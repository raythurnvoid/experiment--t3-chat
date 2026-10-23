// Check creation before uploads. The final transaction repeats these checks.

import {
	internalQuery,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { RegisteredQuery } from "convex/server";
import { path_join } from "../server/server-utils.ts";
import { v } from "convex/values";
import { files_ROOT_ID } from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { access_control_db_authorize_file_write } from "./access_control.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";

// Reuse the loaded module between calls. Keep request state inside each handler.
export const experimental_reuseContext = true;

/**
 * Find the current lock for a new file path.
 * Walk active children under `parentId`, like the create function does.
 *
 * - `anchorNode` is the deepest existing parent. It stores the nearest lock.
 * - `targetNode` is the active node at the final path, if one exists.
 * - `prefixPaths` contains every path part from root to the final path.
 *
 * Return null when the parent is missing or archived, or the path is empty. The create would also fail.
 */
export async function files_nodes_create_db_resolve_destination(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
	},
) {
	const pathSegments = path_extract_segments_from(args.path);
	if (pathSegments.length === 0) {
		return null;
	}

	let anchorNode: Doc<"files_nodes"> | null = null;
	let currentParentPath: string;
	if (args.parentId === files_ROOT_ID) {
		currentParentPath = "/";
	} else {
		const parentNode = await ctx.db.get("files_nodes", args.parentId);
		if (
			!parentNode ||
			parentNode.organizationId !== args.organizationId ||
			parentNode.workspaceId !== args.workspaceId ||
			parentNode.kind !== "folder" ||
			parentNode.archiveOperationId !== null
		) {
			return null;
		}
		anchorNode = parentNode;
		currentParentPath = parentNode.path;
	}

	let currentParentId: Doc<"files_nodes">["parentId"] = args.parentId;
	const prefixPaths: string[] = [];
	let targetNode: Doc<"files_nodes"> | null = null;

	// After one path part is missing, every deeper part is also missing.
	// Only build their paths after that.
	let missingSegments = false;

	for (const [i, name] of pathSegments.entries()) {
		const isLeaf = i === pathSegments.length - 1;
		let existing: Doc<"files_nodes"> | null = null;
		if (!missingSegments) {
			existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId).eq("moveCohortId", undefined)
						.eq("parentId", currentParentId)
						.eq("name", name)
						.eq("archiveOperationId", null),
				)
				.first();
		}

		if (existing) {
			prefixPaths.push(existing.path);
			currentParentPath = existing.path;
			if (isLeaf) {
				targetNode = existing;
			} else if (existing.kind === "folder") {
				anchorNode = existing;
				currentParentId = existing._id;
			} else {
				// This path part is a file. Nothing can exist below it, so the create will fail.
				missingSegments = true;
			}
		} else {
			missingSegments = true;
			currentParentPath = path_join(currentParentPath, name);
			prefixPaths.push(currentParentPath);
		}
	}

	return { anchorNode, targetNode, prefixPaths };
}

/**
 * Check the destination before the action writes R2 files.
 * `create_file_node` checks the destination and its lock again in the final transaction.
 */
export const get_create_file_node_write_preflight = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			canWrite: v.boolean(),
			targetNodeId: v.union(v.id("files_nodes"), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			return null;
		}

		// Check access on the parent before reading deeper path data.
		// Do not reveal the read-only state of a child the caller cannot open.
		const authorized = await access_control_db_authorize_file_write(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return null;
		}

		const destination = await files_nodes_create_db_resolve_destination(ctx, args);
		if (!destination) {
			return null;
		}

		// Check access on every existing path part before returning lock or conflict data.
		// The final create walks the same path again.
		for (const prefixPath of destination.prefixPaths) {
			const segment = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId).eq("moveCohortId", undefined)
						.eq("path", prefixPath)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!segment) {
				break;
			}
			const segmentAuthorized = await access_control_db_authorize_file_write(ctx, {
				userAuth: { id: args.userId },
				membership,
				nodeId: segment._id,
			});
			if (segmentAuthorized._nay) {
				return null;
			}
		}

		return {
			canWrite:
				destination.anchorNode === null ||
				!(
					await files_nodes_db_require_user_writable(ctx, {
						node: destination.anchorNode,
						userId: args.userId,
					})
				)._nay,
			targetNodeId: destination.targetNode?._id ?? null,
		};
	},
});

export type files_nodes_create_preflight_Result =
	typeof get_create_file_node_write_preflight extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
