export const auth_ANONYMOUS_USER_ID = "anonymous";
export const auth_ANONYMOUS_ORG_ID = auth_ANONYMOUS_USER_ID;
export const auth_ANONYMOUS_WORKSPACE_ID = auth_ANONYMOUS_USER_ID;
export const auth_ANONYMOUSE_PROJECT_ID = auth_ANONYMOUS_USER_ID;

interface AuthTokenRetriever {
	isAuthenticated: boolean;
	getToken: () => Promise<string | null>;
}

/**
 * Callers of `auth_get_token` will wait until the `auth_token_retriever.promise` is resolved.
 *
 * Once resolved the token refreshed will replace the promise to
 * ensure new calls to `auth_get_token` will return the new token.
 */
let auth_token_retriever:
	| (PromiseWithResolvers<AuthTokenRetriever> & { resolved: boolean })
	| undefined = undefined;

function make_auth_token() {
	const obj = Object.assign(Promise.withResolvers<AuthTokenRetriever>(), {
		resolved: false,
	});

	obj.promise.then((result) => {
		obj.resolved = true;
		return result;
	});

	return obj;
}

export function auth_get_token(): Promise<string | null> {
	if (auth_token_retriever === undefined) {
		auth_token_retriever = make_auth_token();
	}

	return auth_token_retriever.promise.then((retriever) => {
		if (retriever.isAuthenticated) {
			return retriever.getToken();
		}

		return null;
	});
}

export function auth_set_token_retriever(retriever: AuthTokenRetriever) {
	if (auth_token_retriever === undefined || auth_token_retriever.resolved) {
		auth_token_retriever = make_auth_token();
	}

	auth_token_retriever.resolve(retriever);
}
