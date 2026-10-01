import { defineCommand, type Command } from "just-bash/browser";
import z from "zod";
import type { Infer } from "convex/values";
import type { PlaywriterBrowserScriptOutput } from "common/playwriter-browser.ts";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { internal } from "../convex/_generated/api.js";
import type { ai_chat_browser_resource_validator, ai_chat_browser_source_validator } from "../convex/schema.ts";
import { ai_chat_files_browser_resource_key } from "../convex/ai_chat_files.ts";
import type { browser_Intent } from "../shared/browser-intent.ts";
import {
	files_get_normalized_node_path_segments,
	files_normalize_browser_download_name,
	files_normalize_content_type,
} from "../shared/files.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import {
	files_browser_refresh_session,
	files_browser_runner_call,
	files_browser_runner_session_schema,
} from "./files-browser.ts";
import {
	files_ingestion_decode_base64,
	files_ingestion_MAX_BASE64_CHARS,
	files_ingestion_write,
} from "./files-ingestion.ts";
import { playwriter_runner_call } from "./playwriter-browser.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_TIMED_OUT,
	bash_COMMAND_EXIT_USAGE,
	bash_decode_stdin_as_utf8,
} from "./bash-utils.ts";

/**
 * What the `browser` command knows about the chat call it runs in. Only a chat call with a browser
 * intent, a source user message, and a run gets one.
 */
export type bash_BrowserContext = {
	source: Infer<typeof ai_chat_browser_source_validator>;
	/**
	 * The web choice and settings revisions the user message was sent with. Every door checks them.
	 */
	browserIntent: browser_Intent;
	/**
	 * The chat run. Its doc holds the browser state of this turn. A job uses the run that started it.
	 */
	run: { runId: Id<"ai_chat_runs">; generation: number };
	/**
	 * Only Agent mode may save emitted files and downloads.
	 */
	canWriteFiles: boolean;
	invocationId: Id<"ai_chat_bash_invocations">;
	/**
	 * The call's `transferDeadlineAt`. A run does not start when it could end after it.
	 */
	deadlineAt: number;
	signal: AbortSignal;
	/**
	 * The per-call command counter shared with transfer receipts and job launches.
	 */
	nextCommandNumber: () => number;
};

type BrowserResource = Infer<typeof ai_chat_browser_resource_validator>;
type CloudResource = Extract<BrowserResource, { provider: "cloud" }>;
type PlaywriterResource = Extract<BrowserResource, { provider: "playwriter" }>;

type BrowserReason = keyof typeof REFUSAL_TEXT;

const USAGE = `Usage:
  browser status                          Show the web browser and file preview this chat can use.
  browser open [URL]                      Open or reuse the web browser. The cloud browser may start at URL.
  browser open --file PATH [--source saved|proposed|draft]
                                          Open an app HTML file in the cloud file preview.
  browser tabs                            List cloud web tabs.
  browser tab new [URL]                   Open a cloud web tab.
  browser tab close TAB                   Close a cloud web tab.
  browser run [--tab TAB | --file] [-e CODE]
                                          Run Playwright code. Without -e the code is read from stdin.
  browser reload [--tab TAB | --file]     Reload a cloud tab or the file preview.
  browser close [--file]                  End the cloud browser, or stop automation of My browser.

The code is an async function body. It gets page, frame (file preview only), expect, emitFile and state.
console.log lines and the return value print on stdout. Page console lines, page errors and state
warnings print on stderr. state keeps JSON data between runs of this chat while the browser stays open.
In Agent mode emitFile({workspace: "current" | "personal", path, bytes, contentType?}) saves a pending
file, for example a screenshot: emitFile({workspace: "current", path: "/reports/page.png", bytes: await
page.screenshot(), contentType: "image/png"}). Then use view_image to look at it. TAB is the
8-character id that status, open, tabs and tab new print. --tab may be left out when this turn knows
only one tab.
Exit codes: 0 success, 1 failure or refusal, 2 usage error, 124 time limit.
`;

/**
 * Fixed text for each failure. The model must not retry `stale` or `unknown`.
 */
const REFUSAL_TEXT = {
	stale:
		"the browser changed since this chat last used it (a person used it, or it was paused, turned off or closed). Browser access ended for this turn. Do not retry. Tell the user.",
	unknown: "the result is unknown, and the action may have run. Do not repeat it. Tell the user what is uncertain.",
	busy: "another chat is using the browser. Try again later.",
	agent_access_off: "the user turned off agent access to this browser.",
	agent_blocked_site: "this site is on the list of sites the agent may not use.",
	limit: "this turn used all 20 browser operations.",
	session_limit: "the shared browser session reached its limit. Ask the user to reconnect it in Browser settings.",
	agent_required: "saving files needs Agent mode. Nothing was saved.",
	unavailable: "no browser is available for this command. Run: browser status",
	stopped: "the chat turn was stopped or has ended. This command did not run.",
	needs_capture: "the file preview shows an editor draft. Ask the user to capture the draft again first.",
	time: "this Bash call has too little time left to start a browser command. Run it in a new Bash call.",
	execution: "the browser command could not finish.",
	invalid_result: "the browser returned output that could not be read.",
	not_started: "the browser did not start this command.",
} as const;

const CODE_MAX_CHARS = 20_000;
const RUN_TIME_MS = 30_000;
const STDOUT_MAX_CHARS = 100_000;
const STDERR_MAX_CHARS = 20_000;
const TAB_ID_PRINT_CHARS = 8;

const run_schema = z.object({
	ok: z.literal(true),
	status: z.enum(["succeeded", "errored", "timed_out", "tainted", "refused"]),
	commandId: z.string(),
	codeHash: z.string(),
	elapsedMs: z.number(),
	result: z.unknown(),
	resultTruncated: z.boolean(),
	// Files the snippet asked to create. Base64 turns every 3 bytes into 4 characters, so this cap
	// refuses an oversized string before anything decodes it.
	files: z
		.array(
			z
				.object({
					workspace: z.enum(["current", "personal"]),
					path: z.string().min(1).max(1024),
					contentType: z.string().min(1).max(255).optional(),
					dataBase64: z.string().max(files_ingestion_MAX_BASE64_CHARS),
				})
				.strict(),
		)
		.max(8),
	// Files the page downloaded during the command, with the raw name the page chose. The runner
	// keeps `files` and `downloads` together within 8 items and 8 MiB. Only a succeeded run
	// carries `downloads`; the runner drops the downloads of any other run.
	downloads: z
		.array(
			z
				.object({
					name: z.string().max(255),
					contentType: z.string().max(255),
					dataBase64: z.string().max(files_ingestion_MAX_BASE64_CHARS),
				})
				.strict(),
		)
		.max(8)
		.optional(),
	// Downloads over the shared limit that the runner dropped. Omitted when 0.
	downloadsDropped: z.number().int().positive().optional(),
	consoleEntries: z.array(z.string()),
	pageErrors: z.array(z.string()),
	logs: z.array(z.string()),
	logsTruncated: z.boolean(),
	// The parts of `state` the runner could not save, for example a page handle or a Date.
	stateWarnings: z.array(z.string()).optional(),
	error: z.unknown(),
	session: files_browser_runner_session_schema.optional(),
});

function refuse(reason: BrowserReason, prefix = "") {
	return { stdout: prefix, stderr: `browser: ${REFUSAL_TEXT[reason]}\n`, exitCode: bash_COMMAND_EXIT_FAILURE };
}

function usage_error(text: string) {
	return { stdout: "", stderr: `browser: ${text}\n${USAGE}`, exitCode: bash_COMMAND_EXIT_USAGE };
}

/**
 * Map a door or runner refusal name to the fixed text the model sees.
 */
