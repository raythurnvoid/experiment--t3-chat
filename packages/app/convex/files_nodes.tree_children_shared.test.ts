import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key, type files_sort_Clause } from "../shared/files-sort.ts";
import { files_table_filter_order_field, type files_table_Filter } from "../shared/files-table.ts";
import { insert_tree_node, seed_tree_access_fixture, seed_folder_table } from "./files_nodes.setup.test.ts";

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

describe("list_tree_children_shared", () => {
	const REFUSED = { page: [], isDone: true, continueCursor: "" };
	const BY_NAME = { field: "name", direction: "asc" } as const;
	const FIRST_PAGE = { numItems: 10, cursor: null };
	const DAY = Date.UTC(2026, 8, 4);
	const HOUR = 60 * 60 * 1000;

	/**
	 * 644 children. Every restricted child but `hidden` and `zz-hidden.md` is shared with a member: 600
	 * files and a folder. So the member's table must be the owner's table without those two.
	 */
	async function seed_shared_table() {
		const seeded = await seed_folder_table();
		const children = [
			...Array.from({ length: 640 }, (_, index) => ({
				name: `f-${String(index).padStart(3, "0")}${[".md", ".txt", ""][index % 3]}`,
				kind: "file" as const,
				// 37 and 640 share no factor, so every file has its own time.
				updatedAt: DAY + (((index * 37) % 640) - 320) * HOUR,
				lowercaseExtension: ["md", "txt", undefined][index % 3],
				contentByteSize: index % 4 === 0 ? undefined : (index * 7) % 500,
				restricted: index % 16 !== 0,
			})),
			{ name: "alpha", kind: "folder" as const, updatedAt: DAY },
			{ name: "beta", kind: "folder" as const, updatedAt: DAY - HOUR, restricted: true },
			{ name: "hidden", kind: "folder" as const, updatedAt: DAY + HOUR, restricted: true },
			{
				name: "zz-hidden.md",
				kind: "file" as const,
				updatedAt: DAY,
				lowercaseExtension: "md",
				contentByteSize: 7,
				restricted: true,
			},
		];
		const ids = await seeded.insert_children(children);
		const member = await seeded.add_member("clerk_shared_table", "member");
		const hidden = ["hidden", "zz-hidden.md"];
		const sharedIds = ids.filter((_, index) => children[index]!.restricted && !hidden.includes(children[index]!.name));
		expect(sharedIds).toHaveLength(601);
		await seeded.grant_read({ userId: member.userId }, sharedIds);
		return { ...seeded, member, hidden };
	}

	// One test per sort or filter and direction: each one reads the 644 rows twice.
	test.each(
		["name", "created", "updated", "extension", "size"].flatMap((field) =>
			(["asc", "desc"] as const).map((direction) => ({ field, direction })),
		),
	)(
		"a member pages 600 user shares in the $field $direction sort, like the owner's table without the hidden rows",
		async (sort) => {
			const { read_table, member, hidden } = await seed_shared_table();

			const owner = await read_table(sort, { numItems: 200 });
			expect(owner).toHaveLength(644);
			// 70 rows per page, so the 601 shares take 9 pages.
			expect(await read_table(sort, { numItems: 70, member })).toEqual(owner.filter((name) => !hidden.includes(name)));
		},
	);

	const day = { start: DAY, end: DAY + 24 * HOUR };
	test.each(
		(
			[
				{ filter: { kind: "name", field: "name", op: "starts_with", value: "f-" }, namePrefix: null },
				{ filter: { kind: "extension", field: "extension", op: "is", value: "md" }, namePrefix: null },
				{ filter: { kind: "extension", field: "extension", op: "is", value: "md" }, namePrefix: "f-" },
				{ filter: { kind: "extension", field: "extension", op: "missing" }, namePrefix: null },
				{ filter: { kind: "size", field: "size", op: "is", value: 7 }, namePrefix: null },
				{ filter: { kind: "size", field: "size", op: "missing" }, namePrefix: null },
				{ filter: { kind: "size", field: "size", op: "at_least", value: 250 }, namePrefix: null },
				{ filter: { kind: "size", field: "size", op: "at_most", value: 100 }, namePrefix: null },
				{ filter: { kind: "date", field: "updated", op: "on", ...day }, namePrefix: null },
				{ filter: { kind: "date", field: "updated", op: "before", ...day }, namePrefix: null },
				{ filter: { kind: "date", field: "updated", op: "after", ...day }, namePrefix: null },
				{ filter: { kind: "date", field: "created", op: "after", start: 0, end: 24 * HOUR }, namePrefix: null },
			] satisfies Array<{ filter: files_table_Filter; namePrefix: string | null }>
		).flatMap((filterCase) => (["asc", "desc"] as const).map((direction) => ({ ...filterCase, direction }))),
	)(
		"a member pages 600 user shares in the $filter.field $filter.op filter (prefix $namePrefix, $direction), like the owner's table without the hidden rows",
		async ({ filter, namePrefix, direction }) => {
			const { read_table, member, hidden } = await seed_shared_table();
			const sort = { field: files_table_filter_order_field(filter), direction };

			const owner = await read_table(sort, { filter, namePrefix, numItems: 200 });
			expect(owner.length).toBeGreaterThan(0);
			expect(await read_table(sort, { filter, namePrefix, numItems: 70, member })).toEqual(
				owner.filter((name) => !hidden.includes(name)),
			);
		},
	);

	test("a role share shows for every member with the role, and a node shared twice shows once", async () => {
		const { t, parentId, insert_children, add_member, grant_read, read_page, read_table } = await seed_folder_table();
		const [teamId, mineId] = await insert_children([
			{ name: "team", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "mine", kind: "folder", updatedAt: 1, restricted: true },
		]);
		const first = await add_member("clerk_role_share_first", "member");
		const second = await add_member("clerk_role_share_second", "member");
		await grant_read({ role: "member" }, [teamId!]);
		await grant_read({ userId: first.userId }, [teamId!, mineId!]);

		// One share row serves every member with the role.
		const shareRows = await t.run((ctx) => ctx.db.query("files_share_rows").collect());
		expect(shareRows.filter((row) => row.parentId === parentId)).toHaveLength(3);
		for (const member of [first, second]) {
			const rolePage = await read_page({
				...member,
				kind: "folder",
				sort: BY_NAME,
				principalIndex: 1,
				paginationOpts: FIRST_PAGE,
			});
			expect(rolePage.page.map((row) => row.name)).toEqual(["team"]);
		}
		expect(await read_table(BY_NAME, { member: first })).toEqual(["mine", "team"]);
		expect(await read_table(BY_NAME, { member: second })).toEqual(["team"]);
	});

	test("a shared folder sorts in the missing segment of an extension sort", async () => {
		const { insert_children, add_member, grant_read, read_page, read_table } = await seed_folder_table();
		const ids = await insert_children([
			{ name: "alpha", kind: "folder", updatedAt: 1 },
			{ name: "beta", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "a.md", kind: "file", updatedAt: 1, lowercaseExtension: "md", restricted: true },
		]);
		const member = await add_member("clerk_extension_folder", "member");
		await grant_read({ userId: member.userId }, ids.slice(1));
		const sort = { field: "extension", direction: "desc" } as const;
		const read = (segment: "value" | "missing") =>
			read_page({ ...member, kind: "folder", sort, segment, principalIndex: 0, paginationOpts: FIRST_PAGE });

		expect((await read("value")).page).toEqual([]);
		expect((await read("missing")).page.map((row) => [row.name, row.sortKey])).toEqual([
			["beta", { parts: [null], nameKey: ["beta", "beta"] }],
		]);
		expect(await read_table(sort, { member })).toEqual(["alpha", "beta", "a.md"]);
	});

	test("a share made long after its node sorts by the node's creation time", async () => {
		const { insert_child, add_member, grant_read, read_table } = await seed_folder_table();
		// The older node gets the later share, and the name order is the other way.
		const olderId = await insert_child({ name: "b-older", kind: "folder", updatedAt: 1, restricted: true });
		const newerId = await insert_child({ name: "a-newer", kind: "folder", updatedAt: 1, restricted: true });
		const member = await add_member("clerk_created_share", "member");
		await grant_read({ userId: member.userId }, [newerId]);
		await grant_read({ userId: member.userId }, [olderId]);

		for (const direction of ["asc", "desc"] as const) {
			const sort = { field: "created", direction };
			const owner = await read_table(sort);
			expect(owner).toEqual(direction === "asc" ? ["b-older", "a-newer"] : ["a-newer", "b-older"]);
			expect(await read_table(sort, { member })).toEqual(owner);
		}
	});

	test("the archived sidebar reads a member's archived shares, in name order only", async () => {
		const { t, parentId, insert_children, add_member, grant_read } = await seed_folder_table();
		const ids = await insert_children([
			{ name: "kept", kind: "folder", updatedAt: 1, restricted: true },
			{ name: "gone", kind: "folder", updatedAt: 1, restricted: true },
		]);
		const member = await add_member("clerk_archived_share", "member");
		await grant_read({ userId: member.userId }, ids);
		await test_run_with_flush(t, (ctx) => ctx.db.patch("files_nodes", ids[1]!, { archiveOperationId: "archive-1" }));
		const read = (archived: boolean, sort: files_sort_Clause = BY_NAME) =>
			member.as.query(api.files_nodes.list_tree_children_shared, {
				membershipId: member.membershipId,
				parentId,
				kind: "folder",
				archived,
				principalIndex: 0,
				sort: [sort],
				filter: null,
				namePrefix: null,
				segment: "value",
				paginationOpts: FIRST_PAGE,
			});

		expect((await read(false)).page.map((row) => row.name)).toEqual(["kept"]);
		expect((await read(true)).page.map((row) => [row.name, row.sortKey])).toEqual([
			["gone", { parts: [["archive-1", "gone", "gone"]], nameKey: ["gone", "gone"] }],
		]);
		expect(await read(true, { field: "updated", direction: "desc" })).toEqual(REFUSED);
	});

	test("the owner gets no share rows, even for a node shared with themselves", async () => {
		const { db, insert_child, grant_read, read_page, read_table } = await seed_folder_table();
		const nodeId = await insert_child({ name: "mine", kind: "folder", updatedAt: 1, restricted: true });
		await grant_read({ userId: db.userId }, [nodeId]);

		for (const principalIndex of [0, 1, 2] as const) {
			expect(await read_page({ kind: "folder", sort: BY_NAME, principalIndex, paginationOpts: FIRST_PAGE })).toEqual(
				REFUSED,
			);
		}
		expect(await read_table(BY_NAME)).toEqual(["mine"]);
	});

	test("a share row that no longer matches its node or its access shows nothing", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { t, parentId, insert_children, add_member, grant_read, read_table } = await seed_folder_table();
		const names = ["archived", "foreign", "kept", "moved", "renamed", "unrestricted", "unshared"];
		const ids = await insert_children([
			...names.map((name) => ({ name, kind: "folder" as const, updatedAt: 1, restricted: true })),
			{ name: "elsewhere", kind: "folder", updatedAt: 1 },
		]);
		const [archivedId, foreignId, , movedId, renamedId, unrestrictedId, unsharedId, elsewhereId] = ids;
		const member = await add_member("clerk_stale_share", "member");
		await grant_read({ userId: member.userId }, ids.slice(0, 7));

		// Plain `t.run` skips the flush, so the share rows keep the old copy.
		await t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
			const parent = await ctx.db.get("files_nodes", parentId);
			await ctx.db.patch("files_nodes", archivedId!, { archiveOperationId: "archive-1" });
			// The grant names the node in this workspace, so only the node's own workspace keeps it out.
			await ctx.db.patch("files_nodes", foreignId!, {
				organizationId: other.organizationId,
				workspaceId: other.workspaceId,
			});
			await ctx.db.patch("files_nodes", movedId!, { parentId: elsewhereId! });
			await ctx.db.patch("files_nodes", renamedId!, { name: "a-renamed", sortName: files_sort_text_key("a-renamed") });
			await ctx.db.patch("files_nodes", unrestrictedId!, { restrictedScopeNodeId: parent!.restrictedScopeNodeId });
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			const grant = grants.find((doc) => doc.resourceId === String(unsharedId));
			await ctx.db.delete("access_control_permission_grants", grant!._id);
		});

		// Dropped rows make a page short, so read each stream in one page.
		expect(await read_table(BY_NAME, { member, numItems: 10 })).toEqual(["elsewhere", "kept"]);
		// A copy out of step with its node is a bug, so it is logged.
		expect(
			new Set(
				consoleError.mock.calls
					.filter(([message]) => message === "files_share_rows copy is mismatched")
					.map(([, data]) => (data as { nodeId: Id<"files_nodes"> }).nodeId),
			),
		).toEqual(new Set([archivedId, movedId, renamedId]));
	});

	test("a metadata sort or filter gives a member no share rows", async () => {
		const { insert_children, add_member, grant_read, set_metadata, read_page, read_table } = await seed_folder_table();
		const ids = await insert_children([
			{ name: "open.md", kind: "file", updatedAt: 1 },
			{ name: "shared.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		await set_metadata(ids.map((id) => [id, [{ key: "status", value: "open" }]]));
		const member = await add_member("clerk_metadata_share", "member");
		await grant_read({ userId: member.userId }, [ids[1]!]);
		const status = { field: "metadata.status", direction: "asc" } as const;

		expect(
			await read_page({ ...member, kind: "file", sort: status, principalIndex: 0, paginationOpts: FIRST_PAGE }),
		).toEqual(REFUSED);
		expect(
			await read_page({
				...member,
				kind: "file",
				sort: status,
				filter: { kind: "text", field: "metadata.status", op: "present" },
				principalIndex: 0,
				paginationOpts: FIRST_PAGE,
			}),
		).toEqual(REFUSED);
		expect(await read_table(status, { member })).toEqual(["open.md"]);
		expect(await read_table(BY_NAME, { member })).toEqual(["open.md", "shared.md"]);
	});

	test("a member's first tree page shows their 3 shares past 1,500 restricted children they cannot read", async () => {
		const { parentId, insert_children, add_member, grant_read } = await seed_folder_table();
		const ids = await insert_children(
			[
				...Array.from({ length: 1500 }, (_, index) => `h-${String(index).padStart(4, "0")}`),
				"zz-1",
				"zz-2",
				"zz-3",
			].map((name) => ({ name, kind: "folder" as const, updatedAt: 1, restricted: true })),
		);
		const member = await add_member("clerk_tree_many_hidden", "member");
		await grant_read({ userId: member.userId }, ids.slice(1500));
		const paginationOpts = { numItems: 50, cursor: null };

		// The tree's first page of the folder: the open stream and the member's own share stream.
		const open = await member.as.query(api.files_nodes.list_tree_children, {
			membershipId: member.membershipId,
			parentId,
			kind: "folder",
			archived: false,
			restricted: false,
			paginationOpts,
		});
		expect(open).toMatchObject({ page: [], isDone: true });
		const shared = await member.as.query(api.files_nodes.list_tree_children_shared, {
			membershipId: member.membershipId,
			parentId,
			kind: "folder",
			archived: false,
			principalIndex: 0,
			sort: [BY_NAME],
			filter: null,
			namePrefix: null,
			segment: "value",
			paginationOpts,
		});
		expect(shared.page.map((row) => row.name)).toEqual(["zz-1", "zz-2", "zz-3"]);
		expect(shared.isDone).toBe(true);
	});

	test("refuses a folder the caller cannot read, and gives a grant-only member their shares at the root", async () => {
		const { t, db, asOwner, parentId, add_member, grant_read } = await seed_folder_table();
		const member = await add_member("clerk_root_grant_only", null);
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: parentId }),
		).toEqual({ _yay: null });
		await grant_read({ userId: member.userId }, [parentId]);
		const args = {
			membershipId: member.membershipId,
			parentId: "root" as const,
			kind: "folder" as const,
			sort: [BY_NAME],
			filter: null,
			namePrefix: null,
			segment: "value" as const,
			paginationOpts: FIRST_PAGE,
		};

		const root = await member.as.query(api.files_nodes.list_tree_children_shared, {
			...args,
			archived: false,
			principalIndex: 0,
		});
		expect(root.page.map((row) => row.name)).toEqual(["table"]);
		// The member has no role, so no role stream.
		expect(
			await member.as.query(api.files_nodes.list_tree_children_shared, { ...args, archived: false, principalIndex: 1 }),
		).toEqual(REFUSED);
		// The sorted pages give this member nothing at the root.
		expect(await member.as.query(api.files_nodes.list_tree_children_sorted, { ...args, restricted: false })).toEqual(
			REFUSED,
		);

		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_nodes.list_tree_children_shared, {
				...args,
				membershipId: other.membershipId,
				parentId,
				archived: false,
				principalIndex: 0,
			}),
		).toEqual(REFUSED);
	});

	test("refuses the owner, a missing role, a metadata order and an archived non-name order before reading the folder", async () => {
		const { db, asOwner, parentId, add_member } = await seed_folder_table();
		const member = await add_member("clerk_shared_cheap_refusal", null);
		const base = {
			membershipId: member.membershipId,
			kind: "folder" as const,
			archived: false,
			principalIndex: 0 as const,
			sort: [BY_NAME],
			filter: null,
			namePrefix: null,
			segment: "value" as const,
			paginationOpts: FIRST_PAGE,
		};
		const cases = [
			{ as: asOwner, args: { ...base, membershipId: db.membershipId } },
			// The member has no role, so no role stream.
			{ as: member.as, args: { ...base, principalIndex: 1 as const } },
			{ as: member.as, args: { ...base, sort: [{ field: "metadata.status", direction: "asc" as const }] } },
			{ as: member.as, args: { ...base, archived: true, sort: [{ field: "updated", direction: "desc" as const }] } },
		];
		// The root has no folder to read, so a refusal at the folder costs the same only when it reads
		// no folder.
		const read_cost = (as: typeof asOwner, args: (typeof cases)[number]["args"], at: Id<"files_nodes"> | "root") =>
			as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_nodes.list_tree_children_shared, { ...args, parentId: at });
				const after = await ctx.meta.getTransactionMetrics();
				return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		for (const { as, args } of cases) {
			const atRoot = await read_cost(as, args, "root");
			const atFolder = await read_cost(as, args, parentId);
			expect([atRoot.result, atFolder.result]).toEqual([REFUSED, REFUSED]);
			expect(atFolder.ranges).toBe(atRoot.ranges);
		}
	});

	// convex-test marks any page that reads more than `numItems` + 1 rows, so this proves the split
	// runs before any row read. The cost test below checks the guard number.
	test("a page whose end cursor holds more than 187 rows asks for a split and reads no row", async () => {
		const { t, insert_children, add_member, grant_read, read_page } = await seed_folder_table();
		const names = Array.from({ length: 203 }, (_, index) => `n-${String(index).padStart(4, "0")}.md`);
		const ids = await insert_children(
			names.map((name) => ({ name, kind: "file" as const, updatedAt: 1, restricted: true })),
		);
		const member = await add_member("clerk_shared_split", "member");
		await grant_read({ userId: member.userId }, ids);
		const read = (paginationOpts: { numItems: number; cursor: string | null; endCursor?: string }) =>
			read_page({ ...member, kind: "file", sort: BY_NAME, principalIndex: 0, paginationOpts });

		const first = await read({ numItems: 100, cursor: null });
		const second = await read({ numItems: 100, cursor: first.continueCursor });
		const endCursor = (await read({ numItems: 2, cursor: second.continueCursor })).continueCursor;

		// A SYSTEM author makes the tree rows throw, so this page proves the guard runs before any row read.
		await t.run((ctx) => ctx.db.patch("files_nodes", ids[125]!, { createdBy: users_SYSTEM_AUTHOR }));
		expect(await read({ numItems: 100, cursor: null, endCursor })).toEqual({
			page: [],
			isDone: false,
			continueCursor: endCursor,
			splitCursor: expect.any(String),
			pageStatus: "SplitRequired",
		});
		// A pinned page under the guard gives its rows.
		const small = await read({ numItems: 200, cursor: null, endCursor: first.continueCursor });
		expect(small.page.map((row) => row.name)).toEqual(names.slice(0, 100));
	});

	// Guard = floor(3,000 index ranges / index ranges read by the worst row). The admin holds a
	// workspace role, an organization role and a plugin grant, and each row is its own scope. The
	// worst row is shared with their second role and also has an old plugin grant to the admin: the
	// read check reads that grant, then the live membership lifetime, then the roles.
	// `list_tree_shared_roots` reads rows the same way.
	test.each([
		{ principalIndex: 0, oldPluginGrant: false },
		{ principalIndex: 2, oldPluginGrant: false },
		{ principalIndex: 2, oldPluginGrant: true },
	] as const)(
		"the share page guard fits the measured reads of the worst row of both share queries (principal $principalIndex, old plugin grant $oldPluginGrant)",
		async ({ principalIndex, oldPluginGrant }) => {
			const t = test_convex();
			const f = await seed_tree_access_fixture(t);
			await test_run_with_flush(t, async (ctx) => {
				const now = Date.now();
				for (let index = 0; index < 6; index++) {
					const nodeId = await insert_tree_node({
						ctx,
						owner: f.owner,
						parentId: f.nodes.openId,
						path: `/open/a-${index}`,
						kind: "folder",
						scope: "self",
					});
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: f.owner.organizationId,
						workspaceId: f.owner.workspaceId,
						resourceKind: "file",
						resourceId: String(nodeId),
						...(principalIndex === 0
							? { principalKind: "user" as const, userId: f.admin.userId }
							: { principalKind: "role" as const, role: "member" as const }),
						permission: "content.read",
						createdAt: now,
						updatedAt: now,
					});
					if (oldPluginGrant) {
						await ctx.db.insert("access_control_permission_grants", {
							organizationId: f.owner.organizationId,
							workspaceId: f.owner.workspaceId,
							resourceKind: "file",
							resourceId: String(nodeId),
							principalKind: "user",
							userId: f.admin.userId,
							externalPluginMembershipLifetime: 1,
							permission: "content.read",
							createdAt: now,
							updatedAt: now,
						});
					}
				}
			});
			const read_cost = (numItems: number, query: "children" | "roots") =>
				f.asAdmin.run(async (ctx) => {
					const paginationOpts = { numItems, cursor: null };
					const before = await ctx.meta.getTransactionMetrics();
					const result =
						query === "children"
							? await ctx.runQuery(api.files_nodes.list_tree_children_shared, {
									membershipId: f.admin.membershipId,
									parentId: f.nodes.openId,
									kind: "folder",
									archived: false,
									principalIndex,
									sort: [BY_NAME],
									filter: null,
									namePrefix: null,
									segment: "value",
									paginationOpts,
								})
							: await ctx.runQuery(api.files_nodes.list_tree_shared_roots, {
									membershipId: f.admin.membershipId,
									archived: false,
									principalIndex,
									paginationOpts,
								});
					const after = await ctx.meta.getTransactionMetrics();
					return { rows: result.page.length, ranges: after.databaseQueries.used - before.databaseQueries.used };
				});

			// The new `a-*` shares come first by name in both queries. The page cost minus the cost of a
			// one-row page is what the other rows read.
			for (const query of ["children", "roots"] as const) {
				const one = await read_cost(1, query);
				const six = await read_cost(6, query);
				expect([one.rows, six.rows]).toEqual([1, 6]);
				const perRow = (six.ranges - one.ranges) / 5;
				expect(perRow).toBeGreaterThan(0);
				expect(187).toBeLessThanOrEqual(Math.floor(3000 / perRow));
			}
		},
	);
});

