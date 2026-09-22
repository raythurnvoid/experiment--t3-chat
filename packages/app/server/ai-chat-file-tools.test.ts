import { R2 } from "@convex-dev/r2";
import type { InferToolInput, InferToolOutput } from "ai";
import { getFunctionName } from "convex/server";
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
const agentSource = {
	organizationId: "organization-1" as Id<"organizations">,
	workspaceId: "workspace-1" as Id<"organizations_workspaces">,
	userId: "user-1" as Id<"users">,
	membershipId: "membership-1" as Id<"organizations_workspaces_users">,
	membershipLifetime: 42,
	threadId: "thread-1" as Id<"ai_chat_threads">,
};

function makeReader(overrides: Partial<typeof file> = {}) {
	const readSource = vi.fn().mockResolvedValue({ _yay: { ...file, ...overrides } });
	const resolve = vi.fn().mockImplementation(async ({ workspace }: { workspace: "current" | "personal" }) => ({
		_yay: { membershipId: workspace === "current" ? "membership-1" : "membership-home" },
	}));
	const runQuery = vi.fn(async (query: Parameters<ActionCtx["runQuery"]>[0], args?: unknown) =>
		getFunctionName(query) === "ai_chat_workspaces:resolve" ? resolve(args) : readSource(args),
	);
	const observations = new Map<string, ai_chat_Observation>();
	const tool = ai_chat_tool_create_view_image({ runQuery } as unknown as ActionCtx, {
		...agentSource,
		getThreadId: () => agentSource.threadId,
		observations,
	});
	return { tool, runQuery, readSource, resolve, observations };
}

type Viewer = ReturnType<typeof ai_chat_tool_create_view_image>;

async function execute(
	tool: Viewer,
	toolCallId = "view-1",
	abortSignal?: AbortSignal,
	workspace: "current" | "personal" = "current",
) {
	if (!tool.execute) throw new Error("Missing execute");
	return (await tool.execute(
		{ workspace, path: file.path },
		{ toolCallId, messages: [], abortSignal },
	)) as InferToolOutput<Viewer>;
}

async function convert(tool: Viewer, output: InferToolOutput<Viewer>, toolCallId = "view-1") {
	if (!tool.toModelOutput) throw new Error("Missing converter");
	return await tool.toModelOutput({
		input: { workspace: "current", path: file.path } satisfies InferToolInput<Viewer>,
		output,
		toolCallId,
	});
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

	test("requires the workspace selector and workspace-relative path", () => {
		const { tool } = makeReader();
		if (!has_defined_property(tool.inputSchema, "parse")) throw new Error("Missing schema");
		const schema = tool.inputSchema;
		for (const workspace of ["current", "personal"])
			expect(schema.parse({ workspace, path: file.path })).toEqual({ workspace, path: file.path });
		for (const input of [
			{},
			{ path: file.path },
			{ workspace: "other", path: file.path },
			{ workspace: "current", path: "" },
			{ workspace: "current", path: "reports/image.png" },
			{ workspace: "current", path: "https://example.com/a.png" },
			{ workspace: "current", path: file.path, format: "image" },
			{ workspace: "current", path: file.path, target },
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
			expect(runQuery).toHaveBeenCalledTimes(3);
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
			expect(runQuery).toHaveBeenCalledTimes(3);
		},
	);

	test.each(["denied", "asset", "revision", "target"])(
		"withholds bytes when %s changes during the GET",
		async (change) => {
			const { tool, readSource, observations } = makeReader();
			readSource.mockResolvedValueOnce({ _yay: file }).mockResolvedValueOnce(
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
		const { tool, readSource } = makeReader();
		const saved = { kind: "saved", id: "saved-1" };
		readSource.mockResolvedValue({ _yay: { ...file, target: saved } });
		expect((await execute(tool)).metadata.files).toEqual([saved]);
		expect(readSource.mock.calls[1]?.[0]).toMatchObject({ path: file.path, target: saved });
	});

	test("fails before GET when current access is denied", async () => {
		const { tool, readSource } = makeReader();
		readSource.mockResolvedValue({ _nay: { message: "Denied" } });
		expect((await execute(tool)).metadata.reason).toBe("unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each(["current", "personal"] as const)(
		"reads %s with the captured source and exact destination",
		async (workspace) => {
			const { tool, readSource, resolve, observations } = makeReader();
			const result = await execute(tool, "view-1", undefined, workspace);
			expect(result.metadata.status).toBe("succeeded");
			expect(resolve).toHaveBeenCalledExactlyOnceWith({ source: agentSource, workspace });
			const readArgs = {
				userId: agentSource.userId,
				membershipId: workspace === "current" ? agentSource.membershipId : "membership-home",
				agentSource,
				path: file.path,
			};
			expect(readSource.mock.calls.map((call) => call[0])).toEqual([readArgs, { ...readArgs, target }]);
			expect(await observations.get("view-1")?.isCurrent()).toBe(true);
			expect(readSource).toHaveBeenLastCalledWith({ ...readArgs, target });
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	test("does not read a file when source resolution fails", async () => {
		const { tool, resolve, readSource } = makeReader();
		resolve.mockResolvedValue({ _nay: { message: "Source access revoked" } });
		expect((await execute(tool, "view-1", undefined, "personal")).metadata.reason).toBe("unavailable");
		expect(readSource).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each(["during fetch", "before next step"])("checks the original source for personal bytes %s", async (when) => {
		const { tool, readSource, observations } = makeReader();
		if (when === "during fetch") {
			vi.mocked(fetch).mockImplementation(async () => {
				readSource.mockResolvedValue({ _nay: { message: "Source access revoked" } });
				return new Response(png);
			});
		}
		const result = await execute(tool, "view-1", undefined, "personal");
		if (when === "during fetch") {
			expect(result.metadata.reason).toBe("unavailable");
			expect(observations.size).toBe(0);
		} else {
			expect(result.metadata.status).toBe("succeeded");
			readSource.mockResolvedValue({ _nay: { message: "Source access revoked" } });
			expect(await observations.get("view-1")?.isCurrent()).toBe(false);
		}
		for (const [readArgs] of readSource.mock.calls)
			expect(readArgs).toMatchObject({ agentSource, membershipId: "membership-home" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("reserves one turn limit across parallel reads from both roots", async () => {
		const bytes = new Uint8Array(5 * 1024 * 1024);
		bytes.set(png);
		vi.mocked(fetch).mockImplementation(async () => new Response(bytes));
		const { tool } = makeReader({ size: bytes.length });
		const results = await Promise.all([execute(tool, "one"), execute(tool, "two", undefined, "personal")]);
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
		const { tool, readSource, observations } = makeReader();
		await execute(tool);
		expect(await observations.get("view-1")?.isCurrent()).toBe(true);
		readSource.mockResolvedValue({ _nay: { message: "Denied" } });
		expect(await observations.get("view-1")?.isCurrent()).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("does not rebuild missing observations during conversion", async () => {
		const { tool, observations, runQuery } = makeReader();
		const result = await execute(tool);
		observations.clear();
		expect((await convert(tool, result)).type).toBe("text");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(runQuery).toHaveBeenCalledTimes(3);
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
