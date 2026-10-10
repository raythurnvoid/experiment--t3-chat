// Measure paged Move and Accept cohort steps and the private Discard core, including
// the pending overlay flush. Keep a 25% margin when choosing each Move step's size.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
// The mock scans each indexed table. The maximum fixture can take an hour here.

import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { advance as advance_review } from "./files_pending_update_runs.ts";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import {
	advance as advance_transfer,
	start as start_transfer,
	append_sources as append_transfer_sources,
	seal as seal_transfer,
} from "./files_transfer.ts";
import { advance as advance_subtree } from "./files_subtree_ops.ts";
import { compact_metadata_catalog, run_job as run_overlay_job } from "./files_pending_overlay.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { r2_confirmed_object_delete, r2_create_asset_key } from "./r2_client.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { access_control_FILE_SHARE_LEVELS } from "../shared/access-control.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => {
	vi.useFakeTimers();
	const objects = new Map<string, string | ArrayBuffer>();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		objects.delete(key);
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey) => {
		const key = customKey ?? crypto.randomUUID();
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (path.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(path.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			if (!path.startsWith("https://r2.test/object?key=")) return new Response(null, { status: 404 });
			const body = objects.get(decodeURIComponent(path.slice("https://r2.test/object?key=".length)));
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type Db = Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;
type Cost = ReturnType<typeof transaction_cost>;

const zero: Cost = {
	databaseQueries: 0,
	documentsRead: 0,
	bytesRead: 0,
	documentsWritten: 0,
	bytesWritten: 0,
	functionsScheduled: 0,
};

/**
 * The work done between two metric reads in one transaction.
 */
function transaction_cost(before: Metrics, after: Metrics) {
	return {
		databaseQueries: after.databaseQueries.used - before.databaseQueries.used,
		documentsRead: after.documentsRead.used - before.documentsRead.used,
		bytesRead: after.bytesRead.used - before.bytesRead.used,
		documentsWritten: after.documentsWritten.used - before.documentsWritten.used,
		bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
		functionsScheduled: after.functionsScheduled.used - before.functionsScheduled.used,
	};
}

/**
 * Check one transaction against the Convex limits. `transactionLimits: true` already throws past
 * them, so these asserts show the numbers and keep the check if that option goes away.
 */
function expect_under_convex_limits(cost: ReturnType<typeof transaction_cost>) {
	expect(cost.databaseQueries, "databaseQueries").toBeLessThan(4096);
	expect(cost.documentsRead, "documentsRead").toBeLessThan(32_000);
	expect(cost.bytesRead, "bytesRead").toBeLessThan(16 * 1024 * 1024);
	expect(cost.documentsWritten, "documentsWritten").toBeLessThan(16_000);
	expect(cost.bytesWritten, "bytesWritten").toBeLessThan(16 * 1024 * 1024);
	expect(cost.functionsScheduled, "functionsScheduled").toBeLessThan(1000);
}

/**
 * Peak cost per phase. A measured transaction includes the overlay flush, so also the metadata
 * catalog's deltas and marker.
 */
function budget_recorder() {
	const peaks = new Map<string, { measured: Cost; calls: number }>();
	const record = (phase: string, measured: Cost) => {
		const peak = peaks.get(phase) ?? { measured: { ...zero }, calls: 0 };
		for (const key of Object.keys(zero) as Array<keyof Cost>)
			peak.measured[key] = Math.max(peak.measured[key], measured[key]);
		peak.calls++;
		peaks.set(phase, peak);
		if (peak.calls === 1 || peak.calls % 500 === 0) console.info("Move budget phase", phase, peak.calls);
		expect_under_convex_limits(measured);
		for (const [key, limit] of Object.entries({
			databaseQueries: 4096,
			documentsRead: 32_000,
			bytesRead: 16 * 1024 * 1024,
			documentsWritten: 16_000,
			bytesWritten: 16 * 1024 * 1024,
			functionsScheduled: 1000,
		}) as Array<[keyof Cost, number]>)
			expect(measured[key], `${phase}: ${key}`).toBeLessThan(limit * 0.75);
	};
	return { peaks, record };
}

function measure_cohort(record: ReturnType<typeof budget_recorder>["record"]) {
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
		const cohort = await ctx.db.get("files_move_cohorts", cohortId);
		const phase = cohort?.step === step ? cohort.workPhase : "stale";
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		// The registered handler includes the mutation wrapper and its overlay flush.
		const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		record(`cohort/${phase}`, cost);
		return result;
	});
}

async function finish_scheduled(
	t: ReturnType<typeof test_convex>,
	isDone: () => Promise<boolean>,
) {
	for (let step = 0; step < 50_000; step++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		if (await isDone()) return;
		const next = await t.run(async ctx => (await ctx.db.system.query("_scheduled_functions").collect())
			.filter(job => job.state.kind === "pending")
			.reduce<number | null>((time, job) => time === null ? job.scheduledTime : Math.min(time, job.scheduledTime), null));
		if (next === null) throw new Error("The accepted job has no scheduled worker");
		// Advance between workers, never while an async worker is still reading or writing.
		vi.advanceTimersByTime(Math.max(0, next - Date.now()));
	}
	throw new Error("The scheduled job did not finish");
}

async function add_member(ctx: MutationCtx, db: Db, clerkUserId: string) {
	const userId = await ctx.db.insert("users", { clerkUserId });
	await ctx.db.insert("organizations_workspaces_users", {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		active: true,
		pendingOrganizationRemoval: false,
		updatedAt: Date.now(),
	});
	await access_control_db_ensure_role_assignment(ctx, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		role: "member",
		now: Date.now(),
	});
	return userId;
}

