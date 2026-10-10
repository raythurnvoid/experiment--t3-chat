import { Result } from "common/errors-as-values-utils.ts";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_node, access_control_db_authorize_membership } from "./access_control.ts";
import { files_nodes_db_get_content_version, files_nodes_db_require_user_writable } from "./files_nodes.ts";
import { files_pending_nodes_db_get_ancestry } from "./files_pending_nodes.ts";
import {
	files_pending_updates_action_prepare_content,
	files_pending_updates_db_get_cohort_content,
	type files_pending_updates_CohortContentContext,
} from "./files_pending_updates.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { files_compute_wc_counts, files_nodes_db_insert_committed_text_chunks } from "./files_nodes_create_db.ts";
import { files_metadata_content_stage_docs } from "./files_metadata.ts";
import { files_stored_uploads_cost_cents, files_stored_uploads_db_admit } from "./files_stored_uploads.ts";
import { files_media_dependencies_db_retire } from "./files_media_dependencies.ts";
import { billing_db_check_paid_plan, billing_db_emit_file_save, billing_db_emit_file_upload } from "./billing_db.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	files_private_storage_db_release,
	files_private_storage_db_release_deleted_resource,
	files_private_storage_db_set_cohort_owner,
} from "./files_private_storage.ts";
import { r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_client.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_move_reservations_db_enter } from "../server/files-move-reservations.ts";
import { files_pending_overlay_db_set_cohort_materialization } from "../server/files-pending-overlay.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { files_yjs_scan_client_update } from "../shared/files-yjs.ts";
import {
	files_content_type_index_fields,
	files_get_utf8_byte_size,
	files_MAX_YJS_WIRE_BYTES,
} from "../shared/files.ts";
import { files_metadata_FRONTMATTER_FIELD_PREFIX } from "../shared/files-metadata.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { quotas } from "../shared/quotas.ts";

type Context = Omit<files_pending_updates_CohortContentContext, "preparationFence">;
const PAGE_SIZE = 8;

async function db_current(ctx: MutationCtx, args: Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (!content) return Result({ _nay: { message: "Not found" } });
	const current = await files_pending_updates_db_get_cohort_content(ctx, {
		...args,
		preparationFence: content.preparationFence,
	});
	if (current._nay) return current;
	const entered = await files_move_reservations_db_enter(ctx, { ...args, mode: "stage" });
	return entered._nay ? entered : current;
}

/**
 * Create one candidate after root has reserved the reviewed item and its final saved header.
 */
