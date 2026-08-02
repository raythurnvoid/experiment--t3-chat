// Files nodes are organized as a file tree where each node is either a folder or a Markdown file.
//
// This structure allows file-system-like operations such as finding all items under a path (`/docs/*`) or
// listing folder children and reading file content (`/docs/README.md`).

import {
	action,
	internalAction,
	internalQuery,
	query,
	type QueryCtx,
	type MutationCtx,
	internalMutation,
	mutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type RegisteredMutation,
	type RegisteredQuery,
} from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import {
	path_extract_segments_from,
	server_path_normalize,
	server_convex_get_user_fallback_to_anonymous,
	path_join,
} from "../server/server-utils.ts";
import { v } from "convex/values";
import {
	date_get_week_start_timestamp,
	date_get_day_start_timestamp,
	date_get_hour_start_timestamp,
	date_MS_DAY,
	date_MS_DAYS_30,
	date_MS_WEEK,
} from "../shared/date.ts";
import {
	files_ROOT_ID,
	files_MAX_UPLOADS_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_pending_update_content_of,
	files_db_cancel_pending_update_cleanup_tasks,
	files_db_build_pending_path_overlay,
	files_db_get_pending_update,
	files_db_get_visible_node_by_path,
	files_db_list_pending_updates_for_user,
	files_pending_path_overlay_project_committed_path,
} from "../server/files.ts";
import { Result, Result_all } from "common/errors-as-values-utils.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema from "./schema.ts";
import { components, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { billing_event } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { files_metadata_db_patch_file_scope } from "./files_metadata.ts";
import {
	r2_get_download_url,
	r2_generate_upload_url,
	r2_get_bucket,
	r2_create_asset_key,
	r2_delete_object,
} from "./r2_client.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const files_content_materialization_workpool = new Workpool(components.files_content_materialization_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

/**
 * Rebase an absolute path from one base path to another.
 *
 * @example
 * ```ts
 * // valid rebase
 * path_rebase({
 * 	fromBasePath: "/docs",
 * 	toBasePath: "/archive",
 * 	path: "/docs/guides/getting-started",
 * }); // => "/archive/guides/getting-started"
 * ```
 *
 * @example
 * ```ts
 * // invalid rebase (path is outside fromBasePath)
 * path_rebase({
 * 	fromBasePath: "/docs",
 * 	toBasePath: "/archive",
 * 	path: "/notes/todo",
 * }); // => null
 * ```
 *
 * Path format: absolute (`/`-prefixed) and no trailing `/` for non-root paths.
 *
 * @param args.fromBasePath - Base path that `args.path` must match (same path format).
 * @param args.toBasePath - Base path used in the rebased result (same path format).
 * @param args.path - Absolute path to rebase (same path format).
 *
 * @returns The rebased path, or `null` when `args.path` does not start with `args.fromBasePath`.
 */
function path_rebase(args: { fromBasePath: string; toBasePath: string; path: string }) {
	if (args.path === args.fromBasePath) {
		return args.toBasePath;
	}

	if (!args.path.startsWith(`${args.fromBasePath}/`)) {
		return null;
	}

	const suffix = args.path.slice(args.fromBasePath.length + 1);
	return `${args.toBasePath}${args.toBasePath === "/" ? "" : "/"}${suffix}`;
}

function files_path_depth(path: string) {
	return path === "/" ? 0 : path_extract_segments_from(path).length;
}

function files_lowercase_extension(path: string, kind: Doc<"files_nodes">["kind"]) {
	if (kind !== "file") {
		return null;
	}
	const name = path_extract_segments_from(path).at(-1) ?? "";
	const dotIndex = name.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === name.length - 1) {
		return null;
	}
	return name.slice(dotIndex + 1).toLowerCase();
}

function derive_tree_path_for_file_node(path: string, kind: Doc<"files_nodes">["kind"]) {
	return kind === "folder" && path !== "/" ? `${path}/` : path;
}

/** -1 in any file_stats count means the content cannot be processed (non-markdown / binary). */
const files_STATS_UNPROCESSABLE = -1;

/**
 * Create or update the `file_stats` doc for a file node and, on first creation, link it back via
 * `files_nodes.statsId`. Subsequent updates patch only the stats doc — NOT the file node — so
 * re-materializing content does not invalidate the file-tree / path-resolution queries that read
 * the file node. Returns the stats doc id.
 */
export async function db_upsert_file_stats(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		lineCount: number;
		wordCount: number;
		charCount: number;
	},
) {
	const existing = await ctx.db
		.query("file_stats")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.first();
	if (existing) {
		await ctx.db.patch("file_stats", existing._id, {
			lineCount: args.lineCount,
			wordCount: args.wordCount,
			charCount: args.charCount,
		});
		return existing._id;
	}
	const statsId = await ctx.db.insert("file_stats", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		lineCount: args.lineCount,
		wordCount: args.wordCount,
		charCount: args.charCount,
	});
	await ctx.db.patch("files_nodes", args.nodeId, { statsId });
	return statsId;
}

async function db_patch_plain_text_chunks_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path?: string;
		archiveOperationId?: string;
	},
) {
	const patch: Partial<Pick<Doc<"files_plain_text_chunks">, "path" | "archiveOperationId">> = {};
	if ("path" in args) {
		patch.path = args.path;
	}
	if ("archiveOperationId" in args) {
		patch.archiveOperationId = args.archiveOperationId;
	}
	const chunks = await ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.collect();
	await Promise.all(chunks.map((chunk) => ctx.db.patch("files_plain_text_chunks", chunk._id, patch)));
}

export async function db_patch_file_chunks_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path?: string;
		archiveOperationId?: string;
	},
) {
	await Promise.all([
		db_patch_plain_text_chunks_scope(ctx, args),
		files_metadata_db_patch_file_scope(ctx, {
			...args,
			...(args.path === undefined ? {} : { treePath: args.path }),
		}),
	]);
}

export async function enqueue_file_content_materialization(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		targetSequence: number;
		delayMs: number;
	},
) {
	const existingJobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();

	const jobId = await files_content_materialization_workpool.enqueueAction(
		ctx,
		internal.files_nodes_content.materialize_file_content,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			userId: args.userId,
			targetSequence: args.targetSequence,
		},
		{
			runAfter: args.delayMs,
		},
	);

	await Promise.all([
		ctx.db.insert("files_content_materialization_jobs", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			jobId,
			targetSequence: args.targetSequence,
		}),
		...existingJobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)),
		...existingJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
	]);
}

export const get_by_path = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		path: v.string(),
		/**
		 * Who is looking. Required, not optional, so a new caller cannot forget it and quietly get an
		 * unfiltered view: a restricted node answers `null` for anybody without a grant on it.
		 */
		visibilityUserId: v.id("users"),
		/** When set, resolve through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		const fileNode = await files_db_get_visible_node_by_path(ctx, args);
		if (!fileNode) {
			return null;
		}

		const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			nodes: [fileNode],
		});
		return readable ?? null;
	},
});

export type files_nodes_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function resolve_parent_path_from_parent_id(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return "/";
	}

	const parentNode = await ctx.db.get("files_nodes", args.parentId);
	if (
		!parentNode ||
		parentNode.organizationId !== args.organizationId ||
		parentNode.workspaceId !== args.workspaceId ||
		parentNode.kind !== "folder"
	) {
		return null;
	}

	return parentNode.path;
}

/**
 * Recompute path fields for descendants after a file node moves or is renamed.
 * `parentPath` is the already-updated path for `parentId`; each child path is built from it.
 *
 * File descendants also update their chunk scope.
 */
async function cascade_file_descendants_path(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Id<"files_nodes">;
		parentPath: string;
	},
) {
	const stack: Array<{ parentId: Id<"files_nodes">; parentPath: string }> = [
		{ parentId: args.parentId, parentPath: args.parentPath },
	];

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) {
			continue;
		}

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", frame.parentId),
			)
			.collect();

		await Promise.all(
			children.map(async (child) => {
				const childPath = path_join(frame.parentPath, child.name);
				await ctx.db.patch("files_nodes", child._id, {
					path: childPath,
					treePath: derive_tree_path_for_file_node(childPath, child.kind),
					pathDepth: files_path_depth(childPath),
					lowercaseExtension: files_lowercase_extension(childPath, child.kind),
				});
				if (child.kind === "file") {
					await db_patch_file_chunks_scope(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						nodeId: child._id,
						path: childPath,
					});
				}
				stack.push({
					parentId: child._id,
					parentPath: childPath,
				});
			}),
		);
	}
}

/**
 * The restricted scope a new or moved child inherits from where it sits: the nearest restricted
 * folder at or above `parentId`, or `undefined` when that chain has none.
 *
 * The parent already carries the answer, because every node stores its nearest restricted ancestor.
 * So this is one read and never a walk up the tree.
 */
export async function files_nodes_db_resolve_parent_restricted_scope(
	ctx: MutationCtx,
	args: {
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return undefined;
	}

	const parent = await ctx.db.get("files_nodes", args.parentId);
	return parent?.restrictedScopeNodeId;
}

/**
 * Rewrite `restrictedScopeNodeId` on every descendant of a node whose own scope just changed.
 *
 * `scopeNodeId` is the scope the descendants must inherit, which is the scope the node itself now
 * has. Pass `undefined` to clear it, which is what unrestricting a folder outside any other
 * restricted folder does.
 *
 * A descendant that is restricted itself keeps its own scope, and the walk stops there: everything
 * below it already points at it, and that stays true however the folders above it changed. This is
 * what makes a restricted folder inside another restricted folder keep its own, narrower list of
 * people.
 *
 * It reads and patches the whole subtree in one mutation, like `archive_nodes` does. A subtree big
 * enough to pass Convex's per-mutation limits would fail the whole call, and nothing would be half
 * restricted, so the answer stays consistent. Split this into a job if that limit is ever reached.
 */
export async function files_nodes_db_cascade_restricted_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Id<"files_nodes">;
		scopeNodeId: Id<"files_nodes"> | undefined;
	},
) {
	const stack: Array<Id<"files_nodes">> = [args.parentId];

	while (stack.length > 0) {
		const parentId = stack.pop();
		if (parentId === undefined) {
			continue;
		}

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", parentId),
			)
			.collect();

		await Promise.all(
			children.map(async (child) => {
				if (child.restrictedScopeNodeId === child._id) {
					return;
				}

				if (child.restrictedScopeNodeId !== args.scopeNodeId) {
					await ctx.db.patch("files_nodes", child._id, { restrictedScopeNodeId: args.scopeNodeId });
				}
				stack.push(child._id);
			}),
		);
	}
}

/**
 * Whether the caller may act on every node a sweep collected.
 *
 * A cascade — archive a folder, restore a folder — gathers descendants nobody named. The handler's
 * own check asked about the node the caller pointed at, so a restricted folder nested inside an open
 * one would be swept along by somebody holding no grant on it.
 *
 * Pass the named node's own scope as `rootScopeNodeId`: descendants sharing it were already covered.
 * Everything else is asked once per distinct scope, so a restricted folder holding 500 files costs
 * one check and an ordinary tree costs none.
 */
export async function files_nodes_db_can_act_on_swept_nodes(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		rootScopeNodeId: Id<"files_nodes"> | undefined;
		nodes: readonly Doc<"files_nodes">[];
		permission: access_control_Permission;
	},
) {
	const checkedScopeNodeIds = new Set<Id<"files_nodes">>();

	for (const node of args.nodes) {
		const scopeNodeId = node.restrictedScopeNodeId;
		if (!scopeNodeId || scopeNodeId === args.rootScopeNodeId || checkedScopeNodeIds.has(scopeNodeId)) {
			continue;
		}

		checkedScopeNodeIds.add(scopeNodeId);
		const allowed = await access_control_db_can_act_on_file_node(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNode: node,
			permission: args.permission,
		});
		if (!allowed) {
			return false;
		}
	}

	return true;
}

/**
 * Check `content.write` on the node that decides a file write.
 *
 * For a change to an existing node that is the node itself. For a new node, or for one about to be
 * dropped somewhere, it is the folder it lands in. At the root there is no node to ask about, so
 * the workspace answers.
 *
 * Asking the node, and not the workspace, is what makes a grant useful: somebody whose only power
 * in this workspace is a grant on one restricted folder can still work inside it, which a
 * workspace-wide check would refuse at the door.
 */
export async function authorize_file_write(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		nodeId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.nodeId === files_ROOT_ID) {
		return await access_control_db_authorize_membership(ctx, {
			userAuth: args.userAuth,
			membership: args.membership,
			permission: "content.write",
		});
	}

	return await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: args.nodeId,
		permission: "content.write",
	});
}

/**
 * Check the third permission leg of a move: leaving a restricted folder.
 *
 * A move already asks two questions. May the caller write this node, and may they write where it
 * lands. There is a third. When a node sits inside a restricted folder and lands somewhere that
 * folder does not cover, everybody who can read the destination can now read the file, its history
 * and its comments. That is a change to who can see it, so it needs the permission that owns
 * sharing. `content.write` means "change what is inside", never "change who can see it".
 *
 * Moving a folder does this to every file under it in one action, so the cost of getting it wrong
 * is a whole subtree, not one file. "They could copy the text out anyway" is a different thing:
 * copying gives one person a copy, this hands everyone the real file.
 *
 * A folder that is the restricted scope itself carries that scope wherever it goes, so it changes
 * nobody's access and is not asked about.
 */
export async function authorize_leaving_restricted_scope(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		fileNode: Doc<"files_nodes">;
		destParentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (!args.fileNode.restrictedScopeNodeId || args.fileNode.restrictedScopeNodeId === args.fileNode._id) {
		return Result({ _yay: null });
	}

	const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
		parentId: args.destParentId,
	});
	if (destScopeNodeId === args.fileNode.restrictedScopeNodeId) {
		return Result({ _yay: null });
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: "content.permissions.manage",
		fileNode: args.fileNode,
	});
	if (authorized._nay) {
		// Name the level the Share dialog shows, so the message says what to ask a manager for.
		return Result({
			_nay: { name: "nay", message: "You need Can manage on the shared folder to move this out of it." },
		});
	}

	return Result({ _yay: null });
}

/**
 * Whether the caller may write a file here. `nodeId` is the node that decides, the same one
 * `authorize_file_write` takes.
 *
 * An action cannot read the database, so every action that writes a file asks this first. Without
 * it those actions would still be asking the workspace, and would refuse the one person a grant was
 * meant for.
 */
export const get_current_user_file_write_permission = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return false;
		}

		const authorized = await authorize_file_write(ctx, { userAuth, membership, nodeId: args.nodeId });
		return authorized._nay === undefined;
	},
});

async function db_insert_node(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		name: Doc<"files_nodes">["name"];
		path: Doc<"files_nodes">["path"];
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/**
		 * Set when the caller inserts the file's content docs right after this insert, in the same
		 * mutation, via `files_nodes_db_insert_file_content_docs` (files_nodes_content.ts). Skips
		 * the initial UNPROCESSABLE stats write so those callers do not double-write stats.
		 */
		expectsTextContent?: true;
		now: number;
	},
) {
	// A new node sits inside its parent, so it starts with the parent's restricted scope. Without
	// this, a file created inside a restricted folder would be open to the whole workspace, which is
	// the one thing the person who restricted that folder asked us not to do.
	const restrictedScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
		parentId: args.parentId,
	});

	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		path: args.path,
		restrictedScopeNodeId,
		treePath: derive_tree_path_for_file_node(args.path, args.kind),
		pathDepth: files_path_depth(args.path),
		lowercaseExtension: files_lowercase_extension(args.path, args.kind),
		name: args.name,
		kind: args.kind,
		contentType: args.contentType,
		assetId: args.assetId,
		archiveOperationId: args.archiveOperationId,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: args.now,
	});

	if (args.kind === "folder") {
		return Result({ _yay: nodeId });
	}

	// Content callers insert the file's content docs (and real stats) right after this returns,
	// still inside the same mutation. Keep the assetId invariant here: every file with text
	// content links a content or version-snapshot asset.
	if (args.expectsTextContent) {
		if (!args.assetId) {
			const errorMessage = "fileNode.assetId is not set";
			const errorData = {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		return Result({ _yay: nodeId });
	}

	// A file with no processable text content (e.g. a raw upload) still gets a stats doc, flagged
	// unprocessable with -1. A later materialization overwrites it with real counts if text appears.
	await db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId,
		lineCount: files_STATS_UNPROCESSABLE,
		wordCount: files_STATS_UNPROCESSABLE,
		charCount: files_STATS_UNPROCESSABLE,
	});
	return Result({ _yay: nodeId });
}

/**
 * Create a node from a path, creating each missing parent folder segment before
 * creating the final file/folder segment.
 *
 * Trust callers to pass a valid, normalized path for the requested leaf kind.
 */
export async function files_nodes_db_create_node_recursively_at_path(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/** Forwarded to `db_insert_node` for the leaf only; see the arg doc there. */
		expectsTextContent?: true;
		now: number;
		/**
		 * When set, receives the `_id` of every intermediate folder this call creates (reused
		 * folders are skipped), in creation order (shallowest first).
		 */
		mut_createdAncestorIds?: Array<Id<"files_nodes">>;
	},
) {
	let currentParent: Doc<"files_nodes">["parentId"] = args.parentId;
	const pathSegments = path_extract_segments_from(args.path);
	let currentParentPath: string | null = args.parentId === files_ROOT_ID ? "/" : null;

	// Walk segments in order because each child lookup needs the previous folder id.
	for (const [i, name] of pathSegments.entries()) {
		const isLeaf = i === pathSegments.length - 1;
		const kind: Doc<"files_nodes">["kind"] = isLeaf ? args.kind : "folder";

		// Start the parent-path lookup before the child conflict read
		// so non-root creates wait on one DB round trip instead of two.
		const parentPathPromise =
			currentParentPath == null
				? resolve_parent_path_from_parent_id(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						parentId: currentParent,
					})
				: null;

		const existing = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("parentId", currentParent)
					.eq("name", name)
					.eq("archiveOperationId", undefined),
			)
			.first();

		let path: string;
		if (existing) {
			if (parentPathPromise) {
				await parentPathPromise;
			}

			// The caller was authorized against the parent they named, and this node is one this walk
			// found on its own. Without asking about it, typing `private/new.md` would write inside a
			// restricted folder the caller was never given, and hitting an existing restricted file would
			// report that it is there. SYSTEM writes come from trusted server flows, so there is no user
			// to ask about.
			if (
				args.userId !== users_SYSTEM_AUTHOR &&
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					fileNode: existing,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { name: "nay", message: "Permission denied" } });
			}

			if (!isLeaf) {
				// Reuse active intermediate folders, but reject files that already own the path.
				if (existing.kind === "folder") {
					currentParent = existing._id;
					currentParentPath = existing.path;
					continue;
				}

				return Result({
					_nay: {
						name: "nay",
						message: "This folder already exists.",
					},
				});
			}

			// Archived generated files may share a path with an active replacement.
			if (args.archiveOperationId === undefined) {
				return Result({
					_nay: {
						name: "nay",
						message: kind === "file" ? "This file already exists." : "This folder already exists.",
					},
				});
			}
			path = existing.path;
		} else {
			if (currentParentPath == null) {
				currentParentPath = await parentPathPromise;
				if (currentParentPath == null) {
					return Result({
						_nay: {
							name: "nay",
							message: "Not found",
						},
					});
				}
			}
			path = path_join(currentParentPath, name);
		}

		const nodeIdResult = await db_insert_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: currentParent,
			name,
			path,
			kind,
			contentType: isLeaf ? args.contentType : undefined,
			assetId: isLeaf ? args.assetId : undefined,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
			expectsTextContent: isLeaf ? args.expectsTextContent : undefined,
			now: args.now,
		});

		if (nodeIdResult._nay) {
			return nodeIdResult;
		}

		// Return the requested leaf; otherwise continue creating below the new folder.
		if (isLeaf) {
			return Result({ _yay: nodeIdResult._yay });
		}

		args.mut_createdAncestorIds?.push(nodeIdResult._yay);
		currentParent = nodeIdResult._yay;
		currentParentPath = path;
	}

	const errorMessage = "nodeId not resolved after node path creation";
	const errorData = {};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}

export const create_folder_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuthPromise = server_convex_get_user_fallback_to_anonymous(ctx);
		const membershipPromise = ctx.db.get("organizations_workspaces_users", args.membershipId);

		const userAuth = await userAuthPromise;
		if (!userAuth) {
			await membershipPromise;
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const [rateLimit, membership] = await Promise.all([
			rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id }),
			membershipPromise,
		]);
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (!membership || membership.userId !== userAuth.id || membership.active === false) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return authorized;
		}

		// We trust that the front-end is validating the input correctly.
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			path: args.path,
			kind: "folder",
			now: Date.now(),
		});

		if (nodeIdResult._nay) {
			return nodeIdResult;
		}

		return Result({ _yay: { nodeId: nodeIdResult._yay } });
	},
});

