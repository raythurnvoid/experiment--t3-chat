import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { billing_event } from "../server/billing.ts";
import {
	files_db_reschedule_pending_update_cleanup_for_user,
	files_FIRST_VERSION,
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "../server/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

let enqueueActionSpy: MockInstance;

beforeEach(() => {
	// Keep pending-edit tests off the real billing workpool while still letting
	// focused cases assert whether a file-save event was enqueued.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_pending_update_test_billing_event" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	const usageSnapshot = await ctx.db
		.query("billing_usage_snapshots")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	if (usageSnapshot) return;

	const polarProductId = "pending_update_test_free_product";
	const existingProduct = await ctx.runQuery(components.polar.lib.getProduct, { id: polarProductId });
	if (!existingProduct) {
		await ctx.runMutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "pending_update_test_org",
				name: billing_PRODUCTS.Free.name,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [
					{
						id: `${polarProductId}_price`,
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "free",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						recurringInterval: "month",
					},
				],
				medias: [],
				benefits: [],
			},
		});
	}

	await ctx.db.insert("billing_usage_snapshots", {
		userId,
		polarCustomerId: `pending_update_test_customer_${userId}`,
		subscription: {
			id: `pending_update_test_subscription_${userId}`,
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter: {
			id: "meter_press_usage",
			consumedUnits: 0,
			creditedUnits: 100_000,
			balance: 100_000,
			amountDueCents: 0,
		},
		lastSyncedAt: Date.now(),
	});
}

async function seed_file_with_markdown(args: {
	ctx: MutationCtx;
	path: string;
	name: string;
	markdown: string;
	membership?: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		membershipId: Id<"workspaces_projects_users">;
	};
}) {
	const { ctx, path, name, markdown } = args;
	const membership = args.membership ?? (await test_mocks_fill_db_with.membership(ctx));
	const { userId, workspaceId, projectId, membershipId } = membership;
	await seed_billing_snapshot_for_user(ctx, userId);

	const nodeId = await ctx.db.insert("files_nodes", {
		workspaceId,
		projectId,
		path,
		name,
		kind: "file",
		version: files_FIRST_VERSION,
		parentId: files_ROOT_ID,
		createdBy: userId,
		updatedBy: String(userId),
		updatedAt: Date.now(),
		archiveOperationId: undefined,
	});

	const markdownContentId = await ctx.db.insert("files_markdown_content", {
		workspaceId: workspaceId,
		projectId: projectId,
		nodeId: nodeId,
		content: markdown,
		isArchived: false,
		yjsSequence: 0,
		updatedAt: Date.now(),
		updatedBy: String(userId),
	});

	const baseYjsDoc = new YDoc();
	const baseYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
		mut_yjsDoc: baseYjsDoc,
		markdown,
	});
	if (baseYjsDocFromMarkdown._nay) {
		throw new Error("Failed to seed base Yjs doc from markdown");
	}

	const baseMarkdownResult = files_yjs_doc_get_markdown({
		yjsDoc: baseYjsDoc,
	});
	if (baseMarkdownResult._nay) {
		throw new Error("Failed to seed base markdown from Yjs doc");
	}

	const snapshotId = await ctx.db.insert("files_yjs_snapshots", {
		workspaceId: workspaceId,
		projectId: projectId,
		nodeId: nodeId,
		sequence: 0,
		snapshotUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
		createdBy: userId,
		updatedBy: String(userId),
		updatedAt: Date.now(),
	});

	const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
		workspaceId: workspaceId,
		projectId: projectId,
		nodeId: nodeId,
		lastSequence: 0,
	});

	await ctx.db.patch("files_nodes", nodeId, {
		markdownContentId,
		yjsSnapshotId: snapshotId,
		yjsLastSequenceId: lastSequenceId,
	});

	return {
		workspaceId,
		projectId,
		membershipId,
		userId,
		nodeId,
		baseMarkdown: baseMarkdownResult._yay,
	};
}

let seed_signed_in_file_user_counter = 0;

async function seed_signed_in_file_with_markdown(
	args: Omit<Parameters<typeof seed_file_with_markdown>[0], "membership">,
) {
	const userId = await args.ctx.db.insert("users", {
		clerkUserId: `clerk_pending_update_test_${seed_signed_in_file_user_counter++}`,
	});
	const membership = await test_mocks_fill_db_with.membership(args.ctx, {
		userId,
	});
	return await seed_file_with_markdown({
		...args,
		membership,
	});
}

