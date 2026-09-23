import { afterEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import * as provider from "@cloudflare/playwright";
import {
	BrowserRegistry,
	BrowserSession,
	LIMITS,
	build_controller_html,
	build_executor_module,
	cap_snippet_string_lists,
	handle_request,
	parse_viewer_hello,
	parse_viewer_input,
	session_can_run,
	session_is_expired,
	session_next_alarm,
	validate_gate_request,
	validate_snippet_files,
	handle_gate_request,
	type Env,
} from "./index";

const URL_BASE = "https://runner.internal";
const OWNERS = { ownerId: "user_1", organizationId: "org_1", workspaceId: "ws_1" };
const PROFILE_SECRET = Buffer.alloc(32, 1).toString("base64");
const PROFILE = { profileId: "profile_1", profileKey: Buffer.alloc(32, 7).toString("base64"), agentBlockedHosts: [] as string[] };

type SessionRecord = Parameters<typeof session_can_run>[0];
type DurableObjectState = ConstructorParameters<typeof BrowserRegistry>[0];

type ObjectHandler = (path: string, body: unknown) => unknown;

function make_namespace(handler: ObjectHandler = () => ({ ok: true })) {
	return {
		idFromName: (name: string) => ({ toString: () => name }),
		get: () => ({
			fetch: async (request: Request) => {
				const url = new URL(request.url);
				return Response.json(await handler(url.pathname, await request.json()));
			},
		}),
	};
}

function make_env(opts: {
	secret?: string;
	disabled?: boolean;
	previewUrl?: string;
	sessions?: ObjectHandler;
	registry?: ObjectHandler;
}): Env {
	return {
		BROWSER: { fetch },
		LOADER: {
			load: () => ({ getEntrypoint: () => ({ evaluate: async () => null }) }),
		} as unknown as Env["LOADER"],
		BROWSER_SESSIONS: make_namespace(opts.sessions),
		BROWSER_REGISTRY: make_namespace(opts.registry),
		BROWSER_RUNNER_SECRET: opts.secret ?? "test-secret",
		BROWSER_PROFILE_KEY: PROFILE_SECRET,
		BROWSER_RUNNER_DISABLED: opts.disabled ? "true" : undefined,
		BROWSER_PREVIEW_URL: opts.previewUrl ?? "https://preview.invalid/v0",
	};
}

function browser_request(
	route: "open" | "reload" | "run" | "close" | "keep-open" | "status",
	rawBody: string,
	headers: Record<string, string> = { Authorization: "Bearer test-secret" },
): Request {
	return new Request(`${URL_BASE}/internal/browser/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: rawBody,
	});
}

function make_storage(initial: Record<string, unknown> = {}) {
	const map = new Map<string, unknown>(Object.entries(initial));
	const alarms: Array<number | Date | null> = [];
	return {
		map,
		alarms,
		state: {
			id: { toString: () => "test-id" },
			storage: {
				get: async <T,>(key: string) => map.get(key) as T | undefined,
				list: async <T,>(options: { prefix: string }) =>
					new Map([...map].filter(([key]) => key.startsWith(options.prefix))) as Map<string, T>,
				put: async (key: string, value: unknown) => {
					map.set(key, value);
				},
				delete: async (key: string) => map.delete(key),
				setAlarm: async (time: number | Date) => {
					alarms.push(time);
				},
				getAlarm: async () => null,
				deleteAlarm: async () => {
					alarms.push(null);
				},
			},
			waitUntil: () => {},
		},
	};
}

function make_record(overrides: Partial<SessionRecord> = {}): SessionRecord {
	const now = Date.now();
	return {
		mode: "file",
		version: 1,
		sessionId: "session-1",
		grantId: "grant-1",
		ownerId: "user_1",
		organizationId: "org_1",
		workspaceId: "ws_1",
		nodeId: "node_1",
		navGen: 1,
		loadGen: 1,
		controlGen: 1,
		control: "ready",
		sourceKind: "saved",
		sourceVersion: "v1",
		sourceHash: "hash",
		providerSessionId: "provider-1",
		pageNonce: "nonce-1",
		viewport: { width: 1280, height: 900 },
		command: null,
		commandCount: 0,
		htmlBytesTotal: 100,
		loadCount: 1,
		createdAt: now,
		providerAcquiredAt: now,
		lastActiveAt: now,
		attemptId: "attempt-1",
		closeAttempts: 0,
		...overrides,
	} as SessionRecord;
}


describe("routing", () => {
	it("returns ok for GET /health", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/health`), make_env({}));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown routes", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/nope`), make_env({}));
		expect(res.status).toBe(404);
	});
});

describe("auth", () => {
	it.each(["open", "reload", "run", "close", "keep-open", "status"] as const)("rejects %s without a token", async (route) => {
		const res = await handle_request(browser_request(route, JSON.stringify({}), {}), make_env({}));
		expect(res.status).toBe(401);
	});

	it.each(["open", "reload", "run", "close", "keep-open", "status"] as const)("rejects %s with the wrong token", async (route) => {
		const res = await handle_request(
			browser_request(route, JSON.stringify({}), { Authorization: "Bearer wrong" }),
			make_env({}),
		);
		expect(res.status).toBe(401);
	});

	it("fails closed when the secret is empty", async () => {
		const res = await handle_request(
			browser_request("open", JSON.stringify({}), { Authorization: "Bearer test-secret" }),
			make_env({ secret: "" }),
		);
		expect(res.status).toBe(401);
	});
});

describe("kill switch", () => {
	it.each(["open", "reload", "run", "keep-open"] as const)("returns 503 for %s while disabled", async (route) => {
		const res = await handle_request(browser_request(route, JSON.stringify({})), make_env({ disabled: true }));
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe("disabled");
	});

	it("permits close while disabled", async () => {
		const res = await handle_request(
			browser_request("close", JSON.stringify({ ...OWNERS, sessionId: "s" })),
			make_env({ disabled: true }),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).ok).toBe(true);
	});
});

