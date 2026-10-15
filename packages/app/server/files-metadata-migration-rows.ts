// Push B only. Check each visible owner's complete selected metadata range.
import type { Doc } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { convex_error } from "./convex-utils.ts";
import { files_saved_placement_db_get_node, files_saved_placement_db_get_node_view } from "./files-saved-placement.ts";
import {
	files_metadata_extract_entries,
	files_metadata_scalar_preview,
	files_metadata_search_values,
} from "../shared/files-metadata.ts";
import { files_sort_value_of } from "../shared/files-sort.ts";

async function read_map(db: QueryCtx["db"], owner: Doc<"files_metadata_maps">["owner"]) {
	return await db
		.query("files_metadata_maps")
		.withIndex("by_owner", (q) => q.eq("owner.kind", owner.kind).eq("owner.id", owner.id))
		.unique();
}

function row_value(doc: Doc<"files_metadata_docs">) {
	if (doc.valueKind === "string") return doc.stringValue;
	if (doc.valueKind === "number" || doc.valueKind === "maybe_date") return doc.numberValue;
	if (doc.valueKind === "boolean") return doc.booleanValue;
	return undefined;
}

export async function metadata_migration_audit_saved_rows(ctx: QueryCtx, source: Doc<"files_nodes">) {
	const map = await read_map(ctx.db, { kind: "saved", id: source._id });
	const node = await files_saved_placement_db_get_node(ctx.db, source._id);
	if (!node) {
		// An allocated output is hidden until publication. Its body must match the exact private source.
		if (source.publishedFromPrivateNodeId && source.moveCohortId) {
			const cohort = await ctx.db.get("files_move_cohorts", source.moveCohortId);
			const privateNode = await ctx.db.get("files_pending_nodes", source.publishedFromPrivateNodeId);
			const record = await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", source.moveCohortId!).eq("nodeId", source._id))
				.unique();
			if (
				!cohort ||
				!privateNode ||
				record?.role !== "allocated" ||
				cohort.userId !== privateNode.userId ||
				privateNode.organizationId !== source.organizationId ||
				privateNode.workspaceId !== source.workspaceId
			)
				throw convex_error({ message: `Hidden metadata has no exact allocation: ${source._id}` });
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", privateNode.organizationId)
						.eq("workspaceId", privateNode.workspaceId)
						.eq("userId", privateNode.userId)
						.eq("target.kind", "private")
						.eq("target.id", privateNode._id),
				)
				.unique();
			if (!proposal?.createIntent)
				throw convex_error({ message: `Hidden metadata has no private intent: ${source._id}` });
			if (record.itemId) {
				const item = await ctx.db.get("files_move_cohort_items", record.itemId);
				if (
					!item ||
					item.cohortId !== cohort._id ||
					item.nodeRecordId !== record._id ||
					item.pendingUpdateId !== proposal._id ||
					item.target.kind !== "private" ||
					item.target.id !== privateNode._id
				)
					throw convex_error({ message: `Hidden metadata has no exact cohort item: ${source._id}` });
			}
			const pending = await read_map(ctx.db, { kind: "pending", id: proposal._id });
			if (JSON.stringify(map?.entries ?? []) !== JSON.stringify(pending?.entries ?? []))
				throw convex_error({ message: `Hidden metadata differs from its private source: ${source._id}` });
		}
		return "hidden" as const;
	}
	const selected = await files_saved_placement_db_get_node_view(ctx.db, source._id);
	const views = selected ? [undefined, selected] : [undefined];
	const docs = (
		await Promise.all(
			views.map((moveView) =>
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", source.organizationId)
							.eq("workspaceId", source.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", source._id)
							.eq("moveView.cohortId", moveView?.cohortId)
							.eq("moveView.view", moveView?.view)
							.gte("fieldPath", "metadata.")
							.lt("fieldPath", "metadata/"),
					)
					.collect(),
			),
		)
	).flat();
	const full = files_metadata_extract_entries(map?.entries ?? []);
	const search = files_metadata_search_values(full);
	const expectedValues = search.values.map((value) => ({
		fieldPath: value.fieldPath,
		valueKind: value.valueKind,
		value: value.value,
		entryIndex: search.fields.indexOf(value.fieldPath),
	}));
	const actualValues = docs
		.filter((doc) => doc.docKind === "value")
		.map((doc) => ({
			fieldPath: doc.fieldPath,
			valueKind: doc.valueKind,
			value: row_value(doc),
			entryIndex: doc.entryIndex,
		}));
	const ordered = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
	if (JSON.stringify(ordered(expectedValues)) !== JSON.stringify(ordered(actualValues)))
		throw convex_error({ message: `Metadata search rows differ from the full map: ${source._id}` });
	const fields = docs.filter(
		(doc): doc is Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }> =>
			doc.sourceKind === "committed" && doc.docKind === "field",
	);
	if (JSON.stringify(fields.map((doc) => doc.fieldPath).sort()) !== JSON.stringify([...search.fields].sort()))
		throw convex_error({ message: `Metadata field rows differ from the full map: ${source._id}` });
	for (const field of fields) {
		const values = search.values.filter((value) => value.fieldPath === field.fieldPath);
		const plain = full.values.filter(
			(value) => value.fieldPath === field.fieldPath && value.valueKind !== "maybe_date",
		);
		const preview = files_metadata_scalar_preview(plain[0]!.value);
		if (
			JSON.stringify(field.sortValue) !== JSON.stringify(files_sort_value_of(values)?.sortValue) ||
			field.sortDisplayValue !== preview.value ||
			(field.sortDisplayValueIsPreview ?? false) !== preview.isPreview ||
			field.parentId !== node.parentId ||
			field.name !== node.name ||
			field.nodeKind !== node.kind
		)
			throw convex_error({ message: `Metadata table preview differs from the full map: ${source._id}` });
	}
	return selected ? ("selected" as const) : ("normal" as const);
}
