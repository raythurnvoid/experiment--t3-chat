import { Result } from "common/errors-as-values-utils.ts";
import z from "zod";

// Server-only HTTP client for the trusted browser runner Worker.
//
// Convex actions call the runner through this module. The runner secret and URL stay here, on the
// server: they never reach the browser bundle or model code. Responses are validated before any
// field is used; transport failures become stable `_nay` messages, never raw error text.

const files_browser_runner_error_schema = z.object({
	ok: z.literal(false),
	error: z.object({ code: z.string(), message: z.string() }),
});

const files_browser_runner_ok_schema = z.object({
	ok: z.literal(true),
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
};

function runner_config(): { url: string; secret: string } | null {
	// Feature-gate at call time so deployments without the browser rollout keep working.
	if (process.env.AI_CHAT_BROWSER_ENABLED !== "true") return null;
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
	const config = runner_config();
	if (!config) return null;
	return `${config.url.replace(/^http/u, "ws")}/viewer/stream`;
}

export async function files_browser_runner_call(args: {
	route: files_browser_RunnerRoute;
	body: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<
	| { _yay: unknown; _nay?: never }
	| { _yay?: never; _nay: { message: string } }
> {
	const config = runner_config();
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
			return Result({ _nay: { message: parsed.data.error.message } });
		}
		return Result({ _nay: { message: `Browser request failed (${response.status})` } });
	}

	const ok = files_browser_runner_ok_schema.safeParse(json);
	if (!ok.success) {
		const failed = files_browser_runner_error_schema.safeParse(json);
		if (failed.success) {
			return Result({ _nay: { message: failed.data.error.message } });
		}
		return Result({ _nay: { message: "Browser returned an invalid response" } });
	}

	return Result({ _yay: json });
}
