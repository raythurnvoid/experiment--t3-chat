// Each flow writes drafts and saved changes through the real mutations, runs the overlay jobs, then
// compares the stored derived docs with `check_user` and checks the window bound (every hide matches
// one active saved node with the same copied facts). The share row flows compare the share rows with
// `check_share_rows`, and the ancestor flows the saved nodes' ancestors with `check_ancestors`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	test_convex,
	test_rename_node,
	test_move_nodes,
	test_finish_pending_update_run,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
	test_meta_search,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	files_pending_overlay_db_flush,
	files_pending_overlay_db_mark_target,
	files_pending_overlay_db_set_acting_user,
	files_pending_overlay_list,
	files_pending_overlay_search_name,
} from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_ancestor_ids, type files_PendingParent, type files_PendingTarget } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Scope = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
};

async function insert_saved_node(
	ctx: MutationCtx,
	scope: Scope,
	args: { parent: Doc<"files_nodes"> | null; name: string; kind: "file" | "folder" },
) {
	const path = `${args.parent?.path ?? ""}/${args.name}`;
	const nodeId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		createdBy: scope.userId,
		updatedBy: scope.userId,
		parentId: args.parent?._id ?? files_ROOT_ID,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		kind: args.kind,
		path,
		treePath: args.kind === "folder" ? `${path}/` : path,
		pathDepth: path.split("/").length - 1,
		lowercaseExtension: args.kind === "file" && args.name.includes(".") ? args.name.split(".").at(-1)! : null,
	});
	return (await ctx.db.get("files_nodes", nodeId))!;
}

/**
 * A hide exists only while its saved node is active, with copies that match it.
 */
async function expect_window_bound(t: ReturnType<typeof test_convex>) {
	const pairs = await t.run(async (ctx) => {
		const hides = await ctx.db.query("files_pending_hides").collect();
		return await Promise.all(
			hides.map(async (hide) => ({ hide, node: await ctx.db.get("files_nodes", hide.savedNodeId) })),
		);
	});
	for (const { hide, node } of pairs) {
		expect(node?.archiveOperationId).toBe(null);
		expect({
			parentId: hide.parentId,
			kind: hide.kind,
			name: hide.name,
			updatedAt: hide.updatedAt,
			lowercaseExtension: hide.lowercaseExtension,
			nodeCreationTime: hide.nodeCreationTime,
			treePath: hide.treePath,
		}).toEqual({
			parentId: node!.parentId,
			kind: node!.kind,
			name: node!.name,
			updatedAt: node!.updatedAt,
			lowercaseExtension: node!.lowercaseExtension,
			nodeCreationTime: node!._creationTime,
			treePath: node!.treePath,
		});
	}
}

async function fixture(transactionLimits?: NonNullable<Parameters<typeof test_convex>[0]>["transactionLimits"]) {
	const t = test_convex({ transactionLimits });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const u: Scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asU = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });

	// V is a second member of the same workspace. V's writes are saved writes.
	const vMember = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk_overlay_v" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
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
		return { userId, membershipId };
	});
	const v: Scope = { ...u, userId: vMember.userId };
	const asV = t.withIdentity({ issuer: "https://clerk.test", external_id: vMember.userId });

	/**
	 * Insert a saved node the way a save does, with the overlay flush.
	 */
	const saved = async (parent: Doc<"files_nodes"> | null, name: string, kind: "file" | "folder" = "file") =>
		await test_run_with_flush(t, async (ctx) => await insert_saved_node(ctx, u, { parent, name, kind }));

	const draft_move = async (
		target: files_PendingTarget,
		destParent: files_PendingParent,
		destName: string,
		scope: Scope = u,
	) => {
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope,
			target,
			destParent,
			destName,
		});
		if (moved._nay) throw new Error(moved._nay.message);
	};

	const draft_delete = async (target: files_PendingTarget, scope: Scope = u) => {
		const deleted = await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			...scope,
			target,
		});
		if (deleted._nay) throw new Error(deleted._nay.message);
	};

	const create_private = async (path: string, kind: "file" | "folder" = "file", scope: Scope = u) => {
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, { ...scope, path, kind });
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.target;
	};

	/**
	 * Undo one draft, like the Pending tab's Discard of one row.
	 */
	const undo = async (target: files_PendingTarget) => {
		const proposal = await proposal_of(target);
		const discarded = await asU.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: db.membershipId,
			target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (discarded._nay) throw new Error(discarded._nay.message);
	};

	const proposal_of = async (target: files_PendingTarget, scope: Scope = u) => {
		const proposal = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", scope.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.unique(),
		);
		if (!proposal) throw new Error("Expected a proposal");
		return proposal;
	};

	const v_move = async (node: { id: Id<"files_nodes"> }, parent: { id: Id<"files_nodes"> } | null) => {
		const moved = await test_move_nodes(t, asV, {
				membershipId: vMember.membershipId,
				itemIds: [node.id],
				targetParentId: parent?.id ?? files_ROOT_ID,
			});
		if (moved._nay) throw new Error(moved._nay.message);
		await settle();
	};

	/**
	 * V renames a saved node. Like `rename_node`, `name` is relative to the node's parent.
	 */
	const v_rename = async (node: { id: Id<"files_nodes"> }, name: string) => {
		const renamed = await test_rename_node(t, asV, {
			membershipId: vMember.membershipId,
			nodeId: node.id,
			path: name,
		});
		if (renamed._nay) throw new Error(renamed._nay.message);
		await settle();
	};

	const v_archive = async (node: { id: Id<"files_nodes"> }) => {
		const archived = await asV.mutation(api.files_nodes.archive_nodes, {
			membershipId: vMember.membershipId,
			nodeIds: [node.id],
		});
		if (archived._nay) throw new Error(JSON.stringify(archived._nay));
		await settle();
	};

	const v_restore = async (node: { id: Id<"files_nodes"> }) => {
		const restored = await asV.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: vMember.membershipId,
			nodeIds: [node.id],
		});
		if (restored._nay) throw new Error(JSON.stringify(restored._nay));
		await settle();
	};

	/**
	 * Accept or Discard these proposals of U, or of V, in one review run, driven like its scheduled jobs.
	 */
	const review = async (kind: "accept" | "discard", proposals: Doc<"files_pending_updates">[], reviewer = "u") => {
		const [as, membershipId] = reviewer === "v" ? [asV, vMember.membershipId] : [asU, db.membershipId];
		const started = await as.mutation(api.files_pending_update_runs.start, {
			membershipId,
			requestId: crypto.randomUUID(),
			kind,
			expectedItemCount: proposals.length,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		const sealed = await as.mutation(api.files_pending_update_runs.seal, { membershipId, runId });
		if (sealed._nay) throw new Error(sealed._nay.message);
		await test_finish_pending_update_run(asU, runId);
		await settle();
	};

	/**
	 * Set metadata keys through the agent's door: a draft's pending docs for a private node, or
	 * committed docs for a saved node.
	 */
	const set_metadata = async (path: string, set: Array<{ key: string; value: string }>, scope: Scope = u) => {
		const updated = await t.mutation(internal.files_metadata.update_entries_by_path, {
			...scope,
			path,
			set,
			remove: [],
		});
		if (updated._nay) throw new Error(updated._nay.message);
	};

	const run_job = async (kind: Doc<"files_pending_overlay_jobs">["kind"], key: string) => {
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
				.unique(),
		);
		if (job)
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind,
				key,
				nextAttemptAt: job.nextAttemptAt,
			});
	};

	/**
	 * Run the scheduled functions that are due now (overlay jobs, archive steps, subtree ops), one
	 * timer at a time. `runAllTimers` would also jump hours ahead and expire U's drafts, and it starts
	 * all due functions together, which convex-test does not run as serial transactions.
	 */
	const settle = async () => {
		for (let step = 0; step < 10_000; step++) {
			await t.finishInProgressScheduledFunctions();
			const now = Date.now();
			const due = await t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).some(
					(job) => job.state.kind === "pending" && job.scheduledTime <= now,
				),
			);
			if (!due) return;
			vi.advanceTimersToNextTimer();
		}
		throw new Error("Scheduled functions did not settle");
	};

	/**
	 * U's derived docs of one target.
	 */
	const overlay = async (target: files_PendingTarget, scope: Scope = u) =>
		await t.run(async (ctx) => ({
			hidden:
				target.kind === "saved" &&
				(await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", target.id).eq("userId", scope.userId))
					.unique()) !== null,
			place: await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q.eq("target.kind", target.kind).eq("target.id", target.id).eq("userId", scope.userId),
				)
				.unique(),
		}));

	/**
	 * One page of V's agent `find /`, or with `kind` of `find / -type f`, which opens moved-in
	 * folders on its own.
	 */
	const v_find = async (args: { kind?: "file"; numItems?: number; cursor?: string | null } = {}) => {
		const result = await files_pending_overlay_list({ runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">, {
			organizationId: v.organizationId,
			workspaceId: v.workspaceId,
			visibilityUserId: v.userId,
			overlayUserId: v.userId,
			folderPath: "/",
			mode: "subtree",
			order: "asc",
			...(args.kind ? { kind: args.kind } : {}),
			numItems: args.numItems ?? 50,
			cursor: args.cursor ?? null,
		});
		if (result._nay) throw new Error(result._nay.message);
		return { paths: result._yay.items.map((item) => item.path), cursor: result._yay.continueCursor };
	};

	/**
	 * Run the jobs, then check that every stored derived doc of U and V is what the flush computes,
	 * and the window bound.
	 */
	const expect_overlay_true = async () => {
		await settle();
		for (const scope of [u, v]) {
			const differences: string[] = [];
			let cursor: string | null = null;
			do {
				const page: { differences: string[]; cursor: string | null; moveInProgress: boolean } = await t.query(
					internal.files_pending_overlay.check_user,
					{ ...scope, cursor },
				);
				expect(page.moveInProgress, "a clean audit must finish outside a Move").toBe(false);
				differences.push(...page.differences);
				cursor = page.cursor;
			} while (cursor);
			expect(differences).toEqual([]);
		}
		await expect_window_bound(t);
	};

	/**
	 * Run one of U's mutations, then the jobs. Fake timers never refill the rate limits, so reset them
	 * first.
	 */
	const as_u = async (run: () => Promise<{ _nay?: { message: string } }>) => {
		await t.run(async (ctx) => {
			for (const name of ["files_sharing_write", "files_tree_write", "organizations_write"])
				await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name, key: u.userId });
		});
		const result = await run();
		if (result._nay) throw new Error(result._nay.message);
		await settle();
	};

	const restrict = (node: Doc<"files_nodes">) =>
		as_u(() => asU.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: node._id }));

	const share = (
		node: Doc<"files_nodes">,
		principal: { kind: "user"; userId: Id<"users"> } | { kind: "role"; role: "member" },
		level: "read" | "manage",
	) =>
		as_u(() =>
			asU.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: db.membershipId,
				nodeId: node._id,
				principal,
				level,
			}),
		);

	/**
	 * Run the jobs, then check that every grant of the workspace has the share row it should have, and
	 * every row has its grant.
	 */
	const expect_share_rows_true = async (workspaceId = u.workspaceId) => {
		await settle();
		const differences: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { differences: string[]; cursor: string | null } = await t.query(
				internal.files_pending_overlay.check_share_rows,
				{ organizationId: u.organizationId, workspaceId, cursor },
			);
			differences.push(...page.differences);
			cursor = page.cursor;
		} while (cursor);
		expect(differences).toEqual([]);
	};

	return {
		t,
		db,
		u,
		v,
		asU,
		asV,
		vMember,
		saved,
		draft_move,
		draft_delete,
		create_private,
		undo,
		proposal_of,
		v_move,
		v_rename,
		v_archive,
		v_restore,
		review,
		set_metadata,
		run_job,
		settle,
		overlay,
		v_find,
		expect_overlay_true,
		as_u,
		restrict,
		share,
		expect_share_rows_true,
	};
}

