import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server.js";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import { r2_delete_object } from "./r2.ts";

// Temporary staged app-data wipe helpers for the user-owned plugin publisher
// migration. The plugin registry drain already ran against the legacy schema;
// delete this module once the wipe is verified.

const count_cap = 1000;

async function capped_count(query: { take: (n: number) => Promise<Array<unknown>> }) {
	const docs = await query.take(count_cap);
	return docs.length;
}

export const preview_app_data_wipe = internalQuery({
	args: {},
	returns: v.object({
		users: v.array(
			v.object({
				userId: v.id("users"),
				clerkUserId: v.union(v.string(), v.null()),
				deletedAt: v.union(v.number(), v.null()),
				displayName: v.union(v.string(), v.null()),
				email: v.union(v.string(), v.null()),
				billingUsageSnapshots: v.number(),
			}),
		),
		legacyPluginRegistry: v.object({
			publisherRepositories: v.number(),
			publisherSecrets: v.number(),
			versions: v.number(),
			versionReviews: v.number(),
			sourceMounts: v.number(),
		}),
		appData: v.object({
			organizations: v.number(),
			workspaces: v.number(),
			filesNodes: v.number(),
			globalMountFilesNodes: v.number(),
			workspaceInstallations: v.number(),
		}),
	}),
	handler: async (ctx) => {
		const userDocs = await ctx.db.query("users").take(count_cap);
		const users = [];
		for (const user of userDocs) {
			const anagraphic = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
			const billingUsageSnapshots = await capped_count(
				ctx.db.query("billing_usage_snapshots").withIndex("by_user", (q) => q.eq("userId", user._id)),
			);
			users.push({
				userId: user._id,
				clerkUserId: user.clerkUserId,
				deletedAt: user.deletedAt ?? null,
				displayName: anagraphic?.displayName ?? null,
				email: anagraphic?.email ?? null,
				billingUsageSnapshots,
			});
		}

		return {
			users,
			legacyPluginRegistry: {
				publisherRepositories: await capped_count(ctx.db.query("plugins_publisher_repositories")),
				publisherSecrets: await capped_count(ctx.db.query("plugins_publisher_secrets")),
				versions: await capped_count(ctx.db.query("plugins_versions")),
				versionReviews: await capped_count(ctx.db.query("plugins_version_reviews")),
				sourceMounts: await capped_count(ctx.db.query("plugins_source_mounts")),
			},
			appData: {
				organizations: await capped_count(ctx.db.query("organizations")),
				workspaces: await capped_count(ctx.db.query("organizations_workspaces")),
				filesNodes: await capped_count(ctx.db.query("files_nodes")),
				globalMountFilesNodes: await capped_count(
					ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_treePath", (q) =>
							q
								.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
								.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
						),
				),
				workspaceInstallations: await capped_count(ctx.db.query("plugins_workspace_installations")),
			},
		};
	},
});

export const delete_legacy_plugin_registry_batch = internalMutation({
	args: {
		batchSize: v.optional(v.number()),
	},
	returns: v.object({ done: v.boolean(), deleted: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;
		let budget = batchSize;

		// Child docs before parents: mounts and reviews reference versions.
		const tables = [
			"plugins_source_mounts",
			"plugins_version_reviews",
			"plugins_versions",
			"plugins_publisher_secrets",
			"plugins_publisher_repositories",
		] as const;

		let deleted = 0;
		for (const table of tables) {
			if (budget <= 0) {
				return { done: false, deleted };
			}
			const docs = await ctx.db.query(table).take(budget);
			for (const doc of docs) {
				await ctx.db.delete(table, doc._id);
			}
			deleted += docs.length;
			budget -= docs.length;
		}

		// A full-budget pass may have drained every table exactly; report done only
		// when a follow-up run would find nothing.
		if (deleted === batchSize) {
			return { done: false, deleted };
		}
		return { done: true, deleted };
	},
});

// Legacy plugin source mounts materialized files into the global GitHub
// workspace; after the registry drain those files are orphans. Mirrors
// github_sources.delete_mount_content_batch (child docs and R2 asset before
// the node doc) but sweeps the whole global workspace instead of one mount.
export const delete_orphan_global_mount_files_batch = internalMutation({
	args: {
		batchSize: v.optional(v.number()),
	},
	returns: v.object({ done: v.boolean(), deleted: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = args.batchSize ?? 100;

		let deleted = 0;
		while (deleted < batchSize) {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_treePath", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
				)
				.order("desc")
				.first();
			if (!node) {
				return { done: true, deleted };
			}

			const plainTextChunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("fileNodeId", node._id),
				)
				.take(batchSize - deleted);
			for (const chunk of plainTextChunks) {
				await ctx.db.delete("files_plain_text_chunks", chunk._id);
				deleted++;
			}
			if (plainTextChunks.length > 0) {
				continue;
			}

			const markdownChunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("fileNodeId", node._id),
				)
				.take(batchSize - deleted);
			for (const chunk of markdownChunks) {
				await ctx.db.delete("files_markdown_chunks", chunk._id);
				deleted++;
			}
			if (markdownChunks.length > 0) {
				continue;
			}

			const fileStats = await ctx.db
				.query("file_stats")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("fileNodeId", node._id),
				)
				.take(batchSize - deleted);
			for (const stats of fileStats) {
				await ctx.db.delete("file_stats", stats._id);
				deleted++;
			}
			if (fileStats.length > 0) {
				continue;
			}

			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("fileNodeId", node._id),
				)
				.take(batchSize - deleted);
			for (const metadataDoc of metadataDocs) {
				await ctx.db.delete("files_metadata_docs", metadataDoc._id);
				deleted++;
			}
			if (metadataDocs.length > 0) {
				continue;
			}

			if (node.assetId) {
				const asset = await ctx.db.get("files_r2_assets", node.assetId);
				if (asset) {
					if (deleted + 2 > batchSize) {
						break;
					}
					if (asset.r2Key) {
						await r2_delete_object(ctx, asset.r2Key);
					}
					await ctx.db.delete("files_r2_assets", asset._id);
					await ctx.db.delete("files_nodes", node._id);
					deleted += 2;
					continue;
				}
			}

			await ctx.db.delete("files_nodes", node._id);
			deleted++;
		}

		return { done: false, deleted };
	},
});
