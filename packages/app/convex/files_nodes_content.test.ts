import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, components, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import {
	r2_create_asset_key,
	r2_confirmed_object_delete,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_server_side_copy,
} from "./r2_client.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_YJS_DOC_KEYS,
} from "../shared/files.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { files_nodes_content_db_publish_private_node } from "./files_nodes_content.ts";
import { files_media_validation_db_capture_versions } from "./files_media_validation.ts";
import { files_pending_nodes_db_create, files_pending_nodes_db_discard } from "./files_pending_nodes.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { activities_db_require_by_source_id, activities_db_start } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import type { Doc, Id } from "./_generated/dataModel.js";

const objects = new Map<string, BodyInit>();

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_review" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	objects.clear();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

async function create_file_fixture(rootKind: "plain_text" | "rich_text" = "plain_text", text = "Original text\n") {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: rootKind === "rich_text" ? "/restore.md" : "/restore.txt",
		textContent: text,
	});
	const pointers = await test_get_file_yjs_pointers(t, nodeId);
	const snapshotId = await t.run(async (ctx) => {
		const snapshot = await ctx.db.query("files_snapshots").first();
		if (!snapshot) throw new Error("Missing created snapshot");
		return snapshot._id;
	});
	return { t, db, asUser, scope, nodeId, pointers, snapshotId };
}

async function create_private_text_fixture(collaborationEnabled: boolean) {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const text = "Saved from a private draft\n";
	const prepared = await t.run(async (ctx) => {
		const created = await files_pending_nodes_db_create(ctx, {
			...db,
			parent: { kind: "root" },
			name: "private.txt",
			kind: "file",
		});
		if (created._nay) throw new Error(created._nay.message);
		await ctx.db.patch("files_pending_updates", created._yay.pendingUpdateId, {
			createIntent: {
				kind: "text",
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled,
				metadata: [],
			},
		});
		const yjsDoc = new YjsDoc();
		yjsDoc.getText(files_YJS_DOC_KEYS.plainText).insert(0, text);
		const assetIds: Id<"files_r2_assets">[] = [];
		for (const kind of collaborationEnabled
			? (["content_snapshot", "yjs_snapshot"] as const)
			: (["content_snapshot"] as const)) {
			const body = kind === "content_snapshot" ? text : encodeStateAsUpdate(yjsDoc);
			const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
			const id = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				kind,
				r2Bucket: "test",
				size,
				unfinalizedExpiresAt: Date.now() + 60_000,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({ ...db, assetId: id });
			const held = await files_private_storage_db_reserve(ctx, {
				...db,
				resource: { kind: "asset", id, r2Key },
				byteCount: size,
			});
			if (held._nay) throw new Error(held._nay.message);
			objects.set(r2Key, typeof body === "string" ? body : files_u8_to_array_buffer(body));
			assetIds.push(id);
		}
		const membership = await ctx.db.get("organizations_workspaces_users", db.membershipId);
		const node = await ctx.db.get("files_pending_nodes", created._yay.privateNodeId);
		const pendingUpdate = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
		if (!membership || !node || !pendingUpdate) throw new Error("Expected private draft records");
		return {
			membership,
			node,
			pendingUpdate,
			billedUserId: db.userId,
			prepared: { text, contentAssetId: assetIds[0]!, yjsSnapshotAssetId: assetIds[1] },
		};
	});
	return { t, db, prepared };
}

async function create_transfer_copy_item(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	sourceId: Id<"files_nodes"> = fixture.nodeId,
) {
	const { t, db, asUser } = fixture;
	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "/copies",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	return await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceId);
		if (!source) throw new Error("Missing copy source");
		const now = Date.now();
		const membership = await ctx.db.get("organizations_workspaces_users", db.membershipId);
		if (!membership) throw new Error("Missing copy membership");
		const scope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			membershipId: db.membershipId,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
		};
		const runId = await ctx.db.insert("files_transfer_runs", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			sourceScope: scope,
			destinationScope: scope,
			requestId: "test-copy",
			requestHash: "test-copy",
			kind: "copy",
			sourceView: "saved",
			publication: "saved",
			origin: { kind: "clipboard" },
			targetParent: { kind: "saved", id: folder._yay.nodeId },
			targetPath: "/copies",
			targetName: null,
			missingParentNames: [],
			preparedParent: null,
			fixedDeadline: false,
			conflictPolicy: { file: "ask", folder: "ask" },
			step: "apply",
			planCursor: null,
			reserveCursor: null,
			retryOf: null,
			retryCursor: null,
			revision: 0,
			inFlight: 1,
			applyToRemaining: { file: null, folder: null },
		});
		await activities_db_start(ctx, {
			...db,
			membershipLifetime: scope.membershipLifetime,
			source: { kind: "files_transfer_run", id: runId, transferKind: "copy" },
			title: "Copy files",
			targets: [],
			visibility: "requester",
			feedVisible: true,
			status: "running",
			resultKind: "saved",
			progress: {
				unit: "files",
				discovered: 1,
				total: 1,
				completed: 0,
				skipped: 0,
				failed: 0,
				blocked: 0,
				canceled: 0,
			},
			deadlineAt: now + 30 * 60 * 1000,
			now,
		});
		const itemId = await ctx.db.insert("files_transfer_items", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			runId,
			source: { kind: "saved", id: sourceId },
			sourceParent: source.parentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: source.parentId },
			sourceName: source.name,
			targetName: source.name,
			plannedPath: null,
			sourcePath: source.path,
			kind: "file",
			parentItemId: null,
			order: 0,
			discoveryDone: true,
			discoveryCursor: null,
			state: "copying",
			conflictKind: null,
			choice: null,
			conflictTarget: null,
			conflictVersion: null,
			preparation: null,
			outcome: null,
			cancelReason: null,
			errorCode: null,
			billedUserId: null,
			attempt: 1,
			workId: "work_review" as never,
			attemptExpiresAt: now + 10 * 60 * 1000,
			stagedAssetIds: [],
			capture: null,
			outputTarget: null,
			outputName: null,
			outputPath: null,
			errorMessage: null,
		});
		return { itemId, runId, folderId: folder._yay.nodeId };
	});
}

async function create_sealed_transfer_capture(fixture: Awaited<ReturnType<typeof create_file_fixture>>) {
	const { t, scope } = fixture;
	const copy = await create_transfer_copy_item(fixture);
	const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
		itemId: copy.itemId,
		attempt: 1,
	});
	if (!prepared._yay?.capture || !prepared._yay.yjsSnapshotAsset) throw new Error("Missing copy source");
	const source = prepared._yay;
	const claim = { itemId: copy.itemId, attempt: 1, workId: source.workId };
	const staged = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
		...claim,
		contentSize: source.asset!.size,
		yjsSnapshotSize: source.yjsSnapshotAsset!.size,
	});
	if (!staged._yay?.yjsSnapshotAssetId) throw new Error("Missing copy assets");
	const assets = staged._yay;
	for (const [assetId, sourceKey] of [
		[assets.contentAssetId, source.asset!.r2Key!],
		[assets.yjsSnapshotAssetId!, source.yjsSnapshotAsset!.r2Key!],
	] as const) {
		objects.set(r2_create_asset_key({ ...scope, assetId }), objects.get(sourceKey)!);
	}
	expect(await t.mutation(internal.files_nodes_content.seal_transfer_file_capture, { ...claim, ...assets })).toEqual({
		_yay: null,
	});
	return { ...copy, claim, assets, source };
}

function saved_copy_id(item: Doc<"files_transfer_items"> | null) {
	if (item?.outputTarget?.kind !== "saved") throw new Error(item?.errorMessage ?? "Missing saved copy");
	return item.outputTarget.id;
}

async function start_agent_copy(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	source: Doc<"files_transfer_items">["source"] = { kind: "saved", id: fixture.nodeId },
	targetName = "copied.txt",
) {
	const { t, db } = fixture;
	const threadId = await t.run((ctx) =>
		ctx.db.insert("ai_chat_threads", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			clientGeneratedId: "copy-thread",
			title: "Copy draft",
			archived: false,
			runtime: "aisdk_5",
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		}),
	);
	const started = await t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: db.membershipId,
		threadId,
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		requestId: "agent-copy",
		kind: "copy",
		expectedSourceCount: 1,
		sources: [source],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName,
		missingParentNames: [],
		conflictPolicy: { file: "replace", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: db.membershipId,
			threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let step = 0; step < 12; step++) {
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const item = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.first(),
		);
		if (item?.workId) return { ...started._yay, item };
		if (item?.state === "failed") throw new Error(item.errorMessage!);
	}
	throw new Error("Copy did not start");
}

async function prepare_agent_replacement(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	sourceId: Id<"files_nodes">,
) {
	const destination = await fixture.t.run((ctx) => ctx.db.get("files_nodes", fixture.nodeId));
	const copy = await start_agent_copy(fixture, { kind: "saved", id: sourceId }, destination!.name);
	await fixture.t.action(internal.files_nodes_content.copy_transfer_file, {
		itemId: copy.item._id,
		attempt: copy.item.attempt,
	});
	const pending = await fixture.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", fixture.db.userId).eq("target.kind", "saved").eq("target.id", fixture.nodeId),
			)
			.first(),
	);
	if (!pending?.pendingReplacement) throw new Error("Copy did not create a replacement");
	return pending;
}

