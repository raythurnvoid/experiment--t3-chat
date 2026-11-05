// The public API doors that organize files: `/api/v1/files/stat`, `/api/v1/files/mkdir`,
// `/api/v1/files/move`, `/api/v1/files/copy`, `/api/v1/files/delete`, `/api/v1/files/restore`,
// `/api/v1/files/trash/list`, `/api/v1/files/trash/areas`, and `/api/v1/files/jobs/get` (routes in
// `public_api_files_organize_http_routes.ts`).
//
// They act as the API key, with the same Locked, not hidden rules as `files/list`: a path the key
// cannot open answers "Permission denied", never "not found".

import { compareValues, v, ConvexError, type Infer } from "convex/values";
import type { IndexRange, RegisteredMutation, RegisteredQuery } from "convex/server";
import { validate } from "convex-helpers/validators";
import { z } from "zod";

import { internalQuery, type ActionCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	access_control_db_authorize_membership,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
	access_control_subject_validator,
} from "./access_control.ts";
import { activities_is_active } from "./activities_db.ts";
import { files_archive_runs_db_find_saved_restore_left_node } from "./files_archive_runs.ts";
import { files_nodes_db_archive_named_nodes, files_nodes_db_restore_named_nodes } from "./files_nodes.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_transfer_db_start_for_api } from "./files_transfer.ts";
import { files_tree_db_get_share_principal_keys } from "./files_tree.ts";
import { files_transfer_status_db_require_activity } from "./files_transfer_status.ts";
import { files_write_policy_db_has_write_context_permission } from "./files_write_policy_db.ts";
import { public_api_db_revalidate_file_write_principal, public_api_get_invalid_name_message } from "./public_api.ts";
import { public_api_validate_canonical_folder_path } from "./public_api_plugin_files.ts";
import {
	public_api_authorize_request,
	public_api_settle_plugin_call_best_effort,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";
import { public_api_credentials_db_get_write_context } from "./public_api_credentials_db.ts";
import type { r2_get_assets_ready_states_Result } from "./r2.ts";
import { rate_limiter_limit_by_key, rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE } from "./rate_limiter.ts";
import app_convex_schema, { files_saved_stream_validator } from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";
import { crypto_open_cursor, crypto_seal_cursor, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_db_create_path_lookups, files_db_get_path_access } from "../server/files.ts";
import { files_index_range_apply, files_index_range_phases } from "../server/files-index-range.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import { files_share_rows_principal_key } from "../server/files-share-rows.ts";
import { plugins_file_grants_db_validate_pair } from "../server/plugins-file-grants.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import {
	files_archive_operation_id_time,
	files_ROOT_ID,
	files_TRANSFER_SELECTION_PAGE_SIZE,
	type files_SavedStream,
} from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import type { public_api_Scope } from "../shared/public-api.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const STAT_MAX_PATHS = 100;

/**
 * Answer each path as found, missing, or denied, like `stat` on a file system.
 */
export const get_paths = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		subject: access_control_subject_validator,
		paths: v.array(v.string()),
	},
	returns: v.array(
		v.union(
			v.object({
				path: v.string(),
				status: v.literal("found"),
				node: v.object({
					name: v.string(),
					kind: v.union(v.literal("file"), v.literal("folder")),
					nodeId: v.id("files_nodes"),
					contentType: v.union(v.string(), v.null()),
					updatedAt: v.number(),
					assetId: v.union(v.id("files_r2_assets"), v.null()),
					locked: v.boolean(),
				}),
			}),
			v.object({ path: v.string(), status: v.union(v.literal("missing"), v.literal("denied")) }),
		),
	),
	handler: async (ctx, args) => {
		// Each path costs a few index reads that grow with its depth, never with folder size.
		return await Promise.all(
			args.paths.map(async (path) => {
				const access = await files_db_get_path_access(ctx, { ...args, path });
				if (access.status === "missing") return { path, status: "missing" as const };
				// A locked item shows as a locked row only when its folder is readable, like in `files/list`.
				if (!access.node) return { path, status: "denied" as const };
				return {
					path,
					status: "found" as const,
					node: {
						name: access.node.name,
						kind: access.node.kind,
						nodeId: access.node._id,
						contentType: access.node.contentType,
						updatedAt: access.node.updatedAt,
						assetId: access.node.assetId,
						locked: access.status === "locked",
					},
				};
			}),
		);
	},
});

type get_paths_Result =
	typeof get_paths extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const stat_body_validator = z
	.object({
		paths: z.array(z.string()).min(1),
	})
	.strict();

export type public_api_files_organize_http_stat_Body = z.infer<typeof stat_body_validator>;

export async function public_api_files_organize_http_stat(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/stat";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:list" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, stat_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	// Count the paths here, not in the schema, so the answer names the limit.
	if (body._yay.paths.length > STAT_MAX_PATHS) {
		return {
			status: 400,
			body: { message: `Check at most ${STAT_MAX_PATHS} paths at once. Split the list into several calls.` },
		} as const;
	}

	const paths: string[] = [];
	for (const rawPath of body._yay.paths) {
		if (!rawPath.startsWith("/")) {
			return { status: 400, body: { message: "Path must be absolute.", path: rawPath } } as const;
		}
		const normalized = server_path_normalize(rawPath);
		if (normalized === "/") {
			return { status: 400, body: { message: "Path must not be the workspace root.", path: rawPath } } as const;
		}
		paths.push(normalized);
	}

	const results = (await ctx.runQuery(internal.public_api_files_organize.get_paths, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		subject: principal.subject,
		paths,
	})) as get_paths_Result;

	// Keep readiness separate, the same way `files/list` does.
	const assetIds = results.flatMap((result) =>
		result.status === "found" && result.node.assetId ? [result.node.assetId] : [],
	);
	const assetStates: r2_get_assets_ready_states_Result =
		assetIds.length > 0 ? await ctx.runQuery(internal.r2.get_assets_ready_states, { assetIds }) : {};

	return {
		status: 200,
		body: {
			items: results.map((result) => {
				if (result.status !== "found") {
					return { path: result.path, status: result.status };
				}
				const { node } = result;
				const assetState = node.assetId ? assetStates[node.assetId] : undefined;
				return {
					path: result.path,
					status: result.status,
					// The same item shape as `files/list`.
					item: {
						path: result.path,
						name: node.name,
						kind: node.kind,
						nodeId: node.nodeId,
						contentType: node.contentType,
						updatedAt: node.updatedAt,
						status:
							node.kind === "file" && !node.locked
								? assetState && !assetState.ready
									? ("pending" as const)
									: ("ready" as const)
								: null,
						size: assetState ? assetState.size : null,
						locked: node.locked,
					},
				};
			}),
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const MKDIR_MAX_PATHS = 20;

const mkdir_failure_validator = z.object({
	path: z.string(),
	status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(409)]),
});

/**
 * Create folders like `mkdir -p`, all or nothing. Each path is checked as the key in this
 * transaction. A refusal throws, so the folders made for earlier paths roll back too.
 */
export const create_folders = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Absolute, canonical folder paths. */
		paths: v.array(v.string()),
	},
	returns: v.array(v.object({ path: v.string(), nodeId: v.id("files_nodes"), created: v.boolean() })),
	handler: async (ctx, args) => {
		const now = Date.now();
		const fail = (failArgs: z.infer<typeof mkdir_failure_validator> & { message: string }) =>
			convex_error({ message: failArgs.message, data: { path: failArgs.path, status: failArgs.status } });

		// The key and its scopes are the same for every path. Each path's write check is the create below,
		// so the principal check skips it.
		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: { kind: "user_api_key", credentialId: args.credentialId },
			force: args.force === true,
			path: args.paths[0],
			eachPathChecked: true,
			now,
		});
		if (revalidated._nay) {
			throw fail({
				path: args.paths[0],
				message: revalidated._nay.message,
				status: revalidated._nay.message === "Unauthenticated" ? 401 : 403,
			});
		}
		const { writeContext } = revalidated._yay;

		const created: Array<{ path: string; nodeId: Id<"files_nodes">; created: boolean }> = [];
		const lookups = await files_db_create_path_lookups(ctx, args);
		// Folders already found or made by this request, so nested paths walk each folder once.
		const folders = new Map<string, Doc<"files_nodes">>();
		for (const path of args.paths) {
			const access = await files_db_get_path_access(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				subject: writeContext.subject,
				path,
			});
			// A path inside a locked folder answers the same, whether the name exists there or not.
			if (access.status === "locked" && !access.node) {
				throw fail({ path, message: "Permission denied", status: 403 });
			}
			// An existing folder is fine, like `mkdir -p`. A locked one in a readable folder already shows
			// there as a locked row, so it is fine too.
			if (access.status !== "missing") {
				if (access.node!.kind === "file") {
					throw fail({ path, message: "A file already exists at this path. Pick another path.", status: 409 });
				}
				created.push({ path, nodeId: access.node!._id, created: false });
				continue;
			}

			// Path access answers missing when a file sits in the middle of the path.
			const { node: nearest, depth } = await lookups.find_existing_parent(path);
			if (nearest?.kind === "file") {
				throw fail({
					path,
					message: "A file is in the way on this path. Rename or move it, or pick another path.",
					status: 409,
				});
			}

			// Create below the deepest folder that exists, like `files/write`. The folders above it may be
			// locked: a guest writes only inside the folder shared with them. The helper checks write where
			// the folders land, write rules, and name and path limits.
			const nodeId = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: args.userId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: nearest?._id ?? files_ROOT_ID,
				path: path_extract_segments_from(path).slice(depth).join("/"),
				kind: "folder",
				writeContext,
				folders,
				now,
			});
			if (nodeId._nay) {
				const { name } = nodeId._nay;
				throw fail({
					path,
					message: nodeId._nay.message,
					status:
						nodeId._nay.message === "Permission denied" || name === "read_only"
							? 403
							: name === "name_too_long" || name === "path_too_long" || name === "too_many_folders"
								? 400
								: 409,
				});
			}
			created.push({ path, nodeId: nodeId._yay, created: true });
		}

		return created;
	},
});

type create_folders_Result =
	typeof create_folders extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const mkdir_body_validator = z
	.object({
		force: z.boolean().optional(),
		paths: z.array(z.string()).min(1),
	})
	.strict();

export type public_api_files_organize_http_mkdir_Body = z.infer<typeof mkdir_body_validator>;

export async function public_api_files_organize_http_mkdir(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/mkdir";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, mkdir_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	// Count the paths here, not in the schema, so the answer names the limit.
	if (body._yay.paths.length > MKDIR_MAX_PATHS) {
		return {
			status: 400,
			body: { message: `Make at most ${MKDIR_MAX_PATHS} folders at once. Split the list into several calls.` },
		} as const;
	}

	const paths: string[] = [];
	for (const rawPath of body._yay.paths) {
		const validated = public_api_validate_canonical_folder_path(rawPath);
		if (validated._nay) {
			return { status: 400, body: { message: validated._nay.message, path: rawPath } } as const;
		}
		if (paths.includes(validated._yay)) {
			return { status: 400, body: { message: "Duplicate path in batch", path: rawPath } } as const;
		}
		paths.push(validated._yay);
	}

	// One token per path, before any write, like `files/write-many`. Creating folders is free in the
	// app, so there is no credit gate.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
		count: paths.length,
	});
	if (rateLimit) {
		return { status: 429, body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs } } as const;
	}

	let items: create_folders_Result;
	try {
		items = (await ctx.runMutation(internal.public_api_files_organize.create_folders, {
			credentialId: principal.credentialId,
			force: body._yay.force === true,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.userId,
			paths,
		})) as create_folders_Result;
	} catch (error) {
		const failure =
			error instanceof ConvexError
				? z.object({ message: z.string(), data: mkdir_failure_validator }).safeParse(error.data)
				: null;
		if (!failure?.success) throw error;
		return {
			status: failure.data.data.status,
			body: { message: failure.data.message, path: failure.data.data.path },
		} as const;
	}
	return { status: 200, body: { items }, headers: { "Cache-Control": "no-store" } } as const;
}

