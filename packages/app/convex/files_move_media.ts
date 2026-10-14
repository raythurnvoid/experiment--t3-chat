import { Result } from "common/errors-as-values-utils.ts";
import {
	files_move_media_PAGE_SIZE as PAGE_SIZE,
	type files_move_media_Result as MediaResult,
	files_move_media_changed as changed,
	files_move_media_db_current as db_current,
	files_move_media_db_selected as db_selected,
	files_move_media_db_ref as db_ref,
} from "./files_move_media_db.ts";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import {
	files_media_dependencies_db_create,
	files_media_dependencies_db_append,
	files_media_dependencies_db_seal,
} from "./files_media_dependencies.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_resolve_read_target,
} from "../server/files-saved-placement.ts";
import { files_pending_update_yjs_state_digest } from "../server/files.ts";
import { files_headless_tiptap_editor_create } from "../shared/files-tiptap.ts";
import { files_transfer_rewrite_media_refs } from "../server/files-transfer-media.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";

const context_validator = {
	cohortId: v.id("files_move_cohorts"),
	contentId: v.id("files_move_cohort_content"),
	fence: v.number(),
	attemptFence: v.number(),
	runGeneration: v.union(v.number(), v.null()),
};
type Context = {
	cohortId: Id<"files_move_cohorts">;
	contentId: Id<"files_move_cohort_content">;
	fence: number;
	attemptFence: number;
	runGeneration: number | null;
};

async function db_text(ctx: QueryCtx | MutationCtx, data: NonNullable<Awaited<ReturnType<typeof db_current>>["_yay"]>) {
	const { cohort, content, run } = data;
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
	// One selected item cannot include another selected media file.
	const single = run?.expectedItemCount === 1;
	return Result({
		_yay: {
			text: node.textKind === "rich_text" && !single ? input.text : null,
			digest: content.acceptedTextDigest!,
		},
	});
}

export const read = internalQuery({
	args: context_validator,
	handler: async (
		ctx,
		args,
	): Promise<
		MediaResult<{ text: string | null; digest: string; sealed: boolean; offset: number; ordinary: boolean }>
	> => {
		const checked = await db_current(ctx, args);
		if (checked._nay) return checked;
		const text = await db_text(ctx, checked._yay);
		if (text._nay) return text;
		return Result({
			_yay: {
				...text._yay,
				sealed: checked._yay.set?.sealed ?? false,
				offset: checked._yay.set?.count ?? 0,
				ordinary: checked._yay.cohort.origin.kind === "review",
			},
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

export const select_refs = internalQuery({
	args: { ...context_validator, refs: v.array(v.string()) },
	handler: async (ctx, args): Promise<MediaResult<string[]>> => {
		if (args.refs.length === 0 || args.refs.length > PAGE_SIZE) return changed();
		const checked = await db_current(ctx, args);
		if (checked._nay) return checked;
		const { cohort } = checked._yay;
		if (cohort.origin.kind !== "review") return changed();
		const refs = [];
		for (const src of args.refs) {
			const parsed = files_media_parse_src(src);
			const savedId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
			const privateId =
				parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
			const original = savedId
				? { kind: "saved" as const, id: savedId }
				: privateId
					? { kind: "private" as const, id: privateId }
					: null;
			if (!original) continue;
			const target =
				original.kind === "private"
					? await files_saved_placement_db_resolve_read_target(
							ctx.db,
							{ ...cohort, target: original },
							{
								cohortId: cohort._id,
								view: "after",
							},
						)
					: original;
			if (await db_selected(ctx, cohort.origin.runId, original, target)) refs.push(src);
		}
		return Result({ _yay: refs });
	},
});

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
		ordinary: boolean;
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
	if (checked._yay.ordinary) {
		const selected = [];
		for (let offset = 0; offset < refs.length; offset += PAGE_SIZE) {
			const page = (await ctx.runQuery(internal.files_move_media.select_refs, {
				...args,
				refs: refs.slice(offset, offset + PAGE_SIZE),
			})) as MediaResult<string[]>;
			if (page._nay) return page;
			selected.push(...page._yay);
		}
		refs = selected;
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
