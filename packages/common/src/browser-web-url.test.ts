import { describe, expect, test } from "vitest";
import { browser_web_host_matches, browser_web_normalize_url, browser_web_url_host_matches } from "./browser-web-url.ts";

describe("browser_web_normalize_url", () => {
	test("adds https to a bare host", () => {
		expect(browser_web_normalize_url(" example.com/docs ", [])).toEqual({ ok: true, url: "https://example.com/docs" });
		expect(browser_web_normalize_url("localhost:3000", [])).toEqual({ ok: true, url: "https://localhost:3000/" });
	});

	test("keeps http and https", () => {
		expect(browser_web_normalize_url("http://example.com", [])).toEqual({ ok: true, url: "http://example.com/" });
		expect(browser_web_normalize_url("HTTPS://Example.com/A?b=1#c", [])).toEqual({
			ok: true,
			url: "https://example.com/A?b=1#c",
		});
	});

	test("refuses other schemes", () => {
		expect(browser_web_normalize_url("ftp://x", [])).toEqual({ ok: false, reason: "scheme" });
		expect(browser_web_normalize_url("javascript:alert(1)", [])).toEqual({ ok: false, reason: "scheme" });
		expect(browser_web_normalize_url("data:text/html,hi", [])).toEqual({ ok: false, reason: "scheme" });
		expect(browser_web_normalize_url("file:///etc/passwd", [])).toEqual({ ok: false, reason: "scheme" });
	});

	test("refuses user and password", () => {
		expect(browser_web_normalize_url("http://user:pw@example.com", [])).toEqual({ ok: false, reason: "credentials" });
		expect(browser_web_normalize_url("https://user@example.com", [])).toEqual({ ok: false, reason: "credentials" });
	});

	test("refuses empty, invalid, and long input", () => {
		expect(browser_web_normalize_url("   ", [])).toEqual({ ok: false, reason: "empty" });
		expect(browser_web_normalize_url("http://", [])).toEqual({ ok: false, reason: "invalid" });
		expect(browser_web_normalize_url(`example.com/${"a".repeat(9000)}`, [])).toEqual({ ok: false, reason: "too_long" });
	});

	test("refuses denied hosts and their subdomains", () => {
		const denied = ["app.example.com", "convex.cloud"];
		expect(browser_web_normalize_url("app.example.com", denied)).toEqual({ ok: false, reason: "denied_host" });
		expect(browser_web_normalize_url("https://x.convex.cloud/api", denied)).toEqual({ ok: false, reason: "denied_host" });
		expect(browser_web_normalize_url("https://APP.EXAMPLE.COM./", denied)).toEqual({ ok: false, reason: "denied_host" });
		expect(browser_web_normalize_url("https://example.com", denied)).toEqual({ ok: true, url: "https://example.com/" });
		expect(browser_web_normalize_url("https://notconvex.cloud", denied)).toEqual({ ok: true, url: "https://notconvex.cloud/" });
	});
});

describe("browser_web_host_matches", () => {
	test("matches exact hosts and subdomains only", () => {
		expect(browser_web_host_matches("bank.com", ["bank.com"])).toBe(true);
		expect(browser_web_host_matches("www.bank.com.", ["Bank.com"])).toBe(true);
		expect(browser_web_host_matches("mybank.com", ["bank.com"])).toBe(false);
		expect(browser_web_host_matches("bank.com", [""])).toBe(false);
	});
});

describe("browser_web_url_host_matches", () => {
	test("matches the host of a url", () => {
		expect(browser_web_url_host_matches("https://www.bank.com/login", ["bank.com"])).toBe(true);
		expect(browser_web_url_host_matches("http://[::1]:8080/", ["::1"])).toBe(true);
		expect(browser_web_url_host_matches("https://mybank.com/", ["bank.com"])).toBe(false);
	});

	test("never matches a url that does not parse", () => {
		expect(browser_web_url_host_matches("not a url", ["bank.com"])).toBe(false);
	});
});
