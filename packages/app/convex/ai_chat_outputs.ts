// Stored tool outputs: the full text of a tool result that was too large to keep inline.
//
// Life of one output:
// 1. `reserve` runs before the tool body. It holds the largest size the tool can store, so a full
//    quota refuses the tool before it runs and no output is lost.
// 2. After the tool runs, `release_reservation` gives the hold back when the result fits inline.
//    Otherwise `begin_upload` shrinks the hold to the real size, the action PUTs the bytes, and
//    `attach` adds a pending owner for the run.
// 3. The reply save commits the run's pending owners. Run end removes the ones it left.
// 4. Removing the last owner starts the R2 deletion. The deletion job settles the quota hold.

import { v } from "convex/values";
import type { RegisteredQuery } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { action, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { ai_chat_workspaces_source_validator } from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { r2_enqueue_object_deletion_job, r2_fetch_object_range_from_bucket } from "./r2_client.ts";
import {
	ai_chat_outputs_storage_db_release,
	ai_chat_outputs_storage_db_reserve,
	ai_chat_outputs_storage_db_shrink,
} from "./ai_chat_outputs_storage.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { ai_chat_tool_output_char_boundary } from "../server/ai-chat-tool-output.ts";
import { ai_chat_tool_output_ref_schema } from "../shared/ai-chat-files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * One output must fit in a Convex action's memory. A tool whose largest output is bigger must be
 * refused before it runs, never cut.
 */
const OBJECT_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Bounds how many owner docs one thread's copy or delete must walk.
 */
const THREAD_OWNERS_MAX = 10_000;
const BATCH_SIZE = 50;
const PAGE_MAX_BYTES = 64 * 1024;
const BASH_LIST_LIMIT = 100;

const decoder = new TextDecoder();

/**
 * The run must still be running and belong to the tool's source.
 */
async function db_get_running_run(
	ctx: QueryCtx | MutationCtx,
	args: { runId: Id<"ai_chat_runs">; source: { threadId: Id<"ai_chat_threads">; userId: Id<"users"> } },
) {
	const run = await ctx.db.get("ai_chat_runs", args.runId);
	if (!run || run.status !== "running" || run.threadId !== args.source.threadId || run.userId !== args.source.userId) {
		return null;
	}
	return run;
}

/**
 * Mark the object deleting and queue its R2 deletion. The deletion job gives the quota back.
 */
async function db_start_deletion(ctx: MutationCtx, object: Doc<"ai_chat_output_objects">) {
	if (!object.r2Key) {
		throw should_never_happen("Chat output has no R2 key", { objectId: object._id });
	}
	await ctx.db.patch("ai_chat_output_objects", object._id, { state: { kind: "deleting" } });
	await r2_enqueue_object_deletion_job(ctx, {
		organizationId: object.organizationId,
		workspaceId: object.workspaceId,
		r2Key: object.r2Key,
		reason: "chat_output",
		chatOutputObjectId: object._id,
		...(object.state.kind === "uploading" ? { putMayArriveUntil: object.state.putMayArriveUntil } : {}),
	});
}

/**
 * Delete one owner doc. The last owner starts the object's deletion. Delete chat, workspace
 * purge, account purge and run end all remove owners through this one helper.
 */
export async function ai_chat_outputs_db_remove_owner(ctx: MutationCtx, owner: Doc<"ai_chat_output_owners">) {
	await ctx.db.delete("ai_chat_output_owners", owner._id);

	const object = await ctx.db.get("ai_chat_output_objects", owner.objectId);
	if (!object || object.ownerCount < 1) {
		throw should_never_happen("Chat output owner without object", { ownerId: owner._id });
	}
	if (object.ownerCount > 1) {
		await ctx.db.patch("ai_chat_output_objects", object._id, { ownerCount: object.ownerCount - 1 });
	} else {
		await ctx.db.patch("ai_chat_output_objects", object._id, { ownerCount: 0 });
		await db_start_deletion(ctx, { ...object, ownerCount: 0 });
	}

	const thread = await ctx.db.get("ai_chat_threads", owner.threadId);
	if (thread) {
		await ctx.db.patch("ai_chat_threads", thread._id, {
			outputOwnerCount: Math.max((thread.outputOwnerCount ?? 1) - 1, 0),
		});
	}
}

/**
 * Settle an object that is still reserved or uploading when its thread or workspace goes away.
 * A reservation gives its hold back at once. An upload may still land, so it is deleted after
 * its PUT deadline.
 */
export async function ai_chat_outputs_db_drop_unattached_object(
	ctx: MutationCtx,
	object: Doc<"ai_chat_output_objects">,
) {
	if (object.state.kind === "reserved") {
		await ai_chat_outputs_storage_db_release(ctx, object);
	} else if (object.state.kind === "uploading") {
		await db_start_deletion(ctx, object);
	}
}

/**
 * Release what a run left behind: its reservations and its pending owners. Returns true when
 * more remain, so the caller schedules another pass.
 */
export async function ai_chat_outputs_db_release_run(ctx: MutationCtx, runId: Id<"ai_chat_runs">) {
	const reserved = await ctx.db
		.query("ai_chat_output_objects")
		.withIndex("by_run_state", (q) => q.eq("state.runId", runId).eq("state.kind", "reserved"))
		.take(BATCH_SIZE);
	for (const object of reserved) {
		await ai_chat_outputs_storage_db_release(ctx, object);
	}

	const pendingOwners = await ctx.db
		.query("ai_chat_output_owners")
		.withIndex("by_run_state", (q) => q.eq("runId", runId).eq("state", "pending"))
		.take(BATCH_SIZE);
	for (const owner of pendingOwners) {
		await ai_chat_outputs_db_remove_owner(ctx, owner);
	}

	return reserved.length === BATCH_SIZE || pendingOwners.length === BATCH_SIZE;
}

/**
 * Read the output ref of one stored tool part, or null when it has none.
 */
function read_output_ref(part: unknown) {
	if (!part || typeof part !== "object") return null;
	const toolPart = part as { state?: unknown; output?: unknown };
	if (toolPart.state !== "output-available" || !toolPart.output || typeof toolPart.output !== "object") return null;
	const metadata = (toolPart.output as { metadata?: unknown }).metadata;
	if (!metadata || typeof metadata !== "object") return null;
	const ref = ai_chat_tool_output_ref_schema.safeParse((metadata as { output?: unknown }).output);
	return ref.success ? ref.data : null;
}

/**
 * Check every output ref of a reply step before the step is saved. A ref whose run, object or pending
 * owner is gone is dropped: its part keeps only its inline preview and says so. Returns the
 * content to save and the owners to commit after the save.
 *
 * Nothing is written here, because the save that follows can still refuse the reply.
 */
export async function ai_chat_outputs_db_prepare_reply<T extends { id?: unknown; parts?: unknown }>(
	ctx: MutationCtx,
	args: {
		runId: Id<"ai_chat_runs">;
		threadId: Id<"ai_chat_threads">;
		content: T;
	},
) {
	const run = await ctx.db.get("ai_chat_runs", args.runId);
	// A stopping run still saves its last step through `finish`, so its refs stay valid until it ends.
	const runIsLive = run !== null && run.status !== "ended" && run.threadId === args.threadId;
	const parts: unknown[] = Array.isArray(args.content.parts) ? args.content.parts : [];
	const ownerIds: Array<Id<"ai_chat_output_owners">> = [];
	let changed = false;

	const nextParts: unknown[] = [];
	for (const part of parts) {
		const ref = read_output_ref(part);
		if (!ref) {
			nextParts.push(part);
			continue;
		}

		const objectId = ctx.db.normalizeId("ai_chat_output_objects", ref.outputId);
		const object = objectId ? await ctx.db.get("ai_chat_output_objects", objectId) : null;
		const owner = objectId
			? await ctx.db
					.query("ai_chat_output_owners")
					.withIndex("by_thread_object", (q) => q.eq("threadId", args.threadId).eq("objectId", objectId))
					.first()
			: null;
		// A replay of a saved reply finds its owners committed already.
		if (runIsLive && object?.state.kind === "ready" && owner?.runId === args.runId) {
			if (owner.state === "pending") ownerIds.push(owner._id);
			nextParts.push(part);
			continue;
		}

		console.error("Chat data not saved", {
			reason: "output_ref_dropped",
			threadId: args.threadId,
			runId: args.runId,
			messageId: typeof args.content.id === "string" ? args.content.id : null,
			objectId: ref.outputId,
		});
		changed = true;
		const toolPart = part as { output: { output?: unknown; metadata: Record<string, unknown> } };
		const { output: _output, ...metadata } = toolPart.output.metadata;
		nextParts.push({
			...toolPart,
			output: {
				...toolPart.output,
				output: `${typeof toolPart.output.output === "string" ? toolPart.output.output : ""}\n[Full output not saved.]`,
				metadata,
			},
		});
	}

	return { content: changed ? ({ ...args.content, parts: nextParts } as T) : args.content, ownerIds };
}

/**
 * Commit the owners `ai_chat_outputs_db_prepare_reply` checked, after the reply was saved.
 */
export async function ai_chat_outputs_db_commit_owners(ctx: MutationCtx, ownerIds: Array<Id<"ai_chat_output_owners">>) {
	for (const ownerId of ownerIds) {
		await ctx.db.patch("ai_chat_output_owners", ownerId, { state: "committed" });
	}
}

/**
 * Give a branch copy the right to read the outputs one copied message names. Only committed
 * owners of the source chat are copied, so a ref pasted from another chat grants nothing. A copy
 * adds owners, not bytes.
 */
export async function ai_chat_outputs_db_copy_owners(
	ctx: MutationCtx,
	args: { sourceThreadId: Id<"ai_chat_threads">; targetThreadId: Id<"ai_chat_threads">; parts: unknown },
) {
	for (const part of Array.isArray(args.parts) ? args.parts : []) {
		const ref = read_output_ref(part);
		const objectId = ref ? ctx.db.normalizeId("ai_chat_output_objects", ref.outputId) : null;
		if (!objectId) continue;

		const [sourceOwner, targetOwner] = await Promise.all(
			[args.sourceThreadId, args.targetThreadId].map((threadId) =>
				ctx.db
					.query("ai_chat_output_owners")
					.withIndex("by_thread_object", (q) => q.eq("threadId", threadId).eq("objectId", objectId))
					.first(),
			),
		);
		if (sourceOwner?.state !== "committed" || targetOwner) continue;

		// A committed owner keeps its object ready, so the object cannot be deleting here.
		const object = (await ctx.db.get("ai_chat_output_objects", objectId))!;
		const target = (await ctx.db.get("ai_chat_threads", args.targetThreadId))!;
		await ctx.db.patch("ai_chat_output_objects", objectId, { ownerCount: object.ownerCount + 1 });
		await ctx.db.patch("ai_chat_threads", target._id, { outputOwnerCount: (target.outputOwnerCount ?? 0) + 1 });
		await ctx.db.insert("ai_chat_output_owners", {
			organizationId: sourceOwner.organizationId,
			workspaceId: sourceOwner.workspaceId,
			userId: sourceOwner.userId,
			threadId: target._id,
			objectId,
			opKey: sourceOwner.opKey,
			runId: sourceOwner.runId,
			state: "committed",
		});
	}
}

// #region protocol

/**
 * Hold space for the largest output the tool can store, before the tool runs.
 */
export const reserve = internalMutation({
	args: {
		source: ai_chat_workspaces_source_validator,
		runId: v.id("ai_chat_runs"),
		opKey: v.string(),
		reservedBytes: v.number(),
	},
	returns: v_result({ _yay: v.id("ai_chat_output_objects") }),
	handler: async (ctx, args) => {
		if (!Number.isSafeInteger(args.reservedBytes) || args.reservedBytes < 0 || args.reservedBytes > OBJECT_MAX_BYTES) {
			throw should_never_happen("Invalid chat output reservation", { reservedBytes: args.reservedBytes });
		}

		const run = await db_get_running_run(ctx, args);
		if (!run) return Result({ _nay: { message: "This chat run has ended." } });
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, args.source);
		if (!membership) return Result({ _nay: { message: "Chat is no longer available" } });

		// The door above proved the thread exists.
		const thread = (await ctx.db.get("ai_chat_threads", args.source.threadId))!;
		if ((thread.outputOwnerCount ?? 0) >= THREAD_OWNERS_MAX) {
			console.warn("Chat save refused", { reason: "thread_outputs_full", threadId: thread._id, runId: args.runId });
			return Result({
				_nay: {
					name: "storage_full",
					message: `This chat keeps ${THREAD_OWNERS_MAX.toLocaleString("en-US")} large tool results. Start a new chat.`,
				},
			});
		}

		const now = Date.now();
		const held = await ai_chat_outputs_storage_db_reserve(ctx, {
			organizationId: args.source.organizationId,
			workspaceId: args.source.workspaceId,
			userId: args.source.userId,
			bytes: args.reservedBytes,
			now,
		});
		if (held._nay) {
			// Nothing ran, so nothing is lost. This is a warning, not a lost save.
			console.warn("Chat save refused", {
				reason: "storage_full",
				threadId: thread._id,
				runId: args.runId,
				bytes: args.reservedBytes,
			});
			return held;
		}

		return Result({
			_yay: await ctx.db.insert("ai_chat_output_objects", {
				organizationId: args.source.organizationId,
				workspaceId: args.source.workspaceId,
				userId: args.source.userId,
				threadId: args.source.threadId,
				r2Key: null,
				byteCount: null,
				sha256: null,
				contentType: null,
				ownerCount: 0,
				quotaIds: held._yay,
				state: { kind: "reserved", runId: args.runId, opKey: args.opKey, reservedBytes: args.reservedBytes },
				createdAt: now,
			}),
		});
	},
});

