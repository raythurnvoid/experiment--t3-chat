import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { PRODUCTS, billing_enqueue_page_save_event } from "./billing.ts";
import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_mocks } from "./setup.test.ts";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { pages_FIRST_VERSION, pages_ROOT_ID } from "../server/pages.ts";

vi.mock("@polar-sh/sdk/core.js", () => ({
	PolarCore: class PolarCoreMock {
		constructor(_args: unknown) {}
	},
}));

vi.mock("@polar-sh/sdk/funcs/eventsIngest.js", () => ({
	eventsIngest: vi.fn(),
}));

const eventsIngestMock = vi.mocked(eventsIngest);

describe("billing getPayAsYouGoProduct", () => {
	test("returns ready when synced name matches POLAR_PRODUCTS_PREFIX pattern", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
		const polarProductId = "billing_test_checkout_product_id";

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: polarProductName,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_products_query",
			name: "Billing Products",
			email: "billing-products@test.local",
		});

		const configured = await asUser.query(api.billing.getPayAsYouGoProduct, {});
		expect(configured.setup).toBe("ready");
		if (configured.setup !== "ready") {
			throw new Error("Expected ready setup");
		}
		expect(configured.payAsYouGo.id).toBe(polarProductId);
		expect(configured.payAsYouGo.name).toBe(polarProductName);
		expect(Array.isArray(configured.warnings)).toBe(true);
	});

	test("returns product_not_in_catalog when no product name matches", async () => {
		const t = test_convex();

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: "billing_other_product",
				organizationId: "billing_test_org",
				name: "some-unrelated-product-name",
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_products_empty",
			name: "Billing Empty",
			email: "billing-empty@test.local",
		});

		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim()!;
		const expectedName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;

		const configured = await asUser.query(api.billing.getPayAsYouGoProduct, {});
		expect(configured.setup).toBe("product_not_in_catalog");
		if (configured.setup !== "product_not_in_catalog") {
			throw new Error("Expected product_not_in_catalog");
		}
		expect(configured.expectedProductName).toBe(expectedName);
	});

	test("returns duplicate_product_name when more than one active product uses the checkout name", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim();
		if (!prefix) {
			throw new Error("Expected POLAR_PRODUCTS_PREFIX from setup-env.test.ts");
		}
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;

		for (const id of ["billing_dup_a", "billing_dup_b"] as const) {
			await t.mutation(components.polar.lib.createProduct, {
				product: {
					id,
					organizationId: "billing_test_org",
					name: polarProductName,
					description: null,
					isRecurring: true,
					isArchived: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					recurringInterval: "month",
					metadata: {},
					prices: [],
					medias: [],
					benefits: [],
				},
			});
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_dup",
			name: "Billing Dup",
			email: "billing-dup@test.local",
		});

		const configured = await asUser.query(api.billing.getPayAsYouGoProduct, {});
		expect(configured.setup).toBe("duplicate_product_name");
		if (configured.setup !== "duplicate_product_name") {
			throw new Error("Expected duplicate_product_name");
		}
		expect(configured.expectedProductName).toBe(polarProductName);
	});
});

