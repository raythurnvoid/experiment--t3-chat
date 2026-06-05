/*
Files nodes are organized as a file tree where each node is either a folder or a Markdown file.

This structure allows file-system-like operations such as finding all items under a path (`/docs/*`) or
listing folder children and reading file content (`/docs/README.md`).
*/

import {
	httpAction,
	action,
	internalAction,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
	type MutationCtx,
	type ActionCtx,
	internalMutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	paginationOptsValidator,
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
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	type files_ContentType,
	type files_SpecialFileName,
	type files_InlineAiModelId,
} from "../server/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { minimatch } from "minimatch";
import { Result, Result_all } from "../shared/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema from "./schema.ts";
import { api, components, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";
import { billing_event } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
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
							modelId: "gpt-5-mini" satisfies files_InlineAiModelId,
							inputTokens: args.inputTokens,
							outputTokens: args.outputTokens,
						}),
						actorUserId: args.actorUserId,
						billedUserId: args.billedUser._id,
						workspaceId: args.workspaceId,
						projectId: args.projectId,
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

function is_home_file(node: Pick<Doc<"files_nodes">, "path" | "kind">): boolean;
function is_home_file(node: Pick<Doc<"files_nodes">, "parentId" | "name" | "kind">): boolean;
function is_home_file(node: Partial<Pick<Doc<"files_nodes">, "path" | "parentId" | "name" | "kind">>) {
	return (
		node.kind === "file" &&
		(node.path === `/${"README.md" satisfies files_SpecialFileName}` ||
			(node.parentId === files_ROOT_ID && node.name === ("README.md" satisfies files_SpecialFileName)))
	);
}

async function db_get_home_file(ctx: QueryCtx | MutationCtx, args: { workspaceId: string; projectId: string }) {
	const homeFile = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("parentId", files_ROOT_ID)
				.eq("name", "README.md" satisfies files_SpecialFileName)
				.eq("archiveOperationId", undefined),
		)
		.first();

	return homeFile?.kind === "file" ? homeFile : null;
}

export async function db_insert_file_chunks(
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
	// Delete existing chunk docs.
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
	]).then(([plainTextChunkDocs, markdownChunkDocs]) =>
		Promise.all([
			...plainTextChunkDocs.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)),
			...markdownChunkDocs.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)),
		]),
	);

	return db_insert_file_chunks(ctx, args);
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
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		targetSequence: number;
		delayMs: number;
	},
) {
	const existingJobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_file", (q) => q.eq("nodeId", args.nodeId))
		.collect();

	const jobId = await files_content_materialization_workpool.enqueueAction(
		ctx,
		internal.files_nodes.materialize_file_content,
		{
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			jobId,
			targetSequence: args.targetSequence,
		}),
		...existingJobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)),
		...existingJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
	]);
}

export const get_by_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		if (args.path === "/") {
			return null;
		}

		return await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
	},
});

export type files_nodes_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function db_resolve_tree_node_id_from_path(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	if (args.path === "/") return files_ROOT_ID;

	const fileByMaterializedPath = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_path_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("path", args.path)
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
			.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
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

export const get_file_nodes_list = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.array(doc(app_convex_schema, "files_nodes")),
	handler: async (ctx, args) => {
		const [userAuth, membership] = await Promise.all([
			server_convex_get_user_fallback_to_anonymous(ctx),
			ctx.db.get("workspaces_projects_users", args.membershipId),
		]);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		if (!membership || membership.userId !== userAuth.id || membership.active === false) {
			return [];
		}

		const nodes = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("projectId", membership.projectId),
			)
			.order("asc")
			.collect();

		return nodes;
	},
});

async function db_insert_node(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
		name: Doc<"files_nodes">["name"];
		path: Doc<"files_nodes">["path"];
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		markdownContent?: string;
		now: number;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
		path: args.path,
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

	if (args.markdownContent === undefined) {
		return Result({ _yay: nodeId });
	}

	const markdownContent = args.markdownContent;
	const initialYjsSequence = 0;

	if (!args.assetId) {
		const errorMessage = "fileNode.assetId is not set";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!args.yjsSnapshotAssetId) {
		const errorMessage = "fileNode.yjsSnapshotId asset is not set";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [yjs_snapshot_id, yjs_last_sequence_id] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: nodeId,
			sequence: 0,
			assetId: args.yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: nodeId,
			lastSequence: initialYjsSequence,
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
		const errorMessage = "Failed to create file content docs";
		console.error(errorMessage, {
			error,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		markdownContent?: string;
		now: number;
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
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						parentId: currentParent,
					})
				: null;

		const existing = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
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

		const node = await db_insert_node(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: currentParent,
			name,
			path,
			kind,
			contentType: isLeaf ? args.contentType : undefined,
			assetId: isLeaf ? args.assetId : undefined,
			yjsSnapshotAssetId: isLeaf ? args.yjsSnapshotAssetId : undefined,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
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
		currentParentPath = path;
	}

	const errorMessage = "nodeId not resolved after node path creation";
	const errorData = {};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}

export const create_folder_node = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		name: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuthPromise = server_convex_get_user_fallback_to_anonymous(ctx);
		const membershipPromise = ctx.db.get("workspaces_projects_users", args.membershipId);

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
		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.parentId,
			path: args.name,
			kind: "folder",
			now: Date.now(),
		});

		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

