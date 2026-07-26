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
					message: "The API responded with an error",
					data: Response.json({ message: "Invalid token" }, { status: 401 }),
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

	test.each([
		[
			"is rate limited",
			{
				message: "The API responded with an error",
				data: Response.json({ message: "Rate limit exceeded", retryAfterMs: 10_000 }, { status: 429 }),
			},
		],
		[
			"hits a server error",
			{
				message: "The API responded with an error",
				data: Response.json({ message: "Internal server error" }, { status: 500 }),
			},
		],
		["cannot reach the server", { message: "Failed to fetch" }],
	])("keeps the cached anonymous session when the refresh %s", async (_label, nay) => {
		window.localStorage.setItem("app::auth::anonymous_token", "cached-token");
		window.localStorage.setItem("app::auth::anonymous_token_user_id", "cached-user");

		// A failure that is not a rejection must never mint a new user. The new user gets its own
		// seeded `personal`/`home`, so the cached user's files stay in the database with no
		// reachable address and the app looks wiped.
		appFetchAuthAnonymousMock.mockResolvedValue({ _nay: nay });

		render(
			<AppAuthProvider>
				<AuthProbe />
			</AppAuthProvider>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("is-loaded").textContent).toBe("true");
			expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
			expect(screen.getByTestId("user-id").textContent).toBe("cached-user");
		});

		// Every call must carry the cached token. A call without one is the create path.
		expect(appFetchAuthAnonymousMock).toHaveBeenCalledWith({ token: "cached-token" });
		expect(appFetchAuthAnonymousMock.mock.calls.every((call) => call[0]?.token === "cached-token")).toBe(true);
		expect(window.localStorage.getItem("app::auth::anonymous_token")).toBe("cached-token");
		expect(window.localStorage.getItem("app::auth::anonymous_token_user_id")).toBe("cached-user");
	});
});
