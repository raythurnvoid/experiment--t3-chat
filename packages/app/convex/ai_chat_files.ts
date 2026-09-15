import { v } from "convex/values";
import { paginationOptsValidator, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import app_convex_schema, { ai_chat_bash_result_validator } from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const BASH_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BASH_RESULT_MAX_BYTES = 700 * 1024;

// Begin and lost-reply readback use the same immutable call identity.
const bash_invocation_identity = {
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	userId: v.id("users"),
	threadId: v.id("ai_chat_threads"),
	toolCallId: v.string(),
	commandHash: v.string(),
};

const bash_invocation_result = v.object({
	isNew: v.boolean(),
	invocationId: v.id("ai_chat_bash_invocations"),
	membershipId: v.id("organizations_workspaces_users"),
	deadlineAt: v.number(),
	transferDeadlineAt: v.number(),
	status: app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.status,
	result: v.union(ai_chat_bash_result_validator, v.null()),
	resultExpired: v.boolean(),
});

export async function ai_chat_files_db_get_invocation_membership(
	ctx: QueryCtx | MutationCtx,
	invocation: Doc<"ai_chat_bash_invocations">,
) {
	const membership = await ctx.db.get("organizations_workspaces_users", invocation.membershipId);
	if (
		!membership?.active ||
		membership.userId !== invocation.userId ||
		membership.organizationId !== invocation.organizationId ||
		membership.workspaceId !== invocation.workspaceId
	)
		return null;
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, invocation);
	if (
		!lifetime?.active ||
		lifetime.membershipId !== invocation.membershipId ||
		lifetime.lifetime !== invocation.membershipLifetime
	)
		return null;
	const user = await ctx.db.get("users", invocation.userId);
	if (!user || user.deletedAt !== undefined) return null;
	const workspace = await ctx.db.get("organizations_workspaces", invocation.workspaceId);
	if (
		!workspace ||
		workspace.organizationId !== invocation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return null;
	const thread = await ctx.db.get("ai_chat_threads", invocation.threadId);
	if (!thread || thread.organizationId !== invocation.organizationId || thread.workspaceId !== invocation.workspaceId)
		return null;
	return membership;
}

function invocation_result(
	invocation: Pick<
		Doc<"ai_chat_bash_invocations">,
		"_id" | "membershipId" | "deadlineAt" | "transferDeadlineAt" | "status" | "result" | "resultExpiresAt"
	>,
	isNew = false,
) {
	const now = Date.now();
	const status = invocation.status === "running" && invocation.deadlineAt <= now ? "interrupted" : invocation.status;
	const resultExpired = status === "finished" && (!invocation.result || (invocation.resultExpiresAt ?? 0) <= now);
	return {
		isNew,
		invocationId: invocation._id,
		membershipId: invocation.membershipId,
		deadlineAt: invocation.deadlineAt,
		transferDeadlineAt: invocation.transferDeadlineAt,
		status,
		result: resultExpired ? null : (invocation.result ?? null),
		resultExpired,
	};
}

export const begin_bash_invocation = internalMutation({
	args: bash_invocation_identity,
	returns: v_result({ _yay: bash_invocation_result }),
	handler: async (ctx, args) => {
		if (!args.toolCallId || args.toolCallId.length > 256 || !/^[a-f0-9]{64}$/.test(args.commandHash))
			return Result({ _nay: { message: "Invalid Bash call identity." } });
		const existing = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (existing) {
			if (
				existing.organizationId !== args.organizationId ||
				existing.workspaceId !== args.workspaceId ||
				existing.userId !== args.userId ||
				!(await ai_chat_files_db_get_invocation_membership(ctx, existing))
			)
				return Result({ _nay: { message: "Unauthorized" } });
			if (existing.commandHash !== args.commandHash)
				return Result({
					_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
				});
			if (existing.status === "running" && existing.deadlineAt <= Date.now())
				await ctx.db.patch("ai_chat_bash_invocations", existing._id, { status: "interrupted", finishedAt: Date.now() });
			return Result({ _yay: invocation_result(existing) });
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.first();
		const user = await ctx.db.get("users", args.userId);
		const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (
			!membership ||
			!user ||
			user.deletedAt !== undefined ||
			!workspace ||
			workspace.organizationId !== args.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			!thread ||
			thread.organizationId !== args.organizationId ||
			thread.workspaceId !== args.workspaceId
		)
			return Result({ _nay: { message: "Unauthorized" } });
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return authorized;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		const now = Date.now();
		const invocation = {
			...args,
			membershipId: membership._id,
			membershipLifetime,
			status: "running" as const,
			deadlineAt: now + 120_000,
			transferDeadlineAt: now + 90_000,
		};
		const invocationId = await ctx.db.insert("ai_chat_bash_invocations", invocation);
		await ctx.scheduler.runAt(invocation.deadlineAt, internal.ai_chat_files.interrupt_bash_invocation, {
			invocationId,
		});
		return Result({ _yay: invocation_result({ ...invocation, _id: invocationId }, true) });
	},
});

export const get_bash_invocation = internalQuery({
	args: bash_invocation_identity,
	returns: v_result({ _yay: bash_invocation_result }),
	handler: async (ctx, args) => {
		const invocation = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (!invocation) return Result({ _nay: { message: "Not found" } });
		if (
			invocation.organizationId !== args.organizationId ||
			invocation.workspaceId !== args.workspaceId ||
			invocation.userId !== args.userId ||
			!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))
		)
			return Result({ _nay: { message: "Unauthorized" } });
		if (invocation.commandHash !== args.commandHash)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
			});
		return Result({ _yay: invocation_result(invocation) });
	},
});