/**
 * Add a member of the workspace, with the member role.
 */
async function add_member(ctx: MutationCtx, scope: Omit<Scope, "userId">, clerkUserId: string): Promise<Scope> {
	const userId = await ctx.db.insert("users", { clerkUserId });
	await ctx.db.insert("organizations_workspaces_users", {
		...scope,
		userId,
		active: true,
		updatedAt: Date.now(),
		pendingOrganizationRemoval: false,
	});
	await access_control_db_ensure_role_assignment(ctx, { ...scope, userId, role: "member", now: Date.now() });
	return { ...scope, userId };
}

/**
 * A draft doc written directly, for writes no mutation makes alone.
 */
function proposal_doc(
	scope: Scope,
	target: files_PendingTarget,
	change: Pick<Doc<"files_pending_updates">, "pendingMove" | "pendingArchive">,
) {
	return {
		...scope,
		target,
		revision: 1,
		size: 0,
		updatedAt: Date.now(),
		expiresAt: Date.now() + 60 * 60 * 1000,
		...change,
	};
}

const target = (node: Doc<"files_nodes">): files_PendingTarget => ({ kind: "saved", id: node._id });
const parent = (node: Doc<"files_nodes">): files_PendingParent => ({ kind: "saved", id: node._id });

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A node's share rows by principal. Each row must copy the live node.
 */
async function share_rows(f: Fixture, nodeId: Id<"files_nodes">) {
	const { node, rows } = await f.t.run(async (ctx) => ({
		node: await ctx.db.get("files_nodes", nodeId),
		rows: await ctx.db
			.query("files_share_rows")
			.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
			.collect(),
	}));
	for (const row of rows)
		expect({
			parentId: row.parentId,
			kind: row.kind,
			archiveOperationId: row.archiveOperationId,
			sortName: row.sortName,
			name: row.name,
			updatedAt: row.updatedAt,
			lowercaseExtension: row.lowercaseExtension,
			contentByteSize: row.contentByteSize,
			nodeCreationTime: row.nodeCreationTime,
		}).toEqual({
			parentId: node?.parentId,
			kind: node?.kind,
			archiveOperationId: node?.archiveOperationId,
			sortName: node?.sortName,
			name: node?.name,
			updatedAt: node?.updatedAt,
			lowercaseExtension: node?.lowercaseExtension ?? null,
			contentByteSize: node?.contentByteSize ?? null,
			nodeCreationTime: node?._creationTime,
		});
	return rows.toSorted((a, b) => (a.principalKey < b.principalKey ? -1 : 1));
}

const share_keys = async (f: Fixture, nodeId: Id<"files_nodes">) =>
	(await share_rows(f, nodeId)).map((row) => row.principalKey);

