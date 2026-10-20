import { v, type Infer } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import { validate } from "convex-helpers/validators";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { file_quotes_db_shape } from "./file_quotes.ts";
import { public_api_authorize_request } from "./public_api_http_auth.ts";
import { r2_fetch_object_range_from_bucket } from "./r2_client.ts";
import { file_quotes_part_schema } from "../shared/file-quotes.ts";
import { crypto_open_cursor, crypto_seal_cursor } from "../server/crypto-utils.ts";
import { ai_chat_tool_output_char_boundary } from "../server/ai-chat-tool-output.ts";

const REQUEST_MAX_BYTES = 32 * 1024;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

const authority_validator = v.object({
	credentialId: v.id("api_credentials"),
	userId: v.id("users"),
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
});
const membership_validator = v.object({
	membershipId: v.id("organizations_workspaces_users"),
	membershipLifetime: v.union(v.number(), v.null()),
});
const cursor_validator = v.object({
	endMessageId: v.id("ai_chat_threads_messages_aisdk_5"),
	...membership_validator.fields,
	position: v.union(
		v.object({ kind: v.literal("message"), messageId: v.id("ai_chat_threads_messages_aisdk_5") }),
		v.object({
			kind: v.literal("step"),
			messageId: v.id("ai_chat_threads_messages_aisdk_5"),
			beforeStepIndex: v.number(),
			expectedVersion: v.number(),
		}),
	),
});
const refusal_validator = v.object({
	_nay: v.object({
		message: v.string(),
		data: v.object({
			status: v.union(v.literal(400), v.literal(401), v.literal(403), v.literal(404), v.literal(409)),
			errorCode: v.optional(v.union(v.literal("invalid_cursor"), v.literal("transcript_changed"))),
		}),
	}),
});

function refuse(
	status: Infer<typeof refusal_validator>["_nay"]["data"]["status"],
	message: string,
	errorCode?: "invalid_cursor" | "transcript_changed",
) {
	return Result({ _nay: { message, data: { status, ...(errorCode ? { errorCode } : {}) } } });
}

async function db_read_authority(
	ctx: QueryCtx,
	args: {
		authority: Infer<typeof authority_validator>;
		threadId: string;
		membership?: Infer<typeof membership_validator> | null;
	},
) {
	const { authority } = args;
	const credential = await ctx.db.get("api_credentials", authority.credentialId);
	if (
		!credential ||
		credential.revokedAt !== null ||
		credential.userId !== authority.userId ||
		credential.organizationId !== authority.organizationId ||
		credential.workspaceId !== authority.workspaceId
	) {
		return refuse(401, "Unauthenticated");
	}
	if (credential.serviceAccountId !== null || !credential.scopes.includes("ai_chat:read")) {
		return refuse(403, "Permission denied");
	}
	const user = await ctx.db.get("users", authority.userId);
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", authority.userId)
				.eq("organizationId", authority.organizationId)
				.eq("workspaceId", authority.workspaceId),
		)
		.first();
	if (!user || user.deletedAt != null || !membership || membership.pendingOrganizationRemoval) {
		return refuse(401, "Unauthenticated");
	}
	const lifetime = await ctx.db
		.query("organizations_membership_lifetimes")
		.withIndex("by_workspace_user", (q) => q.eq("workspaceId", authority.workspaceId).eq("userId", authority.userId))
		.first();
	const pinnedMembership = {
		membershipId: membership._id,
		membershipLifetime: lifetime?.lifetime ?? null,
	};
	if (
		(lifetime && (!lifetime.active || lifetime.membershipId !== membership._id)) ||
		(args.membership &&
			(args.membership.membershipId !== pinnedMembership.membershipId ||
				args.membership.membershipLifetime !== pinnedMembership.membershipLifetime))
	) {
		return refuse(401, "Unauthenticated");
	}
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: authority.userId },
		membership,
		permission: null,
	});
	if (authorized._nay) return refuse(401, "Unauthenticated");
	const workspace = await ctx.db.get("organizations_workspaces", authority.workspaceId);
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined) return refuse(404, "Not found");
	const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
	if (!threadId) return refuse(400, "Invalid thread ID");
	const thread = await ctx.db.get("ai_chat_threads", threadId);
	if (
		!thread ||
		thread.organizationId !== authority.organizationId ||
		thread.workspaceId !== authority.workspaceId ||
		thread.createdBy !== authority.userId ||
		thread.copyingAt !== undefined ||
		thread.deletingAt !== undefined
	) {
		return refuse(404, "Not found");
	}
	return Result({ _yay: { thread, membership, pinnedMembership } });
}

