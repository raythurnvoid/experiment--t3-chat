import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
// Load action modules before fake timers. convex-test imports them on first
// run, and that import can hang while timers are faked.
import "./plugins_projections.ts";
import "./plugins_projections_council.ts";
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
	const tokenHash = `page-session-council-projection-${page_session_seed_counter}`;
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

async function seed_council_install(t: ReturnType<typeof test_convex>) {
	const clerkUserId = "council-projection-owner";
	const userId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId }));
	const fixture = await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, { userId });
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "council",
			displayName: "council",
			version: "0.1.0",
			description: "test plugin",
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
			pluginName: "council",
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

function service_principal(fixture: Awaited<ReturnType<typeof seed_council_install>>) {
	return {
		kind: "plugin_service" as const,
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		installationId: fixture.installationId,
		actorUserId: fixture.userId,
		principalKey: `plugin_service:${fixture.installationId}`,
	};
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

async function read_meeting_mapping(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
	channelKey = MEETING_ID,
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

async function read_sync_generation(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
) {
	const state = await t.run(async (ctx) =>
		ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first(),
	);
	if (!state) {
		throw new Error("Expected projection state");
	}
	return state.syncGeneration;
}

async function read_projection_state(
	t: ReturnType<typeof test_convex>,
	installationId: Id<"plugins_workspace_installations">,
) {
	return await t.run(async (ctx) =>
		ctx.db
			.query("plugins_data_projection_states")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first(),
	);
}

async function seed_council_dirty(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_council_install>>,
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("plugins_data_projection_dirty_channels", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			channelKey: MEETING_ID,
			queuedAt: now,
			updatedAt: now,
		});
		return now;
	});
}

const MEETING_ID = "af26438a-1234-4147-aeac-4abea4eb0495";
const MEETING_PATH = `/meetings/${MEETING_ID}/meeting.md`;
const MEETING_COLLISION_PATH = `/meetings/${MEETING_ID}/meeting-af26438a.md`;
const SECOND_MEETING_ID = "bf26438a-1234-4147-aeac-4abea4eb0495";
const SECOND_MEETING_PATH = `/meetings/${SECOND_MEETING_ID}/meeting.md`;

function meeting_value(
	args: {
		meetingId?: string;
		title?: string;
		status?: string;
		recordingWarning?: string | null;
		artifacts?: { kind: string; fileName: string }[];
	} = {},
) {
	return {
		meetingId: args.meetingId ?? MEETING_ID,
		title: args.title ?? "Colleague test 26 Aug",
		status: args.status ?? "ready",
		createdBy: "user_alice",
		createdAt: Date.UTC(2026, 7, 26, 12, 0),
		openedAt: Date.UTC(2026, 7, 26, 12, 5),
		closedAt: Date.UTC(2026, 7, 26, 12, 10),
		deadlineAt: null,
		participantCount: 1,
		recordingWarning: args.recordingWarning ?? null,
		artifacts: args.artifacts ?? [],
	};
}