async function read_file_markdown_from_yjs(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	nodeId: Id<"files_nodes">;
}) {
	const { ctx, workspaceId, projectId, nodeId } = args;
	const file = await ctx.db.get("files_nodes", nodeId);
	if (!file || !file.yjsSnapshotId) {
		throw new Error("File missing while reading markdown from Yjs");
	}

	const snapshot = await ctx.db.get("files_yjs_snapshots", file.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("Snapshot missing while reading markdown from Yjs");
	}

	const updates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_workspace_project_file_sequence", (q) =>
			q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("nodeId", file._id),
		)
		.order("asc")
		.collect();

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshot.snapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	const markdown = files_yjs_doc_get_markdown({ yjsDoc });
	if (markdown._nay) {
		throw new Error("Failed to read markdown from Yjs");
	}

	return markdown._yay;
}

function normalize_pending_update_markdown(markdown: string) {
	const yjsDoc = new YDoc();
	const updateMarkdownResult = files_yjs_doc_update_from_markdown({
		mut_yjsDoc: yjsDoc,
		markdown,
	});
	if (updateMarkdownResult._nay) {
		throw new Error("Failed to normalize pending update markdown");
	}

	const normalizedMarkdown = files_yjs_doc_get_markdown({
		yjsDoc,
	});
	if (normalizedMarkdown._nay) {
		throw new Error("Failed to read normalized pending update markdown");
	}

	return normalizedMarkdown._yay;
}

async function read_file_yjs_state(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	nodeId: Id<"files_nodes">;
}) {
	const { ctx, workspaceId, projectId, nodeId } = args;
	const file = await ctx.db.get("files_nodes", nodeId);
	if (!file || !file.yjsSnapshotId || !file.yjsLastSequenceId) {
		throw new Error("File missing while reading Yjs state");
	}

	const [snapshot, lastSequenceDoc, updates] = await Promise.all([
		ctx.db.get("files_yjs_snapshots", file.yjsSnapshotId),
		ctx.db.get("files_yjs_docs_last_sequences", file.yjsLastSequenceId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("nodeId", file._id),
			)
			.order("asc")
			.collect(),
	]);
	if (!snapshot || !lastSequenceDoc) {
		throw new Error("File Yjs state missing while reading Yjs state");
	}

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshot.snapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	return {
		yjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		yjsSequence: lastSequenceDoc.lastSequence,
	};
}

async function build_file_diff_update_from_snapshot(args: { ctx: MutationCtx; nodeId: Id<"files_nodes">; markdown: string }) {
	const { ctx, nodeId, markdown } = args;
	const file = await ctx.db.get("files_nodes", nodeId);
	if (!file || !file.yjsSnapshotId) {
		throw new Error("File missing while preparing diff update from snapshot");
	}

	const snapshot = await ctx.db.get("files_yjs_snapshots", file.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("Snapshot missing while preparing diff update from snapshot");
	}

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshot.snapshotUpdate);
	const targetYjsDoc = files_yjs_doc_clone({
		yjsDoc: baseYjsDoc,
	});
	const targetYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
		mut_yjsDoc: targetYjsDoc,
		markdown,
	});
	if (targetYjsDocFromMarkdown._nay) {
		throw new Error("Failed to build target Yjs doc while preparing diff update from snapshot");
	}

	const diffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
		yjsDoc: targetYjsDoc,
		yjsBeforeDoc: baseYjsDoc,
	});
	if (!diffUpdate) {
		throw new Error("Missing diff update while preparing diff update from snapshot");
	}

	return files_u8_to_array_buffer(diffUpdate);
}

function read_pending_row_markdown_state(args: {
	pendingUpdate: {
		baseYjsUpdate: ArrayBuffer;
		stagedBranchYjsUpdate: ArrayBuffer;
		unstagedBranchYjsUpdate: ArrayBuffer;
	};
}) {
	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.pendingUpdate.baseYjsUpdate);
	const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.pendingUpdate.stagedBranchYjsUpdate);
	const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.pendingUpdate.unstagedBranchYjsUpdate);

	const baseMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: baseYjsDoc,
	});
	const stagedMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: stagedBranchYjsDoc,
	});
	const unstagedMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: unstagedBranchYjsDoc,
	});

	if (baseMarkdown._nay || stagedMarkdown._nay || unstagedMarkdown._nay) {
		throw new Error("Failed to reconstruct pending row markdown");
	}

	return {
		baseMarkdown: baseMarkdown._yay,
		stagedMarkdown: stagedMarkdown._yay,
		unstagedMarkdown: unstagedMarkdown._yay,
	};
}

