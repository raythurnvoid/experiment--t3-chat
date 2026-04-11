import { PolarCore } from "@polar-sh/sdk/core.js";

/** Polar meter / usage event names configured for this app (Polar dashboard + ingest). */
export const billing_EVENTS = {
	pressUsage: "press_usage_event",
} as const;

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
