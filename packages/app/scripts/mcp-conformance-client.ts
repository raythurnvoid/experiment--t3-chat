/// <reference types="node" />

// Conformance client for `@modelcontextprotocol/conformance`. The runner starts one scenario server,
// then runs this script with the server URL as the last argument and the scenario name in
// `MCP_CONFORMANCE_SCENARIO`. The script drives the real `server/mcp-client.ts` code, with the
// test-only switch that allows `http://localhost`.
//
// Auth scenarios fail until step 8 of the MCP plan adds sign-in. The baseline files next to this
// script list every expected failure with its reason.

// `server/crypto-utils.ts` needs this Convex env value when it loads. The adapter never encrypts
// anything, so a placeholder is enough. Set it before the dynamic import below.
process.env.PLUGIN_SECRETS_ENCRYPTION_KEY ??= "conformance-placeholder";
const { mcp_client_call_tool, mcp_client_list_tools } = await import("../server/mcp-client.ts");

const CALL_TIMEOUT_MS = 10_000;

const serverUrl = process.argv.at(-1) ?? "";
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? "";
const server = { url: serverUrl, headers: [] };
const signal = new AbortController().signal;

async function list_tools() {
	const listed = await mcp_client_list_tools({
		server,
		accessToken: null,
		timeoutMs: CALL_TIMEOUT_MS,
		signal,
		testAllowLocalHttp: true,
	});
	if (listed._nay) throw new Error("Failed to list tools", { cause: listed._nay });
	return listed._yay;
}

async function call_tool(listed: Awaited<ReturnType<typeof list_tools>>, name: string, args: Record<string, unknown>) {
	const tool = listed.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Failed to find tool ${name}`);

	const called = await mcp_client_call_tool({
		server,
		accessToken: null,
		discover: listed.discover,
		tool,
		arguments: args,
		timeoutMs: CALL_TIMEOUT_MS,
		signal,
		testAllowLocalHttp: true,
	});
	console.log(`[mcp-conformance-client] ${name}:`, JSON.stringify(called));
	return called;
}

const scenarios: Record<string, () => Promise<void>> = {
	initialize: async () => {
		await list_tools();
	},
	tools_call: async () => {
		const listed = await list_tools();
		await call_tool(listed, "add_numbers", { a: 5, b: 3 });
	},
	"request-metadata": async () => {
		await list_tools();
	},
	"json-schema-ref-no-deref": async () => {
		await list_tools();
	},
	"http-standard-headers": async () => {
		const listed = await list_tools();
		for (const tool of listed.tools) await call_tool(listed, tool.name, {});
	},
	"http-custom-headers": async () => {
		const listed = await list_tools();
		const context: unknown = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? "{}");
		const toolCalls =
			typeof context === "object" && context !== null && "toolCalls" in context && Array.isArray(context.toolCalls)
				? (context.toolCalls as Array<{ name: string; arguments: Record<string, unknown> }>)
				: [];
		for (const toolCall of toolCalls) await call_tool(listed, toolCall.name, toolCall.arguments);
	},
	"http-invalid-tool-headers": async () => {
		// Call every tool Press kept. A tool with an invalid `x-mcp-header` must not be in the list.
		const listed = await list_tools();
		for (const tool of listed.tools) await call_tool(listed, tool.name, { region: "us-west1" });
	},
	"sep-2322-client-request-state": async () => {
		// Press does not answer `input_required`, so the first three calls fail on purpose. The last
		// two still check that Press sends no request state and never retries.
		const listed = await list_tools();
		for (const name of [
			"test_mrtr_echo_state",
			"test_mrtr_no_state",
			"test_mrtr_unrelated",
			"test_mrtr_no_result_type",
		]) {
			await call_tool(listed, name, {});
		}
	},
	"sse-retry": async () => {
		const listed = await list_tools();
		await call_tool(listed, "test_reconnection", {});
	},
	"elicitation-sep1034-client-defaults": async () => {
		const listed = await list_tools();
		await call_tool(listed, "test_client_elicitation_defaults", {});
	},
};

const run = scenarios[scenario];
// Set `exitCode` instead of calling `process.exit()`. On Windows, `process.exit()` while fetch handles
// are still closing can crash Node with a libuv assertion (exit code 9).
if (!run) {
	console.error(`[mcp-conformance-client] Unknown scenario: ${scenario}`);
	process.exitCode = 1;
} else {
	await run().catch((error: unknown) => {
		console.error("[mcp-conformance-client] Scenario failed", { scenario, error });
		process.exitCode = 1;
	});
}