async function insert_saved_node(
	ctx: MutationCtx,
	db: Db,
	args: { parent: Doc<"files_nodes"> | null; name: string; kind: "file" | "folder"; createdBy?: Id<"users"> },
) {
	const path = `${args.parent?.path ?? ""}/${args.name}`;
	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		createdBy: args.createdBy ?? db.userId,
		updatedBy: args.createdBy ?? db.userId,
		parentId: args.parent?._id ?? files_ROOT_ID,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		kind: args.kind,
		path,
		treePath: args.kind === "folder" ? `${path}/` : path,
		pathDepth: path.split("/").length - 1,
	});
	return (await ctx.db.get("files_nodes", nodeId))!;
}

describe("paged Move transaction budgets", () => {
	test("measures scheduled phases with maximum metadata, draft copies, shares and links", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const dates = Array.from({ length: 128 }, (_, index) =>
			new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
		);
		const frontmatter = [
			"---",
			...dates.map((date, index) => `field${index}: ["distinct-${index}", "${date}"]`),
			"---",
			"",
		].join("\n");
		const body = "A large saved file keeps its text chunks beside both metadata sources.\n".repeat(12_000);
		const heavyId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/project/heavy.md",
			textContent: frontmatter + body,
		});
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: heavyId,
				metadataYaml: dates.map((date, index) => `key${index}: "${date}"`).join("\n"),
			}),
		).toEqual({ _yay: null });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		console.info("Move budget fixture: committed text and maximum metadata ready");

		const seeded = await t.run(async (ctx) => {
			const heavy = (await ctx.db.get("files_nodes", heavyId))!;
			const project = (await ctx.db.get("files_nodes", heavy.parentId as Id<"files_nodes">))!;
			const target = await insert_saved_node(ctx, db, { parent: null, name: "target", kind: "folder" });
			const drafts = await insert_saved_node(ctx, db, { parent: null, name: "drafts", kind: "folder" });
			const shared = await insert_saved_node(ctx, db, { parent: project, name: "shared", kind: "folder" });
			const light: Doc<"files_nodes">[] = [];
			const links: Doc<"files_nodes">[] = [];
			const users: Id<"users">[] = [];
			for (let index = 0; index < 51; index++) users.push(await add_member(ctx, db, `clerk_move_budget_${index}`));
			const metadata = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", heavyId),
				)
				.collect();
			return { heavy, project, target, drafts, shared, light, links, users, metadata };
		});
		expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("frontmatter."))).toHaveLength(512);
		expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("metadata."))).toHaveLength(384);
		let extraLinkId: Id<"files_nodes"> | null = null;
		for (const [parentId, count] of [
			[seeded.project._id, 99],
			[files_ROOT_ID, 402],
		] as const) {
			for (let offset = 0; offset < count; offset += 50) {
				vi.setSystemTime(Date.now() + 60_000);
				const uploaded = await asOwner.mutation(api.files_nodes.create_upload_nodes, {
					membershipId: db.membershipId,
					parentId,
					onConflict: "skip",
					items: Array.from({ length: Math.min(50, count - offset) }, (_, index) => ({
						relativePath: `link-${offset + index}.bin`,
						size: 1,
						contentType: "application/octet-stream",
					})),
				});
				if (uploaded._nay) throw new Error(uploaded._nay.message);
				expect(uploaded._yay.skipped).toHaveLength(0);
				for (const item of uploaded._yay.created) {
					expect(await fetch(item.url, { method: "PUT", body: "x" })).toHaveProperty("status", 200);
					expect(
						await t.mutation(internal.r2.process_uploaded_asset_event, {
							assetId: item.assetId,
							r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
							size: 1,
							eventId: `move-budget-${item.assetId}`,
						}),
					).toEqual({ _yay: null });
					const node = (await t.run((ctx) => ctx.db.get("files_nodes", item.nodeId)))!;
					if (seeded.links.length < 500) seeded.links.push(node);
					else extraLinkId = node._id;
					if (parentId === seeded.project._id) seeded.light.push(node);
				}
			}
		}
		if (!extraLinkId) throw new Error("Expected one extra link target");
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		console.info("Move budget fixture: native upload targets ready");

		// Advance only the clock: setup should not run expiry jobs between fixture writes.
		const refill_sharing = () => vi.setSystemTime(Date.now() + 3_000);
		refill_sharing();
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: heavyId }),
		).toEqual({ _yay: null });
		for (const userId of seeded.users.slice(0, 50)) {
			refill_sharing();
			expect(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: db.membershipId,
					nodeId: heavyId,
					principal: { kind: "user", userId },
					level: "manage",
				}),
			).toEqual({ _yay: null });
		}
		refill_sharing();
		expect(
			(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: db.membershipId,
					nodeId: heavyId,
					principal: { kind: "user", userId: seeded.users[50]! },
					level: "manage",
				})
			)._nay?.message,
		).toContain("at most 50");
		for (let index = 0; index < 9; index++) {
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: `${seeded.shared.path}/restricted-${index}`,
			});
			if (created._nay) throw new Error(created._nay.message);
			refill_sharing();
			expect(
				await asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: db.membershipId,
					nodeId: created._yay.nodeId,
				}),
			).toEqual({ _yay: null });
		}
		for (const node of seeded.links) {
			refill_sharing();
			expect(
				await asOwner.mutation(api.files_sharing.set_node_share_link, {
					membershipId: db.membershipId,
					nodeId: node._id,
					enabled: true,
				}),
			).toEqual({ _yay: null });
			if ((seeded.links.indexOf(node) + 1) % 100 === 0) console.info("Move budget fixture: public links ready", seeded.links.indexOf(node) + 1);
		}
		refill_sharing();
		expect(
			(
				await asOwner.mutation(api.files_sharing.set_node_share_link, {
					membershipId: db.membershipId,
					nodeId: extraLinkId,
					enabled: true,
				})
			)._nay?.message,
		).toContain("at most 500");
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		for (const userId of seeded.users.slice(0, 16)) {
			expect(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					target: { kind: "saved", id: heavyId },
					destParent: { kind: "saved", id: seeded.drafts._id },
					destName: seeded.heavy.name,
				}),
			).toMatchObject({
				_yay: { fromPath: seeded.heavy.path, destPath: `${seeded.drafts.path}/${seeded.heavy.name}` },
			});
		}
		console.info("Move budget fixture: shares, links and owner drafts ready");
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", heavyId))
					.collect(),
			).toHaveLength(16);
			expect(
				await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", heavyId))
					.collect(),
			).toHaveLength(16);
			expect(
				await ctx.db
					.query("files_share_rows")
					.withIndex("by_node", (q) => q.eq("nodeId", heavyId))
					.collect(),
			).toHaveLength(50);
			expect(await ctx.db.query("files_share_links").collect()).toHaveLength(500);
		});

		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		// The metadata catalog's compactor runs in its own transactions while the Move goes on.
		test_spy_handler(compact_metadata_catalog, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("catalog/compactor", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		for (const [phase, registered] of [
			["start", start_transfer],
			["append", append_transfer_sources],
			["seal", seal_transfer],
		] as const) {
			test_spy_handler(registered, async (handler, ctx, args) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await handler(ctx, args);
				record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
				return result;
			});
		}
		// The native 140-root test covers selection size. These roots keep the maximum per-node cost.
		const sources = [heavyId, seeded.shared._id, seeded.light[0]!._id];
		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "move-budget",
			kind: "move",
			expectedSourceCount: sources.length,
			sourceIds: sources.slice(0, 1),
			targetParentId: seeded.target._id,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		test_spy_handler(advance_transfer, async (handler, ctx, args) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			record(`transfer/${run.step}`, cost);
			return result;
		});
		test_spy_handler(advance_subtree, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("subtree", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		test_spy_handler(run_overlay_job, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("overlay", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		expect(
			await asOwner.mutation(api.files_transfer.append_sources, {
				membershipId: db.membershipId,
				runId,
				offset: 1,
				sourceIds: sources.slice(1),
			}),
		).toEqual({ _yay: null });
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		await finish_scheduled(t, async () =>
			(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !== undefined);
		console.info(
			"paged Move phase peaks, with the metadata catalog",
			JSON.stringify({ phases: Object.fromEntries(peaks) }),
		);
		expect(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 3, failed: 0, canceled: 0 } },
		});
		expect(peaks.get("cohort/publish")?.calls, "every saved Move root reaches cohort publication").toBe(sources.length);
		expect(peaks.get("catalog/compactor")?.calls, "the Move's catalog deltas reach the compactor").toBeGreaterThan(0);
		expect(peaks.get("cohort/descendants")?.calls).toBeGreaterThan(0);
		expect(peaks.get("cohort/finish_owners")?.calls).toBeGreaterThan(0);
	}, 7_200_000);

	test("moves one saved file while six owners have large pending content", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/project/heavy.md",
			textContent: "Saved content.\n",
		});
		const seeded = await t.run(async (ctx) => {
			const target = await insert_saved_node(ctx, db, { parent: null, name: "target", kind: "folder" });
			const users: Id<"users">[] = [];
			for (let index = 0; index < 6; index++) users.push(await add_member(ctx, db, `clerk_heavy_content_${index}`));
			return { target, users };
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		const text = "x".repeat(800 * 1024);
		for (const userId of seeded.users) {
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId };
			const batch = await t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					...scope,
					target: { kind: "saved", id: nodeId },
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role: "unstaged",
					text,
				}),
			).toEqual({ _yay: null });
			expect(
				await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
					...scope,
					target: { kind: "saved", id: nodeId },
					operationBatchId: batch._yay.operationBatchId,
				}),
			).toEqual({ _yay: null });
		}
		const read_pending_chunks = async (ctx: MutationCtx) =>
			await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", nodeId),
				)
				.collect();
		await t.run(async (ctx) => {
			const chunks = await read_pending_chunks(ctx);
			expect(new Set(chunks.map((chunk) => (chunk.sourceKind === "pending" ? chunk.userId : null))).size).toBe(6);
			expect(
				chunks.reduce((sum, chunk) => sum + new TextEncoder().encode(chunk.plainTextChunk).byteLength, 0),
			).toBeGreaterThan(4 * 1024 * 1024);
		});
		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "move-six-heavy-drafts",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [nodeId],
			targetParentId: seeded.target._id,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		test_spy_handler(advance_transfer, async (handler, ctx, args) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			record(`transfer/${run.step}`, cost);
			return result;
		});
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		await finish_scheduled(t, async () =>
			(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !== undefined);
		const receipt = await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		console.info(
			"singleton Move with six native 800KiB drafts",
			JSON.stringify({ phases: Object.fromEntries(peaks), receipt }),
		);
		expect(receipt, "one saved root must move with six supported pending content branches").toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, failed: 0, canceled: 0 } },
		});
		await t.run(async (ctx) => {
			const chunks = await read_pending_chunks(ctx);
			expect(new Set(chunks.map((chunk) => (chunk.sourceKind === "pending" ? chunk.userId : null))).size).toBe(6);
			expect(chunks.every((chunk) => chunk.path === "/target/heavy.md")).toBe(true);
		});
	}, 900_000);
});