const DELETE_MAX_PATHS = 200;

const delete_failure_validator = z.object({
	status: z.union([z.literal(401), z.literal(403), z.literal(429)]),
	/** Set on 429. */
	retryAfterMs: z.number().optional(),
});

/**
 * Archive the named paths with the app's archive job, like `rm` with several files. A path that is
 * missing or locked is refused alone, and the other paths are still archived.
 */
export const delete_paths = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Absolute, normalized paths, not the root. */
		paths: v.array(v.string()),
	},
	returns: v.object({
		jobId: v.union(v.id("activities"), v.null()),
		isDone: v.boolean(),
		refused: v.array(v.object({ path: v.string(), message: v.string() })),
	}),
	handler: async (ctx, args) => {
		const fail = (failArgs: z.infer<typeof delete_failure_validator> & { message: string }) =>
			convex_error({
				message: failArgs.message,
				data: {
					status: failArgs.status,
					...(failArgs.retryAfterMs !== undefined ? { retryAfterMs: failArgs.retryAfterMs } : {}),
				},
			});

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: { kind: "user_api_key", credentialId: args.credentialId },
			force: args.force === true,
			path: args.paths[0],
			eachPathChecked: true,
			now: Date.now(),
		});
		if (revalidated._nay) {
			throw fail({
				message: revalidated._nay.message,
				status: revalidated._nay.message === "Unauthenticated" ? 401 : 403,
			});
		}
		const { subject } = revalidated._yay.writeContext;

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
			throw fail({ message: "Unauthenticated", status: 401 });
		}

		// The same bucket as Archive in the app, so a key cannot archive faster than its person.
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) {
			throw fail({ message: rateLimit.message, status: 429, retryAfterMs: rateLimit.retryAfterMs });
		}

		// Resolve each path as the key. Locked answers "Permission denied", never "Not found".
		const refused: Array<{ path: string; message: string }> = [];
		const pathByNodeId = new Map<Id<"files_nodes">, string>();
		for (const path of args.paths) {
			const access = await files_db_get_path_access(ctx, { ...args, subject, path });
			if (access.status === "found") {
				pathByNodeId.set(access.node._id, path);
			} else {
				refused.push({ path, message: access.status === "locked" ? "Permission denied" : "Not found" });
			}
		}
		if (pathByNodeId.size === 0) {
			return { jobId: null, isDone: true, refused };
		}

		const archived = await files_nodes_db_archive_named_nodes(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeIds: [...pathByNodeId.keys()],
			credentialId: args.credentialId,
			force: args.force === true,
		});
		const refusedData = archived._nay?.data && "refusedItems" in archived._nay.data ? archived._nay.data : null;
		// The job stopped inside the request. Its one message is for every found path.
		if (archived._nay && !refusedData) {
			for (const path of pathByNodeId.values()) refused.push({ path, message: archived._nay.message });
			return { jobId: null, isDone: true, refused };
		}
		// Every item was refused before a job started, and `data` has each one's own reason. A path not in
		// the list is inside a refused folder, or it was already archived and is skipped like `rm -f`.
		if (refusedData) {
			const refusedPaths: string[] = [];
			for (const item of refusedData.refusedItems) {
				const path = pathByNodeId.get(item.nodeId)!;
				refusedPaths.push(path);
				refused.push({ path, message: item.refusal.message });
			}
			for (const path of pathByNodeId.values()) {
				if (!refusedPaths.includes(path) && refusedPaths.some((folderPath) => path.startsWith(`${folderPath}/`)))
					refused.push({ path, message: "Not deleted, because a folder above it was not deleted." });
			}
			return { jobId: null, isDone: true, refused };
		}
		if (!archived._yay) {
			return { jobId: null, isDone: true, refused };
		}

		const job = archived._yay;
		const messageByNodeId = new Map(job.refusedItems.map((item) => [item.nodeId, item.message]));
		for (const nodeId of job.notArchivedNodeIds) {
			refused.push({
				path: pathByNodeId.get(nodeId)!,
				// A named path inside a refused folder stays with that folder.
				message: messageByNodeId.get(nodeId) ?? "Not deleted, because a folder above it was not deleted.",
			});
		}
		return { jobId: job.activityId, isDone: job.isDone, refused };
	},
});

type delete_paths_Result =
	typeof delete_paths extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const delete_body_validator = z
	.object({
		force: z.boolean().optional(),
		paths: z.array(z.string()).min(1),
	})
	.strict();

export type public_api_files_organize_http_delete_Body = z.infer<typeof delete_body_validator>;

export async function public_api_files_organize_http_delete(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/delete";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, delete_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	// Count the paths here, not in the schema, so the answer names the limit.
	if (body._yay.paths.length > DELETE_MAX_PATHS) {
		return {
			status: 400,
			body: { message: `Delete at most ${DELETE_MAX_PATHS} paths at once. Split the list into several calls.` },
		} as const;
	}

	const paths: string[] = [];
	for (const rawPath of body._yay.paths) {
		if (!rawPath.startsWith("/")) {
			return { status: 400, body: { message: "Path must be absolute.", path: rawPath } } as const;
		}
		const normalized = server_path_normalize(rawPath);
		if (normalized === "/") {
			return { status: 400, body: { message: "Path must not be the workspace root.", path: rawPath } } as const;
		}
		if (paths.includes(normalized)) {
			return { status: 400, body: { message: "Duplicate path in batch", path: rawPath } } as const;
		}
		paths.push(normalized);
	}

	// One token per call. The archive job also charges the person's tree-write bucket.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
	});
	if (rateLimit) {
		return { status: 429, body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs } } as const;
	}

	let result: delete_paths_Result;
	try {
		result = (await ctx.runMutation(internal.public_api_files_organize.delete_paths, {
			credentialId: principal.credentialId,
			force: body._yay.force === true,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.userId,
			paths,
		})) as delete_paths_Result;
	} catch (error) {
		const failure =
			error instanceof ConvexError
				? z.object({ message: z.string(), data: delete_failure_validator }).safeParse(error.data)
				: null;
		if (!failure?.success) throw error;
		const { status, retryAfterMs } = failure.data.data;
		return { status, body: { message: failure.data.message, retryAfterMs } } as const;
	}
	return { status: 200, body: result, headers: { "Cache-Control": "no-store" } } as const;
}

const TRASH_LIST_MAX_ITEMS = 100;

const trash_key_validator = v.object({
	archiveOperationId: v.string(),
	/**
	 * The `treePath` in an area, or the `name` in a folder: the index field after the delete id.
	 */
	treePathOrName: v.string(),
	createdAt: v.number(),
	nodeId: v.string(),
});

export const get_plugin_trash_access = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		pairId: v.id("plugins_file_pairs"),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const pair = await plugins_file_grants_db_validate_pair(ctx, { pairId: args.pairId, userId: args.userId });
		if (!pair || pair.organizationId !== args.organizationId || pair.workspaceId !== args.workspaceId)
			return "Permission denied";
		// Guests have no Trash. This checks the route once, not each selected file.
		const membership = (await ctx.db.get("organizations_workspaces_users", pair.membershipId))!;
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "content.read",
		});
		return allowed._nay ? "Permission denied" : null;
	},
});

/**
 * One page of one index stream of `files/trash/list`: the archived docs of one area or one folder
 * below `upperKey`, newest archive operation first. `public_api_files_organize_http_trash_list` merges
 * the streams.
 *
 * Every archived doc is listed, not only the top items of the app's Trash view. Two index ranges
 * serve an area. "items" holds the docs of the area. "folders" holds the restricted folders whose
 * parent is in the area: a restricted folder lists in the area of its parent, locked when the
 * caller cannot open it, and its contents list only in its own area. One range serves a folder:
 * "children" holds the archived docs directly inside it, by name.
 */
