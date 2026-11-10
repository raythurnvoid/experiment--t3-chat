import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { create_folder_fixture, mock_transfer_storage } from "./files_transfer.setup.test.ts";

beforeEach(mock_transfer_storage);
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture() {
	const f = await create_folder_fixture(["/source"]);
	const started = await f.asUser.mutation(api.files_nodes.rename_node, {
		membershipId: f.db.membershipId,
		requestId: "migration-rename",
		nodeId: f.folders.get("/source")!,
		path: "renamed",
	});
	if (!started._yay) throw new Error("Expected a Rename job");
	const { runId, activityId } = started._yay;
	await f.t.run(async (ctx) => {
		const run = (await ctx.db.get("files_transfer_runs", runId))!;
		const { _id, _creationTime, ...fields } = run;
		const rename = fields.rename!;
		await ctx.db.patch("files_transfer_runs", _id, {
			rename: { ...rename, parentArchiveOperationId: null, source: { ...rename.source, archiveOperationId: null } },
		});
		for (const change of ["both", "source", "parent", "current"] as const) {
			await ctx.db.insert("files_transfer_runs", {
				...fields,
				requestId: `migration-${change}`,
				rename: {
					...rename,
					parentArchiveOperationId: change === "both" || change === "parent" ? "old-parent-delete" : undefined,
					source: {
						...rename.source,
						archiveOperationId: change === "both" || change === "source" ? "old-source-delete" : undefined,
					},
				},
			});
		}
		const { rename: _rename, ...copy } = fields;
		await ctx.db.insert("files_transfer_runs", { ...copy, kind: "copy", requestId: "migration-unrelated-copy" });

		const activity = (await ctx.db.get("activities", activityId))!;
		const { _id: _activityId, _creationTime: _activityCreationTime, ...activityFields } = activity;
		const opId = await ctx.db.insert("files_subtree_ops", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			kind: "scope",
			status: "running",
			blockedByOpId: null,
			rootNodeIds: [],
			treePaths: [],
		});
		for (const opKind of ["scope", "move", undefined, "scope", undefined] as const) {
			await ctx.db.insert("activities", {
				...activityFields,
				source: { kind: "files_subtree_op", id: opId, opKind },
			});
		}
	});
	const read = () =>
		f.t.run(async (ctx) => ({
			runs: await ctx.db.query("files_transfer_runs").collect(),
			activities: await ctx.db.query("activities").collect(),
			nodes: await ctx.db.query("files_nodes").collect(),
			ops: await ctx.db.query("files_subtree_ops").collect(),
			scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
		}));
	return { ...f, read };
}

const migrations = [
	{
		name: "Rename archive fields",
		migration: "rename",
		ref: internal.migrations.remove_files_transfer_runs_rename_archive_fields,
	},
	{ name: "Activity op kind", migration: "activities", ref: internal.migrations.remove_activities_subtree_op_kind },
] as const;

test.each(migrations)("$name: removes only the old fields across pages and safely repeats", async ({ name, ref }) => {
	const f = await fixture();
	const before = await f.read();
	const runs = before.runs.map((run): Doc<"files_transfer_runs"> => {
		if (name !== "Rename archive fields" || !run.rename) return run;
		const { parentArchiveOperationId: _parentArchiveOperationId, ...rename } = run.rename;
		const { archiveOperationId: _archiveOperationId, ...source } = rename.source;
		return { ...run, rename: { ...rename, source } };
	});
	const activities = before.activities.map((activity): Doc<"activities"> => {
		if (name !== "Activity op kind" || activity.source.kind !== "files_subtree_op") return activity;
		const { opKind: _opKind, ...source } = activity.source;
		return { ...activity, source };
	});
	for (const repeat of [false, true]) {
		let cursor: string | null = null;
		let processed = 0;
		let pages = 0;
		while (true) {
			const { page, cost } = await f.t.run(async (ctx) => {
				const page: { continueCursor: string; isDone: boolean; processed: number } = await ctx.runMutation(ref, {
					cursor,
					batchSize: 2,
					oneBatchOnly: true,
					dryRun: false,
				});
				return { page, cost: await ctx.meta.getTransactionMetrics() };
			});
			processed += page.processed;
			pages += 1;
			expect(page.processed).toBeLessThanOrEqual(2);
			expect(cost.documentsRead.used).toBeLessThan(16);
			expect(cost.documentsWritten.used).toBeLessThanOrEqual(2);
			expect(cost.bytesRead.used).toBeLessThan(100_000);
			expect(cost.bytesWritten.used).toBeLessThan(100_000);
			expect(cost.databaseQueries.used).toBeLessThan(16);
			expect(cost.functionsScheduled.used).toBe(0);
			if (repeat) expect(cost.documentsWritten.used, "a repeat must write no docs").toBe(0);
			if (page.isDone) break;
			cursor = page.continueCursor;
			if (pages > 10) throw new Error("The migration did not finish");
		}
		expect(pages, "the migration must cross more than one page").toBeGreaterThan(1);
		expect(processed).toBe(name === "Rename archive fields" ? before.runs.length : before.activities.length);
		expect(await f.read(), `${name}: remove the old fields and preserve every other value`).toEqual({
			...before,
			runs,
			activities,
		});
	}
});

