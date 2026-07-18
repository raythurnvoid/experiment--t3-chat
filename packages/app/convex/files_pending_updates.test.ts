import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";

const test = baseTest;
import { billing_event } from "../server/billing.ts";
import { r2_create_asset_key } from "./r2.ts";
import {
	files_db_reschedule_pending_update_cleanup_for_user,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "../server/files.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

let enqueueActionSpy: MockInstance;
const r2Objects = new Map<string, string | ArrayBuffer>();
// Keep the automatic presence timeout from firing during these tests; convex-test
// scheduled functions can otherwise race past the active transaction and leak an unhandled rejection.
const presenceHeartbeatIntervalMs = 60 * 60 * 1000;

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (!urlString.startsWith("https://r2.test/object?key=")) {
				return new Response(null, { status: 404 });
			}

			const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
	// Keep pending-edit tests off the real billing workpool while still letting
	// focused cases assert whether a file-save event was enqueued.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_pending_update_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.unstubAllGlobals();
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		membershipId: Id<"organizations_workspaces_users">;
	};
}) {
	const { ctx, path, name, markdown } = args;
	const membership = args.membership ?? (await test_mocks_fill_db_with.membership(ctx));
	const { userId, organizationId, workspaceId, membershipId } = membership;
	await seed_billing_snapshot_for_user(ctx, userId);

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

	const now = Date.now();
	const markdownAssetId = await ctx.db.insert("files_r2_assets", {
		organizationId,
		workspaceId,
		kind: "content",
		r2Bucket: "test-bucket",
		size: files_get_utf8_byte_size(baseMarkdownResult._yay),
		createdBy: userId,
		updatedAt: now,
	});
	const markdownAssetKey = r2_create_asset_key({ organizationId, workspaceId, assetId: markdownAssetId });
	await ctx.db.patch("files_r2_assets", markdownAssetId, {
		r2Key: markdownAssetKey,
	});
	r2Objects.set(markdownAssetKey, baseMarkdownResult._yay);

	const yjsSnapshotUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc));
	const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
		organizationId,
		workspaceId,
		kind: "yjs_snapshot",
		r2Bucket: "test-bucket",
		size: yjsSnapshotUpdate.byteLength,
		createdBy: userId,
		updatedAt: now,
	});
	const yjsSnapshotAssetKey = r2_create_asset_key({ organizationId, workspaceId, assetId: yjsSnapshotAssetId });
	await ctx.db.patch("files_r2_assets", yjsSnapshotAssetId, {
		r2Key: yjsSnapshotAssetKey,
	});
	r2Objects.set(yjsSnapshotAssetKey, yjsSnapshotUpdate);

	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId,
		workspaceId,
		path,
		treePath: path,
		pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
		name,
		kind: "file",
		lowercaseExtension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : null,
		contentType: "text/markdown;charset=utf-8",
		assetId: markdownAssetId,
		parentId: files_ROOT_ID,
		createdBy: userId,
		updatedBy: userId,
		updatedAt: now,
		archiveOperationId: undefined,
	});

	const snapshotId = await ctx.db.insert("files_yjs_snapshots", {
		organizationId: organizationId,
		workspaceId: workspaceId,
		fileNodeId: nodeId,
		sequence: 0,
		assetId: yjsSnapshotAssetId,
		createdBy: userId,
		updatedBy: String(userId),
		updatedAt: now,
	});

	const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
		organizationId: organizationId,
		workspaceId: workspaceId,
		fileNodeId: nodeId,
		lastSequence: 0,
	});

	await ctx.db.patch("files_nodes", nodeId, {
		yjsSnapshotId: snapshotId,
		yjsLastSequenceId: lastSequenceId,
	});

	return {
		organizationId,
		workspaceId,
		membershipId,
		userId,
		nodeId,
		baseMarkdown: baseMarkdownResult._yay,
	};
}

async function seed_folder_node(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	parentId?: Id<"files_nodes">;
	path: string;
	name: string;
}) {
	const now = Date.now();
	return await args.ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: args.path,
		treePath: `${args.path}/`,
		pathDepth: args.path.split("/").filter(Boolean).length,
		lowercaseExtension: null,
		name: args.name,
		kind: "folder",
		parentId: args.parentId ?? files_ROOT_ID,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
	});
}

/**
 * Insert one committed Markdown + plain-text chunk pair covering the whole markdown, so
 * committed chunk reads and denormalized-path assertions have real docs to work with.
 */
async function seed_committed_chunks_for_file(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	path: string;
	markdown: string;
}) {
	const markdownChunkId = await args.ctx.db.insert("files_markdown_chunks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "committed",
		yjsSequence: 0,
		chunkIndex: 0,
		markdownChunk: args.markdown,
		startIndex: 0,
		endIndex: args.markdown.length,
		lineStart: 1,
		lineEnd: args.markdown.split("\n").length,
		chunkFlags: 0,
	});
	const plainTextChunkId = await args.ctx.db.insert("files_plain_text_chunks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "committed",
		yjsSequence: 0,
		markdownChunkId,
		path: args.path,
		chunkIndex: 0,
		plainTextChunk: args.markdown,
		markdownChunk: args.markdown,
		startIndex: 0,
		endIndex: args.markdown.length,
		lineStart: 1,
		lineEnd: args.markdown.split("\n").length,
		chunkFlags: 0,
		hasChunkAbove: false,
		hasChunkBelow: false,
	});

	return { markdownChunkId, plainTextChunkId };
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

