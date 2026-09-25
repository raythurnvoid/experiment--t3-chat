import { R2 } from "@convex-dev/r2";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { presence } from "./presence.ts";
import { test_convex, test_mocks_cancel_pending_home_file_seeds, test_mocks_fill_db_with } from "./setup.test.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { activities_db_require_by_source_id, activities_db_start } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";

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
import { r2, r2_PUT_MAY_ARRIVE_MARGIN_MS, r2_confirmed_object_delete, r2_create_asset_key } from "./r2_client.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_db_insert_pending_update } from "../server/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

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
		sortName: files_sort_text_key(args.tag),
		kind: "file",
		lowercaseExtension: null,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
		contentType: null,
		assetId: null,
		contentByteSize: null,
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
		isRestrictedScopeRoot: false,
		writePolicy: null,

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

async function data_deletion_test_seed_private_chat(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		membershipId: Id<"organizations_workspaces_users">;
		archived: boolean;
		count: number;
	},
) {
	const now = Date.now();
	const threadId = await ctx.db.insert("ai_chat_threads", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		clientGeneratedId: crypto.randomUUID(),
		title: "Private chat",
		archived: args.archived,
		runtime: "aisdk_5",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
	});
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, threadId };
	const shellId = await ctx.db.insert("ai_chat_bash_shells", {
		...scope,
		name: "default",
		cwd: "/tmp",
		cwdTarget: null,
		state: null,
		transcriptBytes: args.count * 7,
		transcriptEntries: args.count,
		transcriptSeq: args.count,
		updatedBy: args.userId,
		updatedAt: now,
	});
	for (let index = 0; index < args.count; index += 1) {
		const fileNodeId = await ctx.db.insert("ai_chat_files", {
			...scope,
			path: `/tmp/private-${index}.txt`,
			kind: "file",
			mode: 0o100644,
			size: 7,
			mtime: now,
		});
		await Promise.all([
			ctx.db.insert("ai_chat_files_content", {
				...scope,
				fileNodeId,
				bytes: new TextEncoder().encode("private").buffer,
			}),
			ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
				...scope,
				parentId: null,
				clientGeneratedMessageId: `private-${index}`,
				content: { role: "user", parts: [{ type: "text", text: "Private note" }] },
				createdBy: args.userId,
				updatedAt: now,
			}),
			ctx.db.insert("ai_chat_bash_shell_transcripts", {
				...scope,
				shellId,
				seq: index,
				text: "private",
				bytes: 7,
			}),
			ctx.db.insert("ai_chat_bash_invocations", {
				...scope,
				userId: args.userId,
				membershipId: args.membershipId,
				membershipLifetime: 0,
				toolCallId: `private-${index}`,
				commandHash: "a".repeat(64),
				status: "interrupted",
				deadlineAt: now,
				transferDeadlineAt: now,
				finishedAt: now,
			}),
		]);
	}
	await Promise.all([
		ctx.db.insert("ai_chat_bash_job_notice_cursors", { ...scope, userId: args.userId, noticeAt: now }),
		ctx.db.insert("public_api_grants", {
			...scope,
			userId: args.userId,
			principalKey: `grant:${threadId}`,
			tokenHash: `hash:${threadId}`,
			agentSource: null,
			codeReadBudgetId: null,
			scopes: ["files:read"],
			remainingReadBytes: 1024,
			pathPrefix: null,
			createdAt: now,
			expiresAt: now + 60_000,
		}),
	]);
	return threadId;
}

async function data_deletion_test_start_transfer_run(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
		count: number;
	},
) {
	const { membershipId, sourceIds } = await t.run(async (ctx) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
			.unique();
		if (!membership) throw new Error("Expected workspace membership");
		const sourceIds: Id<"files_nodes">[] = [];
		for (let index = 0; index < args.count; index += 1) {
			const page = await data_deletion_test_seed_page(ctx, { ...args, tag: `${args.tag}-${index}.md` });
			sourceIds.push(page.nodeId);
		}
		return { membershipId: membership._id, sourceIds };
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: args.userId, external_id: args.userId });
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId,
		requestId: args.tag,
		kind: "copy",
		expectedSourceCount: sourceIds.length,
		sourceIds: sourceIds.slice(0, 100),
		targetParentId: "root",
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId } = started._yay;
	for (let offset = 100; offset < sourceIds.length; offset += 100) {
		expect(
			await asUser.mutation(api.files_transfer.append_sources, {
				membershipId,
				runId,
				offset,
				sourceIds: sourceIds.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	}
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId, runId })).toEqual({ _yay: null });
	// Select and normalize before tests attach worker state to the real items.
	for (let step = 0; step < sourceIds.length * 2 + 4; step++) {
		const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		if (run?.step === "discover") break;
		await t.mutation(internal.files_transfer.advance, { runId });
	}
	expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({ step: "discover" });
	expect(
		await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		),
	).toHaveLength(sourceIds.length);
	return { runId, membershipId, sourceIds };
}

/**
 * Start an "Apply to contents" job on a new folder with one child. The job stays queued because
 * fake timers never run its scheduled step.
 */
async function data_deletion_test_start_write_policy_run(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
	const folder = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: `/${args.tag}` });
	if (folder._nay) throw new Error(folder._nay.message);
	const child = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		...scope,
		path: `/${args.tag}/child`,
	});
	if (child._nay) throw new Error(child._nay.message);
	const membershipId = await t.run(async (ctx) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
			.unique();
		if (!membership) throw new Error("Expected workspace membership");
		return membership._id;
	});
	const started = await t
		.withIdentity({ issuer: "https://clerk.test", subject: args.userId, external_id: args.userId })
		.mutation(api.files_write_policy_runs.start, {
			membershipId,
			nodeId: folder._yay.nodeId,
			writePolicy: { mode: "read_only" },
		});
	if (started._nay) throw new Error(started._nay.message);
	const activity = await t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
	if (activity?.source.kind !== "files_write_policy_run") throw new Error("Expected protection activity");
	return { runId: activity.source.id, activityId: activity._id, membershipId };
}

/**
 * Start a restore job that waits for a choice: `/<tag>` is archived and a new `/<tag>` takes its name.
 */
async function data_deletion_test_start_archive_run(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
	const folder = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: `/${args.tag}` });
	if (folder._nay) throw new Error(folder._nay.message);
	const membershipId = await t.run(async (ctx) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
			.unique();
		if (!membership) throw new Error("Expected workspace membership");
		return membership._id;
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: args.userId, external_id: args.userId });
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId,
		nodeIds: [folder._yay.nodeId],
	});
	if (archived._nay) throw new Error(archived._nay.message);
	const occupant = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		...scope,
		path: `/${args.tag}`,
	});
	if (occupant._nay) throw new Error(occupant._nay.message);
	const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId,
		nodeIds: [folder._yay.nodeId],
	});
	if (restored._nay || !restored._yay) throw new Error("Expected a restore job");
	return { ...restored._yay, membershipId };
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
		serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			pluginVersionId: pluginVersionId,
		}),
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
			serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
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
			sortName: files_sort_text_key(`${args.tag}-${i}.md`),
			kind: "file",
			lowercaseExtension: "md",
			parentId: "root",
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: Date.now(),
			contentType: "text/markdown;charset=utf-8",
			assetId: null,
			contentByteSize: null,
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
			isRestrictedScopeRoot: false,
			writePolicy: null,

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
				contentType: "text/markdown;charset=utf-8",
				yjsRootKind: "rich_text",
				collaborationEnabled: true,
			}),
		]);
		if (i < 5) {
			const pendingUpdateId = await files_db_insert_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				target: { kind: "saved", id: fileNodeId },
				revision: 1,
				size: files_get_utf8_byte_size(`# pending ${i}`),
				updatedAt: Date.now(),
			});
			const pendingTextChunkId = await ctx.db.insert("files_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				sourceKind: "pending",
				userId: args.userId,
				target: { kind: "saved", id: fileNodeId },
				proposalRevision: 1,
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
				target: { kind: "saved", id: fileNodeId },
				proposalRevision: 1,
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
					target: { kind: "saved", id: fileNodeId },
					proposalRevision: 1,
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
					target: { kind: "saved", id: fileNodeId },
					proposalRevision: 1,
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
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: Date.now(),
			lastMessageAt: Date.now(),
		});
		const [shellId, aiFileNodeId] = await Promise.all([
			ctx.db.insert("ai_chat_bash_shells", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId,
				name: "default",
				cwd: "~",
				cwdTarget: null,
				state: null,
				transcriptBytes: 11,
				transcriptEntries: 1,
				transcriptSeq: 1,
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
			ctx.db.insert("ai_chat_bash_shell_transcripts", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId,
				shellId,
				seq: 0,
				text: "$ printf hi",
				bytes: 11,
			}),
			ctx.db.insert("ai_chat_bash_job_notice_cursors", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId,
				userId: args.userId,
				noticeAt: Date.now(),
			}),
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
				serviceAccountId: null,
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
				agentSource: null,
				codeReadBudgetId: null,
				scopes: ["files:list", "files:read"],
				remainingReadBytes: 0,
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
		pendingUpdateExpiryChecks,
		lastSequenceSaved,
		materializationJobs,
		aiThreads,
		aiShells,
		aiShellTranscripts,
		aiJobNoticeCursors,
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
		ctx.db.query("files_pending_update_expiry_checks").collect(),
		ctx.db.query("files_pending_updates_last_sequence_saved").collect(),
		ctx.db.query("files_content_materialization_jobs").collect(),
		ctx.db.query("ai_chat_threads").collect(),
		ctx.db.query("ai_chat_bash_shells").collect(),
		ctx.db.query("ai_chat_bash_shell_transcripts").collect(),
		ctx.db.query("ai_chat_bash_job_notice_cursors").collect(),
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
	return [
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
		pendingUpdateExpiryChecks,
		lastSequenceSaved,
		materializationJobs,
		aiThreads,
		aiShells,
		aiShellTranscripts,
		aiJobNoticeCursors,
		aiMessages,
		aiFiles,
		aiFileContents,
		apiCredentials,
		publicApiGrants,
		permissionGrants,
		chatMessages,
	].reduce((total, rows) => total + rows.filter(inWorkspace).length, 0);
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

/**
 * A background Bash job as `start_bash_job` inserts it: the row and its Activity. The pool item
 * and the watchdog stay null; the delete batch guards both.
 */
async function data_deletion_test_seed_bash_job(
	ctx: MutationCtx,
	args: { parent: Doc<"ai_chat_bash_invocations">; shellId: Id<"ai_chat_bash_shells">; jobNumber: number },
) {
	const now = Date.now();
	const invocationId = await ctx.db.insert("ai_chat_bash_invocations", {
		organizationId: args.parent.organizationId,
		workspaceId: args.parent.workspaceId,
		userId: args.parent.userId,
		threadId: args.parent.threadId,
		toolCallId: `job:${args.parent._id}:${args.jobNumber}`,
		commandHash: "b".repeat(64),
		membershipId: args.parent.membershipId,
		membershipLifetime: args.parent.membershipLifetime,
		status: "running",
		deadlineAt: now + 600_000,
		transferDeadlineAt: now + 600_000,
		job: {
			jobNumber: args.jobNumber,
			shellId: args.shellId,
			parentInvocationId: args.parent._id,
			commandNumber: args.jobNumber,
			script: "sleep 1",
			startCwd: "/",
			startCwdTarget: null,
			shellState: null,
			allowDbFilesMkdir: false,
			workerGeneration: 0,
			workId: null,
			watchdogId: null,
			stopRequestedAt: null,
		},
	});
	const activityId = await activities_db_start(ctx, {
		organizationId: args.parent.organizationId,
		workspaceId: args.parent.workspaceId,
		userId: args.parent.userId,
		membershipId: args.parent.membershipId,
		membershipLifetime: args.parent.membershipLifetime,
		source: {
			kind: "ai_chat_bash_job",
			id: invocationId,
			threadId: args.parent.threadId,
			jobNumber: args.jobNumber,
			shellName: "default",
			parentJobNumber: null,
			scriptPreview: "sleep 1",
		},
		title: `Background command ${args.jobNumber}`,
		targets: [],
		visibility: "requester",
		feedVisible: true,
		status: "running",
		resultKind: "bash_result",
		deadlineAt: now + 600_000,
		now,
	});
	return { invocationId, activityId };
}

async function data_deletion_test_finalize_user_until_done(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		deleteUserAuth?: boolean;
		deleteBillingState?: boolean;
		deleteUserRecord?: boolean;
		batchSize?: number;
		disableReschedule?: boolean;
	},
) {
	for (let pass = 0; pass < 100; pass += 1) {
		const done = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: args.userId,
				deleteUserAuth: args.deleteUserAuth,
				deleteBillingState: args.deleteBillingState,
				deleteUserRecord: args.deleteUserRecord,
				_test_batchSize: args.batchSize,
				_test_disableReschedule: args.disableReschedule,
			}),
		);
		if (done) {
			return pass + 1;
		}
	}
	throw new Error("User finalization did not finish");
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
			const [user, organizationDoc, workspace, roleAssignments, permissionGrants, memberships, requests, ownerQuota] =
				await Promise.all([
					ctx.db.get("users", owner.userId),
					ctx.db.get("organizations", organization.organizationId),
					ctx.db.get("organizations_workspaces", organization.defaultWorkspaceId),
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

			return { user, organizationDoc, workspace, roleAssignments, permissionGrants, memberships, requests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBe(42_003);
		expect(after.organizationDoc).not.toBeNull();
		expect(after.workspace?.pluginDataPurgeStartedAt).toBe(42_003);
		expect(after.roleAssignments).toHaveLength(0);
		expect(after.permissionGrants).toHaveLength(0);
		expect(after.memberships).toHaveLength(0);
		expect(after.requests).toHaveLength(1);
		expect(after.ownerQuota?.usedCount).toBe(0);
	});
});

