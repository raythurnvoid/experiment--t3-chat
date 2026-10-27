import type { PaginationResult, WithoutSystemFields } from "convex/server";
import { paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalAction, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema, { files_metadata_entries_validator } from "./schema.ts";
import { files_index_db_release_ticket, files_index_db_ticket, files_index_RECOVER_MS as RECOVER_MS } from "../server/files-index.ts";
import { files_content_heads_db_for_head, files_content_heads_db_flush } from "../server/files-content-heads.ts";
import { files_metadata_maps_db_read } from "../server/files-metadata-maps.ts";
import {
	files_pending_overlay_db_has_saved_scope_job,
	files_pending_overlay_db_schedule_saved_scope,
	files_pending_overlay_db_schedule_saved_places,
} from "../server/files-pending-overlay.ts";
import {
	files_saved_placement_db_bump_search_generation,
	files_saved_placement_db_get_node,
} from "../server/files-saved-placement.ts";
import { files_chunk_markdown_add_plain_text } from "../server/files-markdown-chunking-mastra.ts";
import { files_pending_update_runs_db_resume_parked } from "./files_pending_update_runs_db.ts";
import { activities_db_get_by_source_id, activities_is_active } from "./activities_db.ts";
import { files_metadata_value_doc_payload } from "./files_metadata_db.ts";
import {
	files_metadata_extract_entries,
	files_metadata_preflight_frontmatter,
	files_metadata_search_values,
	files_metadata_scalar_preview,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";
import { files_sort_value_of } from "../shared/files-sort.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export const experimental_reuseContext = true;

const PAGE_SIZE = 32;
const PAGE_BYTES = 512 * 1024;
const guard_args = { runId: v.id("files_index_runs"), step: v.number(), generation: v.number() };
type Guard = { runId: Id<"files_index_runs">; step: number; generation: number };
type Run = Doc<"files_index_runs">;
type MetadataValue = Extract<Doc<"files_index_candidates">, { kind: "metadata" }>["value"];

function placement(node: Doc<"files_nodes">): Run["placement"] {
	return {
		parentId: node.parentId,
		kind: node.kind,
		name: node.name,
		sortName: node.sortName,
		path: node.path,
		treePath: node.treePath,
		archiveOperationId: node.archiveOperationId,
		restrictedScopeNodeId: node.restrictedScopeNodeId,
		isRestrictedScopeRoot: node.isRestrictedScopeRoot,
	};
}

function same_placement(node: Doc<"files_nodes">, saved: Run["placement"]) {
	return (Object.keys(saved) as Array<keyof Run["placement"]>).every((key) => node[key] === saved[key]);
}

async function current(ctx: QueryCtx | MutationCtx, args: Guard) {
	const run = await ctx.db.get("files_index_runs", args.runId);
	return run && run.phase !== "complete" && run.step === args.step && run.generation === args.generation ? run : null;
}

async function workspace_live(ctx: QueryCtx | MutationCtx, run: Pick<Run, "organizationId" | "workspaceId">) {
	const workspace = await ctx.db.get("organizations_workspaces", run.workspaceId);
	return workspace?.organizationId === run.organizationId && workspace.pluginDataPurgeStartedAt === undefined;
}

async function schedule(ctx: MutationCtx, run: Run, delay = 0) {
	const args = { runId: run._id, step: run.step, generation: run.generation };
	const scheduledId =
		run.phase === "build_metadata"
			? await ctx.scheduler.runAfter(delay, internal.files_index.prepare_metadata, args)
			: await ctx.scheduler.runAfter(delay, internal.files_index.advance, args);
	await ctx.db.patch("files_index_runs", run._id, { scheduledId, nextAttemptAt: Date.now() + delay + RECOVER_MS });
}

async function progress(
	ctx: MutationCtx,
	run: Run,
	patch: Partial<WithoutSystemFields<Run>>,
	options: { schedule?: boolean; delay?: number } = {},
) {
	const next = { ...run, error: null, ...patch, step: run.step + 1, nextAttemptAt: Date.now() + RECOVER_MS };
	await ctx.db.patch("files_index_runs", run._id, {
		error: null,
		...patch,
		step: next.step,
		nextAttemptAt: next.nextAttemptAt,
	});
	if (options.schedule !== false) await schedule(ctx, next, options.delay);
	return { runId: run._id, step: next.step, generation: next.generation };
}

export const start = internalMutation({
	args: { nodeId: v.id("files_nodes") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.unique();
		if (!state || state.activeRunId || state.movePublication || state.requestedRevision <= state.publishedRevision)
			return null;
		if (!(await workspace_live(ctx, state))) return null;
		const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (!node) return null;
		const head = state.requestedHeadId ? await ctx.db.get("files_saved_content_heads", state.requestedHeadId) : null;
		if (state.requestedHeadId && (!head || head.fileNodeId !== node._id))
			throw should_never_happen("Index request lost its source head", { nodeId: node._id });
		const map = await files_metadata_maps_db_read(ctx.db, { kind: "saved", id: node._id });
		const lastChunk = head
			? await ctx.db
					.query("files_text_chunks")
					.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", head._id))
					.order("desc")
					.first()
			: null;
		const runId = await ctx.db.insert("files_index_runs", {
			organizationId: state.organizationId,
			workspaceId: state.workspaceId,
			fileNodeId: node._id,
			indexRevision: state.requestedRevision,
			contentRevision: state.contentRevision,
			contentHeadId: head?._id ?? null,
			previousHeadId: null,
			textKind: head?.textKind ?? null,
			chunkCount: lastChunk ? lastChunk.chunkIndex + 1 : 0,
			yjsSequence: lastChunk?.sourceKind === "committed" ? lastChunk.yjsSequence : undefined,
			placement: placement(node),
			phase: "build_text",
			cursor: null,
			nextPosition: 0,
			step: 0,
			generation: 0,
			nextAttemptAt: Date.now() + RECOVER_MS,
			scheduledId: null,
			slotGeneration: null,
			published: false,
			aborting: false,
			error: null,
		});
		await ctx.db.insert("files_index_inputs", {
			runId,
			metadataMapId: map?._id ?? null,
			metadataRevision: map?.revision ?? null,
			entries: map?.entries ?? [],
		});
		await ctx.db.patch("files_index_states", state._id, { activeRunId: runId, needsRun: false });
		await schedule(ctx, (await ctx.db.get("files_index_runs", runId))!);
		return null;
	},
});

async function build_text(ctx: MutationCtx, run: Run) {
	if (!run.contentHeadId) return await progress(ctx, run, { phase: "build_metadata", cursor: null, nextPosition: 0 });
	const page = await ctx.db
		.query("files_text_chunks")
		.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", run.contentHeadId!))
		.paginate({ cursor: run.cursor, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES });
	const converted = run.textKind === "rich_text" ? files_chunk_markdown_add_plain_text(page.page) : null;
	if (converted?._nay) throw should_never_happen("Saved Markdown chunks could not be indexed", converted._nay);
	for (const [index, chunk] of page.page.entries()) {
		await ctx.db.insert("files_index_candidates", {
			runId: run._id,
			kind: "text",
			position: run.nextPosition + index,
			value: {
				textChunkId: chunk._id,
				chunkIndex: chunk.chunkIndex,
				textChunk: chunk.textChunk,
				plainTextChunk: converted?._yay[index]?.plainTextChunk ?? chunk.textChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
				path: run.placement.path,
				archiveOperationId: run.placement.archiveOperationId ?? undefined,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < run.chunkCount - 1,
			},
		});
	}
	return await progress(
		ctx,
		run,
		page.isDone
			? { phase: "build_metadata", cursor: null, nextPosition: 0 }
			: { cursor: page.continueCursor, nextPosition: run.nextPosition + page.page.length },
	);
}

export const read_input = internalQuery({
	args: guard_args,
	returns: v.union(
		v.object({ run: doc(app_convex_schema, "files_index_runs"), entries: files_metadata_entries_validator }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const run = await current(ctx, args);
		if (!run || run.phase !== "build_metadata" || !(await workspace_live(ctx, run))) return null;
		const input = await ctx.db
			.query("files_index_inputs")
			.withIndex("by_run", (q) => q.eq("runId", run._id))
			.unique();
		if (!input) throw should_never_happen("Index run lost its custom metadata", { runId: run._id });
		return { run, entries: input.entries };
	},
});

export const read_text = internalQuery({
	args: { ...guard_args, cursor: v.union(v.string(), v.null()) },
	returns: v.union(paginationResultValidator(doc(app_convex_schema, "files_text_chunks")), v.null()),
	handler: async (ctx, args) => {
		const run = await current(ctx, args);
		if (!run || run.phase !== "build_metadata" || !run.contentHeadId || !(await workspace_live(ctx, run))) return null;
		return await ctx.db
			.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", run.contentHeadId!))
			.paginate({ cursor: args.cursor, numItems: 128, maximumBytesRead: PAGE_BYTES });
	},
});

export const stage_metadata = internalMutation({
	args: {
		...guard_args,
		position: v.number(),
		done: v.boolean(),
		values: v.array(app_convex_schema.tables.files_index_candidates.validator.members[1].fields.value),
	},
	returns: v.union(v.object(guard_args), v.null()),
	handler: async (ctx, args) => {
		const run = await current(ctx, args);
		if (!run || run.phase !== "build_metadata" || run.nextPosition !== args.position) return null;
		if (!(await workspace_live(ctx, run))) {
			await progress(ctx, run, { phase: "cleanup_candidates", aborting: true });
			return null;
		}
		for (const [index, value] of args.values.entries())
			await ctx.db.insert("files_index_candidates", {
				runId: run._id,
				kind: "metadata",
				position: args.position + index,
				value,
			});
		if (args.done)
			await files_index_db_ticket(ctx, {
				organizationId: run.organizationId,
				workspaceId: run.workspaceId,
				owner: { kind: "index", runId: run._id },
			});
		return await progress(
			ctx,
			run,
			args.done ? { phase: "ready", nextPosition: 0 } : { nextPosition: args.position + args.values.length },
			{ schedule: args.done },
		);
	},
});

export const prepare_metadata = internalAction({
	args: guard_args,
	returns: v.null(),
	handler: async (ctx, args) => {
		const input = await ctx.runQuery(internal.files_index.read_input, args);
		if (!input) {
			await ctx.runMutation(internal.files_index.advance, args);
			return null;
		}
		const { run, entries } = input;
		const full = files_metadata_extract_entries(entries);
		const values = files_metadata_search_values(full);
		const entryIndexes = new Map(values.fields.map((field, index) => [field, index]));
		if (run.textKind === "rich_text" && run.contentHeadId) {
			let cursor: string | null = null;
			const text: string[] = [];
			while (true) {
				const page: PaginationResult<Doc<"files_text_chunks">> | null = await ctx.runQuery(
					internal.files_index.read_text,
					{ ...args, cursor },
				);
				if (!page) {
					await ctx.runMutation(internal.files_index.advance, args);
					return null;
				}
				text.push(...page.page.map((chunk) => chunk.textChunk));
				if (page.isDone) break;
				cursor = page.continueCursor;
			}
			const frontmatter = files_metadata_preflight_frontmatter(text.join(""));
			if (frontmatter._yay) {
				full.fields.push(...frontmatter._yay.fullMetadata.fields);
				full.values.push(...frontmatter._yay.fullMetadata.values);
				values.fields.push(...frontmatter._yay.metadata.fields);
				values.values.push(...frontmatter._yay.metadata.values);
			} else console.warn("Skipped invalid frontmatter while indexing", { runId: run._id, error: frontmatter._nay });
		}
		const grouped = new Map<string, files_metadata_Value[]>();
		const groupedFull = new Map<string, files_metadata_Value[]>();
		for (const [source, target] of [
			[values.values, grouped],
			[full.values, groupedFull],
		] as const)
			for (const value of source) {
				const group = target.get(value.fieldPath) ?? [];
				group.push(value);
				target.set(value.fieldPath, group);
			}
		const scope = {
			path: run.placement.path,
			treePath: run.placement.treePath,
			archiveOperationId: run.placement.archiveOperationId ?? undefined,
		};
		const docs: MetadataValue[] = [];
		for (const fieldPath of values.fields) {
			const sort = files_sort_value_of(grouped.get(fieldPath) ?? []);
			const plain = (groupedFull.get(fieldPath) ?? []).filter((value) => value.valueKind !== "maybe_date");
			const preview = plain[0] ? files_metadata_scalar_preview(plain[0].value) : null;
			docs.push({
				...scope,
				fieldPath,
				docKind: "field",
				parentId: run.placement.parentId,
				nodeKind: run.placement.kind,
				isRestrictedScopeRoot: run.placement.isRestrictedScopeRoot,
				name: run.placement.name,
				sortName: run.placement.sortName,
				...(sort && preview
					? {
							sortValue: sort.sortValue,
							sortDisplayValue: preview.value,
							sortDisplayValueIsPreview: preview.isPreview || plain.length > 1,
						}
					: {}),
			});
		}
		for (const value of values.values)
			docs.push({
				...scope,
				fieldPath: value.fieldPath,
				entryIndex: entryIndexes.get(value.fieldPath),
				...files_metadata_value_doc_payload(value),
			});
		let guard: Guard | null = args;
		let position = run.nextPosition;
		while (guard) {
			const page: MetadataValue[] = [];
			let bytes = 0;
			while (position + page.length < docs.length && page.length < PAGE_SIZE) {
				const value = docs[position + page.length]!;
				const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
				if (page.length > 0 && bytes + size > PAGE_BYTES) break;
				page.push(value);
				bytes += size;
			}
			const done = position + page.length === docs.length;
			guard = await ctx.runMutation(internal.files_index.stage_metadata, { ...guard, position, values: page, done });
			if (done) break;
			position += page.length;
		}
		return null;
	},
});

async function admit(ctx: MutationCtx, run: Run) {
	if (!(await workspace_live(ctx, run)))
		return await progress(ctx, run, { phase: "cleanup_candidates", aborting: true });
	const ticket = await files_index_db_ticket(ctx, {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		owner: { kind: "index", runId: run._id },
	});
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", run.organizationId).eq("workspaceId", run.workspaceId))
		.unique();
	if (!ticket.first || slot?.cohortId || (slot && "indexRunId" in slot)) {
		await ctx.scheduler.runAfter(0, internal.files_index.wake, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
		});
		return await progress(ctx, run, {}, { schedule: false });
	}
	const node = await files_saved_placement_db_get_node(ctx.db, run.fileNodeId);
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", run.fileNodeId))
		.unique();
	if (
		!node ||
		!state ||
		state.movePublication ||
		state.activeRunId !== run._id ||
		state.publishedRevision >= run.indexRevision ||
		!same_placement(node, run.placement)
	)
		return await progress(ctx, run, { phase: "cleanup_candidates", aborting: true, nextPosition: 0 });
	const generation = (slot?.generation ?? 0) + 1;
	const fields = {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		cohortId: null,
		indexRunId: run._id,
		generation,
		visibleView: "before" as const,
		migrationDirection: "to_cohort" as const,
	};
	if (slot) await ctx.db.replace("files_move_workspace_slots", slot._id, fields);
	else await ctx.db.insert("files_move_workspace_slots", fields);
	await files_saved_placement_db_bump_search_generation(ctx, run);
	return await progress(ctx, run, {
		phase: "tag_text",
		slotGeneration: generation,
		previousHeadId: state.publishedHeadId,
		cursor: null,
	});
}

async function slot_for(ctx: MutationCtx, run: Run) {
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", run.organizationId).eq("workspaceId", run.workspaceId))
		.unique();
	if (!slot || !("indexRunId" in slot) || slot.indexRunId !== run._id || slot.generation !== run.slotGeneration)
		throw should_never_happen("Index publisher lost its workspace slot", { runId: run._id });
	return slot;
}

async function tag_old(ctx: MutationCtx, run: Run) {
	await slot_for(ctx, run);
	const page =
		run.phase === "tag_text"
			? await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", run.fileNodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES })
			: await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", run.fileNodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES });
	for (const item of page.page) {
		const table = "plainTextChunk" in item ? "files_plain_text_chunks" : "files_metadata_docs";
		await ctx.db.patch(table, item._id, { moveView: { cohortId: run._id, view: "before" } });
	}
	await files_content_heads_db_flush(ctx);
	await files_saved_placement_db_bump_search_generation(ctx, run);
	return await progress(
		ctx,
		run,
		page.isDone ? { phase: run.phase === "tag_text" ? "tag_metadata" : "install_text", cursor: null } : {},
	);
}

async function install(ctx: MutationCtx, run: Run) {
	await slot_for(ctx, run);
	const kind = run.phase === "install_text" ? "text" : "metadata";
	const page = await ctx.db
		.query("files_index_candidates")
		.withIndex("by_run_kind_position", (q) => q.eq("runId", run._id).eq("kind", kind))
		.paginate({ cursor: run.cursor, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES });
	const head = run.contentHeadId ? await ctx.db.get("files_saved_content_heads", run.contentHeadId) : null;
	if (run.contentHeadId && !head) throw should_never_happen("Index candidate lost its source", { runId: run._id });
	const db = head ? files_content_heads_db_for_head(ctx, head) : ctx.db;
	const scope = {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		fileNodeId: run.fileNodeId,
		sourceKind: "committed" as const,
		yjsSequence: run.yjsSequence,
		moveView: { cohortId: run._id, view: "after" as const },
	};
	for (const item of page.page) {
		if (item.kind === "text") await db.insert("files_plain_text_chunks", { ...scope, ...item.value });
		else
			await db.insert("files_metadata_docs", {
				...scope,
				...item.value,
				restrictedScopeNodeId: run.placement.restrictedScopeNodeId,
			});
	}
	await files_content_heads_db_flush(ctx);
	await files_saved_placement_db_bump_search_generation(ctx, run);
	return await progress(
		ctx,
		run,
		page.isDone
			? { phase: kind === "text" ? "install_metadata" : "publish", cursor: null }
			: { cursor: page.continueCursor },
	);
}

async function publish(ctx: MutationCtx, run: Run) {
	const slot = await slot_for(ctx, run);
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", run.fileNodeId))
		.unique();
	const node = await files_saved_placement_db_get_node(ctx.db, run.fileNodeId);
	const valid =
		(await workspace_live(ctx, run)) &&
		state?.activeRunId === run._id &&
		!state.movePublication &&
		state.publishedRevision < run.indexRevision &&
		node &&
		same_placement(node, run.placement);
	if (valid)
		await ctx.db.patch("files_index_states", state._id, {
			publishedRevision: run.indexRevision,
			publishedHeadId: run.contentHeadId,
		});
	await ctx.db.patch("files_move_workspace_slots", slot._id, {
		visibleView: valid ? "after" : "before",
		migrationDirection: "to_normal",
	});
	await files_saved_placement_db_bump_search_generation(ctx, run);
	return await progress(ctx, run, { phase: "cleanup_text", published: Boolean(valid), aborting: !valid, cursor: null });
}

async function cleanup(ctx: MutationCtx, run: Run) {
	await slot_for(ctx, run);
	const table = run.phase === "cleanup_text" ? "files_plain_text_chunks" : "files_metadata_docs";
	const kept = run.published ? "after" : "before";
	const page = await ctx.db
		.query(table)
		.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", run._id))
		.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES });
	for (const item of page.page) {
		if (item.moveView?.view === kept) await ctx.db.patch(table, item._id, { moveView: undefined });
		else await ctx.db.delete(table, item._id);
	}
	await files_content_heads_db_flush(ctx);
	await files_saved_placement_db_bump_search_generation(ctx, run);
	return await progress(
		ctx,
		run,
		page.isDone
			? { phase: table === "files_plain_text_chunks" ? "cleanup_metadata" : "cleanup_candidates", cursor: null }
			: {},
	);
}

