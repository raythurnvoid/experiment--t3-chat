import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import {
	files_move_content_PAGE_SIZE as PAGE_SIZE,
	files_move_content_STEP_MAX_PAGES as STEP_MAX_PAGES,
	type files_move_content_Context as Context,
	files_move_content_db_current as db_current,
	files_move_content_phase_cursor as phase_cursor,
	files_move_content_changes_saved_content as changes_saved_content,
	files_move_content_retained_state_ids as retained_state_ids,
	files_move_content_consumed_resources as consumed_resources,
	files_move_content_db_reservation as db_reservation,
} from "./files_move_content_db.ts";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { files_move_cohorts_db_advance } from "./files_move_cohorts.ts";
import { files_pending_updates_action_prepare_content } from "./files_pending_updates.ts";
import { files_compute_wc_counts, files_nodes_db_insert_committed_text_chunks } from "./files_nodes_create_db.ts";
import { files_metadata_content_stage_docs } from "./files_metadata.ts";
import { files_metadata_maps_db_read } from "../server/files-metadata-maps.ts";
import { files_stored_uploads_cost_cents, files_stored_uploads_db_admit } from "./files_stored_uploads.ts";
import { files_subtree_ops_db_is_near_limits } from "./files_subtree_ops_db.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import {
	files_chunk_markdown_add_plain_text,
	files_chunk_markdown_bounds,
} from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { files_yjs_scan_client_update } from "../shared/files-yjs.ts";
import {
	files_content_type_index_fields,
	files_get_utf8_byte_size,
	files_MAX_YJS_WIRE_BYTES,
	type files_YjsRootKind,
} from "../shared/files.ts";
import { files_metadata_FRONTMATTER_FIELD_PREFIX } from "../shared/files-metadata.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Reuse loaded modules. Keep each request's state inside its handler.
export const experimental_reuseContext = true;

export async function files_move_content_action_prepare(
	ctx: ActionCtx,
	args: Context & { runGeneration: number | null },
) {
	const begun = await ctx.runMutation(internal.files_pending_updates.begin_cohort_content_preparation, args);
	if (begun._nay) return begun;
	if (begun._yay.done) return Result({ _yay: null });
	const { runGeneration: _runGeneration, ...context } = args;
	const cohortContent = { ...context, preparationFence: begun._yay.preparationFence };
	const data = await ctx.runQuery(internal.files_pending_updates.get_cohort_content_preparation, cohortContent);
	if (data._nay) return data;
	const { phase: _phase, preparationFence: _preparationFence, ...scope } = data._yay;
	const prepared = await files_pending_updates_action_prepare_content(ctx, { ...scope, cohortContent });
	if (prepared._nay) return prepared;
	return await ctx.runMutation(internal.files_pending_updates.stage_cohort_prepared_content, {
		cohortContent,
		prepared: prepared._yay,
	});
}

async function db_progress(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	phase: Doc<"files_move_cohort_content">["phase"],
	part: number,
	cursor: string | null,
	paged: boolean,
	nextChunkIndex = 0,
	chunkBounds?: ArrayBuffer,
) {
	await ctx.db.patch("files_move_cohort_content", content._id, {
		phase,
		phaseCursor: `${part}|${cursor ?? ""}`,
		nextChunkIndex,
		chunkBounds,
	});
	return Result({ _yay: { done: false, paged } });
}

/**
 * One page of the chunks of a prepared text, from `content.nextChunkIndex`. The first page chunks the
 * whole text and returns the bounds of every chunk, and the step keeps them on the content doc. Later pages
 * read their bounds there, so a big text is chunked once and not once per page.
 */
