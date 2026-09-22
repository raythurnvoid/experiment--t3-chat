import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { compareValues, v } from "convex/values";
import { files_headless_tiptap_editor_create } from "../shared/files-tiptap.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import { files_get_utf8_byte_size, type files_PendingTarget } from "../shared/files.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_transfer_rewrite_media_refs } from "../server/files-transfer-media.ts";
import { files_pending_nodes_db_resolve_read_target } from "./files_pending_nodes.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { files_transfer_media_db_get_ready_media } from "./files_transfer_media.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import {
	files_media_validation_db_capture_versions,
	files_media_validation_db_versions_match,
} from "./files_media_validation.ts";

function read_refs(text: string) {
	const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: text } });
	if (editor._nay) return Result({ _nay: { message: editor._nay.message } });
	try {
		const refs = files_transfer_rewrite_media_refs({ mut_editor: editor._yay, referenceMap: new Map() });
		return Result({ _yay: refs._nay?.data.unresolvedRefs ?? [] });
	} finally {
		editor._yay.destroy();
	}
}

async function db_get_publication_text(
	ctx: MutationCtx,
	args: { userId: Id<"users">; operationBatchId: Id<"files_pending_update_operation_batches"> },
) {
	const batch = await ctx.db.get("files_pending_update_operation_batches", args.operationBatchId);
	if (
		!batch?.publication ||
		batch.userId !== args.userId ||
		batch.expiresAt <= Date.now() ||
		!batch.expectedPendingUpdateId
	)
		return null;
	const pending = await ctx.db.get("files_pending_updates", batch.expectedPendingUpdateId);
	if (
		!pending ||
		pending.revision !== batch.expectedRevision ||
		pending.userId !== args.userId ||
		pending.organizationId !== batch.organizationId ||
		pending.workspaceId !== batch.workspaceId ||
		pending.target.kind !== batch.target.kind ||
		pending.target.id !== batch.target.id ||
		!pending.mediaDependencySetId
	)
		return null;
	const set = await ctx.db.get("files_media_dependency_sets", pending.mediaDependencySetId);
	if (
		!set?.sealed ||
		set.owner.kind !== "proposal" ||
		set.owner.pendingUpdateId !== pending._id ||
		set.userId !== pending.userId ||
		set.organizationId !== pending.organizationId ||
		set.workspaceId !== pending.workspaceId
	)
		return null;
	const inputs = await ctx.db
		.query("files_pending_update_text_inputs")
		.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
		.take(2);
	const input = inputs.find((input) => input.role === "staged");
	if (
		!input ||
		input.expiresAt <= Date.now() ||
		input.userId !== args.userId ||
		input.organizationId !== pending.organizationId ||
		input.workspaceId !== pending.workspaceId ||
		input.target.kind !== pending.target.kind ||
		input.target.id !== pending.target.id
	)
		return null;
	const reservation = await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", "text_input").eq("resource.id", input._id))
		.unique();
	if (
		reservation?.publicationBatchId !== batch._id ||
		reservation.settlement.kind !== "held" ||
		reservation.byteCount !== files_get_utf8_byte_size(input.text)
	)
		return null;
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", pending.userId)
				.eq("organizationId", pending.organizationId)
				.eq("workspaceId", pending.workspaceId),
		)
		.first();
	if (!membership) return null;
	const reader = await files_visible_db_create_reader(ctx, pending);
	const entry = await reader.resolveTarget(pending.target);
	if (entry?.pendingUpdate?._id !== pending._id) return null;
	return { batch, input, pending, set, membership };
}

export const start_validation = internalMutation({
	args: {
		userId: v.id("users"),
		pendingUpdateId: v.id("files_pending_updates"),
		reviewedRevision: v.number(),
		operationBatchId: v.optional(v.id("files_pending_update_operation_batches")),
		reviewedPendingUpdateIds: v.array(v.id("files_pending_updates")),
		reviewRunId: v.optional(v.id("files_pending_update_runs")),
	},
	returns: v_result({ _yay: v.object({ isDone: v.boolean() }) }),
	handler: async (ctx, args) => {
		const pending = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
		if (!pending || pending.userId !== args.userId || pending.revision !== args.reviewedRevision)
			return Result({ _nay: { message: "This proposal changed. Review it again." } });
		if (!pending.mediaDependencySetId) return Result({ _yay: { isDone: true } });
		const data = args.operationBatchId
			? await db_get_publication_text(ctx, { userId: args.userId, operationBatchId: args.operationBatchId })
			: null;
		if (!data || data.pending._id !== pending._id)
			return Result({ _nay: { message: "The prepared media check is no longer available" } });
		const refs = read_refs(data.input.text);
		if (refs._nay) return refs;
		const versions = await files_media_validation_db_capture_versions(ctx, {
			userId: args.userId,
			scopes: [data.pending],
		});
		await ctx.db.patch("files_pending_update_text_inputs", data.input._id, {
			mediaValidation: {
				setId: data.set._id,
				setGeneration: data.set.generation,
				pendingUpdateId: data.pending._id,
				reviewedRevision: data.pending.revision,
				textDigest: await crypto_sha256_hex(data.input.text),
				reviewSelectionDigest: await crypto_sha256_hex(
					JSON.stringify([...new Set(args.reviewedPendingUpdateIds)].sort()),
				),
				reviewRunId: args.reviewRunId ?? null,
				...versions,
				totalCount: refs._yay.length,
				validatedCount: 0,
			},
		});
		return Result({ _yay: { isDone: refs._yay.length === 0 } });
	},
});

