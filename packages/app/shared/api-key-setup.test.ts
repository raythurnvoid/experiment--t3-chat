import { describe, expect, test } from "vitest";
import { api_key_setup_parse, api_key_setup_suggest } from "./api-key-setup.ts";

const ALLOWED_SCOPES = ["files:list", "files:read", "files:write", "files:publish"] as const;
const SERVICE_ACCOUNT_SCOPES = ["files:list", "files:read", "files:write"] as const;

function parse_personal(text: string) {
	return api_key_setup_parse(text, { allowedScopes: ALLOWED_SCOPES, serviceAccountScopes: null });
}

/**
 * The error for the first place `marked` appears in `text`, with the exact offset and length.
 */
function error_at(text: string, marked: string, message: string) {
	return { offset: text.indexOf(marked), length: marked.length, message };
}

describe("api_key_setup_parse", () => {
	test("returns the trimmed name and the scopes once each", () => {
		const result = parse_personal(`{
	// Comments and trailing commas are fine.
	"name": "  Local file reader ",
	"scopes": ["files:list", "files:read", "files:list",],
}`);

		expect(result).toEqual({ setup: { name: "Local file reader", scopes: ["files:list", "files:read"] }, errors: [] });
	});

	test("marks the exact text of an unknown scope, an unknown field, and a repeated field", () => {
		const text = '{"name": "Reader", "scope": [], "scopes": ["files:raed", "constructor"], "scopes": ["files:list"]}';

		const result = parse_personal(text);

		expect(result.setup).toBeNull();
		expect(result.errors).toEqual([
			error_at(text, '"scope"', 'Unknown field "scope". Use only "name" and "scopes".'),
			error_at(text, '"files:raed"', 'Unknown scope "files:raed". See "All scopes" for the list.'),
			error_at(text, '"constructor"', 'Unknown scope "constructor". See "All scopes" for the list.'),
			{
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
			error_at(text, '"files:publish"', "Service account keys cannot use files:publish. Remove it, or choose Personal."),
		]);
	});

	test("reports broken JSON at the right offset", () => {
		const text = '{"name": "Reader" "scopes": ["files:list"]}';

		const result = parse_personal(text);

		expect(result.setup).toBeNull();
		expect(result.errors[0]).toEqual(error_at(text, '"scopes"', "Comma expected"));
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
			errors: [error_at(text, "[]", "Choose at least one scope.")],
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
