import { Result } from "common/errors-as-values-utils.ts";
import z from "zod";
import { internal } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { files_browser_sync_browser_session_Result } from "../convex/files_browser.ts";

// Server-only HTTP client for the trusted browser runner Worker.
//
// Convex actions call the runner through this module. The runner secret and URL stay here, on the
// server: they never reach the browser bundle or model code. Responses are validated before any
// field is used; transport failures become stable `_nay` messages, never raw error text.

const files_browser_runner_error_schema = z.object({
	ok: z.literal(false),
	error: z.object({ code: z.string(), message: z.string().optional() }),
});

const files_browser_runner_ok_schema = z.object({
	ok: z.literal(true),
});

const runner_control_schema = z.enum(["starting", "ready", "agent", "human", "pausing", "closing", "closed"]);

export const files_browser_runner_session_schema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("file"),
		sessionId: z.string(),
		nodeId: z.string(),
		navGen: z.number().int().nonnegative(),
		loadGen: z.number().int().positive(),
		controlGen: z.number().int().positive(),
		control: runner_control_schema,
		sourceKind: z.enum(["saved", "proposed", "draft"]),
		sourceVersion: z.string(),
		sourceHash: z.string(),
		idleUntil: z.number(),
		totalUntil: z.number(),
	}),
	z.object({
		mode: z.literal("web"),
		sessionId: z.string(),
		navGen: z.literal(1),
		loadGen: z.number().int().nonnegative(),
		controlGen: z.number().int().positive(),
		control: runner_control_schema,
		agentAccess: z.boolean(),
		idleUntil: z.number(),
		totalUntil: z.number(),
	}),
]);

/**
 * The runner's receipt for one closed session: its real provider start and end times. It exists
 * only when a provider browser was acquired. Convex bills from it once.
 */
export const files_browser_runner_usage_schema = z.object({
	providerAcquiredAt: z.number(),
	endedAt: z.number(),
	reason: z.string(),
});

export const files_browser_RUNNER_ROUTES = [
	"open",
	"status",
	"reload",
	"run",
	"close",
	"keep-open",
	"viewer-grant",
	"viewer-renew",
	"control-take",
	"control-resume",
	"agent-access",
	"profile-summary",
	"profile-clear",
	"profile-delete",
	"download-info",
	"download-push",
	"upload-fill",
	"upload-grant",
] as const;

export type files_browser_RunnerRoute = (typeof files_browser_RUNNER_ROUTES)[number];

const ROUTE_TIMEOUTS_MS: Record<files_browser_RunnerRoute, number> = {
	open: 120_000,
	status: 30_000,
	reload: 60_000,
	run: 90_000,
	close: 60_000,
	"keep-open": 30_000,
	"viewer-grant": 30_000,
	"viewer-renew": 30_000,
	"control-take": 30_000,
	"control-resume": 30_000,
	"agent-access": 30_000,
	"profile-summary": 30_000,
	"profile-clear": 30_000,
	// A wipe may close a live session first.
	"profile-delete": 60_000,
	"download-info": 30_000,
	// The runner uploads up to 25 MiB to R2 before it replies.
	"download-push": 90_000,
	// The runner downloads up to 20 MiB from R2 before it fills the page. It gives the whole fill
	// 120 seconds, so wait a bit longer than that.
	"upload-fill": 150_000,
	"upload-grant": 30_000,
};

function runner_config(route: files_browser_RunnerRoute | null): { url: string; secret: string } | null {
	// Feature-gate at call time so deployments without the browser rollout keep working. Wipes of
	// deleted saved logins still reach the runner while the flag is off. The runner accepts them then.
	if (process.env.AI_CHAT_BROWSER_ENABLED !== "true" && route !== "profile-delete") return null;
	const url = process.env.BROWSER_RUNNER_URL;
	const secret = process.env.BROWSER_RUNNER_SECRET;
	if (!url || !secret) return null;
	return { url: url.replace(/\/$/u, ""), secret };
}

/**
 * The runner's viewer socket URL for the app. The SPA opens this after a grant; the grant
 * itself stays the only credential, and the URL carries none.
 */
export function files_browser_runner_viewer_url(): string | null {
	const config = runner_config(null);
	if (!config) return null;
	return `${config.url.replace(/^http/u, "ws")}/viewer/stream`;
}

/**
 * The runner URL where the app PUTs one computer file for an open file chooser. The grant id is
 * the only credential. The client adds the `name` param.
 */
