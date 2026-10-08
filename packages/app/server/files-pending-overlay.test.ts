import { compareValues, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import {
	files_pending_overlay_list,
	files_pending_overlay_search_name,
	files_pending_overlay_window_ranges,
} from "./files-pending-overlay.ts";

type Row = Record<string, Value>;
type Range = ReturnType<typeof files_pending_overlay_window_ranges>[number];

function in_range(row: Row, range: Range) {
	for (const [field, value] of range.eq) if (compareValues(row[field]!, value) !== 0) return false;
	if (range.lower) {
		const compared = compareValues(row[range.lower.field]!, range.lower.value);
		if (compared < 0 || (compared === 0 && !range.lower.inclusive)) return false;
	}
	if (range.upper) {
		const compared = compareValues(row[range.upper.field]!, range.upper.value);
		if (compared > 0 || (compared === 0 && !range.upper.inclusive)) return false;
	}
	return true;
}

/**
 * Check every window of `rows` (each pair of first and last rows, in both orders) against the rows
 * whose key is between them. Each row must be in exactly one range.
 */
function expect_exact_windows(fields: string[], rows: Row[]) {
	const key = (row: Row) => fields.map((field) => row[field]!);
	const sorted = [...rows].sort((a, b) => compareValues(key(a), key(b)));
	for (let first = 0; first < sorted.length; first++)
		for (let last = first; last < sorted.length; last++) {
			const low = key(sorted[first]!);
			const high = key(sorted[last]!);
			const expected = sorted.filter((row) => compareValues(key(row), low) >= 0 && compareValues(key(row), high) <= 0);
			for (const order of ["asc", "desc"] as const) {
				const ranges = files_pending_overlay_window_ranges({
					fields,
					first: order === "asc" ? low : high,
					last: order === "asc" ? high : low,
					order,
				});
				expect(ranges.length).toBeLessThanOrEqual(2 * fields.length - 1);
				const matched = sorted.filter((row) => ranges.some((range) => in_range(row, range)));
				expect(matched).toEqual(expected);
				for (const row of matched) expect(ranges.filter((range) => in_range(row, range))).toHaveLength(1);
			}
		}
}

describe("files_pending_overlay_window_ranges", () => {
	// The key fields after the owner and parent prefix of each agent hide index.
	test("by_org_ws_user_parent_name: one name field", () => {
		expect_exact_windows(
			["name"],
			["a.md", "b.md", "b.md", "c", "z"].map((name) => ({ name })),
		);
	});

	test("by_org_ws_user_parent_updatedAt: many rows with the same updatedAt, as in `ls -t`", () => {
		const rows = [];
		for (const updatedAt of [100, 200, 200, 200, 300])
			for (const nodeCreationTime of [1, 2, 3]) rows.push({ updatedAt, nodeCreationTime });
		expect_exact_windows(["updatedAt", "nodeCreationTime"], rows);
	});

	test("by_org_ws_user_treePath, by_org_ws_user_kind_treePath: tree paths", () => {
		const treePaths = ["/a/", "/a/b.md", "/a/c/", "/a/c/d.md", "/b.md"];
		expect_exact_windows(
			["treePath"],
			treePaths.map((treePath) => ({ treePath })),
		);
		expect_exact_windows(
			["kind", "treePath"],
			treePaths.map((treePath) => ({ kind: treePath.endsWith("/") ? "folder" : "file", treePath })),
		);
	});

	test("by_org_ws_user_kind_ext_treePath: many `.md` files, as in `find --extension md`", () => {
		const rows = [];
		for (const lowercaseExtension of [null, "md", "md", "txt"])
			for (const treePath of ["/a", "/b", "/c"]) rows.push({ kind: "file", lowercaseExtension, treePath });
		expect_exact_windows(["kind", "lowercaseExtension", "treePath"], rows);
	});

	test("reads exactly the window on the real `ls -t` hide index", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const owner = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };

		const ids = await t.run(async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
			});
			const inserted = [];
			for (const updatedAt of [100, 200, 200, 200, 300])
				for (const nodeCreationTime of [1, 2])
					inserted.push(
						await ctx.db.insert("files_pending_hides", {
							...owner,
							savedNodeId: nodeId,
							parentId: "root",
							kind: "file",
							name: `n${updatedAt}-${nodeCreationTime}`,
							updatedAt,
							lowercaseExtension: null,
							nodeCreationTime,
							treePath: `/n${updatedAt}-${nodeCreationTime}`,
						}),
					);
			return inserted;
		});

		// A `desc` page from (300, 1) down to (200, 2), like `ls -t`.
		const ranges = files_pending_overlay_window_ranges({
			fields: ["updatedAt", "nodeCreationTime"],
			first: [300, 1],
			last: [200, 2],
			order: "desc",
		});
		const read = await t.run(async (ctx) => {
			const found = [];
			for (const range of ranges)
				found.push(
					...(await ctx.db
						.query("files_pending_hides")
						.withIndex("by_org_ws_user_parent_updatedAt", (q) => {
							let indexRange: any = q
								.eq("organizationId", owner.organizationId)
								.eq("workspaceId", owner.workspaceId)
								.eq("userId", owner.userId)
								.eq("parentId", "root");
							for (const [field, value] of range.eq) indexRange = indexRange.eq(field, value);
							if (range.lower)
								indexRange = range.lower.inclusive
									? indexRange.gte(range.lower.field, range.lower.value)
									: indexRange.gt(range.lower.field, range.lower.value);
							if (range.upper)
								indexRange = range.upper.inclusive
									? indexRange.lte(range.upper.field, range.upper.value)
									: indexRange.lt(range.upper.field, range.upper.value);
							return indexRange;
						})
						.collect()),
				);
			return found.map((hide) => [hide.updatedAt, hide.nodeCreationTime]).sort((a, b) => compareValues(a, b));
		});
		expect(ids).toHaveLength(10);
		expect(read).toEqual([
			[200, 2],
			[200, 2],
			[200, 2],
			[300, 1],
		]);
	});
});

