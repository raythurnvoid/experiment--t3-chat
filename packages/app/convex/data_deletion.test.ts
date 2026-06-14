import { R2 } from "@convex-dev/r2";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { presence } from "./presence.ts";
import { test_convex } from "./setup.test.ts";
import { data_deletion_db_request } from "./data_deletion.ts";

const test = baseTest.sequential;
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "./workspaces.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_create_room_id, files_get_utf8_byte_size } from "../shared/files.ts";
import { app_presence_GLOBAL_ROOM_ID } from "../shared/shared-presence-constants.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function data_deletion_test_bootstrap_user(
	ctx: MutationCtx,
	args: { clerkUserId: string | null; displayName: string; avatarUrl?: string; email?: string },
) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	await Promise.all([
		quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			userId,
			now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl,
				email: args.email ?? "",
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.defaultWorkspaceId || !user.defaultProjectId || !user.anagraphic) {
		throw new Error("Failed to bootstrap user");
	}

	return {
		userId,
		defaultWorkspaceId: user.defaultWorkspaceId,
		defaultProjectId: user.defaultProjectId,
		anagraphicId: user.anagraphic,
	} as const;
}

async function data_deletion_test_seed_page(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		tag: string;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: `/${args.tag}`,
		treePath: `/${args.tag}`,
		pathDepth: 1,
		name: args.tag,
		kind: "file",
		lowercaseExtension: null,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});

	const markdown = `# ${args.tag}`;
	const assetId = await ctx.db.insert("files_r2_assets", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		kind: "content",
		r2Bucket: "test-bucket",
		r2Key: `workspaces/${args.workspaceId}/projects/${args.projectId}/assets/${nodeId}`,
		size: files_get_utf8_byte_size(markdown),
		createdBy: args.userId,
		updatedAt: Date.now(),
	});
	await ctx.db.patch("files_nodes", nodeId, {
		assetId,
		contentType: "text/markdown;charset=utf-8",
	});

	return {
		nodeId,
	} as const;
}

async function data_deletion_test_seed_project_content_bulk(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		count: number;
		tag: string;
	},
) {
	const r2Keys: string[] = [];
	for (let i = 0; i < args.count; i += 1) {
		const fileNodeId = await ctx.db.insert("files_nodes", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: `/${args.tag}-${i}.md`,
			treePath: `/${args.tag}-${i}.md`,
			pathDepth: 1,
			name: `${args.tag}-${i}.md`,
			kind: "file",
			lowercaseExtension: "md",
			parentId: "root",
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: Date.now(),
			contentType: "text/markdown;charset=utf-8",
		});
		const contentR2Key = `content/workspaces/${args.workspaceId}/projects/${args.projectId}/nodes/${args.tag}-${i}/markdown`;
		const yjsR2Key = `content/workspaces/${args.workspaceId}/projects/${args.projectId}/nodes/${args.tag}-${i}/yjs`;
		r2Keys.push(contentR2Key, yjsR2Key);
		const [assetId, yjsAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: contentR2Key,
				size: 12,
				createdBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				kind: "yjs_snapshot",
				r2Bucket: "test-bucket",
				r2Key: yjsR2Key,
				size: 12,
				createdBy: args.userId,
				updatedAt: Date.now(),
			}),
		]);
		const [statsId, yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
			ctx.db.insert("file_stats", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				lineCount: 1,
				wordCount: 2,
				charCount: 12,
			}),
			ctx.db.insert("files_yjs_snapshots", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				sequence: 1,
				assetId: yjsAssetId,
				createdBy: args.userId,
				updatedBy: String(args.userId),
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_yjs_docs_last_sequences", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				lastSequence: 1,
			}),
		]);
		await ctx.db.patch("files_nodes", fileNodeId, {
			assetId,
			statsId,
			yjsSnapshotId,
			yjsLastSequenceId,
		});
		const markdownChunkId = await ctx.db.insert("files_markdown_chunks", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			fileNodeId,
			yjsSequence: 1,
			chunkIndex: 0,
			markdownChunk: `# ${args.tag} ${i}`,
			startIndex: 0,
			endIndex: 12,
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		});
		await Promise.all([
			ctx.db.insert("files_plain_text_chunks", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				yjsSequence: 1,
				chunkIndex: 0,
				path: `/${args.tag}-${i}.md`,
				plainTextChunk: `${args.tag} ${i}`,
				markdownChunkId,
			}),
			ctx.db.insert("files_yjs_updates", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				sequence: 1,
				update: new ArrayBuffer(0),
				origin: { type: "USER_EDIT", sessionId: `${args.tag}-${i}` },
				createdBy: args.userId,
				createdAt: Date.now(),
			}),
			ctx.db.insert("files_snapshots", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId,
				assetId,
				createdBy: args.userId,
				archivedAt: -1,
			}),
		]);
		if (i < 5) {
			const pendingUpdateUpdatedAt = Date.now();
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				userId: String(args.userId),
				fileNodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: new ArrayBuffer(0),
				stagedBranchYjsUpdate: new ArrayBuffer(0),
				unstagedBranchYjsUpdate: new ArrayBuffer(0),
				updatedAt: pendingUpdateUpdatedAt,
			});
			await ctx.db.insert("files_pending_updates_chunks", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				userId: String(args.userId),
				fileNodeId,
				pendingUpdateId,
				chunkIndex: 0,
				markdownChunk: `# pending ${i}`,
				plainTextChunk: `pending ${i}`,
				startIndex: 0,
				endIndex: 10,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
			});
			const scheduledFunctionId = await ctx.scheduler.runAfter(
				4 * 60 * 60 * 1000,
				internal.files_pending_updates.remove_file_pending_update_if_expired,
				{
					pendingUpdateId,
					expectedUpdatedAt: pendingUpdateUpdatedAt,
				},
			);
			await ctx.db.insert("files_pending_updates_cleanup_tasks", {
				pendingUpdateId,
				scheduledFunctionId,
				expectedUpdatedAt: pendingUpdateUpdatedAt,
			});
		}
		await ctx.db.insert("files_pending_updates_last_sequence_saved", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: String(args.userId),
			fileNodeId,
			lastSequenceSaved: 1,
			updatedAt: Date.now(),
		});
		const threadId = await ctx.db.insert("ai_chat_threads", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			clientGeneratedId: `${args.tag}-thread-${i}`,
			title: `${args.tag} ${i}`,
			archived: false,
			runtime: "aisdk_5",
			stateId: null,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: Date.now(),
			lastMessageAt: Date.now(),
		});
		const [stateId, aiFileNodeId] = await Promise.all([
			ctx.db.insert("ai_chat_threads_state", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId,
				bashCwd: "~",
				updatedBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("ai_chat_files", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId,
				path: `/${args.tag}-${i}.txt`,
				kind: "file",
				mode: 0o100644,
				size: 4,
				mtime: Date.now(),
			}),
		]);
		await Promise.all([
			ctx.db.patch("ai_chat_threads", threadId, { stateId }),
			ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				parentId: null,
				threadId,
				clientGeneratedMessageId: `${args.tag}-message-${i}`,
				content: {},
				createdBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("ai_chat_files_content", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId,
				fileNodeId: aiFileNodeId,
				bytes: new ArrayBuffer(0),
			}),
			ctx.db.insert("chat_messages", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: null,
				parentId: null,
				isArchived: false,
				createdBy: String(args.userId),
				content: `${args.tag} ${i}`,
			}),
		]);
	}

	return { r2Keys };
}

async function data_deletion_test_count_project_content(ctx: MutationCtx, args: { workspaceId: string; projectId: string }) {
	const [
		files,
		fileStats,
		assets,
		markdownChunks,
		plainTextChunks,
		yjsSnapshots,
		yjsUpdates,
		yjsLastSequences,
		snapshots,
		pendingUpdates,
		pendingUpdateCleanupTasks,
		pendingUpdateChunks,
		lastSequenceSaved,
		materializationJobs,
		aiThreads,
		aiStates,
		aiMessages,
		aiFiles,
		aiFileContents,
		chatMessages,
	] = await Promise.all([
		ctx.db.query("files_nodes").collect(),
		ctx.db.query("file_stats").collect(),
		ctx.db.query("files_r2_assets").collect(),
		ctx.db.query("files_markdown_chunks").collect(),
		ctx.db.query("files_plain_text_chunks").collect(),
		ctx.db.query("files_yjs_snapshots").collect(),
		ctx.db.query("files_yjs_updates").collect(),
		ctx.db.query("files_yjs_docs_last_sequences").collect(),
		ctx.db.query("files_snapshots").collect(),
		ctx.db.query("files_pending_updates").collect(),
		ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
		ctx.db.query("files_pending_updates_chunks").collect(),
		ctx.db.query("files_pending_updates_last_sequence_saved").collect(),
		ctx.db.query("files_content_materialization_jobs").collect(),
		ctx.db.query("ai_chat_threads").collect(),
		ctx.db.query("ai_chat_threads_state").collect(),
		ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
		ctx.db.query("ai_chat_files").collect(),
		ctx.db.query("ai_chat_files_content").collect(),
		ctx.db.query("chat_messages").collect(),
	]);
	const inProject = (row: { workspaceId: string; projectId: string }) =>
		row.workspaceId === args.workspaceId && row.projectId === args.projectId;
	const projectPendingUpdateIds = new Set(pendingUpdates.filter(inProject).map((doc) => doc._id));
	return (
		[
			files,
			fileStats,
			assets,
			markdownChunks,
			plainTextChunks,
			yjsSnapshots,
			yjsUpdates,
			yjsLastSequences,
			snapshots,
			pendingUpdates,
			pendingUpdateChunks,
			lastSequenceSaved,
			materializationJobs,
			aiThreads,
			aiStates,
			aiMessages,
			aiFiles,
			aiFileContents,
			chatMessages,
		].reduce((total, rows) => total + rows.filter(inProject).length, 0) +
		pendingUpdateCleanupTasks.filter((doc) => projectPendingUpdateIds.has(doc.pendingUpdateId)).length
	);
}