/**
 * Create a folder at a trusted absolute path for server-side agent tools.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_folder_node_by_path = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes"), exists: v.boolean() }) }),
	handler: async (ctx, args) => {
		const activeNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
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
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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

export const create_markdown_file_node = internalMutation({
	args: {
		userId: v.id("users"),
		workspaceId: v.string(),
		projectId: v.string(),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		name: v.string(),
		markdownContent: v.string(),
		markdownAssetId: v.id("files_r2_assets"),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		archiveOperationId: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: args.parentId,
			path: args.name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			assetId: args.markdownAssetId,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			archiveOperationId: args.archiveOperationId,
			markdownContent: args.markdownContent,
			now: Date.now(),
		});
		if (node._nay) {
			return node;
		}

		return Result({ _yay: { nodeId: node._yay } });
	},
});

export async function files_nodes_db_finalize_markdown_node_creation(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		markdownAssetId: Id<"files_r2_assets">;
		markdownSize: number;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
	},
) {
	const now = Date.now();
	await Promise.all([
		ctx.db.patch("files_r2_assets", args.markdownAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.markdownAssetId,
			}),
			size: args.markdownSize,
			updatedAt: now,
		}),
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.insert("files_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

export const finalize_markdown_node_creation = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		markdownAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
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

type create_markdown_file_node_Result =
	typeof create_markdown_file_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type action_create_markdown_node_Result =
	| { _yay: { nodeId: Id<"files_nodes"> }; _nay?: undefined }
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
		workspaceId: string;
		projectId: string;
		parentId: Doc<"files_nodes">["parentId"];
		name: string;
		markdownContent: string;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	},
): Promise<action_create_markdown_node_Result> {
	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(args.markdownContent);
	if (snapshotUpdate._nay) {
		return snapshotUpdate;
	}

	const [markdownAssetId, yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
		ctx.runMutation(internal.r2.insert_asset, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "content",
			size: files_get_utf8_byte_size(args.markdownContent),
			createdBy: args.userId,
		}),
		ctx.runMutation(internal.r2.insert_asset, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "yjs_snapshot",
			size: snapshotUpdate._yay.byteLength,
			createdBy: args.userId,
		}),
		ctx.runMutation(internal.r2.insert_asset, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(args.markdownContent),
			createdBy: args.userId,
		}),
	])) as [Id<"files_r2_assets">, Id<"files_r2_assets">, Id<"files_r2_assets">];

	const markdownR2Key = r2_create_asset_key({
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		assetId: markdownAssetId,
	});
	const yjsSnapshotR2Key = r2_create_asset_key({
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		assetId: yjsSnapshotAssetId,
	});
	const versionSnapshotR2Key = r2_create_asset_key({
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		assetId: versionSnapshotAssetId,
	});

	const created = (await ctx.runMutation(internal.files_nodes.create_markdown_file_node, {
		userId: args.userId,
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
		name: args.name,
		markdownContent: args.markdownContent,
		markdownAssetId: markdownAssetId,
		yjsSnapshotAssetId,
		archiveOperationId: args.archiveOperationId,
	})) as create_markdown_file_node_Result;
	if (created._nay) {
		return created;
	}

	try {
		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: args.markdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
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
		console.error("Failed to write initial Markdown file assets", {
			error,
			nodeId: created._yay.nodeId,
			markdownAssetId,
			yjsSnapshotAssetId,
			versionSnapshotAssetId,
		});
		return Result({ _nay: { message: "Failed to create file" } });
	}

	const finalized = (await ctx.runMutation(internal.files_nodes.finalize_markdown_node_creation, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: created._yay.nodeId,
		userId: args.userId,
		markdownAssetId,
		markdownSize: files_get_utf8_byte_size(args.markdownContent),
		yjsSnapshotAssetId,
		yjsSnapshotSize: snapshotUpdate._yay.byteLength,
		versionSnapshotAssetId,
		versionSnapshotSize: files_get_utf8_byte_size(args.markdownContent),
	})) as { _yay?: null; _nay?: { message: string } };
	if (finalized._nay) {
		return Result({ _nay: { message: finalized._nay.message } });
	}

	return Result({ _yay: { nodeId: created._yay.nodeId } });
}

export const create_markdown_node = action({
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

		const membership = (await ctx.runQuery(api.workspaces.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"workspaces_projects_users"> | null;
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return await action_create_markdown_node(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: args.parentId,
			markdownContent: files_INITIAL_CONTENT,
			name: args.name,
		});
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
				return Result({ _nay: { message: "Not found" } });
			}
			parentPath = parent.path;
		}

		const path = path_join(parentPath, args.filename);
		const existingNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
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

			await db_archive_nodes(ctx, {
				nodeIds: [existingNode._id],
				updatedBy: userAuth.id,
				now,
			});
		}

		const sourceAssetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			kind: "upload",
			r2Bucket: r2_get_bucket(),
			size: args.size,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const sourceAssetR2Key = r2_create_asset_key({
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			assetId: sourceAssetId,
		});

		const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			userId: membership.userId,
			parentId: args.parentId,
			path: args.filename,
			kind: "file",
			contentType: args.contentType,
			assetId: sourceAssetId,
			now,
		});
		if (node._nay) {
			return Result({ _nay: node._nay });
		}

		const signedUpload = await r2_generate_upload_url(sourceAssetR2Key);
		const headers: Record<string, string> = args.contentType ? { "Content-Type": args.contentType } : {};

		return Result({
			_yay: {
				assetId: sourceAssetId,
				nodeId: node._yay,
				url: signedUpload.url,
				headers,
			},
		});
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
		let targetParentPath: string | null;
		let leafName: string;

		if (pathSegments.length > 1) {
			targetParentPath = file.parentId === files_ROOT_ID ? "/" : null;
			// We trust that the front-end is validating the input correctly.
			for (const name of pathSegments.slice(0, -1)) {
				const existing = await ctx.db
					.query("files_nodes")
					.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
						q
							.eq("workspaceId", membership.workspaceId)
							.eq("projectId", membership.projectId)
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
						workspaceId: membership.workspaceId,
						projectId: membership.projectId,
						parentId: targetParentId,
					});
					if (targetParentPath == null) {
						return Result({ _yay: null });
					}
				}

				const folderPath = path_join(targetParentPath, name);
				const folder = await db_insert_node(ctx, {
					userId: userAuth.id,
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					parentId: targetParentId,
					name,
					path: folderPath,
					kind: "folder",
					now: Date.now(),
				});
				if (folder._nay) {
					return folder;
				}

				targetParentId = folder._yay;
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

		if (targetParentPath == null) {
			const parentPath = await resolve_parent_path_from_parent_id(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				parentId: targetParentId,
			});
			if (parentPath == null) {
				return Result({ _yay: null });
			}
			targetParentPath = parentPath;
		}

		const renamedPath = path_join(targetParentPath, leafName);
		if (file.archiveOperationId === undefined) {
			// Check whether an active sibling already owns the target name.
			const activeSiblingConflict = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
					q
						.eq("workspaceId", membership.workspaceId)
						.eq("projectId", membership.projectId)
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
								const errorMessage = "Failed to move file to root because path does not include a name segment";
								const errorData = {
									nodeId: ancestorFile._id,
									path: ancestorFile.path,
								};
								console.error(errorMessage, errorData);
								throw should_never_happen(errorMessage, errorData);
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
											const errorMessage = "Failed to rebase descendants files";
											const errorData = {
												ancestorNodeId: ancestorFile._id,
												ancestorPath: ancestorFile.path,
												ancestorTargetPath,
												ancestorTargetParentId,
												descendantNodeId: file._id,
												descendantFilePath: file.path,
											};
											console.error(errorMessage, errorData);
											throw should_never_happen(errorMessage, errorData);
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

export const get_file_node_for_membership = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		fileNodeId: v.string(),
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

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace?.defaultProjectId) {
			return null;
		}

		const hasAssetRead = await access_control_db_has_permission(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			defaultProjectId: workspace.defaultProjectId,
			workspaceOwnerUserId: workspace.ownerUserId,
			resourceKind: "project",
			resourceId: String(membership.projectId),
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
			if (!fileNode || fileNode.workspaceId !== membership.workspaceId || fileNode.projectId !== membership.projectId) {
				return null;
			}

			return fileNode;
		});
		return fileNode;
	},
});

export const get_authorized_by_path = query({
	args: { membershipId: v.id("workspaces_projects_users"), path: v.string() },
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const file =
			args.path === "/"
				? null
				: await ctx.db
						.query("files_nodes")
						.withIndex("by_workspace_project_path_archiveOperation", (q) =>
							q
								.eq("workspaceId", membership.workspaceId)
								.eq("projectId", membership.projectId)
								.eq("path", args.path)
								.eq("archiveOperationId", undefined),
						)
						.first();

		if (!file) {
			return null;
		}

		return {
			nodeId: file._id,
			name: file.name,
			kind: file.kind,
			...(file.assetId ? { assetId: file.assetId } : {}),
		};
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
			.withIndex("by_workspace_project_parent_archiveOperation_name", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", nodeId)
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
			.withIndex("by_workspace_project_parent_archiveOperation_name", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", args.parentId)
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

const files_nodes_bash_listing_page_limit_MAX = 200;

function files_nodes_clamp_bash_listing_page_limit(limit: number) {
	const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit) : files_nodes_bash_listing_page_limit_MAX;
	return Math.max(1, Math.min(files_nodes_bash_listing_page_limit_MAX, finiteLimit));
}

export const get_bash_path_entry = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
	},
	returns: v.union(
		v.object({
			nodeId: v.literal(files_ROOT_ID),
			path: v.literal("/"),
			name: v.literal(""),
			kind: v.literal("folder"),
			updatedAt: v.number(),
			contentType: v.optional(v.string()),
		}),
		v.object({
			nodeId: v.id("files_nodes"),
			path: v.string(),
			name: v.string(),
			kind: v.union(v.literal("folder"), v.literal("file")),
			updatedAt: v.number(),
			updatedBy: v.id("users"),
			contentType: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (args.path === "/") {
			return {
				nodeId: files_ROOT_ID,
				path: "/" as const,
				name: "" as const,
				kind: "folder" as const,
				updatedAt: 0,
			};
		}

		const node = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();

		if (!node) {
			return null;
		}

		return {
			nodeId: node._id,
			path: node.path,
			name: node.name,
			kind: node.kind,
			updatedAt: node.updatedAt,
			updatedBy: node.updatedBy,
			contentType: node.contentType,
		};
	},
});

export type files_nodes_get_bash_path_entry_Result =
	typeof get_bash_path_entry extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function db_list_dir_children_paginated(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
		parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		numItems: number;
		cursor: string | null;
		order?: "asc" | "desc";
	},
) {
	if (args.parentId !== files_ROOT_ID) {
		const parent = await ctx.db.get("files_nodes", args.parentId);
		if (!parent || parent.workspaceId !== args.workspaceId || parent.projectId !== args.projectId || parent.kind !== "folder") {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}
	}

	const result = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_archiveOperation_name", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("parentId", args.parentId)
				.eq("archiveOperationId", undefined),
		)
		.order(args.order ?? "asc")
		.paginate({
			cursor: args.cursor,
			numItems: files_nodes_clamp_bash_listing_page_limit(args.numItems),
		});

	return {
		items: result.page.map((file) => ({
			name: file.name,
			kind: file.kind,
			path: file.path,
			updatedAt: file.updatedAt,
			updatedBy: file.updatedBy,
			contentType: file.contentType,
		})),
		continueCursor: result.continueCursor,
		isDone: result.isDone,
	};
}

export const list_dir_children_by_parent_paginated = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				name: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				path: v.string(),
				updatedAt: v.number(),
				updatedBy: v.id("users"),
				contentType: v.optional(v.string()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		return await db_list_dir_children_paginated(ctx, args);
	},
});

export type files_nodes_list_dir_children_by_parent_paginated_Result =
	typeof list_dir_children_by_parent_paginated extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_dir_children_paginated = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				name: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				path: v.string(),
				updatedAt: v.number(),
				updatedBy: v.id("users"),
				contentType: v.optional(v.string()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const parentId = await db_resolve_tree_node_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!parentId) {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		return await db_list_dir_children_paginated(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId,
			numItems: args.numItems,
			cursor: args.cursor,
			order: args.order,
		});
	},
});

export type files_nodes_list_dir_children_paginated_Result =
	typeof list_dir_children_paginated extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_subtree_paginated = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				updatedAt: v.number(),
				updatedBy: v.id("users"),
				contentType: v.optional(v.string()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const startNodeId = await db_resolve_tree_node_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!startNodeId) {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		if (startNodeId !== files_ROOT_ID) {
			const startNode = await ctx.db.get("files_nodes", startNodeId);
			if (!startNode || startNode.workspaceId !== args.workspaceId || startNode.projectId !== args.projectId) {
				return { items: [], continueCursor: args.cursor ?? "", isDone: true };
			}
			if (startNode.kind !== "folder") {
				return args.cursor == null
					? {
							items: [
								{
									path: startNode.path,
									kind: startNode.kind,
									updatedAt: startNode.updatedAt,
									updatedBy: startNode.updatedBy,
									contentType: startNode.contentType,
								},
							],
							continueCursor: "",
							isDone: true,
						}
					: { items: [], continueCursor: args.cursor, isDone: true };
			}
		}

		const normalizedPath = args.path === "/" ? "/" : args.path.replace(/\/+$/u, "");
		const lowerBound = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
		const upperBound = `${lowerBound}\uffff`;
		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_archiveOperation_path", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("archiveOperationId", undefined)
					.gte("path", lowerBound)
					.lt("path", upperBound),
			)
			.order(args.order ?? "asc")
			.paginate({
				cursor: args.cursor,
				numItems: files_nodes_clamp_bash_listing_page_limit(args.numItems),
			});

		return {
			items: result.page.map((file) => ({
				path: file.path,
				kind: file.kind,
				updatedAt: file.updatedAt,
				updatedBy: file.updatedBy,
				contentType: file.contentType,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_list_subtree_paginated_Result =
	typeof list_subtree_paginated extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Workspace+project-wide recency listing ordered by `updatedAt`, paginated.
 * Backs `ls -t` / `ls -rt`. Project-wide only — the updatedAt index has no `path`
 * column, so it cannot be scoped to a sub-directory without a misleading page-local sort.
 */
