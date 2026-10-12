import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_run_with_flush } from "./setup.test.ts";
import { files_nodes_db_get_content_version } from "./files_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
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
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { files_db_load_pending_update_yjs_state_bytes, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";

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
	const prepareContext = { ...context, runGeneration: null };
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
		const prepared = await f.t.action((ctx) => files_move_content_action_prepare(ctx, prepareContext));
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
	return { ...f, itemId, context, prepareContext, chunks, stage, publish };
}

test("reports content pages, including an empty update page", async () => {
	const f = await fixture();
	expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, f.prepareContext))).toEqual({ _yay: null });
	let sawEmptyUpdatePage = false;
	for (let pass = 0; pass < 100; pass++) {
		const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
		const staged = await test_run_with_flush(f.t, (ctx) => files_move_content_db_stage(ctx, f.context));
		if (staged._nay) throw new Error(staged._nay.message);
		const after = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
		// Text pages use no native page, so one step runs them and then the update page, which ends the step.
		if (content.phase !== "pending_text" && after.phase === "pending_text") {
			expect(content.prepared?.kind).toBe("saved_yjs");
			if (content.prepared?.kind !== "saved_yjs") throw new Error("Expected saved Yjs content");
			expect(content.sourceSnapshotSequence).toBe(content.prepared.baseYjsSequence);
			expect(content.phase, "text creation uses no native page, so the step goes on").not.toBe("updates");
			expect(staged._yay.paged, "an empty native update page is reported").toBe(true);
			sawEmptyUpdatePage = true;
		}
		if (staged._yay.done) break;
		if (pass === 99) throw new Error("Fixture content did not seal");
	}
	expect(sawEmptyUpdatePage, "the test reaches the empty native update page").toBe(true);
});

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
		_yay: { done: true, paged: false },
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
		_yay: { done: true, paged: false },
	});
});

test("each content page checks current membership before changing any side", async () => {
	const f = await fixture();
	expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, f.prepareContext))).toEqual({ _yay: null });
	const before = await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId));
	await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
	expect(
		await test_run_with_flush(f.t, (ctx) => files_move_content_db_stage(ctx, f.context)),
		"a removed member cannot stage another content page",
	).toEqual({ _nay: { message: "Unauthorized" } });
	expect(await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId))).toEqual(before);
	expect(await f.chunks(), "the refused page keeps the old saved content").toBe("old text");
});

test("pages a long text from one chunking, also after a page loses the kept bounds", async () => {
	// Long lines are cut mid-line, and a cut never splits an emoji. The text needs several pages.
	const staged = `${Array.from({ length: 30 }, (_, index) => `${index} ${"😀 words ".repeat(index * 9)}`).join("\n")}\n`;
	const f = await fixture({ staged, unstaged: `${staged}later draft` });
	expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, f.prepareContext))).toEqual({ _yay: null });
	const chunker = vi.spyOn(await import("../server/files-plain-text-chunking.ts"), "files_chunk_plain_text");
	// One page per step, so a step can end inside the text phase. A step may otherwise run many pages.
	vi.spyOn(
		await import("../server/files-pending-overlay.ts"),
		"files_pending_overlay_db_can_join_step",
	).mockResolvedValue(false);
	let dropped = false;
	for (let i = 0; i < 200; i++) {
		const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
		// Content staged before the bounds were kept has none in the middle of a phase.
		if (!dropped && content.phase === "text" && content.nextChunkIndex > 0) {
			expect(content.chunkBounds, "a text phase keeps its chunk bounds between pages").toBeDefined();
			await f.t.run((ctx) => ctx.db.patch("files_move_cohort_content", content._id, { chunkBounds: undefined }));
			dropped = true;
		}
		const staged = await test_run_with_flush(f.t, (ctx) => files_move_content_db_stage(ctx, f.context));
		if (staged._nay) throw new Error(staged._nay.message);
		if (staged._yay.done) break;
		if (i === 199) throw new Error("Content did not seal");
	}
	expect(dropped, "the text phase had more than one page").toBe(true);
	expect(chunker, "each text is chunked once, plus once again for the page that lost its bounds").toHaveBeenCalledTimes(
		3,
	);
	const { content, inputs, text, plain } = await f.t.run(async (ctx) => {
		const content = (await ctx.db.get("files_move_cohort_content", f.context.contentId))!;
		const after = (row: { moveView?: { view: string } }) => row.moveView?.view === "after";
		return {
			content,
			inputs: {
				committed: (await ctx.db.get("files_pending_update_text_inputs", content.acceptedTextInputId!))!.text,
				pending: (await ctx.db.get("files_pending_update_text_inputs", content.unstagedTextInputId!))!.text,
			},
			text: (await ctx.db.query("files_text_chunks").collect()).filter(after),
			plain: (await ctx.db.query("files_plain_text_chunks").collect()).filter(after),
		};
	});
	expect(content.chunkBounds, "the bounds go away with their phase").toBeUndefined();
	for (const sourceKind of ["committed", "pending"] as const) {
		const expected = files_chunk_plain_text(inputs[sourceKind]);
		expect(expected.length, "the text needs several pages").toBeGreaterThan(16);
		const rows = <T extends { sourceKind: string; chunkIndex: number }>(list: T[]) =>
			list.filter((row) => row.sourceKind === sourceKind).sort((a, b) => a.chunkIndex - b.chunkIndex);
		expect(
			rows(text).map(({ chunkIndex, textChunk, startIndex, endIndex, lineStart, lineEnd, chunkFlags }) => ({
				chunkIndex,
				textChunk,
				startIndex,
				endIndex,
				lineStart,
				lineEnd,
				chunkFlags,
			})),
			`the ${sourceKind} rows match one full chunking`,
		).toEqual(expected.map(({ plainTextChunk: _plain, ...chunk }) => chunk));
		expect(
			rows(plain).map(({ chunkIndex, plainTextChunk, hasChunkAbove, hasChunkBelow }) => ({
				chunkIndex,
				plainTextChunk,
				hasChunkAbove,
				hasChunkBelow,
			})),
			`the ${sourceKind} plain rows match one full chunking`,
		).toEqual(
			expected.map((chunk) => ({
				chunkIndex: chunk.chunkIndex,
				plainTextChunk: chunk.plainTextChunk,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < expected.length - 1,
			})),
		);
	}
});

