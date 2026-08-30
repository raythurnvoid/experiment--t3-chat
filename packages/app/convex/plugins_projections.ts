import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { Result } from "common/errors-as-values-utils.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_normalize_text_document_input,
} from "../shared/files.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { r2_create_asset_key, r2_put_object } from "./r2_client.ts";
import {
	files_nodes_db_archive_nodes,
	files_nodes_db_cascade_read_only_scope,
	files_nodes_db_cascade_restricted_scope,
	files_nodes_db_create_node_recursively_at_path,
	files_merge_contiguous_chunks,
} from "./files_nodes.ts";
import {
	db_replace_file_chunks,
	files_nodes_db_finalize_editable_text_node_creation,
	files_nodes_db_insert_file_content_docs,
} from "./files_nodes_content.ts";
import {
	plugins_PROJECTION_PLUGIN_NAMES,
	plugins_projections_is_registered,
	type plugins_ProjectionPluginName,
} from "./plugins_projections_registry.ts";
import {
	collision_slug,
	plugins_projections_chitchat_db_channel_is_live,
	README_CHANNEL_KEY,
	ROOT_FOLDER_PATH,
	rollover_path,
} from "./plugins_projections_chitchat.ts";

const DEBOUNCE_MS = 2000;
const HOURLY_INSTALLATION_TAKE = 20;

function projection_sync_ref(pluginName: plugins_ProjectionPluginName) {
	switch (pluginName) {
		case "chitchat":
			return internal.plugins_projections_chitchat.sync;
		case "council":
			return internal.plugins_projections_council.sync;
	}
}

async function db_plugin_workspace_is_live(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	return (
		workspace?.organizationId === args.organizationId && workspace.pluginDataPurgeStartedAt === undefined
	);
}

async function page_projection_installations(
	ctx: MutationCtx,
	args: {
		pluginName: plugins_ProjectionPluginName;
		cursor: string | null;
	},
) {
	const page = await ctx.db
		.query("plugins_workspace_installations")
		.withIndex("by_pluginName", (q) => q.eq("pluginName", args.pluginName))
		.order("asc")
		.paginate({ cursor: args.cursor, numItems: HOURLY_INSTALLATION_TAKE });

	for (const installation of page.page) {
		if (installation.status === "disabled" || !(await db_plugin_workspace_is_live(ctx, installation))) {
			continue;
		}

		const state = await db_ensure_projection_state(ctx, installation);
		const dirtyChannel = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", installation._id))
			.first();
		const activeChitchatBuild =
			installation.pluginName === "chitchat"
				? await ctx.db
						.query("plugins_data_projection_chitchat_builds")
						.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
						.first()
				: null;
		// Do not treat a cleared `scheduledJobId` as work. After a successful sync that field is
		// empty on purpose. Schedule again only when the folder was never created, the write door
		// left `dirty`, or a channel rebuild is still queued.
		const needsSync =
			state.rootFolderNodeId === undefined || state.dirty || dirtyChannel !== null || activeChitchatBuild !== null;
		if (!needsSync) {
			continue;
		}

		await ctx.scheduler.runAfter(0, internal.plugins_projections.schedule_sync, {
			installationId: installation._id,
		});
	}

	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.plugins_projections.ensure_hourly, {
			pluginName: args.pluginName,
			cursor: page.continueCursor,
		});
	}

	return page.isDone ? null : page.continueCursor;
}

export const schedule_sync = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		expectedSyncGeneration: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation || installation.status === "disabled") {
			return null;
		}
		if (!(await db_plugin_workspace_is_live(ctx, installation))) {
			return null;
		}
		if (!plugins_projections_is_registered(installation.pluginName)) {
			return null;
		}

		const state = await db_ensure_projection_state(ctx, installation);
		// A running sync may ask for a retry after a newer write already replaced it. Keep that
		// stale action from canceling the newer job or creating another generation.
		if (args.expectedSyncGeneration !== undefined && state.syncGeneration !== args.expectedSyncGeneration) {
			return null;
		}
		const activeChitchatBuild =
			installation.pluginName === "chitchat"
				? await ctx.db
						.query("plugins_data_projection_chitchat_builds")
						.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
						.first()
				: null;
		if (activeChitchatBuild) {
			const scheduledJob = state.scheduledJobId
				? await ctx.db.system.get("_scheduled_functions", state.scheduledJobId)
				: null;
			// Keep the lifecycle-bound build alive across normal writes. A pending or running job
			// already owns its next bounded hop; a dead job is replaced without changing generation.
			if (scheduledJob?.state.kind === "pending" || scheduledJob?.state.kind === "inProgress") {
				await ctx.db.patch("plugins_data_projection_states", state._id, {
					dirty: true,
					...(args.expectedSyncGeneration === undefined ? { reconcileAfterChannelKey: undefined } : {}),
					updatedAt: Date.now(),
				});
				return null;
			}

			const scheduledJobId = await ctx.scheduler.runAfter(DEBOUNCE_MS, internal.plugins_projections_chitchat.sync, {
				installationId: installation._id,
				syncGeneration: state.syncGeneration,
			});
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				dirty: true,
				scheduledJobId,
				...(args.expectedSyncGeneration === undefined ? { reconcileAfterChannelKey: undefined } : {}),
				updatedAt: Date.now(),
			});
			return null;
		}
		if (state.scheduledJobId) {
			const scheduledJob = await ctx.db.system.get("_scheduled_functions", state.scheduledJobId);
			// Convex throws when canceling a completed action. Failed and completed jobs are already
			// inert, so only cancel work that can still run.
			if (scheduledJob?.state.kind === "pending" || scheduledJob?.state.kind === "inProgress") {
				await ctx.scheduler.cancel(state.scheduledJobId);
			}
		}

		const syncGeneration = state.syncGeneration + 1;
		const scheduledJobId = await ctx.scheduler.runAfter(DEBOUNCE_MS, projection_sync_ref(installation.pluginName), {
			installationId: installation._id,
			syncGeneration,
		});
		await ctx.db.patch("plugins_data_projection_states", state._id, {
			dirty: true,
			syncGeneration,
			scheduledJobId,
			// A fresh store write may delete a mapped channel behind the saved page cursor.
			// Restart that sweep. Continuation retries pass an expected generation and keep the cursor.
			...(args.expectedSyncGeneration === undefined ? { reconcileAfterChannelKey: undefined } : {}),
			updatedAt: Date.now(),
		});
		return null;
	},
});

export const ensure_hourly = internalMutation({
	args: {
		pluginName: v.optional(v.string()),
		cursor: v.optional(paginationOptsValidator.fields.cursor),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		// The cron calls `{}`. Page Chitchat in this mutation so the existing continuation test
		// still sees the first twenty states immediately. Kick every other registered plugin as
		// its own job. The opaque cursor keeps the continuation in the index's real order.
		if (args.pluginName === undefined && (args.cursor === undefined || args.cursor === null)) {
			for (const pluginName of plugins_PROJECTION_PLUGIN_NAMES) {
				if (pluginName === "chitchat") {
					continue;
				}

				await ctx.scheduler.runAfter(0, internal.plugins_projections.ensure_hourly, {
					pluginName,
				});
			}
		}

		const pluginName = args.pluginName ?? "chitchat";
		if (!plugins_projections_is_registered(pluginName)) {
			return null;
		}

		return await page_projection_installations(ctx, {
			pluginName,
			cursor: args.cursor ?? null,
		});
	},
});