export async function files_move_content_db_create(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; itemId: Id<"files_move_cohort_items">; nodeId: Id<"files_nodes"> },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const item = await ctx.db.get("files_move_cohort_items", args.itemId);
	if (
		!cohort ||
		cohort.phase !== "staging" ||
		cohort.visibleView !== "before" ||
		!item ||
		item.cohortId !== cohort._id ||
		!item.pendingUpdateId ||
		item.reviewedRevision === null
	)
		return Result({ _nay: { message: "This Move step is no longer current." } });
	const membership = await organizations_db_get_membership(ctx, {
		membershipId: cohort.membershipId,
		userId: cohort.userId,
	});
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, cohort);
	if (
		!membership ||
		!lifetime?.active ||
		lifetime.membershipId !== membership._id ||
		lifetime.lifetime !== cohort.membershipLifetime
	)
		return Result({ _nay: { message: "Unauthorized" } });
	const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
	const record = await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId);
	if (
		!proposal ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.userId !== cohort.userId ||
		proposal.revision !== item.reviewedRevision ||
		proposal.target.kind !== item.target.kind ||
		proposal.target.id !== item.target.id ||
		!record ||
		record.cohortId !== cohort._id ||
		record.nodeId !== args.nodeId
	)
		return Result({ _nay: { name: "target_changed", message: "The proposal changed after it was reviewed." } });
	let before: Doc<"files_nodes"> | null = null;
	if (item.target.kind === "saved") {
		const access = await access_control_db_authorize_node(ctx, {
			membership,
			userAuth: { id: cohort.userId },
			nodeId: item.target.id,
			permission: "content.write",
		});
		if (access._nay) return access;
		before = access._yay.fileNode;
		const writable = await files_nodes_db_require_user_writable(ctx, { node: before, userId: cohort.userId });
		if (writable._nay) return writable;
		if (
			!files_transfer_source_versions_equal(
				await files_nodes_db_get_content_version(ctx, before),
				record.sourceContentVersion,
			)
		)
			return Result({ _nay: { name: "target_changed", message: "The file changed after it was reviewed." } });
	} else {
		const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...cohort, privateNodeId: item.target.id });
		if (ancestry._nay) return ancestry;
		const parent = ancestry._yay.savedParent;
		const access = await access_control_db_authorize_membership(ctx, {
			membership,
			userAuth: { id: cohort.userId },
			permission: "content.write",
			fileNode: parent ?? undefined,
		});
		if (access._nay) return access;
		if (
			!item.privateVersion ||
			ancestry._yay.node.creationGeneration !== item.privateVersion.creationGeneration ||
			ancestry._yay.node.structuralRevision !== item.privateVersion.structuralRevision
		)
			return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again." } });
	}
	if (item.contentId) return Result({ _yay: item.contentId });
	const entered = await files_move_reservations_db_enter(ctx, {
		cohortId: cohort._id,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
		mode: "stage",
	});
	if (entered._nay) return entered;
	const contentId = await ctx.db.insert("files_move_cohort_content", {
		cohortId: cohort._id,
		itemId: item._id,
		nodeId: args.nodeId,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
		selectedContentStateId: item.selectedContentStateId,
		prepared: null,
		operationBatchId: null,
		phase: "preparing",
		phaseCursor: null,
		nextChunkIndex: 0,
		acceptedTextInputId: null,
		unstagedTextInputId: null,
		acceptedTextDigest: null,
		sourceSnapshotSequence: null,
		afterYjsSnapshotAssetId: null,
		preparationFence: 0,
		storageBytes: 0,
		storageResourceCount: 0,
		privateByteDelta: 0,
		privateNodeDelta: 0,
		privateAccountingAdded: false,
		storedByteDelta: 0,
		storedUpload: false,
		previousVersion: null,
		acceptedVersion: null,
		previousVersionSnapshotId: null,
		acceptedVersionSnapshotId: null,
		beforeContentVersion: record.sourceContentVersion,
		afterContentVersion: null,
		afterSnapshotId: null,
		afterStatsId: null,
		afterAssetId: null,
		trustedStageId: null,
		nextSequence: null,
		partialFamily: null,
		sealed: false,
		proofEpoch: cohort.proofEpoch,
		costCents: 0,
		afterSequence: null,
		mediaProof: null,
		preparedMediaSet: null,
	});
	await ctx.db.patch("files_move_cohort_items", item._id, { contentId });
	const snapshot = before?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", before.yjsSnapshotId) : null;
	const storedAssetId = proposal.createIntent?.kind === "stored" ? proposal.createIntent.assetId : null;
	for (const assetId of [before?.assetId, snapshot?.assetId, proposal.pendingReplacement?.assetId, storedAssetId]) {
		if (!assetId) continue;
		const claim = await ctx.db
			.query("files_move_asset_claims")
			.withIndex("by_asset", (q) => q.eq("assetId", assetId))
			.first();
		if (claim && claim.cohortId !== cohort._id)
			throw should_never_happen("Reserved Move asset has another owner", { assetId });
		if (!claim) await ctx.db.insert("files_move_asset_claims", { cohortId: cohort._id, assetId });
	}
	return Result({ _yay: contentId });
}

