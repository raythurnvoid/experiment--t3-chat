// Host Worker for the cloud browser.
//
// Runs agent Playwright JavaScript in a Worker Loader Dynamic Worker against one
// Cloudflare Browser Run session. The host owns the session, the snapshot, and the
// network policy. The snippet sees only its assigned session connection.
//
// The BrowserSession Durable Object owns one mode slot per owner/organization/workspace:
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
//   The snippet module exports `connect`, `expect`, and the pure host matcher; the connection
//   gate accepts one command connection through its owning session object.
//   The trusted bridge checks every protocol method, parameter, and target.
// - The provider session id never leaves the runner. Callers use the opaque app
//   session id plus generations; late calls from a retired session are refused.
// - Operational logs include only execution metadata, never code, HTML, DOM,
//   viewer URLs, tokens, cookies, input text, or captured console text.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { acquire, connect, errors, sessions } from "@cloudflare/playwright";
import type { CDPSession, FileChooser, Page } from "@cloudflare/playwright";
import { AgentConnection } from "./agent-connection";
import {
	SNIPPET_EXECUTOR_MAIN_MODULE,
	SNIPPET_EXECUTOR_SOFT_MARGIN_MS,
	snippet_executor_cap_message,
	snippet_executor_check_files,
	snippet_executor_check_state,
	snippet_executor_check_state_warnings,
	snippet_executor_LIMITS,
	snippet_executor_modules,
} from "./snippet-executor";
import { handle_playwriter_request, type PlaywriterGatewayProps } from "./playwriter-session";
export { PlaywriterSession, PlaywriterConnectionGateway } from "./playwriter-session";
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
			stateJson?: unknown;
			stateWarnings?: unknown;
	  }
	| {
			ok: false;
			timedOut?: boolean;
			error: { name: string; message: string };
			viewport: { width: number; height: number } | null;
			popups: { blocked: number; urls: string[] };
			consoleEntries: string[];
			pageErrors: string[];
			logs: string[];
			logsTruncated: boolean;
			stateJson?: unknown;
			stateWarnings?: unknown;
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
	PLAYWRITER_SESSIONS: DurableObjectNamespaceStub;
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
		readonly PlaywriterConnectionGateway?: (options: { props: PlaywriterGatewayProps }) => Fetcher;
	};
};

type BrowserConnectionGatewayProps = {
	mode: SessionMode;
	sessionId: string;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	commandId: string;
};

// Session model

type SessionControl = "starting" | "ready" | "agent" | "pausing" | "human" | "closing" | "closed";

type AgentLease = {
	navGen: number;
	loadGen: number;
	controlGen: number;
	tabId?: string;
	tabGen?: number;
	policyRevision?: number;
};

type BrowserTab = { targetId: string; tabGen: number; navGen: number; viewport: { width: number; height: number } };
type TabOperationReceipt = {
	sessionId: string;
	deadline: number;
	source?: CommandReceipt["source"];
	status: "in_progress" | "completed" | "refused" | "unknown";
	hash: string;
	session: Record<string, unknown> | null;
	usage: { providerAcquiredAt: number; endedAt: number; reason: string } | null;
	result: { tabId: string | null; reason: string | null; cleanup: "complete" | "unknown" };
};
type CommandReceipt = {
	sessionId: string;
	commandId: string;
	codeHash: string;
	source: { chatId: string; sourceMessageId: string; toolCallId: string };
	deadline: number;
	receiptResolutionDeadline: number;
	payloadHash: string | null;
	status: "in_progress" | "completed" | "refused" | "unknown" | "not_started";
	result: { cleanup: "complete" | "unknown"; reason: string | null };
	session: Record<string, unknown> | null;
};
type ScriptState = { sessionId: string; json: string; savedAt: number };

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
	command: {
		id: string;
		startedAt: number;
		deadline?: number;
		tabId?: string;
		connection?: "available" | "consumed" | "revoked" | "settled";
	} | null;
	commandCount: number;
	createdAt: number;
	providerAcquiredAt: number | null;
	lastActiveAt: number;
	attemptId: string;
	closeAttempts: number;
	inputHolder: string | null;
	viewers: Record<
		string,
		{ host: string; controlGen: number; grantedUntil: number; lastInputAt: number; attachedAt: number }
	>;
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
				tabs: Record<string, BrowserTab>;
				tabId: string;
				viewedTabId: string;
				viewGen: number;
				policyRevision: number;
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
		{
			workspaceKey: string;
			ownerId: string;
			organizationId: string;
			state: "claimed" | "active";
			expiresAt: number | null;
		}
	>;
};

// Limits / constants

export const LIMITS = {
	...snippet_executor_LIMITS,
	webTabs: 8,
	bodyBytes: 6_291_456,
	htmlBytes: 900_000,
	htmlBytesTotal: 8_388_608,
	loadCount: 32,
	codeBytes: 20_480,
	textOutBytes: 16_384,
	viewerFrameBytes: 2_097_152,
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
const CONTROLLER_ORIGIN = "https://controller.browser.invalid";
const CONTROLLER_URL = `${CONTROLLER_ORIGIN}/`;
const SESSION_KEY = "session";
const USAGE_KEY_PREFIX = "usage:";
// One `state` value per chat, kept only while its browser session is open. The chat id comes
// from the server-set command receipt, so a script cannot read another chat's value.
const SCRIPT_STATE_KEY_PREFIX = "scriptState:";
const SCRIPT_STATE_MAX_CHATS = 8;
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
	"operationId",
	"operationDeadline",
	"source",
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
	"policyRevision",
	"operationId",
	"operationDeadline",
	"source",
]);
const BROWSER_RUN_FIELDS = new Set([
	"mode",
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"loadGen",
	"controlGen",
	"commandId",
	"code",
	"tabId",
	"tabGen",
	"policyRevision",
	"source",
	"deadline",
	"receiptResolutionDeadline",
]);
const BROWSER_COMMAND_FIELDS = new Set([
	"mode",
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"commandId",
	"codeHash",
	"source",
	"deadline",
	"receiptResolutionDeadline",
]);
const BROWSER_OPERATION_FIELDS = new Set([
	"mode",
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"operationId",
	"operationDeadline",
	"expectedAgentLease",
	"source",
	"policyRevision",
	"tabId",
	"url",
	"viewerId",
]);
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
const BROWSER_WEB_RELOAD_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"mode",
	"expectedAgentLease",
]);
for (const fields of [BROWSER_RELOAD_FIELDS, BROWSER_WEB_RELOAD_FIELDS])
	for (const key of ["operationId", "operationDeadline", "source", "policyRevision", "tabId", "tabGen"])
		fields.add(key);
const BROWSER_CLOSE_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"reason",
	"expectedAgentLease",
	"saveProfile",
]);
for (const key of ["operationId", "operationDeadline", "source", "policyRevision"]) BROWSER_CLOSE_FIELDS.add(key);
const BROWSER_AGENT_ACCESS_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"on",
	"agentBlockedHosts",
	"policyRevision",
]);
const BROWSER_STATUS_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId"]);
const BROWSER_KEEP_OPEN_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_GRANT_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "navGen"]);
const BROWSER_VIEWER_RENEW_FIELDS = new Set(["sessionId", "ownerId", "organizationId", "workspaceId", "viewerId"]);
const BROWSER_CONTROL_TAKE_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"viewerId",
]);
const BROWSER_CONTROL_RESUME_FIELDS = new Set([
	"sessionId",
	"ownerId",
	"organizationId",
	"workspaceId",
	"navGen",
	"controlGen",
]);
const BROWSER_PROFILE_SUMMARY_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "profileId", "profileKey"]);
const BROWSER_PROFILE_CLEAR_FIELDS = new Set([
	"ownerId",
	"organizationId",
	"workspaceId",
	"profileId",
	"profileKey",
	"domain",
]);
const BROWSER_PROFILE_DELETE_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "profileId"]);
const BROWSER_DOWNLOAD_INFO_FIELDS = new Set(["ownerId", "organizationId", "workspaceId", "sessionId", "downloadId"]);
const BROWSER_DOWNLOAD_PUSH_FIELDS = new Set([...BROWSER_DOWNLOAD_INFO_FIELDS, "url", "headers"]);
const BROWSER_UPLOAD_GRANT_FIELDS = new Set([
	"ownerId",
	"organizationId",
	"workspaceId",
	"sessionId",
	"chooserId",
	"controlGen",
	"tabId",
	"tabGen",
	"viewGen",
]);
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

function is_revision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function is_command_source(value: unknown): value is CommandReceipt["source"] {
	return (
		is_record(value) &&
		Object.keys(value).length === 3 &&
		[value.chatId, value.sourceMessageId, value.toolCallId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		)
	);
}

function is_agent_lease(value: unknown): value is AgentLease {
	return (
		is_record(value) &&
		is_positive_int(value.navGen) &&
		is_positive_int(value.loadGen) &&
		is_positive_int(value.controlGen)
	);
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
			message: snippet_executor_cap_message(typeof e.message === "string" ? e.message : String(error)),
		};
	}
	return { name: "Error", message: snippet_executor_cap_message(String(error)) };
}

/**
 * Re-enforce snippet text bounds on the host. The harness caps these arrays itself, but user
 * code reaches them as closure state and can bypass that, so the host caps again: per-list
 * entry count plus one shared byte budget across the lists.
 */
export function cap_snippet_string_lists(args: { lists: Array<unknown>; maxEntries: number; maxBytes: number }): {
	capped: Array<Array<string>>;
	truncated: boolean;
} {
	const { lists, maxEntries, maxBytes } = args;

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
	const console = cap_snippet_string_lists({
		lists: [sandbox.consoleEntries, sandbox.pageErrors],
		maxEntries: LIMITS.consoleEntries,
		maxBytes: LIMITS.consoleBytes,
	});
	const logs = cap_snippet_string_lists({
		lists: [sandbox.logs],
		maxEntries: LIMITS.logLines,
		maxBytes: LIMITS.logBytes,
	});
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
async function read_bounded_stream(args: {
	stream: ReadableStream<Uint8Array> | null;
	maxBytes: number;
	signal?: AbortSignal;
}) {
	const { stream, maxBytes, signal } = args;

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
	const { bytes, truncated } = await read_bounded_stream({ stream: request.body, maxBytes: LIMITS.bodyBytes });
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

async function profile_encrypt(args: { key: CryptoKey; aad: Uint8Array<ArrayBuffer>; cookies: ProfileCookie[] }) {
	const { key, aad, cookies } = args;

	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plain = TEXT_ENCODER.encode(JSON.stringify({ cookies }));
	const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain);
	return { iv: bytes_base64(iv), ciphertext: bytes_base64(new Uint8Array(sealed)) };
}

async function profile_decrypt(args: { key: CryptoKey; aad: Uint8Array<ArrayBuffer>; blob: ProfileBlob }) {
	const { key, aad, blob } = args;

	const iv = base64_bytes(blob.iv);
	const sealed = base64_bytes(blob.ciphertext);
	if (!iv || !sealed) throw new Error("Browser profile is damaged.");
	const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, sealed);
	const parsed: unknown = JSON.parse(TEXT_DECODER.decode(plain));
	if (!is_record(parsed) || !Array.isArray(parsed.cookies)) throw new Error("Browser profile is damaged.");
	return parsed.cookies.filter(is_profile_cookie);
}

function is_profile_cookie(value: unknown): value is ProfileCookie {
	return (
		is_record(value) &&
		typeof value.name === "string" &&
		typeof value.value === "string" &&
		typeof value.domain === "string" &&
		typeof value.expires === "number"
	);
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
	const expiry = (cookie: ProfileCookie) =>
		cookie.session === true || cookie.expires <= 0 ? Number.MAX_VALUE : cookie.expires;
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

export async function handle_gate_request(args: {
	request: Request;
	props: BrowserConnectionGatewayProps;
	sessions: DurableObjectNamespaceStub;
}): Promise<Response> {
	const { request, props, sessions } = args;

	const check = validate_gate_request(request, props.sessionId);
	if (!check.ok) {
		log_browser({ route: "gate", refused: check.reason, commandId: props.commandId });
		return new Response("Forbidden browser request", { status: 403 });
	}

	const url = new URL("https://do/run/stream");
	for (const [name, value] of Object.entries(props)) url.searchParams.set(name, value);
	const stub = sessions.get(
		sessions.idFromName(
			session_object_name({
				ownerId: props.ownerId,
				organizationId: props.organizationId,
				workspaceId: props.workspaceId,
				mode: props.mode,
			}),
		),
	);
	return await stub.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
}

export class BrowserConnectionGateway extends WorkerEntrypoint<Env, BrowserConnectionGatewayProps> {
	async fetch(request: Request): Promise<Response> {
		return await handle_gate_request({ request, props: this.ctx.props, sessions: this.env.BROWSER_SESSIONS });
	}

	connect(): never {
		throw new Error("TCP connect is not allowed.");
	}
}

// Session transitions
//
// Pure decisions over the stored record. The object applies them; unit tests
// cover them without a provider.

function agent_lease_refusal(args: { record: SessionRecord; lease: AgentLease; ownedCommandId?: string }) {
	const { record, lease, ownedCommandId } = args;

	if (record.mode === "web") {
		const tab = lease.tabId ? record.tabs[lease.tabId] : undefined;
		if (!tab || tab.tabGen !== lease.tabGen) return "stale_tab";
		if (tab.navGen !== lease.navGen) return "stale_nav";
		if (record.policyRevision !== lease.policyRevision) return "stale_policy";
	} else if (record.navGen !== lease.navGen) return "stale_nav";
	if (record.loadGen !== lease.loadGen) return "stale_load";
	if (record.controlGen !== lease.controlGen) return "stale_control";
	if (record.control !== "ready") return "control";
	if (record.command && record.command.id !== ownedCommandId) return "busy";
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
		deadlines.push(record.command.deadline ?? record.command.startedAt + LIMITS.commandTimeoutMs + 10_000);
	}
	return Math.min(...deadlines);
}