export const finish_bash_invocation = internalMutation({
	args: {
		invocationId: v.id("ai_chat_bash_invocations"),
		commandHash: v.string(),
		result: ai_chat_bash_result_validator,
	},
	returns: v_result({ _yay: bash_invocation_result }),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (!invocation) return Result({ _nay: { message: "Not found" } });
		if (!(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
			return Result({ _nay: { message: "Unauthorized" } });
		if (invocation.commandHash !== args.commandHash)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash call already has a different command." },
			});
		if (invocation.status !== "running") return Result({ _yay: invocation_result(invocation) });

		if (invocation.deadlineAt <= Date.now()) {
			const patch = { status: "interrupted" as const, finishedAt: Date.now() };
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
			return Result({ _yay: invocation_result({ ...invocation, ...patch }) });
		}

		let result = args.result;
		// Keep a bounded replay even when multibyte output exceeds the shell's character cap.
		if (new TextEncoder().encode(JSON.stringify(result)).byteLength > BASH_RESULT_MAX_BYTES) {
			const stdout = result.stdout.slice(0, 16_384);
			const stderr = result.stderr.slice(0, 16_384);
			result = {
				title: result.title.slice(0, 256),
				output: `${stdout}${stderr ? `\n${stderr}` : ""}\n[Saved Bash result was truncated.]`,
				stdout,
				stderr,
				metadata: {
					...result.metadata,
					command: result.metadata.command.slice(0, 8192),
					cwd: result.metadata.cwd.slice(0, 1024),
					nextCwd: result.metadata.nextCwd.slice(0, 1024),
					stdoutTruncated: true,
					stderrTruncated: true,
					observedPaths: result.metadata.observedPaths.filter((path) => path.length <= 256).slice(0, 20),
					observedPathsTruncated: true,
				},
			};
		}

		const now = Date.now();
		const patch = {
			status: "finished" as const,
			finishedAt: now,
			result,
			resultExpiresAt: now + BASH_RESULT_RETENTION_MS,
		};

		await ctx.db.patch("ai_chat_bash_invocations", invocation._id, patch);
		await ctx.scheduler.runAt(patch.resultExpiresAt, internal.ai_chat_files.expire_bash_invocation_result, {
			invocationId: invocation._id,
		});

		return Result({ _yay: invocation_result({ ...invocation, ...patch }) });
	},
});

export const interrupt_bash_invocation = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (invocation?.status === "running")
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { status: "interrupted", finishedAt: Date.now() });
		return null;
	},
});

export const expire_bash_invocation_result = internalMutation({
	args: { invocationId: v.id("ai_chat_bash_invocations") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (invocation?.resultExpiresAt !== undefined && invocation.resultExpiresAt <= Date.now())
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { result: undefined, resultExpiresAt: undefined });
		return null;
	},
});

export const cleanup_expired_bash_results = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const invocations = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_resultExpiresAt", (q) => q.gt("resultExpiresAt", 0).lte("resultExpiresAt", Date.now()))
			.take(20);
		for (const invocation of invocations)
			await ctx.db.patch("ai_chat_bash_invocations", invocation._id, { result: undefined, resultExpiresAt: undefined });
		if (invocations.length === 20)
			await ctx.scheduler.runAfter(0, internal.ai_chat_files.cleanup_expired_bash_results, {});
		return null;
	},
});

