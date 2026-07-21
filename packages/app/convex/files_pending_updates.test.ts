import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
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
	// Serve signed upload PUTs into the same r2Objects map, so tests can create files
	// through the real creation actions (create_file_by_path) instead of seeding docs.
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "pending-update-test-upload-key",
		url: `https://r2.test/upload?key=${encodeURIComponent(customKey ?? "pending-update-test-upload-key")}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) {
					r2Objects.set(key, body);
				} else if (body instanceof Uint8Array) {
					r2Objects.set(key, files_u8_to_array_buffer(body));
				} else {
					return new Response(null, { status: 400 });
				}
				return new Response(null, { status: 200 });
			}
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

async function seed_chat_thread(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
}) {
	return await args.ctx.db.insert("ai_chat_threads", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		clientGeneratedId: crypto.randomUUID(),
		title: null,
		archived: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
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
	copiedFrom?: { nodeId: Id<"files_nodes">; path: string; archivesSourceOnAccept?: boolean };
	eagerCreatedCommittedSequence?: number;
	eagerCreatedAncestorIds?: Id<"files_nodes">[];
	threadId?: Id<"ai_chat_threads">;
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
		...(args.eagerCreatedCommittedSequence !== undefined
			? { eagerCreatedCommittedSequence: args.eagerCreatedCommittedSequence }
			: {}),
		...(args.eagerCreatedAncestorIds !== undefined ? { eagerCreatedAncestorIds: args.eagerCreatedAncestorIds } : {}),
		...(args.threadId ? { threadId: args.threadId } : {}),
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
	replace?: boolean;
	threadId?: Id<"ai_chat_threads">;
}) {
	return await args.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		destParentId: args.destParentId,
		destName: args.destName,
		replace: args.replace,
		...(args.threadId ? { threadId: args.threadId } : {}),
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

	test("upsert_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
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

		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nFallback`);
		const staleUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: stalePendingRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		// The stale id must not fall back to the newer row: the upsert refuses instead of
		// overwriting it with the dead proposal's content.
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		const pendingRowAfterStaleUpsert = await t.run(async (ctx) =>
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
		expect(pendingRowAfterStaleUpsert).not.toBeNull();
		expect(pendingRowAfterStaleUpsert!._id).toBe(currentPendingRow._id);

		const pendingRowAfterStaleUpsertMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: pendingRowAfterStaleUpsert!,
		});
		expect(pendingRowAfterStaleUpsertMarkdownState.unstagedMarkdown).toContain("Current");
	});

	test("upsert_file_pending_update rejects a stale pendingUpdateId after a newer proposal replaced it", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-race",
				name: "pending-edits-stale-id-race",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale upsert");
		}

		// Tab B discards proposal one, then the agent creates a NEW proposal on the same file.
		await t.run(async (ctx) => {
			const [cleanupTasks, markdownChunks, plainTextChunks] = await Promise.all([
				list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_markdown_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...cleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
				...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (
			!secondRowBefore?.baseYjsUpdate ||
			!secondRowBefore.stagedBranchYjsUpdate ||
			!secondRowBefore.unstagedBranchYjsUpdate
		) {
			throw new Error("Missing second pending row before the stale upsert lands");
		}
		const secondRowBaseBytes = secondRowBefore.baseYjsUpdate;
		const secondRowStagedBytes = secondRowBefore.stagedBranchYjsUpdate;
		const secondRowUnstagedBytes = secondRowBefore.unstagedBranchYjsUpdate;

		// Tab A's delayed debounced upsert still carries proposal one's id and stale content.
		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nStale editor content`);
		const staleUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, byte-identical branches.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (
				!secondRowAfter?.baseYjsUpdate ||
				!secondRowAfter.stagedBranchYjsUpdate ||
				!secondRowAfter.unstagedBranchYjsUpdate
			) {
				throw new Error("Missing second pending row after the stale upsert");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			expect(new Uint8Array(secondRowAfter.baseYjsUpdate)).toEqual(new Uint8Array(secondRowBaseBytes));
			expect(new Uint8Array(secondRowAfter.stagedBranchYjsUpdate)).toEqual(new Uint8Array(secondRowStagedBytes));
			expect(new Uint8Array(secondRowAfter.unstagedBranchYjsUpdate)).toEqual(new Uint8Array(secondRowUnstagedBytes));
		});
	});

	test("upsert_file_pending_update creates a new row when the passed id is dead and no row exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-dead-id-create",
				name: "pending-edits-dead-id-create",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstUpserted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the discard");
		}

		// The proposal is discarded and NO newer row exists: a retry with the dead id is the
		// normal new-proposal path and must still create.
		await t.run(async (ctx) => {
			const [cleanupTasks, markdownChunks, plainTextChunks] = await Promise.all([
				list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_markdown_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...cleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
				...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});

		const retryMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nRetry content`);
		const retried = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: retryMarkdown,
		});
		if (retried._nay) {
			throw new Error(retried._nay.message);
		}

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!._id).not.toBe(firstRow._id);
		const rowAfterMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: rowAfter!,
		});
		expect(rowAfterMarkdownState.unstagedMarkdown).toBe(retryMarkdown);
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
		// The whitespace lands on its own trailing paragraph and file content always
		// ends with one `\n`, so the read-back shape differs from the raw input.
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe("# Base\n\n \n");
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

	test("an identical re-upsert refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-identical-ttl",
				name: "pending-edits-identical-ttl",
				markdown: "# Identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const unstagedMarkdown = `${seeded.baseMarkdown}\n\nIdentical TTL content`;
		const firstUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing identical re-upsert TTL refresh");
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

		// The AI re-writes the exact same pending content: the row bytes do not change, but
		// the 4h lifetime must still restart or the original cleanup task expires the proposal.
		const secondUpsertResult = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondPendingRow) {
			throw new Error("Missing pending doc after the identical re-upsert");
		}
		expect(secondPendingRow._id).toBe(firstPendingRow._id);
		expect(secondPendingRow.updatedAt).toBeGreaterThan(firstPendingRow.updatedAt);

		const secondCleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: secondPendingRow._id,
			}),
		);
		expect(secondCleanupTasks).toHaveLength(1);
		expect(secondCleanupTasks[0]!.expectedUpdatedAt).toBe(secondPendingRow.updatedAt);
		expect(secondCleanupTasks[0]!.scheduledFunctionId).not.toBe(firstCleanupTasks[0]!.scheduledFunctionId);
	});

	test("an identical re-upsert with eagerCreated stamps the row", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-identical-eager.md",
				name: "pending-edits-identical-eager.md",
				markdown: "# Identical eager base",
			}),
		);

		// Two chats race the same write_file: this row lands first WITHOUT the stamp because
		// its create_file_by_path saw the node already created.
		const writtenMarkdown = `${dest.baseMarkdown}\n\nWritten content`;
		const firstUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: writtenMarkdown,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row before the identical eager re-upsert");
		}
		expect(firstRow.eagerCreated).toBeUndefined();

		await new Promise((resolve) => setTimeout(resolve, 2));

		// The chat that eagerly created the node re-writes identical bytes: the stamp must
		// still land, or discard/expiry can never hard-delete the stranded node.
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: writtenMarkdown,
			eagerCreatedCommittedSequence: 0,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}

		const secondRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!secondRow) {
			throw new Error("Missing pending row after the identical eager re-upsert");
		}
		expect(secondRow._id).toBe(firstRow._id);
		expect(secondRow.eagerCreated).toEqual({ committedSequence: 0 });
		expect(secondRow.updatedAt).toBeGreaterThan(firstRow.updatedAt);
	});

	test("upsert_file_pending_update rejects a new proposal on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-new-row",
				name: "pending-edits-archived-new-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The file is archived between the tool's read and its upsert.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nToo late`,
		});
		expect(upserted._nay?.message).toBe("Not found");

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).toBeNull();
	});

	test("upsert_file_pending_update keeps an existing row editable on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-existing-row",
				name: "pending-edits-archived-existing-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The row exists before the file is archived.
		const firstUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBefore archive`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row before the archive");
		}

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		// The surviving row stays editable on the archived file.
		const editedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAfter archive`);
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: editedMarkdown,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const editedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(editedRow?._id).toBe(firstRow._id);
		const editedRowMarkdownState = read_pending_row_markdown_state({
			pendingUpdate: editedRow!,
		});
		expect(editedRowMarkdownState.unstagedMarkdown).toBe(editedMarkdown);

		// The panel's content-discard revert (upsert back to base) still clears the row.
		const reverted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const rowAfterRevert = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfterRevert).toBeNull();
	});
});

