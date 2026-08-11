// Keep route registration static. Load Polar and billing code only when the webhook runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter } from "convex/server";

if (!process.env.POLAR_WEBHOOK_SECRET) {
	throw new Error("POLAR_WEBHOOK_SECRET is not set in Convex env");
}
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET;

export function billing_http_routes(router: { route: HttpRouter["route"] }) {
	router.route({
		path: "/polar/events",
		method: "POST",
		handler: httpAction(async (ctx, request) => {
			const { billing_http_handle_request } = await import("./billing_http.ts");
			return await billing_http_handle_request(ctx, request, POLAR_WEBHOOK_SECRET);
		}),
	});
}