describe("creator-owned private chat deletion", () => {
	test("caps large chat payload batches during account finalization", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const threadId = await t.run((ctx) =>
			data_deletion_test_seed_private_chat(ctx, {
				...db,
				archived: false,
				count: 10,
			}),
		);
		const read = () =>
			t.run(async (ctx) => ({
				contents: await ctx.db
					.query("ai_chat_files_content")
					.withIndex("by_thread_fileNode", (q) => q.eq("threadId", threadId))
					.collect(),
				messages: await ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				transcripts: await ctx.db.query("ai_chat_bash_shell_transcripts").collect(),
				thread: await ctx.db.get("ai_chat_threads", threadId),
			}));
		let previous = await read();
		const capped = new Set<string>();
		let done = false;
		for (let pass = 0; pass < 100 && !done; pass += 1) {
			done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: db.userId,
				_test_disableReschedule: true,
			});
			const current = await read();
			for (const field of ["contents", "messages", "transcripts"] as const) {
				const deleted = previous[field].length - current[field].length;
				expect(deleted).toBeLessThanOrEqual(8);
				if (deleted === 8) capped.add(field);
				if (current[field].length > 0) expect(current.thread).not.toBeNull();
			}
			previous = current;
		}
		expect(done).toBe(true);
		expect(previous).toEqual({ contents: [], messages: [], transcripts: [], thread: null });
		expect([...capped].sort()).toEqual(["contents", "messages", "transcripts"]);
	});

	test.each(["queued", "missing user", "admin", "data-only reset"] as const)(
		"keeps other chats and team files unchanged through %s",
		async (mode) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => {
				const deletedUser = await data_deletion_test_bootstrap_user(ctx, {
					clerkUserId: "private-chat-deleted-user",
					displayName: "Deleted creator",
				});
				const owner = await data_deletion_test_bootstrap_user(ctx, {
					clerkUserId: "private-chat-team-owner",
					displayName: "Team owner",
				});
				const organization = await organizations_db_create(ctx, {
					userId: owner.userId,
					name: "private-chat-team",
					description: "",
					now: Date.now(),
					default: false,
				});
				if (organization._nay) throw new Error(organization._nay.message);
				const scope = {
					organizationId: organization._yay.organizationId,
					workspaceId: organization._yay.defaultWorkspaceId,
				};
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					...scope,
					userId: deletedUser.userId,
					active: true,
				});
				await ctx.db.insert("access_control_role_assignments", {
					...scope,
					userId: deletedUser.userId,
					role: "member",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				const ownerMembership = await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", scope.workspaceId).eq("userId", owner.userId),
					)
					.first();
				if (!ownerMembership) throw new Error("Expected the team owner's membership");
				const threadIds = [];
				for (const archived of [false, true]) {
					threadIds.push(
						await data_deletion_test_seed_private_chat(ctx, {
							...scope,
							membershipId,
							userId: deletedUser.userId,
							archived,
							count: 3,
						}),
					);
				}
				const keptThreadId = await data_deletion_test_seed_private_chat(ctx, {
					...scope,
					membershipId: ownerMembership._id,
					userId: owner.userId,
					archived: false,
					count: 2,
				});
				const page = await data_deletion_test_seed_page(ctx, {
					...scope,
					userId: deletedUser.userId,
					tag: "saved-team-file",
				});
				return { ...scope, deletedUser, threadIds, keptThreadId, nodeId: page.nodeId };
			});
			const transfer = await data_deletion_test_start_transfer_run(t, {
				userId: db.deletedUser.userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				tag: "private-chat-copy",
				count: 1,
			});
			await t.run(async (ctx) => {
				const invocation = await ctx.db
					.query("ai_chat_bash_invocations")
					.withIndex("by_thread_toolCall", (q) => q.eq("threadId", db.threadIds[0]))
					.first();
				if (!invocation) throw new Error("Expected the chat's foreground call");
				const activity = await activities_db_require_by_source_id(ctx, transfer.runId);
				await ctx.db.insert("ai_chat_bash_invocation_transfers", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					threadId: db.threadIds[0],
					invocationId: invocation._id,
					commandNumber: 1,
					runId: transfer.runId,
					activityId: activity._id,
				});
			});
			const read = () =>
				t.run(async (ctx) => ({
					threads: await Promise.all(db.threadIds.map((id) => ctx.db.get("ai_chat_threads", id))),
					keptThread: await ctx.db.get("ai_chat_threads", db.keptThreadId),
					children: (
						await Promise.all(
							(
								[
									"ai_chat_bash_invocation_transfers",
									"ai_chat_bash_invocations",
									"ai_chat_files_content",
									"ai_chat_files",
									"ai_chat_threads_messages_aisdk_5",
									"ai_chat_bash_shell_transcripts",
									"ai_chat_bash_shells",
									"ai_chat_bash_job_notice_cursors",
									"public_api_grants",
								] as const
							).map((table) => ctx.db.query(table).collect()),
						)
					).flat(),
					user: await ctx.db.get("users", db.deletedUser.userId),
					file: await ctx.db.get("files_nodes", db.nodeId),
					assets: await ctx.db.query("files_r2_assets").collect(),
					workspace: await ctx.db.get("organizations_workspaces", db.workspaceId),
				}));
			const before = await read();
			const keptChildren = before.children.filter((doc) => doc.threadId === db.keptThreadId);
			expect(keptChildren.length).toBeGreaterThan(0);
			let requestId: Id<"data_deletion_requests"> | null = null;
			let eligibleAt = Date.now();
			if (mode === "queued" || mode === "missing user") {
				requestId = await t.mutation(internal.data_deletion.init_user_deletion, { userId: db.deletedUser.userId });
				if (!requestId) throw new Error("Expected a user deletion request");
				const request = await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId!));
				eligibleAt = request!.eligibleAt;
				expect(eligibleAt).toBe(Date.now() + RETENTION_MS);
				expect(
					await t.query(internal.data_deletion.list_deletion_request_ids_by_scope, {
						scope: "user",
						limit: 10,
						_test_now: eligibleAt - 1,
					}),
				).not.toContain(requestId);
				expect((await read()).threads).toEqual(before.threads);
				if (mode === "missing user") {
					await t.run((ctx) => ctx.db.delete("users", db.deletedUser.userId));
				}
			}

			if (mode === "data-only reset") {
				await data_deletion_test_hard_delete_user_data_until_done(t, { userId: db.deletedUser.userId, batchSize: 1 });
				expect((await read()).threads).toEqual(before.threads);
				expect((await read()).children).toEqual(before.children);
			} else {
				let previous = before;
				let done = false;
				for (let pass = 0; pass < 150 && !done; pass += 1) {
					done =
						mode === "admin"
							? await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
									userId: db.deletedUser.userId,
									_test_batchSize: 1,
									_test_disableReschedule: true,
								})
							: (
									await t.mutation(internal.data_deletion.process_user_deletion_request, {
										requestId: requestId!,
										_test_now: eligibleAt,
										_test_batchSize: 1,
									})
								).done;
					const current = await read();
					expect(previous.children.length - current.children.length).toBeLessThanOrEqual(1);
					for (const child of current.children) {
						if ("invocationId" in child) {
							expect(current.children.some((doc) => doc._id === child.invocationId)).toBe(true);
						}
					}
					for (let index = 0; index < db.threadIds.length; index += 1) {
						if (current.children.some((doc) => doc.threadId === db.threadIds[index])) {
							expect(current.threads[index]).not.toBeNull();
						}
					}
					if (!done) {
						if (mode !== "missing user") expect(current.user?.deletionFinalizationStartedAt).toBeDefined();
						if (requestId)
							expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId!))).not.toBeNull();
					}
					previous = current;
				}
				expect(done).toBe(true);
				expect(previous.threads).toEqual([null, null]);
				expect(previous.children).toEqual(keptChildren);
				expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", transfer.runId))).toBeNull();
				if (requestId) {
					expect(await t.mutation(internal.data_deletion.process_user_deletion_request, { requestId })).toEqual({
						done: true,
						deletedCount: 0,
					});
				}
			}
			const after = await read();
			expect(after.keptThread).toEqual(before.keptThread);
			expect(after.file).toEqual(before.file);
			expect(after.assets).toEqual(before.assets);
			expect(after.workspace).toEqual(before.workspace);
			if (mode !== "missing user") expect(after.user?.deletionFinalizationStartedAt).toBeUndefined();
		},
	);
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

			await files_db_insert_pending_update(ctx, {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: deletedUser.userId,
				target: {
					kind: "saved",
					id: (
						await data_deletion_test_seed_page(ctx, {
							userId: deletedUser.userId,
							organizationId: created._yay.organizationId,
							workspaceId: created._yay.defaultWorkspaceId,
							tag: "shared-page",
						})
					).nodeId,
				},
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("users_last_active", { userId: deletedUser.userId, lastActiveAt: Date.now() });

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
				serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
					organizationId: created._yay.organizationId,
					workspaceId: created._yay.defaultWorkspaceId,
					pluginVersionId: pluginVersionId,
				}),
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
				serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
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
				expiryChecks,
				lastActive,
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
					.withIndex("by_user_target", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("files_pending_updates_last_sequence_saved")
					.withIndex("by_user_fileNode", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("files_pending_update_expiry_checks")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("users_last_active")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
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
				expiryChecks,
				lastActive,
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
		expect(afterUserDeletion.expiryChecks).toHaveLength(0);
		expect(afterUserDeletion.lastActive).toHaveLength(0);
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

		const finalizationPasses = [];
		for (let i = 0; i < 10; i += 1) {
			const result = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: test_now,
					_test_batchSize: 2,
				}),
			);
			finalizationPasses.push(result);
			if (result.done) {
				break;
			}
		}
		expect(finalizationPasses[0]).toEqual({ done: false, deletedCount: 1 });
		expect(finalizationPasses.at(-1)).toEqual({ done: true, deletedCount: 1 });

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

		let finalPass = { done: false, deletedCount: 0 };
		for (let i = 0; i < 10 && !finalPass.done; i += 1) {
			finalPass = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: test_now,
					_test_batchSize: 2,
				}),
			);
		}
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

	test("drains direct grants in bounded batches and keeps the queued deletion active", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-grant-drain",
				displayName: "Grant Drain",
			}),
		);
		const survivingUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-grant-survivor",
				displayName: "Grant Survivor",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "grant-drain",
				displayName: "Grant Drain",
				version: "0.1.0",
				description: "Grant drain fixture",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/grant-drain-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "grant-drain-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/grant-drain/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				capabilities: ["plugin.data.read", "plugin.data.write"],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: survivingUser.userId,
				updatedAt: now,
			});

			let survivingGrantId: Id<"access_control_permission_grants"> | null = null;
			for (let index = 0; index < 12; index += 1) {
				const organizationId = await ctx.db.insert("organizations", {
					name: `grant-drain-${index}`,
					description: "",
					default: false,
					billingMode: "user",
					ownerUserId: survivingUser.userId,
					updatedAt: now,
				});
				const workspaceId = await ctx.db.insert("organizations_workspaces", {
					organizationId,
					name: "home",
					description: "",
					default: true,
					updatedAt: now,
				});
				await ctx.db.patch("organizations", organizationId, { defaultWorkspaceId: workspaceId });
				const installationId = await ctx.db.insert("plugins_workspace_installations", {
					serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
						organizationId: organizationId,
						workspaceId: workspaceId,
						pluginVersionId: pluginVersionId,
					}),
					organizationId,
					workspaceId,
					pluginVersionId,
					pluginName: "grant-drain",
					status: "enabled",
					configurationYaml: null,
					acceptedCapabilities: ["plugin.data.read", "plugin.data.write"],
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
					outboundOriginsAcceptedAt: now,
					installedBy: survivingUser.userId,
					updatedBy: survivingUser.userId,
					updatedAt: now,
				});
				const scopeId = `private-${index}`;
				await ctx.db.insert("plugins_data_scopes", {
					organizationId,
					workspaceId,
					installationId,
					scopeId,
					collection: "messages",
					keyPrefix: `${scopeId}/`,
					createdByUserId: deletedUser.userId,
					createdAt: now,
					updatedAt: now,
				});

				for (const permission of ["content.read", "content.write", "content.permissions.manage"] as const) {
					await ctx.db.insert("access_control_permission_grants", {
						organizationId,
						workspaceId,
						resourceKind: "plugin_scope",
						resourceId: `${installationId}:${scopeId}`,
						principalKind: "user",
						userId: deletedUser.userId,
						permission,
						createdAt: now,
						updatedAt: now,
					});
				}
				await ctx.db.insert("access_control_permission_grants", {
					organizationId,
					workspaceId,
					resourceKind: "file",
					resourceId: `file-${index}`,
					principalKind: "user",
					userId: deletedUser.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});

				if (index === 0) {
					survivingGrantId = await ctx.db.insert("access_control_permission_grants", {
						organizationId,
						workspaceId,
						resourceKind: "file",
						resourceId: "surviving-file",
						principalKind: "user",
						userId: survivingUser.userId,
						permission: "content.read",
						createdAt: now,
						updatedAt: now,
					});
				}
			}

			if (!survivingGrantId) {
				throw new Error("Expected a surviving grant");
			}
			return { survivingGrantId };
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

		const firstPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: test_now,
				_test_batchSize: 5,
			}),
		);
		expect(firstPass).toEqual({ done: false, deletedCount: 5 });
		const afterFirstPass = await t.run(async (ctx) => ({
			grants: await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_user_organization_workspace_resource_permission", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
			request: await ctx.db.get("data_deletion_requests", requestId),
			user: await ctx.db.get("users", deletedUser.userId),
		}));
		expect(afterFirstPass.grants).toHaveLength(43);
		expect(afterFirstPass.request).not.toBeNull();
		expect(afterFirstPass.user?.defaultOrganizationId).toBeDefined();

		let finalPass = firstPass;
		for (let pass = 0; pass < 12 && !finalPass.done; pass += 1) {
			finalPass = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: test_now,
					_test_batchSize: 5,
				}),
			);
			expect(finalPass.deletedCount).toBeLessThanOrEqual(5);
		}
		expect(finalPass).toEqual({ done: true, deletedCount: 1 });

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const after = await t.run(async (ctx) => ({
			victimGrants: await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_user_organization_workspace_resource_permission", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
			survivingGrant: await ctx.db.get("access_control_permission_grants", seeded.survivingGrantId),
			scopes: await ctx.db.query("plugins_data_scopes").collect(),
			fences: await ctx.db.query("plugins_data_released_scope_ranges").collect(),
			request: await ctx.db.get("data_deletion_requests", requestId),
		}));
		expect(after.victimGrants).toHaveLength(0);
		expect(after.survivingGrant).not.toBeNull();
		expect(after.scopes).toHaveLength(0);
		expect(after.fences).toHaveLength(24);
		expect(after.request).toBeNull();
	});

	test("drains user data and preserves personal tenant cleanup when the tombstone is purged early", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-missing-user-quota",
				displayName: "Missing User Quota",
			}),
		);

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "missing-user-grant-drain",
				displayName: "Missing user grant drain",
				version: "0.1.0",
				description: "Missing user grant cleanup fixture",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/missing-user-grant-drain",
				sourceOwner: "bonobo",
				sourceRepo: "missing-user-grant-drain",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/missing-user-grant-drain/manifest.json",
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
				createdBy: deletedUser.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					pluginVersionId: pluginVersionId,
				}),
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "missing-user-grant-drain",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: deletedUser.userId,
				updatedBy: deletedUser.userId,
				updatedAt: now,
			});
			const scopeId = "private";
			await ctx.db.insert("plugins_data_scopes", {
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				installationId,
				scopeId,
				collection: "messages",
				keyPrefix: "private/",
				createdByUserId: deletedUser.userId,
				createdAt: now,
				updatedAt: now,
			});
			await Promise.all([
				ctx.db.insert("access_control_permission_grants", {
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: "missing-user-file",
					principalKind: "user",
					userId: deletedUser.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				}),
				ctx.db.insert("access_control_permission_grants", {
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					resourceKind: "plugin_scope",
					resourceId: `${installationId}:${scopeId}`,
					principalKind: "user",
					userId: deletedUser.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				}),
			]);
			return { installationId };
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
		const testNow = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected the queued user request doc");
			}
			return request.eligibleAt + 1;
		});
		await t.run((ctx) =>
			ctx.runMutation(internal.users.purge_deleted_user_tombstone, {
				userId: deletedUser.userId,
			}),
		);
		const quotaDocsBefore = await t.run((ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_user_quotaName", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
		);
		expect(quotaDocsBefore).toHaveLength(2);

		const firstPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(firstPass).toEqual({ done: false, deletedCount: 1 });
		expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).not.toBeNull();

		const secondPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(secondPass).toEqual({ done: false, deletedCount: 1 });
		expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).not.toBeNull();

		const membershipPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(membershipPass).toEqual({ done: false, deletedCount: 1 });
		const afterMembershipPass = await t.run(async (ctx) => {
			const [membership, organization, organizationRequest] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) =>
						q
							.eq("userId", deletedUser.userId)
							.eq("organizationId", deletedUser.defaultOrganizationId)
							.eq("workspaceId", deletedUser.defaultWorkspaceId),
					)
					.first(),
				ctx.db.get("organizations", deletedUser.defaultOrganizationId),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_scope", (q) =>
						q.eq("organizationId", deletedUser.defaultOrganizationId).eq("scope", "organization"),
					)
					.first(),
			]);
			return { membership, organization, organizationRequest };
		});
		expect(afterMembershipPass.membership).toBeNull();
		expect(afterMembershipPass.organization).not.toBeNull();
		if (!afterMembershipPass.organizationRequest) {
			throw new Error("Expected personal organization cleanup to stay queued");
		}
		const organizationRequestId = afterMembershipPass.organizationRequest._id;

		const firstQuotaPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(firstQuotaPass).toEqual({ done: false, deletedCount: 1 });
		const afterFirstQuotaPass = await t.run(async (ctx) => ({
			request: await ctx.db.get("data_deletion_requests", requestId),
			quotaDocs: await ctx.db
				.query("quotas")
				.withIndex("by_user_quotaName", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
		}));
		expect(afterFirstQuotaPass.request).not.toBeNull();
		expect(afterFirstQuotaPass.quotaDocs).toHaveLength(1);

		const secondQuotaPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(secondQuotaPass).toEqual({ done: false, deletedCount: 1 });
		expect(await t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).not.toBeNull();

		const finalPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(finalPass).toEqual({ done: true, deletedCount: 1 });

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const afterUserCleanup = await t.run(async (ctx) => {
			const [request, organizationRequest, userQuotaDocs, directGrants, scopes, fences] = await Promise.all([
				ctx.db.get("data_deletion_requests", requestId),
				ctx.db.get("data_deletion_requests", organizationRequestId),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_user_organization_workspace_resource_permission", (q) => q.eq("userId", deletedUser.userId))
					.collect(),
				ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) => q.eq("installationId", seeded.installationId))
					.collect(),
				ctx.db
					.query("plugins_data_released_scope_ranges")
					.withIndex("by_installation_scope", (q) => q.eq("installationId", seeded.installationId))
					.collect(),
			]);

			return {
				request,
				organizationRequest,
				userQuotaDocs,
				directGrants,
				scopes,
				fences,
			};
		});

		expect(afterUserCleanup.request).toBeNull();
		expect(afterUserCleanup.organizationRequest).not.toBeNull();
		expect(afterUserCleanup.userQuotaDocs).toHaveLength(0);
		expect(afterUserCleanup.directGrants).toHaveLength(0);
		expect(afterUserCleanup.scopes).toHaveLength(0);
		expect(afterUserCleanup.fences).toHaveLength(2);

		await data_deletion_test_process_organization_request_until_done(t, {
			requestId: organizationRequestId,
			batchSize: 1,
		});
		const afterTenantCleanup = await t.run(async (ctx) => ({
			organization: await ctx.db.get("organizations", deletedUser.defaultOrganizationId),
			workspace: await ctx.db.get("organizations_workspaces", deletedUser.defaultWorkspaceId),
			request: await ctx.db.get("data_deletion_requests", organizationRequestId),
		}));
		expect(afterTenantCleanup.organization).toBeNull();
		expect(afterTenantCleanup.workspace).toBeNull();
		expect(afterTenantCleanup.request).toBeNull();
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

		let deletionDone = false;
		for (let pass = 0; pass < 10 && !deletionDone; pass += 1) {
			const result = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId: requestId!,
					_test_now: requestEligibleAt + 1,
				}),
			);
			deletionDone = result.done;
		}
		expect(deletionDone).toBe(true);

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
	test("drains Paste runs before workspace files and keeps sibling runs", async () => {
		const t = test_convex();
		const cancelWork = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-clipboard-workspace",
				displayName: "Clipboard Workspace",
			}),
		);
		const sibling = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "clipboard-sibling",
				description: "",
				now: Date.now(),
			}),
		);
		if (sibling._nay) throw new Error(sibling._nay.message);
		const victim = await data_deletion_test_start_transfer_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "clipboard-victim",
			count: 51,
		});
		const control = await data_deletion_test_start_transfer_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: sibling._yay.workspaceId,
			tag: "clipboard-control",
			count: 1,
		});
		const workId = "clipboard-deletion-work" as WorkId;
		const attemptExpiresAt = Date.now() + 60_000;
		const putMayArriveUntil = Date.now() + 25 * 60_000;
		const { requestId, stagedAssetId, stagedKey } = await t.run(async (ctx) => {
			const item = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
				.first();
			if (!item) throw new Error("Expected Paste item");
			const stagedAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				size: 12,
				createdBy: user.userId,
				unfinalizedExpiresAt: attemptExpiresAt,
				putMayArriveUntil,
				updatedAt: Date.now(),
			});
			await ctx.db.patch("files_transfer_items", item._id, {
				state: "copying",
				attempt: 1,
				workId,
				attemptExpiresAt,
				stagedAssetIds: [stagedAssetId],
				billedUserId: null,
			});
			await ctx.db.patch("files_transfer_runs", victim.runId, { step: "apply", inFlight: 1 });
			const activity = await activities_db_require_by_source_id(ctx, victim.runId);
			await ctx.db.patch("activities", activity._id, { status: "running" });
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
				eligibleAt: 0,
			});
			return {
				requestId,
				stagedAssetId,
				stagedKey: r2_create_asset_key({
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					assetId: stagedAssetId,
				}),
			};
		});

		const first = await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId });
		const readProgress = () =>
			t.run(async (ctx) => ({
				run: await ctx.db.get("files_transfer_runs", victim.runId),
				activity: await activities_db_require_by_source_id(ctx, victim.runId),
				selection: await ctx.db
					.query("files_transfer_selection_items")
					.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
					.collect(),
				items: await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
					.collect(),
				stagedAsset: await ctx.db.get("files_r2_assets", stagedAssetId),
				deletionJobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
				sources: await Promise.all(victim.sourceIds.map((nodeId) => ctx.db.get("files_nodes", nodeId))),
			}));
		let progress = await readProgress();
		expect(first).toEqual({ done: false, deletedCount: 50 });
		expect(progress.run).not.toBeNull();
		expect(progress.activity.status).toBe("stopping");
		expect(progress.selection).toHaveLength(1);
		expect(progress.items).toHaveLength(51);
		expect(progress.stagedAsset).toBeNull();
		expect(progress.deletionJobs).toEqual([expect.objectContaining({ r2Key: stagedKey, putMayArriveUntil })]);
		expect(progress.sources.every(Boolean)).toBe(true);
		expect(cancelWork.mock.calls.map((call) => call[1])).toContain(workId);
		// Selection pages drain before work items, while every source file stays intact.
		for (let pass = 0; pass < 4 && progress.items.length > 1; pass++) {
			const remaining = progress.selection.length + progress.items.length;
			const batch = await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId });
			progress = await readProgress();
			expect(batch.done).toBe(false);
			expect(batch.deletedCount).toBeGreaterThan(0);
			expect(batch.deletedCount).toBeLessThanOrEqual(50);
			expect(progress.selection.length + progress.items.length).toBe(remaining - batch.deletedCount);
			expect(progress.sources.every(Boolean)).toBe(true);
		}
		expect(progress.selection).toEqual([]);
		expect(progress.items).toHaveLength(1);

		await data_deletion_test_process_workspace_request_until_done(t, { requestId });
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", victim.runId),
			items: await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
				.collect(),
			activities: await ctx.db.query("activities").collect(),
			controlRun: await ctx.db.get("files_transfer_runs", control.runId),
			controlItems: await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", control.runId))
				.collect(),
			controlFile: await ctx.db.get("files_nodes", control.sourceIds[0]!),
		}));
		expect(after.run).toBeNull();
		expect(after.items).toEqual([]);
		expect(after.activities.some((activity) => activity.source.id === victim.runId)).toBe(false);
		expect(after.controlRun).not.toBeNull();
		expect(after.activities.find((activity) => activity.source.id === control.runId)).toMatchObject({
			status: "running",
		});
		expect(after.controlItems).toHaveLength(1);
		expect(after.controlFile).not.toBeNull();
	});

	test("drains protection runs and keeps sibling runs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-protection-workspace",
				displayName: "Protection Workspace",
			}),
		);
		const sibling = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "protection-sibling",
				description: "",
				now: Date.now(),
			}),
		);
		if (sibling._nay) throw new Error(sibling._nay.message);
		const victim = await data_deletion_test_start_write_policy_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "protection-victim",
		});
		const control = await data_deletion_test_start_write_policy_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: sibling._yay.workspaceId,
			tag: "protection-control",
		});
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);

		await data_deletion_test_process_workspace_request_until_done(t, { requestId });

		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_write_policy_runs", victim.runId),
			activity: await ctx.db.get("activities", victim.activityId),
			controlRun: await ctx.db.get("files_write_policy_runs", control.runId),
			controlActivity: await ctx.db.get("activities", control.activityId),
		}));
		expect(after.run).toBeNull();
		expect(after.activity).toBeNull();
		expect(after.controlRun).not.toBeNull();
		expect(after.controlActivity).toMatchObject({ status: "queued" });
	});

	test("drains archive runs and keeps sibling runs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-archive-workspace",
				displayName: "Archive Workspace",
			}),
		);
		const sibling = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "archive-sibling",
				description: "",
				now: Date.now(),
			}),
		);
		if (sibling._nay) throw new Error(sibling._nay.message);
		const victim = await data_deletion_test_start_archive_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "archive-victim",
		});
		const control = await data_deletion_test_start_archive_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: sibling._yay.workspaceId,
			tag: "archive-control",
		});
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);

		await data_deletion_test_process_workspace_request_until_done(t, { requestId });

		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_archive_runs", victim.runId),
			activity: await ctx.db.get("activities", victim.activityId),
			controlRun: await ctx.db.get("files_archive_runs", control.runId),
			controlActivity: await ctx.db.get("activities", control.activityId),
		}));
		expect(after.run).toBeNull();
		expect(after.activity).toBeNull();
		expect(after.controlRun).not.toBeNull();
		expect(after.controlActivity).toMatchObject({ status: "awaiting_input" });
	});

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

	test("purges Bash links and terminal identities before their thread", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "purge-bash",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: db.userId,
			membershipId: db.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const invocation = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			threadId: thread._yay.threadId,
			membershipId: db.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "purge-bash-call",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (invocation._nay) throw new Error(invocation._nay.message);
		await t.mutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: invocation._yay.invocationId });
		const { requestId, linkId } = await t.run(async (ctx) => {
			// History links can outlive their cleaned-up transfer and Activity docs.
			const scope = {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				membershipId: db.membershipId,
				membershipLifetime: captured._yay.membershipLifetime,
			};
			const runId = await ctx.db.insert("files_transfer_runs", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				sourceScope: scope,
				destinationScope: scope,
				requestId: "purge-bash-run",
				reserveCursor: null,
				requestHash: "hash",
				kind: "copy",
				sourceView: "draft",
				publication: "proposal",
				origin: { kind: "agent", threadId: thread._yay.threadId },
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				preparedParent: null,
				fixedDeadline: false,
				conflictPolicy: { file: "error", folder: "merge" },
				step: "apply",
				planCursor: null,
				revision: 0,
				inFlight: 0,
				retryOf: null,
				retryCursor: null,
				applyToRemaining: { file: null, folder: null },
			});
			const activityId = await activities_db_start(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				source: { kind: "files_transfer_run", id: runId, transferKind: "copy" },
				title: "Bash copy",
				targets: [],
				visibility: "requester",
				feedVisible: true,
				status: "running",
				resultKind: "ready_for_review",
				deadlineAt: Date.now() + 90_000,
				now: Date.now(),
			});
			const linkId = await ctx.db.insert("ai_chat_bash_invocation_transfers", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				threadId: thread._yay.threadId,
				invocationId: invocation._yay.invocationId,
				commandNumber: 1,
				runId,
				activityId,
			});
			await ctx.db.delete("files_transfer_runs", runId);
			await ctx.db.delete("activities", activityId);
			const requestId = await data_deletion_db_request(ctx, {
				userId: db.userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			});
			return { requestId, linkId };
		});
		let done = false;
		for (let index = 0; index < 100 && !done; index += 1) {
			const step = await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			done = step.done;
			await t.run(async (ctx) => {
				const link = await ctx.db.get("ai_chat_bash_invocation_transfers", linkId);
				const receipt = await ctx.db.get("ai_chat_bash_invocations", invocation._yay.invocationId);
				const currentThread = await ctx.db.get("ai_chat_threads", thread._yay.threadId);
				if (link) expect(receipt).not.toBeNull();
				if (receipt) expect(currentThread).not.toBeNull();
			});
		}
		expect(done).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("ai_chat_bash_invocation_transfers", linkId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", invocation._yay.invocationId))).toBeNull();
	});

	test("purges a Bash job through its Activity and job-less calls as a batch", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: db.membershipId,
			clientGeneratedId: "purge-bash-job",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: db.userId,
			membershipId: db.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begin = (toolCallId: string) =>
			t.mutation(internal.ai_chat_files.begin_bash_invocation, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				threadId: thread._yay.threadId,
				membershipId: db.membershipId,
				membershipLifetime: captured._yay.membershipLifetime,
				toolCallId,
				commandHash: "a".repeat(64),
				shellName: "default",
			});
		const first = await begin("purge-job-call-1");
		if (first._nay || !("shell" in first._yay)) throw new Error("Expected a fresh call");
		const shellId = first._yay.shell._id;
		const second = await begin("purge-job-call-2");
		if (second._nay) throw new Error(second._nay.message);
		const calls = [first._yay.invocationId, second._yay.invocationId];
		const { job, requestId } = await t.run(async (ctx) => {
			const parent = await ctx.db.get("ai_chat_bash_invocations", first._yay.invocationId);
			if (!parent) throw new Error("Expected the parent call");
			const job = await data_deletion_test_seed_bash_job(ctx, { parent, shellId, jobNumber: 1 });
			const requestId = await data_deletion_db_request(ctx, {
				userId: db.userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			});
			return { job, requestId };
		});
		// One batch of 8 holds both calls and the job. The job goes first and alone, together with
		// its Activity; the job-less calls go together in the next pass.
		let sawJobGoneFirst = false;
		let done = false;
		for (let index = 0; index < 100 && !done; index += 1) {
			const step = await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 8,
			});
			done = step.done;
			const state = await t.run(async (ctx) => ({
				job: await ctx.db.get("ai_chat_bash_invocations", job.invocationId),
				activity: await ctx.db.get("activities", job.activityId),
				calls: await Promise.all(calls.map((id) => ctx.db.get("ai_chat_bash_invocations", id))),
			}));
			expect(state.activity === null).toBe(state.job === null);
			if (state.job === null && state.calls.every((call) => call !== null)) sawJobGoneFirst = true;
		}
		expect(done).toBe(true);
		expect(sawJobGoneFirst).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect())).toEqual([]);
	});

	test("purges workspace content in retryable batches without touching sibling workspaces", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-batch",
				displayName: "Workspace Batch",
			}),
		);

		const { victimWorkspaceId, controlWorkspaceId, requestId, r2Keys, metadataFolderIds } = await t.run(async (ctx) => {
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

			const metadataFolderIds: Id<"files_nodes">[] = [];
			for (const workspaceId of [victimWorkspace._yay.workspaceId, controlWorkspace._yay.workspaceId]) {
				const scope = { organizationId: user.defaultOrganizationId, workspaceId, userId: user.userId };
				const folder = await ctx.runMutation(internal.files_nodes.create_folder_node_by_path, {
					...scope,
					path: "/folder-metadata",
				});
				if (folder._nay) throw new Error(folder._nay.message);
				const metadata = await ctx.runMutation(internal.files_metadata.update_entries_by_path, {
					...scope,
					path: "/folder-metadata",
					set: [{ key: "plugin-name", value: "chitchat" }],
					remove: [],
				});
				if (metadata._nay) throw new Error(metadata._nay.message);
				metadataFolderIds.push(folder._yay.nodeId);
				for (let index = 0; index < 6; index += 1) {
					const now = Date.now();
					const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
						organizationId: user.defaultOrganizationId,
						workspaceId,
						name: `Writer ${index}`,
						createdBy: user.userId,
						createdAt: now,
						updatedAt: now,
						revokedAt: index === 0 ? now : null,
					});
					await ctx.db.insert("plugins_service_account_bindings", {
						organizationId: user.defaultOrganizationId,
						workspaceId,
						pluginName: `writer-${index}`,
						publisherUserId: user.userId,
						sourceRepositoryUrl: `https://github.com/test/writer-${index}`,
						serviceAccountId,
					});
				}
			}

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
				metadataFolderIds,
			};
		});

		const beforeMetadata = await t.run(async (ctx) =>
			(await ctx.db.query("files_metadata_docs").collect())
				.filter((doc) => doc.sourceKind === "committed")
				.filter((doc) => metadataFolderIds.includes(doc.fileNodeId)),
		);
		for (const nodeId of metadataFolderIds) {
			expect(
				beforeMetadata
					.filter((doc) => doc.fileNodeId === nodeId)
					.map((doc) => doc.docKind)
					.sort(),
			).toEqual(["field", "value"]);
		}
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
		const afterMetadata = await t.run(async (ctx) =>
			(await ctx.db.query("files_metadata_docs").collect())
				.filter((doc) => doc.sourceKind === "committed")
				.filter((doc) => metadataFolderIds.includes(doc.fileNodeId)),
		);
		expect(afterMetadata.map((doc) => doc.docKind).sort()).toEqual(["field", "value"]);
		for (const doc of afterMetadata) {
			expect(doc.fileNodeId).toBe(metadataFolderIds[1]);
			expect(doc.workspaceId).toBe(controlWorkspaceId);
		}
		const survivingAccounts = await t.run(async (ctx) => ({
			accounts: await ctx.db.query("access_control_service_accounts").collect(),
			bindings: await ctx.db.query("plugins_service_account_bindings").collect(),
		}));
		for (const docs of [survivingAccounts.accounts, survivingAccounts.bindings]) {
			expect(docs).toHaveLength(6);
			expect(docs.every((doc) => doc.workspaceId === controlWorkspaceId)).toBe(true);
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
				sortName: files_sort_text_key("state-family.md"),
				kind: "file",
				lowercaseExtension: "md",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: null,
				assetId: null,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
			});
			const pendingUpdateId = await files_db_insert_pending_update(ctx, {
				organizationId: user.defaultOrganizationId,
				workspaceId,
				userId: user.userId,
				target: { kind: "saved", id: nodeId },
				revision: 1,
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
				userId: user.userId,
				target: { kind: "saved", id: nodeId },
				expectedPendingUpdateId: pendingUpdateId,
				expectedRevision: 1,
				expectedPrivateVersion: null,
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
					userId: user.userId,
					target: { kind: "saved", id: nodeId },
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
				userId: user.userId,
				target: { kind: "saved", id: nodeId },
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
			expiryChecks: await ctx.db.query("files_pending_update_expiry_checks").collect(),
		}));
		expect(remaining.states).toHaveLength(0);
		expect(remaining.pages).toHaveLength(0);
		expect(remaining.cleanupTasks).toHaveLength(0);
		expect(remaining.batches).toHaveLength(0);
		expect(remaining.textInputs).toHaveLength(0);
		expect(remaining.trustedStages).toHaveLength(0);
		expect(remaining.pendingUpdates).toHaveLength(0);
		expect(remaining.expiryChecks).toHaveLength(0);
	});

	test("durably deletes the direct upload key before deleting an unpublished asset", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-ws-unfinalized-r2",
				displayName: "Workspace Unfinalized R2",
			}),
		);

		const { assetId, requestId, uploadUrlExpiresAt } = await t.run(async (ctx) => {
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
			await ctx.db.insert("files_nodes", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				path: "/unfinished.pdf",
				treePath: "/unfinished.pdf",
				pathDepth: 1,
				name: "unfinished.pdf",
				sortName: files_sort_text_key("unfinished.pdf"),
				kind: "file",
				lowercaseExtension: "pdf",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "application/pdf",
				assetId,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
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
					.withIndex("by_r2_key", (q) => q.eq("r2Key", liveKey))
					.collect(),
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			r2Key: liveKey,
			reason: "untracked_asset_event",
			putMayArriveUntil: uploadUrlExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assetId))).toBeNull();
	});

	test.each([true, false])(
		"hands off a Yjs cleanup deadline before asset purge when historyPending is %s",
		async (historyPending) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const user = await data_deletion_test_bootstrap_user(ctx, {
					clerkUserId: "clerk-yjs-cleanup-purge",
					displayName: "Yjs Cleanup Purge",
				});
				const scope = { organizationId: user.defaultOrganizationId, workspaceId: user.defaultWorkspaceId };
				const { nodeId } = await data_deletion_test_seed_page(ctx, {
					...scope,
					userId: user.userId,
					tag: "cleanup.md",
				});
				await ctx.db.patch("files_nodes", nodeId, { textKind: "rich_text", collaborationEnabled: false });
				const assetId = await ctx.db.insert("files_r2_assets", {
					...scope,
					kind: "yjs_snapshot",
					r2Bucket: "test-bucket",
					size: 12,
					createdBy: user.userId,
					updatedAt: Date.now(),
				});
				const putMayArriveUntil = Date.now() + 60 * 60 * 1000;
				const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
					...scope,
					fileNodeId: nodeId,
					throughSequence: 2,
					supersededYjsAssetId: assetId,
					putMayArriveUntil,
					historyPending,
				});
				const requestId = await data_deletion_db_request(ctx, { ...scope, userId: user.userId, scope: "workspace" });
				return { ...scope, taskId, assetId, requestId, putMayArriveUntil };
			});
			const r2Key = r2_create_asset_key(seeded);
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: seeded.requestId,
				_test_batchSize: 1,
			});
			const handedOff = await t.run(async (ctx) => ({
				task: await ctx.db.get("files_yjs_cleanup_tasks", seeded.taskId),
				asset: await ctx.db.get("files_r2_assets", seeded.assetId),
				job: await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
					.first(),
			}));
			expect(handedOff.task).toBeNull();
			expect(handedOff.asset).not.toBeNull();
			expect(handedOff.job).toMatchObject({ r2Key, putMayArriveUntil: seeded.putMayArriveUntil });

			await data_deletion_test_process_workspace_request_until_done(t, { requestId: seeded.requestId, batchSize: 1 });
			const purged = await t.run(async (ctx) => ({
				tasks: await ctx.db.query("files_yjs_cleanup_tasks").collect(),
				asset: await ctx.db.get("files_r2_assets", seeded.assetId),
				job: await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
					.first(),
			}));
			expect(purged.tasks).toHaveLength(0);
			expect(purged.asset).toBeNull();
			expect(purged.job).toMatchObject({ r2Key, putMayArriveUntil: seeded.putMayArriveUntil });
		},
	);

	test("keeps service attribution until its files are gone and never recreates it for a late event", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-service-purge-order",
				displayName: "Service Purge Order",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const scope = {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
			};
			const { installationId } = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
				...scope,
				userId: user.userId,
				sessionCount: 0,
			});
			const { nodeId } = await data_deletion_test_seed_page(ctx, {
				...scope,
				userId: user.userId,
				tag: "service-upload",
			});
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.assetId) throw new Error("Missing upload asset");
			await ctx.db.patch("files_r2_assets", node.assetId, {
				kind: "upload",
				r2Key: undefined,
				uploadUrlExpiresAt: Date.now() + 15 * 60 * 1000,
			});
			const targetId = await ctx.db.insert("plugin_service_storage_targets", {
				...scope,
				installationId,
				idempotencyKey: "purge-order",
				targetKey: "upload",
				requestFingerprint: "purge-order",
				destinationPath: "/",
				destinationNodeId: nodeId,
				path: node.path,
				contentType: "text/plain",
				declaredBytes: 12,
				actualBytes: null,
				chargedBytes: 0,
				nodeId,
				assetId: node.assetId,
				state: "pending",
				createdBy: user.userId,
				updatedAt: Date.now(),
			});
			const receiptId = await ctx.db.insert("plugin_service_storage_attempts", {
				...scope,
				targetId,
				assetId: node.assetId,
			});
			const quotaId = await quotas_db_ensure(ctx, {
				...scope,
				quotaName: "plugin_service_storage_bytes",
				now: Date.now(),
			});
			const requestId = await data_deletion_db_request(ctx, {
				...scope,
				userId: user.userId,
				scope: "workspace",
			});
			return { nodeId, assetId: node.assetId, targetId, receiptId, quotaId, requestId };
		});

		let done = false;
		for (let step = 0; step < 30 && !done; step++) {
			const result = await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: seeded.requestId,
				_test_batchSize: 1,
			});
			done = result.done;
			const state = await t.run(async (ctx) => ({
				asset: await ctx.db.get("files_r2_assets", seeded.assetId),
				node: await ctx.db.get("files_nodes", seeded.nodeId),
				target: await ctx.db.get("plugin_service_storage_targets", seeded.targetId),
				receipt: await ctx.db.get("plugin_service_storage_attempts", seeded.receiptId),
				quota: await ctx.db.get("quotas", seeded.quotaId),
			}));
			if (state.asset || state.node) {
				expect(state.target).not.toBeNull();
				expect(state.receipt).not.toBeNull();
			}
			if (state.target || state.receipt) expect(state.quota).not.toBeNull();
		}
		expect(done).toBe(true);

		const key = r2_create_asset_key({
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			assetId: seeded.assetId,
		});
		await t.mutation(internal.r2.record_untracked_asset_event, {
			bucket: r2.config.bucket,
			key,
			size: 1000,
			eventId: "service-purge-late-event",
		});
		const final = await t.run(async (ctx) => ({
			targets: await ctx.db.query("plugin_service_storage_targets").collect(),
			receipts: await ctx.db.query("plugin_service_storage_attempts").collect(),
			quota: await ctx.db.get("quotas", seeded.quotaId),
			job: await ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", key))
				.first(),
		}));
		expect(final.targets).toHaveLength(0);
		expect(final.receipts).toHaveLength(0);
		expect(final.quota).toBeNull();
		expect(final.job).not.toBeNull();
	});

	test("keeps a direct upload target tombstoned through its signed URL lifetime", async () => {
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
				sortName: files_sort_text_key("plugin-source.png"),
				kind: "file",
				lowercaseExtension: "png",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "image/png",
				assetId,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
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
				serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					pluginVersionId: pluginVersionId,
				}),
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
				serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
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
				ownership: "shared",
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
				serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
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
				serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
				fileNodeId,
				actorUserId: user.userId,
				installationId,
				pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:purge-test",
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				apiCallCount: 1,
				outputWriteCount: 1,
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
			const activityId = await ctx.db.insert("activities", {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				userId: user.userId,
				status: "succeeded",
				visibility: "shared",
				feedVisible: true,
				resultKind: "plugin_result",
				source: { kind: "plugin_run", id: runId, installationId, pluginName: "media", event: "files.upload.completed" },
				title: "Media plugin · plugin-source.png",
				errorMessage: null,
				targets: [],
				deadlineAt: now + 60_000,
				finishedAt: now,
				expiresAt: now + 30 * 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
			await ctx.db.insert("activities_user_states", { userId: user.userId, activityId, dismissedAt: now });
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
			const siblingMembership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) =>
					q
						.eq("userId", user.userId)
						.eq("organizationId", user.defaultOrganizationId)
						.eq("workspaceId", siblingWorkspace._yay.workspaceId),
				)
				.unique();
			if (!siblingMembership) throw new Error("Missing sibling membership");
			const siblingScope = {
				organizationId: user.defaultOrganizationId,
				workspaceId: siblingWorkspace._yay.workspaceId,
				membershipId: siblingMembership._id,
				membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, siblingMembership),
			};
			const siblingRunId = await ctx.db.insert("files_transfer_runs", {
				organizationId: user.defaultOrganizationId,
				workspaceId: siblingWorkspace._yay.workspaceId,
				userId: user.userId,
				sourceScope: siblingScope,
				destinationScope: siblingScope,
				requestId: "sibling-transfer",
				reserveCursor: null,
				requestHash: "sibling-transfer",
				kind: "copy",
				sourceView: "saved",
				publication: "saved",
				origin: { kind: "clipboard" },
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				preparedParent: null,
				fixedDeadline: false,
				conflictPolicy: { file: "ask", folder: "ask" },
				step: "apply",
				planCursor: null,
				retryOf: null,
				retryCursor: null,
				revision: 1,
				inFlight: 0,
				applyToRemaining: { file: null, folder: null },
			});
			const siblingActivityId = await ctx.db.insert("activities", {
				organizationId: user.defaultOrganizationId,
				workspaceId: siblingWorkspace._yay.workspaceId,
				userId: user.userId,
				status: "succeeded",
				visibility: "requester",
				feedVisible: true,
				resultKind: "saved",
				source: { kind: "files_transfer_run", id: siblingRunId, transferKind: "copy" },
				title: "Copy files",
				errorMessage: null,
				targets: [],
				deadlineAt: now + 60_000,
				finishedAt: now,
				expiresAt: now + 7 * 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
			await ctx.db.insert("activities_user_states", {
				userId: user.userId,
				activityId: siblingActivityId,
				dismissedAt: now,
			});
			// Stage cleanup must enqueue the derived object keys before removing these unpublished assets.
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
				contentType: "text/markdown",
				yjsRootKind: "rich_text",
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
		expect(
			(await t.run((ctx) => ctx.db.query("activities_user_states").collect())).map((state) => state.activityId),
		).toEqual([siblingActivityId]);
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
				sortName: files_sort_text_key("materialization-job.md"),
				kind: "file",
				lowercaseExtension: "md",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: Date.now(),
				contentType: null,
				assetId: null,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
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

	test("cancels plugin work and keeps Activity recovery valid between purge passes", async () => {
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
				sortName: files_sort_text_key("plugin-run-cancel.png"),
				kind: "file",
				lowercaseExtension: "png",
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "image/png",
				assetId,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
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
				serviceAccountId: await test_mocks_fill_db_with.plugin_service_account(ctx, {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					pluginVersionId: pluginVersionId,
				}),
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
				serviceAccountId: (await ctx.db.get("plugins_workspace_installations", installationId))!.serviceAccountId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				assetId,
				fileNodeId,
				actorUserId: user.userId,
				installationId,
				pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:run-cancel-test",
				workId,
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
				apiCallCount: 0,
				outputWriteCount: 0,
			});
			await activities_db_start(ctx, {
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				userId: user.userId,
				source: { kind: "plugin_run", id: runId, installationId, pluginName: "media", event: "files.upload.completed" },
				title: "media",
				targets: [],
				visibility: "shared",
				feedVisible: false,
				status: "queued",
				resultKind: "plugin_result",
				deadlineAt: now + 30 * 60 * 1000,
				now,
			});
			const requestId = await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				scope: "workspace",
			});
			return { requestId, runId };
		});

		let done = false;
		for (let pass = 0; pass < 100 && !done; pass += 1) {
			const result = await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 5,
			});
			done = result.done;
			if ((await t.run((ctx) => ctx.db.get("plugins_event_runs", runId))) === null) {
				// Recovery can run between any two purge mutations, before the rest of the tenant is gone.
				await t.mutation(internal.activities.recover_expired, { _test_now: Date.now() + 31 * 60 * 1000 });
			}
		}
		expect(done).toBe(true);

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
				sortName: files_sort_text_key("locked"),
				kind: "folder",
				lowercaseExtension: null,
				parentId: "root",
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: null,
				assetId: null,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
			});
			await ctx.db.patch("files_nodes", folderId, {
				writePolicy: { mode: "read_only" },
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
				sortName: files_sort_text_key("file.md"),
				kind: "file",
				lowercaseExtension: "md",
				parentId: folderId,
				writePolicy: null,
				createdBy: user.userId,
				updatedBy: user.userId,
				updatedAt: now,
				contentType: "text/markdown;charset=utf-8",
				assetId,
				contentByteSize: null,
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
				isRestrictedScopeRoot: false,

				archiveOperationId: null,
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
				failureCount: 0,
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
			await quotas_db_ensure(ctx, {
				quotaName: "plugin_service_storage_bytes",
				organizationId: organization.organizationId,
				workspaceId: extraWorkspace.workspaceId,
				now: Date.now(),
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

	test("stops a running Paste before organization files and keeps another organization's run", async () => {
		const t = test_convex();
		const cancelWork = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-organization-clipboard",
				displayName: "Delete Organization Clipboard",
			}),
		);
		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: user.userId,
				name: "org-clipboard",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay;
		});
		const victim = await data_deletion_test_start_transfer_run(t, {
			userId: user.userId,
			organizationId: organization.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			tag: "organization-clipboard-victim",
			count: 51,
		});
		const control = await data_deletion_test_start_transfer_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "organization-clipboard-control",
			count: 1,
		});

		const workId = "organization-clipboard-work" as WorkId;
		const requestId = await t.run(async (ctx) => {
			const item = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
				.first();
			if (!item) throw new Error("Expected Paste item");
			await ctx.db.patch("files_transfer_items", item._id, {
				state: "copying",
				attempt: 1,
				workId,
				attemptExpiresAt: Date.now() + 60_000,
				billedUserId: null,
			});
			await ctx.db.patch("files_transfer_runs", victim.runId, { step: "apply", inFlight: 1 });
			const activity = await activities_db_require_by_source_id(ctx, victim.runId);
			await ctx.db.patch("activities", activity._id, { status: "running" });
			return await data_deletion_db_request(ctx, {
				userId: user.userId,
				organizationId: organization.organizationId,
				scope: "organization",
				eligibleAt: 0,
			});
		});

		// The first pass must stop the live Paste and cancel its worker before any file is deleted.
		const first = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_organization_deletion_request, { requestId }),
		);
		const progress = await t.run(async (ctx) => ({
			activity: await activities_db_require_by_source_id(ctx, victim.runId),
			sources: await Promise.all(victim.sourceIds.map((nodeId) => ctx.db.get("files_nodes", nodeId))),
		}));
		expect(first.done).toBe(false);
		expect(progress.activity.status).toBe("stopping");
		expect(progress.sources.every(Boolean)).toBe(true);
		expect(cancelWork.mock.calls.map((call) => call[1])).toContain(workId);

		await data_deletion_test_process_organization_request_until_done(t, { requestId });
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", victim.runId),
			items: await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", victim.runId))
				.collect(),
			activities: await ctx.db.query("activities").collect(),
			controlRun: await ctx.db.get("files_transfer_runs", control.runId),
			controlFile: await ctx.db.get("files_nodes", control.sourceIds[0]!),
		}));
		expect(after.run).toBeNull();
		expect(after.items).toEqual([]);
		expect(after.activities.some((activity) => activity.source.id === victim.runId)).toBe(false);
		expect(after.controlRun).not.toBeNull();
		expect(after.activities.find((activity) => activity.source.id === control.runId)).toMatchObject({
			status: "running",
		});
		expect(after.controlFile).not.toBeNull();
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
	test("keeps stale plugin frames closed after private scope rows and fences drain", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-private-scope",
				displayName: "Reset Private Scope",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const { installationId } = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				sessionCount: 1,
			});
			const installation = await ctx.db.get("plugins_workspace_installations", installationId);
			const session = await ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_installation", (q) => q.eq("installationId", installationId))
				.first();
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", user.userId)
						.eq("organizationId", user.defaultOrganizationId)
						.eq("workspaceId", user.defaultWorkspaceId),
				)
				.first();
			if (!installation || !session || !membership) {
				throw new Error("Failed to seed plugin frame");
			}
			const now = Date.now();
			await Promise.all([
				ctx.db.insert("public_api_grants", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					threadId: null,
					principalKey: "reset-private-before-plugin-purge",
					tokenHash: "reset-private-before-plugin-purge-token",
					agentSource: null,
					codeReadBudgetId: null,
					scopes: ["files:read"],
					remainingReadBytes: 0,
					pathPrefix: null,
					createdAt: now,
					expiresAt: now + 60_000,
				}),
				ctx.db.patch("plugins_versions", installation.pluginVersionId, {
					capabilities: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write"],
				}),
				ctx.db.patch("plugins_workspace_installations", installationId, {
					acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write"],
				}),
				ctx.db.insert("plugins_data_scopes", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId,
					scopeId: "reset-private",
					collection: "messages",
					keyPrefix: "private/reset/",
					createdByUserId: user.userId,
					createdAt: now,
					updatedAt: now,
					lastAppend: null,
					appendSequence: 0,
				}),
				ctx.db.insert("plugins_data_released_scope_ranges", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId,
					scopeId: "reset-private",
					collectionName: "",
					keyPrefix: "",
				}),
				ctx.db.insert("plugins_data_released_scope_ranges", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId,
					scopeId: "reset-released",
					collectionName: "messages",
					keyPrefix: "private/released/",
				}),
				ctx.db.insert("access_control_permission_grants", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					resourceKind: "plugin_scope",
					resourceId: `${installationId}:reset-private`,
					principalKind: "user",
					userId: user.userId,
					permission: "content.write",
					createdAt: now,
					updatedAt: now,
				}),
			]);
			return {
				installationId,
				pluginVersionId: installation.pluginVersionId,
				sessionId: session._id,
				membershipId: membership._id,
			};
		});
		const asPage = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: seeded.sessionId,
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-reset-private-scope",
			external_id: user.userId,
		});

		const initialWrite = await asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			keyPrefix: "private/reset/",
			value: { text: "private before reset" },
			clientRequestId: "reset-private-before",
		});
		expect(initialWrite._nay).toBeUndefined();

		let reachedEarlyFence = false;
		let reachedClosedGap = false;
		for (let pass = 0; pass < 200; pass += 1) {
			const result = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
					userId: user.userId,
					_test_batchSize: 1,
				}),
			);
			const state = await t.run(async (ctx) => ({
				installation: await ctx.db.get("plugins_workspace_installations", seeded.installationId),
				session: await ctx.db.get("plugins_ui_sessions", seeded.sessionId),
				workspace: await ctx.db.get("organizations_workspaces", user.defaultWorkspaceId),
				scopes: await ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_organization_workspace_installation", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("installationId", seeded.installationId),
					)
					.collect(),
				fences: await ctx.db
					.query("plugins_data_released_scope_ranges")
					.withIndex("by_organization_workspace_installation", (q) =>
						q
							.eq("organizationId", user.defaultOrganizationId)
							.eq("workspaceId", user.defaultWorkspaceId)
							.eq("installationId", seeded.installationId),
					)
					.collect(),
			}));
			if (
				!reachedEarlyFence &&
				state.workspace?.pluginDataPurgeStartedAt !== undefined &&
				state.installation?.status === "enabled" &&
				state.session
			) {
				const staleWrite = await asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					keyPrefix: "private/reset/",
					value: { text: "blocked at the first purge step" },
					clientRequestId: "reset-private-first-fence",
				});
				expect(staleWrite._nay?.message).toBe("Not found");
				reachedEarlyFence = true;
			}
			if (state.scopes.length === 0 && state.fences.length === 0 && state.installation && state.session) {
				expect(result.done).toBe(false);
				expect(state.installation.status).toBe("disabled");
				expect(state.workspace?.pluginDataPurgeStartedAt).toEqual(expect.any(Number));
				const reinstall = await asUser.mutation(api.plugins.install_version, {
					membershipId: seeded.membershipId,
					pluginVersionId: seeded.pluginVersionId,
					acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write"],
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
				});
				expect(reinstall._nay?.message).toBe("Workspace cleanup is in progress");
				const staleWrite = await asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					keyPrefix: "private/reset/",
					value: { text: "must stay private" },
					clientRequestId: "reset-private-stale",
				});
				expect(staleWrite._nay?.message).toBe("Unauthorized");
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("plugins_data")
							.withIndex("by_installation_collection_key", (q) =>
								q.eq("installationId", seeded.installationId).eq("collection", "messages"),
							)
							.collect(),
					),
				).toHaveLength(0);
				reachedClosedGap = true;
				break;
			}
		}
		expect(reachedEarlyFence).toBe(true);
		expect(reachedClosedGap).toBe(true);

		await data_deletion_test_hard_delete_user_data_until_done(t, {
			userId: user.userId,
			batchSize: 1,
		});
		expect(
			await t.run(async (ctx) => {
				const workspace = await ctx.db.get("organizations_workspaces", user.defaultWorkspaceId);
				return {
					installation: await ctx.db.get("plugins_workspace_installations", seeded.installationId),
					session: await ctx.db.get("plugins_ui_sessions", seeded.sessionId),
					workspaceFence: workspace?.pluginDataPurgeStartedAt ?? null,
				};
			}),
		).toEqual({
			installation: null,
			session: null,
			workspaceFence: null,
		});
	});

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
			const serviceStorageQuotaId = await quotas_db_ensure(ctx, {
				quotaName: "plugin_service_storage_bytes",
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				now,
			});
			await ctx.db.patch("quotas", serviceStorageQuotaId, { usedCount: 123, updatedAt: now });
			const publicUploadQuotaId = await quotas_db_ensure(ctx, {
				quotaName: "public_api_upload_bytes",
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				now,
			});
			await ctx.db.patch("quotas", publicUploadQuotaId, { usedCount: 456, updatedAt: now });
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
				serviceStorageQuota,
				publicUploadQuota,
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
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", user.defaultWorkspaceId).eq("quotaName", "plugin_service_storage_bytes"),
					)
					.first(),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", user.defaultWorkspaceId).eq("quotaName", "public_api_upload_bytes"),
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
				serviceStorageQuota,
				publicUploadQuota,
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
		expect(after.serviceStorageQuota).toBeNull();
		expect(after.publicUploadQuota).toBeNull();
		expect(after.userRequest).toBeNull();
		expect(after.defaultOrganizationRequest).toBeNull();
		expect(after.defaultWorkspaceRequest).toBeNull();
		expect(after.resetUserRequests).toHaveLength(0);
		expect(after.unrelatedRequest?._id).toBe(seeded.unrelatedRequestId);
	});

	test("admin data reset batches content while preserving auth, profile, billing, and default organization/workspace docs", async () => {
		// The component uses its own S3 client for metadata and confirmed deletion.
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		const confirmedDelete = vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
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
		const expectedObjectKeys = await t.run(async (ctx) =>
			(await ctx.db.query("files_r2_assets").collect())
				.filter((asset) => asset.createdBy === user.userId)
				.map((asset) => asset.r2Key)
				.filter((key): key is string => key !== undefined),
		);
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
		expect(expectedObjectKeys.length).toBeGreaterThan(0);
		for (const key of expectedObjectKeys) expect(confirmedDelete).toHaveBeenCalledWith(expect.anything(), key);
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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: user.userId,
			deleteUserAuth: false,
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
				writePolicy: { mode: "read_only" },
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
	test("purges unlinked image holds across pages without deleting another user's assets", async () => {
		const t = test_convex();
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
		const victim = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-assets" }));

		// The purge reads 50 holds per page, so 52 victim holds force it to follow its cursor. The
		// last asset belongs to another user and must survive.
		const assets = await t.run(async (ctx) => {
			const ids = [];
			for (let index = 0; index < 53; index++) {
				const owner = index === 52 ? other : victim;
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					createdBy: owner.userId,
					kind: "content",
					r2Bucket: "test",
					size: 8,
					updatedAt: Date.now(),
					unfinalizedExpiresAt: Date.now() + 86_400_000,
					putMayArriveUntil: Date.now() + 1_500_000,
				});
				const reserved = await files_private_storage_db_reserve(ctx, {
					...owner,
					resource: { kind: "asset", id: assetId, r2Key: r2_create_asset_key({ ...owner, assetId }) },
					byteCount: 8,
				});
				if (reserved._nay) throw new Error(reserved._nay.message);
				ids.push(assetId);
			}
			return ids;
		});

		// The purge only takes holds created before it starts, and fake timers freeze the clock.
		vi.advanceTimersByTime(1);

		await data_deletion_test_finalize_user_until_done(t, { userId: victim.userId, batchSize: 10 });
		await data_deletion_test_finish_immediate_scheduled_functions(t);

		const after = await t.run(async (ctx) => ({
			assets: await Promise.all(assets.map((assetId) => ctx.db.get("files_r2_assets", assetId))),
			holds: await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_user_settlement_resource", (q) =>
					q.eq("userId", victim.userId).eq("settlement.kind", "held").eq("resource.kind", "asset"),
				)
				.collect(),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(after.assets.slice(0, 52).every((asset) => asset === null)).toBe(true);
		expect(after.assets[52]).not.toBeNull();

		// Each hold stays until its deletion job reports that R2 removed the object. An upload can
		// still arrive after the user is gone, so every job keeps a future deadline and tries again.
		expect(after.holds).toHaveLength(52);
		expect(after.jobs.filter((job) => job.privateStorageReservationId)).toHaveLength(52);
		expect(after.jobs.every((job) => job.putMayArriveUntil! > Date.now())).toBe(true);
	});

	test("drains private Paste runs before memberships and keeps shared copies", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-clipboard-victim",
				displayName: "Clipboard Victim",
			}),
		);
		const survivor = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-clipboard-survivor",
				displayName: "Clipboard Survivor",
			}),
		);
		const shared = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: victim.userId,
				name: "clipboard-shared",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) throw new Error(created._nay.message);
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: survivor.userId,
				active: true,
			});
			return created._yay;
		});
		const scope = { organizationId: shared.organizationId, workspaceId: shared.defaultWorkspaceId };
		const paste = await data_deletion_test_start_transfer_run(t, {
			...scope,
			userId: victim.userId,
			tag: "clipboard-shared-victim",
			count: 2,
		});
		const output = await t.run(async (ctx) => {
			const output = await data_deletion_test_seed_page(ctx, { ...scope, userId: victim.userId, tag: "copied.md" });
			const item = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", paste.runId))
				.first();
			if (!item) throw new Error("Expected Paste item");
			await ctx.db.patch("files_transfer_items", item._id, {
				state: "completed",
				outputTarget: { kind: "saved", id: output.nodeId },
				outputName: "copied.md",
				outputPath: "/copied.md",
			});
			await ctx.db.patch("files_transfer_runs", paste.runId, { step: "apply" });
			const activity = await activities_db_require_by_source_id(ctx, paste.runId);
			if (!activity.progress) throw new Error("Expected Paste progress");
			await ctx.db.patch("activities", activity._id, {
				status: "running",
				progress: { ...activity.progress, completed: 1 },
			});
			return output;
		});
		const transferred = await t
			.withIdentity({ issuer: "https://clerk.test", subject: victim.userId, external_id: victim.userId })
			.mutation(api.access_control.transfer_organization_ownership, {
				organizationId: shared.organizationId,
				newOwnerUserId: survivor.userId,
			});
		expect(transferred._nay).toBeUndefined();
		const control = await data_deletion_test_start_transfer_run(t, {
			...scope,
			userId: survivor.userId,
			tag: "clipboard-shared-survivor",
			count: 1,
		});

		let remainingCount = paste.sourceIds.length * 2;
		for (let pass = 0; pass < paste.sourceIds.length * 2 + 2; pass++) {
			const done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: victim.userId,
				_test_batchSize: 1,
			});
			const progress = await t.run(async (ctx) => ({
				run: await ctx.db.get("files_transfer_runs", paste.runId),
				selection: await ctx.db
					.query("files_transfer_selection_items")
					.withIndex("by_run_order", (q) => q.eq("runId", paste.runId))
					.collect(),
				items: await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", paste.runId))
					.collect(),
				membership: await ctx.db.get("organizations_workspaces_users", paste.membershipId),
				output: await ctx.db.get("files_nodes", output.nodeId),
			}));
			expect(done).toBe(false);
			remainingCount = Math.max(0, remainingCount - 1);
			expect(progress.selection.length + progress.items.length).toBe(remainingCount);
			expect(progress.items).toHaveLength(Math.min(paste.sourceIds.length, remainingCount));
			expect(progress.membership).not.toBeNull();
			expect(progress.output).not.toBeNull();
			if (!progress.run) break;
		}
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", paste.runId))).toBeNull();
		await data_deletion_test_finalize_user_until_done(t, { userId: victim.userId, batchSize: 1 });
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", paste.runId),
			activities: await ctx.db.query("activities").collect(),
			membership: await ctx.db.get("organizations_workspaces_users", paste.membershipId),
			output: await ctx.db.get("files_nodes", output.nodeId),
			controlRun: await ctx.db.get("files_transfer_runs", control.runId),
			workspace: await ctx.db.get("organizations_workspaces", scope.workspaceId),
		}));
		expect(after.run).toBeNull();
		expect(after.activities.some((activity) => activity.source.id === paste.runId)).toBe(false);
		expect(after.membership).toBeNull();
		expect(after.output).toMatchObject({ _id: output.nodeId });
		expect(after.controlRun).not.toBeNull();
		expect(after.activities.find((activity) => activity.source.id === control.runId)).toMatchObject({
			status: "running",
		});
		expect(after.workspace).not.toBeNull();
	});

	test("drains a protection run before memberships", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-protection-run",
				displayName: "Protection Run",
			}),
		);
		const run = await data_deletion_test_start_write_policy_run(t, {
			userId: victim.userId,
			organizationId: victim.defaultOrganizationId,
			workspaceId: victim.defaultWorkspaceId,
			tag: "protection-finalize",
		});

		const done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
			userId: victim.userId,
			_test_batchSize: 1,
		});
		const firstPass = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_write_policy_runs", run.runId),
			membership: await ctx.db.get("organizations_workspaces_users", run.membershipId),
		}));
		expect(done).toBe(false);
		expect(firstPass.run).toBeNull();
		expect(firstPass.membership).not.toBeNull();

		await data_deletion_test_finalize_user_until_done(t, { userId: victim.userId, batchSize: 1 });
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_write_policy_runs", run.runId),
			activity: await ctx.db.get("activities", run.activityId),
			membership: await ctx.db.get("organizations_workspaces_users", run.membershipId),
		}));
		expect(after.run).toBeNull();
		expect(after.activity).toBeNull();
		expect(after.membership).toBeNull();
	});

	test("drains an archive run before memberships", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-archive-run",
				displayName: "Archive Run",
			}),
		);
		const run = await data_deletion_test_start_archive_run(t, {
			userId: victim.userId,
			organizationId: victim.defaultOrganizationId,
			workspaceId: victim.defaultWorkspaceId,
			tag: "archive-finalize",
		});

		await data_deletion_test_finalize_user_until_done(t, { userId: victim.userId, batchSize: 1 });
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_archive_runs", run.runId),
			activity: await ctx.db.get("activities", run.activityId),
			membership: await ctx.db.get("organizations_workspaces_users", run.membershipId),
		}));
		expect(after.run).toBeNull();
		expect(after.activity).toBeNull();
		expect(after.membership).toBeNull();
	});

	test("drains a Bash job and the finished-job note cursors before memberships", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-bash-job",
				displayName: "Bash Job Victim",
			}),
		);
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", victim.defaultWorkspaceId).eq("userId", victim.userId),
				)
				.first(),
		);
		if (!membership) throw new Error("Expected the victim's membership");
		const asVictim = t.withIdentity({
			issuer: "https://clerk.test",
			subject: victim.userId,
			external_id: victim.userId,
		});
		const thread = await asVictim.mutation(api.ai_chat.thread_create, {
			membershipId: membership._id,
			clientGeneratedId: "drain-bash-job",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: victim.userId,
			membershipId: membership._id,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			organizationId: victim.defaultOrganizationId,
			workspaceId: victim.defaultWorkspaceId,
			userId: victim.userId,
			threadId: thread._yay.threadId,
			membershipId: membership._id,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "drain-job-call",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh call");
		const shellId = begun._yay.shell._id;
		const { job, cursorId } = await t.run(async (ctx) => {
			const parent = await ctx.db.get("ai_chat_bash_invocations", begun._yay.invocationId);
			if (!parent) throw new Error("Expected the parent call");
			const job = await data_deletion_test_seed_bash_job(ctx, { parent, shellId, jobNumber: 1 });
			const cursorId = await ctx.db.insert("ai_chat_bash_job_notice_cursors", {
				organizationId: victim.defaultOrganizationId,
				workspaceId: victim.defaultWorkspaceId,
				threadId: thread._yay.threadId,
				userId: victim.userId,
				noticeAt: Date.now(),
			});
			return { job, cursorId };
		});
		const read = () =>
			t.run(async (ctx) => ({
				job: await ctx.db.get("ai_chat_bash_invocations", job.invocationId),
				activity: await ctx.db.get("activities", job.activityId),
				cursor: await ctx.db.get("ai_chat_bash_job_notice_cursors", cursorId),
				membership: await ctx.db.get("organizations_workspaces_users", membership._id),
			}));
		const finalize = () =>
			t.mutation(internal.data_deletion.finalize_user_deletion_data, { userId: victim.userId, _test_batchSize: 1 });

		// Pass 1: the job and its Activity. Pass 2: the cursor. The membership waits for both.
		expect(await finalize()).toBe(false);
		const afterJob = await read();
		expect(afterJob.job).toBeNull();
		expect(afterJob.activity).toBeNull();
		expect(afterJob.cursor).not.toBeNull();
		expect(afterJob.membership).not.toBeNull();
		expect(await finalize()).toBe(false);
		const afterCursor = await read();
		expect(afterCursor.cursor).toBeNull();
		expect(afterCursor.membership).not.toBeNull();

		await data_deletion_test_finalize_user_until_done(t, { userId: victim.userId, batchSize: 1 });
		expect((await read()).membership).toBeNull();
	});

	test("drains service grants in bounded batches before memberships", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-service-grant-victim",
				displayName: "Service Grant Victim",
			}),
		);
		const survivor = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-service-grant-survivor",
				displayName: "Service Grant Survivor",
			}),
		);

		await t.run(async (ctx) => {
			for (const [user, count, tag] of [
				[victim, 3, "victim"],
				[survivor, 1, "survivor"],
			] as const) {
				const seeded = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					sessionCount: 0,
				});
				const installation = await ctx.db.get("plugins_workspace_installations", seeded.installationId);
				if (!installation) {
					throw new Error("Expected plugin installation");
				}
				for (let index = 0; index < count; index += 1) {
					await ctx.db.insert("plugin_service_grants", {
						serviceAccountId: (await ctx.db.get("plugins_workspace_installations", seeded.installationId))!
							.serviceAccountId,
						organizationId: user.defaultOrganizationId,
						workspaceId: user.defaultWorkspaceId,
						installationId: seeded.installationId,
						pluginVersionId: installation.pluginVersionId,
						pluginName: installation.pluginName,
						actorUserId: user.userId,
						tokenHash: `${tag}-${index}`.padEnd(64, "0"),
						scopes: ["plugin_data:read"],
						principalKey: `plugin_service:${tag}:${index}`,
						phase: "interactive",
						destinationPathPrefix: null,
						expiresAt: Date.now() + 60_000,
						updatedAt: Date.now(),
					});
				}
			}
		});

		const membershipCount = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", victim.userId))
						.collect()
				).length,
		);
		for (const expectedVictimGrantCount of [1, 0]) {
			const done = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: victim.userId,
					_test_batchSize: 2,
				}),
			);
			const progress = await t.run(async (ctx) => ({
				victimGrantCount: (
					await ctx.db
						.query("plugin_service_grants")
						.withIndex("by_actorUser", (q) => q.eq("actorUserId", victim.userId))
						.collect()
				).length,
				victimMembershipCount: (
					await ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", victim.userId))
						.collect()
				).length,
			}));
			expect(done).toBe(false);
			expect(progress.victimGrantCount).toBe(expectedVictimGrantCount);
			expect(progress.victimMembershipCount).toBe(membershipCount);
		}

		await data_deletion_test_finalize_user_until_done(t, {
			userId: victim.userId,
			batchSize: 2,
		});
		const survivorGrantCount = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("plugin_service_grants")
						.withIndex("by_actorUser", (q) => q.eq("actorUserId", survivor.userId))
						.collect()
				).length,
		);
		expect(survivorGrantCount).toBe(1);
	});

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
					sortName: files_sort_text_key(`${tag}.md`),
					kind: "file",
					lowercaseExtension: "md",
					parentId: "root",
					createdBy: user.userId,
					updatedBy: user.userId,
					updatedAt: now,
					contentType: null,
					assetId: null,
					contentByteSize: null,
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
					isRestrictedScopeRoot: false,
					writePolicy: null,

					archiveOperationId: null,
				});
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					target: { kind: "saved", id: nodeId },
					revision: 1,
					size: 0,
					updatedAt: now,
					expiresAt: now + 4 * 60 * 60 * 1000,
				});
				for (let chunkIndex = 0; chunkIndex < 2; chunkIndex += 1) {
					await ctx.db.insert("files_text_chunks", {
						organizationId: user.defaultOrganizationId,
						workspaceId: user.defaultWorkspaceId,
						target: { kind: "saved", id: nodeId },
						proposalRevision: 1,
						sourceKind: "pending",
						userId: user.userId,
						pendingUpdateId,
						chunkIndex,
						textChunk: `chunk-${chunkIndex}`,
						startIndex: chunkIndex,
						endIndex: chunkIndex + 1,
						lineStart: 1,
						lineEnd: 1,
						chunkFlags: 0,
					});
				}
				const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					target: { kind: "saved", id: nodeId },
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
					userId: user.userId,
					target: { kind: "saved", id: nodeId },
					expectedPendingUpdateId: pendingUpdateId,
					expectedRevision: 1,
					expectedPrivateVersion: null,
					expiresAt: now + 30 * 60 * 1000,
					lastActivityAt: now,
					updatedAt: now,
				});
				await ctx.db.insert("files_pending_update_text_inputs", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					userId: user.userId,
					target: { kind: "saved", id: nodeId },
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

				// A plugin storage share. It names the user, so finalization is the last site that can take
				// it: after this the user doc is gone and nothing links the row to anyone.
				const installation = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					sessionCount: 0,
				});
				const memberUsageId = await ctx.db.insert("plugins_data_member_usage", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId: installation.installationId,
					userId: user.userId,
					generation: "document_bound",
					usedBytes: 40,
					usedDocuments: 2,
					machineBytes: 0,
					collectionNames: ["messages"],
				});
				const usageId = await ctx.db.insert("plugins_data_usage", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId: installation.installationId,
					pluginName: "plugin-ui-session-test",
					usedBytes: 0,
					reservedBytes: 0,
					usedDocuments: 0,
					reservedDocuments: 0,
					tombstoneDocuments: 1,
					collectionNames: [],
					updatedAt: now,
				});
				const appendReplayReceiptId = await ctx.db.insert("plugins_data_append_replay_receipts", {
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					installationId: installation.installationId,
					pluginName: "plugin-ui-session-test",
					collection: "messages",
					createdBy: user.userId,
					requestId: `${name}-append`,
					requestFingerprint: `${name}-fingerprint`,
					result: { key: `${name}-deleted`, revision: 1, byteSize: 40 },
					memberUsageId,
					expiresAt: now + 24 * 60 * 60 * 1000,
				});

				return { pendingUpdateId, stateId, memberUsageId, usageId, appendReplayReceiptId };
			});
		}

		const victimSeed = await seed_user_state_docs(victim, "victim-state-family");
		const survivorSeed = await seed_user_state_docs(survivor, "survivor-state-family");

		let done = false;
		let passCount = 0;
		let sawPendingChildDrain = false;
		let sawYjsPageDrain = false;
		while (!done && passCount < 30) {
			done = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: victim.userId,
					_test_batchSize: 1,
				}),
			);
			passCount += 1;
			const progress = await t.run(async (ctx) => ({
				pendingUpdate: await ctx.db.get("files_pending_updates", victimSeed.pendingUpdateId),
				textChunkCount: (
					await ctx.db
						.query("files_text_chunks")
						.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", victimSeed.pendingUpdateId))
						.collect()
				).length,
				state: await ctx.db.get("files_pending_update_yjs_states", victimSeed.stateId),
				page: await ctx.db
					.query("files_pending_update_yjs_state_pages")
					.withIndex("by_state_pageIndex", (q) => q.eq("stateId", victimSeed.stateId))
					.first(),
			}));
			sawPendingChildDrain ||= progress.pendingUpdate !== null && progress.textChunkCount < 2;
			sawYjsPageDrain ||= progress.state !== null && progress.page === null;
		}
		expect(done).toBe(true);
		expect(passCount).toBeGreaterThan(8);
		expect(sawPendingChildDrain).toBe(true);
		expect(sawYjsPageDrain).toBe(true);

		const remaining = await t.run(async (ctx) => ({
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			batches: await ctx.db.query("files_pending_update_operation_batches").collect(),
			textInputs: await ctx.db.query("files_pending_update_text_inputs").collect(),
			trustedStages: await ctx.db.query("files_yjs_trusted_update_stages").collect(),
			memberUsage: await ctx.db.query("plugins_data_member_usage").collect(),
			appendReplayReceipts: await ctx.db.query("plugins_data_append_replay_receipts").collect(),
			pluginDataUsage: await ctx.db.query("plugins_data_usage").collect(),
		}));

		// Only the survivor's docs remain: user finalization drains every user-scoped doc class.
		expect(remaining.states.map((doc) => doc._id)).toEqual([survivorSeed.stateId]);
		expect(remaining.pages.map((doc) => doc.stateId)).toEqual([survivorSeed.stateId]);
		expect(remaining.batches.map((doc) => doc.userId)).toEqual([survivor.userId]);
		expect(remaining.textInputs.map((doc) => doc.userId)).toEqual([survivor.userId]);
		expect(remaining.trustedStages.map((doc) => doc.userId)).toEqual([survivor.userId]);
		// The victim's plugin storage share goes with them; the survivor's stays.
		expect(remaining.memberUsage.map((doc) => doc._id)).toEqual([survivorSeed.memberUsageId]);
		expect(remaining.appendReplayReceipts.map((doc) => doc._id)).toEqual([survivorSeed.appendReplayReceiptId]);
		expect(
			remaining.pluginDataUsage
				.map((doc) => ({ id: doc._id, tombstones: doc.tombstoneDocuments }))
				.sort((left, right) => String(left.id).localeCompare(String(right.id))),
		).toEqual(
			[
				{ id: victimSeed.usageId, tombstones: 0 },
				{ id: survivorSeed.usageId, tombstones: 1 },
			].sort((left, right) => String(left.id).localeCompare(String(right.id))),
		);
	});

	test("keeps recovery fenced while future tenant requests become eligible in bounded passes", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-bounded-request-finalize",
				displayName: "Bounded Request Finalize",
				email: "bounded-request-finalize@test.local",
			}),
		);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 2; index += 1) {
				await ctx.db.insert("data_deletion_requests", {
					userId: deletedUser.userId,
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					scope: "workspace",
					eligibleAt: now - 1,
				});
			}
			for (let index = 0; index < 3; index += 1) {
				await ctx.db.insert("data_deletion_requests", {
					userId: deletedUser.userId,
					organizationId: deletedUser.defaultOrganizationId,
					workspaceId: deletedUser.defaultWorkspaceId,
					scope: "workspace",
					eligibleAt: now + RETENTION_MS,
				});
			}
		});

		let done = false;
		const futureCounts = [];
		for (let pass = 0; pass < 30 && !done; pass += 1) {
			done = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: deletedUser.userId,
					_test_batchSize: 1,
				}),
			);
			futureCounts.push(
				await t.run(
					async (ctx) =>
						(
							await ctx.db
								.query("data_deletion_requests")
								.withIndex("by_user_eligibleAt", (q) => q.eq("userId", deletedUser.userId).gt("eligibleAt", now))
								.collect()
						).length,
				),
			);

			if (!done) {
				const recovery = await t.run((ctx) =>
					ctx.runMutation(internal.users.resolve_user, {
						clerkUserId: "clerk-user-bounded-request-finalize-again",
						email: "bounded-request-finalize@test.local",
						displayName: "Bounded Request Finalize Again",
					}),
				);
				expect(recovery._nay?.message).toBe("Account deletion is being finalized");
			}
		}

		expect(done).toBe(true);
		expect(new Set(futureCounts)).toEqual(new Set([0, 1, 2, 3]));
		const remainingRequests = await t.run((ctx) =>
			ctx.db
				.query("data_deletion_requests")
				.withIndex("by_user", (q) => q.eq("userId", deletedUser.userId))
				.collect(),
		);
		expect(remainingRequests).toHaveLength(6);
		expect(remainingRequests.every((request) => request.eligibleAt <= now)).toBe(true);

		const recovered = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-bounded-request-finalize-again",
				email: "bounded-request-finalize@test.local",
				displayName: "Bounded Request Finalize Again",
			}),
		);
		expect(recovered._nay).toBeUndefined();
		expect(recovered._yay?.userId).toBe(deletedUser.userId);
	});

	test("cleans every zero-grant scope after account finalization and keeps a scope with another principal", async () => {
		const t = test_convex();
		const victim = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: null,
				displayName: "Scope Cleanup Victim",
			}),
		);
		const survivor = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-scope-cleanup-survivor",
				displayName: "Scope Cleanup Survivor",
			}),
		);

		const installationId = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: survivor.defaultOrganizationId,
				workspaceId: survivor.defaultWorkspaceId,
				userId: victim.userId,
				active: true,
				updatedAt: now,
			});
			const installation = await data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: survivor.userId,
				organizationId: survivor.defaultOrganizationId,
				workspaceId: survivor.defaultWorkspaceId,
				sessionCount: 0,
			});

			for (let index = 0; index < 11; index += 1) {
				const scopeId = `orphan-${index}`;
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: survivor.defaultOrganizationId,
					workspaceId: survivor.defaultWorkspaceId,
					installationId: installation.installationId,
					scopeId,
					collection: "messages",
					keyPrefix: `${scopeId}/`,
					createdByUserId: victim.userId,
					createdAt: now,
					updatedAt: now,
				});
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: survivor.defaultOrganizationId,
					workspaceId: survivor.defaultWorkspaceId,
					resourceKind: "plugin_scope",
					resourceId: `${installation.installationId}:${scopeId}`,
					principalKind: "user",
					userId: victim.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}

			await ctx.db.insert("plugins_data_scopes", {
				organizationId: survivor.defaultOrganizationId,
				workspaceId: survivor.defaultWorkspaceId,
				installationId: installation.installationId,
				scopeId: "kept",
				collection: "messages",
				keyPrefix: "kept/",
				createdByUserId: victim.userId,
				createdAt: now,
				updatedAt: now,
			});
			for (const userId of [victim.userId, survivor.userId]) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: survivor.defaultOrganizationId,
					workspaceId: survivor.defaultWorkspaceId,
					resourceKind: "plugin_scope",
					resourceId: `${installation.installationId}:kept`,
					principalKind: "user",
					userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}
			return installation.installationId;
		});

		let prepared = false;
		for (let pass = 0; pass < 5 && !prepared; pass += 1) {
			prepared = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
					userId: victim.userId,
					_test_batchSize: 4,
				}),
			);
		}
		expect(prepared).toBe(true);
		await data_deletion_test_finalize_user_until_done(t, {
			userId: victim.userId,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const state = await t.run(async (ctx) => ({
			scopes: (await ctx.db.query("plugins_data_scopes").collect()).map((doc) => doc.scopeId).sort(),
			fences: (await ctx.db.query("plugins_data_released_scope_ranges").collect()).map((doc) => doc.scopeId).sort(),
			grants: (await ctx.db.query("access_control_permission_grants").collect())
				.filter((grant) => grant.resourceId.startsWith(`${installationId}:`))
				.map((grant) => ({ resourceId: grant.resourceId, userId: grant.userId, permission: grant.permission }))
				.sort((left, right) => left.permission.localeCompare(right.permission)),
		}));
		expect(state.scopes).toEqual(["kept"]);
		expect(state.fences).toEqual(
			Array.from({ length: 11 }, (_, index) => [`orphan-${index}`, `orphan-${index}`])
				.flat()
				.sort(),
		);
		expect(state.grants).toEqual(
			["content.permissions.manage", "content.read", "content.write"].map((permission) => ({
				resourceId: `${installationId}:kept`,
				userId: survivor.userId,
				permission,
			})),
		);
	});

	test("atomically transfers a shared organization after batch-size-one owner deletion passes", async () => {
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
			// Keep the user-wide membership drain at one row while the successor's bounded role set
			// is removed atomically with the owner transfer.
			_test_batchSize: 1,
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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
			batchSize: 1,
		});
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
		const fourthResult = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 2,
			}),
		);
		expect(secondResult).toBe(false);
		expect(thirdResult).toBe(false);
		expect(fourthResult).toBe(true);

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
		});

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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
		});
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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
			deleteBillingState: true,
		});

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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
			deleteUserAuth: false,
		});

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

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
		});
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

	test("blocks recovery between queued finalization batches and allows it after completion", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-between-batches",
				displayName: "Returning Between Batches",
				email: "returning-between-batches@test.local",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				sessionCount: 2,
			}),
		);

		const requestId = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: deletedUser.userId,
				nowTs: 30_251,
			}),
		);
		if (!requestId) {
			throw new Error("Expected a queued user deletion request");
		}
		const testNow = await t.run(async (ctx) => {
			const request = await ctx.db.get("data_deletion_requests", requestId);
			if (!request) {
				throw new Error("Expected the queued user request doc");
			}
			return request.eligibleAt + 1;
		});

		const firstPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_now: testNow,
				_test_batchSize: 1,
			}),
		);
		expect(firstPass).toEqual({ done: false, deletedCount: 1 });

		const blockedRecovery = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-between-batches-again",
				email: "returning-between-batches@test.local",
				displayName: "Returning Between Batches Again",
			}),
		);
		const duringFinalization = await t.run(async (ctx) => ({
			request: await ctx.db.get("data_deletion_requests", requestId),
			user: await ctx.db.get("users", deletedUser.userId),
		}));
		expect(blockedRecovery._yay).toBeUndefined();
		expect(blockedRecovery._nay?.message).toBe("Account deletion is being finalized");
		expect(duringFinalization.request).not.toBeNull();
		expect(duringFinalization.user?.deletedAt).toBe(30_251);
		expect(duringFinalization.user?.deletionFinalizationStartedAt).toBe(testNow);

		let finalPass = { done: false, deletedCount: 0 };
		for (let step = 0; step < 5 && !finalPass.done; step += 1) {
			finalPass = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId,
					_test_now: testNow,
					_test_batchSize: 1,
				}),
			);
		}
		expect(finalPass.done).toBe(true);

		const beforeRecovery = await t.run(async (ctx) => ({
			request: await ctx.db.get("data_deletion_requests", requestId),
			user: await ctx.db.get("users", deletedUser.userId),
		}));
		expect(beforeRecovery.request).toBeNull();
		expect(beforeRecovery.user?.deletionFinalizationStartedAt).toBeUndefined();

		const recovered = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-delete-return-between-batches-again",
				email: "returning-between-batches@test.local",
				displayName: "Returning Between Batches Again",
			}),
		);
		expect(recovered._nay).toBeUndefined();
		expect(recovered._yay?.userId).toBe(deletedUser.userId);
		const recoveredUser = await t.run((ctx) => ctx.db.get("users", deletedUser.userId));
		expect(recoveredUser?.deletedAt).toBeUndefined();
		expect(recoveredUser?.deletionFinalizationStartedAt).toBeUndefined();
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
		let finalizationDone = false;
		for (let pass = 0; pass < 10 && !finalizationDone; pass += 1) {
			const progress = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.process_user_deletion_request, {
					requestId: requestId!,
					_test_now: requestEligibleAt2 + 1,
				}),
			);
			finalizationDone = progress.done;
		}
		expect(finalizationDone).toBe(true);

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

	test("atomically purges the recovery identity and keeps tenant cleanup scheduled across retry", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-return-purge",
				displayName: "Returning User",
				email: "returning-user-purge@test.local",
			}),
		);
		const recoveryEmail = "returning-user-purge@test.local";

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
			deleteUserAuth: true,
			deleteBillingState: true,
			deleteUserRecord: true,
		});

		const afterFinalization = await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			return {
				user: await ctx.db.get("users", deletedUser.userId),
				anagraphic: await ctx.db.get("users_anagraphics", deletedUser.anagraphicId),
				workerCount: jobs.filter(
					(job) => job.state.kind === "pending" && job.name.includes("enqueue_deletion_requests_processing"),
				).length,
			};
		});
		expect(afterFinalization.user).toBeNull();
		expect(afterFinalization.anagraphic).toBeNull();
		expect(afterFinalization.workerCount).toBe(1);

		const retryDone = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: deletedUser.userId,
				deleteUserAuth: true,
				deleteBillingState: true,
				deleteUserRecord: true,
			}),
		);
		expect(retryDone).toBe(true);
		const workerCountAfterRetry = await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			return jobs.filter(
				(job) => job.state.kind === "pending" && job.name.includes("enqueue_deletion_requests_processing"),
			).length;
		});
		expect(workerCountAfterRetry).toBe(1);

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
	test("drains Paste runs before provider deletion can begin", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-clipboard",
				displayName: "Clipboard Hard Delete",
			}),
		);
		const paste = await data_deletion_test_start_transfer_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "clipboard-hard-delete",
			count: 1,
		});
		let done = false;
		for (let pass = 0; pass < paste.sourceIds.length * 2 + 3 && !done; pass++) {
			const run = await t.run((ctx) => ctx.db.get("files_transfer_runs", paste.runId));
			done = await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: user.userId,
				_test_batchSize: 1,
			});
			if (run) expect(done).toBe(false);
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", paste.runId),
			items: await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", paste.runId))
				.collect(),
			user: await ctx.db.get("users", user.userId),
		}));
		expect(after.run).toBeNull();
		expect(after.items).toEqual([]);
		expect(after.user?.deletionFinalizationStartedAt).toBeTypeOf("number");
	});

	test("drains protection runs before provider deletion can begin", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-protection",
				displayName: "Protection Hard Delete",
			}),
		);
		const run = await data_deletion_test_start_write_policy_run(t, {
			userId: user.userId,
			organizationId: user.defaultOrganizationId,
			workspaceId: user.defaultWorkspaceId,
			tag: "protection-hard-delete",
		});

		const first = await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
			userId: user.userId,
			_test_batchSize: 1,
		});
		expect(first).toBe(false);
		let done = false;
		for (let pass = 0; pass < 5 && !done; pass++) {
			done = await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: user.userId,
				_test_batchSize: 1,
			});
		}
		expect(done).toBe(true);
		const after = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_write_policy_runs", run.runId),
			activity: await ctx.db.get("activities", run.activityId),
		}));
		expect(after.run).toBeNull();
		expect(after.activity).toBeNull();
	});

	test("keeps the admin recovery fence until local finalization succeeds", async () => {
		const t = test_convex();
		const deletedUser = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-fence",
				displayName: "Hard Delete Fence",
				email: "hard-delete-fence@test.local",
			}),
		);
		await t.run((ctx) =>
			data_deletion_test_seed_plugin_ui_sessions(ctx, {
				userId: deletedUser.userId,
				organizationId: deletedUser.defaultOrganizationId,
				workspaceId: deletedUser.defaultWorkspaceId,
				sessionCount: 2,
			}),
		);

		const firstPass = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: deletedUser.userId,
				_test_batchSize: 1,
			}),
		);
		expect(firstPass).toBe(false);

		const blockedRecovery = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-hard-delete-fence-again",
				email: "hard-delete-fence@test.local",
				displayName: "Hard Delete Fence Again",
			}),
		);
		const afterFirstPass = await t.run((ctx) => ctx.db.get("users", deletedUser.userId));
		expect(blockedRecovery._nay?.message).toBe("Account deletion is being finalized");
		expect(afterFirstPass?.deletedAt).toBeTypeOf("number");
		expect(afterFirstPass?.deletionFinalizationStartedAt).toBeTypeOf("number");

		let prepared = false;
		for (let step = 0; step < 5 && !prepared; step += 1) {
			prepared = await t.run((ctx) =>
				ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
					userId: deletedUser.userId,
					_test_batchSize: 1,
				}),
			);
		}
		expect(prepared).toBe(true);
		expect((await t.run((ctx) => ctx.db.get("users", deletedUser.userId)))?.deletionFinalizationStartedAt).toBeTypeOf(
			"number",
		);

		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
		});
		const afterFinalization = await t.run((ctx) => ctx.db.get("users", deletedUser.userId));
		expect(afterFinalization?.deletionFinalizationStartedAt).toBeUndefined();

		const recovered = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-hard-delete-fence-again",
				email: "hard-delete-fence@test.local",
				displayName: "Hard Delete Fence Again",
			}),
		);
		expect(recovered._nay).toBeUndefined();
		expect(recovered._yay?.userId).toBe(deletedUser.userId);
	});

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
		await data_deletion_test_finalize_user_until_done(t, {
			userId: deletedUser.userId,
		});

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
				model: "gpt-6-luna",
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