async function data_deletion_test_process_project_request_until_done(
	t: ReturnType<typeof test_convex>,
	args: { requestId: Id<"data_deletion_requests">; batchSize?: number },
) {
	for (let i = 0; i < 300; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId: args.requestId,
				_test_batchSize: args.batchSize,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("Project deletion request did not finish");
}

async function data_deletion_test_process_workspace_request_until_done(
	t: ReturnType<typeof test_convex>,
	args: { requestId: Id<"data_deletion_requests">; batchSize?: number },
) {
	for (let i = 0; i < 300; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: args.requestId,
				_test_batchSize: args.batchSize,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("Workspace deletion request did not finish");
}

async function data_deletion_test_hard_delete_user_data_until_done(
	t: ReturnType<typeof test_convex>,
	args: { userId: Id<"users">; batchSize?: number },
) {
	for (let i = 0; i < 100; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
				userId: args.userId,
				_test_batchSize: args.batchSize,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("User data hard delete did not finish");
}

async function data_deletion_test_run_worker_until_idle(
	t: ReturnType<typeof test_convex>,
	args?: { batchSize?: number; testNow?: number },
) {
	for (let i = 0; i < 40; i += 1) {
		const eligibleRequestCount = await data_deletion_test_count_eligible_requests(t, args);
		if (eligibleRequestCount === 0) {
			return;
		}

		await t.action(internal.data_deletion.enqueue_deletion_requests_processing, {
			_test_now: args?.testNow,
			_test_batchSize: args?.batchSize,
			_test_disableReschedule: true,
		});
		await data_deletion_test_finish_immediate_scheduled_functions(t);
	}

	throw new Error("Deletion worker did not finish eligible requests");
}

async function data_deletion_test_count_eligible_requests(
	t: ReturnType<typeof test_convex>,
	args?: { testNow?: number },
) {
	return await t.run(async (ctx) => {
		const [userRequests, workspaceRequests, projectRequests] = await Promise.all([
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "user",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "workspace",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "project",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
		]);

		return userRequests.length + workspaceRequests.length + projectRequests.length;
	});
}

async function data_deletion_test_finish_immediate_scheduled_functions(t: ReturnType<typeof test_convex>) {
	for (let i = 0; i < 75; i += 1) {
		vi.advanceTimersByTime(1000);
		await t.finishInProgressScheduledFunctions();
	}
}

async function data_deletion_test_hard_delete_user_now_data_until_idle(
	t: ReturnType<typeof test_convex>,
	args: { userId: Id<"users">; batchSize?: number },
) {
	for (let i = 0; i < 10; i += 1) {
		await t.action(internal.users.hard_delete_user_now, {
			userId: args.userId,
			purgeUserMod: "data",
			_test_batchSize: args.batchSize,
			_test_disableReschedule: true,
		});
	}
}

describe("data_deletion_db_request", () => {
	test("dedupes user, workspace, and project requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-dedup",
				displayName: "Dedup User",
			}),
		);

		const workspace = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: user.userId,
				name: "dedup-space",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		if (workspace._nay) {
			throw new Error(workspace._nay.message);
		}

		const extraProject = await t.run(async (ctx) =>
			workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "dedup-extra-project",
				description: "",
				now: Date.now(),
			}),
		);
		if (extraProject._nay) {
			throw new Error(extraProject._nay.message);
		}

		const requests = await t.run(async (ctx) => {
			const userRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});
			const userRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});

			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});
			const workspaceRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});

			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});
			const projectRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});
			const workspaceRequestIdAfterProject = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
			});

			return {
				userRequestId,
				userRequestIdAgain,
				workspaceRequestId,
				workspaceRequestIdAgain,
				workspaceRequestIdAfterProject,
				projectRequestId,
				projectRequestIdAgain,
				rows: await ctx.db.query("data_deletion_requests").collect(),
			};
		});

		expect(requests.userRequestId).toBe(requests.userRequestIdAgain);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAgain);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAfterProject);
		expect(requests.projectRequestId).toBe(requests.projectRequestIdAgain);
		expect(requests.rows).toHaveLength(3);
		expect(requests.rows.filter((row) => row.scope === "user")).toHaveLength(1);
		expect(
			requests.rows.filter((row) => row.scope === "workspace" && row.workspaceId === workspace._yay.workspaceId),
		).toHaveLength(1);
		expect(
			requests.rows.filter(
				(row) =>
					row.scope === "project" &&
					row.workspaceId === workspace._yay.workspaceId &&
					row.projectId === extraProject._yay.projectId,
			),
		).toHaveLength(1);
	});

	test("keeps the earliest eligible time when requests are repeated", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-request-earliest",
				displayName: "Request Earliest",
			}),
		);

		const workspace = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: user.userId,
				name: "earliest-space",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		if (workspace._nay) {
			throw new Error(workspace._nay.message);
		}

		const project = await t.run(async (ctx) =>
			workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "earliest-project",
				description: "",
				now: Date.now(),
			}),
		);
		if (project._nay) {
			throw new Error(project._nay.message);
		}

		const requests = await t.run(async (ctx) => {
			const userRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
				eligibleAt: 20_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
				eligibleAt: 10_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
				eligibleAt: 30_000,
			});

			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 40_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 25_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 50_000,
			});

			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: project._yay.projectId,
				scope: "project",
				eligibleAt: 60_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: project._yay.projectId,
				scope: "project",
				eligibleAt: 35_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: project._yay.projectId,
				scope: "project",
				eligibleAt: 70_000,
			});

			const [userRequest, workspaceRequest, projectRequest] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId),
				ctx.db.get("data_deletion_requests", workspaceRequestId),
				ctx.db.get("data_deletion_requests", projectRequestId),
			]);

			return {
				userRequest,
				workspaceRequest,
				projectRequest,
			};
		});

		expect(requests.userRequest?.eligibleAt).toBe(10_000);
		expect(requests.workspaceRequest?.eligibleAt).toBe(25_000);
		expect(requests.projectRequest?.eligibleAt).toBe(35_000);
	});
});

describe("init_user_deletion", () => {
	test("only tombstones the user and deactivates memberships during phase 1", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-phase-one",
				displayName: "Phase One User",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-phase-one-collaborator",
				displayName: "Phase One Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: collaborator.userId,
				name: "phase-one-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: deletedUser.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: collaborator.userId,
				workspaceId: created._yay.workspaceId,
				name: "p1-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				userId: deletedUser.userId,
				active: true,
			});

			return {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
				extraProjectId: extraProject._yay.projectId,
			} as const;
		});

		await t.run(async (ctx) => {
			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					workspaceId: String(deletedUser.defaultWorkspaceId),
					projectId: String(deletedUser.defaultProjectId),
					tag: "phase-one-personal-page",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					workspaceId: String(sharedWorkspace.workspaceId),
					projectId: String(sharedWorkspace.extraProjectId),
					tag: "phase-one-shared-extra-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: deletedUser.userId,
					polarCustomerId: "cust_phase_one",
					subscription: null,
					meter: null,
					lastSyncedAt: 11_111,
				}),
			]);
		});

		const sharedPresenceRoomId = files_create_room_id(
			String(sharedWorkspace.workspaceId),
			String(sharedWorkspace.extraProjectId),
			"phase-one-shared-presence-page",
		);
		await t.run(async (ctx) => {
			await Promise.all([
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: app_presence_GLOBAL_ROOM_ID,
					userId: deletedUser.userId,
					sessionId: "phase-one-deleted-global",
					interval: 10_000,
				}),
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: sharedPresenceRoomId,
					userId: deletedUser.userId,
					sessionId: "phase-one-deleted-shared",
					interval: 10_000,
				}),
				ctx.runMutation(components.presence.public.heartbeat, {
					roomId: sharedPresenceRoomId,
					userId: collaborator.userId,
					sessionId: "phase-one-collaborator-shared",
					interval: 10_000,
				}),
			]);
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [
				user,
				request,
				requests,
				memberships,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedExtraProject,
				personalPages,
				sharedExtraPages,
				snapshots,
				deletedPresenceRooms,
				collaboratorPresenceRooms,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(deletedUser.defaultProjectId))),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				presence.listUser(ctx, deletedUser.userId, false, 10_000),
				presence.listUser(ctx, collaborator.userId, false, 10_000),
			]);

			return {
				user,
				request,
				requests,
				memberships,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedExtraProject,
				personalPages,
				sharedExtraPages,
				snapshots,
				deletedPresenceRooms,
				collaboratorPresenceRooms,
			};
		});

		expect(after.user?.deletedAt).toBe(10_001);
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-phase-one");
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBe(deletedUser.defaultProjectId);
		expect(after.request?._id).toBe(requestId);
		expect(after.requests).toHaveLength(1);
		expect(after.requests[0]?.scope).toBe("user");
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.memberships.every((membership) => membership.active === false)).toBe(true);
		expect(after.personalWorkspace?._id).toBe(deletedUser.defaultWorkspaceId);
		expect(after.personalProject?._id).toBe(deletedUser.defaultProjectId);
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.personalPages).toHaveLength(1);
		expect(after.sharedExtraPages).toHaveLength(1);
		expect(after.snapshots).toHaveLength(1);
		expect(after.deletedPresenceRooms).toHaveLength(0);
		expect(after.collaboratorPresenceRooms.map((room) => room.roomId)).toContain(sharedPresenceRoomId);
	});

	test("allows account deletion after ownership was transferred first", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-transfer",
				displayName: "Owned Transfer",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-transfer-collaborator",
				displayName: "Owned Transfer Collaborator",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: owner.userId,
				name: "owned-transfer",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
			});

			return created._yay;
		});

		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-owned-transfer-owner",
			external_id: owner.userId,
			name: "Owned Transfer Owner",
			email: "owned-transfer-owner@test.local",
		});
		const transferResult = await ownerClient.mutation(api.access_control.transfer_workspace_ownership, {
			workspaceId: workspace.workspaceId,
			newOwnerUserId: collaborator.userId,
		});
		expect(transferResult._nay).toBeUndefined();

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: owner.userId,
				nowTs: 42_002,
			}),
		);

		expect(requestId).toBeTruthy();
		const after = await t.run(async (ctx) => {
			const [user, ownerRole, workspaceDoc, collaboratorQuota, workspaceRequests] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_role_user", (q) =>
						q.eq("workspaceId", workspace.workspaceId).eq("projectId", workspace.defaultProjectId).eq("role", "owner"),
					)
					.first(),
				ctx.db.get("workspaces", workspace.workspaceId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", collaborator.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", workspace.workspaceId).eq("scope", "workspace"))
					.collect(),
			]);

			return { user, ownerRole, workspaceDoc, collaboratorQuota, workspaceRequests };
		});

		expect(after.user?.deletedAt).toBe(42_002);
		expect(after.ownerRole?.userId).toBe(collaborator.userId);
		expect(after.workspaceDoc).not.toBeNull();
		expect(after.collaboratorQuota?.usedCount).toBe(1);
		expect(after.workspaceRequests).toHaveLength(0);
	});

	test("queues remaining owned workspace deletion and removes memberships immediately", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-delete",
				displayName: "Owned Delete",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-owned-delete-collaborator",
				displayName: "Owned Delete Collaborator",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: owner.userId,
				name: "owned-delete",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
			});

			return created._yay;
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: owner.userId,
				nowTs: 42_003,
			}),
		);

		expect(requestId).toBeTruthy();
		const after = await t.run(async (ctx) => {
			const [user, workspaceDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db.get("workspaces", workspace.workspaceId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_role_user", (q) =>
						q.eq("workspaceId", workspace.workspaceId).eq("projectId", workspace.defaultProjectId).eq("role", "owner"),
					)
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", workspace.workspaceId))
					.collect(),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_workspace_project_user", (q) =>
						q.eq("active", true).eq("workspaceId", workspace.workspaceId),
					)
					.collect(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_workspace_scope", (q) => q.eq("workspaceId", workspace.workspaceId).eq("scope", "workspace"))
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", owner.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
			]);

			return { user, workspaceDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBe(42_003);
		expect(after.workspaceDoc).not.toBeNull();
		expect(after.ownerRoles).toHaveLength(0);
		expect(after.permissionGrants).toHaveLength(0);
		expect(after.memberships).toHaveLength(0);
		expect(after.requests).toHaveLength(1);
		expect(after.ownerQuota?.usedCount).toBe(0);
	});
});

