import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ErrorComponentProps } from "@tanstack/react-router";

const { useAuthMock, useConvexAuthMock, useQueryMock, routerState } = vi.hoisted(() => {
	return {
		useAuthMock: vi.fn(),
		useConvexAuthMock: vi.fn(),
		useQueryMock: vi.fn(),
		// The router's own pathname, with no base path. `useRouterState` and `app_router()` both read it.
		routerState: { location: { pathname: "/" } },
	};
});

vi.mock("@tanstack/react-router", () => ({
	Outlet: function Outlet() {
		return <div>App ready</div>;
	},
	DefaultGlobalNotFound: function DefaultGlobalNotFound() {
		return <div>Not Found</div>;
	},
	createRootRoute: (options: unknown) => ({ options }),
	useRouterState: (options: { select: (state: typeof routerState) => unknown }) => options.select(routerState),
}));

vi.mock("../lib/app-router.ts", () => ({
	app_router: () => ({ state: routerState }),
}));

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();

	return {
		...actual,
		useConvexAuth: () => useConvexAuthMock(),
		useQuery: (query: unknown) => useQueryMock(query),
	};
});

vi.mock("../components/app-auth.tsx", () => ({
	AppAuthProvider: {
		useAuth: () => useAuthMock(),
	},
}));

vi.mock("../components/logo.tsx", () => ({
	Logo: function Logo() {
		return <div>Logo</div>;
	},
}));

vi.mock("../components/my-spinner.tsx", () => ({
	MySpinner: function MySpinner() {
		return <div>Spinner</div>;
	},
}));

vi.mock("../components/app-tanstack-router-dev-tools.tsx", () => ({
	AppTanStackRouterDevTools: function AppTanStackRouterDevTools() {
		return null;
	},
}));

vi.mock("../components/app-route-error.tsx", () => ({
	AppRouteError: function AppRouteError() {
		return <div>App route error</div>;
	},
}));

// RootLayoutInner wraps Outlet in PluginsPublishSessionProvider. The real provider pulls in
// modals and Convex helpers that this root shell test does not need. Render children only.
vi.mock("../components/plugins-publish-session.tsx", () => ({
	PluginsPublishSessionProvider: function PluginsPublishSessionProvider(props: { children: ReactNode }) {
		return props.children;
	},
}));

