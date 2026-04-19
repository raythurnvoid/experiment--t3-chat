import "../convex/setup.test.ts";
import { describe, expect, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import {
	billing_event,
	billing_manual_credit_event_external_id,
	billing_monthly_grant_event_external_id,
	billing_page_save_event_external_id,
	type billing_Event,
} from "./billing.ts";

describe("billing_event", () => {
	test("builds the canonical page_save usage event payload", () => {
		const event = {
			name: "page_save",
			externalCustomerId: "user_1" as Id<"users">,
			externalId: billing_page_save_event_external_id({
				userId: "user_1" as Id<"users">,
				pageId: "page_1",
				newSequence: 42,
			}),
			metadata: {
				amount: 1,
				workspaceId: "workspace_1",
				projectId: "project_1",
				pageId: "page_1",
				yjsSequence: "42",
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
	});

	test("builds the canonical monthly_grant usage event payload", () => {
		const event = {
			name: "monthly_grant",
			externalCustomerId: "user_1" as Id<"users">,
			externalId: billing_monthly_grant_event_external_id({
				userId: "user_1" as Id<"users">,
				subscriptionId: "sub_1",
				periodStart: "2026-01-01T00:00:00.000Z",
			}),
			metadata: {
				amount: -1000,
				subscriptionId: "sub_1",
				productId: "prod_1",
				productName: "Pay As You Go",
				periodStart: "2026-01-01T00:00:00.000Z",
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
	});

	test("builds the canonical manual_credit usage event payload", () => {
		const event = {
			name: "manual_credit",
			externalCustomerId: "user_1" as Id<"users">,
			externalId: billing_manual_credit_event_external_id({
				userId: "user_1" as Id<"users">,
				timestamp: 123456,
			}),
			metadata: {
				amount: -2500,
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
	});
});

describe("billing_page_save_event_external_id", () => {
	test("builds the canonical page_save external id", () => {
		expect(
			billing_page_save_event_external_id({
				userId: "user_1" as Id<"users">,
				pageId: "page_1",
				newSequence: 42,
			}),
		).toBe("page_save:user_1:page_1:42");
	});
});

describe("billing_monthly_grant_event_external_id", () => {
	test("builds the canonical monthly_grant external id", () => {
		expect(
			billing_monthly_grant_event_external_id({
				userId: "user_1" as Id<"users">,
				subscriptionId: "sub_1",
				periodStart: "2026-01-01T00:00:00.000Z",
			}),
		).toBe("monthly_grant:user_1:sub_1:2026-01-01T00:00:00.000Z");
	});
});

describe("billing_manual_credit_event_external_id", () => {
	test("builds the canonical manual_credit external id", () => {
		expect(
			billing_manual_credit_event_external_id({
				userId: "user_1" as Id<"users">,
				timestamp: 123456,
			}),
		).toBe("manual_credit:user_1:123456");
	});
});
