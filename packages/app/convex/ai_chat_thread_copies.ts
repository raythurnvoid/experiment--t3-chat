// Branch copy: copy one branch of a chat into a new chat in small steps.
//
// `begin` creates the target thread with `copyingAt` set, so every thread door treats it as not
// found, and a copy doc. Each `step` then does one bounded piece of work:
// 1. building: walk up from the anchor message and write the ids into pages.
// 2. copying: copy the messages root first, with their committed output owners.
// 3. publish: clear `copyingAt` and delete the copy doc.
// Every step checks the captured membership and the source chat again. A failed check aborts the
// copy, and the Delete chat drain deletes the target.

import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { ai_chat_outputs_db_copy_owners } from "./ai_chat_outputs.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { v_result } from "../server/convex-utils.ts";
import type { ai_chat_UiMessage } from "../shared/ai-chat.ts";
import { get_id_generator } from "../shared/generated-ids.ts";
import { omit_properties, should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * `thread_branch` runs every step in one action, which Convex stops after 10 minutes. The cron
 * aborts a copy left behind after this.
 */
const COPY_LEASE_MS = 15 * 60 * 1000;
const PAGE_MAX_IDS = 1000;
const COPY_MAX_MESSAGES = 100;
/**
 * The most message content one step reads, counted in stored bytes. A reply's bytes include its
 * steps. This keeps a step well below the transaction limits.
 */
const STEP_MAX_BYTES = 2 * 1024 * 1024;
const EXPIRED_BATCH_SIZE = 50;

/**
 * Stop a copy and delete its target through the Delete chat drain. The drain deletes the copy doc
 * and its pages too.
 */
export async function ai_chat_thread_copies_db_abort(ctx: MutationCtx, copy: Doc<"ai_chat_thread_copies">) {
	if (copy.state.kind === "aborted") return;

	await ctx.db.patch("ai_chat_thread_copies", copy._id, { state: { kind: "aborted" } });
	const target = await ctx.db.get("ai_chat_threads", copy.targetThreadId);
	if (target && target.deletingAt === undefined) {
		await ctx.db.patch("ai_chat_threads", target._id, { deletingAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.data_deletion.drain_deleting_thread, { threadId: target._id });
	}
}

/**
 * Start a branch copy of `threadId` that ends at `messageId`, or at the newest message.
 * `thread_branch` resolves the user and spends the rate limit token before it calls this.
 */
export const begin = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.string(),
		messageId: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({ copyId: v.id("ai_chat_thread_copies"), threadId: v.id("ai_chat_threads") }),
	}),
	handler: async (ctx, args) => {
		const userAuth = { id: args.userId };
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return authorized;
		}

		const threadId = ctx.db.normalizeId("ai_chat_threads", args.threadId);
		if (!threadId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const thread = await ctx.db.get("ai_chat_threads", threadId);
		if (!thread || thread.deletingAt !== undefined || thread.copyingAt !== undefined) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId ||
			thread.createdBy !== userAuth.id
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const now = Date.now();
		const organizationId = membership.organizationId;
		const workspaceId = membership.workspaceId;

		let anchor: Doc<"ai_chat_threads_messages_aisdk_5"> | null = null;
		if (args.messageId) {
			const messageId = ctx.db.normalizeId("ai_chat_threads_messages_aisdk_5", args.messageId);
			const message = messageId ? await ctx.db.get("ai_chat_threads_messages_aisdk_5", messageId) : null;
			if (!message || message.threadId !== threadId) {
				return Result({ _nay: { message: "Message not found" } });
			}
			anchor = message;
		} else {
			anchor = await ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_organization_workspace_thread", (q) =>
					q.eq("organizationId", thread.organizationId).eq("workspaceId", thread.workspaceId).eq("threadId", threadId),
				)
				.order("desc")
				.first();
		}

		const unarchivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("by_organization_workspace_createdBy_archived_lastMessageAt", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("createdBy", userAuth.id)
					.eq("archived", false),
			)
			.collect();

		const archivedThreads = await ctx.db
			.query("ai_chat_threads")
			.withIndex("by_organization_workspace_createdBy_archived_lastMessageAt", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("createdBy", userAuth.id)
					.eq("archived", true),
			)
			.collect();

		const sourceTitle = (thread.title || "New Chat").trim() || "New Chat";
		const baseTitle = sourceTitle.replace(/ \(\d+\)$/, "");

		let maxSuffix = 0;
		for (const thread of [...unarchivedThreads, ...archivedThreads]) {
			const title = (thread.title || "New Chat").trim() || "New Chat";
			const normalized = title.replace(/ \(\d+\)$/, "");
			if (normalized !== baseTitle) {
				continue;
			}

			const match = title.match(/ \((\d+)\)$/);
			if (!match) {
				continue;
			}

			const n = Number(match[1]);
			if (Number.isFinite(n) && n > maxSuffix) {
				maxSuffix = n;
			}
		}

		const newThreadId = await ctx.db.insert("ai_chat_threads", {
			organizationId,
			workspaceId,
			clientGeneratedId: get_id_generator("ai_thread")(),
			title: `${baseTitle} (${maxSuffix + 1})`,
			lastMessageAt: now,
			readAt: now,
			archived: false,
			runtime: "aisdk_5",
			createdBy: userAuth.id,
			updatedBy: userAuth.id,
			updatedAt: now,
			starred: false,
			copyingAt: now,
			newestNodeId: null,
		});
		// Copy the creator's scratch and shells, but not transcripts or running jobs.
		const sourceShells = await ctx.db
			.query("ai_chat_bash_shells")
			.withIndex("by_thread_name", (q) => q.eq("threadId", threadId))
			.collect();
		for (const sourceShell of sourceShells) {
			await ctx.db.insert("ai_chat_bash_shells", {
				organizationId,
				workspaceId,
				threadId: newThreadId,
				name: sourceShell.name,
				cwd: sourceShell.cwd,
				cwdTarget: sourceShell.cwdTarget,
				state: sourceShell.state,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
		}
		await ctx.runMutation(internal.ai_chat_files.copy_thread_tmp_files, {
			organizationId,
			workspaceId,
			userId: userAuth.id,
			sourceThreadId: threadId,
			targetThreadId: newThreadId,
		});

		const copyId = await ctx.db.insert("ai_chat_thread_copies", {
			organizationId,
			workspaceId,
			sourceThreadId: threadId,
			targetThreadId: newThreadId,
			userId: userAuth.id,
			membershipId: membership._id,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			state: { kind: "building", nextMessageId: anchor?._id ?? null, pageCount: 0 },
			expiresAt: now + COPY_LEASE_MS,
		});

		return Result({ _yay: { copyId, threadId: newThreadId } });
	},
});

