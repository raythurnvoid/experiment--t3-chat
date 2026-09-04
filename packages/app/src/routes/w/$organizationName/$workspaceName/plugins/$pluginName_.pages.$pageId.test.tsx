/**
 * @vitest-environment jsdom
 *
 * These tests cover the route's state machine and message fields. WindowProxy identity,
 * sandbox navigation, and concrete-origin delivery require the browser-project coverage.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
		// Mint and refresh are actions, revoke is a mutation. One mock records all three, keyed by
		// the function reference each test filters on.
		action: (...args: unknown[]) => mutationMock(...args),
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
	const nonce = fragment.get("nonce");
	if (!nonce) {
		throw new Error("iframe nonce not assigned");
	}
	return { iframe, iframeUrl, fragment, nonce };
}

function post_from_frame(data: unknown, origin = CONVEX_HTTP_ORIGIN) {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source: frameWindow }));
}

function post_ready(nonce: string) {
	post_from_frame({ type: "bonobo:ready", nonce });
}

// Every `--color-<scale>-NN` step declared in `app.css`, name to value: 104 entries across the nine
// numbered scales today. Read from the stylesheet on purpose, and match any scale name rather than
// the nine the frame knows: the frame keeps its own static list of these names (computed styles
// cannot be enumerated), and comparing the posted theme against the stylesheet is what catches a
// scale added, renamed, or resized there without the list following. A scale new to both would slip
// past a list of names here.
//
// The shadcn aliases in the same file (`--color-accent: var(--accent)`, `--color-border`, …) have
// no two-digit step and stay out, as they must.
const APP_COLOR_SCALES: Record<string, string> = Object.fromEntries(
	[...readFileSync(join(process.cwd(), "src", "app.css"), "utf8").matchAll(/^\s*(--color-[a-z0-9-]+-\d{2}):\s*([^;]+);/gmu)].map(
		(match) => [match[1], match[2]],
	),
);

// jsdom loads no stylesheet, so the root element carries the values inline and `getComputedStyle`
// reads them back.
function paint_host_theme(mode: "light" | "dark") {
	for (const [property, value] of Object.entries(APP_COLOR_SCALES)) {
		document.documentElement.style.setProperty(property, value);
	}
	document.documentElement.classList.remove("light", "dark");
	document.documentElement.classList.add(mode);
}

function latest_theme_message() {
	return postMessageMock.mock.calls.findLast(([value]) => (value as { type?: string }).type === "bonobo:theme")?.[0] as
		| { nonce: string; theme: { mode: string; tokens: Record<string, string> } }
		| undefined;
}

function latest_init_message() {
	const message = postMessageMock.mock.calls.findLast(
		([value]) => (value as { type?: string }).type === "bonobo:init",
	)?.[0] as
		| {
				nonce: string;
				token: string;
				context: Record<string, unknown>;
				theme: { mode: string; tokens: Record<string, string> };
		  }
		| undefined;
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
							jwt: "jwt_default",
							jwtExpiresAt: Date.now() + 60_000,
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
		// The theme is read off the root element, so a test that painted one must not leave it there.
		document.documentElement.removeAttribute("style");
		document.documentElement.classList.remove("light", "dark");
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
			["nonce", secondBridge.nonce],
		]);
		expect(secondBridge.nonce).not.toBe(firstBridge.nonce);
		expect(secondBridge.iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
		// `allow-forms` lets plugin JS handle submit events; the asset CSP's `form-action 'none'`
		// keeps real HTTP form submissions blocked.
		expect(secondBridge.iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
		// No `Permissions-Policy` header is sent for plugin assets, so this attribute is the whole
		// delegation. Pin it exactly: without it `navigator.clipboard.writeText` rejects in every
		// plugin page, and a second feature listed here would reach every plugin unnoticed.
		expect(secondBridge.iframe.getAttribute("allow")).toBe("clipboard-write");
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
		const { nonce } = bridge_for(container);
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

		await act(async () => post_ready(nonce));
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("init hands the page its own Convex connection: the deployment url, the session token, and its JWT", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));

		// The page's SDK opens its own ConvexClient against convexUrl and authenticates it with the
		// JWT minted beside the token. The host posts these once and is out of the data path.
		expect(latest_init_message()).toMatchObject({
			type: "bonobo:init",
			nonce,
			apiOrigin: import.meta.env.VITE_CONVEX_HTTP_URL,
			convexUrl: "https://deployment.convex.test",
			token: "plu_default",
			jwt: "jwt_default",
			jwtExpiresAt: expect.any(Number),
		});
	});

	test("init carries the whole resolved theme, and a host theme switch sends an update", async () => {
		paint_host_theme("dark");

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));

		// A plugin page is a cross-origin document: it inherits none of the app's custom properties and
		// cannot read them. So init has to carry every value it needs, resolved — a name would leave the
		// page with nothing to resolve it against. The whole map, under the app's own names and
		// nothing else: a scale the frame's list misses shows up here as a missing key, and a name
		// the list invents shows up as an extra key with an empty value.
		expect(Object.keys(APP_COLOR_SCALES)).toHaveLength(104);
		expect(latest_init_message()?.theme).toEqual({
			mode: "dark",
			tokens: APP_COLOR_SCALES,
		});
		expect(latest_theme_message()).toBeUndefined();

		// The user switches the app to light. Nothing remounts the frame, so the running page only
		// learns about it from this message.
		await act(async () => {
			document.documentElement.style.setProperty("--color-base-1-01", "oklch(0.98 0.002 85)");
			document.documentElement.classList.remove("dark");
			document.documentElement.classList.add("light");
			await Promise.resolve();
		});

		expect(latest_theme_message()).toMatchObject({
			nonce,
			theme: {
				mode: "light",
				tokens: { ...APP_COLOR_SCALES, "--color-base-1-01": "oklch(0.98 0.002 85)" },
			},
		});
	});

	test("a theme switch while the frame is still loading is sent right after init", async () => {
		paint_host_theme("dark");

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		// Let the session mint settle, so init already holds the dark theme.
		await act(async () => {
			await Promise.resolve();
		});

		// The member switches to light before the frame has said ready. Nothing can be sent yet.
		await act(async () => {
			document.documentElement.style.setProperty("--color-base-1-01", "oklch(0.98 0.002 85)");
			document.documentElement.classList.remove("dark");
			document.documentElement.classList.add("light");
			await Promise.resolve();
		});
		expect(latest_theme_message()).toBeUndefined();

		// Ready arrives: init still carries the theme from mint time, so the switch must follow it,
		// or the frame paints dark until the member toggles again.
		await act(async () => post_ready(nonce));
		expect(latest_init_message()?.theme.mode).toBe("dark");
		expect(latest_theme_message()).toMatchObject({
			nonce,
			theme: { mode: "light", tokens: { "--color-base-1-01": "oklch(0.98 0.002 85)" } },
		});
	});

	test("the mode follows the surface colour, not the theme class", async () => {
		paint_host_theme("dark");

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));

		expect(latest_init_message()?.theme.mode).toBe("dark");

		// The app's numbered palette is dark-oriented and the theme provider does not swap it, so a
		// member who picks "light" still sees the same dark surfaces — measured in the running app on
		// 2026-08-24, where the app's own body stayed `oklch(0.14 …)` under `.light`. Nothing the
		// frame paints with changed, so it hears nothing.
		//
		// When the mode came from the class instead, this sent `mode: "light"` beside those dark
		// values: the frame painted its own light panels and dark text, then read the host's dark
		// surface and light text back over them, and the page went unreadable.
		await act(async () => {
			document.documentElement.classList.remove("dark");
			document.documentElement.classList.add("light");
			await Promise.resolve();
		});

		expect(latest_theme_message()).toBeUndefined();

		// A real switch is one that changes the colours. Then the mode follows them — here under the
		// `dark` class, so this is a rule about the surface and not a pin on the class name. The
		// observer watches the class attribute, which is why the class moves at all.
		await act(async () => {
			document.documentElement.style.setProperty("--color-base-1-01", "oklch(0.98 0.002 85)");
			document.documentElement.classList.remove("light");
			document.documentElement.classList.add("dark");
			await Promise.resolve();
		});

		expect(latest_theme_message()).toMatchObject({
			nonce,
			theme: { mode: "light", tokens: { ...APP_COLOR_SCALES, "--color-base-1-01": "oklch(0.98 0.002 85)" } },
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
		const { nonce } = bridge_for(container);
		post_ready(nonce);
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
		const { nonce } = bridge_for(container);
		post_ready(nonce);
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
		const { nonce } = bridge_for(mounted.container);
		post_ready(nonce);
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
		const { nonce } = bridge_for(container);

		await act(async () => {
			// Correct origin but a foreign source window, so only the source guard can drop it.
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", nonce },
					origin: CONVEX_HTTP_ORIGIN,
					source: {} as Window,
				}),
			);
			post_from_frame({ type: "bonobo:ready", nonce }, "https://host.test");
			post_from_frame({ type: "bonobo:ready" });
			post_from_frame({ type: "bonobo:ready", nonce: crypto.randomUUID() });
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "",
			});
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
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
		const { nonce } = bridge_for(container);

		await act(async () => {
			post_ready(nonce);
			post_ready(nonce);
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
		await act(async () => post_ready(bridge.nonce));
		const { nonce } = latest_init_message();
		expect(nonce).toBe(bridge.nonce);
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_1",
			});
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_2",
			});
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error", requestId: "refresh_2" }),
			CONVEX_HTTP_ORIGIN,
		);

		await act(async () => {
			resolveRefresh?.({
				_yay: {
					token: "plu_2",
					expiresAt: Date.now() + 60_000,
					jwt: "jwt_2",
					jwtExpiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
				},
			});
			await refreshPromise;
		});
		post_from_frame({
			type: "bonobo:token-refresh-request",
			nonce,
			requestId: "refresh_1",
		});

		expect(
			mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.refresh_ui_session"),
		).toHaveLength(1);
		// The rotation answer carries the new JWT too, so the frame never exchanges.
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_1", token: "plu_2", jwt: "jwt_2" }),
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
		await act(async () => post_ready(bridge.nonce));
		const { nonce } = latest_init_message();
		expect(nonce).toBe(bridge.nonce);
		postMessageMock.mockClear();
		post_from_frame({
			type: "bonobo:token-refresh-request",
			nonce,
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

	test("a refresh that finds the session gone mints a new session for the same frame and answers bonobo:token", async () => {
		let mintCount = 0;
		const refreshedSessionIds: string[] = [];
		mutationMock.mockImplementation((reference: string, args: { sessionId?: string }) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				return Promise.resolve({
					_yay: {
						token: `plu_${mintCount}`,
						expiresAt: Date.now() + 60_000,
						jwt: `jwt_${mintCount}`,
						jwtExpiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: `session_${mintCount}`,
					},
				});
			}
			// The server deleted the first session doc (the device slept past the session expiry), so
			// its refresh answers "Unauthorized". The re-minted session rotates normally.
			if (reference === "plugins_ui.refresh_ui_session") {
				refreshedSessionIds.push(args.sessionId ?? "");
				return Promise.resolve(
					args.sessionId === "session_1"
						? { _nay: { message: "Unauthorized" } }
						: {
								_yay: {
									token: "plu_rotated",
									expiresAt: Date.now() + 60_000,
									jwt: "jwt_rotated",
									jwtExpiresAt: Date.now() + 60_000,
									pluginVersionId: "version_1",
								},
							},
				);
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const mounted = render(<PageComponent />);
		const bridge = bridge_for(mounted.container);
		await act(async () => post_ready(bridge.nonce));
		const { nonce } = latest_init_message();
		expect(nonce).toBe(bridge.nonce);
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost",
			});
		});

		// The page keeps its document, its state, and its watches: same iframe, same nonce, and the
		// refresh that found the session gone is answered with the new session's token and JWT.
		expect(bridge_for(mounted.container).nonce).toBe(nonce);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", nonce, requestId: "refresh_lost", token: "plu_2", jwt: "jwt_2" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(mintCount).toBe(2);
		// The first session doc is already gone server-side, so the host does not try to revoke it.
		expect(mutationMock).not.toHaveBeenCalledWith(
			"plugins_ui.revoke_ui_session",
			expect.objectContaining({ sessionId: "session_1" }),
		);

		// From here on the frame refreshes the new session, and unmount revokes that one.
		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_next",
			});
		});
		expect(refreshedSessionIds).toEqual(["session_1", "session_2"]);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "bonobo:token",
				requestId: "refresh_next",
				token: "plu_rotated",
				jwt: "jwt_rotated",
			}),
			CONVEX_HTTP_ORIGIN,
		);
		expect(mintCount).toBe(2);

		mounted.unmount();
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_2",
		});
	});

	test("a lost session whose re-mint is refused shows the mint error and moves focus to Retry", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				// The plugin was uninstalled while the device slept, so the re-mint refuses.
				return Promise.resolve(
					mintCount === 1
						? {
								_yay: {
									token: "plu_1",
									expiresAt: Date.now() + 60_000,
									pluginVersionId: "version_1",
									sessionId: "session_1",
								},
							}
						: { _nay: { message: "Not found" } },
				);
			}
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost",
			});
		});

		expect(mintCount).toBe(2);
		expect(screen.getByRole("alert").textContent).toContain("Not found");
		const retry = screen.getByRole("button", { name: "Retry" });
		await waitFor(() => expect(document.activeElement).toBe(retry));
		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:token" }), CONVEX_HTTP_ORIGIN);
		// Nothing was minted, and the first session doc is already gone, so nothing is revoked.
		expect(mutationMock).not.toHaveBeenCalledWith("plugins_ui.revoke_ui_session", expect.anything());
	});

	test("a re-mint that returns another plugin version revokes it and stops the frame", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				// The installation was upgraded while the device slept, so the re-mint binds to the
				// new version while this frame still runs the old bundle.
				return Promise.resolve({
					_yay: {
						token: `plu_${mintCount}`,
						expiresAt: Date.now() + 60_000,
						pluginVersionId: mintCount === 1 ? "version_1" : "version_2",
						sessionId: `session_${mintCount}`,
					},
				});
			}
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost",
			});
		});

		expect(mintCount).toBe(2);
		expect(screen.getByRole("alert").textContent).toContain("installed plugin version changed");
		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:token" }), CONVEX_HTTP_ORIGIN);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_2",
		});
	});

	test("a re-mint that finishes after unmount revokes the new session without posting", async () => {
		let resolveRemint: ((value: unknown) => void) | null = null;
		const remintPromise = new Promise((resolve) => {
			resolveRemint = resolve;
		});
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				return mintCount === 1
					? Promise.resolve({
							_yay: {
								token: "plu_1",
								expiresAt: Date.now() + 60_000,
								pluginVersionId: "version_1",
								sessionId: "session_1",
							},
						})
					: remintPromise;
			}
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const mounted = render(<PageComponent />);
		const { nonce } = bridge_for(mounted.container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost",
			});
		});
		expect(mintCount).toBe(2);
		mounted.unmount();

		await act(async () => {
			resolveRemint?.({
				_yay: {
					token: "plu_2",
					expiresAt: Date.now() + 60_000,
					pluginVersionId: "version_1",
					sessionId: "session_2",
				},
			});
			await remintPromise;
		});

		expect(postMessageMock).not.toHaveBeenCalled();
		// The first session doc was already gone, so only the late re-mint has something to revoke.
		expect(mutationMock).not.toHaveBeenCalledWith(
			"plugins_ui.revoke_ui_session",
			expect.objectContaining({ sessionId: "session_1" }),
		);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_2",
		});
	});

	test("a re-minted session that dies before it ever refreshed stops the frame instead of minting again", async () => {
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
			// Every refresh finds its session gone, so a host that re-minted on each one would loop.
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost",
			});
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_lost", token: "plu_2" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(screen.queryByRole("alert")).toBeNull();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce,
				requestId: "refresh_lost_again",
			});
		});

		expect(mintCount).toBe(2);
		expect(screen.getByRole("alert").textContent).toContain("The plugin page session was lost");
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
	});

	test("a transient refresh failure answers token-error without minting again", async () => {
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
		await act(async () => post_ready(firstBridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({
				type: "bonobo:token-refresh-request",
				nonce: firstBridge.nonce,
				requestId: "refresh_transient",
			});
		});

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error", requestId: "refresh_transient", message: "Not found" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(bridge_for(container).nonce).toBe(firstBridge.nonce);
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
		const { iframe, nonce } = bridge_for(container);
		post_ready(nonce);
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

	test("Retry remounts with a fresh session and nonce", async () => {
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
		await act(async () => post_ready(firstBridge.nonce));
		const firstNonce = latest_init_message().nonce;
		expect(firstNonce).toBe(firstBridge.nonce);

		fireEvent.load(firstBridge.iframe);
		fireEvent.load(firstBridge.iframe);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		const secondBridge = bridge_for(container);
		expect(secondBridge.nonce).not.toBe(firstNonce);
		postMessageMock.mockClear();

		await act(async () => post_ready(firstNonce));
		expect(mintCount).toBe(2);
		expect(postMessageMock).not.toHaveBeenCalled();

		await act(async () => post_ready(secondBridge.nonce));
		const secondNonce = latest_init_message().nonce;
		expect(secondNonce).toBe(secondBridge.nonce);
		expect(mintCount).toBe(2);
	});

	test("init context carries the viewing member's userId for both context kinds", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const page = render(<PageComponent />);
		const pageBridge = bridge_for(page.container);
		await act(async () => post_ready(pageBridge.nonce));
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
		await act(async () => post_ready(viewBridge.nonce));
		expect(latest_init_message().context).toMatchObject({ kind: "file_view", fileViewId: "viewer", userId: "user_1" });
	});

	// #region dev-only bundle override

	const OVERRIDE_ORIGIN = "http://localhost:5174";

	/** Points the override at `version_1`, the id every fixture in this file mints. */
	function stub_override(origin = OVERRIDE_ORIGIN) {
		vi.stubEnv("VITE_PLUGIN_UI_DEV_VERSION_ID", "version_1");
		vi.stubEnv("VITE_PLUGIN_UI_DEV_ORIGIN", origin);
	}

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("an override loads the frame from its own origin and trusts that origin only", async () => {
		stub_override();
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { iframeUrl, nonce } = bridge_for(container);
		expect(iframeUrl.origin).toBe(OVERRIDE_ORIGIN);

		// A different port on the same host is a different origin, and the frame holds a session
		// token, so it must be refused exactly like any other stranger.
		await act(async () => post_from_frame({ type: "bonobo:ready", nonce }, "http://localhost:5175"));
		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), expect.anything());

		await act(async () => post_from_frame({ type: "bonobo:ready", nonce }, OVERRIDE_ORIGIN));
		expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), OVERRIDE_ORIGIN);
	});

	test("an override for another version leaves this frame on the published bundle", async () => {
		vi.stubEnv("VITE_PLUGIN_UI_DEV_VERSION_ID", "version_other");
		vi.stubEnv("VITE_PLUGIN_UI_DEV_ORIGIN", OVERRIDE_ORIGIN);
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);

		expect(bridge_for(container).iframeUrl.origin).toBe(CONVEX_HTTP_ORIGIN);
	});

	test("outside a development build the override does not exist", async () => {
		// Vite erases the whole branch from a production build. This asserts the behaviour that
		// erasure produces: with DEV false the override is not consulted at all, so the frame keeps
		// the published bundle and a message from the override origin is a message from a stranger.
		vi.stubEnv("DEV", false);
		stub_override();
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { iframeUrl, nonce } = bridge_for(container);
		expect(iframeUrl.origin).toBe(CONVEX_HTTP_ORIGIN);

		await act(async () => post_from_frame({ type: "bonobo:ready", nonce }, OVERRIDE_ORIGIN));
		expect(postMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "bonobo:init" }), expect.anything());
	});

	// #endregion dev-only bundle override
});
