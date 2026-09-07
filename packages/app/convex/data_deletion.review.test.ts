import { R2 } from "@convex-dev/r2";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_cancel_pending_home_file_seeds, test_mocks_fill_db_with } from "./setup.test.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { files_nodes_db_is_eager_node_safe_to_hard_delete } from "./files_nodes.ts";
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { r2_confirmed_object_delete, r2_PUT_MAY_ARRIVE_MARGIN_MS, r2_create_asset_key } from "./r2_client.ts";

const test = baseTest.sequential;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Review tests block network calls"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllTimers();
	vi.useRealTimers();
});

// These fixtures are copied from data_deletion.test.ts. The review owns only this new file.
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
		contentType: null,
		assetId: null,
		textKind: null,
		collaborationEnabled: null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: null,
		readOnlyScopeNodeId: null,
		readOnlyPluginName: null,
		readOnlyPluginServiceTargetId: null,
		archiveOperationId: null,
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
			assetId: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			readOnlyScopeNodeId: null,
			readOnlyPluginName: null,
			readOnlyPluginServiceTargetId: null,
			archiveOperationId: null,
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
			textKind: "rich_text",
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
				fieldPath: "frontmatter.cleanup",
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
				fieldPath: "frontmatter.cleanup",
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
					fieldPath: "frontmatter.cleanup",
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
					fieldPath: "frontmatter.cleanup",
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

const review_workspace_tables = [
	"files_pending_update_yjs_state_pages",
	"files_pending_update_yjs_states",
	"files_pending_update_state_cleanup_tasks",
	"files_pending_update_text_inputs",
	"files_pending_update_operation_batches",
	"files_yjs_trusted_update_stages",
	"files_pending_updates_cleanup_tasks",
	"files_pending_updates",
	"files_pending_updates_last_sequence_saved",
	"ai_chat_files_content",
	"ai_chat_files",
	"ai_chat_threads_messages_aisdk_5",
	"ai_chat_threads_state",
	"ai_chat_threads",
	"api_credentials",
	"public_api_grants",
	"public_api_file_write_stages",
	"plugins_event_run_calls",
	"plugins_event_runs",
	"plugins_workspace_event_handlers",
	"plugins_workspace_installation_secrets",
	"plugins_data_reservations",
	"plugins_data_append_replay_receipts",
	"plugins_data_revision_tombstones",
	"plugins_data",
	"plugin_service_grants",
	"plugins_file_access_bindings",
	"plugins_data_scopes",
	"plugins_data_released_scope_ranges",
	"plugin_service_storage_destinations",
	"plugin_service_storage_targets",
	"plugin_service_storage_attempts",
	"plugins_data_member_usage",
	"plugins_data_usage",
	"plugins_ui_sessions",
	"plugins_workspace_installations",
	"activities",
	"chat_messages",
	"files_metadata_docs",
	"files_plain_text_chunks",
	"files_text_chunks",
	"files_yjs_snapshots",
	"files_yjs_updates",
	"files_yjs_docs_last_sequences",
	"files_snapshots",
	"file_stats",
	"files_content_materialization_jobs",
	"files_r2_assets",
	"access_control_permission_grants",
	"files_nodes",
] as const;

