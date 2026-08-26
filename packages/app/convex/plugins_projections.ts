import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
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
import { r2_create_asset_key, r2_put_object } from "./r2_client.ts";
import {
	files_nodes_db_archive_nodes,
	files_nodes_db_cascade_read_only_scope,
	files_nodes_db_create_node_recursively_at_path,
} from "./files_nodes.ts";
import {
	db_replace_file_chunks,
	files_nodes_db_finalize_editable_text_node_creation,
	files_nodes_db_insert_file_content_docs,
} from "./files_nodes_content.ts";
import { plugins_projections_is_registered } from "./plugins_projections_registry.ts";
import { collision_slug, ROOT_FOLDER_PATH, rollover_path } from "./plugins_projections_chitchat.ts";

const DEBOUNCE_MS = 2000;
const HOURLY_INSTALLATION_TAKE = 20;

export const schedule_sync = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation || installation.status === "disabled") {
			return null;
		}
		if (!plugins_projections_is_registered(installation.pluginName)) {
			return null;
		}

		const state = await db_ensure_projection_state(ctx, installation);
		if (state.scheduledJobId) {
			await ctx.scheduler.cancel(state.scheduledJobId);
		}

		const syncGeneration = state.syncGeneration + 1;
		const scheduledJobId = await ctx.scheduler.runAfter(DEBOUNCE_MS, internal.plugins_projections_chitchat.sync, {
			installationId: installation._id,
			syncGeneration,
		});
		await ctx.db.patch("plugins_data_projection_states", state._id, {
			dirty: true,
			syncGeneration,
			scheduledJobId,
			updatedAt: Date.now(),
		});
		return null;
	},
});

export const ensure_hourly = internalMutation({
	args: {
		afterId: v.optional(v.id("plugins_workspace_installations")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const indexed = ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
			.order("asc");
		const installations =
			args.afterId === undefined
				? await indexed.take(HOURLY_INSTALLATION_TAKE)
				: await indexed.filter((q) => q.gt(q.field("_id"), args.afterId!)).take(HOURLY_INSTALLATION_TAKE);

		for (const installation of installations) {
			if (installation.status === "disabled") {
				continue;
			}

			const state = await db_ensure_projection_state(ctx, installation);
			const dirtyChannel = await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", installation._id))
				.first();
			// Do not treat a cleared `scheduledJobId` as work. After a successful sync that field is
			// empty on purpose. Schedule again only when the folder was never created, the write door
			// left `dirty`, or a channel rebuild is still queued.
			const needsSync = state.rootFolderNodeId === undefined || state.dirty || dirtyChannel !== null;
			if (!needsSync) {
				continue;
			}

			await ctx.scheduler.runAfter(0, internal.plugins_projections.schedule_sync, {
				installationId: installation._id,
			});
		}

		if (installations.length === HOURLY_INSTALLATION_TAKE) {
			const last = installations[installations.length - 1];
			if (last) {
				await ctx.scheduler.runAfter(0, internal.plugins_projections.ensure_hourly, {
					afterId: last._id,
				});
			}
		}

		return null;
	},
});

export const finish_sync = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		syncGeneration: v.number(),
		continueImmediately: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state || state.syncGeneration !== args.syncGeneration) {
			return null;
		}

		const dirtyChannel = await ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) => q.eq("installationId", args.installationId))
			.first();
		// Immediate continue is only for a successful sync that still has channels left in this
		// generation. A failed write keeps the dirty-channel doc. Scheduling that same generation
		// again at 0ms would spin. The next user write or the hourly ensure starts a new debounce.
		if (args.continueImmediately) {
			const scheduledJobId = await ctx.scheduler.runAfter(0, internal.plugins_projections_chitchat.sync, {
				installationId: args.installationId,
				syncGeneration: args.syncGeneration,
			});
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				scheduledJobId,
				dirty: dirtyChannel !== null,
				updatedAt: Date.now(),
			});
			return null;
		}

		await ctx.db.patch("plugins_data_projection_states", state._id, {
			scheduledJobId: undefined,
			dirty: dirtyChannel !== null,
			updatedAt: Date.now(),
		});
		return null;
	},
});