/**
 * Create a folder at a trusted absolute path for server-side agent tools.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_folder_node_by_path = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes"), exists: v.boolean() }) }),
	handler: async (ctx, args) => {
		const activeNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();

		// The lookup above is raw, so it also finds a node the caller cannot see. Handing back the id of a
		// restricted folder would be enough: `mkdir` remembers what it gets, so `stat` would then read that
		// folder too. A taken path still says something is there, as every path entrypoint does, but not what.
		if (
			activeNode &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: activeNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (activeNode?.kind === "folder") {
			return Result({ _yay: { nodeId: activeNode._id, exists: true } });
		}
		if (activeNode?.kind === "file") {
			return Result({ _nay: { message: "A file already exists at this path." } });
		}

		// Nothing is at this path, so no existing node answered the permission question, and the walk
		// below will not ask one either: it only checks nodes that already exist. The caller is an
		// action, which proves nothing before calling, so the workspace has to answer here, in the
		// transaction that writes. `create_file_node` asks the same question for the same reason, so
		// `mkdir` and `touch` refuse the same people.
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
			return Result({ _nay: { message: "Permission denied" } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: files_ROOT_ID,
		});
		if (authorized._nay) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const nodeId = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "folder",
			now: Date.now(),
		});

		if (nodeId._nay) {
			return nodeId;
		}

		return Result({ _yay: { nodeId: nodeId._yay, exists: false } });
	},
});

export type files_nodes_create_folder_node_by_path_Result =
	typeof create_folder_node_by_path extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete one bounded batch of a subtree: range-scan `files_nodes` by `treePath` over
 * `[prefix, prefix + "￿")` and, for each node, delete its committed chunks, `file_stats`,
 * metadata docs, and R2 asset (object + doc, gated on `r2Key`) BEFORE the node doc itself, so a
 * crash never orphans children. Asset and node deletion are one budget unit pair so a node never
 * commits with a missing asset reference. Callers drive this to `done: true` by calling repeatedly.
 */
export async function files_nodes_db_delete_subtree_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		/** `files_nodes.treePath` prefix of the subtree, including the trailing slash (e.g. `/<root>/`). */
		treePathPrefix: string;
		batchSize: number;
	},
) {
	const lower = args.treePathPrefix;
	const upper = `${args.treePathPrefix}￿`;

	let deletedCount = 0;
	while (deletedCount < args.batchSize) {
		const node = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.gte("treePath", lower)
					.lt("treePath", upper),
			)
			.order("desc")
			.first();
		if (!node) {
			break;
		}

		const remainingPlainTextChunks = args.batchSize - deletedCount;
		const plainTextChunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingPlainTextChunks);
		for (const chunk of plainTextChunks) {
			await ctx.db.delete("files_plain_text_chunks", chunk._id);
			deletedCount++;
		}
		if (plainTextChunks.length > 0) {
			continue;
		}

		const remainingMarkdownChunks = args.batchSize - deletedCount;
		const markdownChunks = await ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingMarkdownChunks);
		for (const chunk of markdownChunks) {
			await ctx.db.delete("files_markdown_chunks", chunk._id);
			deletedCount++;
		}
		if (markdownChunks.length > 0) {
			continue;
		}

		const remainingFileStats = args.batchSize - deletedCount;
		const fileStats = await ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingFileStats);
		for (const stats of fileStats) {
			await ctx.db.delete("file_stats", stats._id);
			deletedCount++;
		}
		if (fileStats.length > 0) {
			continue;
		}

		const remainingMetadataDocs = args.batchSize - deletedCount;
		const metadataDocs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingMetadataDocs);
		for (const metadataDoc of metadataDocs) {
			await ctx.db.delete("files_metadata_docs", metadataDoc._id);
			deletedCount++;
		}
		if (metadataDocs.length > 0) {
			continue;
		}

		if (node.assetId) {
			const asset = await ctx.db.get("files_r2_assets", node.assetId);
			if (asset) {
				if (deletedCount + 2 > args.batchSize) {
					break;
				}
				if (asset.r2Key) {
					await r2_delete_object(ctx, asset.r2Key);
				}
				await ctx.db.delete("files_r2_assets", asset._id);
				await ctx.db.delete("files_nodes", node._id);
				deletedCount += 2;
				continue;
			}
		}

		if (deletedCount >= args.batchSize) {
			break;
		}
		await ctx.db.delete("files_nodes", node._id);
		deletedCount++;
	}

	const remaining = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_treePath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.gte("treePath", lower)
				.lt("treePath", upper),
		)
		.first();

	return { done: remaining === null, deletedCount };
}

/**
 * An eager-created destination (write_file or cp onto a new path) may only be hard-deleted
 * while it is still the near-empty node the proposal created: no content committed since the
 * proposal (the committed Yjs sequence still matches the immutable `eagerCreated.committedSequence`
 * stamp), no committed rename/move of the node itself by another user (`updatedBy` is still
 * the proposer; rename_node and move_nodes both stamp it), and no other user's pending update
 * doc on the node. An ancestor-folder move rewrites descendant paths without restamping them —
 * that is deliberate: hard-deleting the eager-created node does not undo the ancestor's own
 * move. Anything else means the node became a real file; callers must then drop only the
 * proposer's doc and keep the node.
 */
export async function files_nodes_db_is_eager_node_safe_to_hard_delete(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		// `_id` is absent for the compensation caller whose doc was never written: any real
		// pending update doc on the node then blocks the hard delete.
		pendingUpdate: Pick<Doc<"files_pending_updates">, "userId" | "eagerCreated"> &
			Partial<Pick<Doc<"files_pending_updates">, "_id">>;
	},
) {
	// Proposals against pre-existing files (edits, replace-copies): never hard-delete those.
	if (!args.pendingUpdate.eagerCreated) {
		return false;
	}
	const committedSequence = args.pendingUpdate.eagerCreated.committedSequence;

	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
		// Node already gone: the hard delete no-ops, so running it is safe.
		return true;
	}
	if (node.updatedBy !== args.pendingUpdate.userId) {
		// Someone else committed a structural change (rename/move) since the eager creation;
		// structural changes never advance the Yjs sequence, so the stamp cannot catch them.
		return false;
	}
	if (!node.yjsLastSequenceId) {
		return false;
	}

	const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
	if (!yjsLastSequenceDoc || yjsLastSequenceDoc.lastSequence !== committedSequence) {
		return false;
	}

	const pendingUpdatesOnNode = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();
	if (pendingUpdatesOnNode.some((row) => row._id !== args.pendingUpdate._id)) {
		return false;
	}

	return true;
}

/**
 * Hard-delete one file node with every dependent doc, every user's pending update docs, and its
 * R2 assets/objects. Built for pending-copy destination cleanup, not a general delete: copy
 * destinations are fresh near-empty nodes, so no batching is needed. Missing/mismatched nodes
 * are a no-op so discard stays idempotent.
 */
export async function files_nodes_db_hard_delete_node(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
		return;
	}
	if (node.kind !== "file") {
		// Pending-copy destinations are always files; a folder here means a caller bug.
		const errorMessage = "files_nodes_db_hard_delete_node only supports file nodes";
		const errorData = { nodeId: args.nodeId, kind: node.kind };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [
		plainTextChunks,
		markdownChunks,
		fileStats,
		metadataDocs,
		yjsSnapshots,
		yjsUpdates,
		yjsLastSequences,
		materializationJobs,
		snapshots,
		pendingUpdates,
		lastSequenceSavedDocs,
		shareGrants,
	] = await Promise.all([
		// The by-fileNode chunk indexes cover both committed and pending chunk docs.
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_yjs_snapshots")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", node._id))
			.collect(),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_organization_workspace_fileNode_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		// A single file can be restricted too, and then it owns share grants. Deleting the file without
		// them would leave rows nothing can ever reach or remove.
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(node._id)),
			)
			.collect(),
	]);

	// node.assetId points at the newest version snapshot for editable files, so the same asset id
	// can appear again in `snapshots`; dedupe before deleting.
	const assetIds = new Set<Id<"files_r2_assets">>();
	if (node.assetId) {
		assetIds.add(node.assetId);
	}
	for (const yjsSnapshot of yjsSnapshots) {
		assetIds.add(yjsSnapshot.assetId);
	}
	for (const snapshot of snapshots) {
		assetIds.add(snapshot.assetId);
	}

	await Promise.all(
		pendingUpdates.map((pendingUpdate) =>
			files_db_cancel_pending_update_cleanup_tasks(ctx, { pendingUpdateId: pendingUpdate._id }),
		),
	);

	await Promise.all([
		...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
		...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
		...fileStats.map((stats) => ctx.db.delete("file_stats", stats._id)),
		...metadataDocs.map((metadataDoc) => ctx.db.delete("files_metadata_docs", metadataDoc._id)),
		...yjsSnapshots.map((yjsSnapshot) => ctx.db.delete("files_yjs_snapshots", yjsSnapshot._id)),
		...yjsUpdates.map((yjsUpdate) => ctx.db.delete("files_yjs_updates", yjsUpdate._id)),
		...yjsLastSequences.map((lastSequence) => ctx.db.delete("files_yjs_docs_last_sequences", lastSequence._id)),
		...materializationJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
		...snapshots.map((snapshot) => ctx.db.delete("files_snapshots", snapshot._id)),
		...pendingUpdates.map((pendingUpdate) => ctx.db.delete("files_pending_updates", pendingUpdate._id)),
		...lastSequenceSavedDocs.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
		...shareGrants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)),
	]);

	for (const assetId of assetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) {
			continue;
		}
		if (asset.r2Key) {
			await r2_delete_object(ctx, asset.r2Key);
		}
		await ctx.db.delete("files_r2_assets", asset._id);
	}

	await ctx.db.delete("files_nodes", node._id);
}

/**
 * Remove the folders an eager create committed for a removed leaf, deepest first. A folder is
 * only deleted while it is still the empty folder the proposer created: same scope, still
 * a folder, created and last updated by `userId` (a rename/move by another user stamps
 * `updatedBy` and must survive), no pending update doc referencing it (on the folder itself
 * or as a pending move destination), and no child. A kept folder makes every shallower
 * ancestor non-empty, so the walk stops there and counts the rest as left without further
 * reads.
 */
export async function files_nodes_db_remove_created_ancestor_folders_if_safe(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		createdAncestorIds: Id<"files_nodes">[];
	},
) {
	let ancestorsLeft = 0;
	for (const [i, ancestorId] of args.createdAncestorIds.entries()) {
		const ancestor = await ctx.db.get("files_nodes", ancestorId);
		if (!ancestor) {
			// Already gone (e.g. a repeated compensation): nothing left here.
			continue;
		}
		if (
			ancestor.organizationId !== args.organizationId ||
			ancestor.workspaceId !== args.workspaceId ||
			ancestor.kind !== "folder" ||
			ancestor.createdBy !== args.userId ||
			ancestor.updatedBy !== args.userId
		) {
			ancestorsLeft = args.createdAncestorIds.length - i;
			break;
		}
		const pendingUpdateOnFolder = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", ancestor._id))
			.first();
		if (pendingUpdateOnFolder) {
			// Deleting the folder would orphan the doc (e.g. a pending move of the folder).
			ancestorsLeft = args.createdAncestorIds.length - i;
			break;
		}
		const pendingMoveIntoFolder = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_pendingMove_destParentId", (q) => q.eq("pendingMove.destParentId", ancestor._id))
			.first();
		if (pendingMoveIntoFolder) {
			// A pending move targeting this folder must keep its destination alive.
			ancestorsLeft = args.createdAncestorIds.length - i;
			break;
		}
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", ancestor._id),
			)
			.first();
		if (child) {
			ancestorsLeft = args.createdAncestorIds.length - i;
			break;
		}
		// Somebody restricted this folder and shared it, which is a deliberate act on a folder the
		// agent only happened to create on the way. Keep it. Deleting it would also strand its share
		// grants: they point at this node id, nothing here removes them, and a leftover grant naming a
		// custom role makes that role impossible to delete for good, because `delete_role` refuses
		// while any grant names it.
		if (ancestor.restrictedScopeNodeId === ancestor._id) {
			ancestorsLeft = args.createdAncestorIds.length - i;
			break;
		}
		// Folder creation writes only the files_nodes doc (db_insert_node returns before any side docs
		// for folders), and the check above ruled out the one other doc a folder can own, so one delete
		// removes the whole folder.
		await ctx.db.delete("files_nodes", ancestor._id);
	}
	return { ancestorsLeft };
}

/**
 * Compensation for a failed eager create's proposal upsert (write_file or cp onto a new path):
 * the node was committed but the pending update doc was never recorded, so remove the
 * just-created empty node — only while it is still provably untouched. The safety gate runs
 * with a synthetic pending update doc that has no real `_id`, so any existing pending update
 * doc on the node blocks the hard delete.
 * When the eager create also committed missing parent folders, `createdAncestorIds`
 * lets a removed leaf take those still-empty folders with it. Never errors for the compensation
 * caller: a missing, out-of-scope, archived, or already-real node reports `removed: false`.
 */
export const remove_eager_created_node_if_safe = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		eagerCreatedCommittedSequence: v.number(),
		/**
		 * `_id`s of the folders the eager create committed for this leaf, deepest first
		 * (`createdAncestorIds` from `create_file_by_path`). After the leaf is removed, each
		 * is removed too while it is still an empty folder only touched by `userId`.
		 */
		createdAncestorIds: v.optional(v.array(v.id("files_nodes"))),
	},
	returns: v_result({
		_yay: v.object({
			removed: v.boolean(),
			/** How many of the passed ancestor folders still exist after this attempt. */
			ancestorsLeft: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const createdAncestorIds = args.createdAncestorIds ?? [];
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.organizationId !== args.organizationId ||
			node.workspaceId !== args.workspaceId ||
			node.archiveOperationId !== undefined ||
			node.kind !== "file"
		) {
			return Result({ _yay: { removed: false, ancestorsLeft: createdAncestorIds.length } });
		}

		const safeToHardDelete = await files_nodes_db_is_eager_node_safe_to_hard_delete(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			pendingUpdate: {
				userId: args.userId,
				eagerCreated: { committedSequence: args.eagerCreatedCommittedSequence },
			},
		});
		if (!safeToHardDelete) {
			return Result({ _yay: { removed: false, ancestorsLeft: createdAncestorIds.length } });
		}

		await files_nodes_db_hard_delete_node(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		});

		const { ancestorsLeft } = await files_nodes_db_remove_created_ancestor_folders_if_safe(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			createdAncestorIds,
		});
		return Result({ _yay: { removed: true, ancestorsLeft } });
	},
});

export type files_nodes_remove_eager_created_node_if_safe_Result =
	typeof remove_eager_created_node_if_safe extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const create_upload_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		filename: v.string(),
		contentType: v.optional(v.string()),
		size: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			assetId: v.id("files_r2_assets"),
			nodeId: v.id("files_nodes"),
			url: v.string(),
			headers: v.record(v.string(), v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return authorized;
		}

		if (args.size > files_MAX_UPLOADS_BYTES) {
			return Result({
				_nay: {
					message: "File too large",
				},
			});
		}

		let parentPath = "/";
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== membership.organizationId ||
				parent.workspaceId !== membership.workspaceId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== undefined
			) {
				return Result({ _nay: { message: "Not found" } });
			}
			parentPath = parent.path;
		}

		const path = path_join(parentPath, args.filename);
		const existingNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("path", path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		const now = Date.now();

		// The check at the top of the handler asked about `parentId`. A filename may carry path
		// segments, so between `parentId` and the file there can be folders nobody has asked about, and
		// one of them can be a restricted folder this caller may not write. The create below walks them
		// and does refuse — but by then this mutation has archived the old file and written an asset
		// doc, and a Convex mutation that returns normally commits both. So ask about them here, while
		// nothing has been written yet. Only folders that already exist can carry a restriction, which
		// is the same set the create walk checks.
		const nameSegments = path_extract_segments_from(args.filename);
		let intermediateParentId = args.parentId;
		for (const name of nameSegments.slice(0, -1)) {
			const intermediate = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("parentId", intermediateParentId)
						.eq("name", name)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!intermediate) {
				break;
			}

			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					fileNode: intermediate,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			intermediateParentId = intermediate._id;
		}

		if (existingNode) {
			if (existingNode.kind !== "file") {
				return Result({
					_nay: {
						message: "The path cannot point to a folder",
					},
				});
			}

			// Uploading over a name archives whatever holds it. The check above asked about the folder, so
			// without this an upload could replace a restricted file the caller cannot even open.
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					fileNode: existingNode,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			await files_nodes_db_archive_nodes(ctx, {
				nodeIds: [existingNode._id],
				updatedBy: userAuth.id,
				now,
			});
		}

		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: "upload",
			r2Bucket: r2_get_bucket(),
			size: args.size,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const assetR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId,
		});

		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			parentId: args.parentId,
			path: args.filename,
			kind: "file",
			contentType: args.contentType,
			assetId,
			now,
		});
		if (nodeIdResult._nay) {
			return Result({ _nay: nodeIdResult._nay });
		}

		const signedUpload = await r2_generate_upload_url(assetR2Key);
		const headers: Record<string, string> = args.contentType ? { "Content-Type": args.contentType } : {};

		return Result({
			_yay: {
				assetId,
				nodeId: nodeIdResult._yay,
				url: signedUpload.url,
				headers,
			},
		});
	},
});

/**
 * rename() semantics: only an EMPTY folder can be replaced. Committed active children count
 * as occupancy, and so do the user's own pending moves into the folder (replacing it would
 * break their destinations).
 */
async function db_folder_occupant_is_empty(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		folderId: Id<"files_nodes">;
		userId: string;
	},
) {
	const activeChild = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", args.folderId),
		)
		.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
		.first();
	if (activeChild) {
		return false;
	}
	const pendingUpdates = await files_db_list_pending_updates_for_user(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
	});
	if (pendingUpdates.some((pendingUpdate) => pendingUpdate.pendingMove?.destParentId === args.folderId)) {
		return false;
	}
	return true;
}

/**
 * Shared base validation for a pending move target: resolve the node and destination and run
 * the checks both modes need. The node ids are authoritative, so the same resolution runs
 * when the proposal is created and when it is applied.
 */
async function db_resolve_pending_move_target(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
	},
) {
	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.archiveOperationId !== undefined
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	let destParentPath: string;
	if (args.destParentId === files_ROOT_ID) {
		destParentPath = "/";
	} else {
		const destParent = await ctx.db.get("files_nodes", args.destParentId);
		if (
			!destParent ||
			destParent.organizationId !== args.organizationId ||
			destParent.workspaceId !== args.workspaceId ||
			destParent.kind !== "folder" ||
			destParent.archiveOperationId !== undefined
		) {
			return Result({ _nay: { message: "Destination folder is missing" } });
		}
		destParentPath = destParent.path;
	}

	const destPath = path_join(destParentPath, args.destName);
	if (destPath === node.path) {
		return Result({ _nay: { message: "Source and destination are the same" } });
	}
	if (node.kind === "folder" && destPath.startsWith(`${node.path}/`)) {
		return Result({ _nay: { message: "Cannot move a folder into itself" } });
	}

	return Result({ _yay: { node, destParentPath, destPath } });
}

/**
 * Replace rules shared by both modes: file-onto-file when requested, and folder-onto-EMPTY-folder
 * (rename() semantics; a non-empty one errors "Directory not empty"). File-onto-folder and
 * folder-onto-file never replace. Echoes the resolved target fields so callers can return the
 * result directly.
 */
async function db_validate_occupant_replace(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
		destParentPath: string;
		destPath: string;
		occupant: Doc<"files_nodes">;
		replaceTarget: Id<"files_nodes"> | "any-active-occupant" | undefined;
		userId: string;
	},
) {
	const { node, destParentPath, destPath, occupant } = args;
	const replaceRequested =
		args.replaceTarget != null && (args.replaceTarget === "any-active-occupant" || occupant._id === args.replaceTarget);
	if (replaceRequested && node.kind === "file" && occupant.kind === "file") {
		return Result({ _yay: { node, destParentPath, destPath, replacesNode: occupant } });
	}
	const folderReplaceRequested = replaceRequested && node.kind === "folder" && occupant.kind === "folder";
	if (
		folderReplaceRequested &&
		(await db_folder_occupant_is_empty(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			folderId: occupant._id,
			userId: args.userId,
		}))
	) {
		return Result({ _yay: { node, destParentPath, destPath, replacesNode: occupant } });
	}
	return Result({
		_nay: { message: folderReplaceRequested ? "Directory not empty" : "Path already exists" },
	});
}

/**
 * Proposal-time validation for a pending move, against the proposer's visible tree: a committed
 * sibling with a pending move away does not conflict, and a destination already claimed by
 * another pending move is rejected.
 */