describe("files_pending_overlay flush", () => {
	test("private file and folder, then a private move and rename", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		const file = await f.create_private("/p/f.md");
		expect((await f.overlay(folder)).place).toMatchObject({ ownerTreePath: "/p/", isVisible: true, isPathless: false });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/p/f.md", isVisible: true });
		// The folder holds an active draft, so only the file is a Pending row.
		const listed = await f.t.run((ctx) => ctx.db.query("files_pending_list_rows").collect());
		expect(listed.map((row) => row.listKey).sort()).toEqual(["all", "own"]);
		await f.expect_overlay_true();

		// A private folder moves at once: its child follows it.
		await f.draft_move(folder, { kind: "root" }, "q");
		expect((await f.overlay(folder)).place).toMatchObject({ ownerTreePath: "/q/", name: "q", isVisible: true });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/q/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("a saved move and rename in a draft hide the saved node and place it at the destination", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");

		await f.draft_move(target(x), parent(b), "x.md");
		expect(await f.overlay(target(x))).toMatchObject({
			hidden: true,
			place: { ownerTreePath: "/b/x.md", isVisible: true, accessNodeId: x._id },
		});
		await f.expect_overlay_true();

		await f.draft_move(target(x), parent(a), "y.md");
		expect((await f.overlay(target(x))).place).toMatchObject({ ownerTreePath: "/a/y.md", name: "y.md" });
		await f.expect_overlay_true();
	});

	test("a draft delete hides the saved node until undo, a bulk Discard or expiry", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");

		await f.draft_delete(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
		await f.undo(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.draft_delete(target(x));
		await f.review("discard", [await f.proposal_of(target(x))]);
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.draft_delete(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(true);
		// U is not active, so the draft expires after 4 hours.
		vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
		await f.settle();
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("U's draft delete comes back when V restores the node V archived", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_delete(target(x));

		// V's own transactions keep U's hide true at once, before any job runs.
		const renamed = await test_rename_node(f.t, f.asV, {
			membershipId: f.vMember.membershipId,
			nodeId: x._id,
			path: "y.md",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await expect_window_bound(f.t);
		const archived = await f.asV.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.vMember.membershipId,
			nodeIds: [x._id],
		});
		expect(archived._nay).toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.v_restore({ id: x._id });
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
	});

	test("a draft move of a folder of 40 notes with big metadata, and the fields of a moved note", async () => {
		const f = await fixture();
		const notes = await f.saved(null, "notes", "folder");
		const archive = await f.saved(null, "archive", "folder");
		const files = [];
		for (let index = 0; index < 40; index++) files.push(await f.saved(notes, `n${index}.md`));
		// 128 date-like keys write 384 metadata docs (field, value and maybe_date), the most one file can carry.
		const set = Array.from({ length: 128 }, (_, index) => ({ key: `k${index}`, value: "2026-01-01" }));
		for (const file of files) await f.set_metadata(file.path, set, f.v);

		await f.draft_move(target(notes), parent(archive), "notes");
		expect((await f.overlay(target(notes))).place).toMatchObject({ ownerTreePath: "/archive/notes/", isVisible: true });

		await f.draft_move(target(files[0]!), parent(archive), "n0.md");
		await f.expect_overlay_true();
		const place = (await f.overlay(target(files[0]!))).place!;
		const fields = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_place", (q) => q.eq("placeId", place._id))
				.collect(),
		);
		expect(fields).toHaveLength(384);
		expect(fields.every((field) => field.ownerTreePath === "/archive/n0.md")).toBe(true);
	}, 120_000);

	test("name claims by a private node and by a moved saved node start and end with saved writes", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const q = await f.saved(null, "q", "folder");

		// U's private /p/n claims the name; V then saves /p/n.
		await f.create_private("/p/n", "folder");
		const n = await f.saved(p, "n", "folder");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.expect_overlay_true();

		// V renames the claimed node away, then back; then V moves it to /q.
		await f.v_rename({ id: n._id }, "m");
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.v_rename({ id: n._id }, "n");
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.v_move({ id: n._id }, { id: q._id });
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();

		// U drafts `mv /a/k /q/z`, then V renames /q/n to /q/z: the moved saved node claims the name.
		const a = await f.saved(null, "a", "folder");
		const k = await f.saved(a, "k", "folder");
		await f.draft_move(target(k), parent(q), "z");
		await f.v_rename({ id: n._id }, "z");
		expect((await f.overlay(target(n))).hidden).toBe(true);

		// V archives the claimant: the claim ends. V restores it: the claim is back.
		await f.v_archive({ id: k._id });
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.v_restore({ id: k._id });
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.expect_overlay_true();

		// The claimer moves on: the claim ends.
		await f.draft_move(target(k), parent(p), "k");
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a moved node follows its destination folder when V archives, restores and moves it", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");

		// V archives /b: x is back in /a.
		await f.v_archive({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();
		await f.v_restore({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// U draft-deletes /b, then undoes it.
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.undo(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// V archives the moved node itself: `ls /b` must not show it.
		await f.v_archive({ id: x._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();
	});

	test("a move cycle falls back to the saved place, and resolves again when the cycle ends", async () => {
		const f = await fixture();
		const aFolder = await f.saved(null, "a", "folder");
		const bFolder = await f.saved(null, "b", "folder");

		// U drafts `mv /a /b/`, then V saves `mv /b /a/`.
		await f.draft_move(target(aFolder), parent(bFolder), "a");
		await f.v_move({ id: bFolder._id }, { id: aFolder._id });
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: false,
			place: { isPathless: true, isVisible: false, ownerTreePath: "/a/" },
		});
		await f.expect_overlay_true();

		// V moves /a/b back to the root: U's move resolves again.
		await f.v_move({ id: bFolder._id }, null);
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: true,
			place: { isPathless: false, isVisible: true, ownerTreePath: "/b/a/" },
		});
		await f.expect_overlay_true();

		// The cycle again, then U drafts `mv /a/b /`.
		await f.v_move({ id: bFolder._id }, { id: aFolder._id });
		await f.draft_move(target(bFolder), { kind: "root" }, "b");
		await f.settle();
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: true,
			place: { isPathless: false, isVisible: true, ownerTreePath: "/b/a/" },
		});
		await f.expect_overlay_true();
	});

	test("a move into a private folder follows V's archive and move of its saved parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const c = await f.saved(null, "c", "folder");
		const x = await f.saved(a, "x.md");
		const p = await f.create_private("/b/p", "folder");
		await f.draft_move(target(x), p, "x.md");
		expect((await f.overlay(target(x))).place).toMatchObject({ ownerTreePath: "/b/p/x.md", isVisible: true });

		// V archives /b: x is back in /a.
		await f.v_archive({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();

		// V restores /b and moves it into /c: `find /c` shows x.
		await f.v_restore({ id: b._id });
		await f.v_move({ id: b._id }, { id: c._id });
		expect(await f.overlay(target(x))).toMatchObject({
			hidden: true,
			place: { ownerTreePath: "/c/b/p/x.md", isVisible: true },
		});
		await f.expect_overlay_true();
	});

	test("a private file under a moved folder follows V's rename of the destination", async () => {
		const f = await fixture();
		const g = await f.saved(null, "g", "folder");
		const xFolder = await f.saved(null, "x", "folder");
		await f.draft_move(target(g), parent(xFolder), "g");
		const file = await f.create_private("/x/g/f.md");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/g/f.md", isVisible: true });

		await f.v_rename({ id: xFolder._id }, "y");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/y/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("a private file in a moved folder follows the folder's destination as it hides and shows", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const g = await f.saved(a, "g", "folder");
		await f.draft_move(target(g), parent(b), "g");
		const file = await f.create_private("/b/g/f.md");

		// V archives /b: `find /a` shows /a/g/f.md. V restores it: `find /b` shows /b/g/f.md.
		await f.v_archive({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.expect_overlay_true();
		await f.v_restore({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();

		// The same with U's draft delete of /b and its undo.
		await f.draft_delete(target(b));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.undo(target(b));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();

		// And with a claim on /b that ends: U drafts `mv /c /z`, V renames /b to /z, then U drafts `mv /c /c2`.
		const c = await f.saved(null, "c", "folder");
		await f.draft_move(target(c), { kind: "root" }, "z");
		await f.v_rename({ id: b._id }, "z");
		expect((await f.overlay(target(b))).hidden).toBe(true);
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.draft_move(target(c), { kind: "root" }, "c2");
		await f.settle();
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/z/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("one agent turn: `mv /a/x.md /b/c/`, `rm -r /b`, then undo, exact at once", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const c = await f.saved(b, "c", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(c), "x.md");

		// No job runs between these steps: the inline owner path step does the work.
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.undo(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// The same with a private folder as the destination.
		const p = await f.create_private("/b/p", "folder");
		await f.draft_move(target(x), p, "x.md");
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		expect((await f.overlay(p)).place).toMatchObject({ isVisible: false });
		await f.expect_overlay_true();
	});

	test("with 60 moved files, the first 50 are exact at once and the rest after the job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const files: Doc<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) {
			const file = await f.saved(a, `x${String(index).padStart(2, "0")}.md`);
			await f.draft_move(target(file), parent(b), file.name);
			files.push(file);
		}
		await f.settle();

		const visible = async () =>
			(await Promise.all(files.map(async (file) => (await f.overlay(target(file))).place!.isVisible))).filter(Boolean)
				.length;
		await f.draft_delete(target(b));
		expect(await visible()).toBe(10);
		await f.settle();
		expect(await visible()).toBe(0);
		await f.expect_overlay_true();
	}, 120_000);

	test("place fields follow a private draft's metadata and V's committed metadata of a moved file", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		await f.set_metadata("/p", [{ key: "status", value: "draft" }]);
		await f.expect_overlay_true();
		const place = (await f.overlay(folder)).place!;
		const fieldsOf = async (placeId: Id<"files_pending_places">) =>
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) => q.eq("placeId", placeId))
					.collect(),
			);
		expect((await fieldsOf(place._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["draft"]);

		// A new value bumps the place's version at once; the job then writes the new value only.
		await f.set_metadata("/p", [{ key: "status", value: "done" }]);
		expect((await f.overlay(folder)).place!.fieldsVersion).toBeGreaterThan(place.fieldsVersion);
		await f.expect_overlay_true();
		expect((await fieldsOf(place._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["done"]);

		// A moved saved file shows its committed metadata, and follows V's new value.
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		await f.draft_move(target(x), parent(a), "x.md");
		await f.set_metadata("/x.md", [{ key: "owner", value: "v" }], f.v);
		await f.expect_overlay_true();
		const moved = (await f.overlay(target(x))).place!;
		expect((await fieldsOf(moved._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["v"]);
	});

	test("publishing one draft of a private folder moves the other drafts to the saved folder", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		const children = [];
		for (const name of ["a", "b", "c", "d"]) children.push(await f.create_private(`/p/${name}`, "folder"));
		// Accept publishes the private folder with its first draft; the 3 other drafts stay.
		await f.review("accept", [await f.proposal_of(folder), await f.proposal_of(children[0]!)]);

		const published = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", folder.id as Id<"files_pending_nodes">))
				.unique(),
		);
		expect(published).not.toBe(null);
		for (const child of children.slice(1))
			expect((await f.overlay(child)).place).toMatchObject({
				parent: { kind: "saved", id: published!.savedNodeId },
				isVisible: true,
			});
		await f.expect_overlay_true();
	});

	test("V's folder move, rename, archive and restore update U's drafts under it", async () => {
		const f = await fixture();
		const top = await f.saved(null, "top", "folder");
		const other = await f.saved(null, "other", "folder");
		const dir = await f.saved(top, "dir", "folder");
		const file = await f.create_private("/top/dir/f.md");
		const y = await f.saved(top, "y.md");
		await f.draft_move(target(y), parent(dir), "y.md");

		await f.v_move({ id: dir._id }, { id: other._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir/f.md" });
		expect((await f.overlay(target(y))).place).toMatchObject({ ownerTreePath: "/other/dir/y.md" });
		await f.expect_overlay_true();

		await f.v_rename({ id: dir._id }, "dir2");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir2/f.md" });
		await f.expect_overlay_true();

		await f.v_archive({ id: dir._id });
		expect((await f.overlay(file)).place).toMatchObject({ isVisible: false });
		expect(await f.overlay(target(y))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();

		await f.v_restore({ id: dir._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir2/f.md", isVisible: true });
		await f.expect_overlay_true();

		// U moved an ancestor in a draft: V's rename of /other still reaches the drafts below.
		await f.draft_move(target(other), parent(top), "other");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/top/other/dir2/f.md" });
		await f.v_rename({ id: dir._id }, "dir3");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/top/other/dir3/f.md" });
		await f.expect_overlay_true();
	});

	test("a draft delete inside a moved folder hides the drafts under it (owner path prefix)", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const xFolder = await f.saved(null, "x", "folder");
		const sub = await f.saved(a, "f", "folder");
		await f.draft_move(target(a), parent(xFolder), "a");
		const file = await f.create_private("/x/a/f/n.md");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/a/f/n.md", isVisible: true });

		await f.draft_delete(target(sub));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/a/f/n.md", isVisible: false });
		await f.expect_overlay_true();
	});

	test("the moved folder's fallback path follows V's rename of its saved parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const g = await f.saved(a, "g", "folder");
		await f.draft_move(target(g), parent(b), "g");
		const file = await f.create_private("/b/g/f.md");

		await f.v_archive({ id: b._id });
		await f.v_rename({ id: a._id }, "c");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/c/g/f.md", isVisible: true });
		await f.v_restore({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("account deletion of a user with a replace draft leaves no derived doc of that user", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const x = await f.saved(p, "x.md");
		// V's "replace": a draft delete of saved /p/x.md plus a private /p/x.md.
		await f.draft_delete(target(x), f.v);
		const file = await f.create_private("/p/x.md", "file", f.v);
		expect((await f.overlay(target(x), f.v)).hidden).toBe(true);
		expect((await f.overlay(file, f.v)).place).toMatchObject({ ownerTreePath: "/p/x.md", isVisible: true });
		await f.expect_overlay_true();

		const requestId = await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.v.userId });
		const request = await f.t.run((ctx) => ctx.db.get("data_deletion_requests", requestId!));
		for (let pass = 0; ; pass++) {
			if (pass === 200) throw new Error("User deletion did not finish");
			const result = await f.t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: request!.eligibleAt + 1,
			});
			if (result.done) break;
		}
		await f.settle();

		const left = await f.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_hides")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_places")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_list_rows")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_list_keys")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
		]);
		expect(left).toEqual([]);
		// The saved file stays: it belongs to the workspace.
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", x._id))).toMatchObject({ archiveOperationId: null });
		await f.expect_overlay_true();
	});

	test("a place stores the saved node whose access decides if its owner sees it", async () => {
		const f = await fixture();
		const r = await f.saved(null, "r", "folder");
		const open = await f.saved(null, "open", "folder");
		const plan = await f.saved(r, "plan.md");
		const restricted = await f.asU.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: r._id,
		});
		expect(restricted._nay).toBeUndefined();
		const share = {
			membershipId: f.db.membershipId,
			nodeId: r._id,
			principal: { kind: "user", userId: f.v.userId },
		} as const;
		expect((await f.asU.mutation(api.files_sharing.set_node_share_grant, { ...share, level: "write" }))._nay).toBe(
			undefined,
		);

		// V drafts `mv /r/plan.md /open/` while a grant lets V read and write restricted /r.
		await f.draft_move(target(plan), parent(open), "plan.md", f.v);
		expect((await f.overlay(target(plan), f.v)).place).toMatchObject({
			ownerTreePath: "/open/plan.md",
			isVisible: true,
			accessNodeId: plan._id,
		});
		// A private node stores its nearest saved ancestor.
		const notes = await f.create_private("/r/notes.md");
		expect((await f.overlay(notes)).place).toMatchObject({ accessNodeId: r._id });
		await f.expect_overlay_true();

		// Every place read checks `accessNodeId` the way the reader checks a saved node (Phases D, E).
		const v_can_read_place = async () =>
			await f.t.run(async (ctx) => {
				const place = (await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q.eq("target.kind", "saved").eq("target.id", plan._id).eq("userId", f.v.userId),
					)
					.unique())!;
				const reader = await files_visible_db_create_reader(ctx, f.v);
				return await reader.canRead(await ctx.db.get("files_nodes", place.accessNodeId!));
			});
		expect(await v_can_read_place()).toBe(true);

		// V loses the grant. The place stays, since derived docs do not check access, and the read check
		// now drops it.
		expect((await f.asU.mutation(api.files_sharing.remove_node_share_grant, share))._nay).toBeUndefined();
		expect((await f.overlay(target(plan), f.v)).place).toMatchObject({ isVisible: true, accessNodeId: plan._id });
		expect(await v_can_read_place()).toBe(false);
		await f.expect_overlay_true();
	});

	test("a draft move into a folder the member can no longer read hides the moved nodes from path reads", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const hr = await f.saved(null, "hr", "folder");
		const notes = await f.saved(null, "notes.md");
		const proj = await f.saved(null, "proj", "folder");
		const plan = await f.saved(proj, "plan.md");
		// V may write in open /team: V drafts `mv /notes.md /team/` and `mv /proj /team/`, then a new file
		// inside the moved folder, whose path goes through that move too.
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		const draft = await f.create_private("/team/proj/new.md", "file", f.v);

		const membershipId = f.vMember.membershipId;
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId, target: pendingTarget });
		const target_at = async (path: string) =>
			(await f.asV.query(api.files_nodes.get_visible_target_by_path, { membershipId, path }))?.target ?? null;
		const pending_view = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_pending_updates.get_file_pending_target, { membershipId, target: pendingTarget });
		const v_path_read = (path: string) =>
			f.t.run(async (ctx) => (await (await files_visible_db_create_reader(ctx, f.v)).resolvePath(path))?.path ?? null);
		expect((await f.v_find()).paths).toEqual([
			"/hr",
			"/team",
			"/team/notes.md",
			"/team/proj",
			"/team/proj/new.md",
			"/team/proj/plan.md",
		]);
		expect((await f.v_find({ kind: "file" })).paths).toEqual([
			"/team/notes.md",
			"/team/proj/new.md",
			"/team/proj/plan.md",
		]);
		expect(await pending_view(target(notes))).toMatchObject({ canAccept: true, moveDestinationUnreadable: false });

		// The owner restricts /hr without sharing it with V, then moves /team into it and renames it.
		await f.restrict(hr);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, {
				membershipId: f.db.membershipId,
				itemIds: [team._id],
				targetParentId: hr._id,
			}),
		);
		await f.as_u(() =>
			test_rename_node(f.t, f.asU, {
				membershipId: f.db.membershipId,
				nodeId: team._id,
				path: "secret",
			}),
		);
		// The derived docs still describe the draft and do not check access.
		expect((await f.overlay(target(notes), f.v)).place).toMatchObject({
			ownerTreePath: "/hr/secret/notes.md",
			destinationAccessNodeIds: [team._id],
		});
		expect((await f.overlay(draft, f.v)).place).toMatchObject({
			ownerTreePath: "/hr/secret/proj/new.md",
			accessNodeId: proj._id,
			destinationAccessNodeIds: [team._id],
		});
		await f.expect_overlay_true();

		// No read names the hidden folder. Path reads hide the moved nodes, the saved file inside the moved
		// folder, and the draft created there, like listings do. They do not fall back to a saved place.
		expect(await get_path(target(notes))).toBe(null);
		expect(await get_path(target(proj))).toBe(null);
		expect(await get_path(target(plan))).toBe(null);
		expect(await get_path(draft)).toBe(null);
		expect(await target_at("/hr/secret/notes.md")).toBe(null);
		expect(await target_at("/hr/secret/proj/new.md")).toBe(null);
		expect(await target_at("/proj/new.md")).toBe(null);
		// The agent's path read (`cat /notes.md`) finds nothing at the saved place either. The UI path
		// lookup above still opens the saved rows there, since it reads saved rows first.
		expect(await v_path_read("/notes.md")).toBe(null);
		expect(await v_path_read("/proj/plan.md")).toBe(null);
		expect(await target_at("/notes.md")).toEqual(target(notes));
		// The blocked answer does not depend on the read order: a child read first still knows.
		const blocked_in_order = (targets: files_PendingTarget[]) =>
			f.t.run(async (ctx) => {
				const reader = await files_visible_db_create_reader(ctx, f.v);
				const answers: boolean[] = [];
				for (const pendingTarget of targets) {
					await reader.resolve(pendingTarget);
					answers.push(reader.isBlocked(pendingTarget));
				}
				return answers;
			});
		expect(await blocked_in_order([draft, target(plan), target(proj), target(notes), target(hr)])).toEqual([
			true,
			true,
			true,
			true,
			false,
		]);
		expect(await blocked_in_order([target(proj), target(plan), draft])).toEqual([true, true, true]);
		// The Pending row still shows the saved node at its saved place. Accept would fail, so it is off,
		// and the row knows the path is not the destination. The draft inside the moved folder has no
		// view, so its row offers Discard only.
		expect(await pending_view(target(notes))).toMatchObject({
			entry: { path: "/notes.md" },
			canAccept: false,
			canAcceptWithParents: false,
			moveDestinationUnreadable: true,
		});
		expect(await pending_view(draft)).toBe(null);
		// Listings drop the places, and the hides still drop the saved rows, so `find` shows none of them.
		expect((await f.v_find()).paths).toEqual([]);
		expect((await f.v_find({ kind: "file" })).paths).toEqual([]);
		// `cp -r /proj` finds no folder to copy, since path reads hide /proj too. The refusal for a hidden
		// child of a folder V can still open is in the next test.
		expect(
			await files_pending_overlay_list({ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">, {
				organizationId: f.v.organizationId,
				workspaceId: f.v.workspaceId,
				visibilityUserId: f.v.userId,
				overlayUserId: f.v.userId,
				requireComplete: true,
				folderPath: "/proj",
				mode: "children",
				order: "asc",
				cursor: null,
				numItems: 50,
			}),
		).toEqual({ _yay: { items: [], continueCursor: null, isDone: true } });
	});

	test("a full listing refuses a saved node whose draft moves it into a folder the member can no longer read", async () => {
		const f = await fixture();
		const docs = await f.saved(null, "docs", "folder");
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(docs, "notes.md");
		await f.saved(docs, "readme.md");
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		// `cp -r /docs` lists every child. The moved file is not one of them.
		const list_docs = () =>
			files_pending_overlay_list({ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">, {
				organizationId: f.v.organizationId,
				workspaceId: f.v.workspaceId,
				visibilityUserId: f.v.userId,
				overlayUserId: f.v.userId,
				requireComplete: true,
				folderPath: "/docs",
				mode: "children",
				order: "asc",
				cursor: null,
				numItems: 50,
			});
		expect((await list_docs())._yay?.items.map((item) => item.path)).toEqual(["/docs/readme.md"]);

		// The owner restricts /team. Path reads now hide notes.md, and its hide and its dropped place would
		// leave it out of the copy, so the listing refuses.
		await f.restrict(team);
		expect(
			await f.asV.query(api.files_visible.get_path, { membershipId: f.vMember.membershipId, target: target(notes) }),
		).toBe(null);
		expect(await list_docs()).toEqual({
			_nay: {
				message:
					"A draft move here, or of a folder above it, goes into a folder you can no longer open. Discard that move and try again.",
			},
		});
	});

	test("a blocked draft move resolves at its destination again once the member can read it", async () => {
		const f = await fixture();
		const docs = await f.saved(null, "docs", "folder");
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(docs, "notes.md");
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		const membershipId = f.vMember.membershipId;
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId, target: pendingTarget });
		// The agent's path read, like `cat`.
		const v_path_read = (path: string) =>
			f.t.run(async (ctx) => {
				const entry = await (await files_visible_db_create_reader(ctx, f.v)).resolvePath(path);
				return entry ? { kind: entry.kind, id: entry.node._id } : null;
			});
		expect(await get_path(target(notes))).toBe("/team/notes.md");
		expect(await v_path_read("/team/notes.md")).toEqual(target(notes));

		await f.restrict(team);
		expect(await get_path(target(notes))).toBe(null);
		expect(await v_path_read("/docs/notes.md")).toBe(null);
		// Like any moved-away node, the saved path is free in V's view: the agent's write there makes a
		// new draft.
		const draft = await f.create_private("/docs/notes.md", "file", f.v);
		expect(await v_path_read("/docs/notes.md")).toEqual(draft);

		// The owner shares /team with V again.
		await f.share(team, { kind: "user", userId: f.v.userId }, "read");
		expect(await get_path(target(notes))).toBe("/team/notes.md");
		expect(await v_path_read("/team/notes.md")).toEqual(target(notes));
		expect(await v_path_read("/docs/notes.md")).toEqual(draft);
	});

	test("a draft move into a saved draft folder that is itself blocked is hidden too", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts a folder /new and `mv /notes.md /new/`, then saves the folder first. The move still
		// points at the draft folder. V then drafts `mv /new /team/`.
		const folder = await f.create_private("/new", "folder", f.v);
		await f.draft_move(target(notes), { kind: "private", id: folder.id as Id<"files_pending_nodes"> }, "notes.md", f.v);
		await f.review("accept", [await f.proposal_of(folder, f.v)], "v");
		const published = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", folder.id as Id<"files_pending_nodes">))
				.unique(),
		);
		await f.draft_move({ kind: "saved", id: published!.savedNodeId }, parent(team), "new", f.v);
		const membershipId = f.vMember.membershipId;
		const get_path = () => f.asV.query(api.files_visible.get_path, { membershipId, target: target(notes) });
		expect(await get_path()).toBe("/team/new/notes.md");

		// The owner restricts /team. The saved folder's move is blocked, so the draft folder it came from
		// is blocked too, and so is notes.md.
		await f.restrict(team);
		expect(await get_path()).toBe(null);
		expect(
			await f.asV.query(api.files_pending_updates.get_file_pending_target, { membershipId, target: target(notes) }),
		).toMatchObject({ entry: { path: "/notes.md" }, canAccept: false, moveDestinationUnreadable: true });
	});

	test("ls -t, find -name and meta search leave out the saved children of a blocked moved folder", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const proj = await f.saved(null, "proj", "folder");
		await f.saved(proj, "plan.md");
		await f.set_metadata("/proj/plan.md", [{ key: "status", value: "open" }], f.v);
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		await f.expect_overlay_true();
		const ls_t = async () => {
			const result = await files_pending_overlay_list(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.v.organizationId,
					workspaceId: f.v.workspaceId,
					visibilityUserId: f.v.userId,
					overlayUserId: f.v.userId,
					folderPath: "/",
					mode: "recent",
					order: "desc",
					numItems: 50,
					cursor: null,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path).filter((path) => path.endsWith("plan.md"));
		};
		const find_name = async () => {
			const result = await files_pending_overlay_search_name(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.v.organizationId,
					workspaceId: f.v.workspaceId,
					visibilityUserId: f.v.userId,
					overlayUserId: f.v.userId,
					folderPath: "/",
					query: "plan",
					numItems: 10,
					cursor: null,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path);
		};
		const meta_search = async () =>
			(await test_meta_search(f.t, { ...f.v, plan: { op: "exists", fieldPath: "metadata.status" } })).items.map(
				(item) => item.path,
			);
		expect(await ls_t()).toEqual(["/team/proj/plan.md"]);
		expect(await find_name()).toEqual(["/team/proj/plan.md"]);
		expect(await meta_search()).toEqual(["/team/proj/plan.md"]);

		// The owner restricts /team. No listing shows plan.md, at the destination or at its saved place.
		await f.restrict(team);
		expect(await ls_t()).toEqual([]);
		expect(await find_name()).toEqual([]);
		expect(await meta_search()).toEqual([]);
	});

	test("a draft move into a saved draft folder the member can no longer read cannot be accepted", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts a folder /team/new and `mv /notes.md /team/new/`, then saves the folder first. The move
		// still points at the draft folder, which now leads to the saved one.
		const folder = await f.create_private("/team/new", "folder", f.v);
		await f.draft_move(target(notes), { kind: "private", id: folder.id as Id<"files_pending_nodes"> }, "notes.md", f.v);
		await f.review("accept", [await f.proposal_of(folder, f.v)], "v");
		const pending_view = () =>
			f.asV.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.vMember.membershipId,
				target: target(notes),
			});
		expect(await pending_view()).toMatchObject({
			entry: { path: "/team/new/notes.md" },
			canAccept: true,
			moveDestinationUnreadable: false,
		});

		await f.restrict(team);
		expect(await pending_view()).toMatchObject({
			entry: { path: "/notes.md" },
			canAccept: false,
			moveDestinationUnreadable: true,
		});
	});

	test("a draft move inside another draft move checks both destinations", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const pub = await f.saved(null, "pub", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts `mv /notes.md /team/`, then `mv /team /pub/`: the path of notes goes through both.
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		await f.draft_move(target(team), parent(pub), "team", f.v);
		expect((await f.overlay(target(notes), f.v)).place).toMatchObject({
			ownerTreePath: "/pub/team/notes.md",
			destinationAccessNodeIds: [team._id, pub._id],
		});
		expect((await f.v_find()).paths).toEqual(["/pub", "/pub/team", "/pub/team/notes.md"]);

		// The owner restricts /pub without sharing it with V. V can still read /team, but path reads hide
		// both: the move of /team is blocked, and so is notes.md, whose path goes through it.
		await f.restrict(pub);
		await f.expect_overlay_true();
		expect((await f.v_find()).paths).toEqual([]);
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId: f.vMember.membershipId, target: pendingTarget });
		expect(await get_path(target(team))).toBe(null);
		expect(await get_path(target(notes))).toBe(null);
		// The Pending row of notes.md names its saved place, not /team/notes.md as if that were the
		// destination.
		expect(
			await f.asV.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.vMember.membershipId,
				target: target(notes),
			}),
		).toMatchObject({ entry: { path: "/notes.md" }, canAccept: false, moveDestinationUnreadable: true });
	});

	test("a moved-in folder's next page shows nothing once its destination is unreadable", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const proj = await f.saved(null, "proj", "folder");
		await f.saved(proj, "a.md");
		await f.saved(proj, "b.md");
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		const first = await f.v_find({ kind: "file", numItems: 1 });
		expect(first.paths).toEqual(["/team/proj/a.md"]);

		// The cursor keeps the moved-in folder's stream open. The path does not change, so only the
		// access check on the next page stops it.
		await f.restrict(team);
		expect((await f.v_find({ kind: "file", cursor: first.cursor })).paths).toEqual([]);
	});

	test.each([
		{ others: 31, refused: false },
		{ others: 32, refused: true },
	])(
		"U's draft on a saved node where other users hold $others hides and places is refused: $refused",
		async ({ others, refused }) => {
			const f = await fixture();
			const a = await f.saved(null, "a", "folder");
			const x = await f.saved(null, "x.md");
			// Each other user's move gives a hide and a place; an odd count ends with one draft delete.
			await test_run_with_flush(f.t, async (ctx) => {
				for (let index = 0; index * 2 < others; index++) {
					const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
					await ctx.db.insert(
						"files_pending_updates",
						proposal_doc(
							scope,
							target(x),
							index * 2 + 1 < others
								? { pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path } }
								: { pendingArchive: { fromPath: x.path } },
						),
					);
				}
			});
			await f.settle();
			const docs = await f.t.run(async (ctx) => [
				...(await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", x._id))
					.collect()),
				...(await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", x._id))
					.collect()),
			]);
			expect(docs).toHaveLength(others);

			const drafting = f.draft_move(target(x), parent(a), "x.md");
			if (refused)
				await expect(drafting).rejects.toThrow("Too many people have pending changes on x.md. Try again later.");
			else await drafting;
			expect((await f.overlay(target(x))).hidden).toBe(!refused);
			await f.expect_overlay_true();
		},
		120_000,
	);

	test("a side effect may add U's hide of a saved node where other users hold 32 hides and places", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(null, "x.md");
		// Each other user's move gives a hide and a place. A write of several users goes to jobs, which
		// never refuse.
		const crowd = async (from: number, to: number) => {
			await test_run_with_flush(f.t, async (ctx) => {
				for (let index = from; index < to; index++) {
					const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
					await ctx.db.insert(
						"files_pending_updates",
						proposal_doc(scope, target(x), {
							pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
						}),
					);
				}
			});
			await f.settle();
		};
		// U drafts `mv /x.md /b/` while other users hold 28 docs of x, then they hold 32.
		await crowd(0, 14);
		await f.draft_move(target(x), parent(b), "x.md");
		await crowd(14, 16);

		// `rm -r /b` drops U's hide of x. Its undo adds the hide back in the owner path step, not in a
		// write of x's own draft, so it is not refused.
		await f.draft_delete(target(b));
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await expect(f.undo(target(b))).resolves.toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
	}, 120_000);

	test("U's draft onto the name of a saved node where other users hold 32 hides and places is refused", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		const y = await f.saved(null, "y.md");
		await test_run_with_flush(f.t, async (ctx) => {
			for (let index = 0; index < 16; index++) {
				const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(x), {
						pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
					}),
				);
			}
		});
		await f.settle();

		// A replacing `mv /y.md /x.md` writes only y's draft. Its claim adds U's hide of x, so the cap
		// still applies.
		await expect(
			f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...f.u,
				target: target(y),
				destParent: { kind: "root" },
				destName: "x.md",
				replace: true,
			}),
		).rejects.toThrow("Too many people have pending changes on x.md. Try again later.");
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();
	}, 120_000);

	test("a proposal patch of fields the overlay does not read recomputes nothing", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_delete(target(x));
		const proposal = await f.proposal_of(target(x));
		const flush_ranges = async (patch: Partial<Doc<"files_pending_updates">>) =>
			await test_run_with_flush(f.t, async (ctx) => {
				await ctx.db.patch("files_pending_updates", proposal._id, patch);
				const before = await ctx.meta.getTransactionMetrics();
				await files_pending_overlay_db_flush(ctx);
				return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
			});

		expect(await flush_ranges({ expiresAt: proposal.expiresAt + 1, size: 1 })).toBe(0);
		// A field the overlay reads still recomputes the draft.
		expect(await flush_ranges({ updatedAt: proposal.updatedAt + 1 })).toBeGreaterThan(0);
		await f.expect_overlay_true();
	});

	test("a write to the drafts of two users recomputes them in one job per user", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.draft_move(target(x), parent(b), "x.md", f.v);
		await f.settle();
		// U's targets job doc is full, so U's new work goes to the next key.
		const key_of = (scope: Scope) => `${scope.organizationId}:${scope.workspaceId}:${scope.userId}`;
		const fullJobId = await f.t.run(async (ctx) => {
			const key = key_of(f.u);
			return await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "targets",
				userId: f.u.userId,
				key,
				items: Array.from({ length: 1000 }, () => ({ target: target(a), pendingUpdateId: null, fieldsChanged: false })),
				cursor: null,
				nextAttemptAt: Date.now() + 60 * 60 * 1000,
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "targets",
					key,
					nextAttemptAt: Date.now() + 60 * 60 * 1000,
				}),
				attempts: 0,
			});
		});

		// A hard delete of x removes both users' proposals in one transaction.
		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		expect((await f.overlay(target(x))).place).not.toBe(null);
		expect((await f.overlay(target(x), f.v)).place).not.toBe(null);
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "targets"))
				.collect(),
		);
		expect(jobs.map((job) => [job.key, job.kind === "targets" ? job.items.length : 0]).sort()).toEqual(
			[
				[key_of(f.u), 1000],
				[`${key_of(f.u)}:1`, 1],
				[key_of(f.v), 1],
			].sort(),
		);

		await f.t.run((ctx) => ctx.db.delete("files_pending_overlay_jobs", fullJobId));
		await f.settle();
		expect((await f.overlay(target(x))).place).toBe(null);
		expect((await f.overlay(target(x), f.v)).place).toBe(null);
		await f.expect_overlay_true();
	});

	test("an Accept that also writes another user's draft keeps the accepting user's docs exact at once", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		const y = await f.saved(null, "y.md");
		await f.draft_move(target(x), parent(a), "x.md");
		const proposal = await f.proposal_of(target(x));

		// Like `commit_unit`: U's draft goes, and the same transaction writes V's draft.
		await test_run_with_flush(f.t, async (ctx) => {
			files_pending_overlay_db_set_acting_user(ctx, f.u.userId);
			await ctx.db.delete("files_pending_updates", proposal._id);
			await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.v, target(y), { pendingArchive: { fromPath: y.path } }),
			);
		});
		// No job ran yet: U's docs of x are gone, and V's change waits in V's targets job.
		expect(await f.overlay(target(x))).toEqual({ hidden: false, place: null });
		expect((await f.overlay(target(y), f.v)).hidden).toBe(false);
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "targets"))
				.collect(),
		);
		expect(jobs.map((job) => job.kind === "targets" && job.userId)).toEqual([f.v.userId]);

		await f.settle();
		expect((await f.overlay(target(y), f.v)).hidden).toBe(true);
		await f.expect_overlay_true();
	});

	test("a write to two users' drafts that changes a draft's metadata syncs its place fields in the job", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		await f.set_metadata("/p", [{ key: "status", value: "draft" }]);
		const y = await f.saved(null, "y.md");
		await f.expect_overlay_true();
		const place = (await f.overlay(folder)).place!;

		// One transaction changes U's metadata value and writes V's draft, so U's recompute goes to
		// U's targets job.
		await test_run_with_flush(f.t, async (ctx) => {
			const docs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", place.pendingUpdateId))
				.collect();
			for (const doc of docs)
				if (doc.stringValue === "draft") await ctx.db.patch("files_metadata_docs", doc._id, { stringValue: "done" });
			await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.v, target(y), { pendingArchive: { fromPath: y.path } }),
			);
		});
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) =>
					q.eq("kind", "targets").eq("key", `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}`),
				)
				.unique(),
		);
		expect(job).toMatchObject({
			items: [{ target: folder, pendingUpdateId: place.pendingUpdateId, fieldsChanged: true }],
		});

		await f.settle();
		expect((await f.overlay(folder)).place!.fieldsVersion).toBeGreaterThan(place.fieldsVersion);
		const fields = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_place", (q) => q.eq("placeId", place._id))
				.collect(),
		);
		expect(fields.map((field) => field.stringValue).filter(Boolean)).toEqual(["done"]);
		await f.expect_overlay_true();
	});

	test("a hard deleted draft target sends its claim to the owner's job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const p = await f.saved(null, "p", "folder");
		const x = await f.saved(a, "x.md");
		// U drafts `mv /a/x.md /p/n.md`, then a save adds /p/n.md: U's draft claims its name.
		await f.draft_move(target(x), parent(p), "n.md");
		const n = await f.saved(p, "n.md");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);

		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		// U's own docs of x go at once; the claim on /p/n.md ends in U's targets job.
		expect((await f.overlay(target(x))).place).toBe(null);
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a claim ends when the private claimer goes after its proposal", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const claimer = await f.create_private("/p/n", "folder");
		const n = await f.saved(p, "n", "folder");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);

		// The proposal goes first: the active private node still claims the name.
		const proposal = await f.proposal_of(claimer);
		await test_run_with_flush(f.t, (ctx) => ctx.db.delete("files_pending_updates", proposal._id));
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.delete("files_pending_nodes", claimer.id as Id<"files_pending_nodes">),
		);
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a second flush in one mutation walks a folder's places again", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");

		// One mutation drafts `rm -r /b`, checks its limits (a flush), then undoes the draft.
		await test_run_with_flush(f.t, async (ctx) => {
			const id = await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.u, target(b), { pendingArchive: { fromPath: "/b" } }),
			);
			await files_pending_overlay_db_flush(ctx);
			const place = await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q.eq("target.kind", "saved").eq("target.id", x._id).eq("userId", f.u.userId),
				)
				.unique();
			expect(place).toMatchObject({ isVisible: false });
			await ctx.db.delete("files_pending_updates", id);
		});
		expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: true });
		await f.expect_overlay_true();
	});

	test("with 45 moved files, the inline step does all of them and leaves no job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const files: Doc<"files_nodes">[] = [];
		for (let index = 0; index < 45; index++) {
			const file = await f.saved(a, `x${String(index).padStart(2, "0")}.md`);
			await f.draft_move(target(file), parent(b), file.name);
			files.push(file);
		}
		await f.settle();

		await f.draft_delete(target(b));
		const visible = await Promise.all(files.map(async (file) => (await f.overlay(target(file))).place!.isVisible));
		expect(visible.filter(Boolean)).toHaveLength(0);
		const ownerPathJobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "owner_path"))
				.collect(),
		);
		expect(ownerPathJobs).toEqual([]);
		await f.expect_overlay_true();
	}, 120_000);

	test("crafted docs in a second workspace of the organization stay in their workspace", async () => {
		const f = await fixture();
		const second: Scope = {
			...f.u,
			workspaceId: await f.t.run((ctx) =>
				ctx.db.insert("organizations_workspaces", {
					organizationId: f.u.organizationId,
					name: "second",
					description: "",
					default: false,
					pluginInstallAccess: "owner",
					updatedAt: Date.now(),
				}),
			),
		};
		// In each workspace U drafts `mv /b/x.md /a/`.
		const moved: Array<{ scope: Scope; a: Doc<"files_nodes">; x: Doc<"files_nodes"> }> = [];
		for (const scope of [f.u, second]) {
			const { a, x } = await test_run_with_flush(f.t, async (ctx) => {
				const a = await insert_saved_node(ctx, scope, { parent: null, name: "a", kind: "folder" });
				const b = await insert_saved_node(ctx, scope, { parent: null, name: "b", kind: "folder" });
				const x = await insert_saved_node(ctx, scope, { parent: b, name: "x.md", kind: "file" });
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(x), {
						pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
					}),
				);
				return { a, x };
			});
			moved.push({ scope, a, x });
		}
		// One write drafts `rm -r /a` in both: each workspace's walk of `/a/` runs.
		await test_run_with_flush(f.t, async (ctx) => {
			for (const { scope, a } of moved)
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(a), { pendingArchive: { fromPath: "/a" } }),
				);
		});
		for (const { x } of moved) expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: false });

		// A proposal doc of the second workspace on a node of the first is not the first one's draft.
		const y = await f.saved(null, "y.md");
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.insert(
				"files_pending_updates",
				proposal_doc(second, target(y), { pendingArchive: { fromPath: "/y.md" } }),
			),
		);
		await test_run_with_flush(f.t, async (ctx) =>
			files_pending_overlay_db_mark_target(ctx, { ...f.u, target: target(y) }),
		);
		expect((await f.overlay(target(y))).hidden).toBe(false);
	});

	test("a place's parent becomes the saved folder only through the owner's own receipt", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		const p = await f.create_private("/p", "folder");
		const c = await f.create_private("/p/c.md");
		// A receipt of another user for U's private folder (impossible data).
		await test_run_with_flush(f.t, async (ctx) => {
			const privateNodeId = p.id as Id<"files_pending_nodes">;
			await ctx.db.patch("files_pending_nodes", privateNodeId, { state: "published" });
			await ctx.db.insert("files_pending_node_publish_receipts", {
				...f.v,
				privateNodeId,
				creationGeneration: 0,
				structuralRevision: 0,
				proposalRevision: 0,
				savedNodeId: s._id,
				createdAt: Date.now(),
			});
			files_pending_overlay_db_mark_target(ctx, { ...f.u, target: c });
		});
		expect((await f.overlay(c)).place?.parent).toEqual({ kind: "private", id: p.id });
	});

	test("two writes of one private node in Promise.all read its old doc once", async () => {
		const f = await fixture();
		const p = await f.create_private("/p.md");
		const ranges = await test_run_with_flush(f.t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const privateNodeId = p.id as Id<"files_pending_nodes">;
			await Promise.all([
				ctx.db.patch("files_pending_nodes", privateNodeId, { name: "q.md" }),
				ctx.db.patch("files_pending_nodes", privateNodeId, { structuralRevision: 5 }),
			]);
			return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
		});
		expect(ranges).toBe(1);
		expect((await f.overlay(p)).place).toMatchObject({ name: "q.md", ownerTreePath: "/q.md" });
	});
});

