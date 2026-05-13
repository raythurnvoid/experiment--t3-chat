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
import { files_ROOT_ID } from "../server/files.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import app_convex_schema from "./schema.ts";

/** 15 minutes */
const r2_files_upload_url_expires_ms = 15 * 60 * 1000;
const r2_files_upload_conversion_stale_ms = 15 * 60 * 1000;

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
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
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
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get(args.parentId);
			if (
				!parent ||
				parent.workspaceId !== membership.workspaceId ||
				parent.projectId !== membership.projectId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== undefined
			) {
				return Result({ _nay: { message: "Parent file not found" } });
			}
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
			parentId: args.parentId,
			r2Bucket: r2_files.config.bucket,
			r2Key: upload.key,
			filename: args.filename,
			...(contentType ? { contentType } : {}),
			size: args.size,
			createdAt: now,
			expiresAt: now + r2_files_upload_url_expires_ms,
			status: "pending",
			conversionAttempts: 0,
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
 * Called by the temporary manual fallback after the browser uploads the file to R2.
 *
 * Check that the upload row belongs to this user and project, start an R2
 * metadata refresh, and return the upload row data needed for conversion.
 */
export const prepare_upload_for_finalization = internalMutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
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
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get(args.parentId);
			if (
				!parent ||
				parent.workspaceId !== membership.workspaceId ||
				parent.projectId !== membership.projectId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== undefined
			) {
				return Result({ _nay: { message: "Parent file not found" } });
			}
		}
		if (upload.expiresAt < Date.now()) {
			return Result({ _nay: { message: "Upload expired" } });
		}
		if (!upload.assetId || !upload.sourceNodeId || !upload.shadowNodeId) {
			await ctx.db.patch("files_uploads", upload._id, {
				parentId: upload.parentId ?? args.parentId,
				status: "converting",
				uploadedAt: upload.uploadedAt ?? Date.now(),
				conversionStartedAt: Date.now(),
				conversionAttempts: (upload.conversionAttempts ?? 0) + 1,
				failedAt: undefined,
				failureMessage: undefined,
			});
		}

		if (process.env.NODE_ENV !== "test") {
			await ctx.scheduler.runAfter(0, components.r2.lib.syncMetadata, {
				key: upload.r2Key,
				...r2_files.config,
			});
		}

		return Result({ _yay: (await ctx.db.get(upload._id)) ?? upload });
	},
});

export type r2_prepare_upload_for_finalization_Result =
	typeof prepare_upload_for_finalization extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const prepare_upload_for_r2_event_finalization = internalMutation({
	args: {
		cloudflareMessageId: v.string(),
		action: v.string(),
		bucket: v.string(),
		key: v.string(),
		size: v.optional(v.number()),
		eTag: v.optional(v.string()),
		eventTime: v.string(),
	},
	returns: v_result({
		_yay: v.union(
			v.object({
				type: v.literal("ignored"),
				reason: v.string(),
			}),
			v.object({
				type: v.literal("in_progress"),
				retryAfterMs: v.number(),
			}),
			v.object({
				type: v.literal("already_finalized"),
				assetId: v.id("files_r2_assets"),
				sourceNodeId: v.id("files_nodes"),
				shadowNodeId: v.id("files_nodes"),
			}),
			v.object({
				type: v.literal("claimed"),
				upload: doc(app_convex_schema, "files_uploads"),
			}),
		),
	}),
	handler: async (ctx, args) => {
		if (args.bucket !== r2_files.config.bucket) {
			return Result({
				_yay: {
					type: "ignored",
					reason: "Bucket does not match configured files bucket",
				},
			});
		}

		const upload = await ctx.db
			.query("files_uploads")
			.withIndex("by_r2Bucket_r2Key", (q) => q.eq("r2Bucket", args.bucket).eq("r2Key", args.key))
			.unique();
		if (!upload) {
			return Result({
				_yay: {
					type: "ignored",
					reason: "Upload row not found",
				},
			});
		}
		if (upload.assetId && upload.sourceNodeId && upload.shadowNodeId) {
			return Result({
				_yay: {
					type: "already_finalized",
					assetId: upload.assetId,
					sourceNodeId: upload.sourceNodeId,
					shadowNodeId: upload.shadowNodeId,
				},
			});
		}

		const now = Date.now();
		if (
			upload.status === "converting" &&
			upload.conversionStartedAt !== undefined &&
			upload.conversionStartedAt > now - r2_files_upload_conversion_stale_ms
		) {
			return Result({
				_yay: {
					type: "in_progress",
					retryAfterMs: 30_000,
				},
			});
		}

		await ctx.db.patch(upload._id, {
			status: "converting",
			uploadedAt: upload.uploadedAt ?? now,
			conversionStartedAt: now,
			conversionAttempts: (upload.conversionAttempts ?? 0) + 1,
			failedAt: undefined,
			failureMessage: undefined,
			r2EventCloudflareMessageId: args.cloudflareMessageId,
			r2EventAction: args.action,
			r2EventTime: args.eventTime,
			...(args.size === undefined ? {} : { r2EventSize: args.size }),
			...(args.eTag === undefined ? {} : { r2EventEtag: args.eTag }),
		});

		if (process.env.NODE_ENV !== "test") {
			await ctx.scheduler.runAfter(0, components.r2.lib.syncMetadata, {
				key: upload.r2Key,
				...r2_files.config,
			});
		}

		const claimedUpload = await ctx.db.get(upload._id);
		if (!claimedUpload) {
			return Result({
				_nay: {
					message: "Upload row not found after claim",
				},
			});
		}

		return Result({
			_yay: {
				type: "claimed",
				upload: claimedUpload,
			},
		});
	},
});

