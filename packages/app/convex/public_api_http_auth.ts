import type { ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
// Keep these imports type-only. The static files/list route loads this auth module on its hot path.
import type { public_api_resolve_principal_Result } from "./public_api.ts";
import type { plugins_runtime_consume_run_api_call_Result } from "./plugins_runtime.ts";
import { rate_limiter_http_client_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import {
	public_api_PLUGIN_RUN_TOKEN_REGEX,
	public_api_PLUGIN_SERVICE_TOKEN_REGEX,
	public_api_PLUGIN_UI_TOKEN_REGEX,
	type public_api_Scope,
} from "../shared/public-api.ts";

const API_CREDENTIAL_TOKEN_REGEX = /^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u;
const PUBLIC_API_GRANT_TOKEN_REGEX = /^[0-9a-f]{64}$/u;
type RequiredAppPermission = Extract<access_control_Permission, "content.read" | "content.write">;
const CONTENT_READ_PERMISSION = "content.read" as const satisfies RequiredAppPermission;
const CONTENT_WRITE_PERMISSION = "content.write" as const satisfies RequiredAppPermission;

// Public scopes describe API access. App permissions describe what the user may do. Keep the
// values separate because several file scopes can require the same app permission.
const REQUIRED_APP_PERMISSION_BY_SCOPE = {
	"files:list": CONTENT_READ_PERMISSION,
	"files:read": CONTENT_READ_PERMISSION,
	"files:write": CONTENT_WRITE_PERMISSION,
	"files:download": CONTENT_READ_PERMISSION,
	"secrets:read": null,
	"outbound:fetch": null,
	"activities:write": null,
	// Plugin documents live in the workspace, so a key can never read or write more of them than the
	// person behind it can. Mapping these to null would let a member without content permissions read
	// every installation's stored data.
	"plugin_data:read": CONTENT_READ_PERMISSION,
	"plugin_data:write": CONTENT_WRITE_PERMISSION,
} as const satisfies Record<public_api_Scope, RequiredAppPermission | null>;

type Principal = NonNullable<public_api_resolve_principal_Result["_yay"]>;
type PrincipalKind = "public_api_grant" | "user_api_key" | "plugin_run" | "plugin_ui" | "plugin_service";

function get_bearer_token(request: Request) {
	const authorization = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!authorization?.startsWith(prefix)) return null;
	const token = authorization.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

function is_plausible_bearer_token(token: string) {
	// Reject malformed bearer tokens before lookup. Well-formed tokens still require DB verification.
	return (
		API_CREDENTIAL_TOKEN_REGEX.test(token) ||
		PUBLIC_API_GRANT_TOKEN_REGEX.test(token) ||
		public_api_PLUGIN_RUN_TOKEN_REGEX.test(token) ||
		public_api_PLUGIN_UI_TOKEN_REGEX.test(token) ||
		public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(token)
	);
}

async function mark_credential_used_best_effort(
	ctx: ActionCtx,
	args: {
		credentialId: Id<"api_credentials"> | null;
		now: number;
	},
) {
	const credentialId = args.credentialId;
	if (!credentialId) return;

	try {
		await ctx.runMutation(internal.public_api.mark_credential_used, {
			credentialId,
			now: args.now,
		});
	} catch (error) {
		console.warn("Failed to mark API credential used", {
			error,
			credentialId,
		});
	}
}

function is_principal_kind_allowed<K extends PrincipalKind>(
	principal: Principal,
	allowedKinds: readonly K[],
): principal is Extract<Principal, { kind: K }> {
	// Widening assignment: every K is a PrincipalKind.
	const kinds: readonly PrincipalKind[] = allowedKinds;
	return kinds.includes(principal.kind);
}

export function public_api_is_path_inside_prefix(filePath: string, pathPrefix: string | null) {
	if (pathPrefix == null) return true;
	const normalizedPrefix = server_path_normalize(pathPrefix);
	return normalizedPrefix === "/" || filePath === normalizedPrefix || filePath.startsWith(`${normalizedPrefix}/`);
}

/**
 * Whose eyes a public API call reads files with.
 *
 * A plugin run has no user of its own, so it reads as the person whose upload started it. Without
 * that rule, installing a plugin would be a way around a restricted folder.
 */
export function public_api_visibility_user_id(principal: { actorUserId: Id<"users"> } | { userId: Id<"users"> }) {
	return "actorUserId" in principal ? principal.actorUserId : principal.userId;
}

/**
 * Apply checks that vary per call after the cacheable principal query resolves the token.
 */
export async function public_api_resolve_live_principal(
	ctx: ActionCtx,
	args: {
		presented: string;
		now: number;
		requiredScope: public_api_Scope;
	},
) {
	const resolved: public_api_resolve_principal_Result = await ctx.runQuery(internal.public_api.resolve_principal, {
		presented: args.presented,
	});
	if (resolved._nay) {
		return resolved;
	}

	const principal = resolved._yay;
	const expiresAt =
		principal.kind === "plugin_run"
			? principal.apiTokenExpiresAt
			: principal.kind === "plugin_ui"
				? principal.sessionExpiresAt
				: principal.kind === "public_api_grant" || principal.kind === "plugin_service"
					? principal.expiresAt
					: null;
	if (expiresAt != null && expiresAt <= args.now) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	// Every service grant is judged with its actor's live permissions, in both phases, on purpose.
	// `seal-processing` binds a `processing` grant to one destination path prefix, and that seal says
	// where the grant may write. It does not say whether the member behind it may still write at all.
	// So do not exempt `processing` here: the seal is not a substitute for this check.
	const requiredAppPermission = REQUIRED_APP_PERMISSION_BY_SCOPE[args.requiredScope];
	if (requiredAppPermission && principal.kind !== "plugin_run") {
		const allowed =
			requiredAppPermission === CONTENT_READ_PERMISSION
				? principal.contentPermissions.read
				: principal.contentPermissions.write;
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}
	}

	return resolved;
}

/**
 * Authorize a user API key so its owner can inspect it, without asking for any one scope.
 *
 * `public_api_authorize_request` exists to make a route name the scope it needs, so it can never
 * forget the matching app-permission check. A key-inspection route has no scope to name: the whole
 * point is to report which scopes the key still has. So it gets its own entry point instead of a
 * nullable scope on the shared one, and the returned list is already filtered to what the person
 * behind the key may still do.
 */
export async function public_api_authorize_key_inspection(ctx: ActionCtx, request: Request, args: { route: string }) {
	const token = get_bearer_token(request);
	const rateLimitAuthFailure = async () => {
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_auth",
			key: `${rate_limiter_http_client_key(request)}:${args.route}`,
		});
		if (rateLimit) {
			return {
				_nay: {
					status: 429,
					body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
				},
			} as const;
		}

		return { _nay: { status: 401, body: { message: "Unauthenticated" } } } as const;
	};

	if (!token || !is_plausible_bearer_token(token)) {
		return await rateLimitAuthFailure();
	}

	const resolved: public_api_resolve_principal_Result = await ctx.runQuery(internal.public_api.resolve_principal, {
		presented: token,
	});
	if (resolved._nay) {
		return await rateLimitAuthFailure();
	}

	// Only a person's own key can be inspected this way. A plugin token has no key screen, and a
	// short-lived grant would learn nothing it does not already carry.
	const principal = resolved._yay;
	if (principal.kind !== "user_api_key") {
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	const now = Date.now();
	const postAuthRateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_principal",
		key: `${principal.kind}:${principal.principalKey}:${args.route}`,
	});
	if (postAuthRateLimit) {
		return {
			_nay: {
				status: 429,
				body: { message: postAuthRateLimit.message, retryAfterMs: postAuthRateLimit.retryAfterMs },
			},
		} as const;
	}

	// A scope the owner can no longer use is not a scope the key still has. Report what a call would
	// actually be allowed to do today, not what the key was minted with.
	const allowedScopes = principal.scopes.filter((scope) => {
		const requiredAppPermission = REQUIRED_APP_PERMISSION_BY_SCOPE[scope];
		if (!requiredAppPermission) {
			return true;
		}

		return requiredAppPermission === CONTENT_READ_PERMISSION
			? principal.contentPermissions.read
			: principal.contentPermissions.write;
	});

	await mark_credential_used_best_effort(ctx, { credentialId: principal.credentialId, now });
	return { _yay: { principal, allowedScopes } } as const;
}