async function review_seed_all_workspace_content(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	await data_deletion_test_seed_workspace_content_bulk(ctx, { ...args, count: 2 });
	const now = Date.now();
	const tenant = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	const nodes = (
		await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.collect()
	).filter((node) => node.path === `/${args.tag}-0.md` || node.path === `/${args.tag}-1.md`);
	if (nodes.length !== 2) throw new Error("Expected both base fixture files");
	for (const quotaName of ["public_api_upload_bytes", "plugin_service_storage_bytes"] as const) {
		const quotaId = await quotas_db_ensure(ctx, { ...tenant, quotaName, now });
		await ctx.db.patch("quotas", quotaId, { usedCount: 100 });
	}
	for (let i = 0; i < 2; i += 1) {
		const node = nodes[i]!;
		if (!node.assetId) throw new Error("Expected the base fixture asset");
		const pending = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_fileNode", (q) => q.eq("userId", String(args.userId)).eq("fileNodeId", node._id))
			.first();
		if (!pending) throw new Error("Expected the base fixture proposal");
		const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
			...tenant,
			userId: String(args.userId),
			fileNodeId: node._id,
			expiresAt: now + 1_800_000,
			lastActivityAt: now,
			updatedAt: now,
		});
		const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
			...tenant,
			createdAt: now,
		});
		const activeIds: Array<Id<"files_pending_update_yjs_states">> = [];
		for (const owner of [
			{ kind: "active", pendingUpdateId: pending._id, role: "base" },
			{ kind: "active", pendingUpdateId: pending._id, role: "staged" },
			{ kind: "active", pendingUpdateId: pending._id, role: "unstaged" },
			{ kind: "temporary", operationBatchId, phase: "input", role: "base", expiresAt: now + 1_800_000 },
			{ kind: "retired", cleanupTaskId },
		] as const) {
			const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
				...tenant,
				userId: String(args.userId),
				fileNodeId: node._id,
				owner,
				lineageGeneration: 0,
				sealed: true,
				pageCount: 1,
				totalBytes: 2,
				digest: "review-empty-yjs",
			});
			await ctx.db.insert("files_pending_update_yjs_state_pages", {
				...tenant,
				stateId,
				pageIndex: 0,
				bytes: new Uint8Array([0, 0]).buffer,
			});
			if (owner.kind === "active") activeIds.push(stateId);
		}
		await ctx.db.patch("files_pending_updates", pending._id, {
			baseYjsSequence: 1,
			baseLineageGeneration: 0,
			baseStateId: activeIds[0]!,
			stagedStateId: activeIds[1]!,
			unstagedStateId: activeIds[2]!,
		});
		await ctx.db.insert("files_pending_update_text_inputs", {
			...tenant,
			userId: String(args.userId),
			fileNodeId: node._id,
			operationBatchId,
			role: "staged",
			text: "draft",
			expiresAt: now + 1_800_000,
		});
		await ctx.db.insert("files_yjs_trusted_update_stages", {
			...tenant,
			userId: args.userId,
			fileNodeId: node._id,
			kind: "snapshot_restore",
			update: new Uint8Array([0, 0]).buffer,
			expiresAt: now + 1_800_000,
		});
		await ctx.db.insert("files_content_materialization_jobs", {
			...tenant,
			fileNodeId: node._id,
			jobId: `review_materialize_${args.tag}_${i}` as WorkId,
			targetSequence: 1,
		});
		const { installationId } = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
			...tenant,
			userId: args.userId,
			sessionCount: 2,
		});
		const installation = await ctx.db.get("plugins_workspace_installations", installationId);
		if (!installation) throw new Error("Expected the plugin fixture installation");
		const pluginVersionId = installation.pluginVersionId;
		const pluginName = `review-${args.tag}-${i}`;
		const pluginTenant = { ...tenant, installationId, pluginName };
		// The reused helper names its plugin gallery. Distinct names keep one install per name.
		const acceptedCapabilities = [
			"workspace.files.read",
			"workspace.files.write",
			"workspace.files.own-write",
			"workspace.files.own-access",
			"plugin.secrets.read",
			"plugin.data.read",
			"plugin.data.write",
			"plugin.data.user-write",
			"plugin.service.connect",
		] as const;
		await ctx.db.patch("plugins_workspace_installations", installationId, {
			pluginName,
			acceptedCapabilities: [...acceptedCapabilities],
		});
		await ctx.db.patch("plugins_versions", pluginVersionId, {
			name: pluginName,
			capabilities: [...acceptedCapabilities],
			events: [{ type: "files.upload.completed", contentTypes: ["image/png"], filters: [] }],
			backendEntrypointFile: {
				entry: "worker.js",
				moduleName: "plugin.js",
				r2Key: `plugins/${pluginName}/worker.js`,
				sha256: `sha256:${"b".repeat(64)}`,
				compatibilityDate: "2026-07-01",
				compatibilityFlags: [],
			},
		});
		await ctx.db.insert("plugins_workspace_installation_secrets", {
			...pluginTenant,
			name: "REVIEW_KEY",
			ciphertext: new TextEncoder().encode("test").buffer,
			nonce: new TextEncoder().encode("test").buffer,
			valuePreview: "configured",
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_workspace_event_handlers", {
			...pluginTenant,
			pluginVersionId,
			event: "files.upload.completed",
			contentType: "image/png",
			installationCreatedAt: now,
			updatedAt: now,
		});
		const memberUsageId = await ctx.db.insert("plugins_data_member_usage", {
			...tenant,
			installationId,
			userId: args.userId,
			generation: "document_bound",
			usedBytes: 16,
			usedDocuments: 2,
			machineBytes: 0,
			collectionNames: ["messages"],
		});
		await ctx.db.insert("plugins_data", {
			...pluginTenant,
			collection: "messages",
			key: "live",
			value: { text: "hello" },
			byteSize: 16,
			revision: 1,
			writeMode: "normal",
			ownership: "shared",
			chargedTo: args.userId,
			chargedToMemberUsageId: memberUsageId,
			machineBytes: 0,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_data_usage", {
			...pluginTenant,
			usedBytes: 16,
			reservedBytes: 1000,
			usedDocuments: 1,
			reservedDocuments: 1,
			tombstoneDocuments: 2,
			collectionNames: ["messages"],
			updatedAt: now,
		});
		await ctx.db.insert("plugins_data_append_replay_receipts", {
			...pluginTenant,
			collection: "messages",
			createdBy: args.userId,
			requestId: `deleted-${i}`,
			requestFingerprint: `deleted-${i}`,
			result: { key: `deleted-${i}`, revision: 1, byteSize: 16 },
			memberUsageId,
			expiresAt: now + 86_400_000,
		});
		await ctx.db.insert("plugins_data_reservations", {
			...pluginTenant,
			collection: "messages",
			key: "reserved",
			ownerPrincipalKey: `plugin_service:${args.tag}-${i}`,
			maximumBytes: 1000,
			remainingBytes: 1000,
			state: "live",
			holdsUsageTombstoneSlot: false,
			idempotencyKey: "reserve",
			requestFingerprint: "reserve",
			expiresAt: now + 60_000,
			retryHorizonExpiresAt: now + 86_400_000,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_data_revision_tombstones", {
			...pluginTenant,
			collection: "messages",
			key: "removed",
			revision: 4,
			producerPrincipalKey: `plugin_service:${args.tag}-${i}`,
			deletedAt: now,
			expiresAt: now + 86_400_000,
		});
		await ctx.db.insert("plugin_service_grants", {
			...pluginTenant,
			pluginVersionId,
			actorUserId: args.userId,
			tokenHash: `service-${args.tag}-${i}`,
			scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			principalKey: `plugin_service:${args.tag}-${i}`,
			phase: "processing",
			destinationPathPrefix: `/service-${i}/`,
			expiresAt: now + 86_400_000,
			updatedAt: now,
		});
		const scopeId = `private-${i}`;
		await ctx.db.insert("plugins_data_scopes", {
			...tenant,
			installationId,
			scopeId,
			collection: "messages",
			keyPrefix: "private/",
			createdByUserId: args.userId,
			createdAt: now,
			updatedAt: now,
			lastAppend: null,
			appendSequence: 0,
		});
		await ctx.db.insert("plugins_data_released_scope_ranges", {
			...tenant,
			installationId,
			scopeId,
			collectionName: "",
			keyPrefix: "",
		});
		await ctx.db.insert("plugins_data_released_scope_ranges", {
			...tenant,
			installationId,
			scopeId: `old-${i}`,
			collectionName: "messages",
			keyPrefix: "old/",
		});
		await ctx.db.insert("plugins_file_access_bindings", {
			...tenant,
			installationId,
			scopeId,
			nodeId: node._id,
			updatedAt: now,
		});
		await ctx.db.patch("files_nodes", node._id, { restrictedScopeNodeId: node._id });
		await ctx.db.insert("access_control_permission_grants", {
			...tenant,
			resourceKind: "plugin_scope",
			resourceId: `${installationId}:${scopeId}`,
			principalKind: "user",
			userId: args.userId,
			permission: "content.read",
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert("access_control_permission_grants", {
			...tenant,
			resourceKind: "file",
			resourceId: String(node._id),
			principalKind: "user",
			userId: args.userId,
			permission: "content.read",
			createdAt: now,
			updatedAt: now,
		});
		const runId = await ctx.db.insert("plugins_event_runs", {
			...tenant,
			assetId: node.assetId,
			fileNodeId: node._id,
			actorUserId: args.userId,
			installationId,
			pluginVersionId,
			event: "files.upload.completed",
			eventId: `review-${args.tag}-${i}`,
			status: "succeeded",
			acceptedCapabilities: ["workspace.files.read"],
			expiresAt: now + 1_800_000,
			apiCallCount: 1,
			outputWriteCount: 1,
			errorMessage: null,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_event_run_calls", {
			...tenant,
			runId,
			installationId,
			pluginVersionId,
			sequence: 1,
			kind: "api_request",
			route: "/api/v1/files/read",
			status: "succeeded",
			responseStatus: 200,
			requestBytes: 12,
			errorMessage: null,
			startedAt: now,
			finishedAt: now,
			elapsedMs: 0,
			updatedAt: now,
		});
		await ctx.db.insert("activities", {
			...tenant,
			userId: args.userId,
			status: "succeeded",
			source: { type: "plugin_run", id: runId, installationId, pluginName },
			title: `Review ${i}`,
			errorMessage: null,
			targets: [],
			timeoutAt: now + 60_000,
			finishedAt: now,
			archivedAt: 0,
			updatedAt: now,
		});
		const destinationNodeId = await ctx.db.insert("files_nodes", {
			...tenant,
			path: `/service-${i}`,
			treePath: `/service-${i}`,
			pathDepth: 1,
			name: `service-${i}`,
			kind: "folder",
			lowercaseExtension: null,
			parentId: "root",
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
			contentType: null,
			assetId: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			readOnlyScopeNodeId: null,
			readOnlyPluginName: null,
			readOnlyPluginServiceTargetId: null,
			archiveOperationId: null,
		});
		const uploadAssetId = await ctx.db.insert("files_r2_assets", {
			...tenant,
			kind: "upload",
			r2Bucket: "test-bucket",
			size: 10,
			createdBy: args.userId,
			updatedAt: now,
			uploadUrlExpiresAt: now + 60_000,
		});
		const uploadNodeId = await ctx.db.insert("files_nodes", {
			...tenant,
			path: `/service-${i}/image.png`,
			treePath: `/service-${i}/image.png`,
			pathDepth: 2,
			name: "image.png",
			kind: "file",
			lowercaseExtension: "png",
			parentId: destinationNodeId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
			assetId: uploadAssetId,
			contentType: "image/png",
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: null,
			readOnlyScopeNodeId: null,
			readOnlyPluginName: null,
			readOnlyPluginServiceTargetId: null,
			archiveOperationId: null,
		});
		await ctx.db.insert("plugin_service_storage_destinations", {
			...tenant,
			installationId,
			destinationPath: `/service-${i}`,
			currentEpoch: 1,
			closedEpoch: 0,
			updatedAt: now,
		});
		const uploadTargetId = await ctx.db.insert("plugin_service_storage_targets", {
			...tenant,
			installationId,
			idempotencyKey: "upload",
			targetKey: "image",
			requestFingerprint: "upload",
			readOnly: false,
			nonCollaborative: false,
			destinationPath: `/service-${i}`,
			destinationNodeId,
			destinationEpoch: 1,
			path: `/service-${i}/image.png`,
			contentType: "image/png",
			declaredBytes: 10,
			actualBytes: null,
			chargedBytes: 0,
			nodeId: uploadNodeId,
			assetId: uploadAssetId,
			state: "pending",
			createdBy: args.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugin_service_storage_attempts", {
			...tenant,
			targetId: uploadTargetId,
			assetId: uploadAssetId,
		});
		const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
			...tenant,
			kind: "yjs_snapshot",
			r2Bucket: "test-bucket",
			size: 12,
			createdBy: args.userId,
			updatedAt: now,
		});
		const contentSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
			...tenant,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: 12,
			createdBy: args.userId,
			updatedAt: now,
		});
		await ctx.db.insert("public_api_file_write_stages", {
			...tenant,
			userId: args.userId,
			runId,
			path: `/staged-${i}.md`,
			overwrite: "replace",
			contentType: "text/markdown",
			yjsRootKind: "rich_text",
			yjsSnapshotAssetId,
			contentSnapshotAssetId,
			expiresAt: now + 900_000,
			updatedAt: now,
		});
	}
	return { nodes: nodes.map((node) => node._id) };
}

