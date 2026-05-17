import { describe, expect, test } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { components, internal } from "./_generated/api.js";

const migrations_test_modules = import.meta.glob("./**/*.ts");

const migrations_test_schema = defineSchema({
	users: defineTable({
		clerkUserId: v.union(v.string(), v.null()),
	}).index("by_clerkUser", ["clerkUserId"]),
	workspaces: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		updatedAt: v.number(),
	}),
	workspaces_projects: defineTable({
		workspaceId: v.id("workspaces"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}),
	notifications: defineTable({
		userId: v.id("users"),
		kind: v.literal("workspace_project_invite"),
		read: v.boolean(),
		actorUserId: v.id("users"),
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		createdAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_user_read", ["userId", "read"])
		.index("by_workspace_user_read", ["workspaceId", "userId", "read"])
		.index("by_workspace_project_user", ["workspaceId", "projectId", "userId"]),
	files_nodes: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		name: v.string(),
		kind: v.union(v.literal("folder"), v.literal("file")),
		shadowSourceNodeId: v.optional(v.id("files_nodes")),
		shadowNodeIds: v.optional(v.array(v.id("files_nodes"))),
		shadowSourceFileNodeId: v.optional(v.id("files_nodes")),
		shadowFileNodeIds: v.optional(v.array(v.id("files_nodes"))),
		version: v.number(),
		archiveOperationId: v.optional(v.string()),
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	}),
	files_r2_assets: defineTable({
		workspaceId: v.string(),
		projectId: v.string(),
		r2Bucket: v.string(),
		r2Key: v.string(),
		filename: v.string(),
		contentType: v.optional(v.string()),
		size: v.optional(v.number()),
		sourceNodeId: v.id("files_nodes"),
		shadowNodeId: v.optional(v.id("files_nodes")),
		createdBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
});

describe("remove_notifications_created_at", () => {
	test("removes legacy createdAt from notification rows", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const [userId, actorUserId] = await Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notification-created-at" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notification-created-at-actor" }),
			]);
			const workspaceId = await ctx.db.insert("workspaces", {
				name: "legacy-notification-created-at-workspace",
				description: "",
				default: false,
				updatedAt: 100,
			});
			const projectId = await ctx.db.insert("workspaces_projects", {
				workspaceId,
				name: "home",
				description: "",
				default: true,
				updatedAt: 100,
			});
			const notificationId = await ctx.db.insert("notifications", {
				userId,
				kind: "workspace_project_invite",
				read: false,
				actorUserId,
				workspaceId,
				projectId,
				createdAt: 100,
				updatedAt: 100,
			});

			return { notificationId, userId, actorUserId, workspaceId, projectId };
		});

		const notification = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.remove_notifications_created_at);

			return await ctx.db.get("notifications", legacy.notificationId);
		});

		expect(notification).toMatchObject({
			userId: legacy.userId,
			kind: "workspace_project_invite",
			read: false,
			actorUserId: legacy.actorUserId,
			workspaceId: legacy.workspaceId,
			projectId: legacy.projectId,
			updatedAt: 100,
		});
		expect(notification).not.toHaveProperty("createdAt");
	});
});

describe("node-owned shadow files migrations", () => {
	test("backfills node shadow links from legacy asset shadow pointers and removes the asset field", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-shadow-links" });
			const sourceNodeId = await ctx.db.insert("files_nodes", {
				workspaceId: "workspace_legacy_shadow_links",
				projectId: "project_legacy_shadow_links",
				path: "/report.pdf",
				name: "report.pdf",
				kind: "file",
				version: 0,
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			const shadowNodeId = await ctx.db.insert("files_nodes", {
				workspaceId: "workspace_legacy_shadow_links",
				projectId: "project_legacy_shadow_links",
				path: "/report.pdf.shadow.md",
				name: "report.pdf.shadow.md",
				kind: "file",
				version: 0,
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: "workspace_legacy_shadow_links",
				projectId: "project_legacy_shadow_links",
				r2Bucket: "bucket",
				r2Key: "key",
				filename: "report.pdf",
				sourceNodeId,
				shadowNodeId,
				createdBy: userId,
				createdAt: 100,
				updatedAt: 100,
			});

			return { sourceNodeId, shadowNodeId, assetId };
		});

		const migrated = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_shadow_file_node_ids);
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_node_shadow_links_from_assets);
			await runToCompletion(ctx, components.migrations, internal.migrations.remove_files_r2_assets_shadow_node_id);

			const [source, shadow, asset] = await Promise.all([
				ctx.db.get("files_nodes", legacy.sourceNodeId),
				ctx.db.get("files_nodes", legacy.shadowNodeId),
				ctx.db.get("files_r2_assets", legacy.assetId),
			]);
			return { source, shadow, asset };
		});

		expect(migrated.source?.shadowFileNodeIds).toEqual([legacy.shadowNodeId]);
		expect(migrated.shadow?.shadowSourceFileNodeId).toBe(legacy.sourceNodeId);
		expect(migrated.shadow?.shadowFileNodeIds).toEqual([]);
		expect(migrated.asset).not.toHaveProperty("shadowNodeId");
	});

	test("renames intermediate node-owned shadow fields to explicit file-node names", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-intermediate-shadow-field-names" });
			const sourceNodeId = await ctx.db.insert("files_nodes", {
				workspaceId: "workspace_intermediate_shadow_field_names",
				projectId: "project_intermediate_shadow_field_names",
				path: "/report.pdf",
				name: "report.pdf",
				kind: "file",
				shadowNodeIds: [],
				version: 0,
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			const shadowNodeId = await ctx.db.insert("files_nodes", {
				workspaceId: "workspace_intermediate_shadow_field_names",
				projectId: "project_intermediate_shadow_field_names",
				path: "/report.pdf.shadow.md",
				name: "report.pdf.shadow.md",
				kind: "file",
				shadowSourceNodeId: sourceNodeId,
				shadowNodeIds: [],
				version: 0,
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			await ctx.db.patch("files_nodes", sourceNodeId, {
				shadowNodeIds: [shadowNodeId],
			});

			return { sourceNodeId, shadowNodeId };
		});

		const migrated = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_shadow_file_node_ids);

			const [source, shadow] = await Promise.all([
				ctx.db.get("files_nodes", legacy.sourceNodeId),
				ctx.db.get("files_nodes", legacy.shadowNodeId),
			]);
			return { source, shadow };
		});

		expect(migrated.source?.shadowFileNodeIds).toEqual([legacy.shadowNodeId]);
		expect(migrated.source).not.toHaveProperty("shadowNodeIds");
		expect(migrated.shadow?.shadowSourceFileNodeId).toBe(legacy.sourceNodeId);
		expect(migrated.shadow?.shadowFileNodeIds).toEqual([]);
		expect(migrated.shadow).not.toHaveProperty("shadowSourceNodeId");
		expect(migrated.shadow).not.toHaveProperty("shadowNodeIds");
	});
});