export async function files_move_content_action_prepare(ctx: ActionCtx, args: Context) {
	const begun = await ctx.runMutation(internal.files_pending_updates.begin_cohort_content_preparation, args);
	if (begun._nay) return begun;
	if (begun._yay.done) return Result({ _yay: null });
	const cohortContent = { ...args, preparationFence: begun._yay.preparationFence };
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

function phase_cursor(value: string | null) {
	if (!value) return { part: 0, cursor: null as string | null };
	const separator = value.indexOf("|");
	return { part: Number(value.slice(0, separator)), cursor: value.slice(separator + 1) || null };
}

async function db_progress(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	phase: Doc<"files_move_cohort_content">["phase"],
	part: number,
	cursor: string | null,
	nextChunkIndex = 0,
) {
	await ctx.db.patch("files_move_cohort_content", content._id, {
		phase,
		phaseCursor: `${part}|${cursor ?? ""}`,
		nextChunkIndex,
	});
	return Result({ _yay: { done: false } });
}

async function db_input(ctx: MutationCtx, content: Doc<"files_move_cohort_content">, role: "staged" | "unstaged") {
	const id = role === "staged" ? content.acceptedTextInputId : content.unstagedTextInputId;
	if (!id) return null;
	const input = await ctx.db.get("files_pending_update_text_inputs", id);
	if (!input || input.cohortContentId !== content._id || input.role !== role)
		throw should_never_happen("Move lost its prepared text", { contentId: content._id, role });
	return input;
}

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

function changes_saved_content(prepared: NonNullable<Doc<"files_move_cohort_content">["prepared"]>) {
	return prepared.kind === "saved_yjs"
		? !!prepared.trustedStageId
		: prepared.kind === "saved_asset"
			? !!prepared.publish
			: true;
}

/**
 * One native page. Root schedules the next call and owns the view switch.
 */
export async function files_move_content_db_stage(ctx: MutationCtx, args: Context) {
	const current = await db_current(ctx, args);
	if (current._nay) return current;
	const { content, cohort, proposal, item } = current._yay;
	if (content.sealed) return Result({ _yay: { done: true } });
	if (!content.prepared) return Result({ _nay: { message: "This content is still preparing." } });
	const record = await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId);
	const node = await files_saved_placement_db_get_node(ctx.db, content.nodeId, { cohortId: cohort._id, view: "after" });
	if (!record?.afterPlaceId || !node) return Result({ _nay: { message: "The final saved header is not ready." } });
	const tag = { cohortId: cohort._id, view: "after" as const };
	const beforeTag = { cohortId: cohort._id, view: "before" as const };
	const { part, cursor } = phase_cursor(content.phaseCursor);
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId };
	const shape = content_shape(content, proposal, node);
	const prepared = content.prepared;
	const nextSequence =
		prepared.kind === "saved_yjs"
			? prepared.baseYjsSequence + (content.trustedStageId ? 1 : 0)
			: prepared.kind === "replacement"
				? (prepared.expectedYjsLastSequence?.lastSequence ?? 0)
				: 0;
	if (content.phase === "sources") {
		if (part < 2) {
			const table = part === 0 ? "files_text_chunks" : "files_plain_text_chunks";
			const page = await ctx.db
				.query(table)
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
						.eq("fileNodeId", content.nodeId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.paginate({ cursor, numItems: PAGE_SIZE });
			for (const row of page.page) await ctx.db.patch(table, row._id, { moveView: beforeTag });
			return await db_progress(
				ctx,
				content,
				"sources",
				page.isDone ? part + 1 : part,
				page.isDone ? null : page.continueCursor,
			);
		}
		const page = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("fileNodeId", content.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.paginate({ cursor, numItems: 1 });
		for (const row of page.page) await ctx.db.patch("files_yjs_updates", row._id, { moveView: beforeTag });
		return await db_progress(
			ctx,
			content,
			page.isDone ? "text" : "sources",
			page.isDone ? 0 : part,
			page.isDone ? null : page.continueCursor,
		);
	}
	if (content.phase === "text" || content.phase === "plain_text") {
		const input = await db_input(ctx, content, "staged");
		if (input && shape.rootKind) {
			const chunks =
				shape.rootKind === "rich_text"
					? await files_chunk_markdown(input.text)
					: Result({ _yay: files_chunk_plain_text(input.text) });
			if (chunks._nay) return chunks;
			const page = chunks._yay.slice(content.nextChunkIndex, content.nextChunkIndex + PAGE_SIZE);
			await files_nodes_db_insert_committed_text_chunks(ctx, {
				...scope,
				nodeId: content.nodeId,
				path: node.path,
				archiveOperationId: node.archiveOperationId ?? undefined,
				yjsSequence: shape.collaborationEnabled ? nextSequence : undefined,
				chunks: page,
				moveView: tag,
				chunkCount: chunks._yay.length,
			});
			if (content.nextChunkIndex + page.length < chunks._yay.length)
				return await db_progress(ctx, content, "text", 0, null, content.nextChunkIndex + page.length);
		}
		return await db_progress(ctx, content, "updates", 0, null);
	}
	if (content.phase === "updates") {
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
			if (!page.isDone) return await db_progress(ctx, content, "updates", 0, page.continueCursor);
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
		return await db_progress(ctx, content, "pending_text", 0, null);
	}
	if (content.phase === "pending_text" || content.phase === "pending_plain_text") {
		if (part < 2) {
			const table = part === 0 ? "files_text_chunks" : "files_plain_text_chunks";
			const page = await ctx.db
				.query(table)
				.withIndex("by_pendingUpdate_chunkIndex", (q) =>
					q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
				)
				.paginate({ cursor, numItems: PAGE_SIZE });
			for (const row of page.page) await ctx.db.patch(table, row._id, { moveView: beforeTag });
			return await db_progress(
				ctx,
				content,
				"pending_text",
				page.isDone ? part + 1 : part,
				page.isDone ? null : page.continueCursor,
			);
		}
		const input = await db_input(ctx, content, "unstaged");
		if (input && shape.rootKind) {
			const chunks =
				shape.rootKind === "rich_text"
					? await files_chunk_markdown(input.text)
					: Result({ _yay: files_chunk_plain_text(input.text) });
			if (chunks._nay) return chunks;
			for (const chunk of chunks._yay.slice(content.nextChunkIndex, content.nextChunkIndex + PAGE_SIZE)) {
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
					hasChunkBelow: chunk.chunkIndex < chunks._yay.length - 1,
				});
			}
			if (content.nextChunkIndex + PAGE_SIZE < chunks._yay.length)
				return await db_progress(ctx, content, "pending_text", part, null, content.nextChunkIndex + PAGE_SIZE);
		}
		return await db_progress(ctx, content, "metadata", 0, null);
	}
	if (content.phase === "metadata") {
		if (part < 2) {
			const query =
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
			// Tagging removes each doc from the range. Long field keys make native cursors too large to store.
			const page = await query.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
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
			return await db_progress(
				ctx,
				content,
				"metadata",
				page.isDone ? part + 1 : part,
				null,
			);
		}
		const accepted = await db_input(ctx, content, "staged");
		const remainder = await db_input(ctx, content, "unstaged");
		const afterProposal = db_after_proposal({ content, proposal, nextSequence, operationTime: cohort.operationTime });
		const docs = files_metadata_content_stage_docs({
			node: { ...node, textKind: shape.rootKind },
			metadata: prepared.kind === "private" ? proposal.createIntent?.metadata : undefined,
			yjsSequence: shape.collaborationEnabled ? nextSequence : undefined,
			text: accepted?.text,
			pending: afterProposal ? { proposalId: proposal._id, proposal: afterProposal, text: remainder?.text } : undefined,
		});
		for (const row of docs.slice(content.nextChunkIndex, content.nextChunkIndex + PAGE_SIZE))
			await ctx.db.insert("files_metadata_docs", { ...row, moveView: tag });
		if (content.nextChunkIndex + PAGE_SIZE < docs.length)
			return await db_progress(ctx, content, "metadata", part, null, content.nextChunkIndex + PAGE_SIZE);
		await ctx.db.patch("files_move_cohort_items", item._id, { afterProposal });
		return await db_progress(ctx, content, "seal", 0, null);
	}
	return await db_seal(ctx, { content, cohort, proposal, node, afterPlaceId: record.afterPlaceId });
}

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
		...(original &&
		original.path === node.path &&
		original.parentId === node.parentId &&
		original.name === node.name &&
		original.archiveOperationId === node.archiveOperationId &&
		original.restrictedScopeNodeId === node.restrictedScopeNodeId
			? { updatedAt: original.updatedAt, updatedBy: original.updatedBy }
			: {}),
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
	return Result({ _yay: { done: true } });
}

