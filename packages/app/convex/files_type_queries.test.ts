import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { advance, type files_type_queries_Request } from "./files_type_queries.ts";
import { test_spy_handler } from "./setup.test.ts";
import { create_bash_runner, get_seeded_node_id } from "../server/bash.setup.test.ts";
import { files_access_version_db_wrap } from "../server/files-access-version.ts";
import { files_pending_overlay_db_flush, files_pending_overlay_db_wrap } from "../server/files-pending-overlay.ts";
import { files_type_query_page } from "../server/files-type-query.ts";
import { files_content_type_index_fields } from "../shared/files.ts";

type Runner = Awaited<ReturnType<typeof create_bash_runner>>;

function request(runner: Runner, overrides: Partial<files_type_queries_Request> = {}): files_type_queries_Request {
	return {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		overlay: false,
		rootPath: "/docs",
		contentType: "text/",
		directoriesOnly: false,
		limit: 50,
		...overrides,
	};
}

async function write(runner: Runner, handler: (ctx: MutationCtx) => Promise<void>) {
	await runner.t.run(async (ctx) => {
		const access = files_access_version_db_wrap(ctx);
		const wrapped = { ...ctx, ...files_pending_overlay_db_wrap({ ...ctx, db: access.db }) };
		await handler(wrapped);
		await files_pending_overlay_db_flush(wrapped);
		await access.flush();
	});
}

async function member(runner: Runner) {
	return await runner.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "type-query-member" });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
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
}