function safe_reason(name: string | undefined | null): BrowserReason {
	if (name === "outcome_unknown" || name === "unknown") return "unknown";
	if (name === "blocked_site" || name === "agent_blocked_site") return "agent_blocked_site";
	if (name === "busy_command" || name === "busy") return "busy";
	if (name === "stale" || name === "stale_observation" || name === "stale_lease" || name === "stale_command")
		return "stale";
	if (name === "agent_access_off" || name === "limit" || name === "needs_capture" || name === "unavailable")
		return name;
	return "execution";
}

// Remove values that must never persist in chat history: inline images and protocol markers.
function redact(text: string) {
	return text
		.replace(/data:image\/[a-zA-Z0-9+;,=_-]+/g, "[redacted image]")
		.replace(/\[browser-source:/g, "[redacted source:")
		.replace(/\[file-read:/g, "[redacted file:");
}

function cap(text: string, max: number) {
	return text.length <= max ? text : `${text.slice(0, max)}\n[output truncated]\n`;
}

function short_tab_id(tabId: string) {
	return tabId.slice(0, TAB_ID_PRINT_CHARS);
}

/**
 * Print one run the same way for both browsers. stdout holds the snippet's own `console.log` lines
 * and its return value, so `| jq` reads only what the snippet produced.
 */
function print_run(run: {
	resultText: string | null;
	resultTruncated: boolean;
	logs: string[];
	logsTruncated: boolean;
	consoleEntries: string[];
	pageErrors: string[];
	stateWarnings: string[];
	errorText: string | null;
	notes: string[];
}) {
	let stdout = run.logs.map((line) => `${line}\n`).join("");
	if (run.logsTruncated) stdout += "[logs truncated]\n";
	if (run.resultText !== null) stdout += `${run.resultText}\n`;
	if (run.resultTruncated) stdout += "[result truncated]\n";

	let stderr = "";
	for (const entry of run.consoleEntries.slice(0, 50)) stderr += `[console] ${entry.slice(0, 2000)}\n`;
	for (const entry of run.pageErrors.slice(0, 50)) stderr += `[page error] ${entry.slice(0, 2000)}\n`;
	for (const entry of run.stateWarnings.slice(0, 20)) stderr += `[state] ${entry}\n`;
	if (run.errorText) stderr += `Error: ${run.errorText.slice(0, 1000)}\n`;
	for (const note of run.notes) stderr += `browser: ${note}\n`;

	return { stdout: cap(redact(stdout), STDOUT_MAX_CHARS), stderr: cap(redact(stderr), STDERR_MAX_CHARS) };
}

function cloud_lease(binding: CloudResource, browser: bash_BrowserContext) {
	return {
		controlGen: binding.controlGen,
		loadGen: binding.loadGen,
		navGen: binding.navGen,
		...(binding.mode === "web"
			? {
					tabId: binding.tabId!,
					tabGen: binding.tabGen!,
					policyRevision: browser.browserIntent.policyRevision,
					selectionRevision: browser.browserIntent.selectionRevision,
				}
			: {}),
	};
}

async function update_turn(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	change:
		| { kind: "claim" }
		| { kind: "bind"; bindings: BrowserResource[]; ifAbsent: boolean }
		| { kind: "unbind"; keys: string[] }
		| { kind: "revoke" },
) {
	return ctx.runMutation(internal.ai_chat_files.update_browser_turn, {
		run: browser.run,
		userId: browser.source.userId,
		change,
	});
}

/**
 * Whether the browser still has exactly the lease this turn learned.
 */
async function binding_current(ctx: ActionCtx, browser: bash_BrowserContext, binding: BrowserResource) {
	const allowed = await ctx.runQuery(internal.files_browser.check_browser_source, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		...(binding.provider === "cloud" ? { mode: binding.mode } : {}),
	});
	if (allowed._nay) return false;
	if (binding.provider === "playwriter") {
		const lease = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
			source: browser.source,
			browserIntent: browser.browserIntent,
		});
		return (
			!lease._nay &&
			lease._yay.connectionId === binding.connectionId &&
			lease._yay.connectionGeneration === binding.connectionGeneration &&
			lease._yay.controlRevision === binding.controlRevision &&
			lease._yay.targetRevision === binding.targetRevision &&
			lease._yay.navRevision === binding.navRevision &&
			lease._yay.confirmedTargetHandle === binding.confirmedTargetHandle
		);
	}
	const access = await ctx.runQuery(internal.files_browser.check_browser_session_access, {
		organizationId: browser.source.organizationId,
		workspaceId: browser.source.workspaceId,
		userId: browser.source.userId,
		membershipId: browser.source.membershipId,
		sessionId: binding.sessionId,
		...(binding.mode === "web" ? { tabId: binding.tabId! } : {}),
	});
	return (
		access.ok &&
		access.control === "ready" &&
		access.controlGen === binding.controlGen &&
		access.loadGen === binding.loadGen &&
		access.navGen === binding.navGen &&
		(binding.mode === "file" || (access.mode === "web" && access.tabGen === binding.tabGen))
	);
}

/**
 * Check every binding of this turn before a command. A live lease is never silently rebound: a
 * change by a person ends browser access for the turn. Returns the bindings to keep, or null after
 * revoking the turn.
 */
async function check_bindings(ctx: ActionCtx, browser: bash_BrowserContext, bindings: BrowserResource[]) {
	const checked: BrowserResource[] = [];
	const refreshed = new Set<string>();
	for (const binding of bindings) {
		const ref = binding.provider === "playwriter" ? binding.connectionId : binding.sessionId;
		if (!refreshed.has(ref)) {
			refreshed.add(ref);
			if (binding.provider === "cloud") {
				const loaded = await ctx.runQuery(internal.files_browser.load_browser_session, {
					organizationId: browser.source.organizationId,
					workspaceId: browser.source.workspaceId,
					userId: browser.source.userId,
					membershipId: browser.source.membershipId,
					sessionId: binding.sessionId,
				});
				if (loaded._nay || (await files_browser_refresh_session(ctx, loaded._yay))._nay) return null;
			} else {
				const loaded = await ctx.runQuery(internal.playwriter_browser.load_connection, {
					connectionId: binding.connectionId,
					userId: browser.source.userId,
					membershipId: browser.source.membershipId,
				});
				if (loaded._nay) return null;

				const connection = loaded._yay;
				const status = await playwriter_runner_call({
					route: "status",
					timeoutMs: 5_000,
					body: {
						connectionId: connection._id,
						ownerId: connection.ownerId,
						organizationId: connection.organizationId,
						workspaceId: connection.workspaceId,
					},
				});
				// A dropped socket to the same confirmed tab may reconnect. The new lease must keep the
				// same control and target, so nothing a person did is adopted.
				if (
					status._nay?.name === "transport" ||
					(!status._nay && (status._yay.runtime.state === "failed" || status._yay.runtime.state === "disconnected"))
				) {
					const recovered = await ctx.runAction(internal.playwriter_browser.recover_for_source, {
						source: browser.source,
						browserIntent: browser.browserIntent,
						resource: binding,
					});
					if (recovered._nay) return null;

					const lease = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
						source: browser.source,
						browserIntent: browser.browserIntent,
					});
					if (
						lease._nay ||
						lease._yay.controlRevision !== binding.controlRevision ||
						lease._yay.confirmedTargetHandle !== binding.confirmedTargetHandle
					)
						return null;

					checked.push(lease._yay);
					continue;
				}

				if (
					status._nay ||
					!(await ctx.runMutation(internal.playwriter_browser.commit_runtime, {
						connectionId: connection._id,
						attemptId: connection.connectAttemptId,
						expectedControlRevision: connection.controlRevision,
						runtime: status._yay.runtime,
					}))
				)
					return null;
			}
		}

		if (!(await binding_current(ctx, browser, binding))) return null;
		checked.push(binding);
	}
	return checked;
}