export async function files_nodes_db_validate_pending_move_target_for_proposal(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
		/**
		 * Replace opt-in: file-onto-file (`mv -f`), or folder-onto-EMPTY-folder (rename()
		 * semantics). `"any-active-occupant"` accepts whichever active node owns the destination;
		 * a node id requires the destination to still be exactly that node.
		 */
		replaceTarget?: Id<"files_nodes"> | "any-active-occupant";
		/** The proposing user: their pending updates build the overlay. */
		userId: string;
	},
) {
	const resolved = await db_resolve_pending_move_target(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
	});
	if (resolved._nay) {
		return resolved;
	}
	const { node, destParentPath, destPath } = resolved._yay;

	const overlay = await files_db_build_pending_path_overlay(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
	});
	// Another pending move already claims this visible destination: reject instead of
	// double-booking one path (this also covers moved-in occupants, which are never replaceable).
	const visibleDestParentPath =
		files_pending_path_overlay_project_committed_path(overlay, destParentPath) ?? destParentPath;
	const visibleDestPath = path_join(visibleDestParentPath, args.destName);
	const claimedByOtherMove = overlay.moves.some(
		(move) => move.nodeId !== args.nodeId && move.visiblePath === visibleDestPath,
	);
	if (claimedByOtherMove) {
		return Result({ _nay: { message: "Path already exists" } });
	}
	// The overlay can place the destination inside the folder's own visible subtree even
	// when the committed paths look unrelated (a parent cycle across two pending moves).
	if (node.kind === "folder") {
		const visibleNodePath = files_pending_path_overlay_project_committed_path(overlay, node.path) ?? node.path;
		if (visibleDestPath === visibleNodePath || visibleDestPath.startsWith(`${visibleNodePath}/`)) {
			return Result({ _nay: { message: "Cannot move a folder into itself" } });
		}
	}

	// Check whether an active sibling already owns the destination name.
	const activeSiblingConflict = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("parentId", args.destParentId)
				.eq("name", args.destName)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (activeSiblingConflict && activeSiblingConflict._id !== args.nodeId) {
		// A sibling the proposer's overlay moves away or hides is not a visible occupant:
		// the destination reads as free for them, and accept auto-replaces any replaceable
		// newcomer occupant.
		const siblingInvisible =
			overlay.hiddenNodeIds.has(activeSiblingConflict._id) ||
			overlay.moves.some((move) => move.nodeId === activeSiblingConflict._id);
		if (!siblingInvisible) {
			return await db_validate_occupant_replace(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				node,
				destParentPath,
				destPath,
				occupant: activeSiblingConflict,
				replaceTarget: args.replaceTarget,
				userId: args.userId,
			});
		}
	}

	return Result({ _yay: { node, destParentPath, destPath, replacesNode: null } });
}

/**
 * Accept-time validation for a pending move, against the committed tree. The pending move
 * claims its destination, so any replaceable active occupant is auto-replaced like rename();
 * a non-replaceable occupant that vacates through the accepting user's own pending move is
 * still returned as `replacesNode`, so the caller can apply a swap cycle or ask to accept
 * the occupant's move first.
 */
export async function files_nodes_db_validate_pending_move_target_for_accept(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
		/** The accepting user: the occupant's vacating pending move must be theirs. */
		userId: string;
	},
) {
	const resolved = await db_resolve_pending_move_target(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
	});
	if (resolved._nay) {
		return resolved;
	}
	const { node, destParentPath, destPath } = resolved._yay;

	// Check whether an active sibling already owns the destination name.
	const activeSiblingConflict = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("parentId", args.destParentId)
				.eq("name", args.destName)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (activeSiblingConflict && activeSiblingConflict._id !== args.nodeId) {
		const replaced = await db_validate_occupant_replace(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			node,
			destParentPath,
			destPath,
			occupant: activeSiblingConflict,
			replaceTarget: "any-active-occupant",
			userId: args.userId,
		});
		if (replaced._nay) {
			// A non-replaceable occupant that vacates through the accepting user's own pending
			// move is still returned: the caller applies a swap cycle or asks to accept it first.
			const occupantPendingUpdate = await files_db_get_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: activeSiblingConflict._id,
			});
			if (occupantPendingUpdate?.pendingMove) {
				return Result({ _yay: { node, destParentPath, destPath, replacesNode: activeSiblingConflict } });
			}
		}
		return replaced;
	}

	return Result({ _yay: { node, destParentPath, destPath, replacesNode: null } });
}

/**
 * Patch one node to its destination and fan out the denormalized paths (chunk scope, descendants).
 **/
async function db_apply_node_move(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
		destPath: string;
		updatedBy: Id<"users">;
		now: number;
	},
) {
	await ctx.db.patch("files_nodes", args.node._id, {
		parentId: args.destParentId,
		name: args.destName,
		path: args.destPath,
		treePath: derive_tree_path_for_file_node(args.destPath, args.node.kind),
		pathDepth: files_path_depth(args.destPath),
		lowercaseExtension: files_lowercase_extension(args.destPath, args.node.kind),
		updatedBy: args.updatedBy,
		updatedAt: args.now,
	});
	if (args.node.kind === "file") {
		await db_patch_file_chunks_scope(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.node._id,
			path: args.destPath,
		});
	}
	await cascade_file_descendants_path(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.node._id,
		parentPath: args.destPath,
	});

	// The node landed under a new parent, so it inherits that parent's restricted scope. A node that
	// is restricted itself keeps its own scope, and carries its whole subtree with it, so nothing
	// below it changes either.
	//
	// Moving a file out of a restricted folder does open it to the whole workspace. That is on purpose,
	// and it is why the callers ask `authorize_leaving_restricted_scope` first: this helper only writes
	// the result. `args.node` was read before the patch above, so it still holds the scope from before
	// the move.
	if (args.node.restrictedScopeNodeId !== args.node._id) {
		const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
			parentId: args.destParentId,
		});
		if (destScopeNodeId !== args.node.restrictedScopeNodeId) {
			await ctx.db.patch("files_nodes", args.node._id, { restrictedScopeNodeId: destScopeNodeId });
			await files_nodes_db_cascade_restricted_scope(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: args.node._id,
				scopeNodeId: destScopeNodeId,
			});
		}
	}
}

/**
 * Apply an accepted pending move. Re-validates, then mirrors `rename_node`'s tail; this helper
 * owns the denormalized path fan-out (node, file chunk scope, descendant cascade).
 *
 * `_yay.cycleMemberPendingUpdates` lists the other pending update docs applied together with
 * this one when the user's moves form a swap cycle; the caller must settle those docs too.
 */
export async function files_nodes_db_apply_pending_move(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
		userId: string;
		updatedBy: Id<"users">;
		/**
		 * Whether the caller may move one node of a swap cycle to its own destination.
		 *
		 * The caller authorized the node it was asked about. A cycle drags in nodes it never named:
		 * accepting `/A` also moves whatever sits on `/A`'s destination. Those need the same two
		 * questions, asked now, because a proposal can outlive the access that created it.
		 *
		 * Required, not optional, so a new caller cannot quietly move nodes nobody asked about.
		 */
		authorizeCycleMember: (args: {
			node: Doc<"files_nodes">;
			destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		}) => Promise<boolean>;
	},
) {
	// A committed rename can land the node at the proposed destination before the accept
	// (validation would call that "Source and destination are the same"). Treat it as an
	// already-applied move: a success no-op, so the caller settles the doc normally.
	const acceptedNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		acceptedNode &&
		acceptedNode.organizationId === args.organizationId &&
		acceptedNode.workspaceId === args.workspaceId &&
		acceptedNode.archiveOperationId === undefined &&
		acceptedNode.parentId === args.destParentId &&
		acceptedNode.name === args.destName
	) {
		return Result({
			_yay: { destPath: acceptedNode.path, cycleMemberPendingUpdates: [] as Doc<"files_pending_updates">[] },
		});
	}

	const validated = await files_nodes_db_validate_pending_move_target_for_accept(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
		userId: args.userId,
	});
	if (validated._nay) {
		return validated;
	}
	const { node, destPath } = validated._yay;

	// Update the node once and then rebase descendants under the new materialized path.
	const now = Date.now();
	if (validated._yay.replacesNode) {
		// An occupant that is itself the source of this user's chained pending move must
		// move away first: archiving it here would silently break that other proposal.
		const occupantPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: validated._yay.replacesNode._id,
		});
		if (occupantPendingUpdate?.pendingMove) {
			// The chain of same-user pending moves can close back on this node (a swap
			// built through a temp name). Such a swap cycle has no acceptable order, so
			// accept applies every member's move together: the destinations are each other's
			// sources inside one transaction, so no re-validation and no archiving is needed.
			const cycleMembers: Array<{
				node: Doc<"files_nodes">;
				pendingUpdate: Doc<"files_pending_updates">;
				destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
				destName: string;
			}> = [];
			let isCycle = false;
			let memberNode = validated._yay.replacesNode;
			let memberPendingUpdate = occupantPendingUpdate;
			let memberPendingMove = occupantPendingUpdate.pendingMove;
			// Each hop consumes one of the user's pending moves, so the visited set bounds the
			// walk: the chain ends, reaches the accepted node, or revisits a member.
			const visitedNodeIds = new Set<Id<"files_nodes">>([memberNode._id]);
			while (true) {
				const nextOccupant = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("parentId", memberPendingMove.destParentId)
							.eq("name", memberPendingMove.destName)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (!nextOccupant) {
					break;
				}
				cycleMembers.push({
					node: memberNode,
					pendingUpdate: memberPendingUpdate,
					destParentId: memberPendingMove.destParentId,
					destName: memberPendingMove.destName,
				});
				if (nextOccupant._id === args.nodeId) {
					isCycle = true;
					break;
				}
				if (visitedNodeIds.has(nextOccupant._id)) {
					// The chain closed on itself without the accepted node: not this node's swap cycle.
					break;
				}
				const nextPendingUpdate = await files_db_get_pending_update(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodeId: nextOccupant._id,
				});
				if (!nextPendingUpdate?.pendingMove) {
					break;
				}
				visitedNodeIds.add(nextOccupant._id);
				memberNode = nextOccupant;
				memberPendingUpdate = nextPendingUpdate;
				memberPendingMove = nextPendingUpdate.pendingMove;
			}

			if (isCycle) {
				// Ask about every node the cycle drags in, before anything is written. The caller proved
				// only the node it was asked about; these were found by following the chain. Moving one
				// is a real write: it changes the node's path, and a node that merely sits inside a
				// restricted folder also loses that folder's scope when it lands somewhere open.
				for (const member of cycleMembers) {
					if (!(await args.authorizeCycleMember({ node: member.node, destParentId: member.destParentId }))) {
						return Result({ _nay: { message: "Permission denied" } });
					}
				}

				// A destination can sit inside a folder that is itself a cycle member, so paths
				// captured before the apply go stale mid-transaction. Compute every member's
				// final path from the FINAL parent chain (moved parents use their destination,
				// committed parents their stored fields) before writing anything. A chain that
				// revisits a node means the final tree would contain a parent loop — possible
				// when another user nested a destination parent under its mover after the
				// proposal — so refuse it instead of applying.
				const finalMoves = [
					{ node, destParentId: args.destParentId, destName: args.destName },
					...cycleMembers.map((member) => ({
						node: member.node,
						destParentId: member.destParentId,
						destName: member.destName,
					})),
				];
				const finalMovesByNodeId = new Map(finalMoves.map((move) => [move.node._id, move]));
				const finalPaths: string[] = [];
				for (const move of finalMoves) {
					const chainNodeIds = new Set<Id<"files_nodes">>([move.node._id]);
					const segments = [move.destName];
					let parentId = move.destParentId;
					let loops = false;
					while (parentId !== files_ROOT_ID) {
						if (chainNodeIds.has(parentId)) {
							loops = true;
							break;
						}
						chainNodeIds.add(parentId);
						const parentMove = finalMovesByNodeId.get(parentId);
						if (parentMove) {
							segments.unshift(parentMove.destName);
							parentId = parentMove.destParentId;
							continue;
						}
						const parent = await ctx.db.get("files_nodes", parentId);
						if (!parent) {
							return Result({ _nay: { message: "Destination folder is missing" } });
						}
						segments.unshift(parent.name);
						parentId = parent.parentId;
					}
					if (loops) {
						return Result({ _nay: { message: "Cannot move a folder into itself" } });
					}
					finalPaths.push(`/${segments.join("/")}`);
				}
				for (const [index, move] of finalMoves.entries()) {
					await db_apply_node_move(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						node: move.node,
						destParentId: move.destParentId,
						destName: move.destName,
						destPath: finalPaths[index],
						updatedBy: args.updatedBy,
						now,
					});
				}
				return Result({
					_yay: {
						destPath: finalPaths[0],
						cycleMemberPendingUpdates: cycleMembers.map((member) => member.pendingUpdate),
					},
				});
			}

			return Result({
				_nay: { message: `Accept the pending move of "${validated._yay.replacesNode.name}" first` },
			});
		}
		// Archive (never hard-delete) the occupant of the destination path — a file, or an
		// empty folder — whether it was the proposed replace target or a newcomer created
		// after the proposal.
		//
		// The caller was authorized for the node being moved and for the destination folder. This
		// occupant is neither: it is whatever happens to sit on the path right now, so it needs its own
		// answer before it is archived.
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.updatedBy,
				fileNode: validated._yay.replacesNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: [validated._yay.replacesNode._id],
			updatedBy: args.updatedBy,
			now,
		});
	}
	await db_apply_node_move(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		node,
		destParentId: args.destParentId,
		destName: args.destName,
		destPath,
		updatedBy: args.updatedBy,
		now,
	});
	return Result({ _yay: { destPath, cycleMemberPendingUpdates: [] as Doc<"files_pending_updates">[] } });
}

export const rename_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		path: v.string(),
	},
	returns: v_result({ _yay: v.null(), _nay: { data: v.any() } }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode,
		});
		if (authorized._nay) {
			return authorized;
		}

		const pathSegments = path_extract_segments_from(args.path);
		// Resolve the target first so simple and nested renames share one conflict/write path.
		let targetParentId = fileNode.parentId;
		let targetParentPath: string | null;
		let leafName: string;

		if (pathSegments.length > 1) {
			targetParentPath = fileNode.parentId === files_ROOT_ID ? "/" : null;
			// We trust that the front-end is validating the input correctly.
			for (const name of pathSegments.slice(0, -1)) {
				const existing = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("parentId", targetParentId)
							.eq("name", name)
							.eq("archiveOperationId", undefined),
					)
					.first();

				if (existing) {
					if (existing._id === args.nodeId) {
						return Result({
							_nay: {
								name: "nay",
								message: "Not found",
							},
						});
					}

					// A path-like rename is a move, and this is the folder it would land in. The check at
					// the top of the handler asked about the node being renamed, not about here. Asked
					// through the membership, because `access_control_db_can_act_on_file_node` waves an open
					// node through on the promise that workspace write was already proved, and here it was
					// not: a grant on the node being renamed says nothing about this folder.
					const authorizedSegment = await authorize_file_write(ctx, {
						userAuth,
						membership,
						nodeId: existing._id,
					});
					if (authorizedSegment._nay) {
						return Result({ _nay: { name: "nay", message: "Permission denied" } });
					}

					if (existing.kind === "folder") {
						targetParentId = existing._id;
						targetParentPath = existing.path;
						continue;
					}

					return Result({
						_nay: {
							name: "nay",
							message: "This folder already exists.",
						},
					});
				}

				if (targetParentPath == null) {
					targetParentPath = await resolve_parent_path_from_parent_id(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						parentId: targetParentId,
					});
					if (targetParentPath == null) {
						return Result({ _yay: null });
					}
				}

				// Creating the missing segment writes into whatever holds it, so that folder decides. Nothing
				// has asked about it: the loop starts at the renamed node's own parent, which a grant on the
				// node says nothing about.
				const authorizedNewSegment = await authorize_file_write(ctx, {
					userAuth,
					membership,
					nodeId: targetParentId,
				});
				if (authorizedNewSegment._nay) {
					return Result({ _nay: { name: "nay", message: "Permission denied" } });
				}

				const folderPath = path_join(targetParentPath, name);
				const folderNodeIdResult = await db_insert_node(ctx, {
					userId: userAuth.id,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					parentId: targetParentId,
					name,
					path: folderPath,
					kind: "folder",
					now: Date.now(),
				});
				if (folderNodeIdResult._nay) {
					return folderNodeIdResult;
				}

				targetParentId = folderNodeIdResult._yay;
				targetParentPath = folderPath;
			}

			const resolvedLeafName = pathSegments.at(-1);
			if (!resolvedLeafName) {
				const errorMessage = "leafName not resolved after path rename";
				const errorData = {};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			leafName = resolvedLeafName;
		} else {
			const parentPath = await resolve_parent_path_from_parent_id(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId: fileNode.parentId,
			});
			if (parentPath == null) {
				return Result({ _yay: null });
			}

			targetParentPath = parentPath;
			leafName = args.path;
		}

		if (targetParentPath == null) {
			const parentPath = await resolve_parent_path_from_parent_id(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId: targetParentId,
			});
			if (parentPath == null) {
				return Result({ _yay: null });
			}
			targetParentPath = parentPath;
		}

		const renamedPath = path_join(targetParentPath, leafName);
		if (fileNode.archiveOperationId === undefined) {
			// Check whether an active sibling already owns the target name.
			const activeSiblingConflict = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("parentId", targetParentId)
						.eq("name", leafName)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (activeSiblingConflict && activeSiblingConflict._id !== args.nodeId) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
		}

		const now = Date.now();

		// Update the node once and then rebase descendants under the new materialized path.
		await ctx.db.patch("files_nodes", args.nodeId, {
			parentId: targetParentId,
			name: leafName,
			path: renamedPath,
			treePath: derive_tree_path_for_file_node(renamedPath, fileNode.kind),
			pathDepth: files_path_depth(renamedPath),
			lowercaseExtension: files_lowercase_extension(renamedPath, fileNode.kind),
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		if (fileNode.kind === "file") {
			await db_patch_file_chunks_scope(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				path: renamedPath,
			});
		}
		await cascade_file_descendants_path(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.nodeId,
			parentPath: renamedPath,
		});

		// A rename can be a move: typing `private/notes.md` re-parents the node into `private`. So the
		// same rule as `move_nodes` applies, or a file renamed into a restricted folder would keep the
		// open access it had outside and stay readable by the whole workspace.
		if (targetParentId !== fileNode.parentId && fileNode.restrictedScopeNodeId !== args.nodeId) {
			const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
				parentId: targetParentId,
			});
			if (destScopeNodeId !== fileNode.restrictedScopeNodeId) {
				await ctx.db.patch("files_nodes", args.nodeId, { restrictedScopeNodeId: destScopeNodeId });
				await files_nodes_db_cascade_restricted_scope(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					parentId: args.nodeId,
					scopeNodeId: destScopeNodeId,
				});
			}
		}

		return Result({ _yay: null });
	},
});

export const move_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		itemIds: v.array(v.id("files_nodes")),
		targetParentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// The destination is the first question: dropping into a folder writes into that folder. Each
		// moved node is asked about separately below, because moving something is also a write to it.
		const authorizedTarget = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.targetParentId,
		});
		if (authorizedTarget._nay) {
			return authorizedTarget;
		}

		const targetParentPath = await resolve_parent_path_from_parent_id(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.targetParentId,
		});
		if (targetParentPath == null) {
			return Result({ _yay: null });
		}

		const fileNodesToMove: Array<{ itemId: Id<"files_nodes">; fileNode: Doc<"files_nodes">; movedPath: string }> = [];

		for (const itemId of args.itemIds) {
			const fileNode = await ctx.db.get("files_nodes", itemId);
			if (
				!fileNode ||
				fileNode.organizationId !== membership.organizationId ||
				fileNode.workspaceId !== membership.workspaceId
			) {
				continue;
			}

			// A node the caller may not write refuses the whole call instead of being skipped quietly.
			// A silent skip would leave the sidebar showing a move that never happened.
			const authorizedNode = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.write",
				fileNode,
			});
			if (authorizedNode._nay) {
				return authorizedNode;
			}

			const authorizedLeaving = await authorize_leaving_restricted_scope(ctx, {
				userAuth,
				membership,
				fileNode,
				destParentId: args.targetParentId,
			});
			if (authorizedLeaving._nay) {
				return authorizedLeaving;
			}

			const movedPath = path_join(targetParentPath, fileNode.name);
			fileNodesToMove.push({ itemId, fileNode, movedPath });
		}

		const movingNodeIds = new Set(fileNodesToMove.map((fileNodeToMove) => fileNodeToMove.itemId));
		const movedPathByNodeId = new Map<string, Id<"files_nodes">>();
		for (const fileNodeToMove of fileNodesToMove) {
			if (fileNodeToMove.fileNode.archiveOperationId !== undefined) {
				continue;
			}

			const duplicateTargetNodeId = movedPathByNodeId.get(fileNodeToMove.movedPath);
			if (duplicateTargetNodeId && duplicateTargetNodeId !== fileNodeToMove.itemId) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
			movedPathByNodeId.set(fileNodeToMove.movedPath, fileNodeToMove.itemId);

			// Check whether an active file node already exists for the same path.
			const activePathConflict = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("path", fileNodeToMove.movedPath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (activePathConflict && !movingNodeIds.has(activePathConflict._id)) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
		}

		const now = Date.now();
		for (const fileNodeToMove of fileNodesToMove) {
			// Same-parent drag: no structural change, so skip the patch entirely. Stamping
			// updatedBy here would mark the node as touched by this user and wrongly block
			// the eager hard-delete gate on discard/expiry.
			if (
				fileNodeToMove.movedPath === fileNodeToMove.fileNode.path &&
				fileNodeToMove.fileNode.parentId === args.targetParentId
			) {
				continue;
			}
			await ctx.db.patch("files_nodes", fileNodeToMove.itemId, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId: args.targetParentId,
				path: fileNodeToMove.movedPath,
				treePath: derive_tree_path_for_file_node(fileNodeToMove.movedPath, fileNodeToMove.fileNode.kind),
				pathDepth: files_path_depth(fileNodeToMove.movedPath),
				lowercaseExtension: files_lowercase_extension(fileNodeToMove.movedPath, fileNodeToMove.fileNode.kind),
				updatedBy: userAuth.id,
				updatedAt: now,
			});
			if (fileNodeToMove.fileNode.kind === "file") {
				await db_patch_file_chunks_scope(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: fileNodeToMove.itemId,
					path: fileNodeToMove.movedPath,
				});
			}
			await cascade_file_descendants_path(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId: fileNodeToMove.itemId,
				parentPath: fileNodeToMove.movedPath,
			});

			// Same rule as `db_apply_node_move`: the node inherits the restricted scope of where it
			// landed, unless it is the restricted node itself, which carries its own subtree with it.
			// This mutation patches nodes by hand instead of going through that helper, so the rule has
			// to be applied here too.
			if (fileNodeToMove.fileNode.restrictedScopeNodeId !== fileNodeToMove.itemId) {
				const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
					parentId: args.targetParentId,
				});
				if (destScopeNodeId !== fileNodeToMove.fileNode.restrictedScopeNodeId) {
					await ctx.db.patch("files_nodes", fileNodeToMove.itemId, { restrictedScopeNodeId: destScopeNodeId });
					await files_nodes_db_cascade_restricted_scope(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						parentId: fileNodeToMove.itemId,
						scopeNodeId: destScopeNodeId,
					});
				}
			}
		}
		return Result({ _yay: null });
	},
});