export const list_trash_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		subject: access_control_subject_validator,
		savedStream: files_saved_stream_validator,
		/**
		 * A restricted folder, or null for the open part of the workspace. Not normalized: it comes from
		 * the request body.
		 */
		areaNodeId: v.union(v.string(), v.null()),
		/**
		 * A folder, live or in Trash, for the "children" stream. Null with "items" and "folders". Not
		 * normalized: it comes from the request body.
		 */
		folderNodeId: v.union(v.string(), v.null()),
		stream: v.union(v.literal("items"), v.literal("folders"), v.literal("children")),
		upperKey: v.union(trash_key_validator, v.null()),
		phase: v.number(),
		numItems: v.number(),
	},
	returns: v.union(
		v.object({
			status: v.union(
				v.literal("denied"),
				v.literal("area_not_found"),
				v.literal("area_locked"),
				v.literal("not_an_area"),
				v.literal("folder_not_found"),
				v.literal("not_a_folder"),
			),
		}),
		v.object({
			status: v.literal("page"),
			rows: v.array(
				v.object({
					nodeId: v.id("files_nodes"),
					path: v.string(),
					name: v.string(),
					kind: v.union(v.literal("file"), v.literal("folder")),
					contentType: v.union(v.string(), v.null()),
					updatedAt: v.number(),
					updatedBy: v.union(v.string(), v.null()),
					assetId: v.union(v.id("files_r2_assets"), v.null()),
					archiveOperationId: v.string(),
					treePathOrName: v.string(),
					createdAt: v.number(),
					locked: v.boolean(),
					top: v.boolean(),
				}),
			),
			frontier: v.union(trash_key_validator, v.null()),
			phaseCount: v.number(),
			isDone: v.boolean(),
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
		if (!membership) return { status: "denied" as const };
		// A guest has no Trash view, like in the app (`files_tree.list_trash_entries`). A key bound to a
		// service account acts as the account, so its person does not count. An account with one folder
		// grant still lists the Trash of that folder.
		if (args.subject.kind === "user") {
			const workspaceRead = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.read",
			});
			if (workspaceRead._nay) return { status: "denied" as const };
		}
		const saved = await files_saved_stream_db_create(ctx.db, args, args.savedStream);

		// Check the area or folder on every page, so one the caller lost access to between pages answers 403.
		let area: Id<"files_nodes"> | null = null;
		let folder: Doc<"files_nodes"> | null = null;
		if (args.folderNodeId !== null) {
			const folderId = ctx.db.normalizeId("files_nodes", args.folderNodeId);
			const folderNode = folderId ? await files_saved_placement_db_get_node(ctx.db, folderId, saved.tag) : null;
			if (
				!folderNode ||
				folderNode.organizationId !== args.organizationId ||
				folderNode.workspaceId !== args.workspaceId
			) {
				return { status: "folder_not_found" as const };
			}
			// The folder may be in Trash too. Account grants still work there, so an account can walk into a
			// deleted folder of its own.
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					...args,
					fileNode: folderNode,
					permission: "content.read",
				}))
			) {
				return { status: "area_locked" as const };
			}
			if (folderNode.kind !== "folder") return { status: "not_a_folder" as const };
			folder = folderNode;
		}
		// The open part needs read at the workspace root. A person passed it with the guest check above. An
		// account needs its own workspace grant.
		else if (args.areaNodeId === null) {
			if (!(await access_control_db_can_act_on_file_node(ctx, { ...args, fileNode: null, permission: "content.read" })))
				return { status: "area_locked" as const };
		} else {
			const areaId = ctx.db.normalizeId("files_nodes", args.areaNodeId);
			const areaNode = areaId ? await files_saved_placement_db_get_node(ctx.db, areaId, saved.tag) : null;
			if (!areaNode || areaNode.organizationId !== args.organizationId || areaNode.workspaceId !== args.workspaceId) {
				return { status: "area_not_found" as const };
			}
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					...args,
					fileNode: areaNode,
					permission: "content.read",
				}))
			) {
				return { status: "area_locked" as const };
			}
			// A file can be a restricted root too, but it holds no other items.
			if (!areaNode.isRestrictedScopeRoot || areaNode.kind !== "folder") return { status: "not_an_area" as const };
			area = areaNode._id;
		}

		const phases = files_index_range_phases({
			fields: [
				"archiveOperationId",
				folder ? "name" : "treePath",
				...(args.savedStream.kind === "cohort" ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"]),
			],
			order: "desc",
			// An active doc has a null `archiveOperationId`, so this range holds the archived docs only.
			start: [null],
			startInclusive: false,
			end: args.upperKey
				? [
						args.upperKey.archiveOperationId,
						args.upperKey.treePathOrName,
						args.upperKey.createdAt,
						args.upperKey.nodeId,
					]
				: [],
			endInclusive: false,
		});
		const phase = phases[args.phase];
		if (!phase) return { status: "page" as const, rows: [], frontier: null, phaseCount: phases.length, isDone: true };
		const range = (q: IndexRange) => files_index_range_apply(q, phase);
		const result = await (
			folder
				? saved.queries.by_parent_archive_name((q) => range(q.eq("parentId", folder._id)))
				: args.stream === "items"
					? saved.queries.by_scope_archive_tree((q) => range(q.eq("restrictedScopeNodeId", area)))
					: saved.queries.by_parent_scope_archive_tree((q) => range(q.eq("parentScopeNodeId", area)))
		)
			.order("desc")
			.paginate({ cursor: null, numItems: args.numItems });

		// The frontier is read before the docs are dropped below. It can name a doc the caller cannot
		// open, so the HTTP action seals it inside the public cursor.
		const last = result.page.at(-1);
		const frontier = last
			? {
					archiveOperationId: last.archiveOperationId!,
					treePathOrName: folder ? last.name : last.treePath,
					createdAt: "nodeId" in last ? last.nodeCreationTime : last._creationTime,
					nodeId: "nodeId" in last ? last.nodeId : last._id,
				}
			: null;
		// "items" drops the area's own folder: it lists in its parent area. "folders" drops a folder that
		// stopped being restricted: it keeps `parentScopeNodeId` only while its scope job runs, so few
		// docs are dropped. "children" drops nothing.
		const nodes = (await saved.read_nodes(result.page)).filter(
			(node) => folder || node.isRestrictedScopeRoot === (args.stream === "folders"),
		);
		const readable = new Set(
			(
				await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					subject: args.subject,
					nodes,
				})
			).map((node) => node._id),
		);
		const rows = await Promise.all(
			nodes.map(async (node) => {
				// A top item is what the app's Trash view lists: its parent is the root, active, or archived by
				// another delete. One parent read per doc in an area. In a folder the parent is that folder.
				const parent =
					folder ??
					(node.parentId === files_ROOT_ID
						? null
						: await files_saved_placement_db_get_node(ctx.db, node.parentId, saved.tag));
				const locked = !readable.has(node._id);
				return {
					nodeId: node._id,
					path: node.path,
					name: node.name,
					kind: node.kind,
					contentType: node.contentType,
					updatedAt: node.updatedAt,
					// Locked, not hidden: a locked row shows name, type, size and dates only.
					updatedBy: locked ? null : node.updatedBy,
					assetId: node.assetId,
					archiveOperationId: node.archiveOperationId!,
					treePathOrName: folder ? node.name : node.treePath,
					createdAt: node._creationTime,
					locked,
					top: parent?.archiveOperationId !== node.archiveOperationId,
				};
			}),
		);
		return { status: "page" as const, rows, frontier, phaseCount: phases.length, isDone: result.isDone };
	},
});

type list_trash_page_Result =
	typeof list_trash_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type TrashKey = Infer<typeof trash_key_validator>;

function compare_trash_keys(a: TrashKey, b: TrashKey) {
	return compareValues(
		[a.archiveOperationId, a.treePathOrName, a.createdAt, a.nodeId],
		[b.archiveOperationId, b.treePathOrName, b.createdAt, b.nodeId],
	);
}

const trash_list_body_validator = z
	.object({
		areaNodeId: z.string().min(1).max(64).nullable().optional(),
		/**
		 * A folder, live or in Trash: list the items in Trash directly inside it. Use it instead of
		 * `areaNodeId` when the caller can open the folder but not its area.
		 */
		folderNodeId: z.string().min(1).max(64).optional(),
		// A real cursor is about 1.4 KB. The cap stops a huge string before the server decodes it.
		cursor: z.string().max(16384).nullable().optional(),
		limit: z.number().int().min(1).max(TRASH_LIST_MAX_ITEMS).optional(),
	})
	.strict();

export type public_api_files_organize_http_trash_list_Body = z.infer<typeof trash_list_body_validator>;

/**
 * `files/trash/list`: every archived item of one area, or directly inside one folder, newest delete
 * first. Each page merges the "items" and "folders" streams of `list_trash_page` (or its one "children"
 * stream for a folder) for the normal saved stream and, during a Move, the Move view, like
 * `files_saved_list_page` does for a folder list.
 */
export async function public_api_files_organize_http_trash_list(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/trash/list";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:list" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const { principal, pluginCallId } = auth._yay;
	const userId = public_api_visibility_user_id(principal);

	// Authorizing claimed a plugin run's call slot. A run that ends with a call still open fails, so settle
	// it on every answer below.
	const answer = await (async (/* iife */) => {
		if (principal.kind !== "user_api_key") {
			if (principal.subject.kind !== "plugin_pair")
				return {
					status: 403,
					body: { message: "Switch this plugin to personal file permissions to use Trash." },
				} as const;
			const denied: string | null = await ctx.runQuery(internal.public_api_files_organize.get_plugin_trash_access, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				userId,
				pairId: principal.subject.pairId,
			});
			if (denied !== null) return { status: 403, body: { message: denied } } as const;
		}
		const body = await server_request_json_parse_and_validate(request, trash_list_body_validator);
		if (body._nay) {
			return { status: 400, body: { message: body._nay.message } } as const;
		}
		if (body._yay.areaNodeId !== undefined && body._yay.folderNodeId !== undefined) {
			return { status: 400, body: { message: "Send either areaNodeId or folderNodeId." } } as const;
		}
		const numItems = body._yay.limit ?? TRASH_LIST_MAX_ITEMS;
		const areaNodeId = body._yay.areaNodeId ?? null;
		const folderNodeId = body._yay.folderNodeId ?? null;

		const viewArgs = {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			visibilityUserId: userId,
			subject: principal.subject,
			folderPath: "/",
		};
		const memberArgs = {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId,
		};
		const [view, membership] = await Promise.all([
			ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
			ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
		]);
		if (!view || !membership) {
			return { status: 403, body: { message: "Permission denied" } } as const;
		}
		const sources: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
		if (view.cohortId !== null && view.view !== null) {
			sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
		}
		// Source order follows migration. A doc moved between these reads is seen at least once.
		if (view.migrationDirection === "to_normal") sources.reverse();

		// The area and folder are in the scope, so a cursor works only for the place it was made for.
		const scope = JSON.stringify([
			principal.principalKey,
			principal.subject,
			membership,
			areaNodeId,
			folderNodeId,
			sources,
		]);
		// Like `files/list`, only this error has a code: clients restart with `cursor: null` on it.
		const invalid_cursor = {
			status: 400,
			body: { message: "This Trash cursor changed. Start a new page.", errorCode: "invalid_cursor" as const },
		} as const;
		let upperKey: TrashKey | null = null;
		if (body._yay.cursor != null) {
			let opened: unknown;
			try {
				opened = await crypto_open_cursor({ purpose: "files_trash_list", scope, cursor: body._yay.cursor });
			} catch (error) {
				if (!(error instanceof ConvexError)) throw error;
				return invalid_cursor;
			}
			if (!validate(v.object({ upperKey: trash_key_validator }), opened)) return invalid_cursor;
			upperKey = opened.upperKey;
		}

		type Row = Extract<list_trash_page_Result, { status: "page" }>["rows"][number];
		const key_of = (row: Row): TrashKey => ({
			archiveOperationId: row.archiveOperationId,
			treePathOrName: row.treePathOrName,
			createdAt: row.createdAt,
			nodeId: row.nodeId,
		});
		const page: Row[] = [];
		let isDone = false;
		// A page can be short with a cursor: rows past the first unfinished stream wait for the next round.
		for (let round = 0; round < 8 && page.length < numItems; round++) {
			const batches: Array<{ rows: Row[]; frontier: TrashKey | null; done: boolean }> = [];
			for (const source of sources) {
				for (const stream of folderNodeId !== null ? (["children"] as const) : (["items", "folders"] as const)) {
					for (let phase = 0; ; phase++) {
						let result: list_trash_page_Result;
						try {
							result = (await ctx.runQuery(internal.public_api_files_organize.list_trash_page, {
								organizationId: principal.organizationId,
								workspaceId: principal.workspaceId,
								userId,
								subject: principal.subject,
								savedStream: source,
								areaNodeId,
								folderNodeId,
								stream,
								upperKey,
								phase,
								numItems: numItems - page.length,
							})) as list_trash_page_Result;
						} catch (error) {
							if (
								!(error instanceof ConvexError) ||
								!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
							)
								throw error;
							return invalid_cursor;
						}
						if (result.status === "area_not_found") {
							return { status: 404, body: { message: "Area not found" } } as const;
						}
						if (result.status === "folder_not_found") {
							return { status: 404, body: { message: "Folder not found" } } as const;
						}
						if (result.status === "not_a_folder") {
							return { status: 400, body: { message: "folderNodeId must name a folder." } } as const;
						}
						if (result.status === "denied" || result.status === "area_locked") {
							return { status: 403, body: { message: "Permission denied" } } as const;
						}
						if (result.status === "not_an_area") {
							return {
								status: 400,
								body: { message: "areaNodeId must name a restricted folder. Use null for the rest of the workspace." },
							} as const;
						}
						const done = result.isDone && phase + 1 >= result.phaseCount;
						if (result.frontier || done) {
							batches.push({ rows: result.rows, frontier: done ? null : result.frontier, done });
							break;
						}
					}
				}
			}
			// Keep only rows above the highest unfinished frontier: a stream may still hold rows before it.
			const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
			frontiers.sort((a, b) => compare_trash_keys(b, a));
			const windowEnd = frontiers[0] ?? null;
			const rows = batches
				.flatMap((batch) => batch.rows)
				.filter((row) => windowEnd === null || compare_trash_keys(key_of(row), windowEnd) >= 0)
				.sort((a, b) => compare_trash_keys(key_of(b), key_of(a)));
			// Staging or cleanup may expose the same node in both sources.
			const seen = new Set<Id<"files_nodes">>(page.map((row) => row.nodeId));
			const unique = rows.filter((row) => {
				if (seen.has(row.nodeId)) return false;
				seen.add(row.nodeId);
				return true;
			});
			const remaining = numItems - page.length;
			if (unique.length > remaining) {
				page.push(...unique.slice(0, remaining));
				upperKey = key_of(page.at(-1)!);
				break;
			}
			page.push(...unique);
			isDone = batches.every((batch) => batch.done);
			upperKey = windowEnd ?? (page.length > 0 ? key_of(page.at(-1)!) : upperKey);
			if (isDone) break;
		}

		// A Move that started or ended during the page changes the sources, so the page could miss rows.
		const [currentView, currentMembership] = await Promise.all([
			ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
			ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
		]);
		if (
			!currentView ||
			currentView.generation !== view.generation ||
			currentView.cohortId !== view.cohortId ||
			currentView.view !== view.view ||
			currentView.migrationDirection !== view.migrationDirection ||
			JSON.stringify(currentMembership) !== JSON.stringify(membership)
		) {
			return invalid_cursor;
		}

		const assetIds = page.flatMap((row) => (row.kind === "file" && row.assetId ? [row.assetId] : []));
		const assetStates: r2_get_assets_ready_states_Result =
			assetIds.length > 0 ? await ctx.runQuery(internal.r2.get_assets_ready_states, { assetIds }) : {};

		return {
			status: 200,
			body: {
				items: page.map((row) => {
					const assetState = row.assetId ? assetStates[row.assetId] : undefined;
					return {
						path: row.path,
						name: row.name,
						kind: row.kind,
						nodeId: row.nodeId,
						contentType: row.contentType,
						updatedAt: row.updatedAt,
						size: assetState ? assetState.size : null,
						locked: row.locked,
						archiveOperationId: row.archiveOperationId,
						// The time inside the archive operation id.
						operationAt: files_archive_operation_id_time(row.archiveOperationId),
						// The last person who changed the item, the app's "Changed by". Usually this is who deleted it.
						// After a restore with Skip, it is who restored it, because Skip puts the item in a new delete.
						changedBy: row.updatedBy,
						top: row.top,
					};
				}),
				// `upperKey` can name a row the caller cannot open, so the cursor hides it.
				cursor: isDone ? null : await crypto_seal_cursor({ purpose: "files_trash_list", scope, payload: { upperKey } }),
				isDone,
			},
			headers: { "Cache-Control": "no-store" },
		} as const;
	})();
	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: answer.status === 200 ? "succeeded" : "failed",
		responseStatus: answer.status,
		...(answer.status === 200 ? {} : { errorMessage: answer.body.message }),
	});
	return answer;
}

