// Files nodes are organized as a file tree where each node is either a folder or a Markdown file.
//
// This structure allows file-system-like operations such as finding all items under a path (`/docs/*`) or
// listing folder children and reading file content (`/docs/README.md`).

import {
	httpAction,
	action,
	internalAction,
	internalQuery,
	query,
	type QueryCtx,
	type MutationCtx,
	type ActionCtx,
	internalMutation,
	mutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type RegisteredAction,
	type RegisteredMutation,
	type RegisteredQuery,
	type RouteSpec,
} from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import { generateText, streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import type { Editor } from "@tiptap/core";
import {
	path_extract_segments_from,
	server_path_normalize,
	server_convex_get_user_fallback_to_anonymous,
	path_join,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import { type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
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
	files_INITIAL_CONTENT,
	files_headless_tiptap_editor_create,
	files_u8_to_array_buffer,
	files_headless_tiptap_editor_set_content_from_markdown,
	files_yjs_create_empty_state_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_yjs_doc_create_from_tiptap_editor,
	files_yjs_compute_diff_update_from_state_vector,
	files_MAX_UPLOADS_BYTES,
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_pending_update_content_of,
	files_db_cancel_pending_update_cleanup_tasks,
	files_db_build_pending_path_overlay,
	files_db_get_pending_update,
	files_db_get_visible_node_by_path,
	files_db_list_pending_updates_for_user,
	files_pending_path_overlay_project_committed_path,
	type files_ContentType,
	type files_SpecialFileName,
	type files_InlineAiModelId,
	type files_PendingPathOverlay,
} from "../server/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { minimatch } from "minimatch";
import { Result, Result_all } from "common/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema from "./schema.ts";
import { api, components, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";
import { billing_event } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_metadata_db_delete_committed,
	files_metadata_db_patch_file_scope,
	files_metadata_db_insert_committed,
} from "./files_metadata.ts";
import {
	r2_get_download_url,
	r2_generate_upload_url,
	r2_fetch_object_from_bucket,
	r2_fetch_object_range_from_bucket,
	r2_put_object,
	r2_get_bucket,
	r2_create_asset_key,
	r2_delete_object,
} from "./r2.ts";

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

function files_compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case "gpt-5.4-nano":
		case "gpt-4.1-nano":
			return args.inputTokens * 0.00001 + args.outputTokens * 0.00004;
		case "gpt-5.4-mini":
		case "gpt-5-mini" satisfies files_InlineAiModelId:
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

async function files_ingest_inline_ai_usage_event(
	ctx: ActionCtx | MutationCtx,
	args: {
		actorUserId: Id<"users">;
		billedUser: Doc<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
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
						args.organizationId,
						args.workspaceId,
						"inline_ai",
						args.requestId,
					),
					metadata: {
						amount: files_compute_token_usage_cost_cents({
							modelId: "gpt-5-mini" satisfies files_InlineAiModelId,
							inputTokens: args.inputTokens,
							outputTokens: args.outputTokens,
						}),
						actorUserId: args.actorUserId,
						billedUserId: args.billedUser._id,
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						modelId: "gpt-5-mini" satisfies files_InlineAiModelId,
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
async function db_upsert_file_stats(
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

/**
 * Insert a paired set of committed `files_markdown_chunks` + `files_plain_text_chunks` for one file node.
 * Editable Markdown materialization passes a real `yjsSequence`; read-only text materialization omits it.
 * Caller supplies the already-computed chunk array and the denormalized `path`/`archiveOperationId` for the
 * plain-text docs. Does not touch `file_stats` or `files_metadata_docs` — callers own those.
 */
async function db_insert_committed_text_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		chunks: ReadonlyArray<{
			chunkIndex: number;
			markdownChunk: string;
			plainTextChunk: string;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			chunkFlags: number;
		}>;
	},
) {
	// An empty chunk list naturally performs no inserts.
	const markdownChunkIds = await Promise.all(
		args.chunks.map((chunk) =>
			ctx.db.insert("files_markdown_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed",
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
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
		args.chunks.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed",
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
				markdownChunkId: markdownChunkIds[index],
				chunkIndex: chunk.chunkIndex,
				path: args.path,
				archiveOperationId: args.archiveOperationId,
				plainTextChunk: chunk.plainTextChunk,
				markdownChunk: chunk.markdownChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < args.chunks.length - 1,
			}),
		),
	);
}

export async function db_insert_file_text_content(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		contentType: Doc<"files_nodes">["contentType"];
		textContent: string;
	},
) {
	const isMarkdown = args.contentType?.startsWith("text/markdown") ?? false;
	const isPlainText = args.contentType?.startsWith("text/plain") ?? false;
	if (!isMarkdown && !isPlainText) {
		const errorMessage = "Unsupported text content type";
		const errorData = {
			contentType: args.contentType,
			nodeId: args.nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const chunks = isMarkdown
		? await files_chunk_markdown(args.textContent)
		: Result({ _yay: files_chunk_plain_text(args.textContent) });
	if (chunks._nay) {
		return chunks;
	}

	await db_insert_committed_text_chunks(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: args.path,
		archiveOperationId: args.archiveOperationId,
		yjsSequence: args.yjsSequence,
		chunks: chunks._yay,
	});

	if (isMarkdown) {
		await files_metadata_db_insert_committed(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSequence: args.yjsSequence,
			markdownContent: args.textContent,
		});
	}

	const counts = files_compute_wc_counts(args.textContent);
	await db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		lineCount: counts.lineCount,
		wordCount: counts.wordCount,
		charCount: counts.charCount,
	});

	return Result({ _yay: null });
}

export async function db_replace_file_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		yjsSequence: number;
		markdownContent: string;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		fileNode.kind !== "file"
	) {
		const errorMessage = "db_replace_file_chunks expected a file node in the same organization/workspace";
		console.error(errorMessage, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			fileNode,
		});
		throw should_never_happen(errorMessage);
	}

	// Delete existing committed chunk/metadata docs.
	await Promise.all([
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		files_metadata_db_delete_committed(ctx, args),
	]).then(([plainTextChunkDocs, markdownChunkDocs]) =>
		Promise.all([
			...plainTextChunkDocs.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)),
			...markdownChunkDocs.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)),
		]),
	);

	return db_insert_file_text_content(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: fileNode.path,
		archiveOperationId: fileNode.archiveOperationId,
		yjsSequence: args.yjsSequence,
		contentType: "text/markdown;charset=utf-8",
		textContent: args.markdownContent,
	});
}

export function files_nodes_create_yjs_snapshot_update_from_markdown(markdownContent: string) {
	if (!markdownContent) {
		return Result({ _yay: files_u8_to_array_buffer(files_yjs_create_empty_state_update()) });
	}

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

	return Result({
		_yay: files_u8_to_array_buffer(
			yjs_create_state_update_from_tiptap_editor({
				tiptapEditor: editor._yay,
			}),
		),
	});
}

