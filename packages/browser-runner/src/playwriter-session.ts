import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { browser_web_normalize_url } from "common/browser-web-url.ts";
import {
	playwriter_browser_access_schema,
	playwriter_browser_confirm_schema,
	playwriter_browser_connect_schema,
	playwriter_browser_control_schema,
	playwriter_browser_disconnect_schema,
	playwriter_browser_observation_schema,
	playwriter_browser_receipt_request_schema,
	playwriter_browser_reconnect_schema,
	playwriter_browser_result_schema,
	playwriter_browser_run_schema,
	playwriter_browser_status_schema,
	type PlaywriterBrowserConnect,
	type PlaywriterBrowserCompletedLease,
	type PlaywriterBrowserReceiptRequest,
	type PlaywriterBrowserResult,
	type PlaywriterBrowserRun,
	type PlaywriterBrowserRuntime,
} from "common/playwriter-browser.ts";
import { CHILD_BUNDLE_JS } from "./child-bundle.gen";
import { PLAYWRITER_EXECUTOR_JS, PLAYWRITER_EXECUTOR_REVISION } from "./playwriter-executor";
import { PlaywriterTargetInventory, PlaywriterTransport } from "./playwriter-transport";

type Scope = Pick<PlaywriterBrowserConnect, "connectionId" | "ownerId" | "organizationId" | "workspaceId">;
type Namespace = {
	idFromName: (name: string) => { toString: () => string };
	get: (id: { toString: () => string }) => { fetch: (request: Request) => Promise<Response> };
};
type Storage = {
	get: <T>(key: string) => Promise<T | undefined>;
	put: (key: string, value: unknown) => Promise<void>;
	delete: (key: string) => Promise<unknown>;
	setAlarm: (time: number) => Promise<void>;
	deleteAlarm: () => Promise<void>;
};
type RemoteEnv = {
	PLAYWRITER_SESSIONS: Namespace;
	BROWSER_WEB_DENIED_HOSTS?: string;
	LOADER: {
		load: (code: {
			compatibilityDate: string;
			compatibilityFlags: string[];
			mainModule: string;
			modules: Record<string, string>;
			env: Record<string, unknown>;
			globalOutbound: null;
			limits: { cpuMs: number; subRequests: number };
		}) => { getEntrypoint: () => { evaluate: (input: unknown) => Promise<unknown>; revision?: () => Promise<string> } };
	};
};
export type PlaywriterGatewayProps = Scope & { generation: number; commandId: string };
type Context = {
	exports?: {
		PlaywriterConnectionGateway?: (options: { props: PlaywriterGatewayProps }) => {
			fetch: (request: Request) => Promise<Response> | Response;
		};
	};
};
type SavedSession = {
	scope: Scope;
	runtime: PlaywriterBrowserRuntime;
	blockedHosts: string[];
	allowedVersions: string[];
	attemptId: string;
	humanPaused: boolean;
};
type Receipt = {
	identity: PlaywriterBrowserReceiptRequest;
	payload: string | null;
	status: "in_progress" | "completed" | "refused" | "unknown" | "not_started" | "acknowledged";
	result: PlaywriterBrowserResult | null;
	completedLease: PlaywriterBrowserCompletedLease | null;
};

const private_fields_schema = z
	.array(
		z
			.object({
				tag: z.string().max(16),
				type: z.string().max(64).nullable(),
				value: z.string().max(16_384),
				label: z.string().max(500),
			})
			.strict(),
	)
	.max(128);
const finish_schema = z
	.object({
		result: playwriter_browser_result_schema,
		observation: playwriter_browser_observation_schema.optional(),
		privateFields: private_fields_schema.optional(),
	})
	.strict();
const unknown_result: PlaywriterBrowserResult = {
	ok: false,
	reason: "outcome_unknown",
	inputSent: false,
	cleanup: "unknown",
};

function same_scope(left: Scope, right: Scope) {
	return (
		left.connectionId === right.connectionId &&
		left.ownerId === right.ownerId &&
		left.organizationId === right.organizationId &&
		left.workspaceId === right.workspaceId
	);
}

function identity(input: PlaywriterBrowserReceiptRequest) {
	return JSON.stringify([
		input.connectionId,
		input.ownerId,
		input.organizationId,
		input.workspaceId,
		input.generation,
		input.commandId,
		input.operationHash,
		input.source,
		input.deadline,
		input.receiptResolutionDeadline,
	]);
}

function error(code: string, status = 409) {
	return Response.json({ ok: false, error: { code, message: code.replaceAll("_", " ") } }, { status });
}

function object_name(scope: Scope) {
	return `playwriter:${scope.ownerId}:${scope.organizationId}:${scope.workspaceId}:${scope.connectionId}`;
}

async function body(request: Request, limit = 64_000) {
	if (Number(request.headers.get("Content-Length")) > limit) throw new Error("body_limit");
	const raw = await request.text();
	if (new TextEncoder().encode(raw).byteLength > limit) throw new Error("body_limit");
	return JSON.parse(raw) as unknown;
}

