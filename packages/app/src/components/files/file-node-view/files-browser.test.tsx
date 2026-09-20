import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { files_browser_StreamEvents, files_browser_StreamInput } from "@/lib/files-browser-stream.ts";
import { FilesBrowser, FilesBrowserResumeThreadMirror } from "./files-browser.tsx";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	sendInput: vi.fn<(input: files_browser_StreamInput) => number>(),
	events: null as files_browser_StreamEvents | null,
	selectedThreadId: "thread_selected" as string | null,
	control: "human",
	controlGen: 1,
	sessionEnded: false,
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
			organizationName: "team",
			workspaceName: "home",
		}),
	},
}));
vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: { useThreadList: () => ({ selectedThreadId: mocks.selectedThreadId }) },
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action: mocks.action } };
});
vi.mock("convex/react", () => {
	const client = { action: mocks.action };
	return {
		useConvex: () => client,
		useQuery: (reference: never, args: unknown) => {
			if (args === "skip") return undefined;
			switch (getFunctionName(reference)) {
				case "files_browser:current_browser_session":
					if (mocks.sessionEnded) return null;
					return {
						sessionId: "session_1",
						nodeId: "node_1",
						targetKind: "saved",
						path: "/page.html",
						control: mocks.control,
						sourceKind: "saved",
						sourceVersion: "v1",
						sourceHash: "hash",
						loadGen: 1,
						controlGen: mocks.controlGen,
						idleUntil: Date.now() + 300_000,
						totalUntil: Date.now() + 1_200_000,
					};
				default:
					return null;
			}
		},
	};
});
vi.mock("@/lib/files-browser-stream.ts", () => ({
	files_browser_stream_connect: (args: { events: files_browser_StreamEvents }) => {
		mocks.events = args.events;
		return { sendInput: mocks.sendInput, close: vi.fn() };
	},
}));