/**
 * Give a reservation back. Does nothing once the upload has started, so the tool can call it on
 * every exit path.
 */
export const release_reservation = internalMutation({
	args: { objectId: v.id("ai_chat_output_objects") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const object = await ctx.db.get("ai_chat_output_objects", args.objectId);
		if (object?.state.kind === "reserved") {
			await ai_chat_outputs_storage_db_release(ctx, object);
		}
		return null;
	},
});

/**
 * Upload step 1: shrink the hold to the real size and name the R2 key.
 */
export const begin_upload = internalMutation({
	args: {
		objectId: v.id("ai_chat_output_objects"),
		runId: v.id("ai_chat_runs"),
		byteCount: v.number(),
		sha256: v.string(),
		contentType: v.union(v.literal("text/plain; charset=utf-8"), v.literal("application/json")),
		attemptId: v.string(),
		putMayArriveUntil: v.number(),
	},
	returns: v_result({ _yay: v.object({ r2Key: v.string() }) }),
	handler: async (ctx, args) => {
		const object = await ctx.db.get("ai_chat_output_objects", args.objectId);
		// Run end released the reservation, or the thread is being deleted.
		if (object?.state.kind !== "reserved" || object.state.runId !== args.runId) {
			return Result({ _nay: { message: "The reservation is gone" } });
		}
		if (args.byteCount > object.state.reservedBytes) {
			return Result({ _nay: { message: "The output is larger than its reservation" } });
		}

		const now = Date.now();
		await ai_chat_outputs_storage_db_shrink(ctx, {
			quotaIds: object.quotaIds,
			bytes: object.state.reservedBytes - args.byteCount,
			now,
		});
		const r2Key = `chat-outputs/${object.organizationId}/${object.workspaceId}/${object._id}`;
		await ctx.db.patch("ai_chat_output_objects", object._id, {
			r2Key,
			byteCount: args.byteCount,
			sha256: args.sha256,
			contentType: args.contentType,
			state: {
				kind: "uploading",
				runId: object.state.runId,
				opKey: object.state.opKey,
				attemptId: args.attemptId,
				putMayArriveUntil: args.putMayArriveUntil,
			},
		});
		return Result({ _yay: { r2Key } });
	},
});

