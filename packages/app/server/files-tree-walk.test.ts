import { getFunctionName, type FunctionReference } from "convex/server";
import { compareValues, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { access_control_db_ensure_role_assignment, type access_control_Subject } from "../convex/access_control.ts";
import { insert_installation, type Fixture } from "../convex/files_share_links.setup.test.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	create_bash_runner,
	default_organization_files,
	drain_scheduled_continuations,
	get_seeded_node_id,
} from "./bash.setup.test.ts";
import { files_pending_overlay_list, files_pending_overlay_search_name } from "./files-pending-overlay.ts";
import { files_saved_list_page } from "./files-saved-list.ts";
import {
	files_tree_walk_boundary_status,
	files_tree_walk_db_resolve_stack,
	files_tree_walk_MAX_CALLS,
	files_tree_walk_page,
	type files_tree_walk_Boundary,
	type files_tree_walk_Cursor,
	type files_tree_walk_FrameArgs,
} from "./files-tree-walk.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

type Row = { path: string; locked?: boolean };

const CHAIN_DEPTH = 500;

/**
 * A tree in memory. Each path is a node id. `root` is a restricted folder or file, `former` a former
 * root whose unrestrict job has not reached the items inside yet.
 */
function create_tree(
	spec: Array<{ path: string; folder?: boolean; root?: boolean; former?: boolean; createdAt?: number; id?: string }>,
	readable: Array<string | null>,
) {
	const tree_path = (item: (typeof spec)[number]) => (item.folder ? `${item.path}/` : item.path);
	const areas = spec.filter((item) => item.root || item.former);
	// The closest restricted folder above a path, or null.
	const area_above = (treePath: string) =>
		areas
			.filter((area) => area.folder && treePath !== tree_path(area) && treePath.startsWith(tree_path(area)))
			.sort((a, b) => b.path.length - a.path.length)
			.map((area) => area.id ?? area.path)[0] ?? null;
	const nodes = spec.map((item, index) => {
		const _id = item.id ?? item.path;
		const treePath = tree_path(item);
		const above = area_above(treePath);
		return {
			_id,
			_creationTime: item.createdAt ?? index,
			treePath,
			kind: item.folder ? "folder" : "file",
			restrictedScopeNodeId: item.root ? _id : above,
			extendedScopeNodeId: null,
			parentScopeNodeId: item.root || item.former ? above : undefined,
			archiveOperationId: null,
		} as unknown as Doc<"files_nodes">;
	});
	const byId = new Map(nodes.map((node) => [node._id as string, node]));
	const readableAreas = new Set(readable);
	const can = async (node: Doc<"files_nodes">) => readableAreas.has(node.restrictedScopeNodeId as string | null);

	// What the walk read: every stream call's area, and every row a rows stream returned.
	const calls: Array<{ stream: "rows" | "boundaries"; scopeNodeId: string | null }> = [];
	const rowsRead: string[] = [];
	const key = (node: Doc<"files_nodes">): Value[] => [node.treePath, node._creationTime, node._id];
	const page_of = (list: Doc<"files_nodes">[], frame: files_tree_walk_FrameArgs, numItems: number) => {
		const end = frame.kind === "folder" ? path_tree_prefix_upper_bound(frame.treePath) : `${frame.treePath}\u0000`;
		const matches = list
			.filter((node) => {
				if (node.treePath < frame.treePath || node.treePath >= end) return false;
				const order = compareValues(key(node).slice(0, frame.lower.key.length), frame.lower.key);
				return frame.lower.inclusive ? order >= 0 : order > 0;
			})
			.sort((a, b) => compareValues(key(a), key(b)));
		const page = matches.slice(0, numItems);
		return {
			page,
			frontier: page.length > 0 ? key(page.at(-1)!) : null,
			phaseCount: 1,
			isDone: page.length === matches.length,
		};
	};
	return {
		calls,
		rowsRead,
		rows: async (frame: files_tree_walk_FrameArgs, numItems: number) => {
			calls.push({ stream: "rows", scopeNodeId: frame.scopeNodeId });
			const { page, ...rest } = page_of(
				nodes.filter((node) => node.restrictedScopeNodeId === frame.scopeNodeId),
				frame,
				numItems,
			);
			rowsRead.push(...page.map((node) => node._id));
			return { ...rest, items: page.map((node) => ({ key: key(node), value: { path: node._id } as Row })) };
		},
		boundaries: async (frame: files_tree_walk_FrameArgs, numItems: number) => {
			calls.push({ stream: "boundaries", scopeNodeId: frame.scopeNodeId });
			const { page, ...rest } = page_of(
				nodes.filter((node) => node.parentScopeNodeId !== undefined && node.parentScopeNodeId === frame.scopeNodeId),
				frame,
				numItems,
			);
			const items = [];
			for (const node of page) {
				const status = await files_tree_walk_boundary_status(node, can);
				const value: files_tree_walk_Boundary<Row> = {
					node,
					status,
					row: status === "locked" ? { path: node._id, locked: true } : null,
					path: node._id,
				};
				items.push({ key: key(node), value });
			}
			return { ...rest, items };
		},
		resolve_stack: (top: { nodeId: Id<"files_nodes">; treePath: string }) =>
			files_tree_walk_db_resolve_stack({
				get_node: async (nodeId) => byId.get(nodeId) ?? null,
				can,
				start: { scopeNodeId: null, treePath: "/" },
				top,
			}),
		move: (nodeId: string, treePath: string) => {
			Object.assign(byId.get(nodeId)!, { treePath });
		},
	};
}

