// Fixtures shared by the files_move_scale test files.
import { R2 } from "@convex-dev/r2";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { files_metadata_db_write_entries } from "./files_metadata_db.ts";
import {
	advance as advance_transfer,
	accept_input as accept_transfer_input,
	append_input as append_transfer_input,
} from "./files_transfer.ts";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush, test_spy_handler } from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";

// Each test file calls this in `beforeEach`.
export function mock_move_scale_storage() {
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
}

export async function create_fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asUser };
}

export type Fixture = Awaited<ReturnType<typeof create_fixture>>;
type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;
export type Metadata = Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }>;

export async function create_folder(fixture: Fixture, path: string, parentId: Id<"files_nodes"> | "root" = files_ROOT_ID) {
	const created = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: fixture.db.membershipId,
		parentId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return (await fixture.t.run((ctx) => ctx.db.get("files_nodes", created._yay.nodeId)))!;
}

export function transaction_cost(metrics: Metrics) {
	return {
		databaseQueries: metrics.databaseQueries.used,
		documentsRead: metrics.documentsRead.used,
		bytesRead: metrics.bytesRead.used,
		documentsWritten: metrics.documentsWritten.used,
		bytesWritten: metrics.bytesWritten.used,
		functionsScheduled: metrics.functionsScheduled.used,
		scheduledFunctionArgsBytes: metrics.scheduledFunctionArgsBytes.used,
	};
}

export function measure_move(
	budgetFraction = 1,
	owner?: { userId: Id<"users">; nodeId: Id<"files_nodes">; fieldPages: Set<string> },
) {
	const limits = {
		databaseQueries: 4096,
		documentsRead: 32_000,
		bytesRead: 16 * 1024 * 1024,
		documentsWritten: 16_000,
		bytesWritten: 16 * 1024 * 1024,
		functionsScheduled: 1000,
		scheduledFunctionArgsBytes: 16 * 1024 * 1024,
	};
	const peaks = new Map<string, { calls: number; cost: ReturnType<typeof transaction_cost> }>();
	const record = async (phase: string, ctx: MutationCtx) => {
		const cost = transaction_cost(await ctx.meta.getTransactionMetrics());
		const peak = peaks.get(phase) ?? { calls: 0, cost: { ...cost } };
		for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
			peak.cost[key] = Math.max(peak.cost[key], cost[key]);
			const fraction = budgetFraction;
			if (cost[key] >= limits[key] * fraction) console.info("Move scale over budget", JSON.stringify({ phase, cost }));
			expect(cost[key], `${phase}: ${key} stays below ${fraction * 100}% of the Convex limit`)
				.toBeLessThan(limits[key] * fraction);
		}
		peak.calls++;
		peaks.set(phase, peak);
		if (peak.calls === 1 || peak.calls % 100 === 0) console.info("Move scale phase", phase, peak.calls);
	};
	for (const [phase, registered] of [
		["accept", accept_transfer_input],
		["append", append_transfer_input],
		["transfer", advance_transfer],
	] as const) {
		test_spy_handler(registered, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			await record(phase, ctx);
			return result;
		});
	}
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
		const cohort = await ctx.db.get("files_move_cohorts", cohortId);
		const phase = cohort?.step === step ? cohort.workPhase : "stale";
		// A release step frees at most 8 reservations. Note the first one, to see if the step leaves the rest.
		const firstReservation = () =>
			ctx.db
				.query("files_move_source_reservations")
				.withIndex("by_cohort", (q) => q.eq("cohortId", cohortId))
				.first();
		const releaseFirst = phase === "release" ? await firstReservation() : null;
		const result = await handler(ctx, args);
		if (owner && phase === "owners_stage") {
			const work = await ctx.db
				.query("files_move_owner_work")
				.withIndex("by_cohort_owner_target", (q) =>
					q
						.eq("cohortId", cohortId)
						.eq("userId", owner.userId)
						.eq("target.kind", "saved")
						.eq("target.id", owner.nodeId)
				)
				.unique();
			if (work?.fieldCursor) {
				expect(
					new TextEncoder().encode(work.fieldCursor).byteLength,
					"owner field cursor stays small for native storage",
				).toBeLessThan(4096);
				const cursor = JSON.parse(work.fieldCursor) as { phase: string; page: string | null };
				if (cursor.page !== null && (cursor.phase === "normal" || cursor.phase === "after")) {
					expect(work.afterPlaceId, "the owner has a place during its field pages").not.toBeNull();
					owner.fieldPages.add(work.fieldCursor);
				}
			}
		}
		// The registered handler includes its overlay flush. The extra header read is counted too.
		await record(`cohort/${phase}`, ctx);
		const releaseNext = releaseFirst && (await firstReservation());
		if (releaseNext && releaseNext._id !== releaseFirst._id) await record("cohort/release (paged)", ctx);
		return result;
	});
	return peaks;
}

