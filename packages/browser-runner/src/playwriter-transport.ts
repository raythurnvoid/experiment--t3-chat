// Translate the extension protocol for one fixed Playwright child at a time.
// The caller owns dial, hello/version checks, target confirmation, and command receipts.

import { browser_web_normalize_url } from "common/browser-web-url.ts";

type Params = Record<string, unknown>;
type Check = (value: unknown) => boolean;
type Target = {
	targetId: string;
	type: "page" | "iframe" | "worker";
	title: string;
	url: string;
	browserContextId: string;
	parentFrameId?: string;
};
type Session = {
	target: Target;
	parent?: string;
	contexts: Map<number, { frameId?: string; isDefault: boolean }>;
	frames: Set<string>;
	mainFrameId?: string;
};
type TargetAttachment = {
	target: Target;
	parent?: string;
	event: {
		method: "forwardCDPEvent";
		params: {
			method: "Target.attachedToTarget";
			sessionId?: string;
			params: Params & { sessionId: string; targetInfo: Params; waitingForDebugger: boolean };
		};
	};
	packet: string;
	bytes: number;
};
type Child = {
	socket: WebSocket;
	deadline: number;
	accepting: boolean;
	ended: boolean;
	reason: string | null;
	requests: number;
	trafficBytes: number;
	announced: Set<string>;
	aliases: Map<string, string>;
	aliasCount: number;
	browserSession: string;
	windowBounds: { width: number; height: number };
	scripts: Map<string, Set<string>>;
	bindings: Map<string, Set<string>>;
	guardBinding: string | null;
	guardContext: number | null;
	guardComplete: boolean;
	guardDestroyed: boolean;
	navigated: boolean;
	keys: Map<string, Map<string, Params>>;
	buttons: Map<string, Map<string, Params>>;
	waiters: Set<() => void>;
	timer: ReturnType<typeof setTimeout>;
	settlement?: Promise<{ safe: boolean; reason: string | null }>;
};
type Pending = {
	child: Child;
	childId?: number;
	childSessionId?: string;
	sessionId: string;
	method: string;
	params: Params;
	result?: Params;
	runtimeReady: boolean;
	timer?: ReturnType<typeof setTimeout>;
};

const MAX_CHILD_BYTES = 1_048_576;
const MAX_PROVIDER_BYTES = 8_388_608;
const MAX_PENDING = 128;
const MAX_REQUESTS = 10_000;
const MAX_TRAFFIC_BYTES = 134_217_728;
const MAX_SESSIONS = 64;
const MAX_FRAMES = 2048;
const MAX_CONTEXTS = 1024;
const MAX_SCREENSHOT_BYTES = 2_097_152;
const MAX_SCREENSHOT_EDGE = 8192;
const MAX_SCREENSHOT_PIXELS = 16_000_000;
const LOCAL_WINDOW_ID = 1;

function is_record(value: unknown): value is Params {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function is_text(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_CHILD_BYTES;
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
	return (
		is_record(value) &&
		Object.keys(value).every((key) => Object.hasOwn(fields, key)) &&
		Object.entries(fields).every(([key, check]) => check(value[key]))
	);
}

const PARAMS: Record<string, Record<string, Check>> = {
	"Browser.getVersion": {},
	"Browser.setDownloadBehavior": {
		behavior: is_id,
		downloadPath: optional(is_text),
		eventsEnabled: optional(is_boolean),
	},
	"Browser.getWindowForTarget": { targetId: optional(is_id) },
	"Browser.getWindowBounds": { windowId: is_integer },
	"Browser.setWindowBounds": {
		windowId: is_integer,
		bounds: (value) =>
			shape(value, {
				width: (width) => is_integer(width) && width > 0 && width <= 10_000,
				height: (height) => is_integer(height) && height > 0 && height <= 10_000,
			}),
	},
	"Target.getTargetInfo": { targetId: optional(is_id) },
	"Target.getTargets": {},
	"Target.setDiscoverTargets": { discover: is_boolean },
	"Target.setAutoAttach": {
		autoAttach: (value) => value === true,
		waitForDebuggerOnStart: is_boolean,
		flatten: (value) => value === true,
	},
	"Target.attachToBrowserTarget": {},
	"Target.attachToTarget": { targetId: is_id, flatten: (value) => value === true },
	"Target.detachFromTarget": { sessionId: is_id },
	"Page.enable": {},
	"Page.getFrameTree": {},
	"Page.getLayoutMetrics": {},
	"Page.setLifecycleEventsEnabled": { enabled: (value) => value === true },
	"Page.createIsolatedWorld": { frameId: is_id, worldName: is_id, grantUniveralAccess: optional(is_boolean) },
	"Page.addScriptToEvaluateOnNewDocument": {
		source: is_text,
		worldName: optional(is_id),
		runImmediately: optional(is_boolean),
	},
	"Page.removeScriptToEvaluateOnNewDocument": { identifier: is_id },
	"Page.setFontFamilies": {
		fontFamilies: is_record,
		forScripts: optional((value) => Array.isArray(value) && value.length <= 32),
	},
	"Page.setInterceptFileChooserDialog": { enabled: (value) => value === false },
	"Page.captureScreenshot": {
		format: (value) => value === "png" || value === "jpeg",
		quality: optional((value) => is_integer(value) && value <= 100),
		captureBeyondViewport: (value) => value === false,
	},
	"Page.navigate": {
		url: is_text,
		referrer: optional(is_text),
		frameId: optional(is_id),
		referrerPolicy: optional(is_text),
		transitionType: optional(is_text),
	},
	"Log.enable": {},
	"Runtime.enable": {},
	"Runtime.runIfWaitingForDebugger": {},
	"Runtime.evaluate": { expression: is_text, contextId: is_integer, returnByValue: optional(is_boolean) },
	"Runtime.callFunctionOn": {
		functionDeclaration: is_text,
		objectId: is_id,
		returnByValue: optional(is_boolean),
		awaitPromise: optional(is_boolean),
		userGesture: optional(is_boolean),
		arguments: optional(
			(value) =>
				Array.isArray(value) &&
				value.length <= 128 &&
				value.every((item) =>
					shape(item, { value: () => true, objectId: optional(is_id), unserializableValue: optional(is_text) }),
				),
		),
	},
	"Runtime.getProperties": { objectId: is_id, ownProperties: optional(is_boolean) },
	"Runtime.releaseObject": { objectId: is_id },
	"Runtime.addBinding": { name: is_id, executionContextId: optional(is_integer) },
	"Runtime.removeBinding": { name: is_id },
	"DOM.describeNode": { objectId: is_id },
	"DOM.getBoxModel": { objectId: is_id },
	"DOM.getContentQuads": { objectId: is_id },
	"DOM.getFrameOwner": { frameId: is_id },
	"DOM.scrollIntoViewIfNeeded": {
		objectId: is_id,
		rect: optional((value) => shape(value, { x: is_number, y: is_number, width: is_number, height: is_number })),
	},
	"DOM.resolveNode": { backendNodeId: is_integer, executionContextId: is_integer },
	"Network.enable": {},
	"Emulation.setFocusEmulationEnabled": { enabled: is_boolean },
	"Emulation.setDefaultBackgroundColorOverride": { color: optional(is_record) },
	"Emulation.setEmulatedMedia": { media: is_text, features: (value) => Array.isArray(value) && value.length <= 16 },
	"Emulation.setDeviceMetricsOverride": {
		width: is_integer,
		height: is_integer,
		screenWidth: is_integer,
		screenHeight: is_integer,
		mobile: is_boolean,
		deviceScaleFactor: is_number,
		dontSetVisibleSize: optional(is_boolean),
		screenOrientation: is_record,
	},
	"Input.dispatchKeyEvent": {
		type: (value) => ["keyDown", "keyUp", "rawKeyDown", "char"].includes(String(value)),
		key: optional(is_text),
		code: optional(is_text),
		text: optional(is_text),
		unmodifiedText: optional(is_text),
		windowsVirtualKeyCode: optional(is_integer),
		modifiers: optional((value) => value === 0),
		location: optional(is_integer),
		autoRepeat: optional(is_boolean),
		isKeypad: optional(is_boolean),
		commands: optional((value) => Array.isArray(value) && value.length === 0),
	},
	"Input.insertText": { text: is_text },
	"Input.dispatchMouseEvent": {
		type: (value) => ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(value)),
		x: is_number,
		y: is_number,
		modifiers: optional((value) => value === 0),
		buttons: optional(is_integer),
		button: optional((value) => ["none", "left", "middle", "right"].includes(String(value))),
		clickCount: optional(is_integer),
		force: optional(is_number),
		deltaX: optional(is_number),
		deltaY: optional(is_number),
	},
};

