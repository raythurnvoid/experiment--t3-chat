/*
Files nodes are organized as a file tree where each node is either a folder or a Markdown file.

This structure allows file-system-like operations such as finding all items under a path (`/docs/*`) or
listing folder children and reading file content (`/docs/README.md`).
*/

import {
	httpAction,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
	type MutationCtx,
	type ActionCtx,
	internalMutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator, type RegisteredQuery, type RouteSpec } from "convex/server";
import { generateText, streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	path_extract_segments_from,
	server_convex_get_user_fallback_to_anonymous,
	path_join,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	date_get_week_start_timestamp,
	date_get_day_start_timestamp,
	date_get_hour_start_timestamp,
	date_MS_DAY,
	date_MS_DAYS_30,
	date_MS_WEEK,
} from "../shared/date.ts";
import {
	files_FIRST_VERSION,
	files_ROOT_ID,
	files_headless_tiptap_editor_create,
	files_u8_to_array_buffer,
	files_headless_tiptap_editor_set_content_from_markdown,
	files_yjs_create_empty_state_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_tiptap_editor,
	files_yjs_doc_create_from_tiptap_editor,
	files_yjs_compute_diff_update_from_state_vector,
	files_CREATE_NODE_VALIDATION_MESSAGES,
	files_MAX_UPLOADS_BYTES,
	files_get_utf8_byte_size,
	type files_ContentType,
} from "../server/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { minimatch } from "minimatch";
import { Result, Result_all } from "../shared/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import type { Editor } from "@tiptap/core";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema from "./schema.ts";
import { api, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";
import { billing_event } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_create_upload_key, r2_generate_upload_url, r2_get_bucket } from "./r2.ts";

const files_INLINE_AI_MODEL_ID = "gpt-5-mini" as const;
const files_HOME_FILE_NAME = "README.md";
// Keep recognizing home files created before special file-name casing normalized them to README.md.
const files_LEGACY_HOME_FILE_NAME = "readme.md";

function files_compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case "gpt-5.4-nano":
		case "gpt-4.1-nano":
			return args.inputTokens * 0.00001 + args.outputTokens * 0.00004;
		case "gpt-5.4-mini":
		case files_INLINE_AI_MODEL_ID:
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

async function files_ingest_inline_ai_usage_event(
	ctx: ActionCtx | MutationCtx,
	args: {
		actorUserId: Id<"users">;
		billedUser: Doc<"users">;
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		requestId: string;
		inputTokens: number;
		outputTokens: number;
	},
) {
	if (args.inputTokens + args.outputTokens === 0) {
		return;
	}

	await billing_ingest_events(ctx, {
		billedUserEvents: [
			{
				billedUser: args.billedUser,
				event: billing_event({
					name: "ai_usage",
					externalCustomerId: args.billedUser._id,
					externalMemberId: args.actorUserId,
					externalId: composite_id(
						"billing",
						"ai_usage",
						args.billedUser._id,
						args.actorUserId,
						args.workspaceId,
						args.projectId,
						"inline_ai",
						args.requestId,
					),
					metadata: {
						amount: files_compute_token_usage_cost_cents({
							modelId: files_INLINE_AI_MODEL_ID,
							inputTokens: args.inputTokens,
							outputTokens: args.outputTokens,
						}),
						actorUserId: args.actorUserId,
						billedUserId: args.billedUser._id,
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						modelId: files_INLINE_AI_MODEL_ID,
						inputTokens: args.inputTokens,
						outputTokens: args.outputTokens,
						threadId: "inline_ai",
						messageId: args.requestId,
					},
				}),
			},
		],
	});
}

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

function is_home_file(node: Pick<Doc<"files_nodes">, "path" | "kind">): boolean;
function is_home_file(node: Pick<Doc<"files_nodes">, "parentId" | "name" | "kind">): boolean;
function is_home_file(node: Partial<Pick<Doc<"files_nodes">, "path" | "parentId" | "name" | "kind">>) {
	return (
		node.kind === "file" &&
		(node.path === `/${files_HOME_FILE_NAME}` ||
			node.path === `/${files_LEGACY_HOME_FILE_NAME}` ||
			(node.parentId === files_ROOT_ID &&
				(node.name === files_HOME_FILE_NAME || node.name === files_LEGACY_HOME_FILE_NAME)))
	);
}

async function db_get_home_file(ctx: QueryCtx | MutationCtx, args: { workspaceId: string; projectId: string }) {
	const homeFile = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_kind_name_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("parentId", files_ROOT_ID)
				.eq("kind", "file")
				.eq("name", files_HOME_FILE_NAME)
				.eq("archiveOperationId", undefined),
		)
		.first();

	if (homeFile) {
		return homeFile;
	}

	return ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_kind_name_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("parentId", files_ROOT_ID)
				.eq("kind", "file")
				.eq("name", files_LEGACY_HOME_FILE_NAME)
				.eq("archiveOperationId", undefined),
		)
		.first();
}

async function db_insert_file_chunks(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		yjsSequence: number;
		markdownContent: string;
	},
) {
	// Create new chunks from markdown.
	const chunks = await files_chunk_markdown(args.markdownContent);
	if (chunks._nay) {
		return chunks;
	}

	// An empty chunk list naturally performs no inserts.
	const markdownChunkIds = await Promise.all(
		chunks._yay.map((chunk) =>
			ctx.db.insert("files_markdown_chunks", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				nodeId: args.nodeId,
				yjsSequence: args.yjsSequence,
				chunkIndex: chunk.chunkIndex,
				markdownChunk: chunk.markdownChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
			}),
		),
	);

	await Promise.all(
		chunks._yay.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				nodeId: args.nodeId,
				yjsSequence: args.yjsSequence,
				chunkIndex: chunk.chunkIndex,
				plainTextChunk: chunk.plainTextChunk,
				markdownChunkId: markdownChunkIds[index],
			}),
		),
	);

	return Result({ _yay: null });
}

export async function db_replace_file_chunks(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		yjsSequence: number;
		markdownContent: string;
	},
) {
	// Delete existing chunk rows.
	await Promise.all([
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
			)
			.collect(),
		ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
			)
			.collect(),
	]).then(([plainTextChunkRows, markdownChunkRows]) =>
		Promise.all([
			...plainTextChunkRows.map((row) => ctx.db.delete("files_plain_text_chunks", row._id)),
			...markdownChunkRows.map((row) => ctx.db.delete("files_markdown_chunks", row._id)),
		]),
	);

	return db_insert_file_chunks(ctx, args);
}

async function resolve_id_from_path(ctx: QueryCtx, args: { workspaceId: string; projectId: string; path: string }) {
	if (args.path === "/") {
		return null;
	}

	const activeFileByMaterializedPath = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_path_shadowSourceFileNode_archiveOp", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("path", args.path)
				.eq("shadowSourceFileNodeId", undefined)
				.eq("archiveOperationId", undefined),
		)
		.first();
	return activeFileByMaterializedPath?._id ?? null;
}

async function resolve_file_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	return resolve_id_from_path(ctx, args);
}

export const resolve_file_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.id("files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return resolve_file_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
	},
});

async function db_resolve_tree_node_id_from_path(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	if (args.path === "/") return files_ROOT_ID;

	const fileByMaterializedPath = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_path_shadowSourceFileNode_archiveOp", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("path", args.path)
				.eq("shadowSourceFileNodeId", undefined)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (fileByMaterializedPath) {
		return fileByMaterializedPath._id;
	}

	return null;
}

export const resolve_tree_node_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID), v.null()),
	handler: async (ctx, args) => {
		return db_resolve_tree_node_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
	},
});

async function resolve_parent_path_from_parent_id(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return "/";
	}

	const parentNode = await ctx.db.get("files_nodes", args.parentId);
	if (
		!parentNode ||
		parentNode.workspaceId !== args.workspaceId ||
		parentNode.projectId !== args.projectId ||
		parentNode.kind !== "folder"
	) {
		return null;
	}

	return parentNode.path;
}

async function cascade_file_descendants_path(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
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
			.withIndex("by_workspace_project_parent_name", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("parentId", frame.parentId),
			)
			.collect();

		await Promise.all(
			children.map(async (child) => {
				const childPath = path_join(frame.parentPath, child.name);
				await ctx.db.patch("files_nodes", child._id, {
					path: childPath,
				});
				stack.push({
					parentId: child._id,
					parentPath: childPath,
				});
			}),
		);
	}
}

/**
 * Rebase a shadow file node path when its source file node moves or is renamed.
 *
 * The shadow keeps the suffix generated from the old source path and follows the source to its next path.
 */
function shadow_path_rebase(args: {
	oldSourceFileNodePath: string;
	nextSourceFileNodePath: string;
	shadowFileNodePath: string;
}) {
	if (!args.shadowFileNodePath.startsWith(args.oldSourceFileNodePath)) {
		return args.shadowFileNodePath;
	}

	// Preserve the generated suffix so future multiple shadows can keep following the source path.
	return `${args.nextSourceFileNodePath}${args.shadowFileNodePath.slice(args.oldSourceFileNodePath.length)}`;
}

/**
 * Rebase a shadow file node name when its source file node is renamed.
 *
 * Only return a name when the generated shadow suffix is local to the file name, not a nested path segment.
 */
function shadow_name_rebase(args: {
	oldSourceFileNodePath: string;
	nextSourceFileNodeName: string;
	shadowFileNodePath: string;
}) {
	if (!args.shadowFileNodePath.startsWith(args.oldSourceFileNodePath)) {
		return null;
	}

	const suffix = args.shadowFileNodePath.slice(args.oldSourceFileNodePath.length);
	if (suffix.includes("/")) {
		return null;
	}

	return `${args.nextSourceFileNodeName}${suffix}`;
}

