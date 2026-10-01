/**
 * A public OAuth fixture for live QA of MCP sign-in. One sign-in server at `/oauth-as`, and two MCP
 * servers that need its tokens:
 *
 * - `/oauth-call-only/mcp` lists its tools without a token. It needs a token only for `tools/call`.
 * - `/oauth-list/mcp` needs a token for every request.
 *
 * A Worker keeps no memory between requests. So codes and tokens are signed JSON with an expiry,
 * not ids in a store. Revoke answers 200 but cannot end a token early. A token only opens the
 * fixture's `echo` and `picture` tools, so this is fine for a test server.
 */

type OauthFixture_Env = {
	/**
	 * The HMAC key that signs codes and tokens. Set it with `wrangler secret put`.
	 */
	OAUTH_SIGNING_KEY: string;
};

type OauthFixture_Handler = {
	fetch: (request: Request) => Promise<Response>;
};

const SERVER_NAMES = ["oauth-call-only", "oauth-list"];
const ISSUER_PATH = "/oauth-as";
const SCOPE = "mcp:tools";
const CODE_SECONDS = 5 * 60;
const ACCESS_TOKEN_SECONDS = 10 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function base64url_decode(text: string) {
	const padded = text.replaceAll("-", "+").replaceAll("_", "/");
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function s256(verifier: string) {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function hmac(env: OauthFixture_Env, text: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(env.OAUTH_SIGNING_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

/**
 * Sign a payload of one kind (`kind` stops a refresh token from working as a code or an access token).
 */
async function sign(args: { env: OauthFixture_Env; kind: string; seconds: number; payload: Record<string, string> }) {
	const { env, kind, seconds, payload } = args;

	const body = base64url(
		new TextEncoder().encode(JSON.stringify({ ...payload, kind, exp: Math.floor(Date.now() / 1000) + seconds })),
	);
	return `${body}.${await hmac(env, body)}`;
}

async function verify(args: { env: OauthFixture_Env; kind: string; token: string }) {
	const { env, kind, token } = args;

	const [body = "", signature = ""] = token.split(".");
	if (!body || signature !== (await hmac(env, body))) {
		return null;
	}

	const payload: unknown = JSON.parse(new TextDecoder().decode(base64url_decode(body)));
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("kind" in payload) ||
		payload.kind !== kind ||
		!("exp" in payload) ||
		typeof payload.exp !== "number" ||
		payload.exp < Date.now() / 1000
	) {
		return null;
	}
	return payload as Record<string, unknown>;
}

function escape_html(text: string) {
	return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function token_error(error: string) {
	return Response.json({ error }, { status: 400 });
}

async function issue_tokens(env: OauthFixture_Env, grant: { clientId: string; resource: string; scope: string }) {
	return Response.json(
		{
			access_token: await sign({ env, kind: "access", seconds: ACCESS_TOKEN_SECONDS, payload: grant }),
			token_type: "Bearer",
			expires_in: ACCESS_TOKEN_SECONDS,
			refresh_token: await sign({ env, kind: "refresh", seconds: REFRESH_TOKEN_SECONDS, payload: grant }),
			scope: grant.scope,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}

/**
 * Show the approve page. The client id is a client metadata document URL (CIMD). Fetch it and
 * check that it lists the redirect URI, so the page never sends a code to an address the client did
 * not name.
 */
async function handle_authorize_page(args: { env: OauthFixture_Env; url: URL; origin: string }) {
	const { env, url, origin } = args;

	const params = url.searchParams;
	const clientId = params.get("client_id") ?? "";
	const redirectUri = params.get("redirect_uri") ?? "";
	const resource = params.get("resource") ?? "";
	const challenge = params.get("code_challenge") ?? "";
	if (
		params.get("response_type") !== "code" ||
		params.get("code_challenge_method") !== "S256" ||
		!challenge ||
		!clientId.startsWith("https://") ||
		!SERVER_NAMES.some((name) => resource === `${origin}/${name}/mcp`)
	) {
		return new Response("Bad sign-in request", { status: 400 });
	}

	const clientDocument: unknown = await fetch(clientId).then(
		(response) => (response.ok ? response.json() : null),
		() => null,
	);
	const redirectUris =
		typeof clientDocument === "object" && clientDocument !== null && "redirect_uris" in clientDocument
			? clientDocument.redirect_uris
			: null;
	if (!Array.isArray(redirectUris) || !redirectUris.includes(redirectUri)) {
		return new Response("The client document does not list this redirect URI", { status: 400 });
	}

	// Sign the checked request, so the approve form cannot be changed to send the code elsewhere.
	const signedRequest = await sign({
		env,
		kind: "request",
		seconds: CODE_SECONDS,
		payload: {
			clientId,
			redirectUri,
			resource,
			challenge,
			scope: params.get("scope") ?? SCOPE,
			state: params.get("state") ?? "",
		},
	});
	const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP fixture sign-in</title></head>
<body style="font-family: system-ui; max-width: 480px; margin: 48px auto; padding: 0 16px">
<h1>MCP fixture sign-in</h1>
<p>This is a test sign-in server. It has no accounts. Approve to give <strong>${escape_html(clientId)}</strong> access to <strong>${escape_html(resource)}</strong>.</p>
<form method="post" action="${ISSUER_PATH}/authorize">
<input type="hidden" name="request" value="${escape_html(signedRequest)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body>
</html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:",
		},
	});
}

async function handle_authorize_decision(args: { env: OauthFixture_Env; request: Request; origin: string }) {
	const { env, request, origin } = args;

	const form = await request.formData();
	const signed = await verify({ env, kind: "request", token: String(form.get("request") ?? "") });
	if (!signed) {
		return new Response("This sign-in expired. Start again.", { status: 400 });
	}

	const redirect = new URL(String(signed.redirectUri));
	redirect.searchParams.set("state", String(signed.state));
	redirect.searchParams.set("iss", `${origin}${ISSUER_PATH}`);
	if (form.get("decision") === "approve") {
		redirect.searchParams.set(
			"code",
			await sign({
				env,
				kind: "code",
				seconds: CODE_SECONDS,
				payload: {
					clientId: String(signed.clientId),
					redirectUri: String(signed.redirectUri),
					resource: String(signed.resource),
					challenge: String(signed.challenge),
					scope: String(signed.scope),
				},
			}),
		);
	} else {
		redirect.searchParams.set("error", "access_denied");
	}
	return Response.redirect(redirect.toString(), 302);
}

async function handle_token(env: OauthFixture_Env, request: Request) {
	const params = new URLSearchParams(await request.text());
	const clientId = params.get("client_id") ?? "";
	const resource = params.get("resource");

	if (params.get("grant_type") === "authorization_code") {
		const code = await verify({ env, kind: "code", token: params.get("code") ?? "" });
		if (
			!code ||
			code.clientId !== clientId ||
			code.redirectUri !== params.get("redirect_uri") ||
			(resource !== null && code.resource !== resource) ||
			code.challenge !== (await s256(params.get("code_verifier") ?? ""))
		) {
			return token_error("invalid_grant");
		}
		return await issue_tokens(env, { clientId, resource: String(code.resource), scope: String(code.scope) });
	}

	if (params.get("grant_type") === "refresh_token") {
		const refresh = await verify({ env, kind: "refresh", token: params.get("refresh_token") ?? "" });
		if (!refresh || refresh.clientId !== clientId || (resource !== null && refresh.resource !== resource)) {
			return token_error("invalid_grant");
		}
		return await issue_tokens(env, { clientId, resource: String(refresh.resource), scope: String(refresh.scope) });
	}

	return token_error("unsupported_grant_type");
}

async function handle_server(args: {
	env: OauthFixture_Env;
	basic: OauthFixture_Handler;
	request: Request;
	name: string;
}) {
	const { env, basic, request, name } = args;

	const origin = new URL(request.url).origin;
	const serverUrl = `${origin}/${name}/mcp`;
	const body = request.method === "POST" ? await request.clone().text() : "";
	const needsToken = name === "oauth-list" || body.includes('"tools/call"');

	const authorization = request.headers.get("authorization") ?? "";
	const access = authorization.startsWith("Bearer ")
		? await verify({ env, kind: "access", token: authorization.slice(7) })
		: null;
	if (needsToken && access?.resource !== serverUrl) {
		const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/${name}/mcp", scope="${SCOPE}"`;
		return new Response(null, { status: 401, headers: { "WWW-Authenticate": challenge } });
	}

	return await basic.fetch(request);
}

/**
 * Answer a request for the OAuth fixture, or `null` when the path is not one of its paths.
 */
export async function oauth_fixture_fetch(args: {
	env: OauthFixture_Env;
	basic: OauthFixture_Handler;
	request: Request;
}) {
	const { env, basic, request } = args;

	const url = new URL(request.url);
	const origin = url.origin;
	const path = url.pathname;

	for (const name of SERVER_NAMES) {
		if (request.method === "GET" && path === `/.well-known/oauth-protected-resource/${name}/mcp`) {
			return Response.json({
				resource: `${origin}/${name}/mcp`,
				authorization_servers: [`${origin}${ISSUER_PATH}`],
				scopes_supported: [SCOPE],
			});
		}
		if (path === `/${name}/mcp`) {
			return await handle_server({ env, basic, request, name });
		}
	}

	if (request.method === "GET" && path === `/.well-known/oauth-authorization-server${ISSUER_PATH}`) {
		return Response.json({
			issuer: `${origin}${ISSUER_PATH}`,
			authorization_endpoint: `${origin}${ISSUER_PATH}/authorize`,
			token_endpoint: `${origin}${ISSUER_PATH}/token`,
			revocation_endpoint: `${origin}${ISSUER_PATH}/revoke`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: [SCOPE],
			client_id_metadata_document_supported: true,
			authorization_response_iss_parameter_supported: true,
		});
	}
	if (request.method === "GET" && path === `${ISSUER_PATH}/authorize`) {
		return await handle_authorize_page({ env, url, origin });
	}
	if (request.method === "POST" && path === `${ISSUER_PATH}/authorize`) {
		return await handle_authorize_decision({ env, request, origin });
	}
	if (request.method === "POST" && path === `${ISSUER_PATH}/token`) {
		return await handle_token(env, request);
	}
	if (request.method === "POST" && path === `${ISSUER_PATH}/revoke`) {
		return new Response(null, { status: 200 });
	}
	return null;
}