export async function ai_chat_files_db_get_bash_transfer(
	ctx: QueryCtx | MutationCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number },
) {
	return await ctx.db
		.query("ai_chat_bash_invocation_transfers")
		.withIndex("by_invocation_commandNumber", (q) =>
			q.eq("invocationId", args.invocationId).eq("commandNumber", args.commandNumber),
		)
		.first();
}

/**
 * The producer calls this in the same mutation that accepts the transfer.
 */
export async function ai_chat_files_db_link_bash_transfer(
	ctx: MutationCtx,
	args: {
		invocationId: Id<"ai_chat_bash_invocations">;
		commandNumber: number;
		runId: Id<"files_transfer_runs">;
		activityId: Id<"activities">;
	},
) {
	const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
	if (!invocation || !(await ai_chat_files_db_get_invocation_membership(ctx, invocation)))
		return Result({ _nay: { message: "Unauthorized" } });
	if (!Number.isSafeInteger(args.commandNumber) || args.commandNumber < 0)
		return Result({ _nay: { message: "Invalid Bash command number." } });
	const existing = await ai_chat_files_db_get_bash_transfer(ctx, args);
	if (existing) {
		if (existing.runId !== args.runId || existing.activityId !== args.activityId)
			return Result({
				_nay: { name: "invocation_changed", message: "This Bash command already started another transfer." },
			});
		return Result({ _yay: existing });
	}
	if (invocation.status !== "running" || invocation.deadlineAt <= Date.now())
		return Result({
			_nay: { name: "invocation_interrupted", message: "This Bash call has ended. Start a new command." },
		});
	const link = {
		...args,
		organizationId: invocation.organizationId,
		workspaceId: invocation.workspaceId,
		threadId: invocation.threadId,
	};
	const id = await ctx.db.insert("ai_chat_bash_invocation_transfers", link);
	return Result({ _yay: (await ctx.db.get("ai_chat_bash_invocation_transfers", id))! });
}

/**
 * Accepted jobs are observable while the Bash action is still awaiting its result.
 */
export const list_bash_invocation_transfers = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		toolCallId: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.union(
		v.null(),
		v.object({
			invocationId: v.id("ai_chat_bash_invocations"),
			status: app_convex_schema.tables.ai_chat_bash_invocations.validator.fields.status,
			page: v.array(
				v.object({ commandNumber: v.number(), runId: v.id("files_transfer_runs"), activityId: v.id("activities") }),
			),
			isDone: v.boolean(),
			continueCursor: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const invocation = await ctx.db
			.query("ai_chat_bash_invocations")
			.withIndex("by_thread_toolCall", (q) => q.eq("threadId", args.threadId).eq("toolCallId", args.toolCallId))
			.first();
		if (!invocation || invocation.userId !== userAuth.id || invocation.membershipId !== args.membershipId) return null;
		const membership = await ai_chat_files_db_get_invocation_membership(ctx, invocation);
		if (!membership) return null;
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return null;
		const result = await ctx.db
			.query("ai_chat_bash_invocation_transfers")
			.withIndex("by_invocation_commandNumber", (q) => q.eq("invocationId", invocation._id))
			.paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)) });
		return {
			invocationId: invocation._id,
			status: invocation_result(invocation).status,
			page: result.page.map(({ commandNumber, runId, activityId }) => ({ commandNumber, runId, activityId })),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const load_thread_tmp_files = internalQuery({
	args: {
		threadId: v.id("ai_chat_threads"),
	},
	returns: v.object({
		file_nodes: v.array(doc(app_convex_schema, "ai_chat_files")),
		file_nodes_content_dict: v.record(v.id("ai_chat_files"), doc(app_convex_schema, "ai_chat_files_content")),
	}),
	handler: async (ctx, args) => {
		const fileNodes = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.threadId))
			.collect();
		const fileNodesContentDict: Record<Id<"ai_chat_files">, Doc<"ai_chat_files_content">> = {};
		for (const content of fileNodesContent) {
			fileNodesContentDict[content.fileNodeId] = content;
		}

		return {
			file_nodes: fileNodes,
			file_nodes_content_dict: fileNodesContentDict,
		};
	},
});