async function chunk_page(content: Doc<"files_move_cohort_content">, text: string, rootKind: files_YjsRootKind) {
	let bounds = content.chunkBounds ? new Uint32Array(content.chunkBounds) : null;
	if (!bounds) {
		const chunks =
			rootKind === "rich_text"
				? await files_chunk_markdown_bounds(text)
				: Result({ _yay: files_chunk_plain_text(text) });
		if (chunks._nay) return chunks;
		// The chunker merges small pieces, so even a text made to give tiny chunks keeps its bounds small:
		// 900,000 characters made 6,553 chunks, 128 KiB of the 1 MiB doc limit.
		bounds = Uint32Array.from(
			chunks._yay.flatMap((chunk) => [
				chunk.startIndex,
				chunk.endIndex,
				chunk.lineStart,
				chunk.lineEnd,
				chunk.chunkFlags,
			]),
		);
	}
	const totalChunkCount = bounds.length / 5;
	const page = [];
	for (
		let chunkIndex = content.nextChunkIndex;
		chunkIndex < Math.min(totalChunkCount, content.nextChunkIndex + PAGE_SIZE);
		chunkIndex++
	) {
		const [startIndex, endIndex, lineStart, lineEnd, chunkFlags] = bounds.subarray(chunkIndex * 5, chunkIndex * 5 + 5);
		const textChunk = text.slice(startIndex, endIndex);
		page.push({
			chunkIndex,
			textChunk,
			plainTextChunk: textChunk,
			startIndex,
			endIndex,
			lineStart,
			lineEnd,
			chunkFlags,
		});
	}
	const chunks = rootKind === "rich_text" ? files_chunk_markdown_add_plain_text(page) : Result({ _yay: page });
	if (chunks._nay) return chunks;
	return Result({ _yay: { chunks: chunks._yay, totalChunkCount, chunkBounds: bounds.buffer } });
}

async function db_input(ctx: MutationCtx, content: Doc<"files_move_cohort_content">, role: "staged" | "unstaged") {
	const id = role === "staged" ? content.acceptedTextInputId : content.unstagedTextInputId;
	if (!id) return null;
	const input = await ctx.db.get("files_pending_update_text_inputs", id);
	if (!input || input.cohortContentId !== content._id || input.role !== role)
		throw should_never_happen("Move lost its prepared text", { contentId: content._id, role });
	return input;
}

type StageStep = {
	// Each prepared text is read once per step, not once per page. `chunk_page` keeps its chunk bounds.
	inputs: Partial<Record<"staged" | "unstaged", ReturnType<typeof db_input>>>;
};

function content_shape(
	content: Doc<"files_move_cohort_content">,
	proposal: Doc<"files_pending_updates">,
	node: Doc<"files_nodes">,
) {
	const prepared = content.prepared!;
	if (prepared.kind === "replacement")
		return {
			rootKind: prepared.yjsRootKind ?? null,
			collaborationEnabled: prepared.yjsRootKind !== undefined ? !prepared.nonCollaborative : null,
			contentType: prepared.contentType,
		};
	if (prepared.kind === "private") {
		const intent = proposal.createIntent!;
		return {
			rootKind: intent.kind === "text" ? intent.textKind : null,
			collaborationEnabled: intent.kind === "text" ? intent.collaborationEnabled : null,
			contentType: intent.kind === "folder" ? null : intent.contentType,
		};
	}
	return { rootKind: node.textKind, collaborationEnabled: node.collaborationEnabled, contentType: node.contentType };
}

/**
 * One stage page. It reads at most one `.paginate()` page, the Convex limit per call, and then
 * reports `paged`.
 */