/**
 * Every page of the walk from the root, as listed paths and "denied <path>" lines.
 */
async function walk_all(tree: ReturnType<typeof create_tree>, numItems: number, maxCalls?: number) {
	const listed: string[] = [];
	const cursors: Array<files_tree_walk_Cursor | null> = [];
	let cursor: files_tree_walk_Cursor | null = null;
	for (let page = 0; page < 1_000; page++) {
		const result: Awaited<ReturnType<typeof files_tree_walk_page<Row>>> = await files_tree_walk_page<Row>({
			start: { scopeNodeId: null, treePath: "/", kind: "folder", withRoot: false },
			// Each page starts from the cursor as JSON, like the API and Bash keep it.
			cursor: cursor && (JSON.parse(JSON.stringify(cursor)) as files_tree_walk_Cursor),
			numItems,
			maxCalls,
			rows: [tree.rows],
			boundaries: [tree.boundaries],
			resolve_stack: tree.resolve_stack,
		});
		for (const entry of result.entries) {
			if (entry.row) listed.push(entry.row.locked ? `${entry.row.path} (locked)` : entry.row.path);
			if (entry.denied !== null) listed.push(`denied ${entry.denied}`);
		}
		cursors.push(result.cursor);
		cursor = result.cursor;
		if (!cursor) return { listed, cursors };
	}
	throw new Error("The walk did not end");
}

/**
 * An action ctx whose queries each run alone and record their reads, like Convex counts them.
 */
function metered_ctx(t: ReturnType<typeof test_convex>) {
	const calls: Array<{ name: string; ranges: number; documents: number }> = [];
	const ctx = {
		runQuery: (query: FunctionReference<"query">, args: Record<string, unknown>) =>
			t.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(query, args);
				const after = await ctx.meta.getTransactionMetrics();
				calls.push({
					name: getFunctionName(query),
					ranges: after.databaseQueries.used - before.databaseQueries.used,
					documents: after.documentsRead.used - before.documentsRead.used,
				});
				return result;
			}),
	} as unknown as Pick<ActionCtx, "runQuery">;
	return { ctx, calls };
}

