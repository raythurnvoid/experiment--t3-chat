import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { ai_chat_file_result_schema } from "../shared/ai-chat-files.ts";
import { has_defined_property } from "../shared/shared-utils.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import {
	ai_chat_tool_browser_check_bindings,
	ai_chat_tool_create_browser_management,
	type ai_chat_tool_BrowserTurnContext,
} from "./ai-chat-browser-tools.ts";

beforeEach(() => {
	vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "true");
	vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "true");
	vi.stubEnv("BROWSER_RUNNER_URL", "https://browser-runner.test");
	vi.stubEnv("BROWSER_RUNNER_SECRET", "test-secret");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

function fixture() {
	const turn: ai_chat_tool_BrowserTurnContext = {
		organizationId: "org" as Id<"organizations">,
		workspaceId: "workspace" as Id<"organizations_workspaces">,
		userId: "owner" as Id<"users">,
		membershipId: "membership" as Id<"organizations_workspaces_users">,
		organizationName: "qa",
		workspaceName: "home",
		membershipLifetime: 1,
		getThreadId: () => "chat" as Id<"ai_chat_threads">,
		getSourceMessageId: () => "user-message" as Id<"ai_chat_threads_messages_aisdk_5">,
		browserIntent: {
			webChoice: { provider: "playwriter", connectionId: "connection", confirmedTargetHandle: "opaque-tab" },
			selectionRevision: 1,
			policyRevision: 0,
		},
		browsers: new Map(),
		pendingPlaywriterCommands: new Map(),
		observations: new Map(),
		revocation: { revoked: false },
		canWriteFiles: false,
	};
	const resource = {
		provider: "playwriter" as const,
		connectionId: "connection" as Id<"playwriter_connections">,
		connectionGeneration: 1,
		targetRevision: 1,
		controlRevision: 0,
		navRevision: 0,
		confirmedTargetHandle: "opaque-tab",
	};
	turn.browsers.set("connection", {
		...resource,
		membershipId: turn.membershipId,
		selectionRevision: 1,
		policyRevision: 0,
	});
	const connection: Doc<"playwriter_connections"> = {
		_id: resource.connectionId,
		_creationTime: Date.now(),
		ownerId: turn.userId,
		organizationId: turn.organizationId,
		workspaceId: turn.workspaceId,
		membershipId: turn.membershipId,
		membershipLifetime: 1,
		encryptedShareId: new Uint8Array([1]).buffer,
		shareNonce: new Uint8Array(12).buffer,
		linkFingerprint: "a".repeat(64),
		state: "ready",
		active: true,
		connectionGeneration: 1,
		controlRevision: 0,
		targetRevision: 1,
		navRevision: 0,
		inventoryRevision: 1,
		confirmedTargetId: "native-private",
		confirmedTargetHandle: "opaque-tab",
		targets: [],
		pauseReason: null,
		connectAttemptId: "dial",
		sessionId: "remote-session",
		operations: 0,
		idleExpiresAt: Date.now() + 600_000,
		totalExpiresAt: Date.now() + 3_600_000,
		unresolvedCommand: null,
		pendingAcknowledgement: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	const runtime = {
		generation: 1,
		state: "connected" as const,
		targets: [],
		confirmedTargetId: "native-private",
		targetRevision: 1,
		navRevision: 0,
		controlRevision: 0,
		policyRevision: 0,
		selectionRevision: 1,
		agentAccess: true,
		operations: 1,
		idleExpiresAt: connection.idleExpiresAt,
		totalExpiresAt: connection.totalExpiresAt!,
		sessionId: connection.sessionId,
		inventoryRevision: 1,
	};
	const receipts = new Map<
		string,
		{
			isNew: boolean;
			invocationId: Id<"ai_chat_browser_invocations">;
			commandId: string;
			deadlineAt: number;
			receiptResolutionDeadline: number;
			status: "running" | "finished";
			resource: typeof resource;
			result: { status: "succeeded" | "unknown"; reason: string | null } | null;
			resultExpired: boolean;
		}
	>();
	const runQuery = vi.fn(async (ref, args): Promise<unknown> => {
		const name = getFunctionName(ref);
		if (name === "ai_chat_files:get_browser_invocation") return { _yay: receipts.get(args.toolCallId) ?? null };
		if (name === "playwriter_browser:get_remote_lease") return { _yay: resource };
		if (name === "playwriter_browser:load_connection") return { _yay: connection };
		if (name === "files_browser:get_agent_browser_catalog") return { _yay: { browsers: [] } };
		return { _yay: null };
	});
	const allowedVersions = ["0.5.0"];
	const runMutation = vi.fn(async (ref, args): Promise<unknown> => {
		const name = getFunctionName(ref);
		if (name === "playwriter_browser:reserve_command") {
			const invocation = {
				isNew: true,
				invocationId: `claim-${args.toolCallId}` as Id<"ai_chat_browser_invocations">,
				commandId: `command-${args.toolCallId}`,
				deadlineAt: Date.now() + 30_000,
				receiptResolutionDeadline: Date.now() + 35_000,
				status: "running" as const,
				resource: { ...resource },
				result: null,
				resultExpired: false,
			};
			receipts.set(args.toolCallId, invocation);
			return { _yay: { connection, invocation, allowedVersions } };
		}
		if (name === "playwriter_browser:finish_command") {
			const receipt = receipts.get(args.identity.source.toolCallId);
			if (receipt) {
				receipt.status = "finished";
				receipt.result = { status: "succeeded", reason: null };
			}
			return true;
		}
		return true;
	});
	const runAction = vi.fn();
	const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;
	const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const route = String(input).split("/").at(-1)!;
			requests.push({ route, body: JSON.parse(String(init?.body)) });
			if (route === "status") return Response.json({ ok: true, runtime });
			if (route === "command-ack")
				return Response.json({ ok: true, status: "acknowledged", runtime, completedLease: null, result: null });
			return Response.json({
				ok: true,
				status: "completed",
				runtime,
				completedLease: {
					generation: runtime.generation,
					controlRevision: runtime.controlRevision,
					policyRevision: runtime.policyRevision,
					selectionRevision: runtime.selectionRevision,
					confirmedTargetId: runtime.confirmedTargetId,
					navRevision: runtime.navRevision,
					targetRevision: runtime.targetRevision,
				},
				result: { ok: true, reason: null, inputSent: false, cleanup: "complete" },
				observation: {
					kind: "read",
					observationRevision: "read-revision",
					url: "https://example.com/private?token=page-value",
					title: "Private title",
					text: "PRIVATE PAGE TEXT",
					accessibility: "Private button",
					frames: [],
				},
			});
		}),
	);
	const tools = ai_chat_tool_create_browser_management(ctx, turn);
	return {
		ctx,
		turn,
		tools,
		requests,
		receipts,
		runMutation,
		runQuery,
		runAction,
		runtime,
		resource,
		connection,
		allowedVersions,
	};
}

