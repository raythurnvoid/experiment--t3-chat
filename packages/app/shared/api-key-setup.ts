import { findNodeAtLocation, findNodeAtOffset, getLocation, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";

import { files_get_utf8_byte_size } from "./files.ts";

// Parse the JSON setup text of the "Create API key" dialog. People and agents paste it, so treat it as
// untrusted. The server checks the same name and scope rules again on create.

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_NAME_CHARS = 80;

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
	const errors: Array<{ offset: number; length: number; message: string }> = [];

	if (files_get_utf8_byte_size(text) > MAX_TEXT_BYTES) {
		errors.push({ offset: 0, length: 0, message: "The setup must be at most 16 KiB." });
		return { setup: null, errors };
	}

	// Text copied from chat apps and web pages often has non-breaking spaces or a byte order mark, and the
	// JSON parser refuses both. Swap each for a normal space: one character for one, so offsets stay the same.
	const jsonText = text.replaceAll(/[\u00A0\uFEFF]/gu, " ");

	// Use the syntax tree, not `parse()`. `parse()` keeps only the last of two duplicate keys, and a
	// `"__proto__"` key changes the prototype of the object it returns. JSONC comments and trailing commas are fine.
	const parseErrors: ParseError[] = [];
	let root: ReturnType<typeof parseTree>;
	try {
		root = parseTree(jsonText, parseErrors, { allowTrailingComma: true });
	} catch {
		// `parseTree` calls itself for each nested bracket. About 6,000 brackets, well under the size cap,
		// overflow the call stack. This runs during render, so show an error instead of crashing the page.
		errors.push({ offset: 0, length: 0, message: "The setup has too many nested brackets." });
		return { setup: null, errors };
	}
	if (parseErrors.length > 0) {
		for (const parseError of parseErrors) {
			// "CommaExpected" becomes "Comma expected".
			const words = printParseErrorCode(parseError.error).replaceAll(/(?<=[a-z])(?=[A-Z])/gu, " ");
			errors.push({
				offset: parseError.offset,
				length: parseError.length,
				message: words.charAt(0) + words.slice(1).toLowerCase(),
			});
		}
		return { setup: null, errors };
	}

	if (root?.type !== "object") {
		errors.push({ offset: 0, length: text.length, message: "Paste a JSON object." });
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
				offset: keyNode.offset,
				length: keyNode.length,
				message: `"${key}" is in the setup twice. Keep one.`,
			});
			continue;
		}
		seenKeys.add(key);

		if (key === "name") {
			if (valueNode.type !== "string") {
				errors.push({ offset: valueNode.offset, length: valueNode.length, message: 'The "name" must be text.' });
				continue;
			}

			const nameValue: string = valueNode.value;
			const trimmedName = nameValue.trim();
			if (trimmedName.length === 0) {
				errors.push({ offset: valueNode.offset, length: valueNode.length, message: "API key name is required" });
			} else if (trimmedName.length > MAX_NAME_CHARS) {
				errors.push({
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
					offset: valueNode.offset,
					length: valueNode.length,
					message: 'The "scopes" must be a list, like ["files:list"].',
				});
				continue;
			}
			if (!valueNode.children?.length) {
				errors.push({ offset: valueNode.offset, length: valueNode.length, message: "Choose at least one scope." });
				continue;
			}

			const foundScopes: TScope[] = [];
			for (const item of valueNode.children) {
				const scope = item.type === "string" ? args.allowedScopes.find((allowed) => allowed === item.value) : undefined;
				if (scope === undefined) {
					errors.push({
						offset: item.offset,
						length: item.length,
						message: `Unknown scope ${jsonText.slice(item.offset, item.offset + item.length)}. See "All scopes" for the list.`,
					});
				} else if (args.serviceAccountScopes && !args.serviceAccountScopes.includes(scope)) {
					errors.push({
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
				offset: keyNode.offset,
				length: keyNode.length,
				message: `Unknown field "${key}". Use only "name" and "scopes".`,
			});
		}
	}

	if (!seenKeys.has("name")) {
		errors.push({ offset: root.offset, length: 1, message: 'Add a "name" field.' });
	}
	if (!seenKeys.has("scopes")) {
		errors.push({ offset: root.offset, length: 1, message: 'Add a "scopes" list, like ["files:list"].' });
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