export function session_can_run(args: {
	record: SessionRecord;
	input: { sessionId: string } & AgentLease;
	now: number;
}): { ok: true } | { ok: false; reason: string } {
	const { record, input, now } = args;

	if (record.sessionId !== input.sessionId) return { ok: false, reason: "stale_session" };
	if (record.control === "closed" || record.control === "closing") return { ok: false, reason: "closed" };
	if (session_is_expired(record, now)) return { ok: false, reason: "expired" };
	// The user turned agent access off for this web session. No new command may start.
	if (record.mode === "web" && !record.agentAccess) return { ok: false, reason: "agent_access_off" };
	if (record.mode === "web") {
		const tab = input.tabId ? record.tabs[input.tabId] : undefined;
		if (!tab || tab.tabGen !== input.tabGen) return { ok: false, reason: "stale_tab" };
		if (tab.navGen !== input.navGen) return { ok: false, reason: "stale_nav" };
		if (record.policyRevision !== input.policyRevision) return { ok: false, reason: "stale_policy" };
	} else if (record.navGen !== input.navGen) return { ok: false, reason: "stale_nav" };
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

function count_registry(
	record: RegistryRecord,
	claim: { workspaceKey: string; ownerId: string; organizationId: string },
) {
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
			return await this.claim({
				workspaceKey: body.workspaceKey,
				ownerId: body.ownerId,
				organizationId: body.organizationId,
			});
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
	return connect(`http://fake.host/v1/devtools/browser/${providerSessionId}?persistent=true&browser_binding=BROWSER`);
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
async function acquire_web_browser(
	binding: BrowserWorker,
): Promise<{ providerSessionId: string; pageTargetId: string }> {
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
		if (
			is_record(header) &&
			typeof header.name === "string" &&
			typeof header.value === "string" &&
			header.name.toLowerCase() === name
		)
			return header.value;
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
	"text/html",
	"text/plain",
	"text/css",
	"text/javascript",
	"text/xml",
	"application/xhtml+xml",
	"application/xml",
	"application/json",
	"application/javascript",
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/avif",
	"image/bmp",
	"image/x-icon",
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
		params.set(match[1]!.toLowerCase(), value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/gu, "$1") : value);
	}
	let name = "";
	const extended = /^([^']*)'[^']*'(.*)$/u.exec(params.get("filename*") ?? "");
	if (extended) {
		const charset = extended[1]!.toLowerCase();
		try {
			if (charset === "utf-8") name = decodeURIComponent(extended[2]!);
			// Latin-1 maps each byte to the same code point.
			if (charset === "iso-8859-1")
				name = extended[2]!.replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
		} catch {
			name = "";
		}
	}
	if (name === "") name = params.get("filename") ?? "";
	if (name === "" && /^https?:/iu.test(url)) {
		try {
			const segment =
				new URL(url).pathname
					.split("/")
					.filter((part) => part !== "")
					.at(-1) ?? "";
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
		const bytes = base64_bytes(
			data.replace(/%([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\s/gu, ""),
		);
		return bytes ? { contentType, bytes } : null;
	}
	const chunks = data
		.split(/(%[0-9a-fA-F]{2})/u)
		.map((part) =>
			/^%[0-9a-fA-F]{2}$/u.test(part) ? new Uint8Array([parseInt(part.slice(1), 16)]) : TEXT_ENCODER.encode(part),
		);
	return {
		contentType,
		bytes: append_bytes(
			chunks,
			chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
		),
	};
}

/**
 * Read a CDP `IO` stream in 1 MiB chunks. Stop as soon as it grows past `maxBytes`, or at the next
 * chunk after `signal` aborts.
 */
async function read_cdp_stream(args: {
	cdp: CDPSession;
	handle: string;
	maxBytes: number;
	signal: AbortSignal;
}): Promise<{ over: true } | { over: false; bytes: Uint8Array<ArrayBuffer> }> {
	const { cdp, handle, maxBytes, signal } = args;

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
 * tab, view, and `controlGen` are unchanged and it is under 5 minutes old.
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
	tabId: string;
	tabGen: number;
	viewGen: number;
	openedAt: number;
	timer: ReturnType<typeof setTimeout>;
	busy: boolean;
};

/**
 * The origin of the document that owns the chooser's input. It runs in Playwright's utility world,
 * so page scripts cannot change the answer.
 */
async function chooser_origin(chooser: FileChooser) {
	return await with_wall_timeout(
		chooser.element().evaluate((node) => node.ownerDocument?.location.origin ?? null),
		5000,
	);
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
		? (["Document", "XHR", "Fetch"] as const).map((resourceType) => ({
				urlPattern: "*",
				resourceType,
				requestStage: "Request" as const,
			}))
		: [];
	await with_wall_timeout(cdp.send("Fetch.enable", { patterns: [DOWNLOAD_FETCH_PATTERN, ...filter] }), 5000);
}

// Session object
//
// Owns one owner/organization/workspace slot: the session record, the command
// lock, generations, deadlines, and provider cleanup.

type SessionOpenInput = {
	operationId?: string;
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
	| {
			mode: "web";
			startUrl: string | null;
			agentAccess: boolean;
			profileId: string;
			profileKey: string;
			agentBlockedHosts: string[];
			policyRevision: number;
	  }
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
	tabId: string;
	title: string;
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
	 * Web mode: counts main-frame navigation. A chooser from an older page is gone.
	 */
	mainNavCount: number;
	// Initial URL replies wait for these navigation saves.
	navigationUpdates: Promise<void>;
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
	private viewerFrame: {
		seq: number;
		loadGen: number;
		tabId: string;
		tabGen: number;
		viewGen: number;
		bytes: Uint8Array<ArrayBuffer>;
	} | null = null;
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
	private hostConnections = new Map<string, HostConnection>();
	private trustedTabCreation = false;
	private deferredPages = new Set<Page>();
	private handledPopups = new WeakSet<Page>();
	private tabOperations = new Map<string, TabOperationReceipt>();
	private tabOperationsReady: Promise<void>;
	private opening: { operationId: string | null; work: Promise<Response> } | null = null;
	private commandReceipts = new Map<string, CommandReceipt>();
	private commandReceiptsReady: Promise<void>;
	private locationSeq = 0;
	private hostStart: { sessionId: string; promise: Promise<void> } | null = null;
	/**
	 * Web mode: the live session's profile key, only in memory. After a restart it is gone, and
	 * saves are skipped until the next open. `dirty` means people or the agent used the page since
	 * the last save.
	 */
	private profile: { sessionId: string; profileId: string; key: CryptoKey; dirty: boolean; savedAt: number } | null =
		null;
	/**
	 * Counts profile saves. A save only writes when no newer save started after it, so a slow
	 * periodic save cannot overwrite the End save that read a newer cookie jar.
	 */
	private profileSaveSeq = 0;
	/**
	 * Web mode: the last human click or Enter. One human download may start within 10 seconds of it.
	 */
	private humanGesture: { sessionId: string; tabId: string; at: number } | null = null;
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
		agent: {
			commandId: string;
			items: Array<{ name: string; contentType: string; bytes: Uint8Array<ArrayBuffer> }>;
			bytes: number;
			dropped: number;
		} | null;
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
	private uploadGrants = new Map<
		string,
		{
			sessionId: string;
			chooserId: string;
			controlGen: number;
			tabId: string;
			tabGen: number;
			viewGen: number;
			expiresAt: number;
		}
	>();

	constructor(state: DurableObjectStateStub, env: Env) {
		this.state = state;
		this.env = env;
		this.commandReceiptsReady = state.storage
			.get<Array<[string, CommandReceipt]>>("commandReceipts")
			.then(async (entries) => {
				this.commandReceipts = new Map(entries ?? []);
				for (const receipt of this.commandReceipts.values())
					if (receipt.status === "in_progress") receipt.status = "unknown";
				if (entries) await state.storage.put("commandReceipts", [...this.commandReceipts]);
			});
		this.tabOperationsReady = state.storage
			.get<Array<[string, TabOperationReceipt]>>("tabOperations")
			.then(async (entries) => {
				this.tabOperations = new Map(entries ?? []);
				for (const receipt of this.tabOperations.values())
					if (receipt.status === "in_progress") receipt.status = "unknown";
				if (entries) await this.state.storage.put("tabOperations", [...this.tabOperations]);
			});
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

	private public_meta(record: SessionRecord, targetTabId?: string) {
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
			const tabId = targetTabId ?? record.command?.tabId ?? record.tabId;
			const tab = record.tabs[tabId];
			return {
				mode: "web" as const,
				...shared,
				navGen: tab?.navGen ?? record.navGen,
				tabId,
				tabGen: tab?.tabGen ?? 1,
				viewedTabId: record.viewedTabId,
				viewGen: record.viewGen,
				tabCount: Object.keys(record.tabs).length,
				policyRevision: record.policyRevision,
				agentAccess: record.agentAccess,
			};
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

	private viewed_identity(record: SessionRecord) {
		return record.mode === "web"
			? { tabId: record.viewedTabId, tabGen: record.tabs[record.viewedTabId]!.tabGen, viewGen: record.viewGen }
			: { tabId: record.sessionId, tabGen: record.navGen, viewGen: record.loadGen };
	}

	private viewer_matches(input: { tabId: string; tabGen: number; viewGen: number }, record: SessionRecord) {
		const viewed = this.viewed_identity(record);
		return input.tabId === viewed.tabId && input.tabGen === viewed.tabGen && input.viewGen === viewed.viewGen;
	}

	private host_live(host: HostConnection) {
		return this.hostConnections.get(host.tabId) === host;
	}

	private async command_receipt(path: string, body: Record<string, unknown>): Promise<Response> {
		await this.commandReceiptsReady;
		if (
			!is_non_empty_string(body.sessionId) ||
			!is_non_empty_string(body.commandId) ||
			typeof body.codeHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(body.codeHash) ||
			!is_command_source(body.source) ||
			!is_positive_int(body.deadline) ||
			!is_positive_int(body.receiptResolutionDeadline) ||
			body.receiptResolutionDeadline < body.deadline ||
			body.receiptResolutionDeadline > Date.now() + 120_000
		)
			return invalid_request("A bounded command identity is required.");
		const identity = {
			sessionId: body.sessionId,
			commandId: body.commandId,
			codeHash: body.codeHash,
			source: body.source,
			deadline: body.deadline,
			receiptResolutionDeadline: body.receiptResolutionDeadline,
		};
		let receipt = this.commandReceipts.get(body.commandId);
		if (
			receipt &&
			JSON.stringify(identity) !==
				JSON.stringify({
					sessionId: receipt.sessionId,
					commandId: receipt.commandId,
					codeHash: receipt.codeHash,
					source: receipt.source,
					deadline: receipt.deadline,
					receiptResolutionDeadline: receipt.receiptResolutionDeadline,
				})
		)
			return operation_refused("command_mismatch", "The command identity changed.");
		const reply = (execute = false) =>
			json_response(
				{
					ok: true,
					execute,
					status: receipt!.status,
					commandId: receipt!.commandId,
					codeHash: receipt!.codeHash,
					session: receipt!.session,
					result: receipt!.result,
				},
				200,
			);
		if (!receipt) {
			for (const [id, entry] of this.commandReceipts)
				if (entry.result.cleanup === "complete" && entry.receiptResolutionDeadline < Date.now())
					this.commandReceipts.delete(id);
			if (this.commandReceipts.size >= 256 || byte_length(JSON.stringify([...this.commandReceipts])) > 250_000)
				return operation_refused("receipt_capacity", "Too many retained commands.");
			const execute = path === "/run/claim" && Date.now() < body.deadline;
			receipt = {
				...identity,
				payloadHash: execute && typeof body.payloadHash === "string" ? body.payloadHash : null,
				status: execute ? "in_progress" : "not_started",
				result: { cleanup: execute ? "unknown" : "complete", reason: execute ? null : "not_started" },
				session: null,
			};
			this.commandReceipts.set(body.commandId, receipt);
			await this.state.storage.put("commandReceipts", [...this.commandReceipts]);
			return reply(execute);
		}
		if (path === "/run/claim")
			return receipt.payloadHash === body.payloadHash || receipt.payloadHash === null
				? reply()
				: operation_refused("command_mismatch", "The command payload changed.");
		if (path === "/run/complete" && receipt.status === "in_progress") {
			receipt.status = body.status === "completed" || body.status === "refused" ? body.status : "unknown";
			receipt.result = {
				cleanup: body.cleanup === "complete" ? "complete" : "unknown",
				reason: typeof body.reason === "string" && /^[a-z_]{1,64}$/.test(body.reason) ? body.reason : null,
			};
			receipt.session = is_record(body.session) ? body.session : null;
			await this.state.storage.put("commandReceipts", [...this.commandReceipts]);
		}
		if (path === "/command-fence" && receipt.result.cleanup !== "complete") {
			const record = await this.load();
			if (record?.sessionId === receipt.sessionId) {
				// Closing the owned cloud browser also retires a command lost during a restart.
				const closed = await this.close_record({ record, reason: "command_fenced", saveProfile: false });
				if (closed.verified) receipt.result.cleanup = "complete";
			} else {
				const usage = await this.usage(receipt.sessionId);
				if (usage && usage.reason !== "close_unverified") receipt.result.cleanup = "complete";
			}
			receipt.status = "unknown";
			receipt.result.reason = "command_fenced";
			receipt.session = null;
			await this.state.storage.put("commandReceipts", [...this.commandReceipts]);
		}
		return reply();
	}

	private async management_receipt(path: string, body: Record<string, unknown>): Promise<Response> {
		await this.tabOperationsReady;
		if (
			!is_non_empty_string(body.operationId) ||
			body.operationId.length > 128 ||
			!is_positive_int(body.operationDeadline) ||
			body.operationDeadline > Date.now() + 120_000 ||
			(body.source !== undefined && !is_command_source(body.source))
		)
			return invalid_request("A bounded operation identity is required.");
		const record = await this.load();
		let receipt = this.tabOperations.get(body.operationId);
		const reply = (execute = false) =>
			json_response(
				{
					ok: true,
					execute,
					status: receipt!.status,
					session: receipt!.session,
					usage: receipt!.usage,
					tabs:
						record?.mode === "web" &&
						record.sessionId === receipt!.session?.sessionId &&
						record.control !== "closed" &&
						record.control !== "closing"
							? this.tab_summaries(record)
							: [],
					result: receipt!.result,
				},
				200,
			);
		if (
			receipt &&
			((body.sessionId !== undefined && receipt.sessionId !== body.sessionId) ||
				receipt.deadline !== body.operationDeadline ||
				JSON.stringify(receipt.source) !== JSON.stringify(body.source))
		)
			return operation_refused("operation_mismatch", "The operation identity changed.");
		if (!receipt) {
			for (const [id, entry] of this.tabOperations)
				if (entry.result.cleanup === "complete" && entry.deadline < Date.now()) this.tabOperations.delete(id);
			if (
				path === "/operation/claim" &&
				[...this.tabOperations.values()].some((entry) => entry.result.cleanup === "unknown")
			)
				return operation_refused("busy", "A browser operation still needs cleanup.");
			if (this.tabOperations.size >= 256 || byte_length(JSON.stringify([...this.tabOperations])) > 250_000)
				return operation_refused("receipt_capacity", "Too many retained operations.");
			const execute = path === "/operation/claim" && Date.now() < body.operationDeadline;
			receipt = {
				sessionId: typeof body.sessionId === "string" ? body.sessionId : `start:${body.operationId}`,
				deadline: body.operationDeadline,
				...(is_command_source(body.source) ? { source: body.source } : {}),
				status: execute ? "in_progress" : "unknown",
				hash: typeof body.payloadHash === "string" ? body.payloadHash : "reserved",
				session: null,
				usage: null,
				result: { tabId: null, reason: execute ? null : "not_started", cleanup: execute ? "unknown" : "complete" },
			};
			this.tabOperations.set(body.operationId, receipt);
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
			return reply(execute);
		}
		if (path === "/operation/claim" && receipt.hash !== body.payloadHash && receipt.hash !== "reserved")
			return operation_refused("operation_mismatch", "The operation payload changed.");
		if (path === "/operation/finish" && receipt.status === "in_progress") {
			receipt.status = body.status === "completed" || body.status === "refused" ? body.status : "unknown";
			receipt.session = is_record(body.session) ? body.session : null;
			receipt.result.cleanup = body.cleanup === "complete" ? "complete" : "unknown";
			receipt.result.reason =
				typeof body.reason === "string" && /^[a-z_]{1,64}$/.test(body.reason) ? body.reason : null;
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
		}
		if (path === "/operation-status" && Date.now() >= receipt.deadline && receipt.result.cleanup !== "complete") {
			receipt.status = "unknown";
			receipt.result.reason = "operation_fenced";
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
			const opening = this.opening;
			if (opening?.operationId === body.operationId) await with_wall_timeout(opening.work, 5000).catch(() => {});
			if (this.opening?.operationId !== body.operationId) {
				const current = await this.load();
				const receiptSessionId =
					typeof receipt.session?.sessionId === "string" ? receipt.session.sessionId : receipt.sessionId;
				if (current && (current.sessionId === receiptSessionId || receipt.sessionId.startsWith("start:"))) {
					receipt.session = this.public_meta(current);
					const closed = await this.close_record({ record: current, reason: "operation_fenced", saveProfile: false });
					if (closed.verified) receipt.result.cleanup = "complete";
					receipt.usage = await this.usage(current.sessionId);
				} else {
					const usage = await this.usage(receiptSessionId);
					if (usage && usage.reason !== "close_unverified") {
						receipt.result.cleanup = "complete";
						receipt.usage = usage;
					}
				}
			}
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
		}
		return reply();
	}

	private tab_summaries(record: WebSessionRecord) {
		return Object.entries(record.tabs).map(([tabId, tab]) => {
			const host = this.hostConnections.get(tabId);
			return {
				tabId,
				tabGen: tab.tabGen,
				navGen: tab.navGen,
				title: host?.title ?? "",
				url: host?.page.url().slice(0, browser_web_URL_MAX_CHARS) ?? "",
			};
		});
	}

	private async tab_operation(args: {
		path: string;
		body: Record<string, unknown>;
		inputReleased?: boolean;
	}): Promise<Response> {
		const { path, body, inputReleased = false } = args;

		await this.tabOperationsReady;
		let record = await this.load();
		if (
			!record ||
			record.mode !== "web" ||
			record.sessionId !== body.sessionId ||
			session_is_expired(record, Date.now())
		)
			return operation_refused("closed", "The web browser is unavailable.");
		if (path === "/tabs") {
			for (const tabId of Object.keys(record.tabs)) await this.connect_host(record, { closeOnFailure: true, tabId });
			return json_response({ ok: true, session: this.public_meta(record), tabs: this.tab_summaries(record) }, 200);
		}
		if (path === "/tab-select") {
			if (
				!is_non_empty_string(body.tabId) ||
				!record.tabs[body.tabId] ||
				!is_non_empty_string(body.viewerId) ||
				!record.viewers[body.viewerId] ||
				record.viewers[body.viewerId]!.grantedUntil <= Date.now()
			)
				return operation_refused("viewer", "The viewer is unavailable.");
			if (
				record.inputHolder &&
				record.viewers[record.inputHolder] &&
				record.viewers[record.inputHolder]!.grantedUntil > Date.now() &&
				record.inputHolder !== body.viewerId
			)
				return operation_refused("control", "Another viewer holds input.");
			if (!inputReleased)
				return this.with_input_released(() => this.tab_operation({ path, body, inputReleased: true }));
			if (record.viewedTabId !== body.tabId) {
				this.close_file_chooser();
				this.stop_viewer_producer();
				record.viewedTabId = body.tabId;
				record.viewGen += 1;
				record.viewport = record.tabs[body.tabId]!.viewport;
				await this.save(record);
				this.push_viewers({
					t: "tabs",
					...this.viewed_identity(record),
					viewedTabId: record.viewedTabId,
					tabs: this.tab_summaries(record),
				});
				if (this.viewerStreams.size > 0) await this.start_viewer_producer();
			}
			return json_response({ ok: true, session: this.public_meta(record), tabs: this.tab_summaries(record) }, 200);
		}
		if (
			!is_non_empty_string(body.operationId) ||
			!is_positive_int(body.operationDeadline) ||
			body.operationDeadline > Date.now() + 120_000
		)
			return invalid_request("A bounded operation id and deadline are required.");
		let receipt = this.tabOperations.get(body.operationId);
		const reply = () =>
			json_response(
				{
					ok: true,
					status: receipt!.status,
					session: receipt!.session,
					tabs: this.tab_summaries(record as WebSessionRecord),
					result: receipt!.result,
				},
				200,
			);
		if (
			receipt &&
			(receipt.sessionId !== record.sessionId ||
				receipt.deadline !== body.operationDeadline ||
				JSON.stringify(receipt.source) !== JSON.stringify(body.source))
		)
			return operation_refused("operation_mismatch", "The operation identity changed.");
		if (path === "/operation-status")
			return receipt
				? reply()
				: json_response(
						{
							ok: true,
							status: "unknown",
							session: this.public_meta(record),
							tabs: this.tab_summaries(record),
							result: { tabId: null, reason: "unknown_operation" },
						},
						200,
					);
		const hash = await crypto.subtle
			.digest(
				"SHA-256",
				TEXT_ENCODER.encode(JSON.stringify([path, body.tabId, body.url, body.expectedAgentLease, body.policyRevision])),
			)
			.then((bytes) => bytes_base64(new Uint8Array(bytes)));
		receipt = this.tabOperations.get(body.operationId);
		if (receipt)
			return receipt.hash === hash
				? reply()
				: operation_refused("operation_mismatch", "The operation payload changed.");
		if (Date.now() >= body.operationDeadline) return operation_refused("expired", "The operation deadline passed.");
		for (const [id, entry] of this.tabOperations)
			if (entry.result.cleanup === "complete" && entry.deadline < Date.now()) this.tabOperations.delete(id);
		if ([...this.tabOperations.values()].some((entry) => entry.result.cleanup === "unknown"))
			return operation_refused("busy", "A browser operation still needs cleanup.");
		if (this.tabOperations.size >= 256 || byte_length(JSON.stringify([...this.tabOperations])) > 250_000)
			return operation_refused("receipt_capacity", "Too many retained operations.");
		receipt = {
			sessionId: record.sessionId,
			deadline: body.operationDeadline,
			...(is_command_source(body.source) ? { source: body.source } : {}),
			status: "in_progress",
			hash,
			session: null,
			usage: null,
			result: { tabId: null, reason: null, cleanup: "unknown" },
		};
		this.tabOperations.set(body.operationId, receipt);
		await this.state.storage.put("tabOperations", [...this.tabOperations]);
		const refuse = async (reason: string) => {
			receipt!.status = "refused";
			receipt!.result.reason = reason;
			receipt!.result.cleanup = "complete";
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
			return reply();
		};
		if (record.command || this.trustedTabCreation) return refuse("busy");
		if (body.expectedAgentLease !== undefined) {
			if (!is_agent_lease(body.expectedAgentLease)) return refuse("invalid_lease");
			const reason = agent_lease_refusal({ record, lease: body.expectedAgentLease });
			if (reason || !record.agentAccess) return refuse(reason ?? "agent_access_off");
		} else if (record.control !== "ready" && (record.control !== "human" || body.viewerId !== record.inputHolder))
			return refuse("control");
		if (body.policyRevision !== record.policyRevision) return refuse("stale_policy");
		if (!inputReleased) {
			// The reserved receipt prevents a lost reply from repeating this operation.
			return this.with_input_released(async () => {
				const current = await this.load();
				if (
					!current ||
					current.mode !== "web" ||
					current.sessionId !== record!.sessionId ||
					current.command ||
					current.controlGen !== record!.controlGen
				)
					return refuse("stale_control");
				if (session_is_expired(current, Date.now())) return refuse("expired");
				if (is_agent_lease(body.expectedAgentLease)) {
					const reason = agent_lease_refusal({ record: current, lease: body.expectedAgentLease });
					if (reason) return refuse(reason);
				}
				if (body.policyRevision !== current.policyRevision || (body.expectedAgentLease && !current.agentAccess))
					return refuse("stale_policy");
				record = current;
				return this.apply_tab_operation({ path, body, record: current, receipt: receipt! });
			});
		}
		return this.apply_tab_operation({ path, body, record, receipt });
	}

	private async apply_tab_operation(args: {
		path: string;
		body: Record<string, unknown>;
		record: WebSessionRecord;
		receipt: TabOperationReceipt;
	}) {
		let { path, body, record, receipt } = args;

		const lock = `tabs:${String(body.operationId)}`;
		record.command = { id: lock, startedAt: Date.now(), deadline: body.operationDeadline as number };
		await this.save(record);
		let preNativeRefusal: string | null = null;
		let createdPage: Page | null = null;
		let createdTargetId: string | null = null;
		let createdTabId: string | null = null;
		const refuseBeforeNative = (reason: string): never => {
			preNativeRefusal = reason;
			throw new Error(reason);
		};
		// Provider attach can outlive the user's access or the session deadline.
		const tab_authority_refusal = (current: SessionRecord | null, afterNew = false) => {
			if (!current || current.mode !== "web" || current.sessionId !== record.sessionId || current.command?.id !== lock)
				return "stale_session";
			if (session_is_expired(current, Date.now()) || Date.now() >= receipt.deadline || receipt.status !== "in_progress")
				return "expired";
			if (body.expectedAgentLease !== undefined) {
				if (!is_agent_lease(body.expectedAgentLease)) return "invalid_lease";
				if (afterNew && current.controlGen !== record.controlGen) return "stale_control";
				// New already bumped controlGen for its own tab.
				const lease = afterNew
					? { ...body.expectedAgentLease, controlGen: record.controlGen }
					: body.expectedAgentLease;
				const reason = agent_lease_refusal({ record: current, lease, ownedCommandId: lock });
				if (reason || !current.agentAccess) return reason ?? "agent_access_off";
			} else {
				if (
					current.controlGen !== record.controlGen ||
					(current.control !== "ready" && (current.control !== "human" || body.viewerId !== current.inputHolder))
				)
					return "stale_control";
				if (
					current.control === "human" &&
					(typeof body.viewerId !== "string" ||
						!current.viewers[body.viewerId] ||
						current.viewers[body.viewerId]!.grantedUntil <= Date.now())
				)
					return "viewer";
			}
			if (body.policyRevision !== current.policyRevision) return "stale_policy";
			return null;
		};
		const check_native_tab_authority = async (afterNew = false) => {
			const current = await this.load();
			if (current?.mode !== "web") {
				if (afterNew) throw new Error("stale_session");
				return refuseBeforeNative("stale_session");
			}
			const reason = tab_authority_refusal(current, afterNew);
			if (reason) {
				if (afterNew) throw new Error(reason);
				return refuseBeforeNative(reason);
			}
			return current;
		};
		try {
			if (Date.now() >= receipt.deadline || receipt.status !== "in_progress") throw new Error("operation_fenced");
			if (path === "/tab-new") {
				if (Object.keys(record.tabs).length >= LIMITS.webTabs) throw new Error("tab_limit");
				const address =
					body.url === null
						? null
						: typeof body.url === "string"
							? browser_web_normalize_url(body.url, [
									...web_denied_hosts(this.env),
									...(body.expectedAgentLease ? record.agentBlockedHosts : []),
								])
							: { ok: false as const };
				if (address !== null && !address.ok) throw new Error("address_blocked");
				await this.connect_host(record);
				record = await check_native_tab_authority();
				if (Object.keys(record.tabs).length >= LIMITS.webTabs) return refuseBeforeNative("tab_limit");
				const host = this.hostConnection;
				if (!host) throw new Error("not_ready");
				this.trustedTabCreation = true;
				const page = await with_wall_timeout(host.page.context().newPage(), 10_000);
				createdPage = page;
				const cdp = await page.context().newCDPSession(page);
				const target: unknown = await cdp.send("Target.getTargetInfo");
				await cdp.detach();
				if (!is_record(target) || !is_record(target.targetInfo) || !is_non_empty_string(target.targetInfo.targetId))
					throw new Error("invalid_target");
				createdTargetId = target.targetInfo.targetId;
				const current = await this.load();
				if (
					!current ||
					current.mode !== "web" ||
					current.sessionId !== record.sessionId ||
					current.command?.id !== lock ||
					Date.now() >= receipt.deadline ||
					receipt.status !== "in_progress"
				)
					throw new Error("stale_session");
				record = current;
				const tabId = crypto.randomUUID();
				createdTabId = tabId;
				record.tabs[tabId] = {
					targetId: target.targetInfo.targetId,
					tabGen: 1,
					navGen: 1,
					viewport: { width: 1280, height: 900 },
				};
				receipt.result.tabId = tabId;
				record.controlGen += 1;
				await this.save(record);
				await this.connect_host(record, { closeOnFailure: true, tabId });
				record = await check_native_tab_authority(true);
				const added = this.hostConnections.get(tabId);
				if (!added) throw new Error("not_ready");
				if (address?.ok) {
					const currentAddress = browser_web_normalize_url(body.url as string, [
						...web_denied_hosts(this.env),
						...(body.expectedAgentLease ? record.agentBlockedHosts : []),
					]);
					if (!currentAddress.ok) throw new Error("address_blocked");
					await with_wall_timeout(
						added.page
							.goto(currentAddress.url, { waitUntil: "commit", timeout: LIMITS.navWallMs })
							.then(() => added.navigationUpdates),
						LIMITS.navWallMs,
					);
				}
			} else {
				if (!is_non_empty_string(body.tabId) || !record.tabs[body.tabId]) throw new Error("stale_tab");
				const tabId = body.tabId;
				receipt.result.tabId = tabId;
				if (Object.keys(record.tabs).length === 1) {
					record = await check_native_tab_authority();
					const closed = await this.close_record({
						record,
						reason: body.expectedAgentLease ? "agent_end" : "human_end",
						saveProfile: !body.expectedAgentLease,
						beforeClose: body.expectedAgentLease ? tab_authority_refusal : undefined,
					});
					if (closed.refusal || !closed.existed) return refuseBeforeNative(closed.refusal ?? "stale_session");
					if (!closed.verified) throw new Error("close_unverified");
				} else {
					const targetId = record.tabs[tabId]!.targetId;
					const tabGen = record.tabs[tabId]!.tabGen;
					await this.connect_host(record, { closeOnFailure: true, tabId });
					record = await check_native_tab_authority();
					if (record.tabs[tabId]?.targetId !== targetId || record.tabs[tabId]?.tabGen !== tabGen)
						return refuseBeforeNative("stale_tab");
					const host = this.hostConnections.get(tabId)!;
					if (this.chooser?.host === host) this.close_file_chooser();
					if (record.viewedTabId === tabId) this.stop_viewer_producer();
					await with_wall_timeout(host.page.close(), 10_000);
					const targets: unknown = await host.browserCdp.send("Target.getTargets");
					if (
						!is_record(targets) ||
						!Array.isArray(targets.targetInfos) ||
						targets.targetInfos.some((target) => is_record(target) && target.targetId === targetId)
					)
						throw new Error("target_not_closed");
					// Off and End may finish while the native close waits.
					const current = await this.load();
					if (
						!current ||
						current.mode !== "web" ||
						current.sessionId !== record.sessionId ||
						current.command?.id !== lock ||
						current.control === "closing" ||
						current.control === "closed" ||
						current.tabs[tabId]?.targetId !== targetId ||
						current.tabs[tabId]?.tabGen !== tabGen
					)
						throw new Error("stale_session");
					record = current;
					delete record.tabs[tabId];
					this.hostConnections.delete(tabId);
					const next = Object.keys(record.tabs)[0]!;
					if (record.tabId === tabId) record.tabId = next;
					if (record.viewedTabId === tabId) {
						record.viewedTabId = next;
						record.viewGen += 1;
						record.viewport = record.tabs[next]!.viewport;
					}
					record.controlGen += 1;
					await this.save(record);
				}
			}
			if (Date.now() >= receipt.deadline || receipt.status !== "in_progress") throw new Error("operation_fenced");
			receipt.status = "completed";
			receipt.result.cleanup = "complete";
		} catch (error) {
			receipt.status = "unknown";
			receipt.result.reason =
				preNativeRefusal ??
				(error instanceof Error && ["tab_limit", "address_blocked", "stale_tab"].includes(error.message)
					? error.message
					: "outcome_unknown");
			if (receipt.result.reason !== "outcome_unknown" && !createdPage) {
				receipt.status = "refused";
				receipt.result.cleanup = "complete";
			} else if (createdPage) {
				receipt.result.reason = "outcome_unknown";
				// New owns this page, not the browser or its older tabs.
				try {
					await with_wall_timeout(createdPage.close(), 10_000);
					const host = [...this.hostConnections.values()].find((item) => item.sessionId === record.sessionId);
					const targets: unknown = await host?.browserCdp.send("Target.getTargets");
					if (
						!createdPage.isClosed() ||
						!is_record(targets) ||
						!Array.isArray(targets.targetInfos) ||
						(createdTargetId &&
							targets.targetInfos.some((target) => is_record(target) && target.targetId === createdTargetId))
					)
						throw new Error("target_not_closed");
					if (createdTabId) {
						const current = await this.load();
						if (
							current?.mode !== "web" ||
							current.sessionId !== record.sessionId ||
							current.command?.id !== lock ||
							current.tabs[createdTabId]?.targetId !== createdTargetId
						)
							throw new Error("stale_tab");
						delete current.tabs[createdTabId];
						this.hostConnections.delete(createdTabId);
						const next = Object.keys(current.tabs)[0]!;
						if (current.tabId === createdTabId) current.tabId = next;
						if (current.viewedTabId === createdTabId) {
							current.viewedTabId = next;
							current.viewGen += 1;
							current.viewport = current.tabs[next]!.viewport;
						}
						current.controlGen += 1;
						await this.save(current);
						record = current;
					}
					if (this.hostConnection?.page === createdPage)
						this.hostConnection = this.hostConnections.get(record.tabId) ?? null;
					this.deferredPages.delete(createdPage);
					receipt.result.tabId = null;
					receipt.result.cleanup = "complete";
				} catch {
					/* Keep the unknown receipt when exact cleanup is unproved. */
				}
			} else if ((await this.close_record({ record, reason: "tab_operation_failed", saveProfile: false })).verified)
				receipt.result.cleanup = "complete";
		} finally {
			this.trustedTabCreation = false;
			for (const page of this.deferredPages)
				if (![...this.hostConnections.values()].some((host) => host.page === page)) await page.close().catch(() => {});
			this.deferredPages.clear();
			const current = await this.load();
			if (current?.mode === "web" && current.sessionId === record.sessionId && current.command?.id === lock) {
				current.command = null;
				if (!session_is_expired(current, Date.now())) current.lastActiveAt = Date.now();
				record = current;
				await this.save(current);
				this.push_viewers({
					t: "tabs",
					...this.viewed_identity(current),
					viewedTabId: current.viewedTabId,
					tabs: this.tab_summaries(current),
				});
				if (this.viewerStreams.size > 0) await this.start_viewer_producer().catch(() => {});
			}
			const finished = await this.load();
			receipt.session =
				finished?.sessionId === record.sessionId && finished.control !== "closing" && finished.control !== "closed"
					? this.public_meta(finished)
					: null;
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
		}
		return json_response(
			{
				ok: true,
				status: receipt.status,
				session: receipt.session,
				tabs: receipt.session ? this.tab_summaries(record) : [],
				result: receipt.result,
			},
			200,
		);
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
			const cookies = await profile_decrypt({
				key: profile.key,
				aad: profile_aad(profile.profileId, record),
				blob: stored,
			});
			// Without `browserContextId`: the page lives in the default context (checked live on 2026-09-23).
			if (cookies.length > 0)
				await with_wall_timeout(host.browserCdp.send("Storage.setCookies", { cookies }), LIMITS.profileCdpMs);
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
	private should_save(args: { record: SessionRecord; reason: string; saveProfile: boolean | undefined }) {
		const { record, reason, saveProfile } = args;

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
			const { cookies, truncated } = profile_cookies_to_save(
				is_record(reply) ? reply.cookies : null,
				web_denied_hosts(this.env),
			);
			const sealed = await profile_encrypt({ key: profile.key, aad: profile_aad(profile.profileId, record), cookies });

			// A `profile-delete` may have run during the awaits above. Check its tombstone and the
			// record right before the put, with storage reads only. The object holds other events
			// while storage reads run, so nothing can slip in between these reads and the put.
			const [deletedAt, current] = await Promise.all([
				this.state.storage.get<number>(`${PROFILE_DELETED_KEY_PREFIX}${profile.profileId}`),
				this.state.storage.get<SessionRecord>(SESSION_KEY),
			]);
			if (
				deletedAt !== undefined ||
				current?.sessionId !== record.sessionId ||
				current.mode !== "web" ||
				current.profileId !== profile.profileId
			) {
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
	private async main_page_blocked(record: WebSessionRecord, tabId?: string): Promise<boolean> {
		await with_wall_timeout(this.connect_host(record, { closeOnFailure: true, tabId }), 10_000);
		const host = this.hostConnection;
		if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
		const history: unknown = await with_wall_timeout(host.cdp.send("Page.getNavigationHistory"), 5000);
		if (!is_record(history) || !Array.isArray(history.entries) || typeof history.currentIndex !== "number") {
			throw new Error("Browser history is unavailable.");
		}
		const entry: unknown = history.entries[history.currentIndex];
		return (
			is_record(entry) &&
			typeof entry.url === "string" &&
			browser_web_url_host_matches(entry.url, record.agentBlockedHosts)
		);
	}

	/**
	 * Turn the blocked-site request filter on for an agent command, or off after it. It fails page,
	 * XHR, and fetch requests to blocked sites at the request stage. This is best effort: other
	 * request types and cross-site frames are not covered.
	 */
	private async set_agent_site_filter(sessionId: string, on: boolean): Promise<void> {
		const record = await this.load();
		if (record?.sessionId !== sessionId || record.mode !== "web") throw new Error("Browser session changed.");
		for (const tabId of Object.keys(record.tabs)) await this.connect_host(record, { closeOnFailure: true, tabId });
		await Promise.all(
			[...this.hostConnections.values()]
				.filter((host) => host.sessionId === sessionId)
				.map((host) => set_fetch_patterns(host.cdp, on)),
		);
	}

	private async open_reserved(input: SessionOpenInput): Promise<Response> {
		await this.tabOperationsReady;
		if (this.opening) return operation_refused("busy", "A browser is starting.");
		const receipt = input.operationId ? this.tabOperations.get(input.operationId) : null;
		if (input.operationId && (!receipt || receipt.status !== "in_progress" || Date.now() >= receipt.deadline))
			return operation_refused("operation_fenced", "The open request is retired.");
		if ([...this.tabOperations.values()].some((entry) => entry !== receipt && entry.result.cleanup === "unknown"))
			return operation_refused("busy", "A browser operation still needs cleanup.");
		const work = this.open(input).then(async (response) => {
			if (!receipt) return response;
			const result: unknown = await response.clone().json();
			if (is_record(result) && is_record(result.session)) receipt.session = result.session;
			if (receipt.status !== "in_progress" || Date.now() >= receipt.deadline) {
				receipt.status = "unknown";
				receipt.result.reason = "operation_fenced";
				const current = await this.load();
				if (current && current.sessionId === receipt.session?.sessionId) {
					const closed = await this.close_record({ record: current, reason: "operation_fenced", saveProfile: false });
					receipt.result.cleanup = closed.verified ? "complete" : "unknown";
					receipt.usage = await this.usage(current.sessionId);
				} else if (
					is_record(result) &&
					result.ok === false &&
					result.verified !== false &&
					(!is_record(result.error) || result.error.code !== "bootstrap_failed")
				)
					receipt.result.cleanup = "complete";
				await this.state.storage.put("tabOperations", [...this.tabOperations]);
				return operation_refused("operation_fenced", "The open request is retired.");
			}
			await this.state.storage.put("tabOperations", [...this.tabOperations]);
			return response;
		});
		const opening = { operationId: input.operationId ?? null, work };
		this.opening = opening;
		try {
			return await work;
		} finally {
			if (this.opening === opening) this.opening = null;
		}
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
			const staleStarting = existing.control === "starting" && now - existing.createdAt >= LIMITS.startingStaleMs;
			if (!staleStarting) {
				log_browser({ route: "open", refused: "busy", control: existing.control });
				return operation_refused("busy", "A browser is already active for this workspace.");
			}
			// A stale start never finished bootstrap. Close its known
			// provider session, then take over the slot.
			await this.close_record({ record: existing, reason: "stale_start" });
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
			return json_response({ ok: false, error: { code: "bootstrap_failed", message: failure.message } }, 200);
		}

		return json_response({ ok: true, session: this.public_meta(record) }, 200);
	}

	/**
	 * Open a web session. Acquire first, save the record as `starting`, connect the host,
	 * open the start address, then mark the session ready.
	 */
	private async open_web(
		input: Extract<SessionOpenInput, { mode: "web" }>,
		startUrl: string | null,
	): Promise<Response> {
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
		const tabId = crypto.randomUUID();
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
			tabs: { [tabId]: { targetId: acquired.pageTargetId, tabGen: 1, navGen: 1, viewport: input.viewport } },
			tabId,
			viewedTabId: tabId,
			viewGen: 1,
			policyRevision: input.policyRevision,
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
				await with_wall_timeout(
					host.page.goto(startUrl, { waitUntil: "commit", timeout: LIMITS.openNavWallMs }),
					LIMITS.openNavWallMs,
				).catch(() => {});
				await with_wall_timeout(host.navigationUpdates, LIMITS.navWallMs);
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
			if (current?.sessionId === sessionId && current.control !== "closing")
				await this.close_record({ record: current, reason: "open_failed" });
			log_browser({ route: "open", refused: "bootstrap_failed", attemptId: input.attemptId });
			return json_response({ ok: false, error: { code: "bootstrap_failed", message: failure.message } }, 200);
		}
	}

	/**
	 * `closeOnFailure: false` is for the profile save inside `close_record`: a failed connect there
	 * must not start a second close.
	 */
	private async connect_host(
		record: SessionRecord,
		options: { closeOnFailure: boolean; tabId?: string } = { closeOnFailure: true },
	): Promise<void> {
		const tabId = record.mode === "web" ? (options.tabId ?? record.command?.tabId ?? record.tabId) : record.sessionId;
		if (this.hostStart?.sessionId === record.sessionId) {
			await this.hostStart.promise;
			return this.connect_host(record, options);
		}
		const known = this.hostConnections.get(tabId);
		if (known?.sessionId === record.sessionId) {
			this.hostConnection = known;
			return;
		}
		const start = (async () => {
			if (!record.providerSessionId) throw new Error("Browser is unavailable.");
			const browser =
				[...this.hostConnections.values()].find((host) => host.sessionId === record.sessionId)?.browser ??
				(await connect_persistent(record.providerSessionId));
			let phase = "target";
			try {
				const current = await this.load();
				if (
					!current ||
					current.sessionId !== record.sessionId ||
					current.control === "closing" ||
					current.control === "closed"
				) {
					throw new Error("Browser session changed.");
				}
				const contexts = browser.contexts();
				const candidates = contexts[0]?.pages() ?? [];
				if (contexts.length !== 1 || (record.mode === "file" && candidates.length !== 1)) {
					throw new Error("Unexpected browser targets.");
				}
				// File mode has one page. Web mode picks its registered tab.
				// The target check below closes unregistered pages.
				let picked: { page: Page; cdp: CDPSession; targetId: string; browserContextId: string | undefined } | null =
					null;
				for (const candidate of candidates) {
					const candidateCdp = await candidate.context().newCDPSession(candidate);
					const info: unknown = await candidateCdp.send("Target.getTargetInfo");
					if (
						!is_record(info) ||
						!is_record(info.targetInfo) ||
						!is_non_empty_string(info.targetInfo.targetId) ||
						(info.targetInfo.browserContextId !== undefined && typeof info.targetInfo.browserContextId !== "string")
					) {
						throw new Error("Browser target is unavailable.");
					}
					if (record.mode === "file" || info.targetInfo.targetId === record.tabs[tabId]?.targetId) {
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
				if (
					!is_record(inventory) ||
					!Array.isArray(inventory.browserContextIds) ||
					inventory.browserContextIds.some((id) => typeof id !== "string")
				)
					throw new Error("Browser contexts are unavailable.");
				// getBrowserContexts lists explicit contexts; omit the default context id.
				const contextId = inventory.browserContextIds.includes(picked.browserContextId ?? "")
					? picked.browserContextId
					: undefined;
				phase = "downloads";
				// Chrome never saves a file. Web mode turns events on: downloads that skip the network
				// still report `Browser.downloadWillBegin`, and the safety net below reads them.
				await browserCdp.send("Browser.setDownloadBehavior", {
					behavior: "deny",
					eventsEnabled: record.mode === "web",
					...(contextId ? { browserContextId: contextId } : {}),
				});
				const latest = await this.load();
				if (
					!latest ||
					latest.sessionId !== record.sessionId ||
					latest.control === "closing" ||
					latest.control === "closed"
				) {
					throw new Error("Browser session changed.");
				}
				const host = {
					sessionId: record.sessionId,
					tabId,
					title: "",
					browser,
					page,
					cdp,
					browserCdp,
					targetId: picked.targetId,
					contextId,
					loading: false,
					mainNavCount: 0,
					navigationUpdates: Promise.resolve(),
				};
				this.hostConnection = host;
				this.hostConnections.set(tabId, host);
				// Page timers can outlive a command, so target checks stay on this connection.
				// Web pages navigate freely, so only file mode closes on a main-frame navigation.
				if (record.mode === "file") {
					page.on("framenavigated", (frame) => {
						if (!this.host_live(host) || frame !== page.mainFrame()) return;
						const command = this.viewerRecord?.command;
						if (command && command.connection === undefined && frame.url() === CONTROLLER_URL) return;
						this.agentConnection?.bridge?.revoke();
						this.state.waitUntil(
							this.load().then(async (current) => {
								if (current?.sessionId === host.sessionId)
									await this.close_record({ record: current, reason: "page_navigated" });
							}),
						);
					});
				}
				page.context().on("page", (popup) => {
					if (!this.host_live(host) || popup === page) return;
					if ([...this.hostConnections.values()].some((known) => known.page === popup)) return;
					if (this.trustedTabCreation) {
						this.deferredPages.add(popup);
						return;
					}
					if (record.mode === "web") {
						this.state.waitUntil(this.handle_web_popup(host, popup));
						return;
					}
					this.state.waitUntil(
						popup.close().catch(async () => {
							if (popup.isClosed()) return;
							const current = await this.load();
							if (current?.sessionId === host.sessionId)
								await this.close_record({ record: current, reason: "popup_cleanup_failed" });
						}),
					);
				});
				if (record.mode === "web") {
					// Navigation does not touch idle: only people and agent commands keep a session open.
					const navigated = () => {
						if (!this.host_live(host)) return;
						// A file chooser belongs to the page that opened it.
						host.mainNavCount += 1;
						host.navigationUpdates = host.navigationUpdates.then(async () => {
							const current = await this.load();
							if (current?.mode !== "web" || current.sessionId !== host.sessionId || !current.tabs[host.tabId]) return;
							current.tabs[host.tabId]!.tabGen += 1;
							current.tabs[host.tabId]!.navGen += 1;
							await this.save(current);
							this.push_viewers({ t: "tabs", viewedTabId: current.viewedTabId, tabs: this.tab_summaries(current) });
							this.push_location(host);
						});
						this.state.waitUntil(host.navigationUpdates);
						if (this.chooser?.host === host) this.close_file_chooser();
					};
					// goto() and this listener observe the same trusted navigation event.
					page.on("framenavigated", (frame) => {
						if (frame === page.mainFrame()) navigated();
					});
					cdp.on("Page.frameStartedLoading", (event: unknown) => {
						if (!this.host_live(host) || !is_record(event) || event.frameId !== host.targetId) return;
						host.loading = true;
						this.push_location(host);
					});
					cdp.on("Page.frameStoppedLoading", (event: unknown) => {
						if (!this.host_live(host) || !is_record(event) || event.frameId !== host.targetId) return;
						host.loading = false;
						this.push_location(host);
					});
					// Playwright's `filechooser` event covers a chooser with an input element. Without one
					// (for example a picker with no input) there is nothing to fill.
					cdp.on("Page.fileChooserOpened", (event: unknown) => {
						if (!this.host_live(host) || !is_record(event) || event.backendNodeId !== undefined) return;
						if (!this.viewerRecord?.command) this.push_viewers({ t: "notice", code: "upload_unsupported" });
					});
					page.on("filechooser", (chooser: FileChooser) => {
						if (!this.host_live(host)) return;
						this.state.waitUntil(
							this.open_file_chooser(host, chooser).catch((error: unknown) => {
								log_browser({ route: "file_chooser", sessionId: host.sessionId, error: sanitize_error(error).name });
							}),
						);
					});
					// `Fetch` pauses every page load at the response stage to catch downloads. Agent
					// commands add request-stage pauses so requests to the user's blocked sites fail.
					cdp.on("Fetch.requestPaused", (event: unknown) => {
						if (!is_record(event) || !is_non_empty_string(event.requestId)) return;
						this.state.waitUntil(
							this.answer_fetch_pause({
								host,
								blockedHosts: this.viewerRecord?.mode === "web" ? this.viewerRecord.agentBlockedHosts : [],
								event,
								requestId: event.requestId,
							}),
						);
					});
					browserCdp.on("Browser.downloadWillBegin", (event: unknown) => {
						if (!this.host_live(host) || !is_record(event)) return;
						const running: Promise<void> = this.capture_safety_net_download(host, event)
							.catch((error: unknown) => {
								log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
							})
							.finally(() => this.safetyNetDownloads.delete(running));
						this.safetyNetDownloads.add(running);
						this.state.waitUntil(running);
					});
					phase = "page_events";
					await cdp.send("Page.enable");
					browserCdp.on("Target.targetInfoChanged", (event: unknown) => {
						if (
							!this.host_live(host) ||
							!is_record(event) ||
							!is_record(event.targetInfo) ||
							event.targetInfo.targetId !== host.targetId
						)
							return;
						host.title =
							typeof event.targetInfo.title === "string" ? event.targetInfo.title.slice(0, LIMITS.titleChars) : "";
						if (this.viewerRecord?.mode === "web")
							this.push_viewers({
								t: "tabs",
								viewedTabId: this.viewerRecord.viewedTabId,
								tabs: this.tab_summaries(this.viewerRecord),
							});
					});
					await browserCdp.send("Target.setDiscoverTargets", { discover: true });
					await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
					await set_fetch_patterns(cdp, false);
				}
				browser.on("disconnected", () => {
					if (!this.host_live(host)) return;
					this.hostConnection = null;
					this.state.waitUntil(
						this.load().then(async (current) => {
							if (current?.sessionId === host.sessionId)
								await this.close_record({ record: current, reason: "host_disconnected" });
						}),
					);
				});
				// Reconnect can miss targets created before these listeners were installed.
				phase = "target_check";
				const [checkedContexts, checkedTargets] = await Promise.all([
					browserCdp.send("Target.getBrowserContexts"),
					browserCdp.send("Target.getTargets"),
				]);
				const contextIds: unknown = checkedContexts.browserContextIds;
				const targetInfos: unknown = checkedTargets.targetInfos;
				if (
					!Array.isArray(contextIds) ||
					contextIds.some((id) => typeof id !== "string" || id !== contextId) ||
					!Array.isArray(targetInfos)
				)
					throw new Error("Unexpected browser targets.");
				const pages = targetInfos.filter((target: unknown) => is_record(target) && target.type === "page");
				if (record.mode === "web") {
					const registered = new Set(Object.values(record.tabs).map((tab) => tab.targetId));
					if ([...registered].some((id) => !pages.some((target) => is_record(target) && target.targetId === id))) {
						throw new Error("Unexpected browser targets.");
					}
					for (const target of pages) {
						if (!is_record(target) || !is_non_empty_string(target.targetId))
							throw new Error("Unexpected browser targets.");
						if (registered.has(target.targetId)) continue;
						const closed: unknown = await browserCdp.send("Target.closeTarget", { targetId: target.targetId });
						if (!is_record(closed) || closed.success !== true) throw new Error("Unexpected browser targets.");
					}
					const verified: unknown = await browserCdp.send("Target.getTargets");
					if (!is_record(verified) || !Array.isArray(verified.targetInfos))
						throw new Error("Unexpected browser targets.");
					const remaining = verified.targetInfos.filter((target) => is_record(target) && target.type === "page");
					if (
						remaining.length !== registered.size ||
						remaining.some((target) => !registered.has(String(target.targetId)))
					)
						throw new Error("Unexpected browser targets.");
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
				if (
					!this.host_live(host) ||
					checked?.sessionId !== record.sessionId ||
					checked.control === "closing" ||
					checked.control === "closed"
				)
					throw new Error("Browser session changed.");
			} catch (error) {
				log_browser({ route: "host_connect", phase, error: sanitize_error(error).name });
				if (this.hostConnection?.sessionId === record.sessionId) this.hostConnection = null;
				const current = await this.load();
				if (options.closeOnFailure && current?.sessionId === record.sessionId)
					await this.close_record({ record: current, reason: "host_setup_failed" });
				await browser.close().catch(() => {});
				throw error;
			}
		})();
		const pending = {
			sessionId: record.sessionId,
			promise: start.finally(() => {
				if (this.hostStart === pending) this.hostStart = null;
			}),
		};
		this.hostStart = pending;
		return pending.promise;
	}

	/**
	 * Send one JSON message to every attached viewer.
	 */
	private push_viewers(message: Record<string, unknown>): void {
		const text = JSON.stringify({ ...(this.viewerRecord ? this.viewed_identity(this.viewerRecord) : {}), ...message });
		for (const stream of this.viewerStreams.values()) {
			try {
				stream.socket.send(text);
			} catch {
				this.end_viewer({ stream, code: 1011, reason: "socket error" });
			}
		}
	}

	/**
	 * Web mode: send the current address, title, and history state to the viewers.
	 */
	private push_location(host: HostConnection): void {
		if (this.viewerStreams.size === 0) return;
		if (this.viewerRecord?.mode === "web" && this.viewerRecord.viewedTabId !== host.tabId) return;
		// Reads can finish out of order. Only the newest read may send.
		const seq = ++this.locationSeq;
		this.state.waitUntil(
			(async () => {
				const history: unknown = await host.cdp.send("Page.getNavigationHistory");
				if (
					seq !== this.locationSeq ||
					!this.host_live(host) ||
					!is_record(history) ||
					!Array.isArray(history.entries) ||
					typeof history.currentIndex !== "number"
				)
					return;
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
			})().catch(() => {}),
		);
	}

	/**
	 * Human popups become registered tabs. Agent popups are closed.
	 */
	private async handle_web_popup(host: HostConnection, popup: Page): Promise<void> {
		if (this.handledPopups.has(popup)) return;
		const opener = await popup.opener().catch(() => null);
		if (opener !== host.page && [...this.hostConnections.values()].some((item) => item.page === opener)) return;
		this.handledPopups.add(popup);
		const close = () =>
			popup.close().catch(async () => {
				if (popup.isClosed()) return;
				const current = await this.load();
				if (current?.sessionId === host.sessionId)
					await this.close_record({ record: current, reason: "popup_cleanup_failed" });
			});
		if (opener !== host.page) {
			await close();
			this.push_viewers({ t: "notice", code: "popup_closed" });
			return;
		}

		const gesture = this.humanGesture;
		if (
			this.viewerRecord?.command ||
			this.viewerRecord?.control !== "human" ||
			this.viewerRecord.mode !== "web" ||
			this.viewerRecord.viewedTabId !== host.tabId ||
			!gesture ||
			gesture.tabId !== host.tabId ||
			Date.now() - gesture.at > 10_000
		) {
			await close();
			this.push_viewers({ t: "notice", code: "popup_closed" });
			return;
		}

		// `window.open` first shows about:blank. Wait a little for the real address.
		const blank = (url: string) => url === "" || url === "about:blank";
		if (blank(popup.url())) {
			await popup
				.waitForURL((next) => !blank(next.href), { waitUntil: "commit", timeout: LIMITS.popupUrlWaitMs })
				.catch(() => {});
		}
		const url = popup.isClosed() ? "" : popup.url();
		if (!this.host_live(host)) {
			await close();
			return;
		}
		if (blank(url) || this.viewerRecord?.command) {
			await close();
			this.push_viewers({ t: "notice", code: "popup_closed" });
			return;
		}
		const normalized = browser_web_normalize_url(url, web_denied_hosts(this.env));
		if (!normalized.ok) {
			await close();
			log_browser({ route: "popup", refused: normalized.reason });
			this.push_viewers({ t: "notice", code: "address_blocked" });
			return;
		}
		await this.with_input_released(async () => {
			const current = await this.load();
			if (
				current?.mode !== "web" ||
				current.sessionId !== host.sessionId ||
				current.command ||
				current.control !== "human" ||
				current.viewedTabId !== host.tabId ||
				Object.keys(current.tabs).length >= LIMITS.webTabs
			) {
				await close();
				return operation_refused("popup_closed", "The popup is unavailable.");
			}
			current.command = { id: `popup:${crypto.randomUUID()}`, startedAt: Date.now() };
			await this.save(current);
			try {
				const cdp = await popup.context().newCDPSession(popup);
				const target: unknown = await cdp.send("Target.getTargetInfo");
				await cdp.detach();
				if (!is_record(target) || !is_record(target.targetInfo) || !is_non_empty_string(target.targetInfo.targetId))
					throw new Error("invalid_target");
				const record = await this.load();
				if (
					record?.mode !== "web" ||
					record.sessionId !== current.sessionId ||
					record.command?.id !== current.command!.id
				)
					throw new Error("stale_popup");
				const tabId = crypto.randomUUID();
				record.tabs[tabId] = {
					targetId: target.targetInfo.targetId,
					tabGen: 1,
					navGen: 1,
					viewport: { width: 1280, height: 900 },
				};
				record.viewedTabId = tabId;
				record.viewGen += 1;
				record.controlGen += 1;
				record.viewport = record.tabs[tabId]!.viewport;
				await this.save(record);
				await this.connect_host(record, { closeOnFailure: true, tabId });
				const settled = await this.load();
				if (
					settled?.mode !== "web" ||
					settled.sessionId !== record.sessionId ||
					settled.command?.id !== record.command!.id
				)
					throw new Error("stale_popup");
				settled.command = null;
				await this.save(settled);
				this.stop_viewer_producer();
				this.push_viewers({ t: "tabs", viewedTabId: tabId, tabs: this.tab_summaries(settled) });
				this.push_viewers({ t: "notice", code: "popup_opened_here" });
				if (this.viewerStreams.size) await this.start_viewer_producer();
				return json_response({ ok: true }, 200);
			} catch {
				await close();
				const record = await this.load();
				if (record?.sessionId === current.sessionId)
					await this.close_record({ record, reason: "popup_registration_failed", saveProfile: false });
				return operation_refused("closed", "The popup could not be registered.");
			}
		});
	}

	/**
	 * Web mode: answer one paused request. A response-stage pause is a page load that may be a
	 * download. A request-stage pause comes from the agent's blocked-site filter. Every pause gets
	 * exactly one answer, even when a step throws, or the page hangs.
	 */
	private async answer_fetch_pause(args: {
		host: HostConnection;
		blockedHosts: string[];
		event: Record<string, unknown>;
		requestId: string;
	}) {
		const { host, blockedHosts, event, requestId } = args;

		const pause: { answer: "continue" | "abort" | "block" } = { answer: "continue" };
		try {
			if (event.responseStatusCode === undefined && event.responseErrorReason === undefined) {
				const url = is_record(event.request) && typeof event.request.url === "string" ? event.request.url : "";
				if (browser_web_url_host_matches(url, blockedHosts)) pause.answer = "block";
				return;
			}
			await this.capture_response_download({ host, event, requestId, pause });
		} catch (error) {
			log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
		} finally {
			// After the body was taken, only `failRequest` works (checked live on 2026-09-23). Failing a
			// navigation keeps the current page.
			await (
				pause.answer === "continue"
					? host.cdp.send("Fetch.continueRequest", { requestId })
					: host.cdp.send("Fetch.failRequest", {
							requestId,
							errorReason: pause.answer === "block" ? "BlockedByClient" : "Aborted",
						})
			).catch(() => {});
		}
	}

	/**
	 * Web mode: read a paused page response when Chrome would save it. Set `pause.answer` to abort
	 * as soon as it is a download, so a later failure still stops Chrome's own download.
	 */
	private async capture_response_download(args: {
		host: HostConnection;
		event: Record<string, unknown>;
		requestId: string;
		pause: { answer: string };
	}) {
		const { host, event, requestId, pause } = args;

		const status = event.responseStatusCode;
		const request = is_record(event.request) ? event.request : {};
		if (
			event.responseErrorReason !== undefined ||
			typeof status !== "number" ||
			(status >= 300 && status < 400) ||
			status === 204 ||
			status === 205 ||
			request.method === "HEAD"
		)
			return;
		const disposition = cdp_header(event.responseHeaders, "content-disposition");
		const contentType = cdp_header(event.responseHeaders, "content-type");
		if (!is_download_response(disposition, contentType)) return;
		pause.answer = "abort";

		const url = typeof request.url === "string" ? request.url : "";
		const lengthHeader = cdp_header(event.responseHeaders, "content-length")?.trim() ?? "";
		const length =
			/^\d+$/u.test(lengthHeader) && Number.isSafeInteger(Number(lengthHeader)) ? Number(lengthHeader) : null;
		// The stream gives the decoded body. A compressed body's length cannot be compared with it.
		const encoding = (cdp_header(event.responseHeaders, "content-encoding") ?? "").trim().toLowerCase();
		const exactLength = encoding === "" || encoding === "identity" ? length : null;
		await this.capture_download(host, {
			owner: this.download_owner(host, event.frameId === host.targetId),
			name: download_name(disposition, url),
			origin: download_origin(url),
			sizeHint: length,
			read: async (maxBytes, signal) => {
				const { stream } = await with_wall_timeout(
					host.cdp.send("Fetch.takeResponseBodyAsStream", { requestId }),
					10_000,
				);
				try {
					const read = await read_cdp_stream({ cdp: host.cdp, handle: stream, maxBytes, signal });
					if (read.over) return read;
					// A stream that ends early (the server dropped the connection) still ends with `eof`.
					// Fewer bytes than the header promised is a broken file, not a small one.
					if (exactLength !== null && read.bytes.byteLength !== exactLength)
						throw new Error("Download did not finish.");
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
		const owner = this.download_owner(host, frameId === host.targetId);
		if (/^data:/iu.test(url)) {
			await this.capture_download(host, {
				owner,
				name,
				origin: null,
				sizeHint: null,
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
				this.refuse_download({ sessionId: host.sessionId, owner, code: "download_failed" });
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
			sameOrigin =
				frameUrl !== null && download_origin(frameUrl) !== null && download_origin(frameUrl) === download_origin(url);
		}
		if (!sameOrigin) {
			this.refuse_download({ sessionId: host.sessionId, owner, code: "download_unsupported" });
			return;
		}
		await this.capture_download(host, {
			owner,
			name,
			origin: download_origin(url),
			sizeHint: null,
			read: (maxBytes, signal) => this.read_in_page({ host, frameId, url, maxBytes, signal }),
		});
	}

	/**
	 * Fetch a same-origin file again in an isolated world of its frame, with the page's cookies.
	 * The bytes stay in that world and come back in 1 MiB base64 chunks, so no CDP message is huge.
	 */
	private async read_in_page(args: {
		host: HostConnection;
		frameId: string;
		url: string;
		maxBytes: number;
		signal: AbortSignal;
	}): Promise<DownloadRead> {
		const { host, frameId, url, maxBytes, signal } = args;

		const cdp = host.cdp;
		const world = await with_wall_timeout(
			cdp.send("Page.createIsolatedWorld", { frameId, worldName: "bonobo-download", grantUniveralAccess: false }),
			5000,
		);
		const fetched = await with_wall_timeout(
			cdp.send("Runtime.evaluate", {
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
			}),
			LIMITS.downloadCaptureMs,
		);
		const objectId = fetched.result.objectId;
		if (fetched.exceptionDetails || !objectId) throw new Error("Download failed.");
		try {
			const summary = await with_wall_timeout(
				cdp.send("Runtime.callFunctionOn", {
					objectId,
					returnByValue: true,
					functionDeclaration: "function () { return { over: this.over, size: this.size, type: this.type }; }",
				}),
				5000,
			);
			const value: unknown = summary.result.value;
			if (
				!is_record(value) ||
				typeof value.over !== "boolean" ||
				typeof value.size !== "number" ||
				typeof value.type !== "string"
			) {
				throw new Error("Download failed.");
			}
			if (value.over || value.size > maxBytes) return { over: true };
			const chunks: Uint8Array[] = [];
			for (let offset = 0; offset < value.size; offset += LIMITS.downloadChunkBytes) {
				signal.throwIfAborted();
				const part = await with_wall_timeout(
					cdp.send("Runtime.callFunctionOn", {
						objectId,
						returnByValue: true,
						arguments: [{ value: offset }, { value: LIMITS.downloadChunkBytes }],
						functionDeclaration:
							'function (offset, length) { const part = this.bytes.subarray(offset, offset + length); let text = ""; ' +
							"for (let i = 0; i < part.length; i += 8192) text += String.fromCharCode.apply(null, part.subarray(i, i + 8192)); return btoa(text); }",
					}),
					10_000,
				);
				const bytes = typeof part.result.value === "string" ? base64_bytes(part.result.value) : null;
				if (!bytes) throw new Error("Download failed.");
				chunks.push(bytes);
			}
			const bytes = append_bytes(
				chunks,
				chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
			);
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
			this.downloads = {
				sessionId,
				count: 0,
				bytes: 0,
				starts: [],
				capture: null,
				held: null,
				pushed: new Set(),
				agent: null,
			};
		}
		return this.downloads;
	}

	/**
	 * Who a new download belongs to, or null when nobody asked for it. Call it as soon as the
	 * download shows up, before any await. An agent command owns every download during its run. A
	 * human download needs human control, the main frame, and a click or Enter in the last 10
	 * seconds. Each gesture allows one download.
	 */
	private download_owner(host: HostConnection, mainFrame: boolean): DownloadOwner | null {
		const sessionId = host.sessionId;
		const record = this.viewerRecord;
		if (record?.sessionId !== sessionId) return null;
		// A reload holds the command slot too, but with no agent connection.
		if (record.command && record.command.connection !== undefined) {
			if (record.mode === "web" && record.command.tabId !== host.tabId) return null;
			// Make the command's list now. `run/finish` sends it, so a capture that ends near the
			// command end still has a place to land, or to be counted as dropped.
			const downloads = this.session_downloads(sessionId);
			if (downloads.agent?.commandId !== record.command.id)
				downloads.agent = { commandId: record.command.id, items: [], bytes: 0, dropped: 0 };
			return { kind: "agent", commandId: record.command.id };
		}
		const gesture = this.humanGesture;
		if (
			record.control !== "human" ||
			record.command ||
			!mainFrame ||
			gesture?.sessionId !== sessionId ||
			gesture.tabId !== host.tabId ||
			(record.mode === "web" && record.viewedTabId !== host.tabId) ||
			Date.now() - gesture.at > LIMITS.downloadGestureMs
		)
			return null;
		this.humanGesture = null;
		return { kind: "human" };
	}

	/**
	 * Tell the viewers that a download was not kept. An agent download also counts as dropped in
	 * its command's result, so the agent learns about it even when no viewer is attached.
	 */
	private refuse_download(args: { sessionId: string; owner: DownloadOwner | null; code: string }) {
		const { sessionId, owner, code } = args;

		log_browser({ route: "download", sessionId, refused: code });
		this.push_viewers({ t: "notice", code });
		const agent = this.downloads?.sessionId === sessionId ? this.downloads.agent : null;
		if (owner?.kind === "agent" && agent?.commandId === owner.commandId) agent.dropped += 1;
	}

	/**
	 * Check the limits, read the file, then keep it. A human download waits in memory for Convex;
	 * an agent download joins its command's result. Every refusal and failure tells the viewers.
	 */
	private async capture_download(
		host: HostConnection,
		input: {
			owner: DownloadOwner | null;
			name: string;
			origin: string | null;
			sizeHint: number | null;
			read: (maxBytes: number, signal: AbortSignal) => Promise<DownloadRead>;
		},
	) {
		const owner = input.owner;
		if (!owner) {
			this.refuse_download({ sessionId: host.sessionId, owner: null, code: "download_blocked" });
			return;
		}
		const downloads = this.session_downloads(host.sessionId);
		const now = Date.now();
		downloads.starts = downloads.starts.filter((at) => now - at < LIMITS.downloadStartWindowMs);
		const fileCap = owner.kind === "human" ? LIMITS.downloadHumanBytes : LIMITS.downloadAgentBytes;
		// No await between these checks and `capture`, so two pauses cannot both pass.
		const refusal =
			owner.kind === "human" && downloads.held
				? "download_busy"
				: downloads.capture ||
					  downloads.starts.length >= LIMITS.downloadStarts ||
					  downloads.count >= LIMITS.downloadSessionFiles ||
					  downloads.bytes >= LIMITS.downloadSessionBytes
					? "download_limit"
					: input.sizeHint !== null && input.sizeHint > fileCap
						? "download_too_large"
						: null;
		if (refusal) {
			this.refuse_download({ sessionId: host.sessionId, owner, code: refusal });
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
				this.refuse_download({ sessionId: host.sessionId, owner, code: "download_too_large" });
				return;
			}
			if (downloads.bytes + read.bytes.byteLength > LIMITS.downloadSessionBytes) {
				this.refuse_download({ sessionId: host.sessionId, owner, code: "download_limit" });
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
					this.refuse_download({ sessionId: host.sessionId, owner, code: "download_limit" });
					return;
				}
				agent.items.push(file);
				agent.bytes += file.bytes.byteLength;
				log_browser({ route: "download", sessionId: host.sessionId, owner: "agent", bytes: file.bytes.byteLength });
				return;
			}
			const downloadId = crypto.randomUUID();
			const held: HeldDownload = {
				downloadId,
				...file,
				size: file.bytes.byteLength,
				origin: input.origin,
				expiresAt: Date.now() + LIMITS.downloadKeepMs,
				timer: setTimeout(() => this.drop_held_download(held), LIMITS.downloadKeepMs),
				pushing: null,
			};
			downloads.held = held;
			log_browser({ route: "download", sessionId: host.sessionId, owner: "human", bytes: held.size });
			this.push_viewers({ t: "download", downloadId, name: held.name, size: held.size, contentType: held.contentType });
		})();
		const outcome = capture.catch((error: unknown) => {
			// A read error, a cut-off body, or the 30-second timeout. The user clicked, so say it failed.
			stop.abort();
			log_browser({ route: "download", sessionId: host.sessionId, error: sanitize_error(error).name });
			if (this.downloads === downloads)
				this.refuse_download({ sessionId: host.sessionId, owner, code: "download_failed" });
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
		const held =
			this.downloads?.sessionId === sessionId && this.downloads.held?.downloadId === downloadId
				? this.downloads.held
				: null;
		if (held && held.expiresAt <= Date.now()) {
			this.drop_held_download(held);
			return null;
		}
		return held;
	}

	private download_info(sessionId: string, downloadId: string): Response {
		const held = this.held_download(sessionId, downloadId);
		if (!held) return operation_refused("download_gone", "The download is gone.");
		return json_response(
			{ ok: true, name: held.name, size: held.size, contentType: held.contentType, origin: held.origin },
			200,
		);
	}

	/**
	 * Upload the held download to the signed R2 URL from Convex, then free its bytes. A second push
	 * of the same id answers ok. `If-None-Match: *` makes R2 refuse to replace an object, so a 412
	 * means an earlier push already stored it. A failed push keeps the bytes for a retry.
	 */
	private async download_push(input: {
		sessionId: string;
		downloadId: string;
		url: string;
		headers: Record<string, string>;
	}): Promise<Response> {
		const downloads = this.downloads;
		if (downloads?.sessionId === input.sessionId && downloads.pushed.has(input.downloadId))
			return json_response({ ok: true }, 200);
		const held = this.held_download(input.sessionId, input.downloadId);
		if (!downloads || !held) return operation_refused("download_gone", "The download is gone.");
		held.pushing ??= (async () => {
			const headers = new Headers(input.headers);
			headers.set("If-None-Match", "*");
			const response = await with_wall_timeout(fetch(input.url, { method: "PUT", headers, body: held.bytes }), 60_000);
			await response.body?.cancel().catch(() => {});
			return response.ok || response.status === 412;
		})()
			.catch(() => false)
			.then((pushed) => {
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
		if (
			before?.sessionId !== host.sessionId ||
			before.control !== "human" ||
			before.command ||
			(before.mode === "web" && before.viewedTabId !== host.tabId)
		)
			return;
		const viewed = this.viewed_identity(before);
		const [accept, origin] = await Promise.all([
			with_wall_timeout(chooser.element().getAttribute("accept"), 5000),
			chooser_origin(chooser),
		]);
		// The reads above waited for the page. Check that the same human still holds control.
		const record = this.viewerRecord;
		if (
			origin === null ||
			!this.host_live(host) ||
			record?.sessionId !== host.sessionId ||
			record.control !== "human" ||
			record.command ||
			record.controlGen !== before.controlGen ||
			!this.viewer_matches(viewed, record) ||
			(record.mode === "web" && record.viewedTabId !== host.tabId)
		)
			return;
		this.close_file_chooser();
		const chooserId = crypto.randomUUID();
		const open: OpenFileChooser = {
			sessionId: host.sessionId,
			chooserId,
			host,
			chooser,
			multiple: chooser.isMultiple(),
			accept: (accept ?? "").slice(0, LIMITS.chooserAcceptChars),
			origin,
			mainNavCount: host.mainNavCount,
			controlGen: record.controlGen,
			...viewed,
			openedAt: Date.now(),
			timer: setTimeout(() => this.close_file_chooser(open), LIMITS.chooserMs),
			busy: false,
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
	private async current_file_chooser(input: {
		sessionId: string;
		chooserId: string;
		controlGen: number;
		tabId: string;
		tabGen: number;
		viewGen: number;
	}): Promise<{ ok: true; chooser: OpenFileChooser } | { ok: false; code: string }> {
		const record = await this.load();
		if (
			!record ||
			record.sessionId !== input.sessionId ||
			record.control === "closing" ||
			record.control === "closed"
		) {
			return { ok: false, code: "chooser_gone" };
		}
		if (record.control !== "human" || record.command) return { ok: false, code: "not_human" };
		const chooser = this.chooser;
		if (!chooser || chooser.sessionId !== input.sessionId || chooser.chooserId !== input.chooserId)
			return { ok: false, code: "chooser_gone" };
		if (
			!this.host_live(chooser.host) ||
			chooser.host.mainNavCount !== chooser.mainNavCount ||
			!this.viewer_matches(chooser, record) ||
			(record.mode === "web" && record.viewedTabId !== chooser.host.tabId) ||
			record.controlGen !== chooser.controlGen ||
			Date.now() - chooser.openedAt >= LIMITS.chooserMs
		) {
			this.close_file_chooser(chooser);
			return { ok: false, code: "chooser_gone" };
		}
		if (input.controlGen !== chooser.controlGen || !this.viewer_matches(input, record))
			return { ok: false, code: "chooser_gone" };
		return { ok: true, chooser };
	}

	/**
	 * Give files to the open chooser once. `read_files` fetches the bytes while the chooser is held,
	 * so a second fill cannot start meanwhile. After the reads, check the frame origin and then the
	 * chooser again: the page may have moved while the bytes were on the way.
	 */
	private async fill_file_chooser(
		input: { sessionId: string; chooserId: string; controlGen: number; tabId: string; tabGen: number; viewGen: number },
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
			const filled = await with_wall_timeout(chooser.chooser.setFiles(read.files), LIMITS.uploadSetFilesMs).then(
				() => true,
				() => false,
			);
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
		tabId: string;
		tabGen: number;
		viewGen: number;
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
				return {
					name: file.name,
					mimeType: file.contentType,
					buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
				};
			};
			const files = await Promise.all(input.files.map(read_file))
				.catch(() => {
					// The first failure stops the other reads.
					stop.abort();
					return null;
				})
				.finally(() => clearTimeout(timer));
			if (!files) return { ok: false, code: tooLarge ? "too_large" : "fetch_failed" };
			return { ok: true, files };
		});
		if (!filled.ok) return operation_refused(filled.code, "The file was not given to the page.");
		return json_response({ ok: true }, 200);
	}

	/**
	 * `upload-grant`: a single-use, 2-minute grant for one computer upload to this chooser.
	 */
	private async upload_grant(input: {
		sessionId: string;
		chooserId: string;
		controlGen: number;
		tabId: string;
		tabGen: number;
		viewGen: number;
	}): Promise<Response> {
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
		this.uploadGrants.set(grantId, { ...input, expiresAt });
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
			const body = await with_wall_timeout(
				read_bounded_stream({ stream: request.body, maxBytes: LIMITS.uploadBytes, signal: stop.signal }),
				60_000,
			).catch(() => {
				stop.abort();
				return null;
			});
			if (!body) return { ok: false, code: "upload_failed" };
			if (body.truncated) return { ok: false, code: "too_large" };
			return {
				ok: true,
				files: [
					{
						name: url.searchParams.get("name") ?? "",
						mimeType: mime_essence(request.headers.get("Content-Type")) || "application/octet-stream",
						buffer: Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength),
					},
				],
			};
		});
		if (!filled.ok)
			return reply(filled.code === "too_large" ? 413 : filled.code === "upload_failed" ? 400 : 409, filled.code);
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
		const current = await this.current_file_chooser(chooser);
		if (!current.ok) return;
		this.close_file_chooser(chooser);
		await with_wall_timeout(
			chooser.chooser.element().evaluate((node) => node.dispatchEvent(new Event("cancel", { bubbles: true }))),
			5000,
		).catch(() => {});
	}

	private async agent_stream(url: URL): Promise<Response> {
		const record = await this.load();
		const sessionId = url.searchParams.get("sessionId");
		const commandId = url.searchParams.get("commandId");
		if (
			!record ||
			record.sessionId !== sessionId ||
			record.ownerId !== url.searchParams.get("ownerId") ||
			record.organizationId !== url.searchParams.get("organizationId") ||
			record.workspaceId !== url.searchParams.get("workspaceId") ||
			record.command?.id !== commandId ||
			record.command.connection !== "available" ||
			this.agentConnection ||
			(record.control !== "agent" && record.control !== "pausing") ||
			session_is_expired(record, Date.now())
		) {
			return new Response("Browser command is unavailable", { status: 403 });
		}
		// Reserve before any provider await. A second upgrade cannot spend this command.
		const connection = {
			sessionId: record.sessionId,
			commandId: record.command.id,
			bridge: null as AgentConnection | null,
		};
		this.agentConnection = connection;
		record.command.connection = "consumed";
		await this.save(record);
		let upstream: WebSocket | null = null;
		let acceptingUpgrade = true;
		try {
			await with_wall_timeout(this.connect_host(record), 10_000);
			const beforeUpgrade = await this.load();
			if (
				this.agentConnection !== connection ||
				beforeUpgrade?.sessionId !== record.sessionId ||
				beforeUpgrade.command?.id !== connection.commandId ||
				beforeUpgrade.command.connection !== "consumed" ||
				(beforeUpgrade.control !== "agent" && beforeUpgrade.control !== "pausing")
			)
				throw new Error("Browser command changed.");
			const response = await with_wall_timeout(
				this.env.BROWSER.fetch(
					`${GATE_FAKE_HOST}${GATE_UPGRADE_PATH_PREFIX}${record.providerSessionId}?persistent=true`,
					{ headers: { Upgrade: "websocket" } },
				).then((response) => {
					// A timed-out fetch can still return an open provider socket.
					if (!acceptingUpgrade && response.webSocket) {
						response.webSocket.accept();
						close_socket({ socket: response.webSocket, code: 1000, reason: "command ended" });
					}
					return response;
				}),
				10_000,
			);
			upstream = response.webSocket ?? null;
			const current = await this.load();
			const host = this.hostConnections.get(record.mode === "web" ? record.command!.tabId! : record.sessionId);
			if (
				!upstream ||
				response.status !== 101 ||
				!host ||
				host.sessionId !== record.sessionId ||
				this.agentConnection !== connection ||
				current?.sessionId !== record.sessionId ||
				current.command?.id !== connection.commandId ||
				current.command.connection !== "consumed" ||
				(current.control !== "agent" && current.control !== "pausing") ||
				session_is_expired(current, Date.now())
			) {
				throw new Error("Browser command changed.");
			}
			const [client, server] = Object.values(new WebSocketPair());
			connection.bridge = new AgentConnection({
				upstream,
				downstream: server,
				targetId: host.targetId,
				peerTargetIds:
					record.mode === "web"
						? Object.values(record.tabs)
								.map((tab) => tab.targetId)
								.filter((id) => id !== host.targetId)
						: [],
				mode: record.mode,
				deniedHosts: web_denied_hosts(this.env),
				agentBlockedHosts: record.mode === "web" ? record.agentBlockedHosts : [],
				deadline: record.command.deadline ?? record.command.startedAt + LIMITS.childWallMs,
				onPopup: async (targetId) => {
					try {
						const closed: unknown = await host.browserCdp.send("Target.closeTarget", { targetId });
						if (is_record(closed) && closed.success === true) return;
					} catch {
						/* The host page listener may have closed it first. */
					}
					const targets: unknown = await host.browserCdp.send("Target.getTargets");
					if (
						is_record(targets) &&
						Array.isArray(targets.targetInfos) &&
						targets.targetInfos.every((target) => is_record(target) && is_non_empty_string(target.targetId)) &&
						!targets.targetInfos.some((target) => target.targetId === targetId)
					)
						return;
					throw new Error("Popup could not be closed.");
				},
				onUnsafe: (reason) => {
					log_browser({ route: "agent_connection", reason });
					this.state.waitUntil(
						this.load().then(async (current) => {
							if (current?.sessionId === connection.sessionId && current.command?.id === connection.commandId) {
								await this.close_record({ record: current, reason: "agent_connection_failed" });
							}
						}),
					);
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
				close_socket({ socket: upstream, code: 1011, reason: "command failed" });
			}
			const current = await this.load();
			if (current?.sessionId === record.sessionId)
				await this.close_record({ record: current, reason: "agent_connect_failed" });
			return new Response("Browser command failed", { status: 503 });
		}
	}

	private async settle_run(sessionId: string, commandId: string): Promise<Response> {
		const connection = this.agentConnection;
		if (connection?.sessionId === sessionId && connection.commandId === commandId) connection.bridge?.revoke();
		let record = await this.load();
		if (
			!record ||
			record.sessionId !== sessionId ||
			record.command?.id !== commandId ||
			(record.control !== "agent" && record.control !== "pausing")
		)
			return operation_refused("closed", "Browser command changed.");
		if (record.command.connection === "settled") return json_response({ ok: true, blockedPopups: 0 }, 200);
		// A restarted object cannot prove that the old upstream drained.
		if (!connection?.bridge || connection.sessionId !== sessionId || connection.commandId !== commandId) {
			await this.close_record({ record, reason: "agent_connection_lost" });
			return operation_refused("closed", "Browser command connection was lost.");
		}
		record.command.connection = "revoked";
		await this.save(record);
		try {
			const settled = await connection.bridge.settle(5000);
			if (!settled.safe) throw new Error("Browser command did not settle.");
			const host = this.hostConnections.get(record.mode === "web" ? record.command!.tabId! : record.sessionId);
			if (!host || host.sessionId !== sessionId) throw new Error("Browser connection was lost.");
			// Playwright keeps local target caches. Ask Chromium for the full inventory.
			const check = await with_wall_timeout(
				(async () => {
					const [contexts, targets] = await Promise.all([
						host.browserCdp.send("Target.getBrowserContexts"),
						host.browserCdp.send("Target.getTargets"),
					]);
					const contextIds: unknown = contexts.browserContextIds;
					const targetInfos: unknown = targets.targetInfos;
					if (
						!Array.isArray(contextIds) ||
						contextIds.some((id) => typeof id !== "string" || id !== host.contextId) ||
						!Array.isArray(targetInfos)
					)
						return false;
					const pages = targetInfos.filter((target: unknown) => is_record(target) && target.type === "page");
					if (record?.mode === "web") {
						const registered = new Set(Object.values(record.tabs).map((tab) => tab.targetId));
						return (
							pages.length === registered.size &&
							pages.every((target) => is_record(target) && registered.has(String(target.targetId)))
						);
					}
					if (pages.length !== 1 || !is_record(pages[0]) || pages[0].targetId !== host.targetId) return false;
					const page: unknown = await host.page.evaluate("({url: location.href, nonce: window.__browserNonce})");
					return is_record(page) && page.url === CONTROLLER_URL && page.nonce === record?.pageNonce;
				})(),
				10_000,
			);
			if (!check) throw new Error("Browser target changed.");
			// The command's page work is over. Stop failing requests, then check where the page is.
			// On a blocked site the command result is refused, but the session stays.
			let blockedSite = false;
			if (record.mode === "web" && record.agentBlockedHosts.length > 0) {
				await this.set_agent_site_filter(sessionId, false);
				blockedSite = await this.main_page_blocked(record);
			}
			record = await this.load();
			if (
				!record ||
				record.sessionId !== sessionId ||
				record.command?.id !== commandId ||
				record.command.connection !== "revoked"
			) {
				return operation_refused("closed", "Browser command changed.");
			}
			record.command.connection = "settled";
			await this.save(record);
			if (this.agentConnection === connection) this.agentConnection = null;
			return json_response(
				{ ok: true, blockedPopups: settled.blockedPopups, ...(blockedSite ? { blockedSite: true } : {}) },
				200,
			);
		} catch {
			const current = await this.load();
			if (current?.sessionId === sessionId) await this.close_record({ record: current, reason: "agent_settle_failed" });
			return operation_refused("closed", "Browser command could not be checked.");
		}
	}

	private async begin_run(
		input: {
			sessionId: string;
			navGen: number;
			loadGen: number;
			controlGen: number;
			commandId: string;
			deadline?: number;
			tabId?: string;
			tabGen?: number;
			policyRevision?: number;
		},
		inputReleased = false,
	): Promise<Response> {
		let record = await this.load();
		if (!record || record.control === "closed") {
			return operation_refused("closed", "The browser session is closed.");
		}

		const now = Date.now();
		// A lost caller may still have browser work in flight.
		if (record.command && now - record.command.startedAt >= LIMITS.commandTimeoutMs + 10_000) {
			await this.close_record({ record, reason: "command_timeout" });
			return operation_refused("expired", "The browser command timed out.");
		}
		const check = session_can_run({ record, input, now });
		if (!check.ok) {
			if (check.reason === "expired") {
				await this.close_record({ record, reason: "expired" });
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
			const blocked = await Promise.all(
				Object.keys(record.tabs).map((tabId) => this.main_page_blocked(record as WebSessionRecord, tabId)),
			)
				.then((checks) => checks.some(Boolean))
				.catch(() => null);
			if (blocked !== false) {
				log_browser({
					route: "run_begin",
					refused: blocked ? "agent_blocked_site" : "page_check",
					sessionId: record.sessionId,
				});
				return blocked
					? operation_refused("agent_blocked_site", "The page is on a site the agent may not use.")
					: operation_refused("not_ready", "The browser page could not be checked.");
			}
			if (
				!(await this.set_agent_site_filter(record.sessionId, true).then(
					() => true,
					() => false,
				))
			) {
				return operation_refused("not_ready", "The browser page could not be checked.");
			}
			// The checks above waited for the provider. Check the lease again before taking the slot.
			const current = await this.load();
			const again = current
				? session_can_run({ record: current, input, now: Date.now() })
				: { ok: false as const, reason: "closed" };
			if (!current || !again.ok) {
				await this.set_agent_site_filter(record.sessionId, false).catch(() => {});
				return operation_refused(again.ok ? "closed" : again.reason, "The browser command was refused.");
			}
			record = current;
		}

		// A value saved by an older browser session of the same chat counts as empty.
		await this.commandReceiptsReady;
		const chatId = this.commandReceipts.get(input.commandId)?.source.chatId;
		const scriptState = chatId
			? await this.state.storage.get<ScriptState>(`${SCRIPT_STATE_KEY_PREFIX}${chatId}`)
			: undefined;

		if (input.deadline !== undefined && Date.now() >= input.deadline)
			return operation_refused("expired", "The command deadline passed.");
		record.command = {
			id: input.commandId,
			startedAt: now,
			deadline: input.deadline ?? now + LIMITS.childWallMs,
			connection: "available",
			...(record.mode === "web" ? { tabId: input.tabId } : {}),
		};
		record.control = "agent";
		record.lastActiveAt = now;
		await this.save(record);
		return json_response(
			{
				ok: true,
				lease: {
					sessionId: record.sessionId,
					mode: record.mode,
					viewport: record.mode === "web" ? record.tabs[input.tabId!]!.viewport : record.viewport,
					timeoutMs: LIMITS.commandTimeoutMs,
					scriptState: scriptState?.sessionId === record.sessionId ? scriptState.json : null,
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
		stateJson?: string;
	}): Promise<Response> {
		let record = await this.load();
		if (!record || record.control === "closed") return json_response({ ok: true, state: "closed" }, 200);
		if (record.sessionId !== input.sessionId) return json_response({ ok: true, state: "stale" }, 200);

		const liveCommand = record.command?.id === input.commandId;
		if (!liveCommand) return json_response({ ok: true, state: "stale" }, 200);
		const finishedTabId = record.command?.tabId;
		if (input.tainted) {
			log_browser({ route: "run_finish", sessionId: record.sessionId, tainted: true });
			// A tainted command returns nothing. `close_record` drops its downloads too.
			const closed = await this.close_record({ record, reason: "tainted" });
			return json_response(
				{ ok: true, state: "closed", tainted: true, cleanup: closed.verified ? "complete" : "unknown", session: null },
				200,
			);
		}

		if (record.command?.connection !== "settled") {
			await this.close_record({ record, reason: "command_not_settled" });
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
			if (record.mode === "web" && record.command?.tabId)
				record.tabs[record.command.tabId]!.viewport = { width: input.viewport.width, height: input.viewport.height };
			else record.viewport = { width: input.viewport.width, height: input.viewport.height };
		}
		// Agent tracing can replace Chromium's screencast. Restart ours while the
		// command still blocks input, then check that close or another command did not win.
		if (record.mode === "file" || record.command?.tabId === record.viewedTabId) this.stop_viewer_producer();
		await this.save(record);
		if (this.viewerStreams.size > 0) await this.start_viewer_producer().catch(() => {});
		// A failed restart may still be removing viewers from the same record.
		await this.viewerCleanup;
		const current = await this.load();
		if (!current || current.control === "closing" || current.control === "closed")
			return json_response({ ok: true, state: "closed" }, 200);
		if (current.sessionId !== input.sessionId || current.command?.id !== input.commandId)
			return json_response({ ok: true, state: "stale" }, 200);
		record = current;
		record.command = null;
		record.commandCount += 1;
		record.lastActiveAt = Date.now();
		// Save changed cookies after settlement, even when no viewer is mounted.
		if (this.profile?.sessionId === record.sessionId) this.profile.dirty = true;
		// Human Take stays paused until Resume, even if its viewer detached.
		if (record.control === "pausing") {
			record.control = "human";
		} else if (record.control === "agent") {
			record.control = "ready";
		}
		await this.commandReceiptsReady;
		const chatId = this.commandReceipts.get(input.commandId)?.source.chatId;
		if (input.stateJson !== undefined && chatId)
			await this.save_script_state({ sessionId: record.sessionId, chatId, json: input.stateJson });
		await this.save(record);
		if (
			this.profile?.sessionId === record.sessionId &&
			this.profile.dirty &&
			Date.now() - this.profile.savedAt > LIMITS.profileSaveEveryMs
		)
			await this.save_profile(record);
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
		return json_response(
			{
				ok: true,
				state: record.control,
				cleanup: "complete",
				session: this.public_meta(record, finishedTabId),
				...(agent?.items.length
					? {
							downloads: agent.items.map((item) => ({
								name: item.name,
								contentType: item.contentType,
								dataBase64: bytes_base64(item.bytes),
							})),
						}
					: {}),
				...(agent?.dropped ? { downloadsDropped: agent.dropped } : {}),
			},
			200,
		);
	}

	private async save_script_state(args: { sessionId: string; chatId: string; json: string }): Promise<void> {
		const { sessionId, chatId, json } = args;

		await this.state.storage.put(`${SCRIPT_STATE_KEY_PREFIX}${chatId}`, {
			sessionId,
			json,
			savedAt: Date.now(),
		} satisfies ScriptState);

		// Keep the most recent chats only. 8 values of 256 KiB stay far below the storage limits.
		const saved = [...(await this.state.storage.list<ScriptState>({ prefix: SCRIPT_STATE_KEY_PREFIX }))];
		saved.sort((a, b) => b[1].savedAt - a[1].savedAt);
		for (const [key] of saved.slice(SCRIPT_STATE_MAX_CHATS)) await this.state.storage.delete(key);
	}

	private async reload(
		input: { sessionId: string; navGen: number; expectedAgentLease?: AgentLease } & (
			| { mode: "file"; sourceKind: string; sourceVersion: string; sourceHash: string; html: string }
			| { mode: "web" }
		),
	): Promise<Response> {
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
			const refusal = agent_lease_refusal({ record, lease: input.expectedAgentLease });
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
			// The agent may not reload a web page while the user has turned its access off.
			if (record.mode === "web" && !record.agentAccess) {
				return operation_refused("agent_access_off", "Agent access to this browser is off.");
			}
		}
		if (record.control === "closing" || record.control === "starting") {
			return operation_refused("busy", "The browser session is busy.");
		}
		if (record.mode === "file" && record.navGen !== input.navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.command) {
			return operation_refused("busy", "A browser command is running.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
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
			if (input.expectedAgentLease) {
				const refusal = agent_lease_refusal({ record: current, lease: input.expectedAgentLease });
				if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
				if (current.mode === "web" && !current.agentAccess)
					return operation_refused("agent_access_off", "Agent access to this browser is off.");
			}
			current.command = {
				id: reloadId,
				startedAt: Date.now(),
				...(current.mode === "web" ? { tabId: input.expectedAgentLease?.tabId ?? current.viewedTabId } : {}),
			};
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
			await this.connect_host(reserved);
			const host = this.hostConnections.get(reserved.mode === "web" ? reserved.command!.tabId! : reserved.sessionId);
			if (!host || host.sessionId !== record.sessionId) throw new Error("Browser session changed.");
			if (input.mode === "web") {
				// Slow sites stay usable. A failed navigation save cannot return an old lease.
				const deadline = Date.now() + LIMITS.navWallMs;
				await with_wall_timeout(
					host.page.reload({ waitUntil: "commit", timeout: LIMITS.navWallMs }),
					LIMITS.navWallMs,
				).catch((error: unknown) => {
					if (!(error instanceof WallTimeoutError) && !(error instanceof errors.TimeoutError)) throw error;
				});
				await with_wall_timeout(host.navigationUpdates, Math.max(1, deadline - Date.now()));
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
			await this.close_record({ record, reason: "reload_failed" });
			return json_response({ ok: false, error: { code: "reload_failed", message: failure.message } }, 200);
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

		const reloadTabId = current.command.tabId;
		current.command = null;
		// Web reload keeps loadGen. Tab and navigation generations record page changes.
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
			current.control = "human";
		} else if (current.control === "agent") {
			current.control = "ready";
		}
		await this.save(current);
		log_browser({ route: "reload", sessionId: current.sessionId, loadGen: current.loadGen });
		return json_response({ ok: true, session: this.public_meta(current, reloadTabId) }, 200);
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
			const receipt: UsageReceipt = {
				sessionId: current.sessionId,
				providerAcquiredAt: current.providerAcquiredAt,
				endedAt: now,
				reason,
			};
			await this.state.storage.put(`${USAGE_KEY_PREFIX}${current.sessionId}`, receipt);
		}
		await this.state.storage.delete(SESSION_KEY);
		// Script `state` lives only as long as its browser session.
		const scriptStates = await this.state.storage.list({ prefix: SCRIPT_STATE_KEY_PREFIX });
		for (const key of scriptStates.keys()) await this.state.storage.delete(key);
		// Keep the saved profile's 100-day delete time, if there is one.
		await this.schedule_alarm(null);
		// Convex settles within minutes. Keep receipts for 7 days, then delete them.
		const receipts = await this.state.storage.list<UsageReceipt>({ prefix: USAGE_KEY_PREFIX });
		for (const [key, value] of receipts) {
			if (now - value.endedAt >= LIMITS.usageReceiptMs) await this.state.storage.delete(key);
		}
	}

	private async close_record(args: {
		record: SessionRecord;
		reason: string;
		saveProfile?: boolean;
		beforeClose?: (current: SessionRecord) => string | null;
	}): Promise<{ existed: boolean; verified: boolean; refusal?: string }> {
		let { record, reason, saveProfile, beforeClose } = args;

		let current = await this.load();
		if (current?.sessionId !== record.sessionId) return { existed: false, verified: true };
		const refusal = beforeClose?.(current);
		if (refusal) return { existed: true, verified: false, refusal };
		// Save the cookies while the host connection and the page still exist.
		if (this.should_save({ record: current, reason, saveProfile })) {
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
		const hosts = [...this.hostConnections.values()];
		this.hostConnection = null;
		this.hostConnections.clear();
		for (const browser of new Set(hosts.map((host) => host.browser)))
			this.state.waitUntil(browser.close().catch(() => {}));
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

	private async close(args: {
		sessionId: string | null;
		expectedAgentLease?: AgentLease;
		saveProfile?: boolean;
		by?: string | null;
	}): Promise<Response> {
		const { sessionId, expectedAgentLease, saveProfile, by = null } = args;

		log_browser({
			route: "close_request",
			sessionId: sessionId ?? "none",
			by: by ?? "unknown",
			saveProfile: saveProfile === true,
		});
		const record = await this.load();
		// A session closed earlier may still have its receipt.
		if (!record || (sessionId && record.sessionId !== sessionId) || record.control === "closed") {
			return json_response(
				{ ok: true, existed: false, verified: true, usage: sessionId ? await this.usage(sessionId) : null },
				200,
			);
		}
		if (expectedAgentLease) {
			const refusal = agent_lease_refusal({ record, lease: expectedAgentLease });
			if (refusal) return operation_refused(refusal, "The agent browser lease changed.");
		}
		const result = await this.close_record({ record, reason: "close", saveProfile });
		return json_response({ ok: true, ...result, usage: await this.usage(record.sessionId) }, 200);
	}

	private async status(sessionId: string): Promise<Response> {
		const record = await this.load();
		const alive =
			!!record &&
			record.sessionId === sessionId &&
			record.control !== "closed" &&
			record.control !== "closing" &&
			!session_is_expired(record, Date.now());
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
	private async read_profile(input: {
		ownerId: string;
		organizationId: string;
		workspaceId: string;
		profileId: string;
		profileKey: string;
	}) {
		const stored = await this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY);
		if (stored?.profileId !== input.profileId) return { ok: true as const, stored: null, cookies: [] };
		try {
			const key = await profile_crypto_key(this.env.BROWSER_PROFILE_KEY, input.profileKey);
			const cookies = await profile_decrypt({ key, aad: profile_aad(input.profileId, input), blob: stored });
			return { ok: true as const, stored, cookies, key };
		} catch (error) {
			log_browser({ route: "profile_read", error: sanitize_error(error).name });
			return { ok: false as const };
		}
	}

	/**
	 * List the saved sites with a cookie count each. Never cookie names or values.
	 */
	private async profile_summary(input: {
		ownerId: string;
		organizationId: string;
		workspaceId: string;
		profileId: string;
		profileKey: string;
	}): Promise<Response> {
		if (await this.session_live()) return operation_refused("busy", "End the browser first.");
		const read = await this.read_profile(input);
		if (!read.ok) return operation_refused("profile_unreadable", "The saved browser data cannot be read.");
		const counts = new Map<string, number>();
		for (const cookie of read.cookies) counts.set(cookie_site(cookie), (counts.get(cookie_site(cookie)) ?? 0) + 1);
		const sites = [...counts]
			.map(([domain, cookies]) => ({ domain, cookies }))
			.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
		return json_response(
			{
				ok: true,
				exists: read.stored !== null,
				savedAt: read.stored?.savedAt ?? null,
				truncated: read.stored?.truncated ?? false,
				sites,
			},
			200,
		);
	}

	/**
	 * Remove the cookies of one site and its subdomains, then store the rest again. `savedAt` stays.
	 */
	private async profile_clear(input: {
		ownerId: string;
		organizationId: string;
		workspaceId: string;
		profileId: string;
		profileKey: string;
		domain: string;
	}): Promise<Response> {
		if (await this.session_live()) return operation_refused("busy", "End the browser first.");
		const read = await this.read_profile(input);
		if (!read.ok) return operation_refused("profile_unreadable", "The saved browser data cannot be read.");
		if (!read.stored) return json_response({ ok: true, removed: 0 }, 200);
		const domain = browser_web_canonical_host(input.domain.replace(/^\./u, ""));
		const kept = read.cookies.filter((cookie) => !browser_web_host_matches(cookie_site(cookie), [domain]));
		const removed = read.cookies.length - kept.length;
		if (removed === 0) return json_response({ ok: true, removed: 0 }, 200);
		const sealed = await profile_encrypt({ key: read.key, aad: profile_aad(input.profileId, input), cookies: kept });

		// Like the save: a delete or an open may have run during the crypto awaits. Put only when the
		// blob is still the one read above and no tombstone exists. Storage reads only until the put.
		const [deletedAt, latest] = await Promise.all([
			this.state.storage.get<number>(`${PROFILE_DELETED_KEY_PREFIX}${input.profileId}`),
			this.state.storage.get<ProfileBlob>(PROFILE_BLOB_KEY),
		]);
		if (deletedAt !== undefined || latest?.iv !== read.stored.iv)
			return operation_refused("busy", "The saved browser data changed.");
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
		if (
			record?.mode === "web" &&
			record.profileId === profileId &&
			record.control !== "closing" &&
			record.control !== "closed"
		) {
			await this.close_record({ record, reason: "profile_deleted" });
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
		if (record.mode === "file" && record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
			return operation_refused("expired", "The browser session expired.");
		}

		// Human attention extends the idle deadline, never the total cap.
		record.lastActiveAt = Date.now();
		await this.save(record);
		return json_response({ ok: true, idleUntil: record.lastActiveAt + mode_limits(record.mode).idleMs }, 200);
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
		if (record.mode === "file" && record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
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

	private async viewer_attach(args: { grantId: string; viewerId: string; host: string }): Promise<Response> {
		const { grantId, viewerId, host } = args;

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
		if (record.mode === "file" && record.navGen !== grant.navGen) {
			await this.save(record);
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (session_is_expired(record, now)) {
			await this.save(record);
			await this.close_record({ record, reason: "expired" });
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
			await this.close_record({ record, reason: "expired" });
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
				// Human Pause stays set after detach. Only Resume clears it.
			}
			await this.save(record);
		}
		return json_response({ ok: true }, 200);
	}

	private async control_take_human(args: {
		sessionId: string;
		navGen: number;
		viewerId: string;
		inputReleased?: boolean;
	}): Promise<Response> {
		const { sessionId, navGen, viewerId, inputReleased = false } = args;

		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.mode === "file" && record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
			return operation_refused("expired", "The browser session expired.");
		}

		// A stale command cannot safely hand its page to a human.
		const liveCommand =
			record.command !== null && Date.now() - record.command.startedAt < LIMITS.commandTimeoutMs + 10_000;
		if (!liveCommand && record.command) {
			await this.close_record({ record, reason: "command_timeout" });
			return operation_refused("expired", "The browser command timed out.");
		}
		if (!inputReleased)
			return this.with_input_released(() =>
				this.control_take_human({ sessionId, navGen, viewerId, inputReleased: true }),
			);
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

	private async control_to_agent(args: {
		sessionId: string;
		navGen: number;
		controlGen: number;
		inputReleased?: boolean;
	}): Promise<Response> {
		const { sessionId, navGen, controlGen, inputReleased = false } = args;

		const record = await this.load();
		if (!record || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (record.sessionId !== sessionId) {
			return operation_refused("stale_session", "The browser session is retired.");
		}
		if (record.mode === "file" && record.navGen !== navGen) {
			return operation_refused("stale_nav", "The browser session moved to another file.");
		}
		if (record.control === "agent") {
			return operation_refused("busy", "A browser command is running.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
			return operation_refused("expired", "The browser session expired.");
		}

		if (record.controlGen !== controlGen) return operation_refused("stale_control", "The browser control changed.");
		if (!inputReleased)
			return this.with_input_released(() =>
				this.control_to_agent({ sessionId, navGen, controlGen, inputReleased: true }),
			);
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
	private async set_agent_access(args: {
		sessionId: string;
		on: boolean;
		policyRevision: number;
		blockedHosts: string[];
	}): Promise<Response> {
		const { sessionId, on, policyRevision, blockedHosts } = args;

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
			await this.close_record({ record, reason: "expired" });
			return operation_refused("expired", "The browser session expired.");
		}

		if (policyRevision < record.policyRevision) return operation_refused("stale_policy", "The browser policy changed.");
		if (
			record.agentAccess !== on ||
			record.policyRevision !== policyRevision ||
			JSON.stringify(record.agentBlockedHosts) !== JSON.stringify(blockedHosts)
		) {
			record.agentAccess = on;
			record.policyRevision = policyRevision;
			record.agentBlockedHosts = blockedHosts;
			// Every real change gets a new controlGen. Convex copies `agentAccess` only from a reply
			// with a controlGen at least as new as its own, so a late reply cannot undo this change.
			record.controlGen += 1;
			// Turning access off works like Take: the new controlGen retires every agent lease, and a
			// running command loses its bridge. Its snippet fails fast and the command settles.
			if (this.agentConnection?.sessionId === record.sessionId) this.agentConnection.bridge?.revoke();
			await this.save(record);
			if (record.command?.connection) await this.settle_run(record.sessionId, record.command.id);
			log_browser({ route: "agent_access", sessionId: record.sessionId, on });
		}
		const current = await this.load();
		return current?.mode === "web" && current.sessionId === sessionId
			? json_response({ ok: true, session: this.public_meta(current) }, 200)
			: operation_refused("closed", "The browser session is closed.");
	}

	private async viewer_input(args: {
		viewerId: string;
		sessionId: string;
		controlGen: number;
		loadGen: number | null;
	}): Promise<Response> {
		const { viewerId, sessionId, controlGen, loadGen } = args;

		const record = await this.load();
		if (!record || record.viewers[viewerId] === undefined) {
			return operation_refused("viewer", "The viewer is gone.");
		}
		if (record.sessionId !== sessionId || record.control === "closed" || record.control === "closing") {
			return operation_refused("closed", "The browser session is closed.");
		}
		if (
			record.control !== "human" ||
			record.inputHolder !== viewerId ||
			record.command ||
			this.inputTransition ||
			record.controlGen !== controlGen ||
			(loadGen !== null && record.loadGen !== loadGen)
		) {
			return operation_refused("control", "This viewer does not hold input.");
		}
		const viewer = record.viewers[viewerId]!;
		if (viewer.grantedUntil <= Date.now()) {
			return operation_refused("grant", "The viewer grant expired.");
		}
		if (session_is_expired(record, Date.now())) {
			await this.close_record({ record, reason: "expired" });
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
		if (
			previous &&
			(previous.sessionId !== record.sessionId ||
				previous.loadGen !== record.loadGen ||
				previous.controlGen !== record.controlGen ||
				previous.control !== record.control ||
				previous.inputHolder !== record.inputHolder ||
				previous.command?.id !== record.command?.id)
		) {
			this.inputEpoch += 1;
			this.pointerPosition = null;
		}
		const viewportChanged =
			previous &&
			(previous.loadGen !== record.loadGen ||
				previous.viewport.width !== record.viewport.width ||
				previous.viewport.height !== record.viewport.height ||
				(previous.mode === "web" &&
					record.mode === "web" &&
					(previous.viewedTabId !== record.viewedTabId ||
						previous.viewGen !== record.viewGen ||
						previous.tabs[previous.viewedTabId]?.tabGen !== record.tabs[record.viewedTabId]?.tabGen)));
		if (viewportChanged) this.stop_viewer_producer();
		const agentAccessChanged =
			previous?.mode === "web" && record.mode === "web" && previous.agentAccess !== record.agentAccess;
		for (const stream of this.viewerStreams.values()) {
			const viewer = record.viewers[stream.viewerId];
			if (
				record.sessionId !== stream.sessionId ||
				!viewer ||
				record.control === "closing" ||
				record.control === "closed"
			) {
				this.end_viewer({ stream, code: 4404, reason: "session gone" });
				continue;
			}
			if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
			const limits = mode_limits(record.mode);
			const deadline = Math.min(
				viewer.grantedUntil,
				record.providerAcquiredAt! + limits.totalMs,
				record.lastActiveAt + limits.idleMs,
			);
			stream.deadlineTimer = setTimeout(
				() => this.end_viewer({ stream, code: 4408, reason: "grant expired" }),
				Math.max(0, deadline - Date.now()),
			);
			try {
				if (
					!previous ||
					previous.control !== record.control ||
					previous.controlGen !== record.controlGen ||
					viewportChanged ||
					this.viewed_identity(previous).tabGen !== this.viewed_identity(record).tabGen
				) {
					stream.socket.send(
						JSON.stringify({
							t: "control",
							...this.viewed_identity(record),
							control: record.control,
							controlGen: record.controlGen,
						}),
					);
				}
				if (viewportChanged)
					stream.socket.send(
						JSON.stringify({ t: "viewport", ...this.viewed_identity(record), viewport: record.viewport }),
					);
				if (agentAccessChanged)
					stream.socket.send(
						JSON.stringify({ t: "agent-access", ...this.viewed_identity(record), on: record.agentAccess }),
					);
			} catch {
				this.end_viewer({ stream, code: 1011, reason: "socket error" });
			}
		}
		// A chooser belongs to one human turn. It is gone when control or the session moves on.
		const chooser = this.chooser;
		if (
			chooser &&
			(chooser.sessionId !== record.sessionId ||
				chooser.controlGen !== record.controlGen ||
				record.control !== "human" ||
				record.command ||
				!this.viewer_matches(chooser, record))
		) {
			this.close_file_chooser(chooser);
		}
		if (viewportChanged && this.viewerStreams.size > 0) {
			this.state.waitUntil(this.start_viewer_producer().catch(() => {}));
		}
	}

	private end_viewer(args: { stream: ViewerStream; code: number; reason: string }): void {
		const { stream, code, reason } = args;

		if (!this.viewerStreams.delete(stream.viewerId)) return;
		if (stream.deadlineTimer) clearTimeout(stream.deadlineTimer);
		// Log why each viewer socket ends. A dropped viewer is hard to explain without it.
		log_browser({ route: "viewer_end", sessionId: stream.sessionId, code, reason });
		close_socket({ socket: stream.socket, code, reason });
		// Detaches share a record, so each one must read after the previous save.
		this.viewerCleanup = this.viewerCleanup
			.then(async () => {
				await this.inputTransitionDone;
				const record = await this.load();
				if (record?.sessionId !== stream.sessionId) return;
				if (record.inputHolder === stream.viewerId) {
					await this.with_input_released(() => this.viewer_detach(stream.viewerId));
				} else {
					await this.viewer_detach(stream.viewerId);
				}
				if (this.viewerStreams.size === 0) this.stop_viewer_producer();
			})
			.catch(() => {
				if (this.viewerRecord?.sessionId === stream.sessionId) this.fail_viewers();
			});
		this.state.waitUntil(this.viewerCleanup);
	}

	private fail_viewers(): void {
		const record = this.viewerRecord;
		for (const stream of this.viewerStreams.values()) this.end_viewer({ stream, code: 1011, reason: "viewer failed" });
		// A lost provider connection cannot safely release held or in-flight input.
		if (record && (this.pressedButtons.size > 0 || this.pressedKeys.size > 0 || this.inputDepth > 0)) {
			this.state.waitUntil(this.close_record({ record, reason: "viewer_input_failed" }));
			return;
		}
		this.stop_viewer_producer();
	}

	private stop_viewer_producer(): void {
		this.viewerProducerGen += 1;
		this.viewerStart = null;
		this.viewerFrame = null;
		for (const stream of this.viewerStreams.values()) {
			stream.frameSeqs = [];
			stream.lastFrameSeq = 0;
		}
		this.pointerPosition = null;
		const producer = this.viewerProducer;
		this.viewerProducer = null;
		if (producer) {
			this.viewerLifecycle = this.viewerLifecycle
				.then(async () => {
					await producer.cdp.send("Page.stopScreencast").catch(() => {});
					await producer.cdp.detach().catch(() => {});
				})
				.catch(() => {});
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
			this.end_viewer({ stream, code: 4408, reason: "grant expired" });
			return;
		}
		try {
			stream.frameSeqs.push(frame.seq);
			stream.lastFrameSeq = frame.seq;
			stream.socket.send(
				JSON.stringify({
					t: "frame",
					seq: frame.seq,
					loadGen: frame.loadGen,
					tabId: frame.tabId,
					tabGen: frame.tabGen,
					viewGen: frame.viewGen,
				}),
			);
			stream.socket.send(frame.bytes);
		} catch {
			this.end_viewer({ stream, code: 1011, reason: "socket error" });
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
			await this.connect_host(record, {
				closeOnFailure: true,
				...(record.mode === "web" ? { tabId: record.viewedTabId } : {}),
			});
			const host = this.hostConnection;
			if (!host || host.sessionId !== record.sessionId) return;
			// A fresh producer must not change the command tab while that command owns it.
			if (record.mode === "web" && record.command?.tabId === host.tabId && record.command.connection !== "settled")
				return;
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
				width: record.viewport.width,
				height: record.viewport.height,
				deviceScaleFactor: 1,
				mobile: false,
				screenWidth: record.viewport.width,
				screenHeight: record.viewport.height,
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
				this.state.waitUntil(
					cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {
						if (generation === this.viewerProducerGen) this.fail_viewers();
					}),
				);
				if (generation !== this.viewerProducerGen) return;
				if (
					typeof event.data !== "string" ||
					event.data.length === 0 ||
					event.data.length > Math.ceil((LIMITS.viewerFrameBytes * 4) / 3) + 4
				) {
					this.fail_viewers();
					return;
				}
				try {
					const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
					if (bytes.byteLength > LIMITS.viewerFrameBytes) throw new Error("Viewer frame is too large.");
					const current = this.viewerRecord;
					if (!current || (current.mode === "web" && current.viewedTabId !== host.tabId)) return;
					this.viewerFrame = {
						seq: ++this.viewerFrameSeq,
						loadGen: current.loadGen,
						...this.viewed_identity(current),
						bytes,
					};
					for (const stream of this.viewerStreams.values()) this.send_viewer_frame(stream);
				} catch {
					this.fail_viewers();
				}
			});
			cdp.on("Inspector.detached", () => {
				if (generation === this.viewerProducerGen) this.fail_viewers();
			});
			await cdp.send("Page.startScreencast", {
				format: "jpeg",
				quality: 70,
				maxWidth: record.viewport.width,
				maxHeight: record.viewport.height,
				everyNthFrame: 1,
			});
			if (generation !== this.viewerProducerGen) return;
		});
		this.viewerLifecycle = start.catch(() => {});
		this.viewerStart = with_wall_timeout(start, 15_000)
			.catch(async (error: unknown) => {
				if (generation !== this.viewerProducerGen) return;
				const record = this.viewerRecord;
				this.fail_viewers();
				// A timed-out setup may still change the page. End it before another setup.
				if (error instanceof WallTimeoutError && record)
					await this.close_record({ record, reason: "viewer_start_timeout" });
				throw error;
			})
			.finally(() => {
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
				if (record && record.sessionId === sessionId) await this.close_record({ record, reason: "input_timeout" });
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

	private queue_viewer_input(
		stream: ViewerStream,
		parsed: Extract<ReturnType<typeof parse_viewer_input>, { ok: true }>,
	): void {
		const receivedAt = Date.now();
		const timings = { queueMs: 0, authorizeMs: 0, readyMs: 0, applyMs: 0 };
		const ack = (ok: boolean, code?: string) => {
			try {
				stream.socket.send(JSON.stringify({ t: "input-ack", seq: parsed.seq, ok, timings, ...(code ? { code } : {}) }));
			} catch {
				this.end_viewer({ stream, code: 1011, reason: "socket error" });
			}
		};
		if (!this.viewerRecord || !this.viewer_matches(parsed, this.viewerRecord) || stream.lastFrameSeq === 0) {
			ack(false, "stale_view");
			return;
		}
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
				const checked: unknown = await (
					await this.viewer_input({
						viewerId: stream.viewerId,
						sessionId: stream.sessionId,
						controlGen: parsed.controlGen,
						loadGen: parsed.loadGen,
					})
				).json();
				timings.authorizeMs = Date.now() - startedAt;
				if (!is_record(checked) || checked.ok !== true) {
					ack(
						false,
						is_record(checked) && is_record(checked.error) && typeof checked.error.code === "string"
							? checked.error.code
							: "denied",
					);
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
					current.controlGen !== parsed.controlGen ||
					current.loadGen !== parsed.loadGen ||
					!this.viewer_matches(parsed, current) ||
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
				if (
					input.kind === "mouse.up" ||
					input.kind === "mouse.click" ||
					((input.kind === "key.down" || input.kind === "key.press") && input.key === "Enter")
				) {
					this.humanGesture = { sessionId: stream.sessionId, tabId: parsed.tabId, at: Date.now() };
				}
				const applyAt = Date.now();
				await with_wall_timeout(apply_viewer_input(page, input), 5000);
				timings.applyMs = Date.now() - applyAt;
				// A pending handoff still needs releases, but a replaced page must not inherit them.
				if (this.viewerProducer?.page === page) {
					if (input.kind === "mouse.move" || input.kind === "mouse.click" || input.kind === "wheel")
						this.pointerPosition = { x: input.x, y: input.y };
					if (input.kind === "mouse.down") this.pressedButtons.add(input.button);
					if (input.kind === "mouse.up") this.pressedButtons.delete(input.button);
					if (input.kind === "key.down") this.pressedKeys.add(input.key);
					if (input.kind === "key.up") this.pressedKeys.delete(input.key);
				}
				ack(true);
			} catch {
				ack(false, "apply");
				const record = await this.load();
				if (record?.sessionId === stream.sessionId) await this.close_record({ record, reason: "input_failed" });
			} finally {
				this.inputDepth -= 1;
			}
		});
		this.state.waitUntil(this.inputQueue);
	}

	/**
	 * Web mode: run one address bar action (go, back, forward, reload, stop) for the viewer that
	 * holds control. It uses the same ordered queue and checks as mouse and key input.
	 */
	private queue_viewer_nav(
		stream: ViewerStream,
		parsed: Extract<ReturnType<typeof parse_viewer_nav>, { ok: true }>,
	): void {
		const ack = (ok: boolean, code?: string) => {
			try {
				stream.socket.send(JSON.stringify({ t: "nav-ack", seq: parsed.seq, ok, ...(code ? { code } : {}) }));
			} catch {
				this.end_viewer({ stream, code: 1011, reason: "socket error" });
			}
		};
		if (this.viewerRecord?.mode !== "web") {
			ack(false, "bad_request");
			return;
		}
		if (!this.viewer_matches(parsed, this.viewerRecord) || stream.lastFrameSeq === 0) {
			ack(false, "stale_view");
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
				const checked: unknown = await (
					await this.viewer_input({
						viewerId: stream.viewerId,
						sessionId: stream.sessionId,
						controlGen: parsed.controlGen,
						loadGen: null,
					})
				).json();
				if (!is_record(checked) || checked.ok !== true) {
					const code =
						is_record(checked) && is_record(checked.error) && typeof checked.error.code === "string"
							? checked.error.code
							: "denied";
					ack(false, code === "control" ? "not_controller" : code);
					return;
				}
				await this.start_viewer_producer();
				const current = this.viewerRecord;
				const host = current?.mode === "web" ? this.hostConnections.get(current.viewedTabId) : null;
				if (
					epoch !== this.inputEpoch ||
					this.inputTransition ||
					!host ||
					host.sessionId !== stream.sessionId ||
					current?.sessionId !== stream.sessionId ||
					current.control !== "human" ||
					current.inputHolder !== stream.viewerId ||
					!this.viewer_matches(parsed, current) ||
					current.controlGen !== parsed.controlGen
				) {
					ack(false, "not_controller");
					return;
				}
				// Typing an address and pressing Enter is a human gesture too, so a download link works.
				if (parsed.nav.action === "go")
					this.humanGesture = { sessionId: stream.sessionId, tabId: parsed.tabId, at: Date.now() };
				// A slow site is still a good nav. A CDP error fails this nav but keeps the session.
				const code = await with_wall_timeout(
					apply_viewer_nav({ cdp: host.cdp, action: parsed.nav.action, url }),
					LIMITS.navWallMs,
				).catch((error: unknown) => (error instanceof WallTimeoutError ? null : "apply"));
				if (code === null) ack(true);
				else ack(false, code);
			} catch {
				ack(false, "apply");
			} finally {
				this.inputDepth -= 1;
			}
		});
	}

	private async viewer_lifetime(
		socket: WebSocket,
		scope: { ownerId: string; organizationId: string; workspaceId: string },
	): Promise<void> {
		const first = await new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => resolve(null), 5000);
			socket.addEventListener(
				"message",
				(event) => {
					clearTimeout(timer);
					resolve(event.data);
				},
				{ once: true },
			);
			socket.addEventListener(
				"close",
				() => {
					clearTimeout(timer);
					resolve(null);
				},
				{ once: true },
			);
		});
		const hello = parse_viewer_hello(first);
		const record = await this.load();
		if (
			!hello.ok ||
			!record ||
			hello.hello.mode !== record.mode ||
			hello.hello.ownerId !== scope.ownerId ||
			hello.hello.organizationId !== scope.organizationId ||
			hello.hello.workspaceId !== scope.workspaceId ||
			record.ownerId !== scope.ownerId ||
			record.organizationId !== scope.organizationId ||
			record.workspaceId !== scope.workspaceId
		) {
			close_socket({ socket, code: 4401, reason: "bad grant message" });
			return;
		}
		const viewerId = crypto.randomUUID();
		const attached: unknown = await (
			await this.viewer_attach({ grantId: hello.hello.grantId, viewerId, host: hello.hello.host })
		).json();
		if (!is_record(attached) || attached.ok !== true) {
			close_socket({ socket, code: 4401, reason: "grant refused" });
			return;
		}
		const current = await this.load();
		if (!current || current.sessionId !== record.sessionId || !current.viewers[viewerId] || socket.readyState !== 1) {
			if (current?.sessionId === record.sessionId) await this.viewer_detach(viewerId);
			close_socket({ socket, code: 4404, reason: "session gone" });
			return;
		}
		const stream: ViewerStream = {
			socket,
			viewerId,
			sessionId: record.sessionId,
			frameSeqs: [],
			lastFrameSeq: 0,
			deadlineTimer: null,
		};
		this.viewerStreams.set(viewerId, stream);
		socket.addEventListener("close", () => this.end_viewer({ stream, code: 1000, reason: "client closed" }));
		socket.addEventListener("error", () => this.end_viewer({ stream, code: 1011, reason: "socket error" }));
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
				if (
					!is_positive_int(body.seq) ||
					!Number.isSafeInteger(body.seq) ||
					now - lastPingAt < 1000 ||
					!current ||
					current.sessionId !== stream.sessionId ||
					!this.viewerStreams.has(viewerId) ||
					(current.viewers[viewerId]?.grantedUntil ?? 0) <= now ||
					session_is_expired(current, now) ||
					current.control === "closing" ||
					current.control === "closed"
				)
					return;
				lastPingAt = now;
				try {
					socket.send(JSON.stringify({ t: "pong", seq: body.seq }));
				} catch {
					this.end_viewer({ stream, code: 1011, reason: "socket error" });
				}
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
				if (
					typeof body.chooserId === "string" &&
					current?.sessionId === stream.sessionId &&
					current.inputHolder === viewerId
				) {
					this.state.waitUntil(this.cancel_file_chooser(body.chooserId).catch(() => {}));
				}
				return;
			}
			const parsed = parse_viewer_input(event.data);
			if (parsed.ok) this.queue_viewer_input(stream, parsed);
		});
		try {
			socket.send(
				JSON.stringify({
					t: "hello",
					mode: current.mode,
					viewerId,
					viewport: current.viewport,
					control: current.control,
					controlGen: current.controlGen,
					...this.viewed_identity(current),
					viewedTabId: current.mode === "web" ? current.viewedTabId : current.sessionId,
					policyRevision: current.mode === "web" ? current.policyRevision : 0,
					tabs:
						current.mode === "web"
							? this.tab_summaries(current)
							: [
									{
										tabId: current.sessionId,
										tabGen: current.navGen,
										navGen: current.navGen,
										title: "Preview",
										url: "",
									},
								],
				}),
			);
			if (current.mode === "web")
				socket.send(JSON.stringify({ t: "agent-access", ...this.viewed_identity(current), on: current.agentAccess }));
			this.sync_viewers(current);
			// A viewer that reconnects missed what was pushed while it was away. Send the waiting
			// download and the open chooser again. The Convex save is idempotent per `downloadId`.
			const held = this.downloads?.held ? this.held_download(current.sessionId, this.downloads.held.downloadId) : null;
			if (held)
				socket.send(
					JSON.stringify({
						t: "download",
						...this.viewed_identity(current),
						downloadId: held.downloadId,
						name: held.name,
						size: held.size,
						contentType: held.contentType,
					}),
				);
			const chooser = this.chooser;
			if (chooser?.sessionId === current.sessionId) {
				socket.send(
					JSON.stringify({
						t: "file-chooser",
						...this.viewed_identity(current),
						chooserId: chooser.chooserId,
						multiple: chooser.multiple,
						accept: chooser.accept,
						origin: chooser.origin,
					}),
				);
			}
			await this.start_viewer_producer();
			this.send_viewer_frame(stream);
			if (current.mode === "web" && this.hostConnection?.sessionId === current.sessionId)
				this.push_location(this.hostConnection);
		} catch {
			this.end_viewer({ stream, code: 1011, reason: "viewer start failed" });
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
			await this.close_record({ record, reason: "closing_retry" });
			return;
		}
		if (record.control === "closed") {
			await this.schedule_alarm(record);
			return;
		}
		if (record.control === "starting" && now - record.createdAt >= LIMITS.startingStaleMs) {
			await this.close_record({ record, reason: "stale_start" });
			return;
		}
		if (session_is_expired(record, now)) {
			await this.close_record({ record, reason: "expired" });
			return;
		}
		// A worker crash can leave browser work running after its caller has gone.
		if (
			record.command &&
			now >= (record.command.deadline ?? record.command.startedAt + LIMITS.commandTimeoutMs + 10_000)
		) {
			await this.close_record({ record, reason: "command_timeout" });
			return;
		}
		await this.schedule_alarm(record);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/run/stream") {
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
				return new Response("Upgrade required", { status: 426 });
			return await this.agent_stream(url);
		}
		if (request.method === "GET" && url.pathname === "/viewer/stream") {
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket")
				return new Response("Upgrade required", { status: 426 });
			const scope = parse_owner_tuple({
				ownerId: url.searchParams.get("ownerId"),
				organizationId: url.searchParams.get("organizationId"),
				workspaceId: url.searchParams.get("workspaceId"),
				mode: url.searchParams.get("mode"),
			});
			if (!scope.ok) return scope.response;
			if (this.pendingViewers >= LIMITS.viewersPerSession)
				return operation_refused("busy", "Too many pending viewers.");
			const [client, server] = Object.values(new WebSocketPair());
			server.accept();
			this.pendingViewers += 1;
			this.state.waitUntil(
				this.viewer_lifetime(server, scope)
					.catch(() => close_socket({ socket: server, code: 1011, reason: "viewer failed" }))
					.finally(() => {
						this.pendingViewers -= 1;
					}),
			);
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
		if (["/run/claim", "/run/complete", "/command-status", "/command-fence"].includes(url.pathname))
			return this.command_receipt(url.pathname, body);
		if (url.pathname === "/run/settle") {
			if (!is_non_empty_string(body.sessionId) || !is_non_empty_string(body.commandId))
				return invalid_request("Browser command is required.");
			return await this.settle_run(body.sessionId, body.commandId);
		}
		if (["/operation/claim", "/operation/finish", "/operation-status"].includes(url.pathname))
			return this.management_receipt(url.pathname, body);
		if (["/tabs", "/tab-new", "/tab-close", "/tab-select"].includes(url.pathname))
			return this.tab_operation({ path: url.pathname, body });
		if (url.pathname === "/reuse") {
			const record = await this.load();
			if (
				!record ||
				record.mode !== "web" ||
				record.control === "closed" ||
				record.control === "closing" ||
				session_is_expired(record, Date.now())
			)
				return operation_refused("not_found", "No web browser is open.");
			if (!is_profile_id(body.profileId) || !is_profile_key(body.profileKey) || body.profileId !== record.profileId)
				return invalid_request("The browser profile changed.");
			this.profile = await profile_crypto_key(this.env.BROWSER_PROFILE_KEY, body.profileKey).then((key) => ({
				sessionId: record.sessionId,
				profileId: record.profileId,
				key,
				dirty: this.profile?.dirty ?? false,
				savedAt: this.profile?.savedAt ?? Date.now(),
			}));
			return json_response({ ok: true, session: this.public_meta(record) }, 200);
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
					!is_revision(body.policyRevision) ||
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
				return await this.open_reserved({
					...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
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
					policyRevision: body.policyRevision,
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
			return await this.open_reserved({
				...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
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
			return await this.begin_run({
				sessionId: body.sessionId,
				navGen: body.navGen,
				loadGen: body.loadGen,
				controlGen: body.controlGen,
				commandId: body.commandId,
				...(is_positive_int(body.deadline) ? { deadline: body.deadline } : {}),
				...(typeof body.tabId === "string" && is_positive_int(body.tabGen) && is_revision(body.policyRevision)
					? {
							tabId: body.tabId,
							tabGen: body.tabGen,
							policyRevision: body.policyRevision,
						}
					: {}),
			});
		}
		if (url.pathname === "/run/finish") {
			if (
				typeof body.sessionId !== "string" ||
				typeof body.commandId !== "string" ||
				typeof body.tainted !== "boolean" ||
				typeof body.resultBytes !== "number" ||
				typeof body.fileCount !== "number" ||
				typeof body.fileBytes !== "number" ||
				(body.viewport !== null && !is_record(body.viewport)) ||
				(body.stateJson !== undefined &&
					(typeof body.stateJson !== "string" || byte_length(body.stateJson) > LIMITS.stateBytes))
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
				...(typeof body.stateJson === "string" ? { stateJson: body.stateJson } : {}),
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
				(body.expectedAgentLease !== undefined &&
					(!is_agent_lease(body.expectedAgentLease) || !is_non_empty_string(body.sessionId))) ||
				(body.saveProfile !== undefined && typeof body.saveProfile !== "boolean") ||
				(body.by !== undefined && typeof body.by !== "string")
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.close({
				sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
				expectedAgentLease: body.expectedAgentLease,
				saveProfile: body.saveProfile,
				by: typeof body.by === "string" ? body.by : null,
			});
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
			const input = {
				ownerId: body.ownerId,
				organizationId: body.organizationId,
				workspaceId: body.workspaceId,
				profileId: body.profileId,
				profileKey: body.profileKey,
			};
			if (url.pathname === "/profile/summary") return await this.profile_summary(input);
			return await this.profile_clear({ ...input, domain: String(body.domain) });
		}
		if (url.pathname === "/profile/delete") {
			if (typeof body.profileId !== "string")
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			return await this.profile_delete(body.profileId);
		}
		if (url.pathname === "/download/info" || url.pathname === "/download/push") {
			const headers = is_record(body.headers) ? Object.entries(body.headers) : [];
			if (
				typeof body.sessionId !== "string" ||
				typeof body.downloadId !== "string" ||
				(url.pathname === "/download/push" &&
					(typeof body.url !== "string" ||
						!is_record(body.headers) ||
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
				if (
					is_record(file) &&
					typeof file.name === "string" &&
					typeof file.contentType === "string" &&
					typeof file.url === "string"
				) {
					files.push({ name: file.name, contentType: file.contentType, url: file.url });
				}
			}
			if (
				typeof body.sessionId !== "string" ||
				typeof body.chooserId !== "string" ||
				!is_positive_int(body.controlGen) ||
				!is_item_id(body.tabId) ||
				!is_positive_int(body.tabGen) ||
				!is_positive_int(body.viewGen) ||
				(url.pathname === "/upload/fill" && (!Array.isArray(body.files) || files.length !== body.files.length))
			) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			const input = {
				sessionId: body.sessionId,
				chooserId: body.chooserId,
				controlGen: body.controlGen,
				tabId: body.tabId,
				tabGen: body.tabGen,
				viewGen: body.viewGen,
			};
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
			if (typeof body.sessionId !== "string" || !is_positive_int(body.navGen) || typeof body.viewerId !== "string") {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			return await this.control_take_human({ sessionId: body.sessionId, navGen: body.navGen, viewerId: body.viewerId });
		}
		if (url.pathname === "/control/to-agent") {
			if (typeof body.sessionId !== "string" || !is_positive_int(body.navGen)) {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			if (!is_positive_int(body.controlGen)) return invalid_request("The control generation is required.");
			return await this.control_to_agent({
				sessionId: body.sessionId,
				navGen: body.navGen,
				controlGen: body.controlGen,
			});
		}
		if (url.pathname === "/agent-access") {
			if (typeof body.sessionId !== "string" || typeof body.on !== "boolean") {
				return json_response({ ok: false, error: { code: "invalid_request" } }, 400);
			}
			if (
				!is_revision(body.policyRevision) ||
				!Array.isArray(body.agentBlockedHosts) ||
				body.agentBlockedHosts.length > LIMITS.agentBlockedHosts ||
				!body.agentBlockedHosts.every((host) => typeof host === "string" && host.length <= LIMITS.hostChars)
			)
				return invalid_request("The browser policy is required.");
			return await this.set_agent_access({
				sessionId: body.sessionId,
				on: body.on,
				policyRevision: body.policyRevision,
				blockedHosts: body.agentBlockedHosts,
			});
		}
		return json_response({ ok: false, error: { code: "not_found" } }, 404);
	}
}

// Host request handling
//
// The host authenticates, validates, and drives the objects. Snippet execution
// stays here because only the host request context exposes the connection-gate
// binding factory.

function session_object_name(args: {
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	mode: SessionMode;
}): string {
	const { ownerId, organizationId, workspaceId, mode } = args;

	return `browser:${ownerId}:${organizationId}:${workspaceId}${mode === "file" ? ":file" : ""}`;
}

function workspace_key(organizationId: string, workspaceId: string): string {
	return `${organizationId}:${workspaceId}`;
}

function session_stub(args: {
	env: Env;
	ownerId: string;
	organizationId: string;
	workspaceId: string;
	mode: SessionMode;
}) {
	const { env, ownerId, organizationId, workspaceId, mode } = args;

	return env.BROWSER_SESSIONS.get(
		env.BROWSER_SESSIONS.idFromName(session_object_name({ ownerId, organizationId, workspaceId, mode })),
	);
}

function registry_stub(env: Env) {
	return env.BROWSER_REGISTRY.get(env.BROWSER_REGISTRY.idFromName(REGISTRY_NAME));
}

async function object_json(args: { stub: DurableObjectStubStub; path: string; body: unknown }): Promise<unknown> {
	const { stub, path, body } = args;

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
): Promise<{ ok: true; body: Record<string, unknown> & { mode: SessionMode } } | { ok: false; response: Response }> {
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
		if (!allowed.has(key) && key !== "mode") {
			return { ok: false, response: invalid_request(`Unknown request field \`${key}\`.`) };
		}
	}
	if (body.mode !== "file" && body.mode !== "web")
		return { ok: false, response: invalid_request("`mode` must be file or web.") };
	return { ok: true, body: { ...body, mode: body.mode } };
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
			response: json_response({ ok: false, error: { code: "disabled", message: "Browser runner is disabled." } }, 503),
		};
	}
	return { ok: true };
}

function parse_owner_tuple(
	body: Record<string, unknown>,
):
	| { ok: true; ownerId: string; organizationId: string; workspaceId: string; mode: SessionMode }
	| { ok: false; response: Response } {
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
	if (body.mode !== "file" && body.mode !== "web")
		return { ok: false, response: invalid_request("`mode` must be file or web.") };
	return {
		ok: true,
		ownerId: body.ownerId,
		organizationId: body.organizationId,
		workspaceId: body.workspaceId,
		mode: body.mode,
	};
}

function parse_viewport(
	body: Record<string, unknown>,
): { ok: true; viewport: { width: number; height: number } } | { ok: false; response: Response } {
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

function parse_snapshot(body: Record<string, unknown>):
	| { ok: true; sourceKind: string; sourceVersion: string; sourceHash: string; html: string }
	| {
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
	return {
		ok: true,
		sourceKind: body.sourceKind,
		sourceVersion: body.sourceVersion,
		sourceHash: body.sourceHash,
		html: body.html,
	};
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
		if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be positive.");
		if (body.startUrl !== null && typeof body.startUrl !== "string")
			return invalid_request("`startUrl` must be a string or null.");
		if (typeof body.agentAccess !== "boolean") return invalid_request("`agentAccess` must be a boolean.");
		if (!is_revision(body.policyRevision)) return invalid_request("The browser policy revision is required.");
		// Convex owns the profile doc. Its id names the saved cookies, and its key unlocks them.
		if (!is_profile_id(body.profileId)) return invalid_request("`profileId` is invalid.");
		if (!is_profile_key(body.profileKey)) return invalid_request("`profileKey` must be 32 bytes in base64.");
		if (
			!Array.isArray(body.agentBlockedHosts) ||
			body.agentBlockedHosts.length > LIMITS.agentBlockedHosts ||
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
			policyRevision: body.policyRevision,
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
	return managed_operation({
		env,
		owners,
		body,
		path: "/open",
		work: async () => {
			// Charge admission before acquisition so simultaneous calls cannot bypass quotas.
			if (body.mode === "web") {
				const reused = await object_json({
					stub: session_stub({
						env,
						ownerId: owners.ownerId,
						organizationId: owners.organizationId,
						workspaceId: owners.workspaceId,
						mode: "web",
					}),
					path: "/reuse",
					body: { profileId: body.profileId, profileKey: body.profileKey },
				});
				if (is_record(reused) && reused.ok === true) return json_response(reused, 200);
			}
			const claim = await object_json({
				stub: registry_stub(env),
				path: "/claim",
				body: {
					workspaceKey: workspace_key(owners.organizationId, owners.workspaceId),
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
				},
			});
			if (!is_record(claim) || claim.ok !== true || typeof claim.grantId !== "string") {
				const code =
					is_record(claim) && is_record(claim.error) && typeof claim.error.code === "string"
						? claim.error.code
						: "registry_error";
				return operation_refused(code, "The browser service is busy.");
			}

			const opened = await object_json({
				stub: session_stub({
					env,
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
					workspaceId: owners.workspaceId,
					mode: owners.mode,
				}),
				path: "/open",
				body: {
					...modeFields,
					grantId: claim.grantId,
					attemptId,
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
					workspaceId: owners.workspaceId,
					navGen: body.navGen,
					viewport: viewport.viewport,
					...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
				},
			});
			if (!is_record(opened) || opened.ok !== true) {
				await object_json({ stub: registry_stub(env), path: "/release", body: { grantId: claim.grantId } });
				if (is_record(opened) && is_record(opened.error) && typeof opened.error.code === "string") {
					return json_response({ ok: false, error: opened.error }, 200);
				}
				return json_response({ ok: false, error: { code: "open_failed", message: "The browser did not start." } }, 200);
			}

			const confirmed = await object_json({
				stub: registry_stub(env),
				path: "/confirm",
				body: { grantId: claim.grantId },
			});
			if (!is_record(confirmed) || confirmed.ok !== true) {
				// The claim lapsed mid-bootstrap (or the registry dropped it). Close the orphan
				// instead of running outside the admission caps; idle expiry backstops a lost close.
				const openedSession = is_record(opened.session) ? opened.session : null;
				const openedSessionId =
					openedSession && typeof openedSession.sessionId === "string" ? openedSession.sessionId : null;
				try {
					await object_json({
						stub: session_stub({
							env,
							ownerId: owners.ownerId,
							organizationId: owners.organizationId,
							workspaceId: owners.workspaceId,
							mode: owners.mode,
						}),
						path: "/close",
						body: openedSessionId ? { sessionId: openedSessionId } : {},
					});
				} catch {
					// Best effort.
				}
				return operation_refused("busy", "The browser service is busy.");
			}
			return json_response(opened, 200);
		},
	});
}

async function managed_operation(args: {
	env: Env;
	owners: { ownerId: string; organizationId: string; workspaceId: string; mode: SessionMode };
	body: Record<string, unknown>;
	path: string;
	work: () => Promise<Response>;
}): Promise<Response> {
	const { env, owners, body, path, work } = args;

	if (body.operationId === undefined && body.expectedAgentLease === undefined) return work();
	if (
		!is_non_empty_string(body.operationId) ||
		body.operationId.length > 128 ||
		!is_positive_int(body.operationDeadline) ||
		body.operationDeadline > Date.now() + 120_000 ||
		!is_command_source(body.source)
	)
		return invalid_request("A bounded operation identity and source are required.");
	const stub = session_stub({
		env,
		ownerId: owners.ownerId,
		organizationId: owners.organizationId,
		workspaceId: owners.workspaceId,
		mode: owners.mode,
	});
	const identity = {
		operationId: body.operationId,
		operationDeadline: body.operationDeadline,
		source: body.source,
		...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
	};
	const claim = await object_json({
		stub,
		path: "/operation/claim",
		body: {
			...identity,
			payloadHash: await sha256_hex(JSON.stringify([path, body])),
		},
	});
	if (!is_record(claim) || claim.ok !== true || claim.execute !== true)
		return json_response(is_record(claim) ? claim : { ok: false, error: { code: "claim_failed" } }, 200);
	try {
		const response = await work();
		const result: unknown = await response.json();
		if (!is_record(result)) throw new Error("Invalid operation result.");
		const status = result.ok === true ? "completed" : "refused";
		const cleanup =
			result.verified === false || (is_record(result.error) && result.error.code === "bootstrap_failed")
				? "unknown"
				: "complete";
		const receipt = await object_json({
			stub,
			path: "/operation/finish",
			body: {
				...identity,
				status,
				cleanup,
				session: is_record(result.session) ? result.session : null,
				reason: is_record(result.error) ? result.error.code : null,
			},
		});
		return json_response(
			{
				...result,
				status,
				tabs: is_record(receipt) ? receipt.tabs : [],
				result: is_record(receipt) ? receipt.result : { tabId: null, reason: null },
			},
			response.status,
		);
	} catch {
		await object_json({
			stub,
			path: "/operation/finish",
			body: { ...identity, status: "unknown", reason: "outcome_unknown" },
		}).catch(() => {});
		return json_response(
			{
				ok: true,
				status: "unknown",
				session: null,
				tabs: [],
				result: { tabId: null, reason: "outcome_unknown", cleanup: "unknown" },
			},
			200,
		);
	}
}

async function evaluate_snippet(input: {
	env: Env;
	ctx: BrowserRunnerContext | undefined;
	connection: BrowserConnectionGatewayProps;
	mode: SessionMode;
	runtimeOrigin: string | null;
	viewport: { width: number; height: number };
	code: string;
	deadline: number;
	state: string | null;
}): Promise<SnippetEvaluateResult> {
	const gateway = input.ctx?.exports?.BrowserConnectionGateway;
	if (!gateway) throw new Error("Browser connection gateway is unavailable.");

	const worker = input.env.LOADER.load({
		compatibilityDate: CHILD_COMPAT_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: SNIPPET_EXECUTOR_MAIN_MODULE,
		modules: snippet_executor_modules(input.code),
		env: {
			BROWSER: gateway({ props: input.connection }),
		},
		globalOutbound: null,
		limits: { cpuMs: LIMITS.childCpuMs, subRequests: LIMITS.childSubRequests },
	});
	const entrypoint = worker.getEntrypoint();
	return await with_wall_timeout(
		entrypoint.evaluate({
			endpointId: input.connection.sessionId,
			mode: input.mode,
			runtimeOrigin: input.runtimeOrigin,
			viewport: input.viewport,
			// The snippet stops itself before the command deadline, so the host can still drain and check.
			budgetMs: input.deadline - SNIPPET_EXECUTOR_SOFT_MARGIN_MS - Date.now(),
			state: input.state,
		}),
		Math.max(1, input.deadline - Date.now()),
	);
}

async function execute_browser_command(args: {
	env: Env;
	ctx: BrowserRunnerContext | undefined;
	body: Record<string, unknown>;
	commandId: string;
	lease: Record<string, unknown>;
	connection: BrowserConnectionGatewayProps;
	deadline: number;
	settle: () => Promise<unknown>;
	finish: (
		tainted: boolean,
		meta: {
			resultBytes: number;
			fileCount: number;
			fileBytes: number;
			viewport: { width: number; height: number } | null;
			stateJson?: string;
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
		const blocked =
			typeof value.blocked === "number" && Number.isInteger(value.blocked) && value.blocked >= 0
				? Math.min(value.blocked, 10_000)
				: 0;
		const urls = Array.isArray(value.urls)
			? value.urls
					.filter((url): url is string => typeof url === "string")
					.slice(0, 10)
					.map((url) => url.slice(0, 200))
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
			deadline: args.deadline,
			state: typeof lease.scriptState === "string" ? lease.scriptState : null,
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
				error: wallTimeout ? { name: "TimeoutError", message: "Execution timed out." } : sanitize_error(error),
			},
			200,
		);
	}

	const elapsedMs = Date.now() - started;

	// The snippet stopped itself at its soft limit, but its code may still be running. The settle
	// below revokes the bridge, and the gateway allows one connection per command, so that code can
	// no longer reach the browser. The session stays open when the settle succeeds.
	const timedOut = !sandbox.ok && sandbox.timedOut === true;

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

	// Save `state` only together with output the model gets back: never after a blocked site or a
	// result the host could not check.
	const stateJson = snippet_executor_check_state(sandbox.stateJson);
	const stateWarnings = snippet_executor_check_state_warnings(sandbox.stateWarnings);

	if (!sandbox.ok) {
		// Files and downloads of a failed or timed-out command are dropped.
		await finish(false, {
			resultBytes: 0,
			fileCount: 0,
			fileBytes: 0,
			viewport: snippetViewport(sandbox.viewport),
			...(stateJson === null ? {} : { stateJson }),
		});
		log_browser({ route: "run", commandId, status: timedOut ? "timed_out" : "errored", elapsedMs });
		const text = cap_snippet_text(sandbox);
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
				popups: snippetPopups(sandbox.popups),
				consoleEntries: text.consoleEntries,
				pageErrors: text.pageErrors,
				logs: text.logs,
				logsTruncated: text.logsTruncated,
				stateWarnings,
				error: timedOut
					? {
							name: "TimeoutError",
							message:
								"The script was stopped at its time limit. Actions before that may have happened. The browser is still open.",
						}
					: {
							name: sandbox.error?.name ?? "Error",
							message: snippet_executor_cap_message(sandbox.error?.message ?? "Unknown error"),
						},
			},
			200,
		);
	}

	// Trust nothing from the isolate: re-check every bound on the host.
	const resultJson = typeof sandbox.resultJson === "string" ? sandbox.resultJson : "null";
	const resultBytes = byte_length(resultJson);
	const files = snippet_executor_check_files(sandbox.files);
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
	const finished = await finish(false, {
		resultBytes,
		fileCount: files.files.length,
		fileBytes: files.fileBytes,
		viewport: snippetViewport(sandbox.viewport),
		...(stateJson === null ? {} : { stateJson }),
	});
	// Web mode: the files the page downloaded during the command. They share the 8-file, 8 MiB
	// output limit with `emitFile` files, which come first. Downloads over the limit are dropped.
	const downloads: Array<{ name: string; contentType: string; dataBase64: string }> = [];
	let downloadsDropped =
		is_record(finished) && is_positive_int(finished.downloadsDropped) ? finished.downloadsDropped : 0;
	let outputCount = files.files.length;
	let outputBytes = files.fileBytes;
	for (const item of is_record(finished) && Array.isArray(finished.downloads)
		? (finished.downloads as unknown[])
		: []) {
		const size =
			is_record(item) && typeof item.dataBase64 === "string" ? base64_bytes(item.dataBase64)?.byteLength : undefined;
		if (
			!is_record(item) ||
			typeof item.name !== "string" ||
			typeof item.contentType !== "string" ||
			typeof item.dataBase64 !== "string" ||
			size === undefined ||
			outputCount >= LIMITS.files ||
			outputBytes + size > LIMITS.fileBytes
		) {
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
			stateWarnings,
			error: null,
		},
		200,
	);
}

async function handle_browser_run(args: { request: Request; env: Env; ctx?: BrowserRunnerContext }): Promise<Response> {
	const { request, env, ctx } = args;

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
		return json_response({ ok: false, error: { code: "too_large", message: "`code` exceeds the size limit." } }, 413);
	}
	if (
		!is_non_empty_string(body.commandId) ||
		body.commandId.length > 128 ||
		!is_command_source(body.source) ||
		!is_positive_int(body.deadline) ||
		body.deadline > Date.now() + LIMITS.childWallMs ||
		!is_positive_int(body.receiptResolutionDeadline) ||
		body.receiptResolutionDeadline < body.deadline ||
		body.receiptResolutionDeadline > Date.now() + 120_000
	)
		return invalid_request("A bounded command identity is required.");
	if (
		body.mode === "web" &&
		(!is_non_empty_string(body.tabId) || !is_positive_int(body.tabGen) || !is_revision(body.policyRevision))
	)
		return invalid_request("The web tab lease is required.");
	const commandId = body.commandId;
	const codeHash = await sha256_hex(`browser-v3\n${body.code}`);
	const receiptIdentity = {
		sessionId: body.sessionId,
		commandId,
		codeHash,
		source: body.source,
		deadline: body.deadline,
		receiptResolutionDeadline: body.receiptResolutionDeadline,
	};

	const stub = session_stub({
		env,
		ownerId: owners.ownerId,
		organizationId: owners.organizationId,
		workspaceId: owners.workspaceId,
		mode: owners.mode,
	});
	const claim = await object_json({
		stub,
		path: "/run/claim",
		body: {
			...receiptIdentity,
			payloadHash: await sha256_hex(JSON.stringify(body)),
		},
	});
	if (!is_record(claim) || claim.ok !== true || claim.execute !== true)
		return json_response(is_record(claim) ? claim : { ok: false, error: { code: "claim_failed" } }, 200);
	const begin = await object_json({
		stub,
		path: "/run/begin",
		body: {
			sessionId: body.sessionId,
			navGen: body.navGen,
			loadGen: body.loadGen,
			controlGen: body.controlGen,
			commandId,
			deadline: body.deadline,
			tabId: body.tabId,
			tabGen: body.tabGen,
			policyRevision: body.policyRevision,
		},
	});
	if (!is_record(begin) || begin.ok !== true || !is_record(begin.lease)) {
		await object_json({
			stub,
			path: "/run/complete",
			body: {
				...receiptIdentity,
				status: "refused",
				cleanup: "complete",
				reason: is_record(begin) && is_record(begin.error) ? begin.error.code : "begin_failed",
				session: null,
			},
		});
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
	const runState = {
		finished: false,
		session: null as Record<string, unknown> | null,
		cleanup: "unknown" as "complete" | "unknown",
	};
	const finish = async (
		tainted: boolean,
		meta: {
			resultBytes: number;
			fileCount: number;
			fileBytes: number;
			viewport: { width: number; height: number } | null;
			stateJson?: string;
		},
	) => {
		const finished = await object_json({
			stub,
			path: "/run/finish",
			body: {
				sessionId: body.sessionId,
				commandId,
				tainted,
				...meta,
			},
		});
		runState.finished = true;
		if (is_record(finished)) {
			runState.session = is_record(finished.session) ? finished.session : null;
			runState.cleanup = finished.cleanup === "complete" ? "complete" : "unknown";
		}
		return finished;
	};
	try {
		const response = await with_wall_timeout(
			execute_browser_command({
				env,
				ctx,
				body,
				commandId,
				lease,
				finish,
				connection: {
					mode: owners.mode,
					sessionId: body.sessionId,
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
					workspaceId: owners.workspaceId,
					commandId,
				},
				deadline: body.deadline,
				settle: () => object_json({ stub, path: "/run/settle", body: { sessionId: body.sessionId, commandId } }),
			}),
			Math.max(1, body.deadline - Date.now()),
		);
		const result: unknown = await response.json();
		if (!is_record(result)) throw new Error("Invalid command result.");
		await object_json({
			stub,
			path: "/run/complete",
			body: {
				...receiptIdentity,
				status: runState.cleanup === "complete" ? "completed" : "unknown",
				cleanup: runState.cleanup,
				reason: result.status === "succeeded" ? null : "command_failed",
				session: runState.session,
			},
		});
		return json_response({ ...result, session: runState.session }, response.status);
	} catch {
		return json_response(
			{
				ok: true,
				status: "unknown",
				commandId,
				codeHash,
				session: null,
				result: { cleanup: "unknown", reason: "outcome_unknown" },
			},
			200,
		);
	} finally {
		if (!runState.finished) {
			try {
				await object_json({
					stub,
					path: "/run/finish",
					body: {
						sessionId: body.sessionId,
						commandId,
						tainted: true,
						resultBytes: 0,
						fileCount: 0,
						fileBytes: 0,
						viewport: null,
					},
				});
			} catch {
				// The command deadline closes a session whose finish was lost.
			}
		}
		if (!runState.finished) await object_json({ stub, path: "/command-fence", body: receiptIdentity }).catch(() => {});
	}
}

async function handle_browser_command_receipt(args: { request: Request; env: Env; path: string }): Promise<Response> {
	const { request, env, path } = args;

	if (!(await is_authorized(request, env))) return json_response({ ok: false, error: { code: "unauthorized" } }, 401);
	const parsed = await parse_json_body(request, BROWSER_COMMAND_FIELDS);
	if (!parsed.ok) return parsed.response;
	const owners = parse_owner_tuple(parsed.body);
	if (!owners.ok) return owners.response;
	const response = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path,
		body: parsed.body,
	});
	return json_response(is_record(response) ? response : { ok: false, error: { code: "receipt_failed" } }, 200);
}

async function handle_browser_tab(args: { request: Request; env: Env; path: string }): Promise<Response> {
	const { request, env, path } = args;

	const access =
		path === "/operation-status" ? await is_authorized(request, env) : (await require_host_access(request, env)).ok;
	if (!access) return operation_refused("unavailable", "Browser management is unavailable.");
	const parsed = await parse_json_body(request, BROWSER_OPERATION_FIELDS);
	if (!parsed.ok) return parsed.response;
	const owners = parse_owner_tuple(parsed.body);
	if (!owners.ok) return owners.response;
	if (path !== "/operation-status" && !is_non_empty_string(parsed.body.sessionId))
		return invalid_request("`sessionId` is required.");
	const response = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path,
		body: parsed.body,
	});
	return json_response(is_record(response) ? response : { ok: false, error: { code: "operation_failed" } }, 200);
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
		if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be positive.");
		if (body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease)) {
			return invalid_request("`expectedAgentLease` must contain positive nav, load, and control generations.");
		}
		return managed_operation({
			env,
			owners,
			body,
			path: "/reload",
			work: async () => {
				const reloaded = await object_json({
					stub: session_stub({
						env,
						ownerId: owners.ownerId,
						organizationId: owners.organizationId,
						workspaceId: owners.workspaceId,
						mode: owners.mode,
					}),
					path: "/reload",
					body: {
						mode: "web",
						sessionId: body.sessionId,
						navGen: body.navGen,
						expectedAgentLease: body.expectedAgentLease,
					},
				});
				return json_response(is_record(reloaded) ? reloaded : { ok: false, error: { code: "reload_failed" } }, 200);
			},
		});
	}
	if (body.mode !== undefined && body.mode !== "file") return invalid_request("`mode` must be file or web.");
	const snapshot = parse_snapshot(body);
	if (!snapshot.ok) return snapshot.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (!is_positive_int(body.navGen)) return invalid_request("`navGen` must be a positive int.");
	if (body.expectedAgentLease !== undefined && !is_agent_lease(body.expectedAgentLease)) {
		return invalid_request("`expectedAgentLease` must contain positive nav, load, and control generations.");
	}

	return managed_operation({
		env,
		owners,
		body,
		path: "/reload",
		work: async () => {
			const reloaded = await object_json({
				stub: session_stub({
					env,
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
					workspaceId: owners.workspaceId,
					mode: owners.mode,
				}),
				path: "/reload",
				body: {
					mode: "file",
					sessionId: body.sessionId,
					navGen: body.navGen,
					sourceKind: snapshot.sourceKind,
					sourceVersion: snapshot.sourceVersion,
					sourceHash: snapshot.sourceHash,
					html: snapshot.html,
					expectedAgentLease: body.expectedAgentLease,
				},
			});
			return json_response(is_record(reloaded) ? reloaded : { ok: false, error: { code: "reload_failed" } }, 200);
		},
	});
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
	if (
		body.expectedAgentLease !== undefined &&
		(!is_agent_lease(body.expectedAgentLease) || !is_non_empty_string(body.sessionId))
	) {
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
	return managed_operation({
		env,
		owners,
		body,
		path: "/close",
		work: async () => {
			const closed = await object_json({
				stub: session_stub({
					env,
					ownerId: owners.ownerId,
					organizationId: owners.organizationId,
					workspaceId: owners.workspaceId,
					mode: owners.mode,
				}),
				path: "/close",
				body: {
					sessionId: body.sessionId,
					expectedAgentLease: body.expectedAgentLease,
					saveProfile: body.saveProfile,
					by,
				},
			});
			return json_response(is_record(closed) ? closed : { ok: false, error: { code: "close_failed" } }, 200);
		},
	});
}

async function handle_browser_profile(args: {
	request: Request;
	env: Env;
	route: "summary" | "clear";
}): Promise<Response> {
	const { request, env, route } = args;

	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(
		request,
		route === "summary" ? BROWSER_PROFILE_SUMMARY_FIELDS : BROWSER_PROFILE_CLEAR_FIELDS,
	);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_profile_id(body.profileId)) return invalid_request("`profileId` is invalid.");
	if (!is_profile_key(body.profileKey)) return invalid_request("`profileKey` must be 32 bytes in base64.");
	if (route === "clear" && (!is_non_empty_string(body.domain) || body.domain.length > LIMITS.hostChars)) {
		return invalid_request("`domain` is invalid.");
	}

	const replied = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: `/profile/${route}`,
		body: {
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			profileId: body.profileId,
			profileKey: body.profileKey,
			...(route === "clear" ? { domain: body.domain } : {}),
		},
	});
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

	const deleted = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/profile/delete",
		body: { profileId: body.profileId },
	});
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

async function handle_browser_download(args: {
	request: Request;
	env: Env;
	route: "info" | "push";
}): Promise<Response> {
	const { request, env, route } = args;

	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(
		request,
		route === "info" ? BROWSER_DOWNLOAD_INFO_FIELDS : BROWSER_DOWNLOAD_PUSH_FIELDS,
	);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_item_id(body.sessionId) || !is_item_id(body.downloadId))
		return invalid_request("`sessionId` and `downloadId` are required.");
	if (route === "push") {
		if (!is_signed_url(body.url)) return invalid_request("`url` must be an https URL.");
		// The signed PUT may need a few headers, like `Content-Type`. Keep them plain and small.
		const headers = is_record(body.headers) ? Object.entries(body.headers) : null;
		if (
			!headers ||
			headers.length > 20 ||
			!headers.every(
				([name, value]) =>
					/^[A-Za-z0-9-]{1,64}$/u.test(name) &&
					typeof value === "string" &&
					value.length <= 1024 &&
					!/[\r\n]/u.test(value),
			)
		) {
			return invalid_request("`headers` is invalid.");
		}
	}

	const replied = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: `/download/${route}`,
		body: {
			sessionId: body.sessionId,
			downloadId: body.downloadId,
			...(route === "push" ? { url: body.url, headers: body.headers } : {}),
		},
	});
	return json_response(is_record(replied) ? replied : { ok: false, error: { code: "download_failed" } }, 200);
}

async function handle_browser_upload(args: { request: Request; env: Env; route: "fill" | "grant" }): Promise<Response> {
	const { request, env, route } = args;

	const access = await require_host_access(request, env);
	if (!access.ok) return access.response;

	const parsed = await parse_json_body(
		request,
		route === "fill" ? BROWSER_UPLOAD_FILL_FIELDS : BROWSER_UPLOAD_GRANT_FIELDS,
	);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_item_id(body.sessionId) || !is_item_id(body.chooserId))
		return invalid_request("`sessionId` and `chooserId` are required.");
	if (!is_positive_int(body.controlGen)) return invalid_request("`controlGen` must be a positive int.");
	if (!is_item_id(body.tabId) || !is_positive_int(body.tabGen) || !is_positive_int(body.viewGen))
		return invalid_request("A tab and its view are required.");
	if (route === "fill") {
		if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > LIMITS.uploadFiles) {
			return invalid_request("`files` must have 1 to 10 items.");
		}
		for (const file of body.files as unknown[]) {
			if (
				!is_record(file) ||
				Object.keys(file).some((key) => !BROWSER_UPLOAD_FILE_FIELDS.has(key)) ||
				!is_non_empty_string(file.name) ||
				file.name.length > 255 ||
				!is_non_empty_string(file.contentType) ||
				file.contentType.length > 255 ||
				!is_signed_url(file.url)
			) {
				return invalid_request("`files` has an invalid item.");
			}
		}
	}

	const replied = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: `/upload/${route}`,
		body: {
			sessionId: body.sessionId,
			chooserId: body.chooserId,
			controlGen: body.controlGen,
			tabId: body.tabId,
			tabGen: body.tabGen,
			viewGen: body.viewGen,
			...(route === "fill" ? { files: body.files } : {}),
		},
	});
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

	const kept = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/keep-open",
		body: { sessionId: body.sessionId, navGen: body.navGen, controlGen: body.controlGen },
	});
	return json_response(is_record(kept) ? kept : { ok: false, error: { code: "keep_open_failed" } }, 200);
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

	const status = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/status",
		body: { sessionId: body.sessionId },
	});
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

	const granted = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/viewer/grant",
		body: { sessionId: body.sessionId, navGen: body.navGen },
	});
	return json_response(is_record(granted) ? granted : { ok: false, error: { code: "grant_failed" } }, 200);
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

	const renewed = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/viewer/renew",
		body: { sessionId: body.sessionId, viewerId: body.viewerId },
	});
	return json_response(is_record(renewed) ? renewed : { ok: false, error: { code: "renew_failed" } }, 200);
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

	const taken = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/control/take-human",
		body: { sessionId: body.sessionId, navGen: body.navGen, viewerId: body.viewerId },
	});
	return json_response(is_record(taken) ? taken : { ok: false, error: { code: "take_failed" } }, 200);
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
	if (!is_positive_int(body.controlGen)) return invalid_request("`controlGen` must be a positive int.");

	const resumed = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/control/to-agent",
		body: { sessionId: body.sessionId, navGen: body.navGen, controlGen: body.controlGen },
	});
	return json_response(is_record(resumed) ? resumed : { ok: false, error: { code: "resume_failed" } }, 200);
}