const TRASH_AREAS_MAX_ITEMS = 100;

// Applied eligibility owns this page. Human access changes reach it through the grant worker.
export const list_plugin_trash_areas_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pairId: v.id("plugins_file_pairs"),
		savedStream: files_saved_stream_validator,
		cursor: v.union(v.string(), v.null()),
		numItems: v.number(),
	},
	returns: v.union(
		v.object({ status: v.literal("denied") }),
		v.object({
			status: v.literal("page"),
			rows: v.array(v.object({ nodeId: v.id("files_nodes"), path: v.string() })),
			cursor: v.string(),
			isDone: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const pair = await plugins_file_grants_db_validate_pair(ctx, { pairId: args.pairId });
		if (!pair || pair.organizationId !== args.organizationId || pair.workspaceId !== args.workspaceId)
			return { status: "denied" as const };
		const saved = await files_saved_stream_db_create(ctx.db, args, args.savedStream);
		const result = await ctx.db
			.query("plugins_file_consents")
			.withIndex("by_pair_areaEligible", (q) => q.eq("pairId", args.pairId).eq("areaEligible", true))
			.paginate({ cursor: args.cursor, numItems: args.numItems });
		const rows = await Promise.all(
			result.page.map(async (consent) => {
				const node = await files_saved_placement_db_get_node(ctx.db, consent.rootNodeId, saved.tag);
				// Purge drains consent before deleting the saved node.
				if (!node) throw should_never_happen("Plugin Trash area has no saved node", { consentId: consent._id });
				return { nodeId: node._id, path: node.path };
			}),
		);
		return { status: "page" as const, rows, cursor: result.continueCursor, isDone: result.isDone };
	},
});

type list_plugin_trash_areas_page_Result =
	typeof list_plugin_trash_areas_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const trash_area_key_validator = v.object({ treePath: v.string(), nodeId: v.string() });

type TrashAreaKey = Infer<typeof trash_area_key_validator>;

function compare_trash_area_keys(a: TrashAreaKey, b: TrashAreaKey) {
	return compareValues([a.treePath, a.nodeId], [b.treePath, b.nodeId]);
}

/**
 * One page of one stream of `files/trash/areas`: the active restricted folders after `afterKey`, by
 * `treePath`. Like the app's area picker (`files_tree.list_archive_areas`), the owner reads every
 * restricted folder on principal 0 and gets empty pages for 1 to 3. A member reads the share rows of
 * one principal. A key bound to a service account reads the account's own shares on principal 0 and
 * its role's shares on principal 1. `public_api_files_organize_http_trash_areas` merges the streams.
 */
export const list_trash_areas_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		subject: access_control_subject_validator,
		savedStream: files_saved_stream_validator,
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
		afterKey: v.union(trash_area_key_validator, v.null()),
		numItems: v.number(),
	},
	returns: v.union(
		v.object({ status: v.literal("denied") }),
		v.object({
			status: v.literal("page"),
			rows: v.array(v.object({ nodeId: v.id("files_nodes"), path: v.string(), treePath: v.string() })),
			frontier: v.union(trash_area_key_validator, v.null()),
			isDone: v.boolean(),
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
		if (!membership) return { status: "denied" as const };
		// A guest has no Trash view, like in the app. A key bound to a service account acts as the account,
		// so its person does not count.
		if (args.subject.kind === "user") {
			const workspaceRead = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.read",
			});
			if (workspaceRead._nay) return { status: "denied" as const };
		}
		// The membership check above refused an organization without a default workspace.
		const organization = (await ctx.db.get("organizations", args.organizationId))!;
		const saved = await files_saved_stream_db_create(ctx.db, args, args.savedStream);
		const empty = { status: "page" as const, rows: [], frontier: null, isDone: true };

		// Start at the cursor path itself: another view can hold another folder at the same path.
		let read: Array<{ key: TrashAreaKey; node: Doc<"files_nodes"> | null }>;
		if (args.subject.kind === "user" && organization.ownerUserId === args.userId) {
			if (args.principalIndex !== 0) return empty;
			const nodes = await saved.read_nodes(
				await saved.queries
					.by_archive_restricted_kind_tree((q) => {
						const roots = q.eq("archiveOperationId", null).eq("isRestrictedScopeRoot", true).eq("kind", "folder");
						return args.afterKey ? roots.gte("treePath", args.afterKey.treePath) : roots;
					})
					.take(args.numItems),
			);
			read = nodes.map((node) => ({ key: { treePath: node.treePath, nodeId: node._id }, node }));
		} else {
			let principalKey: string | null;
			if (args.subject.kind === "service_account") {
				// An account has no workspace shares: it reads a restricted folder only through its own grant
				// or its role (`db_has_account_scope_grant`).
				const account = await ctx.db.get("access_control_service_accounts", args.subject.serviceAccountId);
				principalKey =
					[
						files_share_rows_principal_key("service_account", args.subject.serviceAccountId),
						account?.role !== undefined ? files_share_rows_principal_key("role", account.role) : null,
					][args.principalIndex] ?? null;
			} else {
				principalKey =
					(
						await files_tree_db_get_share_principal_keys(ctx, {
							userAuth: { id: args.userId },
							membership,
							defaultWorkspaceId: organization.defaultWorkspaceId!,
							hasWorkspaceRead: true,
						})
					)[args.principalIndex] ?? null;
			}
			if (!principalKey) return empty;
			const { tag } = saved;
			const shareRows = await ctx.db
				.query("files_share_rows")
				.withIndex("by_org_ws_principal_restricted_kind_archive_treePath", (q) => {
					const shares = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("principalKey", principalKey)
						.eq("moveView.cohortId", tag?.cohortId)
						.eq("moveView.view", tag?.view)
						.eq("isRestrictedScopeRoot", true)
						.eq("kind", "folder")
						.eq("archiveOperationId", null);
					return args.afterKey ? shares.gte("treePath", args.afterKey.treePath) : shares;
				})
				.take(args.numItems);
			read = await Promise.all(
				shareRows.map(async (shareRow) => ({
					key: { treePath: shareRow.treePath, nodeId: shareRow.nodeId },
					node: await files_saved_placement_db_get_node(ctx.db, shareRow.nodeId, shareRow.moveView),
				})),
			);
		}

		// The frontier is read before the rows are dropped below. It can name a folder the caller cannot
		// open, so the HTTP action seals it inside the public cursor.
		const frontier = read.at(-1)?.key ?? null;
		// A share row is a copy, so check its node again. Rows the last page already had are left out too.
		const nodes = read.flatMap(({ key, node }) =>
			node &&
			node.organizationId === args.organizationId &&
			node.workspaceId === args.workspaceId &&
			node.archiveOperationId === null &&
			node.restrictedScopeNodeId === node._id &&
			(args.afterKey === null || compare_trash_area_keys(key, args.afterKey) > 0)
				? [node]
				: [],
		);
		const readable = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			subject: args.subject,
			nodes,
		});
		return {
			status: "page" as const,
			rows: readable.map((node) => ({ nodeId: node._id, path: node.path, treePath: node.treePath })),
			frontier,
			isDone: read.length < args.numItems,
		};
	},
});

type list_trash_areas_page_Result =
	typeof list_trash_areas_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const trash_areas_body_validator = z
	.object({
		// A real cursor is about 1.4 KB. The cap stops a huge string before the server decodes it.
		cursor: z.string().max(16384).nullable().optional(),
		limit: z.number().int().min(1).max(TRASH_AREAS_MAX_ITEMS).optional(),
	})
	.strict();

export type public_api_files_organize_http_trash_areas_Body = z.infer<typeof trash_areas_body_validator>;

/**
 * `files/trash/areas`: the Trash areas the key can open, for `files/trash/list`. The first page starts
 * with the open part of the workspace (`areaNodeId: null`) when the key can open the workspace root.
 * Then come the restricted folders the key can open, by path. Each page merges the principal streams
 * of `list_trash_areas_page` for the normal saved stream and, during a Move, the Move view, like
 * `files_saved_list_page` does for a folder list.
 * Plugins page their applied folder consents in consent order, with paths from the saved view.
 */