async function enqueue_file_content_materialization(
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
		internal.files_nodes.materialize_file_content,
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
		/** When set, resolve through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return await files_db_get_visible_node_by_path(ctx, args);
	},
});

export type files_nodes_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function db_resolve_tree_node_id_from_path(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		path: string;
	},
) {
	if (args.path === "/") return files_ROOT_ID;

	const fileNodeByMaterializedPath = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (fileNodeByMaterializedPath) {
		return fileNodeByMaterializedPath._id;
	}

	return null;
}

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
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		textContent?: string;
		readOnly?: boolean;
		now: number;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		path: args.path,
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

	// A file with no processable text content (e.g. a raw upload) still gets a stats doc, flagged
	// unprocessable with -1. A later materialization overwrites it with real counts if text appears.
	if (args.textContent === undefined) {
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

	const initialYjsSequence = 0;

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

	if (args.readOnly === true) {
		await db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			contentType: args.contentType,
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}
			return chunks;
		});

		return Result({ _yay: nodeId });
	}

	// Writable files need editable Yjs docs, so they cannot live in the reserved global organization.
	// Reserved external resources are identified by organizationId; SYSTEM and the reserved workspace id are
	// valid only inside that global organization.
	if (organizations_is_global_organization_id(args.organizationId)) {
		const errorMessage = "Editable text content requires a real organizationId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	if (organizations_is_reserved_workspace_id(args.workspaceId)) {
		const errorMessage = "Editable text content requires a real workspaceId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	if (args.userId === users_SYSTEM_AUTHOR) {
		const errorMessage = "Editable text content requires a real user id";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!args.yjsSnapshotAssetId) {
		const errorMessage = "fileNode.yjsSnapshotId asset is not set";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [yjs_snapshot_id, yjs_last_sequence_id] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: nodeId,
			sequence: 0,
			assetId: args.yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: nodeId,
			lastSequence: initialYjsSequence,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: initialYjsSequence,
			contentType: args.contentType,
			textContent: args.textContent,
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
		const errorMessage = "Failed to create file content docs";
		console.error(errorMessage, {
			error,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			nodeId,
			yjsSequence: initialYjsSequence,
		});
		// Throw so Convex rolls back the node and all related file docs created in this mutation.
		throw convex_error({
			message: errorMessage,
			cause: error,
		});
	});

	await ctx.db.patch("files_nodes", nodeId, {
		yjsLastSequenceId: yjs_last_sequence_id,
		yjsSnapshotId: yjs_snapshot_id,
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
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		textContent?: string;
		readOnly?: boolean;
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
			yjsSnapshotAssetId: isLeaf ? args.yjsSnapshotAssetId : undefined,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
			textContent: isLeaf ? args.textContent : undefined,
			readOnly: isLeaf ? args.readOnly : undefined,
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
		if (activeNode?.kind === "folder") {
			return Result({ _yay: { nodeId: activeNode._id, exists: true } });
		}
		if (activeNode?.kind === "file") {
			return Result({ _nay: { message: "A file already exists at this path." } });
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

export const create_file_node = internalMutation({
	args: {
		userId: doc(app_convex_schema, "files_nodes").fields.createdBy,
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
		contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
		assetId: v.id("files_r2_assets"),
		yjsSnapshotAssetId: v.optional(v.id("files_r2_assets")),
		archiveOperationId: v.optional(v.string()),
		textContent: v.string(),
		readOnly: v.boolean(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			nodeId: v.id("files_nodes"),
			/**
			 * The node's committed Yjs last sequence, captured in this same mutation. Eager-create
			 * callers stamp their pending update doc with it, so a save landing after this mutation
			 * always advances the node past the stamp and the hard-delete gate fails closed.
			 * Undefined when the node has no Yjs docs (read-only files).
			 */
			createdCommittedSequence: v.optional(v.number()),
			/**
			 * `_id`s of the intermediate folders this mutation created (reused folders are
			 * skipped), ordered deepest first; empty when no folder was created. Eager-create
			 * callers hand them to the compensation mutation so a failed proposal upsert can
			 * remove them too.
			 */
			createdAncestorIds: v.array(v.id("files_nodes")),
		}),
	}),
	handler: async (ctx, args) => {
		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return Result({ _nay: { message: "External mount sync run requires mountId and syncRunId" } });
		}
		if (args.mountId != null && args.syncRunId != null) {
			// Recheck inside the node-creation transaction. The mount may be replaced
			// after the action's first check.
			const mount = await ctx.db.get("github_mounts", args.mountId);
			if (
				!mount ||
				mount.status !== "running" ||
				mount.syncRunId !== args.syncRunId ||
				mount.pendingCommitSha == null ||
				!args.path.startsWith(`/${mount.name}/${mount.pendingCommitSha}/`)
			) {
				return Result({ _nay: { message: "External mount sync was superseded" } });
			}
		}
		const createdAncestorIds: Array<Id<"files_nodes">> = [];
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			path: args.path,
			kind: "file",
			contentType: args.contentType,
			assetId: args.assetId,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			archiveOperationId: args.archiveOperationId,
			textContent: args.textContent,
			readOnly: args.readOnly,
			now: Date.now(),
			mut_createdAncestorIds: createdAncestorIds,
		});
		if (nodeIdResult._nay) {
			return nodeIdResult;
		}
		// The helper records shallowest first; compensation walks deepest first.
		createdAncestorIds.reverse();

		// Capture the committed last sequence inside the creating transaction: no save can land
		// between the node creation and this read, so the value is the true creation-time state.
		let createdCommittedSequence: number | undefined;
		const createdNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
		if (createdNode?.yjsLastSequenceId) {
			const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", createdNode.yjsLastSequenceId);
			if (yjsLastSequenceDoc) {
				createdCommittedSequence = yjsLastSequenceDoc.lastSequence;
			}
		}

		return Result({ _yay: { nodeId: nodeIdResult._yay, createdCommittedSequence, createdAncestorIds } });
	},
});

/**
 * Final step of creating an editable Markdown file. Editable files have no content asset:
 * `node.assetId` points at the first version snapshot. This sets r2Key + size on the Yjs
 * snapshot and version snapshot assets, and inserts the version snapshot in `files_snapshots`.
 * The arg types only accept real org/workspace ids, so reserved scopes cannot reach this.
 */
export async function files_nodes_db_finalize_markdown_node_creation(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
	},
) {
	const now = Date.now();

	await Promise.all([
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.insert("files_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

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
		// Folder creation writes only the files_nodes doc (db_insert_node returns before
		// any side docs for folders), so one delete removes the whole folder.
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

export const finalize_markdown_node_creation = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		return await files_nodes_db_finalize_markdown_node_creation(ctx, args);
	},
});

export const cleanup_file_node_creation_assets = internalMutation({
	args: {
		assetIds: v.array(v.id("files_r2_assets")),
		r2Keys: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const r2Key of args.r2Keys) {
			await r2_delete_object(ctx, r2Key);
		}

		for (const assetId of args.assetIds) {
			const asset = await ctx.db.get("files_r2_assets", assetId);
			if (asset) {
				await ctx.db.delete("files_r2_assets", asset._id);
			}
		}

		return null;
	},
});

/**
 * Internal file-node creation for reserved read-only source content (GitHub mirrors and plugin
 * source snapshots).
 *
 * Creates a read-only text file at `path` in the GLOBAL organization under the requested reserved
 * workspace scope, using the SYSTEM user id, one content asset, and no Yjs or version snapshot docs.
 */