describe("cohort Accept transaction budgets", () => {
	test("measures a linked public Accept through publication and cleanup", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodes: Id<"files_nodes">[] = [];
		for (let index = 0; index < 3; index++) {
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: `/inbox/note-${index}.md`,
				textContent: [
					"---",
					...Array.from({ length: 20 }, (_, key) => `field${key}: value-${key}`),
					"---",
					"",
					"Saved text.",
				].join("\n"),
			});
			nodes.push(nodeId);
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const parentId = (await t.run((ctx) => ctx.db.get("files_nodes", nodes[0]!)))!.parentId;
		if (parentId === files_ROOT_ID) throw new Error("Expected the native inbox folder");
		const draft = async (index: number, destName: string) => {
			const proposal = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: { kind: "saved", id: nodes[index]! },
				destParent: { kind: "saved", id: parentId },
				destName,
			});
			if (proposal._nay) throw new Error(proposal._nay.message);
		};
		await draft(0, "temporary-draft-name.md");
		await draft(2, "note-0.md");
		await draft(1, "note-2.md");
		await draft(0, "note-1.md");
		const proposals = await t.run((ctx) =>
			Promise.all(
				nodes.map((nodeId) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId),
						)
						.unique(),
				),
			),
		);
		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		test_spy_handler(advance_review, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("review/advance", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 3,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId }),
		).toEqual({ _yay: null });
		await finish_scheduled(t, async () =>
			(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.run.step === "finished");
		expect(
			(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity,
			"the measured linked Accept completes through native cohort workers",
		).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
		expect(peaks.get("cohort/publish")?.calls, "linked Accept uses one cohort switch").toBe(1);
		expect(peaks.get("cohort/finish_nodes")?.calls).toBeGreaterThan(0);
		const saved = await t.run((ctx) => Promise.all(nodes.map((nodeId) => ctx.db.get("files_nodes", nodeId))));
		expect(saved.map((node) => node?.name)).toEqual(["note-1.md", "note-2.md", "note-0.md"]);
		expect(saved.every((node) => node?.moveCohortId === undefined)).toBe(true);
		console.info(
			"linked public Accept phase peaks, with the metadata catalog",
			JSON.stringify(Object.fromEntries(peaks)),
		);
	}, 180_000);
});

