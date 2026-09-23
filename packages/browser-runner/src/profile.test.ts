import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as provider from "@cloudflare/playwright";
import { BrowserSession, LIMITS, type Env } from "./index";

const bridges = vi.hoisted(() => ({
	settle: vi.fn(),
	inputs: [] as Array<Record<string, unknown>>,
}));
vi.mock("./agent-connection", () => ({
	AgentConnection: class {
		constructor(input: Record<string, unknown>) { bridges.inputs.push(input); }
		revoke = vi.fn();
		settle = bridges.settle;
		close = vi.fn();
	},
}));

const OWNERS = { ownerId: "user_1", organizationId: "org_1", workspaceId: "ws_1" };
const SECRET = Buffer.alloc(32, 1).toString("base64");
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 8).toString("base64");
const NativeResponse = Response;
const FUTURE = Date.parse("2027-06-01T00:00:00Z") / 1000;
const DOWNLOAD_PATTERN = { urlPattern: "*", resourceType: "Document", requestStage: "Response" };

class Socket extends EventTarget {
	readyState = 1;
	accept() {}
	close() { this.readyState = 3; }
}

class SocketPair {
	0 = new Socket();
	1 = new Socket();
}

class SocketResponse extends NativeResponse {
	readonly webSocket: WebSocket | null;
	constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket }) {
		super(body, init?.status === 101 ? { ...init, status: 200 } : init);
		this.webSocket = init?.webSocket ?? null;
		if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
	}
}

type Cookie = Record<string, unknown> & { name: string; value: string; domain: string; expires: number };

function cookie(name: string, domain: string, extra: Partial<Cookie> = {}): Cookie {
	return {
		name, value: `value-of-${name}`, domain, path: "/", expires: FUTURE, size: 10, httpOnly: true, secure: true,
		session: false, sameSite: "Lax", priority: "Medium", sourceScheme: "Secure", sourcePort: 443, ...extra,
	};
}

/**
 * A runner object with a fake provider. The provider keeps a cookie jar that `Storage.*` reads and
 * writes, and a page address that `Page.getNavigationHistory` reports.
 */