export const create_file_node_internal = internalAction({
	args: {
		workspaceId: v.union(
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		path: v.string(),
		rawText: v.string(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return Result({ _nay: { message: "External mount sync run requires mountId and syncRunId" } });
		}
		if (args.mountId != null && args.syncRunId != null) {
			// Sync-run validation is a GitHub-mirror concept; plugin source publishes never pass it.
			if (args.workspaceId !== organizations_GLOBAL_GITHUB_WORKSPACE_ID) {
				return Result({ _nay: { message: "External mount sync run requires the GITHUB workspace scope" } });
			}
			const mount = await ctx.runQuery(internal.github_mounts.get_mount, { mountId: args.mountId });
			if (!mount || mount.syncRunId !== args.syncRunId || mount.status !== "running") {
				return Result({ _nay: { message: "External mount sync was superseded" } });
			}
			// Materialized paths always live inside the run's pending commit root `/<name>/<sha>/...`.
			if (mount.pendingCommitSha == null || !args.path.startsWith(`/${mount.name}/${mount.pendingCommitSha}/`)) {
				return Result({ _nay: { message: "External mount path does not belong to the pending sync root" } });
			}
		}

		const byteSize = files_get_utf8_byte_size(args.rawText);
		if (byteSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({
				_nay: {
					name: "nay",
					message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
				},
			});
		}

		const assetId = await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: args.workspaceId,
			kind: "content",
			size: byteSize,
			createdBy: users_SYSTEM_AUTHOR,
		});

		const r2Key = r2_create_asset_key({
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: args.workspaceId,
			assetId,
		});

		try {
			await r2_put_object(ctx, {
				key: r2Key,
				body: args.rawText,
				contentType: "text/plain;charset=utf-8" satisfies files_ContentType,
			});
		} catch (error) {
			await ctx.runMutation(internal.files_nodes.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			console.error("Failed to write external source file asset", { error, assetId, path: args.path });
			return Result({ _nay: { message: "Failed to create external source file" } });
		}

		// Concurrent mount materialization races on shared folder creation (read-then-insert in
		// files_nodes_db_create_node_recursively_at_path), which Convex surfaces as a commit-time write conflict.
		// Retry the node-creation mutation a few times — the conflicting writer commits the folder, so a
		// retry reads it and proceeds — reusing the same asset so a transient conflict leaks no orphan.
		let created: create_file_node_Result | null = null;
		let lastCreateError: unknown = null;
		for (let attempt = 0; attempt < 5 && created === null; attempt++) {
			try {
				created = (await ctx.runMutation(internal.files_nodes.create_file_node, {
					userId: users_SYSTEM_AUTHOR,
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: args.workspaceId,
					parentId: files_ROOT_ID,
					path: args.path,
					assetId,
					contentType: "text/plain;charset=utf-8" satisfies files_ContentType,
					textContent: args.rawText,
					readOnly: true,
					mountId: args.mountId,
					syncRunId: args.syncRunId,
				})) as create_file_node_Result;
			} catch (error) {
				lastCreateError = error;
			}
		}
		if (created === null) {
			await ctx.runMutation(internal.files_nodes.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			console.error("Failed to create external source file node after retries", {
				error: lastCreateError,
				path: args.path,
			});
			return Result({ _nay: { message: "Failed to create external source file node" } });
		}
		if (created._nay) {
			await ctx.runMutation(internal.files_nodes.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			return created;
		}

		const createdNodeId = created._yay?.nodeId;
		if (!createdNodeId) {
			await ctx.runMutation(internal.files_nodes.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			return Result({ _nay: { message: "Failed to create external source file node" } });
		}

		// Set r2Key + size on the content asset. The node already points at this asset.
		await ctx.runMutation(internal.r2.patch_asset, {
			assetId,
			r2Key,
			size: byteSize,
		});

		return Result({ _yay: { nodeId: createdNodeId } });
	},
});

type create_file_node_Result =
	typeof create_file_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export type files_nodes_create_file_node_internal_Result =
	typeof create_file_node_internal extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type action_create_markdown_node_Result =
	| {
			_yay: {
				nodeId: Id<"files_nodes">;
				createdCommittedSequence?: number;
				createdAncestorIds: Id<"files_nodes">[];
			};
			_nay?: undefined;
	  }
	| {
			_nay: {
				name?: string;
				message: string;
				cause?: unknown;
				data?: unknown;
				stack?: string;
			};
			_yay?: undefined;
	  };

async function action_create_markdown_node(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		markdownContent: string;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	},
): Promise<action_create_markdown_node_Result> {
	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(args.markdownContent);
	if (snapshotUpdate._nay) {
		return snapshotUpdate;
	}

	const [yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "yjs_snapshot",
			size: snapshotUpdate._yay.byteLength,
			createdBy: args.userId,
		}),
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(args.markdownContent),
			createdBy: args.userId,
		}),
	])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

	const yjsSnapshotR2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: yjsSnapshotAssetId,
	});
	const versionSnapshotR2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: versionSnapshotAssetId,
	});

	const assetIds = [yjsSnapshotAssetId, versionSnapshotAssetId];
	const cleanupCreatedAssets = async () => {
		await ctx.runMutation(internal.files_nodes.cleanup_file_node_creation_assets, {
			assetIds,
			r2Keys: [yjsSnapshotR2Key, versionSnapshotR2Key],
		});
	};

	// Editable files do not store their current content in R2. Reads use the committed chunks.
	// We only upload the Yjs snapshot and the first version snapshot. The node points at the
	// version snapshot: the newest snapshot always holds the file's current bytes.
	try {
		await Promise.all([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: args.markdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);
	} catch (error) {
		await cleanupCreatedAssets();
		console.error("Failed to write initial Markdown file assets", {
			error,
			yjsSnapshotAssetId,
			versionSnapshotAssetId,
		});
		return Result({ _nay: { message: "Failed to create file" } });
	}

	const created = (await ctx.runMutation(internal.files_nodes.create_file_node, {
		userId: args.userId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		path: args.path,
		contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		assetId: versionSnapshotAssetId,
		yjsSnapshotAssetId,
		textContent: args.markdownContent,
		readOnly: false,
		archiveOperationId: args.archiveOperationId,
	})) as create_file_node_Result;
	if (created._nay) {
		await cleanupCreatedAssets();
		return created;
	}

	await ctx.runMutation(internal.files_nodes.finalize_markdown_node_creation, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: created._yay.nodeId,
		userId: args.userId,
		yjsSnapshotAssetId,
		yjsSnapshotSize: snapshotUpdate._yay.byteLength,
		versionSnapshotAssetId,
		versionSnapshotSize: files_get_utf8_byte_size(args.markdownContent),
	});

	return Result({
		_yay: {
			nodeId: created._yay.nodeId,
			createdCommittedSequence: created._yay.createdCommittedSequence,
			createdAncestorIds: created._yay.createdAncestorIds,
		},
	});
}

export const create_markdown_node = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
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

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const created = await action_create_markdown_node(ctx, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			markdownContent: files_INITIAL_CONTENT,
			path: args.path,
		});
		if (created._nay) {
			return created;
		}

		// The creation-time sequence capture is internal plumbing; keep the public shape.
		return Result({ _yay: { nodeId: created._yay.nodeId } });
	},
});

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
		if (existingNode) {
			if (existingNode.kind !== "file") {
				return Result({
					_nay: {
						message: "The path cannot point to a folder",
					},
				});
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
		userId: string | null;
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
	if (args.userId != null) {
		const pendingUpdates = await files_db_list_pending_updates_for_user(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
		});
		if (pendingUpdates.some((pendingUpdate) => pendingUpdate.pendingMove?.destParentId === args.folderId)) {
			return false;
		}
	}
	return true;
}

/**
 * Shared proposal-time + accept-time validation for a pending move: the node ids are
 * authoritative, so the same checks run when the proposal is created and when it is applied.
 */
export async function files_nodes_db_validate_pending_move_target(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		destName: string;
		/**
		 * Replace opt-in: file-onto-file, or folder-onto-EMPTY-folder (rename() semantics).
		 * `"any-active-occupant"` (proposal-time `mv -f`/`mv -T`, and accept) accepts whichever
		 * active node owns the destination; a node id requires the destination to still be
		 * exactly that node.
		 */
		replaceTarget?: Id<"files_nodes"> | "any-active-occupant";
		/**
		 * Proposal-time only: validate against this user's visible tree. A committed sibling with
		 * a pending move away does not conflict, and a destination already claimed by another
		 * pending move is rejected. Accept-time callers leave this unset (committed tree).
		 */
		overlayUserId?: Id<"users">;
		/**
		 * Accept-time only: the accepting user's id. An occupant that vacates through this
		 * user's own pending move is returned as `replacesNode` even when it is not
		 * file-replaceable, so the caller can apply a swap cycle or ask to accept the
		 * occupant's move first.
		 */
		acceptUserId?: string;
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

	let overlay: files_PendingPathOverlay | null = null;
	if (args.overlayUserId != null) {
		overlay = await files_db_build_pending_path_overlay(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.overlayUserId,
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
			overlay != null &&
			(overlay.hiddenNodeIds.has(activeSiblingConflict._id) ||
				overlay.moves.some((move) => move.nodeId === activeSiblingConflict._id));
		if (!siblingInvisible) {
			const replaceRequested =
				args.replaceTarget != null &&
				(args.replaceTarget === "any-active-occupant" || activeSiblingConflict._id === args.replaceTarget);
			if (replaceRequested && node.kind === "file" && activeSiblingConflict.kind === "file") {
				return Result({ _yay: { node, destParentPath, destPath, replacesNode: activeSiblingConflict } });
			}
			// rename() semantics: a folder replaces an EMPTY folder; a non-empty one errors
			// "Directory not empty" below. File-onto-folder and folder-onto-file never replace.
			const folderReplaceRequested =
				replaceRequested && node.kind === "folder" && activeSiblingConflict.kind === "folder";
			if (
				folderReplaceRequested &&
				(await db_folder_occupant_is_empty(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					folderId: activeSiblingConflict._id,
					userId: args.overlayUserId ?? args.acceptUserId ?? null,
				}))
			) {
				return Result({ _yay: { node, destParentPath, destPath, replacesNode: activeSiblingConflict } });
			}
			// A non-replaceable occupant that vacates through the accepting user's own pending
			// move is still returned: the caller applies a swap cycle or asks to accept it first.
			if (args.acceptUserId != null) {
				const occupantPendingUpdate = await files_db_get_pending_update(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.acceptUserId,
					nodeId: activeSiblingConflict._id,
				});
				if (occupantPendingUpdate?.pendingMove) {
					return Result({ _yay: { node, destParentPath, destPath, replacesNode: activeSiblingConflict } });
				}
			}
			return Result({
				_nay: { message: folderReplaceRequested ? "Directory not empty" : "Path already exists" },
			});
		}
	}

	return Result({ _yay: { node, destParentPath, destPath, replacesNode: null } });
}

