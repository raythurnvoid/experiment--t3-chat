import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel.js";
import type { Infer } from "convex/values";
import type { ai_chat_workspaces_source_validator } from "../convex/schema.ts";
import { r2_put_object } from "../convex/r2_client.ts";
import {
	files_resolve_upload_content_type,
	files_get_normalized_node_path_segments,
	files_get_utf8_byte_size,
	files_MAX_TEXT_CONTENT_BYTES,
} from "../shared/files.ts";
import {
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_create_empty_state_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "./files.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import { files_upload_content_from_bytes } from "./files-upload-content.ts";
import {
	files_pending_updates_action_stage_private_state_family,
	files_pending_updates_check_frontmatter_caps,
} from "../convex/files_pending_updates.ts";

/**
 * The largest total size of one producer call. Each backend receipt also caps its own item.
 */
export const files_ingestion_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The longest base64 text that can hold `files_ingestion_MAX_BYTES`. Four characters carry three
 * bytes, so a longer string is already over the limit before it is decoded.
 */
export const files_ingestion_MAX_BASE64_CHARS = 4 * Math.ceil(files_ingestion_MAX_BYTES / 3);

/**
 * Read a response body into memory and stop as soon as it passes `maxBytes`.
 *
 * These bodies come from outside services, so their size is not trusted. `response.arrayBuffer()`
 * would buffer the whole body first, and a huge answer would then break the action memory limit.
 */
export async function files_ingestion_read_bytes(response: Response, maxBytes: number) {
	if (!response.body) throw new Error("The file response has no body.");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		// Check the size after every chunk. Content-Length can be missing, or smaller than the body
		// the server actually sends.
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) throw new Error("The file response exceeds its size limit.");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export function files_ingestion_decode_base64(value: string) {
	if (value.length > files_ingestion_MAX_BASE64_CHARS || /[^A-Za-z0-9+/=]/.test(value)) {
		throw new Error("The file has invalid or oversized base64 data.");
	}
	const decoded = atob(value);
	// Reject missing padding and other nonstandard base64 encodings.
	if (btoa(decoded) !== value) throw new Error("The file has invalid base64 data.");
	// Array.from creates an extra array that exceeds the action memory limit for large files.
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index++) {
		bytes[index] = decoded.charCodeAt(index);
	}
	return bytes;
}

