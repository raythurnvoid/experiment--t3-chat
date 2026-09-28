import { mcp_fixtures_create_basic_handler } from "../../app/server/mcp-fixtures/mcp-fixtures.ts";
import { oauth_fixture_fetch } from "./oauth-fixture.ts";

// Workers refuse some setup work in global scope, so create the handler on the first request.
const get_basic_handler = ((/* iife */) => {
	let cache: ReturnType<typeof mcp_fixtures_create_basic_handler> | undefined;

	return function get_basic_handler() {
		return (cache ??= mcp_fixtures_create_basic_handler());
	};
})();

export default {
	async fetch(request: Request, env: { OAUTH_SIGNING_KEY: string }) {
		// Serve the `modern-basic` fixture and the OAuth fixture. The broken and slow fixtures stay test-only.
		if (new URL(request.url).pathname === "/modern-basic") {
			return await get_basic_handler().fetch(request);
		}

		return (
			(await oauth_fixture_fetch(env, get_basic_handler(), request)) ?? new Response("Not found", { status: 404 })
		);
	},
};