export type ai_chat_thread_copies_begin_Result =
	typeof begin extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Copy one message into the target under `parentId`, with its steps and the output owners it
 * needs. Returns the copy's id. The copy has no run, and it never wakes an agent.
 */
async function db_copy_message(
	ctx: MutationCtx,
	args: {
		copy: Doc<"ai_chat_thread_copies">;
		message: Doc<"ai_chat_threads_messages_aisdk_5">;
		parentId: Id<"ai_chat_threads_messages_aisdk_5"> | null;
		now: number;
	},
) {
	const content = args.message.content as unknown as ai_chat_UiMessage;
	const nextId = get_id_generator("ai_message")();
	const metadata = content.metadata
		? omit_properties(content.metadata, ["convexParentId", "convexId", "parentClientGeneratedId"])
		: undefined;

	const copiedId = await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
		organizationId: args.message.organizationId,
		workspaceId: args.message.workspaceId,
		parentId: args.parentId,
		threadId: args.copy.targetThreadId,
		createdBy: args.copy.userId,
		updatedAt: args.now,
		clientGeneratedMessageId: nextId,
		content: { ...content, id: nextId, ...(metadata ? { metadata } : {}) },
		// A reply copied while its run streams keeps the steps its run saved so far.
		status: args.message.status === "streaming" ? "stopped" : args.message.status,
		runId: null,
		version: 0,
		wakePending: false,
		bytes: args.message.bytes,
	});
	await ai_chat_outputs_db_copy_owners(ctx, {
		sourceThreadId: args.copy.sourceThreadId,
		targetThreadId: args.copy.targetThreadId,
		parts: content.parts,
	});

	const steps = await ctx.db
		.query("ai_chat_run_steps")
		.withIndex("by_message_stepIndex", (q) => q.eq("messageId", args.message._id))
		.collect();
	for (const { _id, _creationTime, ...step } of steps) {
		await ctx.db.insert("ai_chat_run_steps", {
			...step,
			threadId: args.copy.targetThreadId,
			messageId: copiedId,
			status: step.status === "tools_running" ? "partial" : step.status,
		});
		await ai_chat_outputs_db_copy_owners(ctx, {
			sourceThreadId: args.copy.sourceThreadId,
			targetThreadId: args.copy.targetThreadId,
			parts: step.parts,
		});
	}

	// Messages are copied root first, so the last copy is the anchor: the node the chat opens on.
	await ctx.db.patch("ai_chat_threads", args.copy.targetThreadId, { newestNodeId: copiedId });
	return copiedId;
}

async function db_publish(args: {
	ctx: MutationCtx;
	copy: Doc<"ai_chat_thread_copies">;
	now: number;
}) {
	const { ctx, copy, now } = args;

	await ctx.db.patch("ai_chat_threads", copy.targetThreadId, {
		copyingAt: undefined,
		lastMessageAt: now,
		readAt: now,
		updatedAt: now,
		updatedBy: copy.userId,
	});
	await ctx.db.delete("ai_chat_thread_copies", copy._id);
}

/**
 * Do one bounded step of a copy. `thread_branch` calls this until it returns `published` or
 * `aborted`.
 */