async function finish(ctx: MutationCtx, run: Run) {
	const candidates = await ctx.db
		.query("files_index_candidates")
		.withIndex("by_run", (q) => q.eq("runId", run._id))
		.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: PAGE_BYTES });
	for (const item of candidates.page) await ctx.db.delete("files_index_candidates", item._id);
	if (!candidates.isDone) return await progress(ctx, run, {});
	const input = await ctx.db
		.query("files_index_inputs")
		.withIndex("by_run", (q) => q.eq("runId", run._id))
		.unique();
	if (input) await ctx.db.delete("files_index_inputs", input._id);
	if (run.slotGeneration !== null) {
		const slot = await slot_for(ctx, run);
		await ctx.db.replace("files_move_workspace_slots", slot._id, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			cohortId: null,
			generation: slot.generation,
		});
		await files_saved_placement_db_bump_search_generation(ctx, run);
	}
	await files_index_db_release_ticket(ctx, {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		owner: { kind: "index", runId: run._id },
	});
	await ctx.db.delete("files_index_runs", run._id);
	if (run.slotGeneration !== null)
		await files_pending_overlay_db_schedule_saved_places(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			_id: run.fileNodeId,
		}, { fieldsChanged: true });
	if (await files_pending_overlay_db_has_saved_scope_job(ctx, run.fileNodeId))
		await files_pending_overlay_db_schedule_saved_scope(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			_id: run.fileNodeId,
		});
	for (const headId of new Set([run.contentHeadId, run.previousHeadId]))
		if (headId) await ctx.scheduler.runAfter(0, internal.files_content_saves.retire, { headId });
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", run.fileNodeId))
		.unique();
	if (state?.activeRunId === run._id) {
		await ctx.db.patch("files_index_states", state._id, {
			activeRunId: null, needsRun: state.requestedRevision > state.publishedRevision,
			nextAttemptAt: Date.now() + RECOVER_MS,
		});
		if (state.requestedRevision > state.publishedRevision)
			await ctx.scheduler.runAfter(0, internal.files_index.start, { nodeId: run.fileNodeId });
	}
	return null;
}

