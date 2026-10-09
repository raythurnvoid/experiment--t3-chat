import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_run_with_flush } from "./setup.test.ts";
import { files_nodes_db_get_content_version } from "./files_nodes.ts";
import {
	files_move_content_action_prepare,
	files_move_content_db_abort,
	files_move_content_db_create,
	files_move_content_db_finish,
	files_move_content_db_publish_accounting,
	files_move_content_db_stage,
} from "./files_move_content.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
} from "../server/files-saved-placement.ts";
import { files_saved_content_collect, files_saved_content_db_text_chunks } from "../server/files-saved-content.ts";
import { files_db_load_pending_update_yjs_state_bytes, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";

const objects = new Map<string, string | ArrayBuffer>();

beforeEach(() => {
	vi.useFakeTimers();
	objects.clear();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("cohort-content-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
			const key = parsed.searchParams.get("key")!;
			if (parsed.pathname === "/upload") {
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(args?: { staged?: string; unstaged?: string; selected?: "staged" | "unstaged" }) {
	const f = await test_create_saved_placement_fixture();
	// The fixture seeds future placement rows. Produce the content through real edit doors first.
	const slotId = await f.t.run(async (ctx) => {
		await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: undefined });
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId))
			.unique();
		if (!slot) throw new Error("Expected a fixture slot");
		await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId: null });
		const claims = await ctx.db
			.query("files_move_slot_claims")
			.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
			.collect();
		for (const claim of claims) await ctx.db.delete("files_move_slot_claims", claim._id);
		return slot._id;
	});
	const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: f.db.membershipId,
		target: { kind: "saved", id: f.nodeId },
	});
	if (batch._nay) throw new Error(batch._nay.message);
	for (const [role, text] of [
		["staged", args?.staged ?? "accepted text"],
		["unstaged", args?.unstaged ?? "accepted text\nlater draft"],
	] as const) {
		const staged = await f.asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: f.db.membershipId,
			operationBatchId: batch._yay.operationBatchId,
			role,
			text,
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const edited = await f.asUser.action(api.ai_chat.upsert_file_pending_update, {
		membershipId: f.db.membershipId,
		target: { kind: "saved", id: f.nodeId },
		operationBatchId: batch._yay.operationBatchId,
	});
	if (edited._nay) throw new Error(edited._nay.message);
	const itemId = await f.t.run(async (ctx) => {
		const proposal = await ctx.db.get("files_pending_updates", f.proposal._id);
		const node = await ctx.db.get("files_nodes", f.nodeId);
		if (!proposal?.content || !node) throw new Error("Expected edited content");
		await ctx.db.patch("files_move_workspace_slots", slotId, { cohortId: f.cohortId });
		await ctx.db.patch("files_nodes", f.nodeId, { moveCohortId: f.cohortId });
		await ctx.db.patch("files_pending_updates", proposal._id, { moveCohortId: f.cohortId });
		await ctx.db.patch("files_move_cohort_nodes", f.recordId, {
			sourceContentVersion: await files_nodes_db_get_content_version(ctx, node),
		});
		const itemId = await ctx.db.insert("files_move_cohort_items", {
			cohortId: f.cohortId,
			order: 0,
			origin: { kind: "transfer", itemId: f.itemId },
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId:
				args?.selected === "unstaged" ? proposal.content.unstagedStateId : proposal.content.stagedStateId,
			target: proposal.target,
			privateVersion: null,
			mediaDependencySet: null,
			nodeRecordId: f.recordId,
			afterProposal: null,
			contentId: null,
			replacementItemId: null,
			status: "staged",
			validatedEpoch: null,
			billingState: "none",
		});
		await ctx.db.patch("files_move_cohort_nodes", f.recordId, { itemId });
		return itemId;
	});
	const created = await test_run_with_flush(f.t, (ctx) =>
		files_move_content_db_create(ctx, { cohortId: f.cohortId, itemId, nodeId: f.nodeId }),
	);
	if (created._nay) throw new Error(created._nay.message);
	const context = { cohortId: f.cohortId, contentId: created._yay, fence: 1, attemptFence: 1 };
	const chunks = () =>
		f.t.run(async (ctx) => {
			const node = await files_saved_placement_db_get_node(ctx.db, f.nodeId);
			if (!node) throw new Error("Expected effective node");
			return (
				await files_saved_content_collect(files_saved_content_db_text_chunks(ctx.db, { ...node, nodeId: node._id }))
			)
				.map((row) => row.textChunk)
				.join("");
		});
	const stage = async () => {
		const prepared = await f.t.action((ctx) => files_move_content_action_prepare(ctx, context));
		expect(prepared, "the real content action prepares a durable candidate").toEqual({ _yay: null });
		for (let i = 0; i < 100; i++) {
			const staged = await test_run_with_flush(f.t, (ctx) => files_move_content_db_stage(ctx, context));
			if (staged._nay) throw new Error(staged._nay.message);
			if (staged._yay.done) return;
		}
		throw new Error("Fixture content did not seal");
	};
	const publish = () =>
		test_run_with_flush(f.t, async (ctx) => {
			await ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "ready" });
			const accounting = await files_move_content_db_publish_accounting(ctx, context);
			if (accounting._nay) return accounting;
			await ctx.db.patch("files_move_cohorts", f.cohortId, {
				phase: "published",
				visibleView: "after",
				publishedAt: Date.now(),
			});
			return accounting;
		});
	return { ...f, itemId, context, chunks, stage, publish };
}