const LOCAL_METHODS = new Set([
	"Browser.setDownloadBehavior",
	"Network.enable",
	"Emulation.setFocusEmulationEnabled",
	"Emulation.setDefaultBackgroundColorOverride",
	"Emulation.setEmulatedMedia",
	"Emulation.setDeviceMetricsOverride",
	"Page.setFontFamilies",
	"Page.setInterceptFileChooserDialog",
	"Runtime.runIfWaitingForDebugger",
]);
const WORKER_METHODS = new Set([
	"Target.setAutoAttach",
	"Runtime.enable",
	"Runtime.runIfWaitingForDebugger",
	"Runtime.evaluate",
	"Runtime.callFunctionOn",
	"Runtime.getProperties",
	"Runtime.releaseObject",
	"Network.enable",
]);
const EVENTS = new Set([
	"Page.frameAttached",
	"Page.frameDetached",
	"Page.frameNavigated",
	"Page.frameRequestedNavigation",
	"Page.navigatedWithinDocument",
	"Page.javascriptDialogOpening",
	"Page.javascriptDialogClosed",
	"Page.lifecycleEvent",
	"Page.windowOpen",
	"Page.fileChooserOpened",
	"Runtime.bindingCalled",
	"Runtime.consoleAPICalled",
	"Runtime.exceptionThrown",
	"Runtime.executionContextCreated",
	"Runtime.executionContextDestroyed",
	"Runtime.executionContextsCleared",
	"Log.entryAdded",
	"Inspector.targetCrashed",
	"Inspector.workerScriptLoaded",
]);

function read_target(value: unknown): Target | null {
	if (
		!is_record(value) ||
		!is_id(value.targetId) ||
		(value.type !== "page" && value.type !== "iframe" && value.type !== "worker") ||
		typeof value.url !== "string" ||
		value.url.length > 8192 ||
		typeof value.title !== "string" ||
		value.title.length > 8192 ||
		(value.browserContextId !== undefined && !is_id(value.browserContextId)) ||
		(value.parentFrameId !== undefined && !is_id(value.parentFrameId))
	)
		return null;
	return {
		targetId: value.targetId,
		type: value.type === "page" ? "page" : value.type === "iframe" ? "iframe" : "worker",
		title: value.title,
		url: value.url,
		browserContextId:
			typeof value.browserContextId === "string" ? value.browserContextId : "playwriter-default-context",
		...(typeof value.parentFrameId === "string" ? { parentFrameId: value.parentFrameId } : {}),
	};
}

function screenshot_check(data: unknown, format: unknown) {
	if (typeof data !== "string") return "invalid";
	if (data.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) return "too_large";
	if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return "invalid";
	const raw = atob(data);
	if (raw.length > MAX_SCREENSHOT_BYTES) return "too_large";
	const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
	let width = 0;
	let height = 0;
	if (format === "png") {
		if (
			bytes.length < 24 ||
			![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
		)
			return "invalid";
		const view = new DataView(bytes.buffer);
		if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return "invalid";
		width = view.getUint32(16);
		height = view.getUint32(20);
	} else {
		if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return "invalid";
		for (let offset = 2; offset + 4 <= bytes.length;) {
			if (bytes[offset] !== 0xff) return "invalid";
			const marker = bytes[offset + 1];
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
				offset += 2;
				continue;
			}
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			if (length < 2 || offset + length + 2 > bytes.length) return "invalid";
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				if (length < 8) return "invalid";
				width = (bytes[offset + 7] << 8) | bytes[offset + 8];
				height = (bytes[offset + 5] << 8) | bytes[offset + 6];
				break;
			}
			offset += 2 + length;
		}
	}
	if (width === 0 || height === 0) return "invalid";
	return width > MAX_SCREENSHOT_EDGE || height > MAX_SCREENSHOT_EDGE || width * height > MAX_SCREENSHOT_PIXELS
		? "too_large"
		: "ok";
}

// One physical socket owns one inventory. The caller owns its startup deadline.
export class PlaywriterTargetInventory {
	private unusable = false;
	private bytes = 0;
	private sessions = new Map<string, TargetAttachment>();

