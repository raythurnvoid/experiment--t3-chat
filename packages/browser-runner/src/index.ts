// Host Worker for the cloud browser.
//
// Runs agent Playwright JavaScript in a Worker Loader Dynamic Worker against one
// Cloudflare Browser Run session. The host owns the session, the snapshot, and the
// network policy. The snippet sees only its assigned session connection.
//
// The BrowserSession Durable Object owns one owner/organization/workspace slot:
// session record, command lock, generations, deadlines, and cleanup. The
// BrowserRegistry object owns deployment-wide and per-workspace admission slots.
// Provider calls use acquire() plus the persistent connect URL form so session
// targets survive client disconnects; browser.close() then only drops the
// client connection. Only the trusted close path ends a session, through a CDP
// Browser.close command.
//
// Security notes:
// - Auth uses `Authorization: Bearer <BROWSER_RUNNER_SECRET>`, checked before any
//   feature or config detail leaves an internal endpoint.
// - The snippet binding receives no provider key, R2 binding, or Convex secret.
//   The snippet module can import only `connect` and `expect`; the connection
//   gate accepts one command connection through its owning session object.
//   The trusted bridge checks every protocol method, parameter, and target.
// - The provider session id never leaves the runner. Callers use the opaque app
//   session id plus generations; late calls from a retired session are refused.
// - Operational logs include only execution metadata, never code, HTML, DOM,
//   viewer URLs, tokens, cookies, input text, or captured console text.

import { WorkerEntrypoint } from "cloudflare:workers";
import { acquire, connect, sessions } from "@cloudflare/playwright";
import type { CDPSession, Page } from "@cloudflare/playwright";
import { CHILD_BUNDLE_JS } from "./child-bundle.gen";
import { AgentConnection } from "./agent-connection";

// Typed locally to match the in-file binding shape convention.
// `limits` is verified in the generated workerd types: per-snippet CPU and
// subrequest caps on the Worker Loader binding.
type BrowserWorkerLoaderWorkerCode = {
	compatibilityDate: string;
	compatibilityFlags?: string[];
	mainModule: string;
	modules: Record<string, string>;
	env?: Record<string, unknown>;
	globalOutbound?: Fetcher | null;
	limits?: {
		cpuMs?: number;
		subRequests?: number;
	};
};

type SnippetEvaluateResult =
	| {
			ok: true;
			resultJson: string;
			files: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; bytes: Uint8Array }>;
			viewport: { width: number; height: number } | null;
			popups: { blocked: number; urls: string[] };
			consoleEntries: string[];
			pageErrors: string[];
			logs: string[];
			logsTruncated: boolean;
	  }
	| {
			ok: false;
			error: { name: string; message: string };
			viewport: { width: number; height: number } | null;
			popups: { blocked: number; urls: string[] };
			consoleEntries: string[];
			pageErrors: string[];
			logs: string[];
			logsTruncated: boolean;
	  };

type SnippetWorkerStub = {
	getEntrypoint: () => { evaluate: (input: unknown) => Promise<SnippetEvaluateResult> };
};

type BrowserWorkerLoader = {
	load: (code: BrowserWorkerLoaderWorkerCode) => SnippetWorkerStub;
};

type BrowserWorker = {
	fetch: typeof fetch;
};

type DurableObjectIdStub = {
	toString: () => string;
};

type DurableObjectStubStub = {
	fetch: (request: Request) => Promise<Response>;
};

type DurableObjectNamespaceStub = {
	idFromName: (name: string) => DurableObjectIdStub;
	get: (id: DurableObjectIdStub) => DurableObjectStubStub;
};

type DurableObjectStorageStub = {
	get: <T>(key: string) => Promise<T | undefined>;
	put: (key: string, value: unknown) => Promise<void>;
	delete: (key: string) => Promise<boolean>;
	setAlarm: (time: number | Date) => Promise<void>;
	getAlarm: () => Promise<number | null>;
	deleteAlarm: () => Promise<void>;
};

type DurableObjectStateStub = {
	id: DurableObjectIdStub;
	storage: DurableObjectStorageStub;
	waitUntil: (promise: Promise<unknown>) => void;
};

export type Env = {
	BROWSER: BrowserWorker;
	LOADER: BrowserWorkerLoader;
	BROWSER_SESSIONS: DurableObjectNamespaceStub;
	BROWSER_REGISTRY: DurableObjectNamespaceStub;
	BROWSER_RUNNER_SECRET: string;
	BROWSER_RUNNER_DISABLED?: string;
	BROWSER_PREVIEW_URL?: string;
};

type Fetcher = {
	fetch: (request: Request) => Response | Promise<Response>;
};

type BrowserRunnerContext = ExecutionContext & {
	readonly exports?: {
		readonly BrowserConnectionGateway?: (options: { props: BrowserConnectionGatewayProps }) => Fetcher;
	};
};

type BrowserConnectionGatewayProps = {
	sessionId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	commandId: string;
};

// Session model

type SessionControl = "starting" | "ready" | "agent" | "pausing" | "human" | "closing" | "closed";

type AgentLease = { navGen: number; loadGen: number; controlGen: number };

type SessionRecord = {
	version: 1;
	sessionId: string;
	grantId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	nodeId: string;
	navGen: number;
	loadGen: number;
	controlGen: number;
	control: SessionControl;
	sourceKind: string;
	sourceVersion: string;
	sourceHash: string;
	providerSessionId: string | null;
	pageNonce: string | null;
	viewport: { width: number; height: number };
	command: { id: string; startedAt: number; connection?: "available" | "consumed" | "revoked" | "settled" } | null;
	commandCount: number;
	htmlBytesTotal: number;
	loadCount: number;
	createdAt: number;
	providerAcquiredAt: number | null;
	lastActiveAt: number;
	attemptId: string;
	closeAttempts: number;
	inputHolder: string | null;
	viewers: Record<string, { host: string; controlGen: number; grantedUntil: number; lastInputAt: number; attachedAt: number }>;
	viewerGrants: Record<string, { navGen: number; expiresAt: number }>;
};

type RegistryRecord = {
	grants: Record<string, { workspaceKey: string; state: "claimed" | "active"; expiresAt: number | null }>;
};

// Limits / constants

export const LIMITS = {
	bodyBytes: 6_291_456,
	htmlBytes: 900_000,
	htmlBytesTotal: 8_388_608,
	loadCount: 32,
	codeBytes: 20_480,
	textOutBytes: 16_384,
	files: 8,
	fileBytes: 8_388_608,
	filePathChars: 1024,
	fileContentTypeChars: 255,
	viewerFrameBytes: 2_097_152,
	consoleEntries: 50,
	consoleBytes: 4096,
	logLines: 100,
	logBytes: 16_384,
	commandTimeoutMs: 30_000,
	childWallMs: 31_000,
	childCpuMs: 30_000,
	childSubRequests: 10,
	sessionTotalMs: 1_200_000,
	sessionIdleMs: 300_000,
	keepAliveMs: 600_000,
	commandsPerSession: 60,
	workspaceSessions: 2,
	deploymentSessions: 10,
	grantTtlMs: 60_000,
	grantActiveMs: 24 * 60 * 60 * 1000,
	startingStaleMs: 90_000,
	closeVerifyMs: 10_000,
	closeAttempts: 3,
	viewportMin: 320,
	viewportMaxWidth: 2560,
	viewportMaxHeight: 1440,
	viewersPerSession: 2,
	viewerGrantTtlMs: 30_000,
	viewerGrantWindowMs: 30_000,
	viewerPollMs: 5_000,
} as const;

const COMPAT_DATE = "2026-09-19";
const CHILD_COMPAT_DATE = "2026-09-19";
const CHILD_ENTRY_MODULE = "executor.js";
const CHILD_BUNDLE_MODULE = "pw.js";
const CONTROLLER_ORIGIN = "https://controller.browser.invalid";
const CONTROLLER_URL = `${CONTROLLER_ORIGIN}/`;
const SESSION_KEY = "session";
const REGISTRY_KEY = "registry";
const REGISTRY_NAME = "registry";
const BROWSER_OPEN_FIELDS = new Set([
	"attemptId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"nodeId",
	"navGen",
	"sourceKind",
	"sourceVersion",
	"sourceHash",
	"html",
	"viewport",
]);
const BROWSER_RUN_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen", "loadGen", "controlGen", "commandId", "code"]);
const BROWSER_RELOAD_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"sourceKind",
	"sourceVersion",
	"sourceHash",
	"html",
	"expectedAgentLease",
]);
const BROWSER_CLOSE_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "reason", "expectedAgentLease"]);
const BROWSER_STATUS_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId"]);
const BROWSER_KEEP_OPEN_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_GRANT_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_RENEW_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "viewerId"]);
const BROWSER_CONTROL_TAKE_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen", "viewerId"]);
const BROWSER_CONTROL_RESUME_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const SOURCE_KINDS = new Set(["saved", "proposed", "draft"]);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Small helpers

function byte_length(value: string): number {
	return TEXT_ENCODER.encode(value).length;
}

function utf8_prefix(value: string, maxBytes: number): string {
	const { read } = TEXT_ENCODER.encodeInto(value, new Uint8Array(maxBytes));
	return value.slice(0, read);
}

function json_response(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function constant_time_sha256_equal(a: string, b: string): Promise<boolean> {
	const [aDigest, bDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(a)),
		crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(b)),
	]);
	const aBytes = new Uint8Array(aDigest);
	const bBytes = new Uint8Array(bDigest);
	let diff = aBytes.length ^ bBytes.length;
	for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}

async function is_authorized(request: Request, env: Env): Promise<boolean> {
	// Fail closed when the secret is missing: without this, `Bearer undefined` (or an empty
	// token) would authenticate against an unset variable.
	if (!env.BROWSER_RUNNER_SECRET) return false;
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) return false;
	return await constant_time_sha256_equal(header.slice(prefix.length), env.BROWSER_RUNNER_SECRET);
}

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_non_empty_string(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function is_positive_int(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function is_agent_lease(value: unknown): value is AgentLease {
	return is_record(value) && is_positive_int(value.navGen) && is_positive_int(value.loadGen) && is_positive_int(value.controlGen);
}

function cap_message(message: string): string {
	return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

function sanitize_error(error: unknown): { name: string; message: string } {
	if (error && typeof error === "object") {
		const e = error as { name?: unknown; message?: unknown };
		return {
			name: typeof e.name === "string" ? e.name : "Error",
			message: cap_message(typeof e.message === "string" ? e.message : String(error)),
		};
	}
	return { name: "Error", message: cap_message(String(error)) };
}

/**
 * Re-enforce snippet text bounds on the host. The harness caps these arrays itself, but user
 * code reaches them as closure state and can bypass that, so the host caps again: per-list
 * entry count plus one shared byte budget across the lists.
 */
export function cap_snippet_string_lists(
	lists: Array<unknown>,
	maxEntries: number,
	maxBytes: number,
): { capped: Array<Array<string>>; truncated: boolean } {
	let truncated = false;
	const capped = lists.map((list) => {
		if (!Array.isArray(list)) {
			truncated = true;
			return [];
		}
		if (list.length > maxEntries) {
			truncated = true;
		}
		return list.slice(0, maxEntries).map((line) => {
			const original = String(line);
			const text = utf8_prefix(original, maxBytes);
			if (text !== original) truncated = true;
			return text;
		});
	});
	let total = 0;
	for (const lines of capped) {
		for (const line of lines) {
			total += byte_length(line);
		}
	}
	while (total > maxBytes) {
		let longest = 0;
		let longestBytes = -1;
		for (let i = 0; i < capped.length; i++) {
			const bytes = capped[i]!.reduce((sum, line) => sum + byte_length(line), 0);
			if (bytes > longestBytes) {
				longest = i;
				longestBytes = bytes;
			}
		}
		const line = capped[longest]!.pop();
		if (line === undefined) {
			break;
		}
		total -= byte_length(line);
		truncated = true;
	}
	return { capped, truncated };
}

type SnippetEvaluateText = {
	consoleEntries?: unknown;
	pageErrors?: unknown;
	logs?: unknown;
	logsTruncated?: unknown;
};

/**
 * Cap one snippet result's text channels: console entries and page errors share their budget
 * (mirroring the harness), logs keep their own, and any cut marks the logs truncated.
 */
function cap_snippet_text(sandbox: SnippetEvaluateText): {
	consoleEntries: Array<string>;
	pageErrors: Array<string>;
	logs: Array<string>;
	logsTruncated: boolean;
} {
	const console = cap_snippet_string_lists(
		[sandbox.consoleEntries, sandbox.pageErrors],
		LIMITS.consoleEntries,
		LIMITS.consoleBytes,
	);
	const logs = cap_snippet_string_lists([sandbox.logs], LIMITS.logLines, LIMITS.logBytes);
	return {
		consoleEntries: console.capped[0] ?? [],
		pageErrors: console.capped[1] ?? [],
		logs: logs.capped[0] ?? [],
		logsTruncated: logs.truncated || sandbox.logsTruncated === true,
	};
}

// workerd kills a runaway snippet at the platform CPU limit, surfacing
// "Worker exceeded CPU time limit." / "exceeded resource limits". That is a
// resource-exhaustion timeout, not user-code error, so map it to `timed_out`.
function is_resource_limit_error(error: unknown): boolean {
	const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
	if (typeof message !== "string") return false;
	return /exceeded (the )?(cpu time|resource|memory) limit/iu.test(message);
}

async function sha256_hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(input));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Operational log — metadata only, never code, HTML, DOM, viewer URLs, tokens,
// cookies, input text, or captured console text.
function log_browser(fields: Record<string, string | number | boolean>): void {
	console.log(JSON.stringify({ tag: "browser_runner", ...fields }));
}

function append_bytes(chunks: Uint8Array[], size: number) {
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function read_bounded_stream(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
	if (!stream) return { bytes: new Uint8Array(), truncated: false };

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;

			const chunk = next.value;
			const remaining = maxBytes - size;
			if (chunk.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(chunk.slice(0, remaining));
					size += remaining;
				}
				await reader.cancel();
				return { bytes: append_bytes(chunks, size), truncated: true };
			}

			chunks.push(chunk);
			size += chunk.byteLength;
		}
		return { bytes: append_bytes(chunks, size), truncated: false };
	} finally {
		reader.releaseLock();
	}
}

async function read_bounded_text(request: Request) {
	const { bytes, truncated } = await read_bounded_stream(request.body, LIMITS.bodyBytes);
	if (truncated) return { ok: false as const };
	return { ok: true as const, text: TEXT_DECODER.decode(bytes) };
}

function invalid_request(message: string) {
	return json_response({ ok: false, error: { code: "invalid_request", message } }, 400);
}

function operation_refused(code: string, message: string) {
	return json_response({ ok: false, error: { code, message } }, 200);
}

// Execution timeout

export class WallTimeoutError extends Error {
	constructor() {
		super("Wall-clock timeout");
		this.name = "WallTimeoutError";
	}
}

export function with_wall_timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new WallTimeoutError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

// Controller document
//
// A synthetic, trusted parent page. It embeds the real preview runtime, speaks
// the existing hello/ready/load_html handshake, and reports readiness through
// window flags the trusted bootstrap reads. It carries only the authorized
// snapshot bytes plus handshake ids — never secrets or provider credentials.

