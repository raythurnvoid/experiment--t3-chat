import { Polar } from "@convex-dev/polar";
import { components } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";
import type { ActionCtx, QueryCtx } from "./_generated/server.js";
import { convex_error } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

/**
 * Single Polar client for this app. Billing functions and the webhook handler share this instance.
 */
export const billing_polar = new Polar<DataModel>(components.polar, {
	getUserInfo: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx as QueryCtx | ActionCtx);

		if (!userAuth || userAuth.kind !== "signed_in") {
			throw convex_error({ message: "Billing requires a signed-in account" });
		}

		return { userId: userAuth.id, email: userAuth.email, name: userAuth.name };
	},
	server: POLAR_SERVER,
});
