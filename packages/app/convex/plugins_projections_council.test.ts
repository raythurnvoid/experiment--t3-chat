import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
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

const MEETING_ID = "af26438a-1234-4147-aeac-4abea4eb0495";
const MEETING_PATH = `/meetings/${MEETING_ID}/meeting.md`;

function meeting_value(
	args: {
		title?: string;
		status?: string;
		recordingWarning?: string | null;
		artifacts?: { kind: string; fileName: string }[];
	} = {},
) {
	return {
		meetingId: MEETING_ID,
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
		expect(meetingFile?.readOnlyScopeNodeId).toBe(file!.nodeId);
		expect(meetingFile?.nonCollaborative).toBe(true);
		expect(file?.content).not.toContain("Council could not store the video recording");
		expect(meetingsFolder?.readOnlyScopeNodeId).toBeUndefined();
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

	test("hourly ensure pages council installations", async () => {
		const t = test_convex();
		const fixture = await seed_council_install(t);

		await t.mutation(internal.plugins_projections.ensure_hourly, { pluginName: "council" });
		const states = await t.run(async (ctx) => await ctx.db.query("plugins_data_projection_states").collect());
		expect(states).toHaveLength(1);
		expect(states[0]?.pluginName).toBe("council");
		expect(states[0]?.installationId).toBe(fixture.installationId);
	});
});