describe("has_tree_children_shared", () => {
	test("says whether a member has an active share in the folder, and the owner gets false", async () => {
		const { db, asOwner, parentId, insert_children, add_member, grant_read } = await seed_folder_table();
		const ids = await insert_children([
			{ name: "open.md", kind: "file", updatedAt: 1 },
			{ name: "shared.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		const member = await add_member("clerk_has_shared", "member");
		const other = await add_member("clerk_has_shared_other", "member");
		await grant_read({ userId: member.userId }, [ids[1]!]);
		await grant_read({ userId: db.userId }, [ids[1]!]);
		const has_shared = (as: typeof asOwner, membershipId: Id<"organizations_workspaces_users">) =>
			as.query(api.files_nodes.has_tree_children_shared, { membershipId, parentId, archived: false });

		expect(await has_shared(member.as, member.membershipId)).toBe(true);
		expect(await has_shared(other.as, other.membershipId)).toBe(false);
		// The owner reads every restricted child in the restricted twin, even one shared with them.
		expect(await has_shared(asOwner, db.membershipId)).toBe(false);
	});

	test("an archived share counts only for the archived read", async () => {
		const { t, parentId, insert_child, add_member, grant_read } = await seed_folder_table();
		const nodeId = await insert_child({ name: "gone", kind: "folder", updatedAt: 1, restricted: true });
		const member = await add_member("clerk_has_shared_archived", "member");
		await grant_read({ userId: member.userId }, [nodeId]);
		await test_run_with_flush(t, (ctx) => ctx.db.patch("files_nodes", nodeId, { archiveOperationId: "archive-1" }));
		const has_shared = (archived: boolean) =>
			member.as.query(api.files_nodes.has_tree_children_shared, {
				membershipId: member.membershipId,
				parentId,
				archived,
			});

		expect(await has_shared(false)).toBe(false);
		expect(await has_shared(true)).toBe(true);
	});

	test("a plugin grant share counts only with the member's live membership lifetime", async () => {
		const { t, db, parentId, insert_child, add_member, grant_read } = await seed_folder_table();
		const nodeId = await insert_child({ name: "plugin", kind: "folder", updatedAt: 1, restricted: true });
		const member = await add_member("clerk_has_shared_plugin", "member");
		await grant_read({ userId: member.userId, externalPluginMembershipLifetime: 1 }, [nodeId]);
		const lifetimeId = await t.run((ctx) =>
			ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: member.userId,
				membershipId: member.membershipId,
				lifetime: 2,
				active: true,
			}),
		);
		const has_shared = () =>
			member.as.query(api.files_nodes.has_tree_children_shared, {
				membershipId: member.membershipId,
				parentId,
				archived: false,
			});

		// After a re-invite the old grant reads nothing.
		expect(await has_shared()).toBe(false);
		await t.run((ctx) => ctx.db.patch("organizations_membership_lifetimes", lifetimeId, { lifetime: 1 }));
		expect(await has_shared()).toBe(true);
	});

	test("refuses a folder the caller cannot read, and gives a grant-only member their shares at the root", async () => {
		const { t, db, asOwner, parentId, add_member, grant_read } = await seed_folder_table();
		const member = await add_member("clerk_has_shared_grant_only", null);
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: parentId }),
		).toEqual({ _yay: null });
		await grant_read({ userId: member.userId }, [parentId]);

		expect(
			await member.as.query(api.files_nodes.has_tree_children_shared, {
				membershipId: member.membershipId,
				parentId: "root",
				archived: false,
			}),
		).toBe(true);

		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_nodes.has_tree_children_shared, {
				membershipId: other.membershipId,
				parentId,
				archived: false,
			}),
		).toBeNull();
	});
});