async function db_stage_page(ctx: MutationCtx, args: Context, step: StageStep) {
	const current = await db_current(ctx, args);
	if (current._nay) return current;
	const { content, cohort, proposal, item } = current._yay;
	if (content.sealed) return Result({ _yay: { done: true, paged: false } });
	if (!content.prepared) return Result({ _nay: { message: "This content is still preparing." } });
	const record = await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId);
	const node = await files_saved_placement_db_get_node(ctx.db, content.nodeId, { cohortId: cohort._id, view: "after" });
	if (!record?.afterPlaceId || !node) return Result({ _nay: { message: "The final saved header is not ready." } });
	const tag = { cohortId: cohort._id, view: "after" as const };
	const beforeTag = { cohortId: cohort._id, view: "before" as const };
	let phase = content.phase;
	let { part } = phase_cursor(content.phaseCursor);
	const { cursor } = phase_cursor(content.phaseCursor);
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId };
	const shape = content_shape(content, proposal, node);
	const prepared = content.prepared;
	const nextSequence =
		prepared.kind === "saved_yjs"
			? prepared.baseYjsSequence + (content.trustedStageId ? 1 : 0)
			: prepared.kind === "replacement"
				? (prepared.expectedYjsLastSequence?.lastSequence ?? 0)
				: 0;
	const input = (role: "staged" | "unstaged") => (step.inputs[role] ??= db_input(ctx, content, role));
	// Each probe below uses the same range as its page.
	const source_chunks = (table: "files_text_chunks" | "files_plain_text_chunks") =>
		ctx.db
			.query(table)
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("fileNodeId", content.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			);
	const source_updates = () =>
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("fileNodeId", content.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			);
	const pending_chunks = (table: "files_text_chunks" | "files_plain_text_chunks") =>
		ctx.db
			.query(table)
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			);
	const metadata_docs = (part: number) =>
		part === 0
			? ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", content.nodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
			: ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) =>
						q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
					);
	// Before the page, skip empty ranges and phases with nothing to write, so an empty range does not use
	// this call's one `.paginate()`. A cursor tail keeps its own page.
	while (cursor === null) {
		if (phase === "sources" && part < 2) {
			if (await source_chunks(part === 0 ? "files_text_chunks" : "files_plain_text_chunks").first()) break;
			part++;
		} else if (phase === "sources") {
			if (await source_updates().first()) break;
			phase = "text";
			part = 0;
		} else if ((phase === "text" || phase === "plain_text") && !((await input("staged")) && shape.rootKind))
			phase = "updates";
		// Only a saved Yjs edit copies updates.
		else if (phase === "updates" && prepared.kind !== "saved_yjs") phase = "pending_text";
		else if ((phase === "pending_text" || phase === "pending_plain_text") && part < 2) {
			if (await pending_chunks(part === 0 ? "files_text_chunks" : "files_plain_text_chunks").first()) break;
			part++;
		} else if (
			(phase === "pending_text" || phase === "pending_plain_text") &&
			!((await input("unstaged")) && shape.rootKind)
		) {
			phase = "metadata";
			part = 0;
		} else if (phase === "metadata" && part < 2) {
			if (await metadata_docs(part).first()) break;
			part++;
		} else break;
	}
	if (phase === "sources") {
		if (part < 2) {
			const table = part === 0 ? "files_text_chunks" : "files_plain_text_chunks";
			const page = await source_chunks(table).paginate({ cursor, numItems: PAGE_SIZE });
			for (const row of page.page) await ctx.db.patch(table, row._id, { moveView: beforeTag });
			return await db_progress(
				ctx,
				content,
				"sources",
				page.isDone ? part + 1 : part,
				page.isDone ? null : page.continueCursor,
				true,
			);
		}
		const page = await source_updates().paginate({ cursor, numItems: 1 });
		for (const row of page.page) await ctx.db.patch("files_yjs_updates", row._id, { moveView: beforeTag });
		return await db_progress(
			ctx,
			content,
			page.isDone ? "text" : "sources",
			page.isDone ? 0 : part,
			page.isDone ? null : page.continueCursor,
			true,
		);
	}
	if (phase === "text" || phase === "plain_text") {
		const staged = await input("staged");
		if (staged && shape.rootKind) {
			const chunks = await chunk_page(content, staged.text, shape.rootKind);
			if (chunks._nay) return chunks;
			const page = chunks._yay.chunks;
			await files_nodes_db_insert_committed_text_chunks(ctx, {
				...scope,
				nodeId: content.nodeId,
				path: node.path,
				archiveOperationId: node.archiveOperationId ?? undefined,
				yjsSequence: shape.collaborationEnabled ? nextSequence : undefined,
				chunks: page,
				moveView: tag,
				chunkCount: chunks._yay.totalChunkCount,
			});
			if (content.nextChunkIndex + page.length < chunks._yay.totalChunkCount)
				return await db_progress(
					ctx,
					content,
					"text",
					0,
					null,
					false,
					content.nextChunkIndex + page.length,
					chunks._yay.chunkBounds,
				);
		}
		return await db_progress(ctx, content, "updates", 0, null, false);
	}
	if (phase === "updates") {
		if (prepared.kind === "saved_yjs") {
			const page = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
						.eq("fileNodeId", content.nodeId)
						.eq("moveView.cohortId", cohort._id)
						.eq("moveView.view", "before")
						.gt("sequence", content.sourceSnapshotSequence!)
						.lte("sequence", prepared.baseYjsSequence),
				)
				.paginate({ cursor, numItems: 1 });
			for (const { _id: _id, _creationTime: _time, ...row } of page.page)
				await ctx.db.insert("files_yjs_updates", { ...row, moveView: tag });
			if (!page.isDone) return await db_progress(ctx, content, "updates", 0, page.continueCursor, true);
			if (content.trustedStageId) {
				const stage = await ctx.db.get("files_yjs_trusted_update_stages", content.trustedStageId);
				if (
					!stage ||
					stage.cohortContentId !== content._id ||
					!shape.rootKind ||
					stage.update.byteLength === 0 ||
					stage.update.byteLength > files_MAX_YJS_WIRE_BYTES
				)
					return Result({ _nay: { message: "The prepared update is no longer available." } });
				const scan = files_yjs_scan_client_update({ update: new Uint8Array(stage.update), rootKind: shape.rootKind });
				if (scan._nay) return Result({ _nay: { message: scan._nay.message } });
				await ctx.db.insert("files_yjs_updates", {
					...scope,
					fileNodeId: content.nodeId,
					sequence: nextSequence,
					moveView: tag,
					update: stage.update,
					origin: { type: "USER_EDIT", sessionId: `pending-accept:${cohort.userId}` },
					createdBy: cohort.userId,
					createdAt: cohort.operationTime,
				});
			}
		}
		return await db_progress(ctx, content, "pending_text", 0, null, prepared.kind === "saved_yjs");
	}
	if (phase === "pending_text" || phase === "pending_plain_text") {
		if (part < 2) {
			const table = part === 0 ? "files_text_chunks" : "files_plain_text_chunks";
			// The index is pendingUpdateId, moveView.cohortId, moveView.view, chunkIndex. Tagging sets
			// moveView, so a tagged chunk leaves this range at once, also for later reads in this
			// mutation. Each `take` from the start then gets the next untagged chunks, with no cursor.
			const rows = await pending_chunks(table).take(PAGE_SIZE);
			for (const row of rows) await ctx.db.patch(table, row._id, { moveView: beforeTag });
			return await db_progress(ctx, content, "pending_text", rows.length < PAGE_SIZE ? part + 1 : part, null, false);
		}
		const unstaged = await input("unstaged");
		if (unstaged && shape.rootKind) {
			const chunks = await chunk_page(content, unstaged.text, shape.rootKind);
			if (chunks._nay) return chunks;
			for (const chunk of chunks._yay.chunks) {
				const shared = {
					...scope,
					sourceKind: "pending" as const,
					userId: cohort.userId,
					target: { kind: "saved" as const, id: content.nodeId },
					pendingUpdateId: proposal._id,
					proposalRevision: proposal.revision + 1,
					chunkIndex: chunk.chunkIndex,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
					moveView: tag,
				};
				const textChunkId = await ctx.db.insert("files_text_chunks", { ...shared, textChunk: chunk.textChunk });
				await ctx.db.insert("files_plain_text_chunks", {
					...shared,
					textChunkId,
					textChunk: chunk.textChunk,
					plainTextChunk: chunk.plainTextChunk,
					path: node.path,
					archiveOperationId: node.archiveOperationId ?? undefined,
					hasChunkAbove: chunk.chunkIndex > 0,
					hasChunkBelow: chunk.chunkIndex < chunks._yay.totalChunkCount - 1,
				});
			}
			if (content.nextChunkIndex + PAGE_SIZE < chunks._yay.totalChunkCount)
				return await db_progress(
					ctx,
					content,
					"pending_text",
					part,
					null,
					false,
					content.nextChunkIndex + PAGE_SIZE,
					chunks._yay.chunkBounds,
				);
		}
		return await db_progress(ctx, content, "metadata", 0, null, false);
	}
	if (phase === "metadata") {
		if (part < 2) {
			// Tagging removes each doc from the range. Long field keys make native cursors too large to store.
			const page = await metadata_docs(part).paginate({
				cursor: null,
				numItems: PAGE_SIZE,
				maximumBytesRead: 1024 * 1024,
			});
			for (const original of page.page) {
				await ctx.db.patch("files_metadata_docs", original._id, { moveView: beforeTag });
				// Frontmatter is replaced. Metadata is bounded by its per-file write contract.
				if (
					original.fieldPath.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX) ||
					original.sourceKind !== "committed"
				)
					continue;
				const { _id: _id, _creationTime: _time, ...row } = original;
				await ctx.db.insert("files_metadata_docs", {
					...row,
					sourceKind: "committed",
					fileNodeId: content.nodeId,
					moveView: tag,
					path: node.path,
					treePath: node.treePath,
					archiveOperationId: node.archiveOperationId ?? undefined,
					...(row.docKind === "field"
						? {
								parentId: node.parentId,
								nodeKind: node.kind,
								name: node.name,
								sortName: files_sort_text_key(node.name),
								isRestrictedScopeRoot: node.restrictedScopeNodeId === node._id,
							}
						: {}),
				});
			}
			return await db_progress(ctx, content, "metadata", page.isDone ? part + 1 : part, null, true);
		}
		const accepted = await input("staged");
		const remainder = await input("unstaged");
		const afterProposal = db_after_proposal({ content, proposal, nextSequence, operationTime: cohort.operationTime });
		const docs = files_metadata_content_stage_docs({
			node: { ...node, textKind: shape.rootKind },
			metadata:
				prepared.kind === "private"
					? (await files_metadata_maps_db_read(ctx.db, { kind: "pending", id: proposal._id }))?.entries
					: undefined,
			yjsSequence: shape.collaborationEnabled ? nextSequence : undefined,
			text: accepted?.text,
			pending: afterProposal ? { proposalId: proposal._id, proposal: afterProposal, text: remainder?.text } : undefined,
		});
		for (const row of docs.slice(content.nextChunkIndex, content.nextChunkIndex + PAGE_SIZE))
			await ctx.db.insert("files_metadata_docs", { ...row, moveView: tag });
		if (content.nextChunkIndex + PAGE_SIZE < docs.length)
			return await db_progress(ctx, content, "metadata", part, null, false, content.nextChunkIndex + PAGE_SIZE);
		await ctx.db.patch("files_move_cohort_items", item._id, { afterProposal });
		return await db_progress(ctx, content, "seal", 0, null, false);
	}
	return await db_seal(ctx, { content, cohort, proposal, node, afterPlaceId: record.afterPlaceId });
}