/**
 * Accept one proposal the way the sidebar does: a review run, not the direct action. The run's
 * commit counts every database read, so it refuses code paths the direct action accepts.
 */
async function accept_through_review_run(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	pendingUpdate: Doc<"files_pending_updates">,
) {
	const { t, db, asUser } = fixture;
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [
			{
				pendingUpdateId: pendingUpdate._id,
				reviewedRevision: pendingUpdate.revision,
				selectedContentStateId: pendingUpdate.pendingReplacement
					? null
					: (pendingUpdate.content?.unstagedStateId ?? null),
			},
		],
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	const sealed = await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId });
	if (sealed._nay) throw new Error(sealed._nay.message);
	await t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
	for (let pass = 0; pass < 20; pass++) {
		await t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await asUser.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId });
		const unit = await t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) throw new Error("Expected a review worker");
		await t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Review did not finish");
}

async function create_private_copy_source(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	text = "Private staged\n",
) {
	const { t, scope } = fixture;
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/draft.txt",
		kind: "file",
	});
	if (created._nay) throw new Error(created._nay.message);
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	if (target.kind !== "private" || !pendingUpdateId || !operationBatchId) throw new Error("Expected private draft");
	for (const [role, value] of [
		["staged", text],
		["unstaged", text + "Unstaged too\n"],
	] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId,
			role,
			text: value,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...scope,
		target,
		pendingUpdateId,
		operationBatchId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	return { target, pendingUpdateId, text: text + "Unstaged too\n" };
}

async function create_pending_proposal(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	userId = fixture.scope.userId,
	texts = {
		staged: "---\nreview: accepted\n---\n\nAccepted text\n",
		unstaged: "---\nreview: accepted\n---\n\nAccepted text\n\nProposed text\n",
	},
) {
	const { t, scope, nodeId } = fixture;
	const ownerScope = { ...scope, userId };
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		...ownerScope,
		target: { kind: "saved", id: nodeId },
	});
	if (batch._nay) throw new Error(batch._nay.message);
	for (const [role, text] of [
		["staged", texts.staged],
		["unstaged", texts.unstaged],
	] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...ownerScope,
			operationBatchId: batch._yay.operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const proposed = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...ownerScope,
		target: { kind: "saved", id: nodeId },
		operationBatchId: batch._yay.operationBatchId,
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	return await t.run(async (ctx) => {
		const pending = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.first();
		if (!pending) throw new Error("Missing pending proposal");
		return pending;
	});
}

async function expect_retired_uploads(t: ReturnType<typeof test_convex>, count: number) {
	await t.run(async (ctx) => {
		const assets = await ctx.db.query("files_r2_assets").collect();
		const publishedKeys = new Set(assets.map((asset) => asset.r2Key));
		const jobs = (await ctx.db.query("files_r2_object_deletion_jobs").collect()).filter(
			(job) => job.reason === "failed_create",
		);
		expect(jobs).toHaveLength(count);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			[...objects.keys()].filter((key) => !publishedKeys.has(key)).sort(),
		);
	});
}

describe("files_nodes_content_db_publish_private_node", () => {
	test.each([false, true])(
		"publishes complete text with collaboration %s and settles storage above the new cap",
		async (collaborationEnabled) => {
			const { t, prepared } = await create_private_text_fixture(collaborationEnabled);
			await t.run(async (ctx) => {
				for (const hold of await ctx.db.query("files_private_storage_reservations").collect()) {
					await ctx.db.patch("quotas", hold.userQuotaId, { maxCount: 0 });
					if (hold.workspaceQuotaId) await ctx.db.patch("quotas", hold.workspaceQuotaId, { maxCount: 0 });
				}
				expect(await ctx.db.query("files_nodes").collect()).toEqual([]);
			});
			const result = await t.run(async (ctx) => files_nodes_content_db_publish_private_node(ctx, prepared));
			if (result._nay) throw new Error(result._nay.message);
			await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", result._yay.target.id);
				expect(node).toMatchObject({
					path: "/private.txt",
					assetId: prepared.prepared.contentAssetId,
					textKind: "plain_text",
					collaborationEnabled,
				});
				const chunks = await ctx.db.query("files_text_chunks").collect();
				expect(chunks.map((chunk) => chunk.textChunk).join("")).toBe(prepared.prepared.text);
				expect(await ctx.db.query("files_snapshots").collect()).toMatchObject([
					{ fileNodeId: result._yay.target.id, assetId: prepared.prepared.contentAssetId },
				]);
				expect(await ctx.db.query("files_pending_node_publish_receipts").collect()).toMatchObject([
					{
						privateNodeId: prepared.node._id,
						savedNodeId: result._yay.target.id,
						proposalRevision: prepared.pendingUpdate.revision,
					},
				]);
				expect(await ctx.db.get("files_pending_nodes", prepared.node._id)).toMatchObject({
					state: "published",
					creationGeneration: 2,
				});
				const holds = await ctx.db.query("files_private_storage_reservations").collect();
				expect(holds.every((hold) => hold.settlement.kind === "saved")).toBe(true);
				for (const hold of holds) {
					expect(await ctx.db.get("quotas", hold.userQuotaId)).toMatchObject({ usedCount: 0 });
				}
				if (collaborationEnabled) {
					expect(result._yay.base).toEqual({ kind: "yjs", sequence: 0, lineageGeneration: 0 });
					expect(await ctx.db.get("files_yjs_docs_last_sequences", node!.yjsLastSequenceId!)).toMatchObject({
						lastSequence: 0,
						lineageGeneration: 0,
					});
				} else {
					expect(result._yay.base).toEqual({ kind: "asset", assetId: prepared.prepared.contentAssetId });
					expect(await ctx.db.query("files_yjs_snapshots").collect()).toEqual([]);
				}
			});
		},
	);

	test("refuses a saved name collision without publishing assets or settling the draft", async () => {
		const { t, db, prepared } = await create_private_text_fixture(false);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const occupant = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "/private.txt",
		});
		expect(occupant._nay).toBeUndefined();
		const result = await t.run(async (ctx) => files_nodes_content_db_publish_private_node(ctx, prepared));
		expect(result._nay).toBeDefined();
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_nodes").collect()).toHaveLength(1);
			expect(await ctx.db.query("files_snapshots").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_node_publish_receipts").collect()).toEqual([]);
			expect(await ctx.db.get("files_pending_nodes", prepared.node._id)).toMatchObject({
				state: "active",
				creationGeneration: 1,
			});
			expect(
				(await ctx.db.query("files_private_storage_reservations").collect()).every(
					(hold) => hold.settlement.kind === "held",
				),
			).toBe(true);
		});
	});

	test("refuses retired prepared assets before creating any saved data", async () => {
		const { t, prepared } = await create_private_text_fixture(false);
		await t.run(async (ctx) =>
			ctx.db.patch("files_r2_assets", prepared.prepared.contentAssetId, { uploadRetiredAt: Date.now() }),
		);
		const result = await t.run(async (ctx) => files_nodes_content_db_publish_private_node(ctx, prepared));
		expect(result._nay?.name).toBe("target_changed");
		expect(await t.run(async (ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
	});
});

describe("private text publication", () => {
	test.each(["html", "htm"])("keeps %s source through saves, collaboration changes, and restore", async (extension) => {
		vi.useFakeTimers();
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const text = "<!doctype html>\n<html><head><title>Brief</title></head><body><p>Original</p></body></html>\n";
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: `/brief.${extension}`,
			textContent: text,
		});
		const snapshot = await t.run((ctx) => ctx.db.query("files_snapshots").first());
		if (!snapshot) throw new Error("Missing HTML snapshot");
		expect(snapshot).toMatchObject({ contentType: "text/html;charset=utf-8", yjsRootKind: "plain_text" });
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: text.replace("Original", "Saved"),
		});
		expect(saved._nay).toBeUndefined();
		expect(
			await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toEqual({ _yay: { text: text.replace("Original", "Saved"), textKind: "plain_text" } });
		for (const task of await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect())) {
			await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		}
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: snapshot._id,
			sessionId: "restore-html",
		});
		expect(restored._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			contentType: "text/html;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
		});
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: `/brief.${extension}`,
		});
		expect(read?.content).toBe(text);
	});
});