/**
 * Upload step 2: after the PUT, make the object ready and add a pending owner for the run.
 * The run, the chat and the membership are checked in this same transaction.
 */
export const attach = internalMutation({
	args: {
		objectId: v.id("ai_chat_output_objects"),
		attemptId: v.string(),
		runId: v.id("ai_chat_runs"),
		source: ai_chat_workspaces_source_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const object = await ctx.db.get("ai_chat_output_objects", args.objectId);
		// A lost reply to an attach that committed. Its owner proves it.
		if (object?.state.kind === "ready") {
			const owner = await ctx.db
				.query("ai_chat_output_owners")
				.withIndex("by_thread_object", (q) => q.eq("threadId", args.source.threadId).eq("objectId", object._id))
				.first();
			return owner?.runId === args.runId
				? Result({ _yay: null })
				: Result({ _nay: { message: "The output was attached elsewhere" } });
		}
		if (object?.state.kind !== "uploading" || object.state.attemptId !== args.attemptId) {
			return Result({ _nay: { message: "The upload is gone" } });
		}

		const run = await db_get_running_run(ctx, args);
		if (!run || object.state.runId !== run._id) return Result({ _nay: { message: "This chat run has ended." } });
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, args.source);
		if (!membership) return Result({ _nay: { message: "Chat is no longer available" } });

		const thread = (await ctx.db.get("ai_chat_threads", args.source.threadId))!;
		await ctx.db.patch("ai_chat_threads", thread._id, { outputOwnerCount: (thread.outputOwnerCount ?? 0) + 1 });
		await ctx.db.patch("ai_chat_output_objects", object._id, { state: { kind: "ready" }, ownerCount: 1 });
		await ctx.db.insert("ai_chat_output_owners", {
			organizationId: object.organizationId,
			workspaceId: object.workspaceId,
			userId: object.userId,
			threadId: thread._id,
			objectId: object._id,
			opKey: object.state.opKey,
			runId: run._id,
			state: "pending",
		});
		return Result({ _yay: null });
	},
});