function make_runner() {
	const stored = new Map<string, unknown>();
	const alarms: Array<number | null> = [];
	const pending = new Set<Promise<unknown>>();
	const browserState = { jar: [] as Cookie[], pageUrl: "https://example.com/", historyFails: false };
	const hooks = { getCookies: null as null | (() => Promise<unknown>) };
	const send = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
		if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page-1" } };
		if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page-1", type: "page" }] };
		if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
		if (method === "Page.getNavigationHistory") {
			if (browserState.historyFails) throw new Error("Target closed");
			return { currentIndex: 0, entries: [{ id: 1, url: browserState.pageUrl, title: "" }] };
		}
		if (method === "Storage.getCookies") {
			if (hooks.getCookies) return await hooks.getCookies() as Record<string, unknown>;
			return { cookies: structuredClone(browserState.jar) };
		}
		if (method === "Storage.setCookies") browserState.jar = structuredClone(params?.cookies as Cookie[]);
		return {};
	});
	const cdp = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
	const context = Object.assign(new EventEmitter(), { newCDPSession: async () => cdp });
	const page = Object.assign(new EventEmitter(), {
		context: () => context,
		mainFrame: () => ({ url: () => browserState.pageUrl, parentFrame: () => null }),
		setViewportSize: vi.fn(async () => {}),
		evaluate: vi.fn(async () => ({})),
		unroute: vi.fn(async () => {}),
	});
	Object.assign(context, { pages: () => [page] });
	const browser = Object.assign(new EventEmitter(), {
		contexts: () => [context], newBrowserCDPSession: async () => cdp, close: vi.fn(async () => {}),
	});
	const connect = vi.spyOn(provider, "connect").mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
	vi.spyOn(provider, "sessions").mockResolvedValue([]);
	vi.spyOn(provider, "acquire").mockResolvedValue({ sessionId: "provider-1" } as Awaited<ReturnType<typeof provider.acquire>>);

	const state = {
		id: { toString: () => "profile-test" },
		storage: {
			get: async <T,>(key: string) => structuredClone(stored.get(key)) as T | undefined,
			list: async <T,>(options: { prefix: string }) =>
				new Map([...stored].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, structuredClone(value)])) as Map<string, T>,
			put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
			delete: async (key: string) => stored.delete(key),
			setAlarm: async (time: number | Date) => { alarms.push(Number(time)); },
			getAlarm: async () => null,
			deleteAlarm: async () => { alarms.push(null); },
		},
		waitUntil: (promise: Promise<unknown>) => {
			pending.add(promise);
			void promise.then(() => pending.delete(promise), () => pending.delete(promise));
		},
	};
	const namespace = { idFromName: (name: string) => ({ toString: () => name }), get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
	const env: Env = {
		BROWSER: { fetch: vi.fn(async () => new Response(null, { status: 101, webSocket: new WebSocketPair()[0] })) },
		BROWSER_SESSIONS: namespace, BROWSER_REGISTRY: namespace,
		BROWSER_RUNNER_SECRET: "test-secret", BROWSER_PROFILE_KEY: SECRET,
		BROWSER_PREVIEW_URL: "https://preview.invalid/v0", BROWSER_WEB_DENIED_HOSTS: "blocked.test",
		LOADER: { load: () => { throw new Error("No snippets in profile tests"); } },
	};
	let session = new BrowserSession(state, env);

	const post = async (path: string, body: unknown) => {
		const response = await session.fetch(new Request(`https://object${path}`, { method: "POST", body: JSON.stringify(body) }));
		return await response.json() as Record<string, unknown>;
	};
	const record = () => stored.get("session") as Record<string, unknown> | undefined;
	const open = async (overrides: Record<string, unknown> = {}) => {
		const opened = await post("/open", {
			mode: "web", ...OWNERS, grantId: "grant-1", attemptId: "attempt-1", navGen: 1, startUrl: "https://example.com/",
			agentAccess: true, viewport: { width: 1280, height: 900 },
			profileId: "profile_1", profileKey: KEY, agentBlockedHosts: [], ...overrides,
		});
		expect(opened).toMatchObject({ ok: true });
		return (opened.session as { sessionId: string }).sessionId;
	};
	const profile_input = (overrides: Record<string, unknown> = {}) => ({ ...OWNERS, profileId: "profile_1", profileKey: KEY, ...overrides });
	const sends = (method: string) => send.mock.calls.filter(([name]) => name === method);
	const seed_viewer = () => {
		const current = structuredClone(record()!) as { viewers: Record<string, unknown> };
		current.viewers.v1 = { host: "docked", controlGen: 1, grantedUntil: Date.now() + 3_600_000, lastInputAt: 0, attachedAt: Date.now() };
		stored.set("session", current);
	};
	const command = async (sessionId: string) => {
		const begun = await post("/run/begin", { sessionId, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" });
		if (begun.ok !== true) return { begun, settled: null, finished: null };
		const url = new URL("https://object/run/stream");
		for (const [name, value] of Object.entries({ ...OWNERS, sessionId, commandId: "command-1" })) url.searchParams.set(name, value);
		expect((await session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }))).status).toBe(101);
		const settled = await post("/run/settle", { sessionId, commandId: "command-1" });
		const finished = await post("/run/finish", { sessionId, commandId: "command-1", tainted: false, resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		return { begun, settled, finished };
	};
	const drain = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	return {
		stored, alarms, browserState, hooks, send, cdp, browser, connect, post, open, record, profile_input, sends, seed_viewer, command, drain,
		restart: () => { session = new BrowserSession(state, env); },
		alarm: () => session.alarm(),
	};
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
	vi.stubGlobal("WebSocketPair", SocketPair);
	vi.stubGlobal("Response", SocketResponse);
	bridges.inputs.length = 0;
	bridges.settle.mockReset().mockResolvedValue({ safe: true, reason: null, blockedPopups: 0 });
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("saved profile", () => {
	it("restores the same cookies after a save, before the start page loads", async () => {
		const runner = make_runner();
		const first = await runner.open();
		const saved = [cookie("sid", ".example.com"), cookie("pref", "www.example.com", { session: true, expires: -1 })];
		runner.browserState.jar = structuredClone(saved);
		expect(await runner.post("/close", { sessionId: first, saveProfile: true })).toMatchObject({ ok: true, existed: true, verified: true });

		const blob = runner.stored.get("profile") as Record<string, unknown>;
		expect(blob).toMatchObject({ v: 1, profileId: "profile_1", truncated: false, savedAt: Date.now() });
		expect(Object.keys(blob).sort()).toEqual(["ciphertext", "iv", "profileId", "savedAt", "truncated", "v"]);
		expect(JSON.stringify(blob)).not.toMatch(/value-of|example\.com|sid/u);
		expect(runner.stored.get("profileDeleteAt")).toBe(Date.now() + LIMITS.profileKeepMs);

		// A new browser starts with an empty jar.
		runner.browserState.jar = [];
		runner.send.mockClear();
		await runner.open();
		// The save keeps session cookies first, so compare without order.
		const by_name = (cookies: Cookie[]) => [...cookies].sort((a, b) => a.name.localeCompare(b.name));
		expect(by_name(runner.browserState.jar)).toEqual(by_name(saved));
		const order = runner.send.mock.calls.map(([method]) => method);
		expect(order.indexOf("Storage.setCookies")).toBeLessThan(order.indexOf("Page.navigate"));
	});

	it("does not decrypt a blob for another owner", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		await runner.post("/close", { sessionId, saveProfile: true });
		runner.browserState.jar = [];

		// Same profile id and key, other owner: the AAD differs, so the blob stays locked.
		await runner.open({ ownerId: "user_2" });
		expect(runner.sends("Storage.setCookies")).toEqual([]);
		expect(runner.browserState.jar).toEqual([]);
		expect(await runner.post("/profile/summary", runner.profile_input({ ownerId: "user_2" })))
			.toMatchObject({ ok: false, error: { code: "busy" } });
		await runner.post("/close", { sessionId: runner.record()!.sessionId });
		expect(await runner.post("/profile/summary", runner.profile_input({ ownerId: "user_2" })))
			.toMatchObject({ ok: false, error: { code: "profile_unreadable" } });
		expect(await runner.post("/profile/summary", runner.profile_input())).toMatchObject({ ok: true, exists: true });
	});

	it("starts empty with a new profile key or another profile id", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		await runner.post("/close", { sessionId, saveProfile: true });

		runner.browserState.jar = [];
		const second = await runner.open({ profileKey: OTHER_KEY });
		expect(runner.sends("Storage.setCookies")).toEqual([]);
		await runner.post("/close", { sessionId: second });

		// A blob of another profile id is ignored. The next save replaces it.
		const third = await runner.open({ profileId: "profile_2" });
		expect(runner.sends("Storage.setCookies")).toEqual([]);
		runner.browserState.jar = [cookie("new", "other.test")];
		await runner.post("/close", { sessionId: third, saveProfile: true });
		expect(runner.stored.get("profile")).toMatchObject({ profileId: "profile_2" });
		expect(await runner.post("/profile/summary", runner.profile_input({ profileId: "profile_2" })))
			.toMatchObject({ ok: true, exists: true, sites: [{ domain: "other.test", cookies: 1 }] });
	});

	it.each([
		{ name: "human End", close: { saveProfile: true }, saves: true },
		{ name: "End without saveProfile", close: {}, saves: false },
		{ name: "saveProfile false", close: { saveProfile: false }, saves: false },
		{ name: "agent browser_close", close: { expectedAgentLease: { navGen: 1, loadGen: 1, controlGen: 1 } }, saves: false },
	])("saves on close only for $name", async ({ close, saves }) => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		expect(await runner.post("/close", { sessionId, ...close })).toMatchObject({ ok: true, existed: true });
		expect(runner.sends("Storage.getCookies")).toHaveLength(saves ? 1 : 0);
		expect(runner.stored.has("profile")).toBe(saves);
	});

	it("saves on idle expiry with no viewer attached", async () => {
		const runner = make_runner();
		await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		vi.setSystemTime(Date.now() + LIMITS.webSessionIdleMs + 1);
		await runner.alarm();
		expect(runner.record()).toBeUndefined();
		expect(runner.stored.has("profile")).toBe(true);
	});

	it.each([
		{ name: "a tainted command", run: async (runner: ReturnType<typeof make_runner>, sessionId: string) => {
			await runner.post("/run/begin", { sessionId, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" });
			await runner.post("/run/finish", { sessionId, commandId: "command-1", tainted: true, resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		} },
		{ name: "a lost host", run: async (runner: ReturnType<typeof make_runner>) => {
			runner.browser.emit("disconnected");
			await vi.waitFor(() => expect(runner.record()).toBeUndefined());
			await runner.drain();
		} },
		{ name: "a restarted object", run: async (runner: ReturnType<typeof make_runner>, sessionId: string) => {
			// The key lived only in memory, so the new instance cannot save.
			runner.restart();
			await runner.post("/close", { sessionId, saveProfile: true });
		} },
	])("does not save after $name", async ({ run }) => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		await run(runner, sessionId);
		expect(runner.record()).toBeUndefined();
		expect(runner.sends("Storage.getCookies")).toEqual([]);
		expect(runner.stored.has("profile")).toBe(false);
	});

	it("saves on viewer renew only when dirty and the last save is over 2 minutes old", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		// Returns how many saves this renew started.
		const renew = async () => {
			const before = runner.sends("Storage.getCookies").length;
			runner.seed_viewer();
			expect(await runner.post("/viewer/renew", { viewerId: "v1", sessionId })).toMatchObject({ ok: true });
			await runner.drain();
			return runner.sends("Storage.getCookies").length - before;
		};

		// Not dirty: no save, even after 3 minutes.
		vi.setSystemTime(Date.now() + 3 * 60_000);
		expect(await renew()).toBe(0);

		// An agent command makes the profile dirty. Before 2 minutes pass, the renew waits.
		const opened = Date.now() - 3 * 60_000;
		vi.setSystemTime(opened + 60_000);
		expect((await runner.command(sessionId)).finished).toMatchObject({ ok: true, state: "ready" });
		expect(await renew()).toBe(0);

		vi.setSystemTime(opened + LIMITS.profileSaveEveryMs + 1);
		expect(await renew()).toBe(1);
		expect(runner.stored.get("profile")).toMatchObject({ savedAt: Date.now() });

		// Saved and clean again: later renews do not save.
		vi.setSystemTime(Date.now() + 3 * 60_000);
		expect(await renew()).toBe(0);
	});

	it("does not let an older periodic save overwrite the End save", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		expect((await runner.command(sessionId)).finished).toMatchObject({ ok: true });
		vi.setSystemTime(Date.now() + LIMITS.profileSaveEveryMs + 1);

		// The periodic save reads the old jar, then waits.
		const oldJar = Promise.withResolvers<unknown>();
		runner.hooks.getCookies = () => {
			runner.hooks.getCookies = null;
			return oldJar.promise;
		};
		runner.seed_viewer();
		expect(await runner.post("/viewer/renew", { viewerId: "v1", sessionId })).toMatchObject({ ok: true });
		expect(runner.sends("Storage.getCookies")).toHaveLength(1);

		// The user logs out and clicks End. The End save writes the new jar. The provider close then
		// waits, so the record stays (closing) with the same ids.
		runner.browserState.jar = [cookie("sid", "new.test")];
		const providerClose = Promise.withResolvers<Awaited<ReturnType<typeof provider.connect>>>();
		runner.connect.mockImplementationOnce(() => providerClose.promise);
		const closing = runner.post("/close", { sessionId, saveProfile: true });
		await vi.waitFor(() => expect(runner.record()).toMatchObject({ control: "closing" }));

		oldJar.resolve({ cookies: [cookie("sid", "old.test")] });
		await runner.drain();
		providerClose.resolve(runner.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		expect(await closing).toMatchObject({ ok: true, existed: true });
		expect(await runner.post("/profile/summary", runner.profile_input()))
			.toMatchObject({ ok: true, exists: true, sites: [{ domain: "new.test", cookies: 1 }] });
	});

	it("never saves cookies of denied hosts", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("app", "blocked.test"), cookie("api", ".api.blocked.test"), cookie("sid", "example.com")];
		await runner.post("/close", { sessionId, saveProfile: true });
		expect(await runner.post("/profile/summary", runner.profile_input()))
			.toEqual({ ok: true, exists: true, savedAt: Date.now(), truncated: false, sites: [{ domain: "example.com", cookies: 1 }] });
	});

	it("keeps the 3,000 longest-living cookies and marks the profile truncated", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [
			cookie("oldest", "old.test", { expires: FUTURE - 10_000 }),
			...Array.from({ length: LIMITS.profileCookies }, (_, index) => cookie(`c${index}`, "example.com", { expires: FUTURE + index })),
		];
		await runner.post("/close", { sessionId, saveProfile: true });
		expect(await runner.post("/profile/summary", runner.profile_input()))
			.toMatchObject({ ok: true, truncated: true, sites: [{ domain: "example.com", cookies: LIMITS.profileCookies }] });
	});

	it("keeps at most 1 MiB of cookie JSON and marks the profile truncated", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = Array.from({ length: 300 }, (_, index) => cookie(`c${index}`, "example.com", { value: "x".repeat(4000) }));
		await runner.post("/close", { sessionId, saveProfile: true });
		const summary = await runner.post("/profile/summary", runner.profile_input());
		const kept = (summary.sites as Array<{ cookies: number }>)[0]!.cookies;
		expect(summary.truncated).toBe(true);
		// All values are ASCII, so string length is the byte count. One more cookie would not fit.
		expect(JSON.stringify({ cookies: runner.browserState.jar.slice(0, kept) }).length).toBeLessThanOrEqual(LIMITS.profileJsonBytes);
		expect(JSON.stringify({ cookies: runner.browserState.jar.slice(0, kept + 1) }).length).toBeGreaterThan(LIMITS.profileJsonBytes);
	});

	it("reports stored bytes in status without the profile id", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		expect(await runner.post("/status", { sessionId })).toMatchObject({ ok: true, alive: true, profileStored: false });
		await runner.post("/close", { sessionId, saveProfile: true });
		const status = await runner.post("/status", { sessionId });
		expect(status).toMatchObject({ ok: true, alive: false, profileStored: true });
		expect(JSON.stringify(status)).not.toContain("profile_1");
	});
});

