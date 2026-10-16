import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { start_transfer } from "./files_transfer.setup.test.ts";
import {
	files_media_dependencies_db_append,
	files_media_dependencies_db_create,
	files_media_dependencies_db_retire,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(expectedCount = 201) {
	const t = test_convex({ transactionLimits: true });
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: scope.membershipId,
		parentId: "root",
		path: "/draft",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
		membershipId: scope.membershipId,
		parentId: "root",
		filename: "photo.png",
		contentType: "image/png",
		size: 4,
	});
	if (upload._nay) throw new Error(upload._nay.message);
	const node = (await t.run((ctx) => ctx.db.get("files_nodes", upload._yay.nodeId)))!;
	const copy = await start_transfer(asUser, {
		membershipId: scope.membershipId,
		requestId: "media-owners",
		kind: "copy",
		sourceIds: [node._id, folder._yay.nodeId],
		targetParentId: "root",
	});
	if (copy._nay) throw new Error(copy._nay.message);
	const items = await t.run((ctx) =>
		ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_order", (q) => q.eq("runId", copy._yay.runId))
			.collect(),
	);
	const owner = { kind: "capture" as const, itemId: items[0]!._id };
	const otherOwner = { kind: "capture" as const, itemId: items[1]!._id };
	const created = await t.run((ctx) => files_media_dependencies_db_create(ctx, { ...scope, owner, expectedCount }));
	if (created._nay) throw new Error(created._nay.message);
	const setId = created._yay;
	const dependency: Doc<"files_media_dependencies">["dependency"] = {
		src: `bonobo-file://${node._id}`,
		target: { kind: "saved", id: node._id },
		assetId: node.assetId!,
		version: {
			kind: "asset",
			assetId: node.assetId!,
			contentType: "image/png",
			textKind: null,
			collaborationEnabled: null,
		},
	};
	// These test opaque mapping storage. Media readiness is checked by the owning producer.
	const mappings = Array.from({ length: expectedCount }, (_, index) => ({ sourceSrc: `source:${index}`, dependency }));
	return { t, scope, setId, owner, otherOwner, mappings, node };
}

describe("media dependency sets", () => {
	test("stores more than 200 mapping rows in exact pages and seals once complete", async () => {
		const f = await fixture();
		const pin = { setId: f.setId, generation: 0 };
		expect(await f.t.run((ctx) => files_media_dependencies_db_seal(ctx, pin))).toHaveProperty("_nay");
		for (let offset = 0; offset < f.mappings.length; offset += 50) {
			const page = { ...pin, offset, mappings: f.mappings.slice(offset, offset + 50) };
			expect(await f.t.run((ctx) => files_media_dependencies_db_append(ctx, page))).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => files_media_dependencies_db_append(ctx, page))).toEqual({ _yay: null });
		}
		expect(await f.t.run((ctx) => files_media_dependencies_db_seal(ctx, pin))).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => files_media_dependencies_db_seal(ctx, pin))).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId))).toMatchObject({
			count: 201,
			expectedCount: 201,
			sealed: true,
			owner: f.owner,
		});
		const rows = await f.t.run((ctx) =>
			ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_order", (q) => q.eq("setId", f.setId))
				.collect(),
		);
		expect(rows.map(({ sourceSrc, dependency }) => ({ sourceSrc, dependency }))).toEqual(f.mappings);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.node._id))).toEqual(f.node);
	});

	test("refuses changed replays and duplicates without partial writes", async () => {
		const f = await fixture(3);
		const pin = { setId: f.setId, generation: 0 };
		expect(
			await f.t.run((ctx) =>
				files_media_dependencies_db_append(ctx, { ...pin, offset: 0, mappings: [f.mappings[0]!] }),
			),
		).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) =>
				files_media_dependencies_db_append(ctx, { ...pin, offset: 0, mappings: [f.mappings[1]!] }),
			),
		).toHaveProperty("_nay");
		expect(
			await f.t.run((ctx) =>
				files_media_dependencies_db_append(ctx, { ...pin, offset: 1, mappings: [f.mappings[1]!, f.mappings[0]!] }),
			),
		).toHaveProperty("_nay");
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId))).toMatchObject({
			count: 1,
			sealed: false,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(1);
	});

	test("keeps a live set and drains only retired mapping rows in pages", async () => {
		const f = await fixture(101);
		for (let offset = 0; offset < f.mappings.length; offset += 50)
			expect(
				await f.t.run((ctx) =>
					files_media_dependencies_db_append(ctx, {
						setId: f.setId,
						generation: 0,
						offset,
						mappings: f.mappings.slice(offset, offset + 50),
					}),
				),
			).toEqual({ _yay: null });
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId: f.setId });
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(101);
		await f.t.run((ctx) => files_media_dependencies_db_retire(ctx, { setId: f.setId, generation: 0, owner: f.owner }));
		expect(
			await f.t.run((ctx) => files_media_dependencies_db_seal(ctx, { setId: f.setId, generation: 0 })),
		).toHaveProperty("_nay");
		// Fake timers keep the rescheduled cleanup from running, so each call deletes one page.
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId: f.setId });
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(51);
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId: f.setId });
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId))).not.toBeNull();
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId: f.setId });
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(0);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.node.assetId!))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.node._id))).toEqual(f.node);
	});

	test("the recovery job restarts the cleanup of a retired set", async () => {
		const f = await fixture(1);
		expect(
			await f.t.run((ctx) =>
				files_media_dependencies_db_append(ctx, { setId: f.setId, generation: 0, offset: 0, mappings: f.mappings }),
			),
		).toEqual({ _yay: null });
		// Retire without scheduling the cleanup, as if the scheduled cleanup was lost.
		await f.t.run((ctx) =>
			ctx.db.patch("files_media_dependency_sets", f.setId, { owner: { kind: "cleanup" }, generation: 1 }),
		);
		await f.t.mutation(internal.files_media_dependencies.recover_cleanup, {});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId)),
			"recovery finishes the lost cleanup",
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toEqual([]);
	});

	test("does not retire a newer generation or another owner's set", async () => {
		const f = await fixture(0);
		await f.t.run((ctx) => files_media_dependencies_db_retire(ctx, { setId: f.setId, generation: 1, owner: f.owner }));
		await f.t.run((ctx) =>
			files_media_dependencies_db_retire(ctx, {
				setId: f.setId,
				generation: 0,
				owner: f.otherOwner,
			}),
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", f.setId))).toMatchObject({
			generation: 0,
			owner: f.owner,
		});
		expect(await f.t.run((ctx) => files_media_dependencies_db_seal(ctx, { setId: f.setId, generation: 0 }))).toEqual({
			_yay: null,
		});
	});
});