	private fail() {
		this.unusable = true;
		this.sessions.clear();
		this.bytes = 0;
		return false;
	}

	private remember(sessionId: string, attachment: TargetAttachment) {
		const bytes = this.bytes - (this.sessions.get(sessionId)?.bytes ?? 0) + attachment.bytes;
		if (bytes > MAX_CHILD_BYTES || (!this.sessions.has(sessionId) && this.sessions.size >= MAX_SESSIONS))
			return this.fail();
		this.sessions.set(sessionId, attachment);
		this.bytes = bytes;
		return true;
	}

	consume(packet: unknown) {
		if (this.unusable) return false;
		if (typeof packet !== "string" || packet.length > MAX_PROVIDER_BYTES) return this.fail();
		const bytes = new TextEncoder().encode(packet).byteLength;
		if (bytes > MAX_PROVIDER_BYTES) return this.fail();
		let message: unknown;
		try {
			message = JSON.parse(packet);
		} catch {
			return this.fail();
		}
		if (!is_record(message)) return this.fail();
		if (message.method !== "forwardCDPEvent") return true;
		if (!is_record(message.params) || !is_id(message.params.method)) return this.fail();
		const method = message.params.method;
		if (!["Target.attachedToTarget", "Target.targetInfoChanged", "Target.detachedFromTarget"].includes(method))
			return true;
		if (
			message.id !== undefined ||
			!is_record(message.params.params) ||
			(message.params.sessionId !== undefined && !is_id(message.params.sessionId))
		)
			return this.fail();
		const params = message.params.params;
		const parent = typeof message.params.sessionId === "string" ? message.params.sessionId : undefined;

		if (method === "Target.detachedFromTarget") {
			if (!is_id(params.sessionId) || (params.targetId !== undefined && !is_id(params.targetId))) return this.fail();
			// A detach can arrive before its parent's attachment was seen.
			const detached = new Set([params.sessionId]);
			for (let index = 0; index < MAX_SESSIONS; index++) {
				let found = false;
				for (const [sessionId, attachment] of this.sessions)
					if (attachment.parent && detached.has(attachment.parent) && !detached.has(sessionId)) {
						detached.add(sessionId);
						found = true;
					}
				if (!found) break;
			}
			for (const sessionId of detached) {
				this.bytes -= this.sessions.get(sessionId)?.bytes ?? 0;
				this.sessions.delete(sessionId);
			}
			return true;
		}

		if (!is_record(params.targetInfo) || !is_id(params.targetInfo.targetId)) return this.fail();
		const targetInfo = params.targetInfo;
		if (method === "Target.targetInfoChanged") {
			const existing = [...this.sessions.entries()].find(
				([, attachment]) => attachment.target.targetId === targetInfo.targetId,
			);
			// A later full native attachment supplies fields for an unseen target.
			if (!existing) return true;
			const [sessionId, attachment] = existing;
			const target = read_target(targetInfo);
			if (
				!target ||
				target.type !== attachment.target.type ||
				targetInfo.browserContextId !== attachment.event.params.params.targetInfo.browserContextId ||
				(targetInfo.attached !== undefined && !is_boolean(targetInfo.attached)) ||
				(targetInfo.canAccessOpener !== undefined && !is_boolean(targetInfo.canAccessOpener))
			)
				return this.fail();
			const event = {
				...attachment.event,
				params: { ...attachment.event.params, params: { ...attachment.event.params.params, targetInfo } },
			};
			const nextPacket = JSON.stringify(event);
			return this.remember(sessionId, {
				...attachment,
				target,
				event,
				packet: nextPacket,
				bytes: new TextEncoder().encode(nextPacket).byteLength,
			});
		}

		if (!is_id(params.sessionId) || !is_boolean(params.waitingForDebugger) || !is_id(targetInfo.type))
			return this.fail();
		const existing = this.sessions.get(params.sessionId);
		if (!["page", "iframe", "worker"].includes(targetInfo.type)) {
			if (
				existing ||
				[...this.sessions.values()].some((attachment) => attachment.target.targetId === targetInfo.targetId)
			)
				return this.fail();
			return true;
		}
		const target = read_target(targetInfo);
		if (
			!target ||
			(target.type === "page" && parent !== undefined) ||
			(targetInfo.attached !== undefined && !is_boolean(targetInfo.attached)) ||
			(targetInfo.canAccessOpener !== undefined && !is_boolean(targetInfo.canAccessOpener))
		)
			return this.fail();
		if (
			existing &&
			(existing.target.targetId !== target.targetId ||
				existing.target.type !== target.type ||
				existing.parent !== parent ||
				existing.event.params.params.targetInfo.browserContextId !== targetInfo.browserContextId)
		)
			return this.fail();
		if (!existing && [...this.sessions.values()].some((attachment) => attachment.target.targetId === target.targetId))
			return this.fail();
		const event = {
			...message,
			method: "forwardCDPEvent" as const,
			params: {
				...message.params,
				method: "Target.attachedToTarget" as const,
				...(parent ? { sessionId: parent } : {}),
				params: { ...params, sessionId: params.sessionId, targetInfo, waitingForDebugger: params.waitingForDebugger },
			},
		};
		return this.remember(params.sessionId, { target, parent, event, packet, bytes });
	}

	get ready() {
		if (this.unusable || this.sessions.size === 0) return false;
		for (const [sessionId] of this.sessions) {
			const visited = new Set<string>();
			let current = sessionId;
			while (true) {
				if (visited.has(current)) return false;
				visited.add(current);
				const attachment = this.sessions.get(current);
				if (!attachment) return false;
				if (!attachment.parent) {
					if (attachment.target.type !== "page") return false;
					break;
				}
				current = attachment.parent;
			}
		}
		return true;
	}

	get roots() {
		if (this.unusable) return [];
		return [...this.sessions.entries()]
			.filter(([, attachment]) => attachment.target.type === "page" && !attachment.parent)
			.map(([sessionId, attachment]) => ({
				sessionId,
				targetId: attachment.target.targetId,
				targetInfo: {
					targetId: attachment.target.targetId,
					type: attachment.target.type,
					title: attachment.target.title,
					url: attachment.target.url,
					...(attachment.event.params.params.targetInfo.browserContextId !== undefined
						? { browserContextId: attachment.target.browserContextId }
						: {}),
					...(attachment.target.parentFrameId ? { parentFrameId: attachment.target.parentFrameId } : {}),
				},
			}));
	}