async function db_get_shadow_file_nodes_for_source_file_node(
	ctx: QueryCtx | MutationCtx,
	sourceFileNode: Doc<"files_nodes">,
) {
	return (
		await Promise.all(
			sourceFileNode.shadowFileNodeIds.map(async (shadowFileNodeId) => {
				const shadowFileNode = await ctx.db.get("files_nodes", shadowFileNodeId);
				if (
					!shadowFileNode ||
					shadowFileNode.workspaceId !== sourceFileNode.workspaceId ||
					shadowFileNode.projectId !== sourceFileNode.projectId ||
					shadowFileNode.shadowSourceFileNodeId !== sourceFileNode._id
				) {
					return null;
				}

				return shadowFileNode;
			}),
		)
	).filter((shadowFileNode): shadowFileNode is Doc<"files_nodes"> => shadowFileNode !== null);
}

async function db_rebase_shadow_file_nodes_for_source_file_node(
	ctx: MutationCtx,
	args: {
		sourceFileNode: Doc<"files_nodes">;
		nextParentId: Doc<"files_nodes">["parentId"];
		nextSourceFileNodeName: string;
		nextSourceFileNodePath: string;
		updatedBy: Id<"users">;
		updatedAt: number;
	},
) {
	const shadowFileNodes = await db_get_shadow_file_nodes_for_source_file_node(ctx, args.sourceFileNode);
	const shadowFileNodeIds = new Set(shadowFileNodes.map((shadowFileNode) => shadowFileNode._id));
	const nextShadowFileNodePathById = new Map<Id<"files_nodes">, string>();

	for (const shadowFileNode of shadowFileNodes) {
		const nextShadowFileNodePath = shadow_path_rebase({
			oldSourceFileNodePath: args.sourceFileNode.path,
			nextSourceFileNodePath: args.nextSourceFileNodePath,
			shadowFileNodePath: shadowFileNode.path,
		});
		const activePathConflict = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.sourceFileNode.workspaceId)
					.eq("projectId", args.sourceFileNode.projectId)
					.eq("path", nextShadowFileNodePath)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (activePathConflict && !shadowFileNodeIds.has(activePathConflict._id)) {
			return Result({
				_nay: {
					name: "nay",
					message: "Path already exists",
				},
			});
		}

		nextShadowFileNodePathById.set(shadowFileNode._id, nextShadowFileNodePath);
	}

	await Promise.all(
		shadowFileNodes.map((shadowFileNode) => {
			const nextPath = nextShadowFileNodePathById.get(shadowFileNode._id) ?? shadowFileNode.path;
			const nextName =
				shadow_name_rebase({
					oldSourceFileNodePath: args.sourceFileNode.path,
					nextSourceFileNodeName: args.nextSourceFileNodeName,
					shadowFileNodePath: shadowFileNode.path,
				}) ?? shadowFileNode.name;

			return ctx.db.patch("files_nodes", shadowFileNode._id, {
				parentId: args.nextParentId,
				name: nextName,
				path: nextPath,
				updatedBy: args.updatedBy,
				updatedAt: args.updatedAt,
			});
		}),
	);

	return Result({ _yay: null });
}

export const get_file_nodes_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.array(doc(app_convex_schema, "files_nodes")),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const nodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_shadowSourceFileNode_kind_name", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("shadowSourceFileNodeId", undefined),
			)
			.order("asc")
			.collect();

		return nodes;
	},
});

async function db_create_node(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
		name: Doc<"files_nodes">["name"];
		kind: Doc<"files_nodes">["kind"];
		createMarkdownContent: boolean;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		shadowSourceFileNodeId?: Id<"files_nodes">;
		markdownContent?: Doc<"files_markdown_content">["content"];
		now?: number;
	},
) {
	const now = args.now ?? Date.now();
	const parentPath = await resolve_parent_path_from_parent_id(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
	});
	if (parentPath == null) {
		return Result({
			_nay: {
				name: "nay",
				message: "Parent file not found",
			},
		});
	}

	const nodePath = path_join(parentPath, args.name);
	if (args.archiveOperationId === undefined) {
		// Check whether an active file already exists for the same path.
		const activePathConflict = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", nodePath)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (activePathConflict) {
			return Result({
				_nay: {
					name: "nay",
					message:
						args.kind === "file"
							? files_CREATE_NODE_VALIDATION_MESSAGES.fileAlreadyExists
							: files_CREATE_NODE_VALIDATION_MESSAGES.folderAlreadyExists,
				},
			});
		}
	}

	const nodeId = await ctx.db.insert("files_nodes", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
		path: nodePath,
		version: files_FIRST_VERSION,
		name: args.name,
		kind: args.kind,
		archiveOperationId: args.archiveOperationId,
		shadowSourceFileNodeId: args.shadowSourceFileNodeId,
		shadowFileNodeIds: [],
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
	});

	if (args.kind === "folder") {
		return Result({ _yay: nodeId });
	}

	if (!args.createMarkdownContent) {
		return Result({ _yay: nodeId });
	}

	const markdownContent = args.markdownContent ?? "";

	// Create initial Yjs snapshot + sequence tracker with the file.
	// Important: do NOT store an empty bytes blob; Yjs update decoding may throw on empty payloads.
	const initialYjsSequence = 0;

	let initialYjsSnapshotUpdate;
	if (markdownContent) {
		const editor = files_headless_tiptap_editor_create();

		if (editor._nay) {
			return editor;
		}

		const markdownContentSet = files_headless_tiptap_editor_set_content_from_markdown({
			markdown: markdownContent,
			mut_editor: editor._yay,
		});
		if (markdownContentSet._nay) {
			return markdownContentSet;
		}
		initialYjsSnapshotUpdate = yjs_create_state_update_from_tiptap_editor({
			tiptapEditor: editor._yay,
		});
	} else {
		initialYjsSnapshotUpdate = files_yjs_create_empty_state_update();
	}

	const [yjs_snapshot_id, yjs_last_sequence_id, markdown_content_id, properties_id] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: nodeId,
			sequence: initialYjsSequence,
			snapshotUpdate: files_u8_to_array_buffer(initialYjsSnapshotUpdate),
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: nodeId,
			lastSequence: initialYjsSequence,
		}),
		ctx.db.insert("files_markdown_content", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: nodeId,
			content: markdownContent,
			isArchived: false,
			yjsSequence: initialYjsSequence,
			updatedBy: args.userId,
			updatedAt: now,
		}),
		// Store file properties from the saved Markdown snapshot, not unsaved editor state.
		ctx.db.insert("files_node_properties", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			fileNodeId: nodeId,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			size: files_get_utf8_byte_size(markdownContent),
			updatedAt: now,
		}),
		db_insert_file_chunks(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId,
			yjsSequence: initialYjsSequence,
			markdownContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}
			return chunks;
		}),
	] as const).catch((error) => {
		const message = "Failed to create file content rows";
		console.error("Failed to create file content rows", {
			message,
			error,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: args.parentId,
			nodeId,
			yjsSequence: initialYjsSequence,
		});
		// Throw so Convex rolls back the node and all related file rows created in this mutation.
		throw convex_error({
			message,
			cause: error,
		});
	});

	await ctx.db.patch("files_nodes", nodeId, {
		markdownContentId: markdown_content_id,
		yjsLastSequenceId: yjs_last_sequence_id,
		yjsSnapshotId: yjs_snapshot_id,
		propertiesId: properties_id,
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
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		kind: Doc<"files_nodes">["kind"];
		createMarkdownContent: boolean;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		shadowSourceFileNodeId?: Id<"files_nodes">;
		markdownContent?: Doc<"files_markdown_content">["content"];
		now: number;
	},
) {
	let currentParent: Doc<"files_nodes">["parentId"] = args.parentId;
	const pathSegments = path_extract_segments_from(args.path);

	// Walk segments in order because each child lookup needs the previous folder id.
	for (const [i, name] of pathSegments.entries()) {
		const isLeaf = i === pathSegments.length - 1;
		const kind: Doc<"files_nodes">["kind"] = isLeaf ? args.kind : "folder";
		const existing = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_kind_name_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", currentParent)
					.eq("kind", kind)
					.eq("name", name)
					.eq("archiveOperationId", undefined),
			)
			.first();

		if (existing) {
			// Reuse active intermediate folders, but keep leaf creation as a real create.
			if (!isLeaf) {
				currentParent = existing._id;
				continue;
			}

			// Archived generated files may share a path with an active replacement.
			if (args.archiveOperationId === undefined) {
				return Result({
					_nay: {
						name: "nay",
						message:
							kind === "file"
								? files_CREATE_NODE_VALIDATION_MESSAGES.fileAlreadyExists
								: files_CREATE_NODE_VALIDATION_MESSAGES.folderAlreadyExists,
					},
				});
			}
		}

		const node = await db_create_node(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: currentParent,
			name,
			kind,
			createMarkdownContent: isLeaf ? args.createMarkdownContent : false,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
			shadowSourceFileNodeId: isLeaf ? args.shadowSourceFileNodeId : undefined,
			markdownContent: isLeaf ? args.markdownContent : undefined,
			now: args.now,
		});

		if (node._nay) {
			return node;
		}

		// Return the requested leaf; otherwise continue creating below the new folder.
		if (isLeaf) {
			return Result({ _yay: node._yay });
		}

		currentParent = node._yay;
	}

	throw should_never_happen("nodeId not resolved after node path creation");
}

export const create_folder_node = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		name: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// We trust that the front-end is validating the input correctly.
		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.parentId,
			path: args.name,
			kind: "folder",
			createMarkdownContent: false,
			now: Date.now(),
		});

		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

export const create_markdown_node = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		name: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// We trust that the front-end is validating the input correctly.
		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.parentId,
			path: args.name,
			kind: "file",
			createMarkdownContent: true,
			now: Date.now(),
		});

		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