function retained_state_ids(proposal: WithoutSystemFields<Doc<"files_pending_updates">> | null) {
	return new Set(
		proposal?.content
			? [proposal.content.baseStateId, proposal.content.stagedStateId, proposal.content.unstagedStateId]
			: [],
	);
}

function consumed_resources(
	proposal: Doc<"files_pending_updates">,
	retained: Set<Id<"files_pending_update_yjs_states">>,
) {
	const resources: Doc<"files_private_storage_reservations">["resource"][] = [];
	if (proposal.content)
		for (const id of [proposal.content.baseStateId, proposal.content.stagedStateId, proposal.content.unstagedStateId]) {
			if (!retained.has(id)) resources.push({ kind: "state", id });
		}
	// One proposal owns at most three states, one replacement, and one private create.
	for (const id of new Set([
		proposal.pendingReplacement?.assetId,
		proposal.createIntent?.kind === "stored" ? proposal.createIntent.assetId : undefined,
	])) {
		if (id) resources.push({ kind: "asset", id, r2Key: "" });
	}
	if (proposal.target.kind === "private") resources.push({ kind: "node", id: proposal.target.id });
	return resources;
}

async function db_reservation(
	ctx: MutationCtx,
	resource: Pick<Doc<"files_private_storage_reservations">["resource"], "kind" | "id">,
) {
	return await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", resource.kind).eq("resource.id", resource.id))
		.unique();
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

/**
 * Root calls this in the view-switch mutation. No candidate loop runs at publication.
 */
export async function files_move_content_db_publish_accounting(ctx: MutationCtx, args: Omit<Context, "contentId">) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort || cohort.fence !== args.fence || cohort.attemptFence !== args.attemptFence)
		return Result({ _nay: { message: "This Move step is no longer current." } });
	if (cohort.privateAccountingApplied) return Result({ _yay: null });
	if (cohort.visibleView !== "before" || cohort.phase !== "ready")
		return Result({ _nay: { message: "This Move is not ready to publish." } });
	const now = Date.now();
	const balances: { quota: Doc<"quotas">; delta: number }[] = [];
	if (cohort.storedFileCount > 0) {
		if (!(await billing_db_check_paid_plan(ctx, { userId: cohort.billedUserId })).hasPaidPlan)
			return Result({
				_nay: { name: "plan_required", message: "This workspace's plan does not include file uploads" },
			});
		const id = await quotas_db_ensure(ctx, {
			quotaName: "stored_file_bytes",
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			now,
		});
		const quota = (await ctx.db.get("quotas", id))!;
		if (quota.usedCount + cohort.storedByteDelta > quota.maxCount)
			return Result({ _nay: { name: "storage_full", message: quotas.stored_file_bytes.disabledReason } });
		balances.push({ quota, delta: cohort.storedByteDelta });
	}
	for (const quotaName of [
		"files_private_user_bytes",
		"files_private_workspace_bytes",
		"files_private_nodes",
	] as const) {
		const id = await quotas_db_ensure(ctx, {
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			...(quotaName === "files_private_workspace_bytes" ? { quotaName } : { quotaName, userId: cohort.userId }),
			now,
		});
		const quota = (await ctx.db.get("quotas", id))!;
		const delta = quotaName === "files_private_nodes" ? cohort.privateNodeDelta : cohort.privateByteDelta;
		if (quota.usedCount + delta < 0)
			throw should_never_happen("Invalid Move private balance", { cohortId: cohort._id, quotaName });
		if (delta > 0 && quota.usedCount + delta > quota.maxCount)
			return Result({ _nay: { name: "storage_full", message: quotas[quotaName].disabledReason } });
		balances.push({ quota, delta });
	}
	for (const { quota, delta } of balances)
		await ctx.db.patch("quotas", quota._id, { usedCount: quota.usedCount + delta, updatedAt: now });
	await ctx.db.patch("files_move_cohorts", cohort._id, { privateAccountingApplied: true });
	return Result({ _yay: null });
}

