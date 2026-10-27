import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel.js";
import { list_tree_children, list_tree_children_shared, list_tree_children_sorted } from "../convex/files_tree.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "../convex/setup.test.ts";
import type { files_DirectoryView, files_IndexDirectoryView } from "../shared/files.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("saved-directory-test-work" as never);
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

function read_directory(
	f: Awaited<ReturnType<typeof fixture>>,
	door: "tree" | "sorted" | "shared",
	args: {
		parentId: Doc<"files_nodes">["parentId"];
		stream: "normal" | "cohort";
		pageView?: files_IndexDirectoryView;
		paginationOpts: { cursor: string | null; numItems: number; endCursor?: string };
	},
) {
	const common = { membershipId: f.db.membershipId, kind: "file" as const, ...args };
	if (door === "tree")
		return f.asUser.query(api.files_tree.list_tree_children, {
			...common, archived: false, restricted: false, pageView: common.pageView as files_DirectoryView | undefined,
		});
	const sorted = {
		...common,
		sort: [{ field: "name" as const, direction: "asc" as const }],
		filter: null,
		namePrefix: null,
		segment: "value" as const,
	};
	if (door === "shared")
		return f.asUser.query(api.files_tree.list_tree_children_shared, { ...sorted, principalIndex: 0 });
	return f.asUser.query(api.files_tree.list_tree_children_sorted, { ...sorted, restricted: false });
}

