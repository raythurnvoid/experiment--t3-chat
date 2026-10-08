import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { db_insert_file_text_content } from "./files_nodes_content.ts";
import { test_convex, test_meta_search, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ancestor_fields } from "../shared/files.ts";

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

/**
 * Run the overlay jobs that draft writes scheduled. They write the place fields that `meta search`
 * reads for drafts. Move the clock only a little, so the drafts do not expire.
 */
async function run_overlay_jobs(t: ReturnType<typeof test_convex>) {
	vi.advanceTimersByTime(1);
	await t.finishInProgressScheduledFunctions();
}

describe("private search", () => {
	test("the agent finds ready content, frontmatter, and captured metadata through private targets", async () => {
		const f = await fixture();
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const content = await f.t.query(internal.files_nodes.text_search_files, {
			...scope,
			hasWorkspaceRead: true,
			query: "privateneedle",
			targets: [f.target],
			numItems: 20,
			cursor: null,
		});
		expect(content.items).toMatchObject([{ target: f.target, path: "/draft/note.md" }]);
		await run_overlay_jobs(f.t);
		for (const [fieldPath, value] of [
			["frontmatter.status", "draft"],
			["metadata.source", "captured"],
		]) {
			const metadata = await test_meta_search(f.t, { ...scope, plan: { op: "eq", fieldPath, value } });
			expect(metadata.items).toMatchObject([{ target: f.target, path: "/draft/note.md" }]);
			// The search box is saved-only: no suggestion and no row from a draft.
			expect(
				await f.asUser.query(api.files_metadata.list_search_values, {
					membershipId: f.db.membershipId,
					fieldPath,
					prefix: "",
				}),
			).toEqual([]);
		}
		const fields = await f.asUser.query(api.files_metadata.list_search_fields, { membershipId: f.db.membershipId });
		expect(fields).toEqual([]);
		for (const clause of [
			{ kind: "name", text: "note" },
			{ kind: "content", text: "privateneedle" },
			{ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.source", value: "captured" } },
			{ kind: "path", path: "/draft/note.md" },
		] as const) {
			expect(
				await f.asUser.query(api.files_nodes.search_saved, {
					membershipId: f.db.membershipId,
					clause,
					paginationOpts: { numItems: 50, cursor: null },
				}),
			).toMatchObject({ page: [], isDone: true });
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
		await run_overlay_jobs(f.t);
		const metadata = await test_meta_search(f.t, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			plan: { op: "eq", fieldPath: "metadata.source", value: "captured" },
			folderPath: "/renamed",
		});
		expect(metadata.items).toMatchObject([{ target: f.target, path: "/renamed/note.md" }]);
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect((await search(other.userId)).items).toEqual([]);
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect((await search()).items).toEqual([]);
	});

	test("includes the selected folder and its children in metadata search", async () => {
		const f = await fixture();
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
		await run_overlay_jobs(f.t);
		const internalResult = await test_meta_search(f.t, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			plan,
			folderPath: "/draft",
		});
		expect(internalResult.items.map((item) => item.path).sort()).toEqual(["/draft", "/draft/note.md"]);
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
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const content = await f.t.query(internal.files_nodes.text_search_files, {
			...scope,
			hasWorkspaceRead: true,
			query: "privateneedle",
			numItems: 20,
			cursor: null,
		});
		expect(content.items).toEqual([]);
		const metadata = await test_meta_search(f.t, { ...scope, plan: { op: "exists", fieldPath: "metadata.source" } });
		expect(metadata.items).toEqual([]);
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

describe("saved search during an archive", () => {
	test("keeps an item whose folder is stamped until the item gets its own stamp", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...scope,
			path: "/docs",
		});
		if (created._nay) throw new Error(created._nay.message);
		const docsId = created._yay.nodeId;
		const innerId = await t.run(async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: docsId,
				name: "inner.md",
				kind: "file",
				path: "/docs/inner.md",
				treePath: "/docs/inner.md",
				pathDepth: 2,
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				textKind: "rich_text",
				collaborationEnabled: false,
				...files_ancestor_fields([docsId]),
			});
			const committed = await db_insert_file_text_content(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				path: "/docs/inner.md",
				rootKind: "rich_text",
				textContent: "catchup here\n",
			});
			if (committed._nay) throw new Error(committed._nay.message);
			return nodeId;
		});
		// The owner reader of the agent's content search keeps a hit under a stamped folder until the hit
		// itself is stamped. Its first page reads the owner's draft chunks, and the next page reads the
		// saved chunks, so read every page.
		const search = async () => {
			const targets: FunctionReturnType<typeof internal.files_nodes.text_search_files>["items"][number]["target"][] =
				[];
			let cursor: string | null = null;
			for (let page = 0; page < 3; page++) {
				const result: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await t.query(
					internal.files_nodes.text_search_files,
					{ ...scope, hasWorkspaceRead: true, query: "catchup", numItems: 20, cursor },
				);
				targets.push(...result.items.map((item) => item.target));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			return targets;
		};
		expect(await search()).toEqual([{ kind: "saved", id: innerId }]);

		// The archive job stamped the folder but has not reached the item inside yet.
		await t.run((ctx) => ctx.db.patch("files_nodes", docsId, { archiveOperationId: "archive-1" }));
		expect(await search()).toEqual([{ kind: "saved", id: innerId }]);

		// The job stamps the item and its index docs. Now search drops it.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", innerId, { archiveOperationId: "archive-1" });
			for (const chunk of await ctx.db.query("files_plain_text_chunks").collect()) {
				if (chunk.sourceKind === "committed" && chunk.fileNodeId === innerId) {
					await ctx.db.patch("files_plain_text_chunks", chunk._id, { archiveOperationId: "archive-1" });
				}
			}
		});
		expect(await search()).toEqual([]);
	});
});

