import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnection } from "./agent-connection";

class Socket extends EventTarget {
	peer: Socket | null = null;
	readyState = 1;
	received: string[] = [];

	send(data: string) {
		if (this.readyState !== 1 || !this.peer) throw new Error("Socket closed");
		this.peer.received.push(data);
		this.peer.dispatchEvent(new MessageEvent("message", { data }));
	}

	close() {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		if (this.peer) {
			this.peer.readyState = 3;
			this.peer.dispatchEvent(new Event("close"));
		}
		this.dispatchEvent(new Event("close"));
	}
}

function socket_pair() {
	const first = new Socket();
	const second = new Socket();
	first.peer = second;
	second.peer = first;
	return [first, second] as const;
}

function messages(socket: Socket) {
	return socket.received.map((value) => JSON.parse(value) as Record<string, unknown>);
}

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xf6sAAAAASUVORK5CYII=";

function png_with_dimensions(width: number, height: number) {
	// Header-only edits exercise the size guard, not a full image decoder.
	const bytes = Buffer.from(PNG_DATA, "base64");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes.toString("base64");
}

function make_connection(options: {
	autoReply?: boolean;
	onPopup?: (targetId: string) => Promise<void>;
	cleanupError?: boolean;
	mode?: "file" | "web";
	agentBlockedHosts?: string[];
} = {}) {
	const [upstream, provider] = socket_pair();
	const [downstream, child] = socket_pair();
	const onUnsafe = vi.fn();
	const onPopup = vi.fn(options.onPopup ?? (async () => {}));
	const bridge = new AgentConnection({
		upstream: upstream as unknown as WebSocket,
		downstream: downstream as unknown as WebSocket,
		targetId: "assigned-page",
		mode: options.mode ?? "file",
		deniedHosts: ["blocked.test"],
		agentBlockedHosts: options.agentBlockedHosts ?? [],
		deadline: Date.now() + 30_000,
		onUnsafe,
		onPopup,
	});
	const emit = (method: string, params: unknown, sessionId: string | null = "page-session") =>
		provider.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
	const reply = (request: Record<string, unknown>, result: unknown = {}) =>
		provider.send(JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }));
	if (options.autoReply !== false) provider.addEventListener("message", (event) => {
		const request = JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>;
		if (options.cleanupError && Number(request.id) < 0) {
			provider.send(JSON.stringify({ id: request.id, sessionId: request.sessionId, error: { code: -32000, message: "Cleanup failed" } }));
			return;
		}
		const result = request.method === "Page.getFrameTree" ? {
			frameTree: { frame: { id: "main-frame" }, childFrames: [{ frame: { id: "inner-frame" } }] },
		} : request.method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `script-${request.id}` } :
			request.method === "Browser.getWindowForTarget" ? { windowId: 7 } :
			request.method === "Page.captureScreenshot" ? { data: PNG_DATA } :
			request.method === "Page.createIsolatedWorld" ? { executionContextId: 9 } :
			request.method === "Page.getNavigationHistory" ? { currentIndex: 1, entries: [
				{ id: 3, url: "https://example.com/", title: "" }, { id: 4, url: "https://bank.test/account", title: "" },
			] } : {};
		reply(request, result);
	});
	emit("Target.attachedToTarget", { sessionId: "page-session", targetInfo: { targetId: "assigned-page", type: "page" } }, null);
	emit("Runtime.executionContextCreated", { context: { id: 1 } });
	let id = 0;
	const send = (method: string, params: unknown = {}, sessionId: string | null = "page-session") => {
		const request = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
		child.send(JSON.stringify(request));
		return request;
	};
	return { bridge, upstream, downstream, provider, child, onUnsafe, onPopup, send, emit, reply };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("AgentConnection", () => {
	it("keeps startup requests on the assigned page and denies downloads", async () => {
		const { bridge, send, provider, child } = make_connection();
		send("Browser.getVersion", {}, null);
		send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, null);
		send("Target.getTargetInfo", {}, null);
		send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/child/path", eventsEnabled: true }, null);
		expect(messages(provider).at(-1)?.params).toEqual({ behavior: "deny", eventsEnabled: false });
		expect(messages(provider).at(-2)?.params).toEqual({ targetId: "assigned-page" });
		expect(messages(child).filter((message) => message.error)).toEqual([]);
		expect(await bridge.settle(1000)).toEqual({ safe: true, reason: null, blockedPopups: 0 });
	});

	it("supports page setup, locators, screenshots, and context tracing", async () => {
		const { bridge, send, provider, child } = make_connection();
		send("Page.getFrameTree");
		send("Page.createIsolatedWorld", { frameId: "inner-frame", worldName: "utility", grantUniveralAccess: true });
		send("Runtime.evaluate", { expression: "document.body", contextId: 9 });
		send("Runtime.callFunctionOn", { functionDeclaration: "function () { return 1; }", objectId: "object-1", arguments: [{ value: "hello" }], awaitPromise: true, returnByValue: true, userGesture: true });
		send("DOM.describeNode", { objectId: "object-1" });
		send("DOM.resolveNode", { backendNodeId: 1, executionContextId: 9 });
		send("DOM.scrollIntoViewIfNeeded", { objectId: "object-1" });
		send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 }, captureBeyondViewport: true });
		send("Page.addScriptToEvaluateOnNewDocument", { source: "window.traceReady = true", runImmediately: true });
		send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 800, maxHeight: 600 });
		expect(messages(child).filter((message) => message.error)).toEqual([]);
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(messages(provider).filter((message) => Number(message.id) < 0).map((message) => message.method))
			.toEqual(["Page.removeScriptToEvaluateOnNewDocument", "Page.stopScreencast"]);
	});

	it.each([
		"Cloudflare.getLiveView", "Cloudflare.getSessionId", "Cloudflare.handoff", "Browser.close",
		"Target.attachToBrowserTarget", "Target.attachToTarget", "Target.createTarget", "Target.createBrowserContext",
		"Target.sendMessageToTarget", "Target.exposeDevToolsProtocol", "Target.setRemoteLocations",
		"DOM.setFileInputFiles", "Network.loadNetworkResource", "IO.read", "Tracing.start",
	])("refuses %s before forwarding", async (method) => {
		const { bridge, send, provider, child, onUnsafe } = make_connection();
		send(method);
		expect(messages(provider)).toEqual([]);
		expect(messages(child).at(-1)?.error).toEqual({ code: -32601, message: `Browser command is not allowed: ${method}.` });
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it.each([
		["Page.createIsolatedWorld", { frameId: "other-frame", worldName: "utility" }],
		["Runtime.evaluate", { expression: "1", contextId: 99 }],
		["Browser.getWindowForTarget", { targetId: "other-page" }],
		["Browser.setWindowBounds", { windowId: 99, bounds: { width: 800, height: 600 } }],
		["Page.removeScriptToEvaluateOnNewDocument", { identifier: "host-script" }],
		["Page.screencastFrameAck", { sessionId: 99 }],
		["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false }],
		["Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 8192, height: 8192, scale: 1 } }],
		["Runtime.evaluate", { expression: "1", contextId: 1, includeCommandLineAPI: true }],
		["Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data: { items: [], files: ["/provider/file"], dragOperationsMask: 1 } }],
	])("checks parameters for %s", async (method, params) => {
		const { bridge, send, provider, child } = make_connection();
		send(method, params);
		expect(messages(provider)).toEqual([]);
		expect(messages(child).at(-1)?.error).toEqual({ code: -32601, message: `Browser command is not allowed: ${method}.` });
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it.each([undefined, { x: 0, y: 0, width: 1, height: 1, scale: 1 }])("passes screenshot bytes for page and clipped captures", async (clip) => {
		const { bridge, send, reply, child, onUnsafe } = make_connection({ autoReply: false });
		// More than two captures are allowed. File exports have their own budget.
		for (let count = 0; count < 3; count++) {
			const request = send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
			reply(request, { data: PNG_DATA });
			expect(messages(child).at(-1)).toMatchObject({ id: request.id, result: { data: PNG_DATA } });
		}
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it.each([
		"A".repeat(Math.ceil(2_097_152 / 3) * 4 + 4),
		Buffer.alloc(2_097_153).toString("base64"),
		png_with_dimensions(8193, 1),
		png_with_dimensions(5000, 4000),
	])("refuses a large screenshot and keeps the connection usable", async (data) => {
		const { bridge, send, reply, child, onUnsafe } = make_connection({ autoReply: false });
		const decode = vi.spyOn(globalThis, "atob");
		const request = send("Page.captureScreenshot", { format: "png" });
		reply(request, { data });
		expect(messages(child).at(-1)).toEqual({
			id: request.id, sessionId: "page-session", error: { code: -32000, message: "Screenshot exceeds the size limit." },
		});
		if (data.length > Math.ceil(2_097_152 / 3) * 4) expect(decode).not.toHaveBeenCalled();
		decode.mockRestore();
		const next = send("Page.captureScreenshot", { format: "png" });
		reply(next, { data: PNG_DATA });
		expect(messages(child).at(-1)).toMatchObject({ id: next.id, result: { data: PNG_DATA } });
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it.each([{}, { data: null }, { data: "%%%=" }, { data: "AAAA" }, { data: png_with_dimensions(0, 1) }])("closes on a malformed screenshot reply", async (result) => {
		const { bridge, send, reply, child, onUnsafe } = make_connection({ autoReply: false });
		const request = send("Page.captureScreenshot", { format: "png" });
		reply(request, result);
		expect(messages(child).some((message) => message.id === request.id)).toBe(false);
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "invalid_provider_reply" });
		expect(onUnsafe).toHaveBeenCalledExactlyOnceWith("invalid_provider_reply");
	});

	it("requires the screenshot reply to match the pending session", async () => {
		const { bridge, send, provider } = make_connection({ autoReply: false });
		const request = send("Page.captureScreenshot", { format: "png" });
		provider.send(JSON.stringify({ id: request.id, sessionId: "other-session", result: { data: PNG_DATA } }));
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "unknown_provider_reply" });
	});

	it("accepts JPEG dimensions only for a JPEG capture", async () => {
		// SOF header fixture. The bridge does not decode the compressed image stream.
		const data = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 2, 0]).toString("base64");
		const { bridge, send, reply, child } = make_connection({ autoReply: false });
		const request = send("Page.captureScreenshot", { format: "jpeg" });
		reply(request, { data });
		expect(messages(child).at(-1)).toMatchObject({ id: request.id, result: { data } });
		expect((await bridge.settle(1000)).safe).toBe(true);
		const wrong = make_connection({ autoReply: false });
		wrong.reply(wrong.send("Page.captureScreenshot", { format: "png" }), { data });
		expect(await wrong.bridge.settle(1000)).toMatchObject({ safe: false, reason: "invalid_provider_reply" });
	});

	it.each([{}, { code: -32000, message: null }])("closes on a malformed screenshot error", async (error) => {
		const { bridge, send, provider } = make_connection({ autoReply: false });
		const request = send("Page.captureScreenshot", { format: "png" });
		provider.send(JSON.stringify({ id: request.id, sessionId: "page-session", error }));
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "invalid_provider_reply" });
	});

	it("forwards a normal provider screenshot error without closing the connection", async () => {
		const { bridge, send, provider, child } = make_connection({ autoReply: false });
		const request = send("Page.captureScreenshot", { format: "png" });
		const error = { code: -32000, message: "Unable to capture screenshot" };
		provider.send(JSON.stringify({ id: request.id, sessionId: "page-session", error }));
		expect(messages(child).at(-1)).toMatchObject({ id: request.id, error });
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it("checks session scope and learned window IDs", async () => {
		const { bridge, send, provider, child } = make_connection();
		send("Runtime.evaluate", { expression: "1", contextId: 1 }, "other-session");
		send("Page.enable", {}, null);
		expect(messages(provider)).toEqual([]);
		expect(messages(child).slice(-2).every((message) => message.error)).toBe(true);
		send("Browser.getWindowForTarget");
		send("Browser.setWindowBounds", { windowId: 7, bounds: { width: 800, height: 600 } });
		expect(messages(provider).at(-1)?.method).toBe("Browser.setWindowBounds");
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it.each(["close", "error"])("keeps upstream alive to drain after child %s", async (event) => {
		const { bridge, send, provider, child, downstream, upstream, reply, onUnsafe } = make_connection({ autoReply: false });
		const request = send("Runtime.evaluate", { expression: "1", contextId: 1 });
		if (event === "close") child.close();
		else {
			downstream.dispatchEvent(new Event("error"));
			send("Input.insertText", { text: "late input" });
		}
		let settled = false;
		const result = bridge.settle(1000).then((value) => { settled = true; return value; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(upstream.readyState).toBe(1);
		reply(request, { result: { type: "number", value: 1 } });
		expect((await result).safe).toBe(true);
		expect(messages(provider)).toHaveLength(1);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it("cleans held input after a child error", async () => {
		const { bridge, send, provider, downstream, onUnsafe } = make_connection();
		send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" });
		downstream.dispatchEvent(new Event("error"));
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(messages(provider).at(-1)).toMatchObject({
			method: "Input.dispatchKeyEvent", sessionId: "page-session", params: { type: "keyUp", key: "Shift", code: "ShiftLeft" },
		});
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it("still fails if the provider connection is lost after a child error", async () => {
		const { bridge, downstream, upstream, onUnsafe } = make_connection();
		downstream.dispatchEvent(new Event("error"));
		upstream.dispatchEvent(new Event("error"));
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "provider_connection" });
		expect(onUnsafe).toHaveBeenCalledExactlyOnceWith("provider_connection");
	});

	it("does not forward new commands while draining", async () => {
		const { bridge, send, provider, child, reply } = make_connection({ autoReply: false });
		const request = send("Runtime.evaluate", { expression: "1", contextId: 1 });
		bridge.revoke();
		send("Input.insertText", { text: "late input" });
		const settlement = bridge.settle(1000);
		reply(request, {});
		expect((await settlement).safe).toBe(true);
		expect(messages(provider)).toHaveLength(1);
		// The late request gets an error reply, so the snippet does not wait for its timeout.
		expect(messages(child).find((message) => message.id === 2)).toEqual({ id: 2, sessionId: "page-session", error: { code: -32000, message: "Browser access was revoked." } });
	});

	it.each([false, true])("marks undrained work unsafe with child error=%s", async (childError) => {
		const { bridge, send, downstream, onUnsafe } = make_connection({ autoReply: false });
		send("Runtime.evaluate", { expression: "pending", contextId: 1 });
		if (childError) downstream.dispatchEvent(new Event("error"));
		const settlement = bridge.settle(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await settlement).toMatchObject({ safe: false, reason: "drain_timeout" });
		expect(onUnsafe).toHaveBeenCalledTimes(1);
		expect(onUnsafe).toHaveBeenCalledWith("drain_timeout");
	});

	it("waits for trusted popup cleanup and hides its session", async () => {
		let finishPopup: () => void = () => {};
		const popup = new Promise<void>((resolve) => { finishPopup = resolve; });
		const { bridge, emit, send, onPopup, child, provider } = make_connection({ onPopup: async () => popup });
		emit("Target.attachedToTarget", { sessionId: "popup-session", targetInfo: { targetId: "popup", type: "page", url: "https://private.invalid" } }, null);
		send("Page.enable", {}, "popup-session");
		let settled = false;
		const settlement = bridge.settle(1000).then((value) => { settled = true; return value; });
		await Promise.resolve();
		expect(onPopup).toHaveBeenCalledWith("popup");
		expect(settled).toBe(false);
		expect(messages(provider)).toEqual([]);
		expect(child.received.join(" ")).not.toContain("private.invalid");
		finishPopup();
		expect(await settlement).toEqual({ safe: true, reason: null, blockedPopups: 1 });
	});

	it("cleans scripts, bindings, held input, drag, and tracing on their own session", async () => {
		const { bridge, send, provider } = make_connection();
		send("Page.addScriptToEvaluateOnNewDocument", { source: "window.test = 1" });
		send("Runtime.addBinding", { name: "testBinding" });
		send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
		send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
		send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 1, y: 2 }] });
		send("Input.setInterceptDrags", { enabled: true });
		send("Input.dispatchDragEvent", { type: "dragEnter", x: 10, y: 20, data: { items: [], dragOperationsMask: 1 } });
		send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 800, maxHeight: 600 });
		expect((await bridge.settle(1000)).safe).toBe(true);
		const cleanup = messages(provider).filter((message) => Number(message.id) < 0);
		expect(cleanup.map((message) => message.method)).toEqual([
			"Page.removeScriptToEvaluateOnNewDocument", "Runtime.removeBinding", "Input.dispatchKeyEvent",
			"Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchDragEvent", "Input.setInterceptDrags", "Page.stopScreencast",
		]);
		expect(cleanup.every((message) => message.sessionId === "page-session")).toBe(true);
	});

	it("reports unsafe cleanup instead of releasing uncertain input", async () => {
		const { bridge, send, onUnsafe } = make_connection({ cleanupError: true });
		send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "command_failed" });
		expect(onUnsafe).toHaveBeenCalledTimes(1);
		expect(onUnsafe).toHaveBeenCalledWith("command_failed");
	});

	it("rejects duplicate request IDs and malformed envelopes", async () => {
		const { bridge, send, child, onUnsafe } = make_connection({ autoReply: false });
		const request = send("Runtime.evaluate", { expression: "1", contextId: 1 });
		child.send(JSON.stringify(request));
		expect((await bridge.settle(1000)).safe).toBe(false);
		expect(onUnsafe).toHaveBeenCalledTimes(1);
		const next = make_connection();
		next.child.send(JSON.stringify([{ id: 1, method: "Page.enable" }]));
		expect(await next.bridge.settle(1000)).toMatchObject({ safe: false, reason: "invalid_command" });
	});

	it("rejects a reply from a different CDP session", async () => {
		const { bridge, send, provider } = make_connection({ autoReply: false });
		const request = send("Runtime.evaluate", { expression: "1", contextId: 1 });
		provider.send(JSON.stringify({ id: request.id, sessionId: "other-session", result: {} }));
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "unknown_provider_reply" });
	});

	it("limits response reads to requests seen on the page", async () => {
		const { bridge, send, emit, provider, child } = make_connection();
		send("Network.getResponseBody", { requestId: "unknown-request" });
		expect(messages(child).at(-1)?.error).toBeDefined();
		emit("Network.requestWillBeSent", { requestId: "page-request", request: { url: "https://esm.sh/module" } });
		send("Network.getResponseBody", { requestId: "page-request" });
		expect(messages(provider).at(-1)?.method).toBe("Network.getResponseBody");
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it("tracks page descendants without granting browser or unrelated target access", async () => {
		const { bridge, emit, send, provider, child } = make_connection();
		emit("Target.attachedToTarget", { sessionId: "worker-session", targetInfo: { targetId: "worker", type: "worker" } });
		emit("Runtime.executionContextCreated", { context: { id: 10 } }, "worker-session");
		send("Runtime.evaluate", { expression: "1", contextId: 10 }, "worker-session");
		send("Page.captureScreenshot", { format: "png" }, "worker-session");
		expect(messages(provider)).toHaveLength(1);
		expect(messages(child).at(-1)?.error).toBeDefined();
		emit("Target.attachedToTarget", { sessionId: "unrelated", targetInfo: { targetId: "other-target", type: "other" } }, null);
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "unapproved_target" });
	});

	it.each([
		["file", "service_worker", null, true],
		["web", "service_worker", null, true],
		["web", "shared_worker", null, false],
		["web", "service_worker", "page-session", false],
	] as const)("detaches a %s mode %s (parent %s, paused=%s) without giving the child a session", async (mode, type, parent, waiting) => {
		const { bridge, emit, send, provider, child, onUnsafe } = make_connection({ mode });
		emit("Target.attachedToTarget", {
			sessionId: "worker-session", targetInfo: { targetId: "sw", type, url: "https://example.com/sw.js" }, waitingForDebugger: waiting,
		}, parent);
		expect(messages(provider).map(({ method, params, sessionId }) => ({ method, params, sessionId }))).toEqual([
			...(waiting ? [{ method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId: "worker-session" }] : []),
			{ method: "Target.detachFromTarget", params: { sessionId: "worker-session" }, sessionId: parent ?? undefined },
		]);
		emit("Target.detachedFromTarget", { sessionId: "worker-session", targetId: "sw" }, parent);
		send("Runtime.evaluate", { expression: "1", contextId: 1 }, "worker-session");
		expect(messages(child).at(-1)?.error).toBeDefined();
		expect(child.received.join(" ")).not.toContain("sw.js");
		expect(await bridge.settle(1000)).toEqual({ safe: true, reason: null, blockedPopups: 0 });
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it("keeps the session when a worker ends before the bridge detaches it", async () => {
		const { bridge, emit, provider, onUnsafe } = make_connection({ autoReply: false, mode: "web" });
		emit("Target.attachedToTarget", {
			sessionId: "worker-session", targetInfo: { targetId: "sw", type: "service_worker" }, waitingForDebugger: true,
		}, null);
		const [resume, detach] = messages(provider);
		// Chrome answers a call to an ended session on the root session, with no session id.
		expect(resume).toMatchObject({ method: "Runtime.runIfWaitingForDebugger", sessionId: "worker-session" });
		provider.send(JSON.stringify({ id: resume!.id, error: { code: -32001, message: "Session with given id not found." } }));
		expect(onUnsafe).not.toHaveBeenCalled();
		expect(detach).toMatchObject({ method: "Target.detachFromTarget" });
		provider.send(JSON.stringify({ id: detach!.id, error: { code: -32602, message: "No session with given id" } }));
		expect(onUnsafe).not.toHaveBeenCalled();
		expect(await bridge.settle(1000)).toEqual({ safe: true, reason: null, blockedPopups: 0 });
	});

	it("settles when Chrome never answers the resume call of a worker it detached", async () => {
		// Live order on a site with a service worker: attach (paused), resume, detach. The detach
		// closes the worker session first, so Chrome drops the resume reply.
		const { bridge, emit, provider, onUnsafe } = make_connection({ autoReply: false, mode: "web" });
		emit("Target.attachedToTarget", {
			sessionId: "worker-session", targetInfo: { targetId: "sw", type: "service_worker" }, waitingForDebugger: true,
		}, null);
		const [resume, detach] = messages(provider);
		expect(resume).toMatchObject({ method: "Runtime.runIfWaitingForDebugger", sessionId: "worker-session" });
		provider.send(JSON.stringify({ id: detach!.id, result: {} }));
		emit("Target.detachedFromTarget", { sessionId: "worker-session", targetId: "sw" }, null);
		const settled = bridge.settle(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await settled).toEqual({ safe: true, reason: null, blockedPopups: 0 });
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it("ignores a late worker reply but still refuses an unknown reply id", async () => {
		const { bridge, emit, provider, onUnsafe } = make_connection({ autoReply: false, mode: "web" });
		emit("Target.attachedToTarget", {
			sessionId: "worker-session", targetInfo: { targetId: "sw", type: "service_worker" }, waitingForDebugger: true,
		}, null);
		const [resume, detach] = messages(provider);
		provider.send(JSON.stringify({ id: detach!.id, result: {} }));
		provider.send(JSON.stringify({ id: resume!.id, sessionId: "worker-session", result: {} }));
		expect(onUnsafe).not.toHaveBeenCalled();
		// The same id again is unknown now.
		provider.send(JSON.stringify({ id: resume!.id, sessionId: "worker-session", result: {} }));
		expect(onUnsafe).toHaveBeenCalledWith("unknown_provider_reply");
		expect((await bridge.settle(1000)).safe).toBe(false);
	});

	it("retires destroyed execution contexts and reports a lost assigned target", async () => {
		const { bridge, emit, send, provider, child } = make_connection();
		emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
		send("Runtime.evaluate", { expression: "1", contextId: 1 });
		expect(messages(provider)).toEqual([]);
		expect(messages(child).at(-1)?.error).toBeDefined();
		emit("Target.detachedFromTarget", { sessionId: "page-session", targetId: "assigned-page" }, null);
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "assigned_target_detached" });
	});

	it("stops accepting work when too many provider requests are pending", async () => {
		const { bridge, send, provider, onUnsafe } = make_connection({ autoReply: false });
		for (let index = 0; index < 129; index++) send("Page.getLayoutMetrics");
		expect(messages(provider)).toHaveLength(128);
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "command_limit" });
		expect(onUnsafe).toHaveBeenCalledTimes(1);
	});

	it("runs cleanup once when settlement is requested twice", async () => {
		const { bridge, send, provider } = make_connection();
		send("Runtime.addBinding", { name: "binding" });
		const first = bridge.settle(1000);
		const second = bridge.settle(1000);
		expect(first).toBe(second);
		expect((await first).safe).toBe(true);
		expect(messages(provider).filter((message) => message.method === "Runtime.removeBinding")).toHaveLength(1);
	});

	it("ends the connection at its command deadline", async () => {
		const { bridge, onUnsafe } = make_connection();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await bridge.settle(1000)).toMatchObject({ safe: false, reason: "deadline" });
		expect(onUnsafe).toHaveBeenCalledTimes(1);
	});
});