describe("files_pending_overlay_list", () => {
	async function fixture() {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		// The helper runs in actions; here each stream query runs on its own, like `ctx.runQuery`.
		const ctx = { runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">;
		const saved = async (path: string) => {
			const created = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: "root",
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const move = async (args: {
			userId: Id<"users">;
			nodeId: Id<"files_nodes">;
			destId: Id<"files_nodes">;
			destName: string;
		}) => {
			const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: args.userId,
				target: { kind: "saved", id: args.nodeId },
				destParent: { kind: "saved", id: args.destId },
				destName: args.destName,
			});
			if (moved._nay) throw new Error(moved._nay.message);
		};
		const draft = async (path: string, kind: "file" | "folder") => {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path,
				kind,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay;
		};
		const list = (args: {
			userId?: Id<"users">;
			folderPath: string;
			mode: "children" | "subtree";
			kind?: "file" | "folder";
			numItems: number;
			cursor: string | null;
			requireComplete?: boolean;
		}) => {
			const { userId = db.userId, ...rest } = args;
			return files_pending_overlay_list(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				visibilityUserId: userId,
				overlayUserId: userId,
				order: "asc",
				...rest,
			});
		};
		/**
		 * Every page of a listing, with the cursor of the first page.
		 */
		const list_all = async (args: Omit<Parameters<typeof list>[0], "cursor">) => {
			const paths: string[] = [];
			let cursor: string | null = null;
			let firstCursor: string | null = null;
			for (let page = 0; page < 50; page++) {
				const result: Awaited<ReturnType<typeof list>> = await list({ ...args, cursor });
				if (result._nay) throw new Error(result._nay.message);
				paths.push(...result._yay.items.map((item) => item.path));
				firstCursor ??= result._yay.continueCursor;
				if (result._yay.isDone) break;
				cursor = result._yay.continueCursor;
			}
			return { paths, firstCursor };
		};
		return { t, db, asUser, saved, move, draft, list, list_all };
	}

	test("pages saved rows, drafts and moved-in folders one row at a time, and refuses another listing's cursor", async () => {
		const f = await fixture();
		const src = await f.saved("src");
		await f.saved("src/a");
		await f.saved("src/c");
		await f.saved("other");
		const outside = await f.saved("outside");
		await f.saved("outside/x");
		await f.draft("/src/b", "folder");
		await f.move({ userId: f.db.userId, nodeId: outside, destId: src, destName: "d" });

		const children = await f.list_all({ folderPath: "/src", mode: "children", numItems: 1 });
		expect(children.paths).toEqual(["/src/a", "/src/b", "/src/c", "/src/d"]);
		// The moved-in folder brings its saved child in through its own stream.
		const subtree = await f.list_all({ folderPath: "/src", mode: "subtree", numItems: 1 });
		expect(subtree.paths).toEqual(["/src/a", "/src/b", "/src/c", "/src/d", "/src/d/x"]);

		// A cursor works only for the listing that made it. The same folder in another mode has the same
		// root, so only the scope check refuses it.
		expect(await f.list({ folderPath: "/src", mode: "subtree", numItems: 1, cursor: children.firstCursor })).toEqual({
			_nay: { message: "Listing changed. Start again." },
		});
		expect(await f.list({ folderPath: "/other", mode: "children", numItems: 1, cursor: children.firstCursor })).toEqual(
			{ _nay: { message: "Listing changed. Start again." } },
		);
		expect(await f.list({ folderPath: "/src", mode: "children", numItems: 1, cursor: "not json" })).toEqual({
			_nay: { message: "Invalid listing cursor" },
		});
	});

	test("lists children in raw name order across pages, with drafts and moves", async () => {
		const f = await fixture();
		const box = await f.saved("box");
		for (const name of ["Zeta", "b", "n"]) await f.saved(`box/${name}`);
		const elsewhere = await f.saved("elsewhere");

		// Insert saved files directly. The listing reads only the node fields.
		const insert_file = (parentId: Id<"files_nodes"> | "root", path: string) =>
			f.t.run(async (ctx) => {
				const name = path.slice(path.lastIndexOf("/") + 1);
				return await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId,
					name,
					kind: "file",
					path,
					treePath: path,
					pathDepth: path.split("/").length - 1,
					lowercaseExtension: "txt",
					contentType: "text/plain",
				});
			});
		for (const name of ["a.txt", "file-10.txt", "file-9.txt", "z.txt"]) await insert_file(box, `/box/${name}`);
		const renamed = await insert_file(box, "/box/q.txt");
		const outside = await insert_file("root", "/outside.txt");

		for (const [path, kind] of [
			["/box/c-draft", "folder"],
			["/box/b-draft.txt", "file"],
		] as const) {
			await f.draft(path, kind);
		}
		for (const [nodeId, destName] of [
			[renamed, "m.txt"],
			[outside, "0-moved.txt"],
			[elsewhere, "x-moved"],
		] as const) {
			await f.move({ userId: f.db.userId, nodeId, destId: box, destName });
		}

		// Raw order puts digits and capitals before lowercase, and "file-10" before "file-9".
		const paths = [
			"0-moved.txt",
			"Zeta",
			"a.txt",
			"b",
			"b-draft.txt",
			"c-draft",
			"file-10.txt",
			"file-9.txt",
			"m.txt",
			"n",
			"x-moved",
			"z.txt",
		].map((name) => `/box/${name}`);
		// Each page size moves the page boundary, so a skipped or repeated entry changes the list.
		for (const numItems of [1, 2, 3, 50]) {
			expect((await f.list_all({ folderPath: "/box", mode: "children", numItems })).paths).toEqual(paths);
		}
	});

	test("walks a private folder and a saved folder moved into it once", async () => {
		const f = await fixture();
		const parent = await f.draft("/draft/nested", "folder");
		await f.draft("/draft/nested/preparing.txt", "file");
		const source = await f.saved("source");
		const child = await f.saved("source/child");
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: { kind: "saved", id: source },
			destParent: parent.target,
			destName: "moved",
		});
		if (moved._nay) throw new Error(moved._nay.message);

		const result = await f.list({ folderPath: "/draft", mode: "subtree", numItems: 20, cursor: null });
		if (result._nay) throw new Error(result._nay.message);
		expect(result._yay.isDone).toBe(true);
		expect(result._yay.items.map((item) => item.path)).toEqual([
			"/draft/nested",
			"/draft/nested/moved",
			"/draft/nested/moved/child",
			"/draft/nested/preparing.txt",
		]);
		expect(result._yay.items.find((item) => item.target.id === child)?.path).toBe("/draft/nested/moved/child");
		expect(result._yay.items.at(-1)).toMatchObject({ target: { kind: "private" }, preparing: true });
	});

	test("keeps private children listed after their parent is saved", async () => {
		const f = await fixture();
		const parent = await f.draft("/draft", "folder");
		const child = await f.draft("/draft/child", "folder");
		if (!parent.pendingUpdateId) throw new Error("Expected the parent proposal");
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.db.membershipId,
			target: parent.target,
			pendingUpdateId: parent.pendingUpdateId,
			reviewedRevision: 1,
		});
		if (saved._nay) throw new Error(saved._nay.message);

		const result = await f.list({ folderPath: "/draft", mode: "children", numItems: 20, cursor: null });
		if (result._nay) throw new Error(result._nay.message);
		expect(result._yay.items).toMatchObject([{ target: child.target, path: "/draft/child", preparing: false }]);
		expect(
			await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
				membershipId: f.db.membershipId,
				path: "/draft/child",
			}),
		).toEqual({ target: child.target, kind: "folder" });
	});

	test("does not show a row again when rows are added before the last shown row", async () => {
		const f = await fixture();
		await f.saved("d");
		for (const name of ["b1", "b2", "b3", "b4"]) await f.saved(`d/${name}`);
		// A draft first, so the page stops inside the saved stream's page.
		await f.draft("/d/a0", "folder");
		const first = await f.list({ folderPath: "/d", mode: "children", numItems: 3, cursor: null });
		if (first._nay) throw new Error(first._nay.message);
		expect(first._yay.items.map((item) => item.path)).toEqual(["/d/a0", "/d/b1", "/d/b2"]);

		// Two new rows before `/d/b2` make the saved stream's next read end before its last shown row.
		await f.saved("d/b1a");
		await f.saved("d/b1b");
		const second = await f.list({ folderPath: "/d", mode: "children", numItems: 3, cursor: first._yay.continueCursor });
		if (second._nay) throw new Error(second._nay.message);
		expect(second._yay.items.map((item) => item.path)).toEqual(["/d/b3", "/d/b4"]);
	});

	test("still shows rows when the transaction is over the read budget after the first stream call", async () => {
		const f = await fixture();
		await f.saved("d");
		for (const name of ["b1", "b2", "b3"]) await f.saved(`d/${name}`);
		const metric = (used: number) => ({ used, remaining: 0 });
		const over = {
			bytesRead: metric(0),
			documentsRead: metric(0),
			databaseQueries: metric(5_000),
			documentsWritten: metric(0),
			bytesWritten: metric(0),
			functionsScheduled: metric(0),
			scheduledFunctionArgsBytes: metric(0),
		};
		// Like a mutation that already used its read budget before the listing.
		const ctx = { runQuery: f.t.query, meta: { getTransactionMetrics: async () => over } } as unknown as Pick<
			ActionCtx,
			"runQuery"
		>;
		const paths: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const result: Awaited<ReturnType<typeof files_pending_overlay_list>> = await files_pending_overlay_list(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				overlayUserId: f.db.userId,
				order: "asc",
				folderPath: "/d",
				mode: "children",
				numItems: 3,
				cursor,
			});
			if (result._nay) throw new Error(result._nay.message);
			paths.push(...result._yay.items.map((item) => item.path));
			if (result._yay.isDone) break;
			cursor = result._yay.continueCursor;
		}
		expect(paths).toEqual(["/d/b1", "/d/b2", "/d/b3"]);
	});

	test("reads each row's hide on its own when a filter skips more hidden rows than the page holds", async () => {
		const f = await fixture();
		const d = await f.saved("d");
		await f.saved("d/a");
		const m = await f.saved("d/m");
		await f.saved("d/z");
		await f.t.run(async (ctx) => {
			const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
			const hide = { ...owner, parentId: d, updatedAt: 1, nodeCreationTime: 1 };
			await ctx.db.insert("files_pending_hides", {
				...hide,
				savedNodeId: m,
				kind: "folder",
				name: "m",
				lowercaseExtension: null,
				treePath: "/d/m/",
			});
			// Hidden files between `a` and `z`: the folder filter skips them, but the name window holds them.
			const fileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
			});
			for (const name of ["b1.md", "b2.md", "b3.md", "b4.md"])
				await ctx.db.insert("files_pending_hides", {
					...hide,
					savedNodeId: fileId,
					kind: "file",
					name,
					lowercaseExtension: "md",
					treePath: `/d/${name}`,
				});
		});
		const listed = await f.list_all({ folderPath: "/d", mode: "children", kind: "folder", numItems: 10 });
		expect(listed.paths).toEqual(["/d/a", "/d/z"]);
	});

	test("hides the rows under a folder the user hid, from the page's folders or the first row's ancestors", async () => {
		const f = await fixture();
		const s = await f.saved("s");
		const a = await f.saved("s/a");
		await f.saved("s/a/x");
		await f.saved("s/a/y");
		await f.saved("s/b");
		await f.t.run((ctx) =>
			ctx.db.insert("files_pending_hides", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				savedNodeId: a,
				parentId: s,
				kind: "folder",
				name: "a",
				updatedAt: 1,
				lowercaseExtension: null,
				nodeCreationTime: 1,
				treePath: "/s/a/",
			}),
		);
		// One page holds the hidden folder and its rows.
		expect((await f.list_all({ folderPath: "/s", mode: "subtree", numItems: 10 })).paths).toEqual(["/s/b"]);
		// Small pages: the second stream page starts inside the hidden folder, so the first row's
		// ancestors find it, and the stream restarts after it.
		expect((await f.list_all({ folderPath: "/s", mode: "subtree", numItems: 1 })).paths).toEqual(["/s/b"]);
	});

	test("decides rows only up to the last hidden folder it read when a page holds more than 1,000", async () => {
		const f = await fixture();
		const s = await f.saved("s");
		await f.t.run(async (ctx) => {
			const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
			for (let index = 0; index <= 1_000; index++) {
				const name = `h${String(index).padStart(4, "0")}`;
				const savedNodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					...owner,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: s,
					name,
					path: `/s/${name}`,
					treePath: `/s/${name}/`,
					pathDepth: 2,
				});
				await ctx.db.insert("files_pending_hides", {
					...owner,
					userId: f.db.userId,
					savedNodeId,
					parentId: s,
					kind: "folder",
					name,
					updatedAt: 1,
					lowercaseExtension: null,
					nodeCreationTime: 1,
					treePath: `/s/${name}/`,
				});
			}
		});
		// The 1,001st hidden folder holds a row. The first call reads 1,000 hidden folders, so it must
		// stop before that folder and let the next call read it.
		await f.saved("s/h1000/c");
		await f.saved("s/zz");
		expect((await f.list_all({ folderPath: "/s", mode: "subtree", numItems: 1_100 })).paths).toEqual(["/s/zz"]);
	});

	test("drops a moved-in place the user can no longer read, and refuses it in a complete listing", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: other.userId,
			}),
		).toEqual({ _yay: null });
		const dest = await f.saved("dest");
		const secret = await f.saved("src/secret");
		await f.move({ userId: other.userId, nodeId: secret, destId: dest, destName: "secret" });
		const args = { userId: other.userId, folderPath: "/dest", mode: "children" as const, numItems: 10 };
		expect((await f.list_all(args)).paths).toEqual(["/dest/secret"]);

		// The place row checks access on its node, so a restrict hides the draft move too.
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: secret }),
		).toEqual({ _yay: null });
		expect((await f.list_all(args)).paths).toEqual([]);
		expect(await f.list({ ...args, cursor: null, requireComplete: true })).toEqual({
			_nay: { message: "Permission denied" },
		});
	});

	test("keeps the cursor small with ten open streams", async () => {
		const f = await fixture();
		const dest = await f.saved("dest");
		// m1 to m10 each hold a saved folder `z`, which sorts after the next moved-in folder, so every
		// nested stream stays open until the listing comes back up the chain.
		const ids: Id<"files_nodes">[] = [];
		for (let index = 1; index <= 10; index++) {
			ids.push(await f.saved(`m${index}`));
			await f.saved(`m${index}/z`);
		}
		for (const [index, nodeId] of ids.entries())
			await f.move({
				userId: f.db.userId,
				nodeId,
				destId: index === 0 ? dest : ids[index - 1]!,
				destName: `m${index + 1}`,
			});

		const chain = Array.from({ length: 10 }, (_, index) =>
			Array.from({ length: index + 1 }, (_, level) => `/m${level + 1}`).join(""),
		);
		// Each moved-in folder opens a stream that must be read before the next row, so the first call
		// stops after its 8 read rounds with a short page and a cursor.
		const first = await f.list({ folderPath: "/dest", mode: "subtree", numItems: 10, cursor: null });
		if (first._nay) throw new Error(first._nay.message);
		expect(first._yay.items.map((item) => item.path)).toEqual(chain.slice(0, 8).map((path) => `/dest${path}`));
		const second = await f.list({
			folderPath: "/dest",
			mode: "subtree",
			numItems: 2,
			cursor: first._yay.continueCursor,
		});
		if (second._nay) throw new Error(second._nay.message);
		expect(second._yay.items.map((item) => item.path)).toEqual(chain.slice(8).map((path) => `/dest${path}`));
		// Measured: 10 open streams make a 2,238 byte cursor. Transfer discovery stores 2 at most.
		const cursor = second._yay.continueCursor!;
		expect(JSON.parse(cursor).streams.length).toBeGreaterThanOrEqual(10);
		expect(cursor.length).toBeLessThan(8_192);

		const rest = await f.list({ folderPath: "/dest", mode: "subtree", numItems: 50, cursor });
		if (rest._nay) throw new Error(rest._nay.message);
		expect(rest._yay.items.map((item) => item.path)).toEqual(chain.toReversed().map((path) => `/dest${path}/z`));
		expect(rest._yay.isDone).toBe(true);
	});
});