async function list_pending_update_cleanup_tasks(args: { ctx: MutationCtx; pendingUpdateId: Id<"files_pending_updates"> }) {
	return await args.ctx.db
		.query("files_pending_updates_cleanup_tasks")
		.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

async function read_pending_update_last_sequence_saved_row(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
}) {
	return await args.ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_workspace_project_user_file", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("userId", args.userId)
				.eq("nodeId", args.nodeId),
		)
		.first();
}

async function upsert_file_pending_update_internal_for_test(args: {
	t: ReturnType<typeof test_convex>;
	workspaceId: string;
	projectId: string;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	pendingUpdateId?: Id<"files_pending_updates">;
	stagedMarkdown?: string;
	unstagedMarkdown: string;
}) {
	return await args.t.mutation(internal.files_pending_updates.upsert_file_pending_update_internal, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		nodeId: args.nodeId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.stagedMarkdown !== undefined ? { stagedMarkdown: args.stagedMarkdown } : {}),
		unstagedMarkdown: args.unstagedMarkdown,
	});
}

describe("upsert_file_pending_update", () => {
	test("upsert_file_pending_update replaces updates deterministically", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-status",
				name: "pending-edits-status",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nChanged once`;

		const unresolved = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (unresolved._nay) {
			throw new Error(unresolved._nay.message);
		}
		expect(unresolved._yay).toBeNull();

		const ready = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (ready._nay) {
			throw new Error(ready._nay.message);
		}
		expect(ready._yay).toBeNull();

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(firstPendingRow).not.toBeNull();

		const readyAgain = await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (readyAgain._nay) {
			throw new Error(readyAgain._nay.message);
		}
		expect(readyAgain._yay).toBeNull();

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow!._id);
		expect(secondPendingRow!.baseYjsSequence).toBe(firstPendingRow!.baseYjsSequence);

		const secondPendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: secondPendingRow!,
		});
		expect(secondPendingRowMarkdownState.stagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondPendingRowMarkdownState.unstagedMarkdown);

		const discarded = await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay).toBeNull();

		const pendingAfterDiscard = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterDiscard).toBeNull();
	});

	test("upsert_file_pending_update accepts a matching pendingUpdateId hint", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-matching-id-hint",
				name: "pending-edits-matching-id-hint",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nFirst`;
		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending row while testing matching pendingUpdateId hint");
		}

		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSecond`);
		const secondUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstPendingRow._id,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow._id);

		const secondPendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: secondPendingRow!,
		});
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondMarkdown);
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toBe(secondMarkdown);
	});

	test("upsert_file_pending_update falls back from a stale pendingUpdateId to the current scoped row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-fallback",
				name: "pending-edits-stale-id-fallback",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst`,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending row while testing fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCurrent`,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending row while testing stale fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const fallbackMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nFallback`);
		const fallbackUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: stalePendingRow._id,
			stagedMarkdown: fallbackMarkdown,
			unstagedMarkdown: fallbackMarkdown,
		});
		if (fallbackUpsertResult._nay) {
			throw new Error(fallbackUpsertResult._nay.message);
		}

		const pendingRowAfterFallback = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRowAfterFallback).not.toBeNull();
		expect(pendingRowAfterFallback!._id).toBe(currentPendingRow._id);

		const pendingRowAfterFallbackMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRowAfterFallback!,
		});
		expect(pendingRowAfterFallbackMarkdownState.stagedMarkdown).toBe(fallbackMarkdown);
		expect(pendingRowAfterFallbackMarkdownState.unstagedMarkdown).toBe(fallbackMarkdown);
	});

	test("upsert_file_pending_update keeps staged at base when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-new-proposal",
				name: "pending-edits-agent-new-proposal",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const agentUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (agentUpsertResult._nay) {
			throw new Error(agentUpsertResult._nay.message);
		}
		expect(agentUpsertResult._yay).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after creating an agent proposal");
		}

		const pendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRow,
		});
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(agentMarkdown);
	});

	test("upsert_file_pending_update preserves existing staged changes when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-preserve-staged",
				name: "pending-edits-agent-preserve-staged",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUser staged`);
		const firstAgentMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nAgent proposal`);
		const stagedPendingUpdateResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedMarkdown,
			unstagedMarkdown: firstAgentMarkdown,
		});
		if (stagedPendingUpdateResult._nay) {
			throw new Error(stagedPendingUpdateResult._nay.message);
		}

		const secondAgentMarkdown = normalize_pending_update_markdown(`${firstAgentMarkdown}\n\nAgent follow up`);
		const secondAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondAgentMarkdown,
		});
		if (secondAgentUpsertResult._nay) {
			throw new Error(secondAgentUpsertResult._nay.message);
		}
		expect(secondAgentUpsertResult._yay).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after the follow-up agent proposal");
		}

		const pendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRow,
		});
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(stagedMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(secondAgentMarkdown);
	});

	test("upsert_file_pending_update keeps a pending row for trailing whitespace at EOF", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-trailing-whitespace-eof",
				name: "pending-edits-trailing-whitespace-eof",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const whitespaceMarkdown = seeded.baseMarkdown + " ";
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: whitespaceMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}
		expect(upsertResult._yay).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after adding trailing whitespace at EOF");
		}

		const pendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRow,
		});
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(whitespaceMarkdown);
	});

	test("upsert_file_pending_update clears the row when agent changes collapse to base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-collapse-to-base",
				name: "pending-edits-agent-collapse-to-base",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const firstAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (firstAgentUpsertResult._nay) {
			throw new Error(firstAgentUpsertResult._nay.message);
		}

		const discardAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardAgentUpsertResult._nay) {
			throw new Error(discardAgentUpsertResult._nay.message);
		}
		expect(discardAgentUpsertResult._yay).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRow).toBeNull();
	});

	test("pending update cleanup task follows the latest pending row state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-task",
				name: "pending-edits-cleanup-task",
				markdown: "# Cleanup task base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup task first`;
		const firstUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending row while testing cleanup task scheduling");
		}

		const firstCleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: firstPendingRow._id,
			}),
		);
		expect(firstCleanupTasks).toHaveLength(1);
		expect(firstCleanupTasks[0]!.expectedUpdatedAt).toBe(firstPendingRow.updatedAt);

		await new Promise((resolve) => setTimeout(resolve, 2));

		const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup task second`;
		const secondUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!secondPendingRow) {
			throw new Error("Missing second pending row while testing cleanup task rescheduling");
		}

		const secondCleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: secondPendingRow._id,
			}),
		);
		expect(secondCleanupTasks).toHaveLength(1);
		expect(secondCleanupTasks[0]!.expectedUpdatedAt).toBe(secondPendingRow.updatedAt);
		expect(secondCleanupTasks[0]!.scheduledFunctionId).not.toBe(firstCleanupTasks[0]!.scheduledFunctionId);

		const discardResult = await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardResult._nay) {
			throw new Error(discardResult._nay.message);
		}

		const cleanupTasksAfterDiscard = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: secondPendingRow._id,
			}),
		);
		expect(cleanupTasksAfterDiscard).toHaveLength(0);
	});
});

describe("files_db_reschedule_pending_update_cleanup_for_user", () => {
	test("files_db_reschedule_pending_update_cleanup_for_user refreshes existing cleanup tasks", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-reschedule-for-user",
				name: "pending-edits-reschedule-for-user",
				markdown: "# Reschedule base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nReschedule pending`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row while testing user cleanup reschedule");
		}

		const firstCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!firstCleanupTask) {
			throw new Error("Missing first cleanup task while testing user cleanup reschedule");
		}

		await t.run((ctx) =>
			files_db_reschedule_pending_update_cleanup_for_user(ctx, {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				userId: seeded.userId,
			}),
		);

		const secondCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!secondCleanupTask) {
			throw new Error("Missing second cleanup task while testing user cleanup reschedule");
		}

		expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
		expect(secondCleanupTask.scheduledFunctionId).not.toBe(firstCleanupTask.scheduledFunctionId);
	});
});

