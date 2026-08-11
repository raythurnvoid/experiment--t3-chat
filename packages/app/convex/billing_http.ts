import { WebhookVerificationError, validateEvent } from "@polar-sh/sdk/webhooks";
import type { ActionCtx } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { billing_polar } from "./billing_polar.ts";
import { convertToDatabaseProduct, convertToDatabaseSubscription } from "../vendor/polar/src/component/util.ts";

// Keep the built-in event handling in sync with @convex-dev/polar's registerRoutes implementation.
export async function billing_http_handle_request(ctx: ActionCtx, request: Request, webhookSecret: string) {
	if (!request.body) {
		throw new Error("No body");
	}

	const body = await request.text();
	const headers = Object.fromEntries(request.headers.entries());
	try {
		const event = validateEvent(body, headers, webhookSecret);
		const rawPayload = JSON.parse(body) as unknown;

		switch (event.type) {
			case "subscription.created":
				await ctx.runMutation(components.polar.lib.createSubscription, {
					subscription: convertToDatabaseSubscription(event.data),
				});
				break;
			case "subscription.updated":
				await ctx.runMutation(components.polar.lib.updateSubscription, {
					subscription: convertToDatabaseSubscription(event.data),
				});
				break;
			case "subscription.active":
			case "subscription.canceled":
			case "subscription.uncanceled":
			case "subscription.revoked":
			case "subscription.past_due":
				await ctx.runMutation(components.polar.lib.updateSubscription, {
					subscription: convertToDatabaseSubscription(event.data),
				});
				break;
			case "product.created":
				await ctx.runMutation(components.polar.lib.createProduct, {
					product: convertToDatabaseProduct(event.data),
				});
				break;
			case "product.updated":
				await ctx.runMutation(components.polar.lib.updateProduct, {
					product: convertToDatabaseProduct(event.data),
				});
				break;
			case "benefit.created":
			case "benefit.updated":
				await billing_polar.syncProducts(ctx);
				break;
			case "customer.updated":
				if (event.data.deletedAt) {
					await ctx.runMutation(components.polar.lib.deleteCustomerByPolarCustomerId, {
						polarCustomerId: event.data.id,
					});
				}
				break;
			case "customer.deleted":
				await ctx.runMutation(components.polar.lib.deleteCustomerByPolarCustomerId, {
					polarCustomerId: event.data.id,
				});
				break;
		}

		if (event.type === "customer.state_changed") {
			console.info("http webhook customer.state_changed received", {
				externalId: event.data.externalId,
				polarCustomerId: event.data.id,
				activeSubscriptionsCount: event.data.activeSubscriptions.length,
				activeMeters: event.data.activeMeters.map((meter) => ({
					meterId: meter.meterId,
					balance: meter.balance,
					consumedUnits: meter.consumedUnits,
					creditedUnits: meter.creditedUnits,
				})),
				receivedAt: new Date().toISOString(),
			});
			await ctx.runMutation(internal.billing.handle_polar_customer_state_update, {
				payload: rawPayload,
			});
		}

		return new Response("Accepted", { status: 202 });
	} catch (error) {
		if (error instanceof WebhookVerificationError) {
			console.error(error);
			return new Response("Forbidden", { status: 403 });
		}

		throw error;
	}
}