describe("file type query pages", () => {
	test("saved-only search hides denied files and refuses a page after access is removed", async () => {
		const runner = await create_bash_runner();
		const userId = await member(runner);
		const hiddenId = await get_seeded_node_id(runner, "/docs/readme.md");
		await write(runner, (ctx) => ctx.db.patch("files_nodes", hiddenId, { restrictedScopeNodeId: hiddenId }));
		const input = request(runner, { userId });
		const page = await files_type_query_page(runner.ctx, input, null);
		expect(page._nay).toBeUndefined();
		expect(page._yay?.items.map((item) => item.path)).toEqual(["/docs/nested/deep.md", "/docs/tutorial.md"]);
		expect(page._yay?.isDone).toBe(true);
		const visibleId = await get_seeded_node_id(runner, "/docs/tutorial.md");
		await write(runner, (ctx) => ctx.db.patch("files_nodes", visibleId, { restrictedScopeNodeId: visibleId }));
		const replay = await files_type_query_page(
			runner.ctx,
			input,
			JSON.stringify({ queryId: page._yay!.queryId, step: 0 }),
		);
		expect(replay._nay?.message).toContain("search changed");
		expect(replay._yay).toBeUndefined();
	});

	test.each(["path", "matching MIME", "new matching MIME"] as const)(
		"invalidates continuation after a saved %s change",
		async (change) => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/docs/a.bin", contentType: "application/octet-stream", withoutYjsState: true }],
			});
			const input = request(runner, { limit: 1 });
			const page = await files_type_query_page(runner.ctx, input, null);
			expect(page._yay?.items.map((item) => item.path)).toEqual(["/docs/nested/deep.md"]);
			expect(page._yay?.isDone).toBe(false);
			const id = await get_seeded_node_id(runner, change === "new matching MIME" ? "/docs/a.bin" : "/docs/readme.md");
			await write(runner, async (ctx) => {
				if (change === "path")
					await ctx.db.patch("files_nodes", id, {
						name: "renamed.md",
						path: "/docs/renamed.md",
						treePath: "/docs/renamed.md",
					});
				else {
					const contentType = change === "new matching MIME" ? "text/plain" : "application/octet-stream";
					await ctx.db.patch("files_nodes", id, { contentType, ...files_content_type_index_fields(contentType) });
				}
			});
			const continued = await files_type_query_page(
				runner.ctx,
				input,
				JSON.stringify({ queryId: page._yay!.queryId, step: page._yay!.step }),
			);
			expect(continued._nay?.message).toContain("search changed");
		},
	);

	test("an empty page keeps the full continuation and repeats safely", async () => {
		const runner = await create_bash_runner();
		const input = request(runner, { limit: 2 });
		const start = await runner.t.mutation(internal.files_type_queries.begin, input);
		expect(start._nay).toBeUndefined();
		const position = start._yay!;
		const args = { ...input, ...position, token: "short-page" };
		expect((await runner.t.mutation(internal.files_type_queries.advance, { ...args, seal: false }))._yay?.state).toBe(
			"working",
		);
		const empty = await runner.t.mutation(internal.files_type_queries.advance, { ...args, seal: true });
		expect(empty._yay).toMatchObject({ state: "page", items: [], isDone: false, step: 1 });
		const replay = await files_type_query_page(runner.ctx, input, JSON.stringify(position));
		expect(replay).toEqual(empty);
		const paths: string[] = [];
		let cursor = JSON.stringify({ queryId: position.queryId, step: 1 });
		for (let round = 0; round < 10; round++) {
			const page = await files_type_query_page(runner.ctx, input, cursor);
			expect(page._nay).toBeUndefined();
			paths.push(...page._yay!.items.map((item) => item.path));
			if (page._yay!.isDone) break;
			cursor = JSON.stringify({ queryId: position.queryId, step: page._yay!.step });
		}
		expect(paths).toEqual(["/docs/nested/deep.md", "/docs/readme.md", "/docs/tutorial.md"]);
	});

	test("a cursor belongs to its user and full search request", async () => {
		const runner = await create_bash_runner();
		const input = request(runner, { limit: 1 });
		const first = await files_type_query_page(runner.ctx, input, null);
		expect(first._nay).toBeUndefined();
		const cursor = JSON.stringify({ queryId: first._yay!.queryId, step: first._yay!.step });
		const userId = await member(runner);
		for (const changed of [
			{ userId },
			{ rootPath: "/" },
			{ contentType: "application/" },
			{ overlay: true },
			{ limit: 2 },
		]) {
			const result = await files_type_query_page(runner.ctx, { ...input, ...changed }, cursor);
			expect(result._nay?.message).toContain("search changed");
		}
	});

	test("a malformed query id returns a command error", async () => {
		const runner = await create_bash_runner();
		const result = await files_type_query_page(
			runner.ctx,
			request(runner),
			JSON.stringify({ queryId: "not-an-id", step: 0 }),
		);
		expect(result._nay?.message).toContain("search changed");
	});

	test("stored source key order does not change the source identity", async () => {
		const runner = await create_bash_runner();
		const data = runner.ctxData;
		const source = {
			organizationId: data.organizationId,
			workspaceId: data.workspaceId,
			userId: data.userId,
			threadId: data.threadId,
			membershipId: data.membershipId,
			membershipLifetime: data.membershipLifetime,
			run: null,
		};
		const input = request(runner, { agentSource: source });
		const start = await runner.t.mutation(internal.files_type_queries.begin, input);
		expect(start._nay).toBeUndefined();
		const reordered = {
			run: null,
			membershipLifetime: source.membershipLifetime,
			membershipId: source.membershipId,
			threadId: source.threadId,
			userId: source.userId,
			workspaceId: source.workspaceId,
			organizationId: source.organizationId,
		};
		// Transport order is not part of an identity. Force a different order at the handler boundary.
		test_spy_handler(
			advance,
			async (handler, ctx, args) =>
				await handler(ctx, { ...(args as Record<string, unknown>), agentSource: reordered }),
		);
		const page = await files_type_query_page(
			runner.ctx,
			{ ...input, agentSource: reordered },
			JSON.stringify(start._yay!),
		);
		expect(page._nay).toBeUndefined();
		expect(page._yay?.items).toHaveLength(3);
	});

	test("expired and stopped queries cannot replay a saved page", async () => {
		const runner = await create_bash_runner();
		const input = request(runner);
		for (const state of ["expired", "stopped"] as const) {
			const page = await files_type_query_page(runner.ctx, input, null);
			expect(page._yay?.items).toHaveLength(3);
			await runner.t.run((ctx) =>
				ctx.db.patch(
					"files_type_queries",
					page._yay!.queryId,
					state === "expired" ? { expiresAt: Date.now() - 1 } : { state: "canceled" },
				),
			);
			const replay = await files_type_query_page(
				runner.ctx,
				input,
				JSON.stringify({ queryId: page._yay!.queryId, step: 0 }),
			);
			expect(replay._nay?.message).toContain(state);
		}
	});
});
