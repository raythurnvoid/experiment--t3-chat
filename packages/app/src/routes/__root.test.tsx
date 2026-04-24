import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { useAuthMock, useConvexAuthMock, useQueryMock } = vi.hoisted(() => {
	return {
		useAuthMock: vi.fn(),
		useConvexAuthMock: vi.fn(),
		useQueryMock: vi.fn(),
	};
});

vi.mock("@tanstack/react-router", () => ({
	Outlet: function Outlet() {
		return <div>App ready</div>;
	},
	createRootRoute: (options: unknown) => ({ options }),
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
		return null;
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

		expect(screen.getByText("Preparing workspace")).not.toBeNull();
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

		expect(screen.getByText("Preparing workspace")).not.toBeNull();
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

		expect(screen.getByText("Preparing workspace")).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("does not wait for usage when there is no active subscription", () => {
		mockBillingQueries({
			subscription: null,
			billingUsageSnapshot: undefined,
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		const element = RootLayout();

		expect(typeof element.type).toBe("function");
		expect((element.type as { name?: string }).name).toBe("RootLayoutInner");
	});

	test("renders the app once the active subscription usage snapshot is ready", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot(),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		const element = RootLayout();

		expect(typeof element.type).toBe("function");
		expect((element.type as { name?: string }).name).toBe("RootLayoutInner");
	});

	test("renders the app once a Free subscription snapshot is ready without a meter", () => {
		mockBillingQueries({
			subscription: createSubscription(),
			billingUsageSnapshot: createUsageSnapshot({ meter: null }),
		});

		const RootLayout = Route.options.component as () => JSX.Element;
		const element = RootLayout();

		expect(typeof element.type).toBe("function");
		expect((element.type as { name?: string }).name).toBe("RootLayoutInner");
	});
});