async function bounded<T>(work: Promise<T>, timeout: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("deadline")), timeout);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function payload_hash(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PlaywriterSession {
	private saved: SavedSession | null = null;
	private forgotten: { scope: Scope; cleanupComplete: boolean; dispatchDeadline: number | null } | null = null;
	private cleanupUnknown = false;
	private cleanupDeadline: number | null = null;
	private initialized: Promise<void>;
	private socket: WebSocket | null = null;
	private inventory: PlaywriterTargetInventory | null = null;
	private transport: PlaywriterTransport | null = null;
	private version: string | null = null;
	private connectAttempt: string | null = null;
	private ping: ReturnType<typeof setInterval> | null = null;
	private lastPong = 0;
	private command: {
		request: PlaywriterBrowserRun;
		used: boolean;
		child: ReturnType<PlaywriterTransport["create_child"]> | null;
		observationRevision: string;
		completedNavRevision: number | null;
	} | null = null;
	private receipts = new Map<string, Receipt>();
	private observation: { revision: string; navRevision: number; fields: z.infer<typeof private_fields_schema> } | null =
		null;
	private dialAttempts: number[] = [];

	constructor(
		private state: { storage: Storage; waitUntil: (work: Promise<unknown>) => void },
		private env: RemoteEnv,
	) {
		this.initialized = this.initialize();
	}

	private async initialize() {
		this.forgotten = (await this.state.storage.get<typeof this.forgotten>("forgotten")) ?? null;
		if (this.forgotten && !this.forgotten.cleanupComplete) {
			if (this.forgotten.dispatchDeadline === null) {
				// The new boot has no old socket or command to drain.
				this.forgotten.cleanupComplete = true;
				await this.state.storage.put("forgotten", this.forgotten);
			} else {
				this.cleanupUnknown = true;
				this.cleanupDeadline = this.forgotten.dispatchDeadline;
			}
		}
		this.dialAttempts = (await this.state.storage.get<number[]>("dialAttempts")) ?? [];
		const saved = await this.state.storage.get<SavedSession>("session");
		if (!saved) return;
		// A new object cannot prove old receipts or retain the old socket.
		saved.runtime.generation += 1;
		saved.runtime.navRevision += 1;
		saved.runtime.targetRevision += 1;
		saved.runtime.state = "disconnected";
		saved.runtime.targets = [];
		saved.runtime.inventoryRevision += 1;
		this.saved = saved;
		await this.persist();
	}

	private async persist() {
		if (this.forgotten?.cleanupComplete) {
			// Keep only the permanent replay fence after owner Forget.
			this.saved = null;
			this.receipts.clear();
			this.dialAttempts = [];
			await this.state.storage.delete("session");
			await this.state.storage.delete("dialAttempts");
			await this.state.storage.deleteAlarm();
			return;
		}
		if (!this.saved) return;
		// Target titles and URLs are only live status. The private confirmed id may persist.
		await this.state.storage.put("session", { ...this.saved, runtime: { ...this.saved.runtime, targets: [] } });
		await this.state.storage.setAlarm(
			Math.min(
				this.saved.runtime.idleExpiresAt,
				this.saved.runtime.totalExpiresAt,
				this.command?.request.deadline ?? Infinity,
			),
		);
	}

	private runtime() {
		if (!this.saved) throw new Error("not_connected");
		return this.saved.runtime;
	}

	private response(receipt?: Receipt) {
		return Response.json(
			receipt
				? {
						ok: true,
						status: receipt.status,
						runtime: this.runtime(),
						completedLease: receipt.completedLease,
						result: receipt.result,
					}
				: { ok: true, runtime: this.runtime() },
		);
	}

	private close_socket(next: PlaywriterBrowserRuntime["state"]) {
		this.connectAttempt = null;
		this.command?.child?.revoke();
		this.transport?.close();
		const socket = this.socket;
		this.socket = null;
		this.transport = null;
		this.inventory = null;
		this.version = null;
		this.observation = null;
		if (this.ping) clearInterval(this.ping);
		this.ping = null;
		try {
			socket?.close(1000, "connection ended");
		} catch {
			/* Already closed. */
		}
		if (this.saved) {
			this.saved.runtime.state = next;
			this.saved.runtime.targets = [];
			this.saved.runtime.inventoryRevision += 1;
		}
	}

	private blocked_hosts() {
		// System rules stay current and are never saved as user preferences.
		return [
			...(this.saved?.blockedHosts ?? []),
			...(this.env.BROWSER_WEB_DENIED_HOSTS ?? "")
				.split(",")
				.map((host) => host.trim())
				.filter((host) => host !== ""),
		];
	}

	private target_allowed() {
		const current = this.saved;
		if (!current || !this.inventory?.ready) return false;
		const root = this.inventory.roots.find((item) => item.targetId === current.runtime.confirmedTargetId);
		const url = this.transport?.url ?? root?.targetInfo.url;
		return !!root && !!url && (url === "about:blank" || browser_web_normalize_url(url, this.blocked_hosts()).ok);
	}

	private command_allowed() {
		const command = this.command;
		if (!command || !this.saved) return false;
		const runtime = this.saved.runtime;
		const request = command.request;
		return (
			runtime.state === "connected" &&
			runtime.agentAccess &&
			!!this.version &&
			request.allowedVersions.includes(this.version) &&
			Date.now() < request.deadline &&
			request.generation === runtime.generation &&
			request.controlRevision === runtime.controlRevision &&
			request.policyRevision === runtime.policyRevision &&
			request.selectionRevision === runtime.selectionRevision &&
			request.targetRevision === runtime.targetRevision &&
			(request.operation.kind === "navigate" || request.navRevision === runtime.navRevision) &&
			this.target_allowed()
		);
	}

	private invalidate_navigation() {
		if (!this.saved) return;
		this.saved.runtime.navRevision += 1;
		this.observation = null;
		const outcome = this.command?.child?.outcome();
		if (this.command && this.command.completedNavRevision === null && outcome?.guarded && outcome.navigated)
			this.command.completedNavRevision = this.saved.runtime.navRevision;
		// Stop old utility work before a late context reply can resume it.
		if (this.command?.request.operation.kind !== "navigate" && !this.command?.child?.outcome().guarded)
			this.command?.child?.revoke();
		this.state.waitUntil(this.persist());
	}

	private confirm_target(targetId: string) {
		if (!this.inventory?.ready || !this.socket || !this.saved) return false;
		const root = this.inventory.roots.find((item) => item.targetId === targetId);
		if (
			!root ||
			(root.targetInfo.url !== "about:blank" &&
				!browser_web_normalize_url(root.targetInfo.url, this.blocked_hosts()).ok)
		)
			return false;
		// No await between checked inventory and listener registration.
		const socket = this.socket;
		const transport = new PlaywriterTransport({
			socket,
			...this.inventory.snapshot(root),
			onUnsafe: () => {
				this.close_socket("needs_human");
				this.state.waitUntil(this.persist());
			},
			onEvent: () => {
				if (!this.saved) return;
				this.saved.runtime.state = "needs_human";
				this.saved.runtime.controlRevision += 1;
				this.command?.child?.revoke();
				this.state.waitUntil(this.persist());
			},
			onNavigation: () => this.invalidate_navigation(),
			canSendInput: () => this.command_allowed(),
		});
		if (this.socket !== socket) {
			transport.close();
			return false;
		}
		this.transport = transport;
		this.saved.runtime.confirmedTargetId = targetId;
		this.saved.runtime.targetRevision += 1;
		return true;
	}

	private async connect(input: PlaywriterBrowserConnect, previousSessionId?: string) {
		if (this.cleanupUnknown) return error("cleanup_unknown");
		if (this.connectAttempt || (this.command && previousSessionId === undefined)) return error("busy");
		if (this.saved?.attemptId === input.attemptId && this.saved.runtime.sessionId === input.sessionId)
			return this.response();
		const now = Date.now();
		if (previousSessionId !== undefined) {
			const previous = this.saved;
			// Reconnect can carry a newer human Pause before its old HTTP call arrives.
			if (
				!previous ||
				previous.runtime.sessionId !== previousSessionId ||
				input.sessionId === previousSessionId ||
				input.expectedTargetId !== previous.runtime.confirmedTargetId ||
				input.controlRevision < previous.runtime.controlRevision ||
				input.policyRevision < previous.runtime.policyRevision ||
				input.selectionRevision < previous.runtime.selectionRevision ||
				(input.controlRevision === previous.runtime.controlRevision && input.paused !== previous.humanPaused) ||
				(input.policyRevision === previous.runtime.policyRevision && input.agentAccess !== previous.runtime.agentAccess)
			)
				return error("recovery_changed");
			if (
				!["disconnected", "expired", "failed"].includes(previous.runtime.state) &&
				previous.runtime.operations < 120 &&
				previous.runtime.totalExpiresAt > now
			)
				return error("busy");
		} else if (
			this.saved &&
			(input.sessionId !== this.saved.runtime.sessionId ||
				input.expectedTargetId !== this.saved.runtime.confirmedTargetId ||
				input.operations < this.saved.runtime.operations ||
				input.totalExpiresAt > this.saved.runtime.totalExpiresAt ||
				input.controlRevision < this.saved.runtime.controlRevision ||
				input.policyRevision < this.saved.runtime.policyRevision ||
				input.selectionRevision < this.saved.runtime.selectionRevision)
		)
			return error("recovery_changed");
		this.dialAttempts = this.dialAttempts.filter((at) => now - at < 30_000);
		if (this.dialAttempts.length >= 3) return error("rate_limited", 429);
		if (
			input.operations >= 120 ||
			input.totalExpiresAt <= now ||
			input.totalExpiresAt > now + 3_600_000 ||
			input.idleExpiresAt <= now ||
			input.idleExpiresAt > now + 600_000 ||
			input.idleExpiresAt > input.totalExpiresAt
		)
			return error("expired");
		if (previousSessionId !== undefined) {
			const previous = this.saved!;
			const controlRevision = previous.runtime.controlRevision;
			const policyRevision = previous.runtime.policyRevision;
			const selectionRevision = previous.runtime.selectionRevision;
			this.connectAttempt = input.attemptId;
			const safe = await this.retire_command();
			if (
				this.connectAttempt !== input.attemptId ||
				this.saved !== previous ||
				previous.runtime.sessionId !== previousSessionId
			)
				return error("canceled");
			this.connectAttempt = null;
			if (!safe) return error("cleanup_unknown");
			if (
				previous.runtime.controlRevision !== controlRevision ||
				previous.runtime.policyRevision !== policyRevision ||
				previous.runtime.selectionRevision !== selectionRevision
			)
				return error("recovery_changed");
			this.receipts.clear();
		}
		this.close_socket("disconnected");
		const previous = this.saved?.runtime;
		this.saved = {
			scope: {
				connectionId: input.connectionId,
				ownerId: input.ownerId,
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
			},
			blockedHosts: input.agentBlockedHosts,
			allowedVersions: input.allowedVersions,
			attemptId: input.attemptId,
			humanPaused: input.paused,
			runtime: {
				generation: (previous?.generation ?? 0) + 1,
				state: "connecting",
				targets: [],
				targetRevision: (previous?.targetRevision ?? 0) + 1,
				navRevision: (previous?.navRevision ?? 0) + 1,
				confirmedTargetId: input.expectedTargetId,
				controlRevision: input.controlRevision,
				policyRevision: input.policyRevision,
				selectionRevision: input.selectionRevision,
				agentAccess: input.agentAccess,
				operations: input.operations,
				idleExpiresAt: input.idleExpiresAt,
				totalExpiresAt: input.totalExpiresAt,
				sessionId: input.sessionId,
				inventoryRevision: (previous?.inventoryRevision ?? 0) + 1,
			},
		};
		// Scope excludes credentials. Reserve the attempt and generation before dialing.
		this.connectAttempt = input.attemptId;
		this.dialAttempts.push(now);
		await this.state.storage.put("dialAttempts", this.dialAttempts);
		await this.persist();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 10_000);
		let response: Response;
		try {
			response = await fetch(`https://playwriter.dev/tunnel/${input.shareId}/extension`, {
				headers: { Upgrade: "websocket" },
				redirect: "manual",
				signal: abort.signal,
			});
		} catch {
			if (this.connectAttempt !== input.attemptId) return error("canceled");
			this.close_socket("failed");
			await this.persist();
			return error("dial_failed", 502);
		} finally {
			clearTimeout(timer);
		}
		if (this.connectAttempt !== input.attemptId) {
			response.webSocket?.accept();
			response.webSocket?.close(1000, "canceled");
			return error("canceled");
		}
		if (response.status !== 101 || !response.webSocket) {
			this.close_socket("failed");
			await this.persist();
			return error(response.status === 429 ? "rate_limited" : "dial_failed", response.status === 429 ? 429 : 502);
		}
		const socket = response.webSocket;
		if (this.connectAttempt !== input.attemptId) {
			socket.accept();
			socket.close(1000, "canceled");
			return error("canceled");
		}
		const inventory = new PlaywriterTargetInventory();
		this.socket = socket;
		this.inventory = inventory;
		this.lastPong = Date.now();
		let helloAt = 0;
		let quietAt = Date.now() + 250;
		socket.addEventListener("message", (event) => {
			if (this.socket !== socket || !this.saved) return;
			this.lastPong = Date.now();
			if (!inventory.consume(event.data)) {
				this.close_socket("needs_human");
				this.state.waitUntil(this.persist());
				return;
			}
			let packet: unknown;
			try {
				packet = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (typeof packet !== "object" || packet === null || Array.isArray(packet)) return;
			const message = packet as Record<string, unknown>;
			const params =
				typeof message.params === "object" && message.params !== null
					? (message.params as Record<string, unknown>)
					: {};
			if (message.method === "hello" && typeof params.version === "string" && params.version.length <= 32) {
				this.version = params.version;
				helloAt = Date.now();
			}
			if (message.method === "ping") {
				try {
					socket.send(JSON.stringify({ method: "pong" }));
				} catch {
					/* Health check closes it. */
				}
			}
			if (
				message.method === "forwardCDPEvent" &&
				["Target.attachedToTarget", "Target.detachedFromTarget", "Target.targetInfoChanged"].includes(
					String(params.method),
				)
			) {
				quietAt = Date.now() + 250;
				this.saved.runtime.inventoryRevision += 1;
				this.saved.runtime.targets = inventory.roots.map((item) => ({
					targetId: item.targetId,
					title: item.targetInfo.title.slice(0, 1024),
					url: item.targetInfo.url.slice(0, 8192),
				}));
			}
		});
		socket.addEventListener("close", () => {
			if (this.socket !== socket) return;
			this.close_socket("disconnected");
			this.state.waitUntil(this.persist());
		});
		socket.addEventListener("error", () => {
			if (this.socket !== socket) return;
			this.close_socket("disconnected");
			this.state.waitUntil(this.persist());
		});
		socket.accept();
		this.ping = setInterval(() => {
			if (this.socket !== socket) return;
			if (Date.now() - this.lastPong > 60_000) {
				this.close_socket("disconnected");
				this.state.waitUntil(this.persist());
				return;
			}
			try {
				socket.send(JSON.stringify({ method: "ping" }));
			} catch {
				this.close_socket("disconnected");
				this.state.waitUntil(this.persist());
			}
		}, 30_000);
		const deadline = now + 15_000;
		while (
			this.socket === socket &&
			this.connectAttempt === input.attemptId &&
			Date.now() < deadline &&
			(!helloAt || !inventory.ready || Date.now() < Math.min(quietAt, helloAt + 2000))
		)
			await new Promise((resolve) => setTimeout(resolve, 50));
		if (this.socket !== socket || this.connectAttempt !== input.attemptId) return error("canceled");
		if (Date.now() >= deadline || !inventory.ready) {
			this.close_socket("failed");
			await this.persist();
			return error("startup_deadline");
		}
		this.connectAttempt = null;
		if (!this.version || !input.allowedVersions.includes(this.version)) {
			this.close_socket("needs_human");
			await this.persist();
			return error("unsupported_version");
		}
		if (input.expectedTargetId) {
			if (!this.confirm_target(input.expectedTargetId)) {
				this.close_socket("needs_human");
				await this.persist();
				return error("target_changed");
			}
			this.saved.runtime.state = this.saved.humanPaused ? "paused" : "connected";
		} else this.saved.runtime.state = "awaiting_confirmation";
		await this.persist();
		return this.response();
	}

	private reserve(input: PlaywriterBrowserReceiptRequest, payload: string | null) {
		const now = Date.now();
		for (const [key, receipt] of this.receipts)
			if (receipt.result?.cleanup === "complete" && receipt.identity.receiptResolutionDeadline < now)
				this.receipts.delete(key);
		if (
			input.deadline > now + 30_000 ||
			input.receiptResolutionDeadline < input.deadline ||
			input.receiptResolutionDeadline > input.deadline + 5000
		)
			return null;
		const receipt: Receipt = {
			identity: {
				connectionId: input.connectionId,
				ownerId: input.ownerId,
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
				generation: input.generation,
				commandId: input.commandId,
				operationHash: input.operationHash,
				source: input.source,
				deadline: input.deadline,
				receiptResolutionDeadline: input.receiptResolutionDeadline,
			},
			payload,
			status: payload === null ? "not_started" : "in_progress",
			result:
				payload === null ? { ok: false, reason: "not_started", inputSent: false, cleanup: "complete" } : unknown_result,
			completedLease: null,
		};
		const bytes = new TextEncoder().encode(JSON.stringify([...this.receipts.values(), receipt])).byteLength;
		if (this.receipts.size >= 256 || bytes > 262_144) return null;
		this.receipts.set(input.commandId, receipt);
		return receipt;
	}

	private async settle(commandId: string) {
		const command = this.command;
		if (!command || command.request.commandId !== commandId) return true;
		command.child?.revoke();
		const safe = command.child ? await command.child.settle(5000) : { safe: true };
		// Several callers can wait for the same child drain, for example finish, fence, and Pause. The
		// first waiter clears the command. After an unsafe drain it also closes the socket and advances
		// the generation. A later waiter only reports the shared result, and it must not touch a
		// successor command.
		if (this.command !== command) return safe.safe;
		this.command = null;
		if (!safe.safe) {
			this.cleanupDeadline = command.request.deadline;
			this.close_socket("disconnected");
			// Earlier effects and held input stay unknown. The old socket cannot dispatch again.
			this.runtime().generation += 1;
			await this.persist();
		}
		return safe.safe;
	}

	private async retire_command() {
		this.observation = null;
		const command = this.command;
		if (!command) return !this.cleanupUnknown;
		const receipt = this.receipts.get(command.request.commandId);
		if (receipt) {
			receipt.status = "unknown";
			receipt.result = { ...unknown_result, inputSent: command.used };
		}
		const safe = await this.settle(command.request.commandId);
		if (receipt)
			receipt.result = { ...unknown_result, inputSent: command.used, cleanup: safe ? "complete" : "unknown" };
		return safe;
	}

	async fetch(request: Request): Promise<Response> {
		await this.initialized;
		const url = new URL(request.url);
		if (url.pathname === "/command-socket") {
			if (
				request.method !== "GET" ||
				request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
				!this.command_allowed() ||
				this.command?.used ||
				url.searchParams.get("commandId") !== this.command?.request.commandId ||
				url.searchParams.get("generation") !== String(this.runtime().generation) ||
				!this.transport
			)
				return error("forbidden", 403);
			this.command!.used = true;
			try {
				this.command!.child = this.transport.create_child({
					deadline: this.command!.request.deadline,
					guardBinding: `__bonobo_guard_${this.command!.observationRevision}`,
				});
			} catch {
				return error("connection_unavailable");
			}
			return new Response(null, { status: 101, webSocket: this.command!.child!.webSocket });
		}
		if (request.method !== "POST") return error("method", 405);
		let input: unknown;
		try {
			input = await body(request, url.pathname === "/run/finish" ? 3_000_000 : 64_000);
		} catch {
			return error("invalid_body", 400);
		}
		const scope = playwriter_browser_status_schema.strip().safeParse(input);
		if (
			!scope.success ||
			(this.saved && !same_scope(scope.data, this.saved.scope)) ||
			(this.forgotten && !same_scope(scope.data, this.forgotten.scope))
		)
			return error("scope_refused", 403);
		if (this.forgotten && ["/connect", "/recover", "/reconnect"].includes(url.pathname))
			return error("connection_forgotten", 410);
		if (["/connect", "/recover"].includes(url.pathname)) {
			const parsed = playwriter_browser_connect_schema.safeParse(input);
			return parsed.success ? this.connect(parsed.data) : error("invalid_body", 400);
		}
		if (url.pathname === "/reconnect") {
			const parsed = playwriter_browser_reconnect_schema.safeParse(input);
			return parsed.success ? this.connect(parsed.data, parsed.data.previousSessionId) : error("invalid_body", 400);
		}
		if (!this.saved) {
			if (url.pathname !== "/disconnect") return error("not_connected", 404);
			const parsed = playwriter_browser_disconnect_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (parsed.data.generation !== undefined) return error("not_connected", 404);
			if (
				this.forgotten &&
				!this.forgotten.cleanupComplete &&
				(this.forgotten.dispatchDeadline === null || Date.now() < this.forgotten.dispatchDeadline)
			)
				return error("cleanup_unknown");
			this.forgotten = {
				scope: scope.data,
				cleanupComplete: true,
				dispatchDeadline: this.forgotten?.dispatchDeadline ?? null,
			};
			await this.state.storage.put("forgotten", this.forgotten);
			await this.persist();
			return error("connection_forgotten", 410);
		}
		const runtime = this.runtime();
		if (url.pathname === "/status")
			return playwriter_browser_status_schema.safeParse(input).success ? this.response() : error("invalid_body", 400);
		if (url.pathname === "/disconnect") {
			const parsed = playwriter_browser_disconnect_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (parsed.data.generation !== undefined && parsed.data.generation > runtime.generation)
				return error("stale_generation");
			if (parsed.data.generation !== undefined && parsed.data.generation < runtime.generation)
				return this.cleanupUnknown ? error("cleanup_unknown") : this.response();
			if (parsed.data.generation === undefined) {
				if (this.forgotten?.cleanupComplete) return error("connection_forgotten", 410);
				// Forget is permanent. Fence late dials before cleanup waits.
				this.forgotten = {
					scope: scope.data,
					cleanupComplete: false,
					dispatchDeadline: this.forgotten?.dispatchDeadline ?? this.command?.request.deadline ?? this.cleanupDeadline,
				};
				this.connectAttempt = null;
				runtime.state = "disconnected";
				this.command?.child?.revoke();
				await this.state.storage.put("forgotten", this.forgotten);
			}
			runtime.state = "disconnected";
			const safe = await this.retire_command();
			this.close_socket("disconnected");
			if (!safe) {
				// This proves no future dispatch after expiry, not known earlier effects.
				if (
					parsed.data.generation === undefined &&
					this.forgotten &&
					this.forgotten.dispatchDeadline !== null &&
					Date.now() >= this.forgotten.dispatchDeadline
				) {
					this.forgotten.cleanupComplete = true;
					await this.state.storage.put("forgotten", this.forgotten);
					await this.persist();
					return error("connection_forgotten", 410);
				}
				await this.persist();
				return error("cleanup_unknown");
			}
			runtime.generation += 1;
			runtime.controlRevision += 1;
			if (this.forgotten) {
				this.forgotten.cleanupComplete = true;
				await this.state.storage.put("forgotten", this.forgotten);
				await this.persist();
				return error("connection_forgotten", 410);
			}
			await this.persist();
			return this.response();
		}
		if (
			Date.now() >= Math.min(runtime.idleExpiresAt, runtime.totalExpiresAt) &&
			!["/command-status", "/command-fence", "/command-ack", "/agent-access"].includes(url.pathname)
		) {
			this.close_socket("expired");
			await this.persist();
			return error("expired");
		}
		if (url.pathname === "/confirm") {
			const parsed = playwriter_browser_confirm_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (
				this.connectAttempt ||
				runtime.state !== "awaiting_confirmation" ||
				parsed.data.generation !== runtime.generation ||
				parsed.data.inventoryRevision !== runtime.inventoryRevision
			)
				return error("stale_inventory");
			if (!this.confirm_target(parsed.data.targetId)) return error("invalid_target");
			runtime.state = this.saved.humanPaused ? "paused" : "connected";
			await this.persist();
			return this.response();
		}
		if (url.pathname === "/pause" || url.pathname === "/resume") {
			const parsed = playwriter_browser_control_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (parsed.data.generation !== runtime.generation || parsed.data.controlRevision < runtime.controlRevision)
				return error("stale_control");
			if (url.pathname === "/resume" && (!this.transport || !this.target_allowed() || this.command))
				return error("needs_human");
			runtime.controlRevision = parsed.data.controlRevision;
			if (url.pathname === "/pause") {
				this.saved.humanPaused = true;
				runtime.state = "paused";
				await this.retire_command();
			} else {
				this.saved.humanPaused = false;
				runtime.state = "connected";
			}
			await this.persist();
			return this.response();
		}
		if (url.pathname === "/agent-access") {
			const parsed = playwriter_browser_access_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (
				parsed.data.generation !== runtime.generation ||
				parsed.data.policyRevision < runtime.policyRevision ||
				parsed.data.selectionRevision < runtime.selectionRevision
			)
				return error("stale_policy");
			if (
				runtime.policyRevision === parsed.data.policyRevision &&
				runtime.selectionRevision === parsed.data.selectionRevision &&
				runtime.agentAccess === parsed.data.agentAccess &&
				JSON.stringify(this.saved.blockedHosts) === JSON.stringify(parsed.data.agentBlockedHosts)
			)
				return this.response();
			runtime.agentAccess = parsed.data.agentAccess;
			runtime.policyRevision = parsed.data.policyRevision;
			runtime.selectionRevision = parsed.data.selectionRevision;
			this.saved.blockedHosts = parsed.data.agentBlockedHosts;
			await this.retire_command();
			await this.persist();
			return this.response();
		}
		if (["/command-status", "/command-fence", "/command-ack"].includes(url.pathname)) {
			const parsed = playwriter_browser_receipt_request_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			if (parsed.data.generation !== runtime.generation)
				return Response.json({ ok: true, status: "unknown", runtime, completedLease: null, result: unknown_result });
			let receipt = this.receipts.get(parsed.data.commandId);
			if (receipt && identity(receipt.identity) !== identity(parsed.data)) return error("receipt_mismatch");
			// Late replies can prove cleanup, never recover an old action or observation.
			if (Date.now() > parsed.data.receiptResolutionDeadline) {
				if (receipt) {
					receipt.status = "unknown";
					receipt.completedLease = null;
					receipt.result = {
						...unknown_result,
						inputSent: receipt.result?.inputSent ?? false,
						cleanup: receipt.result?.cleanup ?? "unknown",
					};
					if (this.command?.request.commandId === parsed.data.commandId) {
						receipt.result.inputSent = this.command.used;
						if (await this.settle(parsed.data.commandId)) receipt.result.cleanup = "complete";
						this.observation = null;
						await this.persist();
					}
				}
				return Response.json({
					ok: true,
					status: "unknown",
					runtime,
					completedLease: null,
					result: receipt?.result ?? unknown_result,
				});
			}
			if (!receipt) receipt = this.reserve(parsed.data, null) ?? undefined;
			if (!receipt) return error("receipt_capacity");
			if (url.pathname === "/command-fence" && receipt.status === "in_progress") {
				receipt.status = "unknown";
				receipt.result = { ...unknown_result, inputSent: this.command?.used ?? false };
				if (await this.settle(parsed.data.commandId)) receipt.result = { ...receipt.result, cleanup: "complete" };
				this.observation = null;
				await this.persist();
			}
			if (url.pathname === "/command-ack") {
				if (receipt.status === "in_progress") return error("in_progress");
				receipt.status = "acknowledged";
			}
			return this.response(receipt);
		}
		if (url.pathname === "/run/begin") {
			const parsed = playwriter_browser_run_schema.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			const command = parsed.data;
			const payload = payload_hash(
				JSON.stringify([
					command.operation,
					command.targetId,
					command.controlRevision,
					command.policyRevision,
					command.selectionRevision,
					command.targetRevision,
					command.navRevision,
				]),
			);
			const existing = this.receipts.get(command.commandId);
			if (existing)
				return identity(existing.identity) === identity(command) &&
					(existing.payload === null || existing.payload === (await payload))
					? this.response(existing)
					: error("receipt_mismatch");
			if (command.generation !== runtime.generation || Date.now() >= command.deadline) return error("stale_generation");
			if (this.command) return error("busy");
			let consumedAck: PlaywriterBrowserReceiptRequest | undefined;
			if (command.lastResolved) {
				const ack = this.receipts.get(command.lastResolved.commandId);
				if (
					!same_scope(command.lastResolved, this.saved.scope) ||
					!ack ||
					identity(ack.identity) !== identity(command.lastResolved) ||
					ack.status === "in_progress"
				)
					return error("ack_refused");
				ack.status = "acknowledged";
				consumedAck = command.lastResolved;
			}
			const receipt = this.reserve(command, "pending");
			if (!receipt) return error("receipt_capacity");
			receipt.payload = await payload;
			const refuse = (reason: string) => {
				receipt.status = "refused";
				receipt.result = { ok: false, reason, inputSent: false, cleanup: "complete" };
				return this.response(receipt);
			};
			if (
				this.command ||
				command.generation !== runtime.generation ||
				Date.now() >= command.deadline ||
				receipt.status !== "in_progress"
			)
				return refuse("stale_command");
			if (
				runtime.state !== "connected" ||
				!runtime.agentAccess ||
				!this.transport ||
				!this.version ||
				!command.allowedVersions.includes(this.version)
			)
				return refuse("agent_unavailable");
			if (
				command.targetId !== runtime.confirmedTargetId ||
				command.controlRevision !== runtime.controlRevision ||
				command.policyRevision !== runtime.policyRevision ||
				command.selectionRevision !== runtime.selectionRevision ||
				command.targetRevision !== runtime.targetRevision ||
				command.navRevision !== runtime.navRevision
			)
				return refuse("stale_lease");
			if (!this.target_allowed()) return refuse("blocked_site");
			if (runtime.operations >= 120) return refuse("operation_limit");
			if (
				(command.operation.kind === "act" || command.operation.kind === "navigate") &&
				(!this.observation ||
					this.observation.navRevision !== runtime.navRevision ||
					this.observation.revision !== command.operation.lastObservationRevision)
			)
				return refuse("stale_observation");
			if (
				command.operation.kind === "navigate" &&
				!browser_web_normalize_url(command.operation.url, this.blocked_hosts()).ok
			)
				return refuse("blocked_site");
			this.command = {
				request: command,
				used: false,
				child: null,
				observationRevision: crypto.randomUUID(),
				completedNavRevision: null,
			};
			runtime.operations += 1;
			runtime.idleExpiresAt = Math.min(Date.now() + 600_000, runtime.totalExpiresAt);
			await this.persist();
			return Response.json({
				ok: true,
				execute: true,
				runtime,
				observationRevision: this.command.observationRevision,
				privateFields: this.observation?.fields ?? [],
				blockedHosts: this.blocked_hosts(),
				...(consumedAck ? { consumedAck } : {}),
			});
		}
		if (url.pathname === "/run/finish") {
			const parsed = playwriter_browser_status_schema
				.extend({ request: playwriter_browser_receipt_request_schema, output: finish_schema })
				.strict()
				.safeParse(input);
			if (!parsed.success) return error("invalid_body", 400);
			const receipt = this.receipts.get(parsed.data.request.commandId);
			if (!receipt || identity(receipt.identity) !== identity(parsed.data.request)) return error("receipt_mismatch");
			if (receipt.status !== "in_progress") return this.response(receipt);
			const command = this.command;
			if (!command || command.request.commandId !== receipt.identity.commandId) return error("wrong_command");
			const output = parsed.data.output;
			// Cleanup can wait for native replies while the human navigates.
			const completedLease =
				runtime.confirmedTargetId === null
					? null
					: {
							generation: runtime.generation,
							controlRevision: runtime.controlRevision,
							policyRevision: runtime.policyRevision,
							selectionRevision: runtime.selectionRevision,
							confirmedTargetId: runtime.confirmedTargetId,
							targetRevision: runtime.targetRevision,
							navRevision: runtime.navRevision,
						};
			const settled = await this.settle(command.request.commandId);
			if (receipt.status !== "in_progress") return this.response(receipt);
			const guarded = command.child?.outcome();
			const navigated =
				command.request.operation.kind === "act" &&
				(command.request.operation.action === "click" ||
					(command.request.operation.action === "press" && command.request.operation.key === "Enter")) &&
				guarded?.guarded &&
				guarded.navigated &&
				(guarded.destroyed || output.result.cleanup === "complete") &&
				output.result.reason !== "blocked_site";
			const safe =
				settled &&
				!!this.transport &&
				this.socket !== null &&
				runtime.state === "connected" &&
				runtime.generation === command.request.generation &&
				runtime.confirmedTargetId === command.request.targetId &&
				runtime.controlRevision === command.request.controlRevision &&
				runtime.policyRevision === command.request.policyRevision &&
				runtime.selectionRevision === command.request.selectionRevision &&
				runtime.targetRevision === command.request.targetRevision &&
				this.target_allowed() &&
				(command.request.operation.kind === "navigate" ||
					navigated ||
					runtime.navRevision === command.request.navRevision);
			// A changed lease invalidates the outcome, not completed cleanup.
			const result: PlaywriterBrowserResult =
				safe && navigated
					? { ok: true, reason: null, inputSent: true, cleanup: "complete" }
					: safe
						? output.result
						: {
								...output.result,
								ok: false,
								reason: "outcome_unknown",
								cleanup: settled ? output.result.cleanup : "unknown",
							};
			receipt.result = result;
			receipt.status =
				result.cleanup === "unknown" || result.reason === "outcome_unknown"
					? "unknown"
					: result.ok
						? "completed"
						: "refused";
			if (receipt.status === "completed")
				receipt.completedLease =
					completedLease && navigated && command.completedNavRevision !== null
						? { ...completedLease, navRevision: command.completedNavRevision }
						: completedLease;
			if (result.cleanup === "unknown" && settled) {
				this.close_socket("disconnected");
				// Fence dispatch without turning unknown native effects into success.
				runtime.generation += 1;
				await this.persist();
			}
			const observation =
				safe &&
				receipt.status === "completed" &&
				runtime.state === "connected" &&
				command.request.navRevision === runtime.navRevision
					? output.observation
					: undefined;
			if (
				observation &&
				observation.kind === command.request.operation.kind &&
				observation.observationRevision === command.observationRevision
			) {
				// Capture can keep checked Read fields only in this same document.
				const fields =
					observation.kind === "read"
						? (output.privateFields ?? [])
						: this.observation?.navRevision === runtime.navRevision
							? this.observation.fields
							: [];
				this.observation = { revision: observation.observationRevision, navRevision: runtime.navRevision, fields };
			}
			return Response.json({
				ok: true,
				status: receipt.status,
				runtime,
				completedLease: receipt.completedLease,
				result: receipt.result,
				...(observation ? { observation } : {}),
			});
		}
		return error("not_found", 404);
	}

	async alarm() {
		await this.initialized;
		if (!this.saved) return;
		if (this.command && Date.now() >= this.command.request.deadline) {
			const command = this.command;
			const safe = await this.settle(command.request.commandId);
			const receipt = this.receipts.get(command.request.commandId);
			// Finish can wait for the same child drain and write its result first. Keep that result.
			if (receipt?.status === "in_progress") {
				receipt.status = "unknown";
				receipt.result = { ...unknown_result, inputSent: command.used, cleanup: safe ? "complete" : "unknown" };
			}
			this.observation = null;
		}
		if (Date.now() < Math.min(this.saved.runtime.idleExpiresAt, this.saved.runtime.totalExpiresAt)) {
			await this.persist();
			return;
		}
		this.close_socket("expired");
		await this.persist();
		await this.state.storage.deleteAlarm();
	}
}

export class PlaywriterConnectionGateway extends WorkerEntrypoint<RemoteEnv, PlaywriterGatewayProps> {
	async fetch(request: Request) {
		const url = new URL(request.url);
		const props = this.ctx.props;
		if (
			request.method !== "GET" ||
			url.hostname !== "fake.host" ||
			url.pathname !== `/v1/devtools/browser/${props.commandId}` ||
			url.search !== "?persistent=true" ||
			request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
		)
			return error("forbidden", 403);
		const socketUrl = new URL("https://do/command-socket");
		socketUrl.searchParams.set("commandId", props.commandId);
		socketUrl.searchParams.set("generation", String(props.generation));
		return this.env.PLAYWRITER_SESSIONS.get(this.env.PLAYWRITER_SESSIONS.idFromName(object_name(props))).fetch(
			new Request(socketUrl, { headers: { Upgrade: "websocket" } }),
		);
	}
	connect(): never {
		throw new Error("TCP is not allowed.");
	}
}

// Called only after the main runner's shared-secret check.
export async function handle_playwriter_request(request: Request, env: RemoteEnv, ctx: Context | undefined) {
	const path = new URL(request.url).pathname.replace("/internal/playwriter", "");
	let input: unknown;
	try {
		input = await body(request);
	} catch {
		return error("invalid_body", 400);
	}
	const scope = playwriter_browser_status_schema.strip().safeParse(input);
	if (!scope.success) return error("invalid_body", 400);
	if (path === "/revision") return Response.json({ ok: true, revision: PLAYWRITER_EXECUTOR_REVISION });
	const stub = env.PLAYWRITER_SESSIONS.get(env.PLAYWRITER_SESSIONS.idFromName(object_name(scope.data)));
	const forward = (route: string, payload: unknown) =>
		stub.fetch(
			new Request(`https://do${route}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}),
		);
	if (path !== "/run") return forward(path, input);
	const parsed = playwriter_browser_run_schema.safeParse(input);
	if (!parsed.success) return error("invalid_body", 400);
	const began = await forward("/run/begin", parsed.data);
	const startSchema = z
		.object({
			ok: z.literal(true),
			execute: z.literal(true),
			runtime: z.object({ generation: z.number().int() }).passthrough(),
			observationRevision: z.string(),
			privateFields: private_fields_schema,
			blockedHosts: z.array(z.string()),
			consumedAck: playwriter_browser_receipt_request_schema.optional(),
		})
		.strict();
	const start = startSchema.safeParse(await began.clone().json());
	if (!start.success) return began;
	let output: z.infer<typeof finish_schema> = { result: unknown_result };
	try {
		const gateway = ctx?.exports?.PlaywriterConnectionGateway;
		if (!gateway) throw new Error("gateway_unavailable");
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-19",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "executor.js",
			modules: { "executor.js": PLAYWRITER_EXECUTOR_JS, "playwright.js": CHILD_BUNDLE_JS },
			env: {
				BROWSER: gateway({
					props: { ...scope.data, generation: parsed.data.generation, commandId: parsed.data.commandId },
				}),
			},
			globalOutbound: null,
			limits: { cpuMs: 30_000, subRequests: 10 },
		});
		const entrypoint = worker.getEntrypoint();
		const result = await bounded(
			(async () => {
				if (
					!entrypoint.revision ||
					(await entrypoint.revision()) !== PLAYWRITER_EXECUTOR_REVISION ||
					Date.now() >= parsed.data.deadline
				)
					throw new Error("revision_changed");
				return entrypoint.evaluate({
					commandId: parsed.data.commandId,
					deadline: parsed.data.deadline,
					operation: parsed.data.operation,
					observationRevision: start.data.observationRevision,
					privateFields: start.data.privateFields,
					blockedHosts: start.data.blockedHosts,
				});
			})(),
			Math.max(1, parsed.data.deadline - Date.now()),
		);
		const checked = finish_schema.safeParse(result);
		if (checked.success) output = checked.data;
	} catch {
		/* Safe fixed result. No raw child errors or page data enter logs. */
	}
	const receiptRequest = playwriter_browser_receipt_request_schema.parse({
		connectionId: parsed.data.connectionId,
		ownerId: parsed.data.ownerId,
		organizationId: parsed.data.organizationId,
		workspaceId: parsed.data.workspaceId,
		generation: parsed.data.generation,
		commandId: parsed.data.commandId,
		operationHash: parsed.data.operationHash,
		source: parsed.data.source,
		deadline: parsed.data.deadline,
		receiptResolutionDeadline: parsed.data.receiptResolutionDeadline,
	});
	const finished = await forward("/run/finish", { ...scope.data, request: receiptRequest, output });
	if (!start.data.consumedAck) return finished;
	const reply: unknown = await finished.json();
	return typeof reply === "object" && reply !== null
		? Response.json({ ...reply, consumedAck: start.data.consumedAck })
		: error("invalid_result", 502);
}
