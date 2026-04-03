import { verifyWebhook } from "@clerk/backend/webhooks";
import { type RouteSpec } from "convex/server";
import { internal } from "./_generated/api.js";
import { httpAction } from "./_generated/server.js";
import { type ActionCtx } from "./_generated/server.js";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { RouterForConvexModules } from "./http.ts";

export function clerk_webhooks_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/webhooks/clerk" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = Record<string, unknown>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
							if (!signingSecret) {
								return {
									status: 500,
									body: { message: "CLERK_WEBHOOK_SIGNING_SECRET is not configured" },
								} as const;
							}

							const eventId = request.headers.get("svix-id");
							if (!eventId) {
								return {
									status: 400,
									body: { message: "Missing `svix-id` header" },
								} as const;
							}

							try {
								const event = await verifyWebhook(request, {
									signingSecret,
								});
								if (event.type !== "user.deleted") {
									return {
										status: 200,
										body: { ok: true, ignored: true },
									} as const;
								}

								const clerkUserId = typeof event.data.id === "string" ? event.data.id : null;
								if (!clerkUserId) {
									return {
										status: 400,
										body: { message: "Missing Clerk user id in webhook payload" },
									} as const;
								}

								await ctx.runMutation(internal.account_deletion.record_clerk_user_deleted_webhook, {
									eventId,
									eventType: event.type,
									clerkUserId,
									receivedAt: Date.now(),
								});

								return {
									status: 200,
									body: { ok: true, ignored: false },
								} as const;
							} catch (error) {
								console.error("[clerk_webhooks_http_routes] Failed to verify Clerk webhook", { error, eventId });
								return {
									status: 400,
									body: { message: "Webhook verification failed" },
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
