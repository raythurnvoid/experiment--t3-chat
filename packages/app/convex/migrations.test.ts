import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { plugins_PRIVATE_FOLDER_ROLLOVER_INDEX } from "./plugins_projections.ts";
import { files_nodes_db_cascade_read_only_scope } from "./files_nodes.ts";

const migrations_test_modules = import.meta.glob("./**/*.ts");

type MigrationAuditPage = { candidateCount: number; continueCursor: string; isDone: boolean };

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
		expect(afterBackfill.memberUsage).toHaveLength(1);
		expect(afterBackfill.memberUsage[0]).toMatchObject({
			userId: fixture.userId,
			installationId: fixture.installationId,
			generation: "document_bound",
			usedBytes: 1600 * 1024,
			usedDocuments: 2,
			machineBytes: 0,
			collectionNames: ["messages"],
		});
		for (const document of afterBackfill.documents) {
			expect(document).toMatchObject({
				chargedTo: fixture.userId,
				chargedToMemberUsageId: afterBackfill.memberUsage[0]!._id,
				machineBytes: 0,
			});
		}

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
		expect(stripped.document?.chargedToMemberUsageId).toBeUndefined();
		expect(stripped.document?.machineBytes).toBeUndefined();
		expect(stripped.memberUsage).toEqual([]);
		// The document itself survives. This rollback gives up the per-member accounting, not the data.
		expect(stripped.document).toMatchObject({ key: "m:1", byteSize: 128 });
	});
});

describe("delete_legacy_plugins_data_member_usage", () => {
	test("removes old counters and keeps document-bound generations", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const keptId = await t.run(async (ctx) => {
			await ctx.db.insert("plugins_data_member_usage", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				userId: fixture.userId,
				usedBytes: 100,
				usedDocuments: 1,
				machineBytes: 0,
				collectionNames: ["legacy"],
			});
			const currentUserId = await ctx.db.insert("users", { clerkUserId: null });
			return await ctx.db.insert("plugins_data_member_usage", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				userId: currentUserId,
				generation: "document_bound",
				usedBytes: 20,
				usedDocuments: 1,
				machineBytes: 0,
				collectionNames: ["current"],
			});
		});
		expect(
			await t.query(internal.migrations.audit_legacy_plugins_data_member_usage_page, { cursor: null }),
		).toMatchObject({ candidateCount: 1, isDone: true });

		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.delete_legacy_plugins_data_member_usage);
		});
		const remaining = await t.run(async (ctx) => await ctx.db.query("plugins_data_member_usage").collect());
		expect(remaining.map((usage) => usage._id)).toEqual([keptId]);
		expect(remaining[0]).toMatchObject({ generation: "document_bound", usedBytes: 20 });
		expect(
			await t.query(internal.migrations.audit_legacy_plugins_data_member_usage_page, { cursor: null }),
		).toMatchObject({ candidateCount: 0, isDone: true });
	});
});

