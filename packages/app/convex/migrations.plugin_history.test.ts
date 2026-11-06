import { afterEach, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import type { WorkId } from "@convex-dev/workpool";

import { internal } from "./_generated/api.js";
import { activities_db_start } from "./activities_db.ts";
import { fixture } from "./files_archive_runs.setup.test.ts";
import { insert_installation } from "./files_share_links.setup.test.ts";
import {
	normalize_plugin_run_pairs,
	normalize_plugin_target_pairs,
	retire_plugin_grants_without_pairs,
	remove_plugin_file_access_model,
} from "./migrations.ts";
import { transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { test_db_hold_move_source, test_mocks, test_spy_handler } from "./setup.test.ts";

afterEach(() => vi.restoreAllMocks());

async function history(count = 1) {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const historyIds = await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		await ctx.db.patch("plugins_workspace_installations", installationId, { fileAccessModel: "personal" });
		const tenant = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
		const saved = [];
		for (let index = 0; index < count; index++) {
			const runId = await ctx.db.insert("plugins_event_runs", {
				...tenant,
				installationId,
				pluginVersionId: installation.pluginVersionId,
				serviceAccountId: installation.serviceAccountId,
				actorUserId: f.db.userId,
				event: "ui.invoke.requested",
				eventId: `history-${index}`,
				acceptedCapabilities: [],
				apiCallCount: 3,
				outputWriteCount: 1,
			});
			const activityId = await activities_db_start(ctx, {
				...tenant,
				userId: f.db.userId,
				source: {
					kind: "plugin_run",
					id: runId,
					installationId,
					pluginName: installation.pluginName,
					event: "ui.invoke.requested",
				},
				title: "Finished plugin work",
				targets: [],
				visibility: "shared",
				feedVisible: false,
				status: "running",
				resultKind: "plugin_result",
				deadlineAt: 100,
				now: 1,
			});
			await ctx.db.patch("activities", activityId, { status: "succeeded", finishedAt: 2 });
			const grantId = await ctx.db.insert("plugin_service_grants", {
				...tenant,
				installationId,
				pluginVersionId: installation.pluginVersionId,
				pluginName: installation.pluginName,
				serviceAccountId: installation.serviceAccountId,
				actorUserId: f.db.userId,
				tokenHash: `history-token-${index}`,
				scopes: ["plugin_data:read", "files:write"],
				principalKey: `plugin_service:${installationId}`,
				phase: "processing",
				destinationPathPrefix: "/output",
				expiresAt: Date.now() + 86_400_000,
				updatedAt: 1,
				...(index === 1 ? { revokedAt: 3, revokedReason: "Already revoked" } : {}),
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				...tenant,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 12,
				storedFileBytes: 12,
				processingWorkId: null,
				createdBy: f.db.userId,
				updatedAt: 1,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				...tenant,
				kind: "file",
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				path: `/image-${index}.png`,
				name: `image-${index}.png`,
				assetId,
			});
			const targetId = await ctx.db.insert("plugin_service_storage_targets", {
				...tenant,
				installationId,
				...(index < 3 ? { serviceAccountId: installation.serviceAccountId } : {}),
				idempotencyKey: `history-${index}`,
				targetKey: `image-${index}`,
				requestFingerprint: `fingerprint-${index}`,
				force: false,
				readOnly: false,
				nonCollaborative: false,
				destinationPath: "/output",
				destinationNodeId: nodeId,
				destinationEpoch: 1,
				path: `/image-${index}.png`,
				contentType: "image/png",
				declaredBytes: 12,
				actualBytes: 12,
				chargedBytes: 12,
				nodeId,
				assetId,
				state: index % 2 === 0 ? "committed" : "released",
				createdBy: f.db.userId,
				updatedAt: 1,
			});
			saved.push({ runId, activityId, grantId, assetId, nodeId, targetId });
		}
		return saved;
	});
	return { ...f, installationId, historyIds };
}