/**
 * Count one turn operation and write the call's durable receipt. Each operation gets its own call id
 * inside this Bash call, so a replayed Bash call never runs a browser action twice.
 */
async function claim(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	args: {
		operationHash: string;
		resource: BrowserResource | null;
		operationKind?: "run";
		mode?: "file";
	},
) {
	const claimed = await update_turn(ctx, browser, { kind: "claim" });
	if (claimed._nay) return { _nay: turn_reason(claimed._nay.name) };

	const toolCallId = `${browser.invocationId}:browser:${browser.nextCommandNumber()}`;
	const begun = await ctx.runMutation(internal.ai_chat_files.begin_browser_invocation, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		toolCallId,
		operationHash: args.operationHash,
		resource: args.resource,
		run: browser.run,
		// Runs must fit the runner's short command deadline.
		timeoutMs: args.resource?.provider === "playwriter" || args.operationKind === "run" ? RUN_TIME_MS : 120_000,
		...(args.operationKind ? { operationKind: args.operationKind } : {}),
		...(args.mode ? { mode: args.mode } : {}),
	});
	// A begin refusal means the saved choice, access, or lease changed, or the chat was stopped.
	if (begun._nay) return { _nay: begun._nay.message.startsWith("Stopped") ? ("stopped" as const) : ("stale" as const) };
	return { _yay: { ...begun._yay, toolCallId, operationHash: args.operationHash } };
}

/**
 * Map a refusal of `update_browser_turn` to its fixed text.
 */
function turn_reason(name: string | undefined): BrowserReason {
	return name === "stopped" ? "stopped" : name === "limit" ? "limit" : "stale";
}

async function finish(
	ctx: ActionCtx,
	invocation: { invocationId: Id<"ai_chat_browser_invocations">; commandId: string; operationHash: string },
	status: "succeeded" | "errored" | "cancelled",
	reason: string | null,
	resource?: BrowserResource,
) {
	await ctx.runMutation(internal.ai_chat_files.finish_browser_invocation, {
		invocationId: invocation.invocationId,
		commandId: invocation.commandId,
		operationHash: invocation.operationHash,
		result: { status, reason },
		...(resource ? { resource } : {}),
	});
}

/**
 * Pick the binding a command acts on. A turn that has none for the target binds the live session,
 * like `browser status` would: there is no older lease for a person's change to replace.
 */
async function target_binding(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	bindings: BrowserResource[],
	target: { file: boolean; tab: string | null },
) {
	const matching = (items: BrowserResource[]) =>
		items.filter((item) =>
			target.file
				? item.provider === "cloud" && item.mode === "file"
				: browser.browserIntent.webChoice.provider === "playwriter"
					? item.provider === "playwriter"
					: item.provider === "cloud" && item.mode === "web",
		);

	let candidates = matching(bindings);
	if (candidates.length === 0) {
		const live = await live_resources(ctx, browser);
		candidates = matching(live);
		if (candidates.length > 0) {
			const bound = await update_turn(ctx, browser, { kind: "bind", bindings: candidates, ifAbsent: true });
			if (bound._nay) return { _nay: "stale" as const };
		}
	}

	if (target.tab !== null) {
		const tab = target.tab;
		const found = candidates.filter((item) => item.provider === "cloud" && item.tabId?.startsWith(tab));
		if (found.length !== 1)
			return { _nay: "usage" as const, text: `unknown tab ${tab}. Run browser tabs to list the tabs.` };
		return { _yay: found[0]! };
	}
	if (candidates.length === 0) return { _nay: "none" as const };
	if (candidates.length > 1)
		return {
			_nay: "usage" as const,
			text: `this turn knows ${candidates.length} tabs. Name one with --tab: ${candidates
				.map((item) => (item.provider === "cloud" && item.tabId ? short_tab_id(item.tabId) : ""))
				.join(", ")}.`,
		};
	return { _yay: candidates[0]! };
}

/**
 * The live sessions this chat may use now: the cloud catalog plus the confirmed shared tab.
 */
async function live_resources(ctx: ActionCtx, browser: bash_BrowserContext) {
	const resources: BrowserResource[] = [];
	const catalog = await ctx.runQuery(internal.files_browser.get_agent_browser_catalog, {
		source: browser.source,
		browserIntent: browser.browserIntent,
	});
	if (!catalog._nay) for (const item of catalog._yay.browsers) resources.push(item.resource);
	if (browser.browserIntent.webChoice.provider === "playwriter") {
		const remote = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
			source: browser.source,
			browserIntent: browser.browserIntent,
		});
		if (!remote._nay) resources.push(remote._yay);
	}
	return resources;
}

async function command_status(ctx: ActionCtx, browser: bash_BrowserContext) {
	const catalog = await ctx.runQuery(internal.files_browser.get_agent_browser_catalog, {
		source: browser.source,
		browserIntent: browser.browserIntent,
	});
	const resources = catalog._nay ? [] : catalog._yay.browsers.map((item) => item.resource);

	const provider = browser.browserIntent.webChoice.provider;
	let web: string;
	if (provider === "none") web = "web: off. The user has not chosen a web browser.";
	else if (provider === "playwriter") {
		const remote = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
			source: browser.source,
			browserIntent: browser.browserIntent,
		});
		if (remote._nay) web = `web: My browser (the user's shared tab), not ready (${remote._nay.name ?? "unavailable"}).`;
		else {
			resources.push(remote._yay);
			web = "web: My browser (the user's shared tab), ready. tabs, tab new and tab close do not apply.";
		}
	} else {
		const session = resources.find((item) => item.provider === "cloud" && item.mode === "web");
		web =
			session?.provider === "cloud" && session.tabId
				? `web: cloud browser open, tab ${short_tab_id(session.tabId)}. Run browser tabs to list every tab.`
				: "web: cloud browser not open. Run: browser open [URL]";
	}

	const fileSession = resources.find((item) => item.provider === "cloud" && item.mode === "file");
	let file = "file preview: none. Run: browser open --file PATH";
	if (fileSession?.provider === "cloud") {
		const loaded = await ctx.runQuery(internal.files_browser.load_browser_session, {
			organizationId: browser.source.organizationId,
			workspaceId: browser.source.workspaceId,
			userId: browser.source.userId,
			membershipId: browser.source.membershipId,
			sessionId: fileSession.sessionId,
		});
		file =
			!loaded._nay && loaded._yay.mode === "file"
				? `file preview: open, ${loaded._yay.path} (${loaded._yay.sourceKind}).`
				: "file preview: open.";
	}

	if (resources.length > 0) {
		const bound = await update_turn(ctx, browser, { kind: "bind", bindings: resources, ifAbsent: true });
		if (bound._nay) return refuse(turn_reason(bound._nay.name));
	}
	return { stdout: `${web}\n${file}\n`, stderr: "", exitCode: 0 };
}

