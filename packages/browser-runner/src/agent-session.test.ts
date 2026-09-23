import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as provider from "@cloudflare/playwright";
import { BrowserSession, LIMITS, session_can_run, type Env } from "./index";

const bridges = vi.hoisted(() => ({
	revoke: vi.fn(), settle: vi.fn(), close: vi.fn(),
	inputs: [] as Array<{ onPopup: (targetId: string) => Promise<void> }>,
}));
vi.mock("./agent-connection", () => ({
	AgentConnection: class {
		constructor(input: { onPopup: (targetId: string) => Promise<void> }) { bridges.inputs.push(input); }
		revoke = bridges.revoke;
		settle = bridges.settle;
		close = bridges.close;
	},
}));

const OWNERS = { ownerId: "user_1", organizationId: "org_1", workspaceId: "ws_1" };
const NativeResponse = Response;
type SessionRecord = Parameters<typeof session_can_run>[0];

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
	constructor(body?: BodyInit | null, init?: ResponseInit) {
		super(body, init?.status === 101 ? { ...init, status: 200 } : init);
		this.webSocket = init?.webSocket ?? null;
		if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
	}
}

function make_provider() {
	const send = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
		if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page-1" } };
		if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page-1", type: "page" }] };
		if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
		return {};
	});
	const cdp = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
	const evaluate = vi.fn(async () => ({ url: "https://controller.browser.invalid/", nonce: "nonce-1" }));
	const mainFrame = { url: vi.fn(() => "https://controller.browser.invalid/"), parentFrame: () => null };
	const context = Object.assign(new EventEmitter(), { newCDPSession: async () => cdp });
	const page = Object.assign(new EventEmitter(), {
		context: () => context, mainFrame: () => mainFrame, evaluate,
		unroute: vi.fn(async () => {}),
		setViewportSize: vi.fn(async () => {}),
	});
	Object.assign(context, { pages: () => [page] });
	const browser = Object.assign(new EventEmitter(), {
		contexts: () => [context], newBrowserCDPSession: async () => cdp,
		close: vi.fn(async () => {}),
	});
	return { send, evaluate, mainFrame, context, page, browser };
}

