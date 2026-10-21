import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_LIMITS_AT_75_PERCENT } from "./setup.test.ts";
import type { files_type_queries_Request } from "./files_type_queries.ts";
import { create_bash_runner, drain_scheduled_continuations, get_seeded_node_id } from "../server/bash.setup.test.ts";
import { files_type_query_page } from "../server/files-type-query.ts";
import { files_content_type_index_fields } from "../shared/files.ts";

type Runner = Awaited<ReturnType<typeof create_bash_runner>>;

function request(runner: Runner, overrides: Partial<files_type_queries_Request> = {}): files_type_queries_Request {
	return {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		overlay: true,
		rootPath: "/targets",
		contentType: "text/plain",
		directoriesOnly: false,
		limit: 3,
		...overrides,
	};
}

describe("file type query scale and retries", () => {
	test("resumes a 500-area walk and owner path within transaction limits", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const userId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: id,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: id,
				role: "member",
				now: Date.now(),
			});
			return id;
		});
		let parent: Doc<"files_nodes"> | null = null;
		for (let start = 0; start < 500; start += 50) {
			parent = await t.run(async (ctx) => {
				let above = parent;
				for (let depth = start + 1; depth <= start + 50; depth++) {
					const path = `${above?.path ?? ""}/a`;
					const id = await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						createdBy: scope.userId,
						updatedBy: scope.userId,
						parentId: above?._id ?? "root",
						name: "a",
						sortName: "a",
						path,
						treePath: `${path}/`,
						pathDepth: depth,
					});
					await ctx.db.patch("files_nodes", id, {
						isRestrictedScopeRoot: true,
						restrictedScopeNodeId: id,
						parentScopeNodeId: above?._id ?? null,
					});
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						resourceKind: "file",
						resourceId: String(id),
						principalKind: "user",
						userId,
						permission: "content.read",
						createdAt: 1,
						updatedAt: 1,
					});
					above = (await ctx.db.get("files_nodes", id))!;
				}
				return above;
			});
		}
		const deepest = parent!;
		const path = `${deepest.path}/hit.txt`;
		expect(path.length).toBeLessThanOrEqual(1024);
		await t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				parentId: deepest._id,
				name: "hit.txt",
				sortName: "hit.txt",
				path,
				treePath: path,
				pathDepth: 501,
				kind: "file",
				contentType: "text/plain",
				...files_content_type_index_fields("text/plain"),
				restrictedScopeNodeId: deepest._id,
			}),
		);
		const input: files_type_queries_Request = {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId,
			overlay: true,
			rootPath: "/",
			contentType: "text/",
			directoriesOnly: false,
			limit: 1,
		};
		const started = await t.mutation(internal.files_type_queries.begin, input);
		if (started._nay) throw new Error(started._nay.message);
		let checked = 0;
		const advance = () =>
			t.run(async (ctx) => {
				const result = await ctx.runMutation(internal.files_type_queries.advance, {
					...input,
					...started._yay,
					token: "deep-walk",
					seal: false,
				});
				const metrics = await ctx.meta.getTransactionMetrics();
				for (const [key, limit] of Object.entries(test_LIMITS_AT_75_PERCENT))
					expect(metrics[key as keyof typeof metrics].used, key).toBeLessThanOrEqual(limit);
				checked++;
				return result;
			});
		expect((await advance())._yay?.state).toBe("working");
		// Start with empty work so every boundary and owner-path step uses real continuation.
		let paths: string[] = [];
		for (let step = 0; step < 2_000; step++) {
			const result = await advance();
			if (result._nay) throw new Error(result._nay.message);
			if (result._yay.state === "page") {
				paths = result._yay.items.map((item) => item.path);
				expect(result._yay.denied).toEqual([]);
				break;
			}
		}
		expect(paths).toEqual([path]);
		expect(checked).toBeGreaterThan(500);
	}, 120_000);

	test("pages all 257 moved subtrees in exact alphabetical order", async () => {
		const names = Array.from({ length: 257 }, (_, index) => String(index).padStart(3, "0"));
		const runner = await create_bash_runner({
			extraFiles: [
				...names.map((name) => ({
					path: `/sources/${name}/hit.txt`,
					content: "hit",
					contentType: "text/plain",
					withoutYjsState: true,
				})),
				{ path: "/targets/anchor.bin", contentType: "application/octet-stream", withoutYjsState: true },
			],
		});
		const parentId = await get_seeded_node_id(runner, "/targets");
		// Reverse creation order so the query must sort by the owner's path.
		for (const name of names.toReversed()) {
			const moved = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				target: { kind: "saved", id: await get_seeded_node_id(runner, `/sources/${name}`) },
				destParent: { kind: "saved", id: parentId },
				destName: name,
			});
			expect(moved._nay, name).toBeUndefined();
		}
		await drain_scheduled_continuations(runner);
		const input = request(runner);
		const start = await runner.t.mutation(internal.files_type_queries.begin, input);
		if (start._nay) throw new Error(start._nay.message);
		const paths: string[] = [];
		let cursor = JSON.stringify(start._yay);
		let done = false;
		for (let pageNumber = 0; pageNumber < 400; pageNumber++) {
			const page = await files_type_query_page(runner.ctx, input, cursor);
			if (page._nay) throw new Error(page._nay.message);
			expect(page._yay.items.length).toBeLessThanOrEqual(input.limit);
			paths.push(...page._yay.items.map((item) => item.path));
			if (page._yay.isDone) {
				done = true;
				break;
			}
			cursor = JSON.stringify({ queryId: page._yay.queryId, step: page._yay.step });
		}
		expect(done, "all streams finish without a total stream cap").toBe(true);
		expect(paths).toEqual(names.map((name) => `/targets/${name}/hit.txt`));
		const streams = await runner.t.run((ctx) =>
			ctx.db
				.query("files_type_query_streams")
				.withIndex("by_query", (q) => q.eq("queryId", start._yay.queryId))
				.collect(),
		);
		expect(streams.filter((stream) => stream.moveTargetId !== null)).toHaveLength(257);
		expect(streams.length).toBeGreaterThan(256);
		expect(streams.every((stream) => stream.done)).toBe(true);
	}, 120_000);

	test("keeps raw indexed Unicode path order across small pages", async () => {
		const names = ["中.txt", "a.txt", "Ω.txt", "Z.txt", "é.txt", "z.txt", "A.txt"];
		const runner = await create_bash_runner({
			extraFiles: names.map((name) => ({ path: `/raw/${name}`, content: name, contentType: "text/plain" })),
		});
		const input = request(runner, { rootPath: "/raw", overlay: false, limit: 2 });
		const paths: string[] = [];
		let cursor: string | null = null;
		let done = false;
		for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
			const page = await files_type_query_page(runner.ctx, input, cursor);
			if (page._nay) throw new Error(page._nay.message);
			paths.push(...page._yay.items.map((item) => item.path));
			if (page._yay.isDone) {
				done = true;
				break;
			}
			cursor = JSON.stringify({ queryId: page._yay.queryId, step: page._yay.step });
		}
		expect(done).toBe(true);
		expect(paths).toEqual([
			"/raw/A.txt",
			"/raw/Z.txt",
			"/raw/a.txt",
			"/raw/z.txt",
			"/raw/é.txt",
			"/raw/Ω.txt",
			"/raw/中.txt",
		]);
	});

	test("same-cursor callers share one receipt and old pages replay after later pages", async () => {
		const runner = await create_bash_runner();
		const input = request(runner, { rootPath: "/docs", contentType: "text/", limit: 1 });
		const start = await runner.t.mutation(internal.files_type_queries.begin, input);
		if (start._nay) throw new Error(start._nay.message);
		const cursor = JSON.stringify(start._yay);
		const concurrent = await Promise.all([
			files_type_query_page(runner.ctx, input, cursor),
			files_type_query_page(runner.ctx, input, cursor),
		]);
		for (const result of concurrent) expect(result._nay).toBeUndefined();
		const first = await files_type_query_page(runner.ctx, input, cursor);
		expect(first._yay).toMatchObject({
			state: "page",
			step: 1,
			items: [{ path: "/docs/nested/deep.md" }],
			isDone: false,
		});
		for (const result of concurrent) {
			if (result._yay?.state === "page") expect(result).toEqual(first);
		}
		const next = await files_type_query_page(
			runner.ctx,
			input,
			JSON.stringify({ queryId: start._yay.queryId, step: 1 }),
		);
		expect(next._yay?.items.map((item) => item.path)).toEqual(["/docs/readme.md"]);
		expect(await files_type_query_page(runner.ctx, input, cursor)).toEqual(first);
		const receipts = await runner.t.run((ctx) =>
			ctx.db
				.query("files_type_query_steps")
				.withIndex("by_query_step", (q) => q.eq("queryId", start._yay.queryId))
				.collect(),
		);
		expect(receipts.map((receipt) => receipt.step)).toEqual([0, 1]);
		expect(receipts.every((receipt) => receipt.sealed)).toBe(true);
	});

	test("a changed moved source refuses both a sealed replay and its next page", async () => {
		const runner = await create_bash_runner({
			extraFiles: [
				{ path: "/sources/a/one.txt", content: "one", contentType: "text/plain" },
				{ path: "/sources/a/two.txt", content: "two", contentType: "text/plain" },
				{ path: "/targets/anchor.bin", contentType: "application/octet-stream", withoutYjsState: true },
			],
		});
		const move = {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			target: { kind: "saved" as const, id: await get_seeded_node_id(runner, "/sources/a") },
			destParent: { kind: "saved" as const, id: await get_seeded_node_id(runner, "/targets") },
			destName: "a",
		};
		expect(
			(await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, move))._nay,
		).toBeUndefined();
		await drain_scheduled_continuations(runner);
		const input = request(runner, { limit: 1 });
		const first = await files_type_query_page(runner.ctx, input, null);
		expect(first._yay?.items.map((item) => item.path)).toEqual(["/targets/a/one.txt"]);
		expect(
			(
				await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...move,
					destName: "z",
				})
			)._nay,
		).toBeUndefined();
		await drain_scheduled_continuations(runner);
		for (const step of [0, first._yay!.step]) {
			const result = await files_type_query_page(
				runner.ctx,
				input,
				JSON.stringify({ queryId: first._yay!.queryId, step }),
			);
			expect(result._nay?.message).toContain("search changed");
			expect(result._yay).toBeUndefined();
		}
	});
});
