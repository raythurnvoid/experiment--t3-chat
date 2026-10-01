import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle_playwriter_request, PlaywriterSession } from "./playwriter-session";
import { playwriter_browser_response_schema } from "common/playwriter-browser.ts";
import { SNIPPET_EXECUTOR_REVISION } from "./snippet-executor";

const SCRIPT = { kind: "script", code: "return 1" };
const SCRIPT_RESULT = {
	ok: true,
	resultJson: "1",
	logs: [],
	logsTruncated: false,
	consoleEntries: [],
	pageErrors: [],
	stateJson: '{"n":1}',
	stateWarnings: [],
	files: [],
};

const SCOPE = { connectionId: "connection", ownerId: "owner", organizationId: "org", workspaceId: "workspace" };
const runtime = {
	generation: 5,
	state: "connected" as const,
	targets: [],
	targetRevision: 3,
	navRevision: 2,
	confirmedTargetId: "native-tab",
	controlRevision: 4,
	policyRevision: 1,
	agentAccess: true,
	operations: 0,
	idleExpiresAt: 0,
	totalExpiresAt: 0,
	sessionId: "session",
	inventoryRevision: 2,
};

class NativeSocket extends EventTarget {
	readyState = 1;
	cleanupReply: number | null = null;
	holdCleanup = false;
	inputCalls = 0;
	url = "https://fixture.test/";
	accept() {
		this.packet({ method: "hello", params: { version: "0.5.0" } });
		this.packet({
			method: "forwardCDPEvent",
			params: {
				method: "Target.attachedToTarget",
				params: {
					sessionId: "native-session",
					targetInfo: { targetId: "native-tab", type: "page", title: "Fixture", url: this.url },
					waitingForDebugger: false,
				},
			},
		});
	}
	send(data: string) {
		const packet = JSON.parse(data) as { id?: number; method: string; params?: { method: string } };
		if (packet.method !== "forwardCDPCommand" || packet.id === undefined) return;
		if (packet.params?.method.startsWith("Input.")) this.inputCalls += 1;
		if (packet.params?.method === "Page.removeScriptToEvaluateOnNewDocument" && this.holdCleanup) {
			this.cleanupReply = packet.id;
			return;
		}
		this.packet({
			id: packet.id,
			result: packet.params?.method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "command-script" } : {},
		});
	}
	close() {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	packet(value: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
	}
	navigate() {
		this.packet({
			method: "forwardCDPEvent",
			params: {
				method: "Page.frameNavigated",
				sessionId: "native-session",
				params: { frame: { id: "main-frame", url: "https://fixture.test/next" } },
			},
		});
	}
}

class ChildSocket extends EventTarget {
	readyState = 1;
	peer: ChildSocket | null = null;
	accept() {}
	send(data: string) {
		this.peer!.dispatchEvent(new MessageEvent("message", { data }));
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

class ChildSocketPair {
	0 = new ChildSocket();
	1 = new ChildSocket();
	constructor() {
		this[0].peer = this[1];
		this[1].peer = this[0];
	}
}

const NativeResponse = Response;
class SocketResponse extends NativeResponse {
	readonly webSocket: WebSocket | null;
	constructor(body?: BodyInit | null, init?: ResponseInit) {
		super(body, init?.status === 101 ? { ...init, status: 200 } : init);
		this.webSocket = init?.webSocket ?? null;
		if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
	}
}

function make_session(existingRecords?: Map<string, unknown>) {
	const now = Date.now();
	const records =
		existingRecords ??
		new Map<string, unknown>([
			[
				"session",
				{
					scope: SCOPE,
					runtime: { ...runtime, idleExpiresAt: now + 600_000, totalExpiresAt: now + 3_600_000 },
					blockedHosts: [],
					allowedVersions: ["0.5.0"],
					attemptId: "attempt",
					humanPaused: false,
				},
			],
		]);
	const put = vi.fn(async (key: string, value: unknown) => {
		records.set(key, value);
	});
	const evaluate = vi.fn(async (_input: unknown): Promise<unknown> => null);
	const env = {
		BROWSER_WEB_DENIED_HOSTS: "",
		PLAYWRITER_SESSIONS: {
			idFromName: (name: string) => ({ toString: () => name }),
			get: () => ({ fetch: (request: Request): Promise<Response> => session.fetch(request) }),
		},
		LOADER: {
			load: vi.fn((_options: { modules: Record<string, string> }) => ({
				getEntrypoint: () => ({
					revision: async () => SNIPPET_EXECUTOR_REVISION,
					evaluate,
				}),
			})),
		},
	};
	const session = new PlaywriterSession(
		{
			storage: {
				get: async <T>(key: string) => records.get(key) as T | undefined,
				list: async <T>(options: { prefix: string }) =>
					new Map([...records].filter(([key]) => key.startsWith(options.prefix))) as Map<string, T>,
				put,
				delete: async (key: string) => records.delete(key),
				setAlarm: async () => {},
				deleteAlarm: async () => {},
			},
			waitUntil: () => {},
		},
		env,
	);
	const post = async (path: string, input: unknown) => {
		const response = await session.fetch(
			new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(input) }),
		);
		return { response, reply: (await response.json()) as Record<string, unknown> };
	};
	const remote = async (path: string, input: unknown) => {
		const response = await handle_playwriter_request({
			request: new Request(`https://runner/internal/playwriter${path}`, { method: "POST", body: JSON.stringify(input) }),
			env,
			ctx: { exports: { PlaywriterConnectionGateway: () => ({ fetch: async () => new Response() }) } },
		});
		return { response, reply: (await response.json()) as Record<string, unknown> };
	};
	return { session, records, put, post, remote, evaluate, env };
}

function receipt() {
	return {
		...SCOPE,
		generation: 6,
		commandId: "command",
		operationHash: "a".repeat(64),
		source: { chatId: "chat", sourceMessageId: "message", toolCallId: "tool" },
		deadline: Date.now() + 20_000,
		receiptResolutionDeadline: Date.now() + 25_000,
	};
}

function receipt_identity(command: ReturnType<typeof receipt>) {
	return {
		connectionId: command.connectionId,
		ownerId: command.ownerId,
		organizationId: command.organizationId,
		workspaceId: command.workspaceId,
		generation: command.generation,
		commandId: command.commandId,
		operationHash: command.operationHash,
		source: command.source,
		deadline: command.deadline,
		receiptResolutionDeadline: command.receiptResolutionDeadline,
	};
}

function connect_request() {
	return {
		...SCOPE,
		shareId: "a".repeat(32),
		attemptId: "new-attempt",
		expectedTargetId: "native-tab",
		paused: false,
		idleExpiresAt: Date.now() + 600_000,
		totalExpiresAt: Date.now() + 3_600_000,
		sessionId: "session",
		operations: 0,
		allowedVersions: ["0.5.0"],
		agentBlockedHosts: [] as string[],
		agentAccess: true,
		policyRevision: 1,
		controlRevision: 4,
	};
}