describe("presence.disconnect", () => {
	test("presence.disconnect shortens cleanup after the last session disconnects", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-disconnect-last-session",
				name: "pending-edits-disconnect-last-session",
				markdown: "# Disconnect base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nDisconnect pending`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row while testing last-session disconnect cleanup");
		}

		const firstCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!firstCleanupTask) {
			throw new Error("Missing first cleanup task while testing last-session disconnect cleanup");
		}

		const roomId = `pending-edits-room-${seeded.nodeId}`;
		const presenceHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-last",
			interval: 1_000,
		});

		await asUser.mutation(api.presence.disconnect, {
			sessionToken: presenceHeartbeatResult.sessionToken,
		});

		const sessionsAfterDisconnect = await asUser.query(api.presence.listSessions, {
			roomToken: presenceHeartbeatResult.roomToken,
		});
		expect(sessionsAfterDisconnect).toHaveLength(0);

		const secondCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!secondCleanupTask) {
			throw new Error("Missing second cleanup task while testing last-session disconnect cleanup");
		}

		expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
		expect(secondCleanupTask.scheduledFunctionId).not.toBe(firstCleanupTask.scheduledFunctionId);
	});

	test("presence.disconnect keeps cleanup unchanged while another session stays online", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-disconnect-multi-session",
				name: "pending-edits-disconnect-multi-session",
				markdown: "# Disconnect multi-session base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nDisconnect multi-session pending`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row while testing multi-session disconnect cleanup");
		}

		const firstCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!firstCleanupTask) {
			throw new Error("Missing first cleanup task while testing multi-session disconnect cleanup");
		}

		const roomId = `pending-edits-room-${seeded.nodeId}`;
		const firstHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-first",
			interval: 1_000,
		});
		await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-second",
			interval: 1_000,
		});

		await asUser.mutation(api.presence.disconnect, {
			sessionToken: firstHeartbeatResult.sessionToken,
		});

		const sessionsAfterDisconnect = await asUser.query(api.presence.listSessions, {
			roomToken: firstHeartbeatResult.roomToken,
		});
		expect(sessionsAfterDisconnect).toHaveLength(1);
		expect(sessionsAfterDisconnect[0]!.sessionId).toBe("session-second");

		const secondCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!secondCleanupTask) {
			throw new Error("Missing second cleanup task while testing multi-session disconnect cleanup");
		}

		expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
		expect(secondCleanupTask.scheduledFunctionId).toBe(firstCleanupTask.scheduledFunctionId);
	});
});

