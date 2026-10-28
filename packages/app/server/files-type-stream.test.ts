import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { create_bash_runner, get_seeded_node_id, runner_as_user } from "./bash.setup.test.ts";
import { test_create_saved_placement_fixture } from "./files-saved-placement.test-fixtures.ts";
import { files_saved_placement_db_get_view } from "./files-saved-placement.ts";
import * as typeStream from "./files-type-stream.ts";
import {
	files_type_query_db_consume,
	files_type_query_db_fill_stream,
	files_type_query_db_open_stream,
	files_type_query_page,
} from "./files-type-query.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("type-stream-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each([
	{ rootPath: "/", operation: "Restrict" },
	{ rootPath: "/typed", operation: "Restrict" },
	{ rootPath: "/", operation: "Unrestrict" },
	{ rootPath: "/typed", operation: "Unrestrict" },
])("keeps all MIME matches in order from $rootPath during $operation", async ({ rootPath, operation }) => {
	const paths = Array.from({ length: 150 }, (_, index) => `/typed/${String(index).padStart(3, "0")}.txt`);
	const runner = await create_bash_runner({
		extraFiles: paths.map((path) => ({ path, contentType: "text/plain", withoutYjsState: true })),
	});
	const nodeId = await get_seeded_node_id(runner, "/typed");
	const user = runner_as_user(runner);
	const args = { membershipId: runner.seeded.membershipId, nodeId };
	expect((await user.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
	if (operation === "Unrestrict") {
		await runner.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await user.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeUndefined();
	}
	const children = await runner.t.run((ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name", (q) =>
				q
					.eq("organizationId", runner.seeded.organizationId)
					.eq("workspaceId", runner.seeded.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", nodeId),
			)
			.collect(),
	);
	// The public mutation writes one batch; its scheduled scope work stays paused.
	expect(children.filter((node) => node.restrictedScopeNodeId === null)).toHaveLength(75);
	expect(children.filter((node) => node.restrictedScopeNodeId === nodeId)).toHaveLength(75);
	const request = {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		overlay: true,
		rootPath,
		contentType: "text/plain",
		directoriesOnly: false,
		limit: 50,
	};
	const found: string[] = [];
	let cursor: string | null = null;
	let done = false;
	for (let pageNumber = 0; pageNumber < 60; pageNumber++) {
		const result = await files_type_query_page(runner.ctx, request, cursor);
		if (result._nay) throw new Error(result._nay.message);
		found.push(...result._yay.items.map((item) => item.path));
		if (result._yay.isDone) {
			done = true;
			break;
		}
		cursor = JSON.stringify({ queryId: result._yay.queryId, step: result._yay.step });
	}
	expect(done).toBe(true);
	expect(found).toEqual(paths);
});

test("keeps readable file boundaries and skips locked subtrees before reading their files", async () => {
	const paths = ["/typed/a.txt", "/typed/b/inside.txt", "/typed/b0.txt", "/typed/c.txt", "/typed/d.txt"];
	const runner = await create_bash_runner({
		extraFiles: paths.map((path) => ({ path, contentType: "text/plain", withoutYjsState: true })),
	});
	const memberId = await runner.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
			displayName: "",
			sortDisplayName: "",
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId,
			role: "member",
			now: Date.now(),
		});
		return userId;
	});
	const owner = runner_as_user(runner);
	for (const path of ["/typed/a.txt", "/typed/b", "/typed/c.txt"]) {
		expect(
			(
				await owner.mutation(api.files_sharing.restrict_node, {
					membershipId: runner.seeded.membershipId,
					nodeId: await get_seeded_node_id(runner, path),
				})
			)._nay,
		).toBeUndefined();
	}
	await runner.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(
		(
			await owner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: runner.seeded.membershipId,
				nodeId: await get_seeded_node_id(runner, "/typed/c.txt"),
				principal: { kind: "user", userId: memberId },
				level: "read",
			})
		)._nay,
	).toBeUndefined();
	const read = typeStream.files_type_stream_db_saved_page;
	const readPaths: string[] = [];
	vi.spyOn(typeStream, "files_type_stream_db_saved_page").mockImplementation(async (db, args) => {
		const page = await read(db, args);
		readPaths.push(...page.items.map((item) => item.treePath));
		return page;
	});
	const request = {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: memberId,
		overlay: false,
		rootPath: "/typed",
		contentType: "text/plain",
		directoriesOnly: false,
		limit: 1,
	};
	const found: string[] = [];
	const denied: string[] = [];
	let cursor: string | null = null;
	let done = false;
	for (let step = 0; step < 20; step++) {
		const page = await files_type_query_page(runner.ctx, request, cursor);
		if (page._nay) throw new Error(page._nay.message);
		found.push(...page._yay.items.map((item) => item.path));
		denied.push(...page._yay.denied);
		if (page._yay.isDone) {
			done = true;
			break;
		}
		cursor = JSON.stringify({ queryId: page._yay.queryId, step: page._yay.step });
	}
	expect(done).toBe(true);
	expect(found).toEqual(["/typed/b0.txt", "/typed/c.txt", "/typed/d.txt"]);
	expect(denied).toEqual(["/typed/b"]);
	expect(readPaths).not.toContain("/typed/b/inside.txt");
});

