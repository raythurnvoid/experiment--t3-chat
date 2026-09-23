import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
	files_browser_StreamEvents,
	files_browser_StreamInput,
	files_browser_StreamNav,
} from "@/lib/files-browser-stream.ts";
import { WebBrowser } from "./web-browser.tsx";

const mocks = vi.hoisted(() => ({
	action: vi.fn(),
	mutation: vi.fn(),
	sendInput: vi.fn<(input: files_browser_StreamInput) => number>(),
	sendNav: vi.fn<(nav: files_browser_StreamNav) => number>(),
	sendFileChooserCancel: vi.fn<(chooserId: string) => boolean>(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	navigate: vi.fn(),
	fetch: vi.fn(),
	treeNodes: [] as Array<Record<string, unknown>>,
	events: null as files_browser_StreamEvents | null,
	session: null as Record<string, unknown> | null,
	// Lets a test push a new session value to the mounted panel, like a live Convex query does.
	sessionListeners: new Set<() => void>(),
	setSession(session: Record<string, unknown> | null) {
		mocks.session = session;
		for (const listener of mocks.sessionListeners) listener();
	},
	available: { enabled: true, paidPlan: true } as { enabled: boolean; paidPlan: boolean } | undefined,
	profile: null as { exists: boolean; lastUsedAt: number | null; agentBlockedHosts: string[] } | null,
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
	AiChatController: { useThreadList: () => ({ selectedThreadId: null }) },
}));
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: { action: mocks.action } };
});
vi.mock("convex/react", async () => {
	const { useSyncExternalStore } = await import("react");
	const client = { action: mocks.action, mutation: mocks.mutation };
	const subscribe = (listener: () => void) => {
		mocks.sessionListeners.add(listener);
		return () => mocks.sessionListeners.delete(listener);
	};
	return {
		useConvex: () => client,
		useQuery: (reference: never, args: unknown) => {
			const session = useSyncExternalStore(subscribe, () => mocks.session);
			if (args === "skip") return undefined;
			switch (getFunctionName(reference)) {
				case "files_browser:current_browser_session":
					return session;
				case "files_browser:current_browser_profile":
					return mocks.profile;
				case "files_browser:web_browser_available":
					return mocks.available;
				default:
					return null;
			}
		},
	};
});
vi.mock("@/lib/files-browser-stream.ts", () => ({
	files_browser_stream_connect: (args: { events: files_browser_StreamEvents }) => {
		mocks.events = args.events;
		return {
			sendInput: mocks.sendInput,
			sendNav: mocks.sendNav,
			sendFileChooserCancel: mocks.sendFileChooserCancel,
			close: vi.fn(),
		};
	},
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useFullList: (enabled: boolean) => (enabled ? mocks.treeNodes : undefined) },
}));
vi.mock("sonner", () => ({
	toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => mocks.navigate,
}));

function webSession(control: string) {
	return {
		mode: "web",
		sessionId: "session_web",
		navigationGeneration: 1,
		loadGen: 1,
		controlGen: 1,
		control,
		agentAccess: true,
		idleUntil: Date.now() + 540_000,
		totalUntil: Date.now() + 3_000_000,
	};
}