/**
 * Stage pages until a transaction limit is near. A `.paginate()` page ends the step. Root schedules the
 * next call and owns the view switch.
 */
export async function files_move_content_db_stage(ctx: MutationCtx, args: Context) {
	const step: StageStep = { inputs: {} };
	for (let pages = 1; ; pages++) {
		const staged = await db_stage_page(ctx, args, step);
		if (
			staged._nay ||
			staged._yay.done ||
			staged._yay.paged ||
			pages >= STEP_MAX_PAGES ||
			// Root ends the transaction after a stage step, so the step may use most of each limit. The
			// smaller join budget would stop a big text early: its first page reads the whole text.
			(await files_subtree_ops_db_is_near_limits(ctx))
		)
			return staged;
	}
}

export const advance_stage = internalMutation({
	args: {
		cohortId: v.id("files_move_cohorts"),
		step: v.number(),
		runGeneration: v.union(v.number(), v.null()),
		join: v.boolean(),
		contentId: v.id("files_move_cohort_content"),
		fence: v.number(),
		attemptFence: v.number(),
		preparationFence: v.number(),
	},
	returns: v.union(
		v.null(),
		v.object({ kind: v.literal("next"), step: v.number() }),
		v.object({ kind: v.literal("complete") }),
	),
	handler: async (ctx, args) => {
		const { contentId, fence, attemptFence, preparationFence, ...current } = args;
		const result = await files_move_cohorts_db_advance(
			ctx,
			{ ...current, stage: { contentId, fence, attemptFence, preparationFence } },
			16,
			files_move_content_db_stage,
		);
		if (!result || result.kind === "next" || result.kind === "complete") return result ?? null;
		throw should_never_happen("Move stage returned another content request", {
			cohortId: args.cohortId,
			kind: result.kind,
		});
	},
});

