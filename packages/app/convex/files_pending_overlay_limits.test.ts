// Measure paged Move and Accept cohort steps and the private Discard core, including
// the pending overlay flush. Keep a 25% margin when choosing each Move step's size.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
// The full maximum Move fixture runs with `test:files:full-size`.
// Two smaller Move tests split its sizes for the default run.

import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_rebuild_node } from "./files_nodes.ts";
import { advance as advance_review, start as start_review, seal as seal_review } from "./files_pending_update_runs.ts";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import {
	advance as advance_transfer,
	start as start_transfer,
	append_sources as append_transfer_sources,
	seal as seal_transfer,
} from "./files_transfer.ts";
import { advance as advance_subtree } from "./files_subtree_ops.ts";
import { compact_metadata_catalog, run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { files_metadata_db_insert_committed } from "./files_metadata.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
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
import { files_metadata_catalog_lower, files_metadata_preflight_frontmatter } from "../shared/files-metadata.ts";

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
	const check = (phase: string, measured: Cost) => {
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
	const record = (phase: string, measured: Cost) => {
		const peak = peaks.get(phase) ?? { measured: { ...zero }, calls: 0 };
		for (const key of Object.keys(zero) as Array<keyof Cost>)
			peak.measured[key] = Math.max(peak.measured[key], measured[key]);
		peak.calls++;
		peaks.set(phase, peak);
		if (peak.calls === 1 || peak.calls % 500 === 0) console.info("Move budget phase", phase, peak.calls);
		check(phase, measured);
	};
	return {
		peaks,
		record,
		check: (name: string) => {
			for (const [phase, peak] of peaks) check(`${name}/${phase}`, peak.measured);
		},
	};
}

function measure_cohort(
	record: ReturnType<typeof budget_recorder>["record"],
	metadata: Doc<"files_metadata_docs">[] = [],
) {
	const rows = new Map(metadata.map((row) => [row._id, { fileNodeId: row.fileNodeId!, view: "before" as "before" | "after" }]));
	const fileIds = new Set(metadata.map((row) => row.fileNodeId));
	const pages: {
		cohortId: Id<"files_move_cohorts">;
		phase: string;
		view: "before" | "after";
		rowIds: Id<"files_metadata_docs">[];
		fileNodeIds: Id<"files_nodes">[];
	}[] = [];
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
		const cohort = await ctx.db.get("files_move_cohorts", cohortId);
		const phase = cohort?.step === step ? cohort.workPhase : "stale";
		const patch = metadata.length ? vi.spyOn(ctx.db, "patch") : null;
		const insert = metadata.length ? vi.spyOn(ctx.db, "insert") : null;
		const remove = metadata.length ? vi.spyOn(ctx.db, "delete") : null;
		const before = await ctx.meta.getTransactionMetrics();
		try {
			const result = await handler(ctx, args);
			// The registered handler includes the mutation wrapper and its overlay flush.
			const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			if (insert) for (const [index, call] of insert.mock.calls.entries()) {
				const fields = call[1] as Partial<Doc<"files_metadata_docs">>;
				if (
					phase !== "sides" || call[0] !== "files_metadata_docs" || fields.sourceKind !== "committed" ||
					!fileIds.has(fields.fileNodeId) || fields.moveView?.view !== "after"
				) continue;
				const id = await insert.mock.results[index]!.value as Id<"files_metadata_docs">;
				rows.set(id, { fileNodeId: fields.fileNodeId!, view: "after" });
			}
			const written = new Map<"before" | "after", Id<"files_metadata_docs">[]>();
			if (patch) for (const [table, id, fields] of patch.mock.calls) {
				const row = rows.get(id as Id<"files_metadata_docs">);
				if (
					!["sides", "finish_sides", "abort_sides"].includes(phase) ||
					table !== "files_metadata_docs" || !row || !("moveView" in fields)
				) continue;
				if (phase === "sides" && (fields as Partial<Doc<"files_metadata_docs">>).moveView?.view !== "before") continue;
				written.set(row.view, [...(written.get(row.view) ?? []), id as Id<"files_metadata_docs">]);
			}
			if (remove) for (const [table, id] of remove.mock.calls) {
				const row = rows.get(id as Id<"files_metadata_docs">);
				if ((phase === "finish_sides" || phase === "abort_sides") && table === "files_metadata_docs" && row)
					written.set(row.view, [...(written.get(row.view) ?? []), id as Id<"files_metadata_docs">]);
			}
			for (const [view, rowIds] of written) pages.push({ cohortId, phase, view, rowIds, fileNodeIds: rowIds.map((id) => rows.get(id)!.fileNodeId) });
			record(`cohort/${phase}`, cost);
			return result;
		} finally {
			patch?.mockRestore();
			insert?.mockRestore();
			remove?.mockRestore();
		}
	});
	return pages;
}

