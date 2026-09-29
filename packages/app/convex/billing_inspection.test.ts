import { afterEach, describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { HTTPClient } from "@polar-sh/sdk/lib/http.js";
import { components, internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import { billing_polar_client } from "../server/billing.ts";

vi.hoisted(() => {
	process.env.CONVEX_CLOUD_URL = "https://billing.convex.cloud";
	process.env.CONVEX_SITE_URL = "https://billing.convex.site";
	process.env.POLAR_SERVER = "sandbox";
	process.env.POLAR_ORGANIZATION_TOKEN = "POLAR_ORGANIZATION_TOKEN_TEST";
	process.env.POLAR_DEBUG = "true";
});

const CUSTOMER_ID = "34a1caad-bae8-4a13-b8cb-e721e0fe445c";
const OTHER_CUSTOMER_ID = "8eab6c67-843f-43b9-a814-253c851338a7";
const POLAR_ORGANIZATION_ID = "1c731786-7a82-4b9c-875e-f843aed606d7";
const EVENT_ID = "5b341c22-37f9-47b4-b3ad-4c3408e55174";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function seed_user(t: ReturnType<typeof test_convex>, customerId: string | null = CUSTOMER_ID) {
	const userId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId: "clerk_billing_inspection" }));
	if (customerId !== null) {
		await t.mutation(components.polar.lib.insertCustomer, { id: customerId, userId });
	}
	return userId;
}

function request_args(userId: FunctionArgs<typeof internal.billing.inspect_polar_billing_page>["userId"]) {
	return {
		userId,
		expectedCustomerId: CUSTOMER_ID,
		expectedCloudUrl: "https://billing.convex.cloud",
		expectedSiteUrl: "https://billing.convex.site",
		expectedPolarServer: "sandbox" as const,
	};
}

function customer_response(userId: string) {
	return {
		id: CUSTOMER_ID,
		created_at: "2026-09-27T00:00:00Z",
		modified_at: null,
		metadata: { private: "private_customer_metadata" },
		external_id: userId,
		email: "private_email@example.com",
		email_verified: true,
		type: "individual",
		name: "private_customer_name",
		billing_name: "private_billing_name",
		billing_address: null,
		tax_id: null,
		organization_id: POLAR_ORGANIZATION_ID,
		deleted_at: null,
		avatar_url: null,
	};
}

function event_response(userId: string) {
	return {
		id: EVENT_ID,
		timestamp: "2026-09-27T00:00:00Z",
		organization_id: POLAR_ORGANIZATION_ID,
		customer_id: null,
		customer: customer_response(userId),
		external_customer_id: userId,
		external_member_id: null,
		label: "private_event_label",
		name: "press_usage_event",
		source: "user",
		metadata: { name: "manual_credit", amount: -5, private: "private_event_metadata" },
	};
}

function json_response(body: unknown) {
	return Response.json(body, { headers: { "polar-version": "2026-04", "x-private-header": "private_header" } });
}

