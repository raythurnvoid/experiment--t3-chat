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
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
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
			quotaName: "extra_organizations",
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

	await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.defaultOrganizationId || !user.defaultWorkspaceId || !user.anagraphic) {
		throw new Error("Failed to bootstrap user");
	}

	return {
		userId,
		defaultOrganizationId: user.defaultOrganizationId,
		defaultWorkspaceId: user.defaultWorkspaceId,
		anagraphicId: user.anagraphic,
	} as const;
}

async function data_deletion_test_seed_page(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
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
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		kind: "content",
		r2Bucket: "test-bucket",
		r2Key: `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${nodeId}`,
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

async function data_deletion_test_seed_workspace_content_bulk(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		count: number;
		tag: string;
	},
) {
	const r2Keys: string[] = [];
	const apiOrganizationId = ctx.db.normalizeId("organizations", args.organizationId);
	const apiWorkspaceId = ctx.db.normalizeId("organizations_workspaces", args.workspaceId);
	if (!apiOrganizationId || !apiWorkspaceId) {
		throw new Error("Expected real organization and workspace ids for API credential fixtures");
	}

	for (let i = 0; i < args.count; i += 1) {
		const fileNodeId = await ctx.db.insert("files_nodes", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
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
		const contentR2Key = `content/organizations/${args.organizationId}/workspaces/${args.workspaceId}/nodes/${args.tag}-${i}/markdown`;
		const yjsR2Key = `content/organizations/${args.organizationId}/workspaces/${args.workspaceId}/nodes/${args.tag}-${i}/yjs`;
		r2Keys.push(contentR2Key, yjsR2Key);
		const [assetId, yjsAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: contentR2Key,
				size: 12,
				createdBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
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
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				lineCount: 1,
				wordCount: 2,
				charCount: 12,
			}),
			ctx.db.insert("files_yjs_snapshots", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sequence: 1,
				assetId: yjsAssetId,
				createdBy: args.userId,
				updatedBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
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
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId,
			sourceKind: "committed",
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
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sourceKind: "committed",
				yjsSequence: 1,
				markdownChunkId,
				chunkIndex: 0,
				path: `/${args.tag}-${i}.md`,
				plainTextChunk: `${args.tag} ${i}`,
				markdownChunk: `# ${args.tag} ${i}`,
				startIndex: 0,
				endIndex: 12,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
				hasChunkAbove: false,
				hasChunkBelow: false,
			}),
			ctx.db.insert("files_metadata_docs", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sourceKind: "committed",
				yjsSequence: 1,
				path: `/${args.tag}-${i}.md`,
				treePath: `/${args.tag}-${i}.md`,
				qualifiedField: "frontmatter.cleanup",
				docKind: "field",
			}),
			ctx.db.insert("files_metadata_docs", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sourceKind: "committed",
				yjsSequence: 1,
				path: `/${args.tag}-${i}.md`,
				treePath: `/${args.tag}-${i}.md`,
				qualifiedField: "frontmatter.cleanup",
				docKind: "value",
				valueKind: "string",
				stringValue: args.tag,
			}),
			ctx.db.insert("files_yjs_updates", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sequence: 1,
				update: new ArrayBuffer(0),
				origin: { type: "USER_EDIT", sessionId: `${args.tag}-${i}` },
				createdBy: args.userId,
				createdAt: Date.now(),
			}),
			ctx.db.insert("files_snapshots", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				assetId,
				createdBy: args.userId,
				archivedAt: -1,
			}),
		]);
		if (i < 5) {
			const pendingUpdateUpdatedAt = Date.now();
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: new ArrayBuffer(0),
				stagedBranchYjsUpdate: new ArrayBuffer(0),
				unstagedBranchYjsUpdate: new ArrayBuffer(0),
				size: files_get_utf8_byte_size(`# pending ${i}`),
				updatedAt: pendingUpdateUpdatedAt,
			});
			const pendingMarkdownChunkId = await ctx.db.insert("files_markdown_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				sourceKind: "pending",
				userId: args.userId,
				fileNodeId,
				pendingUpdateId,
				chunkIndex: 0,
				markdownChunk: `# pending ${i}`,
				startIndex: 0,
				endIndex: 10,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
			});
			await ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId,
				sourceKind: "pending",
				userId: args.userId,
				pendingUpdateId,
				markdownChunkId: pendingMarkdownChunkId,
				path: `/${args.tag}-${i}.md`,
				chunkIndex: 0,
				plainTextChunk: `pending ${i}`,
				markdownChunk: `# pending ${i}`,
				startIndex: 0,
				endIndex: 10,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
				hasChunkAbove: false,
				hasChunkBelow: false,
			});
			await Promise.all([
				ctx.db.insert("files_metadata_docs", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId,
					sourceKind: "pending",
					userId: args.userId,
					pendingUpdateId,
					path: `/${args.tag}-${i}.md`,
					treePath: `/${args.tag}-${i}.md`,
					qualifiedField: "frontmatter.cleanup",
					docKind: "field",
				}),
				ctx.db.insert("files_metadata_docs", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId,
					sourceKind: "pending",
					userId: args.userId,
					pendingUpdateId,
					path: `/${args.tag}-${i}.md`,
					treePath: `/${args.tag}-${i}.md`,
					qualifiedField: "frontmatter.cleanup",
					docKind: "value",
					valueKind: "string",
					stringValue: `pending-${args.tag}`,
				}),
			]);
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
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNodeId,
			lastSequenceSaved: 1,
			updatedAt: Date.now(),
		});
		const threadId = await ctx.db.insert("ai_chat_threads", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
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
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId,
				bashCwd: "~",
				updatedBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("ai_chat_files", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
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
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: null,
				threadId,
				clientGeneratedMessageId: `${args.tag}-message-${i}`,
				content: {},
				createdBy: args.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("ai_chat_files_content", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId,
				fileNodeId: aiFileNodeId,
				bytes: new ArrayBuffer(0),
			}),
			ctx.db.insert("chat_messages", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: null,
				parentId: null,
				isArchived: false,
				createdBy: args.userId,
				content: `${args.tag} ${i}`,
			}),
			ctx.db.insert("api_credentials", {
				organizationId: apiOrganizationId,
				workspaceId: apiWorkspaceId,
				userId: args.userId,
				name: `${args.tag} API key ${i}`,
				keyId: `pk_${args.tag}_${i}`,
				obfuscatedValue: `pk_${args.tag}_${i}.****test`,
				secretHash: `secret_hash_${args.tag}_${i}`,
				scopes: ["files:list", "files:read"],
				createdAt: Date.now(),
				revokedAt: null,
				lastUsedAt: null,
			}),
			ctx.db.insert("public_api_grants", {
				organizationId: apiOrganizationId,
				workspaceId: apiWorkspaceId,
				userId: args.userId,
				threadId,
				principalKey: `grant_${args.tag}_${i}`,
				tokenHash: `token_hash_${args.tag}_${i}`,
				scopes: ["files:list", "files:read"],
				pathPrefix: null,
				createdAt: Date.now(),
				expiresAt: Date.now() + 10 * 60 * 1000,
			}),
		]);
	}

	return { r2Keys };
}