	snapshot(input: { targetId: string; sessionId: string }) {
		if (!this.ready) throw new Error("Browser target inventory is not ready.");
		const root = this.roots.find(
			(candidate) => candidate.targetId === input.targetId && candidate.sessionId === input.sessionId,
		);
		if (!root) throw new Error("Invalid confirmed browser target.");
		const initialEvents: string[] = [];
		const included = new Set<string>();
		const remaining = new Map(this.sessions);
		while (remaining.size > 0) {
			const before = remaining.size;
			for (const [sessionId, attachment] of remaining)
				if (sessionId === root.sessionId || (attachment.parent && included.has(attachment.parent))) {
					initialEvents.push(attachment.packet);
					included.add(sessionId);
					remaining.delete(sessionId);
				}
			if (before === remaining.size) break;
		}
		return { ...root, initialEvents };
	}
}

export class PlaywriterTransport {
	private nextId = 0;
	private nextChildId = 0;
	private closed = false;
	private child: Child | null = null;
	private pending = new Map<number, Pending>();
	private sessions = new Map<string, Session>();

	constructor(
		private input: {
			socket: WebSocket;
			targetId: string;
			sessionId: string;
			targetInfo: Record<string, unknown>;
			initialEvents?: readonly string[];
			onUnsafe: (reason: string) => void;
			onEvent: (reason: "dialog" | "popup" | "target_lost" | "debugger_conflict") => void;
			onNavigation: () => void;
			canSendInput: () => boolean;
		},
	) {
		const target = read_target(input.targetInfo);
		if (
			!target ||
			target.type !== "page" ||
			target.targetId !== input.targetId ||
			!is_id(input.sessionId) ||
			input.socket.readyState !== 1
		)
			throw new Error("Invalid confirmed browser target.");
		this.sessions.set(input.sessionId, { target, contexts: new Map(), frames: new Set() });
		input.socket.addEventListener("message", (event) => this.from_extension(event.data));
		input.socket.addEventListener("close", () => this.socket_lost());
		input.socket.addEventListener("error", () => this.socket_lost());
		const initialEvents = input.initialEvents ?? [];
		if (!Array.isArray(initialEvents) || initialEvents.length > MAX_SESSIONS) {
			this.close();
			throw new Error("Invalid browser attachment snapshot.");
		}
		let bytes = 0;
		// The caller keeps current attachments and orders them by their real parents.
		for (const event of initialEvents) {
			if (
				typeof event !== "string" ||
				event.length > MAX_CHILD_BYTES ||
				(bytes += new TextEncoder().encode(event).byteLength) > MAX_CHILD_BYTES
			) {
				this.close();
				throw new Error("Invalid browser attachment snapshot.");
			}
			this.from_extension(event, true);
			if (this.closed) throw new Error("Invalid browser attachment snapshot.");
		}
	}

	create_child(input: { deadline: number; guardBinding?: string }) {
		if (this.closed || this.input.socket.readyState !== 1 || !this.sessions.has(this.input.sessionId))
			throw new Error("Shared browser is offline.");
		if (this.child) throw new Error("Shared browser is busy.");
		if (!is_number(input.deadline) || input.deadline <= Date.now() || input.deadline > Date.now() + 30_000)
			throw new Error("Invalid browser deadline.");
		const pair = new WebSocketPair();
		pair[1].accept();
		const child: Child = {
			socket: pair[1],
			deadline: input.deadline,
			accepting: true,
			ended: false,
			reason: null,
			requests: 0,
			trafficBytes: 0,
			announced: new Set(),
			aliases: new Map(),
			aliasCount: 0,
			browserSession: `playwriter-browser-${++this.nextChildId}`,
			windowBounds: { width: 1280, height: 720 },
			scripts: new Map(),
			bindings: new Map(),
			guardBinding: input.guardBinding ?? null,
			guardContext: null,
			guardComplete: false,
			guardDestroyed: false,
			navigated: false,
			keys: new Map(),
			buttons: new Map(),
			waiters: new Set(),
			timer: setTimeout(() => this.fail_child(child, "deadline"), Math.max(0, input.deadline - Date.now())),
		};
		this.child = child;
		child.socket.addEventListener("message", (event) => this.from_child(child, event.data));
		child.socket.addEventListener("close", () => {
			child.accepting = false;
		});
		child.socket.addEventListener("error", () => {
			child.accepting = false;
		});
		return {
			webSocket: pair[0],
			revoke: () => {
				child.accepting = false;
			},
			outcome: () => ({ guarded: child.guardComplete, destroyed: child.guardDestroyed, navigated: child.navigated }),
			settle: (timeoutMs: number) => {
				child.accepting = false;
				clearTimeout(child.timer);
				if (!child.settlement)
					child.settlement = this.finish(child, Date.now() + Math.min(5000, Math.max(0, timeoutMs)));
				return child.settlement;
			},
		};
	}

	private wake(child: Child) {
		for (const resolve of child.waiters) resolve();
		child.waiters.clear();
	}

	private fail_child(child: Child, reason: string) {
		if (child.ended || child.reason) return;
		child.reason = reason;
		child.accepting = false;
		try {
			child.socket.close(1000, "command ended");
		} catch {
			/* Already closed. */
		}
		this.wake(child);
		this.input.onUnsafe(reason);
	}

	private fail_extension(reason: string) {
		if (this.child) this.fail_child(this.child, reason);
		else {
			this.input.onUnsafe(reason);
			this.close();
		}
	}

	private socket_lost() {
		this.closed = true;
		if (this.child) this.fail_child(this.child, "connection_lost");
		for (const request of this.pending.values()) if (request.timer) clearTimeout(request.timer);
		this.pending.clear();
		this.sessions.clear();
	}

	private parse(data: unknown, maxBytes: number, child?: Child) {
		if (typeof data !== "string" || data.length > maxBytes) return null;
		const bytes = new TextEncoder().encode(data).byteLength;
		if (bytes > maxBytes) return null;
		if (child) {
			child.trafficBytes += bytes;
			if (child.trafficBytes > MAX_TRAFFIC_BYTES) return null;
		}
		try {
			const value: unknown = JSON.parse(data);
			return is_record(value) ? value : null;
		} catch {
			return null;
		}
	}

	private reply(child: Child, value: Params) {
		if (child.ended || child.socket.readyState !== 1) return;
		try {
			child.socket.send(JSON.stringify(value));
		} catch {
			child.accepting = false;
		}
	}

