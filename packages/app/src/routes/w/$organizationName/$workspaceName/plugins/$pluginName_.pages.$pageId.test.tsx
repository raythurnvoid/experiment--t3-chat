/**
 * @vitest-environment jsdom
 *
 * These tests cover the route's state machine and message fields. WindowProxy identity,
 * sandbox navigation, and concrete-origin delivery require the browser-project coverage.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { paramsMock, tenantContextMock, useQueryMock, mutationMock, watchQueryMock, queryMock } = vi.hoisted(() => ({
	paramsMock: vi.fn(),
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	mutationMock: vi.fn(),
	watchQueryMock: vi.fn(),
	queryMock: vi.fn(),
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
		query: (...args: unknown[]) => queryMock(...args),
		watchQuery: (...args: unknown[]) => watchQueryMock(...args),
	},
	app_convex_api: {
		plugins_ui: {
			list_ui_pages: "plugins_ui.list_ui_pages",
			mint_page_session: "plugins_ui.mint_page_session",
			refresh_ui_session: "plugins_ui.refresh_ui_session",
			revoke_ui_session: "plugins_ui.revoke_ui_session",
		},
		plugins_data: {
			watch_documents: "plugins_data.watch_documents",
			resolve_member_display: "plugins_data.resolve_member_display",
			user_append_document: "plugins_data.user_append_document",
			user_put_document: "plugins_data.user_put_document",
			user_remove_document: "plugins_data.user_remove_document",
			user_put_owned_document: "plugins_data.user_put_owned_document",
			user_remove_owned_document: "plugins_data.user_remove_owned_document",
		},
	},
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

type FakeWatch = {
	args: Record<string, unknown>;
	result: unknown;
	queryError: Error | null;
	callback: (() => void) | null;
	disposed: boolean;
};

const fakeWatches: FakeWatch[] = [];
// Results the next created watches are born with, oldest first. A seeded watch mimics the real
// Convex client holding a cached result for identical args: `localQueryResult` answers
// synchronously from the very first read.
const seededResults: unknown[] = [];

function install_fake_watches() {
	fakeWatches.length = 0;
	seededResults.length = 0;
	watchQueryMock.mockImplementation((_reference: string, args: Record<string, unknown>) => {
		const watch: FakeWatch = {
			args,
			result: seededResults.length > 0 ? seededResults.shift() : undefined,
			queryError: null,
			callback: null,
			disposed: false,
		};
		fakeWatches.push(watch);
		return {
			onUpdate: (callback: () => void) => {
				watch.callback = callback;
				return () => {
					watch.disposed = true;
					watch.callback = null;
				};
			},
			localQueryResult: () => {
				if (watch.queryError) {
					throw watch.queryError;
				}
				return watch.result;
			},
		};
	});
}

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

function latest_message_of_type(type: string) {
	return postMessageMock.mock.calls.findLast(([value]) => (value as { type?: string }).type === type)?.[0] as
		| Record<string, unknown>
		| undefined;
}

/** Mount the page, complete the ready/init handshake, and clear the recorded posts. */
async function mount_page_ready() {
	const PageComponent = Route.options.component as () => JSX.Element;
	const rendered = render(<PageComponent />);
	const bridge = bridge_for(rendered.container);
	await act(async () => post_ready(bridge.bridgeNonce));
	postMessageMock.mockClear();
	return { rendered, bridgeNonce: bridge.bridgeNonce };
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
		queryMock.mockReset();
		install_fake_watches();
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

	test("registers a data watch and forwards updates with the bridge nonce", async () => {
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				keyPrefix: "m:",
				limit: 50,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 50,
		});
		expect(postMessageMock).not.toHaveBeenCalled();

		const docs = [{ collection: "messages", key: "k1", value: { body: "hi" } }];
		await act(async () => {
			fakeWatches[0].result = { docs };
			fakeWatches[0].callback?.();
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "sub_1", docs },
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("the ninth data watch answers a capacity refusal without registering", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { bridgeNonce } = await mount_page_ready();

		await act(async () => {
			for (let index = 1; index <= 9; index += 1) {
				post_from_frame({
					type: "bonobo:data-watch",
					bridgeNonce,
					subscriptionId: `sub_${index}`,
					collection: "messages",
					limit: 10,
				});
			}
		});

		expect(watchQueryMock).toHaveBeenCalledTimes(8);
		expect(postMessageMock).toHaveBeenCalledWith(
			{
				type: "bonobo:data-update",
				bridgeNonce,
				subscriptionId: "sub_9",
				docs: null,
				reason: "capacity",
				message: "Subscription limit reached for this page",
			},
			CONVEX_HTTP_ORIGIN,
		);
		expect(warnSpy).toHaveBeenCalled();
	});

	test("unwatch disposes the subscription and stops forwarding updates", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);

		await act(async () => post_from_frame({ type: "bonobo:data-unwatch", bridgeNonce, subscriptionId: "sub_1" }));
		expect(fakeWatches[0].disposed).toBe(true);

		await act(async () => {
			fakeWatches[0].result = { docs: [] };
			fakeWatches[0].callback?.();
		});
		expect(latest_message_of_type("bonobo:data-update")).toBeUndefined();
	});

	test("a new ready clears the watch registry for the fresh generation", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);

		await act(async () => post_ready(bridgeNonce));
		expect(fakeWatches[0].disposed).toBe(true);
		// The clear killed the old generation's watch audibly.
		expect(latest_message_of_type("bonobo:data-update")).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "sub_1",
			docs: null,
		});
		const postsAfterReady = postMessageMock.mock.calls.length;

		// The old id belongs to the dead generation, so the same id may register a fresh watch.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(2);

		// An update from the dead generation's watch no longer reaches the page.
		await act(async () => {
			fakeWatches[0].result = { docs: [] };
			fakeWatches[0].callback?.();
		});
		expect(postMessageMock.mock.calls.length).toBe(postsAfterReady);
	});

	test("a null query result posts a null update and drops the subscription", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);

		await act(async () => {
			fakeWatches[0].result = null;
			fakeWatches[0].callback?.();
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "sub_1", docs: null },
			CONVEX_HTTP_ORIGIN,
		);
		expect(fakeWatches[0].disposed).toBe(true);

		// The registry no longer holds the id: the same id starts a new Convex subscription.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(2);
	});

	test("an errored subscription posts a null update and drops the subscription", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { bridgeNonce } = await mount_page_ready();
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
			}),
		);

		await act(async () => {
			fakeWatches[0].queryError = new Error("query failed");
			fakeWatches[0].callback?.();
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "sub_1", docs: null },
			CONVEX_HTTP_ORIGIN,
		);
		expect(fakeWatches[0].disposed).toBe(true);
		expect(errorSpy).toHaveBeenCalled();
	});

	function data_update_posts() {
		return postMessageMock.mock.calls.filter(([value]) => (value as { type?: string }).type === "bonobo:data-update");
	}

	async function post_watch_window(bridgeNonce: string, subscriptionId = "win_1") {
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch-window",
				bridgeNonce,
				subscriptionId,
				collection: "messages",
				keyPrefix: "m:",
				pageSize: 3,
			}),
		);
	}

	async function deliver(watch: FakeWatch, docs: { key: string }[], truncated: boolean) {
		await act(async () => {
			watch.result = { docs, truncated };
			watch.callback?.();
		});
	}

	test("a window watch pins its whole args, and a page payload cannot smuggle bounds", async () => {
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch-window",
				bridgeNonce,
				subscriptionId: "win_1",
				collection: "messages",
				keyPrefix: "m:",
				pageSize: 3,
				// Bounds are host-computed fenceposts; a page payload naming them changes nothing.
				keyStartExclusive: "m:evil",
				keyEndInclusive: "m:evil2",
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(1);
		expect(watchQueryMock).toHaveBeenCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
		});

		await deliver(fakeWatches[0], [{ key: "m:1" }], false);
		expect(data_update_posts()).toEqual([
			[
				{
					type: "bonobo:data-update",
					bridgeNonce,
					subscriptionId: "win_1",
					docs: [{ key: "m:1" }],
					hasMore: false,
					atCapacity: false,
					incomplete: false,
				},
				CONVEX_HTTP_ORIGIN,
			],
		]);

		// An identical delivery coalesces away: the whole payload is unchanged.
		await deliver(fakeWatches[0], [{ key: "m:1" }], false);
		expect(data_update_posts()).toHaveLength(1);

		await act(async () => post_from_frame({ type: "bonobo:data-unwatch", bridgeNonce, subscriptionId: "win_1" }));
		expect(fakeWatches[0].disposed).toBe(true);
		expect(data_update_posts()).toHaveLength(1);
	});

	test("a truncated first delivery re-seats behind one post that already says hasMore", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);

		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		// The re-seat happened before the flush: exactly one post, content unchanged, hasMore on.
		expect(data_update_posts()).toEqual([
			[
				{
					type: "bonobo:data-update",
					bridgeNonce,
					subscriptionId: "win_1",
					docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }],
					hasMore: true,
					atCapacity: false,
					incomplete: false,
				},
				CONVEX_HTTP_ORIGIN,
			],
		]);
		expect(fakeWatches[0].disposed).toBe(true);
		expect(watchQueryMock).toHaveBeenCalledTimes(2);
		// The new subscription pins the window to its own largest delivered key.
		expect(watchQueryMock).toHaveBeenLastCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
			keyEndInclusive: "m:3",
		});
	});

	test("load-older appends an unbounded tail from the stored bound", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);
		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);

		await act(async () =>
			post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(3);
		expect(watchQueryMock).toHaveBeenLastCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
			keyStartExclusive: "m:3",
		});

		// The tail's first non-truncated delivery closes the history: hasMore drops.
		await deliver(fakeWatches[2], [{ key: "m:4" }, { key: "m:5" }], false);
		expect(data_update_posts().at(-1)?.[0]).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "win_1",
			docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }, { key: "m:4" }, { key: "m:5" }],
			hasMore: false,
			atCapacity: false,
			incomplete: false,
		});

		// With the whole range covered, another load-older is a silent no-op and starts nothing.
		await act(async () =>
			post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(3);
	});

	test("an arrival overflow splits the interval and the swap commits in one post", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);
		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		// The re-seated watcher confirms the same content: whole payload unchanged, no post.
		await deliver(fakeWatches[1], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], false);
		expect(data_update_posts()).toHaveLength(1);

		// Two arrivals push the old docs past the page size: the interval re-reads as newest-3.
		await deliver(fakeWatches[1], [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], true);
		// The split starts left (.. lte previously-first key] and right (gt it .. old end].
		expect(watchQueryMock).toHaveBeenCalledTimes(4);
		expect(watchQueryMock.mock.calls[2]?.[1]).toEqual({
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
			keyEndInclusive: "m:1",
		});
		expect(watchQueryMock.mock.calls[3]?.[1]).toEqual({
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
			keyStartExclusive: "m:1",
			keyEndInclusive: "m:3",
		});
		expect(data_update_posts()).toHaveLength(2);

		// One replacement delivering does not commit or post: the swap is all-or-nothing. The right
		// side goes first on purpose — a premature commit here would splice in an undelivered left
		// interval and the arrivals would vanish from the flattened list.
		await deliver(fakeWatches[3], [{ key: "m:2" }, { key: "m:3" }], false);
		expect(data_update_posts()).toHaveLength(2);
		expect(fakeWatches[1].disposed).toBe(false);

		await deliver(fakeWatches[2], [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], false);
		expect(fakeWatches[1].disposed).toBe(true);
		expect(data_update_posts().at(-1)?.[0]).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "win_1",
			docs: [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }, { key: "m:2" }, { key: "m:3" }],
			hasMore: true,
			atCapacity: false,
			incomplete: false,
		});
		expect(data_update_posts()).toHaveLength(3);
	});

	test("a denial mid-split kills the whole window with exactly one null", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);
		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		await deliver(fakeWatches[1], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], false);
		await deliver(fakeWatches[1], [{ key: "m:0a" }, { key: "m:0b" }, { key: "m:1" }], true);
		expect(watchQueryMock).toHaveBeenCalledTimes(4);

		// One pending replacement answers a denial: every watcher dies, committed and pending.
		await act(async () => {
			fakeWatches[2].result = null;
			fakeWatches[2].callback?.();
		});
		expect(fakeWatches.every((watch) => watch.disposed)).toBe(true);
		expect(data_update_posts().at(-1)).toEqual([
			{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "win_1", docs: null },
			CONVEX_HTTP_ORIGIN,
		]);
		const postsAfterKill = data_update_posts().length;

		// The other pending replacement's late delivery reaches a dead window: no post, and a
		// load-older for the dead id starts nothing.
		await deliver(fakeWatches[3], [{ key: "m:2" }], false);
		await act(async () =>
			post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
		);
		expect(data_update_posts()).toHaveLength(postsAfterKill);
		expect(watchQueryMock).toHaveBeenCalledTimes(4);
	});

	test("a cached truncated first delivery still re-seats and reports hasMore", async () => {
		const { bridgeNonce } = await mount_page_ready();

		// A sibling subscription with identical args leaves a cached result in the client, so the
		// head's first delivery is synchronous-cached instead of a later server answer. The window
		// must still see it AFTER its bookkeeping registered the interval: the re-seat and the
		// hasMore it implies must match the async path exactly.
		seededResults.push({ docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], truncated: true });
		await post_watch_window(bridgeNonce);

		expect(watchQueryMock).toHaveBeenCalledTimes(2);
		expect(watchQueryMock).toHaveBeenLastCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
			keyEndInclusive: "m:3",
		});
		expect(data_update_posts().at(-1)?.[0]).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "win_1",
			docs: [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }],
			hasMore: true,
			atCapacity: false,
			incomplete: false,
		});
	});

	test("a cached denial at window start kills it without leaking the subscription", async () => {
		const { bridgeNonce } = await mount_page_ready();

		// The page retries a just-denied read as a window before the server confirms the removal:
		// the head's first read answers the cached null. The kill must find the started interval —
		// a missed dispose here would leak a subscription on the app-wide Convex client until the
		// page reloads, and the frame generation would lose the server slot for good.
		seededResults.push(null);
		await post_watch_window(bridgeNonce);

		expect(fakeWatches[0].disposed).toBe(true);
		expect(data_update_posts()).toEqual([
			[{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "win_1", docs: null }, CONVEX_HTTP_ORIGIN],
		]);

		// The slot came back: a fresh watch starts instead of hitting a phantom ceiling.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_after",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(2);
	});

	test("the interval ceiling reports atCapacity and refuses the next load-older", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);

		// Grow to the 6-interval ceiling: the head re-seats, then each load-older tail delivers
		// truncated and re-seats into a bounded interval of its own.
		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		for (let round = 0; round < 5; round += 1) {
			await act(async () =>
				post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
			);
			const tail = fakeWatches[fakeWatches.length - 1]!;
			const base = (round + 1) * 3;
			await deliver(tail, [{ key: `m:${base + 1}` }, { key: `m:${base + 2}` }, { key: `m:${base + 3}` }], true);
		}
		expect(watchQueryMock).toHaveBeenCalledTimes(12);

		// Six intervals: the payload itself reports atCapacity while history stays open.
		expect(data_update_posts().at(-1)?.[0]).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "win_1",
			docs: Array.from({ length: 18 }, (_, index) => ({ key: `m:${index + 1}` })),
			hasMore: true,
			atCapacity: true,
			incomplete: false,
		});

		// The seventh load-older starts nothing and posts nothing new: the refusal's payload
		// coalesces away because atCapacity was already on.
		const postsAtCeiling = data_update_posts().length;
		await act(async () =>
			post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(12);
		expect(data_update_posts()).toHaveLength(postsAtCeiling);
	});

	test("adjacent intervals that shrink below one page merge back into one subscription", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await post_watch_window(bridgeNonce);
		await deliver(fakeWatches[0], [{ key: "m:1" }, { key: "m:2" }, { key: "m:3" }], true);
		await act(async () =>
			post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" }),
		);
		await deliver(fakeWatches[2], [{ key: "m:4" }, { key: "m:5" }], false);
		expect(watchQueryMock).toHaveBeenCalledTimes(3);

		// Physical deletes shrink the head interval: 1 + 2 = 3 docs still fill one page, so the
		// pair keeps its own subscriptions (one full page would re-split on the next arrival).
		await deliver(fakeWatches[1], [{ key: "m:1" }], false);
		expect(watchQueryMock).toHaveBeenCalledTimes(3);

		// The tail shrinks too: 1 + 1 = 2 docs fit one page, and the merge starts one
		// subscription over the combined range.
		await deliver(fakeWatches[2], [{ key: "m:4" }], false);
		expect(watchQueryMock).toHaveBeenCalledTimes(4);
		expect(watchQueryMock).toHaveBeenLastCalledWith("plugins_data.watch_documents", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			limit: 3,
		});
		// All-or-nothing: the replaced pair keeps delivering until the merged read has a result.
		expect(fakeWatches[1].disposed).toBe(false);
		expect(fakeWatches[2].disposed).toBe(false);
		expect(data_update_posts().at(-1)?.[0]).toEqual({
			type: "bonobo:data-update",
			bridgeNonce,
			subscriptionId: "win_1",
			docs: [{ key: "m:1" }, { key: "m:4" }],
			hasMore: false,
			atCapacity: false,
			incomplete: false,
		});

		// The commit swaps the pair out and reclaims their server slots. The flattened list is
		// unchanged, so the commit itself posts nothing.
		const postsBeforeCommit = data_update_posts().length;
		await deliver(fakeWatches[3], [{ key: "m:1" }, { key: "m:4" }], false);
		expect(fakeWatches[1].disposed).toBe(true);
		expect(fakeWatches[2].disposed).toBe(true);
		expect(data_update_posts()).toHaveLength(postsBeforeCommit);
	});

	test("the start budget spends per real start, survives ready, and refills with time", async () => {
		vi.useFakeTimers();
		const { bridgeNonce } = await mount_page_ready();

		// A plain sibling and a window: two page-initiated starts, two tokens.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_plain",
				collection: "notes",
				limit: 10,
			}),
		);
		await post_watch_window(bridgeNonce, "win_1");
		expect(watchQueryMock).toHaveBeenCalledTimes(2);

		// Tokens are never refunded on unwatch, so start-and-drop churn pays full price: 61
		// cycles leave exactly one token in the burst of 64.
		await act(async () => {
			for (let index = 0; index < 61; index += 1) {
				post_from_frame({
					type: "bonobo:data-watch",
					bridgeNonce,
					subscriptionId: `churn_${index}`,
					collection: "notes",
					limit: 10,
				});
				post_from_frame({ type: "bonobo:data-unwatch", bridgeNonce, subscriptionId: `churn_${index}` });
			}
		});
		expect(watchQueryMock).toHaveBeenCalledTimes(63);

		// A load-older that starts nothing is free: this window has no delivered history to
		// extend, so spamming it spends no tokens.
		await act(async () => {
			for (let index = 0; index < 10; index += 1) {
				post_from_frame({ type: "bonobo:data-window-load-older", bridgeNonce, subscriptionId: "win_1" });
			}
		});

		// The last token still admits a start, proving the no-ops above were free.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_last",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(64);

		// The next start is refused with a reason, so the page can tell budget from denial.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_refused",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(64);
		expect(data_update_posts().at(-1)).toEqual([
			{
				type: "bonobo:data-update",
				bridgeNonce,
				subscriptionId: "sub_refused",
				docs: null,
				reason: "budget",
				message: "Too many subscription starts; retry in a moment",
			},
			CONVEX_HTTP_ORIGIN,
		]);

		// The refusal left the healthy sibling alone.
		await act(async () => {
			fakeWatches[0].result = { docs: [{ key: "n:1" }] };
			fakeWatches[0].callback?.();
		});
		expect(data_update_posts().at(-1)).toEqual([
			{ type: "bonobo:data-update", bridgeNonce, subscriptionId: "sub_plain", docs: [{ key: "n:1" }] },
			CONVEX_HTTP_ORIGIN,
		]);

		// A fresh ready clears the registry but never the budget.
		await act(async () => post_ready(bridgeNonce));
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_after_ready",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(64);
		expect(data_update_posts().at(-1)?.[0]).toMatchObject({ subscriptionId: "sub_after_ready", reason: "budget" });

		// One second refills one token.
		act(() => vi.advanceTimersByTime(1_000));
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_recovered",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(65);
	});

	test("a repeated ready kills the cleared watches audibly", async () => {
		const { bridgeNonce } = await mount_page_ready();
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_gen1",
				collection: "notes",
				limit: 10,
			}),
		);
		await post_watch_window(bridgeNonce, "win_gen1");

		// A second SDK generation in the same document (bridge reconnect, or a second client)
		// obsoletes generation 1's ids. Each cleared watch still hears its one death, so the old
		// generation does not freeze silently on stale data; the new generation ignores the ids.
		await act(async () => post_ready(bridgeNonce));
		expect(fakeWatches.every((watch) => watch.disposed)).toBe(true);
		const deaths = data_update_posts()
			.map(([value]) => value as { subscriptionId?: string; docs?: unknown })
			.filter((value) => value.docs === null)
			.map((value) => value.subscriptionId);
		expect(deaths).toEqual(["sub_gen1", "win_gen1"]);
	});

	test("host-invalid watch inputs are refused with a reason and never reach the server", async () => {
		const { bridgeNonce } = await mount_page_ready();

		// Each refusal is host-local: no subscription starts, and the reason marks bad args.
		const invalidInputs = [
			{ type: "bonobo:data-watch", collection: "", limit: 10 },
			{ type: "bonobo:data-watch", collection: "messages", limit: 0 },
			{ type: "bonobo:data-watch", collection: "messages", keyPrefix: "no space", limit: 10 },
			{ type: "bonobo:data-watch-window", collection: "a".repeat(129), pageSize: 10 },
			{ type: "bonobo:data-watch-window", collection: "messages", pageSize: 101 },
		];
		for (const [index, input] of invalidInputs.entries()) {
			const subscriptionId = `bad_${index}`;
			await act(async () => post_from_frame({ ...input, bridgeNonce, subscriptionId }));
			expect(data_update_posts().at(-1)?.[0]).toMatchObject({ subscriptionId, docs: null, reason: "invalid" });
		}
		expect(watchQueryMock).not.toHaveBeenCalled();

		// Inputs outside the host's strict subset — refusals whose outcome depends on the Unicode
		// version — still go to the server and die as today's bare null.
		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "server_side",
				collection: "bad\u{0}name",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(1);
	});

	test("a window occupies one page-visible slot, and the ninth watch is refused as capacity", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { bridgeNonce } = await mount_page_ready();

		await post_watch_window(bridgeNonce, "win_1");
		await act(async () => {
			for (let index = 1; index <= 7; index += 1) {
				post_from_frame({
					type: "bonobo:data-watch",
					bridgeNonce,
					subscriptionId: `sub_${index}`,
					collection: "notes",
					limit: 10,
				});
			}
		});
		expect(watchQueryMock).toHaveBeenCalledTimes(8);

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_9",
				collection: "notes",
				limit: 10,
			}),
		);
		expect(watchQueryMock).toHaveBeenCalledTimes(8);
		// The cap refusal names itself: a page holding real slots should close one, not treat
		// the refusal as access gone or back off as if it were rate-limited.
		expect(data_update_posts().at(-1)).toEqual([
			{
				type: "bonobo:data-update",
				bridgeNonce,
				subscriptionId: "sub_9",
				docs: null,
				reason: "capacity",
				message: "Subscription limit reached for this page",
			},
			CONVEX_HTTP_ORIGIN,
		]);
		expect(warnSpy).toHaveBeenCalled();
	});

	test("a user write maps its op to the mutation and posts the Result verbatim", async () => {
		const writeResult = { _yay: { key: "m:0001:ab", revision: 1, byteSize: 12 } };
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				return Promise.resolve({
					_yay: { token: "plu_1", expiresAt: Date.now() + 60_000, pluginVersionId: "version_1", sessionId: "session_1" },
				});
			}
			if (reference === "plugins_data.user_append_document") {
				return Promise.resolve(writeResult);
			}
			return Promise.resolve({ _yay: {} });
		});
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-user-write",
				bridgeNonce,
				requestId: "wr_1",
				op: "append",
				collection: "messages",
				keyPrefix: "m:",
				value: { body: "hi" },
				clientRequestId: "cr_1",
			}),
		);

		expect(mutationMock).toHaveBeenCalledWith("plugins_data.user_append_document", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			keyPrefix: "m:",
			value: { body: "hi" },
			clientRequestId: "cr_1",
		});
		const resultMessage = latest_message_of_type("bonobo:data-user-write-result");
		expect(resultMessage).toMatchObject({ bridgeNonce, requestId: "wr_1" });
		expect(resultMessage?.result).toBe(writeResult);
	});

	test("the owned ops map to the owned mutations, never the shared ones", async () => {
		// A swapped case here would route putOwned through user_put_document and silently
		// drop the server-appended owner suffix, so the mapping is pinned per op.
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-user-write",
				bridgeNonce,
				requestId: "wr_owned_1",
				op: "putOwned",
				collection: "reactions",
				key: "m:0001:ab:heart",
				value: { on: true },
			}),
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_data.user_put_owned_document", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "reactions",
			key: "m:0001:ab:heart",
			value: { on: true },
		});

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-user-write",
				bridgeNonce,
				requestId: "wr_owned_2",
				op: "removeOwned",
				collection: "reactions",
				key: "m:0001:ab:heart",
			}),
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_data.user_remove_owned_document", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "reactions",
			key: "m:0001:ab:heart",
		});
		expect(
			mutationMock.mock.calls.filter(([reference]) =>
				["plugins_data.user_put_document", "plugins_data.user_remove_document"].includes(reference as string),
			),
		).toHaveLength(0);
	});

	test("a thrown user write answers the stable generic _nay", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				return Promise.resolve({
					_yay: { token: "plu_1", expiresAt: Date.now() + 60_000, pluginVersionId: "version_1", sessionId: "session_1" },
				});
			}
			if (reference === "plugins_data.user_put_document") {
				return Promise.reject(new Error("ArgumentValidationError"));
			}
			return Promise.resolve({ _yay: {} });
		});
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-user-write",
				bridgeNonce,
				requestId: "wr_2",
				op: "put",
				collection: "notes",
				key: "k1",
				value: { body: "hi" },
			}),
		);

		expect(postMessageMock).toHaveBeenCalledWith(
			{
				type: "bonobo:data-user-write-result",
				bridgeNonce,
				requestId: "wr_2",
				result: { _nay: { message: "Failed to write plugin data" } },
			},
			CONVEX_HTTP_ORIGIN,
		);
		expect(errorSpy).toHaveBeenCalled();
	});

	test("member resolve forwards names and maps a null denial to an empty map", async () => {
		queryMock.mockResolvedValueOnce({ members: { user_2: "Ada" } }).mockResolvedValueOnce(null);
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({ type: "bonobo:data-resolve-members", bridgeNonce, requestId: "rm_1", userIds: ["user_2"] }),
		);
		expect(queryMock).toHaveBeenCalledWith("plugins_data.resolve_member_display", {
			membershipId: "membership_1",
			pluginName: "gallery",
			userIds: ["user_2"],
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			{ type: "bonobo:data-resolve-members-result", bridgeNonce, requestId: "rm_1", members: { user_2: "Ada" } },
			CONVEX_HTTP_ORIGIN,
		);

		await act(async () =>
			post_from_frame({ type: "bonobo:data-resolve-members", bridgeNonce, requestId: "rm_2", userIds: ["user_3"] }),
		);
		expect(postMessageMock).toHaveBeenCalledWith(
			{ type: "bonobo:data-resolve-members-result", bridgeNonce, requestId: "rm_2", members: {} },
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("binds tenant and plugin identity from host state, never from the message payload", async () => {
		const { bridgeNonce } = await mount_page_ready();

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-watch",
				bridgeNonce,
				subscriptionId: "sub_1",
				collection: "messages",
				limit: 10,
				pluginName: "other-plugin",
				membershipId: "membership_evil",
			}),
		);
		expect(watchQueryMock.mock.calls[0][1]).toEqual({
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "messages",
			limit: 10,
		});

		await act(async () =>
			post_from_frame({
				type: "bonobo:data-user-write",
				bridgeNonce,
				requestId: "wr_1",
				op: "remove",
				collection: "notes",
				key: "k1",
				pluginName: "other-plugin",
				membershipId: "membership_evil",
			}),
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_data.user_remove_document", {
			membershipId: "membership_1",
			pluginName: "gallery",
			collection: "notes",
			key: "k1",
		});
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
			onError: () => {},
		} as unknown as ComponentProps<typeof PluginsUiFrame>;
		const view = render(<PluginsUiFrame {...fileViewProps} />);
		const viewBridge = bridge_for(view.container);
		await act(async () => post_ready(viewBridge.bridgeNonce));
		expect(latest_init_message().context).toMatchObject({ kind: "file_view", fileViewId: "viewer", userId: "user_1" });
	});
});
