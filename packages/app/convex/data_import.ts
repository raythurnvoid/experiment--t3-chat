// One-off data-import backend for operator-driven bulk imports (currently the Sybill export).
//
// Internal functions only: the import CLI invokes them through `convex run` with the deployment
// admin session, never from app clients. Text files go through the public API write route; this
// module is the binary door, because the public API has no upload route.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import { Result } from "common/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_MAX_UPLOADS_BYTES, files_ROOT_ID } from "../server/files.ts";
import { files_normalize_name, files_normalize_upload_file_name } from "../shared/files.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import { files_nodes_db_archive_nodes, files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { r2_create_asset_key, r2_generate_upload_url, r2_get_bucket } from "./r2_client.ts";

/**
 * Create upload nodes and presigned R2 PUT urls for a batch of binary files.
 *
 * Mirrors the guards of `files_nodes.create_upload_node`, but authorizes as an operator
 * entrypoint: there is no `ctx.auth` identity, so the call is anchored to the organization
 * owner instead. A wrong `createdBy` cannot attribute imported content to another user.
 *
 * Created assets get `processingWorkId: null`, so the R2 event finalizer records the object
 * without starting Markdown conversion or plugin dispatch (it only starts them when the field
 * is still undefined).
 */
export const create_upload_targets = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdBy: v.id("users"),
		items: v.array(
			v.object({
				path: v.string(),
				contentType: v.string(),
				size: v.number(),
			}),
		),
	},
	returns: v_result({
		_yay: v.array(
			v.object({
				path: v.string(),
				assetId: v.id("files_r2_assets"),
				nodeId: v.id("files_nodes"),
				uploadUrl: v.string(),
				headers: v.record(v.string(), v.string()),
			}),
		),
		_nay: {
			data: v.object({ path: v.string() }),
		},
	}),
	handler: async (ctx, args) => {
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (organization.ownerUserId !== args.createdBy) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
		if (!workspace || workspace.organizationId !== args.organizationId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Validate the whole batch before any write. A `_nay` return does not roll back earlier
		// writes in the same mutation, so every fallible check runs first and the write pass below
		// only throws for impossible states (throwing does roll back).
		const leafPaths = new Set<string>();
		const validated: Array<{
			path: string;
			contentType: string;
			size: number;
			collidingNodeId: Id<"files_nodes"> | null;
		}> = [];
		for (const item of args.items) {
			// Require already-canonical paths, like the public API write route: the CLI runs the
			// app normalizer up front, and accepting near-canonical input here would create nodes
			// the app's own creation flows would reject.
			if (!item.path.startsWith("/") || item.path === "/" || server_path_normalize(item.path) !== item.path) {
				return Result({ _nay: { message: "Path must be absolute and normalized", data: { path: item.path } } });
			}

			// Upload names, not Markdown names: files_normalize_name("file", ...) only accepts .md,
			// while imported binaries keep their real extensions like the app's upload flow.
			const name = path_name_of(item.path);
			if (files_normalize_upload_file_name(name) !== name) {
				return Result({ _nay: { message: "Path ends in an invalid file name", data: { path: item.path } } });
			}
			for (const segment of path_extract_segments_from(item.path).slice(0, -1)) {
				const normalizedSegment = files_normalize_name("folder", segment);
				if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
					return Result({ _nay: { message: "Path contains an invalid folder name", data: { path: item.path } } });
				}
			}

			if (item.size > files_MAX_UPLOADS_BYTES) {
				return Result({ _nay: { message: "File too large", data: { path: item.path } } });
			}

			if (leafPaths.has(item.path)) {
				return Result({ _nay: { message: "Duplicate path in batch", data: { path: item.path } } });
			}
			leafPaths.add(item.path);

			const existingNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("path", item.path)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (existingNode && existingNode.kind !== "file") {
				return Result({ _nay: { message: "The path cannot point to a folder", data: { path: item.path } } });
			}

			validated.push({
				path: item.path,
				contentType: item.contentType,
				size: item.size,
				collidingNodeId: existingNode?._id ?? null,
			});
		}

		// An ancestor folder that already exists as a file would make the recursive create fail
		// mid-write, so check every ancestor path up front too.
		for (const item of validated) {
			const segments = path_extract_segments_from(item.path);
			for (let depth = 1; depth < segments.length; depth++) {
				const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
				if (leafPaths.has(ancestorPath)) {
					return Result({
						_nay: { message: "Path conflicts with another item in the batch", data: { path: item.path } },
					});
				}

				const ancestor = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("path", ancestorPath)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (ancestor && ancestor.kind !== "folder") {
					return Result({ _nay: { message: "The path cannot point to a folder", data: { path: item.path } } });
				}
			}
		}

		// Write pass. Items run in order so later items reuse folders created by earlier ones.
		const now = Date.now();
		const targets: Array<{
			path: string;
			assetId: Id<"files_r2_assets">;
			nodeId: Id<"files_nodes">;
			uploadUrl: string;
			headers: Record<string, string>;
		}> = [];
		for (const item of validated) {
			// Importing over a name archives whatever holds it, like create_upload_node, so re-runs
			// replace the previous import instead of failing.
			if (item.collidingNodeId) {
				await files_nodes_db_archive_nodes(ctx, {
					nodeIds: [item.collidingNodeId],
					updatedBy: args.createdBy,
					now,
				});
			}

			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "upload",
				r2Bucket: r2_get_bucket(),
				size: item.size,
				// Settle processing up front: the finalizer must record the R2 object without
				// starting conversion or plugin runs for imported content.
				processingWorkId: null,
				createdBy: args.createdBy,
				updatedAt: now,
			});

			const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.createdBy,
				parentId: files_ROOT_ID,
				path: item.path,
				kind: "file",
				contentType: item.contentType,
				assetId,
				now,
			});
			// The validation pass cleared every failure this helper can hit (collisions, ancestor
			// conflicts; the owner passes permission checks). Throw so a surprise failure rolls the
			// whole batch back instead of leaving earlier items half-imported.
			if (nodeIdResult._nay) {
				const errorMessage = "create_node_recursively_at_path failed after batch validation";
				const errorData = { path: item.path, nay: nodeIdResult._nay };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			const signedUpload = await r2_generate_upload_url(
				r2_create_asset_key({
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					assetId,
				}),
			);

			targets.push({
				path: item.path,
				assetId,
				nodeId: nodeIdResult._yay,
				uploadUrl: signedUpload.url,
				headers: { "Content-Type": item.contentType },
			});
		}

		return Result({ _yay: targets });
	},
});