async function data_deletion_test_count_workspace_content(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: string },
) {
	const [
		files,
		fileStats,
		assets,
		markdownChunks,
		plainTextChunks,
		metadataDocs,
		yjsSnapshots,
		yjsUpdates,
		yjsLastSequences,
		snapshots,
		pendingUpdates,
		pendingUpdateCleanupTasks,
		lastSequenceSaved,
		materializationJobs,
		aiThreads,
		aiStates,
		aiMessages,
		aiFiles,
		aiFileContents,
		apiCredentials,
		publicApiGrants,
		chatMessages,
	] = await Promise.all([
		ctx.db.query("files_nodes").collect(),
		ctx.db.query("file_stats").collect(),
		ctx.db.query("files_r2_assets").collect(),
		ctx.db.query("files_markdown_chunks").collect(),
		ctx.db.query("files_plain_text_chunks").collect(),
		ctx.db.query("files_metadata_docs").collect(),
		ctx.db.query("files_yjs_snapshots").collect(),
		ctx.db.query("files_yjs_updates").collect(),
		ctx.db.query("files_yjs_docs_last_sequences").collect(),
		ctx.db.query("files_snapshots").collect(),
		ctx.db.query("files_pending_updates").collect(),
		ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
		ctx.db.query("files_pending_updates_last_sequence_saved").collect(),
		ctx.db.query("files_content_materialization_jobs").collect(),
		ctx.db.query("ai_chat_threads").collect(),
		ctx.db.query("ai_chat_threads_state").collect(),
		ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
		ctx.db.query("ai_chat_files").collect(),
		ctx.db.query("ai_chat_files_content").collect(),
		ctx.db.query("api_credentials").collect(),
		ctx.db.query("public_api_grants").collect(),
		ctx.db.query("chat_messages").collect(),
	]);
	const inWorkspace = (row: { organizationId: string; workspaceId: string }) =>
		row.organizationId === args.organizationId && row.workspaceId === args.workspaceId;
	const workspacePendingUpdateIds = new Set(pendingUpdates.filter(inWorkspace).map((doc) => doc._id));
	return (
		[
			files,
			fileStats,
			assets,
			markdownChunks,
			plainTextChunks,
			metadataDocs,
			yjsSnapshots,
			yjsUpdates,
			yjsLastSequences,
			snapshots,
			pendingUpdates,
			lastSequenceSaved,
			materializationJobs,
			aiThreads,
			aiStates,
			aiMessages,
			aiFiles,
			aiFileContents,
			apiCredentials,
			publicApiGrants,
			chatMessages,
		].reduce((total, rows) => total + rows.filter(inWorkspace).length, 0) +
		pendingUpdateCleanupTasks.filter((doc) => workspacePendingUpdateIds.has(doc.pendingUpdateId)).length
	);
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

async function data_deletion_test_process_organization_request_until_done(
	t: ReturnType<typeof test_convex>,
	args: { requestId: Id<"data_deletion_requests">; batchSize?: number },
) {
	for (let i = 0; i < 300; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_organization_deletion_request, {
				requestId: args.requestId,
				_test_batchSize: args.batchSize,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("Organization deletion request did not finish");
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
		const [userRequests, organizationRequests, workspaceRequests] = await Promise.all([
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "user",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "organization",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
			ctx.runQuery(internal.data_deletion.list_deletion_request_ids_by_scope, {
				scope: "workspace",
				limit: 1_000,
				_test_now: args?.testNow,
			}),
		]);

		return userRequests.length + organizationRequests.length + workspaceRequests.length;
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
	test("dedupes user, organization, and workspace requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-dedup",
				displayName: "Dedup User",
			}),
		);

		const organization = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: user.userId,
				name: "dedup-space",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		if (organization._nay) {
			throw new Error(organization._nay.message);
		}

		const extraWorkspace = await t.run(async (ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "dedup-extra-ws",
				description: "",
				now: Date.now(),
			}),
		);
		if (extraWorkspace._nay) {
			throw new Error(extraWorkspace._nay.message);
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

			const organizationRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
			});
			const organizationRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
			});

			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
			});
			const workspaceRequestIdAgain = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
			});
			const organizationRequestIdAfterWorkspace = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
			});

			return {
				userRequestId,
				userRequestIdAgain,
				organizationRequestId,
				organizationRequestIdAgain,
				organizationRequestIdAfterWorkspace,
				workspaceRequestId,
				workspaceRequestIdAgain,
				rows: await ctx.db.query("data_deletion_requests").collect(),
			};
		});

		expect(requests.userRequestId).toBe(requests.userRequestIdAgain);
		expect(requests.organizationRequestId).toBe(requests.organizationRequestIdAgain);
		expect(requests.organizationRequestId).toBe(requests.organizationRequestIdAfterWorkspace);
		expect(requests.workspaceRequestId).toBe(requests.workspaceRequestIdAgain);
		expect(requests.rows).toHaveLength(3);
		expect(requests.rows.filter((row) => row.scope === "user")).toHaveLength(1);
		expect(
			requests.rows.filter(
				(row) => row.scope === "organization" && row.organizationId === organization._yay.organizationId,
			),
		).toHaveLength(1);
		expect(
			requests.rows.filter(
				(row) =>
					row.scope === "workspace" &&
					row.organizationId === organization._yay.organizationId &&
					row.workspaceId === extraWorkspace._yay.workspaceId,
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

		const organization = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: user.userId,
				name: "earliest-space",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		if (organization._nay) {
			throw new Error(organization._nay.message);
		}

		const workspace = await t.run(async (ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "earliest-ws",
				description: "",
				now: Date.now(),
			}),
		);
		if (workspace._nay) {
			throw new Error(workspace._nay.message);
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

			const organizationRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
				eligibleAt: 40_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
				eligibleAt: 25_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				scope: "organization",
				eligibleAt: 50_000,
			});

			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 60_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 35_000,
			});
			await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
				eligibleAt: 70_000,
			});

			const [userRequest, organizationRequest, workspaceRequest] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId),
				ctx.db.get("data_deletion_requests", organizationRequestId),
				ctx.db.get("data_deletion_requests", workspaceRequestId),
			]);

			return {
				userRequest,
				organizationRequest,
				workspaceRequest,
			};
		});

		expect(requests.userRequest?.eligibleAt).toBe(10_000);
		expect(requests.organizationRequest?.eligibleAt).toBe(25_000);
		expect(requests.workspaceRequest?.eligibleAt).toBe(35_000);
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

		const sharedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: collaborator.userId,
				name: "phase-one-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				active: true,
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: collaborator.userId,
				organizationId: created._yay.organizationId,
				name: "p1-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				userId: deletedUser.userId,
				active: true,
			});

			return {
				organizationId: created._yay.organizationId,
				defaultWorkspaceId: created._yay.defaultWorkspaceId,
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
			} as const;
		});

		await t.run(async (ctx) => {
			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					tag: "phase-one-personal-page",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: deletedUser.userId,
					organizationId: sharedOrganization.organizationId,
					workspaceId: sharedOrganization.extraWorkspaceId,
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
			sharedOrganization.organizationId,
			sharedOrganization.extraWorkspaceId,
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
				personalOrganization,
				personalWorkspace,
				sharedOrganizationDoc,
				sharedExtraWorkspace,
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
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("organizations", sharedOrganization.organizationId),
				ctx.db.get("organizations_workspaces", sharedOrganization.extraWorkspaceId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === deletedUser.defaultWorkspaceId)),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.workspaceId === sharedOrganization.extraWorkspaceId)),
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
				personalOrganization,
				personalWorkspace,
				sharedOrganizationDoc,
				sharedExtraWorkspace,
				personalPages,
				sharedExtraPages,
				snapshots,
				deletedPresenceRooms,
				collaboratorPresenceRooms,
			};
		});

		expect(after.user?.deletedAt).toBe(10_001);
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-phase-one");
		expect(after.user?.defaultOrganizationId).toBe(deletedUser.defaultOrganizationId);
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
		expect(after.request?._id).toBe(requestId);
		expect(after.requests).toHaveLength(1);
		expect(after.requests[0]?.scope).toBe("user");
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.memberships.every((membership) => membership.active === false)).toBe(true);
		expect(after.personalOrganization?._id).toBe(deletedUser.defaultOrganizationId);
		expect(after.personalWorkspace?._id).toBe(deletedUser.defaultWorkspaceId);
		expect(after.sharedOrganizationDoc?._id).toBe(sharedOrganization.organizationId);
		expect(after.sharedExtraWorkspace?._id).toBe(sharedOrganization.extraWorkspaceId);
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

		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "owned-transfer",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
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
		const transferResult = await ownerClient.mutation(api.access_control.transfer_organization_ownership, {
			organizationId: organization.organizationId,
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
			const [user, ownerRole, organizationDoc, collaboratorQuota, organizationRequests] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_role_user", (q) =>
						q
							.eq("organizationId", organization.organizationId)
							.eq("workspaceId", organization.defaultWorkspaceId)
							.eq("role", "owner"),
					)
					.first(),
				ctx.db.get("organizations", organization.organizationId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", collaborator.userId).eq("quotaName", "extra_organizations"),
					)
					.first(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_scope", (q) =>
						q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
					)
					.collect(),
			]);

			return { user, ownerRole, organizationDoc, collaboratorQuota, organizationRequests };
		});

		expect(after.user?.deletedAt).toBe(42_002);
		expect(after.ownerRole?.userId).toBe(collaborator.userId);
		expect(after.organizationDoc).not.toBeNull();
		expect(after.collaboratorQuota?.usedCount).toBe(1);
		expect(after.organizationRequests).toHaveLength(0);
	});

	test("queues remaining owned organization deletion and removes memberships immediately", async () => {
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

		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "owned-delete",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
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
			const [user, organizationDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota] =
				await Promise.all([
					ctx.db.get("users", owner.userId),
					ctx.db.get("organizations", organization.organizationId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_role_user", (q) =>
							q
								.eq("organizationId", organization.organizationId)
								.eq("workspaceId", organization.defaultWorkspaceId)
								.eq("role", "owner"),
						)
						.collect(),
					ctx.db
						.query("access_control_permission_grants")
						.withIndex("by_organization_workspace_resource_user_permission", (q) =>
							q.eq("organizationId", organization.organizationId),
						)
						.collect(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_organization_workspace_user", (q) =>
							q.eq("active", true).eq("organizationId", organization.organizationId),
						)
						.collect(),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_organization_scope", (q) =>
							q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
						)
						.collect(),
					ctx.db
						.query("quotas")
						.withIndex("by_user_quotaName", (q) => q.eq("userId", owner.userId).eq("quotaName", "extra_organizations"))
						.first(),
				]);

			return { user, organizationDoc, ownerRoles, permissionGrants, memberships, requests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBe(42_003);
		expect(after.organizationDoc).not.toBeNull();
		expect(after.ownerRoles).toHaveLength(0);
		expect(after.permissionGrants).toHaveLength(0);
		expect(after.memberships).toHaveLength(0);
		expect(after.requests).toHaveLength(1);
		expect(after.ownerQuota?.usedCount).toBe(0);
	});
});

