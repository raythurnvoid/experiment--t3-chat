// The public API doors that organize files: `/api/v1/files/stat`, `/api/v1/files/mkdir`,
// `/api/v1/files/move`, `/api/v1/files/copy`, `/api/v1/files/delete`, `/api/v1/files/restore`,
// `/api/v1/files/trash/list`, `/api/v1/files/trash/areas`, and `/api/v1/files/jobs/get` (routes in
// `public_api_files_organize_http_routes.ts`).
//
// They act as the API key, with the same Locked, not hidden rules as `files/list`: a path the key
// cannot open answers "Permission denied", never "not found". The Trash doors, `restore` and `jobs/get`
// also serve plugins, which act as their file pair.

import { compareValues, v, ConvexError, type Infer } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { validate } from "convex-helpers/validators";
import { z } from "zod";

import { internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	access_control_create_file_checker,
	access_control_db_authorize_membership,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
	access_control_subject_validator,
} from "./access_control.ts";
import { activities_is_active } from "./activities_db.ts";
import {
	files_archive_runs_db_find_saved_restore_left_node,
	files_archive_runs_PLUGIN_RESTORE_MESSAGES,
} from "./files_archive_runs.ts";
import { files_nodes_db_archive_named_nodes, files_nodes_db_restore_named_nodes } from "./files_nodes.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_transfer_db_start_for_api } from "./files_transfer.ts";
import { files_tree_db_get_share_principal_keys } from "./files_tree.ts";
import { files_transfer_status_db_require_activity } from "./files_transfer_status.ts";
import { files_write_policy_db_has_write_context_permission } from "./files_write_policy_db.ts";
import {
	public_api_db_revalidate_file_write_principal,
	public_api_db_revalidate_live_plugin_run,
	public_api_get_invalid_name_message,
} from "./public_api.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import { public_api_validate_canonical_folder_path } from "./public_api_plugin_files.ts";
import {
	public_api_authorize_request,
	public_api_settle_plugin_call_best_effort,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";
import { public_api_credentials_db_get_write_context } from "./public_api_credentials_db.ts";
import type { r2_get_assets_ready_states_Result } from "./r2.ts";
import { rate_limiter_limit_by_key, rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE } from "./rate_limiter.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator, files_saved_stream_validator } from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { convex_error } from "../server/convex-utils.ts";
import { crypto_open_cursor, crypto_seal_cursor, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_db_create_path_lookups, files_db_get_path_access } from "../server/files.ts";
import { files_index_range_apply, files_index_range_phases } from "../server/files-index-range.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import {
	files_trash_areas_compare_keys,
	files_trash_areas_key_validator,
	files_trash_areas_merge_page,
	type files_trash_areas_Key,
} from "../server/files-trash-areas.ts";
import type { files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { files_share_rows_principal_key } from "../server/files-share-rows.ts";
import { plugins_file_grants_db_validate_pair } from "../server/plugins-file-grants.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import {
	files_archive_operation_id_time,
	files_check_request_path_length,
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
					readOnly: v.union(v.boolean(), v.null()),
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
						readOnly: access.status === "locked" ? null : access.node.readOnly,
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
		const length = files_check_request_path_length(rawPath);
		if (length._nay) return { status: 400, body: { message: length._nay.message, path: rawPath } } as const;
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
						readOnly: node.readOnly,
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
	status: z.union([z.literal(401), z.literal(403), z.literal(409), z.literal(429)]),
	/** Set on 429. */
	retryAfterMs: z.number().optional(),
});

/**
 * Archive the named paths with the app's archive job, like `rm` with several files. A path that is
 * missing or locked is refused alone, and the other paths are still archived.
 *
 * A retry with the same `requestId` and paths answers like the first call and archives nothing again.
 * A request that started no job saves nothing, so its retry runs again.
 */
export const delete_paths = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		requestId: v.string(),
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

		// Look for an earlier run first: after a finished delete, the paths are "Not found". The key's id
		// in the request id keeps it apart from the request ids of other keys.
		const requestId = `api:${args.credentialId}:${args.requestId}`;
		// The "delete" tag keeps this hash apart from a restore's hash, which uses the same request ids.
		// Only opting into force changes the request identity.
		const inputHash = await crypto_sha256_hex(
			JSON.stringify(["delete", args.paths, ...(args.force === true ? [true] : [])]),
		);
		const previous = await ctx.db
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
			const jobId = previous.apiRequest.activityIds[0]!;
			const activity = await ctx.db.get("activities", jobId);
			return {
				jobId,
				// History cleanup deletes a job 7 days after it ends.
				isDone: !activity || !activities_is_active(activity.status),
				// A delete saves only path refusals. The other shape is a restore's node refusal.
				refused: previous.apiRequest.refused.flatMap((item) => ("nodeId" in item ? [] : [item])),
			};
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
		// Refused before any file write. Its one message is for every found path.
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
		// A delete from a key always keeps its job, so the job can hold the request for a retry.
		await ctx.db.patch("files_archive_runs", job.runId, {
			apiRequest: { requestId, inputHash, refused, activityIds: [job.activityId] },
		});
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
		/**
		 * Send the same `requestId` and body again to retry safely. The answer then names the same job.
		 */
		requestId: z.string().min(1).max(64),
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

	// Handle a missing ID here to name it in the error; the public body type still requires it.
	const body = await server_request_json_parse_and_validate(
		request,
		delete_body_validator.partial({ requestId: true }),
	);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}
	if (body._yay.requestId === undefined) {
		return {
			status: 400,
			body: { message: "requestId is required. Send a unique ID and reuse it when retrying the same delete." },
		} as const;
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
			requestId: body._yay.requestId,
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
	name: v.string(),
	createdAt: v.number(),
	nodeId: v.string(),
});

