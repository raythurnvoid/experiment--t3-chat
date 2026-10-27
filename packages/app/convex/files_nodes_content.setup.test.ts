// Fixtures shared by the files_nodes_content test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { activities_db_start } from "./activities_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import type { Doc, Id } from "./_generated/dataModel.js";

export const objects = new Map<string, BodyInit>();

// Each test file calls this in `beforeEach`.
export function mock_nodes_content_storage() {
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
}

export async function create_file_fixture(
	rootKind: "plain_text" | "rich_text" = "plain_text",
	text = "Original text\n",
) {
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

export async function create_private_text_fixture(collaborationEnabled: boolean) {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const text = "Saved from a private draft\n";
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/private.txt",
		kind: "file",
	});
	if (created._nay || !created._yay.pendingUpdateId || !created._yay.operationBatchId)
		throw new Error("Expected a private text draft");
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	await t.run(async (ctx) => {
		const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
		if (proposal?.createIntent?.kind !== "text") throw new Error("Expected a text create intent");
		await ctx.db.patch("files_pending_updates", pendingUpdateId, {
			createIntent: { ...proposal.createIntent, collaborationEnabled },
		});
	});
	for (const role of ["staged", "unstaged"] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId,
			role,
			text,
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
	const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the private proposal");
	return { t, db, asUser, text, proposal, target };
}

export async function create_transfer_copy_item(
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
			source: { kind: "files_transfer_run", id: runId, transferKind: "copy", isRename: false },
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

export async function create_sealed_transfer_capture(fixture: Awaited<ReturnType<typeof create_file_fixture>>) {
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

export function saved_copy_id(item: Doc<"files_transfer_items"> | null) {
	if (item?.outputTarget?.kind !== "saved") throw new Error(item?.errorMessage ?? "Missing saved copy");
	return item.outputTarget.id;
}

export async function start_agent_copy(args: {
	fixture: Awaited<ReturnType<typeof create_file_fixture>>;
	source?: Doc<"files_transfer_items">["source"];
	targetName?: string;
}) {
	const { fixture, source = { kind: "saved", id: fixture.nodeId }, targetName = "copied.txt" } = args;

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
			newestNodeId: null,
			starred: false,
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

export async function prepare_agent_replacement(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	sourceId: Id<"files_nodes">,
) {
	const destination = await fixture.t.run((ctx) => ctx.db.get("files_nodes", fixture.nodeId));
	const copy = await start_agent_copy({
		fixture,
		source: { kind: "saved", id: sourceId },
		targetName: destination!.name,
	});
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
 * Accept one proposal through the sidebar's real Review workers.
 */
export async function accept_through_review_run(
	fixture: Awaited<ReturnType<typeof create_file_fixture>>,
	pendingUpdate: Doc<"files_pending_updates">,
) {
	const { db, asUser } = fixture;
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
	// Keep scheduled deletes paused while the Review driver runs.
	const hadFakeTimers = vi.isFakeTimers();
	vi.useFakeTimers();
	try {
		await test_finish_pending_update_run(asUser, runId);
	} finally {
		if (!hadFakeTimers) vi.useRealTimers();
	}
	return await asUser.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId });
}

export async function create_private_copy_source(
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

export async function create_pending_proposal(args: {
	fixture: Awaited<ReturnType<typeof create_file_fixture>>;
	userId?: Id<"users">;
	texts?: { staged: string; unstaged: string };
}) {
	const {
		fixture,
		userId = fixture.scope.userId,
		texts = {
			staged: "---\nreview: accepted\n---\n\nAccepted text\n",
			unstaged: "---\nreview: accepted\n---\n\nAccepted text\n\nProposed text\n",
		},
	} = args;

	const { t, scope, nodeId } = fixture;
	const ownerScope = { ...scope, userId };
	const node = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		...ownerScope,
		target: { kind: "saved", id: nodeId },
		expectedPendingContentVersion: node.pendingContentVersion,
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

export async function expect_retired_uploads(t: ReturnType<typeof test_convex>, count: number) {
	// Abandoned prepared heads release their assets after their exact chunks are removed.
	const completed = new Set<string>();
	for (let step = 0; step < 1000; step++) {
		const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		const job = jobs.find((job) => !completed.has(job._id) && job.state.kind === "pending" &&
			job.scheduledTime <= Date.now() && [
				getFunctionName(internal.files_content_saves.retire), getFunctionName(internal.files_content_saves.discard),
			].includes(job.name));
		if (!job) break;
		completed.add(job._id);
		const args = job.args[0] as { headId: Id<"files_saved_content_heads"> };
		await t.mutation(job.name === getFunctionName(internal.files_content_saves.retire)
			? internal.files_content_saves.retire : internal.files_content_saves.discard, args);
		if (step === 999) throw new Error("Prepared source cleanup did not finish");
	}
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
