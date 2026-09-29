import { describe, expect, test } from "vitest";
import { files_table_column_is_valid, files_table_DEFAULT_COLUMNS, files_table_MAX_COLUMNS } from "./files-table.ts";

describe("files_table_column_is_valid", () => {
	test.each(["name", "updated_by", "updated", "created", "type", "size", "metadata.rank", "frontmatter.rank"])(
		"accepts %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(true),
	);
	test.each(["actions", "rank", "metadata.", "metadata.invalid key", "metadata." + "a".repeat(300)])(
		"rejects %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(false),
	);
	test("keeps the default three data columns within the cap", () => {
		expect(files_table_DEFAULT_COLUMNS).toEqual(["name", "updated_by", "updated"]);
		expect(files_table_MAX_COLUMNS).toBe(8);
	});
});