describe("process_user_deletion_request", () => {
	test("tombstones the user, preserves shared content, and directly purges empty personal workspaces", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-main",
				displayName: "Deleted User",
				avatarUrl: "https://example.com/avatar.png",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-collaborator",
				displayName: "Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-space",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: deletedUser.userId,
				active: true,
			});

			await ctx.db.insert("files_pending_updates", {
				workspaceId: String(created._yay.workspaceId),
				projectId: String(created._yay.defaultProjectId),
				userId: String(deletedUser.userId),
				fileNodeId: (
					await data_deletion_test_seed_page(ctx, {
						userId: deletedUser.userId,
						workspaceId: String(created._yay.workspaceId),
						projectId: String(created._yay.defaultProjectId),
						tag: "shared-page",
					})
				).nodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: new ArrayBuffer(0),
				stagedBranchYjsUpdate: new ArrayBuffer(0),
				unstagedBranchYjsUpdate: new ArrayBuffer(0),
				updatedAt: Date.now(),
			});

			await ctx.db.insert("files_pending_updates_last_sequence_saved", {
				workspaceId: String(created._yay.workspaceId),
				projectId: String(created._yay.defaultProjectId),
				userId: String(deletedUser.userId),
				fileNodeId: await ctx.db
					.query("files_nodes")
					.collect()
					.then((pages) => {
						const page = pages.find(
							(page) =>
								page.workspaceId === String(created._yay.workspaceId) &&
								page.projectId === String(created._yay.defaultProjectId) &&
								page.kind === "file" &&
								page.name === "shared-page",
						);
						if (!page) {
							throw new Error("shared page not found");
						}

						return page._id;
					}),
				lastSequenceSaved: 0,
				updatedAt: Date.now(),
			});

			return created._yay;
		});

		await t.run(async (ctx) => {
			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					workspaceId: String(deletedUser.defaultWorkspaceId),
					projectId: String(deletedUser.defaultProjectId),
					tag: "personal-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: deletedUser.userId,
					polarCustomerId: "cust_process_user_retained",
					subscription: null,
					meter: null,
					lastSyncedAt: 66_666,
				}),
			]);
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);

		const requestEligibleAt = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!.eligibleAt;
		});
		const test_now = requestEligibleAt + 1;

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: test_now,
			}),
		);
		await data_deletion_test_run_worker_until_idle(t, { testNow: test_now });

		const afterUserDeletion = await t.run(async (ctx) => {
			const [
				user,
				anagraphic,
				memberships,
				roleAssignments,
				permissionGrants,
				pendingUpdates,
				pendingUpdateSaves,
				cleanupTasks,
				purgeRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
				personalPages,
				snapshots,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_user_role_workspace_project", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_user_workspace_project_resource_permission", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_fileNode", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db
					.query("files_pending_updates_last_sequence_saved")
					.withIndex("by_user_fileNode", (q) => q.eq("userId", String(deletedUser.userId)))
					.collect(),
				ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.get("workspaces", sharedWorkspace.workspaceId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((pages) =>
						pages.filter(
							(page) =>
								page.workspaceId === String(sharedWorkspace.workspaceId) &&
								page.projectId === String(sharedWorkspace.defaultProjectId) &&
								page.kind === "file" &&
								page.name === "shared-page",
						),
					),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				user,
				anagraphic,
				memberships,
				roleAssignments,
				permissionGrants,
				pendingUpdates,
				pendingUpdateSaves,
				cleanupTasks,
				purgeRequests,
				personalWorkspace,
				personalProject,
				sharedWorkspaceDoc,
				sharedPages,
				personalPages,
				snapshots,
			};
		});

		expect(afterUserDeletion.user?.deletedAt).toBe(10_001);
		expect(afterUserDeletion.user?.clerkUserId).toBe("clerk-user-delete-main");
		expect(afterUserDeletion.user?.defaultWorkspaceId).toBeUndefined();
		expect(afterUserDeletion.user?.defaultProjectId).toBeUndefined();
		expect(afterUserDeletion.anagraphic?.displayName).toBe("Deleted User");
		expect(afterUserDeletion.memberships).toHaveLength(0);
		expect(afterUserDeletion.roleAssignments).toHaveLength(0);
		expect(afterUserDeletion.permissionGrants).toHaveLength(0);
		expect(afterUserDeletion.pendingUpdates).toHaveLength(0);
		expect(afterUserDeletion.pendingUpdateSaves).toHaveLength(0);
		expect(afterUserDeletion.cleanupTasks).toHaveLength(0);
		expect(afterUserDeletion.personalWorkspace).toBeNull();
		expect(afterUserDeletion.personalProject).toBeNull();
		expect(afterUserDeletion.personalPages).toHaveLength(0);
		expect(afterUserDeletion.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(afterUserDeletion.purgeRequests).toHaveLength(0);
		expect(afterUserDeletion.sharedPages).toHaveLength(1);
		expect(afterUserDeletion.snapshots).toHaveLength(1);
	});

	test("clears user quota docs when the queued request runs after the user doc is gone", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-missing-user-quota",
				displayName: "Missing User Quota",
			}),
		);

		const requestId = await t.run(async (ctx) => {
			const requestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				scope: "user",
			});

			await ctx.db.delete("users", deletedUser.userId);

			return requestId;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [request, userQuotaDocs] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				request,
				userQuotaDocs,
			};
		});

		expect(after.request).toBeNull();
		expect(after.userQuotaDocs).toHaveLength(0);
	});

	test("keeps shared orphaned projects after retention when the workspace still has active users", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-shared-orphan",
				displayName: "Deleted Shared Orphan User",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-shared-orphan-collaborator",
				displayName: "Shared Orphan Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-orphan-space",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: deletedUser.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: created._yay.workspaceId,
				name: "shared-orphan-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			return {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
				extraProjectId: extraProject._yay.projectId,
			} as const;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(sharedWorkspace.workspaceId),
				projectId: String(sharedWorkspace.extraProjectId),
				tag: "shared-orphan-retained-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 20_001,
			}),
		);
		const requestEligibleAt = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!.eligibleAt;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestEligibleAt + 1,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, sharedWorkspaceDoc, sharedDefaultProject, sharedExtraProject, sharedExtraPages, memberships] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.get("workspaces", sharedWorkspace.workspaceId),
					ctx.db.get("workspaces_projects", sharedWorkspace.defaultProjectId),
					ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", deletedUser.userId))
						.collect(),
				]);

			return {
				user,
				sharedWorkspaceDoc,
				sharedDefaultProject,
				sharedExtraProject,
				sharedExtraPages,
				memberships,
			};
		});

		expect(after.user?.deletedAt).toBe(20_001);
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedDefaultProject?._id).toBe(sharedWorkspace.defaultProjectId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.sharedExtraPages).toHaveLength(1);
		expect(after.memberships).toHaveLength(0);
	});
});

