import { PolarCore } from "@polar-sh/sdk/core.js";
import type { FunctionArgs } from "convex/server";
import type { internal } from "../convex/_generated/api.js";

if (!process.env.POLAR_SERVER) {
	throw new Error("POLAR_SERVER is not set");
}

const POLAR_SERVER = process.env.POLAR_SERVER as "sandbox" | "production";

if (!process.env.POLAR_ORGANIZATION_TOKEN) {
	throw new Error("POLAR_ORGANIZATION_TOKEN is not set");
}

const POLAR_ORGANIZATION_TOKEN = process.env.POLAR_ORGANIZATION_TOKEN;

let billing_polar_client_cached: PolarCore | null = null;

export function billing_polar_client() {
	return (billing_polar_client_cached ??= new PolarCore({
		accessToken: POLAR_ORGANIZATION_TOKEN,
		server: POLAR_SERVER,
	}));
}

// #region usage events
export const billing_POLAR_METER_EVENT = "press_usage_event";

/**
 * App-owned billing usage event payload.
 *
 * Polar receives these values through `ingest_events`:
 * - `name`: Redirected to `metadata.name`; Polar's `name` is always
 *   `billing_POLAR_METER_EVENT` because one meter tracks both charges and credits.
 * - `externalCustomerId`: Sent as Polar `externalCustomerId`; this is the
 *   Convex user id used as Polar's customer external id.
 * - `externalId`: Sent as Polar `externalId` for idempotency.
 * - `metadata`: Sent as Polar `metadata`, with `name` added by the ingest helper.
 *
 * Polar's meter sums event amounts directly. Positive `metadata.amount` values
 * are usage that consumes/decreases balance; negative values are credits or
 * payments that increase balance.
 *
 * Other Polar event fields are intentionally not modeled until a real billing
 * event needs them: `customerId`, `externalMemberId`, `memberId`,
 * `organizationId`, `parentId`, and `timestamp`.
 */
export type billing_Event = FunctionArgs<typeof internal.billing.ingest_events>["events"][number];

export function billing_event<const T extends billing_Event>(event: T): T {
	return event;
}
// #endregion usage events
