/**
 * OAuth for MCP servers: discovery, the authorization URL, the code exchange, refresh, and revoke.
 * Convex actions in `convex/plugins_mcp_oauth.ts` call these functions. Nothing here stores anything.
 *
 * Every request goes through the guarded fetch. Errors come back as a `Result` with a fixed code and
 * a fixed message. Text from the MCP server or the authorization server never goes into `_nay` and
 * never into a log, because an error body can echo back a token or a code.
 */
import {
	LATEST_PROTOCOL_VERSION,
	buildDiscoveryUrls,
	registerClient,
	startAuthorization,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import {
	mcp_guarded_fetch_create,
	mcp_guarded_fetch_is_allowed_url,
	type mcp_GuardedFetchFailure,
} from "./mcp-guarded-fetch.ts";

/**
 * A registered client secret must stay valid at least this long, or Press refuses the client.
 */
const CLIENT_SECRET_MIN_LIFETIME_MS = 60 * 60 * 1000;

const ERROR_MESSAGES = {
	url_blocked: "Press does not allow requests to this sign-in address.",
	timeout: "The sign-in server timed out.",
	too_large: "The sign-in server sent more data than Press accepts.",
	bad_response: "The sign-in server sent a response Press cannot read.",
	network_error: "Press could not reach the sign-in server.",
	server_error: "The sign-in server had an error.",
	oauth_no_metadata: "This server does not say where to sign in, so Press cannot connect to it.",
	oauth_resource_mismatch: "This server's sign-in settings do not match its address.",
	oauth_issuer_changed: "This server no longer uses the sign-in server Press expects.",
	oauth_many_issuers: "This server names more than one sign-in server. Press cannot choose one.",
	oauth_issuer_untrusted:
		"This sign-in server does not confirm which server answered the sign-in, so Press cannot use it safely.",
	oauth_metadata_invalid: "The sign-in server's settings are not valid for Press.",
	// Plugin servers and members' own servers share these. Neither a publisher nor a member can fix
	// them yet, because Press has no pre-registered OAuth apps.
	oauth_no_client: "This server's sign-in server does not support Press yet.",
	oauth_registration_failed: "This server's sign-in server refused to register Press.",
	oauth_client_document_mismatch: "Press's sign-in settings are out of date. Ask an administrator to redeploy the app.",
	oauth_token_invalid: "The sign-in server sent a token Press cannot use.",
	oauth_invalid_grant: "The sign-in expired or was revoked. Connect again.",
	oauth_token_refused: "The sign-in server refused the request.",
} as const;

type ErrorCode = keyof typeof ERROR_MESSAGES;

type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export type mcp_oauth_Client = {
	/**
	 * `cimd`: Press's client metadata document URL is the client id. `dcr`: a client this issuer
	 * registered for Press.
	 */
	kind: "cimd" | "dcr";
	clientId: string;
	clientSecret: string | null;
	/**
	 * When a DCR secret stops working, in ms. `null` means it never expires.
	 */
	clientSecretExpiresAt: number | null;
	authMethod: ClientAuthMethod;
};

type Endpoints = {
	authorization: string;
	token: string;
	revocation: string | null;
	registration: string | null;
};

type Tokens = {
	accessToken: string;
	refreshToken: string | null;
	/**
	 * When the access token expires, in ms. `null` when the server did not say, so Press refreshes
	 * only on a 401.
	 */
	expiresAt: number | null;
	scope: string | null;
};

type Challenge = { resourceMetadataUrl: string | null; scope: string | null } | null;

type TestOptions = {
	/**
	 * Test only: allow `http://localhost` and `http://127.0.0.1`, also for AS endpoints. Only the
	 * conformance adapter and local tests pass it. Convex functions never do.
	 */
	testAllowLocalHttp?: true;
};

const prm_schema = z.object({
	resource: z.string(),
	authorization_servers: z.array(z.string()).optional(),
	scopes_supported: z.array(z.string()).optional(),
});

// Press reads AS metadata with its own schema. The SDK's OIDC schema drops fields it does not name,
// such as `revocation_endpoint`, so an OIDC server would never get a revoke.
const as_metadata_schema = z.object({
	issuer: z.string(),
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	registration_endpoint: z.string().optional(),
	revocation_endpoint: z.string().optional(),
	scopes_supported: z.array(z.string()).optional(),
	response_types_supported: z.array(z.string()),
	code_challenge_methods_supported: z.array(z.string()).optional(),
	token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
	client_id_metadata_document_supported: z.boolean().optional(),
	authorization_response_iss_parameter_supported: z.boolean().optional(),
});

const token_response_schema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
	expires_in: z.number().optional(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
});