async function handle_browser_agent_access(request: Request, env: Env): Promise<Response> {
	if (!(await is_authorized(request, env))) return json_response({ ok: false, error: { code: "unauthorized" } }, 401);

	const parsed = await parse_json_body(request, BROWSER_AGENT_ACCESS_FIELDS);
	if (!parsed.ok) return parsed.response;
	const body = parsed.body;

	const owners = parse_owner_tuple(body);
	if (!owners.ok) return owners.response;
	if (!is_non_empty_string(body.sessionId)) return invalid_request("`sessionId` is required.");
	if (typeof body.on !== "boolean") return invalid_request("`on` must be a boolean.");
	if (
		!is_revision(body.policyRevision) ||
		!Array.isArray(body.agentBlockedHosts) ||
		!body.agentBlockedHosts.every((host) => typeof host === "string") ||
		body.agentBlockedHosts.length > 200
	)
		return invalid_request("A bounded policy is required.");

	const changed = await object_json({
		stub: session_stub({
			env,
			ownerId: owners.ownerId,
			organizationId: owners.organizationId,
			workspaceId: owners.workspaceId,
			mode: owners.mode,
		}),
		path: "/agent-access",
		body: {
			sessionId: body.sessionId,
			on: body.on,
			policyRevision: body.policyRevision,
			agentBlockedHosts: body.agentBlockedHosts,
		},
	});
	return json_response(is_record(changed) ? changed : { ok: false, error: { code: "agent_access_failed" } }, 200);
}

