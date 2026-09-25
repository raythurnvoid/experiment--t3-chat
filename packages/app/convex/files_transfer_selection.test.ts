import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(paths = ["/source", "/target"]) {
	const t = test_convex({ transactionLimits: true });
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const folders = new Map<string, Id<"files_nodes">>();
	for (const path of paths) {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.set(path, created._yay.nodeId);
	}
	return { t, scope, asUser, folders };
}

async function start(
	f: Awaited<ReturnType<typeof fixture>>,
	sources: Id<"files_nodes">[],
	expectedCount = sources.length,
) {
	return await f.asUser.mutation(api.files_transfer.start, {
		membershipId: f.scope.membershipId,
		requestId: "selection",
		kind: "copy",
		expectedSourceCount: expectedCount,
		sourceIds: sources,
		targetParentId: f.folders.get("/target")!,
	});
}

describe("Copy selection pages", () => {
	test("keeps input idle until sealed and refuses a changed replay", async () => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start(f, [source], 3);
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await start(f, [source], 3)).toEqual(started);
		expect(await start(f, [source], 4)).toMatchObject({ _nay: { name: "request_changed" } });
		await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toMatchObject({
			_nay: { name: "incomplete_selection" },
		});
		const page = { ...args, offset: 1, sourceIds: [source, source] };
		expect(await f.asUser.mutation(api.files_transfer.append_sources, page)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.append_sources, page)).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_sources, {
				...page,
				sourceIds: [f.folders.get("/target")!, source],
			}),
		).toMatchObject({ _nay: { name: "request_changed" } });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toHaveLength(3);
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.append_sources, page)).toEqual({ _yay: null });
		for (let step = 0; step < 2; step++) await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ source: { kind: "saved", id: source }, parentItemId: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("activities").collect())).toHaveLength(1);
	});

	test("normalizes a later selected ancestor after more than 200 input entries", async () => {
		const f = await fixture(["/source", "/source/child", "/target"]);
		const child = f.folders.get("/source/child")!;
		const started = await start(
			f,
			Array.from({ length: 100 }, () => child),
			201,
		);
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(
			await f.asUser.mutation(api.files_transfer.append_sources, {
				...args,
				offset: 100,
				sourceIds: Array.from({ length: 100 }, () => child),
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_sources, {
				...args,
				offset: 200,
				sourceIds: [f.folders.get("/source")!],
			}),
		).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		for (let step = 0; step < 60; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId));
			if (run?.step === "discover") break;
		}
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ source: { kind: "saved", id: f.folders.get("/source") }, sourcePath: "/source" });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(3);
	});

	test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid offset %s without appending", async (offset) => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start(f, [source], 2);
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_transfer.append_sources, {
				membershipId: f.scope.membershipId,
				runId: started._yay.runId,
				offset,
				sourceIds: [source],
			}),
		).toMatchObject({ _nay: { name: "invalid_selection" } });
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toHaveLength(1);
	});

	test("plans every root after 200 sources and keeps originals unchanged", async () => {
		const paths = Array.from({ length: 201 }, (_, index) => `/source-${index}`);
		const f = await fixture(["/target", ...paths]);
		const sourceIds = paths.map((path) => f.folders.get(path)!);
		const started = await start(f, sourceIds.slice(0, 100), sourceIds.length);
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		for (let offset = 100; offset < sourceIds.length; offset += 100)
			expect(
				await f.asUser.mutation(api.files_transfer.append_sources, {
					...args,
					offset,
					sourceIds: sourceIds.slice(offset, offset + 100),
				}),
			).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });
		for (let step = 0; step < 280; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId));
			if (run?.step === "apply") break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId))).toMatchObject({ step: "apply" });
		const items = await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect());
		expect(items).toHaveLength(201);
		expect(new Set(items.map((item) => item.plannedPath))).toEqual(new Set(paths.map((path) => `/target${path}`)));
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(202);
	}, 60_000);

	test("discovers past 10,000 items in bounded pages before output", async () => {
		const f = await fixture();
		const sourceId = f.folders.get("/source")!;
		const source = (await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId)))!;
		const { _id, _creationTime, ...fields } = source;
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 120; index++) {
				const name = `child-${String(index).padStart(5, "0")}`;
				await ctx.db.insert("files_nodes", {
					...fields,
					parentId: sourceId,
					name,
					sortName: files_sort_text_key(name),
					path: `/source/${name}`,
					treePath: `/source/${name}/`,
					pathDepth: 2,
				});
			}
		});
		const started = await start(f, [sourceId]);
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toEqual({ _yay: null });

		// Copy once refused a run past 10,000 discovered items, and that check read only this count.
		// Start the count as if 9,900 items were already found, so the 120 children cross 10,000
		// without 10,000 real rows.
		await f.t.run(async (ctx) => {
			const activity = (await ctx.db.query("activities").collect()).find(
				(row) => row.source.kind === "files_transfer_run" && row.source.id === args.runId,
			)!;
			await ctx.db.patch("activities", activity._id, { progress: { ...activity.progress!, discovered: 9_900 } });
		});

		const pageSizes: number[] = [];
		let discovered = 9_900;
		for (let step = 0; step < 10; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: args.runId });
			const view = await f.asUser.query(api.files_transfer.get, args);
			const added = view!.activity.progress.discovered - discovered;
			if (added > 0) pageSizes.push(added);
			discovered = view!.activity.progress.discovered;
			const root = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", args.runId).eq("order", 0))
					.unique(),
			);
			if (root?.discoveryDone) break;
		}
		// The first step adds the selected folder itself. Then its children come in pages of at most 50.
		expect(pageSizes).toEqual([1, 50, 50, 20]);
		const view = await f.asUser.query(api.files_transfer.get, args);
		expect(view).toMatchObject({
			step: "discover",
			activity: {
				status: "running",
				errorMessage: null,
				progress: { discovered: 10_021, completed: 0 },
			},
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", args.runId).eq("order", 10_020))
					.unique(),
			),
		).toMatchObject({ sourcePath: "/source/child-00119", outputTarget: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(source);
	}, 60_000);

	test("Stop prevents later pages and seal; cleanup drains selection pages", async () => {
		const f = await fixture();
		const source = f.folders.get("/source")!;
		const started = await start(f, [source], 2);
		if (started._nay) throw new Error(started._nay.message);
		const args = { membershipId: f.scope.membershipId, runId: started._yay.runId };
		expect(await f.asUser.mutation(api.files_transfer.stop, args)).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.files_transfer.append_sources, { ...args, offset: 1, sourceIds: [source] }),
		).toMatchObject({ _nay: { name: "timed_out" } });
		expect(await f.asUser.mutation(api.files_transfer.seal, args)).toHaveProperty("_nay");
		for (let step = 0; step < 3; step++)
			await f.t.mutation(internal.files_transfer.delete_run_batch, { runId: args.runId });
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", args.runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(2);
	});
});
