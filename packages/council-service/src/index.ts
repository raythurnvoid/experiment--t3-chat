import { council_handle_preflight } from "./cors.ts";
import { council_cors_headers } from "./cors.ts";
import type { ExecutionContext, MessageBatch, ScheduledController } from "./cf.ts";
import type { Env } from "./env.ts";
import { council_NO_STORE_HEADERS } from "./http.ts";
import { council_handle_page_api } from "./routes-page.ts";
import { council_handle_room_api } from "./routes-room.ts";
import { council_handle_room_page } from "./room-page.ts";
import { council_handle_webhook } from "./webhook.ts";
import { council_consume_batch } from "./consumer.ts";
import { council_run_scheduled } from "./cleanup.ts";

export type { Env } from "./env.ts";
export { CouncilWorkflow } from "./workflow.ts";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const preflight = council_handle_preflight(request, env.COUNCIL_PLUGIN_ORIGIN);
		if (preflight) {
			return preflight;
		}

		const url = new URL(request.url);
		const now = Date.now();

		// Reports Cloudflare's deployed version id, which is what browser QA reads to prove it is
		// driving this build and not a previous deploy.
		if (url.pathname === "/health") {
			const corsHeaders = council_cors_headers(request.headers.get("Origin"), env.COUNCIL_PLUGIN_ORIGIN);
			return Response.json(
				{
					service: "bonobo-council-service",
					status: "ok",
					versionId: env.CF_VERSION_METADATA.id,
				},
				{ headers: { ...council_NO_STORE_HEADERS, ...corsHeaders } },
			);
		}

		if (url.pathname === "/room" && request.method === "GET") {
			return council_handle_room_page(request, env);
		}
		if (url.pathname.startsWith("/room/api/")) {
			return await council_handle_room_api(request, env, now);
		}
		if (url.pathname.startsWith("/api/meetings/")) {
			return await council_handle_page_api(request, env, now);
		}
		if (url.pathname === "/webhooks/realtimekit") {
			return await council_handle_webhook(request, env, now);
		}

		const corsHeaders = council_cors_headers(request.headers.get("Origin"), env.COUNCIL_PLUGIN_ORIGIN);
		return Response.json(
			{ message: "Not found" },
			{ status: 404, headers: { ...council_NO_STORE_HEADERS, ...corsHeaders } },
		);
	},

	async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
		await council_consume_batch(batch, env, Date.now());
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(council_run_scheduled(env, controller.scheduledTime));
	},
};