describe("copy_transfer_file", () => {
	test.each(["saved", "private"] as const)(
		"creates a private copy from a %s draft with unstaged edits",
		async (kind) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, scope } = fixture;
			const source = kind === "private" ? await create_private_copy_source(fixture) : null;
			if (!source) await create_pending_proposal(fixture);
			const copy = await start_agent_copy(fixture, source?.target);
			expect(copy.item.preparation).not.toBeNull();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
			const sourceBefore = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id));
			expect(item?.errorMessage).toBeNull();
			expect(item?.state).toBe("completed");
			expect(item?.outputTarget).toEqual({ kind: "private", id: copy.item.preparation!.privateNodeId });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...scope,
				path: "/copied.txt",
				overlayUserId: db.userId,
			});
			expect(read?.content).toBe(source?.text ?? "---\nreview: accepted\n---\n\nAccepted text\n\nProposed text\n");
			for (const pending of sourceBefore.filter((doc) => doc._id !== copy.item.preparation!.pendingUpdateId)) {
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
			}
			const proposal = await t.run((ctx) =>
				ctx.db.get("files_pending_updates", copy.item.preparation!.pendingUpdateId),
			);
			expect(proposal).toMatchObject({
				revision: 2,
				createIntent: { kind: "text" },
				content: { base: { kind: "new" } },
			});
			expect(proposal?.preparation).toBeUndefined();
		},
	);

	test("rebases a read-only source into the capture without changing its draft", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("plain_text", "Saved line\nDraft line\n");
		const { t, db, asUser, scope, nodeId, pointers } = fixture;
		const pending = await create_pending_proposal(fixture, db.userId, {
			staged: "Saved line\nStaged line\n",
			unstaged: "Saved line\nStaged line\nUnstaged line\n",
		});
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const document = new YjsDoc();
		applyUpdate(document, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const before = encodeStateVector(document);
		document.getText(files_YJS_DOC_KEYS.plainText).insert(0, "New saved line\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(document, before)),
					sessionId: "new-saved-line",
				})
			)._nay,
		).toBeUndefined();
		document.destroy();
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const copy = await start_agent_copy(fixture);
		await t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "completed",
			errorMessage: null,
		});
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copied.txt",
					overlayUserId: db.userId,
				})
			)?.content,
		).toBe("New saved line\nSaved line\nStaged line\nUnstaged line\n");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("discarding a preparing copy fences its late worker", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await start_agent_copy(fixture);
		const preparation = copy.item.preparation!;
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_pending_nodes", preparation.privateNodeId);
			if (!node) throw new Error("Missing preparation");
			expect(
				await files_pending_nodes_db_discard(ctx, {
					...fixture.scope,
					privateNodeId: node._id,
					pendingUpdateId: preparation.pendingUpdateId,
					expectedRevision: preparation.proposalRevision,
				}),
			).toEqual({ _yay: null });
		});
		await t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "canceled",
			outputTarget: null,
			cancelReason: "proposal_discard",
		});
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", preparation.privateNodeId))).toMatchObject({
			state: "discarded",
		});
	});

	test.each([
		{ rootKind: "plain_text", collaborative: true },
		{ rootKind: "plain_text", collaborative: false },
		{ rootKind: "rich_text", collaborative: true },
		{ rootKind: "rich_text", collaborative: false },
	] as const)("copies saved content and metadata with %j", async ({ rootKind, collaborative }) => {
		vi.useFakeTimers();
		const sourceText =
			rootKind === "rich_text"
				? '---\nproject: copied\n---\n\nKeep **bold** and <span data-type="comment" data-lb-thread-id="old-thread">these words</span>.\n'
				: '  exact text\n\tspaces, Unicode: 😀\n<span data-type="comment" data-lb-thread-id="literal">plain code</span>';
		const fixture = await create_file_fixture(rootKind, sourceText);
		const { t, db, asUser, scope, nodeId } = fixture;
		if (!collaborative) {
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: db.membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
		}
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: Ray\nchecked: true\ncount: 4",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const meterBefore = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		const copy = await create_transfer_copy_item(fixture);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item?.errorMessage).toBeNull();
		expect(item?.state).toBe("completed");
		const copiedId = saved_copy_id(item);
		const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
		expect(copied).toMatchObject({
			contentType: before?.contentType,
			textKind: rootKind,
			collaborationEnabled: collaborative,
			writePolicy: null,
		});
		expect(copied?.assetId).not.toBe(before?.assetId);
		expect(copied?.yjsLastSequenceId === null).toBe(!collaborative);
		if (collaborative) expect(copied?.yjsLastSequenceId).not.toBe(before?.yjsLastSequenceId);
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: item!.outputPath!,
		});
		if (rootKind === "plain_text") {
			expect(read?.content).toBe(sourceText);
		} else {
			expect(read?.content).toContain("Keep **bold** and these words.");
			expect(read?.content).not.toContain("old-thread");
			expect(read?.content).not.toContain('data-type="comment"');
		}
		await t.run(async (ctx) => {
			const metadata = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", copiedId),
				)
				.collect();
			expect(metadata.filter((entry) => entry.docKind === "value").map((entry) => entry.fieldPath)).toEqual(
				expect.arrayContaining(["metadata.owner", "metadata.checked", "metadata.count"]),
			);
			if (rootKind === "rich_text") expect(metadata.map((entry) => entry.fieldPath)).toContain("frontmatter.project");
			expect(
				await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", copiedId),
					)
					.collect(),
			).toHaveLength(1);
			expect(
				await ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", copiedId))
					.collect(),
			).toHaveLength(0);
		});
		// A lost action response can be retried without another node, version, or charge.
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const meterAfter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		expect(meterAfter?.meter?.consumedUnits).toBe((meterBefore?.meter?.consumedUnits ?? 0) + 1);
		expect((await t.run((ctx) => activities_db_require_by_source_id(ctx, copy.runId))).progress?.completed).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("copies a read-only source into an independent document that stays locked", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		const copiedId = saved_copy_id(item);
		const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
		// A copy keeps the source file's own rule. The destination default does not unlock it.
		expect(copied?.writePolicy).toEqual({ mode: "read_only" });
		const pointers = await test_get_file_yjs_pointers(t, copiedId);
		const snapshotKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(snapshotKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert("Original text\n".length, "Copy edit\n");
		const refused = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId: copiedId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
			sessionId: "clipboard-destination",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedId,
					writePolicy: null,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId: copiedId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "clipboard-destination",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copies/restore.txt",
				})
			)?.content,
		).toBe("Original text\nCopy edit\n");
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/restore.txt",
				})
			)?.content,
		).toBe("Original text\n");
	});

	test("pins saved Yjs edits and leaves later edits and pending proposals behind", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId, pointers } = fixture;
		await create_pending_proposal(fixture);
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert("Original text\n".length, "Saved latest edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "clipboard-source",
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, { itemId: copy.itemId, attempt: 1 });
		const beforeLaterEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "Later edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeLaterEdit)),
					sessionId: "later-source-edit",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/copies/restore.txt",
		});
		expect(read?.content).toBe("Original text\nSaved latest edit\n");
	});

	test.each(["application/pdf", "image/png", "video/mp4", "text/html;charset=utf-8"])(
		"copies stored %s bytes without conversion or shared assets",
		async (contentType) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const bytes = new Uint8Array([0, 255, 13, 10, 128, 70]);
			const source = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename: "stored.html",
				contentType,
				size: bytes.byteLength,
			});
			if (source._nay) throw new Error(source._nay.message);
			const sourceKey = "test/clipboard-stored";
			objects.set(sourceKey, bytes);
			await t.run((ctx) => ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: sourceKey }));
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				objects.set(args.destinationKey, bytes);
				return { outcome: "copied", size: bytes.byteLength, etag: "copied" };
			});
			const copy = await create_transfer_copy_item(fixture, source._yay.nodeId);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			const copiedId = saved_copy_id(item);
			const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
			expect(copied).toMatchObject({ contentType, textKind: null, collaborationEnabled: null, yjsSnapshotId: null });
			expect(copied?.assetId).not.toBe(source._yay.assetId);
			await t.run((ctx) =>
				files_nodes_db_hard_delete_node(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId: source._yay.nodeId,
				}),
			);
			const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", copied!.assetId!));
			expect(asset?.r2Key).not.toBe(sourceKey);
			expect(new Uint8Array(await new Response(objects.get(asset!.r2Key!)).arrayBuffer())).toEqual(bytes);
			expect(await t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(0);
		},
	);

	test.each(["stop", "permission"])(
		"refuses publication after %s during upload and cleans staged assets",
		async (change) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const copy = await create_transfer_copy_item(fixture);
			const savedFetch = globalThis.fetch;
			let changed = false;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					const response = await savedFetch(input, init);
					if (init?.method === "PUT" && !changed) {
						changed = true;
						if (change === "stop") {
							await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: copy.runId });
						} else {
							await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
						}
					}
					return response;
				}),
			);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			expect(item?.outputTarget).toBeNull();
			expect(item?.stagedAssetIds).toEqual([]);
			await expect_retired_uploads(t, 2);
			await t.run(async (ctx) => {
				const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
				for (const job of jobs) expect(job.putMayArriveUntil).toBeGreaterThan(Date.now());
			});
		},
	);

	test("releases failed writes and lets a later attempt use fresh assets", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT") throw new Error("Storage failed after receiving bytes");
				return response;
			}),
		);
		await expect(
			t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 }),
		).rejects.toThrow("Storage failed");
		await expect_retired_uploads(t, 2);
		vi.stubGlobal("fetch", savedFetch);
		await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
	});

	test("keeps the first source bytes and metadata after a failed attempt", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: first",
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT") throw new Error("Storage failed after receiving bytes");
				return response;
			}),
		);
		await expect(
			t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.itemId,
				attempt: 1,
			}),
		).rejects.toThrow("Storage failed");
		vi.stubGlobal("fetch", savedFetch);
		expect(
			(
				await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Newer source text\n",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: newer",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: "work_review" as never,
			context: { itemId: copy.itemId, attempt: 1 },
			result: { kind: "failed", error: "Storage failed" },
		});
		await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item?.state).toBe("completed");
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/copies/restore.txt",
		});
		expect(read?.content).toBe("Original text\n");
		const metadata = await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId,
			fileNodeId: saved_copy_id(item),
		});
		expect(metadata).toEqual([{ key: "owner", value: "first" }]);
	});

	test("reuses sealed assets after a failed attempt and keeps them when history is deleted", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, scope } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		const captured = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(captured?.stagedAssetIds).toEqual([]);
		expect(captured?.capture?.artifact?.contentAssetId).toBe(copy.assets.contentAssetId);
		objects.delete(copy.source.asset!.r2Key!);
		objects.delete(copy.source.yjsSnapshotAsset!.r2Key!);
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: copy.claim.workId,
			context: { itemId: copy.itemId, attempt: 1 },
			result: { kind: "failed", error: "Lost seal response" },
		});
		await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		const beforeMeter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		const laterStorage = vi.mocked(globalThis.fetch).mock.calls.slice(storageCalls);
		expect(laterStorage).toHaveLength(1);
		expect(laterStorage[0]![1]?.method).not.toBe("PUT");
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item).toMatchObject({ state: "completed", capture: { artifact: null }, stagedAssetIds: [] });
		const output = await t.run((ctx) => ctx.db.get("files_nodes", saved_copy_id(item)));
		expect(output?.assetId).toBe(copy.assets.contentAssetId);
		const pointers = await test_get_file_yjs_pointers(t, saved_copy_id(item));
		expect((await t.run((ctx) => ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId)))?.assetId).toBe(
			copy.assets.yjsSnapshotAssetId,
		);
		const afterMeter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		expect(afterMeter?.meter?.consumedUnits).toBe((beforeMeter?.meter?.consumedUnits ?? 0) + 1);
		await t.mutation(internal.files_transfer.delete_run_batch, { runId: copy.runId });
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.yjsSnapshotAssetId!))).not.toBeNull();
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copies/restore.txt",
				})
			)?.content,
		).toBe("Original text\n");
	});

	test.each(["stop", "skip", "mode change", "credit loss"])("releases a sealed capture after %s", async (change) => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		if (change === "stop") {
			await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: copy.runId });
		} else if (change === "skip") {
			await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: copy.folderId,
				path: "restore.txt",
			});
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.capture?.artifact).not.toBeNull();
			const run = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: copy.runId });
			await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId: copy.runId,
				revision: run!.revision,
				choices: [{ itemId: copy.itemId, choice: "skip" }],
				applyToRemaining: { file: null, folder: null },
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: copy.claim.workId,
				context: { itemId: copy.itemId, attempt: 1 },
				result: { kind: "success", returnValue: null },
			});
			await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		} else if (change === "mode change") {
			await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
		} else {
			await t.run(async (ctx) => {
				await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
				const usage = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first();
				await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
			});
		}
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			outputTarget: null,
			stagedAssetIds: [],
			capture: { artifact: null },
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.yjsSnapshotAssetId!))).toBeNull();
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		for (const assetId of [copy.assets.contentAssetId, copy.assets.yjsSnapshotAssetId!]) {
			const job = jobs.find((job) => job.r2Key === r2_create_asset_key({ ...fixture.scope, assetId }));
			expect(job?.putMayArriveUntil).toBeGreaterThan(Date.now());
		}
	});

	test("refuses an old work claim without releasing the current sealed capture", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		const before = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		const oldClaim = { ...copy.claim, workId: "old_work" as never };
		expect(
			await t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...oldClaim,
				...copy.assets,
				text: "Wrong claim",
			}),
		).toEqual({ _yay: null });
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, {
			...oldClaim,
			message: "Old worker failed",
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toEqual(before);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).not.toBeNull();
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
	});

	test("fails when the pinned source bytes disappear before sealing", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.itemId,
			attempt: 1,
		});
		if (!prepared._yay?.asset) throw new Error("Missing captured source");
		objects.delete(prepared._yay.asset.r2Key!);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "failed",
			errorMessage: "The captured source content is no longer available",
			outputTarget: null,
			stagedAssetIds: [],
		});
	});

	test.each(["source asset", "source snapshot", "sealed content"])(
		"fails in the source read transaction when the %s is gone",
		async (missing) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t } = fixture;
			const copy =
				missing === "sealed content"
					? await create_sealed_transfer_capture(fixture)
					: await create_transfer_copy_item(fixture);
			const args = { itemId: copy.itemId, attempt: 1 };
			const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, args);
			if (!prepared._yay) throw new Error("Missing captured source");
			const source = prepared._yay;
			const missingAssetId = missing === "source snapshot" ? source.yjsSnapshotAsset!._id : source.asset!._id;
			await t.run((ctx) => ctx.db.delete("files_r2_assets", missingAssetId));

			expect(await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, args)).toEqual({
				_nay: { message: "The captured source content is no longer available" },
			});
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
				state: "failed",
				errorMessage: "The captured source content is no longer available",
				outputTarget: null,
				stagedAssetIds: [],
				capture: { artifact: null },
			});
			expect(
				await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
					...args,
					workId: source.workId,
					contentSize: source.asset!.size,
				}),
			).toEqual({ _yay: null });
			if (source.capture.artifact?.yjsSnapshotAssetId) {
				expect(
					await t.run((ctx) => ctx.db.get("files_r2_assets", source.capture.artifact!.yjsSnapshotAssetId!)),
				).toBeNull();
			}
		},
	);

	test.each(["after preflight", "during upload", "between retries"])(
		"keeps the original payer when ownership changes %s",
		async (change) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const newOwnerId = await t.run(async (ctx) => {
				const newOwner = await test_mocks_fill_db_with.membership(ctx, {
					organizationName: "personal",
					workspaceName: "home",
				});
				const organization = await ctx.db.get("organizations", db.organizationId);
				if (!organization?.defaultWorkspaceId) throw new Error("Missing default workspace");
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					userId: newOwner.userId,
					active: true,
					updatedAt: Date.now(),
				});
				await ctx.db.patch("organizations", db.organizationId, { billingMode: "organization_owner" });
				return newOwner.userId;
			});
			const copy = await create_transfer_copy_item(fixture);
			const meterBefore = await t.run((ctx) =>
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first(),
			);
			const transfer = async () => {
				const result = await asUser.mutation(api.access_control.transfer_organization_ownership, {
					organizationId: db.organizationId,
					newOwnerUserId: newOwnerId,
				});
				expect(result._nay).toBeUndefined();
			};
			const savedFetch = globalThis.fetch;
			let uploaded = false;
			if (change === "after preflight") {
				const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
					itemId: copy.itemId,
					attempt: 1,
				});
				expect(prepared._yay).toBeTruthy();
				await transfer();
			} else {
				vi.stubGlobal(
					"fetch",
					vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
						const response = await savedFetch(input, init);
						if (init?.method === "PUT") {
							if (change === "between retries") throw new Error("Storage failed after receiving bytes");
							if (!uploaded) {
								uploaded = true;
								await transfer();
							}
						}
						return response;
					}),
				);
			}
			if (change === "between retries") {
				await expect(
					t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 }),
				).rejects.toThrow("Storage failed");
				await transfer();
				vi.stubGlobal("fetch", savedFetch);
				await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
			}
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.itemId,
				attempt: change === "between retries" ? 2 : 1,
			});
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
				state: "completed",
				billedUserId: db.userId,
			});
			await t.run(async (ctx) => {
				const oldOwnerMeter = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first();
				const newOwnerMeter = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", newOwnerId))
					.first();
				expect(oldOwnerMeter?.meter?.consumedUnits).toBe((meterBefore?.meter?.consumedUnits ?? 0) + 1);
				expect(newOwnerMeter?.meter?.consumedUnits).toBe(0);
			});
		},
	);

	test("pauses on a name conflict created during upload", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		let occupied = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT" && !occupied) {
					occupied = true;
					const created = await asUser.mutation(api.files_nodes.create_folder_node, {
						membershipId: db.membershipId,
						parentId: copy.folderId,
						path: "restore.txt",
					});
					expect(created._nay).toBeUndefined();
				}
				return response;
			}),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "conflict",
			conflictKind: "name_conflict",
			outputTarget: null,
			stagedAssetIds: [],
		});
		expect((await t.run((ctx) => activities_db_require_by_source_id(ctx, copy.runId))).status).toBe("awaiting_input");
		await expect_retired_uploads(t, 2);
	});

	test("keeps a late-started worker's cleanup hold until its upload can finish", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await start_agent_copy(fixture);
		const attemptExpiresAt = copy.item.attemptExpiresAt!;
		vi.setSystemTime(attemptExpiresAt - 60_000);
		const uploadStarted = Promise.withResolvers<void>();
		const releaseUploads = Promise.withResolvers<void>();
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT") {
					uploadStarted.resolve();
					await releaseUploads.promise;
				}
				return await savedFetch(input, init);
			}),
		);
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
			objects.delete(key);
		});
		const worker = t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await uploadStarted.promise;
		const stagedItem = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id));
		const assetId = stagedItem!.stagedAssetIds[0]!;
		const r2Key = r2_create_asset_key({ ...fixture.scope, assetId });
		vi.setSystemTime(attemptExpiresAt + 1);
		await t.mutation(internal.files_transfer.recover_expired_attempts, {});
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
				.unique(),
		);
		if (!job?.privateStorageReservationId) throw new Error("Expected an owned deletion job");

		// The worker started one minute before expiry. This PUT still fits its ten-minute runtime.
		vi.setSystemTime(attemptExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS + 1);
		await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		vi.setSystemTime(attemptExpiresAt + 6 * 60_000);
		releaseUploads.resolve();
		await worker;
		expect(objects.has(r2Key)).toBe(true);
		const afterLateUpload = await t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id));
		expect(afterLateUpload).not.toBeNull();
		expect(
			(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job.privateStorageReservationId!)))
				?.settlement.kind,
		).toBe("held");
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id)))?.outputTarget).toBeNull();

		vi.setSystemTime(afterLateUpload!.putMayArriveUntil! + 1);
		await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		expect(objects.has(r2Key)).toBe(false);
		expect(
			(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job.privateStorageReservationId!)))
				?.settlement.kind,
		).toBe("deleted");
	});

	test("keeps current staging when an old or duplicate attempt arrives", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, { itemId: copy.itemId, attempt: 1 });
		const first = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: copy.itemId,
			attempt: 1,
			workId: "work_review" as never,
			contentSize: 14,
			yjsSnapshotSize: 24,
		});
		expect(first._yay).not.toBeNull();
		expect(
			await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
				itemId: copy.itemId,
				attempt: 1,
				workId: "work_review" as never,
				contentSize: 14,
				yjsSnapshotSize: 24,
			}),
		).toEqual({ _yay: null });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.stagedAssetIds).toHaveLength(2);
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, { itemId: copy.itemId, attempt: 1 });
		await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
		const second = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: copy.itemId,
			attempt: 2,
			workId: "work_review" as never,
			contentSize: 14,
			yjsSnapshotSize: 24,
		});
		if (!second._yay) throw new Error("Missing fresh staging");
		expect(second._yay.contentAssetId).not.toBe(first._yay?.contentAssetId);
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", second._yay!.contentAssetId))).not.toBeNull();
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.stagedAssetIds).toEqual([
			second._yay.contentAssetId,
			second._yay.yjsSnapshotAssetId,
		]);
	});

	test.each(["allocation", "source read"])(
		"keeps the winning worker's staging when a duplicate fails at %s",
		async (failure) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t } = fixture;
			const copy = await create_transfer_copy_item(fixture);
			const firstRead = Promise.withResolvers<void>();
			const secondRead = Promise.withResolvers<void>();
			const releaseFirstRead = Promise.withResolvers<void>();
			const releaseSecondRead = Promise.withResolvers<void>();
			const uploadStarted = Promise.withResolvers<void>();
			const releaseUploads = Promise.withResolvers<void>();
			const savedFetch = globalThis.fetch;
			let reads = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					if (init?.method === "PUT") {
						uploadStarted.resolve();
						await releaseUploads.promise;
					} else {
						reads += 1;
						if (reads === 1) {
							firstRead.resolve();
							await releaseFirstRead.promise;
						} else if (reads === 2) {
							secondRead.resolve();
							await releaseSecondRead.promise;
							if (failure === "source read") return new Response(null, { status: 404 });
						}
					}
					return await savedFetch(input, init);
				}),
			);
			const first = t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			await firstRead.promise;
			const duplicate = t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			await secondRead.promise;
			releaseFirstRead.resolve();
			await uploadStarted.promise;
			releaseSecondRead.resolve();
			await duplicate;
			const duringUpload = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			releaseUploads.resolve();
			await first;
			expect(duringUpload?.stagedAssetIds).toHaveLength(2);
			expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
		},
	);

	test("rechecks the credit gate after storage finishes", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		let changed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT" && !changed) {
					changed = true;
					await t.run(async (ctx) => {
						await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
						const usage = await ctx.db
							.query("billing_usage_snapshots")
							.withIndex("by_user", (q) => q.eq("userId", db.userId))
							.first();
						await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
					});
				}
				return response;
			}),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "failed",
			errorMessage: "Insufficient funds",
			outputTarget: null,
			stagedAssetIds: [],
		});
		await expect_retired_uploads(t, 2);
	});

	test("requires a paid plan for stored bytes even with free credits", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		const source = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "stored.pdf",
			contentType: "application/pdf",
			size: 3,
		});
		if (source._nay) throw new Error(source._nay.message);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: "test/paid-copy" });
			await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
		});
		const copy = await create_transfer_copy_item(fixture, source._yay.nodeId);
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(storageCalls);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.errorMessage).toBe(
			"This workspace's plan does not include file uploads",
		);
	});

	test("checks credits before reading or writing storage", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
			const usage = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first();
			await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
		});
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(storageCalls);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.errorMessage).toBe(
			"Insufficient funds",
		);
	});
});

