/**
 * @vitest-environment jsdom
 *
 * These tests cover the route's state machine and message fields. WindowProxy identity,
 * sandbox navigation, concrete-origin delivery, and what `inert` does to focus and clicks all need
 * the browser-project coverage instead. jsdom implements no part of `inert`: `"inert" in
 * HTMLElement.prototype` is false, and `.focus()` inside `<div inert>` still moves
 * `document.activeElement`. So a test in this file can pin where the attribute sits and nothing
 * more.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrictMode, useRef, useState } from "react";
import type { ComponentProps, ComponentPropsWithRef } from "react";
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

// The real hook keeps one identity for the whole life of the component and forwards each call to the
// latest closure, so this mock does the same. A mock that returned the handler itself would give the
// frame a new `mintSession` and `getInitContext` on every render. Both are in the bridge effect's
// dependency array, and the route re-renders while a frame is starting, because the handshake takes
// the starting placeholder down. The effect would then re-run, revoke the live session, and mint
// another one — the failure the frame's props docblock warns about, caused by the mock rather than by
// the code under test.
vi.mock("@/hooks/utils-hooks.ts", () => ({
	useFn: function useFn<T extends (...args: never[]) => unknown>(handler: T) {
		const handlerRef = useRef(handler);
		handlerRef.current = handler;
		const [stableFn] = useState(
			() =>
				(...args: Parameters<T>) =>
					handlerRef.current(...args),
		);
		return stableFn;
	},
}));

vi.mock("@/components/my-button.tsx", () => ({
	// The real button takes every `<button>` prop and spreads it onto the element. Forward the same
	// set: both mount points give their Retry button an `aria-describedby` that names the error
	// message, and a mock that dropped it would fail a test written against correct code.
	MyButton: function MyButton(props: ComponentPropsWithRef<"button">) {
		const { ref, type = "button", ...rest } = props;
		return <button ref={ref} type={type} {...rest} />;
	},
}));

import { PluginsUiFrame, type PluginsUiFrame_Props } from "@/components/plugins-ui-frame.tsx";
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

// Every `--color-<scale>-NN` step declared in `app.css`, name to value. Read from the stylesheet on
// purpose, and match any scale name rather than the ones the frame knows: the frame keeps its own
// static list of these names (computed styles cannot be enumerated), and comparing the posted theme
// against the stylesheet is what catches a scale added, renamed, or resized there without the list
// following. A scale new to both would slip past a list of names here.
//
// The shadcn aliases in the same file (`--color-accent: var(--accent)`, `--color-border`, …) have
// no two-digit step and stay out, as they must.
const APP_COLOR_SCALES: Record<string, string> = Object.fromEntries(
	[...readFileSync(join(process.cwd(), "src", "app.css"), "utf8").matchAll(/^\s*(--color-[a-z0-9-]+-\d{2}):\s*([^;]+);/gmu)].map(
		(match) => [match[1], match[2]],
	),
);

// Reads `const <name> = <number>;` out of a file this test cannot import, so a limit that lives in
// another package is checked against its source instead of a copy typed in here. Both ways of losing
// the constant are loud: `readFileSync` throws when the file moves, and the expectation below fails
// when the name changes, so neither turns into arithmetic on `undefined`.
function read_number_constant(filePath: string, name: string) {
	const source = readFileSync(filePath, "utf8");
	const value = Number(source.match(new RegExp(`\\b${name}\\s*=\\s*([\\d_]+)`, "u"))?.[1].replaceAll("_", ""));
	expect(Number.isFinite(value), `${name} is not a number constant in ${filePath}`).toBe(true);
	return value;
}

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

	test("the Retry button carries the reason as its description", async () => {
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session" ? { _nay: { message: "Unauthorized" } } : { _yay: {} },
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);

		// Focus lands on Retry as the alert appears, and the button's whole name is "Retry". Without a
		// description a screen reader tells the member that there is a button and never says what
		// failed, so the message and the button have to be tied together.
		const alert = await screen.findByRole("alert");
		const retry = screen.getByRole("button", { name: "Retry" });
		const describedBy = retry.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe("Unauthorized");
		expect(alert.contains(document.getElementById(describedBy))).toBe(true);
	});

	test("a mint refused by the rate limiter tells the member how long to wait", async () => {
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? { _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } }
				: { _yay: {} },
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const rateLimited = render(<PageComponent />);

		// A refused mint leaves no frame at all, so this sentence is the whole page. The server's own
		// words tell the member nothing they can do, so the host rewrites this one refusal and names
		// the wait, rounded up to whole seconds so nobody retries too early.
		expect((await screen.findByRole("alert")).textContent).toContain(
			"The plugin page was started too many times in a row. Wait 4 seconds, then press Retry.",
		);
		expect(screen.getByRole("alert").textContent).not.toContain("Rate limit exceeded");
		rateLimited.unmount();

		// Every other refusal already describes what went wrong, so it reaches the member unchanged.
		mutationMock.mockImplementation(async (reference: string) =>
			reference === "plugins_ui.mint_page_session" ? { _nay: { message: "Not found" } } : { _yay: {} },
		);
		render(<PageComponent />);

		expect((await screen.findByRole("alert")).textContent).toContain("Not found");
	});

	test("the wait in that sentence is rounded up, reads as one second, and survives a missing delay", async () => {
		const refuse_mint_with = (data: { retryAfterMs: number } | undefined) =>
			mutationMock.mockImplementation(async (reference: string) =>
				reference === "plugins_ui.mint_page_session"
					? { _nay: { message: "Rate limit exceeded", data } }
					: { _yay: {} },
			);
		const PageComponent = Route.options.component as () => JSX.Element;

		// The rate limiter computes the delay as `retryAfter = -value / rate`, so the number the server
		// sends is a fraction far more often than a whole count of milliseconds. Rounding it down would
		// send the member back while the bucket is still empty, and the retry would be refused again.
		refuse_mint_with({ retryAfterMs: 4831.666666666667 });
		const fractional = render(<PageComponent />);
		expect((await screen.findByRole("alert")).textContent).toContain("Wait 5 seconds, then press Retry.");
		fractional.unmount();

		// Under a second is still a wait, and "Wait 1 seconds" reads as a bug to the member.
		refuse_mint_with({ retryAfterMs: 600 });
		const singular = render(<PageComponent />);
		expect((await screen.findByRole("alert")).textContent).toContain("Wait 1 second, then press Retry.");
		singular.unmount();

		// A deployment older than the `retryAfterMs` field sends the refusal with no data at all. The
		// member still gets a wait to sit out instead of a sentence with a hole in it.
		refuse_mint_with(undefined);
		render(<PageComponent />);
		expect((await screen.findByRole("alert")).textContent).toContain("Wait 5 seconds, then press Retry.");
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
		// the list invents shows up as an extra key with an empty value. Do not count the keys as
		// well. A designer who adds a scale to `app.css` and to the frame's list has made a complete
		// and correct change, and a count pinned here would turn that change red for nothing.
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

	test("the startup deadline leaves focus where the member put it", () => {
		vi.useFakeTimers();
		// Fifteen seconds is long enough for the member to give up on the page and go back to typing
		// somewhere else on the screen. Nobody asked for this timer, so it must not take their caret.
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);

		act(() => vi.advanceTimersByTime(15_000));

		expect(screen.getByRole("alert").textContent).toContain("The plugin page did not start in time");
		expect(document.activeElement).toBe(outside);
		outside.remove();
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

	test("a ready flood past the allowance stops the frame and revokes its session", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);

		// The first ready mints and posts init, so the session exists before the flood starts.
		await act(async () => post_ready(nonce));
		expect(latest_init_message().nonce).toBe(nonce);
		postMessageMock.mockClear();

		// MAX_READY_MESSAGES is 64. The 65th is the one that stops the frame.
		await act(async () => {
			for (let index = 0; index < 64; index += 1) {
				post_ready(nonce);
			}
		});

		expect(screen.getByRole("alert").textContent).toContain("flooded the bridge and was stopped");
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_default",
		});
		// The alert replaces the iframe, so nothing is left to post to.
		expect(container.querySelector("iframe")).toBeNull();
	});

	test("a ready count that stops at the allowance leaves the frame running", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);

		// The other side of the boundary the test above pins. MAX_READY_MESSAGES is 64, and only the
		// 65th stops the frame. A page that is merely slow to start keeps sending ready every 500 ms
		// until init reaches it, so counting one message too early would tell that member their page
		// "flooded the bridge" for being slow.
		await act(async () => {
			for (let index = 0; index < 64; index += 1) {
				post_ready(nonce);
			}
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(bridge_for(container).nonce).toBe(nonce);
		expect(mutationMock).not.toHaveBeenCalledWith("plugins_ui.revoke_ui_session", expect.anything());
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

	test("the same request id sent twice while one refresh is in flight gets one rotation and answers both", async () => {
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
		postMessageMock.mockClear();

		// The SDK cannot do this: `refreshToken()` in `packages/bonobo-plugin-sdk/frontend.js` hands
		// the in-flight promise to concurrent callers, and every new request gets a fresh
		// `crypto.randomUUID()`. This is hardening against a page that posts bridge messages by
		// hand. Both carry the same request id, so both must be answered from the one rotation
		// already running.
		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_same" });
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_same" });
		});
		expect(postMessageMock).not.toHaveBeenCalled();

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

		expect(
			mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.refresh_ui_session"),
		).toHaveLength(1);
		const answers = postMessageMock.mock.calls.filter(
			([value]) => (value as { requestId?: string }).requestId === "refresh_same",
		);
		expect(answers).toHaveLength(2);
		for (const [answer] of answers) {
			expect(answer).toMatchObject({ type: "bonobo:token", requestId: "refresh_same", token: "plu_2" });
		}
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

	test("a healthy rotation lets a second lost session be re-minted too", async () => {
		let mintCount = 0;
		let secondSessionRefreshCount = 0;
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
			// One tab left open all day. The laptop sleeps past the session expiry, the server deletes
			// the session, and the host heals the page with a new one. Later that day the member comes
			// back, a rotation succeeds, and then the laptop sleeps again and deletes that session too.
			if (reference === "plugins_ui.refresh_ui_session") {
				if (args.sessionId === "session_1") {
					return Promise.resolve({ _nay: { message: "Unauthorized" } });
				}
				secondSessionRefreshCount += 1;
				return Promise.resolve(
					secondSessionRefreshCount === 1
						? {
								_yay: {
									token: "plu_rotated",
									expiresAt: Date.now() + 60_000,
									jwt: "jwt_rotated",
									jwtExpiresAt: Date.now() + 60_000,
									pluginVersionId: "version_1",
								},
							}
						: { _nay: { message: "Unauthorized" } },
				);
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		// First sleep: the session is gone, so the host mints a second one for this same document.
		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_lost" });
		});
		expect(mintCount).toBe(2);

		// The member comes back and the page rotates normally, which is what says the new session is
		// healthy. The one-re-mint-per-session rule has to start over from here.
		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_healthy" });
		});
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_healthy", token: "plu_rotated" }),
			CONVEX_HTTP_ORIGIN,
		);

		// Second sleep, same page still open. Without the reset the member would lose the running page
		// to "The plugin page session was lost" and have to press Retry, because the host would still
		// be counting the re-mint it did this morning.
		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_lost_again" });
		});

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_lost_again", token: "plu_3", jwt: "jwt_3" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(mintCount).toBe(3);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(bridge_for(container).nonce).toBe(nonce);
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

	test("a re-mint refused by the rate limiter tells the member how long to wait too", async () => {
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.mint_page_session") {
				mintCount += 1;
				// The mint bucket holds two tokens and a second tab of the same plugin charges it too,
				// so it can be empty by the time this frame has to replace the session it lost.
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
						: { _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 2500 } } },
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
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_lost" });
		});

		// The alert replaces the running page, so this sentence is the whole thing the member is left
		// with. Both mint call sites have to rewrite the refusal, not just the first one: "Rate limit
		// exceeded" is the server's own wording and tells the member nothing they can do.
		expect(screen.getByRole("alert").textContent).toContain(
			"The plugin page was started too many times in a row. Wait 3 seconds, then press Retry.",
		);
		expect(screen.getByRole("alert").textContent).not.toContain("Rate limit exceeded");
		expect(mintCount).toBe(2);
		// Nothing reaches the frame. The stop path sets `cancelled` before the token-error it builds
		// is posted, and the alert has replaced the iframe in the same commit anyway, so the sentence
		// above is the only thing anybody is left reading.
		expect(postMessageMock).not.toHaveBeenCalled();
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

	test("a re-minted session that dies again within minutes stops the frame instead of minting again", async () => {
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
			// The two asks below arrive with no time between them, which is what makes this a loop
			// rather than a device that slept twice; the test after this one is the other side.
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

	test("a device that sleeps through a second session is re-minted again rather than stopped", async () => {
		vi.useFakeTimers();
		let mintCount = 0;
		mutationMock.mockImplementation((reference: string) => {
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
			// No rotation ever succeeds here, so nothing resets the gap the way the healthy rotation
			// above does. The clock is the only thing telling this apart from the mint loop.
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
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_lost" });
		});
		expect(mintCount).toBe(2);

		// The lid closes for an hour. A session lasts half an hour, so the replacement is gone too by
		// the time the page wakes up and asks again. `REMINT_MIN_GAP_MS` in `plugins-ui-frame.tsx` is
		// a few minutes, so an hour is well past it. The number is not read from the source here
		// because it is written as a product of two numbers, and a reader that took only the first
		// one would quietly compare against milliseconds.
		vi.setSystemTime(Date.now() + 60 * 60_000);
		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_lost_again" });
		});

		// The member kept a tab open all day and did nothing wrong, so they keep their page.
		expect(mintCount).toBe(3);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(bridge_for(container).nonce).toBe(nonce);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_lost_again", token: "plu_3", jwt: "jwt_3" }),
			CONVEX_HTTP_ORIGIN,
		);
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

	test("a rate-limited refresh waits the delay the server sent and rotates once more", async () => {
		vi.useFakeTimers();
		let refreshCount = 0;
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
			// The rotation charges the same bucket the page mint charged, and that bucket holds two
			// tokens, so the first rotation of a fresh frame is often refused.
			if (reference === "plugins_ui.refresh_ui_session") {
				refreshCount += 1;
				return refreshCount === 1
					? Promise.resolve({ _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } })
					: Promise.resolve({
							_yay: {
								token: "plu_2",
								expiresAt: Date.now() + 60_000,
								jwt: "jwt_2",
								jwtExpiresAt: Date.now() + 60_000,
								pluginVersionId: "version_1",
							},
						});
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_rate" });
		});
		// Nothing is answered yet: the host is waiting out the delay instead of killing the page.
		expect(refreshCount).toBe(1);
		expect(postMessageMock).not.toHaveBeenCalled();

		// Stop one millisecond short of the delay the server sent. Advancing the whole delay in one
		// step also passes for a host that waits a flat second and throws the server's number away,
		// so the boundary is what pins the duration.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3999);
		});
		expect(refreshCount).toBe(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});

		expect(refreshCount).toBe(2);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_rate", token: "plu_2", jwt: "jwt_2" }),
			CONVEX_HTTP_ORIGIN,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("a rate-limited refusal with no delay to wait stops the frame and offers Retry", async () => {
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
			// Today's server always attaches the delay: the rate limiter's own refusal arm types
			// `retryAfter` as required, so `rate_limiter_limit_by_key` always has a number to pass
			// on. This shape reaches the frame across a version skew — a browser on the new bundle
			// talking to a deployment still running the old `plugins_ui.ts`, which is what the QA
			// notes recorded from the pre-fix server. So the guard covers the rollout window. With
			// no delay the host has nothing to wait out, and it must not sit silent.
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({ _nay: { message: "Rate limit exceeded" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_rate" });
		});

		expect(screen.getByRole("alert").textContent).toContain("could not renew its session");
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		// The frame is still told why, so its own retries stop instead of hanging.
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "bonobo:token-error",
				requestId: "refresh_rate",
				message: "Rate limit exceeded",
			}),
			CONVEX_HTTP_ORIGIN,
		);
		expect(
			mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.refresh_ui_session"),
		).toHaveLength(1);
	});

	test("a bucket still empty after the wait stops the frame instead of retrying forever", async () => {
		vi.useFakeTimers();
		let refreshCount = 0;
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
				refreshCount += 1;
				return Promise.resolve({ _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_rate" });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// Exactly one retry, then the member gets the alert rather than a page that quietly stopped.
		expect(refreshCount).toBe(2);
		expect(screen.getByRole("alert").textContent).toContain("could not renew its session");
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token-error", requestId: "refresh_rate" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("a session lost during the rate-limit wait is re-minted instead of killing the page", async () => {
		vi.useFakeTimers();
		let mintCount = 0;
		let refreshCount = 0;
		mutationMock.mockImplementation((reference: string) => {
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
			// The bucket refuses the first rotation, and the session reaches its expiry while the host
			// sits out the wait, so the server has deleted it by the time the retry asks.
			if (reference === "plugins_ui.refresh_ui_session") {
				refreshCount += 1;
				return refreshCount === 1
					? Promise.resolve({ _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } })
					: Promise.resolve({ _nay: { message: "Unauthorized" } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce, requestId: "refresh_rate" });
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		// Only a second refusal that is still the rate limiter's may stop the frame. Every other one
		// falls through to the branches that know what to do with it, and this is the one that keeps a
		// running page alive: the host mints a replacement session for the same document and answers
		// the refresh with it. Widen that check to any refusal and the member loses their page, their
		// draft, and their live subscriptions to a session that expired while the host was waiting.
		expect(refreshCount).toBe(2);
		expect(mintCount).toBe(2);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(bridge_for(container).nonce).toBe(nonce);
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token", requestId: "refresh_rate", token: "plu_2", jwt: "jwt_2" }),
			CONVEX_HTTP_ORIGIN,
		);
	});

	test("a page unmounted during the rate-limit wait does not rotate again", async () => {
		vi.useFakeTimers();
		let refreshCount = 0;
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
				refreshCount += 1;
				return Promise.resolve({ _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } });
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const mounted = render(<PageComponent />);
		const bridge = bridge_for(mounted.container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_rate" });
		});
		expect(refreshCount).toBe(1);

		// The wait lasts seconds, so a member leaving the page inside it is ordinary. After the wait
		// the host asks whether this frame is still the mounted one, and an unmounted frame is not.
		mounted.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(refreshCount).toBe(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("a frame stopped by a second load during the rate-limit wait does not rotate again", async () => {
		vi.useFakeTimers();
		let refreshCount = 0;
		mutationMock.mockImplementation((reference: string) => {
			if (reference === "plugins_ui.refresh_ui_session") {
				refreshCount += 1;
				return Promise.resolve({ _nay: { message: "Rate limit exceeded", data: { retryAfterMs: 4000 } } });
			}
			return Promise.resolve({ _yay: {} });
		});
		const onError = vi.fn();
		const viewProps = {
			membershipId: "membership_1",
			pluginName: "gallery",
			pluginVersionId: "version_1",
			entry: "dist/frontend/view.html",
			title: "Viewer",
			kindLabel: "plugin view",
			mintSession: () =>
				Promise.resolve({
					_yay: {
						token: "plu_1",
						expiresAt: Date.now() + 60_000,
						pluginVersionId: "version_1",
						sessionId: "session_1",
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
			onError,
		} as unknown as ComponentProps<typeof PluginsUiFrame>;

		// The bare frame, not a mount point: a mount point replaces the iframe with its alert, so the
		// frame would leave the DOM and the identity check would stop the rotation on its own. Here
		// the stopped frame stays mounted, so only the `cancelled` flag can stop it.
		const view = render(<PluginsUiFrame {...viewProps} />);
		const bridge = bridge_for(view.container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_rate" });
		});
		expect(refreshCount).toBe(1);

		// A second load means the frame navigated itself, so the host stops it mid-wait.
		fireEvent.load(bridge.iframe);
		fireEvent.load(bridge.iframe);
		expect(onError).toHaveBeenCalledWith("The plugin view navigated away and was stopped");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(refreshCount).toBe(1);
		// The frame is already stopped for navigating away, so the rate-limit branch must not report
		// a second reason on top of it.
		expect(onError).toHaveBeenCalledTimes(1);
	});

	test("the mint bucket cannot make the host wait past the SDK's refresh deadline", () => {
		// This test guards a coupling that lives in three files and that nothing else enforces.
		//
		// A rate-limited rotation makes the host sleep for the delay the server sent and rotate once
		// more. Meanwhile the SDK abandons an unanswered refresh after `REFRESH_DEADLINE_MS`. If the
		// host answers after that, the SDK has already dropped the request while the host thinks it
		// answered, so `onError` is never called: the member gets a dead plugin page with no alert
		// and no Retry. No test, type, or lint would fail.
		//
		// If this test goes red, the fix is the bucket, not this number. Either give
		// `plugins_ui_session_mint` a faster rate so its worst-case wait shrinks again, or change
		// the host to stop waiting and answer `token-error` right away. Loosening the budget below
		// only hides the dead page.
		const rateLimiterSource = readFileSync(join(process.cwd(), "convex", "rate_limiter.ts"), "utf8");
		// The config object is module-private, so read the bucket out of the source instead of
		// repeating its numbers here. The entry is either an inline object or a shared constant.
		const bucketReference = rateLimiterSource.match(/plugins_ui_session_mint:\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)/u)?.[1];
		const bucket = bucketReference?.startsWith("{")
			? bucketReference
			: rateLimiterSource.match(new RegExp(`const ${bucketReference} = (\\{[^}]*\\})`, "u"))?.[1];
		expect(bucket).toMatch(/kind:\s*"token bucket"/u);

		const rate = Number(bucket?.match(/rate:\s*([\d_]+)/u)?.[1].replaceAll("_", ""));
		// `period` is written with the rate-limiter's own unit constants. Fail loudly on a unit this
		// map does not know rather than computing a wait from `undefined`.
		const periodMs = { SECOND: 1_000, MINUTE: 60_000, HOUR: 3_600_000 }[
			bucket?.match(/period:\s*([A-Z_]+)/u)?.[1] ?? ""
		];
		expect(Number.isFinite(rate)).toBe(true);
		expect(Number.isFinite(periodMs)).toBe(true);

		// A refusal asks for one token, and `calculateRateLimit` in the rate-limiter component sets
		// `retryAfter = -value / rate` with `value` never below -1. So the longest delay the server
		// can send is the time one token takes to accrue: `period / rate`.
		const worstCaseWaitMs = Number(periodMs) / rate;

		// `REFRESH_DEADLINE_MS` in `packages/bonobo-plugin-sdk/frontend.js`. The SDK does not export
		// it, so read it out of the source the same way as the bucket above. A copy typed in here
		// would let a shorter deadline in the SDK slide past this test.
		const SDK_REFRESH_DEADLINE_MS = read_number_constant(
			join(process.cwd(), "..", "bonobo-plugin-sdk", "frontend.js"),
			"REFRESH_DEADLINE_MS",
		);
		// One refresh round trip: the postMessage hop into the host, the Convex call, and the answer
		// posted back. Two of them wrap the wait — the refused rotation and the retry that follows
		// it — and that is the path this budget guards.
		const REFRESH_ROUND_TRIP_BUDGET_MS = 2_000;

		expect(worstCaseWaitMs + 2 * REFRESH_ROUND_TRIP_BUDGET_MS).toBeLessThan(SDK_REFRESH_DEADLINE_MS);

		// One path costs a third call and does not fit. If the retry after the wait answers
		// "Unauthorized", the host mints a replacement session before it answers, so the member's
		// running page is healed instead of killed. At the budget above, three calls around a
		// 5-second wait come to 11 seconds against a 10-second deadline, so the SDK has usually
		// given up on this request by the time the answer arrives.
		//
		// That is survivable, which is why this test does not demand it fit. The SDK's `refreshToken`
		// rejects at the deadline, `fetch_convex_jwt` in the same file catches the rejection, counts
		// it as transient, waits a second and asks again, up to three attempts in all. So the page
		// gets its JWT on a later attempt instead of dropping to unauthenticated. The path itself is
		// pinned by "a session lost during the rate-limit wait is re-minted instead of killing the
		// page" above. Nothing is asserted about it here: an assertion that it overshoots would go
		// red the day somebody makes the bucket faster, which is the fix, not the regression.
	});

	test("a slow start cannot reach the flood limit before the startup deadline", () => {
		// A second coupling of the same shape, between the SDK and the frame, and nothing else
		// enforces it either.
		//
		// The SDK repeats bonobo:ready every `READY_RETRY_MS` until an init reaches it, and the frame
		// stops a page that sends more than `MAX_READY_MESSAGES` of them. A page that is only slow to
		// start must never reach that limit while the frame is still waiting for it: the member would
		// be told the page "flooded the bridge and was stopped", which blames the plugin for being
		// slow. Past the deadline the frame is over anyway, so only the deadline window counts.
		//
		// If this goes red, the fix is one of the three numbers, not this arithmetic.
		const sdkPath = join(process.cwd(), "..", "bonobo-plugin-sdk", "frontend.js");
		const framePath = join(process.cwd(), "src", "components", "plugins-ui-frame.tsx");
		const readyRetryMs = read_number_constant(sdkPath, "READY_RETRY_MS");
		const startupDeadlineMs = read_number_constant(framePath, "STARTUP_DEADLINE_MS");
		const maxReadyMessages = read_number_constant(framePath, "MAX_READY_MESSAGES");

		// The SDK posts one ready straight away and the interval sends the rest, so this is what a
		// frame that takes the whole deadline sends.
		expect(1 + Math.floor(startupDeadlineMs / readyRetryMs)).toBeLessThanOrEqual(maxReadyMessages);
	});

	test("a refresh answered with another plugin version answers token-error", async () => {
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
			// Defence in depth against a server that answers with a version this frame is not. No
			// current server path produces this: `rotate_ui_session` compares the installation's
			// `pluginVersionId` with the session's and refuses with "Not found" first, so an
			// installation that moved to another version never reaches a success answer.
			if (reference === "plugins_ui.refresh_ui_session") {
				return Promise.resolve({
					_yay: {
						token: "plu_2",
						expiresAt: Date.now() + 60_000,
						jwt: "jwt_2",
						jwtExpiresAt: Date.now() + 60_000,
						pluginVersionId: "version_2",
					},
				});
			}
			return Promise.resolve({ _yay: {} });
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);
		await act(async () => post_ready(bridge.nonce));
		postMessageMock.mockClear();

		await act(async () => {
			post_from_frame({ type: "bonobo:token-refresh-request", nonce: bridge.nonce, requestId: "refresh_version" });
		});

		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "bonobo:token-error",
				requestId: "refresh_version",
				message: "The installed plugin version changed",
			}),
			CONVEX_HTTP_ORIGIN,
		);
		// The token from the wrong version is never handed to the frame.
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:token" }),
			CONVEX_HTTP_ORIGIN,
		);
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

	test("the page shows a starting placeholder until the handshake finishes", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const bridge = bridge_for(container);

		// The iframe paints nothing of its own until the plugin's code runs, and that can take the
		// whole startup deadline, so without this the member watches an empty region.
		expect(screen.getByText("Starting the plugin page...")).toBeTruthy();

		await act(async () => post_ready(bridge.nonce));

		expect(screen.queryByText("Starting the plugin page...")).toBeNull();
		// The frame is what reported the handshake, so it has to survive the render that takes the
		// placeholder down. An unchanged nonce says the same document is still there, and no revoke
		// says its session was not thrown away and re-minted underneath it.
		expect(bridge_for(container).nonce).toBe(bridge.nonce);
		expect(mutationMock).not.toHaveBeenCalledWith("plugins_ui.revoke_ui_session", expect.anything());
	});

	test("a mint that finishes before the frame says ready still takes the cover down", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);

		// The other start order, and at least as common in production: a warm Convex answers the mint
		// while the plugin's bundle is still downloading. Every other test in this file posts ready
		// inside the same `act` that flushes the mint, so there the mint's own `.then` posts init and
		// reports the start. Flushing the mint on its own first puts init in the host's hand before
		// ready arrives, and then `handle_ready` is what has to report it.
		await act(async () => {});
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "bonobo:init" }),
			CONVEX_HTTP_ORIGIN,
		);

		await act(async () => post_ready(nonce));
		expect(latest_init_message().nonce).toBe(nonce);

		// A frame that starts without saying so shuts the member out of a page that is running. The
		// cover paints an opaque surface over the whole frame region, and the wrapper under it is
		// `inert`, so there is nothing to click and nothing to tab to and only a reload gets out of
		// it. The cover's paint is a style, which no test in this repository can see, so what is
		// checked here is the text and the attribute.
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();
		expect(container.querySelector("iframe")?.closest("[inert]")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("The plugin page is ready.");
	});

	test("the covered iframe is inert while the placeholder is up, and the placeholder is not", async () => {
		// jsdom implements no part of `inert`, so this test cannot show that focus and clicks are
		// really kept out of the frame. What it does show is where the attribute sits, which is the
		// half that is easy to move by accident. The browser does the rest: in a real browser the
		// iframe under the cover is still a tab stop and still takes clicks, so without the attribute
		// a member could land inside a page they have just been told is not running yet.
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);

		const inertAncestor = container.querySelector("iframe")?.closest("[inert]");
		expect(inertAncestor).not.toBeNull();

		// The cover must stay outside that inert subtree. `inert` takes an element out of the
		// accessibility tree, so a live region marked inert announces nothing and the member waits
		// with no idea that anything is happening.
		const placeholder = screen.getByRole("status");
		expect(placeholder.textContent).toContain("Starting the plugin page...");
		expect(inertAncestor?.contains(placeholder)).toBe(false);

		await act(async () => post_ready(nonce));

		expect(container.querySelector("iframe")?.closest("[inert]")).toBeNull();
	});

	test("the waiting message and the ready message come from one live region that stays in the page", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { nonce } = bridge_for(container);

		const region = screen.getByRole("status");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.textContent).toContain("Starting the plugin page...");

		await act(async () => post_ready(nonce));

		// The same element, still in the page, holding new words. A region that left when the frame
		// started would leave a member who heard the wait begin with nothing to tell them it ended: a
		// start that fails is announced by the alert, and a start that works announces nothing else.
		expect(screen.getByRole("status")).toBe(region);
		expect(region.textContent).toBe("The plugin page is ready.");
	});

	test("the live region enters the page empty and gets its text on the next commit", async () => {
		// A polite live region that arrives already holding its text is the case screen readers do not
		// announce, so the region is rendered empty and filled one commit later. That later change is
		// what gets spoken. The finished DOM shows nothing of that order, so watch the mutations while
		// they happen. What a screen reader does with them is browser behaviour and is not checked
		// here; what is checked is that the host gives it two changes instead of one.
		const container = document.createElement("div");
		document.body.append(container);
		const records: MutationRecord[] = [];
		const observer = new MutationObserver((entries) => records.push(...entries));
		observer.observe(container, { subtree: true, childList: true, characterData: true });

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />, { container });
		records.push(...observer.takeRecords());
		observer.disconnect();

		const region = screen.getByRole("status");
		expect(region.textContent).toContain("Starting the plugin page...");

		const insertedAt = records.findIndex((record) =>
			[...record.addedNodes].some((node) => node === region || node.contains(region)),
		);
		const filledAt = records.findIndex((record) => record.target === region || region.contains(record.target));
		expect(insertedAt).toBeGreaterThanOrEqual(0);
		expect(filledAt).toBeGreaterThan(insertedAt);

		container.remove();
	});

	test("an error after the frame started shows the alert with no placeholder left behind", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { iframe, nonce } = bridge_for(container);
		await act(async () => post_ready(nonce));
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();

		// A second load means the frame navigated itself, so the host stops a frame that was already
		// running. The alert replaces the whole branch the placeholder lives in.
		fireEvent.load(iframe);
		fireEvent.load(iframe);

		expect(screen.getByRole("alert").textContent).toContain("navigated away");
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();
		expect(container.querySelector("iframe")).toBeNull();
	});

	test("Retry brings the starting placeholder back for the new frame", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const firstBridge = bridge_for(container);
		await act(async () => post_ready(firstBridge.nonce));
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();

		fireEvent.load(firstBridge.iframe);
		fireEvent.load(firstBridge.iframe);
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		// Retry gives the frame a new key, so the started frame is no longer the current one and the
		// placeholder is back with nothing having to reset it.
		const secondBridge = bridge_for(container);
		expect(secondBridge.nonce).not.toBe(firstBridge.nonce);
		expect(screen.getByText("Starting the plugin page...")).toBeTruthy();

		await act(async () => post_ready(secondBridge.nonce));
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();
	});

	test("an error on one plugin page does not come back with the member", async () => {
		const uiPages = createUiPages();
		uiPages[0].pages.push({ id: "settings", title: "Settings", entry: "dist/frontend/settings.html", navItem: null });
		useQueryMock.mockReturnValue(uiPages);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		const { iframe } = bridge_for(container);

		// A second load means the frame navigated itself, so the host stops it and offers Retry.
		fireEvent.load(iframe);
		fireEvent.load(iframe);
		expect(screen.getByRole("alert").textContent).toContain("navigated away");

		// The member clicks the plugin's other page in the nav. This route does not remount on a page
		// change, so the frame key is the only thing that separates the two pages.
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "settings" });
		await act(async () => {
			rerender(<PageComponent />);
		});
		expect(screen.queryByRole("alert")).toBeNull();

		// Then they click back. The key comes back to a value it already had, and the error must not
		// come back with it: this is a new frame that has not failed.
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "media" });
		await act(async () => {
			rerender(<PageComponent />);
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(container.querySelector("iframe")).not.toBeNull();
	});

	test("returning to a page whose earlier frame started still shows the placeholder", async () => {
		const uiPages = createUiPages();
		uiPages[0].pages.push({ id: "settings", title: "Settings", entry: "dist/frontend/settings.html", navItem: null });
		useQueryMock.mockReturnValue(uiPages);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		const first = bridge_for(container);
		await act(async () => post_ready(first.nonce));
		expect(screen.queryByText("Starting the plugin page...")).toBeNull();

		// The member visits the other page and comes back before its handshake finishes.
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "settings" });
		await act(async () => {
			rerender(<PageComponent />);
		});
		expect(screen.getByText("Starting the plugin page...")).toBeTruthy();

		// The page they return to is a new frame with its own handshake still to come, so it needs the
		// placeholder as much as any other new frame. A handshake remembered from the earlier visit
		// would leave them watching an iframe that has painted nothing yet.
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "media" });
		await act(async () => {
			rerender(<PageComponent />);
		});

		expect(screen.getByText("Starting the plugin page...")).toBeTruthy();
	});

	test("Retry gives focus back to the page region so the next Tab reaches the frame", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const { iframe } = bridge_for(container);

		fireEvent.load(iframe);
		fireEvent.load(iframe);
		const retry = screen.getByRole("button", { name: "Retry" });
		await waitFor(() => expect(document.activeElement).toBe(retry));

		// Retry unmounts the button under the member's focus. Without the handover focus falls to
		// the body, and a keyboard member has to tab from the top of the document again.
		fireEvent.click(retry);
		const main = container.querySelector("main");
		await waitFor(() => expect(document.activeElement).toBe(main));
	});

	test("a clean mount leaves focus where the member already had it", async () => {
		// The handover only belongs to a member whose Retry button just vanished from under their
		// focus. A member who never hit an error is free to be typing somewhere else on the screen
		// while this page mounts, so mounting must not pull their caret into the page region.
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);
		await act(async () => {});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	test("a frame replaced by a newer installed version puts the member on the page region", async () => {
		let currentVersionId = "version_1";
		useQueryMock.mockImplementation(() => {
			const uiPages = createUiPages();
			uiPages[0].pluginVersionId = currentVersionId;
			return uiPages;
		});
		// The mint has to follow the version the query returns, or the fresh frame stops with a
		// version mismatch and the alert steals the focus this test is about.
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? Promise.resolve({
						_yay: {
							token: "plu_1",
							expiresAt: Date.now() + 60_000,
							pluginVersionId: currentVersionId,
							sessionId: "session_1",
						},
					})
				: Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		await act(async () => post_ready(bridge_for(container).nonce));
		const main = container.querySelector("main");
		// jsdom cannot put focus inside an iframe, so focus sits on the body. A real browser leaves it
		// there too once the iframe holding it is removed, which is the state this pins the move out of.
		expect(document.activeElement).toBe(document.body);

		// An admin installs a newer version, so the frame the member was reading is thrown away and a
		// new one takes its place.
		currentVersionId = "version_2";
		await act(async () => {
			rerender(<PageComponent />);
		});

		// The region they are standing in has nothing to tab to until the new frame starts: the
		// breadcrumb goes to the app header through a portal, and the new frame is inert meanwhile. So
		// put them on the region and let the next Tab reach the frame.
		expect(container.querySelector("main")).toBe(main);
		expect(document.activeElement).toBe(main);
	});

	test("a StrictMode mount does not pull focus into the page region", async () => {
		// The rescue compares the frame on screen with the one from the render before it, and a
		// development build runs that effect twice on mount. The second run sees the identity the
		// first run just stored, so it has to read that as "nothing was replaced" and leave focus
		// alone. Otherwise every member opening a plugin page in development is dragged into the
		// region.
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(
			<StrictMode>
				<PageComponent />
			</StrictMode>,
		);
		await act(async () => {});

		expect(container.querySelector("main")).not.toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	test("the loading branch keeps a main landmark and announces nothing", async () => {
		// The list of plugin pages has not arrived yet. `role="status"` on this element would replace
		// the implicit `main` role, so a member moving by landmark would find no main content while
		// the query is open, and it would announce nothing anyway: the region and its text arrive in
		// the same commit. The frame branch owns the announcement instead.
		useQueryMock.mockReturnValue(undefined);

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);
		await act(async () => {});

		expect(screen.getByRole("main")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByText("Loading plugin page...")).toBeTruthy();
	});

	test("the frame region carries the page title as its accessible name", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);
		await act(async () => {});

		// Retry hands focus to this region, and so does a page that disappears. Without a name the
		// screen reader announces the landing as an unnamed region, so the member is told they moved
		// and never told where to.
		expect(screen.getByRole("main", { name: "Media" })).toBeTruthy();
	});

	test("a page that disappears under the member is announced and takes the focus", async () => {
		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		await act(async () => post_ready(bridge_for(container).nonce));

		// The query is live, so an admin uninstalling the plugin, or an upgrade that drops this page,
		// empties it while the member is looking at the running page.
		useQueryMock.mockReturnValue([]);
		await act(async () => {
			rerender(<PageComponent />);
		});

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("This plugin page is not available.");
		// The region has no name of its own here, so the message is what describes it. A member sent
		// to the region hears what happened instead of silence.
		const main = container.querySelector("main");
		const describedBy = main?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)).toBe(alert);
		// jsdom cannot put focus inside the iframe, so focus sits on the body when the page vanishes.
		// That is the state a real browser leaves behind too, because it drops focus to the body when
		// the focused iframe is removed. What this pins is the move out of that state.
		expect(document.activeElement).toBe(main);
	});

	test("a page that disappears leaves focus where the member put it", async () => {
		// The uninstall is somebody else's action arriving on a live query. The member never asked for
		// it and may be typing elsewhere on the screen by then, so it must not take their caret.
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();

		const PageComponent = Route.options.component as () => JSX.Element;
		const { rerender } = render(<PageComponent />);
		await act(async () => {});

		useQueryMock.mockReturnValue([]);
		await act(async () => {
			rerender(<PageComponent />);
		});

		expect(screen.getByRole("alert").textContent).toContain("This plugin page is not available.");
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	test("an error that clears without a Retry leaves focus where the member put it", async () => {
		// The error clears on its own whenever the frame key changes, and the key carries the version
		// of the plugin installed in this workspace. So an admin upgrading that installation to a
		// newer version clears the error with nobody pressing Retry. Publishing a version does not:
		// it writes a `plugins_versions` doc and touches no installation. The member may be typing
		// elsewhere by then, and taking their caret away would be wrong.
		let currentVersionId = "version_1";
		useQueryMock.mockImplementation(() => {
			const uiPages = createUiPages();
			uiPages[0].pluginVersionId = currentVersionId;
			return uiPages;
		});
		// The mint has to follow the version the query returns. A mint still answering the old id
		// would stop the fresh frame with a version mismatch, the error would never clear, and the
		// test would prove nothing.
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? Promise.resolve({
						_yay: {
							token: "plu_1",
							expiresAt: Date.now() + 60_000,
							pluginVersionId: currentVersionId,
							sessionId: "session_1",
						},
					})
				: Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		const { iframe } = bridge_for(container);

		// A second load means the frame navigated itself, so the host stops it and offers Retry.
		fireEvent.load(iframe);
		fireEvent.load(iframe);
		const retry = screen.getByRole("button", { name: "Retry" });
		await waitFor(() => expect(document.activeElement).toBe(retry));

		// The member gives up on the plugin page and goes back to typing somewhere else.
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();
		expect(document.activeElement).toBe(outside);

		// A new version is installed, so the key changes and the error goes away by itself.
		currentVersionId = "version_2";
		await act(async () => {
			rerender(<PageComponent />);
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	test("a Retry already handed over does not steal focus from the next error that clears itself", async () => {
		// Retry moves focus itself, before it asks for a new frame, so the press leaves nothing behind
		// for a later error to read. The test above never presses Retry. This one presses it, and then
		// puts the page through a second error and an upgrade that clears that error. Nothing must
		// pull the member's caret into the page region on that last step.
		let currentVersionId = "version_1";
		useQueryMock.mockImplementation(() => {
			const uiPages = createUiPages();
			uiPages[0].pluginVersionId = currentVersionId;
			return uiPages;
		});
		// Same trap as the test above: a mint still answering the old version id would stop the fresh
		// frame with a version mismatch, the error would never clear, and this would prove nothing.
		mutationMock.mockImplementation((reference: string) =>
			reference === "plugins_ui.mint_page_session"
				? Promise.resolve({
						_yay: {
							token: "plu_1",
							expiresAt: Date.now() + 60_000,
							pluginVersionId: currentVersionId,
							sessionId: "session_1",
						},
					})
				: Promise.resolve({ _yay: {} }),
		);

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container, rerender } = render(<PageComponent />);
		const firstIframe = bridge_for(container).iframe;

		// A second load means the frame navigated itself, so the host stops it and offers Retry.
		fireEvent.load(firstIframe);
		fireEvent.load(firstIframe);
		const retry = screen.getByRole("button", { name: "Retry" });
		await waitFor(() => expect(document.activeElement).toBe(retry));

		// The press hands focus to the page region while the button is still there.
		fireEvent.click(retry);
		const main = container.querySelector("main");
		await waitFor(() => expect(document.activeElement).toBe(main));

		// The new frame fails the same way, and focus goes back to its Retry button.
		const secondIframe = bridge_for(container).iframe;
		fireEvent.load(secondIframe);
		fireEvent.load(secondIframe);
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" })));

		// This time the member gives up and goes back to typing somewhere else.
		const outside = document.createElement("input");
		document.body.append(outside);
		outside.focus();

		// An admin upgrades this workspace to a newer version, so the key moves and the error clears
		// with nobody pressing Retry.
		currentVersionId = "version_2";
		await act(async () => {
			rerender(<PageComponent />);
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	test("a StrictMode mount revokes one of its two sessions and assigns src once", async () => {
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
		const setAttributeSpy = vi.spyOn(HTMLIFrameElement.prototype, "setAttribute");

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(
			<StrictMode>
				<PageComponent />
			</StrictMode>,
		);
		await act(async () => {});

		// StrictMode runs the mount effect twice, so both runs mint. The first run's cleanup revokes
		// nothing: the session id is assigned inside the mint's `then`, and the cleanup runs before
		// that microtask, so it has a null id and returns straight away. The revoke comes from the
		// first mint itself. It resolves after its own run was cancelled, sees that the frame moved
		// on, and revokes the session it just minted. So the frame is left holding exactly one.
		expect(mintCount).toBe(2);
		const revoked = mutationMock.mock.calls.filter(([reference]) => reference === "plugins_ui.revoke_ui_session");
		expect(revoked).toHaveLength(1);
		expect(revoked[0][1]).toEqual({ membershipId: "membership_1", sessionId: "session_1" });

		// The second run must not re-assign the same src: that would reload the frame and throw away
		// the page the member is already looking at.
		const srcWrites = setAttributeSpy.mock.calls.filter(([name]) => name === "src");
		expect(srcWrites).toHaveLength(1);
		expect(srcWrites[0][1]).toBe(bridge_for(container).iframe.getAttribute("src"));
	});

	test("onStarted fires once however many ready messages the frame sends", async () => {
		const onStarted = vi.fn();
		const viewProps = {
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
			onStarted,
			onError: () => {},
		} as unknown as ComponentProps<typeof PluginsUiFrame>;

		const view = render(<PluginsUiFrame {...viewProps} />);
		const { nonce } = bridge_for(view.container);
		// The handshake is only finished once init goes out, and init waits for the frame to say ready.
		expect(onStarted).not.toHaveBeenCalled();

		await act(async () => post_ready(nonce));
		expect(onStarted).toHaveBeenCalledTimes(1);

		// The SDK keeps sending ready every 500 ms until an init reaches it, and the host answers each
		// one with the same init. So without the once-per-mount rule the caller would be told the
		// frame started again for every repeat that raced the first init.
		await act(async () => post_ready(nonce));
		expect(onStarted).toHaveBeenCalledTimes(1);
	});

	test("a frame whose mint is refused reports the error and never says it started", async () => {
		const onStarted = vi.fn();
		const onError = vi.fn();
		const viewProps = {
			membershipId: "membership_1",
			pluginName: "gallery",
			pluginVersionId: "version_1",
			entry: "dist/frontend/view.html",
			title: "Viewer",
			kindLabel: "plugin view",
			mintSession: () => Promise.resolve({ _nay: { message: "Unauthorized" } }),
			getInitContext: () => ({
				kind: "file_view",
				pluginName: "gallery",
				fileViewId: "viewer",
				fileViewTitle: "Viewer",
				organizationId: "org_1",
				workspaceId: "ws_1",
				file: { fileNodeId: "node_1", name: "a.png", path: "/a.png", contentType: "image/png" },
			}),
			onStarted,
			onError,
		} as unknown as ComponentProps<typeof PluginsUiFrame>;

		const view = render(<PluginsUiFrame {...viewProps} />);
		await act(async () => post_ready(bridge_for(view.container).nonce));

		// There is no handshake to finish, so the caller hears the error and nothing else. A mount
		// point that took its placeholder down here would leave the member watching an iframe that is
		// never going to paint.
		expect(onError).toHaveBeenCalledWith("Unauthorized");
		expect(onStarted).not.toHaveBeenCalled();
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

	test("a frame key change revokes the old session and mints exactly one new one", async () => {
		// `FileNodeViewPluginView` puts `node._id` in the frame key, so opening a second file
		// remounts the frame. Without that segment the member would keep looking at a frame holding
		// the first file's session while the tab says they opened the second file. The component is
		// module-private and its parent needs the whole /files editor stack, so the key itself is
		// covered in the browser (see plugin-marketplace.md, 2026-09-04); this pins what the key
		// buys: a remount revokes the old session and mints exactly one new one.
		let mintCount = 0;
		const props_for = (fileNodeId: string) =>
			({
				membershipId: "membership_1",
				pluginName: "gallery",
				pluginVersionId: "version_1",
				entry: "dist/frontend/view.html",
				title: "Viewer",
				kindLabel: "plugin view",
				mintSession: () => {
					mintCount += 1;
					return Promise.resolve({
						_yay: {
							token: `plu_${mintCount}`,
							expiresAt: Date.now() + 60_000,
							pluginVersionId: "version_1",
							sessionId: `session_${mintCount}`,
						},
					});
				},
				getInitContext: () => ({
					kind: "file_view",
					pluginName: "gallery",
					fileViewId: "viewer",
					fileViewTitle: "Viewer",
					organizationId: "org_1",
					workspaceId: "ws_1",
					file: { fileNodeId, name: "a.mp4", path: `/${fileNodeId}.mp4`, contentType: "video/mp4" },
				}),
				onError: () => {},
			}) as unknown as ComponentProps<typeof PluginsUiFrame>;

		const view = render(<PluginsUiFrame key="node_1" {...props_for("node_1")} />);
		const firstBridge = bridge_for(view.container);
		await act(async () => post_ready(firstBridge.nonce));
		expect(latest_init_message().context).toMatchObject({ file: { fileNodeId: "node_1" } });

		// A different node id is a different key, so React unmounts the first frame and mounts a new one.
		view.rerender(<PluginsUiFrame key="node_2" {...props_for("node_2")} />);
		const secondBridge = bridge_for(view.container);
		await act(async () => post_ready(secondBridge.nonce));

		expect(secondBridge.nonce).not.toBe(firstBridge.nonce);
		expect(mintCount).toBe(2);
		expect(mutationMock).toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_1",
		});
		expect(mutationMock).not.toHaveBeenCalledWith("plugins_ui.revoke_ui_session", {
			membershipId: "membership_1",
			sessionId: "session_2",
		});
		expect(latest_init_message().context).toMatchObject({ file: { fileNodeId: "node_2" } });
	});

	test("a context missing a field the SDK requires is a compile error", () => {
		// The SDK drops an init whose context misses a field and says nothing about why, and the
		// host does not notice either: `handle_ready` clears the startup deadline the moment it
		// posts init, so that deadline can never fire for a context the SDK later rejects. The SDK
		// stops its ready loop in two places: when an init passes its context check, and when the page
		// goes away, through its `pagehide` listener. A rejected context reaches neither, and the page
		// is still open, so the loop keeps running every 500 ms. The 65th ready lands at about 32
		// seconds and takes the flood branch, and the member is told the page "flooded the bridge and
		// was stopped" — a message that blames the plugin for a context this host built wrong. So the
		// mount points have to fail here instead.
		//
		// Each `@ts-expect-error` below is the assertion: `lint:tsc` fails on an unused directive, so
		// a contract that stops rejecting one of these cases fails the type-check on that line.
		type InitContext = ReturnType<PluginsUiFrame_Props["getInitContext"]>;
		const accept = (context: InitContext) => context.kind;

		expect(
			accept({
				kind: "page",
				pluginName: "gallery",
				pageId: "media",
				pageTitle: "Media",
				organizationId: "org_1",
				workspaceId: "ws_1",
			}),
		).toBe("page");

		const pageWithoutTitle = {
			kind: "page" as const,
			pluginName: "gallery",
			pageId: "media",
			organizationId: "org_1",
			workspaceId: "ws_1",
		};
		// @ts-expect-error a page context with no pageTitle is not a valid init context
		accept(pageWithoutTitle);

		const fileViewWithoutFile = {
			kind: "file_view" as const,
			pluginName: "gallery",
			fileViewId: "viewer",
			fileViewTitle: "Viewer",
			organizationId: "org_1",
			workspaceId: "ws_1",
		};
		// @ts-expect-error a file-view context with no file block is not a valid init context
		accept(fileViewWithoutFile);

		const pageFieldsUnderFileViewKind = {
			kind: "file_view" as const,
			pluginName: "gallery",
			pageId: "media",
			pageTitle: "Media",
			organizationId: "org_1",
			workspaceId: "ws_1",
		};
		// @ts-expect-error the two kinds do not share their fields
		accept(pageFieldsUnderFileViewKind);
	});

	// #region dev-only bundle override

	const OVERRIDE_ORIGIN = "http://localhost:5174";

	/**
	 * Points the override at `version_1`, the id every fixture in this file mints.
	 */
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
