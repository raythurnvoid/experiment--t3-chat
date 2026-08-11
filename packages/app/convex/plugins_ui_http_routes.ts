// Keep route registration static. Load the plugin asset implementation only when this route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter } from "convex/server";

export function plugins_ui_http_routes(router: { route: HttpRouter["route"] }) {
	const pathPrefix = "/plugins-ui/" as const;

	router.route({
		pathPrefix,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			const { plugins_ui_http_handle_request } = await import("./plugins_ui.ts");
			return await plugins_ui_http_handle_request(ctx, request, pathPrefix);
		}),
	});
}