export const create_upload_node = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		filename: v.string(),
		contentType: v.optional(v.string()),
		size: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			uploadId: v.id("files_uploads"),
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

		const membership = await workspaces_db_get_membership(ctx, {
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
				parent.workspaceId !== membership.workspaceId ||
				parent.projectId !== membership.projectId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== undefined
			) {
				return Result({ _nay: { message: "Parent folder not found" } });
			}
			parentPath = parent.path;
		}

		const nodePath = path_join(parentPath, args.filename);
		const existingNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_shadowSourceFileNode_archiveOp", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("path", nodePath)
					.eq("shadowSourceFileNodeId", undefined)
					.eq("archiveOperationId", undefined),
			)
			.first();
		const now = Date.now();
		if (existingNode) {
			if (existingNode.kind !== "file") {
				return Result({
					_nay: {
						message: "The path cannot point to a folder",
					},
				});
			}

			await db_archive_nodes(ctx, {
				nodeIds: [existingNode._id, ...existingNode.shadowFileNodeIds],
				updatedBy: userAuth.id,
				now,
			});
		}

		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			userId: membership.userId,
			parentId: args.parentId,
			path: args.filename,
			kind: "file",
			createMarkdownContent: false,
			now,
		});
		if (node._nay) {
			return Result({ _nay: node._nay });
		}

		const key = r2_create_upload_key({
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			nodeId: node._yay,
		});
		const [uploadId, propertiesId] = await Promise.all([
			ctx.db.insert("files_uploads", {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: membership.userId,
				r2Bucket: r2_get_bucket(),
				r2Key: key,
				filename: args.filename,
				sourceNodeId: node._yay,
			}),
			ctx.db.insert("files_node_properties", {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				fileNodeId: node._yay,
				...(args.contentType ? { contentType: args.contentType } : {}),
				size: args.size,
				updatedAt: now,
			}),
		]);
		await ctx.db.patch("files_nodes", node._yay, {
			uploadId,
			propertiesId,
		});
		const signedUpload = await r2_generate_upload_url(key);
		const headers: Record<string, string> = args.contentType ? { "Content-Type": args.contentType } : {};

		return Result({
			_yay: {
				uploadId,
				nodeId: node._yay,
				url: signedUpload.url,
				headers,
			},
		});
	},
});

export const create_file_quick = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// Ensure "tmp" under root exists
		const tmp = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_kind_name_archiveOperation", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("parentId", files_ROOT_ID)
					.eq("kind", "folder")
					.eq("name", "tmp")
					.eq("archiveOperationId", undefined),
			)
			.first();

		let tmpNodeId = null;

		if (!tmp) {
			const tmpNode = await db_create_node(ctx, {
				userId: userAuth.id,
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: files_ROOT_ID,
				name: "tmp",
				kind: "folder",
				createMarkdownContent: false,
			});

			if (tmpNode._nay) {
				return tmpNode;
			}

			tmpNodeId = tmpNode._yay;
		} else {
			tmpNodeId = tmp._id;
		}

		// Create quick file under "tmp".
		const title = `quick-file-${Date.now()}.md`;
		const node = await db_create_node(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: tmpNodeId,
			name: title,
			kind: "file",
			createMarkdownContent: true,
		});

		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

export const rename_node = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		name: v.string(),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (is_home_file(file)) {
			// Ignore rename requests for home file
			return Result({ _yay: null });
		}

		const pathSegments = path_extract_segments_from(args.name);
		// Resolve the target first so simple and nested renames share one conflict/write path.
		let targetParentId = file.parentId;
		let targetParentPath: string;
		let leafName: string;

		if (pathSegments.length > 1) {
			// Treat slash-delimited names as a move into created/reused parent folders.
			const parentPath = await resolve_parent_path_from_parent_id(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: file.parentId,
			});
			if (parentPath == null) {
				return Result({ _yay: null });
			}

			targetParentPath = parentPath;
			// We trust that the front-end is validating the input correctly.
			for (const name of pathSegments.slice(0, -1)) {
				const existing = await ctx.db
					.query("files_nodes")
					.withIndex("by_workspace_project_parent_kind_name_archiveOperation", (q) =>
						q
							.eq("workspaceId", membership.workspaceId)
							.eq("projectId", membership.projectId)
							.eq("parentId", targetParentId)
							.eq("kind", "folder")
							.eq("name", name)
							.eq("archiveOperationId", undefined),
					)
					.first();

				if (existing) {
					if (existing._id === args.nodeId) {
						return Result({
							_nay: {
								name: "nay",
								message: "Parent folder not found",
							},
						});
					}

					targetParentId = existing._id;
					targetParentPath = existing.path;
					continue;
				}

				const folder = await db_create_node(ctx, {
					userId: userAuth.id,
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					parentId: targetParentId,
					name,
					kind: "folder",
					createMarkdownContent: false,
				});
				if (folder._nay) {
					return folder;
				}

				targetParentId = folder._yay;
				targetParentPath = path_join(targetParentPath, name);
			}

			const resolvedLeafName = pathSegments.at(-1);
			if (!resolvedLeafName) {
				throw should_never_happen("leafName not resolved after path rename");
			}
			leafName = resolvedLeafName;
		} else {
			const parentPath = await resolve_parent_path_from_parent_id(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: file.parentId,
			});
			if (parentPath == null) {
				return Result({ _yay: null });
			}

			targetParentPath = parentPath;
			leafName = args.name;
		}

		const renamedPath = path_join(targetParentPath, leafName);
		if (file.archiveOperationId === undefined) {
			// Check whether an active file already exists for the same path.
			const activePathConflict = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", membership.workspaceId)
						.eq("projectId", membership.projectId)
						.eq("path", renamedPath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (activePathConflict && activePathConflict._id !== args.nodeId) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
		}

		const now = Date.now();
		const shadowFileNodesRebase = await db_rebase_shadow_file_nodes_for_source_file_node(ctx, {
			sourceFileNode: file,
			nextParentId: targetParentId,
			nextSourceFileNodeName: leafName,
			nextSourceFileNodePath: renamedPath,
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		if (shadowFileNodesRebase._nay) {
			return shadowFileNodesRebase;
		}

		// Update the node once and then rebase descendants under the new materialized path.
		await ctx.db.patch("files_nodes", args.nodeId, {
			parentId: targetParentId,
			name: leafName,
			path: renamedPath,
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		await cascade_file_descendants_path(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.nodeId,
			parentPath: renamedPath,
		});
		return Result({ _yay: null });
	},
});

export const move_nodes = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const targetParentPath = await resolve_parent_path_from_parent_id(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.targetParentId,
		});
		if (targetParentPath == null) {
			return Result({ _yay: null });
		}

		const filesToMove: Array<{ itemId: Id<"files_nodes">; file: Doc<"files_nodes">; movedPath: string }> = [];

		for (const itemId of args.itemIds) {
			const file = await ctx.db.get("files_nodes", itemId);
			if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
				continue;
			}
			if (is_home_file(file)) {
				// Skip move requests for home file
				continue;
			}

			const movedPath = path_join(targetParentPath, file.name);
			filesToMove.push({ itemId, file, movedPath });
		}

		const movingNodeIds = new Set(filesToMove.map((file) => file.itemId));
		const movedPathByNodeId = new Map<string, Id<"files_nodes">>();
		for (const fileToMove of filesToMove) {
			if (fileToMove.file.archiveOperationId !== undefined) {
				continue;
			}

			const duplicateTargetNodeId = movedPathByNodeId.get(fileToMove.movedPath);
			if (duplicateTargetNodeId && duplicateTargetNodeId !== fileToMove.itemId) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
			movedPathByNodeId.set(fileToMove.movedPath, fileToMove.itemId);

			// Check whether an active file already exists for the same path.
			const activePathConflict = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", membership.workspaceId)
						.eq("projectId", membership.projectId)
						.eq("path", fileToMove.movedPath)
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
		for (const fileToMove of filesToMove) {
			const shadowFileNodesRebase = await db_rebase_shadow_file_nodes_for_source_file_node(ctx, {
				sourceFileNode: fileToMove.file,
				nextParentId: args.targetParentId,
				nextSourceFileNodeName: fileToMove.file.name,
				nextSourceFileNodePath: fileToMove.movedPath,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
			if (shadowFileNodesRebase._nay) {
				return shadowFileNodesRebase;
			}

			await ctx.db.patch("files_nodes", fileToMove.itemId, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: args.targetParentId,
				path: fileToMove.movedPath,
				updatedAt: now,
			});
			await cascade_file_descendants_path(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: fileToMove.itemId,
				parentPath: fileToMove.movedPath,
			});
		}
		return Result({ _yay: null });
	},
});

// #region Archive nodes
async function db_archive_nodes(
	ctx: MutationCtx,
	args: {
		nodeIds: Array<Id<"files_nodes">>;
		updatedBy: Id<"users">;
		now: number;
	},
) {
	const archiveOperationId = crypto.randomUUID();

	await Promise.all(
		args.nodeIds.map((nodeId) =>
			ctx.db.patch("files_nodes", nodeId, {
				archiveOperationId,
				updatedBy: args.updatedBy,
				updatedAt: args.now,
			}),
		),
	);
}

