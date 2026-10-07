import { files_sort_field_is_built_in, files_sort_field_is_valid, files_sort_text_key } from "./files-sort.ts";

export const files_table_DEFAULT_COLUMNS = ["name", "updated_by", "updated"];
export const files_table_MAX_COLUMNS = 8;

export type files_table_Filter =
	| { kind: "name"; field: "name"; op: "starts_with"; value: string }
	| { kind: "extension"; field: "extension"; op: "is"; value: string }
	| { kind: "extension"; field: "extension"; op: "missing" }
	| { kind: "date"; field: "updated" | "created"; op: "on" | "before" | "after"; start: number; end: number }
	| { kind: "size"; field: "size"; op: "is" | "at_least" | "at_most"; value: number }
	| { kind: "size"; field: "size"; op: "missing" }
	| { kind: "text"; field: string; op: "is" | "starts_with"; value: string }
	| { kind: "text"; field: string; op: "present" };

export function files_table_column_is_valid(field: string) {
	return field === "updated_by" || files_sort_field_is_valid(field);
}

/**
 * The text of a file.updated_by cell. With no name found, it shows "Unknown".
 */
export function files_table_updated_by_text(displayName: string | null) {
	return displayName ?? "Unknown";
}

/**
 * True when a `starts with` value cannot be one index range. The sort key writes a number with its
 * length first (`2` is `012`, `10` is `0210`), so a prefix that ends in a digit does not match the
 * longer numbers. Check the key, not the text: accent marks after a digit are dropped from the key.
 */
export function files_table_starts_with_ends_in_digit(value: string) {
	return /[0-9]$/u.test(files_sort_text_key(value));
}

export function files_table_filter_is_valid(filter: files_table_Filter) {
	switch (filter.kind) {
		case "name":
			return (
				filter.field === "name" &&
				filter.value.length >= 1 &&
				filter.value.length <= 1024 &&
				!files_table_starts_with_ends_in_digit(filter.value)
			);
		case "extension":
			return (
				filter.field === "extension" &&
				(filter.op === "missing" || (filter.value.length >= 1 && filter.value.length <= 1024))
			);
		case "date":
			return (
				(filter.field === "created" || filter.field === "updated") &&
				Number.isFinite(filter.start) &&
				Number.isFinite(filter.end) &&
				filter.end - filter.start >= 23 * 60 * 60 * 1000 &&
				filter.end - filter.start <= 25 * 60 * 60 * 1000
			);
		case "size":
			return (
				filter.field === "size" && (filter.op === "missing" || (Number.isInteger(filter.value) && filter.value >= 0))
			);
		case "text":
			return (
				!files_sort_field_is_built_in(filter.field) &&
				files_sort_field_is_valid(filter.field) &&
				(filter.op === "present" ||
					("value" in filter &&
						filter.value.length >= 1 &&
						filter.value.length <= 1024 &&
						(filter.op === "is" || !files_table_starts_with_ends_in_digit(filter.value))))
			);
	}
}

/**
 * The field that orders the table while this filter is on. The filter picks the index, and the
 * index fixes the order: a range orders by its own field, an "is" filter and `name starts with` by
 * name. No second path sorts in another order.
 *
 * It takes only the field and the operation, so the filter bar parser uses it on its tokens too.
 */
export function files_table_filter_order_field(filter: { field: string; op: string }) {
	if (filter.field === "name" || filter.field === "extension") return "name";
	if (filter.field === "updated" || filter.field === "created") return filter.field;
	if (filter.field === "size") return filter.op === "at_least" || filter.op === "at_most" ? "size" : "name";
	return filter.op === "is" ? "name" : filter.field;
}

/**
 * The metadata key the table reads, or null: a text filter's field, else a metadata sort's field.
 * An "is" text filter reads the name order, so the sort alone does not say it.
 */
export function files_table_metadata_field(args: {
	sort: { field: string } | null;
	filter: files_table_Filter | null;
}) {
	const { sort, filter } = args;
	if (filter !== null) return filter.kind === "text" ? filter.field : null;
	return sort !== null && !files_sort_field_is_built_in(sort.field) ? sort.field : null;
}

/**
 * True when `name starts with` can join this filter. Only an "is" filter can: its index keeps the
 * name right after the value, so the name prefix is one more range on the same index.
 */
export function files_table_filter_takes_name_prefix(filter: { field: string; op: string }) {
	return files_table_filter_order_field(filter) === "name" && filter.field !== "name";
}

/**
 * Check one row against a filter the same way the index range does: `is` and `starts with` compare
 * the stored sort key (`files_sort_text_key`), so case, accents and leading zeros are ignored.
 */
export function files_table_filter_matches(args: {
	filter: files_table_Filter;
	facts: { name: string; createdAt: number; updatedAt: number; extension: string | null; contentByteSize: number | null };
	scalar?: string | number | boolean | null;
}) {
	const { filter, facts, scalar = null } = args;

	switch (filter.kind) {
		case "name":
			return files_sort_text_key(facts.name).startsWith(files_sort_text_key(filter.value));
		case "extension":
			return filter.op === "missing" ? facts.extension === null : facts.extension === filter.value.toLowerCase();
		case "date": {
			const time = filter.field === "created" ? facts.createdAt : facts.updatedAt;
			return filter.op === "before"
				? time < filter.start
				: filter.op === "after"
					? time >= filter.end
					: time >= filter.start && time < filter.end;
		}
		case "size":
			return filter.op === "missing"
				? facts.contentByteSize === null
				: facts.contentByteSize !== null &&
						(filter.op === "is"
							? facts.contentByteSize === filter.value
							: filter.op === "at_least"
								? facts.contentByteSize >= filter.value
								: facts.contentByteSize <= filter.value);
		case "text":
			if (!("value" in filter)) return scalar !== null;
			if (scalar === null) return false;
			return filter.op === "is"
				? files_sort_text_key(String(scalar)) === files_sort_text_key(filter.value)
				: files_sort_text_key(String(scalar)).startsWith(files_sort_text_key(filter.value));
	}
}
