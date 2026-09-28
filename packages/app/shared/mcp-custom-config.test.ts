import { describe, expect, test } from "vitest";
import {
	mcp_custom_config_build,
	mcp_custom_config_parse,
	mcp_custom_config_to_text,
	type mcp_custom_config_Fill,
	type mcp_custom_config_Server,
} from "./mcp-custom-config.ts";

const KEY_IN_QUERY_MESSAGE =
	"MCP server URL must not carry a key in its query. Send the key in the Authorization header instead";

/**
 * Parse text that must give exactly one draft and no errors.
 */
function parse_one(text: string) {
	const result = mcp_custom_config_parse(text);
	expect(result.errors).toEqual([]);
	expect(result.drafts).toHaveLength(1);
	return result.drafts[0];
}

/**
 * One remote entry under `mcpServers`, with the given headers.
 */
function remote_text(name: string, url: string, headers: Record<string, string> = {}) {
	return JSON.stringify({ mcpServers: { [name]: { url, headers } } });
}

function make_fill(overrides: Partial<mcp_custom_config_Fill>): mcp_custom_config_Fill {
	return { name: "server", urlFields: [], notSecretHeaders: [], secretValues: [], keptSecretNames: [], ...overrides };
}

describe("mcp_custom_config_parse", () => {
	test("reads a Claude Code http entry with a Bearer ${API_KEY} header", () => {
		const draft = parse_one(
			JSON.stringify({
				mcpServers: {
					sentry: {
						type: "http",
						url: "https://mcp.sentry.dev/mcp",
						headers: { Authorization: "Bearer ${API_KEY}" },
					},
				},
			}),
		);

		expect(draft).toEqual({
			key: "sentry",
			name: "sentry",
			state: "needs_values",
			refusal: null,
			convertedFromMcpRemote: false,
			ignoredKeys: [],
			urlParts: [{ kind: "text", text: "https://mcp.sentry.dev/mcp" }],
			headers: [
				{
					name: "Authorization",
					parts: [
						{ kind: "text", text: "Bearer " },
						{ kind: "secret", secretName: "API_KEY", prefill: null, hint: null, canBeText: false, stored: false },
					],
				},
			],
		});
	});

	test("reads a Cursor ${env:X} header", () => {
		const draft = parse_one(
			remote_text("my-service", "https://api.example.com/mcp", { Authorization: "Bearer ${env:MY_SERVICE_TOKEN}" }),
		);

		expect(draft.headers[0].parts).toEqual([
			{ kind: "text", text: "Bearer " },
			{ kind: "secret", secretName: "MY_SERVICE_TOKEN", prefill: null, hint: null, canBeText: false, stored: false },
		]);
	});

	test("reads a Windsurf serverUrl entry", () => {
		const draft = parse_one(JSON.stringify({ mcpServers: { figma: { serverUrl: "https://mcp.figma.com/mcp" } } }));

		expect(draft.state).toBe("ready");
		expect(draft.urlParts).toEqual([{ kind: "text", text: "https://mcp.figma.com/mcp" }]);
	});

	test("reads VS Code servers with an ${input:id} and uses the input description as hint", () => {
		const draft = parse_one(
			JSON.stringify({
				servers: {
					github: {
						type: "http",
						url: "https://api.githubcopilot.com/mcp/",
						headers: { Authorization: "Bearer ${input:github_mcp_pat}" },
					},
				},
				inputs: [
					{ type: "promptString", id: "github_mcp_pat", description: "GitHub Personal Access Token", password: true },
				],
			}),
		);

		expect(draft.headers).toEqual([
			{
				name: "Authorization",
				parts: [
					{ kind: "text", text: "Bearer " },
					{
						kind: "secret",
						secretName: "GITHUB_MCP_PAT",
						prefill: null,
						hint: "GitHub Personal Access Token",
						canBeText: false,
						stored: false,
					},
				],
			},
		]);
	});

	test("accepts Cline streamableHttp and refuses sse and ws", () => {
		const draftFor = (type: string) =>
			parse_one(JSON.stringify({ mcpServers: { remote: { type, url: "https://mcp.example.com/mcp" } } }));

		expect(draftFor("streamableHttp").state).toBe("ready");
		expect(draftFor("sse").refusal).toContain("old SSE transport");
		expect(draftFor("ws").refusal).toContain("WebSocket");
	});

	test("refuses a Claude Desktop stdio entry and shows the command", () => {
		const draft = parse_one(
			JSON.stringify({
				mcpServers: {
					github: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-github"],
						env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<YOUR_TOKEN>" },
					},
				},
			}),
		);

		expect(draft.state).toBe("refused");
		expect(draft.refusal).toContain("npx -y @modelcontextprotocol/server-github");
		expect(draft.refusal).toContain("Press can only use remote servers");
	});

	test("turns mcp-remote in args into a remote draft with its --header", () => {
		const draft = parse_one(
			JSON.stringify({
				mcpServers: {
					"remote-example": {
						command: "npx",
						args: ["mcp-remote", "https://remote.mcp.server/mcp", "--header", "Authorization: Bearer ${AUTH_TOKEN}"],
						env: { AUTH_TOKEN: "..." },
					},
				},
			}),
		);

		expect(draft.convertedFromMcpRemote).toBe(true);
		expect(draft.ignoredKeys).toEqual([]);
		expect(draft.urlParts).toEqual([{ kind: "text", text: "https://remote.mcp.server/mcp" }]);
		expect(draft.headers[0].parts).toEqual([
			{ kind: "text", text: "Bearer " },
			{ kind: "secret", secretName: "AUTH_TOKEN", prefill: null, hint: null, canBeText: false, stored: false },
		]);
	});

	test("turns mcp-remote in one command string into a remote draft", () => {
		const draft = parse_one(
			JSON.stringify({ mcpServers: { browserbase: { command: "npx -y mcp-remote https://mcp.browserbase.com/mcp" } } }),
		);

		expect(draft.state).toBe("ready");
		expect(draft.convertedFromMcpRemote).toBe(true);
		expect(draft.urlParts).toEqual([{ kind: "text", text: "https://mcp.browserbase.com/mcp" }]);
	});

	test("refuses mcp-remote with --transport sse-only or --allow-http", () => {
		const draftFor = (args: string[]) =>
			parse_one(JSON.stringify({ mcpServers: { remote: { command: "npx", args: ["mcp-remote", ...args] } } }));

		expect(draftFor(["https://remote.mcp.server/sse", "--transport", "sse-only"]).refusal).toContain("sse-only");
		expect(draftFor(["http://127.0.0.1:8080/mcp", "--allow-http"]).refusal).toContain("--allow-http");
	});

	test("refuses a key in the URL query with the header hint", () => {
		const tavily = parse_one(
			JSON.stringify({
				mcpServers: {
					"tavily-remote-mcp": { command: "npx -y mcp-remote https://mcp.tavily.com/mcp/?tavilyApiKey=<your-api-key>" },
				},
			}),
		);
		const exa = parse_one(remote_text("exa", "https://mcp.exa.ai/mcp?exaApiKey=abc"));

		expect(tavily.refusal).toBe(KEY_IN_QUERY_MESSAGE);
		expect(exa.refusal).toBe(KEY_IN_QUERY_MESSAGE);
	});

	test("refuses a key placeholder in the URL path", () => {
		const draft = parse_one(remote_text("remote", "https://mcp.example.com/mcp/<YOUR_TOKEN>"));

		expect(draft.refusal).toBe("This server puts a key in its address. Press can only keep keys in headers.");
	});

	test("turns a URL placeholder that is not a key into a text field", () => {
		const draft = parse_one(
			remote_text("supabase", "https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true"),
		);

		expect(draft.state).toBe("needs_values");
		expect(draft.urlParts).toEqual([
			{ kind: "text", text: "https://mcp.supabase.com/mcp?project_ref=" },
			{ kind: "field", fieldName: "PROJECT_REF", hint: null },
			{ kind: "text", text: "&read_only=true" },
		]);
	});

	test("makes one secret of each placeholder word", () => {
		const secretOf = (value: string) =>
			parse_one(remote_text("remote", "https://mcp.example.com/mcp", { "X-Api-Key": value }));

		expect(secretOf("Bearer <YOUR_HF_TOKEN>").headers[0].parts).toEqual([
			{ kind: "text", text: "Bearer " },
			{ kind: "secret", secretName: "YOUR_HF_TOKEN", prefill: null, hint: null, canBeText: false, stored: false },
		]);
		expect(secretOf("fc-YOUR_API_KEY").headers[0].parts).toEqual([
			{ kind: "secret", secretName: "YOUR_API_KEY", prefill: null, hint: null, canBeText: false, stored: false },
		]);
		expect(secretOf("your_key_here").headers[0].parts).toEqual([
			{ kind: "secret", secretName: "YOUR_KEY_HERE", prefill: null, hint: null, canBeText: false, stored: false },
		]);
		// `...` has no usable name, so the name comes from the entry and the header.
		expect(secretOf("...").headers[0].parts).toEqual([
			{ kind: "secret", secretName: "REMOTE_X_API_KEY", prefill: null, hint: null, canBeText: false, stored: false },
		]);
	});

	test("Authorization: Bearer abc123 gives text Bearer and a prefilled secret", () => {
		const draft = parse_one(remote_text("linear", "https://mcp.linear.app/mcp", { Authorization: "Bearer abc123" }));

		expect(draft.state).toBe("ready");
		expect(draft.headers[0].parts).toEqual([
			{ kind: "text", text: "Bearer " },
			{
				kind: "secret",
				secretName: "LINEAR_AUTHORIZATION",
				prefill: "abc123",
				hint: null,
				canBeText: true,
				stored: false,
			},
		]);
	});

	test("makes a literal header value a prefilled secret", () => {
		const draft = parse_one(remote_text("remote", "https://mcp.example.com/mcp", { "X-Region": "us-east-1" }));

		expect(draft.headers[0].parts).toEqual([
			{
				kind: "secret",
				secretName: "REMOTE_X_REGION",
				prefill: "us-east-1",
				hint: null,
				canBeText: true,
				stored: false,
			},
		]);
	});

	test("lists ignored keys", () => {
		const draft = parse_one(
			JSON.stringify({
				mcpServers: {
					remote: { url: "https://mcp.example.com/mcp", disabled: false, autoApprove: [], timeout: 60 },
				},
			}),
		);

		expect(draft.ignoredKeys).toEqual(["disabled", "autoApprove", "timeout"]);
	});

	test("parses JSONC comments and trailing commas", () => {
		const draft = parse_one(`{
	// My servers
	"mcpServers": {
		"remote": { "url": "https://mcp.example.com/mcp", }, /* last one */
	},
}`);

		expect(draft.state).toBe("ready");
	});

	test("reports broken JSON at the right offset", () => {
		const text = '{"mcpServers": {"remote": {"url": "https://mcp.example.com/mcp" "headers": {}}}}';

		const result = mcp_custom_config_parse(text);

		expect(result.drafts).toEqual([]);
		expect(result.errors[0]).toEqual({ offset: text.indexOf('"headers"'), length: 9, message: "Comma expected" });
	});

	test("refuses URLs that fail the URL rules", () => {
		const refusalOf = (url: string) => parse_one(remote_text("remote", url)).refusal;

		expect(refusalOf("http://mcp.example.com/mcp")).toBe("MCP server URL must use https");
		expect(refusalOf("https://mcp.example.com:8443/mcp")).toBe("MCP server URL must use the https port 443");
		expect(refusalOf("https://10.0.0.1/mcp")).toBe("MCP server URL must use a host name, not an IP address");
		expect(refusalOf("https://localhost/mcp")).toBe("MCP server URL must not point to localhost");
		expect(refusalOf("https://user:pass@mcp.example.com/mcp")).toBe("MCP server URL must not include credentials");
		expect(refusalOf("https://mcp.example.com/mcp#top")).toBe("MCP server URL must not include a fragment");
	});

	test("refuses ${file:}, command plus url, and a static OAuth client", () => {
		const refusalOf = (entry: Record<string, unknown>) =>
			parse_one(JSON.stringify({ mcpServers: { remote: entry } })).refusal;

		expect(
			refusalOf({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${file:/token.txt}" } }),
		).toContain("cannot read files");
		expect(refusalOf({ command: "npx", url: "https://mcp.example.com/mcp" })).toContain("both a command and a URL");
		expect(
			refusalOf({
				url: "https://api.example.com/mcp",
				auth: { CLIENT_ID: "your-oauth-client-id", CLIENT_SECRET: "your-client-secret", scopes: ["read"] },
			}),
		).toContain("its own OAuth client");
	});

	test("refuses reserved, duplicate, and too many headers", () => {
		const refusalOf = (headers: Record<string, string>) =>
			parse_one(remote_text("remote", "https://mcp.example.com/mcp", headers)).refusal;

		expect(refusalOf({ "Mcp-Session-Id": "abc" })).toContain("Press sets the Mcp-Session-Id header itself");
		expect(refusalOf({ "X-Key": "a", "x-key": "b" })).toContain("appears twice");
		expect(refusalOf({ "X-Key": "a", X_Key: "b" })).toBe(
			"Two headers use the secret name REMOTE_X_KEY. Rename one of them.",
		);
		expect(refusalOf({ "X-A": "Bearer <token>", "X-B": "<token>" })).toBeNull();
		expect(refusalOf(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-H${index}`, "v"])))).toContain(
			"at most 8 headers",
		);
	});

	test("refuses 11 servers and a paste over 64 KiB", () => {
		const servers = Object.fromEntries(
			Array.from({ length: 11 }, (_, index) => [`s${index}`, { url: "https://mcp.example.com/mcp" }]),
		);
		const eleven = mcp_custom_config_parse(JSON.stringify({ mcpServers: servers }));
		const base = remote_text("remote", "https://mcp.example.com/mcp");
		const tooBig = mcp_custom_config_parse(base + " ".repeat(64 * 1024 + 1 - base.length));

		expect(eleven).toEqual({
			drafts: [],
			errors: [{ offset: 0, length: 0, message: "Paste at most 10 servers at a time." }],
		});
		expect(tooBig).toEqual({
			drafts: [],
			errors: [{ offset: 0, length: 0, message: "The text must be at most 64 KiB." }],
		});
	});
});

describe("mcp_custom_config_build", () => {
	test("stores a literal Authorization value as text Bearer plus a secret", () => {
		const draft = parse_one(remote_text("linear", "https://mcp.linear.app/mcp", { Authorization: "Bearer abc123" }));

		const result = mcp_custom_config_build(draft, make_fill({ name: " Linear " }));

		expect(result._yay).toEqual({
			server: {
				name: "Linear",
				url: "https://mcp.linear.app/mcp",
				headers: [
					{
						name: "Authorization",
						parts: [
							{ kind: "text", text: "Bearer " },
							{ kind: "secret", secretName: "LINEAR_AUTHORIZATION" },
						],
					},
				],
			},
			secretValues: [{ name: "LINEAR_AUTHORIZATION", value: "abc123" }],
		});
	});

	test("keeps X-Region secret by default and makes it text when marked not secret", () => {
		const draft = parse_one(remote_text("remote", "https://mcp.example.com/mcp", { "X-Region": "us-east-1" }));

		const asSecret = mcp_custom_config_build(draft, make_fill({}));
		const asText = mcp_custom_config_build(draft, make_fill({ notSecretHeaders: ["X-Region"] }));

		expect(asSecret._yay?.server.headers).toEqual([
			{ name: "X-Region", parts: [{ kind: "secret", secretName: "REMOTE_X_REGION" }] },
		]);
		expect(asSecret._yay?.secretValues).toEqual([{ name: "REMOTE_X_REGION", value: "us-east-1" }]);
		expect(asText._yay?.server.headers).toEqual([{ name: "X-Region", parts: [{ kind: "text", text: "us-east-1" }] }]);
		expect(asText._yay?.secretValues).toEqual([]);
	});

	test("needs a value for each placeholder secret unless it is kept", () => {
		const draft = parse_one(remote_text("remote", "https://mcp.example.com/mcp", { Authorization: "Bearer <token>" }));

		expect(mcp_custom_config_build(draft, make_fill({}))._nay?.message).toBe("Fill in TOKEN.");
		expect(
			mcp_custom_config_build(draft, make_fill({ secretValues: [{ name: "TOKEN", value: "t1" }] }))._yay?.secretValues,
		).toEqual([{ name: "TOKEN", value: "t1" }]);
		expect(mcp_custom_config_build(draft, make_fill({ keptSecretNames: ["TOKEN"] }))._yay?.secretValues).toEqual([]);
	});

	test("refuses a value with a line break or a character beyond Latin-1", () => {
		const draft = parse_one(remote_text("remote", "https://mcp.example.com/mcp", { Authorization: "Bearer <token>" }));
		const messageFor = (value: string) =>
			mcp_custom_config_build(draft, make_fill({ secretValues: [{ name: "TOKEN", value }] }))._nay?.message;
		const refusal =
			"The Authorization value must be at most 4 KiB, with no line breaks and no characters beyond Latin-1.";

		expect(messageFor("t1\r\nX-Evil: 1")).toBe(refusal);
		expect(messageFor("t1\u{1F600}")).toBe(refusal);
		expect(messageFor("t1\ud800")).toBe(refusal);
		expect(messageFor("t1\tcafé")).toBeUndefined();
	});

	test("fills URL fields and keeps repeated query names", () => {
		const draft = parse_one(
			remote_text("supabase", "https://mcp.supabase.com/mcp?project_ref=<project-ref>&category=a&category=b"),
		);

		expect(mcp_custom_config_build(draft, make_fill({}))._nay?.message).toBe("Fill in PROJECT_REF.");
		expect(
			mcp_custom_config_build(draft, make_fill({ urlFields: [{ name: "PROJECT_REF", value: "abc" }] }))._yay?.server
				.url,
		).toBe("https://mcp.supabase.com/mcp?project_ref=abc&category=a&category=b");
	});

	test("refuses a refused draft and a bad name", () => {
		const refused = parse_one(remote_text("remote", "http://mcp.example.com/mcp"));
		const ready = parse_one(remote_text("remote", "https://mcp.example.com/mcp"));

		expect(mcp_custom_config_build(refused, make_fill({}))._nay?.message).toBe("MCP server URL must use https");
		expect(mcp_custom_config_build(ready, make_fill({ name: "  " }))._nay?.message).toBe(
			"Names must be 1 to 64 characters.",
		);
	});
});

describe("mcp_custom_config_to_text", () => {
	const server: mcp_custom_config_Server = {
		name: "linear",
		url: "https://mcp.linear.app/mcp",
		headers: [
			{
				name: "Authorization",
				parts: [
					{ kind: "text", text: "Bearer " },
					{ kind: "secret", secretName: "LINEAR_AUTHORIZATION" },
				],
			},
			{ name: "X-Region", parts: [{ kind: "text", text: "us-east-1" }] },
		],
	};

	test("writes canonical JSON with ${secret:NAME} refs", () => {
		expect(mcp_custom_config_to_text(server)).toBe(
			[
				"{",
				'\t"mcpServers": {',
				'\t\t"linear": {',
				'\t\t\t"type": "http",',
				'\t\t\t"url": "https://mcp.linear.app/mcp",',
				'\t\t\t"headers": {',
				'\t\t\t\t"Authorization": "Bearer ${secret:LINEAR_AUTHORIZATION}",',
				'\t\t\t\t"X-Region": "us-east-1"',
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		);
		expect(mcp_custom_config_to_text({ ...server, headers: [] })).not.toContain("headers");
	});

	test("round trips build to text to parse to the same server with no values", () => {
		const draft = parse_one(mcp_custom_config_to_text(server));

		const result = mcp_custom_config_build(
			draft,
			make_fill({ name: draft.name, notSecretHeaders: ["X-Region"], keptSecretNames: ["LINEAR_AUTHORIZATION"] }),
		);

		expect(draft.headers[0].parts[1]).toEqual({
			kind: "secret",
			secretName: "LINEAR_AUTHORIZATION",
			prefill: null,
			hint: null,
			canBeText: false,
			stored: true,
		});
		expect(draft.state).toBe("ready");
		expect(result._yay).toEqual({ server, secretValues: [] });
	});
});
