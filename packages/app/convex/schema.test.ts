import { describe, expect, test } from "vitest";
import app_convex_schema from "./schema.ts";

describe("app_convex_schema", () => {
	test("keeps every index name at 64 characters or fewer", () => {
		// Convex refuses a longer name only at push time, after TypeScript and every other test passed.
		// `export()` is the JSON the Convex CLI pushes. It is marked internal, so it has no type.
		const exported = JSON.parse((app_convex_schema as unknown as { export: () => string }).export()) as {
			tables: Array<{
				tableName: string;
				indexes: Array<{ indexDescriptor: string }>;
				searchIndexes: Array<{ indexDescriptor: string }>;
				vectorIndexes: Array<{ indexDescriptor: string }>;
			}>;
		};
		const names = exported.tables.flatMap((table) =>
			[...table.indexes, ...table.searchIndexes, ...table.vectorIndexes].map(
				(index) => `${table.tableName}.${index.indexDescriptor}`,
			),
		);

		expect(names).toContain("files_pending_places.search_name");
		expect(names).toContain("files_share_rows.by_org_ws_principal_parent_kind_archive_updatedAt_sortName_name");
		expect(names.filter((name) => name.split(".")[1]!.length > 64)).toEqual([]);
	});
});