describe("open validation", () => {
	const valid = () => ({
		mode: "file",
		...OWNERS,
		nodeId: "node_1",
		navGen: 1,
		sourceKind: "saved",
		sourceVersion: "v1",
		sourceHash: "hash",
		html: "<p>hi</p>",
	});

	it("rejects unknown fields", async () => {
		const res = await handle_request(
			browser_request("open", JSON.stringify({ ...valid(), surprise: 1 })),
			make_env({}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects a missing owner tuple", async () => {
		const res = await handle_request(browser_request("open", JSON.stringify({ nodeId: "n" })), make_env({}));
		expect(res.status).toBe(400);
	});

	it("rejects a bad viewport", async () => {
		const res = await handle_request(
			browser_request("open", JSON.stringify({ ...valid(), viewport: { width: 10, height: 10 } })),
			make_env({}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects an unknown source kind", async () => {
		const res = await handle_request(
			browser_request("open", JSON.stringify({ ...valid(), sourceKind: "live" })),
			make_env({}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects oversize html", async () => {
		const res = await handle_request(
			browser_request("open", JSON.stringify({ ...valid(), html: "x".repeat(LIMITS.htmlBytes + 1) })),
			make_env({}),
		);
		expect(res.status).toBe(413);
	});

	it("passes a valid open through claim, session, and confirm", async () => {
		const calls: string[] = [];
		const env = make_env({
			registry: (path) => {
				calls.push(`registry:${path}`);
				return path === "/claim" ? { ok: true, grantId: "g1" } : { ok: true };
			},
			sessions: (path) => {
				calls.push(`session:${path}`);
				return { ok: true, session: { sessionId: "s1" } };
			},
		});
		const res = await handle_request(browser_request("open", JSON.stringify(valid())), env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, session: { sessionId: "s1" } });
		expect(calls).toEqual(["registry:/claim", "session:/open", "registry:/confirm"]);
	});

	it("releases the grant when the session refuses", async () => {
		const calls: string[] = [];
		const env = make_env({
			registry: (path) => {
				calls.push(`registry:${path}`);
				return path === "/claim" ? { ok: true, grantId: "g1" } : { ok: true };
			},
			sessions: () => ({ ok: false, error: { code: "busy", message: "busy" } }),
		});
		const validBody = {
			mode: "file",
			...OWNERS,
			nodeId: "node_1",
			navGen: 1,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			html: "<p>hi</p>",
		};
		const res = await handle_request(browser_request("open", JSON.stringify(validBody)), env);
		expect(res.status).toBe(200);
		expect((await res.json()).error.code).toBe("busy");
		expect(calls).toEqual(["registry:/claim", "registry:/release"]);
	});

	it("refuses before touching the session when the registry is busy", async () => {
		let sessionCalls = 0;
		const env = make_env({
			registry: () => ({ ok: false, error: { code: "workspace_busy" } }),
			sessions: () => {
				sessionCalls += 1;
				return { ok: true };
			},
		});
		const validBody = {
			mode: "file",
			...OWNERS,
			nodeId: "node_1",
			navGen: 1,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			html: "<p>hi</p>",
		};
		const res = await handle_request(browser_request("open", JSON.stringify(validBody)), env);
		expect((await res.json()).error.code).toBe("workspace_busy");
		expect(sessionCalls).toBe(0);
	});

	it("passes a web open through the claim with the owner ids", async () => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({
			registry: (path, body) => {
				received.push([`registry:${path}`, body]);
				return path === "/claim" ? { ok: true, grantId: "g1" } : { ok: true };
			},
			sessions: (path, body) => {
				received.push([`session:${path}`, body]);
				return { ok: true, session: { sessionId: "s1" } };
			},
		});
		const res = await handle_request(browser_request("open", JSON.stringify({
			mode: "web", ...OWNERS, navGen: 1, startUrl: "example.com", agentAccess: false, ...PROFILE, agentBlockedHosts: ["bank.test"],
		})), env);
		expect(res.status).toBe(200);
		expect(received).toEqual([
			["registry:/claim", { workspaceKey: expect.any(String), ownerId: "user_1", organizationId: "org_1" }],
			["session:/open", {
				mode: "web", startUrl: "example.com", agentAccess: false, ...PROFILE, agentBlockedHosts: ["bank.test"], grantId: "g1", attemptId: expect.any(String),
				...OWNERS, navGen: 1, viewport: { width: 1280, height: 900 },
			}],
			["registry:/confirm", { grantId: "g1" }],
		]);
	});

	it.each([
		{ name: "no mode", body: { mode: undefined } },
		{ name: "a file field", body: { nodeId: "node_1" } },
		{ name: "navGen 2", body: { navGen: 2 } },
		{ name: "no agentAccess", body: { agentAccess: undefined } },
		{ name: "a number startUrl", body: { startUrl: 1 } },
		{ name: "no profileId", body: { profileId: undefined } },
		{ name: "a profileId with a colon", body: { profileId: "a:b" } },
		{ name: "no profileKey", body: { profileKey: undefined } },
		{ name: "a short profileKey", body: { profileKey: Buffer.alloc(16).toString("base64") } },
		{ name: "a profileKey that is not base64", body: { profileKey: "not base64!" } },
		{ name: "no agentBlockedHosts", body: { agentBlockedHosts: undefined } },
		{ name: "51 agentBlockedHosts", body: { agentBlockedHosts: Array.from({ length: 51 }, (_, index) => `site${index}.test`) } },
		{ name: "a 254-char blocked host", body: { agentBlockedHosts: ["a".repeat(254)] } },
		{ name: "an empty blocked host", body: { agentBlockedHosts: [""] } },
	])("rejects a web open with $name", async ({ body }) => {
		let calls = 0;
		const env = make_env({ registry: () => { calls += 1; return { ok: true, grantId: "g1" }; } });
		const res = await handle_request(browser_request("open", JSON.stringify({
			mode: "web", ...OWNERS, navGen: 1, startUrl: null, agentAccess: true, ...PROFILE, ...body,
		})), env);
		expect(res.status).toBe(400);
		expect(calls).toBe(0);
	});
});

describe("web host routes", () => {
	function host_request(route: "agent-access" | "reload", body: unknown, headers: Record<string, string> = { Authorization: "Bearer test-secret" }) {
		return new Request(`${URL_BASE}/internal/browser/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	}

	it("passes agent access through to the session", async () => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({ sessions: (path, body) => { received.push([path, body]); return { ok: true, session: { agentAccess: false } }; } });
		const res = await handle_request(host_request("agent-access", { ...OWNERS, sessionId: "session-1", on: false }), env);
		expect(await res.json()).toEqual({ ok: true, session: { agentAccess: false } });
		expect(received).toEqual([["/agent-access", { sessionId: "session-1", on: false }]]);
	});

	it.each([
		{ name: "a string flag", body: { ...OWNERS, sessionId: "session-1", on: "false" } },
		{ name: "an unknown field", body: { ...OWNERS, sessionId: "session-1", on: false, url: "https://example.com/" } },
		{ name: "no session id", body: { ...OWNERS, on: false } },
	])("rejects agent access with $name", async ({ body }) => {
		let calls = 0;
		const env = make_env({ sessions: () => { calls += 1; return { ok: true }; } });
		expect((await handle_request(host_request("agent-access", body), env)).status).toBe(400);
		expect(calls).toBe(0);
	});

	it("refuses agent access without a token", async () => {
		const res = await handle_request(host_request("agent-access", { ...OWNERS, sessionId: "session-1", on: false }, {}), make_env({}));
		expect(res.status).toBe(401);
	});

	it("routes a web reload without a file snapshot", async () => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({ sessions: (path, body) => { received.push([path, body]); return { ok: true }; } });
		const expectedAgentLease = { navGen: 1, loadGen: 1, controlGen: 2 };
		const res = await handle_request(host_request("reload", { mode: "web", ...OWNERS, sessionId: "session-1", navGen: 1, expectedAgentLease }), env);
		expect(res.status).toBe(200);
		expect(received).toEqual([["/reload", { mode: "web", sessionId: "session-1", navGen: 1, expectedAgentLease }]]);
	});

	it.each([
		{ name: "a file field", body: { html: "<p></p>" } },
		{ name: "navGen 2", body: { navGen: 2 } },
	])("rejects a web reload with $name", async ({ body }) => {
		let calls = 0;
		const env = make_env({ sessions: () => { calls += 1; return { ok: true }; } });
		const res = await handle_request(host_request("reload", { mode: "web", ...OWNERS, sessionId: "session-1", navGen: 1, ...body }), env);
		expect(res.status).toBe(400);
		expect(calls).toBe(0);
	});
});

describe("profile host routes", () => {
	function profile_request(route: "summary" | "clear" | "delete", body: unknown, headers: Record<string, string> = { Authorization: "Bearer test-secret" }) {
		return new Request(`${URL_BASE}/internal/browser/profile-${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	}
	const { agentBlockedHosts: _hosts, ...PROFILE_INPUT } = PROFILE;

	it.each([
		{ route: "summary" as const, body: { ...OWNERS, ...PROFILE_INPUT }, sent: { ...OWNERS, ...PROFILE_INPUT } },
		{ route: "clear" as const, body: { ...OWNERS, ...PROFILE_INPUT, domain: "github.com" }, sent: { ...OWNERS, ...PROFILE_INPUT, domain: "github.com" } },
		{ route: "delete" as const, body: { ...OWNERS, profileId: "profile_1" }, sent: { profileId: "profile_1" } },
	])("passes profile-$route to the owner's session object", async ({ route, body, sent }) => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({ sessions: (path, value) => { received.push([path, value]); return { ok: true }; } });
		const res = await handle_request(profile_request(route, body), env);
		expect(await res.json()).toEqual({ ok: true });
		expect(received).toEqual([[`/profile/${route}`, sent]]);
	});

	it.each([
		{ route: "summary" as const, name: "an unknown field", body: { ...OWNERS, ...PROFILE_INPUT, domain: "github.com" } },
		{ route: "summary" as const, name: "a short key", body: { ...OWNERS, ...PROFILE_INPUT, profileKey: Buffer.alloc(31).toString("base64") } },
		{ route: "summary" as const, name: "no profile id", body: { ...OWNERS, profileKey: PROFILE.profileKey } },
		{ route: "clear" as const, name: "no domain", body: { ...OWNERS, ...PROFILE_INPUT } },
		{ route: "clear" as const, name: "a 254-char domain", body: { ...OWNERS, ...PROFILE_INPUT, domain: "a".repeat(254) } },
		{ route: "delete" as const, name: "a profile key", body: { ...OWNERS, ...PROFILE_INPUT } },
		{ route: "delete" as const, name: "a profile id with a colon", body: { ...OWNERS, profileId: "profile:1" } },
		{ route: "delete" as const, name: "no owner", body: { profileId: "profile_1" } },
	])("rejects profile-$route with $name", async ({ route, body }) => {
		let calls = 0;
		const env = make_env({ sessions: () => { calls += 1; return { ok: true }; } });
		expect((await handle_request(profile_request(route, body), env)).status).toBe(400);
		expect(calls).toBe(0);
	});

	it.each(["summary", "clear", "delete"] as const)("refuses profile-%s without a token", async (route) => {
		const res = await handle_request(profile_request(route, { ...OWNERS, profileId: "profile_1" }, {}), make_env({}));
		expect(res.status).toBe(401);
	});

	it("keeps profile-delete open while the runner is disabled, but not summary", async () => {
		const env = make_env({ disabled: true });
		expect((await handle_request(profile_request("delete", { ...OWNERS, profileId: "profile_1" }), env)).status).toBe(200);
		expect((await handle_request(profile_request("summary", { ...OWNERS, ...PROFILE_INPUT }), env)).status).not.toBe(200);
	});

	it("forwards saveProfile on close", async () => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({ sessions: (path, value) => { received.push([path, value]); return { ok: true }; } });
		await handle_request(browser_request("close", JSON.stringify({ ...OWNERS, sessionId: "session-1", saveProfile: true })), env);
		expect(received).toEqual([["/close", { sessionId: "session-1", saveProfile: true }]]);
	});

	it("forwards the close reason as `by` and drops a reason that is not a short code", async () => {
		const received: Array<[string, Record<string, unknown>]> = [];
		const env = make_env({ sessions: (path, value) => { received.push([path, value as Record<string, unknown>]); return { ok: true }; } });
		await handle_request(browser_request("close", JSON.stringify({ ...OWNERS, sessionId: "session-1", reason: "access_lost" })), env);
		expect(received).toEqual([["/close", { sessionId: "session-1", by: "access_lost" }]]);

		// The reason is only logged, so a bad one must not stop the close.
		const bad = await handle_request(browser_request("close", JSON.stringify({ ...OWNERS, sessionId: "session-1", reason: "Access Lost!" })), env);
		expect(bad.status).toBe(200);
		expect(received).toHaveLength(2);
		expect(received[1]![1].by).toBeUndefined();
	});
});

describe("download and upload host routes", () => {
	function route_request(route: string, body: unknown, headers: Record<string, string> = { Authorization: "Bearer test-secret" }) {
		return new Request(`${URL_BASE}/internal/browser/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		});
	}
	const FILE = { name: "a.txt", contentType: "text/plain", url: "https://r2.test/a?sig=1" };

	it.each([
		{ route: "download-info", objectPath: "/download/info", body: { ...OWNERS, sessionId: "s", downloadId: "d" }, sent: { sessionId: "s", downloadId: "d" } },
		{
			route: "download-push",
			objectPath: "/download/push",
			body: { ...OWNERS, sessionId: "s", downloadId: "d", url: "https://r2.test/put", headers: { "Content-Type": "text/csv" } },
			sent: { sessionId: "s", downloadId: "d", url: "https://r2.test/put", headers: { "Content-Type": "text/csv" } },
		},
		{ route: "upload-grant", objectPath: "/upload/grant", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2 }, sent: { sessionId: "s", chooserId: "c", controlGen: 2 } },
		{
			route: "upload-fill",
			objectPath: "/upload/fill",
			body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: [FILE] },
			sent: { sessionId: "s", chooserId: "c", controlGen: 2, files: [FILE] },
		},
	])("passes $route to the owner's session object", async ({ route, objectPath, body, sent }) => {
		const received: Array<[string, unknown]> = [];
		const env = make_env({ sessions: (path, value) => { received.push([path, value]); return { ok: true }; } });
		const res = await handle_request(route_request(route, body), env);
		expect(await res.json()).toEqual({ ok: true });
		expect(received).toEqual([[objectPath, sent]]);
	});

	it.each([
		{ route: "download-info", name: "an unknown field", body: { ...OWNERS, sessionId: "s", downloadId: "d", url: "https://r2.test/" } },
		{ route: "download-info", name: "no download id", body: { ...OWNERS, sessionId: "s" } },
		{ route: "download-push", name: "an http URL", body: { ...OWNERS, sessionId: "s", downloadId: "d", url: "http://r2.test/", headers: {} } },
		{ route: "download-push", name: "a header with a newline", body: { ...OWNERS, sessionId: "s", downloadId: "d", url: "https://r2.test/", headers: { "X-A": "a\r\nb" } } },
		{ route: "download-push", name: "a bad header name", body: { ...OWNERS, sessionId: "s", downloadId: "d", url: "https://r2.test/", headers: { "X A": "a" } } },
		{ route: "upload-grant", name: "no controlGen", body: { ...OWNERS, sessionId: "s", chooserId: "c" } },
		{ route: "upload-fill", name: "no files", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: [] } },
		{ route: "upload-fill", name: "11 files", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: Array(11).fill(FILE) } },
		{ route: "upload-fill", name: "an http file URL", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: [{ ...FILE, url: "http://r2.test/a" }] } },
		{ route: "upload-fill", name: "an extra file field", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: [{ ...FILE, size: 1 }] } },
		{ route: "upload-fill", name: "a 256-char name", body: { ...OWNERS, sessionId: "s", chooserId: "c", controlGen: 2, files: [{ ...FILE, name: "n".repeat(256) }] } },
	])("rejects $route with $name", async ({ route, body }) => {
		let calls = 0;
		const env = make_env({ sessions: () => { calls += 1; return { ok: true }; } });
		expect((await handle_request(route_request(route, body), env)).status).toBe(400);
		expect(calls).toBe(0);
	});

	it.each(["download-info", "download-push", "upload-fill", "upload-grant"])("refuses %s without a token", async (route) => {
		expect((await handle_request(route_request(route, { ...OWNERS }, {}), make_env({}))).status).toBe(401);
	});
});

describe("viewer upload route", () => {
	const APP = "http://localhost:5173";
	function upload_env() {
		const env = make_env({});
		env.BROWSER_APP_ORIGINS = ` ${APP} , https://app.example`;
		const forwarded: Request[] = [];
		env.BROWSER_SESSIONS = {
			idFromName: (name: string) => ({ toString: () => name }),
			get: () => ({ fetch: async (request: Request) => { forwarded.push(request); return Response.json({ ok: true }); } }),
		};
		return { env, forwarded };
	}
	function upload_request(method: string, headers: Record<string, string>, body?: BodyInit) {
		const url = new URL(`${URL_BASE}/viewer/upload`);
		for (const [name, value] of Object.entries({ ...OWNERS, grantId: "grant-1", name: "notes.txt" })) url.searchParams.set(name, value);
		return new Request(url, { method, headers, body });
	}

	it("answers a preflight from an allowed origin", async () => {
		const { env } = upload_env();
		const res = await handle_request(upload_request("OPTIONS", { Origin: APP, "Access-Control-Request-Method": "PUT" }), env);
		expect(res.status).toBe(204);
		expect(Object.fromEntries(res.headers)).toMatchObject({
			"access-control-allow-origin": APP, "access-control-allow-methods": "PUT", "access-control-allow-headers": "Content-Type", vary: "Origin",
		});
	});

	it.each([
		{ name: "another origin", headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "PUT" } },
		{ name: "no origin", headers: { "Access-Control-Request-Method": "PUT" } },
		{ name: "another method", headers: { Origin: APP, "Access-Control-Request-Method": "POST" } },
	])("refuses a preflight with $name", async ({ headers }) => {
		const { env } = upload_env();
		const res = await handle_request(upload_request("OPTIONS", headers), env);
		expect(res.status).toBe(403);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("forwards a PUT from an allowed origin and adds CORS headers", async () => {
		const { env, forwarded } = upload_env();
		const res = await handle_request(upload_request("PUT", { Origin: APP, "Content-Type": "text/plain", "Content-Length": "5" }, "hello"), env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP);
		expect(forwarded).toHaveLength(1);
		expect(new URL(forwarded[0]!.url).searchParams.get("grantId")).toBe("grant-1");
		expect(await forwarded[0]!.text()).toBe("hello");
	});

	it("answers a failed session call with JSON and CORS headers, not a bare 500", async () => {
		const { env } = upload_env();
		env.BROWSER_SESSIONS = {
			idFromName: (name: string) => ({ toString: () => name }),
			get: () => ({ fetch: async () => { throw new Error("Session object reset"); } }),
		};
		const res = await handle_request(upload_request("PUT", { Origin: APP, "Content-Type": "text/plain", "Content-Length": "5" }, "hello"), env);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ ok: false, code: "upload_failed" });
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(APP);
	});

	it("refuses a PUT from another origin, and every PUT when the list is empty", async () => {
		const { env, forwarded } = upload_env();
		const refused = await handle_request(upload_request("PUT", { Origin: "https://evil.test", "Content-Length": "5" }, "hello"), env);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ ok: false, code: "origin_refused" });
		expect(refused.headers.get("Access-Control-Allow-Origin")).toBeNull();
		env.BROWSER_APP_ORIGINS = "";
		expect((await handle_request(upload_request("PUT", { Origin: APP, "Content-Length": "5" }, "hello"), env)).status).toBe(403);
		expect(forwarded).toEqual([]);
	});

	it("refuses a PUT over 20 MiB or without a length before reading it", async () => {
		const { env, forwarded } = upload_env();
		const large = await handle_request(upload_request("PUT", { Origin: APP, "Content-Length": String(LIMITS.uploadBytes + 1) }, "x"), env);
		expect(large.status).toBe(413);
		expect(await large.json()).toEqual({ ok: false, code: "too_large" });
		expect(large.headers.get("Access-Control-Allow-Origin")).toBe(APP);
		const url = new URL(`${URL_BASE}/viewer/upload`);
		for (const [name, value] of Object.entries({ ...OWNERS, grantId: "grant-1", name: "notes.txt" })) url.searchParams.set(name, value);
		// A stream body has no length, like a chunked upload.
		const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
		const chunked = new Request(url, { method: "PUT", headers: { Origin: APP }, body: stream, duplex: "half" } as RequestInit);
		expect((await handle_request(chunked, env)).status).toBe(411);
		expect(forwarded).toEqual([]);
	});

	it("refuses a PUT without a grant or a name", async () => {
		const { env } = upload_env();
		const url = new URL(`${URL_BASE}/viewer/upload`);
		for (const [name, value] of Object.entries(OWNERS)) url.searchParams.set(name, value);
		const res = await handle_request(new Request(url, { method: "PUT", headers: { Origin: APP, "Content-Length": "1" }, body: "x" }), env);
		expect(res.status).toBe(400);
	});
});

describe("run validation", () => {
	it("rejects a missing session id", async () => {
		const res = await handle_request(
			browser_request("run", JSON.stringify({ ...OWNERS, navGen: 1, loadGen: 1, controlGen: 1, code: "1" })),
			make_env({}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects oversize code", async () => {
		const res = await handle_request(
			browser_request(
				"run",
				JSON.stringify({ ...OWNERS, sessionId: "s", navGen: 1, loadGen: 1, controlGen: 1, code: "x".repeat(LIMITS.codeBytes + 1) }),
			),
			make_env({}),
		);
		expect(res.status).toBe(413);
	});

	it("passes a begin refusal through", async () => {
		const env = make_env({ sessions: () => ({ ok: false, error: { code: "busy", message: "busy" } }) });
		const res = await handle_request(
			browser_request(
				"run",
				JSON.stringify({ ...OWNERS, sessionId: "s", navGen: 1, loadGen: 1, controlGen: 1, code: "return 1;" }),
			),
			env,
		);
		expect(res.status).toBe(200);
		expect((await res.json()).error.code).toBe("busy");
	});
});

describe("close and keep-open", () => {
	it("rejects close without owners", async () => {
		const res = await handle_request(browser_request("close", JSON.stringify({})), make_env({}));
		expect(res.status).toBe(400);
	});

	it("passes close through to the session", async () => {
		const env = make_env({ sessions: () => ({ ok: true, existed: true, verified: true }) });
		const res = await handle_request(
			browser_request("close", JSON.stringify({ ...OWNERS, sessionId: "s" })),
			env,
		);
		expect(await res.json()).toEqual({ ok: true, existed: true, verified: true });
	});

	it("passes keep-open through to the session", async () => {
		const env = make_env({ sessions: () => ({ ok: true, idleUntil: 123 }) });
		const res = await handle_request(
			browser_request("keep-open", JSON.stringify({ ...OWNERS, sessionId: "s", navGen: 1 })),
			env,
		);
		expect(await res.json()).toEqual({ ok: true, idleUntil: 123 });
	});
});

describe("execute_browser_command", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([undefined, null, "", "home", "CURRENT", 1])("drops the whole HTTP batch for forged workspace %s", async (workspace) => {
		const finishes: unknown[] = [];
		const env = make_env({ sessions: (path, body) => {
			if (path === "/run/begin") return { ok: true, lease: { sessionId: "session-1", mode: "file", viewport: { width: 1280, height: 900 } } };
			if (path === "/run/settle") return { ok: true, blockedPopups: 0 };
			finishes.push(body);
			return { ok: true };
		} });
		// A forged RPC reply can bypass the snippet's local emitFile checks.
		const evaluate = vi.fn().mockResolvedValue({
			ok: true, resultJson: "42", files: [
				{ workspace: "personal", path: "/first.bin", bytes: new Uint8Array([1]) },
				{ workspace, path: "/bad.bin", bytes: new Uint8Array([2]) },
			], viewport: null, popups: { blocked: 0, urls: [] }, consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
		});
		env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate }) }) };
		const response = await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "forged reply",
		})), env, { waitUntil: () => {}, exports: { BrowserConnectionGateway: () => ({ fetch }) } });
		const result = await response.json();
		expect(response.status).toBe(200);
		expect(result.status).toBe("tainted");
		expect(result.result).toBeNull();
		expect(result.files).toEqual([]);
		expect(result.error.message).toBe("Snippet output failed host validation.");
		expect(finishes).toEqual([expect.objectContaining({ tainted: true, fileCount: 0, fileBytes: 0 })]);
	});

	it.each([
		{ name: "a failed snippet that changed the page", changed: true, timeout: false, lost: false, status: "tainted", tainted: true },
		{ name: "a failed snippet on the registered page", changed: false, timeout: false, lost: false, status: "errored", tainted: false },
		{ name: "a timed-out snippet on the registered page", changed: false, timeout: true, lost: false, status: "timed_out", tainted: true },
		{ name: "a lost isolate call", changed: false, timeout: false, lost: true, status: "errored", tainted: true },
	])("checks or closes after $name", async ({ changed, timeout, lost, status, tainted }) => {
		const finishes: unknown[] = [];
		const calls: string[] = [];
		const env = make_env({
			sessions: (path, body) => {
				calls.push(path);
				if (path === "/run/begin") return {
					ok: true,
					lease: { sessionId: "session-1", mode: "file", viewport: { width: 1280, height: 900 } },
				};
				if (path === "/run/settle") return changed
					? { ok: false, error: { code: "closed", message: "Browser target changed." } }
					: { ok: true, blockedPopups: 0 };
				finishes.push(body);
				return { ok: true };
			},
		});
		env.LOADER = {
			load: () => ({ getEntrypoint: () => ({
				evaluate: async () => {
					if (lost) throw new Error("Isolate disconnected");
					return {
						ok: false,
						error: { name: "Error", message: timeout ? "Execution timed out" : "test failure" },
						viewport: null,
						popups: { blocked: 0, urls: [] },
						consoleEntries: ["private output"],
						pageErrors: [],
						logs: [],
						logsTruncated: false,
					};
				},
			}) }),
		};
		const ctx = { exports: { BrowserConnectionGateway: () => ({ fetch }) } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		const response = await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "throw new Error('test');",
		})), env, ctx);
		const result = await response.json();
		expect(result.status).toBe(status);
		expect(result.files).toEqual([]);
		expect(finishes).toEqual([expect.objectContaining({ tainted })]);
		expect(result.consoleEntries).toEqual(tainted ? [] : ["private output"]);
		expect(calls).toEqual(timeout || lost ? ["/run/begin", "/run/finish"] : ["/run/begin", "/run/settle", "/run/finish"]);
	});

	it("waits for trusted settlement before finishing and returning results", async () => {
		const settling = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const calls: string[] = [];
		const finishes: unknown[] = [];
		const env = make_env({ sessions: async (path, body) => {
			calls.push(path);
			if (path === "/run/begin") return {
				ok: true, lease: { sessionId: "session-1", mode: "file", viewport: { width: 1280, height: 900 } },
			};
			if (path === "/run/settle") {
				expect(body).toEqual({ sessionId: "session-1", commandId: "command-1" });
				settling.resolve();
				await settled.promise;
				return { ok: true, blockedPopups: 2 };
			}
			finishes.push(body);
			return { ok: true };
		} });
		const evaluate = vi.fn(async () => ({
			ok: true, resultJson: "42", files: [
				{ workspace: "current" as const, path: "/reports/result.bin", bytes: new Uint8Array([0, 255, 128]) },
				{ workspace: "personal" as const, path: "/reports/result.bin", bytes: new Uint8Array([1]) },
			], viewport: null,
			popups: { blocked: 99, urls: ["untrusted"] }, consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
		}));
		env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate }) }) };
		const gateway = vi.fn(() => ({ fetch }));
		const ctx = { exports: { BrowserConnectionGateway: gateway } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		let returned = false;
		const pending = handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1", code: "return 42;",
		})), env, ctx).then((response) => { returned = true; return response; });
		await settling.promise;
		expect(finishes).toEqual([]);
		expect(returned).toBe(false);
		expect(gateway).toHaveBeenCalledWith({ props: { ...OWNERS, sessionId: "session-1", commandId: "command-1" } });
		expect(evaluate).toHaveBeenCalledWith({
			sessionId: "session-1", mode: "file", runtimeOrigin: "https://controller.browser.invalid", viewport: { width: 1280, height: 900 }, timeoutMs: LIMITS.commandTimeoutMs,
		});
		settled.resolve();
		const result = await (await pending).json();
		expect(result).toMatchObject({ status: "succeeded", result: 42, popups: { blocked: 2, urls: [] } });
		expect(result.files).toEqual([
			{ workspace: "current", path: "/reports/result.bin", dataBase64: "AP+A" },
			{ workspace: "personal", path: "/reports/result.bin", dataBase64: "AQ==" },
		]);
		expect(calls).toEqual(["/run/begin", "/run/settle", "/run/finish"]);
		expect(finishes).toEqual([expect.objectContaining({ tainted: false, fileCount: 2, fileBytes: 4 })]);
	});

	it("adds agent downloads under the shared 8-file limit and counts the dropped ones", async () => {
		const env = make_env({ sessions: (path) => {
			if (path === "/run/begin") return { ok: true, lease: { sessionId: "session-1", mode: "web", viewport: { width: 1280, height: 900 } } };
			if (path === "/run/settle") return { ok: true, blockedPopups: 0 };
			// The object already dropped one download of its own.
			return {
				ok: true, state: "ready", downloadsDropped: 1,
				downloads: Array.from({ length: 4 }, (_, index) => ({ name: `d${index}.csv`, contentType: "text/csv", dataBase64: "YWJj" })),
			};
		} });
		env.BROWSER_PREVIEW_URL = undefined;
		const evaluate = vi.fn(async () => ({
			ok: true, resultJson: "1", viewport: null, popups: { blocked: 0, urls: [] }, consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
			files: Array.from({ length: 6 }, (_, index) => ({ workspace: "current" as const, path: `/f${index}.bin`, bytes: new Uint8Array([index]) })),
		}));
		env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate }) }) };
		const ctx = { exports: { BrowserConnectionGateway: () => ({ fetch }) } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		const response = await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "return 1;",
		})), env, ctx);
		const result = await response.json();
		expect(result.status).toBe("succeeded");
		expect(result.files).toHaveLength(6);
		expect(result.downloads).toEqual([
			{ name: "d0.csv", contentType: "text/csv", dataBase64: "YWJj" },
			{ name: "d1.csv", contentType: "text/csv", dataBase64: "YWJj" },
		]);
		expect(result.downloadsDropped).toBe(3);
	});

	it("drops a download that would pass 8 MiB with the files, and omits downloadsDropped at 0", async () => {
		const big = Buffer.alloc(LIMITS.fileBytes - 2).toString("base64");
		const make = (downloads: unknown[]) => {
			const env = make_env({ sessions: (path) => {
				if (path === "/run/begin") return { ok: true, lease: { sessionId: "session-1", mode: "web", viewport: { width: 1280, height: 900 } } };
				if (path === "/run/settle") return { ok: true, blockedPopups: 0 };
				return { ok: true, state: "ready", downloads };
			} });
			env.BROWSER_PREVIEW_URL = undefined;
			env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate: async () => ({
				ok: true, resultJson: "1", viewport: null, popups: { blocked: 0, urls: [] }, consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
				files: [{ workspace: "current" as const, path: "/f.bin", bytes: new Uint8Array([1, 2]) }],
			}) }) }) };
			return env;
		};
		const ctx = { exports: { BrowserConnectionGateway: () => ({ fetch }) } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		const run = async (env: Env) => await (await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "return 1;",
		})), env, ctx)).json();
		const fits = await run(make([{ name: "big.bin", contentType: "application/octet-stream", dataBase64: big }]));
		expect(fits.downloads).toHaveLength(1);
		expect(fits).not.toHaveProperty("downloadsDropped");
		const over = await run(make([
			{ name: "big.bin", contentType: "application/octet-stream", dataBase64: big },
			{ name: "one.bin", contentType: "application/octet-stream", dataBase64: "AA==" },
		]));
		expect(over.downloads).toHaveLength(1);
		expect(over.downloadsDropped).toBe(1);
	});

	it("runs a web command without a preview URL and drops URL queries from the error", async () => {
		const env = make_env({ sessions: (path) => {
			if (path === "/run/begin") return { ok: true, lease: { sessionId: "session-1", mode: "web", viewport: { width: 1280, height: 900 } } };
			if (path === "/run/settle") return { ok: true, blockedPopups: 0 };
			return { ok: true };
		} });
		env.BROWSER_PREVIEW_URL = undefined;
		const evaluate = vi.fn(async () => ({
			ok: false, error: { name: "Error", message: "Timeout while loading https://example.com/login?token=abc#code=1 after 5s" },
			viewport: null, popups: { blocked: 0, urls: [] }, consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
		}));
		env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate }) }) };
		const ctx = { exports: { BrowserConnectionGateway: () => ({ fetch }) } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		const response = await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "await page.goto('https://example.com/');",
		})), env, ctx);
		const result = await response.json();
		expect(evaluate).toHaveBeenCalledWith({
			sessionId: "session-1", mode: "web", runtimeOrigin: null, viewport: { width: 1280, height: 900 }, timeoutMs: LIMITS.commandTimeoutMs,
		});
		expect(result.status).toBe("errored");
		expect(result.error.message).toBe("Timeout while loading https://example.com/login after 5s");
	});
});