describe("save_file_pending_update", () => {
	test("save_file_pending_update blocks Free users at zero credits before saving", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-zero-credits",
				name: "pending-edits-save-zero-credits",
				markdown: "# Save base",
			}),
		);
		await t.run(async (ctx) => {
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: {
					...usageSnapshot.meter,
					creditedUnits: 0,
					balance: 0,
				},
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
		});

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalled();

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update blocks anonymous users at zero credits before saving", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-zero-credits",
				name: "pending-edits-save-anon-zero-credits",
				markdown: "# Anon save base",
			});
			// Replace the signed-in billing snapshot with an anonymous one and drain it.
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			const user = await ctx.db.get("users", result.userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}
			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: result.userId,
							externalId: "manual_credit::anonymous_pending_updates::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await asAnonymous.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
		});

		const saveResult = await asAnonymous.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalled();

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update bills anonymous users locally after a successful save", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-success",
				name: "pending-edits-save-anon-success",
				markdown: "# Anon save base",
			});
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await asAnonymous.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
		});

		const saveResult = await asAnonymous.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing anonymous save billing");
		}

		expect(saveResult._yay.newSequence).not.toBeNull();
		expect(enqueueActionSpy).not.toHaveBeenCalled();

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.consumedUnits).toBe(1);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits - 1);

		const savedMarkdown = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdown).toContain("Saved anon chunk");
	});

	test("save_file_pending_update supports partial save and keeps unresolved pending row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save",
				name: "pending-edits-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing partial save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: seeded.userId,
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.workspaceId}::${seeded.projectId}::${seeded.nodeId}::${saveResult._yay.newSequence}`,
					metadata: expect.objectContaining({
						amount: 1,
						actorUserId: seeded.userId,
						billedUserId: seeded.userId,
						workspaceId: seeded.workspaceId,
						projectId: seeded.projectId,
						nodeId: seeded.nodeId,
						yjsSequence: String(saveResult._yay.newSequence),
					}),
				}),
			],
		});

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_workspace_project_file_sequence", (q) =>
					q.eq("workspaceId", seeded.workspaceId).eq("projectId", seeded.projectId).eq("nodeId", seeded.nodeId),
				)
				.order("asc")
				.collect(),
		);
		expect(yjsUpdatesAfterSave).toHaveLength(1);
		expect(yjsUpdatesAfterSave[0]?.createdBy).toBe(seeded.userId);

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_row({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.baseYjsSequence).toBe(saveResult._yay.newSequence);
		const pendingAfterSaveMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingAfterSave!,
		});
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).not.toContain("Unresolved chunk");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved chunk");

		const savedMarkdownAfterPartialSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterPartialSave).toContain("Accepted chunk");
		expect(savedMarkdownAfterPartialSave).not.toContain("Unresolved chunk");
	});

	test("save_file_pending_update clears pending row when all changes are resolved", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-full",
				name: "pending-edits-save-full",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeFirstSave = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeFirstSave).toBeNull();

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing full save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).toBeNull();

		const savedMarkdownAfterFullSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFullSave).toContain("Fully resolved");
	});

	test("save_file_pending_update falls back from a stale pendingUpdateId to the current scoped row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-id",
				name: "pending-edits-save-stale-id",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleMarkdown = `${seeded.baseMarkdown}\n\nStale row`;
		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending row while testing save fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		const currentMarkdown = `${seeded.baseMarkdown}\n\nCurrent row`;
		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentMarkdown,
			unstagedMarkdown: currentMarkdown,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending row while testing save fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: stalePendingRow._id,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing stale save fallback");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).toBeNull();

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const savedMarkdownAfterFallbackSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFallbackSave).toContain("Current row");
	});

	test("save_file_pending_update keeps unresolved row based on saved pending base when remote drift exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-no-staged",
				name: "pending-edits-save-no-staged",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing save without staged changes");
		}
		expect(saveResult._yay.newSequence).toBeNull();

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_row({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(1);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.baseYjsSequence).toBe(1);

		const pendingAfterSaveMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingAfterSave!,
		});
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("# Save base");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved only");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Remote drift");

		const savedMarkdownAfterNoStagedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterNoStagedSave).toContain("# Save base");
		expect(savedMarkdownAfterNoStagedSave).toContain("Remote drift");
		expect(savedMarkdownAfterNoStagedSave).not.toContain("Unresolved only");
	});

	test("save_file_pending_update returns rate-limit _nay and preserves pending row when bucket exhausted", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-rate-limited",
				name: "pending-edits-save-rate-limited",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Rate Limit User",
			email: "rate-limit-user@example.com",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nStaged change`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingBeforeSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeSave).not.toBeNull();

		for (let i = 0; i < 2; i++) {
			const result = await asUser.mutation(api.ai_chat.save_file_pending_update, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			});
			if (result._nay) {
				throw new Error(`Expected pre-exhaust save #${i + 1} to succeed, got: ${result._nay.message}`);
			}

			await t.run(async (ctx) => {
				const saveMarkdown = `${seeded.baseMarkdown}\n\nStaged change ${i + 1}`;
				const upsert = await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_update_internal, {
					workspaceId: seeded.workspaceId,
					projectId: seeded.projectId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
					stagedMarkdown: saveMarkdown,
					unstagedMarkdown: saveMarkdown,
				});
				if (upsert._nay) {
					throw new Error(upsert._nay.message);
				}
			});
		}

		const pendingBeforeBlockedSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeBlockedSave).not.toBeNull();

		const lastSequenceSavedBeforeBlockedSave = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(lastSequenceSavedBeforeBlockedSave?.lastSequenceSaved).toBe(2);

		const saveResult = await asUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (!saveResult._nay) {
			throw new Error("Expected save_file_pending_update to be rate limited");
		}
		expect(saveResult._nay.message).toBe("Rate limit exceeded");

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave?._id).toBe(pendingBeforeBlockedSave?._id);

		const lastSequenceSavedAfter = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(lastSequenceSavedAfter?._id).toBe(lastSequenceSavedBeforeBlockedSave?._id);
		expect(lastSequenceSavedAfter?.lastSequenceSaved).toBe(2);

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_yjs_updates")
					.withIndex("by_workspace_project_file_sequence", (q) =>
						q.eq("workspaceId", seeded.workspaceId).eq("projectId", seeded.projectId).eq("nodeId", seeded.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_yjs_docs_last_sequences")
					.withIndex("by_workspace_project_file", (q) =>
						q.eq("workspaceId", seeded.workspaceId).eq("projectId", seeded.projectId).eq("nodeId", seeded.nodeId),
					)
					.first(),
			]).then(([updates, lastSequence]) => ({
				updateCount: updates.length,
				lastSequence: lastSequence?.lastSequence ?? null,
			})),
		);
		expect(yjsUpdatesAfterSave.updateCount).toBe(2);
		expect(yjsUpdatesAfterSave.lastSequence).toBe(2);
	});
});

