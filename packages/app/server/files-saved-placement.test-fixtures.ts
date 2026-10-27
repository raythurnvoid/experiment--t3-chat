import { vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_saved_placement_db_get_node } from "./files-saved-placement.ts";

function placement_header(node: Doc<"files_nodes">) {
	const {
		_id: _id,
		_creationTime: _time,
		organizationId: _org,
		workspaceId: _ws,
		createdBy: _creator,
		writePolicy: _policy,
		newChildWritePolicy: _childPolicy,
		moveCohortId: _marker,
		scopeOpId: _scopeOp,
		...header
	} = node;
	return header;
}

// Seeds before and after docs for reader tests. Native producer tests use real worker steps.
export async function test_create_saved_placement_fixture(args?: {
	normalPaths?: string[];
	signedIn?: boolean;
	transactionLimits?: NonNullable<Parameters<typeof test_convex>[0]>["transactionLimits"];
	beforeMove?: (args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		nodeId: Id<"files_nodes">;
		parentId: Id<"files_nodes">;
		normalNodes: Map<string, Id<"files_nodes">>;
	}) => Promise<void>;
}) {
	const t = test_convex({ transactionLimits: args?.transactionLimits });
	const db = await t.run(async (ctx) =>
		test_mocks_fill_db_with.membership(
			ctx,
			args?.signedIn ? { userId: await ctx.db.insert("users", { clerkUserId: "saved-placement-test" }) } : undefined,
		),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/old.txt",
		textContent: "old text",
	});
	const created = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/target",
	});
	if (created._nay) throw new Error(created._nay.message);
	const parentId = created._yay.nodeId;
	const normalNodes = new Map<string, Id<"files_nodes">>();
	for (const path of args?.normalPaths ?? []) {
		normalNodes.set(
			path,
			await test_create_saved_text_file(t, { membershipId: db.membershipId, path, textContent: path }),
		);
	}
	const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "saved", id: nodeId },
		destParent: { kind: "saved", id: parentId },
		destName: "new.txt",
	});
	if (moved._nay) throw new Error(moved._nay.message);
	await args?.beforeMove?.({ t, db, nodeId, parentId, normalNodes });
	const overlay = await import("./files-pending-overlay.ts");
	const canJoin = overlay.files_pending_overlay_db_can_join_step;
	// These reader tests seed candidates by hand. Yield before the real cohort starts them.
	const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx) => {
		const allowed = await canJoin(ctx);
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
			.unique();
		return allowed && !slot?.cohortId;
	});
	let originItem: Doc<"files_transfer_items"> | null = null;
	let startedCohortId: Id<"files_move_cohorts"> | null = null;
	try {
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "foundation",
			kind: "move",
			sourceIds: [nodeId],
			expectedSourceCount: 1,
			targetParentId: parentId,
		});
		if (started._nay) throw new Error(started._nay.message);
		for (let step = 0; step < 20; step++) {
			originItem = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.first(),
			);
			startedCohortId = await t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("files_move_workspace_slots")
							.withIndex("by_workspace", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
							)
							.unique()
					)?.cohortId ?? null,
			);
			if (originItem && startedCohortId) break;
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		}
	} finally {
		join.mockRestore();
	}
	if (!originItem || !startedCohortId) throw new Error("Expected the public Transfer origin item and cohort");
	const cohortId = startedCohortId;
	const itemId = originItem._id;
	const saved = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	if (!saved) throw new Error("Expected the saved source");
	const proposal = await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique(),
	);
	if (!proposal) throw new Error("Expected the move proposal");
	// Reader tests own these views. Pause the real worker before filling its candidates.
	const cohort = await t.run(async (ctx) => {
		const cohort = (await ctx.db.get("files_move_cohorts", cohortId))!;
		if (cohort.runJob) await ctx.scheduler.cancel(cohort.runJob.id);
		await ctx.db.patch("files_move_cohorts", cohortId, {
			runJob: undefined,
			reviewDeadlineAt: Date.now() + 60_000,
			phase: "staging",
			stagedItemCount: 1,
			affectedNodeCount: 1,
		});
		return cohort;
	});
	const header = placement_header(saved);
	const before = {
		cohortId,
		view: "before" as const,
		nodeId,
		nodeCreationTime: saved._creationTime,
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		...header,
		contentId: null,
	};
	const after = {
		...before,
		view: "after" as const,
		parentId,
		name: "new.txt",
		sortName: files_sort_text_key("new.txt"),
		path: "/target/new.txt",
		treePath: "/target/new.txt",
		pathDepth: 2,
		ancestor1: parentId,
		updatedAt: saved.updatedAt + 10,
		contentTooLargeByteSize: 1,
		contentShapeMismatchAt: 2,
		contentYjsStateTooLargeByteSize: 3,
		contentFrontmatterTooLargeFieldCount: 4,
		contentFrontmatterTooLargeIndexDocumentCount: 5,
	};
	const recordId = await t.run(async (ctx) => {
		const beforePlaceId = await ctx.db.insert("files_saved_places", before);
		const afterPlaceId = await ctx.db.insert("files_saved_places", after);
		const recordId = await ctx.db.insert("files_move_cohort_nodes", {
			cohortId,
			nodeId,
			order: 0,
			role: "selected",
			itemId: null,
			beforePlaceId,
			afterPlaceId,
			sourceContentVersion: null,
			status: "staged",
			validatedEpoch: null,
			sourceReservationId: null,
		});
		await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
		await ctx.db.insert("files_move_slot_claims", {
			cohortId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: "root",
			name: "old.txt",
			beforeNodeId: nodeId,
			afterNodeId: null,
		});
		await ctx.db.insert("files_move_slot_claims", {
			cohortId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId,
			name: "new.txt",
			beforeNodeId: null,
			afterNodeId: nodeId,
		});
		return recordId;
	});
	// Move code copies the view onto the slot in the same write, so these do both too.
	const setView = (
		cohortPatch: Partial<Doc<"files_move_cohorts">>,
		slotPatch: Partial<
			Pick<
				Extract<Doc<"files_move_workspace_slots">, { cohortId: Id<"files_move_cohorts"> }>,
				"visibleView" | "migrationDirection"
			>
		>,
	) =>
		t.run(async (ctx) => {
			await ctx.db.patch("files_move_cohorts", cohortId, cohortPatch);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique();
			if (!slot) throw new Error("Expected the fixture slot");
			await ctx.db.patch("files_move_workspace_slots", slot._id, slotPatch);
		});
	const publish = () =>
		setView(
			{ phase: "published", visibleView: "after", publishedAt: Date.now() },
			{ visibleView: "after", migrationDirection: "to_normal" },
		);
	const abort = () => setView({ phase: "aborting" }, { migrationDirection: "to_normal" });
	const stageNode = (nodeId: Id<"files_nodes">) =>
		t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const cohort = await ctx.db.get("files_move_cohorts", cohortId);
			if (!node || !cohort) throw new Error("Expected a saved fixture node and cohort");
			const place = {
				...placement_header(node),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				cohortId,
				nodeId,
				nodeCreationTime: node._creationTime,
				contentId: null,
			};
			const beforePlaceId = await ctx.db.insert("files_saved_places", { ...place, view: "before" });
			const afterPlaceId = await ctx.db.insert("files_saved_places", { ...place, view: "after" });
			await ctx.db.insert("files_move_cohort_nodes", {
				cohortId,
				nodeId,
				order: cohort.affectedNodeCount,
				role: "anchor",
				itemId: null,
				beforePlaceId,
				afterPlaceId,
				sourceContentVersion: null,
				status: "staged",
				validatedEpoch: null,
				sourceReservationId: null,
			});
			await ctx.db.insert("files_move_slot_claims", {
				cohortId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: node.parentId,
				name: node.name,
				beforeNodeId: nodeId,
				afterNodeId: nodeId,
			});
			await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
			await ctx.db.patch("files_move_cohorts", cohortId, { affectedNodeCount: cohort.affectedNodeCount + 1 });
		});
	const materializeNode = (nodeId: Id<"files_nodes">) =>
		t.run(async (ctx) => {
			const record = await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", nodeId))
				.unique();
			if (!record) throw new Error("Expected a staged fixture node");
			const node = await files_saved_placement_db_get_node(ctx.db, nodeId);
			if (!node) throw new Error("Expected the selected fixture node");
			await ctx.db.patch("files_nodes", nodeId, { ...placement_header(node), moveCohortId: undefined });
			if (record.beforePlaceId) await ctx.db.delete("files_saved_places", record.beforePlaceId);
			if (record.afterPlaceId) await ctx.db.delete("files_saved_places", record.afterPlaceId);
			await ctx.db.patch("files_move_cohort_nodes", record._id, {
				beforePlaceId: null,
				afterPlaceId: null,
				status: "materialized",
			});
		});
	return {
		t,
		db,
		asUser,
		saved,
		nodeId,
		parentId,
		cohortId,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
		itemId,
		recordId,
		proposal,
		before,
		after,
		publish,
		abort,
		normalNodes,
		stageNode,
		materializeNode,
	};
}