describe("process_project_deletion_request", () => {
	test("removes invalid project requests without a project id", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-project-invalid-request",
				displayName: "Project Invalid Request",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				scope: "project",
				eligibleAt: 0,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId,
			}),
		);
		const after = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));

		expect(result).toEqual({ done: true, deletedCount: 1 });
		expect(after).toBeNull();
	});

	test("purges project content in retryable batches without touching sibling projects", async () => {
		const t = test_convex();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject");
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-project-batch",
				displayName: "Project Batch",
			}),
		);

		const { victimProjectId, controlProjectId, requestId, r2Keys } = await t.run(async (ctx) => {
			const victimProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "batch-victim",
				description: "",
				now: Date.now(),
			});
			if (victimProject._nay) {
				throw new Error(victimProject._nay.message);
			}
			const controlProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "batch-control",
				description: "",
				now: Date.now(),
			});
			if (controlProject._nay) {
				throw new Error(controlProject._nay.message);
			}

			const seeded = await data_deletion_test_seed_project_content_bulk(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(victimProject._yay.projectId),
				count: 20,
				tag: "project-batch-victim",
			});
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(controlProject._yay.projectId),
				tag: "project-batch-control",
			});

			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: victimProject._yay.projectId,
				scope: "project",
			});
			return {
				victimProjectId: victimProject._yay.projectId,
				controlProjectId: controlProject._yay.projectId,
				requestId,
				r2Keys: seeded.r2Keys,
			};
		});

		const beforeCount = await t.run((ctx) =>
			data_deletion_test_count_project_content(ctx, {
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(victimProjectId),
			}),
		);
		const firstResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId,
				_test_batchSize: 5,
			}),
		);
		const afterFirst = await t.run(async (ctx) => {
			const [request, victimCount, controlCount] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(victimProjectId),
				}),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(controlProjectId),
				}),
			]);

			return { request, victimCount, controlCount };
		});

		expect(firstResult.done).toBe(false);
		expect(afterFirst.request?._id).toBe(requestId);
		expect(afterFirst.victimCount).toBeGreaterThan(0);
		expect(afterFirst.victimCount).toBeLessThan(beforeCount);
		expect(afterFirst.controlCount).toBeGreaterThan(0);

		await data_deletion_test_process_project_request_until_done(t, {
			requestId,
			batchSize: 5,
		});

		const afterDone = await t.run(async (ctx) => {
			const [request, victimCount, controlCount] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(victimProjectId),
				}),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(controlProjectId),
				}),
			]);

			return { request, victimCount, controlCount };
		});

		expect(afterDone.request).toBeNull();
		expect(afterDone.victimCount).toBe(0);
		expect(afterDone.controlCount).toBeGreaterThan(0);
		for (const r2Key of r2Keys) {
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), r2Key);
		}
	});

	test("leaves R2 asset rows retryable when object deletion fails", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-project-r2-failure",
				displayName: "Project R2 Failure",
			}),
		);

		const { requestId, assetId } = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/r2-failure",
				createdBy: user.userId,
				updatedAt: Date.now(),
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				scope: "project",
			});
			return {
				requestId,
				assetId,
			};
		});

		vi.spyOn(R2.prototype, "deleteObject").mockRejectedValue(new Error("R2 unavailable"));

		await expect(
			t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
					requestId,
					_test_batchSize: 5,
				}),
			),
		).rejects.toThrow("R2 unavailable");

		const after = await t.run(async (ctx) => {
			const [request, asset] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("files_r2_assets", assetId),
			]);

			return { request, asset };
		});

		expect(after.request?._id).toBe(requestId);
		expect(after.asset?._id).toBe(assetId);
	});

	test("cancels materialization jobs before deleting their tracking docs", async () => {
		const t = test_convex();
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-project-materialization-job",
				displayName: "Project Materialization Job",
			}),
		);
		const jobId = "work_project_materialization_delete" as WorkId;

		const { requestId, jobDocId, fileNodeId } = await t.run(async (ctx) => {
			const fileNodeId = await ctx.db.insert("files_nodes", {
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				path: "/materialization-job.md",
				treePath: "/materialization-job.md",
				pathDepth: 1,
				name: "materialization-job.md",
				kind: "file",
				lowercaseExtension: "md",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: Date.now(),
			});
			const jobDocId = await ctx.db.insert("files_content_materialization_jobs", {
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				fileNodeId,
				jobId,
				targetSequence: 1,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				scope: "project",
			});

			return { requestId, jobDocId, fileNodeId };
		});

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId,
				_test_batchSize: 5,
			}),
		);
		const after = await t.run(async (ctx) => {
			const [request, jobDoc, fileNode] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("files_content_materialization_jobs", jobDocId),
				ctx.db.get("files_nodes", fileNodeId),
			]);

			return { request, jobDoc, fileNode };
		});

		expect(result).toEqual({ done: false, deletedCount: 1 });
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), jobId);
		expect(after.request?._id).toBe(requestId);
		expect(after.jobDoc).toBeNull();
		expect(after.fileNode?._id).toBe(fileNodeId);
	});
});

describe("process_workspace_deletion_request", () => {
	test("removes invalid workspace requests without a workspace id", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-workspace-invalid-request",
				displayName: "Workspace Invalid Request",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
			}),
		);
		const after = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));

		expect(result).toEqual({ done: true, deletedCount: 1 });
		expect(after).toBeNull();
	});

	test("purges the whole workspace and clears matching queued project requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-workspace-request",
				displayName: "Delete Workspace Request",
			}),
		);

		const workspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "workspace-request",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		const extraProject = await t.run(async (ctx) => {
			const created = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				name: "ws-req-extra",
				description: "",
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		await t.run(async (ctx) => {
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(workspace.workspaceId),
				projectId: String(workspace.defaultProjectId),
				tag: "workspace-request-default-page",
			});
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(workspace.workspaceId),
				projectId: String(extraProject.projectId),
				tag: "workspace-request-extra-page",
			});
		});

		const { workspaceRequestId, projectRequestId } = await t.run(async (ctx) => {
			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				projectId: extraProject.projectId,
				scope: "project",
			});
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: workspace.workspaceId,
				scope: "workspace",
			});
			return {
				workspaceRequestId,
				projectRequestId,
			};
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: workspaceRequestId,
		});

		const after = await t.run(async (ctx) => {
			const [
				workspaceDoc,
				defaultProjectDoc,
				extraProjectDoc,
				workspaceRequest,
				projectRequest,
				files,
				fileAssets,
				workspaceQuotaDocs,
			] = await Promise.all([
					ctx.db.get("workspaces", workspace.workspaceId),
					ctx.db.get("workspaces_projects", workspace.defaultProjectId),
					ctx.db.get("workspaces_projects", extraProject.projectId),
					ctx.db.get("data_deletion_requests", workspaceRequestId),
					ctx.db.get("data_deletion_requests", projectRequestId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === String(workspace.workspaceId))),
					ctx.db
						.query("files_r2_assets")
						.withIndex("by_workspace_project", (q) =>
							q.eq("workspaceId", String(workspace.workspaceId)).eq("projectId", String(workspace.defaultProjectId)),
						)
						.collect(),
					ctx.db
						.query("quotas")
						.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", workspace.workspaceId))
						.collect(),
				]);

			return {
				workspaceDoc,
				defaultProjectDoc,
				extraProjectDoc,
				workspaceRequest,
				projectRequest,
				files,
				fileAssets,
				workspaceQuotaDocs,
			};
		});

		expect(after.workspaceDoc).toBeNull();
		expect(after.defaultProjectDoc).toBeNull();
		expect(after.extraProjectDoc).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.files).toHaveLength(0);
		expect(after.fileAssets).toHaveLength(0);
		expect(after.workspaceQuotaDocs).toHaveLength(0);
	});

	test("purges queued project content even when the project doc was already removed", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-workspace-missing-project",
				displayName: "Workspace Missing Project",
			}),
		);

		const { workspaceId, defaultProjectId, removedProjectId, workspaceRequestId, projectRequestId } = await t.run(
			async (ctx) => {
				const workspace = await workspaces_db_create(ctx, {
					userId: user.userId,
					name: "ws-missing-project",
					description: "",
					now: Date.now(),
					default: false,
				});
				if (workspace._nay) {
					throw new Error(workspace._nay.message);
				}
				const removedProject = await workspaces_db_create_project(ctx, {
					userId: user.userId,
					workspaceId: workspace._yay.workspaceId,
					name: "removed-project",
					description: "",
					now: Date.now(),
				});
				if (removedProject._nay) {
					throw new Error(removedProject._nay.message);
				}

				await Promise.all([
					data_deletion_test_seed_project_content_bulk(ctx, {
						userId: user.userId,
						workspaceId: String(workspace._yay.workspaceId),
						projectId: String(workspace._yay.defaultProjectId),
						count: 8,
						tag: "workspace-default-batch",
					}),
					data_deletion_test_seed_project_content_bulk(ctx, {
						userId: user.userId,
						workspaceId: String(workspace._yay.workspaceId),
						projectId: String(removedProject._yay.projectId),
						count: 20,
						tag: "workspace-removed-batch",
					}),
				]);

				const projectRequestId = await data_deletion_db_request(ctx, {
					userId: user.userId,
					workspaceId: workspace._yay.workspaceId,
					projectId: removedProject._yay.projectId,
					scope: "project",
				});
				await ctx.db.delete("workspaces_projects", removedProject._yay.projectId);
				const workspaceRequestId = await data_deletion_db_request(ctx, {
					userId: user.userId,
					workspaceId: workspace._yay.workspaceId,
					scope: "workspace",
				});
				return {
					workspaceId: workspace._yay.workspaceId,
					defaultProjectId: workspace._yay.defaultProjectId,
					removedProjectId: removedProject._yay.projectId,
					workspaceRequestId,
					projectRequestId,
				};
			},
		);

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: workspaceRequestId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [workspace, defaultProject, workspaceRequest, projectRequest, defaultContent, removedContent, quotaDocs] =
				await Promise.all([
					ctx.db.get("workspaces", workspaceId),
					ctx.db.get("workspaces_projects", defaultProjectId),
					ctx.db.get("data_deletion_requests", workspaceRequestId),
					ctx.db.get("data_deletion_requests", projectRequestId),
					data_deletion_test_count_project_content(ctx, {
						workspaceId: String(workspaceId),
						projectId: String(defaultProjectId),
					}),
					data_deletion_test_count_project_content(ctx, {
						workspaceId: String(workspaceId),
						projectId: String(removedProjectId),
					}),
					ctx.db
						.query("quotas")
						.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", workspaceId))
						.collect(),
				]);

			return {
				workspace,
				defaultProject,
				workspaceRequest,
				projectRequest,
				defaultContent,
				removedContent,
				quotaDocs,
			};
		});

		expect(after.workspace).toBeNull();
		expect(after.defaultProject).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.defaultContent).toBe(0);
		expect(after.removedContent).toBe(0);
		expect(after.quotaDocs).toHaveLength(0);
	});
});