export const advance_validation = internalMutation({
	args: {
		userId: v.id("users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		reviewedPendingUpdateIds: v.array(v.id("files_pending_updates")),
		reviewRunId: v.optional(v.id("files_pending_update_runs")),
	},
	returns: v_result({ _yay: v.object({ isDone: v.boolean() }) }),
	handler: async (ctx, args) => {
		const data = await db_get_publication_text(ctx, args);
		const proof = data?.input.mediaValidation;
		const changed = Result({
			_nay: { name: "media_validation_changed", message: "Media or access changed. Try Save again." },
		});
		if (
			!data ||
			!proof ||
			proof.setId !== data.set._id ||
			proof.setGeneration !== data.set.generation ||
			proof.pendingUpdateId !== data.pending._id ||
			proof.reviewedRevision !== data.pending.revision ||
			proof.textDigest !== (await crypto_sha256_hex(data.input.text)) ||
			proof.reviewSelectionDigest !==
				(await crypto_sha256_hex(JSON.stringify([...new Set(args.reviewedPendingUpdateIds)].sort()))) ||
			proof.reviewRunId !== (args.reviewRunId ?? null) ||
			!(await files_media_validation_db_versions_match(ctx, proof))
		)
			return changed;
		const refs = read_refs(data.input.text);
		if (refs._nay) return refs;
		const reviewed = new Set(args.reviewedPendingUpdateIds);
		const reader = await files_visible_db_create_reader(ctx, { ...data.pending, readLimit: 4096 });
		const page = refs._yay.slice(proof.validatedCount, proof.validatedCount + 25);
		for (const src of page) {
			const mapping = await ctx.db
				.query("files_media_dependencies")
				.withIndex("by_set_src", (q) => q.eq("setId", data.set._id).eq("dependency.src", src))
				.first();
			const dependency = mapping?.dependency;
			const parsed = files_media_parse_src(src);
			const savedId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
			const privateId =
				parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
			const original: files_PendingTarget | null =
				dependency?.target ??
				(savedId ? { kind: "saved", id: savedId } : privateId ? { kind: "private", id: privateId } : null);
			const target = original
				? await files_pending_nodes_db_resolve_read_target(ctx, { ...data.pending, target: original })
				: null;
			const entry = target ? await reader.resolveTarget(target) : null;
			const refusal = Result({
				_nay: {
					message: "Save the selected media with this document, or save it first. Changed media must be copied again.",
				},
			});
			if (!entry || entry.node.kind !== "file") return refusal;
			const media = entry.pendingUpdate;
			if (args.reviewRunId && media && !reviewed.has(media._id)) {
				const selected = await ctx.db
					.query("files_pending_update_run_items")
					.withIndex("by_run_pendingUpdate", (q) => q.eq("runId", args.reviewRunId!).eq("pendingUpdateId", media._id))
					.first();
				if (selected)
					return Result({
						_nay: {
							name: "needs_review",
							message: "The accepted text now links to another selected change. Review them together.",
						},
					});
			}
			// An unselected replacement does not replace the saved media used by this document.
			const useSaved = entry.kind === "saved" && (!media || !reviewed.has(media._id));
			const ready = await files_transfer_media_db_get_ready_media(
				ctx,
				useSaved ? { ...entry, kind: "saved", node: entry.node, pendingUpdate: null } : entry,
				data.membership,
			);
			if (!ready || (entry.kind === "private" && !reviewed.has(entry.pendingUpdate._id)) || media?.pendingArchive)
				return refusal;
			if (
				dependency &&
				(ready.assetId !== dependency.assetId ||
					ready.version.contentType !== dependency.version.contentType ||
					(!useSaved && !files_transfer_source_versions_equal(dependency.version, ready.version)))
			)
				return refusal;
		}
		const validatedCount = proof.validatedCount + page.length;
		await ctx.db.patch("files_pending_update_text_inputs", data.input._id, {
			mediaValidation: { ...proof, validatedCount },
		});
		return Result({ _yay: { isDone: validatedCount === proof.totalCount } });
	},
});

export type files_pending_media_ValidatedSave = {
	ctx: MutationCtx;
	textInputId: Id<"files_pending_update_text_inputs">;
	proof: NonNullable<Doc<"files_pending_update_text_inputs">["mediaValidation"]>;
};

export async function files_pending_media_db_require_validation(
	ctx: MutationCtx,
	args: {
		pendingUpdate: Doc<"files_pending_updates">;
		text: string;
		operationBatchId: Id<"files_pending_update_operation_batches">;
		reviewedPendingUpdateIds?: ReadonlySet<Id<"files_pending_updates">>;
		reviewRunId?: Id<"files_pending_update_runs">;
		validated?: files_pending_media_ValidatedSave;
	},
) {
	const data = await db_get_publication_text(ctx, {
		userId: args.pendingUpdate.userId,
		operationBatchId: args.operationBatchId,
	});
	const proof = data?.input.mediaValidation;
	// An atomic review unit checks all proofs before its own media commits advance the clocks.
	if (
		!data ||
		!proof ||
		proof.pendingUpdateId !== args.pendingUpdate._id ||
		proof.reviewedRevision !== args.pendingUpdate.revision ||
		proof.setId !== data.set._id ||
		proof.setGeneration !== data.set.generation ||
		proof.validatedCount !== proof.totalCount ||
		proof.textDigest !== (await crypto_sha256_hex(args.text)) ||
		proof.textDigest !== (await crypto_sha256_hex(data.input.text)) ||
		proof.reviewSelectionDigest !==
			(await crypto_sha256_hex(JSON.stringify([...(args.reviewedPendingUpdateIds ?? [])].sort()))) ||
		proof.reviewRunId !== (args.reviewRunId ?? null) ||
		(!(
			args.validated?.ctx === ctx &&
			args.validated.textInputId === data.input._id &&
			compareValues(args.validated.proof, proof) === 0
		) &&
			!(await files_media_validation_db_versions_match(ctx, proof)))
	)
		return Result({ _nay: { name: "media_validation_changed", message: "Media or access changed. Try Save again." } });
	return Result({ _yay: null });
}

export async function files_pending_media_db_validate_prepared(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		prepared: NonNullable<Doc<"files_pending_update_run_items">["prepared"]>;
		reviewedPendingUpdateIds?: ReadonlySet<Id<"files_pending_updates">>;
		reviewRunId?: Id<"files_pending_update_runs">;
	},
) {
	const pending = await ctx.db.get("files_pending_updates", args.prepared.pendingUpdateId);
	if (!pending || pending.userId !== args.userId || pending.revision !== args.prepared.reviewedRevision)
		return Result({ _nay: { message: "This proposal changed. Review it again." } });
	if (!pending.mediaDependencySetId) return Result({ _yay: null });
	const operationBatchId = args.prepared.operationBatchIds[0];
	const data = operationBatchId ? await db_get_publication_text(ctx, { userId: args.userId, operationBatchId }) : null;
	if (!data || !operationBatchId || data.pending._id !== pending._id)
		return Result({ _nay: { message: "The prepared media check is no longer available" } });
	const checked = await files_pending_media_db_require_validation(ctx, {
		pendingUpdate: pending,
		text: data.input.text,
		operationBatchId,
		reviewedPendingUpdateIds: args.reviewedPendingUpdateIds,
		reviewRunId: args.reviewRunId,
	});
	if (checked._nay) return checked;
	return Result({ _yay: { ctx, textInputId: data.input._id, proof: data.input.mediaValidation! } });
}

