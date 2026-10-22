import { applyEdits } from "jsonc-parser";
import { describe, expect, test } from "vitest";
import {
	api_key_setup_format_edits,
	api_key_setup_parse,
	api_key_setup_quick_fixes,
	api_key_setup_suggest,
	api_key_setup_with_scopes,
} from "./api-key-setup.ts";

const ALLOWED_SCOPES = ["files:list", "files:read", "files:write", "files:publish"] as const;
const SERVICE_ACCOUNT_SCOPES = ["files:list", "files:read", "files:write"] as const;

function parse_personal(text: string) {
	return api_key_setup_parse(text, { allowedScopes: ALLOWED_SCOPES, serviceAccountScopes: null });
}

/**
 * The error for the first place `marked` appears in `text`, with the exact offset and length.
 */
function error_at(text: string, marked: string, code: string, message: string) {
	return { code, offset: text.indexOf(marked), length: marked.length, message };
}

describe("api_key_setup_parse", () => {
	test("returns the trimmed name and the scopes once each, and warns about a scope listed twice", () => {
		const text = `{
	// Comments and trailing commas are fine.
	"name": "  Local file reader ",
	"scopes": ["files:list", "files:read", "files:list",],
}`;

		const result = parse_personal(text);

		expect(result).toEqual({
			setup: { name: "Local file reader", scopes: ["files:list", "files:read"] },
			errors: [],
			warnings: [
				{
					code: "duplicate_scope",
					offset: text.lastIndexOf('"files:list"'),
					length: '"files:list"'.length,
					message: "files:list is in the scopes twice. The key gets it once.",
				},
			],
		});
	});

	test("marks the exact text of an unknown scope, an unknown field, and a repeated field", () => {
		const text = '{"name": "Reader", "scope": [], "scopes": ["files:raed", "constructor"], "scopes": ["files:list"]}';

		const result = parse_personal(text);

		expect(result.setup).toBeNull();
		expect(result.errors).toEqual([
			error_at(text, '"scope"', "unknown_field", 'Unknown field "scope". Use only "name" and "scopes".'),
			error_at(text, '"files:raed"', "unknown_scope", 'Unknown scope "files:raed". See "All scopes" for the list.'),
			error_at(text, '"constructor"', "unknown_scope", 'Unknown scope "constructor". See "All scopes" for the list.'),
			{
				code: "duplicate_field",
				offset: text.lastIndexOf('"scopes"'),
				length: '"scopes"'.length,
				message: '"scopes" is in the setup twice. Keep one.',
			},
		]);
	});

	test("refuses scopes that service account keys cannot use", () => {
		const text = '{"name": "Bot", "scopes": ["files:list", "files:publish"]}';

		const result = api_key_setup_parse(text, {
			allowedScopes: ALLOWED_SCOPES,
			serviceAccountScopes: SERVICE_ACCOUNT_SCOPES,
		});

		expect(result.setup).toBeNull();
		expect(result.errors).toEqual([
			error_at(
				text,
				'"files:publish"',
				"scope_not_allowed",
				"Service account keys cannot use files:publish. Remove it, or choose Personal.",
			),
		]);
	});

	test("reports broken JSON at the right offset", () => {
		const text = '{"name": "Reader" "scopes": ["files:list"]}';

		const result = parse_personal(text);

		expect(result.setup).toBeNull();
		expect(result.errors[0]).toEqual(error_at(text, '"scopes"', "syntax", "Comma expected"));
	});

	test("reports deeply nested brackets instead of throwing", () => {
		const result = parse_personal("[".repeat(16_000));

		expect(result.errors.map((error) => error.message)).toEqual(["The setup has too many nested brackets."]);
	});

	test("accepts a name of 80 characters and refuses an empty or longer name", () => {
		const nameErrors = (name: string) =>
			parse_personal(JSON.stringify({ name, scopes: ["files:list"] })).errors.map((error) => error.message);

		expect(nameErrors("a".repeat(80))).toEqual([]);
		expect(nameErrors("   ")).toEqual(["API key name is required"]);
		expect(nameErrors("a".repeat(81))).toEqual(["API key name must be 80 characters or fewer"]);
	});

	test("refuses an empty scope list", () => {
		const text = '{"name": "Reader", "scopes": []}';

		expect(parse_personal(text)).toEqual({
			setup: null,
			errors: [error_at(text, "[]", "scopes_empty", "Choose at least one scope.")],
			warnings: [],
		});
	});

	test("reads text pasted with non-breaking spaces", () => {
		const result = parse_personal('{\u00A0"name": "Reader",\u00A0"scopes": ["files:list"]}');

		expect(result.setup).toEqual({ name: "Reader", scopes: ["files:list"] });
	});
});

