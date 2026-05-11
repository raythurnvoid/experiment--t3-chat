import { paginationOptsValidator, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import { R2 } from "@convex-dev/r2";
import { doc } from "convex-helpers/validators";
import { components } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import app_convex_schema from "./schema.ts";

/** 15 minutes */
const r2_files_upload_url_expires_ms = 15 * 60 * 1000;

const r2_files = new R2(components.r2, {
	bucket: process.env.R2_BUCKET_FILES ?? process.env.R2_BUCKET!,
	endpoint: process.env.R2_ENDPOINT!,
	accessKeyId: process.env.R2_ACCESS_KEY_ID!,
	secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
});

const r2_files_metadata_validator = v.object({
	key: v.string(),
	sha256: v.optional(v.string()),
	contentType: v.optional(v.string()),
	size: v.optional(v.number()),
	bucket: v.string(),
	lastModified: v.string(),
	link: v.string(),
	url: v.string(),
	bucketLink: v.string(),
});

function r2_files_object_key_prefix(args: { workspaceId: string; projectId: string }) {
	return `workspaces/${args.workspaceId}/projects/${args.projectId}/`;
}

function r2_files_object_key_belongs_to_membership(
	key: string,
	membership: Pick<Doc<"workspaces_projects_users">, "workspaceId" | "projectId">,
) {
	return key.startsWith(r2_files_object_key_prefix(membership));
}

function r2_files_normalize_content_type(contentType: string | undefined) {
	const normalized = contentType?.trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length > 255 || /[\r\n]/.test(normalized)) {
		return undefined;
	}
	return normalized;
}

function r2_files_create_upload_key(args: { workspaceId: string; projectId: string }) {
	return `${r2_files_object_key_prefix(args)}uploads/${crypto.randomUUID()}`;
}

export const generate_upload_url = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		filename: v.string(),
		contentType: v.optional(v.string()),
		size: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			uploadId: v.id("files_uploads"),
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

		const key = r2_files_create_upload_key({
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
		});
		const upload = await r2_files.generateUploadUrl(key);
		const contentType = r2_files_normalize_content_type(args.contentType);
		const headers: Record<string, string> = contentType ? { "Content-Type": contentType } : {};
		const now = Date.now();
		const uploadId = await ctx.db.insert("files_uploads", {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			createdBy: membership.userId,
			r2Bucket: r2_files.config.bucket,
			r2Key: upload.key,
			filename: args.filename,
			...(contentType ? { contentType } : {}),
			size: args.size,
			createdAt: now,
			expiresAt: now + r2_files_upload_url_expires_ms,
		});

		return Result({
			_yay: {
				uploadId,
				url: upload.url,
				headers,
			},
		});
	},
});

/**
 * Called by files_content.finalize_upload after the browser uploads the file to R2.
 *
 * Check that the upload row belongs to this user and project, start an R2
 * metadata refresh, and return the upload row data needed for conversion.
 */
export const prepare_upload_for_finalization = internalMutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		uploadId: v.id("files_uploads"),
	},
	returns: v_result({
		_yay: doc(app_convex_schema, "files_uploads"),
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

		const upload = await ctx.db.get("files_uploads", args.uploadId);
		if (!upload) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			upload.workspaceId !== membership.workspaceId ||
			upload.projectId !== membership.projectId ||
			upload.createdBy !== membership.userId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (upload.expiresAt < Date.now()) {
			return Result({ _nay: { message: "Upload expired" } });
		}

		await ctx.scheduler.runAfter(0, components.r2.lib.syncMetadata, {
			key: upload.r2Key,
			...r2_files.config,
		});

		return Result({ _yay: upload });
	},
});

export type r2_prepare_upload_for_finalization_Result =
	typeof prepare_upload_for_finalization extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const sync_metadata = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		key: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
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
		if (!r2_files_object_key_belongs_to_membership(args.key, membership)) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.scheduler.runAfter(0, components.r2.lib.syncMetadata, {
			key: args.key,
			...r2_files.config,
		});

		return Result({ _yay: null });
	},
});

export const get_metadata = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		key: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			metadata: v.union(r2_files_metadata_validator, v.null()),
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
		if (!r2_files_object_key_belongs_to_membership(args.key, membership)) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const metadata = await r2_files.getMetadata(ctx, args.key);
		return Result({ _yay: { metadata } });
	},
});

export const list_metadata = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: v.object({
			page: v.array(r2_files_metadata_validator),
			isDone: v.boolean(),
			continueCursor: v.string(),
			splitCursor: v.optional(v.union(v.null(), v.string())),
			pageStatus: v.optional(v.union(v.null(), v.literal("SplitRecommended"), v.literal("SplitRequired"))),
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

		const metadata = await r2_files.listMetadata(ctx, args.paginationOpts.numItems, args.paginationOpts.cursor);
		const prefix = r2_files_object_key_prefix(membership);
		return Result({
			_yay: {
				...metadata,
				page: metadata.page.filter((item) => item.key.startsWith(prefix)),
			},
		});
	},
});

export const delete_object = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		key: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
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
		if (!r2_files_object_key_belongs_to_membership(args.key, membership)) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.scheduler.runAfter(0, components.r2.lib.deleteObject, {
			key: args.key,
			...r2_files.config,
		});

		return Result({ _yay: null });
	},
});
