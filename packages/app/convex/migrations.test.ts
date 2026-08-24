import { describe, expect, test } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

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
	files_text_chunks: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		fileNodeId: v.id("files_nodes"),
		sourceKind: v.union(v.literal("committed"), v.literal("pending")),
		userId: v.optional(v.string()),
		pendingUpdateId: v.optional(v.string()),
		yjsSequence: v.optional(v.number()),
		chunkIndex: v.number(),
		textChunk: v.string(),
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
		textChunkId: v.id("files_text_chunks"),
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
	plugins_versions: defineTable({
		name: v.string(),
		sourceStatus: v.union(v.literal("preparing"), v.literal("failed"), v.literal("ready")),
		isLatest: v.boolean(),
		updatedAt: v.number(),
	})
		.index("by_isLatest_name", ["isLatest", "name"])
		.index("by_name", ["name"])
		.index("by_name_sourceStatus_updatedAt", ["name", "sourceStatus", "updatedAt"]),
});

/**
 * The per-member share is the only migration subject here that a member can reach from the app, so
 * these two tests run against the real schema instead of the legacy one above. `test_convex` gives
 * the app's own functions; the migrations component has to be registered by hand, because the app
 * never runs a migration outside these tests.
 *
 * Seeds the frame door one member writes through: an installation that declared and accepted the
 * user-write capability, plus the page session the door reads. `plugins_data.test.ts` seeds the same
 * two docs the same way, and for the same reason — the mint and JWT exchange are `plugins_ui`'s
 * subject, not this file's.
 */
async function seed_member_share_door(t: ReturnType<typeof test_convex>) {
	const capabilities = [
		"plugin.data.read",
		"plugin.data.write",
		"plugin.data.user-write",
		"plugin.service.connect",
	] as const;

	return await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-member-share-backfill" });
		const membership = await test_mocks_fill_db_with.membership(ctx, { userId });
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "chitchat",
			displayName: "Chitchat",
			version: "0.1.0",
			description: "Workspace chat",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/chitchat-plugin",
			sourceOwner: "bonobo",
			sourceRepo: "chitchat-plugin",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/chitchat/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities: [...capabilities],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginVersionId,
			pluginName: "chitchat",
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: [...capabilities],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		const sessionId = await ctx.db.insert("plugins_ui_sessions", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			pluginVersionId,
			userId: membership.userId,
			tokenHash: "page-session-member-share-backfill",
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});

		return { ...membership, pluginVersionId, installationId, sessionId } as const;
	});
}

/** One document as it was stored before the per-member share existed: no `chargedTo`, no `machineBytes`. */
async function seed_pre_share_document(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_member_share_door>>,
	args: { key: string; collection: string; byteSize: number },
) {
	return await t.run(
		async (ctx) =>
			await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: args.collection,
				key: args.key,
				value: { text: "seeded before the share existed" },
				byteSize: args.byteSize,
				revision: 1,
				writeMode: "normal",
				ownership: "owned",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: Date.now(),
			}),
	);
}

describe("backfill_plugins_data_charged_to", () => {
	test("attributes pre-share documents to their author and makes the share bind", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);

		// `MEMBER_MAX_BYTES` in plugins_data.ts is 1600 KiB. Two documents that together fill it
		// exactly, so the member is at their ceiling and the next byte is one too many.
		const documentIds = await Promise.all([
			seed_pre_share_document(t, fixture, { key: "m:1", collection: "messages", byteSize: 800 * 1024 }),
			seed_pre_share_document(t, fixture, { key: "m:2", collection: "messages", byteSize: 800 * 1024 }),
		]);

		// One document per batch, so the second one has to read the member row the first one wrote.
		// A batch-local accumulator would pass a single-batch run and lose bytes here.
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugins_data_charged_to, {
				batchSize: 1,
			});
		});

		const afterBackfill = await t.run(async (ctx) => ({
			documents: await Promise.all(documentIds.map((id) => ctx.db.get("plugins_data", id))),
			memberUsage: await ctx.db.query("plugins_data_member_usage").collect(),
		}));
		for (const document of afterBackfill.documents) {
			expect(document).toMatchObject({ chargedTo: fixture.userId, machineBytes: 0 });
		}
		expect(afterBackfill.memberUsage).toHaveLength(1);
		expect(afterBackfill.memberUsage[0]).toMatchObject({
			userId: fixture.userId,
			installationId: fixture.installationId,
			usedBytes: 1600 * 1024,
			usedDocuments: 2,
			machineBytes: 0,
			collectionNames: ["messages"],
		});

		// The point of attributing them: the member's own share now holds those bytes, so their next
		// write is refused. Before the backfill the same call succeeds, because a share of zero is
		// what an unattributed store looks like from the ceiling's side.
		const asPage = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: fixture.sessionId,
		});
		const appended = await asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "one more" },
			clientRequestId: "after-backfill",
		});
		expect(appended._nay?.name).toBe("storage_full");
		expect(appended._nay?.message).toBe("You have used your 1.6 MiB share of this plugin's storage");

		// Running it again must change nothing. `cursor: null` restarts from the first document, which
		// is what a resumed run does to the rows it already passed.
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugins_data_charged_to, {
				cursor: null,
				batchSize: 1,
			});
		});

		const afterSecondRun = await t.run(async (ctx) => await ctx.db.query("plugins_data_member_usage").collect());
		expect(afterSecondRun).toEqual(afterBackfill.memberUsage);
	});
});

