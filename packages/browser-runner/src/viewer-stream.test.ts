import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as provider from "@cloudflare/playwright";
import { BrowserSession, session_can_run, type Env } from "./index";

const OWNERS = { ownerId: "user_1", organizationId: "org_1", workspaceId: "ws_1" };
const NativeResponse = Response;
type SessionRecord = Parameters<typeof session_can_run>[0];
const TIMINGS = { queueMs: expect.any(Number), authorizeMs: expect.any(Number), readyMs: expect.any(Number), applyMs: expect.any(Number) };

class Socket extends EventTarget {
	peer: Socket | null = null;
	readyState = 1;
	received: Array<string | Uint8Array> = [];
	closed: { code: number; reason: string } | null = null;

	accept() {}

	send(data: string | Uint8Array) {
		if (this.readyState !== 1 || !this.peer) throw new Error("Socket closed");
		this.peer.received.push(data);
		this.peer.dispatchEvent(new MessageEvent("message", { data }));
	}

	close(code = 1000, reason = "") {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.closed = { code, reason };
		if (this.peer) {
			this.peer.readyState = 3;
			this.peer.closed = { code, reason };
			this.peer.dispatchEvent(new Event("close"));
		}
		this.dispatchEvent(new Event("close"));
	}
}

class SocketPair {
	0 = new Socket();
	1 = new Socket();

	constructor() {
		this[0].peer = this[1];
		this[1].peer = this[0];
	}
}

class SocketResponse extends NativeResponse {
	readonly webSocket: Socket | undefined;

	constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: Socket }) {
		super(body, init?.status === 101 ? { ...init, status: 200 } : init);
		this.webSocket = init?.webSocket;
		// Node's Response rejects 101; Workers attach the upgraded socket to it.
		if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
	}
}