export const finish_sync = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		continueImmediately: v.boolean(),
		continueIfDirty: v.optional(v.boolean()),
		keepDirty: v.optional(v.boolean()),
		expectedFiles: v.optional(
			v.object({
				channelKey: v.string(),
				files: v.array(v.object({ rolloverIndex: v.number(), path: v.string() })),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
			return null;
		}
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (
			!installation ||
			installation.status === "disabled" ||
			!plugins_projections_is_registered(installation.pluginName) ||
			!(await db_plugin_workspace_is_live(ctx, installation))
		) {
			return null;
		}

		const dirtyChannel = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", args.installationId))
			.first();
		const expectedFilesCurrent =
			args.expectedFiles === undefined ||
			(await plugins_projections_files_are_current(ctx, {
				installationId: args.installationId,
				channelKey: args.expectedFiles.channelKey,
				files: args.expectedFiles.files,
			}));
		// A successful action opts into the dirty-row recheck so a write that lands after its last
		// query still gets a job. Failed writes do not opt in because retrying them at 0ms would spin.
		const shouldContinue = args.continueImmediately || (args.continueIfDirty === true && dirtyChannel !== null);
		if (shouldContinue) {
			const scheduledJobId = await ctx.scheduler.runAfter(0, projection_sync_ref(installation.pluginName), {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
			});
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				scheduledJobId,
				dirty: dirtyChannel !== null || args.continueImmediately || args.keepDirty === true || !expectedFilesCurrent,
				updatedAt: Date.now(),
			});
			return null;
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			scheduledJobId: undefined,
			dirty: dirtyChannel !== null || args.keepDirty === true || !expectedFilesCurrent,
			updatedAt: Date.now(),
		});
		return null;
	},
});