export const list_recent_paginated = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				updatedAt: v.number(),
				updatedBy: v.id("users"),
				contentType: v.optional(v.string()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_archiveOperation_updatedAt", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("archiveOperationId", undefined),
			)
			.order(args.order === "asc" ? "asc" : "desc")
			.paginate({
				cursor: args.cursor,
				numItems: files_nodes_clamp_bash_listing_page_limit(args.numItems),
			});

		return {
			items: result.page.map((file) => ({
				path: file.path,
				kind: file.kind,
				updatedAt: file.updatedAt,
				updatedBy: file.updatedBy,
				contentType: file.contentType,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_list_recent_paginated_Result =
	typeof list_recent_paginated extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const list_path_prefix_paginated = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pathPrefix: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
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
		const lowerBound = args.pathPrefix;
		const upperBound = `${lowerBound}\uffff`;
		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_archiveOperation_path", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("archiveOperationId", undefined)
					.gte("path", lowerBound)
					.lt("path", upperBound),
			)
			.paginate({
				cursor: args.cursor,
				numItems: files_nodes_clamp_bash_listing_page_limit(args.numItems),
			});

		return {
			items: result.page.map((file) => ({
				path: file.path,
				kind: file.kind,
				updatedAt: file.updatedAt,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_list_path_prefix_paginated_Result =
	typeof list_path_prefix_paginated extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_bash_stat_entry = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
	},
	returns: v.union(
		v.object({
			path: v.literal("/"),
			name: v.literal(""),
			kind: v.literal("folder"),
			updatedAt: v.number(),
			contentType: v.optional(v.string()),
			size: v.optional(v.number()),
		}),
		v.object({
			path: v.string(),
			name: v.string(),
			kind: v.union(v.literal("folder"), v.literal("file")),
			updatedAt: v.number(),
			contentType: v.optional(v.string()),
			size: v.optional(v.number()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (args.path === "/") {
			return {
				path: "/" as const,
				name: "" as const,
				kind: "folder" as const,
				updatedAt: 0,
			};
		}

		const node = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();

		if (!node) {
			return null;
		}

		const asset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		return {
			path: node.path,
			name: node.name,
			kind: node.kind,
			updatedAt: node.updatedAt,
			contentType: node.contentType,
			size: asset?.workspaceId === args.workspaceId && asset.projectId === args.projectId ? asset.size : undefined,
		};
	},
});

export type files_nodes_get_bash_stat_entry_Result =
	typeof get_bash_stat_entry extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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
		// TODO: when truncating, we truncate the total docs but we don't tell the LLM if we truncated in depth
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
						.withIndex("by_workspace_project_parent_archiveOperation_name", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("parentId", frame.parentId)
								.eq("archiveOperationId", undefined),
						)
						[Symbol.asyncIterator]();
				// Keep the iterator on the frame immediately so file children and
				// non-matching children do not restart sibling traversal from the first row.
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

export type files_nodes_list_files_Result =
	typeof list_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
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
	args: { workspaceId: string; projectId: string; nodeId: Id<"files_nodes"> },
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.workspaceId !== args.workspaceId || fileNode.projectId !== args.projectId) {
		return null;
	}

	if (!files_node_has_editable_yjs_state(fileNode)) {
		return null;
	}

	if (!fileNode.yjsSnapshotId) {
		const errorMessage = "fileNode.yjsSnapshotId is not set";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!fileNode.yjsLastSequenceId) {
		const errorMessage = "fileNode.yjsLastSequenceId is not set";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!fileNode.assetId) {
		const errorMessage = "fileNode.assetId is not set";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			assetId: fileNode.assetId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [asset, yjsSnapshotDoc, yjsLastSequenceDoc, yjsUpdatesDocs] = await Promise.all([
		ctx.db.get("files_r2_assets", fileNode.assetId),
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
			)
			.order("asc")
			.collect(),
	]);

	if (
		!asset ||
		asset.workspaceId !== args.workspaceId ||
		asset.projectId !== args.projectId ||
		asset.kind !== "content"
	) {
		const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			assetId: fileNode.assetId,
			asset,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId ||
		yjsSnapshotDoc.projectId !== args.projectId ||
		yjsSnapshotDoc.nodeId !== args.nodeId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId ||
		yjsLastSequenceDoc.projectId !== args.projectId ||
		yjsLastSequenceDoc.nodeId !== args.nodeId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
		yjsSnapshotAsset.workspaceId !== args.workspaceId ||
		yjsSnapshotAsset.projectId !== args.projectId ||
		yjsSnapshotAsset.kind !== "yjs_snapshot"
	) {
		const errorMessage = "yjsSnapshotDoc.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
		workspaceId: v.string(),
		projectId: v.string(),
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
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
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
		const file =
			args.path === "/"
				? null
				: await ctx.db
						.query("files_nodes")
						.withIndex("by_workspace_project_path_archiveOperation", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("path", args.path)
								.eq("archiveOperationId", undefined),
						)
						.first();

		if (!file || file.kind !== "file") return null;

		if (!files_node_has_editable_yjs_state(file)) {
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
			pendingUpdateById.nodeId === file._id
				? pendingUpdateById
				: await ctx.db
						.query("files_pending_updates")
						.withIndex("by_workspace_project_user_file", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("userId", args.userId)
								.eq("nodeId", file._id),
						)
						.first();
		if (pendingUpdate) {
			// Rebuild the pending branch from its recorded base so readers see the same document
			// the pending-update save/rebase flow will later persist.
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.baseYjsUpdate, {
				additionalIncrementalArrayBufferUpdates: [pendingUpdate.unstagedBranchYjsUpdate],
			});

			const markdown = files_yjs_doc_get_markdown({ yjsDoc });
			if (markdown._yay !== undefined) {
				return {
					content: markdown._yay,
					asset: null,
					nodeId: file._id,
					displayNodeId: file._id,
					pendingUpdateId: pendingUpdate._id,
					materializationState: null,
				};
			}

			console.error("Failed to reconstruct markdown from files_pending_updates", {
				nay: markdown._nay,
				nodeId: file._id,
			});
		}

		const asset = file.assetId
			? await ctx.db
					.get("files_r2_assets", file.assetId)
					.then((asset) =>
						asset && asset.workspaceId === args.workspaceId && asset.projectId === args.projectId ? asset : null,
					)
			: null;

		const materializationState = pendingUpdate
			? null
			: await db_get_file_content_materialization_db_state(ctx, {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					nodeId: file._id,
				});

		return {
			asset,
			nodeId: file._id,
			displayNodeId: file._id,
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
	handler: async (ctx, args): Promise<get_file_last_available_markdown_content_by_path_Result> => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!state) {
			return null;
		}

		const materializationState = state.materializationState;
		let content: string;
		if (state.content !== undefined) {
			content = state.content;
		} else if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			content = await reconstruct_latest_file_content_from_materialization_state({ state: materializationState }).then(
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
			content = state.asset?.r2Key
				? await r2_fetch_object_from_bucket({ key: state.asset.r2Key }).then((response) => response.text())
				: "";
		}

		return {
			content,
			nodeId: state.nodeId,
			displayNodeId: state.displayNodeId,
			pendingUpdateId: state.pendingUpdateId,
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

// Bounded reads: never scan more than this many bytes of a committed file when reading a
// line range, so a multi-MB file is not pulled in full. Tunable.
const files_READ_RANGE_MAX_LINES = 200;
const files_READ_RANGE_SCAN_MAX_BYTES = 64 * 1024;
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
		return { content: "" };
	}
	const hasTrailingNewline = content.endsWith("\n");
	const split = content.split("\n");
	const lines = hasTrailingNewline ? split.slice(0, -1) : split;
	const slice = lines.slice(Math.max(0, lines.length - maxLines)).map(files_truncate_long_display_line);
	return { content: slice.length > 0 ? `${slice.join("\n")}\n` : "" };
}

async function files_resolve_readable_content_or_window(
	ctx: ActionCtx,
	args: { workspaceId: string; projectId: string; userId: Id<"users">; path: string; pendingUpdateId?: Id<"files_pending_updates"> },
): Promise<{ nodeId: Id<"files_nodes">; text: string; fetchedAllBytes: boolean; totalBytes: number } | null> {
	const state = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		path: args.path,
		pendingUpdateId: args.pendingUpdateId,
	})) as get_file_markdown_content_db_state_by_path_Result;
	if (!state) {
		return null;
	}
	const materializationState = state.materializationState;
	// Pending user edit, or stale snapshot: full content is (or must be) in memory.
	if (state.content !== undefined) {
		return { nodeId: state.nodeId, text: state.content, fetchedAllBytes: true, totalBytes: files_get_utf8_byte_size(state.content) };
	}
	if (
		materializationState &&
		materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
	) {
		const reconstructed = await reconstruct_latest_file_content_from_materialization_state({ state: materializationState });
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
	const r2Key = state.asset?.r2Key;
	if (!r2Key) {
		return { nodeId: state.nodeId, text: "", fetchedAllBytes: true, totalBytes: 0 };
	}
	const totalBytes = state.asset?.size ?? files_READ_RANGE_SCAN_MAX_BYTES;
	const endInclusive = Math.max(0, Math.min(files_READ_RANGE_SCAN_MAX_BYTES, totalBytes) - 1);
	const response = await r2_fetch_object_range_from_bucket({ key: r2Key, start: 0, endInclusive });
	const bytes = new Uint8Array(await response.arrayBuffer());
	const text = new TextDecoder("utf-8").decode(bytes);
	return { nodeId: state.nodeId, text, fetchedAllBytes: bytes.byteLength >= totalBytes, totalBytes };
}

/**
 * Read a line range of a file without pulling the whole thing: for committed, up-to-date
 * content this issues a single bounded R2 byte-range read (a leading window capped at
 * `files_READ_RANGE_SCAN_MAX_BYTES`); for pending/unmaterialized content it slices the
 * in-memory reconstruction. Backs `head -n N` (startLine 1) and `sed -n 'A,Bp'` (startLine A).
 * Deep ranges of a genuinely huge committed file may fall outside the leading window
 * (scanTruncated); the aggressive-cap testing case keeps whole files within the window.
 */
export const read_file_line_range = internalAction({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		startLine: v.number(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
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
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		const startLine = Math.max(1, Math.trunc(args.startLine));
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
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
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			scanTruncated: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!state) {
			return null;
		}
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
		const materializationState = state.materializationState;

		// Pending/stale: full content in memory.
		if (state.content !== undefined) {
			const tail = files_tail_lines_from_text(state.content, maxLines);
			return { nodeId: state.nodeId, content: tail.content, scanTruncated: false };
		}
		if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			const reconstructed = await reconstruct_latest_file_content_from_materialization_state({ state: materializationState });
			if (reconstructed._nay) {
				throw convex_error({ message: "Failed to reconstruct latest file content", cause: reconstructed._nay });
			}
			const tail = files_tail_lines_from_text(reconstructed._yay.markdown, maxLines);
			return { nodeId: state.nodeId, content: tail.content, scanTruncated: false };
		}

		// Committed: read a bounded trailing window from the end of the R2 object.
		const r2Key = state.asset?.r2Key;
		const totalBytes = state.asset?.size;
		if (!r2Key || totalBytes == null) {
			return { nodeId: state.nodeId, content: "", scanTruncated: false };
		}
		const start = Math.max(0, totalBytes - files_READ_RANGE_SCAN_MAX_BYTES);
		const response = await r2_fetch_object_range_from_bucket({ key: r2Key, start, endInclusive: totalBytes - 1 });
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = new TextDecoder("utf-8").decode(bytes);
		const tail = files_tail_lines_from_text(text, maxLines);
		// If the trailing window didn't reach the start of the file, the earliest returned line
		// could be partial — only relevant for files larger than the scan window.
		const scanTruncated = start > 0;
		return { nodeId: state.nodeId, content: tail.content, scanTruncated };
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
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
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
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		const text = resolved.text;
		// wc -l counts newline characters (not "lines"), so an unterminated final line is not counted.
		let lineCount = 0;
		for (let index = 0; index < text.length; index++) {
			if (text[index] === "\n") lineCount++;
		}
		const wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
		return {
			nodeId: resolved.nodeId,
			lineCount,
			wordCount,
			charCount: text.length,
			byteCount: resolved.totalBytes,
			exact: resolved.fetchedAllBytes,
		};
	},
});

export type files_nodes_read_file_content_stats_Result =
	typeof read_file_content_stats extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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
			!files_node_has_editable_yjs_state(file) ||
			file.archiveOperationId !== undefined
		) {
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
			const errorMessage = "fileNode._id points to missing files_plain_text_chunks docs";
			const errorData = {
				nodeId: args.nodeId,
				workspaceId: file.workspaceId,
				projectId: file.projectId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
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

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.projectId !== membership.projectId ||
			!files_node_has_editable_yjs_state(fileNode)
		) {
			return null;
		}

		if (!fileNode.yjsLastSequenceId) {
			return null;
		}

		const lastYjsSequenceDoc = await ctx.db
			.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId)
			.then((doc) => {
				if (!doc || doc.workspaceId !== fileNode.workspaceId || doc.projectId !== fileNode.projectId) return null;
				return doc;
			});

		if (!lastYjsSequenceDoc) {
			const errorMessage =
				"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
			const errorData = {
				workspaceId: fileNode.workspaceId,
				projectId: fileNode.projectId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
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
		truncated: v.boolean(),
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
		truncated: boolean;
	}> => {
		// Over-fetch a bounded candidate window BEFORE dedup/exact-filter so the survivor
		// count isn't silently far below `limit` (relevance-ranked candidates dropped
		// post-take). Bounded so per-search read cost stays capped.
		const candidateLimit = Math.min(300, Math.max(args.limit * 5, 50));
		const matches = await ctx.db
			.query("files_plain_text_chunks")
			.withSearchIndex("search_by_plainTextChunk", (q) =>
				q.search("plainTextChunk", args.query).eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.take(candidateLimit);

		// Convex text search returns word by word search results ordered by relevance,
		// we want to return only 1 result per chunk and only the exact match of the
		// query in input. `truncated` signals the agent that more matches may exist:
		// either the relevance window filled, or exact matches exceeded the limit.
		let truncated = matches.length >= candidateLimit;
		const exactMatches: typeof matches = [];
		const seenMarkdownChunkIds = new Set<(typeof matches)[number]["markdownChunkId"]>();
		for (const match of matches) {
			if (seenMarkdownChunkIds.has(match.markdownChunkId)) {
				continue;
			}
			seenMarkdownChunkIds.add(match.markdownChunkId);

			// The Convex search index is case-insensitive and word-tokenized, so re-match
			// case-insensitively here too — otherwise `search readme` against `# Readme`
			// gets index hits that are all dropped, returning a false "No files found".
			if (!match.plainTextChunk.toLowerCase().includes(args.query.toLowerCase())) {
				continue;
			}

			if (exactMatches.length >= args.limit) {
				truncated = true;
				break;
			}
			exactMatches.push(match);
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

		return { items, truncated };
	},
});

export type files_nodes_text_search_files_Result =
	typeof text_search_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Create a Markdown file at a trusted path.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_file_by_path = internalAction({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		path: v.string(),
		markdownContent: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args): Promise<action_create_markdown_node_Result> => {
		const activeFile = (await ctx.runQuery(internal.files_nodes.get_by_path, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		})) as Doc<"files_nodes"> | null;
		if (activeFile?.kind === "file") {
			return Result({ _yay: { nodeId: activeFile._id } });
		}

		return await action_create_markdown_node(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: files_ROOT_ID,
			name: args.path,
			markdownContent: args.markdownContent ?? "",
		});
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

export const get_data_for_create_home_file = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.union(
		v.object({
			membership: doc(app_convex_schema, "workspaces_projects_users"),
			homeFile: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await workspaces_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return {
			membership,
			homeFile: await db_get_home_file(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
			}),
		};
	},
});

type get_data_for_create_home_file_Result =
	typeof get_data_for_create_home_file extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const create_home_file = action({
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

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_create_home_file, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		})) as get_data_for_create_home_file_Result;
		if (!data) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const { membership, homeFile } = data;
		if (homeFile) {
			return Result({ _yay: { nodeId: homeFile._id } });
		}

		return await action_create_markdown_node(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			parentId: files_ROOT_ID,
			name: "README.md" satisfies files_SpecialFileName,
			// Keep the auto-created home file consistent with user-created Markdown files.
			markdownContent: files_INITIAL_CONTENT,
		});
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