export function build_controller_html(input: {
	runtimeUrl: string;
	sessionId: string;
	loadId: string;
	nonce: string;
	html: string;
}): string {
	const config = JSON.stringify({
		runtimeUrl: input.runtimeUrl,
		sessionId: input.sessionId,
		loadId: input.loadId,
		html: input.html,
		// The snapshot may contain "</script>". Escape "<" so the config block
		// cannot break out of its own script tag.
	}).replace(/</g, "\\u003c");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Shared browser</title>
<style>html,body{margin:0;padding:0;height:100%;background:#000}iframe{display:block;width:100vw;height:100vh;border:0}</style>
</head>
<body>
<script>
"use strict";
(function () {
  var CFG = ${config};
  window.__browserNonce = ${JSON.stringify(input.nonce)};
  window.__browserReady = false;
  window.__browserError = null;
  var runtimeOrigin = new URL(CFG.runtimeUrl).origin;
  var frame = document.createElement("iframe");
  frame.title = "Shared browser preview";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.referrerPolicy = "no-referrer";
  var settled = false;
  function fail(message) {
    if (settled) return;
    settled = true;
    window.__browserError = String(message).slice(0, 500);
  }
  window.addEventListener("message", function (event) {
    if (settled) return;
    if (event.source !== frame.contentWindow || event.origin !== runtimeOrigin) return;
    var data = event.data;
    if (!data || data.protocol !== "bonobo-file-preview" || data.version !== 1) return;
    if (data.sessionId !== CFG.sessionId) return;
    if (data.type === "ready") {
      frame.contentWindow.postMessage(
        { protocol: "bonobo-file-preview", version: 1, sessionId: CFG.sessionId, type: "load_html", loadId: CFG.loadId, html: CFG.html },
        runtimeOrigin,
      );
      return;
    }
    if (data.loadId !== CFG.loadId) return;
    if (data.type === "loaded") {
      settled = true;
      window.__browserReady = true;
      return;
    }
    if (data.type === "error") {
      fail(typeof data.message === "string" && data.message ? data.message : "The preview reported an error.");
    }
  });
  frame.addEventListener("load", function () {
    frame.contentWindow.postMessage(
      { protocol: "bonobo-file-preview", version: 1, sessionId: CFG.sessionId, type: "hello" },
      runtimeOrigin,
    );
  });
  document.body.appendChild(frame);
  frame.src = CFG.runtimeUrl;
  setTimeout(function () { fail("The preview did not finish loading."); }, 20000);
})();
</script>
</body>
</html>
`;
}

// Snippet harness
//
// The executor resolves the one registered page and its inner preview frame,
// then runs the agent code with `(page, frame, expect, emitFile)`. Console and
// page errors are collected separately from tool output. File bytes the snippet
// emits cross RPC directly, and the host checks their count and total size. The
// app owns Files path and MIME rules. Screenshots travel the other way: the
// trusted bridge checks a provider screenshot reply before the child receives it.

const EXECUTOR_PREFIX = `import { WorkerEntrypoint } from "cloudflare:workers";
import { connect, expect } from "./${CHILD_BUNDLE_MODULE}";

export default class SnippetExecutor extends WorkerEntrypoint {
  async evaluate(input) {
    if (!input || typeof input.sessionId !== "string" || !input.sessionId) {
      throw new Error("Missing browser session.");
    }
    if (!input || typeof input.runtimeOrigin !== "string" || !input.runtimeOrigin) {
      throw new Error("Missing runtime origin.");
    }
    if (!input.viewport || typeof input.viewport.width !== "number" || typeof input.viewport.height !== "number") {
      throw new Error("Missing viewport.");
    }
    var timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : ${LIMITS.commandTimeoutMs};
    var files = [];
    var fileBytes = 0;
    var filesOpen = true;
    var timer;
    var consoleEntries = [];
    var pageErrors = [];
    var consoleBytes = 0;
    var textEncoder = new TextEncoder();
    function utf8Prefix(text, maxBytes) {
      return text.slice(0, textEncoder.encodeInto(text, new Uint8Array(maxBytes)).read);
    }
    function pushBounded(list, line) {
      if (list.length >= ${LIMITS.consoleEntries}) return;
      var room = ${LIMITS.consoleBytes} - consoleBytes;
      if (room <= 0) return;
      var text = utf8Prefix(String(line), room);
      consoleBytes += textEncoder.encode(text).length;
      list.push(text);
    }
    var logs = [];
    var logBytes = 0;
    var logsTruncated = false;
    function pushLog(line) {
      if (logsTruncated) return;
      if (logs.length >= ${LIMITS.logLines}) { logsTruncated = true; return; }
      var text = String(line);
      if (logBytes + textEncoder.encode(text).length > ${LIMITS.logBytes}) {
        text = utf8Prefix(text, Math.max(0, ${LIMITS.logBytes} - logBytes));
        logsTruncated = true;
      }
      logBytes += textEncoder.encode(text).length;
      logs.push(text);
    }
    console.log = function () { pushLog(Array.prototype.map.call(arguments, String).join(" ")); };
    console.info = console.log;
    console.debug = console.log;
    console.warn = function () { pushLog("[warn] " + Array.prototype.map.call(arguments, String).join(" ")); };
    console.error = function () { pushLog("[error] " + Array.prototype.map.call(arguments, String).join(" ")); };
    function emitFile(file) {
      if (!filesOpen) throw new Error("Execution has already finished");
      if (!file || typeof file !== "object" || typeof file.path !== "string" ||
          file.path.length < 1 || file.path.length > ${LIMITS.filePathChars}) {
        throw new TypeError("emitFile requires a path of 1-${LIMITS.filePathChars} characters");
      }
      if (file.workspace !== "current" && file.workspace !== "personal") {
        throw new TypeError("emitFile workspace must be current or personal");
      }
      if (file.contentType !== undefined && (typeof file.contentType !== "string" ||
          file.contentType.length < 1 || file.contentType.length > ${LIMITS.fileContentTypeChars})) {
        throw new TypeError("emitFile contentType must be 1-${LIMITS.fileContentTypeChars} characters");
      }
      if (!(file.bytes instanceof Uint8Array) && !(file.bytes instanceof ArrayBuffer)) {
        throw new TypeError("emitFile bytes must be a Uint8Array or ArrayBuffer");
      }
      if (files.length >= ${LIMITS.files} || fileBytes + file.bytes.byteLength > ${LIMITS.fileBytes}) {
        throw new Error("File output limit exceeded");
      }
      // Copy now, including only the selected typed-array range.
      var bytes = new Uint8Array(file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file.bytes);
      fileBytes += bytes.byteLength;
      files.push({ workspace: file.workspace, path: file.path, ...(file.contentType === undefined ? {} : { contentType: file.contentType }), bytes });
    }
    function readViewport() {
      try {
        var size = page.viewportSize();
        if (size && typeof size.width === "number" && typeof size.height === "number") {
          return { width: size.width, height: size.height };
        }
      } catch (e) {}
      return null;
    }
    var browser;
    try {
      // The gate resolves this app session id through the trusted command bridge.
      var endpoint = "http://fake.host/v1/devtools/browser/" + input.sessionId + "?persistent=true&browser_binding=BROWSER";
      browser = await connect(endpoint);
      var contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error("Unexpected browser contexts: " + contexts.length);
      var pages = contexts[0].pages();
      if (pages.length !== 1) throw new Error("Unexpected browser pages: " + pages.length);
      var page = pages[0];
      page.on("console", function (message) {
        try { pushBounded(consoleEntries, message.type() + ": " + message.text().slice(0, 500)); } catch (e) {}
      });
      page.on("pageerror", function (error) {
        try { pushBounded(pageErrors, String((error && error.message) || error).slice(0, 500)); } catch (e) {}
      });
      var runtimeOrigin = input.runtimeOrigin;
      function findOuter() {
        return page.mainFrame().childFrames().find(function (candidate) {
          try { return new URL(candidate.url()).origin === runtimeOrigin; } catch (e) { return false; }
        }) || null;
      }
      // Child frames attach after the fresh connection; poll briefly instead
      // of reading the tree once.
      async function waitForFrame(find, timeoutMs, label) {
        var deadline = Date.now() + timeoutMs;
        while (true) {
          var found = find();
          if (found) return found;
          if (Date.now() >= deadline) {
            var kids = [];
            try {
              kids = page.mainFrame().childFrames().map(function (candidate) {
                try { return candidate.name() + "|" + candidate.url(); } catch (e) { return "<unreadable>"; }
              });
            } catch (e) {}
            var mainUrl = "";
            try { mainUrl = page.mainFrame().url(); } catch (e) {}
            var domIframes = "?";
            try { domIframes = String(await page.evaluate("document.querySelectorAll('iframe').length")); } catch (e) {}
            throw new Error(label + " main=" + mainUrl + " kids=" + JSON.stringify(kids) + " domIframes=" + domIframes);
          }
          await new Promise(function (resolve) { setTimeout(resolve, 100); });
        }
      }
      var outer = await waitForFrame(findOuter, 10000, "Preview frame not found.");
      var frame = await waitForFrame(function () {
        var kids = outer.childFrames();
        return kids.length === 1 ? kids[0] : null;
      }, 10000, "Preview content not ready.");
      // The viewport is per-connection server-side: re-apply the session size
      // on every fresh connection before user code runs.
      await page.setViewportSize({ width: input.viewport.width, height: input.viewport.height });
      var __result = await Promise.race([
        // A regular function called with undefined receiver: user code must
        // not inherit the entrypoint this value (which exposes the loader env).
        (async function __snippet(page, frame, expect, emitFile) {
`;

const EXECUTOR_SUFFIX = `
        }).call(undefined, page, frame, expect, emitFile),
        new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error("Execution timed out")); }, timeoutMs); }),
      ]);
      filesOpen = false;
      var __resultJson;
      try {
        __resultJson = __result === undefined ? "null" : JSON.stringify(__result);
      } catch (e) {
        return { ok: false, error: { name: "TypeError", message: "Result is not JSON-serializable" }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated };
      }
      if (typeof __resultJson !== "string") __resultJson = "null";
      return { ok: true, resultJson: __resultJson, files: files, viewport: readViewport(), popups: { blocked: 0, urls: [] }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated };
    } catch (err) {
      var __name = err && err.name ? String(err.name) : "Error";
      var __message = err && err.message ? String(err.message) : String(err);
      return { ok: false, error: { name: __name, message: __message }, viewport: readViewport(), popups: { blocked: 0, urls: [] }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated };
    } finally {
      filesOpen = false;
      clearTimeout(timer);
      try { if (browser) await browser.close(); } catch (e) {}
    }
  }
}
`;

export function build_executor_module(user_code: string): string {
	return EXECUTOR_PREFIX + user_code + EXECUTOR_SUFFIX;
}

// One-session connection gate
//
// The snippet's only browser binding. It allows exactly one WebSocket upgrade
// path for the assigned provider session and rebuilds the upstream request
// from trusted values. Acquisition, inventory, history, limits, other session
// ids, unexpected queries, and non-upgrade requests are refused. The single
// allowed query is `persistent=true`: without it the provider disposes the
// session targets when a client disconnects.

const GATE_UPGRADE_PATH_PREFIX = "/v1/devtools/browser/";
const GATE_FAKE_HOST = "http://fake.host";

export function validate_gate_request(
	request: Request,
	assignedSessionId: string,
): { ok: true } | { ok: false; reason: string } {
	if (!assignedSessionId) return { ok: false, reason: "unassigned" };
	if (request.method !== "GET") return { ok: false, reason: "method" };

	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return { ok: false, reason: "url" };
	}
	if (url.pathname !== `${GATE_UPGRADE_PATH_PREFIX}${assignedSessionId}`) return { ok: false, reason: "path" };
	// Persistent is the only allowed query. Targets created without it are
	// disposed when their client disconnects, which breaks reconnects.
	if (url.search !== "?persistent=true") return { ok: false, reason: "query" };
	if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
		return { ok: false, reason: "upgrade" };
	}
	return { ok: true };
}

export async function handle_gate_request(
	request: Request,
	props: BrowserConnectionGatewayProps,
	sessions: DurableObjectNamespaceStub,
): Promise<Response> {
	const check = validate_gate_request(request, props.sessionId);
	if (!check.ok) {
		log_browser({ route: "gate", refused: check.reason, commandId: props.commandId });
		return new Response("Forbidden browser request", { status: 403 });
	}

	const url = new URL("https://do/run/stream");
	for (const [name, value] of Object.entries(props)) url.searchParams.set(name, value);
	const stub = sessions.get(sessions.idFromName(session_object_name(props.ownerId, props.organizationId, props.workspaceId)));
	return await stub.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
}

export class BrowserConnectionGateway extends WorkerEntrypoint<Env, BrowserConnectionGatewayProps> {
	async fetch(request: Request): Promise<Response> {
		return await handle_gate_request(request, this.ctx.props, this.env.BROWSER_SESSIONS);
	}

	connect(): never {
		throw new Error("TCP connect is not allowed.");
	}
}

// Snippet file validation
//
// The child shares its harness with untrusted code. Check the transport shape
// and raw byte budget again here. The app owns Files path and MIME rules.
// The workspace selects a file destination, not a browser session or access grant.

export function validate_snippet_files(files: unknown): (
	| { ok: true; files: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; dataBase64: string }>; fileBytes: number }
	| { ok: false; reason: string }
) {
	if (!Array.isArray(files)) return { ok: false, reason: "files_shape" };
	if (files.length > LIMITS.files) return { ok: false, reason: "files_count" };
	const validated: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; dataBase64: string }> = [];
	let fileBytes = 0;
	for (const file of files) {
		if (!is_record(file) || typeof file.path !== "string" || file.path.length < 1 || file.path.length > LIMITS.filePathChars ||
			(file.workspace !== "current" && file.workspace !== "personal") ||
			!(file.bytes instanceof Uint8Array) || (file.contentType !== undefined &&
				(typeof file.contentType !== "string" || file.contentType.length < 1 || file.contentType.length > LIMITS.fileContentTypeChars))) {
			return { ok: false, reason: "files_shape" };
		}
		fileBytes += file.bytes.byteLength;
		if (fileBytes > LIMITS.fileBytes) return { ok: false, reason: "files_bytes" };
		// Encode whole three-byte groups so concatenated chunks retain valid base64.
		const parts: string[] = [];
		for (let offset = 0; offset < file.bytes.byteLength; offset += 3 * 8192) {
			parts.push(btoa(String.fromCharCode(...file.bytes.subarray(offset, offset + 3 * 8192))));
		}
		validated.push({ workspace: file.workspace, path: file.path, ...(file.contentType === undefined ? {} : { contentType: file.contentType }), dataBase64: parts.join("") });
	}
	return { ok: true, files: validated, fileBytes };
}

// Session transitions
//
// Pure decisions over the stored record. The object applies them; unit tests
// cover them without a provider.

function agent_lease_refusal(record: SessionRecord, lease: AgentLease) {
	if (record.navGen !== lease.navGen) return "stale_nav";
	if (record.loadGen !== lease.loadGen) return "stale_load";
	if (record.controlGen !== lease.controlGen) return "stale_control";
	if (record.control !== "ready") return "control";
	if (record.command) return "busy";
	return null;
}

export function session_is_expired(record: SessionRecord, now: number): boolean {
	if (record.providerAcquiredAt !== null && now - record.providerAcquiredAt >= LIMITS.sessionTotalMs) {
		return true;
	}
	return now - record.lastActiveAt >= LIMITS.sessionIdleMs;
}

export function session_next_alarm(record: SessionRecord): number | null {
	if (record.control === "closed") return null;
	const deadlines: number[] = [record.lastActiveAt + LIMITS.sessionIdleMs];
	if (record.providerAcquiredAt !== null) {
		deadlines.push(record.providerAcquiredAt + LIMITS.sessionTotalMs);
	}
	if (record.control === "starting") {
		deadlines.push(record.createdAt + LIMITS.startingStaleMs);
	}
	if (record.command) {
		deadlines.push(record.command.startedAt + LIMITS.commandTimeoutMs + 10_000);
	}
	return Math.min(...deadlines);
}

export function session_can_run(
	record: SessionRecord,
	input: { sessionId: string; navGen: number; loadGen: number; controlGen: number },
	now: number,
): { ok: true } | { ok: false; reason: string } {
	if (record.sessionId !== input.sessionId) return { ok: false, reason: "stale_session" };
	if (record.control === "closed" || record.control === "closing") return { ok: false, reason: "closed" };
	if (session_is_expired(record, now)) return { ok: false, reason: "expired" };
	if (record.navGen !== input.navGen) return { ok: false, reason: "stale_nav" };
	if (record.loadGen !== input.loadGen) return { ok: false, reason: "stale_load" };
	// Control state before generations: a caller with a retired lease still
	// deserves the actionable reason while a human holds the page.
	if (record.control !== "ready" && record.control !== "agent") return { ok: false, reason: "control" };
	if (record.controlGen !== input.controlGen) return { ok: false, reason: "stale_control" };
	if (record.command && now - record.command.startedAt < LIMITS.commandTimeoutMs + 10_000) {
		return { ok: false, reason: "busy" };
	}
	if (record.commandCount >= LIMITS.commandsPerSession) return { ok: false, reason: "session_limit" };
	if (!record.providerSessionId || !record.pageNonce) return { ok: false, reason: "not_ready" };
	return { ok: true };
}

// Registry object
//
// Owns deployment-wide and per-workspace admission slots. Claims expire fast so
// a crash between claim and open cannot leak a slot.

function sweep_registry(record: RegistryRecord, now: number): void {
	for (const [grantId, grant] of Object.entries(record.grants)) {
		// Claimed grants expire fast; active grants carry a 24 h backstop far beyond any
		// session lifetime, so a lost release wedges a slot for a day at most, never forever.
		if (grant.expiresAt !== null && grant.expiresAt <= now) {
			delete record.grants[grantId];
		}
	}
}

function count_registry(record: RegistryRecord, workspaceKey: string): { deployment: number; workspace: number } {
	let deployment = 0;
	let workspace = 0;
	for (const grant of Object.values(record.grants)) {
		deployment += 1;
		if (grant.workspaceKey === workspaceKey) workspace += 1;
	}
	return { deployment, workspace };
}

export class BrowserRegistry {
	private state: DurableObjectStateStub;
	private env: Env;

	constructor(state: DurableObjectStateStub, env: Env) {
		this.state = state;
		this.env = env;
	}

	private async load(): Promise<RegistryRecord> {
		return (await this.state.storage.get<RegistryRecord>(REGISTRY_KEY)) ?? { grants: {} };
	}

	private async save(record: RegistryRecord): Promise<void> {
		await this.state.storage.put(REGISTRY_KEY, record);
		let next: number | null = null;
		for (const grant of Object.values(record.grants)) {
			if (grant.state === "claimed" && grant.expiresAt !== null) {
				next = next === null ? grant.expiresAt : Math.min(next, grant.expiresAt);
			}
		}
		if (next === null) {
			await this.state.storage.deleteAlarm();
		} else {
			await this.state.storage.setAlarm(next);
		}
	}

	private async claim(workspaceKey: string): Promise<Response> {
		const record = await this.load();
		const now = Date.now();
		sweep_registry(record, now);
		const counts = count_registry(record, workspaceKey);
		if (counts.deployment >= LIMITS.deploymentSessions) {
			log_browser({ route: "registry_claim", refused: "deployment_busy" });
			return json_response({ ok: false, error: { code: "deployment_busy" } }, 200);
		}
		if (counts.workspace >= LIMITS.workspaceSessions) {
			log_browser({ route: "registry_claim", refused: "workspace_busy" });
			return json_response({ ok: false, error: { code: "workspace_busy" } }, 200);
		}

		const grantId = crypto.randomUUID();
		record.grants[grantId] = { workspaceKey, state: "claimed", expiresAt: now + LIMITS.grantTtlMs };
		await this.save(record);
		return json_response({ ok: true, grantId }, 200);
	}

	private async confirm(grantId: string): Promise<Response> {
		const record = await this.load();
		const grant = record.grants[grantId];
		if (!grant) return json_response({ ok: false, error: { code: "unknown_grant" } }, 200);
		grant.state = "active";
		grant.expiresAt = Date.now() + LIMITS.grantActiveMs;
		await this.save(record);
		return json_response({ ok: true }, 200);
	}

	private async release(grantId: string): Promise<Response> {
		const record = await this.load();
		delete record.grants[grantId];
		await this.save(record);
		return json_response({ ok: true }, 200);
	}

	async alarm(): Promise<void> {
		const record = await this.load();
		sweep_registry(record, Date.now());
		await this.save(record);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST") return json_response({ ok: false, error: { code: "not_found" } }, 404);

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json_response({ ok: false, error: { code: "invalid_json" } }, 400);
		}
		if (!is_record(body)) return json_response({ ok: false, error: { code: "invalid_request" } }, 400);

		if (url.pathname === "/claim" && typeof body.workspaceKey === "string") {
			return await this.claim(body.workspaceKey);
		}
		if (url.pathname === "/confirm" && typeof body.grantId === "string") {
			return await this.confirm(body.grantId);
		}
		if (url.pathname === "/release" && typeof body.grantId === "string") {
			return await this.release(body.grantId);
		}
		return json_response({ ok: false, error: { code: "not_found" } }, 404);
	}
}

// Trusted provider operations
//
// The object runs these with the real BROWSER binding. acquire() plus
// connect() keeps session ownership explicit: browser.close() on such a
// connection only drops the client, never the session.

const CONTROLLER_PATTERN = `${CONTROLLER_ORIGIN}/**`;

// Browser egress: esm.sh modules only. The runtime bytes arrive through the
// controller route, not the network. The provider fixes this policy at acquisition;
// snippet code cannot change it through Playwright routes or a later connection.
const BROWSER_EGRESS_HOSTS = ["esm.sh"];

// Persistent URL form, the only supported reconnect path. The provider
// disposes session targets when a non-persistent client disconnects; a fresh
// non-persistent connect then sees zero contexts. browser_binding resolves
// this worker's BROWSER binding inside connect(). Proven in the 8D gate.
function connect_persistent(providerSessionId: string): ReturnType<typeof connect> {
	return connect(
		`http://fake.host/v1/devtools/browser/${providerSessionId}?persistent=true&browser_binding=BROWSER`,
	);
}

type RuntimeAssets = {
	indexHtml: string;
	headers: Record<string, string>;
	assets: Map<string, { text: string; contentType: string }>;
};

// The provider transport does not report cross-origin child frames, so the
// runtime must load same-origin with the controller. Fetch its exact bytes
// and security headers from the deployed preview host and serve them through
// the controller route below. Same bytes, same policy, tighter allowlist.
async function fetch_runtime_assets(previewUrl: string): Promise<RuntimeAssets> {
	const indexResponse = await fetch(previewUrl);
	if (!indexResponse.ok) throw new Error(`Preview runtime unavailable: ${indexResponse.status}.`);
	const indexHtml = await indexResponse.text();
	if (byte_length(indexHtml) > 65_536) throw new Error("Preview runtime index too large.");

	const headers: Record<string, string> = {};
	for (const name of [
		"content-security-policy",
		"referrer-policy",
		"x-content-type-options",
		"permissions-policy",
		"cross-origin-opener-policy",
		"origin-agent-cluster",
	]) {
		const value = indexResponse.headers.get(name);
		if (value) headers[name] = value;
	}

	const assets = new Map<string, { text: string; contentType: string }>();
	const paths = [...new Set(indexHtml.match(/\/assets\/[A-Za-z0-9_.\-]+/g) ?? [])];
	if (paths.length > 10) throw new Error("Preview runtime references too many assets.");
	const previewOrigin = new URL(previewUrl).origin;
	for (const path of paths) {
		const assetResponse = await fetch(`${previewOrigin}${path}`);
		if (!assetResponse.ok) throw new Error(`Preview asset unavailable: ${path}.`);
		const text = await assetResponse.text();
		if (byte_length(text) > 1_048_576) throw new Error(`Preview asset too large: ${path}.`);
		assets.set(path, {
			text,
			contentType: path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
		});
	}
	return { indexHtml, headers, assets };
}

async function load_controller_page(page: Page, input: { previewUrl: string; html: string }): Promise<string> {
	const runtime = await fetch_runtime_assets(input.previewUrl);
	const sessionId = crypto.randomUUID();
	const loadId = crypto.randomUUID();
	const nonce = `${crypto.randomUUID()}-${Math.floor(Math.random() * 1_000_000_000)}`;
	const controllerHtml = build_controller_html({
		runtimeUrl: `${CONTROLLER_ORIGIN}/v0`,
		sessionId,
		loadId,
		nonce,
		html: input.html,
	});

	await page.unroute(CONTROLLER_PATTERN);
	await page.route(CONTROLLER_PATTERN, async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (pathname === "/") {
			await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: controllerHtml });
			return;
		}
		if (pathname === "/v0") {
			await route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				headers: runtime.headers,
				body: runtime.indexHtml,
			});
			return;
		}
		const asset = runtime.assets.get(pathname);
		if (asset) {
			await route.fulfill({ status: 200, contentType: asset.contentType, body: asset.text });
			return;
		}
		await route.abort();
	});
	await page.goto(CONTROLLER_URL, { waitUntil: "load" });
	// waitForFunction takes (expression, arg, options): pass the timeout
	// as options with a null arg, not as the arg.
	await page.waitForFunction("window.__browserReady === true || window.__browserError !== null", null, {
		timeout: 20_000,
	});
	const outcome = await page.evaluate(
		"({ ready: window.__browserReady === true, error: window.__browserError, nonce: window.__browserNonce })",
	);
	if (!is_record(outcome) || outcome.ready !== true || outcome.nonce !== nonce) {
		const detail = is_record(outcome) && typeof outcome.error === "string" ? outcome.error : "unknown";
		throw new Error(`Preview load failed: ${detail}`);
	}
	return nonce;
}

async function bootstrap_browser(input: {
	browser: BrowserWorker;
	previewUrl: string;
	html: string;
	viewport: { width: number; height: number };
}): Promise<{ providerSessionId: string; pageNonce: string; contexts: number; pages: number }> {
	// Fail fast when the preview host is unreachable, before spending browser time.
	await fetch_runtime_assets(input.previewUrl);
	const acquired = await acquire(input.browser, {
		keep_alive: LIMITS.keepAliveMs,
		recording: false,
		// Fixed for the session lifetime, including navigation. A blocked request returns
		// a guardrail 403 at the requested URL, so target checks still close that page.
		guardrails: { allowedDomains: BROWSER_EGRESS_HOSTS },
	});
	const providerSessionId = acquired.sessionId;
	try {
		const browser = await connect_persistent(providerSessionId);
		try {
			const contexts = browser.contexts();
			const context = contexts[0] ?? (await browser.newContext());
			const page = context.pages()[0] ?? (await context.newPage());
			const nonce = await load_controller_page(page, { previewUrl: input.previewUrl, html: input.html });
			// Set the viewport after load: an earlier size does not survive
			// the first navigation on this transport.
			await page.setViewportSize({ width: input.viewport.width, height: input.viewport.height });
			const endContexts = browser.contexts().length;
			const endPages = browser.contexts()[0]?.pages().length ?? 0;
			if (endContexts !== 1 || endPages !== 1) {
				throw new Error("Unexpected targets after bootstrap.");
			}
			return { providerSessionId, pageNonce: nonce, contexts: endContexts, pages: endPages };
		} finally {
			try {
				await browser.close();
			} catch {
				// The client connection is best-effort; the session persists
				// server-side under keep-alive.
			}
		}
	} catch (error) {
		// Bootstrap failed after acquire. Remove the orphan session now; the
		// provider keep-alive expiry is the final backstop.
		try {
			await close_browser_provider(input.browser, providerSessionId);
		} catch {
			// Ignored: the backstop still applies.
		}
		throw error;
	}
}

async function close_browser_provider(browser: BrowserWorker, providerSessionId: string): Promise<boolean> {
	try {
		const connected = await connect_persistent(providerSessionId);
		try {
			const cdp = await connected.newBrowserCDPSession();
			await cdp.send("Browser.close", {});
		} finally {
			try {
				await connected.close();
			} catch {
				// Ignored: the session is already going away.
			}
		}
	} catch (error) {
		// A missing session is already closed.
		if (error instanceof Error && /unable to connect to browser/i.test(error.message)) return true;
		throw error;
	}

	const deadline = Date.now() + LIMITS.closeVerifyMs;
	while (Date.now() < deadline) {
		const active = await sessions(browser);
		if (!active.some((entry) => entry.sessionId === providerSessionId)) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

// Session object
//
// Owns one owner/organization/workspace slot: the session record, the command
// lock, generations, deadlines, and provider cleanup.

type SessionOpenInput = {
	grantId: string;
	attemptId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	nodeId: string;
	navGen: number;
	sourceKind: string;
	sourceVersion: string;
	sourceHash: string;
	html: string;
	viewport: { width: number; height: number };
};

type ViewerStream = {
	socket: WebSocket;
	sessionId: string;
	viewerId: string;
	frameSeqs: number[];
	lastFrameSeq: number;
	deadlineTimer: ReturnType<typeof setTimeout> | null;
};

export class BrowserSession {
	private state: DurableObjectStateStub;
	private env: Env;
	private viewerStreams = new Map<string, ViewerStream>();
	private pendingViewers = 0;
	private viewerRecord: SessionRecord | null = null;
	private viewerProducer: { browser: Awaited<ReturnType<typeof connect>>; page: Page; cdp: CDPSession } | null = null;
	private viewerStart: Promise<void> | null = null;
	private viewerLifecycle: Promise<void> = Promise.resolve();
	private viewerCleanup: Promise<void> = Promise.resolve();
	private viewerProducerGen = 0;
	private viewerFrame: { seq: number; loadGen: number; bytes: Uint8Array<ArrayBuffer> } | null = null;
	private viewerFrameSeq = 0;
	private inputQueue: Promise<void> = Promise.resolve();
	private inputDepth = 0;
	private inputEpoch = 0;
	private inputTransition = false;
	private inputTransitionDone: Promise<unknown> = Promise.resolve();
	private pointerPosition: { x: number; y: number } | null = null;
	private pressedButtons = new Set<"left" | "middle" | "right">();
	private pressedKeys = new Set<string>();
	private agentConnection: { sessionId: string; commandId: string; bridge: AgentConnection | null } | null = null;
	private hostConnection: {
		sessionId: string;
		browser: Awaited<ReturnType<typeof connect>>;
		page: Page;
		cdp: CDPSession;
		browserCdp: CDPSession;
		targetId: string;
		contextId: string | undefined;
	} | null = null;
	private hostStart: { sessionId: string; promise: Promise<void> } | null = null;

	constructor(state: DurableObjectStateStub, env: Env) {
		this.state = state;
		this.env = env;
	}

	private async load(): Promise<SessionRecord | null> {
		const record = await this.state.storage.get<SessionRecord>(SESSION_KEY);
		if (!record) return null;
		// Records written before newer fields existed get safe defaults.
		// The next save persists them.
		const viewport = (record as { viewport?: unknown }).viewport;
		if (
			!is_record(viewport) ||
			!is_positive_int(viewport.width) ||
			!is_positive_int(viewport.height) ||
			viewport.width < LIMITS.viewportMin ||
			viewport.height < LIMITS.viewportMin ||
			viewport.width > LIMITS.viewportMaxWidth ||
			viewport.height > LIMITS.viewportMaxHeight
		) {
			record.viewport = { width: 1280, height: 900 };
		}
		const shaped = record as {
			viewers?: unknown;
			viewerGrants?: unknown;
			inputHolder?: unknown;
		};
		if (!is_record(shaped.viewers)) record.viewers = {};
		if (!is_record(shaped.viewerGrants)) record.viewerGrants = {};
		if (typeof shaped.inputHolder !== "string" && shaped.inputHolder !== null) record.inputHolder = null;
		return record;
	}

	private async save(record: SessionRecord): Promise<void> {
		await this.state.storage.put(SESSION_KEY, record);
		this.sync_viewers(record);
		await this.schedule_alarm(record);
	}

	private async schedule_alarm(record: SessionRecord): Promise<void> {
		const next = session_next_alarm(record);
		if (next === null) {
			await this.state.storage.deleteAlarm();
		} else {
			await this.state.storage.setAlarm(next);
		}
	}

	private registry(): DurableObjectStubStub {
		return this.env.BROWSER_REGISTRY.get(this.env.BROWSER_REGISTRY.idFromName(REGISTRY_NAME));
	}

	private async release_grant(grantId: string): Promise<void> {
		// Retry a few times; anything left over expires via the 24 h active backstop, so a
		// failed release must not fail close.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this.registry().fetch(
					new Request("https://do/release", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ grantId }),
					}),
				);
				return;
			} catch {
				// Retry, then fall through to expiry.
			}
		}
	}

	private public_meta(record: SessionRecord) {
		return {
			sessionId: record.sessionId,
			nodeId: record.nodeId,
			navGen: record.navGen,
			loadGen: record.loadGen,
			controlGen: record.controlGen,
			control: record.control,
			sourceKind: record.sourceKind,
			sourceVersion: record.sourceVersion,
			sourceHash: record.sourceHash,
			pageNonce: record.pageNonce,
			commandCount: record.commandCount,
			loadCount: record.loadCount,
			idleUntil: record.lastActiveAt + LIMITS.sessionIdleMs,
			totalUntil: record.providerAcquiredAt! + LIMITS.sessionTotalMs,
		};
	}

	private async open(input: SessionOpenInput): Promise<Response> {
		const now = Date.now();
		const existing = await this.load();
		if (existing && existing.control !== "closed") {
			const staleStarting =
				existing.control === "starting" && now - existing.createdAt >= LIMITS.startingStaleMs;
			if (!staleStarting) {
				log_browser({ route: "open", refused: "busy", control: existing.control });
				return operation_refused("busy", "A browser is already active for this workspace.");
			}
			// A stale start never finished bootstrap. Close its known
			// provider session, then take over the slot.
			await this.close_record(existing, "stale_start");
		}

		if (!this.env.BROWSER_PREVIEW_URL) {
			return json_response(
				{ ok: false, error: { code: "misconfigured", message: "Preview runtime is not configured." } },
				503,
			);
		}

		const sessionId = crypto.randomUUID();
		const record: SessionRecord = {
			version: 1,
			sessionId,
			grantId: input.grantId,
			ownerId: input.ownerId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			nodeId: input.nodeId,
			navGen: input.navGen,
			loadGen: 1,
			controlGen: 1,
			control: "starting",
			sourceKind: input.sourceKind,
			sourceVersion: input.sourceVersion,
			sourceHash: input.sourceHash,
			providerSessionId: null,
			pageNonce: null,
			viewport: input.viewport,
			command: null,
			commandCount: 0,
			htmlBytesTotal: byte_length(input.html),
			loadCount: 1,
			createdAt: now,
			providerAcquiredAt: null,
			lastActiveAt: now,
			attemptId: input.attemptId,
			closeAttempts: 0,
			inputHolder: null,
			viewers: {},
			viewerGrants: {},
		};

		try {
			const acquiredAt = Date.now();
			const bootstrapped = await bootstrap_browser({
				browser: this.env.BROWSER,
				previewUrl: this.env.BROWSER_PREVIEW_URL,
				html: input.html,
				viewport: input.viewport,
			});
			record.providerSessionId = bootstrapped.providerSessionId;
			record.providerAcquiredAt = acquiredAt;
			record.pageNonce = bootstrapped.pageNonce;
			record.control = "ready";
			record.lastActiveAt = Date.now();
			await this.save(record);
			log_browser({
				route: "open",
				sessionId,
				loadGen: record.loadGen,
				htmlBytes: record.htmlBytesTotal,
				contexts: bootstrapped.contexts,
				pages: bootstrapped.pages,
			});
		} catch (error) {
			// Nothing is persisted yet, so there is no record to close. The
			// bootstrap helper already removed an orphan provider session.
			// The host releases the admission grant on this failure.
			const failure = sanitize_error(error);
			log_browser({ route: "open", refused: "bootstrap_failed", attemptId: input.attemptId });
			return json_response(
				{ ok: false, error: { code: "bootstrap_failed", message: failure.message } },
				200,
			);
		}

		return json_response({ ok: true, session: this.public_meta(record) }, 200);
	}

	private async connect_host(record: SessionRecord): Promise<void> {
		if (this.hostStart?.sessionId === record.sessionId) return this.hostStart.promise;
		if (this.hostConnection?.sessionId === record.sessionId) return;
		const start = (async () => {
			if (!record.providerSessionId) throw new Error("Browser is unavailable.");
			const browser = await connect_persistent(record.providerSessionId);
			let phase = "target";
			try {
				const current = await this.load();
				if (!current || current.sessionId !== record.sessionId || current.control === "closing" || current.control === "closed") {
					throw new Error("Browser session changed.");
				}
				const contexts = browser.contexts();
				const page = contexts[0]?.pages()[0];
				if (contexts.length !== 1 || contexts[0]?.pages().length !== 1 || !page) throw new Error("Unexpected browser targets.");
				const cdp = await page.context().newCDPSession(page);
				const info: unknown = await cdp.send("Target.getTargetInfo");
				if (!is_record(info) || !is_record(info.targetInfo) || !is_non_empty_string(info.targetInfo.targetId) ||
					(info.targetInfo.browserContextId !== undefined && typeof info.targetInfo.browserContextId !== "string")) {
					throw new Error("Browser target is unavailable.");
				}
				phase = "browser_attach";
				const browserCdp = await browser.newBrowserCDPSession();
				phase = "contexts";
				const inventory: unknown = await browserCdp.send("Target.getBrowserContexts");
				if (!is_record(inventory) || !Array.isArray(inventory.browserContextIds) ||
					inventory.browserContextIds.some((id) => typeof id !== "string")) throw new Error("Browser contexts are unavailable.");
				// getBrowserContexts lists explicit contexts; omit the default context id.
				const contextId = inventory.browserContextIds.includes(info.targetInfo.browserContextId ?? "") ? info.targetInfo.browserContextId : undefined;
				phase = "downloads";
				await browserCdp.send("Browser.setDownloadBehavior", {
					behavior: "deny", eventsEnabled: false,
					...(contextId ? { browserContextId: contextId } : {}),
				});
				const latest = await this.load();
				if (!latest || latest.sessionId !== record.sessionId || latest.control === "closing" || latest.control === "closed") {
					throw new Error("Browser session changed.");
				}
				const host = { sessionId: record.sessionId, browser, page, cdp, browserCdp, targetId: info.targetInfo.targetId, contextId };
				this.hostConnection = host;
				// Page timers can outlive a command, so target checks stay on this connection.
				page.on("framenavigated", (frame) => {
					if (this.hostConnection !== host || frame !== page.mainFrame()) return;
					const command = this.viewerRecord?.command;
					if (command && command.connection === undefined && frame.url() === CONTROLLER_URL) return;
					this.agentConnection?.bridge?.revoke();
					this.state.waitUntil(this.load().then(async (current) => {
						if (current?.sessionId === host.sessionId) await this.close_record(current, "page_navigated");
					}));
				});
				page.context().on("page", (popup) => {
					if (this.hostConnection !== host || popup === page) return;
					this.state.waitUntil(popup.close().catch(async () => {
						if (popup.isClosed()) return;
						const current = await this.load();
						if (current?.sessionId === host.sessionId) await this.close_record(current, "popup_cleanup_failed");
					}));
				});
				browser.on("disconnected", () => {
					if (this.hostConnection !== host) return;
					this.hostConnection = null;
					this.state.waitUntil(this.load().then(async (current) => {
						if (current?.sessionId === host.sessionId) await this.close_record(current, "host_disconnected");
					}));
				});
				// Reconnect can miss targets created before these listeners were installed.
				phase = "target_check";
				const [checkedContexts, checkedTargets] = await Promise.all([
					browserCdp.send("Target.getBrowserContexts"), browserCdp.send("Target.getTargets"),
				]);
				const contextIds: unknown = checkedContexts.browserContextIds;
				const targetInfos: unknown = checkedTargets.targetInfos;
				if (!Array.isArray(contextIds) || contextIds.some((id) => typeof id !== "string" || id !== contextId) ||
					!Array.isArray(targetInfos)) throw new Error("Unexpected browser targets.");
				const pages = targetInfos.filter((target: unknown) => is_record(target) && target.type === "page");
				if (pages.length !== 1 || !is_record(pages[0]) || pages[0].targetId !== host.targetId) {
					throw new Error("Unexpected browser targets.");
				}
				phase = "page_check";
				const document: unknown = await page.evaluate("({url: location.href, nonce: window.__browserNonce})");
				if (!is_record(document) || document.url !== CONTROLLER_URL || document.nonce !== record.pageNonce) {
					throw new Error("Browser page changed.");
				}
				const checked = await this.load();
				if (this.hostConnection !== host || checked?.sessionId !== record.sessionId ||
					checked.control === "closing" || checked.control === "closed") throw new Error("Browser session changed.");
			} catch (error) {
				log_browser({ route: "host_connect", phase, error: sanitize_error(error).name });
				const current = await this.load();
				if (current?.sessionId === record.sessionId) await this.close_record(current, "host_setup_failed");
				await browser.close().catch(() => {});
				throw error;
			}
		})();
		const pending = { sessionId: record.sessionId, promise: start.finally(() => {
			if (this.hostStart === pending) this.hostStart = null;
		}) };
		this.hostStart = pending;
		return pending.promise;
	}

	private async agent_stream(url: URL): Promise<Response> {
		const record = await this.load();
		const sessionId = url.searchParams.get("sessionId");
		const commandId = url.searchParams.get("commandId");
		if (!record || record.sessionId !== sessionId || record.ownerId !== url.searchParams.get("ownerId") ||
			record.organizationId !== url.searchParams.get("organizationId") || record.workspaceId !== url.searchParams.get("workspaceId") ||
			record.command?.id !== commandId || record.command.connection !== "available" || this.agentConnection ||
			(record.control !== "agent" && record.control !== "pausing") || session_is_expired(record, Date.now())) {
			return new Response("Browser command is unavailable", { status: 403 });
		}
		// Reserve before any provider await. A second upgrade cannot spend this command.
		const connection = { sessionId: record.sessionId, commandId: record.command.id, bridge: null as AgentConnection | null };
		this.agentConnection = connection;
		record.command.connection = "consumed";
		await this.save(record);
		let upstream: WebSocket | null = null;
		let acceptingUpgrade = true;
		try {
			await with_wall_timeout(this.connect_host(record), 10_000);
			const beforeUpgrade = await this.load();
			if (this.agentConnection !== connection || beforeUpgrade?.sessionId !== record.sessionId ||
				beforeUpgrade.command?.id !== connection.commandId || beforeUpgrade.command.connection !== "consumed" ||
				(beforeUpgrade.control !== "agent" && beforeUpgrade.control !== "pausing")) throw new Error("Browser command changed.");
			const response = await with_wall_timeout(this.env.BROWSER.fetch(
				`${GATE_FAKE_HOST}${GATE_UPGRADE_PATH_PREFIX}${record.providerSessionId}?persistent=true`,
				{ headers: { Upgrade: "websocket" } },
			).then((response) => {
				// A timed-out fetch can still return an open provider socket.
				if (!acceptingUpgrade && response.webSocket) {
					response.webSocket.accept();
					close_socket(response.webSocket, 1000, "command ended");
				}
				return response;
			}), 10_000);
			upstream = response.webSocket ?? null;
			const current = await this.load();
			const host = this.hostConnection;
			if (!upstream || response.status !== 101 || !host || host.sessionId !== record.sessionId ||
				this.agentConnection !== connection || current?.sessionId !== record.sessionId ||
				current.command?.id !== connection.commandId || current.command.connection !== "consumed" ||
				(current.control !== "agent" && current.control !== "pausing") || session_is_expired(current, Date.now())) {
				throw new Error("Browser command changed.");
			}
			const [client, server] = Object.values(new WebSocketPair());
			connection.bridge = new AgentConnection({
				upstream, downstream: server, targetId: host.targetId,
				deadline: record.command.startedAt + LIMITS.childWallMs,
				onPopup: async (targetId) => {
					try {
						const closed: unknown = await host.browserCdp.send("Target.closeTarget", { targetId });
						if (is_record(closed) && closed.success === true) return;
					} catch { /* The host page listener may have closed it first. */ }
					const targets: unknown = await host.browserCdp.send("Target.getTargets");
					if (is_record(targets) && Array.isArray(targets.targetInfos) &&
						targets.targetInfos.every((target) => is_record(target) && is_non_empty_string(target.targetId)) &&
						!targets.targetInfos.some((target) => target.targetId === targetId)) return;
					throw new Error("Popup could not be closed.");
				},
				onUnsafe: (reason) => {
					log_browser({ route: "agent_connection", reason });
					this.state.waitUntil(this.load().then(async (current) => {
						if (current?.sessionId === connection.sessionId && current.command?.id === connection.commandId) {
							await this.close_record(current, "agent_connection_failed");
						}
					}));
				},
			});
			upstream.accept();
			server.accept();
			return new Response(null, { status: 101, webSocket: client });
		} catch {
			acceptingUpgrade = false;
			if (upstream) {
				upstream.accept();
				close_socket(upstream, 1011, "command failed");
			}
			const current = await this.load();
			if (current?.sessionId === record.sessionId) await this.close_record(current, "agent_connect_failed");
			return new Response("Browser command failed", { status: 503 });
		}
	}

	private async settle_run(sessionId: string, commandId: string): Promise<Response> {
		const connection = this.agentConnection;
		if (connection?.sessionId === sessionId && connection.commandId === commandId) connection.bridge?.revoke();
		let record = await this.load();
		if (!record || record.sessionId !== sessionId || record.command?.id !== commandId ||
			(record.control !== "agent" && record.control !== "pausing")) return operation_refused("closed", "Browser command changed.");
		if (record.command.connection === "settled") return json_response({ ok: true, blockedPopups: 0 }, 200);
		// A restarted object cannot prove that the old upstream drained.
		if (!connection?.bridge || connection.sessionId !== sessionId || connection.commandId !== commandId) {
			await this.close_record(record, "agent_connection_lost");
			return operation_refused("closed", "Browser command connection was lost.");
		}
		record.command.connection = "revoked";
		await this.save(record);
		try {
			const settled = await connection.bridge.settle(5000);
			if (!settled.safe) throw new Error("Browser command did not settle.");
			const host = this.hostConnection;
			if (!host || host.sessionId !== sessionId) throw new Error("Browser connection was lost.");
			// Playwright keeps local target caches. Ask Chromium for the full inventory.
			const check = await with_wall_timeout((async () => {
				const [contexts, targets] = await Promise.all([
					host.browserCdp.send("Target.getBrowserContexts"), host.browserCdp.send("Target.getTargets"),
				]);
				const contextIds: unknown = contexts.browserContextIds;
				const targetInfos: unknown = targets.targetInfos;
				if (!Array.isArray(contextIds) || contextIds.some((id) => typeof id !== "string" || id !== host.contextId) ||
					!Array.isArray(targetInfos)) return false;
				const pages = targetInfos.filter((target: unknown) => is_record(target) && target.type === "page");
				if (pages.length !== 1 || !is_record(pages[0]) || pages[0].targetId !== host.targetId) return false;
				const page: unknown = await host.page.evaluate("({url: location.href, nonce: window.__browserNonce})");
				return is_record(page) && page.url === CONTROLLER_URL && page.nonce === record?.pageNonce;
			})(), 10_000);
			if (!check) throw new Error("Browser target changed.");
			record = await this.load();
			if (!record || record.sessionId !== sessionId || record.command?.id !== commandId || record.command.connection !== "revoked") {
				return operation_refused("closed", "Browser command changed.");
			}
			record.command.connection = "settled";
			await this.save(record);
			if (this.agentConnection === connection) this.agentConnection = null;
			return json_response({ ok: true, blockedPopups: settled.blockedPopups }, 200);
		} catch {
			const current = await this.load();
			if (current?.sessionId === sessionId) await this.close_record(current, "agent_settle_failed");
			return operation_refused("closed", "Browser command could not be checked.");
		}
	}

	private async begin_run(input: {
		sessionId: string;
		navGen: number;
		loadGen: number;
		controlGen: number;
		commandId: string;
	}, inputReleased = false): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed") {
			return operation_refused("closed", "The browser session is closed.");
		}

		const now = Date.now();
		// A lost caller may still have browser work in flight.
		if (record.command && now - record.command.startedAt >= LIMITS.commandTimeoutMs + 10_000) {
			await this.close_record(record, "command_timeout");
			return operation_refused("expired", "The browser command timed out.");
		}
		const check = session_can_run(record, input, now);
		if (!check.ok) {
			if (check.reason === "expired") {
				await this.close_record(record, "expired");
				return operation_refused("expired", "The browser session expired.");
			}
			log_browser({ route: "run_begin", refused: check.reason, sessionId: record.sessionId });
			return operation_refused(check.reason, `The browser command was refused: ${check.reason}.`);
		}
		// Recheck the lease after waiting for an in-flight human action to finish.
		if (!inputReleased) return this.with_input_released(() => this.begin_run(input, true));

		record.command = { id: input.commandId, startedAt: now, connection: "available" };
		record.control = "agent";
		record.lastActiveAt = now;
		await this.save(record);
		return json_response(
			{
				ok: true,
				lease: {
					sessionId: record.sessionId,
					viewport: record.viewport,
					timeoutMs: LIMITS.commandTimeoutMs,
				},
			},
			200,
		);
	}

	private async finish_run(input: {
		sessionId: string;
		commandId: string;
		tainted: boolean;
		resultBytes: number;
		fileCount: number;
		fileBytes: number;
		viewport: { width: number; height: number } | null;
	}): Promise<Response> {
		let record = await this.load();
		if (!record || record.control === "closed") return json_response({ ok: true, state: "closed" }, 200);
		if (record.sessionId !== input.sessionId) return json_response({ ok: true, state: "stale" }, 200);

		const liveCommand = record.command?.id === input.commandId;
		if (!liveCommand) return json_response({ ok: true, state: "stale" }, 200);
		if (input.tainted) {
			log_browser({ route: "run_finish", sessionId: record.sessionId, tainted: true });
			await this.close_record(record, "tainted");
			return json_response({ ok: true, state: "closed", tainted: true }, 200);
		}

		if (record.command?.connection !== "settled") {
			await this.close_record(record, "command_not_settled");
			return json_response({ ok: true, state: "closed", tainted: true }, 200);
		}
		// The viewport is per-connection server-side, so the record keeps
		// the last size the snippet chose and the next lease re-applies it.
		if (
			input.viewport &&
			is_positive_int(input.viewport.width) &&
			is_positive_int(input.viewport.height) &&
			input.viewport.width >= LIMITS.viewportMin &&
			input.viewport.height >= LIMITS.viewportMin &&
			input.viewport.width <= LIMITS.viewportMaxWidth &&
			input.viewport.height <= LIMITS.viewportMaxHeight
		) {
			record.viewport = { width: input.viewport.width, height: input.viewport.height };
		}
		// Agent tracing can replace Chromium's screencast. Restart ours while the
		// command still blocks input, then check that close or another command did not win.
		this.stop_viewer_producer();
		await this.save(record);
		if (this.viewerStreams.size > 0) await this.start_viewer_producer().catch(() => {});
		// A failed restart may still be removing viewers from the same record.
		await this.viewerCleanup;
		const current = await this.load();
		if (!current || current.control === "closing" || current.control === "closed") return json_response({ ok: true, state: "closed" }, 200);
		if (current.sessionId !== input.sessionId || current.command?.id !== input.commandId) return json_response({ ok: true, state: "stale" }, 200);
		record = current;
		record.command = null;
		record.commandCount += 1;
		record.lastActiveAt = Date.now();
		// A finished command releases a pausing session to its waiting human. When the
		// holder detached mid-take, there is no human to hand to: fall back to ready.
		if (record.control === "pausing") {
			record.control = record.inputHolder ? "human" : "ready";
		} else if (record.control === "agent") {
			record.control = "ready";
		}
		await this.save(record);
		log_browser({
			route: "run_finish",
			sessionId: record.sessionId,
			resultBytes: input.resultBytes,
			fileCount: input.fileCount,
			fileBytes: input.fileBytes,
		});
		return json_response({ ok: true, state: record.control }, 200);
	}

	private async reload(input: {
		sessionId: string;
		navGen: number;
		sourceKind: string;
		sourceVersion: string;
		sourceHash: string;
		html: string;
		expectedAgentLease?: AgentLease;
	}): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== input.sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (input.expectedAgentLease) {
			const refusal = agent_lease_refusal(record, input.expectedAgentLease);
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
		}
		if (record.control === "closing" || record.control === "starting") {
			return operation_refused("busy", "The browser session is busy.");
		}
		if (record.navGen !== input.navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.command) {
			return operation_refused("busy", "A browser command is running.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}
		if (record.loadCount >= LIMITS.loadCount) {
			return operation_refused("session_limit", "The browser session reached its reload limit.");
		}
		const htmlBytes = byte_length(input.html);
		if (record.htmlBytesTotal + htmlBytes > LIMITS.htmlBytesTotal) {
			return operation_refused("session_limit", "The browser session reached its content limit.");
		}
		if (!record.providerSessionId || !this.env.BROWSER_PREVIEW_URL) {
			return json_response(
				{ ok: false, error: { code: "misconfigured", message: "Browser reload is unavailable." } },
				503,
			);
		}

		// Hold the command slot for the whole reload: the object interleaves concurrent
		// requests at awaits, so a checked-but-unheld reload would overlap a run.
		const reloadId = `reload:${crypto.randomUUID()}`;
		const drained = await this.with_input_released(async () => {
			const current = await this.load();
			if (
				!current ||
				current.sessionId !== record.sessionId ||
				current.loadGen !== record.loadGen ||
				current.controlGen !== record.controlGen ||
				current.command ||
				current.control === "closing" ||
				current.control === "closed" ||
				session_is_expired(current, Date.now())
			) {
				return operation_refused("busy", "The browser session changed.");
			}
			current.command = { id: reloadId, startedAt: Date.now() };
			if (input.expectedAgentLease) current.control = "agent";
			await this.save(current);
			return json_response({ ok: true }, 200);
		});
		const drainedBody: unknown = await drained.clone().json();
		if (!is_record(drainedBody) || drainedBody.ok !== true) return drained;
		const reserved = await this.load();
		if (reserved?.sessionId !== record.sessionId || reserved.command?.id !== reloadId) {
			return operation_refused("closed", "The browser session changed.");
		}
		let reloadedPageNonce: string;

		try {
			// Finish a pending host check before reload changes the page nonce.
			await this.connect_host(record);
			const host = this.hostConnection;
			if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
			// A full navigation resets page input and scroll by design.
			reloadedPageNonce = await load_controller_page(host.page, {
				previewUrl: this.env.BROWSER_PREVIEW_URL,
				html: input.html,
			});
			await host.page.setViewportSize(record.viewport);
		} catch (error) {
			const failure = sanitize_error(error);
			log_browser({ route: "reload", refused: "reload_failed", sessionId: record.sessionId });
			// Reload may have replaced the document before reporting a failure.
			await this.close_record(record, "reload_failed");
			return json_response(
				{ ok: false, error: { code: "reload_failed", message: failure.message } },
				200,
			);
		}

		// Re-read before committing: a concurrent close must win over this reload, and the
		// in-memory record would otherwise resurrect it.
		await this.viewerCleanup;
		const current = await this.load();
		if (!current || current.control === "closed" || current.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (current.sessionId !== input.sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (current.command?.id !== reloadId) {
			return operation_refused("busy", "A browser command is running.");
		}

		current.command = null;
		current.loadGen += 1;
		current.pageNonce = reloadedPageNonce;
		current.sourceKind = input.sourceKind;
		current.sourceVersion = input.sourceVersion;
		current.sourceHash = input.sourceHash;
		current.htmlBytesTotal += htmlBytes;
		current.loadCount += 1;
		current.lastActiveAt = Date.now();
		// Input stays blocked until navigation and the source update have both finished.
		if (current.control === "pausing") {
			current.control = current.inputHolder ? "human" : "ready";
		} else if (current.control === "agent") {
			current.control = "ready";
		}
		await this.save(current);
		log_browser({ route: "reload", sessionId: current.sessionId, loadGen: current.loadGen });
		return json_response({ ok: true, session: this.public_meta(current) }, 200);
	}

	private async release_closed_session(record: SessionRecord): Promise<void> {
		await this.release_grant(record.grantId);
		// Another close can finish first and leave the slot free for a new Start.
		const current = await this.state.storage.get<SessionRecord>(SESSION_KEY);
		if (current?.sessionId !== record.sessionId) return;
		await this.state.storage.delete(SESSION_KEY);
		await this.state.storage.deleteAlarm();
	}

	private async close_record(record: SessionRecord, reason: string): Promise<{ existed: boolean; verified: boolean }> {
		const current = await this.load();
		if (current?.sessionId !== record.sessionId) return { existed: false, verified: true };
		record = current;
		if (this.agentConnection?.sessionId === record.sessionId) {
			this.agentConnection.bridge?.close();
			this.agentConnection = null;
		}
		this.inputEpoch += 1;
		this.stop_viewer_producer();
		const host = this.hostConnection;
		this.hostConnection = null;
		if (host) this.state.waitUntil(host.browser.close().catch(() => {}));
		const providerSessionId = record.providerSessionId;
		record.control = "closing";
		record.command = null;
		record.closeAttempts += 1;
		await this.save(record);

		let verified = true;
		if (providerSessionId) {
			try {
				verified = await close_browser_provider(this.env.BROWSER, providerSessionId);
			} catch (error) {
				log_browser({ route: "close", sessionId: record.sessionId, closeError: sanitize_error(error).name });
				verified = false;
			}
		}

		if (!verified) {
			// Keep the record and the slot: the alarm retries a bounded number of times, and
			// only its final attempt frees an unverified slot (provider expiry backstops it).
			const current = await this.state.storage.get<SessionRecord>(SESSION_KEY);
			if (current?.sessionId === record.sessionId) {
				await this.state.storage.setAlarm(Date.now() + 30_000);
			}
			log_browser({ route: "close", sessionId: record.sessionId, reason, verified });
			return { existed: true, verified };
		}

		await this.release_closed_session(record);
		log_browser({ route: "close", sessionId: record.sessionId, reason, verified });
		return { existed: true, verified };
	}

	private async close(sessionId: string | null, expectedAgentLease?: AgentLease): Promise<Response> {
		const record = await this.load();
		if (!record || (sessionId && record.sessionId !== sessionId)) {
			return json_response({ ok: true, existed: false, verified: true }, 200);
		}
		if (record.control === "closed") {
			return json_response({ ok: true, existed: false, verified: true }, 200);
		}
		if (expectedAgentLease) {
			const refusal = agent_lease_refusal(record, expectedAgentLease);
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
		}
		const result = await this.close_record(record, "close");
		return json_response({ ok: true, ...result }, 200);
	}

	private async status(sessionId: string): Promise<Response> {
		const record = await this.load();
		const alive = !!record && record.sessionId === sessionId &&
			record.control !== "closed" && record.control !== "closing" && !session_is_expired(record, Date.now());
		return json_response(alive ? { ok: true, alive, session: this.public_meta(record) } : { ok: true, alive }, 200);
	}

	private async keep_open(sessionId: string, navGen: number): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		// Human attention extends the idle deadline, never the total cap.
		record.lastActiveAt = Date.now();
		await this.save(record);
		return json_response(
			{ ok: true, idleUntil: record.lastActiveAt + LIMITS.sessionIdleMs },
			200,
		);
	}

	private sweep_viewers(record: SessionRecord, now: number): void {
		for (const [grantId, grant] of Object.entries(record.viewerGrants)) {
			if (grant.expiresAt <= now) delete record.viewerGrants[grantId];
		}
		// A crashed viewer host stops renewing. Reap its row a minute after
		// its grant lapses so the per-session viewer cap cannot wedge.
		for (const [viewerId, viewer] of Object.entries(record.viewers)) {
			if (viewer.grantedUntil + 60_000 <= now) {
				delete record.viewers[viewerId];
				if (record.inputHolder === viewerId) record.inputHolder = null;
			}
		}
	}

	private live_viewers(record: SessionRecord, now: number): number {
		return Object.values(record.viewers).filter((viewer) => viewer.grantedUntil >= now).length;
	}

	private async viewer_grant(sessionId: string, navGen: number): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.control === "starting") {
			return operation_refused("not_ready", "The browser session is starting.");
		}
		if (record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		const now = Date.now();
		this.sweep_viewers(record, now);
		if (Object.keys(record.viewerGrants).length >= 10) {
			return operation_refused("busy", "Too many pending viewer grants.");
		}
		const grantId = crypto.randomUUID();
		record.viewerGrants[grantId] = { navGen, expiresAt: now + LIMITS.viewerGrantTtlMs };
		await this.save(record);
		return json_response({ ok: true, grantId, expiresAt: record.viewerGrants[grantId]?.expiresAt }, 200);
	}

	private async viewer_attach(grantId: string, viewerId: string, host: string): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}

		const now = Date.now();
		const grant = record.viewerGrants[grantId];
		// Single-use: burn the grant on every attempt. A miss writes nothing, so blind grant
		// guessing costs a read, not a write.
		delete record.viewerGrants[grantId];
		if (!grant || grant.expiresAt <= now) {
			if (grant) {
				await this.save(record);
			}
			return operation_refused("grant", "The viewer grant is invalid or expired.");
		}
		if (record.navGen !== grant.navGen) {
			await this.save(record);
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, now)) {
			await this.save(record);
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		this.sweep_viewers(record, now);
		if (this.live_viewers(record, now) >= LIMITS.viewersPerSession && !record.viewers[viewerId]) {
			await this.save(record);
			return operation_refused("busy", "Too many viewers on this browser session.");
		}
		if (!record.providerSessionId) {
			await this.save(record);
			return operation_refused("not_ready", "The browser session is starting.");
		}

		record.viewers[viewerId] = {
			host,
			controlGen: record.controlGen,
			grantedUntil: now + LIMITS.viewerGrantWindowMs,
			lastInputAt: 0,
			attachedAt: now,
		};
		await this.save(record);
		log_browser({ route: "viewer_attach", sessionId: record.sessionId });
		return json_response(
			{
				ok: true,
				sessionId: record.sessionId,
				providerSessionId: record.providerSessionId,
				viewport: record.viewport,
				control: record.control,
				controlGen: record.controlGen,
				grantedUntil: now + LIMITS.viewerGrantWindowMs,
			},
			200,
		);
	}

	private async viewer_renew(viewerId: string, sessionId: string): Promise<Response> {
		const record = await this.load();
		if (!record || record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (record.sessionId !== sessionId || record.control === "closed" || record.control === "closing") {
			delete record.viewers[viewerId];
			await this.save(record);
			return operation_refused("closed", "The browser session is closed.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		const now = Date.now();
		this.sweep_viewers(record, now);
		const viewer = record.viewers[viewerId];
		if (!viewer) return operation_refused("viewer", "The viewer is gone.");
		// Late renewals fail: a grant past its deadline cannot come back, even inside the sweep
		// grace that keeps the row briefly.
		if (viewer.grantedUntil <= now) {
			return operation_refused("grant", "The viewer grant expired.");
		}
		viewer.grantedUntil = now + LIMITS.viewerGrantWindowMs;
		await this.save(record);
		return json_response(
			{
				ok: true,
				grantedUntil: viewer.grantedUntil,
				session: this.public_meta(record),
				control: record.control,
				controlGen: record.controlGen,
				idleUntil: record.lastActiveAt + LIMITS.sessionIdleMs,
			},
			200,
		);
	}


	private async viewer_detach(viewerId: string): Promise<Response> {
		const record = await this.load();
		if (record) {
			delete record.viewers[viewerId];
			if (record.inputHolder === viewerId) {
				record.inputHolder = null;
				// No viewer holds input anymore: leaving human control set would refuse agent
				// commands with nobody able to act. Fall back to ready, never to agent work.
				if (record.control === "human") {
					record.control = "ready";
					record.controlGen += 1;
				}
			}
			await this.save(record);
		}
		return json_response({ ok: true }, 200);
	}

	private async control_take_human(sessionId: string, navGen: number, viewerId: string, inputReleased = false): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		// A stale command cannot safely hand its page to a human.
		const liveCommand =
			record.command !== null && Date.now() - record.command.startedAt < LIMITS.commandTimeoutMs + 10_000;
		if (!liveCommand && record.command) {
			await this.close_record(record, "command_timeout");
			return operation_refused("expired", "The browser command timed out.");
		}
		if (!inputReleased) return this.with_input_released(() => this.control_take_human(sessionId, navGen, viewerId, true));
		// Takeover is allowed: viewers are all authorized members, and a
		// refused take could strand input on a dead tab until its sweep.
		record.inputHolder = viewerId;
		record.controlGen += 1;
		if (liveCommand) {
			// Runs and reloads finish before handing input to this viewer.
			record.control = "pausing";
		} else {
			record.command = null;
			record.control = "human";
		}
		record.lastActiveAt = Date.now();
		await this.save(record);
		log_browser({ route: "control_take", sessionId: record.sessionId, control: record.control });
		return json_response({ ok: true, control: record.control, controlGen: record.controlGen }, 200);
	}

	private async control_to_agent(sessionId: string, navGen: number, inputReleased = false): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.control === "agent") {
			return operation_refused("busy", "A browser command is running.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		if (!inputReleased) return this.with_input_released(() => this.control_to_agent(sessionId, navGen, true));
		// Atomically end human input and ready the agent side. The fresh
		// request lease arrives with the next begin under the new generation.
		record.control = record.command ? "agent" : "ready";
		record.inputHolder = null;
		record.controlGen += 1;
		await this.save(record);
		log_browser({ route: "control_resume", sessionId: record.sessionId });
		return json_response({ ok: true, control: record.control, controlGen: record.controlGen }, 200);
	}

	private async viewer_input(viewerId: string, sessionId: string, controlGen: number, loadGen: number): Promise<Response> {
		const record = await this.load();
		if (!record || record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (record.sessionId !== sessionId || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.control !== "human" || record.inputHolder !== viewerId || record.command || this.inputTransition ||
			record.controlGen !== controlGen || record.loadGen !== loadGen) {
			return operation_refused("control", "This viewer does not hold input.");
		}
		const viewer = record.viewers[viewerId]!;
		if (viewer.grantedUntil <= Date.now()) {
			return operation_refused("grant", "The viewer grant expired.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		// Human input extends the idle deadline, never the total cap.
		record.lastActiveAt = Date.now();
		viewer.lastInputAt = Date.now();
		await this.save(record);
		return json_response({ ok: true }, 200);
	}

	private sync_viewers(record: SessionRecord): void {
		const previous = this.viewerRecord;
		this.viewerRecord = record;
		if (previous && (
			previous.sessionId !== record.sessionId || previous.loadGen !== record.loadGen ||
			previous.controlGen !== record.controlGen || previous.control !== record.control ||
			previous.inputHolder !== record.inputHolder || previous.command?.id !== record.command?.id
		)) {
			this.inputEpoch += 1;
			this.pointerPosition = null;
		}
		const viewportChanged = previous && (
			previous.loadGen !== record.loadGen || previous.viewport.width !== record.viewport.width ||
			previous.viewport.height !== record.viewport.height
		);
		if (viewportChanged) this.stop_viewer_producer();
		for (const stream of this.viewerStreams.values()) {
			const viewer = record.viewers[stream.viewerId];
			if (record.sessionId !== stream.sessionId || !viewer || record.control === "closing" || record.control === "closed") {
				this.end_viewer(stream, 4404, "session gone");
				continue;
			}
			if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
			const deadline = Math.min(viewer.grantedUntil, record.providerAcquiredAt! + LIMITS.sessionTotalMs, record.lastActiveAt + LIMITS.sessionIdleMs);
			stream.deadlineTimer = setTimeout(() => this.end_viewer(stream, 4408, "grant expired"), Math.max(0, deadline - Date.now()));
			try {
				if (!previous || previous.control !== record.control || previous.controlGen !== record.controlGen) {
					stream.socket.send(JSON.stringify({ t: "control", control: record.control, controlGen: record.controlGen }));
				}
				if (viewportChanged) stream.socket.send(JSON.stringify({ t: "viewport", viewport: record.viewport }));
			} catch {
				this.end_viewer(stream, 1011, "socket error");
			}
		}
		if (viewportChanged && this.viewerStreams.size > 0) {
			this.state.waitUntil(this.start_viewer_producer().catch(() => {}));
		}
	}

	private end_viewer(stream: ViewerStream, code: number, reason: string): void {
		if (!this.viewerStreams.delete(stream.viewerId)) return;
		if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
		close_socket(stream.socket, code, reason);
		// Detaches share a record, so each one must read after the previous save.
		this.viewerCleanup = this.viewerCleanup.then(async () => {
			await this.inputTransitionDone;
			const record = await this.load();
			if (record?.sessionId !== stream.sessionId) return;
			if (record.inputHolder === stream.viewerId) {
				await this.with_input_released(() => this.viewer_detach(stream.viewerId));
			} else {
				await this.viewer_detach(stream.viewerId);
			}
			if (this.viewerStreams.size === 0) this.stop_viewer_producer();
		}).catch(() => {
			if (this.viewerRecord?.sessionId === stream.sessionId) this.fail_viewers();
		});
		this.state.waitUntil(this.viewerCleanup);
	}

	private fail_viewers(): void {
		const record = this.viewerRecord;
		for (const stream of this.viewerStreams.values()) this.end_viewer(stream, 1011, "viewer failed");
		// A lost provider connection cannot safely release held or in-flight input.
		if (record && (this.pressedButtons.size > 0 || this.pressedKeys.size > 0 || this.inputDepth > 0)) {
			this.state.waitUntil(this.close_record(record, "viewer_input_failed"));
			return;
		}
		this.stop_viewer_producer();
	}

	private stop_viewer_producer(): void {
		this.viewerProducerGen += 1;
		this.viewerStart = null;
		this.viewerFrame = null;
		this.pointerPosition = null;
		const producer = this.viewerProducer;
		this.viewerProducer = null;
		if (producer) {
			this.viewerLifecycle = this.viewerLifecycle.then(async () => {
				await producer.cdp.send("Page.stopScreencast").catch(() => {});
				await producer.cdp.detach().catch(() => {});
			}).catch(() => {});
			this.state.waitUntil(this.viewerLifecycle);
		}
	}

	private send_viewer_frame(stream: ViewerStream): void {
		const record = this.viewerRecord;
		const frame = this.viewerFrame;
		// Two frames let a release follow its pressed state without waiting a network round trip.
		if (!record || !frame || stream.frameSeqs.length >= 2 || frame.seq <= stream.lastFrameSeq) return;
		if (
			record.sessionId !== stream.sessionId ||
			frame.loadGen !== record.loadGen ||
			!record.viewers[stream.viewerId] ||
			record.viewers[stream.viewerId]!.grantedUntil <= Date.now() ||
			session_is_expired(record, Date.now()) ||
			record.control === "closing" ||
			record.control === "closed"
		) {
			this.end_viewer(stream, 4408, "grant expired");
			return;
		}
		try {
			stream.frameSeqs.push(frame.seq);
			stream.lastFrameSeq = frame.seq;
			stream.socket.send(JSON.stringify({ t: "frame", seq: frame.seq, loadGen: frame.loadGen }));
			stream.socket.send(frame.bytes);
		} catch {
			this.end_viewer(stream, 1011, "socket error");
		}
	}

	private async start_viewer_producer(): Promise<void> {
		if (this.viewerProducer) return;
		if (this.viewerStart) return this.viewerStart;
		const generation = this.viewerProducerGen;
		const start = this.viewerLifecycle.then(async () => {
			const record = await this.load();
			if (
				!record?.providerSessionId ||
				record.control === "closing" ||
				record.control === "closed" ||
				this.viewerStreams.size === 0 ||
				generation !== this.viewerProducerGen
			) {
				return;
			}
			await this.connect_host(record);
			const host = this.hostConnection;
			if (!host || host.sessionId !== record.sessionId) return;
			const { browser, page } = host;
			const current = await this.load();
			if (
				!current ||
				current.sessionId !== record.sessionId ||
				current.loadGen !== record.loadGen ||
				current.control === "closing" ||
				current.control === "closed" ||
				generation !== this.viewerProducerGen ||
				this.viewerStreams.size === 0
			) {
				return;
			}
			await page.setViewportSize(record.viewport);
			// Another connection can change metrics without updating Playwright's cache.
			await host.cdp.send("Emulation.setDeviceMetricsOverride", {
				width: record.viewport.width, height: record.viewport.height, deviceScaleFactor: 1, mobile: false,
				screenWidth: record.viewport.width, screenHeight: record.viewport.height,
			});
			if (generation !== this.viewerProducerGen) return;
			const cdp = await page.context().newCDPSession(page);
			if (generation !== this.viewerProducerGen || this.viewerStreams.size === 0) {
				await cdp.detach();
				return;
			}
			const producer = { browser, page, cdp };
			this.viewerProducer = producer;
			cdp.on("Page.screencastFrame", (event: unknown) => {
				if (generation !== this.viewerProducerGen) return;
				if (!is_record(event) || !is_positive_int(event.sessionId)) {
					this.fail_viewers();
					return;
				}
				// Chromium's sessionId is an ACK token, not a unique frame number.
				this.state.waitUntil(cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {
					if (generation === this.viewerProducerGen) this.fail_viewers();
				}));
				if (generation !== this.viewerProducerGen) return;
				if (typeof event.data !== "string" || event.data.length === 0 || event.data.length > Math.ceil(LIMITS.viewerFrameBytes * 4 / 3) + 4) {
					this.fail_viewers();
					return;
				}
				try {
					const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
					if (bytes.byteLength > LIMITS.viewerFrameBytes) throw new Error("Viewer frame is too large.");
					this.viewerFrame = { seq: ++this.viewerFrameSeq, loadGen: record.loadGen, bytes };
					for (const stream of this.viewerStreams.values()) this.send_viewer_frame(stream);
				} catch {
					this.fail_viewers();
				}
			});
			cdp.on("Inspector.detached", () => {
				if (generation === this.viewerProducerGen) this.fail_viewers();
			});
			await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: record.viewport.width, maxHeight: record.viewport.height, everyNthFrame: 1 });
			if (generation !== this.viewerProducerGen) return;
		});
		this.viewerLifecycle = start.catch(() => {});
		this.viewerStart = with_wall_timeout(start, 15_000).catch(async (error: unknown) => {
			if (generation !== this.viewerProducerGen) return;
			const record = this.viewerRecord;
			this.fail_viewers();
			// A timed-out setup may still change the page. End it before another setup.
			if (error instanceof WallTimeoutError && record) await this.close_record(record, "viewer_start_timeout");
			throw error;
		}).finally(() => {
			if (generation === this.viewerProducerGen) this.viewerStart = null;
		});
		return this.viewerStart;
	}

	private with_input_released(action: () => Promise<Response>): Promise<Response> {
		if (this.inputTransition) return Promise.resolve(operation_refused("busy", "Input control is changing."));
		this.inputTransition = true;
		const epoch = ++this.inputEpoch;
		const sessionId = this.viewerRecord?.sessionId;
		const transition = (async () => {
			try {
				await with_wall_timeout(this.inputQueue, 5000);
				// The old queue may finish after another session has opened.
				const page = epoch === this.inputEpoch ? this.viewerProducer?.page : null;
				if (page) {
					for (const button of this.pressedButtons) await with_wall_timeout(page.mouse.up({ button }), 5000);
					for (const key of this.pressedKeys) await with_wall_timeout(page.keyboard.up(key), 5000);
				}
				if (epoch !== this.inputEpoch) return operation_refused("closed", "The browser control changed.");
				return await action();
			} catch {
				const record = await this.load();
				if (record && record.sessionId === sessionId) await this.close_record(record, "input_timeout");
				return operation_refused("closed", "Browser input failed.");
			} finally {
				this.pressedButtons.clear();
				this.pressedKeys.clear();
				this.pointerPosition = null;
				this.inputTransition = false;
			}
		})();
		this.inputTransitionDone = transition;
		return transition;
	}

	private queue_viewer_input(stream: ViewerStream, parsed: Extract<ReturnType<typeof parse_viewer_input>, { ok: true }>): void {
		const receivedAt = Date.now();
		const timings = { queueMs: 0, authorizeMs: 0, readyMs: 0, applyMs: 0 };
		const ack = (ok: boolean, code?: string) => {
			try {
				stream.socket.send(JSON.stringify({ t: "input-ack", seq: parsed.seq, ok, timings, ...(code ? { code } : {}) }));
			} catch {
				this.end_viewer(stream, 1011, "socket error");
			}
		};
		if (this.inputDepth >= 50 || this.inputTransition) {
			ack(false, "busy");
			return;
		}
		const epoch = this.inputEpoch;
		this.inputDepth += 1;
		this.inputQueue = this.inputQueue.then(async () => {
			const startedAt = Date.now();
			timings.queueMs = startedAt - receivedAt;
			try {
				if (epoch !== this.inputEpoch || !this.viewerStreams.has(stream.viewerId)) {
					ack(false, "control");
					return;
				}
				const checked: unknown = await (await this.viewer_input(stream.viewerId, stream.sessionId, parsed.controlGen, parsed.loadGen)).json();
				timings.authorizeMs = Date.now() - startedAt;
				if (!is_record(checked) || checked.ok !== true) {
					ack(false, is_record(checked) && is_record(checked.error) && typeof checked.error.code === "string" ? checked.error.code : "denied");
					return;
				}
				const readyAt = Date.now();
				await this.start_viewer_producer();
				timings.readyMs = Date.now() - readyAt;
				const current = this.viewerRecord;
				if (
					epoch !== this.inputEpoch ||
					this.inputTransition ||
					!this.viewerProducer ||
					!current ||
					!this.viewerStreams.has(stream.viewerId) ||
					current.sessionId !== stream.sessionId ||
					current.control !== "human" ||
					current.controlGen !== parsed.controlGen || current.loadGen !== parsed.loadGen ||
					current.inputHolder !== stream.viewerId ||
					current.command ||
					(current.viewers[stream.viewerId]?.grantedUntil ?? 0) <= Date.now() ||
					session_is_expired(current, Date.now())
				) {
					ack(false, "control");
					return;
				}
				const input = parsed.input;
				// Even an unchanged move runs Playwright's drag checks while left is held.
				if (input.kind === "mouse.move" && this.pointerPosition?.x === input.x && this.pointerPosition.y === input.y) {
					ack(true);
					return;
				}
				const page = this.viewerProducer.page;
				const applyAt = Date.now();
				await with_wall_timeout(apply_viewer_input(page, input), 5000);
				timings.applyMs = Date.now() - applyAt;
				// A pending handoff still needs releases, but a replaced page must not inherit them.
				if (this.viewerProducer?.page === page) {
					if (input.kind === "mouse.move" || input.kind === "mouse.click" || input.kind === "wheel") this.pointerPosition = { x: input.x, y: input.y };
					if (input.kind === "mouse.down") this.pressedButtons.add(input.button);
					if (input.kind === "mouse.up") this.pressedButtons.delete(input.button);
					if (input.kind === "key.down") this.pressedKeys.add(input.key);
					if (input.kind === "key.up") this.pressedKeys.delete(input.key);
				}
				ack(true);
			} catch {
				ack(false, "apply");
				const record = await this.load();
				if (record?.sessionId === stream.sessionId) await this.close_record(record, "input_failed");
			} finally {
				this.inputDepth -= 1;
			}
		});
	}

	private async viewer_lifetime(socket: WebSocket, scope: { ownerId: string; organizationId: string; workspaceId: string }): Promise<void> {
		const first = await new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => resolve(null), 5000);
			socket.addEventListener("message", (event) => { clearTimeout(timer); resolve(event.data); }, { once: true });
			socket.addEventListener("close", () => { clearTimeout(timer); resolve(null); }, { once: true });
		});
		const hello = parse_viewer_hello(first);
		const record = await this.load();
		if (
			!hello.ok ||
			!record ||
			hello.hello.ownerId !== scope.ownerId ||
			hello.hello.organizationId !== scope.organizationId ||
			hello.hello.workspaceId !== scope.workspaceId ||
			record.ownerId !== scope.ownerId ||
			record.organizationId !== scope.organizationId ||
			record.workspaceId !== scope.workspaceId
		) {
			close_socket(socket, 4401, "bad grant message");
			return;
		}
		const viewerId = crypto.randomUUID();
		const attached: unknown = await (await this.viewer_attach(hello.hello.grantId, viewerId, hello.hello.host)).json();
		if (!is_record(attached) || attached.ok !== true) {
			close_socket(socket, 4401, "grant refused");
			return;
		}
		const current = await this.load();
		if (!current || current.sessionId !== record.sessionId || !current.viewers[viewerId] || socket.readyState !== 1) {
			if (current?.sessionId === record.sessionId) await this.viewer_detach(viewerId);
			close_socket(socket, 4404, "session gone");
			return;
		}
		const stream: ViewerStream = { socket, viewerId, sessionId: record.sessionId, frameSeqs: [], lastFrameSeq: 0, deadlineTimer: null };
		this.viewerStreams.set(viewerId, stream);
		socket.addEventListener("close", () => this.end_viewer(stream, 1000, "client closed"));
		socket.addEventListener("error", () => this.end_viewer(stream, 1011, "socket error"));
		let lastPingAt = 0;
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data.length > 4096) return;
			let body: unknown;
			try {
				body = JSON.parse(event.data);
			} catch {
				return;
			}
			if (is_record(body) && body.t === "frame-ack") {
				if (is_positive_int(body.seq) && body.seq === stream.frameSeqs[0]) {
					stream.frameSeqs.shift();
					this.send_viewer_frame(stream);
				}
				return;
			}
			if (is_record(body) && body.t === "ping") {
				const now = Date.now();
				const current = this.viewerRecord;
				if (!is_positive_int(body.seq) || !Number.isSafeInteger(body.seq) || now - lastPingAt < 1000 ||
					!current || current.sessionId !== stream.sessionId || !this.viewerStreams.has(viewerId) ||
					(current.viewers[viewerId]?.grantedUntil ?? 0) <= now || session_is_expired(current, now) ||
					current.control === "closing" || current.control === "closed") return;
				lastPingAt = now;
				try { socket.send(JSON.stringify({ t: "pong", seq: body.seq })); }
				catch { this.end_viewer(stream, 1011, "socket error"); }
				return;
			}
			const parsed = parse_viewer_input(event.data);
			if (parsed.ok) this.queue_viewer_input(stream, parsed);
		});
		try {
			socket.send(JSON.stringify({ t: "hello", viewerId, viewport: current.viewport, control: current.control, controlGen: current.controlGen }));
			this.sync_viewers(current);
			await this.start_viewer_producer();
			this.send_viewer_frame(stream);
		} catch {
			this.end_viewer(stream, 1011, "viewer start failed");
		}
	}

	async alarm(): Promise<void> {
		const record = await this.load();
		if (!record) {
			await this.state.storage.deleteAlarm();
			return;
		}
		if (record.control === "closing") {
			if (record.closeAttempts >= LIMITS.closeAttempts) {
				await this.release_closed_session(record);
				return;
			}
			await this.close_record(record, "closing_retry");
			return;
		}
		if (record.control === "closed") {
			await this.state.storage.deleteAlarm();
			return;
		}
		if (
			record.control === "starting" &&
			Date.now() - record.createdAt >= LIMITS.startingStaleMs
		) {
			await this.close_record(record, "stale_start");
			return;
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return;
		}
		// A worker crash can leave browser work running after its caller has gone.
		const now = Date.now();
		if (record.command && now - record.command.startedAt >= LIMITS.commandTimeoutMs + 10_000) {
			await this.close_record(record, "command_timeout");
			return;
		}
		await this.schedule_alarm(record);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/run/stream") {
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return new Response("Upgrade required", { status: 426 });
			return await this.agent_stream(url);
		}
		if (request.method === "GET" && url.pathname === "/viewer/stream") {
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return new Response("Upgrade required", { status: 426 });
			const scope = parse_owner_tuple({ ownerId: url.searchParams.get("ownerId"), organizationId: url.searchParams.get("organizationId"), workspaceId: url.searchParams.get("workspaceId") });
			if (!scope.ok) return scope.response;
			if (this.pendingViewers >= LIMITS.viewersPerSession) return operation_refused("busy", "Too many pending viewers.");
			const [client, server] = Object.values(new WebSocketPair());
			server.accept();
			this.pendingViewers += 1;
			this.state.waitUntil(this.viewer_lifetime(server, scope).catch(() => close_socket(server, 1011, "viewer failed")).finally(() => { this.pendingViewers -= 1; }));
			return new Response(null, { status: 101, webSocket: client });
		}
		if (request.method !== "POST") return json_response({ ok: false, error: { code: "not_found" } }, 404);

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json_response({ ok: false, error: { code: "invalid_json" } }, 400);
		}
		if (!is_record(body)) return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
		if (url.pathname === "/run/settle") {
			if (!is_non_empty_string(body.sessionId) || !is_non_empty_string(body.commandId)) return invalid_request("Browser command is required.");
			return await this.settle_run(body.sessionId, body.commandId);
		}

		if (url.pathname === "/open") {
			const viewport = is_record(body.viewport) ? body.viewport : null;
			if (
				typeof body.grantId !== "string" ||
				typeof body.attemptId !== "string" ||
				typeof body.ownerId !== "string" ||
				typeof body.organizationId !== "string" ||
				typeof body.workspaceId !== "string" ||
				typeof body.nodeId !== "string" ||
				!is_positive_int(body.navGen) ||
				typeof body.sourceKind !== "string" ||
				typeof body.sourceVersion !== "string" ||
				typeof body.sourceHash !== "string" ||
				typeof body.html !== "string" ||
				!viewport ||
				!is_positive_int(viewport.width) ||
				!is_positive_int(viewport.height)
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.open({
				grantId: body.grantId,
				attemptId: body.attemptId,
				ownerId: body.ownerId,
				organizationId: body.organizationId,
				workspaceId: body.workspaceId,
				nodeId: body.nodeId,
				navGen: body.navGen,
				sourceKind: body.sourceKind,
				sourceVersion: body.sourceVersion,
				sourceHash: body.sourceHash,
				html: body.html,
				viewport: { width: viewport.width, height: viewport.height },
			});
		}
		if (url.pathname === "/run/begin") {
			if (
				typeof body.sessionId !== "string" ||
				!is_positive_int(body.navGen) ||
				!is_positive_int(body.loadGen) ||
				!is_positive_int(body.controlGen) ||
				typeof body.commandId !== "string" ||
				!body.commandId
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.begin_run({ sessionId: body.sessionId, navGen: body.navGen, loadGen: body.loadGen, controlGen: body.controlGen, commandId: body.commandId });
		}
		if (url.pathname === "/run/finish") {
			if (
				typeof body.sessionId !== "string" ||
				typeof body.commandId !== "string" ||
				typeof body.tainted !== "boolean" ||
				typeof body.resultBytes !== "number" ||
				typeof body.fileCount !== "number" ||
				typeof body.fileBytes !== "number" ||
				(body.viewport !== null && !is_record(body.viewport))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			const viewport = is_record(body.viewport) ? body.viewport : null;
			return await this.finish_run({
				sessionId: body.sessionId,
				commandId: body.commandId,
				tainted: body.tainted,
				resultBytes: body.resultBytes,
				fileCount: body.fileCount,
				fileBytes: body.fileBytes,
				viewport:
					viewport && is_positive_int(viewport.width) && is_positive_int(viewport.height)
						? { width: viewport.width, height: viewport.height }
						: null,
			});
		}
		if (url.pathname === "/reload") {
			if (
				typeof body.sessionId !== "string" ||
				!is_positive_int(body.navGen) ||
				typeof body.sourceKind !== "string" ||
				typeof body.sourceVersion !== "string" ||
				typeof body.sourceHash !== "string" ||
				typeof body.html !== "string" ||
				(body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.reload({
				sessionId: body.sessionId,
				navGen: body.navGen,
				sourceKind: body.sourceKind,
				sourceVersion: body.sourceVersion,
				sourceHash: body.sourceHash,
				html: body.html,
				expectedAgentLease: body.expectedAgentLease,
			});
		}
		if (url.pathname === "/close") {
			if (
				(body.sessionId !== undefined && typeof body.sessionId !== "string") ||
				(body.expectedAgentLease !== undefined && (!is_agent_lease(body.expectedAgentLease) || !is_non_empty_string(body.sessionId)))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.close(typeof body.sessionId === "string" ? body.sessionId : null, body.expectedAgentLease);
		}
		if (url.pathname === "/status") {
			if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
			return await this.status(body.sessionId);
		}
		if (url.pathname === "/keep-open") {
			if (typeof body.sessionId !== "string" || !is_positive_int(body.navGen)) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.keep_open(body.sessionId, body.navGen);
		}
		if (url.pathname === "/viewer/grant") {
			if (typeof body.sessionId !== "string" || !is_positive_int(body.navGen)) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.viewer_grant(body.sessionId, body.navGen);
		}
		if (url.pathname === "/viewer/renew") {
			if (typeof body.viewerId !== "string" || typeof body.sessionId !== "string") {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.viewer_renew(body.viewerId, body.sessionId);
		}
		if (url.pathname === "/control/take-human") {
			if (
				typeof body.sessionId !== "string" ||
				!is_positive_int(body.navGen) ||
				typeof body.viewerId !== "string"
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.control_take_human(body.sessionId, body.navGen, body.viewerId);
		}
		if (url.pathname === "/control/to-agent") {
			if (typeof body.sessionId !== "string" || !is_positive_int(body.navGen)) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.control_to_agent(body.sessionId, body.navGen);
		}
		return json_response({ ok: false, error: { code: "not_found" } }, 404);
	}
}

// Host request handling
//
// The host authenticates, validates, and drives the objects. Snippet execution
// stays here because only the host request context exposes the connection-gate
// binding factory.

function session_object_name(ownerId: string, organizationId: string, workspaceId: string): string {
	return `browser:${ownerId}:${organizationId}:${workspaceId}`;
}

function workspace_key(organizationId: string, workspaceId: string): string {
	return `${organizationId}:${workspaceId}`;
}

function session_stub(env: Env, ownerId: string, organizationId: string, workspaceId: string) {
	return env.BROWSER_SESSIONS.get(
		env.BROWSER_SESSIONS.idFromName(session_object_name(ownerId, organizationId, workspaceId)),
	);
}

function registry_stub(env: Env) {
	return env.BROWSER_REGISTRY.get(env.BROWSER_REGISTRY.idFromName(REGISTRY_NAME));
}

async function object_json(stub: DurableObjectStubStub, path: string, body: unknown): Promise<unknown> {
	const response = await stub.fetch(
		new Request(`https://do${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return await response.json();
}

async function parse_json_body(
	request: Request,
	allowed: Set<string>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
	const raw = await read_bounded_text(request);
	if (!raw.ok) {
		return {
			ok: false,
			response: json_response({ ok: false, error: { code: "too_large", message: "Request body too large." } }, 413),
		};
	}

	let body: unknown;
	try {
		body = JSON.parse(raw.text);
	} catch {
		return {
			ok: false,
			response: json_response(
				{ ok: false, error: { code: "invalid_json", message: "Request body must be valid JSON." } },
				400,
			),
		};
	}
	if (!is_record(body)) {
		return {
			ok: false,
			response: json_response(
				{ ok: false, error: { code: "invalid_request", message: "Request body must be a JSON object." } },
				400,
			),
		};
	}
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) {
			return { ok: false, response: invalid_request(`Unknown request field \`${key}\`.`) };
		}
	}
	return { ok: true, body };
}

async function require_host_access(
	request: Request,
	env: Env,
): Promise<{ ok: true } | { ok: false; response: Response }> {
	// Auth first so an unauthenticated caller cannot probe the kill-switch state.
	if (!(await is_authorized(request, env))) {
		return {
			ok: false,
			response: json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401),
		};
	}
	if (env.BROWSER_RUNNER_DISABLED === "true") {
		return {
			ok: false,
			response: json_response(
				{ ok: false, error: { code: "disabled", message: "Browser runner is disabled." } },
				503,
			),
		};
	}
	return { ok: true };
}

function parse_owner_tuple(body: Record<string, unknown>): (
	| { ok: true; ownerId: string; organizationId: string; workspaceId: string }
	| { ok: false; response: Response }
) {
	if (
		!is_non_empty_string(body.ownerId) ||
		!is_non_empty_string(body.organizationId) ||
		!is_non_empty_string(body.workspaceId)
	) {
		return { ok: false, response: invalid_request("`ownerId`, `organizationId`, and `workspaceId` are required.") };
	}
	if (body.ownerId.length > 128 || body.organizationId.length > 128 || body.workspaceId.length > 128) {
		return { ok: false, response: invalid_request("Owner scope fields are too long.") };
	}
	// Convex ids are alphanumerics. Pin the charset so separator-joined slot names cannot
	// collide (`a:b` + `c` vs `a` + `b:c`).
	const scopePattern = /^[A-Za-z0-9_-]+$/;
	if (
		!scopePattern.test(body.ownerId) ||
		!scopePattern.test(body.organizationId) ||
		!scopePattern.test(body.workspaceId)
	) {
		return { ok: false, response: invalid_request("Owner scope fields are invalid.") };
	}
	return { ok: true, ownerId: body.ownerId, organizationId: body.organizationId, workspaceId: body.workspaceId };
}

function parse_viewport(body: Record<string, unknown>): (
	| { ok: true; viewport: { width: number; height: number } }
	| { ok: false; response: Response }
) {
	if (body.viewport === undefined) return { ok: true, viewport: { width: 1280, height: 900 } };
	if (!is_record(body.viewport) || !is_positive_int(body.viewport.width) || !is_positive_int(body.viewport.height)) {
		return { ok: false, response: invalid_request("`viewport` must be `{ width, height }` positive ints.") };
	}
	if (
		body.viewport.width < LIMITS.viewportMin ||
		body.viewport.height < LIMITS.viewportMin ||
		body.viewport.width > LIMITS.viewportMaxWidth ||
		body.viewport.height > LIMITS.viewportMaxHeight
	) {
		return { ok: false, response: invalid_request("`viewport` is outside the supported range.") };
	}
	return { ok: true, viewport: { width: body.viewport.width, height: body.viewport.height } };
}

function parse_snapshot(
	body: Record<string, unknown>,
): { ok: true; sourceKind: string; sourceVersion: string; sourceHash: string; html: string } | {
	ok: false;
	response: Response;
} {
	if (typeof body.sourceKind !== "string" || !SOURCE_KINDS.has(body.sourceKind)) {
		return { ok: false, response: invalid_request("`sourceKind` must be saved, proposed, or draft.") };
	}
	if (!is_non_empty_string(body.sourceVersion) || body.sourceVersion.length > 256) {
		return { ok: false, response: invalid_request("`sourceVersion` is required.") };
	}
	if (typeof body.sourceHash !== "string" || body.sourceHash.length > 256) {
		return { ok: false, response: invalid_request("`sourceHash` is invalid.") };
	}
	if (typeof body.html !== "string" || body.html.length === 0) {
		return { ok: false, response: invalid_request("`html` must be a non-empty string.") };
	}
	if (byte_length(body.html) > LIMITS.htmlBytes) {
		return {
			ok: false,
			response: json_response(
				{ ok: false, error: { code: "too_large", message: "`html` exceeds the size limit." } },
				413,
			),
		};
	}
	return { ok: true, sourceKind: body.sourceKind, sourceVersion: body.sourceVersion, sourceHash: body.sourceHash, html: body.html };
}

async function handle_browser_open(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_OPEN_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	const viewport = parse_viewport(body);
	if (!viewport.ok) return viewport.response;
	const snapshot = parse_snapshot(body);
	if (!snapshot.ok) return snapshot.response;
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");
	if (!is_non_empty_string(body.nodeId) || body.nodeId.length > 128) {
		return invalid_request("`nodeId` is required.");
	}
	const attemptId =
		typeof body.attemptId === "string" && body.attemptId.length > 0 && body.attemptId.length <= 128
			? body.attemptId
			: crypto.randomUUID();

	// Charge admission before acquisition so simultaneous calls cannot bypass quotas.
	const claim = await object_json(registry_stub(env), "/claim", {
		workspaceKey: workspace_key(owners.organizationId, owners.workspaceId),
	});
	if (!is_record(claim) || claim.ok !== true || typeof claim.grantId !== "string") {
		const code = is_record(claim) && is_record(claim.error) && typeof claim.error.code === "string"
			? claim.error.code
			: "registry_error";
		return operation_refused(code, "The browser service is busy.");
	}

	const opened = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/open",
		{
			grantId: claim.grantId,
			attemptId,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			nodeId: body.nodeId,
			navGen: body.navGen,
			sourceKind: snapshot.sourceKind,
			sourceVersion: snapshot.sourceVersion,
			sourceHash: snapshot.sourceHash,
			html: snapshot.html,
			viewport: viewport.viewport,
		},
	);
	if (!is_record(opened) || opened.ok !== true) {
		await object_json(registry_stub(env), "/release", { grantId: claim.grantId });
		if (is_record(opened) && is_record(opened.error) && typeof opened.error.code === "string") {
			return json_response({ ok: false, error: opened.error }, 200);
		}
		return json_response(
			{ ok: false, error: { code: "open_failed", message: "The browser did not start." } },
			200,
		);
	}

	const confirmed = await object_json(registry_stub(env), "/confirm", { grantId: claim.grantId });
	if (!is_record(confirmed) || confirmed.ok !== true) {
		// The claim lapsed mid-bootstrap (or the registry dropped it). Close the orphan
		// instead of running outside the admission caps; idle expiry backstops a lost close.
		const openedSession = is_record(opened.session) ? opened.session : null;
		const openedSessionId =
			openedSession && typeof openedSession.sessionId === "string" ? openedSession.sessionId : null;
		try {
			await object_json(
				session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
				"/close",
				openedSessionId ? { sessionId: openedSessionId } : {},
			);
		} catch {
			// Best effort.
		}
		return operation_refused("busy", "The browser service is busy.");
	}
	return json_response(opened, 200);
}

async function evaluate_snippet(input: {
	env: Env;
	ctx: BrowserRunnerContext | undefined;
	connection: BrowserConnectionGatewayProps;
	runtimeOrigin: string;
	viewport: { width: number; height: number };
	code: string;
}): Promise<SnippetEvaluateResult> {
	const gateway = input.ctx?.exports?.BrowserConnectionGateway;
	if (!gateway) throw new Error("Browser connection gateway is unavailable.");

	const worker = input.env.LOADER.load({
		compatibilityDate: CHILD_COMPAT_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: CHILD_ENTRY_MODULE,
		modules: {
			[CHILD_ENTRY_MODULE]: build_executor_module(input.code),
			[CHILD_BUNDLE_MODULE]: CHILD_BUNDLE_JS,
		},
		env: {
			BROWSER: gateway({ props: input.connection }),
		},
		globalOutbound: null,
		limits: { cpuMs: LIMITS.childCpuMs, subRequests: LIMITS.childSubRequests },
	});
	const entrypoint = worker.getEntrypoint();
	return await with_wall_timeout(
		entrypoint.evaluate({
			sessionId: input.connection.sessionId,
			runtimeOrigin: input.runtimeOrigin,
			viewport: input.viewport,
			timeoutMs: LIMITS.commandTimeoutMs,
		}),
		LIMITS.childWallMs,
	);
}

async function execute_browser_command(args: {
	env: Env;
	ctx: BrowserRunnerContext | undefined;
	body: Record<string, unknown>;
	commandId: string;
	lease: Record<string, unknown>;
	connection: BrowserConnectionGatewayProps;
	settle: () => Promise<unknown>;
	finish: (
		tainted: boolean,
		meta: {
			resultBytes: number;
			fileCount: number;
			fileBytes: number;
			viewport: { width: number; height: number } | null;
		},
	) => Promise<void>;
}): Promise<Response> {
	const { env, ctx, body, commandId, lease, finish } = args;
	// The caller validated `code`, but narrowing does not cross the extraction boundary, so
	// check again: this function must never run an unknown payload.
	if (typeof body.code !== "string" || body.code.length === 0) {
		return invalid_request("`code` must be a non-empty string.");
	}
	const leaseViewport = is_record(lease.viewport) ? lease.viewport : null;
	if (
		typeof lease.sessionId !== "string" ||
		!leaseViewport ||
		!is_positive_int(leaseViewport.width) ||
		!is_positive_int(leaseViewport.height)
	) {
		return json_response(
			{ ok: false, error: { code: "begin_failed", message: "The browser command did not start." } },
			200,
		);
	}
	if (!env.BROWSER_PREVIEW_URL) {
		return json_response(
			{ ok: false, error: { code: "misconfigured", message: "Preview runtime is not configured." } },
			503,
		);
	}

	const started = Date.now();
	const codeHash = await sha256_hex(`browser-v3\n${body.code}`);
	const snippetViewport = (value: unknown): { width: number; height: number } | null => {
		if (!is_record(value) || !is_positive_int(value.width) || !is_positive_int(value.height)) return null;
		if (
			value.width < LIMITS.viewportMin ||
			value.height < LIMITS.viewportMin ||
			value.width > LIMITS.viewportMaxWidth ||
			value.height > LIMITS.viewportMaxHeight
		) {
			return null;
		}
		return { width: value.width, height: value.height };
	};
	const snippetPopups = (value: unknown): { blocked: number; urls: string[] } => {
		if (!is_record(value)) return { blocked: 0, urls: [] };
		const blocked = typeof value.blocked === "number" && Number.isInteger(value.blocked) && value.blocked >= 0
			? Math.min(value.blocked, 10_000)
			: 0;
		const urls = Array.isArray(value.urls)
			? value.urls.filter((url): url is string => typeof url === "string").slice(0, 10).map((url) =>
				url.slice(0, 200)
			)
			: [];
		return { blocked, urls };
	};
	let sandbox: SnippetEvaluateResult;
	try {
		sandbox = await evaluate_snippet({
			env,
			ctx,
			connection: args.connection,
			runtimeOrigin: CONTROLLER_ORIGIN,
			viewport: { width: leaseViewport.width, height: leaseViewport.height },
			code: body.code,
		});
	} catch (error) {
		const elapsedMs = Date.now() - started;
		const wallTimeout = error instanceof WallTimeoutError;
		const timedOut = wallTimeout || is_resource_limit_error(error);
		// A lost or timed-out isolate may still have browser work in flight.
		await finish(true, { resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		log_browser({ route: "run", commandId, status: timedOut ? "timed_out" : "errored", elapsedMs });
		return json_response(
			{
				ok: true,
				status: timedOut ? "timed_out" : "errored",
				commandId,
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				files: [],
				popups: { blocked: 0, urls: [] },
				consoleEntries: [],
				pageErrors: [],
				logs: [],
				logsTruncated: false,
				error: wallTimeout
					? { name: "TimeoutError", message: "Execution timed out." }
					: sanitize_error(error),
			},
			200,
		);
	}

	const elapsedMs = Date.now() - started;

	const timedOut = !sandbox.ok && sandbox.error?.message === "Execution timed out";
	// A timeout does not prove that the snippet stopped. Close before releasing its lease.
	if (timedOut) {
		await finish(true, { resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		log_browser({ route: "run", commandId, status: "timed_out", reason: "timeout" });
		return json_response(
			{
				ok: true,
				status: "timed_out",
				commandId,
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				files: [],
				popups: { blocked: 0, urls: [] },
				consoleEntries: [],
				pageErrors: [],
				logs: [],
				logsTruncated: false,
				error: { name: "TimeoutError", message: "Execution timed out. The browser session was closed." },
			},
			200,
		);
	}

	// Stop command access and drain accepted protocol work before checking the target.
	const check = await args.settle();
	if (!is_record(check) || check.ok !== true) {
		await finish(true, { resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		// Log only the reason class: the full reason can carry an attacker-influenced page URL.
		log_browser({ route: "run", commandId, status: "tainted", reason: "settle" });
		return json_response(
			{
				ok: true,
				status: "tainted",
				commandId,
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				files: [],
				popups: { blocked: 0, urls: [] },
				consoleEntries: [],
				pageErrors: [],
				logs: [],
				logsTruncated: false,
				error: { name: "Error", message: "The browser command could not be checked. The session was closed." },
			},
			200,
		);
	}
	// Popup ownership lives in the trusted bridge, outside the snippet's closure.
	sandbox.popups = { blocked: typeof check.blockedPopups === "number" ? check.blockedPopups : 0, urls: [] };

	if (!sandbox.ok) {
		await finish(false, { resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: snippetViewport(sandbox.viewport) });
		log_browser({ route: "run", commandId, status: "errored", elapsedMs });
		const text = cap_snippet_text(sandbox);
		return json_response(
			{
				ok: true,
				status: "errored",
				commandId,
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				files: [],
				popups: snippetPopups(sandbox.popups),
				consoleEntries: text.consoleEntries,
				pageErrors: text.pageErrors,
				logs: text.logs,
				logsTruncated: text.logsTruncated,
				error: {
					name: sandbox.error?.name ?? "Error",
					message: cap_message(sandbox.error?.message ?? "Unknown error"),
				},
			},
			200,
		);
	}

	// Trust nothing from the isolate: re-check every bound on the host.
	const resultJson = typeof sandbox.resultJson === "string" ? sandbox.resultJson : "null";
	const resultBytes = byte_length(resultJson);
	const files = validate_snippet_files(sandbox.files);
	if (!files.ok) {
		await finish(true, { resultBytes, fileCount: 0, fileBytes: 0, viewport: null });
		log_browser({ route: "run", commandId, status: "tainted", reason: files.reason });
		return json_response(
			{
				ok: true,
				status: "tainted",
				commandId,
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				files: [],
				popups: { blocked: 0, urls: [] },
				consoleEntries: [],
				pageErrors: [],
				logs: [],
				logsTruncated: false,
				error: { name: "RangeError", message: "Snippet output failed host validation." },
			},
			200,
		);
	}

	let result: unknown = null;
	let resultTruncated = false;
	if (resultBytes > LIMITS.textOutBytes) {
		resultTruncated = true;
	} else {
		try {
			result = JSON.parse(resultJson);
		} catch {
			result = null;
		}
	}
	await finish(false, { resultBytes, fileCount: files.files.length, fileBytes: files.fileBytes, viewport: snippetViewport(sandbox.viewport) });
	log_browser({
		route: "run",
		commandId,
		status: "succeeded",
		elapsedMs,
		resultBytes,
		fileCount: files.files.length,
	});
	const text = cap_snippet_text(sandbox);
	return json_response(
		{
			ok: true,
			status: "succeeded",
			commandId,
			codeHash,
			elapsedMs,
			result,
			resultTruncated,
			files: files.files,
			popups: snippetPopups(sandbox.popups),
			consoleEntries: text.consoleEntries,
			pageErrors: text.pageErrors,
			logs: text.logs,
			logsTruncated: text.logsTruncated,
			error: null,
		},
		200,
	);
}

async function handle_browser_run(request: Request, env: Env, ctx?: BrowserRunnerContext): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_RUN_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen) || !is_positive_int(body.loadGen) || !is_positive_int(body.controlGen)) {
		return invalid_request("`navGen`, `loadGen`, and `controlGen` must be positive ints.");
	}
	if (typeof body.code !== "string" || body.code.length === 0) {
		return invalid_request("`code` must be a non-empty string.");
	}
	if (byte_length(body.code) > LIMITS.codeBytes) {
		return json_response(
			{ ok: false, error: { code: "too_large", message: "`code` exceeds the size limit." } },
			413,
		);
	}
	const commandId =
		typeof body.commandId === "string" && body.commandId.length > 0 && body.commandId.length <= 128
			? body.commandId
			: crypto.randomUUID();

	const stub = session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId);
	const begin = await object_json(stub, "/run/begin", {
		sessionId: body.sessionId,
		navGen: body.navGen,
		loadGen: body.loadGen,
		controlGen: body.controlGen,
		commandId,
	});
	if (!is_record(begin) || begin.ok !== true || !is_record(begin.lease)) {
		if (is_record(begin) && is_record(begin.error) && typeof begin.error.code === "string") {
			return json_response({ ok: false, error: begin.error }, 200);
		}
		return json_response(
			{ ok: false, error: { code: "begin_failed", message: "The browser command did not start." } },
			200,
		);
	}
	const lease = begin.lease;
	// Every path must finish its command. If execution or validation fails unexpectedly,
	// close the session before releasing control. Duplicate finishes are harmless.
	const runState = { finished: false };
	const finish = async (
		tainted: boolean,
		meta: {
			resultBytes: number;
			fileCount: number;
			fileBytes: number;
			viewport: { width: number; height: number } | null;
		},
	) => {
		await object_json(stub, "/run/finish", {
			sessionId: body.sessionId,
			commandId,
			tainted,
			...meta,
		});
		runState.finished = true;
	};
	try {
		return await execute_browser_command({
			env, ctx, body, commandId, lease, finish,
			connection: { sessionId: body.sessionId, ownerId: owners.ownerId, organizationId: owners.organizationId, workspaceId: owners.workspaceId, commandId },
			settle: () => object_json(stub, "/run/settle", { sessionId: body.sessionId, commandId }),
		});
	} finally {
		if (!runState.finished) {
			try {
				await object_json(stub, "/run/finish", {
					sessionId: body.sessionId,
					commandId,
					tainted: true,
					resultBytes: 0,
					fileCount: 0,
					fileBytes: 0,
					viewport: null,
				});
			} catch {
				// The command deadline closes a session whose finish was lost.
			}
		}
	}
}

async function handle_browser_reload(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_RELOAD_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	const snapshot = parse_snapshot(body);
	if (!snapshot.ok) return snapshot.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");
	if (body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease)) {
		return invalid_request("`expectedAgentLease` must contain positive nav, load, and control generations.");
	}

	const reloaded = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/reload",
		{
			sessionId: body.sessionId,
			navGen: body.navGen,
			sourceKind: snapshot.sourceKind,
			sourceVersion: snapshot.sourceVersion,
			sourceHash: snapshot.sourceHash,
			html: snapshot.html,
			expectedAgentLease: body.expectedAgentLease,
		},
	);
	return json_response(
		is_record(reloaded) ? reloaded : { ok: false, error: { code: "reload_failed" } },
		200,
	);
}

async function handle_browser_close(request: Request, env: Env): Promise<Response> {
	// Cleanup stays available while disabled. Auth still applies.
	if (!(await is_authorized(request, env))) {
		return json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401);
	}

	const parsed = await parse_json_body(request, BROWSER_CLOSE_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
		return invalid_request("`sessionId` is invalid.");
	}
	if (body.expectedAgentLease !== undefined && (!is_agent_lease(body.expectedAgentLease) || !is_non_empty_string(body.sessionId))) {
		return invalid_request("`expectedAgentLease` needs a session id and positive nav, load, and control generations.");
	}

	// Send close without the caller's abort signal: cleanup must complete even
	// when the triggering request is already gone.
	const closed = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/close",
		{ sessionId: body.sessionId, expectedAgentLease: body.expectedAgentLease },
	);
	return json_response(
		is_record(closed) ? closed : { ok: false, error: { code: "close_failed" } },
		200,
	);
}

