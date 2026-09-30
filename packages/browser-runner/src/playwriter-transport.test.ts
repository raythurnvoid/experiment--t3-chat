import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaywriterTargetInventory, PlaywriterTransport } from "./playwriter-transport";

class Socket extends EventTarget {
	peer: Socket | null = null;
	readyState = 1;
	received: string[] = [];
	accept() {}

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

class SocketPair {
	0: Socket;
	1: Socket;
	constructor() {
		[this[0], this[1]] = socket_pair();
	}
}

function messages(socket: Socket) {
	return socket.received.map((value) => JSON.parse(value) as Record<string, unknown>);
}

function commands(socket: Socket) {
	return messages(socket)
		.filter((value) => value.method === "forwardCDPCommand")
		.map((value) => ({
			id: Number(value.id),
			...(value.params as { method: string; sessionId: string; params: Record<string, unknown> }),
		}));
}

const TARGET = {
	targetId: "assigned-page",
	type: "page",
	title: "Fixture",
	url: "https://fixture.test/",
	browserContextId: "native-context",
	ignoredSecret: "never copied",
};
const FRAME_TARGET = { targetId: "iframe-target", type: "iframe", title: "Frame", url: "https://frame.test/" };
const WORKER_TARGET = {
	targetId: "worker-target",
	type: "worker",
	title: "Worker",
	url: "https://frame.test/worker.js",
};
const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xf6sAAAAASUVORK5CYII=";
const CALLBACKS = { onUnsafe: () => {}, onEvent: () => {}, onNavigation: () => {}, canSendInput: () => true };

function attachment_event(
	sessionId: string,
	targetInfo: Record<string, unknown>,
	parent: string | null = "page-session",
	waitingForDebugger = false,
) {
	return JSON.stringify({
		method: "forwardCDPEvent",
		params: {
			method: "Target.attachedToTarget",
			...(parent ? { sessionId: parent } : {}),
			params: { sessionId, targetInfo, waitingForDebugger },
		},
	});
}

function make_transport(
	options: {
		autoReply?: boolean;
		runtimeContext?: boolean;
		initialEvents?: readonly string[];
		holdInput?: boolean;
	} = {},
) {
	const [socket, extension] = socket_pair();
	const onUnsafe = vi.fn();
	const onEvent = vi.fn();
	const transport = new PlaywriterTransport({
		...CALLBACKS,
		socket: socket as unknown as WebSocket,
		targetId: "assigned-page",
		sessionId: "page-session",
		targetInfo: TARGET,
		initialEvents: options.initialEvents,
		onUnsafe,
		onEvent,
	});
	const emit = (method: string, params: unknown, sessionId: string | null = "page-session") =>
		extension.send(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: { method, params, ...(sessionId ? { sessionId } : {}) },
			}),
		);
	const reply = (id: number, result: unknown = {}) => extension.send(JSON.stringify({ id, result }));
	if (options.autoReply !== false)
		extension.addEventListener("message", () => {
			const request = commands(extension).at(-1);
			if (!request) return;
			if (options.holdInput && request.method.startsWith("Input.")) return;
			if (request.method === "Runtime.enable" && options.runtimeContext !== false)
				emit(
					"Runtime.executionContextCreated",
					{
						context: {
							id: 1,
							name: "",
							origin: "https://fixture.test",
							auxData: { isDefault: true, frameId: "main-frame" },
						},
					},
					request.sessionId,
				);
			const result =
				request.method === "Page.getFrameTree"
					? { frameTree: { frame: { id: "main-frame" }, childFrames: [{ frame: { id: "inner-frame" } }] } }
					: request.method === "Page.createIsolatedWorld"
						? { executionContextId: 9 }
						: request.method === "Page.addScriptToEvaluateOnNewDocument"
							? { identifier: `script-${request.id}` }
							: request.method === "Page.captureScreenshot"
								? { data: PNG_DATA }
								: {};
			reply(request.id, result);
		});
	const create_child = (guardBinding?: string) => {
		const connection = transport.create_child({ deadline: Date.now() + 30_000, guardBinding });
		const child = connection.webSocket as unknown as Socket;
		let id = 0;
		const send = (
			method: string,
			params: unknown = {},
			sessionId: string | null = "page-session",
			requestId?: number,
		) => {
			const nextId = requestId ?? ++id;
			child.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
			return nextId;
		};
		const start = () =>
			send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, null);
		return { connection, child, send, start };
	};
	return { transport, socket, extension, onUnsafe, onEvent, emit, reply, create_child };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
	vi.stubGlobal("WebSocketPair", SocketPair);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("PlaywriterTargetInventory", () => {
	it("hands a worker before frame before root to the real transport in parent order", async () => {
		const inventory = new PlaywriterTargetInventory();
		expect(inventory.consume(attachment_event("worker-session", WORKER_TARGET, "iframe-session"))).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(inventory.consume(attachment_event("iframe-session", FRAME_TARGET))).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(inventory.consume(attachment_event("page-session", TARGET, null))).toBe(true);
		expect(inventory.ready).toBe(true);
		const snapshot = inventory.snapshot({ targetId: "assigned-page", sessionId: "page-session" });
		expect(snapshot.targetInfo).not.toHaveProperty("ignoredSecret");
		const [socket, extension] = socket_pair();
		extension.addEventListener("message", () => {
			const request = commands(extension).at(-1);
			if (request) extension.send(JSON.stringify({ id: request.id, result: {} }));
		});
		const transport = new PlaywriterTransport({ ...CALLBACKS, socket: socket as unknown as WebSocket, ...snapshot });
		const connection = transport.create_child({ deadline: Date.now() + 30_000 });
		const child = connection.webSocket as unknown as Socket;
		child.send(
			JSON.stringify({
				id: 1,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			}),
		);
		child.send(
			JSON.stringify({
				id: 2,
				method: "Target.setAutoAttach",
				sessionId: "iframe-session",
				params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			}),
		);
		expect(
			messages(child)
				.filter((message) => message.method === "Target.attachedToTarget")
				.map((message) => (message.params as { sessionId: string }).sessionId),
			"The handoff must announce all three sessions in parent order.",
		).toEqual(["page-session", "iframe-session", "worker-session"]);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		transport.close();
	});

	it("removes descendants when the detached parent was never announced", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("worker-session", WORKER_TARGET, "missing-frame"));
		inventory.consume(
			attachment_event("nested-worker", { ...WORKER_TARGET, targetId: "nested-worker-target" }, "worker-session"),
		);
		expect(inventory.ready).toBe(false);
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Target.detachedFromTarget", params: { sessionId: "missing-frame" } },
				}),
			),
		).toBe(true);
		inventory.consume(attachment_event("page-session", TARGET, null));
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toHaveLength(1);
	});

	it("removes a root subtree while keeping another root private", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		inventory.consume(attachment_event("worker-session", WORKER_TARGET, "iframe-session"));
		inventory.consume(attachment_event("peer-session", { ...TARGET, targetId: "peer-target" }, null));
		inventory.consume(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: {
					method: "Target.detachedFromTarget",
					params: { sessionId: "page-session", targetId: TARGET.targetId },
				},
			}),
		);
		expect(inventory.ready).toBe(true);
		expect(inventory.roots.map((root) => root.sessionId)).toEqual(["peer-session"]);
		expect(() => inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" })).toThrow(
			"Invalid confirmed",
		);
		expect(inventory.snapshot({ targetId: "peer-target", sessionId: "peer-session" }).initialEvents).toHaveLength(1);
		inventory.consume(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: { method: "Target.detachedFromTarget", params: { sessionId: "peer-session" } },
			}),
		);
		expect(inventory.ready).toBe(false);
		expect(inventory.roots).toEqual([]);
	});

	it("replaces valid repeats with current native title and URL", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		const root = { ...TARGET, title: "Current", url: "https://fixture.test/current" };
		const frame = { ...FRAME_TARGET, title: "Current frame", url: "https://frame.test/current" };
		expect(inventory.consume(attachment_event("page-session", root, null))).toBe(true);
		expect(inventory.consume(attachment_event("iframe-session", frame))).toBe(true);
		const snapshot = inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" });
		expect(snapshot.targetInfo).toMatchObject({ title: root.title, url: root.url });
		expect(snapshot.initialEvents).toEqual([
			attachment_event("page-session", root, null),
			attachment_event("iframe-session", frame),
		]);
	});

	it.each([
		["target", { ...FRAME_TARGET, targetId: "changed-target" }, "page-session"],
		["type", { ...FRAME_TARGET, type: "worker" }, "page-session"],
		["unsupported type", { ...FRAME_TARGET, type: "service_worker" }, "page-session"],
		["context", { ...FRAME_TARGET, browserContextId: "changed-context" }, "page-session"],
		["parent", FRAME_TARGET, "changed-parent"],
	])("makes changed %s identity unusable", (_name, targetInfo, parent) => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		expect(
			inventory.consume(attachment_event("iframe-session", targetInfo as Record<string, unknown>, String(parent))),
		).toBe(false);
		expect(inventory.ready).toBe(false);
		expect(inventory.roots).toEqual([]);
		expect(inventory.consume(attachment_event("page-session", TARGET, null))).toBe(false);
	});

	it("rejects a reused target under a second session", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		expect(inventory.consume(attachment_event("new-page-session", TARGET, null))).toBe(false);
	});

	it.each([
		["URL", { ...FRAME_TARGET, url: 17 }],
		["type", { ...FRAME_TARGET, type: ["iframe"] }],
		["title", { ...FRAME_TARGET, title: "x".repeat(8193) }],
		["context", { ...FRAME_TARGET, browserContextId: "" }],
		["parent frame", { ...FRAME_TARGET, parentFrameId: 17 }],
		["attached", { ...FRAME_TARGET, attached: "true" }],
		["opener access", { ...FRAME_TARGET, canAccessOpener: 1 }],
	])("rejects malformed supported target %s", (_name, targetInfo) => {
		const inventory = new PlaywriterTargetInventory();
		expect(inventory.consume(attachment_event("iframe-session", targetInfo))).toBe(false);
		expect(inventory.ready).toBe(false);
	});

	it.each([
		{ targetInfo: FRAME_TARGET, waitingForDebugger: false },
		{ sessionId: "iframe-session", targetInfo: FRAME_TARGET },
		{ sessionId: "iframe-session", targetInfo: FRAME_TARGET, waitingForDebugger: 1 },
	])("rejects malformed attachment fields %#", (params) => {
		const inventory = new PlaywriterTargetInventory();
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Target.attachedToTarget", sessionId: "page-session", params },
				}),
			),
		).toBe(false);
	});

	it("updates targets by target ID without adopting event ancestry", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		const targetInfo = { ...FRAME_TARGET, title: "Changed", url: "https://frame.test/changed" };
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Target.targetInfoChanged", sessionId: "unrelated-parent", params: { targetInfo } },
				}),
			),
		).toBe(true);
		const last = JSON.parse(
			inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents[1],
		) as {
			params: { sessionId: string; params: { targetInfo: Record<string, unknown> } };
		};
		expect(last.params.sessionId).toBe("page-session");
		expect(last.params.params.targetInfo).toEqual(targetInfo);
	});

	it.each([
		{ ...FRAME_TARGET, type: "worker" },
		{ ...FRAME_TARGET, browserContextId: "changed-context" },
	])("rejects identity changes in known target updates %#", (targetInfo) => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Target.targetInfoChanged", params: { targetInfo } },
				}),
			),
		).toBe(false);
	});

	it("ignores an unseen target update and uses the later full attachment", () => {
		const inventory = new PlaywriterTargetInventory();
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: {
						method: "Target.targetInfoChanged",
						params: { targetInfo: { targetId: FRAME_TARGET.targetId, url: 17 } },
					},
				}),
			),
		).toBe(true);
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents[1]).toBe(
			attachment_event("iframe-session", FRAME_TARGET),
		);
	});

	it.each([
		[attachment_event("iframe-session", FRAME_TARGET, "missing-parent")],
		[
			attachment_event("iframe-session", FRAME_TARGET, "worker-session"),
			attachment_event("worker-session", WORKER_TARGET, "iframe-session"),
		],
		[attachment_event("iframe-session", FRAME_TARGET, null)],
	])("blocks unresolved or cyclic links %#", (...packets) => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		for (const packet of packets) expect(inventory.consume(packet)).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(() => inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" })).toThrow("not ready");
	});

	it("selects only the exact root and its real descendants", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		inventory.consume(attachment_event("iframe-session", FRAME_TARGET));
		inventory.consume(
			attachment_event("peer-session", { ...TARGET, targetId: "peer-target", url: "https://private-peer.test/" }, null),
		);
		inventory.consume(
			attachment_event(
				"peer-frame",
				{ ...FRAME_TARGET, targetId: "peer-frame-target", browserContextId: TARGET.browserContextId },
				"peer-session",
			),
		);
		const snapshot = inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" });
		expect(snapshot.initialEvents).toHaveLength(2);
		expect(snapshot.initialEvents.join("")).not.toContain("private-peer");
		expect(snapshot.initialEvents.join("")).not.toContain("peer-frame");
		expect(() => inventory.snapshot({ targetId: TARGET.targetId, sessionId: "peer-session" })).toThrow(
			"Invalid confirmed",
		);
		expect(() => inventory.snapshot({ targetId: "peer-target", sessionId: "page-session" })).toThrow(
			"Invalid confirmed",
		);
		expect(() => inventory.snapshot({ targetId: FRAME_TARGET.targetId, sessionId: "iframe-session" })).toThrow(
			"Invalid confirmed",
		);
	});

	it("keeps native missing-context fields and separates a new socket inventory", () => {
		const inventory = new PlaywriterTargetInventory();
		const { browserContextId: _context, ...target } = TARGET;
		inventory.consume(attachment_event("page-session", target, null));
		expect(inventory.roots[0].targetInfo).not.toHaveProperty("browserContextId");
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents[0]).toBe(
			attachment_event("page-session", target, null),
		);
		const next = new PlaywriterTargetInventory();
		expect(next.ready).toBe(false);
		expect(next.roots).toEqual([]);
	});

	it("preserves a native debugger wait for the transport to refuse", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		const waited = attachment_event("worker-session", WORKER_TARGET, "page-session", true);
		inventory.consume(waited);
		const snapshot = inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" });
		expect(snapshot.initialEvents).toContain(waited);
		const [socket, extension] = socket_pair();
		expect(
			() => new PlaywriterTransport({ ...CALLBACKS, socket: socket as unknown as WebSocket, ...snapshot }),
		).toThrow("Invalid browser attachment snapshot");
		expect(socket.readyState).toBe(3);
		expect(commands(extension)).toEqual([]);
	});

	it("counts unresolved children and reclaims detached session slots", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		for (let index = 0; index < 63; index++)
			expect(
				inventory.consume(
					attachment_event(
						`worker-${index}`,
						{ ...WORKER_TARGET, targetId: `worker-target-${index}` },
						"missing-parent",
					),
				),
			).toBe(true);
		inventory.consume(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: { method: "Target.detachedFromTarget", params: { sessionId: "missing-parent" } },
			}),
		);
		for (let index = 0; index < 63; index++)
			expect(
				inventory.consume(attachment_event(`frame-${index}`, { ...FRAME_TARGET, targetId: `frame-target-${index}` })),
			).toBe(true);
		expect(inventory.ready).toBe(true);
		expect(inventory.consume(attachment_event("overflow", { ...FRAME_TARGET, targetId: "overflow-target" }))).toBe(
			false,
		);
	});

	it("replaces packet costs and reclaims bytes on updates and detaches", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		const large = attachment_event("iframe-session", { ...FRAME_TARGET, ignored: "x".repeat(600_000) });
		for (let index = 0; index < 4; index++) expect(inventory.consume(large)).toBe(true);
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Target.targetInfoChanged", params: { targetInfo: FRAME_TARGET } },
				}),
			),
		).toBe(true);
		expect(
			inventory.consume(
				attachment_event("worker-session", { ...WORKER_TARGET, ignored: "x".repeat(800_000) }, "iframe-session"),
			),
		).toBe(true);
		inventory.consume(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: { method: "Target.detachedFromTarget", params: { sessionId: "worker-session" } },
			}),
		);
		expect(
			inventory.consume(
				attachment_event("worker-session", { ...WORKER_TARGET, ignored: "x".repeat(800_000) }, "iframe-session"),
			),
		).toBe(true);
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toHaveLength(3);
	});

	it("bounds the total current packet bytes at exactly one MiB", () => {
		const inventory = new PlaywriterTargetInventory();
		const root = attachment_event("page-session", TARGET, null);
		const empty = attachment_event("iframe-session", { ...FRAME_TARGET, ignored: "" });
		const padding = 1_048_576 - new TextEncoder().encode(root).byteLength - new TextEncoder().encode(empty).byteLength;
		inventory.consume(root);
		expect(
			inventory.consume(attachment_event("iframe-session", { ...FRAME_TARGET, ignored: "x".repeat(padding) })),
		).toBe(true);
		expect(inventory.ready).toBe(true);
		expect(inventory.consume(attachment_event("worker-session", WORKER_TARGET, "iframe-session"))).toBe(false);
	});

	it("counts UTF-8 attachment bytes and caps physical provider packets", () => {
		const utf8 = new PlaywriterTargetInventory();
		expect(utf8.consume(attachment_event("iframe-session", { ...FRAME_TARGET, ignored: "界".repeat(350_000) }))).toBe(
			false,
		);
		const provider = new PlaywriterTargetInventory();
		expect(provider.consume(JSON.stringify({ method: "hello", ignored: "界".repeat(2_800_000) }))).toBe(false);
		const ascii = new PlaywriterTargetInventory();
		expect(ascii.consume(" ".repeat(8_388_609))).toBe(false);
	});

	it("ignores Runtime history and unsupported targets", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event("page-session", TARGET, null));
		expect(
			inventory.consume(
				JSON.stringify({
					method: "forwardCDPEvent",
					params: {
						method: "Runtime.executionContextCreated",
						sessionId: "page-session",
						params: { context: { id: 17 } },
					},
				}),
			),
		).toBe(true);
		expect(inventory.consume(attachment_event("unsupported", { ...WORKER_TARGET, type: "service_worker" }))).toBe(true);
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toEqual([
			attachment_event("page-session", TARGET, null),
		]);
	});
});

