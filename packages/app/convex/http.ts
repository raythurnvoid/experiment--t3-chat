import { httpRouter } from "convex/server";
import { chat, thread_generate_title } from "./ai_chat";
import type { api_schemas_MainPaths } from "../src/lib/api-schemas.ts";
import { httpAction } from "./_generated/server";
import { server_convex_headers_preflight_cors } from "../server/server-utils.ts";
import { contextual_prompt, liveblocks_auth } from "./ai_docs_temp";

const http = httpRouter();

// AI chat streaming endpoint
http.route({
	path: "/api/chat" satisfies api_schemas_MainPaths,
	method: "POST",
	handler: chat,
});
http.route({
	path: "/api/chat" satisfies api_schemas_MainPaths,
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			headers: server_convex_headers_preflight_cors(),
		});
	}),
});

// Thread title generation endpoint
http.route({
	path: "/api/v1/runs/stream" satisfies api_schemas_MainPaths,
	method: "POST",
	handler: thread_generate_title,
});
http.route({
	path: "/api/v1/runs/stream" satisfies api_schemas_MainPaths,
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			headers: server_convex_headers_preflight_cors(),
		});
	}),
});

// AI Docs Temp endpoints
http.route({
	path: "/api/ai-docs-temp/contextual-prompt",
	method: "POST",
	handler: contextual_prompt,
});
http.route({
	path: "/api/ai-docs-temp/contextual-prompt",
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			headers: server_convex_headers_preflight_cors(),
		});
	}),
});

http.route({
	path: "/api/ai-docs-temp/liveblocks-auth",
	method: "POST",
	handler: liveblocks_auth,
});

http.route({
	path: "/api/ai-docs-temp/liveblocks-auth",
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			headers: server_convex_headers_preflight_cors(),
		});
	}),
});

http.route({
	path: "/api/ai-docs-temp/users",
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			headers: server_convex_headers_preflight_cors(),
		});
	}),
});

http.route({
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