function make_session(options: { web?: boolean } = {}) {
	const fileRecord: SessionRecord = {
		mode: "file", version: 1, ...OWNERS, sessionId: "session-1", grantId: "grant-1", nodeId: "node_1",
		navGen: 1, loadGen: 1, controlGen: 1, control: "ready", sourceKind: "saved", sourceVersion: "v1", sourceHash: "hash",
		providerSessionId: "provider-1", pageNonce: "nonce-1", viewport: { width: 1280, height: 900 },
		command: null, commandCount: 0, htmlBytesTotal: 100, loadCount: 1,
		createdAt: Date.now(), providerAcquiredAt: Date.now(), lastActiveAt: Date.now(), attemptId: "attempt-1", closeAttempts: 0,
		inputHolder: null, viewers: {}, viewerGrants: {},
	};
	const record = ((/* iife */) => {
		if (!options.web) return fileRecord;
		// Web records have no file fields. They own page target `page-1`.
		const copy: Record<string, unknown> = {
			...fileRecord, mode: "web", agentAccess: true, pageTargetId: "page-1", profileId: "profile_1", agentBlockedHosts: [],
		};
		for (const key of ["nodeId", "sourceKind", "sourceVersion", "sourceHash", "htmlBytesTotal", "loadCount"]) delete copy[key];
		return copy as SessionRecord;
	})();
	const stored = new Map<string, unknown>([["session", structuredClone(record)]]);
	const pending: Promise<unknown>[] = [];
	const state = {
		id: { toString: () => "test-id" },
		storage: {
			get: async <T,>(key: string) => structuredClone(stored.get(key)) as T | undefined,
			list: async <T,>(options: { prefix: string }) =>
				new Map([...stored].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, structuredClone(value)])) as Map<string, T>,
			put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
			delete: async (key: string) => stored.delete(key),
			setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {},
		},
		waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
	};
	const namespace = { idFromName: (name: string) => ({ toString: () => name }), get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
	const fetchProvider = vi.fn(async () => new Response(null, { status: 101, webSocket: new WebSocketPair()[0] }));
	const env: Env = {
		BROWSER: { fetch: fetchProvider }, BROWSER_SESSIONS: namespace, BROWSER_REGISTRY: namespace,
		BROWSER_RUNNER_SECRET: "secret", BROWSER_PROFILE_KEY: Buffer.alloc(32, 1).toString("base64"), BROWSER_PREVIEW_URL: "https://preview.invalid/v0", BROWSER_WEB_DENIED_HOSTS: "blocked.test,other.test",
		LOADER: { load: () => { throw new Error("No child in session tests"); } },
	};
	const currentProvider = make_provider();
	const { browser } = currentProvider;
	vi.spyOn(provider, "connect").mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
	vi.spyOn(provider, "sessions").mockResolvedValue([]);
	let session = new BrowserSession(state, env);
	const post = async (path: string, body: unknown) => {
		const response = await session.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }));
		return await response.json() as Record<string, unknown>;
	};
	const begin = (sessionId = "session-1") => post("/run/begin", { sessionId, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" });
	const stream = (scope = OWNERS, sessionId = "session-1") => {
		const url = new URL("https://do/run/stream");
		for (const [key, value] of Object.entries({ ...scope, sessionId, commandId: "command-1" })) url.searchParams.set(key, value);
		return session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
	};
	const settle = (sessionId = "session-1") => post("/run/settle", { sessionId, commandId: "command-1" });
	const finish = (sessionId = "session-1") => post("/run/finish", { sessionId, commandId: "command-1", tainted: false, resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
	return { stored, state, fetchProvider, ...currentProvider, post, begin, stream, settle, finish,
		seed_session: (sessionId: string, providerSessionId: string) => {
			stored.set("session", { ...structuredClone(record), sessionId, providerSessionId });
		},
		restart: () => { session = new BrowserSession(state, env); },
		alarm: () => session.alarm(),
		drain: () => Promise.all(pending),
	};
}

beforeEach(() => {
	vi.stubGlobal("WebSocketPair", SocketPair);
	vi.stubGlobal("Response", SocketResponse);
	bridges.revoke.mockReset(); bridges.close.mockReset();
	bridges.inputs.length = 0;
	bridges.settle.mockReset().mockResolvedValue({ safe: true, reason: null, blockedPopups: 2 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("BrowserSession agent connection", () => {
	it.each([
		{ url: "about:blank", nonce: "nonce-1" },
		{ url: "https://controller.browser.invalid/", nonce: "changed" },
	])("closes an invalid page before the first command upgrade (%j)", async (pageState) => {
		const session = make_session();
		session.evaluate.mockResolvedValueOnce(pageState);
		await session.begin();
		expect((await session.stream()).status).toBe(503);
		await session.drain();
		expect(session.fetchProvider).not.toHaveBeenCalled();
		expect(bridges.inputs).toHaveLength(0);
		expect(session.send).toHaveBeenCalledWith("Browser.close", {});
		expect(session.stored.has("session")).toBe(false);
	});

	it.each(["popup", "context"])("closes when a new %s appears before host listeners are installed", async (extra) => {
		const session = make_session();
		const unexpected = make_provider();
		const pages = [session.page];
		const contexts = [session.context];
		let changed = false;
		Object.assign(session.context, { pages: () => pages });
		Object.assign(unexpected.context, { pages: () => [] });
		Object.assign(session.browser, { contexts: () => contexts });
		session.send.mockImplementation(async (method) => {
			if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page-1", browserContextId: "context-1" } };
			if (method === "Target.getBrowserContexts") return {
				browserContextIds: changed && extra === "context" ? ["context-1", "context-2"] : ["context-1"],
			};
			if (method === "Target.getTargets") return {
				targetInfos: [
					{ targetId: "page-1", type: "page", browserContextId: "context-1" },
					...(changed && extra === "popup" ? [{ targetId: "popup-1", type: "page", browserContextId: "context-1" }] : []),
				],
			};
			if (method === "Browser.setDownloadBehavior") {
				expect(session.context.listenerCount("page")).toBe(0);
				changed = true;
				if (extra === "popup") {
					pages.push(unexpected.page);
					session.context.emit("page", unexpected.page);
				} else contexts.push(unexpected.context);
			}
			return {};
		});
		await session.begin();
		expect((await session.stream()).status).toBe(503);
		await session.drain();
		expect(changed).toBe(true);
		expect(session.fetchProvider).not.toHaveBeenCalled();
		expect(bridges.inputs).toHaveLength(0);
		expect(session.send).toHaveBeenCalledWith("Browser.close", {});
		expect(provider.connect).toHaveBeenLastCalledWith("http://fake.host/v1/devtools/browser/provider-1?persistent=true&browser_binding=BROWSER");
		expect(session.stored.has("session")).toBe(false);
	});

	it("waits for host page validation before opening the command socket", async () => {
		const session = make_session();
		const validation = Promise.withResolvers<{ url: string; nonce: string }>();
		session.evaluate.mockReturnValueOnce(validation.promise);
		await session.begin();
		const stream = session.stream();
		await vi.waitFor(() => expect(session.evaluate).toHaveBeenCalledOnce());
		expect(session.fetchProvider).not.toHaveBeenCalled();
		expect(bridges.inputs).toHaveLength(0);
		validation.resolve({ url: "https://controller.browser.invalid/", nonce: "nonce-1" });
		expect((await stream).status).toBe(101);
		expect(session.fetchProvider).toHaveBeenCalledOnce();
		await session.settle(); await session.finish();
	});

	it("refuses wrong owners and consumes only one upgrade", async () => {
		const session = make_session();
		await session.begin();
		expect((await session.stream({ ...OWNERS, ownerId: "other" })).status).toBe(403);
		expect(session.fetchProvider).not.toHaveBeenCalled();
		const responses = await Promise.all([session.stream(), session.stream()]);
		expect(responses.map((response) => response.status).sort()).toEqual([101, 403]);
		expect(session.fetchProvider).toHaveBeenCalledTimes(1);
		expect((session.stored.get("session") as SessionRecord).command?.connection).toBe("consumed");
	});

	it("holds the command through revoke, drain, and target validation", async () => {
		const session = make_session();
		await session.begin(); await session.stream();
		expect(session.evaluate).toHaveBeenCalledOnce();
		session.evaluate.mockClear();
		const drain = Promise.withResolvers<{ safe: boolean; reason: null; blockedPopups: number }>();
		bridges.settle.mockReturnValueOnce(drain.promise);
		const settling = session.settle();
		await vi.waitFor(() => expect(bridges.settle).toHaveBeenCalledOnce());
		expect(bridges.revoke).toHaveBeenCalledOnce();
		expect((session.stored.get("session") as SessionRecord).command?.connection).toBe("revoked");
		expect(session.evaluate).not.toHaveBeenCalled();
		expect((await session.stream()).status).toBe(403);
		drain.resolve({ safe: true, reason: null, blockedPopups: 2 });
		expect(await settling).toEqual({ ok: true, blockedPopups: 2 });
		expect(session.send).toHaveBeenCalledWith("Target.getBrowserContexts");
		expect(session.send).toHaveBeenCalledWith("Target.getTargets");
		expect(session.evaluate).toHaveBeenCalledOnce();
		expect((session.stored.get("session") as SessionRecord).command?.connection).toBe("settled");
		await session.finish();
		expect((session.stored.get("session") as SessionRecord).command).toBeNull();
		expect((await session.stream()).status).toBe(403);
	});

	it.each(["consumed", "revoked"] as const)("closes after restart with %s work", async (connection) => {
		const session = make_session();
		await session.begin(); await session.stream();
		const record = session.stored.get("session") as SessionRecord;
		record.command!.connection = connection;
		session.stored.set("session", structuredClone(record));
		session.restart();
		expect((await session.settle()).ok).toBe(false);
		expect(session.send).toHaveBeenCalledWith("Browser.close", {});
		expect(session.stored.has("session")).toBe(false);
	});

	it("closes instead of releasing a command that did not settle", async () => {
		const session = make_session();
		await session.begin(); await session.stream();
		await session.finish();
		expect(bridges.close).toHaveBeenCalledOnce();
		expect(session.send).toHaveBeenCalledWith("Browser.close", {});
		expect(session.stored.has("session")).toBe(false);
	});

	it("rejects a late provider upgrade after End", async () => {
		const session = make_session();
		await session.begin();
		const upstream = Promise.withResolvers<Response>();
		session.fetchProvider.mockReturnValueOnce(upstream.promise);
		const stream = session.stream();
		await vi.waitFor(() => expect(session.fetchProvider).toHaveBeenCalledOnce());
		await session.post("/close", { sessionId: "session-1" });
		const socket = new WebSocketPair()[0];
		upstream.resolve(new Response(null, { status: 101, webSocket: socket }));
		expect((await stream).status).toBe(503);
		expect(socket.readyState).toBe(3);
		expect(session.stored.has("session")).toBe(false);
	});

	it.each(["before", "after"] as const)("keeps the replacement when the old host connects %s the new host", async (order) => {
		const session = make_session();
		type Browser = Awaited<ReturnType<typeof provider.connect>>;
		const oldHost = Promise.withResolvers<Browser>();
		const newHost = Promise.withResolvers<Browser>();
		const oldBrowser = { close: vi.fn(async () => {}) };
		const closeBrowser = { newBrowserCDPSession: session.browser.newBrowserCDPSession, close: vi.fn(async () => {}) };
		const connect = vi.mocked(provider.connect)
			.mockReturnValueOnce(oldHost.promise)
			.mockResolvedValueOnce(closeBrowser as unknown as Browser)
			.mockReturnValueOnce(newHost.promise);

		await session.begin();
		const oldStream = session.stream();
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
		await session.post("/close", { sessionId: "session-1" });
		expect(session.stored.has("session")).toBe(false);
		expect(closeBrowser.close).toHaveBeenCalledOnce();

		// Seed the record written by a successful Start; keep the same live object.
		session.seed_session("session-2", "provider-2");
		expect((await session.begin("session-2")).ok).toBe(true);
		const newStream = session.stream(OWNERS, "session-2");
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
		expect(connect.mock.calls[2]?.[0]).toContain("/provider-2?");

		if (order === "before") {
			oldHost.resolve(oldBrowser as unknown as Browser);
			expect((await oldStream).status).toBe(503);
		}
		newHost.resolve(session.browser as unknown as Browser);
		expect((await newStream).status).toBe(101);
		if (order === "after") {
			oldHost.resolve(oldBrowser as unknown as Browser);
			expect((await oldStream).status).toBe(503);
		}
		await session.drain();
		expect(oldBrowser.close).toHaveBeenCalledOnce();
		expect(session.browser.close).not.toHaveBeenCalled();
		expect(bridges.close).not.toHaveBeenCalled();
		expect(session.fetchProvider).toHaveBeenCalledExactlyOnceWith(
			"http://fake.host/v1/devtools/browser/provider-2?persistent=true",
			{ headers: { Upgrade: "websocket" } },
		);
		expect(session.stored.get("session")).toMatchObject({
			sessionId: "session-2", control: "agent", command: { connection: "consumed" },
		});
		expect((await session.settle("session-2")).ok).toBe(true);
		expect(await session.finish("session-2")).toEqual({ ok: true, state: "ready" });
		expect(session.browser.close).not.toHaveBeenCalled();
	});

	it("closes when the page nonce changed", async () => {
		const session = make_session();
		await session.begin(); await session.stream();
		session.evaluate.mockResolvedValueOnce({ url: "https://controller.browser.invalid/", nonce: "changed" });
		expect((await session.settle()).ok).toBe(false);
		expect(session.stored.has("session")).toBe(false);
	});

	it.each(["about:blank", "https://controller.browser.invalid/"])("closes a late main-frame navigation to %s after command finish", async (url) => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		expect(session.stored.get("session")).toMatchObject({ control: "ready", command: null });
		session.mainFrame.url.mockReturnValue(url);
		session.page.emit("framenavigated", session.mainFrame);
		await session.drain();
		expect(session.send).toHaveBeenCalledWith("Browser.close", {});
		expect(session.stored.has("session")).toBe(false);
	});

	it("keeps the session when a child frame navigates", async () => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		session.page.emit("framenavigated", { url: () => "about:blank", parentFrame: () => session.mainFrame });
		await session.drain();
		expect(session.stored.get("session")).toMatchObject({ sessionId: "session-1", control: "ready" });
		expect(session.browser.close).not.toHaveBeenCalled();
	});

	it("closes a popup after command finish without closing the shared page", async () => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		const popup = { close: vi.fn(async () => {}), isClosed: () => true };
		session.context.emit("page", popup);
		await session.drain();
		expect(popup.close).toHaveBeenCalledOnce();
		expect(session.browser.close).not.toHaveBeenCalled();
		expect(session.stored.get("session")).toMatchObject({ control: "ready", command: null });
	});

	it.each([false, true])("requires a popup to be gone after a close error (alreadyClosed=%s)", async (alreadyClosed) => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		const popup = { close: vi.fn(async () => { throw new Error("Popup close failed"); }), isClosed: () => alreadyClosed };
		session.context.emit("page", popup);
		await session.drain();
		expect(popup.close).toHaveBeenCalledOnce();
		expect(session.stored.has("session")).toBe(alreadyClosed);
		if (alreadyClosed) expect(session.browser.close).not.toHaveBeenCalled();
		else expect(session.send).toHaveBeenCalledWith("Browser.close", {});
	});

	it.each(["missing", "present", "invalid"] as const)("checks popup inventory after a duplicate close (%s)", async (inventory) => {
		const session = make_session();
		await session.begin(); await session.stream();
		session.send.mockRejectedValueOnce(new Error("Target already closed"));
		session.send.mockResolvedValueOnce(inventory === "invalid" ? {} : {
			targetInfos: [{ targetId: "page-1", type: "page" }, ...(inventory === "present" ? [{ targetId: "popup-1", type: "page" }] : [])],
		});
		const closePopup = bridges.inputs[0]!.onPopup("popup-1");
		if (inventory === "missing") await expect(closePopup).resolves.toBeUndefined();
		else await expect(closePopup).rejects.toThrow("Popup could not be closed.");
		expect(session.send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "popup-1" });
		expect(session.send).toHaveBeenLastCalledWith("Target.getTargets");
		await session.settle(); await session.finish();
	});

	it("ignores late page events from a retired host", async () => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		await session.post("/close", { sessionId: "session-1" });
		const replacement = make_provider();
		vi.mocked(provider.connect).mockResolvedValue(replacement.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		session.seed_session("session-2", "provider-2");
		await session.begin("session-2"); await session.stream(OWNERS, "session-2");
		await session.settle("session-2"); await session.finish("session-2");

		session.mainFrame.url.mockReturnValue("about:blank");
		session.page.emit("framenavigated", session.mainFrame);
		session.context.emit("page", { close: vi.fn(async () => {}), isClosed: () => false });
		await session.drain();
		expect(session.stored.get("session")).toMatchObject({ sessionId: "session-2", control: "ready" });
		expect(replacement.browser.close).not.toHaveBeenCalled();
		expect(replacement.send).not.toHaveBeenCalledWith("Browser.close", {});
	});

	it.each(["https://controller.browser.invalid/", "about:blank"])("allows a trusted reload only to the controller (%s)", async (url) => {
		const session = make_session();
		await session.begin(); await session.stream(); await session.settle(); await session.finish();
		const uuid = "00000000-0000-0000-0000-000000000009";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		Object.assign(session.page, {
			route: async () => {},
			goto: async () => {
				session.mainFrame.url.mockReturnValue(url);
				session.page.emit("framenavigated", session.mainFrame);
				await session.drain();
			},
			waitForFunction: async () => {},
			evaluate: async () => ({ ready: true, error: null, nonce: `${uuid}-0` }),
		});
		const result = await session.post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "hash2", html: "<input />",
		});
		await session.drain();
		if (url === "https://controller.browser.invalid/") {
			expect(result).toMatchObject({ ok: true });
			expect(session.stored.get("session")).toMatchObject({ sessionId: "session-1", control: "ready", loadGen: 2 });
			expect(provider.connect).toHaveBeenCalledOnce();
			expect(session.browser.close).not.toHaveBeenCalled();
			expect(session.send).not.toHaveBeenCalledWith("Browser.close", {});
		} else {
			expect(result).toMatchObject({ ok: false });
			expect(session.send).toHaveBeenCalledWith("Browser.close", {});
			expect(session.stored.has("session")).toBe(false);
		}
	});

	it("closes a provider upgrade that arrives after its timeout", async () => {
		vi.useFakeTimers();
		const session = make_session();
		await session.begin();
		const upstream = Promise.withResolvers<Response>();
		session.fetchProvider.mockReturnValueOnce(upstream.promise);
		const stream = session.stream();
		await vi.waitFor(() => expect(session.fetchProvider).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await stream).status).toBe(503);
		const socket = new WebSocketPair()[0];
		upstream.resolve(new Response(null, { status: 101, webSocket: socket }));
		await vi.waitFor(() => expect(socket.readyState).toBe(3));
		expect(session.stored.has("session")).toBe(false);
	});
});

