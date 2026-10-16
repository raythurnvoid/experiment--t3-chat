import { describe, expect, onTestFinished, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import type { files_PendingParent, files_PendingTarget } from "../shared/files.ts";
import { files_visible_resolve_db_create, type files_visible_resolve_Store } from "./files-visible-resolve.ts";
import {
	files_pending_overlay_db_flush,
	files_pending_overlay_db_resolve_facts,
	files_pending_overlay_db_wrap,
} from "./files-pending-overlay.ts";

function track_pages<T extends object>(query: T, pages: Id<"files_pending_updates">[][], indexed = false): T {
	return new Proxy(query, {
		get(target, key) {
			const method: unknown = Reflect.get(target, key);
			if (typeof method !== "function") return method;
			if (key === "withIndex")
				return (...args: unknown[]) =>
					track_pages(
						Reflect.apply(method, target, args),
						pages,
						args[0] === "by_org_ws_user_pendingMove_destParent_destName",
					);
			if (key === "paginate" && indexed)
				return async (...args: unknown[]) => {
					const result = (await Reflect.apply(method, target, args)) as {
						page: Array<{ _id: Id<"files_pending_updates"> }>;
					};
					pages.push(result.page.map((doc) => doc._id));
					return result;
				};
			return method.bind(target);
		},
	});
}

function saved_work() {
	const docs = new Map<string, string>();
	const store: files_visible_resolve_Store = {
		get: async (key) => docs.get(key) ?? null,
		set: async (key, value) => {
			docs.set(key, value);
		},
		delete: async (key) => {
			docs.delete(key);
		},
	};
	return { store, docs };
}

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

	return { t, db, asUser, create_saved, draft_move, resolve };
}

