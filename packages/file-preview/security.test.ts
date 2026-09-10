import { describe, expect, test } from "vitest";
import { file_preview_security_config } from "./security";

describe("file_preview_security_config", () => {
	test("requires exact production HTTPS origins", () => {
		for (const value of [
			undefined,
			"",
			"*",
			"https://*.example.com",
			"https://press.example/",
			"https://press.example/path",
			"http://localhost:5173",
			"https://user:password@press.example",
		]) {
			expect(() => file_preview_security_config(value, false)).toThrow();
		}
		const config = file_preview_security_config("https://press.example,https://staging.example", false);
		expect(config.origins).toEqual(["https://press.example", "https://staging.example"]);
		expect(config.headers["Content-Security-Policy"]).toContain(
			"frame-ancestors 'self' https://press.example https://staging.example",
		);
		expect(config.headers["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
	});

	test("permits only the documented HTTP development origins", () => {
		const config = file_preview_security_config(undefined, true);
		expect(config.origins).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
		expect(config.headers["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
		expect(() => file_preview_security_config("http://localhost:5174", true)).toThrow();
		expect(() => file_preview_security_config("https://press.example", true)).toThrow();
	});

	test("emits the same full policy for every asset and fallback path", () => {
		const config = file_preview_security_config(undefined, true);
		expect(config.staticHeaders.startsWith("/*\n")).toBe(true);
		for (const [name, value] of Object.entries(config.headers))
			expect(config.staticHeaders).toContain(`  ${name}: ${value}\n`);
		const policy = config.headers["Content-Security-Policy"];
		expect(policy).toContain("connect-src https://esm.sh");
		expect(policy).toContain("worker-src 'none'");
		expect(policy).toContain("frame-src 'self' blob:");
		expect(policy).toContain("form-action 'none'");
		expect(policy).not.toContain("unsafe-eval");
	});
});