function messages(socket: Socket) {
	return socket.received.filter((data): data is string => typeof data === "string")
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

function frames(socket: Socket) {
	return socket.received.filter((data): data is Uint8Array => data instanceof Uint8Array);
}

function make_cdp() {
	return Object.assign(new EventEmitter(), {
		send: vi.fn(async (method: string, _params?: unknown): Promise<Record<string, unknown>> =>
			method === "Target.getTargetInfo" ? { targetInfo: { targetId: "page-1" } } :
				method === "Target.getBrowserContexts" ? { browserContextIds: [] } :
					method === "Target.getTargets" ? { targetInfos: [{ targetId: "page-1", type: "page" }] } : {}),
		detach: vi.fn(async () => {}),
	});
}

function make_provider() {
	const hostCdp = make_cdp();
	const cdp = make_cdp();
	const viewerCdps = [cdp];
	const newCDPSession = vi.fn(async () => {
		const next = make_cdp();
		viewerCdps.push(next);
		return next;
	}).mockResolvedValueOnce(hostCdp).mockResolvedValueOnce(cdp);
	const mainFrame = { url: () => "https://controller.browser.invalid/", parentFrame: () => null };
	const context = Object.assign(new EventEmitter(), { newCDPSession });
	const page = Object.assign(new EventEmitter(), {
		setViewportSize: vi.fn(async (_viewport: { width: number; height: number }) => {}),
		unroute: vi.fn(async () => {}),
		evaluate: vi.fn(async () => ({ url: "https://controller.browser.invalid/", nonce: "nonce-1" })),
		context: () => context,
		mainFrame: () => mainFrame,
		mouse: {
			move: vi.fn(async (_x: number, _y: number) => {}),
			click: vi.fn(async () => {}),
			down: vi.fn(async () => {}),
			up: vi.fn(async (_options: { button: string }) => {}),
			wheel: vi.fn(async () => {}),
		},
		keyboard: {
			press: vi.fn(async () => {}),
			down: vi.fn(async (_key: string) => {}),
			up: vi.fn(async (_key: string) => {}),
			type: vi.fn(async () => {}),
		},
	});
	Object.assign(context, { pages: () => [page] });
	const browser = Object.assign(new EventEmitter(), {
		contexts: () => [context],
		newBrowserCDPSession: async () => hostCdp,
		close: vi.fn(async () => {}),
	});
	return { cdp, hostCdp, viewerCdps, newCDPSession, page, browser };
}

function make_session() {
	const now = Date.now();
	const record: SessionRecord = {
		version: 1,
		...OWNERS,
		sessionId: "session-1",
		grantId: "admission-1",
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
		inputHolder: null,
		viewers: {},
		viewerGrants: {},
	};
	const stored = new Map<string, unknown>([["session", structuredClone(record)]]);
	const get = vi.fn(async (key: string) => structuredClone(stored.get(key)));
	const put = vi.fn(async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); });
	const setAlarm = vi.fn(async () => {});
	const pending = new Set<Promise<unknown>>();
	const namespace = {
		idFromName: (name: string) => ({ toString: () => name }),
		get: () => ({ fetch: async () => Response.json({ ok: true }) }),
	};
	const env: Env = {
		BROWSER: { fetch },
		BROWSER_SESSIONS: namespace,
		BROWSER_REGISTRY: namespace,
		BROWSER_RUNNER_SECRET: "test-secret",
		BROWSER_PREVIEW_URL: "https://preview.invalid/v0",
		LOADER: { load: () => { throw new Error("No snippets in viewer tests"); } },
	};
	const session = new BrowserSession({
		id: { toString: () => "test-session" },
		storage: {
			get: async <T,>(key: string) => await get(key) as T | undefined,
			put,
			delete: async (key) => stored.delete(key),
			setAlarm,
			getAlarm: async () => null,
			deleteAlarm: async () => {},
		},
		waitUntil: (promise) => {
			pending.add(promise);
			void promise.then(() => pending.delete(promise), () => pending.delete(promise));
		},
	}, env);
	const mocked = make_provider();
	const connect = vi.spyOn(provider, "connect").mockResolvedValue(mocked.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
	vi.spyOn(provider, "sessions").mockResolvedValue([]);

	const post = async (path: string, body: unknown) => {
		const response = await session.fetch(new Request(`https://object${path}`, {
			method: "POST", body: JSON.stringify(body),
		}));
		return await response.json() as Record<string, unknown>;
	};
	const open_socket = async () => {
		const url = new URL("https://object/viewer/stream");
		for (const [name, value] of Object.entries(OWNERS)) url.searchParams.set(name, value);
		const response = await session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
		expect(response.status).toBe(101);
		const socket = (response as SocketResponse).webSocket;
		if (!socket) throw new Error("Missing viewer socket");
		return socket;
	};
	const attach = async (host = "docked") => {
		const grant = await post("/viewer/grant", { sessionId: "session-1", navGen: 1 });
		const socket = await open_socket();
		socket.send(JSON.stringify({ ...OWNERS, grantId: grant.grantId, host }));
		await vi.waitFor(() => expect(messages(socket).some((message) => message.t === "hello")).toBe(true));
		const hello = messages(socket).find((message) => message.t === "hello");
		if (typeof hello?.viewerId !== "string") throw new Error("Missing viewer id");
		return { socket, viewerId: hello.viewerId, grantId: grant.grantId };
	};
	const drain = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	const emit_frame = (value: number) => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, value, 0xff, 0xd9]);
		mocked.viewerCdps.at(-1)!.emit("Page.screencastFrame", { sessionId: 1, data: btoa(String.fromCharCode(...bytes)) });
		return bytes;
	};
	return { ...mocked, connect, session, stored, get, put, setAlarm, post, open_socket, attach, drain, emit_frame };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
	vi.stubGlobal("WebSocketPair", SocketPair);
	vi.stubGlobal("Response", SocketResponse);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("BrowserSession viewer stream", () => {
	it("refuses an unknown grant without writing or connecting to the provider", async () => {
		const { open_socket, drain, connect, stored, put } = make_session();
		const before = structuredClone(stored.get("session"));
		const socket = await open_socket();
		socket.send(JSON.stringify({ ...OWNERS, grantId: "unknown", host: "docked" }));
		await drain();
		expect(socket.closed).toEqual({ code: 4401, reason: "grant refused" });
		expect(messages(socket)).toEqual([]);
		expect(put).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
		expect(stored.get("session")).toEqual(before);
	});

	it("refuses a reused grant without changing the attached viewer", async () => {
		const { attach, open_socket, drain, connect, stored, put } = make_session();
		const viewer = await attach();
		await drain();
		const before = structuredClone(stored.get("session"));
		put.mockClear();
		const socket = await open_socket();
		socket.send(JSON.stringify({ ...OWNERS, grantId: viewer.grantId, host: "detached" }));
		await drain();
		expect(socket.closed).toEqual({ code: 4401, reason: "grant refused" });
		expect(messages(socket)).toEqual([]);
		expect(viewer.socket.closed).toBeNull();
		expect(put).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledTimes(1);
		expect(stored.get("session")).toEqual(before);
	});

	it("requires a grant before answering latency pings", async () => {
		const { open_socket, drain, connect, get, put } = make_session();
		const socket = await open_socket();
		socket.send(JSON.stringify({ t: "ping", seq: 1 }));
		await drain();
		expect(socket.closed).toEqual({ code: 4401, reason: "bad grant message" });
		expect(messages(socket)).toEqual([]);
		expect(get).toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
	});

	it("rate limits authenticated pings without storage, activity, or provider work", async () => {
		const { attach, drain, connect, cdp, hostCdp, stored, get, put, setAlarm } = make_session();
		const viewer = await attach();
		await drain();
		const before = structuredClone(stored.get("session"));
		const now = Date.now();
		get.mockClear();
		put.mockClear();
		setAlarm.mockClear();
		connect.mockClear();
		cdp.send.mockClear();
		hostCdp.send.mockClear();
		for (const seq of [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
			viewer.socket.send(JSON.stringify({ t: "ping", seq }));
		}
		viewer.socket.send(JSON.stringify({ t: "ping", seq: 1 }));
		viewer.socket.send(JSON.stringify({ t: "ping", seq: 2 }));
		vi.setSystemTime(now + 999);
		viewer.socket.send(JSON.stringify({ t: "ping", seq: 3 }));
		vi.setSystemTime(now + 1000);
		viewer.socket.send(JSON.stringify({ t: "ping", seq: 4 }));
		// Leave the timer pending to check the deadline inside the ping handler too.
		vi.setSystemTime(now + 30_001);
		viewer.socket.send(JSON.stringify({ t: "ping", seq: 5 }));
		await drain();

		expect(messages(viewer.socket).filter((message) => message.t === "pong")).toEqual([
			{ t: "pong", seq: 1 }, { t: "pong", seq: 4 },
		]);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(setAlarm).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
		expect(cdp.send).not.toHaveBeenCalled();
		expect(hostCdp.send).not.toHaveBeenCalled();
		expect(stored.get("session")).toEqual(before);
	});

	it("caps live viewers at two", async () => {
		const { attach, open_socket, post, drain, connect, stored } = make_session();
		const first = await attach();
		const second = await attach("detached");
		const grant = await post("/viewer/grant", { sessionId: "session-1", navGen: 1 });
		const socket = await open_socket();
		socket.send(JSON.stringify({ ...OWNERS, grantId: grant.grantId, host: "docked" }));
		await drain();
		expect(socket.closed).toEqual({ code: 4401, reason: "grant refused" });
		expect(messages(socket)).toEqual([]);
		expect(first.socket.closed).toBeNull();
		expect(second.socket.closed).toBeNull();
		expect(Object.keys((stored.get("session") as SessionRecord).viewers).sort()).toEqual([first.viewerId, second.viewerId].sort());
		expect((stored.get("session") as SessionRecord).viewerGrants).toEqual({});
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("shares one provider producer and sends the cached frame to a second viewer", async () => {
		const { attach, drain, connect, cdp, emit_frame, stored } = make_session();
		const first = await attach();
		await drain();
		const frame = emit_frame(1);
		const second = await attach("detached");
		await drain();

		expect(connect).toHaveBeenCalledTimes(1);
		expect(cdp.send.mock.calls.filter(([method]) => method === "Page.startScreencast")).toHaveLength(1);
		expect(frames(first.socket)).toEqual([frame]);
		expect(frames(second.socket)).toEqual([frame]);
		expect(messages(second.socket).find((message) => message.t === "hello")).toEqual({
			t: "hello", viewerId: second.viewerId, viewport: { width: 1280, height: 900 }, control: "ready", controlGen: 1,
		});
		expect(stored.get("session")).toMatchObject({
			viewers: { [first.viewerId]: { host: "docked" }, [second.viewerId]: { host: "detached" } },
		});
		expect(messages(second.socket)).toContainEqual({ t: "frame", seq: 1, loadGen: 1 });
	});

	it("closes the session when the shared host connection fails", async () => {
		const { attach, drain, browser, stored } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();

		browser.emit("disconnected");
		await drain();
		expect(first.socket.closed?.code).toBe(4404);
		expect(second.socket.closed?.code).toBe(4404);
		expect(stored.has("session")).toBe(false);
	});

	it("reuses the host when viewers return and ignores events from the old stream", async () => {
		const { attach, drain, connect, cdp, hostCdp, browser, newCDPSession, post, emit_frame } = make_session();
		const first = await attach();
		await drain();
		first.socket.close();
		await drain();
		expect(cdp.send).toHaveBeenCalledWith("Page.stopScreencast");
		expect(cdp.detach).toHaveBeenCalledOnce();
		expect(hostCdp.detach).not.toHaveBeenCalled();
		expect(browser.close).not.toHaveBeenCalled();

		const second = await attach();
		await drain();
		expect(connect).toHaveBeenCalledOnce();
		expect(newCDPSession).toHaveBeenCalledTimes(3);
		cdp.emit("Page.screencastFrame", { sessionId: 1, data: btoa("old frame") });
		cdp.emit("Inspector.detached");
		const frame = emit_frame(2);
		await drain();
		expect(frames(second.socket)).toEqual([frame]);
		expect(second.socket.closed).toBeNull();
		expect(browser.close).not.toHaveBeenCalled();

		const closing = make_provider();
		connect.mockResolvedValueOnce(closing.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		expect(await post("/close", { sessionId: "session-1" })).toMatchObject({ ok: true, verified: true });
		await drain();
		expect(browser.close).toHaveBeenCalledOnce();
		expect(closing.hostCdp.send).toHaveBeenCalledWith("Browser.close", {});
	});

	it("reuses the host and restores viewport metrics after a settled command", async () => {
		const { attach, drain, connect, cdp, hostCdp, browser, newCDPSession, page, post, stored, emit_frame } = make_session();
		const viewer = await attach();
		await drain();
		expect(await post("/run/begin", {
			sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1",
		})).toMatchObject({ ok: true });
		const record = structuredClone(stored.get("session")) as SessionRecord;
		record.command!.connection = "settled";
		stored.set("session", record);
		expect(await post("/run/finish", {
			sessionId: "session-1", commandId: "command-1", tainted: false,
			resultBytes: 0, imageCount: 0, imageBytes: 0, viewport: { width: 800, height: 600 },
		})).toMatchObject({ ok: true, state: "ready" });
		await drain();

		expect(connect).toHaveBeenCalledOnce();
		expect(newCDPSession).toHaveBeenCalledTimes(3);
		expect(cdp.detach).toHaveBeenCalledOnce();
		expect(browser.close).not.toHaveBeenCalled();
		expect(page.setViewportSize).toHaveBeenLastCalledWith({ width: 800, height: 600 });
		expect(hostCdp.send).toHaveBeenLastCalledWith("Emulation.setDeviceMetricsOverride", {
			width: 800, height: 600, deviceScaleFactor: 1, mobile: false, screenWidth: 800, screenHeight: 600,
		});
		cdp.emit("Page.screencastFrame", { sessionId: 1, data: btoa("old frame") });
		const frame = emit_frame(2);
		expect(frames(viewer.socket)).toEqual([frame]);
		expect(stored.get("session")).toMatchObject({ command: null, commandCount: 1, viewport: { width: 800, height: 600 } });
	});

	it("keeps only the latest waiting frame and lets viewers acknowledge separately", async () => {
		const { attach, drain, cdp, emit_frame } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();
		const frame1 = emit_frame(1);
		const frame2 = emit_frame(2);
		emit_frame(3);
		const frame4 = emit_frame(4);
		expect(frames(first.socket)).toEqual([frame1, frame2]);
		expect(frames(second.socket)).toEqual([frame1, frame2]);

		first.socket.send(JSON.stringify({ t: "frame-ack", seq: 1 }));
		expect(frames(first.socket)).toEqual([frame1, frame2, frame4]);
		first.socket.send(JSON.stringify({ t: "frame-ack", seq: 1 }));
		const frame5 = emit_frame(5);
		expect(frames(first.socket)).toEqual([frame1, frame2, frame4]);
		second.socket.send(JSON.stringify({ t: "frame-ack", seq: 1 }));
		expect(frames(second.socket)).toEqual([frame1, frame2, frame5]);
		first.socket.send(JSON.stringify({ t: "frame-ack", seq: 2 }));
		expect(frames(first.socket)).toEqual([frame1, frame2, frame4, frame5]);
		expect(cdp.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toEqual([
			["Page.screencastFrameAck", { sessionId: 1 }],
			["Page.screencastFrameAck", { sessionId: 1 }],
			["Page.screencastFrameAck", { sessionId: 1 }],
			["Page.screencastFrameAck", { sessionId: 1 }],
			["Page.screencastFrameAck", { sessionId: 1 }],
		]);
	});

	it("delivers the press and release frames before either frame is acknowledged", async () => {
		const { attach, drain, post, page, emit_frame } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		page.mouse.down.mockImplementationOnce(async () => { emit_frame(1); });
		page.mouse.up.mockImplementationOnce(async () => { emit_frame(2); });
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "mouse.up", button: "left" }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));
		expect(frames(viewer.socket).map((frame) => frame[4])).toEqual([1, 2]);
		expect(messages(viewer.socket).filter((message) => message.t === "frame")).toEqual([
			{ t: "frame", seq: 1, loadGen: 1 },
			{ t: "frame", seq: 2, loadGen: 1 },
		]);
	});

	it("ignores wrong, future, and out-of-order frame acknowledgements", async () => {
		const { attach, drain, emit_frame } = make_session();
		const viewer = await attach();
		await drain();
		const frame1 = emit_frame(1);
		const frame2 = emit_frame(2);
		const frame3 = emit_frame(3);
		for (const seq of [null, 0, -1, 1.5, "1", 2, 3, 999]) {
			viewer.socket.send(JSON.stringify({ t: "frame-ack", seq }));
		}
		expect(frames(viewer.socket)).toEqual([frame1, frame2]);
		viewer.socket.send(JSON.stringify({ t: "frame-ack", seq: 1 }));
		expect(frames(viewer.socket)).toEqual([frame1, frame2, frame3]);
		const frame4 = emit_frame(4);
		viewer.socket.send(JSON.stringify({ t: "frame-ack", seq: 1 }));
		viewer.socket.send(JSON.stringify({ t: "frame-ack", seq: 4 }));
		expect(frames(viewer.socket)).toEqual([frame1, frame2, frame3]);
		viewer.socket.send(JSON.stringify({ t: "frame-ack", seq: 2 }));
		expect(frames(viewer.socket)).toEqual([frame1, frame2, frame3, frame4]);
	});

	it("skips unchanged moves only after checking the current holder", async () => {
		const { attach, drain, post, page } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: first.viewerId });
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 1, ok: true }));
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));
		second.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 3, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(second.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 3, ok: false, code: "control" }));
		expect(page.mouse.move).toHaveBeenCalledTimes(1);
		expect(page.mouse.move).toHaveBeenCalledWith(10, 20);
	});

	it("refuses input from an earlier human lease without refreshing activity", async () => {
		const { attach, drain, post, page, put, stored } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		await post("/control/to-agent", { sessionId: "session-1", navGen: 1 });
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const before = structuredClone(stored.get("session"));
		put.mockClear();
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", seq: 1, ok: false, code: "control", timings: TIMINGS }));
		expect(page.mouse.move).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(stored.get("session")).toEqual(before);

		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 4, loadGen: 1, seq: 2, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", seq: 2, ok: true, timings: TIMINGS }));
		expect(page.mouse.move).toHaveBeenCalledOnce();
	});

	it("reports storage and input phase times without input payloads", async () => {
		const { attach, drain, post, page, put } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const write = put.getMockImplementation()!;
		put.mockImplementationOnce(async (key, value) => {
			vi.setSystemTime(Date.now() + 7);
			await write(key, value);
		});
		page.mouse.move.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 11); });
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({
			t: "input-ack", seq: 1, ok: true,
			timings: { queueMs: expect.any(Number), authorizeMs: 7, readyMs: 0, applyMs: 11 },
		}));
	});

	it("releases held buttons and keys before handing input to another viewer", async () => {
		const { attach, drain, post, page, stored } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: first.viewerId });
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "key.down", key: "Shift" }));
		await vi.waitFor(() => expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));

		const taken = await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: second.viewerId });
		expect(taken).toMatchObject({ ok: true, control: "human" });
		expect(page.mouse.up).toHaveBeenCalledWith({ button: "left" });
		expect(page.keyboard.up).toHaveBeenCalledWith("Shift");
		expect(stored.get("session")).toMatchObject({ inputHolder: second.viewerId });
		first.socket.send(JSON.stringify({ t: "input", controlGen: 3, loadGen: 1, seq: 3, kind: "mouse.move", x: 20, y: 30 }));
		second.socket.send(JSON.stringify({ t: "input", controlGen: 3, loadGen: 1, seq: 3, kind: "mouse.move", x: 20, y: 30 }));
		await vi.waitFor(() => expect(messages(second.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 3, ok: true }));
		expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 3, ok: false, code: "control" });
		expect(page.mouse.move).toHaveBeenCalledTimes(1);
		expect(page.mouse.up.mock.invocationCallOrder[0]).toBeLessThan(page.mouse.move.mock.invocationCallOrder[0]!);
	});

	it("releases an in-flight button press before another viewer takes control", async () => {
		const { attach, drain, post, page, stored } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: first.viewerId });
		const pressing = Promise.withResolvers<void>();
		page.mouse.down.mockImplementationOnce(() => pressing.promise);
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		await vi.waitFor(() => expect(page.mouse.down).toHaveBeenCalledTimes(1));
		const taking = post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: second.viewerId });
		await vi.advanceTimersByTimeAsync(1);
		expect(stored.get("session")).toMatchObject({ inputHolder: first.viewerId });

		pressing.resolve();
		expect(await taking).toMatchObject({ ok: true, control: "human" });
		expect(page.mouse.up).toHaveBeenCalledTimes(1);
		expect(page.mouse.up).toHaveBeenCalledWith({ button: "left" });
		expect(stored.get("session")).toMatchObject({ inputHolder: second.viewerId });
		expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 1, ok: true });
	});

	it("releases control and held input when the controlling socket closes", async () => {
		const { attach, drain, post, page, browser, cdp, stored } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const controlGen = (stored.get("session") as SessionRecord).controlGen;
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "key.down", key: "Shift" }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));

		viewer.socket.close();
		await drain();
		expect(page.mouse.up).toHaveBeenCalledWith({ button: "left" });
		expect(page.keyboard.up).toHaveBeenCalledWith("Shift");
		expect(stored.get("session")).toMatchObject({ control: "ready", controlGen: controlGen + 1, inputHolder: null, viewers: {} });
		expect(cdp.detach).toHaveBeenCalledTimes(1);
		expect(browser.close).not.toHaveBeenCalled();
		expect(page.keyboard.up.mock.invocationCallOrder[0]).toBeLessThan(cdp.detach.mock.invocationCallOrder[0]!);
	});

	it("closes the provider session when a failed stream cannot release held input", async () => {
		const { attach, drain, post, browser, hostCdp, stored } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "key.down", key: "Shift" }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));

		browser.emit("disconnected");
		await drain();
		expect(viewer.socket.closed?.code).toBe(4404);
		expect(stored.has("session")).toBe(false);
		expect(hostCdp.send).toHaveBeenCalledWith("Browser.close", {});
	});

	it("closes the session when a frame ACK fails while input is in flight", async () => {
		const { attach, drain, post, page, cdp, hostCdp, stored, emit_frame } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const pressing = Promise.withResolvers<void>();
		page.mouse.down.mockImplementationOnce(() => pressing.promise);
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		await vi.waitFor(() => expect(page.mouse.down).toHaveBeenCalledTimes(1));

		cdp.send.mockRejectedValueOnce(new Error("Frame ACK failed"));
		emit_frame(1);
		await vi.waitFor(() => expect(stored.has("session")).toBe(false));
		expect(viewer.socket.closed?.code).toBe(1011);
		expect(hostCdp.send).toHaveBeenCalledWith("Browser.close", {});
		pressing.resolve();
		await drain();
		expect(stored.has("session")).toBe(false);
	});

	it("drains the applied action and refuses queued old input during takeover", async () => {
		const { attach, drain, post, page } = make_session();
		const first = await attach();
		const second = await attach("detached");
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: first.viewerId });
		const moving = Promise.withResolvers<void>();
		page.mouse.move.mockImplementationOnce(() => moving.promise);
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(page.mouse.move).toHaveBeenCalledTimes(1));
		first.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "mouse.move", x: 30, y: 40 }));
		let completed = false;
		const taking = post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: second.viewerId }).then((result) => {
			completed = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(completed).toBe(false);
		moving.resolve();
		expect(await taking).toMatchObject({ ok: true, control: "human" });
		expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 1, ok: true });
		expect(messages(first.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: false, code: "control" });
		expect(page.mouse.move).toHaveBeenCalledTimes(1);
	});

	it("keeps queued input valid when its viewer grant is renewed", async () => {
		const { attach, drain, post, page, stored } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const moving = Promise.withResolvers<void>();
		page.mouse.move.mockImplementationOnce(() => moving.promise);
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(page.mouse.move).toHaveBeenCalledTimes(1));
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 2, kind: "mouse.move", x: 30, y: 40 }));
		const grantedUntil = (stored.get("session") as SessionRecord).viewers[viewer.viewerId]!.grantedUntil;
		await vi.advanceTimersByTimeAsync(1);
		const renewed = await post("/viewer/renew", { sessionId: "session-1", viewerId: viewer.viewerId });
		expect(renewed).toMatchObject({ ok: true });
		expect(renewed.grantedUntil).toBeGreaterThan(grantedUntil);
		expect(stored.get("session")).toMatchObject({ viewers: { [viewer.viewerId]: { grantedUntil: renewed.grantedUntil } } });
		moving.resolve();
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: true }));
		expect(page.mouse.move.mock.calls).toEqual([[10, 20], [30, 40]]);
	});

	it("waits for the first host page check before reload changes its nonce", async () => {
		const { attach, drain, post, page, browser, connect, stored } = make_session();
		const validation = Promise.withResolvers<{ url: string; nonce: string }>();
		const uuid = "00000000-0000-0000-0000-000000000001";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		const evaluate = vi.fn().mockReturnValueOnce(validation.promise)
			.mockResolvedValue({ url: "https://controller.browser.invalid/", ready: true, error: null, nonce: `${uuid}-0` });
		const route = vi.fn(async () => {});
		const goto = vi.fn(async () => {});
		Object.assign(page, { route, goto, evaluate, waitForFunction: async () => {} });
		await attach();
		await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());

		const reload = post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<input />",
		});
		await vi.waitFor(() => expect((stored.get("session") as SessionRecord).command?.id).toMatch(/^reload:/));
		await vi.advanceTimersByTimeAsync(1);
		expect(connect).toHaveBeenCalledOnce();
		expect(page.unroute).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();

		validation.resolve({ url: "https://controller.browser.invalid/", nonce: "nonce-1" });
		expect(await reload).toMatchObject({ ok: true });
		await drain();
		expect(connect).toHaveBeenCalledOnce();
		expect(goto).toHaveBeenCalledOnce();
		expect(page.unroute).toHaveBeenCalledWith("https://controller.browser.invalid/**");
		expect(page.unroute.mock.invocationCallOrder[0]).toBeLessThan(route.mock.invocationCallOrder[0]!);
		expect(browser.close).not.toHaveBeenCalled();
		expect(stored.get("session")).toMatchObject({ control: "ready", command: null, loadGen: 2, pageNonce: `${uuid}-0` });
	});

	it.each([false, true])("restores human input only after a successful reload (failed=%s)", async (failed) => {
		const { attach, drain, post, page, browser, hostCdp, connect, stored, put } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const controlGen = (stored.get("session") as SessionRecord).controlGen;
		const loading = Promise.withResolvers<void>();
		const finishLoad = Promise.withResolvers<void>();
		const uuid = "00000000-0000-0000-0000-000000000001";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => {
			loading.resolve();
			await finishLoad.promise;
			if (failed) throw new Error("Preview request failed");
			return new Response("<html></html>");
		}));
		const goto = vi.fn(async () => {});
		Object.assign(page, {
			route: async () => {},
			goto,
			waitForFunction: async () => {},
			evaluate: async () => ({ url: "https://controller.browser.invalid/", ready: true, error: null, nonce: `${uuid}-0` }),
		});
		const reload = post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<input />",
		});
		await loading.promise;
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 1, ok: false, code: "control" }));
		expect(page.mouse.move).not.toHaveBeenCalled();

		finishLoad.resolve();
		expect(await reload).toMatchObject({ ok: !failed });
		await drain();
		expect(goto).toHaveBeenCalledTimes(failed ? 0 : 1);
		if (failed) {
			expect(connect).toHaveBeenCalledTimes(2);
			expect(hostCdp.send).toHaveBeenCalledWith("Browser.close", {});
			expect(stored.has("session")).toBe(false);
			expect(page.mouse.move).not.toHaveBeenCalled();
			return;
		}
		expect(connect).toHaveBeenCalledOnce();
		expect(browser.close).not.toHaveBeenCalled();
		expect(stored.get("session")).toMatchObject({ control: "human", controlGen, inputHolder: viewer.viewerId, command: null, loadGen: 2 });
		put.mockClear();
		viewer.socket.send(JSON.stringify({ t: "input", controlGen, loadGen: 1, seq: 2, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 2, ok: false, code: "control" }));
		expect(page.mouse.move).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		viewer.socket.send(JSON.stringify({ t: "input", controlGen, loadGen: 2, seq: 3, kind: "mouse.move", x: 10, y: 20 }));
		await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 3, ok: true }));
		expect(page.mouse.move.mock.calls).toEqual([[10, 20]]);
	});

	it.each(["ready", "human"])("closes the %s session when the reloaded controller fails after navigation", async (control) => {
		const { attach, drain, post, page, hostCdp, stored, put } = make_session();
		const viewer = await attach();
		await drain();
		if (control === "human") {
			await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		}
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		const goto = vi.fn(async () => {});
		const waitForFunction = vi.fn(async () => { throw new Error("Controller did not become ready"); });
		Object.assign(page, { route: async () => {}, goto, waitForFunction });
		put.mockClear();

		expect(await post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<input />",
		})).toMatchObject({ ok: false, error: { code: "reload_failed" } });
		await drain();
		expect(goto).toHaveBeenCalledOnce();
		expect(waitForFunction).toHaveBeenCalledOnce();
		expect(goto.mock.invocationCallOrder[0]).toBeLessThan(waitForFunction.mock.invocationCallOrder[0]!);
		expect(hostCdp.send).toHaveBeenCalledWith("Browser.close", {});
		expect(stored.has("session")).toBe(false);
		for (const [, value] of put.mock.calls) {
			const record = value as SessionRecord;
			expect(record.command === null && (record.control === "ready" || record.control === "human")).toBe(false);
		}
	});

	it("keeps a failed reload from restoring a disconnected host session", async () => {
		const { attach, drain, post, browser, connect, stored } = make_session();
		const viewer = await attach();
		await drain();
		await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId });
		const loading = Promise.withResolvers<Response>();
		const fetchPreview = vi.fn(() => loading.promise);
		vi.stubGlobal("fetch", fetchPreview);
		const reloading = post("/reload", {
			sessionId: "session-1", navGen: 1, sourceKind: "saved", sourceVersion: "v2", sourceHash: "h2", html: "<input />",
		});
		await vi.waitFor(() => expect(fetchPreview).toHaveBeenCalledOnce());
		expect(connect).toHaveBeenCalledOnce();

		browser.emit("disconnected");
		loading.reject(new Error("Preview request failed"));
		expect(await reloading).toMatchObject({ ok: false });
		await drain();
		expect(stored.has("session")).toBe(false);
	});

	it("releases a pending human takeover when the finish producer cannot attach", async () => {
		const { attach, drain, post, newCDPSession, stored } = make_session();
		const viewer = await attach();
		await drain();
		expect(await post("/run/begin", {
			sessionId: "session-1", navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1",
		})).toMatchObject({ ok: true });
		expect(await post("/control/take-human", {
			sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId,
		})).toMatchObject({ ok: true, control: "pausing" });
		const record = structuredClone(stored.get("session")) as SessionRecord;
		record.command!.connection = "settled";
		stored.set("session", record);
		newCDPSession.mockRejectedValueOnce(new Error("Producer attach failed"));

		expect(await post("/run/finish", {
			sessionId: "session-1", commandId: "command-1", tainted: false,
			resultBytes: 0, imageCount: 0, imageBytes: 0, viewport: null,
		})).toMatchObject({ ok: true, state: "ready" });
		await drain();
		expect(viewer.socket.closed?.code).toBe(1011);
		expect(stored.get("session")).toMatchObject({ control: "ready", inputHolder: null, command: null, commandCount: 1 });
		expect(Object.keys((stored.get("session") as SessionRecord).viewers)).toHaveLength(0);
	});

	it("ends an expired viewer even when the page sends no frames", async () => {
		const { attach, drain, browser, stored } = make_session();
		const viewer = await attach();
		await drain();
		await vi.advanceTimersByTimeAsync(30_001);
		await drain();
		expect(viewer.socket.closed?.code).toBe(4408);
		expect(stored.get("session")).toMatchObject({ viewers: {}, inputHolder: null });
		expect(browser.close).not.toHaveBeenCalled();
		expect(frames(viewer.socket)).toEqual([]);
	});

	it("keeps a live viewer until the provider total deadline", async () => {
		const { get, page, post, stored, open_socket, drain } = make_session();
		stored.clear();
		const createdAt = Date.now();
		get.mockImplementationOnce(async () => {
			// Loading the empty slot takes time before the provider is acquired.
			vi.setSystemTime(createdAt + 1000);
			return undefined;
		});
		const sessionId = "00000000-0000-0000-0000-000000000009";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(sessionId);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		vi.spyOn(provider, "acquire").mockResolvedValue({ sessionId: "provider-2" } as Awaited<ReturnType<typeof provider.acquire>>);
		Object.assign(page, {
			route: async () => {},
			goto: async () => {},
			waitForFunction: async () => {},
			evaluate: async () => ({ url: "https://controller.browser.invalid/", ready: true, error: null, nonce: `${sessionId}-0` }),
		});
		expect(await post("/open", {
			...OWNERS, grantId: "admission-2", attemptId: "attempt-2", nodeId: "node_2", navGen: 2,
			sourceKind: "saved", sourceVersion: "v1", sourceHash: "hash2", html: "<input />",
			viewport: { width: 1280, height: 900 },
		})).toMatchObject({ ok: true });
		expect(stored.get("session")).toMatchObject({ createdAt, providerAcquiredAt: createdAt + 1000 });

		// Keep open refreshes idle expiry before a fresh viewer attaches near the total cap.
		for (const minutes of [4, 8, 12, 16]) {
			vi.setSystemTime(createdAt + minutes * 60_000);
			expect(await post("/keep-open", { sessionId, navGen: 2 })).toMatchObject({ ok: true });
		}
		vi.setSystemTime(createdAt + 20 * 60_000 - 500);
		expect(await post("/keep-open", { sessionId, navGen: 2 })).toMatchObject({ ok: true });
		const grant = await post("/viewer/grant", { sessionId, navGen: 2 });
		expect(grant).toMatchObject({ ok: true });
		const socket = await open_socket();
		socket.send(JSON.stringify({ ...OWNERS, grantId: grant.grantId, host: "docked" }));
		await vi.waitFor(() => expect(messages(socket).some((message) => message.t === "hello")).toBe(true));
		await drain();
		const hello = messages(socket).find((message) => message.t === "hello");
		expect(await post("/control/take-human", { sessionId, navGen: 2, viewerId: hello?.viewerId })).toMatchObject({ ok: true });
		await vi.advanceTimersByTimeAsync(500);
		await drain();
		expect(await post("/status", { sessionId })).toMatchObject({ ok: true, alive: true });
		expect(socket.closed).toBeNull();
		expect(stored.get("session")).toMatchObject({ control: "human" });

		await vi.advanceTimersByTimeAsync(1000);
		await drain();
		expect(socket.closed?.code).toBe(4408);
		expect(await post("/status", { sessionId })).toMatchObject({ ok: true, alive: false });
	});

	it("keeps a replacement session when old input cleanup times out", async () => {
		const { attach, drain, post, connect, browser, stored } = make_session();
		const connecting = Promise.withResolvers<Awaited<ReturnType<typeof provider.connect>>>();
		connect.mockImplementationOnce(() => connecting.promise);
		const viewer = await attach();
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
		expect(await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId })).toMatchObject({ ok: true });
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.move", x: 10, y: 20 }));
		await vi.advanceTimersByTimeAsync(1);
		expect(await post("/close", { sessionId: "session-1" })).toMatchObject({ ok: true, verified: true });
		expect(stored.has("session")).toBe(false);

		const next = make_provider();
		const uuid = "00000000-0000-0000-0000-000000000009";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		vi.spyOn(provider, "acquire").mockResolvedValue({ sessionId: "provider-2" } as Awaited<ReturnType<typeof provider.acquire>>);
		Object.assign(next.page, {
			route: async () => {},
			goto: async () => {},
			waitForFunction: async () => {},
			evaluate: async () => ({ url: "https://controller.browser.invalid/", ready: true, error: null, nonce: `${uuid}-0` }),
		});
		connect.mockResolvedValue(next.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		const opened = await post("/open", {
			...OWNERS, grantId: "admission-2", attemptId: "attempt-2", nodeId: "node_2", navGen: 2,
			sourceKind: "saved", sourceVersion: "v1", sourceHash: "hash2", html: "<input />",
			viewport: { width: 1280, height: 900 },
		});
		expect(opened).toMatchObject({ ok: true, session: { sessionId: uuid } });
		expect(stored.get("session")).toMatchObject({ sessionId: uuid, control: "ready" });

		// The old viewer is still draining input while the new page is already open.
		await vi.advanceTimersByTimeAsync(5_001);
		const afterOldCleanup = structuredClone(stored.get("session"));
		connecting.resolve(browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		await drain();
		expect(afterOldCleanup).toMatchObject({ sessionId: uuid, control: "ready" });
		expect(next.hostCdp.send.mock.calls.filter(([method]) => method === "Browser.close")).toEqual([]);
	});

	it.each(["pending input", "failed release"])("keeps old cleanup out of a replacement browser (%s)", async (phase) => {
		const { attach, drain, post, page, cdp, connect, stored, emit_frame, open_socket } = make_session();
		const viewer = await attach();
		await drain();
		expect(await post("/control/take-human", { sessionId: "session-1", navGen: 1, viewerId: viewer.viewerId })).toMatchObject({ ok: true });
		const pendingInput = Promise.withResolvers<void>();
		let resuming: Promise<Record<string, unknown>> | null = null;
		if (phase === "pending input") page.mouse.down.mockImplementationOnce(() => pendingInput.promise);
		viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: 1, kind: "mouse.down", button: "left" }));
		await vi.waitFor(() => expect(page.mouse.down).toHaveBeenCalledTimes(1));
		if (phase === "pending input") {
			cdp.send.mockRejectedValueOnce(new Error("Frame ACK failed"));
			emit_frame(1);
		} else {
			await vi.waitFor(() => expect(messages(viewer.socket)).toContainEqual({ t: "input-ack", timings: TIMINGS, seq: 1, ok: true }));
			page.mouse.up.mockImplementationOnce(() => pendingInput.promise);
			resuming = post("/control/to-agent", { sessionId: "session-1", navGen: 1 });
			await vi.waitFor(() => expect(page.mouse.up).toHaveBeenCalledTimes(1));
			expect(await post("/close", { sessionId: "session-1" })).toMatchObject({ ok: true, verified: true });
		}
		await vi.waitFor(() => expect(stored.has("session")).toBe(false));

		const next = make_provider();
		const sessionId = "00000000-0000-0000-0000-000000000009";
		vi.spyOn(crypto, "randomUUID").mockReturnValue(sessionId);
		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>")));
		vi.spyOn(provider, "acquire").mockResolvedValue({ sessionId: "provider-2" } as Awaited<ReturnType<typeof provider.acquire>>);
		Object.assign(next.page, {
			route: async () => {},
			goto: async () => {},
			waitForFunction: async () => {},
			evaluate: async () => ({ url: "https://controller.browser.invalid/", ready: true, error: null, nonce: `${sessionId}-0` }),
		});
		connect.mockResolvedValue(next.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		expect(await post("/open", {
			...OWNERS, grantId: "admission-2", attemptId: "attempt-2", nodeId: "node_2", navGen: 2,
			sourceKind: "saved", sourceVersion: "v1", sourceHash: "hash2", html: "<input />",
			viewport: { width: 1280, height: 900 },
		})).toMatchObject({ ok: true });
		const grant = await post("/viewer/grant", { sessionId, navGen: 2 });
		const replacement = await open_socket();
		replacement.send(JSON.stringify({ ...OWNERS, grantId: grant.grantId, host: "docked" }));
		await vi.waitFor(() => expect(next.cdp.send).toHaveBeenCalledWith("Page.startScreencast", expect.anything()));

		// The old request finishes after the replacement viewer is connected.
		if (phase === "pending input") {
			pendingInput.resolve();
		} else {
			pendingInput.reject(new Error("Old provider closed"));
			expect(await resuming).toMatchObject({ ok: false });
		}
		await drain();
		expect(stored.get("session")).toMatchObject({ sessionId, control: "ready" });
		const hello = messages(replacement).find((message) => message.t === "hello");
		expect(await post("/control/take-human", { sessionId, navGen: 2, viewerId: hello?.viewerId })).toMatchObject({ ok: true });
		expect(next.page.mouse.up).not.toHaveBeenCalled();
		expect(next.page.keyboard.up).not.toHaveBeenCalled();
	});

	it("disposes a late connection after the session closes", async () => {
		const { attach, drain, post, connect, browser, cdp, stored } = make_session();
		const connecting = Promise.withResolvers<Awaited<ReturnType<typeof provider.connect>>>();
		connect.mockImplementationOnce(() => connecting.promise);
		const closingProvider = make_provider();
		connect.mockResolvedValue(closingProvider.browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		const viewer = await attach();
		await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

		expect(await post("/close", { sessionId: "session-1" })).toMatchObject({ ok: true, verified: true });
		expect(viewer.socket.closed?.code).toBe(4404);
		expect(stored.has("session")).toBe(false);
		connecting.resolve(browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
		await drain();
		expect(browser.close).toHaveBeenCalledTimes(1);
		expect(cdp.send).not.toHaveBeenCalled();
		expect(frames(viewer.socket)).toEqual([]);
	});
});