export const get_transcript_page = internalQuery({
	args: {
		authority: authority_validator,
		threadId: v.string(),
		endMessageId: v.optional(v.union(v.string(), v.null())),
		cursor: v.union(cursor_validator, v.null()),
	},
	returns: v.union(
		refusal_validator,
		v.object({
			_yay: v.object({
				page: v.union(
					v.object({
						kind: v.literal("header"),
						thread: v.object({
							id: v.id("ai_chat_threads"),
							title: v.union(v.string(), v.null()),
							endMessageId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
						}),
						fragment: v.null(),
					}),
					v.object({
						kind: v.literal("fragment"),
						threadId: v.id("ai_chat_threads"),
						endMessageId: v.id("ai_chat_threads_messages_aisdk_5"),
						fragment: v.object({
							messageId: v.id("ai_chat_threads_messages_aisdk_5"),
							parentId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
							clientGeneratedMessageId: v.string(),
							role: v.string(),
							createdAt: v.number(),
							updatedAt: v.number(),
							status: v.union(v.literal("streaming"), v.literal("done"), v.literal("stopped"), v.literal("failed")),
							version: v.number(),
							metadata: v.any(),
							stepIndex: v.union(v.number(), v.null()),
							stepStatus: v.union(v.literal("tools_running"), v.literal("done"), v.literal("partial"), v.null()),
							parts: v.array(v.any()),
						}),
					}),
				),
				next: v.union(cursor_validator, v.null()),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const readable = await db_read_authority(ctx, { ...args, membership: args.cursor });
		if (readable._nay) return readable;
		const { thread, membership, pinnedMembership } = readable._yay;
		if (!args.cursor) {
			const endMessageId =
				args.endMessageId == null
					? thread.newestNodeId
					: ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.endMessageId);
			if (args.endMessageId != null && !endMessageId) return refuse(400, "Invalid end message ID");
			if (endMessageId) {
				const end = await ctx.db.get("ai_chat_threads_messages_aisdk_5", endMessageId);
				if (!end || end.threadId !== thread._id) return refuse(404, "Not found");
			}
			return Result({
				_yay: {
					page: {
						kind: "header" as const,
						thread: { id: thread._id, title: thread.title, endMessageId },
						fragment: null,
					},
					next: endMessageId
						? { endMessageId, ...pinnedMembership, position: { kind: "message" as const, messageId: endMessageId } }
						: null,
				},
			});
		}
		const { endMessageId, position } = args.cursor;
		if (args.endMessageId != null && args.endMessageId !== endMessageId) {
			return refuse(400, "Invalid cursor", "invalid_cursor");
		}
		const node = await ctx.db.get("ai_chat_threads_messages_aisdk_5", position.messageId);
		if (
			!node ||
			node.threadId !== thread._id ||
			node.organizationId !== thread.organizationId ||
			node.workspaceId !== thread.workspaceId
		) {
			return refuse(404, "Not found");
		}
		if (position.kind === "step" && node.version !== position.expectedVersion) {
			return refuse(409, "Transcript changed. Start again without a cursor.", "transcript_changed");
		}
		// Copies keep their steps but clear runId. The content shape tells us where parts live.
		const inline = Array.isArray(node.content.parts);
		const step = inline
			? null
			: await ctx.db
					.query("ai_chat_run_steps")
					.withIndex("by_message_stepIndex", (q) =>
						position.kind === "step"
							? q.eq("messageId", node._id).lt("stepIndex", position.beforeStepIndex)
							: q.eq("messageId", node._id),
					)
					.order("desc")
					.first();
		const parts: unknown[] = inline ? node.content.parts : (step?.parts ?? []);
		const shapedParts: unknown[] = [];
		for (const part of parts) {
			if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-file-quote") {
				shapedParts.push(part);
				continue;
			}
			const quote = file_quotes_part_schema.safeParse(part);
			if (!quote.success) continue;
			const [data] = await file_quotes_db_shape(ctx, { membership, quotes: [quote.data.data] });
			shapedParts.push({ type: "data-file-quote", data });
		}
		const next: Infer<typeof cursor_validator> | null =
			step && step.stepIndex > 0
				? {
						endMessageId,
						...pinnedMembership,
						position: {
							kind: "step",
							messageId: node._id,
							beforeStepIndex: step.stepIndex,
							expectedVersion: node.version,
						},
					}
				: node.parentId
					? { endMessageId, ...pinnedMembership, position: { kind: "message", messageId: node.parentId } }
					: null;
		return Result({
			_yay: {
				page: {
					kind: "fragment" as const,
					threadId: thread._id,
					endMessageId,
					fragment: {
						messageId: node._id,
						parentId: node.parentId,
						clientGeneratedMessageId: node.clientGeneratedMessageId,
						role: String(node.content.role),
						createdAt: node._creationTime,
						updatedAt: node.updatedAt,
						status: node.status,
						version: node.version,
						metadata: (node.content.metadata ?? null) as unknown,
						stepIndex: step?.stepIndex ?? null,
						stepStatus: step?.status ?? null,
						parts: shapedParts,
					},
				},
				next,
			},
		});
	},
});

type get_transcript_page_Result =
	typeof get_transcript_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_readable_output = internalQuery({
	args: {
		authority: authority_validator,
		threadId: v.string(),
		outputId: v.string(),
		membership: v.optional(membership_validator),
	},
	returns: v.union(
		refusal_validator,
		v.object({
			_yay: v.object({
				r2Key: v.string(),
				byteCount: v.number(),
				membership: membership_validator,
			}),
		}),
	),
	handler: async (ctx, args) => {
		const readable = await db_read_authority(ctx, args);
		if (readable._nay) return readable;
		const objectId = ctx.db.normalizeId("ai_chat_output_objects", args.outputId);
		if (!objectId) return refuse(400, "Invalid output ID");
		const owner = await ctx.db
			.query("ai_chat_output_owners")
			.withIndex("by_thread_object", (q) => q.eq("threadId", readable._yay.thread._id).eq("objectId", objectId))
			.first();
		const object = owner?.state === "committed" ? await ctx.db.get("ai_chat_output_objects", objectId) : null;
		if (object?.state.kind !== "ready" || !object.r2Key || object.byteCount === null) return refuse(404, "Not found");
		return Result({
			_yay: { r2Key: object.r2Key, byteCount: object.byteCount, membership: readable._yay.pinnedMembership },
		});
	},
});

type get_readable_output_Result =
	typeof get_readable_output extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function parse_body<T>(request: Request, schema: z.ZodSchema<T>) {
	const declaredBytes = Number(request.headers.get("content-length") ?? Number.NaN);
	if (declaredBytes > REQUEST_MAX_BYTES) {
		await request.body?.cancel();
		return Result({ _nay: { message: "Request body is too large" } });
	}
	const reader = request.body?.getReader();
	const bytes = new Uint8Array(REQUEST_MAX_BYTES);
	let length = 0;
	try {
		if (reader) {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (length + chunk.value.byteLength > REQUEST_MAX_BYTES) {
					return Result({ _nay: { message: "Request body is too large" } });
				}
				bytes.set(chunk.value, length);
				length += chunk.value.byteLength;
			}
		}
		const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))));
		if (!parsed.success) return Result({ _nay: { message: "Request body validation failed" } });
		return Result({ _yay: parsed.data });
	} catch {
		return Result({ _nay: { message: "Failed to parse request body as JSON" } });
	} finally {
		await reader?.cancel().catch(() => {});
	}
}