async function command_open(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	input: { url: string | null; file: { path: string; sourceKind: "saved" | "proposed" | "draft" } | null },
) {
	const provider = browser.browserIntent.webChoice.provider;
	if (!input.file && provider === "playwriter" && input.url)
		return usage_error(`My browser keeps its one tab. Navigate inside a run: browser run -e 'await page.goto("URL")'`);

	const claimed = await claim(ctx, browser, {
		operationHash: await crypto_sha256_hex(`browser_open\n${JSON.stringify(input)}`),
		resource: null,
		...(input.file ? { mode: "file" as const } : {}),
	});
	if (claimed._nay) return refuse(claimed._nay);
	const invocation = claimed._yay;
	if (!invocation.isNew) return refuse("unknown");

	if (input.file) {
		const opened = await ctx.runAction(internal.files_browser.agent_open_file_browser, {
			source: browser.source,
			browserIntent: browser.browserIntent,
			operationId: invocation.commandId,
			operationDeadline: invocation.deadlineAt,
			toolCallId: invocation.toolCallId,
			path: input.file.path,
			sourceKind: input.file.sourceKind,
		});
		if (opened._nay) {
			const reason = safe_reason(opened._nay.name);
			await finish(ctx, invocation, "errored", reason);
			return refuse(reason);
		}
		const session = opened._yay.session;
		const binding: BrowserResource = {
			provider: "cloud",
			mode: "file",
			sessionId: session.sessionId,
			controlGen: session.controlGen,
			loadGen: session.loadGen,
			navGen: session.navigationGeneration,
			tabId: null,
			tabGen: null,
		};
		await finish(ctx, invocation, "succeeded", null, binding);
		await update_turn(ctx, browser, { kind: "bind", bindings: [binding], ifAbsent: false });
		return { stdout: `Opened the file preview of ${input.file.path}.\n`, stderr: "", exitCode: 0 };
	}

	if (provider === "playwriter") {
		let lease = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
			source: browser.source,
			browserIntent: browser.browserIntent,
		});
		if (lease._nay?.name === "offline") {
			const recovered = await ctx.runAction(internal.playwriter_browser.recover_for_source, {
				source: browser.source,
				browserIntent: browser.browserIntent,
			});
			if (recovered._nay) {
				const reason = safe_reason(recovered._nay.name);
				await finish(ctx, invocation, "errored", reason);
				return refuse(reason);
			}
			lease = await ctx.runQuery(internal.playwriter_browser.get_remote_lease, {
				source: browser.source,
				browserIntent: browser.browserIntent,
			});
		}
		if (lease._nay) {
			await finish(ctx, invocation, "errored", "unavailable");
			return refuse("unavailable");
		}
		const bound = await update_turn(ctx, browser, { kind: "bind", bindings: [lease._yay], ifAbsent: true });
		const binding = bound._nay
			? null
			: bound._yay.bindings.find((item) => ai_chat_files_browser_resource_key(item) === lease._yay.connectionId);
		if (!binding || !(await binding_current(ctx, browser, binding))) {
			await finish(ctx, invocation, "errored", "stale");
			await update_turn(ctx, browser, { kind: "revoke" });
			return refuse("stale");
		}
		await finish(ctx, invocation, "succeeded", null, binding);
		return { stdout: "My browser is ready: the user's shared tab.\n", stderr: "", exitCode: 0 };
	}

	const opened = await ctx.runAction(internal.files_browser.agent_open_browser, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		operationId: invocation.commandId,
		operationDeadline: invocation.deadlineAt,
		toolCallId: invocation.toolCallId,
		...(input.url ? { startUrl: input.url } : {}),
	});
	if (opened._nay) {
		const reason = safe_reason(opened._nay.name);
		await finish(ctx, invocation, "errored", reason);
		if (reason === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(reason);
	}
	const session = opened._yay.session;
	const binding: BrowserResource = {
		provider: "cloud",
		mode: "web",
		sessionId: session.sessionId,
		controlGen: session.controlGen,
		loadGen: session.loadGen,
		navGen: session.navigationGeneration,
		tabId: session.tabId,
		tabGen: session.tabGen,
	};
	await finish(ctx, invocation, "succeeded", null, binding);
	await update_turn(ctx, browser, { kind: "bind", bindings: [binding], ifAbsent: true });
	return { stdout: `Opened the cloud browser. Tab ${short_tab_id(session.tabId ?? "")}.\n`, stderr: "", exitCode: 0 };
}

async function command_tabs(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	bindings: BrowserResource[],
	input: { operation: "tabs" | "tab-new" | "tab-close"; url: string | null; tab: string | null },
) {
	if (browser.browserIntent.webChoice.provider !== "cloud")
		return {
			stdout: "",
			stderr: "browser: tabs work only in the cloud browser. My browser has one shared tab.\n",
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};

	// Any known tab of the web session carries the session lease that the tab doors check.
	let session = bindings.find((item) => item.provider === "cloud" && item.mode === "web");
	if (!session) {
		const target = await target_binding(ctx, browser, bindings, { file: false, tab: null });
		if (target._nay === "stale") return refuse("stale");
		session = target._yay;
	}
	if (session?.provider !== "cloud")
		return {
			stdout: "",
			stderr: "browser: no web browser is open. Run: browser open [URL]\n",
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};

	let closeTabId: string | null = null;
	if (input.operation === "tab-close") {
		const tab = input.tab!;
		const found = bindings.filter(
			(item) => item.provider === "cloud" && item.sessionId === session.sessionId && item.tabId?.startsWith(tab),
		);
		if (found.length !== 1 || found[0]!.provider !== "cloud")
			return usage_error(`unknown tab ${tab}. Run browser tabs to list the tabs.`);
		closeTabId = found[0]!.tabId;
	}

	const claimed = await claim(ctx, browser, {
		operationHash: await crypto_sha256_hex(`browser_${input.operation}\n${JSON.stringify(input)}`),
		resource: session,
	});
	if (claimed._nay) {
		if (claimed._nay === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(claimed._nay);
	}
	const invocation = claimed._yay;
	if (!invocation.isNew) return refuse("unknown");

	const result = await ctx.runAction(internal.files_browser.agent_browser_tabs, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		sessionId: session.sessionId,
		expectedAgentLease: cloud_lease(session, browser),
		operationId: invocation.commandId,
		operationDeadline: invocation.deadlineAt,
		toolCallId: invocation.toolCallId,
		operation: input.operation,
		...(closeTabId ? { tabId: closeTabId } : {}),
		...(input.url ? { url: input.url } : {}),
	});
	if (result._nay) {
		const reason = safe_reason(result._nay.name);
		await finish(ctx, invocation, "errored", reason);
		return refuse(reason);
	}
	if (result._yay.status !== "completed") {
		const reason =
			result._yay.status === "unknown" || result._yay.status === "in_progress"
				? "unknown"
				: safe_reason(result._yay.result.reason);
		await finish(ctx, invocation, "errored", reason);
		return refuse(reason);
	}

	const listed = result._yay.session;
	// Only this tab change may advance control. A person's Take or Resume ends the turn.
	if (listed && listed.controlGen !== session.controlGen + (input.operation === "tabs" ? 0 : 1)) {
		await finish(ctx, invocation, "errored", "stale");
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}

	// Move this session's bindings to the listing. A late listing must not undo a run that already
	// advanced another tab, so an older tab keeps its binding.
	const removeKeys: string[] = [];
	const put: BrowserResource[] = [];
	for (const previous of bindings) {
		if (previous.provider !== "cloud" || previous.sessionId !== session.sessionId) continue;
		const tab = result._yay.tabs.find((item) => item.tabId === previous.tabId);
		if (!tab || !listed) removeKeys.push(ai_chat_files_browser_resource_key(previous));
		else if (
			listed.controlGen === previous.controlGen &&
			(tab.tabGen < previous.tabGen! || tab.navGen < previous.navGen)
		)
			continue;
		else put.push({ ...previous, controlGen: listed.controlGen, tabGen: tab.tabGen, navGen: tab.navGen });
	}
	if (listed)
		for (const tab of result._yay.tabs)
			if (!put.some((item) => item.provider === "cloud" && item.tabId === tab.tabId))
				put.push({
					provider: "cloud",
					mode: "web",
					sessionId: listed.sessionId,
					controlGen: listed.controlGen,
					loadGen: listed.loadGen,
					navGen: tab.navGen,
					tabId: tab.tabId,
					tabGen: tab.tabGen,
				});
	await finish(ctx, invocation, "succeeded", null);
	if (removeKeys.length > 0) await update_turn(ctx, browser, { kind: "unbind", keys: removeKeys });
	if (put.length > 0) await update_turn(ctx, browser, { kind: "bind", bindings: put, ifAbsent: false });

	if (input.operation === "tab-new")
		return { stdout: `Opened tab ${short_tab_id(result._yay.result.tabId ?? "")}.\n`, stderr: "", exitCode: 0 };
	if (input.operation === "tab-close")
		return {
			stdout: listed
				? `Closed tab ${input.tab}.\n`
				: `Closed tab ${input.tab}. It was the last tab, so the cloud browser ended.\n`,
			stderr: "",
			exitCode: 0,
		};
	const lines = result._yay.tabs.map(
		(tab) =>
			`${short_tab_id(tab.tabId)}  ${tab.url}  ${tab.title}${tab.tabId === result._yay.viewedTabId ? "  (the user sees this tab)" : ""}\n`,
	);
	return { stdout: redact(lines.join("")), stderr: "", exitCode: 0 };
}

