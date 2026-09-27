import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mcp_client_call_tool, mcp_client_list_tools, type mcp_client_NormalizedTool } from "./mcp-client.ts";
import { mcp_fixtures_create } from "./mcp-fixtures/mcp-fixtures.ts";

let fixtures: ReturnType<typeof mcp_fixtures_create>;

beforeEach(() => {
	fixtures = mcp_fixtures_create();
	vi.spyOn(globalThis, "fetch").mockImplementation(fixtures.fetch);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	await fixtures.close();
	vi.restoreAllMocks();
});

const echo_tool: mcp_client_NormalizedTool = {
	name: "echo",
	title: null,
	description: "Echo text",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
	annotations: null,
};

function list(fixture: string, variant = "", timeoutMs = 5000) {
	return mcp_client_list_tools({
		server: { url: `https://${fixture}.fixtures.test/${variant}`, headers: [] },
		accessToken: null,
		timeoutMs,
		signal: new AbortController().signal,
	});
}

async function modern_discover() {
	const listed = await list("modern-basic");
	if (listed._nay) throw new Error("Failed to list the modern-basic fixture", { cause: listed._nay });
	return listed._yay.discover;
}

async function call(
	fixture: string,
	variant: string,
	options: {
		tool?: mcp_client_NormalizedTool;
		arguments?: Record<string, unknown>;
		era?: "modern" | "legacy";
		timeoutMs?: number;
	} = {},
) {
	const discover = options.era === "legacy" ? null : await modern_discover();
	// Keep only the wire entries of the call itself.
	fixtures.wire.length = 0;
	return await mcp_client_call_tool({
		server: { url: `https://${fixture}.fixtures.test/${variant}`, headers: [] },
		accessToken: null,
		discover,
		tool: options.tool ?? echo_tool,
		arguments: options.arguments ?? { text: "hi" },
		timeoutMs: options.timeoutMs ?? 5000,
		signal: new AbortController().signal,
	});
}