/** Patch one node to its destination and fan out the denormalized paths (chunk scope, descendants). */
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

	// The pending move claims its destination: a file or EMPTY folder occupying it at accept
	// time is auto-replaced like rename(). A non-empty folder occupant fails validation unless
	// it vacates through this user's own pending move (swap cycles and chained accepts).
	const validated = await files_nodes_db_validate_pending_move_target(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
		replaceTarget: "any-active-occupant",
		acceptUserId: args.userId,
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

			for (const descendantFileNode of descendantFileNodes) {
				if (descendantFileNode.archiveOperationId !== undefined) {
					continue;
				}
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
							conflictingNodeId: conflictedCurrentFileNode._id,
							conflictingFilePath: conflictedCurrentFileNode.path,
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
											conflictingNodeId: conflictedAncestorFileNode._id,
											conflictingFilePath: conflictedAncestorFileNode.path,
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
							conflictingNodeId: conflictFileNode._id,
							conflictingFilePath: conflictFileNode.path,
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

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization?.defaultWorkspaceId) {
			return null;
		}

		const hasAssetRead = await access_control_db_has_permission(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resourceKind: "workspace",
			resourceId: String(membership.workspaceId),
			permission: "asset.read",
			userId: userAuth.id,
		});
		if (!hasAssetRead) {
			return null;
		}

		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		if (!fileNodeId) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", fileNodeId).then((fileNode) => {
			if (
				!fileNode ||
				fileNode.organizationId !== membership.organizationId ||
				fileNode.workspaceId !== membership.workspaceId
			) {
				return null;
			}

			return fileNode;
		});
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
	returns: v.array(
		v.object({
			_id: v.id("files_nodes"),
			_creationTime: v.number(),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			path: v.string(),
			treePath: v.string(),
			pathDepth: v.number(),
			lowercaseExtension: v.union(v.string(), v.null()),
			name: v.string(),
			kind: doc(app_convex_schema, "files_nodes").fields.kind,
			contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
			statsId: doc(app_convex_schema, "files_nodes").fields.statsId,
			yjsLastSequenceId: doc(app_convex_schema, "files_nodes").fields.yjsLastSequenceId,
			yjsSnapshotId: doc(app_convex_schema, "files_nodes").fields.yjsSnapshotId,
			assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
			archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
			parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
			updatedAt: v.number(),
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

		const fileNodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.order("asc")
			.collect();

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
		numItems: number;
		cursor: string | null;
		parentId?: Id<"files_nodes"> | typeof files_ROOT_ID;
		orderBy: "name" | "updatedAt";
		order?: "asc" | "desc";
	},
) {
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
			items: result.page.map((fileNode) => ({
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
		items: result.page.map((fileNode) => ({
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
		return await filteredQuery.paginate({
			cursor: args.cursor,
			numItems: args.numItems,
			...(minAbsoluteDepth == null && maxAbsoluteDepth == null
				? {}
				: { maximumRowsRead: SUBTREE_FILTER_MAX_ROWS_READ }),
		});
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

		return {
			items: result.page.map((fileNode) => ({
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

function matches_path(absPath: string, include: string | undefined) {
	return include ? minimatch(absPath, include) : true;
}

export const list_files = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
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
		// TODO: when truncating, we truncate the total docs but we don't tell the LLM if we truncated in depth
		const startNodeId = await db_resolve_tree_node_id_from_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
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
		const limit = Math.max(1, Math.min(20, args.limit));
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
						.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", frame.parentId)
								.eq("archiveOperationId", undefined),
						)
						[Symbol.asyncIterator]();
				// Keep the iterator on the frame immediately so file children and
				// non-matching children do not restart sibling traversal from the first doc.
				frame.iterator = iterator;

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

export const get_file_markdown_content_db_state_by_path = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		includePending: v.optional(v.boolean()),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		/**
		 * Max byte size for merging the committed chunks below. If the file is bigger, we skip the
		 * merge and return no `content`, so the caller can reject using `asset.size` without
		 * loading the file body.
		 */
		maxBytes: v.optional(v.number()),
	},
	returns: v.union(
		v.object({
			content: v.optional(v.string()),
			asset: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
			nodeId: v.id("files_nodes"),
			displayNodeId: v.id("files_nodes"),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
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

		// External (reserved) scope: no Yjs/pending/materialization. Read the linked R2 content asset
		// directly and leave `content` undefined so `get_file_last_available_markdown_content_by_path`
		// falls into its raw-R2 `.text()` branch.
		if (
			organizations_is_global_organization_id(args.organizationId) ||
			organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const asset = fileNode.assetId
				? await ctx.db
						.get("files_r2_assets", fileNode.assetId)
						.then((asset) =>
							asset && asset.organizationId === args.organizationId && asset.workspaceId === args.workspaceId
								? asset
								: null,
						)
				: null;
			return {
				asset,
				nodeId: fileNode._id,
				displayNodeId: fileNode._id,
				pendingUpdateId: null,
				materializationState: null,
			};
		}

		if (!files_node_has_editable_yjs_state(fileNode)) return null;

		// Tenant scope (the guards above narrowed both ids to real ids): bind them so the narrowing
		// also reaches the `withIndex` callbacks — TS drops property narrowing at closure boundaries.
		const organizationId = args.organizationId;
		const workspaceId = args.workspaceId;

		const pendingUpdateById =
			args.includePending === false
				? null
				: args.pendingUpdateId
					? await ctx.db.get("files_pending_updates", args.pendingUpdateId)
					: null;
		const pendingUpdate =
			args.includePending === false
				? null
				: pendingUpdateById &&
					  pendingUpdateById.organizationId === organizationId &&
					  pendingUpdateById.workspaceId === workspaceId &&
					  pendingUpdateById.userId === args.userId &&
					  pendingUpdateById.fileNodeId === fileNode._id
					? pendingUpdateById
					: await ctx.db
							.query("files_pending_updates")
							.withIndex("by_organization_workspace_user_fileNode", (q) =>
								q
									.eq("organizationId", organizationId)
									.eq("workspaceId", workspaceId)
									.eq("userId", args.userId)
									.eq("fileNodeId", fileNode._id),
							)
							.first();
		// Move-only docs carry no content; keep returning their `pendingUpdateId` below so
		// write_file/edit_file mix onto them, while content resolves from the committed tree.
		const pendingUpdateContent = pendingUpdate ? files_pending_update_content_of(pendingUpdate) : null;
		if (pendingUpdate && pendingUpdateContent) {
			// Rebuild the pending branch from its recorded base so readers see the same document
			// the pending-update save/rebase flow will later persist.
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdateContent.baseYjsUpdate, {
				additionalIncrementalArrayBufferUpdates: [pendingUpdateContent.unstagedBranchYjsUpdate],
			});

			const markdown = files_yjs_doc_get_markdown({ yjsDoc });
			if (markdown._yay !== undefined) {
				return {
					content: markdown._yay,
					asset: null,
					nodeId: fileNode._id,
					displayNodeId: fileNode._id,
					pendingUpdateId: pendingUpdate._id,
					materializationState: null,
				};
			}

			console.error("Failed to reconstruct markdown from files_pending_updates", {
				nay: markdown._nay,
				nodeId: fileNode._id,
			});
		}

		const asset = fileNode.assetId
			? await ctx.db
					.get("files_r2_assets", fileNode.assetId)
					.then((asset) =>
						asset && asset.organizationId === organizationId && asset.workspaceId === workspaceId ? asset : null,
					)
			: null;

		const materializationState = pendingUpdateContent
			? null
			: await db_get_file_content_materialization_db_state(ctx, {
					organizationId,
					workspaceId,
					nodeId: fileNode._id,
				});

		// Editable files do not store their current content in R2. Reads use the committed
		// chunks. Merge the chunks here, except in two cases: the Yjs log is newer than the
		// snapshot (the caller rebuilds the content from Yjs), or the content is bigger than the
		// caller's byte cap.
		if (
			(!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence <= materializationState.yjsSnapshotDoc.sequence) &&
			asset &&
			(args.maxBytes === undefined || asset.size <= args.maxBytes)
		) {
			const chunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id),
				)
				.collect();
			const committedContent = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
			if (committedContent != null) {
				return {
					content: committedContent,
					asset: null,
					nodeId: fileNode._id,
					displayNodeId: fileNode._id,
					pendingUpdateId: pendingUpdate?._id ?? null,
					materializationState: null,
				};
			}
		}

		return {
			asset,
			nodeId: fileNode._id,
			displayNodeId: fileNode._id,
			pendingUpdateId: pendingUpdate?._id ?? null,
			materializationState,
		};
	},
});

type get_file_markdown_content_db_state_by_path_Result =
	typeof get_file_markdown_content_db_state_by_path extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

type get_file_last_available_markdown_content_by_path_Result = {
	content: string;
	nodeId: Id<"files_nodes">;
	displayNodeId: Id<"files_nodes">;
	pendingUpdateId: Id<"files_pending_updates"> | null;
} | null;

export const get_file_last_available_markdown_content_by_path = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		includePending: v.optional(v.boolean()),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		maxBytes: v.optional(v.number()),
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
	handler: async (ctx, args): Promise<get_file_last_available_markdown_content_by_path_Result> => {
		const contentState = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			includePending: args.includePending,
			overlayUserId: args.overlayUserId,
			maxBytes: args.maxBytes,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!contentState) {
			return null;
		}

		const maxBytes = args.maxBytes;
		const content_exceeds_max_bytes = (content: string) =>
			maxBytes !== undefined && files_get_utf8_byte_size(content) > maxBytes;
		const materializationState = contentState.materializationState;
		let content: string;
		if (contentState.content !== undefined) {
			content = contentState.content;
		} else if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			if (maxBytes !== undefined && materializationState.asset.size > maxBytes) {
				return null;
			}

			content = await files_nodes_reconstruct_latest_file_content_from_materialization_state({ state: materializationState }).then(
				(reconstructed) => {
					if (reconstructed._nay) {
						throw convex_error({
							message: "Failed to reconstruct latest file content",
							cause: reconstructed._nay,
						});
					}

					return reconstructed._yay.markdown;
				},
			);
		} else {
			const asset = contentState.asset;
			if (maxBytes !== undefined && asset && asset.size > maxBytes) {
				return null;
			}

			content = asset?.r2Key
				? await r2_fetch_object_from_bucket({ key: asset.r2Key }).then((response) => response.text())
				: "";
		}

		if (content_exceeds_max_bytes(content)) {
			return null;
		}

		return {
			content,
			nodeId: contentState.nodeId,
			displayNodeId: contentState.displayNodeId,
			pendingUpdateId: contentState.pendingUpdateId,
		};
	},
});

export type files_nodes_get_file_last_available_markdown_content_by_path_Result =
	typeof get_file_last_available_markdown_content_by_path extends RegisteredAction<
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
const files_READ_RANGE_SCAN_MAX_BYTES = 8 * 1024;
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
 * Compute `wc` counts for a full text in one pass: lineCount = newline count (`wc -l`), wordCount =
 * whitespace-delimited words (`wc -w`), charCount = Unicode code points (`wc -m`, not UTF-16 units,
 * so emoji/astral chars count as one). Used both at materialization (to store exact counts on the
 * node) and on the windowed fallback (lower-bound counts for unmaterialized content), so the two
 * paths share identical semantics. Allocation-free except the word split.
 */
function files_compute_wc_counts(text: string) {
	let lineCount = 0;
	let charCount = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 10) lineCount++; // "\n"
		// Skip the trailing half of a surrogate pair so the pair counts as one code point.
		if (code < 0xdc00 || code > 0xdfff) charCount++;
	}
	const trimmed = text.trim();
	const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
	return { lineCount, wordCount, charCount };
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

async function files_resolve_readable_content_or_window(
	ctx: ActionCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		path: string;
		pendingUpdateId?: Id<"files_pending_updates">;
		overlayUserId?: Id<"users">;
	},
): Promise<{ nodeId: Id<"files_nodes">; text: string; fetchedAllBytes: boolean; totalBytes: number } | null> {
	const state = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		path: args.path,
		pendingUpdateId: args.pendingUpdateId,
		overlayUserId: args.overlayUserId,
	})) as get_file_markdown_content_db_state_by_path_Result;
	if (!state) {
		return null;
	}
	const materializationState = state.materializationState;
	// Pending user edit, or stale snapshot: full content is (or must be) in memory.
	if (state.content !== undefined) {
		return {
			nodeId: state.nodeId,
			text: state.content,
			fetchedAllBytes: true,
			totalBytes: files_get_utf8_byte_size(state.content),
		};
	}
	if (
		materializationState &&
		materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
	) {
		const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: materializationState,
		});
		if (reconstructed._nay) {
			throw convex_error({ message: "Failed to reconstruct latest file content", cause: reconstructed._nay });
		}
		return {
			nodeId: state.nodeId,
			text: reconstructed._yay.markdown,
			fetchedAllBytes: true,
			totalBytes: files_get_utf8_byte_size(reconstructed._yay.markdown),
		};
	}
	// Committed and up to date: bounded byte-range read of the content object (leading window).
	const asset = state.asset;
	if (!asset?.r2Key) {
		return { nodeId: state.nodeId, text: "", fetchedAllBytes: true, totalBytes: 0 };
	}
	const totalBytes = asset.size;
	const endInclusive = Math.max(0, Math.min(files_READ_RANGE_SCAN_MAX_BYTES, totalBytes) - 1);
	const response = await r2_fetch_object_range_from_bucket({ key: asset.r2Key, start: 0, endInclusive });
	const bytes = new Uint8Array(await response.arrayBuffer());
	const text = new TextDecoder("utf-8").decode(bytes);
	return { nodeId: state.nodeId, text, fetchedAllBytes: bytes.byteLength >= totalBytes, totalBytes };
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
function files_merge_contiguous_chunks(
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

/**
 * Read a line range of a file without pulling the whole thing. The chunk query handles the latest
 * user-visible chunk source: pending chunks first, then committed chunks when the materialized
 * snapshot is current. Unmaterialized/stale content falls back to a slice of the in-memory
 * reconstruction, or a single bounded R2 byte-range read (a leading window capped at
 * `files_READ_RANGE_SCAN_MAX_BYTES`) for committed-but-window-only fallbacks. Backs `head -n N`
 * (startLine 1) and `sed -n 'A,Bp'` (startLine A). `scanTruncated` is only ever true on the
 * windowed fallback path.
 */
export const read_file_line_range = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		startLine: v.number(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			moreLines: v.boolean(),
			scanTruncated: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const startLine = Math.max(1, Math.trunc(args.startLine));
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
		const chunked = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
			mode: {
				kind: "lines",
				startLine,
				maxLines,
			},
		})) as files_nodes_read_file_content_from_chunks_Result;
		if (chunked) {
			return {
				nodeId: chunked.nodeId,
				content: chunked.content,
				moreLines: chunked.moreLines,
				scanTruncated: false,
			};
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded leading R2 window.
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		const range = files_line_range_from_text(resolved.text, startLine, maxLines);
		// Stopped on the byte window (not line count / EOF): output may be partial.
		const scanTruncated = !resolved.fetchedAllBytes && range.linesReturned < maxLines;
		return {
			nodeId: resolved.nodeId,
			content: range.content,
			moreLines: range.moreLines || !resolved.fetchedAllBytes,
			scanTruncated,
		};
	},
});