	private refuse(child: Child, id: number, sessionId: string | undefined) {
		this.reply(child, {
			id,
			...(sessionId ? { sessionId } : {}),
			error: { code: -32601, message: "Browser command is not allowed." },
		});
	}

	private announce(child: Child, sessionId: string) {
		if (child.announced.has(sessionId)) return;
		const session = this.sessions.get(sessionId);
		if (!session || (session.parent && !child.announced.has(session.parent))) return;
		child.announced.add(sessionId);
		this.reply(child, {
			method: "Target.attachedToTarget",
			...(session.parent ? { sessionId: session.parent } : {}),
			params: { sessionId, targetInfo: session.target, waitingForDebugger: false },
		});
	}

	private from_child(child: Child, data: unknown) {
		const message = this.parse(data, MAX_CHILD_BYTES, child);
		if (
			!message ||
			!shape(message, { id: is_number, method: is_id, params: optional(is_record), sessionId: optional(is_id) }) ||
			typeof message.id !== "number" ||
			!Number.isSafeInteger(message.id)
		)
			return this.fail_child(child, "invalid_command");
		const id = message.id;
		const method = String(message.method);
		const childSessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
		// connect() normally closes only its socket. Never forward a native browser close.
		if (method === "Browser.close") {
			this.reply(child, { id, ...(childSessionId ? { sessionId: childSessionId } : {}), result: {} });
			child.accepting = false;
			return;
		}
		if (id <= 0 || !child.accepting || child.ended || this.child !== child || Date.now() >= child.deadline)
			return this.refuse(child, id, childSessionId);
		if (
			++child.requests > MAX_REQUESTS ||
			this.pending.size >= MAX_PENDING ||
			[...this.pending.values()].some((request) => request.child === child && request.childId === id)
		)
			return this.fail_child(child, "command_limit");
		const fields = Object.hasOwn(PARAMS, method) ? PARAMS[method] : undefined;
		const params = is_record(message.params) ? message.params : {};
		if (!fields || !shape(params, fields)) return this.refuse(child, id, childSessionId);
		if ((method.startsWith("Input.") || method === "Page.navigate") && !this.input.canSendInput())
			return this.refuse(child, id, childSessionId);
		// After guarded navigation, only old guard cleanup may continue.
		if (
			child.navigated &&
			child.guardComplete &&
			![
				"Runtime.callFunctionOn",
				"Runtime.releaseObject",
				"Runtime.removeBinding",
				"Page.removeScriptToEvaluateOnNewDocument",
			].includes(method)
		)
			return this.refuse(child, id, childSessionId);
		const sessionId = childSessionId ? (child.aliases.get(childSessionId) ?? childSessionId) : this.input.sessionId;
		const session = this.sessions.get(sessionId);
		const browserScope = !childSessionId || childSessionId === child.browserSession;
		if (
			(!browserScope && (!session || !child.announced.has(sessionId))) ||
			(session?.target.type === "worker" && !WORKER_METHODS.has(method))
		)
			return this.refuse(child, id, childSessionId);
		if (params.targetId !== undefined && params.targetId !== this.input.targetId)
			return this.refuse(child, id, childSessionId);
		if (params.frameId !== undefined && !session?.frames.has(String(params.frameId)))
			return this.refuse(child, id, childSessionId);
		if (
			(method === "Runtime.evaluate" && !session?.contexts.has(Number(params.contextId))) ||
			(method === "DOM.resolveNode" && !session?.contexts.has(Number(params.executionContextId)))
		)
			return this.refuse(child, id, childSessionId);
		if (
			method === "Runtime.addBinding" &&
			params.executionContextId !== undefined &&
			(params.name !== child.guardBinding ||
				sessionId !== this.input.sessionId ||
				!session?.mainFrameId ||
				session.contexts.get(Number(params.executionContextId))?.frameId !== session.mainFrameId ||
				session.contexts.get(Number(params.executionContextId))?.isDefault !== false)
		)
			return this.refuse(child, id, childSessionId);

		if (method === "Browser.getVersion" && browserScope) {
			this.reply(child, {
				id,
				...(childSessionId ? { sessionId: childSessionId } : {}),
				result: {
					protocolVersion: "1.3",
					product: "Chrome/142.0.0.0",
					revision: "playwriter-bridge",
					userAgent: "Chrome/142.0.0.0",
					jsVersion: "V8",
				},
			});
			return;
		}
		if ((method === "Target.getTargetInfo" || method === "Target.getTargets") && browserScope) {
			this.reply(child, {
				id,
				...(childSessionId ? { sessionId: childSessionId } : {}),
				result:
					method === "Target.getTargets"
						? { targetInfos: [this.sessions.get(this.input.sessionId)?.target] }
						: { targetInfo: this.sessions.get(this.input.sessionId)?.target },
			});
			return;
		}
		if (method === "Target.setDiscoverTargets" && browserScope) {
			this.reply(child, { id, ...(childSessionId ? { sessionId: childSessionId } : {}), result: {} });
			return;
		}
		if (method === "Target.attachToBrowserTarget" && !childSessionId) {
			this.reply(child, { id, result: { sessionId: child.browserSession } });
			return;
		}
		if (method === "Target.attachToTarget" && childSessionId === child.browserSession) {
			if (child.aliasCount >= 8) return this.refuse(child, id, childSessionId);
			const alias = `playwriter-capture-${this.nextChildId}-${++child.aliasCount}`;
			child.aliases.set(alias, this.input.sessionId);
			this.reply(child, { id, sessionId: childSessionId, result: { sessionId: alias } });
			return;
		}
		if (
			method === "Target.detachFromTarget" &&
			childSessionId === child.browserSession &&
			child.aliases.delete(String(params.sessionId))
		) {
			this.reply(child, { id, sessionId: childSessionId, result: {} });
			return;
		}
		if (method === "Browser.getWindowForTarget" && !browserScope) {
			this.reply(child, {
				id,
				sessionId: childSessionId,
				result: { windowId: LOCAL_WINDOW_ID, bounds: child.windowBounds },
			});
			return;
		}
		if (
			(method === "Browser.getWindowBounds" || method === "Browser.setWindowBounds") &&
			!browserScope &&
			params.windowId === LOCAL_WINDOW_ID
		) {
			if (method === "Browser.setWindowBounds" && is_record(params.bounds))
				child.windowBounds = { width: Number(params.bounds.width), height: Number(params.bounds.height) };
			this.reply(child, {
				id,
				sessionId: childSessionId,
				result: method === "Browser.getWindowBounds" ? { bounds: child.windowBounds } : {},
			});
			return;
		}
		if (LOCAL_METHODS.has(method) && (method === "Browser.setDownloadBehavior" ? browserScope : !browserScope)) {
			this.reply(child, { id, ...(childSessionId ? { sessionId: childSessionId } : {}), result: {} });
			return;
		}
		if (browserScope && method !== "Target.setAutoAttach") return this.refuse(child, id, childSessionId);
		if (method === "Target.attachToTarget" || method === "Target.detachFromTarget" || method.startsWith("Browser."))
			return this.refuse(child, id, childSessionId);
		if (
			method === "Page.removeScriptToEvaluateOnNewDocument" &&
			!child.scripts.get(sessionId)?.has(String(params.identifier))
		)
			return this.refuse(child, id, childSessionId);
		if (method === "Runtime.removeBinding" && !child.bindings.get(sessionId)?.has(String(params.name)))
			return this.refuse(child, id, childSessionId);
		let forwarded = params;
		if (method === "Target.setAutoAttach") {
			forwarded = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
			this.announce(child, sessionId);
			for (const [candidate, descendant] of this.sessions)
				if (descendant.parent === sessionId) this.announce(child, candidate);
		}
		if (method === "Page.createIsolatedWorld") forwarded = { ...params, grantUniveralAccess: false };
		if (method === "Page.navigate") {
			const normalized = browser_web_normalize_url(String(params.url), []);
			if (!normalized.ok) return this.refuse(child, id, childSessionId);
			forwarded = { ...params, url: normalized.url };
		}
		this.send(child, sessionId, method, forwarded, id, childSessionId);
	}