describe("mcp_client_list_tools", () => {
	test("lists a modern server with the discover probe and no initialize", async () => {
		const result = await list("modern-basic");

		expect(result._yay).toMatchObject({
			era: "modern",
			protocolVersion: "2026-07-28",
			serverInfo: { name: "modern-basic", version: "1.0.0" },
			dropped: [],
		});
		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["echo", "picture"]);
		expect(result._yay?.tools[0]?.outputSchema).toMatchObject({ required: ["echoed"] });
		expect(result._yay?.discover).not.toBeNull();
		expect(fixtures.wire.map((entry) => entry.rpcMethod)).toEqual(["server/discover", "tools/list"]);
	});

	test("lists a modern server that answers with SSE", async () => {
		const result = await list("modern-sse");

		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["echo", "picture"]);
	});

	test("lists tools of a 2025-11-25 server through initialize", async () => {
		const result = await list("version-legacy");

		expect(result._yay).toMatchObject({ era: "legacy", protocolVersion: "2025-11-25", discover: null });
		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["ping"]);
		expect(fixtures.wire.map((entry) => entry.rpcMethod)).toContain("initialize");
	});

	test("lists tools of a 2025-06-18 server", async () => {
		const result = await list("version-legacy-0618");

		expect(result._yay).toMatchObject({ era: "legacy", protocolVersion: "2025-06-18" });
	});

	test("refuses a server that only speaks 2024-11-05", async () => {
		const result = await list("version-legacy-2024");

		expect(result._nay).toMatchObject({
			name: "unsupported_version",
			message:
				"This server uses an MCP version Press does not support. Press supports 2026-07-28, 2025-11-25, 2025-06-18, and 2025-03-26.",
		});
	});

	test("refuses a server that offers only a future version", async () => {
		const result = await list("version-other");

		expect(result._nay).toMatchObject({ name: "unsupported_version", data: { supported: ["2027-01-01"] } });
	});

	test("refuses an old HTTP+SSE server", async () => {
		const result = await list("version-old-sse");

		expect(result._nay).toMatchObject({
			name: "not_modern_mcp",
			message: "This URL is not an MCP server that Press can use.",
		});
	});

	test("needs sign-in on a 401 and reads the challenge", async () => {
		const result = await list("http-status", "401");

		expect(result._nay).toEqual({
			name: "auth_required",
			message: "This MCP server needs sign-in.",
			data: {
				resourceMetadataUrl: "https://http-status.fixtures.test/.well-known/oauth-protected-resource",
				scope: "files:read",
				error: null,
			},
		});
	});

	test("needs more access on a 403 insufficient_scope", async () => {
		const result = await list("http-status", "403");

		expect(result._nay).toMatchObject({ name: "insufficient_scope", data: { scope: "files:write" } });
	});

	test("retries a 429 twice inside the deadline and reads Retry-After", async () => {
		const result = await list("http-status", "429");

		expect(result._nay).toMatchObject({ name: "rate_limited", data: { retryAfterMs: 1000 } });
		// The probe gets the 429, then the SDK tries `initialize`, so count the probes.
		expect(fixtures.wire.filter((entry) => entry.rpcMethod === "server/discover")).toHaveLength(3);
	});

	test("retries a 500 and then reports a server error", async () => {
		const result = await list("http-status", "500");

		expect(result._nay?.name).toBe("server_error");
		expect(fixtures.wire.filter((entry) => entry.variant === "500")).toHaveLength(3);
	});

	test("does not retry a 429 that would pass the deadline", async () => {
		const result = await list("http-status", "429", 800);

		expect(result._nay?.name).toBe("rate_limited");
		expect(fixtures.wire.filter((entry) => entry.rpcMethod === "server/discover")).toHaveLength(1);
	});

	test("reports a 404 without JSON-RPC as not MCP", async () => {
		const result = await list("http-status", "404");

		expect(result._nay?.name).toBe("not_modern_mcp");
	});

	test("drops each tool Press cannot send to the model and keeps the rest", async () => {
		const result = await list("bad-tools");

		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["good", "local_ref", "bad_output", "lying"]);
		expect(result._yay?.dropped).toEqual([
			{ name: "good", reason: "duplicate name" },
			{ name: "n".repeat(128), reason: "name too long" },
			{ name: "network_ref", reason: "input schema: external_ref" },
			{ name: "recursive_ref", reason: "input schema: recursive_ref" },
			{ name: "huge_schema", reason: "input schema: too_large" },
			{ name: "deep_schema", reason: "input schema: too_large" },
			{ name: "draft_04", reason: "input schema: dialect" },
			{ name: "bad_output", reason: "output schema: external_ref" },
		]);

		const good = result._yay?.tools[0];
		expect(good?.title).toHaveLength(256);
		expect(good?.description).toHaveLength(2048);
		expect(result._yay?.tools[2]?.outputSchema).toBeNull();
		expect(result._yay?.tools[3]?.annotations).toEqual({ readOnlyHint: true, destructiveHint: true });
	});

	test("fails the whole list when a 2026 server sends a malformed tool", async () => {
		const result = await list("bad-tools", "invalid");

		expect(result._nay?.name).toBe("bad_response");
	});

	test("drops a malformed tool on its own on a 2025 server", async () => {
		const result = await list("legacy-bad-tools");

		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["good"]);
		expect(result._yay?.dropped).toEqual([
			{ name: "null_schema", reason: "invalid tool definition" },
			{ name: "root_string", reason: "invalid tool definition" },
		]);
	});

	test("drops tools with an invalid x-mcp-header", async () => {
		const result = await list("header-strict");

		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(["with_header"]);
		// The SDK drops them with only a warning, so they are not in `dropped` (plan 7.6).
		expect(result._yay?.dropped).toEqual([]);
	});

	test("keeps at most 500 tools per server", async () => {
		const result = await list("big", "many");

		expect(result._yay?.tools).toHaveLength(500);
		expect(result._yay?.dropped).toHaveLength(4500);
		expect(result._yay?.dropped[0]?.reason).toBe("too many tools");
	});

	test("refuses a list with more than 20 pages", async () => {
		const result = await list("big", "too-many-pages");

		expect(result._nay?.name).toBe("too_large");
	});

	test.each([
		["empty-cursor", ["a"]],
		["loop", ["a", "b", "c"]],
	])("stops on a repeated cursor (%s)", async (variant, names) => {
		const result = await list("big", variant);

		expect(result._yay?.tools.map((tool) => tool.name)).toEqual(names);
	});

	test("times out a slow list", async () => {
		const result = await list("slow", "list", 200);

		expect(result._nay).toMatchObject({
			name: "timeout",
			message: "The MCP server timed out. It may still have done the work.",
		});
	});
});