export function files_browser_runner_upload_url(args: {
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	grantId: string;
}): string | null {
	const config = runner_config(null);
	if (!config) return null;
	const url = new URL(`${config.url}/viewer/upload`);
	url.searchParams.set("ownerId", args.ownerId);
	url.searchParams.set("organizationId", args.organizationId);
	url.searchParams.set("workspaceId", args.workspaceId);
	url.searchParams.set("grantId", args.grantId);
	return url.toString();
}

/**
 * Call one runner route. A runner refusal keeps its error code in `_nay.name` (for example
 * `busy_command` or `address_blocked`), so callers can branch on it. The code is not secret, and
 * `name` is part of the normal `_nay` shape, so doors may return this `_nay` as it is.
 */
export async function files_browser_runner_call(args: {
	route: files_browser_RunnerRoute;
	body: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<
	| { _yay: unknown; _nay?: never }
	| { _yay?: never; _nay: { message: string; name?: string } }
> {
	const config = runner_config(args.route);
	if (!config) {
		return Result({ _nay: { message: "Browser unavailable" } });
	}

	const timeout = AbortSignal.timeout(args.timeoutMs ?? ROUTE_TIMEOUTS_MS[args.route]);
	const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(`${config.url}/internal/browser/${args.route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
			signal,
			body: JSON.stringify(args.body),
		});
	} catch {
		args.signal?.throwIfAborted();
		return Result({
			_nay: {
				message: "Browser request failed",
			},
		});
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch {
		return Result({ _nay: { message: "Browser returned an invalid response" } });
	}

	if (!response.ok) {
		const parsed = files_browser_runner_error_schema.safeParse(json);
		if (parsed.success && parsed.data.error.message) {
			return Result({ _nay: { message: parsed.data.error.message, name: parsed.data.error.code } });
		}
		return Result({ _nay: { message: `Browser request failed (${response.status})` } });
	}

	const ok = files_browser_runner_ok_schema.safeParse(json);
	if (!ok.success) {
		const failed = files_browser_runner_error_schema.safeParse(json);
		if (failed.success) {
			return Result({
				_nay: { message: failed.data.error.message || "Browser request failed", name: failed.data.error.code },
			});
		}
		return Result({ _nay: { message: "Browser returned an invalid response" } });
	}

	return Result({ _yay: json });
}

// `profileStored` says only whether saved cookie bytes remain in the runner.
export const files_browser_runner_status_schema = z.discriminatedUnion("alive", [
	z.object({
		ok: z.literal(true),
		alive: z.literal(false),
		closing: z.boolean(),
		usage: files_browser_runner_usage_schema.nullable(),
		profileStored: z.boolean(),
	}),
	z.object({
		ok: z.literal(true),
		alive: z.literal(true),
		session: files_browser_runner_session_schema,
		profileStored: z.boolean(),
	}),
]);

/**
 * Refresh live metadata without extending the runner's idle deadline.
 * The explicit return type breaks a cycle through Convex's generated API.
 */
export async function files_browser_refresh_session(ctx: ActionCtx, session: Doc<"files_browser_sessions">): Promise<
	| { _yay: Doc<"files_browser_sessions"> | null; _nay?: never }
	| { _yay?: never; _nay: { message: string; name?: string } }
> {
	if (!session.runnerSessionId || session.control === "closing" || session.control === "closed") {
		return Result({ _yay: null });
	}
	const checked = await files_browser_runner_call({
		route: "status",
		body: {
			sessionId: session.runnerSessionId,
			ownerId: session.ownerId,
			organizationId: session.organizationId,
			workspaceId: session.workspaceId,
		},
	});
	if (checked._nay) return checked;
	const parsed = files_browser_runner_status_schema.safeParse(checked._yay);
	if (!parsed.success) return Result({ _nay: { message: "Browser request failed" } });
	// Input can extend the runner deadline before the app has seen it. Only confirmed loss closes the doc.
	if (!parsed.data.alive) {
		// The runner is still closing the provider browser, so its end time is not known yet.
		// Keep the doc as it is; the next check or the settle cron finishes it.
		if (parsed.data.closing) {
			return Result({ _nay: { message: "Browser is closing" } });
		}
		await ctx.runMutation(internal.files_browser.settle_browser_usage, {
			sessionId: session._id,
			usage: parsed.data.usage,
		});
		return Result({ _yay: null });
	}
	return (await ctx.runMutation(internal.files_browser.sync_browser_session, {
		sessionId: session._id,
		runner: parsed.data.session,
	})) as files_browser_sync_browser_session_Result;
}