describe("discard_file_pending_update", () => {
	test("discards a 256-node private folder that claims a saved name", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

		await t.run(async (ctx) => {
			await insert_saved_node(ctx, db, { parent: null, name: "area", kind: "folder" });
		});
		// A single Discard answers `needs_review` for a private child folder, a child file with content,
		// or a draft move into the tree. So the largest tree it removes is one folder with 255 new, empty
		// files.
		for (let index = 0; index < 255; index++) {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: `/area/drafts/note-${index}.md`,
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
		}
		// Another user then saves `/area/drafts` with files. The owner's private folder now claims that name.
		await t.run(async (ctx) => {
			const area = (await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/area")!;
			const other = await add_member(ctx, db, "clerk_discard_other");
			const claimed = await insert_saved_node(ctx, db, {
				parent: area,
				name: "drafts",
				kind: "folder",
				createdBy: other,
			});
			for (let index = 0; index < 10; index++)
				await insert_saved_node(ctx, db, {
					parent: claimed,
					name: `note-${index}.md`,
					kind: "file",
					createdBy: other,
				});
		});
		const root = await t.run(async (ctx) => {
			const node = (await ctx.db.query("files_pending_nodes").collect()).find((node) => node.name === "drafts")!;
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
				)
				.unique();
			return { node, proposal: proposal! };
		});
		expect(await t.run(async (ctx) => (await ctx.db.query("files_pending_nodes").collect()).length)).toBe(256);

		const { result, cost } = await asOwner.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await ctx.runMutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: db.membershipId,
				target: { kind: "private", id: root.node._id },
				pendingUpdateId: root.proposal._id,
				reviewedRevision: root.proposal.revision,
			});
			return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
		});
		console.info("discard_file_pending_update, 256 private nodes", cost);

		expect(result).toEqual({ _yay: null });
		const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state !== "discarded")).toEqual([]);
		expect_under_convex_limits(cost);
	}, 120_000);
});

