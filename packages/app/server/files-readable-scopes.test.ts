import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import {
	access_control_db_ensure_role_assignment,
	access_control_db_set_service_account_grant,
} from "../convex/access_control.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_ROOT_ID } from "./files.ts";
import {
	files_readable_scopes_db_enumerate_by_path,
	files_readable_scopes_db_plan,
	files_readable_scopes_db_reader,
} from "./files-readable-scopes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	const add_member = async (ctx: MutationCtx, clerkUserId: string) => {
		const userId = await ctx.db.insert("users", { clerkUserId });
		await ctx.db.insert("organizations_workspaces_users", {
			...scope,
			userId,
			active: true,
			updatedAt: Date.now(),
			pendingOrganizationRemoval: false,
		});
		await access_control_db_ensure_role_assignment(ctx, { ...scope, userId, role: "member", now: Date.now() });
		return userId;
	};
	const { v, w } = await t.run(async (ctx) => ({ v: await add_member(ctx, "clerk_v"), w: await add_member(ctx, "clerk_w") }));

	/**
	 * Insert a saved node. A restricted root points at itself; other nodes take their parent's scope.
	 */
	const insert = async (
		ctx: MutationCtx,
		parent: Doc<"files_nodes"> | null,
		name: string,
		kind: "file" | "folder",
		restricted = false,
	) => {
		const path = `${parent?.path ?? ""}/${name}`;
		const nodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			...scope,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: parent?._id ?? files_ROOT_ID,
			name,
			sortName: files_sort_text_key(name),
			kind,
			path,
			treePath: kind === "folder" ? `${path}/` : path,
			pathDepth: path.split("/").length - 1,
			restrictedScopeNodeId: parent?.restrictedScopeNodeId ?? null,
		});
		if (restricted)
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId, isRestrictedScopeRoot: true });
		return (await ctx.db.get("files_nodes", nodeId))!;
	};

	const share = (
		ctx: MutationCtx,
		node: Doc<"files_nodes">,
		principal: { principalKind: "user"; userId: Id<"users"> } | { principalKind: "role"; role: "member" },
	) =>
		ctx.db.insert("access_control_permission_grants", {
			...scope,
			resourceKind: "file",
			resourceId: String(node._id),
			...principal,
			permission: "content.read",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

	/**
	 * Run one query step as `userId`, with an optional service account.
	 */
	const as_reader = async <T>(
		args: { userId: Id<"users">; serviceAccountId?: Id<"access_control_service_accounts"> },
		run: (
			ctx: QueryCtx,
			reader: Extract<Awaited<ReturnType<typeof files_readable_scopes_db_reader>>, { mode: "scoped" }>,
		) => Promise<T>,
	) =>
		await t.run(async (ctx) => {
			const reader = await files_readable_scopes_db_reader(ctx, { ...scope, ...args });
			if (reader.mode !== "scoped") throw new Error("Expected a scoped reader");
			return await run(ctx, reader);
		});

	/**
	 * One page of each principal's items under `/`, as `kind:treePath`.
	 */
	const enumerate = async (args: { userId: Id<"users">; serviceAccountId?: Id<"access_control_service_accounts"> }) => {
		const count = await as_reader(args, async (_ctx, reader) => reader.principalKeys.length);
		const pages = [];
		// Each principal is its own `.paginate()` stream, so each one is its own query.
		for (let principalIndex = 0; principalIndex < count; principalIndex++)
			pages.push(
				await as_reader(args, async (ctx, reader) => {
					const page = await files_readable_scopes_db_enumerate_by_path(ctx, {
						reader,
						tag: undefined,
						principalIndex,
						folderTreePath: "/",
						afterTreePath: null,
						numItems: 10,
					});
					return {
						items: page.items.map((item) => `${item.kind}:${item.node.treePath}`),
						isDone: page.isDone,
						documentsRead: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
					};
				}),
			);
		return pages;
	};

	const plan = (
		args: { userId: Id<"users">; serviceAccountId?: Id<"access_control_service_accounts"> },
		at: string | null,
	) =>
		as_reader(args, async (ctx, reader) => {
			const { partitions } = await files_readable_scopes_db_plan(ctx, { reader, tag: undefined, folder: null, at });
			return partitions;
		});

	return { t, db, scope, v, w, insert, share, enumerate, plan };
}

describe("files_readable_scopes", () => {
	test("lists the folders a member may read in path order, and reads no other folder", async () => {
		const f = await fixture();
		// 1,200 restricted folders shared only with W sit between the folders V may read.
		for (let batch = 0; batch < 6; batch++)
			await test_run_with_flush(f.t, async (ctx) => {
				for (let index = batch * 200; index < (batch + 1) * 200; index++)
					await f.share(ctx, await f.insert(ctx, null, `h-${String(index).padStart(4, "0")}`, "folder", true), {
						principalKind: "user",
						userId: f.w,
					});
			});
		const { inner, r } = await test_run_with_flush(f.t, async (ctx) => {
			// A folder V may read inside a folder V may not.
			const g = await f.insert(ctx, null, "g", "folder", true);
			await f.share(ctx, g, { principalKind: "user", userId: f.w });
			const inner = await f.insert(ctx, g, "in", "folder", true);
			const o = await f.insert(ctx, null, "o", "folder");
			const r = await f.insert(ctx, o, "r", "folder", true);
			const s1 = await f.insert(ctx, null, "s1", "folder", true);
			const s2 = await f.insert(ctx, null, "s2", "folder", true);
			for (const node of [inner, r, s1]) await f.share(ctx, node, { principalKind: "user", userId: f.v });
			await f.share(ctx, s2, { principalKind: "role", role: "member" });
			return { inner, r };
		});

		const pages = await f.enumerate({ userId: f.v });
		expect(pages.map(({ items, isDone }) => ({ items, isDone }))).toEqual([
			{ items: ["scope:/g/in/", "scope:/o/r/", "scope:/s1/"], isDone: true },
			{ items: ["scope:/s2/"], isDone: true },
		]);
		// Only V's own rows and their nodes are read, never W's 1,200 rows.
		for (const page of pages) expect(page.documentsRead).toBeLessThan(50);

		// A list that goes on inside a readable folder keeps it open, also under a hidden folder.
		expect(await f.plan({ userId: f.v }, "/g/in/x.md")).toEqual([
			{ scopeNodeId: null, treePath: "/" },
			{ scopeNodeId: inner._id, treePath: "/g/in/" },
		]);
		expect(await f.plan({ userId: f.v }, "/o/r/")).toEqual([
			{ scopeNodeId: null, treePath: "/" },
			{ scopeNodeId: r._id, treePath: "/o/r/" },
		]);
		expect(await f.plan({ userId: f.v }, "/h-0001/x.md")).toEqual([{ scopeNodeId: null, treePath: "/" }]);
	});

	test("keeps the children of an unrestricted folder in a partition while the unrestrict job runs", async () => {
		const f = await fixture();
		const s = await test_run_with_flush(f.t, async (ctx) => {
			const s = await f.insert(ctx, null, "s", "folder", true);
			// More children than the request's first step writes.
			for (let index = 0; index < 100; index++) await f.insert(ctx, s, `c-${String(index).padStart(3, "0")}.md`, "file");
			return s;
		});
		expect(await f.plan({ userId: f.v }, null)).toEqual([{ scopeNodeId: null, treePath: "/" }]);

		const asOwner = f.t.withIdentity({ issuer: "https://clerk.test", external_id: f.db.userId });
		expect(
			await asOwner.mutation(api.files_sharing.unrestrict_node, { membershipId: f.db.membershipId, nodeId: s._id }),
		).toEqual({ _yay: null });
		const pointers = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect())
				.filter((node) => node.parentId === s._id)
				.map((node) => node.restrictedScopeNodeId),
		);
		expect(pointers).toContain(s._id);
		// The folder is open again, so the children that still point at it are open content too.
		expect(await f.plan({ userId: f.v }, null)).toEqual([
			{ scopeNodeId: null, treePath: "/" },
			{ scopeNodeId: s._id, treePath: "/s/" },
		]);

		// The job ends and every child is rewritten: the partition goes.
		for (let step = 0; step < 100; step++) {
			await f.t.finishInProgressScheduledFunctions();
			if (!(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").first()))) break;
			vi.advanceTimersToNextTimer();
		}
		expect(await f.plan({ userId: f.v }, null)).toEqual([{ scopeNodeId: null, treePath: "/" }]);
	});

	test("an owner acting through a service account reads the account's folders and open nodes only", async () => {
		const f = await fixture();
		const serviceAccountId = await test_run_with_flush(f.t, async (ctx) => {
			const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
				...f.scope,
				name: "bot",
				createdBy: f.db.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			});
			const s = await f.insert(ctx, null, "s", "folder", true);
			const x = await f.insert(ctx, null, "x.md", "file");
			await f.insert(ctx, null, "y.md", "file");
			for (const node of [s, x]) {
				const granted = await access_control_db_set_service_account_grant(ctx, {
					...f.scope,
					serviceAccountId,
					resource: { kind: "file", nodeId: node._id },
					level: "read",
				});
				if (granted._nay) throw new Error(granted._nay.message);
			}
			return serviceAccountId;
		});
		const caller = { userId: f.db.userId, serviceAccountId };

		expect((await f.enumerate(caller)).map(({ items, isDone }) => ({ items, isDone }))).toEqual([
			{ items: ["scope:/s/", "node:/x.md"], isDone: true },
		]);
		// The account has no workspace grant, so open content is not one partition.
		expect(await f.plan(caller, null)).toEqual([]);
		// The owner alone reads every row, and a member through an account has no partitioned read yet.
		expect(
			await f.t.run(async (ctx) => [
				(await files_readable_scopes_db_reader(ctx, { ...f.scope, userId: f.db.userId })).mode,
				(await files_readable_scopes_db_reader(ctx, { ...f.scope, userId: f.v, serviceAccountId })).mode,
			]),
		).toEqual(["flat", "flat"]);

		// A revoked account keeps its rows but reads nothing.
		await f.t.run((ctx) => ctx.db.patch("access_control_service_accounts", serviceAccountId, { revokedAt: Date.now() }));
		expect(await f.enumerate(caller)).toEqual([]);
	});
});