describe("snapshot content fields", () => {
	test.each(["plain_text", "rich_text"] as const)(
		"records each saved %s mode without changing older versions",
		async (rootKind) => {
			vi.useFakeTimers();
			const { t, db, asUser, scope, nodeId } = await create_file_fixture(rootKind);
			const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(materialized._nay).toBeUndefined();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Saved with collaboration off\n",
			});
			expect(saved._nay).toBeUndefined();

			const tasks = await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect());
			for (const task of tasks) {
				await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
			}
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();

			const snapshots = await t.run((ctx) => ctx.db.query("files_snapshots").collect());
			expect(snapshots.map((snapshot) => snapshot.collaborationEnabled)).toEqual([true, true, false, true]);
			for (const snapshot of snapshots) {
				expect(snapshot).toMatchObject({
					contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: rootKind,
				});
				expect(snapshot).not.toHaveProperty("nonCollaborative");
			}
		},
	);
});

describe("cleanup_file_yjs_task", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	test("bounded cleanup retires before new history and a late task cannot delete the next OFF history", async () => {
		const { t, db, asUser, nodeId, pointers } = await create_file_fixture();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_yjs_snapshots", pointers.yjsSnapshotId, { sequence: 64 });
			await ctx.db.patch("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId, { lastSequence: 64 });
			await Promise.all(
				Array.from({ length: 64 }, (_, index) =>
					ctx.db.insert("files_yjs_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: nodeId,
						sequence: index + 1,
						update: new Uint8Array([0, 0]).buffer,
						origin: { type: "USER_EDIT", sessionId: "old-history" },
						createdBy: db.userId,
						createdAt: Date.now(),
					}),
				),
			);
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const task = await t.run(async (ctx) => ctx.db.query("files_yjs_cleanup_tasks").first());
		if (!task) throw new Error("Missing cleanup task");
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(true);

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(32);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay?.message,
		).toContain("old collaboration history");
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(0);
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(false);

		// The final full batch leaves the task pending. ON retires it without waiting for R2.
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(true);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(false);
		const fresh = await test_get_file_yjs_pointers(t, nodeId);
		const editor = new YjsDoc();
		editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "New edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor)),
					sessionId: "new-history",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		await t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
			sequence: 1,
			targetSequence: 1,
			byteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();

		// Both documents are now off. Only the retired task flag protects the newer update.
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		await t.run(async (ctx) => {
			expect((await ctx.db.query("files_yjs_updates").collect()).map((update) => update.sequence)).toEqual([1]);
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task._id)).toBeNull();
			const deletion = await ctx.db.query("files_r2_object_deletion_jobs").first();
			expect(deletion?.putMayArriveUntil).toBe(task.putMayArriveUntil);
		});
	});

	test("the final ON mutation refuses remaining old history", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.assetId) throw new Error("Missing content asset");
			return { ...node, assetId: node.assetId };
		});
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all(
			(["yjs_snapshot", "content_snapshot"] as const).map((kind) =>
				t.mutation(internal.r2.insert_asset, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					kind,
					size: 14,
				}),
			),
		);
		const finalized = await asUser.mutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: db.membershipId,
			nodeId,
			text: "Original text\n",
			textSize: 14,
			baseAssetId: before.assetId,
			yjsSnapshotAssetId,
			yjsSnapshotSize: 14,
			contentSnapshotAssetId,
		});
		expect(finalized._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("restore checks old history before creating a fresh text document", async () => {
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const storedVersionId = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_snapshots", snapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			return await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				assetId: snapshot.assetId,
				createdBy: db.userId,
				archivedAt: 0,
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			});
		});
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey);
			if (body === undefined) throw new Error("Missing source object");
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
		});
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: storedVersionId,
					sessionId: "restore-stored",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			return await ctx.db.get("files_nodes", nodeId);
		});
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-text",
		});
		expect(restored._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("two ON finalizations publish only one document", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const results = await Promise.all(
			[0, 1].map(() =>
				asUser.action(api.files_nodes_content.set_file_collaborative, { membershipId: db.membershipId, nodeId }),
			),
		);
		expect(results.filter((result) => result._nay === undefined)).toHaveLength(1);
		expect(results.find((result) => result._nay)?._nay?.message).toContain("already collaborative");
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_yjs_snapshots").collect()).toHaveLength(1);
			expect(await ctx.db.query("files_yjs_docs_last_sequences").collect()).toHaveLength(1);
		});
	});

	test("asset-only cleanup preserves an asset referenced by a live snapshot", async () => {
		const { t, db, nodeId, pointers } = await create_file_fixture();
		const task = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				throughSequence: 0,
				supersededYjsAssetId: snapshot.assetId,
				putMayArriveUntil: null,
				historyPending: false,
			});
			return { taskId, assetId: snapshot.assetId };
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task.taskId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task.taskId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", task.assetId)).not.toBeNull();
			expect(await ctx.db.query("files_r2_object_deletion_jobs").collect()).toHaveLength(0);
		});
	});
});

