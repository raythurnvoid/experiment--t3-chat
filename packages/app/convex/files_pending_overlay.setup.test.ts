// Fixtures shared by the files_pending_overlay test files.
import { expect, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_convex,
	test_rename_node,
	test_move_nodes,
	test_finish_pending_update_run,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_pending_overlay_list } from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { type files_PendingParent, type files_PendingTarget } from "../shared/files.ts";

export type Scope = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
};

export async function insert_saved_node(
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
export async function expect_window_bound(t: ReturnType<typeof test_convex>) {
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
			lowercaseExtension: hide.lowercaseExtension,
			treePath: hide.treePath,
		}).toEqual({
			parentId: node!.parentId,
			kind: node!.kind,
			name: node!.name,
			lowercaseExtension: node!.lowercaseExtension,
			treePath: node!.treePath,
		});
	}
}

export async function fixture(transactionLimits?: NonNullable<Parameters<typeof test_convex>[0]>["transactionLimits"]) {
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
			subject: { kind: "user", userId: v.userId, plugin: null },
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
export async function add_member(ctx: MutationCtx, scope: Omit<Scope, "userId">, clerkUserId: string): Promise<Scope> {
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
export function proposal_doc(
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

export const target = (node: Doc<"files_nodes">): files_PendingTarget => ({ kind: "saved", id: node._id });
export const parent = (node: Doc<"files_nodes">): files_PendingParent => ({ kind: "saved", id: node._id });

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A node's share rows by principal. Each row must copy the live node.
 */
export async function share_rows(f: Fixture, nodeId: Id<"files_nodes">) {
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
			treePath: row.treePath,
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
			treePath: node?.treePath,
			updatedAt: node?.updatedAt,
			lowercaseExtension: node?.lowercaseExtension ?? null,
			contentByteSize: node?.contentByteSize ?? null,
			nodeCreationTime: node?._creationTime,
		});
	return rows.toSorted((a, b) => (a.principalKey < b.principalKey ? -1 : 1));
}

export const share_keys = async (f: Fixture, nodeId: Id<"files_nodes">) =>
	(await share_rows(f, nodeId)).map((row) => row.principalKey);