describe("api_key_setup_suggest", () => {
	test("suggests only the allowed scopes the list does not have yet, and replaces the string under the cursor", () => {
		const text = '{"name": "Reader", "scopes": ["files:list", "fi"]}';

		const result = api_key_setup_suggest(text, text.indexOf('fi"') + 2, SERVICE_ACCOUNT_SCOPES);

		expect(result).toEqual({
			kind: "scope",
			values: ["files:read", "files:write"],
			replace: { offset: text.indexOf('"fi"'), length: 4 },
		});
	});

	test("suggests the missing field names and sees a colon that is already there", () => {
		const text = '{"name": "Reader", "sc": []}';

		const result = api_key_setup_suggest(text, text.indexOf('sc"') + 2, ALLOWED_SCOPES);

		expect(result).toEqual({
			kind: "field",
			values: ["scopes"],
			replace: { offset: text.indexOf('"sc"'), length: 4 },
			colonFollows: true,
		});
	});
});

describe("api_key_setup_with_scopes", () => {
	test("rewrites only the scopes list and refuses broken JSON", () => {
		const text = '{\n  // CI uploads\n  "name": "Uploader", "scopes": ["files:list"] // keep\n}';

		expect(api_key_setup_with_scopes(text, ["files:list", "files:write"])).toBe(
			'{\n  // CI uploads\n  "name": "Uploader", "scopes": [\n    "files:list",\n    "files:write"\n  ] // keep\n}',
		);
		expect(api_key_setup_with_scopes('{"name": "Uploader" "scopes": []}', ["files:list"])).toBeNull();
	});
});

describe("api_key_setup_format_edits", () => {
	test("lays out a pasted one-line setup like the default one, and keeps the text inside strings", () => {
		const text = '{"name":"My  reader","scopes":["files:list","files:read"]}';

		expect(applyEdits(text, api_key_setup_format_edits(text, { offset: 0, length: text.length }))).toBe(
			'{\n  "name": "My  reader",\n  "scopes": [\n    "files:list",\n    "files:read"\n  ]\n}',
		);
	});
});

describe("api_key_setup_quick_fixes", () => {
	test("offers a close scope for a typo, and only removal for a word that is not close", () => {
		const text = '{"name": "Reader", "scopes": ["files:raed", "constructor"]}';

		const titles = parse_personal(text).errors.map((error) =>
			api_key_setup_quick_fixes(text, error, ALLOWED_SCOPES).map((fix) => fix.title),
		);

		expect(titles).toEqual([["Change to files:read", "Remove this scope"], ["Remove this scope"]]);
	});

	test("turns a setup with a typo, an unknown field, and no name into one that parses", () => {
		let text = '{\n  "scope": [],\n  "scopes": [\n    "files:list",\n    "files:raed"\n  ]\n}';

		// Apply the first fix of the first fixable error until no error has a fix.
		for (let round = 0; round < 10; round++) {
			const fix = parse_personal(text)
				.errors.map((error) => api_key_setup_quick_fixes(text, error, ALLOWED_SCOPES)[0])
				.find((item) => item !== undefined);
			if (!fix) {
				break;
			}
			text = applyEdits(text, fix.edits);
		}

		expect(text).toBe('{\n  "name": "",\n  "scopes": [\n    "files:list",\n    "files:read"\n  ]\n}');
	});
});
