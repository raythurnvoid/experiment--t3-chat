import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_media_validation_db_versions_match } from "./files_media_validation.ts";
import {
	files_media_dependencies_db_create,
	files_media_dependencies_db_append,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";
import { files_transfer_media_db_get_ready_media } from "./files_transfer_media.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_resolve_read_target,
} from "../server/files-saved-placement.ts";
import { files_pending_update_yjs_state_digest } from "../server/files.ts";
import { files_headless_tiptap_editor_create } from "../shared/files-tiptap.ts";
import { files_transfer_rewrite_media_refs } from "../server/files-transfer-media.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";

const PAGE_SIZE = 8;
const context_validator = {
	cohortId: v.id("files_move_cohorts"),
	contentId: v.id("files_move_cohort_content"),
	fence: v.number(),
	attemptFence: v.number(),
};
type Context = {
	cohortId: Id<"files_move_cohorts">;
	contentId: Id<"files_move_cohort_content">;
	fence: number;
	attemptFence: number;
};
type MediaResult<T> = { _yay: T; _nay?: undefined } | { _nay: { name?: string; message: string }; _yay?: undefined };

function changed() {
	return Result({
		_nay: { name: "needs_review", message: "A linked media file changed. Review this document again." },
	});
}

async function db_current(
	ctx: QueryCtx | MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		contentId: Id<"files_move_cohort_content">;
		fence?: number;
		attemptFence?: number;
		proofEpoch?: number;
	},
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (
		!cohort ||
		!content ||
		content.cohortId !== cohort._id ||
		!content.sealed ||
		(cohort.phase !== "staging" &&
			cohort.phase !== "validating" &&
			!(args.proofEpoch !== undefined && cohort.phase === "ready")) ||
		cohort.visibleView !== "before" ||
		(args.fence !== undefined && cohort.fence !== args.fence) ||
		(args.attemptFence !== undefined && cohort.attemptFence !== args.attemptFence) ||
		(args.proofEpoch !== undefined && cohort.proofEpoch !== args.proofEpoch) ||
		content.proofEpoch !== cohort.proofEpoch ||
		cohort.deadlineAt <= Date.now()
	)
		return changed();
	const item = await ctx.db.get("files_move_cohort_items", content.itemId);
	const proposal = await ctx.db.get("files_pending_updates", content.pendingUpdateId);
	if (
		!item ||
		item.cohortId !== cohort._id ||
		item.contentId !== content._id ||
		!proposal ||
		proposal.userId !== cohort.userId ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.moveCohortId !== cohort._id ||
		proposal.revision !== content.reviewedRevision ||
		item.reviewedRevision !== content.reviewedRevision ||
		item.selectedContentStateId !== content.selectedContentStateId
	)
		return changed();
	const [membership, lifetime, user, workspace] = await Promise.all([
		organizations_db_get_membership(ctx, { userId: cohort.userId, membershipId: cohort.membershipId }),
		organizations_membership_lifetimes_db_get(ctx, cohort),
		ctx.db.get("users", cohort.userId),
		ctx.db.get("organizations_workspaces", cohort.workspaceId),
	]);
	if (
		!membership ||
		!lifetime?.active ||
		lifetime.membershipId !== cohort.membershipId ||
		lifetime.lifetime !== cohort.membershipLifetime ||
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		workspace.organizationId !== cohort.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
	if (cohort.origin.kind === "review") {
		const run = await ctx.db.get("files_pending_update_runs", cohort.origin.runId);
		const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
		if (
			!run ||
			run.step !== "running" ||
			run.fence !== cohort.fence ||
			run.planEpoch !== cohort.origin.planEpoch ||
			!unit ||
			unit.runId !== run._id ||
			unit.cohortId !== cohort._id ||
			unit.status !== "preparing" ||
			unit.attemptFence !== cohort.attemptFence
		)
			return changed();
	}
	const pins = cohort.clockPins;
	if (
		!(await files_media_validation_db_versions_match(ctx, {
			versions: [pins.organization, pins.workspace],
			pendingVersions: pins.review ? [pins.review] : [],
		}))
	)
		return changed();
	const set = content.preparedMediaSet
		? await ctx.db.get("files_media_dependency_sets", content.preparedMediaSet.setId)
		: null;
	if (
		content.preparedMediaSet &&
		(!set ||
			set.generation !== content.preparedMediaSet.generation ||
			set.owner.kind !== "cohort_content" ||
			set.owner.contentId !== content._id ||
			set.userId !== cohort.userId ||
			set.organizationId !== cohort.organizationId ||
			set.workspaceId !== cohort.workspaceId)
	)
		return changed();
	return Result({ _yay: { cohort, content, item, proposal, membership, set } });
}