describe("process_user_deletion_request", () => {
	test("tombstones the user, preserves shared content, and directly purges empty personal organizations", async () => {
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

		const sharedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-space",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				active: true,
			});

			await ctx.db.insert("files_pending_updates", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				fileNodeId: (
					await data_deletion_test_seed_page(ctx, {
						userId: deletedUser.userId,
						organizationId: created._yay.organizationId,
						workspaceId: created._yay.defaultWorkspaceId,
						tag: "shared-page",
					})
				).nodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: new ArrayBuffer(0),
				stagedBranchYjsUpdate: new ArrayBuffer(0),
				unstagedBranchYjsUpdate: new ArrayBuffer(0),
				size: 0,
				updatedAt: Date.now(),
			});

			await ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				fileNodeId: await ctx.db
					.query("files_nodes")
					.collect()
					.then((pages) => {
						const page = pages.find(
							(page) =>
								page.organizationId === created._yay.organizationId &&
								page.workspaceId === created._yay.defaultWorkspaceId &&
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
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
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
				personalOrganization,
				personalWorkspace,
				sharedOrganizationDoc,
				sharedPages,
				personalPages,
				snapshots,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_user_role_organization_workspace", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_user_organization_workspace_resource_permission", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_fileNode", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("files_pending_updates_last_sequence_saved")
					.withIndex("by_user_fileNode", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.get("organizations", sharedOrganization.organizationId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((pages) =>
						pages.filter(
							(page) =>
								page.organizationId === sharedOrganization.organizationId &&
								page.workspaceId === sharedOrganization.defaultWorkspaceId &&
								page.kind === "file" &&
								page.name === "shared-page",
						),
					),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.organizationId === deletedUser.defaultOrganizationId)),
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
				personalOrganization,
				personalWorkspace,
				sharedOrganizationDoc,
				sharedPages,
				personalPages,
				snapshots,
			};
		});

		expect(afterUserDeletion.user?.deletedAt).toBe(10_001);
		expect(afterUserDeletion.user?.clerkUserId).toBe("clerk-user-delete-main");
		expect(afterUserDeletion.user?.defaultOrganizationId).toBeUndefined();
		expect(afterUserDeletion.user?.defaultWorkspaceId).toBeUndefined();
		expect(afterUserDeletion.anagraphic?.displayName).toBe("Deleted User");
		expect(afterUserDeletion.memberships).toHaveLength(0);
		expect(afterUserDeletion.roleAssignments).toHaveLength(0);
		expect(afterUserDeletion.permissionGrants).toHaveLength(0);
		expect(afterUserDeletion.pendingUpdates).toHaveLength(0);
		expect(afterUserDeletion.pendingUpdateSaves).toHaveLength(0);
		expect(afterUserDeletion.cleanupTasks).toHaveLength(0);
		expect(afterUserDeletion.personalOrganization).toBeNull();
		expect(afterUserDeletion.personalWorkspace).toBeNull();
		expect(afterUserDeletion.personalPages).toHaveLength(0);
		expect(afterUserDeletion.sharedOrganizationDoc?._id).toBe(sharedOrganization.organizationId);
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

	test("keeps shared orphaned workspaces after retention when the organization still has active users", async () => {
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

		const sharedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-orphan-space",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				active: true,
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: deletedUser.userId,
				organizationId: created._yay.organizationId,
				name: "shared-orphan-extra",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			return {
				organizationId: created._yay.organizationId,
				defaultWorkspaceId: created._yay.defaultWorkspaceId,
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
			} as const;
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				organizationId: sharedOrganization.organizationId,
				workspaceId: sharedOrganization.extraWorkspaceId,
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
			const [user, sharedOrganizationDoc, sharedDefaultWorkspace, sharedExtraWorkspace, sharedExtraPages, memberships] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.get("organizations", sharedOrganization.organizationId),
					ctx.db.get("organizations_workspaces", sharedOrganization.defaultWorkspaceId),
					ctx.db.get("organizations_workspaces", sharedOrganization.extraWorkspaceId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === sharedOrganization.extraWorkspaceId)),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", deletedUser.userId))
						.collect(),
				]);

			return {
				user,
				sharedOrganizationDoc,
				sharedDefaultWorkspace,
				sharedExtraWorkspace,
				sharedExtraPages,
				memberships,
			};
		});

		expect(after.user?.deletedAt).toBe(20_001);
		expect(after.user?.defaultOrganizationId).toBeUndefined();
		expect(after.sharedOrganizationDoc?._id).toBe(sharedOrganization.organizationId);
		expect(after.sharedDefaultWorkspace?._id).toBe(sharedOrganization.defaultWorkspaceId);
		expect(after.sharedExtraWorkspace?._id).toBe(sharedOrganization.extraWorkspaceId);
		expect(after.sharedExtraPages).toHaveLength(1);
		expect(after.memberships).toHaveLength(0);
	});
});