async function handle_browser_keep_open(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_KEEP_OPEN_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");

	const kept = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/keep-open",
		{ sessionId: body.sessionId, navGen: body.navGen },
	);
	return json_response(
		is_record(kept) ? kept : { ok: false, error: { code: "keep_open_failed" } },
		200,
	);
}

async function handle_browser_status(request: Request, env: Env): Promise<Response> {
	// Status stays readable while disabled so the app can retire a lost session.
	if (!(await is_authorized(request, env))) {
		return json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401);
	}
	const parsed = await parse_json_body(request, BROWSER_STATUS_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;
	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");

	const status = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/status",
		{ sessionId: body.sessionId },
	);
	return json_response(is_record(status) ? status : { ok: false, error: { code: "status_failed" } }, 200);
}

async function handle_browser_viewer_grant(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_VIEWER_GRANT_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");

	const granted = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/viewer/grant",
		{ sessionId: body.sessionId, navGen: body.navGen },
	);
	return json_response(
		is_record(granted) ? granted : { ok: false, error: { code: "grant_failed" } },
		200,
	);
}

async function handle_browser_viewer_renew(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_VIEWER_RENEW_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_non_empty_string(body.viewerId)) return invalid_request("`viewerId` is required.");

	const renewed = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/viewer/renew",
		{ sessionId: body.sessionId, viewerId: body.viewerId },
	);
	return json_response(
		is_record(renewed) ? renewed : { ok: false, error: { code: "renew_failed" } },
		200,
	);
}