export const advance = internalMutation({
	args: guard_args,
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await current(ctx, args);
		if (!run) return null;
		if (!run.published && !run.aborting && !(await workspace_live(ctx, run))) {
			if (run.slotGeneration !== null) {
				const slot = await slot_for(ctx, run);
				await ctx.db.patch("files_move_workspace_slots", slot._id, {
					visibleView: "before",
					migrationDirection: "to_normal",
				});
			}
			await progress(ctx, run, {
				phase: run.slotGeneration === null ? "cleanup_candidates" : "cleanup_text",
				aborting: true,
				cursor: null,
			});
			return null;
		}
		switch (run.phase) {
			case "build_text":
				await build_text(ctx, run);
				break;
			case "build_metadata":
				await schedule(ctx, run);
				break;
			case "ready":
				await admit(ctx, run);
				break;
			case "tag_text":
			case "tag_metadata":
				await tag_old(ctx, run);
				break;
			case "install_text":
			case "install_metadata":
				await install(ctx, run);
				break;
			case "publish":
				await publish(ctx, run);
				break;
			case "cleanup_text":
			case "cleanup_metadata":
				await cleanup(ctx, run);
				break;
			case "cleanup_candidates":
				await finish(ctx, run);
				break;
		}
		return null;
	},
});

export const wake = internalMutation({
	args: { organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId))
			.unique();
		if (slot?.cohortId || (slot && "indexRunId" in slot)) return null;
		const ticket = await ctx.db
			.query("files_index_tickets")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!ticket) return null;
		const owner = ticket.owner;
		let valid = false;
		if (owner.kind === "index") {
			const run = await ctx.db.get("files_index_runs", owner.runId);
			valid = run?.phase === "ready";
			if (valid && run) await schedule(ctx, run);
		} else if (owner.kind === "transfer") {
			const run = await ctx.db.get("files_transfer_runs", owner.runId);
			const item = await ctx.db.get("files_transfer_items", owner.itemId);
			const activity = await activities_db_get_by_source_id(ctx, owner.runId);
			valid = Boolean(
				activity &&
				activities_is_active(activity.status) &&
				run?.revision === owner.fence &&
				item?.runId === run._id &&
				item.attempt === owner.attemptFence &&
				item.state === "pending",
			);
			if (valid) await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: owner.runId });
		} else {
			const run = await ctx.db.get("files_pending_update_runs", owner.runId);
			const unit = await ctx.db.get("files_pending_update_run_units", owner.unitId);
			const activity = await activities_db_get_by_source_id(ctx, owner.runId);
			valid = Boolean(
				activity &&
				activities_is_active(activity.status) &&
				run?.fence === owner.fence &&
				run.planEpoch === owner.planEpoch &&
				run.step === "running" &&
				unit?.runId === run._id &&
				unit.attemptFence === owner.attemptFence &&
				unit.status === "preparing",
			);
			if (valid) await files_pending_update_runs_db_resume_parked(ctx, { runId: owner.runId, fence: owner.fence });
		}
		if (!valid) {
			await ctx.db.delete("files_index_tickets", ticket._id);
			await ctx.scheduler.runAfter(0, internal.files_index.wake, args);
		} else if (owner.kind !== "index") await ctx.scheduler.runAfter(1000, internal.files_index.wake, args);
		return null;
	},
});