describe("agent blocked site result", () => {
	it("refuses the result, keeps the session, and finishes untainted when the page ends on a blocked site", async () => {
		const finishes: unknown[] = [];
		const env = make_env({ sessions: (path, body) => {
			if (path === "/run/begin") return { ok: true, lease: { sessionId: "session-1", mode: "web", viewport: { width: 1280, height: 900 } } };
			if (path === "/run/settle") return { ok: true, blockedPopups: 0, blockedSite: true };
			if (path === "/run/finish") finishes.push(body);
			return { ok: true };
		} });
		env.BROWSER_PREVIEW_URL = undefined;
		const evaluate = vi.fn(async () => ({
			ok: true, resultJson: JSON.stringify({ balance: 100 }), files: [], viewport: null, popups: { blocked: 0, urls: [] },
			consoleEntries: [], pageErrors: [], logs: [], logsTruncated: false,
		}));
		env.LOADER = { load: () => ({ getEntrypoint: () => ({ evaluate }) }) };
		const ctx = { exports: { BrowserConnectionGateway: () => ({ fetch }) } } as unknown as NonNullable<Parameters<typeof handle_request>[2]>;
		const response = await handle_request(browser_request("run", JSON.stringify({
			...OWNERS, sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, code: "return 1;",
		})), env, ctx);
		const result = await response.json();
		expect(result).toEqual({ ok: false, error: { code: "agent_blocked_site", message: "The page is on a site the agent may not use." } });
		expect(JSON.stringify(result)).not.toContain("balance");
		expect(finishes).toEqual([expect.objectContaining({ tainted: false, resultBytes: 0, fileCount: 0 })]);
	});
});

