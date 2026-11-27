import type { files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import type { files_index_range_apply } from "./files-index-range.ts";
import { files_tree_walk_frame_end } from "./files-tree-walk.ts";

type Bound = Parameters<typeof files_index_range_apply>[1][number];
type Source = { cohortId?: string; view?: string };
type Tenant = { organizationId: string; workspaceId: string };

// Keep the search query and the first-page byte check on the same physical key.
export function files_metadata_saved_prefix(
	tenant: Tenant,
	source: Source,
	plan: files_metadata_SearchPlan,
	area: string | null | undefined,
): Bound[] {
	const kind =
		plan.op === "exists"
			? undefined
			: plan.op === "eq"
				? typeof plan.value
				: plan.op === "prefix"
					? "string"
					: plan.valueKind;
	const fields: Bound[] = [
		["eq", "organizationId", tenant.organizationId],
		["eq", "workspaceId", tenant.workspaceId],
		["eq", "sourceKind", "committed"],
		["eq", "moveView.cohortId", source.cohortId],
		["eq", "moveView.view", source.view],
		["eq", "archiveOperationId", undefined],
		["eq", "docKind", plan.op === "exists" ? "field" : "value"],
		["eq", "fieldPath", plan.fieldPath],
		["eq", "valueKind", kind],
	];
	if (area !== undefined) fields.push(["eq", "restrictedScopeNodeId", area]);
	if (plan.op === "eq" || plan.op === "exists")
		fields.push(["eq", "searchValue", plan.op === "eq" ? plan.value : undefined]);
	return fields;
}

export function files_metadata_folder_range_fits(
	tenant: Tenant,
	plan: Extract<files_metadata_SearchPlan, { op: "eq" | "exists" }>,
	saved: { start: { treePath: string; scopeNodeId: string | null; kind?: "file" | "folder" }; sources: Source[] } | null,
	owner: { treePath: string; userId: string; sources: Source[] } | null,
) {
	const bounds = [];
	if (saved)
		for (const source of saved.sources)
			bounds.push([
				...files_metadata_saved_prefix(tenant, source, plan, saved.start.scopeNodeId).map((field) => field[2]),
				files_tree_walk_frame_end({ treePath: saved.start.treePath, kind: saved.start.kind ?? "folder" }),
			]);
	if (owner)
		for (const source of owner.sources)
			bounds.push([
				tenant.organizationId,
				tenant.workspaceId,
				owner.userId,
				source.cohortId,
				source.view,
				true,
				plan.op === "exists" ? "field" : "value",
				plan.fieldPath,
				...(plan.op === "eq" ? [typeof plan.value, plan.value] : []),
				owner.treePath,
			]);
	// The exclusive end is as long as the start for folders and two encoded bytes longer for a file.
	return bounds.every((fields) => {
		let bytes = 0;
		for (const value of fields) {
			if (typeof value === "string") bytes += 2 + files_get_utf8_byte_size(value.replaceAll("\0", "\0\0"));
			else bytes += typeof value === "number" ? 9 : 1;
		}
		return bytes < 2500;
	});
}

export function files_metadata_typed_fields(doc: { searchValue?: string | number | boolean }) {
	const value = doc.searchValue;
	return {
		stringValue: typeof value === "string" ? value : undefined,
		numberValue: typeof value === "number" ? value : undefined,
		booleanValue: typeof value === "boolean" ? value : undefined,
	};
}
