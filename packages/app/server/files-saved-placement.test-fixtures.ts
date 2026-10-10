import { expect } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { files_media_validation_db_capture_versions } from "../convex/files_media_validation.ts";
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
		...header
	} = node;
	return header;
}

// Seeds before and after docs for reader tests. Native producer tests use real worker steps.
export async function test_create_saved_placement_fixture(args?: { normalPaths?: string[]; signedIn?: boolean }) {
	const t = test_convex();
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
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: "foundation",
		kind: "move",
		sourceIds: [nodeId],
		expectedSourceCount: 1,
		targetParentId: parentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
	).toEqual({ _yay: null });
	// Public intake produces the origin item. These reader tests stage its candidates below.
	let originItem = await t.run((ctx) =>
		ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
			.first(),
	);
	for (let step = 0; !originItem && step < 20; step++) {
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		originItem = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.first(),
		);
	}
	if (!originItem) throw new Error("Expected the public Transfer origin item");
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
	const cohortId = await t.run(async (ctx) => {
		const run = await ctx.db.get("files_transfer_runs", started._yay.runId);
		if (!run) throw new Error("Expected the Transfer origin");
		const pins = await files_media_validation_db_capture_versions(ctx, { userId: db.userId, scopes: [db] });
		const organization = pins.versions[0] as Doc<"files_move_cohorts">["clockPins"]["organization"];
		const workspace = pins.versions[1] as Doc<"files_move_cohorts">["clockPins"]["workspace"];
		const review = pins.pendingVersions[0]!;
		const cohortId = await ctx.db.insert("files_move_cohorts", {
			...db,
			membershipLifetime: run.sourceScope.membershipLifetime,
			origin: { kind: "transfer", runId: run._id, itemId },
			slotGeneration: 1,
			fence: 1,
			attemptFence: 1,
			workId: null,
			deadlineAt: Date.now() + 60_000,
			reviewDeadlineAt: Date.now() + 60_000,
			phase: "staging",
			visibleView: "before",
			step: 0,
			workPhase: "items",
			operationTime: Date.now(),
			publishedAt: null,
			itemCount: 1,
			stagedItemCount: 1,
			validatedItemCount: 0,
			pendingWorkCount: 0,
			affectedNodeCount: 1,
			materializedNodeCount: 0,
			proofEpoch: 1,
			clockPins: { organization, workspace, review },
			billedUserId: db.userId,
			contentCostCents: 0,
			storedByteDelta: 0,
			storedFileCount: 0,
			privateByteDelta: 0,
			privateNodeDelta: 0,
			privateAccountingApplied: false,
			billingApplied: false,
			planningCursor: null,
			stagingCursor: null,
			validationCursor: null,
			cleanupCursor: null,
			errorCode: null,
			errorMessage: null,
			conflictItemId: null,
		});
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
			.unique();
		if (slot?.cohortId) throw new Error("Expected finished fixture Save jobs");
		if (slot)
			await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId, generation: 1, searchGeneration: 2 });
		else
			await ctx.db.insert("files_move_workspace_slots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				cohortId,
				generation: 1,
				searchGeneration: 2,
			});
		return cohortId;
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
	const publish = () =>
		t.run((ctx) =>
			ctx.db.patch("files_move_cohorts", cohortId, {
				phase: "published",
				visibleView: "after",
				publishedAt: Date.now(),
			}),
		);
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
		itemId,
		recordId,
		proposal,
		before,
		after,
		publish,
		normalNodes,
		stageNode,
		materializeNode,
	};
}