describe("files_pending_overlay jobs", () => {
	test("a job that throws once is retried by the recover cron", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.settle();

		// V's archive of /b schedules the parent job, and its first run throws.
		let failures = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			if ((args as { kind: string }).kind === "parent" && failures++ === 0) throw new Error("test failure");
			return await handler(ctx, args);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await f.v_archive({ id: b._id });
		expect(failures).toBe(1);
		expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: true });
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "parent"))
				.unique(),
		);
		expect(job).toMatchObject({ attempts: 0 });

		// The cron finds the late task and runs the job again.
		vi.setSystemTime(Date.now() + 16 * 60 * 1000);
		await f.t.mutation(internal.files_pending_overlay.recover_jobs, {});
		await f.settle();
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
		await f.expect_overlay_true();
	});

	test("a run scheduled for an older nextAttemptAt does nothing, so one job never runs two chains", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.settle();
		const nextAttemptAt = Date.now();
		const jobId = await f.t.run(async (ctx) =>
			ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: null,
				nextAttemptAt,
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt,
				}),
				attempts: 0,
			}),
		);
		const read_state = () =>
			f.t.run(async (ctx) => ({
				job: await ctx.db.get("files_pending_overlay_jobs", jobId),
				scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
			}));
		const before = await read_state();

		// A run retried after a newer write rescheduled the job: it must not work or schedule a next run.
		await f.t.mutation(internal.files_pending_overlay.run_job, {
			kind: "saved_node",
			key: x._id,
			nextAttemptAt: nextAttemptAt - 1,
		});
		expect(await read_state()).toEqual(before);

		await f.t.mutation(internal.files_pending_overlay.run_job, { kind: "saved_node", key: x._id, nextAttemptAt });
		// The run it was scheduled for does work.
		expect(await read_state()).not.toEqual(before);
	});

	test("a job asked again in the middle of its pass ends the pass, then walks once more", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.settle();
		// x's saved node job is in its places stream.
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: JSON.stringify({ phase: 2, page: null, isDone: false, pending: [] }),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		const renamed = await test_rename_node(f.t, f.asV, {
			membershipId: f.vMember.membershipId,
			nodeId: x._id,
			path: "y.md",
		});
		if (renamed._nay) throw new Error(renamed._nay.message);
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", x._id))
				.unique(),
		);
		expect(JSON.parse(job!.cursor!)).toMatchObject({ phase: 2, rerun: true });

		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
		await f.expect_overlay_true();
	});

	test("a saved node job that moved starts the places at its new spot from the first", async () => {
		const f = await fixture();
		// pNew sorts before pOld, so a cursor of the old spot is past every doc at the new one.
		const pNew = await f.saved(null, "pnew", "folder");
		const pOld = await f.saved(null, "pold", "folder");
		const x = await f.saved(pOld, "x");
		const claimer = await f.create_private("/pnew/x");
		await f.create_private("/pold/y", "file", f.v);
		await f.settle();
		// The cursor of one page at x's old spot, after V's private /pold/y.
		const page = await f.t.run(async (ctx) => {
			const y = await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_user_ownerTreePath", (q) =>
					q.eq("organizationId", f.v.organizationId).eq("workspaceId", f.v.workspaceId).eq("userId", f.v.userId),
				)
				.first();
			await ctx.db.patch("files_pending_places", y!._id, { name: "x" });
			return await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_parent_name", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)
						.eq("parent.kind", "saved")
						.eq("parent.id", pOld._id)
						.eq("name", "x"),
				)
				.paginate({ cursor: null, numItems: 1 });
		});
		expect(page.page).toHaveLength(1);
		// Put the place back, so only the job's own spot check is under test.
		await f.t.run((ctx) => ctx.db.patch("files_pending_places", page.page[0]!._id, { name: "y" }));
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: JSON.stringify({
					phase: 3,
					page: page.continueCursor,
					isDone: false,
					pending: [],
					range: `${pOld._id}:x`,
				}),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		// V moves x next to U's private /pnew/x, which then claims its name.
		const moved = await test_move_nodes(f.t, f.asV, {
				membershipId: f.vMember.membershipId,
				itemIds: [x._id],
				targetParentId: pNew._id,
			});
		if (moved._nay) throw new Error(moved._nay.message);
		await f.run_job("saved_node", x._id);
		expect((await f.overlay(target(x))).hidden).toBe(true);
		expect((await f.overlay(claimer)).place).toMatchObject({ ownerTreePath: "/pnew/x" });
		await f.expect_overlay_true();
	});

	test("a saved node job stores no metadata key in its cursor when it repairs pending metadata scope", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		// A Convex cursor holds the index key of its last doc. A real key can be 500k chars long, and
		// a cursor with it is too large to store in the job doc.
		const longKey = "k".repeat(2_000);
		const docCount = 6;
		await test_run_with_flush(f.t, async (ctx) => {
			for (const scope of [f.u, f.v]) {
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", proposal_doc(scope, target(x), {}));
				for (let index = 0; index < docCount; index++)
					await ctx.db.insert("files_metadata_docs", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						sourceKind: "pending",
						target: target(x),
						userId: scope.userId,
						pendingUpdateId,
						proposalRevision: 1,
						path: x.path,
						treePath: x.treePath,
						fieldPath: `frontmatter.${longKey}${index}`,
						docKind: "field",
					});
			}
		});
		await f.settle();

		// A saved write of a new path sends the scope repair to x's saved node job.
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", x._id, { name: "y.md", sortName: files_sort_text_key("y.md"), path: "/y.md", treePath: "/y.md" }),
		);
		const cursors: string[] = [];
		for (let run = 0; run < 50; run++) {
			const job = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", x._id))
					.unique(),
			);
			if (!job) break;
			if (job.cursor) cursors.push(job.cursor);
			await f.run_job("saved_node", x._id);
		}
		expect(cursors.some((cursor) => JSON.parse(cursor).phase === 5)).toBe(true);
		expect(
			cursors.filter((cursor) => cursor.includes(longKey)),
			"no stored cursor holds the metadata key",
		).toEqual([]);
		const metadata = await f.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", x._id),
				)
				.collect(),
		);
		expect(metadata).toHaveLength(2 * docCount);
		expect(metadata.every((doc) => doc.path === "/y.md" && doc.treePath === "/y.md")).toBe(true);
	});

	test("an owner path job walks a folder that moved behind the place it reached", async () => {
		const f = await fixture();
		const j = await f.saved(null, "j", "folder");
		const b = await f.saved(j, "b", "folder");
		const e = await f.saved(j, "e", "folder");
		await f.saved(j, "m", "folder");
		const s = await f.saved(j, "s", "folder");
		const g = await f.saved(s, "g", "folder");
		// U drafts `mv /j/s/g /j/b/`, a private file in g, 100 private files in /j/m and a folder /j/w.
		await f.draft_move(target(g), parent(b), "g");
		const child = await f.create_private("/j/b/g/c.md");
		for (let index = 0; index < 100; index++) await f.create_private(`/j/m/f${String(index).padStart(3, "0")}.md`);
		const w = await f.create_private("/j/w", "folder");
		await f.settle();
		const key = `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}:/j/`;
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				...f.u,
				kind: "owner_path",
				prefix: "/j/",
				key,
				cursor: null,
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "owner_path",
					key,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});
		// The first run walks one page: g, c.md and 98 files of /j/m.
		await f.run_job("owner_path", key);

		// Changes only the job's walk finds: g's draft now goes to /j/e, and /j/w is now /j/s/g. The
		// second run reaches /j/w, whose claim recomputes g behind the place the job reached.
		await f.t.run(async (ctx) => {
			const proposal = (await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.u.userId).eq("target.kind", "saved").eq("target.id", g._id),
				)
				.unique())!;
			await ctx.db.patch("files_pending_updates", proposal._id, {
				pendingMove: { ...proposal.pendingMove!, destParent: parent(e) },
			});
			await ctx.db.patch("files_pending_nodes", w.id as Id<"files_pending_nodes">, {
				parent: parent(s),
				name: "g",
			});
		});
		await f.run_job("owner_path", key);
		await f.settle();
		expect((await f.overlay(target(g))).place).toMatchObject({ ownerTreePath: "/j/e/g/" });
		expect((await f.overlay(child)).place).toMatchObject({ ownerTreePath: "/j/e/g/c.md" });
		await f.expect_overlay_true();
	}, 120_000);

	test("an owner path job keeps the furthest place it marked when a place of its page moved back", async () => {
		const f = await fixture();
		await f.saved(null, "j", "folder");
		const b = await f.create_private("/j/b", "folder");
		const c = await f.create_private("/j/b/c.md");
		const z = await f.create_private("/j/z.md");
		await f.settle();
		const placeIds = await f.t.run(async (ctx) =>
			Promise.all(
				[b, z].map(
					async (privateTarget) =>
						(await ctx.db
							.query("files_pending_places")
							.withIndex("by_target_user", (q) =>
								q.eq("target.kind", "private").eq("target.id", privateTarget.id).eq("userId", f.u.userId),
							)
							.unique())!._id,
				),
			),
		);
		// U's private /j/b is now /j/y, a change only the job's walk finds.
		await f.t.run((ctx) => ctx.db.patch("files_pending_nodes", b.id as Id<"files_pending_nodes">, { name: "y" }));
		// The job read its last page and marked places up to /j/m.md. b's place, left on that page, moved
		// back since. z keeps the job in its first stream after b: the near-limit check before z flushes
		// b's walk request.
		const key = `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}:/j/`;
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				...f.u,
				kind: "owner_path",
				prefix: "/j/",
				key,
				cursor: JSON.stringify({ phase: 0, page: null, isDone: true, pending: placeIds, lastPath: "/j/m.md" }),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "owner_path",
					key,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		// b's walk of /j/b/ is behind /j/m.md, so it gets its own job and moves c.
		await f.run_job("owner_path", key);
		await f.settle();
		expect((await f.overlay(c)).place).toMatchObject({ ownerTreePath: "/j/y/c.md" });
		await f.expect_overlay_true();
	});

	test("a parent job reuses its reader across the places it walks", async () => {
		// A job stops when fewer than 2,048 ranges are left, so this limit leaves the parent job 800 ranges.
		// One reader reads the 20 folders once: about 330 ranges for 25 places. A new reader per place reads
		// them again, about 100 ranges per place.
		const f = await fixture({ databaseQueries: 2_048 + 800 });
		const top = await f.saved(null, "c00", "folder");
		let folder = top;
		let path = "/c00";
		for (let depth = 1; depth < 20; depth++) {
			const name = `c${String(depth).padStart(2, "0")}`;
			folder = await f.saved(folder, name, "folder");
			path += `/${name}`;
		}
		for (let index = 0; index < 25; index++) await f.create_private(`${path}/f${String(index).padStart(3, "0")}.md`);
		await f.settle();

		let parentRuns = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			if ((args as { kind: string }).kind === "parent") parentRuns++;
			return await handler(ctx, args);
		});
		// V's rename of the top folder moves every place under the deepest one.
		await f.v_rename({ id: top._id }, "top");
		// Places, incoming moves and private children each have their own native page.
		expect(parentRuns).toBe(3);
		await f.expect_overlay_true();
	}, 120_000);

	test("a repair syncs a place's fields once", async () => {
		const f = await fixture();
		await f.create_private("/m", "folder");
		await f.set_metadata(
			"/m",
			Array.from({ length: 128 }, (_, index) => ({ key: `k${index}`, value: `v${index}` })),
		);
		await f.settle();

		let documentsRead = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).repair_user, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			documentsRead += (await ctx.meta.getTransactionMetrics()).documentsRead.used;
			return result;
		});
		await f.t.mutation(internal.files_pending_overlay.repair_user, { ...f.u, cursor: null });
		await f.settle();
		// About 1,000 docs. A sync per field doc would read the 128 fields again for each one.
		expect(documentsRead).toBeLessThan(3_000);
		await f.expect_overlay_true();
	}, 120_000);
});