describe("files_pending_updates_last_sequence_saved", () => {
	test("upsert_file_pending_update and persist_file_pending_update_rebased_state do not write last saved sequence marker", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-marker-non-save-paths",
				name: "pending-edits-save-marker-non-save-paths",
				markdown: "# Save marker base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeChanges = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeChanges).toBeNull();

		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const pendingUpdateLastSequenceSavedAfterUpsert = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterUpsert).toBeNull();

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: unstagedBranchYjsDoc,
			markdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged branch while testing save marker non-save paths");
		}

		const persistResult = await asUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		const pendingUpdateLastSequenceSavedAfterPersist = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterPersist).toBeNull();
	});
});

describe("persist_file_pending_update_rebased_state", () => {
	test("persist_file_pending_update_rebased_state stores the rebased row as the new authoritative pending state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-rebased",
				name: "pending-edits-persist-rebased",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteMarkdown = `${seeded.baseMarkdown}\n\nRemote drift`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: remoteMarkdown,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);

		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: unstagedBranchYjsDoc,
			markdown: `${remoteMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged rebased branch while testing pending update persistence");
		}

		const persistResult = await asUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();
		expect(persistResult._yay.pendingUpdate!.baseYjsSequence).toBe(1);

		const pendingAfterPersist = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterPersist).not.toBeNull();

		const pendingAfterPersistMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingAfterPersist!,
		});
		expect(pendingAfterPersistMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.stagedMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Unresolved only");
	});

	test("persist_file_pending_update_rebased_state ignores a mismatched pendingUpdateId from another file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) => {
			const fileA = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-a",
				name: "pending-edits-persist-mismatch-a",
				markdown: "# File A",
			});
			const fileB = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-b",
				name: "pending-edits-persist-mismatch-b",
				markdown: "# File B",
				membership: fileA,
			});

			return {
				membershipId: fileA.membershipId,
				workspaceId: fileA.workspaceId,
				projectId: fileA.projectId,
				userId: fileA.userId,
				fileAId: fileA.nodeId,
				fileABaseMarkdown: fileA.baseMarkdown,
				fileBId: fileB.nodeId,
				fileBBaseMarkdown: fileB.baseMarkdown,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.fileAId,
			stagedMarkdown: seeded.fileABaseMarkdown,
			unstagedMarkdown: `${seeded.fileABaseMarkdown}\n\nFile A current`,
		});
		await upsert_file_pending_update_internal_for_test({
			t,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			nodeId: seeded.fileBId,
			stagedMarkdown: seeded.fileBBaseMarkdown,
			unstagedMarkdown: `${seeded.fileBBaseMarkdown}\n\nFile B current`,
		});

		const [fileAPendingRow, fileBPendingRow] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_workspace_project_user_file", (q) =>
						q
							.eq("workspaceId", seeded.workspaceId)
							.eq("projectId", seeded.projectId)
							.eq("userId", seeded.userId)
							.eq("nodeId", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_workspace_project_user_file", (q) =>
						q
							.eq("workspaceId", seeded.workspaceId)
							.eq("projectId", seeded.projectId)
							.eq("userId", seeded.userId)
							.eq("nodeId", seeded.fileBId),
					)
					.first(),
			]),
		);
		if (!fileAPendingRow || !fileBPendingRow) {
			throw new Error("Missing pending rows while testing mismatched rebase pendingUpdateId");
		}

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.fileAId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: unstagedBranchYjsDoc,
			markdown: `${seeded.fileABaseMarkdown}\n\nFile A rebased`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build rebased branch while testing mismatched pendingUpdateId");
		}

		const persistResult = await asUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.fileAId,
			pendingUpdateId: fileBPendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();
		expect(persistResult._yay.pendingUpdate!._id).toBe(fileAPendingRow._id);

		const [fileAPendingRowAfterPersist, fileBPendingRowAfterPersist] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_workspace_project_user_file", (q) =>
						q
							.eq("workspaceId", seeded.workspaceId)
							.eq("projectId", seeded.projectId)
							.eq("userId", seeded.userId)
							.eq("nodeId", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_workspace_project_user_file", (q) =>
						q
							.eq("workspaceId", seeded.workspaceId)
							.eq("projectId", seeded.projectId)
							.eq("userId", seeded.userId)
							.eq("nodeId", seeded.fileBId),
					)
					.first(),
			]),
		);
		expect(fileAPendingRowAfterPersist).not.toBeNull();
		expect(fileAPendingRowAfterPersist!._id).toBe(fileAPendingRow._id);
		expect(fileBPendingRowAfterPersist).not.toBeNull();

		const fileAPendingRowAfterPersistMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: fileAPendingRowAfterPersist!,
		});
		expect(fileAPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File A rebased");

		const fileBPendingRowAfterPersistMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: fileBPendingRowAfterPersist!,
		});
		expect(fileBPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File B current");
	});

	test("persist_file_pending_update_rebased_state clears the pending row when the rebased branches match the live base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-clear",
				name: "pending-edits-persist-clear",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);

		const clearResult = await asUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: latestFileState.yjsUpdate,
		});
		if (clearResult._nay) {
			throw new Error(clearResult._nay.message);
		}
		expect(clearResult._yay.pendingUpdate).toBeNull();

		const pendingAfterClear = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterClear).toBeNull();
	});

	test("persist_file_pending_update_rebased_state rejects stale live bases", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale",
				name: "pending-edits-persist-stale",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				nodeId: seeded.nodeId,
			}),
		);

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const stalePersistResult = await asUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: staleFileState.yjsSequence,
			baseYjsUpdate: staleFileState.yjsUpdate,
			stagedBranchYjsUpdate: staleFileState.yjsUpdate,
			unstagedBranchYjsUpdate: staleFileState.yjsUpdate,
		});
		expect(stalePersistResult._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
	});
});

describe("remove_file_pending_update_if_expired", () => {
	test("remove_file_pending_update_if_expired ignores stale scheduled runs", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-stale",
				name: "pending-edits-cleanup-stale",
				markdown: "# Cleanup stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending first`;
		const firstUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending row while testing stale cleanup");
		}

		const firstCleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: firstPendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!firstCleanupTask) {
			throw new Error("Missing first cleanup task while testing stale cleanup");
		}

		await new Promise((resolve) => setTimeout(resolve, 2));

		const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending second`;
		const secondUpsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: firstPendingRow._id,
			expectedUpdatedAt: firstCleanupTask.expectedUpdatedAt,
		});

		const pendingAfterStaleCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterStaleCleanup).not.toBeNull();

		const cleanupTasksAfterStaleCleanup = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: firstPendingRow._id,
			}),
		);
		expect(cleanupTasksAfterStaleCleanup).toHaveLength(1);
		expect(cleanupTasksAfterStaleCleanup[0]!.expectedUpdatedAt).toBe(pendingAfterStaleCleanup!.updatedAt);
	});

	test("remove_file_pending_update_if_expired deletes matching pending updates", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-expired",
				name: "pending-edits-cleanup-expired",
				markdown: "# Cleanup expired base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup expired`;
		const upsertResult = await asUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row while testing expired cleanup");
		}

		const cleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!cleanupTask) {
			throw new Error("Missing cleanup task while testing expired cleanup");
		}

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
		});

		const pendingAfterCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_workspace_project_user_file", (q) =>
					q
						.eq("workspaceId", seeded.workspaceId)
						.eq("projectId", seeded.projectId)
						.eq("userId", seeded.userId)
						.eq("nodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterCleanup).toBeNull();

		const cleanupTasksAfterCleanup = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			}),
		);
		expect(cleanupTasksAfterCleanup).toHaveLength(0);
	});
});