describe("hard delete", () => {
	// The flush's inline part of a hard delete reads the node's hides and places and at most one
	// proposal (`.first()`); the saved node job then pages the proposals. So no hard-delete batch
	// counts proposals. This measures the inline part for 25 nodes with drafts of 5 users, then of 20
	// users: the ranges per node stay the same.
	const hard_delete_cost = async (userCount: number) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const seeded = await t.run(async (ctx) => {
			const a = await insert_saved_node(ctx, db, { parent: null, name: "a", kind: "folder" });
			const b = await insert_saved_node(ctx, db, { parent: null, name: "b", kind: "folder" });
			const files: Doc<"files_nodes">[] = [];
			for (let index = 0; index < 25; index++) {
				const file = await insert_saved_node(ctx, db, { parent: a, name: `note-${index}.md`, kind: "file" });
				await ctx.db.patch("files_nodes", file._id, { archiveOperationId: "archive-op" });
				files.push(file);
			}
			const userIds: Id<"users">[] = [];
			for (let index = 0; index < userCount; index++)
				userIds.push(await add_member(ctx, db, `clerk_hard_delete_${index}`));
			return { b, files, userIds };
		});
		// Each user drafts a move of every node into /b. One flush per user writes the places.
		for (const userId of seeded.userIds)
			await test_run_with_flush(t, async (ctx) => {
				for (const file of seeded.files)
					await ctx.db.insert("files_pending_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId,
						target: { kind: "saved", id: file._id },
						revision: 1,
						size: 0,
						updatedAt: Date.now(),
						expiresAt: Date.now() + 60 * 60 * 1000,
						pendingMove: { destParent: { kind: "saved", id: seeded.b._id }, destName: file.name, fromPath: file.path },
					});
			});
		const places_of_files = () =>
			t.run(async (ctx) => {
				const places = [];
				for (const file of seeded.files)
					places.push(
						...(await ctx.db
							.query("files_pending_places")
							.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", file._id))
							.collect()),
					);
				return places;
			});
		expect(await places_of_files()).toHaveLength(25 * userCount);

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			for (const file of seeded.files) await ctx.db.delete("files_nodes", file._id);
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info(`hard delete, 25 archived nodes with drafts of ${userCount} users each`, cost);
		expect_under_convex_limits(cost);

		// The saved node jobs remove the places of the deleted nodes.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await places_of_files()).toEqual([]);
		return cost;
	};

	test("hard deletes 25 archived nodes with the same ranges for drafts of 5 or 20 users", async () => {
		const few = await hard_delete_cost(5);
		const many = await hard_delete_cost(20);
		expect(many.databaseQueries).toBe(few.databaseQueries);
	}, 120_000);
});

