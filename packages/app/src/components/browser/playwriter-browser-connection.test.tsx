import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PlaywriterBrowserConnection } from "./playwriter-browser-connection.tsx";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	available: { enabled: true, hasSavedConnection: false },
	connection: null as Record<string, unknown> | null,
	preferences: { webChoice: { provider: "cloud" } },
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member-1" }) },
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../convex/_generated/api.js");
	return { app_convex_api: api };
});
vi.mock("convex/react", () => ({
	useConvex: () => ({ action: mocks.action }),
	useQuery: (reference: never) => {
		switch (getFunctionName(reference)) {
			case "playwriter_browser:remote_browser_available":
				return mocks.available;
			case "playwriter_browser:current_connection":
				return mocks.connection;
			case "files_browser:current_browser_preferences":
				return mocks.preferences;
			default:
				return null;
		}
	},
}));

beforeEach(() => {
	mocks.action.mockReset();
	mocks.action.mockResolvedValue({ _yay: { connectionId: "connection-1" } });
	mocks.available = { enabled: true, hasSavedConnection: false };
	mocks.connection = null;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("PlaywriterBrowserConnection", () => {
	test("clears a valid share before the action settles", async () => {
		let settle: (value: unknown) => void = () => {};
		mocks.action.mockImplementation(
			() =>
				new Promise((resolve) => {
					settle = resolve;
				}),
		);
		render(<PlaywriterBrowserConnection />);
		const share = "abcdef0123456789abcdef0123456789";
		const input = screen.getByLabelText("Share ID or Remote control link");
		fireEvent.change(input, { target: { value: `https://playwriter.dev/remote-control#${share}` } });
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(input).toHaveProperty("value", "");
		expect(mocks.action.mock.calls.map(([ref, args]) => [getFunctionName(ref), args])).toEqual([
			["playwriter_browser:connect_tab", { membershipId: "member-1", share }],
		]);
		expect(document.body.textContent).not.toContain(share);
		await act(async () => settle({ _yay: { connectionId: "connection-1" } }));
	});

	test("refuses a copied command without calling the action", () => {
		render(<PlaywriterBrowserConnection />);
		fireEvent.change(screen.getByLabelText("Share ID or Remote control link"), {
			target: { value: "playwriter --remote abcdef0123456789abcdef0123456789" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect(mocks.action).not.toHaveBeenCalled();
		expect(screen.getByRole("alert").textContent).toContain("paste only the value after --remote");
	});

	test("a rejected Connect shows a fixed error and clears its pending state", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.action.mockRejectedValue(new Error("remote URL contains private-share"));
		render(<PlaywriterBrowserConnection />);
		fireEvent.change(screen.getByLabelText("Share ID or Remote control link"), {
			target: { value: "abcdef0123456789abcdef0123456789" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect" }));
		expect((await screen.findByRole("alert")).textContent).toBe("The browser could not do that. Try again.");
		expect(document.body.textContent).not.toContain("private-share");
		expect(errorLog).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Share ID or Remote control link"), {
			target: { value: "abcdef0123456789abcdef0123456789" },
		});
		expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", false);
	});

	test("requires an exact tab choice and never selects the first tab itself", async () => {
		mocks.connection = {
			connectionId: "connection-1",
			connectionGeneration: 7,
			controlRevision: 11,
			state: "needs_confirmation",
			target: null,
			targets: [
				{ handle: "one", title: "First", url: "https://first.test/" },
				{ handle: "two", title: "Second", url: "https://second.test/" },
			],
			pauseReason: null,
		};
		render(<PlaywriterBrowserConnection />);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
		expect(getFunctionName(mocks.action.mock.calls[0]![0])).toBe("playwriter_browser:refresh_connection_status");
		fireEvent.click(screen.getAllByRole("button", { name: "Use this tab" })[1]!);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
		expect(mocks.action.mock.calls[1]![1]).toEqual({
			membershipId: "member-1",
			connectionId: "connection-1",
			targetHandle: "two",
		});
	});

	test("resumes only the pause state shown by this view", async () => {
		mocks.connection = {
			connectionId: "connection-1",
			connectionGeneration: 7,
			controlRevision: 11,
			state: "paused",
			target: { handle: "one", title: "Shared", url: "https://site.test/" },
			targets: [],
			pauseReason: null,
		};
		render(<PlaywriterBrowserConnection />);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
		expect(getFunctionName(mocks.action.mock.calls[1]![0])).toBe("playwriter_browser:resume_connection");
		expect(mocks.action.mock.calls[1]![1]).toEqual({
			membershipId: "member-1",
			connectionId: "connection-1",
			connectionGeneration: 7,
			controlRevision: 11,
		});
	});

	test.each([
		["human", "You paused the agent."],
		["agent_closed", "The agent ended this browser session."],
		["access_lost", "Browser access changed."],
		["private_internal_reason", "Check the connection, then reconnect if needed."],
	])("shows a plain label for %s", async (pauseReason, label) => {
		mocks.connection = {
			connectionId: "connection-1",
			state: "paused",
			target: null,
			targets: [],
			pauseReason,
		};
		render(<PlaywriterBrowserConnection />);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
		expect(screen.getByText(label)).toBeTruthy();
		expect(document.body.textContent).not.toContain(pauseReason);
	});

	test("offers Reconnect rather than Resume when the transport needs help", async () => {
		mocks.connection = {
			connectionId: "connection-1",
			state: "needs_human",
			target: null,
			targets: [],
			pauseReason: null,
		};
		render(<PlaywriterBrowserConnection />);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
		expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
		expect(screen.getByRole("button", { name: "Reconnect" })).toHaveProperty("disabled", false);
		expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
	});

	test("keeps Disconnect when the feature is off and leaves the tab open on unmount", async () => {
		mocks.available = { enabled: false, hasSavedConnection: true };
		mocks.connection = {
			connectionId: "connection-1",
			connectionGeneration: 7,
			controlRevision: 11,
			state: "paused",
			target: { handle: "one", title: "Shared", url: "https://site.test/" },
			targets: [],
			pauseReason: null,
		};
		const view = render(<PlaywriterBrowserConnection />);
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("button", { name: "Resume" })).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
		expect(getFunctionName(mocks.action.mock.calls[1]![0])).toBe("playwriter_browser:disconnect_connection");
		view.unmount();
		expect(mocks.action).toHaveBeenCalledTimes(2);
	});
});