export type files_nodes_read_file_line_range_Result =
	typeof read_file_line_range extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Read the last `maxLines` lines of a file. For committed content this reads a bounded
 * trailing byte window via an R2 range request (so the file is not pulled in full); for
 * pending/unmaterialized content it slices the in-memory reconstruction. Backs `tail -n N`.
 */
export const read_file_tail_lines = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			// True when lines precede the returned tail (the view is a partial end-of-file window).
			moreLines: v.boolean(),
			scanTruncated: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
		// Committed-current content: read the trailing lines from the last materialized chunks.
		const chunked = (await ctx.runQuery(internal.files_nodes.read_committed_file_chunks_line_range, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			startLine: 1,
			maxLines,
			fromEnd: true,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as files_nodes_read_committed_file_chunks_line_range_Result;
		if (chunked.usable) {
			return { nodeId: chunked.nodeId, content: chunked.content, moreLines: chunked.moreLines, scanTruncated: false };
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded trailing R2 window.
		const state = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!state) {
			return null;
		}
		const materializationState = state.materializationState;

		// Pending/stale: full content in memory.
		if (state.content !== undefined) {
			const tail = files_tail_lines_from_text(state.content, maxLines);
			return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove, scanTruncated: false };
		}
		if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
				state: materializationState,
			});
			if (reconstructed._nay) {
				throw convex_error({ message: "Failed to reconstruct latest file content", cause: reconstructed._nay });
			}
			const tail = files_tail_lines_from_text(reconstructed._yay.markdown, maxLines);
			return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove, scanTruncated: false };
		}

		// Committed: read a bounded trailing window from the end of the R2 object.
		const asset = state.asset;
		if (!asset?.r2Key) {
			return { nodeId: state.nodeId, content: "", moreLines: false, scanTruncated: false };
		}
		const totalBytes = asset.size;
		const start = Math.max(0, totalBytes - files_READ_RANGE_SCAN_MAX_BYTES);
		const response = await r2_fetch_object_range_from_bucket({ key: asset.r2Key, start, endInclusive: totalBytes - 1 });
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = new TextDecoder("utf-8").decode(bytes);
		const tail = files_tail_lines_from_text(text, maxLines);
		// If the trailing window didn't reach the start of the file, the earliest returned line
		// could be partial — only relevant for files larger than the scan window.
		const scanTruncated = start > 0;
		return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove || start > 0, scanTruncated };
	},
});