export const archive_nodes = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
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

		const files = Result_all(
			await Promise.all(
				nodeIds.map((nodeId) =>
					ctx.db.get("files_nodes", nodeId).then((file) => {
						if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
							return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId } } });
						}

						return Result({ _yay: file });
					}),
				),
			),
		);

		if (files._nay) {
			return files;
		}

		const nodeIdsToArchive = new Set<Id<"files_nodes">>();

		for (const file of files._yay) {
			if (is_home_file(file)) {
				// Ignore archive requests for home file
				continue;
			}

			if (file.archiveOperationId !== undefined) {
				continue;
			}

			nodeIdsToArchive.add(file._id);
			for (const shadowFileNodeId of file.shadowFileNodeIds) {
				const shadowFileNode = await ctx.db.get("files_nodes", shadowFileNodeId);
				if (
					shadowFileNode &&
					shadowFileNode.workspaceId === membership.workspaceId &&
					shadowFileNode.projectId === membership.projectId &&
					shadowFileNode.archiveOperationId === undefined
				) {
					nodeIdsToArchive.add(shadowFileNode._id);
				}
			}

			// All descendants file needs to be archived too
			const descendantsPathPrefix = `${file.path}/`;
			const descendantFiles = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", membership.workspaceId)
						.eq("projectId", membership.projectId)
						.gte("path", descendantsPathPrefix)
						.lt("path", `${descendantsPathPrefix}\uffff`),
				)
				.collect();

			for (const descendantFile of descendantFiles) {
				if (descendantFile.archiveOperationId !== undefined) {
					continue;
				}
				nodeIdsToArchive.add(descendantFile._id);
			}
		}

		await db_archive_nodes(ctx, {
			nodeIds: [...nodeIdsToArchive],
			updatedBy: userAuth.id,
			now: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const unarchive_nodes = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
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

		const files = Result_all(
			await Promise.all(
				nodeIds.map((nodeId) =>
					ctx.db.get("files_nodes", nodeId).then((file) => {
						if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
							return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId } } });
						}
						return Result({ _yay: file });
					}),
				),
			),
		);

		if (files._nay) {
			return files;
		}

		const filesToUnarchive = [...files._yay];
		for (const file of files._yay) {
			const shadowFileNodes = await db_get_shadow_file_nodes_for_source_file_node(ctx, file);
			for (const shadowFileNode of shadowFileNodes) {
				if (shadowFileNode.archiveOperationId !== undefined) {
					filesToUnarchive.push(shadowFileNode);
				}
			}
		}

		// Find the top most shared ancestor for each file requested.
		const topMostSharedAncestorsByPath = new Map<string, Doc<"files_nodes">>();
		for (const file of filesToUnarchive) {
			if (!file) {
				continue;
			}

			const currentFile = file;

			// Ignore unarchive requests for home file.
			if (is_home_file(currentFile)) {
				continue;
			}

			if (currentFile.archiveOperationId === undefined) {
				continue;
			}

			const conflictedCurrentFile = topMostSharedAncestorsByPath.get(currentFile.path);
			if (conflictedCurrentFile) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive file because it would conflict with another unarchiving file",
						data: {
							requestedNodeIds: args.nodeIds,
							nodeId: currentFile._id,
							filePath: currentFile.path,
							targetPath: currentFile.path,
							conflictingNodeId: conflictedCurrentFile._id,
							conflictingFilePath: conflictedCurrentFile.path,
						},
					},
				});
			}

			let isDescendantOfCurrentRoot = false;
			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (currentFile.path.startsWith(`${currentRootPath}/`)) {
					isDescendantOfCurrentRoot = true;
					break;
				}
			}
			if (isDescendantOfCurrentRoot) {
				continue;
			}

			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (currentRootPath.startsWith(`${currentFile.path}/`)) {
					topMostSharedAncestorsByPath.delete(currentRootPath);
				}
			}

			topMostSharedAncestorsByPath.set(currentFile.path, currentFile);
		}

		if (topMostSharedAncestorsByPath.size === 0) {
			return Result({ _yay: null });
		}

		const topMostSharedAncestorFileParentById = new Map<string, Doc<"files_nodes">>();
		await Promise.all(
			(function* (/* iife */) {
				const visitedParentIds = new Set<Id<"files_nodes">>();
				for (const ancestorFile of topMostSharedAncestorsByPath.values()) {
					if (ancestorFile.archiveOperationId === undefined) {
						continue;
					}

					if (
						ancestorFile.parentId !== files_ROOT_ID &&
						!topMostSharedAncestorFileParentById.has(ancestorFile.parentId) &&
						!visitedParentIds.has(ancestorFile.parentId)
					) {
						visitedParentIds.add(ancestorFile.parentId);
						yield ctx.db.get("files_nodes", ancestorFile.parentId).then((parentFile) => {
							if (parentFile) {
								topMostSharedAncestorFileParentById.set(ancestorFile.parentId, parentFile);
							}
						});
					}
				}
			})(),
		);

		// Build one plan entry per file to unarchive.
		const plans: Array<{
			file: Doc<"files_nodes">;
			targetParentId: Doc<"files_nodes">["parentId"];
			targetPath: string;
		}> = [];
		const ancestorFilesByTargetPath = new Map<string, Doc<"files_nodes">>();

		const plansResult = Result_all(
			await Promise.all(
				(function* (/* iife */) {
					for (const ancestorFile of topMostSharedAncestorsByPath.values()) {
						if (ancestorFile.archiveOperationId === undefined) {
							continue;
						}

						let shouldMoveToRoot = false;
						if (ancestorFile.parentId !== files_ROOT_ID) {
							const parentFile = topMostSharedAncestorFileParentById.get(ancestorFile.parentId);

							// If parent is still archived or invalid, move this subtree to root when unarchiving.
							shouldMoveToRoot =
								!parentFile ||
								parentFile.workspaceId !== membership.workspaceId ||
								parentFile.projectId !== membership.projectId ||
								parentFile.archiveOperationId !== undefined;
						}

						const ancestorTargetParentId = shouldMoveToRoot ? files_ROOT_ID : ancestorFile.parentId;
						let ancestorTargetPath = ancestorFile.path;
						if (shouldMoveToRoot) {
							const ancestorPathName = path_extract_segments_from(ancestorFile.path).at(-1);
							if (!ancestorPathName) {
								throw should_never_happen("Failed to move file to root because path does not include a name segment", {
									nodeId: ancestorFile._id,
									path: ancestorFile.path,
								});
							}
							ancestorTargetPath = `/${ancestorPathName}`;
						}

						yield (async (/* iife */) => {
							const conflictedAncestorFile = ancestorFilesByTargetPath.get(ancestorTargetPath);
							if (conflictedAncestorFile) {
								return Result({
									_nay: {
										name: "nay",
										message: "Failed to unarchive file because it would conflict with another unarchiving file",
										data: {
											requestedNodeIds: args.nodeIds,
											nodeId: ancestorFile._id,
											filePath: ancestorFile.path,
											targetPath: ancestorTargetPath,
											conflictingNodeId: conflictedAncestorFile._id,
											conflictingFilePath: conflictedAncestorFile.path,
										},
									},
								});
							}
							ancestorFilesByTargetPath.set(ancestorTargetPath, ancestorFile);

							plans.push({
								file: ancestorFile,
								targetParentId: ancestorTargetParentId,
								targetPath: ancestorTargetPath,
							});

							return ctx.db
								.query("files_nodes")
								.withIndex("by_workspace_project_path_archiveOperation", (q) =>
									q
										.eq("workspaceId", membership.workspaceId)
										.eq("projectId", membership.projectId)
										.gte("path", `${ancestorFile.path}/`)
										.lt("path", `${ancestorFile.path}/\uffff`),
								)
								.collect()
								.then((descendantFiles) => {
									for (const file of descendantFiles) {
										if (file.archiveOperationId === undefined) {
											continue;
										}

										const targetPath = path_rebase({
											fromBasePath: ancestorFile.path,
											toBasePath: ancestorTargetPath,
											path: file.path,
										});

										if (!targetPath) {
											throw should_never_happen("Failed to rebase descendants files", {
												ancestorNodeId: ancestorFile._id,
												ancestorPath: ancestorFile.path,
												ancestorTargetPath,
												ancestorTargetParentId,
												descendantNodeId: file._id,
												descendantFilePath: file.path,
											});
										}

										plans.push({
											file,
											targetParentId: file.parentId,
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

		for (const [ancestorTargetPath, ancestorFile] of ancestorFilesByTargetPath) {
			// Check whether an active file already exists for the same path.
			const conflictFile = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", membership.workspaceId)
						.eq("projectId", membership.projectId)
						.eq("path", ancestorTargetPath)
						.eq("archiveOperationId", undefined),
				)
				.first();

			if (conflictFile) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive file because path already exists",
						data: {
							requestedNodeIds: args.nodeIds,
							nodeId: ancestorFile._id,
							filePath: ancestorFile.path,
							targetPath: ancestorTargetPath,
							conflictingNodeId: conflictFile._id,
							conflictingFilePath: conflictFile.path,
						},
					},
				});
			}
		}

		const now = Date.now();

		await Promise.all(
			plans.map(async (plan) =>
				ctx.db.patch("files_nodes", plan.file._id, {
					archiveOperationId: undefined,
					updatedBy: userAuth.id,
					updatedAt: now,
					...(plan.targetPath !== plan.file.path ? { path: plan.targetPath } : {}),
					...(plan.targetParentId !== plan.file.parentId ? { parentId: plan.targetParentId } : {}),
				}),
			),
		);

		return Result({ _yay: null });
	},
});
// #endregion Archive nodes

export const get = internalQuery({
	args: {
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get("files_nodes", args.nodeId);
	},
});

export type files_nodes_get_Result =
	typeof get extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue> ? Awaited<ReturnValue> : never;

export const get_for_membership = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		if (!nodeId) {
			return null;
		}

		const file = await ctx.db.get("files_nodes", nodeId);
		if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
			return null;
		}

		if (file.shadowSourceFileNodeId) {
			const sourceFileNode = await ctx.db.get("files_nodes", file.shadowSourceFileNodeId);
			if (
				sourceFileNode &&
				sourceFileNode.workspaceId === membership.workspaceId &&
				sourceFileNode.projectId === membership.projectId
			) {
				return sourceFileNode;
			}
		}

		return file;
	},
});

export const get_by_path = query({
	args: { membershipId: v.id("workspaces_projects_users"), path: v.string() },
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			name: v.string(),
			kind: doc(app_convex_schema, "files_nodes").fields.kind,
			uploadId: doc(app_convex_schema, "files_nodes").fields.uploadId,
			assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileConvexId = await resolve_id_from_path(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			path: args.path,
		});

		if (!fileConvexId) return null;
		const file = await ctx.db.get("files_nodes", fileConvexId);
		if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
			return null;
		}

		return file
			? {
					nodeId: file._id,
					name: file.name,
					kind: file.kind,
					...(file.uploadId ? { uploadId: file.uploadId } : {}),
					...(file.assetId ? { assetId: file.assetId } : {}),
				}
			: null;
	},
});

