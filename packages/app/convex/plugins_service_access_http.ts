import { SignJWT } from "jose";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import type {
	plugins_service_access_create_lease_facts_Result,
	plugins_service_access_get_events_Result,
	plugins_service_access_get_snapshot_Result,
} from "./plugins_service_access.ts";
import { users_ANONYMOUS_JWT_DEFAULT_KID, users_get_anonymous_jwt_private_key } from "./users.ts";
import { rate_limiter_http_client_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { public_api_PLUGIN_UI_TOKEN_REGEX } from "../shared/public-api.ts";

if (!process.env.VITE_CONVEX_HTTP_URL) throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
// Signed by this deployment but not registered in auth.config: these routes verify it by hand.
const JWT_ISSUER = `${process.env.VITE_CONVEX_HTTP_URL}/plugins-services`;

function bearer(request: Request, header: string) {
	const value = request.headers.get(header);
	return value?.startsWith("Bearer ") ? value.slice(7).trim() : null;
}

function failure(message: string) {
	if (message === "Rate limit exceeded") return { status: 429, body: { code: "rate_limited", message } } as const;
	if (message === "Unauthorized")
		return { status: 401, body: { code: "unauthorized", message: "Unauthorized" } } as const;
	if (message === "Permission denied") return { status: 403, body: { code: "permission_denied", message } } as const;
	if (message === "Lease has expired") return { status: 409, body: { code: "expired_lease", message } } as const;
	if (message === "Snapshot required") return { status: 410, body: { code: "snapshot_required", message } } as const;
	if (message === "Installation is unavailable")
		return { status: 409, body: { code: "unavailable", message } } as const;
	if (message === "Installation has been removed") return { status: 410, body: { code: "revoked", message } } as const;
	return { status: 400, body: { code: "invalid_request", message } } as const;
}

async function request_failure(ctx: ActionCtx, request: Request, message: string) {
	if (message === "Unauthorized") {
		const limited = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_auth",
			key: `${rate_limiter_http_client_key(request)}:${new URL(request.url).pathname}`,
		});
		if (limited) return failure(limited.message);
	}
	return failure(message);
}

async function read_request<Body>(request: Request, validator: z.ZodSchema<Body>) {
	const serviceSecret = bearer(request, "X-Bonobo-Service-Authorization");
	if (!serviceSecret) return Result({ _nay: { message: "Unauthorized" } });

	const body = await server_request_json_parse_and_validate(request, validator);
	if (body._nay) return body;

	return Result({ _yay: { body: body._yay, serviceSecretHash: await crypto_sha256_hex(serviceSecret) } });
}

// #region identity exchange

const lease_body_validator = z
	.object({ exchangeId: z.string().min(1).max(128), requestedExpiresAt: z.number().int().positive() })
	.strict();

export type plugins_service_access_http_lease_Body = z.infer<typeof lease_body_validator>;

export async function plugins_service_access_http_lease(ctx: ActionCtx, request: Request) {
	const token = bearer(request, "Authorization");
	if (!token || !public_api_PLUGIN_UI_TOKEN_REGEX.test(token))
		return await request_failure(ctx, request, "Unauthorized");

	const parsed = await read_request(request, lease_body_validator);
	if (parsed._nay) return await request_failure(ctx, request, parsed._nay.message);

	const result: plugins_service_access_create_lease_facts_Result = await ctx.runMutation(
		internal.plugins_service_access.create_lease_facts,
		{
			...parsed._yay.body,
			serviceSecretHash: parsed._yay.serviceSecretHash,
			tokenHash: await crypto_sha256_hex(token),
		},
	);
	if (result._nay) return await request_failure(ctx, request, result._nay.message);

	const { audience, ...facts } = result._yay;
	if (facts.expiresAt <= Date.now()) return failure("Lease has expired");

	const jwt = await new SignJWT(facts)
		.setProtectedHeader({ alg: "ES256", kid: users_ANONYMOUS_JWT_DEFAULT_KID, typ: "JWT" })
		.setIssuer(JWT_ISSUER)
		.setAudience(audience)
		.setSubject(facts.hostSessionId)
		.setJti(facts.exchangeId)
		.setIssuedAt(Math.floor(facts.validatedAt / 1000))
		.setExpirationTime(Math.floor(facts.expiresAt / 1000))
		.sign(await users_get_anonymous_jwt_private_key());

	return { status: 200, body: { jwt } } as const;
}

// #endregion identity exchange

// #region member snapshot

const snapshot_body_validator = z
	.object({
		installationId: z.string().min(1),
		cursor: z.string().nullable(),
		startRevision: z.number().int().nonnegative().nullable(),
	})
	.strict();

export type plugins_service_access_http_snapshot_Body = z.infer<typeof snapshot_body_validator>;

export async function plugins_service_access_http_snapshot(ctx: ActionCtx, request: Request) {
	const parsed = await read_request(request, snapshot_body_validator);
	if (parsed._nay) return await request_failure(ctx, request, parsed._nay.message);

	const result: plugins_service_access_get_snapshot_Result = await ctx.runMutation(
		internal.plugins_service_access.get_snapshot,
		{
			...parsed._yay.body,
			serviceSecretHash: parsed._yay.serviceSecretHash,
		},
	);
	if (result._nay) return await request_failure(ctx, request, result._nay.message);

	return { status: 200, body: result._yay } as const;
}

// #endregion member snapshot

// #region access changes

const events_body_validator = z
	.object({
		installationId: z.string().min(1),
		afterRevision: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
	})
	.strict();

export type plugins_service_access_http_events_Body = z.infer<typeof events_body_validator>;

export async function plugins_service_access_http_events(ctx: ActionCtx, request: Request) {
	const parsed = await read_request(request, events_body_validator);
	if (parsed._nay) return await request_failure(ctx, request, parsed._nay.message);

	const result: plugins_service_access_get_events_Result = await ctx.runMutation(
		internal.plugins_service_access.get_events,
		{
			...parsed._yay.body,
			serviceSecretHash: parsed._yay.serviceSecretHash,
		},
	);
	if (result._nay) return await request_failure(ctx, request, result._nay.message);

	return { status: 200, body: result._yay } as const;
}

// #endregion access changes