describe("hard_delete_user_data", () => {
	test("preserves the usable default tenant while purging reset-owned content and disposable tenants", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-live",
				displayName: "Reset Live",
			}),
		);
		const unrelatedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-unrelated",
				displayName: "Reset Unrelated",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				tag: "reset-default-page",
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "reset-personal-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(extraProject._yay.projectId),
				tag: "reset-personal-extra-page",
			});

			const ownedWorkspace = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "reset-owned-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (ownedWorkspace._nay) {
				throw new Error(ownedWorkspace._nay.message);
			}
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				workspaceId: String(ownedWorkspace._yay.workspaceId),
				projectId: String(ownedWorkspace._yay.defaultProjectId),
				tag: "reset-owned-workspace-page",
			});

			const userRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});
			const defaultWorkspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			const defaultProjectRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				scope: "project",
			});
			const unrelatedRequestId = await data_deletion_db_request(ctx, {
				userId: unrelatedUser.userId,
				workspaceId: unrelatedUser.defaultWorkspaceId,
				projectId: unrelatedUser.defaultProjectId,
				scope: "project",
			});

			return {
				extraProjectId: extraProject._yay.projectId,
				ownedWorkspaceId: ownedWorkspace._yay.workspaceId,
				ownedDefaultProjectId: ownedWorkspace._yay.defaultProjectId,
				userRequestId,
				defaultWorkspaceRequestId,
				defaultProjectRequestId,
				unrelatedRequestId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
		});

		const after = await t.run(async (ctx) => {
			const [
				userDoc,
				defaultWorkspace,
				defaultProject,
				defaultMembership,
				defaultOwnerRole,
				defaultWorkspaceGrants,
				defaultProjectFiles,
				extraProject,
				ownedWorkspace,
				ownedDefaultProject,
				personalProjectQuota,
				userWorkspaceQuota,
				userRequest,
				defaultWorkspaceRequest,
				defaultProjectRequest,
				resetUserRequests,
				unrelatedRequest,
			] = await Promise.all([
				ctx.db.get("users", user.userId),
				ctx.db.get("workspaces", user.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", user.defaultProjectId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q
							.eq("active", true)
							.eq("userId", user.userId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("projectId", user.defaultProjectId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_user_role", (q) =>
						q
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("projectId", user.defaultProjectId)
							.eq("userId", user.userId)
							.eq("role", "owner"),
					)
					.first(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_workspace_project_resource_role_permission", (q) =>
						q
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("projectId", user.defaultProjectId)
							.eq("resourceKind", "workspace")
							.eq("resourceId", String(user.defaultWorkspaceId))
							.eq("principalKind", "role"),
					)
					.collect(),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) =>
						rows.filter(
							(row) =>
								row.workspaceId === String(user.defaultWorkspaceId) &&
								row.projectId === String(user.defaultProjectId),
						),
					),
				ctx.db.get("workspaces_projects", seeded.extraProjectId),
				ctx.db.get("workspaces", seeded.ownedWorkspaceId),
				ctx.db.get("workspaces_projects", seeded.ownedDefaultProjectId),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", user.defaultWorkspaceId).eq("quotaName", "extra_projects"),
					)
					.first(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", user.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db.get("data_deletion_requests", seeded.userRequestId),
				ctx.db.get("data_deletion_requests", seeded.defaultWorkspaceRequestId),
				ctx.db.get("data_deletion_requests", seeded.defaultProjectRequestId),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_user", (q) => q.eq("userId", user.userId))
					.collect(),
				ctx.db.get("data_deletion_requests", seeded.unrelatedRequestId),
			]);

			return {
				userDoc,
				defaultWorkspace,
				defaultProject,
				defaultMembership,
				defaultOwnerRole,
				defaultWorkspaceGrants,
				defaultProjectFiles,
				extraProject,
				ownedWorkspace,
				ownedDefaultProject,
				personalProjectQuota,
				userWorkspaceQuota,
				userRequest,
				defaultWorkspaceRequest,
				defaultProjectRequest,
				resetUserRequests,
				unrelatedRequest,
			};
		});

		expect(after.userDoc?.deletedAt).toBeUndefined();
		expect(after.userDoc?.clerkUserId).toBe("clerk-user-reset-live");
		expect(after.userDoc?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(after.userDoc?.defaultProjectId).toBe(user.defaultProjectId);
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
		expect(after.defaultProject?._id).toBe(user.defaultProjectId);
		expect(after.defaultMembership?._id).toBeDefined();
		expect(after.defaultOwnerRole?._id).toBeDefined();
		expect(after.defaultWorkspaceGrants.length).toBeGreaterThan(0);
		expect(after.defaultProjectFiles).toHaveLength(0);
		expect(after.extraProject).toBeNull();
		expect(after.ownedWorkspace).toBeNull();
		expect(after.ownedDefaultProject).toBeNull();
		expect(after.personalProjectQuota?.usedCount).toBe(0);
		expect(after.userWorkspaceQuota?.usedCount).toBe(0);
		expect(after.userRequest).toBeNull();
		expect(after.defaultWorkspaceRequest).toBeNull();
		expect(after.defaultProjectRequest).toBeNull();
		expect(after.resetUserRequests).toHaveLength(0);
		expect(after.unrelatedRequest?._id).toBe(seeded.unrelatedRequestId);
	});

	test("admin data reset batches content while preserving auth, profile, billing, and default workspace/project docs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-action-batch",
				displayName: "Reset Action Batch",
				email: "reset-action-batch@test.local",
			}),
		);

		const { extraProjectId, anonymousTokenId, billingSnapshotId } = await t.run(async (ctx) => {
			const anonymousTokenId = await ctx.db.insert("users_anon_tokens", {
				userId: user.userId,
				token: "reset-action-token",
				updatedAt: 88_001,
			});
			await ctx.db.patch("users", user.userId, {
				anonymousAuthToken: anonymousTokenId,
			});
			const billingSnapshotId = await ctx.db.insert("billing_usage_snapshots", {
				userId: user.userId,
				polarCustomerId: "cust_reset_action_batch",
				subscription: null,
				meter: null,
				lastSyncedAt: 88_002,
			});
			const extraProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "reset-action-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			await Promise.all([
				data_deletion_test_seed_project_content_bulk(ctx, {
					userId: user.userId,
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(user.defaultProjectId),
					count: 20,
					tag: "reset-action-default",
				}),
				data_deletion_test_seed_project_content_bulk(ctx, {
					userId: user.userId,
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(extraProject._yay.projectId),
					count: 20,
					tag: "reset-action-extra",
				}),
			]);

			return {
				extraProjectId: extraProject._yay.projectId,
				anonymousTokenId,
				billingSnapshotId,
			};
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		await data_deletion_test_hard_delete_user_now_data_until_idle(t, {
			userId: user.userId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [
				userDoc,
				anagraphic,
				anonymousToken,
				billingSnapshot,
				defaultWorkspace,
				defaultProject,
				extraProject,
				defaultMembership,
				ownerRole,
				defaultContent,
				extraContent,
			] = await Promise.all([
				ctx.db.get("users", user.userId),
				ctx.db.get("users_anagraphics", user.anagraphicId),
				ctx.db.get("users_anon_tokens", anonymousTokenId),
				ctx.db.get("billing_usage_snapshots", billingSnapshotId),
				ctx.db.get("workspaces", user.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", user.defaultProjectId),
				ctx.db.get("workspaces_projects", extraProjectId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q
							.eq("active", true)
							.eq("userId", user.userId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("projectId", user.defaultProjectId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_user_role", (q) =>
						q
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("projectId", user.defaultProjectId)
							.eq("userId", user.userId)
							.eq("role", "owner"),
					)
					.first(),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(user.defaultProjectId),
				}),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(extraProjectId),
				}),
			]);

			return {
				userDoc,
				anagraphic,
				anonymousToken,
				billingSnapshot,
				defaultWorkspace,
				defaultProject,
				extraProject,
				defaultMembership,
				ownerRole,
				defaultContent,
				extraContent,
			};
		});

		expect(after.userDoc?.clerkUserId).toBe("clerk-user-reset-action-batch");
		expect(after.userDoc?.anonymousAuthToken).toBe(anonymousTokenId);
		expect(after.userDoc?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(after.userDoc?.defaultProjectId).toBe(user.defaultProjectId);
		expect(after.anagraphic?.displayName).toBe("Reset Action Batch");
		expect(after.anonymousToken?.token).toBe("reset-action-token");
		expect(after.billingSnapshot?.polarCustomerId).toBe("cust_reset_action_batch");
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
		expect(after.defaultProject?._id).toBe(user.defaultProjectId);
		expect(after.defaultMembership?._id).toBeDefined();
		expect(after.ownerRole?._id).toBeDefined();
		expect(after.extraProject).toBeNull();
		expect(after.defaultContent).toBe(0);
		expect(after.extraContent).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("purges queued personal project content after the project doc was already deleted", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-deleted-project-request",
				displayName: "Reset Deleted Project Request",
			}),
		);

		const { removedProjectId, requestId } = await t.run(async (ctx) => {
			const extraProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "reset-del-proj",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			await data_deletion_test_seed_project_content_bulk(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(extraProject._yay.projectId),
				count: 3,
				tag: "reset-deleted-project",
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
			});

			await ctx.db.delete("workspaces_projects", extraProject._yay.projectId);

			return {
				removedProjectId: extraProject._yay.projectId,
				requestId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [request, contentCount, defaultWorkspace, defaultProject] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(removedProjectId),
				}),
				ctx.db.get("workspaces", user.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", user.defaultProjectId),
			]);

			return {
				request,
				contentCount,
				defaultWorkspace,
				defaultProject,
			};
		});

		expect(after.request).toBeNull();
		expect(after.contentCount).toBe(0);
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
		expect(after.defaultProject?._id).toBe(user.defaultProjectId);
	});

	test("throws when resetting a tombstoned user without a default tenant", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-tombstone",
				displayName: "Reset Tombstone",
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: user.userId,
				deleteUserAuth: false,
			}),
		);

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
						userId: user.userId,
					}),
				),
			).rejects.toThrow("Default tenant is missing or inconsistent during data reset");
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Default tenant is missing or inconsistent during data reset",
				expect.objectContaining({
					defaultWorkspaceId: undefined,
					defaultProjectId: undefined,
					membershipFound: false,
					userId: user.userId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("throws when the cached default project is not the workspace default project", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-wrong-default-project",
				displayName: "Reset Wrong Default Project",
			}),
		);
		const extraProject = await t.run(async (ctx) => {
			const result = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				name: "wrong-default",
				description: "",
				now: Date.now(),
			});
			if (result._nay) {
				throw new Error(result._nay.message);
			}
			await ctx.db.patch("users", user.userId, {
				defaultProjectId: result._yay.projectId,
			});
			return result._yay;
		});

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
						userId: user.userId,
					}),
				),
			).rejects.toThrow("Default tenant is missing or inconsistent during data reset");
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Default tenant is missing or inconsistent during data reset",
				expect.objectContaining({
					defaultWorkspaceId: user.defaultWorkspaceId,
					defaultProjectId: extraProject.projectId,
					projectDefault: false,
					workspaceDefaultProjectId: user.defaultProjectId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("preserves shared workspaces and only deletes reset-user-only extra projects", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-shared",
				displayName: "Reset Shared",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-shared-collaborator",
				displayName: "Reset Shared Collaborator",
			}),
		);

		const shared = await t.run(async (ctx) => {
			const workspace = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "reset-shared-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: workspace._yay.workspaceId,
				projectId: workspace._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
				updatedAt: Date.now(),
			});

			const soloProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "reset-solo-project",
				description: "",
				now: Date.now(),
			});
			if (soloProject._nay) {
				throw new Error(soloProject._nay.message);
			}

			const sharedProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "reset-shared-project",
				description: "",
				now: Date.now(),
			});
			if (sharedProject._nay) {
				throw new Error(sharedProject._nay.message);
			}
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: workspace._yay.workspaceId,
				projectId: sharedProject._yay.projectId,
				userId: collaborator.userId,
				active: true,
				updatedAt: Date.now(),
			});

			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: user.userId,
					workspaceId: String(workspace._yay.workspaceId),
					projectId: String(soloProject._yay.projectId),
					tag: "reset-solo-project-page",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: user.userId,
					workspaceId: String(workspace._yay.workspaceId),
					projectId: String(sharedProject._yay.projectId),
					tag: "reset-shared-project-page",
				}),
			]);

			return {
				workspaceId: workspace._yay.workspaceId,
				defaultProjectId: workspace._yay.defaultProjectId,
				soloProjectId: soloProject._yay.projectId,
				sharedProjectId: sharedProject._yay.projectId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
		});

		const after = await t.run(async (ctx) => {
			const [workspace, defaultProject, soloProject, sharedProject, sharedProjectFiles, projectQuota] = await Promise.all([
				ctx.db.get("workspaces", shared.workspaceId),
				ctx.db.get("workspaces_projects", shared.defaultProjectId),
				ctx.db.get("workspaces_projects", shared.soloProjectId),
				ctx.db.get("workspaces_projects", shared.sharedProjectId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.projectId === String(shared.sharedProjectId))),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", shared.workspaceId).eq("quotaName", "extra_projects"),
					)
					.first(),
			]);

			return {
				workspace,
				defaultProject,
				soloProject,
				sharedProject,
				sharedProjectFiles,
				projectQuota,
			};
		});

		expect(after.workspace?._id).toBe(shared.workspaceId);
		expect(after.defaultProject?._id).toBe(shared.defaultProjectId);
		expect(after.soloProject).toBeNull();
		expect(after.sharedProject?._id).toBe(shared.sharedProjectId);
		expect(after.sharedProjectFiles).toHaveLength(1);
		expect(after.projectQuota?.usedCount).toBe(1);
	});
});