async function db_text(ctx: QueryCtx | MutationCtx, data: NonNullable<Awaited<ReturnType<typeof db_current>>["_yay"]>) {
	const { cohort, content } = data;
	if (!content.acceptedTextInputId)
		return content.acceptedTextDigest === null ? Result({ _yay: { text: null, digest: "" } }) : changed();
	const input = await ctx.db.get("files_pending_update_text_inputs", content.acceptedTextInputId);
	const batch = content.operationBatchId
		? await ctx.db.get("files_pending_update_operation_batches", content.operationBatchId)
		: null;
	if (
		!input ||
		!batch ||
		input.cohortContentId !== content._id ||
		batch.cohortContentId !== content._id ||
		input.operationBatchId !== batch._id ||
		input.role !== "staged" ||
		input.userId !== cohort.userId ||
		input.organizationId !== cohort.organizationId ||
		input.workspaceId !== cohort.workspaceId ||
		(input.expiresAt !== undefined && input.expiresAt <= Date.now()) ||
		(batch.expiresAt !== undefined && batch.expiresAt <= Date.now())
	)
		return changed();
	const reservation = await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", "text_input").eq("resource.id", input._id))
		.unique();
	if (
		!reservation ||
		reservation.settlement.kind !== "held" ||
		reservation.cohortContentId !== content._id ||
		reservation.byteCount !== files_get_utf8_byte_size(input.text) ||
		files_pending_update_yjs_state_digest(new TextEncoder().encode(input.text)) !== content.acceptedTextDigest
	)
		return changed();
	const node = await files_saved_placement_db_get_node(ctx.db, content.nodeId, { cohortId: cohort._id, view: "after" });
	if (!node) return changed();
	return Result({
		_yay: { text: node.textKind === "rich_text" ? input.text : null, digest: content.acceptedTextDigest! },
	});
}

export const read = internalQuery({
	args: context_validator,
	handler: async (
		ctx,
		args,
	): Promise<MediaResult<{ text: string | null; digest: string; sealed: boolean; offset: number }>> => {
		const checked = await db_current(ctx, args);
		if (checked._nay) return checked;
		const text = await db_text(ctx, checked._yay);
		if (text._nay) return text;
		return Result({
			_yay: { ...text._yay, sealed: checked._yay.set?.sealed ?? false, offset: checked._yay.set?.count ?? 0 },
		});
	},
});

export const start = internalMutation({
	args: { ...context_validator, digest: v.string(), expectedCount: v.number() },
	handler: async (
		ctx,
		args,
	): Promise<
		MediaResult<{ setId: Id<"files_media_dependency_sets">; generation: number; count: number; sealed: boolean }>
	> => {
		const checked = await db_current(ctx, args);
		if (checked._nay) return checked;
		const data = checked._yay;
		if ((data.content.acceptedTextDigest ?? "") !== args.digest) return changed();
		if (data.set)
			return data.set.expectedCount === args.expectedCount
				? Result({
						_yay: {
							setId: data.set._id,
							generation: data.set.generation,
							count: data.set.count,
							sealed: data.set.sealed,
						},
					})
				: changed();
		const created = await files_media_dependencies_db_create(ctx, {
			...data.cohort,
			owner: { kind: "cohort_content", contentId: data.content._id },
			expectedCount: args.expectedCount,
		});
		if (created._nay) return created;
		await ctx.db.patch("files_move_cohort_content", data.content._id, {
			preparedMediaSet: { setId: created._yay, generation: 0 },
		});
		if (args.expectedCount === 0) await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 });
		return Result({ _yay: { setId: created._yay, generation: 0, count: 0, sealed: args.expectedCount === 0 } });
	},
});