	private send(
		child: Child,
		sessionId: string,
		method: string,
		params: Params,
		childId?: number,
		childSessionId?: string,
	) {
		if (this.closed || this.pending.size >= MAX_PENDING || this.nextId >= Number.MAX_SAFE_INTEGER)
			return this.fail_child(child, "connection_limit");
		const id = ++this.nextId;
		const request: Pending = {
			child,
			childId,
			childSessionId,
			sessionId,
			method,
			params,
			runtimeReady: method !== "Runtime.enable",
		};
		this.pending.set(id, request);
		if (method === "Runtime.enable") {
			this.sessions.get(sessionId)?.contexts.clear();
			request.timer = setTimeout(
				() => this.fail_child(child, "runtime_not_ready"),
				Math.max(0, Math.min(3000, child.deadline - Date.now())),
			);
		}
		if (method === "Input.dispatchKeyEvent") {
			const keys = child.keys.get(sessionId) ?? new Map<string, Params>();
			child.keys.set(sessionId, keys);
			const key = `${String(params.code ?? "")}:${String(params.key ?? "")}`;
			if (params.type === "keyUp") keys.delete(key);
			else if (params.type !== "char") keys.set(key, { ...params, type: "keyUp", modifiers: 0 });
			if (keys.size > 128) return this.fail_child(child, "input_limit");
		}
		if (method === "Input.dispatchMouseEvent") {
			const buttons = child.buttons.get(sessionId) ?? new Map<string, Params>();
			child.buttons.set(sessionId, buttons);
			if (params.type === "mousePressed")
				buttons.set(String(params.button), {
					type: "mouseReleased",
					button: params.button,
					buttons: 0,
					x: params.x,
					y: params.y,
					modifiers: 0,
					clickCount: 1,
				});
			if (params.type === "mouseReleased") buttons.delete(String(params.button));
		}
		try {
			this.input.socket.send(
				JSON.stringify({ id, method: "forwardCDPCommand", params: { method, sessionId, params } }),
			);
		} catch {
			this.pending.delete(id);
			if (request.timer) clearTimeout(request.timer);
			this.fail_child(child, "connection_lost");
		}
	}

	private remember_frames(session: Session, value: unknown, depth = 0): boolean {
		if (
			!is_record(value) ||
			!is_record(value.frame) ||
			!is_id(value.frame.id) ||
			depth > 64 ||
			session.frames.size >= MAX_FRAMES
		)
			return false;
		session.frames.add(value.frame.id);
		if (value.childFrames === undefined) return true;
		return (
			Array.isArray(value.childFrames) &&
			value.childFrames.every((child) => this.remember_frames(session, child, depth + 1))
		);
	}

	private complete(id: number, request: Pending) {
		if (!request.result || !request.runtimeReady) return;
		this.pending.delete(id);
		if (request.timer) clearTimeout(request.timer);
		if (request.childId !== undefined)
			this.reply(request.child, {
				id: request.childId,
				...(request.childSessionId ? { sessionId: request.childSessionId } : {}),
				result: request.result,
			});
		this.wake(request.child);
	}

