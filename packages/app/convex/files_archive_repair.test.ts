import { createHash } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { r2 } from "./r2_client.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_db_hold_move_slot,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_pending_overlay_db_schedule_saved_scope } from "../server/files-pending-overlay.ts";

const scope = vi.hoisted(() => [] as Array<(typeof import("./files_archive_repair_scope.ts"))["files_archive_repair_scope"][number]>);
vi.mock("./files_archive_repair_scope.ts", () => ({ files_archive_repair_scope: scope }));

const repair = makeFunctionReference<"mutation", { index: number }, null>("files_archive_repair:repair_one");

function hash(value: unknown): string {
	const sorted = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(sorted);
		if (item !== null && typeof item === "object")
			return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(Reflect.get(item, key))]));
		return item;
	};
	return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("CONVEX_CLOUD_URL", "https://grand-finch-267.convex.cloud");
	vi.spyOn(r2, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
	scope.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId, path: "/archive-repair.md", textContent: "Keep this exact text.\n",
	});
	const docs = await t.run(async (ctx) => {
		// These old files have no index state. Remove only the fixture's completed state.
		const state = await ctx.db.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId)).unique();
		if (state) {
			expect(state.activeRunId).toBeNull();
			expect(state.needsRun).toBe(false);
			await ctx.db.delete("files_index_states", state._id);
		}
		// Recreate the old drift: the node is archived but its search doc is not.
		await ctx.db.patch("files_nodes", nodeId, { archiveOperationId: "chitchat-projection:test" });
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const search = await ctx.db.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId))
			.unique();
		if (!search) throw new Error("Expected one search doc");
		const text = (await ctx.db.get("files_text_chunks", search.textChunkId))!;
		return { node, text, search };
	});
	scope.push({
		nodeId, textId: docs.text._id, searchId: docs.search._id,
		organizationId: db.organizationId, workspaceId: db.workspaceId,
		archiveOperationId: docs.node.archiveOperationId!,
		nodeHash: hash(docs.node), textHash: hash(docs.text), searchHash: hash(docs.search),
		afterSearchHash: hash({ ...docs.search, archiveOperationId: docs.node.archiveOperationId }),
	});
	const read = () => t.run(async (ctx) => ({
		node: await ctx.db.get("files_nodes", nodeId),
		text: await ctx.db.get("files_text_chunks", docs.text._id),
		search: await ctx.db.get("files_plain_text_chunks", docs.search._id),
	}));
	return { t, db, ...docs, read };
}

test("changes only the approved search archive marker and refuses a repeat", async () => {
	const f = await fixture();
	await expect(f.t.mutation(repair, { index: 0 }), "repair must commit the approved archive marker").resolves.toBeNull();
	const after = await f.read();
	expect(after.search?.archiveOperationId, "search marker must equal the archived node marker")
		.toBe(f.node.archiveOperationId);
	expect(after).toEqual({
		node: f.node, text: f.text, search: { ...f.search, archiveOperationId: f.node.archiveOperationId },
	});
	await expect(f.t.mutation(repair, { index: 0 })).rejects.toThrow("document guard failed");
	expect(await f.read()).toEqual(after);
});

test.each([-1, 0.5, 1])("refuses unapproved index %s", async (index) => {
	const f = await fixture();
	await expect(f.t.mutation(repair, { index })).rejects.toThrow("index is not approved");
	expect(await f.read()).toEqual({ node: f.node, text: f.text, search: f.search });
});

test("refuses another deployment", async () => {
	const f = await fixture();
	vi.stubEnv("CONVEX_CLOUD_URL", "https://wrong.convex.cloud");
	await expect(f.t.mutation(repair, { index: 0 })).rejects.toThrow("deployment mismatch");
	expect(await f.read()).toEqual({ node: f.node, text: f.text, search: f.search });
});

test.each(["path", "tenant", "content", "owner", "node marker", "search marker", "hash"] as const)(
	"refuses stale %s without changing docs", async (change) => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			if (change === "path") await ctx.db.patch("files_plain_text_chunks", f.search._id, { path: "/changed.md" });
			if (change === "tenant") {
				const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-repair-tenant" });
				await ctx.db.patch("files_plain_text_chunks", f.search._id, { workspaceId: other.workspaceId });
			}
			if (change === "content") await ctx.db.patch("files_text_chunks", f.text._id, { textChunk: "Changed text" });
			if (change === "owner") await ctx.db.patch("files_plain_text_chunks", f.search._id, { contentHeadId: undefined });
			if (change === "node marker") await ctx.db.patch("files_nodes", f.node._id, { archiveOperationId: "changed" });
			if (change === "search marker") await ctx.db.patch("files_plain_text_chunks", f.search._id, { archiveOperationId: "changed" });
			if (change === "hash") await ctx.db.patch("files_nodes", f.node._id, { updatedAt: f.node.updatedAt + 1 });
		});
		const before = await f.read();
		await expect(f.t.mutation(repair, { index: 0 })).rejects.toThrow(
			change === "content" || change === "hash" ? "baseline changed" : "document guard failed",
		);
		expect(await f.read()).toEqual(before);
	},
);

test.each(["job", "index", "Move"] as const)("refuses busy %s work", async (kind) => {
	const f = await fixture();
	await f.t.run(async (ctx) => {
		if (kind === "job") await files_pending_overlay_db_schedule_saved_scope(ctx, f.node);
		if (kind === "Move") await test_db_hold_move_slot(ctx, f.db);
		if (kind === "index") await ctx.db.insert("files_index_states", {
			organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, fileNodeId: f.node._id,
			contentRevision: 1, requestedRevision: 1, requestedHeadId: f.node.contentHeadId!,
			publishedRevision: 0, publishedHeadId: null, activeRunId: null, needsRun: true,
			nextAttemptAt: Date.now(), movePublication: null,
		});
	});
	const before = await f.read();
	await expect(f.t.mutation(repair, { index: 0 })).rejects.toThrow("blocked by active work");
	expect(await f.read()).toEqual(before);
});

test("refuses a changed expected after hash before writing", async () => {
	const f = await fixture();
	scope[0]!.afterSearchHash = hash({ ...f.search, path: "/wrong.md", archiveOperationId: f.node.archiveOperationId });
	await expect(f.t.mutation(repair, { index: 0 })).rejects.toThrow("baseline changed");
	expect(await f.read()).toEqual({ node: f.node, text: f.text, search: f.search });
});
