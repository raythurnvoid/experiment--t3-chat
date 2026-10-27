import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api } from "./_generated/api.js";
import { test_convex, test_run_with_flush } from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { files_table_Filter } from "../shared/files-table.ts";
import { insert_tree_node, seed_tree_access_fixture, seed_folder_table } from "./files_nodes.setup.test.ts";
import { expect_under_convex_limits, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockResolvedValue({
		key: "test-upload-key",
		url: "https://r2.test/upload",
	});
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

type Seeded = Awaited<ReturnType<typeof seed_folder_table>>;
type Member = Awaited<ReturnType<Seeded["add_member"]>>;
type TreePage = FunctionReturnType<typeof api.files_tree.list_tree_children>;

const BY_NAME = { field: "name", direction: "asc" } as const;
const BY_STATUS = { field: "metadata.status", direction: "asc" } as const;

/** One page of the Files tree list of `/table` (or `parentId`) for a member. */
function read_tree(
	seeded: Seeded,
	member: Member,
	args: {
		kind: "file" | "folder";
		restricted: boolean;
		numItems?: number;
		cursor?: string | null;
		parentId?: Id<"files_nodes">;
	},
) {
	return member.as.query(api.files_tree.list_tree_children, {
		stream: "normal" as const,
		pageView: null,
		membershipId: member.membershipId,
		parentId: args.parentId ?? seeded.parentId,
		kind: args.kind,
		archived: false,
		restricted: args.restricted,
		paginationOpts: { numItems: args.numItems ?? 50, cursor: args.cursor ?? null },
	});
}

/** Every page of one Files tree stream, in order. */
async function read_tree_pages(seeded: Seeded, member: Member, args: Parameters<typeof read_tree>[2]) {
	const pages: TreePage["page"][] = [];
	let cursor: string | null = null;
	for (let index = 0; index < 100; index++) {
		const result: TreePage = await read_tree(seeded, member, { ...args, cursor });
		pages.push(result.page);
		if (result.isDone) return pages;
		cursor = result.continueCursor;
	}
	throw new Error("Expected the stream to end");
}

/** The fields a locked row shows, read from the node. */
async function locked_row_of(seeded: Seeded, nodeId: Id<"files_nodes">) {
	const node = (await seeded.t.run((ctx) => ctx.db.get("files_nodes", nodeId))) as Doc<"files_nodes">;
	return {
		_id: node._id,
		_creationTime: node._creationTime,
		parentId: node.parentId,
		name: node.name,
		path: node.path,
		kind: node.kind,
		contentType: node.contentType,
		lowercaseExtension: node.lowercaseExtension,
		contentByteSize: node.contentByteSize,
		updatedAt: node.updatedAt,
		archiveOperationId: node.archiveOperationId,
		locked: true,
	};
}

/**
 * `/table` is restricted to the owner. The member was added on `/table/d`, and 500 folders nested
 * under it each have added people who are not the member, so a check walks the whole chain. `parent`
 * is the deepest folder; `template` holds the node fields to copy for its children.
 */
async function seed_deep_chain(seeded: Seeded, member: Member) {
	const grant = (
		ctx: MutationCtx,
		nodeId: Id<"files_nodes">,
		principal: object,
		permission: "content.read" | "content.write",
	) =>
		ctx.db.insert("access_control_permission_grants", {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			resourceKind: "file",
			resourceId: String(nodeId),
			...(principal as { principalKind: "user"; userId: Id<"users"> }),
			permission,
			createdAt: 1,
			updatedAt: 1,
		});
	const seed = await seeded.t.run(async (ctx) => {
		const tableId = seeded.parentId;
		await ctx.db.patch("files_nodes", tableId, {
			restrictedScopeNodeId: tableId,
			isRestrictedScopeRoot: true,
			parentScopeNodeId: null,
		});
		const { _id, _creationTime, ...template } = (await ctx.db.get("files_nodes", tableId))!;
		const strangerId = await ctx.db.insert("users", { clerkUserId: null });
		let parent = { _id: tableId, path: template.path, parentExtendedScopeNodeId: null as Id<"files_nodes"> | null };
		for (let depth = 0; depth <= 500; depth++) {
			const name = depth === 0 ? "d" : "a";
			const path = `${parent.path}/${name}`;
			const parentExtendedScopeNodeId = depth === 0 ? null : parent._id;
			const nodeId = await ctx.db.insert("files_nodes", {
				...template,
				parentId: parent._id,
				name,
				sortName: name,
				path,
				treePath: `${path}/`,
				pathDepth: depth + 2,
				isRestrictedScopeRoot: false,
				parentScopeNodeId: undefined,
				parentExtendedScopeNodeId,
			});
			await ctx.db.patch("files_nodes", nodeId, { extendedScopeNodeId: nodeId });
			if (depth === 0) {
				await grant(ctx, nodeId, { principalKind: "user", userId: member.userId }, "content.read");
			} else {
				await grant(ctx, nodeId, { principalKind: "user", userId: strangerId }, "content.read");
				await grant(ctx, nodeId, { principalKind: "role", role: "admin" }, "content.read");
				await grant(ctx, nodeId, { principalKind: "role", role: "admin" }, "content.write");
			}
			parent = { _id: nodeId, path, parentExtendedScopeNodeId };
		}
		return { tableId, template, parent };
	});
	return { ...seed, grant };
}

describe("locked rows in folder lists", () => {
	test("a member sees a restricted child as a locked row with only name, type, size and dates", async () => {
		const seeded = await seed_folder_table();
		const [, secretId, sharedId] = await seeded.insert_children([
			{ name: "notes.md", kind: "file", updatedAt: 1, lowercaseExtension: "md", contentByteSize: 2 },
			{ name: "secret.md", kind: "file", updatedAt: 2, lowercaseExtension: "md", contentByteSize: 8, restricted: true },
			{ name: "shared.md", kind: "file", updatedAt: 3, lowercaseExtension: "md", restricted: true },
		]);
		const member = await seeded.add_member("clerk_locked_member", "member");
		await seeded.grant_read({ userId: member.userId }, [sharedId!]);

		const open = await read_tree(seeded, member, { kind: "file", restricted: false });
		expect(open.page.map((row) => [row.name, row.locked])).toEqual([["notes.md", false]]);
		const rows = (await read_tree(seeded, member, { kind: "file", restricted: true })).page;
		expect(rows.map((row) => row.name)).toContain("secret.md");
		expect(rows.map((row) => [row.name, row.locked])).toEqual([
			["secret.md", true],
			["shared.md", false],
		]);
		expect(rows[0]).toEqual(await locked_row_of(seeded, secretId!));
		// The folder table shows the same rows.
		expect(await seeded.read_table(BY_NAME, { member })).toEqual(["notes.md", "secret.md", "shared.md"]);
	});

	test("a locked row has no metadata, updatedBy or members", async () => {
		const seeded = await seed_folder_table();
		const [secretId] = await seeded.insert_children([
			{ name: "secret.md", kind: "file", updatedAt: 2, lowercaseExtension: "md", restricted: true },
		]);
		await seeded.set_metadata([[secretId!, [{ key: "status", value: "Done" }]]]);
		const member = await seeded.add_member("clerk_locked_fields", "member");

		const [row] = (await read_tree(seeded, member, { kind: "file", restricted: true })).page;
		expect(Object.keys(row!).sort()).toEqual(Object.keys(await locked_row_of(seeded, secretId!)).sort());
		expect(row).not.toHaveProperty("updatedBy");
		expect(row).not.toHaveProperty("createdBy");
		expect(row).not.toHaveProperty("canWrite");
		// The folder table row has no custom field either: its key holds only its name.
		const page = await seeded.read_page({
			...member,
			kind: "file",
			sort: BY_STATUS,
			restricted: true,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(page.page.map((tableRow) => [tableRow.name, tableRow.locked, tableRow.sortKey])).toEqual([
			["secret.md", true, { parts: [null], nameKey: ["secret.md", "secret.md"] }],
		]);
	});

	// More locked rows than one page: a list that dropped them would give short pages.
	test("a page is full with 600 locked and 600 open children", { timeout: 120_000 }, async () => {
		const seeded = await seed_folder_table();
		await seeded.insert_children(
			Array.from({ length: 1200 }, (_, index) => ({
				name: `f-${String(index).padStart(4, "0")}.md`,
				kind: "file" as const,
				updatedAt: index,
				restricted: index % 2 === 0,
			})),
		);
		const member = await seeded.add_member("clerk_locked_full_page", "member");

		const twin = await read_tree_pages(seeded, member, { kind: "file", restricted: true, numItems: 150 });
		expect(twin.map((page) => page.length)).toEqual([150, 150, 150, 150]);
		expect(twin.flat().every((row) => row.locked)).toBe(true);
		const open = await read_tree_pages(seeded, member, { kind: "file", restricted: false, numItems: 150 });
		expect(open.flat()).toHaveLength(600);
		expect(open.flat().every((row) => !row.locked)).toBe(true);
	});

	test.each([
		{ field: "updated", direction: "desc" },
		{ field: "size", direction: "asc" },
		{ field: "created", direction: "asc" },
	] as const)("the $field sort mixes locked and open rows like the owner's table", async (sort) => {
		const seeded = await seed_folder_table();
		await seeded.insert_children(
			Array.from({ length: 12 }, (_, index) => ({
				name: `f-${String(index).padStart(2, "0")}.md`,
				kind: "file" as const,
				// 5 and 12 share no factor, so every file has its own time and size.
				updatedAt: (index * 5) % 12,
				contentByteSize: ((index * 7) % 12) * 10,
				restricted: index % 3 !== 0,
			})),
		);
		const member = await seeded.add_member("clerk_locked_sort", "member");

		const owner = await seeded.read_table(sort);
		expect(owner).toHaveLength(12);
		expect(await seeded.read_table(sort, { member, numItems: 3 })).toEqual(owner);
	});

	test("a custom-field sort puts the restricted rows of a member in a trailing group by name", async () => {
		const seeded = await seed_folder_table();
		const ids = await seeded.insert_children([
			{ name: "a.md", kind: "file", updatedAt: 1 },
			{ name: "z.md", kind: "file", updatedAt: 1 },
			{ name: "m.md", kind: "file", updatedAt: 1, restricted: true },
			{ name: "c.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		await seeded.set_metadata(ids.map((id, index) => [id, [{ key: "status", value: ["b", "a", "0", "0"][index]! }]]));
		const member = await seeded.add_member("clerk_locked_metadata_sort", "member");
		await seeded.grant_read({ userId: member.userId }, [ids[3]!]);

		// The owner sorts every row by its value.
		expect(await seeded.read_table(BY_STATUS)).toEqual(["c.md", "m.md", "z.md", "a.md"]);
		// A member's restricted rows come last, by name, the openable `c.md` too.
		expect(await seeded.read_table(BY_STATUS, { member })).toEqual(["z.md", "a.md", "c.md", "m.md"]);
		expect(await seeded.read_table({ ...BY_STATUS, direction: "desc" }, { member })).toEqual([
			"a.md",
			"z.md",
			"c.md",
			"m.md",
		]);
	});

	test("a guest lists a folder shared with them", async () => {
		const seeded = await seed_folder_table();
		const [notesId, secretId] = await seeded.insert_children([
			{ name: "notes.md", kind: "file", updatedAt: 1 },
			{ name: "secret.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		const guest = await seeded.add_member("clerk_locked_guest", null);
		// `/table` is restricted, as after its scope job, and shared with the guest.
		await seeded.t.run(async (ctx) => {
			const tableId = seeded.parentId;
			await ctx.db.patch("files_nodes", tableId, {
				restrictedScopeNodeId: tableId,
				isRestrictedScopeRoot: true,
				parentScopeNodeId: null,
			});
			await ctx.db.patch("files_nodes", notesId!, { restrictedScopeNodeId: tableId });
			await ctx.db.patch("files_nodes", secretId!, { parentScopeNodeId: tableId });
		});
		await seeded.grant_read({ userId: guest.userId }, [seeded.parentId]);

		const open = await read_tree(seeded, guest, { kind: "file", restricted: false });
		expect(open.page.map((row) => [row._id, row.locked])).toEqual([[notesId, false]]);
		const twin = await read_tree(seeded, guest, { kind: "file", restricted: true });
		expect(twin.page).toEqual([await locked_row_of(seeded, secretId!)]);
		// The root list stays refused: the guest reads no open node.
		expect(
			await guest.as.query(api.files_tree.list_tree_children, {
				stream: "normal" as const,
				membershipId: guest.membershipId,
				parentId: "root",
				kind: "folder",
				archived: false,
				restricted: true,
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).toEqual({ page: [], isDone: true, continueCursor: "", directoryView: null });
	});

	test("a row the scope job has not reached is checked once per pair", async () => {
		const seeded = await seed_folder_table();
		const guest = await seeded.add_member("clerk_locked_lag", null);
		// The guest was added to `/table`: it is an extended root now. Its children still have the old
		// pair until the scope job reaches them.
		await seeded.t.run((ctx) =>
			ctx.db.patch("files_nodes", seeded.parentId, {
				extendedScopeNodeId: seeded.parentId,
				parentExtendedScopeNodeId: null,
			}),
		);
		await seeded.grant_read({ userId: guest.userId }, [seeded.parentId]);
		const ids = await seeded.insert_children(
			Array.from({ length: 6 }, (_, index) => ({ name: `f-${index}.md`, kind: "file" as const, updatedAt: 1 })),
		);
		await seeded.t.run((ctx) => ctx.db.patch("files_nodes", ids[0]!, { extendedScopeNodeId: seeded.parentId }));
		const read_cost = (numItems: number) =>
			guest.as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_tree.list_tree_children, {
					stream: "normal" as const,
					membershipId: guest.membershipId,
					parentId: seeded.parentId,
					kind: "file",
					archived: false,
					restricted: false,
					paginationOpts: { numItems, cursor: null },
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		// The job has reached `f-0.md` only. The others come back locked, like their path answers.
		const all = await read_cost(6);
		expect(all.result.page.map((row) => [row.name, row.locked])).toEqual([
			["f-0.md", false],
			...ids.slice(1).map((_, index) => [`f-${index + 1}.md`, true]),
		]);
		// One lagging row or five: the pair is checked once.
		const one = await read_cost(2);
		expect(one.result.page.map((row) => row.locked)).toEqual([false, true]);
		expect(all.ranges).toBe(one.ranges);
	});

	// Guard = floor(3,000 index ranges / index ranges read by the worst row). The admin holds a
	// workspace role, an organization role and a plugin grant, and each twin row is its own scope. The
	// worst row is shared with their second role and also has an old plugin grant to the admin.
	test.each([
		{ grant: "none", oldPluginGrant: false },
		{ grant: "user", oldPluginGrant: false },
		{ grant: "role", oldPluginGrant: false },
		{ grant: "role", oldPluginGrant: true },
	] as const)(
		"the restricted page guard fits the measured reads of the worst row (grant $grant, old plugin grant $oldPluginGrant)",
		async ({ grant, oldPluginGrant }) => {
			const t = test_convex();
			const f = await seed_tree_access_fixture(t);
			await test_run_with_flush(t, async (ctx) => {
				const now = Date.now();
				const grant_doc = (resourceId: string, principal: object) =>
					ctx.db.insert("access_control_permission_grants", {
						organizationId: f.owner.organizationId,
						workspaceId: f.owner.workspaceId,
						resourceKind: "file",
						resourceId,
						...(principal as { principalKind: "user"; userId: Id<"users"> }),
						permission: "content.read",
						createdAt: now,
						updatedAt: now,
					});
				for (let index = 0; index < 6; index++) {
					const nodeId = await insert_tree_node({
						ctx,
						owner: f.owner,
						parentId: f.nodes.openId,
						path: `/open/a-${index}`,
						kind: "folder",
						scope: "self",
					});
					if (grant === "user") await grant_doc(String(nodeId), { principalKind: "user", userId: f.admin.userId });
					if (grant === "role") await grant_doc(String(nodeId), { principalKind: "role", role: "member" });
					if (oldPluginGrant) {
						await grant_doc(String(nodeId), {
							principalKind: "user",
							userId: f.admin.userId,
							externalPluginMembershipLifetime: 1,
						});
					}
				}
			});
			const read_cost = (numItems: number) =>
				f.asAdmin.run(async (ctx) => {
					const before = await ctx.meta.getTransactionMetrics();
					const result = await ctx.runQuery(api.files_tree.list_tree_children, {
						stream: "normal" as const,
						membershipId: f.admin.membershipId,
						parentId: f.nodes.openId,
						kind: "folder",
						archived: false,
						restricted: true,
						paginationOpts: { numItems, cursor: null },
					});
					const after = await ctx.meta.getTransactionMetrics();
					return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
				});

			// The page cost minus the cost of a one-row page is what the other rows read.
			const one = await read_cost(1);
			const six = await read_cost(6);
			expect(six.result.page.map((row) => row.locked)).toEqual(Array(6).fill(grant === "none"));
			const perRow = (six.ranges - one.ranges) / 5;
			expect(perRow).toBeGreaterThan(0);
			expect(187).toBeLessThanOrEqual(Math.floor(3000 / perRow));
		},
	);

	test("a folder list under a 500-deep extended chain stays under the limits", { timeout: 120_000 }, async () => {
		const seeded = await seed_folder_table();
		const member = await seeded.add_member("clerk_locked_deep", "member");
		// `/table` is restricted to the owner. The member was added on `/table/d`, and 500 folders nested
		// under it each have added people who are not the member, so a check walks the whole chain.
		const chain = await seed_deep_chain(seeded, member);
		const { tableId, template, parent } = chain;
		const deepestId = parent._id;
		await test_run_with_flush(seeded.t, async (ctx) => {
			// Open children of the deepest folder, and restricted ones: one the member can open, one not.
			for (const [index, scope] of (["open", "open", "open", "shared", "locked"] as const).entries()) {
				const path = `${parent.path}/f-${index}.md`;
				const nodeId = await ctx.db.insert("files_nodes", {
					...template,
					parentId: parent._id,
					name: `f-${index}.md`,
					sortName: `f-${index}.md`,
					kind: "file",
					path,
					treePath: path,
					pathDepth: 503,
					isRestrictedScopeRoot: scope !== "open",
					parentScopeNodeId: scope === "open" ? undefined : tableId,
					extendedScopeNodeId: scope === "open" ? parent._id : null,
				});
				if (scope !== "open") await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
				if (scope === "shared")
					await chain.grant(ctx, nodeId, { principalKind: "user", userId: member.userId }, "content.read");
			}
		});

		for (const restricted of [false, true]) {
			const { page, cost } = await member.as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_tree.list_tree_children, {
					stream: "normal" as const,
					membershipId: member.membershipId,
					parentId: deepestId,
					kind: "file",
					archived: false,
					restricted,
					paginationOpts: { numItems: 50, cursor: null },
				});
				return { page: result.page, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
			});
			console.info("Folder list under 500 levels", { restricted, cost });
			expect(page.map((row) => [row.name, row.locked])).toEqual(
				restricted
					? [
							["f-3.md", false],
							["f-4.md", true],
						]
					: [
							["f-0.md", false],
							["f-1.md", false],
							["f-2.md", false],
						],
			);
			expect_under_convex_limits(cost);
			// The read and write checks share one checker, so the chain is read once, inside the
			// 3,000-range budget of a query.
			expect(cost.databaseQueries, "databaseQueries").toBeLessThan(3000);
		}
	});

	// Guard = floor(3,000 index ranges / index ranges read by the worst row). An open row the scope job
	// has not reached gets the full check. The worst one is its own "Add people" root, still pointing at
	// an old root, read by somebody who gets in only through added people on a folder above, through
	// their second role: it reads its node, then its own read and write grants.
	test("the open page guard fits the measured reads of the worst row the scope job has not reached", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		// `/open/lag` is restricted to nobody. The admin's organization role was added on `/open/lag/d`,
		// and `/open/lag/d/f` has added people of its own. Its children are their own "Add people" roots
		// but still point at `/open/lag/d`.
		const folderId = await t.run(async (ctx) => {
			const now = Date.now();
			const folder = (parentId: Id<"files_nodes">, path: string, scope: Id<"files_nodes"> | "self") =>
				insert_tree_node({ ctx, owner: f.owner, parentId, path, kind: "folder", scope });
			const areaId = await folder(f.nodes.openId, "/open/lag", "self");
			const addedId = await folder(areaId, "/open/lag/d", areaId);
			await ctx.db.patch("files_nodes", addedId, { extendedScopeNodeId: addedId, parentExtendedScopeNodeId: null });
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "file",
				resourceId: String(addedId),
				principalKind: "role",
				role: "member",
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			const folderId = await folder(addedId, "/open/lag/d/f", areaId);
			await ctx.db.patch("files_nodes", folderId, {
				extendedScopeNodeId: folderId,
				parentExtendedScopeNodeId: addedId,
			});
			for (let index = 0; index < 6; index++) {
				const childId = await folder(folderId, `/open/lag/d/f/c-${index}`, areaId);
				await ctx.db.patch("files_nodes", childId, {
					extendedScopeNodeId: childId,
					parentExtendedScopeNodeId: addedId,
				});
			}
			return folderId;
		});
		const read_cost = (numItems: number) =>
			f.asAdmin.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_tree.list_tree_children, {
					stream: "normal" as const,
					membershipId: f.admin.membershipId,
					parentId: folderId,
					kind: "folder",
					archived: false,
					restricted: false,
					paginationOpts: { numItems, cursor: null },
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		// The page cost minus the cost of a one-row page is what the other rows read.
		const one = await read_cost(1);
		const six = await read_cost(6);
		expect(six.result.page.map((row) => row.locked)).toEqual(Array(6).fill(false));
		const perRow = (six.ranges - one.ranges) / 5;
		expect(perRow).toBeGreaterThan(0);
		// A metadata row also reads its node.
		expect(375).toBeLessThanOrEqual(Math.floor(3000 / (perRow + 1)));
	});

	test("a page of rows the scope job has not reached splits under a 500-deep chain", { timeout: 120_000 }, async () => {
		const seeded = await seed_folder_table();
		const member = await seeded.add_member("clerk_locked_deep_lag", "member");
		const { template, parent } = await seed_deep_chain(seeded, member);
		// 200 files of the deepest folder are their own "Add people" roots, but still point at the folder
		// above it: the scope job has not reached them. So each one gets the full check.
		await test_run_with_flush(seeded.t, async (ctx) => {
			for (let index = 0; index < 200; index++) {
				const name = `f-${String(index).padStart(3, "0")}.md`;
				const path = `${parent.path}/${name}`;
				const nodeId = await ctx.db.insert("files_nodes", {
					...template,
					parentId: parent._id,
					name,
					sortName: name,
					kind: "file",
					path,
					treePath: path,
					pathDepth: 503,
					isRestrictedScopeRoot: false,
					parentScopeNodeId: undefined,
					parentExtendedScopeNodeId: parent.parentExtendedScopeNodeId,
				});
				await ctx.db.patch("files_nodes", nodeId, { extendedScopeNodeId: nodeId });
			}
		});

		const names: string[] = [];
		let cursor: string | null = null;
		for (let index = 0; index < 400; index++) {
			const { result, cost } = await member.as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result: TreePage = await ctx.runQuery(api.files_tree.list_tree_children, {
					stream: "normal" as const,
					pageView: null,
					membershipId: member.membershipId,
					parentId: parent._id,
					kind: "file",
					archived: false,
					restricted: false,
					paginationOpts: { numItems: 200, cursor },
				});
				return { result, cost: transaction_cost(before, await ctx.meta.getTransactionMetrics()) };
			});
			expect_under_convex_limits(cost);
			// The guard shrinks by the folder's read and write checks, so the page splits in time.
			expect(cost.databaseQueries, "databaseQueries").toBeLessThan(3000);
			names.push(...result.page.map((row) => row.name));
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
		expect(new Set(names).size).toBe(200);
	});
});

describe("custom-field filters with restricted children", () => {
	/**
	 * `/table` holds `Acme` (shared with Bob), `Beta` (shared with Bob's role), `HR` (only the owner)
	 * and `notes.md` (open). Values: Acme Done, Beta Open, HR `hrStatus`, notes.md Done.
	 */
	async function seed_clients(hrStatus = "Done") {
		const seeded = await seed_folder_table();
		const ids = await seeded.insert_children([
			{ name: "Acme", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "Beta", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "HR", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "notes.md", kind: "file", updatedAt: 1 },
		]);
		const [acmeId, betaId, hrId] = ids;
		await seeded.set_metadata(
			ids.map((id, index) => [id, [{ key: "status", value: ["Done", "Open", hrStatus, "Done"][index]! }]]),
		);
		const bob = await seeded.add_member("clerk_clients_bob", "member");
		await seeded.grant_read({ userId: bob.userId }, [acmeId!]);
		await seeded.grant_read({ role: "member" }, [betaId!]);
		return { ...seeded, bob, hrId: hrId! };
	}
	const IS_DONE = { kind: "text", field: "metadata.status", op: "is", value: "Done" } as const;
	const PRESENT = { kind: "text", field: "metadata.status", op: "present" } as const;

	test("a custom-field filter shows a restricted child the member can open", async () => {
		const { read_table, bob } = await seed_clients();
		expect(await read_table(BY_NAME, { filter: IS_DONE, member: bob })).toEqual(["Acme", "notes.md"]);
		// "present" is in value order, so the restricted rows come after the value rows, by name.
		expect(await read_table(BY_STATUS, { filter: PRESENT, member: bob })).toEqual(["Acme", "Beta", "notes.md"]);
	});

	test("a custom-field filter never shows a locked child, whatever its value", async () => {
		const { read_table, read_page, bob } = await seed_clients();
		for (const [sort, filter] of [
			[BY_NAME, IS_DONE],
			[BY_STATUS, PRESENT],
		] as const) {
			expect(await read_table(sort, { filter, member: bob })).not.toContain("HR");
			// The member's restricted stream of a custom-field filter has no rows at all.
			expect(
				await read_page({
					...bob,
					kind: "folder",
					sort,
					filter,
					restricted: true,
					paginationOpts: { numItems: 10, cursor: null },
				}),
			).toEqual({ page: [], isDone: true, continueCursor: "", directoryView: null });
		}
		// The owner still sees HR by its value.
		expect(await (await seed_clients()).read_table(BY_NAME, { filter: IS_DONE })).toEqual(["Acme", "HR", "notes.md"]);
	});

	test("a locked child's value does not change the pages", async () => {
		/** Every page of every stream a member reads for the filter, one row per page. */
		const read_pages = async (hrStatus: string) => {
			const { read_page, bob } = await seed_clients(hrStatus);
			const pages: string[][] = [];
			for (const stream of [
				{ restricted: false },
				{ restricted: true },
				{ principalIndex: 0 },
				{ principalIndex: 1 },
				{ principalIndex: 2 },
			] as const) {
				let cursor: string | null = null;
				for (let index = 0; index < 20; index++) {
					const result: Awaited<ReturnType<typeof read_page>> = await read_page({
						...bob,
						...stream,
						kind: "folder",
						sort: BY_NAME,
						filter: IS_DONE satisfies files_table_Filter,
						paginationOpts: { numItems: 1, cursor },
					});
					pages.push(result.page.map((row) => row.name));
					if (result.isDone) break;
					cursor = result.continueCursor;
				}
			}
			return pages;
		};

		const done = await read_pages("Done");
		expect(done.flat()).toEqual(["Acme"]);
		expect(await read_pages("Open")).toEqual(done);
	});
});
