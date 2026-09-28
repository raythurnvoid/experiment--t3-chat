/// <reference types="node" />

import type { mcp_oauth_Client } from "../server/mcp-oauth.ts";

// Conformance client for `@modelcontextprotocol/conformance`. The runner starts one scenario server,
// then runs this script with the server URL as the last argument and the scenario name in
// `MCP_CONFORMANCE_SCENARIO`. The script drives the real `server/mcp-client.ts` and
// `server/mcp-oauth.ts` code, with the test-only switch that allows `http://localhost`. The baseline
// files next to this script list every expected failure with its reason.

// `server/crypto-utils.ts` needs this Convex env value when it loads. The adapter never encrypts
// anything, so a placeholder is enough. Set it before the dynamic import below.
process.env.PLUGIN_SECRETS_ENCRYPTION_KEY ??= "conformance-placeholder";
const { mcp_client_auth_challenge, mcp_client_call_tool, mcp_client_list_tools, mcp_client_step_up_scope } =
	await import("../server/mcp-client.ts");
const { mcp_oauth_callback_iss_matches, mcp_oauth_exchange, mcp_oauth_start } = await import("../server/mcp-oauth.ts");

const CALL_TIMEOUT_MS = 10_000;

// The authorization server redirects here, and the adapter reads the answer from `Location`, so the
// address is never opened.
const REDIRECT_URI = "https://app.press.test/oauth/mcp/callback";

// `auth/basic-cimd` expects this exact client id, and counts any other value as a warning that fails
// the run. Press never fetches it here: the check that the app serves its own document runs only in
// Convex.
const CLIENT_ID_METADATA_URL = "https://conformance-test.local/client-metadata.json";

const serverUrl = process.argv.at(-1) ?? "";
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? "";
const server = { url: serverUrl, headers: [] };
const signal = new AbortController().signal;

/**
 * What Convex stores for one member's sign-in: the pinned issuer, the registered client, the token,
 * and the granted scopes. The adapter keeps it in memory for one scenario.
 */
const signIn = {
	pinnedIssuer: null as string | null,
	client: null as mcp_oauth_Client | null,
	accessToken: null as string | null,
	scopes: [] as string[],
};

/**
 * Pin the issuer once, at the first discovery, like a plugin manifest or a saved server does. The
 * conformance AS runs on a random port, so the adapter takes the first issuer the PRM names. It also
 * trusts that issuer when it does not promise `iss`. Reading the PRM again later could
 * follow a new sign-in server, and Press never does that.
 */
async function pin_issuer(resourceMetadataUrl: string | null) {
	const url = new URL(serverUrl);
	const path = url.pathname.replace(/\/$/u, "");
	const candidates = [
		resourceMetadataUrl,
		path ? new URL(`/.well-known/oauth-protected-resource${path}`, url.origin).href : null,
		new URL("/.well-known/oauth-protected-resource", url.origin).href,
	];
	for (const candidate of candidates) {
		if (candidate === null) continue;
		const response = await fetch(candidate);
		if (!response.ok) continue;
		const prm: unknown = await response.json();
		const issuer =
			typeof prm === "object" &&
			prm !== null &&
			"authorization_servers" in prm &&
			Array.isArray(prm.authorization_servers) &&
			typeof prm.authorization_servers[0] === "string"
				? prm.authorization_servers[0]
				: null;
		if (issuer === null) break;
		signIn.pinnedIssuer = issuer;
		process.env.MCP_TRUSTED_ISSUERS = issuer;
		return;
	}
	throw new Error("Failed to find the issuer to pin");
}

/**
 * Do what the Connect button, the sign-in page, and the callback page do together. Like `start` in
 * Convex, ask once with no token first, because a server may name its PRM only in the 401 challenge.
 */