async function command_reload(ctx: ActionCtx, browser: bash_BrowserContext, binding: CloudResource) {
	const claimed = await claim(ctx, browser, {
		operationHash: await crypto_sha256_hex(`browser_reload\n${ai_chat_files_browser_resource_key(binding)}`),
		resource: binding,
	});
	if (claimed._nay) {
		if (claimed._nay === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(claimed._nay);
	}
	const invocation = claimed._yay;
	if (!invocation.isNew) return refuse("unknown");

	const reloaded = await ctx.runAction(internal.files_browser.agent_reload_browser, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		sessionId: binding.sessionId,
		expectedAgentLease: cloud_lease(binding, browser),
		operationId: invocation.commandId,
		operationDeadline: invocation.deadlineAt,
		toolCallId: invocation.toolCallId,
	});
	if (reloaded._nay) {
		const reason = safe_reason(reloaded._nay.name);
		await finish(ctx, invocation, "errored", reason);
		return refuse(reason);
	}
	if (
		reloaded._yay.mode !== binding.mode ||
		reloaded._yay.controlGen !== binding.controlGen ||
		(reloaded._yay.mode === "web" && reloaded._yay.tabId !== binding.tabId)
	) {
		await finish(ctx, invocation, "errored", "stale");
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}

	const next: CloudResource = {
		...binding,
		loadGen: reloaded._yay.loadGen,
		navGen: reloaded._yay.navGen,
		...(reloaded._yay.mode === "web" ? { tabGen: reloaded._yay.tabGen } : {}),
	};
	await finish(ctx, invocation, "succeeded", null, next);
	await update_turn(ctx, browser, { kind: "bind", bindings: [next], ifAbsent: false });
	return { stdout: "Reloaded.\n", stderr: "", exitCode: 0 };
}

async function command_close(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	bindings: BrowserResource[],
	binding: BrowserResource,
) {
	const claimed = await claim(ctx, browser, {
		operationHash: await crypto_sha256_hex(`browser_close\n${ai_chat_files_browser_resource_key(binding)}`),
		resource: binding,
	});
	if (claimed._nay) {
		if (claimed._nay === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(claimed._nay);
	}
	const invocation = claimed._yay;
	if (!invocation.isNew) return refuse("unknown");

	if (binding.provider === "playwriter") {
		const retired = await ctx.runMutation(internal.playwriter_browser.retire_session, {
			source: browser.source,
			browserIntent: browser.browserIntent,
			resource: binding,
		});
		if (retired._nay) {
			const reason = safe_reason(retired._nay.name);
			await finish(ctx, invocation, "errored", reason);
			return refuse(reason);
		}
		const closed = await playwriter_runner_call({
			route: "disconnect",
			body: {
				connectionId: binding.connectionId,
				ownerId: browser.source.userId,
				organizationId: browser.source.organizationId,
				workspaceId: browser.source.workspaceId,
				generation: binding.connectionGeneration,
			},
		});
		await update_turn(ctx, browser, { kind: "unbind", keys: [binding.connectionId] });
		await finish(ctx, invocation, closed._nay ? "errored" : "succeeded", closed._nay ? "execution" : null);
		if (closed._nay) return refuse("execution");
		return { stdout: "Stopped automation of My browser. The user's tab stays open.\n", stderr: "", exitCode: 0 };
	}

	const closed = await ctx.runAction(internal.files_browser.agent_close_browser, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		sessionId: binding.sessionId,
		expectedAgentLease: cloud_lease(binding, browser),
		operationId: invocation.commandId,
		operationDeadline: invocation.deadlineAt,
		toolCallId: invocation.toolCallId,
	});
	if (closed._nay) {
		const reason = safe_reason(closed._nay.name);
		await finish(ctx, invocation, "errored", reason);
		return refuse(reason);
	}
	await finish(ctx, invocation, "succeeded", null);
	await update_turn(ctx, browser, {
		kind: "unbind",
		keys: bindings
			.filter((item) => item.provider === "cloud" && item.sessionId === binding.sessionId)
			.map(ai_chat_files_browser_resource_key),
	});
	return {
		stdout: binding.mode === "file" ? "Closed the file preview.\n" : "Closed the cloud browser.\n",
		stderr: "",
		exitCode: 0,
	};
}

function agent_source(browser: bash_BrowserContext) {
	return {
		userId: browser.source.userId,
		organizationId: browser.source.organizationId,
		workspaceId: browser.source.workspaceId,
		membershipId: browser.source.membershipId,
		membershipLifetime: browser.source.membershipLifetime,
		threadId: browser.source.threadId,
	};
}

/**
 * Save the emitted files and downloads of one successful command as pending files. Only Agent mode
 * saves files. The producer's mutations check again that the browser is still the one the command
 * ran in.
 */
async function save_files(
	ctx: ActionCtx,
	browser: bash_BrowserContext,
	emitted: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; dataBase64: string }>,
	downloads: Array<{ path: string; contentType: string | undefined; bytes: Uint8Array<ArrayBuffer> }>,
	producer: Parameters<typeof files_ingestion_write>[2],
) {
	if (emitted.length === 0 && downloads.length === 0) return { notes: [], filesFailed: false };
	if (!browser.canWriteFiles) return { notes: [REFUSAL_TEXT.agent_required], filesFailed: true };

	const agentSource = agent_source(browser);
	const destinations = new Map<"current" | "personal", Parameters<typeof files_ingestion_write>[1][number]["scope"]>();
	const workspaces: Array<"current" | "personal"> = emitted.map((file) => file.workspace);
	if (downloads.length > 0) workspaces.push("current");
	for (const workspace of workspaces) {
		if (destinations.has(workspace)) continue;
		const resolved = await ctx.runQuery(internal.ai_chat_workspaces.resolve, { source: agentSource, workspace });
		if (resolved._nay) throw new Error(resolved._nay.message);
		const { organizationId, workspaceId, membershipId } = resolved._yay;
		destinations.set(workspace, {
			organizationId,
			workspaceId,
			membershipId,
			userId: browser.source.userId,
			threadId: browser.source.threadId,
			agentSource,
		});
	}
	const files = [
		...emitted.map(({ dataBase64, workspace, ...file }) => ({
			...file,
			scope: destinations.get(workspace)!,
			bytes: files_ingestion_decode_base64(dataBase64),
		})),
		...downloads.map((download) => ({ ...download, scope: destinations.get("current")! })),
	];
	const outcomes = await files_ingestion_write(ctx, files, producer, browser.signal);

	const notes: string[] = [];
	let filesFailed = false;
	for (const item of outcomes) {
		if (item.status === "succeeded") notes.push(`pending file ${item.file.path}. The user reviews it in Files.`);
		else filesFailed = true;
	}
	if (filesFailed) notes.push("some files could not be saved.");
	return { notes, filesFailed };
}

/**
 * Run one snippet in a cloud web tab or the file preview. The lease is checked before and after the
 * run, so a person's change during the run is never reported as the agent's own result.
 */
