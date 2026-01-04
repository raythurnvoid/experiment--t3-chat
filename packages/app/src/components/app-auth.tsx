import { useAuth } from "@clerk/clerk-react";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Result } from "../lib/errors-as-values-utils.ts";
import { type app_convex_Id } from "../lib/app-convex-client.ts";
import { app_fetch_auth_anonymous, app_fetch_auth_resolve_user } from "../lib/fetch.ts";
import { storage_local } from "../lib/storage.ts";
import { create_deferred, delay } from "../lib/utils.ts";
import { useAsyncEffect, useStateRef } from "../hooks/utils-hooks.ts";

function jwt_read_payload_claim_string(jwt: string, key: string): string | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	const payloadB64 = parts[1]!;

	const padded = payloadB64
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(payloadB64.length / 4) * 4, "=");
	let json: string;
	try {
		json = atob(padded);
	} catch {
		return null;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(json) as unknown;
	} catch {
		return null;
	}

	if (!payload || typeof payload !== "object") return null;
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "string" && value ? value : null;
}

function storage_get_anonymous_token() {
	const token = storage_local().getItem("app::auth::anonymous_token");
	const userId = storage_local().getItem("app::auth::anonymous_token_user_id") as app_convex_Id<"users"> | null;
	if (!token || !userId) {
		return null;
	}

	return {
		token,
		userId,
	};
}

function storage_set_anonymous_token(tokenAndMeta: { token: string; userId: app_convex_Id<"users"> }): void {
	storage_local().setItem("app::auth::anonymous_token", tokenAndMeta.token);
	storage_local().setItem("app::auth::anonymous_token_user_id", tokenAndMeta.userId);
}

function storage_clear_anonymous_token(): void {
	storage_local().removeItem("app::auth::anonymous_token");
	storage_local().removeItem("app::auth::anonymous_token_user_id");
}

async function auth_get_anonymous_convex_token(args?: { skipCache?: boolean }) {
	const cached = storage_get_anonymous_token();

	if (!args?.skipCache) {
		if (cached) {
			return cached;
		}
	}

	// If skipCache is true and we have a cached token, try to refresh it first
	if (args?.skipCache && cached) {
		const refreshResult = await app_fetch_auth_anonymous({ token: cached.token });
		if (refreshResult._yay) {
			storage_set_anonymous_token({
				token: refreshResult._yay.payload.token,
				userId: refreshResult._yay.payload.userId,
			});
			return {
				token: refreshResult._yay.payload.token,
				userId: refreshResult._yay.payload.userId,
			};
		}
		// If refresh failed, fall through to create new user
	}

	// Create new anonymous user (either no cached token, or refresh failed)
	const fetchRresult = await app_fetch_auth_anonymous();
	if (fetchRresult._nay) {
		console.error("Failed to create anonymous user:", fetchRresult._nay);
		return null;
	}

	storage_set_anonymous_token({
		token: fetchRresult._yay.payload.token,
		userId: fetchRresult._yay.payload.userId,
	});
	return {
		token: fetchRresult._yay.payload.token,
		userId: fetchRresult._yay.payload.userId,
	};
}

type AnonymousTokenResult = string | null;
type AnonymousTokenDeferred = ReturnType<typeof create_deferred<AnonymousTokenResult>>;

/**
 * Single-source auth provider that wraps the app and provides auth state via context.
 *
 * Uses Clerk internally and manages anonymous token flow.
 */
interface AuthTokenManager {
	isAuthenticated: () => boolean;
	getToken: () => Promise<string | null>;
}

function init_auth_token_manager() {
	const auth_token_manager = Object.assign(Promise.withResolvers<AuthTokenManager>(), {
		// Track if the token manager is set
		resolved: false,
	});

	auth_token_manager.promise
		.then((manager) => {
			auth_token_manager.resolved = true;
			return manager;
		})
		.catch((error) => {
			auth_token_manager.reject(error);
		});

	return auth_token_manager;
}