export async function files_pending_media_action_validate(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		pendingUpdateId: Id<"files_pending_updates">;
		reviewedRevision: number;
		operationBatchId?: Id<"files_pending_update_operation_batches">;
		reviewedPendingUpdateIds?: ReadonlySet<Id<"files_pending_updates">>;
		reviewRunId?: Id<"files_pending_update_runs">;
	},
) {
	const reviewedPendingUpdateIds = [...(args.reviewedPendingUpdateIds ?? [])];
	// Concurrent media edits may invalidate a page. Never keep refreshing a proof forever.
	for (let attempt = 0; attempt < 3; attempt++) {
		const started = await ctx.runMutation(internal.files_pending_media.start_validation, {
			...args,
			reviewedPendingUpdateIds,
		});
		if (started._nay) return started;
		if (started._yay.isDone) return Result({ _yay: null });
		if (!args.operationBatchId) return Result({ _nay: { message: "The prepared media check is no longer available" } });
		while (true) {
			const page = await ctx.runMutation(internal.files_pending_media.advance_validation, {
				userId: args.userId,
				operationBatchId: args.operationBatchId,
				reviewedPendingUpdateIds,
				reviewRunId: args.reviewRunId,
			});
			if (page._nay) {
				if (page._nay.name === "media_validation_changed") break;
				return page;
			}
			if (page._yay.isDone) return Result({ _yay: null });
		}
	}
	return Result({
		_nay: { name: "media_validation_changed", message: "Media or access kept changing. Try Save again." },
	});
}
