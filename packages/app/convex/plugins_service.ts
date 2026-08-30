/**
 * The `/api/internal/plugins/service-grants/*` routes.
 *
 * A plugin frame runs in the browser and holds a short read-only `plu_` token. A page and a file view
 * both get one from the same table, and nothing in this module can tell the two apart. A plugin that
 * also has a server of its own cannot use that token: it belongs to one iframe and dies with it.
 * These routes are how such a server trades the frame's token for a `psg_` grant of its own, keeps
 * that grant alive, and asks whether it is still allowed to act before it does something the user
 * will see.
 *
 * Two credentials are needed, the same way the runner host routes work. The shared secret proves the
 * call comes from the service the operator deployed, and it is checked first so a frame holding only
 * its own token cannot reach or probe these routes. The bearer then says which installation and which
 * member the call is for.
 *
 * `public_api.ts` owns the grant table, the token format, and the resolver. This module owns only the
 * lifecycle: who may trade a UI token for a grant, when a grant may be renewed, and what a service
 * is told when it asks whether its grant is still live.
 */
import type { RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { z } from "zod";

import { internal } from "./_generated/api.js";
import { internalQuery, type ActionCtx } from "./_generated/server.js";
import type {
	public_api_create_plugin_service_grant_Result,
	public_api_resolve_principal_Result,
	public_api_rotate_plugin_service_grant_Result,
} from "./public_api.ts";
import app_convex_schema from "./schema.ts";
import { crypto_sha256_hex, crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { files_normalize_name } from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { public_api_PLUGIN_SERVICE_TOKEN_REGEX, public_api_PLUGIN_UI_TOKEN_REGEX } from "../shared/public-api.ts";

// #region shared

/**
 * The shared secret the Council service proves itself with.
 *
 * This is read without throwing when it is unset, unlike `PLUGIN_RUNNER_HOST_SECRET` in
 * `plugins_runtime.ts`. That secret is set on every deployment already, so a missing value there
 * means the deployment is broken and stopping is right. This one is set when the Council service is
 * first deployed. Until then a throw would fail the whole Convex push and take the rest of the app
 * down with it. So an unset secret refuses every call here instead, and nothing else changes.
 */
const COUNCIL_SERVICE_EXCHANGE_SECRET = process.env.COUNCIL_SERVICE_EXCHANGE_SECRET;

/**
 * The one plugin this secret may exchange UI tokens for.
 *
 * Without it the secret would work for any installation whose plugin declares the five capabilities,
 * and that is a way for one plugin to act as another. Every plugin frame is served from the same
 * asset origin, pages and file views alike, so one frame can read another frame's `plu_` token — the
 * plugin-system skill says plainly that the shared origin is not a plugin-to-plugin boundary. A
 * service holding this secret could present that stolen token and get a grant carrying the other
 * plugin's producer identity. A UI token is read-only for plugin data on purpose, while a service
 * grant is the only principal allowed to write versioned documents at all, so the exchange would turn
 * a read-only token into the other plugin's writer.
 *
 * Read without throwing for the same reason as the secret above. Unset refuses every exchange.
 */
const COUNCIL_PLUGIN_NAME = process.env.COUNCIL_PLUGIN_NAME;

/**
 * The capabilities a workspace must have accepted before its Council installation may hand access to
 * a server outside the app.
 *
 * `plugin.service.connect` is the one the install dialog warns about, and the mint checks it again.
 * The other four are what the finished Council needs to do its job, so asking for all of them up
 * front means a half-consented install fails at the exchange instead of halfway through a meeting.
 */
const REQUIRED_CAPABILITIES = [
	"plugin.service.connect",
	"plugin.data.read",
	"plugin.data.write",
	"workspace.files.write",
	"workspace.files.create-read-only",
] as const satisfies readonly plugins_Capability[];

function get_service_secret(request: Request) {
	const header = request.headers.get("X-Bonobo-Service-Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	const secret = header.slice(prefix.length).trim();
	return secret.length > 0 ? secret : null;
}

function get_bearer_token(request: Request) {
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

/**
 * Prove the call came from the deployed Council service.
 *
 * The digests are compared instead of the secrets themselves so the constant-time compare cannot leak
 * the secret's length. There is no cached digest here on purpose: these routes run a few times per
 * meeting, not on every plugin API call the way the runner host routes do, so the hash is not worth
 * a cache that would have to explain itself.
 */
async function is_council_service(request: Request) {
	const presented = get_service_secret(request);
	if (!presented || !COUNCIL_SERVICE_EXCHANGE_SECRET) {
		return false;
	}

	return crypto_timing_safe_equal(
		await crypto_sha256_hex(presented),
		await crypto_sha256_hex(COUNCIL_SERVICE_EXCHANGE_SECRET),
	);
}

/**
 * The shared shape of all four routes: service secret first, then the bearer, then the body.
 *
 * Every authentication failure answers with the same `Unauthorized` literal, so a caller cannot tell
 * a wrong secret from a wrong token from a token that expired a minute ago. Any other `_nay` is a
 * body problem. Callers own the status mapping.
 */
async function authorize_council_service_request<Body>(
	ctx: ActionCtx,
	request: Request,
	args: {
		tokenRegex: RegExp;
		bodyValidator: z.ZodSchema<Body>;
	},
) {
	if (!(await is_council_service(request))) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const token = get_bearer_token(request);
	if (!token || !args.tokenRegex.test(token)) {
		return Result({ _nay: { message: "Unauthorized" } });
	}
	const resolved: public_api_resolve_principal_Result = await ctx.runQuery(internal.public_api.resolve_principal, {
		presented: token,
	});
	if (resolved._nay) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const body = await server_request_json_parse_and_validate(request, args.bodyValidator);
	if (body._nay) {
		return Result({ _nay: { message: body._nay.message } });
	}

	return Result({ _yay: { principal: resolved._yay, presentedToken: token, body: body._yay } });
}

/**
 * The capabilities the workspace accepted for one installation.
 *
 * The mint refuses a disabled or foreign installation itself, but it narrows a missing scope
 * capability away instead of refusing, and it would have already written the grant doc by the time
 * the caller saw the narrowed list. So the exchange asks first and refuses without writing anything.
 */
export const get_installation_capabilities = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v_result({
		_yay: v.object({
			pluginName: v.string(),
			acceptedCapabilities: doc(app_convex_schema, "plugins_workspace_installations").fields.acceptedCapabilities,
		}),
	}),
	handler: async (ctx, args) => {
		const [installation, workspace] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", args.installationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);
		if (
			!installation ||
			!workspace ||
			workspace.organizationId !== args.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			installation.status !== "enabled" ||
			installation.organizationId !== args.organizationId ||
			installation.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({
			_yay: { pluginName: installation.pluginName, acceptedCapabilities: installation.acceptedCapabilities },
		});
	},
});

type get_installation_capabilities_Result =
	typeof get_installation_capabilities extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/** The refusals the grant mutations can return, and the status each one is. */
function grant_failure(message: string) {
	if (message === "Unauthorized") {
		return { status: 401, body: { message } } as const;
	}
	// What rotation returns for every liveness failure. The route resolved the same grant a moment
	// earlier, so this only happens when the world changed in between — the installation uninstalled
	// or upgraded, or the actor removed, between the query and the mutation.
	if (message === "Unauthenticated") {
		return { status: 401, body: { message } } as const;
	}
	if (message === "Permission denied") {
		return { status: 403, body: { message } } as const;
	}
	if (message === "Not found") {
		return { status: 404, body: { message } } as const;
	}
	// The only refusal that is not about the caller: two 32-byte random tokens would have to collide.
	if (message === "Failed to mint a unique grant token") {
		return { status: 500, body: { message } } as const;
	}

	return { status: 400, body: { message } } as const;
}

// #endregion shared

// #region exchange

/**
 * Nothing is taken from the body on purpose. The tenant, the installation, the plugin, the scopes,
 * and the destination all come from the live installation the UI token points at, so a service
 * that asked for more than its workspace agreed to would be asking a field that does not exist.
 */
const exchange_body_validator = z.object({}).strict();

export type plugins_service_http_exchange_Body = z.infer<typeof exchange_body_validator>;

export async function plugins_service_http_exchange(ctx: ActionCtx, request: Request) {
	const auth = await authorize_council_service_request(ctx, request, {
		tokenRegex: public_api_PLUGIN_UI_TOKEN_REGEX,
		bodyValidator: exchange_body_validator,
	});
	if (auth._nay) {
		if (auth._nay.message === "Unauthorized") {
			return { status: 401, body: { message: auth._nay.message } } as const;
		}
		return { status: 400, body: { message: auth._nay.message } } as const;
	}

	// Only a UI token starts a grant, and a page and a file view both carry one. A grant that could
	// exchange itself would keep a service alive forever without a member ever opening one of the
	// plugin's frames again, and a leaked exchange secret would then be enough on its own. The regex
	// has already refused every other format; this narrows the union.
	const principal = auth._yay.principal;
	if (principal.kind !== "plugin_ui") {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const now = Date.now();
	// `resolve_principal` proves the session exists and its installation is still live, but it does
	// not judge the clock. Every caller applies that verdict itself.
	if (principal.sessionExpiresAt <= now) {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const installation: get_installation_capabilities_Result = await ctx.runQuery(
		internal.plugins_service.get_installation_capabilities,
		{
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			installationId: principal.installationId,
		},
	);
	if (installation._nay) {
		return grant_failure(installation._nay.message);
	}
	// The secret says which plugin it may act for. Checked before the capabilities so a UI token from
	// another plugin is refused whatever that plugin declares.
	if (!COUNCIL_PLUGIN_NAME || installation._yay.pluginName !== COUNCIL_PLUGIN_NAME) {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}
	const missing = REQUIRED_CAPABILITIES.filter(
		(capability) => !installation._yay.acceptedCapabilities.includes(capability),
	);
	if (missing.length > 0) {
		console.warn("Council service grant exchange refused for missing capabilities", {
			installationId: principal.installationId,
			missing,
		});
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	// No file-write scope is asked for here. It only exists together with a destination prefix, and
	// the destination is chosen when a meeting opens, not when the service connects. The seal route
	// below is what trades this grant for a processing one that carries `files:write` and the exact
	// prefix, and the `/api/v1/files/service-uploads/*` routes only accept that sealed grant.
	const minted: public_api_create_plugin_service_grant_Result = await ctx.runMutation(
		internal.public_api.create_plugin_service_grant,
		{
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			installationId: principal.installationId,
			actorUserId: principal.userId,
			requestedScopes: ["plugin_data:read", "plugin_data:write"],
			destinationPathPrefix: null,
			// The service holds this one while a member is watching the frame. A `processing` grant is
			// what outlives them, and it is minted by the sealed Council flow, not by an exchange.
			phase: "interactive",
			now,
		},
	);
	if (minted._nay) {
		return grant_failure(minted._nay.message);
	}

	return {
		status: 200,
		body: {
			token: minted._yay.token,
			expiresAt: minted._yay.expiresAt,
			scopes: minted._yay.scopes,
			principalKey: minted._yay.principalKey,
			actorUserId: String(principal.userId),
			organizationId: String(principal.organizationId),
			workspaceId: String(principal.workspaceId),
			installationId: String(principal.installationId),
		},
	} as const;
}

// #endregion exchange

// #region renew

/** Renewal reads its whole answer from the presented grant, so it has nothing to say in a body. */
const renew_body_validator = z.object({}).strict();

export type plugins_service_http_renew_Body = z.infer<typeof renew_body_validator>;

/**
 * Give the presented grant a new raw token and another day.
 *
 * This can never create a grant. A service that let its grant die has to wait for a member to open
 * one of the plugin's frames again, because only a live `plu_` token can start a new one. That is
 * what stops a leaked exchange secret from being enough to reach a workspace's data on its own.
 */
export async function plugins_service_http_renew(ctx: ActionCtx, request: Request) {
	const auth = await authorize_council_service_request(ctx, request, {
		tokenRegex: public_api_PLUGIN_SERVICE_TOKEN_REGEX,
		bodyValidator: renew_body_validator,
	});
	if (auth._nay) {
		if (auth._nay.message === "Unauthorized") {
			return { status: 401, body: { message: auth._nay.message } } as const;
		}
		return { status: 400, body: { message: auth._nay.message } } as const;
	}

	const principal = auth._yay.principal;
	if (principal.kind !== "plugin_service") {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const now = Date.now();
	if (principal.expiresAt <= now) {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	// The raw token goes to the mutation, never the grant id: looking the doc up by the hash of what
	// the caller presented is what proves it still holds the token it is renewing.
	const rotated: public_api_rotate_plugin_service_grant_Result = await ctx.runMutation(
		internal.public_api.rotate_plugin_service_grant,
		{
			presented: auth._yay.presentedToken,
			now,
		},
	);
	if (rotated._nay) {
		return grant_failure(rotated._nay.message);
	}

	return {
		status: 200,
		body: {
			token: rotated._yay.token,
			expiresAt: rotated._yay.expiresAt,
			scopes: rotated._yay.scopes,
		},
	} as const;
}

// #endregion renew

// #region seal processing

/**
 * The one field the seal takes from the caller: where the meeting's files will land. Everything
 * else — tenant, installation, actor, scopes — comes from the presented interactive grant.
 */
const seal_processing_body_validator = z
	.object({
		destinationPathPrefix: z.string().min(1),
	})
	.strict();

export type plugins_service_http_seal_processing_Body = z.infer<typeof seal_processing_body_validator>;

/**
 * Trade a live interactive grant for a processing grant sealed to one destination.
 *
 * A meeting just closed and the service now has files to upload. The member who opened the frame may
 * leave before the uploads finish, so the sealed grant gets the six-day recovery window instead of
 * the interactive day, and renewal never extends it. In exchange it is bound to one exact path
 * prefix, and the upload routes refuse everything outside it.
 *
 * Only an interactive grant may seal. If a processing grant could seal again, each window could mint
 * the next one and the six-day deadline would mean nothing.
 */
export async function plugins_service_http_seal_processing(ctx: ActionCtx, request: Request) {
	const auth = await authorize_council_service_request(ctx, request, {
		tokenRegex: public_api_PLUGIN_SERVICE_TOKEN_REGEX,
		bodyValidator: seal_processing_body_validator,
	});
	if (auth._nay) {
		if (auth._nay.message === "Unauthorized") {
			return { status: 401, body: { message: auth._nay.message } } as const;
		}
		return { status: 400, body: { message: auth._nay.message } } as const;
	}

	const principal = auth._yay.principal;
	if (principal.kind !== "plugin_service") {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const now = Date.now();
	if (principal.expiresAt <= now) {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	if (principal.phase !== "interactive") {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	// The prefix must already be the canonical absolute form, because the upload routes and
	// `verify-live` compare it exactly. Accepting `/meetings/` here and storing `/meetings` would
	// leave the service holding a value its own grant refuses. `/` is refused because a grant sealed
	// to the whole workspace is not sealed to anything.
	const destinationPathPrefix = auth._yay.body.destinationPathPrefix;
	if (
		!destinationPathPrefix.startsWith("/") ||
		destinationPathPrefix === "/" ||
		server_path_normalize(destinationPathPrefix) !== destinationPathPrefix
	) {
		return { status: 400, body: { message: "destinationPathPrefix must be a normalized absolute path" } } as const;
	}
	// Every segment must already be a canonical folder name, the same rule the upload routes apply
	// to target paths. A prefix like `/Meetings` would seal a destination no upload can ever land
	// under, and the service would only learn that at its first upload instead of here.
	for (const segment of path_extract_segments_from(destinationPathPrefix)) {
		const normalizedSegment = files_normalize_name("folder", segment);
		if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
			return { status: 400, body: { message: "destinationPathPrefix contains an invalid folder name" } } as const;
		}
	}

	// The member behind the grant must still be allowed to write workspace content, because the files
	// the service uploads are written as that member.
	if (!principal.contentPermissions.write) {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	// The same pre-check the exchange does, for the same reason: the mint narrows a missing scope
	// capability away instead of refusing, so ask first. The mint also refuses on its own through
	// `requireAllRequestedScopes` in case a capability disappears between this query and the mutation.
	const installation: get_installation_capabilities_Result = await ctx.runQuery(
		internal.plugins_service.get_installation_capabilities,
		{
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			installationId: principal.installationId,
		},
	);
	if (installation._nay) {
		return grant_failure(installation._nay.message);
	}
	if (!COUNCIL_PLUGIN_NAME || installation._yay.pluginName !== COUNCIL_PLUGIN_NAME) {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}
	const missing = REQUIRED_CAPABILITIES.filter(
		(capability) => !installation._yay.acceptedCapabilities.includes(capability),
	);
	if (missing.length > 0) {
		console.warn("Council service grant seal refused for missing capabilities", {
			installationId: principal.installationId,
			missing,
		});
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	const minted: public_api_create_plugin_service_grant_Result = await ctx.runMutation(
		internal.public_api.create_plugin_service_grant,
		{
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			installationId: principal.installationId,
			actorUserId: principal.actorUserId,
			requestedScopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			// A processing grant with fewer scopes than promised would fail at the end of the meeting,
			// after the member left. Refuse the seal now instead.
			requireAllRequestedScopes: true,
			destinationPathPrefix,
			phase: "processing",
			now,
		},
	);
	if (minted._nay) {
		return grant_failure(minted._nay.message);
	}

	return {
		status: 200,
		body: {
			token: minted._yay.token,
			expiresAt: minted._yay.expiresAt,
			scopes: minted._yay.scopes,
			principalKey: minted._yay.principalKey,
			destinationPathPrefix,
			actorUserId: String(principal.actorUserId),
			organizationId: String(principal.organizationId),
			workspaceId: String(principal.workspaceId),
			installationId: String(principal.installationId),
		},
	} as const;
}

// #endregion seal processing

// #region verify live

/**
 * What the service believes about its own grant. Each field is compared with what the grant really
 * says, and any difference refuses the call.
 *
 * These are claims to check, not authority to hand out: a wrong value can only turn a yes into a no.
 * That is the point. The service asks before it mints a guest token or starts a recording, so a grant
 * that quietly changed under it stops the meeting instead of producing work nobody may keep.
 *
 * Every field is required. If one were optional, a service that forgot to send it would silently lose
 * that check and still get a 200, which is the opposite of failing closed.
 */
const verify_live_body_validator = z
	.object({
		installationId: z.string().min(1),
		phase: z.union([z.literal("interactive"), z.literal("processing")]),
		destinationPathPrefix: z.string().nullable(),
		/**
		 * The scopes the service is about to rely on. The checks below only ask whether every claimed
		 * scope is still in the grant's live set and still allowed to the member behind it, so this claim
		 * can refuse a call but never widen one. It catches a service asserting a scope it never held, a
		 * service still acting on a stale exchange response, and a member who lost the permission the
		 * scope needs, before it starts the work that scope was for.
		 */
		scopes: z.array(z.union([z.literal("plugin_data:read"), z.literal("plugin_data:write"), z.literal("files:write")])),
	})
	.strict();

export type plugins_service_http_verify_live_Body = z.infer<typeof verify_live_body_validator>;

/**
 * Which workspace content permission the member behind the grant needs for each claimed scope.
 *
 * `REQUIRED_APP_PERMISSION_BY_SCOPE` in `public_api_http_auth.ts` says the same thing for these
 * scopes, and `public_api_resolve_live_principal` applies it to a service grant on every `/api/v1/*`
 * route the grant can reach, before that route does the work. Keep the two in step. A scope this map
 * calls readable while that one calls it writable is answered 200 here and `Permission denied` at
 * the very call the service asked about.
 *
 * That check skips one kind of caller, and it does so deliberately: a `plugin_run` principal. A run
 * has no user of its own, so its principal carries no `contentPermissions` for the check to read.
 * Narrower rules bound it instead. It may download only the upload that started it, and it may write
 * only next to that file. Its plugin-document calls are judged too, with the content permission of
 * the person whose upload started it, by `db_authorize` in `plugins_data.ts`, inside the same
 * transaction as the read or write. A service grant is not skipped, so what this map asks for here
 * is what the grant really meets later.
 */
const REQUIRED_CONTENT_PERMISSION_BY_SCOPE = {
	"plugin_data:read": "read",
	"plugin_data:write": "write",
	"files:write": "write",
} as const satisfies Record<plugins_service_http_verify_live_Body["scopes"][number], "read" | "write">;

export async function plugins_service_http_verify_live(ctx: ActionCtx, request: Request) {
	const auth = await authorize_council_service_request(ctx, request, {
		tokenRegex: public_api_PLUGIN_SERVICE_TOKEN_REGEX,
		bodyValidator: verify_live_body_validator,
	});
	if (auth._nay) {
		if (auth._nay.message === "Unauthorized") {
			return { status: 401, body: { message: auth._nay.message } } as const;
		}
		return { status: 400, body: { message: auth._nay.message } } as const;
	}

	const principal = auth._yay.principal;
	if (principal.kind !== "plugin_service") {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const now = Date.now();
	if (principal.expiresAt <= now) {
		return { status: 401, body: { message: "Unauthorized" } } as const;
	}

	const expected = auth._yay.body;
	if (expected.installationId !== String(principal.installationId)) {
		return { status: 409, body: { message: "This grant is for another installation" } } as const;
	}
	if (expected.phase !== principal.phase) {
		return { status: 409, body: { message: "This grant is in another phase" } } as const;
	}
	// Compared exactly. The mint stored a normalized path, so a service that sends `/Meetings/` for a
	// grant that says `/Meetings` is refused. `seal-processing` above validates a real prefix and
	// stores it, so a processing grant always carries one. The service must send back the value it
	// was given, never one it rebuilt from a meeting title.
	if (expected.destinationPathPrefix !== principal.pathPrefix) {
		return { status: 409, body: { message: "This grant writes to another destination" } } as const;
	}
	const liveScopes: readonly string[] = principal.scopes;
	if (expected.scopes.some((scope) => !liveScopes.includes(scope))) {
		return { status: 409, body: { message: "This grant no longer has the scopes it needs" } } as const;
	}
	// A scope the member behind the grant may no longer use is not a scope the service can rely on.
	// An admin can move that member to the `viewer` role while a meeting runs. The member stays in the
	// workspace, so every check above still passes, but `content.write` is gone and the `/api/v1/*`
	// doors refuse `plugin_data:write` and `files:write` from then on. Without this the host answers
	// 200 to the question the service asks before it starts recording, and the meeting fails on the
	// upload after everyone left.
	if (expected.scopes.some((scope) => !principal.contentPermissions[REQUIRED_CONTENT_PERMISSION_BY_SCOPE[scope]])) {
		return {
			status: 409,
			body: { message: "This grant's member can no longer use the scopes it needs" },
		} as const;
	}

	return {
		status: 200,
		body: {
			installationId: String(principal.installationId),
			phase: principal.phase,
			// Already narrowed to what the installation still accepts. A call is checked again anyway,
			// so this says what the grant may attempt, not what it is guaranteed to be allowed.
			scopes: principal.scopes,
			destinationPathPrefix: principal.pathPrefix,
			expiresAt: principal.expiresAt,
			// What the member behind the grant may still do with workspace content. Reported so the
			// service can stop before a meeting instead of failing on the write at the end of one.
			contentPermissions: principal.contentPermissions,
		},
	} as const;
}

// #endregion verify live
