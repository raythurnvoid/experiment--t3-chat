import { expect, test } from "vitest";
import { files_metadata_folder_range_fits, files_metadata_saved_prefix } from "./files-metadata-index.ts";

const tenant = { organizationId: "o", workspaceId: "w" };
const plan = { op: "exists", fieldPath: "f" } as const;

test("existence counts its missing kind and value at the exact saved area boundary", () => {
	const fields = files_metadata_saved_prefix(tenant, {}, plan, null);
	expect(fields.slice(-3)).toEqual([
		["eq", "valueKind", undefined],
		["eq", "restrictedScopeNodeId", null],
		["eq", "searchValue", undefined],
	]);
	// 3+3 tenant, 11 source, 3 missing tags, 7 doc kind, 3 field, 3 missing/null fields.
	const path = "/" + "x".repeat(2462) + "/";
	const fits = (treePath: string) =>
		files_metadata_folder_range_fits(tenant, plan, { start: { treePath, scopeNodeId: null }, sources: [{}] }, null);
	expect(fits(path)).toBe(true);
	expect(fits("/x" + path.slice(1))).toBe(false);
	const file = { treePath: path.slice(0, -1), scopeNodeId: null, kind: "file" as const };
	expect(
		files_metadata_folder_range_fits(tenant, plan, { start: file, sources: [{}] }, null),
		"the exclusive end of a single file range must also fit",
	).toBe(false);
});

test("the first page measures each actual saved area, Move view and owner path", () => {
	const start = { treePath: "/a/", scopeNodeId: null };
	const eq = { op: "eq", fieldPath: "f", value: "界".repeat(805) } as const;
	const fits = (scopeNodeId: string | null, sources: { cohortId?: string; view?: string }[], ownerPath?: string) =>
		files_metadata_folder_range_fits(
			tenant,
			eq,
			{ start: { ...start, scopeNodeId }, sources },
			ownerPath ? { userId: "u".repeat(32), treePath: ownerPath, sources: [{}] } : null,
		);
	expect(fits(null, [{}])).toBe(true);
	expect(fits("r".repeat(48), [{}])).toBe(false);
	expect(fits(null, [{}, { cohortId: "m".repeat(48), view: "after" }])).toBe(false);
	expect(fits(null, [{}], "/" + "p".repeat(48) + "/")).toBe(false);
	expect(files_metadata_folder_range_fits(tenant, eq, null, { userId: "u", treePath: "/a/", sources: [{}] })).toBe(
		true,
	);
});