export type r2_prepare_upload_for_r2_event_finalization_Result =
	typeof prepare_upload_for_r2_event_finalization extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const mark_upload_finalization_failed = internalMutation({
	args: {
		uploadId: v.id("files_uploads"),
		message: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const upload = await ctx.db.get(args.uploadId);
		if (!upload || (upload.assetId && upload.sourceNodeId && upload.shadowNodeId)) {
			return null;
		}

		await ctx.db.patch(upload._id, {
			status: "failed",
			failedAt: Date.now(),
			failureMessage: args.message,
		});

		return null;
	},
});

export const list_recent_uploads = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v_result({
		_yay: v.array(
			v.object({
				uploadId: v.id("files_uploads"),
				parentId: v.optional(v.union(v.id("files_nodes"), v.literal(files_ROOT_ID))),
				filename: v.string(),
				status: v.union(
					v.literal("pending"),
					v.literal("uploaded"),
					v.literal("converting"),
					v.literal("finalized"),
					v.literal("failed"),
				),
				createdAt: v.number(),
				uploadedAt: v.optional(v.number()),
				conversionStartedAt: v.optional(v.number()),
				failedAt: v.optional(v.number()),
				failureMessage: v.optional(v.string()),
			}),
		),
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

		const rows = (
			await Promise.all(
				(["pending", "uploaded", "converting", "failed"] as const).map((status) =>
					ctx.db
						.query("files_uploads")
						.withIndex("by_workspace_project_status_createdAt", (q) =>
							q
								.eq("workspaceId", membership.workspaceId)
								.eq("projectId", membership.projectId)
								.eq("status", status),
						)
						.order("desc")
						.take(10),
				),
			)
		)
			.flat()
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 20);

		return Result({
			_yay: rows.map((upload) => ({
				uploadId: upload._id,
				parentId: upload.parentId,
				filename: upload.filename,
				status: upload.status ?? "pending",
				createdAt: upload.createdAt,
				uploadedAt: upload.uploadedAt,
				conversionStartedAt: upload.conversionStartedAt,
				failedAt: upload.failedAt,
				failureMessage: upload.failureMessage,
			})),
		});
	},
});

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

		if (process.env.NODE_ENV !== "test") {
			await ctx.scheduler.runAfter(0, components.r2.lib.syncMetadata, {
				key: args.key,
				...r2_files.config,
			});
		}

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

		if (process.env.NODE_ENV !== "test") {
			await ctx.scheduler.runAfter(0, components.r2.lib.deleteObject, {
				key: args.key,
				...r2_files.config,
			});
		}

		return Result({ _yay: null });
	},
});
