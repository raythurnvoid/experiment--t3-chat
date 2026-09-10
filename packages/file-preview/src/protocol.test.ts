import { describe, expect, test } from "vitest";
import {
	file_preview_HostMessageSchema,
	file_preview_MaxHtmlBytes,
	file_preview_RuntimeMessageSchema,
} from "./protocol";

const fields = {
	protocol: "bonobo-file-preview",
	version: 1,
	sessionId: "8a16bed0-5b30-4c38-b643-33d708f6b285",
};
const loadId = "7d0c56c4-07e1-457a-9b70-dcf7c9f43010";

describe("file_preview_HostMessageSchema", () => {
	test("accepts hello and bounded HTML", () => {
		expect(file_preview_HostMessageSchema.safeParse({ ...fields, type: "hello" }).success).toBe(true);
		expect(
			file_preview_HostMessageSchema.safeParse({ ...fields, type: "load_html", loadId, html: "<p>Hello</p>" }).success,
		).toBe(true);
	});

	test("rejects unknown commands, versions, fields, and identities", () => {
		for (const changes of [{ type: "save" }, { version: 2 }, { sessionId: "" }, { token: "secret" }]) {
			expect(file_preview_HostMessageSchema.safeParse({ ...fields, type: "hello", ...changes }).success).toBe(false);
		}
	});

	test("counts UTF-8 bytes at the source boundary", () => {
		const message = { ...fields, type: "load_html", loadId };
		expect(
			file_preview_HostMessageSchema.safeParse({ ...message, html: "é".repeat(file_preview_MaxHtmlBytes / 2) }).success,
		).toBe(true);
		expect(
			file_preview_HostMessageSchema.safeParse({ ...message, html: "é".repeat(file_preview_MaxHtmlBytes / 2 + 1) })
				.success,
		).toBe(false);
	});
});

describe("file_preview_RuntimeMessageSchema", () => {
	test("accepts only the bounded status fields", () => {
		expect(file_preview_RuntimeMessageSchema.safeParse({ ...fields, type: "ready" }).success).toBe(true);
		expect(file_preview_RuntimeMessageSchema.safeParse({ ...fields, type: "loaded", loadId }).success).toBe(true);
		const error = { ...fields, type: "error", loadId, message: "a".repeat(500) };
		expect(file_preview_RuntimeMessageSchema.safeParse(error).success).toBe(true);
		expect(file_preview_RuntimeMessageSchema.safeParse({ ...error, message: "a".repeat(501) }).success).toBe(false);
		expect(file_preview_RuntimeMessageSchema.safeParse({ ...error, stack: "private source" }).success).toBe(false);
	});
});