describe("membership scoped pending updates", () => {
	test("pending update APIs reject cross-user membership ids", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-membership-unauthorized",
				name: "pending-edits-membership-unauthorized",
				markdown: "# Base",
			}),
		);

		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
		});

		const unauthorizedUpsert = await asOtherUser.mutation(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnauthorized`,
		});
		if (!unauthorizedUpsert._nay) {
			throw new Error("Expected upsert_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedUpsert._nay.message).toBe("Unauthorized");

		const unauthorizedPending = await asOtherUser.query(api.ai_chat.get_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(unauthorizedPending).toBeNull();

		const unauthorizedLastSaved = await asOtherUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(unauthorizedLastSaved).toBeNull();

		const unauthorizedSave = await asOtherUser.mutation(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (!unauthorizedSave._nay) {
			throw new Error("Expected save_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedSave._nay.message).toBe("Unauthorized");

		const unauthorizedPersist = await asOtherUser.mutation(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: new ArrayBuffer(0),
			stagedBranchYjsUpdate: new ArrayBuffer(0),
			unstagedBranchYjsUpdate: new ArrayBuffer(0),
		});
		if (!unauthorizedPersist._nay) {
			throw new Error("Expected persist_file_pending_update_rebased_state to reject cross-user membership");
		}
		expect(unauthorizedPersist._nay.message).toBe("Unauthorized");
	});
});