async function review_seed_user_publisher_docs(ctx: MutationCtx, userId: Id<"users">, tag: string) {
	for (let i = 0; i < 2; i += 1) {
		const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
			ownerUserId: userId,
			repositoryUrl: `https://github.com/review/${tag}-${i}`,
			owner: "review",
			repo: `${tag}-${i}`,
		});
		await ctx.db.insert("plugins_publisher_repository_secrets", {
			ownerUserId: userId,
			repositoryId,
			name: "REVIEW_KEY",
			ciphertext: new TextEncoder().encode("test").buffer,
			nonce: new TextEncoder().encode("test").buffer,
			valuePreview: "configured",
			updatedAt: Date.now(),
		});
		await ctx.db.insert("plugins_version_reviews", {
			createdBy: userId,
			artifactHash: `sha256:${String(i).repeat(64)}`,
			reviewSubjectHash: `${tag}-${i}`,
			reviewPolicyVersion: "1",
			pluginName: `${tag}-${i}`,
			version: "0.1.0",
			status: "passed",
			mechanicalFindings: [],
			mechanicalAdvisoryFindings: [],
			aiFindings: [],
			capabilityMap: [],
			model: "none",
			updatedAt: Date.now(),
		});
	}
}

// Capture exact IDs BEFORE running any deletion. Child-only rows cannot be found through deleted parents.
// A fixture should be alone in its convex-test database, except for explicit untouched controls.
async function review_capture_workspace_rows(
	ctx: MutationCtx,
	organizationId: Id<"organizations">,
	workspaceId: Id<"organizations_workspaces">,
) {
	const pendingIds = new Set(
		(await ctx.db.query("files_pending_updates").collect())
			.filter((row) => row.organizationId === organizationId && row.workspaceId === workspaceId)
			.map((row) => row._id),
	);
	return await Promise.all(
		review_workspace_tables.map(async (table) => {
			const rows = await ctx.db.query(table).collect();
			const ids = rows
				.filter((row) =>
					"pendingUpdateId" in row && !("workspaceId" in row)
						? pendingIds.has(row.pendingUpdateId)
						: "organizationId" in row &&
							"workspaceId" in row &&
							row.organizationId === organizationId &&
							row.workspaceId === workspaceId,
				)
				.map((row) => row._id);
			return { table, ids };
		}),
	);
}

async function review_count_original_rows(
	ctx: MutationCtx,
	inventory: Awaited<ReturnType<typeof review_capture_workspace_rows>>,
) {
	return await Promise.all(
		inventory.map(async ({ table, ids }) => ({
			table,
			count: (await Promise.all(ids.map((id) => ctx.db.get(table, id)))).filter((row) => row !== null).length,
		})),
	);
}

async function review_seed_two_shared_memberships(ctx: MutationCtx, userId: Id<"users">) {
	const other = await data_deletion_test_bootstrap_user(ctx, { clerkUserId: null, displayName: "Surviving owner" });
	const organization = await organizations_db_create(ctx, {
		userId: other.userId,
		name: "review-shared",
		description: "",
		now: Date.now(),
		default: false,
	});
	if (organization._nay) throw new Error(organization._nay.message);
	const extra = await organizations_db_create_workspace(ctx, {
		userId: other.userId,
		organizationId: organization._yay.organizationId,
		name: "review-extra",
		description: "",
		now: Date.now(),
	});
	if (extra._nay) throw new Error(extra._nay.message);
	for (const workspaceId of [organization._yay.defaultWorkspaceId, extra._yay.workspaceId]) {
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: organization._yay.organizationId,
			workspaceId,
			userId,
			active: true,
			updatedAt: Date.now(),
		});
		await quotas_db_ensure(ctx, {
			quotaName: "active_api_credentials",
			organizationId: organization._yay.organizationId,
			workspaceId,
			userId,
			now: Date.now(),
		});
		await ctx.db.insert("access_control_role_assignments", {
			organizationId: organization._yay.organizationId,
			workspaceId,
			userId,
			role: workspaceId === organization._yay.defaultWorkspaceId ? "member" : "viewer",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await ctx.db.insert("notifications", {
			organizationId: organization._yay.organizationId,
			workspaceId,
			userId,
			actorUserId: other.userId,
			kind: "organization_workspace_invite",
			archivedAt: 0,
			updatedAt: Date.now(),
		});
	}
	await test_mocks_cancel_pending_home_file_seeds(ctx);
	return { other, organizationId: organization._yay.organizationId };
}

const review_user_tables = [
	"plugins_ui_sessions",
	"plugins_publisher_repository_secrets",
	"plugins_publisher_repositories",
	"plugins_version_reviews",
	"notifications",
	"access_control_permission_grants",
	"plugin_service_grants",
	"organizations_workspaces_users",
	"access_control_role_assignments",
	"files_pending_updates",
	"files_pending_updates_last_sequence_saved",
	"files_pending_update_yjs_states",
	"files_pending_update_text_inputs",
	"files_pending_update_operation_batches",
	"files_yjs_trusted_update_stages",
	"plugins_data_append_replay_receipts",
	"plugins_data_member_usage",
	"quotas",
	"api_credentials",
	"public_api_grants",
] as const;

async function review_capture_user_rows(ctx: MutationCtx, userId: Id<"users">) {
	return await Promise.all(
		review_user_tables.map(async (table) => ({
			table,
			ids: (await ctx.db.query(table).collect())
				.filter(
					(row) =>
						("userId" in row && row.userId === userId) ||
						("ownerUserId" in row && row.ownerUserId === userId) ||
						((table === "plugins_version_reviews" || table === "plugins_data_append_replay_receipts") &&
							"createdBy" in row &&
							row.createdBy === userId) ||
						(table === "plugin_service_grants" && "actorUserId" in row && row.actorUserId === userId),
				)
				.map((row) => row._id),
		})),
	);
}

async function review_assert_user_rows_gone(
	t: ReturnType<typeof test_convex>,
	rows: Awaited<ReturnType<typeof review_capture_user_rows>>,
) {
	const remaining = await t.run(
		async (ctx) =>
			await Promise.all(
				rows.map(async ({ table, ids }) => ({
					table,
					count: (await Promise.all(ids.map((id) => ctx.db.get(table, id)))).filter((row) => row !== null).length,
				})),
			),
	);
	expect(remaining.filter((row) => row.count > 0)).toEqual([]);
}

// Queue and admin use the same complete user fixture, then the tenant worker purges content.
// Count both user-local passes and Workpool action windows. Assert every action window <=25.
for (const path of ["queue", "admin"] as const) {
	test(`finishes every ${path} family with batch size one`, async () => {
		const t = test_convex({ transactionLimits: true });
		vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
		const seeded = await t.run(async (ctx) => {
			const user = await data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: `Every ${path} family`,
			});
			const shared = await review_seed_two_shared_memberships(ctx, user.userId);
			await review_seed_all_workspace_content(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				tag: path,
			});
			await review_seed_user_publisher_docs(ctx, user.userId, path);
			const tokenId = await ctx.db.insert("users_anon_tokens", {
				userId: user.userId,
				token: "test-only-token",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", user.userId, { anonymousAuthToken: tokenId });
			const billingId = await ctx.db.insert("billing_usage_snapshots", {
				userId: user.userId,
				polarCustomerId: "test-only-customer",
				subscription: null,
				meter: null,
				lastSyncedAt: Date.now(),
			});
			return {
				user,
				shared,
				tokenId,
				billingId,
				workspaceRows: await review_capture_workspace_rows(ctx, user.defaultOrganizationId, user.defaultWorkspaceId),
				userRows: await review_capture_user_rows(ctx, user.userId),
			};
		});
		for (const row of [...seeded.workspaceRows, ...seeded.userRows])
			expect(row.ids.length, row.table).toBeGreaterThanOrEqual(2);
		let preparePasses = 0;
		let finalizationPasses = 0;
		if (path === "queue") {
			await t.mutation(internal.data_deletion.init_user_deletion, { userId: seeded.user.userId });
			await t.run(async (ctx) => {
				const request = await ctx.db
					.query("data_deletion_requests")
					.withIndex("by_user_scope", (q) => q.eq("userId", seeded.user.userId).eq("scope", "user"))
					.first();
				if (!request) throw new Error("Expected the user deletion request");
				await ctx.db.patch("data_deletion_requests", request._id, { eligibleAt: Date.now() });
			});
		} else {
			for (; preparePasses < 500; preparePasses += 1) {
				if (
					await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
						userId: seeded.user.userId,
						_test_batchSize: 1,
					})
				) {
					preparePasses += 1;
					break;
				}
			}
			expect(preparePasses).toBeLessThan(500);
			for (; finalizationPasses < 500; finalizationPasses += 1) {
				if (
					await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
						userId: seeded.user.userId,
						deleteUserAuth: true,
						deleteBillingState: true,
						deleteUserRecord: true,
						_test_batchSize: 1,
						_test_disableReschedule: true,
					})
				) {
					finalizationPasses += 1;
					break;
				}
			}
			expect(finalizationPasses).toBeLessThan(500);
		}
		let actions = 0;
		let steps = 0;
		let sawReschedule = false;
		for (; actions < 100; actions += 1) {
			const result = await t.action(internal.data_deletion.process_deletion_requests, {
				_test_batchSize: 1,
				_test_disableReschedule: true,
			});
			expect(result.steps).toBeLessThanOrEqual(25);
			steps += result.steps;
			sawReschedule ||= result.shouldReschedule;
			if (!result.shouldReschedule) {
				actions += 1;
				break;
			}
		}
		expect(actions).toBeLessThan(100);
		expect(sawReschedule).toBe(true);
		await review_assert_user_rows_gone(t, seeded.userRows);
		expect(
			(await t.run((ctx) => review_count_original_rows(ctx, seeded.workspaceRows))).filter((row) => row.count > 0),
		).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("data_deletion_requests").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get("organizations", seeded.shared.organizationId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("users_anon_tokens", seeded.tokenId))).toEqual(
			path === "admin" ? null : expect.any(Object),
		);
		expect(await t.run((ctx) => ctx.db.get("billing_usage_snapshots", seeded.billingId))).toEqual(
			path === "admin" ? null : expect.any(Object),
		);
		console.info("Review path counts", { path, preparePasses, finalizationPasses, actions, steps });
	});
}

