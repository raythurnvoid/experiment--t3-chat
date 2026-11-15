// Plugin page tools and shared views: which plugin page tools and plugin view text one chat turn
// may use. The calls themselves travel through `ai_chat_ui_calls` (see `convex/ai_chat_ui_calls.ts`).

import { v } from "convex/values";
import { internalQuery } from "./_generated/server.js";

/**
 * Find the page the chat turn may use, with its tools. Null when the page has no tools for this
 * turn: the plugin is not installed or is off, the member did not consent to page tools, or the
 * page declares none.
 */
export const get_turn_page = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginName: v.string(),
		pageId: v.string(),
	},
	returns: v.union(
		v.object({
			installationId: v.id("plugins_workspace_installations"),
			pluginName: v.string(),
			displayName: v.string(),
			pageTitle: v.string(),
			tools: v.array(v.object({ name: v.string(), description: v.string(), inputSchemaJson: v.string() })),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (
			!installation ||
			installation.status !== "enabled" ||
			!installation.acceptedCapabilities.includes("agent.page-tools")
		) {
			return null;
		}

		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version || version.sourceStatus !== "ready" || version.reviewStatus !== "passed") {
			return null;
		}
		const page = version.pages.find((candidate) => candidate.id === args.pageId);
		if (!page?.agent) {
			return null;
		}

		return {
			installationId: installation._id,
			pluginName: installation.pluginName,
			displayName: version.displayName,
			pageTitle: page.title,
			tools: page.agent.tools,
		};
	},
});

/**
 * Whether the chat turn may read the text a plugin's page or file view shares. True only when the
 * plugin is installed, on, and the admin accepted `agent.view-context`. The host frame checks the
 * same consent, but the request body comes from the browser, so the server checks it again.
 */
export const has_turn_view_context = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginName: v.string(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_pluginName", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (
			!installation ||
			installation.status !== "enabled" ||
			!installation.acceptedCapabilities.includes("agent.view-context")
		) {
			return false;
		}

		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		return !!version && version.sourceStatus === "ready" && version.reviewStatus === "passed";
	},
});
