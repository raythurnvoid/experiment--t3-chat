import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";

beforeEach(() => {
	const objects = new Map<string, ArrayBuffer>();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_public_grants" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: `https://r2.test/object?key=${encodeURIComponent(key!)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key")!;
			if (init?.method === "PUT") {
				objects.set(key, await new Response(init.body).arrayBuffer());
				return new Response(null);
			}
			const body = objects.get(key);
			return body ? new Response(body, { headers: { ETag: '"saved-file"' } }) : new Response(null, { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function seed_public_api_grant(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	token: string;
	scopes?: Array<"files:list" | "files:read">;
	pathPrefix?: string | null;
	now?: number;
}) {
	await args.t.mutation(internal.public_api.create_grant, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		threadId: null,
		principalKey: "grant_test",
		tokenHash: await crypto_sha256_hex(args.token),
		scopes: args.scopes ?? ["files:list", "files:read"],
		pathPrefix: args.pathPrefix ?? null,
		now: args.now ?? Date.now(),
	});
}

function grant_headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

describe("public API grants", () => {
	test("cleans expired grants in bounded batches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const expiredToken = "6".repeat(64);
		const validToken = "7".repeat(64);

		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: validToken,
			now,
		});
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: expiredToken,
			now: now - 20 * 60 * 1000,
		});

		const result = await t.mutation(internal.public_api.cleanup_expired_grants, {
			_test_now: now,
			batchSize: 10,
		});
		expect(result).toEqual({
			deletedCount: 1,
			done: true,
		});

		const grants = await t.run(async (ctx) => ctx.db.query("public_api_grants").collect());
		expect(grants).toHaveLength(1);
		expect(grants[0]?.tokenHash).toBe(await crypto_sha256_hex(validToken));
	});

	test("drains expired grant backlogs through scheduled continuation", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const now = Date.now();
			vi.setSystemTime(now);
			await t.run(async (ctx) => {
				await Promise.all([
					...Array.from({ length: 3 }, (_, index) =>
						ctx.db.insert("public_api_grants", {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							userId: db.userId,
							threadId: null,
							principalKey: `expired_${index}`,
							agentSource: null,
							codeReadBudgetId: null,
							remainingReadBytes: 0,
							tokenHash: `expired_hash_${index}`,
							scopes: ["files:list"],
							pathPrefix: null,
							createdAt: now - 20 * 60 * 1000,
							expiresAt: now - 10 * 60 * 1000,
						}),
					),
					ctx.db.insert("public_api_grants", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId: db.userId,
						threadId: null,
						principalKey: "expires_after_test_now",
						agentSource: null,
						codeReadBudgetId: null,
						remainingReadBytes: 0,
						tokenHash: "expires_after_test_now_hash",
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 500,
					}),
					ctx.db.insert("public_api_grants", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId: db.userId,
						threadId: null,
						principalKey: "valid",
						agentSource: null,
						codeReadBudgetId: null,
						remainingReadBytes: 0,
						tokenHash: "valid_hash",
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
				]);
			});

			const firstBatch = await t.mutation(internal.public_api.cleanup_expired_grants_until_done, {
				_test_now: now,
				batchSize: 2,
			});
			expect(firstBatch).toEqual({
				deletedCount: 2,
				done: false,
			});

			vi.advanceTimersByTime(1000);
			await t.finishInProgressScheduledFunctions();

			const grants = await t.run(async (ctx) => ctx.db.query("public_api_grants").collect());
			expect(grants.map((grant) => grant.tokenHash).sort()).toEqual(["expires_after_test_now_hash", "valid_hash"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("rejects missing or expired grants", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "0".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token,
			now: Date.now() - 20 * 60 * 1000,
		});

		const missing = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/" }),
		});
		expect(missing.status).toBe(401);

		const expired = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/" }),
		});
		expect(expired.status).toBe(401);
	});

	test("lists and reads scoped saved files", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "1".repeat(64);
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/payments/payment-001.md",
			textContent: "---\namount: 12.50\n---\nPayment one\n",
		});
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/payments/payment-002.md",
			textContent: "---\namount: 7.25\n---\nPayment two\n",
		});
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token,
		});

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments", recursive: true, kind: "file", extension: "md", limit: 1000 }),
		});
		expect(listResponse.status).toBe(200);
		const listBody = (await listResponse.json()) as {
			items: Array<{ path: string; kind: string }>;
			isDone: boolean;
		};
		expect(listBody.items.map((item) => item.path).sort()).toEqual([
			"/payments/payment-001.md",
			"/payments/payment-002.md",
		]);
		expect(listBody.items.every((item) => item.kind === "file")).toBe(true);

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(await readResponse.text()).toContain("amount: 12.50");

		const secondResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments/payment-002.md" }),
		});
		expect(secondResponse.status).toBe(200);
		expect(await secondResponse.text()).toContain("amount: 7.25");
	});

	test("enforces grant path prefix before listing or reading files", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "2".repeat(64);
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/payments/payment-001.md",
			textContent: "Payment one\n",
		});
		await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/payments-archive/payment-001.md",
			textContent: "Archived payment\n",
		});
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token,
			pathPrefix: "/payments",
		});

		const allowed = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(allowed.status).toBe(200);

		const sibling = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments-archive/payment-001.md" }),
		});
		expect(sibling.status).toBe(403);

		const rootList = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/" }),
		});
		expect(rootList.status).toBe(403);
	});

	test("enforces grant file scopes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const listOnlyToken = "4".repeat(64);
		const readOnlyToken = "5".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: listOnlyToken,
			scopes: ["files:list"],
		});
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: readOnlyToken,
			scopes: ["files:read"],
		});

		const listWithReadOnly = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(readOnlyToken),
			body: JSON.stringify({ path: "/" }),
		});
		expect(listWithReadOnly.status).toBe(403);

		const readWithListOnly = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(listOnlyToken),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(readWithListOnly.status).toBe(403);
	});
});