export function files_ingestion_encode_base64(bytes: Uint8Array) {
	let binary = "";
	// Small chunks avoid the argument limit of String.fromCharCode for large files.
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/**
 * Create outputs one at a time through normal Files ownership and review.
 *
 * Each item has a durable retry receipt. A later failure or Stop keeps completed items.
 * Producer callbacks add chat or browser checks inside the prepare and finalize transactions.
 */
export async function files_ingestion_write(
	ctx: ActionCtx,
	files: Array<{
		scope: {
			userId: Id<"users">;
			membershipId: Id<"organizations_workspaces_users">;
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			threadId?: Id<"ai_chat_threads">;
			agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		};
		path: string;
		contentType?: string;
		bytes: Uint8Array<ArrayBuffer>;
	}>,
	producer: {
		requestId: string;
		prepare: (
			args: FunctionArgs<typeof internal.files_ingestion.prepare_file>,
		) => Promise<FunctionReturnType<typeof internal.files_ingestion.prepare_file>>;
		finalize: (
			args: FunctionArgs<typeof internal.files_ingestion.finalize_file>,
		) => Promise<FunctionReturnType<typeof internal.files_ingestion.finalize_file>>;
	},
	abortSignal?: AbortSignal,
) {
	if (files.length > 8 || files.reduce((size, file) => size + file.bytes.byteLength, 0) > files_ingestion_MAX_BYTES)
		throw new Error("A file batch may contain at most eight files and 8 MiB.");

	// Check every path and content type first. One bad file then fails the whole call before any
	// receipt exists, instead of after some files are already created.
	const checkedFiles = files.map((file) => {
		const path = file.path;
		if (
			!path.startsWith("/") ||
			path.length > 1024 ||
			/[\\*?\[\]{}\p{Cc}]/u.test(path) ||
			path
				.slice(1)
				.split("/")
				.some((part) => !part || part !== part.trim() || part === "." || part === "..")
		)
			throw new Error("Use a canonical Files path such as /reports/result.bin.");
		const normalized = files_get_normalized_node_path_segments({
			kind: "file",
			nameOrPath: path.slice(1),
			fileNamePolicy: "keep_extension",
		});
		if (
			!normalized ||
			"validationMessage" in normalized ||
			normalized.normalizedPathSegments.join("/") !== path.slice(1)
		)
			throw new Error("Use a valid canonical Files path.");
		const contentType = files_resolve_upload_content_type({ fileName: path, contentType: file.contentType });
		if (!contentType) throw new Error("Invalid file content type.");
		return { path, contentType };
	});

	const results: Array<
		| {
				status: "succeeded";
				file: NonNullable<FunctionReturnType<typeof internal.files_ingestion.finalize_file>["_yay"]>;
		  }
		| { status: "errored" | "cancelled"; index: number }
	> = [];
	for (const [index, file] of files.entries()) {
		const { scope } = file;
		const { threadId: _threadId, ...fileScope } = scope;
		if (abortSignal?.aborted) {
			results.push({ status: "cancelled", index });
			continue;
		}
		const attemptId = crypto.randomUUID();
		let receiptId: Id<"files_ingestion_receipts"> | undefined;
		try {
			const item = checkedFiles[index]!;
			let content = files_upload_content_from_bytes({ bytes: file.bytes, contentType: item.contentType });
			let canonicalText = "";
			if (content.kind === "text") {
				const doc = files_yjs_doc_create_from_array_buffer_update(content.snapshotUpdate);
				try {
					const canonical = files_yjs_doc_get_text({ yjsDoc: doc, rootKind: content.textKind });
					// Markdown serialization can add bytes. Check the text that the pending file will store.
					// Normal uploads can publish frontmatter refusal markers. Private text cannot.
					if (
						canonical._nay ||
						files_get_utf8_byte_size(canonical._yay) > files_MAX_TEXT_CONTENT_BYTES ||
						files_pending_updates_check_frontmatter_caps({
							fileNode: { textKind: content.textKind },
							text: canonical._yay,
						})
					)
						content = { kind: "stored" };
					else canonicalText = canonical._yay;
				} finally {
					doc.destroy();
				}
			}

			const prepareArgs = {
				...scope,
				...item,
				requestId: await crypto_sha256_hex(
					`${scope.threadId ?? ""}:${producer.requestId}:${index}:${scope.workspaceId}`,
				),
				attemptId,
				size: file.bytes.byteLength,
				digest: await crypto_sha256_hex(file.bytes),
				contentType: content.kind === "text" ? content.contentType : item.contentType,
				content:
					content.kind === "text" ? { kind: "text" as const, textKind: content.textKind } : { kind: "stored" as const },
			};
			// Only retry a lost reply, with the same request and attempt identity.
			const prepared = await producer.prepare(prepareArgs).catch(() => producer.prepare(prepareArgs));
			if (prepared._nay) throw new Error(prepared._nay.message);
			if (prepared._yay.kind === "completed") {
				results.push({ status: "succeeded", file: prepared._yay.file });
				continue;
			}

			receiptId = prepared._yay.receiptId;
			abortSignal?.throwIfAborted();
			let text: FunctionArgs<typeof internal.files_ingestion.finalize_file>["text"];
			if (prepared._yay.kind === "stored") {
				await r2_put_object(ctx, {
					key: prepared._yay.r2Key,
					body: file.bytes,
					contentType: prepareArgs.contentType,
					signal: abortSignal,
				});
			} else {
				if (content.kind !== "text") throw new Error("File preparation content changed.");
				const available = await ctx.runQuery(internal.files_ingestion.get_text_preparation, {
					...fileScope,
					receiptId,
					attemptId,
				});
				if (available._nay) throw new Error(available._nay.message);
				const empty = files_u8_to_array_buffer(files_yjs_create_empty_state_update());
				const family = await files_pending_updates_action_stage_private_state_family(
					ctx,
					{
						...scope,
						operationBatchId: available._yay.operationBatchId,
						base: empty,
						staged: empty,
						unstaged: content.snapshotUpdate,
					},
					abortSignal,
				);
				if (family._nay) throw new Error(family._nay.message);
				text = { family: family._yay, unstagedText: canonicalText };
			}

			abortSignal?.throwIfAborted();
			const finalizeArgs = {
				agentSource: scope.agentSource,
				userId: scope.userId,
				membershipId: scope.membershipId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				receiptId,
				attemptId,
				...(text ? { text } : {}),
			};
			const finalized = await producer.finalize(finalizeArgs).catch(() => producer.finalize(finalizeArgs));
			if (finalized._nay) throw new Error(finalized._nay.message);
			results.push({ status: "succeeded", file: finalized._yay });
		} catch {
			if (receiptId) {
				// A lost finalize reply may already have committed. Abort only retires preparing work.
				await ctx
					.runMutation(internal.files_ingestion.abort_file, {
						userId: scope.userId,
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						receiptId,
						attemptId,
					})
					.catch(() => undefined);
			}
			results.push({ status: abortSignal?.aborted ? "cancelled" : "errored", index });
		}
	}
	return results;
}
