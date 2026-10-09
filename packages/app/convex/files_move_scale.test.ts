// Use the public Move intake and its scheduled workers. Measure only Move, after fixture setup.
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import {
	advance as advance_transfer,
	start as start_transfer,
	append_sources as append_transfer_sources,
	seal as seal_transfer,
} from "./files_transfer.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { r2_confirmed_object_delete, r2_create_asset_key } from "./r2_client.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";
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

async function create_fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asUser };
}

type Fixture = Awaited<ReturnType<typeof create_fixture>>;
type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;
type Metadata = Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }>;

async function create_folder(fixture: Fixture, path: string, parentId: Id<"files_nodes"> | "root" = files_ROOT_ID) {
	const created = await fixture.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: fixture.db.membershipId,
		parentId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return (await fixture.t.run((ctx) => ctx.db.get("files_nodes", created._yay.nodeId)))!;
}

function transaction_cost(metrics: Metrics) {
	return {
		databaseQueries: metrics.databaseQueries.used,
		documentsRead: metrics.documentsRead.used,
		bytesRead: metrics.bytesRead.used,
		documentsWritten: metrics.documentsWritten.used,
		bytesWritten: metrics.bytesWritten.used,
		functionsScheduled: metrics.functionsScheduled.used,
	};
}

function measure_move(
	byteBudgetFraction = 1,
	owner?: { userId: Id<"users">; nodeId: Id<"files_nodes">; fieldPages: Set<string> },
) {
	const limits = {
		databaseQueries: 4096,
		documentsRead: 32_000,
		bytesRead: 16 * 1024 * 1024,
		documentsWritten: 16_000,
		bytesWritten: 16 * 1024 * 1024,
		functionsScheduled: 1000,
	};
	const peaks = new Map<string, { calls: number; cost: ReturnType<typeof transaction_cost> }>();
	const record = async (phase: string, ctx: MutationCtx) => {
		const cost = transaction_cost(await ctx.meta.getTransactionMetrics());
		const peak = peaks.get(phase) ?? { calls: 0, cost: { ...cost } };
		for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
			peak.cost[key] = Math.max(peak.cost[key], cost[key]);
			const fraction = key === "bytesRead" || key === "bytesWritten" ? byteBudgetFraction : 1;
			if (cost[key] >= limits[key] * fraction) console.info("Move scale over budget", JSON.stringify({ phase, cost }));
			expect(cost[key], `${phase}: ${key} stays below ${fraction * 100}% of the Convex limit`)
				.toBeLessThan(limits[key] * fraction);
		}
		peak.calls++;
		peaks.set(phase, peak);
		if (peak.calls === 1 || peak.calls % 100 === 0) console.info("Move scale phase", phase, peak.calls);
	};
	for (const [phase, registered] of [
		["start", start_transfer],
		["append", append_transfer_sources],
		["seal", seal_transfer],
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
		return result;
	});
	return peaks;
}

async function start_move(fixture: Fixture, sourceIds: Id<"files_nodes">[], targetParentId: Id<"files_nodes">) {
	const { db, asUser } = fixture;
	const started = await asUser.mutation(api.files_transfer.start, {
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
			await asUser.mutation(api.files_transfer.append_sources, {
				membershipId: db.membershipId,
				runId,
				offset,
				sourceIds: sourceIds.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
			}),
			`Move accepts input page at ${offset}`,
		).toEqual({ _yay: null });
	}
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	return started._yay;
}