export async function public_api_files_organize_http_trash_areas(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/trash/areas";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:list" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const { principal, pluginCallId } = auth._yay;
	const userId = public_api_visibility_user_id(principal);

	// Authorizing claimed a plugin run's call slot. A run that ends with a call still open fails, so settle
	// it on every answer below.
	const answer = await (async (/* iife */) => {
		if (principal.kind !== "user_api_key") {
			if (principal.subject.kind !== "plugin_pair")
				return {
					status: 403,
					body: { message: "Switch this plugin to personal file permissions to use Trash." },
				} as const;
			const denied: string | null = await ctx.runQuery(internal.public_api_files_organize.get_plugin_trash_access, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				userId,
				pairId: principal.subject.pairId,
			});
			if (denied !== null) return { status: 403, body: { message: denied } } as const;
		}
		const body = await server_request_json_parse_and_validate(request, trash_areas_body_validator);
		if (body._nay) {
			return { status: 400, body: { message: body._nay.message } } as const;
		}
		// The open part of the workspace counts as one item of the first page. It needs read at the workspace
		// root, which an account with only folder grants does not have. The root answers "missing" when the
		// caller can open it. A guest gets 403 from the streams below.
		const withOpenArea =
			principal.subject.kind !== "plugin_pair" &&
			body._yay.cursor == null &&
			(
				await ctx.runQuery(internal.files_nodes.get_path_access, {
					organizationId: principal.organizationId,
					workspaceId: principal.workspaceId,
					subject: principal.subject,
					path: "/",
				})
			).status === "missing";
		const numItems = (body._yay.limit ?? TRASH_AREAS_MAX_ITEMS) - (withOpenArea ? 1 : 0);

		const viewArgs = {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			visibilityUserId: userId,
			subject: principal.subject,
			folderPath: "/",
		};
		const memberArgs = {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId,
		};
		const [view, membership] = await Promise.all([
			ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
			ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
		]);
		if (!view || !membership) {
			return { status: 403, body: { message: "Permission denied" } } as const;
		}
		const sources: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
		if (view.cohortId !== null && view.view !== null) {
			sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
		}
		// Source order follows migration. A doc moved between these reads is seen at least once.
		if (view.migrationDirection === "to_normal") sources.reverse();

		const scope = JSON.stringify([principal.principalKey, principal.subject, membership, sources]);
		// Like `files/trash/list`, only this error has a code: clients restart with `cursor: null` on it.
		const invalid_cursor = {
			status: 400,
			body: { message: "This Trash cursor changed. Start a new page.", errorCode: "invalid_cursor" as const },
		} as const;
		if (principal.subject.kind === "plugin_pair") {
			const pluginScope = JSON.stringify([path, principal.organizationId, principal.workspaceId, scope]);
			let cursor: string | null = null;
			if (body._yay.cursor != null) {
				let opened: unknown;
				try {
					opened = await crypto_open_cursor({
						purpose: "files_trash_areas",
						scope: pluginScope,
						cursor: body._yay.cursor,
					});
				} catch (error) {
					if (!(error instanceof ConvexError)) throw error;
					return invalid_cursor;
				}
				if (!validate(v.object({ cursor: v.string() }), opened)) return invalid_cursor;
				cursor = opened.cursor;
			}
			let result: list_plugin_trash_areas_page_Result;
			try {
				result = await ctx.runQuery(internal.public_api_files_organize.list_plugin_trash_areas_page, {
					organizationId: principal.organizationId,
					workspaceId: principal.workspaceId,
					pairId: principal.subject.pairId,
					savedStream: sources.find((source) => source.kind === "cohort") ?? sources[0]!,
					cursor,
					numItems,
				});
			} catch (error) {
				if (
					!(error instanceof ConvexError) ||
					!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
				)
					throw error;
				return invalid_cursor;
			}
			if (result.status === "denied") return { status: 403, body: { message: "Permission denied" } } as const;
			const [currentView, currentMembership] = await Promise.all([
				ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
				ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
			]);
			if (
				!currentView ||
				JSON.stringify(currentView) !== JSON.stringify(view) ||
				JSON.stringify(currentMembership) !== JSON.stringify(membership)
			)
				return invalid_cursor;
			return {
				status: 200,
				body: {
					areas: result.rows.map((row) => ({ areaNodeId: row.nodeId as string | null, path: row.path })),
					cursor: result.isDone
						? null
						: await crypto_seal_cursor({
								purpose: "files_trash_areas",
								scope: pluginScope,
								payload: { cursor: result.cursor },
							}),
					isDone: result.isDone,
				},
				headers: { "Cache-Control": "no-store" },
			} as const;
		}
		let afterKey: TrashAreaKey | null = null;
		if (body._yay.cursor != null) {
			let opened: unknown;
			try {
				opened = await crypto_open_cursor({ purpose: "files_trash_areas", scope, cursor: body._yay.cursor });
			} catch (error) {
				if (!(error instanceof ConvexError)) throw error;
				return invalid_cursor;
			}
			if (!validate(v.object({ afterKey: v.union(trash_area_key_validator, v.null()) }), opened)) return invalid_cursor;
			afterKey = opened.afterKey;
		}

		type Row = Extract<list_trash_areas_page_Result, { status: "page" }>["rows"][number];
		const key_of = (row: Row): TrashAreaKey => ({ treePath: row.treePath, nodeId: row.nodeId });
		const page: Row[] = [];
		let isDone = false;
		// A page can be short with a cursor: rows past the first unfinished stream wait for the next round.
		// The first round runs even with `limit: 1`, so a guest still gets 403.
		for (let round = 0; round < 8 && (round === 0 || page.length < numItems); round++) {
			const batches: Array<{ rows: Row[]; frontier: TrashAreaKey | null; done: boolean }> = [];
			for (const source of sources) {
				for (const principalIndex of [0, 1, 2, 3] as const) {
					let result: list_trash_areas_page_Result;
					try {
						result = (await ctx.runQuery(internal.public_api_files_organize.list_trash_areas_page, {
							organizationId: principal.organizationId,
							workspaceId: principal.workspaceId,
							userId,
							subject: principal.subject,
							savedStream: source,
							principalIndex,
							afterKey,
							// One more, because the first row can be the cursor row itself.
							numItems: numItems - page.length + 1,
						})) as list_trash_areas_page_Result;
					} catch (error) {
						// A Move that started or ended during the page changes its saved view.
						if (
							!(error instanceof ConvexError) ||
							!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
						)
							throw error;
						return invalid_cursor;
					}
					if (result.status === "denied") {
						return { status: 403, body: { message: "Permission denied" } } as const;
					}
					batches.push({ rows: result.rows, frontier: result.isDone ? null : result.frontier, done: result.isDone });
				}
			}
			// Keep only rows up to the lowest unfinished frontier: a stream may still hold rows before it.
			const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
			frontiers.sort(compare_trash_area_keys);
			const windowEnd = frontiers[0] ?? null;
			const rows = batches
				.flatMap((batch) => batch.rows)
				.filter((row) => windowEnd === null || compare_trash_area_keys(key_of(row), windowEnd) <= 0)
				.sort((a, b) => compare_trash_area_keys(key_of(a), key_of(b)));
			// A folder shared with several principals is in several streams. Staging or cleanup may expose the
			// same folder in both sources too.
			const seen = new Set<Id<"files_nodes">>(page.map((row) => row.nodeId));
			const unique = rows.filter((row) => {
				if (seen.has(row.nodeId)) return false;
				seen.add(row.nodeId);
				return true;
			});
			const remaining = numItems - page.length;
			if (unique.length > remaining) {
				page.push(...unique.slice(0, remaining));
				// With `limit: 1` the first page holds only the open area, so the next page starts at the top.
				if (page.length > 0) afterKey = key_of(page.at(-1)!);
				break;
			}
			page.push(...unique);
			isDone = batches.every((batch) => batch.done);
			afterKey = windowEnd ?? (page.length > 0 ? key_of(page.at(-1)!) : afterKey);
			if (isDone) break;
		}

		// A Move that started or ended during the page changes the sources, so the page could miss rows.
		const [currentView, currentMembership] = await Promise.all([
			ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
			ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
		]);
		if (
			!currentView ||
			currentView.generation !== view.generation ||
			currentView.cohortId !== view.cohortId ||
			currentView.view !== view.view ||
			currentView.migrationDirection !== view.migrationDirection ||
			JSON.stringify(currentMembership) !== JSON.stringify(membership)
		) {
			return invalid_cursor;
		}

		return {
			status: 200,
			body: {
				areas: [
					...(withOpenArea ? [{ areaNodeId: null, path: "/" }] : []),
					...page.map((row) => ({ areaNodeId: row.nodeId as string | null, path: row.path })),
				],
				// `afterKey` can name a folder the caller cannot open, so the cursor hides it.
				cursor: isDone
					? null
					: await crypto_seal_cursor({ purpose: "files_trash_areas", scope, payload: { afterKey } }),
				isDone,
			},
			headers: { "Cache-Control": "no-store" },
		} as const;
	})();
	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: answer.status === 200 ? "succeeded" : "failed",
		responseStatus: answer.status,
		...(answer.status === 200 ? {} : { errorMessage: answer.body.message }),
	});
	return answer;
}

/**
 * Each path or node can come from its own delete, and each delete starts its own job in this one
 * mutation. A member's key used about 16 database queries per path, so 200 paths came close to the
 * 4,096 query limit. 100 leaves room for restricted folders, which cost more access reads.
 */
const RESTORE_MAX_ITEMS = 100;

const restore_failure_validator = z.object({
	status: z.union([z.literal(401), z.literal(403), z.literal(409), z.literal(429)]),
	/** Set on 429. */
	retryAfterMs: z.number().optional(),
});

/**
 * Restore the named items from the Trash with the app's restore job. Each path names the archived item
 * at that path. Each node names one archived item by id, with the `archiveOperationId` the caller saw
 * in `files/trash/list`. The job brings back only each selected item and its descendants with the
 * same delete id, one job per delete. An item that is missing, locked, or not archived is refused
 * alone, and the other items are still restored.
 */
