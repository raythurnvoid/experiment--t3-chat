import { SignJWT } from "jose";
import { v } from "convex/values";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import { internalAction, type ActionCtx } from "./_generated/server.js";
import type {
	plugins_chitchat_create_lease_facts_Result,
	plugins_chitchat_get_events_Result,
	plugins_chitchat_get_snapshot_Result,
} from "./plugins_chitchat.ts";
import { users_ANONYMOUS_JWT_DEFAULT_KID, users_get_anonymous_jwt_private_key } from "./users.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { public_api_PLUGIN_UI_TOKEN_REGEX } from "../shared/public-api.ts";

if (!process.env.VITE_CONVEX_HTTP_URL) throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
const JWT_ISSUER = `${process.env.VITE_CONVEX_HTTP_URL}/plugins/chitchat`;

// Push is optional until the separate app is configured. Fresh leases still require a current pull.
const CHITCHAT_HTTP_URL = process.env.CHITCHAT_HTTP_URL;
const CHITCHAT_ACCESS_PUSH_SECRET = process.env.CHITCHAT_ACCESS_PUSH_SECRET;

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

async function read_request<Body>(request: Request, validator: z.ZodSchema<Body>) {
	const serviceSecret = bearer(request, "X-Bonobo-Service-Authorization");
	if (!serviceSecret) return Result({ _nay: { message: "Unauthorized" } });
	const body = await server_request_json_parse_and_validate(request, validator);
	if (body._nay) return body;
	return Result({ _yay: { body: body._yay, serviceSecretHash: await crypto_sha256_hex(serviceSecret) } });
}

const lease_body_validator = z
	.object({ exchangeId: z.string().uuid(), requestedExpiresAt: z.number().int().positive() })
	.strict();
export type plugins_chitchat_http_lease_Body = z.infer<typeof lease_body_validator>;

export async function plugins_chitchat_http_lease(ctx: ActionCtx, request: Request) {
	const token = bearer(request, "Authorization");
	if (!token || !public_api_PLUGIN_UI_TOKEN_REGEX.test(token)) return failure("Unauthorized");
	const parsed = await read_request(request, lease_body_validator);
	if (parsed._nay) return failure(parsed._nay.message);
	const result: plugins_chitchat_create_lease_facts_Result = await ctx.runMutation(
		internal.plugins_chitchat.create_lease_facts,
		{
			...parsed._yay.body,
			serviceSecretHash: parsed._yay.serviceSecretHash,
			tokenHash: await crypto_sha256_hex(token),
		},
	);
	if (result._nay) return failure(result._nay.message);
	const facts = result._yay;
	if (facts.expiresAt <= Date.now()) return failure("Lease has expired");
	const jwt = await new SignJWT(facts)
		.setProtectedHeader({ alg: "ES256", kid: users_ANONYMOUS_JWT_DEFAULT_KID, typ: "JWT" })
		.setIssuer(JWT_ISSUER)
		.setAudience("chitchat")
		.setSubject(facts.hostSessionId)
		.setJti(facts.exchangeId)
		.setIssuedAt(Math.floor(facts.validatedAt / 1000))
		.setExpirationTime(Math.floor(facts.expiresAt / 1000))
		.sign(await users_get_anonymous_jwt_private_key());
	return { status: 200, body: { jwt, facts } } as const;
}

const snapshot_body_validator = z
	.object({
		installationId: z.string().min(1),
		cursor: z.string().nullable(),
		startRevision: z.number().int().nonnegative().nullable(),
	})
	.strict();
export type plugins_chitchat_http_snapshot_Body = z.infer<typeof snapshot_body_validator>;

export async function plugins_chitchat_http_snapshot(ctx: ActionCtx, request: Request) {
	const parsed = await read_request(request, snapshot_body_validator);
	if (parsed._nay) return failure(parsed._nay.message);
	const result: plugins_chitchat_get_snapshot_Result = await ctx.runMutation(internal.plugins_chitchat.get_snapshot, {
		...parsed._yay.body,
		serviceSecretHash: parsed._yay.serviceSecretHash,
	});
	if (result._nay) return failure(result._nay.message);
	return { status: 200, body: result._yay } as const;
}

const events_body_validator = z
	.object({
		installationId: z.string().min(1),
		afterRevision: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
	})
	.strict();
export type plugins_chitchat_http_events_Body = z.infer<typeof events_body_validator>;

export async function plugins_chitchat_http_events(ctx: ActionCtx, request: Request) {
	const parsed = await read_request(request, events_body_validator);
	if (parsed._nay) return failure(parsed._nay.message);
	const result: plugins_chitchat_get_events_Result = await ctx.runQuery(internal.plugins_chitchat.get_events, {
		...parsed._yay.body,
		serviceSecretHash: parsed._yay.serviceSecretHash,
	});
	if (result._nay) return failure(result._nay.message);
	return { status: 200, body: result._yay } as const;
}

export const push_access_events = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (!CHITCHAT_HTTP_URL || !CHITCHAT_ACCESS_PUSH_SECRET) return null;
		const revision: number | null = await ctx.runQuery(internal.plugins_chitchat.get_push_head, {});
		if (revision === null) return null;
		try {
			const response = await fetch(`${CHITCHAT_HTTP_URL}/auth/access-events`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
				headers: { Authorization: `Bearer ${CHITCHAT_ACCESS_PUSH_SECRET}`, "Content-Type": "application/json" },
				body: JSON.stringify({ availableRevision: revision }),
			});
			if (response.ok) await ctx.runMutation(internal.plugins_chitchat.acknowledge_push, { revision });
			else console.warn("Chitchat access notification failed", { revision, status: response.status });
		} catch {
			console.warn("Chitchat access notification could not connect", { revision });
		}
		return null;
	},
});
