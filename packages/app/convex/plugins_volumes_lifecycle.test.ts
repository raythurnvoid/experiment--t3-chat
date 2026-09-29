import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	plugins_volumes_db_drain_batch,
	plugins_volumes_db_retire_generation,
	plugins_volumes_db_schedule_volume_drain,
} from "./plugins_volumes.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

const test = baseTest.sequential;
const RETENTION_MS = 10 * 60 * 1000;
let deleteObjectSpy: MockInstance;

beforeEach(() => {
	vi.useFakeTimers();
	deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "volume-team" }));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const pluginVersionId = await t.run((ctx) =>
		ctx.db.insert("plugins_versions", {
			name: "volume-test",
			displayName: "Volume test",
			version: "0.1.0",
			description: "External records",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/example/volume-test",
			sourceOwner: "example",
			sourceRepo: "volume-test",
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: "plugins/volume-test/manifest.json",
			backendEntrypointFile: null,
			configuration: { description: "Mount name", defaultYaml: "mount:\n  name: records\n" },
			mounts: [{ id: "records", description: "External records", configurationPath: ["mount", "name"] }],
			events: [],
			capabilities: ["workspace.volumes.write"],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "volume-test-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: owner.userId,
			updatedAt: Date.now(),
		}),
	);
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: owner.membershipId,
		pluginVersionId,
		acceptedCapabilities: ["workspace.volumes.write"],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: "volume-test-mcp",
		acceptedSkillNames: [],
	});
	if (installed._nay) throw new Error(installed._nay.message);
	const installationId = installed._yay.installationId;
	const volumeId = await t.run(async (ctx) => {
		await ctx.db.insert("plugins_volume_usage", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			installationId,
			fileCount: 0,
			bytes: 0,
		});
		return await ctx.db.insert("plugins_volumes", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			installationId,
			mountId: "records",
			volumeKey: "sample",
			publishedGenerationId: null,
			createdAt: Date.now(),
			deleteRequestedAt: null,
			drainScheduledUntil: null,
		});
	});
	return { t, asOwner, ...owner, installationId, pluginVersionId, volumeId };
}

async function seed_generation(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		volumeId: Id<"plugins_volumes">;
		status: Doc<"plugins_volume_generations">["status"];
		fileCount: number;
	},
) {
	const now = Date.now();
	const generationId = await ctx.db.insert("plugins_volume_generations", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		volumeId: args.volumeId,
		status: args.status,
		revision: "revision-1",
		fileCount: args.fileCount,
		bytes: args.fileCount * 2,
		createdAt: now,
		lastWriteAt: now,
		publishedAt: args.status === "published" ? now : null,
		expiresAt:
			args.status === "published" ? null : now + (args.status === "retired" ? RETENTION_MS : 26 * 60 * 60 * 1000),
		drainScheduledUntil: null,
	});
	const folderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: args.organizationId,
		workspaceId: args.volumeId,
		createdBy: users_SYSTEM_AUTHOR,
		updatedBy: users_SYSTEM_AUTHOR,
		parentId: "root",
		name: generationId,
		path: `/${generationId}`,
		treePath: `/${generationId}/`,
		pathDepth: 1,
	});
	for (let index = 0; index < args.fileCount; index++) {
		const path = `/${generationId}/item-${index}.json`;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.volumeId,
			kind: "content",
			r2Bucket: "test-files",
			r2Key: `volumes/${args.volumeId}/${generationId}/${index}`,
			size: 2,
			createdBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		});
		const fileNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: args.organizationId,
			workspaceId: args.volumeId,
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
			kind: "file",
			parentId: folderId,
			name: `item-${index}.json`,
			path,
			treePath: `${path}/`,
			pathDepth: 2,
			lowercaseExtension: "json",
			contentType: "application/json",
			assetId,
			contentByteSize: 2,
			textKind: "plain_text",
			collaborationEnabled: false,
		});
		const chunks = {
			organizationId: args.organizationId,
			workspaceId: args.volumeId,
			sourceKind: "committed" as const,
			fileNodeId,
			chunkIndex: 0,
			textChunk: "{}",
			startIndex: 0,
			endIndex: 2,
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		};
		const textChunkId = await ctx.db.insert("files_text_chunks", chunks);
		await ctx.db.insert("files_plain_text_chunks", {
			...chunks,
			textChunkId,
			path,
			plainTextChunk: "{}",
			hasChunkAbove: false,
			hasChunkBelow: false,
		});
		await ctx.db.insert("files_metadata_docs", {
			organizationId: args.organizationId,
			workspaceId: args.volumeId,
			sourceKind: "committed",
			fileNodeId,
			path,
			treePath: `${path}/`,
			fieldPath: "metadata.source",
			docKind: "value",
			valueKind: "string",
			stringValue: "records",
		});
		await ctx.db.insert("file_stats", {
			organizationId: args.organizationId,
			workspaceId: args.volumeId,
			fileNodeId,
			lineCount: 0,
			wordCount: 1,
			charCount: 2,
		});
	}
	if (args.status !== "retired") {
		const usage = await ctx.db
			.query("plugins_volume_usage")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("installationId", args.installationId),
			)
			.unique();
		if (!usage) throw new Error("Expected volume usage");
		await ctx.db.patch("plugins_volume_usage", usage._id, {
			fileCount: usage.fileCount + args.fileCount,
			bytes: usage.bytes + args.fileCount * 2,
		});
	}
	if (args.status === "published")
		await ctx.db.patch("plugins_volumes", args.volumeId, { publishedGenerationId: generationId });
	return generationId;
}