async function connect_session(args: {
	mocked: ReturnType<typeof make_session>;
	socket?: NativeSocket;
	input?: ReturnType<typeof connect_request>;
}) {
	const { mocked, socket = new NativeSocket(), input = connect_request() } = args;

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ status: 101, webSocket: socket })),
	);
	const connecting = mocked.remote("/recover", input);
	await vi.advanceTimersByTimeAsync(300);
	const connected = (await connecting).reply.runtime as typeof runtime;
	expect(connected.state).toBe("connected");
	return connected;
}

function command_request(connected: typeof runtime, commandId: string) {
	return {
		...receipt(),
		commandId,
		generation: connected.generation,
		controlRevision: connected.controlRevision,
		policyRevision: connected.policyRevision,
		targetRevision: connected.targetRevision,
		navRevision: connected.navRevision,
		targetId: "native-tab",
		allowedVersions: ["0.5.0"],
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("PlaywriterSession", () => {
	it("rejects a first idle deadline over ten minutes before dialing", async () => {
		const mocked = make_session(new Map());
		const dial = vi.fn();
		vi.stubGlobal("fetch", dial);
		expect(
			(await mocked.remote("/connect", { ...connect_request(), idleExpiresAt: Date.now() + 600_001 })).reply,
		).toMatchObject({ error: { code: "expired" } });
		expect(dial).not.toHaveBeenCalled();
	});

	it("keeps a successor command when an exact policy sync is retried", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		const command = { ...command_request(connected, "during-policy-retry"), operation: SCRIPT };
		expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
		expect(
			(
				await mocked.remote("/agent-access", {
					...SCOPE,
					generation: connected.generation,
					agentAccess: true,
					agentBlockedHosts: [],
					policyRevision: connected.policyRevision,
				})
			).reply,
		).toMatchObject({ runtime: { state: "connected", generation: connected.generation } });
		expect(
			(
				await mocked.post("/run/finish", {
					...SCOPE,
					request: receipt_identity(command),
					output: { script: { status: "succeeded", stateJson: null } },
				})
			).reply,
			"An unchanged settings retry must not revoke an admitted successor",
		).toMatchObject({ status: "completed" });
	});

	it.each(["connect", "confirm"])("refuses a system-denied native root through %s before attachment", async (path) => {
		const mocked = make_session(new Map());
		mocked.env.BROWSER_WEB_DENIED_HOSTS = " other.test, BLOCKED.TEST. ";
		const socket = new NativeSocket();
		socket.url = "https://login.blocked.test./";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ status: 101, webSocket: socket })),
		);
		const pending = mocked.remote("/connect", {
			...connect_request(),
			expectedTargetId: path === "connect" ? "native-tab" : null,
		});
		await vi.advanceTimersByTimeAsync(300);
		const connected = (await pending).reply;
		const reply =
			path === "connect"
				? connected
				: (
						await mocked.remote("/confirm", {
							...SCOPE,
							generation: (connected.runtime as typeof runtime).generation,
							inventoryRevision: (connected.runtime as typeof runtime).inventoryRevision,
							targetId: "native-tab",
						})
					).reply;
		expect(reply, "A system-denied native root must not be confirmed").toMatchObject({
			ok: false,
			error: { code: path === "connect" ? "target_changed" : "invalid_target" },
		});
		expect(socket.inputCalls).toBe(0);
		expect(mocked.env.LOADER.load).not.toHaveBeenCalled();
		if (path === "confirm")
			expect((await mocked.remote("/status", SCOPE)).reply).toMatchObject({
				runtime: { state: "awaiting_confirmation", confirmedTargetId: null },
			});
	});

	it("keeps current system denies after an empty user policy sync", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		mocked.env.BROWSER_WEB_DENIED_HOSTS = "FIXTURE.TEST.";
		const synced = (
			await mocked.remote("/agent-access", {
				...SCOPE,
				generation: connected.generation,
				agentAccess: true,
				policyRevision: 2,
				agentBlockedHosts: [],
			})
		).reply.runtime as typeof runtime;
		const reply = (
			await mocked.remote("/run", { ...command_request(synced, "system-policy"), operation: SCRIPT })
		).reply;
		expect(reply, "A user policy sync must not remove the current system deny").toMatchObject({
			status: "refused",
			result: { reason: "blocked_site", inputSent: false, cleanup: "complete" },
		});
		expect(mocked.env.LOADER.load).not.toHaveBeenCalled();
		expect(mocked.records.get("session")).toMatchObject({ blockedHosts: [] });
	});

	it("applies current system and saved user denies without storing system entries", async () => {
		const mocked = make_session();
		mocked.env.BROWSER_WEB_DENIED_HOSTS = " system.test, , ";
		const socket = new NativeSocket();
		await connect_session({ mocked, socket, input: { ...connect_request(), agentBlockedHosts: ["user.test"] } });
		expect(mocked.records.get("session")).toMatchObject({ blockedHosts: ["user.test"] });
		for (const host of ["user.test", "system.test"]) {
			socket.packet({
				method: "forwardCDPEvent",
				params: {
					method: "Page.frameNavigated",
					sessionId: "native-session",
					params: { frame: { id: "main-frame", url: `https://${host}/` } },
				},
			});
			const current = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
			expect(
				(await mocked.remote("/run", { ...command_request(current, host), operation: SCRIPT })).reply,
				"A page on a system or user denied site must refuse new scripts",
			).toMatchObject({ status: "refused", result: { reason: "blocked_site" } });
		}
		expect(mocked.env.LOADER.load).not.toHaveBeenCalled();
	});

	it("keeps a blank native root available under system host rules", async () => {
		const mocked = make_session();
		mocked.env.BROWSER_WEB_DENIED_HOSTS = "fixture.test";
		const socket = new NativeSocket();
		socket.url = "about:blank";
		const connected = await connect_session({ mocked, socket });
		mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
		expect(
			(await mocked.remote("/run", { ...command_request(connected, "blank-read"), operation: SCRIPT })).reply,
		).toMatchObject({ status: "completed" });
	});

	it("refuses a removed live version before new child work", async () => {
		const mocked = make_session();
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
		const reply = (
			await mocked.remote("/run", {
				...command_request(connected, "removed-version"),
				allowedVersions: ["0.7.0"],
				operation: SCRIPT,
			})
		).reply;
		expect(reply, "A removed live version must not load or dispatch new work").toMatchObject({
			status: "refused",
			result: { reason: "agent_unavailable", inputSent: false, cleanup: "complete" },
		});
		expect(mocked.env.LOADER.load).not.toHaveBeenCalled();
		expect(socket.inputCalls).toBe(0);
	});

	it("keeps exact duplicate receipts and cleanup after version removal", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
		const command = { ...command_request(connected, "version-receipt"), operation: SCRIPT };
		expect((await mocked.remote("/run", command)).reply.status).toBe("completed");
		expect(
			(await mocked.remote("/run", { ...command, allowedVersions: ["0.7.0"] })).reply,
			"Version removal must not change a completed command identity",
		).toMatchObject({ status: "completed", result: { cleanup: "complete" } });
		for (const path of ["/command-status", "/command-fence", "/command-ack"])
			expect((await mocked.remote(path, receipt_identity(command))).reply).toMatchObject({
				ok: true,
				result: { cleanup: "complete" },
			});
		expect(mocked.evaluate).toHaveBeenCalledOnce();
	});

	it("fences the old boot and preserves the private confirmed target", async () => {
		const { post, records } = make_session();
		const { reply } = await post("/status", SCOPE);
		expect(reply).toMatchObject({
			ok: true,
			runtime: { generation: 6, state: "disconnected", confirmedTargetId: "native-tab", targets: [], navRevision: 3 },
		});
		expect(playwriter_browser_response_schema.safeParse(reply).success).toBe(true);
		expect(JSON.stringify(records.get("session"))).not.toContain("shareId");
	});

	it("reserves not started before a late command can dispatch", async () => {
		const { post } = make_session();
		const request = receipt();
		expect((await post("/command-status", request)).reply.status).toBe("not_started");
		const result = await post("/run/begin", {
			...request,
			controlRevision: 4,
			policyRevision: 1,
			targetRevision: 4,
			navRevision: 3,
			targetId: "native-tab",
			allowedVersions: ["0.5.0"],
			operation: SCRIPT,
		});
		expect(result.reply.status).toBe("not_started");
		expect(result.reply).not.toHaveProperty("execute");
		expect(result.reply.completedLease).toBeNull();
	});

	it.each(["/command-status", "/command-fence", "/command-ack"])(
		"returns only safe cleanup for a completed late receipt through %s",
		async (path) => {
			const mocked = make_session();
			const connected = await connect_session({ mocked });
			mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
			const command = { ...command_request(connected, "late-completed"), operation: SCRIPT };
			expect((await mocked.remote("/run", command)).reply.status).toBe("completed");
			vi.setSystemTime(command.receiptResolutionDeadline + 1);
			const reply = (await mocked.remote(path, receipt_identity(command))).reply;
			expect(reply, "An exact late receipt must retain its cleanup proof").toMatchObject({
				status: "unknown",
				completedLease: null,
				result: { ok: false, reason: "outcome_unknown", cleanup: "complete" },
			});
			expect(reply).not.toHaveProperty("script");
			expect(playwriter_browser_response_schema.safeParse(reply).success).toBe(true);
			expect(mocked.evaluate).toHaveBeenCalledOnce();
		},
	);

	it.each(["/command-status", "/command-fence", "/command-ack"])(
		"settles retained native cleanup after the receipt deadline through %s",
		async (path) => {
			vi.stubGlobal("WebSocketPair", ChildSocketPair);
			vi.stubGlobal("Response", SocketResponse);
			const mocked = make_session();
			const socket = new NativeSocket();
			const connected = await connect_session({ mocked, socket });
			const command = { ...command_request(connected, "late-retained"), operation: SCRIPT };
			expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
			const response = await mocked.session.fetch(
				new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(101);
			const child = response.webSocket as unknown as ChildSocket;
			child.send(
				JSON.stringify({
					id: 1,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				}),
			);
			child.send(
				JSON.stringify({
					id: 2,
					method: "Page.addScriptToEvaluateOnNewDocument",
					sessionId: "native-session",
					params: { source: "", worldName: "utility" },
				}),
			);
			socket.holdCleanup = true;
			vi.setSystemTime(command.receiptResolutionDeadline + 1);
			const pending = mocked.remote(path, receipt_identity(command));
			await vi.waitFor(() =>
				expect(socket.cleanupReply, "A late check must retire the retained native command").not.toBeNull(),
			);
			socket.packet({ id: socket.cleanupReply, result: {} });
			expect((await pending).reply).toMatchObject({
				status: "unknown",
				completedLease: null,
				result: { cleanup: "complete" },
			});
			const replay = (await mocked.remote("/run", command)).reply;
			expect(replay).not.toHaveProperty("execute");
			expect(mocked.evaluate).not.toHaveBeenCalled();
			expect(socket.inputCalls).toBe(0);
		},
	);

	it("never invents a late receipt or accepts a changed late identity", async () => {
		const mocked = make_session();
		const command = receipt();
		await mocked.remote("/command-status", command);
		vi.setSystemTime(command.receiptResolutionDeadline + 1);
		expect((await mocked.remote("/command-status", { ...command, operationHash: "b".repeat(64) })).reply).toMatchObject(
			{ error: { code: "receipt_mismatch" } },
		);
		await mocked.remote("/command-status", { ...receipt(), commandId: "current" });
		for (const commandId of [command.commandId, "never-received"]) {
			const reply = (await mocked.remote("/command-status", { ...command, commandId })).reply;
			expect(reply).toMatchObject({ status: "unknown", completedLease: null, result: { cleanup: "unknown" } });
			expect(reply.status).not.toBe("not_started");
		}
	});

	it("allows only a fresh trusted human Reconnect to reset the ended session", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation });
		const ended = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
		const next = {
			...connect_request(),
			attemptId: "human-reconnect",
			sessionId: "next-session",
			controlRevision: ended.controlRevision,
			previousSessionId: "session",
		};
		expect((await mocked.remote("/recover", { ...next, previousSessionId: undefined })).reply).toMatchObject({
			error: { code: "recovery_changed" },
		});
		const socket = new NativeSocket();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ status: 101, webSocket: socket })),
		);
		const pending = mocked.remote("/reconnect", next);
		await vi.advanceTimersByTimeAsync(300);
		expect((await pending).reply, "An ended session must accept the exact human new-session transition").toMatchObject({
			ok: true,
			runtime: { state: "connected", sessionId: "next-session", generation: ended.generation + 1, operations: 0 },
		});
		expect(
			(await mocked.remote("/reconnect", { ...next, attemptId: "delayed-old", sessionId: "third-session" })).reply,
		).toMatchObject({ error: { code: "recovery_changed" } });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each(["operation limit", "total limit"])(
		"keeps Pause and Off on an explicit human Reconnect after the %s",
		async (limit) => {
			const mocked = make_session();
			const socket = new NativeSocket();
			const input = {
				...connect_request(),
				operations: limit === "operation limit" ? 119 : 0,
				totalExpiresAt: Date.now() + 600_000,
			};
			const connected = await connect_session({ mocked, socket, input });
			if (limit === "operation limit") {
				mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
				expect(
					(
						await mocked.remote("/run", {
							...command_request(connected, "last-budgeted-read"),
							operation: SCRIPT,
						})
					).reply,
				).toMatchObject({ status: "completed", runtime: { operations: 120 } });
			}
			await mocked.remote("/pause", {
				...SCOPE,
				generation: connected.generation,
				controlRevision: connected.controlRevision + 1,
			});
			await mocked.remote("/agent-access", {
				...SCOPE,
				generation: connected.generation,
				agentAccess: false,
				policyRevision: connected.policyRevision + 1,
				agentBlockedHosts: ["blocked.test"],
			});
			if (limit === "total limit") vi.setSystemTime(input.totalExpiresAt + 1);
			const current = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
			const next = {
				...connect_request(),
				previousSessionId: "session",
				sessionId: "fresh-budget",
				attemptId: "fresh-budget",
				paused: true,
				agentAccess: false,
				policyRevision: current.policyRevision,
				controlRevision: current.controlRevision,
				agentBlockedHosts: ["blocked.test"],
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ status: 101, webSocket: new NativeSocket() })),
			);
			const pending = mocked.remote("/reconnect", next);
			await vi.advanceTimersByTimeAsync(300);
			expect((await pending).reply).toMatchObject({
				ok: true,
				runtime: {
					state: "paused",
					agentAccess: false,
					operations: 0,
					sessionId: "fresh-budget",
					controlRevision: current.controlRevision,
					policyRevision: current.policyRevision,
				},
			});
			expect(socket.inputCalls).toBe(0);
			expect(JSON.stringify(mocked.records.get("session"))).not.toContain("shareId");
		},
	);

	it.each(["cleanup before Pause", "total deadline before Pause"])(
		"keeps newer human Pause intent on Reconnect after %s",
		async (order) => {
			vi.stubGlobal("WebSocketPair", ChildSocketPair);
			vi.stubGlobal("Response", SocketResponse);
			const mocked = make_session();
			const socket = new NativeSocket();
			const deadline = Date.now() + 1000;
			const connected = await connect_session({
				mocked,
				socket,
				input: {
				...connect_request(),
				...(order === "total deadline before Pause"
					? { idleExpiresAt: deadline, totalExpiresAt: deadline }
					: { operations: 119 }),
			},
			});
			const preparedPauseRevision = connected.controlRevision + 1;
			if (order === "cleanup before Pause") {
				const command = { ...command_request(connected, "last-before-retirement"), operation: SCRIPT };
				expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
				const response = await mocked.session.fetch(
					new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
						headers: { Upgrade: "websocket" },
					}),
				);
				expect(response.status).toBe(101);
				const child = response.webSocket as unknown as ChildSocket;
				child.send(
					JSON.stringify({
						id: 1,
						method: "Target.setAutoAttach",
						params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
					}),
				);
				child.send(
					JSON.stringify({
						id: 2,
						method: "Page.addScriptToEvaluateOnNewDocument",
						sessionId: "native-session",
						params: { source: "", worldName: "utility" },
					}),
				);
				socket.holdCleanup = true;
				const cleaning = mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation });
				await vi.waitFor(() => expect(socket.cleanupReply).not.toBeNull());
				socket.packet({ id: socket.cleanupReply, result: {} });
				expect((await cleaning).reply).toMatchObject({
					runtime: { state: "disconnected", generation: connected.generation + 1 },
				});
			} else {
				await vi.advanceTimersByTimeAsync(1000);
				expect(
					(
						await mocked.remote("/pause", {
							...SCOPE,
							generation: connected.generation,
							controlRevision: preparedPauseRevision,
						})
					).reply,
				).toMatchObject({ error: { code: "expired" } });
				expect(
					(await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation })).reply,
				).toMatchObject({ runtime: { state: "disconnected", generation: connected.generation + 1 } });
			}
			expect(socket.readyState, "Retirement must close the old real socket before Reconnect").toBe(3);
			if (order === "cleanup before Pause")
				expect(
					(
						await mocked.remote("/pause", {
							...SCOPE,
							generation: connected.generation,
							controlRevision: preparedPauseRevision,
						})
					).reply,
				).toMatchObject({ error: { code: "stale_control" } });
			const ended = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
			const next = {
				...connect_request(),
				previousSessionId: connected.sessionId,
				sessionId: "new-paused-session",
				attemptId: "new-paused-attempt",
				paused: true,
				controlRevision: preparedPauseRevision + 1,
			};
			for (const controlRevision of [ended.controlRevision, ended.controlRevision - 1]) {
				expect(
					(await mocked.remote("/reconnect", { ...next, controlRevision })).reply,
					"Same or older authority must not change saved human Pause",
				).toMatchObject({ error: { code: "recovery_changed" } });
			}
			const newerSocket = new NativeSocket();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ status: 101, webSocket: newerSocket })),
			);
			const reconnecting = mocked.remote("/reconnect", next);
			await vi.advanceTimersByTimeAsync(300);
			const reconnect = (await reconnecting).reply;
			expect(reconnect, "A newer trusted human Pause must be preserved on the new session").toMatchObject({
				ok: true,
				runtime: {
					state: "paused",
					generation: ended.generation + 1,
					controlRevision: next.controlRevision,
					sessionId: next.sessionId,
				},
			});
			const paused = reconnect.runtime as typeof runtime;
			expect(
				(
					await mocked.post("/run/begin", {
						...command_request(paused, "blocked-by-human-pause"),
						operation: SCRIPT,
					})
				).reply,
			).toMatchObject({ status: "refused", result: { reason: "agent_unavailable" } });
			expect(newerSocket.inputCalls).toBe(0);
			const resumed = (
				await mocked.remote("/resume", {
					...SCOPE,
					generation: paused.generation,
					controlRevision: paused.controlRevision + 1,
				})
			).reply.runtime as typeof runtime;
			expect(resumed.state).toBe("connected");
			expect(
				(
					await mocked.post("/run/begin", {
						...command_request(resumed, "read-after-explicit-resume"),
						operation: SCRIPT,
					})
				).reply.execute,
			).toBe(true);
		},
	);

	it.each(["session", "target", "control", "policy", "pause", "access", "scope"])(
		"refuses a changed %s on a fresh human Reconnect before dialing",
		async (change) => {
			const mocked = make_session();
			const connected = await connect_session({ mocked });
			await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation });
			const current = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
			const next = {
				...connect_request(),
				previousSessionId: "session",
				sessionId: "fresh",
				attemptId: "fresh",
				controlRevision: current.controlRevision,
			};
			if (change === "session") next.previousSessionId = "older";
			else if (change === "target") next.expectedTargetId = "other-tab";
			else if (change === "control") next.controlRevision -= 1;
			else if (change === "policy") next.policyRevision -= 1;
			else if (change === "pause") next.paused = true;
			else if (change === "access") next.agentAccess = false;
			else next.workspaceId = "other";
			vi.mocked(fetch).mockClear();
			expect((await mocked.remote("/reconnect", next)).reply).toMatchObject({
				ok: false,
				error: { code: change === "scope" ? "scope_refused" : "recovery_changed" },
			});
			expect(fetch).not.toHaveBeenCalled();
			expect((await mocked.remote("/status", SCOPE)).reply).toMatchObject({
				runtime: { sessionId: "session", generation: current.generation },
			});
		},
	);

	it("refuses an active unspent session reset and fences old receipts after human Reconnect", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		const next = { ...connect_request(), previousSessionId: "session", sessionId: "fresh", attemptId: "fresh" };
		expect((await mocked.remote("/reconnect", next)).reply).toMatchObject({ error: { code: "busy" } });
		const command = command_request(connected, "old-session-command");
		await mocked.remote("/command-status", receipt_identity(command));
		await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation });
		const ended = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ status: 101, webSocket: new NativeSocket() })),
		);
		const pending = mocked.remote("/reconnect", { ...next, controlRevision: ended.controlRevision });
		await vi.advanceTimersByTimeAsync(300);
		const fresh = (await pending).reply.runtime as typeof runtime;
		expect((await mocked.remote("/command-status", receipt_identity(command))).reply).toMatchObject({
			status: "unknown",
			completedLease: null,
			runtime: { generation: fresh.generation },
		});
		expect((await mocked.remote("/run", { ...command, operation: SCRIPT })).reply).toMatchObject({
			error: { code: "stale_generation" },
		});
		expect(mocked.evaluate).not.toHaveBeenCalled();
	});

	it.each(["Pause", "Off"])(
		"leaves a newer %s in place while human Reconnect drains native cleanup",
		async (change) => {
			vi.stubGlobal("WebSocketPair", ChildSocketPair);
			vi.stubGlobal("Response", SocketResponse);
			const mocked = make_session();
			const socket = new NativeSocket();
			const connected = await connect_session({ mocked, socket, input: { ...connect_request(), operations: 119 } });
			const command = { ...command_request(connected, "last-active-command"), operation: SCRIPT };
			expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
			const response = await mocked.session.fetch(
				new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(response.status).toBe(101);
			const child = response.webSocket as unknown as ChildSocket;
			child.send(
				JSON.stringify({
					id: 1,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				}),
			);
			child.send(
				JSON.stringify({
					id: 2,
					method: "Page.addScriptToEvaluateOnNewDocument",
					sessionId: "native-session",
					params: { source: "", worldName: "utility" },
				}),
			);
			socket.holdCleanup = true;
			const restarting = mocked.remote("/reconnect", {
				...connect_request(),
				previousSessionId: "session",
				sessionId: "fresh",
				attemptId: "fresh",
				paused: true,
				controlRevision: connected.controlRevision + 1,
			});
			await vi.waitFor(() => expect(socket.cleanupReply).not.toBeNull());
			const control =
				change === "Pause"
					? mocked.remote("/pause", {
							...SCOPE,
							generation: connected.generation,
							controlRevision: connected.controlRevision + 2,
						})
					: mocked.remote("/agent-access", {
							...SCOPE,
							generation: connected.generation,
							agentAccess: false,
							policyRevision: connected.policyRevision + 1,
							agentBlockedHosts: [],
						});
			await vi.advanceTimersByTimeAsync(1);
			socket.packet({ id: socket.cleanupReply, result: {} });
			expect((await restarting).reply).toMatchObject({ ok: false, error: { code: "recovery_changed" } });
			await control;
			const status = (await mocked.remote("/status", SCOPE)).reply;
			expect(status).toMatchObject({
				runtime: {
					sessionId: "session",
					generation: connected.generation,
					...(change === "Pause"
						? { state: "paused", controlRevision: connected.controlRevision + 2 }
						: { agentAccess: false, policyRevision: connected.policyRevision + 1 }),
				},
			});
			expect(fetch).toHaveBeenCalledOnce();
			expect(socket.inputCalls).toBe(0);
		},
	);

	it.each(["safe", "unsafe"] as const)("keeps one %s native drain shared by finish and Pause", async (drain) => {
		vi.stubGlobal("WebSocketPair", ChildSocketPair);
		vi.stubGlobal("Response", SocketResponse);
		const mocked = make_session();
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		const command = { ...command_request(connected, "finish-pause-drain"), operation: SCRIPT };
		expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
		const response = await mocked.session.fetch(
			new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		const child = response.webSocket as unknown as ChildSocket;
		child.send(
			JSON.stringify({
				id: 1,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			}),
		);
		child.send(
			JSON.stringify({
				id: 2,
				method: "Page.addScriptToEvaluateOnNewDocument",
				sessionId: "native-session",
				params: { source: "", worldName: "utility" },
			}),
		);
		socket.holdCleanup = true;

		// Finish waits for native script removal. Pause then waits for the same child drain.
		const finishing = mocked.post("/run/finish", {
			...SCOPE,
			request: receipt_identity(command),
			output: { script: { status: "succeeded", stateJson: null } },
		});
		await vi.waitFor(() => expect(socket.cleanupReply).not.toBeNull());
		const pausing = mocked.post("/pause", {
			...SCOPE,
			generation: connected.generation,
			controlRevision: connected.controlRevision + 1,
		});
		await vi.waitFor(async () =>
			expect((await mocked.post("/status", SCOPE)).reply).toMatchObject({ runtime: { state: "paused" } }),
		);
		if (drain === "safe") socket.packet({ id: socket.cleanupReply, result: {} });
		else await vi.advanceTimersByTimeAsync(5100);
		expect((await finishing).reply).toMatchObject({ status: "unknown", result: { ok: false } });
		await pausing;

		if (drain === "safe") {
			const fenced = (await mocked.post("/command-fence", receipt_identity(command))).reply;
			expect(child.readyState).toBe(3);
			expect(socket.readyState).toBe(1);
			expect(
				fenced,
				"Successful shared drain must remain usable as cleanup proof before the receipt deadline",
			).toMatchObject({
				status: "unknown",
				result: { cleanup: "complete" },
				runtime: { generation: connected.generation },
			});
			vi.setSystemTime(command.receiptResolutionDeadline + 1);
			expect(
				(await mocked.post("/command-status", receipt_identity(command))).reply,
				"Successful shared drain must remain usable as cleanup proof after the receipt deadline",
			).toMatchObject({
				status: "unknown",
				result: { cleanup: "complete" },
				runtime: { generation: connected.generation },
			});
			const resumed = (
				await mocked.post("/resume", {
					...SCOPE,
					generation: connected.generation,
					controlRevision: connected.controlRevision + 2,
				})
			).reply.runtime as typeof runtime;
			expect(
				(
					await mocked.post("/run/begin", {
						...command_request(resumed, "read-after-pause"),
						operation: SCRIPT,
					})
				).reply.execute,
				"The released command slot must accept a fresh Read after Resume",
			).toBe(true);
			return;
		}

		// The first waiter closed the socket and fenced its generation. The second must not undo that fence.
		expect(socket.readyState).toBe(3);
		expect((await mocked.post("/command-fence", receipt_identity(command))).reply).toMatchObject({
			status: "unknown",
			runtime: { generation: connected.generation + 1, state: "disconnected" },
		});
		expect(
			(await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation })).reply,
			"A fenced unsafe drain must not leave global cleanup unknown",
		).toMatchObject({ ok: true, runtime: { generation: connected.generation + 1 } });
		const newerSocket = new NativeSocket();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ status: 101, webSocket: newerSocket })),
		);
		const reconnecting = mocked.remote("/reconnect", {
			...connect_request(),
			previousSessionId: "session",
			sessionId: "fresh",
			attemptId: "fresh",
			paused: true,
			controlRevision: connected.controlRevision + 1,
		});
		await vi.advanceTimersByTimeAsync(300);
		expect((await reconnecting).reply, "Human Reconnect must work after a fenced unsafe drain").toMatchObject({
			ok: true,
			runtime: { generation: connected.generation + 2, state: "paused", sessionId: "fresh" },
		});
	});

	it("keeps a finished receipt when the deadline alarm waits for the same native drain", async () => {
		vi.stubGlobal("WebSocketPair", ChildSocketPair);
		vi.stubGlobal("Response", SocketResponse);
		const mocked = make_session();
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		const command = { ...command_request(connected, "finish-alarm-drain"), operation: SCRIPT };
		expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
		const response = await mocked.session.fetch(
			new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		const child = response.webSocket as unknown as ChildSocket;
		child.send(
			JSON.stringify({
				id: 1,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			}),
		);
		child.send(
			JSON.stringify({
				id: 2,
				method: "Page.addScriptToEvaluateOnNewDocument",
				sessionId: "native-session",
				params: { source: "", worldName: "utility" },
			}),
		);
		socket.holdCleanup = true;

		// Finish waits for native script removal. The deadline alarm then waits for the same child drain.
		const finishing = mocked.post("/run/finish", {
			...SCOPE,
			request: receipt_identity(command),
			output: { script: { status: "succeeded", stateJson: null } },
		});
		await vi.waitFor(() => expect(socket.cleanupReply).not.toBeNull());
		vi.setSystemTime(command.deadline);
		const alarming = mocked.session.alarm();
		await vi.advanceTimersByTimeAsync(10);
		socket.packet({ id: socket.cleanupReply, result: {} });
		expect((await finishing).reply).toMatchObject({ status: "completed", result: { ok: true, cleanup: "complete" } });
		await alarming;

		expect(
			(await mocked.post("/command-status", receipt_identity(command))).reply,
			"The deadline alarm must not replace a receipt that finish already wrote",
		).toMatchObject({ status: "completed", result: { ok: true, cleanup: "complete" } });
	});

	it("marks a command unknown when its deadline alarm runs before finish", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked, socket: new NativeSocket() });
		const command = { ...command_request(connected, "alarm-before-finish"), operation: SCRIPT };
		expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);

		vi.setSystemTime(command.deadline);
		await mocked.session.alarm();

		expect(
			(await mocked.post("/command-status", receipt_identity(command))).reply,
			"The deadline alarm must end a command that is still running",
		).toMatchObject({ status: "unknown", result: { ok: false, cleanup: "complete" } });
		expect(
			(
				await mocked.post("/run/finish", {
					...SCOPE,
					request: receipt_identity(command),
					output: { script: { status: "succeeded", stateJson: null } },
				})
			).reply,
		).toMatchObject({ status: "unknown" });
	});

	it("reports unknown for a lost boot instead of not started", async () => {
		const { post } = make_session();
		const request = { ...receipt(), generation: 5 };
		expect((await post("/command-status", request)).reply).toMatchObject({
			status: "unknown",
			runtime: { generation: 6 },
		});
	});

	it("refuses a receipt identity change and keeps settled acknowledgements", async () => {
		const { post } = make_session();
		const request = receipt();
		await post("/command-status", request);
		expect((await post("/command-status", { ...request, operationHash: "b".repeat(64) })).reply).toMatchObject({
			ok: false,
			error: { code: "receipt_mismatch" },
		});
		expect((await post("/command-ack", request)).reply.status).toBe("acknowledged");
		expect((await post("/command-status", request)).reply.status).toBe("acknowledged");
	});

	it("bounds receipts without deleting an unresolved identity", async () => {
		const { post } = make_session();
		for (let index = 0; index < 256; index++)
			expect((await post("/command-status", { ...receipt(), commandId: String(index) })).reply.status).toBe(
				"not_started",
			);
		expect((await post("/command-status", { ...receipt(), commandId: "overflow" })).reply).toMatchObject({
			error: { code: "receipt_capacity" },
		});
		expect((await post("/command-status", { ...receipt(), commandId: "0" })).reply.status).toBe("not_started");
	});

	it("keeps pause and access changes while disconnected", async () => {
		const { post } = make_session();
		expect((await post("/pause", { ...SCOPE, generation: 6, controlRevision: 5 })).reply).toMatchObject({
			runtime: { state: "paused", controlRevision: 5 },
		});
		expect(
			(
				await post("/agent-access", {
					...SCOPE,
					generation: 6,
					agentAccess: false,
					policyRevision: 2,
					agentBlockedHosts: ["blocked.test"],
				})
			).reply,
		).toMatchObject({ runtime: { state: "paused", agentAccess: false, policyRevision: 2 } });
		expect((await post("/resume", { ...SCOPE, generation: 6, controlRevision: 6 })).reply).toMatchObject({
			error: { code: "needs_human" },
		});
	});

	it("refuses another tenant before status or cleanup", async () => {
		const { post } = make_session();
		expect((await post("/disconnect", { ...SCOPE, workspaceId: "other" })).response.status).toBe(403);
	});

	it.each([false, true])(
		"permanently fences credential Forget before a delayed initial Connect (existing: %s)",
		async (existing) => {
			const mocked = make_session(existing ? undefined : new Map());
			if (existing) await connect_session({ mocked });
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ status: 101, webSocket: new NativeSocket() })),
			);
			const forgotten = await mocked.remote("/disconnect", SCOPE);
			expect(forgotten.reply, "Credential Forget must persist its fence before returning cleanup proof").toMatchObject({
				ok: false,
				error: { code: "connection_forgotten" },
			});
			expect(mocked.records.get("forgotten")).toMatchObject({ scope: SCOPE, cleanupComplete: true });
			for (const path of ["/connect", "/recover", "/reconnect"]) {
				expect(
					(
						await mocked.remote(path, {
							...connect_request(),
							...(path === "/reconnect" ? { previousSessionId: "session", sessionId: "next" } : {}),
						})
					).reply,
				).toMatchObject({ error: { code: "connection_forgotten" } });
			}
			expect(fetch).not.toHaveBeenCalled();
			const restarted = make_session(mocked.records);
			expect((await restarted.remote("/disconnect", SCOPE)).reply).toMatchObject({
				error: { code: "connection_forgotten" },
			});
			expect((await restarted.remote("/connect", connect_request())).reply).toMatchObject({
				error: { code: "connection_forgotten" },
			});
			expect((await restarted.remote("/disconnect", { ...SCOPE, workspaceId: "other" })).reply).toMatchObject({
				error: { code: "scope_refused" },
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("settles old exact-generation Disconnect without closing the newer socket", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation });
		const ended = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
		const newerSocket = new NativeSocket();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ status: 101, webSocket: newerSocket })),
		);
		const pending = mocked.remote("/reconnect", {
			...connect_request(),
			previousSessionId: "session",
			sessionId: "fresh",
			attemptId: "fresh",
			controlRevision: ended.controlRevision,
		});
		await vi.advanceTimersByTimeAsync(300);
		const newer = (await pending).reply.runtime as typeof runtime;
		const stale = (await mocked.remote("/disconnect", { ...SCOPE, generation: connected.generation })).reply;
		expect(stale, "A retired old generation must return cleanup proof without closing the new session").toMatchObject({
			ok: true,
			runtime: { generation: newer.generation, state: "connected", sessionId: "fresh" },
		});
		expect(newerSocket.readyState).toBe(1);
		expect((await mocked.remote("/disconnect", { ...SCOPE, generation: newer.generation + 1 })).reply).toMatchObject({
			error: { code: "stale_generation" },
		});
		expect(newerSocket.readyState).toBe(1);
	});

	it("fences failed native cleanup before finishing permanent Forget", async () => {
		vi.stubGlobal("WebSocketPair", ChildSocketPair);
		vi.stubGlobal("Response", SocketResponse);
		const mocked = make_session();
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		const command = { ...command_request(connected, "unsettled-forget"), operation: SCRIPT };
		expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
		const response = await mocked.session.fetch(
			new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		const child = response.webSocket as unknown as ChildSocket;
		child.send(
			JSON.stringify({
				id: 1,
				method: "Target.setAutoAttach",
				params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			}),
		);
		child.send(
			JSON.stringify({
				id: 2,
				method: "Page.addScriptToEvaluateOnNewDocument",
				sessionId: "native-session",
				params: { source: "", worldName: "utility" },
			}),
		);
		socket.holdCleanup = true;
		const pending = mocked.remote("/disconnect", SCOPE);
		await vi.advanceTimersByTimeAsync(5100);
		expect((await pending).reply, "Failed native cleanup must not return forgotten cleanup proof").toMatchObject({
			error: { code: "cleanup_unknown" },
		});
		expect(
			(await mocked.remote("/status", SCOPE)).reply,
			"A closed socket must fence the old native generation",
		).toMatchObject({ runtime: { generation: connected.generation + 1, state: "disconnected" } });
		expect(socket.readyState).toBe(3);
		expect((await mocked.remote("/disconnect", SCOPE)).reply).toMatchObject({
			error: { code: "connection_forgotten" },
		});
		expect(mocked.records.get("forgotten")).toMatchObject({ scope: SCOPE, cleanupComplete: true });
		expect(mocked.records.has("session")).toBe(false);
		expect(mocked.records.has("dialAttempts")).toBe(false);
		expect(socket.inputCalls).toBe(0);
		vi.setSystemTime(command.deadline + 1);
		expect(
			(await mocked.remote("/disconnect", SCOPE)).reply,
			"Permanent Forget must settle after the old fixed dispatch deadline",
		).toMatchObject({ error: { code: "connection_forgotten" } });
		expect((await mocked.remote("/connect", connect_request())).reply).toMatchObject({
			error: { code: "connection_forgotten" },
		});
		expect((await mocked.remote("/command-status", receipt_identity(command))).reply).toMatchObject({
			error: { code: "not_connected" },
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("cancels a held initial dial before the Forget storage write finishes", async () => {
		const mocked = make_session(new Map());
		const dial = Promise.withResolvers<{ status: number; webSocket: NativeSocket }>();
		const writeStarted = Promise.withResolvers<void>();
		const writeReleased = Promise.withResolvers<void>();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => dial.promise),
		);
		const put = mocked.put.getMockImplementation()!;
		mocked.put.mockImplementation(async (key, value) => {
			if (key === "forgotten" && !(value as { cleanupComplete: boolean }).cleanupComplete) {
				writeStarted.resolve();
				await writeReleased.promise;
			}
			await put(key, value);
		});
		const connecting = mocked.remote("/connect", { ...connect_request(), expectedTargetId: null });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const forgetting = mocked.remote("/disconnect", SCOPE);
		await writeStarted.promise;
		const socket = new NativeSocket();
		dial.resolve({ status: 101, webSocket: socket });
		try {
			await vi.advanceTimersByTimeAsync(300);
			expect(
				(await connecting).reply,
				"A held dial must be canceled before the Forget storage write finishes",
			).toMatchObject({ error: { code: "canceled" } });
			expect(socket.readyState).toBe(3);
			expect(socket.inputCalls).toBe(0);
		} finally {
			writeReleased.resolve();
		}
		expect((await forgetting).reply).toMatchObject({ error: { code: "connection_forgotten" } });
	});

	it.each(["/run/finish", "/command-fence"])(
		"fences unknown dispatch when %s closes the native socket",
		async (path) => {
			vi.stubGlobal("WebSocketPair", ChildSocketPair);
			vi.stubGlobal("Response", SocketResponse);
			const mocked = make_session();
			const socket = new NativeSocket();
			const connected = await connect_session({ mocked, socket });
			const command = { ...command_request(connected, "failed-before-forget"), operation: SCRIPT };
			expect((await mocked.post("/run/begin", command)).reply.execute).toBe(true);
			const response = await mocked.session.fetch(
				new Request(`https://do/command-socket?commandId=${command.commandId}&generation=${connected.generation}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			const child = response.webSocket as unknown as ChildSocket;
			child.send(
				JSON.stringify({
					id: 1,
					method: "Target.setAutoAttach",
					params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				}),
			);
			child.send(
				JSON.stringify({
					id: 2,
					method: "Page.addScriptToEvaluateOnNewDocument",
					sessionId: "native-session",
					params: { source: "", worldName: "utility" },
				}),
			);
			socket.holdCleanup = true;
			const pending =
				path === "/run/finish"
					? mocked.post(path, {
							...SCOPE,
							request: receipt_identity(command),
							output: { script: { status: "succeeded", stateJson: null } },
						})
					: mocked.remote(path, receipt_identity(command));
			await vi.advanceTimersByTimeAsync(5100);
			const finished = (await pending).reply;
			expect(finished, "Failed cleanup must keep effects unknown and return a newer dispatch fence").toMatchObject({
				status: "unknown",
				completedLease: null,
				result: { cleanup: "unknown" },
				runtime: { generation: connected.generation + 1, state: "disconnected" },
			});
			expect(socket.readyState).toBe(3);
			const calls = socket.inputCalls;
			child.send(
				JSON.stringify({
					id: 3,
					method: "Input.insertText",
					sessionId: "native-session",
					params: { text: "Late input" },
				}),
			);
			expect(socket.inputCalls, "The retired child must never dispatch late input").toBe(calls);
			const recovered = await connect_session({
				mocked,
				socket: new NativeSocket(),
				input: {
				...connect_request(),
				attemptId: "fenced-recovery",
				operations: 1,
				idleExpiresAt: connected.idleExpiresAt,
				totalExpiresAt: connected.totalExpiresAt,
			},
			});
			expect(recovered.generation).toBe(connected.generation + 2);
			expect(
				(
					await mocked.post("/run/begin", {
						...command_request(recovered, "read-after-fence"),
						operation: SCRIPT,
					})
				).reply.execute,
			).toBe(true);
			expect((await mocked.remote("/command-status", receipt_identity(command))).reply).toMatchObject({
				status: "unknown",
				completedLease: null,
				runtime: { generation: recovered.generation },
			});
			expect(fetch).toHaveBeenCalledOnce();
		},
	);

	it("finishes a no-command Forget after restart from its first saved fence", async () => {
		const mocked = make_session();
		await connect_session({ mocked });
		const put = mocked.put.getMockImplementation()!;
		mocked.put.mockImplementation(async (key, value) => {
			await put(key, structuredClone(value));
			if (key === "forgotten" && !(value as { cleanupComplete: boolean }).cleanupComplete)
				throw new Error("Object stopped after its first fence write");
		});
		await expect(mocked.remote("/disconnect", SCOPE)).rejects.toThrow("Object stopped after its first fence write");
		expect(mocked.records.get("forgotten")).toMatchObject({
			scope: SCOPE,
			cleanupComplete: false,
			dispatchDeadline: null,
		});
		const restarted = make_session(mocked.records);
		expect(
			(await restarted.remote("/disconnect", SCOPE)).reply,
			"The new boot must finish the saved no-command Forget fence",
		).toMatchObject({ error: { code: "connection_forgotten" } });
		expect((await restarted.remote("/connect", connect_request())).reply).toMatchObject({
			error: { code: "connection_forgotten" },
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("PlaywriterSession scripts", () => {
	function script_request(args: {
		connected: typeof runtime;
		commandId: string;
		chatId?: string;
	}) {
		const { connected, commandId, chatId = "chat" } = args;

		const request = command_request(connected, commandId);
		return {
			...request,
			source: { ...request.source, chatId },
			operation: { kind: "script", code: "state.n = (state.n ?? 0) + 1; return state.n;" },
		};
	}

	it("keeps script state per chat while the shared tab stays open", async () => {
		const mocked = make_session();
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		// A script may navigate during its command. Its emitted files come back with the completed receipt.
		mocked.evaluate.mockImplementationOnce(async () => {
			socket.navigate();
			return {
				...SCRIPT_RESULT,
				files: [{ workspace: "current", path: "/shot.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
			};
		});
		mocked.evaluate.mockResolvedValue(SCRIPT_RESULT);
		const first = (await mocked.remote("/run", script_request({ connected, commandId: "first-script" }))).reply;
		expect(first).toMatchObject({
			status: "completed",
			script: {
				status: "succeeded",
				resultJson: "1",
				files: [{ workspace: "current", path: "/shot.png", contentType: "image/png", dataBase64: "AQID" }],
			},
		});
		expect(playwriter_browser_response_schema.safeParse(first).success).toBe(true);
		expect(mocked.evaluate.mock.calls.at(-1)![0]).toEqual({
			endpointId: "first-script",
			mode: "shared",
			budgetMs: expect.any(Number),
			state: null,
		});

		const current = (await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime;
		await mocked.remote("/run", script_request({ connected: current, commandId: "second-script" }));
		expect(mocked.evaluate.mock.calls.at(-1)![0]).toMatchObject({ state: '{"n":1}' });
		await mocked.remote("/run", script_request({ connected: current, commandId: "other-chat", chatId: "other" }));
		expect(mocked.evaluate.mock.calls.at(-1)![0], "Another chat must not read this chat's state").toMatchObject({
			state: null,
		});

		socket.close();
		await vi.advanceTimersByTimeAsync(0);
		expect([...mocked.records.keys()].filter((key) => key.startsWith("scriptState:"))).toEqual([]);
	});

	it("returns nothing and saves no state when a script ends on a blocked site", async () => {
		const mocked = make_session();
		mocked.env.BROWSER_WEB_DENIED_HOSTS = "blocked.test";
		const socket = new NativeSocket();
		const connected = await connect_session({ mocked, socket });
		mocked.evaluate.mockImplementation(async () => {
			socket.packet({
				method: "forwardCDPEvent",
				params: {
					method: "Page.frameNavigated",
					sessionId: "native-session",
					params: { frame: { id: "main-frame", url: "https://blocked.test/" } },
				},
			});
			return SCRIPT_RESULT;
		});
		const reply = (await mocked.remote("/run", script_request({ connected, commandId: "blocked-script" }))).reply;
		expect(reply).toMatchObject({ status: "refused", result: { reason: "blocked_site" } });
		expect(reply).not.toHaveProperty("script");
		expect(mocked.records.has("scriptState:chat")).toBe(false);
	});

	it("keeps the connection when a script never answers", async () => {
		const mocked = make_session();
		const connected = await connect_session({ mocked });
		let started!: () => void;
		const began = new Promise<void>((resolve) => (started = resolve));
		mocked.evaluate.mockImplementation(() => {
			started();
			return new Promise(() => {});
		});
		const pending = mocked.remote("/run", script_request({ connected, commandId: "hung-script" }));
		await began;
		await vi.advanceTimersByTimeAsync(20_000);
		const reply = (await pending).reply;
		expect(reply).toMatchObject({ status: "unknown", result: { reason: "outcome_unknown", cleanup: "complete" } });
		expect(reply).not.toHaveProperty("script");
		expect(((await mocked.remote("/status", SCOPE)).reply.runtime as typeof runtime).state).toBe("connected");
	});
});
