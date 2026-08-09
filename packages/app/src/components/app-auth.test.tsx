import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
						token: "fresh-access-token",
						refreshToken: "fresh-refresh-token",
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

		expect(appFetchAuthAnonymousMock).toHaveBeenNthCalledWith(1, { refreshToken: "stale-token" });
		expect(appFetchAuthAnonymousMock).toHaveBeenNthCalledWith(2);
		// Storage holds the refresh token; the access token stays in memory only.
		expect(window.localStorage.getItem("app::auth::anonymous_token")).toBe("fresh-refresh-token");
		expect(window.localStorage.getItem("app::auth::anonymous_token_user_id")).toBe("fresh-user");
	});

	test.each([
		[
			"is rate limited",
			() => ({
				message: "The API responded with an error",
				data: Response.json({ message: "Rate limit exceeded", retryAfterMs: 10_000 }, { status: 429 }),
			}),
		],
		[
			"hits a server error",
			() => ({
				message: "The API responded with an error",
				data: Response.json({ message: "Internal server error" }, { status: 500 }),
			}),
		],
		["cannot reach the server", () => ({ message: "Failed to fetch" })],
	])("keeps the cached refresh token and retries when the refresh %s", async (_label, makeNay) => {
		vi.useFakeTimers();
		try {
			window.localStorage.setItem("app::auth::anonymous_token", "cached-token");
			window.localStorage.setItem("app::auth::anonymous_token_user_id", "cached-user");

			// A transient failure must never mint a new user (its seeded `personal`/`home` would
			// hide the cached user's files) and must never resolve null (the Convex client treats
			// null as signed out for good). The only correct move is to keep retrying.
			appFetchAuthAnonymousMock
				.mockResolvedValueOnce({ _nay: makeNay() })
				.mockResolvedValueOnce({ _nay: makeNay() })
				.mockResolvedValue({
					_yay: {
						payload: {
							token: "fresh-access-token",
							refreshToken: "cached-token",
							userId: "cached-user",
						},
					},
				});

			render(
				<AppAuthProvider>
					<AuthProbe />
				</AppAuthProvider>,
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			// While retrying, no new user is minted and the storage is untouched.
			expect(appFetchAuthAnonymousMock).toHaveBeenCalledTimes(1);
			expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
			expect(window.localStorage.getItem("app::auth::anonymous_token")).toBe("cached-token");

			// Every wait (the 10s `retryAfterMs` and the exponential backoff) stays under the 30s
			// cap, so one 60s advance runs both remaining attempts.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(appFetchAuthAnonymousMock).toHaveBeenCalledTimes(3);

			expect(screen.getByTestId("is-loaded").textContent).toBe("true");
			expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
			expect(screen.getByTestId("user-id").textContent).toBe("cached-user");

			// Every call must carry the cached refresh token. A call without one is the create path.
			expect(appFetchAuthAnonymousMock.mock.calls.every((call) => call[0]?.refreshToken === "cached-token")).toBe(
				true,
			);
			expect(window.localStorage.getItem("app::auth::anonymous_token")).toBe("cached-token");
			expect(window.localStorage.getItem("app::auth::anonymous_token_user_id")).toBe("cached-user");
		} finally {
			vi.useRealTimers();
		}
	});

	test("honors the server's retryAfterMs before retrying after a 429", async () => {
		vi.useFakeTimers();
		try {
			window.localStorage.setItem("app::auth::anonymous_token", "cached-token");
			window.localStorage.setItem("app::auth::anonymous_token_user_id", "cached-user");

			appFetchAuthAnonymousMock
				.mockResolvedValueOnce({
					_nay: {
						message: "The API responded with an error",
						data: Response.json({ message: "Rate limit exceeded", retryAfterMs: 10_000 }, { status: 429 }),
					},
				})
				.mockResolvedValue({
					_yay: {
						payload: {
							token: "fresh-access-token",
							refreshToken: "cached-token",
							userId: "cached-user",
						},
					},
				});

			render(
				<AppAuthProvider>
					<AuthProbe />
				</AppAuthProvider>,
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(appFetchAuthAnonymousMock).toHaveBeenCalledTimes(1);

			// One millisecond short of the server's answer: still waiting.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(9_999);
			});
			expect(appFetchAuthAnonymousMock).toHaveBeenCalledTimes(1);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(appFetchAuthAnonymousMock).toHaveBeenCalledTimes(2);

			expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
			expect(screen.getByTestId("user-id").textContent).toBe("cached-user");
		} finally {
			vi.useRealTimers();
		}
	});
});
