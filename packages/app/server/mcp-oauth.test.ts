import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { mcp_client_list_tools } from "./mcp-client.ts";
import { mcp_oauth_fixtures_create } from "./mcp-fixtures/mcp-oauth-fixtures.ts";
import {
	mcp_oauth_check_client_document,
	mcp_oauth_discover,
	mcp_oauth_exchange,
	mcp_oauth_refresh,
	mcp_oauth_revoke,
	mcp_oauth_start,
	type mcp_oauth_Client,
} from "./mcp-oauth.ts";

const REDIRECT_URI = "https://app.press.test/oauth/mcp/callback";
const CLIENT_DOCUMENT_URL = "https://app.press.test/oauth/mcp/client.json";

let fixtures: ReturnType<typeof mcp_oauth_fixtures_create>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	fixtures = mcp_oauth_fixtures_create();
	vi.spyOn(globalThis, "fetch").mockImplementation(fixtures.fetch);
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(async () => {
	await fixtures.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const SERVER_A = "https://mcp-a.oauth.test/mcp";
const PATH_AWARE_A = "https://mcp-a.oauth.test/.well-known/oauth-protected-resource/mcp";

function discover(
	options: {
		serverUrl?: string;
		challenge?: { resourceMetadataUrl: string | null; scope: string | null } | null;
		pinnedIssuer?: string | null;
		pinnedResource?: string | null;
	} = {},
) {
	return mcp_oauth_discover({
		serverUrl: options.serverUrl ?? SERVER_A,
		challenge: options.challenge === undefined ? { resourceMetadataUrl: PATH_AWARE_A, scope: null } : options.challenge,
		pinnedIssuer: options.pinnedIssuer === undefined ? fixtures.issuer() : options.pinnedIssuer,
		pinnedResource: options.pinnedResource ?? null,
	});
}

function start(
	options: {
		serverUrl?: string;
		challenge?: { resourceMetadataUrl: string | null; scope: string | null } | null;
		extraScopes?: string[];
		knownClient?: mcp_oauth_Client | null;
	} = {},
) {
	return mcp_oauth_start({
		serverUrl: options.serverUrl ?? SERVER_A,
		challenge: options.challenge === undefined ? { resourceMetadataUrl: PATH_AWARE_A, scope: null } : options.challenge,
		pinnedIssuer: fixtures.issuer(),
		pinnedResource: null,
		extraScopes: options.extraScopes ?? [],
		redirectUri: REDIRECT_URI,
		clientIdMetadataUrl: CLIENT_DOCUMENT_URL,
		knownClient: options.knownClient ?? null,
		state: "state-1",
	});
}

/**
 * Run start, the member's sign-in, and the code exchange. Return the tokens and what start chose.
 */
async function connect(options: Parameters<typeof start>[0] = {}) {
	const started = await start(options);
	if (started._nay) throw new Error("Failed to start", { cause: started._nay });

	const callback = await fixtures.authorize(started._yay.authorizationUrl);
	const exchanged = await mcp_oauth_exchange({
		tokenEndpoint: started._yay.endpoints.token,
		client: started._yay.client,
		code: callback.code,
		codeVerifier: started._yay.codeVerifier,
		redirectUri: REDIRECT_URI,
		resource: started._yay.resource,
	});
	if (exchanged._nay) throw new Error("Failed to exchange", { cause: exchanged._nay });
	return { started: started._yay, tokens: exchanged._yay, callback };
}

function requested_hosts() {
	return fixtures.wire.map((entry) => entry.host);
}

describe("mcp_oauth_discover", () => {
	test("follows the challenge URL and accepts the server URL as the resource", async () => {
		const result = await discover();

		expect(result._yay).toMatchObject({
			resource: SERVER_A,
			issuer: fixtures.issuer(),
			issParameterSupported: true,
			authorizationHost: "as.oauth.test",
			endpoints: {
				authorization: "https://as.oauth.test/authorize",
				token: "https://as.oauth.test/token",
				revocation: "https://as.oauth.test/revoke",
				registration: "https://as.oauth.test/register",
			},
		});
	});

	test("refuses a challenge that names a parameter twice, but not a name inside a quoted value", async () => {
		const probe = () =>
			mcp_client_list_tools({
				server: { url: SERVER_A, headers: [] },
				accessToken: null,
				timeoutMs: 5000,
				signal: new AbortController().signal,
			});
		fixtures.switches.challengeMetadataUrl = `${PATH_AWARE_A}?resource_metadata=1`;
		expect((await probe())._nay?.name).toBe("auth_required");

		fixtures.switches.challengeRepeatParam = true;
		expect((await probe())._nay?.name).toBe("bad_response");
	});

	test("tries the path-aware URL when the challenge names none", async () => {
		const result = await discover({ challenge: null });

		expect(result._yay?.resource).toBe(SERVER_A);
		expect(fixtures.wire[0]?.path).toBe("/.well-known/oauth-protected-resource/mcp");
	});

	test("falls back to the root PRM on a 404 and accepts the origin there", async () => {
		fixtures.switches.prmLocation = "root";

		const result = await discover();

		expect(result._yay?.resource).toBe("https://mcp-a.oauth.test/");
	});

	test("refuses a resource of another host, scheme, port, sibling path, or string prefix", async () => {
		for (const resource of [
			"https://mcp-b.oauth.test/mcp",
			"http://mcp-a.oauth.test/mcp",
			"https://mcp-a.oauth.test:8443/mcp",
			"https://mcp-a.oauth.test/alpha",
			"https://mcp-a.oauth.test/mc",
			"https://mcp-a.oauth.test/mcp/",
		]) {
			fixtures.switches.prmResource = resource;
			const result = await discover();
			expect(result._nay?.name, resource).toBe("oauth_resource_mismatch");
		}
	});

	test("accepts a parent resource only when the manifest pins it", async () => {
		fixtures.switches.prmResource = "https://mcp-a.oauth.test/";

		expect((await discover())._nay?.name).toBe("oauth_resource_mismatch");
		expect((await discover({ pinnedResource: "https://mcp-a.oauth.test/other" }))._nay?.name).toBe(
			"oauth_resource_mismatch",
		);
		expect((await discover({ pinnedResource: "https://mcp-a.oauth.test/" }))._yay?.resource).toBe(
			"https://mcp-a.oauth.test/",
		);
	});

	test("keeps the resource string exactly as PRM wrote it", async () => {
		fixtures.switches.prmLocation = "root";
		fixtures.switches.prmResource = "https://mcp-a.oauth.test";

		const result = await discover();

		expect(result._yay?.resource).toBe("https://mcp-a.oauth.test");
	});

	test("refuses a server with no PRM, or a PRM with no issuer", async () => {
		fixtures.switches.prmLocation = "none";
		expect((await discover())._nay?.name).toBe("oauth_no_metadata");

		fixtures.switches.prmLocation = "path";
		fixtures.switches.prmAuthorizationServers = [];
		expect((await discover())._nay?.name).toBe("oauth_no_metadata");
	});

	test("stops at a PRM error instead of trying the next URL", async () => {
		fixtures.switches.prmStatus = 500;

		const result = await discover();

		expect(result._nay?.name).toBe("server_error");
		expect(fixtures.wire.filter((entry) => entry.path.includes("oauth-protected-resource"))).toHaveLength(1);
	});

	test("finds AS metadata at the OIDC path-append URL after a 403", async () => {
		fixtures.switches.issuerPath = "/tenant";
		fixtures.switches.asMetadataLocation = "oidc-append";
		fixtures.switches.asFirstStatus = 403;

		const result = await discover();

		expect(result._yay?.issuer).toBe("https://as.oauth.test/tenant");
		expect(fixtures.wire.map((entry) => entry.path).filter((path) => path.includes("tenant"))).toEqual([
			"/.well-known/oauth-authorization-server/tenant",
			"/.well-known/openid-configuration/tenant",
			"/tenant/.well-known/openid-configuration",
		]);
	});

	test("stops at an AS metadata 500", async () => {
		fixtures.switches.issuerPath = "/tenant";
		fixtures.switches.asMetadataLocation = "oidc-append";
		fixtures.switches.asFirstStatus = 500;

		expect((await discover())._nay?.name).toBe("server_error");
	});

	test("refuses AS metadata whose issuer differs, even by a final slash", async () => {
		fixtures.switches.asIssuerOverride = `${fixtures.issuer()}/`;

		expect((await discover())._nay?.name).toBe("oauth_metadata_invalid");
	});

	test("refuses an AS without S256, even when it lists no methods", async () => {
		fixtures.switches.codeChallengeMethods = null;
		expect((await discover())._nay?.name).toBe("oauth_metadata_invalid");

		fixtures.switches.codeChallengeMethods = ["plain"];
		expect((await discover())._nay?.name).toBe("oauth_metadata_invalid");
	});

	test("refuses an endpoint that is not https", async () => {
		for (const endpoint of ["javascript:alert(1)", "data:text/html,x", "http://evil.example/authorize"]) {
			fixtures.switches.authorizationEndpoint = endpoint;
			expect((await discover())._nay?.name, endpoint).toBe("oauth_metadata_invalid");
		}
	});

	test("refuses a challenge URL on an IP or a local name before any request", async () => {
		for (const url of [
			"https://169.254.169.254/latest",
			"http://localhost:6379/",
			"https://[::ffff:127.0.0.1]/",
			"https://2130706433/",
			"https://0177.0.0.1/",
		]) {
			fixtures.wire.length = 0;
			const result = await discover({ challenge: { resourceMetadataUrl: url, scope: null } });
			expect(result._nay?.name, url).toBe("url_blocked");
			expect(fixtures.wire, url).toEqual([]);
		}
	});

	test("refuses a PRM redirect to a local address", async () => {
		fixtures.switches.prmRedirect = "http://127.0.0.1/";

		expect((await discover())._nay?.name).toBe("url_blocked");
	});

	test("refuses a metadata document over 64 KiB", async () => {
		fixtures.switches.prmResource = `${SERVER_A}${"x".repeat(70 * 1024)}`;

		expect((await discover())._nay?.name).toBe("too_large");
	});

	test("refuses when PRM does not list the pinned issuer, and never contacts the other AS", async () => {
		fixtures.switches.prmAuthorizationServers = ["https://evil.oauth.test"];

		const result = await discover();

		expect(result._nay?.name).toBe("oauth_issuer_changed");
		expect(requested_hosts()).not.toContain("evil.oauth.test");
	});

	test("without a pin, takes the one listed issuer and refuses several", async () => {
		expect((await discover({ pinnedIssuer: null }))._yay?.issuer).toBe(fixtures.issuer());

		fixtures.switches.prmAuthorizationServers = [fixtures.issuer(), "https://other.oauth.test"];
		const result = await discover({ pinnedIssuer: null });
		expect(result._nay).toMatchObject({
			name: "oauth_many_issuers",
			data: { hosts: ["as.oauth.test", "other.oauth.test"] },
		});
	});

	test("refuses an AS without iss unless it is trusted", async () => {
		fixtures.switches.issSupported = false;
		expect((await discover())._nay?.name).toBe("oauth_issuer_untrusted");

		vi.stubEnv("MCP_TRUSTED_ISSUERS", `https://other.example, ${fixtures.issuer()}`);
		expect((await discover())._yay?.issParameterSupported).toBe(false);
	});
});

describe("mcp_oauth_start", () => {
	test("uses the CIMD URL as client id when the AS accepts a public client", async () => {
		fixtures.switches.cimd = true;

		const result = await start();

		expect(result._yay?.client).toEqual({
			kind: "cimd",
			clientId: CLIENT_DOCUMENT_URL,
			clientSecret: null,
			clientSecretExpiresAt: null,
			authMethod: "none",
		});
		expect(fixtures.counts.register).toBe(0);
		const url = new URL(result._yay!.authorizationUrl);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			response_type: "code",
			client_id: CLIENT_DOCUMENT_URL,
			redirect_uri: REDIRECT_URI,
			code_challenge_method: "S256",
			state: "state-1",
			resource: SERVER_A,
		});
	});

	test("registers with DCR when CIMD is offered without a public client", async () => {
		fixtures.switches.cimd = true;
		fixtures.switches.tokenAuthMethods = ["client_secret_basic"];

		const result = await start();

		expect(result._yay?.client).toMatchObject({ kind: "dcr", authMethod: "client_secret_basic" });
		expect(result._yay?.client.clientSecret).toEqual(expect.any(String));
		expect(fixtures.counts.register).toBe(1);
	});

	test("reuses a known client instead of registering again", async () => {
		const first = await start();
		const second = await start({ knownClient: first._yay!.client });

		expect(second._yay?.client).toEqual(first._yay?.client);
		expect(fixtures.counts.register).toBe(1);
	});

	test("refuses when the AS offers no way to become a client", async () => {
		fixtures.switches.registration = "none";

		expect((await start())._nay?.name).toBe("oauth_no_client");
	});

	test("reports a refused registration once", async () => {
		fixtures.switches.registration = "reject";

		expect((await start())._nay?.name).toBe("oauth_registration_failed");
		expect(fixtures.counts.register).toBe(1);
	});

	test("asks for the challenge scope, else the PRM scopes, plus extra scopes and offline_access", async () => {
		const fromChallenge = await start({
			challenge: { resourceMetadataUrl: PATH_AWARE_A, scope: "mcp:write" },
			extraScopes: ["extra"],
		});
		expect(fromChallenge._yay?.scopes).toEqual(["mcp:write", "extra", "offline_access"]);

		fixtures.switches.asScopes = ["mcp:read"];
		const fromPrm = await start();
		expect(fromPrm._yay?.scopes).toEqual(["mcp:read"]);
	});

	test("sends a resource with a query encoded once", async () => {
		const serverUrl = "https://mcp-a.oauth.test/mcp?tenant=a";
		fixtures.switches.prmResource = serverUrl;

		const result = await start({
			serverUrl,
			challenge: { resourceMetadataUrl: `${PATH_AWARE_A}?tenant=a`, scope: null },
		});

		expect(new URL(result._yay!.authorizationUrl).searchParams.get("resource")).toBe(serverUrl);
		expect(result._yay!.authorizationUrl).toMatch(/resource=https%3A%2F%2Fmcp-a.oauth.test%2Fmcp%3Ftenant%3Da(?:&|$)/u);
	});

	test("sends the PRM resource without adding a slash", async () => {
		fixtures.switches.prmLocation = "root";
		fixtures.switches.prmResource = "https://mcp-a.oauth.test";

		const { started, callback } = await connect();

		expect(callback.resource).toBe("https://mcp-a.oauth.test");
		const tokenRequest = fixtures.wire.find((entry) => entry.path === "/token");
		expect(new URLSearchParams(tokenRequest?.body).get("resource")).toBe("https://mcp-a.oauth.test");
		expect(started.resource).toBe("https://mcp-a.oauth.test");
	});
});