async function db_get_file_snapshot_content(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
	},
) {
	const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
	if (
		!snapshot ||
		snapshot.workspaceId !== args.workspaceId ||
		snapshot.projectId !== args.projectId ||
		snapshot.nodeId !== args.nodeId
	) {
		return null;
	}

	const asset = await ctx.db
		.get("files_r2_assets", snapshot.assetId)
		.then((asset) =>
			asset && asset.workspaceId === args.workspaceId && asset.projectId === args.projectId ? asset : null,
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
		membershipId: v.id("workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await db_get_file_snapshot_content(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
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

export const get_data_for_yjs_prepare_doc_last_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
	handler: async (ctx, args) => {
		const membership = await workspaces_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await db_get_file_content_materialization_db_state(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
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

	await enqueue_file_content_materialization(ctx, {
		userId: args.userId,
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: snapshotScheduleDelayMs,
	});

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
		if (!files_node_has_editable_yjs_state(file)) {
			return Result({ _nay: { message: "Not found" } });
		}

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace) {
			const errorMessage = "membership.workspaceId points to a missing workspaces doc";
			const errorData = {
				membershipId: membership._id,
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: user._id,
			workspace,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = {
				userId: user._id,
				workspaceId: workspace._id,
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
	assetId: v.id("files_r2_assets"),
	createdBy: v.id("users"),
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return files_u8_to_array_buffer(mergeUpdates(updates));
}

async function db_insert_snapshot_restore_update(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
		restoreUpdate: ArrayBuffer;
	},
) {
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
		update: args.restoreUpdate,
		origin: {
			type: "USER_SNAPSHOT_RESTORE",
			snapshotId: args.snapshotId,
		},
		createdBy: args.userId,
		createdAt: Date.now(),
	});

	await enqueue_file_content_materialization(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
		userId: args.userId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: 0,
	});

	return newSequenceData.lastSequence;
}

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	const snapshotId = await ctx.db.insert("files_snapshots", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
		assetId: args.assetId,
		createdBy: args.createdBy,
		archivedAt: -1,
	});

	return snapshotId;
}

