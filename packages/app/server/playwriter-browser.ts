import { Result } from "common/errors-as-values-utils.ts";
import { playwriter_browser_response_schema } from "common/playwriter-browser.ts";

const ROUTES = [
	"connect",
	"recover",
	"reconnect",
	"confirm",
	"status",
	"pause",
	"resume",
	"disconnect",
	"agent-access",
	"run",
	"command-status",
	"command-fence",
	"command-ack",
] as const;

export async function playwriter_runner_call(args: {
	route: (typeof ROUTES)[number];
	body: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}) {
	const cleanup =
		args.route === "status" ||
		args.route === "pause" ||
		args.route === "agent-access" ||
		args.route === "disconnect" ||
		args.route === "command-status" ||
		args.route === "command-fence" ||
		args.route === "command-ack";
	if (
		!cleanup &&
		(process.env.AI_CHAT_BROWSER_ENABLED !== "true" || process.env.AI_CHAT_PLAYWRITER_ENABLED !== "true")
	) {
		return Result({ _nay: { message: "Browser unavailable", name: "unavailable" } });
	}
	const url = process.env.BROWSER_RUNNER_URL;
	const secret = process.env.BROWSER_RUNNER_SECRET;
	if (!url || !secret) {
		return Result({ _nay: { message: "Browser unavailable", name: "unavailable" } });
	}
	const timeout = AbortSignal.timeout(args.timeoutMs ?? (args.route === "run" ? 35_000 : 20_000));
	const signal = args.signal ? AbortSignal.any([timeout, args.signal]) : timeout;
	try {
		const response = await fetch(`${url.replace(/\/$/, "")}/internal/playwriter/${args.route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
			body: JSON.stringify(args.body),
			signal,
		});
		const reader = response.body?.getReader();
		if (!reader) {
			return Result({ _nay: { message: "Browser returned an invalid response", name: "invalid_response" } });
		}
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			// A run reply can carry 8 MiB of script files as base64, about 11 MiB, plus the text output.
			if (bytes > 16 * 1024 * 1024) {
				await reader.cancel();
				return Result({ _nay: { message: "Browser response exceeded its limit", name: "invalid_response" } });
			}
			text += decoder.decode(next.value, { stream: true });
		}
		text += decoder.decode();
		const json: unknown = JSON.parse(text);
		const parsed = playwriter_browser_response_schema.safeParse(json);
		if (!parsed.success) {
			return Result({ _nay: { message: "Browser returned an invalid response", name: "invalid_response" } });
		}
		if (!parsed.data.ok) {
			return Result({ _nay: { message: "Browser request refused", name: parsed.data.error.code } });
		}
		if (!response.ok) {
			return Result({ _nay: { message: "Browser request failed", name: "transport" } });
		}
		return Result({ _yay: parsed.data });
	} catch {
		return Result({ _nay: { message: "Browser request failed", name: "transport" } });
	}
}
