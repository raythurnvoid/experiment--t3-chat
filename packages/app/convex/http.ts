import { HttpRouter, httpRouter } from "convex/server";
import { ai_chat_http_routes } from "./ai_chat.ts";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { pages_http_routes } from "./ai_docs_temp.ts";
import { billing } from "./billing.ts";
import { users_http_routes } from "./users.ts";
import { corsRouter } from "convex-helpers/server/cors";
import { allowed_origins } from "../server/server-utils.ts";

const http = httpRouter();

billing.registerRoutes(http, {
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

export type RouterForConvexModules = {
	route: HttpRouter["route"];
};

users_http_routes(appCors);
ai_chat_http_routes(appCors);
pages_http_routes(appCors);

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
