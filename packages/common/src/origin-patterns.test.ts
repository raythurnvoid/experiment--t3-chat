import { describe, expect, test } from "vitest";
import { origin_patterns_allows } from "./origin-patterns.ts";

describe("origin_patterns_allows", () => {
	const entries = ["https://api.example.org", "https://*.example.com", "https://*.ports.example.net:8443"];

	test.each([
		["exact origin", "https://api.example.org/v1", true],
		["exact origin does not cover a subdomain", "https://a.api.example.org/", false],
		["pattern, one label deep", "https://a.example.com/x", true],
		["pattern, two labels deep", "https://a.b.example.com/", true],
		["pattern never matches its base host", "https://example.com/", false],
		["other scheme", "http://a.example.com/", false],
		["other port", "https://a.example.com:444/", false],
		["pattern with a port", "https://a.ports.example.net:8443/", true],
		["pattern with a port, default port", "https://a.ports.example.net/", false],
		["look-alike host", "https://evilexample.com/", false],
		["trailing dot", "https://a.example.com./", false],
	])("%s", (_name, url, allowed) => {
		expect(origin_patterns_allows(entries, new URL(url))).toBe(allowed);
	});
});
