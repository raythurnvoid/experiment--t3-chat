// List the plugin UI pages and file views installed in a workspace. The app sidebar and every file
// open wait on these lists. Minting and serving the frames stays in plugins_ui.ts.
//
// Keep the imports of this module small. On a cold call Convex loads every file that this module
// imports, even the unused ones. plugins_ui.ts loads jose and the R2 client, which made each cold call
// of these lists take about 300ms instead of about 50ms.

import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

async function db_plugin_workspace_is_live(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	return workspace?.organizationId === args.organizationId && workspace.pluginDataPurgeStartedAt === undefined;
}

export const list_ui_pages = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginName: v.string(),
			displayName: v.string(),
			pluginVersionId: v.id("plugins_versions"),
			pages: v.array(
				v.object({
					id: v.string(),
					title: v.string(),
					entry: v.string(),
					navItem: v.union(v.object({ label: v.string(), icon: v.union(v.string(), v.null()) }), v.null()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return [];
		}

		// Which plugins a workspace runs counts as workspace content, like the activity feed.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return [];
		}

		// The status+pluginName index yields enabled installations already in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled"),
			)
			.collect();

		const entries = await Promise.all(
			installations.map(async (installation) => {
				const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
				if (
					!version ||
					version.sourceStatus !== "ready" ||
					version.reviewStatus !== "passed" ||
					version.pages.length === 0
				) {
					return null;
				}
				return {
					pluginName: installation.pluginName,
					displayName: version.displayName,
					pluginVersionId: version._id,
					pages: version.pages,
				};
			}),
		);

		return entries.filter((entry) => entry !== null);
	},
});

export const list_file_views = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginName: v.string(),
			pluginVersionId: v.id("plugins_versions"),
			installationCreatedAt: v.number(),
			fileViews: v.array(
				v.object({
					id: v.string(),
					title: v.string(),
					entry: v.string(),
					contentTypes: v.array(v.string()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return [];
		}

		// Which plugins a workspace runs counts as workspace content, like the activity feed.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return [];
		}

		// The status+pluginName index yields enabled installations already in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled"),
			)
			.collect();

		const entries = await Promise.all(
			installations.map(async (installation) => {
				const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
				if (
					!version ||
					version.sourceStatus !== "ready" ||
					version.reviewStatus !== "passed" ||
					version.fileViews.length === 0
				) {
					return null;
				}
				return {
					pluginName: installation.pluginName,
					pluginVersionId: version._id,
					// The files UI orders view tabs by installation creation time, so tab order does not
					// depend on query order.
					installationCreatedAt: installation._creationTime,
					fileViews: version.fileViews,
				};
			}),
		);

		return entries.filter((entry) => entry !== null);
	},
});