async function read_file_yjs_snapshot_update(args: {
	ctx: MutationCtx;
	fileNode: { yjsSnapshotId?: Id<"files_yjs_snapshots"> };
}) {
	if (!args.fileNode.yjsSnapshotId) {
		throw new Error("fileNode.yjsSnapshotId is not set while reading Yjs snapshot");
	}

	const snapshot = await args.ctx.db.get("files_yjs_snapshots", args.fileNode.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("fileNode.yjsSnapshotId points to a missing files_yjs_snapshots doc while reading Yjs snapshot");
	}

	const snapshotAsset = await args.ctx.db.get("files_r2_assets", snapshot.assetId);
	if (!snapshotAsset?.r2Key) {
		throw new Error("snapshot.assetId points to a missing files_r2_assets doc while reading Yjs snapshot");
	}

	const yjsSnapshotUpdate = r2Objects.get(snapshotAsset.r2Key);
	if (!(yjsSnapshotUpdate instanceof ArrayBuffer)) {
		throw new Error("Expected test R2 object for Yjs snapshot");
	}

	return {
		snapshot,
		yjsSnapshotUpdate,
	};
}

async function read_file_markdown_from_yjs(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
}) {
	const { ctx, organizationId, workspaceId, nodeId } = args;
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while reading markdown from Yjs");
	}
	const { snapshot, yjsSnapshotUpdate } = await read_file_yjs_snapshot_update({ ctx, fileNode });

	const updates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", fileNode._id),
		)
		.order("asc")
		.collect();

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
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
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
}) {
	const { ctx, organizationId, workspaceId, nodeId } = args;
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while reading Yjs state");
	}
	if (!fileNode.yjsSnapshotId) {
		throw new Error("fileNode.yjsSnapshotId is not set while reading Yjs state");
	}
	if (!fileNode.yjsLastSequenceId) {
		throw new Error("fileNode.yjsLastSequenceId is not set while reading Yjs state");
	}

	const [{ snapshot, yjsSnapshotUpdate }, lastSequenceDoc, updates] = await Promise.all([
		read_file_yjs_snapshot_update({ ctx, fileNode }),
		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", fileNode._id),
			)
			.order("asc")
			.collect(),
	]);
	if (!lastSequenceDoc) {
		throw new Error(
			"fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc while reading Yjs state",
		);
	}

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
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
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while preparing diff update from snapshot");
	}
	const { yjsSnapshotUpdate } = await read_file_yjs_snapshot_update({ ctx, fileNode });

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate);
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
		baseYjsUpdate?: ArrayBuffer;
		stagedBranchYjsUpdate?: ArrayBuffer;
		unstagedBranchYjsUpdate?: ArrayBuffer;
	};
}) {
	const { baseYjsUpdate, stagedBranchYjsUpdate, unstagedBranchYjsUpdate } = args.pendingUpdate;
	if (!baseYjsUpdate || !stagedBranchYjsUpdate || !unstagedBranchYjsUpdate) {
		throw new Error("Expected pending update row with Yjs content");
	}

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseYjsUpdate);
	const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(stagedBranchYjsUpdate);
	const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(unstagedBranchYjsUpdate);

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
		throw new Error("Failed to reconstruct pending doc markdown");
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

async function list_pending_update_markdown_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_markdown_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

async function list_pending_update_plain_text_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

async function read_pending_update_row(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
}) {
	return await args.ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", args.nodeId),
		)
		.first();
}

async function read_pending_update_last_sequence_saved_doc(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
}) {
	return await args.ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", args.nodeId),
		)
		.first();
}

async function upsert_file_pending_update_internal_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	pendingUpdateId?: Id<"files_pending_updates">;
	stagedMarkdown?: string;
	unstagedMarkdown: string;
	copiedFrom?: { nodeId: Id<"files_nodes">; path: string };
}) {
	return await args.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.stagedMarkdown !== undefined ? { stagedMarkdown: args.stagedMarkdown } : {}),
		unstagedMarkdown: args.unstagedMarkdown,
		...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
	});
}