const client_metadata_document_schema = z.object({
	client_id: z.string(),
	redirect_uris: z.array(z.string()),
});

function oauth_nay(name: ErrorCode, data: { hosts: string[] } | { oauthError: string | null } | null = null) {
	return Result({ _nay: { name, message: ERROR_MESSAGES[name], data } });
}

async function log_failure(args: {
	operation: string;
	url: string;
	code: string;
	error: unknown;
}) {
	const { url, error, code, operation} = args;

	console.warn("MCP OAuth request failed", {
		operation,
		code,
		// Only the error class. Never the message: SDK errors carry the whole response body.
		errorClass: error instanceof Error ? error.constructor.name : typeof error,
		urlHash: (await crypto_sha256_hex(url)).slice(0, 16),
	});
}

/**
 * Compare two resource URLs: scheme and host without case, no fragment, and the
 * empty path equal to `/`. The URL parser does all three. Every other part stays exact, so a
 * trailing `/` on a non-root path still matters.
 */
export function mcp_oauth_same_resource(a: string, b: string) {
	if (!URL.canParse(a) || !URL.canParse(b)) return false;
	const left = new URL(a);
	const right = new URL(b);
	left.hash = "";
	right.hash = "";
	return left.href === right.href;
}

function is_allowed_endpoint(value: string, options: TestOptions) {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	// The member's browser opens the authorization endpoint, and the guard never sees it. So check it
	// with the guard's host rules here: no IP address, no local name, no Press host.
	if (url.protocol === "https:") return mcp_guarded_fetch_is_allowed_url(value);
	return (
		options.testAllowLocalHttp === true &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1")
	);
}

/**
 * Exact issuer URLs an administrator trusts even without `iss` in the callback.
 * Read at call time, so an env change applies at once.
 */