async function handle_browser_control_take(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_CONTROL_TAKE_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");
	if (!is_non_empty_string(body.viewerId)) return invalid_request("`viewerId` is required.");

	const taken = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/control/take-human",
		{ sessionId: body.sessionId, navGen: body.navGen, viewerId: body.viewerId },
	);
	return json_response(
		is_record(taken) ? taken : { ok: false, error: { code: "take_failed" } },
		200,
	);
}

async function handle_browser_control_resume(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_CONTROL_RESUME_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");

	const resumed = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/control/to-agent",
		{ sessionId: body.sessionId, navGen: body.navGen },
	);
	return json_response(
		is_record(resumed) ? resumed : { ok: false, error: { code: "resume_failed" } },
		200,
	);
}

// Viewer stream gateway
//
// The host routes the upgrade by its non-secret owner scope. The session object
// consumes the grant, shares one frame producer, and checks each input locally.

type ViewerHello = {
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	grantId: string;
	host: "docked" | "detached";
};

export type ViewerInput =
	| { kind: "mouse.move"; x: number; y: number }
	| { kind: "mouse.click"; x: number; y: number; button: "left" | "middle" | "right" }
	| { kind: "mouse.down"; button: "left" | "middle" | "right"; clickCount?: number }
	| { kind: "mouse.up"; button: "left" | "middle" | "right"; clickCount?: number }
	| { kind: "wheel"; x: number; y: number; dx: number; dy: number }
	| { kind: "key.press"; key: string }
	| { kind: "key.down"; key: string }
	| { kind: "key.up"; key: string }
	| { kind: "key.type"; text: string };