describe("billing generateCheckoutLink auth", () => {
	test("rejects anonymous identity before Polar SDK", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_anon_checkout",
			name: "Anon Checkout",
		});

		await expect(
			asAnonymous.action(api.billing.generateCheckoutLink, {
				productIds: ["prod_x"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Billing requires a signed-in account");
	});

	test("rejects Clerk identity without email before Polar SDK", async () => {
		const t = test_convex();
		const asUserNoEmail = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_email_checkout",
			name: "No Email",
		});

		await expect(
			asUserNoEmail.action(api.billing.generateCheckoutLink, {
				productIds: ["prod_x"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Email required for billing");
	});
});

describe("billing generateCheckoutLink curated product", () => {
	test("rejects productIds that do not match the curated pay-as-you-go product", async () => {
		const t = test_convex();
		const prefix = process.env.POLAR_PRODUCTS_PREFIX?.trim()!;
		const polarProductName = `${prefix}-${PRODUCTS.PAY_AS_YOU_GO}`;
		const polarProductId = "billing_curated_checkout_id";

		await t.mutation(components.polar.lib.createProduct, {
			product: {
				id: polarProductId,
				organizationId: "billing_test_org",
				name: polarProductName,
				description: null,
				isRecurring: true,
				isArchived: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: null,
				recurringInterval: "month",
				metadata: {},
				prices: [],
				medias: [],
				benefits: [],
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_curated_checkout",
			name: "Curated Checkout",
			email: "curated-checkout@test.local",
		});

		await expect(
			asUser.action(api.billing.generateCheckoutLink, {
				productIds: ["some_other_product_id"],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Invalid checkout product");

		await expect(
			asUser.action(api.billing.generateCheckoutLink, {
				productIds: [polarProductId, polarProductId],
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Invalid checkout product");
	});
});

describe("billing changeCurrentSubscription", () => {
	test("rejects plan changes", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_plan_change",
			name: "No Plan Change",
			email: "no-plan-change@test.local",
		});

		await expect(asUser.action(api.billing.changeCurrentSubscription, { productId: "any_product" })).rejects.toThrow(
			"Plan changes are not supported",
		);
	});
});

describe("billing generateCheckoutLink ALLOWED_ORIGINS", () => {
	test("rejects misconfigured non-empty ALLOWED_ORIGINS before other checks", async () => {
		const t = test_convex();
		const previous = process.env.ALLOWED_ORIGINS;
		process.env.ALLOWED_ORIGINS = "not-a-url,, , also-invalid";
		try {
			await expect(
				t.action(api.billing.generateCheckoutLink, {
					productIds: ["any"],
					origin: "https://app.test",
					successUrl: "https://app.test/ok",
				}),
			).rejects.toThrow("ALLOWED_ORIGINS is misconfigured");
		} finally {
			if (previous === undefined) {
				delete process.env.ALLOWED_ORIGINS;
			} else {
				process.env.ALLOWED_ORIGINS = previous;
			}
		}
	});
});

describe("billing_enqueue_page_save_event", () => {
	const polar_token_previous = process.env.POLAR_ORGANIZATION_TOKEN;

	beforeEach(() => {
		process.env.POLAR_ORGANIZATION_TOKEN = "test_polar_org_token_enqueue";
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
		if (polar_token_previous === undefined) {
			delete process.env.POLAR_ORGANIZATION_TOKEN;
		} else {
			process.env.POLAR_ORGANIZATION_TOKEN = polar_token_previous;
		}
	});

	test("inserts polar_usage_events_outbox when org token is set and dedupes by key", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const pageId = await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: membership.userId,
				updatedBy: String(membership.userId),
				name: "polar-usage-page",
				path: "/polar-usage-page",
				parentId: pages_ROOT_ID,
				version: pages_FIRST_VERSION,
				archiveOperationId: undefined,
			});

			return { ...membership, pageId };
		});

		const now = 1_700_000_000_000;
		const newSequence = 7;
		await t.run(async (ctx) => {
			await billing_enqueue_page_save_event(ctx, {
				userId: seeded.userId,
				pageId: seeded.pageId,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				newSequence,
				now,
			});
			await billing_enqueue_page_save_event(ctx, {
				userId: seeded.userId,
				pageId: seeded.pageId,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				newSequence,
				now,
			});
		});

		const eventName = process.env.POLAR_USAGE_EVENT_NAME?.trim() || "billing-test-unit";
		const dedupeKey = `${eventName}:${seeded.userId}:${seeded.pageId}:${newSequence}`;

		const rows = await t.run(async (ctx) => ctx.db.query("polar_usage_events_outbox").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.dedupeKey).toBe(dedupeKey);
		expect(rows[0]!.externalCustomerId).toBe(seeded.userId);
		expect(rows[0]!.eventName).toBe(eventName);
		expect(rows[0]!.status).toBe("pending");
		expect(rows[0]!.metadata).toMatchObject({
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: String(seeded.pageId),
			yjsSequence: String(newSequence),
			source: "page-save",
		});
	});

	test("does not insert when POLAR_ORGANIZATION_TOKEN is unset", async () => {
		delete process.env.POLAR_ORGANIZATION_TOKEN;

		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const pageId = await ctx.db.insert("pages", {
				...test_mocks.pages.base(),
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				createdBy: membership.userId,
				updatedBy: String(membership.userId),
				name: "polar-usage-page-no-token",
				path: "/polar-usage-page-no-token",
				parentId: pages_ROOT_ID,
				version: pages_FIRST_VERSION,
				archiveOperationId: undefined,
			});

			return { ...membership, pageId };
		});

		await t.run(async (ctx) => {
			await billing_enqueue_page_save_event(ctx, {
				userId: seeded.userId,
				pageId: seeded.pageId,
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				newSequence: 1,
				now: Date.now(),
			});
		});

		const rows = await t.run(async (ctx) => ctx.db.query("polar_usage_events_outbox").collect());
		expect(rows).toHaveLength(0);
	});
});

