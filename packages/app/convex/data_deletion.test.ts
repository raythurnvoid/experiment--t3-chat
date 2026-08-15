import { R2 } from "@convex-dev/r2";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { presence } from "./presence.ts";
import { test_convex, test_mocks_cancel_pending_home_file_seeds } from "./setup.test.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";

const test = baseTest.sequential;
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { files_create_room_id, files_get_utf8_byte_size } from "../shared/files.ts";
import { app_presence_GLOBAL_ROOM_ID } from "../shared/shared-presence-constants.ts";
import { r2_PUT_MAY_ARRIVE_MARGIN_MS, r2_create_asset_key, r2_create_upload_staging_key } from "./r2_client.ts";

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

	await test_mocks_cancel_pending_home_file_seeds(ctx);

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

async function data_deletion_test_seed_plugin_ui_sessions(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		sessionCount: number;
	},
) {
	const now = Date.now();
	const pluginVersionId = await ctx.db.insert("plugins_versions", {
		name: "gallery",
		displayName: "Gallery",
		version: "0.1.0",
		description: "Workspace media gallery",
		reviewStatus: "passed",
		reviewId: null,
		isLatest: true,
		artifactHash: `sha256:${"a".repeat(64)}`,
		sourceRepositoryUrl: "https://github.com/bonobo/gallery-plugin",
		sourceOwner: "bonobo",
		sourceRepo: "gallery-plugin",
		sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: "plugins/gallery/manifest.json",
		backendEntrypointFile: null,
		configuration: null,
		events: [],
		capabilities: ["workspace.files.read"],
		pages: [],
		fileViews: [],
		outboundOrigins: [],
		uiOutboundOrigins: [],
		files: [],
		sourceStatus: "ready",
		sourceLastError: null,
		createdBy: args.userId,
		updatedAt: now,
	});
	const installationId = await ctx.db.insert("plugins_workspace_installations", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		pluginVersionId,
		pluginName: "gallery",
		status: "enabled",
		configurationYaml: null,
		acceptedCapabilities: ["workspace.files.read"],
		capabilitiesAcceptedAt: now,
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		outboundOriginsAcceptedAt: now,
		installedBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
	});
	for (let i = 0; i < args.sessionCount; i += 1) {
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId,
			pluginVersionId,
			userId: args.userId,
			tokenHash: `${i}`.padStart(64, "0"),
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
	}

	return { installationId } as const;
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
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			}),
		]);
		await ctx.db.patch("files_nodes", fileNodeId, {
			assetId,
			statsId,
			yjsSnapshotId,
			yjsLastSequenceId,
			yjsRootKind: "rich_text",
		});
		const textChunkId = await ctx.db.insert("files_text_chunks", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId,
			sourceKind: "committed",
			yjsSequence: 1,
			chunkIndex: 0,
			textChunk: `# ${args.tag} ${i}`,
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
				textChunkId,
				chunkIndex: 0,
				path: `/${args.tag}-${i}.md`,
				plainTextChunk: `${args.tag} ${i}`,
				textChunk: `# ${args.tag} ${i}`,
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
				size: files_get_utf8_byte_size(`# pending ${i}`),
				updatedAt: pendingUpdateUpdatedAt,
			});
			const pendingTextChunkId = await ctx.db.insert("files_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				sourceKind: "pending",
				userId: args.userId,
				fileNodeId,
				pendingUpdateId,
				chunkIndex: 0,
				textChunk: `# pending ${i}`,
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
				textChunkId: pendingTextChunkId,
				path: `/${args.tag}-${i}.md`,
				chunkIndex: 0,
				plainTextChunk: `pending ${i}`,
				textChunk: `# pending ${i}`,
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
				fileNodeId,
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

	const quota = await quotas_db_get(ctx, {
		quotaName: "active_api_credentials",
		userId: args.userId,
		organizationId: apiOrganizationId,
		workspaceId: apiWorkspaceId,
	});
	await ctx.db.patch("quotas", quota._id, {
		usedCount: quota.usedCount + args.count,
		updatedAt: Date.now(),
	});

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
		textChunks,
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
		permissionGrants,
		chatMessages,
	] = await Promise.all([
		ctx.db.query("files_nodes").collect(),
		ctx.db.query("file_stats").collect(),
		ctx.db.query("files_r2_assets").collect(),
		ctx.db.query("files_text_chunks").collect(),
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
		ctx.db.query("access_control_permission_grants").collect(),
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
			textChunks,
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
			permissionGrants,
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
	await t.action(internal.users.hard_delete_user_now, {
		userId: args.userId,
		purgeUserMod: "data",
		_test_batchSize: args.batchSize,
	});
	await data_deletion_test_finish_immediate_scheduled_functions(t);
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
			const [user, organizationDoc, collaboratorQuota, organizationRequests] = await Promise.all([
				ctx.db.get("users", owner.userId),
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

			return { user, organizationDoc, collaboratorQuota, organizationRequests };
		});

		expect(after.user?.deletedAt).toBe(42_002);
		expect(after.organizationDoc?.ownerUserId).toBe(collaborator.userId);
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
			const [user, organizationDoc, roleAssignments, permissionGrants, memberships, requests, ownerQuota] =
				await Promise.all([
					ctx.db.get("users", owner.userId),
					ctx.db.get("organizations", organization.organizationId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_user", (q) =>
							q.eq("organizationId", organization.organizationId).eq("workspaceId", organization.defaultWorkspaceId),
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

			return { user, organizationDoc, roleAssignments, permissionGrants, memberships, requests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBe(42_003);
		expect(after.organizationDoc).not.toBeNull();
		expect(after.roleAssignments).toHaveLength(0);
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

			// A plugin UI session for the deleted user in the shared org: user finalize must delete
			// it through the by_user index while the collaborator's installation itself survives.
			const now = Date.now();
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "gallery",
				displayName: "Gallery",
				version: "0.1.0",
				description: "Workspace media gallery",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/gallery-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "gallery-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/gallery/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				capabilities: ["workspace.files.read"],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: collaborator.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "gallery",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: ["workspace.files.read"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: collaborator.userId,
				updatedBy: collaborator.userId,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_ui_sessions", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				installationId,
				pluginVersionId,
				userId: deletedUser.userId,
				tokenHash: "f".repeat(64),
				createdAt: now,
				expiresAt: now + 30 * 60 * 1000,
			});

			return { ...created._yay, installationId };
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
				uiSessions,
				sharedInstallation,
			] = await Promise.all([
				ctx.db.get("users", deletedUser.userId),
				ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_user_organization_workspace", (q) => q.eq("userId", deletedUser.userId))
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
				ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("plugins_workspace_installations", sharedOrganization.installationId),
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
				uiSessions,
				sharedInstallation,
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
		expect(afterUserDeletion.uiSessions).toHaveLength(0);
		expect(afterUserDeletion.sharedInstallation).not.toBeNull();
	});

	test("drains plugin UI sessions in bounded batches before finalizing the queued user", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-session-drain",
				displayName: "Session Drain",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				sessionCount: 5,
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);
		if (!requestId) {
			throw new Error("Expected a queued user deletion request");
		}
		const test_now = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected the queued user request doc");
			}
			return request.eligibleAt + 1;
		});

		// Two sessions per pass: the request must stay queued (done: false) until all sessions are deleted.
		const passes = [];
		for (let i = 0; i < 3; i += 1) {
			passes.push(
				await t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
						requestId,
						_test_now: test_now,
						_test_batchSize: 2,
					}),
				),
			);
		}
		expect(passes).toEqual([
			{ done: false, deletedCount: 2 },
			{ done: false, deletedCount: 2 },
			{ done: false, deletedCount: 1 },
		]);

		// Finalization has not run while the drain was in progress.
		const beforeFinalize = await t.run((ctx) => ctx.db.get("users", deletedUser.userId));
		expect(beforeFinalize?.defaultOrganizationId).toBeDefined();

		const finalPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: test_now,
				_test_batchSize: 2,
			}),
		);
		expect(finalPass).toEqual({ done: true, deletedCount: 1 });

		const after = await t.run(async (ctx) => {
			const [sessions, request, user] = await Promise.all([
				ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("users", deletedUser.userId),
			]);
			return { sessions, request, user };
		});
		expect(after.sessions).toHaveLength(0);
		expect(after.request).toBeNull();
		expect(after.user?.defaultOrganizationId).toBeUndefined();
	});

	test("drains the deleted user's notifications in bounded batches before finalizing", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-notification-drain",
				displayName: "Notification Drain",
			}),
		);
		const survivingUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-notification-survivor",
				displayName: "Notification Survivor",
			}),
		);

		// Every row lives in the surviving user's organization on purpose. Finalization queues the
		// deleted user's now-empty personal organization for immediate purge, and that purge deletes
		// all notifications in the organization regardless of recipient — rows seeded there would
		// make both assertions pass for the wrong reason.
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 3; i += 1) {
				await ctx.db.insert("notifications", {
					userId: deletedUser.userId,
					kind: "organization_workspace_invite",
					archivedAt: 0,
					actorUserId: survivingUser.userId,
					organizationId: survivingUser.defaultOrganizationId,
					workspaceId: survivingUser.defaultWorkspaceId,
					updatedAt: now,
				});
			}
			// The deleted user only as actor: this row belongs to the surviving user's inbox and stays.
			const actorOnlyId = await ctx.db.insert("notifications", {
				userId: survivingUser.userId,
				kind: "organization_workspace_invite",
				archivedAt: 0,
				actorUserId: deletedUser.userId,
				organizationId: survivingUser.defaultOrganizationId,
				workspaceId: survivingUser.defaultWorkspaceId,
				updatedAt: now,
			});
			return { actorOnlyId };
		});

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 10_001,
			}),
		);
		if (!requestId) {
			throw new Error("Expected a queued user deletion request");
		}
		const test_now = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected the queued user request doc");
			}
			return request.eligibleAt + 1;
		});

		// Two notifications per pass: the request must stay queued (done: false) until all are gone.
		const passes = [];
		for (let i = 0; i < 2; i += 1) {
			passes.push(
				await t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
						requestId,
						_test_now: test_now,
						_test_batchSize: 2,
					}),
				),
			);
		}
		expect(passes).toEqual([
			{ done: false, deletedCount: 2 },
			{ done: false, deletedCount: 1 },
		]);

		const finalPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: test_now,
				_test_batchSize: 2,
			}),
		);
		expect(finalPass).toEqual({ done: true, deletedCount: 1 });

		const after = await t.run(async (ctx) => {
			const [recipientRows, actorOnly, request] = await Promise.all([
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("notifications", seeded.actorOnlyId),
				ctx.db.get("data_deletion_requests", requestId),
			]);
			return { recipientRows, actorOnly, request };
		});
		expect(after.recipientRows).toHaveLength(0);
		expect(after.actorOnly).not.toBeNull();
		expect(after.request).toBeNull();
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

			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				active: true,
			});
			// Creating a workspace needs `workspace.create`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: deletedUser.userId,
				organizationId: created._yay.organizationId,
				name: "shared-orphan-extra",
				description: "",
				now,
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
			const [request, victimCount, controlCount, deletionJobs] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: victimWorkspaceId,
				}),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: controlWorkspaceId,
				}),
				ctx.db.query("files_r2_object_deletion_jobs").collect(),
			]);

			return { request, victimCount, controlCount, deletionJobs };
		});

		expect(afterDone.request).toBeNull();
		expect(afterDone.victimCount).toBe(0);
		expect(afterDone.controlCount).toBeGreaterThan(0);
		for (const r2Key of r2Keys) {
			expect(afterDone.deletionJobs.some((job) => job.r2Key === r2Key)).toBe(true);
		}
	});

	test("purges paged pending-state families and pending-operation scaffolding with the workspace", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-state-family",
				displayName: "Workspace State Family",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const victimWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "state-family-victim",
				description: "",
				now: Date.now(),
			});
			if (victimWorkspace._nay) {
				throw new Error(victimWorkspace._nay.message);
			}
			const workspaceId = victimWorkspace._yay.workspaceId;
			const now = Date.now();

			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				path: "/state-family.md",
				treePath: "/state-family.md",
				pathDepth: 1,
				name: "state-family.md",
				kind: "file",
				lowercaseExtension: "md",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
			});
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				userId: String(user.userId),
				fileNodeId: nodeId,
				size: 0,
				updatedAt: now,
			});

			// One state per ownership variant, each with a page, plus the operation scaffolding.
			const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				createdAt: now,
			});
			const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				userId: String(user.userId),
				fileNodeId: nodeId,
				expiresAt: now + 30 * 60 * 1000,
				lastActivityAt: now,
				updatedAt: now,
			});
			const stateOwners = [
				{ kind: "active", pendingUpdateId, role: "base" },
				{ kind: "temporary", operationBatchId, phase: "input", role: "staged", expiresAt: now + 30 * 60 * 1000 },
				{ kind: "retired", cleanupTaskId },
			] as const;
			for (const owner of stateOwners) {
				const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
					organizationId: user.defaultOrganizationId,
					workspaceId,
					userId: String(user.userId),
					fileNodeId: nodeId,
					owner,
					lineageGeneration: 0,
					sealed: true,
					pageCount: 1,
					totalBytes: 4,
					digest: "purge-digest",
				});
				await ctx.db.insert("files_pending_update_yjs_state_pages", {
					organizationId: user.defaultOrganizationId,
					workspaceId,
					stateId,
					pageIndex: 0,
					bytes: new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer,
				});
			}
			await ctx.db.insert("files_pending_update_text_inputs", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				userId: String(user.userId),
				fileNodeId: nodeId,
				operationBatchId,
				role: "unstaged",
				text: "staged text",
				expiresAt: now + 30 * 60 * 1000,
			});
			await ctx.db.insert("files_yjs_trusted_update_stages", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				userId: user.userId,
				fileNodeId: nodeId,
				kind: "pending_accept",
				update: new Uint8Array([0, 0]).buffer as ArrayBuffer,
				expiresAt: now + 30 * 60 * 1000,
			});

			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId,
				scope: "workspace",
			});
			return { workspaceId, requestId };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: seeded.requestId,
			batchSize: 2,
		});

		const remaining = await t.run(async (ctx) => ({
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			cleanupTasks: await ctx.db.query("files_pending_update_state_cleanup_tasks").collect(),
			batches: await ctx.db.query("files_pending_update_operation_batches").collect(),
			textInputs: await ctx.db.query("files_pending_update_text_inputs").collect(),
			trustedStages: await ctx.db.query("files_yjs_trusted_update_stages").collect(),
			pendingUpdates: await ctx.db.query("files_pending_updates").collect(),
		}));
		expect(remaining.states).toHaveLength(0);
		expect(remaining.pages).toHaveLength(0);
		expect(remaining.cleanupTasks).toHaveLength(0);
		expect(remaining.batches).toHaveLength(0);
		expect(remaining.textInputs).toHaveLength(0);
		expect(remaining.trustedStages).toHaveLength(0);
		expect(remaining.pendingUpdates).toHaveLength(0);
	});

	test("durably deletes live and staging keys for an upload asset without r2Key", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-unfinalized-r2",
				displayName: "Workspace Unfinalized R2",
			}),
		);

		const { assetId, requestId, stagingKey, uploadUrlExpiresAt } = await t.run(async (ctx) => {
			const now = Date.now();
			const uploadUrlExpiresAt = now + 60_000;
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: user.userId,
				unfinalizedExpiresAt: now + 60_000,
				uploadUrlExpiresAt,
				updatedAt: now,
			});
			const stagingKey = r2_create_upload_staging_key({
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
			});
			await ctx.db.patch("files_r2_assets", assetId, { uploadStagingR2Key: stagingKey });
			await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				path: "/unfinished.pdf",
				treePath: "/unfinished.pdf",
				pathDepth: 1,
				name: "unfinished.pdf",
				kind: "file",
				lowercaseExtension: "pdf",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "application/pdf",
				assetId,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});

			return { assetId, requestId, stagingKey, uploadUrlExpiresAt };
		});
		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId,
			batchSize: 5,
		});

		const liveKey = r2_create_asset_key({
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			assetId,
		});
		const jobs = await t.run(
			async (ctx) =>
				await ctx.db
					.query("files_r2_object_deletion_jobs")
					.filter((q) => q.or(q.eq(q.field("r2Key"), liveKey), q.eq(q.field("r2Key"), stagingKey)))
					.collect(),
		);
		expect(jobs).toHaveLength(2);
		expect(jobs.find((job) => job.r2Key === liveKey)).toMatchObject({
			r2Key: liveKey,
			reason: "untracked_asset_event",
		});
		expect(jobs.find((job) => job.r2Key === liveKey)).not.toHaveProperty("putMayArriveUntil");
		expect(jobs.find((job) => job.r2Key === stagingKey)).toMatchObject({
			r2Key: stagingKey,
			reason: "upload_staging",
			putMayArriveUntil: uploadUrlExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toBeNull();
	});

	test("keeps a legacy upload target tombstoned through its signed URL lifetime", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-legacy-upload-r2",
				displayName: "Workspace Legacy Upload R2",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const uploadUrlExpiresAt = now + 60_000;
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: user.userId,
				uploadUrlExpiresAt,
				updatedAt: now,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return { assetId, requestId, uploadUrlExpiresAt };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: seeded.requestId,
			batchSize: 5,
		});

		const liveKey = r2_create_asset_key({
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			assetId: seeded.assetId,
		});
		const job = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", liveKey))
				.unique(),
		);
		expect(job).toMatchObject({
			r2Key: liveKey,
			putMayArriveUntil: seeded.uploadUrlExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		});
	});

	test("purges plugin installations, secrets, upload event routes, runs, call docs, stored data, and activities", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-plugin-purge",
				displayName: "Workspace Plugin Purge",
			}),
		);

		const { requestId, siblingActivityId } = await t.run(async (ctx) => {
			const now = Date.now();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/plugin-source",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			const fileNodeId = await ctx.db.insert("files_nodes", {
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
				assetId,
			});
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "media",
				displayName: "Media",
				version: "0.1.0",
				description: "Media plugin",
				reviewStatus: "pending",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/sybill-ai-engineering/media-plugin",
				sourceOwner: "sybill-ai-engineering",
				sourceRepo: "media-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				backendEntrypointFile: {
					entry: "dist/backend/worker.js",
					moduleName: "plugin.js",
					r2Key: "plugins/media/backend/worker.js",
					sha256: `sha256:${"b".repeat(64)}`,
					compatibilityDate: "2026-07-01",
					compatibilityFlags: ["nodejs_compat"],
				},
				configuration: null,
				events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
				capabilities: ["plugin.secrets.read", "outbound.fetch"],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: user.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "media",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_workspace_installation_secrets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				name: "OPENAI_API_KEY",
				ciphertext: new TextEncoder().encode("ciphertext").buffer,
				nonce: new TextEncoder().encode("nonce").buffer,
				valuePreview: "sk-...cret",
				createdBy: user.userId,
				updatedBy: user.userId,
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
				installationCreatedAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_ui_sessions", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginVersionId,
				userId: user.userId,
				tokenHash: "e".repeat(64),
				createdAt: now,
				expiresAt: now + 30 * 60 * 1000,
			});
			// The plugin's own document store: a stored document, its accounting doc, a live
			// reservation, a delete tombstone, and the service grant that wrote them.
			await ctx.db.insert("plugins_data", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				collection: "meetings",
				key: "meeting-1",
				value: { title: "Weekly sync" },
				byteSize: 24,
				revision: 1,
				writeMode: "normal",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_usage", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				usedBytes: 24,
				reservedBytes: 1000,
				usedDocuments: 1,
				reservedDocuments: 1,
				tombstoneDocuments: 1,
				collectionNames: ["meetings"],
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_reservations", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				collection: "meetings",
				key: "meeting-2",
				ownerPrincipalKey: "plugin_service:purge-test",
				maximumBytes: 1000,
				remainingBytes: 1000,
				state: "live",
				holdsUsageTombstoneSlot: false,
				idempotencyKey: "reserve-1",
				requestFingerprint: "f".repeat(64),
				expiresAt: now + 60_000,
				retryHorizonExpiresAt: now + 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_revision_tombstones", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginName: "media",
				collection: "meetings",
				key: "meeting-3",
				revision: 4,
				producerPrincipalKey: "plugin_service:purge-test",
				deletedAt: now,
				expiresAt: now + 24 * 60 * 60 * 1000,
			});
			await ctx.db.insert("plugin_service_grants", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				installationId,
				pluginVersionId,
				pluginName: "media",
				actorUserId: user.userId,
				tokenHash: "d".repeat(64),
				scopes: ["plugin_data:read", "plugin_data:write"],
				principalKey: "plugin_service:purge-test",
				phase: "interactive",
				destinationPathPrefix: null,
				expiresAt: now + 60 * 60 * 1000,
				updatedAt: now,
			});
			const runId = await ctx.db.insert("plugins_event_runs", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
				fileNodeId,
				actorUserId: user.userId,
				installationId,
				pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:purge-test",
				status: "succeeded",
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				expiresAt: now + 30 * 60 * 1000,
				apiCallCount: 1,
				outputWriteCount: 1,
				errorMessage: null,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_event_run_calls", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				runId,
				installationId,
				pluginVersionId,
				sequence: 1,
				kind: "api_request",
				route: "/api/v1/files/write",
				status: "succeeded",
				responseStatus: 200,
				requestBytes: 12,
				errorMessage: null,
				startedAt: now,
				finishedAt: now,
				elapsedMs: 0,
				updatedAt: now,
			});
			// Activities sourced at the run. The purge deletes the run docs directly, so the
			// run-retention path that normally deletes a run's activity never gets to run here.
			await ctx.db.insert("activities", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				userId: user.userId,
				status: "succeeded",
				source: { type: "plugin_run", id: runId, installationId, pluginName: "media" },
				title: "Media plugin · plugin-source.png",
				errorMessage: null,
				targets: [],
				timeoutAt: now + 60_000,
				finishedAt: now,
				archivedAt: 0,
				updatedAt: now,
			});
			// A sibling-workspace activity must survive: the drain is scoped by the index, not by table.
			const siblingWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "activity-sibling-ws",
				description: "",
				now,
			});
			if (siblingWorkspace._nay) {
				throw new Error(siblingWorkspace._nay.message);
			}
			const siblingActivityId = await ctx.db.insert("activities", {
				organizationId: user.defaultOrganizationId,
				workspaceId: siblingWorkspace._yay.workspaceId,
				userId: user.userId,
				status: "succeeded",
				source: { type: "plugin_run", id: runId, installationId, pluginName: "media" },
				title: "Media plugin · sibling.png",
				errorMessage: null,
				targets: [],
				timeoutAt: now + 60_000,
				finishedAt: now,
				archivedAt: 0,
				updatedAt: now,
			});
			// An unpublished staged write: its asset docs have no r2Key, so only the stage purge
			// block can reach the R2 objects.
			const stagedYjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			const stagedContentSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			await ctx.db.insert("public_api_file_write_stages", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				userId: user.userId,
				runId,
				path: "/plugin-source.png.description.md",
				overwrite: "replace",
				yjsSnapshotAssetId: stagedYjsSnapshotAssetId,
				contentSnapshotAssetId: stagedContentSnapshotAssetId,
				expiresAt: now + 15 * 60 * 1000,
				updatedAt: now,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return { requestId, siblingActivityId };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId,
			batchSize: 2,
		});

		const remaining = await t.run(async (ctx) => {
			const [
				calls,
				runs,
				eventHandlers,
				secrets,
				uiSessions,
				pluginDocuments,
				pluginUsage,
				pluginReservations,
				pluginTombstones,
				serviceGrants,
				installations,
				stages,
				activities,
			] = await Promise.all([
				ctx.db.query("plugins_event_run_calls").collect(),
				ctx.db.query("plugins_event_runs").collect(),
				ctx.db.query("plugins_workspace_event_handlers").collect(),
				ctx.db.query("plugins_workspace_installation_secrets").collect(),
				ctx.db.query("plugins_ui_sessions").collect(),
				ctx.db.query("plugins_data").collect(),
				ctx.db.query("plugins_data_usage").collect(),
				ctx.db.query("plugins_data_reservations").collect(),
				ctx.db.query("plugins_data_revision_tombstones").collect(),
				ctx.db.query("plugin_service_grants").collect(),
				ctx.db.query("plugins_workspace_installations").collect(),
				ctx.db.query("public_api_file_write_stages").collect(),
				ctx.db.query("activities").collect(),
			]);
			const inWorkspace = (doc: { organizationId: string; workspaceId: string }) =>
				doc.organizationId === user.defaultOrganizationId && doc.workspaceId === user.defaultWorkspaceId;
			return [
				calls,
				runs,
				eventHandlers,
				secrets,
				uiSessions,
				pluginDocuments,
				pluginUsage,
				pluginReservations,
				pluginTombstones,
				serviceGrants,
				installations,
				stages,
				activities,
			].reduce((total, docs) => total + docs.filter(inWorkspace).length, 0);
		});

		expect(remaining).toBe(0);
		// The sibling workspace was not purged, so its activity is still there.
		expect(await t.run((ctx) => ctx.db.get("activities", siblingActivityId))).not.toBeNull();
	});

	test("drains plugin UI sessions in bounded batches before deleting their installation", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-session-drain",
				displayName: "Workspace Session Drain",
			}),
		);
		const seeded = await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				sessionCount: 5,
			}),
		);
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			}),
		);

		// Each pass deletes at most one batch of sessions, and the installation is deleted only
		// after the last session, so a crash between passes never leaves sessions without their
		// installation.
		let previousSessionCount = 5;
		for (let i = 0; i < 300; i += 1) {
			const result = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId,
					_test_batchSize: 2,
				}),
			);
			const afterPass = await t.run(async (ctx) => {
				const [sessions, installation] = await Promise.all([
					ctx.db
						.query("plugins_ui_sessions")
						.withIndex("by_installation", (q) => q.eq("installationId", seeded.installationId))
						.collect(),
					ctx.db.get("plugins_workspace_installations", seeded.installationId),
				]);
				return { sessionCount: sessions.length, hasInstallation: installation !== null };
			});
			expect(afterPass.sessionCount).toBeGreaterThanOrEqual(previousSessionCount - 2);
			previousSessionCount = afterPass.sessionCount;
			if (!afterPass.hasInstallation) {
				expect(afterPass.sessionCount).toBe(0);
			}
			if (result.done) {
				expect(afterPass.sessionCount).toBe(0);
				expect(afterPass.hasInstallation).toBe(false);
				return;
			}
		}
		throw new Error("Workspace deletion request did not finish");
	});

	test("hands R2 deletion to the durable job before deleting the asset doc", async () => {
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

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 5,
			}),
		);

		const after = await t.run(async (ctx) => {
			const [request, asset, job] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("files_r2_assets", assetId),
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", "content/r2-failure"))
					.first(),
			]);

			return { request, asset, job };
		});

		expect(after.request?._id).toBe(requestId);
		expect(after.asset).toBeNull();
		expect(after.job).toMatchObject({ reason: "untracked_asset_event", generation: 1 });
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

	test("cancels plugin event run workpool items before deleting their run docs", async () => {
		const t = test_convex();
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-plugin-run-cancel",
				displayName: "Workspace Plugin Run Cancel",
			}),
		);
		const workId = "work_workspace_plugin_run_delete" as WorkId;

		const { requestId, runId } = await t.run(async (ctx) => {
			const now = Date.now();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/plugin-run-cancel",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			const fileNodeId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				path: "/plugin-run-cancel.png",
				treePath: "/plugin-run-cancel.png",
				pathDepth: 1,
				name: "plugin-run-cancel.png",
				kind: "file",
				lowercaseExtension: "png",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "image/png",
				assetId,
			});
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "media",
				displayName: "Media",
				version: "0.1.0",
				description: "Media plugin",
				reviewStatus: "pending",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/sybill-ai-engineering/media-plugin",
				sourceOwner: "sybill-ai-engineering",
				sourceRepo: "media-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				backendEntrypointFile: {
					entry: "dist/backend/worker.js",
					moduleName: "plugin.js",
					r2Key: "plugins/media/backend/worker.js",
					sha256: `sha256:${"b".repeat(64)}`,
					compatibilityDate: "2026-07-01",
					compatibilityFlags: ["nodejs_compat"],
				},
				configuration: null,
				events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
				capabilities: ["plugin.secrets.read", "outbound.fetch"],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: user.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "media",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
			});
			const runId = await ctx.db.insert("plugins_event_runs", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
				fileNodeId,
				actorUserId: user.userId,
				installationId,
				pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:run-cancel-test",
				status: "queued",
				workId,
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				expiresAt: now + 30 * 60 * 1000,
				apiCallCount: 0,
				outputWriteCount: 0,
				errorMessage: null,
				updatedAt: now,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return { requestId, runId };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId,
			batchSize: 5,
		});

		const runAfter = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));

		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), workId);
		expect(runAfter).toBeNull();
	});

	test("purges a locked subtree with its assets", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-read-only-purge",
				displayName: "Workspace Read Only Purge",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const victimWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "read-only-victim",
				description: "",
				now: Date.now(),
			});
			if (victimWorkspace._nay) {
				throw new Error(victimWorkspace._nay.message);
			}
			const workspaceId = victimWorkspace._yay.workspaceId;
			const now = Date.now();

			const folderId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				path: "/locked",
				treePath: "/locked",
				pathDepth: 1,
				name: "locked",
				kind: "folder",
				lowercaseExtension: null,
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", folderId, {
				readOnlyScopeNodeId: folderId,
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "content/read-only-purge-file",
				size: 12,
				createdBy: user.userId,
				updatedAt: now,
			});
			const fileId = await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				path: "/locked/file.md",
				treePath: "/locked/file.md",
				pathDepth: 2,
				name: "file.md",
				kind: "file",
				lowercaseExtension: "md",
				parentId: folderId,
				readOnlyScopeNodeId: folderId,
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "text/markdown;charset=utf-8",
				assetId,
			});

			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId,
				scope: "workspace",
			});
			return { workspaceId, folderId, fileId, assetId, requestId };
		});

		// Workspace deletion owns the full lifecycle, so read-only locks must not stop it.
		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: seeded.requestId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => ({
			folder: await ctx.db.get("files_nodes", seeded.folderId),
			file: await ctx.db.get("files_nodes", seeded.fileId),
			asset: await ctx.db.get("files_r2_assets", seeded.assetId),
		}));
		expect(after.folder).toBeNull();
		expect(after.file).toBeNull();
		expect(after.asset).toBeNull();
	});

	test("keeps an outstanding exact-key deletion job until its processor confirms object absence", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-deletion-job",
				displayName: "Workspace Deletion Job",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const victimWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "deletion-job-victim",
				description: "",
				now: Date.now(),
			});
			if (victimWorkspace._nay) {
				throw new Error(victimWorkspace._nay.message);
			}
			const workspaceId = victimWorkspace._yay.workspaceId;

			await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId,
				tag: "deletion-job-page",
			});

			// Workspace purge must keep this job. Only its processor can remove it after R2 confirms
			// that the object is gone.
			const jobId = await ctx.db.insert("files_r2_object_deletion_jobs", {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				r2Key: `organizations/${user.defaultOrganizationId}/workspaces/${workspaceId}/assets/refused-stage`,
				reason: "read_only_stage",
				generation: 1,
				attempts: 0,
				nextAttemptAt: Date.now() + 60 * 60 * 1000,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId,
				scope: "workspace",
			});
			return { workspaceId, jobId, requestId };
		});

		await data_deletion_test_process_workspace_request_until_done(t, {
			requestId: seeded.requestId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => ({
			content: await data_deletion_test_count_workspace_content(ctx, {
				organizationId: user.defaultOrganizationId,
				workspaceId: seeded.workspaceId,
			}),
			job: await ctx.db.get("files_r2_object_deletion_jobs", seeded.jobId),
		}));
		expect(after.content).toBe(0);
		expect(after.job).not.toBeNull();
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
			const defaultPage = await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				tag: "reset-default-page",
			});
			const now = Date.now();
			const defaultCustomRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: user.defaultOrganizationId,
				name: "Reset reader",
				normalizedName: "reset reader",
				description: "Role removed by data reset",
				permissions: ["content.read"],
				createdBy: user.userId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				resourceKind: "file",
				resourceId: String(defaultPage.nodeId),
				principalKind: "role",
				role: defaultCustomRoleId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
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
			const extraPage = await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				tag: "reset-personal-extra-page",
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: user.defaultOrganizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				resourceKind: "file",
				resourceId: String(extraPage.nodeId),
				principalKind: "role",
				role: defaultCustomRoleId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
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
				defaultCustomRoleId,
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
				ownedOrganizationId: ownedOrganization._yay.organizationId,
				ownedDefaultWorkspaceId: ownedOrganization._yay.defaultWorkspaceId,
				userRequestId,
				defaultOrganizationRequestId,
				defaultWorkspaceRequestId,
				unrelatedRequestId,
			};
		});

		let resetFinished = false;
		for (let i = 0; i < 100; i += 1) {
			const result = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
					userId: user.userId,
					_test_batchSize: 1,
				}),
			);
			const roleState = await t.run(async (ctx) => {
				const [role, grants] = await Promise.all([
					ctx.db.get("access_control_roles", seeded.defaultCustomRoleId),
					ctx.db
						.query("access_control_permission_grants")
						.withIndex("by_organization_role_workspace_resource", (q) =>
							q
								.eq("organizationId", user.defaultOrganizationId)
								.eq("principalKind", "role")
								.eq("role", seeded.defaultCustomRoleId),
						)
						.collect(),
				]);
				return { role, grants };
			});

			// Every mutation commits separately. Delete the role only after home and extra-workspace
			// grants no longer point at it.
			if (!roleState.role) {
				expect(roleState.grants).toHaveLength(0);
			}
			if (result.done) {
				resetFinished = true;
				break;
			}
		}
		expect(resetFinished).toBe(true);

		const after = await t.run(async (ctx) => {
			const [
				userDoc,
				defaultOrganization,
				defaultWorkspace,
				defaultMembership,
				defaultOwnerRole,
				defaultCustomRole,
				defaultPermissionGrants,
				defaultWorkspaceFiles,
				extraWorkspace,
				ownedOrganization,
				ownedDefaultWorkspace,
				personalWorkspaceQuota,
				userOrganizationQuota,
				activeApiCredentialQuota,
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
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("userId", user.userId),
					)
					.first(),
				ctx.db.get("access_control_roles", seeded.defaultCustomRoleId),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q.eq("organizationId", user.defaultOrganizationId).eq("workspaceId", user.defaultWorkspaceId),
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
				ctx.db
					.query("quotas")
					.withIndex("by_user_organization_workspace_quotaName", (q) =>
						q
							.eq("userId", user.userId)
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("quotaName", "active_api_credentials"),
					)
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
				defaultCustomRole,
				defaultPermissionGrants,
				defaultWorkspaceFiles,
				extraWorkspace,
				ownedOrganization,
				ownedDefaultWorkspace,
				personalWorkspaceQuota,
				userOrganizationQuota,
				activeApiCredentialQuota,
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
		// The reset keeps the owner in the organization doc. It writes no role assignment and no grant.
		expect(after.defaultOwnerRole).toBeNull();
		expect(after.defaultOrganization?.ownerUserId).toBe(user.userId);
		expect(after.defaultCustomRole).toBeNull();
		expect(after.defaultPermissionGrants).toHaveLength(0);
		expect(after.defaultWorkspaceFiles).toHaveLength(0);
		expect(after.extraWorkspace).toBeNull();
		expect(after.ownedOrganization).toBeNull();
		expect(after.ownedDefaultWorkspace).toBeNull();
		expect(after.personalWorkspaceQuota?.usedCount).toBe(0);
		expect(after.userOrganizationQuota?.usedCount).toBe(0);
		expect(after.activeApiCredentialQuota?.usedCount).toBe(0);
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
		// Finish the README seeds scheduled by the workspace creations above so the
		// fetch assertion below only observes the reset flow.
		await data_deletion_test_finish_immediate_scheduled_functions(t);
		fetchSpy.mockClear();
		const result = await t.action(internal.users.hard_delete_user_now, {
			userId: user.userId,
			purgeUserMod: "data",
			_test_batchSize: 1,
		});
		const scheduledContinuations = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.state.kind === "pending" && job.name.includes("hard_delete_user_now"),
			),
		);
		expect(result).toBeNull();
		expect(scheduledContinuations).toHaveLength(1);
		await data_deletion_test_finish_immediate_scheduled_functions(t);
		const unfinishedContinuations = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) =>
					(job.state.kind === "pending" || job.state.kind === "inProgress") &&
					job.name.includes("hard_delete_user_now"),
			),
		);
		expect(unfinishedContinuations).toHaveLength(0);

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
				defaultApiCredentialQuota,
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
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("userId", user.userId),
					)
					.first(),
				quotas_db_get(ctx, {
					quotaName: "active_api_credentials",
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
				}),
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
				defaultApiCredentialQuota,
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
		expect(after.ownerRole).toBeNull();
		expect(after.defaultOrganization?.ownerUserId).toBe(user.userId);
		expect(after.defaultApiCredentialQuota.usedCount).toBe(0);
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

	test("purges queued shared-organization workspace content after the workspace doc was already deleted", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-shared-deleted-ws",
				displayName: "Reset Shared Deleted Workspace",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-shared-deleted-ws-collaborator",
				displayName: "Reset Shared Deleted Workspace Collaborator",
			}),
		);

		const shared = await t.run(async (ctx) => {
			const now = Date.now();
			const organization = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "reset-q-shared",
				description: "",
				now,
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
				updatedAt: now,
			});

			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				name: "queue-only",
				description: "",
				now,
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}
			await data_deletion_test_seed_workspace_content_bulk(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				count: 3,
				tag: "reset-shared-deleted-ws",
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
			});
			const memberships = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_organization_workspace_user", (q) =>
					q
						.eq("active", true)
						.eq("organizationId", organization._yay.organizationId)
						.eq("workspaceId", extraWorkspace._yay.workspaceId),
				)
				.collect();
			await Promise.all(
				memberships.map((membership) => ctx.db.delete("organizations_workspaces_users", membership._id)),
			);
			await ctx.db.delete("organizations_workspaces", extraWorkspace._yay.workspaceId);

			return {
				organizationId: organization._yay.organizationId,
				defaultWorkspaceId: organization._yay.defaultWorkspaceId,
				removedWorkspaceId: extraWorkspace._yay.workspaceId,
				requestId,
			};
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
			batchSize: 5,
		});

		const after = await t.run(async (ctx) => {
			const [request, contentCount, organization, defaultWorkspace] = await Promise.all([
				ctx.db.get("data_deletion_requests", shared.requestId),
				data_deletion_test_count_workspace_content(ctx, {
					organizationId: shared.organizationId,
					workspaceId: shared.removedWorkspaceId,
				}),
				ctx.db.get("organizations", shared.organizationId),
				ctx.db.get("organizations_workspaces", shared.defaultWorkspaceId),
			]);

			return { request, contentCount, organization, defaultWorkspace };
		});

		expect(after.request).toBeNull();
		expect(after.contentCount).toBe(0);
		expect(after.organization?._id).toBe(shared.organizationId);
		expect(after.defaultWorkspace?._id).toBe(shared.defaultWorkspaceId);
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

	test("purges locked home content", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-read-only",
				displayName: "Reset Read Only",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const page = await data_deletion_test_seed_page(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				tag: "reset-locked-page",
			});
			await ctx.db.patch("files_nodes", page.nodeId, {
				readOnlyScopeNodeId: page.nodeId,
			});
			const node = await ctx.db.get("files_nodes", page.nodeId);
			return { nodeId: page.nodeId, assetId: node?.assetId ?? null };
		});

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
		});

		const after = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", seeded.nodeId),
			asset: seeded.assetId ? await ctx.db.get("files_r2_assets", seeded.assetId) : null,
		}));
		// Data reset owns the full lifecycle, so the read-only lock must not stop deletion.
		expect(after.node).toBeNull();
		expect(after.asset).toBeNull();
	});
});

