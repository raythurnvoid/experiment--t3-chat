import {
	applyEdits,
	createScanner,
	findNodeAtLocation,
	findNodeAtOffset,
	getLocation,
	modify,
	parseTree,
	printParseErrorCode,
	SyntaxKind,
	type Edit,
	type FormattingOptions,
	type Node,
	type ParseError,
} from "jsonc-parser";

import { files_get_utf8_byte_size } from "./files.ts";

// Parse the JSON setup text of the "Create API key" dialog. People and agents paste it, so treat it as
// untrusted. The server checks the same name and scope rules again on create.

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_NAME_CHARS = 80;

// Write new JSON like the dialog's default setup: two spaces, one scope per line.
const FORMATTING_OPTIONS = { insertSpaces: true, tabSize: 2, eol: "\n" } satisfies FormattingOptions;

// A stable name for each kind of problem, so the editor can offer the right quick fix.
type ErrorCode =
	| "too_large"
	| "too_deep"
	| "syntax"
	| "not_object"
	| "duplicate_field"
	| "name_not_text"
	| "name_empty"
	| "name_too_long"
	| "scopes_not_list"
	| "scopes_empty"
	| "unknown_scope"
	| "scope_not_allowed"
	| "unknown_field"
	| "missing_name"
	| "missing_scopes";

/**
 * Text copied from chat apps and web pages often has non-breaking spaces or a byte order mark, and the JSON
 * parser refuses both. Swap each for a normal space: one character for one, so offsets stay the same.
 */
function to_json_text(text: string) {
	return text.replaceAll(/[ ﻿]/gu, " ");
}

/**
 * Parse the setup for an edit. Returns null unless the text is valid JSON with an object at the top.
 */
function parse_object(jsonText: string) {
	const parseErrors: ParseError[] = [];
	let root: ReturnType<typeof parseTree>;
	try {
		root = parseTree(jsonText, parseErrors, { allowTrailingComma: true });
	} catch {
		// `parseTree` calls itself for each nested bracket, so a very deep text overflows the call stack.
		return null;
	}

	return parseErrors.length === 0 && root?.type === "object" ? root : null;
}

/**
 * Parse setup text like `{ "name": "Local file reader", "scopes": ["files:list"] }`.
 *
 * Every problem is an error with the offset and length of the text it is about, so the editor can mark it.
 * `setup` is null when there is any error.
 *
 * Pass `serviceAccountScopes` for a key bound to a service account, and `null` for a personal key.
 */
