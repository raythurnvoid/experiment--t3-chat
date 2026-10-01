import { files_sort_field_is_built_in, files_sort_field_is_valid } from "./files-sort.ts";

export const files_table_DEFAULT_COLUMNS = ["name", "updated_by", "updated"];
export const files_table_MAX_COLUMNS = 8;

export type files_table_Filter =
	| { kind: "name"; field: "name"; op: "contains" | "starts_with"; value: string }
	| { kind: "type"; field: "type"; op: "is"; value: string }
	| { kind: "type"; field: "type"; op: "missing" }
	| { kind: "date"; field: "updated" | "created"; op: "on" | "before" | "after"; start: number; end: number }
	| { kind: "size"; field: "size"; op: "is" | "at_least" | "at_most"; value: number }
	| { kind: "size"; field: "size"; op: "missing" }
	| { kind: "text"; field: string; op: "is" | "starts_with"; value: string }
	| { kind: "text"; field: string; op: "present" | "missing" };

export function files_table_column_is_valid(field: string) {
	return field === "updated_by" || files_sort_field_is_valid(field);
}

export function files_table_filter_is_valid(filter: files_table_Filter) {
	switch (filter.kind) {
		case "name":
			return filter.field === "name" && filter.value.length >= 1 && filter.value.length <= 1024;
		case "type":
			return (
				filter.field === "type" &&
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
					filter.op === "missing" ||
					("value" in filter && filter.value.length >= 1 && filter.value.length <= 1024))
			);
	}
}

function fold_filter_text(value: string) {
	// A filter keeps the full text and its digits; a natural-sort key does neither.
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function files_table_filter_matches(args: {
	filter: files_table_Filter;
	facts: { name: string; createdAt: number; updatedAt: number; type: string | null; contentByteSize: number | null };
	scalar?: string | number | boolean | null;
}) {
	const { filter, facts, scalar = null } = args;

	switch (filter.kind) {
		case "name": {
			const name = fold_filter_text(facts.name);
			const value = fold_filter_text(filter.value);
			return filter.op === "contains" ? name.includes(value) : name.startsWith(value);
		}
		case "type":
			return filter.op === "missing" ? facts.type === null : facts.type === filter.value.toLowerCase();
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
			if (!("value" in filter)) return filter.op === "present" ? scalar !== null : scalar === null;
			if (scalar === null) return false;
			return filter.op === "is"
				? fold_filter_text(String(scalar)) === fold_filter_text(filter.value)
				: fold_filter_text(String(scalar)).startsWith(fold_filter_text(filter.value));
	}
}
