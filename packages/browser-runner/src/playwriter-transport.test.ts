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
const CALLBACKS = {
	onUnsafe: () => {},
	onEvent: () => {},
	onNavigation: () => {},
	canSendInput: () => true,
	blockedHosts: (): string[] => [],
};

function attachment_event(args: {
	sessionId: string;
	targetInfo: Record<string, unknown>;
	parent?: string | null;
	waitingForDebugger?: boolean;
}) {
	const { sessionId, targetInfo, parent = "page-session", waitingForDebugger = false } = args;

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
		blockedHosts?: string[];
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
		blockedHosts: () => options.blockedHosts ?? [],
		onUnsafe,
		onEvent,
	});
	const emit = (args: { method: string; params: unknown; sessionId?: string | null }) => {
		const { method, params, sessionId = "page-session" } = args;

		return extension.send(
			JSON.stringify({
				method: "forwardCDPEvent",
				params: { method, params, ...(sessionId ? { sessionId } : {}) },
			}),
		);
	};
	const reply = (id: number, result: unknown = {}) => extension.send(JSON.stringify({ id, result }));
	if (options.autoReply !== false)
		extension.addEventListener("message", () => {
			const request = commands(extension).at(-1);
			if (!request) return;
			if (request.method === "Runtime.enable" && options.runtimeContext !== false)
				emit({
					method: "Runtime.executionContextCreated",
					params: {
						context: {
							id: 1,
							name: "",
							origin: "https://fixture.test",
							auxData: { isDefault: true, frameId: "main-frame" },
						},
					},
					sessionId: request.sessionId,
				});
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
	const create_child = () => {
		const connection = transport.create_child({ deadline: Date.now() + 30_000 });
		const child = connection.webSocket as unknown as Socket;
		let id = 0;
		const send = (args: { method: string; params?: unknown; sessionId?: string | null; requestId?: number }) => {
			const { method, params = {}, sessionId = "page-session", requestId } = args;

			const nextId = requestId ?? ++id;
			child.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
			return nextId;
		};
		const start = () =>
			send({
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
				sessionId: null,
			});
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
		expect(
			inventory.consume(
				attachment_event({ sessionId: "worker-session", targetInfo: WORKER_TARGET, parent: "iframe-session" }),
			),
		).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }))).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }))).toBe(
			true,
		);
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
		inventory.consume(
			attachment_event({ sessionId: "worker-session", targetInfo: WORKER_TARGET, parent: "missing-frame" }),
		);
		inventory.consume(
			attachment_event({
				sessionId: "nested-worker",
				targetInfo: { ...WORKER_TARGET, targetId: "nested-worker-target" },
				parent: "worker-session",
			}),
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toHaveLength(1);
	});

	it("removes a root subtree while keeping another root private", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
		inventory.consume(
			attachment_event({ sessionId: "worker-session", targetInfo: WORKER_TARGET, parent: "iframe-session" }),
		);
		inventory.consume(
			attachment_event({ sessionId: "peer-session", targetInfo: { ...TARGET, targetId: "peer-target" }, parent: null }),
		);
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
		const root = { ...TARGET, title: "Current", url: "https://fixture.test/current" };
		const frame = { ...FRAME_TARGET, title: "Current frame", url: "https://frame.test/current" };
		expect(inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: root, parent: null }))).toBe(
			true,
		);
		expect(inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: frame }))).toBe(true);
		const snapshot = inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" });
		expect(snapshot.targetInfo).toMatchObject({ title: root.title, url: root.url });
		expect(snapshot.initialEvents).toEqual([
			attachment_event({ sessionId: "page-session", targetInfo: root, parent: null }),
			attachment_event({ sessionId: "iframe-session", targetInfo: frame }),
		]);
	});

	it.each([
		["target", { ...FRAME_TARGET, targetId: "changed-target" }, "page-session"],
		["type", { ...FRAME_TARGET, type: "worker" }, "page-session"],
		["unsupported type", { ...FRAME_TARGET, type: "service_worker" }, "page-session"],
		["context", { ...FRAME_TARGET, browserContextId: "changed-context" }, "page-session"],
		["parent", FRAME_TARGET, "changed-parent"],
	])("makes changed %s identity unusable", (args: { _name: any; targetInfo: any; parent: any }) => {
		const { targetInfo, parent } = args;

		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
		expect(
			inventory.consume(
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: targetInfo as Record<string, unknown>,
					parent: String(parent),
				}),
			),
		).toBe(false);
		expect(inventory.ready).toBe(false);
		expect(inventory.roots).toEqual([]);
		expect(inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }))).toBe(
			false,
		);
	});

	it("rejects a reused target under a second session", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		expect(
			inventory.consume(attachment_event({ sessionId: "new-page-session", targetInfo: TARGET, parent: null })),
		).toBe(false);
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
		expect(inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo }))).toBe(false);
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
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
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents[1]).toBe(
			attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }),
		);
	});

	it.each([
		[attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET, parent: "missing-parent" })],
		[
			attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET, parent: "worker-session" }),
			attachment_event({ sessionId: "worker-session", targetInfo: WORKER_TARGET, parent: "iframe-session" }),
		],
		[attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET, parent: null })],
	])("blocks unresolved or cyclic links %#", (...packets) => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		for (const packet of packets) expect(inventory.consume(packet)).toBe(true);
		expect(inventory.ready).toBe(false);
		expect(() => inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" })).toThrow("not ready");
	});

	it("selects only the exact root and its real descendants", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		inventory.consume(attachment_event({ sessionId: "iframe-session", targetInfo: FRAME_TARGET }));
		inventory.consume(
			attachment_event({
				sessionId: "peer-session",
				targetInfo: { ...TARGET, targetId: "peer-target", url: "https://private-peer.test/" },
				parent: null,
			}),
		);
		inventory.consume(
			attachment_event({
				sessionId: "peer-frame",
				targetInfo: { ...FRAME_TARGET, targetId: "peer-frame-target", browserContextId: TARGET.browserContextId },
				parent: "peer-session",
			}),
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: target, parent: null }));
		expect(inventory.roots[0].targetInfo).not.toHaveProperty("browserContextId");
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents[0]).toBe(
			attachment_event({ sessionId: "page-session", targetInfo: target, parent: null }),
		);
		const next = new PlaywriterTargetInventory();
		expect(next.ready).toBe(false);
		expect(next.roots).toEqual([]);
	});

	it("preserves a native debugger wait for the transport to refuse", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		const waited = attachment_event({
			sessionId: "worker-session",
			targetInfo: WORKER_TARGET,
			parent: "page-session",
			waitingForDebugger: true,
		});
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
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		for (let index = 0; index < 63; index++)
			expect(
				inventory.consume(
					attachment_event({
						sessionId: `worker-${index}`,
						targetInfo: { ...WORKER_TARGET, targetId: `worker-target-${index}` },
						parent: "missing-parent",
					}),
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
				inventory.consume(
					attachment_event({
						sessionId: `frame-${index}`,
						targetInfo: { ...FRAME_TARGET, targetId: `frame-target-${index}` },
					}),
				),
			).toBe(true);
		expect(inventory.ready).toBe(true);
		expect(
			inventory.consume(
				attachment_event({ sessionId: "overflow", targetInfo: { ...FRAME_TARGET, targetId: "overflow-target" } }),
			),
		).toBe(false);
	});

	it("replaces packet costs and reclaims bytes on updates and detaches", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
		const large = attachment_event({
			sessionId: "iframe-session",
			targetInfo: { ...FRAME_TARGET, ignored: "x".repeat(600_000) },
		});
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
				attachment_event({
					sessionId: "worker-session",
					targetInfo: { ...WORKER_TARGET, ignored: "x".repeat(800_000) },
					parent: "iframe-session",
				}),
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
				attachment_event({
					sessionId: "worker-session",
					targetInfo: { ...WORKER_TARGET, ignored: "x".repeat(800_000) },
					parent: "iframe-session",
				}),
			),
		).toBe(true);
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toHaveLength(3);
	});

	it("bounds the total current packet bytes at exactly one MiB", () => {
		const inventory = new PlaywriterTargetInventory();
		const root = attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null });
		const empty = attachment_event({ sessionId: "iframe-session", targetInfo: { ...FRAME_TARGET, ignored: "" } });
		const padding = 1_048_576 - new TextEncoder().encode(root).byteLength - new TextEncoder().encode(empty).byteLength;
		inventory.consume(root);
		expect(
			inventory.consume(
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: { ...FRAME_TARGET, ignored: "x".repeat(padding) },
				}),
			),
		).toBe(true);
		expect(inventory.ready).toBe(true);
		expect(
			inventory.consume(
				attachment_event({ sessionId: "worker-session", targetInfo: WORKER_TARGET, parent: "iframe-session" }),
			),
		).toBe(false);
	});

	it("counts UTF-8 attachment bytes and caps physical provider packets", () => {
		const utf8 = new PlaywriterTargetInventory();
		expect(
			utf8.consume(
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: { ...FRAME_TARGET, ignored: "界".repeat(350_000) },
				}),
			),
		).toBe(false);
		const provider = new PlaywriterTargetInventory();
		expect(provider.consume(JSON.stringify({ method: "hello", ignored: "界".repeat(2_800_000) }))).toBe(false);
		const ascii = new PlaywriterTargetInventory();
		expect(ascii.consume(" ".repeat(8_388_609))).toBe(false);
	});

	it("ignores Runtime history and unsupported targets", () => {
		const inventory = new PlaywriterTargetInventory();
		inventory.consume(attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }));
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
		expect(
			inventory.consume(
				attachment_event({ sessionId: "unsupported", targetInfo: { ...WORKER_TARGET, type: "service_worker" } }),
			),
		).toBe(true);
		expect(inventory.snapshot({ targetId: TARGET.targetId, sessionId: "page-session" }).initialEvents).toEqual([
			attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }),
		]);
	});
});