/**
 * The upload failed or its attach was refused. A ready object is left alone: its attach
 * committed and only the reply was lost.
 */
export const fail_upload = internalMutation({
	args: { objectId: v.id("ai_chat_output_objects"), attemptId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const object = await ctx.db.get("ai_chat_output_objects", args.objectId);
		if (object?.state.kind === "uploading" && object.state.attemptId === args.attemptId) {
			await db_start_deletion(ctx, object);
		}
		return null;
	},
});

/**
 * Continue a run end that left more than one batch behind.
 */
export const release_run = internalMutation({
	args: { runId: v.id("ai_chat_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (await ai_chat_outputs_db_release_run(ctx, args.runId)) {
			await ctx.scheduler.runAfter(0, internal.ai_chat_outputs.release_run, { runId: args.runId });
		}
		return null;
	},
});

/**
 * Delete uploads whose action died before attach or fail. Their PUT deadline has passed.
 */
export const fail_expired_uploads = internalMutation({
	args: { _test_now: v.optional(v.number()), _test_disableReschedule: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const expired = await ctx.db
			.query("ai_chat_output_objects")
			.withIndex("by_state_putMayArriveUntil", (q) =>
				q.eq("state.kind", "uploading").lte("state.putMayArriveUntil", now),
			)
			.take(BATCH_SIZE);
		for (const object of expired) {
			await db_start_deletion(ctx, object);
		}

		// A full batch means more uploads may still be waiting.
		if (expired.length === BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.ai_chat_outputs.fail_expired_uploads, {});
		}
		return null;
	},
});