describe("PlaywriterTransport", () => {
	it.each(["complete", "page context", "wrong name", "wrong payload", "no input", "mouse move"])(
		"accepts only an owned final guard witness: %s",
		async (kind) => {
			const fixture = make_transport({ holdInput: true });
			const binding = "__bonobo_guard_command";
			const { connection, send, start } = fixture.create_child(binding);
			start();
			send("Page.getFrameTree");
			fixture.emit("Runtime.executionContextCreated", {
				context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
			});
			send("Page.createIsolatedWorld", { frameId: "main-frame", worldName: "utility" });
			send("Runtime.addBinding", { name: binding, executionContextId: 9 });
			if (kind !== "no input")
				send("Input.dispatchMouseEvent", {
					type: kind === "mouse move" ? "mouseMoved" : "mouseReleased",
					button: "left",
					x: 70,
					y: 50,
				});
			fixture.emit("Runtime.bindingCalled", {
				name: kind === "wrong name" ? "__bonobo_guard_other" : binding,
				executionContextId: kind === "page context" ? 1 : 9,
				payload: kind === "wrong payload" ? "success from the page" : "complete",
			});
			expect(
				connection.outcome().guarded,
				"Only this command's trusted final event in its isolated main-frame world may prove input",
			).toBe(kind === "complete");
			if (kind !== "no input") fixture.reply(commands(fixture.extension).at(-1)!.id);
			expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		},
	);

	it("refuses a guard binding in the page world", async () => {
		const fixture = make_transport();
		const { connection, child, send, start } = fixture.create_child("__bonobo_guard_command");
		start();
		send("Page.getFrameTree");
		fixture.emit("Runtime.executionContextCreated", {
			context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
		});
		const id = send("Runtime.addBinding", { name: "__bonobo_guard_command", executionContextId: 1 });
		expect(messages(child).find((message) => message.id === id)).toHaveProperty("error");
		expect(commands(fixture.extension).some((request) => request.method === "Runtime.addBinding")).toBe(false);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("shows only the confirmed page and scopes auto-attach without debugger waits", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		send("Browser.getVersion", {}, null);
		start();
		send("Target.getTargets", {}, null);
		expect(commands(extension)).toEqual([
			{
				id: 1,
				method: "Target.setAutoAttach",
				sessionId: "page-session",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			},
		]);
		expect(messages(child).find((message) => message.method === "Target.attachedToTarget")).toEqual({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "page-session",
				targetInfo: {
					targetId: "assigned-page",
					type: "page",
					title: "Fixture",
					url: "https://fixture.test/",
					browserContextId: "native-context",
				},
				waitingForDebugger: false,
			},
		});
		expect(messages(child).at(-1)).toMatchObject({ result: { targetInfos: [{ targetId: "assigned-page" }] } });
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("answers setup locally without native window, focus, media, font, or network changes", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		send(
			"Browser.setDownloadBehavior",
			{ behavior: "allowAndName", downloadPath: "/private", eventsEnabled: true },
			null,
		);
		send("Browser.getWindowForTarget");
		send("Browser.setWindowBounds", { windowId: 1, bounds: { width: 1296, height: 854 } });
		send("Browser.getWindowBounds", { windowId: 1 });
		send("Network.enable");
		send("Emulation.setFocusEmulationEnabled", { enabled: true });
		send("Emulation.setEmulatedMedia", { media: "", features: [] });
		send("Page.setFontFamilies", { fontFamilies: { standard: "Times New Roman" } });
		send("Runtime.runIfWaitingForDebugger");
		expect(messages(child).filter((message) => message.error)).toEqual([]);
		expect(messages(child)).toContainEqual(
			expect.objectContaining({ result: { bounds: { width: 1296, height: 854 } } }),
		);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it.each([
		"Browser.close",
		"Target.closeTarget",
		"Target.createTarget",
		"Target.createBrowserContext",
		"Page.bringToFront",
		"Page.startScreencast",
		"Page.handleJavaScriptDialog",
		"Page.setDownloadBehavior",
		"Input.setInterceptDrags",
		"Network.getResponseBody",
		"Fetch.enable",
		"Storage.getCookies",
		"DOM.setFileInputFiles",
		"Target.sendMessageToTarget",
	])("does not forward %s", async (method) => {
		const { extension, create_child } = make_transport();
		const { connection, send, start } = create_child();
		start();
		send(method);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it.each([
		["Page.startScreencast", { format: "jpeg", quality: 50, everyNthFrame: 1 }],
		["Page.stopScreencast", {}],
		["Page.screencastFrameAck", { sessionId: 1 }],
	])("refuses video command %s", async (method, params) => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		const id = send(String(method), params);
		expect(messages(child).at(-1)).toMatchObject({ id, error: { message: "Browser command is not allowed." } });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("delivers the main default context before completing Runtime.enable", async () => {
		const { extension, create_child, reply, emit } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		send("Page.getFrameTree");
		reply(commands(extension).at(-1)!.id, { frameTree: { frame: { id: "main-frame" } } });
		const id = send("Runtime.enable");
		const wireId = commands(extension).at(-1)!.id;
		reply(wireId);
		emit("Runtime.executionContextCreated", {
			context: { id: 2, auxData: { isDefault: true, frameId: "other-frame" } },
		});
		expect(messages(child).find((message) => message.id === id)).toBeUndefined();
		emit("Runtime.executionContextCreated", {
			context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
		});
		expect(
			messages(child)
				.slice(-2)
				.map((message) => message.method ?? message.id),
		).toEqual(["Runtime.executionContextCreated", id]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("waits for the frame tree when its context arrives first", async () => {
		const { extension, create_child, reply, emit } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		const id = send("Runtime.enable");
		reply(commands(extension).at(-1)!.id);
		emit("Runtime.executionContextCreated", {
			context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
		});
		expect(messages(child).find((message) => message.id === id)).toBeUndefined();
		send("Page.getFrameTree");
		reply(commands(extension).at(-1)!.id, { frameTree: { frame: { id: "main-frame" } } });
		expect(messages(child).find((message) => message.id === id)).toMatchObject({ result: {} });
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("fails bounded readiness instead of exposing an unready page", async () => {
		const { transport, create_child, onUnsafe } = make_transport({ runtimeContext: false });
		const { connection, send, start } = create_child();
		start();
		send("Page.getFrameTree");
		send("Runtime.enable");
		await vi.advanceTimersByTimeAsync(3000);
		expect(onUnsafe).toHaveBeenCalledWith("runtime_not_ready");
		const settled = connection.settle(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await settled).toEqual({ safe: false, reason: "runtime_not_ready" });
		expect(() => transport.create_child({ deadline: Date.now() + 30_000 })).toThrow("offline");
	});

	it("uses separate local capture sessions without real attach or detach", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		send("Target.attachToBrowserTarget", {}, null);
		const browserSession = (messages(child).at(-1)?.result as { sessionId: string }).sessionId;
		send("Target.attachToTarget", { targetId: "assigned-page", flatten: true }, browserSession);
		const captureSession = (messages(child).at(-1)?.result as { sessionId: string }).sessionId;
		expect(captureSession).not.toBe("page-session");
		const id = send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, captureSession);
		expect(messages(child).at(-1)).toEqual({ id, sessionId: captureSession, result: { data: PNG_DATA } });
		send("Target.detachFromTarget", { sessionId: captureSession }, browserSession);
		expect(commands(extension).map((request) => request.method)).toEqual([
			"Target.setAutoAttach",
			"Page.captureScreenshot",
		]);
		expect(commands(extension).at(-1)?.sessionId).toBe("page-session");
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("drops oversized screenshot pixels without retiring a safe connection", async () => {
		const { extension, create_child, reply } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		const id = send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
		const bytes = Uint8Array.from(atob(PNG_DATA), (char) => char.charCodeAt(0));
		new DataView(bytes.buffer).setUint32(16, 8193);
		reply(commands(extension).at(-1)!.id, { data: btoa(String.fromCharCode(...bytes)) });
		expect(messages(child).at(-1)).toEqual({
			id,
			sessionId: "page-session",
			error: { code: -32000, message: "Screenshot exceeds the size limit." },
		});
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		const next = create_child();
		expect(await next.connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("drops old replies when the next child uses the same request ID", async () => {
		const { extension, create_child, reply, socket } = make_transport({ autoReply: false });
		const first = create_child();
		first.start();
		reply(commands(extension).at(-1)!.id);
		first.send("Page.enable", {}, "page-session", 10);
		const oldWireId = commands(extension).at(-1)!.id;
		reply(oldWireId);
		expect((await first.connection.settle(1000)).safe).toBe(true);
		expect(socket.readyState).toBe(1);
		const second = create_child();
		second.start();
		reply(commands(extension).at(-1)!.id);
		second.send("Page.enable", {}, "page-session", 10);
		const nextWireId = commands(extension).at(-1)!.id;
		expect(nextWireId).toBeGreaterThan(oldWireId);
		reply(oldWireId);
		expect(messages(second.child).find((message) => message.id === 10)).toBeUndefined();
		reply(nextWireId);
		expect(messages(second.child).find((message) => message.id === 10)).toMatchObject({ result: {} });
		expect((await second.connection.settle(1000)).safe).toBe(true);
	});

	it("cleans only command scripts, bindings, and held input on the live socket", async () => {
		const { extension, create_child, socket } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		send("Page.addScriptToEvaluateOnNewDocument", { source: "", worldName: "utility" });
		send("Runtime.addBinding", { name: "our-binding" });
		send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", modifiers: 0 });
		send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
		child.close();
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		expect(socket.readyState).toBe(1);
		expect(
			commands(extension)
				.slice(-4)
				.map((request) => request.method),
		).toEqual([
			"Page.removeScriptToEvaluateOnNewDocument",
			"Runtime.removeBinding",
			"Input.dispatchKeyEvent",
			"Input.dispatchMouseEvent",
		]);
		expect(commands(extension).every((request) => request.id > 0)).toBe(true);
	});

	it("drains an accepted script after revocation before removing it", async () => {
		const { extension, create_child, reply } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		send("Page.addScriptToEvaluateOnNewDocument", { source: "", worldName: "utility" });
		const scriptId = commands(extension).at(-1)!.id;
		connection.revoke();
		const id = send("Page.enable");
		expect(messages(child).at(-1)).toMatchObject({ id, error: { message: "Browser command is not allowed." } });
		const settled = connection.settle(1000);
		reply(scriptId, { identifier: "our-script" });
		await vi.advanceTimersByTimeAsync(0);
		expect(commands(extension).at(-1)).toMatchObject({
			method: "Page.removeScriptToEvaluateOnNewDocument",
			params: { identifier: "our-script" },
		});
		reply(commands(extension).at(-1)!.id);
		expect(await settled).toEqual({ safe: true, reason: null });
	});

	it("retires our socket when an accepted command cannot drain", async () => {
		const { extension, create_child, reply, socket, transport } = make_transport({ autoReply: false });
		const { connection, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		send("Page.enable");
		const settled = connection.settle(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await settled).toEqual({ safe: false, reason: "drain_timeout" });
		expect(socket.readyState).toBe(3);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach", "Page.enable"]);
		expect(() => transport.create_child({ deadline: Date.now() + 30_000 })).toThrow("offline");
	});

	it("settles socket loss without closing or detaching the native page", async () => {
		const { extension, create_child, reply, transport } = make_transport({ autoReply: false });
		const { connection, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		send("Page.enable");
		extension.close();
		expect(await connection.settle(1000)).toEqual({ safe: false, reason: "connection_lost" });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach", "Page.enable"]);
		expect(() => transport.create_child({ deadline: Date.now() + 30_000 })).toThrow("offline");
	});

	it("keeps descendants scoped and replays existing attachments for a new child", async () => {
		const { create_child, emit } = make_transport();
		const first = create_child();
		first.start();
		emit("Target.attachedToTarget", {
			sessionId: "iframe-session",
			targetInfo: {
				targetId: "iframe-target",
				type: "iframe",
				title: "",
				url: "https://frame.test/",
				parentFrameId: "main-frame",
			},
			waitingForDebugger: false,
		});
		emit(
			"Target.attachedToTarget",
			{
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
				waitingForDebugger: false,
			},
			"iframe-session",
		);
		expect(messages(first.child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(3);
		expect((await first.connection.settle(1000)).safe).toBe(true);
		const second = create_child();
		second.start();
		second.send(
			"Target.setAutoAttach",
			{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			"iframe-session",
		);
		expect(messages(second.child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(3);
		emit("Target.detachedFromTarget", { sessionId: "iframe-session", targetId: "iframe-target" });
		second.send("Runtime.enable", {}, "worker-session");
		expect(messages(second.child).at(-1)?.error).toBeDefined();
		expect((await second.connection.settle(1000)).safe).toBe(true);
	});

	it("starts with existing frames and workers captured before confirmation", async () => {
		const initialEvents = [
			attachment_event("iframe-session", {
				targetId: "iframe-target",
				type: "iframe",
				title: "",
				url: "https://frame.test/",
			}),
			attachment_event(
				"worker-session",
				{ targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
				"iframe-session",
			),
		];
		const { create_child, emit } = make_transport({ initialEvents });
		const first = create_child();
		first.start();
		first.send(
			"Target.setAutoAttach",
			{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			"iframe-session",
		);
		const attached = messages(first.child).filter((message) => message.method === "Target.attachedToTarget");
		expect(attached.map((message) => (message.params as { sessionId: string }).sessionId)).toEqual([
			"page-session",
			"iframe-session",
			"worker-session",
		]);
		emit("Target.attachedToTarget", {
			sessionId: "iframe-session",
			targetInfo: { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" },
			waitingForDebugger: false,
		});
		expect(messages(first.child).filter((message) => message.method === "Target.attachedToTarget")).toEqual(attached);
		expect(await first.connection.settle(1000)).toEqual({ safe: true, reason: null });
		const second = create_child();
		second.start();
		second.send(
			"Target.setAutoAttach",
			{ autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			"iframe-session",
		);
		expect(messages(second.child).filter((message) => message.method === "Target.attachedToTarget")).toEqual(attached);
		expect(await second.connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("keeps frame and context state when a live attachment repeats the snapshot", async () => {
		const target = { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" };
		const { create_child, emit, extension } = make_transport({
			initialEvents: [attachment_event("iframe-session", target)],
		});
		const { connection, child, send, start } = create_child();
		start();
		send("Page.getFrameTree", {}, "iframe-session");
		send("Page.createIsolatedWorld", { frameId: "inner-frame", worldName: "utility" }, "iframe-session");
		emit("Target.attachedToTarget", {
			sessionId: "iframe-session",
			targetInfo: { ...target, title: "Frame" },
			waitingForDebugger: false,
		});
		send("Runtime.evaluate", { expression: "1", contextId: 9 }, "iframe-session");
		send("Page.createIsolatedWorld", { frameId: "inner-frame", worldName: "utility" }, "iframe-session");
		expect(messages(child).filter((message) => message.error)).toEqual([]);
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(2);
		expect(
			commands(extension)
				.slice(-2)
				.map((request) => request.method),
		).toEqual(["Runtime.evaluate", "Page.createIsolatedWorld"]);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it.each([
		["malformed JSON", ["{"]],
		[
			"stale context",
			[
				JSON.stringify({
					method: "forwardCDPEvent",
					params: { method: "Runtime.executionContextsCleared", params: {}, sessionId: "page-session" },
				}),
			],
		],
		[
			"missing parent",
			[
				attachment_event(
					"worker-session",
					{ targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
					"missing-session",
				),
			],
		],
		["unrelated page", [attachment_event("other-page-session", { ...TARGET, targetId: "other-page" }, null)]],
		[
			"debugger wait",
			[
				attachment_event(
					"iframe-session",
					{ targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" },
					"page-session",
					true,
				),
			],
		],
		["too many events", Array.from({ length: 65 }, () => attachment_event("page-session", TARGET, null))],
		["too many bytes", [" ".repeat(1_048_577)]],
		[
			"too many UTF-8 bytes",
			[
				attachment_event("iframe-session", {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
					ignored: "界".repeat(350_000),
				}),
			],
		],
	])("refuses initial attachments with %s", (_name, initialEvents) => {
		expect(() => make_transport({ initialEvents: initialEvents as string[] })).toThrow(
			"Invalid browser attachment snapshot",
		);
	});

	it("closes the socket when a snapshot attachment contains a reply ID", () => {
		const [socket] = socket_pair();
		const event = JSON.parse(
			attachment_event("iframe-session", {
				targetId: "iframe-target",
				type: "iframe",
				title: "",
				url: "https://frame.test/",
			}),
		);
		expect(
			() =>
				new PlaywriterTransport({
					...CALLBACKS,
					socket: socket as unknown as WebSocket,
					targetId: "assigned-page",
					sessionId: "page-session",
					targetInfo: TARGET,
					initialEvents: [JSON.stringify({ ...event, id: 1 })],
				}),
		).toThrow("Invalid browser attachment snapshot");
		expect(socket.readyState).toBe(3);
	});

	it.each([
		["URL", 7],
		["type", ["iframe"]],
	])("fences a malformed live target %s before creating a child", (field, value) => {
		const targetInfo = { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" };
		const { create_child, emit, socket, onUnsafe } = make_transport({
			initialEvents: [attachment_event("iframe-session", targetInfo)],
		});
		emit("Target.attachedToTarget", {
			sessionId: "iframe-session",
			targetInfo: { ...targetInfo, [String(field).toLowerCase()]: value },
			waitingForDebugger: false,
		});
		expect(socket.readyState).toBe(3);
		expect(onUnsafe).toHaveBeenCalledWith("invalid_target");
		expect(() => create_child()).toThrow("offline");
	});

	it("ignores unsupported native target types without losing the checked frame", async () => {
		const { create_child, emit, socket } = make_transport({
			initialEvents: [
				attachment_event("iframe-session", {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				}),
			],
		});
		emit("Target.attachedToTarget", {
			sessionId: "unsupported-session",
			targetInfo: {
				targetId: "unsupported-target",
				type: "service_worker",
				title: "",
				url: "https://frame.test/sw.js",
			},
			waitingForDebugger: false,
		});
		const { connection, child, start } = create_child();
		start();
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(2);
		expect(socket.readyState).toBe(1);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("limits the total snapshot bytes across valid packets", () => {
		const [socket] = socket_pair();
		const targetInfo = {
			targetId: "iframe-target",
			type: "iframe",
			title: "",
			url: "https://frame.test/",
			ignored: "x".repeat(600_000),
		};
		expect(
			() =>
				new PlaywriterTransport({
					...CALLBACKS,
					socket: socket as unknown as WebSocket,
					targetId: "assigned-page",
					sessionId: "page-session",
					targetInfo: TARGET,
					initialEvents: [
						attachment_event("iframe-session", targetInfo),
						attachment_event("iframe-session", targetInfo),
					],
				}),
		).toThrow("Invalid browser attachment snapshot");
		expect(socket.readyState).toBe(3);
	});

	it("fences root loss before admitting the first child", () => {
		const { create_child, emit, socket, onEvent } = make_transport();
		emit("Target.detachedFromTarget", { sessionId: "page-session", targetId: "assigned-page" }, null);
		expect(socket.readyState).toBe(3);
		expect(onEvent).toHaveBeenCalledWith("target_lost");
		expect(() => create_child()).toThrow("offline");
	});

	it.each([
		["target", { targetId: "different-target", type: "iframe", title: "", url: "https://frame.test/" }, "page-session"],
		["type", { targetId: "iframe-target", type: "worker", title: "", url: "https://frame.test/" }, "page-session"],
		["parent", { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" }, "other-parent"],
	])("fences changed %s before a child exists", (_name, targetInfo, parent) => {
		const { create_child, emit, socket, onUnsafe } = make_transport({
			initialEvents: [
				attachment_event("iframe-session", {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				}),
			],
		});
		emit(
			"Target.attachedToTarget",
			{ sessionId: "iframe-session", targetInfo, waitingForDebugger: false },
			String(parent),
		);
		expect(socket.readyState).toBe(3);
		expect(onUnsafe).toHaveBeenCalledWith("target_changed");
		expect(() => create_child()).toThrow("offline");
	});

	it("removes a detached subtree before admitting the first child", async () => {
		const { create_child, emit } = make_transport({
			initialEvents: [
				attachment_event("iframe-session", {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				}),
				attachment_event(
					"worker-session",
					{ targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
					"iframe-session",
				),
			],
		});
		emit("Target.detachedFromTarget", { sessionId: "iframe-session", targetId: "iframe-target" });
		const { connection, child, send, start } = create_child();
		start();
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(1);
		send("Runtime.enable", {}, "worker-session");
		expect(messages(child).at(-1)?.error).toBeDefined();
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("ignores late events from a closed socket and keeps reconnect inventory separate", async () => {
		const old = make_transport();
		old.transport.close();
		old.socket.dispatchEvent(
			new MessageEvent("message", {
				data: attachment_event("iframe-session", {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				}),
			}),
		);
		expect(() => old.create_child()).toThrow("offline");
		const { create_child } = make_transport();
		const { connection, child, start } = create_child();
		start();
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(1);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("reports native dialogs and quarantines popups without closing them", async () => {
		const { create_child, emit, onEvent, extension } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		emit("Page.javascriptDialogOpening", {
			type: "alert",
			message: "Fixture",
			defaultPrompt: "",
			url: "https://fixture.test/",
		});
		send("Page.handleJavaScriptDialog", { accept: false });
		emit(
			"Target.attachedToTarget",
			{ sessionId: "popup-session", targetInfo: { ...TARGET, targetId: "popup-target" }, waitingForDebugger: false },
			null,
		);
		expect(onEvent.mock.calls.map(([reason]) => reason)).toEqual(["dialog", "popup"]);
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(1);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("does not resume an observed debugger wait", async () => {
		const { create_child, emit, extension, onEvent } = make_transport();
		const { connection, start } = create_child();
		start();
		emit("Target.attachedToTarget", {
			sessionId: "worker-session",
			targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://fixture.test/worker.js" },
			waitingForDebugger: true,
		});
		expect(onEvent).toHaveBeenCalledWith("debugger_conflict");
		expect(await connection.settle(1000)).toEqual({ safe: false, reason: "debugger_conflict" });
		expect(commands(extension).some((request) => request.method === "Runtime.runIfWaitingForDebugger")).toBe(false);
	});

	it("drops unsolicited Network events and translates string errors", async () => {
		const { extension, create_child } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		extension.send(JSON.stringify({ id: commands(extension).at(-1)!.id, result: {} }));
		extension.send(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: {
					sessionId: "page-session",
					method: "Network.requestWillBeSent",
					params: { request: { headers: { Cookie: "secret" } } },
				},
			}),
		);
		const id = send("Page.enable");
		extension.send(JSON.stringify({ id: commands(extension).at(-1)!.id, error: "A secret URL in an upstream error" }));
		expect(messages(child).at(-1)).toEqual({
			id,
			sessionId: "page-session",
			error: { code: -32000, message: "Remote browser command failed." },
		});
		expect(child.received.join("")).not.toContain("secret");
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("drops unsolicited video frames while page commands still work", async () => {
		const { extension, create_child, emit, onUnsafe } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		emit("Page.screencastFrame", { data: "private screencast image", sessionId: 1, metadata: { timestamp: 1 } });
		emit("Page.screencastVisibilityChanged", { visible: true });
		const id = send("Page.enable");
		expect(child.received.join("")).not.toContain("private screencast image");
		expect(messages(child).some((message) => String(message.method).startsWith("Page.screencast"))).toBe(false);
		expect(messages(child).at(-1)).toEqual({ id, sessionId: "page-session", result: {} });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach", "Page.enable"]);
		expect(onUnsafe).not.toHaveBeenCalled();
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("rejects clipped screenshots and invalid parameter scope before dispatch", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		send("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: false,
			clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
		});
		send("Runtime.evaluate", { expression: "1", contextId: 99 });
		send("Page.navigate", { url: "file:///private" });
		send("Browser.setWindowBounds", { windowId: 99, bounds: { width: 100, height: 100 } });
		send("Target.attachToTarget", { targetId: "other-page", flatten: true }, null);
		expect(messages(child).filter((message) => message.error).length).toBe(5);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("refuses overlapping children and invalid command deadlines", async () => {
		const { transport, create_child } = make_transport();
		expect(() => transport.create_child({ deadline: Date.now() - 1 })).toThrow("deadline");
		expect(() => transport.create_child({ deadline: Date.now() + 60_000 })).toThrow("deadline");
		const { connection } = create_child();
		expect(() => create_child()).toThrow("busy");
		expect((await connection.settle(1000)).safe).toBe(true);
		transport.close();
		expect(() => create_child()).toThrow("offline");
	});
});