describe("profile summary and clear", () => {
	async function saved_runner(jar: Cookie[]) {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = jar;
		await runner.post("/close", { sessionId, saveProfile: true });
		return runner;
	}

	it("counts cookies per site, sorted, with no names or values", async () => {
		const runner = await saved_runner([
			cookie("b", "www.github.com"), cookie("a", ".github.com"), cookie("c", "github.com"), cookie("d", "Example.COM"),
		]);
		const summary = await runner.post("/profile/summary", runner.profile_input());
		expect(summary).toEqual({
			ok: true, exists: true, savedAt: Date.now(), truncated: false,
			sites: [{ domain: "example.com", cookies: 1 }, { domain: "github.com", cookies: 2 }, { domain: "www.github.com", cookies: 1 }],
		});
		expect(JSON.stringify(summary)).not.toMatch(/value-of/u);
	});

	it("answers exists false when nothing is stored for this profile", async () => {
		const runner = make_runner();
		expect(await runner.post("/profile/summary", runner.profile_input()))
			.toEqual({ ok: true, exists: false, savedAt: null, truncated: false, sites: [] });
		expect(await runner.post("/profile/clear", runner.profile_input({ domain: "example.com" }))).toEqual({ ok: true, removed: 0 });
	});

	it("clears one site and its subdomains and keeps savedAt", async () => {
		const runner = await saved_runner([
			cookie("a", "example.com"), cookie("b", ".example.com"), cookie("c", "www.example.com"),
			cookie("d", "notexample.com"), cookie("e", "other.test"),
		]);
		const savedAt = Date.now();
		vi.setSystemTime(savedAt + 60_000);
		expect(await runner.post("/profile/clear", runner.profile_input({ domain: ".Example.com" }))).toEqual({ ok: true, removed: 3 });
		expect(await runner.post("/profile/summary", runner.profile_input())).toEqual({
			ok: true, exists: true, savedAt, truncated: false,
			sites: [{ domain: "notexample.com", cookies: 1 }, { domain: "other.test", cookies: 1 }],
		});
	});

	it("refuses summary and clear while a session is live", async () => {
		const runner = make_runner();
		await runner.open();
		expect(await runner.post("/profile/summary", runner.profile_input())).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await runner.post("/profile/clear", runner.profile_input({ domain: "example.com" }))).toMatchObject({ ok: false, error: { code: "busy" } });
	});
});

