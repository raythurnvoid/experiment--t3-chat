import { useAuth as useClerkAuth } from "@clerk/clerk-react";

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
	return auth_token_manager.promise.then((manager) => manager.is_authenticated);
}

export function auth_set_token_manager(retriever: AuthTokenManager) {
	// Replace the token manager if is already set
	if (auth_token_manager.resolved) {
		auth_token_manager = init_auth_token_manager();
	}

	// Set the token manager
	auth_token_manager.resolve(retriever);
}

export function useAuth() {
	const clerk_auth = useClerkAuth();

	return {
		userId: clerk_auth.userId,
		isAuthenticated: clerk_auth.isSignedIn,
		isLoaded: clerk_auth.isLoaded,
		getToken: clerk_auth.getToken,
	};
}