// #region Archive nodes
export async function files_nodes_db_archive_nodes(
	ctx: MutationCtx,
	args: {
		nodeIds: Array<Id<"files_nodes">>;
		updatedBy: Id<"users">;
		now: number;
	},
) {
	const archiveOperationId = crypto.randomUUID();

	await Promise.all(
		args.nodeIds.map(async (nodeId) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!fileNode) {
				return;
			}
			await ctx.db.patch("files_nodes", nodeId, {
				archiveOperationId,
				updatedBy: args.updatedBy,
				updatedAt: args.now,
			});
			if (fileNode.kind === "file") {
				await db_patch_file_chunks_scope(ctx, {
					organizationId: fileNode.organizationId,
					workspaceId: fileNode.workspaceId,
					nodeId,
					archiveOperationId,
				});
			}
		}),
	);
}

export const archive_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeIds: v.array(v.string()),
	},
	returns: v_result({ _yay: v.null(), _nay: { data: v.any() } }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const nodeIds = [];
		for (const maybeNodeId of args.nodeIds) {
			const nodeId = ctx.db.normalizeId("files_nodes", maybeNodeId);
			if (!nodeId) {
				return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: maybeNodeId } } });
			}
			nodeIds.push(nodeId);
		}

		const fileNodes = Result_all(
			await Promise.all(
				nodeIds.map((nodeId) =>
					ctx.db.get("files_nodes", nodeId).then((fileNode) => {
						if (
							!fileNode ||
							fileNode.organizationId !== membership.organizationId ||
							fileNode.workspaceId !== membership.workspaceId
						) {
							return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId } } });
						}

						return Result({ _yay: fileNode });
					}),
				),
			),
		);

		if (fileNodes._nay) {
			return fileNodes;
		}

		// Per node, not per workspace: archiving is a write to the node itself, and a grant on one
		// restricted folder has to be enough to archive what is inside it. The nodes are already loaded
		// here, so this costs no extra read for an unrestricted tree.
		for (const fileNode of fileNodes._yay) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.write",
				fileNode,
			});
			if (authorized._nay) {
				// Somebody who cannot even see this node hears the same answer as somebody who named an id
				// that is not there. Two different refusals would confirm the file exists.
				const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodes: [fileNode],
				});
				return readable
					? authorized
					: Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: fileNode._id } } });
			}
		}

		const nodeIdsToArchive = new Set<Id<"files_nodes">>();

		for (const fileNode of fileNodes._yay) {
			if (fileNode.archiveOperationId !== undefined) {
				continue;
			}

			nodeIdsToArchive.add(fileNode._id);

			// All descendant file nodes need to be archived too.
			const descendantsPathPrefix = `${fileNode.path}/`;
			const descendantFileNodes = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.gte("path", descendantsPathPrefix)
						.lt("path", `${descendantsPathPrefix}\uffff`),
				)
				.collect();

			const activeDescendants = descendantFileNodes.filter(
				(descendantFileNode) => descendantFileNode.archiveOperationId === undefined,
			);

			// A folder can hold a restricted folder the caller was never given, and the check above only
			// asked about the node they named. Without this, writing to the folder above is enough to
			// archive somebody else's restricted subtree.
			if (
				!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					rootScopeNodeId: fileNode.restrictedScopeNodeId,
					nodes: activeDescendants,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			for (const descendantFileNode of activeDescendants) {
				nodeIdsToArchive.add(descendantFileNode._id);
			}
		}

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: [...nodeIdsToArchive],
			updatedBy: userAuth.id,
			now: Date.now(),
		});

		return Result({ _yay: null });
	},
});

/**
 * The two fields that name whatever blocked a restore, kept only for a caller who may read it.
 *
 * Every conflict refusal in `unarchive_nodes` names a second node, and the caller did not always ask
 * about that one: it can be an ancestor the sweep walked up to, or a node already sitting on the
 * target path. A `content.write` role without `content.read` reaches these refusals, so the path is
 * worth hiding, and the id is worth hiding on its own — it opens files elsewhere. The message stays
 * either way, because a caller has to learn the restore is blocked.
 */
async function unarchive_conflict_fields(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		conflictFileNode: Doc<"files_nodes">;
	},
) {
	const authorized = await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: args.conflictFileNode._id,
		permission: "content.read",
	});

	return authorized._nay
		? {}
		: { conflictingNodeId: args.conflictFileNode._id, conflictingFilePath: args.conflictFileNode.path };
}

export const unarchive_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeIds: v.array(v.string()),
	},
	returns: v_result({ _yay: v.null(), _nay: { data: v.any() } }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		if (args.nodeIds.length === 0) {
			return Result({ _yay: null });
		}

		const nodeIds = [];
		for (const maybeNodeId of args.nodeIds) {
			const nodeId = ctx.db.normalizeId("files_nodes", maybeNodeId);
			if (!nodeId) {
				return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: maybeNodeId } } });
			}
			nodeIds.push(nodeId);
		}

		const fileNodes = Result_all(
			await Promise.all(
				nodeIds.map((nodeId) =>
					ctx.db.get("files_nodes", nodeId).then((fileNode) => {
						if (
							!fileNode ||
							fileNode.organizationId !== membership.organizationId ||
							fileNode.workspaceId !== membership.workspaceId
						) {
							return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId } } });
						}
						return Result({ _yay: fileNode });
					}),
				),
			),
		);

		if (fileNodes._nay) {
			return fileNodes;
		}

		// Per node, like `archive_nodes`. An archived node keeps the restricted scope it had, so
		// restoring something out of a restricted folder still asks that folder for permission.
		for (const fileNode of fileNodes._yay) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.write",
				fileNode,
			});
			if (authorized._nay) {
				// Same as `archive_nodes`: a node the caller cannot see answers "Not found", so the refusal
				// does not tell them it is in the archive.
				const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodes: [fileNode],
				});
				return readable
					? authorized
					: Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: fileNode._id } } });
			}
		}

		const fileNodesToUnarchive = [...fileNodes._yay];

		// Find the top most shared ancestor for each requested file node.
		const topMostSharedAncestorsByPath = new Map<string, Doc<"files_nodes">>();
		for (const fileNode of fileNodesToUnarchive) {
			if (!fileNode) {
				continue;
			}

			if (fileNode.archiveOperationId === undefined) {
				continue;
			}

			const conflictedCurrentFileNode = topMostSharedAncestorsByPath.get(fileNode.path);
			if (conflictedCurrentFileNode) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive file because it would conflict with another unarchiving file",
						data: {
							requestedNodeIds: args.nodeIds,
							nodeId: fileNode._id,
							filePath: fileNode.path,
							targetPath: fileNode.path,
							...(await unarchive_conflict_fields(ctx, {
								userAuth,
								membership,
								conflictFileNode: conflictedCurrentFileNode,
							})),
						},
					},
				});
			}

			let isDescendantOfCurrentRoot = false;
			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (fileNode.path.startsWith(`${currentRootPath}/`)) {
					isDescendantOfCurrentRoot = true;
					break;
				}
			}
			if (isDescendantOfCurrentRoot) {
				continue;
			}

			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (currentRootPath.startsWith(`${fileNode.path}/`)) {
					topMostSharedAncestorsByPath.delete(currentRootPath);
				}
			}

			topMostSharedAncestorsByPath.set(fileNode.path, fileNode);
		}

		if (topMostSharedAncestorsByPath.size === 0) {
			return Result({ _yay: null });
		}

		const topMostSharedAncestorParentFileNodeById = new Map<string, Doc<"files_nodes">>();
		await Promise.all(
			(function* (/* iife */) {
				const visitedParentIds = new Set<Id<"files_nodes">>();
				for (const ancestorFileNode of topMostSharedAncestorsByPath.values()) {
					if (ancestorFileNode.archiveOperationId === undefined) {
						continue;
					}

					if (
						ancestorFileNode.parentId !== files_ROOT_ID &&
						!topMostSharedAncestorParentFileNodeById.has(ancestorFileNode.parentId) &&
						!visitedParentIds.has(ancestorFileNode.parentId)
					) {
						visitedParentIds.add(ancestorFileNode.parentId);
						yield ctx.db.get("files_nodes", ancestorFileNode.parentId).then((parentFileNode) => {
							if (parentFileNode) {
								topMostSharedAncestorParentFileNodeById.set(ancestorFileNode.parentId, parentFileNode);
							}
						});
					}
				}
			})(),
		);

		// Build one plan entry per file node to unarchive.
		const plans: Array<{
			fileNode: Doc<"files_nodes">;
			targetParentId: Doc<"files_nodes">["parentId"];
			targetPath: string;
		}> = [];
		const ancestorFileNodesByTargetPath = new Map<string, Doc<"files_nodes">>();

		const plansResult = Result_all(
			await Promise.all(
				(function* (/* iife */) {
					for (const ancestorFileNode of topMostSharedAncestorsByPath.values()) {
						if (ancestorFileNode.archiveOperationId === undefined) {
							continue;
						}

						let shouldMoveToRoot = false;
						if (ancestorFileNode.parentId !== files_ROOT_ID) {
							const parentFileNode = topMostSharedAncestorParentFileNodeById.get(ancestorFileNode.parentId);

							// If parent is still archived or invalid, move this subtree to root when unarchiving.
							shouldMoveToRoot =
								!parentFileNode ||
								parentFileNode.organizationId !== membership.organizationId ||
								parentFileNode.workspaceId !== membership.workspaceId ||
								parentFileNode.archiveOperationId !== undefined;
						}

						const ancestorTargetParentId = shouldMoveToRoot ? files_ROOT_ID : ancestorFileNode.parentId;
						let ancestorTargetPath = ancestorFileNode.path;
						if (shouldMoveToRoot) {
							const ancestorPathName = path_extract_segments_from(ancestorFileNode.path).at(-1);
							if (!ancestorPathName) {
								const errorMessage = "Failed to move file to root because path does not include a name segment";
								const errorData = {
									nodeId: ancestorFileNode._id,
									path: ancestorFileNode.path,
								};
								console.error(errorMessage, errorData);
								throw should_never_happen(errorMessage, errorData);
							}
							ancestorTargetPath = `/${ancestorPathName}`;
						}

						yield (async (/* iife */) => {
							const conflictedAncestorFileNode = ancestorFileNodesByTargetPath.get(ancestorTargetPath);
							if (conflictedAncestorFileNode) {
								return Result({
									_nay: {
										name: "nay",
										message: "Failed to unarchive file because it would conflict with another unarchiving file",
										data: {
											requestedNodeIds: args.nodeIds,
											nodeId: ancestorFileNode._id,
											filePath: ancestorFileNode.path,
											targetPath: ancestorTargetPath,
											...(await unarchive_conflict_fields(ctx, {
												userAuth,
												membership,
												conflictFileNode: conflictedAncestorFileNode,
											})),
										},
									},
								});
							}
							ancestorFileNodesByTargetPath.set(ancestorTargetPath, ancestorFileNode);

							plans.push({
								fileNode: ancestorFileNode,
								targetParentId: ancestorTargetParentId,
								targetPath: ancestorTargetPath,
							});

							return ctx.db
								.query("files_nodes")
								.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
									q
										.eq("organizationId", membership.organizationId)
										.eq("workspaceId", membership.workspaceId)
										.gte("path", `${ancestorFileNode.path}/`)
										.lt("path", `${ancestorFileNode.path}/\uffff`),
								)
								.collect()
								.then((descendantFileNodes) => {
									for (const descendantFileNode of descendantFileNodes) {
										if (descendantFileNode.archiveOperationId === undefined) {
											continue;
										}

										const targetPath = path_rebase({
											fromBasePath: ancestorFileNode.path,
											toBasePath: ancestorTargetPath,
											path: descendantFileNode.path,
										});

										if (!targetPath) {
											const errorMessage = "Failed to rebase descendant file nodes";
											const errorData = {
												ancestorNodeId: ancestorFileNode._id,
												ancestorPath: ancestorFileNode.path,
												ancestorTargetPath,
												ancestorTargetParentId,
												descendantNodeId: descendantFileNode._id,
												descendantFilePath: descendantFileNode.path,
											};
											console.error(errorMessage, errorData);
											throw should_never_happen(errorMessage, errorData);
										}

										plans.push({
											fileNode: descendantFileNode,
											targetParentId: descendantFileNode.parentId,
											targetPath,
										});
									}

									return Result({ _yay: null });
								});
						})();
					}
				})(),
			),
		);

		if (plansResult._nay) {
			return plansResult;
		}

		// `plans` holds the whole restored subtree, not only the nodes the caller named, and an archived
		// node keeps the restricted scope it had. Without this, restoring an open folder would also
		// restore a restricted folder nested inside it for somebody holding no grant on it.
		//
		// No `rootScopeNodeId` here: the named nodes were each checked above, and this call is about
		// everything the sweep added, which can carry any scope.
		if (
			!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				rootScopeNodeId: undefined,
				nodes: plans.map((plan) => plan.fileNode),
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// A plan that lands somewhere new is a move, and dropping into a folder writes into that folder.
		// Asked before the conflict loop, like `move_nodes`, so a refused caller is not told which path is
		// taken. Same skip as the scope loop below, because a node that carries its own restriction keeps
		// it wherever it lands, so moving that one opens nothing. Refusing it would also strand the
		// folder: the destination is picked by this code, not by the caller, and the only people who can
		// see the folder are the ones its share list names.
		for (const plan of plans) {
			if (plan.targetParentId === plan.fileNode.parentId || plan.fileNode.restrictedScopeNodeId === plan.fileNode._id) {
				continue;
			}

			const authorizedTarget = await authorize_file_write(ctx, {
				userAuth,
				membership,
				nodeId: plan.targetParentId,
			});
			if (authorizedTarget._nay) {
				return authorizedTarget;
			}
		}

		for (const [ancestorTargetPath, ancestorFileNode] of ancestorFileNodesByTargetPath) {
			// Check whether an active file node already exists for the same path.
			const conflictFileNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("path", ancestorTargetPath)
						.eq("archiveOperationId", undefined),
				)
				.first();

			if (conflictFileNode) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive file because path already exists",
						data: {
							requestedNodeIds: args.nodeIds,
							nodeId: ancestorFileNode._id,
							filePath: ancestorFileNode.path,
							targetPath: ancestorTargetPath,
							...(await unarchive_conflict_fields(ctx, {
								userAuth,
								membership,
								conflictFileNode,
							})),
						},
					},
				});
			}
		}

		const now = Date.now();

		await Promise.all(
			plans.map(async (plan) => {
				await ctx.db.patch("files_nodes", plan.fileNode._id, {
					archiveOperationId: undefined,
					updatedBy: userAuth.id,
					updatedAt: now,
					pathDepth: files_path_depth(plan.targetPath),
					lowercaseExtension: files_lowercase_extension(plan.targetPath, plan.fileNode.kind),
					...(plan.targetPath !== plan.fileNode.path
						? { treePath: derive_tree_path_for_file_node(plan.targetPath, plan.fileNode.kind) }
						: {}),
					...(plan.targetPath !== plan.fileNode.path ? { path: plan.targetPath } : {}),
					...(plan.targetParentId !== plan.fileNode.parentId ? { parentId: plan.targetParentId } : {}),
				});
				if (plan.fileNode.kind === "file") {
					await db_patch_file_chunks_scope(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						nodeId: plan.fileNode._id,
						path: plan.targetPath,
						archiveOperationId: undefined,
					});
				}
			}),
		);

		// A subtree whose parent stayed archived comes back at the top of the tree. That is a move to a
		// new parent, so it follows the same rule as `rename_node`: it inherits the scope of where it
		// lands, which at the root is none. Without this it would keep pointing at a restricted folder
		// still in the archive, and nobody could open the share dialog that decides who gets in.
		for (const plan of plans) {
			if (plan.targetParentId === plan.fileNode.parentId || plan.fileNode.restrictedScopeNodeId === plan.fileNode._id) {
				continue;
			}

			const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
				parentId: plan.targetParentId,
			});
			if (destScopeNodeId !== plan.fileNode.restrictedScopeNodeId) {
				await ctx.db.patch("files_nodes", plan.fileNode._id, { restrictedScopeNodeId: destScopeNodeId });
				await files_nodes_db_cascade_restricted_scope(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					parentId: plan.fileNode._id,
					scopeNodeId: destScopeNodeId,
				});
			}
		}

		return Result({ _yay: null });
	},
});
// #endregion Archive nodes

export const get_file_node_for_membership = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		if (!fileNodeId) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", fileNodeId);
		if (!fileNode) {
			return null;
		}

		// The permission is checked against the node, not the workspace, so a file inside a restricted
		// folder is refused here even for somebody the workspace lets read everything else.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		return fileNode;
	},
});

export const get_authorized_by_path = query({
	args: { membershipId: v.id("organizations_workspaces_users"), path: v.string() },
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			name: v.string(),
			kind: doc(app_convex_schema, "files_nodes").fields.kind,
			assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode =
			args.path === "/"
				? null
				: await ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
							q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("path", args.path)
								.eq("archiveOperationId", undefined),
						)
						.first();

		if (!fileNode) {
			return null;
		}

		// A link that uses a path opens the same nodes as a link that uses `?nodeId=`, so it gets the
		// same check on the node. Otherwise a shared path URL would give out a node id that
		// `get_file_node_for_membership` would then refuse to open.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		return {
			nodeId: fileNode._id,
			name: fileNode.name,
			kind: fileNode.kind,
			...(fileNode.assetId ? { assetId: fileNode.assetId } : {}),
		};
	},
});

const SUBTREE_FILTER_MAX_ROWS_READ = 1000;

// #region list

export const list_tree = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	// Return whole node documents. Listing the fields here meant every new column broke this query
	// at runtime with a returns-validation error. The four overrides narrow what the handler below
	// guarantees: the visible tree never carries reserved `GLOBAL`/`SYSTEM` values.
	returns: v.array(
		v.object({
			...doc(app_convex_schema, "files_nodes").fields,
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const [userAuth, membership] = await Promise.all([
			server_convex_get_user_fallback_to_anonymous(ctx),
			ctx.db.get("organizations_workspaces_users", args.membershipId),
		]);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		if (!membership || membership.userId !== userAuth.id || membership.active === false) {
			return [];
		}

		// A failed check does not end the query here. Somebody whose role gives no workspace-wide read
		// can still have been given one folder, and showing them that folder is the whole point of
		// sharing. The filter below is told what the check said and keeps only what they were given.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});

		const allFileNodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.order("asc")
			.collect();

		// The tree is the widest leak in the app: it carries the name and the path of every node in the
		// workspace. Without this filter a restricted file would still be listed for everybody, and the
		// name of a file is often the whole secret.
		const fileNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodes: allFileNodes,
			hasWorkspaceRead: !authorized._nay,
		});

		return fileNodes.map((fileNode) => {
			if (fileNode.createdBy === users_SYSTEM_AUTHOR || fileNode.updatedBy === users_SYSTEM_AUTHOR) {
				const errorMessage = "Reserved SYSTEM author reached visible file tree";
				const errorData = {
					fileNodeId: fileNode._id,
					createdBy: fileNode.createdBy,
					updatedBy: fileNode.updatedBy,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			return {
				...fileNode,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: fileNode.createdBy,
				updatedBy: fileNode.updatedBy,
			};
		});
	},
});