async function run_cloud(ctx: ActionCtx, browser: bash_BrowserContext, binding: CloudResource, code: string) {
	const readArgs = {
		organizationId: browser.source.organizationId,
		workspaceId: browser.source.workspaceId,
		userId: browser.source.userId,
		membershipId: browser.source.membershipId,
		sessionId: binding.sessionId,
		...(binding.mode === "web" && binding.tabId ? { tabId: binding.tabId } : {}),
	};
	const isCurrent = async (lease: CloudResource) => {
		const checked = await ctx.runQuery(internal.files_browser.check_browser_session_access, readArgs);
		return (
			checked.ok &&
			checked.control === "ready" &&
			checked.controlGen === lease.controlGen &&
			checked.loadGen === lease.loadGen &&
			checked.navGen === lease.navGen
		);
	};

	const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
	const claimed = await claim(ctx, browser, { operationHash: codeHash, resource: binding, operationKind: "run" });
	if (claimed._nay) {
		if (claimed._nay === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(claimed._nay);
	}
	const invocation = claimed._yay;
	if (!invocation.isNew) return refuse("unknown");

	const access = await ctx.runQuery(internal.files_browser.check_browser_session_access, readArgs);
	if (!access.ok && access.reason === "agent_access_off") {
		await finish(ctx, invocation, "errored", "agent_access_off");
		return refuse("agent_access_off");
	}
	if (
		!access.ok ||
		access.control !== "ready" ||
		access.controlGen !== binding.controlGen ||
		access.loadGen !== binding.loadGen ||
		access.navGen !== binding.navGen
	) {
		await finish(ctx, invocation, "errored", "stale");
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}

	const response = await files_browser_runner_call({
		route: "run",
		body: {
			mode: binding.mode,
			sessionId: access.runnerSessionId,
			ownerId: browser.source.userId,
			organizationId: browser.source.organizationId,
			workspaceId: browser.source.workspaceId,
			navGen: binding.navGen,
			loadGen: binding.loadGen,
			controlGen: binding.controlGen,
			commandId: invocation.commandId,
			deadline: invocation.deadlineAt,
			receiptResolutionDeadline: invocation.receiptResolutionDeadline,
			source: {
				chatId: browser.source.threadId,
				sourceMessageId: browser.source.sourceMessageId,
				toolCallId: invocation.toolCallId,
			},
			...(binding.mode === "web"
				? {
						tabId: binding.tabId,
						tabGen: binding.tabGen,
						selectionRevision: browser.browserIntent.selectionRevision,
						policyRevision: browser.browserIntent.policyRevision,
					}
				: {}),
			code,
		},
		signal: browser.signal,
	}).catch(() => null);

	// The runner did not report a session for this command, so it may still have run. The receipt
	// resolver settles it from the runner. These refusals only pick the text the model sees.
	if (!response) return refuse("unknown");
	// `busy_command` means another chat's command is running on this browser right now.
	if (response._nay?.name === "busy_command") return refuse("busy");
	if (response._nay?.name === "agent_access_off") return refuse("agent_access_off");
	// The page is on a site the user blocked for the agent. The runner dropped the whole output.
	if (response._nay?.name === "agent_blocked_site") return refuse("agent_blocked_site");
	if (response._nay) return refuse("unknown");

	const parsed = run_schema.safeParse(response._yay);
	if (
		!parsed.success ||
		parsed.data.commandId !== invocation.commandId ||
		parsed.data.codeHash !== codeHash ||
		(parsed.data.status !== "succeeded" && parsed.data.files.length > 0)
	)
		return refuse("invalid_result");
	const outcome = parsed.data;
	if (!outcome.session) return refuse("unknown");

	// Only this run may advance the lease. A changed mode, control, or tab means a person took over.
	const runner = outcome.session;
	if (
		runner.mode !== binding.mode ||
		runner.controlGen !== binding.controlGen ||
		(runner.mode === "web" && runner.tabId !== binding.tabId)
	) {
		await finish(ctx, invocation, "errored", "stale");
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}
	const synced = await ctx.runMutation(internal.files_browser.sync_browser_session, {
		sessionId: binding.sessionId,
		runner,
	});
	const next: CloudResource = {
		...binding,
		loadGen: runner.loadGen,
		navGen: runner.navGen,
		...(runner.mode === "web" ? { tabGen: runner.tabGen } : {}),
	};
	if (synced._nay || !synced._yay || !(await isCurrent(next))) {
		const after = await ctx.runQuery(internal.files_browser.check_browser_session_access, readArgs);
		// The user can turn agent access off while the command runs. Say so, so the model does not retry.
		const reason = !after.ok && after.reason === "agent_access_off" ? "agent_access_off" : "stale";
		await finish(ctx, invocation, "errored", reason);
		if (reason === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(reason);
	}
	await update_turn(ctx, browser, { kind: "bind", bindings: [next], ifAbsent: false });

	// Each download of a successful run becomes a pending file in `/.system/downloads/` of this
	// workspace, like an emitted file. The Files writer refuses the whole batch for one bad file, so
	// check each download here and drop only the bad one.
	const notes: string[] = [];
	const downloads: Array<{ path: string; contentType: string | undefined; bytes: Uint8Array<ArrayBuffer> }> = [];
	for (const download of outcome.downloads ?? []) {
		const path = `/.system/downloads/${files_normalize_browser_download_name(download.name)}`;
		const normalized = files_get_normalized_node_path_segments({
			kind: "file",
			nameOrPath: path.slice(1),
			fileNamePolicy: "keep_extension",
		});
		if (
			!normalized ||
			"validationMessage" in normalized ||
			normalized.normalizedPathSegments.join("/") !== path.slice(1)
		) {
			notes.push("a download was not saved: its name is not valid.");
			continue;
		}
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = files_ingestion_decode_base64(download.dataBase64);
		} catch {
			notes.push(`a download for ${path} was not saved: its data could not be read.`);
			continue;
		}
		// A web server picks the type. A broken type is left out so the writer guesses from the name.
		downloads.push({ path, contentType: files_normalize_content_type(download.contentType) ?? undefined, bytes });
	}
	if (outcome.downloadsDropped)
		notes.push(`downloads over the limit that were not saved: ${outcome.downloadsDropped}.`);

	const browserScope = {
		agentSource: agent_source(browser),
		threadId: browser.source.threadId,
		modeId: "agent" as const,
		sessionId: binding.sessionId,
		expectedAgentLease: cloud_lease(next, browser),
		expectedSource:
			access.mode === "web"
				? { mode: "web" as const }
				: {
						mode: "file" as const,
						targetKind: access.targetKind,
						nodeId: access.nodeId,
						sourceKind: access.sourceKind,
						sourceVersion: access.sourceVersion,
						sourceHash: access.sourceHash,
					},
	};
	const saved = await save_files(ctx, browser, outcome.files, downloads, {
		requestId: invocation.toolCallId,
		prepare: (args) => ctx.runMutation(internal.files_browser.prepare_file_output, { ...args, ...browserScope }),
		finalize: (args) => ctx.runMutation(internal.files_browser.finalize_file_output, { ...args, ...browserScope }),
	});
	notes.push(...saved.notes);
	const filesFailed = saved.filesFailed;

	await finish(
		ctx,
		invocation,
		outcome.status === "succeeded" && !filesFailed ? "succeeded" : "errored",
		outcome.status === "succeeded"
			? filesFailed
				? browser.canWriteFiles
					? "storage"
					: "agent_required"
				: null
			: "execution",
		next,
	);

	const error = outcome.error as { name?: unknown; message?: unknown } | null | undefined;
	const printed = print_run({
		resultText:
			outcome.result === undefined || outcome.result === null
				? null
				: typeof outcome.result === "string"
					? outcome.result
					: (JSON.stringify(outcome.result) ?? null),
		resultTruncated: outcome.resultTruncated,
		logs: outcome.logs,
		logsTruncated: outcome.logsTruncated,
		consoleEntries: outcome.consoleEntries,
		pageErrors: outcome.pageErrors,
		stateWarnings: outcome.stateWarnings ?? [],
		errorText: error && typeof error.message === "string" ? error.message : null,
		notes,
	});
	return {
		...printed,
		exitCode:
			outcome.status === "timed_out"
				? bash_COMMAND_EXIT_TIMED_OUT
				: outcome.status === "succeeded" && !filesFailed
					? 0
					: bash_COMMAND_EXIT_FAILURE,
	};
}

/**
 * Run one snippet in the user's shared tab through the Playwriter relay. The relay keeps one
 * unresolved command per connection. A lost reply stays with the scheduled resolver and is never
 * run again here.
 */
async function run_playwriter(ctx: ActionCtx, browser: bash_BrowserContext, binding: PlaywriterResource, code: string) {
	const operation = { kind: "script" as const, code };
	const operationHash = await crypto_sha256_hex(`browser_script\n${JSON.stringify(operation)}`);

	const claimed = await update_turn(ctx, browser, { kind: "claim" });
	if (claimed._nay) return refuse(turn_reason(claimed._nay.name));

	const toolCallId = `${browser.invocationId}:browser:${browser.nextCommandNumber()}`;
	const reserved = await ctx.runMutation(internal.playwriter_browser.reserve_command, {
		source: browser.source,
		browserIntent: browser.browserIntent,
		resource: binding,
		toolCallId,
		operationHash,
		run: browser.run,
	});
	if (reserved._nay) {
		// `busy` is a command of another chat that is still settling. `limit` is the shared session's
		// own limit. A pause, a stop, or a changed lease ends browser access for the turn.
		const reason: BrowserReason =
			reserved._nay.name === "busy"
				? "busy"
				: reserved._nay.name === "limit"
					? "session_limit"
					: reserved._nay.message.startsWith("Stopped")
						? "stopped"
						: "stale";
		if (reason === "stale") await update_turn(ctx, browser, { kind: "revoke" });
		return refuse(reason);
	}
	const { connection, invocation, allowedVersions } = reserved._yay;
	if (!invocation.isNew) return refuse("unknown");

	const identity = {
		generation: binding.connectionGeneration,
		commandId: invocation.commandId,
		operationHash,
		source: { chatId: browser.source.threadId, sourceMessageId: browser.source.sourceMessageId, toolCallId },
		deadline: invocation.deadlineAt,
		receiptResolutionDeadline: invocation.receiptResolutionDeadline,
		invocationId: invocation.invocationId,
	};
	const base = {
		connectionId: connection._id,
		ownerId: browser.source.userId,
		organizationId: browser.source.organizationId,
		workspaceId: browser.source.workspaceId,
	};
	const { invocationId: _invocationId, ...receipt } = identity;
	const lastResolved = connection.pendingAcknowledgement;
	const response = await playwriter_runner_call({
		route: "run",
		signal: browser.signal,
		body: {
			...base,
			...receipt,
			controlRevision: binding.controlRevision,
			policyRevision: browser.browserIntent.policyRevision,
			selectionRevision: browser.browserIntent.selectionRevision,
			targetRevision: binding.targetRevision,
			navRevision: binding.navRevision,
			targetId: connection.confirmedTargetId!,
			allowedVersions,
			operation,
			...(lastResolved
				? {
						lastResolved: {
							...base,
							generation: lastResolved.generation,
							commandId: lastResolved.commandId,
							operationHash: lastResolved.operationHash,
							source: lastResolved.source,
							deadline: lastResolved.deadline,
							receiptResolutionDeadline: lastResolved.receiptResolutionDeadline,
						},
					}
				: {}),
		},
	});
	// The scheduled resolver owns an uncertain reply. The script output is lost with it.
	if (
		response._nay ||
		!("status" in response._yay) ||
		response._yay.status === "in_progress" ||
		response._yay.status === "acknowledged"
	)
		return refuse("unknown");

	const run = response._yay;
	const safeStatus =
		run.status === "unknown"
			? "unknown"
			: run.status === "not_started"
				? "not_started"
				: run.result?.ok
					? "succeeded"
					: "errored";
	const finished = await ctx.runMutation(internal.playwriter_browser.finish_command, {
		connectionId: connection._id,
		identity,
		result: {
			status: safeStatus,
			reason: run.result?.reason && /^[a-z0-9_]{1,64}$/.test(run.result.reason) ? run.result.reason : null,
		},
		runtime: run.runtime,
		completedLease: run.completedLease,
		fenced: run.runtime.generation > identity.generation || run.result?.cleanup === "complete",
	});
	if (run.consumedAck)
		await ctx.runMutation(internal.playwriter_browser.clear_acknowledgement, {
			connectionId: connection._id,
			commandId: run.consumedAck.commandId,
			generation: run.consumedAck.generation,
		});
	if (!finished) return refuse("unknown");
	const acknowledged = await playwriter_runner_call({
		route: "command-ack",
		body: { ...base, ...receipt },
		timeoutMs: 3_000,
	});
	if (!acknowledged._nay && "status" in acknowledged._yay && acknowledged._yay.status === "acknowledged")
		await ctx.runMutation(internal.playwriter_browser.clear_acknowledgement, {
			connectionId: connection._id,
			commandId: identity.commandId,
			generation: identity.generation,
		});

	// Cleanup does not prove whether an uncertain action ran.
	if (safeStatus === "unknown") return refuse("unknown");
	if (safeStatus !== "succeeded")
		return refuse(safeStatus === "not_started" ? "not_started" : safe_reason(run.result?.reason));

	const completed = run.completedLease;
	if (
		!completed ||
		run.runtime.generation !== binding.connectionGeneration ||
		run.runtime.controlRevision !== binding.controlRevision ||
		run.runtime.policyRevision !== browser.browserIntent.policyRevision ||
		run.runtime.selectionRevision !== browser.browserIntent.selectionRevision ||
		run.runtime.confirmedTargetId !== connection.confirmedTargetId ||
		completed.generation !== binding.connectionGeneration ||
		completed.controlRevision !== binding.controlRevision ||
		completed.policyRevision !== browser.browserIntent.policyRevision ||
		completed.selectionRevision !== browser.browserIntent.selectionRevision ||
		completed.confirmedTargetId !== connection.confirmedTargetId
	) {
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}

	// A script's click often navigates after the script returns, while the runner cleans up. Adopt
	// the runtime revisions, not only the completed lease, or every such late navigation would end
	// browser access for the turn. A person's navigation in the same short window is adopted too.
	const next: PlaywriterResource = {
		...binding,
		navRevision: run.runtime.navRevision,
		targetRevision: run.runtime.targetRevision,
	};
	if (!(await binding_current(ctx, browser, next))) {
		await update_turn(ctx, browser, { kind: "revoke" });
		return refuse("stale");
	}
	await update_turn(ctx, browser, { kind: "bind", bindings: [next], ifAbsent: false });

	// A thrown or timed out script still completes the receipt. Its own status decides the exit code.
	const script: PlaywriterBrowserScriptOutput | undefined = run.script;
	if (!script || (script.status !== "succeeded" && script.files.length > 0)) return refuse("invalid_result");

	// The receipt already completed above, so a failed save shows only in the exit code and the notes.
	const browserScope = {
		agentSource: agent_source(browser),
		threadId: browser.source.threadId,
		modeId: "agent" as const,
		source: browser.source,
		browserIntent: browser.browserIntent,
		expectedLease: next,
	};
	const saved = await save_files(ctx, browser, script.files, [], {
		requestId: toolCallId,
		prepare: (args) => ctx.runMutation(internal.playwriter_browser.prepare_file_output, { ...args, ...browserScope }),
		finalize: (args) => ctx.runMutation(internal.playwriter_browser.finalize_file_output, { ...args, ...browserScope }),
	});

	// Print a string result raw, like the cloud browser does. A cut result is no longer valid JSON.
	let resultText = script.resultJson;
	if (resultText !== null && !script.resultTruncated && resultText.startsWith('"')) {
		const value: unknown = JSON.parse(resultText);
		if (typeof value === "string") resultText = value;
	}
	const printed = print_run({
		resultText,
		resultTruncated: script.resultTruncated,
		logs: script.logs,
		logsTruncated: script.logsTruncated,
		consoleEntries: script.consoleEntries,
		pageErrors: script.pageErrors,
		stateWarnings: script.stateWarnings,
		errorText: script.error ? `${script.error.name}: ${script.error.message}` : null,
		notes: saved.notes,
	});
	return {
		...printed,
		exitCode:
			script.status === "timed_out"
				? bash_COMMAND_EXIT_TIMED_OUT
				: script.status === "succeeded" && !saved.filesFailed
					? 0
					: bash_COMMAND_EXIT_FAILURE,
	};
}

/**
 * `browser` drives the user's chosen web browser or the cloud file preview with Playwright code,
 * like the Playwriter CLI. The provider is the user's saved choice; the agent never picks or
 * switches it. Output is normal Bash output: it is saved with the chat like any other command.
 */
export function bash_browser_command_create(ctx: ActionCtx, browser: bash_BrowserContext): Command {
	return defineCommand("browser", async (args, commandCtx) => {
		const [subcommand, ...rest] = args;
		if (subcommand === undefined) return usage_error("missing subcommand");
		if (subcommand === "--help" || subcommand === "-h" || subcommand === "help")
			return { stdout: USAGE, stderr: "", exitCode: 0 };

		// Parse the flags every subcommand shares. Each subcommand then refuses the ones it does not take.
		let file = false;
		let tab: string | null = null;
		let code: string | null = null;
		let filePath: string | null = null;
		let sourceKind: "saved" | "proposed" | "draft" = "saved";
		let sourceKindGiven = false;
		const positionals: string[] = [];
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index]!;
			if (arg === "--file") {
				file = true;
				// `open --file PATH` takes a value; the other subcommands use --file as a target flag.
				if (subcommand === "open") {
					index += 1;
					filePath = rest[index] ?? null;
					if (!filePath) return usage_error("open --file needs a path");
				}
				continue;
			}
			if (arg === "--tab") {
				index += 1;
				tab = rest[index] ?? null;
				if (!tab || tab.length < 4) return usage_error("--tab needs a tab id of at least 4 characters");
				continue;
			}
			if (arg === "-e") {
				index += 1;
				code = rest[index] ?? null;
				if (code === null) return usage_error("-e needs code");
				continue;
			}
			if (arg === "--source") {
				index += 1;
				const value = rest[index];
				if (value !== "saved" && value !== "proposed" && value !== "draft")
					return usage_error("--source must be saved, proposed or draft");
				sourceKind = value;
				sourceKindGiven = true;
				continue;
			}
			if (arg.startsWith("-")) return usage_error(`unsupported option ${arg}`);
			positionals.push(arg);
		}

		const known = ["status", "open", "tabs", "tab", "run", "reload", "close"];
		if (!known.includes(subcommand)) return usage_error(`unknown subcommand ${subcommand}`);
		if (file && tab !== null) return usage_error("use --tab or --file, not both");
		if (code !== null && subcommand !== "run") return usage_error("-e works only with run");
		if (sourceKindGiven && !filePath) return usage_error("--source works only with open --file");
		if (tab !== null && subcommand !== "run" && subcommand !== "reload")
			return usage_error("--tab works only with run and reload");
		if (file && subcommand !== "run" && subcommand !== "reload" && subcommand !== "close" && subcommand !== "open")
			return usage_error(`--file does not work with ${subcommand}`);

		// The turn state comes from the run doc, because Bash runs outside the chat action.
		const turn = await ctx.runQuery(internal.ai_chat_files.get_browser_turn, {
			run: browser.run,
			userId: browser.source.userId,
		});
		if (turn._nay || turn._yay.revoked) return refuse("stale");
		const bindings = await check_bindings(ctx, browser, turn._yay.bindings);
		if (!bindings) {
			await update_turn(ctx, browser, { kind: "revoke" });
			return refuse("stale");
		}
		if (bindings.some((item, index) => item !== turn._yay.bindings[index]))
			await update_turn(ctx, browser, { kind: "bind", bindings, ifAbsent: false });

		if (subcommand === "status") {
			if (positionals.length > 0) return usage_error("status takes no arguments");
			return command_status(ctx, browser);
		}

		if (subcommand === "open") {
			if (positionals.length > (filePath ? 0 : 1)) return usage_error("open takes one URL");
			if (filePath) return command_open(ctx, browser, { url: null, file: { path: filePath, sourceKind } });
			if (browser.browserIntent.webChoice.provider === "none")
				return {
					stdout: "",
					stderr: "browser: the user has not chosen a web browser.\n",
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			return command_open(ctx, browser, { url: positionals[0] ?? null, file: null });
		}

		if (subcommand === "tabs") {
			if (positionals.length > 0) return usage_error("tabs takes no arguments");
			return command_tabs(ctx, browser, bindings, { operation: "tabs", url: null, tab: null });
		}

		if (subcommand === "tab") {
			const [action, value, extra] = positionals;
			if (action === "new" && extra === undefined)
				return command_tabs(ctx, browser, bindings, { operation: "tab-new", url: value ?? null, tab: null });
			if (action === "close" && value !== undefined && value.length >= 4 && extra === undefined)
				return command_tabs(ctx, browser, bindings, { operation: "tab-close", url: null, tab: value });
			return usage_error("use tab new [URL] or tab close TAB");
		}

		if (positionals.length > 0) return usage_error(`${subcommand} takes no positional arguments`);
		if (subcommand !== "close" && !file && browser.browserIntent.webChoice.provider === "playwriter" && tab !== null)
			return usage_error("My browser has one shared tab. Leave out --tab.");

		const target = await target_binding(ctx, browser, bindings, { file, tab });
		if (target._nay === "stale") return refuse("stale");
		if (target._nay === "usage") return usage_error(target.text);
		if (target._nay === "none")
			return {
				stdout: "",
				stderr: file
					? "browser: no file preview is open. Run: browser open --file PATH\n"
					: "browser: no web browser is open. Run: browser open [URL]\n",
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};
		const binding = target._yay;

		if (subcommand === "close") return command_close(ctx, browser, bindings, binding);

		if (subcommand === "reload") {
			if (binding.provider !== "cloud")
				return {
					stdout: "",
					stderr: `browser: reload works only in the cloud browser. In My browser use: browser run -e 'await page.reload()'\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
				};
			return command_reload(ctx, browser, binding);
		}

		const source = code ?? bash_decode_stdin_as_utf8(commandCtx.stdin);
		if (!source.trim()) return usage_error("run needs code: pass -e CODE or a heredoc on stdin");
		if (source.length > CODE_MAX_CHARS) return usage_error(`the code is longer than ${CODE_MAX_CHARS} characters`);
		// A run holds the browser for up to 30 seconds. It must end before this Bash call stores its result.
		if (Date.now() + RUN_TIME_MS > browser.deadlineAt)
			return { stdout: "", stderr: `browser: ${REFUSAL_TEXT.time}\n`, exitCode: bash_COMMAND_EXIT_TIMED_OUT };

		return binding.provider === "cloud"
			? run_cloud(ctx, browser, binding, source)
			: run_playwriter(ctx, browser, binding, source);
	});
}