export const restore_items = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Absolute, normalized paths, not the root. Empty when `nodes` names the items. */
		paths: v.array(v.string()),
		/** Empty when `paths` names the items. Not normalized: the ids come from the request body. */
		nodes: v.array(v.object({ nodeId: v.string(), archiveOperationId: v.string() })),
		onConflict: v.union(v.literal("keep_both"), v.literal("skip")),
		/** Null for a dry run (`preview_restore`), which saves no request to retry. */
		requestId: v.union(v.string(), v.null()),
	},
	returns: v.object({
		jobIds: v.array(v.id("activities")),
		isDone: v.boolean(),
		refused: v.array(
			v.union(
				v.object({ path: v.string(), message: v.string() }),
				v.object({ nodeId: v.string(), path: v.union(v.string(), v.null()), message: v.string() }),
			),
		),
	}),
	handler: async (ctx, args) => {
		const fail = (failArgs: z.infer<typeof restore_failure_validator> & { message: string }) =>
			convex_error({
				message: failArgs.message,
				data: {
					status: failArgs.status,
					...(failArgs.retryAfterMs !== undefined ? { retryAfterMs: failArgs.retryAfterMs } : {}),
				},
			});

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: { kind: "user_api_key", credentialId: args.credentialId },
			force: args.force === true,
			// Each item is checked below, so a restore by nodes passes the root like `write-many` does.
			path: args.paths[0] ?? "/",
			eachPathChecked: true,
			now: Date.now(),
		});
		if (revalidated._nay) {
			throw fail({
				message: revalidated._nay.message,
				status: revalidated._nay.message === "Unauthenticated" ? 401 : 403,
			});
		}
		// A key bound to a service account acts as the account here and at every step of the job, like
		// `delete`. The person still owns the job, its Activity, and its rate buckets.
		const { writeContext } = revalidated._yay;
		const { subject } = writeContext;

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
			throw fail({ message: "Unauthenticated", status: 401 });
		}

		// Look for an earlier run first: after a finished restore, the items are no longer archived. The
		// key's id in the request id keeps it apart from the request ids of other keys.
		const requestId = args.requestId === null ? null : `api:${args.credentialId}:${args.requestId}`;
		// Only opting into force changes the request identity. A paths request hashes the bare paths list,
		// and a nodes request adds a "nodes" tag, so the two can never share a hash.
		const inputHash = await crypto_sha256_hex(
			JSON.stringify([
				...(args.nodes.length > 0 ? ["nodes", args.nodes] : [args.paths]),
				args.onConflict,
				...(args.force === true ? [true] : []),
			]),
		);
		const previous =
			requestId === null
				? null
				: await ctx.db
						.query("files_archive_runs")
						.withIndex("by_user_workspace_apiRequest", (q) =>
							q.eq("userId", args.userId).eq("workspaceId", args.workspaceId).eq("apiRequest.requestId", requestId),
						)
						.unique();
		if (previous?.apiRequest) {
			if (previous.apiRequest.inputHash !== inputHash) {
				throw fail({
					message: "This requestId was already used for another request. Send a new requestId.",
					status: 409,
				});
			}
			// At most one job per path or node, so at most 100 reads.
			const activities = await Promise.all(
				previous.apiRequest.activityIds.map((activityId) => ctx.db.get("activities", activityId)),
			);
			return {
				jobIds: previous.apiRequest.activityIds,
				// History cleanup deletes a job 7 days after it ends.
				isDone: activities.every((activity) => !activity || !activities_is_active(activity.status)),
				refused: previous.apiRequest.refused,
			};
		}

		// The same bucket as Restore in the app, so a key cannot restore faster than its person.
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) {
			throw fail({ message: rateLimit.message, status: 429, retryAfterMs: rateLimit.retryAfterMs });
		}

		// Resolve each path or node to its archived item, as the key. Locked answers "Permission denied",
		// never "Not found". Each item costs a few index reads, never a read of a whole folder.
		type Selector = { path: string } | { nodeId: string; path: string | null };
		const refused: Array<Selector & { message: string }> = [];
		const nodes: Doc<"files_nodes">[] = [];
		const selectorsByOperationId = new Map<string, Selector[]>();
		const add_node = (node: Doc<"files_nodes">, selector: Selector) => {
			nodes.push(node);
			const selectors = selectorsByOperationId.get(node.archiveOperationId!) ?? [];
			selectorsByOperationId.set(node.archiveOperationId!, [...selectors, selector]);
		};
		for (const path of args.paths) {
			// Two reads are enough to tell one archived item from several.
			const archived = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", path)
						.gt("archiveOperationId", null),
				)
				.take(2);
			// No archived item here. Answer like the tree does, so a path inside a locked folder stays
			// "Permission denied" whether it exists or not.
			if (archived.length === 0) {
				const access = await files_db_get_path_access(ctx, { ...args, subject, path });
				refused.push({
					path,
					message:
						access.status === "locked"
							? "Permission denied"
							: access.status === "found"
								? "Not in the Trash"
								: "Not found",
				});
				continue;
			}

			// An archived item the key cannot open is locked, like a locked row in its folder.
			let isReadable = true;
			for (const fileNode of archived) {
				isReadable &&= await access_control_db_can_act_on_file_node(ctx, {
					...args,
					subject,
					fileNode,
					permission: "content.read",
				});
			}
			if (!isReadable) {
				refused.push({ path, message: "Permission denied" });
				continue;
			}
			// The same path was archived more than once, for example after a new item took the name.
			if (archived.length > 1) {
				refused.push({
					path,
					message:
						"Several deleted items have this path. Find the one you want in files/trash/list and restore it by nodes.",
				});
				continue;
			}

			// Per node, like Restore in the app. An archived node keeps the restricted scope it had.
			const node = archived[0]!;
			if (
				!(await files_write_policy_db_has_write_context_permission(ctx, {
					...args,
					writeContext,
					membership,
					node,
					permission: "content.write",
				}))
			) {
				refused.push({ path, message: "Permission denied" });
				continue;
			}
			add_node(node, { path });
		}
		for (const selector of args.nodes) {
			const nodeId = ctx.db.normalizeId("files_nodes", selector.nodeId);
			// Read the item where the saved view shows it, like `files/trash/list` does. A published Move
			// shows its new place and Trash stamp before its cleanup rewrites the node doc.
			const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
			if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
				refused.push({ nodeId: selector.nodeId, path: null, message: "Not found" });
				continue;
			}
			// Check access before the item's state, so a locked item does not tell whether it changed.
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					...args,
					subject,
					fileNode: node,
					permission: "content.read",
				}))
			) {
				refused.push({ nodeId: selector.nodeId, path: null, message: "Permission denied" });
				continue;
			}
			// The item was restored, or restored and deleted again, since the caller listed it. Never restore
			// another delete than the one the caller saw.
			if (node.archiveOperationId !== selector.archiveOperationId) {
				refused.push({
					nodeId: selector.nodeId,
					path: node.path,
					message: "This Trash item changed. List the Trash and pick it again.",
				});
				continue;
			}
			if (
				!(await files_write_policy_db_has_write_context_permission(ctx, {
					...args,
					writeContext,
					membership,
					node,
					permission: "content.write",
				}))
			) {
				refused.push({ nodeId: selector.nodeId, path: node.path, message: "Permission denied" });
				continue;
			}
			add_node(node, { nodeId: selector.nodeId, path: node.path });
		}
		if (nodes.length === 0) {
			return { jobIds: [], isDone: true, refused };
		}

		const restored = await files_nodes_db_restore_named_nodes(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodes,
			credentialId: args.credentialId,
			force: args.force === true,
			// Nobody can answer a question for an API job, so the choice is made up front.
			applyToRemaining: { file: args.onConflict, folder: args.onConflict },
			stopAtRefusal: false,
		});
		// A refused delete operation refuses every path or node that named an item of it.
		for (const refusal of restored.refusals) {
			for (const selector of selectorsByOperationId.get(refusal.archiveOperationId)!) {
				refused.push({ ...selector, message: refusal.nay.message });
			}
		}

		// The jobs include a job that stopped partway, because it keeps what it restored.
		const jobIds = restored.jobs.map((job) => job.activityId);
		// An API restore always keeps its jobs, so one of them can hold the request for a retry. Use the
		// last one: the jobs run one after another, so it ends last, and history cleanup deletes it last.
		const lastJob = restored.jobs.at(-1);
		if (lastJob && requestId !== null) {
			await ctx.db.patch("files_archive_runs", lastJob.runId, {
				apiRequest: { requestId, inputHash, refused, activityIds: jobIds },
			});
		}
		return { jobIds, isDone: restored.jobs.every((job) => job.isDone), refused };
	},
});

type restore_items_Result =
	typeof restore_items extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * `files/restore` with `dryRun`: run the real restore, read each job like `files/jobs/get` does, then
 * throw so Convex undoes every write of this mutation. Files, jobs, Activity and scheduled steps are
 * never saved. The preview uses the same code as the restore, so the two cannot drift apart.
 *
 * The restore runs in a nested mutation, so its own end-of-mutation work runs before the reads here.
 * Only the first step of each job runs in the request. A big delete or a job that waits for another
 * one is not finished, and the preview says so.
 */
export const preview_restore = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		paths: v.array(v.string()),
		nodes: v.array(v.object({ nodeId: v.string(), archiveOperationId: v.string() })),
		onConflict: v.union(v.literal("keep_both"), v.literal("skip")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const restored = (await ctx.runMutation(internal.public_api_files_organize.restore_items, {
			...args,
			requestId: null,
		})) as restore_items_Result;
		const jobs = [];
		for (const jobId of restored.jobIds) {
			const job = (await ctx.runQuery(internal.public_api_files_organize.get_job, {
				credentialId: args.credentialId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				jobId,
				cursor: null,
			})) as get_job_Result;
			if (!job) throw should_never_happen("A restore job of this request is missing", { jobId });
			// The job id names nothing after the rollback, so leave it out.
			const { jobId: _jobId, refusedCursor, ...preview } = job;
			jobs.push({ ...preview, hasMoreItems: refusedCursor !== null });
		}
		// Keep this throw. Returning would save the restore.
		throw convex_error({
			message: "Restore preview rolled back",
			data: { kind: "restore_preview", preview: { isDone: restored.isDone, refused: restored.refused, jobs } },
		});
	},
});

type RestorePreview = {
	isDone: boolean;
	refused: restore_items_Result["refused"];
	jobs: Array<Omit<NonNullable<get_job_Result>, "jobId" | "refusedCursor"> & { hasMoreItems: boolean }>;
};

const restore_body_validator = z
	.object({
		force: z.boolean().optional(),
		paths: z.array(z.string()).min(1).optional(),
		/**
		 * Items from `files/trash/list`, by id. Use it when several deleted items have one path.
		 */
		nodes: z
			.array(z.object({ nodeId: z.string().min(1).max(64), archiveOperationId: z.string().min(1).max(64) }).strict())
			.min(1)
			.optional(),
		onConflict: z.union([z.literal("keep_both"), z.literal("skip")]).optional(),
		/**
		 * Run the restore and undo it, to see what it would do. Nothing is saved.
		 */
		dryRun: z.boolean().optional(),
		/**
		 * Send the same `requestId` and body again to retry safely. The answer then names the same jobs.
		 * Required unless `dryRun` is true.
		 */
		requestId: z.string().min(1).max(64).optional(),
	})
	.strict();

export type public_api_files_organize_http_restore_Body = z.infer<typeof restore_body_validator>;

