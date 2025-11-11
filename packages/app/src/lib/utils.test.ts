import { test, expect, describe } from "vitest";
import { string_optional } from "./utils.ts";

describe("string_optional", () => {
	test("Should return interpolated string when value is not empty", () => {
		expect(string_optional`Hello ${"world"}`).toBe("Hello world");
	});

	test("Should return empty string if all values are empty", () => {
		expect(string_optional`Hello ${""}`).toBe("");
		expect(string_optional`Hello ${null}`).toBe("");
		expect(string_optional`Hello ${undefined}`).toBe("");
	});
});