describe("files_share_rows", () => {
	test("share dialog writes keep one row per shared user or role", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		// The owner holds no grant, so the new restricted folder has no row.
		expect(await share_keys(f, s._id)).toEqual([]);

		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		// "manage" adds more grants, but only the read grant has a row.
		await f.share(s, { kind: "user", userId: f.v.userId }, "manage");
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		// A role share is one row, not one row per member.
		await f.share(s, { kind: "role", role: "member" }, "read");
		expect(await share_keys(f, s._id)).toEqual(["role:member", `user:${f.v.userId}`]);

		await f.as_u(() =>
			f.asU.mutation(api.files_sharing.remove_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: s._id,
				principal: { kind: "user", userId: f.v.userId },
			}),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("rows follow a rename, move, archive and restore of the shared folder and of its parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const s = await f.saved(a, "s", "folder");
		const b = await f.saved(null, "b", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const membershipId = f.db.membershipId;

		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: s._id, path: "t" }));
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: a._id }]);
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: a._id, path: "a2" }));
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: a._id }]);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, { membershipId, itemIds: [s._id], targetParentId: b._id }),
		);
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: b._id }]);
		await f.expect_share_rows_true();

		// Archiving the parent archives the shared folder too. Archived rows stay.
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [b._id] }));
		expect((await share_rows(f, s._id))[0]?.archiveOperationId).not.toBe(null);
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [b._id] }));
		expect(await share_rows(f, s._id)).toMatchObject([{ archiveOperationId: null }]);
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [s._id] }));
		expect((await share_rows(f, s._id))[0]?.archiveOperationId).not.toBe(null);
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [s._id] }));
		expect(await share_rows(f, s._id)).toMatchObject([{ archiveOperationId: null }]);
		await f.expect_share_rows_true();
	});

	test("rows live only while their node is a restricted root", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.share(s, { kind: "role", role: "member" }, "read");

		// A node write alone ends and brings back the rows, while the grants stay.
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", s._id, { restrictedScopeNodeId: null, isRestrictedScopeRoot: false }),
		);
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", s._id, { restrictedScopeNodeId: s._id, isRestrictedScopeRoot: true }),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member", `user:${f.v.userId}`]);

		await f.as_u(() =>
			f.asU.mutation(api.files_sharing.unrestrict_node, { membershipId: f.db.membershipId, nodeId: s._id }),
		);
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
	});

	test("a hard deleted shared file leaves no row", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.restrict(x);
		await f.share(x, { kind: "user", userId: f.v.userId }, "read");
		expect(await share_rows(f, x._id)).toMatchObject([{ kind: "file", lowercaseExtension: "md" }]);

		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		expect(await share_keys(f, x._id)).toEqual([]);
		await f.expect_share_rows_true();
	});

	test("removing a member from the organization removes the member's rows", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.share(s, { kind: "role", role: "member" }, "read");

		// The fixture inserts V's membership directly. Removal also needs V's credential quota.
		await f.t.run((ctx) => quotas_db_ensure(ctx, { quotaName: "active_api_credentials", ...f.v, now: Date.now() }));
		await f.as_u(() =>
			f.asU.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.u.organizationId,
				userIdToRemove: f.v.userId,
			}),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("a grant of another workspace on the node gets no row, also after the node changes", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		const secondWorkspaceId = await f.t.run((ctx) =>
			ctx.db.insert("organizations_workspaces", {
				organizationId: f.u.organizationId,
				name: "second",
				description: "",
				default: false,
				pluginInstallAccess: "owner",
				updatedAt: Date.now(),
			}),
		);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.u.organizationId,
				workspaceId: secondWorkspaceId,
				resourceKind: "file",
				resourceId: String(s._id),
				principalKind: "user",
				userId: f.v.userId,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		expect(await share_keys(f, s._id)).toEqual([]);

		await f.as_u(() =>
			test_rename_node(f.t, f.asU, { membershipId: f.db.membershipId, nodeId: s._id, path: "t" }),
		);
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await f.expect_share_rows_true(secondWorkspaceId);
	});

	test("service account and public grants on a shared folder get no row", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await test_run_with_flush(f.t, async (ctx) => {
			const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				name: "bot",
				createdBy: f.u.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			});
			for (const principal of [
				{ principalKind: "service_account" as const, serviceAccountId },
				{ principalKind: "public" as const },
			])
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: f.u.organizationId,
					workspaceId: f.u.workspaceId,
					resourceKind: "file",
					resourceId: String(s._id),
					...principal,
					permission: "content.read",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
		});
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);

		// A node write reads every `content.read` grant of the node again.
		await f.as_u(() =>
			test_rename_node(f.t, f.asU, { membershipId: f.db.membershipId, nodeId: s._id, path: "t" }),
		);
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		await f.expect_share_rows_true();
	});

	test("a grant write that is not a file grant marks nothing", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		const grant = (resourceKind: "workspace" | "plugin_scope" | "file", resourceId: string) => ({
			organizationId: f.u.organizationId,
			workspaceId: f.u.workspaceId,
			resourceKind,
			resourceId,
			principalKind: "user" as const,
			userId: f.v.userId,
			permission: "content.read" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const flush_ranges = async (write: (ctx: MutationCtx) => Promise<unknown>) =>
			await test_run_with_flush(f.t, async (ctx) => {
				await write(ctx);
				const before = await ctx.meta.getTransactionMetrics();
				await files_pending_overlay_db_flush(ctx);
				return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
			});

		expect(
			await flush_ranges(async (ctx) => {
				const workspaceGrantId = await ctx.db.insert(
					"access_control_permission_grants",
					grant("workspace", f.u.workspaceId),
				);
				const scopeGrantId = await ctx.db.insert(
					"access_control_permission_grants",
					grant("plugin_scope", "plugin:scope"),
				);
				await ctx.db.patch("access_control_permission_grants", workspaceGrantId, { updatedAt: Date.now() + 1 });
				await ctx.db.delete("access_control_permission_grants", scopeGrantId);
			}),
		).toBe(0);
		// A file grant write still syncs its row.
		expect(
			await flush_ranges((ctx) => ctx.db.insert("access_control_permission_grants", grant("file", String(s._id)))),
		).toBeGreaterThan(0);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_rows").collect())).toEqual([]);
		await f.expect_share_rows_true();
	});

	test("a size patch and a content save of a shared file update its rows", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.restrict(x);
		await f.share(x, { kind: "user", userId: f.v.userId }, "read");

		// A materialization patches the size alone. A content save also patches `updatedAt`.
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", x._id, { contentByteSize: 42 }));
		expect(await share_rows(f, x._id)).toMatchObject([{ contentByteSize: 42 }]);
		const savedAt = Date.now() + 1000;
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", x._id, { contentByteSize: 99, updatedBy: f.u.userId, updatedAt: savedAt }),
		);
		expect(await share_rows(f, x._id)).toMatchObject([{ contentByteSize: 99, updatedAt: savedAt }]);
		await f.expect_share_rows_true();
	});

	test("a shared folder keeps its rows when its parent is restricted and when it moves into another restricted folder", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const s = await f.saved(a, "s", "folder");
		const r = await f.saved(null, "r", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.restrict(r);
		await f.share(r, { kind: "role", role: "member" }, "read");

		await f.restrict(a);
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, {
					membershipId: f.db.membershipId,
					itemIds: [s._id],
					targetParentId: r._id,
				}),
		);
		expect(await share_rows(f, s._id)).toMatchObject([{ principalKey: `user:${f.v.userId}`, parentId: r._id }]);
		expect(await share_keys(f, r._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("a node write that changes only its workspace drops its rows", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const secondWorkspaceId = await f.t.run((ctx) =>
			ctx.db.insert("organizations_workspaces", {
				organizationId: f.u.organizationId,
				name: "second",
				description: "",
				default: false,
				pluginInstallAccess: "owner",
				updatedAt: Date.now(),
			}),
		);

		// No app code moves a node to another workspace. The rows must still never copy such a node.
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", s._id, { workspaceId: secondWorkspaceId }));
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await f.expect_share_rows_true(secondWorkspaceId);
	});
});

