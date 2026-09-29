import { files_sort_field_is_valid } from "./files-sort.ts";

export const files_table_DEFAULT_COLUMNS = ["name", "updated_by", "updated"];
export const files_table_MAX_COLUMNS = 8;

export function files_table_column_is_valid(field: string) {
	return field === "updated_by" || files_sort_field_is_valid(field);
}