function is_coord(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3000;
}

function is_delta(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 3000;
}

function is_button(value: unknown): value is "left" | "middle" | "right" {
	return value === "left" || value === "middle" || value === "right";
}

function is_key(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 32;
}

export function parse_viewer_input(
	data: unknown,
): { ok: true; seq: string | number; controlGen: number; loadGen: number; input: ViewerInput } | { ok: false } {
	if (typeof data !== "string" || data.length === 0 || data.length > 4096) return { ok: false };
	let body: unknown;
	try {
		body = JSON.parse(data);
	} catch {
		return { ok: false };
	}
	if (!is_record(body) || body.t !== "input") return { ok: false };
	if (typeof body.seq !== "string" && typeof body.seq !== "number") return { ok: false };
	if (!is_positive_int(body.controlGen) || !Number.isSafeInteger(body.controlGen) ||
		!is_positive_int(body.loadGen) || !Number.isSafeInteger(body.loadGen)) return { ok: false };
	const lease = { controlGen: body.controlGen, loadGen: body.loadGen };

	switch (body.kind) {
		case "mouse.move":
			if (is_coord(body.x) && is_coord(body.y)) {
				return { ok: true, seq: body.seq, ...lease, input: { kind: "mouse.move", x: body.x, y: body.y } };
			}
			break;
		case "mouse.click":
			if (is_coord(body.x) && is_coord(body.y) && (body.button === undefined || is_button(body.button))) {
				return {
					ok: true,
					seq: body.seq,
					...lease,
					input: { kind: "mouse.click", x: body.x, y: body.y, button: is_button(body.button) ? body.button : "left" },
				};
			}
			break;
		case "mouse.down":
		case "mouse.up":
			if (
				(body.button === undefined || is_button(body.button)) &&
				(body.clickCount === undefined || (is_positive_int(body.clickCount) && body.clickCount <= 10))
			) {
				return {
					ok: true,
					seq: body.seq,
					...lease,
					input: { kind: body.kind, button: is_button(body.button) ? body.button : "left", clickCount: body.clickCount },
				};
			}
			break;
		case "wheel":
			if (is_coord(body.x) && is_coord(body.y) && is_delta(body.dx) && is_delta(body.dy)) {
				return {
					ok: true,
					seq: body.seq,
					...lease,
					input: { kind: "wheel", x: body.x, y: body.y, dx: body.dx, dy: body.dy },
				};
			}
			break;
		case "key.press":
		case "key.down":
		case "key.up":
			if (is_key(body.key)) {
				return { ok: true, seq: body.seq, ...lease, input: { kind: body.kind, key: body.key } };
			}
			break;
		case "key.type":
			if (typeof body.text === "string" && body.text.length > 0 && body.text.length <= 1024) {
				return { ok: true, seq: body.seq, ...lease, input: { kind: "key.type", text: body.text } };
			}
			break;
	}
	return { ok: false };
}