describe("profile delete", () => {
	it("deletes a matching blob and answers deleted true", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		await runner.post("/close", { sessionId, saveProfile: true });
		expect(await runner.post("/profile/delete", { profileId: "profile_1" })).toEqual({ ok: true, deleted: true });
		expect(runner.stored.has("profile")).toBe(false);
		expect(runner.stored.has("profileDeleteAt")).toBe(false);
		expect(runner.stored.get("profileDeleted:profile_1")).toBe(Date.now());
		// Only the tombstone is left to wake up for.
		expect(runner.alarms.at(-1)).toBe(Date.now() + LIMITS.profileTombstoneMs);
		// The usage receipt stays for Convex billing.
		expect(runner.stored.has(`usage:${sessionId}`)).toBe(true);
	});

	it("keeps a blob with another profile id", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		await runner.post("/close", { sessionId, saveProfile: true });
		expect(await runner.post("/profile/delete", { profileId: "profile_2" })).toEqual({ ok: true, deleted: true });
		expect(runner.stored.get("profile")).toMatchObject({ profileId: "profile_1" });
		// The other profile's tombstone is due long before the kept profile.
		expect(runner.alarms.at(-1)).toBe(Date.now() + LIMITS.profileTombstoneMs);
		expect(runner.alarms.at(-1)).toBeLessThan(runner.stored.get("profileDeleteAt") as number);
	});

	it("answers deleted true when nothing is stored", async () => {
		const runner = make_runner();
		expect(await runner.post("/profile/delete", { profileId: "profile_1" })).toEqual({ ok: true, deleted: true });
	});

	it("closes a live session of the same profile without saving", async () => {
		const runner = make_runner();
		await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		expect(await runner.post("/profile/delete", { profileId: "profile_1" })).toEqual({ ok: true, deleted: true });
		expect(runner.record()).toBeUndefined();
		expect(runner.sends("Storage.getCookies")).toEqual([]);
		expect(runner.stored.has("profile")).toBe(false);
	});

	it("keeps a live session of another profile", async () => {
		const runner = make_runner();
		await runner.open({ profileId: "profile_2" });
		expect(await runner.post("/profile/delete", { profileId: "profile_1" })).toEqual({ ok: true, deleted: true });
		expect(runner.record()).toMatchObject({ control: "ready", profileId: "profile_2" });
	});

	it("does not bring the blob back when a save races the delete", async () => {
		const runner = make_runner();
		const first = await runner.open();
		runner.browserState.jar = [cookie("old", "example.com")];
		await runner.post("/close", { sessionId: first, saveProfile: true });

		const second = await runner.open();
		runner.browserState.jar.push(cookie("new", "example.com"));
		const cookies = Promise.withResolvers<unknown>();
		runner.hooks.getCookies = () => cookies.promise;
		const closing = runner.post("/close", { sessionId: second, saveProfile: true });
		await vi.waitFor(() => expect(runner.sends("Storage.getCookies")).toHaveLength(1));

		// The delete's provider close fails, so the record stays (closing) with the same profile id.
		// Only the tombstone can stop the save's put now.
		runner.connect.mockRejectedValueOnce(new Error("Provider socket lost"));
		expect(await runner.post("/profile/delete", { profileId: "profile_1" })).toEqual({ ok: true, deleted: true });
		expect(runner.record()).toMatchObject({ control: "closing", profileId: "profile_1" });
		expect(runner.stored.has("profile")).toBe(false);

		cookies.resolve({ cookies: runner.browserState.jar });
		await closing;
		expect(runner.stored.has("profile")).toBe(false);
		expect(runner.stored.has("profileDeleteAt")).toBe(false);
	});
});