describe("agent reload and close leases", () => {
	it.each([
		{ route: "reload", overrides: { control: "human" as const, controlGen: 2 }, reason: "stale_control" },
		{ route: "close", overrides: { control: "human" as const, controlGen: 2 }, reason: "stale_control" },
		{ route: "reload", overrides: { loadGen: 2 }, reason: "stale_load" },
		{ route: "close", overrides: { navGen: 2 }, reason: "stale_nav" },
		{ route: "reload", overrides: { control: "human" as const }, reason: "control" },
		{ route: "close", overrides: { control: "human" as const }, reason: "control" },
	])("refuses agent $route with $reason", async ({ route, overrides, reason }) => {
		const storage = make_storage({ session: make_record(overrides) });
		const put = vi.spyOn(storage.state.storage, "put");
		const session = new BrowserSession(storage.state, make_env({}));
		const response = await session.fetch(new Request(`https://object/${route}`, { method: "POST", body: JSON.stringify({
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<p>new</p>",
			expectedAgentLease: { navGen: 1, loadGen: 1, controlGen: 1 },
		}) }));
		expect((await response.json()).error.code).toBe(reason);
		expect(put).not.toHaveBeenCalled();
	});

	it.each(["reload", "close"])("passes the frozen lease through the %s host route", async (route) => {
		const expectedAgentLease = { navGen: 1, loadGen: 2, controlGen: 3 };
		const received: unknown[] = [];
		const env = make_env({ sessions: (_path, body) => { received.push(body); return { ok: true }; } });
		const response = await handle_request(browser_request(route as "reload" | "close", JSON.stringify({
			...OWNERS, sessionId: "session-1", expectedAgentLease,
			...(route === "reload" ? { navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<p>new</p>" } : {}),
		})), env);
		expect(response.status).toBe(200);
		expect(received).toEqual([expect.objectContaining({ expectedAgentLease })]);
	});
});

describe("BrowserSession reload", () => {
		afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each(["take", "run", "alarm"])("closes an overdue reload before %s can reuse its page", async (operation) => {
		const storage = make_storage({ session: make_record({
			control: "agent",
			command: { id: "reload:old", startedAt: Date.now() - LIMITS.commandTimeoutMs - 10_001 },
			inputHolder: null,
			viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: Date.now() + 30_000, attachedAt: Date.now(), lastInputAt: Date.now() } },
			viewerGrants: {},
		}) });
		const session = new BrowserSession(storage.state, make_env({}));
		if (operation === "alarm") {
			await session.alarm();
		} else {
			await session.fetch(new Request(`https://object${operation === "take" ? "/control/take-human" : "/run/begin"}`, {
				method: "POST",
				body: JSON.stringify({ sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, viewerId: "v1", commandId: "next" }),
			}));
		}
		// Provider close fails in this test, so its old page stays retired while cleanup retries.
		expect(storage.map.get("session")).toMatchObject({ control: "closing", command: null });
	});

	it.each([
		{ agent: true, failed: false, take: true },
		{ agent: true, failed: true, take: true },
		{ agent: false, failed: false, take: true },
		{ agent: false, failed: true, take: true },
		{ agent: true, failed: false, take: false },
		{ agent: true, failed: true, take: false },
	])("finishes reload with the right control (agent=$agent, failed=$failed, take=$take)", async ({ agent, failed, take }) => {
		const connecting = Promise.withResolvers<void>();
		const finishConnect = Promise.withResolvers<void>();
		const uuid = "00000000-0000-0000-0000-000000000001";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		const cdp = {
			send: vi.fn(async (method: string) => method === "Target.getTargetInfo" ? { targetInfo: { targetId: "page-1" } } :
				method === "Target.getBrowserContexts" ? { browserContextIds: [] } :
					method === "Target.getTargets" ? { targetInfos: [{ targetId: "page-1", type: "page" }] } : {}),
		};
		const context = Object.assign(new EventEmitter(), { newCDPSession: async () => cdp });
		const page = Object.assign(new EventEmitter(), {
			context: () => context,
			mainFrame: () => ({ url: () => "https://controller.browser.invalid/" }),
			unroute: vi.fn(async () => {}),
			route: vi.fn(async () => {}),
			goto: vi.fn(async () => {}),
			waitForFunction: async () => {},
			evaluate: vi.fn().mockResolvedValueOnce({ url: "https://controller.browser.invalid/", nonce: "nonce-1" })
				.mockResolvedValue({ ready: true, error: null, nonce: `${uuid}-0` }),
			setViewportSize: async () => {},
		});
		Object.assign(context, { pages: () => [page] });
		const browser = Object.assign(new EventEmitter(), {
			contexts: () => [context], newBrowserCDPSession: async () => cdp, close: vi.fn(async () => {}),
		});
		vi.spyOn(provider, "sessions").mockResolvedValue([]);
		const connect = vi.spyOn(provider, "connect")
			.mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof provider.connect>>)
			.mockImplementationOnce(async () => {
				connecting.resolve();
				await finishConnect.promise;
				if (failed) throw new Error("Provider connection failed");
				return browser as unknown as Awaited<ReturnType<typeof provider.connect>>;
			});
		const storage = make_storage({ session: make_record({
			control: agent ? "ready" : "human",
			inputHolder: agent ? null : "v1",
			viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: Date.now() + 30_000, attachedAt: Date.now(), lastInputAt: Date.now() } },
			viewerGrants: {},
		}) });
		// Durable Object reads return copies, so each interleaved call must reload the record.
		storage.state.storage.get = async <T,>(key: string) => structuredClone(storage.map.get(key)) as T | undefined;
		storage.state.storage.put = async (key, value) => { storage.map.set(key, structuredClone(value)); };
		const session = new BrowserSession(storage.state, make_env({}));
		const post = async (path: string, body: unknown) => {
			const response = await session.fetch(new Request(`https://object${path}`, { method: "POST", body: JSON.stringify(body) }));
			return await response.json();
		};
		const reload = post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<input />",
			...(agent ? { expectedAgentLease: { navGen: 1, loadGen: 1, controlGen: 1 } } : {}),
		});
		await connecting.promise;
		const taken = take ? await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: "v1" }) : null;
		finishConnect.resolve();
		const result = await reload;
		if (take) expect(taken).toMatchObject({ ok: true, control: "pausing", controlGen: 2 });
		expect(result.ok).toBe(!failed);
		expect(page.goto).toHaveBeenCalledTimes(failed ? 0 : 1);
		expect(connect).toHaveBeenCalledTimes(failed ? 2 : 1);
		if (failed) {
			expect(cdp.send).toHaveBeenCalledWith("Browser.close", {});
			expect(browser.close).toHaveBeenCalledOnce();
			expect(storage.map.has("session")).toBe(false);
		} else {
			expect(browser.close).not.toHaveBeenCalled();
			expect(page.unroute).toHaveBeenCalledWith("https://controller.browser.invalid/**");
			expect(page.unroute.mock.invocationCallOrder[0]).toBeLessThan(page.route.mock.invocationCallOrder[0]!);
			expect(storage.map.get("session")).toMatchObject({ control: take ? "human" : "ready", controlGen: take ? 2 : 1, command: null, loadGen: 2 });
		}
	});
});