describe("backfill_plugin_scope_append_activity", () => {
	test("preserves live append history, defaults empty rows, and leaves both audits clean", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const seeded = await t.run(async (ctx) => {
			const membershipRevision = 123;
			const secondUserId = await ctx.db.insert("users", { clerkUserId: null });
			const keyAt = (prefix: string, at: number, suffix: string) =>
				`${prefix}${String(9_999_999_999_999 - at).padStart(13, "0")}:${suffix}`;
			const insertScope = async (
				scopeId: string,
				collection: string,
				lastAppend?: {
					at: number;
					key: string;
					createdByUserId: typeof fixture.userId;
				} | null,
				appendSequence?: number,
			) =>
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					scopeId,
					collection,
					keyPrefix: `${scopeId}/`,
					createdByUserId: fixture.userId,
					createdAt: membershipRevision,
					...(lastAppend === undefined ? {} : { lastAppend }),
					...(appendSequence === undefined ? {} : { appendSequence }),
					updatedAt: membershipRevision,
				});
			const insertDocument = async (args: {
				scopeId?: string;
				collection: string;
				key: string;
				createdBy?: typeof fixture.userId;
				requestId?: string;
			}) =>
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: args.collection,
					key: args.key,
					value: { text: args.key },
					byteSize: 32,
					revision: 1,
					writeMode: "normal",
					ownership: "owned",
					createdBy: args.createdBy ?? fixture.userId,
					updatedBy: args.createdBy ?? fixture.userId,
					updatedAt: membershipRevision,
					...(args.scopeId === undefined ? {} : { scopeId: args.scopeId }),
					...(args.requestId === undefined
						? {}
						: {
								userWriteRequestId: args.requestId,
								userWriteRequestFingerprint: "a".repeat(64),
							}),
				});

			await insertScope("live", "messages");
			await insertScope("live", "replies");
			await insertScope("live", "channels", undefined, 1.5);
			const preservedMarker = {
				at: 300,
				key: keyAt("live/", 300, "0001"),
				createdByUserId: fixture.userId,
			};
			await insertScope("live", "reactions", preservedMarker, 4);
			const markerOnly = {
				at: 250,
				key: keyAt("marker-only/", 250, "0001"),
				createdByUserId: fixture.userId,
			};
			await insertScope("marker-only", "messages", markerOnly, 0);

			const olderMessageKey = keyAt("live/", 100, "0001");
			const tiedMessageKey = keyAt("live/", 200, "0001");
			const winningTiedMessageKey = keyAt("live/", 200, "000f");
			const replyKey = keyAt("live/", 150, "0002");
			await insertDocument({
				scopeId: "live",
				collection: "messages",
				key: olderMessageKey,
				requestId: "message-old",
			});
			await insertDocument({
				scopeId: "live",
				collection: "messages",
				key: tiedMessageKey,
				requestId: "message-tie-a",
			});
			await insertDocument({
				scopeId: "live",
				collection: "messages",
				key: winningTiedMessageKey,
				createdBy: secondUserId,
				requestId: "message-tie-b",
			});
			await insertDocument({
				scopeId: "live",
				collection: "replies",
				key: replyKey,
				requestId: "reply",
			});

			// These rows look close to append history but are public, non-append, malformed, or released.
			await insertDocument({ collection: "messages", key: keyAt("public/", 400, "0001"), requestId: "public" });
			await insertDocument({ scopeId: "live", collection: "channels", key: keyAt("live/", 450, "0001") });
			await insertDocument({
				scopeId: "live",
				collection: "channels",
				key: "live/not-an-append",
				requestId: "malformed",
			});
			await insertDocument({
				scopeId: "released",
				collection: "messages",
				key: keyAt("released/", 500, "0001"),
				requestId: "released",
			});
			for (let index = 0; index < 21; index += 1) {
				await insertDocument({ collection: "noise", key: `public-${index}` });
			}

			return {
				membershipRevision,
				markerOnly,
				preservedMarker,
				replyKey,
				secondUserId,
				winningTiedMessageKey,
			};
		});

		const readAudit = async (name: "append" | "defaults") => {
			let cursor: string | null = null;
			let candidateCount = 0;
			let pages = 0;
			do {
				const page: MigrationAuditPage = await t.query(
					name === "append"
						? internal.migrations.audit_plugin_scope_append_activity_page
						: internal.migrations.audit_plugin_scope_last_append_defaults_page,
					{ cursor },
				);
				candidateCount += page.candidateCount;
				pages += 1;
				cursor = page.isDone ? null : page.continueCursor;
				if (page.isDone) {
					break;
				}
			} while (cursor !== null);
			return { candidateCount, pages };
		};

		expect(await readAudit("append")).toMatchObject({ candidateCount: 4, pages: expect.any(Number) });
		expect((await readAudit("append")).pages).toBeGreaterThan(1);
		expect(await readAudit("defaults")).toEqual({ candidateCount: 4, pages: 1 });

		await t.run(async (ctx) => {
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.backfill_plugin_scope_last_append_from_documents,
				{ batchSize: 1 },
			);
		});
		expect((await readAudit("append")).candidateCount).toBe(0);

		// Simulate a runtime append between the two passes. The default pass must not lower it.
		await t.run(async (ctx) => {
			const scopes = await ctx.db
				.query("plugins_data_scopes")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", fixture.installationId).eq("scopeId", "live"),
				)
				.collect();
			const replies = scopes.find((scope) => scope.collection === "replies");
			await ctx.db.patch("plugins_data_scopes", replies!._id, { appendSequence: 2 });
		});

		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.default_plugin_scope_last_append, {
				batchSize: 1,
			});
		});
		expect((await readAudit("defaults")).candidateCount).toBe(0);

		const first = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) =>
						q.eq("installationId", fixture.installationId).eq("scopeId", "live"),
					)
					.collect()
			)
				.map((scope) => ({
					collection: scope.collection,
					lastAppend: scope.lastAppend,
					appendSequence: scope.appendSequence,
					updatedAt: scope.updatedAt,
				}))
				.sort((left, right) => left.collection.localeCompare(right.collection)),
		);
		expect(first).toEqual([
			{ collection: "channels", lastAppend: null, appendSequence: 0, updatedAt: seeded.membershipRevision },
			{
				collection: "messages",
				lastAppend: {
					at: 200,
					key: seeded.winningTiedMessageKey,
					createdByUserId: seeded.secondUserId,
				},
				appendSequence: 1,
				updatedAt: seeded.membershipRevision,
			},
			{
				collection: "reactions",
				lastAppend: seeded.preservedMarker,
				appendSequence: 4,
				updatedAt: seeded.membershipRevision,
			},
			{
				collection: "replies",
				lastAppend: { at: 150, key: seeded.replyKey, createdByUserId: fixture.userId },
				appendSequence: 2,
				updatedAt: seeded.membershipRevision,
			},
		]);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) =>
						q.eq("installationId", fixture.installationId).eq("scopeId", "released"),
					)
					.collect(),
			),
		).toEqual([]);
		expect(
			await t.run(async (ctx) => {
				const [scope] = await ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) =>
						q.eq("installationId", fixture.installationId).eq("scopeId", "marker-only"),
					)
					.collect();
				return {
					lastAppend: scope?.lastAppend,
					appendSequence: scope?.appendSequence,
					updatedAt: scope?.updatedAt,
				};
			}),
		).toEqual({
			lastAppend: seeded.markerOnly,
			appendSequence: 1,
			updatedAt: seeded.membershipRevision,
		});

		// Both passes are resumable. A second full run changes no activity or membership revision.
		await t.run(async (ctx) => {
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.backfill_plugin_scope_last_append_from_documents,
			);
			await runToCompletion(ctx, components.migrations, internal.migrations.default_plugin_scope_last_append);
		});
		const second = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("plugins_data_scopes")
					.withIndex("by_installation_scope", (q) =>
						q.eq("installationId", fixture.installationId).eq("scopeId", "live"),
					)
					.collect()
			)
				.map((scope) => ({
					collection: scope.collection,
					lastAppend: scope.lastAppend,
					appendSequence: scope.appendSequence,
					updatedAt: scope.updatedAt,
				}))
				.sort((left, right) => left.collection.localeCompare(right.collection)),
		);
		expect(second).toEqual(first);
	});
});