export const recover = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await ctx.scheduler.runAfter(0, internal.files_index.recover_requests, { cutoff: Date.now(), cursor: null });
		await ctx.scheduler.runAfter(0, internal.files_index.recover_page, {
			cutoff: Date.now(),
			phase: "build_text",
			cursor: null,
		});
		return null;
	},
});

/**
 * A failed first callback has no run yet. Visit only idle requests whose wake-up is overdue.
 */
export const recover_requests = internalMutation({
	args: { cutoff: v.number(), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db.query("files_index_states")
			.withIndex("by_needsRun_nextAttemptAt", (q) => q.eq("needsRun", true).lte("nextAttemptAt", args.cutoff))
			.paginate({ cursor: args.cursor, numItems: 8 });
		for (const state of page.page) {
			await ctx.scheduler.runAfter(0, internal.files_index.start, { nodeId: state.fileNodeId });
			await ctx.db.patch("files_index_states", state._id, { nextAttemptAt: Date.now() + RECOVER_MS });
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.files_index.recover_requests, { ...args, cursor: page.continueCursor });
		return null;
	},
});

export const recover_page = internalMutation({
	args: {
		cutoff: v.number(),
		phase: app_convex_schema.tables.files_index_runs.validator.fields.phase,
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const phases = [
			"build_text",
			"build_metadata",
			"ready",
			"tag_text",
			"tag_metadata",
			"install_text",
			"install_metadata",
			"publish",
			"cleanup_text",
			"cleanup_metadata",
			"cleanup_candidates",
		] as const;
		if (args.phase === "complete") return null;
		const page = await ctx.db
			.query("files_index_runs")
			.withIndex("by_phase_nextAttemptAt", (q) => q.eq("phase", args.phase).lte("nextAttemptAt", args.cutoff))
			.paginate({ cursor: args.cursor, numItems: 8 });
		for (const run of page.page) {
			const job = run.scheduledId ? await ctx.db.system.get(run.scheduledId) : null;
			if (job?.state.kind === "pending" || job?.state.kind === "inProgress") continue;
			// Recovery keeps the same publisher. A late action loses its old generation.
			const next = { ...run, generation: run.generation + 1 };
			if (job?.state.kind === "failed")
				console.error("Resuming failed saved index", { runId: run._id, phase: run.phase, error: job.state });
			await ctx.db.patch("files_index_runs", run._id, {
				generation: next.generation,
				error: job?.state.kind === "failed" ? "Scheduled index step failed" : null,
			});
			await schedule(ctx, next);
		}
		const phase = page.isDone ? phases[phases.indexOf(args.phase) + 1] : args.phase;
		if (phase)
			await ctx.scheduler.runAfter(0, internal.files_index.recover_page, {
				...args,
				phase,
				cursor: page.isDone ? null : page.continueCursor,
			});
		return null;
	},
});