const scope_tables = [
	"files_nodes",
	"files_text_chunks",
	"files_plain_text_chunks",
	"files_metadata_docs",
	"file_stats",
	"files_r2_assets",
] as const;

async function read_scope_counts(t: ReturnType<typeof test_convex>, volumeId: Id<"plugins_volumes">) {
	return await t.run(async (ctx) => {
		const counts: Record<string, number> = {};
		for (const tableName of scope_tables)
			counts[tableName] = (await ctx.db.query(tableName).collect()).filter(
				(doc) => doc.workspaceId === volumeId,
			).length;
		return counts;
	});
}

async function seed_installation_grants(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
	},
) {
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership) throw new Error("Expected live membership");
	const grant = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		resourceKind: "plugin_installation" as const,
		resourceId: args.installationId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	await ctx.db.insert("access_control_permission_grants", {
		...grant,
		principalKind: "user",
		userId: args.userId,
		permission: "workspace.plugins.manage",
	});
	await ctx.db.insert("access_control_permission_grants", {
		...grant,
		principalKind: "role",
		role: "viewer",
		permission: "workspace.plugins.manage",
	});
	await ctx.db.insert("access_control_permission_grants", {
		...grant,
		principalKind: "user",
		userId: args.userId,
		permission: "plugin.run_as",
		runAs: { membershipId: args.membershipId, membershipLifetime: membership._creationTime, scopes: ["volumes:write"] },
	});
}

async function seed_history(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		pluginVersionId: Id<"plugins_versions">;
		userId: Id<"users">;
	},
) {
	const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
	if (!installation) throw new Error("Expected installation");
	const runId = await ctx.db.insert("plugins_event_runs", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		pluginVersionId: args.pluginVersionId,
		serviceAccountId: installation.serviceAccountId,
		actorUserId: args.userId,
		event: "ui.invoke.requested",
		eventId: "history",
		acceptedCapabilities: installation.acceptedCapabilities,
		apiCallCount: 1,
		outputWriteCount: 0,
	});
	const activityId = await ctx.db.insert("activities", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		source: {
			kind: "plugin_run",
			id: runId,
			installationId: args.installationId,
			pluginName: installation.pluginName,
			event: "ui.invoke.requested",
		},
		title: "Volume test",
		targets: [],
		visibility: "shared",
		feedVisible: false,
		resultKind: "plugin_result",
		status: "succeeded",
		deadlineAt: Date.now(),
		errorMessage: null,
		updatedAt: Date.now(),
		finishedAt: Date.now(),
	});
	const callId = await ctx.db.insert("plugins_event_run_calls", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		pluginVersionId: args.pluginVersionId,
		runId,
		sequence: 1,
		kind: "api_request",
		route: "/api/v1/volumes/publish",
		status: "succeeded",
		errorMessage: null,
		startedAt: Date.now(),
		updatedAt: Date.now(),
	});
	return { runId, activityId, callId };
}

