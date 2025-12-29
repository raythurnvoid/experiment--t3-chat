import { useAuth as useClerkAuth } from "@clerk/clerk-react";
import { useEffect, useEffectEvent, useRef } from "react";
import { Result } from "./errors-as-values-utils.ts";

interface AuthTokenManager {
	is_authenticated: () => boolean;
	get_token_for_convex: () => Promise<string | null>;
}

/**
 * Callers of `auth_get_token` will wait until the `auth_token_manager.promise` is resolved.
 *
 * Once resolved the token refreshed will replace the promise to
 * ensure new calls to `auth_get_token` will return the new token.
 */
let auth_token_manager = init_auth_token_manager();

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

export function auth_get_token() {
	return auth_token_manager.promise.then((manager) => manager.get_token_for_convex());
}

export function auth_get_is_authenticated() {
	return auth_token_manager.promise.then((manager) => manager.is_authenticated());
}

export function auth_set_token_manager(retriever: AuthTokenManager) {
	// Replace the token manager if is already set
	if (auth_token_manager.resolved) {
		auth_token_manager = init_auth_token_manager();
	}

	// Set the token manager
	auth_token_manager.resolve(retriever);
}

async function auth_get_anonymous_convex_token(args?: { skipCache?: boolean }) {
	// TODO: implement (custom-jwt flow). Must NOT require Clerk auth.
	// Return a JWT string or null on failure.
	return null;
}

export function useAuth() {
	const clerkAuth = useClerkAuth();

	const clerkAuthIsLoadedDeferred = useRef(
		Promise.withResolvers<
			| Result<{ _yay: null }>
			| Result<{ _nay: { name: "nay_abort"; message: "Clerk auth is not loaded after 10 seconds" } }>
		>(),
	);
	const clerkAuthIsLoadedTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		if (clerkAuth.isLoaded) {
			clerkAuthIsLoadedDeferred.current.resolve(Result({ _yay: null }));
		}
	}, [clerkAuth.isLoaded]);

	async function getToken(options?: { skipCache?: boolean }) {
		const clerkAuthIsLoadedResult = await clerkAuthIsLoadedDeferred.current.promise;

		if (clerkAuthIsLoadedResult._nay) {
			throw new Error(clerkAuthIsLoadedResult._nay.message);
		}

		let result;

		if (clerkAuth.isSignedIn) {
			result = await clerkAuth.getToken({
				template: "convex",
				skipCache: options?.skipCache,
			});
		} else {
			result = await auth_get_anonymous_convex_token({ skipCache: options?.skipCache });
		}

		return result;
	}

	/**
	 * Same as `getToken` but in convex auth format.
	 */
	function fetchAccessToken(options: { forceRefreshToken: boolean }) {
		return getToken({ skipCache: options.forceRefreshToken });
	}

	const handleMount = useEffectEvent(() => {
		clerkAuthIsLoadedTimeout.current = setTimeout(() => {
			clerkAuthIsLoadedDeferred.current.resolve(
				Result({ _nay: { name: "nay_abort", message: "Clerk auth is not loaded after 10 seconds" } }),
			);
		}, 10_000);

		return () => {
			if (clerkAuthIsLoadedTimeout.current) {
				clearTimeout(clerkAuthIsLoadedTimeout.current);
			}
		};
	});

	const handleClerkIsLoadedChange = useEffectEvent(() => {
		if (clerkAuth.isLoaded) {
			clerkAuthIsLoadedDeferred.current.resolve(Result({ _yay: null }));
			if (clerkAuthIsLoadedTimeout.current) {
				clearTimeout(clerkAuthIsLoadedTimeout.current);
			}
		}
	});

	useEffect(handleMount, []);
	useEffect(handleClerkIsLoadedChange, [clerkAuth.isLoaded]);

	return {
		userId: clerkAuth.userId,
		isAuthenticated: clerkAuth.isSignedIn,
		isLoading: !clerkAuth.isLoaded,
		isLoaded: clerkAuth.isLoaded,
		getToken,
		/**
		 * Same as `getToken` but in convex auth format.
		 */
		fetchAccessToken,
	};
}
