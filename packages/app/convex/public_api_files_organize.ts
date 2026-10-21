// The public API doors that organize files: `/api/v1/files/stat`, `/api/v1/files/mkdir`,
// `/api/v1/files/move`, `/api/v1/files/copy`, `/api/v1/files/delete`, `/api/v1/files/restore`, and
// `/api/v1/files/jobs/get` (routes in `public_api_files_organize_http_routes.ts`).
//
// They act as the API key, with the same Locked, not hidden rules as `files/list`: a path the key
// cannot open answers "Permission denied", never "not found".

import { v, ConvexError } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
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
import { files_nodes_db_archive_named_nodes, files_nodes_db_restore_named_nodes } from "./files_nodes.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_transfer_db_start_for_api } from "./files_transfer.ts";
import { files_transfer_queries_db_require_activity } from "./files_transfer_queries.ts";
import { public_api_db_revalidate_file_write_principal, public_api_get_invalid_name_message } from "./public_api.ts";
import { public_api_validate_canonical_folder_path } from "./public_api_plugin_files.ts";
import { public_api_authorize_request } from "./public_api_http_auth.ts";
import type { r2_get_assets_ready_states_Result } from "./r2.ts";
import { rate_limiter_limit_by_key, rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_db_create_path_lookups, files_db_get_path_access } from "../server/files.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { files_ROOT_ID, files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import type { public_api_Scope } from "../shared/public-api.ts";

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

const stat_body_validator = z.object({
	paths: z.array(z.string()).min(1).max(STAT_MAX_PATHS),
});

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

const mkdir_body_validator = z.object({
	paths: z.array(z.string()).min(1).max(MKDIR_MAX_PATHS),
});

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
		// The archive job checks each item as a person with a membership. A key bound to a service account
		// has narrower grants than its person, so it must not run as that person.
		if (subject.kind !== "user") {
			throw fail({
				message: "Keys bound to a service account cannot move, copy, or delete files yet.",
				status: 403,
			});
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
		});
		// The job stopped inside the request. Its one message is for every found path.
		if (archived._nay && !archived._nay.data?.refusedItems) {
			for (const path of pathByNodeId.values()) refused.push({ path, message: archived._nay.message });
			return { jobId: null, isDone: true, refused };
		}
		// Every item was refused before a job started, and `data` has each one's own reason. A path not in
		// the list is inside a refused folder, or it was already archived and is skipped like `rm -f`.
		if (archived._nay) {
			const refusedPaths: string[] = [];
			for (const item of archived._nay.data.refusedItems) {
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

const delete_body_validator = z.object({
	paths: z.array(z.string()).min(1).max(DELETE_MAX_PATHS),
});

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

const RESTORE_MAX_PATHS = 200;

const restore_failure_validator = z.object({
	status: z.union([z.literal(401), z.literal(403), z.literal(409), z.literal(429)]),
	/** Set on 429. */
	retryAfterMs: z.number().optional(),
});

/**
 * Restore the named paths from the Trash with the app's restore job. Each path names the archived item
 * at that path. Like Restore in the app, the job brings back everything the same delete archived with
 * it, one job per delete. A path that is missing, locked, or not archived is refused alone, and the
 * other paths are still restored.
 */
export const restore_paths = internalMutation({
	args: {
		credentialId: v.id("api_credentials"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Absolute, normalized paths, not the root. */
		paths: v.array(v.string()),
		onConflict: v.union(v.literal("keep_both"), v.literal("skip")),
		requestId: v.string(),
	},
	returns: v.object({
		jobIds: v.array(v.id("activities")),
		isDone: v.boolean(),
		refused: v.array(v.object({ path: v.string(), message: v.string() })),
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
		// The restore job checks each item as a person with a membership. A key bound to a service account
		// has narrower grants than its person, so it must not run as that person.
		if (subject.kind !== "user") {
			throw fail({ message: "Keys bound to a service account cannot restore files yet.", status: 403 });
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
		if (!membership) {
			throw fail({ message: "Unauthenticated", status: 401 });
		}

		// Look for an earlier run first: after a finished restore, the paths are no longer archived. The
		// key's id in the request id keeps it apart from the request ids of other keys.
		const requestId = `api:${args.credentialId}:${args.requestId}`;
		const inputHash = await crypto_sha256_hex(JSON.stringify([args.paths, args.onConflict]));
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
			// At most one job per path, so at most 200 reads.
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

		// Resolve each path to the archived item there, as the key. Locked answers "Permission denied",
		// never "Not found". Each path costs a few index reads, never a read of a whole folder.
		const refused: Array<{ path: string; message: string }> = [];
		const nodes: Doc<"files_nodes">[] = [];
		const pathsByOperationId = new Map<string, string[]>();
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
				refused.push({ path, message: "Several deleted items have this path. Restore the one you want in the app." });
				continue;
			}

			// Per node, like Restore in the app. An archived node keeps the restricted scope it had.
			const node = archived[0]!;
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.write",
				fileNode: node,
			});
			if (authorized._nay) {
				refused.push({ path, message: authorized._nay.message });
				continue;
			}
			nodes.push(node);
			const operationPaths = pathsByOperationId.get(node.archiveOperationId!) ?? [];
			pathsByOperationId.set(node.archiveOperationId!, [...operationPaths, path]);
		}
		if (nodes.length === 0) {
			return { jobIds: [], isDone: true, refused };
		}

		const restored = await files_nodes_db_restore_named_nodes(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodes,
			credentialId: args.credentialId,
			// Nobody can answer a question for an API job, so the choice is made up front.
			applyToRemaining: { file: args.onConflict, folder: args.onConflict },
			stopAtRefusal: false,
		});
		// A refused delete operation refuses every path that named an item of it.
		for (const refusal of restored.refusals) {
			for (const path of pathsByOperationId.get(refusal.archiveOperationId)!) {
				refused.push({ path, message: refusal.nay.message });
			}
		}

		const jobIds = restored.jobs.map((job) => job.activityId);
		// An API restore always keeps its jobs, so the first one can hold the request for a retry.
		const firstJob = restored.jobs[0];
		if (firstJob) {
			await ctx.db.patch("files_archive_runs", firstJob.runId, {
				apiRequest: { requestId, inputHash, refused, activityIds: jobIds },
			});
		}
		return { jobIds, isDone: restored.jobs.every((job) => job.isDone), refused };
	},
});