async function db_ref(
	ctx: QueryCtx | MutationCtx,
	data: NonNullable<Awaited<ReturnType<typeof db_current>>["_yay"]>,
	src: string,
) {
	const { cohort, item, membership } = data;
	const pin = item.mediaDependencySet;
	const captured = pin ? await ctx.db.get("files_media_dependency_sets", pin.setId) : null;
	if (
		pin &&
		(!captured?.sealed ||
			captured.generation !== pin.generation ||
			captured.userId !== cohort.userId ||
			captured.organizationId !== cohort.organizationId ||
			captured.workspaceId !== cohort.workspaceId ||
			captured.owner.kind !== "proposal" ||
			captured.owner.pendingUpdateId !== item.pendingUpdateId)
	)
		return changed();
	const mapping = captured
		? await ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_src", (q) => q.eq("setId", captured._id).eq("dependency.src", src))
				.first()
		: null;
	const parsed = files_media_parse_src(src);
	const savedId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
	const privateId = parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
	const original =
		mapping?.dependency.target ??
		(savedId
			? { kind: "saved" as const, id: savedId }
			: privateId
				? { kind: "private" as const, id: privateId }
				: null);
	if (!original) return changed();
	const fixedView = { cohortId: cohort._id, view: "after" as const };
	const target = await files_saved_placement_db_resolve_read_target(ctx.db, { ...cohort, target: original }, fixedView);
	if (target?.kind !== "saved") return changed();
	if (cohort.origin.kind === "review") {
		const runId = cohort.origin.runId;
		let selected = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_target", (q) =>
				q.eq("runId", runId).eq("target.kind", original.kind).eq("target.id", original.id),
			)
			.unique();
		// A published private link may target a selected saved replacement.
		if (!selected && original.kind === "private")
			selected = await ctx.db
				.query("files_pending_update_run_items")
				.withIndex("by_run_target", (q) =>
					q.eq("runId", runId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.unique();
		if (selected?.unitId && selected.unitId !== cohort.origin.unitId) {
			const unit = await ctx.db.get("files_pending_update_run_units", selected.unitId);
			if (unit?.status !== "completed") return changed();
		}
	}
	const node = await files_saved_placement_db_get_node(ctx.db, target.id, fixedView);
	if (
		!node ||
		node.organizationId !== cohort.organizationId ||
		node.workspaceId !== cohort.workspaceId ||
		node.archiveOperationId !== null
	)
		return changed();
	const authorized = await access_control_db_authorize_membership(ctx, {
		membership,
		userAuth: { id: cohort.userId },
		permission: "content.read",
		fileNode: node,
	});
	if (authorized._nay) return authorized;
	const ready = await files_transfer_media_db_get_ready_media({
		ctx,
		membership,
		entry: { kind: "saved", node, pendingUpdate: null, path: node.path },
	});
	if (!ready) return changed();
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
		.unique();
	const selectedMedia = record?.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	if (selectedMedia?.contentId) {
		const candidate = await ctx.db.get("files_move_cohort_content", selectedMedia.contentId);
		const pending = selectedMedia.pendingUpdateId
			? await ctx.db.get("files_pending_updates", selectedMedia.pendingUpdateId)
			: null;
		if (
			!candidate?.sealed ||
			candidate.proofEpoch !== cohort.proofEpoch ||
			candidate.afterAssetId !== ready.assetId ||
			!pending ||
			pending.revision !== selectedMedia.reviewedRevision ||
			pending.moveCohortId !== cohort._id
		)
			return changed();
		const originalAsset =
			pending.pendingReplacement?.assetId ??
			(pending.createIntent?.kind === "stored" ? pending.createIntent.assetId : null);
		const needsHold =
			originalAsset === ready.assetId ||
			candidate.prepared?.kind === "replacement" ||
			candidate.prepared?.kind === "private";
		if (needsHold) {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", ready.assetId))
				.unique();
			const asset = await ctx.db.get("files_r2_assets", ready.assetId);
			if (
				!hold ||
				!asset ||
				hold.settlement.kind !== "held" ||
				hold.resource.kind !== "asset" ||
				hold.organizationId !== cohort.organizationId ||
				hold.workspaceId !== cohort.workspaceId ||
				hold.userId !== cohort.userId ||
				hold.byteCount !== asset.size ||
				hold.resource.r2Key !== asset.r2Key ||
				(hold.cohortContentId !== candidate._id &&
					!(hold.cohortContentId === undefined && originalAsset === ready.assetId))
			)
				return changed();
		}
	}
	const pinned = mapping?.dependency;
	if (
		pinned &&
		(ready.assetId !== pinned.assetId ||
			ready.version.contentType !== pinned.version.contentType ||
			(pinned.version.kind !== "pending" && !files_transfer_source_versions_equal(pinned.version, ready.version)))
	)
		return changed();
	return Result({ _yay: { src, target, assetId: ready.assetId, version: ready.version } });
}

export const append = internalMutation({
	args: {
		...context_validator,
		setId: v.id("files_media_dependency_sets"),
		generation: v.number(),
		offset: v.number(),
		refs: v.array(v.string()),
	},
	handler: async (ctx, args): Promise<MediaResult<null>> => {
		if (args.refs.length === 0 || args.refs.length > PAGE_SIZE) return changed();
		const checked = await db_current(ctx, args);
		if (checked._nay) return checked;
		if (checked._yay.set?._id !== args.setId || checked._yay.set.generation !== args.generation) return changed();
		const mappings = [];
		for (const src of args.refs) {
			const current = await db_ref(ctx, checked._yay, src);
			if (current._nay) return current;
			mappings.push({ sourceSrc: src, dependency: current._yay });
		}
		const added = await files_media_dependencies_db_append(ctx, { ...args, mappings });
		if (added._nay) return added;
		if (args.offset + args.refs.length === checked._yay.set.expectedCount)
			return await files_media_dependencies_db_seal(ctx, args);
		return Result({ _yay: null });
	},
});

export async function files_move_media_action_prepare_refs(ctx: ActionCtx, args: Context): Promise<MediaResult<null>> {
	const checked = (await ctx.runQuery(internal.files_move_media.read, args)) as MediaResult<{
		text: string | null;
		digest: string;
		sealed: boolean;
		offset: number;
	}>;
	if (checked._nay) return checked;
	if (checked._yay.sealed) return Result({ _yay: null });
	let refs: string[] = [];
	if (checked._yay.text !== null) {
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: checked._yay.text } });
		if (editor._nay) return editor;
		try {
			const parsed = files_transfer_rewrite_media_refs({ mut_editor: editor._yay, referenceMap: new Map() });
			refs = [...new Set(parsed._nay?.data.unresolvedRefs ?? [])];
		} finally {
			editor._yay.destroy();
		}
	}
	const started = (await ctx.runMutation(internal.files_move_media.start, {
		...args,
		digest: checked._yay.digest,
		expectedCount: refs.length,
	})) as MediaResult<{ setId: Id<"files_media_dependency_sets">; generation: number; count: number; sealed: boolean }>;
	if (started._nay) return started;
	for (let offset = started._yay.count; offset < refs.length; offset += PAGE_SIZE) {
		const added = (await ctx.runMutation(internal.files_move_media.append, {
			...args,
			setId: started._yay.setId,
			generation: started._yay.generation,
			offset,
			refs: refs.slice(offset, offset + PAGE_SIZE),
		})) as MediaResult<null>;
		if (added._nay) return added;
	}
	return Result({ _yay: null });
}

