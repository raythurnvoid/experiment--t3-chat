import { describe, expect, test, vi } from "vitest";
import { components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";

vi.mock("@polar-sh/sdk/core.js", () => ({
	PolarCore: class PolarCoreMock {
		constructor(_args: unknown) {}
	},
}));

async function seed_free_product(t: ReturnType<typeof test_convex>, polarProductId: string) {
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: polarProductId,
			organizationId: "ai_chat_credit_gate_test_org",
			name: billing_PRODUCTS.Free.name,
			description: null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${polarProductId}_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "free",
					isArchived: false,
					productId: polarProductId,
					priceCurrency: "eur",
					recurringInterval: "month",
				},
			],
			medias: [],
			benefits: [],
		},
	});
}

async function seed_snapshot(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		polarProductId: string;
		balanceCents: number;
	},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("billing_usage_snapshots", {
			userId: args.userId,
			polarCustomerId: `chat_credit_gate_customer_${args.userId}`,
			subscription: {
				id: `chat_credit_gate_subscription_${args.userId}`,
				productId: args.polarProductId,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
			meter: {
				id: "meter_press_usage",
				consumedUnits: 0,
				creditedUnits: args.balanceCents,
				balance: args.balanceCents,
				amountDueCents: 0,
			},
			lastSyncedAt: Date.now(),
		});
	});
}

describe("/api/chat credit gate", () => {
	test("returns 402 when a signed-in Free user has zero current credits", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
			}),
		);
		await seed_free_product(t, "prod_chat_credit_gate_zero");
		await seed_snapshot(t, {
			userId: seeded.userId,
			polarProductId: "prod_chat_credit_gate_zero",
			balanceCents: 0,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk_chat_credit_gate_zero",
			external_id: seeded.userId,
			email: "chat-credit-gate@test.local",
		});

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [
					{
						id: "msg_chat_credit_gate_user",
						role: "user",
						parts: [{ type: "text", text: "Say one short sentence." }],
					},
				],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				clientGeneratedThreadId: "thread_chat_credit_gate_client",
				membershipId: seeded.membershipId,
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(402);
		expect(body).toEqual({
			message: "Insufficient funds",
		});
	});
});
