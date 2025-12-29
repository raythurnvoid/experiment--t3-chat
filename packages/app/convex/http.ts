import { HttpRouter, httpRouter } from "convex/server";
import { ai_chat_http_routes } from "./ai_chat.ts";
import { httpAction } from "./_generated/server.js";
import { pages_http_routes } from "./ai_docs_temp.ts";
import { users_http_routes } from "./users.ts";
import { corsRouter } from "convex-helpers/server/cors";

if (!process.env.ALLOWED_ORIGINS) {
	throw new Error("`ALLOWED_ORIGINS` env var is not set in Convex env");
}

/** Comma separated list of allowed origins for CORS */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

const http = httpRouter();

const appCors = corsRouter(http, {
	allowedOrigins: ALLOWED_ORIGINS.split(","),
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
