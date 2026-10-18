import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import type { files_table_Filter } from "../shared/files-table.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
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
	// The share streams serve only custom-field filters. `present` is in value order, so its share rows
	// come after the open rows, by name.
	const PRESENT = { kind: "text", field: "metadata.status", op: "present" } as const satisfies files_table_Filter;
	const BY_STATUS = { field: "metadata.status", direction: "asc" } as const;
	const STATUS = [{ key: "status", value: "open" }];

	test("a role share shows for every member with the role, and a node shared twice shows once", async () => {
		const { t, parentId, insert_children, add_member, grant_read, set_metadata, read_page, read_table } =
			await seed_folder_table();
		const ids = await insert_children([
			{ name: "team.md", kind: "file", updatedAt: 1, restricted: true },
			{ name: "mine.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		const [teamId, mineId] = ids;
		await set_metadata(ids.map((id) => [id, STATUS]));
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
				kind: "file",
				sort: BY_STATUS,
				filter: PRESENT,
				principalIndex: 1,
				paginationOpts: FIRST_PAGE,
			});
			expect(rolePage.page.map((row) => [row.name, row.sortKey])).toEqual([
				["team.md", { parts: [null], nameKey: ["team.md", "team.md"] }],
			]);
		}
		expect(await read_table(BY_STATUS, { filter: PRESENT, member: first })).toEqual(["mine.md", "team.md"]);
		expect(await read_table(BY_STATUS, { filter: PRESENT, member: second })).toEqual(["team.md"]);
	});

	test("the owner gets no share rows, even for a node shared with themselves", async () => {
		const { db, insert_child, grant_read, set_metadata, read_page, read_table } = await seed_folder_table();
		const nodeId = await insert_child({ name: "mine.md", kind: "file", updatedAt: 1, restricted: true });
		await set_metadata([[nodeId, STATUS]]);
		await grant_read({ userId: db.userId }, [nodeId]);

		for (const principalIndex of [0, 1, 2] as const) {
			expect(
				await read_page({ kind: "file", sort: BY_STATUS, filter: PRESENT, principalIndex, paginationOpts: FIRST_PAGE }),
			).toEqual(REFUSED);
		}
		// The owner reads the restricted metadata twin instead.
		expect(await read_table(BY_STATUS, { filter: PRESENT })).toEqual(["mine.md"]);
	});

	test("a share row that no longer matches its node or its access shows nothing", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { t, parentId, insert_children, add_member, grant_read, set_metadata, read_table } =
			await seed_folder_table();
		const names = ["archived", "foreign", "kept", "moved", "renamed", "unrestricted", "unshared"];
		const ids = await insert_children([
			...names.map((name) => ({ name: `${name}.md`, kind: "file" as const, updatedAt: 1, restricted: true })),
			{ name: "elsewhere", kind: "folder", updatedAt: 1 },
		]);
		const [archivedId, foreignId, , movedId, renamedId, unrestrictedId, unsharedId, elsewhereId] = ids;
		await set_metadata(ids.slice(0, 7).map((id) => [id, STATUS]));
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
			await ctx.db.patch("files_nodes", renamedId!, {
				name: "a-renamed.md",
				sortName: files_sort_text_key("a-renamed.md"),
			});
			await ctx.db.patch("files_nodes", unrestrictedId!, { restrictedScopeNodeId: parent!.restrictedScopeNodeId });
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			const grant = grants.find((doc) => doc.resourceId === String(unsharedId));
			await ctx.db.delete("access_control_permission_grants", grant!._id);
		});

		// Dropped rows make a page short, so read each stream in one page.
		expect(await read_table(BY_STATUS, { filter: PRESENT, member, numItems: 10 })).toEqual(["kept.md"]);
		// A copy out of step with its node is a bug, so it is logged.
		expect(
			new Set(
				consoleError.mock.calls
					.filter(([message]) => message === "files_share_rows copy is mismatched")
					.map(([, data]) => (data as { nodeId: Id<"files_nodes"> }).nodeId),
			),
		).toEqual(new Set([archivedId, movedId, renamedId]));
	});

	test("every order but a custom-field filter gives a member no share rows", async () => {
		const { insert_children, add_member, grant_read, set_metadata, read_page, read_table } = await seed_folder_table();
		const ids = await insert_children([
			{ name: "open.md", kind: "file", updatedAt: 1 },
			{ name: "shared.md", kind: "file", updatedAt: 1, restricted: true },
		]);
		await set_metadata(ids.map((id) => [id, STATUS]));
		const member = await add_member("clerk_metadata_share", "member");
		await grant_read({ userId: member.userId }, [ids[1]!]);
		const read = (sort: typeof BY_NAME | typeof BY_STATUS, filter: files_table_Filter | null = null) =>
			read_page({ ...member, kind: "file", sort, filter, principalIndex: 0, paginationOpts: FIRST_PAGE });

		expect(await read(BY_NAME)).toEqual(REFUSED);
		expect(await read(BY_STATUS)).toEqual(REFUSED);
		expect(await read(BY_NAME, { kind: "name", field: "name", op: "starts_with", value: "s" })).toEqual(REFUSED);
		expect((await read(BY_STATUS, PRESENT)).page.map((row) => row.name)).toEqual(["shared.md"]);
		// The sort and the name order read the restricted twin instead.
		expect(await read_table(BY_STATUS, { member })).toEqual(["open.md", "shared.md"]);
		expect(await read_table(BY_NAME, { member })).toEqual(["open.md", "shared.md"]);
	});

	test("keeps a grant-only member's root table empty when a custom-field filter is applied", async () => {
		const { t, db, asOwner, parentId, add_member, grant_read, set_metadata } = await seed_folder_table();
		const member = await add_member("clerk_root_grant_only", null);
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: parentId }),
		).toEqual({ _yay: null });
		await set_metadata([[parentId, STATUS]]);
		await grant_read({ userId: member.userId }, [parentId]);
		const args = {
			membershipId: member.membershipId,
			parentId: "root" as const,
			kind: "folder" as const,
			sort: [BY_STATUS],
			filter: PRESENT,
			namePrefix: null,
			segment: "value" as const,
			paginationOpts: FIRST_PAGE,
		};

		const root = await member.as.query(api.files_tree.list_tree_children_shared, { ...args, principalIndex: 0 });
		expect(root, "A custom-field filter must not open the guest root table").toEqual(REFUSED);
		const shared = await member.as.query(api.files_tree.list_tree_shared_roots, {
			membershipId: member.membershipId,
			archived: false,
			principalIndex: 0,
			paginationOpts: FIRST_PAGE,
		});
		expect(
			shared.page.map((row) => row.name),
			"Shared with you still opens the shared folder",
		).toEqual(["table"]);
		// The member has no role, so no role stream.
		expect(await member.as.query(api.files_tree.list_tree_children_shared, { ...args, principalIndex: 1 })).toEqual(
			REFUSED,
		);
		// The sorted pages give this member nothing at the root.
		expect(await member.as.query(api.files_tree.list_tree_children_sorted, { ...args, restricted: false })).toEqual(
			REFUSED,
		);

		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_tree.list_tree_children_shared, {
				...args,
				membershipId: other.membershipId,
				parentId,
				principalIndex: 0,
			}),
		).toEqual(REFUSED);
	});

	test("refuses the owner, a missing role and every order but a custom-field filter before reading the folder", async () => {
		const { db, asOwner, parentId, add_member } = await seed_folder_table();
		const member = await add_member("clerk_shared_cheap_refusal", null);
		const base = {
			membershipId: member.membershipId,
			kind: "folder" as const,
			principalIndex: 0 as const,
			sort: [BY_STATUS] as Array<{ field: string; direction: "asc" | "desc" }>,
			filter: PRESENT as files_table_Filter | null,
			namePrefix: null,
			segment: "value" as const,
			paginationOpts: FIRST_PAGE,
		};
		const cases = [
			{ as: asOwner, args: { ...base, membershipId: db.membershipId } },
			// The member has no role, so no role stream.
			{ as: member.as, args: { ...base, principalIndex: 1 as const } },
			{ as: member.as, args: { ...base, filter: null } },
			{ as: member.as, args: { ...base, sort: [BY_NAME], filter: null } },
		];
		// The root has no folder to read, so a refusal at the folder costs the same only when it reads
		// no folder.
		const read_cost = (as: typeof asOwner, args: (typeof cases)[number]["args"], at: Id<"files_nodes"> | "root") =>
			as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_tree.list_tree_children_shared, { ...args, parentId: at });
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
	// runs before any row read, not the guard. The cost test below checks the guard number.
	test("a page whose end cursor holds more rows than it asks for asks for a split and reads no row", async () => {
		const { t, insert_children, add_member, grant_read, set_metadata, read_page } = await seed_folder_table();
		const names = Array.from({ length: 103 }, (_, index) => `n-${String(index).padStart(4, "0")}.md`);
		const ids = await insert_children(
			names.map((name) => ({ name, kind: "file" as const, updatedAt: 1, restricted: true })),
		);
		await set_metadata(ids.map((id) => [id, STATUS]));
		const member = await add_member("clerk_shared_split", "member");
		await grant_read({ userId: member.userId }, ids);
		const read = (paginationOpts: { numItems: number; cursor: string | null; endCursor?: string }) =>
			read_page({ ...member, kind: "file", sort: BY_STATUS, filter: PRESENT, principalIndex: 0, paginationOpts });

		// 100 rows and 2 more put the end cursor after row 102: one more than `numItems` + 1.
		const first = await read({ numItems: 100, cursor: null });
		const endCursor = (await read({ numItems: 2, cursor: first.continueCursor })).continueCursor;

		// A SYSTEM author makes the tree rows throw, so this page proves the guard runs before any row read.
		await t.run((ctx) => ctx.db.patch("files_nodes", ids[101]!, { createdBy: users_SYSTEM_AUTHOR }));
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
	// read check reads that grant, then the live membership lifetime, then the roles. A filter row
	// also reads its field doc.
	test.each([
		{ principalIndex: 0, oldPluginGrant: false },
		{ principalIndex: 2, oldPluginGrant: false },
		{ principalIndex: 2, oldPluginGrant: true },
	] as const)(
		"the share page guards fit the measured reads of the worst row (principal $principalIndex, old plugin grant $oldPluginGrant)",
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
						path: `/open/a-${index}.md`,
						kind: "file",
						scope: "self",
					});
					await files_metadata_db_write_entries(ctx, {
						fileNode: (await ctx.db.get("files_nodes", nodeId))!,
						entries: STATUS,
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
			const read_cost = (numItems: number, query: "filter" | "roots") =>
				f.asAdmin.run(async (ctx) => {
					const paginationOpts = { numItems, cursor: null };
					const before = await ctx.meta.getTransactionMetrics();
					const result =
						query === "filter"
							? await ctx.runQuery(api.files_tree.list_tree_children_shared, {
									membershipId: f.admin.membershipId,
									parentId: f.nodes.openId,
									kind: "file",
									principalIndex,
									sort: [BY_STATUS],
									filter: PRESENT,
									namePrefix: null,
									segment: "value",
									paginationOpts,
								})
							: await ctx.runQuery(api.files_tree.list_tree_shared_roots, {
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
			for (const [query, guard] of [
				["filter", 166],
				["roots", 176],
			] as const) {
				const one = await read_cost(1, query);
				const six = await read_cost(6, query);
				expect([one.rows, six.rows]).toEqual([1, 6]);
				const perRow = (six.ranges - one.ranges) / 5;
				expect(perRow).toBeGreaterThan(0);
				expect(guard).toBeLessThanOrEqual(Math.floor(3000 / perRow));
			}
		},
	);
});
