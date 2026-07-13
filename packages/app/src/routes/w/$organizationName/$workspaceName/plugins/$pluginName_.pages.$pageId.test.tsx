/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"happyDOM": {"settings": {"disableIframePageLoading": true}}}
 *
 * Iframe page loading is disabled so happy-dom never fetches the real CONVEX_HTTP_URL asset.
 * With it disabled `iframe.contentWindow` is null, and a MessageEvent dispatched without a
 * source (null) still satisfies the route's `event.source === contentWindow` guard.
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
	// Must forward ref to a native button: the route moves focus to Retry through this ref.
	MyButton: function MyButton(props: { ref?: Ref<HTMLButtonElement>; children?: ReactNode; onClick?: () => void }) {
		return (
			<button type="button" ref={props.ref} onClick={props.onClick}>
				{props.children}
			</button>
		);
	},
}));

import { plugins_UI_PAGES_PROTOCOL_VERSION } from "../../../../../../shared/plugins.ts";

import { Route } from "./$pluginName_.pages.$pageId.tsx";

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

describe("RoutePluginsPluginPage", () => {
	beforeEach(() => {
		paramsMock.mockReturnValue({ pluginName: "gallery", pageId: "media" });
		tenantContextMock.mockReturnValue({
			membershipId: "membership_1",
			organizationId: "org_1",
			workspaceId: "ws_1",
		});
		useQueryMock.mockReturnValue(createUiPages());
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	test("mint failure replaces the page with an alert and moves focus to Retry", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Unauthorized" } });

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const iframe = container.querySelector("iframe");
		expect(iframe).not.toBeNull();

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", protocolVersion: plugins_UI_PAGES_PROTOCOL_VERSION },
					source: iframe?.contentWindow,
				}),
			);
		});

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

		act(() => {
			vi.advanceTimersByTime(15_000);
		});

		expect(screen.getByRole("alert").textContent).toContain("The plugin page did not start in time");
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(document.activeElement).toBe(retry);
	});

	test("a ready message from a foreign source neither mints nor errors", async () => {
		mutationMock.mockResolvedValue({ _nay: { message: "Unauthorized" } });

		const PageComponent = Route.options.component as () => JSX.Element;
		render(<PageComponent />);

		// source: window mismatches the iframe contentWindow (null here), so the bridge drops it.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", protocolVersion: plugins_UI_PAGES_PROTOCOL_VERSION },
					source: window,
				}),
			);
		});

		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	test("a successful startup clears the deadline", async () => {
		vi.useFakeTimers();
		mutationMock.mockResolvedValue({
			_yay: { token: "plu_token", expiresAt: Date.now() + 60_000, pluginVersionId: "version_1" },
		});

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);
		const iframe = container.querySelector("iframe");

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "bonobo:ready", protocolVersion: plugins_UI_PAGES_PROTOCOL_VERSION },
					source: iframe?.contentWindow,
				}),
			);
		});

		act(() => {
			vi.advanceTimersByTime(15_000);
		});

		expect(screen.queryByRole("alert")).toBeNull();
		expect(container.querySelector("iframe")).not.toBeNull();
	});

	test("Retry clears the error, remounts the iframe, and re-arms the deadline", () => {
		vi.useFakeTimers();

		const PageComponent = Route.options.component as () => JSX.Element;
		const { container } = render(<PageComponent />);

		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(screen.getByRole("alert")).not.toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(container.querySelector("iframe")).not.toBeNull();

		// A second full deadline shows the retried attempt started its own timer (this fails if
		// the bridge effect does not re-run when the attempt counter changes).
		act(() => {
			vi.advanceTimersByTime(15_000);
		});
		expect(screen.getByRole("alert").textContent).toContain("The plugin page did not start in time");
	});
});