describe("files_tree_walk_page", () => {
	test("the walk reads no row under a locked folder", async () => {
		const tree = create_tree(
			[
				{ path: "/a.md" },
				{ path: "/Team", folder: true, root: true },
				{ path: "/Team/plan.md" },
				// Readable on its own, but the walk never gets past /Team to see it.
				{ path: "/Team/Open", folder: true, root: true },
				{ path: "/Team/Open/x.md" },
				{ path: "/z.md" },
			],
			[null, "/Team/Open"],
		);

		const { listed } = await walk_all(tree, 50);

		expect(tree.rowsRead).not.toContain("/Team/plan.md");
		expect(tree.calls.map((call) => call.scopeNodeId)).not.toContain("/Team");
		expect(tree.calls.map((call) => call.scopeNodeId)).not.toContain("/Team/Open");
		// Uppercase letters sort first, so /Team comes before /a.md.
		expect(listed).toEqual(["/Team (locked)", "denied /Team", "/a.md", "/z.md"]);
	});

	test("a readable boundary is listed once and the cursor resumes inside nested folders", async () => {
		const tree = create_tree(
			[
				{ path: "/a", folder: true, root: true },
				{ path: "/a/1.md" },
				{ path: "/a/b", folder: true, root: true },
				{ path: "/a/b/2.md" },
				{ path: "/a/b/3.md" },
				{ path: "/a/c.md" },
				{ path: "/d.md" },
			],
			[null, "/a", "/a/b"],
		);
		const expected = ["/a", "/a/1.md", "/a/b", "/a/b/2.md", "/a/b/3.md", "/a/c.md", "/d.md"];

		for (const numItems of [1, 2, 3, 50]) {
			const { listed, cursors } = await walk_all(tree, numItems);
			expect(listed, `${numItems} per page`).toEqual(expected);
			if (numItems === 1) expect(cursors.some((cursor) => cursor?.top?.nodeId === "/a/b")).toBe(true);
		}
	});

	test("two rows with the same treePath order by createdAt and node id", async () => {
		const tree = create_tree(
			[
				{ path: "/same.md", id: "b", createdAt: 2 },
				{ path: "/same.md", id: "c", createdAt: 1 },
				{ path: "/same.md", id: "a", createdAt: 2 },
			],
			[null],
		);

		expect((await walk_all(tree, 1)).listed).toEqual(["c", "a", "b"]);
	});

	test("a former root during unrestrict is walked like its parent and is listed once", async () => {
		const spec = [{ path: "/Old", folder: true, former: true }, { path: "/Old/note.md" }, { path: "/z.md" }];

		// Its own row is in the open area, so it comes after its old area's rows.
		expect((await walk_all(create_tree(spec, [null, "/Old"]), 1)).listed).toEqual(["/Old/note.md", "/Old", "/z.md"]);
		// Its old area stays closed, with no "Permission denied" line: its own row is in the open area.
		expect((await walk_all(create_tree(spec, [null]), 50)).listed).toEqual(["/Old", "/z.md"]);
	});

	test("a broken frame chain answers an invalid cursor", async () => {
		const tree = create_tree(
			[{ path: "/a", folder: true, root: true }, { path: "/a/1.md" }, { path: "/a/2.md" }],
			[null, "/a"],
		);
		const first = await files_tree_walk_page<Row>({
			start: { scopeNodeId: null, treePath: "/", kind: "folder", withRoot: false },
			cursor: null,
			numItems: 2,
			rows: [tree.rows],
			boundaries: [tree.boundaries],
			resolve_stack: tree.resolve_stack,
		});
		expect(first.cursor?.top).toEqual({ nodeId: "/a", treePath: "/a/" });

		// A rename of the frame folder between pages.
		tree.move("/a", "/renamed/");
		await expect(
			files_tree_walk_page<Row>({
				start: { scopeNodeId: null, treePath: "/", kind: "folder", withRoot: false },
				cursor: first.cursor,
				numItems: 2,
				rows: [tree.rows],
				boundaries: [tree.boundaries],
				resolve_stack: tree.resolve_stack,
			}),
		).rejects.toThrow("The folder changed since the last page. Run the command again.");
	});

	test("a page stops at the call cap and the next page goes on", async () => {
		const spec = Array.from({ length: 20 }, (_, index) => [
			{ path: `/f${String(index).padStart(2, "0")}`, folder: true, root: true },
			{ path: `/f${String(index).padStart(2, "0")}/x.md` },
		]).flat();
		const tree = create_tree(spec, [null, ...spec.filter((item) => item.root).map((item) => item.path)]);

		const capped = await walk_all(tree, 50, 6);
		const full = await walk_all(tree, 50, 1_000);

		expect(full.cursors).toHaveLength(1);
		expect(capped.cursors.length).toBeGreaterThan(1);
		expect(capped.listed).toEqual(full.listed);
		expect(full.listed).toHaveLength(40);
	});
});

