import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { R2 } from "@convex-dev/r2";
import { components } from "./_generated/api.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { workspaces_db_get_membership_for_user } from "./workspaces.ts";

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

async function r2_files_get_authorized_membership(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Doc<"workspaces_projects_users">["_id"] },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const membership = await workspaces_db_get_membership_for_user(ctx, {
		userId: userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	return Result({ _yay: membership });
}

function r2_files_object_key_prefix(args: { workspaceId: string; projectId: string }) {
	return `workspaces/${args.workspaceId}/projects/${args.projectId}/`;
}

function r2_files_object_key_belongs_to_membership(
	key: string,
	membership: Pick<Doc<"workspaces_projects_users">, "workspaceId" | "projectId">,
) {
	return key.startsWith(r2_files_object_key_prefix(membership));
}

function r2_files_normalize_upload_filename(filename: string) {
	const baseName = filename.trim().replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "upload";
	const normalized = baseName
		.split("")
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code > 31 && code !== 127;
		})
		.join("")
		.replace(/[^A-Za-z0-9._ -]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);

	return normalized || "upload";
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

function r2_files_create_upload_key(args: { workspaceId: string; projectId: string; filename: string }) {
	const filename = r2_files_normalize_upload_filename(args.filename);
	return `${r2_files_object_key_prefix(args)}uploads/${crypto.randomUUID()}/${filename}`;
}

export const generate_upload_url = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		filename: v.string(),
		contentType: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			bucket: v.string(),
			key: v.string(),
			url: v.string(),
			headers: v.record(v.string(), v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const membershipResult = await r2_files_get_authorized_membership(ctx, {
			membershipId: args.membershipId,
		});
		if (membershipResult._nay) {
			return membershipResult;
		}

		const key = r2_files_create_upload_key({
			workspaceId: membershipResult._yay.workspaceId,
			projectId: membershipResult._yay.projectId,
			filename: args.filename,
		});
		const upload = await r2_files.generateUploadUrl(key);
		const contentType = r2_files_normalize_content_type(args.contentType);

		return Result({
			_yay: {
				bucket: r2_files.config.bucket,
				key: upload.key,
				url: upload.url,
				headers: contentType ? { "Content-Type": contentType } : {},
			},
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
		const membershipResult = await r2_files_get_authorized_membership(ctx, {
			membershipId: args.membershipId,
		});
		if (membershipResult._nay) {
			return membershipResult;
		}
		if (!r2_files_object_key_belongs_to_membership(args.key, membershipResult._yay)) {
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
		const membershipResult = await r2_files_get_authorized_membership(ctx, {
			membershipId: args.membershipId,
		});
		if (membershipResult._nay) {
			return membershipResult;
		}
		if (!r2_files_object_key_belongs_to_membership(args.key, membershipResult._yay)) {
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
		const membershipResult = await r2_files_get_authorized_membership(ctx, {
			membershipId: args.membershipId,
		});
		if (membershipResult._nay) {
			return membershipResult;
		}

		const metadata = await r2_files.listMetadata(ctx, args.paginationOpts.numItems, args.paginationOpts.cursor);
		const prefix = r2_files_object_key_prefix(membershipResult._yay);
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
		const membershipResult = await r2_files_get_authorized_membership(ctx, {
			membershipId: args.membershipId,
		});
		if (membershipResult._nay) {
			return membershipResult;
		}
		if (!r2_files_object_key_belongs_to_membership(args.key, membershipResult._yay)) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.scheduler.runAfter(0, components.r2.lib.deleteObject, {
			key: args.key,
			...r2_files.config,
		});

		return Result({ _yay: null });
	},
});
