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
import { Buffer } from "node:buffer";
import { acquire, connect, sessions } from "@cloudflare/playwright";
import type { CDPSession, FileChooser, Page } from "@cloudflare/playwright";
import { CHILD_BUNDLE_JS } from "./child-bundle.gen";
import { AgentConnection } from "./agent-connection";
import {
	browser_web_canonical_host,
	browser_web_host_matches,
	browser_web_normalize_url,
	browser_web_URL_MAX_CHARS,
	browser_web_url_host_matches,
} from "common/browser-web-url.ts";

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
	list: <T>(options: { prefix: string }) => Promise<Map<string, T>>;
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
	/**
	 * Comma list of hosts the web browser may not open: our own app, backend, and Workers.
	 * A listed host also denies its subdomains.
	 */
	BROWSER_WEB_DENIED_HOSTS?: string;
	/**
	 * 32 random bytes, base64. Together with the per-profile key from Convex it locks the saved cookies.
	 */
	BROWSER_PROFILE_KEY: string;
	/**
	 * Comma list of app origins that may send a file to `PUT /viewer/upload` (CORS).
	 */
	BROWSER_APP_ORIGINS?: string;
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

type SessionRecordBase = {
	version: 1;
	sessionId: string;
	grantId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	navGen: number;
	loadGen: number;
	controlGen: number;
	control: SessionControl;
	providerSessionId: string | null;
	pageNonce: string | null;
	viewport: { width: number; height: number };
	command: { id: string; startedAt: number; connection?: "available" | "consumed" | "revoked" | "settled" } | null;
	commandCount: number;
	createdAt: number;
	providerAcquiredAt: number | null;
	lastActiveAt: number;
	attemptId: string;
	closeAttempts: number;
	inputHolder: string | null;
	viewers: Record<string, { host: string; controlGen: number; grantedUntil: number; lastInputAt: number; attachedAt: number }>;
	viewerGrants: Record<string, { navGen: number; expiresAt: number }>;
};

/**
 * File mode shows one workspace file on the controller page. Web mode opens real sites.
 */
type SessionRecord = SessionRecordBase &
	(
		| {
				mode: "file";
				nodeId: string;
				sourceKind: string;
				sourceVersion: string;
				sourceHash: string;
				htmlBytesTotal: number;
				loadCount: number;
		  }
		| {
				mode: "web";
				agentAccess: boolean;
				/**
				 * The one page target this session owns. A reconnect keeps it and closes other pages.
				 * It never leaves the runner.
				 */
				pageTargetId: string | null;
				/**
				 * The Convex profile doc id. The saved cookies belong to it.
				 */
				profileId: string;
				/**
				 * Hosts the user's agent may not use. A listed host also covers its subdomains.
				 */
				agentBlockedHosts: string[];
		  }
	);

type SessionMode = SessionRecord["mode"];

type WebSessionRecord = Extract<SessionRecord, { mode: "web" }>;

/**
 * The saved cookies of one browser profile, encrypted. Only the dates and `truncated` are plain.
 */
type ProfileBlob = { v: 1; profileId: string; iv: string; ciphertext: string; savedAt: number; truncated: boolean };

/**
 * The fields of a CDP `Network.Cookie` that the runner reads. A saved cookie keeps all its other fields too.
 */
type ProfileCookie = { name: string; value: string; domain: string; expires: number; session?: boolean };

/**
 * Proof of how long the provider browser was held. Convex bills from it.
 */
type UsageReceipt = { sessionId: string; providerAcquiredAt: number; endedAt: number; reason: string };

type RegistryRecord = {
	grants: Record<
		string,
		{ workspaceKey: string; ownerId: string; organizationId: string; state: "claimed" | "active"; expiresAt: number | null }
	>;
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
	webSessionTotalMs: 3_600_000,
	// Keep this below keepAliveMs. The provider ends a browser with no client after keepAliveMs,
	// so the idle close must run first, while the browser is still alive.
	webSessionIdleMs: 540_000,
	webCommandsPerSession: 120,
	userSessions: 2,
	workspaceSessions: 2,
	organizationSessions: 4,
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
	// The app renews every 20 s. A background tab may run that timer only once a minute (Chrome
	// timer throttling), so the window must outlast a renew that comes about a minute late.
	viewerGrantWindowMs: 90_000,
	viewerPollMs: 5_000,
	viewerMessageChars: 16_384,
	textInsertChars: 4000,
	titleChars: 1024,
	popupUrlWaitMs: 5_000,
	navWallMs: 5_000,
	openNavWallMs: 10_000,
	usageReceiptMs: 7 * 24 * 60 * 60 * 1000,
	profileCookies: 3000,
	profileJsonBytes: 1_048_576,
	profileSaveEveryMs: 120_000,
	// Above the 90-day Convex profile expiry, so Convex normally deletes the profile first.
	profileKeepMs: 100 * 24 * 60 * 60 * 1000,
	profileTombstoneMs: 7 * 24 * 60 * 60 * 1000,
	profileCdpMs: 10_000,
	agentBlockedHosts: 50,
	hostChars: 253,
	downloadHumanBytes: 26_214_400,
	downloadAgentBytes: 8_388_608,
	downloadSessionFiles: 20,
	downloadSessionBytes: 104_857_600,
	downloadStarts: 3,
	downloadStartWindowMs: 10_000,
	downloadGestureMs: 10_000,
	downloadKeepMs: 120_000,
	downloadCaptureMs: 30_000,
	downloadNameChars: 255,
	downloadChunkBytes: 1_048_576,
	uploadBytes: 20_971_520,
	uploadFiles: 10,
	uploadGrantMs: 120_000,
	// One `upload-fill`: all reads plus `setFiles`. Convex waits longer than this for the reply.
	uploadFillMs: 120_000,
	uploadSetFilesMs: 30_000,
	chooserMs: 300_000,
	chooserAcceptChars: 512,
} as const;

/**
 * Time and command limits for one session mode.
 */
function mode_limits(mode: SessionMode) {
	return mode === "web"
		? { totalMs: LIMITS.webSessionTotalMs, idleMs: LIMITS.webSessionIdleMs, commands: LIMITS.webCommandsPerSession }
		: { totalMs: LIMITS.sessionTotalMs, idleMs: LIMITS.sessionIdleMs, commands: LIMITS.commandsPerSession };
}

const COMPAT_DATE = "2026-09-19";
const CHILD_COMPAT_DATE = "2026-09-19";
const CHILD_ENTRY_MODULE = "executor.js";
const CHILD_BUNDLE_MODULE = "pw.js";
const CONTROLLER_ORIGIN = "https://controller.browser.invalid";
const CONTROLLER_URL = `${CONTROLLER_ORIGIN}/`;
const SESSION_KEY = "session";
const USAGE_KEY_PREFIX = "usage:";
const PROFILE_BLOB_KEY = "profile";
const PROFILE_DELETE_AT_KEY = "profileDeleteAt";
const PROFILE_DELETED_KEY_PREFIX = "profileDeleted:";
const REGISTRY_KEY = "registry";
const REGISTRY_NAME = "registry";
const BROWSER_OPEN_FIELDS = new Set([
	"mode",
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
const BROWSER_WEB_OPEN_FIELDS = new Set([
	"mode",
	"attemptId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"startUrl",
	"viewport",
	"agentAccess",
	"profileId",
	"profileKey",
	"agentBlockedHosts",
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
	"mode",
]);
const BROWSER_WEB_RELOAD_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen", "mode", "expectedAgentLease"]);
const BROWSER_CLOSE_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"reason",
	"expectedAgentLease",
	"saveProfile",
]);
const BROWSER_AGENT_ACCESS_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "on"]);
const BROWSER_STATUS_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId"]);
const BROWSER_KEEP_OPEN_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_GRANT_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_RENEW_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "viewerId"]);
const BROWSER_CONTROL_TAKE_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen", "viewerId"]);
const BROWSER_CONTROL_RESUME_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_PROFILE_SUMMARY_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "profileId", "profileKey"]);
const BROWSER_PROFILE_CLEAR_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "profileId", "profileKey", "domain"]);
const BROWSER_PROFILE_DELETE_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "profileId"]);
const BROWSER_DOWNLOAD_INFO_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "sessionId", "downloadId"]);
const BROWSER_DOWNLOAD_PUSH_FIELDS = new Set([...BROWSER_DOWNLOAD_INFO_FIELDS, "url", "headers"]);
const BROWSER_UPLOAD_GRANT_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "sessionId", "chooserId", "controlGen"]);
const BROWSER_UPLOAD_FILL_FIELDS = new Set([...BROWSER_UPLOAD_GRANT_FIELDS, "files"]);
const BROWSER_UPLOAD_FILE_FIELDS = new Set(["name", "contentType", "url"]);
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
	// Drop URL query and fragment: page URLs can carry tokens, and this text reaches Convex.
	const text = message.replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/giu, "$1");
	return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/**
 * Read the deny list from the comma list in `BROWSER_WEB_DENIED_HOSTS`.
 */
function web_denied_hosts(env: Env) {
	return (env.BROWSER_WEB_DENIED_HOSTS ?? "")
		.split(",")
		.map((host) => host.trim())
		.filter((host) => host !== "");
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

/**
 * Read a body up to `maxBytes`. When `signal` aborts, cancel the body and throw: a caller that
 * gave up must not keep reading into memory.
 */
async function read_bounded_stream(stream: ReadableStream<Uint8Array> | null, maxBytes: number, signal?: AbortSignal) {
	if (!stream) return { bytes: new Uint8Array(), truncated: false };

	const reader = stream.getReader();
	const stop = () => {
		reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", stop, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			// A cancel ends the read like a normal end. Those bytes are not the whole body.
			signal?.throwIfAborted();
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
		signal?.removeEventListener("abort", stop);
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

// Saved browser profile
//
// Web mode keeps the user's cookies between sessions. They are stored in this object's storage,
// encrypted with AES-GCM. The key needs two parts: the runner secret `BROWSER_PROFILE_KEY` and
// a random key from the Convex profile doc. So deleting the Convex doc makes the stored bytes
// unreadable at once. The key lives only in memory, never in storage.

function base64_bytes(value: string) {
	try {
		return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

function bytes_base64(bytes: Uint8Array) {
	// Encode whole three-byte groups so the joined chunks stay valid base64.
	const parts: string[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += 3 * 8192) {
		parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 3 * 8192))));
	}
	return parts.join("");
}

/**
 * True when `value` is base64 for exactly 32 bytes, the size of both key parts.
 */
function is_profile_key(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && base64_bytes(value)?.byteLength === 32;
}

/**
 * The profile id is a Convex doc id. It is part of a storage key, so pin the charset.
 */
function is_profile_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

/**
 * Key = SHA-256(secret, 0, "browser-profile", 0, profileKey), used as an AES-GCM-256 key.
 */
async function profile_crypto_key(secret: string | undefined, profileKey: string) {
	const secretBytes = base64_bytes(secret ?? "");
	const keyBytes = base64_bytes(profileKey);
	if (secretBytes?.byteLength !== 32 || keyBytes?.byteLength !== 32) throw new Error("Browser profile key is invalid.");
	const label = TEXT_ENCODER.encode("browser-profile");
	const zero = new Uint8Array(1);
	const material = append_bytes([secretBytes, zero, label, zero, keyBytes], 32 + 1 + label.byteLength + 1 + 32);
	const digest = await crypto.subtle.digest("SHA-256", material);
	return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * The extra data every encryption binds: a blob from another profile, owner, or workspace does not decrypt.
 */
function profile_aad(profileId: string, scope: { ownerId: string; organizationId: string; workspaceId: string }) {
	return TEXT_ENCODER.encode(JSON.stringify([profileId, scope.ownerId, scope.organizationId, scope.workspaceId]));
}

async function profile_encrypt(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, cookies: ProfileCookie[]) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = TEXT_ENCODER.encode(JSON.stringify({ cookies }));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain);
	return { iv: bytes_base64(iv), ciphertext: bytes_base64(new Uint8Array(sealed)) };
}

async function profile_decrypt(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, blob: ProfileBlob) {
	const iv = base64_bytes(blob.iv);
	const sealed = base64_bytes(blob.ciphertext);
	if (!iv || !sealed) throw new Error("Browser profile is damaged.");
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, sealed);
	const parsed: unknown = JSON.parse(TEXT_DECODER.decode(plain));
	if (!is_record(parsed) || !Array.isArray(parsed.cookies)) throw new Error("Browser profile is damaged.");
	return parsed.cookies.filter(is_profile_cookie);
}

function is_profile_cookie(value: unknown): value is ProfileCookie {
	return is_record(value) && typeof value.name === "string" && typeof value.value === "string" &&
		typeof value.domain === "string" && typeof value.expires === "number";
}

/**
 * The site a cookie belongs to: its domain without the leading dot, in canonical form.
 */
function cookie_site(cookie: ProfileCookie) {
	return browser_web_canonical_host(cookie.domain.replace(/^\./u, ""));
}

/**
 * Pick the cookies to save: never cookies of our own hosts, at most 3,000, and at most 1 MiB of JSON.
 */