// #endregion protocol

// #region reads

type get_human_readable_object_Result =
	typeof get_human_readable_object extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The object a human may read: the user's own chat, with current access and a committed owner in
 * that exact chat. "Missing" and "not allowed" both return null.
 */
export const get_human_readable_object = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		outputId: v.string(),
	},
	returns: v.union(v.object({ r2Key: v.string(), byteCount: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const userAuth = { id: args.userId };
		const user = await ctx.db.get("users", userAuth.id);
		if (!user || user.deletedAt !== undefined) return null;
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return null;
		const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
		if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined) return null;

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		const thread = threadId ? await ctx.db.get("ai_chat_threads", threadId) : null;
		if (
			!thread ||
			thread.deletingAt !== undefined ||
			thread.copyingAt !== undefined ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId ||
			thread.createdBy !== userAuth.id
		) {
			return null;
		}

		const objectId = ctx.db.normalizeId("ai_chat_output_objects", args.outputId);
		const owner = objectId
			? await ctx.db
					.query("ai_chat_output_owners")
					.withIndex("by_thread_object", (q) => q.eq("threadId", thread._id).eq("objectId", objectId))
					.first()
			: null;
		const object = owner?.state === "committed" ? await ctx.db.get("ai_chat_output_objects", owner.objectId) : null;
		if (object?.state.kind !== "ready" || !object.r2Key || object.byteCount === null) return null;
		return { r2Key: object.r2Key, byteCount: object.byteCount };
	},
});

/**
 * Read one page of a stored output for the chat UI. The bytes are read on the server, and the
 * checks run again after the R2 read, so no URL reaches the browser and access lost during the
 * read returns nothing. A page ends on a whole UTF-8 character.
 */