export async function start_move(fixture: Fixture, sourceIds: Id<"files_nodes">[], targetParentId: Id<"files_nodes">) {
	const { db, asUser } = fixture;
	const started = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: "move-scale",
		kind: "move",
		expectedSourceCount: sourceIds.length,
		sourceIds: sourceIds.slice(0, files_TRANSFER_SELECTION_PAGE_SIZE),
		targetParentId,
	});
	expect(started._nay, "Move accepts its first input page").toBeUndefined();
	if (started._nay) throw new Error(started._nay.message);
	const { runId } = started._yay;
	for (
		let offset = files_TRANSFER_SELECTION_PAGE_SIZE;
		offset < sourceIds.length;
		offset += files_TRANSFER_SELECTION_PAGE_SIZE
	) {
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId,
				offset,
				sourceIds: sourceIds.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
			}),
			`Move accepts input page at ${offset}`,
		).toEqual({ _yay: null });
	}
	return started._yay;
}

export async function finish_move(fixture: Fixture, run: Awaited<ReturnType<typeof start_move>>, total: number) {
	const { t, db, asUser } = fixture;
	for (let step = 0; step < 100_000; step++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		if ((await t.run((ctx) => ctx.db.get("activities", run.activityId)))?.finishedAt !== undefined) {
			expect(
				await asUser.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId: run.runId }),
				`all ${total} selected roots complete`,
			).toMatchObject({
				activity: { status: "succeeded", progress: { total, completed: total, canceled: 0, failed: 0 } },
			});
			return;
		}
		if (vi.getTimerCount() === 0) throw new Error("Move has no scheduled worker");
		// Run workers before moving the clock. Do not jump to the job's expiry during a write.
		vi.advanceTimersToNextTimer();
	}
	throw new Error("Move did not finish within the test runner's steps");
}

export async function write_markers(fixture: Fixture, nodeIds: Id<"files_nodes">[]) {
	for (let offset = 0; offset < nodeIds.length; offset += 40) {
		await test_run_with_flush(fixture.t, async (ctx) => {
			for (const nodeId of nodeIds.slice(offset, offset + 40)) {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				await files_metadata_db_write_entries(ctx, { fileNode: node, entries: [{ key: "marker", value: node.name }] });
			}
		});
	}
}

export async function expect_moved_markers(
	fixture: Fixture,
	nodeIds: Id<"files_nodes">[],
	pathOf: (node: Doc<"files_nodes">) => string,
) {
	for (let offset = 0; offset < nodeIds.length; offset += 40) {
		await fixture.t.run(async (ctx) => {
			for (const nodeId of nodeIds.slice(offset, offset + 40)) {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				const path = pathOf(node);
				expect(node.path, "every moved node has its final path").toBe(path);
				expect(node.treePath).toBe(node.kind === "folder" ? `${path}/` : path);
				expect(node.moveCohortId).toBeUndefined();
				const metadata = await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", fixture.db.organizationId)
							.eq("workspaceId", fixture.db.workspaceId)
							.eq("fileNodeId", nodeId),
					)
					.collect();
				expect(metadata, "every moved node keeps both marker docs").toHaveLength(2);
				for (const doc of metadata) {
					if (doc.sourceKind !== "committed") throw new Error("Expected saved marker metadata");
					expect(doc.path, "every metadata doc has its final path").toBe(path);
					expect(doc.treePath).toBe(node.treePath);
					expect(doc.fieldPath).toBe("metadata.marker");
					expect(doc.moveView).toBeUndefined();
					if (doc.docKind === "field")
						expect(doc).toMatchObject({
							parentId: node.parentId,
							nodeKind: node.kind,
							name: node.name,
							sortName: node.sortName,
							isRestrictedScopeRoot: node.restrictedScopeNodeId === node._id,
							sortDisplayValue: node.name,
						});
					else expect(doc.stringValue, "every marker value survives Move").toBe(node.name);
				}
			}
		});
	}
}

