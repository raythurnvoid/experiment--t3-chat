// Keep route registration static. Load the built-in skill files only when this route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter } from "convex/server";

/**
 * Public, read-only list of the built-in skills, at the RFC's well-known path. Convex answers HEAD
 * with this GET route.
 */
export function agent_skills_http_routes(router: { route: HttpRouter["route"] }) {
	const pathPrefix = "/.well-known/agent-skills/" as const;

	router.route({
		pathPrefix,
		method: "GET",
		handler: httpAction(async (_ctx, request) => {
			const { agent_skills_http_handle_request } = await import("./agent_skills_http.ts");
			return await agent_skills_http_handle_request({ request, pathPrefix });
		}),
	});
}
