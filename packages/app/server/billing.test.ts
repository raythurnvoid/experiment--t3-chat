import "../convex/setup.test.ts";
import { describe, expect, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import { composite_id } from "../shared/shared-utils.ts";
import { billing_event, type billing_Event } from "./billing.ts";

describe("billing_event", () => {
	test("builds the canonical page_save usage event payload", () => {
		const event = {
			name: "page_save",
			externalCustomerId: "user_1" as Id<"users">,
			externalId: composite_id(
				"billing",
				"page_save",
				"user_1" as Id<"users">,
				"page_1",
				42,
			),
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

	test("builds the canonical monthly_credit usage event payload", () => {
		const event = {
			name: "monthly_credit",
			externalCustomerId: "user_1" as Id<"users">,
			externalId: composite_id(
				"billing",
				"monthly_credit",
				"user_1" as Id<"users">,
				"sub_1",
				"2026-01-01T00:00:00.000Z",
			),
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
			externalId: composite_id("billing", "manual_credit", "user_1" as Id<"users">, 123456),
			metadata: {
				amount: -2500,
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
	});
});