test("a reviewed partial Save publishes at full private byte quotas and charges once", async () => {
	const f = await fixture();
	await f.stage();
	const content = (await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.context.contentId)))!;
	expect(content.privateByteDelta).toBeGreaterThan(0);
	expect(content.privateNodeDelta).toBe(0);
	const balances = await f.t.run(async (ctx) => {
		const quotaDocs = [];
		for (const quotaName of [
			"files_private_user_bytes",
			"files_private_workspace_bytes",
			"files_private_nodes",
		] as const) {
			const id = await quotas_db_ensure(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				...(quotaName === "files_private_workspace_bytes" ? { quotaName } : { quotaName, userId: f.db.userId }),
				now: Date.now(),
			});
			const quota = (await ctx.db.get("quotas", id))!;
			if (quotaName !== "files_private_nodes") await ctx.db.patch("quotas", id, { maxCount: quota.usedCount });
			quotaDocs.push((await ctx.db.get("quotas", id))!);
		}
		return quotaDocs;
	});
	const expectBalances = (assertion: string) =>
		f.t.run(async (ctx) => {
			for (const quota of balances)
				expect(await ctx.db.get("quotas", quota._id), assertion).toMatchObject({
					usedCount: quota.usedCount + (quota.quotaName === "files_private_nodes" ? 0 : content.privateByteDelta),
					maxCount: quota.maxCount,
				});
		});
	expect(await f.publish(), "Reviewed partial Save publishes at full private byte quotas").toEqual({ _yay: null });
	await expectBalances("Save applies both exact byte deltas and keeps the caps and node count");
	expect(await f.chunks(), "Save publishes the accepted text").toBe("accepted text");
	const proposal = await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, f.proposal._id));
	const bytes = await f.t.run(async (ctx) => {
		const state = await ctx.db.get("files_pending_update_yjs_states", proposal!.content!.unstagedStateId);
		if (!state) throw new Error("Expected the remaining draft state");
		const loaded = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc: state });
		if (loaded._nay) throw new Error(loaded._nay.message);
		return files_u8_to_array_buffer(loaded._yay);
	});
	const doc = files_yjs_doc_create_from_array_buffer_update(bytes);
	expect(files_yjs_doc_get_text({ yjsDoc: doc, rootKind: "plain_text" })).toEqual({
		_yay: "accepted text\nlater draft",
	});
	doc.destroy();
	expect(await test_run_with_flush(f.t, (ctx) => files_move_content_db_publish_accounting(ctx, f.context))).toEqual({
		_yay: null,
	});
	await expectBalances("Replaying Save does not charge either byte quota again");
	for (let pass = 0; pass < 100; pass++) {
		const result = await test_run_with_flush(f.t, (ctx) => files_move_content_db_finish(ctx, f.context));
		if (result._nay) throw new Error(result._nay.message);
		if (result._yay.done) break;
		if (pass === 99) throw new Error("Content repair did not finish");
	}
	await expectBalances("Physical repair keeps the published byte balances, caps and node count");
});

test("publication still refuses private node growth at the node cap", async () => {
	const f = await fixture();
	await f.stage();
	// No real Move adds private nodes. Force one to prove the node cap still guards the switch.
	await f.t.run(async (ctx) => {
		const id = await quotas_db_ensure(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			quotaName: "files_private_nodes",
			now: Date.now(),
		});
		const quota = (await ctx.db.get("quotas", id))!;
		await ctx.db.patch("quotas", id, { maxCount: quota.usedCount });
		await ctx.db.patch("files_move_cohorts", f.cohortId, { privateNodeDelta: 1 });
	});
	const balances = await f.t.run((ctx) => ctx.db.query("quotas").collect());
	expect(await f.publish()).toMatchObject({ _nay: { name: "storage_full" } });
	expect(await f.t.run((ctx) => ctx.db.query("quotas").collect()), "a refused switch changes no balance").toEqual(
		balances,
	);
	expect(await f.chunks(), "the refusal leaves the old content visible").toBe("old text");
});