describe("backfill_plugin_scope_identity_markers", () => {
	test("recovers a baseline-deleted Chitchat scope before identity backfill and stays repeatable", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const scopeId = "p/11111111-1111-4111-8111-111111111111";
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [collection, key] of [
				["channels", scopeId],
				["messages", `${scopeId}:1:message`],
				["replies", `${scopeId}:1:message:reply`],
				["reactions", `${scopeId}:1:message:user:emoji`],
			] as const) {
				await ctx.db.insert("plugins_data", {
					scopeId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection,
					key,
					value: { text: "private history" },
					byteSize: 26,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		const runRecovery = async () => {
			await t.run(async (ctx) => {
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.recover_or_audit_orphan_plugin_scope_ranges,
					{ batchSize: 1 },
				);
			});
		};
		const readRanges = async () =>
			await t.run(async (ctx) =>
				(
					await ctx.db
						.query("plugins_data_released_scope_ranges")
						.withIndex("by_installation_scope", (q) =>
							q.eq("installationId", fixture.installationId).eq("scopeId", scopeId),
						)
						.collect()
				)
					.map((row) => ({ id: row._id, collectionName: row.collectionName, keyPrefix: row.keyPrefix }))
					.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
			);

		await runRecovery();
		const first = await readRanges();
		expect(
			first
				.map(({ collectionName, keyPrefix }) => ({ collectionName, keyPrefix }))
				.sort((left, right) =>
					left.collectionName < right.collectionName ? -1 : left.collectionName > right.collectionName ? 1 : 0,
				),
		).toEqual([
				{ collectionName: "", keyPrefix: "" },
				{ collectionName: "channels", keyPrefix: scopeId },
				{ collectionName: "messages", keyPrefix: scopeId },
				{ collectionName: "reactions", keyPrefix: scopeId },
				{ collectionName: "replies", keyPrefix: scopeId },
			]);

		await runRecovery();
		expect(await readRanges()).toEqual(first);

		const asPage = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: fixture.sessionId,
		});
		const staleWrite = await asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: `${scopeId}:late-message`,
			value: { text: "must stay private" },
		});
		expect(staleWrite._nay?.message).toBe("Permission denied");
	});

	test("blocks an orphan scoped document from an unknown plugin instead of guessing its prefix", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { pluginName: "unknown-plugin" });
			await ctx.db.insert("plugins_data", {
				scopeId: "private-id",
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "unknown-plugin",
				collection: "private-documents",
				key: "unknown-prefix/document",
				value: { text: "unknown" },
				byteSize: 18,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.run(async (ctx) => {
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.recover_or_audit_orphan_plugin_scope_ranges,
				);
			}),
		).rejects.toThrow(
			"Plugin scope recovery blocked: choose how to migrate or erase an orphan scoped document outside Chitchat",
		);
		expect(await t.run(async (ctx) => ctx.db.query("plugins_data_released_scope_ranges").collect())).toEqual([]);
	});

	test("blocks a Chitchat lookalike key even after a valid row recovered the scope", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const scopeId = "p/22222222-2222-4222-8222-222222222222";
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const key of [`${scopeId}:message`, `${scopeId}-other:message`]) {
				await ctx.db.insert("plugins_data", {
					scopeId,
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key,
					value: { seenAt: 1 },
					byteSize: 12,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		await expect(
			t.run(async (ctx) => {
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.recover_or_audit_orphan_plugin_scope_ranges,
				);
			}),
		).rejects.toThrow("Plugin scope recovery blocked: choose how to migrate or erase a malformed Chitchat orphan");
		expect(await t.run(async (ctx) => ctx.db.query("plugins_data_released_scope_ranges").collect())).toEqual([]);
	});

	test("blocks a Chitchat orphan whose scope id is only the private prefix", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("plugins_data", {
				scopeId: "p/",
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "channels",
				key: "p/",
				value: { name: "invalid private channel" },
				byteSize: 34,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.run(async (ctx) => {
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.recover_or_audit_orphan_plugin_scope_ranges,
				);
			}),
		).rejects.toThrow("Plugin scope recovery blocked: choose how to migrate or erase a malformed Chitchat orphan");
		expect(await t.run(async (ctx) => ctx.db.query("plugins_data_released_scope_ranges").collect())).toEqual([]);
	});

	test("adds one marker per installation and scope id, stays repeatable, and makes the lifetime cap exact", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const siblingInstallationId = await t.run(async (ctx) => {
			const now = Date.now();
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "chitchat",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});

			for (let index = 0; index < 997; index += 1) {
				await ctx.db.insert("plugins_data_released_scope_ranges", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					scopeId: `historic-${index}`,
					collectionName: "",
					keyPrefix: "",
				});
			}

			for (const collection of ["messages", "reactions"]) {
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					scopeId: "live-only",
					collection,
					keyPrefix: "live/",
					createdByUserId: fixture.userId,
					createdAt: now,
					updatedAt: now,
				});
				await ctx.db.insert("plugins_data_released_scope_ranges", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					scopeId: "released-only",
					collectionName: collection,
					keyPrefix: "released/",
				});
			}
			await ctx.db.insert("plugins_data_scopes", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				scopeId: "both",
				collection: "messages",
				keyPrefix: "both/",
				createdByUserId: fixture.userId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_released_scope_ranges", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				scopeId: "both",
				collectionName: "messages",
				keyPrefix: "both/",
			});
			await ctx.db.insert("plugins_data_released_scope_ranges", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId,
				scopeId: "live-only",
				collectionName: "messages",
				keyPrefix: "sibling/",
			});
			return installationId;
		});

		const runBackfill = async () => {
			await t.run(async (ctx) => {
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.backfill_plugin_scope_identities_from_live_scopes,
					{ batchSize: 1 },
				);
				await runToCompletion(
					ctx,
					components.migrations,
					internal.migrations.backfill_plugin_scope_identities_from_released_ranges,
					{ batchSize: 1 },
				);
			});
		};
		const readMarkers = async () =>
			await t.run(async (ctx) =>
				(await ctx.db.query("plugins_data_released_scope_ranges").collect())
					.filter((row) => row.collectionName === "" && row.keyPrefix === "")
					.map((row) => ({ id: row._id, installationId: row.installationId, scopeId: row.scopeId }))
					.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
			);

		await runBackfill();
		const firstMarkers = await readMarkers();
		expect(firstMarkers.filter((row) => row.installationId === fixture.installationId)).toHaveLength(1_000);
		for (const scopeId of ["live-only", "released-only", "both"]) {
			expect(
				firstMarkers.filter(
					(row) => row.installationId === fixture.installationId && row.scopeId === scopeId,
				),
			).toHaveLength(1);
		}
		expect(
			firstMarkers.filter(
				(row) => row.installationId === siblingInstallationId && row.scopeId === "live-only",
			),
		).toHaveLength(1);

		await runBackfill();
		expect(await readMarkers()).toEqual(firstMarkers);

		const asPage = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: fixture.sessionId,
		});
		const refused = await asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "cap-probe", collections: ["messages"], keyPrefix: "cap/" },
		});
		expect(refused).toEqual({
			_nay: {
				name: "storage_full",
				message:
					"This plugin has already created 1000 private spaces, which is its lifetime limit. Reinstall it to start over.",
			},
		});
		expect((await readMarkers()).filter((row) => row.installationId === fixture.installationId)).toHaveLength(1_000);
	});
});