test("staging preserves saved content, then publishes exact partial content and quota once", async () => {
	const f = await fixture();
	const old = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
	const initial = await f.t.run((ctx) =>
		ctx.db
			.query("quotas")
			.withIndex("by_workspace_quotaName", (q) =>
				q.eq("workspaceId", f.db.workspaceId).eq("quotaName", "files_private_workspace_bytes"),
			)
			.unique(),
	);
	await f.stage();
	expect(await f.chunks(), "staging leaves the saved content unchanged").toBe("old text");
	expect(
		await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)),
		"staging does not patch the physical content head",
	).toEqual(old);
	const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
	expect(content.afterSequence?.lastSequenceId, "ordinary Save keeps the sequence identity").toBe(
		old!.yjsLastSequenceId,
	);
	expect(content.afterSequence?.lineageGeneration, "ordinary Save keeps the Yjs lineage").toBe(0);
	expect(await f.publish()).toEqual({ _yay: null });
	expect(await f.chunks(), "the switch serves accepted content").toBe("accepted text");
	const proposal = await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, f.proposal._id));
	expect(proposal?.content?.base, "only later draft edits remain on the accepted base").toEqual({
		kind: "yjs",
		sequence: 1,
		lineageGeneration: 0,
	});
	const bytes = await f.t.run(async (ctx) => {
		const stateDoc = await ctx.db.get("files_pending_update_yjs_states", proposal!.content!.unstagedStateId);
		if (!stateDoc) throw new Error("Expected remaining state");
		const loaded = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
		if (loaded._nay) throw new Error(loaded._nay.message);
		return files_u8_to_array_buffer(loaded._yay);
	});
	const doc = files_yjs_doc_create_from_array_buffer_update(bytes);
	expect(files_yjs_doc_get_text({ yjsDoc: doc, rootKind: "plain_text" })).toEqual({
		_yay: "accepted text\nlater draft",
	});
	doc.destroy();
	const balance = () => f.t.run((ctx) => ctx.db.get("quotas", initial!._id));
	expect((await balance())!.usedCount, "publication applies the exact private delta").toBe(
		initial!.usedCount + content.privateByteDelta,
	);
	expect(await test_run_with_flush(f.t, (ctx) => files_move_content_db_publish_accounting(ctx, f.context))).toEqual({
		_yay: null,
	});
	expect((await balance())!.usedCount, "replaying publication does not debit quota again").toBe(
		initial!.usedCount + content.privateByteDelta,
	);
	for (let i = 0; i < 100; i++) {
		const finished = await test_run_with_flush(f.t, (ctx) => files_move_content_db_finish(ctx, f.context));
		if (finished._nay) throw new Error(finished._nay.message);
		if (finished._yay.done) break;
		if (i === 99) throw new Error("Content repair did not finish");
	}
	expect((await balance())!.usedCount, "physical repair cannot change the published private balance").toBe(
		initial!.usedCount + content.privateByteDelta,
	);
	expect(await test_run_with_flush(f.t, (ctx) => files_move_content_db_finish(ctx, f.context))).toEqual({
		_yay: { done: true },
	});
	expect(
		(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId).eq("fileNodeId", f.nodeId),
					)
					.collect(),
			)
		).filter((row) => row.assetId === content.afterAssetId),
	).toHaveLength(1);
});

test.each(["finish", "abort"] as const)(
	"a no-publication review preserves its saved content head after %s",
	async (mode) => {
		const f = await fixture({ staged: "unselected edit", unstaged: "old text", selected: "unstaged" });
		const original = await f.t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", f.nodeId))!;
			return {
				node,
				sequence: await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId!),
				snapshot: await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId!),
				stats: await ctx.db.get("file_stats", node.statsId!),
			};
		});
		const beforeObjects = new Map(objects);
		await f.stage();
		expect(objects, "unchanged accepted text creates no content or snapshot upload").toEqual(beforeObjects);
		const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
		expect(content.afterSnapshotId, "unchanged content keeps the snapshot identity").toBe(original.node.yjsSnapshotId);
		expect(content.afterStatsId).toBe(original.node.statsId);
		expect(content.costCents).toBe(0);
		if (mode === "finish") expect(await f.publish()).toEqual({ _yay: null });
		else await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "aborting" }));
		for (let pass = 0; pass < 100; pass++) {
			const result = await test_run_with_flush(f.t, (ctx) =>
				mode === "finish" ? files_move_content_db_finish(ctx, f.context) : files_move_content_db_abort(ctx, f.context),
			);
			if (result._nay) throw new Error(result._nay.message);
			if (result._yay.done) break;
			if (pass === 99) throw new Error("Unchanged content cleanup did not finish");
		}
		expect(await f.chunks()).toBe("old text");
		await f.t.run(async (ctx) => {
			expect(
				await ctx.db.get("files_yjs_docs_last_sequences", original.sequence!._id),
				"cleanup preserves the unchanged sequence counters",
			).toEqual(original.sequence);
			expect(await ctx.db.get("files_yjs_snapshots", original.snapshot!._id)).toEqual(original.snapshot);
			expect(await ctx.db.get("file_stats", original.stats!._id)).toEqual(original.stats);
		});
	},
);

