import { mcp_fixtures_create_basic_handler } from "../../app/server/mcp-fixtures/mcp-fixtures.ts";

// Workers refuse some setup work in global scope, so create the handler on the first request.
const get_basic_handler = ((/* iife */) => {
	let cache: ReturnType<typeof mcp_fixtures_create_basic_handler> | undefined;

	return function get_basic_handler() {
		return (cache ??= mcp_fixtures_create_basic_handler());
	};
})();

export default {
	async fetch(request: Request) {
		// Serve only the `modern-basic` fixture. The broken and slow fixtures stay test-only.
		if (new URL(request.url).pathname !== "/modern-basic") {
			return new Response("Not found", { status: 404 });
		}

		return await get_basic_handler().fetch(request);
	},
};