describe("pending update provenance", () => {
	test("a later replace proposal overwrites the recorded source", async () => {
		const t = test_convex();

		const sourceA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-a.md",
				name: "provenance-source-a.md",
				markdown: "# Provenance source A",
			}),
		);
		const sourceB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-b.md",
				name: "provenance-source-b.md",
				markdown: "# Provenance source B",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-dest.md",
				name: "provenance-dest.md",
				markdown: "# Provenance dest base",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);

		const firstCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceA.baseMarkdown}\n\nFrom A`,
			copiedFrom: { nodeId: sourceA.nodeId, path: "/provenance-source-a.md" },
		});
		if (firstCopy._nay) {
			throw new Error(firstCopy._nay.message);
		}

		// cp then mv -f onto the same target: the newest structural intent wins the provenance slot.
		const secondReplace = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceB.baseMarkdown}\n\nFrom B`,
			copiedFrom: { nodeId: sourceB.nodeId, path: "/provenance-source-b.md", archivesSourceOnAccept: true },
		});
		if (secondReplace._nay) {
			throw new Error(secondReplace._nay.message);
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
		expect(row?.copiedFrom).toEqual({
			nodeId: sourceB.nodeId,
			path: "/provenance-source-b.md",
			archivesSourceOnAccept: true,
		});
	});

	test("mv -f onto an existing copy row records the archive-source shape with identical content", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/identical-replace-src.md",
				name: "identical-replace-src.md",
				markdown: "# Identical replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/identical-replace-dest.md",
				name: "identical-replace-dest.md",
				markdown: "# Identical replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// cp onto the existing target: a plain copy-replace row with the source's content.
		const plainCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: source.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/identical-replace-src.md" },
		});
		if (plainCopy._nay) {
			throw new Error(plainCopy._nay.message);
		}

		// mv -f with byte-identical content: the row content already matches, but the row must
		// still turn into a replace-move (`archivesSourceOnAccept`), or accept never archives
		// the source and the overlay never hides it.
		const replaceMove = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: source.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/identical-replace-src.md", archivesSourceOnAccept: true },
		});
		if (replaceMove._nay) {
			throw new Error(replaceMove._nay.message);
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
		expect(row?.copiedFrom).toEqual({
			nodeId: source.nodeId,
			path: "/identical-replace-src.md",
			archivesSourceOnAccept: true,
		});

		// The overlay data now references the source node, and the source path reads as gone
		// for the proposer (other users keep seeing it).
		const overlayData = await t.query(internal.files_pending_updates.get_pending_path_overlay_data, {
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
		});
		expect(overlayData.referencedNodes.map((node) => node._id)).toContain(source.nodeId);
		const hiddenSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			path: "/identical-replace-src.md",
			overlayUserId: dest.userId,
		});
		expect(hiddenSource).toBeNull();
		const committedSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			path: "/identical-replace-src.md",
		});
		expect(committedSource?._id).toBe(source.nodeId);
	});

	test("a replace proposal clears the source's own pure pending move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/replace-clears-src.md",
				name: "replace-clears-src.md",
				markdown: "# Replace clears source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/replace-clears-dest.md",
				name: "replace-clears-dest.md",
				markdown: "# Replace clears dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// The source already has its own pending move (mv a→b before mv -f b→c).
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "replace-clears-elsewhere.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		const sourceRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				nodeId: source.nodeId,
			}),
		);
		if (!sourceRow) {
			throw new Error("Missing source move row before the replace proposal");
		}

		// A plain copy does not archive the source, so its move proposal stays.
		const plainCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied`,
			copiedFrom: { nodeId: source.nodeId, path: "/replace-clears-src.md" },
		});
		if (plainCopy._nay) {
			throw new Error(plainCopy._nay.message);
		}
		const sourceRowAfterCopy = await t.run((ctx) => ctx.db.get("files_pending_updates", sourceRow._id));
		expect(sourceRowAfterCopy?.pendingMove?.destName).toBe("replace-clears-elsewhere.md");

		// mv -f archives the source on accept: the newest structural intent wins, so the
		// source's stale move proposal is dropped (a pure move row is deleted).
		const replaceMove = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied`,
			copiedFrom: { nodeId: source.nodeId, path: "/replace-clears-src.md", archivesSourceOnAccept: true },
		});
		if (replaceMove._nay) {
			throw new Error(replaceMove._nay.message);
		}

		await t.run(async (ctx) => {
			const sourceRowAfterReplace = await ctx.db.get("files_pending_updates", sourceRow._id);
			expect(sourceRowAfterReplace).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: sourceRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
	});

	test("a replace proposal keeps the source's content when its row is mixed", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/replace-clears-mixed-src.md",
				name: "replace-clears-mixed-src.md",
				markdown: "# Replace clears mixed source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/replace-clears-mixed-dest.md",
				name: "replace-clears-mixed-dest.md",
				markdown: "# Replace clears mixed dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Mixed source row: a content edit plus a pending move.
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			stagedMarkdown: source.baseMarkdown,
			unstagedMarkdown: `${source.baseMarkdown}\n\nMixed source change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "replace-clears-mixed-elsewhere.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const replaceMove = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied`,
			copiedFrom: { nodeId: source.nodeId, path: "/replace-clears-mixed-src.md", archivesSourceOnAccept: true },
		});
		if (replaceMove._nay) {
			throw new Error(replaceMove._nay.message);
		}

		const sourceRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				nodeId: source.nodeId,
			}),
		);
		if (!sourceRow) {
			throw new Error("Expected the mixed source row to survive the replace proposal");
		}
		expect(sourceRow.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(sourceRow)).toBe(true);
		const sourceRowMarkdownState = read_pending_row_markdown_state({ pendingUpdate: sourceRow });
		expect(sourceRowMarkdownState.unstagedMarkdown).toContain("Mixed source change");
	});

	test("an agent content upsert stamps its thread and dedupes across writers", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-stamp.md",
				name: "thread-ids-stamp.md",
				markdown: "# Thread ids stamp base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([
				seed_chat_thread({ ctx, ...seeded }),
				seed_chat_thread({ ctx, ...seeded }),
			]),
		);

		const firstWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A`,
			threadId: threadA,
		});
		if (firstWrite._nay) {
			throw new Error(firstWrite._nay.message);
		}
		const rowAfterFirst = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterFirst?.threadIds).toEqual([threadA]);

		const secondWriteSameThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A again`,
			threadId: threadA,
		});
		if (secondWriteSameThread._nay) {
			throw new Error(secondWriteSameThread._nay.message);
		}
		const rowAfterSameThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterSameThread?.threadIds).toEqual([threadA]);

		const thirdWriteOtherThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread B`,
			threadId: threadB,
		});
		if (thirdWriteOtherThread._nay) {
			throw new Error(thirdWriteOtherThread._nay.message);
		}
		const rowAfterOtherThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterOtherThread?.threadIds).toEqual([threadA, threadB]);
	});

	test("an identical re-write from another chat still appends its thread", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-identical.md",
				name: "thread-ids-identical.md",
				markdown: "# Thread ids identical base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([
				seed_chat_thread({ ctx, ...seeded }),
				seed_chat_thread({ ctx, ...seeded }),
			]),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nSame bytes from both threads`;
		for (const threadId of [threadA, threadB]) {
			const written = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: changedMarkdown,
				threadId,
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("a client upsert preserves the recorded threads", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-client-preserve.md",
				name: "thread-ids-client-preserve.md",
				markdown: "# Thread ids client preserve base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}

		const clientWrite = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nClient edit on top`,
		});
		if (clientWrite._nay) {
			throw new Error(clientWrite._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA]);
	});

	test("an agent move stamps a fresh row and appends on an existing content row", async () => {
		const t = test_convex();

		const moveOnly = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-move-only.md",
				name: "thread-ids-move-only.md",
				markdown: "# Thread ids move only",
			}),
		);
		const contentThenMove = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-content-move.md",
				name: "thread-ids-content-move.md",
				markdown: "# Thread ids content move",
				membership: {
					userId: moveOnly.userId,
					organizationId: moveOnly.organizationId,
					workspaceId: moveOnly.workspaceId,
					membershipId: moveOnly.membershipId,
				},
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([
				seed_chat_thread({ ctx, ...moveOnly }),
				seed_chat_thread({ ctx, ...moveOnly }),
			]),
		);

		const freshMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: moveOnly.organizationId,
			workspaceId: moveOnly.workspaceId,
			userId: moveOnly.userId,
			nodeId: moveOnly.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-move-only-renamed.md",
			threadId: threadA,
		});
		if (freshMove._nay) {
			throw new Error(freshMove._nay.message);
		}
		const moveOnlyRow = await t.run((ctx) => read_pending_update_row({ ctx, ...moveOnly }));
		expect(moveOnlyRow?.pendingMove).toBeDefined();
		expect(moveOnlyRow?.threadIds).toEqual([threadA]);

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			unstagedMarkdown: `${contentThenMove.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveAfterContent = await upsert_file_pending_move_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-content-move-renamed.md",
			threadId: threadB,
		});
		if (moveAfterContent._nay) {
			throw new Error(moveAfterContent._nay.message);
		}
		const contentMoveRow = await t.run((ctx) => read_pending_update_row({ ctx, ...contentThenMove }));
		expect(contentMoveRow?.pendingMove).toBeDefined();
		expect(contentMoveRow?.threadIds).toEqual([threadA, threadB]);
	});

	test("a structural discard keeps the recorded threads on the surviving content doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-discard-preserve.md",
				name: "thread-ids-discard-preserve.md",
				markdown: "# Thread ids discard preserve base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([
				seed_chat_thread({ ctx, ...seeded }),
				seed_chat_thread({ ctx, ...seeded }),
			]),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveWrite = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-discard-preserve-renamed.md",
			threadId: threadB,
		});
		if (moveWrite._nay) {
			throw new Error(moveWrite._nay.message);
		}

		// The client-driven structural discard drops the move but keeps the content doc alive —
		// and with it the recorded contributor set.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row!)).toBe(true);
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("an upsert without a thread leaves threadIds unset until an agent write lands", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-unset.md",
				name: "thread-ids-unset.md",
				markdown: "# Thread ids unset base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));

		const threadlessWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nThreadless write`,
		});
		if (threadlessWrite._nay) {
			throw new Error(threadlessWrite._nay.message);
		}
		const rowAfterThreadless = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterThreadless?.threadIds).toBeUndefined();

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write after`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}
		const rowAfterAgent = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterAgent?.threadIds).toEqual([threadA]);
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

	test("save_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
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
		// The stale id must not fall back to the newer row: saving it would publish a
		// proposal this tab never had open.
		expect(saveResult._nay?.message).toBe("Not found");

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
		expect(pendingAfterSave!._id).toBe(currentPendingRow._id);

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).toBeNull();

		const savedMarkdownAfterRejectedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterRejectedSave).not.toContain("Current doc");
	});

	test("save_file_pending_update rejects a stale pendingUpdateId instead of accepting a newer replace proposal", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-source.md",
				name: "save-stale-id-replace-source.md",
				markdown: "# Stale save replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-dest.md",
				name: "save-stale-id-replace-dest.md",
				markdown: "# Stale save replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale save");
		}

		// Tab B discards proposal one, then the agent proposes an mv -f replace on the file.
		await t.run(async (ctx) => {
			const [cleanupTasks, markdownChunks, plainTextChunks] = await Promise.all([
				list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_markdown_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...cleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
				...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const replacementMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nReplacement content`);
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-stale-id-replace-source.md", archivesSourceOnAccept: true },
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!secondRowBefore) {
			throw new Error("Missing replace row before the stale save lands");
		}

		// Tab A's Save click still carries proposal one's id: acting on the replace row would
		// publish its content and archive the source — accepting a proposal the user never accepted.
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			pendingUpdateId: firstRow._id,
		});
		expect(saved._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// Nothing was published, the source stays active, and the replace row stays intact.
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).not.toContain("Replacement content");
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeUndefined();
			const rowAfter = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(rowAfter?._id).toBe(secondRowBefore._id);
			expect(rowAfter?.copiedFrom).toEqual({
				nodeId: source.nodeId,
				path: "/save-stale-id-replace-source.md",
				archivesSourceOnAccept: true,
			});
		});
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

	test("save_file_pending_update returns rate-limit _nay and preserves pending doc when the limiter rejects", async () => {
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
				throw new Error(`Expected save #${i + 1} to succeed, got: ${result._nay.message}`);
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

		// The bucket allows a burst of 50, so force the next limiter check to reject instead of
		// exhausting it with 50 real saves.
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValueOnce({ ok: false, retryAfter: 5_000 } as never);

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

	test("save_file_pending_update_in_db rejects a stale replayed save without publishing or billing again", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-replay",
				name: "pending-edits-save-stale-replay",
				markdown: "# Stale replay base",
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

		// Two tabs' save actions read this same live base before either mutation runs.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const firstSave = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (firstSave._nay) {
			throw new Error(firstSave._nay.message);
		}
		if (!firstSave._yay) {
			throw new Error("Missing save result _yay while testing the stale replayed save");
		}
		expect(firstSave._yay.newSequence).toBe(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());
		enqueueActionSpy.mockClear();

		// The second tab's mutation still runs with its stale action-read base.
		const replayedSave = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: originalFileState.yjsSequence,
			baseYjsUpdate: originalFileState.yjsUpdate,
		});
		expect(replayedSave._nay?.message).toBe("Stale save");
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());

		await t.run(async (ctx) => {
			// No second publish: the sequence and update count stay at the first save's values.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSequenceDoc?.lastSequence).toBe(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.baseYjsSequence).toBe(1);
		});
	});

	test("save_file_pending_update_in_db rejects a save whose base misses another user's commit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-concurrent-commit",
				name: "pending-edits-save-concurrent-commit",
				markdown: "# Concurrent commit base",
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

		// The save action reads this live base, then another user commits before the mutation runs.
		const actionReadFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const otherUserDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nOther user's commit`,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			update: otherUserDiff,
			sessionId: "other-user-session",
		});
		// The push above bills its own event; only the stale save below must not bill.
		enqueueActionSpy.mockClear();

		// The mutation still runs with the action-read base: saving would stamp the pushed
		// sequence onto row bytes that lack the other user's commit, hiding that commit
		// from pending reads while claiming the latest sequence.
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: actionReadFileState.yjsSequence,
			baseYjsUpdate: actionReadFileState.yjsUpdate,
		});
		expect(saved._nay?.message).toBe("Stale save");
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());

		await t.run(async (ctx) => {
			// Only the other user's commit exists; nothing was published on top of it.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.baseYjsSequence).toBe(0);
		});
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

	test("persist_file_pending_update_rebased_state rejects a mismatched pendingUpdateId from another file", async () => {
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

		// The synced id must match the row the mutation resolves: a foreign id means the
		// client's view is stale, so the persist refuses instead of patching either row.
		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.fileAId,
			pendingUpdateId: fileBPendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

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
		expect(fileAPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File A current");

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

	test("persist_file_pending_update_rebased_state does not recreate a discarded row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-discarded",
				name: "pending-edits-persist-discarded",
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
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Another tab discards the proposal while this tab's sync is in flight.
		await t.run(async (ctx) => {
			const [cleanupTasks, markdownChunks, plainTextChunks] = await Promise.all([
				list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id }),
				list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
			]);
			await Promise.all([
				...cleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
				...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", pendingRow._id),
			]);
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
			markdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the discarded row");
		}

		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The discarded proposal must stay dead: no row and no pending chunks reappear.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const markdownChunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(markdownChunks.filter((chunk) => chunk.sourceKind === "pending")).toHaveLength(0);
		});
	});

	test("persist_file_pending_update_rebased_state does not patch a newer proposal on the same file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-replaced",
				name: "pending-edits-persist-replaced",
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
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the in-flight sync");
		}

		// Another tab discards the first proposal, then the agent creates a NEW proposal on
		// the same file while this tab's sync is still in flight.
		await t.run(async (ctx) => {
			const [cleanupTasks, markdownChunks, plainTextChunks] = await Promise.all([
				list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_markdown_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...cleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
				...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent proposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRowBefore?.unstagedBranchYjsUpdate) {
			throw new Error("Missing second pending row before the stale sync lands");
		}
		const secondRowUnstagedBytes = secondRowBefore.unstagedBranchYjsUpdate;

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
			throw new Error("Failed to build stale sync branch while testing the replaced row");
		}

		// The stale sync still carries the FIRST row's id and branches.
		const persistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, same unstaged branch bytes.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter?.unstagedBranchYjsUpdate) {
				throw new Error("Missing second pending row after the stale sync");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			expect(new Uint8Array(secondRowAfter.unstagedBranchYjsUpdate)).toEqual(
				new Uint8Array(secondRowUnstagedBytes),
			);
		});
	});

	test("persist_file_pending_update_rebased_state_in_db rejects a stale base after a save advanced the row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale-base",
				name: "pending-edits-persist-stale-base",
				markdown: "# Persist stale base",
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
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Tab A's sync action reads this live base before tab B's save lands.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		// Tab B's partial save rebases the row to the new sequence with fresh unresolved content.
		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing the stale persist base");
		}
		expect(saveResult._yay.newSequence).toBe(1);

		const rowAfterSave = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowAfterSave?.baseYjsUpdate || !rowAfterSave.stagedBranchYjsUpdate || !rowAfterSave.unstagedBranchYjsUpdate) {
			throw new Error("Missing rebased pending row after the save");
		}
		expect(rowAfterSave.baseYjsSequence).toBe(1);
		const rowAfterSaveBaseBytes = rowAfterSave.baseYjsUpdate;
		const rowAfterSaveStagedBytes = rowAfterSave.stagedBranchYjsUpdate;
		const rowAfterSaveUnstagedBytes = rowAfterSave.unstagedBranchYjsUpdate;

		// Tab A's delayed mutation still carries branches rebased onto the OLD captured base.
		const staleBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(originalFileState.yjsUpdate);
		const staleUnstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: staleBaseYjsDoc,
		});
		const staleUnstagedProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: staleUnstagedBranchYjsDoc,
			markdown: `${seeded.baseMarkdown}\n\nStale sync content`,
		});
		if (staleUnstagedProjection._nay) {
			throw new Error("Failed to build the stale sync branch while testing the stale persist base");
		}

		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.persist_file_pending_update_rebased_state_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: pendingRow._id,
				baseYjsSequence: originalFileState.yjsSequence,
				baseYjsUpdate: originalFileState.yjsUpdate,
				latestBaseYjsSequence: originalFileState.yjsSequence,
				latestBaseYjsUpdate: originalFileState.yjsUpdate,
				stagedBranchYjsUpdate: originalFileState.yjsUpdate,
				unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(staleUnstagedBranchYjsDoc)),
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			// The post-save row must be untouched: same base sequence and branch bytes.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row?.baseYjsUpdate || !row.stagedBranchYjsUpdate || !row.unstagedBranchYjsUpdate) {
				throw new Error("Missing pending row after the stale persist");
			}
			expect(row.baseYjsSequence).toBe(1);
			expect(new Uint8Array(row.baseYjsUpdate)).toEqual(new Uint8Array(rowAfterSaveBaseBytes));
			expect(new Uint8Array(row.stagedBranchYjsUpdate)).toEqual(new Uint8Array(rowAfterSaveStagedBytes));
			expect(new Uint8Array(row.unstagedBranchYjsUpdate)).toEqual(new Uint8Array(rowAfterSaveUnstagedBytes));
		});
	});

	test("persist_file_pending_update_rebased_state_in_db does not resurrect content on a row degraded to a pure move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-degraded.md",
				name: "pending-edits-persist-degraded.md",
				markdown: "# Persist degraded base",
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
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nMixed content`,
		});
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-edits-persist-degraded-dest.md",
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
		if (
			!mixedRow?.baseYjsUpdate ||
			mixedRow.baseYjsSequence == null ||
			!mixedRow.stagedBranchYjsUpdate ||
			!mixedRow.unstagedBranchYjsUpdate
		) {
			throw new Error("Missing mixed pending row before the revert");
		}
		const capturedBaseYjsSequence = mixedRow.baseYjsSequence;
		const capturedBaseBytes = mixedRow.baseYjsUpdate;
		const capturedStagedBytes = mixedRow.stagedBranchYjsUpdate;
		const capturedUnstagedBytes = mixedRow.unstagedBranchYjsUpdate;

		// Another tab reverts the content: the row degrades to a pure move with no yjs fields.
		const reverted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const degradedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(degradedRow?._id).toBe(mixedRow._id);
		expect(degradedRow?.baseYjsSequence).toBeUndefined();

		// The in-flight sync still carries the reverted content branches with the old captured base.
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.persist_file_pending_update_rebased_state_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: mixedRow._id,
				baseYjsSequence: capturedBaseYjsSequence,
				baseYjsUpdate: capturedBaseBytes,
				latestBaseYjsSequence: capturedBaseYjsSequence,
				latestBaseYjsUpdate: capturedBaseBytes,
				stagedBranchYjsUpdate: capturedStagedBytes,
				unstagedBranchYjsUpdate: capturedUnstagedBytes,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The pure-move row must stay content-free: resurrecting the branches would revive
			// a proposal the user already reverted.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?._id).toBe(mixedRow._id);
			expect(row?.pendingMove?.destName).toBe("pending-edits-persist-degraded-dest.md");
			expect(row?.baseYjsSequence).toBeUndefined();
			expect(row?.baseYjsUpdate).toBeUndefined();
			expect(row?.stagedBranchYjsUpdate).toBeUndefined();
			expect(row?.unstagedBranchYjsUpdate).toBeUndefined();
		});
	});

	test("an identical persist refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-identical-ttl",
				name: "pending-edits-persist-identical-ttl",
				markdown: "# Persist identical TTL base",
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
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: unstagedBranchYjsDoc,
			markdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the unstaged branch while testing identical persist TTL refresh");
		}
		const persistArgs = {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		};

		const firstPersistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, persistArgs);
		if (firstPersistResult._nay) {
			throw new Error(firstPersistResult._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row after the first persist");
		}
		const firstCleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: firstRow._id,
			}),
		);
		expect(firstCleanupTasks).toHaveLength(1);
		expect(firstCleanupTasks[0]!.expectedUpdatedAt).toBe(firstRow.updatedAt);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// A retried sync persists the exact same bytes: the row content does not change, but
		// the 4h lifetime must still restart or the original cleanup task expires the proposal.
		const secondPersistResult = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, persistArgs);
		if (secondPersistResult._nay) {
			throw new Error(secondPersistResult._nay.message);
		}
		expect(secondPersistResult._yay.pendingUpdate).not.toBeNull();

		const secondRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRow) {
			throw new Error("Missing pending row after the identical persist");
		}
		expect(secondRow._id).toBe(firstRow._id);
		expect(secondRow.updatedAt).toBeGreaterThan(firstRow.updatedAt);

		const secondCleanupTasks = await t.run((ctx) =>
			list_pending_update_cleanup_tasks({
				ctx,
				pendingUpdateId: secondRow._id,
			}),
		);
		expect(secondCleanupTasks).toHaveLength(1);
		expect(secondCleanupTasks[0]!.expectedUpdatedAt).toBe(secondRow.updatedAt);
		expect(secondCleanupTasks[0]!.scheduledFunctionId).not.toBe(firstCleanupTasks[0]!.scheduledFunctionId);
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
			replacesExistingOccupant: false,
			cancelledExistingMove: false,
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

	test("records the replace target only with the replace opt-in", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-src.md",
				name: "move-replace-src.md",
				markdown: "# Replace source base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-dest.md",
				name: "move-replace-dest.md",
				markdown: "# Replace dest base",
				membership,
			}),
		);

		// Without the opt-in the occupied destination stays a conflict.
		const withoutReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
		});
		expect(withoutReplace._nay?.message).toBe("Path already exists");

		const withReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
			replace: true,
		});
		if (withReplace._nay) {
			throw new Error(withReplace._nay.message);
		}
		expect(withReplace._yay).toEqual({
			fromPath: "/move-replace-src.md",
			destPath: "/move-replace-dest.md",
			replacesExistingOccupant: true,
			cancelledExistingMove: false,
		});

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove).toEqual({
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
			fromPath: "/move-replace-src.md",
			replacesNodeId: occupant.nodeId,
		});

		// A file never replaces a folder occupant, even with the opt-in.
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-replace-folder",
				name: "move-replace-folder",
			}),
		);
		const folderConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-folder",
			replace: true,
		});
		expect(folderConflict._nay?.message).toBe("Path already exists");
	});

	test("accepts a destination vacated by the proposer's own pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-src.md",
				name: "vacated-src.md",
				markdown: "# Vacated base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-other.md",
				name: "vacated-other.md",
				markdown: "# Vacated other base",
				membership,
			}),
		);

		// The first proposal vacates /vacated-src.md in the proposer's visible tree.
		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// The committed sibling moved away for this user, so its path is free to claim.
		const reuseMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-src.md",
		});
		if (reuseMove._nay) {
			throw new Error(reuseMove._nay.message);
		}
		expect(reuseMove._yay.destPath).toBe("/vacated-src.md");
		expect(reuseMove._yay.replacesExistingOccupant).toBe(false);
	});

	test("rejects a destination already claimed by another pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-a.md",
				name: "claim-a.md",
				markdown: "# Claim a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-b.md",
				name: "claim-b.md",
				markdown: "# Claim b base",
				membership,
			}),
		);

		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// One visible path, one proposal: the second claim is rejected, replace or not.
		const doubleBooked = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		expect(doubleBooked._nay?.message).toBe("Path already exists");
		const doubleBookedReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
			replace: true,
		});
		expect(doubleBookedReplace._nay?.message).toBe("Path already exists");
	});

	test("rejects a folder parent cycle across two pending moves", async () => {
		const t = test_convex();

		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const folderAId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-a",
				name: "parent-cycle-a",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-b",
				name: "parent-cycle-b",
			}),
		);
		const folderCId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-c",
				name: "parent-cycle-c",
			}),
		);

		// Folder A moves into folder B: A shows at /parent-cycle-b/x.
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderAId,
			destParentId: folderBId,
			destName: "x",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Folder B into the moved folder A: the visible destination sits inside B itself, a
		// parent cycle across two rows that would drop both rows from the overlay.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderBId,
			destParentId: folderAId,
			destName: "inside",
		});
		expect(moveB._nay?.message).toBe("Cannot move a folder into itself");

		// A legitimate move of an unrelated folder into the moved folder A still passes.
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderCId,
			destParentId: folderAId,
			destName: "c",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		expect(moveC._yay.destPath).toBe("/parent-cycle-a/c");
	});

	test("rejects a folder replace proposal onto a non-empty folder", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-full/keep.md",
				name: "keep.md",
				markdown: "# Edr proposal keep base",
			}),
		);
		const { folderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-src",
				name: "edr-p-src",
			});
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-full",
				name: "edr-p-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return { folderId };
		});

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-full",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("rejects replacing an empty folder occupant that a pending move targets into", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-into-file.md",
				name: "edr-p-into-file.md",
				markdown: "# Edr into base",
			}),
		);
		const { folderId, emptyFolderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into-src",
				name: "edr-p-into-src",
			});
			const emptyFolderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into",
				name: "edr-p-into",
			});
			return { folderId, emptyFolderId };
		});

		// The user proposes moving a file INTO the empty folder: replacing the folder would
		// break that proposal's destination, so the folder no longer counts as empty.
		const movedIn = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: emptyFolderId,
			destName: "moved.md",
		});
		if (movedIn._nay) {
			throw new Error(movedIn._nay.message);
		}
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-into",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("keeps a file replace proposal onto an empty folder rejected", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-file-src.md",
				name: "edr-p-file-src.md",
				markdown: "# Edr file src base",
			}),
		);
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-dstdir",
				name: "edr-p-dstdir",
			}),
		);

		// rename() fails EISDIR here: a file never replaces a folder, empty or not.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-dstdir",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Path already exists");
	});

	test("mv back to the original path cancels a pure pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-move-src.md",
				name: "cancel-move-src.md",
				markdown: "# Cancel move base",
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
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
			throw new Error("Missing pending move row before cancel");
		}

		// mv back to the source path cancels the proposal instead of failing validation.
		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay).toEqual({
			fromPath: "/cancel-move-src.md",
			destPath: "/cancel-move-src.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(row).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});

		// Without a pending move the same-path mv keeps the current rejection.
		const samePathWithoutRow = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		expect(samePathWithoutRow._nay?.message).toBe("Source and destination are the same");
	});

	test("mv back to the original path keeps the content of a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-mixed-src.md",
				name: "cancel-mixed-src.md",
				markdown: "# Cancel mixed base",
			}),
		);

		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCancel mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay.cancelledExistingMove).toBe(true);

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the content proposal to survive the cancelled move");
		}
		expect(row.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
		const rowMarkdownState = read_pending_row_markdown_state({ pendingUpdate: row });
		expect(rowMarkdownState.unstagedMarkdown).toContain("Cancel mixed change");
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
				eagerCreated: { committedSequence: 0 },
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
			expect(row.eagerCreated).toEqual({ committedSequence: 0 });
		});
	});

	test("auto-replaces a newcomer file at the destination on accept", async () => {
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

		// A file appears at the proposed destination after the proposal was created. The
		// pending move claims its destination, so accept replaces the newcomer like `mv -f`.
		const newcomerNodeId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
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
			}),
		);

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
			// The newcomer is archived (recoverable), never hard-deleted, and the move proceeds.
			const newcomerNode = await ctx.db.get("files_nodes", newcomerNodeId);
			expect(newcomerNode?.archiveOperationId).toBeDefined();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-conflict-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("archives the replaced file when applying a replace move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-src.md",
				name: "apply-replace-src.md",
				markdown: "# Apply replace base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-dest.md",
				name: "apply-replace-dest.md",
				markdown: "# Apply replace dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-dest.md",
			replace: true,
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
			nodeId: seeded.nodeId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The replaced file is archived (recoverable), never hard-deleted.
			const replacedNode = await ctx.db.get("files_nodes", occupant.nodeId);
			expect(replacedNode?.archiveOperationId).toBeDefined();

			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-replace-dest.md");
			expect(node?.archiveOperationId).toBeUndefined();

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the row when a folder owns the destination at accept", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-src.md",
				name: "apply-replace-conflict-src.md",
				markdown: "# Replace conflict base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
				markdown: "# Replace conflict dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-conflict-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The recorded target goes away and a FOLDER takes the destination path. Files
		// auto-replace at accept, but a folder occupant still fails and keeps the row.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupant.nodeId, { archiveOperationId: "archive-op-replaced-away" });
			await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
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
			expect(node?.path).toBe("/apply-replace-conflict-src.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.pendingMove?.replacesNodeId).toBe(occupant.nodeId);
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

	test("rejects accepting a chained move before the vacating move is accepted", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-a.md",
				name: "chain-a.md",
				markdown: "# Chain a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-b.md",
				name: "chain-b.md",
				markdown: "# Chain b base",
				membership,
			}),
		);

		// Move B vacates /chain-b.md in the proposer's visible tree, so move A may claim it.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}
		const pendingRowA = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRowA) {
			throw new Error("Missing pending move row for move A before apply");
		}

		// Accepting A first must not archive B: B still sits at /chain-b.md only because its own
		// pending move is not accepted yet, so accept must ask for B's move first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(applied._nay?.message).toBe('Accept the pending move of "chain-b.md" first');

		await t.run(async (ctx) => {
			const occupant = await ctx.db.get("files_nodes", other.nodeId);
			expect(occupant?.archiveOperationId).toBeUndefined();
			expect(occupant?.path).toBe("/chain-b.md");

			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/chain-a.md");

			const rowA = await ctx.db.get("files_pending_updates", pendingRowA._id);
			expect(rowA?.pendingMove?.destName).toBe("chain-b.md");
		});
	});

	test("accepts chained moves in dependency order", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-a.md",
				name: "chain-order-a.md",
				markdown: "# Chain order a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-b.md",
				name: "chain-order-b.md",
				markdown: "# Chain order b base",
				membership,
			}),
		);

		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Accepting B first frees /chain-order-b.md, so accepting A afterwards is a plain move.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const appliedB = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: other.nodeId,
		});
		if (appliedB._nay) {
			throw new Error(appliedB._nay.message);
		}
		const appliedA = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (appliedA._nay) {
			throw new Error(appliedA._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/chain-order-c.md");
			expect(nodeB?.archiveOperationId).toBeUndefined();

			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/chain-order-b.md");
			expect(nodeA?.archiveOperationId).toBeUndefined();
		});
	});

	test("accepts a two-file swap cycle in one accept", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-a.md",
				name: "swap-a.md",
				markdown: "# Swap a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-b.md",
				name: "swap-b.md",
				markdown: "# Swap b base",
				membership,
			}),
		);

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a cycle (A: a→b, B: b→a) that no single accept order can resolve.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
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
			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/swap-b.md");
			expect(nodeA?.name).toBe("swap-b.md");
			expect(nodeA?.archiveOperationId).toBeUndefined();

			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/swap-a.md");
			expect(nodeB?.name).toBe("swap-a.md");
			expect(nodeB?.archiveOperationId).toBeUndefined();

			const rowA = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(rowA).toBeNull();
			const rowB = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: other.nodeId,
			});
			expect(rowB).toBeNull();
		});

		// The bulk accept flow still calls accept for the settled second row: no-op success.
		const appliedB = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: other.nodeId,
		});
		expect(appliedB._nay).toBeUndefined();
	});

	test("a mixed row inside a swap cycle keeps its content proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-a.md",
				name: "swap-mixed-a.md",
				markdown: "# Swap mixed a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-b.md",
				name: "swap-mixed-b.md",
				markdown: "# Swap mixed b base",
				membership,
			}),
		);

		// B carries a content edit, so its row stays mixed through the swap.
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			stagedMarkdown: other.baseMarkdown,
			unstagedMarkdown: `${other.baseMarkdown}\n\nSwap mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the mixed row's side: the cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: other.nodeId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/swap-mixed-b.md");
			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/swap-mixed-a.md");

			// A's pure move row is settled away; B keeps its content proposal.
			const rowA = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(rowA).toBeNull();
			const rowB = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: other.nodeId,
			});
			if (!rowB) {
				throw new Error("Expected the mixed row to survive the swap accept");
			}
			expect(rowB.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(rowB)).toBe(true);
			const rowBMarkdownState = read_pending_row_markdown_state({ pendingUpdate: rowB });
			expect(rowBMarkdownState.unstagedMarkdown).toContain("Swap mixed change");
		});
	});

	test("accepts a rotation cycle longer than twelve files in one accept", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/rotate-1.md",
				name: "rotate-1.md",
				markdown: "# Rotate 1 base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const fileCount = 14;
		const rotated = [seeded];
		for (let index = 2; index <= fileCount; index++) {
			const file = await t.run(async (ctx) =>
				seed_file_with_markdown({
					ctx,
					path: `/rotate-${index}.md`,
					name: `rotate-${index}.md`,
					markdown: `# Rotate ${index} base`,
					membership,
				}),
			);
			rotated.push(file);
		}

		// mv f1→tmp frees /rotate-1.md, each next mv shifts a file down one slot, and the final
		// mv replaces f1's tmp proposal: the rows form one rotation cycle of 14 files.
		const movedToTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "rotate-tmp.md",
		});
		if (movedToTmp._nay) {
			throw new Error(movedToTmp._nay.message);
		}
		for (const [index, file] of rotated.entries()) {
			if (index === 0) {
				continue;
			}
			const moved = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: file.nodeId,
				destParentId: files_ROOT_ID,
				destName: `rotate-${index}.md`,
			});
			if (moved._nay) {
				throw new Error(moved._nay.message);
			}
		}
		const movedToLast = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: `rotate-${fileCount}.md`,
		});
		if (movedToLast._nay) {
			throw new Error(movedToLast._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
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
			for (const [index, file] of rotated.entries()) {
				const node = await ctx.db.get("files_nodes", file.nodeId);
				expect(node?.path).toBe(index === 0 ? `/rotate-${fileCount}.md` : `/rotate-${index}.md`);
				expect(node?.archiveOperationId).toBeUndefined();

				const row = await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: file.nodeId,
				});
				expect(row).toBeNull();
			}
		});
	});

	test("accepts a two-folder swap cycle in one accept", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc swap a child base",
			}),
		);
		const membership = {
			userId: childA.userId,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			membershipId: childA.membershipId,
		};
		const childB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-b/b-child.md",
				name: "b-child.md",
				markdown: "# Fsc swap b child base",
				membership,
			}),
		);
		const { folderAId, folderBId, childAChunkIds } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-a",
				name: "fsc-swap-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-b",
				name: "fsc-swap-b",
			});
			await ctx.db.patch("files_nodes", childB.nodeId, { parentId: folderBId });
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-swap-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a folder swap cycle (A: a→b, B: b→a).
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			nodeId: folderAId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folderA = await ctx.db.get("files_nodes", folderAId);
			expect(folderA?.path).toBe("/fsc-swap-b");
			expect(folderA?.treePath).toBe("/fsc-swap-b/");
			expect(folderA?.archiveOperationId).toBeUndefined();

			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-swap-a");
			expect(folderB?.treePath).toBe("/fsc-swap-a/");
			expect(folderB?.archiveOperationId).toBeUndefined();

			// Both children cascaded under their folder's swapped path.
			const movedChildA = await ctx.db.get("files_nodes", childA.nodeId);
			expect(movedChildA?.path).toBe("/fsc-swap-b/a-child.md");
			const movedChildB = await ctx.db.get("files_nodes", childB.nodeId);
			expect(movedChildB?.path).toBe("/fsc-swap-a/b-child.md");
			const childAChunk = await ctx.db.get("files_plain_text_chunks", childAChunkIds.plainTextChunkId);
			expect(childAChunk?.path).toBe("/fsc-swap-b/a-child.md");

			const rowA = await read_pending_update_row({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				nodeId: folderAId,
			});
			expect(rowA).toBeNull();
			const rowB = await read_pending_update_row({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				nodeId: folderBId,
			});
			expect(rowB).toBeNull();
		});

		// The bulk accept flow still calls accept for the settled second row: no-op success.
		const appliedB = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			nodeId: folderBId,
		});
		expect(appliedB._nay).toBeUndefined();
	});

	test("accepts a mixed file and folder swap cycle in one accept", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-mix-a.md",
				name: "fsc-mix-a.md",
				markdown: "# Fsc mix a base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-mix-b",
				name: "fsc-mix-b",
			}),
		);

		// The file and the folder trade paths through a temp name.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the mixed cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: folderBId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const fileA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(fileA?.path).toBe("/fsc-mix-b");
			expect(fileA?.archiveOperationId).toBeUndefined();
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-mix-a.md");
			expect(folderB?.archiveOperationId).toBeUndefined();

			const rowA = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(rowA).toBeNull();
			const rowB = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: folderBId,
			});
			expect(rowB).toBeNull();
		});
	});

	test("settles a content-plus-move cycle member and keeps its content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-cnm-a.md",
				name: "fsc-cnm-a.md",
				markdown: "# Fsc cnm base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-cnm-b",
				name: "fsc-cnm-b",
			}),
		);

		// The file carries a content proposal, then joins the swap: its doc is content-plus-move.
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCnm change`);
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
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the file is the NON-clicked cycle member.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: folderBId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const fileA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(fileA?.path).toBe("/fsc-cnm-b");
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-cnm-a.md");

			// The content doc survives without the move, and its pending chunks follow the file.
			const rowA = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!rowA) {
				throw new Error("Expected the content proposal to survive the cycle accept");
			}
			expect(rowA.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(rowA)).toBe(true);
			const pendingChunks = await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: rowA._id });
			expect(pendingChunks.length).toBeGreaterThan(0);
			for (const chunk of pendingChunks) {
				expect(chunk.path).toBe("/fsc-cnm-b");
			}

			const rowB = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: folderBId,
			});
			expect(rowB).toBeNull();
		});
	});

	test("accepts a three-folder rotation cycle in one accept", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-rot-a/rot-child.md",
				name: "rot-child.md",
				markdown: "# Fsc rot child base",
			}),
		);
		const { folderAId, folderBId, folderCId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-a",
				name: "fsc-rot-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-b",
				name: "fsc-rot-b",
			});
			const folderCId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-c",
				name: "fsc-rot-c",
			});
			return { folderAId, folderBId, folderCId };
		});

		// A→tmp frees a, B claims a, C claims b, and the final move replaces A's tmp
		// row: the three rows form the A→c, B→a, C→b rotation.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderCId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-b",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-c",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			nodeId: folderBId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folderA = await ctx.db.get("files_nodes", folderAId);
			expect(folderA?.path).toBe("/fsc-rot-c");
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-rot-a");
			const folderC = await ctx.db.get("files_nodes", folderCId);
			expect(folderC?.path).toBe("/fsc-rot-b");

			const movedChild = await ctx.db.get("files_nodes", childA.nodeId);
			expect(movedChild?.path).toBe("/fsc-rot-c/rot-child.md");

			for (const folderId of [folderAId, folderBId, folderCId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: childA.organizationId,
					workspaceId: childA.workspaceId,
					userId: childA.userId,
					nodeId: folderId,
				});
				expect(row).toBeNull();
			}
		});
	});

	test("keeps cycle member paths correct when the destination parent also moves in the cycle", async () => {
		const t = test_convex();

		// M=/fsc-nest-m holds C=child.md; K=/fsc-nest-k.md is a file with committed chunks.
		const childC = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-m/child.md",
				name: "child.md",
				markdown: "# Fsc nest child base",
			}),
		);
		const membership = {
			userId: childC.userId,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			membershipId: childC.membershipId,
		};
		const fileK = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-k.md",
				name: "fsc-nest-k.md",
				markdown: "# Fsc nest k base",
				membership,
			}),
		);
		const { folderMId, fileKChunkIds } = await t.run(async (ctx) => {
			const folderMId = await seed_folder_node({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				userId: childC.userId,
				path: "/fsc-nest-m",
				name: "fsc-nest-m",
			});
			await ctx.db.patch("files_nodes", childC.nodeId, { parentId: folderMId });
			const fileKChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				nodeId: fileK.nodeId,
				path: "/fsc-nest-k.md",
				markdown: fileK.baseMarkdown,
			});
			return { folderMId, fileKChunkIds };
		});

		// C→tmp frees child.md, K claims it INSIDE M, M claims K's path, and the final
		// move replaces C's tmp row: the cycle is C→/fsc-nest-m, M→/fsc-nest-k.md,
		// K→(M)/child.md — K's destination parent M moves in the same cycle.
		const moveCTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-tmp.md",
		});
		if (moveCTmp._nay) {
			throw new Error(moveCTmp._nay.message);
		}
		const moveK = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: fileK.nodeId,
			destParentId: folderMId,
			destName: "child.md",
		});
		if (moveK._nay) {
			throw new Error(moveK._nay.message);
		}
		const moveM = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: folderMId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-k.md",
		});
		if (moveM._nay) {
			throw new Error(moveM._nay.message);
		}
		const moveCFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-m",
		});
		if (moveCFinal._nay) {
			throw new Error(moveCFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childC.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childC.membershipId,
			nodeId: childC.nodeId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const fileC = await ctx.db.get("files_nodes", childC.nodeId);
			expect(fileC?.path).toBe("/fsc-nest-m");
			const folderM = await ctx.db.get("files_nodes", folderMId);
			expect(folderM?.path).toBe("/fsc-nest-k.md");
			expect(folderM?.treePath).toBe("/fsc-nest-k.md/");

			// K's path must come from M's FINAL location, not M's pre-move path.
			const nodeK = await ctx.db.get("files_nodes", fileK.nodeId);
			expect(nodeK?.parentId).toBe(folderMId);
			expect(nodeK?.path).toBe("/fsc-nest-k.md/child.md");
			const chunkK = await ctx.db.get("files_plain_text_chunks", fileKChunkIds.plainTextChunkId);
			expect(chunkK?.path).toBe("/fsc-nest-k.md/child.md");

			for (const nodeId of [childC.nodeId, folderMId, fileK.nodeId]) {
				const node = await ctx.db.get("files_nodes", nodeId);
				expect(node?.archiveOperationId).toBeUndefined();
				const row = await read_pending_update_row({
					ctx,
					organizationId: childC.organizationId,
					workspaceId: childC.workspaceId,
					userId: childC.userId,
					nodeId,
				});
				expect(row).toBeNull();
			}
		});
	});

	test("rejects the accept when a concurrent move gave the cycle a parent loop", async () => {
		const t = test_convex();

		// A=/fsc-loop-q/a and B=/fsc-loop-b swap; Q is A's committed parent.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-loop-file.md",
				name: "fsc-loop-file.md",
				markdown: "# Fsc loop base",
			}),
		);
		const { folderQId, folderAId, folderBId } = await t.run(async (ctx) => {
			const folderQId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-q",
				name: "fsc-loop-q",
			});
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderQId,
				path: "/fsc-loop-q/a",
				name: "a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-b",
				name: "fsc-loop-b",
			});
			return { folderQId, folderAId, folderBId };
		});

		// The swap cycle: A→/fsc-loop-b, B→(Q)/a.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: folderQId,
			destName: "a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Another user commits Q under B after the proposals: the final tree would nest
		// B under Q and Q under B — a parent loop.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderQId, {
				parentId: folderBId,
				path: "/fsc-loop-b/fsc-loop-q",
				treePath: "/fsc-loop-b/fsc-loop-q/",
				pathDepth: 2,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: folderAId,
		});
		expect(applied._nay?.message).toBe("Cannot move a folder into itself");

		await t.run(async (ctx) => {
			// Nothing moved or archived, and both rows survive for retry or discard.
			const folderA = await ctx.db.get("files_nodes", folderAId);
			expect(folderA?.path).toBe("/fsc-loop-q/a");
			expect(folderA?.archiveOperationId).toBeUndefined();
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-loop-b");
			expect(folderB?.archiveOperationId).toBeUndefined();
			for (const nodeId of [folderAId, folderBId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId,
				});
				expect(row?.pendingMove).toBeDefined();
			}
		});
	});

	test("accepts a folder swap when the accepted member targets an empty folder occupant", async () => {
		const t = test_convex();

		// A holds a child (with chunks); B is EMPTY, so A's destination occupant is
		// replaceable on its own — the cycle must still swap, never archive B.
		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-empty-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc empty a child base",
			}),
		);
		const { folderAId, folderBId, childAChunkIds } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-a",
				name: "fsc-empty-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-b",
				name: "fsc-empty-b",
			});
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-empty-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			nodeId: folderAId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folderA = await ctx.db.get("files_nodes", folderAId);
			expect(folderA?.path).toBe("/fsc-empty-b");
			expect(folderA?.archiveOperationId).toBeUndefined();
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.path).toBe("/fsc-empty-a");
			expect(folderB?.archiveOperationId).toBeUndefined();

			const movedChild = await ctx.db.get("files_nodes", childA.nodeId);
			expect(movedChild?.path).toBe("/fsc-empty-b/a-child.md");
			const childAChunk = await ctx.db.get("files_plain_text_chunks", childAChunkIds.plainTextChunkId);
			expect(childAChunk?.path).toBe("/fsc-empty-b/a-child.md");

			for (const nodeId of [folderAId, folderBId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: childA.organizationId,
					workspaceId: childA.workspaceId,
					userId: childA.userId,
					nodeId,
				});
				expect(row).toBeNull();
			}
		});
	});

	test("accepts a folder move that replaces an empty folder occupant", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-src/child.md",
				name: "child.md",
				markdown: "# Edr child base",
			}),
		);
		const { folderId, occupantId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-src",
				name: "edr-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-dst",
				name: "edr-dst",
			});
			return { folderId, occupantId };
		});

		// rename() semantics: a folder may replace an EMPTY folder occupant.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-dst",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: child.membershipId,
			nodeId: folderId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The empty occupant is archived (never hard-deleted), the mover owns the path.
			const occupant = await ctx.db.get("files_nodes", occupantId);
			expect(occupant?.archiveOperationId).toBeDefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-dst");
			expect(folder?.archiveOperationId).toBeUndefined();
			const movedChild = await ctx.db.get("files_nodes", child.nodeId);
			expect(movedChild?.path).toBe("/edr-dst/child.md");

			const row = await read_pending_update_row({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				nodeId: folderId,
			});
			expect(row).toBeNull();
		});
	});

	test("auto-replaces an empty folder newcomer at accept", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-new-src/child.md",
				name: "child.md",
				markdown: "# Edr newcomer child base",
			}),
		);
		const folderId = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new-src",
				name: "edr-new-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return folderId;
		});

		// Propose while the destination is free, then an empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-new",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const newcomerId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new",
				name: "edr-new",
			}),
		);

		// Accept replays rename(): the empty folder occupant is auto-replaced like a file.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: child.membershipId,
			nodeId: folderId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const newcomer = await ctx.db.get("files_nodes", newcomerId);
			expect(newcomer?.archiveOperationId).toBeDefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-new");
			const movedChild = await ctx.db.get("files_nodes", child.nodeId);
			expect(movedChild?.path).toBe("/edr-new/child.md");
		});
	});

	test("rejects the accept when a pending move targets into the empty folder newcomer", async () => {
		const t = test_convex();

		const file = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-claim-file.md",
				name: "edr-claim-file.md",
				markdown: "# Edr claim base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim-src",
				name: "edr-claim-src",
			}),
		);

		// Propose while the destination is free, then an empty folder lands there and this
		// user proposes a move INTO it: that pending move counts as occupancy.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-claim",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const newcomerId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim",
				name: "edr-claim",
			}),
		);
		const movedInto = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: file.nodeId,
			destParentId: newcomerId,
			destName: "into.md",
		});
		if (movedInto._nay) {
			throw new Error(movedInto._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: file.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: file.membershipId,
			nodeId: folderId,
		});
		expect(applied._nay?.message).toBe("Directory not empty");

		await t.run(async (ctx) => {
			// Nothing moved or archived, and both pending docs survive.
			const newcomer = await ctx.db.get("files_nodes", newcomerId);
			expect(newcomer?.archiveOperationId).toBeUndefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-claim-src");
			for (const nodeId of [folderId, file.nodeId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: file.organizationId,
					workspaceId: file.workspaceId,
					userId: file.userId,
					nodeId,
				});
				expect(row?.pendingMove).toBeDefined();
			}
		});
	});

	test("rejects the accept when the folder occupant is not empty", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-full/keep.md",
				name: "keep.md",
				markdown: "# Edr keep base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full-src",
				name: "edr-full-src",
			}),
		);

		// Propose while the destination is free, then a NON-empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-full",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const occupantId = await t.run(async (ctx) => {
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full",
				name: "edr-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return occupantId;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: occupantChild.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: occupantChild.membershipId,
			nodeId: folderId,
		});
		expect(applied._nay?.message).toBe("Directory not empty");

		await t.run(async (ctx) => {
			// Nothing moved or archived, and the row survives for retry or discard.
			const occupant = await ctx.db.get("files_nodes", occupantId);
			expect(occupant?.archiveOperationId).toBeUndefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-full-src");
			const row = await read_pending_update_row({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				nodeId: folderId,
			});
			expect(row?.pendingMove).toBeDefined();
		});
	});

	test("returns success when the move was already applied on a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-idem-src.md",
				name: "apply-idem-src.md",
				markdown: "# Apply idem base",
			}),
		);

		// Mixed row: the content proposal keeps the row alive after the first accept.
		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply idem change`;
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
			destName: "apply-idem-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
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
			throw new Error("Missing mixed pending row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const firstApplied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (firstApplied._nay) {
			throw new Error(firstApplied._nay.message);
		}

		// The bulk accept flow retries the same call; the move is already applied, so the retry
		// must be a success no-op instead of "Not found", or the content step never runs.
		const secondApplied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(secondApplied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-idem-renamed.md");

			const row = await ctx.db.get("files_pending_updates", pendingRow._id);
			if (!row) {
				throw new Error("Expected the content proposal to survive the retried apply");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("accepts a pure move whose rename the UI already performed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-renamed-src.md",
				name: "apply-ui-renamed-src.md",
				markdown: "# Apply ui renamed base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-renamed-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A committed rename lands the node at the proposed destination before the accept.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-renamed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		// The move is already applied, so accept is a success no-op that settles the row.
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-ui-renamed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the content when a mixed row's move was already renamed into place", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-mixed-src.md",
				name: "apply-ui-mixed-src.md",
				markdown: "# Apply ui mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUi mixed change`);
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
			destName: "apply-ui-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-mixed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the already-applied move");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
		});

		// The content step of the accept still works after the no-op move settlement.
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		await t.run(async (ctx) => {
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			});
			expect(committedMarkdown).toContain("Ui mixed change");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
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

	test("archives the discarded swap member when the other member's accept replaces it", async () => {
		const t = test_convex();

		// Two EMPTY folders swap; discarding one side turns the other accept into a
		// plain empty-folder replacement of the now-stationary occupant.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-disc-file.md",
				name: "edr-disc-file.md",
				markdown: "# Edr disc base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-a",
				name: "edr-disc-a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-b",
				name: "edr-disc-b",
			});
			return { folderAId, folderBId };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: folderBId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			nodeId: folderAId,
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// B no longer vacates, so A's accept soft-archives it and takes the path.
			const folderB = await ctx.db.get("files_nodes", folderBId);
			expect(folderB?.archiveOperationId).toBeDefined();
			const folderA = await ctx.db.get("files_nodes", folderAId);
			expect(folderA?.path).toBe("/edr-disc-b");
			expect(folderA?.archiveOperationId).toBeUndefined();
			for (const nodeId of [folderAId, folderBId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId,
				});
				expect(row).toBeNull();
			}
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
			eagerCreatedCommittedSequence: 0,
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

	test("hard-deletes an eagerly created write_file destination", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		// write_file onto a new path: the node was eagerly created for this proposal, no copiedFrom.
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-eager-write-dest.md",
				name: "discard-eager-write-dest.md",
				markdown: "# Eager write base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
			eagerCreatedCommittedSequence: 0,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager write row before discard");
		}
		expect(pendingRow.eagerCreated).toEqual({ committedSequence: 0 });

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
			expect(await ctx.db.get("files_nodes", dest.nodeId)).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("keeps a file saved between its eager create and the proposal upsert", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});

		// write_file eagerly creates the node and captures the CREATION-time committed sequence.
		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/discard-eager-saved-in-window.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		expect(created._yay.createdCommittedSequence).toBe(0);
		const nodeId = created._yay.nodeId;

		// The user edits and SAVES the brand-new file before the proposal upsert lands.
		const savedMarkdown = normalize_pending_update_markdown("# Saved by the user");
		const editorUpserted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: membership.membershipId,
			nodeId,
			stagedMarkdown: savedMarkdown,
			unstagedMarkdown: savedMarkdown,
		});
		if (editorUpserted._nay) {
			throw new Error(editorUpserted._nay.message);
		}
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: membership.membershipId,
			nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		// The proposal upsert lands late with the CREATION-time capture, not the current sequence.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager row before discard");
		}
		expect(pendingRow.eagerCreated).toEqual({ committedSequence: 0 });

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The save advanced the node past the creation-time stamp: the gate fails closed, the
			// node keeps the saved content, and only the proposal row is dropped.
			const node = await ctx.db.get("files_nodes", nodeId);
			expect(node?.path).toBe("/discard-eager-saved-in-window.md");
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId,
			});
			expect(committedMarkdown).toContain("Saved by the user");
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("still hard-deletes an untouched node created through the real create action", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});

		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/discard-eager-untouched.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				nodeId: created._yay.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager row before discard");
		}
		expect(pendingRow.eagerCreated).toEqual({ committedSequence: 0 });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// No save landed in the window: the untouched eager node is removed entirely.
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("discard removes the eager leaf and its created ancestor folders", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});

		// write_file on a deep new path eagerly creates the leaf AND its missing folders.
		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13a/deep/x.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		expect(created._yay.createdAncestorIds).toHaveLength(2);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			eagerCreatedAncestorIds: created._yay.createdAncestorIds,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				nodeId: created._yay.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager row before discard");
		}
		expect(pendingRow.eagerCreated).toEqual({
			committedSequence: 0,
			createdAncestorIds: created._yay.createdAncestorIds,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard removes the untouched leaf and both still-empty created folders.
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
			for (const ancestorId of created._yay.createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).toBeNull();
			}
		});
	});

	test("discard keeps an ancestor folder that gained another committed file", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});

		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13c/deep/x.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		const [deepAncestorId, shallowAncestorId] = created._yay.createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}

		// A second committed file under /r13c makes that folder non-empty once the deep
		// branch is discarded away.
		const sibling = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13c/other.md",
		});
		if (sibling._nay) {
			throw new Error(sibling._nay.message);
		}

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			eagerCreatedAncestorIds: created._yay.createdAncestorIds,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The empty deep folder goes with the leaf; /r13c keeps the committed sibling.
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
			expect(await ctx.db.get("files_nodes", deepAncestorId)).toBeNull();
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
			expect(await ctx.db.get("files_nodes", sibling._yay.nodeId)).not.toBeNull();
		});
	});

	test("discard keeps an ancestor folder that is another user's pending move destination", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});

		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13i/deep/x.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		const [deepAncestorId, shallowAncestorId] = created._yay.createdAncestorIds;
		if (!deepAncestorId || !shallowAncestorId) {
			throw new Error("Expected two created ancestor folder ids");
		}

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			eagerCreatedAncestorIds: created._yay.createdAncestorIds,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another user proposes moving their own file INTO the created folder through the REAL
		// move-upsert: the row lives on their file, not on the folder, but its destination is
		// the folder and deleting it would break their Accept later.
		const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "clerk_discard_move_dest_other" }));
		const otherFile = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: otherUserId,
			path: "/discard-move-dest-source.md",
		});
		if (otherFile._nay) {
			throw new Error(otherFile._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: otherUserId,
			nodeId: otherFile._yay.nodeId,
			destParentId: deepAncestorId,
			destName: "discard-move-dest-source.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The untouched leaf goes, but the folder is another user's pending move
			// destination and must survive with their proposal intact.
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
			expect(await ctx.db.get("files_nodes", deepAncestorId)).not.toBeNull();
			expect(await ctx.db.get("files_nodes", shallowAncestorId)).not.toBeNull();
			const otherRow = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", otherFile._yay.nodeId))
				.first();
			expect(otherRow?.pendingMove?.destParentId).toBe(deepAncestorId);
		});
	});

	test("discard keeps the node and its created folders when a save advanced the sequence", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Test User",
		});

		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13d/deep/x.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}

		// The user edits and SAVES the brand-new file before the proposal upsert lands.
		const savedMarkdown = normalize_pending_update_markdown("# Saved by the user");
		const editorUpserted = await asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
			stagedMarkdown: savedMarkdown,
			unstagedMarkdown: savedMarkdown,
		});
		if (editorUpserted._nay) {
			throw new Error(editorUpserted._nay.message);
		}
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			eagerCreatedAncestorIds: created._yay.createdAncestorIds,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: membership.membershipId,
			nodeId: created._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The save advanced the node past the creation-time stamp: keep the leaf and
			// never touch the created folders (they contain the surviving leaf).
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			expect(node?.path).toBe("/r13d/deep/x.md");
			for (const ancestorId of created._yay.createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).not.toBeNull();
			}
		});
	});

	test("keeps the node when discarding a replace-copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-replace-copy-source.md",
				name: "discard-replace-copy-source.md",
				markdown: "# Replace copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-replace-copy-dest.md",
				name: "discard-replace-copy-dest.md",
				markdown: "# Replace copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the destination node was NOT created by the proposal.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-replace-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

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
			// Only the proposal row is dropped; the pre-existing node keeps its committed content.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-replace-copy-dest.md");
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

	test("discarding a replace-move row keeps both files", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-replace-move-source.md",
				name: "discard-replace-move-source.md",
				markdown: "# Replace move source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-replace-move-dest.md",
				name: "discard-replace-move-dest.md",
				markdown: "# Replace move dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// mv -f between editable files: the replace lives on the TARGET row with the archive flag.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-replace-move-source.md", archivesSourceOnAccept: true },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

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
			// Nothing moved and nothing was archived: only the proposal row is dropped.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeUndefined();
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBeUndefined();
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
			eagerCreatedCommittedSequence: 0,
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
			eagerCreatedCommittedSequence: 0,
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
			expect(row?.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/discard-copy-rebase-source.md" });
			expect(row?.eagerCreated).toEqual({ committedSequence: 0 });
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
			eagerCreatedCommittedSequence: 0,
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

	test("keeps an eager node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-eager-renamed-dest.md",
				name: "discard-eager-renamed-dest.md",
				markdown: "# Eager renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
			eagerCreatedCommittedSequence: 0,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager row before discard");
		}

		// Another workspace member commits a rename of the placeholder through the REAL
		// rename_node mutation (structural only: the Yjs sequence does not move, so the
		// stamp still matches).
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_eager_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await asOtherUser.mutation(api.files_nodes.rename_node, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "discard-eager-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

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
			// The other user's rename must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-eager-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeUndefined();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
	});

	test("keeps an eager node that another user moved with move_nodes since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-eager-moved-dest.md",
				name: "discard-eager-moved-dest.md",
				markdown: "# Eager moved base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
			eagerCreatedCommittedSequence: 0,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing eager row before discard");
		}

		// Another workspace member drags the placeholder into a folder through the REAL
		// move_nodes mutation.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_eager_moved_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				path: "/discard-eager-moved-folder",
				name: "discard-eager-moved-folder",
			});
			return { otherUserId, otherMembershipId, folderId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const moved = await asOtherUser.mutation(api.files_nodes.move_nodes, {
			membershipId: other.otherMembershipId,
			itemIds: [dest.nodeId],
			targetParentId: other.folderId,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

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
			// The other user's move must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-eager-moved-folder/discard-eager-moved-dest.md");
			expect(node?.archiveOperationId).toBeUndefined();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			expect(cleanupTasks).toHaveLength(0);
		});
	});

	test("hard-deletes an eager node after another user dragged it onto its same parent", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-eager-same-parent-dest.md",
				name: "discard-eager-same-parent-dest.md",
				markdown: "# Eager same parent base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
			eagerCreatedCommittedSequence: 0,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another workspace member drags the placeholder onto the parent it is already in
		// (the Files UI allows this). A structural no-op must not stamp updatedBy, or the
		// eager hard-delete gate would wrongly treat the node as touched by another user.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_eager_same_parent_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const moved = await asOtherUser.mutation(api.files_nodes.move_nodes, {
			membershipId: other.otherMembershipId,
			itemIds: [dest.nodeId],
			targetParentId: files_ROOT_ID,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.updatedBy).toBe(dest.userId);
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
			// The no-op drag did not make the node a real file: discard hard-deletes it.
			expect(await ctx.db.get("files_nodes", dest.nodeId)).toBeNull();
		});
	});

	test("no-ops on content-only rows and keeps the content", async () => {
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
		// No structural aspect on the row: the discard is an idempotent no-op success.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(discarded._nay).toBeUndefined();

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
			eagerCreatedCommittedSequence: 0,
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
		expect(row.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/copy-empty-source.md" });
		expect(row.eagerCreated).toEqual({ committedSequence: 0 });
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
			eagerCreatedCommittedSequence: 0,
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
		expect(row.copiedFrom).toEqual({ nodeId: source.nodeId, path: "/collapse-copy-source.md" });
		expect(row.eagerCreated).toEqual({ committedSequence: 0 });
		expect(row.pendingMove?.destName).toBe("collapse-copy-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});

	test("content collapse degrades a replace-copy row with a move to a pure move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-source.md",
				name: "collapse-replace-source.md",
				markdown: "# Collapse replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-dest.md",
				name: "collapse-replace-dest.md",
				markdown: "# Collapse replace dest base",
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
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/collapse-replace-source.md" },
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
			destName: "collapse-replace-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base hits the pure-move degrade branch: the non-eager
		// provenance is stale without content, so the patch clears copiedFrom too.
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
			throw new Error("Expected the degraded pure-move row to survive the content collapse");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(row.pendingMove?.destName).toBe("collapse-replace-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(false);
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
			eagerCreatedCommittedSequence: 0,
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

	test("full save on a replace-move row archives the source file", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-replace-move-source.md",
				name: "save-replace-move-source.md",
				markdown: "# Save replace move source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-replace-move-dest.md",
				name: "save-replace-move-dest.md",
				markdown: "# Save replace move dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const replacementMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nReplacement content`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-replace-move-source.md", archivesSourceOnAccept: true },
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

		const committedMarkdown = await t.run((ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			}),
		);
		expect(committedMarkdown).toContain("Replacement content");

		await t.run(async (ctx) => {
			// The accepted replace archives the source file (recoverable) and resolves the row.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeDefined();
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBeUndefined();
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

	test("an identical-content replace-move row persists and accepting archives the source", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-same-replace-source.md",
				name: "save-same-replace-source.md",
				markdown: "# Same replace content",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-same-replace-dest.md",
				name: "save-same-replace-dest.md",
				markdown: "# Same replace content",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// Identical content collapses to base, but the row must persist: accepting it still
		// archives the source file, which is the whole point of the mv.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: dest.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-same-replace-source.md", archivesSourceOnAccept: true },
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
			throw new Error("Expected a persisted replace-move row for identical content");
		}
		expect(row.copiedFrom).toEqual({
			nodeId: source.nodeId,
			path: "/save-same-replace-source.md",
			archivesSourceOnAccept: true,
		});
		expect(files_pending_update_has_yjs_content(row)).toBe(true);

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

		await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeDefined();
			const rowAfterSave = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(rowAfterSave).toBeNull();
		});
	});

	test("a partial save that publishes staged content archives the replace source", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-partial-replace-source.md",
				name: "save-partial-replace-source.md",
				markdown: "# Partial replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-partial-replace-dest.md",
				name: "save-partial-replace-dest.md",
				markdown: "# Partial replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// Staged carries part of the replacement while unstaged has more: the save publishes the
		// staged part, so the source is archived and the rest stays reviewable.
		const stagedMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nPart one`);
		const unstagedMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nPart one\n\nPart two`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-partial-replace-source.md", archivesSourceOnAccept: true },
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

		await t.run(async (ctx) => {
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeDefined();
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending row to survive a partial save");
			}
			expect(row.copiedFrom).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("save onto an archived target returns Not found and keeps the row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-source.md",
				name: "save-archived-target-source.md",
				markdown: "# Archived target source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-dest.md",
				name: "save-archived-target-dest.md",
				markdown: "# Archived target dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const replacementMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nArchived target replacement`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-archived-target-source.md", archivesSourceOnAccept: true },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Any user archives the target file before the proposer accepts.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", dest.nodeId, { archiveOperationId: "archive-op-save-target" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
		});
		expect(saved._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// Nothing was published or archived: the source stays active and the row stays intact.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeUndefined();
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending row to survive the failed save");
			}
			expect(row.copiedFrom).toEqual({
				nodeId: source.nodeId,
				path: "/save-archived-target-source.md",
				archivesSourceOnAccept: true,
			});
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("accepting a replace removes the proposer's leftover row on the archived source", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-replace-leftover-source.md",
				name: "save-replace-leftover-source.md",
				markdown: "# Replace leftover source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-replace-leftover-dest.md",
				name: "save-replace-leftover-dest.md",
				markdown: "# Replace leftover dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// A pre-mv content edit leaves a content row on the source; the mv -f absorb carries the
		// content into the replace proposal but the source row itself stays behind.
		const leftoverMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nLeftover edit`);
		const leftover = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			stagedMarkdown: source.baseMarkdown,
			unstagedMarkdown: leftoverMarkdown,
		});
		if (leftover._nay) {
			throw new Error(leftover._nay.message);
		}
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: leftoverMarkdown,
			unstagedMarkdown: leftoverMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-replace-leftover-source.md", archivesSourceOnAccept: true },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const leftoverRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				nodeId: source.nodeId,
			}),
		);
		if (!leftoverRow) {
			throw new Error("Missing leftover content row on the source before accept");
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

		await t.run(async (ctx) => {
			// The accepted replace archives the source and takes the leftover row with it.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeDefined();
			const rowAfterSave = await ctx.db.get("files_pending_updates", leftoverRow._id);
			expect(rowAfterSave).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: leftoverRow._id });
			expect(cleanupTasks).toHaveLength(0);
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: leftoverRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	async function seed_replace_chain_files(t: ReturnType<typeof test_convex>, prefix: string) {
		const fileA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: `/${prefix}-a.md`,
				name: `${prefix}-a.md`,
				markdown: "# Chain source a",
			}),
		);
		const membership = {
			userId: fileA.userId,
			organizationId: fileA.organizationId,
			workspaceId: fileA.workspaceId,
			membershipId: fileA.membershipId,
		};
		const fileB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: `/${prefix}-b.md`,
				name: `${prefix}-b.md`,
				markdown: "# Chain b base",
				membership,
			}),
		);
		const fileC = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: `/${prefix}-c.md`,
				name: `${prefix}-c.md`,
				markdown: "# Chain c base",
				membership,
			}),
		);

		// mv -f a b, then mv -f b c: each hop is a replace row on its target carrying the
		// visible chain content.
		const chainMarkdown = normalize_pending_update_markdown(`${fileA.baseMarkdown}\n\nChain content`);
		const replaceOnB = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: fileA.organizationId,
			workspaceId: fileA.workspaceId,
			userId: fileA.userId,
			nodeId: fileB.nodeId,
			stagedMarkdown: chainMarkdown,
			unstagedMarkdown: chainMarkdown,
			copiedFrom: { nodeId: fileA.nodeId, path: `/${prefix}-a.md`, archivesSourceOnAccept: true },
		});
		if (replaceOnB._nay) {
			throw new Error(replaceOnB._nay.message);
		}
		const replaceOnC = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: fileA.organizationId,
			workspaceId: fileA.workspaceId,
			userId: fileA.userId,
			nodeId: fileC.nodeId,
			stagedMarkdown: chainMarkdown,
			unstagedMarkdown: chainMarkdown,
			copiedFrom: { nodeId: fileB.nodeId, path: `/${prefix}-b.md`, archivesSourceOnAccept: true },
		});
		if (replaceOnC._nay) {
			throw new Error(replaceOnC._nay.message);
		}

		return { fileA, fileB, fileC, chainMarkdown };
	}

	test("accepting the head of a chained replace archives every source in the chain", async () => {
		const t = test_convex();

		const { fileA, fileB, fileC } = await seed_replace_chain_files(t, "save-chain-head");
		const rowOnB = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				nodeId: fileB.nodeId,
			}),
		);
		if (!rowOnB) {
			throw new Error("Missing replace row on b before accept");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fileA.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: fileA.membershipId,
			nodeId: fileC.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		await t.run(async (ctx) => {
			// Accepting c consumed the whole chain: b AND a are archived and every row is gone.
			const nodeC = await ctx.db.get("files_nodes", fileC.nodeId);
			expect(nodeC?.archiveOperationId).toBeUndefined();
			const nodeB = await ctx.db.get("files_nodes", fileB.nodeId);
			expect(nodeB?.archiveOperationId).toBeDefined();
			const nodeA = await ctx.db.get("files_nodes", fileA.nodeId);
			expect(nodeA?.archiveOperationId).toBeDefined();
			expect(await ctx.db.get("files_pending_updates", rowOnB._id)).toBeNull();
			const rowOnC = await read_pending_update_row({
				ctx,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				nodeId: fileC.nodeId,
			});
			expect(rowOnC).toBeNull();
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: rowOnB._id });
			expect(cleanupTasks).toHaveLength(0);
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: rowOnB._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("accepting chained replaces from the tail reaches the same end state", async () => {
		const t = test_convex();

		const { fileA, fileB, fileC } = await seed_replace_chain_files(t, "save-chain-tail");

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fileA.userId,
			name: "Test User",
		});
		const savedB = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: fileA.membershipId,
			nodeId: fileB.nodeId,
		});
		if (savedB._nay) {
			throw new Error(savedB._nay.message);
		}
		const savedC = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: fileA.membershipId,
			nodeId: fileC.nodeId,
		});
		if (savedC._nay) {
			throw new Error(savedC._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeC = await ctx.db.get("files_nodes", fileC.nodeId);
			expect(nodeC?.archiveOperationId).toBeUndefined();
			const nodeB = await ctx.db.get("files_nodes", fileB.nodeId);
			expect(nodeB?.archiveOperationId).toBeDefined();
			const nodeA = await ctx.db.get("files_nodes", fileA.nodeId);
			expect(nodeA?.archiveOperationId).toBeDefined();
			for (const nodeId of [fileA.nodeId, fileB.nodeId, fileC.nodeId]) {
				const row = await read_pending_update_row({
					ctx,
					organizationId: fileA.organizationId,
					workspaceId: fileA.workspaceId,
					userId: fileA.userId,
					nodeId,
				});
				expect(row).toBeNull();
			}
		});
	});

	test("a chained replace stops cleanly at a source already archived by someone else", async () => {
		const t = test_convex();

		const { fileA, fileB, fileC } = await seed_replace_chain_files(t, "save-chain-archived");
		// Someone else archives the deepest source before the accept.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", fileA.nodeId, { archiveOperationId: "archive-op-chain-other" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fileA.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: fileA.membershipId,
			nodeId: fileC.nodeId,
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		await t.run(async (ctx) => {
			// b is archived and its row is consumed; the already-archived a keeps its operation id.
			const nodeB = await ctx.db.get("files_nodes", fileB.nodeId);
			expect(nodeB?.archiveOperationId).toBeDefined();
			const nodeA = await ctx.db.get("files_nodes", fileA.nodeId);
			expect(nodeA?.archiveOperationId).toBe("archive-op-chain-other");
			const rowOnB = await read_pending_update_row({
				ctx,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				nodeId: fileB.nodeId,
			});
			expect(rowOnB).toBeNull();
		});
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
			eagerCreatedCommittedSequence: 0,
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

	test("expiry removes the eager leaf and its created ancestor folders", async () => {
		const t = test_convex();
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const membership = await t.run(async (ctx) => {
			const seededMembership = await test_mocks_fill_db_with.membership(ctx);
			await seed_billing_snapshot_for_user(ctx, seededMembership.userId);
			return seededMembership;
		});

		// write_file on a deep new path eagerly creates the leaf AND its missing folders.
		const created = await t.action(internal.files_nodes.create_file_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/r13e/deep/x.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		if (!created._yay.created) {
			throw new Error("Expected create_file_by_path to create a fresh node");
		}
		expect(created._yay.createdAncestorIds).toHaveLength(2);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: created._yay.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Written content"),
			eagerCreatedCommittedSequence: created._yay.createdCommittedSequence,
			eagerCreatedAncestorIds: created._yay.createdAncestorIds,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const { pendingRow, cleanupTask } = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				nodeId: created._yay.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing eager row before expiry");
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
			// Expiry removes the untouched leaf and both still-empty created folders.
			expect(await ctx.db.get("files_nodes", created._yay.nodeId)).toBeNull();
			for (const ancestorId of created._yay.createdAncestorIds) {
				expect(await ctx.db.get("files_nodes", ancestorId)).toBeNull();
			}
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("expiry keeps an eager node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-eager-renamed-dest.md",
				name: "expire-eager-renamed-dest.md",
				markdown: "# Expire eager renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
			eagerCreatedCommittedSequence: 0,
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
				throw new Error("Missing eager row before expiry");
			}
			const cleanupTasks = await list_pending_update_cleanup_tasks({ ctx, pendingUpdateId: pendingRow._id });
			const cleanupTask = cleanupTasks[0];
			if (!cleanupTask) {
				throw new Error("Missing cleanup task before expiry");
			}
			return { pendingRow, cleanupTask };
		});

		// Another workspace member commits a rename of the placeholder through the REAL
		// rename_node mutation (structural only: the Yjs sequence does not move, so the
		// stamp still matches).
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_expire_eager_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await asOtherUser.mutation(api.files_nodes.rename_node, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "expire-eager-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		await t.mutation(internal.ai_chat.remove_file_pending_update_if_expired, {
			pendingUpdateId: pendingRow._id,
			expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
		});

		await t.run(async (ctx) => {
			// The other user's rename must survive expiry: keep the node, drop only the row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-eager-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeUndefined();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_markdown_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("expiry deletes a replace-copy row but keeps the node", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-replace-copy-source.md",
				name: "expire-replace-copy-source.md",
				markdown: "# Expire replace copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-replace-copy-dest.md",
				name: "expire-replace-copy-dest.md",
				markdown: "# Expire replace copy dest base",
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
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/expire-replace-copy-source.md" },
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
				throw new Error("Missing replace-copy row before expiry");
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
			// The row expires like a plain content row; the pre-existing node is never hard-deleted.
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-replace-copy-dest.md");
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

describe("pending path overlay reads", () => {
	test("get_by_path resolves through the proposer's pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-src.md",
				name: "overlay-src.md",
				markdown: "# Overlay base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The claimed destination presents the moved node with its doc UNCHANGED.
		const atDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			path: "/overlay-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(atDest?._id).toBe(seeded.nodeId);
		expect(atDest?.path).toBe("/overlay-src.md");

		// The vacated source reads as missing for the proposer.
		const atSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(atSource).toBeNull();

		// Without `overlayUserId` the committed lookup is unchanged (other users' view).
		const committedSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			path: "/overlay-src.md",
		});
		expect(committedSource?._id).toBe(seeded.nodeId);
		const committedDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			path: "/overlay-dest.md",
		});
		expect(committedDest).toBeNull();

		// Another user commits a rename of the source node and a newcomer file takes the old
		// path. The newcomer is untouched by the overlay, so it stays visible to the proposer.
		const newcomerNodeId = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, {
				path: "/overlay-moved-away.md",
				treePath: "/overlay-moved-away.md",
				name: "overlay-moved-away.md",
			});
			return await ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/overlay-src.md",
				treePath: "/overlay-src.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "overlay-src.md",
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
			});
		});
		const newcomer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(newcomer?._id).toBe(newcomerNodeId);
	});

	test("content reads at the claimed destination serve the moved file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-content-src.md",
				name: "overlay-content-src.md",
				markdown: "# Overlay content base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/overlay-content-src.md",
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
			destName: "overlay-content-dest.md",
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

		// Chunk reads translate the claimed destination to the moved file's content.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.nodeId).toBe(seeded.nodeId);
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read composes with the structural row: content resolves from the
		// committed tree and the row's id is still reported for mixing.
		const markdownState = await t.query(internal.files_nodes.get_file_markdown_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);

		// The vacated source path serves nothing for the proposer.
		const vacatedRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-src.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(vacatedRead).toBeNull();
	});
});