describe("AgentConnection web mode", () => {
	it("forwards navigation with the normalized address", async () => {
		const { bridge, send, provider, child } = make_connection({ mode: "web" });
		send("Page.getFrameTree");
		send("Page.navigate", { url: "Example.com/path?q=1", frameId: "main-frame", referrer: "", referrerPolicy: "unsafeUrl" });
		send("Page.reload", {});
		send("Page.getNavigationHistory");
		send("Page.navigateToHistoryEntry", { entryId: 3 });
		send("Page.stopLoading");
		expect(messages(child).filter((message) => message.error)).toEqual([]);
		expect(messages(provider).find((message) => message.method === "Page.navigate")?.params).toEqual({
			url: "https://example.com/path?q=1", frameId: "main-frame", referrer: "", referrerPolicy: "unsafeUrl",
		});
		expect(messages(provider).map((message) => message.method)).toEqual([
			"Page.getFrameTree", "Page.navigate", "Page.reload", "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.stopLoading",
		]);
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it.each([
		["https://blocked.test/login", "denied_host"],
		["https://api.blocked.test/", "denied_host"],
		["javascript:alert(1)", "scheme"],
		["file:///etc/passwd", "scheme"],
		["https://user:pass@example.com/", "credentials"],
	])("refuses navigation to %s without echoing the address", async (url, reason) => {
		const { bridge, send, provider, child, onUnsafe } = make_connection({ mode: "web" });
		send("Page.getFrameTree");
		send("Page.navigate", { url, frameId: "main-frame" });
		expect(messages(provider).map((message) => message.method)).toEqual(["Page.getFrameTree"]);
		const refused = messages(child).at(-1);
		expect(refused?.error).toEqual({ code: -32000, message: `Browser address is not allowed: ${reason}.` });
		expect(JSON.stringify(refused)).not.toContain(url);
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it.each([
		["https://bank.test/login"],
		["https://www.Bank.test./"],
	])("refuses navigation to the agent's blocked site %s", async (url) => {
		const { bridge, send, provider, child, onUnsafe } = make_connection({ mode: "web", agentBlockedHosts: ["bank.test"] });
		send("Page.getFrameTree");
		send("Page.navigate", { url, frameId: "main-frame" });
		send("Page.navigate", { url: "https://example.com/", frameId: "main-frame" });
		expect(messages(provider).map((message) => message.method)).toEqual(["Page.getFrameTree", "Page.navigate"]);
		expect(messages(child).find((message) => message.id === 2)?.error)
			.toEqual({ code: -32000, message: "Browser address is not allowed: agent_blocked_site." });
		expect(JSON.stringify(messages(child))).not.toContain("bank.test");
		expect((await bridge.settle(1000)).safe).toBe(true);
		expect(onUnsafe).not.toHaveBeenCalled();
	});

	it("refuses history navigation to a blocked site or to an entry it never saw", async () => {
		const { bridge, send, provider, child } = make_connection({ mode: "web", agentBlockedHosts: ["bank.test"] });
		// Before the bridge saw the history, every entry is unknown.
		send("Page.navigateToHistoryEntry", { entryId: 3 });
		send("Page.getNavigationHistory");
		send("Page.navigateToHistoryEntry", { entryId: 4 });
		send("Page.navigateToHistoryEntry", { entryId: 99 });
		send("Page.navigateToHistoryEntry", { entryId: 3 });
		const refused = messages(child).filter((message) => message.error).map((message) => message.id);
		expect(refused).toEqual([1, 3, 4]);
		expect(messages(provider).map((message) => [message.method, message.params])).toEqual([
			["Page.getNavigationHistory", {}], ["Page.navigateToHistoryEntry", { entryId: 3 }],
		]);
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it("allows history navigation to any entry when no site is blocked", async () => {
		const { bridge, send, provider } = make_connection({ mode: "web" });
		send("Page.navigateToHistoryEntry", { entryId: 4 });
		expect(messages(provider).map((message) => message.method)).toEqual(["Page.navigateToHistoryEntry"]);
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it.each(["Page.navigate", "Page.reload", "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.stopLoading"])(
		"refuses %s in file mode",
		async (method) => {
			const { bridge, send, provider, child } = make_connection();
			send("Page.getFrameTree");
			send(method, method === "Page.navigate" ? { url: "https://example.com/", frameId: "main-frame" } :
				method === "Page.navigateToHistoryEntry" ? { entryId: 1 } : {});
			expect(messages(provider).map((message) => message.method)).toEqual(["Page.getFrameTree"]);
			expect(messages(child).at(-1)?.error).toEqual({ code: -32601, message: `Browser command is not allowed: ${method}.` });
			expect((await bridge.settle(1000)).safe).toBe(true);
		},
	);

	it("turns off universal access for isolated worlds in web mode only", async () => {
		const web = make_connection({ mode: "web" });
		web.send("Page.getFrameTree");
		web.send("Page.createIsolatedWorld", { frameId: "main-frame", worldName: "utility", grantUniveralAccess: true });
		expect(messages(web.provider).at(-1)?.params).toEqual({ frameId: "main-frame", worldName: "utility", grantUniveralAccess: false });
		const file = make_connection();
		file.send("Page.getFrameTree");
		file.send("Page.createIsolatedWorld", { frameId: "main-frame", worldName: "utility", grantUniveralAccess: true });
		expect(messages(file.provider).at(-1)?.params).toEqual({ frameId: "main-frame", worldName: "utility", grantUniveralAccess: true });
	});

	it("answers the download setting itself in web mode", async () => {
		const { bridge, send, provider, child } = make_connection({ mode: "web" });
		const request = send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/child/path", eventsEnabled: true }, null);
		expect(messages(provider)).toEqual([]);
		expect(messages(child).at(-1)).toEqual({ id: request.id, result: {} });
		expect((await bridge.settle(1000)).safe).toBe(true);
	});

	it.each(["file", "web"] as const)("removes cookies and credentials from network events (%s mode)", async (mode) => {
		const { bridge, emit, child } = make_connection({ mode });
		emit("Network.requestWillBeSent", {
			requestId: "r1",
			request: { url: "https://example.com/", headers: { Cookie: "sid=1", AUTHORIZATION: "Bearer t", Accept: "text/html" } },
			redirectResponse: { url: "https://example.com/old", headers: { "Set-Cookie": "sid=2", Location: "/" }, requestHeaders: { cookie: "sid=0" }, headersText: "Set-Cookie: sid=2" },
		});
		emit("Network.requestWillBeSentExtraInfo", {
			requestId: "r1", headers: { cookie: "sid=1", "Proxy-Authorization": "Basic x", accept: "*/*" },
			associatedCookies: [{ cookie: { name: "sid" } }], connectTiming: { requestTime: 1 },
		});
		emit("Network.responseReceived", {
			requestId: "r1",
			response: {
				url: "https://example.com/", status: 200, statusText: "OK", headers: { "set-cookie": "sid=3", "Content-Type": "text/html" },
				requestHeaders: { Cookie: "sid=1" }, headersText: "Set-Cookie: sid=3", requestHeadersText: "Cookie: sid=1",
			},
		});
		emit("Network.responseReceivedExtraInfo", {
			requestId: "r1", headers: { "Set-Cookie": "sid=3", "x-safe": "1" }, headersText: "Set-Cookie: sid=3",
			blockedCookies: [{ cookieLine: "sid=3" }], exemptedCookies: [], cookiePartitionKey: { topLevelSite: "https://example.com" },
			statusCode: 200,
		});
		emit("Network.webSocketWillSendHandshakeRequest", { requestId: "w1", request: { headers: { Cookie: "sid=1" } } });
		emit("Network.webSocketHandshakeResponseReceived", {
			requestId: "w1", response: { status: 101, headers: { "Set-Cookie": "sid=4" }, requestHeaders: { Authorization: "x" }, headersText: "x", requestHeadersText: "y" },
		});
		const events = messages(child).filter((message) => typeof message.method === "string" && message.method.startsWith("Network."));
		expect(events.map((event) => event.params)).toEqual([
			{
				requestId: "r1",
				request: { url: "https://example.com/", headers: { Accept: "text/html" } },
				redirectResponse: { url: "https://example.com/old", headers: { Location: "/" }, requestHeaders: {} },
			},
			{ requestId: "r1", headers: { accept: "*/*" }, connectTiming: { requestTime: 1 } },
			{
				requestId: "r1",
				response: { url: "https://example.com/", status: 200, statusText: "OK", headers: { "Content-Type": "text/html" }, requestHeaders: {} },
			},
			{ requestId: "r1", headers: { "x-safe": "1" }, statusCode: 200 },
			{ requestId: "w1", request: { headers: {} } },
			{ requestId: "w1", response: { status: 101, headers: {}, requestHeaders: {} } },
		]);
		expect(JSON.stringify(events)).not.toMatch(/sid=|Bearer|Basic/u);
		expect((await bridge.settle(1000)).safe).toBe(true);
	});
});
