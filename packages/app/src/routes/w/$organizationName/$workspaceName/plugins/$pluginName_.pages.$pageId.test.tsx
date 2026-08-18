/**
 * @vitest-environment jsdom
 *
 * These tests cover the route's state machine and message fields. WindowProxy identity,
 * sandbox navigation, and concrete-origin delivery require the browser-project coverage.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { paramsMock, tenantContextMock, useQueryMock, mutationMock } = vi.hoisted(() => ({
	paramsMock: vi.fn(),
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: (_path: string) => (options: unknown) => ({
		options,
		useParams: () => paramsMock(),
	}),
}));

vi.mock("convex/react", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: {
		mutation: (...args: unknown[]) => mutationMock(...args),
	},
	app_convex_api: {
		plugins_ui: {
			list_ui_pages: "plugins_ui.list_ui_pages",
			mint_page_session: "plugins_ui.mint_page_session",
			refresh_ui_session: "plugins_ui.refresh_ui_session",
			revoke_ui_session: "plugins_ui.revoke_ui_session",
		},
	},
	app_convex_deployment_url: "https://deployment.convex.test",
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuthenticated: () => ({ userId: "user_1", isAnonymous: false }),
	},
}));

vi.mock("@/components/plugins-header-breadcrumb.tsx", () => ({
	PluginsHeaderBreadcrumb: function PluginsHeaderBreadcrumb() {
		return <div>Breadcrumb</div>;
	},
}));

vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: <T,>(fn: T) => fn,
}));

vi.mock("@/components/my-button.tsx", () => ({
	MyButton: function MyButton(props: { ref?: Ref<HTMLButtonElement>; children?: ReactNode; onClick?: () => void }) {
		return (
			<button type="button" ref={props.ref} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
}));

import { PluginsUiFrame } from "@/components/plugins-ui-frame.tsx";
import { Route } from "./$pluginName_.pages.$pageId.tsx";

const postMessageMock = vi.fn();
const frameWindow = { postMessage: postMessageMock } as unknown as Window;
const CONVEX_HTTP_ORIGIN = new URL(import.meta.env.VITE_CONVEX_HTTP_URL).origin;

function createUiPages() {
	return [
		{
			pluginName: "gallery",
			displayName: "Gallery",
			pluginVersionId: "version_1",
			pages: [{ id: "media", title: "Media", entry: "dist/frontend/index.html", navItem: null }],
		},
	];
}

function bridge_for(container: HTMLElement) {
	const iframe = container.querySelector("iframe");
	if (!iframe) {
		throw new Error("iframe not rendered");
	}
	const src = iframe.getAttribute("src");
	if (!src) {
		throw new Error("iframe src not assigned");
	}
	const iframeUrl = new URL(src);
	const fragment = new URLSearchParams(iframeUrl.hash.slice(1));
	const bridgeNonce = fragment.get("bridgeNonce");
	if (!bridgeNonce) {
		throw new Error("iframe bridge nonce not assigned");
	}
	return { iframe, iframeUrl, fragment, bridgeNonce };
}

function post_from_frame(data: unknown, origin = CONVEX_HTTP_ORIGIN) {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source: frameWindow }));
}

function post_ready(bridgeNonce: string) {
	post_from_frame({ type: "bonobo:ready", bridgeNonce });
}

function latest_init_message() {
	const message = postMessageMock.mock.calls.findLast(
		([value]) => (value as { type?: string }).type === "bonobo:init",
	)?.[0] as { bridgeNonce: string; token: string; context: Record<string, unknown> } | undefined;
	if (!message) {
		throw new Error("init message not posted");
	}
	return message;
}

describe("RoutePluginsPluginPage", () => {
	beforeEach(() => {
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "media" });
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "org_1",
			workspaceId: "ws_1",
		});
		useQueryMock.mockReturnValue(createUiPages());
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? Promise.resolve({
						_yay: {
							token: "plu_default",
							expiresAt: Date.now() + 60_000,
							pluginVersionId: "version_1",
							sessionId: "session_default",
						},
					})
				: Promise.resolve({ _yay: {} }),
		);
		vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(frameWindow);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	test("keeps the asset query empty and assigns a fresh fragment bootstrap on every mount", () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const first = render(<PageComponent />);
		const firstBridge = bridge_for(first.container);
		first.unmount();
		const second = render(<PageComponent />);
		const secondBridge = bridge_for(second.container);

		expect(firstBridge.iframeUrl.origin).toBe(secondBridge.iframeUrl.origin);
		expect(firstBridge.iframeUrl.pathname).toBe(secondBridge.iframeUrl.pathname);
		expect(secondBridge.iframeUrl.pathname).toBe("/plugins-ui/version_1/dist/frontend/index.html");
		expect([...secondBridge.iframeUrl.searchParams]).toEqual([]);
		expect([...secondBridge.fragment]).toEqual([
			["parentOrigin", window.location.origin],
			["bridgeNonce", secondBridge.bridgeNonce],
		]);
		expect(secondBridge.bridgeNonce).not.toBe(firstBridge.bridgeNonce);
		expect(secondBridge.iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
		// `allow-forms` lets plugin JS handle submit events; the asset CSP's `form-action 'none'`
		// keeps real HTTP form submissions blocked.
		expect(secondBridge.iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
	});

	test("mint failure replaces the page with an alert and moves focus to Retry", async () => {
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session" ? { _nay: { message: "Unauthorized" } } : { _yay: {} },
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Unauthorized");
		const retry = screen.getByRole("button", { name: "Retry" });
		// Focus moves in a passive effect, which findByRole's observer can outrun.
		await waitFor(() => expect(document.activeElement).toBe(retry));
	});

	test("mints in parallel but waits for the frame ready message before posting init", async () => {
		let resolveMint: ((value: unknown) => void) | null = null;
		const mintPromise = new Promise((resolve) => {
			resolveMint = resolve;
		});
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session" ? mintPromise : Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.mint_page_session", expect.anything());

		await act(async () => {
			resolveMint?.({
				_yay: {
					token: "plu_parallel",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_parallel",
				},
			});
			await mintPromise;
		});
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);

		await act(async () => post_ready(bridgeNonce));
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("init hands the page its own Convex connection: the deployment url and the session token", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);
		await act(async () => post_ready(bridgeNonce));

		// The page's SDK opens its own ConvexClient against convexUrl and exchanges the token at
		// apiOrigin for a plugin-session JWT. The host posts these once and is out of the data path.
		expect(latest_init_message()).toMatchObject({
			type: "bonobo:init",
			bridgeNonce,
			apiOrigin: import.meta.env.VITE_CONVEX_HTTP_URL,
			convexUrl: "https://deployment.convex.test",
			token: "plu_default",
		});
	});

	test("startup deadline replaces the page with an alert and moves focus to Retry", () => {
		vi.useFakeTimers();

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);
		expect(screen.queryByRole("alert")).toBeNull();

		act(() => vi.advanceTimersByTime(15_000));

		expect(screen.getByRole("alert").textContent).toContain("The plugin page did not start in time");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
	});

	test("init completed just before the host deadline keeps the frame active", async () => {
		vi.useFakeTimers();
		let resolveMint: ((value: unknown) => void) | null = null;
		const mintPromise = new Promise((resolve) => {
			resolveMint = resolve;
		});
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session" ? mintPromise : Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);
		post_ready(bridgeNonce);
		act(() => vi.advanceTimersByTime(14_999));
		await act(async () => {
			resolveMint?.({
				_yay: {
					token: "plu_on_time",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_on_time",
				},
			});
			await mintPromise;
		});
		act(() => vi.advanceTimersByTime(1));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("revokes a session minted after the host deadline without posting init", async () => {
		vi.useFakeTimers();
		let resolveMint: ((value: unknown) => void) | null = null;
		const mintPromise = new Promise((resolve) => {
			resolveMint = resolve;
		});
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session" ? mintPromise : Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);
		post_ready(bridgeNonce);
		act(() => vi.advanceTimersByTime(15_000));

		await act(async () => {
			resolveMint?.({
				_yay: {
					token: "plu_late",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_late",
				},
			});
			await mintPromise;
		});

		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_late",
		});
	});

	test("revokes a session that finishes minting after unmount without posting init", async () => {
		let resolveMint: ((value: unknown) => void) | null = null;
		const mintPromise = new Promise((resolve) => {
			resolveMint = resolve;
		});
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session" ? mintPromise : Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const mounted = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(mounted.container);
		post_ready(bridgeNonce);
		mounted.unmount();

		await act(async () => {
			resolveMint?.({
				_yay: {
					token: "plu_after_unmount",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_after_unmount",
				},
			});
			await mintPromise;
		});

		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_after_unmount",
		});
	});

	test("drops messages with a foreign source, origin, nonce, or malformed request id", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);

		await act(async () => {
			// Correct origin but a foreign source window, so only the source guard can drop it.
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", bridgeNonce },
					origin: CONVEX_HTTP_ORIGIN,
					source: {} as Window,
				}),
			);
			post_from_frame({ type: "bonobo:ready", bridgeNonce }, "https://host.test");
			post_from_frame({ type: "bonobo:ready" });
			post_from_frame({ type: "bonobo:ready", bridgeNonce: crypto.randomUUID() });
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce,
				requestId: "",
			});
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce,
				requestId: "x".repeat(65),
			});
		});

		expect(mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.mint_page_session")).toHaveLength(
			1,
		);
		expect(postMessageMock).not.toHaveBeenCalled();
	});

	test("coalesces repeated ready messages and rejects a returned version mismatch", async () => {
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? {
						_yay: {
							token: "plu_token",
							expiresAt: Date.now() + 60_000,
							pluginVersionId: "version_2",
							sessionId: "session_1",
						},
					}
				: { _yay: {} },
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);

		await act(async () => {
			post_ready(bridgeNonce);
			post_ready(bridgeNonce);
		});

		expect(mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.mint_page_session")).toHaveLength(
			1,
		);
		expect(screen.getByRole("alert").textContent).toContain("installed plugin version changed");
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("serializes refreshes and reuses the response for a repeated request id", async () => {
		let resolveRefresh: ((value: unknown) => void) | null = null;
		const refreshPromise = new Promise((resolve) => {
			resolveRefresh = resolve;
		});
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				return Promise.resolve({
					_yay: {
						token: "plu_1",
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: "session_1",
					},
				});
			}
			if (reference === "plugins_ui.refresh_ui_session") {
				return refreshPromise;
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);
		await act(async () => post_ready(bridge.bridgeNonce));
		const { bridgeNonce } = latest_init_message();
		expect(bridgeNonce).toBe(bridge.bridgeNonce);
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce,
				requestId: "refresh_1",
			});
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce,
				requestId: "refresh_2",
			});
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error", requestId: "refresh_2" }),
			CONVEX_HTTP_ORIGIN,
		);

		await act(async () => {
			resolveRefresh?.({
				_yay: { token: "plu_2", expiresAt: Date.now() + 60_000, pluginVersionId: "version_1" },
			});
			await refreshPromise;
		});
		post_from_frame({
			type: "bonobo:token-refresh-request",
			bridgeNonce,
			requestId: "refresh_1",
		});

		expect(
			mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.refresh_ui_session"),
		).toHaveLength(1);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_1", token: "plu_2" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("does not post a refresh that finishes after unmount", async () => {
		let resolveRefresh: ((value: unknown) => void) | null = null;
		const refreshPromise = new Promise((resolve) => {
			resolveRefresh = resolve;
		});
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				return Promise.resolve({
					_yay: {
						token: "plu_1",
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: "session_1",
					},
				});
			}
			if (reference === "plugins_ui.refresh_ui_session") {
				return refreshPromise;
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const mounted = render(<PageComponent />);
		const bridge = bridge_for(mounted.container);
		await act(async () => post_ready(bridge.bridgeNonce));
		const { bridgeNonce } = latest_init_message();
		expect(bridgeNonce).toBe(bridge.bridgeNonce);
		postMessageMock.mockClear();
		post_from_frame({
			type: "bonobo:token-refresh-request",
			bridgeNonce,
			requestId: "refresh_after_unmount",
		});
		mounted.unmount();

		await act(async () => {
			resolveRefresh?.({
				_yay: { token: "plu_2", expiresAt: Date.now() + 60_000, pluginVersionId: "version_1" },
			});
			await refreshPromise;
		});

		expect(postMessageMock).not.toHaveBeenCalled();
	});

	test("a refresh that finds the session gone remounts the frame instead of answering token-error", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				return Promise.resolve({
					_yay: {
						token: `plu_${mintCount}`,
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: `session_${mintCount}`,
					},
				});
			}
			// The server deleted the session doc (the device slept past the session expiry), so the
			// refresh answers "Unauthorized".
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const firstBridge = bridge_for(container);
		await act(async () => post_ready(firstBridge.bridgeNonce));
		const firstNonce = latest_init_message().bridgeNonce;
		expect(firstNonce).toBe(firstBridge.bridgeNonce);
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce: firstNonce,
				requestId: "refresh_lost",
			});
		});

		// The frame recovers by remounting instead of leaving the page dead behind a token-error.
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		const secondBridge = bridge_for(container);
		expect(secondBridge.bridgeNonce).not.toBe(firstNonce);
		expect(mintCount).toBe(2);
		// The session doc is already gone server-side, so the host does not try to revoke it.
		expect(mutationMock).not.toHaveBeenCalledWith(
			"plugins_ui.revoke_ui_session",
			expect.objectContaining({ sessionId: "session_1" }),
		);

		await act(async () => post_ready(secondBridge.bridgeNonce));
		expect(latest_init_message()).toMatchObject({ bridgeNonce: secondBridge.bridgeNonce, token: "plu_2" });
	});

	test("a transient refresh failure answers token-error without remounting", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				return Promise.resolve({
					_yay: {
						token: `plu_${mintCount}`,
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: `session_${mintCount}`,
					},
				});
			}
			// Any refusal other than "Unauthorized" is transient; the SDK's own retry handles it.
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Not found" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const firstBridge = bridge_for(container);
		await act(async () => post_ready(firstBridge.bridgeNonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				bridgeNonce: firstBridge.bridgeNonce,
				requestId: "refresh_transient",
			});
		});

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error", requestId: "refresh_transient", message: "Not found" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(bridge_for(container).bridgeNonce).toBe(firstBridge.bridgeNonce);
		expect(mintCount).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("a second load stops the frame and revokes a session that finishes minting late", async () => {
		let resolveMint: ((value: unknown) => void) | null = null;
		const mintPromise = new Promise((resolve) => {
			resolveMint = resolve;
		});
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session" ? mintPromise : Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { iframe, bridgeNonce } = bridge_for(container);
		post_ready(bridgeNonce);
		fireEvent.load(iframe);
		fireEvent.load(iframe);
		expect(screen.getByRole("alert").textContent).toContain("navigated away");

		await act(async () => {
			resolveMint?.({
				_yay: {
					token: "plu_late",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_late",
				},
			});
			await mintPromise;
		});

		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_late",
		});
	});

	test("Retry remounts with a fresh session and bridge nonce", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				return Promise.resolve({
					_yay: {
						token: `plu_${mintCount}`,
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: `session_${mintCount}`,
					},
				});
			}
			return Promise.resolve({ _yay: {} });
		});
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const firstBridge = bridge_for(container);
		await act(async () => post_ready(firstBridge.bridgeNonce));
		const firstNonce = latest_init_message().bridgeNonce;
		expect(firstNonce).toBe(firstBridge.bridgeNonce);

		fireEvent.load(firstBridge.iframe);
		fireEvent.load(firstBridge.iframe);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		const secondBridge = bridge_for(container);
		expect(secondBridge.bridgeNonce).not.toBe(firstNonce);
		postMessageMock.mockClear();

		await act(async () => post_ready(firstNonce));
		expect(mintCount).toBe(2);
		expect(postMessageMock).not.toHaveBeenCalled();

		await act(async () => post_ready(secondBridge.bridgeNonce));
		const secondNonce = latest_init_message().bridgeNonce;
		expect(secondNonce).toBe(secondBridge.bridgeNonce);
		expect(mintCount).toBe(2);
	});

	test("init context carries the viewing member's userId for both context kinds", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const page = render(<PageComponent />);
		const pageBridge = bridge_for(page.container);
		await act(async () => post_ready(pageBridge.bridgeNonce));
		expect(latest_init_message().context).toMatchObject({ kind: "page", userId: "user_1" });
		page.unmount();
		postMessageMock.mockClear();

		// The shared frame adds userId itself, so the file-view caller's context gains it too.
		const fileViewProps = {
			membershipId: "membership_1",
			pluginName: "gallery",
			pluginVersionId: "version_1",
			entry: "dist/frontend/view.html",
			title: "Viewer",
			kindLabel: "plugin view",
			mintSession: () =>
				Promise.resolve({
					_yay: {
						token: "plu_view",
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: "session_view",
					},
				}),
			getInitContext: () => ({
				kind: "file_view",
				pluginName: "gallery",
				fileViewId: "viewer",
				fileViewTitle: "Viewer",
				organizationId: "org_1",
				workspaceId: "ws_1",
				file: { fileNodeId: "node_1", name: "a.png", path: "/a.png", contentType: "image/png" },
			}),
			onSessionLost: () => {},
			onError: () => {},
		} as unknown as ComponentProps<typeof PluginsUiFrame>;
		const view = render(<PluginsUiFrame {...fileViewProps} />);
		const viewBridge = bridge_for(view.container);
		await act(async () => post_ready(viewBridge.bridgeNonce));
		expect(latest_init_message().context).toMatchObject({ kind: "file_view", fileViewId: "viewer", userId: "user_1" });
	});
});