export function api_key_setup_parse<TScope extends string>(
	text: string,
	args: {
		allowedScopes: readonly TScope[];
		serviceAccountScopes: readonly TScope[] | null;
	},
) {
	const errors: Array<{ code: ErrorCode; offset: number; length: number; message: string }> = [];

	if (files_get_utf8_byte_size(text) > MAX_TEXT_BYTES) {
		errors.push({ code: "too_large", offset: 0, length: 0, message: "The setup must be at most 16 KiB." });
		return { setup: null, errors };
	}

	const jsonText = to_json_text(text);

	// Use the syntax tree, not `parse()`. `parse()` keeps only the last of two duplicate keys, and a
	// `"__proto__"` key changes the prototype of the object it returns. JSONC comments and trailing commas are fine.
	const parseErrors: ParseError[] = [];
	let root: ReturnType<typeof parseTree>;
	try {
		root = parseTree(jsonText, parseErrors, { allowTrailingComma: true });
	} catch {
		// `parseTree` calls itself for each nested bracket. About 6,000 brackets, well under the size cap,
		// overflow the call stack. This runs during render, so show an error instead of crashing the page.
		errors.push({ code: "too_deep", offset: 0, length: 0, message: "The setup has too many nested brackets." });
		return { setup: null, errors };
	}
	if (parseErrors.length > 0) {
		for (const parseError of parseErrors) {
			// "CommaExpected" becomes "Comma expected".
			const words = printParseErrorCode(parseError.error).replaceAll(/(?<=[a-z])(?=[A-Z])/gu, " ");
			errors.push({
				code: "syntax",
				offset: parseError.offset,
				length: parseError.length,
				message: words.charAt(0) + words.slice(1).toLowerCase(),
			});
		}
		return { setup: null, errors };
	}

	if (root?.type !== "object") {
		errors.push({ code: "not_object", offset: 0, length: text.length, message: "Paste a JSON object." });
		return { setup: null, errors };
	}

	// Compare decoded key values, so `"n\u0061me"` counts as `name`. Use a Set and `find`, never a plain
	// object lookup: `"constructor"` is a key of every object.
	const seenKeys = new Set<string>();
	let name: string | null = null;
	let scopes: TScope[] | null = null;
	for (const property of root.children ?? []) {
		// With no parse errors, every property node has a key node and a value node.
		const [keyNode, valueNode] = property.children!;
		const key: string = keyNode.value;

		if (seenKeys.has(key)) {
			errors.push({
				code: "duplicate_field",
				offset: keyNode.offset,
				length: keyNode.length,
				message: `"${key}" is in the setup twice. Keep one.`,
			});
			continue;
		}
		seenKeys.add(key);

		if (key === "name") {
			if (valueNode.type !== "string") {
				errors.push({
					code: "name_not_text",
					offset: valueNode.offset,
					length: valueNode.length,
					message: 'The "name" must be text.',
				});
				continue;
			}

			const nameValue: string = valueNode.value;
			const trimmedName = nameValue.trim();
			if (trimmedName.length === 0) {
				errors.push({
					code: "name_empty",
					offset: valueNode.offset,
					length: valueNode.length,
					message: "API key name is required",
				});
			} else if (trimmedName.length > MAX_NAME_CHARS) {
				errors.push({
					code: "name_too_long",
					offset: valueNode.offset,
					length: valueNode.length,
					message: `API key name must be ${MAX_NAME_CHARS} characters or fewer`,
				});
			} else {
				name = trimmedName;
			}
		} else if (key === "scopes") {
			if (valueNode.type !== "array") {
				errors.push({
					code: "scopes_not_list",
					offset: valueNode.offset,
					length: valueNode.length,
					message: 'The "scopes" must be a list, like ["files:list"].',
				});
				continue;
			}
			if (!valueNode.children?.length) {
				errors.push({
					code: "scopes_empty",
					offset: valueNode.offset,
					length: valueNode.length,
					message: "Choose at least one scope.",
				});
				continue;
			}

			const foundScopes: TScope[] = [];
			for (const item of valueNode.children) {
				const scope = item.type === "string" ? args.allowedScopes.find((allowed) => allowed === item.value) : undefined;
				if (scope === undefined) {
					errors.push({
						code: "unknown_scope",
						offset: item.offset,
						length: item.length,
						message: `Unknown scope ${jsonText.slice(item.offset, item.offset + item.length)}. See "All scopes" for the list.`,
					});
				} else if (args.serviceAccountScopes && !args.serviceAccountScopes.includes(scope)) {
					errors.push({
						code: "scope_not_allowed",
						offset: item.offset,
						length: item.length,
						message: `Service account keys cannot use ${scope}. Remove it, or choose Personal.`,
					});
				} else {
					foundScopes.push(scope);
				}
			}

			// A scope listed twice grants nothing more, so keep one copy, like the server does.
			scopes = Array.from(new Set(foundScopes));
		} else {
			errors.push({
				code: "unknown_field",
				offset: keyNode.offset,
				length: keyNode.length,
				message: `Unknown field "${key}". Use only "name" and "scopes".`,
			});
		}
	}

	if (!seenKeys.has("name")) {
		errors.push({ code: "missing_name", offset: root.offset, length: 1, message: 'Add a "name" field.' });
	}
	if (!seenKeys.has("scopes")) {
		errors.push({
			code: "missing_scopes",
			offset: root.offset,
			length: 1,
			message: 'Add a "scopes" list, like ["files:list"].',
		});
	}

	if (errors.length > 0 || name === null || scopes === null) {
		return { setup: null, errors };
	}

	return { setup: { name, scopes }, errors };
}