describe("process_workspace_deletion_request", () => {
	test("removes invalid workspace requests without a workspace id", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-invalid-request",
				displayName: "Workspace Invalid Request",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
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

	test("purges workspace content in retryable batches without touching sibling workspaces", async () => {
		const t = test_convex();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject");
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-batch",
				displayName: "Workspace Batch",
			}),
		);

		const { victimWorkspaceId, controlWorkspaceId, requestId, r2Keys } = await t.run(async (ctx) => {
			const victimWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "batch-victim",
				description: "",
				now: Date.now(),
			});
			if (victimWorkspace._nay) {
				throw new Error(victimWorkspace._nay.message);
			}
			const controlWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "batch-control",
				description: "",
				now: Date.now(),
			});
			if (controlWorkspace._nay) {
				throw new Error(controlWorkspace._nay.message);
			}

			const seeded = await data_deletion_test_seed_workspace_content_bulk(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: victimWorkspace._yay.workspaceId,
				count: 20,
				tag: "ws-batch-victim",
			});
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: controlWorkspace._yay.workspaceId,
				tag: "ws-batch-control",
			});

			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: victimWorkspace._yay.workspaceId,
				scope: "workspace",
			});
			return {
				victimWorkspaceId: victimWorkspace._yay.workspaceId,
				controlWorkspaceId: controlWorkspace._yay.workspaceId,
				requestId,
				r2Keys: seeded.r2Keys,
			};
		});

		const beforeCount = await t.run((ctx) =>
			data_deletion_test_count_workspace_content(ctx, {
				organizationId: user.defaultOrganizationId,
				workspaceId: victimWorkspaceId,
			}),
		);
		const firstResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 5,
			}),
		);
		const afterFirst = await t.run(async (ctx) => {
			const [request, victimCount, controlCount] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: victimWorkspaceId,
				}),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: controlWorkspaceId,
				}),
			]);

			return { request, victimCount, controlCount };
		});

		expect(firstResult.done).toBe(false);
		expect(afterFirst.request?._id).toBe(requestId);
		expect(afterFirst.victimCount).toBeGreaterThan(0);
		expect(afterFirst.victimCount).toBeLessThan(beforeCount);
		expect(afterFirst.controlCount).toBeGreaterThan(0);

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId,
			batchSize: 5,
		});

		const afterDone = await t.run(async (ctx) => {
			const [request, victimCount, controlCount] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: victimWorkspaceId,
				}),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: controlWorkspaceId,
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

	test("purges plugin installations, secrets, upload event routes, runs, and call docs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-plugin-purge",
				displayName: "Workspace Plugin Purge",
			}),
		);

		const { requestId } = await t.run(async (ctx) => {
			const now = Date.now();
			const sourceAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/plugin-source",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			const sourceFileNodeId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				path: "/plugin-source.png",
				treePath: "/plugin-source.png",
				pathDepth: 1,
				name: "plugin-source.png",
				kind: "file",
				lowercaseExtension: "png",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "image/png",
				assetId: sourceAssetId,
			});
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "media",
				displayName: "Media",
				version: "0.1.0",
				description: "Media plugin",
				reviewStatus: "pending",
				runtimeVersion: "1",
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/sybill-ai-engineering/media-plugin",
				sourceOwner: "sybill-ai-engineering",
				sourceRepo: "media-plugin",
				sourceDefaultBranch: "main",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				artifactR2Key: "plugins/media/artifact.json",
				backend: {
					entry: "dist/backend/worker.js",
					moduleName: "plugin.js",
					r2Key: "plugins/media/backend/worker.js",
					compatibilityDate: "2026-07-01",
					compatibilityFlags: ["nodejs_compat"],
				},
				events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
				pages: [],
				capabilities: ["uploads.source.read", "files.markdown.write", "plugin.secrets.read"],
				outboundOrigins: [],
				files: [],
				sourceMountName: null,
				createdBy: user.userId,
				createdAt: now,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "media",
				status: "enabled",
				acceptedCapabilities: ["uploads.source.read", "files.markdown.write", "plugin.secrets.read"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: user.userId,
				updatedBy: user.userId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_workspace_installation_secrets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				name: "OPENAI_API_KEY",
				ciphertext: "ciphertext",
				nonce: "nonce",
				keyVersion: 1,
				valuePreview: "sk-...cret",
				createdBy: user.userId,
				updatedBy: user.userId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_workspace_event_handlers", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginVersionId,
				pluginName: "media",
				event: "files.upload.completed",
				contentType: "image/png",
				status: "enabled",
				installationCreatedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			const runId = await ctx.db.insert("plugins_event_runs", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				sourceAssetId,
				sourceFileNodeId,
				actorUserId: user.userId,
				installationId,
				pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:purge-test",
				status: "succeeded",
				acceptedCapabilities: ["uploads.source.read", "files.markdown.write", "plugin.secrets.read"],
				expiresAt: now + 30 * 60 * 1000,
				hostCallCount: 1,
				hostWriteCount: 1,
				errorMessage: null,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_event_run_calls", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				runId,
				installationId,
				pluginVersionId,
				sequence: 1,
				operation: "writeMarkdown",
				status: "succeeded",
				outputPath: "plugin-source.png.description.md",
				outputOverwrite: "replace",
				markdownBytes: 12,
				errorMessage: null,
				startedAt: now,
				finishedAt: now,
				elapsedMs: 0,
				createdAt: now,
				updatedAt: now,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return { requestId };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId,
			batchSize: 2,
		});

		const remaining = await t.run(async (ctx) => {
			const [calls, runs, eventHandlers, secrets, installations] = await Promise.all([
				ctx.db.query("plugins_event_run_calls").collect(),
				ctx.db.query("plugins_event_runs").collect(),
				ctx.db.query("plugins_workspace_event_handlers").collect(),
				ctx.db.query("plugins_workspace_installation_secrets").collect(),
				ctx.db.query("plugins_workspace_installations").collect(),
			]);
			const inWorkspace = (doc: { organizationId: string; workspaceId: string }) =>
				doc.organizationId === user.defaultOrganizationId && doc.workspaceId === user.defaultWorkspaceId;
			return [calls, runs, eventHandlers, secrets, installations].reduce(
				(total, docs) => total + docs.filter(inWorkspace).length,
				0,
			);
		});

		expect(remaining).toBe(0);
	});

	test("leaves R2 asset rows retryable when object deletion fails", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-r2-failure",
				displayName: "Workspace R2 Failure",
			}),
		);

		const { requestId, assetId } = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/r2-failure",
				size: 1,
				createdBy: user.userId,
				updatedAt: Date.now(),
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return {
				requestId,
				assetId,
			};
		});

		vi.spyOn(R2.prototype, "deleteObject").mockRejectedValue(new Error("R2 unavailable"));

		await expect(
			t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
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
				clerkUserId: "clerk-user-ws-materialization-job",
				displayName: "Workspace Materialization Job",
			}),
		);
		const jobId = "work_workspace_materialization_delete" as WorkId;

		const { requestId, jobDocId, fileNodeId } = await t.run(async (ctx) => {
			const fileNodeId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
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
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				fileNodeId,
				jobId,
				targetSequence: 1,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});

			return { requestId, jobDocId, fileNodeId };
		});

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
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