describe("materialize_file_content and restore_snapshot_r2", () => {
	test.each([false, true])(
		"overlapping downloads and restore keep the latest edit (restore changes text: %s)",
		async (changesText) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const originalText = "Original text\n";
			const editedText = "Original text\nEdit during restore\nSecond edit\n";
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: "/review-restore.txt",
				textContent: originalText,
			});
			const pointers = await test_get_file_yjs_pointers(t, nodeId);
			const before = await t.run(async (ctx) => {
				const snapshot = await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.first();
				const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				if (!snapshot || !yjsSnapshot) throw new Error("Missing created snapshots");
				const asset = await ctx.db.get("files_r2_assets", yjsSnapshot.assetId);
				if (!asset?.r2Key) throw new Error("Missing created Yjs object");
				return { snapshotId: snapshot._id, yjsKey: asset.r2Key };
			});

			// Use the live document's structs, as an open editor does.
			const editor = new YjsDoc();
			const originalYjs = objects.get(before.yjsKey);
			if (!originalYjs) throw new Error("Missing Yjs bytes");
			applyUpdate(editor, new Uint8Array(await new Response(originalYjs).arrayBuffer()));
			if (changesText) {
				const beforeEdit = encodeStateVector(editor);
				editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "Remove this line\n");
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "before-restore",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				const materialized = await asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				if (materialized._nay) throw new Error(materialized._nay.message);
				await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_yjs_push_update", key: db.userId });
			}
			const expectedText = (changesText ? "Remove this line\n" : "") + editedText;
			const stateVector = encodeStateVector(editor);
			const text = editor.getText(files_YJS_DOC_KEYS.plainText);
			text.insert(text.length, "Edit during restore\n");
			const edit = files_u8_to_array_buffer(encodeStateAsUpdate(editor, stateVector));

			// Pause the restore's two PUTs after its read and diff are finished.
			const uploadsStarted = Promise.withResolvers<void>();
			const releaseUploads = Promise.withResolvers<void>();
			const oldYjsPutStarted = Promise.withResolvers<void>();
			const releaseOldYjsPut = Promise.withResolvers<void>();
			const fetchMock = vi.mocked(globalThis.fetch);
			const baseFetch = fetchMock.getMockImplementation();
			if (!baseFetch) throw new Error("Missing R2 stub");
			let pausedUploads = 0;
			let pausedYjsPut = false;
			fetchMock.mockImplementation(async (input, init) => {
				if (init?.method === "PUT" && typeof init.body === "string" && pausedUploads < 2) {
					pausedUploads += 1;
					if (pausedUploads === 2) uploadsStarted.resolve();
					await releaseUploads.promise;
				}
				if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !pausedYjsPut) {
					pausedYjsPut = true;
					oldYjsPutStarted.resolve();
					await releaseOldYjsPut.promise;
				}
				return await baseFetch(input, init);
			});

			const restoring = asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: before.snapshotId,
				sessionId: "review-restore",
			});
			await uploadsStarted.promise;
			try {
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: edit,
					sessionId: "review-other-editor",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				// Downloads call the materializer outside its single-worker pool.
				const firstDownload = asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				await oldYjsPutStarted.promise;
				try {
					const nextVector = encodeStateVector(editor);
					text.insert(text.length, "Second edit\n");
					const secondPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: db.membershipId,
						nodeId,
						expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
						update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, nextVector)),
						sessionId: "review-other-editor",
					});
					if (secondPush._nay) throw new Error(secondPush._nay.message);
					const secondDownload = await asUser.action(api.r2.create_signed_download_url, {
						membershipId: db.membershipId,
						fileNodeId: nodeId,
					});
					if (secondDownload._nay) throw new Error(secondDownload._nay.message);
					const savedKey = await t.run(async (ctx) => {
						const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
						return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
					});
					const savedYjs = objects.get(savedKey);
					if (!savedYjs) throw new Error("Missing saved Yjs bytes");
					const savedDoc = new YjsDoc();
					applyUpdate(savedDoc, new Uint8Array(await new Response(savedYjs).arrayBuffer()));
					expect(savedDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
					savedDoc.destroy();
				} finally {
					releaseOldYjsPut.resolve();
				}
				const firstDownloadResult = await firstDownload;
				if (firstDownloadResult._nay) throw new Error(firstDownloadResult._nay.message);
				const liveKey = await t.run(async (ctx) => {
					const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
					return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
				});
				const liveBytes = objects.get(liveKey);
				if (!liveBytes) throw new Error("Missing live Yjs bytes");
				const liveDoc = new YjsDoc();
				applyUpdate(liveDoc, new Uint8Array(await new Response(liveBytes).arrayBuffer()));
				// The older worker must not replace the newer worker's saved object.
				expect.soft(liveDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
				liveDoc.destroy();
			} finally {
				editor.destroy();
				releaseOldYjsPut.resolve();
				releaseUploads.resolve();
			}

			const result = await restoring;
			fetchMock.mockImplementation(baseFetch);
			expect(pausedUploads).toBe(2);
			const after = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
				const stages = await ctx.db.query("files_yjs_trusted_update_stages").collect();
				return { snapshotSequence: snapshot?.sequence, lastSequence: sequence?.lastSequence, stages };
			});
			const lastSequence = changesText ? 3 : 2;
			expect(after).toMatchObject({ snapshotSequence: lastSequence, lastSequence });
			expect(after.stages).toHaveLength(changesText ? 1 : 0);
			// A refused, unconsumed restore update is removed by the trusted-stage expiry job.
			for (const stage of after.stages) expect(stage.expiresAt).toBeGreaterThan(Date.now());
			await expect_retired_uploads(t, 4);
			const read = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/review-restore.txt",
			});
			expect.soft(result._nay?.message).toBe("This file changed while the snapshot was being restored. Try again.");
			expect.soft(read?.content).toBe(expectedText);
		},
	);
});