describe("finalize_user_deletion_data", () => {
	test("directly purges local data and only clears matching request rows", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-direct",
				displayName: "Hard Delete Data Direct",
			}),
		);
		const unrelatedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-unrelated",
				displayName: "Unrelated User",
			}),
		);
		const unrelatedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: unrelatedUser.userId,
				name: "hd-unrelated",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "direct-user-purge-page",
			}),
		);
		const deletedR2Keys = await t.run(async (ctx) => {
			const now = Date.now();
			const markdownR2Key = `content/workspaces/${deletedUser.defaultWorkspaceId}/projects/${deletedUser.defaultProjectId}/nodes/direct-user-purge-page/markdown`;
			const yjsR2Key = `content/workspaces/${deletedUser.defaultWorkspaceId}/projects/${deletedUser.defaultProjectId}/nodes/direct-user-purge-page/yjs-snapshot`;

			await Promise.all([
				ctx.db.insert("files_r2_assets", {
					workspaceId: String(deletedUser.defaultWorkspaceId),
					projectId: String(deletedUser.defaultProjectId),
					kind: "content",
					r2Bucket: "test-bucket",
					r2Key: markdownR2Key,
					createdBy: deletedUser.userId,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					workspaceId: String(deletedUser.defaultWorkspaceId),
					projectId: String(deletedUser.defaultProjectId),
					kind: "yjs_snapshot",
					r2Bucket: "test-bucket",
					r2Key: yjsR2Key,
					createdBy: deletedUser.userId,
					updatedAt: now,
				}),
			]);

			return [markdownR2Key, yjsR2Key] as const;
		});

		const requestIds = await t.run(async (ctx) => {
			const userRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				scope: "user",
			});
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				scope: "workspace",
			});
			const projectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				projectId: deletedUser.defaultProjectId,
				scope: "project",
			});
			const unrelatedProjectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: unrelatedWorkspace.workspaceId,
				projectId: unrelatedWorkspace.defaultProjectId,
				scope: "project",
			});

			return {
				userRequestId,
				workspaceRequestId,
				projectRequestId,
				unrelatedProjectRequestId,
			};
		});

		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);
		await data_deletion_test_run_worker_until_idle(t);

		const after = await t.run(async (ctx) => {
			const [user, workspace, project, files, filesR2Assets, userRequest, workspaceRequest, projectRequest, unrelatedProjectRequest] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
					ctx.db
						.query("files_r2_assets")
						.withIndex("by_workspace_project", (q) =>
							q.eq("workspaceId", String(deletedUser.defaultWorkspaceId)).eq("projectId", String(deletedUser.defaultProjectId)),
						)
						.collect(),
					ctx.db.get("data_deletion_requests", requestIds.userRequestId),
					ctx.db.get("data_deletion_requests", requestIds.workspaceRequestId),
					ctx.db.get("data_deletion_requests", requestIds.projectRequestId),
					ctx.db.get("data_deletion_requests", requestIds.unrelatedProjectRequestId),
				]);

			return {
				user,
				workspace,
				project,
				files,
				filesR2Assets,
				userRequest,
				workspaceRequest,
				projectRequest,
				unrelatedProjectRequest,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-data-direct");
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
		expect(after.user?.defaultProjectId).toBeUndefined();
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.files).toHaveLength(0);
		expect(after.filesR2Assets).toHaveLength(0);
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), deletedR2Keys[0]);
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), deletedR2Keys[1]);
		deleteObjectSpy.mockRestore();
		expect(after.userRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.unrelatedProjectRequest?._id).toBe(requestIds.unrelatedProjectRequestId);
	});

	test("finishes a user whose scheduled deletion was already initialized and preserves billing snapshots by default", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-initialized",
				displayName: "Hard Delete Data Initialized",
			}),
		);

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "initialized-user-purge-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);

		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: deletedUser.userId,
				polarCustomerId: "cust_initialized_hard_delete",
				subscription: null,
				meter: null,
				lastSyncedAt: 77_777,
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);
		await data_deletion_test_run_worker_until_idle(t);

		const after = await t.run(async (ctx) => {
			const [user, request, workspace, project, files, snapshots] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				user,
				request,
				workspace,
				project,
				files,
				snapshots,
			};
		});

		expect(after.user?.deletedAt).toBe(30_001);
		expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-data-initialized");
		expect(after.request).toBeNull();
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.files).toHaveLength(0);
		expect(after.snapshots).toHaveLength(1);
	});

	test("deletes billing snapshots only when finalization is explicitly purging billing state", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-delete-billing",
				displayName: "Hard Delete Data Delete Billing",
			}),
		);

		await t.run(async (ctx) => {
			await Promise.all([
				ctx.runMutation(internal.data_deletion.init_user_deletion, {
					userId: deletedUser.userId,
					nowTs: 30_501,
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: deletedUser.userId,
					polarCustomerId: "cust_delete_billing_state",
					subscription: null,
					meter: null,
					lastSyncedAt: 77_501,
				}),
			]);
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
				deleteBillingState: true,
			}),
		);

		const snapshots = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
		);

		expect(snapshots).toHaveLength(0);
	});

	test("can preserve user auth when the caller keeps the user record", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-preserve-auth",
				displayName: "Hard Delete Data Preserve Auth",
			}),
		);
		const anonymousTokenId = await t.run(async (ctx) => {
			const tokenId = await ctx.db.insert("users_anon_tokens", {
				userId: deletedUser.userId,
				token: "hard-delete-data-preserved-token",
				updatedAt: 44_444,
			});
			await ctx.db.patch("users", deletedUser.userId, {
				anonymousAuthToken: tokenId,
			});

			return tokenId;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
				deleteUserAuth: false,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [user, anonymousToken] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anon_tokens", anonymousTokenId),
			]);

			return {
				user,
				anonymousToken,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-data-preserve-auth");
		expect(after.user?.anonymousAuthToken).toBe(anonymousTokenId);
		expect(after.anonymousToken?.token).toBe("hard-delete-data-preserved-token");
	});

	test("keeps shared orphaned projects while deleting the user data directly", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-shared",
				displayName: "Hard Delete Data Shared",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-data-collaborator",
				displayName: "Hard Delete Data Collaborator",
			}),
		);

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: deletedUser.userId,
				name: "hd-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: collaborator.userId,
				active: true,
			});

			const extraProject = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: created._yay.workspaceId,
				name: "hd-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}

			return {
				workspaceId: created._yay.workspaceId,
				defaultProjectId: created._yay.defaultProjectId,
				extraProjectId: extraProject._yay.projectId,
			};
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(sharedWorkspace.workspaceId),
				projectId: String(sharedWorkspace.extraProjectId),
				tag: "shared-orphan-project-page",
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);
		await data_deletion_test_run_worker_until_idle(t);

		const after = await t.run(async (ctx) => {
			const [user, requests, sharedWorkspaceDoc, sharedDefaultProject, sharedExtraProject, extraProjectPages] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("workspaces", sharedWorkspace.workspaceId),
					ctx.db.get("workspaces_projects", sharedWorkspace.defaultProjectId),
					ctx.db.get("workspaces_projects", sharedWorkspace.extraProjectId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.projectId === String(sharedWorkspace.extraProjectId))),
				]);

			return {
				user,
				requests,
				sharedWorkspaceDoc,
				sharedDefaultProject,
				sharedExtraProject,
				extraProjectPages,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.requests).toHaveLength(0);
		expect(after.sharedWorkspaceDoc?._id).toBe(sharedWorkspace.workspaceId);
		expect(after.sharedDefaultProject?._id).toBe(sharedWorkspace.defaultProjectId);
		expect(after.sharedExtraProject?._id).toBe(sharedWorkspace.extraProjectId);
		expect(after.extraProjectPages).toHaveLength(1);
	});
});