/**
 * Move one owned side page back to normal, or remove the side that lost the switch.
 */
async function db_cleanup_page(ctx: MutationCtx, content: Doc<"files_move_cohort_content">, mode: "finish" | "abort") {
	const marker = `${mode}:`;
	const progress = content.phaseCursor?.startsWith(marker) ? content.phaseCursor.slice(marker.length) : null;
	if (progress === "done") return true;
	const { part } = phase_cursor(progress);
	if (part >= 14) return true;
	const kind = Math.floor(part / 2);
	const view = part % 2 === 0 ? "before" : "after";
	const remove = mode === "finish" ? view === "before" : view === "after";
	const cohort = (await ctx.db.get("files_move_cohorts", content.cohortId))!;
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId };
	const table =
		kind === 0 || kind === 4
			? "files_text_chunks"
			: kind === 1 || kind === 5
				? "files_plain_text_chunks"
				: kind === 2
					? "files_yjs_updates"
					: "files_metadata_docs";
	const query =
		kind === 0 || kind === 1
			? ctx.db
					.query(table as "files_text_chunks" | "files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("fileNodeId", content.nodeId)
							.eq("moveView.cohortId", content.cohortId)
							.eq("moveView.view", view),
					)
			: kind === 2
				? ctx.db
						.query("files_yjs_updates")
						.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("fileNodeId", content.nodeId)
								.eq("moveView.cohortId", content.cohortId)
								.eq("moveView.view", view),
						)
				: kind === 3
					? ctx.db
							.query("files_metadata_docs")
							.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
								q
									.eq("organizationId", scope.organizationId)
									.eq("workspaceId", scope.workspaceId)
									.eq("sourceKind", "committed")
									.eq("fileNodeId", content.nodeId)
									.eq("moveView.cohortId", content.cohortId)
									.eq("moveView.view", view),
							)
					: kind === 4 || kind === 5
						? ctx.db
								.query(table as "files_text_chunks" | "files_plain_text_chunks")
								.withIndex("by_pendingUpdate_chunkIndex", (q) =>
									q
										.eq("pendingUpdateId", content.pendingUpdateId)
										.eq("moveView.cohortId", content.cohortId)
										.eq("moveView.view", view),
								)
						: ctx.db
								.query("files_metadata_docs")
								.withIndex("by_pendingUpdate_fieldPath", (q) =>
									q
										.eq("pendingUpdateId", content.pendingUpdateId)
										.eq("moveView.cohortId", content.cohortId)
										.eq("moveView.view", view),
								);
	// Clearing or deleting each tag drains the range without storing a large metadata cursor.
	const page = await query.paginate({ cursor: null, numItems: kind === 2 ? 1 : PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
	for (const row of page.page) {
		if (remove) await ctx.db.delete(table, row._id);
		else await ctx.db.patch(table, row._id, { moveView: undefined });
	}
	await ctx.db.patch("files_move_cohort_content", content._id, {
		phaseCursor: `${marker}${page.isDone ? part + 1 : part}|`,
	});
	return false;
}

async function db_retire_states(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	states: Doc<"files_pending_update_yjs_states">[],
) {
	if (!states.length) return;
	const cohort = (await ctx.db.get("files_move_cohorts", content.cohortId))!;
	const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		createdAt: Date.now(),
	});
	for (const state of states)
		await ctx.db.patch("files_pending_update_yjs_states", state._id, { owner: { kind: "retired", cleanupTaskId } });
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