export const read_dir = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const nodeId = await db_resolve_tree_node_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!nodeId) return [];

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_shadowSourceFileNode_archiveOp", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", nodeId)
					.eq("shadowSourceFileNodeId", undefined)
					.eq("archiveOperationId", undefined),
			)
			.collect();

		// TODO: do not collect
		const names = children.map((file) => file.name);
		return names;
	},
});

export const get_file_info_for_list_dir_pagination = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		cursor: paginationOptsValidator.fields.cursor,
	},
	handler: async (ctx, args) => {
		// TODO: do not use paginate
		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_shadowSourceFileNode_archiveOp", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", args.parentId)
					.eq("shadowSourceFileNodeId", undefined)
					.eq("archiveOperationId", undefined),
			)
			.paginate({
				cursor: args.cursor,
				numItems: 1,
			});

		return {
			...result,
			files: result.page.map((file) => ({
				name: file.name,
				nodeId: file._id,
				updatedAt: file.updatedAt,
			})),
		};
	},
});

function matches_path(absPath: string, include: string | undefined) {
	return include ? minimatch(absPath, include) : true;
}

export const list_files = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		maxDepth: v.number(),
		limit: v.number(),
		include: v.optional(v.string()),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				updatedAt: v.number(),
				depthTruncated: v.boolean(),
			}),
		),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		// TODO: when truncating, we truncate the total rows but we don't tell the LLM if we truncated in depth
		const startNodeId = await db_resolve_tree_node_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!startNodeId) return { items: [], truncated: false };

		if (startNodeId !== files_ROOT_ID) {
			const startNode = await ctx.db.get("files_nodes", startNodeId);
			if (!startNode || startNode.kind !== "folder") {
				return startNode && matches_path(args.path, args.include)
					? {
							items: [
								{
									path: startNode.path,
									kind: startNode.kind,
									updatedAt: startNode.updatedAt,
									depthTruncated: false,
								},
							],
							truncated: false,
						}
					: { items: [], truncated: false };
			}
		}

		// Normalize base path to an absolute path string (leading slash, no trailing slash except root)
		const basePath = args.path;
		const maxDepth = Math.max(0, Math.min(10, args.maxDepth));
		const limit = Math.max(1, Math.min(100, args.limit));
		const include = args.include;

		const matchesInclude = (absPath: string) => matches_path(absPath, include);

		const results: Array<{
			path: string;
			kind: Doc<"files_nodes">["kind"];
			updatedAt: number;
			depthTruncated: boolean;
		}> = [];
		let truncated = false;

		// Depth-first traversal using an explicit stack.
		// We iterate children via an indexed query (async iterable) and dive deeper first.
		const stack: Array<{
			parentId: Doc<"files_nodes">["parentId"];
			absPath: string;
			depth: number;
			iterator: AsyncIterator<Doc<"files_nodes">> | null;
		}> = [{ parentId: startNodeId, absPath: basePath, depth: 0, iterator: null }];

		try {
			// Iterate 1 extra time (less or equal `limit`) to flag the truncation
			while (stack.length && results.length <= limit) {
				const frame = stack.at(-1)!;

				// Lazily fetch children by parentId via index; avoid .collect()
				const iterator =
					frame.iterator ??
					ctx.db
						.query("files_nodes")
						.withIndex("by_workspace_project_parent_shadowSourceFileNode_archiveOp", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("parentId", frame.parentId)
								.eq("shadowSourceFileNodeId", undefined)
								.eq("archiveOperationId", undefined),
						)
						[Symbol.asyncIterator]();

				const iteratorItem = await iterator.next();

				// No more children at this frame or file is empty or `maxDepth` is reached
				if (iteratorItem.done) {
					stack.pop();
					// Clean up the iterator
					await iterator.return?.();

					continue;
				}

				const child = iteratorItem.value;
				const childPath = path_join(frame.absPath, child.name);

				// If include pattern is provided, only add items that match the glob
				if (matchesInclude(childPath)) {
					if (results.length < limit && frame.depth <= maxDepth) {
						results.push({ path: childPath, kind: child.kind, updatedAt: child.updatedAt, depthTruncated: false });
					}
					// Respect the `maxDepth` and mark the depth truncation
					else if (frame.depth > maxDepth) {
						stack.pop();
						// Clean up the iterator
						await iterator.return?.();

						const lastResult = results.at(-1);
						if (lastResult) {
							lastResult.depthTruncated = true;
						}

						continue;
					}
					// Respect `limit` and mark the truncation
					else {
						truncated = true;
						break;
					}
				}

				// Then, push the child to dive deeper first (pre-order/JSON.stringify-like walk)
				const nextDepth = frame.depth + 1;
				// less or equal `maxDepth` to allow the extra depth iteration
				if (child.kind === "folder" && nextDepth <= maxDepth + 1) {
					// Set frame on parent frame to resume iteration
					frame.iterator = iterator;
					stack.push({
						parentId: child._id,
						absPath: childPath,
						depth: nextDepth,
						iterator: null,
					});
				}
			}
		} finally {
			// Clean up the iterators
			await Promise.all(stack.map((frame) => frame.iterator?.return?.()).filter((x) => x != null));
		}

		return { items: results, truncated };
	},
});

export const get_file_last_available_markdown_content_by_path = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.object({
			content: v.string(),
			nodeId: v.id("files_nodes"),
			displayNodeId: v.id("files_nodes"),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const convexId = await resolve_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});

		if (!convexId) return null;

		const file = await ctx.db.get("files_nodes", convexId);

		if (!file) return null;
		if (file.archiveOperationId !== undefined) return null;
		if (file.kind !== "file") return null;

		const shadowFileNodes = file.markdownContentId
			? []
			: await db_get_shadow_file_nodes_for_source_file_node(ctx, file);
		const contentFile =
			file.markdownContentId !== undefined
				? file
				: (shadowFileNodes.find(
						(shadowFileNode) =>
							shadowFileNode.archiveOperationId === undefined && shadowFileNode.markdownContentId !== undefined,
					) ?? null);

		if (!contentFile) return null;
		if (contentFile.kind !== "file" || !contentFile.markdownContentId) return null;

		if (!contentFile.markdownContentId) {
			return null;
		}

		const pendingUpdateById = args.pendingUpdateId
			? await ctx.db.get("files_pending_updates", args.pendingUpdateId)
			: null;
		const pendingUpdate =
			pendingUpdateById &&
			pendingUpdateById.workspaceId === args.workspaceId &&
			pendingUpdateById.projectId === args.projectId &&
			pendingUpdateById.userId === args.userId &&
			pendingUpdateById.nodeId === contentFile._id
				? pendingUpdateById
				: await ctx.db
						.query("files_pending_updates")
						.withIndex("by_workspace_project_user_file", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("userId", args.userId)
								.eq("nodeId", contentFile._id),
						)
						.first();
		if (pendingUpdate) {
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate);

			const markdown = files_yjs_doc_get_markdown({ yjsDoc });
			if (markdown._yay) {
				return {
					content: markdown._yay,
					nodeId: contentFile._id,
					displayNodeId: file._id,
					pendingUpdateId: pendingUpdate._id,
				};
			}

			console.error(
				"[get_file_last_available_markdown_content_by_path] Failed to reconstruct markdown from files_pending_updates",
				{
					nay: markdown._nay,
					nodeId: contentFile._id,
				},
			);
		}

		const markdownContentDoc = await ctx.db.get("files_markdown_content", contentFile.markdownContentId);
		if (!markdownContentDoc) return null;

		return {
			content: markdownContentDoc.content,
			nodeId: contentFile._id,
			displayNodeId: file._id,
			pendingUpdateId: pendingUpdate?._id ?? null,
		};
	},
});

export const get_plain_text = query({
	args: { membershipId: v.id("workspaces_projects_users"), nodeId: v.id("files_nodes") },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.workspaceId !== membership.workspaceId ||
			file.projectId !== membership.projectId ||
			file.kind !== "file" ||
			!file.markdownContentId ||
			file.archiveOperationId !== undefined
		) {
			return null;
		}

		if (!file.markdownContentId) {
			return null;
		}

		const latestChunkByFile = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
				q.eq("workspaceId", file.workspaceId).eq("projectId", file.projectId).eq("nodeId", args.nodeId),
			)
			.order("desc")
			.first();

		if (!latestChunkByFile) {
			throw should_never_happen("Missing plain text chunks for file", {
				nodeId: args.nodeId,
				workspaceId: file.workspaceId,
				projectId: file.projectId,
			});
		}

		const plainTextChunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
				q
					.eq("workspaceId", file.workspaceId)
					.eq("projectId", file.projectId)
					.eq("nodeId", args.nodeId)
					.eq("yjsSequence", latestChunkByFile.yjsSequence),
			)
			.order("asc")
			.collect();

		return plainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n\n");
	},
});

export const get_file_last_yjs_sequence = query({
	args: { membershipId: v.id("workspaces_projects_users"), nodeId: v.id("files_nodes") },
	returns: v.union(v.object({ lastSequence: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.workspaceId !== membership.workspaceId ||
			file.projectId !== membership.projectId ||
			file.kind !== "file" ||
			!file.markdownContentId
		) {
			return null;
		}

		if (!file.yjsLastSequenceId) {
			return null;
		}

		const lastYjsSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", file.yjsLastSequenceId).then((doc) => {
			if (!doc || doc.workspaceId !== file.workspaceId || doc.projectId !== file.projectId) return null;
			return doc;
		});

		if (!lastYjsSequenceDoc) {
			throw should_never_happen("lastYjsSequenceDoc is not valorized", {
				workspaceId: file.workspaceId,
				projectId: file.projectId,
				nodeId: args.nodeId,
				yjsLastSequenceId: file.yjsLastSequenceId,
			});
		}

		return { lastSequence: lastYjsSequenceDoc.lastSequence };
	},
});