/**
 * Settle a plugin call created during authorization. Telemetry must not change an HTTP response
 * that the route already decided.
 */
export async function public_api_settle_plugin_call_best_effort(
	ctx: ActionCtx,
	args: {
		callId: Id<"plugins_event_run_calls"> | null;
		status: "succeeded" | "failed";
		responseStatus: number;
		errorCode?: string;
		errorMessage?: string;
		responseBytes?: number;
	},
) {
	const callId = args.callId;
	if (!callId) return;

	try {
		await ctx.runMutation(internal.plugins_runtime.finish_run_call, {
			callId,
			status: args.status,
			responseStatus: args.responseStatus,
			errorCode: args.errorCode,
			errorMessage: args.errorMessage ?? null,
			responseBytes: args.responseBytes,
		});
	} catch (error) {
		console.warn("Failed to settle plugin run call", { error, callId });
	}
}

export async function public_api_authorize_request<K extends PrincipalKind>(
	ctx: ActionCtx,
	request: Request,
	args: {
		requiredScope: public_api_Scope;
		allowedKinds: readonly K[];
		route: string;
	},
) {
	const token = get_bearer_token(request);
	if (!token || !is_plausible_bearer_token(token)) {
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_auth",
			key: `${rate_limiter_http_client_key(request)}:${args.route}`,
		});
		if (rateLimit) {
			return {
				_nay: {
					status: 429,
					body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
				},
			} as const;
		}

		return { _nay: { status: 401, body: { message: "Unauthenticated" } } } as const;
	}

	const resolved = await public_api_resolve_live_principal(ctx, {
		presented: token,
		now: Date.now(),
		requiredScope: args.requiredScope,
	});
	if (resolved._nay) {
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_auth",
			key: `${rate_limiter_http_client_key(request)}:${args.route}`,
		});
		if (rateLimit) {
			return {
				_nay: {
					status: 429,
					body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
				},
			} as const;
		}

		return {
			_nay: {
				status: resolved._nay.message === "Permission denied" ? 403 : 401,
				body: { message: resolved._nay.message },
			},
		} as const;
	}

	const principal = resolved._yay;
	const now = Date.now();
	const postAuthRateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_principal",
		key: `${principal.kind}:${principal.principalKey}:${args.route}`,
	});
	if (postAuthRateLimit) {
		console.warn("Public API principal route rate-limited", {
			route: args.route,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		return {
			_nay: {
				status: 429,
				body: { message: postAuthRateLimit.message, retryAfterMs: postAuthRateLimit.retryAfterMs },
			},
		} as const;
	}

	// Consume the slot before the kind and scope checks. A rejected plugin call must still cost a slot.
	let pluginCallId: Id<"plugins_event_run_calls"> | null = null;
	if (principal.kind === "plugin_run") {
		const consumed: plugins_runtime_consume_run_api_call_Result = await ctx.runMutation(
			internal.plugins_runtime.consume_run_api_call,
			{
				runId: principal.runId,
				kind: "api_request",
				route: args.route,
			},
		);
		if (consumed._nay) {
			return {
				_nay: {
					status: consumed._nay.message === "Plugin API call limit exceeded" ? 429 : 401,
					body: { message: consumed._nay.message },
				},
			} as const;
		}
		pluginCallId = consumed._yay.callId;
	}

	// Capture these before generic kind narrowing. Each principal union arm has a narrower scope array.
	const principalScopes: readonly public_api_Scope[] = principal.scopes;
	const credentialId = principal.kind === "plugin_run" ? null : principal.credentialId;

	if (!is_principal_kind_allowed(principal, args.allowedKinds)) {
		console.warn("Public API principal kind rejected", {
			route: args.route,
			requiredKinds: args.allowedKinds,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 403,
			errorCode: "permission_denied",
			errorMessage: "Permission denied",
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	if (!principalScopes.includes(args.requiredScope)) {
		console.warn("Public API principal scope rejected", {
			route: args.route,
			requiredScope: args.requiredScope,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 403,
			errorCode: "permission_denied",
			errorMessage: "Permission denied",
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	await mark_credential_used_best_effort(ctx, {
		credentialId,
		now,
	});
	return { _yay: { principal, pluginCallId, presentedToken: token } } as const;
}