export async function files_move_media_db_validate_next(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		contentId: Id<"files_move_cohort_content">;
		proofEpoch: number;
		cursor: string | null;
	},
): Promise<MediaResult<{ done: boolean; cursor: string }>> {
	const checked = await db_current(ctx, args);
	if (checked._nay) return checked;
	const { content, set, cohort } = checked._yay;
	if (!set?.sealed || set.count !== set.expectedCount) return changed();
	const previous = content.mediaProof;
	if (
		previous &&
		(previous.proofEpoch !== cohort.proofEpoch ||
			previous.reviewedRevision !== content.reviewedRevision ||
			previous.selectedContentStateId !== content.selectedContentStateId ||
			previous.textDigest !== (content.acceptedTextDigest ?? "") ||
			previous.dependencySet?.setId !== set._id ||
			previous.dependencySet.generation !== set.generation)
	)
		return changed();
	if (previous?.sealed) return Result({ _yay: { done: true, cursor: args.cursor ?? "" } });
	const page = await ctx.db
		.query("files_media_dependencies")
		.withIndex("by_set_order", (q) => q.eq("setId", set._id))
		.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	let validatedCount = previous?.validatedCount ?? 0;
	for (const row of page.page) {
		if (row.order !== validatedCount) return changed();
		const current = await db_ref(ctx, checked._yay, row.sourceSrc);
		if (current._nay) return current;
		if (
			current._yay.target.kind !== row.dependency.target.kind ||
			current._yay.target.id !== row.dependency.target.id ||
			current._yay.assetId !== row.dependency.assetId ||
			!files_transfer_source_versions_equal(current._yay.version, row.dependency.version)
		)
			return changed();
		validatedCount++;
	}
	if (page.isDone && validatedCount !== set.expectedCount) return changed();
	await ctx.db.patch("files_move_cohort_content", content._id, {
		mediaProof: {
			proofEpoch: cohort.proofEpoch,
			reviewedRevision: content.reviewedRevision,
			selectedContentStateId: content.selectedContentStateId,
			textDigest: content.acceptedTextDigest ?? "",
			dependencySet: { setId: set._id, generation: set.generation },
			expectedCount: set.expectedCount,
			validatedCount,
			sealed: page.isDone,
		},
	});
	return Result({ _yay: { done: page.isDone, cursor: page.continueCursor } });
}
