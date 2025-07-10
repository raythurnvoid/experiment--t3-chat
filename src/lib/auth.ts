import { useAuth as useClerkAuth } from "@clerk/clerk-react";

interface AuthTokenManager {
	isAuthenticated: () => boolean;
	getToken: () => Promise<string | null>;
}

/**
 * Callers of `auth_get_token` will wait until the `auth_token_manager.promise` is resolved.
 *
 * Once resolved the token refreshed will replace the promise to
 * ensure new calls to `auth_get_token` will return the new token.
 */
let auth_token_manager = init_auth_token_manager();

function init_auth_token_manager() {
	const obj = Object.assign(Promise.withResolvers<AuthTokenManager>(), {
		// Track if the token manager is set
		resolved: false,
	});

	obj.promise.then((result) => {
		obj.resolved = true;
		return result;
	});

	return obj;
}

export function auth_get_token_manager_token() {
	return auth_token_manager.promise.then((manager) => manager.getToken());
}

export function auth_get_token_manager_is_authenticated() {
	return auth_token_manager.promise.then((manager) => manager.isAuthenticated);
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