export type files_nodes_read_file_tail_lines_Result =
	typeof read_file_tail_lines extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Line/word/char/byte counts for a file without a guaranteed full read. `byteCount` is the
 * true size; line/word/char counts come from a bounded leading window, so `exact` is false
 * when the file is larger than the scan window (counts are then lower bounds). Backs `wc` on
 * large files so the agent learns a file's size (e.g. line count) instead of over-paging.
 */
export const read_file_content_stats = internalAction({
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
		v.object({
			nodeId: v.id("files_nodes"),
			lineCount: v.number(),
			wordCount: v.number(),
			charCount: v.number(),
			byteCount: v.number(),
			exact: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Committed-current content: count exactly from the materialized chunks (the verbatim document).
		const chunked = (await ctx.runQuery(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as files_nodes_read_committed_file_chunk_stats_Result;
		if (chunked.usable) {
			return {
				nodeId: chunked.nodeId,
				lineCount: chunked.lineCount,
				wordCount: chunked.wordCount,
				charCount: chunked.charCount,
				byteCount: chunked.byteCount,
				exact: true,
			};
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded leading R2 window (counts
		// are then lower bounds, flagged via `exact: false`).
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		// Same wc semantics as the materialized path, but on a possibly-partial window (lower bounds).
		const counts = files_compute_wc_counts(resolved.text);
		return {
			nodeId: resolved.nodeId,
			lineCount: counts.lineCount,
			wordCount: counts.wordCount,
			charCount: counts.charCount,
			byteCount: resolved.totalBytes,
			exact: resolved.fetchedAllBytes,
		};
	},
});

export type files_nodes_read_file_content_stats_Result =
	typeof read_file_content_stats extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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

		const items = result.page.map((searchChunk) => ({
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

/**
 * Create a Markdown file at a trusted path.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_file_by_path = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		markdownContent: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			nodeId: v.id("files_nodes"),
			created: v.boolean(),
			/**
			 * The node's committed Yjs last sequence, captured in the mutation that created the
			 * node. Eager-create callers pass it to the pending-update upsert as the immutable
			 * `eagerCreated.committedSequence` stamp. Only set when `created` is true.
			 */
			createdCommittedSequence: v.optional(v.number()),
			/**
			 * `_id`s of the intermediate folders created for this path (reused folders are
			 * skipped), ordered deepest first; empty when no folder was created. Eager-create
			 * callers hand them to `remove_eager_created_node_if_safe` so a failed proposal
			 * upsert also removes the folders it committed.
			 */
			createdAncestorIds: v.array(v.id("files_nodes")),
		}),
	}),
	handler: async (ctx, args) => {
		const activeFileNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
		})) as Doc<"files_nodes"> | null;
		if (activeFileNode?.kind === "file") {
			// `created: false` marks a pre-existing file. Callers that need a fresh node (e.g.
			// pending-copy destinations, which are later hard-deleted) must treat this as a conflict.
			return Result({ _yay: { nodeId: activeFileNode._id, created: false, createdAncestorIds: [] } });
		}

		const created = await action_create_markdown_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			markdownContent: args.markdownContent ?? "",
		});
		if (created._nay) {
			return created;
		}

		return Result({
			_yay: {
				nodeId: created._yay.nodeId,
				created: true,
				createdCommittedSequence: created._yay.createdCommittedSequence,
				createdAncestorIds: created._yay.createdAncestorIds,
			},
		});
	},
});

export type files_nodes_create_file_by_path_Result =
	typeof create_file_by_path extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #region home file

/**
 * Seeds the initial README.md for a freshly created workspace. Scheduled from the
 * workspace-creation mutations; after that the file is a normal file (rename, move,
 * archive all work on it).
 */
export const create_home_file = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const result = await action_create_markdown_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: "README.md" satisfies files_SpecialFileName,
			// Keep the auto-created home file consistent with user-created Markdown files.
			markdownContent: files_INITIAL_CONTENT,
		});
		if (result._nay) {
			console.error("[files_nodes.create_home_file] Failed to create home file", { result, args });
		}
		return null;
	},
});

// #endregion home file

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

async function db_get_file_snapshot_content(
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

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
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

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
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

async function yjs_increment_or_create_last_sequence(
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

	const snapshotScheduleDelayMs =
		newSequenceData.lastSequence > 0 && newSequenceData.lastSequence % 50 === 0 ? 0 : 30_000;

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

const store_version_snapshot_args_schema = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	nodeId: v.id("files_nodes"),
	assetId: v.id("files_r2_assets"),
	userId: v.id("users"),
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return files_u8_to_array_buffer(mergeUpdates(updates));
}

async function db_insert_snapshot_restore_update(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
		restoreUpdate: ArrayBuffer;
	},
) {
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
		update: args.restoreUpdate,
		origin: {
			type: "USER_SNAPSHOT_RESTORE",
			snapshotId: args.snapshotId,
		},
		createdBy: args.userId,
		createdAt: Date.now(),
	});

	await enqueue_file_content_materialization(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		userId: args.userId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: 0,
	});

	return newSequenceData.lastSequence;
}

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	const snapshotId = await ctx.db.insert("files_snapshots", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		assetId: args.assetId,
		createdBy: args.userId,
		archivedAt: -1,
	});

	return snapshotId;
}

