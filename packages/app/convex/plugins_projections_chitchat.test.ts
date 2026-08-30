import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	files_nodes_db_archive_nodes,
	files_nodes_db_cascade_read_only_scope,
	files_nodes_db_cascade_restricted_scope,
	files_nodes_db_create_node_recursively_at_path,
} from "./files_nodes.ts";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
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

async function force_projection_root_lock(
	t: ReturnType<typeof test_convex>,
	rootFolderNodeId: Id<"files_nodes">,
	scopeNodeId: Id<"files_nodes"> | undefined,
) {
	await t.run(async (ctx) => {
		const root = await ctx.db.get("files_nodes", rootFolderNodeId);
		if (!root) {
			throw new Error("Expected projection root");
		}
		await ctx.db.patch("files_nodes", root._id, { readOnlyScopeNodeId: scopeNodeId });
		await files_nodes_db_cascade_read_only_scope(ctx, {
			organizationId: root.organizationId,
			workspaceId: root.workspaceId,
			parentId: root._id,
			scopeNodeId,
		});
	});
}

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

async function seed_plugin_user_write(
	t: ReturnType<typeof test_convex>,
	args: { pluginName: string; clerkUserId?: string },
) {
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
			capabilities: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write", "plugin.service.connect"],
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
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
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
		return { userId, membershipId, clerkUserId } as const;
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

async function read_sync_generation(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
) {
	const state = await read_projection_state(t, installationId);
	if (!state) {
		throw new Error("Expected projection state");
	}
	return state.syncGeneration;
}

async function cancel_projection_job(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
) {
	return await t.run(async (ctx) => {
		const state = await ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.unique();
		if (!state) {
			throw new Error("Expected projection state");
		}
		if (state.scheduledJobId) {
			await ctx.scheduler.cancel(state.scheduledJobId);
			await ctx.db.patch("plugins_data_projection_states", state._id, { scheduledJobId: undefined });
		}
		return state;
	});
}

async function insert_store_messages(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	channelKey: string,
	count: number,
) {
	await t.run(async (ctx) => {
		const baseUpdatedAt = Date.now() - count;
		for (let index = 0; index < count; index += 1) {
			await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "messages",
				key: `${channelKey}:bulk-${String(index).padStart(6, "0")}`,
				value: { text: `message ${index}`, attachments: [], editedAt: null, deletedAt: null },
				byteSize: 96,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: baseUpdatedAt + index,
			});
		}
	});
}

async function put_public_channel(
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	key: string,
	name: string,
) {
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

async function read_projection_mapping(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
	channelKey: string,
) {
	return await t.run(async (ctx) => {
		const row = await ctx.db
			.query("plugins_data_projection_files")
			.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
				q.eq("installationId", installationId).eq("channelKey", channelKey).eq("rolloverIndex", 0),
			)
			.first();
		return row ? { row, node: await ctx.db.get("files_nodes", row.fileNodeId) } : null;
	});
}

async function seed_and_claim_dirty_channel(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	channelKey: string,
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("plugins_data_projection_dirty_channels", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			channelKey,
			queuedAt: now,
			updatedAt: now,
		});
	});
	const claimed = await t.mutation(internal.plugins_projections_chitchat.peek_dirty_channel, {
		installationId: fixture.installationId,
		syncGeneration: await read_sync_generation(t, fixture.installationId),
	});
	if (!claimed) {
		throw new Error("Expected dirty channel claim");
	}
	return claimed;
}

