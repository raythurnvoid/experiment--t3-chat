import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server.js";
import { files_sort_validator } from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_nodes_db_require_user_writable } from "./files_nodes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_sort_DEFAULT, files_sort_field_is_valid } from "../shared/files-sort.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

// The saved sort of a folder's table. Each folder has at most one doc, and every member sees it.
// A folder with no doc sorts by Name, A to Z.

/**
 * Load the folder of a member's workspace. The root has no node, so it loads as null.
 */
async function db_get_folder(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		folderId: Id<"files_nodes"> | typeof files_ROOT_ID;
	},
) {
	if (args.folderId === files_ROOT_ID) {
		return Result({ _yay: null });
	}

	const folder = await ctx.db.get("files_nodes", args.folderId);
	// A node from another workspace is not this member's to see.
	if (
		!folder ||
		folder.kind !== "folder" ||
		folder.organizationId !== args.membership.organizationId ||
		folder.workspaceId !== args.membership.workspaceId
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	return Result({ _yay: folder });
}

/**
 * Saving a sort is a write to the folder, like its metadata. So it needs `content.write`, and a
 * read-only folder refuses it. The root has no write policy, so only the workspace permission
 * applies there.
 */
async function db_authorize_sort_write(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		folder: Doc<"files_nodes"> | null;
	},
) {
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: "content.write",
		fileNode: args.folder ?? undefined,
	});
	if (authorized._nay) {
		return authorized;
	}

	if (args.folder) {
		const writable = await files_nodes_db_require_user_writable(ctx, { node: args.folder, userId: args.userAuth.id });
		if (writable._nay) {
			return writable;
		}
	}

	return Result({ _yay: null });
}

async function db_get_folder_sort_doc(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		folderId: Id<"files_nodes"> | typeof files_ROOT_ID;
	},
) {
	return await ctx.db
		.query("files_folder_sorts")
		.withIndex("by_organization_workspace_folder", (q) =>
			q
				.eq("organizationId", args.membership.organizationId)
				.eq("workspaceId", args.membership.workspaceId)
				.eq("folderId", args.folderId),
		)
		.unique();
}

export const get_folder_sort = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: v.union(v.id("files_nodes"), v.literal("root")),
	},
	returns: v.union(v.object({ sort: files_sort_validator, canSave: v.boolean() }), v.null()),
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

		const folder = await db_get_folder(ctx, { membership, folderId: args.folderId });
		if (folder._nay) {
			return null;
		}

		// Ask about the folder, not the workspace, so a restricted folder is refused here too.
		const readable = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode: folder._yay ?? undefined,
		});
		if (readable._nay) {
			// A member with no workspace read still sees the root children shared with them, so give them
			// a sort they cannot save. Use the default: the saved one could name a metadata key they
			// cannot see.
			if (args.folderId === files_ROOT_ID && readable._nay.message === "Permission denied") {
				return { sort: files_sort_DEFAULT, canSave: false };
			}

			return null;
		}

		const [sortDoc, writable] = await Promise.all([
			db_get_folder_sort_doc(ctx, { membership, folderId: args.folderId }),
			db_authorize_sort_write(ctx, { userAuth, membership, folder: folder._yay }),
		]);

		return { sort: sortDoc?.sort ?? files_sort_DEFAULT, canSave: !writable._nay };
	},
});

export const set_folder_sort = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: v.union(v.id("files_nodes"), v.literal("root")),
		sort: files_sort_validator,
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

		const folder = await db_get_folder(ctx, { membership, folderId: args.folderId });
		if (folder._nay) {
			return folder;
		}

		const authorized = await db_authorize_sort_write(ctx, { userAuth, membership, folder: folder._yay });
		if (authorized._nay) {
			return authorized;
		}

		if (!files_sort_field_is_valid(args.sort.field)) {
			return Result({ _nay: { message: "This field cannot be sorted." } });
		}

		const now = Date.now();
		const sortDoc = await db_get_folder_sort_doc(ctx, { membership, folderId: args.folderId });

		// Name, A to Z is what a folder with no doc shows, so store it as no doc.
		if (args.sort.field === files_sort_DEFAULT.field && args.sort.direction === files_sort_DEFAULT.direction) {
			if (sortDoc) {
				await ctx.db.delete("files_folder_sorts", sortDoc._id);
			}
		} else if (sortDoc) {
			await ctx.db.patch("files_folder_sorts", sortDoc._id, {
				sort: args.sort,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("files_folder_sorts", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				folderId: args.folderId,
				sort: args.sort,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
		}

		return Result({ _yay: null });
	},
});
