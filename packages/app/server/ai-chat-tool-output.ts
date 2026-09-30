// Store the full text of a large tool result and give the model a preview of it.
//
// A storing tool reserves space before it runs (`ai_chat_outputs.reserve`). After it runs, a result
// that fits inline keeps today's shape and the reservation is released. A bigger result is uploaded
// to R2 with a create-only PUT and attached to the run, and the model gets its head and tail.

import type { FunctionArgs } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { r2, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "../convex/r2_client.ts";
import type { ai_chat_ToolOutputRef } from "../shared/ai-chat-files.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A serialized result up to this size stays inline. A bigger one is stored.
 */
export const ai_chat_tool_output_INLINE_MAX_BYTES = 24 * 1024;

/**
 * The most a storing tool can store, reserved before it runs. Bash output passes the engine's
 * 250,000 limit only through the command echo and diagnostics, and UTF-8 can use 3 bytes for one
 * character. An MCP reply is at most 1 MiB, and its compact stored JSON stays close to that size.
 */
const RESERVE_BYTES = {
	bash: 1024 * 1024,
	mcp: 2 * 1024 * 1024,
} as const;

const PREVIEW_HEAD_BYTES = 16 * 1024;
const PREVIEW_TAIL_BYTES = 2 * 1024;
const UPLOAD_URL_LIFETIME_S = 300;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_TIMEOUT_MS = 30_000;

function serialized_bytes(value: unknown) {
	return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
}

/**
 * Move `index` back to the start of a UTF-8 character, so a cut never splits one.
 */
export function ai_chat_tool_output_char_boundary(bytes: Uint8Array, index: number) {
	let boundary = Math.min(Math.max(index, 0), bytes.byteLength);
	while (boundary > 0 && boundary < bytes.byteLength && (bytes[boundary]! & 0xc0) === 0x80) {
		boundary -= 1;
	}
	return boundary;
}

/**
 * One tool call of one provider request of one run. A retry of the same call gets the same key,
 * so a repeated attach finds the result that is already saved.
 */
async function op_key(args: { runId: Id<"ai_chat_runs">; modelCallId: string; toolCallId: string }) {
	return await crypto_sha256_hex(`${args.runId}:${args.modelCallId}:${args.toolCallId}`);
}

/**
 * The text the model reads for a stored result: its head, a marker line, and its tail.
 */
function preview(text: string, ref: ai_chat_ToolOutputRef | null) {
	const bytes = encoder.encode(text);
	const headEnd = ai_chat_tool_output_char_boundary(bytes, PREVIEW_HEAD_BYTES);
	// Move the tail start forward past a split character.
	let tailStart = Math.max(headEnd, bytes.byteLength - PREVIEW_TAIL_BYTES);
	while (tailStart < bytes.byteLength && (bytes[tailStart]! & 0xc0) === 0x80) tailStart += 1;

	const shown = `This shows the first ${headEnd} bytes and the last ${bytes.byteLength - tailStart} bytes.`;
	const notStored = [
		...(ref?.cutBy.includes("mcp_binary_omitted") ? ["binary blocks"] : []),
		...(ref?.cutBy.includes("mcp_structured_dropped") ? ["structured content that failed its schema"] : []),
	];
	const marker = ref
		? `[Full output stored at ${ref.path} (${ref.storedBytes} bytes). ${shown} Read the rest with ` +
			`sed -n, head -c, tail or grep on that path.` +
			(notStored.length > 0
				? ` Not stored, because the tool result dropped them first: ${notStored.join(", ")}.`
				: "") +
			"]"
		: `[Full output not saved (storage error). ${shown}]`;
	return `${decoder.decode(bytes.subarray(0, headEnd))}\n\n${marker}\n\n${decoder.decode(bytes.subarray(tailStart))}`;
}

/**
 * Upload the full text and attach it to the run. Returns null and logs the loss when it could not
 * be stored.
 */
async function store(
	ctx: ActionCtx,
	args: {
		objectId: Id<"ai_chat_output_objects">;
		runId: Id<"ai_chat_runs">;
		source: FunctionArgs<typeof internal.ai_chat_outputs.attach>["source"];
		text: string;
		contentType: "text/plain; charset=utf-8" | "application/json";
		sourceBytes: number;
		cutBy: ai_chat_ToolOutputRef["cutBy"];
	},
) {
	const bytes = encoder.encode(args.text);
	const attemptId = crypto.randomUUID();
	// The tool already ran, so a result that cannot be stored now is lost. Log ids and sizes only.
	const logLoss = () =>
		console.error("Chat data not saved", {
			reason: "output_storage_error",
			threadId: args.source.threadId,
			runId: args.runId,
			objectId: args.objectId,
			bytes: bytes.byteLength,
		});
	const begun = await ctx.runMutation(internal.ai_chat_outputs.begin_upload, {
		objectId: args.objectId,
		runId: args.runId,
		byteCount: bytes.byteLength,
		sha256: await crypto_sha256_hex(bytes),
		contentType: args.contentType,
		attemptId,
		// The signed URL expires first, so no PUT can arrive after this.
		putMayArriveUntil: Date.now() + UPLOAD_URL_LIFETIME_S * 1000 + r2_PUT_MAY_ARRIVE_MARGIN_MS,
	});
	if (begun._nay) {
		logLoss();
		return null;
	}

	// A create-only PUT never replaces stored bytes. A 412 means an earlier try already stored them.
	let uploaded = false;
	for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !uploaded; attempt++) {
		const upload = await r2.generateUploadUrl(begun._yay.r2Key, {
			createOnly: true,
			expiresIn: UPLOAD_URL_LIFETIME_S,
		});
		const response = await fetch(upload.url, {
			method: "PUT",
			headers: { "Content-Type": args.contentType, "If-None-Match": "*" },
			body: bytes,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		}).catch(() => null);
		uploaded = response !== null && (response.ok || response.status === 412);
	}

	const attached = uploaded
		? await ctx.runMutation(internal.ai_chat_outputs.attach, {
				objectId: args.objectId,
				attemptId,
				runId: args.runId,
				source: args.source,
			})
		: null;
	if (!attached || attached._nay) {
		await ctx.runMutation(internal.ai_chat_outputs.fail_upload, { objectId: args.objectId, attemptId });
		logLoss();
		return null;
	}

	return {
		outputId: args.objectId,
		path: `/tool-output/${args.objectId}.txt`,
		storedBytes: bytes.byteLength,
		sourceBytes: args.sourceBytes,
		cutBy: args.cutBy,
	};
}