const transcript_body_schema = z.object({
	threadId: z.string().min(1).max(128),
	endMessageId: z.string().min(1).max(128).nullable().optional(),
	cursor: z
		.string()
		.min(1)
		.max(16 * 1024)
		.nullable()
		.optional(),
});
export type public_api_ai_chat_http_transcript_Body = z.infer<typeof transcript_body_schema>;

export async function public_api_ai_chat_http_transcript(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/ai-chat/threads/transcript";
}) {
	const auth = await public_api_authorize_request({
		...args,
		requiredScope: "ai_chat:read",
		allowedKinds: ["user_api_key"],
		route: args.path,
	});
	if (auth._nay) return { ...auth._nay, headers: NO_STORE_HEADERS };
	const { principal } = auth._yay;
	if (principal.serviceAccountId !== null) {
		return { status: 403, headers: NO_STORE_HEADERS, body: { message: "Permission denied" } } as const;
	}
	const parsed = await parse_body(args.request, transcript_body_schema);
	if (parsed._nay) return { status: 400, headers: NO_STORE_HEADERS, body: parsed._nay } as const;
	const body = parsed._yay;
	const authority = {
		credentialId: principal.credentialId,
		userId: principal.userId,
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
	};
	const scope = JSON.stringify({ route: args.path, ...authority, threadId: body.threadId });
	let cursor: Infer<typeof cursor_validator> | null = null;
	if (body.cursor) {
		const opened = await crypto_open_cursor({ purpose: "ai_chat_transcript", scope, cursor: body.cursor });
		if (
			!validate(cursor_validator, opened) ||
			(opened.position.kind === "step" &&
				(!Number.isSafeInteger(opened.position.beforeStepIndex) ||
					opened.position.beforeStepIndex <= 0 ||
					!Number.isSafeInteger(opened.position.expectedVersion)))
		) {
			return {
				status: 400,
				headers: NO_STORE_HEADERS,
				body: { message: "Invalid cursor", errorCode: "invalid_cursor" },
			} as const;
		}
		cursor = opened;
	}
	const result = (await args.ctx.runQuery(internal.public_api_ai_chat.get_transcript_page, {
		authority,
		threadId: body.threadId,
		endMessageId: body.endMessageId,
		cursor,
	})) as get_transcript_page_Result;
	if (result._nay) {
		return {
			status: result._nay.data.status,
			headers: NO_STORE_HEADERS,
			body: { message: result._nay.message, errorCode: result._nay.data.errorCode },
		} as const;
	}
	const next = result._yay.next
		? await crypto_seal_cursor({ purpose: "ai_chat_transcript", scope, payload: result._yay.next })
		: null;
	const response = { ...result._yay.page, cursor: next, isDone: next === null };
	// A whole saved doc fits even with JSON escaping. Never turn a limit into a cut transcript.
	if (new TextEncoder().encode(JSON.stringify(response)).byteLength > RESPONSE_MAX_BYTES) {
		throw new Error("AI transcript page exceeds the saved-document response bound");
	}
	return { status: 200, headers: NO_STORE_HEADERS, body: response } as const;
}