	private from_extension(data: unknown, initial = false) {
		if (this.closed) return;
		const message = this.parse(data, MAX_PROVIDER_BYTES, this.child ?? undefined);
		if (
			!message ||
			(initial &&
				(message.id !== undefined ||
					message.method !== "forwardCDPEvent" ||
					!is_record(message.params) ||
					message.params.method !== "Target.attachedToTarget"))
		)
			return this.fail_extension("invalid_extension_message");
		if (message.method === "pong" || message.method === "hello" || message.method === "ready") return;
		if (message.method === "ping") {
			try {
				this.input.socket.send(JSON.stringify({ method: "pong" }));
			} catch {
				this.socket_lost();
			}
			return;
		}
		if (message.id !== undefined) {
			if (!is_integer(message.id) || message.id <= 0) {
				if (this.child) this.fail_child(this.child, "invalid_extension_reply");
				return;
			}
			const request = this.pending.get(message.id);
			// Socket-lifetime IDs are never reused. A retired reply cannot belong to the next child.
			if (!request) return;
			if (message.error !== undefined) {
				if (typeof message.error !== "string" || message.result !== undefined)
					return this.fail_child(request.child, "invalid_extension_reply");
				this.pending.delete(message.id);
				if (request.timer) clearTimeout(request.timer);
				if (request.childId === undefined || request.method.startsWith("Input."))
					this.fail_child(request.child, "command_failed");
				if (request.childId !== undefined)
					this.reply(request.child, {
						id: request.childId,
						...(request.childSessionId ? { sessionId: request.childSessionId } : {}),
						error: { code: -32000, message: "Remote browser command failed." },
					});
				this.wake(request.child);
				return;
			}
			if (!is_record(message.result)) return this.fail_child(request.child, "invalid_extension_reply");
			const session = this.sessions.get(request.sessionId);
			if (!session) return this.fail_child(request.child, "target_lost");
			if (request.method === "Page.getFrameTree") {
				session.frames.clear();
				if (
					!this.remember_frames(session, message.result.frameTree) ||
					!is_record(message.result.frameTree) ||
					!is_record(message.result.frameTree.frame)
				)
					return this.fail_child(request.child, "invalid_frame");
				session.mainFrameId = String(message.result.frameTree.frame.id);
				this.complete_runtime(request.sessionId);
			}
			if (request.method === "Page.createIsolatedWorld") {
				if (!is_integer(message.result.executionContextId) || session.contexts.size >= MAX_CONTEXTS)
					return this.fail_child(request.child, "invalid_context");
				session.contexts.set(message.result.executionContextId, {
					frameId: String(request.params.frameId),
					isDefault: false,
				});
			}
			if (request.method === "Page.addScriptToEvaluateOnNewDocument") {
				if (!is_id(message.result.identifier)) return this.fail_child(request.child, "invalid_script");
				const scripts = request.child.scripts.get(request.sessionId) ?? new Set<string>();
				if (scripts.size >= 128) return this.fail_child(request.child, "script_limit");
				scripts.add(message.result.identifier);
				request.child.scripts.set(request.sessionId, scripts);
			}
			if (request.method === "Page.removeScriptToEvaluateOnNewDocument")
				request.child.scripts.get(request.sessionId)?.delete(String(request.params.identifier));
			if (request.method === "Runtime.addBinding") {
				const bindings = request.child.bindings.get(request.sessionId) ?? new Set<string>();
				if (bindings.size >= 128) return this.fail_child(request.child, "binding_limit");
				bindings.add(String(request.params.name));
				request.child.bindings.set(request.sessionId, bindings);
				if (request.params.name === request.child.guardBinding && is_integer(request.params.executionContextId))
					request.child.guardContext = request.params.executionContextId;
			}
			if (request.method === "Runtime.removeBinding")
				request.child.bindings.get(request.sessionId)?.delete(String(request.params.name));
			if (request.method === "Page.captureScreenshot") {
				const check = screenshot_check(message.result.data, request.params.format);
				if (check === "invalid") return this.fail_child(request.child, "invalid_screenshot");
				if (check === "too_large") {
					this.pending.delete(message.id);
					if (request.childId !== undefined)
						this.reply(request.child, {
							id: request.childId,
							...(request.childSessionId ? { sessionId: request.childSessionId } : {}),
							error: { code: -32000, message: "Screenshot exceeds the size limit." },
						});
					this.wake(request.child);
					return;
				}
			}
			request.result = message.result;
			this.complete(message.id, request);
			return;
		}
		if (
			message.method !== "forwardCDPEvent" ||
			!is_record(message.params) ||
			!is_id(message.params.method) ||
			!is_record(message.params.params) ||
			(message.params.sessionId !== undefined && !is_id(message.params.sessionId))
		)
			return this.fail_extension("invalid_extension_event");
		const method = message.params.method;
		const params = message.params.params;
		const sessionId = typeof message.params.sessionId === "string" ? message.params.sessionId : undefined;
		const session = sessionId ? this.sessions.get(sessionId) : undefined;
		const child = this.child;
		if (method === "Target.attachedToTarget") {
			if (!is_id(params.sessionId) || !is_boolean(params.waitingForDebugger) || !is_record(params.targetInfo))
				return this.fail_extension("invalid_target");
			if (params.waitingForDebugger) {
				this.input.onEvent("debugger_conflict");
				return this.fail_extension("debugger_conflict");
			}
			const target = read_target(params.targetInfo);
			if (!target) {
				if (
					!initial &&
					typeof params.targetInfo.type === "string" &&
					params.targetInfo.type.length > 0 &&
					!["page", "iframe", "worker"].includes(params.targetInfo.type)
				)
					return;
				return this.fail_extension("invalid_target");
			}
			const existing = this.sessions.get(params.sessionId);
			if (existing) {
				if (
					existing.target.targetId !== target.targetId ||
					existing.target.type !== target.type ||
					existing.target.browserContextId !== target.browserContextId ||
					existing.parent !== sessionId
				)
					return this.fail_extension("target_changed");
				existing.target = target;
				return;
			}
			if ([...this.sessions.values()].some((candidate) => candidate.target.targetId === target.targetId))
				return this.fail_extension("target_changed");
			if (target.type === "page") {
				this.input.onEvent("popup");
				if (initial) this.fail_extension("target_changed");
				else if (child) child.accepting = false;
				return;
			}
			if (!session) {
				if (initial) this.fail_extension("invalid_target_parent");
				return;
			}
			if (this.sessions.size >= MAX_SESSIONS) return this.fail_extension("target_limit");
			this.sessions.set(params.sessionId, { target, parent: sessionId, contexts: new Map(), frames: new Set() });
			if (child) this.announce(child, params.sessionId);
			return;
		}
		if (method === "Target.detachedFromTarget") {
			if (!is_id(params.sessionId)) {
				if (child) this.fail_child(child, "invalid_target");
				return;
			}
			if (!this.sessions.has(params.sessionId)) return;
			const detached = new Set([params.sessionId]);
			for (let index = 0; index < MAX_SESSIONS; index++) {
				let found = false;
				for (const [candidate, descendant] of this.sessions)
					if (descendant.parent && detached.has(descendant.parent) && !detached.has(candidate)) {
						detached.add(candidate);
						found = true;
					}
				if (!found) break;
			}
			for (const candidate of detached) {
				const target = this.sessions.get(candidate);
				this.sessions.delete(candidate);
				if (target && child?.announced.delete(candidate))
					this.reply(child, {
						method,
						...(target.parent ? { sessionId: target.parent } : {}),
						params: { sessionId: candidate, targetId: target.target.targetId },
					});
			}
			if (params.sessionId === this.input.sessionId) {
				this.input.onEvent("target_lost");
				return this.fail_extension("target_lost");
			}
			return;
		}
		if (!session || !EVENTS.has(method)) return;
		if (method === "Runtime.executionContextCreated") {
			if (
				!is_record(params.context) ||
				!is_integer(params.context.id) ||
				session.contexts.size >= MAX_CONTEXTS ||
				(params.context.auxData !== undefined && !is_record(params.context.auxData))
			) {
				if (child) this.fail_child(child, "invalid_context");
				return;
			}
			const aux = is_record(params.context.auxData) ? params.context.auxData : {};
			if (
				(aux.frameId !== undefined && !is_id(aux.frameId)) ||
				(aux.isDefault !== undefined && !is_boolean(aux.isDefault))
			) {
				if (child) this.fail_child(child, "invalid_context");
				return;
			}
			const isDefault = session.target.type === "worker" ? aux.isDefault !== false : aux.isDefault === true;
			session.contexts.set(params.context.id, {
				...(typeof aux.frameId === "string" ? { frameId: aux.frameId } : {}),
				isDefault,
			});
		}
		if (method === "Runtime.executionContextDestroyed") {
			if (!is_integer(params.executionContextId)) {
				if (child) this.fail_child(child, "invalid_context");
				return;
			}
			session.contexts.delete(params.executionContextId);
		}
		if (method === "Runtime.executionContextsCleared") {
			session.contexts.clear();
			// All old document handles are gone, including the guard and original element.
			if (child && child.guardContext !== null && sessionId === this.input.sessionId) child.guardDestroyed = true;
		}
		if (
			method === "Runtime.bindingCalled" &&
			child &&
			sessionId === this.input.sessionId &&
			params.name === child.guardBinding
		) {
			// Page-world bindings and unrelated human events cannot prove this command.
			const context = session.contexts.get(Number(params.executionContextId));
			if (
				params.payload === "complete" &&
				params.executionContextId === child.guardContext &&
				context?.isDefault === false &&
				context.frameId === session.mainFrameId &&
				[...this.pending.values()].some(
					(request) =>
						request.child === child &&
						request.sessionId === sessionId &&
						((request.method === "Input.dispatchMouseEvent" &&
							request.params.type === "mouseReleased" &&
							request.params.button === "left") ||
							(request.method === "Input.dispatchKeyEvent" &&
								["keyDown", "rawKeyDown"].includes(String(request.params.type)) &&
								request.params.key === "Enter")),
				)
			)
				child.guardComplete = true;
			return;
		}
		const committed =
			sessionId === this.input.sessionId &&
			((method === "Page.frameNavigated" && is_record(params.frame) && params.frame.parentId === undefined) ||
				(method === "Page.navigatedWithinDocument" && params.frameId === session.mainFrameId));
		if (committed) {
			const url = method === "Page.frameNavigated" && is_record(params.frame) ? params.frame.url : params.url;
			if (typeof url !== "string" || url.length > 8192) return this.fail_extension("invalid_navigation");
			session.target.url = url;
			if (child) child.navigated = true;
		}
		if (
			sessionId === this.input.sessionId &&
			(method === "Runtime.executionContextsCleared" ||
				(method === "Page.frameNavigated" && is_record(params.frame) && params.frame.parentId === undefined) ||
				(method === "Page.navigatedWithinDocument" && params.frameId === session.mainFrameId))
		)
			this.input.onNavigation();
		if (method === "Page.frameAttached") {
			if (!is_id(params.frameId) || !is_id(params.parentFrameId) || session.frames.size >= MAX_FRAMES) {
				if (child) this.fail_child(child, "invalid_frame");
				return;
			}
			if (session.frames.has(params.parentFrameId)) session.frames.add(params.frameId);
		}
		if (method === "Page.frameDetached" && params.reason !== "swap" && is_id(params.frameId))
			session.frames.delete(params.frameId);
		if (method === "Page.javascriptDialogOpening") {
			this.input.onEvent("dialog");
			if (child) child.accepting = false;
		}
		if (method === "Page.windowOpen") {
			this.input.onEvent("popup");
			if (child) child.accepting = false;
		}
		if (child && sessionId && child.announced.has(sessionId)) this.reply(child, { method, sessionId, params });
		// Playwright must receive the context event before its Runtime.enable reply.
		if (method === "Runtime.executionContextCreated" && sessionId) this.complete_runtime(sessionId);
	}

