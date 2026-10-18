// Read a file's stored asset, for preview, download and properties. Only what a file open waits on
// lives here. Uploads and asset jobs stay in r2.ts, because they need its heavy imports.
//
// Keep the imports of this module small. On a cold call Convex loads every file that this module
// imports, even the unused ones. r2.ts loads about 5 MB, which adds about 200ms to each cold file open.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { query } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

export const get_asset_by_file_node_id = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await files_saved_placement_db_get_node(ctx.db, args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.archiveOperationId !== null ||
			!fileNode.assetId
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			return null;
		}

		return asset;
	},
});