describe("files_nodes ancestors", () => {
	/**
	 * The active node at a path, with its stored ancestor ids.
	 */
	const node_at = async (f: Fixture, path: string) => {
		const node = await f.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", path),
				)
				.first(),
		);
		if (!node) throw new Error(`Expected a node at ${path}`);
		return { ...node, ancestors: files_ancestor_ids(node) };
	};

	/**
	 * Run the jobs, then check that every node copies its parent's ancestors plus the parent.
	 */
	const expect_ancestors_true = async (f: Fixture) => {
		await f.settle();
		const differences: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { differences: string[]; cursor: string | null } = await f.t.query(
				internal.files_pending_overlay.check_ancestors,
				{ cursor },
			);
			differences.push(...page.differences);
			cursor = page.cursor;
		} while (cursor);
		expect(differences).toEqual([]);
	};

	test("inserts, a rename, a move and a nested move keep every node's ancestors", async () => {
		const f = await fixture();
		const membershipId = f.db.membershipId;
		// Each mutation inserts a folder and the folders inside it in one round.
		const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.u, path: "/a/b/c" });
		if (created._nay) throw new Error(created._nay.message);
		await f.as_u(() =>
			f.asU.mutation(api.files_nodes.create_folder_node, { membershipId, parentId: files_ROOT_ID, path: "d/e" }),
		);
		const a = await node_at(f, "/a");
		const b = await node_at(f, "/a/b");
		const d = await node_at(f, "/d");
		expect(a.ancestors).toEqual([]);
		expect((await node_at(f, "/a/b/c")).ancestors).toEqual([a._id, b._id]);
		expect((await node_at(f, "/d/e")).ancestors).toEqual([d._id]);
		await expect_ancestors_true(f);

		// A rename changes paths, not ancestors.
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: a._id, path: "a2" }));
		expect((await node_at(f, "/a2/b/c")).ancestors).toEqual([a._id, b._id]);

		// `b` moves into `/d/e`, and its child follows it in the move's subtree step.
		const e = await node_at(f, "/d/e");
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, { membershipId, itemIds: [b._id], targetParentId: e._id }),
		);
		expect((await node_at(f, "/d/e/b")).ancestors).toEqual([d._id, e._id]);
		expect((await node_at(f, "/d/e/b/c")).ancestors).toEqual([d._id, e._id, b._id]);

		// A nested move: `d` with everything inside moves into `/a2`.
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, { membershipId, itemIds: [d._id], targetParentId: a._id }),
		);
		expect((await node_at(f, "/a2/d")).ancestors).toEqual([a._id]);
		expect((await node_at(f, "/a2/d/e/b/c")).ancestors).toEqual([a._id, d._id, e._id, b._id]);
		await expect_ancestors_true(f);
	});

	test("a restore under a new parent and an accepted draft move keep every node's ancestors", async () => {
		const f = await fixture();
		const membershipId = f.db.membershipId;
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(a, "b", "folder");
		const x = await f.saved(b, "x.md");
		const z = await f.saved(null, "z", "folder");
		expect((await node_at(f, "/a/b/x.md")).ancestors).toEqual([a._id, b._id]);

		// `b` comes back while its folder stays archived by another operation, so it lands at the root.
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [b._id] }));
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [a._id] }));
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [b._id] }));
		expect((await node_at(f, "/b")).ancestors).toEqual([]);
		expect((await node_at(f, "/b/x.md")).ancestors).toEqual([b._id]);
		await expect_ancestors_true(f);

		// The Accept writes the move inside its counted unit.
		await f.draft_move(target(b), parent(z), "b");
		await f.review("accept", [await f.proposal_of(target(b))]);
		expect((await node_at(f, "/z/b")).ancestors).toEqual([z._id]);
		expect((await node_at(f, "/z/b/x.md")).ancestors).toEqual([z._id, b._id]);
		expect(x._id).toBe((await node_at(f, "/z/b/x.md"))._id);
		await expect_ancestors_true(f);
	});

	test("a node more than 12 folders deep keeps the top 12", async () => {
		const f = await fixture();
		const folders: Doc<"files_nodes">[] = [];
		for (let depth = 1; depth <= 14; depth++)
			folders.push(await f.saved(folders.at(-1) ?? null, `f${depth}`, "folder"));
		const deep = await f.saved(folders.at(-1)!, "deep.md");
		const top12 = folders.slice(0, 12).map((folder) => folder._id);
		expect((await node_at(f, deep.path)).ancestors).toEqual(top12);
		expect((await node_at(f, folders[12]!.path)).ancestors).toEqual(top12);
		expect((await node_at(f, folders[11]!.path)).ancestors).toEqual(top12.slice(0, 11));
		await expect_ancestors_true(f);
	});

	test("a files_nodes patch that mixes ancestor fields with other fields throws", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await expect(
			test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", x._id, { ancestor1: a._id, name: "y.md" })),
		).rejects.toThrow("A files_nodes patch mixes ancestor fields with other fields");
	});
});