async function db_remove_asset(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	assetId: Id<"files_r2_assets">,
) {
	const reservation = await db_reservation(ctx, { kind: "asset", id: assetId });
	if (
		!reservation ||
		reservation.settlement.kind !== "held" ||
		reservation.cohortContentId !== content._id ||
		reservation.resource.kind !== "asset"
	)
		return;
	const asset = await ctx.db.get("files_r2_assets", assetId);
	await r2_enqueue_object_deletion_job(ctx, {
		...reservation,
		r2Key: reservation.resource.r2Key,
		reason: "failed_create",
		putMayArriveUntil: (asset?.uploadUrlExpiresAt ?? Date.now()) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
	});
	const claim = await ctx.db
		.query("files_move_asset_claims")
		.withIndex("by_asset", (q) => q.eq("assetId", assetId))
		.first();
	if (claim?.cohortId === content.cohortId) await ctx.db.delete("files_move_asset_claims", claim._id);
	if (asset) await ctx.db.delete("files_r2_assets", assetId);
}

async function db_finish_resources(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	mode: "finish" | "abort",
) {
	const item = (await ctx.db.get("files_move_cohort_items", content.itemId))!;
	const retained =
		mode === "finish" ? retained_state_ids(item.afterProposal) : new Set<Id<"files_pending_update_yjs_states">>();
	if (mode === "finish") {
		const proposal = await ctx.db.get("files_pending_updates", content.pendingUpdateId);
		if (!proposal || proposal.revision !== content.reviewedRevision)
			throw should_never_happen("Move settled its proposal before content", { contentId: content._id });
		for (const resource of consumed_resources(proposal, retained)) {
			const reservation = await db_reservation(ctx, resource);
			if (!reservation || reservation.settlement.kind !== "held") continue;
			const transferred = await files_private_storage_db_set_cohort_owner(ctx, {
				reservationId: reservation._id,
				cohortContentId: content._id,
			});
			if (transferred._nay)
				throw should_never_happen("Published Move could not settle its hold", { reservationId: reservation._id });
			if (resource.kind === "node")
				await files_private_storage_db_release(ctx, {
					reservationId: reservation._id,
					settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
				});
			else if (resource.kind === "asset") {
				if (resource.id === content.afterAssetId || resource.id === content.afterYjsSnapshotAssetId) {
					await ctx.db.patch("files_r2_assets", resource.id, {
						unfinalizedExpiresAt: undefined,
						uploadUrlExpiresAt: undefined,
					});
					await files_private_storage_db_release(ctx, {
						reservationId: reservation._id,
						settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
					});
				} else await db_remove_asset(ctx, content, resource.id);
			}
		}
		// An active proposal has exactly one three-state family.
		const original = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", content.pendingUpdateId))
			.collect();
		await db_retire_states(
			ctx,
			content,
			original.filter((state) => !retained.has(state._id)),
		);
	}
	const batch = content.operationBatchId
		? await ctx.db.get("files_pending_update_operation_batches", content.operationBatchId)
		: null;
	if (batch) {
		// One preparation batch has at most six states and two text inputs.
		const states = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_operationBatch", (q) => q.eq("owner.operationBatchId", batch._id))
			.collect();
		for (const state of states) {
			if (!retained.has(state._id)) continue;
			const reservation = await db_reservation(ctx, { kind: "state", id: state._id });
			if (!reservation) throw should_never_happen("Move lost a partial hold", { stateId: state._id });
			const transferred = await files_private_storage_db_set_cohort_owner(ctx, {
				reservationId: reservation._id,
				cohortContentId: null,
			});
			if (transferred._nay)
				throw should_never_happen("Published Move could not settle partial content", { stateId: state._id });
			if (state.owner.kind !== "cohort")
				throw should_never_happen("Move partial state changed owner", { stateId: state._id });
			await ctx.db.patch("files_pending_update_yjs_states", state._id, {
				target: { kind: "saved", id: content.nodeId },
				owner: { kind: "active", pendingUpdateId: content.pendingUpdateId, role: state.owner.role },
				lineageGeneration: content.afterSequence?.lineageGeneration,
			});
		}
		await db_retire_states(
			ctx,
			content,
			states.filter((state) => !retained.has(state._id)),
		);
		const inputs = await ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
			.collect();
		for (const input of inputs) {
			await ctx.db.delete("files_pending_update_text_inputs", input._id);
			await files_private_storage_db_release_deleted_resource(ctx, { kind: "text_input", id: input._id });
		}
		if (content.trustedStageId && (await ctx.db.get("files_yjs_trusted_update_stages", content.trustedStageId))) {
			await ctx.db.delete("files_yjs_trusted_update_stages", content.trustedStageId);
			await files_private_storage_db_release_deleted_resource(ctx, {
				kind: "trusted_stage",
				id: content.trustedStageId,
			});
		}
		if (batch.publication?.kind === "assets")
			for (const id of [
				batch.publication.contentAssetId,
				batch.publication.yjsSnapshotAssetId,
				batch.publication.backupAssetId,
			]) {
				if (!id) continue;
				const reservation = await db_reservation(ctx, { kind: "asset", id });
				if (!reservation || reservation.settlement.kind !== "held" || reservation.cohortContentId !== content._id)
					continue;
				if (mode === "finish") {
					await ctx.db.patch("files_r2_assets", id, { unfinalizedExpiresAt: undefined, uploadUrlExpiresAt: undefined });
					await files_private_storage_db_release(ctx, {
						reservationId: reservation._id,
						settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
					});
				} else await db_remove_asset(ctx, content, id);
			}
		await ctx.db.delete("files_pending_update_operation_batches", batch._id);
	}
	if (content.preparedMediaSet) {
		await files_media_dependencies_db_retire(ctx, {
			...content.preparedMediaSet,
			owner: { kind: "cohort_content", contentId: content._id },
		});
		await ctx.db.patch("files_move_cohort_content", content._id, { preparedMediaSet: null });
	}
}