describe("profile alarm", () => {
	async function saved_runner() {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.browserState.jar = [cookie("sid", "example.com")];
		await runner.post("/close", { sessionId, saveProfile: true });
		const deleteAt = runner.stored.get("profileDeleteAt") as number;
		return { runner, sessionId, deleteAt };
	}

	it("keeps the profile on a stray early alarm", async () => {
		const { runner, deleteAt } = await saved_runner();
		expect(runner.alarms.at(-1)).toBe(deleteAt);
		vi.setSystemTime(Date.now() + 60 * 60_000);
		await runner.alarm();
		expect(runner.stored.has("profile")).toBe(true);
		expect(runner.alarms.at(-1)).toBe(deleteAt);
	});

	it("deletes the profile at its due time in an object with no session, and keeps receipts", async () => {
		const { runner, sessionId, deleteAt } = await saved_runner();
		vi.setSystemTime(deleteAt);
		await runner.alarm();
		expect(runner.stored.has("profile")).toBe(false);
		expect(runner.stored.has("profileDeleteAt")).toBe(false);
		expect(runner.alarms.at(-1)).toBeNull();
		expect(runner.stored.has(`usage:${sessionId}`)).toBe(true);
	});

	it("keeps the backstop alarm across a new session", async () => {
		const { runner, deleteAt } = await saved_runner();
		const second = await runner.open();
		// The session deadline comes first while the session lives.
		expect(runner.alarms.at(-1)).toBeLessThan(deleteAt);
		await runner.post("/close", { sessionId: second });
		expect(runner.alarms.at(-1)).toBe(deleteAt);
	});

	it("sets an alarm for the oldest tombstone and deletes tombstones after 7 days", async () => {
		const runner = make_runner();
		const firstAt = Date.now();
		await runner.post("/profile/delete", { profileId: "profile_1" });
		// No session and no profile: only the tombstone needs the alarm.
		expect(runner.alarms.at(-1)).toBe(firstAt + LIMITS.profileTombstoneMs);
		vi.setSystemTime(firstAt + 60_000);
		await runner.post("/profile/delete", { profileId: "profile_2" });
		expect(runner.alarms.at(-1)).toBe(firstAt + LIMITS.profileTombstoneMs);

		// A stray early alarm keeps both and sets the same time again.
		vi.setSystemTime(firstAt + LIMITS.profileTombstoneMs - 1);
		await runner.alarm();
		expect(runner.stored.has("profileDeleted:profile_1")).toBe(true);
		expect(runner.alarms.at(-1)).toBe(firstAt + LIMITS.profileTombstoneMs);

		// The alarm at its time deletes the first one and moves on to the second.
		vi.setSystemTime(firstAt + LIMITS.profileTombstoneMs);
		await runner.alarm();
		expect(runner.stored.has("profileDeleted:profile_1")).toBe(false);
		expect(runner.stored.has("profileDeleted:profile_2")).toBe(true);
		expect(runner.alarms.at(-1)).toBe(firstAt + 60_000 + LIMITS.profileTombstoneMs);

		vi.setSystemTime(firstAt + 60_000 + LIMITS.profileTombstoneMs);
		await runner.alarm();
		expect(runner.stored.has("profileDeleted:profile_2")).toBe(false);
		expect(runner.alarms.at(-1)).toBeNull();
	});
});