export async function public_api_files_organize_http_restore(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/restore";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, restore_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	const dryRun = body._yay.dryRun === true;
	if ((body._yay.paths === undefined) === (body._yay.nodes === undefined)) {
		return { status: 400, body: { message: "Send either paths or nodes." } } as const;
	}
	// A dry run saves nothing, so there is nothing to retry.
	if (dryRun && body._yay.requestId !== undefined) {
		return { status: 400, body: { message: "A dry run takes no requestId." } } as const;
	}
	if (!dryRun && body._yay.requestId === undefined) {
		return { status: 400, body: { message: "requestId is required." } } as const;
	}
	// Count the items here, not in the schema, so the answer names the limit.
	if ((body._yay.paths ?? body._yay.nodes ?? []).length > RESTORE_MAX_ITEMS) {
		return {
			status: 400,
			body: { message: `Restore at most ${RESTORE_MAX_ITEMS} items at once. Split the list into several calls.` },
		} as const;
	}
	const nodes = body._yay.nodes ?? [];
	for (const [index, node] of nodes.entries()) {
		if (nodes.findIndex((other) => other.nodeId === node.nodeId) !== index) {
			return { status: 400, body: { message: "Duplicate node in batch", nodeId: node.nodeId } } as const;
		}
	}

	const paths: string[] = [];
	for (const rawPath of body._yay.paths ?? []) {
		if (!rawPath.startsWith("/")) {
			return { status: 400, body: { message: "Path must be absolute.", path: rawPath } } as const;
		}
		const normalized = server_path_normalize(rawPath);
		if (normalized === "/") {
			return { status: 400, body: { message: "Path must not be the workspace root.", path: rawPath } } as const;
		}
		if (paths.includes(normalized)) {
			return { status: 400, body: { message: "Duplicate path in batch", path: rawPath } } as const;
		}
		paths.push(normalized);
	}

	// One token per call. The restore job also charges the person's tree-write bucket.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
	});
	if (rateLimit) {
		return { status: 429, body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs } } as const;
	}

	const restoreArgs = {
		credentialId: principal.credentialId,
		force: body._yay.force === true,
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.userId,
		paths,
		nodes,
		// Keep both never loses an item, and the app asks nothing for an API job.
		onConflict: body._yay.onConflict ?? "keep_both",
	};
	let result: restore_items_Result;
	try {
		if (dryRun) {
			await ctx.runMutation(internal.public_api_files_organize.preview_restore, restoreArgs);
			throw should_never_happen("A restore preview returned instead of rolling back");
		}
		result = (await ctx.runMutation(internal.public_api_files_organize.restore_items, {
			...restoreArgs,
			requestId: body._yay.requestId!,
		})) as restore_items_Result;
	} catch (error) {
		if (
			dryRun &&
			error instanceof ConvexError &&
			z.object({ data: z.object({ kind: z.literal("restore_preview") }) }).safeParse(error.data).success
		) {
			// Only `preview_restore` throws this kind, and a mutation error crosses `runMutation` unchanged, so
			// trust the `RestorePreview` shape here.
			const { preview } = (error.data as { data: { preview: RestorePreview } }).data;
			return {
				status: 200,
				body: {
					dryRun: true as const,
					// False when a job did not end in the first step: its later results are unknown.
					complete: preview.isDone,
					refused: preview.refused,
					jobs: preview.jobs,
				},
				headers: { "Cache-Control": "no-store" },
			} as const;
		}
		const failure =
			error instanceof ConvexError
				? z.object({ message: z.string(), data: restore_failure_validator }).safeParse(error.data)
				: null;
		if (!failure?.success) throw error;
		const { status, retryAfterMs } = failure.data.data;
		return { status, body: { message: failure.data.message, retryAfterMs } } as const;
	}
	return { status: 200, body: result, headers: { "Cache-Control": "no-store" } } as const;
}

// One selection page of the transfer job, so the whole selection is sent and sealed in one request.
const TRANSFER_MAX_PATHS = files_TRANSFER_SELECTION_PAGE_SIZE;

const transfer_failure_validator = z.object({
	status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(409), z.literal(429)]),
	path: z.string().optional(),
});

/**
 * Move or copy the named paths with the app's transfer job, like `mv` and `cp`. A `from` path that is
 * missing or locked is refused alone, and the job starts with the other paths.
 */
export const transfer_paths = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		kind: v.union(v.literal("move"), v.literal("copy")),
		/** Absolute, normalized paths, not the root. A trailing "/" means it must be a folder. */
		from: v.array(v.string()),
		/**
		 * An absolute, normalized path. The root means "into the root folder". A trailing "/" means it
		 * must be an existing folder.
		 */
		to: v.string(),
		onConflict: v.union(v.literal("error"), v.literal("replace"), v.literal("skip")),
		requestId: v.string(),
	},
	returns: v.object({
		jobId: v.union(v.id("activities"), v.null()),
		isDone: v.boolean(),
		refused: v.array(v.object({ path: v.string(), message: v.string() })),
	}),
	handler: async (ctx, args) => {
		const fail = (failArgs: z.infer<typeof transfer_failure_validator> & { message: string }) =>
			convex_error({
				message: failArgs.message,
				data: { status: failArgs.status, ...(failArgs.path !== undefined ? { path: failArgs.path } : {}) },
			});

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: { kind: "user_api_key", credentialId: args.credentialId },
			force: args.force === true,
			path: args.to,
			eachPathChecked: true,
			now: Date.now(),
		});
		if (revalidated._nay) {
			throw fail({
				message: revalidated._nay.message,
				status: revalidated._nay.message === "Unauthenticated" ? 401 : 403,
			});
		}
		const { subject } = revalidated._yay.writeContext;

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
			throw fail({ message: "Unauthenticated", status: 401 });
		}

		// Look for an earlier run first: after a finished Move, the `from` paths no longer exist. The key's
		// id in the request id keeps it apart from the app's and the agent's request ids.
		const requestId = `api:${args.credentialId}:${args.requestId}`;
		const inputHash = await crypto_sha256_hex(
			JSON.stringify([args.kind, args.from, args.to, args.onConflict, ...(args.force === true ? [true] : [])]),
		);
		const previous = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_request", (q) =>
				q.eq("userId", args.userId).eq("workspaceId", args.workspaceId).eq("requestId", requestId),
			)
			.unique();
		if (previous) {
			if (previous.origin.kind !== "api" || previous.origin.inputHash !== inputHash) {
				throw fail({
					message: "This requestId was already used for another request. Send a new requestId.",
					status: 409,
				});
			}
			const activity = await files_transfer_status_db_require_activity(ctx, previous._id);
			return {
				jobId: activity._id,
				isDone: !activities_is_active(activity.status),
				refused: previous.origin.refused,
			};
		}

		// Resolve each path as the key. Locked answers "Permission denied", never "Not found". The job
		// would stop for one bad source, so a bad one is refused here and the others still go.
		const refused: Array<{ path: string; message: string }> = [];
		const sources: Array<{ kind: "saved"; id: Id<"files_nodes"> }> = [];
		for (const path of args.from) {
			const mustBeFolder = path.endsWith("/");
			const access = await files_db_get_path_access(ctx, {
				...args,
				subject,
				path: mustBeFolder ? path.slice(0, -1) : path,
			});
			if (access.status !== "found") {
				refused.push({ path, message: access.status === "locked" ? "Permission denied" : "Not found" });
				continue;
			}
			// Like `mv file.md/ dest`, a trailing "/" refuses a file.
			if (mustBeFolder && access.node.kind !== "folder") {
				refused.push({ path, message: "Not a folder" });
				continue;
			}
			sources.push({ kind: "saved", id: access.node._id });
		}
		if (sources.length === 0) {
			return { jobId: null, isDone: true, refused };
		}

		// Read `to` like `mv` and `cp`: an existing folder takes the items inside it. Otherwise it is the
		// new path of the one item, which is also how a rename works.
		const get_folder_access = async (path: string) =>
			path === "/"
				? ({ status: "found", node: null } as const)
				: await files_db_get_path_access(ctx, { ...args, subject, path });
		const toMustBeFolder = args.to.length > 1 && args.to.endsWith("/");
		const toPath = toMustBeFolder ? args.to.slice(0, -1) : args.to;
		const destination = await get_folder_access(toPath);
		if (destination.status === "locked") {
			throw fail({ message: "Permission denied", status: 403, path: args.to });
		}

		let targetPath = toPath;
		let targetParent: { kind: "root" } | { kind: "saved"; id: Id<"files_nodes"> } = { kind: "root" };
		let targetName: string | null = null;
		if (destination.status === "found" && (!destination.node || destination.node.kind === "folder")) {
			if (destination.node) targetParent = { kind: "saved", id: destination.node._id };
		} else {
			// Count the paths the caller sent, not the ones left after refusals, so a refused path never
			// turns "put inside" into "rename".
			if (args.from.length !== 1) {
				throw fail({
					message: "To move or copy several paths, `to` must be an existing folder.",
					status: 400,
					path: args.to,
				});
			}
			if (toMustBeFolder) {
				throw fail({ message: '`to` ends with "/", so it must be an existing folder.', status: 409, path: args.to });
			}

			const segments = path_extract_segments_from(toPath);
			targetName = segments.at(-1)!;
			targetPath = `/${segments.slice(0, -1).join("/")}`;
			const parent = await get_folder_access(targetPath);
			if (parent.status === "locked") {
				throw fail({ message: "Permission denied", status: 403, path: args.to });
			}
			// Unlike the agent's `cp`, a copy here does not make missing folders. See `files_transfer_db_start_for_api`.
			if (parent.status === "missing") {
				throw fail({
					message: "The folder above `to` does not exist. Make it with files/mkdir, then try again.",
					status: 409,
					path: args.to,
				});
			}
			if (parent.node?.kind === "file") {
				throw fail({
					message: "A file is in the way on this path. Rename or move it, or pick another path.",
					status: 409,
					path: args.to,
				});
			}
			if (parent.node) targetParent = { kind: "saved", id: parent.node._id };

			// The API never renames on its own, like the write routes. A name that is taken keeps its
			// spelling, so only a new name must be clean.
			if (destination.status === "missing") {
				const source = (await ctx.db.get("files_nodes", sources[0]!.id))!;
				const invalidNameMessage = public_api_get_invalid_name_message(source.kind, targetName);
				if (invalidNameMessage) {
					throw fail({ message: invalidNameMessage, status: 400, path: args.to });
				}
			}
		}

		const started = await files_transfer_db_start_for_api(ctx, {
			force: args.force === true,
			membership,
			requestId,
			kind: args.kind,
			sources,
			targetParent,
			targetPath,
			targetName,
			// Like the agent's `mv` and `cp`. Nobody can answer a question for an API job, so never "ask".
			conflictPolicy:
				args.kind === "copy"
					? { file: args.onConflict, folder: "merge" }
					: { file: args.onConflict, folder: args.onConflict === "skip" ? "skip" : "error" },
			origin: { kind: "api", credentialId: args.credentialId, inputHash, refused },
		});
		if (started._nay) {
			const { name, message } = started._nay;
			throw fail({
				// Do not name the other job: this key may not read it.
				message:
					name === "busy"
						? "A transfer is already running in this workspace. Wait for it to finish, then try again."
						: message,
				status:
					name === "busy" || name === "request_changed"
						? 409
						: message === rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE
							? 429
							: message === "Permission denied" || name === "read_only"
								? 403
								: 400,
			});
		}

		return { jobId: started._yay.activityId, isDone: false, refused };
	},
});

type transfer_paths_Result =
	typeof transfer_paths extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const transfer_body_validator = z
	.object({
		force: z.boolean().optional(),
		from: z.array(z.string()).min(1),
		to: z.string(),
		onConflict: z.union([z.literal("error"), z.literal("replace"), z.literal("skip")]).optional(),
		/**
		 * Send the same `requestId` and body again to retry safely. The answer then names the same job.
		 */
		requestId: z.string().min(1).max(64),
	})
	.strict();

export type public_api_files_organize_http_transfer_Body = z.infer<typeof transfer_body_validator>;