beforeEach(() => {
	mocks.action.mockReset();
	mocks.action.mockResolvedValue({ _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test", control: "human" } });
	mocks.sendInput.mockReset();
	mocks.sendInput.mockReturnValue(1);
	mocks.events = null;
	mocks.selectedThreadId = "thread_selected";
	mocks.control = "human";
	mocks.controlGen = 1;
	mocks.sessionEnded = false;
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function browserPanel(host: "docked" | "detached" = "docked", editorRevision = 0) {
	return (
		<FilesBrowser
			targetKind="saved"
			nodeId="node_1"
			path="/page.html"
			host={host}
			editorRevision={editorRevision}
			serverSequence={0}
			getDraftText={null}
			getDraftRevision={null}
		/>
	);
}

async function connectViewer() {
	await waitFor(() => expect(mocks.events).not.toBeNull());
	act(() => mocks.events!.onHello({ viewerId: "viewer_1", viewport: { width: 1280, height: 800 }, control: "human", controlGen: 1 }));
	const frame = screen.getByRole("application");
	vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 800));
	return frame;
}

describe("FilesBrowser", () => {
	// Screenshots are now pending Files, so the panel no longer has its own Results list. The viewer
	// must still connect, and none of that old surface may come back.
	test("keeps the live viewer without the old Results surface", async () => {
		render(browserPanel());
		await connectViewer();

		expect(screen.queryByRole("group", { name: "Browser results" })).toBeNull();
		expect(screen.queryByText("Results")).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
	});

	test("keeps the renewal deadline when control and session metadata change", async () => {
		vi.useFakeTimers();
		mocks.control = "ready";
		const { rerender } = render(browserPanel());
		await act(async () => {});
		act(() => mocks.events!.onHello({
			viewerId: "viewer_1", viewport: { width: 1280, height: 800 }, control: "ready", controlGen: 1,
		}));
		await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
		mocks.control = "human";
		mocks.controlGen = 2;
		rerender(browserPanel("docked", 1));
		await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
		const renewals = () => mocks.action.mock.calls.filter(([reference]) => getFunctionName(reference) === "files_browser:renew_browser_viewer");
		expect(renewals().map(([, args]) => args)).toEqual([{
			membershipId: "membership_1", sessionId: "session_1", viewerId: "viewer_1",
		}]);
		await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
		expect(renewals()).toHaveLength(2);
	});

	test("returns to Start when the runner ends the session before renewal", async () => {
		render(browserPanel());
		await connectViewer();
		mocks.action.mockImplementation(async (reference) => {
			if (getFunctionName(reference) === "files_browser:end_browser") mocks.sessionEnded = true;
			return { _yay: {} };
		});
		await act(async () => mocks.events!.onClose({ code: 4404, reason: "session ended" }));
		expect(mocks.action.mock.calls.find(([reference]) => getFunctionName(reference) === "files_browser:end_browser")?.[1]).toEqual({
			membershipId: "membership_1", sessionId: "session_1",
		});
		expect(screen.getByRole("button", { name: "Start shared browser" })).toBeTruthy();
	});

	test("does not end the shared session when only the viewer moves", async () => {
		render(browserPanel());
		await connectViewer();
		act(() => mocks.events!.onClose({ code: 4409, reason: "viewer moved" }));
		expect(mocks.action.mock.calls.some(([reference]) => getFunctionName(reference) === "files_browser:end_browser")).toBe(false);
		expect(screen.getByRole("button", { name: "End browser" })).toBeTruthy();
	});

	test("uses the new hello control after a same-session reconnect", async () => {
		render(browserPanel());
		const frame = await connectViewer();
		act(() => mocks.events!.onControl({ control: "human", controlGen: 2 }));
		const firstEvents = mocks.events;
		vi.useFakeTimers();
		act(() => mocks.events!.onClose({ code: 1006, reason: "connection lost" }));
		await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
		expect(mocks.events).not.toBe(firstEvents);
		act(() => mocks.events!.onHello({
			viewerId: "viewer_reconnected", viewport: { width: 1280, height: 800 }, control: "ready", controlGen: 3,
		}));
		expect(screen.getByRole("button", { name: "Take control" })).toHaveProperty("disabled", false);
		expect(screen.queryByRole("button", { name: /^Resume agent/ })).toBeNull();
		fireEvent.mouseDown(frame, { clientX: 320, clientY: 250, detail: 1 });
		expect(mocks.sendInput).not.toHaveBeenCalled();
	});

	test("a newer session control overrides an older socket message", async () => {
		const { rerender } = render(browserPanel());
		await connectViewer();
		act(() => mocks.events!.onControl({ control: "human", controlGen: 2 }));
		mocks.control = "ready";
		mocks.controlGen = 3;
		rerender(browserPanel("docked", 1));
		expect(screen.getByRole("button", { name: "Take control" })).toHaveProperty("disabled", false);
		expect(screen.queryByRole("button", { name: /^Resume agent/ })).toBeNull();
	});

	test("keeps a completed handoff when a same-generation pausing message arrives", async () => {
		render(browserPanel());
		await connectViewer();
		act(() => mocks.events!.onControl({ control: "pausing", controlGen: 1 }));
		expect(screen.getByRole("button", { name: /^Resume agent/ })).toBeTruthy();
	});

	test("sends one press and release per click, with the native double-click count", async () => {
		render(browserPanel());
		const frame = await connectViewer();
		for (const detail of [1, 2]) {
			fireEvent.mouseDown(frame, { clientX: 320, clientY: 250, button: 0, detail });
			fireEvent.mouseUp(frame, { clientX: 320, clientY: 250, button: 0, detail });
			fireEvent.click(frame, { clientX: 320, clientY: 250, button: 0, detail });
		}
		expect(mocks.sendInput.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "mouse.move", x: 640, y: 100 },
			{ kind: "mouse.down", button: "left", clickCount: 1 },
			{ kind: "mouse.move", x: 640, y: 100 },
			{ kind: "mouse.up", button: "left", clickCount: 1 },
			{ kind: "mouse.move", x: 640, y: 100 },
			{ kind: "mouse.down", button: "left", clickCount: 2 },
			{ kind: "mouse.move", x: 640, y: 100 },
			{ kind: "mouse.up", button: "left", clickCount: 2 },
		]);
	});

	test("ignores the image margins and releases a drag outside the page", async () => {
		render(browserPanel());
		const frame = await connectViewer();
		fireEvent.mouseDown(frame, { clientX: 320, clientY: 100 });
		fireEvent.mouseUp(frame, { clientX: 320, clientY: 100 });
		fireEvent.click(frame, { clientX: 320, clientY: 100 });
		expect(mocks.sendInput).not.toHaveBeenCalled();

		fireEvent.mouseDown(frame, { clientX: 320, clientY: 250, detail: 1 });
		fireEvent.mouseMove(frame, { clientX: 500, clientY: 300, buttons: 1 });
		fireEvent.mouseUp(frame, { clientX: 800, clientY: 900, detail: 1 });
		expect(mocks.sendInput.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "mouse.move", x: 640, y: 100 },
			{ kind: "mouse.down", button: "left", clickCount: 1 },
			{ kind: "mouse.move", x: 1000, y: 200 },
			{ kind: "mouse.move", x: 1279, y: 799 },
			{ kind: "mouse.up", button: "left", clickCount: 1 },
		]);
	});

	test("releases the remote button when pointer capture is lost", async () => {
		render(browserPanel());
		const frame = await connectViewer();
		fireEvent.mouseDown(frame, { clientX: 320, clientY: 250, button: 2, detail: 1 });
		fireEvent.lostPointerCapture(frame);
		fireEvent.mouseUp(frame, { clientX: 320, clientY: 250, button: 2, detail: 1 });
		expect(mocks.sendInput.mock.calls.filter(([input]) => input.kind === "mouse.up")).toEqual([
			[{ kind: "mouse.up", button: "right", clickCount: 1 }],
		]);
	});

	test("mirrors chat changes to the attached popout", async () => {
		const child = { postMessage: vi.fn(), focus: vi.fn(), closed: false };
		vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
		const { rerender } = render(
			<>
				<FilesBrowserResumeThreadMirror />
				{browserPanel()}
			</>,
		);
		await connectViewer();
		fireEvent.click(screen.getByRole("button", { name: "Pop out" }));
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source: child as unknown as Window,
					data: { kind: "browser-takeover", sessionId: "session_1" },
				}),
			),
		);
		expect(child.postMessage).toHaveBeenCalledWith(
			{ kind: "browser-thread", sessionId: "session_1", threadId: "thread_selected" },
			window.location.origin,
		);
		mocks.selectedThreadId = "thread_next";
		rerender(
			<>
				<FilesBrowserResumeThreadMirror key="next" />
				{browserPanel()}
			</>,
		);
		await waitFor(() =>
			expect(child.postMessage).toHaveBeenCalledWith(
				{ kind: "browser-thread", sessionId: "session_1", threadId: "thread_next" },
				window.location.origin,
			),
		);
	});

	test("resumes only the chat sent by its opener for this session", async () => {
		// A fresh child window has no selected chat store from the Files sidebar.
		mocks.selectedThreadId = null;
		render(<FilesBrowserResumeThreadMirror />).unmount();
		const opener = { postMessage: vi.fn() };
		vi.stubGlobal("opener", opener);
		render(browserPanel("detached"));
		await connectViewer();
		const resume = screen.getByRole("button", { name: /^Resume agent/ });
		expect(resume).toHaveProperty("disabled", true);
		for (const overrides of [{ source: window }, { origin: "https://other.test" }]) {
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						origin: window.location.origin,
						source: opener as unknown as Window,
						data: { kind: "browser-thread", sessionId: "session_1", threadId: "thread_selected" },
						...overrides,
					}),
				),
			);
			expect(resume).toHaveProperty("disabled", true);
		}
		for (const overrides of [{ sessionId: "other_session" }, { threadId: 123 }]) {
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						origin: window.location.origin,
						source: opener as unknown as Window,
						data: { kind: "browser-thread", sessionId: "session_1", threadId: "thread_selected", ...overrides },
					}),
				),
			);
			expect(resume).toHaveProperty("disabled", true);
		}
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source: opener as unknown as Window,
					data: { kind: "browser-thread", sessionId: "session_1", threadId: "thread_selected" },
				}),
			),
		);
		expect(resume).toHaveProperty("disabled", false);
		fireEvent.click(resume);
		expect(
			mocks.action.mock.calls.find(
				([reference]) => getFunctionName(reference) === "files_browser:resume_browser_agent",
			)?.[1],
		).toEqual({ membershipId: "membership_1", sessionId: "session_1", threadId: "thread_selected" });
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					source: opener as unknown as Window,
					data: { kind: "browser-thread", sessionId: "session_1", threadId: null },
				}),
			),
		);
		expect(resume).toHaveProperty("disabled", true);
	});
});