export const ensure_projection_root = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v_result({ _yay: v.object({ folderNodeId: v.id("files_nodes"), folderPath: v.string() }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId);
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
			if (occupant.kind === "folder" && occupant.readOnlyScopeNodeId === occupant._id) {
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

type write_projection_markdown_Result = {
	_yay?: { nodeId: Id<"files_nodes"> };
	_nay?: { name?: string; message: string };
};

type write_projection_channel_files_Result = {
	_yay?: null;
	_nay?: { name?: string; message: string };
};

export const write_projection_markdown = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		path: v.string(),
		text: v.string(),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args): Promise<write_projection_markdown_Result> => {
		const text = files_normalize_text_document_input(args.text);
		const textSize = files_get_utf8_byte_size(text);
		if (textSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
			installationId: args.installationId,
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

		if (occupant?.mapped === true && occupant.channelKey !== args.channelKey) {
			return Result({ _nay: { message: "Path is occupied by another projected file" } });
		}

		const extraLocked = occupant?.extraLocked === true;
		const collaborative = occupant?.mapped === true && occupant.collaborative;
		if (occupant && (collaborative || extraLocked)) {
			await ctx.runMutation(internal.plugins_projections.archive_projection_node, {
				installationId: args.installationId,
				nodeId: occupant.nodeId,
			});
		} else if (occupant?.mapped === true) {
			return await replace_projection_file(ctx, {
				installationId: args.installationId,
				organizationId,
				workspaceId,
				writerUserId,
				rootFolderNodeId,
				nodeId: occupant.nodeId,
				baseAssetId: occupant.assetId,
				text,
				textSize,
			});
		} else if (occupant?.mapped === false && occupant.adoptable && occupant.assetId !== undefined) {
			await ctx.runMutation(internal.plugins_projections.map_projection_file, {
				installationId: args.installationId,
				nodeId: occupant.nodeId,
				path: args.path,
				channelKey: args.channelKey,
				rolloverIndex: args.rolloverIndex ?? 0,
			});
			return await replace_projection_file(ctx, {
				installationId: args.installationId,
				organizationId,
				workspaceId,
				writerUserId,
				rootFolderNodeId,
				nodeId: occupant.nodeId,
				baseAssetId: occupant.assetId,
				text,
				textSize,
			});
		}

		return await create_projection_file(ctx, {
			installationId: args.installationId,
			organizationId,
			workspaceId,
			writerUserId,
			path: args.path,
			text,
			textSize,
			channelKey: args.channelKey,
			rolloverIndex: args.rolloverIndex ?? 0,
		});
	},
});

export const write_projection_channel_files = internalAction({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		channelKey: v.string(),
		slug: v.string(),
		folderPath: v.string(),
		texts: v.array(v.string()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<write_projection_channel_files_Result> => {
		const fileCount = args.texts.length;
		for (let oldestIndex = 0; oldestIndex < fileCount; oldestIndex += 1) {
			const rolloverIndex = fileCount - 1 - oldestIndex;
			const text = args.texts[oldestIndex];
			if (text === undefined) {
				continue;
			}

			let path = rollover_path(args.folderPath, args.slug, rolloverIndex);
			const preflight = (await ctx.runQuery(internal.plugins_projections.get_write_preflight, {
				installationId: args.installationId,
				path,
			})) as get_write_preflight_Result;
			if (
				preflight._yay &&
				preflight._yay.occupant &&
				((preflight._yay.occupant.mapped === false && preflight._yay.occupant.adoptable !== true) ||
					(preflight._yay.occupant.mapped === true && preflight._yay.occupant.channelKey !== args.channelKey))
			) {
				path = rollover_path(args.folderPath, collision_slug(args.slug, args.channelKey), rolloverIndex);
			}

			const written = await ctx.runAction(internal.plugins_projections.write_projection_markdown, {
				installationId: args.installationId,
				path,
				text,
				channelKey: args.channelKey,
				rolloverIndex,
			});
			if (written._nay) {
				return Result({ _nay: { message: written._nay.message } });
			}
		}

		await ctx.runMutation(internal.plugins_projections.trim_projection_channel_files, {
			installationId: args.installationId,
			channelKey: args.channelKey,
			keepCount: fileCount,
		});
		return Result({ _yay: null });
	},
});

export const archive_projection_channel = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		channelKey: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return null;
		}

		const docs = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", args.installationId).eq("channelKey", args.channelKey),
			)
			.collect();
		const nodeIds = docs.map((doc) => doc.fileNodeId);
		if (nodeIds.length > 0) {
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds,
				updatedBy: state.writerUserId,
				now: Date.now(),
			});
		}

		await Promise.all(docs.map((doc) => ctx.db.delete("plugins_data_projection_files", doc._id)));
		return null;
	},
});