function db_after_proposal(args: {
	content: Doc<"files_move_cohort_content">;
	proposal: Doc<"files_pending_updates">;
	nextSequence: number;
	operationTime: number;
}) {
	const { content, proposal, nextSequence } = args;
	const prepared = content.prepared!;
	const family = content.partialFamily;
	const unchanged = prepared.kind === "saved_asset" && prepared.unchanged;
	if (!family && !unchanged) return null;
	const { _id: _id, _creationTime: _time, moveCohortId: _cohortId, ...header } = proposal;
	return {
		...header,
		target: { kind: "saved" as const, id: content.nodeId },
		revision: proposal.revision + 1,
		createIntent: undefined,
		preparation: undefined,
		pendingMove: undefined,
		pendingArchive: undefined,
		pendingReplacement: undefined,
		copiedFrom: undefined,
		contentNeedsRebase: undefined,
		contentRebaseRootKind: undefined,
		content: family
			? {
					base:
						prepared.kind === "saved_yjs"
							? { kind: "yjs" as const, sequence: nextSequence, lineageGeneration: prepared.baseLineageGeneration }
							: content.afterYjsSnapshotAssetId
								? { kind: "yjs" as const, sequence: 0, lineageGeneration: 0 }
								: { kind: "asset" as const, assetId: content.afterAssetId! },
					baseStateId: family.baseStateId,
					stagedStateId: family.stagedStateId,
					unstagedStateId: family.unstagedStateId,
				}
			: proposal.content,
		updatedAt: args.operationTime,
	};
}