describe("the walk at 500 levels", () => {
	/**
	 * A chain of 500 nested restricted folders `/a/a/...`, each with a file `x` and its own user grant
	 * for a member, so each boundary check reads grants.
	 */
	async function seed_chain() {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return userId;
		});
		let parent: Doc<"files_nodes"> | null = null;
		for (let start = 0; start < CHAIN_DEPTH; start += 50) {
			parent = await t.run(async (ctx) => {
				let above = parent;
				for (let depth = start + 1; depth <= Math.min(start + 50, CHAIN_DEPTH); depth++) {
					const path = `${above?.path ?? ""}/a`;
					const base = {
						...test_mocks.files.base(),
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						createdBy: db.userId,
						updatedBy: db.userId,
						pathDepth: depth,
					};
					const folderId = await ctx.db.insert("files_nodes", {
						...base,
						parentId: above?._id ?? "root",
						name: "a",
						sortName: files_sort_text_key("a"),
						path,
						treePath: `${path}/`,
					});
					await ctx.db.patch("files_nodes", folderId, {
						isRestrictedScopeRoot: true,
						restrictedScopeNodeId: folderId,
						parentScopeNodeId: above?._id ?? null,
					});
					await ctx.db.insert("files_nodes", {
						...base,
						parentId: folderId,
						name: "x",
						sortName: files_sort_text_key("x"),
						kind: "file",
						path: `${path}/x`,
						treePath: `${path}/x`,
						pathDepth: depth + 1,
						restrictedScopeNodeId: folderId,
					});
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						resourceKind: "file",
						resourceId: String(folderId),
						principalKind: "user",
						userId: member,
						permission: "content.read",
						createdAt: 1,
						updatedAt: 1,
					});
					above = (await ctx.db.get("files_nodes", folderId))!;
				}
				return above;
			});
		}
		const { ctx, calls } = metered_ctx(t);
		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: member,
			subject: { kind: "user" as const, userId: member, plugin: null },
			folderPath: "/",
		};
		return { t, db, deepest: parent!, ctx, calls, args };
	}

	test("a walk through 500 nested restricted folders stays under the limits", async () => {
		const { ctx, calls, args } = await seed_chain();

		const paths: string[] = [];
		const cursorLengths: number[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 200; page++) {
			const result = await files_pending_overlay_list(ctx, {
				...args,
				mode: "subtree",
				order: "asc",
				numItems: 50,
				cursor,
			});
			if (result._nay) throw new Error(result._nay.message);
			paths.push(...result._yay.items.map((item) => item.path));
			cursor = result._yay.continueCursor;
			if (cursor === null) break;
			cursorLengths.push(cursor.length);
		}

		expect(cursor, "the walk ends").toBeNull();
		expect(paths).toHaveLength(2 * CHAIN_DEPTH);
		expect(new Set(paths).size).toBe(2 * CHAIN_DEPTH);
		const worst = (name: string) => Math.max(...calls.filter((call) => call.name === name).map((call) => call.ranges));
		console.info(
			"Walk cost at 500 levels",
			JSON.stringify({
				pages: cursorLengths.length + 1,
				calls: calls.length,
				maxCursorLength: Math.max(...cursorLengths),
				rows: worst("files_visible:internal_list_subtree_saved"),
				boundaries: worst("files_visible:internal_list_subtree_boundaries"),
				start: worst("files_visible:internal_get_walk_start"),
				stack: worst("files_visible:internal_resolve_walk_stack"),
			}),
		);
		expect(Math.max(...calls.map((call) => call.ranges)), "each stream call and the stack rebuild").toBeLessThan(3_000);
		// The Bash cursor is stored as is. The API seals it in base64, about 4/3 longer.
		expect(Math.max(...cursorLengths) * (4 / 3) + 200).toBeLessThan(16_384);
	}, 300_000);

	test("a name search under 500 boundaries stays under the limits", async () => {
		const { ctx, calls, args } = await seed_chain();

		const items = [];
		for (let cursor: string | null = null, page = 0; page < 100; page++) {
			const result = await files_pending_overlay_search_name(ctx, { ...args, query: "x", numItems: 1_000, cursor });
			if (result._nay) throw new Error(result._nay.message);
			items.push(...result._yay.items);
			cursor = result._yay.continueCursor;
			if (cursor === null) break;
		}

		console.info(
			"Name search cost at 500 levels",
			JSON.stringify({ calls: calls.length, maxRanges: Math.max(...calls.map((call) => call.ranges)) }),
		);
		expect(items).toHaveLength(CHAIN_DEPTH);
		expect(Math.max(...calls.map((call) => call.ranges))).toBeLessThan(3_000);
	}, 300_000);

	test("a page makes at most 64 stream calls and reads the start and the stack once", async () => {
		const { ctx, calls, args } = await seed_chain();
		const page = async (cursor: string | null) => {
			const before = calls.length;
			const result = await files_pending_overlay_list(ctx, {
				...args,
				mode: "subtree",
				order: "asc",
				numItems: 1_000,
				cursor,
			});
			if (result._nay) throw new Error(result._nay.message);
			const names = calls.slice(before).map((call) => call.name);
			const count = (name: string) => names.filter((called) => called === `files_visible:${name}`).length;
			return { cursor: result._yay.continueCursor, count };
		};

		const first = await page(null);
		const second = await page(first.cursor);

		for (const [index, { count }] of [first, second].entries()) {
			expect(
				count("internal_list_subtree_saved") + count("internal_list_subtree_boundaries"),
				`stream calls of page ${index + 1}`,
			).toBeLessThanOrEqual(files_tree_walk_MAX_CALLS);
			expect(count("internal_get_walk_start"), `start calls of page ${index + 1}`).toBe(1);
		}
		expect(first.count("internal_resolve_walk_stack"), "the first page has no stack").toBe(0);
		expect(second.count("internal_resolve_walk_stack"), "the next page rebuilds its stack once").toBe(1);
		expect(second.cursor).not.toBeNull();
	}, 300_000);

	test("a list from the deepest folder stays under the limits, for a member and a plugin", async () => {
		const { t, db, deepest, ctx, calls, args } = await seed_chain();
		const installationId = await insert_installation({ t, db } as unknown as Fixture);
		const subjects = {
			member: args.subject,
			// The sandbox check reads its roots and the folder's chain.
			plugin: {
				...args.subject,
				plugin: {
					installationId,
					roots: [{ target: { kind: "folder" as const, nodeId: deepest._id }, level: "read" as const }],
				},
			},
		};

		for (const [name, subject] of Object.entries(subjects)) {
			calls.length = 0;
			const result = await files_pending_overlay_list(ctx, {
				...args,
				subject,
				folderPath: deepest.path,
				mode: "subtree",
				order: "asc",
				numItems: 50,
				cursor: null,
			});
			if (result._nay) throw new Error(result._nay.message);
			expect(
				result._yay.items.map((item) => item.path),
				name,
			).toEqual([`${deepest.path}/x`]);
			const worst = (query: string) =>
				Math.max(...calls.filter((call) => call.name === `files_visible:${query}`).map((call) => call.ranges));
			console.info(
				`List from the deepest folder for a ${name}`,
				JSON.stringify({ start: worst("internal_get_walk_start"), rows: worst("internal_list_subtree_saved") }),
			);
			expect(Math.max(...calls.map((call) => call.ranges)), name).toBeLessThan(3_000);
		}
	}, 300_000);
});