describe("remove_plugins_data_charged_to_and_machine_bytes", () => {
	test("leaves no attribution field and no member row behind", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const documentId = await seed_pre_share_document(t, fixture, {
			key: "m:1",
			collection: "messages",
			byteSize: 128,
		});

		// Start from the state phase 1 leaves: an attributed document and the member row that holds
		// its counters. The backfill is the shortest way to produce exactly that state.
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.backfill_plugins_data_charged_to);
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.remove_plugins_data_charged_to_and_machine_bytes,
			);
			await runToCompletion(ctx, components.migrations, internal.migrations.delete_plugins_data_member_usage);
		});

		const stripped = await t.run(async (ctx) => ({
			document: await ctx.db.get("plugins_data", documentId),
			memberUsage: await ctx.db.query("plugins_data_member_usage").collect(),
		}));
		// The schema push that follows this rollback drops both fields, and full-table validation
		// refuses it while any row still carries either one.
		expect(stripped.document?.chargedTo).toBeUndefined();
		expect(stripped.document?.machineBytes).toBeUndefined();
		expect(stripped.memberUsage).toEqual([]);
		// The document itself survives. This rollback gives up the per-member accounting, not the data.
		expect(stripped.document).toMatchObject({ key: "m:1", byteSize: 128 });
	});
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
			const textChunkId = await ctx.db.insert("files_text_chunks", {
				organizationId: "organization-files-node-id-rename",
				workspaceId: "workspace-files-node-id-rename",
				fileNodeId: fileId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				textChunk: "hello",
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
				textChunkId,
			});

			return { fileId, plainTextChunkId };
		});

		const plainTextChunk = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.rename_plain_text_chunks_file_node_id);

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

describe("backfill_plugins_versions_is_latest", () => {
	test("keeps one marker after a committed bounded batch", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const versions = await t.run(async (ctx) => {
			// Put the winner in the first batch and both stale markers after its cursor.
			const newestReadyId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: false,
				updatedAt: 300,
			});
			const firstStaleId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 200,
			});
			const secondStaleId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 100,
			});
			return { firstStaleId, newestReadyId, secondStaleId };
		});

		const batch = await t.mutation(internal.migrations.backfill_plugins_versions_is_latest, {
			cursor: null,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		const result = await t.run(async (ctx) => ({
			firstStale: await ctx.db.get("plugins_versions", versions.firstStaleId),
			newestReady: await ctx.db.get("plugins_versions", versions.newestReadyId),
			secondStale: await ctx.db.get("plugins_versions", versions.secondStaleId),
		}));

		expect(batch).toMatchObject({ processed: 1, isDone: false });
		expect(
			[result.firstStale, result.newestReady, result.secondStale]
				.filter((version) => version?.isLatest)
				.map((version) => version?._id),
		).toEqual([versions.newestReadyId]);
		expect(result.newestReady?.isLatest).toBe(true);
		expect(result.firstStale?.isLatest).toBe(false);
		expect(result.secondStale?.isLatest).toBe(false);
	});
});

