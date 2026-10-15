// One-time metadata migration. Remove after the strict schema passes.
import type { Doc } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { convex_error } from "./convex-utils.ts";
import {
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_scalar_preview,
	files_metadata_validate_entries,
	type files_metadata_Entry,
} from "../shared/files-metadata.ts";

type MapOwner = Doc<"files_metadata_maps">["owner"];
type MapScope = Pick<Doc<"files_metadata_maps">, "organizationId" | "workspaceId">;
type LegacyIntent = NonNullable<Doc<"files_pending_updates">["createIntent"]> & { metadata?: files_metadata_Entry[] };
export type LegacyProposal = Omit<Doc<"files_pending_updates">, "createIntent"> & { createIntent?: LegacyIntent };
export type LegacyCaptureItem = Omit<Doc<"files_transfer_items">, "capture"> & {
	capture: (NonNullable<Doc<"files_transfer_items">["capture"]> & { metadata?: files_metadata_Entry[] }) | null;
};

function fail(message: string, id: string): never {
	throw convex_error({ message: `${message}: ${id}` });
}

function checked_entries(entries: files_metadata_Entry[], id: string) {
	const checked = files_metadata_validate_entries(entries);
	if (checked._nay) fail("Metadata source does not fit the final map", id);
	return checked._yay.entries;
}

async function read_map(db: QueryCtx["db"], owner: MapOwner) {
	return await db
		.query("files_metadata_maps")
		.withIndex("by_owner", (q) => q.eq("owner.kind", owner.kind).eq("owner.id", owner.id))
		.unique();
}

function same_entries(left: files_metadata_Entry[], right: files_metadata_Entry[]) {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Copy once. An existing different map is an error, never a value to overwrite. */
export async function metadata_migration_copy_map(
	ctx: MutationCtx,
	scope: MapScope,
	owner: MapOwner,
	entries: files_metadata_Entry[],
) {
	checked_entries(entries, owner.id);
	const stored = await read_map(ctx.db, owner);
	if (stored) {
		if (
			stored.organizationId !== scope.organizationId ||
			stored.workspaceId !== scope.workspaceId ||
			!same_entries(stored.entries, entries)
		)
			fail("Metadata map differs from its source", owner.id);
		return;
	}
	if (!entries.length) return;
	await ctx.db.insert("files_metadata_maps", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		owner,
		entries,
		revision: 1,
	});
}

/** Keep the old value-doc order. Field docs and date companions do not own values. */
export function metadata_migration_entries_from_docs(docs: Doc<"files_metadata_docs">[]) {
	return docs
		.filter((doc) => doc.docKind === "value" && doc.valueKind !== "maybe_date")
		.sort((left, right) => (left.entryIndex ?? 0) - (right.entryIndex ?? 0))
		.map((doc) => {
			const key = doc.fieldPath.slice(files_metadata_METADATA_FIELD_PREFIX.length);
			if (doc.valueKind === "string" && doc.stringValue !== undefined) return { key, value: doc.stringValue };
			if (doc.valueKind === "number" && doc.numberValue !== undefined) return { key, value: doc.numberValue };
			if (doc.valueKind === "boolean" && doc.booleanValue !== undefined) return { key, value: doc.booleanValue };
			return fail("Metadata value doc has no matching scalar", doc._id);
		});
}

async function source_docs(
	db: QueryCtx["db"],
	node: Doc<"files_nodes">,
	moveView?: Doc<"files_metadata_docs">["moveView"],
) {
	// One old map writes at most 384 docs. This is one owner, not a folder or workspace scan.
	return await db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
			q
				.eq("organizationId", node.organizationId)
				.eq("workspaceId", node.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", node._id)
				.eq("moveView.cohortId", moveView?.cohortId)
				.eq("moveView.view", moveView?.view)
				.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
				.lt("fieldPath", "metadata/"),
		)
		.collect();
}