// Workspace is content-only by contract. Organization and reset also exercise structure cleanup.
for (const path of ["workspace", "organization", "reset"] as const) {
	test(`finishes every ${path} content family with batch size one`, async () => {
		const t = test_convex({ transactionLimits: true });
		vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
		const seeded = await t.run(async (ctx) => {
			const user = await data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: `Every ${path} family`,
			});
			let organizationId = user.defaultOrganizationId;
			let workspaceId = user.defaultWorkspaceId;
			if (path === "organization") {
				const organization = await organizations_db_create(ctx, {
					userId: user.userId,
					name: "review-org",
					description: "",
					now: Date.now(),
					default: false,
				});
				if (organization._nay) throw new Error(organization._nay.message);
				organizationId = organization._yay.organizationId;
				workspaceId = organization._yay.defaultWorkspaceId;
			}
			if (path === "workspace") {
				const extra = await organizations_db_create_workspace(ctx, {
					userId: user.userId,
					organizationId,
					name: "review-ws",
					description: "",
					now: Date.now(),
				});
				if (extra._nay) throw new Error(extra._nay.message);
				workspaceId = extra._yay.workspaceId;
			}
			await review_seed_all_workspace_content(ctx, { userId: user.userId, organizationId, workspaceId, tag: path });
			const inventory = await review_capture_workspace_rows(ctx, organizationId, workspaceId);
			const requestId =
				path === "reset"
					? null
					: await data_deletion_db_request(ctx, {
							userId: user.userId,
							organizationId,
							...(path === "workspace" ? { workspaceId } : {}),
							scope: path,
						});
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return { user, organizationId, workspaceId, inventory, requestId };
		});
		for (const row of seeded.inventory) expect(row.ids.length, row.table).toBeGreaterThanOrEqual(2);
		let done = false;
		let passes = 0;
		for (; passes < 1000; passes += 1) {
			const result =
				path === "reset"
					? await t.mutation(internal.data_deletion.hard_delete_user_data, {
							userId: seeded.user.userId,
							_test_batchSize: 1,
						})
					: path === "organization"
						? await t.mutation(internal.data_deletion.process_organization_deletion_request, {
								requestId: seeded.requestId!,
								_test_batchSize: 1,
							})
						: await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
								requestId: seeded.requestId!,
								_test_batchSize: 1,
							});
			if (result.done) {
				done = true;
				passes += 1;
				break;
			}
		}
		expect(done).toBe(true);
		expect(passes).toBeGreaterThan(25);
		expect(
			(await t.run((ctx) => review_count_original_rows(ctx, seeded.inventory))).filter((row) => row.count > 0),
		).toEqual([]);
		const budgetRows = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", seeded.workspaceId))
					.collect()
			).filter(
				(row) => row.quotaName === "public_api_upload_bytes" || row.quotaName === "plugin_service_storage_bytes",
			),
		);
		expect(budgetRows).toEqual([]);
		if (path === "organization")
			expect(await t.run((ctx) => ctx.db.get("organizations", seeded.organizationId))).toBeNull();
		if (path === "reset") {
			const workspace = await t.run((ctx) => ctx.db.get("organizations_workspaces", seeded.workspaceId));
			expect(workspace).not.toBeNull();
			expect(workspace?.pluginDataPurgeStartedAt).toBeUndefined();
		}
		console.info("Review path counts", { path, passes });
	});
}

async function review_seed_organization_structure(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		ownerUserId: Id<"users">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
	},
) {
	const now = Date.now();
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization || organization.default) throw new Error("Expected a non-default fixture organization");
	const extra = await organizations_db_create_workspace(ctx, {
		userId: args.ownerUserId,
		organizationId: args.organizationId,
		name: "structure-extra",
		description: "",
		now,
	});
	if (extra._nay) throw new Error(extra._nay.message);
	for (let i = 0; i < 2; i += 1) {
		const user = await data_deletion_test_bootstrap_user(ctx, {
			clerkUserId: `review-structure-${i}`,
			displayName: `Retained member ${i}`,
		});
		for (const workspaceId of [args.defaultWorkspaceId, extra._yay.workspaceId]) {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: args.organizationId,
				workspaceId,
				userId: user.userId,
				active: true,
				updatedAt: now,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				organizationId: args.organizationId,
				workspaceId,
				userId: user.userId,
				now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: args.organizationId,
				workspaceId,
				userId: user.userId,
				role: workspaceId === args.defaultWorkspaceId ? "member" : "viewer",
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("notifications", {
				organizationId: args.organizationId,
				workspaceId,
				userId: user.userId,
				actorUserId: args.ownerUserId,
				kind: "organization_workspace_invite",
				archivedAt: 0,
				updatedAt: now,
			});
		}
		await ctx.runMutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		await ctx.db.insert("access_control_roles", {
			organizationId: args.organizationId,
			name: `Review role ${i}`,
			normalizedName: `review role ${i}`,
			description: "",
			permissions: ["content.read"],
			createdBy: args.ownerUserId,
			createdAt: now,
			updatedAt: now,
		});
	}
	await test_mocks_cancel_pending_home_file_seeds(ctx);
	return extra._yay.workspaceId;
}

const review_structure_tables = [
	"organizations_workspaces",
	"organizations_workspaces_users",
	"notifications",
	"quotas",
	"access_control_role_assignments",
	"access_control_roles",
	"access_control_permission_grants",
] as const;

async function review_capture_organization_structure(ctx: MutationCtx, organizationId: Id<"organizations">) {
	return await Promise.all(
		review_structure_tables.map(async (table) => ({
			table,
			ids: (await ctx.db.query(table).collect())
				.filter((row) => row.organizationId === organizationId)
				.map((row) => row._id),
		})),
	);
}

