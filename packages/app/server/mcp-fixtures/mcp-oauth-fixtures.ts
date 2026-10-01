/**
 * A fake OAuth authorization server and two MCP servers that need its tokens, for the OAuth tests.
 * They run in memory, with no sockets. A test routes a stubbed `fetch` to `fixtures.fetch`.
 *
 * - AS: `https://as.oauth.test` (the issuer, unless a switch changes it).
 * - Server A: `https://mcp-a.oauth.test/mcp`. Server B: `https://mcp-b.oauth.test/mcp`.
 *
 * Each token is bound to the `resource` it was minted for, so server B refuses a token for server A.
 * Switches change one behavior at a time.
 */
import { mcp_fixtures_create_basic_handler } from "./mcp-fixtures.ts";

export type mcp_oauth_fixtures_WireEntry = {
	host: string;
	path: string;
	method: string;
	headers: Headers;
	body: string;
};

type ServerName = "mcp-a" | "mcp-b";

const AS_ORIGIN = "https://as.oauth.test";

function default_switches() {
	return {
		/**
		 * Where each MCP server serves its PRM: `path` (path-aware well-known), `root`, or `none`.
		 */
		prmLocation: "path" as "path" | "root" | "none",
		/**
		 * Put `resource_metadata` in the 401 challenge.
		 */
		challengeHasMetadataUrl: true,
		/**
		 * Override the challenge `resource_metadata` value.
		 */
		challengeMetadataUrl: null as string | null,
		challengeScope: null as string | null,
		/**
		 * Name `resource_metadata` twice in the challenge.
		 */
		challengeRepeatParam: false,
		/**
		 * Override PRM `resource`. `null` means the URL the PRM describes.
		 */
		prmResource: null as string | null,
		prmAuthorizationServers: null as string[] | null,
		prmScopes: ["mcp:read"] as string[] | null,
		/**
		 * The status the PRM URL answers with instead of the document, for example 500 or 302.
		 */
		prmStatus: null as number | null,
		prmRedirect: null as string | null,
		issuerPath: "",
		/**
		 * Where the AS serves metadata: `oauth` (RFC 8414) or `oidc-append` (`<issuer>/.well-known/openid-configuration`).
		 */
		asMetadataLocation: "oauth" as "oauth" | "oidc-append",
		/**
		 * The first AS metadata URL answers with this status before the right one.
		 */
		asFirstStatus: null as number | null,
		asIssuerOverride: null as string | null,
		codeChallengeMethods: ["S256"] as string[] | null,
		authorizationEndpoint: null as string | null,
		issSupported: true,
		cimd: false,
		tokenAuthMethods: ["none", "client_secret_basic", "client_secret_post"] as string[] | null,
		registration: "ok" as "ok" | "reject" | "none",
		/**
		 * Seconds until a registered client secret expires. `null` answers 0 (never expires).
		 */
		registrationSecretExpiresIn: null as number | null,
		asScopes: ["mcp:read", "mcp:write", "offline_access"] as string[] | null,
		revocation: true,
		/**
		 * The token endpoint answers 307 to another host.
		 */
		tokenRedirect: null as string | null,
		tokenIncludeRefresh: true,
		tokenExpiresIn: 3600 as number | null,
		/**
		 * The scope the AS grants. `null` grants what was asked.
		 */
		grantedScope: null as string | null,
		tokenType: "Bearer",
		/**
		 * Answer every refresh with `invalid_grant`.
		 */
		refreshInvalidGrant: false,
		/**
		 * Server answers 401 to every request, even with a good token.
		 */
		serverAlwaysUnauthorized: false,
		/**
		 * Server needs a token only for `tools/call`, so its tool list works without one.
		 */
		serverTokenOnlyForCall: false,
		/**
		 * Server answers 403 to `tools/call`. `insufficient_scope` names a scope; `plain` does not.
		 */
		serverForbidden: null as "insufficient_scope" | "plain" | null,
		/**
		 * Server answers 500 to every request that carries a good token.
		 */
		serverErrorWithToken: false,
		/**
		 * A token error body that repeats the token it got.
		 */
		echoSecretsInErrors: false,
	};
}

export type mcp_oauth_fixtures_Switches = ReturnType<typeof default_switches>;