async function db_list_children(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		visibilityUserId: Id<"users">;
		numItems: number;
		cursor: string | null;
		parentId?: Id<"files_nodes"> | typeof files_ROOT_ID;
		orderBy: "name" | "updatedAt";
		order?: "asc" | "desc";
	},
) {
	// A page can come back shorter than `numItems` once restricted nodes are dropped. The cursor still
	// points at the right place, so paging keeps working; only the page size varies.
	const filter_readable = (nodes: Doc<"files_nodes">[]) =>
		access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			nodes,
		});

	if (args.parentId == null) {
		if (args.orderBy === "name") {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("archiveOperationId", undefined),
			)
			.order(args.order ?? "desc")
			.paginate({
				cursor: args.cursor,
				numItems: args.numItems,
			});

		return {
			items: (await filter_readable(result.page)).map((fileNode) => ({
				name: fileNode.name,
				kind: fileNode.kind,
				path: fileNode.path,
				updatedAt: fileNode.updatedAt,
				updatedBy: fileNode.updatedBy,
				contentType: fileNode.contentType,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	}

	const parentId = args.parentId;
	if (parentId !== files_ROOT_ID) {
		const parent = await ctx.db.get("files_nodes", parentId);
		if (
			!parent ||
			parent.organizationId !== args.organizationId ||
			parent.workspaceId !== args.workspaceId ||
			parent.kind !== "folder"
		) {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}
	}

	const result =
		args.orderBy === "name"
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("parentId", parentId)
							.eq("archiveOperationId", undefined),
					)
					.order(args.order ?? "asc")
					.paginate({
						cursor: args.cursor,
						numItems: args.numItems,
					})
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_updatedAt", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("parentId", parentId)
							.eq("archiveOperationId", undefined),
					)
					.order(args.order ?? "desc")
					.paginate({
						cursor: args.cursor,
						numItems: args.numItems,
					});

	return {
		items: (await filter_readable(result.page)).map((fileNode) => ({
			name: fileNode.name,
			kind: fileNode.kind,
			path: fileNode.path,
			updatedAt: fileNode.updatedAt,
			updatedBy: fileNode.updatedBy,
			contentType: fileNode.contentType,
		})),
		continueCursor: result.continueCursor,
		isDone: result.isDone,
	};
}

export const list_children = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and list restricted nodes. */
		visibilityUserId: v.id("users"),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		parentId: v.optional(v.union(v.id("files_nodes"), v.literal(files_ROOT_ID))),
		orderBy: v.union(v.literal("name"), v.literal("updatedAt")),
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				name: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				path: v.string(),
				updatedAt: v.number(),
				updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
				contentType: v.optional(v.string()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		return await db_list_children(ctx, args);
	},
});

export type files_nodes_list_children_Result =
	typeof list_children extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_subtree = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and walk into a restricted folder. */
		visibilityUserId: v.id("users"),
		folderPath: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
		kind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
		lowercaseExtension: v.optional(v.string()),
		minDepth: v.optional(v.number()),
		maxDepth: v.optional(v.number()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_nodes")),
	handler: async (ctx, args) => {
		const lowercaseExtension = args.lowercaseExtension;
		const kind = args.kind;

		if (lowercaseExtension != null && kind === "folder") {
			return { page: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		const normalizedPath = server_path_normalize(args.folderPath);
		const lowerBound = derive_tree_path_for_file_node(normalizedPath, "folder");
		const upperBound = `${lowerBound}\uffff`;
		const baseDepth = files_path_depth(normalizedPath);
		const minAbsoluteDepth = args.minDepth == null ? null : baseDepth + args.minDepth;
		const maxAbsoluteDepth = args.maxDepth == null ? null : baseDepth + args.maxDepth;
		const query =
			lowercaseExtension != null
				? ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_archive_kind_lowercaseExtension_tree", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("archiveOperationId", undefined)
								.eq("kind", "file")
								.eq("lowercaseExtension", lowercaseExtension)
								.gte("treePath", lowerBound)
								.lt("treePath", upperBound),
						)
						.order(args.order ?? "asc")
				: kind == null
					? ctx.db
							.query("files_nodes")
							.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("archiveOperationId", undefined)
									.gte("treePath", lowerBound)
									.lt("treePath", upperBound),
							)
							.order(args.order ?? "asc")
					: ctx.db
							.query("files_nodes")
							.withIndex("by_organization_workspace_archiveOperation_kind_treePath", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("archiveOperationId", undefined)
									.eq("kind", kind)
									.gte("treePath", lowerBound)
									.lt("treePath", upperBound),
							)
							.order(args.order ?? "asc");
		let filteredQuery = query;
		if (minAbsoluteDepth != null && maxAbsoluteDepth != null) {
			filteredQuery = query.filter((q) =>
				q.and(q.gte(q.field("pathDepth"), minAbsoluteDepth), q.lte(q.field("pathDepth"), maxAbsoluteDepth)),
			);
		} else if (minAbsoluteDepth != null) {
			filteredQuery = query.filter((q) => q.gte(q.field("pathDepth"), minAbsoluteDepth));
		} else if (maxAbsoluteDepth != null) {
			filteredQuery = query.filter((q) => q.lte(q.field("pathDepth"), maxAbsoluteDepth));
		}
		const result = await filteredQuery.paginate({
			cursor: args.cursor,
			numItems: args.numItems,
			...(minAbsoluteDepth == null && maxAbsoluteDepth == null
				? {}
				: { maximumRowsRead: SUBTREE_FILTER_MAX_ROWS_READ }),
		});

		// A page can come back shorter once restricted nodes are dropped. The cursor is unchanged, so
		// paging still walks the whole subtree; only the page size varies.
		return {
			...result,
			page: await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.visibilityUserId,
				nodes: result.page,
			}),
		};
	},
});

export type files_nodes_list_subtree_Result =
	typeof list_subtree extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion list

export const search_paths = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and match a restricted path. */
		visibilityUserId: v.id("users"),
		pathQuery: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		kind: v.optional(v.union(v.literal("folder"), v.literal("file"))),
		parentId: v.optional(v.union(v.id("files_nodes"), v.literal(files_ROOT_ID))),
		pathPrefix: v.optional(v.string()),
		minPathDepth: v.optional(v.number()),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				updatedAt: v.number(),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		if (args.parentId != null && args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== args.organizationId ||
				parent.workspaceId !== args.workspaceId ||
				parent.kind !== "folder"
			) {
				return { items: [], continueCursor: args.cursor ?? "", isDone: true };
			}
		}

		const pathPrefixFilter =
			args.pathPrefix == null || args.pathPrefix === "/"
				? null
				: derive_tree_path_for_file_node(args.pathPrefix, "folder");

		let searchQuery = ctx.db.query("files_nodes").withSearchIndex("search_path", (q) => {
			const base = q
				.search("path", args.pathQuery)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("archiveOperationId", undefined);

			if (args.kind != null && args.parentId != null) {
				return base.eq("kind", args.kind).eq("parentId", args.parentId);
			}
			if (args.kind != null) {
				return base.eq("kind", args.kind);
			}
			if (args.parentId != null) {
				return base.eq("parentId", args.parentId);
			}
			return base;
		});
		// Subtree scope rides a post-index `.filter()` (search filterFields are equality-only, so a
		// prefix range cannot ride the index): numItems counts docs that pass the filter, so pages
		// fill with descendants instead of thinning, and the `\uffff` upper bound keeps a
		// sibling-prefix folder like /foo-bar out of a /foo scope.
		if (pathPrefixFilter != null) {
			searchQuery = searchQuery.filter((q) =>
				q.and(q.gte(q.field("treePath"), pathPrefixFilter), q.lt(q.field("treePath"), `${pathPrefixFilter}\uffff`)),
			);
		}

		// The depth floor also runs after the search index. It excludes the starting
		// folder for scoped `find -mindepth 1 --path-query ...`.
		if (args.minPathDepth != null) {
			const minPathDepth = args.minPathDepth;
			searchQuery = searchQuery.filter((q) => q.gte(q.field("pathDepth"), minPathDepth));
		}

		const result = await searchQuery.paginate({
			cursor: args.cursor,
			numItems: args.numItems,
		});

		const readable = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			nodes: result.page,
		});

		return {
			items: readable.map((fileNode) => ({
				path: fileNode.path,
				kind: fileNode.kind,
				updatedAt: fileNode.updatedAt,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_search_paths_Result =
	typeof search_paths extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const file_content_materialization_state_validator = v.object({
	fileNode: doc(app_convex_schema, "files_nodes"),
	yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
	yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
	yjsUpdatesDocs: v.array(doc(app_convex_schema, "files_yjs_updates")),
	asset: doc(app_convex_schema, "files_r2_assets"),
	yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
});

export async function db_get_file_content_materialization_db_state(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		return null;
	}

	if (!files_node_has_editable_yjs_state(fileNode)) {
		return null;
	}

	const [asset, yjsSnapshotDoc, yjsLastSequenceDoc, yjsUpdatesDocs] = await Promise.all([
		ctx.db.get("files_r2_assets", fileNode.assetId),
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
			)
			.order("asc")
			.collect(),
	]);

	// Do not check the asset kind here. node.assetId always holds the file's current bytes, but
	// the kind can vary: usually the newest version snapshot, or an old content row without an
	// r2Key (old data) until a materialization points the node at a fresh snapshot.
	if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
		const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: fileNode.assetId,
			asset,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.organizationId !== args.organizationId ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId ||
		yjsSnapshotDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.organizationId !== args.organizationId ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId ||
		yjsLastSequenceDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const yjsSnapshotAsset = await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId);
	if (
		!yjsSnapshotAsset ||
		yjsSnapshotAsset.organizationId !== args.organizationId ||
		yjsSnapshotAsset.workspaceId !== args.workspaceId ||
		yjsSnapshotAsset.kind !== "yjs_snapshot"
	) {
		const errorMessage = "yjsSnapshotDoc.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: yjsSnapshotDoc.assetId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		fileNode,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		yjsUpdatesDocs,
		asset,
		yjsSnapshotAsset,
	};
}

export const get_file_content_materialization_state = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
	handler: async (ctx, args) => {
		return await db_get_file_content_materialization_db_state(ctx, args);
	},
});

export type get_file_content_materialization_state_Result =
	typeof get_file_content_materialization_state extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

// #region read file

// Bounded reads. DEV-PHASE AGGRESSIVE CAPS: deliberately small so our tiny test files exercise the
// same paging / truncation / fallback paths a huge file would in production. Raise these before
// production. `MAX_LINES` is the per-page line cap for head/sed/tail; `SCAN_MAX_BYTES` is the
// leading-window size for the in-memory/windowed FALLBACK path (committed reads use chunks and are
// depth-unbounded, so this only bounds pending/stale reads).
// Exported so the agent-facing bash tool description / system prompt can interpolate the true
// per-read line cap instead of hardcoding a number that silently drifts when this value changes.
export const files_READ_RANGE_MAX_LINES = 40;
// A single very long line (legitimately minified content, or a deliberate attempt to bypass
// line-based limits) is truncated for display at this many characters, with a marker, so one
// line cannot dominate the bounded output. Generous enough not to clip normal prose lines.
const files_READ_MAX_LINE_CHARS = 8000;

/**
 * Truncate one display line that is pathologically long, appending a clear marker so the
 * agent understands the line continues (rather than being silently cut). Returns the line
 * unchanged when it is within the cap.
 */
function files_truncate_long_display_line(line: string) {
	if (line.length <= files_READ_MAX_LINE_CHARS) {
		return line;
	}
	return `${line.slice(0, files_READ_MAX_LINE_CHARS)} …[line truncated to ${files_READ_MAX_LINE_CHARS} chars — the full line is ${line.length}+ chars]`;
}

/**
 * Returns lines [`startLine`, `startLine`+`maxLines`) of `content` (1-based, each line with
 * its trailing newline), plus how many lines were returned and whether more lines follow
 * within `content`. `content` may be a leading window of a larger file. Over-long lines are
 * truncated for display (with a marker) so a single huge line cannot flood the output.
 */
export function files_line_range_from_text(content: string, startLine: number, maxLines: number) {
	if (maxLines <= 0 || content.length === 0) {
		return { content: "", linesReturned: 0, moreLines: false };
	}
	const hasTrailingNewline = content.endsWith("\n");
	const split = content.split("\n");
	// A trailing newline yields an empty final element that is not a real line; drop it.
	const lines = hasTrailingNewline ? split.slice(0, -1) : split;
	const start = Math.max(0, startLine - 1);
	const slice = lines.slice(start, start + maxLines).map(files_truncate_long_display_line);
	const moreLines = start + maxLines < lines.length;
	const out = slice.length > 0 ? `${slice.join("\n")}\n` : "";
	return { content: out, linesReturned: slice.length, moreLines };
}

/** Returns the last `maxLines` lines of `content` (over-long lines truncated for display). */
export function files_tail_lines_from_text(content: string, maxLines: number) {
	if (maxLines <= 0 || content.length === 0) {
		return { content: "", moreAbove: false };
	}
	const hasTrailingNewline = content.endsWith("\n");
	const split = content.split("\n");
	const lines = hasTrailingNewline ? split.slice(0, -1) : split;
	const slice = lines.slice(Math.max(0, lines.length - maxLines)).map(files_truncate_long_display_line);
	// `moreAbove` is true when the file (or this window) holds lines before the returned tail, so a
	// `tail` view can honestly signal it is partial rather than implying it shows the whole file.
	return { content: slice.length > 0 ? `${slice.join("\n")}\n` : "", moreAbove: lines.length > maxLines };
}

/**
 * Resolve the committed-chunk read target for a path, or null when the chunk fast path must NOT
 * be used: a pending user overlay (not yet committed), a stale snapshot (latest edits not yet
 * committed — chunks would disagree with `cat`), an explicit pendingUpdateId (caller wants a
 * pending view), or a non-file / non-editable node. `byteSize` is the committed content byte size.
 */
async function db_resolve_committed_chunk_source(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		path: string;
		pendingUpdateId?: Id<"files_pending_updates">;
		overlayUserId?: Id<"users">;
	},
): Promise<{
	nodeId: Id<"files_nodes">;
	byteSize: number;
	counts: { lineCount: number; wordCount: number; charCount: number } | null;
} | null> {
	// An explicit pending view is requested → committed chunks are not what the caller wants.
	if (args.pendingUpdateId || args.path === "/") return null;

	const fileNode = await files_db_get_visible_node_by_path(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: args.path,
		overlayUserId: args.overlayUserId,
	});
	if (fileNode == null) return null;
	if (fileNode.kind !== "file") return null;

	// The third door onto a file, next to `read_file_content_from_chunks` and the markdown one. It
	// hands out no text, but `wc` reports exact line, word and byte counts, which is plenty to learn
	// from a file somebody was not given.
	const readable = await access_control_db_can_act_on_file_node(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		fileNode,
		permission: "content.read",
	});
	if (!readable) return null;

	// Exact wc counts from the linked file_stats doc (read O(1) by id — the back-ref the node holds).
	// null when unlinked (old file not yet migrated) or flagged unprocessable (-1), so the stats
	// query falls back to the windowed estimate. Shared by both scopes.
	const resolve_counts = async () => {
		const stats = fileNode.statsId ? await ctx.db.get("file_stats", fileNode.statsId) : null;
		return stats && stats.lineCount >= 0 && stats.wordCount >= 0 && stats.charCount >= 0
			? { lineCount: stats.lineCount, wordCount: stats.wordCount, charCount: stats.charCount }
			: null;
	};

	// External (reserved) scope: no Yjs/pending/materialization. Committed chunks are addressed by
	// node id alone; byte size comes from the linked R2 content asset.
	if (
		organizations_is_global_organization_id(args.organizationId) ||
		organizations_is_reserved_workspace_id(args.workspaceId)
	) {
		const asset = fileNode.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		const byteSize =
			asset &&
			asset.organizationId === args.organizationId &&
			asset.workspaceId === args.workspaceId &&
			asset.kind === "content"
				? asset.size
				: 0;
		return { nodeId: fileNode._id, byteSize, counts: await resolve_counts() };
	}

	if (!files_node_has_editable_yjs_state(fileNode)) return null;

	// Tenant scope (the guards above narrowed both ids): bind them so the narrowing reaches the
	// `withIndex` callback — TS drops property narrowing at closure boundaries.
	const organizationId = args.organizationId;
	const workspaceId = args.workspaceId;

	// The user's unstaged branch is not materialized into chunks; read it via the in-memory path.
	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", organizationId)
				.eq("workspaceId", workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", fileNode._id),
		)
		.first();
	if (pendingUpdate) return null;

	const materializationState = await db_get_file_content_materialization_db_state(ctx, {
		organizationId,
		workspaceId,
		nodeId: fileNode._id,
	});
	if (!materializationState) return null;
	// Stale: edits exist beyond the materialized snapshot, so chunks are behind the committed view.
	if (materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence) return null;

	return {
		nodeId: fileNode._id,
		byteSize: materializationState.asset.size,
		counts: await resolve_counts(),
	};
}

/**
 * Concatenate chunks (given in ascending chunkIndex order) into the exact source substring they
 * span. Returns null if the chunks are not contiguous (each startIndex must equal the previous
 * endIndex) — a safety check so a materialization anomaly falls back rather than returning text
 * with a hidden gap.
 */
export function files_merge_contiguous_chunks(
	chunks: Array<{ startIndex: number; endIndex: number; markdownChunk: string }>,
): string | null {
	let out = "";
	let prevEnd: number | null = null;
	for (const chunk of chunks) {
		if (prevEnd !== null && chunk.startIndex !== prevEnd) return null;
		out += chunk.markdownChunk;
		prevEnd = chunk.endIndex;
	}
	return out;
}

/**
 * Read a forward line window from chunks that are already ordered by their line range.
 *
 * The caller chooses the source query: pending update chunks or committed snapshot chunks.
 * This helper only keeps the chunks that overlap the requested lines, verifies they form
 * one contiguous text span, and then slices the merged text with the same line helper used
 * by action fallbacks.
 */
async function files_read_forward_line_range_from_ordered_chunks(
	chunks: AsyncIterable<{
		startIndex: number;
		endIndex: number;
		lineStart: number;
		lineEnd: number;
		markdownChunk: string;
	}>,
	args: { startLine: number; maxLines: number },
) {
	const startLine = Math.max(1, Math.trunc(args.startLine));
	const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
	const endLine = startLine + maxLines - 1;
	const overlapping: Array<{
		startIndex: number;
		endIndex: number;
		lineStart: number;
		lineEnd: number;
		markdownChunk: string;
	}> = [];
	let hasChunks = false;
	let sawBeyond = false;

	for await (const chunk of chunks) {
		hasChunks = true;

		// The index may start before the requested line when the first returned
		// chunk spans across it. Skip anything that still ends too early.
		if (chunk.lineEnd < startLine) {
			continue;
		}

		// Once a chunk starts after the requested window, every later ordered
		// chunk is also beyond it. Stop so line reads do not scan the whole file.
		if (chunk.lineStart > endLine) {
			sawBeyond = true;
			break;
		}
		overlapping.push(chunk);
	}

	if (overlapping.length === 0) {
		return { hasChunks, content: "", moreLines: sawBeyond };
	}

	const merged = files_merge_contiguous_chunks(overlapping);
	if (merged == null) return null;
	const baseLine = overlapping[0]!.lineStart;
	// The merged text begins at baseLine, so translate the document line number
	// into the merged-string line number before slicing.
	const range = files_line_range_from_text(merged, startLine - baseLine + 1, maxLines);
	return { hasChunks, content: range.content, moreLines: range.moreLines || sawBeyond };
}

/**
 * Read a line range (or the trailing lines) of committed, up-to-date content directly from
 * materialized chunks. Returns { usable: false } when the content is not committed-current (the
 * action then falls back to the in-memory / windowed path). For a forward range it seeks the
 * chunks overlapping [startLine, startLine+maxLines) via the lineEnd index; for `fromEnd` it walks
 * chunks from the end until it has enough trailing lines. Works at any depth — no byte window.
 */