/**
 * Physical repair runs after publication. Its quota receipt was applied with the view switch.
 */
export async function files_move_content_db_finish(ctx: MutationCtx, args: Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!content || content.cohortId !== args.cohortId || !cohort) return Result({ _nay: { message: "Not found" } });
	const entered = await files_pending_overlay_db_set_cohort_materialization(ctx, { ...args, mode: "finish" });
	if (entered._nay) return entered;
	if (!cohort.privateAccountingApplied || !content.sealed)
		throw should_never_happen("Move content finished before publication", args);
	if (content.phaseCursor === "finish:done") return Result({ _yay: { done: true } });
	if (!(await db_cleanup_page(ctx, content, "finish"))) return Result({ _yay: { done: false } });
	const node = await ctx.db.get("files_nodes", content.nodeId);
	const place = await files_saved_placement_db_get_node(ctx.db, content.nodeId, {
		cohortId: cohort._id,
		view: "after",
	});
	if (!node || !place) throw should_never_happen("Move lost its accepted content header", args);
	if (content.afterSequence) {
		const { lastSequenceId, ...sequence } = content.afterSequence;
		await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceId, { ...sequence, moveView: undefined });
	}
	if (content.afterSnapshotId)
		await ctx.db.patch("files_yjs_snapshots", content.afterSnapshotId, { moveView: undefined });
	if (content.afterStatsId) await ctx.db.patch("file_stats", content.afterStatsId, { moveView: undefined });
	if (node.yjsLastSequenceId && node.yjsLastSequenceId !== content.afterSequence?.lastSequenceId)
		await ctx.db.delete("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
	if (node.yjsSnapshotId && node.yjsSnapshotId !== content.afterSnapshotId)
		await ctx.db.delete("files_yjs_snapshots", node.yjsSnapshotId);
	if (node.statsId && node.statsId !== content.afterStatsId) await ctx.db.delete("file_stats", node.statsId);
	await ctx.db.patch("files_nodes", node._id, {
		assetId: place.assetId,
		contentType: place.contentType,
		...files_content_type_index_fields(place.contentType),
		textKind: place.textKind,
		collaborationEnabled: place.collaborationEnabled,
		contentByteSize: place.contentByteSize,
		yjsSnapshotId: content.afterSnapshotId,
		yjsLastSequenceId: content.afterSequence?.lastSequenceId ?? null,
		statsId: content.afterStatsId,
		contentTooLargeByteSize: place.contentTooLargeByteSize,
		contentShapeMismatchAt: place.contentShapeMismatchAt,
		contentYjsStateTooLargeByteSize: place.contentYjsStateTooLargeByteSize,
		contentFrontmatterTooLargeFieldCount: place.contentFrontmatterTooLargeFieldCount,
		contentFrontmatterTooLargeIndexDocumentCount: place.contentFrontmatterTooLargeIndexDocumentCount,
	});
	for (const role of ["previousVersion", "acceptedVersion"] as const) {
		const version = content[role];
		const receipt = role === "previousVersion" ? "previousVersionSnapshotId" : "acceptedVersionSnapshotId";
		if (!version || content[receipt]) continue;
		const existing =
			role === "previousVersion"
				? await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", version.assetId))
						.first()
				: null;
		const id =
			existing?._id ??
			(await ctx.db.insert("files_snapshots", {
				organizationId: cohort.organizationId,
				workspaceId: cohort.workspaceId,
				fileNodeId: content.nodeId,
				assetId: version.assetId,
				contentType: version.contentType,
				yjsRootKind: version.yjsRootKind,
				collaborationEnabled: version.collaborationEnabled,
				createdBy: cohort.userId,
				archivedAt: -1,
			}));
		await ctx.db.patch("files_move_cohort_content", content._id, { [receipt]: id });
	}
	const item = (await ctx.db.get("files_move_cohort_items", content.itemId))!;
	if (content.costCents > 0 && item.billingState !== "sent") {
		const billedUser = await ctx.db.get("users", cohort.billedUserId);
		if (!billedUser) throw should_never_happen("Published Move lost its payer", { cohortId: cohort._id });
		// Anonymous usage was debited at the switch. Signed-in usage goes to the normal billing queue.
		if (billedUser.clerkUserId) {
			if (content.storedUpload)
				await billing_db_emit_file_upload(ctx, {
					billedUser,
					actorUserId: cohort.userId,
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					nodeId: content.nodeId,
					assetId: content.afterAssetId!,
					chargeKey: content.afterAssetId!,
					amount: content.costCents,
					bytes: content.storedByteDelta,
				});
			else
				await billing_db_emit_file_save(ctx, {
					billedUser,
					actorUserId: cohort.userId,
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					nodeId: content.nodeId,
					version: content.afterSequence
						? `${content.afterSequence.lastSequenceId}:${content.afterSequence.lastSequence}`
						: content.afterAssetId!,
				});
		}
		await ctx.db.patch("files_move_cohort_items", item._id, { billingState: "sent" });
	}
	await db_finish_resources(ctx, content, "finish");
	await ctx.db.patch("files_move_cohort_content", content._id, { phaseCursor: "finish:done" });
	return Result({ _yay: { done: true } });
}