async function s256(verifier: string) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return btoa(String.fromCharCode(...digest))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

/**
 * Create the fixtures. `switches` can be changed by a test at any time.
 */
export function mcp_oauth_fixtures_create() {
	const switches = default_switches();
	const wire: mcp_oauth_fixtures_WireEntry[] = [];
	const basic = mcp_fixtures_create_basic_handler();

	let counter = 0;
	const next = (prefix: string) => `${prefix}-${++counter}`;

	const codes = new Map<
		string,
		{ clientId: string; redirectUri: string; challenge: string; resource: string | null; scope: string }
	>();
	const accessTokens = new Map<string, { resource: string | null; scope: string; grant: string }>();
	const refreshTokens = new Map<string, { resource: string | null; scope: string; grant: string; used: boolean }>();
	const deadGrants = new Set<string>();
	const clients = new Map<string, { secret: string | null; authMethod: string; redirectUris: string[] }>();
	const revoked: string[] = [];
	const counts = { token: 0, refresh: 0, register: 0 };

	const issuer = () => `${AS_ORIGIN}${switches.issuerPath}`;
	const serverUrl = (name: ServerName) => `https://${name}.oauth.test/mcp`;

	const as_metadata = () => ({
		issuer: switches.asIssuerOverride ?? issuer(),
		authorization_endpoint: switches.authorizationEndpoint ?? `${AS_ORIGIN}/authorize`,
		token_endpoint: `${AS_ORIGIN}/token`,
		...(switches.registration !== "none" && { registration_endpoint: `${AS_ORIGIN}/register` }),
		...(switches.revocation && { revocation_endpoint: `${AS_ORIGIN}/revoke` }),
		response_types_supported: ["code"],
		...(switches.codeChallengeMethods && { code_challenge_methods_supported: switches.codeChallengeMethods }),
		...(switches.tokenAuthMethods && { token_endpoint_auth_methods_supported: switches.tokenAuthMethods }),
		...(switches.asScopes && { scopes_supported: switches.asScopes }),
		...(switches.cimd && { client_id_metadata_document_supported: true }),
		...(switches.issSupported && { authorization_response_iss_parameter_supported: true }),
	});

	const prm = (describes: string) => ({
		resource: switches.prmResource ?? describes,
		authorization_servers: switches.prmAuthorizationServers ?? [issuer()],
		...(switches.prmScopes && { scopes_supported: switches.prmScopes }),
	});

	/**
	 * Read client auth the way RFC 6749 §2.3.1 sends it: Basic, then the body.
	 */
	const client_from_request = (headers: Headers, params: URLSearchParams) => {
		const basic = headers.get("authorization");
		if (basic?.startsWith("Basic ")) {
			const [id = "", secret = ""] = atob(basic.slice(6)).split(":").map(decodeURIComponent);
			return { clientId: id, secret, method: "client_secret_basic" };
		}
		const secret = params.get("client_secret");
		return {
			clientId: params.get("client_id") ?? "",
			secret,
			method: secret === null ? "none" : "client_secret_post",
		};
	};

	const check_client = (auth: ReturnType<typeof client_from_request>) => {
		// A CIMD client id is a URL. The fixture trusts it without fetching the document.
		if (auth.clientId.startsWith("https://")) return auth.method === "none";
		const client = clients.get(auth.clientId);
		if (!client) return false;
		if (client.secret === null) return auth.method === "none";
		return auth.secret === client.secret && auth.method === client.authMethod;
	};

	const issue_tokens = (args: {
		resource: string | null;
		scope: string;
		grant: string;
	}) => {
		const { scope, grant, resource} = args;

		const accessToken = next("access");
		accessTokens.set(accessToken, { resource, scope, grant });
		const body: Record<string, unknown> = { access_token: accessToken, token_type: switches.tokenType };
		if (switches.tokenExpiresIn !== null) body.expires_in = switches.tokenExpiresIn;
		if (switches.tokenIncludeRefresh) {
			const refreshToken = next("refresh");
			refreshTokens.set(refreshToken, { resource, scope, grant, used: false });
			body.refresh_token = refreshToken;
		}
		body.scope = scope;
		return Response.json(body);
	};

	const token_error = (args: {
		error: string;
		status?: number;
		echo?: string;
	}) =>
		{
		const { status = 400, echo = "", error} = args;

		return Response.json(
			{ error, error_description: switches.echoSecretsInErrors ? `<b>bad</b> ${echo}` : "refused" },
			{ status },
		);
	};

	const handle_as = async (args: {
		request: Request;
		url: URL;
		body: string;
	}) => {
		const { request, url, body } = args;

		const path = url.pathname;
		const metadataPaths =
			switches.asMetadataLocation === "oauth"
				? [`/.well-known/oauth-authorization-server${switches.issuerPath}`]
				: [`${switches.issuerPath}/.well-known/openid-configuration`];
		if (request.method === "GET" && path.includes("/.well-known/")) {
			if (switches.asFirstStatus !== null && path === `/.well-known/oauth-authorization-server${switches.issuerPath}`) {
				return new Response("<html>nope</html>", { status: switches.asFirstStatus });
			}
			if (metadataPaths.includes(path)) return Response.json(as_metadata());
			return new Response("not found", { status: 404 });
		}

		if (request.method === "POST" && path === "/register") {
			counts.register++;
			if (switches.registration === "reject") {
				return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
			}
			const metadata = JSON.parse(body) as { token_endpoint_auth_method?: string; redirect_uris: string[] };
			const authMethod = metadata.token_endpoint_auth_method ?? "client_secret_basic";
			const clientId = next("client");
			const secret = authMethod === "none" ? null : next("secret");
			clients.set(clientId, { secret, authMethod, redirectUris: metadata.redirect_uris });
			return Response.json(
				{
					client_id: clientId,
					...(secret && {
						client_secret: secret,
						client_secret_expires_at:
							switches.registrationSecretExpiresIn === null
								? 0
								: Math.floor(Date.now() / 1000) + switches.registrationSecretExpiresIn,
					}),
					token_endpoint_auth_method: authMethod,
					redirect_uris: metadata.redirect_uris,
				},
				{ status: 201 },
			);
		}

		if (request.method === "POST" && path === "/token") {
			if (switches.tokenRedirect)
				return new Response(null, { status: 307, headers: { Location: switches.tokenRedirect } });
			counts.token++;
			const params = new URLSearchParams(body);
			const auth = client_from_request(request.headers, params);
			if (!check_client(auth)) return token_error({ error: "invalid_client", status: 401 });

			if (params.get("grant_type") === "authorization_code") {
				const code = params.get("code") ?? "";
				const recorded = codes.get(code);
				codes.delete(code);
				if (
					!recorded ||
					recorded.clientId !== auth.clientId ||
					recorded.redirectUri !== params.get("redirect_uri") ||
					recorded.resource !== params.get("resource") ||
					recorded.challenge !== (await s256(params.get("code_verifier") ?? ""))
				) {
					return token_error({ error: "invalid_grant", status: 400, echo: code });
				}
				return issue_tokens({
					resource: recorded.resource,
					scope: switches.grantedScope ?? recorded.scope,
					grant: next("grant"),
				});
			}

			if (params.get("grant_type") === "refresh_token") {
				counts.refresh++;
				const refreshToken = params.get("refresh_token") ?? "";
				const recorded = refreshTokens.get(refreshToken);
				if (switches.refreshInvalidGrant || !recorded || deadGrants.has(recorded.grant)) {
					return token_error({ error: "invalid_grant", status: 400, echo: refreshToken });
				}
				// Rotation: a reused refresh token kills the whole grant.
				if (recorded.used) {
					deadGrants.add(recorded.grant);
					return token_error({ error: "invalid_grant", status: 400, echo: refreshToken });
				}
				recorded.used = true;
				if (params.get("resource") !== recorded.resource) return token_error({ error: "invalid_target" });
				return issue_tokens({ resource: recorded.resource, scope: recorded.scope, grant: recorded.grant });
			}

			return token_error({ error: "unsupported_grant_type" });
		}

		if (request.method === "POST" && path === "/revoke") {
			const params = new URLSearchParams(body);
			revoked.push(params.get("token") ?? "");
			return new Response(null, { status: 200 });
		}

		return new Response("not found", { status: 404 });
	};

	const handle_server = async (args: {
		name: ServerName;
		request: Request;
		url: URL;
		body: string;
	}) => {
		const { name, request, url, body } = args;

		const origin = `https://${name}.oauth.test`;
		const pathAware = "/.well-known/oauth-protected-resource/mcp";
		const root = "/.well-known/oauth-protected-resource";
		if (request.method === "GET" && (url.pathname === pathAware || url.pathname === root)) {
			if (switches.prmRedirect) return new Response(null, { status: 302, headers: { Location: switches.prmRedirect } });
			if (switches.prmStatus !== null) return new Response("error", { status: switches.prmStatus });
			if (url.pathname === pathAware && switches.prmLocation === "path") {
				return Response.json(prm(serverUrl(name)));
			}
			if (url.pathname === root && switches.prmLocation === "root") return Response.json(prm(`${origin}/`));
			return new Response("not found", { status: 404 });
		}

		const authorization = request.headers.get("authorization") ?? "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		const recorded = accessTokens.get(token);
		// A token is good only for the resource it was minted for, and only while its grant lives.
		const good =
			recorded !== undefined &&
			!deadGrants.has(recorded.grant) &&
			(recorded.resource === serverUrl(name) || recorded.resource === `${origin}/` || recorded.resource === origin);
		const needsToken = !switches.serverTokenOnlyForCall || (request.method === "POST" && body.includes('"tools/call"'));
		if ((needsToken && !good) || switches.serverAlwaysUnauthorized) {
			const challengeUrl = switches.challengeMetadataUrl ?? `${origin}${pathAware}`;
			const parts: string[] = [];
			if (switches.challengeHasMetadataUrl) parts.push(`resource_metadata="${challengeUrl}"`);
			if (switches.challengeRepeatParam) parts.push(`resource_metadata="https://evil.oauth.test/prm"`);
			if (switches.challengeScope) parts.push(`scope="${switches.challengeScope}"`);
			return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer ${parts.join(", ")}`.trim() } });
		}

		if (switches.serverForbidden && request.method === "POST") {
			if (body.includes('"tools/call"')) {
				const header =
					switches.serverForbidden === "insufficient_scope"
						? 'Bearer error="insufficient_scope", scope="mcp:write"'
						: 'Bearer error="access_denied"';
				return new Response(null, { status: 403, headers: { "WWW-Authenticate": header } });
			}
		}
		if (switches.serverErrorWithToken && good) return new Response("error", { status: 500 });

		return await basic.fetch(request);
	};

	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body = request.method === "POST" ? await request.clone().text() : "";
		wire.push({ host: url.host, path: url.pathname, method: request.method, headers: request.headers, body });

		if (url.origin === AS_ORIGIN) return await handle_as({ request, url, body });
		if (url.host === "mcp-a.oauth.test") return await handle_server({ name: "mcp-a", request, url, body });
		if (url.host === "mcp-b.oauth.test") return await handle_server({ name: "mcp-b", request, url, body });
		throw new TypeError(`fixture: no route for ${url.host}`);
	};

	return {
		switches,
		wire,
		fetch,
		revoked,
		counts,
		issuer,
		serverUrl,
		/**
		 * Act as the member who signs in at the authorization URL. Return what the callback receives.
		 */
		authorize: async (authorizationUrl: string, options: { iss?: string | null } = {}) => {
			const url = new URL(authorizationUrl);
			const params = url.searchParams;
			if (params.get("code_challenge_method") !== "S256") throw new Error("fixture: PKCE S256 missing");
			const clientId = params.get("client_id") ?? "";
			const redirectUri = params.get("redirect_uri") ?? "";
			const client = clients.get(clientId);
			if (!clientId.startsWith("https://") && !client?.redirectUris.includes(redirectUri)) {
				throw new Error("fixture: unknown client or redirect URI");
			}

			const code = next("code");
			codes.set(code, {
				clientId,
				redirectUri,
				challenge: params.get("code_challenge") ?? "",
				resource: params.get("resource"),
				scope: switches.grantedScope ?? params.get("scope") ?? "",
			});
			return {
				code,
				state: params.get("state") ?? "",
				iss: options.iss === undefined ? (switches.issSupported ? issuer() : null) : options.iss,
				scope: params.get("scope"),
				resource: params.get("resource"),
			};
		},
		close: async () => {
			await basic.close();
		},
	};
}
