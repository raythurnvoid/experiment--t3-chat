import { decodeJwt } from "jose";
import { should_never_happen } from "./shared-utils.ts";

const users_decode_jwt = ((/* iife */) => {
	function value(jwt: string) {
		const payload = decodeJwt(jwt);
		return payload;
	}

	let cache: ReturnType<typeof value> | undefined;

	return function users_decode_jwt(jwt: string) {
		return (cache ??= value(jwt));
	};
})();

export function users_get_user_id_from_jwt(jwt: string) {
	const payload = users_decode_jwt(jwt);
	if (!payload.sub) {
		throw should_never_happen("users_get_user_id_from_jwt: no sub in JWT, failed to extract user ID");
	}
	return payload.sub;
}