describe("materialize_file_content", () => {
	test("two workers for the same counter publish once and retire the unused uploads", async () => {
		const { t, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const first = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const second = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(second._nay).toBeUndefined();
		} finally {
			release.resolve();
		}
		expect((await first)._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_snapshots").collect()).toHaveLength(2);
		});
		await expect_retired_uploads(t, 2);
	});

	test("a worker paused before OFF and ON cannot publish into the new document", async () => {
		const { t, db, asUser, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const materializing = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();
			const newPointers = await test_get_file_yjs_pointers(t, nodeId);
			expect(newPointers.yjsLastSequenceId).not.toBe(pointers.yjsLastSequenceId);
			const before = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId),
			}));
			release.resolve();
			expect((await materializing)._nay).toBeUndefined();
			await t.run(async (ctx) => {
				expect(await ctx.db.get("files_nodes", nodeId)).toEqual(before.node);
				expect(await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId)).toEqual(before.snapshot);
			});
			await expect_retired_uploads(t, 2);
		} finally {
			release.resolve();
		}
	});
});

describe("restore_snapshot_r2", () => {
	test("uses the saved type for download and same-shape restore after the current type changes", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId, pointers } = await create_file_fixture();
		const originalSnapshot = await t.run((ctx) => ctx.db.get("files_snapshots", snapshotId));
		await t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { contentType: "application/json" }));

		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		getUrl.mockClear();
		const fetchObject = vi.mocked(fetch);
		fetchObject.mockClear();
		const download = await asUser.action(api.files_nodes.create_file_snapshot_content_url, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
		});
		expect(download?.snapshotId).toBe(snapshotId);
		expect(getUrl).toHaveBeenCalledWith(expect.any(String), {
			expiresIn: 15 * 60,
			responseContentType: "text/plain;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''restore.txt",
		});
		expect(fetchObject).not.toHaveBeenCalled();

		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-saved-type",
		});
		expect(restored._nay).toBeUndefined();
		const result = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			snapshots: await ctx.db.query("files_snapshots").collect(),
			originalSnapshot: await ctx.db.get("files_snapshots", snapshotId),
		}));
		expect(result.node).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
			yjsSnapshotId: pointers.yjsSnapshotId,
			yjsLastSequenceId: pointers.yjsLastSequenceId,
		});
		expect(result.snapshots.slice(-2).map((snapshot) => snapshot.contentType)).toEqual([
			"application/json",
			"text/plain;charset=utf-8",
		]);
		expect(result.originalSnapshot).toEqual(originalSnapshot);
	});

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			[true, false].map((collaborationEnabled) => ({ rootKind, collaborationEnabled })),
		),
	)(
		"restores a stored destination to $rootKind with saved collaboration $collaborationEnabled",
		async ({ rootKind, collaborationEnabled }) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture(rootKind);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let textSnapshotId = snapshotId;
			if (!collaborationEnabled) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				textSnapshotId = await t.run(async (ctx) => (await ctx.db.query("files_snapshots").order("desc").first())!._id);
			}

			const storedSnapshotId = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_snapshots", snapshotId);
				if (!snapshot) throw new Error("Missing original snapshot");
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId: snapshot.assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				});
			});
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "stored" };
			});
			const stored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: storedSnapshotId,
				sessionId: "restore-stored-first",
			});
			expect(stored._nay).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
				textKind: null,
				collaborationEnabled: null,
			});

			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, {
				userId: db.userId,
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
			});
			expect(restoreData?.snapshotContent).toMatchObject({
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
				sessionId: "restore-saved-mode",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.query("files_snapshots").order("desc").first(),
			}));
			expect(result.node?.collaborationEnabled).toBe(collaborationEnabled);
			expect(result.node?.textKind).toBe(rootKind);
			expect(result.node?.yjsSnapshotId !== null).toBe(collaborationEnabled);
			expect(result.snapshot).toMatchObject({
				contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
		},
	);

	test.each(["text/plain;charset=utf-8", "text/html"])(
		"copies null-shaped %s bytes without parsing",
		async (contentType) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType,
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			const scope = { userId: db.userId, membershipId: db.membershipId, nodeId, snapshotId };
			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, scope);
			const downloadData = await t.query(internal.files_nodes.get_data_for_create_file_snapshot_content_url, scope);
			expect(restoreData?.snapshotContent?.yjsRootKind).toBeNull();
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			expect(restoreData?.snapshotContent?.collaborationEnabled).toBe(false);
			expect(downloadData?.yjsRootKind).toBeNull();
			expect(downloadData).not.toHaveProperty("nonCollaborative");
			expect(downloadData?.contentType).toBe(contentType);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();

			const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x00, 0xff]);
			if (!restoreData?.snapshotContent?.asset.r2Key) throw new Error("Missing snapshot key");
			objects.set(restoreData.snapshotContent.asset.r2Key, bytes);
			const copy = vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				objects.set(args.destinationKey, objects.get(args.sourceKey)!);
				return { outcome: "copied", size: bytes.byteLength, etag: "stored-text" };
			});
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "null-stored-shape",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", nodeId);
				const assetId = node?.assetId;
				if (!assetId) throw new Error("Missing restored asset");
				return {
					node,
					asset: await ctx.db.get("files_r2_assets", assetId),
					snapshot: await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", assetId))
						.first(),
				};
			});
			expect(new Uint8Array(await new Response(objects.get(result.asset!.r2Key!)).arrayBuffer())).toEqual(bytes);
			expect(copy).toHaveBeenCalledOnce();
			expect(result.node).toMatchObject({ textKind: null, collaborationEnabled: null, yjsSnapshotId: null });
			expect(result.snapshot).toMatchObject({
				contentType,
				yjsRootKind: null,
				collaborationEnabled: false,
			});
			expect(result.snapshot).not.toHaveProperty("nonCollaborative");
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((sourceRootKind) =>
			(["plain_text", "rich_text"] as const).flatMap((targetRootKind) =>
				[false, true].map((off) => ({ sourceRootKind, targetRootKind, off })),
			),
		),
	)(
		"preserves every owner's proposal and expiry across repeated restores: %j",
		async ({ sourceRootKind, targetRootKind, off }) => {
			const fixture = await create_file_fixture(sourceRootKind);
			const { t, db, asUser, nodeId, snapshotId } = fixture;
			await create_pending_proposal(fixture);
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "restore_other_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
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
			await create_pending_proposal(fixture, otherUserId);
			if (off) {
				const toggled = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				});
				expect(toggled._nay).toBeUndefined();
			}

			const readProposals = () =>
				t.run(async (ctx) => {
					const [pending, states, pages, cleanup, chunks, searchChunks, metadata] = await Promise.all([
						ctx.db.query("files_pending_updates").collect(),
						ctx.db.query("files_pending_update_yjs_states").collect(),
						ctx.db.query("files_pending_update_yjs_state_pages").collect(),
						ctx.db.query("files_pending_updates_cleanup_tasks").collect(),
						ctx.db
							.query("files_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_plain_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_metadata_docs")
							.filter((q) => q.eq(q.field("sourceKind"), "pending"))
							.collect(),
					]);
					return { pending, states, pages, cleanup, chunks, searchChunks, metadata };
				});
			const before = await readProposals();
			expect(before.pending).toHaveLength(2);
			const restoredText = "Restored text\n";

			const versionId = await t.run(async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					size: new TextEncoder().encode(restoredText).byteLength,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const r2Key = `test/restore-version-${assetId}`;
				objects.set(r2Key, restoredText);
				await ctx.db.patch("files_r2_assets", assetId, { r2Key });
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: targetRootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: targetRootKind,
					collaborationEnabled: true,
				});
			});

			for (const [restoreId, rootKind, text] of [
				[versionId, targetRootKind, restoredText],
				[snapshotId, sourceRootKind, "Original text\n"],
			] as const) {
				const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: restoreId,
					sessionId: "restore-preserved-proposals",
				});
				expect(restored._nay).toBeUndefined();
				expect(await readProposals()).toEqual({
					...before,
					pending: before.pending.map((pending) => ({
						...pending,
						revision: pending.revision + 1,
						contentNeedsRebase: true,
						contentRebaseRootKind: sourceRootKind,
					})),
				});
				const node = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
				expect(node?.textKind).toBe(rootKind);
				expect(node?.collaborationEnabled === false).toBe(off);
				const content = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...fixture.scope,
					path: sourceRootKind === "rich_text" ? "/restore.md" : "/restore.txt",
				});
				expect(content?.content).toBe(text);
			}
		},
	);

	test("normalizes a version saved with collaboration off when the live document already matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/normalize.md",
			textContent: "# Original\n",
		});
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "# Title",
		});
		expect(saved._nay).toBeUndefined();
		const version = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const snapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
				.first();
			return { snapshotId: snapshot!._id, r2Key: asset!.r2Key! };
		});
		expect(objects.get(version.r2Key)).toBe("# Title");

		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-normalized",
		});
		expect(restored._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			const yjsAsset = await ctx.db.get("files_r2_assets", yjsSnapshot!.assetId);
			return { contentKey: asset!.r2Key!, yjsKey: yjsAsset!.r2Key! };
		});
		expect.soft(await new Response(objects.get(after.contentKey)).text()).toBe("# Title\n");
		const yjsDoc = new YjsDoc();
		applyUpdate(yjsDoc, new Uint8Array(await new Response(objects.get(after.yjsKey)).arrayBuffer()));
		const yjsText = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		expect(yjsText._yay).toBe("# Title\n");
		yjsDoc.destroy();

		const download = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
		});
		if (download._nay) throw new Error(download._nay.message);
		expect(await (await fetch(download._yay.url)).text()).toBe("# Title\n");
	});

	test("requires the Properties confirmation before a stored version removes shared history", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, snapshotId, pointers } = fixture;
		const pending = await create_pending_proposal(fixture);
		// A historical version saved as stored bytes, before the file became editable text.
		await t.run(async (ctx) =>
			ctx.db.patch("files_snapshots", snapshotId, {
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			}),
		);
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: new TextEncoder().encode(String(body)).byteLength, etag: "copied" };
		});
		const restore = () =>
			asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "restore-stored",
			});
		const refused = await restore();
		expect(refused._nay?.message).toBe(
			"Turn collaboration off in Properties before replacing this text file with stored content.",
		);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.filter((job) => job.reason === "failed_create")).toHaveLength(1);
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		expect((await restore())._nay).toBeUndefined();
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentType).toBe("application/octet-stream");
		expect(node?.yjsSnapshotId).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual({
			...pending,
			revision: pending.revision + 2,
			contentNeedsRebase: true,
			contentRebaseRootKind: "plain_text",
		});
	});

	test.each([false, true])(
		"keeps the destination mode when the version has the opposite mode (off: %s)",
		async (destinationOff) => {
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let versionId = snapshotId;
			if (!destinationOff) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Version saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				versionId = await t.run(async (ctx) => {
					const node = await ctx.db.get("files_nodes", nodeId);
					return (await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
						.first())!._id;
				});
			}
			const savedCurrent = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Current text to replace\n",
			});
			expect(savedCurrent._nay).toBeUndefined();
			if (!destinationOff) {
				const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				});
				expect(on._nay).toBeUndefined();
			}
			const before = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: versionId,
				sessionId: "restore-mode",
			});
			expect(restored._nay).toBeUndefined();
			const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			expect(after?.collaborationEnabled === false).toBe(destinationOff);
			const assetId = after?.assetId;
			if (!assetId) throw new Error("Missing restored content asset");
			const restoredSnapshot = await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", assetId))
					.first(),
			);
			expect(restoredSnapshot).toMatchObject({
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: !destinationOff,
			});
			expect(after?.yjsLastSequenceId).toBe(before?.yjsLastSequenceId);
			expect(after?.yjsSnapshotId).toBe(before?.yjsSnapshotId);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/restore.txt",
			});
			expect(read?.content).toBe(destinationOff ? "Original text\n" : "Version saved with collaboration off\n");
		},
	);
});