describe("council file projection", () => {
	test("a stale disabled sync leaves projection rows for the bounded lifecycle drain", async () => {
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, {
			installationId: fixture.installationId,
		});
		const state = await read_projection_state(t, fixture.installationId);
		if (!state) {
			throw new Error("Expected projection state");
		}
		await seed_council_dirty(t, fixture);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);

		expect(
			await t.mutation(internal.plugins_projections_council.prepare_sync, {
				installationId: fixture.installationId,
				syncGeneration: state.syncGeneration,
			}),
		).toEqual({ _nay: { message: "Installation gone" } });
		expect(await t.run((ctx) => ctx.db.get("plugins_data_projection_states", state._id))).not.toBeNull();
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
					)
					.first(),
			),
		).not.toBeNull();
	});

	test("a versioned meeting write schedules a sync that writes meeting.md", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}

		await flush_projection(t);

		const file = await read_projection_file(t, fixture, MEETING_PATH);
		expect(file).not.toBeNull();
		expect(file?.content).toContain("# Colleague test 26 Aug");
		expect(file?.content).toContain("- Status: ready");
		expect(file?.content).toContain(`- Meeting id: ${MEETING_ID}`);
		expect(file?.content).toContain("Council stored no recording files for this meeting.");
		expect(file?.nonCollaborativeBaseAssetId).toEqual(expect.any(String));

		const [meetingFile, meetingsFolder] = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", file!.nodeId);
			const folder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("path", "/meetings")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return [fileNode, folder] as const;
		});
		if (!meetingsFolder) {
			throw new Error("Expected the shared meetings folder");
		}
		expect(meetingFile?.readOnlyScopeNodeId).toBe(file!.nodeId);
		expect(meetingFile?.nonCollaborative).toBe(true);
		expect(file?.content).not.toContain("Council could not store the video recording");
		expect(meetingsFolder?.readOnlyScopeNodeId).toBeUndefined();
		expect(meetingsFolder?.projectionPluginName).toBeUndefined();
		const mapped = await read_meeting_mapping(t, fixture.installationId);
		expect(mapped?.row.contentHash).toBe(await crypto_sha256_hex(file!.content));
		expect(mapped?.row.contentAssetId).toBe(mapped?.node?.assetId);

		const restricted = await fixture.asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: fixture.membershipId,
			nodeId: meetingsFolder._id,
		});
		expect(restricted._nay).toBeUndefined();
		const unrestricted = await fixture.asUser.mutation(api.files_sharing.unrestrict_node, {
			membershipId: fixture.membershipId,
			nodeId: meetingsFolder._id,
		});
		expect(unrestricted._nay).toBeUndefined();
		const locked = await fixture.asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: fixture.membershipId,
			nodeId: meetingsFolder._id,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await fixture.asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: fixture.membershipId,
			nodeId: meetingsFolder._id,
		});
		expect(unlocked._nay).toBeUndefined();
	});

	test("an unchanged Council note keeps its current asset", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		for (const revision of [1, 2]) {
			const written = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal: service_principal(fixture),
				collection: "meetings",
				key: MEETING_ID,
				revision,
				value: meeting_value(),
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
			await flush_projection(t);
			const mapped = await read_meeting_mapping(t, fixture.installationId);
			if (revision === 1) {
				expect(mapped?.node?.assetId).toBeDefined();
				continue;
			}
			const snapshots = await t.run(async (ctx) =>
				(await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === mapped?.node?._id,
				),
			);
			expect(snapshots).toHaveLength(1);
			expect(mapped?.row.contentAssetId).toBe(mapped?.node?.assetId);
		}
	});

	test("writes the over-cap recording warning into meeting.md", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const warning =
			"Council could not store the video recording. The file was larger than the workspace can accept. The audio file was still saved.";

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value({
				recordingWarning: warning,
				artifacts: [{ kind: "track_audio", fileName: "recording-audio.m4a" }],
			}),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}

		await flush_projection(t);

		const file = await read_projection_file(t, fixture, MEETING_PATH);
		expect(file?.content).toContain(warning);
		expect(file?.content).toContain("- recording-audio.m4a");
	});

	test("reuses a member /meetings folder and does not lock a sibling", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);

		const meetingsFolder = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "meetings",
		});
		if (meetingsFolder._nay) {
			throw new Error(meetingsFolder._nay.message);
		}

		const notesFolder = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: meetingsFolder._yay.nodeId,
			path: "notes",
		});
		if (notesFolder._nay) {
			throw new Error(notesFolder._nay.message);
		}

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}

		await flush_projection(t);

		const file = await read_projection_file(t, fixture, MEETING_PATH);
		expect(file?.content).toContain("# Colleague test 26 Aug");

		const [meetings, notes, state] = await t.run(async (ctx) => {
			return [
				await ctx.db.get("files_nodes", meetingsFolder._yay.nodeId),
				await ctx.db.get("files_nodes", notesFolder._yay.nodeId),
				await ctx.db
					.query("plugins_data_projection_states")
					.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
					.first(),
			] as const;
		});
		expect(meetings?.readOnlyScopeNodeId).toBeUndefined();
		expect(notes?.readOnlyScopeNodeId).toBeUndefined();
		expect(state?.rootFolderNodeId).toBe(meetingsFolder._yay.nodeId);

		const stillWritable = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: meetingsFolder._yay.nodeId,
			path: "later-upload",
		});
		if (stillWritable._nay) {
			throw new Error(stillWritable._nay.message);
		}
	});

	test("two Council syncs preserve a member-locked non-collaborative user file at the target path", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const userFile = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: MEETING_PATH,
			textContent: "user-owned meeting note",
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
			nodeId: userFile._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const userNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", userFile._yay.nodeId));
		expect(userNode?.nonCollaborative).toBe(true);
		expect(userNode?.assetId).toBeDefined();
		expect(userNode?.readOnlyScopeNodeId).toBe(userFile._yay.nodeId);
		expect(userNode?.projectionPluginName).toBeUndefined();

		for (const revision of [1, 2]) {
			const written = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal: service_principal(fixture),
				collection: "meetings",
				key: MEETING_ID,
				revision,
				value: meeting_value({ title: `Council projection ${revision}` }),
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
			await flush_projection(t);
		}

		const original = await read_projection_file(t, fixture, MEETING_PATH);
		expect(original?.nodeId).toBe(userFile._yay.nodeId);
		expect(original?.content).toContain("user-owned meeting note");
		const originalNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", userFile._yay.nodeId));
		expect(originalNode?.archiveOperationId).toBeUndefined();

		const mapped = await read_meeting_mapping(t, fixture.installationId);
		expect(mapped?.row.path).toBe(MEETING_COLLISION_PATH);
		expect(mapped?.node?.readOnlyScopeNodeId).toBe(mapped?.node?._id);
		expect((await read_projection_file(t, fixture, MEETING_COLLISION_PATH))?.content).toContain(
			"# Council projection 2",
		);
	});

	test("a folder named meeting.md sends the Council note to its collision path", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const meetingsFolder = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "meetings",
		});
		if (meetingsFolder._nay) {
			throw new Error(meetingsFolder._nay.message);
		}
		const meetingFolder = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: meetingsFolder._yay.nodeId,
			path: MEETING_ID,
		});
		if (meetingFolder._nay) {
			throw new Error(meetingFolder._nay.message);
		}
		const occupant = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: meetingFolder._yay.nodeId,
			path: "meeting.md",
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		await flush_projection(t);

		const folder = await t.run(async (ctx) => await ctx.db.get("files_nodes", occupant._yay.nodeId));
		expect(folder?.kind).toBe("folder");
		expect(folder?.archiveOperationId).toBeUndefined();
		expect((await read_meeting_mapping(t, fixture.installationId))?.row.path).toBe(MEETING_COLLISION_PATH);
		expect((await read_projection_file(t, fixture, MEETING_COLLISION_PATH))?.content).toContain(
			"# Colleague test 26 Aug",
		);
	});

	test("a versioned delete archives meeting.md and leaves a sibling folder", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}

		await flush_projection(t);
		const before = await read_projection_file(t, fixture, MEETING_PATH);
		if (!before) {
			throw new Error("Expected meeting.md");
		}

		const meetingFolder = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", before.nodeId);
			if (!fileNode || fileNode.parentId === files_ROOT_ID) {
				throw new Error("Expected a meeting folder parent");
			}

			return fileNode.parentId;
		});

		const sibling = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: meetingFolder,
			path: "keep-me",
		});
		if (sibling._nay) {
			throw new Error(sibling._nay.message);
		}

		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 2,
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		await flush_projection(t);

		expect(await read_projection_file(t, fixture, MEETING_PATH)).toBeNull();
		const leftover = await t.run(async (ctx) => await ctx.db.get("files_nodes", sibling._yay.nodeId));
		expect(leftover?.archiveOperationId).toBeUndefined();
		expect(leftover?.path).toBe(`/meetings/${MEETING_ID}/keep-me`);
	});

	test("a source delete drops a stale map without archiving a moved Council note", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		await flush_projection(t);

		const mapped = await read_meeting_mapping(t, fixture.installationId);
		if (!mapped?.node) {
			throw new Error("Expected mapped Council note");
		}
		// Public lock controls refuse projection-owned nodes. Patch the stale state directly to
		// model a move that raced with an older projection generation.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", mapped.node!._id, { readOnlyScopeNodeId: undefined });
		});
		const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "council-delete-target",
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

		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 2,
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}
		await flush_projection(t);

		const movedNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", mapped.node!._id));
		expect(movedNode?.archiveOperationId).toBeUndefined();
		expect(movedNode?.path).toBe("/council-delete-target/meeting.md");
		expect(await read_meeting_mapping(t, fixture.installationId)).toBeNull();
	});

	test("a repair archive drops a moved map before creating one replacement", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		await flush_projection(t);

		const mapped = await read_meeting_mapping(t, fixture.installationId);
		if (!mapped?.node) {
			throw new Error("Expected mapped Council note");
		}
		// Public lock controls refuse projection-owned nodes. Patch the stale state directly to
		// model a move that raced with an older projection generation.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", mapped.node!._id, { readOnlyScopeNodeId: undefined });
		});
		const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: fixture.membershipId,
			parentId: files_ROOT_ID,
			path: "council-repair-race-target",
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

		await t.mutation(internal.plugins_projections.archive_projection_node, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			nodeId: mapped.node._id,
		});
		const afterArchive = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", mapped.node!._id),
			map: await ctx.db.get("plugins_data_projection_files", mapped.row._id),
		}));
		expect(afterArchive.node?.archiveOperationId).toBeUndefined();
		expect(afterArchive.node?.path).toBe("/council-repair-race-target/meeting.md");
		expect(afterArchive.map).toBeNull();

		const replacement = await t.action(internal.plugins_projections.write_projection_markdown, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			path: MEETING_PATH,
			text: "# Replacement Council note",
			channelKey: MEETING_ID,
			rolloverIndex: 0,
		});
		if (replacement._nay) {
			throw new Error(replacement._nay.message);
		}
		const afterReplace = await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("plugins_data_projection_files")
				.withIndex("by_installation_channelKey_rolloverIndex", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID).eq("rolloverIndex", 0),
				)
				.collect();
			return {
				rows,
				moved: await ctx.db.get("files_nodes", mapped.node!._id),
				replacement: replacement._yay ? await ctx.db.get("files_nodes", replacement._yay.nodeId) : null,
			};
		});
		expect(afterReplace.rows).toHaveLength(1);
		expect(afterReplace.rows[0]?.fileNodeId).toBe(replacement._yay?.nodeId);
		expect(afterReplace.moved?.archiveOperationId).toBeUndefined();
		expect(afterReplace.replacement?.readOnlyScopeNodeId).toBe(afterReplace.replacement?._id);
	});

	test("hourly ensure pages council installations", async () => {
		const t = test_convex();
		const fixture = await seed_council_install(t);

		await t.mutation(internal.plugins_projections.ensure_hourly, { pluginName: "council" });
		const states = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(states).toHaveLength(1);
		expect(states[0]?.pluginName).toBe("council");
		expect(states[0]?.installationId).toBe(fixture.installationId);
	});

	test("same-time Council changes resume through opaque pages with a page size of one", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 5; index += 1) {
				const meetingId = `same-time-${index}`;
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "meetings",
					key: meetingId,
					value: meeting_value({ meetingId, title: `Meeting ${index}` }),
					byteSize: 200,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});

		let truncated = true;
		let calls = 0;
		while (truncated && calls < 10) {
			const advanced = await t.mutation(internal.plugins_projections_council.advance_collection_cursor, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				runStartMs: updatedAt,
				pageSize: 1,
			});
			if (advanced._nay) {
				throw new Error(advanced._nay.message);
			}
			truncated = advanced._yay.truncated;
			calls += 1;
		}

		expect(truncated).toBe(false);
		expect(calls).toBeGreaterThan(1);
		const [ordered, dirty, state] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("plugins_data")
					.withIndex("by_installation_collection_scope_updatedAt", (q) =>
						q.eq("installationId", fixture.installationId).eq("collection", "meetings").eq("scopeId", undefined),
					)
					.order("asc")
					.collect(),
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
				ctx.db
					.query("plugins_data_projection_states")
					.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
					.first(),
			]),
		);
		expect(state?.cursors.meetings?.lastId).toBe(ordered.at(-1)?._id);
		expect(state?.scanCursors?.meetings).toBeUndefined();
		expect(dirty.map((row) => row.channelKey).sort()).toEqual([
			"same-time-0",
			"same-time-1",
			"same-time-2",
			"same-time-3",
			"same-time-4",
		]);
	});

	test("one Council sync hop caps its change scan and still drains the oldest dirty meeting", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			if (!state) {
				throw new Error("Expected projection state");
			}
			if (state.scheduledJobId) {
				await ctx.scheduler.cancel(state.scheduledJobId);
				await ctx.db.patch("plugins_data_projection_states", state._id, { scheduledJobId: undefined });
			}

			await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "council",
				collection: "meetings",
				key: "oldest-dirty",
				value: meeting_value({ meetingId: "oldest-dirty", title: "Oldest dirty" }),
				byteSize: 200,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt,
			});
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "oldest-dirty",
				queuedAt: updatedAt - 1,
				updatedAt,
			});

			for (let index = 0; index < 2501; index += 1) {
				const meetingId = `bulk-${String(index).padStart(4, "0")}`;
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "meetings",
					key: meetingId,
					value: meeting_value({ meetingId, title: meetingId }),
					byteSize: 200,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});

		await t.action(internal.plugins_projections_council.sync, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
		});

		const state = await read_projection_state(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
		);
		expect(await read_meeting_mapping(t, fixture.installationId, "oldest-dirty")).not.toBeNull();
		expect(state?.scanCursors?.meetings).toBeDefined();
		expect(state?.scheduledJobId).toBeDefined();
		expect(state?.dirty).toBe(true);
		expect(dirty).toHaveLength(2497);
	});

	test("a capped Council scan schedules after a thrown file write", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const before = await read_projection_state(t, fixture.installationId);
		if (!before) {
			throw new Error("Expected projection state");
		}
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			if (before.scheduledJobId) {
				await ctx.scheduler.cancel(before.scheduledJobId);
				await ctx.db.patch("plugins_data_projection_states", before._id, { scheduledJobId: undefined });
			}

			await ctx.db.insert("plugins_data", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "council",
				collection: "meetings",
				key: "oldest-thrown",
				value: meeting_value({ meetingId: "oldest-thrown", title: "Oldest thrown" }),
				byteSize: 200,
				revision: 1,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt,
			});
			await ctx.db.insert("plugins_data_projection_dirty_channels", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				channelKey: "oldest-thrown",
				queuedAt: updatedAt - 1,
				updatedAt,
			});

			for (let index = 0; index < 2501; index += 1) {
				const meetingId = `thrown-${String(index).padStart(4, "0")}`;
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "meetings",
					key: meetingId,
					value: meeting_value({ meetingId, title: meetingId }),
					byteSize: 200,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt,
				});
			}
		});
		vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("R2 upload failed"));

		await t.action(internal.plugins_projections_council.sync, {
			installationId: fixture.installationId,
			syncGeneration: before.syncGeneration,
		});

		const after = await read_projection_state(t, fixture.installationId);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", "oldest-thrown"),
				)
				.first(),
		);
		expect(after?.scanCursors?.meetings).toBeDefined();
		expect(after?.scheduledJobId).toBeDefined();
		expect(after?.syncGeneration).toBe(before.syncGeneration + 1);
		expect(dirty).not.toBeNull();
		expect(await read_meeting_mapping(t, fixture.installationId, "oldest-thrown")).toBeNull();
	});

	test("Council reconcile resumes through a durable one-key cursor", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const holder = await t.action(internal.files_nodes_content.create_file_by_path, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId: fixture.userId,
			path: "/council-reconcile-holder.md",
			textContent: "holder",
		});
		if (holder._nay) {
			throw new Error(holder._nay.message);
		}
		await t.run(async (ctx) => {
			for (const channelKey of ["dead-a", "dead-b", "dead-c"]) {
				await ctx.db.insert("plugins_data_projection_files", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					channelKey,
					fileNodeId: holder._yay.nodeId,
					rolloverIndex: 0,
					path: `/meetings/${channelKey}/meeting.md`,
					updatedAt: Date.now(),
				});
			}
		});

		const pending: boolean[] = [];
		const cursors: Array<string | undefined> = [];
		pending.push(
			await t.mutation(internal.plugins_projections_council.reconcile_meetings, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				keyLimit: 1,
			}),
		);
		cursors.push((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey);

		// A source write or physical delete starts a new generation. Restart the sweep so a dead
		// meeting behind the saved cursor cannot wait until the hourly backstop.
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		expect((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey).toBeUndefined();
		for (let call = 0; call < 4; call += 1) {
			pending.push(
				await t.mutation(internal.plugins_projections_council.reconcile_meetings, {
					installationId: fixture.installationId,
					syncGeneration: await read_sync_generation(t, fixture.installationId),
					keyLimit: 1,
				}),
			);
			cursors.push((await read_projection_state(t, fixture.installationId))?.reconcileAfterChannelKey);
		}

		expect(pending).toEqual([true, true, true, true, false]);
		expect(cursors).toEqual(["dead-a", "dead-a", "dead-b", "dead-c", undefined]);
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
		);
		expect(dirty.map((row) => row.channelKey).sort()).toEqual(["dead-a", "dead-b", "dead-c"]);
	});

	test("a failed queue head moves behind healthy Council work in the next generation", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);

		// Occupy both paths Council can use for the first meeting. Its write will always fail,
		// while the second meeting still has a free destination.
		for (const path of [MEETING_PATH, MEETING_COLLISION_PATH]) {
			const occupant = await t.action(internal.files_nodes_content.create_file_by_path, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId: fixture.userId,
				path,
				textContent: "member-owned Council note",
			});
			if (occupant._nay) {
				throw new Error(occupant._nay.message);
			}
		}

		for (const [meetingId, title] of [
			[MEETING_ID, "Blocked meeting"],
			[SECOND_MEETING_ID, "Healthy meeting"],
		] as const) {
			const written = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal: service_principal(fixture),
				collection: "meetings",
				key: meetingId,
				revision: 1,
				value: meeting_value({ meetingId, title }),
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
		}

		await t.mutation(internal.plugins_projections.schedule_sync, {
			installationId: fixture.installationId,
		});
		const firstGeneration = await read_sync_generation(t, fixture.installationId);
		await t.action(internal.plugins_projections_council.sync, {
			installationId: fixture.installationId,
			syncGeneration: firstGeneration,
		});

		const afterFailure = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_queuedAt", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(afterFailure.map((row) => row.channelKey)).toEqual([SECOND_MEETING_ID, MEETING_ID]);
		if (afterFailure[0]?.queuedAt === undefined || afterFailure[1]?.queuedAt === undefined) {
			throw new Error("Expected both claimed queue rows to have FIFO stamps");
		}
		expect(afterFailure[1].queuedAt).toBeGreaterThan(afterFailure[0].queuedAt);

		await t.mutation(internal.plugins_projections.schedule_sync, {
			installationId: fixture.installationId,
		});
		const secondGeneration = await read_sync_generation(t, fixture.installationId);
		await t.action(internal.plugins_projections_council.sync, {
			installationId: fixture.installationId,
			syncGeneration: secondGeneration,
		});

		expect(await read_meeting_mapping(t, fixture.installationId, SECOND_MEETING_ID)).not.toBeNull();
		expect(await read_meeting_mapping(t, fixture.installationId, MEETING_ID)).toBeNull();
		expect((await read_projection_file(t, fixture, SECOND_MEETING_PATH))?.content).toContain("# Healthy meeting");
		const remaining = await t.run(
			async (ctx) =>
				await ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
		);
		expect(remaining.map((row) => row.channelKey)).toEqual([MEETING_ID]);
	});

	test("a stale Council generation cannot rotate the dirty queue", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const staleGeneration = await read_sync_generation(t, fixture.installationId);
		await seed_council_dirty(t, fixture);

		await t.mutation(internal.plugins_projections.schedule_sync, { installationId: fixture.installationId });
		const before = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
				)
				.first(),
		);
		const claimed = await t.mutation(internal.plugins_projections_council.peek_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: staleGeneration,
		});
		const after = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
				)
				.first(),
		);

		expect(claimed).toBeNull();
		expect(after?.queuedAt).toBe(before?.queuedAt);
		expect(after?.updatedAt).toBe(before?.updatedAt);
	});

	test.each(["asset", "move", "archive"] as const)(
		"completion keeps the Council dirty row after a supported %s race",
		async (race) => {
			vi.useFakeTimers();
			const t = test_convex();
			const fixture = await seed_council_install(t);
			const written = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal: service_principal(fixture),
				collection: "meetings",
				key: MEETING_ID,
				revision: 1,
				value: meeting_value(),
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
			await flush_projection(t);

			const mapped = await read_meeting_mapping(t, fixture.installationId);
			if (!mapped?.node?.assetId) {
				throw new Error("Expected mapped Council note");
			}
			const dirtyStamp = await seed_council_dirty(t, fixture);
			// Public lock controls refuse projection-owned nodes. Patch the stale state directly so
			// completion still proves it keeps work after an invalid in-flight file change.
			await t.run(async (ctx) => {
				await ctx.db.patch("files_nodes", mapped.node!._id, { readOnlyScopeNodeId: undefined });
			});

			if (race === "asset") {
				const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: fixture.membershipId,
					nodeId: mapped.node._id,
					text: "member council edit",
					baseAssetId: mapped.node.assetId,
				});
				expect(saved._nay).toBeUndefined();
				expect(saved._yay?.assetId).not.toBe(mapped.node.assetId);
			} else if (race === "move") {
				const target = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: fixture.membershipId,
					parentId: files_ROOT_ID,
					path: "council-race-target",
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

			await t.mutation(internal.plugins_projections_council.complete_dirty_channel, {
				installationId: fixture.installationId,
				syncGeneration: await read_sync_generation(t, fixture.installationId),
				channelKey: MEETING_ID,
				updatedAt: dirtyStamp,
				files: [{ rolloverIndex: 0, path: mapped.row.path }],
			});
			const dirtyStillExists = await t.run(async (ctx) =>
				ctx.db
					.query("plugins_data_projection_dirty_channels")
					.withIndex("by_installation_channelKey", (q) =>
						q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
					)
					.first(),
			);
			expect(dirtyStillExists).not.toBeNull();
		},
	);

	test("an unlocked Council note is replaced with a self-locked note and does not block later dirty work", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const first = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		await flush_projection(t);

		const mapped = await read_meeting_mapping(t, fixture.installationId);
		if (!mapped?.node?.assetId) {
			throw new Error("Expected mapped Council note");
		}
		const dirtyStamp = await seed_council_dirty(t, fixture);
		// Public lock controls refuse projection-owned nodes. Patch the stale state directly so
		// the repair flow still covers an old unlocked projection note.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", mapped.node!._id, { readOnlyScopeNodeId: undefined });
		});
		const saved = await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: fixture.membershipId,
			nodeId: mapped.node._id,
			text: "member council edit",
			baseAssetId: mapped.node.assetId,
		});
		expect(saved._nay).toBeUndefined();
		await t.mutation(internal.plugins_projections_council.complete_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration: await read_sync_generation(t, fixture.installationId),
			channelKey: MEETING_ID,
			updatedAt: dirtyStamp,
			files: [{ rolloverIndex: 0, path: mapped.row.path }],
		});

		const second = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: SECOND_MEETING_ID,
			revision: 1,
			value: meeting_value({ meetingId: SECOND_MEETING_ID, title: "Second meeting" }),
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		await flush_projection(t);

		const repaired = await read_meeting_mapping(t, fixture.installationId);
		expect(repaired?.node?._id).not.toBe(mapped.node._id);
		expect(repaired?.node?.readOnlyScopeNodeId).toBe(repaired?.node?._id);
		expect((await read_projection_file(t, fixture, MEETING_PATH))?.content).not.toContain("member council edit");
		expect((await read_projection_file(t, fixture, SECOND_MEETING_PATH))?.content).toContain("# Second meeting");
		expect(await read_meeting_mapping(t, fixture.installationId, SECOND_MEETING_ID)).not.toBeNull();
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
		);
		expect(dirty).toEqual([]);
	});

	test("a Council store write during a claimed rebuild keeps the dirty row and queue stamp", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const fixture = await seed_council_install(t);
		const first = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 1,
			value: meeting_value(),
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		await flush_projection(t);
		const mapped = await read_meeting_mapping(t, fixture.installationId);
		if (!mapped) {
			throw new Error("Expected Council mapping");
		}
		await seed_council_dirty(t, fixture);
		const syncGeneration = await read_sync_generation(t, fixture.installationId);
		const claimed = await t.mutation(internal.plugins_projections_council.peek_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration,
		});
		if (!claimed) {
			throw new Error("Expected Council dirty meeting claim");
		}
		const claimedQueueAt = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("plugins_data_projection_dirty_channels")
						.withIndex("by_installation_channelKey", (q) =>
							q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
						)
						.first()
				)?.queuedAt,
		);
		vi.advanceTimersByTime(1);
		const changed = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: MEETING_ID,
			revision: 2,
			value: meeting_value({ title: "changed during rebuild" }),
		});
		if (changed._nay) {
			throw new Error(changed._nay.message);
		}
		await t.mutation(internal.plugins_projections_council.advance_collection_cursor, {
			installationId: fixture.installationId,
			syncGeneration,
			runStartMs: Date.now(),
		});
		await t.mutation(internal.plugins_projections_council.complete_dirty_channel, {
			installationId: fixture.installationId,
			syncGeneration,
			channelKey: MEETING_ID,
			updatedAt: claimed.updatedAt,
			files: [{ rolloverIndex: 0, path: mapped.row.path }],
		});
		const dirty = await t.run(async (ctx) =>
			ctx.db
				.query("plugins_data_projection_dirty_channels")
				.withIndex("by_installation_channelKey", (q) =>
					q.eq("installationId", fixture.installationId).eq("channelKey", MEETING_ID),
				)
				.first(),
		);
		expect(dirty?.updatedAt).toBeGreaterThan(claimed.updatedAt);
		expect(dirty?.queuedAt).toBe(claimedQueueAt);
	});
});