export const ensure_projection_root = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
	},
	returns: v_result({ _yay: v.object({ folderNodeId: v.id("files_nodes"), folderPath: v.string() }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId, args.syncGeneration);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, pluginName, writerUserId, state } = ready;
		const now = Date.now();

		if (state.rootFolderNodeId) {
			const mappedRoot = await ctx.db.get("files_nodes", state.rootFolderNodeId);
			if (
				mappedRoot &&
				mappedRoot.organizationId === installation.organizationId &&
				mappedRoot.workspaceId === installation.workspaceId &&
				mappedRoot.kind === "folder" &&
				mappedRoot.archiveOperationId === undefined &&
				mappedRoot.projectionPluginName === pluginName
			) {
				if (mappedRoot.readOnlyScopeNodeId !== mappedRoot._id) {
					await ctx.db.patch("files_nodes", mappedRoot._id, {
						readOnlyScopeNodeId: mappedRoot._id,
						readOnlyPluginServiceTargetId: undefined,
					});
					await files_nodes_db_cascade_read_only_scope(ctx, {
						organizationId: installation.organizationId,
						workspaceId: installation.workspaceId,
						parentId: mappedRoot._id,
						scopeNodeId: mappedRoot._id,
					});
				}

				return Result({ _yay: { folderNodeId: mappedRoot._id, folderPath: mappedRoot.path } });
			}
		}

		const suffixPath = `${ROOT_FOLDER_PATH}-${installation._id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
		const candidates = [ROOT_FOLDER_PATH, suffixPath];
		let folderPath: string | null = null;
		let folderNodeId: Id<"files_nodes"> | null = null;

		for (const candidate of candidates) {
			const occupant = await db_get_active_node_by_path(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				path: candidate,
			});
			if (!occupant) {
				folderPath = candidate;
				folderNodeId = null;
				break;
			}

			// A leftover projection folder locks itself. Reinstall reuses that frozen snapshot.
			// A member folder or a file at the same path is not ours: try the suffixed name.
			if (
				occupant.kind === "folder" &&
				occupant.readOnlyScopeNodeId === occupant._id &&
				occupant.projectionPluginName === pluginName
			) {
				folderPath = occupant.path;
				folderNodeId = occupant._id;
				break;
			}
		}

		if (folderPath === null) {
			return Result({ _nay: { message: "Projection folder path is occupied" } });
		}

		if (folderNodeId === null) {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: writerUserId,
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				parentId: files_ROOT_ID,
				path: folderPath,
				kind: "folder",
				skipAccessControlAndLock: true,
				projectionPluginName: pluginName,
				now,
			});
			if (created._nay) {
				return Result({ _nay: { message: created._nay.message } });
			}

			folderNodeId = created._yay;
		}

		const folder = await ctx.db.get("files_nodes", folderNodeId);
		if (!folder) {
			return Result({ _nay: { message: "Projection folder missing after create" } });
		}
		if (folder.projectionPluginName !== pluginName) {
			return Result({ _nay: { message: "Projection folder ownership mismatch" } });
		}

		if (folder.readOnlyScopeNodeId !== folder._id) {
			await ctx.db.patch("files_nodes", folder._id, {
				readOnlyScopeNodeId: folder._id,
				readOnlyPluginServiceTargetId: undefined,
			});
			await files_nodes_db_cascade_read_only_scope(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				parentId: folder._id,
				scopeNodeId: folder._id,
			});
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			rootFolderNodeId: folder._id,
			updatedAt: now,
		});

		return Result({ _yay: { folderNodeId: folder._id, folderPath: folder.path } });
	},
});

/**
 * Reuse or create a writable folder for a projector that shares the path with other workspace files.
 *
 * Do not lock this folder. Council recordings also land under `/meetings`, and a folder lock would
 * freeze those uploads and any member files already there.
 */
export const ensure_writable_projection_root = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		preferredPath: v.string(),
	},
	returns: v_result({ _yay: v.object({ folderNodeId: v.id("files_nodes"), folderPath: v.string() }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId, args.syncGeneration);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, writerUserId, state } = ready;
		const now = Date.now();

		if (state.rootFolderNodeId) {
			const mappedRoot = await ctx.db.get("files_nodes", state.rootFolderNodeId);
			if (mappedRoot && mappedRoot.kind === "folder" && mappedRoot.archiveOperationId === undefined) {
				return Result({ _yay: { folderNodeId: mappedRoot._id, folderPath: mappedRoot.path } });
			}
		}

		const suffix = installation._id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
		const suffixPath = `${args.preferredPath}-${suffix}`;
		const candidates = [args.preferredPath, suffixPath];
		let folderPath: string | null = null;
		let folderNodeId: Id<"files_nodes"> | null = null;

		for (const candidate of candidates) {
			const occupant = await db_get_active_node_by_path(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				path: candidate,
			});
			if (!occupant) {
				folderPath = candidate;
				folderNodeId = null;
				break;
			}

			// Reuse any live folder at this path, including a member folder. Recordings and notes
			// share `/meetings`. A file at the same path is not a folder: try the suffixed name.
			if (occupant.kind === "folder") {
				folderPath = occupant.path;
				folderNodeId = occupant._id;
				break;
			}
		}

		if (folderPath === null) {
			return Result({ _nay: { message: "Projection folder path is occupied" } });
		}

		if (folderNodeId === null) {
			// Keep this shared root member-owned. Only the Council note files get a projection stamp.
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: writerUserId,
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				parentId: files_ROOT_ID,
				path: folderPath,
				kind: "folder",
				now,
			});
			if (created._nay) {
				return Result({ _nay: { message: created._nay.message } });
			}

			folderNodeId = created._yay;
		}

		const folder = await ctx.db.get("files_nodes", folderNodeId);
		if (!folder) {
			return Result({ _nay: { message: "Projection folder missing after create" } });
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			rootFolderNodeId: folder._id,
			updatedAt: now,
		});

		return Result({ _yay: { folderNodeId: folder._id, folderPath: folder.path } });
	},
});

type write_projection_markdown_Result = {
	_yay?: { nodeId: Id<"files_nodes">; path: string };
	_nay?: { name?: string; message: string };
};

type write_projection_channel_files_Result = {
	_yay?: { files: plugins_ProjectionExpectedFile[] };
	_nay?: { name?: string; message: string };
};

export type plugins_ProjectionExpectedFile = {
	rolloverIndex: number;
	path: string;
};

export const write_projection_markdown = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		path: v.string(),
		text: v.string(),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes"), path: v.string() }) }),
	handler: async (ctx, args): Promise<write_projection_markdown_Result> => {
		const text = files_normalize_text_document_input(args.text);
		const textSize = files_get_utf8_byte_size(text);
		if (textSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}
		const contentHash = await crypto_sha256_hex(text);
		const rolloverIndex = args.rolloverIndex ?? 0;
		await ctx.runMutation(internal.plugins_projections.repair_legacy_projection_mapping, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			expectedProjectionStateId: args.expectedProjectionStateId,
			path: args.path,
		});

		const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			expectedProjectionStateId: args.expectedProjectionStateId,
			path: args.path,
		})) as get_write_preflight_Result;
		if (preflight._nay) {
			return Result({ _nay: { message: preflight._nay.message } });
		}

		const ready = preflight._yay;
		if (!ready) {
			return Result({ _nay: { message: "Write preflight failed" } });
		}

		const { organizationId, workspaceId, writerUserId, rootFolderNodeId, occupant } = ready;
		if (occupant && occupant.mapped === false && occupant.adoptable !== true) {
			return Result({ _nay: { message: "Path is occupied by an unmapped file" } });
		}

		if (
			occupant?.mapped === true &&
			(occupant.channelKey !== args.channelKey || occupant.rolloverIndex !== rolloverIndex)
		) {
			return Result({ _nay: { message: "Path is occupied by another projected file" } });
		}

		const extraLocked = occupant?.extraLocked === true;
		const collaborative = occupant?.mapped === true && occupant.collaborative;
		if (occupant && (collaborative || extraLocked)) {
			await ctx.runMutation(internal.plugins_projections.archive_projection_node, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: args.expectedProjectionStateId,
				nodeId: occupant.nodeId,
			});
		} else if (
			occupant?.mapped === true &&
			occupant.contentHash === contentHash &&
			occupant.contentAssetId === occupant.assetId
		) {
			return Result({ _yay: { nodeId: occupant.nodeId, path: args.path } });
		} else if (occupant?.mapped === true) {
			const replaced = await replace_projection_file(ctx, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: args.expectedProjectionStateId,
				organizationId,
				workspaceId,
				writerUserId,
				rootFolderNodeId,
				nodeId: occupant.nodeId,
				baseAssetId: occupant.assetId,
				text,
				textSize,
			});
			if (replaced._nay) {
				return Result({ _nay: replaced._nay });
			}
			if (!replaced._yay) {
				return Result({ _nay: { message: "Projection replace failed" } });
			}

			return Result({ _yay: { nodeId: replaced._yay.nodeId, path: args.path } });
		} else if (occupant?.mapped === false && occupant.adoptable && occupant.assetId !== undefined) {
			await ctx.runMutation(internal.plugins_projections.map_projection_file, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: args.expectedProjectionStateId,
				nodeId: occupant.nodeId,
				path: args.path,
				channelKey: args.channelKey,
				rolloverIndex,
			});
			const replaced = await replace_projection_file(ctx, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
				expectedProjectionStateId: args.expectedProjectionStateId,
				organizationId,
				workspaceId,
				writerUserId,
				rootFolderNodeId,
				nodeId: occupant.nodeId,
				baseAssetId: occupant.assetId,
				text,
				textSize,
			});
			if (replaced._nay) {
				return Result({ _nay: replaced._nay });
			}
			if (!replaced._yay) {
				return Result({ _nay: { message: "Projection replace failed" } });
			}

			return Result({ _yay: { nodeId: replaced._yay.nodeId, path: args.path } });
		}

		const created = await create_projection_file(ctx, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			expectedProjectionStateId: args.expectedProjectionStateId,
			organizationId,
			workspaceId,
			writerUserId,
			path: args.path,
			text,
			textSize,
			channelKey: args.channelKey,
			rolloverIndex,
		});
		if (created._nay) {
			return Result({ _nay: created._nay });
		}
		if (!created._yay) {
			return Result({ _nay: { message: "Projection create failed" } });
		}

		return Result({ _yay: { nodeId: created._yay.nodeId, path: args.path } });
	},
});

export async function plugins_projections_write_channel_files(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		channelKey: string;
		slug: string;
		folderPath: string;
		texts: string[];
	},
): Promise<write_projection_channel_files_Result> {
	const fileCount = args.texts.length;
	const files: plugins_ProjectionExpectedFile[] = [];
	for (let oldestIndex = 0; oldestIndex < fileCount; oldestIndex += 1) {
		const rolloverIndex = fileCount - 1 - oldestIndex;
		const text = args.texts[oldestIndex];
		if (text === undefined) {
			continue;
		}

		let path = rollover_path(args.folderPath, args.slug, rolloverIndex);
		await ctx.runMutation(internal.plugins_projections.repair_legacy_projection_mapping, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			path,
		});
		const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			path,
		})) as get_write_preflight_Result;
		if (
			preflight._yay &&
			preflight._yay.occupant &&
			((preflight._yay.occupant.mapped === false && preflight._yay.occupant.adoptable !== true) ||
				(preflight._yay.occupant.mapped === true &&
					(preflight._yay.occupant.channelKey !== args.channelKey ||
						preflight._yay.occupant.rolloverIndex !== rolloverIndex)))
		) {
			path = rollover_path(args.folderPath, collision_slug(args.slug, args.channelKey), rolloverIndex);
		}

		const written = await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
			installationId: args.installationId,
			syncGeneration: args.syncGeneration,
			path,
			text,
			channelKey: args.channelKey,
			rolloverIndex,
		});
		if (written._nay) {
			return Result({ _nay: { message: written._nay.message } });
		}
		if (!written._yay) {
			return Result({ _nay: { message: "Projection write failed" } });
		}
		files.push({ rolloverIndex, path: written._yay.path });
	}

	await ctx.runMutation(internal.plugins_projections.trim_projection_channel_files, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		channelKey: args.channelKey,
		keepCount: fileCount,
	});
	return Result({ _yay: { files } });
}

export const write_projection_channel_files = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		channelKey: v.string(),
		slug: v.string(),
		folderPath: v.string(),
		texts: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.object({ files: v.array(v.object({ rolloverIndex: v.number(), path: v.string() })) }),
	}),
	handler: plugins_projections_write_channel_files,
});

/**
 * The folder map row of a private channel keeps this rollover index. Real files start at 0, so
 * `trim_projection_channel_files` never trims it, and `archive_projection_channel` archives the
 * folder together with its files.
 */
export const plugins_PRIVATE_FOLDER_ROLLOVER_INDEX = -1;

/**
 * One private channel's scope names at most 50 people and each person holds at most three
 * permission docs, so one bounded read covers the whole grant list on either side of the mirror.
 */
const MIRROR_GRANT_TAKE = 256;

/**
 * Reuse or create the restricted folder that holds one private channel's files.
 *
 * The folder inherits the read-only lock from the locked projection root and carries its own
 * ACL restriction. Members cannot create nodes under the locked root, so a live folder mapped
 * for this channel — or an empty leftover at the candidate path with the root's lock — is ours
 * to reuse.
 * The restriction is re-asserted on every call, so an owner's manual unrestrict heals the same
 * way the root heals a manual unlock.
 */
export const ensure_private_channel_folder = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		channelKey: v.string(),
		folderPath: v.string(),
		collisionFolderPath: v.string(),
	},
	returns: v_result({ _yay: v.object({ folderNodeId: v.id("files_nodes"), folderPath: v.string() }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, pluginName, writerUserId, state } = ready;
		if (!state.rootFolderNodeId) {
			return Result({ _nay: { message: "Projection folder is not ready" } });
		}

		const now = Date.now();

		const mappedRow = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q
					.eq("installationId", args.installationId)
					.eq("channelKey", args.channelKey)
					.eq("rolloverIndex", plugins_PRIVATE_FOLDER_ROLLOVER_INDEX),
			)
			.first();
		if (mappedRow) {
			const mappedFolder = await ctx.db.get("files_nodes", mappedRow.fileNodeId);
			if (
				mappedFolder &&
				mappedFolder.organizationId === installation.organizationId &&
				mappedFolder.workspaceId === installation.workspaceId &&
				mappedFolder.kind === "folder" &&
				mappedFolder.archiveOperationId === undefined &&
				mappedFolder.projectionPluginName === pluginName &&
				mappedFolder.readOnlyScopeNodeId === state.rootFolderNodeId
			) {
				await db_assert_restricted_scope(ctx, {
					organizationId: installation.organizationId,
					workspaceId: installation.workspaceId,
					folder: mappedFolder,
				});
				return Result({ _yay: { folderNodeId: mappedFolder._id, folderPath: mappedFolder.path } });
			}
		}

		const candidates = [args.folderPath, args.collisionFolderPath];
		let folderPath: string | null = null;
		let folderNodeId: Id<"files_nodes"> | null = null;

		for (const candidate of candidates) {
			const occupant = await db_get_active_node_by_path(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				path: candidate,
			});
			if (!occupant) {
				folderPath = candidate;
				folderNodeId = null;
				break;
			}

			// A folder carrying the root's lock is a leftover projection folder: members cannot
			// create under the locked root. Anything else at this path is not ours.
			if (
				occupant.kind === "folder" &&
				occupant.readOnlyScopeNodeId === state.rootFolderNodeId &&
				occupant.projectionPluginName === pluginName
			) {
				// A folder mapped to a channel is that channel's live home, not a leftover. Two
				// private channels with the same name must not share one folder: the second
				// channel's grant reconcile would remove the first channel's readers and open its
				// files to the wrong people. This channel's own mapped folder was already handled
				// above, so any map row here belongs to another channel — try the collision path.
				const occupantMapped = await ctx.db
					.query("plugins_data_projection_files")
					.withIndex("by_installation_fileNodeId", (q) =>
						q.eq("installationId", args.installationId).eq("fileNodeId", occupant._id),
					)
					.first();
				if (occupantMapped) {
					continue;
				}

				// Do not give a new channel access to files left by an older same-name channel. Include
				// archived children because restoring one later would expose its old transcript.
				const leftoverChild = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", installation.organizationId)
							.eq("workspaceId", installation.workspaceId)
							.eq("parentId", occupant._id),
					)
					.first();
				if (leftoverChild) {
					continue;
				}

				folderPath = occupant.path;
				folderNodeId = occupant._id;
				break;
			}
		}

		if (folderPath === null) {
			return Result({ _nay: { message: "Private channel folder path is occupied" } });
		}

		if (folderNodeId === null) {
			const rootFolder = await ctx.db.get("files_nodes", state.rootFolderNodeId);
			const rootLocked =
				rootFolder !== null &&
				rootFolder.projectionPluginName === pluginName &&
				rootFolder.readOnlyScopeNodeId === rootFolder._id;
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: writerUserId,
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				parentId: files_ROOT_ID,
				path: folderPath,
				kind: "folder",
				projectionPluginName: pluginName,
				...(rootLocked ? { skipAccessControlAndLock: true as const, inheritParentReadOnlyScope: true as const } : {}),
				now,
			});
			if (created._nay) {
				return Result({ _nay: { message: created._nay.message } });
			}

			folderNodeId = created._yay;
		}

		const folder = await ctx.db.get("files_nodes", folderNodeId);
		if (!folder) {
			return Result({ _nay: { message: "Private channel folder missing after create" } });
		}
		if (folder.projectionPluginName !== pluginName) {
			return Result({ _nay: { message: "Private channel folder ownership mismatch" } });
		}

		await db_assert_restricted_scope(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			folder,
		});

		if (mappedRow) {
			await ctx.db.patch("plugins_data_projection_files", mappedRow._id, {
				fileNodeId: folder._id,
				path: folder.path,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("plugins_data_projection_files", {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				installationId: args.installationId,
				channelKey: args.channelKey,
				fileNodeId: folder._id,
				rolloverIndex: plugins_PRIVATE_FOLDER_ROLLOVER_INDEX,
				path: folder.path,
				updatedAt: now,
			});
		}

		return Result({ _yay: { folderNodeId: folder._id, folderPath: folder.path } });
	},
});

/**
 * Mirror one private channel's scope membership onto its folder's file grants.
 *
 * Every person in the scope gets exactly one `content.read` grant on the folder, nothing more —
 * a file `manage` grant would let a channel manager unrestrict or re-share the folder. The sync
 * owns the grant list: anything else on the folder is removed, including grants a person added
 * by hand through the share dialog.
 *
 * Two phases, because folder adoption can hand an empty leftover folder to a new channel with the
 * same name: `remove_extra` runs before the files are rewritten so old readers lose the folder
 * before new content lands, and `add_missing` runs after a successful write so a failed write never
 * opens stale content to new members.
 */
export const reconcile_private_folder_grants = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		channelKey: v.string(),
		phase: v.union(v.literal("remove_extra"), v.literal("add_missing")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return null;
		}
		const { pluginName, state } = live._yay;

		const mappedRow = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q
					.eq("installationId", args.installationId)
					.eq("channelKey", args.channelKey)
					.eq("rolloverIndex", plugins_PRIVATE_FOLDER_ROLLOVER_INDEX),
			)
			.first();
		if (!mappedRow) {
			return null;
		}

		const folder = await ctx.db.get("files_nodes", mappedRow.fileNodeId);
		if (!folder || folder.archiveOperationId !== undefined || folder.projectionPluginName !== pluginName) {
			return null;
		}

		// The channel key is the scope id, and `scope_resource_id` in plugins_data.ts owns this
		// resource-id format.
		const scopeResourceId = `${args.installationId}:${args.channelKey}`;
		const scopeGrants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("resourceKind", "plugin_scope")
					.eq("resourceId", scopeResourceId),
			)
			.take(MIRROR_GRANT_TAKE);
		const memberUserIds = new Set<Id<"users">>();
		for (const grant of scopeGrants) {
			if (grant.userId) {
				memberUserIds.add(grant.userId);
			}
		}

		const folderGrants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(folder._id)),
			)
			.take(MIRROR_GRANT_TAKE);

		if (args.phase === "remove_extra") {
			const kept = new Set<Id<"users">>();
			for (const grant of folderGrants) {
				const mirrored =
					grant.principalKind === "user" &&
					grant.userId !== undefined &&
					memberUserIds.has(grant.userId) &&
					grant.permission === "content.read" &&
					!kept.has(grant.userId);
				if (mirrored && grant.userId) {
					kept.add(grant.userId);
					continue;
				}

				await ctx.db.delete("access_control_permission_grants", grant._id);
			}
			return null;
		}

		const holders = new Set<Id<"users">>();
		for (const grant of folderGrants) {
			if (grant.principalKind === "user" && grant.userId && grant.permission === "content.read") {
				holders.add(grant.userId);
			}
		}

		const now = Date.now();
		for (const userId of memberUserIds) {
			if (holders.has(userId)) {
				continue;
			}

			await ctx.db.insert("access_control_permission_grants", {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				resourceKind: "file",
				resourceId: String(folder._id),
				principalKind: "user",
				userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
		}

		return null;
	},
});

/**
 * Assert a private channel folder's ACL restriction on itself and cascade it downwards.
 */
async function db_assert_restricted_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		folder: Doc<"files_nodes">;
	},
) {
	if (args.folder.restrictedScopeNodeId === args.folder._id) {
		return;
	}

	await ctx.db.patch("files_nodes", args.folder._id, { restrictedScopeNodeId: args.folder._id });
	await files_nodes_db_cascade_restricted_scope(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.folder._id,
		scopeNodeId: args.folder._id,
	});
}

export const archive_projection_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		channelKey: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return null;
		}
		const { pluginName, state } = live._yay;

		const docs = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.collect();
		const nodeIds = await db_get_active_mapped_node_ids(ctx, {
			organizationId: state.organizationId,
			workspaceId: state.workspaceId,
			pluginName,
			docs,
		});
		if (nodeIds.length > 0) {
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds,
				updatedBy: state.writerUserId,
				now: Date.now(),
			});
		}

		// A private channel's mirrored grants hang off its folder, and the folder map row is the only
		// way back to them. The row is deleted right below, so take the grants now. Left behind they
		// would be unreachable forever: nothing could remove them, and somebody dropped from the
		// channel afterwards would keep reading the archived copy.
		const folderRow = docs.find((doc) => doc.rolloverIndex === plugins_PRIVATE_FOLDER_ROLLOVER_INDEX);
		if (folderRow) {
			const folderGrants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", state.organizationId)
						.eq("workspaceId", state.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", String(folderRow.fileNodeId)),
				)
				.take(MIRROR_GRANT_TAKE);
			await Promise.all(folderGrants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)));
		}

		await Promise.all(docs.map((doc) => ctx.db.delete("plugins_data_projection_files", doc._id)));
		return null;
	},
});

export const archive_projection_node = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		nodeId: v.id("files_nodes"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return null;
		}
		const { pluginName, state } = live._yay;

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", args.nodeId),
			)
			.first();
		if (mapped) {
			const active = await db_get_active_node_by_path(ctx, {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				path: mapped.path,
			});
			// A member may move the file after the action preflight. Drop only the stale map so the
			// action can create one replacement at the old path without archiving the moved copy.
			if (active?._id !== args.nodeId) {
				await ctx.db.delete("plugins_data_projection_files", mapped._id);
				return null;
			}
		}
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (!node || node.organizationId !== state.organizationId || node.workspaceId !== state.workspaceId) {
			return null;
		}
		if (node.projectionPluginName !== undefined && node.projectionPluginName !== pluginName) {
			return null;
		}
		if (node.projectionPluginName !== pluginName) {
			if (mapped) {
				await ctx.db.delete("plugins_data_projection_files", mapped._id);
			}
			return null;
		}

		const lock = node.readOnlyScopeNodeId;
		if (lock !== undefined && lock !== state.rootFolderNodeId && lock !== node._id) {
			return null;
		}

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: [args.nodeId],
			updatedBy: state.writerUserId,
			now: Date.now(),
		});
		if (mapped) {
			await ctx.db.delete("plugins_data_projection_files", mapped._id);
		}
		return null;
	},
});

export const trim_projection_channel_files = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		channelKey: v.string(),
		keepCount: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return null;
		}
		const { pluginName, state } = live._yay;

		const docs = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.collect();
		const extra = docs.filter((doc) => doc.rolloverIndex >= args.keepCount);
		if (extra.length === 0) {
			return null;
		}

		const nodeIds = await db_get_active_mapped_node_ids(ctx, {
			organizationId: state.organizationId,
			workspaceId: state.workspaceId,
			pluginName,
			docs: extra,
		});
		if (nodeIds.length > 0) {
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds,
				updatedBy: state.writerUserId,
				now: Date.now(),
			});
		}
		await Promise.all(extra.map((doc) => ctx.db.delete("plugins_data_projection_files", doc._id)));
		return null;
	},
});

/**
 * Upgrade one legacy mapped file only when its stored hash/asset pair still matches the exact
 * committed text and its plugin lock. A stale map loses its pointer and the normal collision path
 * leaves the live member file untouched.
 */
export const repair_legacy_projection_mapping = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		path: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return null;
		}
		const { installation, pluginName, state } = live._yay;
		const node = await db_get_active_node_by_path(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			path: args.path,
		});
		if (!node) {
			return null;
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", node._id),
			)
			.first();
		if (!mapped) {
			return null;
		}
		if (node.projectionPluginName === pluginName) {
			return null;
		}
		if (node.kind !== "file" || node.projectionPluginName !== undefined) {
			await ctx.db.delete("plugins_data_projection_files", mapped._id);
			return null;
		}

		const requiredLock =
			pluginName === "council"
				? node.readOnlyScopeNodeId === node._id
				: node.readOnlyScopeNodeId === state.rootFolderNodeId;
		let exactContent = false;
		if (
			node.nonCollaborative === true &&
			node.assetId !== undefined &&
			mapped.path === args.path &&
			mapped.contentHash !== undefined &&
			mapped.contentAssetId === node.assetId &&
			requiredLock
		) {
			const chunks = await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", installation.organizationId)
						.eq("workspaceId", installation.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id),
				)
				.collect();
			const text = files_merge_contiguous_chunks(chunks);
			exactContent = text !== null && (await crypto_sha256_hex(text)) === mapped.contentHash;
		}

		if (!exactContent) {
			await ctx.db.delete("plugins_data_projection_files", mapped._id);
			return null;
		}

		await ctx.db.patch("files_nodes", node._id, { projectionPluginName: pluginName });
		return null;
	},
});

export const get_write_preflight = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		path: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			writerUserId: v.id("users"),
			rootFolderNodeId: v.id("files_nodes"),
			occupant: v.union(
				v.object({
					nodeId: v.id("files_nodes"),
					assetId: v.id("files_r2_assets"),
					mapped: v.literal(true),
					channelKey: v.string(),
					rolloverIndex: v.number(),
					contentHash: v.optional(v.string()),
					contentAssetId: v.optional(v.id("files_r2_assets")),
					collaborative: v.boolean(),
					extraLocked: v.boolean(),
				}),
				v.object({
					nodeId: v.id("files_nodes"),
					mapped: v.literal(false),
					adoptable: v.boolean(),
					extraLocked: v.boolean(),
					assetId: v.optional(v.id("files_r2_assets")),
				}),
				v.null(),
			),
		}),
	}),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
			.first();
		if (!state?.rootFolderNodeId) {
			return Result({ _nay: { message: "Projection folder is not ready" } });
		}
		if (state.syncGeneration !== args.syncGeneration) {
			return Result({ _nay: { message: "Projection sync was superseded" } });
		}
		if (args.expectedProjectionStateId !== undefined && state._id !== args.expectedProjectionStateId) {
			return Result({ _nay: { message: "Projection sync was superseded" } });
		}

		const occupant = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (!occupant) {
			return Result({
				_yay: {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					writerUserId: state.writerUserId,
					rootFolderNodeId: state.rootFolderNodeId,
					occupant: null,
				},
			});
		}
		if (occupant.kind !== "file") {
			return Result({
				_yay: {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					writerUserId: state.writerUserId,
					rootFolderNodeId: state.rootFolderNodeId,
					occupant: {
						nodeId: occupant._id,
						mapped: false as const,
						adoptable: false,
						extraLocked: false,
					},
				},
			});
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", occupant._id),
			)
			.first();
		if (!mapped || occupant.assetId === undefined) {
			// Public file doors can create the same lock shape. Require the internal stamp too.
			const adoptable =
				occupant.nonCollaborative === true &&
				occupant.assetId !== undefined &&
				occupant.projectionPluginName === state.pluginName &&
				(state.pluginName === "council"
					? occupant.readOnlyScopeNodeId === occupant._id
					: occupant.readOnlyScopeNodeId === state.rootFolderNodeId);
			return Result({
				_yay: {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					writerUserId: state.writerUserId,
					rootFolderNodeId: state.rootFolderNodeId,
					occupant: {
						nodeId: occupant._id,
						mapped: false as const,
						adoptable,
						extraLocked: projection_file_is_extra_locked({
							pluginName: state.pluginName,
							mapped: false,
							lock: occupant.readOnlyScopeNodeId,
							nodeId: occupant._id,
							rootFolderNodeId: state.rootFolderNodeId,
						}),
						...(occupant.assetId !== undefined ? { assetId: occupant.assetId } : {}),
					},
				},
			});
		}
		if (occupant.projectionPluginName !== state.pluginName) {
			// A map row alone is not ownership. The write path may stamp a legacy file only after
			// matching its exact expected hash, bound asset, and projection lock.
			return Result({
				_yay: {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					writerUserId: state.writerUserId,
					rootFolderNodeId: state.rootFolderNodeId,
					occupant: {
						nodeId: occupant._id,
						mapped: false as const,
						adoptable: false,
						extraLocked: projection_file_is_extra_locked({
							pluginName: state.pluginName,
							mapped: false,
							lock: occupant.readOnlyScopeNodeId,
							nodeId: occupant._id,
							rootFolderNodeId: state.rootFolderNodeId,
						}),
						assetId: occupant.assetId,
					},
				},
			});
		}
		return Result({
			_yay: {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				writerUserId: state.writerUserId,
				rootFolderNodeId: state.rootFolderNodeId,
				occupant: {
					nodeId: occupant._id,
					assetId: occupant.assetId,
					mapped: true as const,
					channelKey: mapped.channelKey,
					rolloverIndex: mapped.rolloverIndex,
					contentHash: mapped.contentHash,
					contentAssetId: mapped.contentAssetId,
					collaborative: occupant.nonCollaborative !== true,
					extraLocked: projection_file_is_extra_locked({
						pluginName: state.pluginName,
						mapped: true,
						lock: occupant.readOnlyScopeNodeId,
						nodeId: occupant._id,
						rootFolderNodeId: state.rootFolderNodeId,
					}),
				},
			},
		});
	},
});

export const insert_projection_file_node = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		path: v.string(),
		text: v.string(),
		textSize: v.number(),
		contentSnapshotAssetId: v.id("files_r2_assets"),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.number(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, pluginName, writerUserId, state } = ready;
		if (
			pluginName === "chitchat" &&
			args.channelKey !== README_CHANNEL_KEY &&
			(args.channelKey === undefined ||
				!(await plugins_projections_chitchat_db_channel_is_live(ctx, args.installationId, args.channelKey)))
		) {
			return Result({ _nay: { message: "Projection source is no longer live" } });
		}
		if (!state.rootFolderNodeId) {
			return Result({ _nay: { message: "Projection folder is not ready" } });
		}

		const rootFolder = await ctx.db.get("files_nodes", state.rootFolderNodeId);
		const rootLocked =
			rootFolder !== null &&
			rootFolder.projectionPluginName === pluginName &&
			rootFolder.readOnlyScopeNodeId === rootFolder._id;
		const now = Date.now();
		const contentHash = await crypto_sha256_hex(args.text);
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: writerUserId,
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			assetId: args.contentSnapshotAssetId,
			expectsTextContent: true,
			projectionPluginName: pluginName,
			...(rootLocked ? { skipAccessControlAndLock: true as const, inheritParentReadOnlyScope: true as const } : {}),
			now,
		});
		if (created._nay) {
			return Result({ _nay: { message: created._nay.message } });
		}

		await files_nodes_db_insert_file_content_docs(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			nodeId: created._yay,
			path: args.path,
			contentType: "text/markdown;charset=utf-8",
			rootKind: "rich_text",
			textContent: args.text,
			readOnly: false,
			nonCollaborative: true,
			userId: writerUserId,
			now,
		});
		await files_nodes_db_finalize_editable_text_node_creation(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			nodeId: created._yay,
			userId: writerUserId,
			versionSnapshotAssetId: args.contentSnapshotAssetId,
			versionSnapshotSize: args.textSize,
		});

		// Council notes sit under a writable `/meetings` folder. Lock only this file so a later
		// recording upload into the same meeting folder is not frozen.
		if (pluginName === "council") {
			await ctx.db.patch("files_nodes", created._yay, {
				readOnlyScopeNodeId: created._yay,
				readOnlyPluginServiceTargetId: undefined,
			});
		}

		if (args.channelKey !== undefined) {
			const channelKey = args.channelKey;
			const existingMap = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q
						.eq("installationId", args.installationId)
						.eq("channelKey", channelKey)
						.eq("rolloverIndex", args.rolloverIndex),
				)
				.first();
			if (existingMap) {
				await ctx.db.patch("plugins_data_projection_files", existingMap._id, {
					fileNodeId: created._yay,
					path: args.path,
					contentHash,
					contentAssetId: args.contentSnapshotAssetId,
					updatedAt: now,
				});
			} else {
				await ctx.db.insert("plugins_data_projection_files", {
					organizationId: installation.organizationId,
					workspaceId: installation.workspaceId,
					installationId: args.installationId,
					channelKey: args.channelKey,
					fileNodeId: created._yay,
					rolloverIndex: args.rolloverIndex,
					path: args.path,
					contentHash,
					contentAssetId: args.contentSnapshotAssetId,
					updatedAt: now,
				});
			}
		}

		return Result({ _yay: { nodeId: created._yay } });
	},
});

/**
 * Point the projection file map at an existing non-collaborative leftover file.
 * Reinstall uses this so a frozen snapshot is reused instead of a collision name.
 */
export const map_projection_file = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		nodeId: v.id("files_nodes"),
		path: v.string(),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		const channelKey = args.channelKey;
		if (live._nay || channelKey === undefined) {
			return null;
		}

		const ready = live._yay;
		if (!ready) {
			return null;
		}

		const { installation, pluginName, state } = ready;
		const node = await ctx.db.get("files_nodes", args.nodeId);
		const active = await db_get_active_node_by_path(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			path: args.path,
		});
		const lockMatches =
			node !== null &&
			(pluginName === "council"
				? node.readOnlyScopeNodeId === node._id
				: node.readOnlyScopeNodeId === state.rootFolderNodeId);
		if (
			!node ||
			node.kind !== "file" ||
			node.nonCollaborative !== true ||
			node.assetId === undefined ||
			node.projectionPluginName !== pluginName ||
			active?._id !== node._id ||
			!lockMatches
		) {
			return null;
		}
		const now = Date.now();
		const existingMap = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q
					.eq("installationId", args.installationId)
					.eq("channelKey", channelKey)
					.eq("rolloverIndex", args.rolloverIndex),
			)
			.first();
		if (existingMap) {
			await ctx.db.patch("plugins_data_projection_files", existingMap._id, {
				fileNodeId: args.nodeId,
				path: args.path,
				contentHash: undefined,
				contentAssetId: undefined,
				updatedAt: now,
			});
			return null;
		}

		await ctx.db.insert("plugins_data_projection_files", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: args.installationId,
			channelKey,
			fileNodeId: args.nodeId,
			rolloverIndex: args.rolloverIndex,
			path: args.path,
			contentHash: undefined,
			contentAssetId: undefined,
			updatedAt: now,
		});
		return null;
	},
});

export const finalize_projection_replace = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		expectedProjectionStateId: v.optional(v.id("plugins_data_projection_states")),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		textSize: v.number(),
		baseAssetId: v.id("files_r2_assets"),
		versionSnapshotAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(
			ctx,
			args.installationId,
			args.syncGeneration,
			args.expectedProjectionStateId,
		);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, pluginName, writerUserId, state } = ready;
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== installation.organizationId ||
			fileNode.workspaceId !== installation.workspaceId ||
			fileNode.nonCollaborative !== true
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", args.nodeId),
			)
			.first();
		if (!mapped) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			pluginName === "chitchat" &&
			mapped.channelKey !== README_CHANNEL_KEY &&
			!(await plugins_projections_chitchat_db_channel_is_live(ctx, args.installationId, mapped.channelKey))
		) {
			return Result({ _nay: { message: "Projection source is no longer live" } });
		}
		const active = await db_get_active_node_by_path(ctx, {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			path: mapped.path,
		});
		if (active?._id !== fileNode._id) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (fileNode.projectionPluginName !== pluginName) {
			return Result({ _nay: { message: "Projection file ownership mismatch" } });
		}

		if (!projection_replace_lock_ok(pluginName, fileNode, state.rootFolderNodeId)) {
			return Result({ _nay: { message: "This item is read-only." } });
		}

		if (fileNode.assetId !== args.baseAssetId) {
			return Result({
				_nay: {
					message: "This file changed while you were saving. Copy your local changes before reloading, then try again.",
				},
			});
		}

		const now = Date.now();
		const contentHash = await crypto_sha256_hex(args.text);
		await Promise.all([
			ctx.db.patch("files_nodes", args.nodeId, {
				assetId: args.versionSnapshotAssetId,
				updatedBy: writerUserId,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: installation.organizationId,
					workspaceId: installation.workspaceId,
					assetId: args.versionSnapshotAssetId,
				}),
				size: args.textSize,
				unfinalizedExpiresAt: undefined,
				updatedAt: now,
			}),
			db_replace_file_chunks(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				nodeId: args.nodeId,
				textContent: args.text,
			}),
			ctx.db.insert("files_snapshots", {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				fileNodeId: args.nodeId,
				assetId: args.versionSnapshotAssetId,
				createdBy: writerUserId,
				archivedAt: -1,
			}),
			...(mapped
				? [
						ctx.db.patch("plugins_data_projection_files", mapped._id, {
							contentHash,
							contentAssetId: args.versionSnapshotAssetId,
							updatedAt: now,
						}),
					]
				: []),
		]);

		return Result({ _yay: { nodeId: args.nodeId } });
	},
});

async function create_projection_file(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		expectedProjectionStateId?: Id<"plugins_data_projection_states">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		writerUserId: Id<"users">;
		path: string;
		text: string;
		textSize: number;
		channelKey?: string;
		rolloverIndex: number;
	},
) {
	const contentSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		kind: "content_snapshot",
		size: args.textSize,
		createdBy: args.writerUserId,
	})) as Id<"files_r2_assets">;
	const r2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: contentSnapshotAssetId,
	});
	await r2_put_object(ctx, {
		key: r2Key,
		body: args.text,
		contentType: "text/markdown;charset=utf-8",
	});

	const created = (await ctx.runMutation(internal.plugins_projections.insert_projection_file_node, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		expectedProjectionStateId: args.expectedProjectionStateId,
		path: args.path,
		text: args.text,
		textSize: args.textSize,
		contentSnapshotAssetId,
		channelKey: args.channelKey,
		rolloverIndex: args.rolloverIndex,
	})) as insert_projection_file_node_Result;
	if (created._nay) {
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds: [contentSnapshotAssetId],
			r2Keys: [r2Key],
			durableTenantScope: {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			},
		});
		return created;
	}

	return created;
}

async function replace_projection_file(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		syncGeneration: number;
		expectedProjectionStateId?: Id<"plugins_data_projection_states">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		writerUserId: Id<"users">;
		rootFolderNodeId: Id<"files_nodes">;
		nodeId: Id<"files_nodes">;
		baseAssetId: Id<"files_r2_assets">;
		text: string;
		textSize: number;
	},
) {
	const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		kind: "content_snapshot",
		size: args.textSize,
		createdBy: args.writerUserId,
	})) as Id<"files_r2_assets">;
	const r2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: versionSnapshotAssetId,
	});
	await r2_put_object(ctx, {
		key: r2Key,
		body: args.text,
		contentType: "text/markdown;charset=utf-8",
	});

	const finalized = (await ctx.runMutation(internal.plugins_projections.finalize_projection_replace, {
		installationId: args.installationId,
		syncGeneration: args.syncGeneration,
		expectedProjectionStateId: args.expectedProjectionStateId,
		nodeId: args.nodeId,
		text: args.text,
		textSize: args.textSize,
		baseAssetId: args.baseAssetId,
		versionSnapshotAssetId,
	})) as finalize_projection_replace_Result;
	if (finalized._nay) {
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds: [versionSnapshotAssetId],
			r2Keys: [r2Key],
			durableTenantScope: {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			},
		});
		return finalized;
	}

	return Result({ _yay: { nodeId: args.nodeId } });
}

type get_write_preflight_Result = {
	_yay?: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		writerUserId: Id<"users">;
		rootFolderNodeId: Id<"files_nodes">;
		occupant:
			| {
					nodeId: Id<"files_nodes">;
					assetId: Id<"files_r2_assets">;
					mapped: true;
					channelKey: string;
					rolloverIndex: number;
					contentHash?: string;
					contentAssetId?: Id<"files_r2_assets">;
					collaborative: boolean;
					extraLocked: boolean;
			  }
			| {
					nodeId: Id<"files_nodes">;
					mapped: false;
					adoptable: boolean;
					extraLocked: boolean;
					assetId?: Id<"files_r2_assets">;
			  }
			| null;
	};
	_nay?: { name?: string; message: string };
};

type insert_projection_file_node_Result = {
	_yay?: { nodeId: Id<"files_nodes"> };
	_nay?: { name?: string; message: string };
};

type finalize_projection_replace_Result = insert_projection_file_node_Result;

/**
 * Chitchat files inherit the locked `/chitchat` folder. Mapped Council files must lock themselves
 * under a writable `/meetings` folder. A missing direct lock is repair work, not a valid hash match.
 */
function projection_file_is_extra_locked(args: {
	pluginName: string;
	mapped: boolean;
	lock: Id<"files_nodes"> | undefined;
	nodeId: Id<"files_nodes">;
	rootFolderNodeId: Id<"files_nodes">;
}) {
	if (args.pluginName === "council") {
		return args.mapped
			? args.lock !== args.nodeId
			: args.lock !== undefined && args.lock !== args.nodeId && args.lock !== args.rootFolderNodeId;
	}

	return args.lock !== args.rootFolderNodeId;
}

function projection_replace_lock_ok(
	pluginName: string,
	fileNode: Doc<"files_nodes">,
	rootFolderNodeId: Id<"files_nodes"> | undefined,
) {
	if (rootFolderNodeId === undefined) {
		return false;
	}
	if (fileNode.projectionPluginName !== pluginName) {
		return false;
	}

	if (fileNode.readOnlyScopeNodeId === rootFolderNodeId) {
		return true;
	}

	return pluginName === "council" && fileNode.readOnlyScopeNodeId === fileNode._id;
}

/**
 * Keep this check in the mutation that removes a dirty marker. A save, move, or archive after the
 * action-side preflight must make completion fail so Convex retries the channel later.
 */
export async function plugins_projections_files_are_current(
	ctx: MutationCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		channelKey: string;
		files: plugins_ProjectionExpectedFile[];
		expectedProjectionStateId?: Id<"plugins_data_projection_states">;
	},
) {
	const state = await db_get_projection_state(ctx, args.installationId);
	if (!state?.rootFolderNodeId) {
		return false;
	}
	if (args.expectedProjectionStateId !== undefined && state._id !== args.expectedProjectionStateId) {
		return false;
	}
	if (state.pluginName === "chitchat") {
		const root = await ctx.db.get("files_nodes", state.rootFolderNodeId);
		if (
			!root ||
			root.projectionPluginName !== "chitchat" ||
			root.readOnlyScopeNodeId !== root._id ||
			root.archiveOperationId !== undefined
		) {
			return false;
		}
	}

	const mappedFiles = (
		await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.collect()
	).filter((mapped) => mapped.rolloverIndex !== plugins_PRIVATE_FOLDER_ROLLOVER_INDEX);
	if (mappedFiles.length !== args.files.length) {
		return false;
	}

	const expectedByRollover = new Map(args.files.map((file) => [file.rolloverIndex, file]));
	const mappedByRollover = new Map(mappedFiles.map((mapped) => [mapped.rolloverIndex, mapped]));
	if (expectedByRollover.size !== args.files.length || mappedByRollover.size !== mappedFiles.length) {
		return false;
	}

	const activeMatches = await Promise.all(
		args.files.map(async (expected) => {
			const mapped = mappedByRollover.get(expected.rolloverIndex);
			if (
				!mapped ||
				mapped.path !== expected.path ||
				mapped.contentHash === undefined ||
				mapped.contentAssetId === undefined
			) {
				return false;
			}

			const activeNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", mapped.organizationId)
						.eq("workspaceId", mapped.workspaceId)
						.eq("path", expected.path)
						.eq("archiveOperationId", undefined),
				)
				.first();
			return (
				activeNode?._id === mapped.fileNodeId &&
				activeNode.nonCollaborative === true &&
				activeNode.projectionPluginName === state.pluginName &&
				projection_replace_lock_ok(state.pluginName, activeNode, state.rootFolderNodeId) &&
				activeNode.assetId !== undefined &&
				activeNode.assetId === mapped.contentAssetId
			);
		}),
	);
	return activeMatches.every(Boolean) && (await db_private_folder_acl_is_current(ctx, state, args.channelKey));
}

async function db_private_folder_acl_is_current(
	ctx: MutationCtx,
	state: Doc<"plugins_data_projection_states">,
	channelKey: string,
) {
	const folderMap = await ctx.db
		.query("plugins_data_projection_files")
		.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
			q
				.eq("installationId", state.installationId)
				.eq("channelKey", channelKey)
				.eq("rolloverIndex", plugins_PRIVATE_FOLDER_ROLLOVER_INDEX),
		)
		.first();
	if (!folderMap) {
		return true;
	}
	if (state.pluginName !== "chitchat" || !state.rootFolderNodeId) {
		return false;
	}

	const folder = await db_get_active_node_by_path(ctx, {
		organizationId: state.organizationId,
		workspaceId: state.workspaceId,
		path: folderMap.path,
	});
	if (
		folder?._id !== folderMap.fileNodeId ||
		folder.kind !== "folder" ||
		folder.projectionPluginName !== "chitchat" ||
		folder.readOnlyScopeNodeId !== state.rootFolderNodeId ||
		folder.restrictedScopeNodeId !== folder._id
	) {
		return false;
	}

	const scopeResourceId = `${state.installationId}:${channelKey}`;
	const [scopeGrants, folderGrants] = await Promise.all([
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("resourceKind", "plugin_scope")
					.eq("resourceId", scopeResourceId),
			)
			.take(MIRROR_GRANT_TAKE),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", state.organizationId)
					.eq("workspaceId", state.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(folder._id)),
			)
			.take(MIRROR_GRANT_TAKE),
	]);
	const expectedUsers = new Set(scopeGrants.flatMap((grant) => (grant.userId ? [grant.userId] : [])));
	const actualUsers = new Set<Id<"users">>();
	for (const grant of folderGrants) {
		if (
			grant.principalKind !== "user" ||
			grant.userId === undefined ||
			grant.permission !== "content.read" ||
			actualUsers.has(grant.userId)
		) {
			return false;
		}
		actualUsers.add(grant.userId);
	}
	return expectedUsers.size === actualUsers.size && [...expectedUsers].every((userId) => actualUsers.has(userId));
}

async function db_ensure_projection_state(ctx: MutationCtx, installation: Doc<"plugins_workspace_installations">) {
	const existing = await db_get_projection_state(ctx, installation._id);
	if (existing) {
		return existing;
	}

	const organization = await ctx.db.get("organizations", installation.organizationId);
	if (!organization) {
		throw new Error("Installation organization is missing");
	}

	const now = Date.now();
	const stateId = await ctx.db.insert("plugins_data_projection_states", {
		organizationId: installation.organizationId,
		workspaceId: installation.workspaceId,
		installationId: installation._id,
		pluginName: installation.pluginName,
		writerUserId: organization.ownerUserId,
		cursors: {},
		scanCursors: {},
		syncGeneration: 0,
		dirty: true,
		updatedAt: now,
	});
	const created = await ctx.db.get("plugins_data_projection_states", stateId);
	if (!created) {
		throw new Error("Projection state missing after insert");
	}

	return created;
}

async function db_get_projection_state(ctx: MutationCtx, installationId: Id<"plugins_workspace_installations">) {
	return await ctx.db
		.query("plugins_data_projection_states")
		.withIndex("by_installation", (q) => q.eq("installationId", installationId))
		.first();
}

async function db_require_live_state(
	ctx: MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
	syncGeneration: number,
	expectedProjectionStateId?: Id<"plugins_data_projection_states">,
) {
	const installation = await ctx.db.get("plugins_workspace_installations", installationId);
	const pluginName = installation?.pluginName;
	if (
		!installation ||
		installation.status === "disabled" ||
		!pluginName ||
		!plugins_projections_is_registered(pluginName)
	) {
		return Result({ _nay: { message: "Installation gone" } });
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", installation.organizationId),
		ctx.db.get("organizations_workspaces", installation.workspaceId),
	]);
	if (
		!organization ||
		!workspace ||
		workspace.organizationId !== installation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const state = await db_get_projection_state(ctx, installationId);
	if (!state) {
		return Result({ _nay: { message: "Missing projection state" } });
	}
	// Scheduled actions may keep running after cancellation. Refuse stale generations in the
	// same transaction that would change projection files, maps, folders, or grants.
	if (state.syncGeneration !== syncGeneration) {
		return Result({ _nay: { message: "Projection sync was superseded" } });
	}
	if (expectedProjectionStateId !== undefined && state._id !== expectedProjectionStateId) {
		return Result({ _nay: { message: "Projection sync was superseded" } });
	}

	return Result({
		_yay: { installation, pluginName, organization, writerUserId: state.writerUserId, state },
	});
}

async function db_get_active_node_by_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		path: string;
	},
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.first();
}

async function db_get_active_mapped_node_ids(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		pluginName: plugins_ProjectionPluginName;
		docs: Doc<"plugins_data_projection_files">[];
	},
) {
	const matches = await Promise.all(
		args.docs.map(async (doc) => {
			const active = await db_get_active_node_by_path(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				path: doc.path,
			});
			if (active?._id !== doc.fileNodeId) {
				return null;
			}
			if (active.projectionPluginName !== args.pluginName) {
				return null;
			}
			return doc.fileNodeId;
		}),
	);

	return matches.filter((nodeId): nodeId is Id<"files_nodes"> => nodeId !== null);
}