describe("a caller who cannot open the root", () => {
	/**
	 * The owner restricts `/docs`. The guest has no workspace role, so they cannot open the root, and
	 * `share` adds them to one folder.
	 */
	async function seed_guest() {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "walk-guest", workspaceName: "home" }),
		);
		const owner = await create_bash_runner({ shared: { t, seeded }, extraFiles: default_organization_files });
		const guestId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "walk-guest" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			return userId;
		});
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", subject: "walk-owner", external_id: seeded.userId });
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: seeded.membershipId,
			nodeId: await get_seeded_node_id(owner, "/docs"),
		});
		expect(restricted._nay).toBeUndefined();
		await drain_scheduled_continuations(owner);
		const share = async (path: string) => {
			const shared = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: seeded.membershipId,
				nodeId: await get_seeded_node_id(owner, path),
				principal: { kind: "user", userId: guestId },
				level: "read",
			});
			expect(shared._nay).toBeUndefined();
			await drain_scheduled_continuations(owner);
		};
		const ctx = {
			runQuery: (query: FunctionReference<"query">, args: Record<string, unknown>) =>
				t.action((ctx) => ctx.runQuery(query, args)),
		} as unknown as Pick<ActionCtx, "runQuery">;
		const as_user = (userId: Id<"users">) => ({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: userId,
			subject: { kind: "user" as const, userId, plugin: null },
		});
		return { t, seeded, ctx, guest: as_user(guestId), share };
	}

	test("the API list of the root is Permission denied for a guest or an account", async () => {
		const { t, seeded, ctx, guest, share } = await seed_guest();
		await share("/docs");
		const list = (args: Omit<Parameters<typeof files_saved_list_page>[1], "cursorScope" | "numItems" | "cursor">) =>
			files_saved_list_page(ctx, { ...args, cursorScope: "test", numItems: 100, cursor: null, minDepth: 1 });
		const paths = (listed: Awaited<ReturnType<typeof files_saved_list_page>>) =>
			listed._yay!.page.map((node) => `${node.path}${node.locked ? " (locked)" : ""}`);
		const denied = { _nay: { name: "folder_locked", message: "Permission denied: /" } };

		// The guest cannot open the root, so a direct or recursive list of it is locked. The shared
		// folder lists by its own path.
		expect(await list({ ...guest, folderPath: "/" })).toEqual(denied);
		expect(await list({ ...guest, folderPath: "/", maxDepth: 1, withLocked: true })).toEqual(denied);
		expect(paths(await list({ ...guest, folderPath: "/docs" }))).toEqual([
			"/docs/nested",
			"/docs/nested/deep.md",
			"/docs/readme.md",
			"/docs/tutorial.md",
		]);

		const serviceAccountId = await t.run((ctx) =>
			ctx.db.insert("access_control_service_accounts", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				name: "No grant",
				createdBy: seeded.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			}),
		);
		const account = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			subject: { kind: "service_account" as const, serviceAccountId },
		};
		expect(await list({ ...account, folderPath: "/" })).toEqual(denied);
	});

	test("the Bash walk of the root is Permission denied for a guest", async () => {
		const { ctx, guest, share } = await seed_guest();
		await share("/docs");

		// What `ls -R`, `find` and `tree` read: the user's own overlay.
		const list = (folderPath: string) =>
			files_pending_overlay_list(ctx, {
				...guest,
				overlayUserId: guest.visibilityUserId,
				folderPath,
				mode: "subtree",
				order: "asc",
				numItems: 100,
				cursor: null,
			});
		expect(await list("/")).toEqual({ _nay: { name: "permission_denied", message: "Permission denied" } });
		const listed = await list("/docs");
		if (listed._nay) throw new Error(listed._nay.message);
		expect(listed._yay.items.map((item) => `${item.path}${item.locked ? " (locked)" : ""}`)).toEqual([
			"/docs/nested",
			"/docs/nested/deep.md",
			"/docs/readme.md",
			"/docs/tutorial.md",
		]);
	});

	test("a name search finds a file a guest reads through Add people only from inside", async () => {
		const { ctx, guest, share } = await seed_guest();
		await share("/docs/nested");

		const search = async (folderPath: string) => {
			const found = await files_pending_overlay_search_name(ctx, {
				...guest,
				overlayUserId: guest.visibilityUserId,
				folderPath,
				query: "deep",
				numItems: 50,
				cursor: null,
			});
			if (found._nay) throw new Error(found._nay.message);
			return found._yay.items.map((item) => item.path);
		};
		expect(await search("/docs/nested")).toEqual(["/docs/nested/deep.md"]);
		// The guest cannot open the root, so a search from it is Permission denied.
		await expect(search("/")).rejects.toThrow("Permission denied");
	});
});