test.each(["to_selected", "to_normal"] as const)(
	"keeps every MIME candidate when sources migrate %s between walk rounds",
	async (direction) => {
		const paths = Array.from({ length: 41 }, (_, index) => `/typed/${String(index).padStart(2, "0")}.txt`);
		const f = await test_create_saved_placement_fixture({ normalPaths: paths });
		const selected = paths.filter((_, index) => index % 2 === 0);
		for (const path of selected) await f.stageNode(f.normalNodes.get(path)!);
		if (direction === "to_normal") await f.publish();
		const started = await f.t.mutation(internal.files_type_queries.begin, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			overlay: false,
			rootPath: "/typed",
			contentType: "text/",
			directoriesOnly: false,
			limit: 50,
		});
		if (started._nay) throw new Error(started._nay.message);
		const queryId = started._yay.queryId;
		await f.t.run(async (ctx) => {
			const file = (await ctx.db.get("files_nodes", f.normalNodes.get(paths[0]!)!))!;
			if (file.parentId === "root") throw new Error("Expected typed folder");
			await ctx.db.patch("files_type_queries", queryId, { root: { kind: "saved", id: file.parentId } });
		});
		const streamId = await f.t.run((ctx) =>
			files_type_query_db_open_stream(ctx.db, {
				queryId,
				kind: "saved",
				moveTargetId: null,
				savedPrefix: "/typed/",
				ownerPrefix: "/typed/",
			}),
		);
		const read = typeStream.files_type_stream_db_saved_page;
		// Keep the real index cursor, but make each read small enough to span several rounds.
		vi.spyOn(typeStream, "files_type_stream_db_saved_page").mockImplementation((db, args) =>
			read(db, { ...args, limit: 3 }),
		);
		const fill = () =>
			f.t.run(async (ctx) => {
				const query = (await ctx.db.get("files_type_queries", queryId))!;
				const stream = (await ctx.db.get("files_type_query_streams", streamId))!;
				await files_type_query_db_fill_stream(
					ctx,
					query,
					stream,
					await files_saved_placement_db_get_view(ctx.db, query),
				);
			});
		await fill();
		expect((await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId)))!.buffer.length).toBeGreaterThan(
			0,
		);
		// A walk reads both sources in one transaction. Migrate before its next saved round.
		if (direction === "to_normal") {
			for (const path of selected) await f.materializeNode(f.normalNodes.get(path)!);
		} else {
			for (const path of paths.filter((_, index) => index % 2 !== 0)) await f.stageNode(f.normalNodes.get(path)!);
		}
		const found: string[] = [];
		let done = false;
		for (let step = 0; step < 500; step++) {
			const stream = (await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId)))!;
			if (stream.done) {
				done = true;
				break;
			}
			if (stream.buffer.length === 0) await fill();
			else {
				found.push(stream.buffer[0]!.key.path);
				await f.t.run((ctx) => files_type_query_db_consume(ctx.db, stream));
			}
		}
		expect(done).toBe(true);
		expect(found).toEqual(paths);
	},
);

test("keeps an empty walk cursor until its source has results", async () => {
	const f = await test_create_saved_placement_fixture({ normalPaths: ["/typed/a.txt"] });
	const started = await f.t.mutation(internal.files_type_queries.begin, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		overlay: false,
		rootPath: "/typed",
		contentType: "text/",
		directoriesOnly: false,
		limit: 50,
	});
	if (started._nay) throw new Error(started._nay.message);
	const queryId = started._yay.queryId;
	await f.t.run(async (ctx) => {
		const file = (await ctx.db.get("files_nodes", f.normalNodes.get("/typed/a.txt")!))!;
		if (file.parentId === "root") throw new Error("Expected typed folder");
		await ctx.db.patch("files_type_queries", queryId, { root: { kind: "saved", id: file.parentId } });
	});
	const streamId = await f.t.run((ctx) =>
		files_type_query_db_open_stream(ctx.db, {
			queryId,
			kind: "saved",
			moveTargetId: null,
			savedPrefix: "/typed/",
			ownerPrefix: "/typed/",
		}),
	);
	const walkPage = typeStream.files_type_stream_db_walk;
	const cursor = { key: ["/typed/"], inclusive: false };
	const page = vi
		.spyOn(typeStream, "files_type_stream_db_walk")
		.mockResolvedValueOnce({ items: [], cursor, lowerPath: "/typed/" })
		.mockImplementationOnce(async (ctx, args) => {
			expect(args.cursor).toEqual(cursor);
			return walkPage(ctx, args);
		});
	const fill = () =>
		f.t.run(async (ctx) => {
			const query = (await ctx.db.get("files_type_queries", queryId))!;
			const stream = (await ctx.db.get("files_type_query_streams", streamId))!;
			await files_type_query_db_fill_stream(ctx, query, stream, await files_saved_placement_db_get_view(ctx.db, query));
		});
	await fill();
	expect(await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId))).toMatchObject({
		readSource: 0,
		readCursor: null,
		done: false,
		buffer: [],
		batches: [],
	});
	await fill();
	expect(page).toHaveBeenCalledTimes(2);
	const stream = (await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId)))!;
	expect(stream.buffer.map((item) => item.key.path)).toEqual(["/typed/a.txt"]);
	await f.t.run((ctx) => files_type_query_db_consume(ctx.db, stream));
	expect(await f.t.run((ctx) => ctx.db.get("files_type_query_streams", streamId))).toMatchObject({ done: true });
});
