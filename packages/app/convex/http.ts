import { HttpRouter, httpRouter } from "convex/server";
import { ai_chat_http_routes } from "./ai_chat.ts";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { files_http_routes } from "./files_nodes.ts";
import { public_api_http_routes } from "./public_api.ts";
import { r2_http_routes } from "./r2.ts";
import { plugins_runtime_http_routes } from "./plugins_runtime.ts";
import { plugins_ui_http_routes } from "./plugins_ui.ts";
import { billing_polar } from "./billing.ts";
import { users_http_routes } from "./users.ts";
import { corsRouter } from "convex-helpers/server/cors";
import { allowed_origins } from "../server/server-utils.ts";

// NOTE: experimental_reuseContext does NOT work for http actions. Verified 2026-07-15:
// with the flag exported here, every request still paid the full ~250ms module load.
// Only queries and mutations benefit; see the flag in files_nodes.ts.

const http = httpRouter();

billing_polar.registerRoutes(http, {
	events: {
		"customer.state_changed": async (ctx, event, rawPayload) => {
			console.info("[billing-credits] http webhook customer.state_changed received", {
				externalId: event.data.externalId,
				polarCustomerId: event.data.id,
				activeSubscriptionsCount: event.data.activeSubscriptions.length,
				activeMeters: event.data.activeMeters.map((m) => ({
					meterId: m.meterId,
					balance: m.balance,
					consumedUnits: m.consumedUnits,
					creditedUnits: m.creditedUnits,
				})),
				receivedAt: new Date().toISOString(),
			});
			await ctx.runMutation(internal.billing.handle_polar_customer_state_update, {
				payload: rawPayload,
			});
		},
	},
});

const appCors = corsRouter(http, {
	allowedOrigins: allowed_origins(),
	allowedHeaders: ["Authorization", "Content-Type"],
});

// Sandboxed plugin iframes have an opaque origin, so the browser sends the literal header
// `Origin: null`. The "null" entry lets them call the bearer-token public API (no cookies;
// allowCredentials stays false). It has to be added here in code because allowed_origins()
// URL-parses the env entries and would drop the bare "null" string.
const appCorsPublicApi = corsRouter(http, {
	allowedOrigins: [...allowed_origins(), "null"],
	allowedHeaders: ["Authorization", "Content-Type"],
});

export type RouterForConvexModules = {
	route: HttpRouter["route"];
};

users_http_routes(appCors);
ai_chat_http_routes(appCors);
public_api_http_routes(appCorsPublicApi);
files_http_routes(appCors);
r2_http_routes(appCors);
plugins_runtime_http_routes(appCors);
plugins_ui_http_routes(http);

appCors.route({
	path: "/getMessagesByAuthor",
	method: "GET",
	handler: httpAction(async () => {
		return new Response("Hello, world!", {
			headers: {
				"Access-Control-Allow-Origin": "*",
			},
		});
	}),
});

export default http;
