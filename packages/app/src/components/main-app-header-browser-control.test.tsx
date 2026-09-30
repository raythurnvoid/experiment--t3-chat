import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MainAppHeaderBrowserControl } from "./main-app-header-browser-control.tsx";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	provider: "playwriter" as "none" | "playwriter" | "cloud",
	webAgentAccess: false,
	enabled: false,
	queries: new Set<string>(),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "member-1", organizationName: "team", workspaceName: "home" }),
	},
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../convex/_generated/api.js");
	return { app_convex_api: api };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("convex/react", () => ({
	useConvex: () => ({ action: mocks.action }),
	useQuery: (reference: never, args: unknown) => {
		const name = getFunctionName(reference);
		mocks.queries.add(name);
		switch (name) {
			case "files_browser:current_browser_preferences":
				return {
					webChoice:
						mocks.provider === "playwriter"
							? { provider: "playwriter", connectionId: "connection-1", confirmedTargetHandle: "target-1" }
							: { provider: mocks.provider },
					selectionRevision: 1,
					policyRevision: 1,
					webAgentAccess: mocks.webAgentAccess,
					agentBlockedHosts: [],
					syncPending: false,
				};
			case "files_browser:web_browser_available":
				return { enabled: mocks.provider === "cloud", paidPlan: false };
			case "playwriter_browser:remote_browser_available":
				return { enabled: mocks.enabled, hasSavedConnection: true };
			case "playwriter_browser:current_connection":
				return {
					connectionId: "connection-1",
					state: "paused",
					target: { handle: "target-1", title: "Shared tab", url: "https://site.test/" },
					targets: [],
					pauseReason: null,
				};
			case "files_browser:current_browser_session":
				expect(args).toEqual({ membershipId: "member-1", mode: "web" });
				return { sessionId: "session-1", mode: "web", control: "human", controlGen: 7 };
			default:
				return null;
		}
	},
}));

beforeEach(() => {
	mocks.action.mockReset();
	mocks.action.mockResolvedValue({ _yay: null });
	mocks.provider = "playwriter";
	mocks.enabled = false;
	mocks.webAgentAccess = false;
	mocks.queries.clear();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("MainAppHeaderBrowserControl", () => {
	test("a saved none choice shows no browser and mounts no cloud controls", () => {
		mocks.provider = "none";
		mocks.enabled = true;
		mocks.webAgentAccess = true;
		render(<MainAppHeaderBrowserControl />);
		expect(screen.getByText("No browser selected")).toBeTruthy();
		expect(screen.queryByText(/Cloud browser/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Open Browser" })).toBeNull();
		expect(screen.getByRole("button", { name: "Browser settings" })).toBeTruthy();
		expect([...mocks.queries]).not.toContain("files_browser:current_browser_session");
	});

	test("keeps remote cleanup and common settings without a cloud session", async () => {
		render(<MainAppHeaderBrowserControl />);
		expect(screen.getByText("Agent access off")).toBeTruthy();
		expect([...mocks.queries]).not.toContain("files_browser:current_browser_session");
		fireEvent.click(screen.getByRole("button", { name: "Browser settings" }));
		const dialog = await screen.findByRole("dialog", { name: "Browser settings" });
		await waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
		expect(getFunctionName(mocks.action.mock.calls[0]![0])).toBe("playwriter_browser:refresh_connection_status");
		fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mocks.action).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
		expect(getFunctionName(mocks.action.mock.calls[1]![0])).toBe("playwriter_browser:disconnect_connection");
	});

	test("Resume sends the shown session control generation without a chat or viewer", async () => {
		mocks.provider = "cloud";
		mocks.enabled = true;
		render(<MainAppHeaderBrowserControl />);
		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		await waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
		expect(mocks.action.mock.calls[0]![1]).toEqual({ membershipId: "member-1", sessionId: "session-1", controlGen: 7 });
		expect(getFunctionName(mocks.action.mock.calls[0]![0])).toBe("files_browser:resume_browser_agent");
	});
});