describe("list_deletion_request_ids_by_scope", () => {
	test("returns at most limit eligible user-scoped ids across paginated global order", async () => {
		const t = test_convex();
		const maxEligibleAt = await t.run(async (ctx) => {
			for (let i = 0; i < 22; i++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `clerk-user-scope-list-${i}` });
				await data_deletion_db_request(ctx, { userId, scope: "user" });
			}
			const rows = await ctx.db.query("data_deletion_requests").collect();
			return Math.max(...rows.map((row) => row.eligibleAt));
		});
		const listed = await t.run((ctx) =>
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "user",
				limit: 20,
				_test_now: maxEligibleAt + 1,
			}),
		);
		expect(listed).toHaveLength(20);
	});
});

describe("enqueue_deletion_requests_processing", () => {
	test("runs the pipeline on an eligible project deletion request", async () => {
		const t = test_convex();
		const { requestId, test_now } = await t.run(async (ctx) => {
			const user = await data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-pipeline-project",
				displayName: "Pipeline Project",
			});
			const workspace = await workspaces_db_create(ctx, {
				userId: user.userId,
				name: "pipeline-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			const extraProject = await workspaces_db_create_project(ctx, {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "pipeline-proj",
				description: "",
				now: Date.now(),
			});
			if (extraProject._nay) {
				throw new Error(extraProject._nay.message);
			}
			const rid = await ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: extraProject._yay.projectId,
				scope: "project",
				eligibleAt: Date.now() + RETENTION_MS,
			});
			const row = await ctx.db.get("data_deletion_requests", rid!);
			if (!row) {
				throw new Error("Expected purge request");
			}
			return { requestId: rid, test_now: row.eligibleAt + 1 };
		});
		await t.action(internal.data_deletion.enqueue_deletion_requests_processing, { _test_now: test_now });
		const queued = await t.run(async (ctx) => ctx.db.get("data_deletion_requests", requestId));
		expect(queued).not.toBeNull();
		await data_deletion_test_finish_immediate_scheduled_functions(t);
		await data_deletion_test_run_worker_until_idle(t, { testNow: test_now });
		const remaining = await t.run(async (ctx) => ctx.db.get("data_deletion_requests", requestId));
		expect(remaining).toBeNull();
	});

	test("drains a multi-batch project fixture through the action worker", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-worker-batch-drain",
				displayName: "Worker Batch Drain",
			}),
		);

		const { requestId, test_now } = await t.run(async (ctx) => {
			await data_deletion_test_seed_project_content_bulk(ctx, {
				userId: user.userId,
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				count: 20,
				tag: "worker-batch-drain",
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				scope: "project",
			});
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected project deletion request");
			}

			return {
				requestId,
				test_now: request.eligibleAt + 1,
			};
		});

		await data_deletion_test_run_worker_until_idle(t, {
			testNow: test_now,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [request, contentCount] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_project_content(ctx, {
					workspaceId: String(user.defaultWorkspaceId),
					projectId: String(user.defaultProjectId),
				}),
			]);

			return { request, contentCount };
		});

		expect(after.request).toBeNull();
		expect(after.contentCount).toBe(0);
	});

	test("reschedules when a processor throws and leaves the request retryable", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-worker-r2-failure",
				displayName: "Worker R2 Failure",
			}),
		);

		const { requestId, assetId, test_now } = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: String(user.defaultWorkspaceId),
				projectId: String(user.defaultProjectId),
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/worker-r2-failure",
				createdBy: user.userId,
				updatedAt: Date.now(),
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				workspaceId: user.defaultWorkspaceId,
				projectId: user.defaultProjectId,
				scope: "project",
			});
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected project deletion request");
			}

			return {
				requestId,
				assetId,
				test_now: request.eligibleAt + 1,
			};
		});

		vi.spyOn(R2.prototype, "deleteObject").mockRejectedValueOnce(new Error("R2 unavailable"));
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_now: test_now,
				_test_disableReschedule: true,
				_test_batchSize: 5,
			});
			const after = await t.run(async (ctx) => {
				const [request, asset] = await Promise.all([
					ctx.db.get("data_deletion_requests", requestId),
					ctx.db.get("files_r2_assets", assetId),
				]);

				return { request, asset };
			});

			expect(result.steps).toBe(1);
			expect(result.shouldReschedule).toBe(true);
			expect(after.request?._id).toBe(requestId);
			expect(after.asset?._id).toBe(assetId);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to process project deletion request",
				expect.objectContaining({
					requestId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("directly consumes an already-queued project request during the user phase in the same run", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-pipeline-user-first",
				displayName: "Pipeline User First",
			}),
		);

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "pipeline-personal-page",
			}),
		);

		const { userRequestId, projectRequestId, test_now } = await t.run(async (ctx) => {
			const queuedProjectRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: deletedUser.defaultWorkspaceId,
				projectId: deletedUser.defaultProjectId,
				scope: "project",
			});
			const queuedProjectRequest = await ctx.db.get("data_deletion_requests", queuedProjectRequestId);
			if (!queuedProjectRequest) {
				throw new Error("Expected queued project deletion request");
			}

			const rid = await ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 40_001,
			});
			const row = await ctx.db.get("data_deletion_requests", rid!);
			if (!row) {
				throw new Error("Expected user deletion request");
			}

			return {
				userRequestId: rid!,
				projectRequestId: queuedProjectRequestId,
				test_now: Math.max(row.eligibleAt, queuedProjectRequest.eligibleAt) + 1,
			};
		});

		await t.action(internal.data_deletion.enqueue_deletion_requests_processing, { _test_now: test_now });
		await data_deletion_test_run_worker_until_idle(t, { testNow: test_now });

		const after = await t.run(async (ctx) => {
			const [userRequest, projectRequest, requests, workspace, project, files] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId!),
				ctx.db.get("data_deletion_requests", projectRequestId),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("workspaces_projects", deletedUser.defaultProjectId),
				ctx.db.query("files_nodes").collect(),
			]);

			return {
				userRequest,
				projectRequest,
				requests,
				workspace,
				project,
				files: files.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId)),
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.projectRequest).toBeNull();
		expect(after.requests).toHaveLength(0);
		expect(after.workspace).toBeNull();
		expect(after.project).toBeNull();
		expect(after.files).toHaveLength(0);
	});

	test("respects the per-run mutation step budget", async () => {
		const t = test_convex();
		const maxEligibleAt = await t.run(async (ctx) => {
			const now = Date.now();

			for (let i = 0; i < 25; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-user-${i}`,
					deletedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					scope: "user",
					eligibleAt: now + RETENTION_MS,
				});
			}

			for (let i = 0; i < 55; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-workspace-${i}`,
				});
				const workspaceId = await ctx.db.insert("workspaces", {
					name: `quota-workspace-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					workspaceId,
					scope: "workspace",
					eligibleAt: now + RETENTION_MS,
				});
			}

			for (let i = 0; i < 205; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-project-${i}`,
				});
				const workspaceId = await ctx.db.insert("workspaces", {
					name: `quota-project-workspace-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				const projectId = await ctx.db.insert("workspaces_projects", {
					workspaceId,
					name: `quota-project-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					workspaceId,
					projectId,
					scope: "project",
					eligibleAt: now + RETENTION_MS,
				});
			}

			const rows = await ctx.db.query("data_deletion_requests").collect();
			return Math.max(...rows.map((row) => row.eligibleAt));
		});

		await t.action(internal.data_deletion.enqueue_deletion_requests_processing, {
			_test_now: maxEligibleAt + 1,
			_test_disableReschedule: true,
		});
		await data_deletion_test_finish_immediate_scheduled_functions(t);

		const remaining = await t.run(async (ctx) => ctx.db.query("data_deletion_requests").collect());

		expect(remaining.filter((row) => row.scope === "user")).toHaveLength(5);
		expect(remaining.filter((row) => row.scope === "workspace")).toHaveLength(50);
		expect(remaining.filter((row) => row.scope === "project")).toHaveLength(205);
	});

	test("reschedules when project-only requests use the whole step budget", async () => {
		const t = test_convex();
		const eligibleAt = await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 26; i += 1) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-project-only-budget-${i}`,
				});
				const workspaceId = await ctx.db.insert("workspaces", {
					name: `project-only-budget-workspace-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				const projectId = await ctx.db.insert("workspaces_projects", {
					workspaceId,
					name: `project-only-budget-project-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					workspaceId,
					projectId,
					scope: "project",
					eligibleAt: now,
				});
			}
			return now;
		});

		const result = await t.action(internal.data_deletion.process_deletion_requests, {
			_test_now: eligibleAt,
			_test_disableReschedule: true,
		});
		const remaining = await t.run(async (ctx) => ctx.db.query("data_deletion_requests").collect());

		expect(result.steps).toBe(25);
		expect(result.shouldReschedule).toBe(true);
		expect(remaining.filter((row) => row.scope === "project")).toHaveLength(1);
	});
});

describe("resolve_user after tombstone", () => {
	test("reclaims the same user row during retention and preserves default content", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-retention",
				displayName: "Returning User",
				email: "returning-user-retention@test.local",
			}),
		);
		const recoveryEmail = "returning-user-retention@test.local";

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				workspaceId: String(deletedUser.defaultWorkspaceId),
				projectId: String(deletedUser.defaultProjectId),
				tag: "retained-personal-page",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_101,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-retention-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [user, request, memberships, anagraphic, files] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db
					.query("workspaces_projects_users")
					.collect()
					.then((rows) => rows.filter((row) => row.userId === deletedUser.userId)),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === String(deletedUser.defaultWorkspaceId))),
			]);

			return {
				user,
				request,
				memberships,
				anagraphic,
				files,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-return-retention-again");
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBe(deletedUser.defaultProjectId);
		expect(after.request).toBeNull();
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.memberships.every((membership) => membership.active !== false)).toBe(true);
		expect(after.anagraphic?.email).toBe(recoveryEmail);
		expect(after.files).toHaveLength(1);
	});

	test("reclaims the same user row during retention and returns the billing restore marker", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-billing",
				displayName: "Returning Billing User",
				email: "returning-billing-user@test.local",
			}),
		);
		const recoveryEmail = "returning-billing-user@test.local";

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_returning_billing_user",
			userId: deletedUser.userId,
		});
		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "prod_returning_billing_user",
				organizationId: "returning_billing_org",
				name: "Returning Billing Product",
				description: "Returning billing product",
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});
		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_returning_billing_user",
				customerId: "cust_returning_billing_user",
				productId: "prod_returning_billing_user",
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "eur",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				canceledAt: "2026-01-15T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				endsAt: "2026-02-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_201,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-billing-again",
				email: recoveryEmail,
				displayName: "Returning Billing User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);

			return {
				request,
			};
		});

		expect(result._yay.restoredDeletedAccount).toBe(true);
		expect(after.request).toBeNull();
	});

	test("reclaims the same user row after retention purge and recreates default tenant state", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return",
				displayName: "Returning User",
				email: "returning-user@test.local",
			}),
		);
		const recoveryEmail = "returning-user@test.local";

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_returning_user",
			userId: deletedUser.userId,
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);
		const requestEligibleAt2 = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!.eligibleAt;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestEligibleAt2 + 1,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [user, customer, quota, anagraphic] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.runQuery(components.polar.lib.getCustomerByUserId, {
					userId: deletedUser.userId,
				}),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", deletedUser.userId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
			]);

			const [workspace, project] =
				user?.defaultWorkspaceId && user.defaultProjectId
					? await Promise.all([
							ctx.db.get("workspaces", user.defaultWorkspaceId),
							ctx.db.get("workspaces_projects", user.defaultProjectId),
						])
					: [null, null];

			return {
				user,
				customer,
				quota,
				anagraphic,
				workspace,
				project,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-return");
		expect(after.user?.defaultWorkspaceId).toBeDefined();
		expect(after.user?.defaultWorkspaceId).not.toBe(deletedUser.defaultWorkspaceId);
		expect(after.user?.defaultProjectId).toBeDefined();
		expect(after.user?.defaultProjectId).not.toBe(deletedUser.defaultProjectId);
		expect(after.workspace?._id).toBe(after.user?.defaultWorkspaceId);
		expect(after.project?._id).toBe(after.user?.defaultProjectId);
		expect(after.customer?.id).toBe("cust_returning_user");
		expect(after.quota).not.toBeNull();
		expect(after.anagraphic?.email).toBe(recoveryEmail);
	});

	test("creates a fresh user row when the returning email does not match", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-non-match",
				displayName: "Returning User",
				email: "returning-user-non-match@test.local",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_001,
			}),
		);
		const requestEligibleAt = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId!);
			return request!.eligibleAt;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: requestEligibleAt + 1,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-non-match-again",
				email: "somebody-else@test.local",
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [oldUser, newUser] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", result._yay.userId),
			]);

			return {
				oldUser,
				newUser,
			};
		});

		expect(result._yay.userId).not.toBe(deletedUser.userId);
		expect(after.oldUser?.deletedAt).toBe(30_001);
		expect(after.oldUser?.clerkUserId).toBe("clerk-user-delete-return-non-match");
		expect(after.newUser?.clerkUserId).toBe("clerk-user-delete-return-non-match-again");
		expect(after.newUser?.deletedAt).toBeUndefined();
	});

	test("prefers the deleted account over an anonymous session during reclaim", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-anon",
				displayName: "Returning User",
				email: "returning-user-anon@test.local",
			}),
		);
		const recoveryEmail = "returning-user-anon@test.local";

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_301,
			}),
		);
		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "data_deletion_anonymous_free_product",
				organizationId: "data_deletion_test_org",
				name: billing_PRODUCTS.Free.name,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-anon-again",
				email: recoveryEmail,
				anonymousUserToken: anonymousPayload.token,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [reclaimedUser, anonymousUser] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", anonymousPayload.userId),
			]);

			return {
				reclaimedUser,
				anonymousUser,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.reclaimedUser?.deletedAt).toBeUndefined();
		expect(after.reclaimedUser?.clerkUserId).toBe("clerk-user-delete-return-anon-again");
		expect(after.anonymousUser?._id).toBe(anonymousPayload.userId);
		expect(after.anonymousUser?.clerkUserId).toBeNull();
	});

	test("removes only the user deletion request while leaving resource delete requests intact", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-resource-request",
				displayName: "Returning User",
				email: "returning-user-resource-request@test.local",
			}),
		);
		const recoveryEmail = "returning-user-resource-request@test.local";

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_401,
			}),
		);
		const resourceDeleteProjectRequestId = await t.run(async (ctx) => {
			const workspace = await workspaces_db_create(ctx, {
				userId: deletedUser.userId,
				name: "restore-req-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}

			const project = await workspaces_db_create_project(ctx, {
				userId: deletedUser.userId,
				workspaceId: workspace._yay.workspaceId,
				name: "restore-req-proj",
				description: "",
				now: Date.now(),
			});
			if (project._nay) {
				throw new Error(project._nay.message);
			}

			return await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				workspaceId: workspace._yay.workspaceId,
				projectId: project._yay.projectId,
				scope: "project",
			});
		});

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-resource-request-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [userRequest, resourceDeleteProjectRequest] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("data_deletion_requests", resourceDeleteProjectRequestId),
			]);

			return {
				userRequest,
				resourceDeleteProjectRequest,
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.resourceDeleteProjectRequest?._id).toBe(resourceDeleteProjectRequestId);
	});

	test("purges the stored recovery email after hard delete and falls back to a fresh user later", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-purge",
				displayName: "Returning User",
				email: "returning-user-purge@test.local",
			}),
		);
		const recoveryEmail = "returning-user-purge@test.local";

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);
		await t.run((ctx) =>
			ctx.runMutation(internal.users.purge_deleted_user_tombstone, {
				userId: deletedUser.userId,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-purge-again",
				email: recoveryEmail,
				displayName: "Returning User Again",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [oldUser, newUser, oldAnagraphic] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users", result._yay.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
			]);

			return {
				oldUser,
				newUser,
				oldAnagraphic,
			};
		});

		expect(after.oldUser).toBeNull();
		expect(result._yay.userId).not.toBe(deletedUser.userId);
		expect(after.newUser?.clerkUserId).toBe("clerk-user-delete-return-purge-again");
		expect(after.oldAnagraphic).toBeNull();
	});
});