/**
 * Count the import workspace's nodes, assets, and plugin runs for reconciliation.
 *
 * The dedicated import workspace IS the run: no run id is written to shared tables. Callers
 * poll `assets.unfinalized` until the R2 event finalizer has recorded every uploaded object.
 */
export const verify_run = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.object({
		nodes: v.object({
			activeFiles: v.number(),
			activeFolders: v.number(),
			archived: v.number(),
		}),
		assets: v.object({
			total: v.number(),
			unfinalized: v.number(),
			unfinalizedActive: v.number(),
		}),
		pluginEventRuns: v.number(),
	}),
	handler: async (ctx, args) => {
		// Workspace-scoped collects: an import workspace holds on the order of hundreds of nodes
		// and dozens of assets, so full collects stay small. Never widen these to unscoped scans.
		const [nodes, assets, pluginEventRuns] = await Promise.all([
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_treePath", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
			ctx.db
				.query("plugins_event_runs")
				.withIndex("by_organization_workspace_event_status_updatedAt", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
		]);

		const activeNodes = nodes.filter((node) => node.archiveOperationId === undefined);
		const unfinalized = assets.filter((asset) => asset.r2Key === undefined);
		// Assets an active file still depends on. Crashed write attempts and archive-and-replace
		// leave unfinalized rows behind that no active file references; those are workspace debris,
		// not missing imports, so callers track this count instead of the raw one.
		const activeAssetIds = new Set(activeNodes.map((node) => node.assetId).filter(Boolean));
		return {
			nodes: {
				activeFiles: activeNodes.filter((node) => node.kind === "file").length,
				activeFolders: activeNodes.filter((node) => node.kind === "folder").length,
				archived: nodes.length - activeNodes.length,
			},
			assets: {
				total: assets.length,
				unfinalized: unfinalized.length,
				unfinalizedActive: unfinalized.filter((asset) => activeAssetIds.has(asset._id)).length,
			},
			pluginEventRuns: pluginEventRuns.length,
		};
	},
});

/**
 * List the workspace's unfinalized assets with everything that still references them.
 *
 * Used when the finalization poll stalls, to tell which files never got their R2 event and
 * which unfinalized rows are pure orphans (no node, no snapshot doc) safe to clean up.
 */
export const list_unfinalized = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.array(
		v.object({
			assetId: v.id("files_r2_assets"),
			kind: v.string(),
			createdAt: v.number(),
			activePaths: v.array(v.string()),
			archivedPaths: v.array(v.string()),
			yjsSnapshotRefs: v.number(),
			fileSnapshotRefs: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const assets = await ctx.db
			.query("files_r2_assets")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.collect();
		const unfinalized = assets.filter((asset) => asset.r2Key === undefined);
		if (unfinalized.length === 0) {
			return [];
		}

		// The snapshot tables have no by-asset index; workspace-scoped collects stay small here.
		const [yjsSnapshots, fileSnapshots] = await Promise.all([
			ctx.db
				.query("files_yjs_snapshots")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
			ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
		]);

		const results: Array<{
			assetId: Id<"files_r2_assets">;
			kind: string;
			createdAt: number;
			activePaths: string[];
			archivedPaths: string[];
			yjsSnapshotRefs: number;
			fileSnapshotRefs: number;
		}> = [];
		for (const asset of unfinalized) {
			const nodes = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_asset", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("assetId", asset._id),
				)
				.collect();
			results.push({
				assetId: asset._id,
				kind: asset.kind,
				createdAt: asset._creationTime,
				activePaths: nodes.filter((node) => node.archiveOperationId === undefined).map((node) => node.path),
				archivedPaths: nodes.filter((node) => node.archiveOperationId !== undefined).map((node) => node.path),
				yjsSnapshotRefs: yjsSnapshots.filter((snapshot) => snapshot.assetId === asset._id).length,
				fileSnapshotRefs: fileSnapshots.filter((snapshot) => snapshot.assetId === asset._id).length,
			});
		}
		return results;
	},
});

/**
 * Count committed frontmatter metadata docs for a few imported files by path.
 *
 * Used by import verification to prove frontmatter was indexed, without dumping whole
 * tables. `metadataDocs: null` means the path has no active file node.
 */
export const verify_metadata = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		paths: v.array(v.string()),
	},
	returns: v.array(
		v.object({
			path: v.string(),
			metadataDocs: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const results: Array<{ path: string; metadataDocs: number | null }> = [];
		for (const path of args.paths) {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("path", path)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!node) {
				results.push({ path, metadataDocs: null });
				continue;
			}

			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id),
				)
				.collect();
			results.push({ path, metadataDocs: metadataDocs.length });
		}
		return results;
	},
});