async function apply_viewer_input(page: Page, input: ViewerInput): Promise<void> {
	switch (input.kind) {
		case "mouse.move":
			await page.mouse.move(input.x, input.y);
			break;
		case "mouse.click":
			await page.mouse.click(input.x, input.y, { button: input.button });
			break;
		case "mouse.down":
			await page.mouse.down({ button: input.button, clickCount: input.clickCount });
			break;
		case "mouse.up":
			await page.mouse.up({ button: input.button, clickCount: input.clickCount });
			break;
		case "wheel":
			await page.mouse.move(input.x, input.y);
			await page.mouse.wheel(input.dx, input.dy);
			break;
		case "key.press":
			await page.keyboard.press(input.key);
			break;
		case "key.down":
			await page.keyboard.down(input.key);
			break;
		case "key.up":
			await page.keyboard.up(input.key);
			break;
		case "key.type":
			await page.keyboard.type(input.text);
			break;
	}
}

export function parse_viewer_hello(data: unknown): { ok: true; hello: ViewerHello } | { ok: false } {
	if (typeof data !== "string" || data.length === 0 || data.length > 4096) return { ok: false };
	let body: unknown;
	try {
		body = JSON.parse(data);
	} catch {
		return { ok: false };
	}
	if (!is_record(body)) return { ok: false };
	if (
		!is_non_empty_string(body.ownerId) ||
		!is_non_empty_string(body.organizationId) ||
		!is_non_empty_string(body.workspaceId) ||
		!is_non_empty_string(body.grantId) ||
		(body.host !== "docked" && body.host !== "detached")
	) {
		return { ok: false };
	}
	if (body.ownerId.length > 128 || body.organizationId.length > 128 || body.workspaceId.length > 128) {
		return { ok: false };
	}
	// Same charset pin as the host owner tuple: slot names join with `:` separators.
	const scopePattern = /^[A-Za-z0-9_-]+$/;
	if (
		!scopePattern.test(body.ownerId) ||
		!scopePattern.test(body.organizationId) ||
		!scopePattern.test(body.workspaceId)
	) {
		return { ok: false };
	}
	return {
		ok: true,
		hello: {
			ownerId: body.ownerId,
			organizationId: body.organizationId,
			workspaceId: body.workspaceId,
			grantId: body.grantId,
			host: body.host,
		},
	};
}

