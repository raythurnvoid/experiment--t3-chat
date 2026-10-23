import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import type { files_table_Filter } from "../shared/files-table.ts";
import { files_metadata_db_write_entries } from "./files_metadata_db.ts";
import { insert_tree_node, seed_tree_access_fixture, seed_folder_table } from "./files_nodes.setup.test.ts";
import type { files_DirectoryView } from "../shared/files.ts";

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
	const REFUSED = { page: [], isDone: true, continueCursor: "", directoryView: null };
	const BY_NAME = { field: "name", direction: "asc" } as const;
	const FIRST_PAGE = { numItems: 10, cursor: null };
	// The share streams serve only custom-field filters. `present` is in value order, so its share rows
	// come after the open rows, by name.
	const PRESENT = { kind: "text", field: "metadata.status", op: "present" } as const satisfies files_table_Filter;
	const BY_STATUS = { field: "metadata.status", direction: "asc" } as const;
	const STATUS = [{ key: "status", value: "open" }];

	test("shared metadata rows keep the Move view and check folder access on each page", async () => {
		vi.useFakeTimers();
		try {
			const f = await seed_folder_table();
			const ids = await f.insert_children(
				["a.md", "b.md", "c.md"].map((name) => ({ name, kind: "file" as const, updatedAt: 1, restricted: true })),
			);
			await f.set_metadata(ids.map((id) => [id, STATUS]));
			const member = await f.add_member("clerk_shared_move_pages", null);
			await f.grant_read({ userId: member.userId }, ids);
			expect(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId: f.parentId,
					principal: { kind: "user", userId: member.userId },
					level: "read",
				}),
			).toEqual({ _yay: null });
			await f.t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
			const normal = await f.read_page({
				...member, kind: "file", sort: BY_STATUS, filter: PRESENT, principalIndex: 0, paginationOpts: FIRST_PAGE,
			});
			expect(normal.page.map((row) => row._id), "the member can read shared metadata before Move").toEqual(ids);
			const destination = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.db.membershipId,
				parentId: "root",
				path: "/destination",
			});
			if (destination._nay) throw new Error(destination._nay.message);
			// Keep real worker steps separate so both saved views can be read before repair.
			const overlay = await import("../server/files-pending-overlay.ts");
			vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
			const started = await f.asOwner.mutation(api.files_transfer.accept_input, {
				membershipId: f.db.membershipId,
				requestId: "shared-metadata-move",
				kind: "move",
				expectedSourceCount: 1,
				sourceIds: [f.parentId],
				targetParentId: destination._yay.nodeId,
			});
			if (started._nay) throw new Error(started._nay.message);
			const readCohort = () => f.t.run((ctx) =>
				ctx.db.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", started._yay.runId))
					.unique(),
			);
			for (let step = 0; step < 100; step++) {
				const cohort = await readCohort();
				if (cohort?.workPhase === "publish") break;
				if (!cohort) await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
				else
					await f.t.mutation(internal.files_move_cohorts.advance, {
						cohortId: cohort._id,
						step: cohort.step,
						runGeneration: cohort.runJob?.generation ?? null,
						join: false,
					});
			}
			const cohort = await readCohort();
			expect(cohort, "the public Move stages real metadata and share rows before publication").toMatchObject({
				workPhase: "publish", visibleView: "before",
			});
			if (!cohort) throw new Error("Expected the Move cohort");
			const read = (owner: boolean, pageView?: files_DirectoryView, cursor: string | null = null) => {
				const args = {
					membershipId: owner ? f.db.membershipId : member.membershipId,
					parentId: f.parentId,
					stream: "cohort" as const,
					pageView,
					kind: "file" as const,
					sort: [BY_STATUS],
					filter: PRESENT,
					namePrefix: null,
					segment: "value" as const,
					paginationOpts: { cursor, numItems: 1 },
				};
				return owner
					? f.asOwner.query(api.files_tree.list_tree_children_sorted, { ...args, restricted: true })
					: member.as.query(api.files_tree.list_tree_children_shared, { ...args, principalIndex: 0 });
			};
			for (const view of ["before", "after"] as const) {
				if (view === "after")
					await f.t.mutation(internal.files_move_cohorts.advance, {
						cohortId: cohort._id,
						step: cohort.step,
						runGeneration: cohort.runJob?.generation ?? null,
						join: false,
					});
				const expectedView = { cohortId: cohort._id, view };
				for (const owner of [false, true]) {
					const first = await read(owner);
					expect(
						first.page.map((row) => [row._id, row.path]), "the selected metadata stream returns a real saved row",
					).toEqual([[ids[0], `${view === "before" ? "" : "/destination"}/table/a.md`]]);
					expect(
						first.directoryView, "nonempty shared and restricted metadata pages use the selected directory tag",
					).toEqual(expectedView);
					expect(first.isDone, "the access check starts from a real continuation").toBe(false);
					const next = await read(owner, first.directoryView, first.continueCursor);
					expect(next.directoryView).toEqual(expectedView);
					expect(
						next.page.map((row) => row._id), "matching tagged continuations reach another metadata row",
					).toEqual([ids[1]]);
				}
			}
			const first = await read(false);
			expect(
				await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId: f.parentId,
					principal: { kind: "user", userId: member.userId },
				}),
			).toEqual({ _yay: null });
			const refused = await read(false, first.directoryView, first.continueCursor);
			expect(refused, "a continuation cannot reuse folder access removed after its first page").toEqual(REFUSED);
		} finally {
			vi.useRealTimers();
		}
	});

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

		const root = await member.as.query(api.files_tree.list_tree_children_shared, {
			stream: "normal" as const,
			...args,
			principalIndex: 0,
		});
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
		expect(
			await member.as.query(api.files_tree.list_tree_children_shared, {
				stream: "normal" as const,
				...args,
				principalIndex: 1,
			}),
		).toEqual(REFUSED);
		// The sorted pages give this member nothing at the root.
		expect(
			await member.as.query(api.files_tree.list_tree_children_sorted, {
				stream: "normal" as const,
				...args,
				restricted: false,
			}),
		).toEqual(REFUSED);

		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_tree.list_tree_children_shared, {
				stream: "normal" as const,
				...args,
				membershipId: other.membershipId,
				parentId,
				principalIndex: 0,
			}),
		).toEqual(REFUSED);
	});

	test("tags empty owner, missing-role and unsupported-order streams with fixed folder reads", async () => {
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
			{ as: asOwner, args: { ...base, membershipId: db.membershipId }, extraRanges: 2 },
			// The member has no role, so no role stream.
			{ as: member.as, args: { ...base, principalIndex: 1 as const }, extraRanges: 5 },
			{ as: member.as, args: { ...base, filter: null }, extraRanges: 5 },
			{ as: member.as, args: { ...base, sort: [BY_NAME], filter: null }, extraRanges: 5 },
		];
		// Empty streams still check the folder and select its directory view.
		const read_cost = (as: typeof asOwner, args: (typeof cases)[number]["args"], at: Id<"files_nodes"> | "root") =>
			as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_tree.list_tree_children_shared, {
					stream: "normal" as const,
					...args,
					parentId: at,
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		for (const { as, args, extraRanges } of cases) {
			const atRoot = await read_cost(as, args, "root");
			const atFolder = await read_cost(as, args, parentId);
			expect([atRoot.result, atFolder.result]).toEqual([REFUSED, REFUSED]);
			expect(atFolder.ranges - atRoot.ranges).toBe(extraRanges);
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
			directoryView: null,
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
									stream: "normal" as const,
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
