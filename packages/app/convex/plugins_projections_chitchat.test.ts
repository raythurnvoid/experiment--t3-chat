import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { collision_slug } from "./plugins_projections_chitchat.ts";
// Load action modules before fake timers. convex-test imports them on first
// run, and that import can hang while timers are faked.
import "./plugins_projections.ts";
import "./plugins_projections_chitchat.ts";
import "./files_nodes_content.ts";

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

let page_session_seed_counter = 0;

async function seed_page_session(
	t: ReturnType<typeof test_convex>,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		pluginVersionId: Id<"plugins_versions">;
		userId: Id<"users">;
	},
) {
	page_session_seed_counter += 1;
	const tokenHash = `page-session-projection-${page_session_seed_counter}`;
	const sessionId = await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("plugins_ui_sessions", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			pluginVersionId: args.pluginVersionId,
			userId: args.userId,
			tokenHash,
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
	});
	const asPage = t.withIdentity({
		issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
		subject: sessionId,
	});
	return { sessionId, asPage } as const;
}

async function seed_plugin_user_write(t: ReturnType<typeof test_convex>, args: { pluginName: string; clerkUserId?: string }) {
	const clerkUserId = args.clerkUserId ?? "chitchat-owner";
	const userId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId }));
	const fixture = await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, { userId });
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: args.pluginName,
			displayName: args.pluginName,
			version: "0.1.0",
			description: "test plugin",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"b".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/bonobo/${args.pluginName}-plugin`,
			sourceOwner: "bonobo",
			sourceRepo: `${args.pluginName}-plugin`,
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: `plugins/${args.pluginName}/manifest.json`,
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities: [
				"plugin.data.read",
				"plugin.data.write",
				"plugin.data.user-write",
				"plugin.service.connect",
			],
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
			pluginName: args.pluginName,
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: [
				"plugin.data.read",
				"plugin.data.write",
				"plugin.data.user-write",
				"plugin.service.connect",
			] satisfies plugins_Capability[],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		const anagraphicId = await ctx.db.insert("users_anagraphics", {
			userId: membership.userId,
			displayName: "Alice",
			email: "alice@example.com",
			updatedAt: now,
		});
		await ctx.db.patch("users", membership.userId, { anagraphic: anagraphicId });
		return { ...membership, pluginVersionId, installationId } as const;
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: clerkUserId, external_id: userId });
	const pageSession = await seed_page_session(t, fixture);
	return { ...fixture, asUser, ...pageSession } as const;
}

async function flush_projection(t: ReturnType<typeof test_convex>) {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function read_projection_file(
	t: ReturnType<typeof test_convex>,
	fixture: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
	path: string,
) {
	return await t.query(internal.files_nodes.read_file_content_from_chunks, {
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		userId: fixture.userId,
		path,
		mode: { kind: "full", maxBytes: 100_000 },
	});
}

async function read_projection_state(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
) {
	return await t.run(async (ctx) => {
		return await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first();
	});
}

async function put_public_channel(fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>, key: string, name: string) {
	const channel = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
		collection: "channels",
		key,
		value: { name, archivedAt: null },
	});
	if (channel._nay) {
		throw new Error(channel._nay.message);
	}

	return channel._yay;
}

async function append_public_message(
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	channelKey: string,
	text: string,
	clientRequestId: string,
) {
	const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
		collection: "messages",
		keyPrefix: `${channelKey}:`,
		value: { text, attachments: [], editedAt: null, deletedAt: null },
		clientRequestId,
	});
	if (appended._nay) {
		throw new Error(appended._nay.message);
	}

	return appended._yay;
}

describe("chitchat file projection", () => {
	test("user_append_document schedules a sync that writes the public channel file", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "hello from chitchat", "msg-1");
		await flush_projection(t);

		const file = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(file).not.toBeNull();
		expect(file?.content).toContain("hello from chitchat");
		expect(file?.content).toContain("<!-- chitchat:msg:");
		expect(file?.content).toContain("**Alice**");
		expect(file?.nonCollaborativeBaseAssetId).toEqual(expect.any(String));

		const node = await t.run(async (ctx) => await ctx.db.get("files_nodes", file!.nodeId));
		expect(node?.readOnlyScopeNodeId).toBeDefined();
		expect(node?.nonCollaborative).toBe(true);
	});

	test("an unregistered plugin write does not schedule projection work", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "gallery" });

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "gallery only" },
			clientRequestId: "gallery-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		await flush_projection(t);

		const states = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(states).toHaveLength(0);
		expect(await read_projection_file(t, fixture, "/chitchat/general.md")).toBeNull();
	});

	test("same-millisecond messages both reach the file when the cursor page size is 1", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "first same-ms", "same-1");
		await append_public_message(fixture, "chan-general", "second same-ms", "same-2");

		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		let truncated = true;
		while (truncated) {
			const page = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				collection: "messages",
				pageSize: 1,
			});
			if (page._nay) {
				throw new Error(page._nay.message);
			}

			truncated = page._yay.truncated;
		}

		const messageDocs = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_scope_updatedAt", (q) =>
					q
						.eq("installationId", fixture.installationId)
						.eq("collection", "messages")
						.eq("scopeId", undefined),
				)
				.collect();
		});
		const lastMessage = [...messageDocs].sort((left, right) => (left._id < right._id ? -1 : 1)).at(-1);
		const state = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
		});
		expect(state?.cursors.messages?.lastId).toBe(lastMessage?._id);

		const dirty = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
				)
				.first();
		});
		expect(dirty).not.toBeNull();

		const timestamps = new Set(messageDocs.map((doc) => doc.updatedAt));
		expect(timestamps.size).toBe(1);

		const stateForWrite = await read_projection_state(t, fixture.installationId);
		if (stateForWrite === null) {
			throw new Error("Expected projection state after schedule_sync");
		}

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: stateForWrite.syncGeneration,
		});

		const file = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(file?.content).toContain("first same-ms");
		expect(file?.content).toContain("second same-ms");
	});

	test("edits, deletes, and reactions change the projected block", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		const appended = await append_public_message(fixture, "chan-general", "original", "edit-1");
		await flush_projection(t);
		expect((await read_projection_file(t, fixture, "/chitchat/general.md"))?.content).toContain("original");

		const edited = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: appended.key,
			value: { text: "edited text", attachments: [], editedAt: Date.now(), deletedAt: null },
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const reacted = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: `${appended.key}:thumbs_up`,
			value: {},
		});
		if (reacted._nay) {
			throw new Error(reacted._nay.message);
		}

		await flush_projection(t);
		const afterEdit = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(afterEdit?.content).toContain("edited text");
		expect(afterEdit?.content).toContain("(edited)");
		expect(afterEdit?.content).toContain("👍 1");

		const deleted = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: appended.key,
			value: { text: "edited text", attachments: [], editedAt: Date.now(), deletedAt: Date.now() },
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		await flush_projection(t);
		const afterDelete = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(afterDelete?.content).toContain("(message deleted)");
		expect(afterDelete?.content).not.toContain("edited text");
	});

	test("a private scoped channel never appears in a file or a search chunk", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const privateKey = "p/secret-channel";
		const secret = "private-secret-text";

		const scope = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: "scope-private",
				collections: ["channels", "messages", "replies", "reactions"],
				keyPrefix: privateKey,
			},
		});
		if (scope._nay) {
			throw new Error(scope._nay.message);
		}

		const channel = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: privateKey,
			value: { name: "secret", archivedAt: null },
		});
		if (channel._nay) {
			throw new Error(channel._nay.message);
		}

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			keyPrefix: `${privateKey}:`,
			value: { text: secret, attachments: [], editedAt: null, deletedAt: null },
			clientRequestId: "private-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		await flush_projection(t);

		expect(await read_projection_file(t, fixture, "/chitchat/secret.md")).toBeNull();
		const chunks = await t.run(async (ctx) => await ctx.db.query("files_text_chunks").collect());
		expect(chunks.some((chunk) => chunk.textChunk.includes(secret))).toBe(false);
	});

	test("an unmapped occupant at /chitchat/general.md is not overwritten", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		const occupant = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/chitchat/general.md",
			textContent: "user owned file",
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "projected", "occ-1");
		await flush_projection(t);

		const original = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(original?.content).toContain("user owned file");
		expect(original?.content).not.toContain("projected");

		const collision = await t.run(async (ctx) => {
			const files = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
			return files.find((doc) => doc.channelKey === "chan-general");
		});
		expect(collision).not.toBeNull();
		expect(collision?.path).not.toBe("/chitchat/general.md");
		const projected = await read_projection_file(t, fixture, collision!.path);
		expect(projected?.content).toContain("projected");
	});

	test("bash replace on a projection file is read_only and create_file_by_path under the folder is too", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "locked", "lock-1");
		await flush_projection(t);

		const file = await read_projection_file(t, fixture, "/chitchat/general.md");
		if (!file?.nonCollaborativeBaseAssetId) {
			throw new Error("Expected a non-collaborative projection file");
		}

		const replaced = await t.action(internal.files_nodes_content.replace_file_content_internal_action, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			nodeId: file.nodeId,
			text: "agent overwrite",
			baseAssetId: file.nonCollaborativeBaseAssetId,
		});
		expect(replaced._nay?.name).toBe("read_only");

		const created = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/chitchat/other.md",
		});
		expect(created._nay?.name).toBe("read_only");
	});

	test("uninstall drain deletes projection tables and leaves the files", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "keep me", "drain-1");
		await flush_projection(t);
		expect((await read_projection_file(t, fixture, "/chitchat/general.md"))?.content).toContain("keep me");

		for (let passes = 0; passes < 30; passes += 1) {
			const drained = await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				_test_disableReschedule: true,
			});
			if (drained.done) {
				break;
			}
		}

		const states = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		const maps = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_files").collect());
		expect(states).toHaveLength(0);
		expect(maps).toHaveLength(0);
		expect((await read_projection_file(t, fixture, "/chitchat/general.md"))?.content).toContain("keep me");
	});

	test("an extra lock on a mapped file is archived and a new mapped file is written", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "before lock", "lock-extra-1");
		await flush_projection(t);

		const before = await read_projection_file(t, fixture, "/chitchat/general.md");
		if (!before) {
			throw new Error("Expected a projection file");
		}

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", before.nodeId, {
				readOnlyScopeNodeId: before.nodeId,
			});
		});

		await append_public_message(fixture, "chan-general", "after extra lock", "lock-extra-2");
		await flush_projection(t);

		const after = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(after?.content).toContain("after extra lock");
		expect(after?.nodeId).not.toBe(before.nodeId);
	});

	test("reinstall adopts leftover non-collaborative files at the same path", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "frozen snapshot", "adopt-1");
		await flush_projection(t);
		const leftover = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(leftover?.content).toContain("frozen snapshot");

		for (let passes = 0; passes < 30; passes += 1) {
			const drained = await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				_test_disableReschedule: true,
			});
			if (drained.done) {
				break;
			}
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "after reinstall", "adopt-2");
		await flush_projection(t);

		const adopted = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(adopted?.content).toContain("after reinstall");
		expect(adopted?.nodeId).toBe(leftover?.nodeId);

		const collisionMaps = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
		});
		expect(collisionMaps.some((doc) => doc.path !== "/chitchat/general.md" && doc.channelKey === "chan-general")).toBe(
			false,
		);
	});

	test("two public channels with the same name keep separate files", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general-a", "general");
		await put_public_channel(fixture, "chan-general-b", "general");
		await append_public_message(fixture, "chan-general-a", "alpha-only", "same-name-a");
		await append_public_message(fixture, "chan-general-b", "beta-only", "same-name-b");
		await flush_projection(t);

		const maps = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
		});
		const mapA = maps.find((doc) => doc.channelKey === "chan-general-a");
		const mapB = maps.find((doc) => doc.channelKey === "chan-general-b");
		expect(mapA).toBeDefined();
		expect(mapB).toBeDefined();
		expect(mapA?.path).not.toBe(mapB?.path);

		const fileA = await read_projection_file(t, fixture, mapA!.path);
		const fileB = await read_projection_file(t, fixture, mapB!.path);
		expect(fileA?.content).toContain("alpha-only");
		expect(fileA?.content).not.toContain("beta-only");
		expect(fileB?.content).toContain("beta-only");
		expect(fileB?.content).not.toContain("alpha-only");
	});

	test("a public channel named readme does not replace the projection README", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-readme", "readme");
		await append_public_message(fixture, "chan-readme", "readme-channel-text", "readme-1");
		await flush_projection(t);

		const readme = await read_projection_file(t, fixture, "/chitchat/README.md");
		expect(readme?.content).toContain("Private channels never appear here.");
		expect(readme?.content).not.toContain("readme-channel-text");

		const channelFile = await t.run(async (ctx) => {
			const maps = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
			return maps.find((doc) => doc.channelKey === "chan-readme");
		});
		expect(channelFile?.path).not.toBe("/chitchat/README.md");
		const projected = await read_projection_file(t, fixture, channelFile!.path);
		expect(projected?.content).toContain("readme-channel-text");
	});

	test("an existing user folder named chitchat is not reused or locked", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		const created = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "chitchat",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "keep the user folder", "folder-1");
		await flush_projection(t);

		const userFolder = await t.run(async (ctx) => await ctx.db.get("files_nodes", created._yay.nodeId));
		expect(userFolder?.readOnlyScopeNodeId).toBeUndefined();

		const stolen = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(stolen).toBeNull();

		const projected = await t.run(async (ctx) => {
			const maps = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
			return maps.find((doc) => doc.channelKey === "chan-general");
		});
		expect(projected?.path.startsWith("/chitchat-")).toBe(true);
		const file = await read_projection_file(t, fixture, projected!.path);
		expect(file?.content).toContain("keep the user folder");
	});

	test("a member-locked leftover chitchat folder is reused instead of suffixing", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		const created = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "chitchat",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (locked._nay) {
			throw new Error(locked._nay.message);
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "into the leftover folder", "leftover-lock-1");
		await flush_projection(t);

		const folder = await t.run(async (ctx) => await ctx.db.get("files_nodes", created._yay.nodeId));
		expect(folder?.readOnlyScopeNodeId).toBe(created._yay.nodeId);

		const file = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(file?.content).toContain("into the leftover folder");

		const state = await read_projection_state(t, fixture.installationId);
		expect(state?.rootFolderNodeId).toBe(created._yay.nodeId);
	});

	test("a failed channel write keeps dirty work and does not reschedule the same generation", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		const folder = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "chitchat",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const occupant = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/chitchat/general.md",
			textContent: "user owned file",
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}

		const collisionPath = `/chitchat/${collision_slug("general", "chan-general")}.md`;
		const collision = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: collisionPath,
			textContent: "collision owned file",
		});
		if (collision._nay) {
			throw new Error(collision._nay.message);
		}

		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: folder._yay.nodeId,
		});
		if (locked._nay) {
			throw new Error(locked._nay.message);
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "projected", "write-nay-1");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });

		const before = await read_projection_state(t, fixture.installationId);
		if (before === null || before.syncGeneration === 0) {
			throw new Error("Expected schedule_sync to create a generation");
		}

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: before.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		expect(after?.scheduledJobId).toBeUndefined();
		expect(after?.dirty).toBe(true);

		const dirty = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
				)
				.first();
		});
		expect(dirty).not.toBeNull();

		const original = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(original?.content).toContain("user owned file");
		expect(original?.content).not.toContain("projected");
	});

	test("hourly ensure continues past the first twenty chitchat installations", async () => {
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const now = Date.now();

		await t.run(async (ctx) => {
			for (let extra = 0; extra < 20; extra += 1) {
				await ctx.db.insert("plugins_workspace_installations", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					pluginVersionId: fixture.pluginVersionId,
					pluginName: "chitchat",
					status: "enabled",
					configurationYaml: null,
					acceptedCapabilities: [
						"plugin.data.read",
						"plugin.data.write",
						"plugin.data.user-write",
						"plugin.service.connect",
					] satisfies plugins_Capability[],
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
					outboundOriginsAcceptedAt: now,
					installedBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		await t.mutation(internal.plugins_projections.ensure_hourly, {});
		const afterFirstPage = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(afterFirstPage).toHaveLength(20);

		const firstPageLastId = await t.run(async (ctx) => {
			const page = await ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
				.order("asc")
				.take(20);
			return page[19]?._id;
		});
		expect(firstPageLastId).toBeDefined();

		await t.mutation(internal.plugins_projections.ensure_hourly, { afterId: firstPageLastId });
		const afterSecondPage = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(afterSecondPage).toHaveLength(21);
	});
});