async function upsert_file_pending_move_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
	destName: string;
}) {
	return await args.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
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

		const unresolved = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (unresolved._nay) {
			throw new Error(unresolved._nay.message);
		}
		expect(unresolved._yay).toBeNull();

		const ready = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(firstPendingRow).not.toBeNull();

		const readyAgain = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
		await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing matching pendingUpdateId hint");
		}

		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSecond`);
		const secondUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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

	test("upsert_file_pending_update falls back from a stale pendingUpdateId to the current scoped doc", async () => {
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
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst`,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCurrent`,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing stale fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const fallbackMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nFallback`);
		const fallbackUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
		const agentUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after creating an agent proposal");
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
		const stagedPendingUpdateResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedMarkdown,
			unstagedMarkdown: firstAgentMarkdown,
		});
		if (stagedPendingUpdateResult._nay) {
			throw new Error(stagedPendingUpdateResult._nay.message);
		}

		const secondAgentMarkdown = normalize_pending_update_markdown(`${firstAgentMarkdown}\n\nAgent follow up`);
		const secondAgentUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after the follow-up agent proposal");
		}

		const pendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRow,
		});
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(stagedMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(secondAgentMarkdown);
	});

	test("upsert_file_pending_update keeps a pending doc for trailing whitespace at EOF", async () => {
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after adding trailing whitespace at EOF");
		}

		const pendingRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRow,
		});
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(whitespaceMarkdown);
	});

	test("upsert_file_pending_update clears the doc when agent changes collapse to base", async () => {
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
		const firstAgentUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (firstAgentUpsertResult._nay) {
			throw new Error(firstAgentUpsertResult._nay.message);
		}

		const discardAgentUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRow).toBeNull();
	});

	test("pending update cleanup task follows the latest pending doc state", async () => {
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
		const firstUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending doc while testing cleanup task scheduling");
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
		const secondUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!secondPendingRow) {
			throw new Error("Missing second pending doc while testing cleanup task rescheduling");
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
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
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

describe("pending file chunk docs lifecycle", () => {
	const read_pending_row = async (args: {
		t: ReturnType<typeof test_convex>;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
	}) =>
		await args.t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("userId", args.userId)
						.eq("fileNodeId", args.nodeId),
				)
				.first(),
		);

	test("upsert creates chunks, re-chunks only on unstaged change, and collapse deletes them", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-upsert",
				name: "pending-chunks-upsert",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle one`);
		const firstUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing chunk creation");
		}
		expect(pendingRow.size).toBe(files_get_utf8_byte_size(firstMarkdown));

		const firstMarkdownChunks = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const firstPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(firstMarkdownChunks.length).toBeGreaterThan(0);
		expect(firstPlainTextChunks).toHaveLength(firstMarkdownChunks.length);
		expect(firstMarkdownChunks.map((chunk) => chunk.markdownChunk).join("\n")).toContain("Chunk needle one");
		expect(firstPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle one");
		expect(firstMarkdownChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			fileNodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			chunkIndex: 0,
		});
		expect(firstPlainTextChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			fileNodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			path: "/pending-chunks-upsert",
			chunkIndex: 0,
		});
		expect(new Set(firstMarkdownChunks.map((chunk) => chunk._id))).toContain(firstPlainTextChunks[0]?.markdownChunkId);
		for (const chunk of firstPlainTextChunks) {
			const markdownChunk = firstMarkdownChunks.find((candidate) => candidate._id === chunk.markdownChunkId);
			if (!markdownChunk) throw new Error("Expected linked Markdown chunk");
			expect(chunk).toMatchObject({
				markdownChunk: markdownChunk.markdownChunk,
				startIndex: markdownChunk.startIndex,
				endIndex: markdownChunk.endIndex,
				lineStart: markdownChunk.lineStart,
				lineEnd: markdownChunk.lineEnd,
				chunkFlags: markdownChunk.chunkFlags,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < firstPlainTextChunks.length - 1,
			});
		}

		// Unstaged content changed -> chunk docs are replaced.
		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle two`);
		const secondUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await read_pending_row({ t, ...seeded });
		if (!secondPendingRow) {
			throw new Error("Missing pending doc while testing chunk replacement");
		}
		expect(secondPendingRow._id).toBe(pendingRow._id);
		expect(secondPendingRow.size).toBe(files_get_utf8_byte_size(secondMarkdown));

		const secondMarkdownChunks = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const secondPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(secondMarkdownChunks.length).toBeGreaterThan(0);
		expect(secondPlainTextChunks).toHaveLength(secondMarkdownChunks.length);
		expect(secondMarkdownChunks.map((chunk) => chunk.markdownChunk).join("\n")).toContain("Chunk needle two");
		expect(secondMarkdownChunks.map((chunk) => chunk.markdownChunk).join("\n")).not.toContain("Chunk needle one");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle two");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).not.toContain("Chunk needle one");
		const firstMarkdownChunkIds = new Set(firstMarkdownChunks.map((chunk) => chunk._id));
		for (const chunk of secondMarkdownChunks) {
			expect(firstMarkdownChunkIds.has(chunk._id)).toBe(false);
		}
		const firstPlainTextChunkIds = new Set(firstPlainTextChunks.map((chunk) => chunk._id));
		for (const chunk of secondPlainTextChunks) {
			expect(firstPlainTextChunkIds.has(chunk._id)).toBe(false);
		}

		// Staged-only change (Accept all) keeps the unstaged content intact -> chunk doc ids survive.
		const stagedOnlyUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (stagedOnlyUpsertResult._nay) {
			throw new Error(stagedOnlyUpsertResult._nay.message);
		}

		const stagedOnlyPendingRow = await read_pending_row({ t, ...seeded });
		if (!stagedOnlyPendingRow) {
			throw new Error("Missing pending doc while testing staged-only pending update");
		}
		expect(stagedOnlyPendingRow.size).toBe(secondPendingRow.size);

		const stagedOnlyMarkdownChunks = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const stagedOnlyPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(new Set(stagedOnlyMarkdownChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondMarkdownChunks.map((chunk) => chunk._id)),
		);
		expect(new Set(stagedOnlyPlainTextChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondPlainTextChunks.map((chunk) => chunk._id)),
		);

		// Collapse back to base deletes the pending update doc and its chunk docs in the same mutation.
		const collapseResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapseResult._nay) {
			throw new Error(collapseResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const markdownChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(markdownChunksAfterCollapse).toHaveLength(0);
		expect(plainTextChunksAfterCollapse).toHaveLength(0);
	});

	test("full save deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-chunks-full-save",
				name: "pending-chunks-full-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved chunk needle`;
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing full-save chunk cleanup");
		}
		const markdownChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(markdownChunksBeforeSave.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeSave.length).toBeGreaterThan(0);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const markdownChunksAfterSave = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(markdownChunksAfterSave).toHaveLength(0);
		expect(plainTextChunksAfterSave).toHaveLength(0);
	});

	test("expiry cleanup deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-expiry",
				name: "pending-chunks-expiry",
				markdown: "# Expiry base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nExpiry chunk needle`,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expiry chunk cleanup");
		}
		const markdownChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(markdownChunksBeforeExpiry.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeExpiry.length).toBeGreaterThan(0);

		const cleanupTask = await t.run(async (ctx) => {
			const cleanupTasks = await list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: pendingRow._id,
			});
			return cleanupTasks[0] ?? null;
		});
		if (!cleanupTask) {
			throw new Error("Missing cleanup task while testing expiry chunk cleanup");
		}

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
		});

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const markdownChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(markdownChunksAfterExpiry).toHaveLength(0);
		expect(plainTextChunksAfterExpiry).toHaveLength(0);
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing user cleanup reschedule");
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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
	test("presence.disconnect keeps the long-lived cleanup after the last session disconnects", async () => {
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing last-session disconnect cleanup");
		}

		const roomId = `pending-edits-room-${seeded.nodeId}`;
		const presenceHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-last",
			interval: presenceHeartbeatIntervalMs,
		});

		// Capture after the heartbeat so any reconnect-driven refresh is already applied and
		// the assertion isolates disconnect, which must leave the cleanup schedule untouched.
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
		expect(secondCleanupTask.scheduledFunctionId).toBe(firstCleanupTask.scheduledFunctionId);
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing multi-session disconnect cleanup");
		}

		const roomId = `pending-edits-room-${seeded.nodeId}`;
		const firstHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-first",
			interval: presenceHeartbeatIntervalMs,
		});
		await asUser.mutation(api.presence.heartbeat, {
			roomId,
			userId: seeded.userId,
			sessionId: "session-second",
			interval: presenceHeartbeatIntervalMs,
		});

		// Capture after both heartbeats so the assertion isolates disconnect from
		// the heartbeat-driven cleanup refresh.
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
	test("save_file_pending_update returns Not found when there is no pending doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-missing-doc",
				name: "pending-edits-save-missing-doc",
				markdown: "# Missing doc base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});

		expect(saveResult._nay?.message).toBe("Not found");
	});

	test("save_file_pending_update throws when a file points to missing Yjs state", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-broken-yjs",
				name: "pending-edits-save-broken-yjs",
				markdown: "# Broken Yjs base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingMarkdown = `${seeded.baseMarkdown}\n\nPending chunk`;
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: pendingMarkdown,
			unstagedMarkdown: pendingMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		await t.run(async (ctx) => {
			const file = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!file?.yjsSnapshotId) {
				throw new Error("Expected seeded file Yjs snapshot");
			}
			await ctx.db.delete("files_yjs_snapshots", file.yjsSnapshotId);
		});

		await expect(
			asUser.action(api.ai_chat.save_file_pending_update, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			}),
		).rejects.toThrow("fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc");
	});

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

		await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		await asAnonymous.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
		});

		const saveResult = await asAnonymous.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		await asAnonymous.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
		});

		const saveResult = await asAnonymous.action(api.ai_chat.save_file_pending_update, {
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
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());

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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdown).toContain("Saved anon chunk");
	});

	test("save_file_pending_update supports partial save and keeps unresolved pending doc", async () => {
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
		await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
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
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.organizationId}::${seeded.workspaceId}::${seeded.nodeId}::${saveResult._yay.newSequence}`,
					metadata: expect.objectContaining({
						amount: 1,
						actorUserId: seeded.userId,
						billedUserId: seeded.userId,
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						nodeId: seeded.nodeId,
						yjsSequence: String(saveResult._yay.newSequence),
					}),
				}),
			],
		});

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
				)
				.order("asc")
				.collect(),
		);
		expect(yjsUpdatesAfterSave).toHaveLength(1);
		expect(yjsUpdatesAfterSave[0]?.createdBy).toBe(seeded.userId);

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterPartialSave).toContain("Accepted chunk");
		expect(savedMarkdownAfterPartialSave).not.toContain("Unresolved chunk");
	});

	test("save_file_pending_update clears pending doc when all changes are resolved", async () => {
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).toBeNull();

		const savedMarkdownAfterFullSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFullSave).toContain("Fully resolved");
	});

	test("save_file_pending_update falls back from a stale pendingUpdateId to the current scoped doc", async () => {
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

		const staleMarkdown = `${seeded.baseMarkdown}\n\nStale doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing save fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		const currentMarkdown = `${seeded.baseMarkdown}\n\nCurrent doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentMarkdown,
			unstagedMarkdown: currentMarkdown,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing save fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFallbackSave).toContain("Current doc");
	});

	test("save_file_pending_update keeps unresolved doc based on saved pending base when remote drift exists", async () => {
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

		await asUser.action(api.ai_chat.upsert_file_pending_update, {
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

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
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
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(1);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterNoStagedSave).toContain("# Save base");
		expect(savedMarkdownAfterNoStagedSave).toContain("Remote drift");
		expect(savedMarkdownAfterNoStagedSave).not.toContain("Unresolved only");
	});

	test("save_file_pending_update returns rate-limit _nay and preserves pending doc when bucket exhausted", async () => {
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeSave).not.toBeNull();

		for (let i = 0; i < 2; i++) {
			const result = await asUser.action(api.ai_chat.save_file_pending_update, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			});
			if (result._nay) {
				throw new Error(`Expected pre-exhaust save #${i + 1} to succeed, got: ${result._nay.message}`);
			}

			const saveMarkdown = `${seeded.baseMarkdown}\n\nStaged change ${i + 1}`;
			const upsert = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				stagedMarkdown: saveMarkdown,
				unstagedMarkdown: saveMarkdown,
			});
			if (upsert._nay) {
				throw new Error(upsert._nay.message);
			}
		}

		const pendingBeforeBlockedSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeBlockedSave).not.toBeNull();

		const lastSequenceSavedBeforeBlockedSave = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(lastSequenceSavedBeforeBlockedSave?.lastSequenceSaved).toBe(2);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_yjs_docs_last_sequences")
					.withIndex("by_organization_workspace_fileNode", (q) =>
						q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
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

		await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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
	test("persist_file_pending_update_rebased_state stores the rebased doc as the new authoritative pending state", async () => {
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

		await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
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
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileAId,
			stagedMarkdown: seeded.fileABaseMarkdown,
			unstagedMarkdown: `${seeded.fileABaseMarkdown}\n\nFile A current`,
		});
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileBId,
			stagedMarkdown: seeded.fileBBaseMarkdown,
			unstagedMarkdown: `${seeded.fileBBaseMarkdown}\n\nFile B current`,
		});

		const [fileAPendingRow, fileBPendingRow] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("fileNodeId", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("fileNodeId", seeded.fileBId),
					)
					.first(),
			]),
		);
		if (!fileAPendingRow || !fileBPendingRow) {
			throw new Error("Missing pending docs while testing mismatched rebase pendingUpdateId");
		}

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("fileNodeId", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("fileNodeId", seeded.fileBId),
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

	test("persist_file_pending_update_rebased_state clears the pending doc when the rebased branches match the live base", async () => {
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

		await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const clearResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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

		const stalePersistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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
		const firstUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending doc while testing stale cleanup");
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
		const secondUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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
		const upsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expired cleanup");
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
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
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

		const unauthorizedUpsert = await asOtherUser.action(api.ai_chat.upsert_file_pending_update, {
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

		const unauthorizedSave = await asOtherUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (!unauthorizedSave._nay) {
			throw new Error("Expected save_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedSave._nay.message).toBe("Unauthorized");

		const unauthorizedPersist = await asOtherUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
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

describe("upsert_file_pending_move_in_db", () => {
	test("creates a pure-move row and replaces the proposal on a second mv", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-upsert-src.md",
				name: "move-upsert-src.md",
				markdown: "# Move upsert base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-upsert-dest",
				name: "move-upsert-dest",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "moved.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/move-upsert-src.md",
			destPath: "/move-upsert-dest/moved.md",
		});

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after move upsert");
		}
		expect(pendingRow.pendingMove).toEqual({
			destParentId: destFolderId,
			destName: "moved.md",
			fromPath: "/move-upsert-src.md",
		});
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		const cleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(cleanupTasks).toHaveLength(1);
		expect(cleanupTasks[0]?.expectedUpdatedAt).toBe(pendingRow.updatedAt);

		const replaced = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		const replacedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(replacedRow?._id).toBe(pendingRow._id);
		expect(replacedRow?.pendingMove?.destName).toBe("renamed.md");
	});

	test("makes a mixed row when mv follows a pending content edit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-mixed-src.md",
				name: "move-mixed-src.md",
				markdown: "# Mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nMixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow) {
			throw new Error("Missing mixed pending row");
		}
		expect(mixedRow.pendingMove?.destName).toBe("move-mixed-renamed.md");
		expect(files_pending_update_has_yjs_content(mixedRow)).toBe(true);
		const mixedRowMarkdownState = read_pending_row_markdown_state({ pendingUpdate: mixedRow });
		expect(mixedRowMarkdownState.unstagedMarkdown).toContain("Mixed change");
		const pendingChunks = await t.run((ctx) =>
			list_pending_update_markdown_chunks({ ctx, pendingUpdateId: mixedRow._id }),
		);
		expect(pendingChunks.length).toBeGreaterThan(0);
	});

	test("rejects invalid move targets with short literal errors", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-src.md",
				name: "move-validate-src.md",
				markdown: "# Validate base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const sibling = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-sibling.md",
				name: "move-validate-sibling.md",
				markdown: "# Sibling base",
				membership,
			}),
		);

		// Destination parent must be an active folder or root.
		const destParentIsFile = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: sibling.nodeId,
			destName: "moved.md",
		});
		expect(destParentIsFile._nay?.message).toBe("Destination folder is missing");

		// Same source and destination path.
		const samePath = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-src.md",
		});
		expect(samePath._nay?.message).toBe("Source and destination are the same");

		// Active sibling already owns the destination name.
		const siblingConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-sibling.md",
		});
		expect(siblingConflict._nay?.message).toBe("Path already exists");

		// Folder cannot move into its own subtree.
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-validate-folder",
				name: "move-validate-folder",
			}),
		);
		const subFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderId,
				path: "/move-validate-folder/sub",
				name: "sub",
			}),
		);
		const folderIntoItself = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: subFolderId,
			destName: "move-validate-folder",
		});
		expect(folderIntoItself._nay?.message).toBe("Cannot move a folder into itself");

		// Archived source nodes are not movable.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-validate" });
		});
		const archivedSource = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "moved.md",
		});
		expect(archivedSource._nay?.message).toBe("Not found");
	});
});

