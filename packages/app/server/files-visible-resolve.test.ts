import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import type { files_PendingParent, files_PendingTarget } from "../shared/files.ts";
import { files_visible_resolve_db_create } from "./files-visible-resolve.ts";

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

	const create_saved = async (path: string) => {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return { kind: "saved" as const, id: created._yay.nodeId };
	};

	const draft_move = async (target: files_PendingTarget, destParent: files_PendingParent, destName: string) => {
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target,
			destParent,
			destName,
		});
		if (moved._nay) throw new Error(moved._nay.message);
	};

	/**
	 * Resolve each target with one fresh core, in order, and return what the core gave.
	 */
	const resolve = (targets: files_PendingTarget[], options: { includeHidden?: boolean; readLimit?: number } = {}) =>
		t.run(async (ctx) => {
			const core = files_visible_resolve_db_create(ctx.db, { ...db, ...options });
			const results = [];
			for (const target of targets) {
				const result = await core.resolve(target);
				results.push(result && { path: result.entry.path, hidden: result.hidden });
			}
			return results;
		});

	return { t, db, create_saved, draft_move, resolve };
}

describe("files_visible_resolve_db_create", () => {
	test("includeHidden returns hidden targets with their path, and no path stays null", async () => {
		const f = await fixture();

		const deleted = await f.create_saved("deleted");
		const deletedChild = await f.create_saved("deleted/child");
		const archivedResult = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: deleted,
		});
		if (archivedResult._nay) throw new Error(archivedResult._nay.message);

		// A draft move of `/claimer` takes the name of `/taken`, which another write saves later.
		const claimer = await f.create_saved("claimer");
		await f.draft_move(claimer, { kind: "root" }, "taken");
		const taken = await f.create_saved("other-name");
		await f.t.run((ctx) => ctx.db.patch("files_nodes", taken.id, { name: "taken", path: "/taken" }));

		// The destination of this move is archived later, so the row falls back to its saved place.
		const archived = await f.create_saved("archived");
		const moved = await f.create_saved("moved");
		await f.draft_move(moved, archived, "moved-there");
		await f.t.run((ctx) => ctx.db.patch("files_nodes", archived.id, { archiveOperationId: "archive-1" }));

		const lost = await f.create_saved("lost");
		const lostChild = await f.create_saved("lost/child");
		await f.t.run((ctx) => ctx.db.delete("files_nodes", lost.id));

		const targets = [deleted, deletedChild, taken, archived, moved, lostChild];
		expect(await f.resolve(targets)).toEqual([null, null, null, null, { path: "/moved", hidden: false }, null]);
		expect(await f.resolve(targets, { includeHidden: true })).toEqual([
			{ path: "/deleted", hidden: true },
			{ path: "/deleted/child", hidden: true },
			{ path: "/taken", hidden: true },
			{ path: "/archived", hidden: true },
			{ path: "/moved", hidden: false },
			null,
		]);
	});

	test("gives the same answer in a move cycle whatever target it reads first", async () => {
		const f = await fixture();
		const a = await f.create_saved("a");
		const b = await f.create_saved("b");

		// The owner drafts `mv /a /b/`, then another user saves `mv /b /a/`.
		await f.draft_move(a, b, "a");
		await f.t.run((ctx) => ctx.db.patch("files_nodes", b.id, { parentId: a.id, path: "/a/b" }));

		// The move of `/a` cannot resolve, so `/a` stays at its saved place and `/b` is under it.
		const expected = [
			{ path: "/a", hidden: false },
			{ path: "/a/b", hidden: false },
		];
		expect(await f.resolve([a, b])).toEqual(expected);
		expect((await f.resolve([b, a])).reverse()).toEqual(expected);
	});

	test("puts every member of a 3-node move cycle at its saved place, in every read order", async () => {
		const f = await fixture();
		const a = await f.create_saved("a");
		const b = await f.create_saved("b");
		const x = await f.create_saved("x");

		// The owner drafts `mv /b /x/` and `mv /a /b/`, then another user saves `mv /x /a/`.
		await f.draft_move(b, x, "b");
		await f.draft_move(a, b, "a");
		await f.t.run((ctx) => ctx.db.patch("files_nodes", x.id, { parentId: a.id, path: "/a/x" }));

		const paths = { [a.id]: "/a", [b.id]: "/b", [x.id]: "/a/x" };
		const orders = [
			[a, b, x],
			[a, x, b],
			[b, a, x],
			[b, x, a],
			[x, a, b],
			[x, b, a],
		];
		for (const order of orders) {
			expect(await f.resolve(order)).toEqual(order.map((target) => ({ path: paths[target.id], hidden: false })));
		}
	});

	test("resolves 200 files under a 20-folder chain below a move cycle within 2,048 reads", async () => {
		const f = await fixture();
		const a = await f.create_saved("a");
		const b = await f.create_saved("b");

		// The owner drafts `mv /a /b/`, then another user saves `mv /b /a/`.
		await f.draft_move(a, b, "a");
		const files = await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", b.id, { parentId: a.id, path: "/a/b" });
			const insert = async (parentId: Id<"files_nodes">, name: string, kind: "file" | "folder") =>
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId,
					name,
					sortName: files_sort_text_key(name),
					kind,
				});
			let parentId = b.id;
			for (let index = 0; index < 20; index++) parentId = await insert(parentId, `d${index}`, "folder");
			return await Promise.all(
				Array.from({ length: 200 }, async (_, index) => ({
					kind: "saved" as const,
					id: await insert(parentId, `f${index}.md`, "file"),
				})),
			);
		});

		const results = await f.resolve(files, { readLimit: 2048 });
		const chain = Array.from({ length: 20 }, (_, index) => `/d${index}`).join("");
		expect(results).toEqual(files.map((_, index) => ({ path: `/a/b${chain}/f${index}.md`, hidden: false })));
	});
});
