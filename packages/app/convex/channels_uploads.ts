import { v } from "convex/values";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import { action, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_authorize_node } from "./access_control.ts";
import { channels_db_ensure_file_channel, channels_db_get_access } from "./channels.ts";
import { channels_messages_db_is_visible } from "./channels_messages.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { files_stored_uploads_db_admit } from "./files_stored_uploads.ts";
import { files_UPLOAD_URL_TTL_MS } from "./files_nodes.ts";
import {
	files_get_signed_download_serving,
	files_INVALID_CONTENT_TYPE_MESSAGE,
	files_resolve_upload_content_type,
} from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { r2, r2_create_asset_key, r2_get_object_metadata, r2_UNFINALIZED_ASSET_TTL_MS } from "./r2_client.ts";
import type { settle_channel_upload_asset } from "./r2.ts";

// Make Convex reuse the loaded module between calls. No mutable module state is allowed here.
export const experimental_reuseContext = true;

// Starting name bound. Keep message metadata small while preserving native filenames.
const MAX_NAME_LENGTH = 255;
const INVALID_NAME_CHARACTER = /[\/\\\p{Cc}]/u;

async function get_context(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Id<"organizations_workspaces_users">; userId: Id<"users"> },
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user || user.deletedAt != null) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { userAuth: { id: user._id }, membership } });
}

export const create_upload_target = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: v.union(
			v.object({ kind: v.literal("channel"), channelId: v.id("channels") }),
			v.object({ kind: v.literal("file"), fileNodeId: v.id("files_nodes") }),
		),
		name: v.string(),
		contentType: v.optional(v.string()),
		size: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			uploadId: v.id("channels_uploads"),
			url: v.string(),
			headers: v.record(v.string(), v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const context = await get_context(ctx, { membershipId: args.membershipId, userId: userAuth.id });
		if (context._nay) return context;
		const { membership } = context._yay;
		const limit = await rate_limiter_limit_by_key(ctx, { name: "channels_upload_write", key: userAuth.id });
		if (limit) return Result({ _nay: { message: limit.message } });
		let channel = args.target.kind === "channel" ? await ctx.db.get("channels", args.target.channelId) : null;
		if (args.target.kind === "channel") {
			if (!channel) return Result({ _nay: { message: "Not found" } });
			const access = await channels_db_get_access(ctx, { ...context._yay, channel });
			if (access._nay) return access;
			if (!access._yay.canPost) return Result({ _nay: { message: access._yay.postRefusal! } });
		} else {
			const read = await access_control_db_authorize_node(ctx, {
				...context._yay,
				nodeId: args.target.fileNodeId,
				permission: "content.read",
			});
			if (read._nay) return Result({ _nay: { message: "Not found" } });
			const write = await access_control_db_authorize_node(ctx, {
				...context._yay,
				nodeId: args.target.fileNodeId,
				permission: "content.write",
			});
			if (write._nay) return write;
			const file = read._yay.fileNode;
			if (file.kind !== "file" || file.archiveOperationId !== null)
				return Result({ _nay: { message: "This file cannot have new comments" } });
			const asset = file.assetId ? await ctx.db.get("files_r2_assets", file.assetId) : null;
			if (asset?.kind === "upload" && !asset.r2Key)
				return Result({ _nay: { message: "Wait for the file upload to finish" } });
		}
		if (!args.name.trim() || args.name.length > MAX_NAME_LENGTH || INVALID_NAME_CHARACTER.test(args.name))
			return Result({ _nay: { message: "Invalid file name" } });
		const contentType = files_resolve_upload_content_type({ contentType: args.contentType, fileName: args.name });
		if (contentType === null) return Result({ _nay: { message: files_INVALID_CONTENT_TYPE_MESSAGE } });
		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "Upload organization not found";
			const errorData = { membershipId: membership._id, organizationId: membership.organizationId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const admission = await files_stored_uploads_db_admit(ctx, {
			organization,
			actorUserId: userAuth.id,
			workspaceId: membership.workspaceId,
			declaredBytes: [args.size],
		});
		if (admission._nay) return admission;
		// A refused first upload must not create a file channel.
		if (!channel && args.target.kind === "file")
			channel = await channels_db_ensure_file_channel(ctx, {
				membership,
				fileNodeId: args.target.fileNodeId,
				userId: userAuth.id,
			});
		const now = Date.now();
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: "channel_upload",
			r2Bucket: r2.config.bucket,
			size: args.size,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			uploadUrlExpiresAt: now + files_UPLOAD_URL_TTL_MS,
			createdBy: userAuth.id,
			updatedAt: now,
		});
		const uploadId = await ctx.db.insert("channels_uploads", {
			channelId: channel!._id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId,
			uploaderUserId: userAuth.id,
			name: args.name,
			contentType,
			messageId: null,
			createdAt: now,
		});
		const signed = await r2.generateUploadUrl(r2_create_asset_key({ ...membership, assetId }), {
			createOnly: true,
			expiresIn: files_UPLOAD_URL_TTL_MS / 1000,
		});
		return Result({
			_yay: { uploadId, url: signed.url, headers: { "Content-Type": contentType, "If-None-Match": "*" } },
		});
	},
});