type restore_paths_Result =
	typeof restore_paths extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const restore_body_validator = z.object({
	paths: z.array(z.string()).min(1).max(RESTORE_MAX_PATHS),
	onConflict: z.union([z.literal("keep_both"), z.literal("skip")]).optional(),
	/**
	 * Send the same `requestId` and body again to retry safely. The answer then names the same jobs.
	 */
	requestId: z.string().min(1).max(64),
});

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

	// One token per call. The restore job also charges the person's tree-write bucket.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
	});
	if (rateLimit) {
		return { status: 429, body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs } } as const;
	}

	let result: restore_paths_Result;
	try {
		result = (await ctx.runMutation(internal.public_api_files_organize.restore_paths, {
			credentialId: principal.credentialId,
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.userId,
			paths,
			// Keep both never loses an item, and the app asks nothing for an API job.
			onConflict: body._yay.onConflict ?? "keep_both",
			requestId: body._yay.requestId,
		})) as restore_paths_Result;
	} catch (error) {
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
		// The transfer job checks each item as a person with a membership. A key bound to a service account
		// has narrower grants than its person, so it must not run as that person.
		if (subject.kind !== "user") {
			throw fail({
				message: "Keys bound to a service account cannot move, copy, or delete files yet.",
				status: 403,
			});
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
		if (!membership) {
			throw fail({ message: "Unauthenticated", status: 401 });
		}

		// Look for an earlier run first: after a finished Move, the `from` paths no longer exist. The key's
		// id in the request id keeps it apart from the app's and the agent's request ids.
		const requestId = `api:${args.credentialId}:${args.requestId}`;
		const inputHash = await crypto_sha256_hex(JSON.stringify([args.kind, args.from, args.to, args.onConflict]));
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
			const activity = await files_transfer_queries_db_require_activity(ctx, previous._id);
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

const transfer_body_validator = z.object({
	from: z.array(z.string()).min(1).max(TRANSFER_MAX_PATHS),
	to: z.string(),
	onConflict: z.union([z.literal("error"), z.literal("replace"), z.literal("skip")]).optional(),
	/**
	 * Send the same `requestId` and body again to retry safely. The answer then names the same job.
	 */
	requestId: z.string().min(1).max(64),
});

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

// Refused items of a move or copy job per `jobs/get` page.
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
			refused: v.array(v.object({ path: v.union(v.string(), v.null()), message: v.string() })),
			/** Set when more refused items follow. Send it back as `cursor`. */
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
		// Name an item only while the key may still read it, like the app's job card.
		const readableNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			subject: { kind: "user", userId: run.userId, plugin: null },
			nodes,
		});
		const pathByNodeId = new Map(readableNodes.map((node) => [node._id, node.path]));

		return {
			jobId: activity._id,
			kind: run.kind === "archive" ? ("delete" as const) : ("restore" as const),
			status: activity.status,
			progress: activity.progress,
			errorMessage: activity.errorMessage,
			refused: [
				// The paths a restore refused come on its first job only, like the start of a move.
				...(run.apiRequest?.refused ?? []),
				...run.refusedItems.map((refusedItem) => ({
					path: pathByNodeId.get(refusedItem.nodeId) ?? null,
					message: refusedItem.refusal.message,
				})),
			],
			// A delete or a restore names at most 200 paths, so all its refused items fit in one page.
			refusedCursor: null,
		};
	},
});

type get_job_Result =
	typeof get_job extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const jobs_get_body_validator = z.object({
	jobId: z.string().max(64),
	/** `refusedCursor` from the last page, to read more refused items. */
	cursor: z
		.string()
		.regex(/^(failed|denied):-?\d{1,9}$/u)
		.nullable()
		.optional(),
});

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