/**
 * Find what the editor should suggest at `offset`: the field names at the top level of the setup, or
 * the scope ids inside the "scopes" list. Fields and scopes already in the setup are left out.
 *
 * `replace` is the text a picked suggestion replaces: the whole string under the cursor, quotes
 * included, or nothing when the cursor is not in a string. `colonFollows` says whether a field name
 * already has its `:`, so the editor inserts only the name.
 *
 * The text may be broken while the user types, so this reads it without refusing anything.
 */
export function api_key_setup_suggest<TScope extends string>(
	text: string,
	offset: number,
	allowedScopes: readonly TScope[],
) {
	let root: ReturnType<typeof parseTree>;
	let location: ReturnType<typeof getLocation>;
	try {
		root = parseTree(text, [], { allowTrailingComma: true });
		location = getLocation(text, offset);
	} catch {
		// Both call themselves for each nested bracket, so a very deep text overflows the call stack.
		return null;
	}

	const node = location.previousNode;
	const replace =
		node && node.offset < offset && offset <= node.offset + node.length
			? { offset: node.offset, length: node.length }
			: { offset, length: 0 };
	// Skip the string under the cursor when listing what the setup already has: it is being replaced.
	const isReplaced = (other: { offset: number }) => replace.length > 0 && other.offset === replace.offset;

	if (location.isAtPropertyKey && location.path.length === 1) {
		const presentKeys = (root?.type === "object" ? (root.children ?? []) : []).flatMap((property) => {
			const keyNode = property.children?.[0];
			return keyNode && !isReplaced(keyNode) ? [keyNode.value] : [];
		});
		return {
			kind: "field" as const,
			values: (["name", "scopes"] as const).filter((key) => !presentKeys.includes(key)),
			replace,
			colonFollows: /^\s*:/u.test(text.slice(replace.offset + replace.length)),
		};
	}

	if (location.matches(["scopes", "*"])) {
		const listNode = root ? findNodeAtLocation(root, ["scopes"]) : undefined;
		const presentScopes = (listNode?.type === "array" ? (listNode.children ?? []) : [])
			.filter((item) => item.type === "string" && !isReplaced(item))
			.map((item) => item.value);
		return {
			kind: "scope" as const,
			values: allowedScopes.filter((scope) => !presentScopes.includes(scope)),
			replace,
		};
	}

	return null;
}

/**
 * Find the setup string under `offset` that has docs to show on hover: a top-level field name, or an
 * item of the top-level "scopes" list. Returns its decoded value and the text range it covers.
 */
export function api_key_setup_hover_target(text: string, offset: number) {
	let root: ReturnType<typeof parseTree>;
	try {
		root = parseTree(text, [], { allowTrailingComma: true });
	} catch {
		// `parseTree` calls itself for each nested bracket, so a very deep text overflows the call stack.
		return null;
	}

	const node = root?.type === "object" ? findNodeAtOffset(root, offset) : undefined;
	if (node?.type !== "string" || !node.parent) {
		return null;
	}

	const range = { offset: node.offset, length: node.length };
	const property = node.parent;
	if (property.type === "property" && property.parent === root && property.children?.[0] === node) {
		return { kind: "field" as const, value: node.value as string, ...range };
	}

	const listProperty = property.parent;
	if (
		property.type === "array" &&
		listProperty?.type === "property" &&
		listProperty.parent === root &&
		listProperty.children?.[0]?.value === "scopes"
	) {
		return { kind: "scope" as const, value: node.value as string, ...range };
	}

	return null;
}

/**
 * Read the text items of the top-level "scopes" list, in text order, so the scope checkboxes can mirror
 * the setup. A setup with no "scopes" field lists none.
 *
 * Returns null when the text is not valid JSON with an object at the top, or its "scopes" is not a list.
 * The setup then cannot be edited safely from outside the text.
 */
export function api_key_setup_listed_scopes(text: string) {
	const root = parse_object(to_json_text(text));
	const listNode = root ? findNodeAtLocation(root, ["scopes"]) : undefined;
	if (!root || (listNode && listNode.type !== "array")) {
		return null;
	}

	return (listNode?.children ?? []).flatMap((item) => (item.type === "string" ? [item.value as string] : []));
}

/**
 * Write `scopes` as the setup's "scopes" list. Only the list changes: the name, other fields, and comments
 * outside the list keep their text. Returns null when `api_key_setup_listed_scopes` would.
 */
