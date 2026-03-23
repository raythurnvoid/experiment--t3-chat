import { decodeJwt } from "jose";
import { should_never_happen } from "./shared-utils.ts";

const users_decode_jwt = ((/* iife */) => {
	function value(jwt: string) {
		return decodeJwt(jwt);
	}

	const cache = new Map<string, ReturnType<typeof value>>();

	return function users_decode_jwt(jwt: string) {
		const cached = cache.get(jwt);
		if (cached) {
			return cached;
		}

		const payload = value(jwt);
		cache.set(jwt, payload);
		return payload;
	};
})();

export function users_get_user_id_from_jwt(jwt: string) {
	const payload = users_decode_jwt(jwt);

	if (!payload.sub) {
		throw should_never_happen("users_get_user_id_from_jwt: no sub in JWT, failed to extract user ID");
	}

	return {
		userId: payload.sub,
		expiresAt: typeof payload.exp === "number" ? payload.exp * 1000 : null,
	};
}

export function users_create_anonymouse_user_display_name(userId: string) {
	return `Anonymous user ${userId}`;
}

export function users_create_fallback_display_name(userId: string) {
	return `User ${userId}`;
}