describe("metadata catalog", () => {
	// The most catalog work one node can cause: 896 committed metadata docs (128 frontmatter keys with
	// 3 values, 128 metadata keys with 2 values), each key 160 characters and each value 1,024 bytes,
	// the longest that still count. Every doc makes its own delta, so this is also the byte peak.
	test("measures create, full replacement, archive, restore and the compactor at maximum delta sizes", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const node = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "max", kind: "folder" }));
		const docs = (round: number) =>
			(["frontmatter", "metadata"] as const).flatMap((namespace) =>
				Array.from({ length: 128 }, (_, key) => {
					const prefix = `${namespace}.r${round}k${key}-`;
					const fieldPath = prefix + "x".repeat(160 - prefix.length);
					const base = {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						sourceKind: "committed" as const,
						fileNodeId: node._id,
						path: node.path,
						treePath: node.treePath,
						fieldPath,
					};
					return [
						{ ...base, docKind: "field" as const, parentId: files_ROOT_ID },
						...Array.from({ length: namespace === "frontmatter" ? 3 : 2 }, (_, value) => {
							const head = `r${round}k${key}v${value}-`;
							return {
								...base,
								docKind: "value" as const,
								valueKind: "string" as const,
								stringValue: head + "v".repeat(1024 - head.length),
							};
						}),
					];
				}).flat(),
			);
		expect(docs(0)).toHaveLength(896);
		const { peaks, record } = budget_recorder();
		const measure = async (phase: string, write: (ctx: MutationCtx) => Promise<void>) =>
			await test_run_with_flush(t, async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				await write(ctx);
				await files_pending_overlay_db_flush(ctx);
				record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			});
		const all_docs = (ctx: MutationCtx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", node._id),
				)
				.collect();
		test_spy_handler(compact_metadata_catalog, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("catalog/compactor", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const compact = async () => {
			for (let run = 0; run < 100; run++) {
				vi.setSystemTime(Date.now() + 5001);
				const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").first());
				if (!marker) return;
				await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker._id });
			}
			throw new Error("The catalog compactor did not drain");
		};
		const count = (table: "files_metadata_catalog" | "files_metadata_catalog_deltas") =>
			t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

		await measure("catalog/create", async (ctx) => {
			for (const doc of docs(0)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(1152);
		await compact();
		expect(await count("files_metadata_catalog")).toBe(1152);
		await measure("catalog/replace", async (ctx) => {
			for (const doc of await all_docs(ctx)) await ctx.db.delete("files_metadata_docs", doc._id);
			for (const doc of docs(1)) await ctx.db.insert("files_metadata_docs", doc);
		});
		expect(await count("files_metadata_catalog_deltas")).toBe(2304);
		await compact();
		// Each archive or restore patch reads its doc first, like the scope helper's own query.
		await measure("catalog/archive", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: "archive-op" });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(0);
		await measure("catalog/restore", async (ctx) => {
			for (const doc of await all_docs(ctx))
				await ctx.db.patch("files_metadata_docs", doc._id, { archiveOperationId: undefined });
		});
		await compact();
		expect(await count("files_metadata_catalog")).toBe(1152);
		console.info("metadata catalog peaks at maximum delta sizes", JSON.stringify(Object.fromEntries(peaks)));
		expect(peaks.get("catalog/compactor")?.measured.documentsRead).toBeGreaterThan(1000);
	}, 600_000);
});