describe("copy_transfer_file saved replacement", () => {
	test.each([false, true])(
		"keeps destination identity, metadata, and collaboration %s",
		async (collaborationEnabled) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser, scope, nodeId, pointers } = fixture;
			const sourceId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: "/source/restore.txt",
				textContent: "Replacement text\n",
			});
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId: collaborationEnabled ? sourceId : nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "owner: destination",
			});
			if (collaborationEnabled) {
				const yjsKey = await t.run(async (ctx) => {
					const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
					return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
				});
				const editor = new YjsDoc();
				applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
				const beforeEdit = encodeStateVector(editor);
				const text = editor.getText(files_YJS_DOC_KEYS.plainText);
				text.insert(text.length, "Live text before replace\n");
				expect(
					(
						await asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: db.membershipId,
							nodeId,
							expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
							update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
							sessionId: "replace-test",
						})
					)._nay,
				).toBeUndefined();
				editor.destroy();
			}
			const started = await asUser.mutation(api.files_transfer.start, {
				membershipId: db.membershipId,
				requestId: "saved-replacement",
				kind: "copy",
				expectedSourceCount: 1,
				sourceIds: [sourceId],
				targetParentId: files_ROOT_ID,
			});
			if (started._nay) throw new Error(started._nay.message);
			const { runId } = started._yay;
			expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
				_yay: null,
			});
			for (let step = 0; step < 12; step++) {
				await t.mutation(internal.files_transfer.advance, { runId });
				const run = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
				if (run?.activity.status === "awaiting_input") break;
			}
			const waiting = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
			const page = await asUser.query(api.files_transfer.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { cursor: null, numItems: 50 },
			});
			if (!page) throw new Error("Missing transfer items");
			const item = page.page[0]!;
			expect(waiting?.activity.status).toBe("awaiting_input");
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting!.revision,
						choices: [
							{
								itemId: item.itemId,
								choice: "replace",
								reviewedTarget: item.conflict!.target!,
								reviewedVersion: item.conflict!.version,
							},
						],
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			for (let step = 0; step < 5; step++) {
				await t.mutation(internal.files_transfer.advance, { runId });
				const copying = await t.run((ctx) => ctx.db.get("files_transfer_items", item.itemId));
				if (copying?.workId) break;
			}
			const mediaPins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: db.userId, scopes: [scope] }),
			);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item.itemId, attempt: 1 });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item.itemId))).toMatchObject({
				state: "completed",
				outputTarget: { kind: "saved", id: nodeId },
				stagedAssetIds: [],
			});
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({ collaborationEnabled });
			expect(
				(
					await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
						...scope,
						path: "/restore.txt",
						includePending: false,
					})
				)?.content,
			).toBe("Replacement text\n");
			expect(
				(await t.run((ctx) => ctx.db.get("files_media_validation_versions", mediaPins.versions[1]!.id)))?.revision,
			).toBeGreaterThan(mediaPins.versions[1]!.revision);
			expect(
				await asUser.query(api.files_metadata.get_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				}),
			).toEqual([{ key: "owner", value: "destination" }]);
			if (collaborationEnabled) {
				const snapshots = await t.run((ctx) =>
					ctx.db
						.query("files_snapshots")
						.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
						)
						.collect(),
				);
				const texts = await Promise.all(
					snapshots.map(async (snapshot) => {
						const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", snapshot.assetId));
						return await new Response(objects.get(asset!.r2Key!)).text();
					}),
				);
				expect(texts).toContain("Original text\nLive text before replace\n");
			}
		},
	);
});