export async function files_nodes_reconstruct_latest_file_content_from_materialization_state(args: {
	state: NonNullable<get_file_content_materialization_state_Result>;
}) {
	if (!args.state.yjsSnapshotAsset.r2Key) {
		const errorMessage = "yjsSnapshotAsset.r2Key is not set";
		const errorData = {
			nodeId: args.state.fileNode._id,
			assetId: args.state.yjsSnapshotAsset._id,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: args.state.yjsSnapshotAsset.r2Key }).then(
		(response) => response.arrayBuffer(),
	);
	const updatesAfterSnapshot = args.state.yjsUpdatesDocs.filter(
		(update) => update.sequence > args.state.yjsSnapshotDoc.sequence,
	);
	const snapshotUpdate = yjs_merge_updates_to_array_buffer([
		new Uint8Array(baseSnapshotUpdate),
		...updatesAfterSnapshot.map((update) => new Uint8Array(update.update)),
	]);

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
	const markdown = files_yjs_doc_get_markdown({ yjsDoc });

	if (markdown._nay) {
		return markdown;
	}

	return Result({
		_yay: {
			yjsDoc,
			markdown: markdown._yay,
			snapshotUpdate,
			sequence: args.state.yjsLastSequenceDoc.lastSequence,
		},
	});
}

/**
 * Replace the current content of an editable Markdown file in place, keeping the same nodeId.
 * The caller has already validated the node (editable, same scope) and PUT the new content bytes
 * at the content snapshot asset's deterministic key. `fillUpdate` is a Yjs diff update computed
 * against the doc state the caller reconstructed; open editors apply it as a remote change.
 * The caller omits it when the diff is empty (the new content equals the current content).
 */
export async function files_nodes_db_fill_markdown_node_content(
	ctx: MutationCtx,
	args: {
		// Editable files only exist in real tenant scopes, so the caller passes the already
		// scope-checked ids instead of the node's wider reserved-scope union fields.
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		fileNode: Doc<"files_nodes"> & {
			assetId: NonNullable<Doc<"files_nodes">["assetId"]>;
			yjsSnapshotId: NonNullable<Doc<"files_nodes">["yjsSnapshotId"]>;
			yjsLastSequenceId: NonNullable<Doc<"files_nodes">["yjsLastSequenceId"]>;
		};
		userId: Id<"users">;
		markdownContent: string;
		contentSnapshotAssetId: Id<"files_r2_assets">;
		contentSize: number;
		fillUpdate?: ArrayBuffer;
	},
) {
	const now = Date.now();
	const { organizationId, workspaceId } = args;

	await Promise.all([
		ctx.db.patch("files_r2_assets", args.contentSnapshotAssetId, {
			r2Key: r2_create_asset_key({ organizationId, workspaceId, assetId: args.contentSnapshotAssetId }),
			size: args.contentSize,
			updatedAt: now,
		}),
		// Store the new content as a version snapshot and point the node at it: the newest
		// snapshot always holds the file's current bytes.
		store_version_snapshot(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
			assetId: args.contentSnapshotAssetId,
			userId: args.userId,
		}),
		ctx.db.patch("files_nodes", args.fileNode._id, {
			assetId: args.contentSnapshotAssetId,
			updatedBy: args.userId,
			updatedAt: now,
		}),
	]);

	let yjsSequence: number;
	if (args.fillUpdate) {
		const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
		});
		await ctx.db.insert("files_yjs_updates", {
			organizationId,
			workspaceId,
			fileNodeId: args.fileNode._id,
			sequence: newSequenceData.lastSequence,
			update: args.fillUpdate,
			// Non-user origin so open editor sessions apply the update as a remote change.
			origin: { type: "USER_AI_EDIT" },
			createdBy: args.userId,
			createdAt: now,
		});
		await enqueue_file_content_materialization(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
			userId: args.userId,
			targetSequence: newSequenceData.lastSequence,
			delayMs: 0,
		});
		yjsSequence = newSequenceData.lastSequence;
	} else {
		const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", args.fileNode.yjsLastSequenceId);
		if (!yjsLastSequenceDoc) {
			const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
			const errorData = {
				fileNodeId: args.fileNode._id,
				yjsLastSequenceId: args.fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		yjsSequence = yjsLastSequenceDoc.lastSequence;
	}

	return await db_replace_file_chunks(ctx, {
		organizationId,
		workspaceId,
		nodeId: args.fileNode._id,
		yjsSequence,
		markdownContent: args.markdownContent,
	});
}

export const finalize_file_content_materialization = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		sequence: v.number(),
		targetSequence: v.number(),
		markdown: v.string(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotSize: v.number(),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to materialize file content"),
			}),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return Result({ _yay: null });
		}

		if (state.yjsLastSequenceDoc.lastSequence !== args.sequence || args.sequence !== args.targetSequence) {
			return Result({ _yay: null });
		}

		const now = Date.now();

		const dbWriteResult = Result_all(
			await Promise.all([
				// Point the node at the new version snapshot. It now holds the file's current
				// bytes, so downloads sign it and reads use its size as the byte cap.
				ctx.db.patch("files_nodes", args.nodeId, {
					assetId: args.versionSnapshotAssetId,
				}),
				ctx.db.patch("files_r2_assets", state.yjsSnapshotAsset._id, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: state.yjsSnapshotAsset._id,
					}),
					size: args.yjsSnapshotSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: args.versionSnapshotAssetId,
					}),
					size: args.markdownSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_yjs_snapshots", state.yjsSnapshotDoc._id, {
					sequence: args.sequence,
					updatedBy: users_SYSTEM_AUTHOR,
					updatedAt: now,
				}),
				...state.yjsUpdatesDocs
					.filter((updateData) => updateData.sequence <= args.sequence)
					.map((updateData) => ctx.db.delete("files_yjs_updates", updateData._id)),
				db_replace_file_chunks(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: args.sequence,
					markdownContent: args.markdown,
				}),
				store_version_snapshot(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					assetId: args.versionSnapshotAssetId,
					userId: args.userId,
				}),
				ctx.db
					.query("files_content_materialization_jobs")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
					.collect()
					.then((jobs) =>
						Promise.all(
							jobs
								.filter((job) => job.targetSequence <= args.targetSequence)
								.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
						),
					),
			]),
		);

		if (dbWriteResult._nay) {
			const errorMessage = "Failed to materialize file content" satisfies NonNullable<
				(typeof args)["_errors"]
			>["message"];
			console.error(errorMessage, {
				dbWriteResult,
			});
			return Result({
				_nay: {
					name: "nay",
					message: errorMessage,
				},
			});
		}

		return Result({ _yay: null });
	},
});