describe("plugin scope cleanup migrations", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("audits every page and deletes only exact orphan and stranded rows", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const otherWorkspaceId = await ctx.db.insert("organizations_workspaces", {
				organizationId: fixture.organizationId,
				name: "other",
				description: "",
				default: false,
				updatedAt: now,
			});
			const siblingInstallationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "chitchat",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			const deadInstallationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "chitchat",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});

			const insertScope = async (args: {
				installationId: typeof fixture.installationId;
				scopeId: string;
				collection: string;
			}) =>
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: args.installationId,
					scopeId: args.scopeId,
					collection: args.collection,
					keyPrefix: `${args.scopeId}/`,
					createdByUserId: fixture.userId,
					createdAt: now,
					updatedAt: now,
				});
			const insertGrant = async (args: {
				workspaceId?: typeof fixture.workspaceId;
				resourceKind?: "file" | "plugin_scope";
				resourceId: string;
				permission?: "content.read" | "content.permissions.manage";
			}) =>
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: fixture.organizationId,
					workspaceId: args.workspaceId ?? fixture.workspaceId,
					resourceKind: args.resourceKind ?? "plugin_scope",
					resourceId: args.resourceId,
					principalKind: "user",
					userId: fixture.userId,
					permission: args.permission ?? "content.permissions.manage",
					createdAt: now,
					updatedAt: now,
				});

			await insertScope({ installationId: fixture.installationId, scopeId: "live", collection: "messages" });
			for (let index = 0; index < 3; index += 1) {
				await insertGrant({ resourceId: `${fixture.installationId}:live` });
			}
			await insertScope({ installationId: fixture.installationId, scopeId: "zero", collection: "messages" });
			await insertScope({ installationId: fixture.installationId, scopeId: "zero", collection: "reactions" });
			await insertScope({ installationId: deadInstallationId, scopeId: "dead", collection: "messages" });
			await insertGrant({ resourceId: `${deadInstallationId}:dead` });

			// These exact-looking grants miss one join field each and must not keep the live zero-grant scope.
			await insertGrant({ workspaceId: otherWorkspaceId, resourceId: `${fixture.installationId}:zero` });
			await insertGrant({ resourceId: `${siblingInstallationId}:zero` });
			await insertGrant({ resourceId: "not-an-installation:scope" });

			const folderNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				name: "private",
				path: "/private",
				treePath: "/private/",
				updatedAt: now,
			});
			const fileGrantId = await insertGrant({ resourceKind: "file", resourceId: String(folderNodeId) });

			// Force both audit queries over more than one fixed-size page with harmless live rows.
			for (let index = 0; index < 21; index += 1) {
				const scopeId = `kept-${index}`;
				await insertScope({ installationId: fixture.installationId, scopeId, collection: "messages" });
				await insertGrant({ resourceId: `${fixture.installationId}:${scopeId}` });
			}
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "zero",
				queuedAt: 1,
				updatedAt: 1,
			});
			await ctx.db.delete("plugins_workspace_installations", deadInstallationId);

			return { deadInstallationId, fileGrantId, siblingInstallationId, membershipRevision: now };
		});

		let grantCursor: string | null = null;
		let orphanGrantCount = 0;
		let grantPages = 0;
		do {
			const page: MigrationAuditPage = await t.query(internal.migrations.audit_orphan_plugin_scope_grants_page, {
				cursor: grantCursor,
			});
			orphanGrantCount += page.candidateCount;
			grantPages += 1;
			grantCursor = page.isDone ? null : page.continueCursor;
			if (page.isDone) {
				break;
			}
		} while (grantCursor !== null);

		let scopeCursor: string | null = null;
		let strandedScopeCount = 0;
		let scopePages = 0;
		do {
			const page: MigrationAuditPage = await t.query(internal.migrations.audit_stranded_plugin_data_scopes_page, {
				cursor: scopeCursor,
			});
			strandedScopeCount += page.candidateCount;
			scopePages += 1;
			scopeCursor = page.isDone ? null : page.continueCursor;
			if (page.isDone) {
				break;
			}
		} while (scopeCursor !== null);

		expect(grantPages).toBeGreaterThan(1);
		expect(scopePages).toBeGreaterThan(1);
		expect(orphanGrantCount).toBe(1);
		expect(strandedScopeCount).toBe(3);

		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.delete_orphan_plugin_scope_grants);
		});
		let finalGrantCursor: string | null = null;
		let finalOrphanGrantCount = 0;
		do {
			const page: MigrationAuditPage = await t.query(internal.migrations.audit_orphan_plugin_scope_grants_page, {
				cursor: finalGrantCursor,
			});
			finalOrphanGrantCount += page.candidateCount;
			finalGrantCursor = page.isDone ? null : page.continueCursor;
			if (page.isDone) {
				break;
			}
		} while (finalGrantCursor !== null);
		expect(finalOrphanGrantCount).toBe(0);

		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.delete_stranded_plugin_data_scopes);
		});

		const after = await t.run(async (ctx) => ({
			deadGrants: (await ctx.db.query("access_control_permission_grants").collect()).filter(
				(grant) => grant.resourceId === `${seeded.deadInstallationId}:dead`,
			),
			deadScopes: (await ctx.db.query("plugins_data_scopes").collect()).filter(
				(scope) => scope.installationId === seeded.deadInstallationId,
			),
			fileGrant: await ctx.db.get("access_control_permission_grants", seeded.fileGrantId),
			liveGrants: (await ctx.db.query("access_control_permission_grants").collect()).filter(
				(grant) => grant.resourceId === `${fixture.installationId}:live`,
			),
			liveScopes: (await ctx.db.query("plugins_data_scopes").collect()).filter(
				(scope) => scope.installationId === fixture.installationId && scope.scopeId === "live",
			),
			zeroScopes: (await ctx.db.query("plugins_data_scopes").collect()).filter(
				(scope) => scope.installationId === fixture.installationId && scope.scopeId === "zero",
			),
			zeroFences: (await ctx.db.query("plugins_data_released_scope_ranges").collect()).filter(
				(fence) => fence.installationId === fixture.installationId && fence.scopeId === "zero",
			),
			deadFences: (await ctx.db.query("plugins_data_released_scope_ranges").collect()).filter(
				(fence) => fence.installationId === seeded.deadInstallationId,
			),
			dirty: await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "zero"),
				)
				.first(),
			siblingGrant: (await ctx.db.query("access_control_permission_grants").collect()).find(
				(grant) => grant.resourceId === `${seeded.siblingInstallationId}:zero`,
			),
		}));
		expect(after.deadGrants).toEqual([]);
		expect(after.deadScopes).toEqual([]);
		expect(after.fileGrant).not.toBeNull();
		expect(after.liveGrants).toHaveLength(3);
		expect(after.liveScopes).toHaveLength(1);
		expect(after.liveScopes[0]?.updatedAt).toBe(seeded.membershipRevision);
		expect(after.zeroScopes).toEqual([]);
		expect(after.zeroFences.map((fence) => fence.collectionName).sort()).toEqual(["", "messages", "reactions"]);
		expect(after.deadFences).toEqual([]);
		expect(after.dirty?.updatedAt).toBeGreaterThan(1);
		expect(after.siblingGrant).toBeDefined();

		let finalScopeCursor: string | null = null;
		let finalStrandedCount = 0;
		do {
			const page: MigrationAuditPage = await t.query(internal.migrations.audit_stranded_plugin_data_scopes_page, {
				cursor: finalScopeCursor,
			});
			finalStrandedCount += page.candidateCount;
			finalScopeCursor = page.isDone ? null : page.continueCursor;
			if (page.isDone) {
				break;
			}
		} while (finalScopeCursor !== null);
		expect(finalStrandedCount).toBe(0);
	});

	test("promotes the lowest active member when only an inactive pending manager remains", async () => {
		const t = test_convex();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const firstUserId = await ctx.db.insert("users", { clerkUserId: null });
			const secondUserId = await ctx.db.insert("users", { clerkUserId: null });
			const [inactiveManagerId, activeMemberId] = [firstUserId, secondUserId].sort((left, right) =>
				left < right ? -1 : left > right ? 1 : 0,
			);
			await Promise.all([
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: inactiveManagerId!,
					active: false,
					pendingOrganizationRemoval: true,
					updatedAt: now,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: activeMemberId!,
					active: true,
					updatedAt: now,
				}),
			]);
			await ctx.db.insert("plugins_data_scopes", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				scopeId: "needs-manager",
				collection: "messages",
				keyPrefix: "needs-manager/",
				createdByUserId: inactiveManagerId!,
				createdAt: now,
				updatedAt: now,
			});
			const resourceId = `${fixture.installationId}:needs-manager`;
			for (const [userId, permission] of [
				[inactiveManagerId!, "content.permissions.manage"],
				[activeMemberId!, "content.read"],
			] as const) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					resourceKind: "plugin_scope",
					resourceId,
					principalKind: "user",
					userId,
					permission,
					createdAt: now,
					updatedAt: now,
				});
			}
			return { activeMemberId: activeMemberId!, resourceId, membershipRevision: now };
		});

		const before = await t.query(internal.migrations.audit_stranded_plugin_data_scopes_page, { cursor: null });
		expect(before.candidateCount).toBe(1);
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.delete_stranded_plugin_data_scopes);
		});
		const after = await t.run(async (ctx) => ({
			scope: await ctx.db
				.query("plugins_data_scopes")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", fixture.installationId).eq("scopeId", "needs-manager"),
				)
				.first(),
			manager: await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("resourceKind", "plugin_scope")
						.eq("resourceId", seeded.resourceId)
						.eq("principalKind", "user")
						.eq("userId", seeded.activeMemberId)
						.eq("permission", "content.permissions.manage"),
				)
				.first(),
		}));
		expect(after.scope).not.toBeNull();
		expect(after.scope?.updatedAt).toBe(seeded.membershipRevision + 1);
		expect(after.manager).not.toBeNull();
		const auditAfter = await t.query(internal.migrations.audit_stranded_plugin_data_scopes_page, { cursor: null });
		expect(auditAfter.candidateCount).toBe(0);
	});

	test("releases every collection row before a later migration page can see a new grant", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 16; index += 1) {
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					scopeId: "page-boundary",
					collection: `collection-${String(index).padStart(2, "0")}`,
					keyPrefix: "page-boundary/",
					createdByUserId: fixture.userId,
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		let batch = await t.mutation(internal.migrations.delete_stranded_plugin_data_scopes, {
			cursor: null,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				resourceKind: "plugin_scope",
				resourceId: `${fixture.installationId}:page-boundary`,
				principalKind: "user",
				userId: fixture.userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
		});
		while (!batch.isDone) {
			batch = await t.mutation(internal.migrations.delete_stranded_plugin_data_scopes, {
				cursor: batch.continueCursor,
				batchSize: 1,
				dryRun: false,
				oneBatchOnly: true,
			});
		}

		const result = await t.run(async (ctx) => ({
			scopes: await ctx.db
				.query("plugins_data_scopes")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", fixture.installationId).eq("scopeId", "page-boundary"),
				)
				.collect(),
			fences: await ctx.db
				.query("plugins_data_released_scope_ranges")
				.withIndex("by_installation_scope", (q) =>
					q.eq("installationId", fixture.installationId).eq("scopeId", "page-boundary"),
				)
				.collect(),
		}));
		expect(result.scopes).toEqual([]);
		expect(result.fences).toHaveLength(17);
	});
});