async function saved_history(f: Awaited<ReturnType<typeof history>>) {
	return await f.t.run(async (ctx) => ({
		runs: await ctx.db.query("plugins_event_runs").collect(),
		grants: await ctx.db.query("plugin_service_grants").collect(),
		targets: await ctx.db.query("plugin_service_storage_targets").collect(),
		assets: await ctx.db.query("files_r2_assets").collect(),
		nodes: await ctx.db.query("files_nodes").collect(),
		accounts: await ctx.db.query("access_control_service_accounts").collect(),
		permissions: await ctx.db.query("access_control_permission_grants").collect(),
		activities: await ctx.db.query("activities").collect(),
	}));
}

const steps = {
	runs: internal.migrations.normalize_plugin_run_pairs,
	targets: internal.migrations.normalize_plugin_target_pairs,
	grants: internal.migrations.retire_plugin_grants_without_pairs,
	installations: internal.migrations.remove_plugin_file_access_model,
};

async function migrate(f: Awaited<ReturnType<typeof history>>, step: keyof typeof steps) {
	const sizes = [];
	let cursor: string | null = null;
	while (true) {
		const page: FunctionReturnType<typeof internal.migrations.normalize_plugin_run_pairs> = await f.t.mutation(
			steps[step],
			{ oneBatchOnly: true, dryRun: false, cursor },
		);
		sizes.push(page.processed);
		if (page.isDone) return sizes;
		cursor = page.continueCursor;
	}
}

test("history migration keeps every protected field across pages and safe repeats", async () => {
	const f = await history(56);
	// Removed installations keep their history too.
	await f.t.run((ctx) => ctx.db.delete("plugins_workspace_installations", f.installationId));
	const before = await saved_history(f);
	const costs: ReturnType<typeof transaction_cost>[] = [];
	test_spy_handler(normalize_plugin_target_pairs, async (handler, ctx, args) => {
		const metrics = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		costs.push(transaction_cost(metrics, await ctx.meta.getTransactionMetrics()));
		return result;
	});
	for (const step of ["runs", "targets", "grants"] as const) {
		const sizes = await migrate(f, step);
		expect(sizes.slice(0, 2), "retained history crosses native pages").toEqual([25, 25]);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(56);
	}
	const after = await saved_history(f);
	expect(after.runs, "old runs gain only an explicit null pair").toEqual(
		before.runs.map((run) => ({ ...run, filePairId: null })),
	);
	expect(after.targets, "old targets keep every field and original account pin").toEqual(
		before.targets.map((target) => ({
			...target,
			filePairId: null,
			serviceAccountId: target.serviceAccountId ?? null,
		})),
	);
	for (const [index, grant] of after.grants.entries()) {
		const original = before.grants[index]!;
		expect(grant, "retired grants keep their token, owner and saved history").toEqual({
			...original,
			filePairId: null,
			...(original.revokedAt === undefined
				? { revokedAt: grant.revokedAt, revokedReason: "Personal file access started", updatedAt: grant.revokedAt }
				: {}),
		});
		expect(grant.revokedAt, "every null-pair grant is revoked").toBeTypeOf("number");
	}
	for (const key of ["assets", "nodes", "accounts", "permissions", "activities"] as const)
		expect(after[key], `${key} stay unchanged`).toEqual(before[key]);
	for (const cost of costs) {
		expect(cost.documentsRead).toBeLessThan(500);
		expect(cost.bytesRead).toBeLessThan(1024 * 1024);
		expect(cost.documentsWritten).toBeLessThanOrEqual(25);
	}
	for (const step of ["runs", "targets", "grants"] as const) await migrate(f, step);
	expect(await saved_history(f), "repeating the migration changes nothing").toEqual(after);
});

test.each(["queued", "running", "awaiting_input", "stopping"] as const)(
	"history migration refuses a %s run",
	async (status) => {
		const f = await history();
		await f.t.run((ctx) => ctx.db.patch("activities", f.historyIds[0]!.activityId, { status }));
		const before = await saved_history(f);
		await expect(migrate(f, "runs"), "unfinished runs must keep their saved authority fields").rejects.toThrow(
			"Wait for the old plugin run",
		);
		expect(await saved_history(f)).toEqual(before);
	},
);