export async function read_metadata(fixture: Fixture, nodeId: Id<"files_nodes">) {
	const docs: Metadata[] = [];
	let cursor: string | null = null;
	do {
		const page = await fixture.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", fixture.db.organizationId)
						.eq("workspaceId", fixture.db.workspaceId)
						.eq("fileNodeId", nodeId),
				)
				.paginate({ cursor, numItems: 16 }),
		);
		for (const doc of page.page) {
			if (doc.sourceKind !== "committed") throw new Error("Expected saved metadata");
			docs.push(doc);
		}
		cursor = page.isDone ? null : page.continueCursor;
	} while (cursor !== null);
	return docs;
}

export function metadata_payload(doc: Metadata) {
	return {
		fieldPath: doc.fieldPath,
		docKind: doc.docKind,
		valueKind: doc.valueKind,
		stringValue: doc.stringValue,
		numberValue: doc.numberValue,
		booleanValue: doc.booleanValue,
		entryIndex: doc.entryIndex,
		sortValue: doc.sortValue,
		sortDisplayValue: doc.sortDisplayValue,
		yjsSequence: doc.yjsSequence,
		archiveOperationId: doc.archiveOperationId,
	};
}

/**
 * Upload `total` files at the root and Move them all in one public Move. The test files pick a count past
 * the view's moved roots (`files_transfer_status_MAX_SELECTED_NODES`).
 */
export async function move_selected_files(total: number) {
	const fixture = await create_fixture();
	const { t, db, asUser } = fixture;
	const target = await create_folder(fixture, "target");
	const sourceIds: Id<"files_nodes">[] = [];
	for (let offset = 0; offset < total; offset += 50) {
		const length = Math.min(50, total - offset);
		vi.setSystemTime(Date.now() + 60_000);
		const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: Array.from({ length }, (_, index) => ({
				relativePath: `file-${(offset + index).toString().padStart(4, "0")}.bin`,
				size: 1,
				contentType: "application/octet-stream",
			})),
		});
		if (uploaded._nay) throw new Error(uploaded._nay.message);
		expect(uploaded._yay.created).toHaveLength(length);
		expect(uploaded._yay.skipped).toHaveLength(0);
		for (const item of uploaded._yay.created) {
			expect(await fetch(item.url, { method: "PUT", body: "x" })).toHaveProperty("status", 200);
			expect(
				await t.mutation(internal.r2.process_uploaded_asset_event, {
					assetId: item.assetId,
					r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
					size: 1,
					eventId: `move-scale-${item.assetId}`,
				}),
			).toEqual({ _yay: null });
			sourceIds.push(item.nodeId);
		}
	}
	expect(new Set(sourceIds).size, "all selected files are distinct").toBe(total);
	await write_markers(fixture, sourceIds);
	await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
	const peaks = measure_move();
	const run = await start_move(fixture, sourceIds, target._id);
	await finish_move(fixture, run, total);
	const view = await asUser.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId: run.runId });
	expect(view?.movedNodeIds.length, "the selection is bigger than the view's moved roots").toBeLessThan(total);
	await expect_moved_markers(fixture, sourceIds, (node) => `/target/${node.name}`);
	console.info("Move scale selected files", JSON.stringify(Object.fromEntries(peaks)));
}