async function finish_scheduled(t: ReturnType<typeof test_convex>, isDone: () => Promise<boolean>) {
	for (let step = 0; step < 50_000; step++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		if (await isDone()) return;
		// Each scheduled worker has a fake timer. Reading `_scheduled_functions` here would be slow:
		// that table keeps finished jobs, so each read grows with the steps already run.
		if (vi.getTimerCount() === 0) throw new Error("The accepted job has no scheduled worker");
		// Advance between workers, never while an async worker is still reading or writing.
		vi.advanceTimersToNextTimer();
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

/**
 * Share a restricted root 100 times. The share caps allow 50 shares on one node
 * (MAX_FILE_SHARE_PRINCIPALS in files_sharing.ts, MAX_READERS in plugins_external_files.ts). This is
 * twice that: 50 users and 50 roles, each with the three grants of a "manage" share.
 */
async function share_100_times(t: ReturnType<typeof test_convex>, db: Db, nodeId: Id<"files_nodes">) {
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
					resourceId: String(nodeId),
					...principal,
					permission,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
	});
}

describe("paged Move transaction budgets", () => {
	// MAX_OTHER_USERS_DOCS_PER_SAVED_NODE in files-pending-overlay.ts is 32, one hide and one place
	// per user. So at most 16 users can draft on one saved node.
	const MAX_DRAFT_OWNERS = 16;

	test("Scheduled Move progress ignores old worker history", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folders: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			folders.push(created._yay.nodeId);
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "move-with-old-worker-history",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [folders[0]!],
			targetParentId: folders[1]!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		const historyDelay = 24 * 60 * 60 * 1000;
		const historyDueAt = Date.now() + historyDelay;
		const scheduledCount = await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			for (let index = 0; index < 500; index++) {
				const jobId = await ctx.scheduler.runAfter(historyDelay, internal.files_transfer.advance, { runId });
				await ctx.scheduler.cancel(jobId);
			}
			return transaction_cost(before, await ctx.meta.getTransactionMetrics()).functionsScheduled;
		});
		expect(scheduledCount).toBe(500);
		// Canceled jobs keep their history. Their fake timers stay past this Move.
		const history = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.scheduledTime === historyDueAt),
		);
		expect(history).toHaveLength(500);
		expect(history.every((job) => job.state.kind === "canceled")).toBe(true);
		const run = t.run;
		let peakDocumentsRead = 0;
		t.run = async <Output>(func: Parameters<typeof run<Output>>[0]) =>
			await run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await func(ctx);
				const after = await ctx.meta.getTransactionMetrics();
				peakDocumentsRead = Math.max(peakDocumentsRead, transaction_cost(before, after).documentsRead);
				return result;
			});
		try {
			await finish_scheduled(t, async () =>
				(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !== undefined,
			);
		} finally {
			t.run = run;
		}
		expect(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, failed: 0, canceled: 0 } },
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", folders[0]!)))?.path).toBe("/target/source");
		expect(Date.now()).toBeLessThan(historyDueAt);
		expect(peakDocumentsRead, "Scheduled Move progress must not read old worker history").toBeLessThan(32);
	}, 120_000);

	// Moves a heavy file with `keys` frontmatter and metadata keys (128 is the maximum) and `lines`
	// lines of text while `owners` users draft a move of it. Also moves a folder with restricted
	// folders and a file with a link.
	const measure_paged_move = async (args: { owners: number; keys: number; lines: number; dense?: boolean }) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const dates = Array.from({ length: args.keys }, (_, index) =>
			new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
		);
		const frontmatter = [
			"---",
			...dates.map((date, index) => {
				const key = args.dense ? `field${index}-`.padEnd(148, "k") : `field${index}`;
				const value = args.dense ? `distinct-${index}-`.padEnd(1024, "x") : `distinct-${index}`;
				return `${key}: ["${value}", "${date}"]`;
			}),
			"---",
			"",
		].join("\n");
		const body = "A large saved file keeps its text chunks beside both metadata sources.\n".repeat(args.lines);
		const textContent = frontmatter + body;
		const metadataYaml = dates.map((date, index) => `key${index}: "${date}"`).join("\n");
		if (args.dense) {
			expect(new TextEncoder().encode(textContent).byteLength).toBeLessThanOrEqual(900_000);
			expect(new TextEncoder().encode(metadataYaml).byteLength).toBeLessThanOrEqual(16 * 1024);
			expect(files_metadata_preflight_frontmatter(textContent)._yay).toMatchObject({ fieldCount: 128, indexDocumentCount: 512 });
		}
		const heavyId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/project/heavy.md",
			textContent,
		});
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: heavyId,
				metadataYaml,
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
		expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("frontmatter."))).toHaveLength(args.keys * 4);
		expect(seeded.metadata.filter((doc) => doc.fieldPath.startsWith("metadata."))).toHaveLength(args.keys * 3);
		if (args.dense) expect(seeded.metadata.every((doc) => doc.fieldPath.length <= 160), "Dense metadata keys fit the catalog").toBe(true);
		// Owner steps page these docs 8 at a time (PAGE_SIZE in files_move_owner_work.ts). Use full pages.
		expect(seeded.metadata.length, "the metadata fills more than one owner page").toBeGreaterThan(8);
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
				const created = uploaded._yay.created;
				for (const item of created) {
					expect(await fetch(item.url, { method: "PUT", body: "x" })).toHaveProperty("status", 200);
					expect(
						await t.mutation(internal.r2.process_uploaded_asset_event, {
							assetId: item.assetId,
							r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
							size: 1,
							eventId: `move-budget-${item.assetId}`,
						}),
					).toEqual({ _yay: null });
				}
				const nodes = await t.run((ctx) =>
					Promise.all(created.map(async (item) => (await ctx.db.get("files_nodes", item.nodeId))!)),
				);
				for (const node of nodes) {
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
		// Seed the link load. Keep the native 500th success and 501st refusal.
		await t.run(async (ctx) => {
			for (const [index, node] of seeded.links.slice(0, 499).entries())
				await ctx.db.insert("files_share_links", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId: node._id,
					token: index.toString(16).padStart(64, "0"),
					restrictedScopeNodeId: node.restrictedScopeNodeId,
					ancestorNodeIds: node.parentId === files_ROOT_ID ? [] : [seeded.project._id],
					createdBy: db.userId,
					createdAt: Date.now(),
				});
		});
		refill_sharing();
		expect(
			await asOwner.mutation(api.files_sharing.set_node_share_link, {
				membershipId: db.membershipId,
				nodeId: seeded.links[499]!._id,
				enabled: true,
			}),
		).toEqual({ _yay: null });
		console.info("Move budget fixture: public links ready", 500);
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
		for (const userId of seeded.users.slice(0, args.owners)) {
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
		if (args.owners === MAX_DRAFT_OWNERS)
			await expect(
				t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: seeded.users[MAX_DRAFT_OWNERS]!,
					target: { kind: "saved", id: heavyId },
					destParent: { kind: "saved", id: seeded.drafts._id },
					destName: seeded.heavy.name,
				}),
				"the cap refuses one more owner draft",
			).rejects.toThrow("Too many people have pending changes");
		console.info("Move budget fixture: shares, links and owner drafts ready");
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", heavyId))
					.collect(),
			).toHaveLength(args.owners);
			expect(
				await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", heavyId))
					.collect(),
			).toHaveLength(args.owners);
			expect(
				await ctx.db
					.query("files_share_rows")
					.withIndex("by_node", (q) => q.eq("nodeId", heavyId))
					.collect(),
			).toHaveLength(50);
			expect(await ctx.db.query("files_share_links").collect()).toHaveLength(500);
		});

		const { peaks, record, check } = budget_recorder();
		const metadataPages = measure_cohort(record, args.dense ? seeded.metadata : []);
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
		// Move completion can come before its delayed catalog work.
		await finish_scheduled(t, async () => {
			if (args.dense && metadataPages.length) {
				const page = metadataPages[0]!;
				const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", page.cohortId));
				expect(cohort).not.toBeNull();
				expect(page.rowIds.length, "Dense metadata uses 64 rows when the byte bound allows it").toBe(64);
			}
			if ((await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt === undefined)
				return false;
			return await t.run(async (ctx) => !(await ctx.db
				.query("files_metadata_catalog_compactors")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.first()));
		});
		console.info(
			"paged Move phase peaks, with the metadata catalog",
			JSON.stringify({ args, phases: Object.fromEntries(peaks) }),
		);
		expect(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 3, failed: 0, canceled: 0 } },
		});
		expect(peaks.get("cohort/publish")?.calls, "every saved Move root reaches cohort publication").toBe(sources.length);
		expect(peaks.get("catalog/compactor")?.calls, "the Move's catalog deltas reach the compactor").toBeGreaterThan(0);
		expect(
			peaks.get("catalog/compactor")?.measured.documentsWritten,
			"the compactor applies the Move's catalog deltas",
		).toBeGreaterThan(0);
		expect(peaks.get("cohort/descendants")?.calls).toBeGreaterThan(0);
		expect(peaks.get("cohort/finish_owners")?.calls).toBeGreaterThan(0);
		if (args.dense) {
			// Check outside the worker too: a worker can catch a failed budget assertion.
			check("Dense metadata Move stays below the budget after the flush");
			const metadata = await t.run((ctx) => ctx.db.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", heavyId))
				.collect());
			const metadata_fields = (rows: Doc<"files_metadata_docs">[]) => rows.map((row) => Object.fromEntries(Object.entries(row)
				.filter(([key]) => !["_id", "_creationTime", "moveView", "path", "treePath", "parentId"].includes(key))))
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			expect(metadata, "Dense metadata keeps all 896 saved docs").toHaveLength(896);
			expect(metadata_fields(metadata)).toEqual(metadata_fields(seeded.metadata));
			expect(metadata.every((row) => row.moveView === undefined && row.path === "/target/heavy.md" && row.treePath === row.path)).toBe(true);
			expect(metadata.filter((row) => row.docKind === "field").every((row) => row.parentId === seeded.target._id)).toBe(true);
			expect((await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
				path: "/target/heavy.md", includePending: false,
			}))?.content, "Dense metadata Move keeps its saved text").toBe(textContent);
		}
	};

	// The full size: 16 owners with 896 metadata docs each and a large text make about 8,700 Move steps.
	// It runs only in `test:files:full-size`. The steps
	// work in pages, so one step's cost does not grow with the owner count, the doc count or the text
	// size. The two tests below split these sizes and reach the same peak per phase (checked once
	// against this test).
	test("measures scheduled phases with maximum metadata, draft copies, shares and links", async () => {
		await measure_paged_move({ owners: MAX_DRAFT_OWNERS, keys: 128, lines: 12_000 });
	}, 7_200_000);

	// The maximum metadata with one owner. 200 lines make about 12 text chunks, more than one page of
	// 8. A larger text only adds steps, and saving it takes most of the full test's fixture time.
	test("measures scheduled phases with maximum metadata, shares, links and one draft copy", async () => {
		await measure_paged_move({ owners: 1, keys: 128, lines: 200, dense: true });
	}, 1_200_000);

	// The owner cap with two keys: 14 metadata docs, two pages per owner.
	test("measures scheduled phases with the most draft copies, shares and links", async () => {
		await measure_paged_move({ owners: MAX_DRAFT_OWNERS, keys: 2, lines: 200 });
	}, 600_000);

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
		await finish_scheduled(
			t,
			async () =>
				(await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !==
				undefined,
		);
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
		await finish_scheduled(
			t,
			async () =>
				(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.run.step ===
				"finished",
		);
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

	test.each([
		["mixed", "finish"],
		["mixed", "stop"],
		["bytes", "finish"],
		["bytes", "stop"],
	] as const)("Metadata cleanup keeps %s docs on native %s", async (size, mode) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodes: Doc<"files_nodes">[] = [];
		const texts: string[] = [];
		let folder: Doc<"files_nodes">;
		if (size === "mixed") {
			folder = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "metadata", kind: "folder" }));
			for (let index = 0; index < 65; index++) {
				const node = await t.run((ctx) => insert_saved_node(ctx, db, { parent: folder, name: `file-${index}.md`, kind: "file" }));
				const key = `field${index}-`.padEnd(148, "k");
				const value = `value-${index}-`.padEnd(1024, "x");
				await test_run_with_flush(t, (ctx) => files_metadata_db_insert_committed(ctx, {
					...scope, nodeId: node._id, yjsSequence: 1, markdownContent: `---\n${key}: ${value}\n---\n`,
				}));
				nodes.push(node);
			}
		} else {
			const createdFolder = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId, parentId: files_ROOT_ID, path: "metadata",
			});
			if (createdFolder._nay) throw new Error(createdFolder._nay.message);
			folder = (await t.run((ctx) => ctx.db.get("files_nodes", createdFolder._yay.nodeId)))!;
			for (let index = 0; index < 3; index++) {
				// Explicit YAML keys have no 1,024-character implicit-key limit.
				const text = index === 0
					? `---\n? ${"k".repeat(898_900)}\n: []\n---\n`
					: `---\nfield${index}: ${`value-${index}-`.padEnd(898_900, "x")}\n---\n`;
				expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(900_000);
				expect(files_metadata_preflight_frontmatter(text)._yay).toMatchObject({
					fieldCount: 1, indexDocumentCount: index === 0 ? 1 : 2,
				});
				const created = await asOwner.action(api.files_nodes_content.create_text_node, {
					membershipId: db.membershipId, parentId: folder._id, path: `file-${index}.md`,
				});
				if (created._nay) throw new Error(created._nay.message);
				const nodeId = created._yay.nodeId;
				// The member Save door keeps exact text without building draft Yjs branches.
				expect(await asOwner.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId, nodeId, acknowledgeDropCollaborativeHistory: true,
				})).toEqual({ _yay: null });
				expect(await asOwner.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId, nodeId, text,
				})).toEqual({ _yay: null });
				nodes.push((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!);
				expect(nodes[index], "Near-cap metadata uses a native Markdown file with collaboration off").toMatchObject({
					contentType: "text/markdown;charset=utf-8", textKind: "rich_text", collaborationEnabled: false,
					yjsSnapshotId: null, yjsLastSequenceId: null,
				});
				texts.push(text);
				expect((await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope, path: nodes[index]!.path, includePending: false,
				}))?.content, "Near-cap metadata starts from the exact native saved text").toBe(text);
			}
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const originals = await t.run(async (ctx) => (await Promise.all(nodes.map((node) => ctx.db.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id))
			.collect()))).flat());
		expect(originals, "The native metadata producer creates every expected field and value").toHaveLength(size === "mixed" ? 130 : 5);
		if (size === "mixed") expect(originals.every((row) => row.fieldPath.length === 160), "Mixed metadata keys reach the catalog cap").toBe(true);
		else expect(nodes.map((node) => originals.filter((doc) => doc.fileNodeId === node._id).length), "Near-cap text creates the expected metadata docs per file").toEqual([1, 2, 2]);
		const fieldPaths = [...new Set(originals.map((row) => row.fieldPath).filter((field) => field.length <= 160))];
		const readCatalog = () => t.run(async (ctx) => (await Promise.all(fieldPaths.flatMap((fieldPath) =>
			(["key", "parent", "value"] as const).map((family) => ctx.db.query("files_metadata_catalog")
				.withIndex("by_org_ws_family_parent_lower_field_value", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined).eq("family", family)
					.eq("parentId", family === "parent" ? folder._id : undefined).eq("fieldPathLower", files_metadata_catalog_lower(fieldPath)).eq("fieldPath", fieldPath))
				.collect())))).flat().map(({ _id, _creationTime, ...row }) => row));
		const catalogBefore = await readCatalog();
		expect(catalogBefore).toHaveLength(size === "mixed" ? 195 : 4);
		expect(catalogBefore.every((row) => row.count === 1)).toBe(true);
		const proposalResult = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope, target: { kind: "saved", id: folder._id }, destParent: { kind: "root" }, destName: "moved",
		});
		if (proposalResult._nay) throw new Error(proposalResult._nay.message);
		const proposal = await t.run((ctx) => ctx.db.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", folder._id)).unique());
		if (!proposal) throw new Error("Expected the folder Move proposal");
		const { peaks, record, check } = budget_recorder();
		const pages = measure_cohort(record, originals);
		for (const [phase, registered] of [
			["review/start", start_review], ["review/seal", seal_review], ["review/advance", advance_review],
			["catalog/compactor", compact_metadata_catalog], ["overlay", run_overlay_job],
		] as const) test_spy_handler(registered, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId, requestId: crypto.randomUUID(), kind: "accept", expectedItemCount: 1,
			items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		expect(await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({ _yay: null });
		for (let pass = 0; pass < 1000; pass++) {
			const job = await t.run((ctx) => ctx.db.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)).first());
			if (job) await t.mutation(internal.files_pending_overlay.run_job, { kind: job.kind, key: job.key, nextAttemptAt: job.nextAttemptAt });
			else await t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
			if ((await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))?.step !== "planning") break;
			if (pass === 999) throw new Error("Metadata Review planning did not finish");
		}
		await t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await t.run((ctx) => ctx.db.query("files_pending_update_run_units").withIndex("by_run_order", (q) => q.eq("runId", runId)).first());
		if (!unit?.cohortId) throw new Error("Metadata Review did not start a cohort");
		const cohortId = unit.cohortId;
		let stopped = false;
		let bytePage: Id<"files_metadata_docs">[] | null = null;
		let completed: Doc<"files_move_cohorts"> | null = null;
		for (let pass = 0; pass < 10_000; pass++) {
			const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId));
			if (!cohort) throw new Error("Missing metadata cohort");
			const staged = pages.filter((page) => page.phase === "sides").reduce((count, page) => count + page.rowIds.length, 0);
			if (mode === "stop" && !stopped && staged >= (size === "mixed" ? 66 : 5)) {
				expect(cohort, "Stop reaches real metadata staging before publication").toMatchObject({ phase: "staging", workPhase: "sides", publishedAt: null, errorCode: null });
				expect(await asOwner.mutation(api.activities.request_stop, { membershipId: db.membershipId, activityId })).toEqual({ _yay: null });
				stopped = true;
				continue;
			}
			if (size === "bytes" && bytePage === null && (cohort.workPhase === "finish_sides" || cohort.workPhase === "abort_sides")) {
				// This expected native page is read outside the measured handler.
				const page = await t.run((ctx) => ctx.db.query("files_metadata_docs").withIndex("by_move_view", (q) => q.eq("moveView.cohortId", cohortId).eq("moveView.view", "before"))
					.paginate({ cursor: null, numItems: 64, maximumBytesRead: 1024 * 1024 }));
				expect(page.isDone, "Near-cap metadata reaches the byte bound before the row bound").toBe(false);
				expect(page.page.length).toBeLessThan(64);
				bytePage = page.page.map((row) => row._id);
			}
			const cleanup = pages.filter((page) => page.phase === "finish_sides" || page.phase === "abort_sides");
			if (cleanup.length) {
				if (size === "mixed") expect(cleanup[0]!.rowIds.length, "Saved metadata cleanup takes 64 rows when they fit").toBe(64);
				else expect(cleanup[0]!.rowIds, "Metadata cleanup keeps the 1 MiB page bound").toEqual(bytePage);
			}
			if (cohort.phase === "complete") { completed = cohort; break; }
			await t.action(internal.files_move_cohorts.run, { cohortId, step: cohort.step });
			if (pass === 9999) throw new Error("Metadata cohort did not finish");
		}
		await t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId });
		await test_finish_pending_update_run(asOwner, runId);
		await finish_scheduled(t, async () => !(await t.run((ctx) => ctx.db.query("files_metadata_catalog_compactors")
			.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)).first())));
		check("Saved metadata cleanup stays below the budget after the flush");
		expect(completed).toMatchObject({ phase: "complete", visibleView: mode === "stop" ? "before" : "after", errorCode: mode === "stop" ? "stopped" : null });
		if (mode === "stop") expect(completed?.publishedAt).toBeNull();
		else expect(completed?.publishedAt).not.toBeNull();
		expect((await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity).toMatchObject({
			status: mode === "stop" ? "canceled" : "succeeded",
			progress: { completed: mode === "stop" ? 0 : 1, canceled: mode === "stop" ? 1 : 0, failed: 0, blocked: 0 },
		});
		const finalNodes = await t.run((ctx) => Promise.all(nodes.map((node) => ctx.db.get("files_nodes", node._id))));
		expect(finalNodes.map((node) => [node?._id, node?.parentId, node?.path, node?.treePath])).toEqual(nodes.map((node) => {
			const path = mode === "stop" ? node.path : node.path.replace("/metadata/", "/moved/");
			return [node._id, folder._id, path, path];
		}));
		const metadata = await t.run(async (ctx) => (await Promise.all(nodes.map((node) => ctx.db.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id)).collect()))).flat());
		if (mode === "stop") expect(metadata, "Stop before publication keeps every saved metadata field").toEqual(originals);
		else {
			const metadata_fields = (rows: Doc<"files_metadata_docs">[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["_id", "_creationTime", "moveView", "path", "treePath"].includes(key))))
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			expect(metadata_fields(metadata), "Native Move keeps every saved metadata field and value").toEqual(metadata_fields(originals));
		}
		const paths = new Map(finalNodes.map((node) => [node!._id, node!.path]));
		expect(metadata.every((row) => row.moveView === undefined && row.path === paths.get(row.fileNodeId!) && row.treePath === row.path)).toBe(true);
		expect(finalNodes.every((node) => node?.moveCohortId === undefined)).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(mode === "stop" ? proposal : null);
		expect(await readCatalog(), "Native metadata cleanup keeps exact catalog counts").toEqual(catalogBefore);
		if (size === "mixed") expect(new Set(pages.find((page) => page.phase === (mode === "stop" ? "abort_sides" : "finish_sides"))!.fileNodeIds).size, "Metadata cleanup pages cross file boundaries").toBeGreaterThan(1);
		else for (const [index, text] of texts.entries()) expect((await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope, path: finalNodes[index]!.path, includePending: false,
		}))?.content, "Native metadata cleanup keeps every near-cap saved text").toBe(text);
		console.info("saved metadata page peaks, with the catalog", JSON.stringify({ size, mode, phases: Object.fromEntries(peaks), pages: pages.map(({ phase, view, rowIds }) => ({ phase, view, rows: rowIds.length })) }));
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
	// that is a restricted root (see `share_100_times`).
	test("saves a shared file with 100 shares", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const file = await t.run(async (ctx) => {
			const file = await insert_saved_node(ctx, db, { parent: null, name: "shared.md", kind: "file" });
			await ctx.db.patch("files_nodes", file._id, { restrictedScopeNodeId: file._id, isRestrictedScopeRoot: true });
			return file;
		});
		await share_100_times(t, db, file._id);

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

	// A rename of a folder changes the `treePath` of every node below it. A job that writes a shared
	// folder's new path (a restore, a scope job) does it through the flush, which rewrites every share
	// row of the folder.
	test("rewrites the paths of a shared folder with 100 shares after its parent's rename", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { parent, shared } = await t.run(async (ctx) => {
			const parent = await insert_saved_node(ctx, db, { parent: null, name: "p", kind: "folder" });
			const shared = await insert_saved_node(ctx, db, { parent, name: "shared", kind: "folder" });
			await ctx.db.patch("files_nodes", shared._id, { restrictedScopeNodeId: shared._id, isRestrictedScopeRoot: true });
			return { parent, shared };
		});
		await share_100_times(t, db, shared._id);
		const renamed = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", parent._id, {
				name: "p2",
				sortName: files_sort_text_key("p2"),
				path: "/p2",
				treePath: "/p2/",
			});
			return (await ctx.db.get("files_nodes", parent._id))!;
		});

		const cost = await test_run_with_flush(t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			await files_nodes_db_rebuild_node(ctx, { node: (await ctx.db.get("files_nodes", shared._id))!, parent: renamed });
			await files_pending_overlay_db_flush(ctx);
			return transaction_cost(before, await ctx.meta.getTransactionMetrics());
		});
		console.info("path rewrite, a shared folder with 100 shares", cost);

		const rows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(rows).toHaveLength(100);
		expect(rows.every((row) => row.treePath === "/p2/shared/")).toBe(true);
		expect_under_convex_limits(cost);
	}, 120_000);
});