function trusted_issuers() {
	return (process.env.MCP_TRUSTED_ISSUERS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * GET one metadata document. `missing` means discovery may move on to the next URL: only a 404 for
 * PRM, and a 4xx or a 502 for AS metadata. Any other failure stops it.
 */
async function get_metadata(args: {
	url: string;
	options: TestOptions;
	moveOn: (status: number) => boolean;
}) {
	const { url, options, moveOn } = args;

	const guard = mcp_guarded_fetch_create({ kind: "oauth", ...options });
	let response: Response;
	try {
		response = await guard.fetch(url, {
			headers: { Accept: "application/json", "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION },
		});
	} catch (error) {
		return { kind: "failed" as const, code: guard.failure ?? ("network_error" as const), error };
	}

	if (!response.ok) {
		await response.body?.cancel();
		if (moveOn(response.status)) return { kind: "missing" as const };
		const code = response.status >= 500 ? ("server_error" as const) : ("bad_response" as const);
		return { kind: "failed" as const, code, error: null };
	}

	const json: unknown = await response.json().catch(() => null);
	return { kind: "found" as const, json };
}

/**
 * Find the protected resource metadata (PRM), check its `resource`, choose the issuer, and check the
 * issuer's metadata. It registers nothing and builds no authorization URL. The `Step` comments below
 * follow the discovery order. Step 1, reading the 401 challenge, runs in the caller.
 *
 * `pinnedIssuer: null` is only for a member's own server that has no sign-in server yet.
 * Then PRM must list exactly one issuer, and that issuer becomes the pin.
 */
export async function mcp_oauth_discover(
	args: {
		serverUrl: string;
		challenge: Challenge;
		pinnedIssuer: string | null;
		/**
		 * A reviewed parent `resource` from the plugin manifest. `null` means the exact rule only.
		 */
		pinnedResource: string | null;
	} & TestOptions,
) {
	const testOptions: TestOptions = { testAllowLocalHttp: args.testAllowLocalHttp };
	const server = new URL(args.serverUrl);
	const origin = `${server.origin}/`;

	// Step 2: the challenge URL first, then the path-aware and the root well-known URLs. A PRM found
	// at the challenge URL or the path-aware URL describes the server URL. The root one describes the
	// origin (RFC 9728 §3.3).
	const candidates: Array<{ url: string; expectedResource: string }> = [];
	if (args.challenge?.resourceMetadataUrl) {
		candidates.push({ url: args.challenge.resourceMetadataUrl, expectedResource: args.serverUrl });
	}
	const path = server.pathname.replace(/\/$/u, "");
	if (path) {
		const pathAware = new URL(`/.well-known/oauth-protected-resource${path}`, server.origin);
		pathAware.search = server.search;
		candidates.push({ url: pathAware.href, expectedResource: args.serverUrl });
	}
	candidates.push({ url: `${server.origin}/.well-known/oauth-protected-resource`, expectedResource: origin });

	let prm: (z.infer<typeof prm_schema> & { expectedResource: string }) | null = null;
	for (const candidate of candidates) {
		const found = await get_metadata({ url: candidate.url, options: testOptions, moveOn: (status) => status === 404 });
		if (found.kind === "missing") continue;
		if (found.kind === "failed") {
			await log_failure({ operation: "discover_prm", url: candidate.url, code: found.code, error: found.error });
			return oauth_nay(found.code);
		}

		const parsed = prm_schema.safeParse(found.json);
		if (!parsed.success) return oauth_nay("bad_response");
		prm = { ...parsed.data, expectedResource: candidate.expectedResource };
		break;
	}

	// Step 3: no PRM, or no issuer in it. Never fall back to the server origin as the issuer.
	if (!prm || !prm.authorization_servers?.length) return oauth_nay("oauth_no_metadata");

	// Step 4: the resource must be the one the answering URL describes, or the reviewed pin. It must
	// always be on the server's origin.
	if (!URL.canParse(prm.resource) || new URL(prm.resource).origin !== server.origin) {
		return oauth_nay("oauth_resource_mismatch");
	}
	const resourceAccepted =
		mcp_oauth_same_resource(prm.resource, prm.expectedResource) ||
		(args.pinnedResource !== null && mcp_oauth_same_resource(prm.resource, args.pinnedResource));
	if (!resourceAccepted) return oauth_nay("oauth_resource_mismatch");

	// Step 5: the pinned issuer must be listed exactly. A server with no pin must list one issuer.
	let issuer: string;
	if (args.pinnedIssuer !== null) {
		if (!prm.authorization_servers.includes(args.pinnedIssuer)) return oauth_nay("oauth_issuer_changed");
		issuer = args.pinnedIssuer;
	} else {
		if (prm.authorization_servers.length > 1) {
			const hosts = prm.authorization_servers.map((entry) => (URL.canParse(entry) ? new URL(entry).host : entry));
			return oauth_nay("oauth_many_issuers", { hosts });
		}
		issuer = prm.authorization_servers[0]!;
	}
	if (!is_allowed_endpoint(issuer, testOptions)) return oauth_nay("oauth_metadata_invalid");

	// Step 6: the RFC 8414 and OIDC URLs in the spec order. Move on only on a 4xx or a 502, like the SDK.
	let metadata: z.infer<typeof as_metadata_schema> | null = null;
	for (const { url } of buildDiscoveryUrls(issuer)) {
		const found = await get_metadata({ url: url.href, options: testOptions, moveOn: (status) => status === 502 || status < 500 });
		if (found.kind === "missing") continue;
		if (found.kind === "failed") {
			await log_failure({ operation: "discover_as", url: url.href, code: found.code, error: found.error });
			return oauth_nay(found.code);
		}

		const parsed = as_metadata_schema.safeParse(found.json);
		if (!parsed.success) return oauth_nay("bad_response");
		metadata = parsed.data;
		break;
	}
	if (!metadata) return oauth_nay("oauth_no_metadata");

	// Step 7: the exact string. The SDK would also accept an issuer that differs by a final `/`.
	if (metadata.issuer !== issuer) return oauth_nay("oauth_metadata_invalid");

	// Step 8: PKCE with S256 is required even when the AS says nothing. The SDK would go on without it.
	if (
		!metadata.code_challenge_methods_supported?.includes("S256") ||
		!metadata.response_types_supported.includes("code")
	) {
		return oauth_nay("oauth_metadata_invalid");
	}
	const endpoints: Endpoints = {
		authorization: metadata.authorization_endpoint,
		token: metadata.token_endpoint,
		revocation: metadata.revocation_endpoint ?? null,
		registration: metadata.registration_endpoint ?? null,
	};
	for (const endpoint of Object.values(endpoints)) {
		if (endpoint !== null && !is_allowed_endpoint(endpoint, testOptions)) return oauth_nay("oauth_metadata_invalid");
	}

	// Step 5a: all servers share one client id and one callback. Without `iss` in the callback, a bad
	// AS could bounce the member to an honest AS and receive the honest code. So use an AS only when it
	// promises `iss`, or when an administrator listed it.
	const issParameterSupported = metadata.authorization_response_iss_parameter_supported === true;
	if (!issParameterSupported && !trusted_issuers().includes(issuer)) return oauth_nay("oauth_issuer_untrusted");

	return Result({
		_yay: {
			/**
			 * The accepted PRM `resource`, verbatim. It is sent on authorize, token, and refresh.
			 */
			resource: prm.resource,
			issuer,
			endpoints,
			issParameterSupported,
			authorizationHost: new URL(endpoints.authorization).host,
			prmScopes: prm.scopes_supported ?? [],
			metadata,
		},
	});
}

/**
 * Run discovery, choose the client, and build the authorization URL with PKCE.
 */
export async function mcp_oauth_start(
	args: {
		serverUrl: string;
		challenge: Challenge;
		pinnedIssuer: string | null;
		pinnedResource: string | null;
		/**
		 * Scopes to add: the manifest scopes, or the earlier scopes plus the step-up scope on a reconnect.
		 */
		extraScopes: readonly string[];
		redirectUri: string;
		clientIdMetadataUrl: string;
		/**
		 * A client this issuer registered for Press before, or `null`.
		 */
		knownClient: mcp_oauth_Client | null;
		state: string;
	} & TestOptions,
) {
	const testOptions: TestOptions = { testAllowLocalHttp: args.testAllowLocalHttp };
	const discovered = await mcp_oauth_discover({
		serverUrl: args.serverUrl,
		challenge: args.challenge,
		pinnedIssuer: args.pinnedIssuer,
		pinnedResource: args.pinnedResource,
		...testOptions,
	});
	if (discovered._nay) return discovered;
	const { metadata, issuer, resource } = discovered._yay;

	// Step 9: the challenge scope, else every scope PRM lists, else none. Then the extra scopes, and
	// `offline_access` only when the AS lists it.
	const scopes = new Set(args.challenge?.scope ? args.challenge.scope.split(" ") : discovered._yay.prmScopes);
	for (const scope of args.extraScopes) scopes.add(scope);
	if (metadata.scopes_supported?.includes("offline_access")) scopes.add("offline_access");
	scopes.delete("");
	const scope = [...scopes].join(" ");

	// Use CIMD first, but only for an AS that accepts a public client. A missing list means
	// `client_secret_basic` (RFC 8414), so no CIMD then.
	const authMethods = metadata.token_endpoint_auth_methods_supported;
	let client: mcp_oauth_Client;
	const knownClientUsable =
		args.knownClient !== null &&
		(args.knownClient.clientSecretExpiresAt === null || args.knownClient.clientSecretExpiresAt > Date.now());
	if (metadata.client_id_metadata_document_supported === true && authMethods?.includes("none")) {
		client = {
			kind: "cimd",
			clientId: args.clientIdMetadataUrl,
			clientSecret: null,
			clientSecretExpiresAt: null,
			authMethod: "none",
		};
	} else if (knownClientUsable) {
		client = args.knownClient!;
	} else if (metadata.registration_endpoint) {
		const requestedMethod: ClientAuthMethod = authMethods?.includes("none")
			? "none"
			: !authMethods || authMethods.includes("client_secret_basic")
				? "client_secret_basic"
				: "client_secret_post";
		const guard = mcp_guarded_fetch_create({ kind: "oauth", ...testOptions });
		try {
			const registered = await registerClient(issuer, {
				metadata,
				clientMetadata: {
					client_name: "Press",
					application_type: "web",
					redirect_uris: [args.redirectUri],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: requestedMethod,
				},
				fetchFn: guard.fetch,
			});
			// Use the method the AS answered with. A secret with no method means `client_secret_basic`.
			const answeredMethod = registered.token_endpoint_auth_method;
			const authMethod: ClientAuthMethod =
				answeredMethod === "none" || answeredMethod === "client_secret_basic" || answeredMethod === "client_secret_post"
					? answeredMethod
					: registered.client_secret
						? "client_secret_basic"
						: "none";
			// 0 means the secret never expires (RFC 7591).
			const clientSecretExpiresAt = registered.client_secret_expires_at
				? registered.client_secret_expires_at * 1000
				: null;
			// Every Connect with an expired client registers a new one, and each is stored for good. So a
			// sign-in server whose secrets expire at once could grow the client table on every Connect.
			if (clientSecretExpiresAt !== null && clientSecretExpiresAt < Date.now() + CLIENT_SECRET_MIN_LIFETIME_MS) {
				return oauth_nay("oauth_registration_failed");
			}
			console.info("MCP OAuth client registered", { urlHash: (await crypto_sha256_hex(issuer)).slice(0, 16) });
			client = {
				kind: "dcr",
				clientId: registered.client_id,
				clientSecret: registered.client_secret ?? null,
				clientSecretExpiresAt,
				authMethod,
			};
		} catch (error) {
			const code = guard.failure ?? "oauth_registration_failed";
			await log_failure({ operation: "register", url: issuer, code, error });
			return oauth_nay(code);
		}
	} else {
		return oauth_nay("oauth_no_client");
	}

	const authorization = await startAuthorization(issuer, {
		metadata,
		clientInformation: { client_id: client.clientId },
		redirectUrl: args.redirectUri,
		scope: scope || undefined,
		state: args.state,
		// Pass the string, never a URL object, so the exact PRM value is sent (no `/` added).
		resource,
	});

	return Result({
		_yay: {
			resource,
			issuer,
			endpoints: discovered._yay.endpoints,
			issParameterSupported: discovered._yay.issParameterSupported,
			authorizationHost: discovered._yay.authorizationHost,
			client,
			scopes: scope ? scope.split(" ") : [],
			authorizationUrl: authorization.authorizationUrl.href,
			codeVerifier: authorization.codeVerifier,
		},
	});
}

/**
 * Send one token request (RFC 6749 §4.1.3 and §6) with the stored client auth, and check the answer.
 * Never follows a redirect, because the guard refuses redirects on a POST.
 */
async function token_request(
	args: { tokenEndpoint: string; client: mcp_oauth_Client; params: URLSearchParams; operation: string } & TestOptions,
) {
	const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
	add_client_auth({ client: args.client, headers, params: args.params });

	const guard = mcp_guarded_fetch_create({
		kind: "oauth",
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
	let response: Response;
	try {
		response = await guard.fetch(args.tokenEndpoint, { method: "POST", headers, body: args.params.toString() });
	} catch (error) {
		const code = guard.failure ?? "network_error";
		await log_failure({ operation: args.operation, url: args.tokenEndpoint, code, error });
		return oauth_nay(code);
	}

	const json: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		// Read only the error code, from a fixed list of values. Never the description.
		const oauthError =
			typeof json === "object" && json !== null && "error" in json && typeof json.error === "string"
				? json.error
				: null;
		await log_failure({ operation: args.operation, url: args.tokenEndpoint, code: `http_${response.status}`, error: null });
		if (oauthError === "invalid_grant") return oauth_nay("oauth_invalid_grant");
		if (response.status >= 500) return oauth_nay("server_error");
		return oauth_nay("oauth_token_refused", {
			oauthError: oauthError && /^[a-z_]{1,64}$/u.test(oauthError) ? oauthError : null,
		});
	}

	const parsed = token_response_schema.safeParse(json);
	if (!parsed.success) return oauth_nay("oauth_token_invalid");
	return Result({
		_yay: {
			accessToken: parsed.data.access_token,
			refreshToken: parsed.data.refresh_token ?? null,
			expiresAt: parsed.data.expires_in === undefined ? null : Date.now() + parsed.data.expires_in * 1000,
			scope: parsed.data.scope ?? null,
		} satisfies Tokens,
	});
}

/**
 * Add client authentication by the stored method (RFC 6749 §2.3.1). Basic auth encodes the id and
 * the secret with the form encoding first, as the RFC says.
 */
function add_client_auth(args: {
	client: mcp_oauth_Client;
	headers: Headers;
	params: URLSearchParams;
}) {
	const { client, headers, params } = args;

	if (client.authMethod === "client_secret_basic" && client.clientSecret !== null) {
		const id = encodeURIComponent(client.clientId);
		const secret = encodeURIComponent(client.clientSecret);
		headers.set("Authorization", `Basic ${btoa(`${id}:${secret}`)}`);
		return;
	}
	params.set("client_id", client.clientId);
	if (client.authMethod === "client_secret_post" && client.clientSecret !== null) {
		params.set("client_secret", client.clientSecret);
	}
}

/**
 * RFC 9207: an AS that sends `iss` must send the exact issuer, and an AS that promised `iss` must
 * send it. The comparison is plain string equality, with no URL normalization.
 */
export function mcp_oauth_callback_iss_matches(args: {
	iss: string | null;
	issuer: string;
	issParameterSupported: boolean;
}) {
	return args.iss === null ? !args.issParameterSupported : args.iss === args.issuer;
}

/**
 * Exchange the authorization code at the token endpoint recorded at start. The caller already
 * checked `state` and `iss`.
 */
export async function mcp_oauth_exchange(
	args: {
		tokenEndpoint: string;
		client: mcp_oauth_Client;
		code: string;
		codeVerifier: string;
		redirectUri: string;
		resource: string;
	} & TestOptions,
) {
	return await token_request({
		tokenEndpoint: args.tokenEndpoint,
		client: args.client,
		params: new URLSearchParams({
			grant_type: "authorization_code",
			code: args.code,
			code_verifier: args.codeVerifier,
			redirect_uri: args.redirectUri,
			resource: args.resource,
		}),
		operation: "exchange",
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
}

/**
 * Refresh with the values stored on the grant. It never runs discovery again, so a server that names
 * a new AS later never receives this refresh token. A response without a new refresh token
 * keeps the old one.
 */
export async function mcp_oauth_refresh(
	args: {
		tokenEndpoint: string;
		client: mcp_oauth_Client;
		refreshToken: string;
		resource: string;
		/**
		 * The scope the AS granted. Refresh never asks for more.
		 */
		scope: string | null;
	} & TestOptions,
) {
	const params = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: args.refreshToken,
		resource: args.resource,
	});
	if (args.scope) params.set("scope", args.scope);

	const refreshed = await token_request({
		tokenEndpoint: args.tokenEndpoint,
		client: args.client,
		params,
		operation: "refresh",
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
	if (refreshed._nay) return refreshed;
	return Result({
		_yay: { ...refreshed._yay, refreshToken: refreshed._yay.refreshToken ?? args.refreshToken },
	});
}

/**
 * Revoke one token (RFC 7009), best effort. The caller has already deleted it locally.
 */
export async function mcp_oauth_revoke(
	args: {
		revocationEndpoint: string;
		client: mcp_oauth_Client;
		token: string;
		tokenTypeHint: "refresh_token" | "access_token";
	} & TestOptions,
) {
	const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
	const params = new URLSearchParams({ token: args.token, token_type_hint: args.tokenTypeHint });
	add_client_auth({ client: args.client, headers, params });

	const guard = mcp_guarded_fetch_create({
		kind: "oauth",
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
	try {
		const response = await guard.fetch(args.revocationEndpoint, { method: "POST", headers, body: params.toString() });
		await response.body?.cancel();
		if (!response.ok) {
			await log_failure({ operation: "revoke", url: args.revocationEndpoint, code: `http_${response.status}`, error: null });
			return oauth_nay(response.status >= 500 ? "server_error" : "oauth_token_refused");
		}
	} catch (error) {
		const code: mcp_GuardedFetchFailure = guard.failure ?? "network_error";
		await log_failure({ operation: "revoke", url: args.revocationEndpoint, code, error });
		return oauth_nay(code);
	}

	return Result({ _yay: {} });
}

/**
 * Check that the client metadata document the app serves names the same client id and callback that
 * Convex builds. A mismatch means the app and Convex drifted apart, and every AS would refuse.
 */
export async function mcp_oauth_check_client_document(args: { clientIdMetadataUrl: string; redirectUri: string }) {
	const guard = mcp_guarded_fetch_create({
		kind: "oauth",
		// The app host is a Press host, so the guard refuses it by default. This one read needs it.
		allowedPressHost: new URL(args.clientIdMetadataUrl).hostname,
	});
	let response: Response;
	try {
		response = await guard.fetch(args.clientIdMetadataUrl, { headers: { Accept: "application/json" } });
	} catch (error) {
		const code = guard.failure ?? "network_error";
		await log_failure({ operation: "client_document", url: args.clientIdMetadataUrl, code, error });
		return oauth_nay(code);
	}

	const parsed = client_metadata_document_schema.safeParse(await response.json().catch(() => null));
	if (
		!response.ok ||
		!parsed.success ||
		parsed.data.client_id !== args.clientIdMetadataUrl ||
		parsed.data.redirect_uris.length !== 1 ||
		parsed.data.redirect_uris[0] !== args.redirectUri
	) {
		return oauth_nay("oauth_client_document_mismatch");
	}

	return Result({ _yay: {} });
}