describe("mcp_oauth_exchange", () => {
	test("gets tokens that the server accepts, sent only in the Authorization header", async () => {
		const unauthorized = await mcp_client_list_tools({
			server: { url: SERVER_A, headers: [] },
			accessToken: null,
			timeoutMs: 5000,
			signal: new AbortController().signal,
		});
		expect(unauthorized._nay).toMatchObject({ name: "auth_required", data: { resourceMetadataUrl: PATH_AWARE_A } });

		const { tokens } = await connect();
		expect(tokens).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
		expect(tokens.expiresAt).toBeGreaterThan(Date.now());

		fixtures.wire.length = 0;
		const listed = await mcp_client_list_tools({
			server: { url: SERVER_A, headers: [] },
			accessToken: tokens.accessToken,
			timeoutMs: 5000,
			signal: new AbortController().signal,
		});
		expect(listed._yay?.tools.map((tool) => tool.name)).toEqual(["echo", "picture"]);
		for (const entry of fixtures.wire) {
			expect(entry.headers.get("authorization")).toBe(`Bearer ${tokens.accessToken}`);
			expect(entry.path).not.toContain(tokens.accessToken);
		}
	});

	test("authenticates with the DCR secret by the method the AS answered", async () => {
		fixtures.switches.tokenAuthMethods = ["client_secret_post"];
		const post = await connect();
		expect(post.started.client.authMethod).toBe("client_secret_post");
		const postBody = new URLSearchParams(fixtures.wire.findLast((entry) => entry.path === "/token")?.body);
		expect(postBody.get("client_secret")).toBe(post.started.client.clientSecret);

		fixtures.switches.tokenAuthMethods = ["client_secret_basic"];
		const basic = await connect();
		expect(basic.started.client.authMethod).toBe("client_secret_basic");
		const basicRequest = fixtures.wire.findLast((entry) => entry.path === "/token");
		expect(basicRequest?.headers.get("authorization")).toMatch(/^Basic /u);
		expect(new URLSearchParams(basicRequest?.body).has("client_secret")).toBe(false);
	});

	test("stores a token with no refresh token and no expiry", async () => {
		fixtures.switches.tokenIncludeRefresh = false;
		fixtures.switches.tokenExpiresIn = null;

		const { tokens } = await connect();

		expect(tokens).toMatchObject({ refreshToken: null, expiresAt: null });
	});

	test("keeps the narrower scope the AS granted", async () => {
		fixtures.switches.grantedScope = "mcp:read";

		const { tokens } = await connect({ extraScopes: ["mcp:write"] });

		expect(tokens.scope).toBe("mcp:read");
	});

	test("refuses a token that is not a Bearer token", async () => {
		fixtures.switches.tokenType = "MAC";

		await expect(connect()).rejects.toMatchObject({ cause: { name: "oauth_token_invalid" } });
	});

	test("never follows a token endpoint redirect", async () => {
		const started = await start();
		const callback = await fixtures.authorize(started._yay!.authorizationUrl);
		fixtures.switches.tokenRedirect = "https://other.oauth.test/token";

		const result = await mcp_oauth_exchange({
			tokenEndpoint: started._yay!.endpoints.token,
			client: started._yay!.client,
			code: callback.code,
			codeVerifier: started._yay!.codeVerifier,
			redirectUri: REDIRECT_URI,
			resource: started._yay!.resource,
		});

		expect(result._nay?.name).toBe("bad_response");
		expect(requested_hosts()).not.toContain("other.oauth.test");
	});

	test("refuses a wrong verifier and keeps the code and the error text out of the result and logs", async () => {
		fixtures.switches.echoSecretsInErrors = true;
		const started = await start();
		const callback = await fixtures.authorize(started._yay!.authorizationUrl);

		const result = await mcp_oauth_exchange({
			tokenEndpoint: started._yay!.endpoints.token,
			client: started._yay!.client,
			code: callback.code,
			codeVerifier: "wrong-verifier-wrong-verifier-wrong-verifier-123",
			redirectUri: REDIRECT_URI,
			resource: started._yay!.resource,
		});

		expect(result._nay?.name).toBe("oauth_invalid_grant");
		const everything = JSON.stringify([result, warn.mock.calls]);
		expect(everything).not.toContain(callback.code);
		expect(everything).not.toContain(started._yay!.codeVerifier);
		expect(everything).not.toContain("<b>");
	});
});