describe("plugins_volumes_db_schedule_volume_drain", () => {
	test("self-continues until all six file scope tables of a 500-file volume are empty", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 500 }));
		await f.t.run((ctx) => plugins_volumes_db_schedule_volume_drain(ctx, { volumeId: f.volumeId }));
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_scope_counts(f.t, f.volumeId), "volume drain must empty all six scope tables").toEqual(
			Object.fromEntries(scope_tables.map((name) => [name, 0])),
		);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_generations").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 0,
			bytes: 0,
		});
		expect(deleteObjectSpy).toHaveBeenCalledTimes(500);
	});

	test("two cron ticks keep one leased loop and an expired lease gets a new owner", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 50 }));
		await f.t.run((ctx) =>
			ctx.db.patch("plugins_volumes", f.volumeId, { deleteRequestedAt: Date.now(), drainScheduledUntil: 0 }),
		);
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		const readJobs = () =>
			f.t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).filter(
					(job) => job.name === "plugins_volumes:drain_volume",
				),
			);
		const jobs = await readJobs();
		expect(jobs).toHaveLength(1);
		const previousLease = (await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId)))!.drainScheduledUntil!;
		vi.setSystemTime(Date.now() + RETENTION_MS + 1);
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		expect(await readJobs()).toHaveLength(2);
		expect(
			await f.t.mutation(internal.plugins_volumes.drain_volume, { volumeId: f.volumeId, leaseUntil: previousLease }),
		).toEqual({ done: true });
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).not.toBeNull();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toBeNull();
	});
});

describe("plugins_volumes_db_retire_generation", () => {
	test("releases once and keeps the old files for ten minutes", async () => {
		const f = await fixture();
		const oldId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 1 }));
		const liveId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "staging", fileCount: 2 }));
		await f.t.run(async (ctx) => {
			await plugins_volumes_db_retire_generation(ctx, { generationId: oldId });
			await ctx.db.patch("plugins_volume_generations", liveId, {
				status: "published",
				publishedAt: Date.now(),
				expiresAt: null,
			});
			await ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: liveId });
		});
		const retired = await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", oldId));
		await f.t.run((ctx) => plugins_volumes_db_retire_generation(ctx, { generationId: oldId }));
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 2,
			bytes: 4,
		});
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", oldId))).toEqual(retired);
		vi.setSystemTime(Date.now() + RETENTION_MS - 1);
		await f.t.mutation(internal.plugins_volumes.drain_generation, {
			generationId: oldId,
			leaseUntil: retired!.drainScheduledUntil!,
		});
		expect((await read_scope_counts(f.t, f.volumeId)).files_nodes).toBe(5);
		vi.setSystemTime(Date.now() + 1);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", oldId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", liveId))).not.toBeNull();
		expect((await read_scope_counts(f.t, f.volumeId)).files_nodes).toBe(3);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 2,
			bytes: 4,
		});
	});
});

describe("gc_expired", () => {
	test("skips fifty live deletion leases and also recovers expired staging and retired copies", async () => {
		const f = await fixture();
		const staleId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "staging", fileCount: 1 }));
		const retiredId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 1 }));
		await f.t.run(async (ctx) => {
			await plugins_volumes_db_retire_generation(ctx, { generationId: retiredId });
			await ctx.db.patch("plugins_volumes", f.volumeId, { publishedGenerationId: null });
			for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
				if (job.name === "plugins_volumes:drain_generation") await ctx.scheduler.cancel(job._id);
			}
		});
		const expiry = (await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId)))!.expiresAt!;
		vi.setSystemTime(expiry);
		const lastVolumeId = await f.t.run(async (ctx) => {
			let lastId = f.volumeId;
			for (let index = 0; index < 51; index++) {
				lastId = await ctx.db.insert("plugins_volumes", {
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					installationId: f.installationId,
					mountId: index < 32 ? "dropped-a" : "dropped-b",
					volumeKey: `old-${index}`,
					publishedGenerationId: null,
					createdAt: Date.now() - 60_000,
					deleteRequestedAt: Date.now() - 51 + index,
					drainScheduledUntil: index === 50 ? Date.now() - 1 : Date.now() + RETENTION_MS,
				});
			}
			return lastId;
		});
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_volumes", lastVolumeId)),
			"GC must reach the expired lease after fifty live leases",
		).toMatchObject({ drainScheduledUntil: Date.now() + RETENTION_MS });
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId)),
			"live volume leases must not starve expired staging",
		).toMatchObject({ status: "retired" });
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", retiredId))).toMatchObject({
			drainScheduledUntil: Date.now() + RETENTION_MS,
		});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", lastVolumeId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", retiredId))).toBeNull();
	});

	test("expires staging after 26 hours and leaves a current published copy", async () => {
		const f = await fixture();
		const liveId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 2 }));
		const staleId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "staging", fileCount: 1 }));
		const expiry = (await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId)))!.expiresAt!;
		vi.setSystemTime(expiry - 1);
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId))).toMatchObject({
			status: "staging",
		});
		vi.setSystemTime(expiry);
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 2,
			bytes: 4,
		});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", staleId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volume_generations", liveId))).not.toBeNull();
	});
});