/**
 * Reserve space for the full output before a storing tool runs. When this throws, the tool must
 * not run, because its output could not be kept.
 */
export async function ai_chat_tool_output_reserve(
	ctx: ActionCtx,
	args: {
		source: FunctionArgs<typeof internal.ai_chat_outputs.reserve>["source"];
		getRun: () => { runId: Id<"ai_chat_runs">; generation: number } | null;
		getModelCallId: (toolCallId: string) => string | null;
		toolCallId: string;
		tool: keyof typeof RESERVE_BYTES;
	},
) {
	const runId = args.getRun()?.runId ?? null;
	// The chat run starts before the stream, and the receipt middleware sees each tool call before
	// the SDK runs it. So both ids are always set here.
	const modelCallId = args.getModelCallId(args.toolCallId);
	if (!runId || !modelCallId) throw new Error("Tool output storage needs a chat run.");

	const reserved = await ctx.runMutation(internal.ai_chat_outputs.reserve, {
		source: args.source,
		runId,
		opKey: await op_key({ runId, modelCallId, toolCallId: args.toolCallId }),
		reservedBytes: RESERVE_BYTES[args.tool],
	});
	if (reserved._nay) throw new Error(reserved._nay.message);

	return { runId, objectId: reserved._yay };
}

/**
 * Give the model `inlineText` when it fits inline. Otherwise store `storedText` and give the model
 * its preview. `ref` is set only when the text was stored; the tool puts it in `metadata.output`.
 * The caller still releases the reservation on every exit path; a stored object ignores that.
 */
export async function ai_chat_tool_output_keep(
	ctx: ActionCtx,
	args: {
		reservation: { objectId: Id<"ai_chat_output_objects">; runId: Id<"ai_chat_runs"> };
		source: FunctionArgs<typeof internal.ai_chat_outputs.attach>["source"];
		inlineText: string;
		storedText: string;
		contentType: "text/plain; charset=utf-8" | "application/json";
		sourceBytes: number;
		cutBy: ai_chat_ToolOutputRef["cutBy"];
	},
) {
	if (serialized_bytes(args.inlineText) <= ai_chat_tool_output_INLINE_MAX_BYTES) {
		return { output: args.inlineText, ref: null };
	}

	const ref = await store(ctx, {
		objectId: args.reservation.objectId,
		runId: args.reservation.runId,
		source: args.source,
		text: args.storedText,
		contentType: args.contentType,
		sourceBytes: args.sourceBytes,
		cutBy: args.cutBy,
	});
	return { output: preview(args.storedText, ref), ref };
}