describe("apply_file_pending_move", () => {
	test("applies a pure file move and patches denormalized paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-src.md",
				name: "apply-src.md",
				markdown: "# Apply base",
			}),
		);
		const destFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-dest",
				name: "apply-dest",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const metadataDocId = await t.run((ctx) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				fileNodeId: seeded.nodeId,
				sourceKind: "committed",
				path: "/apply-src.md",
				treePath: "/apply-src.md",
				qualifiedField: "meta.topic",
				docKind: "field",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.parentId).toBe(destFolderId);
			expect(node?.name).toBe("renamed.md");
			expect(node?.path).toBe("/apply-dest/renamed.md");
			expect(node?.treePath).toBe("/apply-dest/renamed.md");

			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", plainTextChunkId);
			expect(plainTextChunk?.path).toBe("/apply-dest/renamed.md");

			const metadataDoc = await ctx.db.get("files_metadata_docs", metadataDocId);
			expect(metadataDoc?.path).toBe("/apply-dest/renamed.md");
			expect(metadataDoc?.treePath).toBe("/apply-dest/renamed.md");

			const rowAfterApply = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterApply).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
	});

	test("applies a folder move and cascades descendant paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const { folderId, destFolderId, childChunkIds } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder",
				name: "apply-folder",
			});
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId });
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder-dest",
				name: "apply-folder-dest",
			});
			const childChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-folder/child.md",
				markdown: seeded.baseMarkdown,
			});
			return { folderId, destFolderId, childChunkIds };
		});

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: destFolderId,
			destName: "apply-folder",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: folderId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/apply-folder-dest/apply-folder");
			expect(folder?.treePath).toBe("/apply-folder-dest/apply-folder/");
			expect(folder?.parentId).toBe(destFolderId);

			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(child?.path).toBe("/apply-folder-dest/apply-folder/child.md");

			const childChunk = await ctx.db.get("files_plain_text_chunks", childChunkIds.plainTextChunkId);
			expect(childChunk?.path).toBe("/apply-folder-dest/apply-folder/child.md");
		});
	});

	test("keeps the content proposal when applying a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-mixed-src.md",
				name: "apply-mixed-src.md",
				markdown: "# Apply mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-mixed-renamed.md");

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the applied move");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
			const rowMarkdownState = read_pending_row_markdown_state({ pendingUpdate: row });
			expect(rowMarkdownState.unstagedMarkdown).toContain("Apply mixed change");
		});
	});

	test("keeps a copiedFrom row that has no content", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-copy-source.md",
				name: "apply-copy-source.md",
				markdown: "# Apply copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-copy-dest.md",
				name: "apply-copy-dest.md",
				markdown: "# Apply copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// Anomalous row shape (move + copiedFrom, no yjs): apply must never delete a copiedFrom
		// row, or the eagerly-created destination node could not be discarded later.
		const rowId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				fileNodeId: dest.nodeId,
				pendingMove: {
					destParentId: files_ROOT_ID,
					destName: "apply-copy-renamed.md",
					fromPath: "/apply-copy-dest.md",
				},
				copiedFrom: { nodeId: source.nodeId, path: "/apply-copy-source.md" },
				size: 0,
				updatedAt: Date.now(),
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			pendingUpdateId: rowId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/apply-copy-renamed.md");
			const row = await ctx.db.get("files_pending_updates", rowId);
			if (!row) {
				throw new Error("Expected the copiedFrom row to survive the applied move");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(row.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/apply-copy-source.md" });
		});
	});

	test("keeps the row on an accept-time conflict", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-conflict-src.md",
				name: "apply-conflict-src.md",
				markdown: "# Apply conflict base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-conflict-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A file appears at the proposed destination after the proposal was created.
		await t.run(async (ctx) => {
			await ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/apply-conflict-dest.md",
				treePath: "/apply-conflict-dest.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "apply-conflict-dest.md",
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(applied._nay?.message).toBe("Path already exists");

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-conflict-src.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.pendingMove?.destName).toBe("apply-conflict-dest.md");
		});
	});

	test("returns Not found when the source was archived after the proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archived-src.md",
				name: "apply-archived-src.md",
				markdown: "# Apply archived base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-archived-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-apply" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(applied._nay?.message).toBe("Not found");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("apply-archived-dest.md");
	});
});