export async function public_api_files_organize_http_transfer(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/move" | "/api/v1/files/copy";
}) {
	const { ctx, request, path } = args;
	const kind = path === "/api/v1/files/move" ? "move" : "copy";

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const principalScopes: readonly public_api_Scope[] = principal.scopes;
	// A copy reads its sources and writes their bytes again, so it needs the scopes a read and a
	// download need. The job checks them again at each step.
	if (kind === "copy" && !(principalScopes.includes("files:read") && principalScopes.includes("files:download"))) {
		return {
			status: 403,
			body: { message: "Copy needs an API key with the files:read and files:download scopes." },
		} as const;
	}

	const body = await server_request_json_parse_and_validate(request, transfer_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	// Count the paths here, not in the schema, so the answer names the limit.
	if (body._yay.from.length > TRANSFER_MAX_PATHS) {
		return {
			status: 400,
			body: {
				message: `${kind === "move" ? "Move" : "Copy"} at most ${TRANSFER_MAX_PATHS} paths at once. Split the list into several calls.`,
			},
		} as const;
	}

	const from: string[] = [];
	const fromPaths = new Set<string>();
	for (const rawPath of body._yay.from) {
		if (!rawPath.startsWith("/")) {
			return { status: 400, body: { message: "Path must be absolute.", path: rawPath } } as const;
		}
		const normalized = server_path_normalize(rawPath);
		if (normalized === "/") {
			return { status: 400, body: { message: "Path must not be the workspace root.", path: rawPath } } as const;
		}
		if (fromPaths.has(normalized)) {
			return { status: 400, body: { message: "Duplicate path in batch", path: rawPath } } as const;
		}
		fromPaths.add(normalized);
		// Keep a trailing "/": like in `mv`, it says the path must be a folder.
		from.push(rawPath.endsWith("/") ? `${normalized}/` : normalized);
	}
	if (!body._yay.to.startsWith("/")) {
		return { status: 400, body: { message: "Path must be absolute.", path: body._yay.to } } as const;
	}

	// One token per call. The transfer job also charges the person's tree-write bucket.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
	});
	if (rateLimit) {
		return { status: 429, body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs } } as const;
	}

	let result: transfer_paths_Result;
	try {
		result = (await ctx.runMutation(internal.public_api_files_organize.transfer_paths, {
			credentialId: principal.credentialId,
			force: body._yay.force === true,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.userId,
			kind,
			from,
			// Keep a trailing "/" on `to`: like in `mv`, it says `to` must be an existing folder.
			to: `${server_path_normalize(body._yay.to)}${body._yay.to.length > 1 && body._yay.to.endsWith("/") ? "/" : ""}`,
			// Like `mv` and `cp`: a move stops at a name that is taken, a copy replaces the file there.
			onConflict: body._yay.onConflict ?? (kind === "move" ? "error" : "replace"),
			requestId: body._yay.requestId,
		})) as transfer_paths_Result;
	} catch (error) {
		const failure =
			error instanceof ConvexError
				? z.object({ message: z.string(), data: transfer_failure_validator }).safeParse(error.data)
				: null;
		if (!failure?.success) throw error;
		const { status, path: failedPath } = failure.data.data;
		return { status, body: { message: failure.data.message, path: failedPath } } as const;
	}
	return { status: 200, body: result, headers: { "Cache-Control": "no-store" } } as const;
}

// Refused items of a move or copy job, or renamed and skipped items of a restore, per `jobs/get` page.
const JOB_REFUSED_PAGE_SIZE = 100;

/**
 * Read a job that this API key started, like the app's job card. Another key of the same person
 * gets null, so a rotated key cannot read the old key's jobs.
 */
export const get_job = internalQuery({
	args: {
		credentialId: v.id("api_credentials"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		jobId: v.string(),
		/** From `refusedCursor` of the last page. */
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.union(
		v.object({
			jobId: v.id("activities"),
			kind: v.union(v.literal("delete"), v.literal("restore"), v.literal("move"), v.literal("copy")),
			status: app_convex_schema.tables.activities.validator.fields.status,
			progress: app_convex_schema.tables.activities.validator.fields.progress,
			errorMessage: v.union(v.string(), v.null()),
			refused: v.array(
				v.union(
					v.object({ path: v.union(v.string(), v.null()), message: v.string() }),
					// A restore that named its items by node id.
					v.object({ nodeId: v.string(), path: v.union(v.string(), v.null()), message: v.string() }),
				),
			),
			/**
			 * Restore: the items that Keep both brought back under a new name. Move and copy never rename.
			 */
			renamed: v.array(v.object({ path: v.string(), newPath: v.string() })),
			/** Set when more refused or renamed items follow. Send it back as `cursor`. */
			refusedCursor: v.union(v.string(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const activityId = ctx.db.normalizeId("activities", args.jobId);
		const activity = activityId ? await ctx.db.get("activities", activityId) : null;
		if (activity?.source.kind === "files_transfer_run") {
			const run = await ctx.db.get("files_transfer_runs", activity.source.id);
			if (
				!run ||
				run.origin.kind !== "api" ||
				run.origin.credentialId !== args.credentialId ||
				run.userId !== args.userId ||
				run.workspaceId !== args.workspaceId
			)
				return null;

			// Refused items come in two parts, each read by its index in item order: items that failed,
			// then items skipped because the person cannot open them. The cursor says the part and the
			// last order read, so a page costs the same for a small job and a huge one.
			const [part, afterOrder] = args.cursor ? args.cursor.split(":") : ["failed", "-1"];
			const after = Number(afterOrder);
			const items =
				part === "failed"
					? await ctx.db
							.query("files_transfer_items")
							.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "failed").gt("order", after))
							.take(JOB_REFUSED_PAGE_SIZE)
					: await ctx.db
							.query("files_transfer_items")
							.withIndex("by_run_skipReason_order", (q) =>
								q.eq("runId", run._id).eq("skipReason", "permission_denied").gt("order", after),
							)
							.take(JOB_REFUSED_PAGE_SIZE);
			const hasDenied =
				part === "failed" &&
				items.length < JOB_REFUSED_PAGE_SIZE &&
				(await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_skipReason_order", (q) => q.eq("runId", run._id).eq("skipReason", "permission_denied"))
					.first()) !== null;
			const refusedCursor =
				items.length === JOB_REFUSED_PAGE_SIZE ? `${part}:${items.at(-1)!.order}` : hasDenied ? "denied:-1" : null;

			return {
				jobId: activity._id,
				kind: run.kind,
				status: activity.status,
				progress: activity.progress,
				errorMessage: activity.errorMessage,
				// The paths refused before the job started come first, on the first page only. A locked item
				// keeps its name, like a locked row in its folder.
				refused: [
					...(args.cursor ? [] : run.origin.refused),
					...items.map((item) => ({
						path: item.sourcePath,
						message: part === "failed" ? (item.errorMessage ?? "Failed") : "Permission denied",
					})),
				],
				renamed: [],
				refusedCursor,
			};
		}
		if (!activity || activity.source.kind !== "files_archive_run") return null;
		const run = await ctx.db.get("files_archive_runs", activity.source.id);
		if (
			!run ||
			run.credentialId !== args.credentialId ||
			run.userId !== args.userId ||
			run.workspaceId !== args.workspaceId
		)
			return null;

		// At most 200 refused items, because a delete names at most 200 paths. A restore has none.
		const nodes = (
			await Promise.all(run.refusedItems.map((refusedItem) => ctx.db.get("files_nodes", refusedItem.nodeId)))
		).flatMap((node) => (node && node.workspaceId === run.workspaceId ? [node] : []));
		// Only a stopped job needs a recovery item. Read each selected id at its current saved path.
		let leftNode = null;
		if (
			run.kind === "restore" &&
			!args.cursor &&
			activity.status !== "succeeded" &&
			!activities_is_active(activity.status)
		) {
			for (const root of run.restoreRoots) {
				leftNode = await files_archive_runs_db_find_saved_restore_left_node(ctx, { run, root });
				if (leftNode) break;
			}
		}
		if (leftNode) nodes.push(leftNode);
		// Name an item only while the key may still read it, like the app's job card.
		const writeContext = await public_api_credentials_db_get_write_context(ctx, {
			credentialId: args.credentialId,
			userId: args.userId,
		});
		const readableNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			subject: writeContext.subject,
			nodes,
		});
		const pathByNodeId = new Map(readableNodes.map((node) => [node._id, node.path]));

		// A restore lists the items it renamed or skipped for a clash, read by their index in item order.
		// The cursor says the last order read, so a page costs the same for a small job and a huge one.
		const afterOrder = args.cursor ? Number(args.cursor.split(":")[1]) : -1;
		const items = await ctx.db
			.query("files_archive_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", run._id).gt("order", afterOrder))
			.take(JOB_REFUSED_PAGE_SIZE);

		const forcedRefused = [];
		for (const item of items) {
			if (item.kind !== "force_archive") continue;
			const node = await files_saved_placement_db_get_node(ctx.db, item.nodeId);
			const readable =
				node &&
				(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					subject: writeContext.subject,
					fileNode: node,
					permission: "content.read",
				}));
			forcedRefused.push({
				path: readable ? node.path : null,
				message:
					!readable || item.reason === "permission"
						? "Permission denied"
						: item.reason === "not_empty"
							? "This folder still holds items that could not be moved to Trash."
							: "This item changed. Try again.",
			});
		}
		return {
			jobId: activity._id,
			kind: run.kind === "archive" ? ("delete" as const) : ("restore" as const),
			status: activity.status,
			progress: activity.progress,
			errorMessage: activity.errorMessage,
			refused: [
				// A delete names at most 200 paths and a restore at most 100, so their refused paths fit on the first page.
				// The paths a restore refused come only on the job that holds the request, its last job.
				...(args.cursor
					? []
					: [
							...(run.apiRequest?.refused ?? []),
							...run.refusedItems.map((refusedItem) => ({
								path: pathByNodeId.get(refusedItem.nodeId) ?? null,
								message: refusedItem.refusal.message,
							})),
						]),
				...(leftNode && pathByNodeId.has(leftNode._id)
					? [
							{
								path: pathByNodeId.get(leftNode._id)!,
								message:
									"This item is still in the Trash. Restore it to bring it back with the items inside it that were moved to Trash with it.",
							},
						]
					: []),
				...forcedRefused,
				...items.flatMap((item) =>
					item.kind === "restore" && item.newPath === null
						? [
								{
									path: item.path,
									message: "An item with this name is already there, so this item stays in the Trash.",
								},
							]
						: [],
				),
			],
			renamed: items.flatMap((item) =>
				item.kind === "restore" && item.newPath !== null ? [{ path: item.path, newPath: item.newPath }] : [],
			),
			refusedCursor: items.length === JOB_REFUSED_PAGE_SIZE ? `items:${items.at(-1)!.order}` : null,
		};
	},
});

type get_job_Result =
	typeof get_job extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const jobs_get_body_validator = z
	.object({
		jobId: z.string().max(64),
		/** `refusedCursor` from the last page, to read more refused or renamed items. */
		cursor: z
			.string()
			.regex(/^(failed|denied|items):-?\d{1,9}$/u)
			.nullable()
			.optional(),
	})
	.strict();

export type public_api_files_organize_http_jobs_get_Body = z.infer<typeof jobs_get_body_validator>;

export async function public_api_files_organize_http_jobs_get(args: {
	ctx: ActionCtx;
	request: Request;
	path: "/api/v1/files/jobs/get";
}) {
	const { ctx, request, path } = args;

	const auth = await public_api_authorize_request({
		ctx,
		request,
		requiredScope: "files:list" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, jobs_get_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const job = (await ctx.runQuery(internal.public_api_files_organize.get_job, {
		credentialId: principal.credentialId,
		workspaceId: principal.workspaceId,
		userId: principal.userId,
		jobId: body._yay.jobId,
		cursor: body._yay.cursor ?? null,
	})) as get_job_Result;
	// Finished jobs are deleted 7 days after they end, so an old id is not found either.
	if (!job) {
		return { status: 404, body: { message: "Job not found" } } as const;
	}
	return { status: 200, body: job, headers: { "Cache-Control": "no-store" } } as const;
}