describe("inspect_polar_billing_page", () => {
	test("reads only the mapped customer and keeps private fields off the result and logs", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const group = vi.spyOn(console, "group").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json_response(customer_response(userId)));
		const before = await t.run(async (ctx) => ({
			users: await ctx.db.query("users").collect(),
			snapshots: await ctx.db.query("billing_usage_snapshots").collect(),
			jobs: await ctx.db.system.query("_scheduled_functions").collect(),
		}));

		const result = await t.action(internal.billing.inspect_polar_billing_page, request_args(userId));
		expect(result).toEqual({
			_yay: {
				cloudUrl: "https://billing.convex.cloud",
				siteUrl: "https://billing.convex.site",
				polarServer: "sandbox",
				customer: { id: CUSTOMER_ID, externalId: userId, organizationId: POLAR_ORGANIZATION_ID, deletedAt: null },
				customerHttp: { status: 200, apiVersion: "2026-04" },
				events: null,
			},
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const request = fetchSpy.mock.calls[0][0] as Request;
		expect(request.url).toBe(`https://sandbox-api.polar.sh/v1/customers/${CUSTOMER_ID}`);
		expect(request.method).toBe("GET");
		expect(request.redirect).toBe("error");
		expect(log).not.toHaveBeenCalled();
		expect(group).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/private_|POLAR_ORGANIZATION_TOKEN_TEST|HttpMeta/);
		expect(
			await t.run(async (ctx) => ({
				users: await ctx.db.query("users").collect(),
				snapshots: await ctx.db.query("billing_usage_snapshots").collect(),
				jobs: await ctx.db.system.query("_scheduled_functions").collect(),
			})),
		).toEqual(before);
	});

	test("reads a null-customer event and preserves negative credit amounts", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(
				json_response({ items: [event_response(userId)], pagination: { total_count: 1, max_page: 1 } }),
			);
		const result = await t.action(internal.billing.inspect_polar_billing_page, {
			...request_args(userId),
			events: { page: 1 },
		});
		expect(result).toMatchObject({
			_yay: {
				events: {
					page: 1,
					http: { status: 200, apiVersion: "2026-04" },
					pagination: { totalCount: 1, maxPage: 1 },
					items: [
						{
							id: EVENT_ID,
							timestamp: "2026-09-27T00:00:00.000Z",
							customerId: null,
							externalCustomerId: userId,
							externalMemberId: null,
							metadata: { name: "manual_credit", amount: -5 },
						},
					],
				},
			},
		});
		expect(JSON.stringify(result)).not.toMatch(/private_|HttpMeta/);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const url = new URL((fetchSpy.mock.calls[1][0] as Request).url);
		expect(url.pathname).toBe("/v1/events/");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			external_customer_id: userId,
			organization_id: POLAR_ORGANIZATION_ID,
			name: "press_usage_event",
			source: "user",
			page: "1",
			limit: "100",
		});
	});

	test.each([
		{ total_count: 0, max_page: 0 },
		{ total_count: 101, max_page: 2 },
		{ has_next_page: true },
		{ has_next_page: false },
	])("preserves empty page state %j without following it", async (pagination) => {
		const t = test_convex();
		const userId = await seed_user(t);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(json_response({ items: [], pagination }));
		const result = await t.action(internal.billing.inspect_polar_billing_page, {
			...request_args(userId),
			events: { page: 1 },
		});
		expect(result).toMatchObject({
			_yay: {
				events: {
					items: [],
					pagination:
						"has_next_page" in pagination
							? { hasNextPage: pagination.has_next_page }
							: { totalCount: pagination.total_count, maxPage: pagination.max_page },
				},
			},
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("checks metadata filters and accepts the matching non-null customer", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const event = { ...event_response(userId), customer_id: CUSTOMER_ID };
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(json_response({ items: [event], pagination: { has_next_page: false } }));
		const result = await t.action(internal.billing.inspect_polar_billing_page, {
			...request_args(userId),
			events: { page: 5, metadata: { name: "manual_credit" } },
		});
		expect(result).toMatchObject({ _yay: { events: { page: 5, items: [{ customerId: CUSTOMER_ID }] } } });
	});

	test("wrong external payer is refused", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const event = { ...event_response(userId), external_customer_id: "another_payer" };
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(json_response({ items: [event], pagination: { has_next_page: false } }));
		const result = await t.action(internal.billing.inspect_polar_billing_page, {
			...request_args(userId),
			events: { page: 1 },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ _nay: { message: "Billing inspection event does not match" } });
	});

	test.each([
		{ customer_id: OTHER_CUSTOMER_ID },
		{ organization_id: OTHER_CUSTOMER_ID },
		{ metadata: { name: "manual_credit", amount: -5, billedUserId: "another_payer" } },
	])("refuses a wrong event link %j", async (change) => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(
				json_response({ items: [{ ...event_response(userId), ...change }], pagination: { has_next_page: false } }),
			);
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), events: { page: 1 } }),
		).toEqual({ _nay: { message: "Billing inspection event does not match" } });
	});

	test("refuses a returned event outside the metadata filter", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(json_response({ items: [event_response(userId)], pagination: { has_next_page: false } }));
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, {
				...request_args(userId),
				events: { page: 1, metadata: { name: "file_save" } },
			}),
		).toEqual({ _nay: { message: "Billing inspection event does not match" } });
	});

	test.each([
		{ expectedCloudUrl: "https://other.convex.cloud" },
		{ expectedSiteUrl: "https://other.convex.site" },
		{ expectedCustomerId: "not_a_uuid" },
		{ expectedCustomerId: OTHER_CUSTOMER_ID },
		{ expectedPolarServer: "production" as const },
		...[-1, 0, 1.5, 6].map((page) => ({ events: { page } })),
	])("refuses a wrong target or page before fetch %j", async (change) => {
		const t = test_convex();
		const userId = await seed_user(t);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), ...change }),
		).toHaveProperty("_nay");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each(["missing_map", "anonymous", "deleted", "missing_user"])("refuses %s before fetch", async (kind) => {
		const t = test_convex();
		const userId = await seed_user(t, kind === "missing_map" ? null : CUSTOMER_ID);
		await t.run(async (ctx) => {
			if (kind === "anonymous") await ctx.db.patch("users", userId, { clerkUserId: null });
			if (kind === "deleted") await ctx.db.patch("users", userId, { deletedAt: Date.now() });
			if (kind === "missing_user") await ctx.db.delete("users", userId);
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
		expect(await t.action(internal.billing.inspect_polar_billing_page, request_args(userId))).toHaveProperty("_nay");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each([
		{ id: OTHER_CUSTOMER_ID },
		{ external_id: "another_payer" },
		{ organization_id: "not_a_uuid" },
		{ deleted_at: "2026-09-27T00:00:00Z" },
	])("refuses a mismatched customer before the event GET %j", async (change) => {
		const t = test_convex();
		const userId = await seed_user(t);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(json_response({ ...customer_response(userId), ...change }));
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), events: { page: 1 } }),
		).toHaveProperty("_nay");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test.each([
		{ id: "not_a_uuid" },
		{ timestamp: "not_a_date" },
		{ customer_id: "not_a_uuid" },
		{ external_customer_id: null },
		{ metadata: { name: "unknown_event", amount: 1 } },
		{ metadata: { name: "manual_credit", amount: "1" } },
		{ metadata: { name: "manual_credit" } },
	])("refuses malformed event fields %j", async (change) => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(
				json_response({ items: [{ ...event_response(userId), ...change }], pagination: { has_next_page: false } }),
			);
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), events: { page: 1 } }),
		).toHaveProperty("_nay");
	});

	test.each([{ total_count: -1, max_page: 1 }, { total_count: 1, max_page: -1 }, { has_next_page: "false" }, {}])(
		"refuses malformed page state %j",
		async (pagination) => {
			const t = test_convex();
			const userId = await seed_user(t);
			vi.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(json_response(customer_response(userId)))
				.mockResolvedValueOnce(json_response({ items: [], pagination }));
			expect(
				await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), events: { page: 1 } }),
			).toHaveProperty("_nay");
		},
	);

	test("reads a full continued page without following it", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(
				json_response({
					items: Array.from({ length: 100 }, () => event_response(userId)),
					pagination: { has_next_page: true },
				}),
			);
		const result = await t.action(internal.billing.inspect_polar_billing_page, {
			...request_args(userId),
			events: { page: 2 },
		});
		expect(result).toMatchObject({ _yay: { events: { page: 2, pagination: { hasNextPage: true } } } });
		expect(result._yay?.events?.items).toHaveLength(100);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	test("refuses more than one page of returned events", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json_response(customer_response(userId)))
			.mockResolvedValueOnce(
				json_response({
					items: Array.from({ length: 101 }, () => event_response(userId)),
					pagination: { has_next_page: false },
				}),
			);
		expect(
			await t.action(internal.billing.inspect_polar_billing_page, { ...request_args(userId), events: { page: 1 } }),
		).toEqual({ _nay: { message: "Invalid billing inspection page" } });
	});

	test.each([
		() => new Response("private_error_body", { status: 500 }),
		() => new Response(null, { status: 302, headers: { location: "https://outside.example.com" } }),
		() => new Response("private_not_json", { headers: { "content-type": "text/plain" } }),
		() => new Response("not_json", { headers: { "content-type": "application/json" } }),
		() => Response.json({}, { headers: { "polar-version": "private_bad_version" } }),
	])("returns a quiet error for a refused HTTP response", async (response) => {
		const t = test_convex();
		const userId = await seed_user(t);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
		expect(await t.action(internal.billing.inspect_polar_billing_page, request_args(userId))).toEqual({
			_nay: { message: "Could not inspect Polar billing" },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(log).not.toHaveBeenCalled();
	});

	test("cancels a response above the byte cap", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const cancel = vi.fn();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(256_001));
					},
					cancel,
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		expect(await t.action(internal.billing.inspect_polar_billing_page, request_args(userId))).toEqual({
			_nay: { message: "Could not inspect Polar billing" },
		});
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("times out a stalled body read and cancels it", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.useFakeTimers();
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		const cancel = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ReadableStream({ cancel }), {
				headers: { "content-type": "application/json" },
			}),
		);
		const result = t.action(internal.billing.inspect_polar_billing_page, request_args(userId));
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ _nay: { message: "Could not inspect Polar billing" } });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("times out a stalled GET before reading its body", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		vi.useFakeTimers();
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return await new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(new Error("private_timeout")), { once: true });
			});
		});
		const result = t.action(internal.billing.inspect_polar_billing_page, request_args(userId));
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ _nay: { message: "Could not inspect Polar billing" } });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("does not return or log a thrown transport error", async () => {
		const t = test_convex();
		const userId = await seed_user(t);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("POLAR_ORGANIZATION_TOKEN_TEST private_failure"));
		expect(await t.action(internal.billing.inspect_polar_billing_page, request_args(userId))).toEqual({
			_nay: { message: "Could not inspect Polar billing" },
		});
		expect(log).not.toHaveBeenCalled();
	});
});

describe("billing_polar_client", () => {
	test("keeps the normal cached client when an inspection client is requested", () => {
		const cached = billing_polar_client();
		const inspection = billing_polar_client({ httpClient: new HTTPClient(), expectedServer: "sandbox" });
		expect(inspection).not.toBe(cached);
		expect(billing_polar_client()).toBe(cached);
	});
});