export const read_committed_file_chunks_line_range = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		startLine: v.number(),
		maxLines: v.number(),
		fromEnd: v.boolean(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({ usable: v.literal(false) }),
		v.object({
			usable: v.literal(true),
			nodeId: v.id("files_nodes"),
			content: v.string(),
			moreLines: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const source = await db_resolve_committed_chunk_source(ctx, args);
		if (!source) return { usable: false as const };
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));

		if (args.fromEnd) {
			// tail: stream chunks from the end (descending) only until they cover maxLines distinct
			// lines, then reorder ascending and slice the last maxLines. The trailing chunks are
			// consecutive (so contiguous), and reading just enough of them avoids pulling the whole file.
			const tailChunks: Array<Doc<"files_markdown_chunks">> = [];
			let lastLineEnd: number | null = null;
			for await (const chunk of ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", source.nodeId),
				)
				.order("desc")) {
				if (lastLineEnd === null) lastLineEnd = chunk.lineEnd; // file's last line (first iterated, desc)
				tailChunks.push(chunk);
				// Distinct lines covered so far = lastLine - earliestStart + 1 (contiguous chunks share at
				// most a boundary line, so this counts distinct lines exactly, not a summed over-count).
				if (lastLineEnd - chunk.lineStart + 1 >= maxLines) break;
			}
			if (tailChunks.length === 0) {
				// A non-empty committed file must have chunks; if absent it is not yet materialized.
				if (source.byteSize > 0) return { usable: false as const };
				return { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
			}
			tailChunks.reverse(); // desc → asc (document order)
			const merged = files_merge_contiguous_chunks(tailChunks);
			if (merged == null) return { usable: false as const };
			const tail = files_tail_lines_from_text(merged, maxLines);
			// For `fromEnd`, `moreLines` means "lines precede this tail". `lineEnd` is 0-based, so the
			// file has `lastLineEnd + 1` lines; the tail is partial iff that total exceeds maxLines, i.e.
			// `lastLineEnd >= maxLines`. (Using the file's true last line, not the merged-suffix length,
			// which can equal maxLines on a chunk boundary while earlier lines still exist.)
			const moreLines = (lastLineEnd ?? 0) >= maxLines;
			return { usable: true as const, nodeId: source.nodeId, content: tail.content, moreLines };
		}

		// Seek to the first chunk whose lineEnd >= startLine (which contains the start of line
		// `startLine`), then stream forward in chunkIndex order (the index's trailing chunkIndex column
		// orders same-lineEnd ties), stopping at the first chunk that starts past endLine. lineStart is
		// non-decreasing in chunkIndex, so that first beyond-chunk means every later chunk is beyond too
		// — we read only the chunks overlapping the range, never the whole file, regardless of depth.
		const range = await files_read_forward_line_range_from_ordered_chunks(
			ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_lineEnd_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", source.nodeId)
						.gte("lineEnd", Math.max(1, Math.trunc(args.startLine))),
				)
				.order("asc"),
			{ startLine: args.startLine, maxLines },
		);
		if (range == null) return { usable: false as const };
		if (!range.hasChunks) {
			// No chunk ends at/after startLine: either startLine is past EOF (a valid empty page on a
			// materialized file) or the file is not materialized (fall back).
			const anyChunk = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", source.nodeId),
				)
				.first();
			if (anyChunk) return { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
			return source.byteSize > 0
				? { usable: false as const }
				: { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
		}
		return { usable: true as const, nodeId: source.nodeId, content: range.content, moreLines: range.moreLines };
	},
});

export type files_nodes_read_committed_file_chunks_line_range_Result =
	typeof read_committed_file_chunks_line_range extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Read app-file content directly from chunk tables.
 *
 * Pending update chunks win because they are the user's current view of the file.
 * When there is no pending update, the query reads committed Markdown chunks only if
 * the materialized snapshot is current. Returning null means chunks cannot serve this
 * request; callers decide whether to treat that as no content or use an action fallback.
 */
export const read_file_content_from_chunks = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		mode: v.union(
			v.object({
				kind: v.literal("full"),
				maxBytes: v.number(),
			}),
			v.object({
				kind: v.literal("lines"),
				startLine: v.number(),
				maxLines: v.number(),
			}),
		),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			moreLines: v.boolean(),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Translate the path through the overlay first; the per-user pending-content logic
		// below then runs on the resolved node, so content-plus-move docs compose.
		const fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			overlayUserId: args.overlayUserId,
		});
		if (fileNode == null) return null;
		if (fileNode.kind !== "file") return null;

		// `userId` is the person asking, so the restricted check belongs here and not in each caller.
		// Every reader of file bytes lands in this query or in the markdown one next to it — bash `cat`,
		// `head`, `tail`, `wc`, `sed`, the AI edit tool, the public API — and a check in one of them is a
		// check in all of them. Answering `null` is the same answer a missing file gives, which is what
		// the caller already handles.
		const [readableNode] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodes: [fileNode],
		});
		if (!readableNode) return null;

		const requestedOrganizationId = args.organizationId;
		const requestedWorkspaceId = args.workspaceId;
		const realTenantScope =
			organizations_is_global_organization_id(requestedOrganizationId) ||
			organizations_is_reserved_workspace_id(requestedWorkspaceId)
				? null
				: {
						organizationId: requestedOrganizationId,
						workspaceId: requestedWorkspaceId,
					};
		const isEditableTextFile = files_node_has_editable_yjs_state(fileNode);
		const isReadOnlyPlainTextFile = !isEditableTextFile && (fileNode.contentType?.startsWith("text/plain") ?? false);
		if (realTenantScope) {
			if (!isEditableTextFile && !isReadOnlyPlainTextFile) return null;

			if (isEditableTextFile) {
				// Bind the guard-narrowed ids; TS drops property narrowing inside the closures below.
				const { organizationId, workspaceId } = realTenantScope;

				// Prefer the explicit pending update when the caller is continuing a known
				// read. Otherwise use the current pending edit for this user and file.
				let pendingUpdate: Doc<"files_pending_updates"> | null = null;
				if (args.pendingUpdateId != null) {
					pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId).then((pendingUpdate) => {
						if (
							!pendingUpdate ||
							pendingUpdate.organizationId !== organizationId ||
							pendingUpdate.workspaceId !== workspaceId ||
							pendingUpdate.userId !== args.userId ||
							pendingUpdate.fileNodeId !== fileNode._id
						) {
							return null;
						}
						return pendingUpdate;
					});
					if (pendingUpdate == null) return null;
				} else {
					pendingUpdate = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_organization_workspace_user_fileNode", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("userId", args.userId)
								.eq("fileNodeId", fileNode._id),
						)
						.first();
				}

				// Move-only docs have no pending content; fall through to the committed chunks
				// so reads do not return an empty file behind a move-only doc.
				if (pendingUpdate != null && files_pending_update_content_of(pendingUpdate) != null) {
					// Pending chunks are already the markdown text the user sees. Full reads
					// still honor maxBytes; line reads stream only the overlapping chunks.
					const chunks = ctx.db
						.query("files_markdown_chunks")
						.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdate._id));

					if (args.mode.kind === "full") {
						if (pendingUpdate.size > args.mode.maxBytes) return null;
						const collectedChunks = await chunks.collect();
						if (collectedChunks.length === 0) {
							return pendingUpdate.size > 0
								? null
								: {
										nodeId: fileNode._id,
										content: "",
										moreLines: false,
										pendingUpdateId: pendingUpdate._id,
									};
						}

						const content = files_merge_contiguous_chunks(collectedChunks);
						if (content == null || files_get_utf8_byte_size(content) > args.mode.maxBytes) return null;
						return { nodeId: fileNode._id, content, moreLines: false, pendingUpdateId: pendingUpdate._id };
					}

					const startLine = Math.max(1, Math.trunc(args.mode.startLine));
					const range = await files_read_forward_line_range_from_ordered_chunks(
						ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_pendingUpdate_lineEnd_chunkIndex", (q) =>
								q.eq("pendingUpdateId", pendingUpdate._id).gte("lineEnd", startLine),
							),
						{
							startLine,
							maxLines: args.mode.maxLines,
						},
					);
					if (range == null || (!range.hasChunks && pendingUpdate.size > 0)) return null;
					return {
						nodeId: fileNode._id,
						content: range.content,
						moreLines: range.moreLines,
						pendingUpdateId: pendingUpdate._id,
					};
				}
			} else if (args.pendingUpdateId != null) {
				return null;
			}
		} else if (args.pendingUpdateId != null) {
			// External (reserved) nodes never have pending docs; an explicit pending view cannot resolve.
			return null;
		}

		// Determine the committed byte size used for the cap/empty checks below. Tenant: the materialized
		// snapshot must be current (stale → null so the action fallback runs). External: the linked R2
		// content asset's size.
		let byteSize: number;
		if (realTenantScope && isEditableTextFile) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: realTenantScope.organizationId,
				workspaceId: realTenantScope.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
			byteSize = materializationState.asset.size;
		} else {
			const asset = fileNode.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
			byteSize =
				asset &&
				asset.organizationId === args.organizationId &&
				asset.workspaceId === args.workspaceId &&
				asset.kind === "content"
					? asset.size
					: 0;
		}

		if (args.mode.kind === "full") {
			// Full reads use the byte size as the cheap cap check, then merge the materialized chunks
			// only when the file is small enough to return inline.
			if (byteSize > args.mode.maxBytes) return null;

			const chunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id),
				)
				.collect();
			if (chunks.length === 0) {
				return byteSize > 0 ? null : { nodeId: fileNode._id, content: "", moreLines: false, pendingUpdateId: null };
			}

			const content = files_merge_contiguous_chunks(chunks);
			if (content == null) return null;
			return { nodeId: fileNode._id, content, moreLines: false, pendingUpdateId: null };
		}

		// Line reads use the lineEnd index to seek near the requested start line
		// and avoid reading unrelated leading chunks.
		const startLine = Math.max(1, Math.trunc(args.mode.startLine));
		const range = await files_read_forward_line_range_from_ordered_chunks(
			ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_lineEnd_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id)
						.gte("lineEnd", startLine),
				)
				.order("asc"),
			{ startLine, maxLines: args.mode.maxLines },
		);
		if (range == null) return null;
		if (!range.hasChunks) {
			const anyChunk = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id),
				)
				.first();
			if (!anyChunk && byteSize > 0) return null;
		}

		return { nodeId: fileNode._id, content: range.content, moreLines: range.moreLines, pendingUpdateId: null };
	},
});

export type files_nodes_read_file_content_from_chunks_Result =
	typeof read_file_content_from_chunks extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Exact line/word/char/byte counts for committed, up-to-date content — read O(1) from the counts
 * stored on the file node at materialization (NO file/chunk content is read). Returns
 * { usable: false } when not committed-current, or for a file materialized before counts were
 * stored (the action then falls back to the windowed estimate). byteCount is the content byte size.
 */
export const read_committed_file_chunk_stats = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({ usable: v.literal(false) }),
		v.object({
			usable: v.literal(true),
			nodeId: v.id("files_nodes"),
			lineCount: v.number(),
			wordCount: v.number(),
			charCount: v.number(),
			byteCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const source = await db_resolve_committed_chunk_source(ctx, args);
		// Counts are persisted on the node at materialization; if absent (older file), fall back.
		if (!source || !source.counts) return { usable: false as const };
		return {
			usable: true as const,
			nodeId: source.nodeId,
			lineCount: source.counts.lineCount,
			wordCount: source.counts.wordCount,
			charCount: source.counts.charCount,
			byteCount: source.byteSize,
		};
	},
});

export type files_nodes_read_committed_file_chunk_stats_Result =
	typeof read_committed_file_chunk_stats extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #region match

// Per-file `grep` scans chunks streaming-style and bounds only the retained output state.
// DEV-PHASE AGGRESSIVE: keep these small while we exercise pagination/truncation behavior.
const files_GREP_MAX_MATCHES = 100;
const files_GREP_MAX_CONTEXT_LINES = 20;
const files_GREP_MAX_OUTPUT_LINES = 200;
const files_GREP_MAX_SCAN_LINES = 200;
const files_GREP_MAX_SCAN_BYTES = 16 * 1024;
const files_GREP_MAX_SLICE_CHARS = 16 * 1024;

type MatchChunksListTruncatedReason =
	| "selected_match_limit_reached"
	| "output_line_limit_reached"
	| "scan_line_limit_reached"
	| "scan_byte_limit_reached"
	| "slice_window_ended";

/**
 * Scan ordered Markdown chunks as one logical file.
 *
 * This owns the hard part that both grep modes share: stitching ordered chunks,
 * preserving source line numbers, adding context, and stopping at the scan caps.
 * Callers choose either fixed-string substring matching or regex matching.
 */
async function match_markdown_chunks_list(
	chunks: AsyncIterable<{
		chunkIndex: number;
		lineStart?: number;
		lineEnd?: number;
		startIndex?: number;
		endIndex?: number;
		markdownChunk?: string;
	}>,
	args: {
		fileNodeId: Id<"files_nodes">;
		pattern: string;
		invert: boolean;
		before: number;
		after: number;
		match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
		window?:
			| { kind: "lines"; startLine: number; maxLines: number }
			| { kind: "slice"; startIndex: number; maxChars: number };
	},
) {
	const linesByNumber = new Map<number, { lineNumber: number; line: string; matched: boolean }>();
	const previousLines: Array<{ lineNumber: number; line: string }> = [];
	const requestedBefore = Math.max(0, args.before);
	const requestedAfter = Math.max(0, args.after);
	const before = Math.min(requestedBefore, files_GREP_MAX_CONTEXT_LINES);
	const after = Math.min(requestedAfter, files_GREP_MAX_CONTEXT_LINES);
	const lineWindow =
		args.window?.kind === "lines"
			? {
					startLine: Math.max(1, Math.trunc(args.window.startLine)),
					maxLines: Math.max(1, Math.min(files_GREP_MAX_SCAN_LINES, Math.trunc(args.window.maxLines))),
				}
			: { startLine: 1, maxLines: files_GREP_MAX_SCAN_LINES };
	const lineWindowEnd = lineWindow.startLine + lineWindow.maxLines - 1;
	const sliceWindow =
		args.window?.kind === "slice"
			? {
					startIndex: Math.max(0, Math.trunc(args.window.startIndex)),
					maxChars: Math.max(1, Math.min(files_GREP_MAX_SLICE_CHARS, Math.trunc(args.window.maxChars))),
				}
			: null;
	const sliceWindowEnd = sliceWindow == null ? null : sliceWindow.startIndex + sliceWindow.maxChars;
	let afterRemaining = 0;
	let afterContextCapPending = false;
	let carry = "";
	let carryStartIndex: number | null = null;
	let lineNumber: number | null = null;
	let prevEnd: number | null = null;
	let previousChunkIndex: number | null = null;
	let selectedCount = 0;
	let selectedStored = 0;
	let scanTruncated = false;
	let outputTruncated = false;
	let stopScanning = false;
	const truncation = {
		reason: null as MatchChunksListTruncatedReason | null,
		nextStartLine: null as number | null,
		nextStartIndex: null as number | null,
	};
	let lastScannedLine: number | null = null;
	let lastScannedIndex: number | null = null;
	let scannedBytes = 0;

	const setTruncated = (reason: MatchChunksListTruncatedReason, nextLine: number | null, nextIndex: number | null) => {
		scanTruncated = true;
		stopScanning = true;
		if (truncation.reason == null) {
			truncation.reason = reason;
			truncation.nextStartLine = nextLine;
			truncation.nextStartIndex = nextIndex;
		}
	};

	const includeLine = (line: { lineNumber: number; line: string }, matched: boolean) => {
		const existing = linesByNumber.get(line.lineNumber);
		if (existing) {
			if (matched) {
				existing.matched = true;
			}
			return true;
		}
		if (linesByNumber.size >= files_GREP_MAX_OUTPUT_LINES) {
			outputTruncated = true;
			setTruncated("output_line_limit_reached", line.lineNumber, null);
			return false;
		}
		linesByNumber.set(line.lineNumber, { ...line, matched });
		return true;
	};

	const rememberPreviousLine = (line: { lineNumber: number; line: string }) => {
		if (before === 0) {
			return;
		}
		previousLines.push(line);
		if (previousLines.length > before) {
			previousLines.shift();
		}
	};

	const processLine = (line: string, lineStartIndex: number | null, lineEndIndex: number | null) => {
		lineNumber = (lineNumber ?? 0) + 1;
		if (lineNumber < lineWindow.startLine) {
			return true;
		}
		if (lineNumber > lineWindowEnd) {
			setTruncated("scan_line_limit_reached", lineNumber, null);
			return false;
		}

		const lineBytes = files_get_utf8_byte_size(line) + 1;
		if (scannedBytes + lineBytes > files_GREP_MAX_SCAN_BYTES) {
			const lineExceedsByteCap = lineBytes > files_GREP_MAX_SCAN_BYTES;
			setTruncated(
				"scan_byte_limit_reached",
				lineExceedsByteCap ? null : lineNumber,
				lineExceedsByteCap ? lineStartIndex : null,
			);
			return false;
		}
		scannedBytes += lineBytes;
		lastScannedLine = lineNumber;
		lastScannedIndex = lineEndIndex;

		const displayLine = { lineNumber, line: files_truncate_long_display_line(line) };
		const isMatch =
			args.pattern.length > 0 &&
			(args.match.kind === "substring"
				? (args.match.ignoreCase ? line.toLowerCase() : line).includes(args.match.needle)
				: args.match.regex.test(line));
		const selected = args.invert ? !isMatch : isMatch;

		if (!selected && afterRemaining === 0 && afterContextCapPending) {
			outputTruncated = true;
			afterContextCapPending = false;
		}

		if (selected) {
			if (selectedStored < files_GREP_MAX_MATCHES) {
				if (!includeLine(displayLine, true)) {
					rememberPreviousLine(displayLine);
					return false;
				}
				selectedCount++;
				selectedStored++;
				if (requestedBefore > before && previousLines.length === before) {
					outputTruncated = true;
				}
				for (const previousLine of previousLines) {
					if (!includeLine(previousLine, false)) {
						rememberPreviousLine(displayLine);
						return false;
					}
				}
				afterRemaining = after;
				afterContextCapPending = requestedAfter > after;
			} else {
				setTruncated("selected_match_limit_reached", lineNumber, null);
				rememberPreviousLine(displayLine);
				return afterRemaining > 0;
			}
		} else if (afterRemaining > 0) {
			if (!includeLine(displayLine, false)) {
				rememberPreviousLine(displayLine);
				return false;
			}
			afterRemaining--;
		}

		rememberPreviousLine(displayLine);
		return true;
	};

	for await (const chunk of chunks) {
		if (previousChunkIndex !== null && chunk.chunkIndex !== previousChunkIndex + 1) {
			return null;
		}
		previousChunkIndex = chunk.chunkIndex;

		let text = chunk.markdownChunk;
		if (text == null) {
			return null;
		}
		if (chunk.startIndex != null && chunk.endIndex != null && prevEnd !== null && chunk.startIndex !== prevEnd) {
			return null;
		}
		prevEnd = chunk.endIndex ?? prevEnd;

		let textStartIndex = chunk.startIndex ?? null;
		let textPrefixForLineNumber = "";
		if (sliceWindow != null) {
			if (chunk.startIndex == null || chunk.endIndex == null) {
				return null;
			}
			if (chunk.endIndex <= sliceWindow.startIndex) {
				continue;
			}
			if (sliceWindowEnd != null && chunk.startIndex >= sliceWindowEnd) {
				setTruncated("slice_window_ended", null, sliceWindow.startIndex + sliceWindow.maxChars);
				break;
			}
			const trimStart = Math.max(0, sliceWindow.startIndex - chunk.startIndex);
			const trimEnd = Math.min(text.length, sliceWindowEnd == null ? text.length : sliceWindowEnd - chunk.startIndex);
			if (trimStart > trimEnd) {
				continue;
			}
			textPrefixForLineNumber = text.slice(0, trimStart);
			text = text.slice(trimStart, trimEnd);
			textStartIndex = chunk.startIndex + trimStart;
			if (chunk.startIndex + trimEnd < chunk.endIndex) {
				setTruncated(
					"slice_window_ended",
					null,
					sliceWindow.startIndex + Math.max(1, sliceWindow.maxChars - args.pattern.length + 1),
				);
			}
		}

		if (lineNumber == null) {
			let skippedLines = 0;
			for (const char of textPrefixForLineNumber) {
				if (char === "\n") {
					skippedLines++;
				}
			}
			lineNumber = chunk.lineStart == null ? 0 : chunk.lineStart - 1 + skippedLines;
		}
		if (carry.length === 0) {
			carryStartIndex = textStartIndex;
		}
		carry += text;

		let newlineIndex = carry.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = carry.slice(0, newlineIndex);
			const lineStartIndex = carryStartIndex;
			const lineEndIndex: number | null = carryStartIndex == null ? null : carryStartIndex + newlineIndex;
			carry = carry.slice(newlineIndex + 1);
			carryStartIndex = lineEndIndex == null ? null : lineEndIndex + 1;
			if (!processLine(line, lineStartIndex, lineEndIndex)) {
				break;
			}
			newlineIndex = carry.indexOf("\n");
		}
		if (stopScanning || (scanTruncated && afterRemaining <= 0)) {
			break;
		}
	}

	if ((!scanTruncated || truncation.reason === "slice_window_ended") && carry.length > 0) {
		const lineStartIndex = carryStartIndex;
		const lineEndIndex = carryStartIndex == null ? null : carryStartIndex + carry.length;
		processLine(carry, lineStartIndex, lineEndIndex);
	}

	const resultTruncatedReason = truncation.reason ?? (outputTruncated ? "output_line_limit_reached" : null);

	return {
		fileNodeId: args.fileNodeId,
		lines: [...linesByNumber.values()].sort((left, right) => left.lineNumber - right.lineNumber),
		selectedCount,
		scanTruncated: scanTruncated || outputTruncated,
		truncatedReason: resultTruncatedReason,
		nextStartLine: truncation.nextStartLine,
		nextStartIndex: truncation.nextStartIndex,
		lastScannedLine,
		lastScannedIndex,
	};
}