describe("organization structure at batch size one", () => {
	for (const path of ["organization", "reset"] as const) {
		test(`finishes ${path} structure with retained members`, async () => {
			const t = test_convex({ transactionLimits: true });
			vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
			const seeded = await t.run(async (ctx) => {
				const user = await data_deletion_test_bootstrap_user(ctx, {
					clerkUserId: null,
					displayName: "Structure owner",
				});
				const created = await organizations_db_create(ctx, {
					userId: user.userId,
					name: "structure-org",
					description: "",
					now: Date.now(),
				});
				if (created._nay) throw new Error(created._nay.message);
				const { organizationId, defaultWorkspaceId } = created._yay;
				const extraWorkspaceId = await review_seed_organization_structure(ctx, {
					organizationId,
					defaultWorkspaceId,
					ownerUserId: user.userId,
				});
				const workspaceRows = [];
				for (const [index, workspaceId] of [defaultWorkspaceId, extraWorkspaceId].entries()) {
					await review_seed_all_workspace_content(ctx, {
						organizationId,
						workspaceId,
						userId: user.userId,
						tag: `structure-${index}`,
					});
					workspaceRows.push(...(await review_capture_workspace_rows(ctx, organizationId, workspaceId)));
				}
				const structure = await review_capture_organization_structure(ctx, organizationId);
				const retainedRequests = await ctx.db
					.query("data_deletion_requests")
					.withIndex("by_scope_eligibleAt", (q) => q.eq("scope", "user"))
					.collect();
				const requestId =
					path === "organization"
						? await data_deletion_db_request(ctx, {
								userId: user.userId,
								organizationId,
								scope: "organization",
								eligibleAt: Date.now(),
							})
						: null;
				return { user, organizationId, workspaceRows, structure, retainedRequests, requestId };
			});
			for (const family of [...seeded.workspaceRows, ...seeded.structure]) {
				expect(family.ids.length, family.table).toBeGreaterThanOrEqual(2);
			}
			for (const quotaName of ["public_api_upload_bytes", "plugin_service_storage_bytes"] as const) {
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("quotas")
							.withIndex("by_organization_quotaName", (q) =>
								q.eq("organizationId", seeded.organizationId).eq("quotaName", quotaName),
							)
							.collect(),
					),
				).toHaveLength(2);
			}
			let done = false;
			let passes = 0;
			for (; passes < 1000 && !done; passes += 1) {
				const result =
					path === "reset"
						? await t.mutation(internal.data_deletion.hard_delete_user_data, {
								userId: seeded.user.userId,
								_test_batchSize: 1,
							})
						: await t.mutation(internal.data_deletion.process_organization_deletion_request, {
								requestId: seeded.requestId!,
								_test_batchSize: 1,
							});
				done = result.done;
			}
			expect(done).toBe(true);
			expect(passes).toBeGreaterThan(25);
			expect(
				(await t.run((ctx) => review_count_original_rows(ctx, seeded.workspaceRows))).filter(
					(family) => family.count > 0,
				),
			).toEqual([]);
			const remainingStructure = await t.run(async (ctx) =>
				Promise.all(
					seeded.structure.map(async ({ table, ids }) => ({
						table,
						count: (await Promise.all(ids.map((id) => ctx.db.get(table, id)))).filter(Boolean).length,
					})),
				),
			);
			expect(remainingStructure.filter((family) => family.count > 0)).toEqual([]);
			expect(seeded.retainedRequests).toHaveLength(2);
			for (const request of seeded.retainedRequests) {
				expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", request._id))).toEqual(request);
				expect((await t.run((ctx) => ctx.db.get("users", request.userId)))?.deletedAt).toBeTypeOf("number");
			}
			expect(await t.run((ctx) => ctx.db.get("organizations", seeded.organizationId))).toBeNull();
			if (path === "reset") {
				expect((await t.run((ctx) => ctx.db.get("users", seeded.user.userId)))?.defaultWorkspaceId).toBe(
					seeded.user.defaultWorkspaceId,
				);
			}
			console.info("Review structure counts", { path, passes });
		});
	}
});

async function finish_review_jobs(t: ReturnType<typeof test_convex>) {
	for (let pass = 0; pass < 75; pass += 1) {
		vi.advanceTimersByTime(1000);
		await t.finishInProgressScheduledFunctions();
	}
}

describe("hard_delete_user_now", () => {
	test("continues preparation after 25 batches before calling Clerk", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-review-prepare",
				displayName: "Review prepare",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				sessionCount: 30,
			}),
		);
		const fetchMock = vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));
		await t.action(internal.users.hard_delete_user_now, {
			userId: user.userId,
			purgeUserMod: "data_and_auth",
			_test_batchSize: 1,
		});
		const first = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			sessions: await ctx.db.query("plugins_ui_sessions").collect(),
			jobs: (await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.state.kind === "pending" && job.name.includes("hard_delete_user_now"),
			),
		}));
		expect(first.sessions).toHaveLength(5);
		expect(first.jobs).toHaveLength(1);
		expect(first.jobs[0].args).toEqual([{ userId: user.userId, purgeUserMod: "data_and_auth" }]);
		expect(first.user?.deletionFinalizationStartedAt).toBeTypeOf("number");
		expect(first.user?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(fetchMock).not.toHaveBeenCalled();
		await finish_review_jobs(t);
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			sessions: await ctx.db.query("plugins_ui_sessions").collect(),
		}));
		expect(after.sessions).toHaveLength(0);
		expect(after.user?.deletionFinalizationStartedAt).toBeUndefined();
		expect(after.user?.clerkUserId).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.clerk.com/v1/users/clerk-review-prepare",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	test("continues finalization after 25 batches and clears the fence", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, { clerkUserId: null, displayName: "Review finalization" }),
		);
		await t.run(async (ctx) => {
			for (let i = 0; i < 30; i += 1) {
				const file = await data_deletion_test_seed_page(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					tag: `sequence-${i}`,
				});
				await ctx.db.insert("files_pending_updates_last_sequence_saved", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					fileNodeId: file.nodeId,
					lastSequenceSaved: 1,
					updatedAt: Date.now(),
				});
			}
		});
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
		await t.action(internal.users.hard_delete_user_now, {
			userId: user.userId,
			purgeUserMod: "data_and_auth",
			_test_batchSize: 1,
		});
		const first = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			sequences: await ctx.db.query("files_pending_updates_last_sequence_saved").collect(),
			jobs: (await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.state.kind === "pending" && job.name.includes("hard_delete_user_now"),
			),
		}));
		expect(first.sequences).toHaveLength(6);
		expect(first.jobs).toHaveLength(1);
		expect(first.user?.deletionFinalizationStartedAt).toBeTypeOf("number");
		await finish_review_jobs(t);
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			sequences: await ctx.db.query("files_pending_updates_last_sequence_saved").collect(),
		}));
		expect(after.sequences).toHaveLength(0);
		expect(after.user?.deletionFinalizationStartedAt).toBeUndefined();
		expect(after.user?.defaultWorkspaceId).toBeUndefined();
	});
});

describe("anonymous auth finalization", () => {
	test("removes auth and billing docs when a tombstone is purged early", async () => {
		const t = test_convex({ transactionLimits: true });
		await t.run(async (ctx) => {
			const seedUser = await ctx.db.insert("users", { clerkUserId: null });
			await test_mocks_fill_db_with.plan(ctx, { userId: seedUser, plan: "Free" });
		});
		const user = await t.mutation(internal.users.create_anonymous_user, {});
		await t.run(test_mocks_cancel_pending_home_file_seeds);
		const requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		if (!requestId) throw new Error("Expected the user deletion request");
		await t.mutation(internal.users.purge_deleted_user_tombstone, { userId: user.userId });
		const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));
		if (!request) throw new Error("Expected the retained user deletion request");
		vi.setSystemTime(request.eligibleAt);
		let done = false;
		for (let pass = 0; pass < 30 && !done; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("users", user.userId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).toBeNull();
		expect(
			await t.query(internal.users.get_with_anagraphic_and_anonymous_auth_token, {
				userId: user.userId,
				tokenId: user.tokenId,
			}),
		).toBeNull();
		const after = await t.run(async (ctx) => ({
			tokens: (
				await ctx.db
					.query("users_anon_tokens")
					.withIndex("by_user", (q) => q.eq("userId", user.userId))
					.collect()
			).length,
			snapshots: (
				await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", user.userId))
					.collect()
			).length,
		}));
		expect(after).toEqual({ tokens: 0, snapshots: 0 });
	});

	for (const userRecord of ["retained", "missing"] as const) {
		test(`removes auth and billing after finalizing a ${userRecord} user record`, async () => {
			const t = test_convex({ transactionLimits: true });
			await t.run(async (ctx) => {
				const seedUser = await ctx.db.insert("users", { clerkUserId: null });
				await test_mocks_fill_db_with.plan(ctx, { userId: seedUser, plan: "Free" });
			});
			const user = await t.mutation(internal.users.create_anonymous_user, {});
			await t.run(test_mocks_cancel_pending_home_file_seeds);
			const requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
			if (!requestId) throw new Error("Expected the user deletion request");
			const billingSnapshot = await t.run((ctx) =>
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", user.userId))
					.first(),
			);
			if (!billingSnapshot) throw new Error("Expected the anonymous billing snapshot");
			if (userRecord === "missing") {
				// This is the state left by the old tombstone purge before its queued request ran.
				await t.run(async (ctx) => {
					const tombstone = await ctx.db.get("users", user.userId);
					if (!tombstone?.anagraphic) throw new Error("Expected the deleted user's profile");
					await ctx.db.delete("users_anagraphics", tombstone.anagraphic);
					await ctx.db.delete("users", user.userId);
				});
			}
			const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));
			if (!request) throw new Error("Expected the retained deletion request");
			vi.setSystemTime(request.eligibleAt);
			let done = false;
			for (let pass = 0; pass < 30 && !done; pass += 1) {
				const result = await t.mutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_batchSize: 1,
				});
				done = result.done;
			}
			expect(done).toBe(true);
			expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).toBeNull();
			if (userRecord === "retained") {
				expect(await t.run((ctx) => ctx.db.get("users_anon_tokens", user.tokenId))).not.toBeNull();
				expect(await t.run((ctx) => ctx.db.get("billing_usage_snapshots", billingSnapshot._id))).not.toBeNull();
				await t.mutation(internal.users.purge_deleted_user_tombstone, { userId: user.userId });
				await t.mutation(internal.users.purge_deleted_user_tombstone, { userId: user.userId });
			}
			expect(await t.run((ctx) => ctx.db.get("users", user.userId))).toBeNull();
			expect(await t.run((ctx) => ctx.db.get("users_anon_tokens", user.tokenId))).toBeNull();
			expect(await t.run((ctx) => ctx.db.get("billing_usage_snapshots", billingSnapshot._id))).toBeNull();
		});
	}

	test("keeps rotation in one token doc and deletes it on full purge", async () => {
		const t = test_convex({ transactionLimits: true });
		// The real anonymous bootstrap requires the synced Free product.
		await t.run(async (ctx) => {
			const seedUser = await ctx.db.insert("users", { clerkUserId: null });
			await test_mocks_fill_db_with.plan(ctx, { userId: seedUser, plan: "Free" });
		});
		const user = await t.mutation(internal.users.create_anonymous_user, {});
		await t.run(test_mocks_cancel_pending_home_file_seeds);
		await t.mutation(internal.users.set_anonymous_auth_token, { tokenId: user.tokenId, token: "refresh-1" });
		await t.mutation(internal.users.set_anonymous_auth_token, {
			tokenId: user.tokenId,
			token: "refresh-2",
			expectedCurrentToken: "refresh-1",
		});
		const stale = await t.mutation(internal.users.set_anonymous_auth_token, {
			tokenId: user.tokenId,
			token: "refresh-3",
			expectedCurrentToken: "refresh-1",
		});
		expect(stale).toBe("refresh-2");
		const before = await t.run((ctx) =>
			ctx.db
				.query("users_anon_tokens")
				.withIndex("by_user", (q) => q.eq("userId", user.userId))
				.collect(),
		);
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({ token: "refresh-2", previousToken: "refresh-1" });
		await t.action(internal.users.hard_delete_user_now, {
			userId: user.userId,
			purgeUserMod: "data_auth_and_user_record",
			_test_batchSize: 1,
			_test_disableReschedule: true,
		});
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			token: await ctx.db.get("users_anon_tokens", user.tokenId),
			snapshots: await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", user.userId))
				.collect(),
		}));
		expect(after).toEqual({ user: null, token: null, snapshots: [] });
		expect(
			await t.query(internal.users.get_with_anagraphic_and_anonymous_auth_token, {
				userId: user.userId,
				tokenId: user.tokenId,
			}),
		).toBeNull();
	});
});