async function db_seal(
	ctx: MutationCtx,
	args: {
		content: Doc<"files_move_cohort_content">;
		cohort: Doc<"files_move_cohorts">;
		proposal: Doc<"files_pending_updates">;
		node: Doc<"files_nodes">;
		afterPlaceId: Id<"files_saved_places">;
	},
) {
	const { content, cohort, proposal, node } = args;
	const prepared = content.prepared!;
	const shape = content_shape(content, proposal, node);
	const accepted = await db_input(ctx, content, "staged");
	const remainder = await db_input(ctx, content, "unstaged");
	const changed = node.kind === "file" && changes_saved_content(prepared);
	const unchanged = (prepared.kind === "saved_yjs" || prepared.kind === "saved_asset") && !changed;
	// A review with no content change keeps the existing assets and content head.
	const original = unchanged ? await ctx.db.get("files_nodes", content.nodeId) : null;
	if (unchanged && !original)
		throw should_never_happen("Unchanged Save lost its saved file", { contentId: content._id });
	const originalSnapshot = original?.yjsSnapshotId
		? await ctx.db.get("files_yjs_snapshots", original.yjsSnapshotId)
		: null;
	let assetId =
		content.afterAssetId ??
		(prepared.kind === "replacement"
			? prepared.contentAssetId
			: prepared.kind === "private" && proposal.createIntent?.kind === "stored"
				? proposal.createIntent.assetId
				: node.assetId);
	let snapshotAssetId =
		originalSnapshot?.assetId ??
		content.afterYjsSnapshotAssetId ??
		(prepared.kind === "replacement" ? prepared.yjsSnapshot?.assetId : null) ??
		null;
	const size = original
		? original.contentByteSize
		: accepted
			? files_get_utf8_byte_size(accepted.text)
			: prepared.kind === "replacement"
				? prepared.contentSize
				: prepared.kind === "private" && proposal.createIntent?.kind === "stored"
					? proposal.createIntent.size
					: node.contentByteSize;
	const storedUpload = changed && !shape.rootKind;
	const costCents =
		!changed || node.kind !== "file" ? 0 : shape.rootKind ? 1 : files_stored_uploads_cost_cents(size ?? 0);
	const storedByteDelta = storedUpload ? (size ?? 0) : 0;
	if (storedUpload) {
		const organization = (await ctx.db.get("organizations", cohort.organizationId))!;
		const admitted = await files_stored_uploads_db_admit(ctx, {
			organization,
			actorUserId: cohort.userId,
			workspaceId: cohort.workspaceId,
			billedUserId: cohort.billedUserId,
			declaredBytes: [storedByteDelta],
		});
		if (admitted._nay) return admitted;
	}
	let afterSequence: Doc<"files_move_cohort_content">["afterSequence"] = null;
	if (shape.collaborationEnabled) {
		if (!snapshotAssetId) return Result({ _nay: { message: "The accepted snapshot is not ready." } });
		if (original) {
			const head = original.yjsLastSequenceId
				? await ctx.db.get("files_yjs_docs_last_sequences", original.yjsLastSequenceId)
				: null;
			if (!head) throw should_never_happen("Unchanged Save lost its sequence head", { contentId: content._id });
			afterSequence = {
				lastSequenceId: head._id,
				lastSequence: head.lastSequence,
				lineageGeneration: head.lineageGeneration,
				unmaterializedUpdateCount: head.unmaterializedUpdateCount,
				unmaterializedUpdateBytes: head.unmaterializedUpdateBytes,
			};
		} else if (prepared.kind === "saved_yjs")
			afterSequence = {
				lastSequenceId: prepared.expectedYjsLastSequenceId,
				lastSequence: prepared.baseYjsSequence + (content.trustedStageId ? 1 : 0),
				lineageGeneration: prepared.baseLineageGeneration,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
			};
		else {
			const old =
				prepared.kind === "replacement" && prepared.expectedYjsLastSequence
					? await ctx.db.get("files_yjs_docs_last_sequences", prepared.expectedYjsLastSequence.id)
					: null;
			const lastSequence = old?.lastSequence ?? 0;
			const lineageGeneration = old ? old.lineageGeneration + 1 : 0;
			const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				moveView: { cohortId: cohort._id, view: "after" },
				organizationId: cohort.organizationId,
				workspaceId: cohort.workspaceId,
				fileNodeId: content.nodeId,
				lastSequence,
				lineageGeneration,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
			});
			afterSequence = {
				lastSequenceId,
				lastSequence,
				lineageGeneration,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
			};
		}
	}
	let afterSnapshotId: Id<"files_yjs_snapshots"> | null = original?.yjsSnapshotId ?? null;
	if (!original && afterSequence && snapshotAssetId)
		afterSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
			moveView: { cohortId: cohort._id, view: "after" },
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			fileNodeId: content.nodeId,
			sequence: afterSequence.lastSequence,
			assetId: snapshotAssetId,
			createdBy: cohort.userId,
			updatedBy: cohort.userId,
			updatedAt: cohort.operationTime,
		});
	const afterStatsId = original
		? original.statsId
		: node.kind === "file"
			? await ctx.db.insert("file_stats", {
					moveView: { cohortId: cohort._id, view: "after" },
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					fileNodeId: content.nodeId,
					...(accepted ? files_compute_wc_counts(accepted.text) : { lineCount: -1, wordCount: -1, charCount: -1 }),
				})
			: null;
	for (const id of [assetId, snapshotAssetId]) {
		if (!id) continue;
		const asset = await ctx.db.get("files_r2_assets", id);
		const claim = await ctx.db
			.query("files_move_asset_claims")
			.withIndex("by_asset", (q) => q.eq("assetId", id))
			.first();
		if (
			!asset ||
			asset.organizationId !== cohort.organizationId ||
			asset.workspaceId !== cohort.workspaceId ||
			claim?.cohortId !== cohort._id
		)
			throw should_never_happen("Accepted Move asset has no claim", { contentId: content._id, assetId: id });
	}
	const afterContentVersion = afterSequence
		? {
				kind: "yjs" as const,
				lastSequenceId: afterSequence.lastSequenceId,
				lineageGeneration: afterSequence.lineageGeneration,
				sequence: afterSequence.lastSequence,
				contentType: shape.contentType!,
				textKind: shape.rootKind!,
				collaborationEnabled: true as const,
			}
		: assetId
			? {
					kind: "asset" as const,
					assetId,
					contentType: shape.contentType!,
					textKind: shape.rootKind,
					collaborationEnabled: shape.rootKind ? (false as const) : null,
				}
			: null;
	const previousAsset = prepared.kind === "replacement" ? (prepared.backup?.assetId ?? node.assetId) : null;
	const previous = previousAsset ? await ctx.db.get("files_r2_assets", previousAsset) : null;
	const previousVersion =
		previousAsset && previous
			? {
					assetId: previousAsset,
					size: prepared.kind === "replacement" ? (prepared.backup?.size ?? previous.size) : previous.size,
					contentType: node.contentType!,
					yjsRootKind: node.textKind,
					collaborationEnabled: node.collaborationEnabled === true,
				}
			: null;
	const acceptedVersion =
		changed && assetId
			? {
					assetId,
					size: size!,
					contentType: shape.contentType!,
					yjsRootKind: shape.rootKind,
					collaborationEnabled: shape.collaborationEnabled === true,
				}
			: null;
	await ctx.db.patch("files_saved_places", args.afterPlaceId, {
		contentId: content._id,
		assetId,
		contentType: shape.contentType,
		...files_content_type_index_fields(shape.contentType),
		textKind: shape.rootKind,
		collaborationEnabled: shape.collaborationEnabled,
		contentByteSize: size,
		yjsSnapshotId: afterSnapshotId,
		yjsLastSequenceId: afterSequence?.lastSequenceId ?? null,
		statsId: afterStatsId,
		contentTooLargeByteSize: original?.contentTooLargeByteSize ?? null,
		contentShapeMismatchAt: original?.contentShapeMismatchAt ?? null,
		contentYjsStateTooLargeByteSize: original?.contentYjsStateTooLargeByteSize ?? null,
		contentFrontmatterTooLargeFieldCount: original?.contentFrontmatterTooLargeFieldCount ?? null,
		contentFrontmatterTooLargeIndexDocumentCount: original?.contentFrontmatterTooLargeIndexDocumentCount ?? null,
		// Only new content changes the modified time. A Move of the same file keeps it.
		...(changed ? { updatedAt: cohort.operationTime, updatedBy: cohort.userId } : {}),
	});
	await ctx.db.patch("files_move_cohort_content", content._id, {
		phase: "sealed",
		phaseCursor: null,
		nextChunkIndex: 0,
		sealed: true,
		afterAssetId: assetId,
		afterYjsSnapshotAssetId: snapshotAssetId,
		afterSnapshotId,
		afterStatsId,
		afterSequence,
		nextSequence: afterSequence?.lastSequence ?? null,
		afterContentVersion,
		previousVersion,
		acceptedVersion,
		costCents,
	});
	const afterProposal = db_after_proposal({
		content: { ...content, afterAssetId: assetId },
		proposal,
		nextSequence: afterSequence?.lastSequence ?? 0,
		operationTime: cohort.operationTime,
	});
	await db_add_private_accounting(ctx, {
		content,
		cohort,
		proposal,
		afterProposal,
		storedByteDelta,
		storedUpload,
		costCents,
	});
	await ctx.db.patch("files_move_cohort_items", content.itemId, {
		afterProposal:
			afterProposal && remainder ? { ...afterProposal, size: files_get_utf8_byte_size(remainder.text) } : afterProposal,
	});
	return Result({ _yay: { done: true, paged: false } });
}