export const read_page = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		outputId: v.string(),
		offset: v.number(),
		limit: v.number(),
	},
	returns: v_result({
		_yay: v.object({ text: v.string(), offset: v.number(), nextOffset: v.number(), totalBytes: v.number() }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const notFound = Result({ _nay: { message: "Not found" } });
		const limit = Math.min(Math.max(Math.floor(args.limit), 1), PAGE_MAX_BYTES);
		const target = {
			userId: userAuth.id,
			membershipId: args.membershipId,
			threadId: args.threadId,
			outputId: args.outputId,
		};
		const readable = (await ctx.runQuery(
			internal.ai_chat_outputs.get_human_readable_object,
			target,
		)) as get_human_readable_object_Result;
		if (!readable || !Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > readable.byteCount) {
			return notFound;
		}
		if (args.offset === readable.byteCount) {
			return Result({
				_yay: { text: "", offset: args.offset, nextOffset: args.offset, totalBytes: readable.byteCount },
			});
		}

		// Read 3 more bytes than the page, so a character split at the page end can be finished.
		const endInclusive = Math.min(args.offset + limit + 3, readable.byteCount) - 1;
		const response = await r2_fetch_object_range_from_bucket({
			key: readable.r2Key,
			start: args.offset,
			endInclusive,
		});
		const window = new Uint8Array(await response.arrayBuffer());
		const bytes = response.status === 206 ? window : window.subarray(args.offset, endInclusive + 1);

		// Start on a whole character, then end on one.
		let start = 0;
		while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
		const end =
			args.offset + start + limit >= readable.byteCount
				? bytes.byteLength
				: ai_chat_tool_output_char_boundary(bytes, start + limit);

		const stillReadable = (await ctx.runQuery(
			internal.ai_chat_outputs.get_human_readable_object,
			target,
		)) as get_human_readable_object_Result;
		if (!stillReadable) return notFound;

		return Result({
			_yay: {
				text: decoder.decode(bytes.subarray(start, end)),
				offset: args.offset + start,
				nextOffset: args.offset + end,
				totalBytes: readable.byteCount,
			},
		});
	},
});

/**
 * The object a running tool may read. A tool call also needs its captured membership lifetime,
 * so a member who leaves and rejoins cannot revive an old run's reads. A pending owner counts
 * only for the run that attached it.
 */
export const get_tool_readable_object = internalQuery({
	args: {
		source: ai_chat_workspaces_source_validator,
		runId: v.union(v.id("ai_chat_runs"), v.null()),
		outputId: v.string(),
	},
	returns: v.union(v.object({ r2Key: v.string(), byteCount: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, args.source);
		if (!membership) return null;
		const objectId = ctx.db.normalizeId("ai_chat_output_objects", args.outputId);
		const owner = objectId
			? await ctx.db
					.query("ai_chat_output_owners")
					.withIndex("by_thread_object", (q) => q.eq("threadId", args.source.threadId).eq("objectId", objectId))
					.first()
			: null;
		const runId = args.runId;
		// A job reads with no run, so it reads only outputs of saved replies.
		const runIsLive = runId !== null && (await db_get_running_run(ctx, { runId, source: args.source })) !== null;
		if (!owner || (owner.state === "pending" && !(runIsLive && owner.runId === runId))) {
			return null;
		}
		const object = await ctx.db.get("ai_chat_output_objects", owner.objectId);
		if (object?.state.kind !== "ready" || !object.r2Key || object.byteCount === null) return null;
		return { r2Key: object.r2Key, byteCount: object.byteCount };
	},
});

/**
 * The newest outputs a running tool may read in its chat, for `ls /tool-output`.
 */
export const list_tool_readable_objects = internalQuery({
	args: { source: ai_chat_workspaces_source_validator, runId: v.union(v.id("ai_chat_runs"), v.null()) },
	returns: v.array(v.object({ outputId: v.id("ai_chat_output_objects"), byteCount: v.number() })),
	handler: async (ctx, args) => {
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, args.source);
		if (!membership) return [];
		const runId = args.runId;
		const runIsLive = runId !== null && (await db_get_running_run(ctx, { runId, source: args.source })) !== null;
		const owners = await ctx.db
			.query("ai_chat_output_owners")
			.withIndex("by_thread", (q) => q.eq("threadId", args.source.threadId))
			.order("desc")
			.take(BASH_LIST_LIMIT);
		const listed: Array<{ outputId: Id<"ai_chat_output_objects">; byteCount: number }> = [];
		for (const owner of owners) {
			if (owner.state === "pending" && !(runIsLive && owner.runId === args.runId)) continue;
			const object = await ctx.db.get("ai_chat_output_objects", owner.objectId);
			if (object?.state.kind === "ready" && object.byteCount !== null) {
				listed.push({ outputId: object._id, byteCount: object.byteCount });
			}
		}
		return listed;
	},
});

// #endregion reads
