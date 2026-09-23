import "../convex/setup.test.ts";
import { describe, expect, test } from "vitest";
import type { Id } from "../convex/_generated/dataModel.js";
import { composite_id } from "../shared/shared-utils.ts";
import { billing_event, type billing_Event } from "./billing.ts";

describe("billing_event", () => {
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

	test("builds the canonical file_save usage event payload", () => {
		const event = {
			name: "file_save",
			externalCustomerId: "billed_user_1" as Id<"users">,
			externalMemberId: "actor_user_1" as Id<"users">,
			externalId: composite_id(
				"billing",
				"file_save",
				"billed_user_1" as Id<"users">,
				"actor_user_1" as Id<"users">,
				"organization_1",
				"workspace_1",
				"file_1",
				"42",
			),
			metadata: {
				amount: 1,
				actorUserId: "actor_user_1" as Id<"users">,
				billedUserId: "billed_user_1" as Id<"users">,
				organizationId: "organization_1",
				workspaceId: "workspace_1",
				nodeId: "file_1",
				version: "42",
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

	test("builds the canonical ai_usage usage event payload", () => {
		const event = {
			name: "ai_usage",
			externalCustomerId: "billed_user_1" as Id<"users">,
			externalMemberId: "actor_user_1" as Id<"users">,
			externalId: composite_id(
				"billing",
				"ai_usage",
				"billed_user_1" as Id<"users">,
				"actor_user_1" as Id<"users">,
				"organization_1",
				"workspace_1",
				"thread_1",
				"message_1",
			),
			metadata: {
				amount: 12.5,
				actorUserId: "actor_user_1" as Id<"users">,
				billedUserId: "billed_user_1" as Id<"users">,
				organizationId: "organization_1",
				workspaceId: "workspace_1",
				modelId: "gpt-5.4-nano",
				inputTokens: 1000,
				outputTokens: 250,
				generatedImages: 1,
				threadId: "thread_1",
				messageId: "message_1",
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
	});

	test("builds the canonical browser_usage usage event payload", () => {
		const event = {
			name: "browser_usage",
			externalCustomerId: "billed_user_1" as Id<"users">,
			externalMemberId: "actor_user_1" as Id<"users">,
			externalId: composite_id(
				"billing",
				"browser_usage",
				"billed_user_1" as Id<"users">,
				"actor_user_1" as Id<"users">,
				"organization_1",
				"workspace_1",
				"session_1",
			),
			metadata: {
				amount: 0.6,
				actorUserId: "actor_user_1" as Id<"users">,
				billedUserId: "billed_user_1" as Id<"users">,
				organizationId: "organization_1",
				workspaceId: "workspace_1",
				sessionId: "session_1",
				mode: "web",
				billedMs: 61_000,
			},
		} satisfies billing_Event;

		expect(billing_event(event)).toEqual(event);
		// One session is one event: the id ends with the session doc id.
		expect(event.externalId).toBe(
			"browser_usage::billed_user_1::actor_user_1::organization_1::workspace_1::session_1",
		);
	});
});