describe("plugins_volumes_db_drain_batch", () => {
	test("bounds deletion to 200 documents and refuses a different workspace", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 50 }));
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-team" }));
		const before = await read_scope_counts(f.t, f.volumeId);
		expect(
			await f.t.run((ctx) =>
				plugins_volumes_db_drain_batch(ctx, { ...other, installationId: null, volumeId: f.volumeId, batchSize: 1000 }),
			),
		).toEqual({ done: true, deletedCount: 0 });
		expect(await read_scope_counts(f.t, f.volumeId)).toEqual(before);
		const result = await f.t.run((ctx) => plugins_volumes_db_drain_batch(ctx, { ...f, batchSize: 1000 }));
		expect(result.done).toBe(false);
		const after = await read_scope_counts(f.t, f.volumeId);
		const deletedCount =
			Object.values(before).reduce((a, b) => a + b, 0) - Object.values(after).reduce((a, b) => a + b, 0);
		expect(deletedCount).toBeLessThanOrEqual(200);
		expect(result.deletedCount).toBe(deletedCount);
	});

	test("removes unlinked assets and chunks before removing the volume", async () => {
		const f = await fixture();
		const generationId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 1 }));
		await f.t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.filter((q) => q.and(q.eq(q.field("workspaceId"), f.volumeId), q.eq(q.field("kind"), "file")))
				.unique();
			if (!node) throw new Error("Expected fixture file");
			await ctx.db.delete("files_nodes", node._id);
		});
		await f.t.run((ctx) => plugins_volumes_db_schedule_volume_drain(ctx, { volumeId: f.volumeId }));
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_scope_counts(f.t, f.volumeId)).toEqual(Object.fromEntries(scope_tables.map((name) => [name, 0])));
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), `volumes/${f.volumeId}/${generationId}/0`);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toBeNull();
	});
});

describe("uninstall_version volume lifecycle", () => {
	test("drains its files and grants while keeping terminal run history", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 3 }));
		const history = await f.t.run(async (ctx) => {
			await seed_installation_grants(ctx, f);
			return await seed_history(ctx, f);
		});
		expect(
			await f.asOwner.mutation(api.plugins.uninstall_version, {
				membershipId: f.membershipId,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("plugins_mounts").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toMatchObject({
			deleteRequestedAt: expect.any(Number),
		});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_scope_counts(f.t, f.volumeId), "uninstall must empty all six volume scope tables").toEqual(
			Object.fromEntries(scope_tables.map((name) => [name, 0])),
		);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volumes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_generations").collect())).toEqual([]);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("access_control_permission_grants")
					.filter((q) => q.eq(q.field("resourceKind"), "plugin_installation"))
					.collect(),
			),
		).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_event_runs", history.runId))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", history.activityId))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_event_run_calls", history.callId))).not.toBeNull();
		expect(deleteObjectSpy).toHaveBeenCalledTimes(3);
	});

	test("cron recovers the files when the uninstall data job is interrupted", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 2 }));
		expect(
			await f.asOwner.mutation(api.plugins.uninstall_version, {
				membershipId: f.membershipId,
				installationId: f.installationId,
			}),
		).toEqual({ _yay: null });
		await f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
				if (job.name === "plugins_data:drain_uninstalled_installation") await ctx.scheduler.cancel(job._id);
			}
		});
		await f.t.mutation(internal.plugins_volumes.gc_expired, {});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId)),
			"cron must recover interrupted uninstall",
		).toBeNull();
		expect(await read_scope_counts(f.t, f.volumeId)).toEqual(Object.fromEntries(scope_tables.map((name) => [name, 0])));
		expect(deleteObjectSpy).toHaveBeenCalledTimes(2);
	});
});

describe("install_version mount lifecycle", () => {
	test("a rename keeps the volume, and a no-config upgrade drops and drains it", async () => {
		const f = await fixture();
		await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 2 }));
		expect(
			await f.asOwner.mutation(api.plugins.update_installation_configuration, {
				membershipId: f.membershipId,
				installationId: f.installationId,
				configurationYaml: "mount:\n  name: renamed\n",
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("plugins_mounts").unique())).toMatchObject({ name: "renamed" });
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toMatchObject({
			deleteRequestedAt: null,
		});
		const nextId = await f.t.run(async (ctx) => {
			const previous = await ctx.db.get("plugins_versions", f.pluginVersionId);
			if (!previous) throw new Error("Expected plugin version");
			const { _id, _creationTime, ...version } = previous;
			return await ctx.db.insert("plugins_versions", {
				...version,
				version: "0.2.0",
				configuration: null,
				mounts: [],
				capabilities: [],
			});
		});
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: f.userId }),
		);
		expect(
			await f.asOwner.mutation(api.plugins.install_version, {
				membershipId: f.membershipId,
				pluginVersionId: nextId,
				acceptedCapabilities: [],
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				acceptedMcpServersFingerprint: "volume-test-mcp",
				acceptedSkillNames: [],
			}),
		).toEqual({ _yay: { installationId: f.installationId } });
		expect(await f.t.run((ctx) => ctx.db.query("plugins_mounts").collect())).toEqual([]);
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await read_scope_counts(f.t, f.volumeId), "mount drop must empty all six volume scope tables").toEqual(
			Object.fromEntries(scope_tables.map((name) => [name, 0])),
		);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_generations").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 0,
			bytes: 0,
		});
		expect(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId))).toMatchObject({
			pluginVersionId: nextId,
		});
		expect(deleteObjectSpy).toHaveBeenCalledTimes(2);
	});
});

