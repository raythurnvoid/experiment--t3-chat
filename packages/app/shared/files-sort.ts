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

type files_sort_Direction = "asc" | "desc";

/**
 * The saved sort of a folder and the sort a query reads. `field` is a built-in field name, or a
 * qualified metadata field path such as `metadata.status` or `frontmatter.due`. Check it with
 * `files_sort_field_is_valid`: a field that can be searched can also be sorted.
 */
export type files_sort_Sort = { field: string; direction: files_sort_Direction };

/**
 * The index tuple of one row inside its segment, after the fields every row of the segment shares.
 * Compare two keys with `files_sort_compare`.
 */
export type files_sort_Key = Array<string | number | null>;

export const files_sort_DEFAULT: files_sort_Sort = { field: "name", direction: "asc" };

export function files_sort_field_is_built_in(field: string): field is (typeof files_sort_BUILT_IN_FIELDS)[number] {
	return (files_sort_BUILT_IN_FIELDS as readonly string[]).includes(field);
}

export function files_sort_field_is_valid(field: string) {
	return (
		files_sort_field_is_built_in(field) ||
		(field.length <= files_search_query_FIELD_PATH_MAX_LENGTH && files_search_query_field_path_is_valid(field))
	);
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
 * Compare two sort keys exactly like a Convex index does, in the given direction.
 */
export function files_sort_compare(a: files_sort_Key, b: files_sort_Key, direction: files_sort_Direction) {
	const result = compareValues(a, b);
	return direction === "asc" ? result : -result;
}