describe("browser status", () => {
	it("passes an authenticated status read through while disabled", async () => {
		const seen: unknown[] = [];
		const response = await handle_request(browser_request("status", JSON.stringify({ ...OWNERS, sessionId: "session-1" })), make_env({
			disabled: true,
			sessions: (path, body) => { seen.push({ path, body }); return { ok: true, alive: false }; },
		}));
		expect(await response.json()).toEqual({ ok: true, alive: false });
		expect(seen).toEqual([{ path: "/status", body: { sessionId: "session-1" } }]);
	});

	it.each([
		{ name: "live", record: make_record(), alive: true },
		{ name: "missing", record: undefined, alive: false },
		{ name: "closing", record: make_record({ control: "closing" }), alive: false },
		{ name: "expired", record: make_record({ lastActiveAt: Date.now() - LIMITS.sessionIdleMs - 1 }), alive: false },
		{ name: "replaced", record: make_record({ sessionId: "replacement" }), alive: false },
	])("reports $name without changing idle time or grants", async ({ record, alive }) => {
		const storage = make_storage(record ? { session: record } : {});
		const put = vi.spyOn(storage.state.storage, "put");
		const session = new BrowserSession(storage.state, make_env({}));
		const response = await session.fetch(new Request("https://object/status", { method: "POST", body: JSON.stringify({ sessionId: "session-1" }) }));
		const result = await response.json();
		if (alive && record) {
			expect(result).toEqual({ ok: true, alive: true, session: {
				mode: "file", sessionId: record.sessionId, nodeId: record.nodeId, navGen: record.navGen, loadGen: record.loadGen,
				controlGen: record.controlGen, control: record.control, sourceKind: record.sourceKind,
				sourceVersion: record.sourceVersion, sourceHash: record.sourceHash, pageNonce: record.pageNonce,
				commandCount: record.commandCount, loadCount: record.loadCount,
				idleUntil: record.lastActiveAt + LIMITS.sessionIdleMs,
				totalUntil: record.providerAcquiredAt! + LIMITS.sessionTotalMs,
			}, profileStored: false });
		} else {
			// A record that still has this session id is closing: its usage receipt may still come.
			expect(result).toEqual({ ok: true, alive: false, closing: record?.sessionId === "session-1", usage: null, profileStored: false });
		}
		expect(put).not.toHaveBeenCalled();
	});
});

describe("BrowserSession close", () => {
	afterEach(() => vi.restoreAllMocks());

	it("keeps a replacement session when an earlier close finishes late", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const finishFirst = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(provider, "connect").mockImplementation(async () => {
			const first = ++calls === 1;
			return {
				newBrowserCDPSession: async () => ({
					send: async () => {
						if (first) {
							firstStarted.resolve();
							await finishFirst.promise;
						}
					},
				}),
				close: async () => {},
			} as unknown as Awaited<ReturnType<typeof provider.connect>>;
		});
		vi.spyOn(provider, "sessions").mockResolvedValue([]);
		const storage = make_storage({ session: make_record() });
		const session = new BrowserSession(storage.state, make_env({}));
		const close = () => session.fetch(new Request("https://object/close", {
			method: "POST", body: JSON.stringify({ sessionId: "session-1" }),
		}));
		const first = close();
		await firstStarted.promise;
		const second = await close();
		expect((await second.json()).verified).toBe(true);
		expect(storage.map.has("session")).toBe(false);

		// A new Start now owns the empty slot while the first provider close is pending.
		const replacement = make_record({ sessionId: "replacement", grantId: "new-grant", providerSessionId: "new-provider" });
		await storage.state.storage.put("session", replacement);
		await storage.state.storage.setAlarm(12345);
		finishFirst.resolve();
		await first;
		expect(storage.map.get("session")).toEqual(replacement);
		expect(storage.alarms.at(-1)).toBe(12345);
	});
});

describe("validate_gate_request", () => {
	const gate = (url: string, init?: RequestInit) => new Request(url, init);

	it("allows the exact assigned upgrade path", () => {
		const res = validate_gate_request(
			gate("http://fake.host/v1/devtools/browser/sess-1?persistent=true", {
				headers: { Upgrade: "websocket" },
			}),
			"sess-1",
		);
		expect(res).toEqual({ ok: true });
	});

	it("refuses another session id", () => {
		const res = validate_gate_request(
			gate("http://fake.host/v1/devtools/browser/sess-2?persistent=true", {
				headers: { Upgrade: "websocket" },
			}),
			"sess-1",
		);
		expect(res).toEqual({ ok: false, reason: "path" });
	});

	it("refuses acquisition posts", () => {
		const res = validate_gate_request(
			gate("http://fake.host/v1/devtools/browser?persistent=true", {
				method: "POST",
				headers: { Upgrade: "websocket" },
			}),
			"sess-1",
		);
		expect(res).toEqual({ ok: false, reason: "method" });
	});

	it("refuses inventory paths", async () => {
		for (const path of ["/v1/sessions", "/v1/history", "/v1/limits"]) {
			const res = validate_gate_request(
				gate(`http://fake.host${path}?persistent=true`, { headers: { Upgrade: "websocket" } }),
				"sess-1",
			);
			expect(res).toEqual({ ok: false, reason: "path" });
		}
	});

	it("refuses unexpected query strings", () => {
		for (const query of ["", "?x=1", "?persistent=false", "?persistent=true&x=1"]) {
			const res = validate_gate_request(
				gate(`http://fake.host/v1/devtools/browser/sess-1${query}`, {
					headers: { Upgrade: "websocket" },
				}),
				"sess-1",
			);
			expect(res).toEqual({ ok: false, reason: "query" });
		}
	});

	it("refuses a missing upgrade header", () => {
		const res = validate_gate_request(
			new Request("http://fake.host/v1/devtools/browser/sess-1?persistent=true"),
			"sess-1",
		);
		expect(res).toEqual({ ok: false, reason: "upgrade" });
	});

	it("forwards only the assigned command and owner tuple to its session object", async () => {
		const seen: Request[] = [];
		const idFromName = vi.fn((name: string) => ({ toString: () => name }));
		const sessions = {
			idFromName,
			get: () => ({ fetch: async (request: Request) => {
				seen.push(request);
				return new Response("upgraded", { status: 200 });
			} }),
		};
		const res = await handle_gate_request(
			gate("http://fake.host/v1/devtools/browser/sess-1?persistent=true", {
				headers: { Upgrade: "websocket", "X-Owner-Id": "other-owner" },
			}),
			{ ...OWNERS, sessionId: "sess-1", commandId: "c1" },
			sessions,
		);
		expect(res.status).toBe(200);
		expect(idFromName).toHaveBeenCalledWith("browser:user_1:org_1:ws_1");
		expect(seen).toHaveLength(1);
		const url = new URL(seen[0]!.url);
		expect(url.pathname).toBe("/run/stream");
		expect(Object.fromEntries(url.searchParams)).toEqual({ ...OWNERS, sessionId: "sess-1", commandId: "c1" });
		expect(Object.fromEntries(seen[0]!.headers)).toEqual({ upgrade: "websocket" });
	});
});

describe("validate_snippet_files", () => {
	it.each([undefined, null, "", "home", "CURRENT", 1])("refuses missing or invalid workspace %s", (workspace) => {
		expect(validate_snippet_files([
			{ workspace: "current", path: "/first.bin", bytes: new Uint8Array([1]) },
			{ workspace, path: "/bad.bin", bytes: new Uint8Array([2]) },
		])).toEqual({ ok: false, reason: "files_shape" });
	});

	it("preserves arbitrary, empty, and sliced bytes without a forced content type", () => {
		const source = new Uint8Array([99, 0, 255, 128, 99]);
		expect(validate_snippet_files([
			{ workspace: "current", path: "/reports/custom", contentType: "application/x-custom", bytes: source.subarray(1, 4) },
			{ workspace: "personal", path: "/reports/empty", bytes: new Uint8Array() },
		])).toEqual({
			ok: true, fileBytes: 3, files: [
				{ workspace: "current", path: "/reports/custom", contentType: "application/x-custom", dataBase64: "AP+A" },
				{ workspace: "personal", path: "/reports/empty", dataBase64: "" },
			],
		});
	});

	it("allows exactly eight files and 8 MiB across both workspaces", () => {
		const files = Array.from({ length: LIMITS.files }, (_, index) => ({
			workspace: index % 2 ? "personal" : "current",
			path: "/reports/" + index, bytes: new Uint8Array(LIMITS.fileBytes / LIMITS.files).fill(index),
		}));
		const result = validate_snippet_files(files);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.fileBytes).toBe(LIMITS.fileBytes);
		for (const [index, file] of result.files.entries()) {
			expect(file.workspace).toBe(files[index].workspace);
			expect(Buffer.from(file.dataBase64, "base64").equals(Buffer.from(files[index].bytes))).toBe(true);
		}
		expect(JSON.stringify(result).length).toBeLessThan(12 * 1024 * 1024);
	});

	it.each([
		[null, "files_shape"],
		[[{ workspace: "current", path: "", bytes: new Uint8Array() }], "files_shape"],
		[[{ workspace: "current", path: "/reports/file", bytes: [1, 2] }], "files_shape"],
		[[{ workspace: "current", path: "/reports/file", contentType: null, bytes: new Uint8Array() }], "files_shape"],
		[[{ workspace: "current", path: "x".repeat(LIMITS.filePathChars + 1), bytes: new Uint8Array() }], "files_shape"],
		[[{ workspace: "current", path: "/reports/file", contentType: "x".repeat(LIMITS.fileContentTypeChars + 1), bytes: new Uint8Array() }], "files_shape"],
		[Array.from({ length: LIMITS.files + 1 }, (_, index) => ({ workspace: index % 2 ? "personal" : "current", path: "/reports/file", bytes: new Uint8Array() })), "files_count"],
		[[{ workspace: "current", path: "/reports/file", bytes: new Uint8Array(LIMITS.fileBytes + 1) }], "files_bytes"],
		[[{ workspace: "current", path: "/reports/one", bytes: new Uint8Array(LIMITS.fileBytes) }, { workspace: "personal", path: "/reports/two", bytes: new Uint8Array([1]) }], "files_bytes"],
	])("refuses malformed or over-limit output", (files, reason) => {
		expect(validate_snippet_files(files)).toEqual({ ok: false, reason });
	});
});