export const get_upload_for_action = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		uploadId: v.id("channels_uploads"),
		operation: v.union(v.literal("settle"), v.literal("download")),
	},
	returns: v_result({
		_yay: v.object({
			upload: doc(app_convex_schema, "channels_uploads"),
			asset: doc(app_convex_schema, "files_r2_assets"),
		}),
	}),
	handler: async (ctx, args) => {
		const context = await get_context(ctx, args);
		if (context._nay) return context;
		const upload = await ctx.db.get("channels_uploads", args.uploadId);
		if (
			!upload ||
			upload.organizationId !== context._yay.membership.organizationId ||
			upload.workspaceId !== context._yay.membership.workspaceId
		)
			return Result({ _nay: { message: "Not found" } });
		const channel = await ctx.db.get("channels", upload.channelId);
		if (!channel) return Result({ _nay: { message: "Not found" } });
		const access = await channels_db_get_access(ctx, { ...context._yay, channel });
		if (access._nay) return access;
		if (args.operation === "settle" || upload.messageId === null) {
			if (upload.uploaderUserId !== args.userId) return Result({ _nay: { message: "Not found" } });
		} else {
			const message = await ctx.db.get("channels_messages", upload.messageId);
			if (
				!message ||
				message.channelId !== channel._id ||
				message.deletedAt !== null ||
				!(await channels_messages_db_is_visible(ctx, message, args.userId))
			)
				return Result({ _nay: { message: "Not found" } });
		}
		const asset = await ctx.db.get("files_r2_assets", upload.assetId);
		if (
			!asset ||
			asset.kind !== "channel_upload" ||
			asset.organizationId !== upload.organizationId ||
			asset.workspaceId !== upload.workspaceId
		)
			return Result({ _nay: { message: "Not found" } });
		if (asset.unfinalizedExpiresAt !== undefined && asset.unfinalizedExpiresAt <= Date.now())
			return Result({ _nay: { message: "This upload expired" } });
		if (args.operation === "download" && asset.r2Key === undefined)
			return Result({ _nay: { message: "Wait for the file upload to finish" } });
		return Result({ _yay: { upload, asset } });
	},
});

type get_upload_for_action_Result =
	typeof get_upload_for_action extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type settle_channel_upload_asset_Result =
	typeof settle_channel_upload_asset extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const settle_upload = action({
	args: { membershipId: v.id("organizations_workspaces_users"), uploadId: v.id("channels_uploads") },
	returns: v_result({ _yay: v.null() }),
	handler: async (
		ctx,
		args,
	): Promise<{ _yay: null; _nay?: undefined } | { _nay: { message: string; name?: string }; _yay?: undefined }> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const checked = (await ctx.runQuery(internal.channels_uploads.get_upload_for_action, {
			...args,
			userId: userAuth.id,
			operation: "settle",
		})) as get_upload_for_action_Result;
		if (checked._nay) return checked;
		if (checked._yay.asset.r2Key !== undefined) return Result({ _yay: null });
		const key = r2_create_asset_key({ ...checked._yay.upload, assetId: checked._yay.asset._id });
		const metadata = await r2_get_object_metadata(ctx, key);
		if (!metadata) return Result({ _nay: { message: "The upload is not ready yet" } });
		return (await ctx.runMutation(internal.r2.settle_channel_upload_asset, {
			assetId: checked._yay.asset._id,
			r2Key: key,
			size: metadata.size,
			etag: metadata.etag,
		})) as settle_channel_upload_asset_Result;
	},
});

export const get_upload_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		uploadId: v.id("channels_uploads"),
		download: v.optional(v.boolean()),
	},
	returns: v_result({ _yay: v.object({ url: v.string(), expiresAt: v.number() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const checked = (await ctx.runQuery(internal.channels_uploads.get_upload_for_action, {
			membershipId: args.membershipId,
			uploadId: args.uploadId,
			userId: userAuth.id,
			operation: "download",
		})) as get_upload_for_action_Result;
		if (checked._nay) return checked;
		const url = await r2.getUrl(checked._yay.asset.r2Key!, {
			expiresIn: files_UPLOAD_URL_TTL_MS / 1000,
			...files_get_signed_download_serving({
				contentType: checked._yay.upload.contentType,
				fileName: checked._yay.upload.name,
				download: args.download,
			}),
		});
		return Result({ _yay: { url, expiresAt: Date.now() + files_UPLOAD_URL_TTL_MS } });
	},
});