type finalize_file_content_materialization_Result =
	typeof finalize_file_content_materialization extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const materialize_file_content = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		targetSequence: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return Result({ _yay: null });
		}

		const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({ state });
		if (reconstructed._nay) {
			return reconstructed;
		}

		const sequence = reconstructed._yay.sequence;
		const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(reconstructed._yay.markdown),
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;

		if (!state.yjsSnapshotAsset.r2Key) {
			const errorMessage = "materialization yjsSnapshotAsset r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				yjsSnapshotAssetId: state.yjsSnapshotAsset._id,
				versionSnapshotAssetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		// The current markdown lives in the committed chunk tables, not in R2. So we only upload
		// the Yjs snapshot and the new version snapshot here.
		await Promise.all([
			r2_put_object(ctx, {
				key: state.yjsSnapshotAsset.r2Key,
				body: reconstructed._yay.snapshotUpdate,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: reconstructed._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalizationResult = (await ctx.runMutation(internal.files_nodes.finalize_file_content_materialization, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			userId: args.userId,
			sequence,
			targetSequence: args.targetSequence,
			markdown: reconstructed._yay.markdown,
			versionSnapshotAssetId,
			markdownSize: files_get_utf8_byte_size(reconstructed._yay.markdown),
			yjsSnapshotSize: reconstructed._yay.snapshotUpdate.byteLength,
		})) as finalize_file_content_materialization_Result;
		if (finalizationResult._nay) {
			return finalizationResult;
		}

		return Result({ _yay: null });
	},
});

export const restore_snapshot = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
		snapshotMarkdownContent: v.string(),
		restoreUpdate: v.optional(v.bytes()),
		currentSnapshotAssetId: v.id("files_r2_assets"),
		currentSnapshotSize: v.number(),
		restoredSnapshotAssetId: v.id("files_r2_assets"),
		restoredSnapshotSize: v.number(),
		skipRateLimit: v.optional(v.boolean()),
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

		if (!args.skipRateLimit) {
			const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
			if (rateLimit) {
				return Result({ _nay: { message: rateLimit.message } });
			}
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const [snapshotContent, fileNode] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			ctx.db.get("files_nodes", args.nodeId).then((fileNode) => {
				if (
					!fileNode ||
					fileNode.organizationId !== membership.organizationId ||
					fileNode.workspaceId !== membership.workspaceId
				) {
					return null;
				}

				return fileNode;
			}),
		]);

		if (!snapshotContent || !files_node_has_editable_yjs_state(fileNode)) {
			return Result({
				_nay: {
					name: "nay",
					message: "Not found",
				},
			});
		}

		const userDoc = await ctx.db.get("users", userAuth.id);
		if (!userDoc) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: userAuth.id,
			organization,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = {
				userId: userAuth.id,
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

		const now = Date.now();
		const userId = userAuth.id;

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		const [, , , , , restoredYjsSequence] = await Promise.all([
			ctx.db.patch("files_r2_assets", args.currentSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.currentSnapshotAssetId,
				}),
				size: args.currentSnapshotSize,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.restoredSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.restoredSnapshotAssetId,
				}),
				size: args.restoredSnapshotSize,
				updatedAt: now,
			}),
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				assetId: args.currentSnapshotAssetId,
				userId,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				assetId: args.restoredSnapshotAssetId,
				userId,
			}),

			ctx.db.patch("files_nodes", fileNode._id, {
				// Point the node at the restored snapshot: it now holds the file's current bytes.
				// The queued materialization will later point it at its own fresh snapshot.
				assetId: args.restoredSnapshotAssetId,
				updatedBy: userId,
				updatedAt: now,
			}),

			args.restoreUpdate
				? db_insert_snapshot_restore_update(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId,
						nodeId: args.nodeId,
						snapshotId: args.snapshotId,
						restoreUpdate: args.restoreUpdate,
					})
				: Promise.resolve(null),
		]);

		const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		if (!yjsLastSequenceDoc) {
			const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
			const errorData = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
				yjsLastSequenceDoc,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const restoreFileResult = Result_all(
			await Promise.all([
				db_replace_file_chunks(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: yjsLastSequenceDoc.lastSequence,
					markdownContent: args.snapshotMarkdownContent,
				}),
			]),
		);

		if (restoreFileResult._nay) {
			const errorMessage = "Failed to restore file" satisfies NonNullable<(typeof args)["_errors"]>["message"];
			console.error(errorMessage, {
				restoreFileResult,
			});
			return Result({
				_nay: {
					name: "nay",
					message: errorMessage,
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
								membership.organizationId,
								membership.workspaceId,
								args.nodeId,
								restoredYjsSequence,
							),
							metadata: {
								amount: 1,
								actorUserId: userAuth.id,
								billedUserId: billedUser._id,
								organizationId: membership.organizationId,
								workspaceId: membership.workspaceId,
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

type restore_snapshot_Result =
	typeof restore_snapshot extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_restore_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			membership: doc(app_convex_schema, "organizations_workspaces_users"),
			snapshotContent: v.union(
				v.object({
					asset: doc(app_convex_schema, "files_r2_assets"),
					snapshotId: v.id("files_snapshots"),
					_creationTime: v.number(),
				}),
				v.null(),
			),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
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

		const [snapshotContent, materializationState] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			db_get_file_content_materialization_db_state(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			}),
		]);

		return {
			membership,
			snapshotContent,
			materializationState,
		};
	},
});

type get_data_for_restore_snapshot_Result =
	typeof get_data_for_restore_snapshot extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const restore_snapshot_r2 = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<restore_snapshot_Result> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_restore_snapshot, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		})) as get_data_for_restore_snapshot_Result;
		if (!data) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const { membership, snapshotContent, materializationState } = data;
		if (!snapshotContent) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}
		if (!materializationState) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return Result({
				_nay: {
					message: "Insufficient funds",
				},
			});
		}

		if (!snapshotContent.asset.r2Key) {
			const errorMessage = "snapshot.assetId points to an asset without r2Key";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				assetId: snapshotContent.asset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const snapshotMarkdownContent = await r2_fetch_object_from_bucket({ key: snapshotContent.asset.r2Key }).then(
			(response) => response.text(),
		);
		const currentContent = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: materializationState,
		});
		if (currentContent._nay) {
			console.error("Failed to reconstruct current file content", {
				nay: currentContent._nay,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			});
			return Result({ _nay: { name: "nay", message: "Failed to restore file" } });
		}
		const yjsBeforeStateVector = encodeStateVector(currentContent._yay.yjsDoc);
		const restoredYjsDocProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: currentContent._yay.yjsDoc,
			markdown: snapshotMarkdownContent,
		});
		if (restoredYjsDocProjection._nay) {
			console.error("Failed to workspace restored snapshot Markdown", {
				nay: restoredYjsDocProjection._nay,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			});
			return Result({ _nay: { name: "nay", message: "Failed to restore file" } });
		}
		const restoreUpdate = files_yjs_compute_diff_update_from_state_vector({
			yjsDoc: restoredYjsDocProjection._yay,
			yjsBeforeStateVector,
		});

		const [currentSnapshotAssetId, restoredSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(currentContent._yay.markdown),
				createdBy: userAuth.id,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(snapshotMarkdownContent),
				createdBy: userAuth.id,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

		const currentSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: currentSnapshotAssetId,
		});
		const restoredSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: restoredSnapshotAssetId,
		});

		// Editable files have no current-content object in R2. The restore mutation replaces the
		// committed chunks, and the queued materialization refreshes the Yjs snapshot. Only two
		// version snapshots go to R2: a backup of the current state, and the restored content.
		await Promise.all([
			r2_put_object(ctx, {
				key: currentSnapshotR2Key,
				body: currentContent._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: restoredSnapshotR2Key,
				body: snapshotMarkdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		return (await ctx.runMutation(internal.files_nodes.restore_snapshot, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
			sessionId: args.sessionId,
			snapshotMarkdownContent,
			restoreUpdate: restoreUpdate ? files_u8_to_array_buffer(restoreUpdate) : undefined,
			currentSnapshotAssetId,
			currentSnapshotSize: files_get_utf8_byte_size(currentContent._yay.markdown),
			restoredSnapshotAssetId,
			restoredSnapshotSize: files_get_utf8_byte_size(snapshotMarkdownContent),
			skipRateLimit: true,
		})) as restore_snapshot_Result;
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

								const membership = await ctx.runQuery(api.organizations.get_membership, { membershipId });
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
									organizationId: membership.organizationId,
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
									const errorMessage = "Organization credit check did not return billed user";
									const errorData = {
										userId: user._id,
										organizationId: membership.organizationId,
									};
									console.error(errorMessage, errorData);
									throw should_never_happen(errorMessage, errorData);
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
										model: openai("gpt-5-mini" satisfies files_InlineAiModelId),
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
										organizationId: membership.organizationId,
										workspaceId: membership.workspaceId,
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
									model: openai("gpt-5-mini" satisfies files_InlineAiModelId),
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
											organizationId: membership.organizationId,
											workspaceId: membership.workspaceId,
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