async function reconstruct_latest_file_content_from_materialization_state(args: {
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

export const finalize_file_content_materialization = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
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
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
				ctx.db.patch("files_r2_assets", state.asset._id, {
					r2Key: r2_create_asset_key({
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						assetId: state.asset._id,
					}),
					size: args.markdownSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", state.yjsSnapshotAsset._id, {
					r2Key: r2_create_asset_key({
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						assetId: state.yjsSnapshotAsset._id,
					}),
					size: args.yjsSnapshotSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						workspaceId: args.workspaceId,
						projectId: args.projectId,
						assetId: args.versionSnapshotAssetId,
					}),
					size: args.markdownSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_yjs_snapshots", state.yjsSnapshotDoc._id, {
					sequence: args.sequence,
					updatedBy: "system",
					updatedAt: now,
				}),
				...state.yjsUpdatesDocs
					.filter((updateData) => updateData.sequence <= args.sequence)
					.map((updateData) => ctx.db.delete("files_yjs_updates", updateData._id)),
				db_replace_file_chunks(ctx, {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					nodeId: args.nodeId,
					yjsSequence: args.sequence,
					markdownContent: args.markdown,
				}),
				store_version_snapshot(ctx, {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					nodeId: args.nodeId,
					assetId: args.versionSnapshotAssetId,
					createdBy: args.userId,
				}),
				ctx.db
					.query("files_content_materialization_jobs")
					.withIndex("by_file", (q) => q.eq("nodeId", args.nodeId))
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
		workspaceId: v.string(),
		projectId: v.string(),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		targetSequence: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return Result({ _yay: null });
		}

		const reconstructed = await reconstruct_latest_file_content_from_materialization_state({ state });
		if (reconstructed._nay) {
			return reconstructed;
		}

		const sequence = reconstructed._yay.sequence;
		const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(reconstructed._yay.markdown),
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;

		if (!state.asset.r2Key || !state.yjsSnapshotAsset.r2Key) {
			const errorMessage = "materialization asset r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				assetId: state.asset._id,
				yjsSnapshotAssetId: state.yjsSnapshotAsset._id,
				versionSnapshotAssetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const versionSnapshotR2Key = r2_create_asset_key({
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			assetId: versionSnapshotAssetId,
		});

		await Promise.all([
			r2_put_object(ctx, {
				key: state.asset.r2Key,
				body: reconstructed._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
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
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
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

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const [snapshotContent, fileNode] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			ctx.db.get("files_nodes", args.nodeId).then((fileNode) => {
				if (
					!fileNode ||
					fileNode.workspaceId !== membership.workspaceId ||
					fileNode.projectId !== membership.projectId
				) {
					return null;
				}

				return fileNode;
			}),
		]);

		if (!snapshotContent || !fileNode) {
			return Result({
				_nay: {
					name: "nay",
					message: "Not found",
				},
			});
		}

		if (!files_node_has_editable_yjs_state(fileNode)) {
			return Result({
				_nay: {
					name: "nay",
					message: "Not found",
				},
			});
		}

		if (!fileNode.yjsLastSequenceId) {
			const errorMessage = "fileNode.yjsLastSequenceId is not set";
			const errorData = {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const userDoc = await ctx.db.get("users", userAuth.id);
		if (!userDoc) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const workspace = await ctx.db.get("workspaces", membership.workspaceId);
		if (!workspace) {
			const errorMessage = "membership.workspaceId points to a missing workspaces doc";
			const errorData = {
				membershipId: membership._id,
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: userAuth.id,
			workspace,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = {
				userId: userAuth.id,
				workspaceId: workspace._id,
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
		const createdBy = userAuth.id;
		const updatedBy = userAuth.id;

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		if (!fileNode.assetId) {
			const errorMessage = "fileNode.assetId is not set";
			const errorData = {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				assetId: fileNode.assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const [, , , , , , restoredYjsSequence] = await Promise.all([
			ctx.db.patch("files_r2_assets", fileNode.assetId, {
				r2Key: r2_create_asset_key({
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					assetId: fileNode.assetId,
				}),
				size: files_get_utf8_byte_size(args.snapshotMarkdownContent),
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.currentSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					assetId: args.currentSnapshotAssetId,
				}),
				size: args.currentSnapshotSize,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.restoredSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					assetId: args.restoredSnapshotAssetId,
				}),
				size: args.restoredSnapshotSize,
				updatedAt: now,
			}),
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				assetId: args.currentSnapshotAssetId,
				createdBy: createdBy,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				assetId: args.restoredSnapshotAssetId,
				createdBy: createdBy,
			}),

			ctx.db.patch("files_nodes", fileNode._id, {
				updatedBy: updatedBy,
				updatedAt: now,
			}),

			args.restoreUpdate
				? db_insert_snapshot_restore_update(ctx, {
						workspaceId: membership.workspaceId,
						projectId: membership.projectId,
						userId: userAuth.id,
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
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
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
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
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

type restore_snapshot_Result =
	typeof restore_snapshot extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_restore_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			membership: doc(app_convex_schema, "workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const [snapshotContent, materializationState] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			db_get_file_content_materialization_db_state(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
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
			workspaceId: membership.workspaceId,
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
		const currentContent = await reconstruct_latest_file_content_from_materialization_state({
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
			console.error("Failed to project restored snapshot Markdown", {
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
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(currentContent._yay.markdown),
				createdBy: userAuth.id,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(snapshotMarkdownContent),
				createdBy: userAuth.id,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

		if (!materializationState.asset.r2Key) {
			const errorMessage = "restore asset r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				assetId: materializationState.asset._id,
				currentSnapshotAssetId,
				restoredSnapshotAssetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const currentSnapshotR2Key = r2_create_asset_key({
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			assetId: currentSnapshotAssetId,
		});
		const restoredSnapshotR2Key = r2_create_asset_key({
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			assetId: restoredSnapshotAssetId,
		});

		await Promise.all([
			r2_put_object(ctx, {
				key: materializationState.asset.r2Key,
				body: snapshotMarkdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
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
				const snapshotTimeSlotKey = `${snapshot.nodeId}::${bucketTimestamp}`;
				if (!latestSnapshotNodeIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotNodeIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (keepSnapshot) {
				continue;
			}

			const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
			if (
				!asset ||
				asset.workspaceId !== snapshot.workspaceId ||
				asset.projectId !== snapshot.projectId ||
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
									const errorMessage = "Workspace credit check did not return billed user";
									const errorData = {
										userId: user._id,
										workspaceId: membership.workspaceId,
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
