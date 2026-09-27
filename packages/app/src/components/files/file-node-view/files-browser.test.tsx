import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { files_browser_StreamEvents, files_browser_StreamInput } from "@/lib/files-browser-stream.ts";
import { FilesBrowser, FilesBrowserResumeThreadMirror } from "./files-browser.tsx";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	mutation: vi.fn(),
	sendInput: vi.fn<(input: files_browser_StreamInput) => number>(),
	events: null as files_browser_StreamEvents | null,
	selectedThreadId: "thread_selected" as string | null,
	control: "human",
	controlGen: 1,
	sessionEnded: false,
	sessionLoading: false,
	webSession: false,
	paidPlan: true,
	sessionId: "session_1",
	sessionNodeId: "node_1",
	sessionPath: "/page.html",
	sessionSourceKind: "saved",
	sessionNavigationGeneration: 1,
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
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: (props: { to: string; children?: ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: { useThreadList: () => ({ selectedThreadId: mocks.selectedThreadId }) },
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action: mocks.action } };
});
vi.mock("convex/react", () => {
	const client = { action: mocks.action, mutation: mocks.mutation };
	return {
		useConvex: () => client,
		useQuery: (reference: never, args: unknown) => {
			if (args === "skip") return undefined;
			switch (getFunctionName(reference)) {
				case "files_browser:current_browser_session":
					if (mocks.sessionLoading) return undefined;
					if (mocks.sessionEnded) return null;
					if (mocks.webSession) {
						return {
							mode: "web",
							sessionId: "session_web",
							navigationGeneration: 1,
							loadGen: 1,
							controlGen: 1,
							control: "ready",
							agentAccess: true,
							idleUntil: Date.now() + 300_000,
							totalUntil: Date.now() + 1_200_000,
						};
					}
					return {
						mode: "file",
						sessionId: mocks.sessionId,
						nodeId: mocks.sessionNodeId,
						targetKind: "saved",
						path: mocks.sessionPath,
						navigationGeneration: mocks.sessionNavigationGeneration,
						control: mocks.control,
						sourceKind: mocks.sessionSourceKind,
						sourceVersion: "v1",
						sourceHash: "hash",
						loadGen: 1,
						controlGen: mocks.controlGen,
						idleUntil: Date.now() + 300_000,
						totalUntil: Date.now() + 1_200_000,
					};
				case "files_browser:web_browser_available":
					return { enabled: true, paidPlan: mocks.paidPlan };
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
	mocks.sessionLoading = false;
	mocks.webSession = false;
	mocks.paidPlan = true;
	mocks.sessionId = "session_1";
	mocks.sessionNodeId = "node_1";
	mocks.sessionPath = "/page.html";
	mocks.sessionSourceKind = "saved";
	mocks.sessionNavigationGeneration = 1;
	mocks.mutation.mockReset();
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

	test("shows the plan text instead of Start on a free plan", () => {
		mocks.sessionEnded = true;
		mocks.paidPlan = false;
		render(browserPanel());
		expect(
			screen.getByText(
				"The browser needs a Pay As You Go or Pro plan. Change your plan in Billing, in your account menu.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start shared browser" })).toBeNull();
	});

	test("offers to end a live web browser instead of starting a file browser", async () => {
		mocks.webSession = true;
		render(browserPanel());
		expect(screen.getByText("A web browser is open.")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open the web browser" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start shared browser" })).toBeNull();
		expect(screen.queryByRole("application")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "End it" }));
		expect(
			mocks.action.mock.calls.find(([reference]) => getFunctionName(reference) === "files_browser:end_browser")?.[1],
		).toEqual({ membershipId: "membership_1", sessionId: "session_web" });
	});

	test("offers to open or end the browser of another file instead of starting", () => {
		mocks.sessionNodeId = "node_other";
		mocks.sessionPath = "/docs/other.html";
		const opened = vi.fn();
		window.addEventListener("files::open_browser", opened);
		render(browserPanel());
		expect(screen.getByText("A browser is open on other.html.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start shared browser" })).toBeNull();
		expect(screen.queryByRole("application")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open other.html" }));
		window.removeEventListener("files::open_browser", opened);
		expect(opened.mock.calls.map(([event]) => event.detail)).toEqual([
			{ membershipId: "membership_1", nodeId: "node_other", targetKind: "saved" },
		]);

		fireEvent.click(screen.getByRole("button", { name: "End it" }));
		expect(
			mocks.action.mock.calls.find(([reference]) => getFunctionName(reference) === "files_browser:end_browser")?.[1],
		).toEqual({ membershipId: "membership_1", sessionId: "session_1" });
	});

	test("waits for the session query instead of offering Start", () => {
		mocks.sessionLoading = true;
		render(browserPanel());
		expect(screen.getByRole("status").textContent).toBe("Loading…");
		expect(screen.queryByRole("button", { name: "Start shared browser" })).toBeNull();
	});

	// This tab's `nav.generation` moves on when the user opens another file and comes back, while the
	// session keeps its own `navigationGeneration`. Reload checks the capture against the session.
	test("reloads a draft with the session's navigationGeneration", async () => {
		mocks.sessionSourceKind = "draft";
		mocks.sessionNavigationGeneration = 7;
		mocks.mutation.mockImplementation(async (reference) =>
			getFunctionName(reference) === "files_browser:capture_browser_draft"
				? { _yay: { captureId: "capture_1", uploadUrl: "https://upload.test" } }
				: { _yay: null },
		);
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ storageId: "storage_1" })));
		render(
			<FilesBrowser
				targetKind="saved"
				nodeId="node_1"
				path="/page.html"
				host="docked"
				editorRevision={0}
				serverSequence={0}
				getDraftText={() => "<p>draft</p>"}
				getDraftRevision={() => 1}
			/>,
		);
		await connectViewer();

		fireEvent.click(screen.getByRole("button", { name: "Reload from current source" }));
		await waitFor(() =>
			expect(
				mocks.action.mock.calls.find(([reference]) => getFunctionName(reference) === "files_browser:reload_browser")?.[1],
			).toMatchObject({ sessionId: "session_1", draftCaptureId: "capture_1", draftStorageId: "storage_1" }),
		);
		expect(
			mocks.mutation.mock.calls.find(
				([reference]) => getFunctionName(reference) === "files_browser:capture_browser_draft",
			)?.[1],
		).toMatchObject({ nodeId: "node_1", navigationGeneration: 7 });
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

	// The popout store lives in the module and outlasts one test, so each popout test uses its own session.
	test("mirrors chat changes to the attached popout", async () => {
		mocks.sessionId = "session_popout_chat";
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
					data: { kind: "browser-takeover", sessionId: "session_popout_chat" },
				}),
			),
		);
		expect(child.postMessage).toHaveBeenCalledWith(
			{ kind: "browser-thread", sessionId: "session_popout_chat", threadId: "thread_selected" },
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
				{ kind: "browser-thread", sessionId: "session_popout_chat", threadId: "thread_next" },
				window.location.origin,
			),
		);
	});

	// Leaving the Browser view or the file unmounts this panel while the popout keeps running.
	test("docks the popout after its panel was gone", async () => {
		mocks.sessionId = "session_popout_dock";
		const child = { postMessage: vi.fn(), focus: vi.fn(), closed: false };
		vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
		const fromChild = (data: { kind: string; sessionId: string }) =>
			act(() =>
				window.dispatchEvent(
					new MessageEvent("message", { origin: window.location.origin, source: child as unknown as Window, data }),
				),
			);
		const first = render(browserPanel());
		await connectViewer();
		fireEvent.click(screen.getByRole("button", { name: "Pop out" }));
		fromChild({ kind: "browser-takeover", sessionId: "session_popout_dock" });
		expect(screen.getByText("Viewing in a popout window.")).toBeTruthy();
		first.unmount();

		// Mounting again must not attach a second viewer, or it would take control from the popout.
		mocks.events = null;
		const second = render(browserPanel());
		expect(screen.getByText("Viewing in a popout window.")).toBeTruthy();
		expect(screen.queryByRole("application")).toBeNull();
		second.unmount();

		const opened = vi.fn();
		window.addEventListener("files::open_browser", opened);
		fromChild({ kind: "browser-dock-request", sessionId: "session_popout_dock" });
		window.removeEventListener("files::open_browser", opened);
		expect(opened.mock.calls.map(([event]) => event.detail)).toEqual([
			{ membershipId: "membership_1", nodeId: "node_1", targetKind: "saved" },
		]);

		render(browserPanel());
		await connectViewer();
		await waitFor(() =>
			expect(child.postMessage).toHaveBeenCalledWith(
				{ kind: "browser-dock-ack", sessionId: "session_popout_dock" },
				window.location.origin,
			),
		);
		expect(screen.getByRole("button", { name: "Pop out" })).toBeTruthy();
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
