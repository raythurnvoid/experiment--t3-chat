import type { api_schemas_MainPaths } from "./api-schemas.ts";
import type { LiteralUnion } from "type-fest";
import { auth_get_token } from "./auth.ts";

export async function app_fetch_main_stream(args: { url: api_schemas_MainPaths } & AppFetchCommonArgs) {
	const auth = args.auth ?? true;
	// It's correct to default to `application/json` even in case we don't expect any response body, because in case of non-ok response it would be a json anyway.
	const accept = args.accept ?? "application/json";
	const method = args.method ?? "GET";

	const headers = new Headers();

	if (auth) {
		const token = await auth_get_token();

		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		} else {
		}
	}
}

interface AppFetchCommonArgs {
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	body?: any;
	auth?: boolean;
	accept?: LiteralUnion<"text/plain" | "application/json", string>;
}