describe("repair_plugins_versions_is_latest", () => {
	test("uses a bounded default batch", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		await t.run(async (ctx) => {
			await Promise.all(
				Array.from({ length: 21 }, (_, index) =>
					ctx.db.insert("plugins_versions", {
						name: `plugin-${index}`,
						sourceStatus: "ready",
						isLatest: false,
						updatedAt: index,
					}),
				),
			);
		});

		const batch = await t.mutation(internal.migrations.repair_plugins_versions_is_latest, {
			cursor: null,
			dryRun: false,
			oneBatchOnly: true,
		});

		expect(batch).toMatchObject({ processed: 20, isDone: false });
	});

	test("keeps one marker after a committed bounded batch", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const versions = await t.run(async (ctx) => {
			// Put the winner in the first batch and both stale markers after its cursor.
			const newestReadyId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: false,
				updatedAt: 300,
			});
			const firstStaleId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 200,
			});
			const secondStaleId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 100,
			});
			return { firstStaleId, newestReadyId, secondStaleId };
		});

		const batch = await t.mutation(internal.migrations.repair_plugins_versions_is_latest, {
			cursor: null,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		const result = await t.run(async (ctx) => ({
			firstStale: await ctx.db.get("plugins_versions", versions.firstStaleId),
			newestReady: await ctx.db.get("plugins_versions", versions.newestReadyId),
			secondStale: await ctx.db.get("plugins_versions", versions.secondStaleId),
		}));

		expect(batch).toMatchObject({ processed: 1, isDone: false });
		expect(
			[result.firstStale, result.newestReady, result.secondStale]
				.filter((version) => version?.isLatest)
				.map((version) => version?._id),
		).toEqual([versions.newestReadyId]);
		expect(result.newestReady?.isLatest).toBe(true);
		expect(result.firstStale?.isLatest).toBe(false);
		expect(result.secondStale?.isLatest).toBe(false);
	});

	test("moves the marker to the ready version that became ready last", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const versions = await t.run(async (ctx) => {
			// The stale marker sits on the older ready row, so the migration has to move it.
			const staleId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 100,
			});
			const newestReadyId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: false,
				updatedAt: 300,
			});
			// A failed row can carry the newest time of all. It must never win.
			const failedLaterId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "failed",
				isLatest: false,
				updatedAt: 500,
			});
			// A second plugin proves the migration answers per name instead of picking one global winner.
			const otherPluginId = await ctx.db.insert("plugins_versions", {
				name: "gallery",
				sourceStatus: "ready",
				isLatest: false,
				updatedAt: 700,
			});
			return { failedLaterId, newestReadyId, otherPluginId, staleId };
		});

		const result = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.repair_plugins_versions_is_latest);
			return {
				failedLater: await ctx.db.get("plugins_versions", versions.failedLaterId),
				newestReady: await ctx.db.get("plugins_versions", versions.newestReadyId),
				otherPlugin: await ctx.db.get("plugins_versions", versions.otherPluginId),
				stale: await ctx.db.get("plugins_versions", versions.staleId),
			};
		});

		expect(result.stale?.isLatest).toBe(false);
		expect(result.newestReady?.isLatest).toBe(true);
		expect(result.failedLater?.isLatest).toBe(false);
		expect(result.otherPlugin?.isLatest).toBe(true);
	});

	test("keeps an existing latest marker inside the newest ready tie", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const versions = await t.run(async (ctx) => {
			// Old rows can share a millisecond. Two of them even carry the marker, so the migration has
			// to pick one and clear the other instead of leaving the plugin with two latest versions.
			const markedFirstId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 300,
			});
			const markedSecondId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: true,
				updatedAt: 300,
			});
			const unmarkedId = await ctx.db.insert("plugins_versions", {
				name: "media",
				sourceStatus: "ready",
				isLatest: false,
				updatedAt: 300,
			});
			return { markedFirstId, markedSecondId, unmarkedId };
		});

		const result = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.repair_plugins_versions_is_latest);
			return {
				markedFirst: await ctx.db.get("plugins_versions", versions.markedFirstId),
				markedSecond: await ctx.db.get("plugins_versions", versions.markedSecondId),
				unmarked: await ctx.db.get("plugins_versions", versions.unmarkedId),
			};
		});

		expect(result.markedFirst?.isLatest).toBe(true);
		expect(result.markedSecond?.isLatest).toBe(false);
		expect(result.unmarked?.isLatest).toBe(false);
	});

	test("leaves a plugin with no ready version without a latest marker", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const versions = await t.run(async (ctx) => {
			// A plugin can hold a stale marker on a row that never became ready. Nothing is publishable,
			// so the migration has to clear the marker rather than hand it to the next best row.
			const failedId = await ctx.db.insert("plugins_versions", {
				name: "broken",
				sourceStatus: "failed",
				isLatest: true,
				updatedAt: 900,
			});
			const preparingId = await ctx.db.insert("plugins_versions", {
				name: "broken",
				sourceStatus: "preparing",
				isLatest: false,
				updatedAt: 800,
			});
			return { failedId, preparingId };
		});

		const result = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.repair_plugins_versions_is_latest);
			return {
				failed: await ctx.db.get("plugins_versions", versions.failedId),
				preparing: await ctx.db.get("plugins_versions", versions.preparingId),
			};
		});

		expect(result.failed?.isLatest).toBe(false);
		expect(result.preparing?.isLatest).toBe(false);
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
			const textChunkId = await ctx.db.insert("files_text_chunks", {
				organizationId: "organization-files-backfill",
				workspaceId: "workspace-files-backfill",
				fileNodeId: fileId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				textChunk: "hello",
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
				textChunkId,
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