describe("PlaywriterTransport", () => {
	it("refuses a binding for one execution context", async () => {
		const fixture = make_transport();
		const { connection, child, send, start } = fixture.create_child();
		start();
		send({ method: "Page.getFrameTree" });
		fixture.emit({
			method: "Runtime.executionContextCreated",
			params: {
				context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
			},
		});
		const id = send({ method: "Runtime.addBinding", params: { name: "__page_binding", executionContextId: 1 } });
		expect(messages(child).find((message) => message.id === id)).toHaveProperty("error");
		expect(commands(fixture.extension).some((request) => request.method === "Runtime.addBinding")).toBe(false);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("shows only the confirmed page and scopes auto-attach without debugger waits", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		send({ method: "Browser.getVersion", params: {}, sessionId: null });
		start();
		send({ method: "Target.getTargets", params: {}, sessionId: null });
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
		send({
			method: "Browser.setDownloadBehavior",
			params: { behavior: "allowAndName", downloadPath: "/private", eventsEnabled: true },
			sessionId: null,
		});
		send({ method: "Browser.getWindowForTarget" });
		send({ method: "Browser.setWindowBounds", params: { windowId: 1, bounds: { width: 1296, height: 854 } } });
		send({ method: "Browser.getWindowBounds", params: { windowId: 1 } });
		send({ method: "Network.enable" });
		send({ method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
		send({ method: "Emulation.setEmulatedMedia", params: { media: "", features: [] } });
		send({ method: "Page.setFontFamilies", params: { fontFamilies: { standard: "Times New Roman" } } });
		send({ method: "Runtime.runIfWaitingForDebugger" });
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
		send({ method });
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
		const id = send({ method: String(method), params });
		expect(messages(child).at(-1)).toMatchObject({ id, error: { message: "Browser command is not allowed." } });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("delivers the main default context before completing Runtime.enable", async () => {
		const { extension, create_child, reply, emit } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		send({ method: "Page.getFrameTree" });
		reply(commands(extension).at(-1)!.id, { frameTree: { frame: { id: "main-frame" } } });
		const id = send({ method: "Runtime.enable" });
		const wireId = commands(extension).at(-1)!.id;
		reply(wireId);
		emit({
			method: "Runtime.executionContextCreated",
			params: {
				context: { id: 2, auxData: { isDefault: true, frameId: "other-frame" } },
			},
		});
		expect(messages(child).find((message) => message.id === id)).toBeUndefined();
		emit({
			method: "Runtime.executionContextCreated",
			params: {
				context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
			},
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
		const id = send({ method: "Runtime.enable" });
		reply(commands(extension).at(-1)!.id);
		emit({
			method: "Runtime.executionContextCreated",
			params: {
				context: { id: 1, auxData: { isDefault: true, frameId: "main-frame" } },
			},
		});
		expect(messages(child).find((message) => message.id === id)).toBeUndefined();
		send({ method: "Page.getFrameTree" });
		reply(commands(extension).at(-1)!.id, { frameTree: { frame: { id: "main-frame" } } });
		expect(messages(child).find((message) => message.id === id)).toMatchObject({ result: {} });
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("fails bounded readiness instead of exposing an unready page", async () => {
		const { transport, create_child, onUnsafe } = make_transport({ runtimeContext: false });
		const { connection, send, start } = create_child();
		start();
		send({ method: "Page.getFrameTree" });
		send({ method: "Runtime.enable" });
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
		send({ method: "Target.attachToBrowserTarget", params: {}, sessionId: null });
		const browserSession = (messages(child).at(-1)?.result as { sessionId: string }).sessionId;
		send({
			method: "Target.attachToTarget",
			params: { targetId: "assigned-page", flatten: true },
			sessionId: browserSession,
		});
		const captureSession = (messages(child).at(-1)?.result as { sessionId: string }).sessionId;
		expect(captureSession).not.toBe("page-session");
		const id = send({
			method: "Page.captureScreenshot",
			params: { format: "png", captureBeyondViewport: false },
			sessionId: captureSession,
		});
		expect(messages(child).at(-1)).toEqual({ id, sessionId: captureSession, result: { data: PNG_DATA } });
		send({
			method: "Target.detachFromTarget",
			params: { sessionId: captureSession },
			sessionId: browserSession,
		});
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
		const id = send({ method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: false } });
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
		first.send({ method: "Page.enable", params: {}, sessionId: "page-session", requestId: 10 });
		const oldWireId = commands(extension).at(-1)!.id;
		reply(oldWireId);
		expect((await first.connection.settle(1000)).safe).toBe(true);
		expect(socket.readyState).toBe(1);
		const second = create_child();
		second.start();
		reply(commands(extension).at(-1)!.id);
		second.send({ method: "Page.enable", params: {}, sessionId: "page-session", requestId: 10 });
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
		send({ method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "", worldName: "utility" } });
		send({ method: "Runtime.addBinding", params: { name: "our-binding" } });
		send({
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown", key: "Enter", code: "Enter", modifiers: 0 },
		});
		send({
			method: "Input.dispatchMouseEvent",
			params: { type: "mousePressed", button: "left", x: 10, y: 20 },
		});
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
		send({ method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "", worldName: "utility" } });
		const scriptId = commands(extension).at(-1)!.id;
		connection.revoke();
		const id = send({ method: "Page.enable" });
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
		send({ method: "Page.enable" });
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
		send({ method: "Page.enable" });
		extension.close();
		expect(await connection.settle(1000)).toEqual({ safe: false, reason: "connection_lost" });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach", "Page.enable"]);
		expect(() => transport.create_child({ deadline: Date.now() + 30_000 })).toThrow("offline");
	});

	it("keeps descendants scoped and replays existing attachments for a new child", async () => {
		const { create_child, emit } = make_transport();
		const first = create_child();
		first.start();
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "iframe-session",
				targetInfo: {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
					parentFrameId: "main-frame",
				},
				waitingForDebugger: false,
			},
		});
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
				waitingForDebugger: false,
			},
			sessionId: "iframe-session",
		});
		expect(messages(first.child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(3);
		expect((await first.connection.settle(1000)).safe).toBe(true);
		const second = create_child();
		second.start();
		second.send({
			method: "Target.setAutoAttach",
			params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			sessionId: "iframe-session",
		});
		expect(messages(second.child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(3);
		emit({
			method: "Target.detachedFromTarget",
			params: { sessionId: "iframe-session", targetId: "iframe-target" },
		});
		second.send({ method: "Runtime.enable", params: {}, sessionId: "worker-session" });
		expect(messages(second.child).at(-1)?.error).toBeDefined();
		expect((await second.connection.settle(1000)).safe).toBe(true);
	});

	it("starts with existing frames and workers captured before confirmation", async () => {
		const initialEvents = [
			attachment_event({
				sessionId: "iframe-session",
				targetInfo: {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				},
			}),
			attachment_event({
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
				parent: "iframe-session",
			}),
		];
		const { create_child, emit } = make_transport({ initialEvents });
		const first = create_child();
		first.start();
		first.send({
			method: "Target.setAutoAttach",
			params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			sessionId: "iframe-session",
		});
		const attached = messages(first.child).filter((message) => message.method === "Target.attachedToTarget");
		expect(attached.map((message) => (message.params as { sessionId: string }).sessionId)).toEqual([
			"page-session",
			"iframe-session",
			"worker-session",
		]);
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "iframe-session",
				targetInfo: { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" },
				waitingForDebugger: false,
			},
		});
		expect(messages(first.child).filter((message) => message.method === "Target.attachedToTarget")).toEqual(attached);
		expect(await first.connection.settle(1000)).toEqual({ safe: true, reason: null });
		const second = create_child();
		second.start();
		second.send({
			method: "Target.setAutoAttach",
			params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
			sessionId: "iframe-session",
		});
		expect(messages(second.child).filter((message) => message.method === "Target.attachedToTarget")).toEqual(attached);
		expect(await second.connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("keeps frame and context state when a live attachment repeats the snapshot", async () => {
		const target = { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" };
		const { create_child, emit, extension } = make_transport({
			initialEvents: [attachment_event({ sessionId: "iframe-session", targetInfo: target })],
		});
		const { connection, child, send, start } = create_child();
		start();
		send({ method: "Page.getFrameTree", params: {}, sessionId: "iframe-session" });
		send({
			method: "Page.createIsolatedWorld",
			params: { frameId: "inner-frame", worldName: "utility" },
			sessionId: "iframe-session",
		});
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "iframe-session",
				targetInfo: { ...target, title: "Frame" },
				waitingForDebugger: false,
			},
		});
		send({
			method: "Runtime.evaluate",
			params: { expression: "1", contextId: 9 },
			sessionId: "iframe-session",
		});
		send({
			method: "Page.createIsolatedWorld",
			params: { frameId: "inner-frame", worldName: "utility" },
			sessionId: "iframe-session",
		});
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
				attachment_event({
					sessionId: "worker-session",
					targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
					parent: "missing-session",
				}),
			],
		],
		[
			"unrelated page",
			[
				attachment_event({
					sessionId: "other-page-session",
					targetInfo: { ...TARGET, targetId: "other-page" },
					parent: null,
				}),
			],
		],
		[
			"debugger wait",
			[
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" },
					parent: "page-session",
					waitingForDebugger: true,
				}),
			],
		],
		[
			"too many events",
			Array.from({ length: 65 }, () =>
				attachment_event({ sessionId: "page-session", targetInfo: TARGET, parent: null }),
			),
		],
		["too many bytes", [" ".repeat(1_048_577)]],
		[
			"too many UTF-8 bytes",
			[
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: {
						targetId: "iframe-target",
						type: "iframe",
						title: "",
						url: "https://frame.test/",
						ignored: "界".repeat(350_000),
					},
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
			attachment_event({
				sessionId: "iframe-session",
				targetInfo: {
					targetId: "iframe-target",
					type: "iframe",
					title: "",
					url: "https://frame.test/",
				},
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
			initialEvents: [attachment_event({ sessionId: "iframe-session", targetInfo })],
		});
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "iframe-session",
				targetInfo: { ...targetInfo, [String(field).toLowerCase()]: value },
				waitingForDebugger: false,
			},
		});
		expect(socket.readyState).toBe(3);
		expect(onUnsafe).toHaveBeenCalledWith("invalid_target");
		expect(() => create_child()).toThrow("offline");
	});

	it("ignores unsupported native target types without losing the checked frame", async () => {
		const { create_child, emit, socket } = make_transport({
			initialEvents: [
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: {
						targetId: "iframe-target",
						type: "iframe",
						title: "",
						url: "https://frame.test/",
					},
				}),
			],
		});
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "unsupported-session",
				targetInfo: {
					targetId: "unsupported-target",
					type: "service_worker",
					title: "",
					url: "https://frame.test/sw.js",
				},
				waitingForDebugger: false,
			},
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
						attachment_event({ sessionId: "iframe-session", targetInfo }),
						attachment_event({ sessionId: "iframe-session", targetInfo }),
					],
				}),
		).toThrow("Invalid browser attachment snapshot");
		expect(socket.readyState).toBe(3);
	});

	it("fences root loss before admitting the first child", () => {
		const { create_child, emit, socket, onEvent } = make_transport();
		emit({
			method: "Target.detachedFromTarget",
			params: { sessionId: "page-session", targetId: "assigned-page" },
			sessionId: null,
		});
		expect(socket.readyState).toBe(3);
		expect(onEvent).toHaveBeenCalledWith("target_lost");
		expect(() => create_child()).toThrow("offline");
	});

	it.each([
		["target", { targetId: "different-target", type: "iframe", title: "", url: "https://frame.test/" }, "page-session"],
		["type", { targetId: "iframe-target", type: "worker", title: "", url: "https://frame.test/" }, "page-session"],
		["parent", { targetId: "iframe-target", type: "iframe", title: "", url: "https://frame.test/" }, "other-parent"],
	])("fences changed %s before a child exists", (args: { _name: any; targetInfo: any; parent: any }) => {
		const { targetInfo, parent } = args;

		const { create_child, emit, socket, onUnsafe } = make_transport({
			initialEvents: [
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: {
						targetId: "iframe-target",
						type: "iframe",
						title: "",
						url: "https://frame.test/",
					},
				}),
			],
		});
		emit({
			method: "Target.attachedToTarget",
			params: { sessionId: "iframe-session", targetInfo, waitingForDebugger: false },
			sessionId: String(parent),
		});
		expect(socket.readyState).toBe(3);
		expect(onUnsafe).toHaveBeenCalledWith("target_changed");
		expect(() => create_child()).toThrow("offline");
	});

	it("removes a detached subtree before admitting the first child", async () => {
		const { create_child, emit } = make_transport({
			initialEvents: [
				attachment_event({
					sessionId: "iframe-session",
					targetInfo: {
						targetId: "iframe-target",
						type: "iframe",
						title: "",
						url: "https://frame.test/",
					},
				}),
				attachment_event({
					sessionId: "worker-session",
					targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://frame.test/worker.js" },
					parent: "iframe-session",
				}),
			],
		});
		emit({
			method: "Target.detachedFromTarget",
			params: { sessionId: "iframe-session", targetId: "iframe-target" },
		});
		const { connection, child, send, start } = create_child();
		start();
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget")).toHaveLength(1);
		send({ method: "Runtime.enable", params: {}, sessionId: "worker-session" });
		expect(messages(child).at(-1)?.error).toBeDefined();
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("ignores late events from a closed socket and keeps reconnect inventory separate", async () => {
		const old = make_transport();
		old.transport.close();
		old.socket.dispatchEvent(
			new MessageEvent("message", {
				data: attachment_event({
					sessionId: "iframe-session",
					targetInfo: {
						targetId: "iframe-target",
						type: "iframe",
						title: "",
						url: "https://frame.test/",
					},
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

	it("quarantines popups without closing them", async () => {
		const { create_child, emit, onEvent, extension } = make_transport();
		const { connection, child, start } = create_child();
		start();
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "popup-session",
				targetInfo: { ...TARGET, targetId: "popup-target" },
				waitingForDebugger: false,
			},
			sessionId: null,
		});
		expect(onEvent.mock.calls.map(([reason]) => reason)).toEqual(["popup"]);
		expect(messages(child).filter((message) => message.method === "Target.attachedToTarget").length).toBe(1);
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach"]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("does not resume an observed debugger wait", async () => {
		const { create_child, emit, extension, onEvent } = make_transport();
		const { connection, start } = create_child();
		start();
		emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "worker-session",
				targetInfo: { targetId: "worker-target", type: "worker", title: "", url: "https://fixture.test/worker.js" },
				waitingForDebugger: true,
			},
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
		const id = send({ method: "Page.enable" });
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
		emit({
			method: "Page.screencastFrame",
			params: { data: "private screencast image", sessionId: 1, metadata: { timestamp: 1 } },
		});
		emit({ method: "Page.screencastVisibilityChanged", params: { visible: true } });
		const id = send({ method: "Page.enable" });
		expect(child.received.join("")).not.toContain("private screencast image");
		expect(messages(child).some((message) => String(message.method).startsWith("Page.screencast"))).toBe(false);
		expect(messages(child).at(-1)).toEqual({ id, sessionId: "page-session", result: {} });
		expect(commands(extension).map((request) => request.method)).toEqual(["Target.setAutoAttach", "Page.enable"]);
		expect(onUnsafe).not.toHaveBeenCalled();
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
	});

	it("rejects oversized screenshot clips and invalid parameter scope before dispatch", async () => {
		const { extension, create_child } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		send({
			method: "Page.captureScreenshot",
			params: {
				format: "png",
				captureBeyondViewport: false,
				clip: { x: 0, y: 0, width: 8192, height: 8192, scale: 1 },
			},
		});
		send({ method: "Runtime.evaluate", params: { expression: "1", contextId: 99 } });
		send({ method: "Page.navigate", params: { url: "file:///private" } });
		send({ method: "Browser.setWindowBounds", params: { windowId: 99, bounds: { width: 100, height: 100 } } });
		send({
			method: "Target.attachToTarget",
			params: { targetId: "other-page", flatten: true },
			sessionId: null,
		});
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

describe("PlaywriterTransport script commands", () => {
	it("stops waiting for page reads at the deadline but still drains input", async () => {
		const { extension, create_child, reply, onUnsafe, socket } = make_transport({ autoReply: false });
		const { connection, child, send, start } = create_child();
		start();
		reply(commands(extension).at(-1)!.id);
		const readId = send({ method: "Runtime.getProperties", params: { objectId: "endless-read" } });
		const read = commands(extension).at(-1)!;
		send({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 1, y: 1 } });
		const input = commands(extension).at(-1)!;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(messages(child).find((message) => message.id === readId)).toMatchObject({
			error: { message: "Browser access was revoked." },
		});
		const settled = connection.settle(1000);
		reply(read.id, { result: [] });
		reply(input.id);
		expect(await settled).toEqual({ safe: true, reason: null });
		expect(onUnsafe).not.toHaveBeenCalled();
		expect(socket.readyState).toBe(1);
	});

	it("stops a script when any frame shows a blocked site and keeps it blocked", async () => {
		const { create_child, emit } = make_transport({ blockedHosts: ["blocked.test"] });
		const { connection, child, send, start } = create_child();
		start();
		emit({
			method: "Page.frameNavigated",
			params: {
				frame: { id: "inner-frame", parentId: "main-frame", url: "https://blocked.test/" },
			},
		});
		emit({
			method: "Page.frameNavigated",
			params: {
				frame: { id: "inner-frame", parentId: "main-frame", url: "https://fixture.test/" },
			},
		});
		const id = send({ method: "Page.enable" });
		expect(messages(child).find((message) => message.id === id)).toHaveProperty("error");
		expect(
			messages(child).some((message) => message.method === "Page.frameNavigated"),
			"A revoked script must not see events that could carry the blocked page",
		).toBe(false);
		expect(connection.blocked()).toBe(true);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("hides a frame tree reply that shows a blocked frame", async () => {
		const { extension, create_child, reply } = make_transport({ autoReply: false, blockedHosts: ["blocked.test"] });
		const { connection, child, send, start } = create_child();
		start();
		// Answer Fetch.enable and Target.setAutoAttach.
		for (const request of commands(extension)) reply(request.id);
		const id = send({ method: "Page.getFrameTree" });
		reply(commands(extension).at(-1)!.id, {
			frameTree: {
				frame: { id: "main-frame", url: "https://fixture.test/" },
				childFrames: [{ frame: { id: "inner-frame", url: "https://blocked.test/secret" } }],
			},
		});
		expect(messages(child).find((message) => message.id === id)).toMatchObject({
			error: { message: "Browser access was revoked." },
		});
		expect(connection.blocked()).toBe(true);
		const settled = connection.settle(1000);
		await vi.advanceTimersByTimeAsync(0);
		reply(commands(extension).at(-1)!.id); // Fetch.disable
		expect((await settled).safe).toBe(true);
	});

	it("fails only requests to blocked sites and never shows them to the script", async () => {
		const { create_child, emit, extension } = make_transport({ blockedHosts: ["blocked.test"] });
		const { connection, child, start } = create_child();
		expect(commands(extension).at(-1)).toMatchObject({
			method: "Fetch.enable",
			sessionId: "page-session",
			params: { patterns: [{ urlPattern: "*blocked.test*", requestStage: "Request" }] },
		});
		start();
		emit({
			method: "Fetch.requestPaused",
			params: { requestId: "blocked-request", request: { url: "https://blocked.test/x" } },
		});
		emit({
			method: "Fetch.requestPaused",
			params: {
				requestId: "allowed-request",
				request: { url: "https://fixture.test/?q=blocked.test" },
			},
		});
		expect(commands(extension).slice(-2)).toMatchObject([
			{ method: "Fetch.failRequest", params: { requestId: "blocked-request", errorReason: "BlockedByClient" } },
			{ method: "Fetch.continueRequest", params: { requestId: "allowed-request" } },
		]);
		expect(messages(child).some((message) => message.method === "Fetch.requestPaused")).toBe(false);
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		expect(commands(extension).at(-1)).toMatchObject({ method: "Fetch.disable", sessionId: "page-session" });
	});

	it.each([
		["Ctrl+V by key code", "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 86 }],
		["Meta+V", "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "v", code: "KeyV" }],
		["Shift+Insert", "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 8, key: "Insert", code: "Insert" }],
		["middle click", "Input.dispatchMouseEvent", { type: "mousePressed", button: "middle", x: 1, y: 1 }],
	])("refuses a paste from the user's clipboard: %s", async (args: { _name: any; method: any; params: any }) => {
		const { method, params } = args;

		const { create_child, extension } = make_transport();
		const { connection, child, send, start } = create_child();
		start();
		const id = send({ method, params });
		expect(messages(child).find((message) => message.id === id)).toHaveProperty("error");
		send({
			method: "Input.dispatchKeyEvent",
			params: { type: "keyDown", modifiers: 0, key: "v", code: "KeyV" },
		});
		expect(commands(extension).map((request) => request.method)).toEqual([
			"Target.setAutoAttach",
			"Input.dispatchKeyEvent",
		]);
		expect((await connection.settle(1000)).safe).toBe(true);
	});

	it("shows only the current history url and checks the real url of an entry", async () => {
		const { extension, create_child, reply } = make_transport({ autoReply: false, blockedHosts: ["blocked.test"] });
		const { connection, child, send, start } = create_child();
		start();
		// Answer Fetch.enable and Target.setAutoAttach.
		for (const request of commands(extension)) reply(request.id);
		const id = send({ method: "Page.getNavigationHistory" });
		reply(commands(extension).at(-1)!.id, {
			currentIndex: 2,
			entries: [
				{ id: 1, url: "https://blocked.test/", userTypedURL: "https://blocked.test/", title: "Blocked" },
				{ id: 2, url: "https://private.test/", userTypedURL: "https://private.test/", title: "Private" },
				{ id: 3, url: "https://fixture.test/", userTypedURL: "https://fixture.test/", title: "Fixture" },
			],
		});
		expect(messages(child).find((message) => message.id === id)).toMatchObject({
			result: {
				entries: [
					{ id: 1, url: "", userTypedURL: "", title: "" },
					{ id: 2, url: "", userTypedURL: "", title: "" },
					{ id: 3, url: "https://fixture.test/", title: "Fixture" },
				],
			},
		});
		const blocked = send({ method: "Page.navigateToHistoryEntry", params: { entryId: 1 } });
		const unknown = send({ method: "Page.navigateToHistoryEntry", params: { entryId: 99 } });
		send({ method: "Page.navigateToHistoryEntry", params: { entryId: 2 } });
		expect(messages(child).find((message) => message.id === blocked)).toHaveProperty("error");
		expect(messages(child).find((message) => message.id === unknown)).toHaveProperty("error");
		expect(commands(extension).at(-1)).toMatchObject({
			method: "Page.navigateToHistoryEntry",
			params: { entryId: 2 },
		});
		reply(commands(extension).at(-1)!.id);
		const settled = connection.settle(1000);
		await vi.advanceTimersByTimeAsync(0);
		reply(commands(extension).at(-1)!.id); // Fetch.disable
		expect((await settled).safe).toBe(true);
	});

	it("lets a script answer dialogs and dismisses one it leaves open", async () => {
		const { create_child, emit, onEvent, extension } = make_transport();
		const { connection, child, send, start } = create_child();
		const dialog = { type: "confirm", message: "Fixture", defaultPrompt: "", url: "https://fixture.test/" };
		start();
		emit({ method: "Page.javascriptDialogOpening", params: dialog });
		expect(messages(child).some((message) => message.method === "Page.javascriptDialogOpening")).toBe(true);
		send({ method: "Page.handleJavaScriptDialog", params: { accept: true } });
		emit({ method: "Page.javascriptDialogClosed", params: { result: true, userInput: "" } });
		emit({ method: "Page.javascriptDialogOpening", params: dialog });
		expect(await connection.settle(1000)).toEqual({ safe: true, reason: null });
		expect(onEvent).not.toHaveBeenCalled();
		expect(
			commands(extension)
				.filter((request) => request.method === "Page.handleJavaScriptDialog")
				.map((request) => request.params.accept),
		).toEqual([true, false]);
	});
});
