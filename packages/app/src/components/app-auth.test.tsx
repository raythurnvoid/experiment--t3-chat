import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { appFetchAuthAnonymousMock, appFetchAuthResolveUserMock, useAuthMock } = vi.hoisted(() => ({
	appFetchAuthAnonymousMock: vi.fn(),
	appFetchAuthResolveUserMock: vi.fn(),
	useAuthMock: vi.fn(),
}));

vi.mock("@clerk/clerk-react", () => ({
	useAuth: () => useAuthMock(),
}));

vi.mock("../lib/fetch.ts", () => ({
	app_fetch_auth_anonymous: appFetchAuthAnonymousMock,
	app_fetch_auth_resolve_user: appFetchAuthResolveUserMock,
}));

vi.mock("../lib/app-router.ts", () => ({
	app_router: () => ({
		navigate: vi.fn(),
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
	},
}));

import { AppAuthProvider } from "./app-auth.tsx";

function AuthProbe() {
	const auth = AppAuthProvider.useAuth();

	return (
		<div>
			<div data-testid="is-loaded">{String(auth.isLoaded)}</div>
			<div data-testid="is-authenticated">{String(auth.isAuthenticated)}</div>
			<div data-testid="user-id">{auth.userId}</div>
		</div>
	);
}

describe("AppAuthProvider anonymous auth", () => {
	beforeEach(() => {
		window.localStorage.clear();
		appFetchAuthAnonymousMock.mockReset();
		appFetchAuthResolveUserMock.mockReset();
		useAuthMock.mockReturnValue({
			getToken: vi.fn(),
			isLoaded: true,
			isSignedIn: false,
			signOut: vi.fn(),
		});
	});

	afterEach(() => {
		cleanup();
		window.localStorage.clear();
		vi.clearAllMocks();
	});

	test("clears stale anonymous storage and creates a fresh anonymous session before loading", async () => {
		window.localStorage.setItem("app::auth::anonymous_token", "stale-token");
		window.localStorage.setItem("app::auth::anonymous_token_user_id", "stale-user");

		appFetchAuthAnonymousMock
			.mockResolvedValueOnce({
				_nay: {
					message: "Invalid token",
				},
			})
			.mockResolvedValueOnce({
				_yay: {
					payload: {
						token: "fresh-token",
						userId: "fresh-user",
					},
				},
			});

		render(
			<AppAuthProvider>
				<AuthProbe />
			</AppAuthProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("is-loaded").textContent).toBe("true");
			expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
			expect(screen.getByTestId("user-id").textContent).toBe("fresh-user");
		});

		expect(appFetchAuthAnonymousMock).toHaveBeenNthCalledWith(1, { token: "stale-token" });
		expect(appFetchAuthAnonymousMock).toHaveBeenNthCalledWith(2);
		expect(window.localStorage.getItem("app::auth::anonymous_token")).toBe("fresh-token");
		expect(window.localStorage.getItem("app::auth::anonymous_token_user_id")).toBe("fresh-user");
	});
});