// Viewer stream gateway
//
// The host routes the upgrade by its non-secret owner scope. The session object
// consumes the grant, shares one frame producer, and checks each input locally.

type ViewerHello = {
	mode: SessionMode;
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

export function parse_viewer_input(data: unknown):
	| {
			ok: true;
			seq: string | number;
			controlGen: number;
			loadGen: number;
			tabId: string;
			tabGen: number;
			viewGen: number;
			input: ViewerInput;
	  }
	| { ok: false } {
	if (typeof data !== "string" || data.length === 0 || data.length > LIMITS.viewerMessageChars) return { ok: false };
	let body: unknown;
	try {
		body = JSON.parse(data);
	} catch {
		return { ok: false };
	}
	if (!is_record(body) || body.t !== "input") return { ok: false };
	if (typeof body.seq !== "string" && typeof body.seq !== "number") return { ok: false };
	if (
		!is_positive_int(body.controlGen) ||
		!Number.isSafeInteger(body.controlGen) ||
		!is_positive_int(body.loadGen) ||
		!Number.isSafeInteger(body.loadGen)
	)
		return { ok: false };
	if (
		!is_non_empty_string(body.tabId) ||
		body.tabId.length > 256 ||
		!is_positive_int(body.tabGen) ||
		!is_positive_int(body.viewGen)
	)
		return { ok: false };
	const lease = {
		controlGen: body.controlGen,
		loadGen: body.loadGen,
		tabId: body.tabId,
		tabGen: body.tabGen,
		viewGen: body.viewGen,
	};

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
					input: {
						kind: body.kind,
						button: is_button(body.button) ? body.button : "left",
						clickCount: body.clickCount,
					},
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
function parse_viewer_nav(body: unknown):
	| {
			ok: true;
			seq: string | number;
			controlGen: number;
			tabId: string;
			tabGen: number;
			viewGen: number;
			nav: ViewerNav;
	  }
	| { ok: false } {
	if (!is_record(body) || body.t !== "nav") return { ok: false };
	if (typeof body.seq !== "string" && typeof body.seq !== "number") return { ok: false };
	if (!is_positive_int(body.controlGen) || !Number.isSafeInteger(body.controlGen)) return { ok: false };
	if (!is_non_empty_string(body.tabId) || !is_positive_int(body.tabGen) || !is_positive_int(body.viewGen))
		return { ok: false };
	const lease = { controlGen: body.controlGen, tabId: body.tabId, tabGen: body.tabGen, viewGen: body.viewGen };
	if (body.action === "go") {
		if (typeof body.url !== "string") return { ok: false };
		return { ok: true, seq: body.seq, ...lease, nav: { action: "go", url: body.url } };
	}
	if (body.action === "back" || body.action === "forward" || body.action === "reload" || body.action === "stop") {
		if (body.url !== undefined) return { ok: false };
		return { ok: true, seq: body.seq, ...lease, nav: { action: body.action } };
	}
	return { ok: false };
}

/**
 * Run one address bar action on the page. Return null on success or a refusal code.
 */
async function apply_viewer_nav(args: {
	cdp: CDPSession;
	action: ViewerNav["action"];
	url: string | null;
}): Promise<string | null> {
	const { cdp, action, url } = args;

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
		(body.mode !== "file" && body.mode !== "web") ||
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
			mode: body.mode,
			ownerId: body.ownerId,
			organizationId: body.organizationId,
			workspaceId: body.workspaceId,
			grantId: body.grantId,
			host: body.host,
		},
	};
}