// Controls for attack items 5, 6, 8, 9, 10, and 20.
// Uses the existing data_deletion_test_* helpers named in the parent review file.
// These are expected to pass. No assertion below is claimed as a bug reproduction.

describe("ordering review controls", () => {
	test("makes each tenant request eligible once as time moves forward", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "Moving Clock",
			}),
		);
		const startedAt = Date.now();
		const requestIds = await t.run(async (ctx) => {
			const requestIds: Id<"data_deletion_requests">[] = [];
			for (let index = 0; index < 3; index += 1) {
				const workspace = await organizations_db_create_workspace(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					name: `moving-clock-${index}`,
					description: "",
					now: startedAt,
				});
				if (workspace._nay) throw new Error(workspace._nay.message);
				requestIds.push(
					await data_deletion_db_request(ctx, {
						userId: user.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId: workspace._yay.workspaceId,
						scope: "workspace",
						eligibleAt: startedAt + 7 * 24 * 60 * 60 * 1000,
					}),
				);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return requestIds;
		});

		const firstEligibleTimes = new Map<Id<"data_deletion_requests">, number>();
		const futureCounts = new Set<number>();
		let done = false;
		for (let pass = 0; pass < 40 && !done; pass += 1) {
			const now = startedAt + pass * 1000;
			vi.setSystemTime(now);
			done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: user.userId,
				_test_batchSize: 1,
				_test_disableReschedule: true,
			});
			const requests = await t.run((ctx) =>
				Promise.all(requestIds.map((id) => ctx.db.get("data_deletion_requests", id))),
			);
			futureCounts.add(requests.filter((request) => request && request.eligibleAt > now).length);
			for (const request of requests) {
				expect(request).not.toBeNull();
				if (!request) throw new Error("Request disappeared before its tenant purge");
				const firstEligibleTime = firstEligibleTimes.get(request._id);
				if (firstEligibleTime !== undefined) {
					expect(request.eligibleAt).toBe(firstEligibleTime);
				} else if (request.eligibleAt <= now) {
					firstEligibleTimes.set(request._id, request.eligibleAt);
				}
			}
		}
		expect(done).toBe(true);
		expect(firstEligibleTimes.size).toBe(3);
		expect(futureCounts).toEqual(new Set([3, 2, 1, 0]));
	});

	test("a reset cancels a queued finalization between its batches", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "Reset Between Batches",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				sessionCount: 1,
			}),
		);
		const requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		if (!requestId) throw new Error("Deletion request was not created");
		const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));
		if (!request) throw new Error("Deletion request is missing");
		const first = await t.mutation(internal.data_deletion.process_user_deletion_request, {
			requestId,
			_test_batchSize: 1,
			_test_now: request.eligibleAt + 1,
		});
		expect(first).toEqual({ done: false, deletedCount: 1 });
		const beforeReset = await t.run((ctx) => ctx.db.get("users", user.userId));
		expect(beforeReset?.deletionFinalizationStartedAt).toBeDefined();

		let done = false;
		for (let pass = 0; pass < 40 && !done; pass += 1) {
			const reset = await t.mutation(internal.data_deletion.hard_delete_user_data, {
				userId: user.userId,
				_test_batchSize: 1,
			});
			done = reset.done;
			const replay = await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
				_test_now: request.eligibleAt + 1,
			});
			expect(replay).toEqual({ done: true, deletedCount: 0 });
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			workspace: await ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
			request: await ctx.db.get("data_deletion_requests", requestId),
			memberships: await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", user.userId))
				.collect(),
		}));
		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.user?.deletionFinalizationStartedAt).toBeUndefined();
		expect(after.user?.defaultWorkspaceId).toBe(user.defaultWorkspaceId);
		expect(after.workspace?.pluginDataPurgeStartedAt).toBeUndefined();
		expect(after.request).toBeNull();
		expect(after.memberships).toHaveLength(1);
		expect(after.memberships[0]?.active).toBe(true);
	});

	test("charges a fresh anonymous successor once across three workspace batches", async () => {
		const t = test_convex({ transactionLimits: true });
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-shared-owner",
				displayName: "Shared Owner",
				email: "review-shared-owner@example.test",
			}),
		);
		await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: owner.userId, plan: "Free" }));
		// This real bootstrap ensures the quota before the user creates any organization.
		const successor = await t.mutation(internal.users.create_anonymous_user, {});
		const organization = await t.run(async (ctx) => {
			const organization = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "review-successor",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (organization._nay) throw new Error(organization._nay.message);
			for (let index = 0; index < 2; index += 1) {
				const workspace = await organizations_db_create_workspace(ctx, {
					userId: owner.userId,
					organizationId: organization._yay.organizationId,
					name: `successor-${index}`,
					description: "",
					now: Date.now(),
				});
				if (workspace._nay) throw new Error(workspace._nay.message);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return organization._yay;
		});
		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "review-shared-owner",
			external_id: owner.userId,
		});
		const invited = await ownerClient.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: organization.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			userIdToAdd: successor.userId,
		});
		expect(invited._nay).toBeUndefined();
		const initialQuota = await t.run((ctx) =>
			quotas_db_get(ctx, {
				quotaName: "extra_organizations",
				userId: successor.userId,
			}),
		);
		expect(initialQuota.usedCount).toBe(0);

		const prepared = await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
			userId: owner.userId,
			_test_batchSize: 1,
		});
		expect(prepared).toBe(true);
		let done = false;
		let ownerChanges = 0;
		let previousOwnerId = owner.userId;
		for (let pass = 0; pass < 40 && !done; pass += 1) {
			done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: owner.userId,
				deleteUserAuth: true,
				_test_batchSize: 1,
				_test_disableReschedule: true,
			});
			const current = await t.run((ctx) => ctx.db.get("organizations", organization.organizationId));
			if (!current) throw new Error("Shared organization was deleted");
			if (current.ownerUserId !== previousOwnerId) {
				ownerChanges += 1;
				previousOwnerId = current.ownerUserId;
			}
		}
		expect(done).toBe(true);
		expect(ownerChanges).toBe(1);
		const after = await t.run(async (ctx) => ({
			organization: await ctx.db.get("organizations", organization.organizationId),
			quota: await quotas_db_get(ctx, { quotaName: "extra_organizations", userId: successor.userId }),
			requests: await ctx.db
				.query("data_deletion_requests")
				.withIndex("by_organization_scope", (q) =>
					q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
				)
				.collect(),
			roles: await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_user_workspace", (q) =>
					q.eq("organizationId", organization.organizationId).eq("userId", successor.userId),
				)
				.collect(),
		}));
		expect(after.organization?.ownerUserId).toBe(successor.userId);
		expect(after.organization?.billingMode).toBe("user");
		expect(after.quota.usedCount).toBe(1);
		expect(after.requests).toHaveLength(0);
		expect(after.roles).toHaveLength(0);
	});

	test("early tombstone purge leaves no active ghost membership", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "Early Tombstone Purge",
			}),
		);
		const requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		if (!requestId) throw new Error("Deletion request was not created");
		const inactive = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", user.userId))
				.collect(),
		);
		expect(inactive).toHaveLength(1);
		expect(inactive.every((membership) => membership.active === false)).toBe(true);
		await t.mutation(internal.users.purge_deleted_user_tombstone, { userId: user.userId });
		const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));
		if (!request) throw new Error("Deletion request is missing");
		let done = false;
		for (let pass = 0; pass < 30 && !done; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
				_test_now: request.eligibleAt + 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			memberships: await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", user.userId))
				.collect(),
			requests: await ctx.db
				.query("data_deletion_requests")
				.withIndex("by_organization_scope", (q) =>
					q.eq("organizationId", user.defaultOrganizationId).eq("scope", "organization"),
				)
				.collect(),
			userRequest: await ctx.db.get("data_deletion_requests", requestId),
		}));
		expect(after.memberships).toHaveLength(0);
		expect(after.requests).toHaveLength(1);
		expect(after.userRequest).toBeNull();
	});
});

