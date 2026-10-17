import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { ConvexError } from "convex/values";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import {
	fixture as share_fixture,
	mock_share_storage,
	reset_rate_limits,
	type Fixture,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/**
 * Two restricted folders from before the backfill: `/a` in an open folder and `/a/b` inside `/a`.
 * Neither has `parentScopeNodeId`.
 */
async function fixture() {
	const f = await share_fixture();
	f.t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const folder = async (path: string) => {
		const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/x.md` });
		return (await f.t.run((ctx) => ctx.db.get("files_nodes", fileId)))!.parentId as Id<"files_nodes">;
	};
	const outerId = await folder("/a");
	const innerId = await folder("/a/b");
	for (const nodeId of [outerId, innerId]) {
		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }))._nay,
		).toBeUndefined();
	}
	await f.t.run(async (ctx) => {
		for (const nodeId of [outerId, innerId])
			await ctx.db.patch("files_nodes", nodeId, { parentScopeNodeId: undefined });
	});
	return { ...f, outerId, innerId };
}

async function audit(f: Fixture) {
	const problems = [];
	for (const query of [
		internal.migrations.audit_files_nodes_parent_scope_roots,
		internal.migrations.audit_files_nodes_parent_scope_boundaries,
	]) {
		for (let cursor: string | null = null, done = false; !done;) {
			const page: { page: unknown[]; continueCursor: string; isDone: boolean } = await f.t.query(query, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				cursor,
			});
			problems.push(...page.page);
			cursor = page.continueCursor;
			done = page.isDone;
		}
	}
	return problems;
}

function get_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!);
}

test("the backfill stores each restricted folder's parent scope, with null for an open parent", async () => {
	const f = await fixture();
	expect(await audit(f)).toEqual([
		{ nodeId: f.outerId, problem: "missing" },
		{ nodeId: f.innerId, problem: "missing" },
	]);

	const status = await f.t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.backfill_files_nodes_parent_scope),
	);
	expect(status.isDone).toBe(true);

	expect((await get_node(f, f.outerId)).parentScopeNodeId).toBe(null);
	expect((await get_node(f, f.innerId)).parentScopeNodeId).toBe(f.outerId);
	// A node that is not restricted gets nothing.
	expect((await get_node(f, f.nodeId)).parentScopeNodeId).toBeUndefined();
	expect(await audit(f)).toEqual([]);
});

test("the audit reports a wrong parent scope and a former root that kept the field", async () => {
	const f = await fixture();
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/c/x.md" });
	const openFolderId = (await get_node(f, fileId)).parentId as Id<"files_nodes">;
	await f.t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", f.outerId, { parentScopeNodeId: null });
		await ctx.db.patch("files_nodes", f.innerId, { parentScopeNodeId: null });
		// An open folder whose op is gone, and an open file with no op.
		const endedOpId = await ctx.db.insert("files_subtree_ops", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			status: "running",
			blockedByOpId: null,
			rootNodeIds: [openFolderId],
			treePaths: ["/c/"],
			kind: "scope",
		});
		await ctx.db.delete("files_subtree_ops", endedOpId);
		await ctx.db.patch("files_nodes", openFolderId, { parentScopeNodeId: null, scopeOpId: endedOpId });
		await ctx.db.patch("files_nodes", f.nodeId, { parentScopeNodeId: null });
	});

	expect(await audit(f)).toEqual([
		{ nodeId: f.innerId, problem: "wrong_parent_scope" },
		{ nodeId: openFolderId, problem: "former_root_with_ended_op" },
		{ nodeId: f.nodeId, problem: "former_root_without_op" },
	]);
});

test("the workspace page shows a running scope op", async () => {
	const f = await fixture();
	const page = async () => {
		const rows = [];
		for (let cursor: string | null = null, done = false; !done;) {
			const result = await f.t.query(internal.migrations.audit_files_nodes_parent_scope_workspace_page, { cursor });
			rows.push(...result.page);
			cursor = result.continueCursor;
			done = result.isDone;
		}
		return rows.find((row) => row.workspaceId === f.db.workspaceId);
	};
	expect(await page()).toMatchObject({ liveMoveCohortId: null, scopeOpCount: 0, scopeStatus: "allowed" });

	await f.t.run((ctx) =>
		ctx.db.insert("files_subtree_ops", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			status: "running",
			blockedByOpId: null,
			rootNodeIds: [f.outerId],
			treePaths: ["/a/"],
			kind: "scope",
		}),
	);
	expect(await page()).toMatchObject({ scopeOpCount: 1 });
});

test("the preview rolls back", async () => {
	const f = await fixture();

	const error = await f.t
		.mutation(internal.migrations.preview_files_nodes_parent_scope, { cursor: null })
		.catch((e) => e);

	expect(error).toBeInstanceOf(ConvexError);
	expect(error.data).toMatchObject({ data: { isDone: true } });
	expect((await get_node(f, f.outerId)).parentScopeNodeId).toBeUndefined();
});
