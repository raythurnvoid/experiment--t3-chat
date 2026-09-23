import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as provider from "@cloudflare/playwright";
import { BrowserSession, LIMITS, type Env } from "./index";

const bridges = vi.hoisted(() => ({ settle: vi.fn() }));
vi.mock("./agent-connection", () => ({
	AgentConnection: class {
		revoke = vi.fn();
		settle = bridges.settle;
		close = vi.fn();
	},
}));

const OWNERS = { ownerId: "user_1", organizationId: "org_1", workspaceId: "ws_1" };
const SESSION = { sessionId: "session-1" };
const NativeResponse = Response;
const MiB = 1_048_576;

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
		if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
	}
}

function messages(socket: Socket) {
	return socket.received.filter((data): data is string => typeof data === "string")
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

type Read = { data: string; base64Encoded: boolean; eof: boolean };

/**
 * A web session with a fake provider. The host CDP session serves page and browser commands. A
 * paused response body comes from `body.reads` (sent as base64), or from `body.read` when a test
 * needs control.
 */
function make_web() {
	const now = Date.now();
	const stored = new Map<string, unknown>([["session", {
		mode: "web", version: 1, ...OWNERS, ...SESSION, grantId: "admission-1", navGen: 1, loadGen: 1, controlGen: 1, control: "ready",
		providerSessionId: "provider-1", pageNonce: "nonce-1", viewport: { width: 1280, height: 900 }, command: null, commandCount: 0,
		createdAt: now, providerAcquiredAt: now, lastActiveAt: now, attemptId: "attempt-1", closeAttempts: 0, inputHolder: null,
		viewers: {}, viewerGrants: {}, agentAccess: true, pageTargetId: "page-1", profileId: "profile_1", agentBlockedHosts: [],
	}]]);
	const body = { reads: [] as string[], read: null as null | (() => Promise<Read>) };
	const frames = { main: "https://example.com/page", child: "https://ads.test/frame" };
	const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
		if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page-1" } };
		if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
		if (method === "Target.getTargets") return { targetInfos: [{ targetId: "page-1", type: "page" }] };
		if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 1, url: frames.main, title: "" }] };
		if (method === "Page.getFrameTree") {
			return { frameTree: { frame: { id: "page-1", url: frames.main }, childFrames: [{ frame: { id: "child", url: frames.child } }] } };
		}
		if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
		if (method === "IO.read") {
			if (body.read) return await body.read();
			// Chrome sends binary stream chunks as base64.
			const data = Buffer.from(body.reads.shift() ?? "").toString("base64");
			return { data, base64Encoded: true, eof: body.reads.length === 0 };
		}
		return {};
	});
	const hostCdp = Object.assign(new EventEmitter(), { send, detach: vi.fn(async () => {}) });
	const viewerCdp = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({})), detach: vi.fn(async () => {}) });
	const context = Object.assign(new EventEmitter(), {
		newCDPSession: vi.fn(async () => viewerCdp).mockResolvedValueOnce(hostCdp),
	});
	const page = Object.assign(new EventEmitter(), {
		setViewportSize: vi.fn(async () => {}),
		unroute: vi.fn(async () => {}),
		evaluate: vi.fn(async () => ({})),
		context: () => context,
		mainFrame: () => ({ url: () => frames.main, parentFrame: () => null }),
		mouse: { move: vi.fn(async () => {}), click: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
		keyboard: { press: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}), type: vi.fn(async () => {}), insertText: vi.fn(async () => {}) },
	});
	Object.assign(context, { pages: () => [page] });
	const browser = Object.assign(new EventEmitter(), {
		contexts: () => [context], newBrowserCDPSession: async () => hostCdp, close: vi.fn(async () => {}),
	});
	vi.spyOn(provider, "connect").mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof provider.connect>>);
	vi.spyOn(provider, "sessions").mockResolvedValue([]);

	const pending = new Set<Promise<unknown>>();
	const namespace = { idFromName: (name: string) => ({ toString: () => name }), get: () => ({ fetch: async () => Response.json({ ok: true }) }) };
	const env: Env = {
		BROWSER: { fetch: vi.fn(async () => new Response(null, { status: 101, webSocket: new WebSocketPair()[0] })) },
		BROWSER_SESSIONS: namespace,
		BROWSER_REGISTRY: namespace,
		BROWSER_RUNNER_SECRET: "test-secret",
		BROWSER_PROFILE_KEY: Buffer.alloc(32, 1).toString("base64"),
		BROWSER_WEB_DENIED_HOSTS: "",
		LOADER: { load: () => { throw new Error("No snippets in download tests"); } },
	};
	const session = new BrowserSession({
		id: { toString: () => "download-test" },
		storage: {
			get: async <T,>(key: string) => structuredClone(stored.get(key)) as T | undefined,
			list: async <T,>(options: { prefix: string }) =>
				new Map([...stored].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, structuredClone(value)])) as Map<string, T>,
			put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
			delete: async (key: string) => stored.delete(key),
			setAlarm: async () => {},
			getAlarm: async () => null,
			deleteAlarm: async () => {},
		},
		waitUntil: (promise) => {
			pending.add(promise);
			void promise.then(() => pending.delete(promise), () => pending.delete(promise));
		},
	}, env);

	const drain = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	const post = async (path: string, value: unknown) => {
		const response = await session.fetch(new Request(`https://object${path}`, { method: "POST", body: JSON.stringify(value) }));
		return await response.json() as Record<string, unknown>;
	};
	const attach = async () => {
		const grant = await post("/viewer/grant", { ...SESSION, navGen: 1 });
		const url = new URL("https://object/viewer/stream");
		for (const [name, value] of Object.entries(OWNERS)) url.searchParams.set(name, value);
		const response = await session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }));
		const socket = (response as SocketResponse).webSocket!;
		socket.send(JSON.stringify({ ...OWNERS, grantId: grant.grantId, host: "docked" }));
		await vi.waitFor(() => expect(messages(socket).some((message) => message.t === "hello")).toBe(true));
		const viewerId = messages(socket).find((message) => message.t === "hello")!.viewerId as string;
		await drain();
		return { socket, viewerId };
	};
	/**
	 * Attach a viewer and take human control (controlGen 2).
	 */
	const human = async () => {
		const viewer = await attach();
		expect(await post("/control/take-human", { ...SESSION, navGen: 1, viewerId: viewer.viewerId })).toMatchObject({ ok: true, controlGen: 2 });
		let seq = 0;
		const input = async (value: Record<string, unknown>) => {
			seq += 1;
			const mine = seq;
			viewer.socket.send(JSON.stringify({ t: "input", controlGen: 2, loadGen: 1, seq: mine, ...value }));
			await vi.waitFor(() => expect(messages(viewer.socket).find((message) => message.t === "input-ack" && message.seq === mine)).toMatchObject({ ok: true }));
		};
		const click = () => input({ kind: "mouse.click", x: 10, y: 10 });
		return { ...viewer, input, click };
	};
	/**
	 * A paused page response, like Chrome sends it at the `Response` stage.
	 */
	const pause = async (requestId: string, headers: Record<string, string>, options: {
		status?: number; frameId?: string; method?: string; url?: string; errorReason?: string;
	} = {}) => {
		hostCdp.emit("Fetch.requestPaused", {
			requestId, frameId: options.frameId ?? "page-1", resourceType: "Document",
			request: { url: options.url ?? "https://files.example/get/report?id=1", method: options.method ?? "GET" },
			...(options.errorReason ? { responseErrorReason: options.errorReason } : { responseStatusCode: options.status ?? 200 }),
			responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
		});
		await drain();
	};
	const answers = (requestId: string) => send.mock.calls.filter(([method, params]) =>
		(method === "Fetch.continueRequest" || method === "Fetch.failRequest") && params?.requestId === requestId);
	const notices = (socket: Socket) => messages(socket).filter((message) => message.t === "notice").map((message) => message.code);
	const downloads = (socket: Socket) => messages(socket).filter((message) => message.t === "download");
	const run_command = async (during: () => Promise<void>) => {
		expect(await post("/run/begin", { ...SESSION, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" })).toMatchObject({ ok: true });
		const url = new URL("https://object/run/stream");
		for (const [name, value] of Object.entries({ ...OWNERS, ...SESSION, commandId: "command-1" })) url.searchParams.set(name, value);
		expect((await session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }))).status).toBe(101);
		await during();
		expect(await post("/run/settle", { ...SESSION, commandId: "command-1" })).toMatchObject({ ok: true });
		return await post("/run/finish", { ...SESSION, commandId: "command-1", tainted: false, resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
	};
	/**
	 * Move time forward. Renew the viewer grant on the way, or the viewer ends after 30 seconds.
	 */
	const wait = async (ms: number, viewerId: string) => {
		for (let left = ms; left > 0; left -= 20_000) {
			await vi.advanceTimersByTimeAsync(Math.min(20_000, left));
			expect(await post("/viewer/renew", { viewerId, ...SESSION })).toMatchObject({ ok: true });
		}
	};
	return { session, stored, body, frames, send, hostCdp, page, browser, drain, post, attach, human, pause, answers, notices, downloads, run_command, wait };
}

/**
 * A Playwright file chooser. `evaluate` runs the page function on a fake input element.
 */
function make_chooser(options: { multiple?: boolean; accept?: string | null; origin?: string } = {}) {
	const node = { ownerDocument: { location: { origin: options.origin ?? "https://example.com" } }, dispatchEvent: vi.fn(() => true) };
	const element = {
		getAttribute: vi.fn(async (name: string) => (name === "accept" ? options.accept ?? null : null)),
		evaluate: vi.fn(async (fn: (value: typeof node) => unknown) => fn(node)),
	};
	return { node, element, chooser: { element: () => element, isMultiple: () => options.multiple ?? false, setFiles: vi.fn(async () => {}) } };
}

const ATTACHMENT = { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"report.pdf\"" };

let fetchMock: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
	vi.stubGlobal("WebSocketPair", SocketPair);
	vi.stubGlobal("Response", SocketResponse);
	fetchMock = vi.fn(async () => new NativeResponse(null, { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	bridges.settle.mockReset().mockResolvedValue({ safe: true, reason: null, blockedPopups: 0 });
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("download capture", () => {
	it("captures an attachment, fails the request, and keeps the page", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["%PDF", "-1.7"];
		await web.pause("r1", { ...ATTACHMENT, "Content-Length": "8" });

		expect(web.send.mock.calls.map(([method]) => method).filter((method) => /^(Fetch|IO)\./u.test(method) && method !== "Fetch.enable")).toEqual([
			"Fetch.takeResponseBodyAsStream", "IO.read", "IO.read", "IO.close", "Fetch.failRequest",
		]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
		expect(web.send.mock.calls.some(([method]) => method === "Page.navigate")).toBe(false);
		const [download] = web.downloads(viewer.socket);
		expect(download).toEqual({ t: "download", downloadId: expect.any(String), name: "report.pdf", size: 8, contentType: "application/pdf" });
		expect(await web.post("/download/info", { ...SESSION, downloadId: download!.downloadId }))
			.toEqual({ ok: true, name: "report.pdf", size: 8, contentType: "application/pdf", origin: "https://files.example" });
	});

	it.each([
		{ name: "an HTML page", headers: { "Content-Type": "text/html; charset=utf-8" }, options: {} },
		{ name: "an inline PDF", headers: { "Content-Type": "application/pdf" }, options: {} },
		{ name: "a response with no type", headers: {}, options: {} },
		{ name: "a redirect", headers: ATTACHMENT, options: { status: 302 } },
		{ name: "a 204", headers: ATTACHMENT, options: { status: 204 } },
		{ name: "a HEAD request", headers: ATTACHMENT, options: { method: "HEAD" } },
		{ name: "a network error", headers: {}, options: { errorReason: "Failed" } },
	])("continues $name", async ({ headers, options }) => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		await web.pause("r1", headers, options);
		expect(web.answers("r1")).toEqual([["Fetch.continueRequest", { requestId: "r1" }]]);
		expect(web.send.mock.calls.some(([method]) => method === "Fetch.takeResponseBodyAsStream")).toBe(false);
	});

	it("decodes base64 chunks and plain text chunks to the same bytes", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		const chunks = [
			{ data: Buffer.from([0xff, 0x00, 0x80]).toString("base64"), base64Encoded: true, eof: false },
			{ data: "ok", base64Encoded: false, eof: true },
		];
		web.body.read = async () => chunks.shift()!;
		await web.pause("r1", ATTACHMENT);
		const [download] = web.downloads(viewer.socket);
		expect(download).toMatchObject({ size: 5 });
		expect(await web.post("/download/push", { ...SESSION, downloadId: download!.downloadId, url: "https://r2.test/a", headers: {} })).toEqual({ ok: true });
		const sent = new Uint8Array(await new NativeResponse(fetchMock.mock.calls[0]![1]!.body).arrayBuffer());
		expect(sent).toEqual(new Uint8Array([0xff, 0x00, 0x80, 0x6f, 0x6b]));
	});

	it("drops a body shorter than its Content-Length, but keeps a compressed one", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		// The server dropped the connection after 4 of 8 bytes. The stream still ends with eof.
		web.body.reads = ["%PDF"];
		await web.pause("r1", { ...ATTACHMENT, "Content-Length": "8" });
		expect(web.notices(viewer.socket)).toEqual(["download_failed"]);
		expect(web.downloads(viewer.socket)).toEqual([]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);

		// Chrome gives the decoded body, so a gzip length is not compared.
		await viewer.click();
		web.body.reads = ["%PDF-1.7"];
		await web.pause("r2", { ...ATTACHMENT, "Content-Length": "5", "Content-Encoding": "gzip" });
		expect(web.downloads(viewer.socket)).toMatchObject([{ size: 8 }]);
	});

	it("tells the viewers when a capture fails", async () => {
		const web = make_web();
		const viewer = await web.human();
		const send = web.send.getMockImplementation()!;
		web.send.mockImplementation(async (method, params) => {
			if (method === "IO.read") throw new Error("Read failed");
			return await send(method, params);
		});
		await viewer.click();
		await web.pause("r1", ATTACHMENT);
		expect(web.notices(viewer.socket)).toEqual(["download_failed"]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
	});

	it("fails a capture after 30 seconds, stops its read, and keeps the capture slot until the read ends", async () => {
		const web = make_web();
		const viewer = await web.human();
		// Each chunk takes 9 seconds, and the body never ends.
		web.body.read = () => new Promise((resolve) => setTimeout(() => resolve({ data: "a", base64Encoded: false, eof: false }), 9_000));
		await viewer.click();
		web.hostCdp.emit("Fetch.requestPaused", {
			requestId: "r1", frameId: "page-1", request: { url: "https://files.example/a", method: "GET" }, responseStatusCode: 200,
			responseHeaders: [{ name: "Content-Disposition", value: "attachment" }, { name: "Content-Type", value: "application/zip" }],
		});
		await web.wait(LIMITS.downloadCaptureMs, viewer.viewerId);
		expect(web.notices(viewer.socket)).toEqual(["download_failed"]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);

		// The 4th chunk is still on the way, so a new capture must wait for it.
		await viewer.click();
		web.hostCdp.emit("Fetch.requestPaused", {
			requestId: "r2", frameId: "page-1", request: { url: "https://files.example/b", method: "GET" }, responseStatusCode: 200,
			responseHeaders: [{ name: "Content-Disposition", value: "attachment" }, { name: "Content-Type", value: "application/zip" }],
		});
		await vi.waitFor(() => expect(web.answers("r2")).toHaveLength(1));
		expect(web.notices(viewer.socket)).toEqual(["download_failed", "download_limit"]);

		// The read stops at that chunk and closes the stream. Then the next capture works.
		await web.wait(9_000, viewer.viewerId);
		expect(web.send.mock.calls.filter(([method]) => method === "IO.read")).toHaveLength(4);
		expect(web.send).toHaveBeenCalledWith("IO.close", { handle: "stream-1" });
		web.body.read = null;
		web.body.reads = ["b"];
		await viewer.click();
		await web.pause("r3", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(1);
	});

	it.each([
		{ type: "text/csv", download: true },
		{ type: "text/calendar", download: true },
		{ type: "image/tiff", download: true },
		{ type: "application/zip", download: true },
		{ type: "text/html", download: false },
		{ type: "text/plain", download: false },
		{ type: "application/json", download: false },
		{ type: "application/xml", download: false },
		{ type: "image/png", download: false },
		{ type: "image/svg+xml", download: false },
		{ type: "image/x-icon", download: false },
		{ type: "audio/mpeg", download: false },
		{ type: "video/mp4", download: false },
	])("treats $type without a disposition as a download: $download", async ({ type, download }) => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r1", { "Content-Type": `${type}; charset=utf-8` });
		expect(web.answers("r1")[0]![0]).toBe(download ? "Fetch.failRequest" : "Fetch.continueRequest");
		expect(web.downloads(viewer.socket)).toHaveLength(download ? 1 : 0);
	});

	it("captures an unknown binary type without a disposition", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["PK"];
		await web.pause("r1", { "Content-Type": "application/zip" }, { url: "https://files.example/dl/archive.zip?x=1" });
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
		expect(web.downloads(viewer.socket)).toMatchObject([{ name: "archive.zip", contentType: "application/zip" }]);
	});

	it("answers every pause once, even when a step throws", async () => {
		const web = make_web();
		const viewer = await web.human();
		const send = web.send.getMockImplementation()!;
		web.send.mockImplementation(async (method, params) => {
			if (method === "Fetch.takeResponseBodyAsStream") throw new Error("Target closed");
			return await send(method, params);
		});
		await viewer.click();
		// The read fails inside the capture.
		await web.pause("r1", ATTACHMENT);
		// No owner: the gesture is used. Its refusal log fails, so the throw reaches the pause handler.
		vi.mocked(console.log).mockImplementationOnce(() => { throw new Error("log failed"); });
		await web.pause("r2", ATTACHMENT);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
		expect(web.answers("r2")).toEqual([["Fetch.failRequest", { requestId: "r2", errorReason: "Aborted" }]]);
	});

	it("drops a download from a page timer and allows one download per gesture", async () => {
		const web = make_web();
		const viewer = await web.human();
		// No click yet: a page timer started it.
		await web.pause("r1", ATTACHMENT);
		expect(web.notices(viewer.socket)).toEqual(["download_blocked"]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
		expect(web.send.mock.calls.some(([method]) => method === "Fetch.takeResponseBodyAsStream")).toBe(false);

		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r2", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(1);
		// Save the first so the one-unclaimed rule does not decide the next one.
		await web.post("/download/push", { ...SESSION, downloadId: web.downloads(viewer.socket)[0]!.downloadId, url: "https://r2.test/a", headers: {} });
		web.body.reads = ["b"];
		await web.pause("r3", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(1);
		expect(web.notices(viewer.socket)).toEqual(["download_blocked", "download_blocked"]);

		// A gesture older than 10 seconds does not count.
		await viewer.click();
		vi.setSystemTime(Date.now() + LIMITS.downloadGestureMs + 1);
		await web.pause("r4", ATTACHMENT);
		expect(web.notices(viewer.socket)).toEqual(["download_blocked", "download_blocked", "download_blocked"]);
	});

	it("never gives a subframe download to the human", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		await web.pause("r1", ATTACHMENT, { frameId: "child" });
		expect(web.notices(viewer.socket)).toEqual(["download_blocked"]);
		expect(web.downloads(viewer.socket)).toEqual([]);
	});

	it("records Enter and the address bar as gestures, but not other keys", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.input({ kind: "key.press", key: "a" });
		await web.pause("r1", ATTACHMENT);
		expect(web.notices(viewer.socket)).toEqual(["download_blocked"]);
		await viewer.input({ kind: "key.down", key: "Enter" });
		web.body.reads = ["a"];
		await web.pause("r2", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(1);
		// Save it, so the one-unclaimed rule does not decide the next one.
		await web.post("/download/push", { ...SESSION, downloadId: web.downloads(viewer.socket)[0]!.downloadId, url: "https://r2.test/a", headers: {} });

		// The address bar Go goes through the `nav` message, not through input.
		viewer.socket.send(JSON.stringify({ t: "nav", seq: 1, controlGen: 2, action: "go", url: "https://files.example/get/report" }));
		await vi.waitFor(() => expect(messages(viewer.socket).find((message) => message.t === "nav-ack" && message.seq === 1)).toMatchObject({ ok: true }));
		expect(web.send).toHaveBeenCalledWith("Page.navigate", { url: "https://files.example/get/report" });
		web.body.reads = ["b"];
		await web.pause("r3", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(2);
	});

	it.each([
		{ name: "filename* before filename", disposition: "attachment; filename=\"plain.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt", url: "https://f.test/x/path.bin", expected: "résumé.txt" },
		{ name: "filename", disposition: "attachment; filename=\"quoted \\\"name\\\".txt\"", url: "https://f.test/x/path.bin", expected: "quoted \"name\".txt" },
		{ name: "the URL path", disposition: "attachment", url: "https://f.test/x/path%20one.bin?q=1", expected: "path one.bin" },
		{ name: "download", disposition: "attachment", url: "https://f.test/", expected: "download" },
		{ name: "a name cut at 255", disposition: `attachment; filename="${"n".repeat(300)}.txt"`, url: "https://f.test/", expected: "n".repeat(255) },
	])("names a download from $name", async ({ disposition, url, expected }) => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r1", { "Content-Type": "application/octet-stream", "Content-Disposition": disposition }, { url });
		expect(web.downloads(viewer.socket)).toMatchObject([{ name: expected }]);
	});
});

describe("download caps", () => {
	it("refuses a file over the human cap from Content-Length without reading it", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		await web.pause("r1", { ...ATTACHMENT, "Content-Length": String(LIMITS.downloadHumanBytes + 1) });
		expect(web.notices(viewer.socket)).toEqual(["download_too_large"]);
		expect(web.send.mock.calls.some(([method]) => method === "Fetch.takeResponseBodyAsStream")).toBe(false);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
	});

	it("stops reading and closes the stream once a body passes the human cap", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		const chunk = "x".repeat(MiB);
		web.body.read = async () => ({ data: chunk, base64Encoded: false, eof: false });
		await web.pause("r1", ATTACHMENT);
		expect(web.send.mock.calls.filter(([method]) => method === "IO.read")).toHaveLength(LIMITS.downloadHumanBytes / MiB + 1);
		expect(web.send).toHaveBeenCalledWith("IO.close", { handle: "stream-1" });
		expect(web.notices(viewer.socket)).toEqual(["download_too_large"]);
		expect(web.downloads(viewer.socket)).toEqual([]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
	});

	it("keeps one unclaimed human download", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r1", ATTACHMENT);
		await viewer.click();
		web.body.reads = ["b"];
		await web.pause("r2", ATTACHMENT);
		expect(web.downloads(viewer.socket)).toHaveLength(1);
		expect(web.notices(viewer.socket)).toEqual(["download_busy"]);
	});

	it("runs one capture at a time", async () => {
		const web = make_web();
		const viewer = await web.human();
		const first = Promise.withResolvers<Read>();
		web.body.read = () => first.promise;
		await viewer.click();
		const paused = web.pause("r1", ATTACHMENT);
		await vi.waitFor(() => expect(web.send).toHaveBeenCalledWith("IO.read", expect.anything()));
		// A second download with its own gesture: the running capture refuses it.
		await viewer.click();
		web.hostCdp.emit("Fetch.requestPaused", {
			requestId: "r2", frameId: "page-1", request: { url: "https://files.example/b", method: "GET" }, responseStatusCode: 200,
			responseHeaders: [{ name: "Content-Disposition", value: "attachment" }, { name: "Content-Type", value: "application/zip" }],
		});
		await vi.waitFor(() => expect(web.answers("r2")).toHaveLength(1));
		expect(web.notices(viewer.socket)).toEqual(["download_limit"]);
		first.resolve({ data: "a", base64Encoded: false, eof: true });
		await paused;
		expect(web.downloads(viewer.socket)).toHaveLength(1);
	});

	it("allows 3 capture starts per 10 seconds", async () => {
		const web = make_web();
		const viewer = await web.attach();
		const finished = await web.run_command(async () => {
			for (const id of ["r1", "r2", "r3", "r4"]) {
				web.body.reads = ["a"];
				await web.pause(id, ATTACHMENT);
			}
			await web.wait(LIMITS.downloadStartWindowMs, viewer.viewerId);
			web.body.reads = ["b"];
			await web.pause("r5", ATTACHMENT);
		});
		expect((finished.downloads as unknown[]).length).toBe(4);
		for (const id of ["r1", "r2", "r3", "r4", "r5"]) expect(web.answers(id)).toEqual([["Fetch.failRequest", { requestId: id, errorReason: "Aborted" }]]);
	});

	it("stops at 20 files per session", async () => {
		const web = make_web();
		const viewer = await web.attach();
		await web.run_command(async () => {
			for (let index = 0; index < LIMITS.downloadSessionFiles + 1; index += 1) {
				if (index % LIMITS.downloadStarts === 0) await web.wait(LIMITS.downloadStartWindowMs, viewer.viewerId);
				web.body.reads = ["a"];
				await web.pause(`r${index}`, ATTACHMENT);
			}
		});
		// 8 files fit in the command result. The other 12 are dropped from it, and the 21st never starts.
		const codes = web.notices(viewer.socket);
		expect(codes.filter((code) => code === "download_limit")).toHaveLength(13);
		expect(web.send.mock.calls.filter(([method]) => method === "Fetch.takeResponseBodyAsStream")).toHaveLength(20);
	});

	it("stops at 100 MiB per session", async () => {
		const web = make_web();
		const viewer = await web.human();
		const chunk = "x".repeat(MiB);
		for (let index = 0; index < 4; index += 1) {
			await web.wait(LIMITS.downloadStartWindowMs, viewer.viewerId);
			await viewer.click();
			// Plain text chunks: base64 for 100 MiB would make this test slow.
			let left = 25;
			web.body.read = async () => {
				left -= 1;
				return { data: chunk, base64Encoded: false, eof: left === 0 };
			};
			await web.pause(`r${index}`, ATTACHMENT);
			const last = web.downloads(viewer.socket).at(-1)!;
			expect(last.size).toBe(25 * MiB);
			expect(await web.post("/download/push", { ...SESSION, downloadId: last.downloadId, url: "https://r2.test/a", headers: {} })).toEqual({ ok: true });
		}
		await web.wait(LIMITS.downloadStartWindowMs, viewer.viewerId);
		await viewer.click();
		web.body.read = null;
		web.body.reads = ["a"];
		await web.pause("r5", ATTACHMENT);
		expect(web.notices(viewer.socket)).toEqual(["download_limit"]);
	});
});

