import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { playwriter_runner_call } from "./playwriter-browser.ts";

const runtime = {
	generation: 1,
	state: "connected",
	targets: [],
	confirmedTargetId: null,
	targetRevision: 0,
	inventoryRevision: 0,
	navRevision: 0,
	controlRevision: 0,
	policyRevision: 0,
	agentAccess: true,
	operations: 0,
	idleExpiresAt: Date.now() + 600_000,
	totalExpiresAt: Date.now() + 3_600_000,
	sessionId: "session",
};

beforeEach(() => {
	vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "true");
	vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "true");
	vi.stubEnv("BROWSER_RUNNER_URL", "https://runner.test/");
	vi.stubEnv("BROWSER_RUNNER_SECRET", "private-runner-key");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("playwriter_runner_call", () => {
	test("uses only the trusted runner URL and server credential", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, runtime }));
		vi.stubGlobal("fetch", fetchMock);
		expect(
			(await playwriter_runner_call({ route: "status", body: { connectionId: "connection" } }))._nay,
		).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://runner.test/internal/playwriter/status",
			expect.objectContaining({
				headers: { "Content-Type": "application/json", Authorization: "Bearer private-runner-key" },
			}),
		);
	});

	test.each(["run", "connect", "recover", "reconnect"] as const)("flags off refuse %s before HTTP", async (route) => {
		vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "false");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const result = await playwriter_runner_call({ route, body: {} });
		expect(result._nay?.name).toBe("unavailable");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test.each([
		"status",
		"pause",
		"agent-access",
		"disconnect",
		"command-status",
		"command-fence",
		"command-ack",
	] as const)("safe %s still reaches the runner with flags off", async (route) => {
		vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "false");
		vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "false");
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, runtime }));
		vi.stubGlobal("fetch", fetchMock);
		expect((await playwriter_runner_call({ route, body: {} }))._nay).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("cleanup still requires the runner credential", async () => {
		vi.stubEnv("BROWSER_RUNNER_SECRET", undefined);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect((await playwriter_runner_call({ route: "disconnect", body: {} }))._nay?.name).toBe("unavailable");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("checks every consumed runtime field", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ ok: true, runtime: { ...runtime, generation: "wrong" } })),
		);
		expect((await playwriter_runner_call({ route: "status", body: {} }))._nay?.name).toBe("invalid_response");
	});

	test("provider error text never leaves the client", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ok: false, error: { code: "stale", message: "SECRET_TYPED_VALUE" } }, { status: 409 }),
				),
		);
		const result = await playwriter_runner_call({ route: "run", body: {} });
		expect(result._nay?.name).toBe("stale");
		expect(JSON.stringify(result)).not.toContain("SECRET_TYPED_VALUE");
	});

	test("oversized HTTP output is refused before JSON parsing", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x".repeat(16 * 1024 * 1024 + 1))));
		expect((await playwriter_runner_call({ route: "status", body: {} }))._nay?.name).toBe("invalid_response");
	});
});
