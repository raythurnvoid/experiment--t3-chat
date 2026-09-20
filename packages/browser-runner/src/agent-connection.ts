// The child runs the Playwright client and server, so its CDP traffic is untrusted.
// Keep provider capabilities and connection lifetime checks outside that isolate.

type Params = Record<string, unknown>;
type Check = (value: unknown) => boolean;
type Session = {
	targetId: string;
	kind: "page" | "iframe" | "worker";
	contexts: Set<number>;
	scripts: Set<string>;
	bindings: Set<string>;
	keys: Map<string, Params>;
	buttons: Set<string>;
	x: number;
	y: number;
	touch: boolean;
	drag: boolean;
	interceptDrags: boolean;
	screencast: boolean;
	frameAcks: Set<number>;
};
type Pending = { method: string; params: Params; sessionId?: string; cleanup: boolean };

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_PROVIDER_BYTES = 8_388_608;
const MAX_PENDING = 128;
const MAX_REQUESTS = 10_000;
const MAX_TRAFFIC_BYTES = 134_217_728;

function is_record(value: unknown): value is Params {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function is_text(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_MESSAGE_BYTES;
}

function is_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function is_number(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function is_integer(value: unknown): value is number {
	return is_number(value) && Number.isSafeInteger(value) && value >= 0;
}

function is_boolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function optional(check: Check): Check {
	return (value) => value === undefined || check(value);
}

function shape(value: unknown, fields: Record<string, Check>): value is Params {
	return is_record(value) && Object.keys(value).every((key) => Object.hasOwn(fields, key)) &&
		Object.entries(fields).every(([key, check]) => check(value[key]));
}

function is_rect(value: unknown) {
	return shape(value, { x: is_number, y: is_number, width: is_number, height: is_number });
}

function is_fonts(value: unknown) {
	return shape(value, {
		standard: optional(is_text), fixed: optional(is_text), serif: optional(is_text),
		sansSerif: optional(is_text), cursive: optional(is_text), fantasy: optional(is_text), math: optional(is_text),
	});
}

function is_drag(value: unknown) {
	return shape(value, {
		items: (items) => Array.isArray(items) && items.length <= 32 && items.every((item) =>
			shape(item, { mimeType: is_text, data: is_text, title: optional(is_text), baseURL: optional(is_text) })),
		dragOperationsMask: is_integer,
		// File paths refer to the provider's disk, not files supplied by the user.
		files: optional((files) => Array.isArray(files) && files.length === 0),
	});
}

const PARAMS: Record<string, Record<string, Check>> = {
	"Browser.getVersion": {},
	"Browser.setDownloadBehavior": {
		behavior: (value) => value === "allowAndName" || value === "deny", downloadPath: optional(is_text),
		eventsEnabled: optional(is_boolean),
	},
	"Browser.getWindowForTarget": { targetId: optional(is_id) },
	"Browser.getWindowBounds": { windowId: is_integer },
	"Browser.setWindowBounds": {
		windowId: is_integer,
		bounds: (value) => shape(value, {
			width: (width) => is_integer(width) && width > 0 && width <= 2592,
			height: (height) => is_integer(height) && height > 0 && height <= 1568,
		}),
	},
	"Target.getTargetInfo": { targetId: optional(is_id) },
	"Target.setAutoAttach": {
		autoAttach: (value) => value === true, waitForDebuggerOnStart: (value) => value === true,
		flatten: (value) => value === true,
	},
	"Page.enable": {},
	"Page.getFrameTree": {},
	"Page.getLayoutMetrics": {},
	"Page.bringToFront": {},
	"Page.setLifecycleEventsEnabled": { enabled: is_boolean },
	"Page.createIsolatedWorld": { frameId: is_id, worldName: is_id, grantUniveralAccess: optional(is_boolean) },
	"Page.addScriptToEvaluateOnNewDocument": { source: is_text, worldName: optional(is_text), runImmediately: optional(is_boolean) },
	"Page.removeScriptToEvaluateOnNewDocument": { identifier: is_id },
	"Page.setFontFamilies": {
		fontFamilies: is_fonts,
		forScripts: optional((value) => Array.isArray(value) && value.length <= 32 &&
			value.every((item) => shape(item, { script: is_id, fontFamilies: is_fonts }))),
	},
	"Page.setInterceptFileChooserDialog": { enabled: is_boolean },
	"Page.handleJavaScriptDialog": { accept: is_boolean, promptText: optional(is_text) },
	"Page.captureScreenshot": {
		format: (value) => value === "png" || value === "jpeg",
		quality: optional((value) => is_integer(value) && value <= 100),
		captureBeyondViewport: optional(is_boolean),
		clip: optional((value) => shape(value, {
			x: is_number, y: is_number,
			width: (width) => is_number(width) && width > 0 && width <= 8192,
			height: (height) => is_number(height) && height > 0 && height <= 8192,
			scale: (scale) => is_number(scale) && scale > 0 && scale <= 4,
		}) && Number(value.width) * Number(value.height) * Number(value.scale) ** 2 <= 16_000_000),
	},
	"Page.startScreencast": {
		format: (value) => value === "jpeg", quality: (value) => is_integer(value) && value <= 100,
		maxWidth: (value) => is_integer(value) && value > 0 && value <= 2560,
		maxHeight: (value) => is_integer(value) && value > 0 && value <= 1440,
	},
	"Page.stopScreencast": {},
	"Page.screencastFrameAck": { sessionId: is_integer },
	"Log.enable": {},
	"Runtime.enable": {},
	"Runtime.runIfWaitingForDebugger": {},
	"Runtime.evaluate": { expression: is_text, contextId: is_integer, returnByValue: optional(is_boolean) },
	"Runtime.callFunctionOn": {
		functionDeclaration: is_text, objectId: is_id, returnByValue: optional(is_boolean),
		awaitPromise: optional(is_boolean), userGesture: optional(is_boolean),
		arguments: optional((value) => Array.isArray(value) && value.every((item) => shape(item, {
			value: () => true, objectId: optional(is_id), unserializableValue: optional(is_text),
		}))),
	},
	"Runtime.getProperties": { objectId: is_id, ownProperties: optional(is_boolean) },
	"Runtime.releaseObject": { objectId: is_id },
	"Runtime.addBinding": { name: is_id },
	"Runtime.removeBinding": { name: is_id },
	"DOM.describeNode": { objectId: is_id },
	"DOM.getBoxModel": { objectId: is_id },
	"DOM.getContentQuads": { objectId: is_id },
	"DOM.getFrameOwner": { frameId: is_id },
	"DOM.scrollIntoViewIfNeeded": { objectId: is_id, rect: optional(is_rect) },
	"DOM.resolveNode": { backendNodeId: is_integer, executionContextId: is_integer },
	"Network.enable": {},
	"Network.getResponseBody": { requestId: is_id },
	"Emulation.setFocusEmulationEnabled": { enabled: is_boolean },
	"Emulation.setDefaultBackgroundColorOverride": {
		color: optional((value) => shape(value, {
			r: (v) => is_integer(v) && v <= 255, g: (v) => is_integer(v) && v <= 255,
			b: (v) => is_integer(v) && v <= 255, a: optional((v) => is_number(v) && v >= 0 && v <= 1),
		})),
	},
	"Emulation.setEmulatedMedia": {
		media: is_text,
		features: (value) => Array.isArray(value) && value.length <= 16 &&
			value.every((item) => shape(item, { name: is_id, value: is_text })),
	},
	"Emulation.setDeviceMetricsOverride": {
		width: (value) => is_integer(value) && value >= 320 && value <= 2560,
		height: (value) => is_integer(value) && value >= 320 && value <= 1440,
		screenWidth: (value) => is_integer(value) && value >= 320 && value <= 2560,
		screenHeight: (value) => is_integer(value) && value >= 320 && value <= 1440,
		mobile: is_boolean, deviceScaleFactor: (value) => is_number(value) && value > 0 && value <= 2,
		dontSetVisibleSize: optional(is_boolean),
		screenOrientation: (value) => shape(value, { angle: is_number, type: is_id }),
	},
	"Input.dispatchKeyEvent": {
		type: (value) => ["keyDown", "keyUp", "rawKeyDown", "char"].includes(String(value)),
		key: optional(is_text), code: optional(is_text), text: optional(is_text), unmodifiedText: optional(is_text),
		windowsVirtualKeyCode: optional(is_integer), modifiers: optional(is_integer), location: optional(is_integer),
		autoRepeat: optional(is_boolean), isKeypad: optional(is_boolean),
		commands: optional((value) => Array.isArray(value) && value.every(is_text)),
	},
	"Input.insertText": { text: is_text },
	"Input.dispatchMouseEvent": {
		type: (value) => ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(value)),
		x: is_number, y: is_number, modifiers: optional(is_integer), buttons: optional(is_integer),
		button: optional((value) => ["none", "left", "middle", "right"].includes(String(value))),
		clickCount: optional(is_integer), force: optional(is_number), deltaX: optional(is_number), deltaY: optional(is_number),
	},
	"Input.dispatchTouchEvent": {
		type: (value) => value === "touchStart" || value === "touchEnd", modifiers: optional(is_integer),
		touchPoints: (value) => Array.isArray(value) && value.length <= 10 && value.every((point) =>
			shape(point, { x: is_number, y: is_number })),
	},
	"Input.setInterceptDrags": { enabled: is_boolean },
	"Input.dispatchDragEvent": {
		type: (value) => ["dragEnter", "dragOver", "drop", "dragCancel"].includes(String(value)),
		x: is_number, y: is_number, data: is_drag, modifiers: optional(is_integer),
	},
};

const ROOT_METHODS = new Set(["Browser.getVersion", "Browser.setDownloadBehavior", "Target.getTargetInfo", "Target.setAutoAttach"]);
const WORKER_METHODS = new Set([
	"Target.setAutoAttach", "Runtime.enable", "Runtime.runIfWaitingForDebugger", "Runtime.evaluate", "Runtime.callFunctionOn",
	"Runtime.getProperties", "Runtime.releaseObject", "Network.enable", "Network.getResponseBody",
]);
const EVENTS = new Set([
	"Page.frameAttached", "Page.frameDetached", "Page.frameNavigated", "Page.frameRequestedNavigation", "Page.navigatedWithinDocument",
	"Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.lifecycleEvent", "Page.windowOpen", "Page.fileChooserOpened", "Page.screencastFrame",
	"Runtime.bindingCalled", "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
	"Log.entryAdded", "Inspector.targetCrashed", "Inspector.workerScriptLoaded", "Input.dragIntercepted",
	"Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.requestServedFromCache", "Network.responseReceived",
	"Network.responseReceivedExtraInfo", "Network.loadingFinished", "Network.loadingFailed", "Network.webSocketCreated",
	"Network.webSocketWillSendHandshakeRequest", "Network.webSocketHandshakeResponseReceived", "Network.webSocketFrameSent",
	"Network.webSocketFrameReceived", "Network.webSocketClosed", "Network.webSocketFrameError",
]);

export class AgentConnection {
	private accepting = true;
	private settled = false;
	private unsafeReason: string | null = null;
	private requests = 0;
	private trafficBytes = 0;
	private cleanupId = -1;
	private pending = new Map<number, Pending>();
	private sessions = new Map<string, Session>();
	private frames = new Set<string>();
	private windows = new Set<number>();
	private networkRequests = new Set<string>();
	private popups = new Set<Promise<void>>();
	private blockedPopups = 0;
	private waiters = new Set<() => void>();
	private deadlineTimer: ReturnType<typeof setTimeout>;
	private settlement: Promise<{ safe: boolean; reason: string | null; blockedPopups: number }> | null = null;

	constructor(private input: {
		upstream: WebSocket;
		downstream: WebSocket;
		targetId: string;
		deadline: number;
		onPopup: (targetId: string) => Promise<void>;
		onUnsafe: (reason: string) => void;
	}) {
		input.downstream.addEventListener("message", (event) => this.from_child(event.data));
		input.downstream.addEventListener("close", () => this.revoke());
		// Child teardown can report an error. Stop input, then prove cleanup on the live upstream.
		input.downstream.addEventListener("error", () => this.revoke());
		input.upstream.addEventListener("message", (event) => this.from_provider(event.data));
		input.upstream.addEventListener("close", () => { if (!this.settled) this.fail("provider_connection"); });
		input.upstream.addEventListener("error", () => this.fail("provider_connection"));
		this.deadlineTimer = setTimeout(() => this.fail("deadline"), Math.max(0, input.deadline - Date.now()));
	}

	private wake() {
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	private close_sockets() {
		clearTimeout(this.deadlineTimer);
		for (const socket of [this.input.downstream, this.input.upstream]) {
			try { socket.close(1000, "command ended"); } catch { /* Already closed. */ }
		}
	}

	private fail(reason: string) {
		if (this.unsafeReason || this.settled) return;
		this.unsafeReason = reason;
		this.accepting = false;
		this.close_sockets();
		this.wake();
		this.input.onUnsafe(reason);
	}

	private reply(value: Params) {
		if (this.input.downstream.readyState !== 1) return;
		try { this.input.downstream.send(JSON.stringify(value)); } catch { this.revoke(); }
	}

	private parse(data: unknown, maxBytes: number) {
		if (typeof data !== "string" || data.length > maxBytes) return null;
		const bytes = new TextEncoder().encode(data).byteLength;
		if (bytes > maxBytes) return null;
		this.trafficBytes += bytes;
		if (this.trafficBytes > MAX_TRAFFIC_BYTES) { this.fail("traffic_limit"); return null; }
		try {
			const value: unknown = JSON.parse(data);
			return is_record(value) ? value : null;
		} catch { return null; }
	}

	private from_child(data: unknown) {
		if (!this.accepting) return;
		if (Date.now() >= this.input.deadline) return this.fail("deadline");
		const message = this.parse(data, MAX_MESSAGE_BYTES);
		if (!message || !shape(message, { id: is_integer, method: is_id, params: optional(is_record), sessionId: optional(is_id) }) ||
			typeof message.id !== "number" || message.id <= 0 || this.pending.has(message.id)) return this.fail("invalid_command");
		if (++this.requests > MAX_REQUESTS || this.pending.size >= MAX_PENDING) return this.fail("command_limit");
		const method = String(message.method);
		const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		const params = is_record(message.params) ? message.params : {};
		const fields = Object.hasOwn(PARAMS, method) ? PARAMS[method] : undefined;
		const allowedScope = sessionId ? !!session && (session.kind !== "worker" || WORKER_METHODS.has(method)) : ROOT_METHODS.has(method);
		if (!fields || !allowedScope || !shape(params, fields) || !this.allowed_params(method, params, session)) {
			this.reply({ id: message.id, ...(sessionId ? { sessionId } : {}), error: { code: -32601, message: `Browser command is not allowed: ${method}.` } });
			return;
		}
		// These startup requests must not choose a provider path or another target.
		const forwarded = method === "Browser.setDownloadBehavior" ? { behavior: "deny", eventsEnabled: false } :
			method === "Target.getTargetInfo" ? { targetId: this.input.targetId } : params;
		this.send(message.id, { method, params: forwarded, sessionId, cleanup: false });
	}

	private allowed_params(method: string, params: Params, session: Session | undefined) {
		if (method === "Browser.getWindowForTarget" || method === "Target.getTargetInfo") {
			if (params.targetId !== undefined && params.targetId !== this.input.targetId) return false;
		}
		if (method === "Browser.getWindowBounds" || method === "Browser.setWindowBounds") {
			if (!this.windows.has(Number(params.windowId))) return false;
		}
		if (params.frameId !== undefined && !this.frames.has(String(params.frameId))) return false;
		if (method === "Runtime.evaluate" && !session?.contexts.has(Number(params.contextId))) return false;
		if (method === "DOM.resolveNode" && !session?.contexts.has(Number(params.executionContextId))) return false;
		if (method === "Page.removeScriptToEvaluateOnNewDocument" && !session?.scripts.has(String(params.identifier))) return false;
		if (method === "Runtime.removeBinding" && !session?.bindings.has(String(params.name))) return false;
		if (method === "Page.screencastFrameAck" && !session?.frameAcks.has(Number(params.sessionId))) return false;
		if (method === "Network.getResponseBody" && !this.networkRequests.has(String(params.requestId))) return false;
		return true;
	}

	private send(id: number, request: Pending) {
		if (this.unsafeReason) return;
		if (this.pending.size >= MAX_PENDING) return this.fail("command_limit");
		this.pending.set(id, request);
		const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
		if (session && !request.cleanup) this.track_input(request.method, request.params, session);
		if (this.unsafeReason) return;
		try {
			this.input.upstream.send(JSON.stringify({ id, method: request.method, params: request.params,
				...(request.sessionId ? { sessionId: request.sessionId } : {}) }));
		} catch { this.fail("provider_send"); }
	}

	private track_input(method: string, params: Params, session: Session) {
		if (method === "Input.dispatchKeyEvent") {
			const key = `${String(params.code ?? "")}:${String(params.key ?? "")}`;
			if (params.type === "keyUp") session.keys.delete(key);
			else if (params.type !== "char") session.keys.set(key, { type: "keyUp", key: params.key, code: params.code,
				windowsVirtualKeyCode: params.windowsVirtualKeyCode, location: params.location, modifiers: 0 });
			if (session.keys.size > 128) this.fail("input_limit");
		}
		if (method === "Input.dispatchMouseEvent") {
			session.x = Number(params.x); session.y = Number(params.y);
			if (params.type === "mousePressed" && typeof params.button === "string") session.buttons.add(params.button);
			if (params.type === "mouseReleased" && typeof params.button === "string") session.buttons.delete(params.button);
		}
		if (method === "Input.dispatchTouchEvent") session.touch = params.type === "touchStart";
		if (method === "Input.setInterceptDrags") session.interceptDrags = params.enabled === true;
		if (method === "Input.dispatchDragEvent") session.drag = params.type === "dragEnter" || params.type === "dragOver";
		if (method === "Page.startScreencast") session.screencast = true;
		if (method === "Page.stopScreencast") session.screencast = false;
		if (method === "Page.screencastFrameAck") session.frameAcks.delete(Number(params.sessionId));
	}

	private remember_frames(value: unknown, depth = 0): boolean {
		if (!is_record(value) || !is_record(value.frame) || !is_id(value.frame.id) || depth > 64 || this.frames.size >= 2048) return false;
		this.frames.add(value.frame.id);
		if (value.childFrames === undefined) return true;
		return Array.isArray(value.childFrames) && value.childFrames.every((child) => this.remember_frames(child, depth + 1));
	}

	private from_provider(data: unknown) {
		if (this.settled || this.unsafeReason) return;
		const message = this.parse(data, MAX_PROVIDER_BYTES);
		if (!message) return this.fail("invalid_provider_message");
		if (message.sessionId !== undefined && !is_id(message.sessionId)) return this.fail("invalid_provider_message");
		const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
		if (message.id !== undefined) {
			if (typeof message.id !== "number") return this.fail("invalid_provider_reply");
			const request = this.pending.get(message.id);
			if (!request || request.sessionId !== sessionId) return this.fail("unknown_provider_reply");
			if (!is_record(message.result) && !is_record(message.error)) return this.fail("invalid_provider_reply");
			if (is_record(message.error) && (request.cleanup || request.method.startsWith("Input."))) return this.fail("command_failed");
			if (is_record(message.result) && !this.track_reply(request, message.result)) return this.fail("invalid_provider_reply");
			this.pending.delete(message.id);
			if (!request.cleanup) this.reply(message);
			this.wake();
			return;
		}
		if (!is_id(message.method) || !is_record(message.params)) return this.fail("invalid_provider_event");
		const params = message.params;
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		if (message.method === "Target.attachedToTarget") {
			if (!is_id(params.sessionId) || !is_record(params.targetInfo) || !is_id(params.targetInfo.targetId)) return this.fail("invalid_target");
			const targetId = params.targetInfo.targetId;
			const kind = params.targetInfo.type;
			const assigned = targetId === this.input.targetId && kind === "page";
			const child = !!session && (kind === "iframe" || kind === "worker");
			if (!assigned && !child) {
				if (kind !== "page") return this.fail("unapproved_target");
				this.blockedPopups += 1;
				const closing = Promise.resolve().then(() => this.input.onPopup(targetId)).catch(() => this.fail("popup_cleanup"));
				this.popups.add(closing);
				void closing.finally(() => { this.popups.delete(closing); this.wake(); });
				return;
			}
			if (this.sessions.has(params.sessionId) || this.sessions.size >= 64) return this.fail("target_limit");
			this.sessions.set(params.sessionId, { targetId, kind: assigned ? "page" : kind === "iframe" ? "iframe" : "worker",
				contexts: new Set(), scripts: new Set(), bindings: new Set(), keys: new Map(), buttons: new Set(),
				x: 0, y: 0, touch: false, drag: false, interceptDrags: false, screencast: false, frameAcks: new Set() });
			this.reply(message);
			return;
		}
		if (message.method === "Target.detachedFromTarget") {
			if (typeof params.sessionId !== "string" || !this.sessions.has(params.sessionId)) return;
			if (this.sessions.get(params.sessionId)?.targetId === this.input.targetId) return this.fail("assigned_target_detached");
			this.sessions.delete(params.sessionId);
			this.reply(message);
			return;
		}
		if (!session || !EVENTS.has(message.method)) return;
		if (message.method === "Runtime.executionContextCreated") {
			if (!is_record(params.context) || !is_integer(params.context.id) || session.contexts.size >= 1024) return this.fail("invalid_context");
			session.contexts.add(params.context.id);
		}
		if (message.method === "Runtime.executionContextDestroyed") {
			if (!is_integer(params.executionContextId)) return this.fail("invalid_context");
			session.contexts.delete(params.executionContextId);
		}
		if (message.method === "Runtime.executionContextsCleared") session.contexts.clear();
		if (message.method === "Page.frameAttached") {
			if (!is_id(params.frameId) || !is_id(params.parentFrameId) || this.frames.size >= 2048) return this.fail("invalid_frame");
			if (this.frames.has(params.parentFrameId)) this.frames.add(params.frameId);
		}
		if (message.method === "Page.frameDetached") {
			if (!is_id(params.frameId)) return this.fail("invalid_frame");
			if (params.reason !== "swap") this.frames.delete(params.frameId);
		}
		if (message.method === "Network.requestWillBeSent") {
			if (!is_id(params.requestId) || this.networkRequests.size >= 4096) return this.fail("network_limit");
			this.networkRequests.add(params.requestId);
		}
		if (message.method === "Page.screencastFrame") {
			if (!is_integer(params.sessionId) || session.frameAcks.size >= 128) return this.fail("invalid_screencast");
			session.frameAcks.add(params.sessionId);
		}
		if (message.method === "Input.dragIntercepted") {
			if (!is_drag(params.data)) return this.fail("invalid_drag");
			session.drag = true;
		}
		this.reply(message);
	}

	private track_reply(request: Pending, result: Params) {
		const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
		if (request.method === "Browser.getWindowForTarget") {
			if (!is_integer(result.windowId)) return false;
			this.windows.add(result.windowId);
		}
		if (request.method === "Page.getFrameTree" && !this.remember_frames(result.frameTree)) return false;
		if (request.method === "Page.createIsolatedWorld") {
			if (!session || !is_integer(result.executionContextId)) return false;
			session.contexts.add(result.executionContextId);
		}
		if (request.method === "Page.addScriptToEvaluateOnNewDocument") {
			if (!session || !is_id(result.identifier) || session.scripts.size >= 128) return false;
			session.scripts.add(result.identifier);
		}
		if (request.method === "Page.removeScriptToEvaluateOnNewDocument") session?.scripts.delete(String(request.params.identifier));
		if (request.method === "Runtime.addBinding") {
			if (!session || session.bindings.size >= 128) return false;
			session.bindings.add(String(request.params.name));
		}
		if (request.method === "Runtime.removeBinding") session?.bindings.delete(String(request.params.name));
		return true;
	}

	private async drain(deadline: number) {
		while (!this.unsafeReason && (this.pending.size > 0 || this.popups.size > 0)) {
			if (Date.now() >= deadline) { this.fail("drain_timeout"); break; }
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, deadline - Date.now());
				const wake = () => { clearTimeout(timer); resolve(); };
				this.waiters.add(wake);
			});
		}
	}

	revoke() {
		this.accepting = false;
	}

	settle(timeoutMs: number) {
		this.revoke();
		if (!this.settlement) this.settlement = this.finish(Date.now() + timeoutMs);
		return this.settlement;
	}

	private async finish(deadline: number) {
		await this.drain(deadline);
		if (!this.unsafeReason) {
			for (const [sessionId, session] of this.sessions) {
				const commands: Array<{ method: string; params: Params }> = [];
				const cleanup = (method: string, params: Params) => commands.push({ method, params });
				for (const identifier of session.scripts) cleanup("Page.removeScriptToEvaluateOnNewDocument", { identifier });
				for (const name of session.bindings) cleanup("Runtime.removeBinding", { name });
				for (const params of session.keys.values()) cleanup("Input.dispatchKeyEvent", params);
				for (const button of session.buttons) cleanup("Input.dispatchMouseEvent", { type: "mouseReleased", button, buttons: 0, x: session.x, y: session.y, modifiers: 0, clickCount: 1 });
				if (session.touch) cleanup("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				if (session.drag) cleanup("Input.dispatchDragEvent", { type: "dragCancel", x: session.x, y: session.y, data: { items: [], dragOperationsMask: 0 } });
				if (session.interceptDrags) cleanup("Input.setInterceptDrags", { enabled: false });
				if (session.screencast) cleanup("Page.stopScreencast", {});
				for (const command of commands) {
					if (this.unsafeReason) break;
					this.send(this.cleanupId--, { ...command, sessionId, cleanup: true });
					if (this.pending.size >= 64) await this.drain(deadline);
				}
			}
			await this.drain(deadline);
		}
		this.settled = !this.unsafeReason;
		this.close_sockets();
		return { safe: this.settled, reason: this.unsafeReason, blockedPopups: this.blockedPopups };
	}

	close() {
		if (this.settled) return;
		this.fail("connection_closed");
	}
}