describe("discard_file_pending_structural", () => {
	test("deletes a pure-move row and leaves the node untouched", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-move-src.md",
				name: "discard-move-src.md",
				markdown: "# Discard move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/discard-move-src.md");
			const rowAfterDiscard = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterDiscard).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
	});

	test("drops the move and keeps the content on a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-mixed-src.md",
				name: "discard-mixed-src.md",
				markdown: "# Discard mixed base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDiscard mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the structural discard");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks.length).toBeGreaterThan(0);
		});
	});

	test("hard-deletes the eager copy destination node", async () => {
		const t = test_convex();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-source.md",
				name: "discard-copy-source.md",
				markdown: "# Copy source base",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-dest.md",
				name: "discard-copy-dest.md",
				markdown: "# Copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Extra dependents of the destination node that the hard delete must remove too.
		const { pendingRow, statsId, snapshotRowId, metadataDocId, assetIds, r2Keys } = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow?.copiedFrom) {
				throw new Error("Missing pending copy row before discard");
			}
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			if (!destNode?.assetId || !destNode.yjsSnapshotId || !destNode.yjsLastSequenceId) {
				throw new Error("Missing destination node pointers before discard");
			}
			const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", destNode.yjsSnapshotId);
			if (!yjsSnapshot) {
				throw new Error("Missing destination yjs snapshot before discard");
			}
			const statsId = await ctx.db.insert("file_stats", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				fileNodeId: dest.nodeId,
				lineCount: 1,
				wordCount: 3,
				charCount: 15,
			});
			// Points at the same asset as node.assetId, so the hard delete must dedupe asset ids.
			const snapshotRowId = await ctx.db.insert("files_snapshots", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				fileNodeId: dest.nodeId,
				assetId: destNode.assetId,
				createdBy: dest.userId,
				archivedAt: -1,
			});
			const metadataDocId = await ctx.db.insert("files_metadata_docs", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				fileNodeId: dest.nodeId,
				sourceKind: "committed",
				path: "/discard-copy-dest.md",
				treePath: "/discard-copy-dest.md",
				qualifiedField: "meta.topic",
				docKind: "field",
			});
			const assetIds = [destNode.assetId, yjsSnapshot.assetId];
			const r2Keys: string[] = [];
			for (const assetId of assetIds) {
				const asset = await ctx.db.get("files_r2_assets", assetId);
				if (asset?.r2Key) {
					r2Keys.push(asset.r2Key);
				}
			}
			return { pendingRow, statsId, snapshotRowId, metadataDocId, assetIds, r2Keys };
		});
		expect(r2Keys).toHaveLength(2);
		const lastSequenceSavedId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				fileNodeId: dest.nodeId,
				lastSequenceSaved: 0,
				updatedAt: Date.now(),
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			pendingUpdateId: pendingRow._id,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", dest.nodeId)).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			expect(await ctx.db.get("file_stats", statsId)).toBeNull();
			expect(await ctx.db.get("files_snapshots", snapshotRowId)).toBeNull();
			expect(await ctx.db.get("files_metadata_docs", metadataDocId)).toBeNull();
			expect(await ctx.db.get("files_pending_updates_last_sequence_saved", lastSequenceSavedId)).toBeNull();
			for (const assetId of assetIds) {
				expect(await ctx.db.get("files_r2_assets", assetId)).toBeNull();
			}
			const markdownChunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", dest.organizationId).eq("workspaceId", dest.workspaceId).eq("fileNodeId", dest.nodeId),
				)
				.collect();
			expect(markdownChunks).toHaveLength(0);
			const plainTextChunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", dest.organizationId).eq("workspaceId", dest.workspaceId).eq("fileNodeId", dest.nodeId),
				)
				.collect();
			expect(plainTextChunks).toHaveLength(0);
			const yjsSnapshots = await ctx.db
				.query("files_yjs_snapshots")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", dest.organizationId).eq("workspaceId", dest.workspaceId).eq("fileNodeId", dest.nodeId),
				)
				.collect();
			expect(yjsSnapshots).toHaveLength(0);
			const yjsLastSequences = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", dest.organizationId).eq("workspaceId", dest.workspaceId).eq("fileNodeId", dest.nodeId),
				)
				.collect();
			expect(yjsLastSequences).toHaveLength(0);
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
		for (const r2Key of r2Keys) {
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), r2Key);
		}

		// The source file is untouched.
		const sourceNode = await t.run((ctx) => ctx.db.get("files_nodes", source.nodeId));
		expect(sourceNode?.path).toBe("/discard-copy-source.md");
	});

	test("keeps the node when content was committed since the copy was proposed", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-source.md",
				name: "discard-copy-committed-source.md",
				markdown: "# Committed guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-dest.md",
				name: "discard-copy-committed-dest.md",
				markdown: "# Committed guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-committed-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Someone commits real content to the destination node through the regular Yjs flow.
		await t.run(async (ctx) => {
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			if (!destNode?.yjsLastSequenceId) {
				throw new Error("Missing destination yjsLastSequenceId while advancing committed state");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", destNode.yjsLastSequenceId, { lastSequence: 1 });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The node became a real file: only the proposal row is dropped.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-committed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when a rebase re-aligns the row base after a commit", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-source.md",
				name: "discard-copy-rebase-source.md",
				markdown: "# Rebase guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-dest.md",
				name: "discard-copy-rebase-dest.md",
				markdown: "# Rebase guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-rebase-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// Someone commits real content, then the client rebases the copy row: the rebase brings
		// baseYjsSequence back in line with the committed sequence, but the stamp must not move.
		const remoteMarkdown = `${dest.baseMarkdown}\n\nRemote commit`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: dest.nodeId,
				markdown: remoteMarkdown,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: unstagedBranchYjsDoc,
			markdown: `${remoteMarkdown}\n\nCopied content`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build rebased branch while testing the copy stamp");
		}
		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row?.baseYjsSequence).toBe(1);
			expect(row?.copiedFrom).toEqual({
				nodeId: source.nodeId,
				path: "/discard-copy-rebase-source.md",
				committedSequence: 0,
			});
		});

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Base and committed sequence match again, but the immutable stamp proves content was
			// committed after the copy: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-rebase-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when another user has a pending row on it", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-source.md",
				name: "discard-copy-otheruser-source.md",
				markdown: "# Other user guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-dest.md",
				name: "discard-copy-otheruser-dest.md",
				markdown: "# Other user guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-otheruser-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another user drafts on the destination node; hard delete would destroy their draft.
		const otherUserRowId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: "other_user_pending_guard",
				fileNodeId: dest.nodeId,
				size: 0,
				updatedAt: Date.now(),
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-otheruser-dest.md");
			const otherUserRow = await ctx.db.get("files_pending_updates", otherUserRowId);
			expect(otherUserRow).not.toBeNull();
			const proposerRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(proposerRow).toBeNull();
		});
	});

	test("returns Nothing to discard for content-only rows", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-src.md",
				name: "discard-content-src.md",
				markdown: "# Discard content base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent only`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(discarded._nay?.message).toBe("Nothing to discard");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("structural rows on content collapse", () => {
	test("content collapse on a mixed row degrades it to a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/degrade-mixed-src.md",
				name: "degrade-mixed-src.md",
				markdown: "# Degrade base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDegrade change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "degrade-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base would normally delete the row; the move must survive.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a degraded pure-move row after content collapse");
			}
			expect(row.pendingMove?.destName).toBe("degrade-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: row._id });
			expect(cleanupTasks).toHaveLength(1);
			expect(cleanupTasks[0]?.expectedUpdatedAt).toBe(row.updatedAt);
		});
	});

	test("a copy row with no content change is still persisted", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/copy-empty-source.md",
				name: "copy-empty-source.md",
				markdown: "# Copy empty base",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/copy-empty-dest.md",
				name: "copy-empty-dest.md",
				markdown: "# Copy empty base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Source content equals the destination base, so branch docs match base; without the
		// copiedFrom guard the row would never be written and the eager node could not be discarded.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: dest.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/copy-empty-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a persisted copy row for an unchanged copy");
		}
		expect(row.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/copy-empty-source.md", committedSequence: 0 });
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});

	test("content collapse keeps yjs fields on a copy row with a pending move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-copy-source.md",
				name: "collapse-copy-source.md",
				markdown: "# Collapse copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-copy-dest.md",
				name: "collapse-copy-dest.md",
				markdown: "# Collapse copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/collapse-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			destParentId: files_ROOT_ID,
			destName: "collapse-copy-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base must NOT hit the pure-move degrade branch: the copy row
		// keeps its yjs fields, so it can never become a copiedFrom row without content.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: dest.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the copy row to survive the content collapse");
		}
		expect(row.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/collapse-copy-source.md", committedSequence: 0 });
		expect(row.pendingMove?.destName).toBe("collapse-copy-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("save with structural rows", () => {
	test("save on a pure-move row returns No content to save", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-move-src.md",
				name: "save-move-src.md",
				markdown: "# Save move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(saved._nay?.message).toBe("No content to save");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("save-move-dest.md");
	});

	test("full save on a mixed row publishes the content and keeps the move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-mixed-src.md",
				name: "save-mixed-src.md",
				markdown: "# Save mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSave mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const committedMarkdown = await t.run((ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(committedMarkdown).toContain("Save mixed change");

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the move proposal to survive a full save");
			}
			expect(row.pendingMove?.destName).toBe("save-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: row._id });
			expect(cleanupTasks).toHaveLength(1);
			expect(cleanupTasks[0]?.expectedUpdatedAt).toBe(row.updatedAt);
		});
	});

	test("partial save clears copiedFrom so expiry cannot hard-delete the node", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-source.md",
				name: "save-copy-source.md",
				markdown: "# Save copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-dest.md",
				name: "save-copy-dest.md",
				markdown: "# Save copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Staged stays at base while unstaged carries the copied content, so a save is partial.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/save-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the pending row to survive a partial save");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("remove_file_pending_update_if_expired structural rows", () => {
	test("expiry hard-deletes the eager copy destination node", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-source.md",
				name: "expire-copy-source.md",
				markdown: "# Expire copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-dest.md",
				name: "expire-copy-dest.md",
				markdown: "# Expire copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/expire-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const { pendingRow, cleanupTask } = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing pending copy row before expiry");
			}
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			const cleanupTask = cleanupTasks[0];
			if (!cleanupTask) {
				throw new Error("Missing cleanup task before expiry");
			}
			return { pendingRow, cleanupTask };
		});

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", dest.nodeId)).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.path).toBe("/expire-copy-source.md");
		});
	});

	test("expiry deletes a pure-move row but keeps the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-move-src.md",
				name: "expire-move-src.md",
				markdown: "# Expire move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "expire-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const { pendingRow, cleanupTask } = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing pending move row before expiry");
			}
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			const cleanupTask = cleanupTasks[0];
			if (!cleanupTask) {
				throw new Error("Missing cleanup task before expiry");
			}
			return { pendingRow, cleanupTask };
		});

		// A stale expected timestamp must not delete the newer row.
		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt - 1,
		});
		const rowAfterStaleRun = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfterStaleRun).not.toBeNull();

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/expire-move-src.md");
		});
	});
});

describe("reads behind a pure-move row", () => {
	test("committed content stays readable behind a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/read-move-src.md",
				name: "read-move-src.md",
				markdown: "# Read move base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/read-move-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "read-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads must fall through to the committed chunks, not return an empty pending view.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read returns the committed content but still reports the
		// structural row's id, so write_file/edit_file mix onto it.
		const markdownState = await t.query(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);
	});
});

