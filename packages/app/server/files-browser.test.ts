import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	files_browser_RUNNER_ROUTES,
	files_browser_runner_call,
	files_browser_runner_upload_url,
	files_browser_runner_viewer_url,
} from "./files-browser.ts";

const scope = { ownerId: "user-1", organizationId: "organization-1", workspaceId: "workspace-1" };
const cleanupRoutes = [
	"status",
	"close",
	"profile-delete",
	"agent-access",
	"operation-status",
	"command-status",
	"command-fence",
] as const;

beforeEach(() => {
	vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "false");
	vi.stubEnv("BROWSER_RUNNER_URL", "https://browser-runner.test/");
	vi.stubEnv("BROWSER_RUNNER_SECRET", "secret");
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("files_browser_runner_call", () => {
	test.each(cleanupRoutes)("keeps authenticated %s calls working while the browser feature is off", async (route) => {
		const result = await files_browser_runner_call({ route, body: scope });
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			`https://browser-runner.test/internal/browser/${route}`,
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
				body: JSON.stringify(scope),
			}),
		);
		expect(result).toEqual({ _yay: { ok: true } });
	});

	test.each(files_browser_RUNNER_ROUTES.filter((route) => !cleanupRoutes.some((cleanup) => cleanup === route)))(
		"refuses %s while the browser feature is off",
		async (route) => {
			expect(await files_browser_runner_call({ route, body: scope })).toEqual({
				_nay: { message: "Browser unavailable" },
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	test.each(["BROWSER_RUNNER_URL", "BROWSER_RUNNER_SECRET"])("still requires %s for cleanup", async (key) => {
		vi.stubEnv(key, undefined);
		for (const route of cleanupRoutes) {
			expect(await files_browser_runner_call({ route, body: scope })).toEqual({
				_nay: { message: "Browser unavailable" },
			});
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	test("keeps new work off when the feature flag is missing", async () => {
		vi.stubEnv("AI_CHAT_BROWSER_ENABLED", undefined);
		expect((await files_browser_runner_call({ route: "open", body: scope }))._nay?.message).toBe("Browser unavailable");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("files_browser_runner_viewer_url", () => {
	test("keeps viewer access off during the rollout", () => {
		expect(files_browser_runner_viewer_url()).toBeNull();
	});
});

describe("files_browser_runner_upload_url", () => {
	test("keeps upload access off during the rollout", () => {
		expect(files_browser_runner_upload_url({ ...scope, mode: "file", grantId: "grant-1" })).toBeNull();
	});
	test.each(["file", "web"] as const)("routes %s uploads to the matching browser slot", (mode) => {
		vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "true");
		const url = new URL(files_browser_runner_upload_url({ ...scope, mode, grantId: "grant-1" })!);
		expect(url.searchParams.get("mode")).toBe(mode);
		expect(url.searchParams.get("grantId")).toBe("grant-1");
	});
});