// Proposed additions to data_deletion.review.test.ts. Root owns that file.
// These are cleared-item probes. No assertion is expected to fail on current code.
// Use the original file's beforeEach/afterEach fake timers and imported helpers.

describe("review: notification producer during account deletion", () => {
	test("refuses a new invite after the recipient notification drain", async () => {
		const t = test_convex({ transactionLimits: true });
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-notification-owner",
				displayName: "Owner",
			}),
		);
		const recipient = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-notification-recipient",
				displayName: "Recipient",
			}),
		);
		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: owner.userId,
				name: "review-notifications",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) throw new Error(created._nay.message);
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "review-notification-owner",
			external_id: owner.userId,
		});
		const inviteArgs = {
			organizationId: created._yay.organizationId,
			workspaceId: created._yay.defaultWorkspaceId,
			userIdToAdd: recipient.userId,
		};
		// Positive control uses the same public producer and recipient before deletion.
		expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs)).toEqual({
			_yay: null,
		});
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", recipient.userId))
					.collect(),
			),
		).toHaveLength(1);
		await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
			userId: recipient.userId,
			_test_batchSize: 1,
		});
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", recipient.userId))
					.collect(),
			),
		).toHaveLength(0);
		expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, inviteArgs)).toEqual({
			_nay: { message: "User to add not found" },
		});
		// Named assertion if the producer tombstone guard were absent: expected [] but gets an invite.
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", recipient.userId))
					.collect(),
			),
		).toHaveLength(0);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", recipient.userId).eq("organizationId", created._yay.organizationId),
					)
					.collect(),
			),
		).toHaveLength(0);
	});
});

describe("review: account event producer during workspace purge", () => {
	test("checks the first purge fence before enabled installations drain", async () => {
		for (const beginPurge of [false, true]) {
			const t = test_convex({ transactionLimits: true });
			const user = await t.run((ctx) =>
				data_deletion_test_bootstrap_user(ctx, {
					clerkUserId: `review-account-event-${beginPurge}`,
					displayName: "Event Owner",
				}),
			);
			const scope = {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
			};
			const { installationId } = await t.run((ctx) =>
				data_deletion_test_seed_plugin_ui_sessions(ctx, {
					...scope,
					sessionCount: 1,
				}),
			);
			await t.run(async (ctx) => {
				const installation = await ctx.db.get("plugins_workspace_installations", installationId);
				if (!installation) throw new Error("Missing test installation");
				await ctx.db.patch("plugins_versions", installation.pluginVersionId, {
					backendEntrypointFile: {
						entry: "worker.js",
						moduleName: "worker.js",
						r2Key: "plugins/review/worker.js",
						sha256: "a".repeat(64),
						compatibilityDate: "2026-08-01",
						compatibilityFlags: [],
					},
					events: [{ type: "users.account.deleted", contentTypes: [], filters: [] }],
					files: [
						{
							path: "worker.js",
							sha256: "a".repeat(64),
							bytes: 1,
							contentType: "application/javascript",
							r2Key: "plugins/review/worker.js",
						},
					],
				});
				await ctx.db.insert("plugins_workspace_event_handlers", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					installationId,
					pluginVersionId: installation.pluginVersionId,
					pluginName: installation.pluginName,
					event: "users.account.deleted",
					installationCreatedAt: installation._creationTime,
					updatedAt: Date.now(),
				});
				// This early family makes the first purge return before it disables the plugin.
				await ctx.db.insert("ai_chat_threads", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					clientGeneratedId: "review-fence-thread",
					title: "Thread",
					archived: false,
					runtime: "aisdk_5",
					stateId: null,
					createdBy: user.userId,
					updatedBy: user.userId,
					updatedAt: Date.now(),
					lastMessageAt: Date.now(),
				});
			});
			await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
			if (beginPurge) {
				const requestId = await t.run((ctx) =>
					data_deletion_db_request(ctx, {
						...scope,
						scope: "workspace",
						eligibleAt: Date.now(),
					}),
				);
				await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId,
					_test_batchSize: 1,
				});
			}
			expect((await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.status).toBe(
				"enabled",
			);
			await t.mutation(internal.plugins_runtime.enqueue_account_deleted_runs, { userId: user.userId });
			// Named side effect: the unfenced control gets one run, the fenced case gets none.
			expect(await t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(beginPurge ? 0 : 1);
		}
	});
});

describe("review: upload guard survives workspace purge", () => {
	test("keeps the same exact jobs through failures and the remaining upload window", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-upload-window",
				displayName: "Upload Owner",
			}),
		);
		const now = Date.now();
		const uploadUrlExpiresAt = now + 20 * 60 * 1000;
		const { assetId, requestId, r2Key } = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 1,
				createdBy: user.userId,
				uploadUrlExpiresAt,
				unfinalizedExpiresAt: now + 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
			const r2Key = r2_create_asset_key({
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
				eligibleAt: now,
			});
			return { assetId, requestId, r2Key };
		});
		await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toBeNull();
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
				.first(),
		);
		if (!job) throw new Error("Missing purge deletion job");
		const guard = uploadUrlExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS;
		expect(job.putMayArriveUntil).toBe(guard);
		// The provider-failure action calls this same mutation. No R2 calls run in this probe.
		for (let attempt = 0; attempt < 12; attempt += 1) {
			await t.mutation(internal.r2_client.record_object_deletion_failure, {
				jobId: job._id,
				generation: job.generation,
			});
		}
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).toMatchObject({
			attempts: 12,
			putMayArriveUntil: guard,
			nextAttemptAt: now + 60 * 60 * 1000,
		});
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: guard - 1,
		});
		// Named side effect: pre-expiry success must keep the job for a possible later PUT.
		expect(await t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).toMatchObject({
			putMayArriveUntil: guard,
			nextAttemptAt: guard,
		});
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: guard + 1,
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).toBeNull();
	});
});

