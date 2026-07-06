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
	organizations: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		defaultWorkspaceId: v.optional(v.id("organizations_workspaces")),
		updatedAt: v.number(),
	}),
	organizations_workspaces: defineTable({
		organizationId: v.id("organizations"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}),
	notifications: defineTable({
		userId: v.id("users"),
		kind: v.literal("organization_workspace_invite"),
		read: v.boolean(),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_user_read", ["userId", "read"])
		.index("by_organization_user_read", ["organizationId", "userId", "read"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),
	files_nodes: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		path: v.string(),
		pathDepth: v.optional(v.number()),
		lowercaseExtension: v.optional(v.union(v.string(), v.null())),
		name: v.string(),
		kind: v.union(v.literal("folder"), v.literal("file")),
		archiveOperationId: v.optional(v.string()),
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	}),
	files_markdown_chunks: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		fileNodeId: v.id("files_nodes"),
		sourceKind: v.union(v.literal("committed"), v.literal("pending")),
		userId: v.optional(v.string()),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		yjsSequence: v.optional(v.number()),
		chunkIndex: v.number(),
		markdownChunk: v.string(),
		startIndex: v.number(),
		endIndex: v.number(),
		lineStart: v.number(),
		lineEnd: v.number(),
		chunkFlags: v.number(),
	}),
	files_plain_text_chunks: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		fileNodeId: v.optional(v.id("files_nodes")),
		nodeId: v.optional(v.id("files_nodes")),
		yjsSequence: v.number(),
		chunkIndex: v.number(),
		path: v.optional(v.string()),
		archiveOperationId: v.optional(v.string()),
		plainTextChunk: v.string(),
		markdownChunkId: v.id("files_markdown_chunks"),
	}),
	plugins_workspace_installation_secrets: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		installationId: v.string(),
		pluginName: v.string(),
		name: v.string(),
		ciphertext: v.bytes(),
		nonce: v.bytes(),
		keyVersion: v.optional(v.number()),
		valuePreview: v.string(),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),
});

describe("rename_plain_text_chunks_file_node_id", () => {
	test("renames legacy nodeId to fileNodeId", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-files-node-id-rename" });
			const fileId = await ctx.db.insert("files_nodes", {
				organizationId: "organization-files-node-id-rename",
				workspaceId: "workspace-files-node-id-rename",
				path: "/docs/readme.md",
				name: "readme.md",
				kind: "file",
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			const markdownChunkId = await ctx.db.insert("files_markdown_chunks", {
				organizationId: "organization-files-node-id-rename",
				workspaceId: "workspace-files-node-id-rename",
				fileNodeId: fileId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				markdownChunk: "hello",
				startIndex: 0,
				endIndex: 5,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
			});
			const plainTextChunkId = await ctx.db.insert("files_plain_text_chunks", {
				organizationId: "organization-files-node-id-rename",
				workspaceId: "workspace-files-node-id-rename",
				nodeId: fileId,
				yjsSequence: 0,
				chunkIndex: 0,
				plainTextChunk: "hello",
				markdownChunkId,
			});

			return { fileId, plainTextChunkId };
		});

		const plainTextChunk = await t.run(async (ctx) => {
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.rename_plain_text_chunks_file_node_id,
			);

			return await ctx.db.get("files_plain_text_chunks", legacy.plainTextChunkId);
		});

		expect(plainTextChunk).toMatchObject({ fileNodeId: legacy.fileId });
		expect(plainTextChunk).not.toHaveProperty("nodeId");
	});
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
			const organizationId = await ctx.db.insert("organizations", {
				name: "legacy-notification-created-at-organization",
				description: "",
				default: false,
				updatedAt: 100,
			});
			const workspaceId = await ctx.db.insert("organizations_workspaces", {
				organizationId,
				name: "home",
				description: "",
				default: true,
				updatedAt: 100,
			});
			const notificationId = await ctx.db.insert("notifications", {
				userId,
				kind: "organization_workspace_invite",
				read: false,
				actorUserId,
				organizationId,
				workspaceId,
				createdAt: 100,
				updatedAt: 100,
			});

			return { notificationId, userId, actorUserId, organizationId, workspaceId };
		});

		const notification = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.remove_notifications_created_at);

			return await ctx.db.get("notifications", legacy.notificationId);
		});

		expect(notification).toMatchObject({
			userId: legacy.userId,
			kind: "organization_workspace_invite",
			read: false,
			actorUserId: legacy.actorUserId,
			organizationId: legacy.organizationId,
			workspaceId: legacy.workspaceId,
			updatedAt: 100,
		});
		expect(notification).not.toHaveProperty("createdAt");
	});
});