describe("agent blocked sites", () => {
	it("refuses a command while the page is on a blocked site", async () => {
		const runner = make_runner();
		const sessionId = await runner.open({ agentBlockedHosts: ["bank.test"] });
		runner.browserState.pageUrl = "https://www.Bank.test/account";
		runner.send.mockClear();
		const { begun } = await runner.command(sessionId);
		expect(begun).toMatchObject({ ok: false, error: { code: "agent_blocked_site" } });
		expect(runner.sends("Fetch.enable")).toEqual([]);
		expect(runner.record()).toMatchObject({ control: "ready", command: null });
	});

	it("refuses a command when the page cannot be checked", async () => {
		const runner = make_runner();
		const sessionId = await runner.open({ agentBlockedHosts: ["bank.test"] });
		runner.browserState.historyFails = true;
		expect((await runner.command(sessionId)).begun).toMatchObject({ ok: false, error: { code: "not_ready" } });
		expect(runner.record()).toMatchObject({ control: "ready", command: null });
	});

	it("fails page, XHR, and fetch requests to blocked sites during a command", async () => {
		const runner = make_runner();
		const sessionId = await runner.open({ agentBlockedHosts: ["bank.test"] });
		// Web mode always pauses page responses to catch downloads.
		expect(runner.sends("Fetch.enable")).toEqual([["Fetch.enable", { patterns: [DOWNLOAD_PATTERN] }]]);
		runner.send.mockClear();
		const begun = await runner.post("/run/begin", { sessionId, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" });
		expect(begun).toMatchObject({ ok: true });
		// One `Fetch.enable` replaces the list, so the download pattern stays next to the filter.
		expect(runner.sends("Fetch.enable")).toEqual([["Fetch.enable", { patterns: [
			DOWNLOAD_PATTERN,
			{ urlPattern: "*", resourceType: "Document", requestStage: "Request" },
			{ urlPattern: "*", resourceType: "XHR", requestStage: "Request" },
			{ urlPattern: "*", resourceType: "Fetch", requestStage: "Request" },
		] }]]);
		runner.cdp.emit("Fetch.requestPaused", { requestId: "r1", request: { url: "https://api.bank.test/transfer" }, resourceType: "XHR" });
		runner.cdp.emit("Fetch.requestPaused", { requestId: "r2", request: { url: "https://example.com/next" }, resourceType: "Document" });
		await runner.drain();
		expect(runner.sends("Fetch.failRequest")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "BlockedByClient" }]]);
		expect(runner.sends("Fetch.continueRequest")).toEqual([["Fetch.continueRequest", { requestId: "r2" }]]);
	});

	it("gives the bridge the list, turns the filter off after the command, and flags a blocked end page", async () => {
		const runner = make_runner();
		const sessionId = await runner.open({ agentBlockedHosts: ["bank.test"] });
		bridges.settle.mockImplementationOnce(async () => {
			// The agent reached the blocked site in a way the filters did not catch.
			runner.browserState.pageUrl = "https://bank.test/";
			return { safe: true, reason: null, blockedPopups: 0 };
		});
		const { settled, finished } = await runner.command(sessionId);
		expect(bridges.inputs[0]).toMatchObject({ mode: "web", agentBlockedHosts: ["bank.test"] });
		expect(settled).toEqual({ ok: true, blockedPopups: 0, blockedSite: true });
		// Off means only the download pattern again. `Fetch.disable` would stop download capture.
		expect(runner.sends("Fetch.enable").at(-1)).toEqual(["Fetch.enable", { patterns: [DOWNLOAD_PATTERN] }]);
		expect(runner.sends("Fetch.disable")).toEqual([]);
		// The session stays.
		expect(finished).toMatchObject({ ok: true, state: "ready" });
	});

	it("does no page check or filter when the list is empty", async () => {
		const runner = make_runner();
		const sessionId = await runner.open();
		runner.send.mockClear();
		const { settled } = await runner.command(sessionId);
		expect(settled).toEqual({ ok: true, blockedPopups: 0 });
		expect(runner.sends("Page.getNavigationHistory")).toEqual([]);
		expect(runner.sends("Fetch.enable")).toEqual([]);
	});
});

describe("profile logs", () => {
	it("never logs cookie names, values, or domains", async () => {
		const runner = make_runner();
		const first = await runner.open({ startUrl: null });
		runner.browserState.jar = [cookie("secretname", "privatesite.test"), cookie("blocked", "blocked.test")];
		await runner.post("/close", { sessionId: first, saveProfile: true });
		const second = await runner.open({ startUrl: null });
		await runner.post("/close", { sessionId: second, saveProfile: true });
		await runner.post("/profile/summary", runner.profile_input());
		await runner.post("/profile/clear", runner.profile_input({ domain: "privatesite.test" }));
		await runner.post("/profile/summary", runner.profile_input({ profileKey: OTHER_KEY }));
		await runner.post("/profile/delete", { profileId: "profile_1" });
		const lines = log.mock.calls.map((call) => call.map(String).join(" "));
		expect(lines.some((line) => line.includes("profile_save"))).toBe(true);
		expect(lines.some((line) => line.includes("profile_restore"))).toBe(true);
		for (const line of lines) {
			expect(line).not.toMatch(/secretname|value-of|privatesite|blocked\.test|profile_1/u);
		}
	});
});