async function stage_public_channel_publish(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_plugin_user_write>>,
	channelKey: string,
) {
	await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
	const state = await cancel_projection_job(t, fixture.installationId);
	const dirty = await t.run(async (ctx) =>
		ctx.db
			.query("plugins_data_projection_dirty_channels")
			.withIndex("by_installation_channelKey", (q) =>
				q.eq("installationId", fixture.installationId).eq("channelKey", channelKey),
			)
			.unique(),
	);
	if (!dirty) {
		throw new Error("Expected channel to be dirty");
	}

	for (let hop = 0; hop < 20; hop += 1) {
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind === "publish") {
			return { state, step } as const;
		}
	}
	throw new Error("Expected channel build to reach publish");
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

	test("an oversized or unsafe author name is bounded before it reaches staged output", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const oversizedName = "n".repeat(900_000);
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", fixture.userId);
			if (!user?.anagraphic) {
				throw new Error("Expected user anagraphic");
			}
			await ctx.db.patch("users_anagraphics", user.anagraphic, { displayName: oversizedName });
		});

		await put_public_channel(fixture, "chan-large-name", "large-name");
		await append_public_message(fixture, "chan-large-name", "small message", "large-name-1");
		await flush_projection(t);

		const file = await read_projection_file(t, fixture, "/chitchat/large-name.md");
		expect(file?.content).toContain(`**${"n".repeat(128)}**`);
		expect(file?.content).not.toContain("n".repeat(129));

		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", fixture.userId);
			if (!user?.anagraphic) {
				throw new Error("Expected user anagraphic");
			}
			await ctx.db.patch("users_anagraphics", user.anagraphic, { displayName: "Mallory\n**Injected**" });
		});
		await append_public_message(fixture, "chan-large-name", "second message", "large-name-2");
		await flush_projection(t);
		const sanitized = await read_projection_file(t, fixture, "/chitchat/large-name.md");
		expect(sanitized?.content).toContain("**Mallory \\*\\*Injected\\*\\***");
		expect(sanitized?.content).not.toContain("\n**Injected**");
	});

	test("one build keeps the first sanitized author label after a profile rename", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-rename", "rename");
		await insert_store_messages(t, fixture, "chan-rename", 21);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-rename"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected rename channel to be dirty");
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				channelKey: dirty.channelKey,
				dirtyUpdatedAt: dirty.updatedAt,
			}),
		).toMatchObject({ kind: "building" });
		const cached = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_chitchat_authors")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.unique(),
		);
		expect(cached?.label).toBe("Alice");
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", fixture.userId);
			if (!user?.anagraphic) {
				throw new Error("Expected user anagraphic");
			}
			await ctx.db.patch("users_anagraphics", user.anagraphic, { displayName: "Bob" });
		});

		let output: string | undefined;
		for (let hop = 0; hop < 20; hop += 1) {
			const next = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				channelKey: dirty.channelKey,
				dirtyUpdatedAt: dirty.updatedAt,
			});
			if (next.kind === "publish") {
				output = next.body === "" ? next.header : `${next.header}\n\n${next.body}`;
				break;
			}
		}
		if (!output) {
			throw new Error("Expected renamed build to reach publish");
		}
		expect(output.match(/\*\*Alice\*\*/g)).toHaveLength(21);
		expect(output).not.toContain("**Bob**");
	});

	test("finalize and cleanup read at most one large staged body", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: { bytesRead: 1_000_000 } });
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-bodies", "bodies");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-bodies"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected bodies channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected a staged publish");
		}
		await t.run(async (ctx) => {
			const first = await ctx.db
				.query("plugins_data_projection_chitchat_files")
				.withIndex("by_build_fileIndex", (q) => q.eq("buildId", step.buildId).eq("fileIndex", 0))
				.unique();
			if (!first) {
				throw new Error("Expected first staged body");
			}
			await ctx.db.patch("plugins_data_projection_chitchat_files", first._id, { body: "a".repeat(400_000) });
			await ctx.db.insert("plugins_data_projection_chitchat_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				buildId: step.buildId,
				fileIndex: 1,
				body: "b".repeat(400_000),
				updatedAt: Date.now(),
			});
			await ctx.db.patch("plugins_data_projection_chitchat_builds", step.buildId, {
				phase: "finalize",
				outputFileIndex: 1,
				publishFileIndex: undefined,
				publishedFiles: [
					{ rolloverIndex: 1, path: "/chitchat/bodies-1.md" },
					{ rolloverIndex: 0, path: "/chitchat/bodies.md" },
				],
			});
		});

		await expect(
			t.query(internal.plugins_projections_chitchat.get_build_finalize, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: step.buildId,
			}),
		).resolves.toMatchObject({ files: [{ rolloverIndex: 1 }, { rolloverIndex: 0 }] });
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_data_projection_chitchat_builds", step.buildId, { phase: "cleanup" });
		});
		await t.mutation(internal.plugins_projections_chitchat.cleanup_cancelled_builds, {
			installationId: fixture.installationId,
			buildId: step.buildId,
		});
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_chitchat_files")
					.withIndex("by_build_fileIndex", (q) => q.eq("buildId", step.buildId))
					.collect(),
			),
		).toHaveLength(1);
		// Model a lost cleanup job. A normal sync must recover this build without a dirty row.
		await t.run(async (ctx) => {
			const dirtyRow = await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-bodies"),
				)
				.unique();
			if (dirtyRow) {
				await ctx.db.delete("plugins_data_projection_dirty_channels", dirtyRow._id);
			}
		});
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		await flush_projection(t);
		expect(await t.run((ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", step.buildId))).toBeNull();
	});

	test("one large-channel scan hop stages only 50 source documents", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-large", "large");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const seeded = await t.run(async (ctx) => {
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique();
			if (!state) {
				throw new Error("Expected projection state");
			}
			if (state.scheduledJobId) {
				await ctx.scheduler.cancel(state.scheduledJobId);
			}

			let lastId: Id<"plugins_data"> | null = null;
			for (let index = 0; index < 120; index += 1) {
				const updatedAt = Date.now() + index;
				lastId = await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `chan-large:message-${String(index).padStart(3, "0")}`,
					value: {
						text: `${String(index).padStart(3, "0")}-${"x".repeat(7900)}`,
						attachments: [],
						editedAt: null,
						deletedAt: null,
					},
					byteSize: 8000,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
			const last = lastId ? await ctx.db.get("plugins_data", lastId) : null;
			if (!last) {
				throw new Error("Expected a last large-channel message");
			}
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors: {
					...state.cursors,
					messages: {
						updatedAt: last.updatedAt,
						lastCreationTime: last._creationTime,
						lastId: last._id,
					},
				},
				scheduledJobId: undefined,
			});
			const dirtyUpdatedAt = Date.now();
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "chan-large",
				queuedAt: dirtyUpdatedAt,
				updatedAt: dirtyUpdatedAt,
			});
			return { syncGeneration: state.syncGeneration, dirtyUpdatedAt };
		});

		const firstHop = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: seeded.syncGeneration,
			channelKey: "chan-large",
			dirtyUpdatedAt: seeded.dirtyUpdatedAt,
		});
		expect(firstHop.kind).toBe("building");
		const bounded = await t.run(async (ctx) => ({
			items: await ctx.db.query("plugins_data_projection_chitchat_items").collect(),
			files: await ctx.db.query("plugins_data_projection_chitchat_files").collect(),
			build: await ctx.db.query("plugins_data_projection_chitchat_builds").unique(),
		}));
		expect(bounded.items).toHaveLength(50);
		expect(bounded.files).toHaveLength(0);
		expect(bounded.build?.phase).toBe("scan_messages");

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: seeded.syncGeneration,
		});
		await flush_projection(t);
		const files = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-large"),
				)
				.collect(),
		);
		expect(files.length).toBeGreaterThan(1);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-large"),
					)
					.first(),
			),
		).toBeNull();
	});

	test("rollover files number the oldest archive first and keep the newest text in the main file", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-order", "order");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-order"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected order channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected order channel to reach publish");
		}

		await t.run(async (ctx) => {
			const main = await ctx.db
				.query("plugins_data_projection_chitchat_files")
				.withIndex("by_build_fileIndex", (q) => q.eq("buildId", step.buildId).eq("fileIndex", 0))
				.unique();
			if (!main) {
				throw new Error("Expected staged main file");
			}
			await ctx.db.patch("plugins_data_projection_chitchat_files", main._id, { body: "newest text" });
			await ctx.db.insert("plugins_data_projection_chitchat_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				buildId: step.buildId,
				fileIndex: 1,
				body: "middle text",
				updatedAt: Date.now(),
			});
			await ctx.db.insert("plugins_data_projection_chitchat_files", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				buildId: step.buildId,
				fileIndex: 2,
				body: "oldest text",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("plugins_data_projection_chitchat_builds", step.buildId, {
				phase: "publish",
				outputFileIndex: 2,
				publishFileIndex: 2,
				publishedFiles: [],
			});
		});

		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		for (let file = 0; file < 3; file += 1) {
			const publish = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				channelKey: dirty.channelKey,
				dirtyUpdatedAt: dirty.updatedAt,
			});
			if (publish.kind !== "publish") {
				throw new Error("Expected staged rollover publish");
			}
			const path =
				publish.rolloverIndex === 0
					? `${root._yay.folderPath}/order.md`
					: `${root._yay.folderPath}/order.${String(publish.rolloverIndex).padStart(3, "0")}.md`;
			const written = await t.action(internal.plugins_projections.write_projection_markdown, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: publish.lifecycleStateId,
				path,
				text:
					publish.rolloverIndex === 0 && publish.body !== ""
						? `${publish.header}\n\n${publish.body}`
						: publish.rolloverIndex === 0
							? publish.header
							: publish.body,
				channelKey: dirty.channelKey,
				rolloverIndex: publish.rolloverIndex,
			});
			if (written._nay || !written._yay) {
				throw new Error(written._nay?.message ?? "Expected rollover write");
			}
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: publish.buildId,
				fileIndex: publish.fileIndex,
				path: written._yay.path,
			});
		}
		const ready = await t.query(internal.plugins_projections_chitchat.get_build_finalize, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			buildId: step.buildId,
		});
		if (!ready) {
			throw new Error("Expected completed rollover publish");
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: ready.lifecycleStateId,
				channelKey: ready.channelKey,
				keepCount: ready.files.length,
				archiveFolder: false,
			}),
		).toBe(true);
		await t.mutation(internal.plugins_projections_chitchat.mark_build_finalized, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			buildId: step.buildId,
		});

		const mapped = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-order"),
				)
				.collect(),
		);
		expect(mapped.map((file) => ({ rolloverIndex: file.rolloverIndex, path: file.path }))).toEqual([
			{ rolloverIndex: 0, path: "/chitchat/order.md" },
			{ rolloverIndex: 1, path: "/chitchat/order.001.md" },
			{ rolloverIndex: 2, path: "/chitchat/order.002.md" },
		]);
		const oldest = await read_projection_file(t, fixture, "/chitchat/order.001.md");
		const middle = await read_projection_file(t, fixture, "/chitchat/order.002.md");
		const newest = await read_projection_file(t, fixture, "/chitchat/order.md");
		expect(oldest?.content).toBe("oldest text");
		expect(middle?.content).toBe("middle text");
		expect(newest?.content).toContain("# order");
		expect(newest?.content).toContain("newest text");
		expect(newest?.content).not.toContain("oldest text");
	});

	test("large rollover cleanup resumes until every plain-text chunk and map is archived", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-trim-large", "trim-large");
		await append_public_message(fixture, "chan-trim-large", "main file", "trim-large-main");
		await flush_projection(t);
		const state = await read_projection_state(t, fixture.installationId);
		if (!state) {
			throw new Error("Expected projection state");
		}

		const extra = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: state._id,
			path: "/chitchat/trim-large.001.md",
			text: "x".repeat(200_000),
			channelKey: "chan-trim-large",
			rolloverIndex: 1,
		});
		if (extra._nay || !extra._yay) {
			throw new Error(extra._nay?.message ?? "Expected large extra rollover");
		}
		const extraNodeId = extra._yay.nodeId;

		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: state._id,
				channelKey: "chan-trim-large",
				keepCount: 1,
				archiveFolder: false,
			}),
		).toBe(false);
		const afterFirstHop = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", extraNodeId),
			map: await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-trim-large").eq("rolloverIndex", 1),
				)
				.unique(),
			chunks: await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("fileNodeId", extraNodeId),
				)
				.collect(),
		}));
		expect(afterFirstHop.node?.archiveOperationId).toBeDefined();
		expect(afterFirstHop.map).not.toBeNull();
		expect(afterFirstHop.chunks.length).toBeGreaterThan(8);
		expect(afterFirstHop.chunks.every((chunk) => chunk.archiveOperationId === undefined)).toBe(true);

		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: state._id,
				channelKey: "chan-trim-large",
				keepCount: 1,
				archiveFolder: false,
			}),
		).toBe(false);
		const afterChunkHop = await t.run(async (ctx) =>
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("fileNodeId", extraNodeId),
				)
				.collect(),
		);
		expect(afterChunkHop.filter((chunk) => chunk.archiveOperationId !== undefined)).toHaveLength(8);
		expect(afterChunkHop.some((chunk) => chunk.archiveOperationId === undefined)).toBe(true);

		let done = false;
		for (let hop = 0; hop < 30 && !done; hop += 1) {
			done = await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: state._id,
				channelKey: "chan-trim-large",
				keepCount: 1,
				archiveFolder: false,
			});
		}
		expect(done).toBe(true);
		const completed = await t.run(async (ctx) => ({
			map: await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-trim-large").eq("rolloverIndex", 1),
				)
				.unique(),
			chunks: await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("fileNodeId", extraNodeId),
				)
				.collect(),
		}));
		expect(completed.map).toBeNull();
		expect(completed.chunks.every((chunk) => chunk.archiveOperationId === afterFirstHop.node?.archiveOperationId)).toBe(
			true,
		);
	});

	test("a same-channel write keeps the active build and is rebuilt after it finishes", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-growing", "growing");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-growing"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected growing channel to be dirty");
		}

		const firstStep = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (firstStep.kind !== "publish") {
			throw new Error("Expected first build to be ready to publish");
		}
		const activeBeforeWrite = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_chitchat_builds")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-growing"),
				)
				.unique(),
		);
		await append_public_message(fixture, "chan-growing", "written during build", "growing-late");
		// Run the zero-delay scheduling seam now instead of waiting for the test timer drain.
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });

		const afterWrite = await read_projection_state(t, fixture.installationId);
		const activeAfterWrite = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_chitchat_builds")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-growing"),
				)
				.unique(),
		);
		expect(afterWrite?.syncGeneration).toBe(state.syncGeneration);
		expect(afterWrite?.scheduledJobId).toBeDefined();
		expect(activeAfterWrite?._id).toBe(activeBeforeWrite?._id);
		if (!activeBeforeWrite) {
			throw new Error("Expected active build");
		}

		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		const written = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: firstStep.lifecycleStateId,
			path: `${root._yay.folderPath}/growing.md`,
			text: firstStep.body === "" ? firstStep.header : `${firstStep.header}\n\n${firstStep.body}`,
			channelKey: "chan-growing",
			rolloverIndex: 0,
		});
		if (written._nay || !written._yay) {
			throw new Error(written._nay?.message ?? "Expected projection write");
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: activeBeforeWrite._id,
				fileIndex: 0,
				path: written._yay.path,
			}),
		).toBe(true);
		const finalize = await t.query(internal.plugins_projections_chitchat.get_build_finalize, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			buildId: activeBeforeWrite._id,
		});
		if (!finalize) {
			throw new Error("Expected build finalization data");
		}
		await t.mutation(internal.plugins_projections.trim_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: finalize.lifecycleStateId,
			channelKey: finalize.channelKey,
			keepCount: finalize.files.length,
		});
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_finalized, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: activeBeforeWrite._id,
			}),
		).toBe(true);
		expect(
			(await t.run((ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", activeBeforeWrite._id)))?.phase,
		).toBe("cleanup");
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-growing"),
					)
					.unique(),
			),
		).not.toBeNull();

		await flush_projection(t);
		expect((await read_projection_file(t, fixture, "/chitchat/growing.md"))?.content).toContain("written during build");
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-growing"),
					)
					.unique(),
			),
		).toBeNull();
	});

	test("a write after the last dirty check replaces the running cleanup sync job", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-finish-race", "finish-race");
		const staged = await stage_public_channel_publish(t, fixture, "chan-finish-race");
		await t.run(async (ctx) => {
			const dirty = await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-finish-race"),
				)
				.unique();
			if (!dirty) {
				throw new Error("Expected staged channel dirty work");
			}

			await ctx.db.delete("plugins_data_projection_dirty_channels", dirty._id);
			await ctx.db.patch("plugins_data_projection_chitchat_builds", staged.step.buildId, { phase: "cleanup" });
			await ctx.db.patch("plugins_data_projection_states", staged.state._id, {
				dirty: false,
				scheduledJobId: undefined,
			});
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			await Promise.all(jobs.filter((job) => job.state.kind === "pending").map((job) => ctx.scheduler.cancel(job._id)));
		});

		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const runningState = await read_projection_state(t, fixture.installationId);
		if (!runningState?.scheduledJobId) {
			throw new Error("Expected cleanup sync job");
		}
		const runningJobId = runningState.scheduledJobId;

		let markUploadStarted: (() => void) | undefined;
		const uploadStarted = new Promise<void>((resolve) => {
			markUploadStarted = resolve;
		});
		let releaseUpload: (() => void) | undefined;
		const uploadReleased = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			markUploadStarted?.();
			await uploadReleased;
			return new Response(null, { status: 200 });
		});

		vi.advanceTimersByTime(2000);
		await uploadStarted;
		try {
			expect(
				(await t.run((ctx) => ctx.db.system.get("_scheduled_functions", runningJobId)))?.state.kind,
			).toBe("inProgress");
			expect(
				await t.query(internal.plugins_projections_chitchat.has_dirty_channel, {
					installationId: fixture.installationId,
				}),
			).toBe(false);

			await append_public_message(
				fixture,
				"chan-finish-race",
				"written after the stale dirty check",
				"finish-race-late",
			);
			// Run the store write's scheduling callback while the old job is still active.
			await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
			const afterWrite = await read_projection_state(t, fixture.installationId);
			expect(afterWrite?.syncGeneration).toBe(runningState.syncGeneration);
			expect(afterWrite?.scheduledJobId).toBe(runningJobId);

			await t.mutation(internal.plugins_projections.finish_sync, {
				installationId: fixture.installationId,
				syncGeneration: runningState.syncGeneration,
				continueImmediately: false,
				continueIfDirty: true,
			});

			const afterFinish = await read_projection_state(t, fixture.installationId);
			if (!afterFinish?.scheduledJobId) {
				throw new Error("Expected replacement cleanup sync job");
			}
			const replacementJobId = afterFinish.scheduledJobId;
			expect(afterFinish?.syncGeneration).toBe(runningState.syncGeneration);
			expect(replacementJobId).not.toBe(runningJobId);
			expect(afterFinish?.dirty).toBe(true);
			expect(
				(await t.run((ctx) => ctx.db.system.get("_scheduled_functions", replacementJobId)))?.state.kind,
			).toBe("pending");
		} finally {
			releaseUpload?.();
			await t.finishInProgressScheduledFunctions();
		}
	});

	test("another dirty channel gets a turn while a large channel is still building", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-large", "large");
		await put_public_channel(fixture, "chan-small", "small");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		await insert_store_messages(t, fixture, "chan-large", 120);

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});

		expect(await read_projection_mapping(t, fixture.installationId, "chan-small")).not.toBeNull();
		expect(await read_projection_mapping(t, fixture.installationId, "chan-large")).toBeNull();
		const largeBuild = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_chitchat_builds")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-large"),
				)
				.unique(),
		);
		expect(largeBuild?.phase).toBe("scan_messages");
	});

	test("a replaced projection lifecycle cannot publish old staged output", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-old", "old");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const oldState = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-old"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected old channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected a staged publish");
		}
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		await t.run(async (ctx) => {
			const stagedFile = await ctx.db
				.query("plugins_data_projection_chitchat_files")
				.withIndex("by_build_fileIndex", (q) => q.eq("buildId", step.buildId).eq("fileIndex", 0))
				.unique();
			if (!stagedFile) {
				throw new Error("Expected staged file");
			}
			await ctx.db.patch("plugins_data_projection_chitchat_files", stagedFile._id, {
				body: "old lifecycle output",
			});
			await ctx.db.delete("plugins_data_projection_states", oldState._id);
			await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				writerUserId: fixture.userId,
				cursors: {},
				scanCursors: {},
				syncGeneration: oldState.syncGeneration,
				dirty: true,
				rootFolderNodeId: root._yay.folderNodeId,
				updatedAt: Date.now(),
			});
		});
		const refused = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			expectedProjectionStateId: step.lifecycleStateId,
			path: `${root._yay.folderPath}/old.md`,
			text: "old lifecycle output",
			channelKey: "chan-old",
			rolloverIndex: 0,
		});
		expect(refused._nay?.message).toBe("Projection sync was superseded");

		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: oldState.syncGeneration,
				buildId: step.buildId,
				fileIndex: 0,
				path: "/chitchat/old.md",
			}),
		).toBe(false);
		const staleAdvance = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		expect(staleAdvance.kind).not.toBe("publish");
		expect(await read_projection_mapping(t, fixture.installationId, "chan-old")).toBeNull();
	});

	test("a projection lifecycle replaced during finalization cannot trim files or finish the old build", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-finalize", "finalize");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const oldState = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-finalize"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected finalize channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected a staged publish");
		}
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		for (const [rolloverIndex, path] of [
			[0, `${root._yay.folderPath}/finalize.md`],
			[1, `${root._yay.folderPath}/finalize-old.md`],
		] as const) {
			const written = await t.action(internal.plugins_projections.write_projection_markdown, {
				installationId: fixture.installationId,
				syncGeneration: oldState.syncGeneration,
				expectedProjectionStateId: step.lifecycleStateId,
				path,
				text: rolloverIndex === 0 ? step.header : "old extra file",
				channelKey: "chan-finalize",
				rolloverIndex,
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: oldState.syncGeneration,
				buildId: step.buildId,
				fileIndex: 0,
				path: `${root._yay.folderPath}/finalize.md`,
			}),
		).toBe(true);
		const ready = await t.query(internal.plugins_projections_chitchat.get_build_finalize, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			buildId: step.buildId,
		});
		if (!ready) {
			throw new Error("Expected finalization data");
		}

		await t.run(async (ctx) => {
			await ctx.db.delete("plugins_data_projection_states", oldState._id);
			await ctx.db.insert("plugins_data_projection_states", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				writerUserId: fixture.userId,
				cursors: {},
				scanCursors: {},
				syncGeneration: oldState.syncGeneration,
				dirty: true,
				rootFolderNodeId: root._yay.folderNodeId,
				updatedAt: Date.now(),
			});
		});
		const staleAdvance = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		expect(staleAdvance.kind).toBe("building");
		await t.mutation(internal.plugins_projections.trim_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: oldState.syncGeneration,
			expectedProjectionStateId: ready.lifecycleStateId,
			channelKey: ready.channelKey,
			keepCount: ready.files.length,
		});
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_finalized, {
				installationId: fixture.installationId,
				syncGeneration: oldState.syncGeneration,
				buildId: step.buildId,
			}),
		).toBe(false);
		const after = await t.run(async (ctx) => ({
			build: await ctx.db.get("plugins_data_projection_chitchat_builds", step.buildId),
			dirty: await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-finalize"),
				)
				.unique(),
			extra: await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-finalize").eq("rolloverIndex", 1),
				)
				.unique(),
		}));
		expect(after.build?.phase).toBe("finalize");
		expect(after.dirty).not.toBeNull();
		expect(after.extra).not.toBeNull();
	});

	test("an archived channel cancels its active publish build", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-archived-build", "archived-build");
		await append_public_message(fixture, "chan-archived-build", "must not publish", "archived-build-1");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-archived-build"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected archived channel to be dirty");
		}
		const publish = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (publish.kind !== "publish") {
			throw new Error("Expected an active publish build");
		}

		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "chan-archived-build",
			value: { name: "archived-build", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const current = await read_projection_state(t, fixture.installationId);
		if (!current) {
			throw new Error("Expected current projection state");
		}
		expect(
			await t.query(internal.plugins_projections_chitchat.get_build_slug_resolution, {
				installationId: fixture.installationId,
				syncGeneration: current.syncGeneration,
				expectedProjectionStateId: current._id,
				buildId: publish.buildId,
			}),
		).toBeNull();
		const currentDirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-archived-build"),
				)
				.unique(),
		);
		if (!currentDirty) {
			throw new Error("Expected archived channel to stay dirty");
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: current.syncGeneration,
				channelKey: currentDirty.channelKey,
				dirtyUpdatedAt: currentDirty.updatedAt,
			}),
		).toMatchObject({ kind: "archive" });
		expect(await read_projection_mapping(t, fixture.installationId, "chan-archived-build")).toBeNull();
	});

	test("an unarchived channel cancels its active archive build before file cleanup", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-unarchived-build", "archived-build");
		await append_public_message(fixture, "chan-unarchived-build", "keep this projection", "unarchive-build-1");
		await flush_projection(t);
		const original = await read_projection_mapping(t, fixture.installationId, "chan-unarchived-build");
		if (!original?.node) {
			throw new Error("Expected the original projected file");
		}

		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "chan-unarchived-build",
			value: { name: "archived-build", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const state = await read_projection_state(t, fixture.installationId);
		const archiveDirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-unarchived-build"),
				)
				.unique(),
		);
		if (!state || !archiveDirty) {
			throw new Error("Expected the archived channel to be dirty");
		}
		const archiveStep = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: archiveDirty.channelKey,
			dirtyUpdatedAt: archiveDirty.updatedAt,
		});
		if (archiveStep.kind !== "archive") {
			throw new Error("Expected an active archive build");
		}

		const restored = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "chan-unarchived-build",
			value: { name: "restored-build", archivedAt: null },
		});
		if (restored._nay) {
			throw new Error(restored._nay.message);
		}
		const restoredDirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-unarchived-build"),
				)
				.unique(),
		);
		if (!restoredDirty) {
			throw new Error("Expected the restored channel to stay dirty");
		}
		expect(restoredDirty.updatedAt).toBeGreaterThan(archiveDirty.updatedAt);

		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: archiveStep.lifecycleStateId,
				channelKey: restoredDirty.channelKey,
				keepCount: 0,
				archiveFolder: true,
			}),
		).toBe(false);
		const preserved = await read_projection_mapping(t, fixture.installationId, "chan-unarchived-build");
		expect(preserved?.node?._id).toBe(original.node._id);
		expect(preserved?.node?.archiveOperationId).toBeUndefined();

		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				channelKey: restoredDirty.channelKey,
				dirtyUpdatedAt: restoredDirty.updatedAt,
			}),
		).toEqual({ kind: "done" });
		const cancelled = await t.run(async (ctx) => ({
			build: await ctx.db.get("plugins_data_projection_chitchat_builds", archiveStep.buildId),
			dirty: await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-unarchived-build"),
				)
				.unique(),
		}));
		expect(cancelled.build).toBeNull();
		expect(cancelled.dirty?._id).toBe(restoredDirty._id);

		await flush_projection(t);
		const rebuilt = await read_projection_mapping(t, fixture.installationId, "chan-unarchived-build");
		expect(rebuilt?.node?.archiveOperationId).toBeUndefined();
		expect((await read_projection_file(t, fixture, rebuilt!.row.path))?.content).toContain("# restored-build");
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-unarchived-build"),
					)
					.unique(),
			),
		).toBeNull();
	});

	test("an archived channel hides its projection before draining a large active build", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-large-archive", "large-archive");
		await append_public_message(fixture, "chan-large-archive", "published before rebuild", "large-archive-1");
		await flush_projection(t);
		expect(await read_projection_file(t, fixture, "/chitchat/large-archive.md")).not.toBeNull();

		await insert_store_messages(t, fixture, "chan-large-archive", 100);
		const dirty = await seed_and_claim_dirty_channel(t, fixture, "chan-large-archive");
		const state = await read_projection_state(t, fixture.installationId);
		if (!state) {
			throw new Error("Expected current projection state");
		}
		for (let hop = 0; hop < 2; hop += 1) {
			expect(
				await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
					installationId: fixture.installationId,
					syncGeneration: state.syncGeneration,
					channelKey: dirty.channelKey,
					dirtyUpdatedAt: dirty.updatedAt,
				}),
			).toEqual({ kind: "building" });
		}
		const stagedBeforeArchive = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_chitchat_items")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect(),
		);
		expect(stagedBeforeArchive.length).toBeGreaterThan(50);

		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "chan-large-archive",
			value: { name: "large-archive", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const currentDirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-large-archive"),
				)
				.unique(),
		);
		if (!currentDirty) {
			throw new Error("Expected archived channel to stay dirty");
		}
		const archiveStep = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: currentDirty.channelKey,
			dirtyUpdatedAt: currentDirty.updatedAt,
		});
		if (archiveStep.kind !== "archive") {
			throw new Error("Expected the active build to archive before staged cleanup");
		}

		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_file_cleanup, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				expectedProjectionStateId: archiveStep.lifecycleStateId,
				channelKey: currentDirty.channelKey,
				keepCount: 0,
				archiveFolder: true,
			}),
		).toBe(false);
		const afterFirstArchiveHop = await t.run(async (ctx) => ({
			mapping: await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q
						.eq("installationId", fixture.installationId)
						.eq("channelKey", "chan-large-archive")
						.eq("rolloverIndex", 0),
				)
				.unique(),
			staged: await ctx.db
				.query("plugins_data_projection_chitchat_items")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect(),
		}));
		expect(afterFirstArchiveHop.mapping).not.toBeNull();
		expect(await read_projection_file(t, fixture, "/chitchat/large-archive.md")).toBeNull();
		expect(afterFirstArchiveHop.staged).toHaveLength(stagedBeforeArchive.length);
	});

	test("an archive between slug resolution and file creation refuses the stale publish", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-create-race", "create-race");
		await append_public_message(fixture, "chan-create-race", "must not publish", "create-race-1");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-create-race"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected create-race channel to be dirty");
		}
		const publish = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (publish.kind !== "publish") {
			throw new Error("Expected a staged public publish");
		}
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		if (root._nay) {
			throw new Error(root._nay.message);
		}
		const resolution = await t.query(internal.plugins_projections_chitchat.get_build_slug_resolution, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: publish.lifecycleStateId,
			buildId: publish.buildId,
		});
		if (!resolution) {
			throw new Error("Expected a live slug resolution");
		}
		const path = `/chitchat/${resolution.slug}.md`;

		vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
				collection: "channels",
				key: "chan-create-race",
				value: { name: "create-race", archivedAt: Date.now() },
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
			return new Response(null, { status: 200 });
		});
		const written = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: publish.lifecycleStateId,
			path,
			text: publish.header,
			channelKey: "chan-create-race",
			rolloverIndex: publish.rolloverIndex,
		});
		expect(written._nay?.message).toBe("Projection source is no longer live");
		expect(await read_projection_mapping(t, fixture.installationId, "chan-create-race")).toBeNull();
		expect(await read_projection_file(t, fixture, path)).toBeNull();
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: publish.buildId,
				fileIndex: publish.fileIndex,
				path,
			}),
		).toBe(false);
		const build = await t.run(async (ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", publish.buildId));
		expect(build?.publishedFiles).toEqual([]);
	});

	test("a publish retry reuses the same file asset and then finishes once", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-retry", "retry");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-retry"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected retry channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected a staged publish");
		}
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		if (root._nay) {
			throw new Error(root._nay.message);
		}
		const firstWrite = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: step.lifecycleStateId,
			path: "/chitchat/retry.md",
			text: step.header,
			channelKey: "chan-retry",
			rolloverIndex: 0,
		});
		if (firstWrite._nay) {
			throw new Error(firstWrite._nay.message);
		}
		const beforeRetry = await read_projection_mapping(t, fixture.installationId, "chan-retry");

		const secondWrite = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: step.lifecycleStateId,
			path: "/chitchat/retry.md",
			text: step.header,
			channelKey: "chan-retry",
			rolloverIndex: 0,
		});
		if (secondWrite._nay) {
			throw new Error(secondWrite._nay.message);
		}
		const afterRetry = await read_projection_mapping(t, fixture.installationId, "chan-retry");
		expect(afterRetry?.node?.assetId).toBe(beforeRetry?.node?.assetId);
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: step.buildId,
				fileIndex: 0,
				path: "/chitchat/retry.md",
			}),
		).toBe(true);
		const finalize = await t.query(internal.plugins_projections_chitchat.get_build_finalize, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			buildId: step.buildId,
		});
		if (!finalize) {
			throw new Error("Expected retry finalization data");
		}
		await t.mutation(internal.plugins_projections.trim_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: finalize.lifecycleStateId,
			channelKey: finalize.channelKey,
			keepCount: finalize.files.length,
		});
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_finalized, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: step.buildId,
			}),
		).toBe(true);
		const completed = await t.run(async (ctx) => ({
			build: await ctx.db.get("plugins_data_projection_chitchat_builds", step.buildId),
			dirty: await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-retry"),
				)
				.unique(),
		}));
		// Finalization changes both rows in one mutation, before scheduled staging cleanup runs.
		expect(completed.build?.phase).toBe("cleanup");
		expect(completed.dirty).toBeNull();
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: step.buildId,
				fileIndex: 0,
				path: "/chitchat/retry.md",
			}),
		).toBe(false);
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
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: Date.now(),
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
					q.eq("installationId", fixture.installationId).eq("collection", "messages").eq("scopeId", undefined),
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

	test("the tie escape does not rewind the merged cursor on call four", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 251; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `chan-${String(index).padStart(3, "0")}:message`,
					value: {},
					byteSize: 2,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});
		const ordered = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_updatedAt", (q) =>
					q.eq("installationId", fixture.installationId).eq("collection", "messages"),
				)
				.order("asc")
				.collect(),
		);

		const fences: Array<string | undefined> = [];
		for (let call = 0; call < 4; call += 1) {
			const advanced = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: updatedAt,
				pageSize: 100,
			});
			expect(advanced._nay).toBeUndefined();
			fences.push((await read_projection_state(t, fixture.installationId))?.cursors.messages?.lastId);
		}
		expect(fences[3]).toBe(ordered[250]?._id);
		expect(fences[3]).toBe(fences[2]);
	});

	test("a merged change scan excludes rows written after its run fence", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const runStartMs = Date.now();
		const ids = await t.run(async (ctx) => {
			const current = await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "messages",
				key: "current:message",
				value: {},
				byteSize: 2,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: runStartMs,
			});
			const future = await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "messages",
				key: "future:message",
				value: {},
				byteSize: 2,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: runStartMs + 1,
			});
			return { current, future };
		});

		await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			collection: "messages",
			runStartMs,
		});
		expect((await read_projection_state(t, fixture.installationId))?.cursors.messages?.lastId).toBe(ids.current);
		await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			collection: "messages",
			runStartMs: runStartMs + 1,
		});
		expect((await read_projection_state(t, fixture.installationId))?.cursors.messages?.lastId).toBe(ids.future);
	});

	test("the tie escape reaches exhaustion without losing the 604th document", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 604; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `chan-${String(index).padStart(3, "0")}:message`,
					value: {},
					byteSize: 2,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});
		const lastId = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("plugins_data")
						.withIndex("by_installation_collection_updatedAt", (q) =>
							q.eq("installationId", fixture.installationId).eq("collection", "messages"),
						)
						.order("asc")
						.collect()
				).at(-1)?._id,
		);
		let truncated = true;
		for (let call = 0; call < 10; call += 1) {
			const result = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: updatedAt,
				pageSize: 100,
			});
			if (result._yay?.truncated === false) {
				truncated = false;
				break;
			}
		}
		expect(truncated).toBe(false);
		expect((await read_projection_state(t, fixture.installationId))?.cursors.messages?.lastId).toBe(lastId);
	});

	test("the seventh 700-row tie page reaches the opaque page cursor's end", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 700; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `seven-${String(index).padStart(3, "0")}:message`,
					value: {},
					byteSize: 2,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});
		let seventhTruncated = false;
		for (let call = 1; call <= 7; call += 1) {
			const result = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: updatedAt,
				pageSize: 100,
			});
			if (call === 7) {
				seventhTruncated = result._yay?.truncated ?? false;
			}
		}
		expect(seventhTruncated).toBe(false);
	});

	test("a later timestamp is reached after a 700-row applied tie", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const tiedUpdatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 700; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `large-tie-${String(index).padStart(3, "0")}:message`,
					value: {},
					byteSize: 2,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: tiedUpdatedAt,
				});
			}
		});

		for (let call = 0; call < 7; call += 1) {
			await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: tiedUpdatedAt,
				pageSize: 100,
			});
		}

		const laterId = await t.run(async (ctx) =>
			ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "chitchat",
				collection: "messages",
				key: "later:message",
				value: {},
				byteSize: 2,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: tiedUpdatedAt + 1,
			}),
		);
		let truncated = true;
		for (let call = 0; call < 12 && truncated; call += 1) {
			const result = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: tiedUpdatedAt + 1,
				pageSize: 100,
			});
			truncated = result._yay?.truncated ?? false;
		}

		expect(truncated).toBe(false);
		expect((await read_projection_state(t, fixture.installationId))?.cursors.messages?.lastId).toBe(laterId);
	});

	test("one sync hop caps a growing feed and leaves the hourly backstop dirty", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const baseUpdatedAt = Date.now() - 3000;
		await t.run(async (ctx) => {
			for (let index = 0; index < 2501; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `missing:message-${String(index).padStart(4, "0")}`,
					value: {},
					byteSize: 2,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: baseUpdatedAt + index,
				});
			}
		});
		const before = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: before!.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		const dirtyChannels = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(dirtyChannels).toEqual([]);
		expect(after?.scheduledJobId).toBeDefined();
		expect(after?.dirty).toBe(true);
		expect(after?.cursors.messages?.updatedAt).toBe(baseUpdatedAt + 2499);
	});

	test("one opaque change-feed page stays inside the read ceiling", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: { bytesRead: 1_200_000 } });
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 1208; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "messages",
					key: `ceiling-${String(index).padStart(4, "0")}:message`,
					value: { payload: "x".repeat(1000) },
					byteSize: 1014,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});
		await t.run(async (ctx) => {
			const ordered = await ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_updatedAt", (q) =>
					q.eq("installationId", fixture.installationId).eq("collection", "messages"),
				)
				.order("asc")
				.take(151);
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_projection_states", state!._id, {
				cursors: {
					messages: {
						updatedAt,
						lastCreationTime: ordered[150]!._creationTime,
						lastId: ordered[150]!._id,
					},
				},
			});
		});

		await expect(
			t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "messages",
				runStartMs: updatedAt,
				pageSize: 100,
			}),
		).resolves.toMatchObject({ _yay: { truncated: true } });
	});

	test("replaces a completed stored job with a new projection generation", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const scheduled = await read_projection_state(t, fixture.installationId);
		if (!scheduled?.scheduledJobId) {
			throw new Error("Expected a scheduled projection job");
		}
		const completedJobId = scheduled.scheduledJobId;
		await flush_projection(t);
		expect((await t.run((ctx) => ctx.db.system.get("_scheduled_functions", completedJobId)))?.state.kind).toBe(
			"success",
		);

		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_projection_states", state!._id, {
				dirty: true,
				scheduledJobId: completedJobId,
			});
		});

		await expect(
			t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId }),
		).resolves.toBeNull();
		const replaced = await read_projection_state(t, fixture.installationId);
		expect(replaced?.syncGeneration).toBe(scheduled.syncGeneration + 1);
		expect(replaced?.scheduledJobId).toBeDefined();
		expect(replaced?.scheduledJobId).not.toBe(completedJobId);
	});

	test("a stale retry request cannot replace the current projection job", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const oldGeneration = await read_sync_generation(t, fixture.installationId);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const current = await read_projection_state(t, fixture.installationId);

		await t.mutation(internal.plugins_projections.schedule_sync, {
			installationId: fixture.installationId,
			expectedSyncGeneration: oldGeneration,
		});
		expect(await read_projection_state(t, fixture.installationId)).toMatchObject({
			syncGeneration: current!.syncGeneration,
			scheduledJobId: current!.scheduledJobId,
		});
	});

	test("a stale projection finalizer cannot overwrite newer file content", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "old source text", "generation-old");
		await flush_projection(t);
		const staleGeneration = await read_sync_generation(t, fixture.installationId);

		await append_public_message(fixture, "chan-general", "new source text", "generation-new");
		await flush_projection(t);
		const current = await read_projection_mapping(t, fixture.installationId, "chan-general");
		if (!current?.node?.assetId) {
			throw new Error("Expected the current projected file");
		}

		const staleText = "stale action output";
		const refused = await t.mutation(internal.plugins_projections.finalize_projection_replace, {
			installationId: fixture.installationId,
			syncGeneration: staleGeneration,
			nodeId: current.node._id,
			text: staleText,
			textSize: new TextEncoder().encode(staleText).byteLength,
			baseAssetId: current.node.assetId,
			versionSnapshotAssetId: current.node.assetId,
		});
		expect(refused._nay?.message).toBe("Projection sync was superseded");
		expect((await read_projection_file(t, fixture, current.row.path))?.content).toContain("new source text");
		expect((await read_projection_file(t, fixture, current.row.path))?.content).not.toContain(staleText);
	});

	test.each(["create", "replace"] as const)(
		"a stale action-level projection %s hands its uploaded asset to the deletion ledger",
		async (mode) => {
			vi.useFakeTimers();
			const t = test_convex();
			const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
			await put_public_channel(fixture, "chan-general", "general");
			await append_public_message(fixture, "chan-general", "current source", `cleanup-${mode}`);
			await flush_projection(t);
			const current = await read_projection_mapping(t, fixture.installationId, "chan-general");
			if (!current?.node?.assetId) {
				throw new Error("Expected current projected file");
			}

			await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
			const scheduled = await read_projection_state(t, fixture.installationId);
			vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
				await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
				return new Response(null, { status: 200 });
			});
			const refused = await t.action(internal.plugins_projections.write_projection_markdown, {
				installationId: fixture.installationId,
				syncGeneration: scheduled!.syncGeneration,
				path: mode === "replace" ? current.row.path : "/chitchat/cleanup-create.md",
				text: `stale ${mode} output`,
				channelKey: mode === "replace" ? "chan-general" : "cleanup-create",
				rolloverIndex: 0,
			});
			expect(refused._nay?.message).toBe("Projection sync was superseded");

			const cleanup = await t.run(async (ctx) => ({
				jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				createdMap: await ctx.db
					.query("plugins_data_projection_files")
					.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "cleanup-create"),
					)
					.first(),
			}));
			expect(cleanup.jobs.map((job) => job.reason)).toEqual(["failed_create"]);
			expect(cleanup.assets.some((asset) => cleanup.jobs[0]?.r2Key.endsWith(asset._id))).toBe(false);
			if (mode === "create") {
				expect(cleanup.createdMap).toBeNull();
			} else {
				expect((await read_projection_mapping(t, fixture.installationId, "chan-general"))?.node?.assetId).toBe(
					current.node.assetId,
				);
			}
		},
	);

	test("a delayed stale archive cannot remove a rebuilt channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "first generation", "archive-old");
		await flush_projection(t);
		const staleGeneration = await read_sync_generation(t, fixture.installationId);

		await append_public_message(fixture, "chan-general", "rebuilt generation", "archive-new");
		await flush_projection(t);
		await t.mutation(internal.plugins_projections.archive_projection_channel, {
			installationId: fixture.installationId,
			syncGeneration: staleGeneration,
			channelKey: "chan-general",
		});

		const current = await read_projection_mapping(t, fixture.installationId, "chan-general");
		expect(current?.node?.archiveOperationId).toBeUndefined();
		expect((await read_projection_file(t, fixture, current!.row.path))?.content).toContain("rebuilt generation");
	});

	test("a queued channel archive cannot change the frozen snapshot after uninstall", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "frozen after uninstall", "archive-uninstall");
		await flush_projection(t);
		const syncGeneration = await read_sync_generation(t, fixture.installationId);

		await t.run(async (ctx) => {
			await ctx.db.delete("plugins_workspace_installations", fixture.installationId);
		});
		await t.mutation(internal.plugins_projections.archive_projection_channel, {
			installationId: fixture.installationId,
			syncGeneration,
			channelKey: "chan-general",
		});

		const frozen = await read_projection_mapping(t, fixture.installationId, "chan-general");
		expect(frozen?.node?.archiveOperationId).toBeUndefined();
		expect((await read_projection_file(t, fixture, frozen!.row.path))?.content).toContain("frozen after uninstall");
	});

	test("a new generation drains dead mappings found before a paged reconcile was superseded", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: { functionsScheduled: 250 } });
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique();
			if (state?.scheduledJobId) {
				await ctx.scheduler.cancel(state.scheduledJobId);
				await ctx.db.patch("plugins_data_projection_states", state._id, {
					scheduledJobId: undefined,
					dirty: false,
				});
			}
		});
		const holder = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/reconcile-generation-holder.md",
			textContent: "holder",
		});
		if (holder._nay) {
			throw new Error(holder._nay.message);
		}
		await t.run(async (ctx) => {
			for (let index = 0; index < 201; index += 1) {
				const channelKey = `dead-generation-${String(index).padStart(3, "0")}`;
				await ctx.db.insert("plugins_data_projection_files", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey,
					fileNodeId: holder._yay.nodeId,
					rolloverIndex: 0,
					path: `/chitchat/${channelKey}.md`,
					updatedAt: Date.now(),
				});
			}
		});

		const staleGeneration = await read_sync_generation(t, fixture.installationId);
		expect(
			await t.mutation(internal.plugins_projections_chitchat.reconcile_channels, {
				installationId: fixture.installationId,
				syncGeneration: staleGeneration,
			}),
		).toBe(true);
		expect((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey).toBe(
			"dead-generation-199",
		);

		// Supersede the generation before the old reconcile work can archive any file.
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		await flush_projection(t);

		const remaining = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) => q.eq("installationId", fixture.installationId))
				.collect();
		});
		expect(remaining.map((row) => row.channelKey)).toEqual(["__readme__"]);
	});

	test("a physical channel delete behind the reconcile cursor restarts the sweep", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const target = await put_public_channel(fixture, "alive-000", "alive-000");
		await flush_projection(t);
		const holder = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/reconcile-delete-holder.md",
			textContent: "holder",
		});
		if (holder._nay) {
			throw new Error(holder._nay.message);
		}
		await t.run(async (ctx) => {
			const updatedAt = Date.now();
			let lastChannelDoc: Doc<"plugins_data"> | null = null;
			for (let index = 1; index <= 200; index += 1) {
				const channelKey = `alive-${String(index).padStart(3, "0")}`;
				const channelDocId = await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "channels",
					key: channelKey,
					value: { name: channelKey, archivedAt: null },
					byteSize: 39,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
				lastChannelDoc = await ctx.db.get("plugins_data", channelDocId);
				await ctx.db.insert("plugins_data_projection_files", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey,
					fileNodeId: holder._yay.nodeId,
					rolloverIndex: 0,
					path: `/chitchat/${channelKey}.md`,
					updatedAt,
				});
			}

			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique();
			if (!state || !lastChannelDoc) {
				throw new Error("Expected projection state and seeded channel");
			}
			await ctx.db.patch("plugins_data_projection_states", state._id, {
				cursors: {
					...state.cursors,
					channels: {
						updatedAt: lastChannelDoc.updatedAt,
						lastCreationTime: lastChannelDoc._creationTime,
						lastId: lastChannelDoc._id,
					},
				},
			});
		});

		expect(
			await t.mutation(internal.plugins_projections_chitchat.reconcile_channels, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
			}),
		).toBe(true);
		expect((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey).toBe("alive-198");

		const deleted = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "channels",
			key: "alive-000",
			expectedRevision: target.revision,
		});
		expect(deleted._nay).toBeUndefined();
		expect(deleted._yay?.deleted).toBe(true);
		await flush_projection(t);

		expect(await read_projection_mapping(t, fixture.installationId, "alive-000")).toBeNull();
	});

	test("reconcile resumes after 200 distinct mapped keys", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: { functionsScheduled: 200 } });
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique();
			if (state?.scheduledJobId) {
				await ctx.scheduler.cancel(state.scheduledJobId);
				await ctx.db.patch("plugins_data_projection_states", state._id, { scheduledJobId: undefined, dirty: false });
			}
		});
		const holder = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/reconcile-holder.md",
			textContent: "holder",
		});
		if (holder._nay) {
			throw new Error(holder._nay.message);
		}
		await t.run(async (ctx) => {
			for (let index = 0; index < 201; index += 1) {
				await ctx.db.insert("plugins_data_projection_files", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey: `dead-${String(index).padStart(3, "0")}`,
					fileNodeId: holder._yay.nodeId,
					rolloverIndex: 0,
					path: `/chitchat/dead-${String(index).padStart(3, "0")}.md`,
					updatedAt: Date.now(),
				});
			}
		});

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
		});
		expect((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey).toBe("dead-198");
		// The real sync schedules its own next hop. No plugin write is needed to reach key 201.
		await flush_projection(t);
		expect((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey).toBeUndefined();
		const afterSecondPage = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_files")
					.withIndex("by_installation_channelKey_rolloverIndex", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(afterSecondPage.map((row) => row.channelKey)).toEqual(["__readme__"]);
	});

	test("one sync hop processes the first three equal-time channels in FIFO order", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const channelKey of ["first", "second", "third", "fourth", "fifth"]) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "chitchat",
					collection: "channels",
					key: channelKey,
					value: { name: channelKey, archivedAt: null },
					byteSize: 39,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
				await ctx.db.insert("plugins_data_projection_dirty_channels", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey,
					queuedAt: now,
					updatedAt: now,
				});
			}
		});

		const state = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: state!.syncGeneration,
		});

		const result = await t.run(async (ctx) => {
			const mapped = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) => q.eq("installationId", fixture.installationId))
				.collect();
			const dirty = await ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_queuedAt", (q) => q.eq("installationId", fixture.installationId))
				.collect();
			return {
				mapped: mapped.filter((row) => row.channelKey !== "__readme__").map((row) => row.channelKey),
				dirty: dirty.map((row) => row.channelKey),
			};
		});
		expect(result.mapped).toEqual(["first", "second", "third"]);
		expect(result.dirty).toEqual(["fourth", "fifth"]);
	});

	test("a failed queue head moves behind healthy work in the next generation", async () => {
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

		for (const path of ["/chitchat/bad.md", `/chitchat/${collision_slug("bad", "bad-channel")}.md`]) {
			const occupant = await t.action(internal.files_nodes_content.create_file_by_path, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				path,
				textContent: "user owned file",
			});
			if (occupant._nay) {
				throw new Error(occupant._nay.message);
			}
		}
		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: folder._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		await t.run(async (ctx) => {
			// Model a frozen projection root while keeping both occupied children member-owned.
			await ctx.db.patch("files_nodes", folder._yay.nodeId, { projectionPluginName: "chitchat" });
		});

		// Keep both rows at the same clock time. Their insert order makes the bad row the head.
		await put_public_channel(fixture, "bad-channel", "bad");
		await put_public_channel(fixture, "healthy-channel", "healthy");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const firstState = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: firstState!.syncGeneration,
		});

		const afterFailure = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_queuedAt", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(afterFailure.map((row) => row.channelKey)).toEqual(["healthy-channel", "bad-channel"]);
		if (afterFailure[0]?.queuedAt === undefined || afterFailure[1]?.queuedAt === undefined) {
			throw new Error("Expected both claimed queue rows to have FIFO stamps");
		}
		expect(afterFailure[1].queuedAt).toBeGreaterThan(afterFailure[0].queuedAt);

		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const secondState = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: secondState!.syncGeneration,
		});

		expect(await read_projection_mapping(t, fixture.installationId, "healthy-channel")).not.toBeNull();
		expect(await read_projection_mapping(t, fixture.installationId, "bad-channel")).toBeNull();
		const remaining = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(remaining.map((row) => row.channelKey)).toEqual(["bad-channel"]);
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
		const afterEditMap = await read_projection_mapping(t, fixture.installationId, "chan-general");
		expect(afterEditMap?.row.contentHash).toBe(await crypto_sha256_hex(afterEdit!.content));
		expect(afterEditMap?.row.contentAssetId).toBe(afterEditMap?.node?.assetId);

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

	test("an unchanged Chitchat file keeps its current asset", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "stable text", "stable-1");
		await flush_projection(t);
		const before = await read_projection_mapping(t, fixture.installationId, "chan-general");

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "chan-general",
				queuedAt: now,
				updatedAt: now,
			});
		});
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: state!.syncGeneration,
		});

		const after = await read_projection_mapping(t, fixture.installationId, "chan-general");
		expect(after?.node?.assetId).toBe(before?.node?.assetId);
		expect(after?.row.contentAssetId).toBe(after?.node?.assetId);
	});

	test("a same-hash file edit still rebuilds when its asset binding changed", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "store text", "asset-bound-1");
		await flush_projection(t);

		const projected = await read_projection_file(t, fixture, "/chitchat/general.md");
		const before = await read_projection_mapping(t, fixture.installationId, "chan-general");
		const state = await read_projection_state(t, fixture.installationId);
		if (!projected || !before?.node?.assetId || !state?.rootFolderNodeId) {
			throw new Error("Expected a mapped Chitchat file and root");
		}

		const refusedUnlock = await fixture.asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: fixture.membershipId,
			nodeId: state.rootFolderNodeId,
		});
		expect(refusedUnlock._nay?.message).toBe("This item is managed by a plugin.");
		const refusedNestedLock = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: before.node._id,
		});
		expect(refusedNestedLock._nay?.message).toBe("This item is managed by a plugin.");

		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: fixture.membershipId,
			nodeId: before.node._id,
			text: "member changed the derived file",
			baseAssetId: before.node.assetId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		const editedAssetId = saved._yay.assetId;
		await force_projection_root_lock(t, state.rootFolderNodeId, state.rootFolderNodeId);

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "chan-general",
				queuedAt: now,
				updatedAt: now,
			});
		});
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const dirtyState = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: dirtyState!.syncGeneration,
		});

		const rebuilt = await read_projection_file(t, fixture, "/chitchat/general.md");
		const after = await read_projection_mapping(t, fixture.installationId, "chan-general");
		expect(rebuilt?.content).toBe(projected.content);
		expect(after?.node?.assetId).not.toBe(editedAssetId);
		expect(after?.row.contentAssetId).toBe(after?.node?.assetId);
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

		const pageSession = await seed_page_session(t, fixture);
		const reinstalled = { ...fixture, ...pageSession };
		await put_public_channel(reinstalled, "chan-general", "general");
		await append_public_message(reinstalled, "chan-general", "after reinstall", "adopt-2");
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

	test("three same-name UUID channels with the same prefix keep distinct stable files", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		const channelKeys = [
			"aaaaaaaa-0000-4000-8000-000000000001",
			"aaaaaaaa-0000-4000-8000-000000000002",
			"aaaaaaaa-0000-4000-8000-000000000003",
		] as const;

		await put_public_channel(fixture, channelKeys[0], "general");
		await append_public_message(fixture, channelKeys[0], "first channel", "same-prefix-1");
		await flush_projection(t);

		for (const [index, channelKey] of channelKeys.slice(1).entries()) {
			await put_public_channel(fixture, channelKey, "general");
			await append_public_message(fixture, channelKey, `channel ${index + 2}`, `same-prefix-${index + 2}`);
		}
		await flush_projection(t);

		const expectedPaths = [
			"/chitchat/general.md",
			`/chitchat/${collision_slug("general", channelKeys[1])}.md`,
			`/chitchat/${collision_slug("general", channelKeys[2])}.md`,
		];
		const projectedPaths = await Promise.all(
			channelKeys.map(async (channelKey) =>
				(await read_projection_mapping(t, fixture.installationId, channelKey))?.row.path,
			),
		);
		expect(projectedPaths).toEqual(expectedPaths);
		expect(new Set(projectedPaths).size).toBe(3);

		for (const [index, channelKey] of channelKeys.entries()) {
			await append_public_message(fixture, channelKey, `rebuilt ${index + 1}`, `same-prefix-rebuild-${index + 1}`);
		}
		await flush_projection(t);
		expect(
			await Promise.all(
				channelKeys.map(async (channelKey) =>
					(await read_projection_mapping(t, fixture.installationId, channelKey))?.row.path,
				),
			),
		).toEqual(expectedPaths);
	});

	test("a folder at the channel file path sends the projection to its collision slug", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-folder", "general");
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const state = await cancel_projection_job(t, fixture.installationId);
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		const folderNodeId = await t.run(async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: files_ROOT_ID,
				path: `${root._yay.folderPath}/general.md`,
				kind: "folder",
				skipAccessControlAndLock: true,
				inheritParentReadOnlyScope: true,
				now: Date.now(),
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}
			return created._yay;
		});
		await append_public_message(fixture, "chan-folder", "projected around folder", "folder-occupant-1");
		await flush_projection(t);

		const folder = await t.run(async (ctx) => await ctx.db.get("files_nodes", folderNodeId));
		expect(folder?.kind).toBe("folder");
		expect(folder?.archiveOperationId).toBeUndefined();
		const collisionPath = `/chitchat/${collision_slug("general", "chan-folder")}.md`;
		expect((await read_projection_mapping(t, fixture.installationId, "chan-folder"))?.row.path).toBe(collisionPath);
		expect((await read_projection_file(t, fixture, collisionPath))?.content).toContain("projected around folder");
	});

	test("a dirty rebuild preserves a numeric suffix in the main channel slug", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-release", "release.001");
		await append_public_message(fixture, "chan-release", "first release note", "release-numeric-1");
		await flush_projection(t);

		expect((await read_projection_mapping(t, fixture.installationId, "chan-release"))?.row.path).toBe(
			"/chitchat/release.001.md",
		);

		await append_public_message(fixture, "chan-release", "second release note", "release-numeric-2");
		await flush_projection(t);

		const rebuilt = await read_projection_file(t, fixture, "/chitchat/release.001.md");
		expect(rebuilt?.content).toContain("first release note");
		expect(rebuilt?.content).toContain("second release note");
		expect((await read_projection_mapping(t, fixture.installationId, "chan-release"))?.row.path).toBe(
			"/chitchat/release.001.md",
		);
		expect(await read_projection_file(t, fixture, "/chitchat/release.md")).toBeNull();
	});

	test("a same-name first build keeps all rollover files on its collision slug", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });

		await put_public_channel(fixture, "chan-general-a", "general");
		await append_public_message(fixture, "chan-general-a", "alpha-only", "same-name-rollover-a");
		await flush_projection(t);

		await put_public_channel(fixture, "chan-general-b", "general");
		await append_public_message(fixture, "chan-general-b", "beta-only", "same-name-rollover-b");
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general-b"),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected the second general channel to be dirty");
		}
		const step = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (step.kind !== "publish") {
			throw new Error("Expected the second general channel to reach publish");
		}

		await t.run(async (ctx) => {
			const main = await ctx.db
				.query("plugins_data_projection_chitchat_files")
				.withIndex("by_build_fileIndex", (q) => q.eq("buildId", step.buildId).eq("fileIndex", 0))
				.unique();
			if (!main) {
				throw new Error("Expected staged main file");
			}
			await ctx.db.patch("plugins_data_projection_chitchat_files", main._id, { body: "newest beta text" });
			for (let fileIndex = 1; fileIndex <= 3; fileIndex += 1) {
				await ctx.db.insert("plugins_data_projection_chitchat_files", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					buildId: step.buildId,
					fileIndex,
					body: `archived beta text ${fileIndex}`,
					updatedAt: Date.now(),
				});
			}
			await ctx.db.patch("plugins_data_projection_chitchat_builds", step.buildId, {
				outputFileIndex: 3,
				publishFileIndex: 3,
				publishedFiles: [],
			});
			const cursors = { ...state.cursors };
			for (const collection of ["channels", "messages"] as const) {
				const last = await ctx.db
					.query("plugins_data")
					.withIndex("by_installation_collection_updatedAt", (q) =>
						q.eq("installationId", fixture.installationId).eq("collection", collection),
					)
					.order("desc")
					.first();
				if (!last) {
					throw new Error(`Expected a ${collection} cursor`);
				}
				cursors[collection] = {
					updatedAt: last.updatedAt,
					lastCreationTime: last._creationTime,
					lastId: last._id,
				};
			}
			await ctx.db.patch("plugins_data_projection_states", state._id, { cursors });
		});

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
		});
		await flush_projection(t);

		const collision = collision_slug("general", "chan-general-b");
		const maps = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general-b"),
				)
				.collect(),
		);
		expect(maps.map(({ rolloverIndex, path }) => ({ rolloverIndex, path }))).toEqual([
			{ rolloverIndex: 0, path: `/chitchat/${collision}.md` },
			{ rolloverIndex: 1, path: `/chitchat/${collision}.001.md` },
			{ rolloverIndex: 2, path: `/chitchat/${collision}.002.md` },
			{ rolloverIndex: 3, path: `/chitchat/${collision}.003.md` },
		]);
		expect(await read_projection_file(t, fixture, "/chitchat/general.001.md")).toBeNull();
		expect((await read_projection_file(t, fixture, "/chitchat/general.md"))?.content).toContain("alpha-only");
		expect((await read_projection_file(t, fixture, `/chitchat/${collision}.md`))?.content).toContain(
			"newest beta text",
		);
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

	test("a forged locked Chitchat root and file stay untouched", async () => {
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
		const userFile = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/chitchat/general.md",
			textContent: "member file",
		});
		if (userFile._nay) {
			throw new Error(userFile._nay.message);
		}
		const collaborationOff = await fixture.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: fixture.membershipId,
			nodeId: userFile._yay.nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(collaborationOff._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			await Promise.all(jobs.filter((job) => job.state.kind === "pending").map((job) => ctx.scheduler.cancel(job._id)));
		});

		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (locked._nay) {
			throw new Error(locked._nay.message);
		}

		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "safe projected copy", "leftover-lock-1");
		await flush_projection(t);

		const folder = await t.run(async (ctx) => await ctx.db.get("files_nodes", created._yay.nodeId));
		expect(folder?.readOnlyScopeNodeId).toBe(created._yay.nodeId);
		expect(folder?.projectionPluginName).toBeUndefined();

		const file = await read_projection_file(t, fixture, "/chitchat/general.md");
		expect(file?.nodeId).toBe(userFile._yay.nodeId);
		expect(file?.content).toContain("member file");
		expect(
			(await t.run(async (ctx) => await ctx.db.get("files_nodes", userFile._yay.nodeId)))?.projectionPluginName,
		).toBeUndefined();

		const state = await read_projection_state(t, fixture.installationId);
		expect(state?.rootFolderNodeId).not.toBe(created._yay.nodeId);
		const projected = await t.run(async (ctx) => {
			return await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general").eq("rolloverIndex", 0),
				)
				.first();
		});
		expect(projected?.path).not.toBe("/chitchat/general.md");
		expect((await read_projection_file(t, fixture, projected!.path))?.content).toContain("safe projected copy");
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
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folder._yay.nodeId, { projectionPluginName: "chitchat" });
		});

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

	test("a capped scan schedules an active slug-resolution failure in the same generation", async () => {
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
		for (const path of ["/chitchat/general.md", `/chitchat/${collision_slug("general", "chan-general")}.md`]) {
			const occupant = await t.action(internal.files_nodes_content.create_file_by_path, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				path,
				textContent: "user owned file",
			});
			if (occupant._nay) {
				throw new Error(occupant._nay.message);
			}
		}
		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: folder._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folder._yay.nodeId, { projectionPluginName: "chitchat" });
		});
		await put_public_channel(fixture, "chan-general", "general");
		const staged = await stage_public_channel_publish(t, fixture, "chan-general");
		await insert_store_messages(t, fixture, "chan-general", 2501);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: staged.state.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		expect(after?.scheduledJobId).toBeDefined();
		expect(after?.syncGeneration).toBe(staged.state.syncGeneration);
		expect(
			(await t.run((ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", staged.step.buildId)))?.phase,
		).toBe("publish");
	});

	test("a capped scan schedules an active file-write failure in the same generation", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		const staged = await stage_public_channel_publish(t, fixture, "chan-general");
		const root = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: staged.state.syncGeneration,
		});
		if (root._nay || !root._yay) {
			throw new Error(root._nay?.message ?? "Expected projection root");
		}
		await insert_store_messages(t, fixture, "chan-general", 2501);

		let uploadCount = 0;
		vi.mocked(globalThis.fetch).mockImplementation(async () => {
			uploadCount += 1;
			if (uploadCount === 2) {
				await t.run(async (ctx) => {
					const occupant = await files_nodes_db_create_node_recursively_at_path(ctx, {
						userId: fixture.userId,
						organizationId: fixture.organizationId,
						workspaceId: fixture.workspaceId,
						parentId: files_ROOT_ID,
						path: `${root._yay.folderPath}/general.md`,
						kind: "folder",
						skipAccessControlAndLock: true,
						inheritParentReadOnlyScope: true,
						now: Date.now(),
					});
					if (occupant._nay) {
						throw new Error(occupant._nay.message);
					}
				});
			}
			return new Response(null, { status: 200 });
		});

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: staged.state.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		expect(uploadCount).toBe(2);
		expect(after?.scheduledJobId).toBeDefined();
		expect(after?.syncGeneration).toBe(staged.state.syncGeneration);
		expect(
			(await t.run((ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", staged.step.buildId)))?.phase,
		).toBe("publish");
	});

	test("a capped scan schedules an active thrown file write in the same generation", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		const staged = await stage_public_channel_publish(t, fixture, "chan-general");
		await insert_store_messages(t, fixture, "chan-general", 2501);

		let uploadCount = 0;
		vi.mocked(globalThis.fetch).mockImplementation(async () => {
			uploadCount += 1;
			if (uploadCount === 2) {
				throw new Error("R2 upload failed");
			}
			return new Response(null, { status: 200 });
		});

		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: staged.state.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		expect(uploadCount).toBe(2);
		expect(after?.scheduledJobId).toBeDefined();
		expect(after?.syncGeneration).toBe(staged.state.syncGeneration);
		expect(
			(await t.run((ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", staged.step.buildId)))?.phase,
		).toBe("publish");
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

		const continuationCursor = await t.mutation(internal.plugins_projections.ensure_hourly, {});
		const afterFirstPage = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(afterFirstPage).toHaveLength(20);
		expect(continuationCursor).toEqual(expect.any(String));

		await t.mutation(internal.plugins_projections.ensure_hourly, {
			pluginName: "chitchat",
			cursor: continuationCursor,
		});
		const afterSecondPage = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(afterSecondPage).toHaveLength(21);
	});

	test.each(["asset", "move", "archive"] as const)(
		"completion keeps the Chitchat dirty row after a supported %s race",
		async (race) => {
			vi.useFakeTimers();
			const t = test_convex();
			const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
			await put_public_channel(fixture, "chan-general", "general");
			await append_public_message(fixture, "chan-general", "projected text", `race-${race}`);
			await flush_projection(t);

			const mapped = await read_projection_mapping(t, fixture.installationId, "chan-general");
			const state = await read_projection_state(t, fixture.installationId);
			if (!mapped?.node?.assetId || !state?.rootFolderNodeId) {
				throw new Error("Expected mapped Chitchat file and root");
			}
			const claimed = await seed_and_claim_dirty_channel(t, fixture, "chan-general");
			await force_projection_root_lock(t, state.rootFolderNodeId, undefined);

			if (race === "asset") {
				const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: fixture.membershipId,
					nodeId: mapped.node._id,
					text: "member edit",
					baseAssetId: mapped.node.assetId,
				});
				expect(saved._nay).toBeUndefined();
				expect(saved._yay?.assetId).not.toBe(mapped.node.assetId);
			} else if (race === "move") {
				const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: fixture.membershipId,
					parentId: files_ROOT_ID,
					path: "projection-race-target",
				});
				if (target._nay) {
					throw new Error(target._nay.message);
				}
				const moved = await fixture.asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: fixture.membershipId,
					itemIds: [mapped.node._id],
					targetParentId: target._yay.nodeId,
				});
				expect(moved._nay).toBeUndefined();
				expect((await t.run(async (ctx) => await ctx.db.get("files_nodes", mapped.node!._id)))?.path).not.toBe(
					mapped.row.path,
				);
			} else {
				const archived = await fixture.asUser.mutation(api.files_nodes.archive_nodes, {
					membershipId: fixture.membershipId,
					nodeIds: [mapped.node._id],
				});
				expect(archived._nay).toBeUndefined();
				expect(
					(await t.run(async (ctx) => await ctx.db.get("files_nodes", mapped.node!._id)))?.archiveOperationId,
				).toBeDefined();
			}

			await t.mutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				channelKey: "chan-general",
				updatedAt: claimed.updatedAt,
				files: [{ rolloverIndex: 0, path: mapped.row.path }],
			});
			const dirtyStillExists = await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
					)
					.first(),
			);
			expect(dirtyStillExists).not.toBeNull();
		},
	);

	test("completion checks a changed rollover file after index zero", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "projected text", "rollover-race");
		await flush_projection(t);

		const first = await read_projection_mapping(t, fixture.installationId, "chan-general");
		const state = await read_projection_state(t, fixture.installationId);
		if (!first?.node?.assetId || !state?.rootFolderNodeId) {
			throw new Error("Expected mapped Chitchat file and root");
		}
		const secondPath = "/chitchat/general-part-2.md";
		const secondWritten = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			path: secondPath,
			text: "second rollover before race",
			channelKey: "chan-general",
			rolloverIndex: 1,
		});
		if (secondWritten._nay) {
			throw new Error(secondWritten._nay.message);
		}
		const second = await t.run(async (ctx) => {
			const row = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general").eq("rolloverIndex", 1),
				)
				.unique();
			return row ? { row, node: await ctx.db.get("files_nodes", row.fileNodeId) } : null;
		});
		if (!second?.node?.assetId) {
			throw new Error("Expected second mapped Chitchat file");
		}

		const claimed = await seed_and_claim_dirty_channel(t, fixture, "chan-general");
		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: fixture.membershipId,
			nodeId: second.node._id,
			text: "member changed only rollover one",
			baseAssetId: second.node.assetId,
		});
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.assetId).not.toBe(second.node.assetId);

		await t.mutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			channelKey: "chan-general",
			updatedAt: claimed.updatedAt,
			files: [
				{ rolloverIndex: 0, path: first.row.path },
				{ rolloverIndex: 1, path: second.row.path },
			],
		});
		const dirtyStillExists = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
				)
				.first(),
		);
		expect(dirtyStillExists).not.toBeNull();
	});

	test("trimming a moved rollover drops its stale map without archiving the moved file", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "projected text", "rollover-trim-move");
		await flush_projection(t);
		const written = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			path: "/chitchat/general.001.md",
			text: "older rollover",
			channelKey: "chan-general",
			rolloverIndex: 1,
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		const rollover = await t.run(async (ctx) => {
			const row = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general").eq("rolloverIndex", 1),
				)
				.first();
			return row ? { row, node: await ctx.db.get("files_nodes", row.fileNodeId) } : null;
		});
		if (!rollover?.node) {
			throw new Error("Expected rollover file");
		}
		const state = await read_projection_state(t, fixture.installationId);
		if (!state?.rootFolderNodeId) {
			throw new Error("Expected projection root");
		}
		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "rollover-trim-target",
		});
		if (target._nay) {
			throw new Error(target._nay.message);
		}
		const moved = await fixture.asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: fixture.membershipId,
			itemIds: [rollover.node._id],
			targetParentId: target._yay.nodeId,
		});
		expect(moved._nay).toBeUndefined();

		await t.mutation(internal.plugins_projections.trim_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			channelKey: "chan-general",
			keepCount: 1,
		});

		const after = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", rollover.node!._id),
			map: await ctx.db.get("plugins_data_projection_files", rollover.row._id),
		}));
		expect(after.node?.archiveOperationId).toBeUndefined();
		expect(after.node?.path).toBe("/rollover-trim-target/general.001.md");
		expect(after.map).toBeNull();
	});

	test("a swapped pair of rollover paths is rebuilt without wedging the channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await flush_projection(t);
		const state = await read_projection_state(t, fixture.installationId);
		if (!state?.rootFolderNodeId) {
			throw new Error("Expected projection root");
		}
		const initial = await t.action(internal.plugins_projections.write_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: "chan-general",
			slug: "general",
			folderPath: "/chitchat",
			texts: ["older rollover", "newer rollover"],
		});
		if (initial._nay) {
			throw new Error(initial._nay.message);
		}
		const before = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
				)
				.collect();
			return await Promise.all(
				rows.map(async (row) => ({ row, node: await ctx.db.get("files_nodes", row.fileNodeId) })),
			);
		});
		const main = before.find(({ row }) => row.rolloverIndex === 0);
		const older = before.find(({ row }) => row.rolloverIndex === 1);
		if (!main?.node || !older?.node) {
			throw new Error("Expected two rollover files");
		}

		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		for (const rename of [
			{ nodeId: older.node._id, path: "general-swap-temp.md" },
			{ nodeId: main.node._id, path: "general.001.md" },
			{ nodeId: older.node._id, path: "general.md" },
		]) {
			const result = await fixture.asUser.mutation(api.files_nodes.rename_node, {
				membershipId: fixture.membershipId,
				...rename,
			});
			expect(result._nay).toBeUndefined();
		}

		const claimed = await seed_and_claim_dirty_channel(t, fixture, "chan-general");
		const rebuilt = await t.action(internal.plugins_projections.write_projection_channel_files, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: "chan-general",
			slug: "general",
			folderPath: "/chitchat",
			texts: ["rebuilt older", "rebuilt newer"],
		});
		if (rebuilt._nay || !rebuilt._yay) {
			throw new Error(rebuilt._nay?.message ?? "Expected rebuilt rollover files");
		}
		await force_projection_root_lock(t, state.rootFolderNodeId, state.rootFolderNodeId);
		await t.mutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: "chan-general",
			updatedAt: claimed.updatedAt,
			files: rebuilt._yay.files,
		});

		const after = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
				)
				.collect();
			return {
				rows: await Promise.all(
					rows.map(async (row) => ({ row, node: await ctx.db.get("files_nodes", row.fileNodeId) })),
				),
				dirty: await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", "chan-general"),
					)
					.first(),
			};
		});
		expect(after.dirty).toBeNull();
		expect(after.rows).toHaveLength(2);
		for (const { row, node } of after.rows) {
			expect(node?._id).toBe(row.fileNodeId);
			expect(node?.path).toBe(row.path);
			expect(node?.archiveOperationId).toBeUndefined();
		}
	});

	test.each(["asset", "move", "archive"] as const)(
		"finish_sync keeps Chitchat dirty after a supported README %s race",
		async (race) => {
			vi.useFakeTimers();
			const t = test_convex();
			const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
			await put_public_channel(fixture, "chan-general", "general");
			await flush_projection(t);

			const mapped = await read_projection_mapping(t, fixture.installationId, "__readme__");
			const before = await read_projection_state(t, fixture.installationId);
			if (!mapped?.node?.assetId || !before?.rootFolderNodeId) {
				throw new Error("Expected mapped README and root");
			}
			await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
			const scheduled = await read_projection_state(t, fixture.installationId);
			await force_projection_root_lock(t, before.rootFolderNodeId, undefined);

			if (race === "asset") {
				const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: fixture.membershipId,
					nodeId: mapped.node._id,
					text: "changed readme",
					baseAssetId: mapped.node.assetId,
				});
				expect(saved._nay).toBeUndefined();
			} else if (race === "move") {
				const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: fixture.membershipId,
					parentId: files_ROOT_ID,
					path: "readme-race-target",
				});
				if (target._nay) {
					throw new Error(target._nay.message);
				}
				const moved = await fixture.asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: fixture.membershipId,
					itemIds: [mapped.node._id],
					targetParentId: target._yay.nodeId,
				});
				expect(moved._nay).toBeUndefined();
			} else {
				const archived = await fixture.asUser.mutation(api.files_nodes.archive_nodes, {
					membershipId: fixture.membershipId,
					nodeIds: [mapped.node._id],
				});
				expect(archived._nay).toBeUndefined();
			}

			await t.mutation(internal.plugins_projections.finish_sync, {
				installationId: fixture.installationId,
				syncGeneration: scheduled!.syncGeneration,
				continueImmediately: false,
				expectedFiles: {
					channelKey: "__readme__",
					files: [{ rolloverIndex: 0, path: mapped.row.path }],
				},
			});
			expect((await read_projection_state(t, fixture.installationId))?.dirty).toBe(true);
		},
	);

	test("a refused production README write cannot mark Chitchat clean", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "chan-general", "general");
		await flush_projection(t);
		const mapped = await read_projection_mapping(t, fixture.installationId, "__readme__");
		const state = await read_projection_state(t, fixture.installationId);
		if (!mapped?.node?.assetId || !state?.rootFolderNodeId) {
			throw new Error("Expected mapped README and projection root");
		}

		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		const archived = await fixture.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: fixture.membershipId,
			nodeIds: [mapped.node._id],
		});
		expect(archived._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const { _id: _oldId, _creationTime: _oldCreationTime, ...node } = mapped.node!;
			await ctx.db.insert("files_nodes", {
				...node,
				archiveOperationId: undefined,
				nonCollaborative: false,
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const scheduled = await read_projection_state(t, fixture.installationId);
		await t.action(internal.plugins_projections_chitchat.sync, {
			installationId: fixture.installationId,
			syncGeneration: scheduled!.syncGeneration,
		});

		expect((await read_projection_state(t, fixture.installationId))?.dirty).toBe(true);
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

	test("a forged private folder under the real root stays untouched", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_plugin_user_write(t, { pluginName: "chitchat" });
		await put_public_channel(fixture, "general", "general");
		await append_public_message(fixture, "general", "create the real root", "private-forge-root");
		await flush_projection(t);
		const state = await read_projection_state(t, fixture.installationId);
		if (!state?.rootFolderNodeId) {
			throw new Error("Expected the real Chitchat root");
		}
		await force_projection_root_lock(t, state.rootFolderNodeId, undefined);
		const userFile = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/chitchat/private/war-room/user.md",
			textContent: "private member file",
		});
		if (userFile._nay) {
			throw new Error(userFile._nay.message);
		}
		const forgedFolder = await t.run(async (ctx) => {
			return await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/chitchat/private/war-room")
						.eq("archiveOperationId", undefined),
				)
				.first();
		});
		if (!forgedFolder) {
			throw new Error("Expected the member private folder");
		}
		await force_projection_root_lock(t, state.rootFolderNodeId, state.rootFolderNodeId);

		const scope = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: SCOPE_ID,
				collections: ["channels", "messages", "replies", "reactions"],
				keyPrefix: SCOPE_ID,
			},
		});
		expect(scope._nay).toBeUndefined();
		await put_public_channel(fixture, SCOPE_ID, "war-room");
		await append_public_message(fixture, SCOPE_ID, "projected private text", "private-forge-message");
		await flush_projection(t);

		const untouchedFolder = await t.run(async (ctx) => await ctx.db.get("files_nodes", forgedFolder._id));
		const untouchedFile = await read_projection_file(t, fixture, "/chitchat/private/war-room/user.md");
		expect(untouchedFolder?.archiveOperationId).toBeUndefined();
		expect(untouchedFolder?.projectionPluginName).toBeUndefined();
		expect(untouchedFile?.nodeId).toBe(userFile._yay.nodeId);
		expect(untouchedFile?.content).toContain("private member file");
		const projectedFolder = await read_private_folder(t, fixture);
		expect(projectedFolder?.node?._id).not.toBe(forgedFolder._id);
		expect(projectedFolder?.row.path).not.toBe("/chitchat/private/war-room");
		expect(projectedFolder?.node?.projectionPluginName).toBe("chitchat");
		expect((await read_projection_file(t, fixture, `${projectedFolder!.row.path}/war-room.md`))?.content).toContain(
			"projected private text",
		);
	});

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

		// Public and private documents share one bounded fence per collection.
		const state = await read_projection_state(t, fixture.installationId);
		expect(Object.keys(state?.cursors ?? {}).sort()).toEqual(["channels", "messages", "reactions", "replies"]);
		expect(state?.cursors.replies).toBeDefined();
		expect(state?.cursors.reactions).toBeDefined();

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

	test("a same-name private channel leaves an old folder with archived files untouched", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "old channel content", "leftover-1");
		await flush_projection(t);
		const oldFolder = await read_private_folder(t, fixture);
		if (!oldFolder?.node) {
			throw new Error("Expected the old private folder");
		}
		const oldFolderNode = oldFolder.node;
		const oldTranscript = await read_projection_file(t, fixture, `${oldFolder.row.path}/war-room.md`);
		if (!oldTranscript?.nodeId) {
			throw new Error("Expected the old private transcript");
		}
		const oldGrants = await read_folder_grants(t, fixture, oldFolderNode._id);

		// A rollover file of the old channel. Producing one for real needs a 600 KB transcript, so
		// insert it through the same node writer the projection uses.
		const leftoverNodeId = await t.run(async (ctx) => {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: files_ROOT_ID,
				path: `${oldFolder.row.path}/war-room.001.md`,
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

		// Uninstall can leave archived transcript files after it removes the projection maps. Keep the
		// folder active so a later same-name channel sees it at the preferred path.
		await t.run(async (ctx) => {
			const children = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("parentId", oldFolderNode._id),
				)
				.collect();
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds: children.map((node) => node._id),
				updatedBy: fixture.userId,
				now: Date.now(),
			});

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

		const projected = await read_private_folder(t, fixture, "p/room-9");
		expect(projected?.node?._id).not.toBe(oldFolderNode._id);
		expect(projected?.row.path).toBe(`/chitchat/private/${collision_slug("war-room", "p/room-9")}`);
		expect(await read_folder_grants(t, fixture, oldFolderNode._id)).toEqual(oldGrants);

		const leftover = await t.run(async (ctx) => await ctx.db.get("files_nodes", leftoverNodeId));
		expect(leftover?.archiveOperationId).toBeDefined();
		expect(leftover?.parentId).toBe(oldFolderNode._id);

		// The public restore door hides an archived node from a user who cannot read its old folder.
		const asBob = t.withIdentity({
			issuer: "https://clerk.test",
			subject: bob.clerkUserId,
			external_id: bob.userId,
		});
		const oldContent = await asBob.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: bob.membershipId,
			nodeId: oldTranscript.nodeId,
		});
		expect(oldContent._nay?.message).toBe("Permission denied");
		const restored = await asBob.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: bob.membershipId,
			nodeIds: [leftoverNodeId],
		});
		expect(restored._nay?.message).toBe("Not found");
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

		// Public sharing cannot change a projection-owned folder, even for the owner.
		const unrestricted = await fixture.asUser.mutation(api.files_sharing.unrestrict_node, {
			membershipId: fixture.membershipId,
			nodeId: folder!.node!._id,
		});
		expect(unrestricted._nay?.message).toBe("Plugin-managed files cannot be shared.");
		const shared = await fixture.asUser.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: fixture.membershipId,
			nodeId: folder!.node!._id,
			principal: { kind: "user", userId: carol.userId },
			level: "read",
		});
		expect(shared._nay?.message).toBe("Plugin-managed files cannot be shared.");

		// Model old stored state from before the authority fence. Clear the folder restriction and
		// its grants directly so completion has to notice and retain the dirty work.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folder!.node!._id, { restrictedScopeNodeId: undefined });
			await files_nodes_db_cascade_restricted_scope(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				parentId: folder!.node!._id,
				scopeNodeId: undefined,
			});
			const grants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", String(folder!.node!._id)),
				)
				.collect();
			await Promise.all(grants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)));
		});
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
		await append_public_message(fixture, SCOPE_ID, "published content", "revive-1");
		await flush_projection(t);
		// Anchor the path first: the null below must mean "dead scope", not "never existed".
		expect((await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md"))?.content).toContain(
			"published content",
		);
		await append_public_message(fixture, SCOPE_ID, "must not publish", "revive-2");
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", SCOPE_ID),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected private channel to be dirty");
		}
		const publish = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (publish.kind !== "publish") {
			throw new Error("Expected an active private publish build");
		}

		const deleted = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "delete", scopeId: SCOPE_ID },
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}
		const current = await read_projection_state(t, fixture.installationId);
		if (!current) {
			throw new Error("Expected current projection state");
		}
		expect(
			await t.query(internal.plugins_projections_chitchat.get_build_slug_resolution, {
				installationId: fixture.installationId,
				syncGeneration: current.syncGeneration,
				expectedProjectionStateId: current._id,
				buildId: publish.buildId,
			}),
		).toBeNull();
		const currentDirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", SCOPE_ID),
				)
				.unique(),
		);
		if (!currentDirty) {
			throw new Error("Expected deleted scope to stay dirty");
		}
		expect(
			await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
				installationId: fixture.installationId,
				syncGeneration: current.syncGeneration,
				channelKey: currentDirty.channelKey,
				dirtyUpdatedAt: currentDirty.updatedAt,
			}),
		).toMatchObject({ kind: "archive" });
		expect((await read_projection_file(t, fixture, "/chitchat/private/war-room/war-room.md"))?.content).not.toContain(
			"must not publish",
		);

		// A deleted scope keeps its documents, so the channel doc still looks alive. Only the missing
		// scope row says the channel is dead, and the projector has to read that too — otherwise the
		// dirty row this delete leaves behind rebuilds the whole transcript after the archive ran.
		expect(
			await t.query(internal.plugins_projections_chitchat.get_channel_projection_metadata, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				channelKey: SCOPE_ID,
			}),
		).toBeNull();
	});

	test("a scope delete between slug resolution and file replacement refuses the stale publish", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "old private content", "replace-race-1");
		await flush_projection(t);
		const current = await read_projection_mapping(t, fixture.installationId, SCOPE_ID);
		if (!current?.node?.assetId) {
			throw new Error("Expected the current private projection file");
		}

		await append_public_message(fixture, SCOPE_ID, "must not replace", "replace-race-2");
		const state = await cancel_projection_job(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", SCOPE_ID),
				)
				.unique(),
		);
		if (!dirty) {
			throw new Error("Expected the private channel to be dirty");
		}
		const publish = await t.mutation(internal.plugins_projections_chitchat.advance_channel_build, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			channelKey: dirty.channelKey,
			dirtyUpdatedAt: dirty.updatedAt,
		});
		if (publish.kind !== "publish") {
			throw new Error("Expected a staged private publish");
		}
		const resolution = await t.query(internal.plugins_projections_chitchat.get_build_slug_resolution, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: publish.lifecycleStateId,
			buildId: publish.buildId,
		});
		if (!resolution) {
			throw new Error("Expected a live private slug resolution");
		}

		vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			const deleted = await fixture.asPage.mutation(api.plugins_data.user_manage_scope, {
				action: { kind: "delete", scopeId: SCOPE_ID },
			});
			if (deleted._nay) {
				throw new Error(deleted._nay.message);
			}
			return new Response(null, { status: 200 });
		});
		const written = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: state.syncGeneration,
			expectedProjectionStateId: publish.lifecycleStateId,
			path: current.row.path,
			text: `${publish.header}\n\n${publish.body}`,
			channelKey: SCOPE_ID,
			rolloverIndex: publish.rolloverIndex,
		});
		expect(written._nay?.message).toBe("Projection source is no longer live");
		const after = await read_projection_mapping(t, fixture.installationId, SCOPE_ID);
		expect(after?.node?.assetId).toBe(current.node.assetId);
		expect((await read_projection_file(t, fixture, current.row.path))?.content).toContain("old private content");
		expect((await read_projection_file(t, fixture, current.row.path))?.content).not.toContain("must not replace");
		expect(
			await t.mutation(internal.plugins_projections_chitchat.mark_build_file_published, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
				buildId: publish.buildId,
				fileIndex: publish.fileIndex,
				path: current.row.path,
			}),
		).toBe(false);
		const build = await t.run(async (ctx) => ctx.db.get("plugins_data_projection_chitchat_builds", publish.buildId));
		expect(build?.publishedFiles).toEqual([]);
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
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				collection: "channels",
				runStartMs: Date.now(),
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
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });

		// What the sync sees when it picks the channel up.
		const picked = await t.mutation(internal.plugins_projections_chitchat.peek_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
		});
		expect(picked?.channelKey).toBe(SCOPE_ID);

		// A second membership change lands while the rebuild is in flight. It writes no store
		// document, so this dirty row is the only record of it.
		await set_scope_member(fixture, carol.userId);

		await t.mutation(internal.plugins_projections_chitchat.complete_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			channelKey: SCOPE_ID,
			updatedAt: picked!.updatedAt,
			files: [],
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

	test("archiving the channel keeps its merged message cursor", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await append_public_message(fixture, SCOPE_ID, "archived cursors", "cursor-archive-1");
		await flush_projection(t);
		const before = await read_projection_state(t, fixture.installationId);
		expect(before?.cursors.messages).toBeDefined();

		const archived = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: SCOPE_ID,
			value: { name: "war-room", archivedAt: Date.now() },
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await flush_projection(t);

		// Archiving changes the channels collection, not the merged messages fence.
		const after = await read_projection_state(t, fixture.installationId);
		expect(after?.cursors.messages).toEqual(before?.cursors.messages);
	});

	test("a scoped message advances the merged cursor and dirties only the private channel", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_private_channel(t);
		await put_public_channel(fixture, "chan-general", "general");
		await append_public_message(fixture, "chan-general", "public message", "cursor-pub-1");
		await append_public_message(fixture, SCOPE_ID, "private message", "cursor-priv-1");
		await flush_projection(t);

		const cleanState = await read_projection_state(t, fixture.installationId);
		const mergedCursor = cleanState?.cursors.messages;
		expect(mergedCursor).toBeDefined();

		await append_public_message(fixture, SCOPE_ID, "second private message", "cursor-priv-2");
		const advanced = await t.mutation(internal.plugins_projections_chitchat.advance_collection_cursor, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			collection: "messages",
			runStartMs: Date.now(),
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
		expect(state?.cursors.messages).not.toEqual(mergedCursor);
	});
});
