import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(ready = true) {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/draft/note.md",
		kind: "file",
	});
	if (created._nay) throw new Error(created._nay.message);
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	if (target.kind !== "private" || !pendingUpdateId || !operationBatchId) throw new Error("Expected a private file");
	await t.run(async (ctx) => {
		const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
		if (proposal?.createIntent?.kind !== "text") throw new Error("Expected text intent");
		await ctx.db.patch("files_pending_updates", pendingUpdateId, {
			createIntent: { ...proposal.createIntent, metadata: [{ key: "source", value: "captured" }] },
		});
	});
	if (ready) {
		for (const [role, text] of [
			["staged", ""],
			["unstaged", "---\nstatus: draft\n---\nprivateneedle\n"],
		] as const) {
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				operationBatchId,
				role,
				text,
			});
			if (staged._nay) throw new Error(staged._nay.message);
		}
		const result = await asUser.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target,
			pendingUpdateId,
			operationBatchId,
		});
		if (result._nay) throw new Error(result._nay.message);
	}
	return { t, db, asUser, target, pendingUpdateId };
}

describe("private search", () => {
	test("finds ready content, frontmatter, and captured metadata through private targets", async () => {
		const f = await fixture();
		const content = await f.asUser.query(api.files_nodes.search_content, {
			membershipId: f.db.membershipId,
			query: "privateneedle",
			targets: [f.target],
		});
		expect(content).toMatchObject({ results: [{ target: f.target, path: "/draft/note.md" }], truncated: false });
		for (const [fieldPath, value] of [
			["frontmatter.status", "draft"],
			["metadata.source", "captured"],
		]) {
			expect(
				await f.asUser.query(api.files_metadata.search_nodes, {
					membershipId: f.db.membershipId,
					plans: [{ op: "eq", fieldPath, value }],
				}),
			).toEqual({ targets: [f.target], truncated: false });
			expect(
				await f.asUser.query(api.files_metadata.list_search_values, {
					membershipId: f.db.membershipId,
					fieldPath,
					prefix: "",
				}),
			).toEqual([value]);
		}
		const grep = await f.t.query(internal.files_nodes.match_text_file_lines, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: f.target,
			pattern: "privateneedle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		expect(grep).toMatchObject({ target: f.target, selectedCount: 1, scanTruncated: false });
		const textgrep = await f.t.query(internal.files_nodes.match_plain_text_file_lines, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: f.target,
			pattern: "privateneedle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		expect(textgrep).toMatchObject({ target: f.target, selectedCount: 1, scanTruncated: false });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test("uses the current ancestor path and hides the draft from other or inactive members", async () => {
		const f = await fixture();
		const parent = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.db.membershipId,
			path: "/draft",
		});
		if (!parent) throw new Error("Expected the private parent");
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: parent.target,
			destParent: { kind: "root" },
			destName: "renamed",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const search = (userId = f.db.userId, pathPrefix = "/renamed") =>
			f.t.query(internal.files_nodes.text_search_files, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				query: "privateneedle",
				hasWorkspaceRead: true,
				pathPrefix,
				numItems: 20,
				cursor: null,
			});
		expect((await search()).items).toMatchObject([{ target: f.target, path: "/renamed/note.md" }]);
		expect((await search(f.db.userId, "/draft")).items).toEqual([]);
		const metadata = await f.t.query(internal.files_metadata.search, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			plan: { op: "eq", fieldPath: "metadata.source", value: "captured" },
			pathPrefix: "/renamed",
			numItems: 20,
			cursor: null,
		});
		expect(metadata.items).toMatchObject([{ target: f.target, path: "/renamed/note.md" }]);
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect((await search(other.userId)).items).toEqual([]);
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect((await search()).items).toEqual([]);
	});

	test("includes the selected folder and its children in metadata search", async () => {
		const f = await fixture();
		const parent = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.db.membershipId,
			path: "/draft",
		});
		if (!parent) throw new Error("Expected the private parent");
		for (const path of ["/draft", "/draft/note.md"]) {
			const updated = await f.t.mutation(internal.files_metadata.update_entries_by_path, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				path,
				set: [{ key: "scope", value: "selected" }],
				remove: [],
			});
			if (updated._nay) throw new Error(updated._nay.message);
		}
		const plan = { op: "eq" as const, fieldPath: "metadata.scope", value: "selected" };
		const internalResult = await f.t.query(internal.files_metadata.search, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			plan,
			pathPrefix: "/draft",
			numItems: 20,
			cursor: null,
		});
		expect(internalResult.items.map((item) => item.path).sort()).toEqual(["/draft", "/draft/note.md"]);
		const publicResult = await f.asUser.query(api.files_metadata.search_nodes, {
			membershipId: f.db.membershipId,
			plans: [plan],
			pathPrefix: "/draft",
		});
		expect(publicResult.truncated).toBe(false);
		expect(publicResult.targets).toHaveLength(2);
		expect(publicResult.targets).toEqual(expect.arrayContaining([parent.target, f.target]));
	});

	test("ignores stale indexed revisions and refuses content reads before preparation finishes", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			for (const table of ["files_plain_text_chunks", "files_metadata_docs"] as const) {
				const docs = await ctx.db.query(table).collect();
				for (const document of docs)
					if (document.sourceKind === "pending") {
						await ctx.db.patch(table, document._id, { proposalRevision: document.proposalRevision - 1 });
					}
			}
		});
		expect(
			await f.asUser.query(api.files_nodes.search_content, {
				membershipId: f.db.membershipId,
				query: "privateneedle",
			}),
		).toEqual({ results: [], truncated: false });
		expect(
			await f.asUser.query(api.files_metadata.search_nodes, {
				membershipId: f.db.membershipId,
				plans: [{ op: "exists", fieldPath: "metadata.source" }],
			}),
		).toEqual({ targets: [], truncated: false });
		const preparing = await fixture(false);
		expect(
			await preparing.t.query(internal.files_nodes.match_text_file_lines, {
				organizationId: preparing.db.organizationId,
				workspaceId: preparing.db.workspaceId,
				userId: preparing.db.userId,
				target: preparing.target,
				pattern: "needle",
				ignoreCase: false,
				fixedStrings: true,
				invert: false,
				before: 0,
				after: 0,
			}),
		).toBeNull();
	});
});