describe("cap_snippet_string_lists", () => {
	it("caps UTF-8 bytes without splitting a character", () => {
		const res = cap_snippet_string_lists([["€".repeat(4096)]], 50, 4096);
		expect(res.truncated).toBe(true);
		expect(new TextEncoder().encode(res.capped[0]![0]).length).toBe(4095);
		expect(res.capped[0]![0]).toBe("€".repeat(1365));
	});

	it("marks a clipped single line as truncated", () => {
		expect(cap_snippet_string_lists([["abcdef"]], 50, 3)).toEqual({ capped: [["abc"]], truncated: true });
	});

	it("caps entries and the shared byte budget", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line-${i}-${"x".repeat(100)}`);
		const res = cap_snippet_string_lists([lines, ["short"]], 50, 4096);
		expect(res.truncated).toBe(true);
		expect(res.capped[0]?.length).toBeLessThanOrEqual(50);
		const total = res.capped.flat().reduce((sum, line) => sum + line.length, 0);
		expect(total).toBeLessThanOrEqual(4096);
	});

	it("coerces non-arrays and non-strings", () => {
		const res = cap_snippet_string_lists([null, [1, { a: 1 }, "ok"]], 50, 4096);
		expect(res.truncated).toBe(true);
		expect(res.capped[0]).toEqual([]);
		expect(res.capped[1]).toEqual(["1", "[object Object]", "ok"]);
	});

	it("passes bounded lists through untouched", () => {
		const res = cap_snippet_string_lists([["a", "b"], ["c"]], 50, 4096);
		expect(res).toEqual({ capped: [["a", "b"], ["c"]], truncated: false });
	});

	it("evicts the largest list by bytes, not by entries", () => {
		const res = cap_snippet_string_lists([["x".repeat(1000)], ["a", "b", "c"]], 50, 100);
		expect(res.truncated).toBe(true);
		expect(res.capped[0]).toEqual([]);
		expect(res.capped[1]).toEqual(["a", "b", "c"]);
	});
});

describe("build_controller_html", () => {
	it("embeds the handshake config with escaped markup", () => {
		const html = build_controller_html({
			runtimeUrl: "https://controller.browser.invalid/v0",
			sessionId: "session-1",
			loadId: "load-1",
			nonce: "nonce-1",
			html: "<p>x</p><script>alert(1)</script>",
		});
		expect(html).toContain("bonobo-file-preview");
		expect(html).toContain("load_html");
		expect(html).toContain("__browserReady");
		expect(html).toContain("nonce-1");
		// The snapshot must not break out of its script block.
		expect(html).toContain("\\u003c/script>");
		expect(html).not.toContain("<script>alert(1)");
	});
});

describe("build_executor_module", () => {
	function run_snippet(code: string, timeoutMs = 1000) {
		const screenshot = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xf6sAAAAASUVORK5CYII=", "base64"));
		const outer = { url: () => "https://controller.browser.invalid/v0", childFrames: () => [{}] };
		const page = {
			on: () => {}, mainFrame: () => ({ childFrames: () => [outer] }),
			setViewportSize: async () => {}, viewportSize: () => ({ width: 1280, height: 900 }),
			screenshot: async () => screenshot,
		};
		const source = build_executor_module(code).replace(/^import .*;$/gm, "").replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {}, TextEncoder, URL, Uint8Array, ArrayBuffer, console: {}, expect: () => {}, setTimeout, clearTimeout,
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => { evaluate: (input: unknown) => Promise<{
			ok: boolean; files?: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; bytes: Uint8Array }>; error?: { message: string };
		}> };
		return new Executor().evaluate({ sessionId: "fixture", mode: "file", runtimeOrigin: "https://controller.browser.invalid", viewport: { width: 1280, height: 900 }, timeoutMs });
	}

	it.each([undefined, null, "", "home", "CURRENT", 1])("rejects workspace %s inside the browser harness", async (workspace) => {
		const result = await run_snippet(`
			emitFile({ workspace: "personal", path: "/first.bin", bytes: new Uint8Array([1]) });
			emitFile({ workspace: ${JSON.stringify(workspace)}, path: "/bad.bin", bytes: new Uint8Array([2]) });
		`);
		expect(result).toMatchObject({ ok: false, error: { message: "emitFile workspace must be current or personal" } });
		expect(result.files).toBeUndefined();
	});

	it("emits a screenshot and arbitrary binary bytes through the same helper", async () => {
		const result = await run_snippet(`
			const source = new Uint8Array([99, 0, 255, 128, 99]);
			emitFile({ workspace: "current", path: "/reports/slice.bin", bytes: source.subarray(1, 4) });
			emitFile({ workspace: "personal", path: "/reports/buffer.bin", bytes: source.buffer, contentType: "application/x-custom" });
			emitFile({ workspace: "current", path: "/reports/empty", bytes: new ArrayBuffer(0) });
			emitFile({ workspace: "personal", path: "/reports/page.png", bytes: await page.screenshot() });
			source.fill(5);
		`);
		expect(result.ok).toBe(true);
		expect(result.files?.slice(0, 3)).toEqual([
			{ workspace: "current", path: "/reports/slice.bin", bytes: new Uint8Array([0, 255, 128]) },
			{ workspace: "personal", path: "/reports/buffer.bin", bytes: new Uint8Array([99, 0, 255, 128, 99]), contentType: "application/x-custom" },
			{ workspace: "current", path: "/reports/empty", bytes: new Uint8Array() },
		]);
		expect(result.files?.[3]?.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(result.files?.[3]?.workspace).toBe("personal");
	});

	it("allows the exact file and byte budgets", async () => {
		const result = await run_snippet(`for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/reports/" + i, bytes: new Uint8Array(${LIMITS.fileBytes / LIMITS.files}) });`);
		expect(result.ok).toBe(true);
		expect(result.files).toHaveLength(LIMITS.files);
		expect(result.files?.reduce((sum, file) => sum + file.bytes.byteLength, 0)).toBe(LIMITS.fileBytes);
	});

	it.each([
		`for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/reports/" + i, bytes: new Uint8Array() });`,
		`emitFile({ workspace: "personal", path: "/reports/large", bytes: new Uint8Array(${LIMITS.fileBytes}) });`,
		`emitFile({ workspace: "current", path: "/reports/bad", bytes: "text" });`,
		`emitFile({ workspace: "current", path: "", bytes: new Uint8Array() });`,
		`emitFile({ workspace: "current", path: "/reports/bad", contentType: null, bytes: new Uint8Array() });`,
		`throw new Error("failed");`,
	])("drops all emitted files when the snippet fails", async (failure) => {
		const result = await run_snippet(`emitFile({ workspace: "current", path: "/reports/first", bytes: new Uint8Array([1]) }); ${failure}`);
		expect(result.ok).toBe(false);
		expect(result.files).toBeUndefined();
	});

	it("drops emitted files on timeout and clears the timer after success", async () => {
		vi.useFakeTimers();
		try {
			const pending = run_snippet('emitFile({ workspace: "current", path: "/reports/first", bytes: new Uint8Array([1]) }); await new Promise(() => {});', 50);
			await vi.advanceTimersByTimeAsync(50);
			expect(await pending).toMatchObject({ ok: false, error: { message: "Execution timed out" } });
			expect((await pending).files).toBeUndefined();
			expect((await run_snippet("return 1;")).ok).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally { vi.useRealTimers(); }
	});

	it("caps Unicode console and log output in the running harness", async () => {
		const inner = {};
		const outer = { url: () => "https://controller.browser.invalid/v0", childFrames: () => [inner] };
		const page = {
			on: (event: string, callback: (message: { type: () => string; text: () => string }) => void) => {
				if (event === "console") for (let i = 0; i < 10; i++) callback({ type: () => "log", text: () => "€".repeat(500) });
			},
			mainFrame: () => ({ childFrames: () => [outer] }),
			setViewportSize: async () => {}, viewportSize: () => ({ width: 1280, height: 900 }),
		};
		const source = build_executor_module('console.log("€".repeat(6000)); return 42;')
			.replace(/^import .*;$/gm, "").replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {}, TextEncoder, URL, console: {}, expect: () => {}, setTimeout: () => 0, clearTimeout: () => {},
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => { evaluate: (input: unknown) => Promise<{ ok: boolean; logs: string[]; consoleEntries: string[]; logsTruncated: boolean }> };
		const result = await new Executor().evaluate({ sessionId: "fixture", mode: "file", runtimeOrigin: "https://controller.browser.invalid", viewport: { width: 1280, height: 900 } });
		expect(result.ok).toBe(true);
		expect(result.logsTruncated).toBe(true);
		expect(result.logs).toEqual(["€".repeat(5461)]);
		expect(result.consoleEntries.reduce((sum, line) => sum + new TextEncoder().encode(line).length, 0)).toBeLessThanOrEqual(LIMITS.consoleBytes);
	});

	it("gives web snippets the main frame without waiting for a preview frame", async () => {
		const mainFrame = { childFrames: () => [] };
		const page = {
			on: () => {}, mainFrame: () => mainFrame,
			setViewportSize: async () => {}, viewportSize: () => ({ width: 1280, height: 900 }),
		};
		const source = build_executor_module("return frame === page.mainFrame();")
			.replace(/^import .*;$/gm, "").replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {}, TextEncoder, URL, Uint8Array, ArrayBuffer, console: {}, expect: () => {}, setTimeout, clearTimeout,
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => { evaluate: (input: unknown) => Promise<{ ok: boolean; resultJson?: string }> };
		const result = await new Executor().evaluate({ sessionId: "fixture", mode: "web", runtimeOrigin: null, viewport: { width: 1280, height: 900 }, timeoutMs: 1000 });
		expect(result).toMatchObject({ ok: true, resultJson: "true" });
		// Only web mode may skip the runtime origin.
		await expect(new Executor().evaluate({ sessionId: "fixture", mode: "file", runtimeOrigin: null, viewport: { width: 1280, height: 900 }, timeoutMs: 1000 }))
			.rejects.toThrow("Missing runtime origin.");
	});

	it.each([
		"async ({ page }) => {\n\tawait page.title();\n\treturn 1;\n}",
		"// Read the title.\nasync (page) => page.title()",
		"page => 1",
		"async function main({ page }) {\n\treturn 1;\n}",
		"return async ({ page }) => 1;",
	])("refuses a snippet that only defines or returns a function: %s", async (code) => {
		expect(await run_snippet(code)).toMatchObject({
			ok: false, error: { message: "Your code returned a function. Write the function body only, do not wrap it in a function." },
		});
	});

	it.each([
		["return 1;", "1"],
		["(async () => 1)();", "null"],
		["async function helper() { return 2; }\nawait helper();", "null"],
		["function helper() {}\nemitFile({ workspace: \"current\", path: \"/a\", bytes: new Uint8Array() });\nhelper();", "null"],
		["const run = async () => 3;\nreturn await run();", "3"],
	])("runs a snippet that uses its own functions: %s", async (code, resultJson) => {
		expect(await run_snippet(code)).toMatchObject({ ok: true, resultJson });
	});

	it("wraps user code with the registered page harness", () => {
		const module = build_executor_module("return 42;");
		expect(module).toContain("return 42;");
		expect(module).toContain('from "./pw.js"');
		expect(module).toContain("persistent=true&browser_binding=BROWSER");
		expect(module).not.toContain("providerSessionId");
		expect(module).toContain("setViewportSize");
		expect(module).toContain(".call(undefined, page, frame, expect, emitFile)");
		expect(module).toContain("Preview frame not found");
		expect(module).toContain("emitFile");
	});
});

