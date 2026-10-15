import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { create_bash_runner } from "../server/bash.setup.test.ts";
import { files_type_query_db_delete_batch, files_type_query_db_open_stream } from "../server/files-type-query.ts";

async function fixture() {
	const runner = await create_bash_runner();
	const input = {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		overlay: false,
		rootPath: "/docs",
		contentType: "text/",
		directoriesOnly: false,
		limit: 2,
	};
	const result = await runner.t.mutation(internal.files_type_queries.begin, input);
	if (result._nay) throw new Error(result._nay.message);
	const queryId = result._yay.queryId;
	await runner.t.run(async (ctx) => {
		await files_type_query_db_open_stream(ctx.db, {
			queryId,
			kind: "saved",
			moveTargetId: null,
			savedPrefix: "/docs/",
			ownerPrefix: "/docs/",
		});
		await ctx.db.insert("files_type_query_steps", { queryId, step: 0, items: [], sealed: false, isDone: false });
		for (const key of ["root", "frame:1", "frame:2"])
			await ctx.db.insert("files_type_query_work", { queryId, key, value: "{}" });
	});
	return { ...runner, input, queryId };
}

describe("file type query cleanup", () => {
	test.each(["user", "workspace"] as const)("%s deletion drains queries before their headers", async (scope) => {
		const f = await fixture();
		const requestId =
			scope === "workspace"
				? await f.t.run((ctx) =>
						data_deletion_db_request(ctx, {
							...f.input,
							scope: "workspace",
							eligibleAt: 0,
						}),
					)
				: null;
		let done = false;
		for (let pass = 0; pass < 100; pass++) {
			const result =
				scope === "user"
					? await f.t.mutation(internal.data_deletion.hard_delete_user_data, {
							userId: f.input.userId,
							_test_batchSize: 1,
						})
					: await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
							requestId: requestId!,
							_test_batchSize: 1,
						});
			if (result.done) {
				done = true;
				break;
			}
		}
		expect(done).toBe(true);
		expect(
			await f.t.run((ctx) => ctx.db.query("files_type_queries").collect()),
			"deletion removes the query header",
		).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_type_query_streams").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_type_query_steps").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_type_query_work").collect())).toEqual([]);
	});

	test("bounded cleanup cancels first, deletes children, then removes the header", async () => {
		const f = await fixture();
		const other = await f.t.mutation(internal.files_type_queries.begin, f.input);
		if (other._nay) throw new Error(other._nay.message);
		for (let pass = 0; pass < 6; pass++) {
			const deleted = await f.t.run((ctx) => files_type_query_db_delete_batch(ctx.db, f.queryId, 1));
			expect(deleted).toBe(1);
			const header = await f.t.run((ctx) => ctx.db.get("files_type_queries", f.queryId));
			if (pass < 5) expect(header?.state).toBe("canceled");
			else expect(header).toBeNull();
		}
		const remaining = await f.t.run(async (ctx) => ({
			streams: await ctx.db.query("files_type_query_streams").collect(),
			steps: await ctx.db.query("files_type_query_steps").collect(),
			work: await ctx.db.query("files_type_query_work").collect(),
			other: await ctx.db.get("files_type_queries", other._yay.queryId),
		}));
		expect(remaining.streams).toEqual([]);
		expect(remaining.steps).toEqual([]);
		expect(remaining.work).toEqual([]);
		expect(remaining.other?.state).toBe("preparing");
		expect(await f.t.run((ctx) => files_type_query_db_delete_batch(ctx.db, f.queryId, 1))).toBe(0);
	});

	test("the expiry worker drains all child families and leaves a live query", async () => {
		const f = await fixture();
		const live = await f.t.mutation(internal.files_type_queries.begin, f.input);
		if (live._nay) throw new Error(live._nay.message);
		await f.t.run((ctx) => ctx.db.patch("files_type_queries", f.queryId, { expiresAt: Date.now() - 1 }));
		for (let pass = 0; pass < 4; pass++) await f.t.mutation(internal.files_type_queries.cleanup_expired, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_type_queries", f.queryId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_type_query_work").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("files_type_queries", live._yay.queryId))).not.toBeNull();
	});
});