	private complete_runtime(sessionId: string) {
		const session = this.sessions.get(sessionId);
		if (
			!session ||
			![...session.contexts.values()].some(
				(context) =>
					context.isDefault &&
					(session.target.type === "worker" ||
						(session.mainFrameId !== undefined && context.frameId === session.mainFrameId)),
			)
		)
			return;
		for (const [id, request] of this.pending)
			if (request.method === "Runtime.enable" && request.sessionId === sessionId) {
				request.runtimeReady = true;
				this.complete(id, request);
			}
	}

	private async drain(child: Child, deadline: number) {
		while ([...this.pending.values()].some((request) => request.child === child)) {
			if (this.closed || Date.now() >= deadline) {
				this.fail_child(child, "drain_timeout");
				break;
			}
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(
					() => {
						child.waiters.delete(wake);
						resolve();
					},
					Math.max(0, deadline - Date.now()),
				);
				child.waiters.add(wake);
			});
		}
	}

	private async finish(child: Child, deadline: number) {
		await this.drain(child, deadline);
		if (!this.closed && Date.now() < deadline) {
			for (const [sessionId] of this.sessions) {
				for (const identifier of child.scripts.get(sessionId) ?? [])
					this.send(child, sessionId, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
				for (const name of child.bindings.get(sessionId) ?? [])
					this.send(child, sessionId, "Runtime.removeBinding", { name });
				for (const params of child.keys.get(sessionId)?.values() ?? [])
					this.send(child, sessionId, "Input.dispatchKeyEvent", params);
				for (const params of child.buttons.get(sessionId)?.values() ?? [])
					this.send(child, sessionId, "Input.dispatchMouseEvent", params);
				if (this.pending.size >= 64) await this.drain(child, deadline);
			}
			await this.drain(child, deadline);
		}
		for (const [id, request] of this.pending)
			if (request.child === child) {
				if (request.timer) clearTimeout(request.timer);
				this.pending.delete(id);
			}
		child.ended = true;
		clearTimeout(child.timer);
		try {
			child.socket.close(1000, "command ended");
		} catch {
			/* Already closed. */
		}
		if (this.child === child) this.child = null;
		if (child.reason) {
			this.closed = true;
			try {
				this.input.socket.close(1000, "connection ended");
			} catch {
				/* Already closed. */
			}
		}
		return { safe: child.reason === null, reason: child.reason };
	}

	get url() {
		return this.sessions.get(this.input.sessionId)?.target.url;
	}

	close() {
		this.socket_lost();
		try {
			this.input.socket.close(1000, "connection ended");
		} catch {
			/* Already closed. */
		}
	}
}