/**
 * Callers of `auth_get_token` will wait until the `auth_token_manager.promise` is resolved.
 *
 * Once resolved the token refresher will replace the promise to
 * ensure new calls to `auth_get_token` will return the new token.
 */
let auth_token_manager = init_auth_token_manager();

export type AppAuthContextValue = {
	/** Either the Clerk user ID if signed in, or the anonymous user ID from the anonymous token */
	userId: string | null;
	/** Whether the user is using anonymous auth */
	isAnonymous: boolean | undefined;
	/** Whether auth is currently loading */
	isLoading: boolean;
	/** Whether auth has finished loading */
	isLoaded: boolean;
	/** Whether the user is authenticated (either via Clerk or anonymous) */
	isAuthenticated: boolean;
	/** Get auth token (Clerk JWT or anonymous token) */
	getToken: (options?: { skipCache?: boolean }) => Promise<string | null>;
	/** Same as `getToken` but in Convex auth format */
	fetchAccessToken: (options: { forceRefreshToken: boolean }) => Promise<string | null>;
};

const AppAuthContext = createContext<AppAuthContextValue | null>(null);

export type AppAuthProvider_Props = {
	children: ReactNode;
};

export function AppAuthProvider(props: AppAuthProvider_Props) {
	const { children } = props;

	const clerkAuth = useAuth();

	const authReadyDeferred = useRef(create_deferred<Result<{ _yay: null }>>());

	const anonymousTokenDeferredRef = useRef<AnonymousTokenDeferred | undefined>(undefined);

	const tokenFlowAbortControllerRef = useRef(new AbortController());

	const [authStatusRef, setAuthStatus, authStatus] = useStateRef<{
		isAnonymous: boolean | undefined;
		isLoading: boolean;
		isLoaded: boolean;
		isAuthenticated: boolean;
		userId: app_convex_Id<"users"> | null;
	}>({
		isAnonymous: undefined,
		isLoading: true,
		isLoaded: false,
		isAuthenticated: false,
		userId: null,
	});

	const [fetchAnonymousToken] = useState(() => (options?: { skipCache?: boolean }): Promise<string | null> => {
		const signal = tokenFlowAbortControllerRef.current.signal;

		// Force refresh: reset the deferred
		if (options?.skipCache) {
			anonymousTokenDeferredRef.current = undefined;
		}

		// Already have a deferred (pending or resolved) — return same promise
		if (anonymousTokenDeferredRef.current) {
			return anonymousTokenDeferredRef.current.promise;
		}

		// First call: create deferred and start fetch
		anonymousTokenDeferredRef.current = create_deferred<AnonymousTokenResult>();
		const deferred = anonymousTokenDeferredRef.current;

		auth_get_anonymous_convex_token({ skipCache: options?.skipCache })
			.then((result) => {
				if (result) {
					if (!signal.aborted) {
						setAuthStatus({
							isAnonymous: true,
							isLoading: false,
							isLoaded: true,
							isAuthenticated: true,
							userId: result.userId,
						});
					}

					deferred.resolve(result.token);
				} else {
					if (!signal.aborted) {
						// Treat a null result as a real failure.
						setAuthStatus({
							isAnonymous: true,
							isLoading: false,
							isLoaded: true,
							isAuthenticated: false,
							userId: null,
						});
					}

					console.error("AppAuthProvider.fetchAnonymousToken: Failed to fetch anonymous token");
					deferred.resolve(null);
				}
			})
			.catch((error) => {
				if (!signal.aborted) {
					setAuthStatus({
						isAnonymous: true,
						isLoading: false,
						isLoaded: true,
						isAuthenticated: false,
						userId: null,
					});
				}

				console.error("AppAuthProvider.fetchAnonymousToken: Error while fetching anonymous token", error);
				deferred.resolve(null);
			});

		return deferred.promise;
	});

	/**
	 * Fetch the token either from Clerk for signed in users or fetch a token for anonymous users.
	 *
	 * It always resolves and never rejects to ensure convex auth can transition to unauthenticated,
	 * the convex client only handle resolved promises.
	 */
	const [getToken] = useState(() => async (options?: { skipCache?: boolean }): Promise<string | null> => {
		const skipCache = options?.skipCache ?? false;

		try {
			await authReadyDeferred.current.promise;
		} catch (error) {
			console.error("AppAuthProvider.getToken: `authReadyDeferred` rejected", error);
			return null;
		}

		tokenFlowAbortControllerRef.current.abort();
		tokenFlowAbortControllerRef.current = new AbortController();

		if (!authStatusRef.current.isAnonymous) {
			try {
				return await clerkAuth.getToken({
					template: "convex",
					skipCache,
				});
			} catch (error) {
				console.error("AppAuthProvider.getToken: Clerk getToken failed", error);
				return null;
			}
		}

		try {
			return await fetchAnonymousToken(options);
		} catch (error) {
			console.error("AppAuthProvider.getToken: Failed to get anonymous user token", error);
			return null;
		}
	});

	const [fetchAccessToken] = useState(() => (options: { forceRefreshToken: boolean }) => {
		console.debug("AppAuthProvider.fetchAccessToken", options);
		return getToken({ skipCache: options.forceRefreshToken });
	});

	async function fetchClerkToken(args: { retryUntileUserIdIsSet: boolean; signal: AbortSignal }) {
		const maxAttempts = 20;
		const delayMs = 500;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// Add delay when retrying
			if (attempt > 1) {
				await delay(delayMs);
			}

			if (args.signal.aborted) return;

			const token = await clerkAuth.getToken({ template: "convex", skipCache: attempt > 1 }).catch((error) => {
				console.error("AppAuthProvider: Clerk getToken failed", error);
				return null;
			});

			if (args.signal.aborted) return;

			if (!token) continue;

			const userId = jwt_read_payload_claim_string(token, "external_id");

			if (userId && args.retryUntileUserIdIsSet) {
				return { userId, token };
			} else if (!args.retryUntileUserIdIsSet) {
				return { userId, token };
			}
		}
	}

	useAsyncEffect(
		async (signal) => {
			if (!clerkAuth.isLoaded) {
				return;
			}

			tokenFlowAbortControllerRef.current?.abort();
			tokenFlowAbortControllerRef.current = new AbortController();

			if (authReadyDeferred.current.status !== "pending") {
				authReadyDeferred.current.reset();
			}

			setAuthStatus((prev) => ({
				...prev,
				isAnonymous: false,
				isLoading: true,
				isLoaded: false,
				isAuthenticated: false,
				userId: null,
			}));

			// Post sign in resolution
			if (clerkAuth.isSignedIn) {
				do {
					const anonymousUserToken = storage_get_anonymous_token()?.token;
					let clerkTokenData = await fetchClerkToken({
						retryUntileUserIdIsSet: false,
						signal: tokenFlowAbortControllerRef.current.signal,
					});

					if (signal.aborted) return;

					const handleFatalSigninError = async (args: { toastMessage: string }) => {
						const message = "Signup/signin failed.";
						toast.error(message);
						await clerkAuth.signOut().catch((error) => {
							console.error("AppAuthProvider: Fatal: Clerk signOut failed", error);
							window.location.reload();
						});
					};

					const handleFatalMissingClerkTokenError = async () => {
						const message = "Signup/signin failed.";
						console.error(`AppAuthProvider: ${message} Failed to fetch Clerk token while signed in.`);
						await handleFatalSigninError({ toastMessage: message });
					};

					if (!clerkTokenData) {
						await handleFatalMissingClerkTokenError();
						break;
					}

					let userId = clerkTokenData.userId;

					if (!userId) {
						const resolveResult = await app_fetch_auth_resolve_user({
							token: clerkTokenData.token,
							anonymousUserToken,
						});

						if (resolveResult._nay) {
							const message = "Signup/signin failed.";
							console.error(`AppAuthProvider: ${message} resolve_user failed`, resolveResult._nay);
							await handleFatalSigninError({ toastMessage: message });
							break;
						}

						clerkTokenData = await fetchClerkToken({
							retryUntileUserIdIsSet: true,
							signal: tokenFlowAbortControllerRef.current.signal,
						});

						if (!clerkTokenData) {
							await handleFatalMissingClerkTokenError();
							break;
						}

						userId = clerkTokenData.userId;
					}

					if (!userId) {
						const message = "Signup/signin failed.";
						console.error(`AppAuthProvider: ${message} Missing \`external_id\` in Clerk token.`);
						await handleFatalSigninError({ toastMessage: message });
						break;
					}

					// Only clear anonymous token once we are sure we can run the app in Clerk mode.
					storage_clear_anonymous_token();
					setAuthStatus((prev) => ({
						...prev,
						isAnonymous: false,
						isLoading: false,
						isLoaded: true,
						isAuthenticated: true,
						userId: userId as app_convex_Id<"users">,
					}));
				} while (0);
			}

			if (authReadyDeferred.current.status === "pending") {
				authReadyDeferred.current.resolve(Result({ _yay: null }));
			}

			// Anonymous user flow
			if (!clerkAuth.isSignedIn) {
				// Start fetching anonymous token if not already in flight
				if (!anonymousTokenDeferredRef.current) void fetchAnonymousToken();
			}
		},
		[clerkAuth.isLoaded, clerkAuth.isSignedIn],
	);

	// Set token manager for Convex auth
	useEffect(() => {
		AppAuthProvider.setTokenManager({
			isAuthenticated: () => authStatusRef.current.isAuthenticated ?? false,
			getToken: () => getToken(),
		});
	});

	return (
		<AppAuthContext.Provider
			value={{
				userId: authStatus.userId,
				isAnonymous: authStatus.isAnonymous,
				isLoading: authStatus.isLoading,
				isLoaded: authStatus.isLoaded,
				isAuthenticated: authStatus.isAuthenticated,
				getToken,
				fetchAccessToken,
			}}
		>
			{children}
		</AppAuthContext.Provider>
	);
}