async function sign_in(extraScopes: readonly string[]) {
	const probed = await mcp_client_list_tools({
		server,
		accessToken: null,
		timeoutMs: CALL_TIMEOUT_MS,
		signal,
		testAllowLocalHttp: true,
	});
	const challenge = mcp_client_auth_challenge(probed._nay);
	if (signIn.pinnedIssuer === null) await pin_issuer(challenge?.resourceMetadataUrl ?? null);

	const state = crypto.randomUUID();
	const started = await mcp_oauth_start({
		serverUrl,
		challenge,
		pinnedIssuer: signIn.pinnedIssuer,
		pinnedResource: null,
		extraScopes,
		redirectUri: REDIRECT_URI,
		clientIdMetadataUrl: CLIENT_ID_METADATA_URL,
		knownClient: signIn.client,
		state,
		testAllowLocalHttp: true,
	});
	if (started._nay) throw new Error("Failed to start the sign-in", { cause: started._nay });
	signIn.client = started._yay.client;

	// The member signs in at the AS. The conformance AS answers at once with a redirect.
	const authorized = await fetch(started._yay.authorizationUrl, { redirect: "manual" });
	const location = authorized.headers.get("location");
	if (location === null) throw new Error("Failed to read the sign-in answer");
	const answer = new URL(location).searchParams;

	// The same checks as `finish`, in the same order: state, `iss`, the error, then the code.
	if (answer.get("state") !== state) throw new Error("Failed to match the sign-in state");
	if (
		!mcp_oauth_callback_iss_matches({
			iss: answer.get("iss"),
			issuer: started._yay.issuer,
			issParameterSupported: started._yay.issParameterSupported,
		})
	) {
		throw new Error("Failed to match the sign-in issuer");
	}
	const code = answer.get("code");
	if (answer.get("error") !== null || code === null) throw new Error("Failed to get a sign-in code");

	const exchanged = await mcp_oauth_exchange({
		tokenEndpoint: started._yay.endpoints.token,
		client: started._yay.client,
		code,
		codeVerifier: started._yay.codeVerifier,
		redirectUri: REDIRECT_URI,
		resource: started._yay.resource,
		testAllowLocalHttp: true,
	});
	if (exchanged._nay) throw new Error("Failed to exchange the sign-in code", { cause: exchanged._nay });
	signIn.accessToken = exchanged._yay.accessToken;
	signIn.scopes = started._yay.scopes;
}

async function list_tools() {
	const list = () =>
		mcp_client_list_tools({
			server,
			accessToken: signIn.accessToken,
			timeoutMs: CALL_TIMEOUT_MS,
			signal,
			testAllowLocalHttp: true,
		});
	let listed = await list();
	// A server that needs sign-in: connect once, then list again.
	if (listed._nay?.name === "auth_required") {
		await sign_in([]);
		listed = await list();
	}
	if (listed._nay) throw new Error("Failed to list tools", { cause: listed._nay });
	return listed._yay;
}

async function call_tool(listed: Awaited<ReturnType<typeof list_tools>>, name: string, args: Record<string, unknown>) {
	const tool = listed.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Failed to find tool ${name}`);

	const call = () =>
		mcp_client_call_tool({
			server,
			accessToken: signIn.accessToken,
			discover: listed.discover,
			tool,
			arguments: args,
			timeoutMs: CALL_TIMEOUT_MS,
			signal,
			testAllowLocalHttp: true,
		});
	let called = await call();
	// A 403 that asks for more scope: the member presses "Reconnect with more access" once, and
	// the call runs again. A second 403 ends the call.
	const stepUpScope = mcp_client_step_up_scope(called._nay);
	if (stepUpScope !== null) {
		await sign_in([...signIn.scopes, ...stepUpScope.split(" ")]);
		called = await call();
	}
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

/**
 * Every `auth/*` scenario: sign in, list the tools, and call the scenario's one tool.
 */
async function run_auth_scenario() {
	const listed = await list_tools();
	await call_tool(listed, "test-tool", {});
}

const run = scenario.startsWith("auth/") ? run_auth_scenario : scenarios[scenario];
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