describe("remove_plugins_workspace_installation_secrets_key_version", () => {
	test("removes legacy keyVersion from installation secret rows", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-installation-secret-key-version" });
			const secretId = await ctx.db.insert("plugins_workspace_installation_secrets", {
				organizationId: "organization-legacy-installation-secret-key-version",
				workspaceId: "workspace-legacy-installation-secret-key-version",
				installationId: "installation-legacy-installation-secret-key-version",
				pluginName: "media",
				name: "OPENAI_API_KEY",
				ciphertext: new TextEncoder().encode("ciphertext").buffer,
				nonce: new TextEncoder().encode("nonce").buffer,
				keyVersion: 1,
				valuePreview: "configured",
				createdBy: userId,
				updatedBy: userId,
				createdAt: 100,
				updatedAt: 100,
			});

			return { secretId };
		});

		const secret = await t.run(async (ctx) => {
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.remove_plugins_workspace_installation_secrets_key_version,
			);

			return await ctx.db.get("plugins_workspace_installation_secrets", legacy.secretId);
		});

		expect(secret).toMatchObject({ pluginName: "media", valuePreview: "configured", updatedAt: 100 });
		expect(secret).not.toHaveProperty("keyVersion");
	});
});

describe("files chunk search backfills", () => {
	test("backfills node path depth and plain text chunk scope fields", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-files-backfill" });
			const fileId = await ctx.db.insert("files_nodes", {
				organizationId: "organization-files-backfill",
				workspaceId: "workspace-files-backfill",
				path: "/docs/readme.md",
				name: "readme.md",
				kind: "file",
				archiveOperationId: "archive-files-backfill",
				parentId: "root",
				createdBy: userId,
				updatedBy: userId,
				updatedAt: 100,
			});
			const markdownChunkId = await ctx.db.insert("files_markdown_chunks", {
				organizationId: "organization-files-backfill",
				workspaceId: "workspace-files-backfill",
				fileNodeId: fileId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				markdownChunk: "hello",
				startIndex: 0,
				endIndex: 5,
				lineStart: 1,
				lineEnd: 1,
				chunkFlags: 0,
			});
			const plainTextChunkId = await ctx.db.insert("files_plain_text_chunks", {
				organizationId: "organization-files-backfill",
				workspaceId: "workspace-files-backfill",
				fileNodeId: fileId,
				yjsSequence: 0,
				chunkIndex: 0,
				plainTextChunk: "hello",
				markdownChunkId,
			});

			return { fileId, plainTextChunkId };
		});

		const result = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_path_depth);
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_plain_text_chunk_scope);

			const fileNode = await ctx.db.get("files_nodes", legacy.fileId);
			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", legacy.plainTextChunkId);
			return { fileNode, plainTextChunk };
		});

		expect(result.fileNode).toMatchObject({ pathDepth: 2 });
		expect(result.plainTextChunk).toMatchObject({
			path: "/docs/readme.md",
			archiveOperationId: "archive-files-backfill",
		});
	});

	test("backfills lowercase extension for file nodes", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-files-extension-backfill" });
			const [markdownFileId, folderId, extensionlessFileId] = await Promise.all([
				ctx.db.insert("files_nodes", {
					organizationId: "organization-files-extension-backfill",
					workspaceId: "workspace-files-extension-backfill",
					path: "/docs/README.MD",
					name: "README.MD",
					kind: "file",
					parentId: "root",
					createdBy: userId,
					updatedBy: userId,
					updatedAt: 100,
				}),
				ctx.db.insert("files_nodes", {
					organizationId: "organization-files-extension-backfill",
					workspaceId: "workspace-files-extension-backfill",
					path: "/docs",
					name: "docs",
					kind: "folder",
					parentId: "root",
					createdBy: userId,
					updatedBy: userId,
					updatedAt: 100,
				}),
				ctx.db.insert("files_nodes", {
					organizationId: "organization-files-extension-backfill",
					workspaceId: "workspace-files-extension-backfill",
					path: "/LICENSE",
					name: "LICENSE",
					kind: "file",
					parentId: "root",
					createdBy: userId,
					updatedBy: userId,
					updatedAt: 100,
				}),
			]);

			return { markdownFileId, folderId, extensionlessFileId };
		});

		const result = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_lowercase_extension);

			const [markdownFile, folder, extensionlessFile] = await Promise.all([
				ctx.db.get("files_nodes", legacy.markdownFileId),
				ctx.db.get("files_nodes", legacy.folderId),
				ctx.db.get("files_nodes", legacy.extensionlessFileId),
			]);
			return { markdownFile, folder, extensionlessFile };
		});

		expect(result.markdownFile).toMatchObject({ lowercaseExtension: "md" });
		expect(result.folder).toMatchObject({ lowercaseExtension: null });
		expect(result.extensionlessFile).toMatchObject({ lowercaseExtension: null });
	});
});