function options(toolCallId = "read-1") {
	return { toolCallId, messages: [] };
}

describe("ai_chat_tool_create_browser_management", () => {
	test("forwards the current claim version list only on a new Run", async () => {
		const f = fixture();
		f.allowedVersions.splice(0, 1, "0.6.0");
		expect(
			ai_chat_file_result_schema.parse(await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()))
				.metadata.status,
		).toBe("succeeded");
		expect(
			f.requests.find((request) => request.route === "run")?.body.allowedVersions,
			"Run must carry the current claim version list",
		).toEqual(["0.6.0"]);
		f.allowedVersions.length = 0;
		expect(
			ai_chat_file_result_schema.parse(await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()))
				.metadata.status,
		).toBe("succeeded");
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(1);
		expect(f.requests.find((request) => request.route === "command-ack")?.body).not.toHaveProperty("allowedVersions");
	});
	test("exposes all tools without a mounted browser panel", () => {
		const f = fixture();
		f.turn.browsers.clear();
		expect(Object.keys(f.tools)).toEqual([
			"browser_status",
			"browser_open",
			"browser_tabs",
			"browser_new_tab",
			"browser_close_tab",
			"browser_run",
			"browser_reload",
			"browser_close",
			"playwriter_read",
			"playwriter_act",
			"playwriter_navigate",
			"playwriter_capture",
		]);
	});
	test("the Press schema refuses Tab and keeps Enter", () => {
		const f = fixture();
		const schema = f.tools.playwriter_act.inputSchema;
		if (!has_defined_property(schema, "parse")) throw new Error("Missing schema");
		const input = {
			browserRef: "connection",
			lastObservationRevision: "read-revision",
			action: "press",
			locator: { by: "role", role: "textbox", name: "Search" },
		};
		expect(() => schema.parse({ ...input, key: "Tab" })).toThrow();
		expect(schema.parse({ ...input, key: "Enter" })).toEqual({ ...input, key: "Enter" });
	});
	test("keeps remote page text out of stored results and gives it only to the live model", async () => {
		const f = fixture();
		const raw = await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options());
		const result = ai_chat_file_result_schema.parse(raw);
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE|native-private|private\?token|Private title/);
		expect(
			f.turn.observations.get("read-1")?.output.type,
			"Private Read must use content so missing records cannot replay it",
		).toBe("content");
		expect(JSON.stringify(f.turn.observations.get("read-1")?.output)).toContain("PRIVATE PAGE TEXT");
		await f.tools.playwriter_read.toModelOutput?.({
			input: { browserRef: "connection" },
			output: result,
			toolCallId: "read-1",
		});
		expect(f.turn.observations.get("read-1")?.safeResult).toEqual({ status: "succeeded", reason: null });
		expect(await f.turn.observations.get("read-1")?.isCurrent()).toBe(true);
		expect(f.requests.map((request) => request.route)).toEqual(["run", "command-ack"]);
	});
	test("an exact duplicate never executes again or reconstructs old page text", async () => {
		const f = fixture();
		await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options());
		f.turn.observations.clear();
		expect(
			ai_chat_file_result_schema.parse(await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()))
				.metadata.status,
		).toBe("succeeded");
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(1);
		expect(f.turn.observations.size).toBe(0);
	});
	test("lost replies remain unknown and are never replayed", async () => {
		const f = fixture();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Lost network reply")));
		const result = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()),
		);
		expect(result.metadata.reason).toBe("unknown");
		await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options());
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(
			f.runMutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "playwriter_browser:finish_command"),
		).toHaveLength(0);
	});
	test("a settled unknown action keeps its warning after navigation changes", async () => {
		const f = fixture();
		f.runtime.navRevision++;
		f.resource.navRevision++;
		f.connection.navRevision++;
		const runnerFetch = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (!String(input).endsWith("/run")) return runnerFetch(input, init);
				f.requests.push({ route: "run", body: JSON.parse(String(init?.body)) });
				return Response.json({
					ok: true,
					status: "unknown",
					runtime: f.runtime,
					completedLease: null,
					result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "complete" },
				});
			}),
		);
		const result = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_act.execute?.(
				{
					browserRef: "connection",
					action: "click",
					locator: { by: "role", role: "button", name: "Count" },
					lastObservationRevision: "read-revision",
				},
				options("uncertain-click"),
			),
		);
		expect(result.metadata.reason).toBe("unknown");
		expect(f.turn.observations.size).toBe(0);
		expect(f.turn.pendingPlaywriterCommands?.size).toBe(0);
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(1);
		expect(await ai_chat_tool_browser_check_bindings(f.ctx, f.turn)).toBe(false);
		expect(f.turn.revocation.revoked).toBe(true);
	});
	test("the turn limit refuses operation 21 before reserving or dispatching it", async () => {
		const f = fixture();
		for (let i = 0; i < 20; i++)
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options(`read-${i}`));
		const result = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options("read-21")),
		);
		expect(result.metadata.reason).toBe("limit");
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(20);
		expect(f.receipts.size).toBe(20);
	});
	test("an observation keeps its original navigation revision", async () => {
		const f = fixture();
		await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options());
		const binding = f.turn.browsers.get("connection")!;
		if (binding.provider !== "playwriter") throw new Error("Expected shared browser");
		binding.navRevision++;
		f.runQuery.mockImplementation(async (ref) =>
			getFunctionName(ref) === "playwriter_browser:get_remote_lease" ? { _yay: { ...binding } } : { _yay: null },
		);
		expect(await f.turn.observations.get("read-1")?.isCurrent()).toBe(false);
	});
	test("a lost runner connection recovers only the frozen target and clears old observations", async () => {
		const f = fixture();
		const output = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()),
		);
		await f.tools.playwriter_read.toModelOutput?.({
			input: { browserRef: "connection" },
			output,
			toolCallId: "read-1",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true, runtime: { ...f.runtime, state: "failed" } })),
		);
		f.runAction.mockImplementation(async () => {
			f.resource.connectionGeneration = 2;
			return { _yay: null };
		});
		expect(await ai_chat_tool_browser_check_bindings(f.ctx, f.turn)).toBe(true);
		expect(f.runAction).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			expect.objectContaining({
				resource: expect.objectContaining({
					confirmedTargetHandle: "opaque-tab",
					connectionGeneration: 1,
				}),
			}),
		);
		expect(f.turn.observations.get("read-1")?.safeResult).toEqual({ status: "succeeded", reason: null });
		expect(JSON.stringify(f.turn.observations.get("read-1"))).not.toMatch(/PRIVATE|opaque-tab|native-private/);
		expect(await f.turn.observations.get("read-1")?.isCurrent()).toBe(false);
		expect(f.turn.browsers.get("connection")).toMatchObject({ connectionGeneration: 2 });
	});
	test.each([false, true])(
		"a direct navigation reply keeps its completed lease with later human navigation: %s",
		async (humanNavigation) => {
			const f = fixture();
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options());
			const runnerFetch = fetch;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = JSON.parse(String(init?.body));
					if (body.operation?.kind !== "navigate") return runnerFetch(input, init);
					f.requests.push({ route: "run", body });
					f.runtime.navRevision = humanNavigation ? 2 : 1;
					f.resource.navRevision = f.runtime.navRevision;
					f.connection.navRevision = f.runtime.navRevision;
					return Response.json({
						ok: true,
						status: "completed",
						runtime: f.runtime,
						completedLease: {
							generation: 1,
							controlRevision: 0,
							policyRevision: 0,
							selectionRevision: 1,
							confirmedTargetId: "native-private",
							targetRevision: 1,
							navRevision: 1,
						},
						result: { ok: true, reason: null, inputSent: false, cleanup: "complete" },
					});
				}),
			);
			const output = ai_chat_file_result_schema.parse(
				await f.tools.playwriter_navigate.execute?.(
					{
						browserRef: "connection",
						url: "https://example.com/next",
						lastObservationRevision: "read-revision",
					},
					options("navigate"),
				),
			);
			expect(output.metadata.status).toBe(humanNavigation ? "errored" : "succeeded");
			expect(output.metadata.reason).toBe(humanNavigation ? "stale" : null);
			expect(f.turn.browsers.get("connection")).toMatchObject({ navRevision: 1 });
			expect(
				f.requests.filter((request) => (request.body.operation as { kind?: string } | undefined)?.kind === "navigate"),
			).toHaveLength(1);
		},
	);
	test.each(["unchanged", "human_navigation", "human_pause"] as const)(
		"a lost navigation reply recovers its exact receipt with %s authority",
		async (change) => {
			const f = fixture();
			const read = ai_chat_file_result_schema.parse(
				await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options()),
			);
			await f.tools.playwriter_read.toModelOutput?.({
				input: { browserRef: "connection" },
				output: read,
				toolCallId: "read-1",
			});
			const runnerFetch = fetch;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const body = JSON.parse(String(init?.body));
					if (body.operation?.kind === "navigate") {
						f.requests.push({ route: "run", body });
						throw new Error("Lost navigation reply");
					}
					return runnerFetch(input, init);
				}),
			);
			const output = ai_chat_file_result_schema.parse(
				await f.tools.playwriter_navigate.execute?.(
					{
						browserRef: "connection",
						url: "https://example.com/next",
						lastObservationRevision: "read-revision",
					},
					options("navigate"),
				),
			);
			expect(output.metadata.reason).toBe("unknown");
			const receipt = f.receipts.get("navigate")!;
			receipt.status = "finished";
			receipt.result = { status: "succeeded", reason: null };
			receipt.resource = { ...f.resource, navRevision: 1, targetRevision: 2 };
			Object.assign(f.resource, receipt.resource);
			if (change === "human_navigation") f.resource.navRevision++;
			if (change === "human_pause") f.resource.controlRevision++;
			Object.assign(f.runtime, {
				navRevision: f.resource.navRevision,
				targetRevision: 2,
				controlRevision: f.resource.controlRevision,
			});
			Object.assign(f.connection, f.resource);
			expect(await ai_chat_tool_browser_check_bindings(f.ctx, f.turn)).toBe(change === "unchanged");
			if (change === "unchanged") {
				const fresh = ai_chat_file_result_schema.parse(
					await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options("fresh-read")),
				);
				expect(fresh.metadata.status).toBe("succeeded");
				expect(f.turn.observations.get("read-1")?.safeResult).toEqual({ status: "succeeded", reason: null });
				expect(JSON.stringify(f.turn.observations.get("read-1"))).not.toMatch(/PRIVATE|opaque-tab|native-private/);
				expect(await f.turn.observations.get("read-1")?.isCurrent()).toBe(false);
				expect(f.turn.observations.has("fresh-read")).toBe(true);
			} else expect(f.turn.revocation.revoked).toBe(true);
			expect(
				f.requests.filter(
					(request) => request.body.operation && (request.body.operation as { kind: string }).kind === "navigate",
				),
			).toHaveLength(1);
		},
	);
	test("fenced cleanup permits a checked reconnect and fresh read without replay", async () => {
		const f = fixture();
		const runnerFetch = fetch;
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Lost reply")));
		await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options("lost-read"));
		const originalQuery = f.runQuery.getMockImplementation()!;
		f.runQuery.mockImplementation(async (ref, args) => {
			if (getFunctionName(ref) === "playwriter_browser:get_remote_lease" && f.connection.state === "offline")
				return { _nay: { name: "offline", message: "Offline" } };
			return originalQuery(ref, args);
		});
		f.runAction.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "playwriter_browser:resolve_command") {
				const receipt = f.receipts.get("lost-read")!;
				receipt.status = "finished";
				receipt.result = { status: "unknown", reason: "outcome_unknown" };
				f.connection.state = "offline";
				return null;
			}
			f.connection.state = "ready";
			f.connection.connectionGeneration = 3;
			f.resource.connectionGeneration = 3;
			f.runtime.generation = 3;
			return { _yay: null };
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ok: true, runtime: { ...f.runtime, generation: 2, state: "disconnected" } }),
				),
		);
		expect(await ai_chat_tool_browser_check_bindings(f.ctx, f.turn)).toBe(true);
		expect(f.runAction.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			"playwriter_browser:resolve_command",
			"playwriter_browser:recover_for_source",
		]);
		vi.stubGlobal("fetch", runnerFetch);
		const fresh = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_read.execute?.({ browserRef: "connection" }, options("fresh-read")),
		);
		expect(fresh.metadata.status).toBe("succeeded");
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(1);
	});
	test("malformed screenshot bytes return a fixed error without exposing provider data", async () => {
		const f = fixture();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					ok: true,
					status: "completed",
					runtime: f.runtime,
					completedLease: {
						generation: 1,
						controlRevision: 0,
						policyRevision: 0,
						selectionRevision: 1,
						confirmedTargetId: "native-private",
						targetRevision: 1,
						navRevision: 0,
					},
					result: { ok: true, reason: null, inputSent: false, cleanup: "complete" },
					observation: {
						kind: "capture",
						observationRevision: "capture",
						format: "png",
						data: "PRIVATE INVALID BASE64!",
					},
				}),
			),
		);
		const result = ai_chat_file_result_schema.parse(
			await f.tools.playwriter_capture.execute?.({ browserRef: "connection", format: "png" }, options("capture")),
		);
		expect(result.metadata.reason).toBe("unsupported_image");
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		expect(f.turn.observations.size).toBe(0);
	});
	test("runs a cloud command within the runner's 31-second deadline", async () => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		const binding = {
			provider: "cloud" as const,
			mode: "web" as const,
			sessionId: "cloud" as Id<"files_browser_sessions">,
			membershipId: f.turn.membershipId,
			controlGen: 1,
			loadGen: 1,
			navGen: 2,
			tabId: "tab",
			tabGen: 2,
			selectionRevision: 1,
			policyRevision: 0,
		};
		f.turn.browsers.set("cloud:tab", binding);
		f.runQuery.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_browser:check_browser_session_access")
				return { ...binding, ok: true, control: "ready", runnerSessionId: "private-runner" };
			return { _yay: null };
		});
		f.runMutation.mockImplementation(async (ref, args) => {
			if (getFunctionName(ref) === "ai_chat_files:begin_browser_invocation")
				return {
					_yay: {
						isNew: true,
						invocationId: "claim",
						commandId: "cloud-command",
						deadlineAt: Date.now() + args.timeoutMs,
						receiptResolutionDeadline: Date.now() + args.timeoutMs + 5_000,
						status: "running",
						resource: { ...binding },
						result: null,
						resultExpired: false,
					},
				};
			return { _yay: true };
		});
		const code = "return await page.title();";
		const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { deadline: number };
				if (body.deadline > Date.now() + 31_000)
					return Response.json(
						{ ok: false, error: { code: "invalid_request", message: "A bounded command identity is required." } },
						{ status: 400 },
					);
				return Response.json({
					ok: true,
					status: "succeeded",
					commandId: "cloud-command",
					codeHash,
					elapsedMs: 1,
					result: "Fixture",
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: {
						mode: "web",
						sessionId: "private-runner",
						control: "ready",
						controlGen: 1,
						loadGen: 1,
						navGen: 2,
						tabId: "tab",
						tabGen: 2,
						viewedTabId: null,
						viewGen: 1,
						tabCount: 1,
						agentAccess: true,
						selectionRevision: 1,
						policyRevision: 0,
						idleUntil: Date.now() + 60_000,
						totalUntil: Date.now() + 600_000,
					},
				});
			}),
		);
		const result = ai_chat_file_result_schema.parse(
			await f.tools.browser_run.execute?.({ browserRef: "cloud", tabRef: "tab", code }, options("cloud-run")),
		);
		expect(result.metadata.status).toBe("succeeded");
		expect(
			f.runMutation.mock.calls.find(([ref]) => getFunctionName(ref) === "ai_chat_files:begin_browser_invocation")?.[1],
		).toMatchObject({
			timeoutMs: 30_000,
			operationKind: "run",
			operationHash: codeHash,
		});
		const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
		expect(request).toMatchObject({
			commandId: "cloud-command",
			code,
			navGen: 2,
			tabGen: 2,
			controlGen: 1,
			source: { chatId: "chat", sourceMessageId: "user-message", toolCallId: "cloud-run" },
		});
		expect(
			f.runMutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "ai_chat_files:finish_browser_invocation"),
		).toHaveLength(1);
		expect(f.turn.observations.get("cloud-run")?.output).toBeDefined();
	});
	test("File Run accepts JSON null and keeps the exact file binding", async () => {
		const f = fixture();
		f.turn.browsers.clear();
		const resource = {
			provider: "cloud" as const,
			mode: "file" as const,
			sessionId: "file" as Id<"files_browser_sessions">,
			controlGen: 3,
			loadGen: 1,
			navGen: 2,
			tabId: null,
			tabGen: null,
		};
		f.turn.browsers.set("file:file", {
			...resource,
			membershipId: f.turn.membershipId,
			selectionRevision: 1,
			policyRevision: 0,
		});
		f.runQuery.mockImplementation(async (ref) =>
			getFunctionName(ref) === "files_browser:check_browser_session_access"
				? { ...resource, ok: true, control: "ready", runnerSessionId: "private-file-runner" }
				: { _yay: null },
		);
		f.runMutation.mockImplementation(async (ref, args) =>
			getFunctionName(ref) === "ai_chat_files:begin_browser_invocation"
				? {
						_yay: {
							isNew: true,
							invocationId: "file-claim",
							commandId: "file-command",
							deadlineAt: Date.now() + args.timeoutMs,
							receiptResolutionDeadline: Date.now() + args.timeoutMs + 5_000,
							status: "running",
							resource,
							result: null,
							resultExpired: false,
						},
					}
				: { _yay: true },
		);
		const code = "return await frame.title();";
		const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					status: "succeeded",
					commandId: "file-command",
					codeHash,
					elapsedMs: 1,
					result: "File fixture",
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: {
						mode: "file",
						sessionId: "private-file-runner",
						nodeId: "file-node",
						control: "ready",
						controlGen: 3,
						loadGen: 1,
						navGen: 2,
						sourceKind: "saved",
						sourceVersion: "version",
						sourceHash: "a".repeat(64),
						idleUntil: Date.now() + 60_000,
						totalUntil: Date.now() + 600_000,
					},
				}),
			),
		);
		const schema = f.tools.browser_run.inputSchema;
		if (!has_defined_property(schema, "parse")) throw new Error("Missing schema");
		const missing = schema.parse({ browserRef: "file", tabRef: "null", code });
		expect(
			ai_chat_file_result_schema.parse(await f.tools.browser_run.execute?.(missing, options("string-null"))).metadata
				.reason,
		).toBe("unavailable");
		expect(fetch).not.toHaveBeenCalled();
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(
			() => schema.parse({ browserRef: "file", tabRef: null, code }),
			"File Run schema must accept JSON null",
		).not.toThrow();
		const input = schema.parse({ browserRef: "file", tabRef: null, code });
		expect(
			ai_chat_file_result_schema.parse(await f.tools.browser_run.execute?.(input, options("file-run"))).metadata.status,
			"File Run must reach its exact file binding",
		).toBe("succeeded");
		const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
		expect(request).toMatchObject({
			mode: "file",
			sessionId: "private-file-runner",
			controlGen: 3,
			loadGen: 1,
			navGen: 2,
			code,
			source: { chatId: "chat", sourceMessageId: "user-message", toolCallId: "file-run" },
		});
		expect(request).not.toHaveProperty("tabId");
		expect(f.turn.browsers.get("file:file")).toMatchObject(resource);
		expect(f.turn.observations.get("file-run")?.output).toBeDefined();
	});
	test("Close has one strict browser ref and retires the exact native connection", async () => {
		const f = fixture();
		const schema = f.tools.browser_close.inputSchema;
		if (!has_defined_property(schema, "parse")) throw new Error("Missing schema");
		expect(() => schema.parse({ browserRef: "connection", tabRef: "null" }), "Close must exclude tabRef").toThrow();
		expect(() => schema.parse({ browserRef: "connection", tabRef: null })).toThrow();
		expect(() => schema.parse({ browserRef: "connection", tabRef: "tab" })).toThrow();
		const input = schema.parse({ browserRef: "connection" });
		expect(input).toEqual({ browserRef: "connection" });
		f.runMutation.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "ai_chat_files:begin_browser_invocation")
				return {
					_yay: {
						isNew: true,
						invocationId: "close-claim",
						commandId: "close-command",
						deadlineAt: Date.now() + 30_000,
						receiptResolutionDeadline: Date.now() + 35_000,
						status: "running",
						resource: f.resource,
						result: null,
						resultExpired: false,
					},
				};
			return { _yay: null };
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true, runtime: { ...f.runtime, state: "disconnected", generation: 2 } })),
		);
		expect(
			ai_chat_file_result_schema.parse(await f.tools.browser_close.execute?.(input, options("native-close"))).metadata
				.status,
			"Native Close must reach its exact connection",
		).toBe("succeeded");
		const retired = f.runMutation.mock.calls.find(
			([ref]) => getFunctionName(ref) === "playwriter_browser:retire_session",
		)?.[1];
		expect(retired).toEqual({
			browserIntent: f.turn.browserIntent,
			resource: f.resource,
			source: {
				organizationId: f.turn.organizationId,
				workspaceId: f.turn.workspaceId,
				userId: f.turn.userId,
				membershipId: f.turn.membershipId,
				membershipLifetime: 1,
				threadId: "chat",
				sourceMessageId: "user-message",
			},
		});
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://browser-runner.test/internal/playwriter/disconnect");
		expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
			connectionId: "connection",
			generation: 1,
			ownerId: f.turn.userId,
			organizationId: f.turn.organizationId,
			workspaceId: f.turn.workspaceId,
		});
		expect(f.turn.browsers.size).toBe(0);
	});
	test("web Run still requires its exact tab handle", async () => {
		const f = fixture();
		f.turn.browsers.clear();
		f.turn.browsers.set("cloud:tab", {
			provider: "cloud",
			mode: "web",
			sessionId: "cloud" as Id<"files_browser_sessions">,
			membershipId: f.turn.membershipId,
			controlGen: 1,
			loadGen: 1,
			navGen: 1,
			tabId: "tab",
			tabGen: 1,
			selectionRevision: 1,
			policyRevision: 0,
		});
		const schema = f.tools.browser_run.inputSchema;
		if (!has_defined_property(schema, "parse")) throw new Error("Missing schema");
		for (const tabRef of [undefined, null, "wrong-tab"]) {
			const input = schema.parse({ browserRef: "cloud", tabRef, code: "return await page.title();" });
			const result = ai_chat_file_result_schema.parse(
				await f.tools.browser_run.execute?.(input, options("no-exact-tab")),
			);
			expect(result.metadata.status).toBe("errored");
			expect(result.metadata.reason).toBe(tabRef === "wrong-tab" ? "unavailable" : "execution");
		}
		expect(f.runMutation).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	test("a late Tabs reply keeps the other tab's completed navigation", async () => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		const current = {
			mode: "web" as const,
			sessionId: "private-runner",
			control: "ready" as const,
			controlGen: 1,
			loadGen: 1,
			navGen: 1,
			tabId: "a",
			tabGen: 1,
			viewedTabId: "a",
			viewGen: 1,
			tabCount: 1,
			agentAccess: true,
			selectionRevision: 1,
			policyRevision: 0,
			idleUntil: Date.now() + 60_000,
			totalUntil: Date.now() + 600_000,
		};
		let tabs = [{ tabId: "a", tabGen: 1, navGen: 1, title: "A", url: "https://example.com/a" }];
		const loaded = {
			_id: "cloud",
			mode: "web",
			runnerSessionId: current.sessionId,
			control: "ready",
			ownerId: f.turn.userId,
			organizationId: f.turn.organizationId,
			workspaceId: f.turn.workspaceId,
		};
		f.runQuery.mockImplementation(async (ref, args) => {
			const name = getFunctionName(ref);
			if (name === "files_browser:check_browser_session_access")
				return {
					...current,
					...tabs.find((tab) => tab.tabId === args.tabId),
					ok: true,
					runnerSessionId: current.sessionId,
				};
			if (name === "files_browser:load_browser_session") return { _yay: loaded };
			return { _yay: null };
		});
		f.runMutation.mockImplementation(async (ref, args) => {
			const name = getFunctionName(ref);
			if (name === "ai_chat_files:begin_browser_invocation")
				return {
					_yay: {
						isNew: true,
						invocationId: `claim-${args.toolCallId}`,
						commandId: `command-${args.toolCallId}`,
						deadlineAt: Date.now() + args.timeoutMs,
						receiptResolutionDeadline: Date.now() + args.timeoutMs + 5_000,
						status: "running",
						resource: args.resource,
						result: null,
						resultExpired: false,
					},
				};
			if (name === "files_browser:sync_browser_session") return { _yay: loaded };
			return { _yay: true };
		});
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		f.runAction.mockImplementation(async (ref, args) => {
			if (getFunctionName(ref) === "files_browser:agent_open_browser")
				return { _yay: { session: { ...current, sessionId: "cloud", navigationGeneration: current.navGen } } };
			if (args.operation === "tab-new") {
				current.controlGen++;
				tabs.push({ tabId: "b", tabGen: 1, navGen: 1, title: "OLD B TITLE", url: "https://example.com/old-b" });
			} else if (args.operation === "tab-close") {
				current.controlGen++;
				tabs = tabs.filter((tab) => tab.tabId !== args.tabId);
			}
			current.tabCount = tabs.length;
			const reply = {
				_yay: {
					status: "completed",
					session: { ...current, sessionId: "cloud" },
					tabs: structuredClone(tabs),
					viewedTabId: "a",
					result: { reason: null },
				},
			};
			if (args.operation === "tabs") {
				started.resolve();
				await released.promise;
			}
			return reply;
		});
		const navigate = "await page.goto('https://example.com/new-b'); return await page.title();";
		f.requests.length = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const route = String(input).split("/").at(-1)!;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				f.requests.push({ route, body });
				if (route === "status") return Response.json({ ok: true, alive: true, session: current, profileStored: false });
				const tab = tabs.find((item) => item.tabId === body.tabId)!;
				if (body.tabGen !== tab.tabGen || body.navGen !== tab.navGen || body.controlGen !== current.controlGen)
					return Response.json({ ok: false, error: { code: "stale_control", message: "The tab lease changed." } });
				if (body.code === navigate)
					Object.assign(tab, { tabGen: 2, navGen: 2, title: "NEW B TITLE", url: "https://example.com/new-b" });
				return Response.json({
					ok: true,
					status: "succeeded",
					commandId: body.commandId,
					codeHash: await crypto_sha256_hex(`browser-v3\n${String(body.code)}`),
					elapsedMs: 1,
					result: tab.title,
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: { ...current, ...tab },
				});
			}),
		);
		const opened = ai_chat_file_result_schema.parse(
			await f.tools.browser_open.execute?.({ mode: "web" }, options("open")),
		);
		expect(opened.metadata.status).toBe("succeeded");
		const added = ai_chat_file_result_schema.parse(
			await f.tools.browser_new_tab.execute?.(
				{ browserRef: "cloud", url: "https://example.com/old-b" },
				options("new-b"),
			),
		);
		expect(added.metadata.status).toBe("succeeded");
		expect(f.turn.browsers.get("cloud:b")).toMatchObject({ controlGen: 2, tabGen: 1, navGen: 1 });
		const listing = f.tools.browser_tabs.execute?.({ browserRef: "cloud" }, options("late-tabs"));
		await started.promise;
		try {
			const navigated = ai_chat_file_result_schema.parse(
				await f.tools.browser_run.execute?.(
					{ browserRef: "cloud", tabRef: "b", code: navigate },
					options("navigate-b"),
				),
			);
			expect(navigated.metadata.status, "the concurrent Run must complete before the old reply").toBe("succeeded");
			expect(f.turn.browsers.get("cloud:b")).toMatchObject({ controlGen: 2, tabGen: 2, navGen: 2 });
			expect(tabs.find((tab) => tab.tabId === "b")).toMatchObject({ tabGen: 2, navGen: 2 });
		} finally {
			released.resolve();
		}
		const listed = ai_chat_file_result_schema.parse(await listing);
		expect(listed.metadata.status).toBe("succeeded");
		await ai_chat_tool_browser_check_bindings(f.ctx, f.turn);
		const next = ai_chat_file_result_schema.parse(
			await f.tools.browser_run.execute?.(
				{ browserRef: "cloud", tabRef: "b", code: "return await page.title();" },
				options("next-run"),
			),
		);
		expect(next.metadata.status, "next safe Run succeeds after the late Tabs reply").toBe("succeeded");
		expect(f.turn.revocation.revoked).toBe(false);
		expect(f.turn.browsers.get("cloud:b")).toMatchObject({ controlGen: 2, tabGen: 2, navGen: 2 });
		expect(await f.turn.observations.get("navigate-b")?.isCurrent()).toBe(true);
		expect(await f.turn.observations.get("late-tabs")?.isCurrent()).toBe(false);
		expect(f.turn.observations.get("late-tabs")?.safeResult).toEqual({ status: "succeeded", reason: null });
		const modelOutput = await f.tools.browser_tabs.toModelOutput?.({
			input: { browserRef: "cloud" },
			output: listed,
			toolCallId: "late-tabs",
		});
		expect(modelOutput).toEqual({
			type: "text",
			value: "browser_tabs: succeeded. (Private observation unavailable. The earlier tool result is unchanged.)",
		});
		expect(JSON.stringify(f.turn.observations.get("late-tabs"))).not.toMatch(/OLD B TITLE|old-b|tabRef/);
		expect(f.requests.filter((request) => request.route === "run")).toHaveLength(2);
		expect(f.requests.at(-1)?.body).toMatchObject({ tabId: "b", navGen: 2, tabGen: 2, controlGen: 2 });
		const closed = ai_chat_file_result_schema.parse(
			await f.tools.browser_close_tab.execute?.({ browserRef: "cloud", tabRef: "b" }, options("close-b")),
		);
		expect(closed.metadata.status).toBe("succeeded");
		expect(f.turn.browsers.has("cloud:b")).toBe(false);
		expect(f.turn.browsers.get("cloud:a")).toMatchObject({ controlGen: 3, tabGen: 1, navGen: 1 });
	});
	test.each([
		["browser_run", false],
		["browser_run", true],
		["browser_reload", false],
		["browser_reload", true],
		["browser_tabs", false],
		["browser_tabs", true],
		["browser_new_tab", false],
		["browser_new_tab", true],
		["browser_close_tab", false],
		["browser_close_tab", true],
	] as const)("%s keeps its own control generation after Take and Resume: %s", async (name, humanControlChanged) => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		const binding = {
			provider: "cloud" as const,
			mode: "web" as const,
			sessionId: "cloud" as Id<"files_browser_sessions">,
			membershipId: f.turn.membershipId,
			controlGen: 1,
			loadGen: 0,
			navGen: 1,
			tabId: "tab",
			tabGen: 1,
			selectionRevision: 1,
			policyRevision: 0,
		};
		f.turn.browsers.set("cloud:tab", binding);
		let currentControlGen = 1;
		f.runQuery.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_browser:check_browser_session_access")
				return {
					ok: true,
					control: "ready",
					controlGen: currentControlGen,
					mode: "web",
					runnerSessionId: "private-runner",
					loadGen: 0,
					navGen: 1,
					tabGen: 1,
				};
			return { _yay: null };
		});
		f.runMutation.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "ai_chat_files:begin_browser_invocation")
				return {
					_yay: {
						isNew: true,
						invocationId: "claim",
						commandId: "cloud-command",
						deadlineAt: Date.now() + 120_000,
						receiptResolutionDeadline: Date.now() + 125_000,
						status: "running",
						resource: { ...binding },
						result: null,
						resultExpired: false,
					},
				};
			return { _yay: true };
		});
		const code = "return await page.title();";
		const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
		const ownControlChange = name === "browser_new_tab" || name === "browser_close_tab" ? 1 : 0;
		f.runAction.mockImplementation(async () => {
			currentControlGen = 1 + ownControlChange + (humanControlChanged ? 2 : 0);
			const session = { ...binding, controlGen: currentControlGen };
			if (name === "browser_reload") return { _yay: session };
			return {
				_yay: {
					status: "completed",
					session,
					tabs: [{ tabId: "tab", tabGen: 1, navGen: 1, url: "https://example.com", title: "Fixture" }],
					viewedTabId: null,
					result: { reason: null },
				},
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				currentControlGen = humanControlChanged ? 3 : 1;
				return Response.json({
					ok: true,
					status: "succeeded",
					commandId: "cloud-command",
					codeHash,
					elapsedMs: 1,
					result: "PRIVATE PAGE",
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: {
						mode: "web",
						sessionId: "private-runner",
						control: "ready",
						controlGen: currentControlGen,
						loadGen: 0,
						navGen: 1,
						tabId: "tab",
						tabGen: 1,
						viewedTabId: null,
						viewGen: 1,
						tabCount: 1,
						agentAccess: true,
						selectionRevision: 1,
						policyRevision: 0,
						idleUntil: Date.now() + 60_000,
						totalUntil: Date.now() + 600_000,
					},
				});
			}),
		);
		const input = { browserRef: "cloud", tabRef: "tab", code };
		const output = ai_chat_file_result_schema.parse(await f.tools[name].execute?.(input, options("cloud-operation")));
		expect(output.metadata.status).toBe(humanControlChanged ? "errored" : "succeeded");
		expect(output.metadata.reason).toBe(humanControlChanged ? "stale" : null);
		expect(binding.controlGen).toBe(humanControlChanged ? 1 : 1 + ownControlChange);
		if (name === "browser_run") {
			expect(f.turn.observations.has("cloud-operation")).toBe(!humanControlChanged);
			if (humanControlChanged) {
				const next = ai_chat_file_result_schema.parse(await f.tools.browser_run.execute?.(input, options("next-run")));
				expect(next.metadata.reason).toBe("stale");
			}
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	});
	test.each([{ mode: "file" }, { tabId: "other-tab" }])(
		"does not adopt a changed Reload mode or tab: %j",
		async (changed) => {
			const f = fixture();
			f.turn.browserIntent.webChoice = { provider: "cloud" };
			f.turn.browsers.clear();
			const binding = {
				provider: "cloud" as const,
				mode: "web" as const,
				sessionId: "cloud" as Id<"files_browser_sessions">,
				membershipId: f.turn.membershipId,
				controlGen: 1,
				loadGen: 1,
				navGen: 1,
				tabId: "tab",
				tabGen: 1,
				selectionRevision: 1,
				policyRevision: 0,
			};
			f.turn.browsers.set("cloud:tab", binding);
			const before = { ...binding };
			f.runMutation.mockResolvedValue({
				_yay: {
					isNew: true,
					invocationId: "claim",
					commandId: "command",
					deadlineAt: Date.now() + 120_000,
					receiptResolutionDeadline: Date.now() + 125_000,
					status: "running",
					resource: { ...binding },
					result: null,
					resultExpired: false,
				},
			});
			f.runAction.mockResolvedValue({
				_yay: { mode: "web", loadGen: 1, controlGen: 1, navGen: 2, tabId: "tab", tabGen: 2, ...changed },
			});
			const result = ai_chat_file_result_schema.parse(
				await f.tools.browser_reload.execute?.({ browserRef: "cloud", tabRef: "tab" }, options("reload")),
			);
			expect(result.metadata.reason).toBe("stale");
			expect(binding).toEqual(before);
			expect(f.turn.revocation.revoked).toBe(true);
			expect(f.turn.observations.has("reload")).toBe(false);
		},
	);
	test("continues with a fresh Reload observation and exact tab lease", async () => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		const current = {
			mode: "web" as const,
			sessionId: "private-runner",
			control: "ready" as const,
			controlGen: 1,
			loadGen: 1,
			navGen: 1,
			tabId: "tab",
			tabGen: 1,
			viewedTabId: null,
			viewGen: 1,
			tabCount: 1,
			agentAccess: true,
			selectionRevision: 1,
			policyRevision: 0,
			idleUntil: Date.now() + 60_000,
			totalUntil: Date.now() + 600_000,
		};
		const loaded = {
			_id: "cloud",
			mode: "web",
			runnerSessionId: current.sessionId,
			control: "ready",
			ownerId: f.turn.userId,
			organizationId: f.turn.organizationId,
			workspaceId: f.turn.workspaceId,
		};
		f.runQuery.mockImplementation(async (ref) => {
			const name = getFunctionName(ref);
			if (name === "files_browser:check_browser_session_access")
				return { ...current, ok: true, runnerSessionId: current.sessionId };
			if (name === "files_browser:load_browser_session") return { _yay: loaded };
			return { _yay: null };
		});
		f.runMutation.mockImplementation(async (ref, args) => {
			const name = getFunctionName(ref);
			if (name === "ai_chat_files:begin_browser_invocation")
				return {
					_yay: {
						isNew: true,
						invocationId: `claim-${args.toolCallId}`,
						commandId: `command-${args.toolCallId}`,
						deadlineAt: Date.now() + args.timeoutMs,
						receiptResolutionDeadline: Date.now() + args.timeoutMs + 5_000,
						status: "running",
						resource: args.resource,
						result: null,
						resultExpired: false,
					},
				};
			if (name === "files_browser:sync_browser_session") return { _yay: loaded };
			return { _yay: true };
		});
		f.runAction.mockImplementation(async (ref) => {
			if (getFunctionName(ref) === "files_browser:agent_open_browser")
				return { _yay: { session: { ...current, sessionId: "cloud", navigationGeneration: current.navGen } } };
			current.navGen = 2;
			current.tabGen = 2;
			return { _yay: { mode: "web", loadGen: 1, controlGen: 1, navGen: 2, tabId: "tab", tabGen: 2 } };
		});
		const code = "return await page.title();";
		const codeHash = await crypto_sha256_hex(`browser-v3\n${code}`);
		f.requests.length = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const route = String(input).split("/").at(-1)!;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				f.requests.push({ route, body });
				if (route === "status") return Response.json({ ok: true, alive: true, session: current, profileStored: false });
				if (body.tabGen !== current.tabGen || body.navGen !== current.navGen || body.controlGen !== current.controlGen)
					return Response.json({ ok: false, error: { code: "stale_control", message: "The tab lease changed." } });
				return Response.json({
					ok: true,
					status: "succeeded",
					commandId: body.commandId,
					codeHash,
					elapsedMs: 1,
					result: "Fixture",
					resultTruncated: false,
					files: [],
					consoleEntries: [],
					pageErrors: [],
					logs: [],
					logsTruncated: false,
					error: null,
					session: current,
				});
			}),
		);
		const opened = ai_chat_file_result_schema.parse(
			await f.tools.browser_open.execute?.({ mode: "web" }, options("open")),
		);
		expect(opened.metadata.status).toBe("succeeded");
		const oldOpen = f.turn.observations.get("open")!;
		expect(await oldOpen.isCurrent()).toBe(true);
		const refs = { browserRef: "cloud", tabRef: "tab" };
		const reloaded = ai_chat_file_result_schema.parse(await f.tools.browser_reload.execute?.(refs, options("reload")));
		expect(reloaded.metadata.status).toBe("succeeded");
		expect(await ai_chat_tool_browser_check_bindings(f.ctx, f.turn)).toBe(true);
		expect(await oldOpen.isCurrent()).toBe(false);
		const fresh = f.turn.observations.get("reload");
		expect(fresh?.toolName).toBe("browser_reload");
		expect(fresh?.output).toEqual({ type: "content", value: [{ type: "text", text: JSON.stringify(refs) }] });
		expect(await fresh?.isCurrent()).toBe(true);
		expect(JSON.stringify(reloaded)).not.toContain("private-runner");
		const run = ai_chat_file_result_schema.parse(
			await f.tools.browser_run.execute?.({ ...refs, code }, options("run")),
		);
		expect(run.metadata.status).toBe("succeeded");
		expect(f.requests.map((request) => request.route)).toEqual(["status", "run"]);
		expect(f.requests[1]?.body).toMatchObject({ tabId: "tab", tabGen: 2, navGen: 2, controlGen: 1 });
	});
	test.each(["web", "file"] as const)("a stale %s Open revokes the unbound turn", async (mode) => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		f.runMutation.mockResolvedValue({
			_yay: {
				isNew: true,
				invocationId: "claim",
				commandId: "command",
				deadlineAt: Date.now() + 120_000,
				receiptResolutionDeadline: Date.now() + 125_000,
				status: "running",
				resource: null,
				result: null,
				resultExpired: false,
			},
		});
		f.runAction.mockResolvedValue({ _nay: { name: "stale", message: "Browser control changed" } });
		const input = mode === "web" ? { mode } : { mode, path: "/page.html", sourceKind: "saved" as const };
		const result = ai_chat_file_result_schema.parse(await f.tools.browser_open.execute?.(input, options("open")));
		expect(result.metadata.reason).toBe("stale");
		expect(f.turn.revocation.revoked).toBe(true);
		expect(f.turn.browsers.size).toBe(0);
		expect(f.turn.observations.size).toBe(0);
		const next = ai_chat_file_result_schema.parse(await f.tools.browser_open.execute?.(input, options("after-stale")));
		expect(next.metadata.reason).toBe("unavailable");
		expect(f.runAction).toHaveBeenCalledTimes(1);
	});

	test("a lost cloud open reply leaves its durable claim unresolved", async () => {
		const f = fixture();
		f.turn.browserIntent.webChoice = { provider: "cloud" };
		f.turn.browsers.clear();
		f.runMutation.mockResolvedValue({
			_yay: {
				isNew: true,
				invocationId: "claim",
				commandId: "command",
				deadlineAt: Date.now() + 120_000,
				receiptResolutionDeadline: Date.now() + 125_000,
				status: "running",
				resource: null,
				result: null,
				resultExpired: false,
			},
		});
		f.runAction.mockResolvedValue({ _nay: { name: "outcome_unknown", message: "The reply was lost" } });
		const result = ai_chat_file_result_schema.parse(
			await f.tools.browser_open.execute?.({ mode: "web" }, options("open")),
		);
		expect(result.metadata.reason).toBe("unknown");
		expect(
			f.runMutation.mock.calls.filter(([ref]) => getFunctionName(ref) === "ai_chat_files:finish_browser_invocation"),
		).toHaveLength(0);
	});
});