test.each(["pending", "not_started", "work", "waiter"] as const)(
	"history migration refuses an upload with %s work",
	async (change) => {
		const f = await history();
		const ids = f.historyIds[0]!;
		await f.t.run(async (ctx) => {
			if (change === "pending")
				await ctx.db.patch("plugin_service_storage_targets", ids.targetId, { state: "pending" });
			if (change === "not_started" || change === "work")
				await ctx.db.patch("files_r2_assets", ids.assetId, {
					processingWorkId: change === "work" ? ("pending-work" as WorkId) : undefined,
				});
			if (change === "waiter") {
				const cohortId = await test_db_hold_move_source(ctx, f.db, { kind: "saved", id: ids.nodeId });
				await ctx.db.insert("files_move_waiters", {
					cohortId,
					worker: { kind: "upload", id: ids.assetId, resume: { kind: "conversion", eventId: "history" } },
					createdAt: 1,
				});
			}
		});
		const before = await saved_history(f);
		await expect(migrate(f, "targets"), "unfinished uploads must keep their original pins").rejects.toThrow(
			"Wait for the old plugin upload",
		);
		expect(await saved_history(f)).toEqual(before);
	},
);

test.each(["runs", "grants"] as const)("history migration waits for %s text writes", async (step) => {
	const f = await history();
	const ids = f.historyIds[0]!;
	await f.t.run(async (ctx) => {
		await ctx.db.insert("public_api_file_write_stages", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			...(step === "runs" ? { runId: ids.runId } : { grantId: ids.grantId }),
			force: false,
			requestReadOnly: false,
			path: "/pending.md",
			overwrite: "fail",
			contentType: "text/markdown",
			yjsRootKind: "rich_text",
			yjsSnapshotAssetId: ids.assetId,
			contentSnapshotAssetId: ids.assetId,
			expiresAt: Date.now() + 60_000,
			updatedAt: 1,
		});
	});
	const before = await saved_history(f);
	await expect(migrate(f, step), "accepted text work blocks history changes").rejects.toThrow("text writes to finish");
	expect(await saved_history(f)).toEqual(before);
});

test.each(["runs", "targets", "grants", "installations"] as const)(
	"the %s preview rolls back its real patch",
	async (step) => {
		const f = await history();
		const before = await saved_history(f);
		const installation = await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId));
		const definitions = {
			runs: normalize_plugin_run_pairs,
			targets: normalize_plugin_target_pairs,
			grants: retire_plugin_grants_without_pairs,
			installations: remove_plugin_file_access_model,
		};
		let patched = false;
		test_spy_handler(definitions[step], async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if (step === "installations") {
				patched =
					(await ctx.db.get("plugins_workspace_installations", f.installationId))?.fileAccessModel === undefined;
			} else if (step === "runs") {
				patched = (await ctx.db.get("plugins_event_runs", f.historyIds[0]!.runId))?.filePairId === null;
			} else if (step === "targets") {
				patched = (await ctx.db.get("plugin_service_storage_targets", f.historyIds[0]!.targetId))?.filePairId === null;
			} else {
				const grant = await ctx.db.get("plugin_service_grants", f.historyIds[0]!.grantId);
				patched = grant?.filePairId === null && grant.revokedAt !== undefined;
			}
			return result;
		});
		await expect(
			f.t.mutation(internal.migrations.preview_plugin_file_history, { step, cursor: null }),
			"the preview reports rollback after its real batch",
		).rejects.toThrow('"preview":true');
		expect(patched, "the preview executes its real patch before rollback").toBe(true);
		expect(await saved_history(f), "the preview rolls back all history changes").toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId))).toEqual(
			installation,
		);
		await migrate(f, step);
		if (step === "installations") {
			const { fileAccessModel: _model, ...expected } = installation!;
			expect(
				await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", f.installationId)),
				"the strip removes only the rollout marker",
			).toEqual(expected);
		} else {
			const after = await saved_history(f);
			expect(after[step], "the same real batch changes the intended history fields").not.toEqual(before[step]);
		}
	},
);