describe("projection scaling cutover migrations", () => {
	beforeEach(() => {
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
			key: customKey ?? "test-upload-key",
			url: "https://r2.test/upload",
		}));
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("resets old producer pointers instead of stamping member-owned nodes", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const chitchatRootId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "folder",
				name: "chitchat",
				path: "/chitchat",
				treePath: "/chitchat/",
				updatedAt: now,
			});
			const chitchatFileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "file",
				name: "general.md",
				path: "/chitchat/general.md",
				treePath: "/chitchat/general.md",
				lowercaseExtension: "md",
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				writerUserId: fixture.userId,
				rootFolderNodeId: chitchatRootId,
				cursors: {},
				syncGeneration: 1,
				dirty: false,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "general",
				fileNodeId: chitchatFileId,
				rolloverIndex: 0,
				path: "/chitchat/general.md",
				updatedAt: now,
			});

			const councilInstallationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			const councilRootId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "folder",
				name: "meetings",
				path: "/meetings",
				treePath: "/meetings/",
				updatedAt: now,
			});
			const councilFileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "file",
				name: "meeting.md",
				path: "/meetings/one/meeting.md",
				treePath: "/meetings/one/meeting.md",
				lowercaseExtension: "md",
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: councilInstallationId,
				pluginName: "council",
				writerUserId: fixture.userId,
				rootFolderNodeId: councilRootId,
				cursors: {},
				syncGeneration: 1,
				dirty: false,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: councilInstallationId,
				channelKey: "one",
				fileNodeId: councilFileId,
				rolloverIndex: 0,
				path: "/meetings/one/meeting.md",
				updatedAt: now,
			});
			return {
				chitchatRootId,
				chitchatFileId,
				councilInstallationId,
				councilRootId,
				councilFileId,
			};
		});

		await t.run(async (ctx) => {
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.audit_projection_private_folder_authority,
			);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_root_authority);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_file_authority);
		});
		const result = await t.run(async (ctx) => ({
			chitchatRoot: await ctx.db.get("files_nodes", seeded.chitchatRootId),
			chitchatFile: await ctx.db.get("files_nodes", seeded.chitchatFileId),
			councilRoot: await ctx.db.get("files_nodes", seeded.councilRootId),
			councilFile: await ctx.db.get("files_nodes", seeded.councilFileId),
			chitchatState: await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first(),
			councilState: await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", seeded.councilInstallationId))
				.first(),
			councilDirty: await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", seeded.councilInstallationId).eq("channelKey", "one"),
				)
				.first(),
			maps: await ctx.db.query("plugins_data_projection_files").collect(),
		}));
		expect(result.chitchatRoot?.projectionPluginName).toBeUndefined();
		expect(result.chitchatRoot?.readOnlyScopeNodeId).toBeUndefined();
		expect(result.chitchatFile?.projectionPluginName).toBeUndefined();
		expect(result.councilRoot?.projectionPluginName).toBeUndefined();
		expect(result.councilFile?.projectionPluginName).toBeUndefined();
		expect(result.chitchatState?.rootFolderNodeId).toBeUndefined();
		expect(result.chitchatState?.dirty).toBe(true);
		expect(result.councilState?.dirty).toBe(true);
		expect(result.councilDirty?.queuedAt).toEqual(expect.any(Number));
		expect(result.maps).toEqual([]);
	});

	test("blocks an unsafe private folder before pointer changes and after an earlier proof goes stale", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const rootId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "folder",
				name: "chitchat",
				path: "/chitchat",
				treePath: "/chitchat/",
				updatedAt: now,
			});
			const regularFileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "file",
				name: "war-room.md",
				path: "/chitchat/private/war-room/war-room.md",
				treePath: "/chitchat/private/war-room/war-room.md",
				lowercaseExtension: "md",
				updatedAt: now,
			});
			const privateFolderId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "folder",
				name: "war-room",
				path: "/chitchat/private/war-room",
				treePath: "/chitchat/private/war-room/",
				updatedAt: now,
			});
			const stateId = await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				writerUserId: fixture.userId,
				rootFolderNodeId: rootId,
				cursors: {},
				syncGeneration: 1,
				dirty: false,
				updatedAt: now,
			});
			const regularMapId = await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "p/war-room",
				fileNodeId: regularFileId,
				rolloverIndex: 0,
				path: "/chitchat/private/war-room/war-room.md",
				updatedAt: now,
			});
			const privateMapId = await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "p/war-room",
				fileNodeId: privateFolderId,
				rolloverIndex: plugins_PRIVATE_FOLDER_ROLLOVER_INDEX,
				path: "/chitchat/private/war-room",
				updatedAt: now,
			});
			const grantId = await ctx.db.insert("access_control_permission_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				resourceKind: "file",
				resourceId: privateFolderId,
				principalKind: "user",
				userId: fixture.userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			return { grantId, privateFolderId, privateMapId, regularFileId, regularMapId, rootId, stateId };
		});

		await expect(
			t.mutation(internal.migrations.audit_projection_private_folder_authority, {
				cursor: null,
				batchSize: 100,
				dryRun: false,
				oneBatchOnly: true,
			}),
		).rejects.toThrow(/Projection cutover blocked/u);

		const blocked = await t.run(async (ctx) => ({
			grant: await ctx.db.get("access_control_permission_grants", seeded.grantId),
			maps: await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect(),
			root: await ctx.db.get("files_nodes", seeded.rootId),
			state: await ctx.db.get("plugins_data_projection_states", seeded.stateId),
		}));
		expect(blocked.state?.rootFolderNodeId).toBe(seeded.rootId);
		expect(blocked.state?.syncGeneration).toBe(1);
		expect(blocked.root?.projectionPluginName).toBeUndefined();
		expect(blocked.maps.map((map) => map._id)).toEqual(
			expect.arrayContaining([seeded.regularMapId, seeded.privateMapId]),
		);
		expect(blocked.maps).toHaveLength(2);
		expect(blocked.grant?._id).toBe(seeded.grantId);

		// This simulates the operator choosing a proof-based migration instead of erasing the folder.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.rootId, {
				projectionPluginName: "chitchat",
				readOnlyScopeNodeId: seeded.rootId,
			});
			await ctx.db.patch("files_nodes", seeded.privateFolderId, {
				projectionPluginName: "chitchat",
				readOnlyScopeNodeId: seeded.rootId,
				restrictedScopeNodeId: seeded.privateFolderId,
			});
		});
		await t.mutation(internal.migrations.audit_projection_private_folder_authority, {
			cursor: null,
			batchSize: 100,
			dryRun: false,
			oneBatchOnly: true,
		});

		// Migration phases commit separately. If authority changes after the first proof, the later
		// destructive pass must keep the map that owns cleanup of the folder's mirrored grants.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.privateFolderId, { restrictedScopeNodeId: undefined });
		});
		await expect(
			t.mutation(internal.migrations.audit_projection_file_authority, {
				cursor: null,
				batchSize: 100,
				dryRun: false,
				oneBatchOnly: true,
			}),
		).rejects.toThrow(/Projection cutover blocked/u);
		const staleProofBlocked = await t.run(async (ctx) => ({
			grant: await ctx.db.get("access_control_permission_grants", seeded.grantId),
			privateMap: await ctx.db.get("plugins_data_projection_files", seeded.privateMapId),
		}));
		expect(staleProofBlocked.privateMap?._id).toBe(seeded.privateMapId);
		expect(staleProofBlocked.grant?._id).toBe(seeded.grantId);

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.privateFolderId, {
				restrictedScopeNodeId: seeded.privateFolderId,
			});
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.audit_projection_private_folder_authority,
			);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_root_authority);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_file_authority);
			await runToCompletion(
				ctx,
				components.migrations,
				internal.migrations.audit_projection_private_folder_authority,
			);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_root_authority);
			await runToCompletion(ctx, components.migrations, internal.migrations.audit_projection_file_authority);
		});

		const migrated = await t.run(async (ctx) => ({
			grant: await ctx.db.get("access_control_permission_grants", seeded.grantId),
			privateFolder: await ctx.db.get("files_nodes", seeded.privateFolderId),
			privateMap: await ctx.db.get("plugins_data_projection_files", seeded.privateMapId),
			regularFile: await ctx.db.get("files_nodes", seeded.regularFileId),
			regularMap: await ctx.db.get("plugins_data_projection_files", seeded.regularMapId),
			state: await ctx.db.get("plugins_data_projection_states", seeded.stateId),
		}));
		expect(migrated.state?.rootFolderNodeId).toBe(seeded.rootId);
		expect(migrated.state?.syncGeneration).toBe(1);
		expect(migrated.privateFolder?.projectionPluginName).toBe("chitchat");
		expect(migrated.privateMap?._id).toBe(seeded.privateMapId);
		expect(migrated.regularFile?.projectionPluginName).toBeUndefined();
		expect(migrated.regularMap).toBeNull();
		expect(migrated.grant?._id).toBe(seeded.grantId);
	});

	test("backfills the normalized text hash and updates its asset binding", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const text = "projection migration\n";
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const firstAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "projection/first.md",
				size: new TextEncoder().encode(text).byteLength,
				createdBy: fixture.userId,
				updatedAt: now,
			});
			const fileNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "file",
				name: "general.md",
				path: "/chitchat/general.md",
				treePath: "/chitchat/general.md",
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				assetId: firstAssetId,
				projectionPluginName: "chitchat",
				updatedAt: now,
			});
			await ctx.db.insert("files_text_chunks", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				fileNodeId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				textChunk: text,
				startIndex: 0,
				endIndex: text.length,
				lineStart: 1,
				lineEnd: 2,
				chunkFlags: 0,
			});
			const projectionFileId = await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "general",
				fileNodeId,
				rolloverIndex: 0,
				path: "/chitchat/general.md",
				updatedAt: now,
			});
			return { fileNodeId, firstAssetId, projectionFileId };
		});

		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
		const expectedHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const legacy = await t.run((ctx) => ctx.db.get("plugins_data_projection_files", seeded.projectionFileId));
		expect(legacy?.contentHash).toBeUndefined();
		expect(legacy?.contentAssetId).toBeUndefined();

		await t.mutation(internal.migrations.backfill_projection_file_content_pairs, {
			cursor: null,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		const firstPair = await t.run((ctx) => ctx.db.get("plugins_data_projection_files", seeded.projectionFileId));
		expect(firstPair?.contentHash).toBe(expectedHash);
		expect(firstPair?.contentAssetId).toBe(seeded.firstAssetId);

		const secondAssetId = await t.run(async (ctx) => {
			const now = Date.now();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "projection/second.md",
				size: new TextEncoder().encode(text).byteLength,
				createdBy: fixture.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", seeded.fileNodeId, { assetId, updatedAt: now });
			return assetId;
		});
		await t.mutation(internal.migrations.backfill_projection_file_content_pairs, {
			cursor: null,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		const rebound = await t.run((ctx) => ctx.db.get("plugins_data_projection_files", seeded.projectionFileId));
		expect(rebound?.contentHash).toBe(expectedHash);
		expect(rebound?.contentAssetId).toBe(secondAssetId);
	});

	test("backfills the hash and asset binding for a stamped Council mapping", async () => {
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const text = "# Council meeting\n\nLegacy note.\n";
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "council",
				displayName: "Council",
				version: "0.1.0",
				description: "Meeting notes",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"c".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/council-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "council-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/council/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				capabilities: [],
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: fixture.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId,
				pluginName: "council",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				r2Key: "projection/council-meeting.md",
				size: new TextEncoder().encode(text).byteLength,
				createdBy: fixture.userId,
				updatedAt: now,
			});
			const fileNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				kind: "file",
				name: "meeting.md",
				path: "/meetings/meeting-1/meeting.md",
				treePath: "/meetings/meeting-1/meeting.md",
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				assetId,
				readOnlyScopeNodeId: undefined,
				projectionPluginName: "council",
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", fileNodeId, { readOnlyScopeNodeId: fileNodeId });
			await ctx.db.insert("files_text_chunks", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				fileNodeId,
				sourceKind: "committed",
				yjsSequence: 0,
				chunkIndex: 0,
				textChunk: text,
				startIndex: 0,
				endIndex: text.length,
				lineStart: 1,
				lineEnd: 4,
				chunkFlags: 0,
			});
			const projectionFileId = await ctx.db.insert("plugins_data_projection_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId,
				channelKey: "meeting-1",
				fileNodeId,
				rolloverIndex: 0,
				path: "/meetings/meeting-1/meeting.md",
				updatedAt: now,
			});
			return { assetId, projectionFileId };
		});

		await t.mutation(internal.migrations.backfill_projection_file_content_pairs, {
			cursor: null,
			batchSize: 100,
			dryRun: false,
			oneBatchOnly: true,
		});
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
		const expectedHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const migrated = await t.run((ctx) => ctx.db.get("plugins_data_projection_files", seeded.projectionFileId));
		expect(migrated?.contentHash).toBe(expectedHash);
		expect(migrated?.contentAssetId).toBe(seeded.assetId);
	});

	test("a real cutover rebuild keeps the backfilled active asset", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		component.register(t);
		const fixture = await seed_member_share_door(t);
		const asPage = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: fixture.sessionId,
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-member-share-backfill",
			external_id: fixture.userId,
		});

		const channel = await asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "chan-cutover",
			value: { name: "cutover", archivedAt: null },
		});
		expect(channel._nay).toBeUndefined();
		const message = await asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			keyPrefix: "chan-cutover:",
			value: { text: "same bytes through cutover", attachments: [], editedAt: null, deletedAt: null },
			clientRequestId: "cutover-message",
		});
		expect(message._nay).toBeUndefined();
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });

		const run_sync = async () => {
			const state = await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_states")
					.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
					.unique(),
			);
			if (!state) {
				throw new Error("Expected a Chitchat projection state");
			}
			await t.action(internal.plugins_projections_chitchat.sync, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
			});
		};
		const read_mapping = async () =>
			await t.run(async (ctx) => {
				const row = await ctx.db
					.query("plugins_data_projection_files")
					.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-cutover").eq("rolloverIndex", 0),
					)
					.unique();
				return row ? { row, node: await ctx.db.get("files_nodes", row.fileNodeId) } : null;
			});
		const mark_dirty = async () => {
			await t.run(async (ctx) => {
				const now = Date.now();
				await ctx.db.insert("plugins_data_projection_dirty_channels", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey: "chan-cutover",
					queuedAt: now,
					updatedAt: now,
				});
			});
			await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		};
		const run_backfill = async () => {
			await t.mutation(internal.migrations.backfill_projection_file_content_pairs, {
				cursor: null,
				batchSize: 100,
				dryRun: false,
				oneBatchOnly: true,
			});
		};

		await run_sync();
		const projected = await read_mapping();
		if (!projected?.node?.assetId) {
			throw new Error("Expected a projected channel file");
		}
		const assetX = projected.node.assetId;
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_data_projection_files", projected.row._id, {
				contentHash: undefined,
				contentAssetId: undefined,
			});
		});

		await run_backfill();
		await mark_dirty();
		await run_sync();
		const afterLegacyRebuild = await read_mapping();
		expect(afterLegacyRebuild?.row.contentAssetId).toBe(assetX);
		expect(afterLegacyRebuild?.node?.assetId).toBe(assetX);

		const file = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: afterLegacyRebuild!.row.path,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		const state = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique(),
		);
		if (!file || !state?.rootFolderNodeId || !afterLegacyRebuild?.node?.assetId) {
			throw new Error("Expected a readable projected file and root");
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", state.rootFolderNodeId!, { readOnlyScopeNodeId: undefined });
			await files_nodes_db_cascade_read_only_scope(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: state.rootFolderNodeId!,
				scopeNodeId: undefined,
			});
		});
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: fixture.membershipId,
			nodeId: afterLegacyRebuild.node._id,
			text: file.content,
			baseAssetId: afterLegacyRebuild.node.assetId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		const assetY = saved._yay.assetId;
		expect(assetY).not.toBe(assetX);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", state.rootFolderNodeId!, {
				readOnlyScopeNodeId: state.rootFolderNodeId!,
			});
			await files_nodes_db_cascade_read_only_scope(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: state.rootFolderNodeId!,
				scopeNodeId: state.rootFolderNodeId!,
			});
		});

		await run_backfill();
		await mark_dirty();
		await run_sync();
		const afterReboundRebuild = await read_mapping();
		expect(afterReboundRebuild?.row.contentAssetId).toBe(assetY);
		expect(afterReboundRebuild?.node?.assetId).toBe(assetY);
	});

	async function seedProjectionResetFixture(t: ReturnType<typeof test_convex>) {
		const fixture = await seed_member_share_door(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		return await t.run(async (ctx) => {
			const now = Date.now();
			const cursorDocumentId = await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "messages",
				key: "general:message",
				value: { text: "before cutover" },
				byteSize: 24,
				revision: 1,
				writeMode: "normal",
				ownership: "owned",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique();
			if (!state?.scheduledJobId) {
				throw new Error("Expected a scheduled Chitchat projection state");
			}
			const generation = state.syncGeneration;
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors: {
					messages: {
						updatedAt: now,
						lastCreationTime: (await ctx.db.get("plugins_data", cursorDocumentId))!._creationTime,
						lastId: cursorDocumentId,
					},
				},
				scanCursors: undefined,
				reconcileAfterChannelKey: "general",
				dirty: false,
			});
			const councilInstallationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
			const councilStateId = await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: councilInstallationId,
				pluginName: "council",
				writerUserId: fixture.userId,
				cursors: {
					meetings: {
						updatedAt: now,
						lastCreationTime: (await ctx.db.get("plugins_data", cursorDocumentId))!._creationTime,
						lastId: cursorDocumentId,
					},
				},
				syncGeneration: generation,
				scheduledJobId: state.scheduledJobId,
				dirty: false,
				updatedAt: now,
			});
			return { ...fixture, councilStateId, generation, stateId: state._id };
		});
	}

	test("backfills legacy scan cursors and resets only Chitchat logical cursors", async () => {
		const t = test_convex();
		component.register(t);
		const seeded = await seedProjectionResetFixture(t);
		const before = await t.run(async (ctx) => ({
			chitchat: await ctx.db.get("plugins_data_projection_states", seeded.stateId),
			council: await ctx.db.get("plugins_data_projection_states", seeded.councilStateId),
		}));
		expect(before.chitchat?.dirty).toBe(false);
		expect(Object.keys(before.chitchat?.cursors ?? {})).toEqual(["messages"]);
		expect(before.chitchat?.scanCursors).toBeUndefined();
		expect(before.chitchat?.reconcileAfterChannelKey).toBe("general");
		expect(before.council?.scanCursors).toBeUndefined();
		expect(before.chitchat?.scheduledJobId).toBeDefined();

		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.reset_chitchat_projection_state_cursors);
		});
		const after = await t.run(async (ctx) => ({
			chitchat: await ctx.db.get("plugins_data_projection_states", seeded.stateId),
			council: await ctx.db.get("plugins_data_projection_states", seeded.councilStateId),
		}));
		expect(after.chitchat?.cursors).toEqual({});
		expect(after.chitchat?.scanCursors).toEqual({});
		expect(after.chitchat?.reconcileAfterChannelKey).toBeUndefined();
		expect(after.chitchat?.dirty).toBe(true);
		expect(after.chitchat?.scheduledJobId).toBeUndefined();
		expect(after.chitchat?.syncGeneration).toBe(seeded.generation + 1);
		expect(after.council?.scanCursors).toEqual({});
		expect(after.council?.cursors).toEqual(before.council?.cursors);
		expect(after.council?.dirty).toBe(before.council?.dirty);
		expect(after.council?.syncGeneration).toBe(before.council?.syncGeneration);
		expect(after.council?.scheduledJobId).toBe(before.council?.scheduledJobId);
	});

	test("an old finish cannot clear a reset Chitchat state", async () => {
		const t = test_convex();
		component.register(t);
		const seeded = await seedProjectionResetFixture(t);
		await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.reset_chitchat_projection_state_cursors);
		});
		const reset = await t.run((ctx) => ctx.db.get("plugins_data_projection_states", seeded.stateId));

		await t.mutation(internal.plugins_projections.finish_sync, {
			installationId: seeded.installationId,
			syncGeneration: seeded.generation,
			continueImmediately: false,
		});
		const afterOldFinish = await t.run((ctx) => ctx.db.get("plugins_data_projection_states", seeded.stateId));
		expect(afterOldFinish?.dirty).toBe(true);
		expect(afterOldFinish?.cursors).toEqual(reset?.cursors);
		expect(afterOldFinish?.scheduledJobId).toBe(reset?.scheduledJobId);
		expect(afterOldFinish?.syncGeneration).toBe(reset?.syncGeneration);
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