/**
 * Scan ordered plain-text chunks as one logical file for regex line matching.
 */
async function match_plain_text_chunks_list(
	chunks: AsyncIterable<{
		chunkIndex: number;
		lineStart?: number;
		plainTextChunk?: string;
	}>,
	args: {
		fileNodeId: Id<"files_nodes">;
		pattern: string;
		ignoreCase: boolean;
		fixedStrings: boolean;
		invert: boolean;
	},
) {
	let match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
	if (args.fixedStrings) {
		// `textgrep -F` treats regex metacharacters as normal text.
		match = {
			kind: "substring",
			needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
			ignoreCase: args.ignoreCase,
		};
	} else {
		try {
			match = { kind: "regex", regex: new RegExp(args.pattern, args.ignoreCase ? "iu" : "u") };
		} catch {
			return null;
		}
	}

	const linesByNumber = new Map<number, { lineNumber: number; line: string; matched: boolean }>();
	let carry = "";
	let lineNumber: number | null = null;
	let previousChunkIndex: number | null = null;
	let selectedCount = 0;
	let selectedStored = 0;
	let scanTruncated = false;
	let outputTruncated = false;
	let stopScanning = false;
	const truncation = {
		reason: null as MatchChunksListTruncatedReason | null,
		nextStartLine: null as number | null,
	};
	let lastScannedLine: number | null = null;
	let scannedBytes = 0;

	const setTruncated = (reason: MatchChunksListTruncatedReason, nextLine: number | null) => {
		scanTruncated = true;
		stopScanning = true;
		if (truncation.reason == null) {
			truncation.reason = reason;
			truncation.nextStartLine = nextLine;
		}
	};

	const includeLine = (line: { lineNumber: number; line: string }) => {
		if (linesByNumber.has(line.lineNumber)) {
			return true;
		}
		if (linesByNumber.size >= files_GREP_MAX_OUTPUT_LINES) {
			outputTruncated = true;
			setTruncated("output_line_limit_reached", line.lineNumber);
			return false;
		}
		linesByNumber.set(line.lineNumber, { ...line, matched: true });
		return true;
	};

	const processLine = (line: string) => {
		lineNumber = (lineNumber ?? 0) + 1;
		if (lineNumber > files_GREP_MAX_SCAN_LINES) {
			setTruncated("scan_line_limit_reached", lineNumber);
			return false;
		}

		const lineBytes = files_get_utf8_byte_size(line) + 1;
		if (scannedBytes + lineBytes > files_GREP_MAX_SCAN_BYTES) {
			setTruncated("scan_byte_limit_reached", lineBytes > files_GREP_MAX_SCAN_BYTES ? null : lineNumber);
			return false;
		}
		scannedBytes += lineBytes;
		lastScannedLine = lineNumber;

		const isMatch =
			args.pattern.length > 0 &&
			(match.kind === "substring"
				? (match.ignoreCase ? line.toLowerCase() : line).includes(match.needle)
				: match.regex.test(line));
		const selected = args.invert ? !isMatch : isMatch;
		if (!selected) {
			return true;
		}

		if (selectedStored >= files_GREP_MAX_MATCHES) {
			setTruncated("selected_match_limit_reached", lineNumber);
			return false;
		}

		if (!includeLine({ lineNumber, line: files_truncate_long_display_line(line) })) {
			return false;
		}
		selectedCount++;
		selectedStored++;
		return true;
	};

	for await (const chunk of chunks) {
		if (previousChunkIndex !== null && chunk.chunkIndex !== previousChunkIndex + 1) {
			return null;
		}
		previousChunkIndex = chunk.chunkIndex;

		const text = chunk.plainTextChunk;
		if (text == null) {
			return null;
		}
		if (lineNumber == null) {
			lineNumber = chunk.lineStart == null ? 0 : chunk.lineStart - 1;
		}
		carry += text;

		let newlineIndex = carry.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = carry.slice(0, newlineIndex);
			carry = carry.slice(newlineIndex + 1);
			if (!processLine(line)) {
				break;
			}
			newlineIndex = carry.indexOf("\n");
		}
		if (stopScanning) {
			break;
		}
	}

	if (!scanTruncated && carry.length > 0) {
		processLine(carry);
	}

	const resultTruncatedReason = truncation.reason ?? (outputTruncated ? "output_line_limit_reached" : null);
	return {
		fileNodeId: args.fileNodeId,
		lines: [...linesByNumber.values()].sort((left, right) => left.lineNumber - right.lineNumber),
		selectedCount,
		scanTruncated: scanTruncated || outputTruncated,
		truncatedReason: resultTruncatedReason,
		nextStartLine: truncation.nextStartLine,
		nextStartIndex: null,
		lastScannedLine,
		lastScannedIndex: null,
	};
}

async function* db_plain_text_chunks_with_lines(chunks: AsyncIterable<Doc<"files_plain_text_chunks">>) {
	for await (const chunk of chunks) {
		yield {
			chunkIndex: chunk.chunkIndex,
			lineStart: chunk.lineStart,
			plainTextChunk: chunk.plainTextChunk,
		};
	}
}

/**
 * Match lines in Markdown chunks for the Bash `grep` command's single-file path.
 *
 * Normal grep uses regex matching over the Markdown representation. `grep -F`
 * uses fixed-string matching through the same chunk scan.
 */
export const match_markdown_file_lines = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		pattern: v.string(),
		ignoreCase: v.boolean(),
		fixedStrings: v.boolean(),
		invert: v.boolean(),
		before: v.number(),
		after: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		window: v.optional(
			v.union(
				v.object({
					kind: v.literal("lines"),
					startLine: v.number(),
					maxLines: v.number(),
				}),
				v.object({
					kind: v.literal("slice"),
					startIndex: v.number(),
					maxChars: v.number(),
				}),
			),
		),
	},
	returns: v.union(
		v.null(),
		v.object({
			fileNodeId: v.id("files_nodes"),
			lines: v.array(
				v.object({
					lineNumber: v.number(),
					line: v.string(),
					matched: v.boolean(),
				}),
			),
			selectedCount: v.number(),
			scanTruncated: v.boolean(),
			truncatedReason: v.union(
				v.literal("selected_match_limit_reached"),
				v.literal("output_line_limit_reached"),
				v.literal("scan_line_limit_reached"),
				v.literal("scan_byte_limit_reached"),
				v.literal("slice_window_ended"),
				v.null(),
			),
			nextStartLine: v.union(v.number(), v.null()),
			nextStartIndex: v.union(v.number(), v.null()),
			lastScannedLine: v.union(v.number(), v.null()),
			lastScannedIndex: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			fileNode == null ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.archiveOperationId !== undefined
		) {
			return null;
		}
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId) &&
			!files_node_has_editable_yjs_state(fileNode)
		)
			return null;

		let pendingUpdateId: Id<"files_pending_updates"> | null = null;
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			// Bind the guard-narrowed ids; TS drops property narrowing inside the closures below.
			const organizationId = args.organizationId;
			const workspaceId = args.workspaceId;
			let pendingUpdate: Doc<"files_pending_updates"> | null = null;
			if (args.pendingUpdateId != null) {
				pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
				if (
					!pendingUpdate ||
					pendingUpdate.organizationId !== organizationId ||
					pendingUpdate.workspaceId !== workspaceId ||
					pendingUpdate.userId !== args.userId ||
					pendingUpdate.fileNodeId !== fileNode._id
				) {
					return null;
				}
			} else {
				pendingUpdate = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("userId", args.userId)
							.eq("fileNodeId", fileNode._id),
					)
					.first();
			}
			// Move-only docs have no pending chunks; leave the id null so the scan falls
			// through to the committed chunks instead of a silent no-match.
			if (pendingUpdate != null && files_pending_update_content_of(pendingUpdate) != null) {
				pendingUpdateId = pendingUpdate._id;
			}
		} else if (args.pendingUpdateId != null) {
			// External (reserved) nodes never have pending docs; an explicit pending view cannot resolve.
			return null;
		}

		let match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
		if (args.fixedStrings) {
			// `grep -F` treats regex metacharacters as normal text.
			match = {
				kind: "substring",
				needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
				ignoreCase: args.ignoreCase,
			};
		} else {
			try {
				match = { kind: "regex", regex: new RegExp(args.pattern, args.ignoreCase ? "iu" : "u") };
			} catch {
				return null;
			}
		}

		const window = args.window;
		if (pendingUpdateId != null) {
			const chunks =
				window?.kind === "lines"
					? ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_pendingUpdate_lineEnd_chunkIndex", (q) =>
								q.eq("pendingUpdateId", pendingUpdateId).gte("lineEnd", Math.max(1, Math.trunc(window.startLine))),
							)
					: window?.kind === "slice"
						? ctx.db
								.query("files_markdown_chunks")
								.withIndex("by_pendingUpdate_endIndex_chunkIndex", (q) =>
									q
										.eq("pendingUpdateId", pendingUpdateId)
										.gte("endIndex", Math.max(0, Math.trunc(window.startIndex)) + 1),
								)
						: ctx.db
								.query("files_markdown_chunks")
								.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdateId));

			return await match_markdown_chunks_list(chunks, {
				fileNodeId: fileNode._id,
				pattern: args.pattern,
				invert: args.invert,
				before: args.before,
				after: args.after,
				match,
				window,
			});
		}

		// Tenant committed chunks are valid only when the latest Yjs sequence is materialized; external
		// (reserved) nodes have no Yjs/materialization state and read committed chunks by node id.
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
		}

		const chunks =
			window?.kind === "lines"
				? ctx.db
						.query("files_markdown_chunks")
						.withIndex("by_organization_workspace_source_fileNode_lineEnd_chunk", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", fileNode._id)
								.gte("lineEnd", Math.max(1, Math.trunc(window.startLine))),
						)
				: window?.kind === "slice"
					? ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_organization_workspace_source_fileNode_endIndex_chunk", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("sourceKind", "committed")
									.eq("fileNodeId", fileNode._id)
									.gte("endIndex", Math.max(0, Math.trunc(window.startIndex)) + 1),
							)
					: ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("sourceKind", "committed")
									.eq("fileNodeId", fileNode._id),
							);

		return await match_markdown_chunks_list(chunks, {
			fileNodeId: fileNode._id,
			pattern: args.pattern,
			invert: args.invert,
			before: args.before,
			after: args.after,
			match,
			window,
		});
	},
});

export type files_nodes_match_markdown_file_lines_Result =
	typeof match_markdown_file_lines extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Match lines in plain-text chunks for the Bash `textgrep` command's single-file path.
 * This uses regex matching over rendered plain text.
 */
export const match_plain_text_file_lines = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		pattern: v.string(),
		ignoreCase: v.boolean(),
		fixedStrings: v.boolean(),
		invert: v.boolean(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.null(),
		v.object({
			fileNodeId: v.id("files_nodes"),
			lines: v.array(
				v.object({
					lineNumber: v.number(),
					line: v.string(),
					matched: v.boolean(),
				}),
			),
			selectedCount: v.number(),
			scanTruncated: v.boolean(),
			truncatedReason: v.union(
				v.literal("selected_match_limit_reached"),
				v.literal("output_line_limit_reached"),
				v.literal("scan_line_limit_reached"),
				v.literal("scan_byte_limit_reached"),
				v.literal("slice_window_ended"),
				v.null(),
			),
			nextStartLine: v.union(v.number(), v.null()),
			nextStartIndex: v.union(v.number(), v.null()),
			lastScannedLine: v.union(v.number(), v.null()),
			lastScannedIndex: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			fileNode == null ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.archiveOperationId !== undefined
		) {
			return null;
		}
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId) &&
			!files_node_has_editable_yjs_state(fileNode)
		)
			return null;

		let pendingUpdateId: Id<"files_pending_updates"> | null = null;
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			// Bind the guard-narrowed ids; TS drops property narrowing inside the closures below.
			const organizationId = args.organizationId;
			const workspaceId = args.workspaceId;
			let pendingUpdate: Doc<"files_pending_updates"> | null = null;
			if (args.pendingUpdateId != null) {
				pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
				if (
					!pendingUpdate ||
					pendingUpdate.organizationId !== organizationId ||
					pendingUpdate.workspaceId !== workspaceId ||
					pendingUpdate.userId !== args.userId ||
					pendingUpdate.fileNodeId !== fileNode._id
				) {
					return null;
				}
			} else {
				pendingUpdate = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("userId", args.userId)
							.eq("fileNodeId", fileNode._id),
					)
					.first();
			}
			// Move-only docs have no pending chunks; leave the id null so the scan falls
			// through to the committed chunks instead of a silent no-match.
			if (pendingUpdate != null && files_pending_update_content_of(pendingUpdate) != null) {
				pendingUpdateId = pendingUpdate._id;
			}
		} else if (args.pendingUpdateId != null) {
			// External (reserved) nodes never have pending docs; an explicit pending view cannot resolve.
			return null;
		}

		if (pendingUpdateId != null) {
			const chunks = ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pendingUpdateId));

			return await match_plain_text_chunks_list(db_plain_text_chunks_with_lines(chunks), {
				fileNodeId: fileNode._id,
				pattern: args.pattern,
				ignoreCase: args.ignoreCase,
				fixedStrings: args.fixedStrings,
				invert: args.invert,
			});
		}

		// Tenant committed chunks are valid only when the latest Yjs sequence is materialized; external
		// (reserved) nodes have no Yjs/materialization state and read committed chunks by node id.
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
		}

		const chunks = ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", fileNode._id),
			);

		return await match_plain_text_chunks_list(db_plain_text_chunks_with_lines(chunks), {
			fileNodeId: fileNode._id,
			pattern: args.pattern,
			ignoreCase: args.ignoreCase,
			fixedStrings: args.fixedStrings,
			invert: args.invert,
		});
	},
});

export type files_nodes_match_plain_text_file_lines_Result =
	typeof match_plain_text_file_lines extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion match

// #endregion read file

export const get_file_last_yjs_sequence = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.id("files_nodes") },
	returns: v.union(v.object({ lastSequence: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!files_node_has_editable_yjs_state(fileNode) ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const lastYjsSequenceDoc = await ctx.db
			.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId)
			.then((doc) => {
				if (!doc || doc.organizationId !== fileNode.organizationId || doc.workspaceId !== fileNode.workspaceId)
					return null;
				return doc;
			});

		if (!lastYjsSequenceDoc) {
			const errorMessage =
				"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
			const errorData = {
				organizationId: fileNode.organizationId,
				workspaceId: fileNode.workspaceId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return { lastSequence: lastYjsSequenceDoc.lastSequence };
	},
});

function db_text_search_filtered_query(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_plain_text_chunks">["organizationId"];
		workspaceId: Doc<"files_plain_text_chunks">["workspaceId"];
		userId: Id<"users">;
		query: string;
		pathPrefix?: string;
		pendingNodeIds: Array<Id<"files_nodes">>;
	},
) {
	const rawPrefix = args.pathPrefix?.trim();
	const scopePrefix = rawPrefix && rawPrefix !== "/" ? `/${rawPrefix.replace(/^\/+|\/+$/gu, "")}` : null;
	const scopedLowerBound = scopePrefix === null ? "/" : `${scopePrefix}/`;
	const scopedUpperBound = `${scopedLowerBound}\uffff`;

	let searchQuery = ctx.db
		.query("files_plain_text_chunks")
		.withSearchIndex("search_by_plainTextChunk", (q) =>
			q
				.search("plainTextChunk", args.query)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("archiveOperationId", undefined),
		);
	// Convex applies `.filter` before returned page contents, so each rendered page is already
	// scoped and does not need a JavaScript re-filter or separate page probe. The tradeoff is that
	// `.filter` scans search hits after `withSearchIndex`; equality filters in the search index are
	// still more efficient where available. Do not rely on `maximumRowsRead` here: Convex currently
	// does not enforce it for search queries.
	if (scopePrefix !== null) {
		searchQuery = searchQuery.filter((q) =>
			q.and(q.gte(q.field("path"), scopedLowerBound), q.lt(q.field("path"), scopedUpperBound)),
		);
	}
	searchQuery = searchQuery.filter((q) =>
		q.or(
			q.eq(q.field("sourceKind"), "committed"),
			q.and(q.eq(q.field("sourceKind"), "pending"), q.eq(q.field("userId"), args.userId)),
		),
	);
	for (const pendingNodeId of args.pendingNodeIds) {
		searchQuery = searchQuery.filter((q) =>
			q.or(q.neq(q.field("fileNodeId"), pendingNodeId), q.eq(q.field("sourceKind"), "pending")),
		);
	}
	return searchQuery;
}

const text_search_args = {
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	userId: v.id("users"),
	query: v.string(),
	/** Optional subtree scope: keep only matches whose file path is under this folder prefix. */
	pathPrefix: v.optional(v.string()),
};

export const text_search_files = internalQuery({
	args: {
		...text_search_args,
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				markdownChunk: v.string(),
				chunkIndex: v.number(),
				startIndex: v.number(),
				endIndex: v.number(),
				lineStart: v.number(),
				lineEnd: v.number(),
				chunkFlags: v.number(),
				hasChunkAbove: v.boolean(),
				hasChunkBelow: v.boolean(),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (
		ctx,
		args,
	): Promise<{
		items: Array<{
			path: string;
			markdownChunk: string;
			chunkIndex: number;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			chunkFlags: number;
			hasChunkAbove: boolean;
			hasChunkBelow: boolean;
		}>;
		continueCursor: string;
		isDone: boolean;
	}> => {
		const pageLimit = args.numItems;
		// Reserved (external) scope has no per-user pending overlay; tenant scope suppresses committed
		// chunks for files the acting user is currently editing.
		let pendingNodeIds: Array<Id<"files_nodes">> = [];
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			// Bind the guard-narrowed ids; TS drops property narrowing inside the closure below.
			const organizationId = args.organizationId;
			const workspaceId = args.workspaceId;
			const pendingUpdates = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("userId", args.userId),
				)
				.order("asc")
				.collect();
			// Only docs with a content proposal have pending chunks to search instead.
			// Move-only docs must keep their committed chunks searchable.
			pendingNodeIds = pendingUpdates
				.filter((pendingUpdate) => files_pending_update_content_of(pendingUpdate) != null)
				.map((pendingUpdate) => pendingUpdate.fileNodeId);
		}

		const result = await db_text_search_filtered_query(ctx, {
			...args,
			pendingNodeIds,
		}).paginate({
			cursor: args.cursor,
			numItems: pageLimit,
		});

		// A chunk carries the text of its file, so a hit inside a restricted file would print the very
		// thing the restriction protects. Each distinct file on the page is looked up once, and the
		// filter answers once per restricted scope, so a page of chunks from one file costs one check.
		const pageNodeIds = [...new Set(result.page.map((searchChunk) => searchChunk.fileNodeId))];
		const pageNodes = (await Promise.all(pageNodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
			(fileNode) => fileNode !== null,
		);
		const readableNodeIds = new Set(
			(
				await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodes: pageNodes,
				})
			).map((fileNode) => fileNode._id),
		);

		const items = result.page
			.filter((searchChunk) => readableNodeIds.has(searchChunk.fileNodeId))
			.map((searchChunk) => ({
				path: searchChunk.path,
				markdownChunk: searchChunk.markdownChunk,
				chunkIndex: searchChunk.chunkIndex,
				startIndex: searchChunk.startIndex,
				endIndex: searchChunk.endIndex,
				lineStart: searchChunk.lineStart,
				lineEnd: searchChunk.lineEnd,
				chunkFlags: searchChunk.chunkFlags,
				hasChunkAbove: searchChunk.hasChunkAbove,
				hasChunkBelow: searchChunk.hasChunkBelow,
			}));

		return {
			items,
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_text_search_files_Result =
	typeof text_search_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const profile_text_search_files = internalAction({
	args: {
		...text_search_args,
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		durationMs: v.number(),
		itemCount: v.number(),
		continueCursor: v.string(),
		isDone: v.boolean(),
		firstPaths: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		const startedAt = Date.now();
		const result: files_nodes_text_search_files_Result = await ctx.runQuery(
			internal.files_nodes.text_search_files,
			args,
		);
		return {
			durationMs: Date.now() - startedAt,
			itemCount: result.items.length,
			continueCursor: result.continueCursor,
			isDone: result.isDone,
			firstPaths: result.items.slice(0, 5).map((item) => item.path),
		};
	},
});

export const get_file_snapshots_list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		showArchived: v.boolean(),
	},
	returns: v.object({
		snapshots: v.array(doc(app_convex_schema, "files_snapshots")),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return {
				snapshots: [],
			};
		}

		// Against the node, not the workspace: a file's version list says when it changed and how
		// often, and a restricted file must not answer that to everybody in the workspace.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return {
				snapshots: [],
			};
		}

		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) => {
				const qBase = q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("fileNodeId", args.nodeId);

				const qFinal = args.showArchived ? qBase.gt("archivedAt", 0) : qBase.lte("archivedAt", 0);

				return qFinal;
			})
			.order("desc")
			.collect();

		return {
			snapshots,
		};
	},
});