describe("accept_file_pending_replacement", () => {
	test.each(["text", "stored bytes"] as const)(
		"drops another owner's retained proposal when copying %s after a stored-byte restore",
		async (sourceKind) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture("rich_text");
			const { t, db, asUser, nodeId, snapshotId } = fixture;
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "copy_after_restore_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
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
			const pending = await create_pending_proposal(fixture, otherUserId);
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
			});
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: db.membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
						membershipId: db.membershipId,
						nodeId,
						snapshotId,
						sessionId: "copy-after-stored-restore",
					})
				)._nay,
			).toBeUndefined();
			expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.textKind).toBeNull();
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual({
				...pending,
				revision: pending.revision + 2,
				contentNeedsRebase: true,
				contentRebaseRootKind: "rich_text",
			});
			let sourceId: Id<"files_nodes">;
			if (sourceKind === "text") {
				sourceId = await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: "/source.txt",
					textContent: "Copied text\n",
				});
			} else {
				const source = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: files_ROOT_ID,
					filename: "source.pdf",
					contentType: "application/pdf",
					size: 3,
				});
				if (source._nay) throw new Error(source._nay.message);
				sourceId = source._yay.nodeId;
			}
			const sourceNode = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			if (!sourceNode?.assetId) throw new Error("Missing copy source");
			if (sourceKind === "stored bytes") {
				const r2Key = "test/copy-after-restore.pdf";
				objects.set(r2Key, new Uint8Array([0, 255, 128]));
				await t.run((ctx) => ctx.db.patch("files_r2_assets", sourceNode.assetId!, { r2Key }));
			}
			const staged = await prepare_agent_replacement(fixture, sourceNode._id);
			const mediaPins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: db.userId, scopes: [db] }),
			);
			expect(
				(
					await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
						membershipId: db.membershipId,
						target: { kind: "saved", id: nodeId },
						pendingUpdateId: staged._id,
						reviewedRevision: staged.revision,
					})
				)._nay,
			).toBeUndefined();
			await t.run(async (ctx) => {
				expect(await ctx.db.get("files_pending_updates", pending._id)).toBeNull();
				expect(
					await ctx.db
						.query("files_text_chunks")
						.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pending._id))
						.collect(),
				).toHaveLength(0);
			});
			expect(
				(await t.run((ctx) => ctx.db.get("files_media_validation_versions", mediaPins.versions[1]!.id)))?.revision,
			).toBeGreaterThan(mediaPins.versions[1]!.revision);
		},
	);

	test("refuses replacement after the saved document receives an edit", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, pointers } = fixture;
		const sourceBytes = new Uint8Array([0, 255, 10, 13, 128]);
		const source = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.pdf",
			contentType: "application/pdf",
			size: sourceBytes.byteLength,
		});
		if (source._nay) throw new Error(source._nay.message);
		const sourceKey = "test/stored-source.pdf";
		objects.set(sourceKey, sourceBytes);
		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: sourceKey }));
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: sourceBytes.byteLength, etag: "copied" };
		});
		const pending = await prepare_agent_replacement(fixture, source._yay.nodeId);

		// Live edits must remain safe even before the saved text asset changes.
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		text.insert(text.length, "Edit before accepting the copy\n");
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
			sessionId: "saved-copy-editor",
		});
		editor.destroy();
		expect(pushed._nay).toBeUndefined();

		const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: nodeId },
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		});
		expect(accepted._nay?.message).toContain("changed");
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(after?.contentType).toBe("text/plain;charset=utf-8");
		expect(after?.assetId).toBe(pending.pendingReplacement!.baseAssetId);
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test.each([
		{ sourceOff: true, destinationOff: false },
		{ sourceOff: false, destinationOff: true },
	])("keeps the saved destination collaboration mode: %j", async ({ sourceOff, destinationOff }) => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source.txt",
			textContent: "Copied text\n",
		});
		for (const id of [sourceOff ? sourceId : null, destinationOff ? nodeId : null]) {
			if (id === null) continue;
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId: id,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
		}
		const staged = await prepare_agent_replacement(fixture, sourceId);
		const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: nodeId },
			pendingUpdateId: staged._id,
			reviewedRevision: staged.revision,
		});
		expect(accepted._nay).toBeUndefined();
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		const expectedOff = destinationOff;
		expect(after?.collaborationEnabled === false).toBe(expectedOff);
		const assetId = after?.assetId;
		if (!assetId) throw new Error("Missing copied content asset");
		const copiedSnapshot = await t.run((ctx) =>
			ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", assetId))
				.first(),
		);
		expect(copiedSnapshot).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			yjsRootKind: "plain_text",
			collaborationEnabled: !expectedOff,
		});
		expect(after?.yjsLastSequenceId !== null).toBe(!expectedOff);
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/restore.txt",
		});
		expect(read?.content).toBe("Copied text\n");
	});

	test("accepts the replacement through a review run and keeps the replaced bytes in history", async () => {
		const fixture = await create_file_fixture();
		const { t, db, scope, nodeId } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source.txt",
			textContent: "Copied text\n",
		});
		const staged = await prepare_agent_replacement(fixture, sourceId);
		const previousAssetId = staged.pendingReplacement!.baseAssetId;

		const finished = await accept_through_review_run(fixture, staged);

		expect(finished?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", staged._id))).toBeNull();
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/restore.txt",
		});
		expect(read?.content).toBe("Copied text\n");
		const history = await t.run((ctx) =>
			ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect(),
		);
		expect(history.map((version) => version.assetId)).toContain(previousAssetId);
	});
});