describe("saved browser profiles", () => {
	async function seed_browser_profile(
		ctx: MutationCtx,
		args: {
			userId: Id<"users">;
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
		},
	) {
		return await ctx.db.insert("files_browser_profiles", {
			...args,
			profileKey: new Uint8Array(32).buffer,
			agentBlockedHosts: [],
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
		});
	}

	async function read_browser_profiles(t: ReturnType<typeof test_convex>) {
		return await t.run(async (ctx) => ({
			profileIds: (await ctx.db.query("files_browser_profiles").collect()).map((doc) => doc._id).sort(),
			wipes: await ctx.db.query("files_browser_profile_wipes").collect(),
		}));
	}

	test("the account deletion request closes live browsers and deletes every saved profile", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-browser-profiles",
				displayName: "Browser Profiles",
			}),
		);
		const other = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-delete-browser-profiles-other",
				displayName: "Browser Profiles Other",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const session = {
				mode: "web" as const,
				ownerId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				billedUserId: user.userId,
				navigationGeneration: 1,
				loadGen: 0,
				controlGen: 1,
				agentAccess: true,
				createdAt: now,
				updatedAt: now,
			};
			const extraWorkspace = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "profiles-extra",
				description: "",
				now,
			});
			if (extraWorkspace._nay) throw new Error(extraWorkspace._nay.message);
			return {
				liveSessionId: await ctx.db.insert("files_browser_sessions", {
					...session,
					control: "ready",
					billing: { state: "pending" },
					runnerSessionId: "runner-web-1",
				}),
				// A closed browser needs no close.
				closedSessionId: await ctx.db.insert("files_browser_sessions", {
					...session,
					control: "closed",
					closedAt: now,
					billing: { state: "settled", billedMs: 0, amountCents: 0, settledAt: now },
				}),
				profileIds: [
					await seed_browser_profile(ctx, {
						userId: user.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId: user.defaultWorkspaceId,
					}),
					await seed_browser_profile(ctx, {
						userId: user.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId: extraWorkspace._yay.workspaceId,
					}),
				],
				otherProfileId: await seed_browser_profile(ctx, {
					userId: other.userId,
					organizationId: other.defaultOrganizationId,
					workspaceId: other.defaultWorkspaceId,
				}),
			};
		});

		await t.mutation(internal.data_deletion.init_user_deletion, { userId: user.userId });
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "pending"),
		);
		expect(jobs.filter((job) => job.name.includes("end_browser_session_internal")).map((job) => job.args[0])).toEqual([
			{ sessionId: seeded.liveSessionId, reason: "account_deleted" },
		]);
		expect(jobs.filter((job) => job.name.includes("delete_user_profiles_batch")).map((job) => job.args[0])).toEqual([
			{ userId: user.userId },
		]);

		// The scheduled batch deletes each profile and writes its wipe doc in the same transaction.
		await t.mutation(internal.files_browser.delete_user_profiles_batch, { userId: user.userId });
		const after = await read_browser_profiles(t);
		expect(after.profileIds).toEqual([seeded.otherProfileId]);
		expect(after.wipes.map((wipe) => wipe.profileId).sort()).toEqual([...seeded.profileIds].sort());
		expect(after.wipes.every((wipe) => wipe.ownerId === user.userId && wipe.attempts === 0)).toBe(true);
	});

	test("the workspace purge deletes the workspace's saved profiles with wipe docs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-purge-browser-profiles",
				displayName: "Purge Browser Profiles",
			}),
		);
		const other = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-purge-browser-profiles-other",
				displayName: "Purge Browser Profiles Other",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const sibling = await organizations_db_create_workspace(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				name: "profiles-sibling",
				description: "",
				now: Date.now(),
			});
			if (sibling._nay) throw new Error(sibling._nay.message);
			return {
				purgedProfileIds: [
					await seed_browser_profile(ctx, {
						userId: user.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId: user.defaultWorkspaceId,
					}),
					await seed_browser_profile(ctx, {
						userId: other.userId,
						organizationId: user.defaultOrganizationId,
						workspaceId: user.defaultWorkspaceId,
					}),
				],
				siblingProfileId: await seed_browser_profile(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: sibling._yay.workspaceId,
				}),
				requestId: await data_deletion_db_request(ctx, {
					userId: user.userId,
					organizationId: user.defaultOrganizationId,
					workspaceId: user.defaultWorkspaceId,
					scope: "workspace",
					eligibleAt: 0,
				}),
			};
		});

		await data_deletion_test_process_workspace_request_until_done(t, { requestId: seeded.requestId });
		const after = await read_browser_profiles(t);
		expect(after.profileIds).toEqual([seeded.siblingProfileId]);
		expect(after.wipes.map((wipe) => wipe.profileId).sort()).toEqual([...seeded.purgedProfileIds].sort());
		expect(after.wipes.every((wipe) => wipe.workspaceId === user.defaultWorkspaceId)).toBe(true);
	});

	test("the data reset deletes the user's saved profiles with wipe docs", async () => {
		const t = test_convex();
		const user = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-browser-profiles",
				displayName: "Reset Browser Profiles",
			}),
		);
		const other = await t.run((ctx) =>
			data_deletion_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-reset-browser-profiles-other",
				displayName: "Reset Browser Profiles Other",
			}),
		);
		const seeded = await t.run(async (ctx) => ({
			resetProfileId: await seed_browser_profile(ctx, {
				userId: user.userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
			}),
			otherProfileId: await seed_browser_profile(ctx, {
				userId: other.userId,
				organizationId: other.defaultOrganizationId,
				workspaceId: other.defaultWorkspaceId,
			}),
		}));

		await data_deletion_test_hard_delete_user_data_until_done(t, { userId: user.userId });
		const after = await read_browser_profiles(t);
		expect(after.profileIds).toEqual([seeded.otherProfileId]);
		expect(after.wipes.map((wipe) => wipe.profileId)).toEqual([seeded.resetProfileId]);
	});
});