describe("hard_delete_plugin_from_registry volume lifecycle", () => {
	test("preview counts volume data and the guarded drain removes it", async () => {
		const f = await fixture();
		const generationId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 2 }));
		await f.t.run((ctx) => seed_installation_grants(ctx, f));
		expect(
			await f.t.query(internal.plugins.preview_hard_delete_registered_plugin, { pluginName: "volume-test" }),
		).toMatchObject({
			previewTruncated: false,
			pluginMounts: 1,
			pluginVolumes: 1,
			pluginVolumeGenerations: 1,
			pluginVolumeUsageDocs: 1,
			volumeFileNodes: 3,
			volumeR2Assets: 2,
			pluginInstallationGrants: 3,
		});
		let done = false;
		for (let pass = 0; pass < 100 && !done; pass++) {
			const result = await f.t.mutation(internal.plugins.hard_delete_plugin_from_registry, {
				pluginName: "volume-test",
				_test_batchSize: 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		expect(
			await read_scope_counts(f.t, f.volumeId),
			"registry deletion must empty all six volume scope tables",
		).toEqual(Object.fromEntries(scope_tables.map((name) => [name, 0])));
		for (const tableName of [
			"plugins_mounts",
			"plugins_volumes",
			"plugins_volume_generations",
			"plugins_volume_usage",
			"plugins_workspace_installations",
			"access_control_permission_grants",
		] as const)
			expect(await f.t.run((ctx) => ctx.db.query(tableName).collect()), tableName).toEqual([]);
		expect(
			await f.t.query(internal.plugins.preview_hard_delete_registered_plugin, { pluginName: "volume-test" }),
		).toMatchObject({
			pluginMounts: 0,
			pluginVolumes: 0,
			pluginVolumeGenerations: 0,
			pluginVolumeUsageDocs: 0,
			volumeFileNodes: 0,
			volumeR2Assets: 0,
			pluginInstallationGrants: 0,
		});
		for (const index of [0, 1])
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), `volumes/${f.volumeId}/${generationId}/${index}`);
	});
});

describe("account deletion volume lifecycle", () => {
	test("removes a member's self-consent and keeps the shared published volume", async () => {
		const f = await fixture();
		const generationId = await f.t.run((ctx) => seed_generation(ctx, { ...f, status: "published", fileCount: 1 }));
		const member = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userIdToAdd: member.userId,
			}),
		).toEqual({ _yay: null });
		const grantId = await f.t.run(async (ctx) => {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.workspaceId).eq("userId", member.userId).eq("active", true),
				)
				.unique();
			if (!membership) throw new Error("Expected shared membership");
			return await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				resourceKind: "plugin_installation",
				resourceId: f.installationId,
				principalKind: "user",
				userId: member.userId,
				permission: "plugin.run_as",
				runAs: { membershipId: membership._id, membershipLifetime: membership._creationTime, scopes: [] },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const requestId = await f.t.mutation(internal.data_deletion.init_user_deletion, {
			userId: member.userId,
			nowTs: Date.now(),
		});
		if (!requestId) throw new Error("Expected deletion request");
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
		let done = false;
		for (let pass = 0; pass < 1000 && !done; pass++) {
			const result = await f.t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			done = result.done;
		}
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("access_control_permission_grants", grantId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_volumes", f.volumeId))).toMatchObject({
			publishedGenerationId: generationId,
			deleteRequestedAt: null,
		});
		expect((await read_scope_counts(f.t, f.volumeId)).files_nodes).toBe(2);
		expect(await f.t.run((ctx) => ctx.db.query("plugins_volume_usage").unique())).toMatchObject({
			fileCount: 1,
			bytes: 2,
		});
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});
});