describe("process_organization_deletion_request", () => {
	test("removes invalid organization requests without an organization id", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-organization-invalid-request",
				displayName: "Organization Invalid Request",
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				scope: "organization",
				eligibleAt: 0,
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_organization_deletion_request, {
				requestId,
			}),
		);
		const after = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));

		expect(result).toEqual({ done: true, deletedCount: 1 });
		expect(after).toBeNull();
	});

	test("purges the whole organization and clears matching queued workspace requests", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-organization-request",
				displayName: "Delete Organization Request",
			}),
		);

		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "organization-request",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		const extraWorkspace = await t.run(async (ctx) => {
			const created = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization.organizationId,
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
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				tag: "organization-request-default-page",
			});
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: organization.organizationId,
				workspaceId: extraWorkspace.workspaceId,
				tag: "organization-request-extra-page",
			});
		});

		const { organizationRequestId, workspaceRequestId } = await t.run(async (ctx) => {
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization.organizationId,
				workspaceId: extraWorkspace.workspaceId,
				scope: "workspace",
			});
			const organizationRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization.organizationId,
				scope: "organization",
			});
			return {
				organizationRequestId,
				workspaceRequestId,
			};
		});

		await data_deletion_test_process_organization_request_until_done(t, {
			requestId: organizationRequestId,
		});

		const after = await t.run(async (ctx) => {
			const [
				organizationDoc,
				defaultWorkspaceDoc,
				extraWorkspaceDoc,
				organizationRequest,
				workspaceRequest,
				files,
				fileAssets,
				organizationQuotaDocs,
			] = await Promise.all([
				ctx.db.get("organizations", organization.organizationId),
				ctx.db.get("organizations_workspaces", organization.defaultWorkspaceId),
				ctx.db.get("organizations_workspaces", extraWorkspace.workspaceId),
				ctx.db.get("data_deletion_requests", organizationRequestId),
				ctx.db.get("data_deletion_requests", workspaceRequestId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.organizationId === organization.organizationId)),
				ctx.db
					.query("files_r2_assets")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", organization.organizationId).eq("workspaceId", organization.defaultWorkspaceId),
					)
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", organization.organizationId))
					.collect(),
			]);

			return {
				organizationDoc,
				defaultWorkspaceDoc,
				extraWorkspaceDoc,
				organizationRequest,
				workspaceRequest,
				files,
				fileAssets,
				organizationQuotaDocs,
			};
		});

		expect(after.organizationDoc).toBeNull();
		expect(after.defaultWorkspaceDoc).toBeNull();
		expect(after.extraWorkspaceDoc).toBeNull();
		expect(after.organizationRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.files).toHaveLength(0);
		expect(after.fileAssets).toHaveLength(0);
		expect(after.organizationQuotaDocs).toHaveLength(0);
	});

	test("purges queued workspace content even when the workspace doc was already removed", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-organization-missing-ws",
				displayName: "Organization Missing Workspace",
			}),
		);

		const { organizationId, defaultWorkspaceId, removedWorkspaceId, organizationRequestId, workspaceRequestId } =
			await t.run(async (ctx) => {
				const organization = await organizations_db_create(ctx, {
					userId: user.userId,
					name: "ws-missing-ws",
					description: "",
					now: Date.now(),
					default: false,
				});
				if (organization._nay) {
					throw new Error(organization._nay.message);
				}
				const removedWorkspace = await organizations_db_create_workspace(ctx, {
					userId: user.userId,
					organizationId: organization._yay.organizationId,
					name: "removed-ws",
					description: "",
					now: Date.now(),
				});
				if (removedWorkspace._nay) {
					throw new Error(removedWorkspace._nay.message);
				}

				await Promise.all([
					data_deletion_test_seed_workspace_content_bulk(ctx, {
						userId: user.userId,
						organizationId: organization._yay.organizationId,
						workspaceId: organization._yay.defaultWorkspaceId,
						count: 8,
						tag: "organization-default-batch",
					}),
					data_deletion_test_seed_workspace_content_bulk(ctx, {
						userId: user.userId,
						organizationId: organization._yay.organizationId,
						workspaceId: removedWorkspace._yay.workspaceId,
						count: 20,
						tag: "organization-removed-batch",
					}),
				]);

				const workspaceRequestId = await data_deletion_db_request(ctx, {
					userId: user.userId,
					organizationId: organization._yay.organizationId,
					workspaceId: removedWorkspace._yay.workspaceId,
					scope: "workspace",
				});
				await ctx.db.delete("organizations_workspaces", removedWorkspace._yay.workspaceId);
				const organizationRequestId = await data_deletion_db_request(ctx, {
					userId: user.userId,
					organizationId: organization._yay.organizationId,
					scope: "organization",
				});
				return {
					organizationId: organization._yay.organizationId,
					defaultWorkspaceId: organization._yay.defaultWorkspaceId,
					removedWorkspaceId: removedWorkspace._yay.workspaceId,
					organizationRequestId,
					workspaceRequestId,
				};
			});

		await data_deletion_test_process_organization_request_until_done(t, {
			requestId: organizationRequestId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [
				organization,
				defaultWorkspace,
				organizationRequest,
				workspaceRequest,
				defaultContent,
				removedContent,
				quotaDocs,
			] = await Promise.all([
				ctx.db.get("organizations", organizationId),
				ctx.db.get("organizations_workspaces", defaultWorkspaceId),
				ctx.db.get("data_deletion_requests", organizationRequestId),
				ctx.db.get("data_deletion_requests", workspaceRequestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: organizationId,
					workspaceId: defaultWorkspaceId,
				}),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: organizationId,
					workspaceId: removedWorkspaceId,
				}),
				ctx.db
					.query("quotas")
					.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", organizationId))
					.collect(),
			]);

			return {
				organization,
				defaultWorkspace,
				organizationRequest,
				workspaceRequest,
				defaultContent,
				removedContent,
				quotaDocs,
			};
		});

		expect(after.organization).toBeNull();
		expect(after.defaultWorkspace).toBeNull();
		expect(after.organizationRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
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
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				tag: "reset-default-page",
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "reset-personal-extra",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				tag: "reset-personal-extra-page",
			});

			const ownedOrganization = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "reset-owned-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (ownedOrganization._nay) {
				throw new Error(ownedOrganization._nay.message);
			}
			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: ownedOrganization._yay.organizationId,
				workspaceId: ownedOrganization._yay.defaultWorkspaceId,
				tag: "reset-owned-organization-page",
			});

			const userRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
			});
			const defaultOrganizationRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				scope: "organization",
			});
			const defaultWorkspaceRequestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			const unrelatedRequestId = await data_deletion_db_request(ctx, {
				userId: unrelatedUser.userId,
				organizationId: unrelatedUser.defaultOrganizationId,
				workspaceId: unrelatedUser.defaultWorkspaceId,
				scope: "workspace",
			});

			return {
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
				ownedOrganizationId: ownedOrganization._yay.organizationId,
				ownedDefaultWorkspaceId: ownedOrganization._yay.defaultWorkspaceId,
				userRequestId,
				defaultOrganizationRequestId,
				defaultWorkspaceRequestId,
				unrelatedRequestId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
		});

		const after = await t.run(async (ctx) => {
			const [
				userDoc,
				defaultOrganization,
				defaultWorkspace,
				defaultMembership,
				defaultOwnerRole,
				defaultOrganizationGrants,
				defaultWorkspaceFiles,
				extraWorkspace,
				ownedOrganization,
				ownedDefaultWorkspace,
				personalWorkspaceQuota,
				userOrganizationQuota,
				userRequest,
				defaultOrganizationRequest,
				defaultWorkspaceRequest,
				resetUserRequests,
				unrelatedRequest,
			] = await Promise.all([
				ctx.db.get("users", user.userId),
				ctx.db.get("organizations", user.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", user.userId)
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user_role", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("userId", user.userId)
							.eq("role", "owner"),
					)
					.first(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_role_permission", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("resourceKind", "organization")
							.eq("resourceId", user.defaultOrganizationId)
							.eq("principalKind", "role"),
					)
					.collect(),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) =>
						rows.filter(
							(row) => row.organizationId === user.defaultOrganizationId && row.workspaceId === user.defaultWorkspaceId,
						),
					),
				ctx.db.get("organizations_workspaces", seeded.extraWorkspaceId),
				ctx.db.get("organizations", seeded.ownedOrganizationId),
				ctx.db.get("organizations_workspaces", seeded.ownedDefaultWorkspaceId),
				ctx.db
					.query("quotas")
					.withIndex("by_organization_quotaName", (q) =>
						q.eq("organizationId", user.defaultOrganizationId).eq("quotaName", "extra_workspaces"),
					)
					.first(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", user.userId).eq("quotaName", "extra_organizations"))
					.first(),
				ctx.db.get("data_deletion_requests", seeded.userRequestId),
				ctx.db.get("data_deletion_requests", seeded.defaultOrganizationRequestId),
				ctx.db.get("data_deletion_requests", seeded.defaultWorkspaceRequestId),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_user", (q) => q.eq("userId", user.userId))
					.collect(),
				ctx.db.get("data_deletion_requests", seeded.unrelatedRequestId),
			]);

			return {
				userDoc,
				defaultOrganization,
				defaultWorkspace,
				defaultMembership,
				defaultOwnerRole,
				defaultOrganizationGrants,
				defaultWorkspaceFiles,
				extraWorkspace,
				ownedOrganization,
				ownedDefaultWorkspace,
				personalWorkspaceQuota,
				userOrganizationQuota,
				userRequest,
				defaultOrganizationRequest,
				defaultWorkspaceRequest,
				resetUserRequests,
				unrelatedRequest,
			};
		});

		expect(after.userDoc?.deletedAt).toBeUndefined();
		expect(after.userDoc?.clerkUserId).toBe("clerk-user-reset-live");
		expect(after.userDoc?.defaultOrganizationId).toBe(user.defaultOrganizationId);
		expect(after.userDoc?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(after.defaultOrganization?._id).toBe(user.defaultOrganizationId);
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
		expect(after.defaultMembership?._id).toBeDefined();
		expect(after.defaultOwnerRole?._id).toBeDefined();
		expect(after.defaultOrganizationGrants.length).toBeGreaterThan(0);
		expect(after.defaultWorkspaceFiles).toHaveLength(0);
		expect(after.extraWorkspace).toBeNull();
		expect(after.ownedOrganization).toBeNull();
		expect(after.ownedDefaultWorkspace).toBeNull();
		expect(after.personalWorkspaceQuota?.usedCount).toBe(0);
		expect(after.userOrganizationQuota?.usedCount).toBe(0);
		expect(after.userRequest).toBeNull();
		expect(after.defaultOrganizationRequest).toBeNull();
		expect(after.defaultWorkspaceRequest).toBeNull();
		expect(after.resetUserRequests).toHaveLength(0);
		expect(after.unrelatedRequest?._id).toBe(seeded.unrelatedRequestId);
	});

	test("admin data reset batches content while preserving auth, profile, billing, and default organization/workspace docs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-action-batch",
				displayName: "Reset Action Batch",
				email: "reset-action-batch@test.local",
			}),
		);

		const { extraWorkspaceId, anonymousTokenId, billingSnapshotId } = await t.run(async (ctx) => {
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
			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "reset-action-extra",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			await Promise.all([
				data_deletion_test_seed_workspace_content_bulk(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					count: 20,
					tag: "reset-action-default",
				}),
				data_deletion_test_seed_workspace_content_bulk(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: extraWorkspace._yay.workspaceId,
					count: 20,
					tag: "reset-action-extra",
				}),
			]);

			return {
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
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
				defaultOrganization,
				defaultWorkspace,
				extraWorkspace,
				defaultMembership,
				ownerRole,
				defaultContent,
				extraContent,
			] = await Promise.all([
				ctx.db.get("users", user.userId),
				ctx.db.get("users_anagraphics", user.anagraphicId),
				ctx.db.get("users_anon_tokens", anonymousTokenId),
				ctx.db.get("billing_usage_snapshots", billingSnapshotId),
				ctx.db.get("organizations", user.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
				ctx.db.get("organizations_workspaces", extraWorkspaceId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", user.userId)
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user_role", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("userId", user.userId)
							.eq("role", "owner"),
					)
					.first(),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
				}),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: extraWorkspaceId,
				}),
			]);

			return {
				userDoc,
				anagraphic,
				anonymousToken,
				billingSnapshot,
				defaultOrganization,
				defaultWorkspace,
				extraWorkspace,
				defaultMembership,
				ownerRole,
				defaultContent,
				extraContent,
			};
		});

		expect(after.userDoc?.clerkUserId).toBe("clerk-user-reset-action-batch");
		expect(after.userDoc?.anonymousAuthToken).toBe(anonymousTokenId);
		expect(after.userDoc?.defaultOrganizationId).toBe(user.defaultOrganizationId);
		expect(after.userDoc?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(after.anagraphic?.displayName).toBe("Reset Action Batch");
		expect(after.anonymousToken?.token).toBe("reset-action-token");
		expect(after.billingSnapshot?.polarCustomerId).toBe("cust_reset_action_batch");
		expect(after.defaultOrganization?._id).toBe(user.defaultOrganizationId);
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
		expect(after.defaultMembership?._id).toBeDefined();
		expect(after.ownerRole?._id).toBeDefined();
		expect(after.extraWorkspace).toBeNull();
		expect(after.defaultContent).toBe(0);
		expect(after.extraContent).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("purges queued personal workspace content after the workspace doc was already deleted", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-deleted-ws-request",
				displayName: "Reset Deleted Workspace Request",
			}),
		);

		const { removedWorkspaceId, requestId } = await t.run(async (ctx) => {
			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "reset-del-ws",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			await data_deletion_test_seed_workspace_content_bulk(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				count: 3,
				tag: "reset-deleted-ws",
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
			});

			await ctx.db.delete("organizations_workspaces", extraWorkspace._yay.workspaceId);

			return {
				removedWorkspaceId: extraWorkspace._yay.workspaceId,
				requestId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [request, contentCount, defaultOrganization, defaultWorkspace] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: removedWorkspaceId,
				}),
				ctx.db.get("organizations", user.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
			]);

			return {
				request,
				contentCount,
				defaultOrganization,
				defaultWorkspace,
			};
		});

		expect(after.request).toBeNull();
		expect(after.contentCount).toBe(0);
		expect(after.defaultOrganization?._id).toBe(user.defaultOrganizationId);
		expect(after.defaultWorkspace?._id).toBe(user.defaultWorkspaceId);
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
					defaultOrganizationId: undefined,
					defaultWorkspaceId: undefined,
					membershipFound: false,
					userId: user.userId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("throws when the cached default workspace is not the organization default workspace", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-wrong-default-ws",
				displayName: "Reset Wrong Default Workspace",
			}),
		);
		const extraWorkspace = await t.run(async (ctx) => {
			const result = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "wrong-default",
				description: "",
				now: Date.now(),
			});
			if (result._nay) {
				throw new Error(result._nay.message);
			}
			await ctx.db.patch("users", user.userId, {
				defaultWorkspaceId: result._yay.workspaceId,
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
					defaultOrganizationId: user.defaultOrganizationId,
					defaultWorkspaceId: extraWorkspace.workspaceId,
					workspaceDefault: false,
					organizationDefaultWorkspaceId: user.defaultWorkspaceId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("preserves shared organizations and only deletes reset-user-only extra workspaces", async () => {
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
			const organization = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "reset-share-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (organization._nay) {
				throw new Error(organization._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization._yay.organizationId,
				workspaceId: organization._yay.defaultWorkspaceId,
				userId: collaborator.userId,
				active: true,
				updatedAt: Date.now(),
			});

			const soloWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "reset-solo-ws",
				description: "",
				now: Date.now(),
			});
			if (soloWorkspace._nay) {
				throw new Error(soloWorkspace._nay.message);
			}

			const sharedWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "reset-share-ws",
				description: "",
				now: Date.now(),
			});
			if (sharedWorkspace._nay) {
				throw new Error(sharedWorkspace._nay.message);
			}
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization._yay.organizationId,
				workspaceId: sharedWorkspace._yay.workspaceId,
				userId: collaborator.userId,
				active: true,
				updatedAt: Date.now(),
			});

			await Promise.all([
				data_deletion_test_seed_page(ctx, {
					userId: user.userId,
					organizationId: organization._yay.organizationId,
					workspaceId: soloWorkspace._yay.workspaceId,
					tag: "reset-solo-ws-page",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: user.userId,
					organizationId: organization._yay.organizationId,
					workspaceId: sharedWorkspace._yay.workspaceId,
					tag: "reset-share-ws-page",
				}),
			]);

			return {
				organizationId: organization._yay.organizationId,
				defaultWorkspaceId: organization._yay.defaultWorkspaceId,
				soloWorkspaceId: soloWorkspace._yay.workspaceId,
				sharedWorkspaceId: sharedWorkspace._yay.workspaceId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
		});

		const after = await t.run(async (ctx) => {
			const [organization, defaultWorkspace, soloWorkspace, sharedWorkspace, sharedWorkspaceFiles, workspaceQuota] =
				await Promise.all([
					ctx.db.get("organizations", shared.organizationId),
					ctx.db.get("organizations_workspaces", shared.defaultWorkspaceId),
					ctx.db.get("organizations_workspaces", shared.soloWorkspaceId),
					ctx.db.get("organizations_workspaces", shared.sharedWorkspaceId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === shared.sharedWorkspaceId)),
					ctx.db
						.query("quotas")
						.withIndex("by_organization_quotaName", (q) =>
							q.eq("organizationId", shared.organizationId).eq("quotaName", "extra_workspaces"),
						)
						.first(),
				]);

			return {
				organization,
				defaultWorkspace,
				soloWorkspace,
				sharedWorkspace,
				sharedWorkspaceFiles,
				workspaceQuota,
			};
		});

		expect(after.organization?._id).toBe(shared.organizationId);
		expect(after.defaultWorkspace?._id).toBe(shared.defaultWorkspaceId);
		expect(after.soloWorkspace).toBeNull();
		expect(after.sharedWorkspace?._id).toBe(shared.sharedWorkspaceId);
		expect(after.sharedWorkspaceFiles).toHaveLength(1);
		expect(after.workspaceQuota?.usedCount).toBe(1);
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
		const unrelatedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
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
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				tag: "direct-user-purge-page",
			}),
		);
		const deletedR2Keys = await t.run(async (ctx) => {
			const now = Date.now();
			const markdownR2Key = `content/organizations/${deletedUser.defaultOrganizationId}/workspaces/${deletedUser.defaultWorkspaceId}/nodes/direct-user-purge-page/markdown`;
			const yjsR2Key = `content/organizations/${deletedUser.defaultOrganizationId}/workspaces/${deletedUser.defaultWorkspaceId}/nodes/direct-user-purge-page/yjs-snapshot`;

			await Promise.all([
				ctx.db.insert("files_r2_assets", {
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					kind: "content",
					r2Bucket: "test-bucket",
					r2Key: markdownR2Key,
					size: 1,
					createdBy: deletedUser.userId,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-bucket",
					r2Key: yjsR2Key,
					size: 1,
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
			const organizationRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				scope: "organization",
			});
			const workspaceRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				scope: "workspace",
			});
			const unrelatedWorkspaceRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				organizationId: unrelatedOrganization.organizationId,
				workspaceId: unrelatedOrganization.defaultWorkspaceId,
				scope: "workspace",
			});

			return {
				userRequestId,
				organizationRequestId,
				workspaceRequestId,
				unrelatedWorkspaceRequestId,
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
			const [
				user,
				organization,
				workspace,
				files,
				filesR2Assets,
				userRequest,
				organizationRequest,
				workspaceRequest,
				unrelatedWorkspaceRequest,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.organizationId === deletedUser.defaultOrganizationId)),
				ctx.db
					.query("files_r2_assets")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", deletedUser.defaultOrganizationId).eq("workspaceId", deletedUser.defaultWorkspaceId),
					)
					.collect(),
				ctx.db.get("data_deletion_requests", requestIds.userRequestId),
				ctx.db.get("data_deletion_requests", requestIds.organizationRequestId),
				ctx.db.get("data_deletion_requests", requestIds.workspaceRequestId),
				ctx.db.get("data_deletion_requests", requestIds.unrelatedWorkspaceRequestId),
			]);

			return {
				user,
				organization,
				workspace,
				files,
				filesR2Assets,
				userRequest,
				organizationRequest,
				workspaceRequest,
				unrelatedWorkspaceRequest,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-data-direct");
		expect(after.user?.defaultOrganizationId).toBeUndefined();
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
		expect(after.organization).toBeNull();
		expect(after.workspace).toBeNull();
		expect(after.files).toHaveLength(0);
		expect(after.filesR2Assets).toHaveLength(0);
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), deletedR2Keys[0]);
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), deletedR2Keys[1]);
		deleteObjectSpy.mockRestore();
		expect(after.userRequest).toBeNull();
		expect(after.organizationRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.unrelatedWorkspaceRequest?._id).toBe(requestIds.unrelatedWorkspaceRequestId);
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
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
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
			const [user, request, organization, workspace, files, snapshots] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.organizationId === deletedUser.defaultOrganizationId)),
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
			]);

			return {
				user,
				request,
				organization,
				workspace,
				files,
				snapshots,
			};
		});

		expect(after.user?.deletedAt).toBe(30_001);
		expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-data-initialized");
		expect(after.request).toBeNull();
		expect(after.organization).toBeNull();
		expect(after.workspace).toBeNull();
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

	test("keeps shared orphaned workspaces while deleting the user data directly", async () => {
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

		const sharedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: deletedUser.userId,
				name: "hd-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: collaborator.userId,
				active: true,
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: deletedUser.userId,
				organizationId: created._yay.organizationId,
				name: "hd-shared-extra",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			return {
				organizationId: created._yay.organizationId,
				defaultWorkspaceId: created._yay.defaultWorkspaceId,
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
			};
		});

		await t.run((ctx) =>
			data_deletion_test_seed_page(ctx, {
				userId: deletedUser.userId,
				organizationId: sharedOrganization.organizationId,
				workspaceId: sharedOrganization.extraWorkspaceId,
				tag: "shared-orphan-ws-page",
			}),
		);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);
		await data_deletion_test_run_worker_until_idle(t);

		const after = await t.run(async (ctx) => {
			const [user, requests, sharedOrganizationDoc, sharedDefaultWorkspace, sharedExtraWorkspace, extraWorkspacePages] =
				await Promise.all([
					ctx.db.get("users", deletedUser.userId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("organizations", sharedOrganization.organizationId),
					ctx.db.get("organizations_workspaces", sharedOrganization.defaultWorkspaceId),
					ctx.db.get("organizations_workspaces", sharedOrganization.extraWorkspaceId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.workspaceId === sharedOrganization.extraWorkspaceId)),
				]);

			return {
				user,
				requests,
				sharedOrganizationDoc,
				sharedDefaultWorkspace,
				sharedExtraWorkspace,
				extraWorkspacePages,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.requests).toHaveLength(0);
		expect(after.sharedOrganizationDoc?._id).toBe(sharedOrganization.organizationId);
		expect(after.sharedDefaultWorkspace?._id).toBe(sharedOrganization.defaultWorkspaceId);
		expect(after.sharedExtraWorkspace?._id).toBe(sharedOrganization.extraWorkspaceId);
		expect(after.extraWorkspacePages).toHaveLength(1);
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
	test("runs the pipeline on an eligible workspace deletion request", async () => {
		const t = test_convex();
		const { requestId, test_now } = await t.run(async (ctx) => {
			const user = await data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-pipeline-ws",
				displayName: "Pipeline Workspace",
			});
			const organization = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "pipeline-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (organization._nay) {
				throw new Error(organization._nay.message);
			}
			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "pipeline-ws",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}
			const rid = await ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
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

	test("drains a multi-batch workspace fixture through the action worker", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-worker-batch-drain",
				displayName: "Worker Batch Drain",
			}),
		);

		const { requestId, test_now } = await t.run(async (ctx) => {
			await data_deletion_test_seed_workspace_content_bulk(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				count: 20,
				tag: "worker-batch-drain",
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected workspace deletion request");
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
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
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
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/worker-r2-failure",
				size: 1,
				createdBy: user.userId,
				updatedAt: Date.now(),
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected workspace deletion request");
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
				"Failed to process workspace deletion request",
				expect.objectContaining({
					requestId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("directly consumes an already-queued workspace request during the user phase in the same run", async () => {
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
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				tag: "pipeline-personal-page",
			}),
		);

		const { userRequestId, workspaceRequestId, test_now } = await t.run(async (ctx) => {
			const queuedWorkspaceRequestId = await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				scope: "workspace",
			});
			const queuedWorkspaceRequest = await ctx.db.get("data_deletion_requests", queuedWorkspaceRequestId);
			if (!queuedWorkspaceRequest) {
				throw new Error("Expected queued workspace deletion request");
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
				workspaceRequestId: queuedWorkspaceRequestId,
				test_now: Math.max(row.eligibleAt, queuedWorkspaceRequest.eligibleAt) + 1,
			};
		});

		await t.action(internal.data_deletion.enqueue_deletion_requests_processing, { _test_now: test_now });
		await data_deletion_test_run_worker_until_idle(t, { testNow: test_now });

		const after = await t.run(async (ctx) => {
			const [userRequest, workspaceRequest, requests, organization, workspace, files] = await Promise.all([
				ctx.db.get("data_deletion_requests", userRequestId!),
				ctx.db.get("data_deletion_requests", workspaceRequestId),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
				ctx.db.query("files_nodes").collect(),
			]);

			return {
				userRequest,
				workspaceRequest,
				requests,
				organization,
				workspace,
				files: files.filter((row) => row.organizationId === deletedUser.defaultOrganizationId),
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.requests).toHaveLength(0);
		expect(after.organization).toBeNull();
		expect(after.workspace).toBeNull();
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
					clerkUserId: `clerk-user-quota-organization-${i}`,
				});
				const organizationId = await ctx.db.insert("organizations", {
					name: `quota-organization-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					organizationId,
					scope: "organization",
					eligibleAt: now + RETENTION_MS,
				});
			}

			for (let i = 0; i < 205; i++) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-quota-ws-${i}`,
				});
				const organizationId = await ctx.db.insert("organizations", {
					name: `quota-ws-org-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId,
					name: `quota-ws-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					organizationId,
					workspaceId,
					scope: "workspace",
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
		expect(remaining.filter((row) => row.scope === "organization")).toHaveLength(50);
		expect(remaining.filter((row) => row.scope === "workspace")).toHaveLength(205);
	});

	test("reschedules when ws-only requests use the whole step budget", async () => {
		const t = test_convex();
		const eligibleAt = await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 26; i += 1) {
				const userId = await ctx.db.insert("users", {
					clerkUserId: `clerk-user-ws-only-budget-${i}`,
				});
				const organizationId = await ctx.db.insert("organizations", {
					name: `ws-only-budget-organization-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: userId,
					updatedAt: now,
				});
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId,
					name: `ws-only-budget-ws-${i}`,
					description: "",
					default: false,
					updatedAt: now,
				});
				await ctx.db.insert("data_deletion_requests", {
					userId,
					organizationId,
					workspaceId,
					scope: "workspace",
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
		expect(remaining.filter((row) => row.scope === "workspace")).toHaveLength(1);
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
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
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
					.query("organizations_workspaces_users")
					.collect()
					.then((rows) => rows.filter((row) => row.userId === deletedUser.userId)),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((rows) => rows.filter((row) => row.organizationId === deletedUser.defaultOrganizationId)),
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
		expect(after.user?.defaultOrganizationId).toBe(deletedUser.defaultOrganizationId);
		expect(after.user?.defaultWorkspaceId).toBe(deletedUser.defaultWorkspaceId);
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
						q.eq("userId", deletedUser.userId).eq("quotaName", "extra_organizations"),
					)
					.first(),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
			]);

			const [organization, workspace] =
				user?.defaultOrganizationId && user.defaultWorkspaceId
					? await Promise.all([
							ctx.db.get("organizations", user.defaultOrganizationId),
							ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
						])
					: [null, null];

			return {
				user,
				customer,
				quota,
				anagraphic,
				organization,
				workspace,
			};
		});

		expect(result._yay.userId).toBe(deletedUser.userId);
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBe("clerk-user-delete-return");
		expect(after.user?.defaultOrganizationId).toBeDefined();
		expect(after.user?.defaultOrganizationId).not.toBe(deletedUser.defaultOrganizationId);
		expect(after.user?.defaultWorkspaceId).toBeDefined();
		expect(after.user?.defaultWorkspaceId).not.toBe(deletedUser.defaultWorkspaceId);
		expect(after.organization?._id).toBe(after.user?.defaultOrganizationId);
		expect(after.workspace?._id).toBe(after.user?.defaultWorkspaceId);
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
		const resourceDeleteWorkspaceRequestId = await t.run(async (ctx) => {
			const organization = await organizations_db_create(ctx, {
				userId: deletedUser.userId,
				name: "restore-req-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (organization._nay) {
				throw new Error(organization._nay.message);
			}

			const workspace = await organizations_db_create_workspace(ctx, {
				userId: deletedUser.userId,
				organizationId: organization._yay.organizationId,
				name: "restore-req-ws",
				description: "",
				now: Date.now(),
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}

			return await data_deletion_db_request(ctx, {
				userId: deletedUser.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: workspace._yay.workspaceId,
				scope: "workspace",
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
			const [userRequest, resourceDeleteWorkspaceRequest] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId!),
				ctx.db.get("data_deletion_requests", resourceDeleteWorkspaceRequestId),
			]);

			return {
				userRequest,
				resourceDeleteWorkspaceRequest,
			};
		});

		expect(after.userRequest).toBeNull();
		expect(after.resourceDeleteWorkspaceRequest?._id).toBe(resourceDeleteWorkspaceRequestId);
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

describe("finalize_user_deletion_data plugins publisher", () => {
	test("purges the deleted user's repository claims, publisher secrets, and version review docs", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-publisher",
				displayName: "Hard Delete Publisher",
			}),
		);
		const unrelatedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-publisher-unrelated",
				displayName: "Unrelated Publisher",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const deletedRepositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: deletedUser.userId,
				repositoryUrl: "https://github.com/bonobo/media-plugin",
				owner: "bonobo",
				repo: "media-plugin",
				createdAt: now,
			});
			const deletedSecretId = await ctx.db.insert("plugins_publisher_secrets", {
				ownerUserId: deletedUser.userId,
				repositoryId: deletedRepositoryId,
				name: "OPENAI_API_KEY",
				ciphertext: "ciphertext",
				nonce: "nonce",
				keyVersion: 1,
				valuePreview: "configured",
				allowedOrigins: ["https://api.openai.com"],
				createdAt: now,
				updatedAt: now,
			});
			const deletedReviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: deletedUser.userId,
				artifactHash: `sha256:${"d".repeat(64)}`,
				pluginName: "media",
				version: "0.1.0",
				status: "passed",
				mechanicalFindings: [],
				aiFindings: [],
				model: "none",
				createdAt: now,
			});
			const unrelatedRepositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: unrelatedUser.userId,
				repositoryUrl: "https://github.com/gorilla/pdf-plugin",
				owner: "gorilla",
				repo: "pdf-plugin",
				createdAt: now,
			});
			const unrelatedSecretId = await ctx.db.insert("plugins_publisher_secrets", {
				ownerUserId: unrelatedUser.userId,
				repositoryId: unrelatedRepositoryId,
				name: "MODAL_TOKEN",
				ciphertext: "ciphertext",
				nonce: "nonce",
				keyVersion: 1,
				valuePreview: "configured",
				allowedOrigins: [],
				createdAt: now,
				updatedAt: now,
			});
			const unrelatedReviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: unrelatedUser.userId,
				artifactHash: `sha256:${"e".repeat(64)}`,
				pluginName: "pdf",
				version: "0.1.0",
				status: "passed",
				mechanicalFindings: [],
				aiFindings: [],
				model: "none",
				createdAt: now,
			});

			return {
				deletedRepositoryId,
				deletedSecretId,
				deletedReviewId,
				unrelatedRepositoryId,
				unrelatedSecretId,
				unrelatedReviewId,
			};
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [
				deletedRepository,
				deletedSecret,
				deletedReview,
				deletedUserRepositories,
				unrelatedRepository,
				unrelatedSecret,
				unrelatedReview,
			] = await Promise.all([
				ctx.db.get("plugins_publisher_repositories", seeded.deletedRepositoryId),
				ctx.db.get("plugins_publisher_secrets", seeded.deletedSecretId),
				ctx.db.get("plugins_version_reviews", seeded.deletedReviewId),
				ctx.db
					.query("plugins_publisher_repositories")
					.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db.get("plugins_publisher_repositories", seeded.unrelatedRepositoryId),
				ctx.db.get("plugins_publisher_secrets", seeded.unrelatedSecretId),
				ctx.db.get("plugins_version_reviews", seeded.unrelatedReviewId),
			]);

			return {
				deletedRepository,
				deletedSecret,
				deletedReview,
				deletedUserRepositories,
				unrelatedRepository,
				unrelatedSecret,
				unrelatedReview,
			};
		});

		expect(after.deletedRepository).toBeNull();
		expect(after.deletedSecret).toBeNull();
		expect(after.deletedReview).toBeNull();
		expect(after.deletedUserRepositories).toHaveLength(0);
		expect(after.unrelatedRepository?._id).toBe(seeded.unrelatedRepositoryId);
		expect(after.unrelatedSecret?._id).toBe(seeded.unrelatedSecretId);
		expect(after.unrelatedReview?._id).toBe(seeded.unrelatedReviewId);
	});
});