describe("files_pending_overlay_search_name", () => {
	async function fixture() {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const saved = async (path: string) => {
			const created = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: "root",
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		return { t, db, asUser, saved };
	}

	test("name search drops a member's draft in a folder they can no longer read", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: other.userId,
			}),
		).toEqual({ _yay: null });
		const secret = await f.saved("secret");
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: other.userId,
			path: "/secret/draftnote",
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		const search_paths = async () => {
			const result = await files_pending_overlay_search_name(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					visibilityUserId: other.userId,
					overlayUserId: other.userId,
					folderPath: "/",
					query: "draftnote",
					numItems: 10,
					cursor: null,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path);
		};
		expect(await search_paths()).toEqual(["/secret/draftnote"]);

		// The draft's place checks access on its folder per row.
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: secret }),
		).toEqual({ _yay: null });
		expect(await search_paths()).toEqual([]);
	});

	test("shows a row once when a folder inside a moved-in folder is moved away and back", async () => {
		const f = await fixture();
		const dest = await f.saved("dest");
		await f.saved("outside");
		const g = await f.saved("outside/g");
		const k = await f.saved("outside/g/k");
		await f.saved("outside/g/k/target");
		const move = async (nodeId: Id<"files_nodes">, destId: Id<"files_nodes">, destName: string) => {
			const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target: { kind: "saved", id: nodeId },
				destParent: { kind: "saved", id: destId },
				destName,
			});
			if (moved._nay) throw new Error(moved._nay.message);
			return moved._yay;
		};
		await move(g, dest, "g");
		await move(k, g, "k2");
		// Back to its saved parent and name: the move is cancelled, though `/dest/g/k` is not its saved path.
		expect((await move(k, g, "k")).cancelledExistingMove).toBe(true);

		const paths: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const result: Awaited<ReturnType<typeof files_pending_overlay_search_name>> = await files_pending_overlay_search_name(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					visibilityUserId: f.db.userId,
					overlayUserId: f.db.userId,
					folderPath: "/dest",
					query: "target",
					numItems: 1,
					cursor,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			paths.push(...result._yay.items.map((item) => item.path));
			if (result._yay.isDone) break;
			cursor = result._yay.continueCursor;
		}
		expect(paths).toEqual(["/dest/g/k/target"]);
	});
});