/** Preserve the exact selected old ranges. An allocated output may have no index docs yet. */
export async function metadata_migration_saved_source(ctx: QueryCtx, node: Doc<"files_nodes">) {
	const cohort = node.moveCohortId ? await ctx.db.get("files_move_cohorts", node.moveCohortId) : null;
	if (node.moveCohortId && !cohort) fail("Saved metadata has no Move cohort", node._id);
	if (cohort && (cohort.organizationId !== node.organizationId || cohort.workspaceId !== node.workspaceId))
		fail("Saved metadata has the wrong Move scope", node._id);
	const record = cohort
		? await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
				.unique()
		: null;
	if (cohort && record?.role === "allocated" && cohort.phase !== "complete") {
		if (!node.publishedFromPrivateNodeId) fail("Allocated metadata has no private source", node._id);
		const privateNode = await ctx.db.get("files_pending_nodes", node.publishedFromPrivateNodeId);
		if (
			!privateNode ||
			privateNode.organizationId !== node.organizationId ||
			privateNode.workspaceId !== node.workspaceId ||
			privateNode.userId !== cohort.userId
		)
			fail("Allocated metadata has the wrong private source", node._id);
		const proposal = (await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", privateNode.organizationId)
					.eq("workspaceId", privateNode.workspaceId)
					.eq("userId", privateNode.userId)
					.eq("target.kind", "private")
					.eq("target.id", privateNode._id),
			)
			.unique()) as LegacyProposal | null;
		if (!proposal?.createIntent || proposal.createIntent.metadata === undefined)
			fail("Allocated metadata has no full private map", node._id);
		if (record.itemId) {
			const item = await ctx.db.get("files_move_cohort_items", record.itemId);
			if (
				!item ||
				item.cohortId !== cohort._id ||
				item.nodeRecordId !== record._id ||
				item.target.kind !== "private" ||
				item.target.id !== privateNode._id ||
				item.pendingUpdateId !== proposal._id
			)
				fail("Allocated metadata has the wrong cohort item", node._id);
		}
		// itemId is null between allocation and item insertion. The node pointer still names the source.
		return { entries: checked_entries(proposal.createIntent.metadata, proposal._id), source: "allocated" as const };
	}
	const moveView = cohort ? { cohortId: cohort._id, view: cohort.visibleView } : undefined;
	const docs = [...(await source_docs(ctx.db, node)), ...(moveView ? await source_docs(ctx.db, node, moveView) : [])];
	const entries = metadata_migration_entries_from_docs(docs);
	return { entries: checked_entries(entries, node._id), source: "indexed" as const };
}

export async function metadata_migration_backfill_saved(ctx: MutationCtx, node: Doc<"files_nodes">) {
	const source = await metadata_migration_saved_source(ctx, node);
	await metadata_migration_copy_map(ctx, node, { kind: "saved", id: node._id }, source.entries);
}

export async function metadata_migration_backfill_pending(ctx: MutationCtx, proposal: LegacyProposal) {
	const entries = proposal.createIntent?.metadata;
	if (entries === undefined) return;
	const owner: MapOwner =
		proposal.target.kind === "private"
			? { kind: "pending", id: proposal._id }
			: { kind: "saved", id: proposal.target.id };
	await metadata_migration_copy_map(ctx, proposal, owner, entries);
}

export async function metadata_migration_backfill_capture(ctx: MutationCtx, item: LegacyCaptureItem) {
	const entries = item.capture?.metadata;
	if (entries === undefined) return;
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run || run.organizationId !== item.organizationId || run.workspaceId !== item.workspaceId)
		fail("Capture metadata has no exact transfer run", item._id);
	await metadata_migration_copy_map(ctx, item, { kind: "capture", id: item._id }, entries);
}

async function require_copy(db: QueryCtx["db"], scope: MapScope, owner: MapOwner, entries: files_metadata_Entry[]) {
	const stored = await read_map(db, owner);
	if (stored && (stored.organizationId !== scope.organizationId || stored.workspaceId !== scope.workspaceId))
		fail("Metadata map has the wrong scope", owner.id);
	if (!same_entries(stored?.entries ?? [], checked_entries(entries, owner.id)))
		fail("Metadata map differs from its source", owner.id);
}