test("a 700 KB Save stages and repairs in few steps, and no step nears a limit", async () => {
	// Each text has about 600 chunks, written or tagged in pages of 8.
	const text = "a\t".repeat(350_000);
	const f = await fixture({ staged: text, unstaged: `${text}\nlater draft` });
	let steps = 0;
	let heaviest = 0;
	const step = (
		run: (ctx: MutationCtx) => ReturnType<typeof files_move_content_db_stage | typeof files_move_content_db_finish>,
	) =>
		test_run_with_flush(f.t, async (ctx) => {
			steps++;
			const result = await run(ctx);
			await files_pending_overlay_db_flush(ctx);
			for (const metric of Object.values(await ctx.meta.getTransactionMetrics()))
				heaviest = Math.max(heaviest, metric.used / (metric.used + metric.remaining));
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.done;
		});
	const untagged = () =>
		f.t.run(async (ctx) =>
			(
				await Promise.all(
					(["files_text_chunks", "files_plain_text_chunks"] as const).map((table) =>
						ctx.db
							.query(table)
							.withIndex("by_pendingUpdate_chunkIndex", (q) =>
								q
									.eq("pendingUpdateId", f.proposal._id)
									.eq("moveView.cohortId", undefined)
									.eq("moveView.view", undefined),
							)
							.collect(),
					),
				)
			).flat(),
		);
	expect((await untagged()).length, "the draft has old chunks to tag").toBeGreaterThan(1000);
	expect(await f.t.action((ctx) => files_move_content_action_prepare(ctx, f.prepareContext))).toEqual({ _yay: null });
	while (!(await step((ctx) => files_move_content_db_stage(ctx, f.context))));
	expect(await untagged(), "staging tags every old draft chunk").toEqual([]);
	expect(await f.publish()).toEqual({ _yay: null });
	while (!(await step((ctx) => files_move_content_db_finish(ctx, f.context))));
	expect(await f.chunks(), "the switch serves the whole accepted text").toBe(text);
	// One page per step took 754 steps. Pages join while a step stays under 1/16 of every limit, so 65 steps.
	expect(steps, "each step runs many pages").toBeLessThan(80);
	expect(heaviest, "each step keeps a quarter of every limit").toBeLessThan(0.75);
});

test("a stale runner cannot retire a successor's preparation at the same step", async () => {
	const f = await fixture();
	await f.t.mutation(internal.files_move_cohorts.handoff, { cohortId: f.cohortId, step: 0, runGeneration: null });
	const first = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
	await f.t.mutation(internal.files_move_cohorts.handoff, {
		cohortId: f.cohortId,
		step: first.step,
		runGeneration: first.runJob!.generation,
	});
	const successor = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
	expect(successor.step, "runner replacement keeps the preparation step").toBe(first.step);
	const begun = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, {
		...f.context,
		runGeneration: successor.runJob!.generation,
	});
	if (begun._nay) throw new Error(begun._nay.message);
	const cohortContent = { ...f.context, preparationFence: begun._yay.preparationFence };
	const batch = await f.t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		target: { kind: "saved", id: f.nodeId },
		cohortContent,
	});
	if (batch._nay) throw new Error(batch._nay.message);
	const staged = await f.t.mutation(internal.files_pending_updates.stage_prepared_content_text, {
		cohortContent,
		userId: f.db.userId,
		operationBatchId: batch._yay.operationBatchId,
		role: "staged",
		text: "successor output",
	});
	if (staged._nay) throw new Error(staged._nay.message);
	const before = await f.t.run(async (ctx) => ({
		content: await ctx.db.get("files_move_cohort_content", f.context.contentId),
		batch: await ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId),
		input: await ctx.db.get("files_pending_update_text_inputs", staged._yay),
	}));
	expect(
		await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, {
			...f.context,
			runGeneration: first.runJob!.generation,
		}),
		"a stale runner cannot begin over its successor",
	).toMatchObject({ _nay: { name: "stopped" } });
	expect(
		await f.t.run(async (ctx) => ({
			content: await ctx.db.get("files_move_cohort_content", f.context.contentId),
			batch: await ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId),
			input: await ctx.db.get("files_pending_update_text_inputs", staged._yay),
		})),
		"the successor keeps its batch, bytes and preparation fence",
	).toEqual(before);
});

test("a lost preparation keeps held output and fences the next attempt", async () => {
	const f = await fixture();
	const first = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, f.prepareContext);
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
	const second = await f.t.mutation(internal.files_pending_updates.begin_cohort_content_preparation, f.prepareContext);
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