describe("content search on a deep file", () => {
	test("finds one file 110 folders deep in one row", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const owner = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: Date.now(),
			};
			let parentId: Id<"files_nodes"> | "root" = "root";
			const ancestors: Id<"files_nodes">[] = [];
			let path = "";
			for (let level = 1; level <= 110; level++) {
				if (parentId !== "root") ancestors.push(parentId);
				path += `/d${level}`;
				parentId = await ctx.db.insert("files_nodes", {
					...owner,
					parentId,
					name: `d${level}`,
					kind: "folder",
					path,
					treePath: `${path}/`,
					pathDepth: level,
					...files_ancestor_fields(ancestors.slice(0, 12)),
				});
			}
			const nodeId = await ctx.db.insert("files_nodes", {
				...owner,
				parentId,
				name: "deep.md",
				kind: "file",
				path: `${path}/deep.md`,
				treePath: `${path}/deep.md`,
				pathDepth: 111,
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				textKind: "rich_text",
				collaborationEnabled: false,
			});
			const committed = await db_insert_file_text_content(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				path: `${path}/deep.md`,
				rootKind: "rich_text",
				textContent: "zebraword here\n",
			});
			if (committed._nay) throw new Error(committed._nay.message);
		});

		// The owner reader resolves the file through all 110 folders above it, so one row must fit.
		// The first page reads the user's drafts, the next one the saved text.
		const paths: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 3; page++) {
			const result: { items: { path: string }[]; continueCursor: string; isDone: boolean; retrySmaller: boolean } =
				await t.query(internal.files_nodes.text_search_files, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					hasWorkspaceRead: true,
					query: "zebraword",
					numItems: 1,
					cursor,
				});
			expect(result.retrySmaller).toBe(false);
			paths.push(...result.items.map((item) => item.path));
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
		expect(paths).toEqual([`${Array.from({ length: 110 }, (_, index) => `/d${index + 1}`).join("")}/deep.md`]);
	});
});
