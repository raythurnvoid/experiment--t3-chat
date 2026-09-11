import { describe, expect, test } from "vitest";
import { ai_chat_skills_LIMITS, ai_chat_skills_parse } from "./ai-chat-skills.ts";

describe("ai_chat_skills_parse", () => {
	test("validates standard fields and returns only catalog metadata", () => {
		const parsed = ai_chat_skills_parse(
			"\uFEFF---\r\nname: example\r\ndescription: A useful skill\r\nlicense: MIT\r\ncompatibility: Needs Python\r\nmetadata:\r\n  bonobo-script-runtime: python\r\nallowed-tools: Bash\r\nfuture-field: [ignored]\r\n---\r\nPrivate body\r\n",
			"example",
		);
		expect(parsed._yay).toEqual({
			name: "example",
			description: "A useful skill",
		});
	});

	test.each([
		["no YAML", "example"],
		["---\nname: example\nname: example\ndescription: duplicate\n---\n", "example"],
		["---\nname: example\ndescription: [not, text]\n---\n", "example"],
		["---\nname: example\ndescription: ok\nmetadata:\n  runtime: 3\n---\n", "example"],
		["---\nname: example\ndescription: !custom text\n---\n", "example"],
		["---\nname: Other\ndescription: ok\n---\n", "Other"],
		["---\nname: two--hyphens\ndescription: ok\n---\n", "two--hyphens"],
		["---\nname: example\ndescription: ok\n---\n", "different"],
		["---\nname: example\ndescription: ' '\n---\n", "example"],
		[`---\nname: example\ndescription: '${"a".repeat(1025)}'\n---\n`, "example"],
		[`---\nname: example\ndescription: ok\ncompatibility: '${"a".repeat(501)}'\n---\n`, "example"],
	])("refuses malformed or invalid frontmatter: %s", (text, folderName) => {
		expect(ai_chat_skills_parse(text, folderName)._nay?.name).toBe("invalid");
	});

	test("distinguishes valid Unicode skill names from the app path limit", () => {
		expect(ai_chat_skills_parse("---\nname: 日本語\ndescription: ok\n---\n", "日本語")._nay?.message).toContain(
			"valid in Agent Skills",
		);
	});

	test("bounds YAML aliases and never returns a parser's source text", () => {
		const text =
			"---\nname: example\ndescription: PRIVATE_SENTINEL\na: &a [x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b]\n---\n";
		const parsed = ai_chat_skills_parse(text, "example");
		expect(parsed._nay?.name).toBe("invalid");
		expect(JSON.stringify(parsed)).not.toContain("PRIVATE_SENTINEL");
	});

	test("accepts simple aliases and empty bodies", () => {
		expect(ai_chat_skills_parse("---\nname: &name example\ndescription: *name\n---\n", "example")._yay).toEqual({
			name: "example",
			description: "example",
		});
	});

	test("does not load or bound the body while enforcing the UTF-8 frontmatter limit", () => {
		expect(
			ai_chat_skills_parse(
				`---\nname: example\ndescription: ok\n---\n${"🐵".repeat(ai_chat_skills_LIMITS.skill / 4)}`,
				"example",
			)._yay,
		).toEqual({ name: "example", description: "ok" });
		expect(
			ai_chat_skills_parse(
				`---\nname: example\ndescription: ok\n#${"x".repeat(ai_chat_skills_LIMITS.frontmatter)}\n---\n`,
				"example",
			)._nay?.name,
		).toBe("too_large");
	});
});