describe("mcp_oauth_refresh", () => {
	test("sends the stored resource and scope, and keeps the old refresh token when none comes back", async () => {
		const { started, tokens } = await connect();
		fixtures.switches.tokenIncludeRefresh = false;

		const result = await mcp_oauth_refresh({
			tokenEndpoint: started.endpoints.token,
			client: started.client,
			refreshToken: tokens.refreshToken!,
			resource: started.resource,
			scope: tokens.scope,
		});

		expect(result._yay?.accessToken).not.toBe(tokens.accessToken);
		expect(result._yay?.refreshToken).toBe(tokens.refreshToken);
		const body = new URLSearchParams(fixtures.wire.findLast((entry) => entry.path === "/token")?.body);
		expect(Object.fromEntries(body)).toMatchObject({
			grant_type: "refresh_token",
			resource: SERVER_A,
			scope: tokens.scope,
		});
	});

	test("reports invalid_grant, also for a reused rotated refresh token", async () => {
		const { started, tokens } = await connect();
		const refresh = () =>
			mcp_oauth_refresh({
				tokenEndpoint: started.endpoints.token,
				client: started.client,
				refreshToken: tokens.refreshToken!,
				resource: started.resource,
				scope: tokens.scope,
			});

		expect((await refresh())._yay).toBeTruthy();
		expect((await refresh())._nay?.name).toBe("oauth_invalid_grant");

		fixtures.switches.refreshInvalidGrant = true;
		expect((await refresh())._nay?.name).toBe("oauth_invalid_grant");
	});
});