export function api_key_setup_with_scopes(text: string, scopes: readonly string[]) {
	if (api_key_setup_listed_scopes(text) === null) {
		return null;
	}

	// Edit the swapped text so `modify` parses the same tree. The swap keeps offsets, so the edits fit the original.
	return applyEdits(text, modify(to_json_text(text), ["scopes"], scopes, { formattingOptions: FORMATTING_OPTIONS }));
}

/**
 * Remove a list item or an object field, together with the comma that joins it to its neighbor.
 */
function remove_edit(text: string, node: Node): Edit {
	const siblings = node.parent?.children ?? [];
	const index = siblings.indexOf(node);
	const before = siblings[index - 1];
	const after = siblings[index + 1];

	// Remove from the end of the item before, so its comma goes too. The first item takes the comma after it.
	const start = before ? before.offset + before.length : node.offset;
	const end = !before && after ? after.offset : node.offset + node.length;
	// A lone item can still have a trailing comma. Keep comments on either side.
	if (!before && !after) {
		const scanner = createScanner(to_json_text(text), true);
		scanner.setPosition(end);
		if (scanner.scan() === SyntaxKind.CommaToken) {
			const commaOffset = scanner.getTokenOffset();
			return { offset: start, length: commaOffset + 1 - start, content: text.slice(end, commaOffset) };
		}
	}
	return { offset: start, length: end - start, content: "" };
}

/**
 * Count the single-character inserts, deletes, and changes that turn `a` into `b` (Levenshtein distance).
 */
function edit_distance(a: string, b: string) {
	let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(previousRow[j] + 1, row[j - 1] + 1, previousRow[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previousRow = row;
	}

	return previousRow[b.length];
}

/**
 * List the quick fixes for one error from `api_key_setup_parse`: a title for each, and the text edits that
 * make it. Problems that need the user's own words, like an empty name, have none.
 */
export function api_key_setup_quick_fixes(
	text: string,
	error: { code: ErrorCode; offset: number },
	allowedScopes: readonly string[],
) {
	const jsonText = to_json_text(text);
	// Every error with a fix comes from a setup that parses, so a broken text has no fixes.
	const root = parse_object(jsonText);
	if (!root) {
		return [];
	}

	const node = findNodeAtOffset(root, error.offset);
	const fixes: Array<{ title: string; edits: Edit[] }> = [];
	switch (error.code) {
		case "unknown_scope": {
			if (!node) {
				break;
			}

			// Offer the allowed scope that is a typo away, like "files:raed" for "files:read".
			if (node.type === "string") {
				const value: string = node.value;
				let closest = { scope: "", distance: Infinity };
				for (const scope of allowedScopes) {
					const distance = edit_distance(value, scope);
					if (distance < closest.distance) {
						closest = { scope, distance };
					}
				}
				if (closest.distance <= 3) {
					fixes.push({
						title: `Change to ${closest.scope}`,
						edits: [{ offset: node.offset, length: node.length, content: JSON.stringify(closest.scope) }],
					});
				}
			}
			fixes.push({ title: "Remove this scope", edits: [remove_edit(text, node)] });
			break;
		}
		case "scope_not_allowed": {
			if (node) {
				fixes.push({ title: "Remove this scope", edits: [remove_edit(text, node)] });
			}
			break;
		}
		case "duplicate_field":
		case "unknown_field": {
			// The error marks the field name. Remove the whole field: its name and its value.
			if (node?.parent?.type === "property") {
				fixes.push({
					title: error.code === "duplicate_field" ? "Remove this copy" : "Remove this field",
					edits: [remove_edit(text, node.parent)],
				});
			}
			break;
		}
		case "missing_name": {
			fixes.push({
				title: 'Add a "name" field',
				edits: modify(jsonText, ["name"], "", {
					formattingOptions: FORMATTING_OPTIONS,
					getInsertionIndex: () => 0,
				}),
			});
			break;
		}
		case "missing_scopes": {
			fixes.push({
				title: 'Add a "scopes" list',
				edits: modify(jsonText, ["scopes"], ["files:list"], { formattingOptions: FORMATTING_OPTIONS }),
			});
			break;
		}
	}

	return fixes;
}