/** Use this only before the switch, while old source values are still current. */
export async function metadata_migration_audit_saved(ctx: QueryCtx, node: Doc<"files_nodes">) {
	const source = await metadata_migration_saved_source(ctx, node);
	await require_copy(ctx.db, node, { kind: "saved", id: node._id }, source.entries);
	return source.source;
}

export async function metadata_migration_audit_pending(ctx: QueryCtx, proposal: LegacyProposal) {
	const entries = proposal.createIntent?.metadata;
	if (entries === undefined) return;
	const owner: MapOwner =
		proposal.target.kind === "private"
			? { kind: "pending", id: proposal._id }
			: { kind: "saved", id: proposal.target.id };
	await require_copy(ctx.db, proposal, owner, entries);
}

export async function metadata_migration_audit_capture(ctx: QueryCtx, item: LegacyCaptureItem) {
	if (item.capture?.metadata === undefined) return;
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run || run.organizationId !== item.organizationId || run.workspaceId !== item.workspaceId)
		fail("Capture metadata has no exact transfer run", item._id);
	await require_copy(ctx.db, item, { kind: "capture", id: item._id }, item.capture.metadata);
}

/** Keep existing sort keys. The new table display is a separate short preview. */
export async function metadata_migration_preview_doc(ctx: MutationCtx, doc: Doc<"files_metadata_docs">) {
	if (doc.sourceKind !== "committed" || doc.docKind !== "field" || doc.sortDisplayValue === undefined) return;
	const preview = files_metadata_scalar_preview(doc.sortDisplayValue);
	// New writes may already store a short display with its full-value flag.
	let isPreview = doc.sortDisplayValueIsPreview === true || preview.isPreview;
	if (!isPreview) {
		const values = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
				q
					.eq("organizationId", doc.organizationId)
					.eq("workspaceId", doc.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", doc.fileNodeId)
					.eq("moveView.cohortId", doc.moveView?.cohortId)
					.eq("moveView.view", doc.moveView?.view)
					.eq("fieldPath", doc.fieldPath),
			)
			.filter((q) => q.and(q.eq(q.field("docKind"), "value"), q.neq(q.field("valueKind"), "maybe_date")))
			.take(2);
		isPreview = values.length > 1;
	}
	if (doc.sortDisplayValue === preview.value && (doc.sortDisplayValueIsPreview ?? false) === isPreview) return;
	await ctx.db.patch("files_metadata_docs", doc._id, {
		sortDisplayValue: preview.value,
		sortDisplayValueIsPreview: isPreview,
	});
}

export function metadata_migration_strip_intent<T extends { createIntent?: LegacyIntent }>(header: T) {
	if (header.createIntent?.metadata === undefined) return header;
	const { metadata: _metadata, ...createIntent } = header.createIntent;
	return { ...header, createIntent };
}

export async function metadata_migration_strip_pending(ctx: MutationCtx, proposal: LegacyProposal) {
	const entries = proposal.createIntent?.metadata;
	if (entries === undefined) return;
	const owner: MapOwner =
		proposal.target.kind === "private"
			? { kind: "pending", id: proposal._id }
			: { kind: "saved", id: proposal.target.id };
	await require_copy(ctx.db, proposal, owner, entries);
	const { _id, _creationTime: _time, ...next } = metadata_migration_strip_intent(proposal);
	await ctx.db.replace("files_pending_updates", _id, next);
}

export async function metadata_migration_strip_capture(ctx: MutationCtx, item: LegacyCaptureItem) {
	if (!item.capture || item.capture.metadata === undefined) return;
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run || run.organizationId !== item.organizationId || run.workspaceId !== item.workspaceId)
		fail("Capture metadata has no exact transfer run", item._id);
	await require_copy(ctx.db, item, { kind: "capture", id: item._id }, item.capture.metadata);
	const { metadata: _metadata, ...capture } = item.capture;
	const { _id, _creationTime: _time, ...fields } = item;
	await ctx.db.replace("files_transfer_items", _id, { ...fields, capture });
}