describe("mcp_oauth_revoke", () => {
	test("posts the token with its hint and the client auth", async () => {
		const { started, tokens } = await connect();

		const result = await mcp_oauth_revoke({
			revocationEndpoint: started.endpoints.revocation!,
			client: started.client,
			token: tokens.refreshToken!,
			tokenTypeHint: "refresh_token",
		});

		expect(result._yay).toEqual({});
		expect(fixtures.revoked).toEqual([tokens.refreshToken]);
		const body = new URLSearchParams(fixtures.wire.at(-1)?.body);
		expect(body.get("token_type_hint")).toBe("refresh_token");
	});
});

describe("mcp_oauth_check_client_document", () => {
	const document = { client_id: CLIENT_DOCUMENT_URL, redirect_uris: [REDIRECT_URI] };

	function serve(body: unknown) {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url === CLIENT_DOCUMENT_URL) return Response.json(body);
			throw new TypeError("no route");
		});
	}

	test("reads the document on the app host, which the guard refuses for anything else", async () => {
		vi.stubEnv("APP_BASE_URL", "https://app.press.test");
		serve(document);

		const result = await mcp_oauth_check_client_document({
			clientIdMetadataUrl: CLIENT_DOCUMENT_URL,
			redirectUri: REDIRECT_URI,
		});

		expect(result._yay).toEqual({});
		const blocked = await mcp_oauth_discover({
			serverUrl: "https://app.press.test/mcp",
			challenge: null,
			pinnedIssuer: null,
			pinnedResource: null,
		});
		expect(blocked._nay?.name).toBe("url_blocked");
	});

	test("refuses a document with another client id or callback", async () => {
		serve({ ...document, redirect_uris: ["https://elsewhere.test/callback"] });

		const result = await mcp_oauth_check_client_document({
			clientIdMetadataUrl: CLIENT_DOCUMENT_URL,
			redirectUri: REDIRECT_URI,
		});

		expect(result._nay?.name).toBe("oauth_client_document_mismatch");
	});
});