async function finish_move(fixture: Fixture, run: Awaited<ReturnType<typeof start_move>>, total: number) {
	const { t, db, asUser } = fixture;
	for (let step = 0; step < 100_000; step++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		if ((await t.run((ctx) => ctx.db.get("activities", run.activityId)))?.finishedAt !== undefined) {
			expect(
				await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: run.runId }),
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

async function write_markers(fixture: Fixture, nodeIds: Id<"files_nodes">[]) {
	for (let offset = 0; offset < nodeIds.length; offset += 40) {
		await test_run_with_flush(fixture.t, async (ctx) => {
			for (const nodeId of nodeIds.slice(offset, offset + 40)) {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				await files_metadata_db_write_entries(ctx, { fileNode: node, entries: [{ key: "marker", value: node.name }] });
			}
		});
	}
}

async function expect_moved_markers(
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

async function read_metadata(fixture: Fixture, nodeId: Id<"files_nodes">) {
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

function metadata_payload(doc: Metadata) {
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

describe("public Move scale", () => {
	test("moves 1000 selected files and keeps every metadata value", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser } = fixture;
		const target = await create_folder(fixture, "target");
		const sourceIds: Id<"files_nodes">[] = [];
		for (let offset = 0; offset < 1000; offset += 50) {
			vi.setSystemTime(Date.now() + 60_000);
			const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: Array.from({ length: 50 }, (_, index) => ({
					relativePath: `file-${(offset + index).toString().padStart(4, "0")}.bin`,
					size: 1,
					contentType: "application/octet-stream",
				})),
			});
			if (uploaded._nay) throw new Error(uploaded._nay.message);
			expect(uploaded._yay.created).toHaveLength(50);
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
		expect(new Set(sourceIds).size, "all 1000 selected files are distinct").toBe(1000);
		await write_markers(fixture, sourceIds);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		const peaks = measure_move();
		await finish_move(fixture, await start_move(fixture, sourceIds, target._id), 1000);
		await expect_moved_markers(fixture, sourceIds, (node) => `/target/${node.name}`);
		console.info("Move scale selected files", JSON.stringify(Object.fromEntries(peaks)));
	}, 7_200_000);

	test("moves one folder with 2001 descendants and keeps every metadata value", async () => {
		const fixture = await create_fixture();
		const { t } = fixture;
		const target = await create_folder(fixture, "target");
		const source = await create_folder(fixture, "source");
		const seed = await create_folder(fixture, "child-0000", source._id);
		const descendants = [seed._id];
		const { _id: _seedId, _creationTime: _seedTime, ...fields } = seed;
		// Bulk setup copies a real folder doc. Move still enters through the public door.
		for (let offset = 1; offset < 2001; offset += 100) {
			const ids = await t.run(async (ctx) => {
				const ids: Id<"files_nodes">[] = [];
				for (let index = offset; index < Math.min(offset + 100, 2001); index++) {
					const name = `child-${index.toString().padStart(4, "0")}`;
					const path = `/source/${name}`;
					ids.push(
						await ctx.db.insert("files_nodes", {
							...fields,
							name,
							sortName: files_sort_text_key(name),
							path,
							treePath: `${path}/`,
						}),
					);
				}
				return ids;
			});
			descendants.push(...ids);
		}
		expect(new Set(descendants).size, "the folder has more than 2000 distinct descendants").toBe(2001);
		await write_markers(fixture, [source._id, ...descendants]);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		const peaks = measure_move();
		await finish_move(fixture, await start_move(fixture, [source._id], target._id), 1);
		await expect_moved_markers(fixture, [source._id, ...descendants], (node) =>
			node._id === source._id ? "/target/source" : `/target/source/${node.name}`,
		);
		console.info("Move scale descendants", JSON.stringify(Object.fromEntries(peaks)));
	}, 7_200_000);

	test("pages 896 native metadata docs when repeated destination paths exceed 16 MiB", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser } = fixture;
		const dates = Array.from({ length: 128 }, (_, index) =>
			new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
		const frontmatter = ["---", ...dates.map((date, index) =>
			`field${index}: ["distinct-${index}", "${date}"]`), "---", "", "Body.", ""].join("\n");
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/heavy.md",
			textContent: frontmatter,
		});
		expect(
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: dates.map((date, index) => `key${index}: "${date}"`).join("\n"),
			}),
		).toEqual({ _yay: null });
		// The public saved folder door has no name length cap.
		const target = await create_folder(fixture, "d".repeat(12_000));
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		const before = await read_metadata(fixture, nodeId);
		expect(before.filter((doc) => doc.fieldPath.startsWith("frontmatter."))).toHaveLength(512);
		expect(before.filter((doc) => doc.fieldPath.startsWith("metadata."))).toHaveLength(384);
		expect(before).toHaveLength(896);
		const path = `${target.path}/heavy.md`;
		const repeatedPathBytes = new TextEncoder().encode(path).byteLength * 2 * before.length;
		expect(repeatedPathBytes, "whole-file path copies alone exceed one transaction's write bytes")
			.toBeGreaterThan(16 * 1024 * 1024);
		const peaks = measure_move();
		await finish_move(fixture, await start_move(fixture, [nodeId], target._id), 1);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			path,
			treePath: path,
			parentId: target._id,
		});
		const after = await read_metadata(fixture, nodeId);
		expect(after, "all 896 native metadata docs survive the long-path Move").toHaveLength(896);
		// Value docs share a field key. New doc IDs may change their order within that key.
		expect(
			after.map((doc) => JSON.stringify(metadata_payload(doc))).sort(),
			"every native metadata field and value survives Move",
		).toEqual(before.map((doc) => JSON.stringify(metadata_payload(doc))).sort());
		for (const doc of after) {
			expect(doc.path, "every native metadata doc has the long destination path").toBe(path);
			expect(doc.treePath).toBe(path);
			expect(doc.moveView).toBeUndefined();
			if (doc.docKind === "field") expect(doc.parentId).toBe(target._id);
		}
		expect(peaks.get("cohort/sides")!.calls, "metadata uses several side pages").toBeGreaterThan(896 / 8);
		console.info("Move scale long path", JSON.stringify({ repeatedPathBytes, phases: Object.fromEntries(peaks) }));
	}, 7_200_000);

	test.each([false, true])(
		"keeps a native large frontmatter key below 75% of each Move byte budget (pending draft: %s)",
		async (hasDraft) => {
			const fixture = await create_fixture();
			const { t, db, asUser } = fixture;
			const target = await create_folder(fixture, "target");
			const key = "k".repeat(890_000);
			// Explicit YAML keys may be longer than the 1024-character limit on implicit keys.
			const extraFields = hasDraft
				? Array.from({ length: 46 }, (_, index) => `a${index}: value${index}\n`).join("")
				: "";
			const text = `---\n${extraFields}? ${key}\n: ["v0", "v1", "v2", "v3", "v4", "v5", "v6"]\n---\nBody.\n`;
			const size = new TextEncoder().encode(text).byteLength;
			expect(size, "the uploaded text fits the native content cap").toBeLessThanOrEqual(900_000);
			const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: [
					{
						relativePath: "large-key.md",
						size,
						contentType: "text/markdown",
					},
				],
			});
			if (uploaded._nay) throw new Error(uploaded._nay.message);
			expect(uploaded._yay.created).toHaveLength(1);
			expect(uploaded._yay.skipped).toHaveLength(0);
			const item = uploaded._yay.created[0]!;
			expect(await fetch(item.url, { method: "PUT", body: text })).toHaveProperty("status", 200);
			expect(
				await t.mutation(internal.r2.process_uploaded_asset_event, {
					assetId: item.assetId,
					r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
					size,
					eventId: `move-scale-${item.assetId}`,
				}),
			).toEqual({ _yay: null });
			await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
			const node = (await t.run((ctx) => ctx.db.get("files_nodes", item.nodeId)))!;
			expect(node, "the native upload publishes a saved editable file before Move").toMatchObject({
				path: "/large-key.md",
				kind: "file",
				textKind: "rich_text",
			});
			expect(node.yjsSnapshotId, "the native upload finishes its text conversion before Move").toBeTruthy();
			expect(node.yjsLastSequenceId, "the native upload publishes its content sequence before Move").toBeTruthy();
			const before = await read_metadata(fixture, item.nodeId);
			const frontmatter = before.filter((doc) => doc.fieldPath === `frontmatter.${key}`);
			expect(frontmatter, "the native producer stores one large field and seven distinct values").toHaveLength(8);
			for (const doc of before) {
				expect(doc.sourceKind).toBe("committed");
			}
			for (const doc of frontmatter) {
				expect(doc.fieldPath).toBe(`frontmatter.${key}`);
			}
			expect(frontmatter.filter((doc) => doc.docKind === "value").map((doc) => doc.stringValue).sort())
				.toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
			console.info(
				"Move scale large key fixture",
				JSON.stringify({
					textBytes: size,
					metadataDocs: before.length,
					frontmatterDocs: frontmatter.length,
					fieldPathBytes: new TextEncoder().encode(frontmatter[0]!.fieldPath).byteLength,
				}),
			);
			let pendingUpdate: Doc<"files_pending_updates"> | null = null;
			if (hasDraft) {
				const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId: db.membershipId,
					target: { kind: "saved", id: item.nodeId },
				});
				if (batch._nay) throw new Error(batch._nay.message);
				expect(
					await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
						membershipId: db.membershipId,
						operationBatchId: batch._yay.operationBatchId,
						role: "unstaged",
						text: "Owner draft.\n",
					}),
				).toEqual({ _yay: null });
				const updated = await asUser.action(api.files_pending_updates.upsert_file_pending_update, {
					membershipId: db.membershipId,
					target: { kind: "saved", id: item.nodeId },
					operationBatchId: batch._yay.operationBatchId,
				});
				if (updated._nay) throw new Error(updated._nay.message);
				pendingUpdate = updated._yay.pendingUpdate;
				expect(pendingUpdate?.content, "the public draft producer stores content before Move").toBeTruthy();
				// The agent move door creates the owner's path and its metadata field joins.
				const pendingMove = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: item.nodeId },
					destParent: { kind: "root" },
					destName: "draft-large-key.md",
				});
				expect(pendingMove._nay).toBeUndefined();
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_pending_places")
							.withIndex("by_pendingUpdate", (q) =>
								q
									.eq("pendingUpdateId", pendingUpdate!._id)
									.eq("moveView.cohortId", undefined)
									.eq("moveView.view", undefined)
							)
							.unique()
					),
					"the pending move creates an owner place before Move"
				).not.toBeNull();
				// Run ready overlay work. Running all future timers would expire the draft before Move.
				vi.advanceTimersByTime(0);
				await t.finishInProgressScheduledFunctions();
			}
			const fieldPages = new Set<string>();
			const peaks = measure_move(0.75, hasDraft ? { userId: db.userId, nodeId: item.nodeId, fieldPages } : undefined);
			await finish_move(fixture, await start_move(fixture, [item.nodeId], target._id), 1);
			if (pendingUpdate) {
				const afterDraft = await asUser.query(api.files_pending_updates.get_file_pending_update, {
					membershipId: db.membershipId,
						target: { kind: "saved", id: item.nodeId },
				});
				expect(afterDraft, "Move keeps the owner's content branch").toMatchObject({
					_id: pendingUpdate._id,
					content: {
						stagedStateId: pendingUpdate.content?.stagedStateId,
						unstagedStateId: pendingUpdate.content?.unstagedStateId,
					},
				});
				expect(fieldPages.size, "the owner uses non-final metadata field pages").toBeGreaterThan(0);
				await t.run(async (ctx) => {
					const place = await ctx.db
						.query("files_pending_places")
						.withIndex("by_pendingUpdate", (q) =>
							q
								.eq("pendingUpdateId", pendingUpdate!._id)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
						)
						.unique();
					expect(place, "the owner keeps its pending path after Move").toMatchObject({
						ownerTreePath: "/draft-large-key.md",
					});
					if (!place) throw new Error("Expected the owner place after Move");
					// This one native fixture has 106 metadata docs, below a transaction's read bytes.
					const fields = await ctx.db
						.query("files_pending_place_fields")
						.withIndex("by_place", (q) =>
							q
								.eq("placeId", place._id)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
						)
						.collect();
					expect(fields, "the owner keeps every metadata field join").toHaveLength(before.length);
					expect(
						fields.filter((doc) => doc.fieldPath === `frontmatter.${key}`),
						"the owner keeps all large-key field and value joins"
					).toHaveLength(8);
				});
			}
			const after = await read_metadata(fixture, item.nodeId);
			expect(after, "all native metadata docs survive the large-key Move").toHaveLength(before.length);
			expect(
				after.map((doc) => JSON.stringify(metadata_payload(doc))).sort(),
				"every upload metadata payload survives the large-key Move",
			).toEqual(before.map((doc) => JSON.stringify(metadata_payload(doc))).sort());
			for (const doc of after) {
				expect(doc.path).toBe("/target/large-key.md");
				expect(doc.treePath).toBe("/target/large-key.md");
				expect(doc.moveView).toBeUndefined();
			}
			const movedFrontmatter = after.filter((doc) => doc.fieldPath === `frontmatter.${key}`);
			expect(movedFrontmatter, "all eight native large-key frontmatter docs survive Move").toHaveLength(8);
			for (const doc of movedFrontmatter) expect(doc.fieldPath).toBe(`frontmatter.${key}`);
			expect(movedFrontmatter.filter((doc) => doc.docKind === "value").map((doc) => doc.stringValue).sort())
				.toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
			console.info("Move scale large key", JSON.stringify(Object.fromEntries(peaks)));
		},
		7_200_000
	);
});