async function db_add_private_accounting(
	ctx: MutationCtx,
	args: {
		content: Doc<"files_move_cohort_content">;
		cohort: Doc<"files_move_cohorts">;
		proposal: Doc<"files_pending_updates">;
		afterProposal: WithoutSystemFields<Doc<"files_pending_updates">> | null;
		storedByteDelta: number;
		storedUpload: boolean;
		costCents: number;
	},
) {
	const { content, cohort, proposal, afterProposal } = args;
	if (content.privateAccountingAdded) return;
	let privateByteDelta = 0;
	let privateNodeDelta = 0;
	const retained = retained_state_ids(afterProposal);
	for (const resource of consumed_resources(proposal, retained)) {
		const reservation = await db_reservation(ctx, resource);
		if (!reservation || reservation.settlement.kind !== "held" || reservation.cohortContentId)
			throw should_never_happen("Move lost an original private hold", { contentId: content._id, resource });
		if (resource.kind === "node") privateNodeDelta--;
		else privateByteDelta -= reservation.byteCount;
	}
	for (const id of retained) {
		const reservation = await db_reservation(ctx, { kind: "state", id });
		if (!reservation || reservation.settlement.kind !== "held")
			throw should_never_happen("Move lost its partial state hold", { contentId: content._id, id });
		if (reservation.cohortContentId === content._id) privateByteDelta += reservation.byteCount;
	}
	await ctx.db.patch("files_move_cohort_content", content._id, {
		privateByteDelta,
		privateNodeDelta,
		privateAccountingAdded: true,
		storedByteDelta: args.storedByteDelta,
		storedUpload: args.storedUpload,
	});
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		privateByteDelta: cohort.privateByteDelta + privateByteDelta,
		privateNodeDelta: cohort.privateNodeDelta + privateNodeDelta,
		storedByteDelta: cohort.storedByteDelta + args.storedByteDelta,
		storedFileCount: cohort.storedFileCount + (args.storedUpload ? 1 : 0),
		contentCostCents: cohort.contentCostCents + args.costCents,
	});
}
