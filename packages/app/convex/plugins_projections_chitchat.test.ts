import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
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

async function join_workspace_member(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	clerkUserId: string,
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId,
			active: true,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId,
			role: "member",
			now,
		});
		return { userId } as const;
	});
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

	test("a channel doc whose scope id is not its key is not projected at all", async () => {
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

		// The scope id must equal the channel key. This pairing is one the plugin never writes, and
		// the projector refuses it rather than guessing which one names the channel — so nothing is
		// written at either the public path or the private one.
		expect(await read_projection_file(t, fixture, "/chitchat/secret.md")).toBeNull();
		expect(await read_projection_file(t, fixture, "/chitchat/private/secret/secret.md")).toBeNull();
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
		expect(readme?.content).toContain("Private channels appear under `private/`.");
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

describe("private channel projection", () => {
	// The scope id is the channel key. The public put/append helpers are key-generic, so passing
	// the scope id as the channel key writes documents inside the scope's key range.
	const SCOPE_ID = "p/room-1";

	async function seed_private_channel(t: ReturnType<typeof test_convex>) {
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const scope = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: SCOPE_ID,
				collections: ["channels", "messages", "replies", "reactions"],
				keyPrefix: SCOPE_ID,
			},
		});
		if (scope._nay) {
			throw new Error(scope._nay.message);
		}

		await put_public_channel(fixture, SCOPE_ID, "war-room");
		return fixture;
	}

	async function set_scope_member(
		fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
		userId: Id<"users">,
		scopeId = SCOPE_ID,
	) {
		const set = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId, userId, level: "member" },
		});
		if (set._nay) {
			throw new Error(set._nay.message);
		}
	}

	async function read_private_folder(
		t: ReturnType<typeof test_convex>,
		fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
		scopeId = SCOPE_ID,
	) {
		return await t.run(async (ctx) => {
			const row = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", scopeId).eq("rolloverIndex", -1),
				)
				.first();
			if (!row) {
				return null;
			}

			const node = await ctx.db.get("files_nodes", row.fileNodeId);
			return { row, node } as const;
		});
	}

	async function read_folder_grants(
		t: ReturnType<typeof test_convex>,
		fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
		folderNodeId: Id<"files_nodes">,
	) {
		return await t.run(async (ctx) => {
			return await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", String(folderNodeId)),
				)
				.collect();
		});
	}

	test("a private channel projects into a restricted folder only scope members can read", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		const carol = await join_workspace_member(t, fixture, "chitchat-carol");
		await set_scope_member(fixture, bob.userId);

		const appended = await append_public_message(fixture, SCOPE_ID, "private plans", "private-1");
		const reply = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "replies",
			keyPrefix: `${appended.key}:`,
			value: { text: "private reply", attachments: [], editedAt: null, deletedAt: null },
			clientRequestId: "private-reply-1",
		});
		if (reply._nay) {
			throw new Error(reply._nay.message);
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

		// The owner (Alice) reads everything, so this proves the file exists at the private path.
		const file = await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md");
		expect(file?.content).toContain("private plans");
		expect(file?.content).toContain("private reply");
		expect(file?.content).toContain("👍 1");
		expect(file?.content).toContain("organization owner");
		expect(await read_projection_file(t, fixture, "/chitchat/war-room.md")).toBeNull();

		// All four scoped collections keep their own fence.
		const state = await read_projection_state(t, fixture.installationId);
		expect(state?.cursors[`${SCOPE_ID}:replies`]).toBeDefined();
		expect(state?.cursors[`${SCOPE_ID}:reactions`]).toBeDefined();

		const folder = await read_private_folder(t, fixture);
		expect(folder?.row.path).toBe("/chitchat/private/war-room");
		expect(folder?.node?.restrictedScopeNodeId).toBe(folder?.node?._id);

		const grants = await read_folder_grants(t, fixture, folder!.node!._id);
		expect(grants.map((grant) => [grant.userId, grant.permission]).sort()).toEqual(
			[
				[fixture.userId, "content.read"],
				[bob.userId, "content.read"],
			].sort(),
		);
		expect(grants.every((grant) => grant.principalKind === "user")).toBe(true);

		const asBob = await read_projection_file(
			t,
			{ ...fixture, userId: bob.userId },
			"/chitchat/private/war-room/war-room.md",
		);
		expect(asBob?.content).toContain("private plans");
		const asCarol = await read_projection_file(
			t,
			{ ...fixture, userId: carol.userId },
			"/chitchat/private/war-room/war-room.md",
		);
		expect(asCarol).toBeNull();
	});


	test("two private channels with the same name get separate restricted folders", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		await set_scope_member(fixture, bob.userId);
		await append_public_message(fixture, SCOPE_ID, "alpha secret", "twin-1");
		await flush_projection(t);

		const secondScope = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: "p/room-2",
				collections: ["channels", "messages", "replies", "reactions"],
				keyPrefix: "p/room-2",
			},
		});
		if (secondScope._nay) {
			throw new Error(secondScope._nay.message);
		}

		await put_public_channel(fixture, "p/room-2", "war-room");
		await append_public_message(fixture, "p/room-2", "bravo secret", "twin-2");
		await flush_projection(t);

		// Each channel keeps its own folder; the second lands on the collision slug.
		const firstFolder = await read_private_folder(t, fixture);
		const secondFolder = await read_private_folder(t, fixture, "p/room-2");
		expect(firstFolder?.row.path).toBe("/chitchat/private/war-room");
		expect(secondFolder?.row.path).toBe(`/chitchat/private/${collision_slug("war-room", "p/room-2")}`);
		expect(secondFolder?.node?._id).not.toBe(firstFolder?.node?._id);

		const firstFile = await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md");
		expect(firstFile?.content).toContain("alpha secret");
		expect(firstFile?.content).not.toContain("bravo secret");

		// Bob is only in the first channel: his grant there must survive the second channel's
		// sync, and he gets nothing on the second folder.
		const firstGrants = await read_folder_grants(t, fixture, firstFolder!.node!._id);
		expect(firstGrants.map((grant) => grant.userId).sort()).toEqual([fixture.userId, bob.userId].sort());
		const secondGrants = await read_folder_grants(t, fixture, secondFolder!.node!._id);
		expect(secondGrants.map((grant) => grant.userId)).toEqual([fixture.userId]);

		// Anchor the second file's path before reading it as Bob: a wrong path would read null for
		// everybody and prove nothing about his access.
		const secondPath = `${secondFolder!.row.path}/war-room.md`;
		expect((await read_projection_file(t, fixture, secondPath))?.content).toContain("bravo secret");
		expect(await read_projection_file(t, { ...fixture, userId: bob.userId }, secondPath)).toBeNull();
	});

	test("adopting a leftover folder does not hand the old channel's files to the new members", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "old channel content", "leftover-1");
		await flush_projection(t);
		const oldFolder = await read_private_folder(t, fixture);

		// A rollover file of the old channel. Producing one for real needs a 600 KB transcript, so
		// insert it through the same node writer the projection uses.
		const leftoverNodeId = await t.run(async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: files_ROOT_ID,
				path: `${oldFolder!.row.path}/war-room.001.md`,
				kind: "file",
				contentType: "text/markdown;charset=utf-8",
				skipAccessControlAndLock: true,
				inheritParentReadOnlyScope: true,
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			return created._yay;
		});

		// Uninstall and disable delete the projection map rows and leave the files. What is left is
		// an unmapped folder that still carries the root lock, which the next same-name channel adopts.
		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect();
			await Promise.all(rows.map((row) => ctx.db.delete("plugins_data_projection_files", row._id)));
		});

		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		const newScope = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: "p/room-9",
				collections: ["channels", "replies", "messages", "reactions"],
				keyPrefix: "p/room-9",
			},
		});
		if (newScope._nay) {
			throw new Error(newScope._nay.message);
		}
		await set_scope_member(fixture, bob.userId, "p/room-9");
		await put_public_channel(fixture, "p/room-9", "war-room");
		await append_public_message(fixture, "p/room-9", "new channel content", "leftover-2");
		await flush_projection(t);

		// The new channel took the folder, so its members now read everything inside it. The old
		// channel's rollover file must not be one of those things.
		const adopted = await read_private_folder(t, fixture, "p/room-9");
		expect(adopted?.node?._id).toBe(oldFolder!.node!._id);
		const leftover = await t.run(async (ctx) => await ctx.db.get("files_nodes", leftoverNodeId));
		expect(leftover?.archiveOperationId).toBeDefined();
	});

	test("a non-member's text search cannot reach the private channel file", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		const carol = await join_workspace_member(t, fixture, "chitchat-carol");
		await set_scope_member(fixture, bob.userId);
		await append_public_message(fixture, SCOPE_ID, "zebra classified plan", "search-1");
		await flush_projection(t);

		const search = async (userId: Id<"users">) =>
			await t.query(internal.files_nodes.text_search_files, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				// Both hold workspace-wide read from their role. The folder restriction, not the
				// workspace check, is what has to keep Carol out.
				hasWorkspaceRead: true,
				query: "zebra classified plan",
				numItems: 10,
				cursor: null,
			});

		// The projected file is indexed like any other file, so the words really are in the index.
		expect((await search(bob.userId)).items.map((item) => item.path)).toContain(
			"/chitchat/private/war-room/war-room.md",
		);
		expect((await search(carol.userId)).items).toEqual([]);
	});

	test("a second sync keeps the private folder instead of archiving it as an unknown public channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);

		await append_public_message(fixture, SCOPE_ID, "first private", "keep-1");
		await flush_projection(t);
		await append_public_message(fixture, SCOPE_ID, "second private", "keep-2");
		await flush_projection(t);

		const file = await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md");
		expect(file?.content).toContain("first private");
		expect(file?.content).toContain("second private");

		const folder = await read_private_folder(t, fixture);
		expect(folder?.node?.archiveOperationId).toBeUndefined();
	});

	test("remove_principal hides the folder from the removed member before any sync runs", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		await set_scope_member(fixture, bob.userId);

		await append_public_message(fixture, SCOPE_ID, "before removal", "remove-1");
		await flush_projection(t);
		const asBobBefore = await read_projection_file(
			t,
			{ ...fixture, userId: bob.userId },
			"/chitchat/private/war-room/war-room.md",
		);
		expect(asBobBefore?.content).toContain("before removal");

		const removed = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "remove_principal", scopeId: SCOPE_ID, userId: bob.userId },
		});
		if (removed._nay) {
			throw new Error(removed._nay.message);
		}

		// No timers ran, so no sync has: the mutation itself must have deleted the mirrored grant.
		const folder = await read_private_folder(t, fixture);
		const grantsNow = await read_folder_grants(t, fixture, folder!.node!._id);
		expect(grantsNow.map((grant) => grant.userId)).toEqual([fixture.userId]);
		expect(
			await read_projection_file(t, { ...fixture, userId: bob.userId }, "/chitchat/private/war-room/war-room.md"),
		).toBeNull();

		// The sync the removal scheduled must not add the grant back.
		await flush_projection(t);
		const grantsAfterSync = await read_folder_grants(t, fixture, folder!.node!._id);
		expect(grantsAfterSync.map((grant) => grant.userId)).toEqual([fixture.userId]);
		expect(
			await read_projection_file(t, { ...fixture, userId: bob.userId }, "/chitchat/private/war-room/war-room.md"),
		).toBeNull();
	});

	test("set_principal opens the folder to the new member after the scheduled sync", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);

		await append_public_message(fixture, SCOPE_ID, "before bob joined", "join-1");
		await flush_projection(t);

		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		expect(
			await read_projection_file(t, { ...fixture, userId: bob.userId }, "/chitchat/private/war-room/war-room.md"),
		).toBeNull();

		await set_scope_member(fixture, bob.userId);

		// Adds ride the sync: before timers run the folder is still closed to Bob.
		expect(
			await read_projection_file(t, { ...fixture, userId: bob.userId }, "/chitchat/private/war-room/war-room.md"),
		).toBeNull();

		await flush_projection(t);
		const asBob = await read_projection_file(
			t,
			{ ...fixture, userId: bob.userId },
			"/chitchat/private/war-room/war-room.md",
		);
		expect(asBob?.content).toContain("before bob joined");
	});

	test("the sync removes hand-added grants and restores the folder restriction", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const carol = await join_workspace_member(t, fixture, "chitchat-carol");

		await append_public_message(fixture, SCOPE_ID, "healed content", "heal-1");
		await flush_projection(t);

		const folder = await read_private_folder(t, fixture);

		// The owner's real "Stop restricting" door. It clears the folder pointer and cascades that to
		// every file inside, so the heal has to restore both — patching only the folder would leave
		// the files already readable and prove nothing about the cascade. It also drops every grant
		// on the folder, so the hand-added ones below are inserted after it.
		const unrestricted = await fixture.asUser.mutation(api.files_sharing.unrestrict_node, {
			membershipId: fixture.membershipId,
			nodeId: folder!.node!._id,
		});
		if (unrestricted._nay) {
			throw new Error(unrestricted._nay.message);
		}
		const openedFile = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/chitchat/private/war-room/war-room.md")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return { found: node !== null, restrictedScopeNodeId: node?.restrictedScopeNodeId ?? null };
		});
		expect(openedFile).toEqual({ found: true, restrictedScopeNodeId: null });

		await t.run(async (ctx) => {
			const now = Date.now();
			// A hand-added share for a non-member, and an extra write grant for a member.
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				resourceKind: "file",
				resourceId: String(folder!.node!._id),
				principalKind: "user",
				userId: carol.userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				resourceKind: "file",
				resourceId: String(folder!.node!._id),
				principalKind: "user",
				userId: fixture.userId,
				permission: "content.write",
				createdAt: now,
				updatedAt: now,
			});
		});

		await append_public_message(fixture, SCOPE_ID, "trigger heal", "heal-2");
		await flush_projection(t);

		const healedFolder = await read_private_folder(t, fixture);
		expect(healedFolder?.node?.restrictedScopeNodeId).toBe(healedFolder?.node?._id);
		const grants = await read_folder_grants(t, fixture, folder!.node!._id);
		expect(grants.map((grant) => [grant.userId, grant.permission])).toEqual([[fixture.userId, "content.read"]]);

		// Anchor the path first: Carol's null below must mean "refused", not "no such file".
		const healedFile = await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md");
		expect(healedFile?.content).toContain("trigger heal");
		expect(
			await read_projection_file(t, { ...fixture, userId: carol.userId }, "/chitchat/private/war-room/war-room.md"),
		).toBeNull();
	});

	test("deleting the scope removes the grants now and archives the folder on the next sync", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		await set_scope_member(fixture, bob.userId);

		await append_public_message(fixture, SCOPE_ID, "doomed content", "delete-1");
		await flush_projection(t);
		const folder = await read_private_folder(t, fixture);
		expect((await read_folder_grants(t, fixture, folder!.node!._id)).length).toBe(2);
		// Anchor the path first: the null read after the delete must mean "archived", not "never
		// existed".
		expect((await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md"))?.content).toContain(
			"doomed content",
		);

		const deleted = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "delete", scopeId: SCOPE_ID },
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		// Grants go in the same mutation; the archive rides the scheduled sync.
		expect(await read_folder_grants(t, fixture, folder!.node!._id)).toEqual([]);

		await flush_projection(t);
		expect(await read_private_folder(t, fixture)).toBeNull();
		const folderNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", folder!.node!._id));
		expect(folderNode?.archiveOperationId).toBeDefined();
		expect(await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md")).toBeNull();

		const state = await read_projection_state(t, fixture.installationId);
		expect(Object.keys(state?.cursors ?? {}).filter((key) => key.startsWith(`${SCOPE_ID}:`))).toEqual([]);
	});

	test("a deleted scope stops projecting instead of rebuilding the channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "doomed content", "revive-1");
		await flush_projection(t);
		// Anchor the path first: the null below must mean "dead scope", not "never existed".
		expect((await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md"))?.content).toContain(
			"doomed content",
		);

		const deleted = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "delete", scopeId: SCOPE_ID },
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		// A deleted scope keeps its documents, so the channel doc still looks alive. Only the missing
		// scope row says the channel is dead, and the projector has to read that too — otherwise the
		// dirty row this delete leaves behind rebuilds the whole transcript after the archive ran.
		expect(
			await t.query(internal.plugins_projections_chitchat.load_channel_projection, {
				installationId: fixture.installationId,
				channelKey: SCOPE_ID,
			}),
		).toBeNull();
	});

	test("archiving the channel takes the mirrored grants with the folder", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		await set_scope_member(fixture, bob.userId);
		await append_public_message(fixture, SCOPE_ID, "archived content", "archive-1");
		await flush_projection(t);
		const folder = await read_private_folder(t, fixture);
		expect((await read_folder_grants(t, fixture, folder!.node!._id)).length).toBe(2);

		// The Chitchat archive button, which is what "delete channel" does in the plugin UI.
		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: SCOPE_ID,
			value: { name: "war-room", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await flush_projection(t);

		// The folder map row is gone with the archive, and that row is the only way back to these
		// grants. Left behind, nothing could ever remove them: Bob would keep reading the archived
		// copy after being dropped from the channel.
		expect(await read_private_folder(t, fixture)).toBeNull();
		expect(await read_folder_grants(t, fixture, folder!.node!._id)).toEqual([]);
	});

	test("a member's private read cursor does not rebuild the channel file", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "cursor churn", "churn-1");
		await flush_projection(t);

		const advance_channels = async () => {
			const advanced = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				collection: "channels",
				scopeId: SCOPE_ID,
			});
			if (advanced._nay) {
				throw new Error(advanced._nay.message);
			}

			return await t.run(async (ctx) => {
				const rows = await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
					.collect();
				return rows.map((row) => row.channelKey);
			});
		};

		// The plugin keeps each member's read cursor for a private channel in the `channels`
		// collection inside the scope, so a `p/` key never shows up in the public cursor map. The
		// server appends the user id, making the stored key `<channelKey>:read:<userId>`.
		const cursorDoc = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "channels",
			key: `${SCOPE_ID}:read`,
			value: { lastReadAt: Date.now() },
		});
		if (cursorDoc._nay) {
			throw new Error(cursorDoc._nay.message);
		}
		expect(await advance_channels()).toEqual([]);

		// Anchor it: the channel document itself in the same collection still marks the channel dirty.
		// Step the clock first — the fence orders a shared millisecond by creation time, and the
		// channel doc is older than the read cursor written above.
		vi.advanceTimersByTime(5);
		await put_public_channel(fixture, SCOPE_ID, "war-room-renamed");
		expect(await advance_channels()).toEqual([SCOPE_ID]);
	});

	test("a scope change during a rebuild keeps the channel dirty", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		const bob = await join_workspace_member(t, fixture, "chitchat-bob");
		const carol = await join_workspace_member(t, fixture, "chitchat-carol");
		await set_scope_member(fixture, bob.userId);

		// What the sync sees when it picks the channel up.
		const picked = await t.query(internal.plugins_projections_chitchat.peek_dirty_channel, {
			installationId: fixture.installationId,
		});
		expect(picked?.channelKey).toBe(SCOPE_ID);

		// A second membership change lands while the rebuild is in flight. It writes no store
		// document, so this dirty row is the only record of it.
		await set_scope_member(fixture, carol.userId);

		await t.mutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
			installationId: fixture.installationId,
			channelKey: SCOPE_ID,
			updatedAt: picked!.updatedAt,
		});

		const stillDirty = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
				.collect();
			return rows.map((row) => row.channelKey);
		});
		expect(stillDirty).toEqual([SCOPE_ID]);
	});

	test("archiving the channel keeps its scoped cursors", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "archived cursors", "cursor-archive-1");
		await flush_projection(t);
		const before = await read_projection_state(t, fixture.installationId);
		expect(before?.cursors[`${SCOPE_ID}:messages`]).toBeDefined();

		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: SCOPE_ID,
			value: { name: "war-room", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await flush_projection(t);

		// The scope is still alive, so the scoped pass keeps listing it. Dropping the fences here
		// would make the next run re-read the channel's whole history from the start.
		const after = await read_projection_state(t, fixture.installationId);
		expect(after?.cursors[`${SCOPE_ID}:messages`]).toEqual(before?.cursors[`${SCOPE_ID}:messages`]);
	});

	test("a scoped message advances the scoped cursor and dirties only the private channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "public message", "cursor-pub-1");
		await append_public_message(fixture, SCOPE_ID, "private message", "cursor-priv-1");
		await flush_projection(t);

		const cleanState = await read_projection_state(t, fixture.installationId);
		const publicCursor = cleanState?.cursors.messages;
		expect(cleanState?.cursors[`${SCOPE_ID}:messages`]).toBeDefined();

		await append_public_message(fixture, SCOPE_ID, "second private message", "cursor-priv-2");
		const advanced = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
			installationId: fixture.installationId,
			collection: "messages",
			scopeId: SCOPE_ID,
		});
		if (advanced._nay) {
			throw new Error(advanced._nay.message);
		}

		const dirty = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
				.collect();
		});
		expect(dirty.map((row) => row.channelKey)).toEqual([SCOPE_ID]);

		const state = await read_projection_state(t, fixture.installationId);
		expect(state?.cursors[`${SCOPE_ID}:messages`]).not.toEqual(cleanState?.cursors[`${SCOPE_ID}:messages`]);
		expect(state?.cursors.messages).toEqual(publicCursor);
	});
});
