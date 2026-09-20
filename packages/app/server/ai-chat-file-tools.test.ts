import { R2 } from "@convex-dev/r2";
import type { InferToolInput, InferToolOutput } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { has_defined_property } from "../shared/shared-utils.ts";
import { ai_chat_tool_create_view_image, type ai_chat_Observation } from "./ai-chat-file-tools.ts";

// Complete images, not arbitrary bytes with an image MIME label. PNG/JPEG/WEBP were encoded by Chromium.
const fixtures = {
	"image/png":
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWJiYGD4D8IgBpBmYAAAAAD//7vS9wEAAAAGSURBVAMAGDACA6ybwrYAAAAASUVORK5CYII=",
	"image/jpeg":
		"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJVAA//Z",
	"image/webp":
		"UklGRgYCAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggGAAAADABAJ0BKgIAAgABQCYlpAADcAD+/TZoAA==",
	"image/gif": "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};
const target = { kind: "private" as const, id: "private-1" };
const png = Uint8Array.from(atob(fixtures["image/png"]), (char) => char.charCodeAt(0));
const file = {
	target,
	assetId: "asset-1",
	r2Key: "file-key",
	contentType: "application/octet-stream",
	size: png.length,
	path: "/reports/image.bin",
	revision: "revision-1",
};

function makeReader(overrides: Partial<typeof file> = {}) {
	const runQuery = vi.fn().mockResolvedValue({ _yay: { ...file, ...overrides } });
	const observations = new Map<string, ai_chat_Observation>();
	const tool = ai_chat_tool_create_view_image({ runQuery } as unknown as ActionCtx, {
		userId: "user-1" as Id<"users">,
		membershipId: "membership-1" as Id<"organizations_workspaces_users">,
		getThreadId: () => "thread-1" as Id<"ai_chat_threads">,
		observations,
	});
	return { tool, runQuery, observations };
}

type Viewer = ReturnType<typeof ai_chat_tool_create_view_image>;

async function execute(tool: Viewer, toolCallId = "view-1", abortSignal?: AbortSignal) {
	if (!tool.execute) throw new Error("Missing execute");
	return (await tool.execute(
		{ path: file.path },
		{ toolCallId, messages: [], abortSignal },
	)) as InferToolOutput<Viewer>;
}

async function convert(tool: Viewer, output: InferToolOutput<Viewer>, toolCallId = "view-1") {
	if (!tool.toModelOutput) throw new Error("Missing converter");
	return await tool.toModelOutput({ input: { path: file.path } satisfies InferToolInput<Viewer>, output, toolCallId });
}

describe("ai_chat_tool_create_view_image", () => {
	beforeEach(() => {
		vi.spyOn(R2.prototype, "getUrl").mockResolvedValue("https://r2.test/file");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => new Response(png)),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("accepts only a required workspace path", () => {
		const { tool } = makeReader();
		if (!has_defined_property(tool.inputSchema, "parse")) throw new Error("Missing schema");
		const schema = tool.inputSchema;
		expect(schema.parse({ path: file.path })).toEqual({ path: file.path });
		for (const input of [
			{},
			{ path: "" },
			{ path: "reports/image.png" },
			{ path: "https://example.com/a.png" },
			{ path: file.path, format: "image" },
			{ path: file.path, target },
			{ target },
		])
			expect(() => schema.parse(input)).toThrow();
	});

	test.each(Object.entries(fixtures))(
		"reads real %s bytes during execute and ignores the declared MIME",
		async (mediaType, encoded) => {
			const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
			vi.mocked(fetch).mockImplementation(async () => new Response(bytes));
			const { tool, runQuery } = makeReader({ size: bytes.length });
			const result = await execute(tool);
			expect(result.metadata).toEqual({ status: "succeeded", reason: null, files: [target] });
			expect(JSON.stringify(result)).not.toContain(encoded);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(runQuery).toHaveBeenCalledTimes(2);
			const model = await convert(tool, result);
			expect(model).toMatchObject({
				type: "content",
				value: [
					{ type: "text", text: expect.stringContaining(file.path) },
					{ type: "image-data", data: encoded, mediaType },
				],
			});
			expect(await convert(tool, result)).toEqual(model);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(runQuery).toHaveBeenCalledTimes(2);
		},
	);

	test.each(["denied", "asset", "revision", "target"])(
		"withholds bytes when %s changes during the GET",
		async (change) => {
			const { tool, runQuery, observations } = makeReader();
			runQuery.mockResolvedValueOnce({ _yay: file }).mockResolvedValueOnce(
				change === "denied"
					? { _nay: { message: "Denied" } }
					: {
							_yay: {
								...file,
								...(change === "asset" ? { assetId: "asset-2" } : {}),
								...(change === "revision" ? { revision: "revision-2" } : {}),
								...(change === "target" ? { target: { kind: "saved", id: "saved-1" } } : {}),
							},
						},
			);
			const result = await execute(tool);
			expect(result.metadata.status).toBe("errored");
			expect(observations.size).toBe(0);
			expect((await convert(tool, result)).type).toBe("text");
		},
	);

	test("records the saved identity when a private link already resolves through Save", async () => {
		const { tool, runQuery } = makeReader();
		const saved = { kind: "saved", id: "saved-1" };
		runQuery.mockResolvedValue({ _yay: { ...file, target: saved } });
		expect((await execute(tool)).metadata.files).toEqual([saved]);
		expect(runQuery.mock.calls[1]?.[1]).toMatchObject({ path: file.path, target: saved });
	});

	test("fails before GET when current access is denied", async () => {
		const { tool, runQuery } = makeReader();
		runQuery.mockResolvedValue({ _nay: { message: "Denied" } });
		expect((await execute(tool)).metadata.reason).toBe("unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("reserves the turn limit before parallel reads", async () => {
		const bytes = new Uint8Array(5 * 1024 * 1024);
		bytes.set(png);
		vi.mocked(fetch).mockImplementation(async () => new Response(bytes));
		const { tool } = makeReader({ size: bytes.length });
		const results = await Promise.all([execute(tool, "one"), execute(tool, "two")]);
		expect(results.map((result) => result.metadata.status)).toEqual(["succeeded", "errored"]);
		expect(results[1]?.metadata.reason).toBe("limit");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test.each(["zero", "edge", "pixels", "truncated", "unknown", "short_body", "long_body"])(
		"refuses %s image content",
		async (kind) => {
			let bytes = png.slice();
			const data = new DataView(bytes.buffer);
			if (kind === "zero") data.setUint32(16, 0);
			if (kind === "edge") data.setUint32(16, 8193);
			if (kind === "pixels") {
				data.setUint32(16, 5000);
				data.setUint32(20, 5000);
			}
			if (kind === "truncated") bytes = bytes.slice(0, 32);
			if (kind === "unknown") bytes.fill(0);
			if (kind === "short_body") bytes = bytes.slice(0, bytes.length - 1);
			if (kind === "long_body") {
				const longer = new Uint8Array(bytes.length + 1);
				longer.set(bytes);
				bytes = longer;
			}
			const size = kind === "short_body" || kind === "long_body" ? png.length : bytes.length;
			vi.mocked(fetch).mockImplementation(async () => new Response(bytes));
			const { tool, observations } = makeReader({ size });
			expect((await execute(tool)).metadata.status).toBe("errored");
			expect(observations.size).toBe(0);
		},
	);

	test("keeps a live source recheck without fetching bytes again", async () => {
		const { tool, runQuery, observations } = makeReader();
		await execute(tool);
		expect(await observations.get("view-1")?.isCurrent()).toBe(true);
		runQuery.mockResolvedValue({ _nay: { message: "Denied" } });
		expect(await observations.get("view-1")?.isCurrent()).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("does not rebuild missing observations during conversion", async () => {
		const { tool, observations, runQuery } = makeReader();
		const result = await execute(tool);
		observations.clear();
		expect((await convert(tool, result)).type).toBe("text");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(runQuery).toHaveBeenCalledTimes(2);
	});

	test("Stop before reading does not read or add observations", async () => {
		const { tool, observations, runQuery } = makeReader();
		const controller = new AbortController();
		controller.abort();
		expect((await execute(tool, "view-1", controller.signal)).metadata.status).toBe("cancelled");
		expect(observations.size).toBe(0);
		expect(runQuery).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