describe("agent downloads", () => {
	it("returns the command's downloads and drops what passes 8 files", async () => {
		const web = make_web();
		const viewer = await web.attach();
		const finished = await web.run_command(async () => {
			for (let index = 0; index < LIMITS.files + 1; index += 1) {
				if (index % LIMITS.downloadStarts === 0) await web.wait(LIMITS.downloadStartWindowMs, viewer.viewerId);
				web.body.reads = [`file-${index}`];
				await web.pause(`r${index}`, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="f${index}.csv"` });
			}
		});
		expect(finished).toMatchObject({ ok: true, state: "ready", downloadsDropped: 1 });
		const downloads = finished.downloads as Array<{ name: string; contentType: string; dataBase64: string }>;
		expect(downloads).toHaveLength(LIMITS.files);
		expect(downloads[0]).toEqual({ name: "f0.csv", contentType: "text/csv", dataBase64: Buffer.from("file-0").toString("base64") });
	});

	it("drops a download that would pass 8 MiB for the command", async () => {
		const web = make_web();
		await web.attach();
		const chunk = "x".repeat(MiB);
		const finished = await web.run_command(async () => {
			web.body.reads = Array.from({ length: 8 }, () => chunk);
			await web.pause("r1", ATTACHMENT);
			web.body.reads = ["a"];
			await web.pause("r2", ATTACHMENT);
		});
		expect((finished.downloads as unknown[]).length).toBe(1);
		expect(finished.downloadsDropped).toBe(1);
	});

	it("counts refused and failed downloads in downloadsDropped", async () => {
		const web = make_web();
		await web.attach();
		const finished = await web.run_command(async () => {
			// Over the agent file cap before reading.
			await web.pause("r1", { ...ATTACHMENT, "Content-Length": String(LIMITS.downloadAgentBytes + 1) });
			// A cut-off body.
			web.body.reads = ["ab"];
			await web.pause("r2", { ...ATTACHMENT, "Content-Length": "4" });
			// A cross-origin link from the safety net.
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g1", url: "https://other.test/file.bin", suggestedFilename: "file.bin" });
			await web.drain();
		});
		expect(finished).toMatchObject({ ok: true, downloadsDropped: 3 });
		expect(finished.downloads).toBeUndefined();
	});

	it("gives a download from the command's last step to the command, even when the command ends first", async () => {
		const web = make_web();
		await web.attach();
		const frameTree = Promise.withResolvers<Record<string, unknown>>();
		const send = web.send.getMockImplementation()!;
		web.send.mockImplementation(async (method, params) => {
			if (method === "Page.getFrameTree") return await frameTree.promise;
			if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
			if (method === "Runtime.evaluate") return { result: { objectId: "file-1" } };
			if (method === "Runtime.callFunctionOn") {
				return params?.arguments ? { result: { value: "YWJj" } } : { result: { value: { over: false, size: 3, type: "text/csv" } } };
			}
			return await send(method, params);
		});
		expect(await web.post("/run/begin", { ...SESSION, navGen: 1, loadGen: 1, controlGen: 1, commandId: "command-1" })).toMatchObject({ ok: true });
		const url = new URL("https://object/run/stream");
		for (const [name, value] of Object.entries({ ...OWNERS, ...SESSION, commandId: "command-1" })) url.searchParams.set(name, value);
		expect((await web.session.fetch(new Request(url, { headers: { Upgrade: "websocket" } }))).status).toBe(101);

		// The last step clicks a same-origin `<a download>`. The frame check is slow.
		web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g1", url: "https://example.com/export.csv", suggestedFilename: "export.csv" });
		expect(await web.post("/run/settle", { ...SESSION, commandId: "command-1" })).toMatchObject({ ok: true });
		const finishing = web.post("/run/finish", { ...SESSION, commandId: "command-1", tainted: false, resultBytes: 0, fileCount: 0, fileBytes: 0, viewport: null });
		// The command has ended before the frame check answers.
		await vi.waitFor(() => expect(web.stored.get("session")).toMatchObject({ command: null }));
		frameTree.resolve({ frameTree: { frame: { id: "page-1", url: "https://example.com/page" } } });
		const finished = await finishing;
		expect(finished.downloads).toEqual([{ name: "export.csv", contentType: "text/csv", dataBase64: "YWJj" }]);
	});

	it("reads a data: URL download from the safety net, up to the file cap", async () => {
		const web = make_web();
		const viewer = await web.attach();
		const finished = await web.run_command(async () => {
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g1", url: "data:text/plain;base64,aGk=", suggestedFilename: "hi.txt" });
			await web.drain();
			// The URL length is capped at the file cap, before decoding.
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g2", url: `data:,${"a".repeat(LIMITS.downloadAgentBytes)}`, suggestedFilename: "big.txt" });
			await web.drain();
		});
		expect(finished.downloads).toEqual([{ name: "hi.txt", contentType: "text/plain", dataBase64: "aGk=" }]);
		expect(web.notices(viewer.socket)).toEqual(["download_too_large"]);
	});

	it("reads a same-origin download again in an isolated world", async () => {
		const web = make_web();
		await web.attach();
		const send = web.send.getMockImplementation()!;
		web.send.mockImplementation(async (method, params) => {
			if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
			if (method === "Runtime.evaluate") return { result: { objectId: "file-1" } };
			if (method === "Runtime.callFunctionOn") {
				return params?.arguments ? { result: { value: "YWJj" } } : { result: { value: { over: false, size: 3, type: "text/csv; charset=utf-8" } } };
			}
			return await send(method, params);
		});
		const finished = await web.run_command(async () => {
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g1", url: "https://example.com/export.csv", suggestedFilename: "export.csv" });
			await web.drain();
		});
		expect(web.send).toHaveBeenCalledWith("Page.createIsolatedWorld", { frameId: "page-1", worldName: "bonobo-download", grantUniveralAccess: false });
		expect(web.send).toHaveBeenCalledWith("Runtime.releaseObject", { objectId: "file-1" });
		expect(finished.downloads).toEqual([{ name: "export.csv", contentType: "text/csv", dataBase64: "YWJj" }]);
	});

	it("does not read a cross-origin or blob download from the safety net", async () => {
		const web = make_web();
		const viewer = await web.attach();
		await web.run_command(async () => {
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g1", url: "https://other.test/file.bin", suggestedFilename: "file.bin" });
			web.hostCdp.emit("Browser.downloadWillBegin", { frameId: "page-1", guid: "g2", url: "blob:https://example.com/1", suggestedFilename: "b.bin" });
			await web.drain();
		});
		expect(web.notices(viewer.socket)).toEqual(["download_unsupported", "download_unsupported"]);
		expect(web.send.mock.calls.some(([method]) => method === "Page.createIsolatedWorld")).toBe(false);
	});

	it("keeps the agent blocked-sites filter working next to the download pattern", async () => {
		const web = make_web();
		web.stored.set("session", { ...web.stored.get("session") as object, agentBlockedHosts: ["bank.test"] });
		await web.attach();
		await web.run_command(async () => {
			const enabled = web.send.mock.calls.filter(([method]) => method === "Fetch.enable").at(-1);
			expect(enabled?.[1]).toEqual({ patterns: [
				{ urlPattern: "*", resourceType: "Document", requestStage: "Response" },
				{ urlPattern: "*", resourceType: "Document", requestStage: "Request" },
				{ urlPattern: "*", resourceType: "XHR", requestStage: "Request" },
				{ urlPattern: "*", resourceType: "Fetch", requestStage: "Request" },
			] });
			web.hostCdp.emit("Fetch.requestPaused", { requestId: "q1", request: { url: "https://api.bank.test/x", method: "GET" }, resourceType: "XHR" });
			web.hostCdp.emit("Fetch.requestPaused", { requestId: "q2", request: { url: "https://example.com/x", method: "GET" }, resourceType: "Fetch" });
			web.body.reads = ["a"];
			await web.pause("r1", ATTACHMENT);
		});
		expect(web.answers("q1")).toEqual([["Fetch.failRequest", { requestId: "q1", errorReason: "BlockedByClient" }]]);
		expect(web.answers("q2")).toEqual([["Fetch.continueRequest", { requestId: "q2" }]]);
		expect(web.answers("r1")).toEqual([["Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" }]]);
	});
});

describe("download routes", () => {
	const held = async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["data"];
		await web.pause("r1", ATTACHMENT);
		const downloadId = web.downloads(viewer.socket)[0]!.downloadId as string;
		return { web, viewer, downloadId };
	};

	it("pushes once with If-None-Match, then answers ok again without a second PUT", async () => {
		const { web, downloadId } = await held();
		const push = { ...SESSION, downloadId, url: "https://r2.test/put?sig=1", headers: { "Content-Type": "application/pdf" } };
		expect(await web.post("/download/push", push)).toEqual({ ok: true });
		expect(await web.post("/download/push", push)).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://r2.test/put?sig=1");
		expect(init?.method).toBe("PUT");
		expect(new Headers(init?.headers).get("If-None-Match")).toBe("*");
		expect(new Headers(init?.headers).get("Content-Type")).toBe("application/pdf");
		expect(await web.post("/download/info", { ...SESSION, downloadId })).toMatchObject({ ok: false, error: { code: "download_gone" } });
	});

	it("refuses an unknown id", async () => {
		const { web } = await held();
		expect(await web.post("/download/info", { ...SESSION, downloadId: "unknown" })).toMatchObject({ ok: false, error: { code: "download_gone" } });
		expect(await web.post("/download/push", { ...SESSION, downloadId: "unknown", url: "https://r2.test/a", headers: {} }))
			.toMatchObject({ ok: false, error: { code: "download_gone" } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("counts a 412 as saved", async () => {
		const { web, downloadId } = await held();
		fetchMock.mockResolvedValueOnce(new NativeResponse(null, { status: 412 }));
		expect(await web.post("/download/push", { ...SESSION, downloadId, url: "https://r2.test/a", headers: {} })).toEqual({ ok: true });
	});

	it("keeps the bytes after a failed push so a retry works", async () => {
		const { web, downloadId } = await held();
		fetchMock.mockResolvedValueOnce(new NativeResponse(null, { status: 500 }));
		expect(await web.post("/download/push", { ...SESSION, downloadId, url: "https://r2.test/a", headers: {} }))
			.toMatchObject({ ok: false, error: { code: "download_push_failed" } });
		expect(await web.post("/download/info", { ...SESSION, downloadId })).toMatchObject({ ok: true, size: 4 });
		expect(await web.post("/download/push", { ...SESSION, downloadId, url: "https://r2.test/a", headers: {} })).toEqual({ ok: true });
		expect(new Uint8Array(await new NativeResponse(fetchMock.mock.calls[1]![1]!.body).arrayBuffer())).toEqual(new TextEncoder().encode("data"));
	});

	it("drops an unclaimed download after 2 minutes", async () => {
		const { web, viewer, downloadId } = await held();
		await web.wait(LIMITS.downloadKeepMs, viewer.viewerId);
		expect(web.notices(viewer.socket)).toEqual(["download_lost"]);
		expect(await web.post("/download/info", { ...SESSION, downloadId })).toMatchObject({ ok: false, error: { code: "download_gone" } });
	});

	it.each([
		{ name: "saves", status: 200, reply: { ok: true }, notices: [] },
		{ name: "fails", status: 500, reply: { ok: false, error: { code: "download_push_failed" } }, notices: ["download_lost"] },
	])("waits for a push that runs past the 2 minutes, and reports lost only when it $name", async ({ status, reply, notices }) => {
		const { web, viewer, downloadId } = await held();
		await web.wait(LIMITS.downloadKeepMs - 10_000, viewer.viewerId);
		const put = Promise.withResolvers<Response>();
		fetchMock.mockImplementationOnce(() => put.promise);
		const pushing = web.post("/download/push", { ...SESSION, downloadId, url: "https://r2.test/a", headers: {} });
		// The 2 minutes end while the PUT runs.
		await web.wait(20_000, viewer.viewerId);
		expect(web.notices(viewer.socket)).toEqual([]);
		put.resolve(new NativeResponse(null, { status }));
		expect(await pushing).toMatchObject(reply);
		await web.drain();
		expect(web.notices(viewer.socket)).toEqual(notices);
	});

	it("drops an unclaimed download at close", async () => {
		const { web, viewer, downloadId } = await held();
		await web.post("/close", SESSION);
		expect(web.notices(viewer.socket)).toEqual(["download_lost"]);
		expect(await web.post("/download/info", { ...SESSION, downloadId })).toMatchObject({ ok: false, error: { code: "download_gone" } });
	});
});

describe("file choosers", () => {
	const upload_url = (grantId: string, name = "notes.txt") => {
		const url = new URL("https://object/viewer/upload");
		for (const [key, value] of Object.entries({ ...OWNERS, grantId, name })) url.searchParams.set(key, value);
		return url;
	};
	const put = async (web: ReturnType<typeof make_web>, grantId: string, body: BodyInit) => {
		// `duplex` lets a stream body through, like a browser upload.
		const init = { method: "PUT", body, headers: { "Content-Type": "text/plain" }, duplex: "half" } as RequestInit;
		const response = await web.session.fetch(new Request(upload_url(grantId), init));
		return { status: response.status, body: await response.json() as Record<string, unknown> };
	};
	const open = async (options: Parameters<typeof make_chooser>[0] = {}) => {
		const web = make_web();
		const viewer = await web.human();
		const chooser = make_chooser(options);
		web.page.emit("filechooser", chooser.chooser);
		await web.drain();
		const opened = messages(viewer.socket).find((message) => message.t === "file-chooser");
		return { web, viewer, chooser, chooserId: opened?.chooserId as string, opened };
	};
	const fill = (web: ReturnType<typeof make_web>, chooserId: string, files: unknown[], controlGen = 2) =>
		web.post("/upload/fill", { ...SESSION, chooserId, controlGen, files });
	const ONE = [{ name: "a.txt", contentType: "text/plain", url: "https://r2.test/a" }];

	it("opens a chooser only in human control", async () => {
		const web = make_web();
		const viewer = await web.attach();
		web.page.emit("filechooser", make_chooser().chooser);
		await web.drain();
		expect(messages(viewer.socket).some((message) => message.t === "file-chooser")).toBe(false);

		const { opened } = await open({ multiple: true, accept: "image/*,.pdf" });
		expect(opened).toEqual({ t: "file-chooser", chooserId: expect.any(String), multiple: true, accept: "image/*,.pdf", origin: "https://example.com" });
	});

	it("fills the chooser once from signed URLs", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		fetchMock.mockResolvedValue(new NativeResponse("hello"));
		expect(await fill(web, chooserId, ONE)).toEqual({ ok: true });
		expect(chooser.chooser.setFiles).toHaveBeenCalledWith([{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
		expect(messages(viewer.socket)).toContainEqual({ t: "file-chooser-closed", chooserId });
		expect(await fill(web, chooserId, ONE)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		expect(chooser.chooser.setFiles).toHaveBeenCalledOnce();
	});

	it("gives a single chooser exactly one file", async () => {
		const { web, chooser, chooserId } = await open({ multiple: false });
		expect(await fill(web, chooserId, [...ONE, ...ONE])).toMatchObject({ ok: false, error: { code: "too_many_files" } });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("refuses a fill after a main-frame navigation", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		web.hostCdp.emit("Page.frameNavigated", { frame: { id: "page-1", url: "https://example.com/next" } });
		await web.drain();
		expect(messages(viewer.socket)).toContainEqual({ t: "file-chooser-closed", chooserId });
		expect(await fill(web, chooserId, ONE)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("refuses a fill after a controlGen change", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		expect(await fill(web, chooserId, ONE, 1)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		await web.post("/control/to-agent", { ...SESSION, navGen: 1 });
		await web.post("/control/take-human", { ...SESSION, navGen: 1, viewerId: viewer.viewerId });
		expect(await fill(web, chooserId, ONE, 4)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("refuses a fill when the frame origin changed while the files were read", async () => {
		const { web, chooser, chooserId } = await open();
		fetchMock.mockImplementation(async () => {
			chooser.node.ownerDocument.location.origin = "https://evil.test";
			return new NativeResponse("hello");
		});
		expect(await fill(web, chooserId, ONE)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("refuses a fill when the chooser closed while its origin was read", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		fetchMock.mockResolvedValue(new NativeResponse("hello"));
		// The page navigates while the origin check runs. The origin itself did not change.
		chooser.element.evaluate.mockImplementationOnce(async (fn) => {
			web.hostCdp.emit("Page.frameNavigated", { frame: { id: "page-1", url: "https://example.com/next" } });
			return fn(chooser.node);
		});
		expect(await fill(web, chooserId, ONE)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
		expect(messages(viewer.socket)).toContainEqual({ t: "file-chooser-closed", chooserId });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("reads the files of one fill at the same time, under one shared 20 MiB cap", async () => {
		const { web, chooser, chooserId } = await open({ multiple: true });
		const bodies = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
		fetchMock.mockImplementationOnce(() => bodies[0]!.promise).mockImplementationOnce(() => bodies[1]!.promise);
		const two = [ONE[0]!, { name: "b.txt", contentType: "text/plain", url: "https://r2.test/b" }];
		const filling = fill(web, chooserId, two);
		// Both fetches start before either answers.
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		bodies[1]!.resolve(new NativeResponse("world"));
		bodies[0]!.resolve(new NativeResponse("hello"));
		expect(await filling).toEqual({ ok: true });
		expect(chooser.chooser.setFiles).toHaveBeenCalledWith([
			{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
			{ name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("world") },
		]);

		// Each file is under 20 MiB, but not both together.
		const next = await open({ multiple: true });
		fetchMock.mockImplementation(async () => new NativeResponse(new Uint8Array(LIMITS.uploadBytes / 2 + 1)));
		expect(await fill(next.web, next.chooserId, two)).toMatchObject({ ok: false, error: { code: "too_large" } });
		expect(next.chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("stops a fill whose reads pass the fill budget", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		// The signed URL never answers until the fill gives up.
		fetchMock.mockImplementation((_url, init) => new Promise((_, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		}));
		let reply: Record<string, unknown> | null = null;
		const filling = fill(web, chooserId, ONE).then((value) => { reply = value; });
		await web.wait(LIMITS.uploadFillMs - LIMITS.uploadSetFilesMs - 5_000, viewer.viewerId);
		await vi.waitFor(() => expect(reply).toMatchObject({ ok: false, error: { code: "fetch_failed" } }));
		await filling;
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("answers a broken or slow computer upload with a code and stops reading it", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		// The connection breaks in the middle of the body.
		const broken = new ReadableStream({ start(controller) {
			controller.enqueue(new Uint8Array([1]));
			controller.error(new Error("reset"));
		} });
		const first = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		expect(await put(web, first.grantId as string, broken)).toEqual({ status: 400, body: { ok: false, code: "upload_failed" } });

		// The body never ends.
		let cancelled = false;
		const slow = new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } });
		const second = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		const replied = put(web, second.grantId as string, slow);
		await web.wait(60_000, viewer.viewerId);
		expect(await replied).toEqual({ status: 400, body: { ok: false, code: "upload_failed" } });
		expect(cancelled).toBe(true);
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
		// Each grant works once, even after a failure.
		expect(await put(web, second.grantId as string, "hello")).toEqual({ status: 403, body: { ok: false, code: "grant_invalid" } });
	});

	it("refuses a fill over 20 MiB and a failed fetch", async () => {
		const first = await open({ multiple: true });
		fetchMock.mockResolvedValue(new NativeResponse(new Uint8Array(LIMITS.uploadBytes + 1)));
		expect(await fill(first.web, first.chooserId, ONE)).toMatchObject({ ok: false, error: { code: "too_large" } });
		const second = await open();
		fetchMock.mockResolvedValue(new NativeResponse(null, { status: 403 }));
		expect(await fill(second.web, second.chooserId, ONE)).toMatchObject({ ok: false, error: { code: "fetch_failed" } });
	});

	it("uses a grant once for a computer upload, even when the first try fails", async () => {
		const { web, chooser, chooserId } = await open();
		const granted = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		expect(granted).toEqual({ ok: true, grantId: expect.any(String), expiresAt: Date.now() + LIMITS.uploadGrantMs });
		// A failed try keeps the chooser open, so only the used grant can refuse the retry.
		expect(await put(web, granted.grantId as string, new Uint8Array(LIMITS.uploadBytes + 1))).toMatchObject({ status: 413 });
		expect(await put(web, granted.grantId as string, "hello")).toEqual({ status: 403, body: { ok: false, code: "grant_invalid" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();

		const again = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		expect(await put(web, again.grantId as string, "hello")).toEqual({ status: 200, body: { ok: true } });
		expect(chooser.chooser.setFiles).toHaveBeenCalledWith([{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
	});

	it("refuses an expired grant", async () => {
		const { web, chooser, chooserId } = await open();
		const granted = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		vi.setSystemTime(Date.now() + LIMITS.uploadGrantMs);
		expect(await put(web, granted.grantId as string, "hello")).toEqual({ status: 403, body: { ok: false, code: "grant_invalid" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("refuses a computer upload over 20 MiB", async () => {
		const { web, chooser, chooserId } = await open();
		const granted = await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 });
		expect(await put(web, granted.grantId as string, new Uint8Array(LIMITS.uploadBytes + 1))).toEqual({ status: 413, body: { ok: false, code: "too_large" } });
		expect(chooser.chooser.setFiles).not.toHaveBeenCalled();
	});

	it("cancels the chooser from the viewer", async () => {
		const { web, viewer, chooser, chooserId } = await open();
		viewer.socket.send(JSON.stringify({ t: "file-chooser-cancel", chooserId }));
		await web.drain();
		expect(chooser.node.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel" }));
		expect(messages(viewer.socket)).toContainEqual({ t: "file-chooser-closed", chooserId });
		expect(await fill(web, chooserId, ONE)).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
	});

	it("closes the chooser after 5 minutes", async () => {
		const { web, viewer, chooserId } = await open();
		await web.wait(LIMITS.chooserMs, viewer.viewerId);
		expect(messages(viewer.socket)).toContainEqual({ t: "file-chooser-closed", chooserId });
		expect(await web.post("/upload/grant", { ...SESSION, chooserId, controlGen: 2 })).toMatchObject({ ok: false, error: { code: "chooser_gone" } });
	});
});

describe("viewer reconnect", () => {
	it("sends the waiting download and the open chooser again to a viewer that attaches", async () => {
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r1", ATTACHMENT);
		const [download] = web.downloads(viewer.socket);
		web.page.emit("filechooser", make_chooser().chooser);
		await web.drain();
		const opened = messages(viewer.socket).find((message) => message.t === "file-chooser");
		expect(opened).toBeDefined();

		const again = await web.attach();
		expect(web.downloads(again.socket)).toEqual([download]);
		expect(messages(again.socket).filter((message) => message.t === "file-chooser")).toEqual([opened]);

		// A saved download is not sent again. Close the second viewer first: a session has 2 at most.
		expect(await web.post("/download/push", { ...SESSION, downloadId: download!.downloadId, url: "https://r2.test/a", headers: {} })).toEqual({ ok: true });
		again.socket.close();
		await vi.waitFor(() => expect(Object.keys((web.stored.get("session") as { viewers: object }).viewers)).toHaveLength(1));
		const later = await web.attach();
		expect(web.downloads(later.socket)).toEqual([]);
	});
});

describe("download and upload logs", () => {
	it("never logs names, URLs, or hosts", async () => {
		const log = vi.mocked(console.log);
		const web = make_web();
		const viewer = await web.human();
		await viewer.click();
		web.body.reads = ["a"];
		await web.pause("r1", { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=\"secretname.zip\"" }, { url: "https://privatesite.test/x" });
		const downloadId = web.downloads(viewer.socket)[0]!.downloadId;
		await web.post("/download/push", { ...SESSION, downloadId, url: "https://r2.test/privatekey", headers: {} });
		const lines = log.mock.calls.map((call) => call.map(String).join(" "));
		expect(lines.some((line) => line.includes("download"))).toBe(true);
		for (const line of lines) expect(line).not.toMatch(/secretname|privatesite|privatekey|r2\.test/u);
	});
});