export async function metadata_migration_audit_review(ctx: QueryCtx, item: Doc<"files_pending_update_run_items">) {
	const header = item.reviewHeader as (NonNullable<typeof item.reviewHeader> & { createIntent?: LegacyIntent }) | null;
	if (!header || header.createIntent?.metadata === undefined) return;
	const run = await ctx.db.get("files_pending_update_runs", item.runId);
	if (!run) fail("Review metadata has no run", item._id);
	if (run.step !== "finished") {
		const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
		if (
			!proposal ||
			proposal.revision !== item.reviewedRevision ||
			header.revision !== item.reviewedRevision ||
			proposal.organizationId !== run.organizationId ||
			proposal.workspaceId !== run.workspaceId ||
			proposal.userId !== run.userId ||
			header.organizationId !== run.organizationId ||
			header.workspaceId !== run.workspaceId ||
			header.userId !== run.userId ||
			header.target.kind !== item.target.kind ||
			header.target.id !== item.target.id ||
			proposal.target.kind !== item.target.kind ||
			proposal.target.id !== item.target.id
		)
			fail("Active review metadata has no exact proposal", item._id);
		const owner: MapOwner =
			header.target.kind === "private"
				? { kind: "pending", id: proposal._id }
				: { kind: "saved", id: header.target.id };
		await require_copy(ctx.db, run, owner, header.createIntent.metadata);
	}
}

export async function metadata_migration_strip_review(ctx: MutationCtx, item: Doc<"files_pending_update_run_items">) {
	await metadata_migration_audit_review(ctx, item);
	const header = item.reviewHeader as (NonNullable<typeof item.reviewHeader> & { createIntent?: LegacyIntent }) | null;
	if (!header || header.createIntent?.metadata === undefined) return;
	const { _id, _creationTime: _time, ...fields } = item;
	await ctx.db.replace("files_pending_update_run_items", _id, {
		...fields,
		reviewHeader: metadata_migration_strip_intent(header),
	});
}

export async function metadata_migration_audit_cohort(ctx: QueryCtx, item: Doc<"files_move_cohort_items">) {
	const header = item.afterProposal as
		| (NonNullable<typeof item.afterProposal> & { createIntent?: LegacyIntent })
		| null;
	if (!header || header.createIntent?.metadata === undefined) return;
	const cohort = await ctx.db.get("files_move_cohorts", item.cohortId);
	if (!cohort) fail("After-proposal metadata has no cohort", item._id);
	const proposal = item.pendingUpdateId ? await ctx.db.get("files_pending_updates", item.pendingUpdateId) : null;
	if (cohort.phase !== "complete" || proposal?.moveCohortId === cohort._id) {
		if (
			!proposal ||
			proposal.organizationId !== cohort.organizationId ||
			proposal.workspaceId !== cohort.workspaceId ||
			proposal.userId !== cohort.userId ||
			header.organizationId !== cohort.organizationId ||
			header.workspaceId !== cohort.workspaceId ||
			header.userId !== cohort.userId
		)
			fail("Active after-proposal metadata has no exact proposal", item._id);
		const owner: MapOwner =
			header.target.kind === "private"
				? { kind: "pending", id: proposal._id }
				: { kind: "saved", id: header.target.id };
		if (header.target.kind === "saved" && item.target.kind === "private") {
			const record = await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId);
			if (
				!record ||
				record.role !== "allocated" ||
				record.cohortId !== cohort._id ||
				record.itemId !== item._id ||
				record.nodeId !== header.target.id
			)
				fail("After-proposal metadata has the wrong saved output", item._id);
		} else if (header.target.kind !== item.target.kind || header.target.id !== item.target.id) {
			fail("After-proposal metadata has the wrong target", item._id);
		}
		await require_copy(ctx.db, cohort, owner, header.createIntent.metadata);
	}
}

export async function metadata_migration_strip_cohort(ctx: MutationCtx, item: Doc<"files_move_cohort_items">) {
	await metadata_migration_audit_cohort(ctx, item);
	const header = item.afterProposal as
		| (NonNullable<typeof item.afterProposal> & { createIntent?: LegacyIntent })
		| null;
	if (!header || header.createIntent?.metadata === undefined) return;
	const { _id, _creationTime: _time, ...fields } = item;
	await ctx.db.replace("files_move_cohort_items", _id, {
		...fields,
		afterProposal: metadata_migration_strip_intent(header),
	});
}
