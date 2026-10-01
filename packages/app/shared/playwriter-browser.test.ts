import { describe, expect, test } from "vitest";
import { playwriter_parse_share } from "./playwriter-browser.ts";

const share = "a".repeat(32);

describe("playwriter_parse_share", () => {
	test("accepts only a lowercase ID or the exact official link", () => {
		expect(playwriter_parse_share(` ${share} `)).toBe(share);
		expect(playwriter_parse_share(`https://playwriter.dev/remote-control#${share}`)).toBe(share);
	});

	test.each([
		"A".repeat(32),
		"a".repeat(31),
		`https://other.test/remote-control#${share}`,
		`https://playwriter.dev.other.test/remote-control#${share}`,
		`https://playwriter.dev:443/remote-control#${share}`,
		`https://user@playwriter.dev/remote-control#${share}`,
		`https://playwriter.dev/remote-control?x=1#${share}`,
		`https://playwriter.dev/remote-control/#${share}`,
		`http://playwriter.dev/remote-control#${share}`,
		`wss://playwriter.dev/remote-control#${share}`,
		`playwriter --remote ${share} -e 'run code'`,
	])("refuses other forms: %s", (value) => {
		expect(playwriter_parse_share(value)).toBeNull();
	});
});