/**
 * Stop restores the old side and retires output without changing private quota or history.
 */
export async function files_move_content_db_abort(ctx: MutationCtx, args: Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (!content || content.cohortId !== args.cohortId) return Result({ _nay: { message: "Not found" } });
	const entered = await files_pending_overlay_db_set_cohort_materialization(ctx, { ...args, mode: "abort" });
	if (entered._nay) return entered;
	if (content.phaseCursor === "abort:done") return Result({ _yay: { done: true } });
	if (!(await db_cleanup_page(ctx, content, "abort"))) return Result({ _yay: { done: false } });
	if (!content.prepared || changes_saved_content(content.prepared)) {
		if (content.afterSnapshotId) await ctx.db.delete("files_yjs_snapshots", content.afterSnapshotId);
		if (content.afterStatsId) await ctx.db.delete("file_stats", content.afterStatsId);
	}
	if (
		content.afterSequence &&
		content.afterSequence.lastSequenceId !==
			(content.beforeContentVersion?.kind === "yjs" ? content.beforeContentVersion.lastSequenceId : null)
	)
		await ctx.db.delete("files_yjs_docs_last_sequences", content.afterSequence.lastSequenceId);
	await db_finish_resources(ctx, content, "abort");
	await ctx.db.patch("files_move_cohort_content", content._id, { phaseCursor: "abort:done" });
	return Result({ _yay: { done: true } });
}

/**
 * Root calls only after every content, placement, and owner side has finished cleanup.
 */
export async function files_move_content_db_release_claims(ctx: MutationCtx, args: Omit<Context, "contentId">) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort) return Result({ _nay: { message: "Not found" } });
	const entered = await files_move_reservations_db_enter(ctx, {
		...args,
		mode: cohort.visibleView === "after" ? "finish" : "abort",
	});
	if (entered._nay) return entered;
	const claims = await ctx.db
		.query("files_move_asset_claims")
		.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
		.take(PAGE_SIZE);
	for (const claim of claims) await ctx.db.delete("files_move_asset_claims", claim._id);
	return Result({ _yay: { done: claims.length < PAGE_SIZE } });
}