function close_socket(socket: WebSocket, code: number, reason: string): void {
	try {
		socket.close(code, reason);
	} catch {
		// The socket is already gone.
	}
}

async function handle_viewer_stream(request: Request, env: Env): Promise<Response> {
	if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
		return new Response("Upgrade required", { status: 426 });
	}
	if (env.BROWSER_RUNNER_DISABLED === "true") {
		return json_response({ ok: false, error: { code: "disabled", message: "Browser runner is disabled." } }, 503);
	}
	const url = new URL(request.url);
	const owners = parse_owner_tuple({
		ownerId: url.searchParams.get("ownerId"),
		organizationId: url.searchParams.get("organizationId"),
		workspaceId: url.searchParams.get("workspaceId"),
	});
	if (!owners.ok) return owners.response;
	return session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId).fetch(request);
}

export async function handle_request(
	request: Request,
	env: Env,
	ctx?: BrowserRunnerContext,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/health") {
		return json_response({ ok: true }, 200);
	}
	if (request.method === "GET" && url.pathname === "/viewer/stream") {
		return handle_viewer_stream(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/open") {
		return handle_browser_open(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/reload") {
		return handle_browser_reload(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/run") {
		return handle_browser_run(request, env, ctx);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/close") {
		return handle_browser_close(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/keep-open") {
		return handle_browser_keep_open(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/status") {
		return handle_browser_status(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/viewer-grant") {
		return handle_browser_viewer_grant(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/viewer-renew") {
		return handle_browser_viewer_renew(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/control-take") {
		return handle_browser_control_take(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/control-resume") {
		return handle_browser_control_resume(request, env);
	}
	return json_response({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
	fetch: handle_request,
};