export const text_search_files = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		query: v.string(),
		limit: v.number(),
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
	}> => {
		const matches = await ctx.db
			.query("files_plain_text_chunks")
			.withSearchIndex("search_by_plainTextChunk", (q) =>
				q.search("plainTextChunk", args.query).eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.take(Math.max(1, Math.min(100, args.limit)));

		// Convex text search returns word by word search results ordered by relevance,
		// we want to return only 1 result per chunk and only the exact match of the
		// query in input.
		const exactMatches: typeof matches = [];
		const seenMarkdownChunkIds = new Set<(typeof matches)[number]["markdownChunkId"]>();
		for (const match of matches) {
			if (seenMarkdownChunkIds.has(match.markdownChunkId)) {
				continue;
			}
			seenMarkdownChunkIds.add(match.markdownChunkId);

			if (!match.plainTextChunk.includes(args.query)) {
				continue;
			}

			exactMatches.push(match);

			if (exactMatches.length >= args.limit) {
				break;
			}
		}

		const items = (
			await Promise.all(
				exactMatches.map(async (plainTextChunk) => {
					const [fileDoc, markdownChunkDoc] = await Promise.all([
						ctx.db.get("files_nodes", plainTextChunk.nodeId),
						ctx.db.get("files_markdown_chunks", plainTextChunk.markdownChunkId),
					]);

					if (
						!fileDoc ||
						fileDoc.workspaceId !== args.workspaceId ||
						fileDoc.projectId !== args.projectId ||
						fileDoc.kind !== "file" ||
						fileDoc.archiveOperationId !== undefined
					) {
						return null;
					}

					if (
						!markdownChunkDoc ||
						markdownChunkDoc.workspaceId !== args.workspaceId ||
						markdownChunkDoc.projectId !== args.projectId ||
						markdownChunkDoc.nodeId !== plainTextChunk.nodeId ||
						markdownChunkDoc.yjsSequence !== plainTextChunk.yjsSequence ||
						markdownChunkDoc.chunkIndex !== plainTextChunk.chunkIndex
					) {
						return null;
					}

					const [chunkAbove, chunkBelow] = await Promise.all([
						ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
								q
									.eq("workspaceId", args.workspaceId)
									.eq("projectId", args.projectId)
									.eq("nodeId", plainTextChunk.nodeId)
									.eq("yjsSequence", plainTextChunk.yjsSequence)
									.eq("chunkIndex", plainTextChunk.chunkIndex - 1),
							)
							.first(),
						ctx.db
							.query("files_markdown_chunks")
							.withIndex("by_workspace_project_file_yjsSequence_chunkIndex", (q) =>
								q
									.eq("workspaceId", args.workspaceId)
									.eq("projectId", args.projectId)
									.eq("nodeId", plainTextChunk.nodeId)
									.eq("yjsSequence", plainTextChunk.yjsSequence)
									.eq("chunkIndex", plainTextChunk.chunkIndex + 1),
							)
							.first(),
					]);

					return {
						path: fileDoc.path,
						markdownChunk: markdownChunkDoc.markdownChunk,
						chunkIndex: markdownChunkDoc.chunkIndex,
						startIndex: markdownChunkDoc.startIndex,
						endIndex: markdownChunkDoc.endIndex,
						lineStart: markdownChunkDoc.lineStart,
						lineEnd: markdownChunkDoc.lineEnd,
						chunkFlags: markdownChunkDoc.chunkFlags,
						hasChunkAbove: !!chunkAbove,
						hasChunkBelow: !!chunkBelow,
					};
				}),
			)
		).filter((item): item is NonNullable<typeof item> => item !== null);

		return { items };
	},
});