export type ai_chat_files_load_thread_tmp_files_Result =
	typeof load_thread_tmp_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const patch_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
		fileNodes: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
				mode: v.number(),
				size: v.number(),
				mtime: v.number(),
				symlinkTargetPath: v.optional(v.string()),
			}),
		),
		fileNodesContentDict: v.record(v.string(), v.bytes()),
		deletePaths: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const invocation = await ctx.db.get("ai_chat_bash_invocations", args.invocationId);
		if (
			!invocation ||
			invocation.organizationId !== args.organizationId ||
			invocation.workspaceId !== args.workspaceId ||
			invocation.threadId !== args.threadId ||
			!(await ai_chat_files_db_get_invocation_membership(ctx, invocation))
		) {
			throw convex_error({ message: "The Bash thread is no longer available." });
		}

		// Rejoining does not let an old call write into shared thread scratch.
		const existingAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.threadId))
			.collect();
		const existingByPath = new Map(existingAiChatFiles.map((fileNode) => [fileNode.path, fileNode]));

		await Promise.all(
			args.deletePaths.map(async (path) => {
				const existing = existingByPath.get(path);
				if (!existing) {
					return;
				}
				const aiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
					.collect();
				await Promise.all([
					...aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)),
					ctx.db.delete("ai_chat_files", existing._id),
				]);
			}),
		);

		await Promise.all(
			args.fileNodes.map(async (fileNode) => {
				const doc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.kind === "symlink" && fileNode.symlinkTargetPath !== undefined
						? { symlinkTargetPath: fileNode.symlinkTargetPath }
						: {}),
				};
				const existing = existingByPath.get(fileNode.path);
				const fileNodeId = existing?._id ?? (await ctx.db.insert("ai_chat_files", doc));
				if (existing) {
					await ctx.db.replace("ai_chat_files", existing._id, doc);
				}

				if (fileNode.kind !== "file") {
					if (existing) {
						const aiChatFilesContent = await ctx.db
							.query("ai_chat_files_content")
							.withIndex("by_fileNode", (q) => q.eq("fileNodeId", existing._id))
							.collect();
						await Promise.all(aiChatFilesContent.map((row) => ctx.db.delete("ai_chat_files_content", row._id)));
					}
					return;
				}

				const bytes = args.fileNodesContentDict[fileNode.path];
				if (bytes === undefined) {
					return;
				}
				const existingAiChatFilesContent = await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", fileNodeId))
					.first();
				const contentDoc = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.threadId,
					fileNodeId,
					bytes,
				};
				if (existingAiChatFilesContent) {
					await ctx.db.replace("ai_chat_files_content", existingAiChatFilesContent._id, contentDoc);
				} else {
					await ctx.db.insert("ai_chat_files_content", contentDoc);
				}
			}),
		);

		return null;
	},
});

export type ai_chat_files_patch_thread_tmp_files_Args =
	typeof patch_thread_tmp_files extends RegisteredMutation<infer _Visibility, infer Args, infer _ReturnValue>
		? Args
		: never;

export const copy_thread_tmp_files = internalMutation({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const sourceAiChatFiles = await ctx.db
			.query("ai_chat_files")
			.withIndex("by_thread_path", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const sourceAiChatFilesContent = await ctx.db
			.query("ai_chat_files_content")
			.withIndex("by_thread_fileNode", (q) => q.eq("threadId", args.sourceThreadId))
			.collect();
		const contentByFileNodeId = new Map(sourceAiChatFilesContent.map((content) => [content.fileNodeId, content]));

		// The branch target is created in the same transaction, so source rows are inserted as-is.
		await Promise.all(
			sourceAiChatFiles.map(async (fileNode) => {
				const fileNodeId = await ctx.db.insert("ai_chat_files", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					threadId: args.targetThreadId,
					path: fileNode.path,
					kind: fileNode.kind,
					mode: fileNode.mode,
					size: fileNode.size,
					mtime: fileNode.mtime,
					...(fileNode.symlinkTargetPath !== undefined ? { symlinkTargetPath: fileNode.symlinkTargetPath } : {}),
				});
				const content = contentByFileNodeId.get(fileNode._id);
				if (content) {
					await ctx.db.insert("ai_chat_files_content", {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						threadId: args.targetThreadId,
						fileNodeId,
						bytes: content.bytes,
					});
				}
			}),
		);

		return null;
	},
});