function profile_cookies_to_save(value: unknown, deniedHosts: readonly string[]) {
	const cookies = (Array.isArray(value) ? value : [])
		.filter(is_profile_cookie)
		.filter((cookie) => !browser_web_host_matches(cookie_site(cookie), deniedHosts));
	// Keep the cookies that live longest. A session cookie has no expiry date and is often the
	// login itself, so it sorts first.
	const expiry = (cookie: ProfileCookie) => (cookie.session === true || cookie.expires <= 0 ? Number.MAX_VALUE : cookie.expires);
	cookies.sort((a, b) => expiry(b) - expiry(a));

	let truncated = cookies.length > LIMITS.profileCookies;
	const kept: ProfileCookie[] = [];
	let jsonBytes = byte_length(JSON.stringify({ cookies: [] }));
	for (const cookie of cookies.slice(0, LIMITS.profileCookies)) {
		// One comma between list items.
		const size = byte_length(JSON.stringify(cookie)) + (kept.length > 0 ? 1 : 0);
		if (jsonBytes + size > LIMITS.profileJsonBytes) {
			truncated = true;
			break;
		}
		kept.push(cookie);
		jsonBytes += size;
	}
	return { cookies: kept, truncated };
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
// then runs the agent code with `(page, frame, expect, emitFile)`. In web mode
// there is no preview frame: `frame` is the page's main frame. Console and
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
    if (input.mode !== "file" && input.mode !== "web") {
      throw new Error("Missing session mode.");
    }
    if (input.mode === "file" && (typeof input.runtimeOrigin !== "string" || !input.runtimeOrigin)) {
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
      var frame;
      if (input.mode === "web") {
        frame = page.mainFrame();
      } else {
        var outer = await waitForFrame(findOuter, 10000, "Preview frame not found.");
        frame = await waitForFrame(function () {
          var kids = outer.childFrames();
          return kids.length === 1 ? kids[0] : null;
        }, 10000, "Preview content not ready.");
      }
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
      // The model often sends a whole function instead of its body. That code only defines the
      // function, so nothing runs. Say so instead of reporting an empty success.
      if (typeof __result === "function" || (__result === undefined && __SNIPPET_IS_FUNCTION__)) {
        return { ok: false, error: { name: "TypeError", message: "Your code returned a function. Write the function body only, do not wrap it in a function." }, consoleEntries: consoleEntries, pageErrors: pageErrors, logs: logs, logsTruncated: logsTruncated };
      }
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

/**
 * True when the snippet is one function and nothing else, like `async ({ page }) => { ... }`.
 * Such code only defines the function, so it never runs. A named function that the code uses
 * again (a helper it calls) is fine.
 */
function snippet_is_function(code: string) {
	// Skip leading blank lines and comments.
	const start = code.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, "");
	if (/^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/u.test(start)) return true;
	const name = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/u.exec(start)?.[1];
	return name !== undefined && start.split(/[^\w$]+/u).filter((word) => word === name).length === 1;
}

export function build_executor_module(user_code: string): string {
	return EXECUTOR_PREFIX + user_code + EXECUTOR_SUFFIX.replace("__SNIPPET_IS_FUNCTION__", String(snippet_is_function(user_code)));
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
	const limits = mode_limits(record.mode);
	if (record.providerAcquiredAt !== null && now - record.providerAcquiredAt >= limits.totalMs) {
		return true;
	}
	return now - record.lastActiveAt >= limits.idleMs;
}

export function session_next_alarm(record: SessionRecord): number | null {
	if (record.control === "closed") return null;
	const limits = mode_limits(record.mode);
	const deadlines: number[] = [record.lastActiveAt + limits.idleMs];
	if (record.providerAcquiredAt !== null) {
		deadlines.push(record.providerAcquiredAt + limits.totalMs);
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
	// The user turned agent access off for this web session. No new command may start.
	if (record.mode === "web" && !record.agentAccess) return { ok: false, reason: "agent_access_off" };
	if (record.navGen !== input.navGen) return { ok: false, reason: "stale_nav" };
	if (record.loadGen !== input.loadGen) return { ok: false, reason: "stale_load" };
	// Control state before generations: a caller with a retired lease still
	// deserves the actionable reason while a human holds the page.
	if (record.control !== "ready" && record.control !== "agent") return { ok: false, reason: "control" };
	if (record.controlGen !== input.controlGen) return { ok: false, reason: "stale_control" };
	// Keep this code apart from the other `busy` causes: the app shows a special message
	// ("another chat is using the browser") only for this case. A reload holds the same slot
	// without an agent connection, so it stays plain `busy`.
	if (record.command && now - record.command.startedAt < LIMITS.commandTimeoutMs + 10_000) {
		return { ok: false, reason: record.command.connection ? "busy_command" : "busy" };
	}
	if (record.commandCount >= mode_limits(record.mode).commands) return { ok: false, reason: "session_limit" };
	if (!record.providerSessionId || !record.pageNonce) return { ok: false, reason: "not_ready" };
	return { ok: true };
}

// Registry object
//
// Owns deployment-wide, per-workspace, per-organization, and per-user admission slots. Claims expire fast so
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

function count_registry(record: RegistryRecord, claim: { workspaceKey: string; ownerId: string; organizationId: string }) {
	let deployment = 0;
	let workspace = 0;
	let organization = 0;
	let user = 0;
	for (const grant of Object.values(record.grants)) {
		deployment += 1;
		if (grant.workspaceKey === claim.workspaceKey) workspace += 1;
		if (grant.organizationId === claim.organizationId) organization += 1;
		if (grant.ownerId === claim.ownerId) user += 1;
	}
	return { deployment, workspace, organization, user };
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

	private async claim(claim: { workspaceKey: string; ownerId: string; organizationId: string }): Promise<Response> {
		const record = await this.load();
		const now = Date.now();
		sweep_registry(record, now);
		const counts = count_registry(record, claim);
		if (counts.deployment >= LIMITS.deploymentSessions) {
			log_browser({ route: "registry_claim", refused: "deployment_busy" });
			return json_response({ ok: false, error: { code: "deployment_busy" } }, 200);
		}
		if (counts.workspace >= LIMITS.workspaceSessions) {
			log_browser({ route: "registry_claim", refused: "workspace_busy" });
			return json_response({ ok: false, error: { code: "workspace_busy" } }, 200);
		}
		if (counts.organization >= LIMITS.organizationSessions) {
			log_browser({ route: "registry_claim", refused: "organization_limit" });
			return json_response({ ok: false, error: { code: "organization_limit" } }, 200);
		}
		if (counts.user >= LIMITS.userSessions) {
			log_browser({ route: "registry_claim", refused: "user_limit" });
			return json_response({ ok: false, error: { code: "user_limit" } }, 200);
		}

		const grantId = crypto.randomUUID();
		record.grants[grantId] = {
			workspaceKey: claim.workspaceKey,
			ownerId: claim.ownerId,
			organizationId: claim.organizationId,
			state: "claimed",
			expiresAt: now + LIMITS.grantTtlMs,
		};
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

		if (
			url.pathname === "/claim" &&
			typeof body.workspaceKey === "string" &&
			typeof body.ownerId === "string" &&
			typeof body.organizationId === "string"
		) {
			return await this.claim({ workspaceKey: body.workspaceKey, ownerId: body.ownerId, organizationId: body.organizationId });
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

/**
 * Acquire a browser for web mode and return its one page target.
 */
async function acquire_web_browser(binding: BrowserWorker): Promise<{ providerSessionId: string; pageTargetId: string }> {
	// No guardrails: web mode opens real sites. The provider egress proxy still refuses private
	// and metadata addresses, and Chrome blocks loopback.
	const acquired = await acquire(binding, { keep_alive: LIMITS.keepAliveMs, recording: false });
	const providerSessionId = acquired.sessionId;
	try {
		const browser = await connect_persistent(providerSessionId);
		try {
			const context = browser.contexts()[0] ?? (await browser.newContext());
			const page = context.pages()[0] ?? (await context.newPage());
			if (browser.contexts().length !== 1 || context.pages().length !== 1) {
				throw new Error("Unexpected targets after bootstrap.");
			}
			const cdp = await context.newCDPSession(page);
			const info: unknown = await cdp.send("Target.getTargetInfo");
			await cdp.detach().catch(() => {});
			if (!is_record(info) || !is_record(info.targetInfo) || !is_non_empty_string(info.targetInfo.targetId)) {
				throw new Error("Browser target is unavailable.");
			}
			return { providerSessionId, pageTargetId: info.targetInfo.targetId };
		} finally {
			try {
				await browser.close();
			} catch {
				// The client connection is best-effort; the session persists server-side.
			}
		}
	} catch (error) {
		try {
			await close_browser_provider(binding, providerSessionId);
		} catch {
			// Ignored: the provider keep-alive expiry is the backstop.
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

// Downloads and uploads (web mode)
//
// A real Chrome download lands on the provider's disk, where CDP cannot read it. So the host
// pauses page loads at the response stage and reads the body itself when Chrome would save it.
// Downloads that skip the network (`<a download>`, `data:`) reach the `Browser.downloadWillBegin`
// safety net. File choosers are answered with bytes the user picked in the app.

/**
 * The `Fetch` pattern that pauses every page load after its headers arrive. It stays on for the
 * whole web session.
 */
const DOWNLOAD_FETCH_PATTERN = { urlPattern: "*", resourceType: "Document", requestStage: "Response" } as const;

type DownloadOwner = { kind: "human" } | { kind: "agent"; commandId: string };

/**
 * One captured human download, kept in memory until Convex saves it or it expires.
 */
type HeldDownload = {
	downloadId: string;
	name: string;
	size: number;
	contentType: string;
	origin: string | null;
	bytes: Uint8Array<ArrayBuffer>;
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
	pushing: Promise<boolean> | null;
};

type DownloadRead = { over: true } | { over: false; bytes: Uint8Array<ArrayBuffer>; contentType: string };

/**
 * The value of a header in a CDP header list, or null. Names are case-insensitive.
 */
function cdp_header(headers: unknown, name: string) {
	if (!Array.isArray(headers)) return null;
	for (const header of headers) {
		if (is_record(header) && typeof header.name === "string" && typeof header.value === "string" &&
			header.name.toLowerCase() === name) return header.value;
	}
	return null;
}

/**
 * The MIME type without parameters, like `application/zip`, or "" when there is none.
 */
function mime_essence(contentType: string | null) {
	return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase().slice(0, LIMITS.fileContentTypeChars);
}

/**
 * The types Chrome shows in the tab, besides `audio/*` and `video/*`. Chrome saves other types,
 * even some `text/*` and `image/*` ones like `text/csv` or `image/tiff`.
 */
const SHOWN_CONTENT_TYPES = new Set([
	"text/html", "text/plain", "text/css", "text/javascript", "text/xml",
	"application/xhtml+xml", "application/xml", "application/json", "application/javascript", "application/pdf",
	"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/x-icon",
	"image/vnd.microsoft.icon",
]);

/**
 * True when Chrome would save this response instead of showing it: an `attachment` disposition,
 * or a type Chrome does not show. A response with no type is left to Chrome.
 */
function is_download_response(disposition: string | null, contentType: string | null) {
	if (disposition !== null && disposition.split(";", 1)[0]!.trim().toLowerCase() === "attachment") return true;
	const mime = mime_essence(contentType);
	if (mime === "") return false;
	const shown = SHOWN_CONTENT_TYPES.has(mime) || mime.startsWith("audio/") || mime.startsWith("video/");
	return !shown;
}

/**
 * The raw file name: `filename*` (RFC 5987), then `filename`, then the last URL path segment,
 * then `download`. Convex and the app server clean it up; here it is only cut to 255 characters.
 */
function download_name(disposition: string | null, url: string) {
	const params = new Map<string, string>();
	for (const match of (disposition ?? "").matchAll(/;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/gu)) {
		const value = match[2]!.trim();
		params.set(match[1]!.toLowerCase(), value.startsWith("\"") ? value.slice(1, -1).replace(/\\(.)/gu, "$1") : value);
	}
	let name = "";
	const extended = /^([^']*)'[^']*'(.*)$/u.exec(params.get("filename*") ?? "");
	if (extended) {
		const charset = extended[1]!.toLowerCase();
		try {
			if (charset === "utf-8") name = decodeURIComponent(extended[2]!);
			// Latin-1 maps each byte to the same code point.
			if (charset === "iso-8859-1") name = extended[2]!.replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
		} catch {
			name = "";
		}
	}
	if (name === "") name = params.get("filename") ?? "";
	if (name === "" && /^https?:/iu.test(url)) {
		try {
			const segment = new URL(url).pathname.split("/").filter((part) => part !== "").at(-1) ?? "";
			try {
				name = decodeURIComponent(segment);
			} catch {
				name = segment;
			}
		} catch {
			name = "";
		}
	}
	return cap_download_name(name);
}

function cap_download_name(name: string) {
	// Do not leave half of a surrogate pair at the cut.
	const capped = name.slice(0, LIMITS.downloadNameChars).replace(/[\uD800-\uDBFF]$/u, "");
	return capped === "" ? "download" : capped;
}

/**
 * Where a download came from, for the saved file's metadata. `data:` and other opaque URLs have none.
 */
function download_origin(url: string) {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/**
 * Decode a `data:` URL. Its `%xx` escapes are raw bytes, and the rest is UTF-8.
 */
function decode_data_url(url: string) {
	const comma = url.indexOf(",");
	if (!/^data:/iu.test(url) || comma < 0) return null;
	const meta = url.slice(5, comma);
	const data = url.slice(comma + 1);
	const contentType = mime_essence(meta.replace(/;base64$/iu, "")) || "text/plain";
	if (/;base64$/iu.test(meta)) {
		const bytes = base64_bytes(data.replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\s/gu, ""));
		return bytes ? { contentType, bytes } : null;
	}
	const chunks = data.split(/(%[0-9a-fA-F]{2})/u).map((part) =>
		/^%[0-9a-fA-F]{2}$/u.test(part) ? new Uint8Array([parseInt(part.slice(1), 16)]) : TEXT_ENCODER.encode(part));
	return { contentType, bytes: append_bytes(chunks, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)) };
}

/**
 * Read a CDP `IO` stream in 1 MiB chunks. Stop as soon as it grows past `maxBytes`, or at the next
 * chunk after `signal` aborts.
 */
async function read_cdp_stream(cdp: CDPSession, handle: string, maxBytes: number, signal: AbortSignal): Promise<{ over: true } | { over: false; bytes: Uint8Array<ArrayBuffer> }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		signal.throwIfAborted();
		const read = await with_wall_timeout(cdp.send("IO.read", { handle, size: LIMITS.downloadChunkBytes }), 10_000);
		const chunk = read.base64Encoded ? base64_bytes(read.data) : TEXT_ENCODER.encode(read.data);
		if (!chunk) throw new Error("Download chunk is damaged.");
		size += chunk.byteLength;
		if (size > maxBytes) return { over: true };
		chunks.push(chunk);
		if (read.eof) return { over: false, bytes: append_bytes(chunks, size) };
	}
}

/**
 * The file bytes a chooser fill gives to the page.
 */
type ChooserFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * The one open file chooser of the live web session. It stays in memory: the Playwright handle
 * cannot be stored. It is current only while its host connection, main-frame navigation count,
 * and `controlGen` are unchanged and it is under 5 minutes old.
 */
type OpenFileChooser = {
	sessionId: string;
	chooserId: string;
	host: HostConnection;
	chooser: FileChooser;
	multiple: boolean;
	accept: string;
	origin: string;
	mainNavCount: number;
	controlGen: number;
	openedAt: number;
	timer: ReturnType<typeof setTimeout>;
	busy: boolean;
};

/**
 * The origin of the document that owns the chooser's input. It runs in Playwright's utility world,
 * so page scripts cannot change the answer.
 */
async function chooser_origin(chooser: FileChooser) {
	return await with_wall_timeout(chooser.element().evaluate((node) => node.ownerDocument?.location.origin ?? null), 5000);
}

/**
 * The app origins in `BROWSER_APP_ORIGINS` that may upload through the viewer route.
 */
function app_origins(env: Env) {
	return (env.BROWSER_APP_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin !== "");
}

/**
 * Set the host page's `Fetch` patterns. The download pattern is always on in web mode. An agent
 * command with blocked sites adds the request-stage filter. One `Fetch.enable` replaces the whole
 * list, so both must go in every call.
 */
async function set_fetch_patterns(cdp: CDPSession, agentFilter: boolean) {
	const filter = agentFilter
		? (["Document", "XHR", "Fetch"] as const).map((resourceType) => ({ urlPattern: "*", resourceType, requestStage: "Request" as const }))
		: [];
	await with_wall_timeout(cdp.send("Fetch.enable", { patterns: [DOWNLOAD_FETCH_PATTERN, ...filter] }), 5000);
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
	navGen: number;
	viewport: { width: number; height: number };
} & (
	| {
			mode: "file";
			nodeId: string;
			sourceKind: string;
			sourceVersion: string;
			sourceHash: string;
			html: string;
	  }
	| { mode: "web"; startUrl: string | null; agentAccess: boolean; profileId: string; profileKey: string; agentBlockedHosts: string[] }
);

type ViewerStream = {
	socket: WebSocket;
	sessionId: string;
	viewerId: string;
	frameSeqs: number[];
	lastFrameSeq: number;
	deadlineTimer: ReturnType<typeof setTimeout> | null;
};

type HostConnection = {
	sessionId: string;
	browser: Awaited<ReturnType<typeof connect>>;
	page: Page;
	cdp: CDPSession;
	browserCdp: CDPSession;
	targetId: string;
	contextId: string | undefined;
	/**
	 * Web mode: true while the main frame loads. The viewer location bar shows it.
	 */
	loading: boolean;
	/**
	 * Web mode: counts cross-document main-frame navigations. A file chooser from an older page is gone.
	 */
	mainNavCount: number;
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
	private hostConnection: HostConnection | null = null;
	private locationSeq = 0;
	private hostStart: { sessionId: string; promise: Promise<void> } | null = null;
	/**
	 * Web mode: the live session's profile key, only in memory. After a restart it is gone, and
	 * saves are skipped until the next open. `dirty` means people or the agent used the page since
	 * the last save.
	 */
	private profile: { sessionId: string; profileId: string; key: CryptoKey; dirty: boolean; savedAt: number } | null = null;
	/**
	 * Counts profile saves. A save only writes when no newer save started after it, so a slow
	 * periodic save cannot overwrite the End save that read a newer cookie jar.
	 */
	private profileSaveSeq = 0;
	/**
	 * Web mode: the last human click or Enter. One human download may start within 10 seconds of it.
	 */
	private humanGesture: { sessionId: string; at: number } | null = null;
	/**
	 * Web mode: the live session's downloads, only in memory. `held` is the one human download that
	 * waits for Convex to save it. `agent` collects the running command's downloads for `run/finish`.
	 * `pushed` remembers saved ids, so a repeated push answers ok.
	 */
	private downloads: {
		sessionId: string;
		count: number;
		bytes: number;
		starts: number[];
		capture: Promise<void> | null;
		held: HeldDownload | null;
		pushed: Set<string>;
		agent: { commandId: string; items: Array<{ name: string; contentType: string; bytes: Uint8Array<ArrayBuffer> }>; bytes: number; dropped: number } | null;
	} | null = null;
	/**
	 * Web mode: running safety-net downloads. They check their frame before the capture starts.
	 * `run/finish` waits for them, so a download from the command's last step joins its result.
	 */
	private safetyNetDownloads = new Set<Promise<void>>();
	private chooser: OpenFileChooser | null = null;
	/**
	 * Single-use grants for `PUT /viewer/upload`, each bound to one chooser. Only in memory.
	 */
	private uploadGrants = new Map<string, { sessionId: string; chooserId: string; controlGen: number; expiresAt: number }>();

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

	/**
	 * The only alarm writer. The alarm serves the session deadlines, the saved profile's 100-day
	 * delete time, and the 7-day delete time of the oldest profile tombstone, so it must always be
	 * the earliest of them.
	 */
	private async schedule_alarm(record: SessionRecord | null): Promise<void> {
		const [profileDeleteAt, tombstones] = await Promise.all([
			this.state.storage.get<number>(PROFILE_DELETE_AT_KEY),
			this.state.storage.list<number>({ prefix: PROFILE_DELETED_KEY_PREFIX }),
		]);
		const tombstoneAt = tombstones.size > 0 ? Math.min(...tombstones.values()) + LIMITS.profileTombstoneMs : null;
		// A close that the provider did not confirm is retried in 30 seconds.
		const sessionAt = record?.control === "closing" ? Date.now() + 30_000 : record ? session_next_alarm(record) : null;
		const times = [sessionAt, profileDeleteAt ?? null, tombstoneAt].filter((time) => time !== null);
		if (times.length === 0) {
			await this.state.storage.deleteAlarm();
		} else {
			await this.state.storage.setAlarm(Math.min(...times));
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
		const limits = mode_limits(record.mode);
		const shared = {
			sessionId: record.sessionId,
			navGen: record.navGen,
			loadGen: record.loadGen,
			controlGen: record.controlGen,
			control: record.control,
			pageNonce: record.pageNonce,
			commandCount: record.commandCount,
			idleUntil: record.lastActiveAt + limits.idleMs,
			totalUntil: record.providerAcquiredAt! + limits.totalMs,
		};
		if (record.mode === "web") {
			return { mode: "web" as const, ...shared, agentAccess: record.agentAccess };
		}
		return {
			mode: "file" as const,
			...shared,
			nodeId: record.nodeId,
			sourceKind: record.sourceKind,
			sourceVersion: record.sourceVersion,
			sourceHash: record.sourceHash,
			loadCount: record.loadCount,
		};
	}

	/**
	 * Read the usage receipt for a session, without its session id.
	 */
	private async usage(sessionId: string) {
		const receipt = await this.state.storage.get<UsageReceipt>(`${USAGE_KEY_PREFIX}${sessionId}`);
		if (!receipt) return null;
		return { providerAcquiredAt: receipt.providerAcquiredAt, endedAt: receipt.endedAt, reason: receipt.reason };
	}

	/**
	 * Put the saved cookies of this profile into the new browser. Any failure starts empty and
	 * logs only a code. A blob of another profile id is ignored; the next save replaces it.
	 */
	private async restore_profile(record: WebSessionRecord, host: HostConnection): Promise<void> {
		const profile = this.profile;
		if (profile?.sessionId !== record.sessionId) return;
		try {
			const stored = await this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY);
			if (stored?.profileId !== profile.profileId) return;
			const cookies = await profile_decrypt(profile.key, profile_aad(profile.profileId, record), stored);
			// Without `browserContextId`: the page lives in the default context (checked live on 2026-09-23).
			if (cookies.length > 0) await with_wall_timeout(host.browserCdp.send("Storage.setCookies", { cookies }), LIMITS.profileCdpMs);
			log_browser({ route: "profile_restore", sessionId: record.sessionId, cookies: cookies.length });
		} catch (error) {
			log_browser({ route: "profile_restore", sessionId: record.sessionId, error: sanitize_error(error).name });
		}
	}

	/**
	 * Decide if a close saves the cookies. Human End asks for it with `saveProfile: true`, and idle
	 * or total expiry saves too. Security, internal, and failure closes never save: that page may
	 * not be in a state the user wants to keep. The agent's `browser_close` does not save either;
	 * its work is saved by the next End, expiry, or periodic save.
	 */
	private should_save(record: SessionRecord, reason: string, saveProfile: boolean | undefined) {
		// After a restart the key is gone, so nothing can be saved.
		if (record.mode !== "web" || this.profile?.sessionId !== record.sessionId) return false;
		if (reason === "close") return saveProfile === true;
		return reason === "expired";
	}

	/**
	 * Save the browser cookies, encrypted. A failure only logs a code: it must never block a close.
	 */
	private async save_profile(record: SessionRecord): Promise<void> {
		const profile = this.profile;
		if (record.mode !== "web" || profile?.sessionId !== record.sessionId) return;
		const seq = ++this.profileSaveSeq;
		// Input during the save marks the profile dirty again.
		profile.dirty = false;
		profile.savedAt = Date.now();
		try {
			if (this.hostConnection?.sessionId !== record.sessionId) {
				await with_wall_timeout(this.connect_host(record, { closeOnFailure: false }), LIMITS.profileCdpMs);
			}
			const host = this.hostConnection;
			if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
			// Without `browserContextId`: with the page's context id Chromium answers "Failed to find
			// browser context" (checked live on 2026-09-23).
			const reply: unknown = await with_wall_timeout(host.browserCdp.send("Storage.getCookies"), LIMITS.profileCdpMs);
			const { cookies, truncated } = profile_cookies_to_save(is_record(reply) ? reply.cookies : null, web_denied_hosts(this.env));
			const sealed = await profile_encrypt(profile.key, profile_aad(profile.profileId, record), cookies);

			// A `profile-delete` may have run during the awaits above. Check its tombstone and the
			// record right before the put, with storage reads only. The object holds other events
			// while storage reads run, so nothing can slip in between these reads and the put.
			const [deletedAt, current] = await Promise.all([
				this.state.storage.get<number>(`${PROFILE_DELETED_KEY_PREFIX}${profile.profileId}`),
				this.state.storage.get<SessionRecord>(SESSION_KEY),
			]);
			if (deletedAt !== undefined || current?.sessionId !== record.sessionId || current.mode !== "web" ||
				current.profileId !== profile.profileId) {
				log_browser({ route: "profile_save", sessionId: record.sessionId, skipped: "deleted" });
				return;
			}
			if (seq !== this.profileSaveSeq) {
				log_browser({ route: "profile_save", sessionId: record.sessionId, skipped: "newer_save" });
				return;
			}
			const savedAt = Date.now();
			const blob: ProfileBlob = { v: 1, profileId: profile.profileId, ...sealed, savedAt, truncated };
			await this.state.storage.put(PROFILE_BLOB_KEY, blob);
			await this.state.storage.put(PROFILE_DELETE_AT_KEY, savedAt + LIMITS.profileKeepMs);
			await this.schedule_alarm(current);
			log_browser({ route: "profile_save", sessionId: record.sessionId, cookies: cookies.length, truncated });
		} catch (error) {
			profile.dirty = true;
			log_browser({ route: "profile_save", sessionId: record.sessionId, error: sanitize_error(error).name });
		}
	}

	/**
	 * Web mode: true when the main page is on a site the user's agent may not use.
	 */
	private async main_page_blocked(record: WebSessionRecord): Promise<boolean> {
		await with_wall_timeout(this.connect_host(record), 10_000);
		const host = this.hostConnection;
		if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
		const history: unknown = await with_wall_timeout(host.cdp.send("Page.getNavigationHistory"), 5000);
		if (!is_record(history) || !Array.isArray(history.entries) || typeof history.currentIndex !== "number") {
			throw new Error("Browser history is unavailable.");
		}
		const entry: unknown = history.entries[history.currentIndex];
		return is_record(entry) && typeof entry.url === "string" && browser_web_url_host_matches(entry.url, record.agentBlockedHosts);
	}

	/**
	 * Turn the blocked-site request filter on for an agent command, or off after it. It fails page,
	 * XHR, and fetch requests to blocked sites at the request stage. This is best effort: other
	 * request types and cross-site frames are not covered.
	 */
	private async set_agent_site_filter(sessionId: string, on: boolean): Promise<void> {
		const host = this.hostConnection;
		if (!host || host.sessionId !== sessionId) throw new Error("Browser session changed.");
		await set_fetch_patterns(host.cdp, on);
	}

	private async open(input: SessionOpenInput): Promise<Response> {
		// Check the start address before anything is acquired, so a refusal costs no browser time.
		let startUrl: string | null = null;
		if (input.mode === "web" && input.startUrl !== null) {
			const normalized = browser_web_normalize_url(input.startUrl, web_denied_hosts(this.env));
			if (!normalized.ok) {
				log_browser({ route: "open", refused: "address_blocked", reason: normalized.reason });
				return operation_refused("address_blocked", "The browser cannot open this address.");
			}
			startUrl = normalized.url;
		}

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

		if (input.mode === "web") return await this.open_web(input, startUrl);

		if (!this.env.BROWSER_PREVIEW_URL) {
			return json_response(
				{ ok: false, error: { code: "misconfigured", message: "Preview runtime is not configured." } },
				503,
			);
		}

		const sessionId = crypto.randomUUID();
		const record: SessionRecord = {
			mode: "file",
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

	/**
	 * Open a web session. Acquire first, save the record as `starting`, connect the host,
	 * open the start address, then mark the session ready.
	 */
	private async open_web(input: Extract<SessionOpenInput, { mode: "web" }>, startUrl: string | null): Promise<Response> {
		let acquired: { providerSessionId: string; pageTargetId: string };
		const acquiredAt = Date.now();
		try {
			acquired = await acquire_web_browser(this.env.BROWSER);
		} catch (error) {
			// The helper already closed a browser it acquired. The host releases the admission grant.
			const failure = sanitize_error(error);
			log_browser({ route: "open", refused: "bootstrap_failed", attemptId: input.attemptId });
			return json_response({ ok: false, error: { code: "bootstrap_failed", message: failure.message } }, 200);
		}

		const sessionId = crypto.randomUUID();
		const now = Date.now();
		const record: SessionRecord = {
			mode: "web",
			version: 1,
			sessionId,
			grantId: input.grantId,
			ownerId: input.ownerId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			navGen: input.navGen,
			loadGen: 1,
			controlGen: 1,
			control: "starting",
			providerSessionId: acquired.providerSessionId,
			// Web pages have no controller document. A random nonce keeps the lease shape.
			pageNonce: crypto.randomUUID(),
			viewport: input.viewport,
			command: null,
			commandCount: 0,
			createdAt: now,
			providerAcquiredAt: acquiredAt,
			lastActiveAt: now,
			attemptId: input.attemptId,
			closeAttempts: 0,
			inputHolder: null,
			viewers: {},
			viewerGrants: {},
			agentAccess: input.agentAccess,
			pageTargetId: acquired.pageTargetId,
			profileId: input.profileId,
			agentBlockedHosts: input.agentBlockedHosts,
		};
		await this.save(record);
		// Without a key the session still works. It just starts empty and saves nothing.
		this.profile = await profile_crypto_key(this.env.BROWSER_PROFILE_KEY, input.profileKey).then(
			(key) => ({ sessionId, profileId: input.profileId, key, dirty: false, savedAt: Date.now() }),
			(error: unknown) => {
				log_browser({ route: "profile_key", sessionId, error: sanitize_error(error).name });
				return null;
			},
		);

		try {
			await with_wall_timeout(this.connect_host(record), 15_000);
			const host = this.hostConnection;
			if (!host || host.sessionId !== sessionId) throw new Error("Browser session changed.");
			// Size the page before the first load. Some sites pick a mobile or desktop layout from
			// the first width and keep it.
			await host.page.setViewportSize(record.viewport);
			// Restore the saved logins before the first page loads, so the start page is logged in.
			await this.restore_profile(record, host);
			// A slow or failing site does not fail the open. The user sees Chrome's error page.
			if (startUrl !== null) {
				await with_wall_timeout(host.cdp.send("Page.navigate", { url: startUrl }), LIMITS.openNavWallMs).catch(() => {});
			}
			const current = await this.load();
			if (!current || current.sessionId !== sessionId || current.control !== "starting") {
				throw new Error("Browser session changed.");
			}
			current.control = "ready";
			current.lastActiveAt = Date.now();
			await this.save(current);
			log_browser({ route: "open", sessionId, mode: "web", startUrl: startUrl !== null });
			return json_response({ ok: true, session: this.public_meta(current) }, 200);
		} catch (error) {
			const failure = sanitize_error(error);
			const current = await this.load();
			if (current?.sessionId === sessionId && current.control !== "closing") await this.close_record(current, "open_failed");
			log_browser({ route: "open", refused: "bootstrap_failed", attemptId: input.attemptId });
			return json_response({ ok: false, error: { code: "bootstrap_failed", message: failure.message } }, 200);
		}
	}

	/**
	 * `closeOnFailure: false` is for the profile save inside `close_record`: a failed connect there
	 * must not start a second close.
	 */
	private async connect_host(record: SessionRecord, options = { closeOnFailure: true }): Promise<void> {
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
				const candidates = contexts[0]?.pages() ?? [];
				if (contexts.length !== 1 || (record.mode === "file" && candidates.length !== 1)) {
					throw new Error("Unexpected browser targets.");
				}
				// File mode has exactly one page. Web mode picks the page target chosen at open;
				// the target check below closes any other page.
				let picked: { page: Page; cdp: CDPSession; targetId: string; browserContextId: string | undefined } | null = null;
				for (const candidate of candidates) {
					const candidateCdp = await candidate.context().newCDPSession(candidate);
					const info: unknown = await candidateCdp.send("Target.getTargetInfo");
					if (!is_record(info) || !is_record(info.targetInfo) || !is_non_empty_string(info.targetInfo.targetId) ||
						(info.targetInfo.browserContextId !== undefined && typeof info.targetInfo.browserContextId !== "string")) {
						throw new Error("Browser target is unavailable.");
					}
					if (record.mode === "file" || info.targetInfo.targetId === record.pageTargetId) {
						picked = {
							page: candidate,
							cdp: candidateCdp,
							targetId: info.targetInfo.targetId,
							browserContextId: info.targetInfo.browserContextId,
						};
						break;
					}
					await candidateCdp.detach().catch(() => {});
				}
				if (!picked) throw new Error("Unexpected browser targets.");
				const { page, cdp } = picked;
				phase = "browser_attach";
				const browserCdp = await browser.newBrowserCDPSession();
				phase = "contexts";
				const inventory: unknown = await browserCdp.send("Target.getBrowserContexts");
				if (!is_record(inventory) || !Array.isArray(inventory.browserContextIds) ||
					inventory.browserContextIds.some((id) => typeof id !== "string")) throw new Error("Browser contexts are unavailable.");
				// getBrowserContexts lists explicit contexts; omit the default context id.
				const contextId = inventory.browserContextIds.includes(picked.browserContextId ?? "") ? picked.browserContextId : undefined;
				phase = "downloads";
				// Chrome never saves a file. Web mode turns events on: downloads that skip the network
				// still report `Browser.downloadWillBegin`, and the safety net below reads them.
				await browserCdp.send("Browser.setDownloadBehavior", {
					behavior: "deny", eventsEnabled: record.mode === "web",
					...(contextId ? { browserContextId: contextId } : {}),
				});
				const latest = await this.load();
				if (!latest || latest.sessionId !== record.sessionId || latest.control === "closing" || latest.control === "closed") {
					throw new Error("Browser session changed.");
				}
				const host = {
					sessionId: record.sessionId,
					browser,
					page,
					cdp,
					browserCdp,
					targetId: picked.targetId,
					contextId,
					loading: false,
					mainNavCount: 0,
				};
				this.hostConnection = host;
				// Page timers can outlive a command, so target checks stay on this connection.
				// Web pages navigate freely, so only file mode closes on a main-frame navigation.
				if (record.mode === "file") {
					page.on("framenavigated", (frame) => {
						if (this.hostConnection !== host || frame !== page.mainFrame()) return;
						const command = this.viewerRecord?.command;
						if (command && command.connection === undefined && frame.url() === CONTROLLER_URL) return;
						this.agentConnection?.bridge?.revoke();
						this.state.waitUntil(this.load().then(async (current) => {
							if (current?.sessionId === host.sessionId) await this.close_record(current, "page_navigated");
						}));
					});
				}
				page.context().on("page", (popup) => {
					if (this.hostConnection !== host || popup === page) return;
					if (record.mode === "web") {
						this.state.waitUntil(this.handle_web_popup(host, popup));
						return;
					}
					this.state.waitUntil(popup.close().catch(async () => {
						if (popup.isClosed()) return;
						const current = await this.load();
						if (current?.sessionId === host.sessionId) await this.close_record(current, "popup_cleanup_failed");
					}));
				});
				if (record.mode === "web") {
					// Cross-document navigations only: `Page.navigatedWithinDocument` is ignored.
					// Navigation does not touch idle: only people and agent commands keep a session open.
					cdp.on("Page.frameNavigated", (event: unknown) => {
						if (this.hostConnection !== host || !is_record(event) || !is_record(event.frame)) return;
						if (event.frame.parentId !== undefined) return;
						// A file chooser belongs to the page that opened it.
						host.mainNavCount += 1;
						if (this.chooser?.host === host) this.close_file_chooser();
						this.push_location(host);
					});
					cdp.on("Page.frameStartedLoading", (event: unknown) => {
						if (this.hostConnection !== host || !is_record(event) || event.frameId !== host.targetId) return;
						host.loading = true;
						this.push_location(host);
					});
					cdp.on("Page.frameStoppedLoading", (event: unknown) => {
						if (this.hostConnection !== host || !is_record(event) || event.frameId !== host.targetId) return;
						host.loading = false;
						this.push_location(host);
					});
					// Playwright's `filechooser` event covers a chooser with an input element. Without one
					// (for example a picker with no input) there is nothing to fill.
					cdp.on("Page.fileChooserOpened", (event: unknown) => {
						if (this.hostConnection !== host || !is_record(event) || event.backendNodeId !== undefined) return;
						if (!this.viewerRecord?.command) this.push_viewers({ t: "notice", code: "upload_unsupported" });
					});
					page.on("filechooser", (chooser: FileChooser) => {
						if (this.hostConnection !== host) return;
						this.state.waitUntil(this.open_file_chooser(host, chooser).catch((error: unknown) => {
							log_browser({ route: "file_chooser", sessionId: host.sessionId, error: sanitize_error(error).name });
						}));
					});
					// `Fetch` pauses every page load at the response stage to catch downloads. Agent
					// commands add request-stage pauses so requests to the user's blocked sites fail.
					cdp.on("Fetch.requestPaused", (event: unknown) => {
						if (!is_record(event) || !is_non_empty_string(event.requestId)) return;
						this.state.waitUntil(this.answer_fetch_pause(host, record.agentBlockedHosts, event, event.requestId));
					});
					browserCdp.on("Browser.downloadWillBegin", (event: unknown) => {
						if (this.hostConnection !== host || !is_record(event)) return;
						const running: Promise<void> = this.capture_safety_net_download(host, event).catch((error: unknown) => {
							log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
						}).finally(() => this.safetyNetDownloads.delete(running));
						this.safetyNetDownloads.add(running);
						this.state.waitUntil(running);
					});
					phase = "page_events";
					await cdp.send("Page.enable");
					await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
					await set_fetch_patterns(cdp, false);
				}
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
				if (record.mode === "web") {
					// A popup can open while no host is connected. Keep the assigned page, close the rest.
					if (!pages.some((target) => is_record(target) && target.targetId === host.targetId)) {
						throw new Error("Unexpected browser targets.");
					}
					for (const target of pages) {
						if (!is_record(target) || !is_non_empty_string(target.targetId) || target.targetId === host.targetId) continue;
						const closed: unknown = await browserCdp.send("Target.closeTarget", { targetId: target.targetId });
						if (!is_record(closed) || closed.success !== true) throw new Error("Unexpected browser targets.");
					}
					if (pages.length > 1) log_browser({ route: "host_connect", closedPages: pages.length - 1 });
				} else {
					if (pages.length !== 1 || !is_record(pages[0]) || pages[0].targetId !== host.targetId) {
						throw new Error("Unexpected browser targets.");
					}
					phase = "page_check";
					const document: unknown = await page.evaluate("({url: location.href, nonce: window.__browserNonce})");
					if (!is_record(document) || document.url !== CONTROLLER_URL || document.nonce !== record.pageNonce) {
						throw new Error("Browser page changed.");
					}
				}
				const checked = await this.load();
				if (this.hostConnection !== host || checked?.sessionId !== record.sessionId ||
					checked.control === "closing" || checked.control === "closed") throw new Error("Browser session changed.");
			} catch (error) {
				log_browser({ route: "host_connect", phase, error: sanitize_error(error).name });
				if (this.hostConnection?.sessionId === record.sessionId) this.hostConnection = null;
				const current = await this.load();
				if (options.closeOnFailure && current?.sessionId === record.sessionId) await this.close_record(current, "host_setup_failed");
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

	/**
	 * Send one JSON message to every attached viewer.
	 */
	private push_viewers(message: Record<string, unknown>): void {
		const text = JSON.stringify(message);
		for (const stream of this.viewerStreams.values()) {
			try {
				stream.socket.send(text);
			} catch {
				this.end_viewer(stream, 1011, "socket error");
			}
		}
	}

	/**
	 * Web mode: send the current address, title, and history state to the viewers.
	 */
	private push_location(host: HostConnection): void {
		if (this.viewerStreams.size === 0) return;
		// Reads can finish out of order. Only the newest read may send.
		const seq = ++this.locationSeq;
		this.state.waitUntil((async () => {
			const history: unknown = await host.cdp.send("Page.getNavigationHistory");
			if (seq !== this.locationSeq || this.hostConnection !== host || !is_record(history) || !Array.isArray(history.entries) ||
				typeof history.currentIndex !== "number") return;
			const index = history.currentIndex;
			const entry: unknown = history.entries[index];
			if (!is_record(entry)) return;
			this.push_viewers({
				t: "location",
				url: typeof entry.url === "string" ? entry.url.slice(0, browser_web_URL_MAX_CHARS) : "",
				title: typeof entry.title === "string" ? entry.title.slice(0, LIMITS.titleChars) : "",
				loading: host.loading,
				canGoBack: index > 0,
				canGoForward: index < history.entries.length - 1,
			});
		})().catch(() => {}));
	}

	/**
	 * Web mode: the viewer shows one tab. Close each popup. When no agent command runs, open the
	 * popup's address in the main page instead, if the address rules allow it.
	 */
	private async handle_web_popup(host: HostConnection, popup: Page): Promise<void> {
		const close = () => popup.close().catch(async () => {
			if (popup.isClosed()) return;
			const current = await this.load();
			if (current?.sessionId === host.sessionId) await this.close_record(current, "popup_cleanup_failed");
		});

		// An agent command owns the page. Do not follow its popups.
		if (this.viewerRecord?.command) {
			await close();
			this.push_viewers({ t: "notice", code: "popup_closed" });
			return;
		}

		// `window.open` first shows about:blank. Wait a little for the real address.
		const blank = (url: string) => url === "" || url === "about:blank";
		if (blank(popup.url())) {
			await popup.waitForURL((next) => !blank(next.href), { waitUntil: "commit", timeout: LIMITS.popupUrlWaitMs }).catch(() => {});
		}
		const url = popup.isClosed() ? "" : popup.url();
		await close();
		if (this.hostConnection !== host) return;
		if (blank(url) || this.viewerRecord?.command) {
			this.push_viewers({ t: "notice", code: "popup_closed" });
			return;
		}
		const normalized = browser_web_normalize_url(url, web_denied_hosts(this.env));
		if (!normalized.ok) {
			log_browser({ route: "popup", refused: normalized.reason });
			this.push_viewers({ t: "notice", code: "address_blocked" });
			return;
		}
		await with_wall_timeout(host.cdp.send("Page.navigate", { url: normalized.url }), LIMITS.navWallMs).catch(() => {});
		this.push_viewers({ t: "notice", code: "popup_opened_here" });
	}

	/**
	 * Web mode: answer one paused request. A response-stage pause is a page load that may be a
	 * download. A request-stage pause comes from the agent's blocked-site filter. Every pause gets
	 * exactly one answer, even when a step throws, or the page hangs.
	 */
	private async answer_fetch_pause(host: HostConnection, blockedHosts: string[], event: Record<string, unknown>, requestId: string) {
		const pause: { answer: "continue" | "abort" | "block" } = { answer: "continue" };
		try {
			if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
				const url = is_record(event.request) && typeof event.request.url === "string" ? event.request.url : "";
				if (browser_web_url_host_matches(url, blockedHosts)) pause.answer = "block";
				return;
			}
			await this.capture_response_download(host, event, requestId, pause);
		} catch (error) {
			log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
		} finally {
			// After the body was taken, only `failRequest` works (checked live on 2026-09-23). Failing a
			// navigation keeps the current page.
			await (pause.answer === "continue"
				? host.cdp.send("Fetch.continueRequest", { requestId })
				: host.cdp.send("Fetch.failRequest", { requestId, errorReason: pause.answer === "block" ? "BlockedByClient" : "Aborted" })
			).catch(() => {});
		}
	}

	/**
	 * Web mode: read a paused page response when Chrome would save it. Set `pause.answer` to abort
	 * as soon as it is a download, so a later failure still stops Chrome's own download.
	 */
	private async capture_response_download(host: HostConnection, event: Record<string, unknown>, requestId: string, pause: { answer: string }) {
		const status = event.responseStatusCode;
		const request = is_record(event.request) ? event.request : {};
		if (event.responseErrorReason !== undefined || typeof status !== "number" || (status >= 300 && status < 400) ||
			status === 204 || status === 205 || request.method === "HEAD") return;
		const disposition = cdp_header(event.responseHeaders, "content-disposition");
		const contentType = cdp_header(event.responseHeaders, "content-type");
		if (!is_download_response(disposition, contentType)) return;
		pause.answer = "abort";

		const url = typeof request.url === "string" ? request.url : "";
		const lengthHeader = cdp_header(event.responseHeaders, "content-length")?.trim() ?? "";
		const length = /^\d+$/u.test(lengthHeader) && Number.isSafeInteger(Number(lengthHeader)) ? Number(lengthHeader) : null;
		// The stream gives the decoded body. A compressed body's length cannot be compared with it.
		const encoding = (cdp_header(event.responseHeaders, "content-encoding") ?? "").trim().toLowerCase();
		const exactLength = encoding === "" || encoding === "identity" ? length : null;
		await this.capture_download(host, {
			owner: this.download_owner(host.sessionId, event.frameId === host.targetId),
			name: download_name(disposition, url),
			origin: download_origin(url),
			sizeHint: length,
			read: async (maxBytes, signal) => {
				const { stream } = await with_wall_timeout(host.cdp.send("Fetch.takeResponseBodyAsStream", { requestId }), 10_000);
				try {
					const read = await read_cdp_stream(host.cdp, stream, maxBytes, signal);
					if (read.over) return read;
					// A stream that ends early (the server dropped the connection) still ends with `eof`.
					// Fewer bytes than the header promised is a broken file, not a small one.
					if (exactLength !== null && read.bytes.byteLength !== exactLength) throw new Error("Download did not finish.");
					return { ...read, contentType: mime_essence(contentType) || "application/octet-stream" };
				} finally {
					await host.cdp.send("IO.close", { handle: stream }).catch(() => {});
				}
			},
		});
	}

	/**
	 * Web mode safety net: Chrome denied a download that never passed the response pause. Read a
	 * `data:` URL directly. Read a same-origin `http(s)` file again from the page, with its cookies.
	 * `blob:` downloads send no event at all (checked live on 2026-09-23).
	 */
	private async capture_safety_net_download(host: HostConnection, event: Record<string, unknown>) {
		const url = typeof event.url === "string" ? event.url : "";
		const frameId = typeof event.frameId === "string" ? event.frameId : "";
		const name = cap_download_name(typeof event.suggestedFilename === "string" ? event.suggestedFilename : "");
		// Decide the owner before any await: the agent command may finish while the frame is checked.
		const owner = this.download_owner(host.sessionId, frameId === host.targetId);
		if (/^data:/iu.test(url)) {
			await this.capture_download(host, {
				owner, name, origin: null, sizeHint: null,
				read: async (maxBytes) => {
					// The URL holds the whole file. A URL longer than the cap is too large before decoding.
					if (url.length > maxBytes) return { over: true };
					const decoded = decode_data_url(url);
					if (!decoded) throw new Error("The data URL is damaged.");
					return { over: false, ...decoded };
				},
			});
			return;
		}

		let sameOrigin = false;
		if (/^https?:/iu.test(url)) {
			const tree: unknown = await with_wall_timeout(host.cdp.send("Page.getFrameTree"), 5000).catch(() => null);
			if (tree === null) {
				this.refuse_download(host.sessionId, owner, "download_failed");
				return;
			}
			const find = (node: unknown): string | null => {
				if (!is_record(node) || !is_record(node.frame)) return null;
				if (node.frame.id === frameId) return typeof node.frame.url === "string" ? node.frame.url : null;
				for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
					const found = find(child);
					if (found !== null) return found;
				}
				return null;
			};
			const frameUrl = is_record(tree) ? find(tree.frameTree) : null;
			sameOrigin = frameUrl !== null && download_origin(frameUrl) !== null && download_origin(frameUrl) === download_origin(url);
		}
		if (!sameOrigin) {
			this.refuse_download(host.sessionId, owner, "download_unsupported");
			return;
		}
		await this.capture_download(host, {
			owner, name, origin: download_origin(url), sizeHint: null,
			read: (maxBytes, signal) => this.read_in_page(host, frameId, url, maxBytes, signal),
		});
	}

	/**
	 * Fetch a same-origin file again in an isolated world of its frame, with the page's cookies.
	 * The bytes stay in that world and come back in 1 MiB base64 chunks, so no CDP message is huge.
	 */
	private async read_in_page(host: HostConnection, frameId: string, url: string, maxBytes: number, signal: AbortSignal): Promise<DownloadRead> {
		const cdp = host.cdp;
		const world = await with_wall_timeout(cdp.send("Page.createIsolatedWorld", { frameId, worldName: "bonobo-download", grantUniveralAccess: false }), 5000);
		const fetched = await with_wall_timeout(cdp.send("Runtime.evaluate", {
			contextId: world.executionContextId,
			awaitPromise: true,
			expression: `(async () => {
				const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
				if (!response.ok || !response.body) throw new Error("Download failed.");
				const reader = response.body.getReader();
				const chunks = [];
				let size = 0;
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					size += next.value.byteLength;
					if (size > ${maxBytes}) {
						await reader.cancel();
						return { over: true, size: 0, type: "", bytes: null };
					}
					chunks.push(next.value);
				}
				const bytes = new Uint8Array(size);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return { over: false, size, type: response.headers.get("content-type") || "", bytes };
			})()`,
		}), LIMITS.downloadCaptureMs);
		const objectId = fetched.result.objectId;
		if (fetched.exceptionDetails || !objectId) throw new Error("Download failed.");
		try {
			const summary = await with_wall_timeout(cdp.send("Runtime.callFunctionOn", {
				objectId, returnByValue: true, functionDeclaration: "function () { return { over: this.over, size: this.size, type: this.type }; }",
			}), 5000);
			const value: unknown = summary.result.value;
			if (!is_record(value) || typeof value.over !== "boolean" || typeof value.size !== "number" || typeof value.type !== "string") {
				throw new Error("Download failed.");
			}
			if (value.over || value.size > maxBytes) return { over: true };
			const chunks: Uint8Array[] = [];
			for (let offset = 0; offset < value.size; offset += LIMITS.downloadChunkBytes) {
				signal.throwIfAborted();
				const part = await with_wall_timeout(cdp.send("Runtime.callFunctionOn", {
					objectId, returnByValue: true, arguments: [{ value: offset }, { value: LIMITS.downloadChunkBytes }],
					functionDeclaration: "function (offset, length) { const part = this.bytes.subarray(offset, offset + length); let text = \"\"; " +
						"for (let i = 0; i < part.length; i += 8192) text += String.fromCharCode.apply(null, part.subarray(i, i + 8192)); return btoa(text); }",
				}), 10_000);
				const bytes = typeof part.result.value === "string" ? base64_bytes(part.result.value) : null;
				if (!bytes) throw new Error("Download failed.");
				chunks.push(bytes);
			}
			const bytes = append_bytes(chunks, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
			if (bytes.byteLength !== value.size) throw new Error("Download failed.");
			return { over: false, bytes, contentType: mime_essence(value.type) || "application/octet-stream" };
		} finally {
			await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
		}
	}

	/**
	 * The live session's download state. A new session starts with a new one.
	 */
	private session_downloads(sessionId: string) {
		if (this.downloads?.sessionId !== sessionId) {
			this.downloads = { sessionId, count: 0, bytes: 0, starts: [], capture: null, held: null, pushed: new Set(), agent: null };
		}
		return this.downloads;
	}

	/**
	 * Who a new download belongs to, or null when nobody asked for it. Call it as soon as the
	 * download shows up, before any await. An agent command owns every download during its run. A
	 * human download needs human control, the main frame, and a click or Enter in the last 10
	 * seconds. Each gesture allows one download.
	 */
	private download_owner(sessionId: string, mainFrame: boolean): DownloadOwner | null {
		const record = this.viewerRecord;
		if (record?.sessionId !== sessionId) return null;
		// A reload holds the command slot too, but with no agent connection.
		if (record.command && record.command.connection !== undefined) {
			// Make the command's list now. `run/finish` sends it, so a capture that ends near the
			// command end still has a place to land, or to be counted as dropped.
			const downloads = this.session_downloads(sessionId);
			if (downloads.agent?.commandId !== record.command.id) downloads.agent = { commandId: record.command.id, items: [], bytes: 0, dropped: 0 };
			return { kind: "agent", commandId: record.command.id };
		}
		const gesture = this.humanGesture;
		if (record.control !== "human" || record.command || !mainFrame || gesture?.sessionId !== sessionId ||
			Date.now() - gesture.at > LIMITS.downloadGestureMs) return null;
		this.humanGesture = null;
		return { kind: "human" };
	}

	/**
	 * Tell the viewers that a download was not kept. An agent download also counts as dropped in
	 * its command's result, so the agent learns about it even when no viewer is attached.
	 */
	private refuse_download(sessionId: string, owner: DownloadOwner | null, code: string) {
		log_browser({ route: "download", sessionId, refused: code });
		this.push_viewers({ t: "notice", code });
		const agent = this.downloads?.sessionId === sessionId ? this.downloads.agent : null;
		if (owner?.kind === "agent" && agent?.commandId === owner.commandId) agent.dropped += 1;
	}

	/**
	 * Check the limits, read the file, then keep it. A human download waits in memory for Convex;
	 * an agent download joins its command's result. Every refusal and failure tells the viewers.
	 */
	private async capture_download(host: HostConnection, input: {
		owner: DownloadOwner | null;
		name: string;
		origin: string | null;
		sizeHint: number | null;
		read: (maxBytes: number, signal: AbortSignal) => Promise<DownloadRead>;
	}) {
		const owner = input.owner;
		if (!owner) {
			this.refuse_download(host.sessionId, null, "download_blocked");
			return;
		}
		const downloads = this.session_downloads(host.sessionId);
		const now = Date.now();
		downloads.starts = downloads.starts.filter((at) => now - at < LIMITS.downloadStartWindowMs);
		const fileCap = owner.kind === "human" ? LIMITS.downloadHumanBytes : LIMITS.downloadAgentBytes;
		// No await between these checks and `capture`, so two pauses cannot both pass.
		const refusal =
			owner.kind === "human" && downloads.held ? "download_busy" :
				downloads.capture || downloads.starts.length >= LIMITS.downloadStarts || downloads.count >= LIMITS.downloadSessionFiles ||
					downloads.bytes >= LIMITS.downloadSessionBytes ? "download_limit" :
					input.sizeHint !== null && input.sizeHint > fileCap ? "download_too_large" : null;
		if (refusal) {
			this.refuse_download(host.sessionId, owner, refusal);
			return;
		}
		downloads.starts.push(now);
		// The timeout below does not stop the read by itself. `stop` ends it at its next chunk.
		const stop = new AbortController();
		const reading = input.read(fileCap, stop.signal);
		const capture = (async () => {
			const read = await with_wall_timeout(reading, LIMITS.downloadCaptureMs);
			if (this.downloads !== downloads) {
				log_browser({ route: "download", sessionId: host.sessionId, refused: "session_changed" });
				return;
			}
			if (read.over) {
				this.refuse_download(host.sessionId, owner, "download_too_large");
				return;
			}
			if (downloads.bytes + read.bytes.byteLength > LIMITS.downloadSessionBytes) {
				this.refuse_download(host.sessionId, owner, "download_limit");
				return;
			}
			downloads.count += 1;
			downloads.bytes += read.bytes.byteLength;
			const file = { name: input.name, contentType: read.contentType, bytes: read.bytes };
			if (owner.kind === "agent") {
				const agent = downloads.agent?.commandId === owner.commandId ? downloads.agent : null;
				// The command already sent its result, so nothing can carry the file now.
				if (!agent) {
					log_browser({ route: "download", sessionId: host.sessionId, refused: "command_finished" });
					return;
				}
				// Agent output shares one limit per command: 8 files and 8 MiB.
				if (agent.items.length >= LIMITS.files || agent.bytes + file.bytes.byteLength > LIMITS.fileBytes) {
					this.refuse_download(host.sessionId, owner, "download_limit");
					return;
				}
				agent.items.push(file);
				agent.bytes += file.bytes.byteLength;
				log_browser({ route: "download", sessionId: host.sessionId, owner: "agent", bytes: file.bytes.byteLength });
				return;
			}
			const downloadId = crypto.randomUUID();
			const held: HeldDownload = {
				downloadId, ...file, size: file.bytes.byteLength, origin: input.origin, expiresAt: Date.now() + LIMITS.downloadKeepMs,
				timer: setTimeout(() => this.drop_held_download(held), LIMITS.downloadKeepMs), pushing: null,
			};
			downloads.held = held;
			log_browser({ route: "download", sessionId: host.sessionId, owner: "human", bytes: held.size });
			this.push_viewers({ t: "download", downloadId, name: held.name, size: held.size, contentType: held.contentType });
		})();
		const outcome = capture.catch((error: unknown) => {
			// A read error, a cut-off body, or the 30-second timeout. The user clicked, so say it failed.
			stop.abort();
			log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
			if (this.downloads === downloads) this.refuse_download(host.sessionId, owner, "download_failed");
		});
		// Keep the one-capture slot until the read really ended, so two reads never fill memory at once.
		const slot: Promise<void> = Promise.all([outcome, reading.catch(() => {})]).then(() => {
			if (downloads.capture === slot) downloads.capture = null;
		});
		downloads.capture = slot;
		// The paused page gets its answer as soon as the capture is decided, not when the read ends.
		await outcome;
	}

	/**
	 * Drop the held human download and tell the viewers it was not saved. A running push decides
	 * first: when it saves the file, the file is not lost.
	 */
	private drop_held_download(held: HeldDownload) {
		if (this.downloads?.held !== held) return;
		if (held.pushing) {
			this.state.waitUntil(held.pushing.then(() => this.drop_held_download(held)));
			return;
		}
		this.downloads.held = null;
		clearTimeout(held.timer);
		log_browser({ route: "download", sessionId: this.downloads.sessionId, dropped: "download_lost" });
		this.push_viewers({ t: "notice", code: "download_lost" });
	}

	/**
	 * The held human download with this id, if it is still waiting to be saved.
	 */
	private held_download(sessionId: string, downloadId: string) {
		const held = this.downloads?.sessionId === sessionId && this.downloads.held?.downloadId === downloadId ? this.downloads.held : null;
		if (held && held.expiresAt <= Date.now()) {
			this.drop_held_download(held);
			return null;
		}
		return held;
	}

	private download_info(sessionId: string, downloadId: string): Response {
		const held = this.held_download(sessionId, downloadId);
		if (!held) return operation_refused("download_gone", "The download is gone.");
		return json_response({ ok: true, name: held.name, size: held.size, contentType: held.contentType, origin: held.origin }, 200);
	}

	/**
	 * Upload the held download to the signed R2 URL from Convex, then free its bytes. A second push
	 * of the same id answers ok. `If-None-Match: *` makes R2 refuse to replace an object, so a 412
	 * means an earlier push already stored it. A failed push keeps the bytes for a retry.
	 */
	private async download_push(input: { sessionId: string; downloadId: string; url: string; headers: Record<string, string> }): Promise<Response> {
		const downloads = this.downloads;
		if (downloads?.sessionId === input.sessionId && downloads.pushed.has(input.downloadId)) return json_response({ ok: true }, 200);
		const held = this.held_download(input.sessionId, input.downloadId);
		if (!downloads || !held) return operation_refused("download_gone", "The download is gone.");
		held.pushing ??= (async () => {
			const headers = new Headers(input.headers);
			headers.set("If-None-Match", "*");
			const response = await with_wall_timeout(fetch(input.url, { method: "PUT", headers, body: held.bytes }), 60_000);
			await response.body?.cancel().catch(() => {});
			return response.ok || response.status === 412;
		})().catch(() => false).then((pushed) => {
			// Free the file before anyone else sees the push end, so the 2-minute expiry that waits
			// for this push finds nothing to drop.
			held.pushing = null;
			if (!pushed) return false;
			if (downloads.held === held) {
				downloads.held = null;
				clearTimeout(held.timer);
			}
			downloads.pushed.add(held.downloadId);
			return true;
		});
		const pushed = await held.pushing;
		if (!pushed) {
			log_browser({ route: "download_push", sessionId: input.sessionId, refused: "download_push_failed" });
			return operation_refused("download_push_failed", "The download could not be saved.");
		}
		log_browser({ route: "download_push", sessionId: input.sessionId, bytes: held.size });
		return json_response({ ok: true }, 200);
	}

	/**
	 * Web mode: a page opened a file chooser. Only a human in control gets the app dialog. During
	 * agent commands the snippet handles its own choosers. A new chooser replaces the old one.
	 */
	private async open_file_chooser(host: HostConnection, chooser: FileChooser) {
		const before = this.viewerRecord;
		if (before?.sessionId !== host.sessionId || before.control !== "human" || before.command) return;
		const [accept, origin] = await Promise.all([
			with_wall_timeout(chooser.element().getAttribute("accept"), 5000),
			chooser_origin(chooser),
		]);
		// The reads above waited for the page. Check that the same human still holds control.
		const record = this.viewerRecord;
		if (origin === null || this.hostConnection !== host || record?.sessionId !== host.sessionId || record.control !== "human" || record.command ||
			record.controlGen !== before.controlGen) return;
		this.close_file_chooser();
		const chooserId = crypto.randomUUID();
		const open: OpenFileChooser = {
			sessionId: host.sessionId, chooserId, host, chooser, multiple: chooser.isMultiple(),
			accept: (accept ?? "").slice(0, LIMITS.chooserAcceptChars), origin, mainNavCount: host.mainNavCount,
			controlGen: record.controlGen, openedAt: Date.now(),
			timer: setTimeout(() => this.close_file_chooser(open), LIMITS.chooserMs), busy: false,
		};
		this.chooser = open;
		log_browser({ route: "file_chooser", sessionId: host.sessionId, multiple: open.multiple });
		this.push_viewers({ t: "file-chooser", chooserId, multiple: open.multiple, accept: open.accept, origin });
	}

	/**
	 * Forget the open chooser, its upload grants, and tell the viewers it is gone.
	 */
	private close_file_chooser(chooser = this.chooser) {
		if (!chooser || this.chooser !== chooser) return;
		this.chooser = null;
		clearTimeout(chooser.timer);
		for (const [grantId, grant] of this.uploadGrants) {
			if (grant.chooserId === chooser.chooserId) this.uploadGrants.delete(grantId);
		}
		this.push_viewers({ t: "file-chooser-closed", chooserId: chooser.chooserId });
	}

	/**
	 * The open chooser, when it is still current for this caller. A chooser that is no longer
	 * current closes here.
	 */
	private async current_file_chooser(input: { sessionId: string; chooserId: string; controlGen: number }):
		Promise<{ ok: true; chooser: OpenFileChooser } | { ok: false; code: string }> {
		const record = await this.load();
		if (!record || record.sessionId !== input.sessionId || record.control === "closing" || record.control === "closed") {
			return { ok: false, code: "chooser_gone" };
		}
		if (record.control !== "human" || record.command) return { ok: false, code: "not_human" };
		const chooser = this.chooser;
		if (!chooser || chooser.sessionId !== input.sessionId || chooser.chooserId !== input.chooserId) return { ok: false, code: "chooser_gone" };
		if (this.hostConnection !== chooser.host || chooser.host.mainNavCount !== chooser.mainNavCount ||
			record.controlGen !== chooser.controlGen || Date.now() - chooser.openedAt >= LIMITS.chooserMs) {
			this.close_file_chooser(chooser);
			return { ok: false, code: "chooser_gone" };
		}
		if (input.controlGen !== chooser.controlGen) return { ok: false, code: "chooser_gone" };
		return { ok: true, chooser };
	}

	/**
	 * Give files to the open chooser once. `read_files` fetches the bytes while the chooser is held,
	 * so a second fill cannot start meanwhile. After the reads, check the frame origin and then the
	 * chooser again: the page may have moved while the bytes were on the way.
	 */
	private async fill_file_chooser(
		input: { sessionId: string; chooserId: string; controlGen: number },
		read_files: (chooser: OpenFileChooser) => Promise<{ ok: true; files: ChooserFile[] } | { ok: false; code: string }>,
	): Promise<{ ok: true } | { ok: false; code: string }> {
		const claimed = await this.current_file_chooser(input);
		if (!claimed.ok) return claimed;
		const chooser = claimed.chooser;
		if (chooser.busy) return { ok: false, code: "chooser_gone" };
		chooser.busy = true;
		try {
			const read = await read_files(chooser);
			if (!read.ok) return read;
			const origin = await chooser_origin(chooser.chooser).catch(() => null);
			if (origin !== chooser.origin) {
				this.close_file_chooser(chooser);
				return { ok: false, code: "chooser_gone" };
			}
			// Check the chooser last. The origin read above can take seconds, and a control change or a
			// navigation during it closes the chooser. Only a storage read runs between this check and
			// `setFiles`, and the object holds other events during storage reads.
			const again = await this.current_file_chooser(input);
			if (!again.ok) return again;
			// One fill per chooser: it is gone after this call, even when the page refuses the files.
			this.close_file_chooser(chooser);
			const filled = await with_wall_timeout(chooser.chooser.setFiles(read.files), LIMITS.uploadSetFilesMs).then(() => true, () => false);
			log_browser({ route: "file_chooser_fill", sessionId: input.sessionId, files: read.files.length, ok: filled });
			return filled ? { ok: true } : { ok: false, code: "chooser_gone" };
		} finally {
			chooser.busy = false;
		}
	}

	/**
	 * `upload-fill`: fetch the signed Files URLs from Convex and give them to the chooser.
	 */
	private async upload_fill(input: {
		sessionId: string;
		chooserId: string;
		controlGen: number;
		files: Array<{ name: string; contentType: string; url: string }>;
	}): Promise<Response> {
		const filled = await this.fill_file_chooser(input, async (chooser) => {
			if (!chooser.multiple && input.files.length !== 1) return { ok: false, code: "too_many_files" };
			// Read all files at once. The whole fill must end before Convex stops waiting, so the reads
			// get the fill budget minus the time the origin check (5 s) and `setFiles` may take.
			const stop = new AbortController();
			const timer = setTimeout(() => stop.abort(), LIMITS.uploadFillMs - LIMITS.uploadSetFilesMs - 5_000);
			// All files share one 20 MiB cap. Count every chunk, so the reads never hold more than that.
			let total = 0;
			let tooLarge = false;
			const read_file = async (file: { name: string; contentType: string; url: string }): Promise<ChooserFile> => {
				const response = await fetch(file.url, { signal: stop.signal });
				const reader = response.body?.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					if (!response.ok) throw new Error("Fetch failed.");
					// No body means an empty file.
					while (reader) {
						const next = await reader.read();
						stop.signal.throwIfAborted();
						if (next.done) break;
						size += next.value.byteLength;
						total += next.value.byteLength;
						if (total > LIMITS.uploadBytes) {
							tooLarge = true;
							throw new Error("The files are too large.");
						}
						chunks.push(next.value);
					}
				} finally {
					await reader?.cancel().catch(() => {});
				}
				const bytes = append_bytes(chunks, size);
				return { name: file.name, mimeType: file.contentType, buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
			};
			const files = await Promise.all(input.files.map(read_file)).catch(() => {
				// The first failure stops the other reads.
				stop.abort();
				return null;
			}).finally(() => clearTimeout(timer));
			if (!files) return { ok: false, code: tooLarge ? "too_large" : "fetch_failed" };
			return { ok: true, files };
		});
		if (!filled.ok) return operation_refused(filled.code, "The file was not given to the page.");
		return json_response({ ok: true }, 200);
	}

	/**
	 * `upload-grant`: a single-use, 2-minute grant for one computer upload to this chooser.
	 */
	private async upload_grant(input: { sessionId: string; chooserId: string; controlGen: number }): Promise<Response> {
		const current = await this.current_file_chooser(input);
		if (!current.ok) return operation_refused(current.code, "The page no longer asks for a file.");
		const now = Date.now();
		for (const [grantId, grant] of this.uploadGrants) {
			if (grant.expiresAt <= now) this.uploadGrants.delete(grantId);
		}
		// Keep the map small. The oldest grant goes first.
		if (this.uploadGrants.size >= 10) this.uploadGrants.delete(this.uploadGrants.keys().next().value!);
		const grantId = crypto.randomUUID();
		const expiresAt = now + LIMITS.uploadGrantMs;
		this.uploadGrants.set(grantId, { sessionId: input.sessionId, chooserId: input.chooserId, controlGen: input.controlGen, expiresAt });
		return json_response({ ok: true, grantId, expiresAt }, 200);
	}

	/**
	 * `PUT /viewer/upload`: one file from the user's computer. The grant is the secret. It is burned
	 * on the first try, and nothing is stored. Every refusal is JSON with a code, so the app can
	 * show a message.
	 */
	private async viewer_upload(request: Request, url: URL): Promise<Response> {
		const reply = (status: number, code?: string) => json_response(code ? { ok: false, code } : { ok: true }, status);
		const grantId = url.searchParams.get("grantId") ?? "";
		const grant = this.uploadGrants.get(grantId);
		this.uploadGrants.delete(grantId);
		if (!grant || grant.expiresAt <= Date.now()) return reply(403, "grant_invalid");
		const filled = await this.fill_file_chooser(grant, async () => {
			// A slow, aborted, or broken body is a refusal. On a timeout, stop reading the body too.
			const stop = new AbortController();
			const body = await with_wall_timeout(read_bounded_stream(request.body, LIMITS.uploadBytes, stop.signal), 60_000).catch(() => {
				stop.abort();
				return null;
			});
			if (!body) return { ok: false, code: "upload_failed" };
			if (body.truncated) return { ok: false, code: "too_large" };
			return { ok: true, files: [{
				name: url.searchParams.get("name") ?? "",
				mimeType: mime_essence(request.headers.get("Content-Type")) || "application/octet-stream",
				buffer: Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength),
			}] };
		});
		if (!filled.ok) return reply(filled.code === "too_large" ? 413 : filled.code === "upload_failed" ? 400 : 409, filled.code);
		return reply(200);
	}

	/**
	 * Viewer `file-chooser-cancel`: tell the page the user closed its file dialog, like Chrome does
	 * after a real cancel. The page keeps any file it already had.
	 */
	private async cancel_file_chooser(chooserId: string) {
		const record = this.viewerRecord;
		const chooser = this.chooser;
		if (!record || !chooser || chooser.chooserId !== chooserId || chooser.busy) return;
		const current = await this.current_file_chooser({ sessionId: record.sessionId, chooserId, controlGen: chooser.controlGen });
		if (!current.ok) return;
		this.close_file_chooser(chooser);
		await with_wall_timeout(chooser.chooser.element().evaluate((node) => node.dispatchEvent(new Event("cancel", { bubbles: true }))), 5000)
			.catch(() => {});
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
				mode: record.mode, deniedHosts: web_denied_hosts(this.env),
				agentBlockedHosts: record.mode === "web" ? record.agentBlockedHosts : [],
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
			// Access may have been turned off after the command began. Refuse its work, but let it settle.
			if (current.mode === "web" && !current.agentAccess) connection.bridge.revoke();
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
				// Web pages may be on any site. The assigned page target is the whole check.
				if (record?.mode === "web") return true;
				const page: unknown = await host.page.evaluate("({url: location.href, nonce: window.__browserNonce})");
				return is_record(page) && page.url === CONTROLLER_URL && page.nonce === record?.pageNonce;
			})(), 10_000);
			if (!check) throw new Error("Browser target changed.");
			// The command's page work is over. Stop failing requests, then check where the page is.
			// On a blocked site the command result is refused, but the session stays.
			let blockedSite = false;
			if (record.mode === "web" && record.agentBlockedHosts.length > 0) {
				await this.set_agent_site_filter(sessionId, false);
				blockedSite = await this.main_page_blocked(record);
			}
			record = await this.load();
			if (!record || record.sessionId !== sessionId || record.command?.id !== commandId || record.command.connection !== "revoked") {
				return operation_refused("closed", "Browser command changed.");
			}
			record.command.connection = "settled";
			await this.save(record);
			if (this.agentConnection === connection) this.agentConnection = null;
			return json_response({ ok: true, blockedPopups: settled.blockedPopups, ...(blockedSite ? { blockedSite: true } : {}) }, 200);
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
		let record = await this.load();
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

		// The user listed sites their agent may not use. Refuse while the page is on one, and fail
		// requests to them until the command settles. Best effort: the UI says so.
		if (record.mode === "web" && record.agentBlockedHosts.length > 0) {
			const blocked = await this.main_page_blocked(record).catch(() => null);
			if (blocked !== false) {
				log_browser({ route: "run_begin", refused: blocked ? "agent_blocked_site" : "page_check", sessionId: record.sessionId });
				return blocked
					? operation_refused("agent_blocked_site", "The page is on a site the agent may not use.")
					: operation_refused("not_ready", "The browser page could not be checked.");
			}
			if (!(await this.set_agent_site_filter(record.sessionId, true).then(() => true, () => false))) {
				return operation_refused("not_ready", "The browser page could not be checked.");
			}
			// The checks above waited for the provider. Check the lease again before taking the slot.
			const current = await this.load();
			const again = current ? session_can_run(current, input, Date.now()) : { ok: false as const, reason: "closed" };
			if (!current || !again.ok) {
				await this.set_agent_site_filter(record.sessionId, false).catch(() => {});
				return operation_refused(again.ok ? "closed" : again.reason, "The browser command was refused.");
			}
			record = current;
		}

		record.command = { id: input.commandId, startedAt: now, connection: "available" };
		record.control = "agent";
		record.lastActiveAt = now;
		await this.save(record);
		return json_response(
			{
				ok: true,
				lease: {
					sessionId: record.sessionId,
					mode: record.mode,
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
			// A tainted command returns nothing. `close_record` drops its downloads too.
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
		// The agent may have logged in or out. The next viewer renew saves the cookies.
		if (this.profile?.sessionId === record.sessionId) this.profile.dirty = true;
		// A finished command releases a pausing session to its waiting human. When the
		// holder detached mid-take, there is no human to hand to: fall back to ready.
		if (record.control === "pausing") {
			record.control = record.inputHolder ? "human" : "ready";
		} else if (record.control === "agent") {
			record.control = "ready";
		}
		await this.save(record);
		// A download the command started may still be reading, or still checking its frame. Let it
		// land in this command's list.
		await Promise.all([this.downloads?.capture, ...this.safetyNetDownloads]);
		const agent = this.downloads?.agent?.commandId === input.commandId ? this.downloads.agent : null;
		if (agent && this.downloads) this.downloads.agent = null;
		log_browser({
			route: "run_finish",
			sessionId: record.sessionId,
			resultBytes: input.resultBytes,
			fileCount: input.fileCount,
			fileBytes: input.fileBytes,
			downloads: agent?.items.length ?? 0,
		});
		return json_response({
			ok: true,
			state: record.control,
			...(agent?.items.length ? {
				downloads: agent.items.map((item) => ({ name: item.name, contentType: item.contentType, dataBase64: bytes_base64(item.bytes) })),
			} : {}),
			...(agent?.dropped ? { downloadsDropped: agent.dropped } : {}),
		}, 200);
	}

	private async reload(input: { sessionId: string; navGen: number; expectedAgentLease?: AgentLease } & (
		| { mode: "file"; sourceKind: string; sourceVersion: string; sourceHash: string; html: string }
		| { mode: "web" }
	)): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== input.sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.mode !== input.mode) {
			return operation_refused("bad_request", "The browser session has another mode.");
		}
		if (input.expectedAgentLease) {
			const refusal = agent_lease_refusal(record, input.expectedAgentLease);
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
			// The agent may not reload a web page while the user has turned its access off.
			if (record.mode === "web" && !record.agentAccess) {
				return operation_refused("agent_access_off", "Agent access to this browser is off.");
			}
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
		// Web reload only reloads the current page, so the file load and content limits do not apply.
		const htmlBytes = input.mode === "file" ? byte_length(input.html) : 0;
		if (record.mode === "file") {
			if (record.loadCount >= LIMITS.loadCount) {
				return operation_refused("session_limit", "The browser session reached its reload limit.");
			}
			if (record.htmlBytesTotal + htmlBytes > LIMITS.htmlBytesTotal) {
				return operation_refused("session_limit", "The browser session reached its content limit.");
			}
		}
		const previewUrl = this.env.BROWSER_PREVIEW_URL;
		if (!record.providerSessionId || (input.mode === "file" && !previewUrl)) {
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
		let reloadedPageNonce: string | null = null;

		try {
			// Finish a pending host check before reload changes the page nonce.
			await this.connect_host(record);
			const host = this.hostConnection;
			if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
			if (input.mode === "web") {
				// A slow site is not a failure. Only a broken connection closes the session.
				await with_wall_timeout(host.cdp.send("Page.reload"), LIMITS.navWallMs).catch((error: unknown) => {
					if (!(error instanceof WallTimeoutError)) throw error;
				});
			} else {
				// A full navigation resets page input and scroll by design.
				reloadedPageNonce = await load_controller_page(host.page, {
					previewUrl: previewUrl!,
					html: input.html,
				});
				await host.page.setViewportSize(record.viewport);
			}
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
		// Web mode keeps loadGen: the page changes all the time, and agent leases must stay valid.
		if (current.mode === "file" && input.mode === "file") {
			current.loadGen += 1;
			current.pageNonce = reloadedPageNonce;
			current.sourceKind = input.sourceKind;
			current.sourceVersion = input.sourceVersion;
			current.sourceHash = input.sourceHash;
			current.htmlBytesTotal += htmlBytes;
			current.loadCount += 1;
		}
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

	/**
	 * Every close path ends here, including the alarm's last retry. So this is where the usage
	 * receipt is written: Convex bills the session from it.
	 */
	private async release_closed_session(record: SessionRecord, reason: string): Promise<void> {
		await this.release_grant(record.grantId);
		// Another close can finish first and leave the slot free for a new Start.
		const current = await this.state.storage.get<SessionRecord>(SESSION_KEY);
		if (current?.sessionId !== record.sessionId) return;
		// Write the receipt before the record goes away. No browser was acquired means nothing to bill.
		const now = Date.now();
		if (current.providerAcquiredAt !== null) {
			const receipt: UsageReceipt = { sessionId: current.sessionId, providerAcquiredAt: current.providerAcquiredAt, endedAt: now, reason };
			await this.state.storage.put(`${USAGE_KEY_PREFIX}${current.sessionId}`, receipt);
		}
		await this.state.storage.delete(SESSION_KEY);
		// Keep the saved profile's 100-day delete time, if there is one.
		await this.schedule_alarm(null);
		// Convex settles within minutes. Keep receipts for 7 days, then delete them.
		const receipts = await this.state.storage.list<UsageReceipt>({ prefix: USAGE_KEY_PREFIX });
		for (const [key, value] of receipts) {
			if (now - value.endedAt >= LIMITS.usageReceiptMs) await this.state.storage.delete(key);
		}
	}

	private async close_record(record: SessionRecord, reason: string, saveProfile?: boolean): Promise<{ existed: boolean; verified: boolean }> {
		let current = await this.load();
		if (current?.sessionId !== record.sessionId) return { existed: false, verified: true };
		// Save the cookies while the host connection and the page still exist.
		if (this.should_save(current, reason, saveProfile)) {
			await this.save_profile(current);
			// The save waits for the provider. Another close may have finished meanwhile.
			current = await this.load();
			if (current?.sessionId !== record.sessionId) return { existed: false, verified: true };
		}
		// No save may run for this session once its close starts.
		if (this.profile?.sessionId === record.sessionId) this.profile = null;
		// Drop what only lived in memory for this session. At close there may be no viewer left.
		if (this.downloads?.held) this.drop_held_download(this.downloads.held);
		this.downloads = null;
		this.close_file_chooser();
		this.uploadGrants.clear();
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
			if (current?.sessionId === record.sessionId) await this.schedule_alarm(current);
			log_browser({ route: "close", sessionId: record.sessionId, reason, verified });
			return { existed: true, verified };
		}

		await this.release_closed_session(record, reason);
		log_browser({ route: "close", sessionId: record.sessionId, reason, verified });
		return { existed: true, verified };
	}

	private async close(sessionId: string | null, expectedAgentLease?: AgentLease, saveProfile?: boolean, by: string | null = null): Promise<Response> {
		log_browser({ route: "close_request", sessionId: sessionId ?? "none", by: by ?? "unknown", saveProfile: saveProfile === true });
		const record = await this.load();
		// A session closed earlier may still have its receipt.
		if (!record || (sessionId && record.sessionId !== sessionId) || record.control === "closed") {
			return json_response({ ok: true, existed: false, verified: true, usage: sessionId ? await this.usage(sessionId) : null }, 200);
		}
		if (expectedAgentLease) {
			const refusal = agent_lease_refusal(record, expectedAgentLease);
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
		}
		const result = await this.close_record(record, "close", saveProfile);
		return json_response({ ok: true, ...result, usage: await this.usage(record.sessionId) }, 200);
	}

	private async status(sessionId: string): Promise<Response> {
		const record = await this.load();
		const alive = !!record && record.sessionId === sessionId &&
			record.control !== "closed" && record.control !== "closing" && !session_is_expired(record, Date.now());
		// Only whether bytes remain: no profile id and no data. QA and the wipe checks read it.
		const profileStored = (await this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY)) !== undefined;
		if (alive) return json_response({ ok: true, alive, session: this.public_meta(record), profileStored }, 200);
		// The record stays until the provider close finishes. Until then the receipt may still change.
		const closing = !!record && record.sessionId === sessionId;
		return json_response({ ok: true, alive, closing, usage: await this.usage(sessionId), profileStored }, 200);
	}

	/**
	 * True while a session could still save into the profile. A closing session has passed its save.
	 */
	private async session_live() {
		const record = await this.load();
		return !!record && record.control !== "closing" && record.control !== "closed";
	}

	/**
	 * Read the stored profile for these owners. `exists: false` when nothing is stored or the blob
	 * belongs to another profile id. A blob that does not decrypt is an error, not an empty profile.
	 */
	private async read_profile(input: { ownerId: string; organizationId: string; workspaceId: string; profileId: string; profileKey: string }) {
		const stored = await this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY);
		if (stored?.profileId !== input.profileId) return { ok: true as const, stored: null, cookies: [] };
		try {
			const key = await profile_crypto_key(this.env.BROWSER_PROFILE_KEY, input.profileKey);
			const cookies = await profile_decrypt(key, profile_aad(input.profileId, input), stored);
			return { ok: true as const, stored, cookies, key };
		} catch (error) {
			log_browser({ route: "profile_read", error: sanitize_error(error).name });
			return { ok: false as const };
		}
	}

	/**
	 * List the saved sites with a cookie count each. Never cookie names or values.
	 */
	private async profile_summary(input: { ownerId: string; organizationId: string; workspaceId: string; profileId: string; profileKey: string }): Promise<Response> {
		if (await this.session_live()) return operation_refused("busy", "End the browser first.");
		const read = await this.read_profile(input);
		if (!read.ok) return operation_refused("profile_unreadable", "The saved browser data cannot be read.");
		const counts = new Map<string, number>();
		for (const cookie of read.cookies) counts.set(cookie_site(cookie), (counts.get(cookie_site(cookie)) ?? 0) + 1);
		const sites = [...counts].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
		return json_response({
			ok: true,
			exists: read.stored !== null,
			savedAt: read.stored?.savedAt ?? null,
			truncated: read.stored?.truncated ?? false,
			sites,
		}, 200);
	}

	/**
	 * Remove the cookies of one site and its subdomains, then store the rest again. `savedAt` stays.
	 */
	private async profile_clear(input: { ownerId: string; organizationId: string; workspaceId: string; profileId: string; profileKey: string; domain: string }): Promise<Response> {
		if (await this.session_live()) return operation_refused("busy", "End the browser first.");
		const read = await this.read_profile(input);
		if (!read.ok) return operation_refused("profile_unreadable", "The saved browser data cannot be read.");
		if (!read.stored) return json_response({ ok: true, removed: 0 }, 200);
		const domain = browser_web_canonical_host(input.domain.replace(/^\./u, ""));
		const kept = read.cookies.filter((cookie) => !browser_web_host_matches(cookie_site(cookie), [domain]));
		const removed = read.cookies.length - kept.length;
		if (removed === 0) return json_response({ ok: true, removed: 0 }, 200);
		const sealed = await profile_encrypt(read.key, profile_aad(input.profileId, input), kept);

		// Like the save: a delete or an open may have run during the crypto awaits. Put only when the
		// blob is still the one read above and no tombstone exists. Storage reads only until the put.
		const [deletedAt, latest] = await Promise.all([
			this.state.storage.get<number>(`${PROFILE_DELETED_KEY_PREFIX}${input.profileId}`),
			this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY),
		]);
		if (deletedAt !== undefined || latest?.iv !== read.stored.iv) return operation_refused("busy", "The saved browser data changed.");
		await this.state.storage.put(PROFILE_BLOB_KEY, { ...read.stored, ...sealed } satisfies ProfileBlob);
		log_browser({ route: "profile_clear", removed });
		return json_response({ ok: true, removed }, 200);
	}

	/**
	 * Delete a profile's stored bytes. Convex already deleted its key, so this is cleanup. The
	 * tombstone comes first: a save that is still running then skips its put.
	 */
	private async profile_delete(profileId: string): Promise<Response> {
		await this.state.storage.put(`${PROFILE_DELETED_KEY_PREFIX}${profileId}`, Date.now());
		// A live session of this profile ends without saving. A session of a newer profile (after a
		// re-invite or a Clear all) stays.
		const record = await this.load();
		if (record?.mode === "web" && record.profileId === profileId && record.control !== "closing" && record.control !== "closed") {
			await this.close_record(record, "profile_deleted");
		}
		const stored = await this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY);
		if (stored?.profileId === profileId) {
			await this.state.storage.delete(PROFILE_BLOB_KEY);
			await this.state.storage.delete(PROFILE_DELETE_AT_KEY);
		}
		await this.schedule_alarm(await this.load());
		log_browser({ route: "profile_delete", deleted: stored?.profileId === profileId });
		return json_response({ ok: true, deleted: true }, 200);
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
			{ ok: true, idleUntil: record.lastActiveAt + mode_limits(record.mode).idleMs },
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
		// Save the cookies now and then while people use the page, so a provider crash loses at
		// most a few minutes. The renew reply does not wait for it.
		const profile = this.profile;
		if (profile?.sessionId === record.sessionId && profile.dirty && now - profile.savedAt > LIMITS.profileSaveEveryMs) {
			this.state.waitUntil(this.save_profile(record));
		}
		return json_response(
			{
				ok: true,
				grantedUntil: viewer.grantedUntil,
				session: this.public_meta(record),
				control: record.control,
				controlGen: record.controlGen,
				idleUntil: record.lastActiveAt + mode_limits(record.mode).idleMs,
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

	/**
	 * Web mode: the user allows or blocks agent commands on this browser.
	 */
	private async set_agent_access(sessionId: string, on: boolean): Promise<Response> {
		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.mode !== "web") {
			return operation_refused("bad_request", "Agent access applies to web sessions only.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record(record, "expired");
			return operation_refused("expired", "The browser session expired.");
		}

		if (record.agentAccess !== on) {
			record.agentAccess = on;
			// Every real change gets a new controlGen. Convex copies `agentAccess` only from a reply
			// with a controlGen at least as new as its own, so a late reply cannot undo this change.
			record.controlGen += 1;
			// Turning access off works like Take: the new controlGen retires every agent lease, and a
			// running command loses its bridge. Its snippet fails fast and the command settles.
			if (!on && this.agentConnection?.sessionId === record.sessionId) this.agentConnection.bridge?.revoke();
			await this.save(record);
			log_browser({ route: "agent_access", sessionId: record.sessionId, on });
		}
		return json_response({ ok: true, session: this.public_meta(record) }, 200);
	}

	private async viewer_input(viewerId: string, sessionId: string, controlGen: number, loadGen: number | null): Promise<Response> {
		const record = await this.load();
		if (!record || record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (record.sessionId !== sessionId || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.control !== "human" || record.inputHolder !== viewerId || record.command || this.inputTransition ||
			record.controlGen !== controlGen || (loadGen !== null && record.loadGen !== loadGen)) {
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
		// Address bar navs come through here too.
		if (this.profile?.sessionId === record.sessionId) this.profile.dirty = true;
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
		const agentAccessChanged = previous?.mode === "web" && record.mode === "web" && previous.agentAccess !== record.agentAccess;
		for (const stream of this.viewerStreams.values()) {
			const viewer = record.viewers[stream.viewerId];
			if (record.sessionId !== stream.sessionId || !viewer || record.control === "closing" || record.control === "closed") {
				this.end_viewer(stream, 4404, "session gone");
				continue;
			}
			if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
			const limits = mode_limits(record.mode);
			const deadline = Math.min(viewer.grantedUntil, record.providerAcquiredAt! + limits.totalMs, record.lastActiveAt + limits.idleMs);
			stream.deadlineTimer = setTimeout(() => this.end_viewer(stream, 4408, "grant expired"), Math.max(0, deadline - Date.now()));
			try {
				if (!previous || previous.control !== record.control || previous.controlGen !== record.controlGen) {
					stream.socket.send(JSON.stringify({ t: "control", control: record.control, controlGen: record.controlGen }));
				}
				if (viewportChanged) stream.socket.send(JSON.stringify({ t: "viewport", viewport: record.viewport }));
				if (agentAccessChanged) stream.socket.send(JSON.stringify({ t: "agent-access", on: record.agentAccess }));
			} catch {
				this.end_viewer(stream, 1011, "socket error");
			}
		}
		// A chooser belongs to one human turn. It is gone when control or the session moves on.
		const chooser = this.chooser;
		if (chooser && (chooser.sessionId !== record.sessionId || chooser.controlGen !== record.controlGen ||
			record.control !== "human" || record.command)) {
			this.close_file_chooser(chooser);
		}
		if (viewportChanged && this.viewerStreams.size > 0) {
			this.state.waitUntil(this.start_viewer_producer().catch(() => {}));
		}
	}

	private end_viewer(stream: ViewerStream, code: number, reason: string): void {
		if (!this.viewerStreams.delete(stream.viewerId)) return;
		if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
		// Log why each viewer socket ends. A dropped viewer is hard to explain without it.
		log_browser({ route: "viewer_end", sessionId: stream.sessionId, code, reason });
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
				// A click or Enter lets the page start one human download in the next 10 s. Record it
				// before the input runs: the page may start the download while the input is applied.
				if (input.kind === "mouse.up" || input.kind === "mouse.click" ||
					((input.kind === "key.down" || input.kind === "key.press") && input.key === "Enter")) {
					this.humanGesture = { sessionId: stream.sessionId, at: Date.now() };
				}
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

	/**
	 * Web mode: run one address bar action (go, back, forward, reload, stop) for the viewer that
	 * holds control. It uses the same ordered queue and checks as mouse and key input.
	 */
	private queue_viewer_nav(stream: ViewerStream, parsed: Extract<ReturnType<typeof parse_viewer_nav>, { ok: true }>): void {
		const ack = (ok: boolean, code?: string) => {
			try {
				stream.socket.send(JSON.stringify({ t: "nav-ack", seq: parsed.seq, ok, ...(code ? { code } : {}) }));
			} catch {
				this.end_viewer(stream, 1011, "socket error");
			}
		};
		if (this.viewerRecord?.mode !== "web") {
			ack(false, "bad_request");
			return;
		}
		// Check the address first. A refused address needs no queue slot and no storage write.
		let url: string | null = null;
		if (parsed.nav.action === "go") {
			const normalized = browser_web_normalize_url(parsed.nav.url, web_denied_hosts(this.env));
			if (!normalized.ok) {
				ack(false, normalized.reason);
				return;
			}
			url = normalized.url;
		}
		if (this.inputDepth >= 50 || this.inputTransition) {
			ack(false, "busy");
			return;
		}
		const epoch = this.inputEpoch;
		this.inputDepth += 1;
		this.inputQueue = this.inputQueue.then(async () => {
			try {
				if (epoch !== this.inputEpoch || !this.viewerStreams.has(stream.viewerId)) {
					ack(false, "not_controller");
					return;
				}
				// Check human control and set lastActiveAt, like input does.
				const checked: unknown = await (await this.viewer_input(stream.viewerId, stream.sessionId, parsed.controlGen, null)).json();
				if (!is_record(checked) || checked.ok !== true) {
					const code = is_record(checked) && is_record(checked.error) && typeof checked.error.code === "string" ? checked.error.code : "denied";
					ack(false, code === "control" ? "not_controller" : code);
					return;
				}
				await this.start_viewer_producer();
				const host = this.hostConnection;
				const current = this.viewerRecord;
				if (epoch !== this.inputEpoch || this.inputTransition || !host || host.sessionId !== stream.sessionId ||
					current?.sessionId !== stream.sessionId || current.control !== "human" || current.inputHolder !== stream.viewerId) {
					ack(false, "not_controller");
					return;
				}
				// Typing an address and pressing Enter is a human gesture too, so a download link works.
				if (parsed.nav.action === "go") this.humanGesture = { sessionId: stream.sessionId, at: Date.now() };
				// A slow site is still a good nav. A CDP error fails this nav but keeps the session.
				const code = await with_wall_timeout(apply_viewer_nav(host.cdp, parsed.nav.action, url), LIMITS.navWallMs).catch(
					(error: unknown) => (error instanceof WallTimeoutError ? null : "apply"),
				);
				if (code === null) ack(true);
				else ack(false, code);
			} catch {
				ack(false, "apply");
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
			if (typeof event.data !== "string" || event.data.length > LIMITS.viewerMessageChars) return;
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
			if (is_record(body) && body.t === "nav") {
				const nav = parse_viewer_nav(body);
				if (nav.ok) this.queue_viewer_nav(stream, nav);
				return;
			}
			if (is_record(body) && body.t === "file-chooser-cancel") {
				const current = this.viewerRecord;
				// Only the viewer that holds human control may answer the page's file dialog.
				if (typeof body.chooserId === "string" && current?.sessionId === stream.sessionId && current.inputHolder === viewerId) {
					this.state.waitUntil(this.cancel_file_chooser(body.chooserId).catch(() => {}));
				}
				return;
			}
			const parsed = parse_viewer_input(event.data);
			if (parsed.ok) this.queue_viewer_input(stream, parsed);
		});
		try {
			socket.send(JSON.stringify({ t: "hello", viewerId, viewport: current.viewport, control: current.control, controlGen: current.controlGen }));
			if (current.mode === "web") socket.send(JSON.stringify({ t: "agent-access", on: current.agentAccess }));
			this.sync_viewers(current);
			// A viewer that reconnects missed what was pushed while it was away. Send the waiting
			// download and the open chooser again. The Convex save is idempotent per `downloadId`.
			const held = this.downloads?.held ? this.held_download(current.sessionId, this.downloads.held.downloadId) : null;
			if (held) socket.send(JSON.stringify({ t: "download", downloadId: held.downloadId, name: held.name, size: held.size, contentType: held.contentType }));
			const chooser = this.chooser;
			if (chooser?.sessionId === current.sessionId) {
				socket.send(JSON.stringify({ t: "file-chooser", chooserId: chooser.chooserId, multiple: chooser.multiple, accept: chooser.accept, origin: chooser.origin }));
			}
			await this.start_viewer_producer();
			this.send_viewer_frame(stream);
			if (current.mode === "web" && this.hostConnection?.sessionId === current.sessionId) this.push_location(this.hostConnection);
		} catch {
			this.end_viewer(stream, 1011, "viewer start failed");
		}
	}

	async alarm(): Promise<void> {
		// The saved profile's backstop: nobody used it for 100 days, so delete it here even if every
		// Convex wipe failed. An early alarm (for a session deadline, or a stray one) keeps it.
		const now = Date.now();
		const profileDeleteAt = await this.state.storage.get<number>(PROFILE_DELETE_AT_KEY);
		if (profileDeleteAt !== undefined && now >= profileDeleteAt) {
			await this.state.storage.delete(PROFILE_BLOB_KEY);
			await this.state.storage.delete(PROFILE_DELETE_AT_KEY);
			log_browser({ route: "alarm", profileExpired: true });
		}
		// A tombstone only has to outlive a save that was running during the delete.
		const tombstones = await this.state.storage.list<number>({ prefix: PROFILE_DELETED_KEY_PREFIX });
		for (const [key, deletedAt] of tombstones) {
			if (now - deletedAt >= LIMITS.profileTombstoneMs) await this.state.storage.delete(key);
		}

		const record = await this.load();
		if (!record) {
			await this.schedule_alarm(null);
			return;
		}
		if (record.control === "closing") {
			if (record.closeAttempts >= LIMITS.closeAttempts) {
				// The provider close was never verified. The provider keep-alive ends the browser.
				await this.release_closed_session(record, "close_unverified");
				return;
			}
			await this.close_record(record, "closing_retry");
			return;
		}
		if (record.control === "closed") {
			await this.schedule_alarm(record);
			return;
		}
		if (
			record.control === "starting" &&
			now - record.createdAt >= LIMITS.startingStaleMs
		) {
			await this.close_record(record, "stale_start");
			return;
		}
		if (session_is_expired(record, now)) {
			await this.close_record(record, "expired");
			return;
		}
		// A worker crash can leave browser work running after its caller has gone.
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
		// The Worker already checked the query, the size, and the CORS origin.
		if (request.method === "PUT" && url.pathname === "/viewer/upload") return await this.viewer_upload(request, url);
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
			if (body.mode === "web") {
				if (
					typeof body.grantId !== "string" ||
					typeof body.attemptId !== "string" ||
					typeof body.ownerId !== "string" ||
					typeof body.organizationId !== "string" ||
					typeof body.workspaceId !== "string" ||
					!is_positive_int(body.navGen) ||
					(body.startUrl !== null && typeof body.startUrl !== "string") ||
					typeof body.agentAccess !== "boolean" ||
					typeof body.profileId !== "string" ||
					typeof body.profileKey !== "string" ||
					!Array.isArray(body.agentBlockedHosts) ||
					!body.agentBlockedHosts.every((host) => typeof host === "string") ||
					!viewport ||
					!is_positive_int(viewport.width) ||
					!is_positive_int(viewport.height)
				) {
					return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
				}
				return await this.open({
					mode: "web",
					grantId: body.grantId,
					attemptId: body.attemptId,
					ownerId: body.ownerId,
					organizationId: body.organizationId,
					workspaceId: body.workspaceId,
					navGen: body.navGen,
					startUrl: body.startUrl,
					agentAccess: body.agentAccess,
					profileId: body.profileId,
					profileKey: body.profileKey,
					agentBlockedHosts: body.agentBlockedHosts,
					viewport: { width: viewport.width, height: viewport.height },
				});
			}
			if (
				body.mode !== "file" ||
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
				mode: "file",
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
			if (body.mode === "web") {
				if (
					typeof body.sessionId !== "string" ||
					!is_positive_int(body.navGen) ||
					(body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease))
				) {
					return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
				}
				return await this.reload({
					mode: "web",
					sessionId: body.sessionId,
					navGen: body.navGen,
					expectedAgentLease: body.expectedAgentLease,
				});
			}
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
				mode: "file",
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
				(body.expectedAgentLease !== undefined && (!is_agent_lease(body.expectedAgentLease) || !is_non_empty_string(body.sessionId))) ||
				(body.saveProfile !== undefined && typeof body.saveProfile !== "boolean") ||
				(body.by !== undefined && typeof body.by !== "string")
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.close(
				typeof body.sessionId === "string" ? body.sessionId : null,
				body.expectedAgentLease,
				body.saveProfile,
				typeof body.by === "string" ? body.by : null,
			);
		}
		if (url.pathname === "/profile/summary" || url.pathname === "/profile/clear") {
			if (
				typeof body.ownerId !== "string" ||
				typeof body.organizationId !== "string" ||
				typeof body.workspaceId !== "string" ||
				typeof body.profileId !== "string" ||
				typeof body.profileKey !== "string" ||
				(url.pathname === "/profile/clear" && typeof body.domain !== "string")
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			const input = { ownerId: body.ownerId, organizationId: body.organizationId, workspaceId: body.workspaceId, profileId: body.profileId, profileKey: body.profileKey };
			if (url.pathname === "/profile/summary") return await this.profile_summary(input);
			return await this.profile_clear({ ...input, domain: String(body.domain) });
		}
		if (url.pathname === "/profile/delete") {
			if (typeof body.profileId !== "string") return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			return await this.profile_delete(body.profileId);
		}
		if (url.pathname === "/download/info" || url.pathname === "/download/push") {
			const headers = is_record(body.headers) ? Object.entries(body.headers) : [];
			if (
				typeof body.sessionId !== "string" ||
				typeof body.downloadId !== "string" ||
				(url.pathname === "/download/push" && (typeof body.url !== "string" || !is_record(body.headers) ||
					!headers.every(([, value]) => typeof value === "string")))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			if (url.pathname === "/download/info") return this.download_info(body.sessionId, body.downloadId);
			return await this.download_push({
				sessionId: body.sessionId,
				downloadId: body.downloadId,
				url: String(body.url),
				headers: Object.fromEntries(headers.map(([name, value]) => [name, String(value)])),
			});
		}
		if (url.pathname === "/upload/fill" || url.pathname === "/upload/grant") {
			const files: Array<{ name: string; contentType: string; url: string }> = [];
			for (const file of Array.isArray(body.files) ? (body.files as unknown[]) : []) {
				if (is_record(file) && typeof file.name === "string" && typeof file.contentType === "string" && typeof file.url === "string") {
					files.push({ name: file.name, contentType: file.contentType, url: file.url });
				}
			}
			if (
				typeof body.sessionId !== "string" ||
				typeof body.chooserId !== "string" ||
				!is_positive_int(body.controlGen) ||
				(url.pathname === "/upload/fill" && (!Array.isArray(body.files) || files.length !== body.files.length))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			const input = { sessionId: body.sessionId, chooserId: body.chooserId, controlGen: body.controlGen };
			if (url.pathname === "/upload/grant") return await this.upload_grant(input);
			return await this.upload_fill({ ...input, files });
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
		if (url.pathname === "/agent-access") {
			if (typeof body.sessionId !== "string" || typeof body.on !== "boolean") {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.set_agent_access(body.sessionId, body.on);
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

	const parsed = await parse_json_body(request, new Set([...BROWSER_OPEN_FIELDS, ...BROWSER_WEB_OPEN_FIELDS]));
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	// Each mode has its own strict field set.
	const allowed = body.mode === "web" ? BROWSER_WEB_OPEN_FIELDS : body.mode === "file" ? BROWSER_OPEN_FIELDS : null;
	if (!allowed) return invalid_request("`mode` must be file or web.");
	for (const key of Object.keys(body)) {
		if (!allowed.has(key)) return invalid_request(`Unknown request field \`${key}\`.`);
	}
	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	const viewport = parse_viewport(body);
	if (!viewport.ok) return viewport.response;
	let modeFields: Record<string, unknown>;
	if (body.mode === "web") {
		// Web sessions never change document, so navGen stays 1.
		if (body.navGen !== 1) return invalid_request("`navGen` must be 1 in web mode.");
		if (body.startUrl !== null && typeof body.startUrl !== "string") return invalid_request("`startUrl` must be a string or null.");
		if (typeof body.agentAccess !== "boolean") return invalid_request("`agentAccess` must be a boolean.");
		// Convex owns the profile doc. Its id names the saved cookies, and its key unlocks them.
		if (!is_profile_id(body.profileId)) return invalid_request("`profileId` is invalid.");
		if (!is_profile_key(body.profileKey)) return invalid_request("`profileKey` must be 32 bytes in base64.");
		if (
			!Array.isArray(body.agentBlockedHosts) || body.agentBlockedHosts.length > LIMITS.agentBlockedHosts ||
			!body.agentBlockedHosts.every((host) => is_non_empty_string(host) && host.length <= LIMITS.hostChars)
		) {
			return invalid_request("`agentBlockedHosts` must be a short list of hosts.");
		}
		modeFields = {
			mode: "web",
			startUrl: body.startUrl,
			agentAccess: body.agentAccess,
			profileId: body.profileId,
			profileKey: body.profileKey,
			agentBlockedHosts: body.agentBlockedHosts,
		};
	} else {
		const snapshot = parse_snapshot(body);
		if (!snapshot.ok) return snapshot.response;
		if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");
		if (!is_non_empty_string(body.nodeId) || body.nodeId.length > 128) {
			return invalid_request("`nodeId` is required.");
		}
		modeFields = {
			mode: "file",
			nodeId: body.nodeId,
			sourceKind: snapshot.sourceKind,
			sourceVersion: snapshot.sourceVersion,
			sourceHash: snapshot.sourceHash,
			html: snapshot.html,
		};
	}
	const attemptId =
		typeof body.attemptId === "string" && body.attemptId.length > 0 && body.attemptId.length <= 128
			? body.attemptId
			: crypto.randomUUID();

	// Charge admission before acquisition so simultaneous calls cannot bypass quotas.
	const claim = await object_json(registry_stub(env), "/claim", {
		workspaceKey: workspace_key(owners.organizationId, owners.workspaceId),
		ownerId: owners.ownerId,
		organizationId: owners.organizationId,
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
			...modeFields,
			grantId: claim.grantId,
			attemptId,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			navGen: body.navGen,
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
	mode: SessionMode;
	runtimeOrigin: string | null;
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
			mode: input.mode,
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
	) => Promise<unknown>;
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
		(lease.mode !== "file" && lease.mode !== "web") ||
		!leaseViewport ||
		!is_positive_int(leaseViewport.width) ||
		!is_positive_int(leaseViewport.height)
	) {
		return json_response(
			{ ok: false, error: { code: "begin_failed", message: "The browser command did not start." } },
			200,
		);
	}
	const mode = lease.mode;
	// Only file mode loads the preview runtime.
	if (mode === "file" && !env.BROWSER_PREVIEW_URL) {
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
			mode,
			runtimeOrigin: mode === "file" ? CONTROLLER_ORIGIN : null,
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

	// The page ended on a site the user blocked for the agent. Drop the output, keep the session.
	if (check.blockedSite === true) {
		await finish(false, { resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: snippetViewport(sandbox.viewport) });
		log_browser({ route: "run", commandId, status: "agent_blocked_site", elapsedMs });
		return json_response(
			{ ok: false, error: { code: "agent_blocked_site", message: "The page is on a site the agent may not use." } },
			200,
		);
	}

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
	const finished = await finish(false, { resultBytes, fileCount: files.files.length, fileBytes: files.fileBytes, viewport: snippetViewport(sandbox.viewport) });
	// Web mode: the files the page downloaded during the command. They share the 8-file, 8 MiB
	// output limit with `emitFile` files, which come first. Downloads over the limit are dropped.
	const downloads: Array<{ name: string; contentType: string; dataBase64: string }> = [];
	let downloadsDropped = is_record(finished) && is_positive_int(finished.downloadsDropped) ? finished.downloadsDropped : 0;
	let outputCount = files.files.length;
	let outputBytes = files.fileBytes;
	for (const item of is_record(finished) && Array.isArray(finished.downloads) ? (finished.downloads as unknown[]) : []) {
		const size = is_record(item) && typeof item.dataBase64 === "string" ? base64_bytes(item.dataBase64)?.byteLength : undefined;
		if (!is_record(item) || typeof item.name !== "string" || typeof item.contentType !== "string" || typeof item.dataBase64 !== "string" ||
			size === undefined || outputCount >= LIMITS.files || outputBytes + size > LIMITS.fileBytes) {
			downloadsDropped += 1;
			continue;
		}
		outputCount += 1;
		outputBytes += size;
		downloads.push({ name: item.name, contentType: item.contentType, dataBase64: item.dataBase64 });
	}
	log_browser({
		route: "run",
		commandId,
		status: "succeeded",
		elapsedMs,
		resultBytes,
		fileCount: files.files.length,
		downloadCount: downloads.length,
		downloadsDropped,
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
			downloads,
			...(downloadsDropped > 0 ? { downloadsDropped } : {}),
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
		const finished = await object_json(stub, "/run/finish", {
			sessionId: body.sessionId,
			commandId,
			tainted,
			...meta,
		});
		runState.finished = true;
		return finished;
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

	const parsed = await parse_json_body(request, new Set([...BROWSER_RELOAD_FIELDS, ...BROWSER_WEB_RELOAD_FIELDS]));
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	// Web reload reloads the current page. It carries no file snapshot.
	if (body.mode === "web") {
		for (const key of Object.keys(body)) {
			if (!BROWSER_WEB_RELOAD_FIELDS.has(key)) return invalid_request(`Unknown request field \`${key}\`.`);
		}
		if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
		if (body.navGen !== 1) return invalid_request("`navGen` must be 1 in web mode.");
		if (body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease)) {
			return invalid_request("`expectedAgentLease` must contain positive nav, load, and control generations.");
		}
		const reloaded = await object_json(
			session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
			"/reload",
			{ mode: "web", sessionId: body.sessionId, navGen: body.navGen, expectedAgentLease: body.expectedAgentLease },
		);
		return json_response(is_record(reloaded) ? reloaded : { ok: false, error: { code: "reload_failed" } }, 200);
	}
	if (body.mode !== undefined && body.mode !== "file") return invalid_request("`mode` must be file or web.");
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
	// Only a human End sends `saveProfile: true`. Every other close drops the cookies.
	if (body.saveProfile !== undefined && typeof body.saveProfile !== "boolean") {
		return invalid_request("`saveProfile` must be a boolean.");
	}
	// The app names the path that asked for the close. It is only logged, so a close nobody
	// expected can be traced back to its caller. A bad code is dropped, never a reason to refuse
	// the close: the app marks its session closed even when this call fails.
	const by = typeof body.reason === "string" && /^[a-z_]{1,40}$/u.test(body.reason) ? body.reason : undefined;

	// Send close without the caller's abort signal: cleanup must complete even
	// when the triggering request is already gone.
	const closed = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/close",
		{ sessionId: body.sessionId, expectedAgentLease: body.expectedAgentLease, saveProfile: body.saveProfile, by },
	);
	return json_response(
		is_record(closed) ? closed : { ok: false, error: { code: "close_failed" } },
		200,
	);
}

async function handle_browser_profile(request: Request, env: Env, route: "summary" | "clear"): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, route === "summary" ? BROWSER_PROFILE_SUMMARY_FIELDS : BROWSER_PROFILE_CLEAR_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_profile_id(body.profileId)) return invalid_request("`profileId` is invalid.");
	if (!is_profile_key(body.profileKey)) return invalid_request("`profileKey` must be 32 bytes in base64.");
	if (route === "clear" && (!is_non_empty_string(body.domain) || body.domain.length > LIMITS.hostChars)) {
		return invalid_request("`domain` is invalid.");
	}

	const replied = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		`/profile/${route}`,
		{ ownerId: owners.ownerId, organizationId: owners.organizationId, workspaceId: owners.workspaceId, profileId: body.profileId, profileKey: body.profileKey, ...(route === "clear" ? { domain: body.domain } : {}) },
	);
	return json_response(is_record(replied) ? replied : { ok: false, error: { code: "profile_failed" } }, 200);
}

async function handle_browser_profile_delete(request: Request, env: Env): Promise<Response> {
	// Deleting saved data stays available while disabled, like close. Auth still applies.
	if (!(await is_authorized(request, env))) {
		return json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401);
	}

	const parsed = await parse_json_body(request, BROWSER_PROFILE_DELETE_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_profile_id(body.profileId)) return invalid_request("`profileId` is invalid.");

	const deleted = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/profile/delete",
		{ profileId: body.profileId },
	);
	return json_response(is_record(deleted) ? deleted : { ok: false, error: { code: "profile_failed" } }, 200);
}

/**
 * A signed R2 URL from Convex: `https` and at most 8192 characters.
 */
function is_signed_url(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 8192) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * The id fields of the download and upload routes. Each one names one item in DO memory.
 */
function is_item_id(value: unknown): value is string {
	return is_non_empty_string(value) && value.length <= 128;
}

async function handle_browser_download(request: Request, env: Env, route: "info" | "push"): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, route === "info" ? BROWSER_DOWNLOAD_INFO_FIELDS : BROWSER_DOWNLOAD_PUSH_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_item_id(body.sessionId) || !is_item_id(body.downloadId)) return invalid_request("`sessionId` and `downloadId` are required.");
	if (route === "push") {
		if (!is_signed_url(body.url)) return invalid_request("`url` must be an https URL.");
		// The signed PUT may need a few headers, like `Content-Type`. Keep them plain and small.
		const headers = is_record(body.headers) ? Object.entries(body.headers) : null;
		if (!headers || headers.length > 20 || !headers.every(([name, value]) =>
			/^[A-Za-z0-9-]{1,64}$/u.test(name) && typeof value === "string" && value.length <= 1024 && !/[\r\n]/u.test(value))) {
			return invalid_request("`headers` is invalid.");
		}
	}

	const replied = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		`/download/${route}`,
		{ sessionId: body.sessionId, downloadId: body.downloadId, ...(route === "push" ? { url: body.url, headers: body.headers } : {}) },
	);
	return json_response(is_record(replied) ? replied : { ok: false, error: { code: "download_failed" } }, 200);
}

async function handle_browser_upload(request: Request, env: Env, route: "fill" | "grant"): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, route === "fill" ? BROWSER_UPLOAD_FILL_FIELDS : BROWSER_UPLOAD_GRANT_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_item_id(body.sessionId) || !is_item_id(body.chooserId)) return invalid_request("`sessionId` and `chooserId` are required.");
	if (!is_positive_int(body.controlGen)) return invalid_request("`controlGen` must be a positive int.");
	if (route === "fill") {
		if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > LIMITS.uploadFiles) {
			return invalid_request("`files` must have 1 to 10 items.");
		}
		for (const file of body.files as unknown[]) {
			if (!is_record(file) || Object.keys(file).some((key) => !BROWSER_UPLOAD_FILE_FIELDS.has(key)) ||
				!is_non_empty_string(file.name) || file.name.length > 255 ||
				!is_non_empty_string(file.contentType) || file.contentType.length > 255 || !is_signed_url(file.url)) {
				return invalid_request("`files` has an invalid item.");
			}
		}
	}

	const replied = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		`/upload/${route}`,
		{ sessionId: body.sessionId, chooserId: body.chooserId, controlGen: body.controlGen, ...(route === "fill" ? { files: body.files } : {}) },
	);
	return json_response(is_record(replied) ? replied : { ok: false, error: { code: "upload_failed" } }, 200);
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

async function handle_browser_agent_access(request: Request, env: Env): Promise<Response> {
	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(request, BROWSER_AGENT_ACCESS_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (typeof body.on !== "boolean") return invalid_request("`on` must be a boolean.");

	const changed = await object_json(
		session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId),
		"/agent-access",
		{ sessionId: body.sessionId, on: body.on },
	);
	return json_response(
		is_record(changed) ? changed : { ok: false, error: { code: "agent_access_failed" } },
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
	| { kind: "key.type"; text: string }
	| { kind: "text.insert"; text: string };

/**
 * One address bar action from the web viewer.
 */
type ViewerNav = { action: "go"; url: string } | { action: "back" | "forward" | "reload" | "stop" };

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
	if (typeof data !== "string" || data.length === 0 || data.length > LIMITS.viewerMessageChars) return { ok: false };
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
		case "text.insert":
			if (typeof body.text === "string" && body.text.length > 0 && body.text.length <= LIMITS.textInsertChars) {
				return { ok: true, seq: body.seq, ...lease, input: { kind: "text.insert", text: body.text } };
			}
			break;
	}
	return { ok: false };
}

/**
 * Parse a `nav` message. The address rules run later, so a bad address gets a nav-ack with its reason.
 */
function parse_viewer_nav(
	body: unknown,
): { ok: true; seq: string | number; controlGen: number; nav: ViewerNav } | { ok: false } {
	if (!is_record(body) || body.t !== "nav") return { ok: false };
	if (typeof body.seq !== "string" && typeof body.seq !== "number") return { ok: false };
	if (!is_positive_int(body.controlGen) || !Number.isSafeInteger(body.controlGen)) return { ok: false };
	if (body.action === "go") {
		if (typeof body.url !== "string") return { ok: false };
		return { ok: true, seq: body.seq, controlGen: body.controlGen, nav: { action: "go", url: body.url } };
	}
	if (body.action === "back" || body.action === "forward" || body.action === "reload" || body.action === "stop") {
		if (body.url !== undefined) return { ok: false };
		return { ok: true, seq: body.seq, controlGen: body.controlGen, nav: { action: body.action } };
	}
	return { ok: false };
}

/**
 * Run one address bar action on the page. Return null on success or a refusal code.
 */
async function apply_viewer_nav(cdp: CDPSession, action: ViewerNav["action"], url: string | null): Promise<string | null> {
	switch (action) {
		case "go":
			await cdp.send("Page.navigate", { url: url! });
			return null;
		case "reload":
			await cdp.send("Page.reload");
			return null;
		case "stop":
			await cdp.send("Page.stopLoading");
			return null;
		case "back":
		case "forward": {
			const history = await cdp.send("Page.getNavigationHistory");
			const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
			if (!entry) return "no_history";
			await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
			return null;
		}
	}
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
		case "text.insert":
			// One CDP Input.insertText call, like a paste. It sends no key events.
			await page.keyboard.insertText(input.text);
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

/**
 * `PUT /viewer/upload`: one file from the user's computer for the open file chooser. It is public:
 * the single-use grant in the query is the secret. Only the app origins in `BROWSER_APP_ORIGINS`
 * may call it from a browser (CORS).
 */
async function handle_viewer_upload(request: Request, env: Env): Promise<Response> {
	const origin = request.headers.get("Origin");
	const cors = origin && app_origins(env).includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : null;
	if (request.method === "OPTIONS") {
		// A refused preflight has no CORS headers, so the browser never sends the PUT.
		if (!cors || request.headers.get("Access-Control-Request-Method") !== "PUT") return new Response(null, { status: 403 });
		return new Response(null, {
			status: 204,
			headers: { ...cors, "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" },
		});
	}
	if (!cors) return json_response({ ok: false, code: "origin_refused" }, 403);
	const reply = (response: Response) => {
		const out = new Response(response.body, response);
		for (const [name, value] of Object.entries(cors)) out.headers.set(name, value);
		return out;
	};
	if (env.BROWSER_RUNNER_DISABLED === "true") return reply(json_response({ ok: false, code: "disabled" }, 503));

	const url = new URL(request.url);
	const owners = parse_owner_tuple({
		ownerId: url.searchParams.get("ownerId"),
		organizationId: url.searchParams.get("organizationId"),
		workspaceId: url.searchParams.get("workspaceId"),
	});
	const name = url.searchParams.get("name") ?? "";
	if (!owners.ok || !is_item_id(url.searchParams.get("grantId")) || name.length < 1 || name.length > 255) {
		return reply(json_response({ ok: false, code: "invalid_request" }, 400));
	}
	// Refuse a large file before reading it. The session object still caps the bytes it reads.
	const length = request.headers.get("Content-Length");
	if (length === null || !/^\d+$/u.test(length)) return reply(json_response({ ok: false, code: "length_required" }, 411));
	if (Number(length) > LIMITS.uploadBytes) return reply(json_response({ ok: false, code: "too_large" }, 413));

	// A throw would reach the browser as a bare 500 without CORS headers, which the app cannot read.
	try {
		return reply(await session_stub(env, owners.ownerId, owners.organizationId, owners.workspaceId).fetch(request));
	} catch (error) {
		log_browser({ route: "viewer_upload", error: sanitize_error(error).name });
		return reply(json_response({ ok: false, code: "upload_failed" }, 500));
	}
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
	if (request.method === "POST" && url.pathname === "/internal/browser/agent-access") {
		return handle_browser_agent_access(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/profile-summary") {
		return handle_browser_profile(request, env, "summary");
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/profile-clear") {
		return handle_browser_profile(request, env, "clear");
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/profile-delete") {
		return handle_browser_profile_delete(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/download-info") {
		return handle_browser_download(request, env, "info");
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/download-push") {
		return handle_browser_download(request, env, "push");
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/upload-fill") {
		return handle_browser_upload(request, env, "fill");
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/upload-grant") {
		return handle_browser_upload(request, env, "grant");
	}
	if ((request.method === "PUT" || request.method === "OPTIONS") && url.pathname === "/viewer/upload") {
		return handle_viewer_upload(request, env);
	}
	return json_response({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
	fetch: handle_request,
};