describe("content save", () => {
	// A content save patches the file node, so the flush rewrites every share row of a shared file
	// that is a restricted root. The share caps allow 50 shares on one node (MAX_FILE_SHARE_PRINCIPALS
	// in files_sharing.ts, MAX_READERS in plugins_external_files.ts). This measures twice that: 50
	// users and 50 roles, each with the three grants of a "manage" share.
	test("saves a shared file with 100 shares", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const file = await t.run(async (ctx) => {
			const file = await insert_saved_node(ctx, db, { parent: null, name: "shared.md", kind: "file" });
			await ctx.db.patch("files_nodes", file._id, { restrictedScopeNodeId: file._id, isRestrictedScopeRoot: true });
			return file;
		});
		await test_run_with_flush(t, async (ctx) => {
			const principals: Array<
				{ principalKind: "user"; userId: Id<"users"> } | { principalKind: "role"; role: Id<"access_control_roles"> }
			> = [];
			for (let index = 0; index < 50; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `clerk_reader_${index}` });
				const role = await ctx.db.insert("access_control_roles", {
					organizationId: db.organizationId,
					name: `Readers ${index}`,
					normalizedName: `readers ${index}`,
					description: "",
					permissions: ["content.read"],
					createdBy: db.userId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				principals.push({ principalKind: "user", userId }, { principalKind: "role", role });
			}
			for (const principal of principals)
				for (const permission of access_control_FILE_SHARE_LEVELS.manage.permissions)
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						resourceKind: "file",
						resourceId: String(file._id),
						...principal,
						permission,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
		});

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			// The node fields a content save patches in files_nodes_content.ts, without the new asset.
			await ctx.db.patch("files_nodes", file._id, {
				contentByteSize: 2048,
				updatedBy: db.userId,
				updatedAt: Date.now() + 1000,
			});
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("content save, a shared file with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.contentByteSize === 2048)).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);
});