// Reachable admin/retention overlap. Expected to pass under the current spec.
// Account recovery keeps resource requests, including this implicit request.
// This captures a product risk, not a confirmed violation of the current contract.
describe("overlapping account deletion review", () => {
	test("keeps the implicit organization purge after a member recovers during retention", async () => {
		const t = test_convex({ transactionLimits: true });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const owner = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-overlap-owner",
				displayName: "Overlap Owner",
				email: "review-overlap-owner@example.test",
			}),
		);
		const member = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "review-overlap-member",
				displayName: "Overlap Member",
				email: "review-overlap-member@example.test",
			}),
		);
		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "review-overlap-owner",
			external_id: owner.userId,
		});
		const memberClient = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "review-overlap-member",
			external_id: member.userId,
		});
		const created = await ownerClient.mutation(api.organizations.create_organization, {
			name: "review-overlap-team",
			description: "",
		});
		if (created._nay) throw new Error(created._nay.message);
		const organization = created._yay;
		const invite = await ownerClient.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: organization.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			userIdToAdd: member.userId,
		});
		expect(invite._nay).toBeUndefined();
		const page = await t.run(async (ctx) => {
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return await data_deletion_test_seed_page(ctx, {
				userId: member.userId,
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				tag: "member-work",
			});
		});

		// B starts ordinary account deletion while A still owns the shared organization.
		const memberDeletion = await memberClient.action(api.users.delete_current_user_account, {});
		expect(memberDeletion._nay).toBeUndefined();
		const memberRequest = await t.run((ctx) =>
			ctx.db
				.query("data_deletion_requests")
				.withIndex("by_user_scope", (q) => q.eq("userId", member.userId).eq("scope", "user"))
				.unique(),
		);
		expect(memberRequest).not.toBeNull();
		if (!memberRequest) throw new Error("Member deletion request is missing");
		expect(memberRequest.eligibleAt).toBeGreaterThan(Date.now());

		// The admin account-removal path keeps a shared organization only if another
		// active member exists. B is temporarily inactive during retention.
		await t.action(internal.users.hard_delete_user_now, {
			userId: owner.userId,
			purgeUserMod: "data_and_auth",
			_test_batchSize: 1,
			_test_disableReschedule: true,
		});
		const sharedRequest = await t.run((ctx) =>
			ctx.db
				.query("data_deletion_requests")
				.withIndex("by_organization_scope", (q) =>
					q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
				)
				.unique(),
		);
		expect(sharedRequest).not.toBeNull();
		if (!sharedRequest) throw new Error("Shared organization request is missing");
		expect(sharedRequest.eligibleAt).toBeLessThanOrEqual(Date.now());

		const recovery = await t.mutation(internal.users.resolve_user, {
			clerkUserId: "review-overlap-member-returned",
			displayName: "Overlap Member",
			email: "review-overlap-member@example.test",
		});
		expect(recovery._nay).toBeUndefined();
		expect(recovery._yay?.restoredDeletedAccount).toBe(true);
		expect(Date.now()).toBeLessThan(memberRequest.eligibleAt);
		const recoveredMembership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", member.userId)
						.eq("organizationId", organization.organizationId)
						.eq("workspaceId", organization.defaultWorkspaceId),
				)
				.unique(),
		);
		expect(recoveredMembership).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", page.nodeId))).not.toBeNull();

		let done = false;
		for (let pass = 0; pass < 80 && !done; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_organization_deletion_request, {
				requestId: sharedRequest._id,
				_test_batchSize: 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", member.userId),
			organization: await ctx.db.get("organizations", organization.organizationId),
			file: await ctx.db.get("files_nodes", page.nodeId),
		}));
		expect(after.user?.deletedAt).toBeUndefined();
		// The member's retention window does not cancel a resource-scope request.
		expect(Date.now()).toBeLessThan(memberRequest.eligibleAt);
		expect(after.organization).toBeNull();
		expect(after.file).toBeNull();
	});
});

describe("process_user_deletion_request", () => {
	test("does not fence or delete a live user", async () => {
		const t = test_convex({ transactionLimits: true });
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, { clerkUserId: null, displayName: "Review live user" }),
		);
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: user.userId,
				scope: "user",
				eligibleAt: Date.now(),
			}),
		);
		const before = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			memberships: await ctx.db.query("organizations_workspaces_users").collect(),
			quotas: await ctx.db.query("quotas").collect(),
			request: await ctx.db.get("data_deletion_requests", requestId),
		}));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
			}),
		).toEqual({ done: false, deletedCount: 0 });
		const after = await t.run(async (ctx) => ({
			user: await ctx.db.get("users", user.userId),
			memberships: await ctx.db.query("organizations_workspaces_users").collect(),
			quotas: await ctx.db.query("quotas").collect(),
			request: await ctx.db.get("data_deletion_requests", requestId),
		}));
		expect(after).toEqual(before);
		expect(errorSpy).toHaveBeenCalledWith("Deletion request made no progress", expect.objectContaining({ requestId }));
		await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		expect(
			await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
			}),
		).toEqual({ done: false, deletedCount: 1 });
	});
});

describe("process_user_deletion_request eager copy assets", () => {
	test("keeps a durable exact-key deletion job after removing an untouched eager copy", async () => {
		const t = test_convex({ transactionLimits: true });
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject");
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, { clerkUserId: null, displayName: "Eager copy deletion" }),
		);
		const tenant = { organizationId: user.defaultOrganizationId, workspaceId: user.defaultWorkspaceId };
		const seeded = await t.run(async (ctx) => {
			const source = await data_deletion_test_seed_page(ctx, { ...tenant, userId: user.userId, tag: "source.md" });
			const destination = await data_deletion_test_seed_page(ctx, { ...tenant, userId: user.userId, tag: "copy.md" });
			const node = await ctx.db.get("files_nodes", destination.nodeId);
			if (!node?.assetId) throw new Error("Missing eager destination base asset");
			await ctx.db.patch("files_r2_assets", node.assetId, { size: 0 });
			// cp creates an empty text placeholder and captures its committed sequence.
			const sequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				...tenant,
				fileNodeId: destination.nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			});
			await ctx.db.patch("files_nodes", destination.nodeId, {
				yjsLastSequenceId: sequenceId,
				textKind: "rich_text",
			});
			// The stage action has copied the object before calling this real commit mutation.
			const stagedAssetId = await ctx.db.insert("files_r2_assets", {
				...tenant,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 15,
				createdBy: user.userId,
				updatedAt: Date.now(),
				unfinalizedExpiresAt: Date.now() + 60_000,
			});
			return { sourceId: source.nodeId, nodeId: destination.nodeId, baseAssetId: node.assetId, stagedAssetId };
		});
		const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_replacement_in_db, {
			...tenant,
			userId: user.userId,
			nodeId: seeded.nodeId,
			expectedUpdatedAt: null,
			replacement: {
				assetId: seeded.stagedAssetId,
				baseAssetId: seeded.baseAssetId,
				size: 15,
				contentType: "text/markdown;charset=utf-8",
				yjsRootKind: "rich_text",
			},
			text: "# copied source",
			copiedFrom: { nodeId: seeded.sourceId, path: "/source.md" },
			eagerCreatedCommittedSequence: 0,
		});
		if (!committed._yay) throw new Error(`Copy stage refused: ${committed._nay?.message}`);
		const pendingUpdateId = committed._yay.pendingUpdateId;
		const stagedKey = await t.run(async (ctx) => {
			const pending = await ctx.db.get("files_pending_updates", pendingUpdateId);
			const asset = await ctx.db.get("files_r2_assets", seeded.stagedAssetId);
			if (!pending || !asset?.r2Key) throw new Error("Copy commit did not publish the object and pending row");
			expect(
				await files_nodes_db_is_eager_node_safe_to_hard_delete(ctx, {
					...tenant,
					nodeId: seeded.nodeId,
					pendingUpdate: pending,
				}),
			).toBe(true);
			return asset.r2Key;
		});
		const requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		if (!requestId) throw new Error("Deletion request was not created");
		const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId));
		if (!request) throw new Error("Deletion request is missing");
		vi.setSystemTime(request.eligibleAt + 1);
		let done = false;
		for (let pass = 0; pass < 40 && !done; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
				_test_now: request.eligibleAt + 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			pending: await ctx.db.get("files_pending_updates", pendingUpdateId),
			node: await ctx.db.get("files_nodes", seeded.nodeId),
			baseAsset: await ctx.db.get("files_r2_assets", seeded.baseAssetId),
			stagedAsset: await ctx.db.get("files_r2_assets", seeded.stagedAssetId),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(after.pending).toBeNull();
		expect(after.node).toBeNull();
		expect(after.baseAsset).toBeNull();
		expect(after.stagedAsset).toBeNull();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
		expect(
			after.jobs.map((job) => job.r2Key),
			"eager copy deletion must retain its staged key for durable retries",
		).toContain(stagedKey);

		const job = after.jobs.find((job) => job.r2Key === stagedKey);
		if (!job) throw new Error("Expected the copied object's deletion job");
		const confirmedDelete = vi
			.spyOn(r2_confirmed_object_delete, "delete_object")
			.mockRejectedValue(new Error("R2 unavailable"));
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const pendingJob = await t.query(internal.r2_client.get_object_deletion_job, { jobId: job._id });
			if (!pendingJob) throw new Error("Deletion stopped retrying during the outage");
			vi.setSystemTime(pendingJob.nextAttemptAt);
			await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		}
		const retry = await t.query(internal.r2_client.get_object_deletion_job, { jobId: job._id });
		expect(retry?.attempts).toBe(6);
		if (!retry) throw new Error("Expected another deletion attempt");
		vi.setSystemTime(retry.nextAttemptAt);
		confirmedDelete.mockResolvedValue(undefined);
		await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		expect(await t.query(internal.r2_client.get_object_deletion_job, { jobId: job._id })).toBeNull();
	});
});
