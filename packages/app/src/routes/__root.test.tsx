import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mockQueryResults, useAuthMock, useConvexAuthMock } = vi.hoisted(() => {
	return {
		mockQueryResults: [] as unknown[],
		useAuthMock: vi.fn(),
		useConvexAuthMock: vi.fn(),
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
		useQuery: () => mockQueryResults.shift(),
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

function createUsageSnapshot(args?: { subscriptionId?: string; productId?: string }) {
	return {
		userId: "user_free",
		polarCustomerId: "cust_free",
		subscription: {
			id: args?.subscriptionId ?? "sub_free",
			productId: args?.productId ?? "prod_free",
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		},
		meter: {
			id: "meter_press_usage",
			consumedUnits: 100,
			creditedUnits: 1000,
			balance: 900,
			amountDueCents: 0,
		},
		lastSyncedAt: Date.parse("2026-01-15T00:00:00.000Z"),
	} as NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>>;
}

describe("RootLayout", () => {
	beforeEach(() => {
		mockQueryResults.length = 0;
		useAuthMock.mockReset();
		useConvexAuthMock.mockReset();

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
		mockQueryResults.length = 0;
		vi.clearAllMocks();
	});

	test("keeps the startup shell visible while billing bootstrap is still missing usage", () => {
		mockQueryResults.push(createSubscription(), null);

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("Preparing workspace")).not.toBeNull();
		expect(screen.getByText(/billing setup/)).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("keeps the startup shell visible while the usage snapshot belongs to another subscription", () => {
		mockQueryResults.push(
			createSubscription(),
			createUsageSnapshot({
				subscriptionId: "sub_other",
				productId: "prod_other",
			}),
		);

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("Preparing workspace")).not.toBeNull();
		expect(screen.queryByText("App ready")).toBeNull();
	});

	test("does not wait for usage when there is no active subscription", () => {
		mockQueryResults.push(null, undefined);

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(screen.queryByText("Preparing workspace")).toBeNull();
	});

	test("renders the app once the active subscription usage snapshot is ready", () => {
		mockQueryResults.push(createSubscription(), createUsageSnapshot());

		const RootLayout = Route.options.component as () => JSX.Element;
		render(<RootLayout />);

		expect(screen.getByText("App ready")).not.toBeNull();
		expect(screen.queryByText("Preparing workspace")).toBeNull();
	});
});
