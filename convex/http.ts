import { httpRouter } from "convex/server";
import { chat, thread_generate_title } from "./ai_chat";

const http = httpRouter();

// AI chat streaming endpoint
http.route({
	path: "/api/chat",
	method: "POST",
	handler: chat,
});

// Thread title generation endpoint
http.route({
	path: "/api/v1/runs/stream",
	method: "POST",
	handler: thread_generate_title,
});

export default http;