const output_body_schema = z.object({
	threadId: z.string().min(1).max(128),
	outputId: z.string().min(1).max(128),
	offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	limit: z.number().int().min(4).max(65_536).optional(),
});
export type public_api_ai_chat_http_read_output_Body = z.infer<typeof output_body_schema>;

export async function public_api_ai_chat_http_read_output(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/ai-chat/threads/tool-output/read";
}) {
	const auth = await public_api_authorize_request({
		...args,
		requiredScope: "ai_chat:read",
		allowedKinds: ["user_api_key"],
		route: args.path,
	});
	if (auth._nay) return { ...auth._nay, headers: NO_STORE_HEADERS };
	const { principal } = auth._yay;
	if (principal.serviceAccountId !== null) {
		return { status: 403, headers: NO_STORE_HEADERS, body: { message: "Permission denied" } } as const;
	}
	const parsed = await parse_body(args.request, output_body_schema);
	if (parsed._nay) return { status: 400, headers: NO_STORE_HEADERS, body: parsed._nay } as const;
	const { offset, limit = 65_536 } = parsed._yay;
	const target = {
		authority: {
			credentialId: principal.credentialId,
			userId: principal.userId,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
		},
		threadId: parsed._yay.threadId,
		outputId: parsed._yay.outputId,
	};
	const result = (await args.ctx.runQuery(
		internal.public_api_ai_chat.get_readable_output,
		target,
	)) as get_readable_output_Result;
	if (result._nay) {
		return {
			status: result._nay.data.status,
			headers: NO_STORE_HEADERS,
			body: { message: result._nay.message },
		} as const;
	}
	const readable = result._yay;
	if (offset > readable.byteCount) {
		return {
			status: 400,
			headers: NO_STORE_HEADERS,
			body: { message: "Offset is past the end of the output" },
		} as const;
	}
	if (offset === readable.byteCount) {
		return {
			status: 200,
			headers: NO_STORE_HEADERS,
			body: { text: "", offset, nextOffset: offset, totalBytes: readable.byteCount },
		} as const;
	}
	let bytes: Uint8Array;
	try {
		// Allow three skipped leading bytes and three bytes after the page's last character.
		const endInclusive = Math.min(offset + limit + 6, readable.byteCount) - 1;
		const response = await r2_fetch_object_range_from_bucket({
			key: readable.r2Key,
			start: offset,
			endInclusive,
			signal: args.request.signal,
		});
		const expectedLength = endInclusive - offset + 1;
		const validRange =
			response.status === 206 &&
			response.headers.get("Content-Range") === `bytes ${offset}-${endInclusive}/${readable.byteCount}`;
		const validWhole = response.status === 200 && offset === 0 && readable.byteCount === expectedLength;
		if ((!validRange && !validWhole) || !response.body) {
			await response.body?.cancel();
			throw new Error("Invalid output range");
		}
		bytes = new Uint8Array(expectedLength);
		const reader = response.body.getReader();
		let length = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (length + chunk.value.byteLength > expectedLength) throw new Error("Output range is too large");
				bytes.set(chunk.value, length);
				length += chunk.value.byteLength;
			}
			if (length !== expectedLength) throw new Error("Output range is incomplete");
		} finally {
			await reader.cancel().catch(() => {});
		}
	} catch {
		// Provider errors may contain a storage key or signed URL.
		console.error("AI output read failed", { threadId: target.threadId, outputId: target.outputId });
		return { status: 503, headers: NO_STORE_HEADERS, body: { message: "Stored output is unavailable" } } as const;
	}
	const checked = (await args.ctx.runQuery(internal.public_api_ai_chat.get_readable_output, {
		...target,
		membership: readable.membership,
	})) as get_readable_output_Result;
	if (checked._nay) {
		return {
			status: checked._nay.data.status,
			headers: NO_STORE_HEADERS,
			body: { message: checked._nay.message },
		} as const;
	}
	if (checked._yay.r2Key !== readable.r2Key || checked._yay.byteCount !== readable.byteCount) {
		return { status: 503, headers: NO_STORE_HEADERS, body: { message: "Stored output is unavailable" } } as const;
	}
	let start = 0;
	while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
	const end =
		offset + start + limit >= readable.byteCount
			? bytes.byteLength
			: ai_chat_tool_output_char_boundary(bytes, start + limit);
	return {
		status: 200,
		headers: NO_STORE_HEADERS,
		body: {
			text: new TextDecoder().decode(bytes.subarray(start, end)),
			offset: offset + start,
			nextOffset: offset + end,
			totalBytes: readable.byteCount,
		},
	} as const;
}