describe("drain_outbox", () => {
	const polar_token_previous = process.env.POLAR_ORGANIZATION_TOKEN;

	beforeEach(() => {
		process.env.POLAR_ORGANIZATION_TOKEN = "test_polar_org_token_drain";
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
		if (polar_token_previous === undefined) {
			delete process.env.POLAR_ORGANIZATION_TOKEN;
		} else {
			process.env.POLAR_ORGANIZATION_TOKEN = polar_token_previous;
		}
	});

	test("deletes rows when eventsIngest succeeds", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			const createdAt = 1_700_000_000_001;
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:1",
				externalCustomerId: "user_drain_ok",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt,
				metadata: {
					source: "page-save",
					workspaceId: "ws",
					projectId: "pr",
					pageId: "page",
					yjsSequence: "1",
				},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).toBeNull();
		expect(eventsIngestMock).toHaveBeenCalledTimes(1);
		const ingestCall = eventsIngestMock.mock.calls[0];
		expect(ingestCall).toBeDefined();
		const ingestPayload = ingestCall![1] as {
			events: Array<{ externalId: string; externalCustomerId: string; name: string }>;
		};
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe("billing-test-unit:u:test-page:1");
		expect(ingestPayload.events[0]!.externalCustomerId).toBe("user_drain_ok");
		expect(ingestPayload.events[0]!.name).toBe("billing-test-unit");
	});

	test("marks row failed when eventsIngest returns an error result", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: false,
			error: { statusCode: 400, message: "ingest_failed_test" } as never,
		});

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:2",
				externalCustomerId: "user_drain_fail",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_000_002,
				metadata: {},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!.status).toBe("failed");
		expect(rowAfter!.lastError).toContain("ingest_failed_test");
	});

	test("marks row failed when eventsIngest throws", async () => {
		eventsIngestMock.mockRejectedValue(new Error("ingest_threw_test"));

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:throw",
				externalCustomerId: "user_drain_throw",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_000_003,
				metadata: {},
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!.status).toBe("failed");
		expect(rowAfter!.lastError).toContain("ingest_threw_test");
	});

	test("does not process rows when POLAR_ORGANIZATION_TOKEN is unset", async () => {
		delete process.env.POLAR_ORGANIZATION_TOKEN;
		eventsIngestMock.mockResolvedValue({ ok: true, value: {} as never });

		const t = test_convex();
		const rowId = await t.run(async (ctx) => {
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:3",
				externalCustomerId: "user_no_token",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_000_004,
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowAfter = await t.run(async (ctx) => ctx.db.get("polar_usage_events_outbox", rowId));
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!.status).toBe("pending");
		expect(eventsIngestMock).not.toHaveBeenCalled();
	});

	test("processes rows oldest-first", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.run(async (ctx) => {
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:older",
				externalCustomerId: "user_older",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_000_010,
			});
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:newer",
				externalCustomerId: "user_newer",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_000_011,
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const firstPayload = eventsIngestMock.mock.calls[0]![1] as {
			events: Array<{ externalId: string }>;
		};
		const secondPayload = eventsIngestMock.mock.calls[1]![1] as {
			events: Array<{ externalId: string }>;
		};
		expect(firstPayload.events[0]!.externalId).toBe("billing-test-unit:u:test-page:older");
		expect(secondPayload.events[0]!.externalId).toBe("billing-test-unit:u:test-page:newer");
	});

	test("respects the drain batch size", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		await t.run(async (ctx) => {
			for (let i = 0; i < 25; i++) {
				await ctx.db.insert("polar_usage_events_outbox", {
					dedupeKey: `billing-test-unit:u:test-page:batch:${i}`,
					externalCustomerId: `user_batch_${i}`,
					eventName: "billing-test-unit",
					status: "pending",
					createdAt: 1_700_000_001_000 + i,
				});
			}
		});

		await t.action(internal.billing.drain_outbox, {});

		const rowsAfter = await t.run(async (ctx) =>
			ctx.db
				.query("polar_usage_events_outbox")
				.withIndex("by_status_createdAt", (q) => q.eq("status", "pending"))
				.collect(),
		);
		expect(eventsIngestMock).toHaveBeenCalledTimes(24);
		expect(rowsAfter).toHaveLength(1);
		expect(rowsAfter[0]!.dedupeKey).toBe("billing-test-unit:u:test-page:batch:24");
	});

	test("ignores already failed rows", async () => {
		eventsIngestMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const failedRowId = await t.run(async (ctx) => {
			await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:failed",
				externalCustomerId: "user_failed",
				eventName: "billing-test-unit",
				status: "failed",
				createdAt: 1_700_000_002_000,
				lastError: "previous failure",
			});
			return await ctx.db.insert("polar_usage_events_outbox", {
				dedupeKey: "billing-test-unit:u:test-page:pending",
				externalCustomerId: "user_pending",
				eventName: "billing-test-unit",
				status: "pending",
				createdAt: 1_700_000_002_001,
			});
		});

		await t.action(internal.billing.drain_outbox, {});

		const remainingRows = await t.run(async (ctx) => ctx.db.query("polar_usage_events_outbox").collect());
		expect(eventsIngestMock).toHaveBeenCalledTimes(1);
		expect(remainingRows).toHaveLength(1);
		expect(remainingRows[0]!.status).toBe("failed");
		expect(remainingRows[0]!._id).not.toBe(failedRowId);
	});
});