describe("session transitions", () => {
	const lease = { sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1 };

	it("allows a fresh command", () => {
		expect(session_can_run(make_record(), lease, Date.now())).toEqual({ ok: true });
	});

	it("refuses a retired session id", () => {
		expect(session_can_run(make_record(), { ...lease, sessionId: "old" }, Date.now())).toEqual({
			ok: false,
			reason: "stale_session",
		});
	});

	it("refuses a closed session", () => {
		expect(session_can_run(make_record({ control: "closing" }), lease, Date.now())).toEqual({
			ok: false,
			reason: "closed",
		});
	});

	it("refuses stale generations", () => {
		expect(session_can_run(make_record(), { ...lease, navGen: 2 }, Date.now())).toEqual({
			ok: false,
			reason: "stale_nav",
		});
		expect(session_can_run(make_record(), { ...lease, loadGen: 2 }, Date.now())).toEqual({
			ok: false,
			reason: "stale_load",
		});
		expect(session_can_run(make_record(), { ...lease, controlGen: 2 }, Date.now())).toEqual({
			ok: false,
			reason: "stale_control",
		});
	});

	it("refuses while a human holds control", () => {
		expect(session_can_run(make_record({ control: "human" }), lease, Date.now())).toEqual({
			ok: false,
			reason: "control",
		});
	});

	it("refuses an expired session", () => {
		const record = make_record({ lastActiveAt: Date.now() - LIMITS.sessionIdleMs - 1000 });
		expect(session_can_run(record, lease, Date.now())).toEqual({ ok: false, reason: "expired" });
	});

	it("refuses an overlapping command and closes a stale command before reuse", async () => {
		const now = Date.now();
		const fresh = make_record({ command: { id: "c1", startedAt: now - 1000, connection: "available" } });
		expect(session_can_run(fresh, lease, now)).toEqual({ ok: false, reason: "busy_command" });
		// A reload holds the slot without an agent connection. "Another chat" would be the wrong text.
		const reloading = make_record({ command: { id: "reload:1", startedAt: now - 1000 } });
		expect(session_can_run(reloading, lease, now)).toEqual({ ok: false, reason: "busy" });
		const stale = make_record({ command: { id: "c1", startedAt: now - LIMITS.commandTimeoutMs - 20_000 } });
		const storage = make_storage({ session: stale });
		const session = new BrowserSession(storage.state, make_env({}));
		const response = await session.fetch(new Request("https://do/run/begin", {
			method: "POST", body: JSON.stringify({ ...lease, commandId: "next" }),
		}));
		expect((await response.json()).error.code).toBe("expired");
		expect(storage.map.get("session")).toMatchObject({ control: "closing", command: null });
	});

	it("refuses past the session command cap", () => {
		const record = make_record({ commandCount: LIMITS.commandsPerSession });
		expect(session_can_run(record, lease, Date.now())).toEqual({ ok: false, reason: "session_limit" });
	});

	it("computes expiry from idle and total deadlines", () => {
		const now = Date.now();
		expect(session_is_expired(make_record(), now)).toBe(false);
		expect(
			session_is_expired(make_record({ lastActiveAt: now - LIMITS.sessionIdleMs }), now),
		).toBe(true);
		expect(
			session_is_expired(make_record({ providerAcquiredAt: now - LIMITS.sessionTotalMs }), now),
		).toBe(true);
	});

	it("uses web limits and refuses a web command while agent access is off", () => {
		const now = Date.now();
		const web = (overrides: Partial<SessionRecord> = {}) =>
			make_record({ mode: "web", agentAccess: true, pageTargetId: "page-1", ...overrides } as Partial<SessionRecord>);
		expect(session_can_run(web(), lease, now)).toEqual({ ok: true });
		expect(session_can_run(web({ agentAccess: false } as Partial<SessionRecord>), lease, now)).toEqual({ ok: false, reason: "agent_access_off" });
		expect(session_can_run(web({ commandCount: LIMITS.webCommandsPerSession - 1 }), lease, now)).toEqual({ ok: true });
		expect(session_can_run(web({ commandCount: LIMITS.webCommandsPerSession }), lease, now)).toEqual({ ok: false, reason: "session_limit" });
		expect(session_is_expired(web({ lastActiveAt: now - LIMITS.webSessionIdleMs + 1000 }), now)).toBe(false);
		expect(session_is_expired(web({ lastActiveAt: now - LIMITS.webSessionIdleMs }), now)).toBe(true);
		expect(session_is_expired(web({ providerAcquiredAt: now - LIMITS.webSessionTotalMs + 1000 }), now)).toBe(false);
		expect(session_is_expired(web({ providerAcquiredAt: now - LIMITS.webSessionTotalMs }), now)).toBe(true);
		const record = web();
		expect(session_next_alarm(record)).toBe(record.lastActiveAt + LIMITS.webSessionIdleMs);
		// The provider keeps an idle browser for keepAliveMs. The runner must end it first.
		expect(LIMITS.webSessionIdleMs).toBeLessThan(LIMITS.keepAliveMs);
	});

	it("schedules no alarm for a closed session", () => {
		expect(session_next_alarm(make_record({ control: "closed" }))).toBe(null);
		const record = make_record();
		expect(session_next_alarm(record)).toBe(record.lastActiveAt + LIMITS.sessionIdleMs);
	});
});