describe("finalize_user_deletion_data", () => {
	test("deletes the user's paged state families, batches, text inputs, and trusted-update stages", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "State Family Victim",
			}),
		);
		const survivor = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-state-family-survivor",
				displayName: "State Family Survivor",
			}),
		);

		async function seed_user_state_docs(
			user: {
				userId: Id<"users">;
				defaultOrganizationId: Id<"organizations">;
				defaultWorkspaceId: Id<"organizations_workspaces">;
			},
			tag: string,
		) {
			return await t.run(async (ctx) => {
				const now = Date.now();
				const nodeId = await ctx.db.insert("files_nodes", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					path: `/${tag}.md`,
					treePath: `/${tag}.md`,
					pathDepth: 1,
					name: `${tag}.md`,
					kind: "file",
					lowercaseExtension: "md",
					parentId: "root",
					createdBy: user.userId,
					updatedBy: user.userId,
					updatedAt: now,
				});
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: String(user.userId),
					fileNodeId: nodeId,
					size: 0,
					updatedAt: now,
				});
				const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: String(user.userId),
					fileNodeId: nodeId,
					owner: { kind: "active", pendingUpdateId, role: "base" },
					lineageGeneration: 0,
					sealed: true,
					pageCount: 1,
					totalBytes: 4,
					digest: "finalize-digest",
				});
				await ctx.db.insert("files_pending_update_yjs_state_pages", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					stateId,
					pageIndex: 0,
					bytes: new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer,
				});
				const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: String(user.userId),
					fileNodeId: nodeId,
					expiresAt: now + 30 * 60 * 1000,
					lastActivityAt: now,
					updatedAt: now,
				});
				await ctx.db.insert("files_pending_update_text_inputs", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: String(user.userId),
					fileNodeId: nodeId,
					operationBatchId,
					role: "staged",
					text: "staged text",
					expiresAt: now + 30 * 60 * 1000,
				});
				await ctx.db.insert("files_yjs_trusted_update_stages", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					fileNodeId: nodeId,
					kind: "snapshot_restore",
					update: new Uint8Array([0, 0]).buffer as ArrayBuffer,
					expiresAt: now + 30 * 60 * 1000,
				});
				return { stateId };
			});
		}

		await seed_user_state_docs(victim, "victim-state-family");
		const survivorSeed = await seed_user_state_docs(survivor, "survivor-state-family");

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: victim.userId,
			}),
		);

		const remaining = await t.run(async (ctx) => ({
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			batches: await ctx.db.query("files_pending_update_operation_batches").collect(),
			textInputs: await ctx.db.query("files_pending_update_text_inputs").collect(),
			trustedStages: await ctx.db.query("files_yjs_trusted_update_stages").collect(),
		}));

		// Only the survivor's docs remain: user finalization drains every user-scoped doc class.
		expect(remaining.states.map((doc) => doc._id)).toEqual([survivorSeed.stateId]);
		expect(remaining.pages.map((doc) => doc.stateId)).toEqual([survivorSeed.stateId]);
		expect(remaining.batches.map((doc) => doc.userId)).toEqual([String(survivor.userId)]);
		expect(remaining.textInputs.map((doc) => doc.userId)).toEqual([String(survivor.userId)]);
		expect(remaining.trustedStages.map((doc) => doc.userId)).toEqual([survivor.userId]);
	});

	test("keeps a shared organization when its Clerk member is reset before its local owner is removed", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "Anonymous Shared Owner",
			}),
		);
		const collaborator = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-shared-owner-successor",
				displayName: "Shared Owner Successor",
			}),
		);
		const shared = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "shared-owner-removal",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}
			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: owner.userId,
				organizationId: created._yay.organizationId,
				name: "future-purge",
				description: "",
				now: Date.now(),
			});
			if (extraWorkspace._nay) {
				throw new Error(extraWorkspace._nay.message);
			}

			const now = Date.now();
			await Promise.all([
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay.organizationId,
					workspaceId: created._yay.defaultWorkspaceId,
					userId: collaborator.userId,
					active: true,
					updatedAt: now,
				}),
				ctx.db.insert("access_control_role_assignments", {
					organizationId: created._yay.organizationId,
					workspaceId: created._yay.defaultWorkspaceId,
					userId: collaborator.userId,
					role: "member",
					createdAt: now,
					updatedAt: now,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay.organizationId,
					workspaceId: extraWorkspace._yay.workspaceId,
					userId: collaborator.userId,
					active: true,
					updatedAt: now,
				}),
				ctx.db.insert("access_control_role_assignments", {
					organizationId: created._yay.organizationId,
					workspaceId: extraWorkspace._yay.workspaceId,
					userId: collaborator.userId,
					role: "member",
					createdAt: now,
					updatedAt: now,
				}),
				data_deletion_test_seed_page(ctx, {
					userId: owner.userId,
					organizationId: created._yay.organizationId,
					workspaceId: created._yay.defaultWorkspaceId,
					tag: "shared-owner-content",
				}),
				data_deletion_test_seed_page(ctx, {
					userId: owner.userId,
					organizationId: created._yay.organizationId,
					workspaceId: extraWorkspace._yay.workspaceId,
					tag: "shared-owner-future-content",
				}),
			]);
			const futureWorkspaceRequestId = await data_deletion_db_request(ctx, {
				userId: owner.userId,
				organizationId: created._yay.organizationId,
				workspaceId: extraWorkspace._yay.workspaceId,
				scope: "workspace",
			});

			return {
				...created._yay,
				extraWorkspaceId: extraWorkspace._yay.workspaceId,
				futureWorkspaceRequestId,
			};
		});

		// The reset processes Clerk-backed users first, so their shared membership
		// remains available when the local-only owner is removed next.
		await data_deletion_test_hard_delete_user_now_data_until_idle(t, {
			userId: collaborator.userId,
		});
		// A forced deletion handoff preserves the shared organization even when
		// the successor is already at the normal organization creation limit.
		const collaboratorQuotaMax = await t.run(async (ctx) => {
			const quota = await ctx.db
				.query("quotas")
				.withIndex("by_user_quotaName", (q) =>
					q.eq("userId", collaborator.userId).eq("quotaName", "extra_organizations"),
				)
				.unique();
			if (!quota) {
				throw new Error("Expected collaborator organization quota");
			}
			await ctx.db.patch("quotas", quota._id, { usedCount: quota.maxCount });
			return quota.maxCount;
		});
		const deletionResult = await t.action(internal.users.hard_delete_user_now, {
			userId: owner.userId,
			purgeUserMod: "data_auth_and_user_record",
			_test_disableReschedule: true,
		});
		await data_deletion_test_run_worker_until_idle(t);

		const after = await t.run(async (ctx) => {
			const [
				deletedOwner,
				organization,
				collaboratorMembership,
				collaboratorRoles,
				collaboratorQuota,
				futureWorkspaceRequest,
				defaultWorkspaceFiles,
				futureWorkspaceFiles,
			] = await Promise.all([
				ctx.db.get("users", owner.userId),
				ctx.db.get("organizations", shared.organizationId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", collaborator.userId)
							.eq("organizationId", shared.organizationId)
							.eq("workspaceId", shared.defaultWorkspaceId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", shared.organizationId)
							.eq("workspaceId", shared.defaultWorkspaceId)
							.eq("userId", collaborator.userId),
					)
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", collaborator.userId).eq("quotaName", "extra_organizations"),
					)
					.unique(),
				ctx.db.get("data_deletion_requests", shared.futureWorkspaceRequestId),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((files) => files.filter((file) => file.workspaceId === shared.defaultWorkspaceId)),
				ctx.db
					.query("files_nodes")
					.collect()
					.then((files) => files.filter((file) => file.workspaceId === shared.extraWorkspaceId)),
			]);

			return {
				deletedOwner,
				organization,
				collaboratorMembership,
				collaboratorRoles,
				collaboratorQuota,
				futureWorkspaceRequest,
				defaultWorkspaceFiles,
				futureWorkspaceFiles,
			};
		});

		expect(deletionResult).toBeNull();
		expect(after.deletedOwner).toBeNull();
		expect(after.organization?.ownerUserId).toBe(collaborator.userId);
		expect(after.collaboratorMembership).not.toBeNull();
		// The new owner gets all their power from the organization doc, so their role assignment is
		// deleted.
		expect(after.collaboratorRoles).toHaveLength(0);
		expect(after.collaboratorQuota?.usedCount).toBe(collaboratorQuotaMax + 1);
		expect(after.futureWorkspaceRequest).toBeNull();
		expect(after.defaultWorkspaceFiles).toHaveLength(1);
		expect(after.futureWorkspaceFiles).toHaveLength(0);
	});

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
				userId: unrelatedUser.userId,
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
				deletionJobs,
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
				ctx.db.query("files_r2_object_deletion_jobs").collect(),
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
				deletionJobs,
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
		expect(after.deletionJobs.some((job) => job.r2Key === deletedR2Keys[0])).toBe(true);
		expect(after.deletionJobs.some((job) => job.r2Key === deletedR2Keys[1])).toBe(true);
		expect(after.userRequest).toBeNull();
		expect(after.organizationRequest).toBeNull();
		expect(after.workspaceRequest).toBeNull();
		expect(after.unrelatedWorkspaceRequest?._id).toBe(requestIds.unrelatedWorkspaceRequestId);
	});

	test("prepares hard deletion by tombstoning first and draining plugin UI sessions in bounded batches", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-session-drain",
				displayName: "Hard Delete Session Drain",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				sessionCount: 5,
			}),
		);

		const firstResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 2,
			}),
		);

		const afterFirstBatch = await t.run(async (ctx) => {
			const [sessions, user, userRequests] = await Promise.all([
				ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("users", deletedUser.userId),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect()
					.then((requests) => requests.filter((request) => request.scope === "user")),
			]);
			return { sessionCount: sessions.length, user, userRequests };
		});
		expect(firstResult).toBe(false);
		expect(afterFirstBatch.sessionCount).toBe(3);
		expect(afterFirstBatch.user?.deletedAt).toBeTypeOf("number");
		expect(afterFirstBatch.user?.defaultOrganizationId).toBe(deletedUser.defaultOrganizationId);
		expect(afterFirstBatch.userRequests).toHaveLength(0);

		const secondResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 2,
			}),
		);
		const thirdResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 2,
			}),
		);
		expect(secondResult).toBe(false);
		expect(thirdResult).toBe(true);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
			}),
		);

		const remainingSessions = await t.run((ctx) =>
			ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
		);
		expect(remainingSessions).toHaveLength(0);
	});

	test("prepares hard deletion by draining publisher docs in bounded child-first batches", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-publisher-drain",
				displayName: "Hard Delete Publisher Drain",
			}),
		);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 5; i += 1) {
				const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
					ownerUserId: deletedUser.userId,
					repositoryUrl: `https://github.com/bonobo/delete-${i}`,
					owner: "bonobo",
					repo: `delete-${i}`,
				});
				await Promise.all([
					ctx.db.insert("plugins_publisher_repository_secrets", {
						ownerUserId: deletedUser.userId,
						repositoryId,
						name: `SECRET_${i}`,
						ciphertext: new TextEncoder().encode(`ciphertext-${i}`).buffer,
						nonce: new TextEncoder().encode(`nonce-${i}`).buffer,
						valuePreview: "configured",
						updatedAt: now,
					}),
					ctx.db.insert("plugins_version_reviews", {
						createdBy: deletedUser.userId,
						artifactHash: `sha256:${i.toString(16).repeat(64)}`,
						reviewSubjectHash: `subject:${i.toString(16).repeat(64)}`,
						reviewPolicyVersion: "1",
						pluginName: `delete-${i}`,
						version: "0.1.0",
						status: "passed",
						mechanicalFindings: [],
						mechanicalAdvisoryFindings: [],
						aiFindings: [],
						capabilityMap: [],
						model: "none",
						updatedAt: now,
					}),
				]);
			}
		});

		const firstResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 2,
			}),
		);
		const afterFirstBatch = await t.run(async (ctx) => {
			const [secrets, repositories, reviews] = await Promise.all([
				ctx.db
					.query("plugins_publisher_repository_secrets")
					.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("plugins_publisher_repositories")
					.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("plugins_version_reviews")
					.withIndex("by_createdBy_pluginName", (q) => q.eq("createdBy", deletedUser.userId))
					.collect(),
			]);
			return { secretCount: secrets.length, repositoryCount: repositories.length, reviewCount: reviews.length };
		});

		expect(firstResult).toBe(false);
		expect(afterFirstBatch).toEqual({ secretCount: 3, repositoryCount: 5, reviewCount: 5 });

		const remainingResults: boolean[] = [];
		for (let i = 0; i < 9; i += 1) {
			remainingResults.push(
				await t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
						userId: deletedUser.userId,
						_test_batchSize: 2,
					}),
				),
			);
		}
		expect(remainingResults).toEqual([false, false, false, false, false, false, false, false, true]);

		const afterDone = await t.run(async (ctx) => {
			const [secrets, repositories, reviews] = await Promise.all([
				ctx.db
					.query("plugins_publisher_repository_secrets")
					.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("plugins_publisher_repositories")
					.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("plugins_version_reviews")
					.withIndex("by_createdBy_pluginName", (q) => q.eq("createdBy", deletedUser.userId))
					.collect(),
			]);
			return { secretCount: secrets.length, repositoryCount: repositories.length, reviewCount: reviews.length };
		});
		expect(afterDone).toEqual({ secretCount: 0, repositoryCount: 0, reviewCount: 0 });
	});

	test("uses the production publisher-doc batch cap", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-publisher-cap",
				displayName: "Hard Delete Publisher Cap",
			}),
		);
		await t.run(async (ctx) => {
			const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: deletedUser.userId,
				repositoryUrl: "https://github.com/bonobo/delete-cap",
				owner: "bonobo",
				repo: "delete-cap",
			});
			await Promise.all(
				Array.from({ length: 101 }, (_, index) =>
					ctx.db.insert("plugins_publisher_repository_secrets", {
						ownerUserId: deletedUser.userId,
						repositoryId,
						name: `SECRET_${index}`,
						ciphertext: new TextEncoder().encode(`ciphertext-${index}`).buffer,
						nonce: new TextEncoder().encode(`nonce-${index}`).buffer,
						valuePreview: "configured",
						updatedAt: Date.now(),
					}),
				),
			);
		});

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
			}),
		);
		const remainingSecrets = await t.run((ctx) =>
			ctx.db
				.query("plugins_publisher_repository_secrets")
				.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", deletedUser.userId))
				.collect(),
		);

		expect(result).toBe(false);
		expect(remainingSecrets).toHaveLength(1);
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
				processingWorkId: "work_worker_r2_failure" as WorkId,
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

		vi.spyOn(Workpool.prototype, "cancel").mockRejectedValueOnce(new Error("Workpool unavailable"));
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

	test("moves persistent workspace failures behind later tenant cleanup", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-workspace-fairness",
				displayName: "Workspace Fairness",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const eligibleAt = Date.now();
			const failureRequestIds: Array<Id<"data_deletion_requests">> = [];

			for (let i = 0; i < 25; i += 1) {
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId: user.defaultOrganizationId,
					name: `fair-ws-${i}`,
					description: "",
					default: false,
					updatedAt: eligibleAt,
				});
				await ctx.db.insert("files_r2_assets", {
					organizationId: user.defaultOrganizationId,
					workspaceId,
					kind: "content",
					r2Bucket: "test-bucket",
					r2Key: `content/workspace-fairness-fail-${i}`,
					size: 1,
					processingWorkId: `work_workspace_fairness_fail_${i}` as WorkId,
					createdBy: user.userId,
					updatedAt: eligibleAt,
				});
				failureRequestIds.push(
					await ctx.db.insert("data_deletion_requests", {
						userId: user.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId,
						scope: "workspace",
						eligibleAt,
					}),
				);
			}

			// This ordinary empty workspace is request 26. It must not wait behind
			// the failing R2-backed workspaces forever.
			const successWorkspaceId = await ctx.db.insert("organizations_workspaces", {
				organizationId: user.defaultOrganizationId,
				name: "fair-ws-success",
				description: "",
				default: false,
				updatedAt: eligibleAt,
			});
			const successRequestId = await ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: successWorkspaceId,
				scope: "workspace",
				eligibleAt,
			});

			return {
				eligibleAt,
				failureRequestIds,
				successRequestId,
				successWorkspaceId,
				testNow: eligibleAt + 1,
			};
		});

		vi.spyOn(Workpool.prototype, "cancel").mockImplementation(async (_ctx, workId) => {
			if (String(workId).includes("workspace_fairness_fail")) {
				throw new Error("Workpool unavailable");
			}
		});
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_now: seeded.testNow,
				_test_disableReschedule: true,
			});
			const afterFirst = await t.run(async (ctx) => ({
				failures: await Promise.all(
					seeded.failureRequestIds.map((requestId) => ctx.db.get("data_deletion_requests", requestId)),
				),
				success: await ctx.db.get("data_deletion_requests", seeded.successRequestId),
			}));

			expect(first.steps).toBe(25);
			expect(afterFirst.failures.every((request) => request?.eligibleAt === seeded.testNow)).toBe(true);
			expect(afterFirst.success?.eligibleAt).toBe(seeded.eligibleAt);

			const second = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_now: seeded.testNow,
				_test_disableReschedule: true,
			});
			const afterSecond = await t.run(async (ctx) => ({
				failureRequests: await Promise.all(
					seeded.failureRequestIds.map((requestId) => ctx.db.get("data_deletion_requests", requestId)),
				),
				failureAssets: await ctx.db
					.query("files_r2_assets")
					.withIndex("by_organization_workspace", (q) => q.eq("organizationId", user.defaultOrganizationId))
					.collect(),
				successRequest: await ctx.db.get("data_deletion_requests", seeded.successRequestId),
				successWorkspace: await ctx.db.get("organizations_workspaces", seeded.successWorkspaceId),
			}));

			expect(second.steps).toBe(25);
			expect(afterSecond.failureRequests.every((request) => request !== null)).toBe(true);
			expect(afterSecond.failureAssets).toHaveLength(25);
			expect(afterSecond.successRequest).toBeNull();
			expect(afterSecond.successWorkspace?._id).toBe(seeded.successWorkspaceId);
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("moves persistent organization failures behind later tenant cleanup", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-organization-fairness",
				displayName: "Organization Fairness",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const eligibleAt = Date.now();
			const failureRequestIds: Array<Id<"data_deletion_requests">> = [];
			const failureOrganizationIds: Array<Id<"organizations">> = [];

			for (let i = 0; i < 25; i += 1) {
				const organizationId = await ctx.db.insert("organizations", {
					name: `fair-org-${i}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: user.userId,
					updatedAt: eligibleAt,
				});
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId,
					name: `fair-org-ws-${i}`,
					description: "",
					default: true,
					updatedAt: eligibleAt,
				});
				await ctx.db.insert("files_r2_assets", {
					organizationId,
					workspaceId,
					kind: "content",
					r2Bucket: "test-bucket",
					r2Key: `content/organization-fairness-fail-${i}`,
					size: 1,
					processingWorkId: `work_organization_fairness_fail_${i}` as WorkId,
					createdBy: user.userId,
					updatedAt: eligibleAt,
				});
				failureOrganizationIds.push(organizationId);
				failureRequestIds.push(
					await ctx.db.insert("data_deletion_requests", {
						userId: user.userId,
						organizationId,
						scope: "organization",
						eligibleAt,
					}),
				);
			}

			// This ordinary empty organization is request 26. It must not wait
			// behind the failing R2-backed organizations forever.
			const successOrganizationId = await ctx.db.insert("organizations", {
				name: "fair-org-complete",
				description: "",
				default: false,
				billingMode: "user",
				ownerUserId: user.userId,
				updatedAt: eligibleAt,
			});
			const successRequestId = await ctx.db.insert("data_deletion_requests", {
				userId: user.userId,
				organizationId: successOrganizationId,
				scope: "organization",
				eligibleAt,
			});

			return {
				eligibleAt,
				failureOrganizationIds,
				failureRequestIds,
				successOrganizationId,
				successRequestId,
				testNow: eligibleAt + 1,
			};
		});

		vi.spyOn(Workpool.prototype, "cancel").mockImplementation(async (_ctx, workId) => {
			if (String(workId).includes("organization_fairness_fail")) {
				throw new Error("Workpool unavailable");
			}
		});
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_now: seeded.testNow,
				_test_disableReschedule: true,
			});
			const afterFirst = await t.run(async (ctx) => ({
				failures: await Promise.all(
					seeded.failureRequestIds.map((requestId) => ctx.db.get("data_deletion_requests", requestId)),
				),
				success: await ctx.db.get("data_deletion_requests", seeded.successRequestId),
			}));

			expect(first.steps).toBe(25);
			expect(afterFirst.failures.every((request) => request?.eligibleAt === seeded.testNow)).toBe(true);
			expect(afterFirst.success?.eligibleAt).toBe(seeded.eligibleAt);

			const second = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_now: seeded.testNow,
				_test_disableReschedule: true,
			});
			const afterSecond = await t.run(async (ctx) => ({
				failureRequests: await Promise.all(
					seeded.failureRequestIds.map((requestId) => ctx.db.get("data_deletion_requests", requestId)),
				),
				failureOrganizations: await Promise.all(
					seeded.failureOrganizationIds.map((organizationId) => ctx.db.get("organizations", organizationId)),
				),
				failureAssets: await ctx.db.query("files_r2_assets").collect(),
				successOrganization: await ctx.db.get("organizations", seeded.successOrganizationId),
				successRequest: await ctx.db.get("data_deletion_requests", seeded.successRequestId),
			}));

			expect(second.steps).toBe(25);
			expect(afterSecond.failureRequests.every((request) => request !== null)).toBe(true);
			expect(afterSecond.failureOrganizations.every((organization) => organization !== null)).toBe(true);
			expect(afterSecond.failureAssets).toHaveLength(25);
			expect(afterSecond.successOrganization).toBeNull();
			expect(afterSecond.successRequest).toBeNull();
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
		const anonymousPayload = (await anonymousResponse.json()) as {
			token: string;
			refreshToken: string;
			userId: Id<"users">;
		};

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-anon-again",
				email: recoveryEmail,
				anonymousUserToken: anonymousPayload.refreshToken,
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

describe("prepare_user_for_hard_deletion", () => {
	test("drains the deleted user's repository claims, publisher secrets, and version review docs", async () => {
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
			});
			const deletedSecretId = await ctx.db.insert("plugins_publisher_repository_secrets", {
				ownerUserId: deletedUser.userId,
				repositoryId: deletedRepositoryId,
				name: "OPENAI_API_KEY",
				ciphertext: new TextEncoder().encode("ciphertext").buffer,
				nonce: new TextEncoder().encode("nonce").buffer,
				valuePreview: "configured",
				updatedAt: now,
			});
			const deletedReviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: deletedUser.userId,
				artifactHash: `sha256:${"d".repeat(64)}`,
				reviewSubjectHash: `subject:${"d".repeat(64)}`,
				reviewPolicyVersion: "1",
				pluginName: "media",
				version: "0.1.0",
				status: "passed",
				mechanicalFindings: [],
				mechanicalAdvisoryFindings: [],
				aiFindings: [],
				capabilityMap: [],
				model: "none",
				updatedAt: now,
			});
			const linkedDeletedReviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: deletedUser.userId,
				artifactHash: `sha256:${"c".repeat(64)}`,
				reviewSubjectHash: `subject:${"c".repeat(64)}`,
				reviewPolicyVersion: "1",
				pluginName: "cached-media",
				version: "0.1.0",
				status: "passed",
				mechanicalFindings: [],
				mechanicalAdvisoryFindings: [],
				aiFindings: [],
				capabilityMap: [],
				model: "none",
				updatedAt: now,
			});
			const linkedVersionId = await ctx.db.insert("plugins_versions", {
				name: "cached-media",
				displayName: "Cached Media",
				version: "0.1.0",
				description: "Cached media plugin",
				reviewStatus: "passed",
				reviewId: linkedDeletedReviewId,
				isLatest: true,
				artifactHash: `sha256:${"c".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/unrelated/cached-media-plugin",
				sourceOwner: "unrelated",
				sourceRepo: "cached-media-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/cached-media/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				capabilities: [],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: unrelatedUser.userId,
				updatedAt: now,
			});
			const unrelatedRepositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: unrelatedUser.userId,
				repositoryUrl: "https://github.com/gorilla/pdf-plugin",
				owner: "gorilla",
				repo: "pdf-plugin",
			});
			const unrelatedSecretId = await ctx.db.insert("plugins_publisher_repository_secrets", {
				ownerUserId: unrelatedUser.userId,
				repositoryId: unrelatedRepositoryId,
				name: "MODAL_TOKEN",
				ciphertext: new TextEncoder().encode("ciphertext").buffer,
				nonce: new TextEncoder().encode("nonce").buffer,
				valuePreview: "configured",
				updatedAt: now,
			});
			const unrelatedReviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: unrelatedUser.userId,
				artifactHash: `sha256:${"e".repeat(64)}`,
				reviewSubjectHash: `subject:${"e".repeat(64)}`,
				reviewPolicyVersion: "1",
				pluginName: "pdf",
				version: "0.1.0",
				status: "passed",
				mechanicalFindings: [],
				mechanicalAdvisoryFindings: [],
				aiFindings: [],
				capabilityMap: [],
				model: "none",
				updatedAt: now,
			});

			return {
				deletedRepositoryId,
				deletedSecretId,
				deletedReviewId,
				linkedDeletedReviewId,
				linkedVersionId,
				unrelatedRepositoryId,
				unrelatedSecretId,
				unrelatedReviewId,
			};
		});

		let prepared = false;
		for (let i = 0; i < 10; i += 1) {
			prepared = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
					userId: deletedUser.userId,
					_test_batchSize: 2,
				}),
			);
			if (prepared) {
				break;
			}
		}
		expect(prepared).toBe(true);
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
				linkedDeletedReview,
				linkedVersion,
				deletedUserRepositories,
				unrelatedRepository,
				unrelatedSecret,
				unrelatedReview,
			] = await Promise.all([
				ctx.db.get("plugins_publisher_repositories", seeded.deletedRepositoryId),
				ctx.db.get("plugins_publisher_repository_secrets", seeded.deletedSecretId),
				ctx.db.get("plugins_version_reviews", seeded.deletedReviewId),
				ctx.db.get("plugins_version_reviews", seeded.linkedDeletedReviewId),
				ctx.db.get("plugins_versions", seeded.linkedVersionId),
				ctx.db
					.query("plugins_publisher_repositories")
					.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", deletedUser.userId))
					.collect(),
				ctx.db.get("plugins_publisher_repositories", seeded.unrelatedRepositoryId),
				ctx.db.get("plugins_publisher_repository_secrets", seeded.unrelatedSecretId),
				ctx.db.get("plugins_version_reviews", seeded.unrelatedReviewId),
			]);

			return {
				deletedRepository,
				deletedSecret,
				deletedReview,
				linkedDeletedReview,
				linkedVersion,
				deletedUserRepositories,
				unrelatedRepository,
				unrelatedSecret,
				unrelatedReview,
			};
		});

		expect(after.deletedRepository).toBeNull();
		expect(after.deletedSecret).toBeNull();
		expect(after.deletedReview).toBeNull();
		expect(after.linkedDeletedReview?.createdBy).toBeNull();
		expect(after.linkedVersion?.reviewId).toBe(seeded.linkedDeletedReviewId);
		expect(after.deletedUserRepositories).toHaveLength(0);
		expect(after.unrelatedRepository?._id).toBe(seeded.unrelatedRepositoryId);
		expect(after.unrelatedSecret?._id).toBe(seeded.unrelatedSecretId);
		expect(after.unrelatedReview?._id).toBe(seeded.unrelatedReviewId);

		// A second publisher may have received this global cached review before deletion removed it.
		// Registration must reload the review in its own transaction instead of storing a dangling id.
		expect(
			await t.mutation(internal.plugins.upsert_plugin, {
				repositoryId: seeded.unrelatedRepositoryId,
				name: "media",
				displayName: "Media",
				version: "0.2.0",
				description: "Deleted review race fixture",
				reviewStatus: "passed",
				reviewId: seeded.deletedReviewId,
				artifactHash: `sha256:${"d".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/gorilla/pdf-plugin",
				sourceOwner: "gorilla",
				sourceRepo: "pdf-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/media/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				pages: [],
				fileViews: [],
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				createdBy: unrelatedUser.userId,
			}),
		).toEqual({ _nay: { message: "Plugin review changed during publishing; publish again" } });
	});

	test("keeps a cached review used by another publisher's last attempt", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-cached-attempt-review",
				displayName: "Deleted Review Creator",
			}),
		);
		const publisher = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-cached-attempt-publisher",
				displayName: "Cached Review Publisher",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const reviewId = await ctx.db.insert("plugins_version_reviews", {
				createdBy: deletedUser.userId,
				artifactHash: `sha256:${"a".repeat(64)}`,
				reviewSubjectHash: `subject:${"a".repeat(64)}`,
				reviewPolicyVersion: "3",
				pluginName: "cached-attempt",
				version: "0.2.0",
				status: "rejected",
				mechanicalFindings: [],
				mechanicalAdvisoryFindings: [],
				aiFindings: ["Cached rejection"],
				capabilityMap: [],
				model: "gpt-5.4-mini",
				updatedAt: now,
			});
			const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: publisher.userId,
				repositoryUrl: "https://github.com/bonobo/cached-attempt-plugin",
				owner: "bonobo",
				repo: "cached-attempt-plugin",
				lastPublishAttempt: {
					at: now,
					pluginName: "cached-attempt",
					status: "rejected",
					message: "Plugin review rejected this version: Cached rejection",
					commitSha: null,
					artifactHash: `sha256:${"a".repeat(64)}`,
					reviewId,
				},
			});
			await ctx.db.insert("plugins_versions", {
				name: "cached-attempt",
				displayName: "Cached Attempt",
				version: "0.1.0",
				description: "Existing release",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"b".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/cached-attempt-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "cached-attempt-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/cached-attempt/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				pages: [],
				fileViews: [],
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: publisher.userId,
				updatedAt: now,
			});
			return { repositoryId, reviewId };
		});

		let prepared = false;
		for (let index = 0; index < 10; index += 1) {
			prepared = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
					userId: deletedUser.userId,
					_test_batchSize: 2,
				}),
			);
			if (prepared) break;
		}
		expect(prepared).toBe(true);

		const review = await t.run((ctx) => ctx.db.get("plugins_version_reviews", seeded.reviewId));
		expect(review?.createdBy).toBeNull();
		const details = await t
			.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-cached-attempt-publisher",
				external_id: publisher.userId,
			})
			.query(api.plugins.get_publisher_plugin, { pluginName: "cached-attempt" });
		expect(details?.repository._id).toBe(seeded.repositoryId);
		expect(details?.repository.lastPublishAttempt?.reviewId).toBe(seeded.reviewId);
		expect(details?.reviews.map((item) => item._id)).toContain(seeded.reviewId);
	});

	test("drains the deleted user's notifications after the publisher docs", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-prepare-notification-drain",
				displayName: "Prepare Notification Drain",
			}),
		);
		const otherUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-prepare-notification-other",
				displayName: "Prepare Notification Other",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			for (let i = 0; i < 3; i += 1) {
				await ctx.db.insert("notifications", {
					userId: deletedUser.userId,
					kind: "organization_workspace_invite",
					archivedAt: 0,
					actorUserId: otherUser.userId,
					organizationId: otherUser.defaultOrganizationId,
					workspaceId: otherUser.defaultWorkspaceId,
					updatedAt: now,
				});
			}
			// The deleted user only as actor: this row belongs to the other user's inbox and stays.
			const actorOnlyId = await ctx.db.insert("notifications", {
				userId: otherUser.userId,
				kind: "organization_workspace_invite",
				archivedAt: 0,
				actorUserId: deletedUser.userId,
				organizationId: otherUser.defaultOrganizationId,
				workspaceId: otherUser.defaultWorkspaceId,
				updatedAt: now,
			});
			return { actorOnlyId };
		});

		// Pass 1 deletes two notifications, pass 2 the last one, pass 3 finds nothing and reports done.
		const passes = [];
		for (let i = 0; i < 3; i += 1) {
			passes.push(
				await t.run((ctx) =>
					ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
						userId: deletedUser.userId,
						_test_batchSize: 2,
					}),
				),
			);
		}
		expect(passes).toEqual([false, false, true]);

		const after = await t.run(async (ctx) => {
			const [recipientRows, actorOnly] = await Promise.all([
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db.get("notifications", seeded.actorOnlyId),
			]);
			return { recipientRows, actorOnly };
		});
		expect(after.recipientRows).toHaveLength(0);
		expect(after.actorOnly).not.toBeNull();
	});
});