describe("BrowserSession web agent access", () => {
	it("gives the bridge web mode and the deny list, and settles without the page nonce check", async () => {
		const session = make_session({ web: true });
		expect(await session.begin()).toMatchObject({ ok: true });
		expect((await session.stream()).status).toBe(101);
		expect(bridges.inputs[0]).toMatchObject({ mode: "web", deniedHosts: ["blocked.test", "other.test"] });
		expect(await session.settle()).toEqual({ ok: true, blockedPopups: 2 });
		expect(session.send).toHaveBeenCalledWith("Target.getTargets");
		expect(session.evaluate).not.toHaveBeenCalled();
		expect(await session.finish()).toEqual({ ok: true, state: "ready" });
	});

	it("revokes a running bridge and retires the lease when access turns off", async () => {
		const session = make_session({ web: true });
		await session.begin(); await session.stream();
		expect(await session.post("/agent-access", { sessionId: "session-1", on: false }))
			.toMatchObject({ ok: true, session: { agentAccess: false, controlGen: 2 } });
		expect(bridges.revoke).toHaveBeenCalledOnce();
		expect((await session.settle()).ok).toBe(true);
		expect(await session.finish()).toEqual({ ok: true, state: "ready" });
		expect(await session.post("/run/begin", { sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 2, commandId: "command-2" }))
			.toMatchObject({ ok: false, error: { code: "agent_access_off" } });
	});

	it("revokes a bridge that connects after access turned off", async () => {
		const session = make_session({ web: true });
		await session.begin();
		await session.post("/agent-access", { sessionId: "session-1", on: false });
		expect(bridges.revoke).not.toHaveBeenCalled();
		expect((await session.stream()).status).toBe(101);
		expect(bridges.revoke).toHaveBeenCalledOnce();
		await session.settle(); await session.finish();
	});
});