describe("BrowserRegistry", () => {
	async function post(registry: BrowserRegistry, path: string, body: unknown) {
		const res = await registry.fetch(
			new Request(`https://do${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return await res.json();
	}

	it("claims, confirms, and releases a grant", async () => {
		const storage = make_storage();
		const registry = new BrowserRegistry(storage.state as unknown as DurableObjectState, make_env({}));
		const claim = (await post(registry, "/claim", { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org" })) as { grantId: string };
		expect(typeof claim.grantId).toBe("string");
		expect(await post(registry, "/confirm", { grantId: claim.grantId })).toEqual({ ok: true });
		expect(await post(registry, "/release", { grantId: claim.grantId })).toEqual({ ok: true });
		// Release is idempotent.
		expect(await post(registry, "/release", { grantId: claim.grantId })).toEqual({ ok: true });
	});

	it("enforces the workspace cap", async () => {
		const storage = make_storage();
		const registry = new BrowserRegistry(storage.state as unknown as DurableObjectState, make_env({}));
		await post(registry, "/claim", { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org" });
		await post(registry, "/claim", { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org" });
		const third = (await post(registry, "/claim", { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org" })) as { error: { code: string } };
		expect(third.error.code).toBe("workspace_busy");
		// Another workspace still has room.
		const other = (await post(registry, "/claim", { workspaceKey: "org:ws2", ownerId: "user_2", organizationId: "org" })) as { ok: boolean };
		expect(other.ok).toBe(true);
	});

	it("enforces the user and organization caps", async () => {
		const storage = make_storage();
		const registry = new BrowserRegistry(storage.state as unknown as DurableObjectState, make_env({}));
		const claim = (workspaceKey: string, ownerId: string, organizationId: string) =>
			post(registry, "/claim", { workspaceKey, ownerId, organizationId });
		expect(await claim("org:ws1", "user_1", "org")).toMatchObject({ ok: true });
		expect(await claim("org:ws2", "user_1", "org")).toMatchObject({ ok: true });
		expect(await claim("org:ws3", "user_1", "org")).toMatchObject({ ok: false, error: { code: "user_limit" } });
		expect(await claim("org:ws3", "user_2", "org")).toMatchObject({ ok: true });
		expect(await claim("org:ws4", "user_3", "org")).toMatchObject({ ok: true });
		expect(await claim("org:ws5", "user_4", "org")).toMatchObject({ ok: false, error: { code: "organization_limit" } });
		// The same user in another organization is still capped by the user limit.
		expect(await claim("org2:ws1", "user_1", "org2")).toMatchObject({ ok: false, error: { code: "user_limit" } });
		expect(await claim("org2:ws1", "user_4", "org2")).toMatchObject({ ok: true });
	});

	it("refuses a claim without owner ids", async () => {
		const storage = make_storage();
		const registry = new BrowserRegistry(storage.state as unknown as DurableObjectState, make_env({}));
		expect(await post(registry, "/claim", { workspaceKey: "org:ws" })).toMatchObject({ ok: false });
		expect(storage.map.has("registry")).toBe(false);
	});

	it("sweeps expired claims on the next claim", async () => {
		const storage = make_storage({
			registry: {
				grants: { old: { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org", state: "claimed", expiresAt: Date.now() - 1000 } },
			},
		});
		const registry = new BrowserRegistry(storage.state as unknown as DurableObjectState, make_env({}));
		const res = (await post(registry, "/claim", { workspaceKey: "org:ws", ownerId: "user_1", organizationId: "org" })) as { ok: boolean };
		expect(res.ok).toBe(true);
		const stored = storage.map.get("registry") as { grants: Record<string, unknown> };
		expect("old" in stored.grants).toBe(false);
	});
});

describe("BrowserSession alarm", () => {
	function make_session(initial: Record<string, unknown>, onRegistry?: (path: string) => void) {
		const storage = make_storage(initial);
		const env = make_env({
			registry: (path) => {
				onRegistry?.(path);
				return { ok: true };
			},
		});
		const session = new BrowserSession(storage.state as unknown as DurableObjectState, env);
		return { storage, session };
	}

	it("clears the alarm when no record exists", async () => {
		const { storage, session } = make_session({});
		await session.alarm();
		expect(storage.alarms).toEqual([null]);
	});

	it("keeps an unverified close for alarm retry", async () => {
		const released: string[] = [];
		const { storage, session } = make_session(
			{ session: make_record({ lastActiveAt: Date.now() - LIMITS.sessionIdleMs - 1000 }) },
			(path) => released.push(path),
		);
		await session.alarm();
		// Provider close fails in unit tests, so the record stays closing with its slot held
		// and a near retry scheduled, instead of freeing an unverified slot.
		const record = storage.map.get("session") as { control: string };
		expect(record.control).toBe("closing");
		expect(released).toEqual([]);
		const retryAt = storage.alarms.at(-1);
		expect(typeof retryAt).toBe("number");
		expect(retryAt as number).toBeGreaterThan(Date.now() + 20_000);
		expect(retryAt as number).toBeLessThanOrEqual(Date.now() + 31_000);
	});

	it("closes a stale starting record without a provider session", async () => {
		const { storage, session } = make_session({
			session: make_record({
				control: "starting",
				createdAt: Date.now() - LIMITS.startingStaleMs - 1000,
				providerSessionId: null,
				pageNonce: null,
			}),
		});
		await session.alarm();
		expect(storage.map.has("session")).toBe(false);
	});

	it("force-deletes a closing record past its retry budget", async () => {
		const { storage, session } = make_session({
			session: make_record({ control: "closing", closeAttempts: LIMITS.closeAttempts }),
		});
		await session.alarm();
		expect(storage.map.has("session")).toBe(false);
	});

	it("writes an unverified receipt when the last close retry gives up", async () => {
		const record = make_record({ control: "closing", closeAttempts: LIMITS.closeAttempts });
		const { storage, session } = make_session({ session: record });
		const status = async () => await (await session.fetch(new Request("https://do/status", {
			method: "POST", body: JSON.stringify({ sessionId: "session-1" }),
		}))).json();
		// Until the record goes away, the caller must wait: the receipt is not final.
		expect(await status()).toEqual({ ok: true, alive: false, closing: true, usage: null, profileStored: false });
		await session.alarm();
		const usage = { providerAcquiredAt: record.providerAcquiredAt, endedAt: expect.any(Number), reason: "close_unverified" };
		expect(storage.map.get("usage:session-1")).toEqual({ sessionId: "session-1", ...usage });
		expect(await status()).toEqual({ ok: true, alive: false, closing: false, usage, profileStored: false });
	});

	it("writes no receipt when no browser was acquired", async () => {
		const { storage, session } = make_session({
			session: make_record({
				control: "starting",
				createdAt: Date.now() - LIMITS.startingStaleMs - 1000,
				providerSessionId: null,
				providerAcquiredAt: null,
				pageNonce: null,
			}),
		});
		await session.alarm();
		expect(storage.map.has("session")).toBe(false);
		expect([...storage.map.keys()].filter((key) => key.startsWith("usage:"))).toEqual([]);
	});

	it("deletes receipts older than seven days when a session closes", async () => {
		const now = Date.now();
		const old = { sessionId: "old", providerAcquiredAt: now - LIMITS.usageReceiptMs - 60_000, endedAt: now - LIMITS.usageReceiptMs - 1, reason: "close" };
		const recent = { sessionId: "recent", providerAcquiredAt: now - 120_000, endedAt: now - 60_000, reason: "close" };
		const { storage, session } = make_session({
			session: make_record({ control: "closing", closeAttempts: LIMITS.closeAttempts }),
			"usage:old": old,
			"usage:recent": recent,
		});
		await session.alarm();
		expect(storage.map.has("usage:old")).toBe(false);
		expect(storage.map.get("usage:recent")).toEqual(recent);
		expect(storage.map.has("usage:session-1")).toBe(true);
	});

	it("closes a pausing session whose command caller died", async () => {
		const stale = Date.now() - LIMITS.commandTimeoutMs - 20_000;
		const { storage, session } = make_session({
			session: make_record({
				control: "pausing",
				command: { id: "c1", startedAt: stale },
				inputHolder: "v1",
				viewers: {},
				viewerGrants: {},
			}),
		});
		await session.alarm();
		const record = storage.map.get("session") as { control: string; command: unknown };
		expect(record.control).toBe("closing");
		expect(record.command).toBe(null);
	});

	it("reschedules the alarm for a live record", async () => {
		const { storage, session } = make_session({ session: make_record() });
		await session.alarm();
		expect(storage.map.has("session")).toBe(true);
		expect(storage.alarms.length).toBe(1);
		expect(typeof storage.alarms[0]).toBe("number");
	});

	it("refuses begin on an expired record and retires it for retry", async () => {
		const { storage, session } = make_session({
			session: make_record({ lastActiveAt: Date.now() - LIMITS.sessionIdleMs - 1000 }),
		});
		const res = await session.fetch(
			new Request("https://do/run/begin", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "session-1",
					navGen: 1,
					loadGen: 1,
					controlGen: 1,
					commandId: "c1",
				}),
			}),
		);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("expired");
		expect((storage.map.get("session") as { control: string }).control).toBe("closing");
	});
});

describe("BrowserSession viewer", () => {
	function make_session(initial: Record<string, unknown>) {
		const storage = make_storage(initial);
		const env = make_env({ registry: () => ({ ok: true }) });
		const session = new BrowserSession(storage.state as unknown as DurableObjectState, env);
		return { storage, session };
	}

	async function post(session: BrowserSession, path: string, body: unknown) {
		const res = await session.fetch(
			new Request(`https://do${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return (await res.json()) as Record<string, never>;
	}

	function live_record(overrides: Partial<SessionRecord> = {}) {
		return make_record({ viewers: {}, viewerGrants: {}, inputHolder: null, ...overrides });
	}

	it("refuses grants for stale navigation and retired sessions", async () => {
		const { session } = make_session({ session: live_record() });
		const stale = (await post(session, "/viewer/grant", { sessionId: "session-1", navGen: 2 })) as {
			error: { code: string };
		};
		expect(stale.error.code).toBe("stale_nav");
		const retired = (await post(session, "/viewer/grant", { sessionId: "old", navGen: 1 })) as {
			error: { code: string };
		};
		expect(retired.error.code).toBe("stale_session");
	});

	it("takes human control from ready and hands back to the agent", async () => {
		const now = Date.now();
		const { storage, session } = make_session({ session: live_record({
			viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: now + 30_000, attachedAt: now, lastInputAt: 0 } },
		}) });

		const take = (await post(session, "/control/take-human", {
			sessionId: "session-1",
			navGen: 1,
			viewerId: "v1",
		})) as { control: string; controlGen: number };
		expect(take.control).toBe("human");
		const record = storage.map.get("session") as { inputHolder: string; controlGen: number };
		expect(record.inputHolder).toBe("v1");

		// Agent commands are refused while a human holds control.
		const begin = (await post(session, "/run/begin", {
			sessionId: "session-1",
			navGen: 1,
			loadGen: 1,
			controlGen: take.controlGen,
			commandId: "c1",
		})) as { error: { code: string } };
		expect(begin.error.code).toBe("control");

		const resume = (await post(session, "/control/to-agent", { sessionId: "session-1", navGen: 1 })) as {
			control: string;
		};
		expect(resume.control).toBe("ready");
		expect((storage.map.get("session") as { inputHolder: string | null }).inputHolder).toBe(null);
	});

	it("pauses a running command on take and hands over at finish", async () => {
		const now = Date.now();
		const { storage, session } = make_session({
			session: live_record({
				control: "agent", command: { id: "c1", startedAt: now, connection: "settled" },
				viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: now + 30_000, attachedAt: now, lastInputAt: 0 } },
			}),
		});

		const take = (await post(session, "/control/take-human", {
			sessionId: "session-1",
			navGen: 1,
			viewerId: "v1",
		})) as { control: string };
		expect(take.control).toBe("pausing");

		const finish = (await post(session, "/run/finish", {
			sessionId: "session-1",
			commandId: "c1",
			tainted: false,
			resultBytes: 10,
			fileCount: 0,
			fileBytes: 0,
			viewport: null,
		})) as { state: string };
		expect(finish.state).toBe("human");
		expect((storage.map.get("session") as { control: string }).control).toBe("human");
	});

	it("closes a dead command before take can reuse its page", async () => {
		const now = Date.now();
		const { storage, session } = make_session({
			session: live_record({
				control: "agent", command: { id: "c1", startedAt: now - 60_000 },
				viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: now + 30_000, attachedAt: now, lastInputAt: 0 } },
			}),
		});

		const take = (await post(session, "/control/take-human", {
			sessionId: "session-1",
			navGen: 1,
			viewerId: "v1",
		})) as { error: { code: string } };
		expect(take.error.code).toBe("expired");
		expect(storage.map.get("session")).toMatchObject({ control: "closing", command: null });
	});

	it("closes a stuck pausing session on the next take", async () => {
		const now = Date.now();
		const { storage, session } = make_session({
			session: live_record({
				control: "pausing", command: { id: "c1", startedAt: now - 60_000 },
				viewers: { v1: { host: "docked", controlGen: 1, grantedUntil: now + 30_000, attachedAt: now, lastInputAt: 0 } },
			}),
		});

		const take = (await post(session, "/control/take-human", {
			sessionId: "session-1",
			navGen: 1,
			viewerId: "v1",
		})) as { error: { code: string } };
		expect(take.error.code).toBe("expired");
		expect(storage.map.get("session")).toMatchObject({ control: "closing", command: null });
	});

	it("finishes a pausing command to ready when the holder is gone", async () => {
		const now = Date.now();
		const { session } = make_session({
			session: live_record({ control: "pausing", command: { id: "c1", startedAt: now, connection: "settled" }, inputHolder: null }),
		});

		const finish = (await post(session, "/run/finish", {
			sessionId: "session-1",
			commandId: "c1",
			tainted: false,
			resultBytes: 10,
			fileCount: 0,
			fileBytes: 0,
			viewport: null,
		})) as { state: string };
		expect(finish.state).toBe("ready");
	});

	it("refuses reload while a command holds the slot", async () => {
		const now = Date.now();
		const { session } = make_session({
			session: live_record({ control: "agent", command: { id: "c1", startedAt: now } }),
		});

		const reloaded = (await post(session, "/reload", {
			sessionId: "session-1",
			navGen: 1,
			sourceKind: "saved",
			sourceVersion: "v2",
			sourceHash: "h2",
			html: "<h1>hi</h1>",
		})) as { error: { code: string } };
		expect(reloaded.error.code).toBe("busy");
	});
});

describe("parse_viewer_input", () => {
	const lease = { controlGen: 2, loadGen: 3 };

	it.each(["mouse.down", "mouse.up"])("keeps the native click count for %s", (kind) => {
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, ...lease, kind, button: "left", clickCount: 2 }))).toEqual({
			ok: true, seq: 1, ...lease, input: { kind, button: "left", clickCount: 2 },
		});
	});

	it.each([0, -1, 1.5, 11, "2"])("refuses invalid click count %s", (clickCount) => {
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, ...lease, kind: "mouse.down", clickCount }))).toEqual({ ok: false });
	});

	it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])("refuses invalid input generations %s", (generation) => {
		for (const field of ["controlGen", "loadGen"] as const) {
			expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, kind: "key.press", key: "Enter", ...lease, [field]: generation }))).toEqual({ ok: false });
		}
	});

	it("accepts mouse, wheel, and keyboard shapes", () => {
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, ...lease, kind: "mouse.move", x: 10, y: 20 })).ok).toBe(true);
		expect(
			parse_viewer_input(JSON.stringify({ t: "input", seq: 2, ...lease, kind: "mouse.click", x: 10, y: 20 })).ok,
		).toBe(true);
		expect(
			parse_viewer_input(JSON.stringify({ t: "input", seq: 3, ...lease, kind: "wheel", x: 1, y: 2, dx: 0, dy: 100 })).ok,
		).toBe(true);
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 4, ...lease, kind: "key.press", key: "Enter" })).ok).toBe(
			true,
		);
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 5, ...lease, kind: "key.type", text: "hi" })).ok).toBe(true);
	});

	it("refuses malformed input", () => {
		expect(parse_viewer_input("{nope")).toEqual({ ok: false });
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, ...lease, kind: "mouse.move", x: -5, y: 1 }))).toEqual({
			ok: false,
		});
		expect(parse_viewer_input(JSON.stringify({ t: "input", seq: 1, ...lease, kind: "key.press", key: "" }))).toEqual({
			ok: false,
		});
		expect(parse_viewer_input(JSON.stringify({ t: "input", ...lease, kind: "mouse.move", x: 1, y: 1 }))).toEqual({ ok: false });
		expect(parse_viewer_input(JSON.stringify({ t: "other", ...lease, seq: 1 }))).toEqual({ ok: false });
	});
});

describe("parse_viewer_hello", () => {
	const valid = JSON.stringify({
		ownerId: "u",
		organizationId: "o",
		workspaceId: "w",
		grantId: "g",
		host: "docked",
	});

	it("accepts a well-formed hello", () => {
		expect(parse_viewer_hello(valid)).toEqual({
			ok: true,
			hello: { ownerId: "u", organizationId: "o", workspaceId: "w", grantId: "g", host: "docked" },
		});
	});

	it("refuses malformed hellos", () => {
		expect(parse_viewer_hello("{nope")).toEqual({ ok: false });
		expect(parse_viewer_hello(JSON.stringify({ ownerId: "u" }))).toEqual({ ok: false });
		expect(parse_viewer_hello(JSON.stringify({ ...JSON.parse(valid), host: "sideways" }))).toEqual({ ok: false });
		expect(parse_viewer_hello("x".repeat(5000))).toEqual({ ok: false });
		expect(parse_viewer_hello(null)).toEqual({ ok: false });
	});
});

describe("viewer host routes", () => {
	it("returns 426 for a stream request without upgrade", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/viewer/stream`), make_env({}));
		expect(res.status).toBe(426);
	});

	it("passes viewer-grant through to the session", async () => {
		const seen: string[] = [];
		const env = make_env({
			sessions: (path) => {
				seen.push(path);
				return { ok: true, grantId: "g1" };
			},
		});
		const res = await handle_request(
			new Request(`${URL_BASE}/internal/browser/viewer-grant`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
				body: JSON.stringify({ ...OWNERS, sessionId: "s", navGen: 1 }),
			}),
			env,
		);
		expect(seen).toEqual(["/viewer/grant"]);
		expect(((await res.json()) as { grantId: string }).grantId).toBe("g1");
	});

	it("rejects viewer-renew without a viewer id", async () => {
		const res = await handle_request(
			new Request(`${URL_BASE}/internal/browser/viewer-renew`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
				body: JSON.stringify({ ...OWNERS, sessionId: "s" }),
			}),
			make_env({}),
		);
		expect(res.status).toBe(400);
	});
});