/**
 * Check the live pair and the no-guest Trash rule once per request.
 * Return the refusal message, or null when the request may continue.
 */
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
 * One page of `files/trash/list`, newest archive operation first.
 *
 * Area mode (no `folderNodeId`) reads the area's Trash entries, like the app's Trash view
 * (`files_tree.list_trash_entries`): the items in Trash on their own, then by the path they had at
 * delete time. A restricted folder lists in the area of its parent, locked when the caller cannot open
 * it. An unrestrict moves the entries of the opened folder to the area above, while the Trash items
 * keep their delete-time area. So an area must not read the items by their stored area.
 * `entriesCursor` is the Convex cursor of that range.
 *
 * Folder mode reads the archived docs directly inside the folder, by name, below `upperKey`.
 * `public_api_files_organize_http_trash_list` merges that stream across the saved views.
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
		 * A folder, live or in Trash, for folder mode. Null in area mode. Not normalized: it comes from
		 * the request body.
		 */
		folderNodeId: v.union(v.string(), v.null()),
		upperKey: v.union(trash_key_validator, v.null()),
		entriesCursor: v.union(v.string(), v.null()),
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
					createdAt: v.number(),
					locked: v.boolean(),
					top: v.boolean(),
				}),
			),
			frontier: v.union(trash_key_validator, v.null()),
			phaseCount: v.number(),
			entriesCursor: v.union(v.string(), v.null()),
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

		let nodes: Array<Doc<"files_nodes">>;
		let frontier: TrashKey | null = null;
		let phaseCount = 1;
		let entriesCursor: string | null = null;
		let isDone: boolean;
		if (folder) {
			const folderId = folder._id;
			const phases = files_index_range_phases({
				fields: [
					"archiveOperationId",
					"name",
					...(args.savedStream.kind === "cohort" ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"]),
				],
				order: "desc",
				// An active doc has a null `archiveOperationId`, so this range holds the archived docs only.
				start: [null],
				startInclusive: false,
				end: args.upperKey
					? [args.upperKey.archiveOperationId, args.upperKey.name, args.upperKey.createdAt, args.upperKey.nodeId]
					: [],
				endInclusive: false,
			});
			const phase = phases[args.phase];
			if (!phase)
				return {
					status: "page" as const,
					rows: [],
					frontier: null,
					phaseCount: phases.length,
					entriesCursor: null,
					isDone: true,
				};
			const result = await saved.queries
				.by_parent_archive_name((q) => files_index_range_apply(q.eq("parentId", folderId), phase))
				.order("desc")
				.paginate({ cursor: null, numItems: args.numItems });

			// The frontier can name a doc the caller cannot open, so the HTTP action seals it inside the
			// public cursor.
			const last = result.page.at(-1);
			frontier = last
				? {
						archiveOperationId: last.archiveOperationId!,
						name: last.name,
						createdAt: "nodeId" in last ? last.nodeCreationTime : last._creationTime,
						nodeId: "nodeId" in last ? last.nodeId : last._id,
					}
				: null;
			nodes = await saved.read_nodes(result.page);
			phaseCount = phases.length;
			isDone = result.isDone;
		} else {
			const result = await ctx.db
				.query("files_trash_entries")
				.withIndex("by_org_ws_area_order_path", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("area", area),
				)
				.paginate({ cursor: args.entriesCursor, numItems: args.numItems });
			// Entries follow the stored nodes. While a Move runs, the current view can already show a node
			// out of Trash. Its Move cleanup fixes the entry. Until then, leave the row out, like the app.
			nodes = (
				await Promise.all(result.page.map((entry) => files_saved_placement_db_get_node(ctx.db, entry.nodeId)))
			).filter((node): node is Doc<"files_nodes"> => node !== null && node.archiveOperationId !== null);
			entriesCursor = result.continueCursor;
			isDone = result.isDone;
		}
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
		const rows = nodes.map((node) => {
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
				createdAt: node._creationTime,
				locked,
				// A top item is what the app's Trash view lists: an item in Trash on its own. Every area entry is
				// one. In a folder, it is an item of another delete than the folder.
				top: folder ? folder.archiveOperationId !== node.archiveOperationId : true,
			};
		});
		return { status: "page" as const, rows, frontier, phaseCount, entriesCursor, isDone };
	},
});

type list_trash_page_Result =
	typeof list_trash_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type TrashKey = Infer<typeof trash_key_validator>;