describe("mcp_client_call_tool", () => {
	test("calls a modern tool with the prior discover result and no probe", async () => {
		const result = await call("modern-basic", "");

		expect(result._yay?.result).toEqual({
			isError: false,
			blocks: [{ kind: "text", text: "hi" }],
			structured: { echoed: "hi" },
			structuredNote: null,
			bytesIn: expect.any(Number),
		});
		expect(fixtures.wire.map((entry) => entry.rpcMethod)).toEqual(["tools/call"]);
	});

	test("returns a tool error as an error result", async () => {
		const result = await call("modern-basic", "", { arguments: { text: "fail" } });

		expect(result._yay?.result).toMatchObject({ isError: true, blocks: [{ kind: "text", text: "boom" }] });
	});

	test("omits an image and counts its bytes", async () => {
		const result = await call("modern-basic", "", {
			tool: { ...echo_tool, name: "picture", outputSchema: null },
			arguments: {},
		});

		expect(result._yay?.result.blocks).toEqual([{ kind: "omitted", type: "image", mimeType: "image/png", bytes: 8 }]);
	});

	test("calls a modern tool that answers with SSE", async () => {
		const result = await call("modern-sse", "");

		expect(result._yay?.result.blocks).toEqual([{ kind: "text", text: "hi" }]);
	});

	test("calls a 2025 tool in its own session and ends it with a DELETE", async () => {
		const result = await call("version-legacy", "", {
			era: "legacy",
			tool: { ...echo_tool, name: "ping", outputSchema: null },
			arguments: {},
		});

		expect(result._yay?.result.blocks).toEqual([{ kind: "text", text: "pong" }]);
		const methods = fixtures.wire
			.filter((entry) => entry.httpMethod !== "GET")
			.map((entry) => entry.rpcMethod ?? entry.httpMethod);
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
	});

	test("reports an unknown result and does not retry when a legacy session is lost", async () => {
		const result = await call("legacy-session-404", "", {
			era: "legacy",
			tool: { ...echo_tool, name: "ping", outputSchema: null },
			arguments: {},
		});

		expect(result._nay).toMatchObject({
			name: "result_unknown",
			message: "The connection to the MCP server was lost. The result is unknown. Check before you retry.",
		});
		expect(fixtures.wire.filter((entry) => entry.rpcMethod === "tools/call")).toHaveLength(1);
	});

	// The SDK does not end a request when its SSE stream closes early, so the call waits for its
	// timeout. The timeout message already says the tool may have run.
	test.each(["close", "mid-event"])("times out when the stream drops before the answer (%s)", async (variant) => {
		const result = await call("sse-drop", variant, { timeoutMs: 300 });

		expect(result._nay?.name).toBe("timeout");
	});

	test("reads the answer past comments, other events, a server request, and a stray id", async () => {
		const result = await call("sse-extra", "");

		expect(result._yay?.result.blocks).toEqual([{ kind: "text", text: "done" }]);
	});

	test.each(["html", "array", "accepted"])("refuses a bad answer (%s)", async (variant) => {
		const result = await call("bad-content-type", variant, { timeoutMs: 1000 });

		expect(result._nay).toMatchObject({
			name: "bad_response",
			message: "The MCP server sent a response Press cannot read.",
		});
	});

	test.each(["cross-origin", "to-ip"])("refuses a redirect (%s)", async (variant) => {
		const result = await call("redirect", variant);

		expect(result._nay?.name).toBe("bad_response");
	});

	test("refuses a result over 1 MiB", async () => {
		const result = await call("big", "huge-result");

		expect(result._nay?.name).toBe("too_large");
	});

	test.each(["never", "progress"])("times out a call that does not answer (%s)", async (variant) => {
		const result = await call("slow", variant, { timeoutMs: 200 });

		expect(result._nay?.name).toBe("timeout");
	});

	test.each([
		["401", "auth_required"],
		["403", "insufficient_scope"],
		["404", "not_modern_mcp"],
		["405", "not_modern_mcp"],
		["406", "bad_response"],
		["415", "bad_response"],
		["429", "rate_limited"],
		["500", "server_error"],
		["503", "server_error"],
	])("maps HTTP %s to %s and never retries", async (status, code) => {
		const result = await call("http-status", status);

		expect(result._nay?.name).toBe(code);
		expect(fixtures.wire).toHaveLength(1);
	});

	test("mirrors an x-mcp-header parameter as an Mcp-Param header", async () => {
		const listed = await list("header-strict");
		const tool = listed._yay?.tools[0];
		if (!tool) throw new Error("Failed to list the header-strict fixture");

		const result = await call("header-strict", "call", { tool, arguments: { region: "us-west1" } });

		expect(result._yay?.result.blocks).toEqual([{ kind: "text", text: "region us-west1" }]);
		expect(fixtures.wire[0]?.headers.get("mcp-param-region")).toBe("us-west1");
	});

	test.each(["elicit", "state-only"])("refuses a tool that asks for more input (%s)", async (variant) => {
		const result = await call("mrtr", variant);

		expect(result._nay).toMatchObject({
			name: "input_required_unsupported",
			message: "The MCP tool asked for more input. Press does not support that yet.",
		});
	});

	test.each([
		["task", "bad_response"],
		["unknown", "bad_response"],
		// The SDK needs `resultType` on the modern era. Only the legacy codec treats a missing one as complete.
		["missing", "bad_response"],
		["capability-required", "capability_required"],
		["header-mismatch", "bad_response"],
	])("maps the result type or protocol error %s to %s", async (variant, code) => {
		const result = await call("result-types", variant);

		expect(result._nay?.name).toBe(code);
	});

	test("turns invalid arguments into an error result the model can read", async () => {
		const result = await call("result-types", "invalid-params");

		expect(result._yay?.result).toMatchObject({
			isError: true,
			blocks: [{ kind: "text", text: "tool call rejected: invalid arguments: fixture error -32602" }],
		});
	});

	test("turns another protocol error into an error result", async () => {
		const result = await call("result-types", "method-error");

		expect(result._yay?.result.blocks).toEqual([
			{ kind: "text", text: "tool call failed with error -32603: fixture error -32603" },
		]);
	});

	test("normalizes audio, links, and embedded resources without fetching them", async () => {
		const result = await call("bad-output", "mixed", { tool: { ...echo_tool, outputSchema: null } });

		expect(result._yay?.result.blocks).toEqual([
			{ kind: "omitted", type: "audio", mimeType: "audio/wav", bytes: 6 },
			{ kind: "text", text: "resource link: file:///etc/passwd (passwd, unknown type, unknown size)" },
			{ kind: "text", text: "resource file:///a.txt:\nhello" },
			{ kind: "omitted", type: "blob", mimeType: "application/zip", bytes: 3 },
		]);
		expect(fixtures.wire).toHaveLength(1);
	});

	test("refuses an unknown content type", async () => {
		const result = await call("bad-output", "unknown-type");

		// The SDK checks each content block against the spec, so Press never sees an unknown type.
		expect(result._nay?.name).toBe("bad_response");
	});

	test("sends structured output once when a text block has the same JSON", async () => {
		const result = await call("bad-output", "same-json");

		expect(result._yay?.result).toMatchObject({ structured: null, structuredNote: null });
	});

	test.each(["mismatch", "missing-structured"])(
		"keeps the text and drops structured output that does not match (%s)",
		async (variant) => {
			const result = await call("bad-output", variant);

			expect(result._yay?.result).toMatchObject({
				isError: false,
				blocks: [{ kind: "text", text: "hi" }],
				structured: null,
				structuredNote: "structured result did not match its schema",
			});
		},
	);

	test("does not check structured output of an error result", async () => {
		const result = await call("bad-output", "error-structured");

		expect(result._yay?.result).toMatchObject({ isError: true, structured: { echoed: 1 }, structuredNote: null });
	});
});