AppAuthProvider.getToken = () => {
	return auth_token_manager.promise.then((manager) => manager.getToken());
};

AppAuthProvider.getIsAuthenticated = () => {
	return auth_token_manager.promise.then((manager) => manager.isAuthenticated());
};

AppAuthProvider.setTokenManager = (manager: AuthTokenManager) => {
	// Replace the token manager if is already set
	if (auth_token_manager.resolved) {
		auth_token_manager = init_auth_token_manager();
	}

	// Set the token manager
	auth_token_manager.resolve(manager);
};

/**
 * Hook to consume auth state from `AppAuthProvider`.
 *
 * Must be used within `AppAuthProvider`.
 */
AppAuthProvider.useAuth = () => {
	const context = use(AppAuthContext);

	if (!context) {
		throw new Error("useAppAuth must be used within `AppAuthProvider`");
	}

	return context;
};

/**
 * Hook to consume auth state from `AppAuthProvider`, but only if authenticated.
 *
 * Throws an error if the user is not authenticated.
 *
 * Must be used within `AppAuthProvider` and guarded by `AppAuthProvider.useAuth().isAuthenticated`.
 */
AppAuthProvider.useAuthenticated = () => {
	const auth = AppAuthProvider.useAuth();

	if (!auth.isAuthenticated || !auth.userId) {
		throw new Error("useAuthenticated must be used when `AppAuthProvider.useAuth` returns `isAuthenticated = true`");
	}

	return {
		userId: auth.userId,
		isAnonymous: auth.isAnonymous,
	};
};