function compare_trash_keys(a: TrashKey, b: TrashKey) {
	return compareValues(
		[a.archiveOperationId, a.name, a.createdAt, a.nodeId],
		[b.archiveOperationId, b.name, b.createdAt, b.nodeId],
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
 * `files/trash/list`: the Trash entries of one area, or every archived item directly inside one
 * folder, newest delete first. Area mode reads one range of entries (`list_trash_page`). Folder mode
 * merges `list_trash_page` for the normal saved stream and, during a Move, the Move view, like
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

	// A run fails if a claimed call stays open. Close it before every refusal.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	if (principal.kind !== "user_api_key") {
		if (principal.subject.kind !== "plugin_pair") {
			return {
				status: 403,
				body: await fail({
					status: 403,
					message: "Permission denied",
					errorCode: "permission_denied",
				}),
			} as const;
		}
		const denied: string | null = await ctx.runQuery(internal.public_api_files_organize.get_plugin_trash_access, {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId,
			pairId: principal.subject.pairId,
		});
		if (denied !== null) {
			return {
				status: 403,
				body: await fail({ status: 403, message: denied, errorCode: "permission_denied" }),
			} as const;
		}
	}
	const body = await server_request_json_parse_and_validate(request, trash_list_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}
	if (body._yay.areaNodeId !== undefined && body._yay.folderNodeId !== undefined) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Send either areaNodeId or folderNodeId.", errorCode: "invalid_input" }),
		} as const;
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
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
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
	const invalid_cursor = async () =>
		({
			status: 400,
			body: {
				...(await fail({
					status: 400,
					message: "This Trash cursor changed. Start a new page.",
					errorCode: "invalid_cursor",
				})),
				errorCode: "invalid_cursor" as const,
			},
		}) as const;
	// A folder pages by key. An area pages its Trash entries with their Convex cursor.
	let upperKey: TrashKey | null = null;
	let entriesCursor: string | null = null;
	if (body._yay.cursor != null) {
		let opened: unknown;
		try {
			opened = await crypto_open_cursor({ purpose: "files_trash_list", scope, cursor: body._yay.cursor });
		} catch (error) {
			if (!(error instanceof ConvexError)) throw error;
			return await invalid_cursor();
		}
		if (folderNodeId !== null) {
			if (!validate(v.object({ upperKey: trash_key_validator }), opened)) return await invalid_cursor();
			upperKey = opened.upperKey;
		} else {
			if (!validate(v.object({ entriesCursor: v.string() }), opened)) return await invalid_cursor();
			entriesCursor = opened.entriesCursor;
		}
	}

	type Row = Extract<list_trash_page_Result, { status: "page" }>["rows"][number];
	const key_of = (row: Row): TrashKey => ({
		archiveOperationId: row.archiveOperationId,
		name: row.name,
		createdAt: row.createdAt,
		nodeId: row.nodeId,
	});
	const read_page = async (readArgs: { source: files_SavedStream; phase: number }) => {
		let result: list_trash_page_Result;
		try {
			result = (await ctx.runQuery(internal.public_api_files_organize.list_trash_page, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				userId,
				subject: principal.subject,
				savedStream: readArgs.source,
				areaNodeId,
				folderNodeId,
				upperKey,
				entriesCursor,
				phase: readArgs.phase,
				numItems: numItems - page.length,
			})) as list_trash_page_Result;
		} catch (error) {
			if (
				!(error instanceof ConvexError) ||
				!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
			)
				throw error;
			return { refusal: await invalid_cursor() };
		}
		if (result.status === "area_not_found") {
			return {
				refusal: {
					status: 404,
					body: await fail({ status: 404, message: "Area not found", errorCode: "not_found" }),
				} as const,
			};
		}
		if (result.status === "folder_not_found") {
			return {
				refusal: {
					status: 404,
					body: await fail({ status: 404, message: "Folder not found", errorCode: "not_found" }),
				} as const,
			};
		}
		if (result.status === "not_a_folder") {
			return {
				refusal: {
					status: 400,
					body: await fail({
						status: 400,
						message: "folderNodeId must name a folder.",
						errorCode: "invalid_input",
					}),
				} as const,
			};
		}
		if (result.status === "denied" || result.status === "area_locked") {
			return {
				refusal: {
					status: 403,
					body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
				} as const,
			};
		}
		if (result.status === "not_an_area") {
			return {
				refusal: {
					status: 400,
					body: await fail({
						status: 400,
						message: "areaNodeId must name a restricted folder. Use null for the rest of the workspace.",
						errorCode: "invalid_input",
					}),
				} as const,
			};
		}
		return { result };
	};

	const page: Row[] = [];
	let isDone = false;
	// An area has one stream, read once in the current view. Its page can be short with a cursor when
	// the view shows some entry nodes out of Trash.
	if (folderNodeId === null) {
		const read = await read_page({ source: sources[0]!, phase: 0 });
		if (read.refusal) return read.refusal;
		page.push(...read.result.rows);
		entriesCursor = read.result.entriesCursor;
		isDone = read.result.isDone;
	}
	// A page can be short with a cursor: rows past the first unfinished stream wait for the next round.
	for (let round = 0; folderNodeId !== null && round < 8 && page.length < numItems; round++) {
		const batches: Array<{ rows: Row[]; frontier: TrashKey | null; done: boolean }> = [];
		for (const source of sources) {
			for (let phase = 0; ; phase++) {
				const read = await read_page({ source, phase });
				if (read.refusal) return read.refusal;
				const { result } = read;
				const done = result.isDone && phase + 1 >= result.phaseCount;
				if (result.frontier || done) {
					batches.push({ rows: result.rows, frontier: done ? null : result.frontier, done });
					break;
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
		return await invalid_cursor();
	}

	const assetIds = page.flatMap((row) => (row.kind === "file" && row.assetId ? [row.assetId] : []));
	const assetStates: r2_get_assets_ready_states_Result =
		assetIds.length > 0 ? await ctx.runQuery(internal.r2.get_assets_ready_states, { assetIds }) : {};

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});
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
			cursor: isDone
				? null
				: await crypto_seal_cursor({
						purpose: "files_trash_list",
						scope,
						payload: folderNodeId !== null ? { upperKey } : { entriesCursor },
					}),
			isDone,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const TRASH_AREAS_MAX_ITEMS = 100;

/**
 * Page every eligible workspace or folder consent for one pair, in consent order.
 * The worker applies human access changes to by_pair_areaEligible. Do not filter the page again.
 */
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
			rows: v.array(v.object({ nodeId: v.union(v.id("files_nodes"), v.null()), path: v.string() })),
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
				if (consent.rootNodeId === null) return { nodeId: null, path: "/" };
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

/**
 * One page of one stream of `files/trash/areas`: the active restricted folders after `afterKey`, by
 * `treePath`. Like the app's area picker (`files_tree.list_archive_areas`), the owner reads every
 * restricted folder on principal 0 and gets empty pages for 1 to 3. A member reads the share rows of
 * one principal. A key bound to a service account reads the account's own shares on principal 0 and
 * its role's shares on principal 1. `files_trash_areas_merge_page` merges the streams for
 * `public_api_files_organize_http_trash_areas` and the agent's `trash areas`.
 */
export const list_trash_areas_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		subject: access_control_subject_validator,
		savedStream: files_saved_stream_validator,
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3)),
		afterKey: v.union(files_trash_areas_key_validator, v.null()),
		numItems: v.number(),
		/** The agent's `trash areas`: the chat must still reach this workspace. */
		agentSource: v.optional(ai_chat_workspaces_source_validator),
	},
	returns: v.union(
		v.object({ status: v.literal("denied") }),
		v.object({
			status: v.literal("page"),
			rows: v.array(v.object({ nodeId: v.id("files_nodes"), path: v.string(), treePath: v.string() })),
			frontier: v.union(files_trash_areas_key_validator, v.null()),
			isDone: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return { status: "denied" as const };
		}
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
		let read: Array<{ key: files_trash_areas_Key; node: Doc<"files_nodes"> | null }>;
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
			(args.afterKey === null || files_trash_areas_compare_keys(key, args.afterKey) > 0)
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
 * Plugins page their applied consents in consent order. Folder paths come from the saved view;
 * workspace consent returns `/`.
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

	// A run fails if a claimed call stays open. Close it before every refusal.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	if (principal.kind !== "user_api_key") {
		if (principal.subject.kind !== "plugin_pair") {
			return {
				status: 403,
				body: await fail({
					status: 403,
					message: "Permission denied",
					errorCode: "permission_denied",
				}),
			} as const;
		}
		const denied: string | null = await ctx.runQuery(internal.public_api_files_organize.get_plugin_trash_access, {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId,
			pairId: principal.subject.pairId,
		});
		if (denied !== null) {
			return {
				status: 403,
				body: await fail({ status: 403, message: denied, errorCode: "permission_denied" }),
			} as const;
		}
	}
	const body = await server_request_json_parse_and_validate(request, trash_areas_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
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
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}
	const sources: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
	if (view.cohortId !== null && view.view !== null) {
		sources.push({ kind: "cohort", cohortId: view.cohortId, view: view.view, generation: view.generation });
	}
	// Source order follows migration. A doc moved between these reads is seen at least once.
	if (view.migrationDirection === "to_normal") sources.reverse();

	const scope = JSON.stringify([principal.principalKey, principal.subject, membership, sources]);
	// Like `files/trash/list`, only this error has a code: clients restart with `cursor: null` on it.
	const invalid_cursor = async () =>
		({
			status: 400,
			body: {
				...(await fail({
					status: 400,
					message: "This Trash cursor changed. Start a new page.",
					errorCode: "invalid_cursor",
				})),
				errorCode: "invalid_cursor" as const,
			},
		}) as const;
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
				return await invalid_cursor();
			}
			if (!validate(v.object({ cursor: v.string() }), opened)) return await invalid_cursor();
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
			return await invalid_cursor();
		}
		if (result.status === "denied") {
			return {
				status: 403,
				body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
			} as const;
		}

		// Any saved-view change can change these paths. Compare the full view before closing the page.
		const [currentView, currentMembership] = await Promise.all([
			ctx.runQuery(internal.files_visible.internal_get_move_view, viewArgs),
			ctx.runQuery(internal.public_api.get_file_read_membership, memberArgs),
		]);
		if (
			!currentView ||
			JSON.stringify(currentView) !== JSON.stringify(view) ||
			JSON.stringify(currentMembership) !== JSON.stringify(membership)
		) {
			return await invalid_cursor();
		}

		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "succeeded",
			responseStatus: 200,
		});

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

	let afterKey: files_trash_areas_Key | null = null;
	if (body._yay.cursor != null) {
		let opened: unknown;
		try {
			opened = await crypto_open_cursor({ purpose: "files_trash_areas", scope, cursor: body._yay.cursor });
		} catch (error) {
			if (!(error instanceof ConvexError)) throw error;
			return await invalid_cursor();
		}
		if (!validate(v.object({ afterKey: v.union(files_trash_areas_key_validator, v.null()) }), opened)) {
			return await invalid_cursor();
		}
		afterKey = opened.afterKey;
	}

	// A page can be short with a cursor. The first round runs even with `limit: 1`, so a guest still gets 403.
	let merged: Awaited<ReturnType<typeof files_trash_areas_merge_page>>;
	try {
		merged = await files_trash_areas_merge_page({
			sources,
			afterKey,
			numItems,
			read_page: async (page) =>
				(await ctx.runQuery(internal.public_api_files_organize.list_trash_areas_page, {
					organizationId: principal.organizationId,
					workspaceId: principal.workspaceId,
					userId,
					subject: principal.subject,
					savedStream: page.source,
					principalIndex: page.principalIndex,
					afterKey: page.afterKey,
					numItems: page.numItems,
				})) as list_trash_areas_page_Result,
		});
	} catch (error) {
		// A Move that started or ended during the page changes its saved view.
		if (
			!(error instanceof ConvexError) ||
			!z.object({ paginationError: z.literal("InvalidCursor") }).safeParse(error.data).success
		)
			throw error;
		return await invalid_cursor();
	}
	if (merged.status === "denied") {
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}
	const { page, isDone } = merged;
	afterKey = merged.afterKey;

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
		return await invalid_cursor();
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});
	return {
		status: 200,
		body: {
			areas: [
				...(withOpenArea ? [{ areaNodeId: null, path: "/" }] : []),
				...page.map((row) => ({ areaNodeId: row.nodeId as string | null, path: row.path })),
			],
			// `afterKey` can name a folder the caller cannot open, so the cursor hides it.
			cursor: isDone ? null : await crypto_seal_cursor({ purpose: "files_trash_areas", scope, payload: { afterKey } }),
			isDone,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
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
 * The error code that a plugin's call keeps for each refusal status of `files/restore` and `files/jobs/get`.
 */
const ERROR_CODE_BY_STATUS = {
	400: "invalid_input",
	401: "unauthenticated",
	403: "permission_denied",
	404: "not_found",
	409: "conflict",
	429: "rate_limited",
} as const;

const restore_principal_validator = v.union(
	v.object({ kind: v.literal("user_api_key"), credentialId: v.id("api_credentials") }),
	/**
	 * A plugin's backend run. The HTTP action passes the hash of the token it was given, never the
	 * token, and the call that the request claimed. The mutation checks both again.
	 */
	v.object({
		kind: v.literal("plugin_run"),
		runId: v.id("plugins_event_runs"),
		callId: v.id("plugins_event_run_calls"),
		tokenHash: v.string(),
	}),
);

/**
 * The refusals a plugin's request saved, for a retry or a job reader. A plugin may see a path only
 * when it sent it and can read the item now. A path selector that kept the item's id is checked
 * again with `checker`. A path selector without an id gets a null path, because looking up an old
 * refusal by its path could find another item. A node selector has no path.
 */
async function db_render_plugin_restore_refusals(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		refused: NonNullable<Doc<"files_archive_runs">["apiRequest"]>["refused"];
		checker: ReturnType<typeof access_control_create_file_checker>;
	},
) {
	return await Promise.all(
		args.refused.map(async (refusal) => {
			if (!("nodeId" in refusal)) return { path: null, message: refusal.message };
			if (refusal.path === null) return refusal;
			const nodeId = ctx.db.normalizeId("files_nodes", refusal.nodeId);
			const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
			const isReadable =
				node !== null &&
				node.organizationId === args.organizationId &&
				node.workspaceId === args.workspaceId &&
				(await args.checker.can(node, "content.read"));
			return { ...refusal, path: isReadable ? refusal.path : null };
		}),
	);
}

/**
 * Restore the named items from the Trash with the app's restore job. Each path names the archived item
 * at that path. Each node names one archived item by id, with the `archiveOperationId` the caller saw
 * in `files/trash/list`. The job brings back only each selected item and its descendants with the
 * same delete id, one job per delete. An item that is missing, locked, or not archived is refused
 * alone, and the other items are still restored.
 *
 * A plugin run acts as its file pair, with fixed refusal messages. Its replies and its saved request
 * name only paths the plugin sent (see `db_render_plugin_restore_refusals`).
 */
export const restore_items = internalMutation({
	args: {
		force: v.optional(v.boolean()),
		principal: restore_principal_validator,
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
				// A plugin's retry gets a null path where it may not see the path now.
				v.object({ path: v.union(v.string(), v.null()), message: v.string() }),
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
		const now = Date.now();
		const credentialId = args.principal.kind === "user_api_key" ? args.principal.credentialId : null;

		let writeContext: files_nodes_WriteContext;
		// A plugin run: the pins its jobs keep, and its own copy of the force check, which only a new
		// job needs. Null for a key.
		let pluginRestore: {
			pins: NonNullable<Doc<"files_archive_runs">["plugin"]>;
			canForce: boolean;
		} | null = null;
		if (args.principal.kind === "plugin_run") {
			const { principal } = args;
			// Check the token, the run and the claimed call here, in the transaction that accepts the work.
			// The HTTP action checked them before, but the run can end or the token can change since.
			const pluginRun = await ctx.db.get("plugins_event_runs", principal.runId);
			if (!pluginRun || pluginRun.apiTokenHash !== principal.tokenHash) {
				throw fail({ message: "Unauthenticated", status: 401 });
			}
			const live = await public_api_db_revalidate_live_plugin_run(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				runId: pluginRun._id,
				now,
				requiredScope: "files:restore",
			});
			if (live._nay) {
				throw fail({ message: live._nay.message, status: live._nay.message === "Unauthenticated" ? 401 : 403 });
			}
			const { installation, subject } = live._yay;
			const call = await ctx.db.get("plugins_event_run_calls", principal.callId);
			if (
				!call ||
				call.status !== "started" ||
				call.kind !== "api_request" ||
				call.route !== "/api/v1/files/restore" ||
				call.runId !== pluginRun._id ||
				call.organizationId !== pluginRun.organizationId ||
				call.workspaceId !== pluginRun.workspaceId ||
				call.installationId !== installation._id ||
				call.pluginVersionId !== pluginRun.pluginVersionId ||
				pluginRun.actorUserId !== args.userId
			) {
				throw fail({ message: "Unauthenticated", status: 401 });
			}
			// An upload run's authority ends with the file that started it. Check the source before new work.
			// A job that was accepted never checks it again, so losing the source later does not stop it.
			if (pluginRun.fileNodeId) {
				const source = await files_saved_placement_db_get_node(ctx.db, pluginRun.fileNodeId);
				if (
					!source ||
					source.archiveOperationId !== null ||
					source.organizationId !== args.organizationId ||
					source.workspaceId !== args.workspaceId
				) {
					throw fail({ message: "Unauthenticated", status: 401 });
				}
			}
			// The live check above validated the run's pair by its exact ids and membership lifetime. Both
			// the run and the installation must still accept Restore.
			if (
				!pluginRun.acceptedCapabilities.includes("workspace.files.restore") ||
				!installation.acceptedCapabilities.includes("workspace.files.restore")
			) {
				throw fail({ message: "Permission denied", status: 403 });
			}
			writeContext = {
				subject,
				actorUserId: args.userId,
				resourceScope: { kind: "workspace" },
				force: args.force === true,
			};
			pluginRestore = {
				pins: {
					installationId: installation._id,
					filePairId: subject.pairId,
					pluginVersionId: installation.pluginVersionId,
					serviceAccountId: pluginRun.serviceAccountId,
					capabilitiesAcceptedAt: installation.capabilitiesAcceptedAt,
				},
				canForce:
					pluginRun.acceptedCapabilities.includes("workspace.files.manage-read-only") &&
					installation.acceptedCapabilities.includes("workspace.files.manage-read-only"),
			};
		} else {
			const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				principalRef: { kind: "user_api_key", credentialId: args.principal.credentialId },
				force: args.force === true,
				// Each item is checked below, so a restore by nodes passes the root like `write-many` does.
				path: args.paths[0] ?? "/",
				eachPathChecked: true,
				now,
			});
			if (revalidated._nay) {
				throw fail({
					message: revalidated._nay.message,
					status: revalidated._nay.message === "Unauthenticated" ? 401 : 403,
				});
			}
			// A key bound to a service account acts as the account here and at every step of the job, like
			// `delete`. The person still owns the job, its Activity, and its rate buckets.
			writeContext = revalidated._yay.writeContext;
		}
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
		// Guests have no Trash, like on the plugin Trash doors. Check it once, not for each item.
		if (
			pluginRestore &&
			(
				await access_control_db_authorize_membership(ctx, {
					userAuth: { id: args.userId },
					membership,
					permission: "content.read",
				})
			)._nay
		) {
			throw fail({ message: "Permission denied", status: 403 });
		}

		// Look for an earlier run first: after a finished restore, the items are no longer archived. The
		// key's id in the request id keeps it apart from the request ids of other keys. A plugin's request id
		// holds its installation and file pair, not its run, so a later run of the same plugin for the same
		// person finds it.
		const requestId =
			args.requestId === null
				? null
				: pluginRestore
					? `plugin:${pluginRestore.pins.installationId}:${pluginRestore.pins.filePairId}:${args.requestId}`
					: `api:${credentialId}:${args.requestId}`;
		// Only opting into force changes the request identity. A paths request hashes the bare paths list,
		// and a nodes request adds a "nodes" tag, so the two can never share a hash.
		const inputHash = await crypto_sha256_hex(
			JSON.stringify([
				...(args.nodes.length > 0 ? ["nodes", args.nodes] : [args.paths]),
				args.onConflict,
				...(args.force === true ? [true] : []),
			]),
		);
		// One checker for the whole answer, so up to 100 items share its reads. Nothing here changes grants.
		const checker = access_control_create_file_checker(ctx, { ...args, subject });
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
				// A retry starts no work, so it needs no check of force, targets or landing. A plugin sees again
				// only the paths it may read now.
				refused: pluginRestore
					? await db_render_plugin_restore_refusals(ctx, { ...args, refused: previous.apiRequest.refused, checker })
					: previous.apiRequest.refused,
			};
		}
		// A forced plugin restore needs Read-only management on the run and the installation. Only new work
		// checks it, so an old forced request still answers its retry after an upgrade took the capability.
		if (pluginRestore && args.force === true && !pluginRestore.canForce) {
			throw fail({ message: "Permission denied", status: 403 });
		}

		// The same bucket as Restore in the app, so a key cannot restore faster than its person.
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) {
			throw fail({ message: rateLimit.message, status: 429, retryAfterMs: rateLimit.retryAfterMs });
		}

		// Resolve each path or node to its archived item, as the key. Locked answers "Permission denied",
		// never "Not found". Each item costs a few index reads, never a read of a whole folder.
		//
		// A plugin gets the fixed messages of `files_archive_runs_PLUGIN_RESTORE_MESSAGES` and only the
		// paths it sent. A path it sent keeps the id of the one item found there when the plugin can read it,
		// so a retry can check that item again. A node it sent never gets a path.
		type Selector = { path: string } | { nodeId: string; path: string | null };
		const refused: Array<Selector & { message: string }> = [];
		const nodes: Doc<"files_nodes">[] = [];
		const selectorsByOperationId = new Map<string, Selector[]>();
		const add_node = (node: Doc<"files_nodes">, selector: Selector) => {
			nodes.push(node);
			const selectors = selectorsByOperationId.get(node.archiveOperationId!) ?? [];
			selectorsByOperationId.set(node.archiveOperationId!, [...selectors, selector]);
		};
		const notFoundMessage = pluginRestore ? files_archive_runs_PLUGIN_RESTORE_MESSAGES.not_in_trash : "Not found";
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
								: notFoundMessage,
				});
				continue;
			}

			// An archived item the key cannot open is locked, like a locked row in its folder.
			let isReadable = true;
			for (const fileNode of archived) {
				isReadable &&= await checker.can(fileNode, "content.read");
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
			const selector: Selector = pluginRestore ? { nodeId: node._id, path } : { path };
			if (
				!(await files_write_policy_db_has_write_context_permission(ctx, {
					...args,
					writeContext,
					membership,
					node,
					permission: "content.write",
					// A pair has access per chosen item, so its checks share the answer's checker.
					checker: pluginRestore ? checker : null,
				}))
			) {
				refused.push({ ...selector, message: "Permission denied" });
				continue;
			}
			add_node(node, selector);
		}
		for (const selector of args.nodes) {
			const nodeId = ctx.db.normalizeId("files_nodes", selector.nodeId);
			// Read the item where the saved view shows it, like `files/trash/list` does. A published Move
			// shows its new place and Trash stamp before its cleanup rewrites the node doc.
			const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
			if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
				refused.push({ nodeId: selector.nodeId, path: null, message: notFoundMessage });
				continue;
			}
			// Check access before the item's state, so a locked item does not tell whether it changed.
			if (!(await checker.can(node, "content.read"))) {
				refused.push({ nodeId: selector.nodeId, path: null, message: "Permission denied" });
				continue;
			}
			const path = pluginRestore ? null : node.path;
			// The item was restored, or restored and deleted again, since the caller listed it. Never restore
			// another delete than the one the caller saw.
			if (node.archiveOperationId !== selector.archiveOperationId) {
				refused.push({
					nodeId: selector.nodeId,
					path,
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
					checker: pluginRestore ? checker : null,
				}))
			) {
				refused.push({ nodeId: selector.nodeId, path, message: "Permission denied" });
				continue;
			}
			add_node(node, { nodeId: selector.nodeId, path });
		}
		if (nodes.length === 0) {
			return { jobIds: [], isDone: true, refused };
		}

		const restored = await files_nodes_db_restore_named_nodes(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodes,
			credentialId,
			plugin: pluginRestore?.pins,
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
		principal: restore_principal_validator,
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
		const jobs: RestorePreview["jobs"] = [];
		// A plugin reads its jobs with the Restore authority that the nested restore just checked, so its
		// preview needs no file read capability. It reads only the jobs that this restore returned.
		if (args.principal.kind === "plugin_run") {
			const pluginRun = await ctx.db.get("plugins_event_runs", args.principal.runId);
			if (!pluginRun?.filePairId) {
				throw should_never_happen("A restore preview has no plugin pair", { runId: args.principal.runId });
			}
			// Made after the restore's writes, so no answer comes from before them.
			const checker = access_control_create_file_checker(ctx, {
				...args,
				subject: { kind: "plugin_pair", pairId: pluginRun.filePairId },
			});
			for (const jobId of restored.jobIds) {
				const job = await db_get_plugin_restore_job(ctx, {
					installationId: pluginRun.installationId,
					filePairId: pluginRun.filePairId,
					userId: args.userId,
					workspaceId: args.workspaceId,
					jobId,
					cursor: null,
					paginate: false,
					checker,
				});
				if (!job) throw should_never_happen("A restore job of this request is missing", { jobId });
				const { jobId: _jobId, isDone, continueCursor: _continueCursor, ...preview } = job;
				jobs.push({ ...preview, hasMoreItems: !isDone });
			}
		} else {
			for (const jobId of restored.jobIds) {
				const job = (await ctx.runQuery(internal.public_api_files_organize.get_job, {
					credentialId: args.principal.credentialId,
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
	jobs: Array<
		| (Omit<NonNullable<get_job_Result>, "jobId" | "refusedCursor"> & { hasMoreItems: boolean })
		| (Omit<
				NonNullable<Awaited<ReturnType<typeof db_get_plugin_restore_job>>>,
				"jobId" | "isDone" | "continueCursor"
		  > & {
				hasMoreItems: boolean;
		  })
	>;
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
		requiredScope: ["files:write", "files:restore"],
		allowedKinds: ["user_api_key", "plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const { principal, pluginCallId, presentedToken } = auth._yay;

	// A run fails if a claimed call stays open. So every answer below closes the call after the iife
	// returns, and an unexpected error closes it before it goes on.
	const response = await (async (/* iife */) => {
		// The shared auth passes a caller that holds any one of the scopes above. So an upload run with only
		// `files:write` passes it too. Check the one scope each caller kind needs.
		const scopes: readonly public_api_Scope[] = principal.scopes;
		if (!scopes.includes(principal.kind === "plugin_run" ? "files:restore" : "files:write")) {
			return { status: 403, body: { message: "Permission denied" } } as const;
		}

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

		if (principal.kind === "plugin_run" && !pluginCallId) {
			throw should_never_happen("A plugin restore has no claimed call", { runId: principal.runId });
		}
		const restoreArgs = {
			// The mutation checks the run's token and claimed call again, so pass the token's hash only.
			principal:
				principal.kind === "plugin_run"
					? {
							kind: "plugin_run" as const,
							runId: principal.runId,
							callId: pluginCallId!,
							tokenHash: await crypto_sha256_hex(presentedToken),
						}
					: { kind: "user_api_key" as const, credentialId: principal.credentialId },
			force: body._yay.force === true,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: public_api_visibility_user_id(principal),
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
	})().catch(async (error: unknown) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 500,
			errorCode: "internal_error",
			errorMessage: "Failed to restore",
		});
		throw error;
	});

	if (response.status === 200) {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "succeeded",
			responseStatus: 200,
		});
	} else {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: response.status,
			errorCode: ERROR_CODE_BY_STATUS[response.status],
			errorMessage: response.body.message,
		});
	}
	return response;
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
				// Move and copy never rename. Type the empty list, or the SDK's generated types print `never[]`.
				renamed: [] as Array<{ path: string; newPath: string }>,
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
		// One checker for the whole page, so its items share the checker's reads.
		const checker = access_control_create_file_checker(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			subject: writeContext.subject,
		});
		for (const item of items) {
			if (item.kind !== "force_archive") continue;
			const node = await files_saved_placement_db_get_node(ctx.db, item.nodeId);
			const readable = node && (await checker.can(node, "content.read"));
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
				// A restore keeps its request on its last job. A delete also keeps early path refusals;
				// omit exact repeats of the job's refusals below.
				...(args.cursor
					? []
					: [
							...(run.apiRequest?.refused ?? []).filter(
								(item) =>
									!run.refusedItems.some(
										(refusedItem) =>
											pathByNodeId.get(refusedItem.nodeId) === item.path &&
											refusedItem.refusal.message === item.message,
									),
							),
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

/**
 * Read a Restore job that a plugin started, for the same installation and file pair, like the app's job
 * card. Another installation's, pair's, person's or key's job, an app job and a delete job get null. A
 * job of an older plugin version stays readable: only its worker stops on an upgrade. The caller checked
 * who asks: `get_plugin_restore_job`, or the dry run of `files/restore` for the jobs its own nested
 * restore returned.
 *
 * A plugin gets fixed messages only. It gets a path only where its pair can read the item now, checked
 * with the one `checker` of the whole answer. A row it cannot read stays, with null paths.
 */
async function db_get_plugin_restore_job(
	ctx: QueryCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		filePairId: Id<"plugins_file_pairs">;
		userId: Id<"users">;
		workspaceId: Id<"organizations_workspaces">;
		jobId: Id<"activities">;
		/**
		 * The native cursor of the outcome page to read, or null for the first page.
		 */
		cursor: string | null;
		/**
		 * False for the dry run. It reads up to 100 jobs in one mutation, and Convex allows one `paginate`
		 * per function, so it reads only the first page of each job, with `take`.
		 */
		paginate: boolean;
		checker: ReturnType<typeof access_control_create_file_checker>;
	},
) {
	const { checker } = args;
	const isFirstPage = args.cursor === null;

	const activity = await ctx.db.get("activities", args.jobId);
	if (!activity || activity.source.kind !== "files_archive_run") return null;
	const run = await ctx.db.get("files_archive_runs", activity.source.id);
	if (
		!run ||
		run.kind !== "restore" ||
		run.plugin?.installationId !== args.installationId ||
		run.plugin.filePairId !== args.filePairId ||
		run.userId !== args.userId ||
		run.workspaceId !== args.workspaceId
	)
		return null;
	const is_readable = async (node: Doc<"files_nodes"> | null) =>
		node !== null && node.workspaceId === run.workspaceId && (await checker.can(node, "content.read"));

	// Only a stopped job needs a recovery item. Read each selected id at its current saved path.
	let leftNode = null;
	if (isFirstPage && activity.status !== "succeeded" && !activities_is_active(activity.status)) {
		for (const root of run.restoreRoots) {
			leftNode = await files_archive_runs_db_find_saved_restore_left_node(ctx, { run, root });
			if (leftNode) break;
		}
	}

	// A plugin's job writes `plugin_restore` rows only, a page at a time by order. Keep every row of the
	// page, also one the pair cannot read, so a page never needs more reads to fill up. Sort each row into
	// skipped or renamed before hiding its paths, so a hidden Keep both still counts as a rename.
	const outcomes = ctx.db.query("files_archive_run_items").withIndex("by_run_order", (q) => q.eq("runId", run._id));
	const page = args.paginate
		? await outcomes.paginate({ cursor: args.cursor, numItems: JOB_REFUSED_PAGE_SIZE })
		: await outcomes.take(JOB_REFUSED_PAGE_SIZE).then((items) => ({
				page: items,
				isDone: items.length < JOB_REFUSED_PAGE_SIZE,
				// The dry run never reads a second page.
				continueCursor: "",
			}));
	const skipped = [];
	const renamed = [];
	for (const item of page.page) {
		if (item.kind !== "plugin_restore") continue;
		const isReadable = await is_readable(await files_saved_placement_db_get_node(ctx.db, item.nodeId));
		if (item.newPath === null) {
			skipped.push({
				path: isReadable ? item.path : null,
				message: "An item with this name is already there, so this item stays in the Trash.",
			});
		} else {
			renamed.push({ path: isReadable ? item.path : null, newPath: isReadable ? item.newPath : null });
		}
	}

	// The Activity's own message can name items. A plugin gets the fixed message of its code instead.
	const messages: Record<string, string> = files_archive_runs_PLUGIN_RESTORE_MESSAGES;
	const errorCode = activity.errorCode ?? "stopped";
	return {
		jobId: activity._id,
		kind: "restore" as const,
		status: activity.status,
		progress: activity.progress,
		errorMessage:
			activity.errorMessage === null
				? null
				: Object.hasOwn(messages, errorCode)
					? messages[errorCode]!
					: files_archive_runs_PLUGIN_RESTORE_MESSAGES.stopped,
		refused: [
			// The items the request refused at the start come on the first page of its last job only.
			...(isFirstPage && run.apiRequest
				? await db_render_plugin_restore_refusals(ctx, {
						organizationId: run.organizationId,
						workspaceId: run.workspaceId,
						refused: run.apiRequest.refused,
						checker,
					})
				: []),
			...(leftNode
				? [
						{
							path: (await is_readable(leftNode)) ? leftNode.path : null,
							message:
								"This item is still in the Trash. Restore it to bring it back with the items inside it that were moved to Trash with it.",
						},
					]
				: []),
			...skipped,
		],
		renamed,
		isDone: page.isDone,
		// The native cursor of the next page. It can point at a row the plugin cannot read, so the HTTP
		// action seals it before it leaves the server.
		continueCursor: page.continueCursor,
	};
}

/**
 * `files/jobs/get` for a plugin run or page: read one Restore job of the caller's own installation and
 * file pair, one page of its outcomes at a time. A foreign job answers "not_found", like a missing one.
 *
 * Check the caller again here, in the same snapshot as the job. The HTTP auth checked it before, but
 * the token can rotate, the run can end and consent can change since. The HTTP action passes the token
 * hash and `now`, so no clock check runs inside a cached query result. The caller's pair, installation
 * and person come from the stored run or page session, never from the request.
 */
export const get_plugin_restore_job = internalQuery({
	args: {
		principal: v.union(
			v.object({
				kind: v.literal("plugin_run"),
				runId: v.id("plugins_event_runs"),
				callId: v.id("plugins_event_run_calls"),
				tokenHash: v.string(),
			}),
			v.object({ kind: v.literal("plugin_ui"), sessionId: v.id("plugins_ui_sessions"), tokenHash: v.string() }),
		),
		now: v.number(),
		/** Not normalized: it comes from the request body. */
		jobId: v.string(),
		/** The native outcome cursor, opened from the sealed `refusedCursor` of the last page. */
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.union(
		v.object({
			status: v.union(v.literal("unauthenticated"), v.literal("permission_denied"), v.literal("not_found")),
		}),
		v.object({
			status: v.literal("found"),
			job: v.object({
				jobId: v.id("activities"),
				kind: v.literal("restore"),
				status: app_convex_schema.tables.activities.validator.fields.status,
				progress: app_convex_schema.tables.activities.validator.fields.progress,
				errorMessage: v.union(v.string(), v.null()),
				refused: v.array(
					v.union(
						v.object({ path: v.union(v.string(), v.null()), message: v.string() }),
						v.object({ nodeId: v.string(), path: v.union(v.string(), v.null()), message: v.string() }),
					),
				),
				renamed: v.array(v.object({ path: v.union(v.string(), v.null()), newPath: v.union(v.string(), v.null()) })),
				isDone: v.boolean(),
				continueCursor: v.string(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const { principal } = args;

		let caller: {
			installation: Doc<"plugins_workspace_installations">;
			filePairId: Id<"plugins_file_pairs">;
			userId: Id<"users">;
		};
		if (principal.kind === "plugin_run") {
			const pluginRun = await ctx.db.get("plugins_event_runs", principal.runId);
			if (!pluginRun || pluginRun.apiTokenHash !== principal.tokenHash) return { status: "unauthenticated" as const };
			const live = await public_api_db_revalidate_live_plugin_run(ctx, {
				organizationId: pluginRun.organizationId,
				workspaceId: pluginRun.workspaceId,
				runId: pluginRun._id,
				now: args.now,
				requiredScope: "files:list",
			});
			if (live._nay) {
				return {
					status:
						live._nay.message === "Unauthenticated" ? ("unauthenticated" as const) : ("permission_denied" as const),
				};
			}
			const { installation, subject } = live._yay;
			const call = await ctx.db.get("plugins_event_run_calls", principal.callId);
			if (
				!call ||
				call.status !== "started" ||
				call.kind !== "api_request" ||
				call.route !== "/api/v1/files/jobs/get" ||
				call.runId !== pluginRun._id ||
				call.organizationId !== pluginRun.organizationId ||
				call.workspaceId !== pluginRun.workspaceId ||
				call.installationId !== installation._id ||
				call.pluginVersionId !== pluginRun.pluginVersionId
			) {
				return { status: "unauthenticated" as const };
			}
			// An upload run's authority ends with the file that started it.
			if (pluginRun.fileNodeId) {
				const source = await files_saved_placement_db_get_node(ctx.db, pluginRun.fileNodeId);
				if (
					!source ||
					source.archiveOperationId !== null ||
					source.organizationId !== pluginRun.organizationId ||
					source.workspaceId !== pluginRun.workspaceId
				) {
					return { status: "unauthenticated" as const };
				}
			}
			// The installation's read consent is checked below for runs and pages alike.
			if (!pluginRun.acceptedCapabilities.includes("workspace.files.read"))
				return { status: "permission_denied" as const };
			caller = { installation, filePairId: subject.pairId, userId: pluginRun.actorUserId };
		} else {
			// A refresh writes a new token hash and a later expiry on the same session doc. So the session id
			// and its expiry alone do not prove that the token the HTTP action saw is still the live one.
			const session = await ctx.db.get("plugins_ui_sessions", principal.sessionId);
			if (!session || session.tokenHash !== principal.tokenHash || session.expiresAt <= args.now) {
				return { status: "unauthenticated" as const };
			}
			const installation = await ctx.db.get("plugins_workspace_installations", session.installationId);
			if (
				!installation ||
				installation.status !== "enabled" ||
				installation.pluginVersionId !== session.pluginVersionId ||
				installation.organizationId !== session.organizationId ||
				installation.workspaceId !== session.workspaceId ||
				!(await plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: session.serviceAccountId }))
			) {
				return { status: "unauthenticated" as const };
			}
			caller = { installation, filePairId: session.filePairId, userId: session.userId };
		}
		const { installation, userId } = caller;

		// The pair by its exact ids and membership lifetime. Guests have no Trash, like on the other plugin
		// Trash doors.
		const pair = await plugins_file_grants_db_validate_pair(ctx, {
			pairId: caller.filePairId,
			installationId: installation._id,
			userId,
		});
		if (!pair) return { status: "unauthenticated" as const };
		const membership = (await ctx.db.get("organizations_workspaces_users", pair.membershipId))!;
		if (
			(
				await access_control_db_authorize_membership(ctx, {
					userAuth: { id: userId },
					membership,
					permission: "content.read",
				})
			)._nay ||
			!installation.acceptedCapabilities.includes("workspace.files.read")
		) {
			return { status: "permission_denied" as const };
		}

		const jobId = ctx.db.normalizeId("activities", args.jobId);
		const job = jobId
			? await db_get_plugin_restore_job(ctx, {
					installationId: installation._id,
					filePairId: pair._id,
					userId,
					workspaceId: pair.workspaceId,
					jobId,
					cursor: args.cursor,
					paginate: true,
					// One checker for the whole answer: outcomes, refusals and the recovery item share its reads.
					checker: access_control_create_file_checker(ctx, {
						organizationId: pair.organizationId,
						workspaceId: pair.workspaceId,
						subject: { kind: "plugin_pair", pairId: pair._id },
					}),
				})
			: null;
		return job ? { status: "found" as const, job } : { status: "not_found" as const };
	},
});

type get_plugin_restore_job_Result =
	typeof get_plugin_restore_job extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
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

/**
 * A plugin's body. Its `refusedCursor` is sealed, so it has another shape than a key's cursor.
 */
const plugin_jobs_get_body_validator = z
	.object({
		jobId: z.string().max(64),
		// A real cursor is about 1.4 KB. The cap stops a huge string before the server opens it.
		cursor: z.string().max(16384).nullable().optional(),
	})
	.strict();

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
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const { principal, pluginCallId, presentedToken } = auth._yay;

	// A plugin reads only Restore jobs of its own installation and pair, with `get_plugin_restore_job`. It
	// never reaches the key's `get_job`, whose saved messages can name items the plugin cannot read.
	if (principal.kind !== "user_api_key") {
		// A run fails if a claimed call stays open. So every answer below closes the call after the iife
		// returns, and an unexpected error closes it before it goes on.
		const response = await (async (/* iife */) => {
			if (principal.subject.kind !== "plugin_pair") {
				return { status: 403, body: { message: "Permission denied" } } as const;
			}
			const body = await server_request_json_parse_and_validate(request, plugin_jobs_get_body_validator);
			if (body._nay) {
				return { status: 400, body: { message: body._nay.message } } as const;
			}

			// The cursor works only for this job, installation and pair. It does not pin the run or page, so a
			// later run or a page of the same pair can go on reading.
			const scope = JSON.stringify([body._yay.jobId, principal.installationId, principal.subject.pairId]);
			let cursor: string | null = null;
			if (body._yay.cursor != null) {
				const opened = await crypto_open_cursor({ purpose: "files_jobs_get", scope, cursor: body._yay.cursor });
				if (!validate(v.object({ cursor: v.string() }), opened)) {
					// Like `files/trash/list`, only this error has a code: clients restart with `cursor: null` on it.
					return {
						status: 400,
						body: { message: "This job cursor changed. Start a new page.", errorCode: "invalid_cursor" as const },
					} as const;
				}
				cursor = opened.cursor;
			}

			if (principal.kind === "plugin_run" && !pluginCallId) {
				throw should_never_happen("A plugin job read has no claimed call", { runId: principal.runId });
			}
			const tokenHash = await crypto_sha256_hex(presentedToken);
			const result = (await ctx.runQuery(internal.public_api_files_organize.get_plugin_restore_job, {
				principal:
					principal.kind === "plugin_run"
						? { kind: "plugin_run", runId: principal.runId, callId: pluginCallId!, tokenHash }
						: { kind: "plugin_ui", sessionId: principal.sessionId, tokenHash },
				now: Date.now(),
				jobId: body._yay.jobId,
				cursor,
			})) as get_plugin_restore_job_Result;
			if (result.status === "unauthenticated") {
				return { status: 401, body: { message: "Unauthenticated" } } as const;
			}
			if (result.status === "permission_denied") {
				return { status: 403, body: { message: "Permission denied" } } as const;
			}
			// Finished jobs are deleted 7 days after they end, so an old id is not found either.
			if (result.status !== "found") {
				return { status: 404, body: { message: "Job not found" } } as const;
			}
			const { isDone, continueCursor, ...job } = result.job;
			return {
				status: 200,
				body: {
					...job,
					refusedCursor: isDone
						? null
						: await crypto_seal_cursor({ purpose: "files_jobs_get", scope, payload: { cursor: continueCursor } }),
				},
				headers: { "Cache-Control": "no-store" },
			} as const;
		})().catch(async (error: unknown) => {
			await public_api_settle_plugin_call_best_effort(ctx, {
				callId: pluginCallId,
				status: "failed",
				responseStatus: 500,
				errorCode: "internal_error",
				errorMessage: "Failed to read the job",
			});
			throw error;
		});

		if (response.status === 200) {
			await public_api_settle_plugin_call_best_effort(ctx, {
				callId: pluginCallId,
				status: "succeeded",
				responseStatus: 200,
			});
		} else {
			await public_api_settle_plugin_call_best_effort(ctx, {
				callId: pluginCallId,
				status: "failed",
				responseStatus: response.status,
				errorCode: "errorCode" in response.body ? response.body.errorCode : ERROR_CODE_BY_STATUS[response.status],
				errorMessage: response.body.message,
			});
		}
		return response;
	}

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