export const archive_projection_node = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return null;
		}

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", args.nodeId),
			)
			.first();
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.organizationId !== state.organizationId ||
			node.workspaceId !== state.workspaceId
		) {
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
		channelKey: v.string(),
		keepCount: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await db_get_projection_state(ctx, args.installationId);
		if (!state) {
			return null;
		}

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

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: extra.map((doc) => doc.fileNodeId),
			updatedBy: state.writerUserId,
			now: Date.now(),
		});
		await Promise.all(extra.map((doc) => ctx.db.delete("plugins_data_projection_files", doc._id)));
		return null;
	},
});

export const get_write_preflight = internalQuery({
	args: {
		installationId: v.id("plugins_workspace_installations"),
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
		if (!occupant || occupant.kind !== "file") {
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

		const mapped = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_fileNodeId", (q) =>
				q.eq("installationId", args.installationId).eq("fileNodeId", occupant._id),
			)
			.first();
		if (!mapped || occupant.assetId === undefined) {
			return Result({
				_yay: {
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					writerUserId: state.writerUserId,
					rootFolderNodeId: state.rootFolderNodeId,
					occupant: {
						nodeId: occupant._id,
						mapped: false as const,
						adoptable: occupant.nonCollaborative === true && occupant.assetId !== undefined,
						extraLocked: occupant.readOnlyScopeNodeId !== state.rootFolderNodeId,
						...(occupant.assetId !== undefined ? { assetId: occupant.assetId } : {}),
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
					collaborative: occupant.nonCollaborative !== true,
					extraLocked: occupant.readOnlyScopeNodeId !== state.rootFolderNodeId,
				},
			},
		});
	},
});

export const insert_projection_file_node = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		path: v.string(),
		text: v.string(),
		textSize: v.number(),
		contentSnapshotAssetId: v.id("files_r2_assets"),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.number(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, writerUserId, state } = ready;
		if (!state.rootFolderNodeId) {
			return Result({ _nay: { message: "Projection folder is not ready" } });
		}

		const now = Date.now();
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
			skipAccessControlAndLock: true,
			inheritParentReadOnlyScope: true,
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
		nodeId: v.id("files_nodes"),
		path: v.string(),
		channelKey: v.optional(v.string()),
		rolloverIndex: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId);
		const channelKey = args.channelKey;
		if (live._nay || channelKey === undefined) {
			return null;
		}

		const ready = live._yay;
		if (!ready) {
			return null;
		}

		const { installation } = ready;
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
			updatedAt: now,
		});
		return null;
	},
});

export const finalize_projection_replace = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		textSize: v.number(),
		baseAssetId: v.id("files_r2_assets"),
		versionSnapshotAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const live = await db_require_live_state(ctx, args.installationId);
		if (live._nay) {
			return live;
		}

		const ready = live._yay;
		if (!ready) {
			return Result({ _nay: { message: "Installation gone" } });
		}

		const { installation, writerUserId, state } = ready;
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== installation.organizationId ||
			fileNode.workspaceId !== installation.workspaceId ||
			fileNode.nonCollaborative !== true
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (fileNode.readOnlyScopeNodeId !== state.rootFolderNodeId) {
			return Result({ _nay: { message: "This item is read-only." } });
		}

		if (fileNode.assetId !== args.baseAssetId) {
			return Result({
				_nay: { message: "This file changed while you were saving. Copy your local changes before reloading, then try again." },
			});
		}

		const now = Date.now();
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
		]);

		return Result({ _yay: { nodeId: args.nodeId } });
	},
});

async function create_projection_file(
	ctx: ActionCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
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

async function db_require_live_state(ctx: MutationCtx, installationId: Id<"plugins_workspace_installations">) {
	const installation = await ctx.db.get("plugins_workspace_installations", installationId);
	if (!installation || installation.status === "disabled" || !plugins_projections_is_registered(installation.pluginName)) {
		return Result({ _nay: { message: "Installation gone" } });
	}

	const organization = await ctx.db.get("organizations", installation.organizationId);
	if (!organization) {
		return Result({ _nay: { message: "Not found" } });
	}

	const state = await db_get_projection_state(ctx, installationId);
	if (!state) {
		return Result({ _nay: { message: "Missing projection state" } });
	}

	return Result({
		_yay: { installation, organization, writerUserId: state.writerUserId, state },
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