describe("BrowserSession usage receipts", () => {
	it("writes a receipt on close and returns it from close and status", async () => {
		const session = make_session();
		const acquiredAt = (session.stored.get("session") as SessionRecord).providerAcquiredAt;
		const usage = { providerAcquiredAt: acquiredAt, endedAt: expect.any(Number), reason: "close" };
		const closed = await session.post("/close", { sessionId: "session-1" });
		expect(closed).toEqual({ ok: true, existed: true, verified: true, usage });
		expect(session.stored.get("usage:session-1")).toEqual({ sessionId: "session-1", ...usage });
		expect(await session.post("/status", { sessionId: "session-1" })).toEqual({ ok: true, alive: false, closing: false, usage: closed.usage, profileStored: false });
		// A repeated close still returns the receipt.
		expect(await session.post("/close", { sessionId: "session-1" })).toEqual({ ok: true, existed: false, verified: true, usage: closed.usage });
	});

	it("writes an expired receipt from the alarm", async () => {
		const session = make_session();
		const acquiredAt = Date.now() - LIMITS.sessionTotalMs - 1000;
		session.stored.set("session", { ...(session.stored.get("session") as SessionRecord), providerAcquiredAt: acquiredAt });
		await session.alarm();
		expect(session.stored.has("session")).toBe(false);
		expect(session.stored.get("usage:session-1")).toEqual({
			sessionId: "session-1", providerAcquiredAt: acquiredAt, endedAt: expect.any(Number), reason: "expired",
		});
	});

	it("reports closing and no receipt while the provider close is unverified", async () => {
		const session = make_session();
		vi.mocked(provider.connect).mockRejectedValueOnce(new Error("Provider offline"));
		expect(await session.post("/close", { sessionId: "session-1" })).toEqual({ ok: true, existed: true, verified: false, usage: null });
		expect(await session.post("/status", { sessionId: "session-1" })).toEqual({ ok: true, alive: false, closing: true, usage: null, profileStored: false });
		expect(session.stored.has("usage:session-1")).toBe(false);
	});
});