beforeEach(() => {
	mocks.action.mockReset();
	mocks.action.mockResolvedValue({ _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test" } });
	mocks.sendInput.mockReset();
	mocks.sendInput.mockReturnValue(1);
	mocks.sendNav.mockReset();
	mocks.sendNav.mockReturnValue(1);
	mocks.sendFileChooserCancel.mockReset();
	mocks.sendFileChooserCancel.mockReturnValue(true);
	mocks.toastSuccess.mockReset();
	mocks.toastError.mockReset();
	mocks.navigate.mockReset();
	mocks.navigate.mockResolvedValue(undefined);
	mocks.fetch.mockReset();
	mocks.treeNodes = [];
	mocks.events = null;
	mocks.session = null;
	mocks.available = { enabled: true, paidPlan: true };
	mocks.mutation.mockReset();
	mocks.mutation.mockResolvedValue({ _yay: null });
	mocks.profile = { exists: false, lastUsedAt: null, agentBlockedHosts: [] };
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function connectViewer(control: string) {
	await waitFor(() => expect(mocks.events).not.toBeNull());
	act(() =>
		mocks.events!.onHello({ viewerId: "viewer_1", viewport: { width: 1280, height: 800 }, control, controlGen: 1 }),
	);
	act(() =>
		mocks.events!.onWebMessage({
			t: "location",
			url: "https://start.test/",
			title: "Start page",
			loading: false,
			canGoBack: false,
			canGoForward: false,
		}),
	);
	return screen.getByRole("application");
}

describe("WebBrowser", () => {
	test("keeps the Start card and the address while starting, then shows the runner refusal", async () => {
		let finishStart: (result: unknown) => void = () => {};
		mocks.action.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishStart = resolve;
				}),
		);
		render(<WebBrowser />);
		fireEvent.change(screen.getByRole("textbox", { name: "Start address (optional)" }), {
			target: { value: "example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Start web browser" }));

		// The start door saved a starting doc, and the query pushed it before the runner answered.
		act(() => mocks.setSession(webSession("starting")));
		expect(screen.queryByRole("toolbar", { name: "Browser" })).toBeNull();
		expect(screen.getByRole("button", { name: "Starting…" })).toHaveProperty("disabled", true);

		// The runner refused the open, and the start door deleted the doc.
		act(() => mocks.setSession(null));
		await act(async () =>
			finishStart({ _nay: { message: "You already have 2 browsers open in other workspaces. End one first." } }),
		);
		expect(screen.getByRole("alert").textContent).toBe(
			"You already have 2 browsers open in other workspaces. End one first.",
		);
		expect(screen.getByRole("textbox", { name: "Start address (optional)" })).toHaveProperty("value", "example.com");
		expect(screen.getByRole("button", { name: "Start web browser" })).toHaveProperty("disabled", false);
	});

	test("keeps the address read-only without human control", async () => {
		mocks.session = webSession("ready");
		render(<WebBrowser />);
		await connectViewer("ready");

		const address = screen.getByRole("textbox", { name: "Address" });
		expect(address).toHaveProperty("readOnly", true);
		expect(address).toHaveProperty("value", "https://start.test/");
		expect(screen.getByText("Take control to navigate")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Go" })).toHaveProperty("disabled", true);
		fireEvent.submit(address.closest("form")!);
		expect(mocks.sendNav).not.toHaveBeenCalled();
	});

	// jsdom has no implicit form submission, so the test submits the form that Enter submits.
	test("Enter in the address sends one go nav with the normalized address", async () => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		const address = screen.getByRole("textbox", { name: "Address" });
		expect(address).toHaveProperty("readOnly", false);
		fireEvent.change(address, { target: { value: "example.com/docs" } });
		fireEvent.submit(address.closest("form")!);

		expect(mocks.sendNav.mock.calls).toEqual([[{ action: "go", url: "https://example.com/docs" }]]);
		expect(address).toHaveProperty("value", "https://start.test/");
	});

	test("shows a scheme error inline and sends nothing", async () => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		const address = screen.getByRole("textbox", { name: "Address" }) as HTMLInputElement;
		fireEvent.change(address, { target: { value: "ftp://files.test/" } });
		expect(address.validity.valid).toBe(false);
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.submit(address.closest("form")!);

		expect(screen.getByRole("alert").textContent).toBe("Use an address that starts with http:// or https://.");
		expect(mocks.sendNav).not.toHaveBeenCalled();
	});

	test("pastes local text as one text.insert and keeps copy local", async () => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		const frame = await connectViewer("human");

		fireEvent.paste(frame, { clipboardData: { getData: (type: string) => (type === "text/plain" ? "hello" : "") } });
		fireEvent.keyDown(frame, { key: "a", ctrlKey: true });
		fireEvent.keyDown(frame, { key: "z", metaKey: true });
		fireEvent.keyDown(frame, { key: "c", ctrlKey: true });
		fireEvent.keyDown(frame, { key: "x", metaKey: true });

		expect(mocks.sendInput.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "text.insert", text: "hello" },
			{ kind: "key.press", key: "Control+a" },
			{ kind: "key.press", key: "Control+z" },
		]);
	});

	test("the agent switch follows agent-access pushes", async () => {
		mocks.session = webSession("ready");
		render(<WebBrowser />);
		await connectViewer("ready");

		const agentSwitch = screen.getByRole("switch", { name: "Agent can use this browser" });
		expect(agentSwitch).toHaveProperty("checked", true);
		expect(agentSwitch.getAttribute("data-agent-access")).toBe("on");

		act(() => mocks.events!.onWebMessage({ t: "agent-access", on: false }));
		expect(agentSwitch).toHaveProperty("checked", false);
		expect(agentSwitch.getAttribute("data-agent-access")).toBe("off");
	});

	test("turning the switch off calls the agent access door", async () => {
		mocks.session = webSession("ready");
		render(<WebBrowser />);
		await connectViewer("ready");
		mocks.action.mockResolvedValue({ _yay: { agentAccess: false, controlGen: 2 } });

		fireEvent.click(screen.getByRole("switch", { name: "Agent can use this browser" }));

		await waitFor(() =>
			expect(
				mocks.action.mock.calls.find(
					([reference]) => getFunctionName(reference) === "files_browser:set_browser_agent_access",
				)?.[1],
			).toEqual({ membershipId: "membership_1", sessionId: "session_web", on: false }),
		);
	});

	test("shows runner notices as status text", async () => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		act(() => mocks.events!.onWebMessage({ t: "notice", code: "upload_unsupported" }));
		expect(screen.getByText("This site uses a file picker the cloud browser does not support.")).toBeTruthy();
		act(() => mocks.events!.onWebMessage({ t: "nav-ack", seq: 3, ok: false, code: "denied_host" }));
		expect(screen.getByText("This address is blocked")).toBeTruthy();
	});

	test("says so when a viewer reconnect drops human control", async () => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		// The socket dropped. The viewer retries with a new grant, and the runner gives control to one viewer id only.
		act(() => mocks.events!.onClose({ code: 1006, reason: "" }));

		expect(screen.getByText("You lost control because the viewer reconnected. Take control again.")).toBeTruthy();
	});

	test("the Start card asks Free plans to upgrade instead of starting", () => {
		mocks.available = { enabled: true, paidPlan: false };
		render(<WebBrowser />);

		expect(screen.getByText(/The browser needs a Pay As You Go or Pro plan\./)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Start web browser" })).toBeNull();
	});

	test("ends a live file browser before starting here", async () => {
		mocks.session = { mode: "file", sessionId: "session_file", nodeId: "node_1", targetKind: "saved" };
		mocks.action.mockResolvedValue({ _yay: {} });
		render(<WebBrowser />);

		expect(screen.getByText("A file browser is open in Files.")).toBeTruthy();
		fireEvent.change(screen.getByRole("textbox", { name: "Start address (optional)" }), {
			target: { value: "example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "End it and start here" }));

		await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(2));
		expect(mocks.action.mock.calls.map(([reference, args]) => [getFunctionName(reference), args])).toEqual([
			["files_browser:end_browser", { membershipId: "membership_1", sessionId: "session_file" }],
			[
				"files_browser:start_web_browser",
				{ membershipId: "membership_1", viewport: { width: 1280, height: 800 }, startUrl: "https://example.com/" },
			],
		]);
	});
});

describe("WebBrowserSavedData", () => {
	const SUMMARY = {
		exists: true,
		savedAt: Date.UTC(2026, 8, 23, 10, 42),
		truncated: true,
		sites: [
			{ domain: "example.com", cookies: 1 },
			{ domain: "gist.github.com", cookies: 3 },
			{ domain: "github.com", cookies: 12 },
		],
	};

	// Answer each saved data door by name. Other actions (the viewer grant) keep a working reply.
	function mockActions(results: Record<string, unknown>) {
		mocks.action.mockImplementation(async (reference: never) => {
			return results[getFunctionName(reference)] ?? { _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test" } };
		});
	}

	function actionCalls(name: string) {
		return mocks.action.mock.calls
			.filter(([reference]) => getFunctionName(reference) === name)
			.map(([, args]) => args as unknown);
	}

	function rowTexts(list: HTMLElement) {
		return within(list)
			.getAllByRole("listitem")
			.map((item) => item.firstElementChild?.textContent);
	}

	async function openSavedData() {
		fireEvent.click(screen.getByRole("button", { name: "Manage saved data" }));
		return await screen.findByRole("dialog", { name: "Manage saved data" });
	}

	test("shows the Saved data badge only when a saved profile exists", () => {
		render(<WebBrowser />);
		expect(screen.queryByText("Saved data")).toBeNull();
		cleanup();

		mocks.profile = { exists: true, lastUsedAt: Date.now(), agentBlockedHosts: [] };
		render(<WebBrowser />);
		expect(screen.getByText("Saved data")).toBeTruthy();
		cleanup();

		mocks.session = webSession("ready");
		render(<WebBrowser />);
		expect(screen.getByText("Saved data")).toBeTruthy();
	});

	test("the Start card explains saved logins and the agent risk", () => {
		render(<WebBrowser />);

		expect(
			screen.getByText("Your logins are saved for this workspace. Only you and your agent chats use them."),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Your agent can use the sites you are logged in to. Add sites it must not use, like your bank, under Manage saved data.",
			),
		).toBeTruthy();
		expect(screen.getByText("Reload the page before you type a password if the agent used it.")).toBeTruthy();
	});

	test("lists saved sites as names with cookie counts", async () => {
		mockActions({ "files_browser:list_browser_profile_sites": { _yay: SUMMARY } });
		render(<WebBrowser />);
		const dialog = await openSavedData();

		// No browser is live, so the list loads at once.
		const showButton = within(dialog).getByRole("button", { name: "Show saved sites" });
		showButton.focus();
		fireEvent.click(showButton);
		const list = await within(dialog).findByRole("list", { name: "Saved sites" });

		// The pressed button is gone, so the focus moves to the section heading, not to the page body.
		expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Saved sites" }));
		expect(rowTexts(list)).toEqual([
			"example.com — 1 cookie",
			"gist.github.com — 3 cookies",
			"github.com — 12 cookies",
		]);
		expect(actionCalls("files_browser:list_browser_profile_sites")).toEqual([{ membershipId: "membership_1" }]);
		expect(within(dialog).getByText(/^Last saved .* Some cookies were not saved/)).toBeTruthy();
	});

	test("warns before listing while a browser is live and lists only after confirm", async () => {
		mocks.session = webSession("ready");
		mockActions({ "files_browser:list_browser_profile_sites": { _yay: SUMMARY } });
		render(<WebBrowser />);
		const dialog = await openSavedData();

		fireEvent.click(within(dialog).getByRole("button", { name: "Show saved sites" }));
		expect(within(dialog).getByText(/Showing saved sites ends it first\./)).toBeTruthy();
		expect(dialog.getAttribute("data-sites-state")).toBe("confirm");
		expect(actionCalls("files_browser:list_browser_profile_sites")).toEqual([]);

		fireEvent.click(within(dialog).getByRole("button", { name: "End browser and show sites" }));
		await within(dialog).findByRole("list", { name: "Saved sites" });
		expect(actionCalls("files_browser:list_browser_profile_sites")).toEqual([{ membershipId: "membership_1" }]);
	});

	test("shows a list refusal", async () => {
		mockActions({
			"files_browser:list_browser_profile_sites": {
				_nay: { name: "profile_unreadable", message: "Saved data could not be read. Clear all to start fresh." },
			},
		});
		render(<WebBrowser />);
		const dialog = await openSavedData();

		fireEvent.click(within(dialog).getByRole("button", { name: "Show saved sites" }));

		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"Saved data could not be read. Clear all to start fresh.",
		);
	});

	test("Clear on a site calls the site door and drops that site and the hosts under it", async () => {
		mockActions({
			"files_browser:list_browser_profile_sites": { _yay: SUMMARY },
			"files_browser:clear_browser_profile_site": { _yay: { removed: 15 } },
		});
		render(<WebBrowser />);
		const dialog = await openSavedData();
		fireEvent.click(within(dialog).getByRole("button", { name: "Show saved sites" }));
		const list = await within(dialog).findByRole("list", { name: "Saved sites" });

		const clearButton = within(list).getByRole("button", { name: "Clear github.com" });
		clearButton.focus();
		fireEvent.click(clearButton);

		await within(dialog).findByText("Cleared github.com.");
		expect(actionCalls("files_browser:clear_browser_profile_site")).toEqual([
			{ membershipId: "membership_1", domain: "github.com" },
		]);
		expect(rowTexts(list)).toEqual(["example.com — 1 cookie"]);
		// The pressed button is gone, so the focus moves to the section heading, not to the page body.
		expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Saved sites" }));
	});

	test("Clear all asks first, then calls the clear door", async () => {
		mocks.profile = { exists: true, lastUsedAt: Date.now(), agentBlockedHosts: ["bank.example"] };
		mockActions({ "files_browser:clear_browser_profile": { _yay: null } });
		render(<WebBrowser />);
		const dialog = await openSavedData();

		fireEvent.click(within(dialog).getByRole("button", { name: "Clear all saved data" }));
		expect(
			within(dialog).getByText(
				"This signs you out of every site in this workspace's browser, for you and your agent chats. This also clears Sites the agent may not use.",
			),
		).toBeTruthy();
		expect(actionCalls("files_browser:clear_browser_profile")).toEqual([]);

		const clearAllButton = within(dialog).getByRole("button", { name: "Clear all" });
		clearAllButton.focus();
		fireEvent.click(clearAllButton);

		await within(dialog).findByText("All saved data is cleared.");
		expect(actionCalls("files_browser:clear_browser_profile")).toEqual([{ membershipId: "membership_1" }]);
		// The pressed button is gone, so the focus moves to the section heading, not to the page body.
		expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Clear all saved data" }));
	});

	test("adds and removes sites the agent may not use and shows a refusal", async () => {
		mocks.profile = { exists: true, lastUsedAt: Date.now(), agentBlockedHosts: ["bank.example"] };
		render(<WebBrowser />);
		const dialog = await openSavedData();

		expect(within(dialog).getByText("Best effort. Takes effect at the next start.")).toBeTruthy();
		expect(rowTexts(within(dialog).getByRole("list", { name: "Sites the agent may not use" }))).toEqual([
			"bank.example",
		]);

		const input = within(dialog).getByRole("textbox", { name: "Add a site" });
		fireEvent.change(input, { target: { value: "shop.example" } });
		const addButton = within(dialog).getByRole("button", { name: "Add" });
		addButton.focus();
		fireEvent.click(addButton);
		await waitFor(() => expect(input).toHaveProperty("value", ""));
		// Add turns disabled while the list saves. The focus goes back to the input for the next site.
		expect(document.activeElement).toBe(input);

		fireEvent.click(within(dialog).getByRole("button", { name: "Remove bank.example" }));
		await waitFor(() => expect(mocks.mutation).toHaveBeenCalledTimes(2));

		expect(mocks.mutation.mock.calls.map(([reference, args]) => [getFunctionName(reference), args])).toEqual([
			[
				"files_browser:set_browser_agent_blocked_hosts",
				{ membershipId: "membership_1", hosts: ["bank.example", "shop.example"] },
			],
			["files_browser:set_browser_agent_blocked_hosts", { membershipId: "membership_1", hosts: [] }],
		]);

		mocks.mutation.mockResolvedValueOnce({ _nay: { message: "Too many sites" } });
		fireEvent.change(input, { target: { value: "more.example" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

		expect((await within(dialog).findByRole("alert")).textContent).toBe("You can add at most 50 sites.");
		expect(input).toHaveProperty("value", "more.example");
	});
});

describe("WebBrowser downloads and file choosers", () => {
	const TREE_NODES = [
		{ _id: "node_a", kind: "file", name: "report.pdf", path: "/docs/report.pdf", archiveOperationId: null },
		{ _id: "node_b", kind: "file", name: "photo.png", path: "/photo.png", archiveOperationId: null },
		{ _id: "node_folder", kind: "folder", name: "docs", path: "/docs", archiveOperationId: null },
		{ _id: "node_old", kind: "file", name: "old.txt", path: "/old.txt", archiveOperationId: "archive_1" },
	];

	// Answer each door by name. Other actions (the viewer grant) keep a working reply.
	function mockActions(results: Record<string, unknown>) {
		mocks.action.mockImplementation(async (reference: never) => {
			return results[getFunctionName(reference)] ?? { _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test" } };
		});
	}

	function actionCalls(name: string) {
		return mocks.action.mock.calls
			.filter(([reference]) => getFunctionName(reference) === name)
			.map(([, args]) => args as unknown);
	}

	function emitDownload(downloadId: string) {
		act(() =>
			mocks.events!.onWebMessage({
				t: "download",
				downloadId,
				name: "report.pdf",
				size: 10,
				contentType: "application/pdf",
			}),
		);
	}

	async function openChooser(args: { control: string; multiple: boolean }) {
		mocks.session = webSession(args.control);
		render(<WebBrowser />);
		await connectViewer(args.control);
		// A newer control generation than the hello's. The fill must use this one.
		act(() => mocks.events!.onControl({ control: args.control, controlGen: 4 }));
		act(() =>
			mocks.events!.onWebMessage({
				t: "file-chooser",
				chooserId: "chooser_1",
				multiple: args.multiple,
				accept: "image/*, .pdf",
				origin: "https://upload.example",
			}),
		);
		return await screen.findByRole("dialog", {
			name: args.multiple ? "upload.example wants files" : "upload.example wants a file",
		});
	}

	function pickFromFiles(dialog: HTMLElement, name: RegExp) {
		fireEvent.click(within(dialog).getByRole("combobox", { name: "Choose from Files" }));
		fireEvent.click(screen.getByRole("option", { name }));
	}

	test("saves a download at once and offers Open and Delete", async () => {
		mockActions({
			"files_browser:save_browser_download": {
				_yay: { nodeId: "node_saved", path: "/.system/downloads/report.pdf", shared: false },
			},
		});
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		emitDownload("download_1");

		await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
		expect(actionCalls("files_browser:save_browser_download")).toEqual([
			{ membershipId: "membership_1", sessionId: "session_web", downloadId: "download_1" },
		]);
		const [text, options] = mocks.toastSuccess.mock.calls[0] as [
			string,
			{
				description: string | undefined;
				action: { label: string; onClick: () => void };
				cancel: { label: string; onClick: () => void };
			},
		];
		expect(text).toBe("Saved to .system/downloads/report.pdf");
		expect(options.description).toBeUndefined();
		expect([options.action.label, options.cancel.label]).toEqual(["Open", "Delete"]);

		options.action.onClick();
		expect(mocks.navigate).toHaveBeenCalledWith({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName: "team", workspaceName: "home" },
			search: { nodeId: "node_saved" },
		});

		options.cancel.onClick();
		await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(2));
		expect(mocks.mutation.mock.calls.map(([reference, args]) => [getFunctionName(reference), args])).toEqual([
			["files_nodes:archive_nodes", { membershipId: "membership_1", nodeIds: ["node_saved"] }],
		]);
	});

	test("says members can see a download saved in a team workspace", async () => {
		mockActions({
			"files_browser:save_browser_download": {
				_yay: { nodeId: "node_saved", path: "/.system/downloads/report-2.pdf", shared: true },
			},
		});
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		emitDownload("download_2");

		await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
		expect(mocks.toastSuccess.mock.calls[0]?.[0]).toBe("Saved to .system/downloads/report-2.pdf");
		expect(mocks.toastSuccess.mock.calls[0]?.[1]).toMatchObject({
			description: "Members of this workspace can see it.",
		});
	});

	test("shows a refused save as an error toast with Retry, which saves the same download again", async () => {
		mockActions({
			"files_browser:save_browser_download": {
				_nay: { name: "download_push_failed", message: "Download not saved: the upload failed." },
			},
		});
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		emitDownload("download_3");

		await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
		const [text, options] = mocks.toastError.mock.calls[0] as [
			string,
			{ action: { label: string; onClick: () => void } },
		];
		expect(text).toBe("Download not saved: the upload failed.");
		expect(options.action.label).toBe("Retry");
		expect(mocks.toastSuccess).not.toHaveBeenCalled();

		// The runner still holds the bytes, so Retry asks Convex to save the same download again.
		mockActions({
			"files_browser:save_browser_download": {
				_yay: { nodeId: "node_saved", path: "/.system/downloads/report.pdf", shared: false },
			},
		});
		options.action.onClick();
		await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
		expect(actionCalls("files_browser:save_browser_download")).toEqual([
			{ membershipId: "membership_1", sessionId: "session_web", downloadId: "download_3" },
			{ membershipId: "membership_1", sessionId: "session_web", downloadId: "download_3" },
		]);
	});

	test.each([
		["download_unsupported", "This download is not supported in the cloud browser."],
		["download_blocked", "A download started without a click was blocked."],
		["download_busy", "Download not saved: another download is still being saved."],
		["download_too_large", "Download not saved: over 25 MB."],
		["download_limit", "Download not saved: too many downloads in this session."],
		["download_lost", "A download was not saved in time."],
		["download_failed", "Download not saved: it did not finish."],
		["upload_unsupported", "This site uses a file picker the cloud browser does not support."],
	])("shows the %s notice", async (code, text) => {
		mocks.session = webSession("human");
		render(<WebBrowser />);
		await connectViewer("human");

		act(() => mocks.events!.onWebMessage({ t: "notice", code }));

		expect(screen.getByText(text)).toBeTruthy();
	});

	test("Choose from Files fills the picked file with the current control generation", async () => {
		mocks.treeNodes = TREE_NODES;
		mockActions({ "files_browser:fill_browser_chooser_from_files": { _yay: null } });
		const dialog = await openChooser({ control: "human", multiple: false });

		expect(within(dialog).getByText("Accepted types: image/*, .pdf.")).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("combobox", { name: "Choose from Files" }));
		// Only live files are offered: no folder and no archived file.
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
			"report.pdf/docs/report.pdf",
			"photo.png/photo.png",
		]);
		fireEvent.click(screen.getByRole("option", { name: /report\.pdf/ }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Give to the page" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(actionCalls("files_browser:fill_browser_chooser_from_files")).toEqual([
			{
				membershipId: "membership_1",
				sessionId: "session_web",
				chooserId: "chooser_1",
				controlGen: 4,
				nodeIds: ["node_a"],
			},
		]);
		expect(screen.getByText("File given to the page")).toBeTruthy();
	});

	test("a page that takes one file keeps only the last pick", async () => {
		mocks.treeNodes = TREE_NODES;
		mockActions({ "files_browser:fill_browser_chooser_from_files": { _yay: null } });
		const dialog = await openChooser({ control: "human", multiple: false });

		pickFromFiles(dialog, /report\.pdf/);
		pickFromFiles(dialog, /photo\.png/);

		const chosen = within(dialog).getByRole("list", { name: "Chosen files" });
		expect(
			within(chosen)
				.getAllByRole("listitem")
				.map((item) => item.firstElementChild?.textContent),
		).toEqual(["/photo.png"]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Give to the page" }));

		await waitFor(() => expect(actionCalls("files_browser:fill_browser_chooser_from_files")).toHaveLength(1));
		expect(actionCalls("files_browser:fill_browser_chooser_from_files")[0]).toMatchObject({ nodeIds: ["node_b"] });
	});

	test("a page that takes several files keeps each pick and says the computer gives one", async () => {
		mocks.treeNodes = TREE_NODES;
		mockActions({ "files_browser:fill_browser_chooser_from_files": { _yay: null } });
		const dialog = await openChooser({ control: "human", multiple: true });

		expect(within(dialog).getByText("One file at a time from your computer.")).toBeTruthy();
		pickFromFiles(dialog, /report\.pdf/);
		pickFromFiles(dialog, /photo\.png/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Give 2 files to the page" }));

		await waitFor(() => expect(actionCalls("files_browser:fill_browser_chooser_from_files")).toHaveLength(1));
		expect(actionCalls("files_browser:fill_browser_chooser_from_files")[0]).toMatchObject({
			nodeIds: ["node_a", "node_b"],
		});
	});

	test("shows a refused fill as a toast when the runner closed the chooser first", async () => {
		mocks.treeNodes = TREE_NODES;
		let finishFill: (result: unknown) => void = () => {};
		mocks.action.mockImplementation(async (reference: never) => {
			if (getFunctionName(reference) === "files_browser:fill_browser_chooser_from_files") {
				return await new Promise((resolve) => {
					finishFill = resolve;
				});
			}
			return { _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test" } };
		});
		const dialog = await openChooser({ control: "human", multiple: false });

		pickFromFiles(dialog, /report\.pdf/);
		fireEvent.click(within(dialog).getByRole("button", { name: "Give to the page" }));
		await waitFor(() => expect(actionCalls("files_browser:fill_browser_chooser_from_files")).toHaveLength(1));

		// The real runner closes the chooser before `setFiles`. The page then navigated, so the fill failed.
		act(() => mocks.events!.onWebMessage({ t: "file-chooser-closed", chooserId: "chooser_1" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		await act(async () =>
			finishFill({ _nay: { name: "chooser_gone", message: "The page no longer asks for a file." } }),
		);

		expect(mocks.toastError).toHaveBeenCalledWith("The page no longer asks for a file.");
		expect(screen.queryByText("File given to the page")).toBeNull();
	});

	test("keeps the focus in the dialog while the fill runs", async () => {
		mocks.treeNodes = TREE_NODES;
		let finishFill: (result: unknown) => void = () => {};
		mocks.action.mockImplementation(async (reference: never) => {
			if (getFunctionName(reference) === "files_browser:fill_browser_chooser_from_files") {
				return await new Promise((resolve) => {
					finishFill = resolve;
				});
			}
			return { _yay: { grantId: "grant_1", viewerUrl: "wss://viewer.test" } };
		});
		const dialog = await openChooser({ control: "human", multiple: false });

		pickFromFiles(dialog, /report\.pdf/);
		const giveButton = within(dialog).getByRole("button", { name: "Give to the page" });
		giveButton.focus();
		fireEvent.click(giveButton);
		await waitFor(() => expect(giveButton).toHaveProperty("disabled", true));

		// The pressed button is disabled, so the focus moves to the dialog heading, not to the page body.
		expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "upload.example wants a file" }));
		await act(async () => finishFill({ _yay: null }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("From your computer gets a grant, then PUTs the file with its name and type", async () => {
		vi.stubGlobal("fetch", mocks.fetch);
		mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
		mockActions({
			"files_browser:grant_browser_upload": {
				_yay: { url: "https://runner.test/viewer/upload?ownerId=user_1&grantId=grant_9", expiresAt: 1 },
			},
		});
		const dialog = await openChooser({ control: "human", multiple: false });
		const file = new File(["hello"], "my notes.txt", { type: "text/plain" });

		fireEvent.change(within(dialog).getByLabelText("File from your computer"), { target: { files: [file] } });

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(actionCalls("files_browser:grant_browser_upload")).toEqual([
			{ membershipId: "membership_1", sessionId: "session_web", chooserId: "chooser_1", controlGen: 4 },
		]);
		expect(mocks.fetch.mock.calls).toEqual([
			[
				"https://runner.test/viewer/upload?ownerId=user_1&grantId=grant_9&name=my%20notes.txt",
				{ method: "PUT", body: file, headers: { "Content-Type": "text/plain" } },
			],
		]);
		expect(screen.getByText("File given to the page")).toBeTruthy();
	});

	test("From your computer shows the runner's refusal and sends an untyped file as octet-stream", async () => {
		vi.stubGlobal("fetch", mocks.fetch);
		mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ ok: false, code: "not_human" }) });
		mockActions({
			"files_browser:grant_browser_upload": {
				_yay: { url: "https://runner.test/viewer/upload?grantId=grant_9", expiresAt: 1 },
			},
		});
		const dialog = await openChooser({ control: "human", multiple: true });

		fireEvent.change(within(dialog).getByLabelText("File from your computer"), {
			target: { files: [new File(["x"], "data")] },
		});

		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"You no longer have control, so the page stopped waiting for this file. Take control and open the file dialog again.",
		);
		// The dialog is still open and shows the refusal, so no toast repeats it.
		expect(mocks.toastError).not.toHaveBeenCalled();
		expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { "Content-Type": "application/octet-stream" } });
	});

	test("From your computer says so when the runner could not read the upload", async () => {
		vi.stubGlobal("fetch", mocks.fetch);
		mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ ok: false, code: "upload_failed" }) });
		mockActions({
			"files_browser:grant_browser_upload": {
				_yay: { url: "https://runner.test/viewer/upload?grantId=grant_9", expiresAt: 1 },
			},
		});
		const dialog = await openChooser({ control: "human", multiple: false });

		fireEvent.change(within(dialog).getByLabelText("File from your computer"), {
			target: { files: [new File(["x"], "data.txt", { type: "text/plain" })] },
		});

		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"The file could not be sent to the page. Try again.",
		);
	});

	test("Cancel sends file-chooser-cancel and closes the dialog", async () => {
		const dialog = await openChooser({ control: "human", multiple: false });

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

		expect(mocks.sendFileChooserCancel.mock.calls).toEqual([["chooser_1"]]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("file-chooser-closed closes the open dialog, and ignores another chooser", async () => {
		await openChooser({ control: "human", multiple: false });

		act(() => mocks.events!.onWebMessage({ t: "file-chooser-closed", chooserId: "chooser_other" }));
		expect(screen.getByRole("dialog", { name: "upload.example wants a file" })).toBeTruthy();

		act(() => mocks.events!.onWebMessage({ t: "file-chooser-closed", chooserId: "chooser_1" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mocks.sendFileChooserCancel).not.toHaveBeenCalled();
	});

	test("without control the dialog says so and gives nothing", async () => {
		const dialog = await openChooser({ control: "ready", multiple: false });

		expect(within(dialog).getByText(/^Control of the browser changed, so the page no longer waits/)).toBeTruthy();
		expect(within(dialog).getByRole("combobox", { name: "Choose from Files" })).toHaveProperty("disabled", true);
		expect(within(dialog).getByRole("button", { name: "From your computer" })).toHaveProperty("disabled", true);
	});

	test("losing control while the dialog is open offers Close and keeps the focus in the dialog", async () => {
		const dialog = await openChooser({ control: "human", multiple: false });
		within(dialog).getByRole("button", { name: "From your computer" }).focus();

		// The socket dropped. The runner closes the chooser when control changes, and the new socket never hears that.
		act(() => mocks.events!.onClose({ code: 1006, reason: "" }));

		expect(
			within(dialog).getByText(
				"Control of the browser changed, so the page no longer waits for this file. Close this dialog, take control, and open the file dialog on the page again.",
			),
		).toBeTruthy();
		expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
		// The corner X is also named "Close". The footer button is the one with the text.
		const closeButton = within(dialog)
			.getAllByRole("button", { name: "Close" })
			.find((button) => button.textContent === "Close");
		expect(document.activeElement).toBe(closeButton);

		fireEvent.click(closeButton!);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	test("taking control again after a missed chooser close keeps the dialog closed to files", async () => {
		const dialog = await openChooser({ control: "human", multiple: false });

		// Control moved on and came back. The runner closed this chooser, but the closed message never came.
		act(() => mocks.events!.onControl({ control: "ready", controlGen: 5 }));
		act(() => mocks.events!.onControl({ control: "human", controlGen: 6 }));

		expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
		expect((within(dialog).getByRole("button", { name: "From your computer" }) as HTMLButtonElement).disabled).toBe(true);
	});
});