/**
 * Create a Markdown file at a trusted path.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_file_by_path = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		markdownContent: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const activeFile = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_shadowSourceFileNode_archiveOp", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", args.path)
					.eq("shadowSourceFileNodeId", undefined)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (activeFile?.kind === "file") {
			return Result({ _yay: { nodeId: activeFile._id } });
		}

		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "file",
			createMarkdownContent: true,
			markdownContent: args.markdownContent,
			now: Date.now(),
		});
		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

export const get_home_file = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.union(
		v.object({
			file: doc(app_convex_schema, "files_nodes"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const file = await db_get_home_file(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
		});

		if (!file) {
			return null;
		}

		return {
			file,
		};
	},
});

export const create_home_file = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const file = await db_get_home_file(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
		});

		if (file) {
			return Result({ _yay: { nodeId: file._id } });
		}

		const result = await db_create_node(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: files_ROOT_ID,
			name: files_HOME_FILE_NAME,
			kind: "file",
			createMarkdownContent: true,
		});

		if (result._nay) {
			return result;
		}

		return Result({ _yay: { nodeId: result._yay } });
	},
});

export const get_file_snapshots_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return {
				snapshots: [],
			};
		}

		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_workspace_project_file_archivedAt", (q) => {
				const qBase = q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("nodeId", args.nodeId);

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
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(doc(app_convex_schema, "files_snapshots"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (!snapshot) {
			return null;
		}

		if (
			snapshot.workspaceId !== membership.workspaceId ||
			snapshot.projectId !== membership.projectId ||
			snapshot.nodeId !== args.nodeId
		) {
			return null;
		}

		return snapshot;
	},
});

async function do_get_file_snapshot_content(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
	},
) {
	const content = await ctx.db
		.query("files_snapshots_contents")
		.withIndex("by_workspace_project_fileSnapshot", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("snapshotId", args.snapshotId),
		)
		.first();
	if (!content || content.nodeId !== args.nodeId) {
		return null;
	}

	return {
		content: content.content,
		snapshotId: content.snapshotId,
		_creationTime: content._creationTime,
	};
}

export const get_file_snapshot_content = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			content: v.string(),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await do_get_file_snapshot_content(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		});
	},
});

export const archive_snapshot = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (!snapshot || snapshot.workspaceId !== membership.workspaceId || snapshot.projectId !== membership.projectId) {
			return Result({ _yay: null });
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const unarchive_snapshot = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (!snapshot || snapshot.workspaceId !== membership.workspaceId || snapshot.projectId !== membership.projectId) {
			return Result({ _yay: null });
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: 0,
		});
		return Result({ _yay: null });
	},
});

function yjs_create_state_update_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = files_yjs_doc_create_from_tiptap_editor({
		tiptapEditor: args.tiptapEditor,
	});
	return encodeStateAsUpdate(yjsDoc);
}

export const yjs_get_doc_last_snapshot = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_yjs_snapshots"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.workspaceId !== membership.workspaceId ||
			node.projectId !== membership.projectId ||
			node.kind !== "file" ||
			!node.markdownContentId
		) {
			return null;
		}

		return await ctx.db
			.query("files_yjs_snapshots")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("projectId", membership.projectId).eq("nodeId", args.nodeId),
			)
			.order("desc")
			.first();
	},
});

async function yjs_increment_or_create_last_sequence(
	ctx: MutationCtx,
	args: { workspaceId: string; projectId: string; nodeId: Id<"files_nodes"> },
) {
	let lastSequenceData = await ctx.db
		.query("files_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_file", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
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
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			lastSequence: 0,
		});
		lastSequenceData = (await ctx.db.get("files_yjs_docs_last_sequences", lastSequenceDataId))!;
	}

	return lastSequenceData;
}

export async function files_db_yjs_push_update(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		update: ArrayBuffer;
		sessionId: string;
		userId: Id<"users">;
	},
) {
	const now = Date.now();

	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
	});

	await ctx.db.insert("files_yjs_updates", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
		sequence: newSequenceData.lastSequence,
		update: args.update,
		origin: {
			type: "USER_EDIT",
			sessionId: args.sessionId,
		},
		createdBy: args.userId,
		createdAt: now,
	});

	const snapshotScheduleDelayMs =
		newSequenceData.lastSequence > 0 && newSequenceData.lastSequence % 50 === 0 ? 0 : 30_000;

	const schedules = await ctx.db
		.query("files_yjs_snapshot_schedules")
		.withIndex("by_file", (q) => q.eq("nodeId", args.nodeId))
		.collect();

	const scheduledId = await ctx.scheduler.runAfter(snapshotScheduleDelayMs, internal.files_nodes.update_snapshots, {
		userId: args.userId,
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
	});

	await Promise.all([
		schedules[0]
			? ctx.db.patch("files_yjs_snapshot_schedules", schedules[0]._id, { scheduledFunctionId: scheduledId })
			: ctx.db.insert("files_yjs_snapshot_schedules", { nodeId: args.nodeId, scheduledFunctionId: scheduledId }),
		...schedules.slice(1).map((schedule) => ctx.db.delete("files_yjs_snapshot_schedules", schedule._id)),
	]);

	return Result({ _yay: { newSequence: newSequenceData.lastSequence } });
}

export const yjs_push_update = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (!file) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (file.kind !== "file" || !file.markdownContentId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace) {
			throw should_never_happen("Workspace missing", {
				membershipId: membership._id,
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
			});
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: user._id,
			workspace,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			throw should_never_happen("Billed user missing", {
				userId: user._id,
				workspaceId: workspace._id,
				billedUserId,
			});
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
			workspaceId: file.workspaceId,
			projectId: file.projectId,
			nodeId: args.nodeId,
			update: args.update,
			sessionId: args.sessionId,
			userId: user._id,
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
							membership.workspaceId,
							membership.projectId,
							args.nodeId,
							pushResult._yay.newSequence,
						),
						metadata: {
							amount: 1,
							actorUserId: user._id,
							billedUserId: billedUser._id,
							workspaceId: file.workspaceId,
							projectId: file.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.workspaceId !== membership.workspaceId ||
			node.projectId !== membership.projectId ||
			node.kind !== "file"
		) {
			return null;
		}

		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("projectId", membership.projectId).eq("nodeId", args.nodeId),
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

const store_version_snapshot_args_schema = v.object({
	workspaceId: v.string(),
	projectId: v.string(),
	nodeId: v.id("files_nodes"),
	content: v.string(),
	createdBy: v.id("users"),
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return files_u8_to_array_buffer(mergeUpdates(updates));
}

function yjs_compute_diff_update_with_headless_tiptap_editor(args: {
	fileYjsData: Doc<"files_yjs_snapshots">;
	headlessEditorWithUpdatedContent: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(args.fileYjsData.snapshotUpdate);
	const yjsBeforeStateVector = encodeStateVector(yjsDoc);

	files_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.headlessEditorWithUpdatedContent,
		opKind: args.opKind,
	});

	// TODO: there's a small performance improvement that can be achieved by listening for updates events from ydoc
	const diffUpdate = files_yjs_compute_diff_update_from_state_vector({ yjsDoc, yjsBeforeStateVector });

	return diffUpdate;
}

async function write_markdown_to_yjs_sync(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		markdownContent: string;
		sessionId: string;
		snapshotId: Id<"files_snapshots">;
	},
) {
	// Reconstruct the latest Y.Doc from last snapshot
	const fileYjsData = await ctx.db
		.query("files_yjs_snapshots")
		.withIndex("by_workspace_project_file_sequence", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
		)
		.order("desc")
		.first();

	if (!fileYjsData) {
		return null;
	}

	// Convert markdown to TipTap JSON
	const headlessEditor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdownContent },
	});

	if (headlessEditor._nay) {
		throw should_never_happen("Could not create headless editor from markdown content", {
			nodeId: args.nodeId,
			nay: headlessEditor._nay,
		});
	}

	const diffUpdate = yjs_compute_diff_update_with_headless_tiptap_editor({
		fileYjsData,
		headlessEditorWithUpdatedContent: headlessEditor._yay,
		opKind: "snapshot-restore",
	});

	if (!diffUpdate) {
		return null;
	}

	const newSnapshotUpdate = yjs_merge_updates_to_array_buffer([new Uint8Array(fileYjsData.snapshotUpdate), diffUpdate]);

	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
	});

	await Promise.all([
		ctx.db.insert("files_yjs_updates", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			sequence: newSequenceData.lastSequence,
			update: files_u8_to_array_buffer(diffUpdate),
			origin: {
				type: "USER_SNAPSHOT_RESTORE",
				snapshotId: args.snapshotId,
			},
			createdBy: args.userId,
			createdAt: Date.now(),
		}),

		ctx.db.patch("files_yjs_snapshots", fileYjsData._id, {
			sequence: newSequenceData.lastSequence,
			snapshotUpdate: newSnapshotUpdate,
			updatedAt: Date.now(),
			updatedBy: args.userId,
		}),
	]);

	return newSequenceData.lastSequence;
}

export const update_snapshots = internalMutation({
	args: {
		userId: v.id("users"),
		workspaceId: v.string(),
		projectId: v.string(),
		nodeId: v.id("files_nodes"),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to update the file snapshots"),
			}),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const cleanScheduleLocksPromise = ctx.db
			.query("files_yjs_snapshot_schedules")
			.withIndex("by_file", (q) => q.eq("nodeId", args.nodeId))
			.collect()
			.then((scheduleLocks) =>
				Promise.all(scheduleLocks.map((schedule) => ctx.db.delete("files_yjs_snapshot_schedules", schedule._id))),
			);

		try {
			const now = Date.now();

			const file = await ctx.db.get("files_nodes", args.nodeId);
			if (
				!file ||
				file.workspaceId !== args.workspaceId ||
				file.projectId !== args.projectId ||
				!file.markdownContentId
			) {
				throw should_never_happen("File missing", {
					nodeId: args.nodeId,
					file: file,
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					markdownContentId: file?.markdownContentId,
				});
			}

			// Load latest snapshot
			const yjsSnapshotData = await ctx.db
				.query("files_yjs_snapshots")
				.withIndex("by_workspace_project_file_sequence", (q) =>
					q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
				)
				.order("desc")
				.first();

			if (!yjsSnapshotData) {
				throw should_never_happen(
					"yjs_snapshot_data or last_sequence_data are null.\n" + //
						"The job should start only if the last sequence exists and is greater than 0\n" + //
						"and only if the yjs snapshot data already exists, the snapshot data should\n" + //
						"be created with the file",
				);
			}

			// Fetch updates since snapshot up to uptoSeq
			const updateDataList = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_workspace_project_file_sequence", (q) =>
					q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
				)
				.order("asc")
				.collect();

			const lastUpdate = updateDataList.at(-1);
			const sequence = lastUpdate ? lastUpdate.sequence : yjsSnapshotData.sequence;

			// merge last snapshot update with all incremental updates into a single update blob
			const snapshotUpdate = yjs_merge_updates_to_array_buffer([
				new Uint8Array(yjsSnapshotData.snapshotUpdate),
				...updateDataList.map((u) => new Uint8Array(u.update)),
			]);

			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
			const markdown = files_yjs_doc_get_markdown({ yjsDoc });

			if (markdown._nay) {
				return markdown;
			}

			const dbWriteResult = Result_all(
				await Promise.all([
					// Write new snapshot row (append-only)
					ctx.db.patch("files_yjs_snapshots", yjsSnapshotData._id, {
						sequence,
						snapshotUpdate: snapshotUpdate,
						updatedBy: "system",
						updatedAt: now,
					}),

					// Prune compacted updates
					...updateDataList.map((updateData) => ctx.db.delete("files_yjs_updates", updateData._id)),

					ctx.db.patch("files_markdown_content", file.markdownContentId, {
						content: markdown._yay,
						yjsSequence: sequence,
						updatedBy: "system",
						updatedAt: now,
					}),

					(async () => {
						if (!file.propertiesId) {
							throw should_never_happen("File properties missing", {
								nodeId: args.nodeId,
								workspaceId: args.workspaceId,
								projectId: args.projectId,
							});
						}

						await ctx.db.patch("files_node_properties", file.propertiesId, {
							workspaceId: args.workspaceId,
							projectId: args.projectId,
							fileNodeId: args.nodeId,
							contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
							size: files_get_utf8_byte_size(markdown._yay),
							updatedAt: now,
						});
					})(),

					db_replace_file_chunks(ctx, {
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						nodeId: args.nodeId,
						yjsSequence: sequence,
						markdownContent: markdown._yay,
					}),

					store_version_snapshot(ctx, {
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						nodeId: args.nodeId,
						content: markdown._yay,
						createdBy: args.userId,
					}),
				]),
			);

			if (dbWriteResult._nay) {
				const message = "Failed to update the file snapshots" satisfies NonNullable<
					(typeof args)["_errors"]
				>["message"];
				console.error(message, {
					dbWriteResult,
				});
				return Result({
					_nay: {
						name: "nay",
						message,
					},
				});
			}

			return Result({ _yay: null });
		} finally {
			await cleanScheduleLocksPromise;
		}
	},
});

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	// Create snapshot entry
	const snapshotId = await ctx.db.insert("files_snapshots", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
		createdBy: args.createdBy,
		archivedAt: -1,
	});

	// Create content entry
	await ctx.db.insert("files_snapshots_contents", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		snapshotId: snapshotId,
		content: args.content,
		nodeId: args.nodeId,
	});

	return snapshotId;
}

export const restore_snapshot = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
		currentMarkdownContent: v.string(),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to restore file"),
			}),
		),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const [snapshotContent, file] = await Promise.all([
			do_get_file_snapshot_content(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			ctx.db.get("files_nodes", args.nodeId).then((file) => {
				if (!file || file.workspaceId !== membership.workspaceId || file.projectId !== membership.projectId) {
					return null;
				}

				return file;
			}),
		]);

		if (!snapshotContent || !file || !file.markdownContentId) {
			const msg = "Not found";
			console.error(
				should_never_happen(msg, {
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					nodeId: args.nodeId,
					snapshotContentNotFound: !snapshotContent,
					fileNotFound: !file,
					markdownContentIdNotFound: !file?.markdownContentId,
				}),
			);
			return Result({
				_nay: {
					name: "nay",
					message: msg,
				},
			});
		}

		if (!file.yjsLastSequenceId) {
			throw should_never_happen("file.yjsLastSequenceId is not set", {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				yjsLastSequenceId: file.yjsLastSequenceId,
			});
		}

		const userDoc = await ctx.db.get("users", userAuth.id);
		if (!userDoc) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace) {
			throw should_never_happen("Workspace missing", {
				membershipId: membership._id,
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			});
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: userAuth.id,
			workspace,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			throw should_never_happen("Billed user missing", {
				userId: userAuth.id,
				workspaceId: workspace._id,
				billedUserId,
			});
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

		const now = Date.now();
		const createdBy = userAuth.id;
		const updatedBy = userAuth.id;

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		const [, , , restoredYjsSequence] = await Promise.all([
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				content: args.currentMarkdownContent,
				createdBy: createdBy,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				content: snapshotContent.content,
				createdBy: createdBy,
			}),

			ctx.db.patch("files_nodes", file._id, {
				updatedBy: updatedBy,
				updatedAt: now,
			}),

			write_markdown_to_yjs_sync(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				markdownContent: snapshotContent.content,
				sessionId: args.sessionId,
				snapshotId: args.snapshotId,
			}),
		]);

		const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", file.yjsLastSequenceId);
		if (!yjsLastSequenceDoc) {
			throw should_never_happen("yjsLastSequenceDoc is not valorized", {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				yjsLastSequenceId: file.yjsLastSequenceId,
				yjsLastSequenceDoc,
			});
		}

		const restoreFileResult = Result_all(
			await Promise.all([
				ctx.db.patch("files_markdown_content", file.markdownContentId, {
					content: snapshotContent.content,
					yjsSequence: yjsLastSequenceDoc.lastSequence,
					updatedBy: updatedBy,
					updatedAt: now,
				}),
				(async () => {
					if (!file.propertiesId) {
						throw should_never_happen("File properties missing", {
							nodeId: args.nodeId,
							workspaceId: membership.workspaceId,
							projectId: membership.projectId,
						});
					}

					await ctx.db.patch("files_node_properties", file.propertiesId, {
						workspaceId: membership.workspaceId,
						projectId: membership.projectId,
						fileNodeId: args.nodeId,
						contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
						size: files_get_utf8_byte_size(snapshotContent.content),
						updatedAt: now,
					});
				})(),
				db_replace_file_chunks(ctx, {
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					nodeId: args.nodeId,
					yjsSequence: yjsLastSequenceDoc.lastSequence,
					markdownContent: snapshotContent.content,
				}),
			]),
		);

		if (restoreFileResult._nay) {
			const message = "Failed to restore file" satisfies NonNullable<(typeof args)["_errors"]>["message"];
			console.error(message, {
				restoreFileResult,
			});
			return Result({
				_nay: {
					name: "nay",
					message,
				},
			});
		}

		if (restoredYjsSequence !== null) {
			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser,
						event: billing_event({
							name: "file_save",
							externalCustomerId: billedUser._id,
							externalMemberId: userAuth.id,
							externalId: composite_id(
								"billing",
								"file_save",
								billedUser._id,
								userAuth.id,
								membership.workspaceId,
								membership.projectId,
								args.nodeId,
								restoredYjsSequence,
							),
							metadata: {
								amount: 1,
								actorUserId: userAuth.id,
								billedUserId: billedUser._id,
								workspaceId: membership.workspaceId,
								projectId: membership.projectId,
								nodeId: args.nodeId,
								yjsSequence: String(restoredYjsSequence),
							},
						}),
					},
				],
			});
		}

		return Result({
			_yay: null,
		});
	},
});

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
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const timestamp60DaysAgo = now - 60 * 24 * 60 * 60 * 1000;

		const latestSnapshotNodeIdWithTimeSlot = new Set<string>();
		const deletePromises: Array<Promise<any>> = [];

		const snapshotsToScanCursor = ctx.db
			.query("files_snapshots")
			.withIndex("by_creation_time", (q) => q.gte("_creationTime", timestamp60DaysAgo))
			.order("desc");

		for await (const snapshot of snapshotsToScanCursor) {
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
				const snapshotTimeSlotKey = `${snapshot.nodeId}::${bucketTimestamp}`;
				if (!latestSnapshotNodeIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotNodeIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (!keepSnapshot) {
				deletePromises.push(
					// TODO: If we save the content id in the snapshot doc we can use the more efficient .get
					ctx.db
						.query("files_snapshots_contents")
						.withIndex("by_workspace_project_fileSnapshot", (q) =>
							q
								.eq("workspaceId", snapshot.workspaceId)
								.eq("projectId", snapshot.projectId)
								.eq("snapshotId", snapshot._id),
						)
						.first()
						.then((content) => content && ctx.db.delete("files_snapshots_contents", content._id)),
					ctx.db.delete("files_snapshots", snapshot._id),
				);
			}
		}

		await Promise.all(deletePromises);

		return null;
	},
});

// #endregion snapshots

export function files_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/files/contextual-prompt" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							prompt: z.string(),
							option: z.string().optional(),
							command: z.string().optional(),
							context: z
								.object({
									beforeSelection: z.string(),
									selection: z.string(),
									afterSelection: z.string(),
								})
								.optional(),
							previous: z
								.object({
									prompt: z.string(),
									response: z.object({
										type: z.enum(["insert", "replace", "other"]).optional(),
										text: z.string(),
									}),
								})
								.optional(),
							membershipId: z.string(),
							requestId: z.string(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
								if (!userAuth) {
									return {
										status: 401,
										body: {
											message: "Unauthenticated",
										},
									} as const;
								}

								const rateLimit = await rate_limiter_limit_by_key(ctx, {
									name: "ai_inline_http",
									key: userAuth.id,
								});
								if (rateLimit) {
									return {
										status: 429,
										body: {
											message: rateLimit.message,
											retryAfterMs: rateLimit.retryAfterMs,
										},
									} as const;
								}

								const body = await server_request_json_parse_and_validate(request, bodyValidator);
								if (body._nay) {
									return {
										status: 400,
										body: body._nay,
									} as const;
								}

								const { prompt, option, command, context, previous, membershipId, requestId } = body._yay;

								if (!prompt || typeof prompt !== "string") {
									return {
										status: 400,
										body: {
											message: "Invalid prompt",
										},
									} as const;
								}

								const user = await ctx.runQuery(internal.users.get, { userId: userAuth.id });
								if (!user) {
									return {
										status: 401,
										body: {
											message: "Unauthenticated",
										},
									} as const;
								}

								const membership = await ctx.runQuery(api.workspaces.get_membership, { membershipId });
								if (!membership || membership.userId !== user._id) {
									return {
										status: 403,
										body: {
											message: "Unauthorized",
										},
									} as const;
								}

								const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
									userId: user._id,
									workspaceId: membership.workspaceId,
									minimumRequiredCents: 1,
								});
								if (!creditCheck.hasCredits) {
									return {
										status: 402,
										body: {
											message: "Insufficient funds",
										},
									} as const;
								}
								const billedUser = creditCheck.billedUser;
								if (!billedUser) {
									throw should_never_happen("Workspace credit check did not return billed user", {
										userId: user._id,
										workspaceId: membership.workspaceId,
									});
								}

								// Use the Liveblocks contextual shape when editor context is present; the inline popover path
								// omits context and consumes the streaming response below.
								let systemPrompt = "";
								let userPrompt = "";

								if (context) {
									systemPrompt =
										"You are an AI writing assistant for a rich text editor. " +
										"Return only the text that should be inserted or used as the replacement. " +
										"Use Markdown formatting when appropriate.";
									userPrompt = [
										`Instruction: ${prompt}`,
										`Before selection:\n${context.beforeSelection || "(empty)"}`,
										`Selected text:\n${context.selection || "(empty)"}`,
										`After selection:\n${context.afterSelection || "(empty)"}`,
										previous
											? `Previous instruction:\n${previous.prompt}\n\nPrevious response:\n${previous.response.text}`
											: null,
									]
										.filter((value) => value !== null)
										.join("\n\n");
								} else {
									switch (option) {
										case "continue":
											systemPrompt =
												"You are an AI writing assistant that continues existing text based on context from prior text. " +
												"Give more weight/priority to the later characters than the beginning ones. " +
												"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = prompt;
											break;
										case "improve":
											systemPrompt =
												"You are an AI writing assistant that improves existing text. " +
												"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = `The existing text is: ${prompt}`;
											break;
										case "shorter":
											systemPrompt =
												"You are an AI writing assistant that shortens existing text. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = `The existing text is: ${prompt}`;
											break;
										case "longer":
											systemPrompt =
												"You are an AI writing assistant that lengthens existing text. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = `The existing text is: ${prompt}`;
											break;
										case "fix":
											systemPrompt =
												"You are an AI writing assistant that fixes grammar and spelling errors in existing text. " +
												"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = `The existing text is: ${prompt}`;
											break;
										case "zap":
											systemPrompt =
												"You are an AI writing assistant that generates text based on a prompt. " +
												"You take an input from the user and a command for manipulating the text. " +
												"Use Markdown formatting when appropriate.";
											userPrompt = `For this text: ${prompt}. You have to respect the command: ${command}`;
											break;
										default:
											systemPrompt =
												"You are an AI writing assistant. Help with the given text based on the user's needs.";
											userPrompt = command ? `${command}\n\nText: ${prompt}` : `Continue this text:\n\n${prompt}`;
									}
								}

								if (context) {
									const result = await generateText({
										model: openai(files_INLINE_AI_MODEL_ID),
										system: systemPrompt,
										messages: [
											{
												role: "user",
												content: userPrompt,
											},
										],
										temperature: 0.7,
										maxOutputTokens: 500,
										abortSignal: request.signal,
									});

									await files_ingest_inline_ai_usage_event(ctx, {
										actorUserId: user._id,
										billedUser,
										workspaceId: membership.workspaceId,
										projectId: membership.projectId,
										requestId,
										inputTokens: result.totalUsage.inputTokens ?? 0,
										outputTokens: result.totalUsage.outputTokens ?? 0,
									});

									return {
										status: 200,
										body: {
											type: context.selection.trim() ? "replace" : "insert",
											text: result.text,
										},
									} as const;
								}

								// Generate streaming completion using AI SDK v5 UI message stream response
								const result = streamText({
									model: openai(files_INLINE_AI_MODEL_ID),
									system: systemPrompt,
									messages: [
										{
											role: "user",
											content: userPrompt,
										},
									],
									temperature: 0.7,
									maxOutputTokens: 500,
									experimental_transform: smoothStream({
										delayInMs: 100,
									}),
									abortSignal: request.signal,
									onFinish: async ({ totalUsage }) => {
										await files_ingest_inline_ai_usage_event(ctx, {
											actorUserId: user._id,
											billedUser,
											workspaceId: membership.workspaceId,
											projectId: membership.projectId,
											requestId,
											inputTokens: totalUsage.inputTokens ?? 0,
											outputTokens: totalUsage.outputTokens ?? 0,
										});
									},
								});

								return {
									status: 200,
									body: result,
								} as const;
							} catch (error: unknown) {
								console.error("AI generation error:", error);
								return {
									status: 500,
									body: {
										message: error instanceof Error ? error.message : "Internal server error",
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 200 && "toUIMessageStreamResponse" in result.body) {
									return result.body.toUIMessageStreamResponse({
										onError: (error) => {
											console.error("AI generation error:", error);
											return error instanceof Error ? error.message : String(error);
										},
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