describe("the walk on a real database", () => {
	/**
	 * The owner restricts `/docs` and does not share it. The member reads the rest of the workspace.
	 */
	async function seed_team(extraFiles: typeof default_organization_files = []) {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "walk-db", workspaceName: "home" }),
		);
		const ownerRunner = await create_bash_runner({
			shared: { t, seeded },
			extraFiles: [...default_organization_files, ...extraFiles],
		});
		const memberId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "walk-db-member" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return userId;
		});
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "walk-db-owner",
			external_id: seeded.userId,
		});
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: seeded.membershipId,
			nodeId: await get_seeded_node_id(ownerRunner, "/docs"),
		});
		expect(restricted._nay).toBeUndefined();
		// The scope job moves every item inside /docs into its area, a batch per round.
		for (let round = 0; round < 4; round++) await drain_scheduled_continuations(ownerRunner);
		const share = async (path: string) => {
			const shared = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: seeded.membershipId,
				nodeId: await get_seeded_node_id(ownerRunner, path),
				principal: { kind: "user", userId: memberId },
				level: "read",
			});
			expect(shared._nay).toBeUndefined();
			await drain_scheduled_continuations(ownerRunner);
		};
		const { ctx, calls } = metered_ctx(t);
		const as_user = (userId: Id<"users">) => ({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: userId,
			subject: { kind: "user" as const, userId, plugin: null } as access_control_Subject,
		});
		const list = async (
			who: ReturnType<typeof as_user>,
			args: Partial<Parameters<typeof files_pending_overlay_list>[1]> = {},
		) => {
			const listed = await files_pending_overlay_list(ctx, {
				...who,
				folderPath: "/",
				mode: "subtree",
				order: "asc",
				numItems: 500,
				cursor: null,
				...args,
			});
			if (listed._nay) throw new Error(listed._nay.message);
			return {
				paths: listed._yay.items.map((item) => `${item.path}${item.locked ? " (locked)" : ""}`),
				denied: listed._yay.denied ?? [],
			};
		};
		return {
			t,
			seeded,
			ownerRunner,
			calls,
			share,
			list,
			owner: as_user(seeded.userId),
			member: as_user(memberId),
		};
	}
	/** 200 files in /docs/many and one open file, each with `topic: atlas`. */
	async function seed_many() {
		const atlas = "---\ntopic: atlas\n---\n";
		const seeded = await seed_team([
			{ path: "/atlas.md", content: atlas },
			{ path: "/docs/many", kind: "folder" },
			...Array.from({ length: 200 }, (_, index) => ({
				path: `/docs/many/f${String(index).padStart(3, "0")}.md`,
				content: atlas,
			})),
		]);
		const documents = (name: string) =>
			seeded.calls
				.filter((call) => call.name === `files_visible:${name}`)
				.reduce((sum, call) => sum + call.documents, 0);
		return { ...seeded, documents };
	}

	// The read counts come first: the check of each row would hide the files too.
	test("a list reads no row under a locked folder", async () => {
		const { list, member, documents } = await seed_many();

		const listed = await list(member);

		expect(documents("internal_list_subtree_saved"), "the list reads none of the 200 files").toBeLessThan(200);
		expect(listed).toEqual({
			paths: ["/atlas.md", "/docs (locked)", "/reports", "/reports/summary.md", "/source.pdf", "/uploaded.md"],
			denied: ["/docs"],
		});
	}, 120_000);

	test("a metadata search reads no value under a locked folder", async () => {
		const { list, member, documents } = await seed_many();

		const found = await list(member, {
			mode: "metadata",
			plan: { op: "eq", fieldPath: "frontmatter.topic", value: "atlas" },
		});

		expect(documents("internal_search_metadata_saved"), "the search reads none of the 200 values").toBeLessThan(200);
		expect(found.paths).toEqual(["/atlas.md"]);
	}, 120_000);

	test("a draft delete of a big folder is skipped in one read", async () => {
		const { ownerRunner, calls, list, owner } = await seed_team([
			{ path: "/big", kind: "folder" },
			...Array.from({ length: 300 }, (_, index) => ({
				path: `/big/f${String(index).padStart(3, "0")}.md`,
				content: "x",
			})),
		]);
		expect((await ownerRunner.run({ command: "rm -r /home/cloud-usr/w/walk-db/home/big" })).metadata.exitCode).toBe(0);
		calls.length = 0;

		// Small pages, so each read of rows under /big would take 10 of its 300 files.
		const listed = await list(owner, { overlayUserId: owner.visibilityUserId, numItems: 10 });

		const reads = calls.filter((call) => call.name === "files_visible:internal_list_subtree_saved").length;
		console.info("Saved row reads past a draft delete", JSON.stringify({ reads }));
		expect(reads, "the walk goes on after /big, not 10 rows at a time").toBeLessThanOrEqual(4);
		expect(listed.paths).toEqual([
			"/docs",
			"/docs/nested",
			"/docs/nested/deep.md",
			"/docs/readme.md",
			"/docs/tutorial.md",
			"/reports",
			"/reports/summary.md",
			"/source.pdf",
			"/uploaded.md",
		]);
	}, 120_000);

	test("the kind filter lists only files and keeps the denied line", async () => {
		const { list, member } = await seed_team();

		expect(await list(member, { kind: "file" })).toEqual({
			paths: ["/reports/summary.md", "/source.pdf", "/uploaded.md"],
			denied: ["/docs"],
		});
	});

	test("a row the scope job has not moved yet stays hidden under a locked folder", async () => {
		const { t, ownerRunner, list, member } = await seed_team();
		// Like a scope job that has not reached this file yet: it is still in the open area.
		const readmeId = await get_seeded_node_id(ownerRunner, "/docs/readme.md");
		await t.run((ctx) => ctx.db.patch("files_nodes", readmeId, { restrictedScopeNodeId: null }));

		const listed = await list(member);

		expect(listed.paths).toEqual(["/docs (locked)", "/reports", "/reports/summary.md", "/source.pdf", "/uploaded.md"]);
		expect(listed.denied).toEqual(["/docs"]);
	});

	test("the owner lists every row, with no locked row and no denied line", async () => {
		const { list, owner } = await seed_team();

		expect(await list(owner)).toEqual({
			paths: [
				"/docs",
				"/docs/nested",
				"/docs/nested/deep.md",
				"/docs/readme.md",
				"/docs/tutorial.md",
				"/reports",
				"/reports/summary.md",
				"/source.pdf",
				"/uploaded.md",
			],
			denied: [],
		});
	});

	test("a reader added to a folder inside a locked one lists it only from inside", async () => {
		const { share, list, member } = await seed_team();
		await share("/docs/nested");

		expect(await list(member, { folderPath: "/docs/nested" })).toEqual({ paths: ["/docs/nested/deep.md"], denied: [] });
		const fromRoot = await list(member);
		expect(fromRoot.paths).not.toContain("/docs/nested/deep.md");
		expect(fromRoot.denied).toEqual(["/docs"]);
	});

	test("a plugin lists only its sandbox, and the root above its roots is Permission denied", async () => {
		const { t, seeded, ownerRunner, list, member } = await seed_team();
		const installationId = await insert_installation({ t, db: seeded } as unknown as Fixture);
		const reportsId = await get_seeded_node_id(ownerRunner, "/reports");
		const plugin = {
			...member,
			subject: {
				kind: "user" as const,
				userId: member.visibilityUserId,
				plugin: {
					installationId,
					roots: [{ target: { kind: "folder" as const, nodeId: reportsId }, level: "read" as const }],
				},
			},
		};

		// The root is above the plugin's roots, so it is locked (Landlock behavior).
		await expect(list(plugin)).rejects.toThrow("Permission denied");
		expect(await list(plugin, { folderPath: "/reports" })).toEqual({ paths: ["/reports/summary.md"], denied: [] });
	});

	test("find -mmin in a plugin's sandbox inside an area reads no row outside it", async () => {
		const now = Date.now();
		const { t, seeded, ownerRunner, calls, list, member } = await seed_team(
			Array.from({ length: 100 }, (_, index) => ({ path: `/r-${index}.md`, updatedAt: now - 60_000 })),
		);
		const installationId = await insert_installation({ t, db: seeded } as unknown as Fixture);
		const reportsId = await get_seeded_node_id(ownerRunner, "/reports");
		const plugin = {
			...member,
			subject: {
				kind: "user" as const,
				userId: member.visibilityUserId,
				plugin: {
					installationId,
					roots: [{ target: { kind: "folder" as const, nodeId: reportsId }, level: "read" as const }],
				},
			},
		};
		calls.length = 0;

		const listed = await list(plugin, { folderPath: "/reports", updated: { from: now - 3_600_000, to: null } });

		const rows = calls
			.filter((call) => call.name === "files_visible:internal_list_subtree_recent_saved")
			.reduce((sum, call) => sum + call.documents, 0);
		expect(rows, "the per-folder read skips the 100 recent rows outside the sandbox").toBeLessThan(50);
		expect(listed).toEqual({ paths: ["/reports/summary.md"], denied: [] });
	});
});