import { app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";

import { Route } from "./__root.tsx";

function createSubscription() {
	return {
		id: "sub_free",
		productId: "prod_free",
		status: "active",
		cancelAtPeriodEnd: false,
		currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: null,
		pendingUpdate: null,
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>>;
}

function createUsageSnapshot(args?: {
	subscriptionId?: string | null;
	productId?: string;
	polarCustomerId?: string | null;
	meter?: null;
	meterId?: string | null;
}) {
	return {
		userId: "user_free",
		polarCustomerId: args && "polarCustomerId" in args ? args.polarCustomerId : "cust_free",
		subscription: {
			id: args && "subscriptionId" in args ? args.subscriptionId : "sub_free",
			productId: args?.productId ?? "prod_free",
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter:
			args?.meter === null
				? null
				: {
						id: args && "meterId" in args ? args.meterId : "meter_press_usage",
						consumedUnits: 100,
						creditedUnits: 1000,
						balance: 900,
						amountDueCents: 0,
					},
		lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>>;
}

function mockBillingQueries(args: {
	subscription: app_convex_FunctionReturnType<typeof app_convex_api.billing.get_current_user_subscription>;
	billingUsageSnapshot: app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot> | undefined;
}) {
	const queryResults = [args.subscription, args.billingUsageSnapshot];
	let callIndex = 0;
	useQueryMock.mockImplementation(() => {
		const result = queryResults[callIndex % queryResults.length];
		callIndex += 1;
		return result;
	});
}

describe("RootLayout", () => {
	beforeEach(() => {
		routerState.location.pathname = "/";
		useAuthMock.mockReset();
		useConvexAuthMock.mockReset();
		useQueryMock.mockReset();

		useAuthMock.mockReturnValue({
			isLoaded: true,
			isAuthenticated: true,
			isAnonymous: false,
			userId: "user_free",
		});
		useConvexAuthMock.mockReturnValue({
			isLoading: false,
			isAuthenticated: true,
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("keeps the startup shell visible while billing bootstrap is still missing usage", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: null,
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("Preparing organization")).not.toBeNull();
		expect(screen.getByText(/billing setup/)).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("keeps the startup shell visible while the usage snapshot belongs to another subscription", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot({
				subscriptionId: "sub_other",
				productId: "prod_other",
			}),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("Preparing organization")).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("keeps the startup shell visible while the usage snapshot has a null subscription id", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot({
				subscriptionId: null,
				polarCustomerId: null,
				meterId: null,
			}),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("Preparing organization")).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("does not wait for usage when there is no active subscription", () => {
		mockBillingQueries({
			subscription: null,
			billingUsageSnapshot: undefined,
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(screen.queryByText("Preparing organization")).toBeNull();
	});

	test("renders the app once the active subscription usage snapshot is ready", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot(),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(screen.queryByText("Preparing organization")).toBeNull();
	});

	test("renders the app once a Free subscription snapshot is ready without a meter", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot({ meter: null }),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(screen.queryByText("Preparing organization")).toBeNull();
	});
});

describe("RootLayout on the share page", () => {
	const shareErrorProps = { error: new Error("secret-token-abc"), reset: () => {} } as unknown as ErrorComponentProps;

	beforeEach(() => {
		routerState.location.pathname = "/share/abc123";
		useAuthMock.mockReset();
		useConvexAuthMock.mockReset();
		useQueryMock.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		document.documentElement.removeAttribute("data-app-ready");
	});

	test("renders the route without any private auth or billing hook", () => {
		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(useAuthMock).not.toHaveBeenCalled();
		expect(useConvexAuthMock).not.toHaveBeenCalled();
		expect(useQueryMock).not.toHaveBeenCalled();
		expect(document.documentElement.hasAttribute("data-app-ready")).toBe(false);
	});

	test("shows the generic share message for an error, without its details", () => {
		const RootRouteError = Route.options.errorComponent as (props: ErrorComponentProps) => JSX.Element;
		const { container } = render(<RootRouteError {...shareErrorProps} />);

		expect(screen.getByText("This link does not work.")).not.toBeNull();
		expect(screen.queryByText("App route error")).toBeNull();
		expect(container.textContent).not.toContain("secret-token-abc");
		expect(useAuthMock).not.toHaveBeenCalled();
	});

	test("shows the generic share message for an unknown path under the share prefix", () => {
		routerState.location.pathname = "/SHARE/abc123/extra";
		const RootRouteNotFound = Route.options.notFoundComponent as () => JSX.Element;
		render(<RootRouteNotFound />);

		expect(screen.getByText("This link does not work.")).not.toBeNull();
		expect(screen.queryByText("Not Found")).toBeNull();
	});

	test("keeps the app error and not-found pages for other paths", () => {
		routerState.location.pathname = "/share-other";
		const RootRouteError = Route.options.errorComponent as (props: ErrorComponentProps) => JSX.Element;
		const RootRouteNotFound = Route.options.notFoundComponent as () => JSX.Element;
		render(
			<>
				<RootRouteError {...shareErrorProps} />
				<RootRouteNotFound />
			</>,
		);

		expect(screen.getByText("App route error")).not.toBeNull();
		expect(screen.getByText("Not Found")).not.toBeNull();
		expect(screen.queryByText("This link does not work.")).toBeNull();
	});

	test("logs no error for the share page, and still logs it for the app", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const onCatch = Route.options.onCatch as (error: unknown) => void;

		// The log runs after a lazy import of the router. Let it finish before the path changes.
		onCatch(new Error("secret-token-abc"));
		await import("../lib/app-router.ts");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(consoleError).not.toHaveBeenCalled();

		routerState.location.pathname = "/w/acme/main/files";
		onCatch(new Error("app failure"));
		await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
		expect(consoleError.mock.calls[0]?.[1]).toEqual({ args: new Error("app failure") });
	});
});