describe("files_visible_resolve_db_create", () => {
	test("reports real claim pages through the facade and owner wrapper", async () => {
		// Keep the closed proposals until their scheduled cleanup runs.
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const f = await fixture();
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const empty = await f.create_saved("empty");
		const targets: files_PendingTarget[] = [];
		const proposalIds = [];
		for (const name of ["one", "two"]) {
			targets.push(await f.create_saved(name));
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: `/draft-${name}`,
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			const target = created._yay.target;
			const pendingUpdateId = created._yay.pendingUpdateId;
			if (target.kind !== "private" || !pendingUpdateId) throw new Error("Expected the private folder proposal");
			const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target,
				destParent: { kind: "root" },
				destName: name,
				replace: true,
			});
			if (moved._nay) throw new Error(moved._nay.message);
			const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
			if (!proposal) throw new Error("Expected the private replacement proposal");
			expect(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				}),
			).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({
				state: "discarded",
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toMatchObject({
				pendingMove: { destParent: { kind: "root" }, destName: name },
			});
			proposalIds.push(pendingUpdateId);
		}

		const pages: Id<"files_pending_updates">[][] = [];
		const observe = <T extends Parameters<typeof files_visible_resolve_db_create>[0]>(db: T): T =>
			new Proxy(db, {
				get(target, key) {
					const method: unknown = Reflect.get(target, key);
					if (typeof method !== "function") return method;
					if (key === "query")
						return (...args: unknown[]) => track_pages(Reflect.apply(method, target, args), pages);
					return method.bind(target);
				},
			});
		const { store } = saved_work();
		const operation = { kind: "move", parent: { kind: "root" }, name: "one", cursor: null } as const;
		await f.t.run(async (ctx) => {
			const reader = files_visible_resolve_db_create(observe(ctx.db), {
				...scope,
				resume: { store, fence: "same-view" },
			});
			expect(await reader.resume(operation, { stepLimit: 256, allowPagination: false })).toEqual({
				status: "unfinished",
				paginated: false,
			});
			expect(pages).toEqual([]);
			expect(await reader.resume(operation, { stepLimit: 256 }), "The facade reports its actual native page").toEqual({
				status: "hidden",
				value: null,
				paginated: true,
			});
			expect(await reader.resume(operation, { stepLimit: 256 })).toEqual({
				status: "hidden",
				value: null,
				paginated: false,
			});
		});
		expect(pages).toEqual([[proposalIds[0]]]);
		pages.length = 0;

		await f.t.run(async (ctx) => {
			const observed = { ...ctx, db: observe(ctx.db) };
			const wrapped = { ...observed, ...files_pending_overlay_db_wrap(observed) };
			const args = { ...scope, allowPagination: true };
			const noPage = await files_pending_overlay_db_resolve_facts(wrapped, { ...args, target: empty });
			expect(noPage.facts?.own?.entry.path).toBe("/empty");
			expect(noPage.parentPage, "Allowing a page does not consume the owner's page slot").toBe(false);
			const first = await files_pending_overlay_db_resolve_facts(wrapped, { ...args, target: targets[0]! });
			expect(first.parentPage, "The owner wrapper reports its actual native page").toBe(true);
			expect(first.facts?.own?.entry.path).toBe("/one");
			const second = await files_pending_overlay_db_resolve_facts(wrapped, { ...args, target: targets[1]! });
			expect(second, "The next owner waits before a second parent page").toEqual({ facts: null, parentPage: false });
			await files_pending_overlay_db_flush(wrapped);
		});
		expect(pages, "Only the first owner's real page ran in this parent").toEqual([[proposalIds[0]]]);
		pages.length = 0;
		let finished = false;
		for (let step = 0; step < 10; step++) {
			const result = await f.t.run(async (ctx) => {
				const observed = { ...ctx, db: observe(ctx.db) };
				const wrapped = { ...observed, ...files_pending_overlay_db_wrap(observed) };
				const result = await files_pending_overlay_db_resolve_facts(wrapped, {
					...scope,
					target: targets[1]!,
					allowPagination: true,
				});
				await files_pending_overlay_db_flush(wrapped);
				return result;
			});
			if (step === 0) expect(result.parentPage, "The next parent reads the waiting owner's native page").toBe(true);
			if (result.facts) {
				expect(result.facts.own?.entry.path).toBe("/two");
				finished = true;
				break;
			}
		}
		expect(finished).toBe(true);
		expect(pages, "The waiting owner's source page is read once").toEqual([[proposalIds[1]]]);
	});

	test("resumes a path deeper than 256 targets without returning a budget miss", async () => {
		const f = await fixture();
		const depth = 270;
		const leaf = await f.t.run(async (ctx) => {
			let parentId: Id<"files_nodes"> | "root" = "root";
			for (let index = 0; index < depth; index++)
				parentId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId,
					name: "a",
					sortName: "a",
					kind: "folder",
				});
			return parentId as Id<"files_nodes">;
		});
		const { store, docs } = saved_work();
		let slices = 0;
		while (true) {
			const result = await f.t.run(async (ctx) => {
				const reader = files_visible_resolve_db_create(ctx.db, {
					...f.db,
					readLimit: 4,
					resume: { store, fence: "same-view" },
				});
				return await reader.resume({ kind: "target", target: { kind: "saved", id: leaf } }, { stepLimit: 32 });
			});
			slices++;
			if (result.status === "unfinished") {
				expect(slices).toBeLessThan(3000);
				continue;
			}
			expect(result.status).toBe("resolved");
			if (result.status === "resolved") expect(result.value?.entry.path).toBe("/a".repeat(depth));
			break;
		}
		expect(slices).toBeGreaterThan(1);
		expect(docs.has("record:resolved:saved:" + leaf)).toBe(true);
	});

	test("rejects saved resolver work after its fence changes", async () => {
		const f = await fixture();
		const target = await f.create_saved("a");
		const { store } = saved_work();
		const first = await f.t.run(async (ctx) =>
			files_visible_resolve_db_create(ctx.db, {
				...f.db,
				resume: { store, fence: "before" },
			}).resume({ kind: "target", target }, { stepLimit: 1 }),
		);
		expect(first.status).toBe("unfinished");
		const next = await f.t.run(async (ctx) =>
			files_visible_resolve_db_create(ctx.db, {
				...f.db,
				resume: { store, fence: "after" },
			}).resume({ kind: "target", target }),
		);
		expect(next).toEqual({ status: "invalidated" });
	});

	test("saved-only path resolution ignores private moves and claims", async () => {
		const f = await fixture();
		const folder = await f.create_saved("a");
		await f.draft_move(folder, { kind: "root" }, "b");
		const { store } = saved_work();
		for (const [path, expected] of [["/a", "resolved"], ["/b", "hidden"]] as const) {
			let slices = 0;
			while (true) {
				const result = await f.t.run(async (ctx) => files_visible_resolve_db_create(ctx.db, {
					...f.db, pending: false, resume: { store, fence: "saved-only" },
				}).resume({ kind: "path", path }, { stepLimit: 8 }));
				if (result.status === "unfinished") {
					expect(++slices).toBeLessThan(100);
					continue;
				}
				expect(result.status).toBe(expected);
				if (result.status === "resolved") expect(result.value?.entry.pendingUpdate).toBeNull();
				break;
			}
		}
	});

	test("resumes exact paths and reports the nearest applied move", async () => {
		const f = await fixture();
		const folder = await f.create_saved("a");
		await f.create_saved("a/child");
		await f.draft_move(folder, { kind: "root" }, "b");
		const { store } = saved_work();
		let slices = 0;
		while (true) {
			const result = await f.t.run(async (ctx) =>
				files_visible_resolve_db_create(ctx.db, {
					...f.db,
					resume: { store, fence: "same-view" },
				}).resume({ kind: "path", path: "/b/child" }, { stepLimit: 8 }),
			);
			if (result.status === "unfinished") {
				expect(++slices).toBeLessThan(100);
				continue;
			}
			expect(result.status).toBe("resolved");
			if (result.status === "resolved") {
				expect(result.value?.entry.path).toBe("/b/child");
				expect(result.value?.moveApplied).toBe(false);
				expect(result.value?.appliedMoveTarget).toEqual(folder);
			}
			break;
		}
	});

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