export const step = internalMutation({
	args: { copyId: v.id("ai_chat_thread_copies") },
	returns: v.union(v.literal("running"), v.literal("published"), v.literal("aborted")),
	handler: async (ctx, args) => {
		const copy = await ctx.db.get("ai_chat_thread_copies", args.copyId);
		if (!copy || copy.state.kind === "aborted") return "aborted";

		// The membership door also checks that the user and workspace are not being deleted and
		// that the source chat is still there.
		const now = Date.now();
		const target = await ctx.db.get("ai_chat_threads", copy.targetThreadId);
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, {
			organizationId: copy.organizationId,
			workspaceId: copy.workspaceId,
			userId: copy.userId,
			threadId: copy.sourceThreadId,
			membershipId: copy.membershipId,
			membershipLifetime: copy.membershipLifetime,
		});
		if (
			!membership ||
			!target ||
			target.deletingAt !== undefined ||
			target.copyingAt === undefined ||
			copy.expiresAt <= now
		) {
			await ai_chat_thread_copies_db_abort(ctx, copy);
			return "aborted";
		}

		// Walk up from the anchor and save the ids. Saved parents never change, so the list stays
		// right for every later step.
		if (copy.state.kind === "building") {
			const messageIds: Array<Id<"ai_chat_threads_messages_aisdk_5">> = [];
			let nextMessageId = copy.state.nextMessageId;
			let bytes = 0;
			while (nextMessageId && messageIds.length < PAGE_MAX_IDS && bytes < STEP_MAX_BYTES) {
				const message = await ctx.db.get("ai_chat_threads_messages_aisdk_5", nextMessageId);
				// A message is deleted only with its chat, and the check above proved the chat exists.
				if (!message) {
					throw should_never_happen("Branch copy parent message missing", { copyId: copy._id, nextMessageId });
				}
				messageIds.push(message._id);
				bytes += message.bytes;
				nextMessageId = message.parentId;
			}

			const pageCount = copy.state.pageCount + (messageIds.length > 0 ? 1 : 0);
			if (messageIds.length > 0) {
				await ctx.db.insert("ai_chat_thread_copy_pages", { copyId: copy._id, page: pageCount - 1, messageIds });
			}
			if (nextMessageId) {
				await ctx.db.patch("ai_chat_thread_copies", copy._id, {
					state: { kind: "building", nextMessageId, pageCount },
				});
				return "running";
			}
			// An empty chat has no pages.
			if (pageCount === 0) {
				await db_publish({ ctx, copy, now });
				return "published";
			}
			// The root is the last id of the last page, so the copy starts there.
			await ctx.db.patch("ai_chat_thread_copies", copy._id, {
				state: { kind: "copying", page: pageCount - 1, index: messageIds.length - 1, parentId: null },
			});
			return "running";
		}

		let { page, index, parentId } = copy.state;
		const pageDoc = await ctx.db
			.query("ai_chat_thread_copy_pages")
			.withIndex("by_copy_page", (q) => q.eq("copyId", copy._id).eq("page", page))
			.unique();
		if (!pageDoc) {
			throw should_never_happen("Branch copy page missing", { copyId: copy._id, page });
		}

		let copied = 0;
		let bytes = 0;
		while (index >= 0 && copied < COPY_MAX_MESSAGES && bytes < STEP_MAX_BYTES) {
			const message = await ctx.db.get("ai_chat_threads_messages_aisdk_5", pageDoc.messageIds[index]!);
			if (!message) {
				throw should_never_happen("Branch copy message missing", { copyId: copy._id, page, index });
			}
			parentId = await db_copy_message(ctx, { copy, message, parentId, now });
			bytes += message.bytes;
			copied += 1;
			index -= 1;
		}

		if (index >= 0) {
			await ctx.db.patch("ai_chat_thread_copies", copy._id, { state: { kind: "copying", page, index, parentId } });
			return "running";
		}

		await ctx.db.delete("ai_chat_thread_copy_pages", pageDoc._id);
		if (page > 0) {
			const nextPage = await ctx.db
				.query("ai_chat_thread_copy_pages")
				.withIndex("by_copy_page", (q) => q.eq("copyId", copy._id).eq("page", page - 1))
				.unique();
			if (!nextPage) {
				throw should_never_happen("Branch copy page missing", { copyId: copy._id, page: page - 1 });
			}
			await ctx.db.patch("ai_chat_thread_copies", copy._id, {
				state: { kind: "copying", page: page - 1, index: nextPage.messageIds.length - 1, parentId },
			});
			return "running";
		}

		await db_publish({ ctx, copy, now });
		return "published";
	},
});

export type ai_chat_thread_copies_step_Result =
	typeof step extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Abort copies whose `thread_branch` action stopped before it published them.
 */
export const abort_expired_copies = internalMutation({
	args: { _test_disableReschedule: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		let isBatchFull = false;
		for (const kind of ["building", "copying"] as const) {
			const expired = await ctx.db
				.query("ai_chat_thread_copies")
				.withIndex("by_state_expiresAt", (q) => q.eq("state.kind", kind).lt("expiresAt", now))
				.take(EXPIRED_BATCH_SIZE);
			for (const copy of expired) {
				await ai_chat_thread_copies_db_abort(ctx, copy);
			}
			isBatchFull ||= expired.length === EXPIRED_BATCH_SIZE;
		}

		// A full batch means more copies may still be waiting.
		if (isBatchFull && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.ai_chat_thread_copies.abort_expired_copies, {});
		}
		return null;
	},
});
