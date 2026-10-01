// The sort order of a folder's children. The server indexes store the keys built here, and the
// browser merges rows with the same keys, so both sides must build them with this one module.
import { compareValues } from "convex/values";
import type { files_metadata_Value } from "./files-metadata.ts";
import {
	files_search_query_field_path_is_valid,
	files_search_query_FIELD_PATH_MAX_LENGTH,
} from "./files-search-query.ts";

const TEXT_KEY_MAX_CODE_POINTS = 256;
const DIGIT_RUN_MAX_LENGTH = 99;

export const files_sort_BUILT_IN_FIELDS = ["name", "updated", "created", "type", "size"] as const;

/**
 * The most clauses one sort can hold. Each extra clause adds reads to the same table work limit.
 */
export const files_sort_MAX_CLAUSES = 8;

type files_sort_Direction = "asc" | "desc";

/**
 * One clause in a saved or requested sort. `field` is a built-in field name, or a
 * qualified metadata field path such as `metadata.status` or `frontmatter.due`. Check it with
 * `files_sort_field_is_valid`: a field that can be searched can also be sorted.
 */
export type files_sort_Clause = { field: string; direction: files_sort_Direction };
export type files_sort_Sort = files_sort_Clause[];

/**
 * One clause key part. A present one-field sort keeps its full index suffix.
 * Raw index suffixes stay inside server cursors.
 */
export type files_sort_Key = Array<string | number | null>;

export type files_sort_RowKey = {
	parts: Array<files_sort_Key | null>;
	nameKey: [string, string];
};

export const files_sort_DEFAULT: files_sort_Sort = [{ field: "name", direction: "asc" }];

export function files_sort_field_is_built_in(field: string): field is (typeof files_sort_BUILT_IN_FIELDS)[number] {
	return (files_sort_BUILT_IN_FIELDS as readonly string[]).includes(field);
}

export function files_sort_field_is_valid(field: string) {
	return (
		files_sort_field_is_built_in(field) ||
		(field.length <= files_search_query_FIELD_PATH_MAX_LENGTH && files_search_query_field_path_is_valid(field))
	);
}

export function files_sort_is_valid(sort: files_sort_Sort) {
	return (
		sort.length >= 1 &&
		sort.length <= files_sort_MAX_CLAUSES &&
		new Set(sort.map((clause) => clause.field)).size === sort.length &&
		sort.every(
			(clause) =>
				files_sort_field_is_valid(clause.field) && (clause.direction === "asc" || clause.direction === "desc"),
		)
	);
}

/**
 * Folders miss Type and Size. Name's full key is unique, so later fields cannot change its order.
 * Keep the original clauses for saved choices, keys and cursor scopes.
 */
export function files_sort_execution_fields(sort: files_sort_Sort, kind: "folder" | "file") {
	const fields: files_sort_Sort = [];
	for (const clause of sort) {
		if (sort.length > 1 && kind === "folder" && (clause.field === "type" || clause.field === "size")) continue;
		fields.push(clause);
		if (clause.field === "name") break;
	}
	return fields;
}

/**
 * The alphabetical key of a text. Case and accents are ignored, and digit runs compare by value, so
 * `file2` sorts before `file10`.
 *
 * Every index that stores this key puts the raw name right after it. So names that share a key
 * (`a.md` and `A.md`) still have one fixed order.
 *
 * Only built-in string methods are used, with no locale, so the server and the browser build the
 * same key.
 */
export function files_sort_text_key(text: string) {
	const key = text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		// Write each digit run as its length and then its digits, so a shorter number sorts first.
		// `2` becomes `012` and `10` becomes `0210`. Leading zeros are dropped, so `007` is `017`.
		.replace(/[0-9]+/g, (digits) => {
			const number = digits.replace(/^0+(?=[0-9])/, "").slice(0, DIGIT_RUN_MAX_LENGTH);
			return `${String(number.length).padStart(2, "0")}${number}`;
		});

	// Cut by code points, never by UTF-16 units. Half an emoji is a lone surrogate, and Convex refuses
	// to store it. The frontmatter writer runs in a queue that retries forever, so that throw would
	// block every later file.
	return Array.from(key).slice(0, TEXT_KEY_MAX_CODE_POINTS).join("");
}

/**
 * The text sort value of one field, from the values the metadata extraction found for it, or null
 * when the field has no plain value (a frontmatter map, an empty list, a tagged value).
 *
 * Every value sorts as text: a number as `String(value)` and a boolean as `true` or `false`. A list
 * uses its first item. The extraction keeps list items in document order, and `maybe_date` values
 * are skipped because they only repeat a string value as a time.
 */
export function files_sort_value_of(values: files_metadata_Value[]) {
	const value = values.find((metadataValue) => metadataValue.valueKind !== "maybe_date");
	if (!value) {
		return null;
	}

	return { sortValue: files_sort_text_key(String(value.value)), displayValue: value.value };
}

/**
 * Build one fresh row key from its facts and encoded metadata scalars. Do not decode stored keys.
 */
export function files_sort_key_of(args: {
	sort: files_sort_Sort;
	facts: {
		kind: "folder" | "file";
		name: string;
		createdAt: number;
		updatedAt: number;
		type: string | null;
		contentByteSize: number | null;
	};
	metadataParts: ReadonlyMap<string, string | null>;
}): files_sort_RowKey {
	const { sort, facts, metadataParts } = args;

	const nameKey: [string, string] = [files_sort_text_key(facts.name), facts.name];
	let hasName = false;
	const parts = sort.map((clause): files_sort_Key | null => {
		if (hasName) return null;
		if (clause.field === "name") {
			hasName = true;
			return nameKey;
		}
		const scalar =
			clause.field === "created"
				? facts.createdAt
				: clause.field === "updated"
					? facts.updatedAt
					: clause.field === "type"
						? facts.kind === "folder"
							? null
							: facts.type
						: clause.field === "size"
							? facts.kind === "folder"
								? null
								: facts.contentByteSize
							: (metadataParts.get(clause.field) ?? null);
		if (scalar === null) return null;
		// A one-field sort keeps its exact index suffix. Created has no name suffix.
		return sort.length === 1 && clause.field !== "created" ? [scalar, ...nameKey] : [scalar];
	});
	return { parts, nameKey };
}

/**
 * Missing values stay last in either direction. Multi-sort applies each direction on its own.
 */
export function files_sort_compare(args: { a: files_sort_RowKey; b: files_sort_RowKey; sort: files_sort_Sort }) {
	const { a, b, sort } = args;

	for (const [index, clause] of sort.entries()) {
		const aPart = a.parts[index];
		const bPart = b.parts[index];
		if (aPart === null && bPart === null) continue;
		if (aPart === null) return 1;
		if (bPart === null) return -1;
		const result = compareValues(aPart, bPart);
		if (result !== 0) return clause.direction === "asc" ? result : -result;
	}
	// Single Created keeps native equal-time ties. Single missing values use Name asc.
	if (sort.length === 1 && a.parts[0] !== null && b.parts[0] !== null) return 0;
	return compareValues(a.nameKey, b.nameKey);
}
