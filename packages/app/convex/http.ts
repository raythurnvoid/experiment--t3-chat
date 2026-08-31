import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { corsRouter } from "convex-helpers/server/cors";
import { allowed_origins } from "../server/server-utils.ts";
import { ai_chat_http_routes } from "./ai_chat_http_routes.ts";
import { billing_http_routes } from "./billing_http_routes.ts";
import { files_nodes_ai_http_routes } from "./files_nodes_ai_http_routes.ts";
import { plugins_data_http_routes } from "./plugins_data_http_routes.ts";
import { plugins_invoke_http_routes } from "./plugins_invoke_http_routes.ts";
import { plugins_runtime_http_routes } from "./plugins_runtime_http_routes.ts";
import { plugins_service_http_routes } from "./plugins_service_http_routes.ts";
import { plugins_ui_http_routes } from "./plugins_ui_http_routes.ts";
import { public_api_files_list_http_routes } from "./public_api_files_list_http.ts";
import { public_api_http_routes } from "./public_api_http_routes.ts";
import { public_api_plugin_files_http_routes } from "./public_api_plugin_files_http_routes.ts";
import { public_api_service_uploads_http_routes } from "./public_api_service_uploads_http_routes.ts";
import { r2_http_routes } from "./r2_http_routes.ts";
import { users_http_routes } from "./users_http_routes.ts";

// NOTE: experimental_reuseContext does NOT work for http actions. Verified 2026-07-15:
// with the flag exported here, every request still paid the full ~250ms module load.
// Only queries and mutations benefit; see the flag in files_nodes.ts.

const http = httpRouter();

const appCors = corsRouter(http, {
	allowedOrigins: allowed_origins(),
	allowedHeaders: ["Authorization", "Content-Type"],
});

// Route definitions stay small and static. Each heavy implementation loads inside its route.
users_http_routes(appCors);
ai_chat_http_routes(appCors);
files_nodes_ai_http_routes(appCors);
// File listing stays static because it is small and is the hot plugin read path.
public_api_files_list_http_routes(appCors);
public_api_http_routes(appCors);
public_api_plugin_files_http_routes(appCors);
public_api_service_uploads_http_routes(appCors);
plugins_data_http_routes(appCors);
plugins_invoke_http_routes(appCors);
r2_http_routes(appCors);
plugins_runtime_http_routes(appCors);
plugins_service_http_routes(appCors);
plugins_ui_http_routes(http);
billing_http_routes(http);

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