describe("saved directory streams", () => {
	test("tags an idle directory page", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
		const page = await asUser.query(api.files_tree.list_tree_children, {
			membershipId: scope.membershipId,
			stream: "normal",
			parentId: "root",
			kind: "file",
			archived: false,
			restricted: false,
			paginationOpts: { cursor: null, numItems: 1 },
		});
		expect(page, "an idle directory response carries its view tag").toHaveProperty("directoryView", null);
	});

	test("unrelated directories do not read the workspace Move slot", async () => {
		const f = await fixture();
		const created = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "/unrelated",
		});
		if (created._nay) throw new Error(created._nay.message);
		let slotReads = 0;
		for (const registered of [list_tree_children, list_tree_children_sorted, list_tree_children_shared])
			test_spy_handler(registered, async (handler, ctx, args) => {
				const db = new Proxy(ctx.db, {
					get(target, key) {
						const member: unknown = Reflect.get(target, key);
						if (typeof member !== "function") return member;
						if (key === "query")
							return (...queryArgs: unknown[]) => {
								if (queryArgs[0] === "files_move_workspace_slots") slotReads++;
								return Reflect.apply(member, target, queryArgs);
							};
						return member.bind(target);
					},
				});
				return await handler({ ...ctx, db }, args);
			});
		for (const door of ["tree", "sorted", "shared"] as const)
			for (const stream of ["normal", "cohort"] as const) {
				const page = await read_directory(f, door, {
					parentId: created._yay.nodeId,
					stream,
					paginationOpts: { cursor: null, numItems: 1 },
				});
				expect(page.directoryView).toBeNull();
				expect(page.page).toEqual([]);
			}
		expect(slotReads, "an unrelated directory never reads the workspace Move slot").toBe(0);
	});

	test.each(["tree", "sorted", "shared"] as const)("%s tags both parents and empty streams", async (door) => {
		const f = await fixture();
		for (const view of ["before", "after"] as const) {
			if (view === "after") await f.publish();
			for (const parentId of ["root", f.parentId] as const)
				for (const stream of ["normal", "cohort"] as const) {
					const page = await read_directory(f, door, {
						parentId,
						stream,
						paginationOpts: { cursor: null, numItems: 1 },
					});
					expect(page.directoryView, "every enabled stream carries the same directory view").toEqual({
						cohortId: f.cohortId,
						view,
					});
					const selected =
						stream === "cohort" &&
						door !== "shared" &&
						(view === "before" ? parentId === "root" : parentId === f.parentId);
					expect(page.page.map((node) => node._id)).toEqual(selected ? [f.nodeId] : []);
				}
		}
		await f.materializeNode(f.nodeId);
		for (const stream of ["normal", "cohort"] as const) {
			const page = await read_directory(f, door, {
				parentId: f.parentId,
				stream,
				paginationOpts: { cursor: null, numItems: 1 },
			});
			expect(page.directoryView, "the last restored node and deleted places leave an idle directory").toBeNull();
			expect(page.page.map((node) => node._id)).toEqual(stream === "normal" && door !== "shared" ? [f.nodeId] : []);
		}
	});

	test.each(["tree", "sorted"] as const)("%s pins continuations and split children", async (door) => {
		const f = await fixture({ normalPaths: ["/a.txt", "/b.txt", "/c.txt"] });
		const args = { parentId: "root" as const, stream: "normal" as const };
		const first = await read_directory(f, door, { ...args, paginationOpts: { cursor: null, numItems: 1 } });
		expect(first.isDone, "the check starts with a real continuation").toBe(false);
		const next = await read_directory(f, door, {
			...args,
			pageView: first.directoryView,
			paginationOpts: { cursor: first.continueCursor, numItems: 1 },
		});
		expect(next.page).toHaveLength(1);
		expect(next.page[0]!._id).not.toBe(first.page[0]!._id);
		await f.publish();
		for (const paginationOpts of [
			{ cursor: first.continueCursor, numItems: 1 },
			{ cursor: null, endCursor: first.continueCursor, numItems: 1 },
		])
			await expect(
				read_directory(f, door, { ...args, pageView: first.directoryView, paginationOpts }),
				"a continuation or split child cannot use an older directory view",
			).rejects.toMatchObject({ data: { reason: "saved_directory_view_changed", paginationError: "InvalidCursor" } });
		await expect(
			read_directory(f, door, { ...args, paginationOpts: { cursor: first.continueCursor, numItems: 1 } }),
			"a continuation must carry its directory view",
		).rejects.toMatchObject({ data: { reason: "saved_directory_view_changed", paginationError: "InvalidCursor" } });
		const fresh = await read_directory(f, door, {
			...args,
			pageView: first.directoryView,
			paginationOpts: { cursor: null, numItems: 1 },
		});
		expect(fresh.directoryView, "a fresh first page selects the current view without rejecting its old tag").toEqual({
			cohortId: f.cohortId,
			view: "after",
		});
	});

	test.each(["before", "after"] as const)(
		"Stop keeps the %s directory view until repair removes its places",
		async (view) => {
			const f = await fixture();
			if (view === "after") await f.publish();
			const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId));
			if (!item) throw new Error("Expected the fixture's public Move item");
			// The fixture owns its placement headers. Stop may queue repair but must not run it here.
			const overlay = await import("./files-pending-overlay.ts");
			const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
			try {
				expect(
					await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId: item.runId }),
				).toEqual({ _yay: null });
			} finally {
				join.mockRestore();
			}
			for (const door of ["tree", "sorted", "shared"] as const)
				for (const parentId of ["root", f.parentId] as const) {
					const page = await read_directory(f, door, {
						parentId,
						stream: "cohort",
						paginationOpts: { cursor: null, numItems: 1 },
					});
					expect(page.directoryView, "Stop preserves the selected directory view during repair").toEqual({
						cohortId: f.cohortId,
						view,
					});
					const selected = door !== "shared" && (view === "before" ? parentId === "root" : parentId === f.parentId);
					expect(page.page.map((node) => node._id)).toEqual(selected ? [f.nodeId] : []);
				}
			await f.materializeNode(f.nodeId);
			const parentId = view === "before" ? "root" : f.parentId;
			const page = await read_directory(f, "tree", {
				parentId,
				stream: "normal",
				paginationOpts: { cursor: null, numItems: 1 },
			});
			expect(page.directoryView).toBeNull();
			expect(
				page.page.map((node) => node._id),
				"repair restores the selected saved name to the normal stream",
			).toEqual([f.nodeId]);
		},
	);
});