test("Stop restores content and keeps original private accounting", async () => {
	const f = await fixture();
	const old = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
	await f.stage();
	const quota = await f.t.run((ctx) =>
		ctx.db
			.query("quotas")
			.withIndex("by_workspace_quotaName", (q) =>
				q.eq("workspaceId", f.db.workspaceId).eq("quotaName", "files_private_workspace_bytes"),
			)
			.unique(),
	);
	await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "aborting" }));
	for (let i = 0; i < 100; i++) {
		const stopped = await test_run_with_flush(f.t, (ctx) => files_move_content_db_abort(ctx, f.context));
		if (stopped._nay) throw new Error(stopped._nay.message);
		if (stopped._yay.done) break;
		if (i === 99) throw new Error("Content Stop did not finish");
	}
	expect(await f.chunks(), "Stop restores all old chunks").toBe("old text");
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).toEqual(old);
	expect(
		(await f.t.run((ctx) => ctx.db.get("quotas", quota!._id)))!.usedCount,
		"Stop does not change original private storage",
	).toBe(quota!.usedCount);
	expect(await test_run_with_flush(f.t, (ctx) => files_move_content_db_abort(ctx, f.context))).toEqual({
		_yay: { done: true },
	});
});

test("each content page checks current membership before changing any side", async () => {
	const f = await fixture();
	expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, f.context))).toEqual({ _yay: null });
	const before = await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId));
	await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
	expect(
		await test_run_with_flush(f.t, (ctx) => files_move_content_db_stage(ctx, f.context)),
		"a removed member cannot stage another content page",
	).toEqual({ _nay: { message: "Unauthorized" } });
	expect(await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId))).toEqual(before);
	expect(await f.chunks(), "the refused page keeps the old saved content").toBe("old text");
});

test("publication refuses extra private growth without changing any balance or saved content", async () => {
	const f = await fixture();
	await f.stage();
	const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
	expect(content.privateByteDelta).toBeGreaterThan(0);
	await f.t.run(async (ctx) => {
		const quota = await ctx.db
			.query("quotas")
			.withIndex("by_workspace_quotaName", (q) =>
				q.eq("workspaceId", f.db.workspaceId).eq("quotaName", "files_private_workspace_bytes"),
			)
			.unique();
		if (!quota) throw new Error("Expected private quota");
		await ctx.db.patch("quotas", quota._id, { maxCount: quota.usedCount });
	});
	const balances = await f.t.run((ctx) => ctx.db.query("quotas").collect());
	expect(await f.publish(), "final private growth still needs ordinary quota").toMatchObject({
		_nay: { name: "storage_full" },
	});
	expect(await f.t.run((ctx) => ctx.db.query("quotas").collect()), "a refused switch changes no balance").toEqual(
		balances,
	);
	expect(await f.chunks(), "quota refusal leaves the old content visible").toBe("old text");
});

test("a lost preparation keeps held output and fences the next attempt", async () => {
	const f = await fixture();
	const first = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, f.context);
	if (first._nay) throw new Error(first._nay.message);
	const oldContext = { ...f.context, preparationFence: first._yay.preparationFence };
	const batch = await f.t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		target: { kind: "saved", id: f.nodeId },
		cohortContent: oldContext,
	});
	if (batch._nay) throw new Error(batch._nay.message);
	expect(
		await f.t.mutation(internal.files_pending_updates.stage_prepared_content_text, {
			cohortContent: oldContext,
			userId: f.db.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "staged",
			text: "held output",
		}),
	).toMatchObject({ _yay: expect.any(String) });
	vi.setSystemTime(Date.now() + 60 * 60 * 1000);
	await f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
		_test_disableReschedule: true,
	});
	expect(
		await f.t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)),
		"a long cohort keeps its preparation batch",
	).not.toBeNull();
	const second = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, f.context);
	if (second._nay) throw new Error(second._nay.message);
	expect(second._yay.preparationFence).toBe(first._yay.preparationFence + 1);
	expect(
		await f.t.mutation(internal.files_pending_updates.stage_prepared_content_text, {
			cohortContent: oldContext,
			userId: f.db.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "staged",
			text: "late output",
		}),
		"an old worker cannot overwrite new preparation",
	).toMatchObject({ _nay: { name: "stopped" } });
	await f.stage();
	expect(await f.chunks()).toBe("old text");
});