function close_socket(args: { socket: WebSocket; code: number; reason: string }): void {
	const { socket, code, reason } = args;

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
		mode: url.searchParams.get("mode"),
	});
	if (!owners.ok) return owners.response;
	return session_stub({
		env,
		ownerId: owners.ownerId,
		organizationId: owners.organizationId,
		workspaceId: owners.workspaceId,
		mode: owners.mode,
	}).fetch(request);
}

/**
 * `PUT /viewer/upload`: one file from the user's computer for the open file chooser. It is public:
 * the single-use grant in the query is the secret. Only the app origins in `BROWSER_APP_ORIGINS`
 * may call it from a browser (CORS).
 */
async function handle_viewer_upload(request: Request, env: Env): Promise<Response> {
	const origin = request.headers.get("Origin");
	const cors =
		origin && app_origins(env).includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : null;
	if (request.method === "OPTIONS") {
		// A refused preflight has no CORS headers, so the browser never sends the PUT.
		if (!cors || request.headers.get("Access-Control-Request-Method") !== "PUT")
			return new Response(null, { status: 403 });
		return new Response(null, {
			status: 204,
			headers: {
				...cors,
				"Access-Control-Allow-Methods": "PUT",
				"Access-Control-Allow-Headers": "Content-Type",
				"Access-Control-Max-Age": "600",
			},
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
		mode: url.searchParams.get("mode"),
	});
	const name = url.searchParams.get("name") ?? "";
	if (!owners.ok || !is_item_id(url.searchParams.get("grantId")) || name.length < 1 || name.length > 255) {
		return reply(json_response({ ok: false, code: "invalid_request" }, 400));
	}
	// Refuse a large file before reading it. The session object still caps the bytes it reads.
	const length = request.headers.get("Content-Length");
	if (length === null || !/^\d+$/u.test(length))
		return reply(json_response({ ok: false, code: "length_required" }, 411));
	if (Number(length) > LIMITS.uploadBytes) return reply(json_response({ ok: false, code: "too_large" }, 413));

	// A throw would reach the browser as a bare 500 without CORS headers, which the app cannot read.
	try {
		return reply(
			await session_stub({
				env,
				ownerId: owners.ownerId,
				organizationId: owners.organizationId,
				workspaceId: owners.workspaceId,
				mode: owners.mode,
			}).fetch(request),
		);
	} catch (error) {
		log_browser({ route: "viewer_upload", error: sanitize_error(error).name });
		return reply(json_response({ ok: false, code: "upload_failed" }, 500));
	}
}

export async function handle_request(request: Request, env: Env, ctx?: BrowserRunnerContext): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "POST" && url.pathname.startsWith("/internal/playwriter/")) {
		if (!(await is_authorized(request, env)))
			return json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401);
		if (
			env.BROWSER_RUNNER_DISABLED === "true" &&
			!["status", "disconnect", "agent-access", "pause", "command-status", "command-fence", "command-ack"].includes(
				url.pathname.split("/").at(-1)!,
			)
		)
			return json_response({ ok: false, error: { code: "disabled", message: "Browser runner is disabled" } }, 503);
		return handle_playwriter_request({ request, env, ctx });
	}
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
		return handle_browser_run({ request, env, ctx });
	}
	if (
		request.method === "POST" &&
		["/internal/browser/command-status", "/internal/browser/command-fence"].includes(url.pathname)
	)
		return handle_browser_command_receipt({ request, env, path: url.pathname.slice("/internal/browser".length) });
	if (
		request.method === "POST" &&
		[
			"/internal/browser/tabs",
			"/internal/browser/tab-new",
			"/internal/browser/tab-close",
			"/internal/browser/tab-select",
			"/internal/browser/operation-status",
		].includes(url.pathname)
	)
		return handle_browser_tab({ request, env, path: url.pathname.slice("/internal/browser".length) });
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
		return handle_browser_profile({ request, env, route: "summary" });
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/profile-clear") {
		return handle_browser_profile({ request, env, route: "clear" });
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/profile-delete") {
		return handle_browser_profile_delete(request, env);
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/download-info") {
		return handle_browser_download({ request, env, route: "info" });
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/download-push") {
		return handle_browser_download({ request, env, route: "push" });
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/upload-fill") {
		return handle_browser_upload({ request, env, route: "fill" });
	}
	if (request.method === "POST" && url.pathname === "/internal/browser/upload-grant") {
		return handle_browser_upload({ request, env, route: "grant" });
	}
	if ((request.method === "PUT" || request.method === "OPTIONS") && url.pathname === "/viewer/upload") {
		return handle_viewer_upload(request, env);
	}
	return json_response({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
	fetch: handle_request,
};
