/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"happyDOM": {"settings": {"disableIframePageLoading": true}}}
 *
 * These tests cover the route's state machine and message fields. WindowProxy identity,
 * sandbox navigation, and opaque-origin delivery require the browser-project coverage.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
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
			refresh_page_session: "plugins_ui.refresh_page_session",
			revoke_page_session: "plugins_ui.revoke_page_session",
		},
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

import { Route } from "./$pluginName_.pages.$pageId.tsx";

const postMessageMock = vi.fn();
const frameWindow = { postMessage: postMessageMock } as unknown as Window;

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

function post_from_frame(data: unknown, origin = "null") {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source: frameWindow }));
}

function post_ready(bridgeNonce: string) {
	post_from_frame({ type: "bonobo:ready", bridgeNonce });
}

function latest_init_message() {
	const message = postMessageMock.mock.calls.findLast(
		([value]) => (value as { type?: string }).type === "bonobo:init",
	)?.[0] as { bridgeNonce: string; token: string } | undefined;
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
		mutationMock.mockResolvedValue({ _yay: {} });
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
	});

	test("mint failure replaces the page with an alert and moves focus to Retry", async () => {
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session" ? { _nay: { message: "Unauthorized" } } : { _yay: {} },
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);

		await act(async () => post_ready(bridgeNonce));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Unauthorized");
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(document.activeElement).toBe(retry);
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
		expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), "*");
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

		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), "*");
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_page_session", {
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

		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), "*");
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_page_session", {
			membershipId: "membership_1",
			sessionId: "session_after_unmount",
		});
	});

	test("drops messages with a foreign source, origin, nonce, or malformed request id", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { bridgeNonce } = bridge_for(container);

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", bridgeNonce },
					origin: "null",
					source: window,
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

		expect(mutationMock).not.toHaveBeenCalledWith("plugins_ui.mint_page_session", expect.anything());
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
		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), "*");
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
			if (reference === "plugins_ui.refresh_page_session") {
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
			"*",
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
			mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.refresh_page_session"),
		).toHaveLength(1);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_1", token: "plu_2" }),
			"*",
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
			if (reference === "plugins_ui.refresh_page_session") {
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

		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), "*");
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_page_session", {
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
		expect(mintCount).toBe(1);
		expect(postMessageMock).not.toHaveBeenCalled();

		await act(async () => post_ready(secondBridge.bridgeNonce));
		const secondNonce = latest_init_message().bridgeNonce;
		expect(secondNonce).toBe(secondBridge.bridgeNonce);
		expect(mintCount).toBe(2);
	});
});
