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
 * Other Polar event fields are intentionally not modeled until a real billing
 * event needs them: `customerId`, `externalMemberId`, `memberId`,
 * `organizationId`, `parentId`, and `timestamp`.
 */
export type billing_Event = FunctionArgs<typeof internal.billing.ingest_events>["events"][number];

export function billing_event<const T extends billing_Event>(event: T): T {
	return event;
}

export function billing_page_save_event_external_id(args: {
	userId: billing_Event["externalCustomerId"];
	pageId: string;
	newSequence: number;
}) {
	return `page_save:${args.userId}:${args.pageId}:${args.newSequence}`;
}

export function billing_monthly_grant_event_external_id(args: {
	userId: billing_Event["externalCustomerId"];
	subscriptionId: string;
	periodStart: string;
}) {
	return `monthly_grant:${args.userId}:${args.subscriptionId}:${args.periodStart}`;
}

export function billing_manual_credit_event_external_id(args: {
	userId: billing_Event["externalCustomerId"];
	timestamp: number;
}) {
	return `manual_credit:${args.userId}:${args.timestamp}`;
}
// #endregion usage events