export const get_file_snapshot = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(doc(app_convex_schema, "files_snapshots"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (!snapshot) {
			return null;
		}

		if (
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId ||
			snapshot.fileNodeId !== args.nodeId
		) {
			return null;
		}

		return snapshot;
	},
});

export async function db_get_file_snapshot_content(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
	},
) {
	const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
	if (
		!snapshot ||
		snapshot.organizationId !== args.organizationId ||
		snapshot.workspaceId !== args.workspaceId ||
		snapshot.fileNodeId !== args.nodeId
	) {
		return null;
	}

	const asset = await ctx.db
		.get("files_r2_assets", snapshot.assetId)
		.then((asset) =>
			asset && asset.organizationId === args.organizationId && asset.workspaceId === args.workspaceId ? asset : null,
		);
	if (!asset) {
		return null;
	}

	return {
		asset,
		snapshotId: snapshot._id,
		_creationTime: snapshot._creationTime,
	};
}

export const get_data_for_create_file_snapshot_content_url = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			asset: doc(app_convex_schema, "files_r2_assets"),
			snapshotId: v.id("files_snapshots"),
			_creationTime: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		return await db_get_file_snapshot_content(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		});
	},
});

type get_data_for_create_file_snapshot_content_url_Result =
	typeof get_data_for_create_file_snapshot_content_url extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const create_file_snapshot_content_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			url: v.string(),
			snapshotId: v.id("files_snapshots"),
			_creationTime: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_create_file_snapshot_content_url, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		})) as get_data_for_create_file_snapshot_content_url_Result;
		if (!data) {
			return null;
		}
		if (!data.asset.r2Key) {
			const errorMessage = "snapshot.assetId points to an asset without r2Key";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				assetId: data.asset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			url: await r2_get_download_url({
				key: data.asset.r2Key,
				options: {
					expiresIn: 15 * 60,
				},
			}),
			snapshotId: data.snapshotId,
			_creationTime: data._creationTime,
		};
	},
});

export const archive_snapshot = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		// The snapshot comes first here, because the permission belongs to the file it is a version of.
		// This mutation takes only a snapshot id, so there is no node to check until it is loaded.
		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
			return Result({ _yay: null });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: snapshot.fileNodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const unarchive_snapshot = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		// Same order as `archive_snapshot`: the snapshot names the file, and the file carries the
		// permission.
		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
			return Result({ _yay: null });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: snapshot.fileNodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: 0,
		});
		return Result({ _yay: null });
	},
});

export const get_data_for_yjs_prepare_doc_last_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		return await db_get_file_content_materialization_db_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
	},
});

type get_data_for_yjs_prepare_doc_last_snapshot_Result =
	typeof get_data_for_yjs_prepare_doc_last_snapshot extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const yjs_prepare_doc_last_snapshot = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			snapshot: doc(app_convex_schema, "files_yjs_snapshots"),
			snapshotUrl: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_yjs_prepare_doc_last_snapshot, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		})) as get_data_for_yjs_prepare_doc_last_snapshot_Result;
		if (!data) {
			return null;
		}

		if (!data.yjsSnapshotAsset.r2Key) {
			const errorMessage = "yjsSnapshotAsset.r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				assetId: data.yjsSnapshotAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			snapshot: data.yjsSnapshotDoc,
			snapshotUrl: await r2_get_download_url({
				key: data.yjsSnapshotAsset.r2Key,
				options: {
					expiresIn: 15 * 60,
				},
			}),
		};
	},
});

export async function yjs_increment_or_create_last_sequence(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	let lastSequenceData = await ctx.db
		.query("files_yjs_docs_last_sequences")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.order("desc")
		.first();

	const newSequence = lastSequenceData ? lastSequenceData.lastSequence + 1 : 0;

	// Update or create lastSequence tracking
	if (lastSequenceData) {
		await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceData._id, { lastSequence: newSequence });
		lastSequenceData.lastSequence = newSequence;
	} else {
		const lastSequenceDataId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			lastSequence: 0,
		});
		lastSequenceData = (await ctx.db.get("files_yjs_docs_last_sequences", lastSequenceDataId))!;
	}

	return lastSequenceData;
}

export async function files_db_yjs_push_update(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		update: ArrayBuffer;
		sessionId: string;
		userId: Id<"users">;
		/**
		 * True for one-shot commits (save/accept) so committed chunks refresh right away
		 * and readers do not see stale content. False for live editor keystreams:
		 * materialization keeps the 30s debounce (each push reschedules the job).
		 */
		materializeImmediately: boolean;
	},
) {
	const now = Date.now();

	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
	});

	await ctx.db.insert("files_yjs_updates", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sequence: newSequenceData.lastSequence,
		update: args.update,
		origin: {
			type: "USER_EDIT",
			sessionId: args.sessionId,
		},
		createdBy: args.userId,
		createdAt: now,
	});

	const snapshotScheduleDelayMs = args.materializeImmediately
		? 0
		: newSequenceData.lastSequence > 0 && newSequenceData.lastSequence % 50 === 0
			? 0
			: 30_000;

	await enqueue_file_content_materialization(ctx, {
		userId: args.userId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: snapshotScheduleDelayMs,
	});

	return Result({ _yay: { newSequence: newSequenceData.lastSequence } });
}

export const yjs_push_update = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		update: v.bytes(),
		sessionId: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_yjs_push_update", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const user = await ctx.db.get("users", userAuth.id);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (!fileNode) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (fileNode.organizationId !== membership.organizationId || fileNode.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (!files_node_has_editable_yjs_state(fileNode)) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode,
		});
		if (authorized._nay) {
			return authorized;
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: user._id,
			organization,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = {
				userId: user._id,
				organizationId: organization._id,
				billedUserId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const check = await billing_db_check_credits(ctx, {
			userId: billedUser._id,
			minimumRequiredCents: 1,
		});
		if (!check.hasCredits) {
			return Result({
				_nay: {
					message: "Insufficient funds",
				},
			});
		}

		const pushResult = await files_db_yjs_push_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			update: args.update,
			sessionId: args.sessionId,
			userId: user._id,
			// Live editor keystream: keep the materialization debounce.
			materializeImmediately: false,
		});
		if (pushResult._nay) {
			return pushResult;
		}

		await billing_ingest_events(ctx, {
			billedUserEvents: [
				{
					billedUser,
					event: billing_event({
						name: "file_save",
						externalCustomerId: billedUser._id,
						externalMemberId: user._id,
						externalId: composite_id(
							"billing",
							"file_save",
							billedUser._id,
							user._id,
							membership.organizationId,
							membership.workspaceId,
							args.nodeId,
							pushResult._yay.newSequence,
						),
						metadata: {
							amount: 1,
							actorUserId: user._id,
							billedUserId: billedUser._id,
							organizationId: fileNode.organizationId,
							workspaceId: fileNode.workspaceId,
							nodeId: args.nodeId,
							yjsSequence: String(pushResult._yay.newSequence),
						},
					}),
				},
			],
		});

		return pushResult;
	},
});

export const yjs_get_incremental_updates = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			updates: v.array(doc(app_convex_schema, "files_yjs_updates")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.kind !== "file"
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("fileNodeId", args.nodeId),
			)
			.order("desc")
			.collect();

		if (updates.length === 0) {
			return null;
		}

		return { updates };
	},
});

// #region snapshots

/**
 * Internal mutation to cleanup old snapshots based on retention rules.
 * Runs daily at 5AM UTC via cron job.
 *
 * Retention rules:
 * - Older than 30 days: keep only the last snapshot for each week
 * - Older than 7 days (but <= 30 days): keep only the last snapshot for each day
 * - Older than 1 day (but <= 7 days): keep only the last snapshot each hour
 * - <= 1 day old: keep all snapshots
 */
export const cleanup_old_snapshots = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const timestamp60DaysAgo = now - 60 * date_MS_DAY;

		const latestSnapshotNodeIdWithTimeSlot = new Set<string>();
		const snapshotsToDelete: Array<{
			snapshotId: Id<"files_snapshots">;
			assetId: Id<"files_r2_assets">;
			r2Key: string;
		}> = [];

		for await (const snapshot of ctx.db.query("files_snapshots").order("desc")) {
			if (snapshot._creationTime < timestamp60DaysAgo) {
				break;
			}

			const age = now - snapshot._creationTime;
			let keepSnapshot = false;

			// If the snapshot is less than 1 day old, keep it
			if (age <= date_MS_DAY) {
				keepSnapshot = true;
			} else {
				// If the snapshot is older than 1 day, we need to determine the time slot it belongs to
				let bucketTimestamp: number;

				if (age > date_MS_DAYS_30) {
					bucketTimestamp = date_get_week_start_timestamp(snapshot._creationTime);
				} else if (age > date_MS_WEEK) {
					bucketTimestamp = date_get_day_start_timestamp(snapshot._creationTime);
				} else {
					bucketTimestamp = date_get_hour_start_timestamp(snapshot._creationTime);
				}

				// If this is the first snapshot for this time slot, it means it's the latest
				// therefore we keep it
				const snapshotTimeSlotKey = `${snapshot.fileNodeId}::${bucketTimestamp}`;
				if (!latestSnapshotNodeIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotNodeIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (keepSnapshot) {
				continue;
			}

			// Never delete the snapshot the node points at: it holds the file's current bytes and
			// must stay downloadable. The newest-first rule alone is not safe here: a restore
			// writes two snapshots in one transaction, so they share the same creation time.
			const node = await ctx.db.get("files_nodes", snapshot.fileNodeId);
			if (node?.assetId === snapshot.assetId) {
				continue;
			}

			const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
			if (
				!asset ||
				asset.organizationId !== snapshot.organizationId ||
				asset.workspaceId !== snapshot.workspaceId ||
				asset.kind !== "content_snapshot"
			) {
				const errorMessage = "snapshot.assetId points to a missing or mismatched files_r2_assets doc";
				const errorData = {
					snapshotId: snapshot._id,
					assetId: snapshot.assetId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			if (!asset.r2Key) {
				const errorMessage = "snapshotAsset.r2Key is not set";
				const errorData = {
					snapshotId: snapshot._id,
					assetId: asset._id,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			snapshotsToDelete.push({
				snapshotId: snapshot._id,
				assetId: asset._id,
				r2Key: asset.r2Key,
			});
		}

		await Promise.all(snapshotsToDelete.map((snapshot) => r2_delete_object(ctx, snapshot.r2Key)));
		await Promise.all(snapshotsToDelete.map((snapshot) => ctx.db.delete("files_snapshots", snapshot.snapshotId)));
		await Promise.all(snapshotsToDelete.map((snapshot) => ctx.db.delete("files_r2_assets", snapshot.assetId)));

		return null;
	},
});

// #endregion snapshots

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const grepTestFileNodeId = "grep-test-file-node" as Id<"files_nodes">;
	const matchMarkdownTestScannerOptions = {
		fileNodeId: grepTestFileNodeId,
		invert: false,
		before: 0,
		after: 0,
	};

	function grepTestLineNumberAt(content: string, offset: number) {
		return content.slice(0, offset).split("\n").length;
	}

	function grepTestChunks(content: string, splitIndexes: number[] = []) {
		const chunks: Array<{
			chunkIndex: number;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			markdownChunk: string;
		}> = [];
		let startIndex = 0;
		for (const [chunkIndex, endIndex] of [...splitIndexes, content.length].entries()) {
			chunks.push({
				chunkIndex,
				startIndex,
				endIndex,
				lineStart: grepTestLineNumberAt(content, startIndex),
				lineEnd: grepTestLineNumberAt(content, endIndex),
				markdownChunk: content.slice(startIndex, endIndex),
			});
			startIndex = endIndex;
		}
		return chunks;
	}

	async function* grepTestChunkIterator(
		chunks: Array<{
			chunkIndex: number;
			startIndex?: number;
			endIndex?: number;
			lineStart?: number;
			lineEnd?: number;
			markdownChunk?: string;
			plainTextChunk?: string;
		}>,
	) {
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	async function* lineRangeTestChunkIterator(
		chunks: Array<{
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			markdownChunk: string;
		}>,
	) {
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	async function grepTestScan(
		content: string,
		args: {
			pattern: string;
			ignoreCase?: boolean;
			invert?: boolean;
			before?: number;
			after?: number;
			splitIndexes?: number[];
		},
	) {
		return await match_markdown_chunks_list(grepTestChunkIterator(grepTestChunks(content, args.splitIndexes)), {
			...matchMarkdownTestScannerOptions,
			pattern: args.pattern,
			invert: args.invert ?? false,
			before: args.before ?? 0,
			after: args.after ?? 0,
			match: {
				kind: "substring",
				needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
				ignoreCase: args.ignoreCase ?? false,
			},
		});
	}

	describe("chunk line range reads", () => {
		test("line range reads the first page and reports more lines", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 5, lineStart: 1, lineEnd: 2, markdownChunk: "one\nt" },
					{ startIndex: 5, endIndex: 14, lineStart: 2, lineEnd: 3, markdownChunk: "wo\nthree\n" },
					{ startIndex: 14, endIndex: 19, lineStart: 4, lineEnd: 4, markdownChunk: "four\n" },
				]),
				{ startLine: 1, maxLines: 2 },
			);

			expect(result).toEqual({ hasChunks: true, content: "one\ntwo\n", moreLines: true });
		});

		test("line range reads an offset page across chunk boundaries", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 5, lineStart: 1, lineEnd: 2, markdownChunk: "one\nt" },
					{ startIndex: 5, endIndex: 14, lineStart: 2, lineEnd: 3, markdownChunk: "wo\nthree\n" },
					{ startIndex: 14, endIndex: 19, lineStart: 4, lineEnd: 4, markdownChunk: "four\n" },
				]),
				{ startLine: 2, maxLines: 2 },
			);

			expect(result).toEqual({ hasChunks: true, content: "two\nthree\n", moreLines: true });
		});

		test("line range returns null for non-contiguous chunks", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 4, lineStart: 1, lineEnd: 1, markdownChunk: "one\n" },
					{ startIndex: 6, endIndex: 10, lineStart: 2, lineEnd: 2, markdownChunk: "two\n" },
				]),
				{ startLine: 1, maxLines: 2 },
			);

			expect(result).toBeNull();
		});
	});

	describe("match_markdown_chunks_list", () => {
		test("finds literal substring matches without context", async () => {
			const content = "alpha\nneedle one\nbeta\nneedle two\n";
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "needle one", matched: true },
				{ lineNumber: 4, line: "needle two", matched: true },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("matches case-insensitively", async () => {
			const content = "alpha\nNeedle one\nbeta\nNEEDLE two\n";
			const result = await grepTestScan(content, { pattern: "needle", ignoreCase: true });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "Needle one", matched: true },
				{ lineNumber: 4, line: "NEEDLE two", matched: true },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("reassembles lines across chunk boundaries", async () => {
			const content = "first\nboundary-needle-line\nlast";
			const result = await grepTestScan(content, {
				pattern: "needle",
				splitIndexes: [content.indexOf("needle") + 2],
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "boundary-needle-line", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns no lines for an empty pattern", async () => {
			const result = await grepTestScan("alpha\nbeta\n", { pattern: "" });

			expect(result).toEqual({
				fileNodeId: grepTestFileNodeId,
				lines: [],
				selectedCount: 0,
				scanTruncated: false,
				truncatedReason: null,
				nextStartLine: null,
				nextStartIndex: null,
				lastScannedLine: 2,
				lastScannedIndex: 10,
			});
		});

		test("returns null for non-contiguous chunks", async () => {
			const result = await match_markdown_chunks_list(
				grepTestChunkIterator([
					{ chunkIndex: 0, startIndex: 0, endIndex: 5, markdownChunk: "hello" },
					{ chunkIndex: 1, startIndex: 6, endIndex: 11, markdownChunk: "world" },
				]),
				{
					...matchMarkdownTestScannerOptions,
					pattern: "world",
					match: { kind: "substring", needle: "world", ignoreCase: false },
				},
			);

			expect(result).toBeNull();
		});

		test("matches regex over Markdown chunks", async () => {
			const content = "intro\ncritical   alert\noutro\n";
			const result = await match_markdown_chunks_list(grepTestChunkIterator(grepTestChunks(content)), {
				...matchMarkdownTestScannerOptions,
				pattern: String.raw`critical\s+alert`,
				match: { kind: "regex", regex: /critical\s+alert/u },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "critical   alert", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("matches regex over plain-text chunks", async () => {
			const result = await match_plain_text_chunks_list(
				grepTestChunkIterator([{ chunkIndex: 0, plainTextChunk: "intro\ncritical alert\noutro\n" }]),
				{
					fileNodeId: grepTestFileNodeId,
					pattern: String.raw`critical\s+alert`,
					ignoreCase: false,
					fixedStrings: false,
					invert: false,
				},
			);

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns before and after context", async () => {
			const content = "one\ntwo\nneedle one\nfour\nfive\nneedle two\nseven\n";
			const result = await grepTestScan(content, { pattern: "needle", before: 1, after: 1 });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "two", matched: false },
				{ lineNumber: 3, line: "needle one", matched: true },
				{ lineNumber: 4, line: "four", matched: false },
				{ lineNumber: 5, line: "five", matched: false },
				{ lineNumber: 6, line: "needle two", matched: true },
				{ lineNumber: 7, line: "seven", matched: false },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns inverted selections", async () => {
			const content = "keep one\nneedle one\nkeep two\nneedle two\nkeep three\n";
			const result = await grepTestScan(content, { pattern: "needle", invert: true });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 1, line: "keep one", matched: true },
				{ lineNumber: 3, line: "keep two", matched: true },
				{ lineNumber: 5, line: "keep three", matched: true },
			]);
			expect(result.selectedCount).toBe(3);
			expect(result.scanTruncated).toBe(false);
		});

		test("reports the bounded selected count when the selected cap is hit", async () => {
			const content = Array.from({ length: files_GREP_MAX_MATCHES + 5 }, (_, index) => `needle ${index + 1}`).join(
				"\n",
			);
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toHaveLength(files_GREP_MAX_MATCHES);
			expect(result.selectedCount).toBe(files_GREP_MAX_MATCHES);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("selected_match_limit_reached");
			expect(result.nextStartLine).toBe(files_GREP_MAX_MATCHES + 1);
		});

		test("starts from a non-zero line window source origin", async () => {
			const content = "one\ntwo\nthree\nneedle four\nneedle five\n";
			const chunks = grepTestChunks(content, [14]).filter((chunk) => chunk.lineEnd >= 4);
			const result = await match_markdown_chunks_list(grepTestChunkIterator(chunks), {
				...matchMarkdownTestScannerOptions,
				pattern: "needle",
				match: { kind: "substring", needle: "needle", ignoreCase: false },
				window: { kind: "lines", startLine: 4, maxLines: 1 },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 4, line: "needle four", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_line_limit_reached");
			expect(result.nextStartLine).toBe(5);
		});

		test("stops at the line scan cap and returns a continuation line", async () => {
			const content = Array.from({ length: files_GREP_MAX_SCAN_LINES + 5 }, (_, index) =>
				index === files_GREP_MAX_SCAN_LINES + 2 ? "late needle" : `line ${index + 1}`,
			).join("\n");
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.selectedCount).toBe(0);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_line_limit_reached");
			expect(result.nextStartLine).toBe(files_GREP_MAX_SCAN_LINES + 1);
		});

		test("stops before an oversized line and returns a slice continuation index", async () => {
			const content = `${"x".repeat(files_GREP_MAX_SCAN_BYTES + 10)}needle\n`;
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_byte_limit_reached");
			expect(result.nextStartIndex).toBe(0);
		});

		test("counts UTF-8 bytes when applying the scan byte cap", async () => {
			const content = `${"é".repeat(Math.floor(files_GREP_MAX_SCAN_BYTES / 2))}needle\n`;
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_byte_limit_reached");
			expect(result.nextStartIndex).toBe(0);
		});

		test("slice window scans inside an oversized line", async () => {
			const prefix = "x".repeat(files_GREP_MAX_SCAN_BYTES + 10);
			const content = `${prefix}needle-end\n`;
			const result = await match_markdown_chunks_list(
				grepTestChunkIterator(grepTestChunks(content, [prefix.length - 5])),
				{
					...matchMarkdownTestScannerOptions,
					pattern: "needle",
					match: { kind: "substring", needle: "needle", ignoreCase: false },
					window: { kind: "slice", startIndex: prefix.length - 5, maxChars: 64 },
				},
			);

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 1, line: "xxxxxneedle-end", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});
	});

	describe("derive_tree_path_for_file_node", () => {
		test("keeps file paths unchanged", () => {
			expect(derive_tree_path_for_file_node("/docs/readme.md", "file")).toBe("/docs/readme.md");
		});

		test("adds a trailing slash for non-root folders", () => {
			expect(derive_tree_path_for_file_node("/docs", "folder")).toBe("/docs/");
		});

		test("keeps root unchanged", () => {
			expect(derive_tree_path_for_file_node("/", "folder")).toBe("/");
		});
	});
}