test.each(migrations)("$name: the live preview rolls back and returns only safe counts", async ({ migration }) => {
	const f = await fixture();
	const seeded = await f.read();
	await f.t.run(async (ctx) => {
		for (let index = 0; index < 5; index++) {
			if (migration === "rename") {
				const { _id, _creationTime, ...run } = seeded.runs[0]!;
				await ctx.db.insert("files_transfer_runs", { ...run, requestId: `preview-page-${index}` });
			} else {
				const { _id, _creationTime, ...activity } = seeded.activities[1]!;
				await ctx.db.insert("activities", activity);
			}
		}
	});
	const before = await f.read();
	let cursor: string | null = null;
	for (const processed of [10, 1]) {
		let failure: unknown;
		try {
			await f.t.mutation(internal.migrations.preview_remove_trash_freeze_leftovers, { migration, cursor });
		} catch (error) {
			failure = error;
		}
		expect(await f.read(), "the live preview must preserve all stored docs").toEqual(before);
		expect(failure).toBeInstanceOf(Error);
		const receipt = JSON.parse((failure as Error).message);
		expect(Object.keys(receipt).sort()).toEqual(["continueCursor", "cost", "isDone", "preview", "processed"]);
		expect(receipt).toMatchObject({ preview: "trash_freeze", processed, isDone: processed === 1 });
		expect(typeof receipt.continueCursor).toBe("string");
		expect(Object.keys(receipt.cost).sort()).toEqual([
			"bytesRead",
			"bytesWritten",
			"databaseQueries",
			"documentsRead",
			"documentsWritten",
			"functionsScheduled",
		]);
		for (const counter of Object.values(receipt.cost)) {
			expect(counter).toEqual({ used: expect.any(Number), remaining: expect.any(Number) });
		}
		expect(receipt.cost.documentsWritten.used, "the live preview must reach real patches").toBeGreaterThan(0);
		expect(receipt.cost.documentsWritten.used).toBeLessThanOrEqual(10);
		expect(receipt.cost.documentsRead.used).toBeLessThan(32);
		expect(receipt.cost.bytesRead.used).toBeLessThan(500_000);
		expect(receipt.cost.bytesWritten.used).toBeLessThan(500_000);
		expect(receipt.cost.databaseQueries.used).toBeLessThan(32);
		expect(receipt.cost.functionsScheduled.used).toBe(0);
		cursor = receipt.continueCursor;
	}
});

test.each(migrations)("$name: an outer preview failure rolls back a real nested patch", async ({ name, ref }) => {
	const f = await fixture();
	const before = await f.read();
	let changedInside = false;
	let failure: unknown;
	try {
		await f.t.run(async (ctx) => {
			await ctx.runMutation(ref, { cursor: null, batchSize: 2, oneBatchOnly: true, dryRun: false });
			if (name === "Rename archive fields") {
				const after = (await ctx.db.get("files_transfer_runs", before.runs[0]!._id))!;
				changedInside =
					after.rename!.source.archiveOperationId === undefined && after.rename!.parentArchiveOperationId === undefined;
			} else {
				const source = (await ctx.db.get("activities", before.activities[1]!._id))!.source;
				changedInside = source.kind === "files_subtree_op" && source.opKind === undefined;
			}
			throw new Error("Rollback preview finished");
		});
	} catch (error) {
		failure = error;
	}
	// Read persisted docs first. An expected error alone would not prove rollback.
	expect(await f.read(), "the preview must preserve all stored docs").toEqual(before);
	expect(changedInside, "the preview must reach a real field-removal patch").toBe(true);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe("Rollback preview finished");
});
