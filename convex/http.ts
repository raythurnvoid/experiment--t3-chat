import { httpRouter } from "convex/server";
import { chat, thread_generate_title } from "./ai_chat";
import type { api_schemas_MainPaths } from "../src/lib/api-schemas.ts";

const http = httpRouter();

// AI chat streaming endpoint
http.route({
	path: "/api/chat" satisfies api_schemas_MainPaths,
	method: "POST",
	handler: chat,
});

// Thread title generation endpoint
http.route({
	path: "/api/v1/runs/stream" satisfies api_schemas_MainPaths,
	method: "POST",
	handler: thread_generate_title,
});

export default http;
