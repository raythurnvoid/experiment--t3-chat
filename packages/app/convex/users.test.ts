import { afterEach, describe, expect, test, vi } from "vitest";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_cancel_pending_home_file_seeds } from "./setup.test.ts";
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function users_test_remote_delete_response(input: string | URL | Request) {
	const url = input instanceof Request ? input.url : String(input);
	if (url.startsWith("https://api.clerk.com/")) {
		return new Response(null, { status: 200 });
	}

	// A missing Polar resource is a successful idempotent delete in the app helpers.
	return new Response(JSON.stringify({ error: "ResourceNotFound", detail: "Deleted by an earlier request" }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}

function users_test_fetch_url(input: string | URL | Request) {
	return input instanceof Request ? input.url : String(input);
}

async function users_test_bootstrap_user(
	ctx: MutationCtx,
	args: { clerkUserId: string; displayName: string; avatarUrl?: string; email?: string },
) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	await Promise.all([
		quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId,
			now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl,
				email: args.email ?? "",
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.anagraphic || !user.defaultOrganizationId || !user.defaultWorkspaceId) {
		throw new Error("Expected bootstrapped user");
	}

	await test_mocks_cancel_pending_home_file_seeds(ctx);

	return {
		userId,
		anagraphicId: user.anagraphic,
		defaultOrganizationId: user.defaultOrganizationId,
		defaultWorkspaceId: user.defaultWorkspaceId,
	} as const;
}

async function users_test_bootstrap_anonymous_user(ctx: MutationCtx, args: { displayName: string }) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: null,
	});

	await Promise.all([
		quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId,
			now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				email: "",
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.anagraphic || !user.defaultOrganizationId || !user.defaultWorkspaceId) {
		throw new Error("Expected bootstrapped anonymous user");
	}

	await test_mocks_cancel_pending_home_file_seeds(ctx);

	return {
		userId,
		anagraphicId: user.anagraphic,
		defaultOrganizationId: user.defaultOrganizationId,
		defaultWorkspaceId: user.defaultWorkspaceId,
	} as const;
}

async function users_test_seed_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		name?: string;
	},
) {
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "users_test_org",
			name: args.name ?? "Users Test Product",
			description: "Users test product",
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

async function users_test_seed_subscription(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: string;
		customerId: string;
		subscriptionId: string;
		polarProductId: string;
	},
) {
	await t.mutation(components.polar.lib.insertCustomer, {
		id: args.customerId,
		userId: args.userId,
	});

	await t.mutation(components.polar.lib.createSubscription, {
		subscription: {
			id: args.subscriptionId,
			customerId: args.customerId,
			productId: args.polarProductId,
			checkoutId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-02T00:00:00.000Z",
			amount: 1000,
			currency: "eur",
			recurringInterval: "month",
			status: "active",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			cancelAtPeriodEnd: false,
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: null,
			metadata: {},
		},
	});
}

async function users_test_seed_page(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: `/${args.tag}`,
		treePath: `/${args.tag}`,
		pathDepth: 1,
		name: args.tag,
		kind: "file",
		lowercaseExtension: null,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});

	return {
		nodeId,
	} as const;
}

describe("/api/auth/resolve-user", () => {
	test("sets Clerk external_id before enqueueing the Free subscription bootstrap", async () => {
		const t = test_convex();

		const sequence: string[] = [];
		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => {
			sequence.push("enqueue");
			return "work_resolve_free" as never;
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			sequence.push("clerk");
			return new Response(JSON.stringify({ id: "clerk-user-resolve-free" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			});
		});

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-free",
				name: "Resolve Free User",
				email: "resolve-free-user@test.local",
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body._yay?.userId).toBeDefined();
			expect(sequence).toEqual(["clerk", "enqueue"]);
			expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.bootstrap_free_subscription, {
				userId: body._yay.userId,
				email: "resolve-free-user@test.local",
				name: "Resolve Free User",
			});

			const [customer, subscription, user] = await Promise.all([
				t.query(components.polar.lib.getCustomerByUserId, {
					userId: body._yay.userId,
				}),
				t.query(components.polar.lib.getCurrentSubscription, {
					userId: body._yay.userId,
				}),
				t.run((ctx) => ctx.db.get("users", body._yay.userId)),
			]);
			const anagraphic = user?.anagraphic
				? await t.run((ctx) => ctx.db.get("users_anagraphics", user.anagraphic!))
				: null;

			expect(customer).toBeNull();
			expect(subscription).toBeNull();
			expect(anagraphic?.email).toBe("resolve-free-user@test.local");
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-resolve-free",
				expect.objectContaining({
					method: "PATCH",
				}),
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("returns an existing external_id without consuming the auth write rate limit", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-resolve-existing-external-id",
				displayName: "Resolve Existing External ID",
				email: "resolve-existing-external-id@test.local",
			}),
		);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-existing-external-id" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_existing_external_id" as never);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-existing-external-id",
				name: "Resolve Existing External ID",
				email: "resolve-existing-external-id@test.local",
				external_id: seeded.userId,
			});

			for (let index = 0; index < 3; index++) {
				const response = await asUser.fetch("/api/auth/resolve-user", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({}),
				});
				const body = await response.json();

				expect(response.status).toBe(200);
				expect(body._yay?.userId).toBe(seeded.userId);
				expect(body._yay?.restoredDeletedAccount).toBe(false);
			}

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(enqueueActionSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("repairs a stale external_id after the referenced user doc is gone", async () => {
		const t = test_convex();
		const stale = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-resolve-stale-external-id-old",
				displayName: "Resolve Stale External ID Old",
				email: "resolve-stale-external-id-old@test.local",
			}),
		);
		await t.run(async (ctx) => {
			await Promise.all([ctx.db.delete("users_anagraphics", stale.anagraphicId), ctx.db.delete("users", stale.userId)]);
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-stale-external-id" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_stale_external_id" as never);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-stale-external-id",
				name: "Resolve Stale External ID",
				email: "resolve-stale-external-id@test.local",
				external_id: stale.userId,
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body._yay?.userId).toBeDefined();
			expect(body._yay?.userId).not.toBe(stale.userId);
			expect(body._yay?.restoredDeletedAccount).toBe(false);
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-resolve-stale-external-id",
				expect.objectContaining({
					method: "PATCH",
				}),
			);
			expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.bootstrap_free_subscription, {
				userId: body._yay.userId,
				email: "resolve-stale-external-id@test.local",
				name: "Resolve Stale External ID",
			});

			const user = await t.run((ctx) => ctx.db.get("users", body._yay.userId));

			expect(user?.clerkUserId).toBe("clerk-user-resolve-stale-external-id");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("passes the restore flag to Free subscription bootstrap after reclaiming a tombstoned account", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-resolve-restore-free",
				displayName: "Resolve Restore User",
				email: "resolve-restore-user@test.local",
			}),
		);
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.init_user_deletion, {
				userId: seeded.userId,
				nowTs: 30_001,
			}),
		);

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_resolve_restore_free" as never);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-restore-free-again" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-restore-free-again",
				name: "Resolve Restore User Again",
				email: "resolve-restore-user@test.local",
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body._yay?.userId).toBe(seeded.userId);
			expect(body._yay?.restoredDeletedAccount).toBe(true);
			expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.bootstrap_free_subscription, {
				userId: seeded.userId,
				email: "resolve-restore-user@test.local",
				name: "Resolve Restore User Again",
				restoreCanceledSubscription: true,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps sign-in successful when enqueueing Free bootstrap fails", async () => {
		const t = test_convex();

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockRejectedValue(new Error("enqueue free bootstrap exploded"));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-free-failure" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-free-failure",
				name: "Resolve Free Failure User",
				email: "resolve-free-failure-user@test.local",
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body._yay?.userId).toBeDefined();
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to enqueue Free subscription bootstrap",
				expect.objectContaining({
					clerkUserId: "clerk-user-resolve-free-failure",
				}),
			);
			expect(enqueueActionSpy).toHaveBeenCalled();

			const subscription = await t.query(components.polar.lib.getCurrentSubscription, {
				userId: body._yay.userId,
			});
			expect(subscription).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("returns 400 when the Clerk identity has no email", async () => {
		const t = test_convex();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-missing-email" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-missing-email",
				name: "Resolve Missing Email User",
				email: undefined,
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(400);
			expect(body._nay?.message).toBe("Signed-in user email is required");

			const user = await t.run((ctx) =>
				ctx.db
					.query("users")
					.withIndex("by_clerkUser", (q) => q.eq("clerkUserId", "clerk-user-resolve-missing-email"))
					.first(),
			);

			expect(user).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("returns 400 when a different live user already owns the email", async () => {
		const t = test_convex();
		const existingUser = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-resolve-email-owner",
				displayName: "Existing Email Owner",
				email: "resolve-email-conflict@test.local",
			}),
		);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id: "clerk-user-resolve-email-conflict" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				subject: "clerk-user-resolve-email-conflict",
				name: "Resolve Email Conflict User",
				email: "Resolve-Email-Conflict@Test.Local",
			});

			const response = await asUser.fetch("/api/auth/resolve-user", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			});
			const body = await response.json();

			expect(response.status).toBe(400);
			expect(body._nay?.message).toBe("Email is already linked to another user");

			const after = await t.run(async (ctx) => {
				const [ownerUser, conflictingUser, anagraphic] = await Promise.all([
					ctx.db.get("users", existingUser.userId),
					ctx.db
						.query("users")
						.withIndex("by_clerkUser", (q) => q.eq("clerkUserId", "clerk-user-resolve-email-conflict"))
						.first(),
					ctx.db.get("users_anagraphics", existingUser.anagraphicId),
				]);

				return {
					ownerUser,
					conflictingUser,
					anagraphic,
				};
			});

			expect(after.ownerUser?.clerkUserId).toBe("clerk-user-resolve-email-owner");
			expect(after.conflictingUser).toBeNull();
			expect(after.anagraphic?.email).toBe("resolve-email-conflict@test.local");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("resolve_user", () => {
	test("stores the normalized email on the existing live Clerk-linked user", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-existing-live-email",
				displayName: "Existing Live User",
			}),
		);

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-existing-live-email",
				email: " Existing-Live-Email@Test.Local ",
				displayName: "Existing Live User Updated",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const [user, anagraphic] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db.get("users_anagraphics", seeded.anagraphicId),
			]);

			return {
				user,
				anagraphic,
			};
		});

		expect(result._yay.userId).toBe(seeded.userId);
		expect(after.user?.clerkUserId).toBe("clerk-user-existing-live-email");
		expect(after.anagraphic?.displayName).toBe("Existing Live User Updated");
		expect(after.anagraphic?.email).toBe("existing-live-email@test.local");
	});

	test("upgrades the anonymous user in place and stores the normalized email", async () => {
		const t = test_convex();
		await users_test_seed_product(t, {
			polarProductId: "users_anonymous_upgrade_free_product",
			name: billing_PRODUCTS.Free.name,
		});
		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-resolve-anonymous-email",
				email: " Resolve-Anonymous-Email@Test.Local ",
				anonymousUserToken: anonymousPayload.token,
				displayName: "Resolved Anonymous User",
			}),
		);
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		const after = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", anonymousPayload.userId);
			const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;

			return {
				user,
				anagraphic,
			};
		});

		expect(result._yay.userId).toBe(anonymousPayload.userId);
		expect(after.user?.clerkUserId).toBe("clerk-user-resolve-anonymous-email");
		expect(after.user?.anonymousAuthToken).toBeUndefined();
		expect(after.anagraphic?.displayName).toBe("Resolved Anonymous User");
		expect(after.anagraphic?.email).toBe("resolve-anonymous-email@test.local");
	});

	test("rate-limits anonymous user creation by forwarded client key", async () => {
		const t = test_convex();
		await users_test_seed_product(t, {
			polarProductId: "users_anonymous_rate_limit_free_product",
			name: billing_PRODUCTS.Free.name,
		});

		for (let i = 0; i < 2; i++) {
			const response = await t.fetch("/api/auth/anonymous", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-forwarded-for": "203.0.113.10",
				},
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(200);
		}

		const blocked = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-forwarded-for": "203.0.113.10",
			},
			body: JSON.stringify({}),
		});
		const blockedBody = await blocked.json();
		const users = await t.run((ctx) => ctx.db.query("users").collect());

		expect(blocked.status).toBe(429);
		expect(blockedBody.message).toBe("Rate limit exceeded");
		expect(typeof blockedBody.retryAfterMs).toBe("number");
		expect(users).toHaveLength(2);
	});

	test("allows stale anonymous token recovery by rejecting refresh before clean anonymous creation", async () => {
		const t = test_convex();
		await users_test_seed_product(t, {
			polarProductId: "users_anonymous_stale_recovery_free_product",
			name: billing_PRODUCTS.Free.name,
		});

		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		await t.run(async (ctx) => {
			await ctx.db.delete("users", anonymousPayload.userId);
		});

		const refreshResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ token: anonymousPayload.token }),
		});
		const freshResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const freshPayload = (await freshResponse.json()) as { token: string; userId: Id<"users"> };

		const after = await t.run(async (ctx) => {
			const [oldUser, freshUser] = await Promise.all([
				ctx.db.get("users", anonymousPayload.userId),
				ctx.db.get("users", freshPayload.userId),
			]);

			return {
				oldUser,
				freshUser,
			};
		});

		expect(refreshResponse.status).toBe(401);
		expect(freshResponse.status).toBe(200);
		expect(freshPayload.userId).not.toBe(anonymousPayload.userId);
		expect(freshPayload.token).not.toBe(anonymousPayload.token);
		expect(after.oldUser).toBeNull();
		expect(after.freshUser?._id).toBe(freshPayload.userId);
	});

	test("returns a conflict when another live user already owns the email and leaves the anonymous user untouched", async () => {
		const t = test_convex();
		const existingUser = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-resolve-conflict-owner",
				displayName: "Resolve Conflict Owner",
				email: "resolve-internal-conflict@test.local",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_anonymous_conflict_free_product",
			name: billing_PRODUCTS.Free.name,
		});
		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-resolve-conflict",
				email: " Resolve-Internal-Conflict@Test.Local ",
				anonymousUserToken: anonymousPayload.token,
				displayName: "Resolve Conflict User",
			}),
		);

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Email is already linked to another user");

		const after = await t.run(async (ctx) => {
			const [ownerUser, anonymousUser, conflictingUser, ownerAnagraphic] = await Promise.all([
				ctx.db.get("users", existingUser.userId),
				ctx.db.get("users", anonymousPayload.userId),
				ctx.db
					.query("users")
					.withIndex("by_clerkUser", (q) => q.eq("clerkUserId", "clerk-user-resolve-conflict"))
					.first(),
				ctx.db.get("users_anagraphics", existingUser.anagraphicId),
			]);

			return {
				ownerUser,
				anonymousUser,
				conflictingUser,
				ownerAnagraphic,
			};
		});

		expect(after.ownerUser?.clerkUserId).toBe("clerk-user-resolve-conflict-owner");
		expect(after.ownerAnagraphic?.email).toBe("resolve-internal-conflict@test.local");
		expect(after.anonymousUser?._id).toBe(anonymousPayload.userId);
		expect(after.anonymousUser?.clerkUserId).toBeNull();
		expect(after.anonymousUser?.anonymousAuthToken).toBeDefined();
		expect(after.conflictingUser).toBeNull();
	});
});

describe("list_current_user_account_deletion_blocking_organizations", () => {
	test("returns only owned non-default organizations at default-workspace scope", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-blocker-owner",
				displayName: "Account Delete Blocker Owner",
				email: "account-delete-blocker-owner@test.local",
			}),
		);
		const collaborator = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-blocker-collaborator",
				displayName: "Account Delete Blocker Collaborator",
				email: "account-delete-blocker-collaborator@test.local",
			}),
		);
		const workspaceOwner = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-blocker-workspace-owner",
				displayName: "Account Delete Blocker Workspace Owner",
				email: "account-delete-blocker-workspace-owner@test.local",
			}),
		);

		const organizations = await t.run(async (ctx) => {
			const now = Date.now();
			const ownedOrganization = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "owned-blocker",
				description: "",
				now,
				default: false,
			});
			if (ownedOrganization._nay) {
				throw new Error(ownedOrganization._nay.message);
			}

			const sharedOrganization = await organizations_db_create(ctx, {
				userId: collaborator.userId,
				name: "shared-member",
				description: "",
				now,
				default: false,
			});
			if (sharedOrganization._nay) {
				throw new Error(sharedOrganization._nay.message);
			}
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: sharedOrganization._yay.organizationId,
				workspaceId: sharedOrganization._yay.defaultWorkspaceId,
				userId: owner.userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: sharedOrganization._yay.organizationId,
				workspaceId: sharedOrganization._yay.defaultWorkspaceId,
				userId: owner.userId,
				role: "member",
				now,
			});

			const workspaceScopedOrganization = await organizations_db_create(ctx, {
				userId: workspaceOwner.userId,
				name: "workspace-owner",
				description: "",
				now,
				default: false,
			});
			if (workspaceScopedOrganization._nay) {
				throw new Error(workspaceScopedOrganization._nay.message);
			}
			const workspaceScopedWorkspace = await organizations_db_create_workspace(ctx, {
				userId: workspaceOwner.userId,
				organizationId: workspaceScopedOrganization._yay.organizationId,
				name: "ws-local-owner",
				description: "",
				now,
			});
			if (workspaceScopedWorkspace._nay) {
				throw new Error(workspaceScopedWorkspace._nay.message);
			}
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: workspaceScopedOrganization._yay.organizationId,
				workspaceId: workspaceScopedWorkspace._yay.workspaceId,
				userId: owner.userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: workspaceScopedOrganization._yay.organizationId,
				workspaceId: workspaceScopedWorkspace._yay.workspaceId,
				userId: owner.userId,
				role: "owner",
				now,
			});

			await test_mocks_cancel_pending_home_file_seeds(ctx);

			return {
				ownedOrganization: ownedOrganization._yay,
				sharedOrganization: sharedOrganization._yay,
				workspaceScopedOrganization: workspaceScopedOrganization._yay,
			};
		});

		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-blocker-owner",
			external_id: owner.userId,
			name: "Account Delete Blocker Owner",
			email: "account-delete-blocker-owner@test.local",
		});

		const blockers = await asOwner.query(api.users.list_current_user_account_deletion_blocking_organizations, {});

		expect(blockers.map((blocker) => blocker.organization.name)).toEqual(["owned-blocker"]);
		expect(blockers[0]?.organization._id).toBe(organizations.ownedOrganization.organizationId);
		expect(blockers[0]?.defaultWorkspace._id).toBe(organizations.ownedOrganization.defaultWorkspaceId);
		expect(
			blockers.some((blocker) => blocker.organization._id === organizations.sharedOrganization.organizationId),
		).toBe(false);
		expect(
			blockers.some((blocker) => blocker.organization._id === organizations.workspaceScopedOrganization.organizationId),
		).toBe(false);
	});
});

describe("delete_current_user_account", () => {
	test("deletes the account after organization ownership transfers through the access-control endpoint", async () => {
		const t = test_convex();
		const owner = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-transfer-owner",
				displayName: "Delete Transfer Owner",
				email: "delete-transfer-owner@test.local",
			}),
		);
		const collaborator = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-transfer-collaborator",
				displayName: "Delete Transfer Collaborator",
				email: "delete-transfer-collaborator@test.local",
			}),
		);

		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: owner.userId,
				name: "delete-transfer",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: collaborator.userId,
				active: true,
			});

			await test_mocks_cancel_pending_home_file_seeds(ctx);

			return created._yay;
		});

		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-transfer-owner",
			external_id: owner.userId,
			name: "Delete Transfer Owner",
			email: "delete-transfer-owner@test.local",
		});

		const transferResult = await asOwner.mutation(api.access_control.transfer_organization_ownership, {
			organizationId: organization.organizationId,
			newOwnerUserId: collaborator.userId,
		});

		expect(transferResult._nay).toBeUndefined();
		const after = await t.run(async (ctx) => {
			const [ownerRole, collaboratorQuota] = await Promise.all([
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_role_user", (q) =>
						q
							.eq("organizationId", organization.organizationId)
							.eq("workspaceId", organization.defaultWorkspaceId)
							.eq("role", "owner"),
					)
					.first(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) =>
						q.eq("userId", collaborator.userId).eq("quotaName", "extra_organizations"),
					)
					.first(),
			]);

			return { ownerRole, collaboratorQuota };
		});

		expect(after.ownerRole?.userId).toBe(collaborator.userId);
		expect(after.collaboratorQuota?.usedCount).toBe(1);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);

		try {
			const deleteResult = await asOwner.action(api.users.delete_current_user_account, {});

			expect(deleteResult._nay).toBeUndefined();
			const afterDeletion = await t.run(async (ctx) => {
				const [user, ownerRole, organizationRequests] = await Promise.all([
					ctx.db.get("users", owner.userId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_role_user", (q) =>
							q
								.eq("organizationId", organization.organizationId)
								.eq("workspaceId", organization.defaultWorkspaceId)
								.eq("role", "owner"),
						)
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_organization_scope", (q) =>
							q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
						)
						.collect(),
				]);

				return { user, ownerRole, organizationRequests };
			});

			expect(afterDeletion.user?.deletedAt).toBeTypeOf("number");
			expect(afterDeletion.ownerRole?.userId).toBe(collaborator.userId);
			expect(afterDeletion.organizationRequests).toHaveLength(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("returns Unauthenticated when no authenticated identity is present", async () => {
		const t = test_convex();

		const result = await t.action(api.users.delete_current_user_account, {});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Unauthenticated");
	});

	test("returns Unauthenticated when Clerk external_id is not set yet", async () => {
		const t = test_convex();
		const asSignedInWithoutExternalId = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-without-external-id",
			name: "Delete Unresolved Clerk User",
		});

		const result = await asSignedInWithoutExternalId.action(api.users.delete_current_user_account, {});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Unauthenticated");
	});

	test("blocks account deletion while non-personal organization ownership remains", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-owned-delete",
				displayName: "Delete Owned Organization",
				email: "delete-owned-organization@test.local",
			}),
		);
		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: seeded.userId,
				name: "delete-owned",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await test_mocks_cancel_pending_home_file_seeds(ctx);

			return created._yay;
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-owned-delete",
			external_id: seeded.userId,
			name: "Delete Owned Organization",
			email: "delete-owned-organization@test.local",
		});

		const result = await asUser.action(api.users.delete_current_user_account, {});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Resolve owned organizations before deleting account");
		const after = await t.run(async (ctx) => {
			const [user, ownerRoles, memberships, organizationRequests, ownerQuota] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_role_user", (q) =>
						q
							.eq("organizationId", organization.organizationId)
							.eq("workspaceId", organization.defaultWorkspaceId)
							.eq("role", "owner"),
					)
					.collect(),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_organization_workspace_user", (q) =>
						q.eq("active", true).eq("organizationId", organization.organizationId),
					)
					.collect(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_scope", (q) =>
						q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
					)
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", seeded.userId).eq("quotaName", "extra_organizations"))
					.first(),
			]);

			return { user, ownerRoles, memberships, organizationRequests, ownerQuota };
		});

		expect(after.user?.deletedAt).toBeUndefined();
		expect(after.ownerRoles).toHaveLength(1);
		expect(after.memberships).toHaveLength(1);
		expect(after.organizationRequests).toHaveLength(0);
		expect(after.ownerQuota?.usedCount).toBe(1);
	});

	test("deletes the account after owned organizations are deleted through the organization endpoint", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-after-organization-delete",
				displayName: "Delete After Organization Delete",
				email: "delete-after-organization-delete@test.local",
			}),
		);
		const organization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: seeded.userId,
				name: "delete-after-ws",
				description: "",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await test_mocks_cancel_pending_home_file_seeds(ctx);

			return created._yay;
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-after-organization-delete",
			external_id: seeded.userId,
			name: "Delete After Organization Delete",
			email: "delete-after-organization-delete@test.local",
		});

		const deleteOrganizationResult = await asUser.mutation(api.organizations.delete_organization, {
			organizationId: organization.organizationId,
		});

		expect(deleteOrganizationResult._nay).toBeUndefined();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);

		try {
			const deleteAccountResult = await asUser.action(api.users.delete_current_user_account, {});

			expect(deleteAccountResult._nay).toBeUndefined();
			const after = await t.run(async (ctx) => {
				const [user, ownerRoles, organizationRequests] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_role_user", (q) =>
							q
								.eq("organizationId", organization.organizationId)
								.eq("workspaceId", organization.defaultWorkspaceId)
								.eq("role", "owner"),
						)
						.collect(),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_organization_scope", (q) =>
							q.eq("organizationId", organization.organizationId).eq("scope", "organization"),
						)
						.collect(),
				]);

				return { user, ownerRoles, organizationRequests };
			});

			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.ownerRoles).toHaveLength(0);
			expect(after.organizationRequests).toHaveLength(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("deletes the Clerk user, schedules the current subscription for period-end cancellation, and processes the local tombstone flow", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete",
				displayName: "Delete Action User",
				email: "delete-action-user@test.local",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_delete_account_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_delete_account",
			subscriptionId: "sub_users_delete_account",
			polarProductId: "users_delete_account_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_delete_account",
				subscription: null,
				meter: null,
				lastSyncedAt: 12_345,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete",
			external_id: seeded.userId,
			name: "Delete Action User",
			email: "delete-action-user@test.local",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_delete_current_user_account" as never);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					anagraphic,
					billingJob,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db.get("users_anagraphics", seeded.anagraphicId),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					anagraphic,
					billingJob,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.organization).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_delete_account");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.anagraphic?.email).toBe("delete-action-user@test.local");
			expect(after.billingJob?.jobId).toBe("work_delete_current_user_account");
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-account-delete",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.billing.cancel_polar_subscription_at_period_end,
				{
					userId: seeded.userId,
					subscriptionId: "sub_users_delete_account",
				},
				{
					context: {
						userId: seeded.userId,
					},
					onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
				},
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("treats Clerk 404 as success and still schedules period-end cancellation during the local tombstone flow", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-404",
				displayName: "Delete Missing Clerk User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_delete_account_404_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_delete_account_404",
			subscriptionId: "sub_users_delete_account_404",
			polarProductId: "users_delete_account_404_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_delete_account_404",
				subscription: null,
				meter: null,
				lastSyncedAt: 54_321,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-404",
			external_id: seeded.userId,
			name: "Delete Missing Clerk User",
			email: "delete-missing-clerk-user@test.local",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 404,
				statusText: "Not Found",
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_delete_404" as never);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.organization).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_delete_account_404");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob?.jobId).toBe("work_delete_404");
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-account-delete-404",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.billing.cancel_polar_subscription_at_period_end,
				{
					userId: seeded.userId,
					subscriptionId: "sub_users_delete_account_404",
				},
				{
					context: {
						userId: seeded.userId,
					},
					onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
				},
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps the local tombstone when Clerk cleanup fails", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-failure",
				displayName: "Delete Clerk Failure User",
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-failure",
			external_id: seeded.userId,
			name: "Delete Clerk Failure User",
			email: "delete-clerk-failure-user@test.local",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "boom" }), {
				status: 500,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, purgeRequests, memberships, organization, workspace] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBe("clerk-user-account-delete-failure");
			expect(after.request).not.toBeNull();
			expect(after.organization).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps the local tombstone and subscription mirror when cancellation scheduling fails", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-polar-failure",
				displayName: "Delete Polar Failure User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_delete_account_polar_failure_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_delete_account_polar_failure",
			subscriptionId: "sub_users_delete_account_polar_failure",
			polarProductId: "users_delete_account_polar_failure_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_delete_account_polar_failure",
				subscription: null,
				meter: null,
				lastSyncedAt: 88_888,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-polar-failure",
			external_id: seeded.userId,
			name: "Delete Polar Failure User",
			email: "delete-polar-failure-user@test.local",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockRejectedValue(new Error("enqueue period-end cancellation exploded"));

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, snapshots, customer, subscriptions, billingJob] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					request,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_delete_account_polar_failure");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob).toBeNull();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.billing.cancel_polar_subscription_at_period_end,
				{
					userId: seeded.userId,
					subscriptionId: "sub_users_delete_account_polar_failure",
				},
				{
					context: {
						userId: seeded.userId,
					},
					onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
				},
			);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"Failed to schedule Polar subscription period-end cancellation after local deletion",
				expect.objectContaining({
					subscriptionId: "sub_users_delete_account_polar_failure",
					userId: seeded.userId,
				}),
			);
		} finally {
			consoleErrorSpy.mockRestore();
			fetchSpy.mockRestore();
		}
	});

	test("runs local tombstone flow for anonymous JWT, skips Clerk delete, and schedules period-end cancellation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_anonymous_user(ctx, {
				displayName: "Anonymous Delete User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_delete_account_anonymous_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_delete_account_anonymous",
			subscriptionId: "sub_users_delete_account_anonymous",
			polarProductId: "users_delete_account_anonymous_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_delete_account_anonymous",
				subscription: null,
				meter: null,
				lastSyncedAt: 99_999,
			}),
		);

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous Delete User",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_delete_anonymous" as never);

		try {
			const result = await asAnonymous.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.organization).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_delete_account_anonymous");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob?.jobId).toBe("work_delete_anonymous");
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.billing.cancel_polar_subscription_at_period_end,
				{
					userId: seeded.userId,
					subscriptionId: "sub_users_delete_account_anonymous",
				},
				{
					context: {
						userId: seeded.userId,
					},
					onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
				},
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("reclaims the tombstoned user and marks it for billing restore without scheduling a second cancellation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-restore",
				displayName: "Delete Restore User",
				email: "delete-restore-user@test.local",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_delete_account_restore_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_delete_account_restore",
			subscriptionId: "sub_users_delete_account_restore",
			polarProductId: "users_delete_account_restore_product",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-restore",
			external_id: seeded.userId,
			name: "Delete Restore User",
			email: "delete-restore-user@test.local",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_restore" as never);

		try {
			const deleteResult = await asUser.action(api.users.delete_current_user_account, {});
			expect(deleteResult._nay).toBeUndefined();

			const restoreResult = await t.run((ctx) =>
				ctx.runMutation(internal.users.resolve_user, {
					clerkUserId: "clerk-user-account-delete-restore-again",
					email: "delete-restore-user@test.local",
					displayName: "Delete Restore User Again",
				}),
			);
			if (restoreResult._nay) {
				throw new Error(restoreResult._nay.message);
			}

			const after = await t.run(async (ctx) => {
				const [user, request, memberships] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
				]);

				return {
					user,
					request,
					memberships,
				};
			});

			expect(restoreResult._yay.userId).toBe(seeded.userId);
			expect(restoreResult._yay.restoredDeletedAccount).toBe(true);
			expect(after.user?.deletedAt).toBeUndefined();
			expect(after.user?.clerkUserId).toBe("clerk-user-account-delete-restore-again");
			expect(after.request).toBeNull();
			expect(after.memberships.every((membership) => membership.active !== false)).toBe(true);
			expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("hard_delete_user_now", () => {
	test("defaults to data-only reset and preserves the live account shell", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete",
				displayName: "Hard Delete User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete",
			subscriptionId: "sub_users_hard_delete",
			polarProductId: "users_hard_delete_product",
		});
		await t.run((ctx) =>
			Promise.all([
				users_test_seed_page(ctx, {
					userId: seeded.userId,
					organizationId: seeded.defaultOrganizationId,
					workspaceId: seeded.defaultWorkspaceId,
					tag: "hard-delete-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: seeded.userId,
					polarCustomerId: "cust_users_hard_delete",
					subscription: null,
					meter: null,
					lastSyncedAt: 11_111,
				}),
			]),
		);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_hard_delete" as never);

		try {
			const result = await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
			});

			const after = await t.run(async (ctx) => {
				const [
					user,
					anagraphic,
					organization,
					workspace,
					membership,
					ownerRole,
					requests,
					files,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db.get("users_anagraphics", seeded.anagraphicId),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_user_organization_workspace", (q) =>
							q
								.eq("active", true)
								.eq("userId", seeded.userId)
								.eq("organizationId", seeded.defaultOrganizationId)
								.eq("workspaceId", seeded.defaultWorkspaceId),
						)
						.first(),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_user_role", (q) =>
							q
								.eq("organizationId", seeded.defaultOrganizationId)
								.eq("workspaceId", seeded.defaultWorkspaceId)
								.eq("userId", seeded.userId)
								.eq("role", "owner"),
						)
						.first(),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.organizationId === seeded.defaultOrganizationId)),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					anagraphic,
					organization,
					workspace,
					membership,
					ownerRole,
					requests,
					files,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(result).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(enqueueActionSpy).not.toHaveBeenCalled();
			expect(after.user?.deletedAt).toBeUndefined();
			expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete");
			expect(after.user?.defaultOrganizationId).toBe(seeded.defaultOrganizationId);
			expect(after.user?.defaultWorkspaceId).toBe(seeded.defaultWorkspaceId);
			expect(after.anagraphic?.displayName).toBe("Hard Delete User");
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.membership?._id).toBeDefined();
			expect(after.ownerRole?._id).toBeDefined();
			expect(after.requests).toHaveLength(0);
			expect(after.files).toHaveLength(0);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("requests Polar customer deletion and clears any scheduled billing cancellation when purgeUserMod removes the user record", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-delete-polar",
				displayName: "Hard Delete Delete Polar User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_delete_polar_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_delete_polar",
			subscriptionId: "sub_users_hard_delete_delete_polar",
			polarProductId: "users_hard_delete_delete_polar_product",
		});
		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId: seeded.userId,
			jobId: "work_hard_delete_delete_polar_existing" as WorkId,
			updatedAt: 77_777,
		});

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => users_test_remote_delete_response(input));
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);

		try {
			await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
				purgeUserMod: "data_auth_and_user_record",
			});

			const after = await t.run(async (ctx) => {
				const [user, customer, subscriptions, customerSubscriptions, billingJob] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listCustomerSubscriptions, {
						customerId: "cust_users_hard_delete_delete_polar",
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					customer,
					subscriptions,
					customerSubscriptions,
					billingJob,
				};
			});

			expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_hard_delete_delete_polar_existing");
			expect(fetchSpy.mock.calls.map(([input]) => users_test_fetch_url(input))).toEqual([
				expect.stringContaining("/v1/subscriptions/sub_users_hard_delete_delete_polar"),
				expect.stringContaining("/v1/customers/cust_users_hard_delete_delete_polar?anonymize=false"),
				"https://api.clerk.com/v1/users/clerk-user-hard-delete-delete-polar",
			]);
			expect(after.user).toBeNull();
			expect(after.customer?.id).toBe("cust_users_hard_delete_delete_polar");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.customerSubscriptions).toHaveLength(1);
			expect(after.billingJob).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("purges the final user tombstone and removes the Polar customer when purgeUserMod removes the user record", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-purge",
				displayName: "Hard Delete Purge User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_purge_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_purge",
			subscriptionId: "sub_users_hard_delete_purge",
			polarProductId: "users_hard_delete_purge_product",
		});
		await t.run((ctx) =>
			Promise.all([
				users_test_seed_page(ctx, {
					userId: seeded.userId,
					organizationId: seeded.defaultOrganizationId,
					workspaceId: seeded.defaultWorkspaceId,
					tag: "hard-delete-purge-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: seeded.userId,
					polarCustomerId: "cust_users_hard_delete_purge",
					subscription: null,
					meter: null,
					lastSyncedAt: 66_666,
				}),
			]),
		);

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => users_test_remote_delete_response(input));

		try {
			await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
				purgeUserMod: "data_auth_and_user_record",
			});

			const after = await t.run(async (ctx) => {
				const [
					user,
					anagraphic,
					requests,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					customerSubscriptions,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db.get("users_anagraphics", seeded.anagraphicId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listCustomerSubscriptions, {
						customerId: "cust_users_hard_delete_purge",
					}),
				]);

				return {
					user,
					anagraphic,
					requests,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					customerSubscriptions,
				};
			});

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-hard-delete-purge",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
			expect(fetchSpy.mock.calls.map(([input]) => users_test_fetch_url(input))).toEqual([
				expect.stringContaining("/v1/subscriptions/sub_users_hard_delete_purge"),
				expect.stringContaining("/v1/customers/cust_users_hard_delete_purge?anonymize=false"),
				"https://api.clerk.com/v1/users/clerk-user-hard-delete-purge",
			]);
			expect(after.user).toBeNull();
			expect(after.anagraphic).toBeNull();
			expect(after.requests).toHaveLength(1);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.snapshots).toHaveLength(0);
			expect(after.customer?.id).toBe("cust_users_hard_delete_purge");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.customerSubscriptions).toHaveLength(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("treats Clerk 404 as success and still schedules period-end cancellation when purgeUserMod removes auth", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-404",
				displayName: "Hard Delete Missing Remote User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_404_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_404",
			subscriptionId: "sub_users_hard_delete_404",
			polarProductId: "users_hard_delete_404_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_hard_delete_404",
				subscription: null,
				meter: null,
				lastSyncedAt: 22_222,
			}),
		);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 404,
				statusText: "Not Found",
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_hard_delete_404" as never);

		try {
			await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
				purgeUserMod: "data_and_auth",
			});

			const after = await t.run(async (ctx) => {
				const [user, requests, organization, workspace, snapshots, customer, subscriptions, billingJob] =
					await Promise.all([
						ctx.db.get("users", seeded.userId),
						ctx.db.query("data_deletion_requests").collect(),
						ctx.db.get("organizations", seeded.defaultOrganizationId),
						ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
						ctx.db
							.query("billing_usage_snapshots")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.collect(),
						ctx.runQuery(components.polar.lib.getCustomerByUserId, {
							userId: seeded.userId,
						}),
						ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
							userId: seeded.userId,
						}),
						ctx.db
							.query("billing_cancel_polar_subscription_jobs")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.first(),
					]);

				return {
					user,
					requests,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.billing.cancel_polar_subscription_at_period_end,
				{
					userId: seeded.userId,
					subscriptionId: "sub_users_hard_delete_404",
				},
				{
					context: {
						userId: seeded.userId,
					},
					onComplete: internal.billing.complete_polar_subscription_period_end_cancellation,
				},
			);
			expect(enqueueActionSpy).toHaveBeenCalledWith(
				expect.anything(),
				internal.data_deletion.process_deletion_requests,
				{},
			);
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.requests).toHaveLength(1);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete_404");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob?.jobId).toBe("work_hard_delete_404");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps the local tombstone when Clerk deletion fails during auth purge", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-failure",
				displayName: "Hard Delete Clerk Failure User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_failure_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_failure",
			subscriptionId: "sub_users_hard_delete_failure",
			polarProductId: "users_hard_delete_failure_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_hard_delete_failure",
				subscription: null,
				meter: null,
				lastSyncedAt: 33_333,
			}),
		);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "boom" }), {
				status: 500,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			await expect(
				t.action(internal.users.hard_delete_user_now, {
					userId: seeded.userId,
					purgeUserMod: "data_and_auth",
				}),
			).rejects.toThrow("Failed to delete Clerk user");

			const after = await t.run(async (ctx) => {
				const [user, requests, organization, workspace, snapshots, customer, subscriptions] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
				]);

				return {
					user,
					requests,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
				};
			});

			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-failure");
			expect(after.requests).toHaveLength(0);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete_failure");
			expect(after.subscriptions).toHaveLength(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("stops before Clerk deletion when period-end cancellation cannot be enqueued", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-cancellation-failure",
				displayName: "Hard Delete Cancellation Failure User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_cancellation_failure_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_cancellation_failure",
			subscriptionId: "sub_users_hard_delete_cancellation_failure",
			polarProductId: "users_hard_delete_cancellation_failure_product",
		});
		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId: seeded.userId,
			jobId: "work_hard_delete_cancellation_failure_existing" as WorkId,
			updatedAt: 66_666,
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => users_test_remote_delete_response(input));
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		vi.spyOn(Workpool.prototype, "enqueueAction").mockRejectedValue(new Error("workpool unavailable"));

		try {
			await expect(
				t.action(internal.users.hard_delete_user_now, {
					userId: seeded.userId,
					purgeUserMod: "data_and_auth",
				}),
			).rejects.toThrow("workpool unavailable");

			const after = await t.run(async (ctx) => {
				const [user, billingJob, activeMembership] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_user_organization_workspace", (q) =>
							q
								.eq("active", true)
								.eq("userId", seeded.userId)
								.eq("organizationId", seeded.defaultOrganizationId)
								.eq("workspaceId", seeded.defaultWorkspaceId),
						)
						.first(),
				]);
				return { user, billingJob, activeMembership };
			});

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(cancelSpy).toHaveBeenCalledWith(
				expect.anything(),
				"work_hard_delete_cancellation_failure_existing",
			);
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-cancellation-failure");
			expect(after.billingJob?.jobId).toBe("work_hard_delete_cancellation_failure_existing");
			expect(after.activeMembership).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("tombstones locally before immediate subscription revoke during purge", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-polar-failure",
				displayName: "Hard Delete Polar Failure User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_polar_failure_product",
		});
		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId: seeded.userId,
			jobId: "work_hard_delete_polar_failure" as WorkId,
			updatedAt: 44_443,
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_polar_failure",
			subscriptionId: "sub_users_hard_delete_polar_failure",
			polarProductId: "users_hard_delete_polar_failure_product",
		});
		await t.run((ctx) =>
			ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_hard_delete_polar_failure",
				subscription: null,
				meter: null,
				lastSyncedAt: 44_444,
			}),
		);

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 400 }));
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);

		try {
			await expect(
				t.action(internal.users.hard_delete_user_now, {
					userId: seeded.userId,
					purgeUserMod: "data_auth_and_user_record",
				}),
			).rejects.toThrow("Failed to revoke Polar subscription");

			const after = await t.run(async (ctx) => {
				const [user, requests, organization, workspace, snapshots, customer, subscriptions, billingJob] =
					await Promise.all([
						ctx.db.get("users", seeded.userId),
						ctx.db.query("data_deletion_requests").collect(),
						ctx.db.get("organizations", seeded.defaultOrganizationId),
						ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
						ctx.db
							.query("billing_usage_snapshots")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.collect(),
						ctx.runQuery(components.polar.lib.getCustomerByUserId, {
							userId: seeded.userId,
						}),
						ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
							userId: seeded.userId,
						}),
						ctx.db
							.query("billing_cancel_polar_subscription_jobs")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.first(),
					]);

				return {
					user,
					requests,
					organization,
					workspace,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(fetchSpy.mock.calls.map(([input]) => users_test_fetch_url(input))).toEqual([
				expect.stringContaining("/v1/subscriptions/sub_users_hard_delete_polar_failure"),
			]);
			expect(cancelSpy).not.toHaveBeenCalled();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-polar-failure");
			expect(after.requests).toHaveLength(0);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete_polar_failure");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob?.jobId).toBe("work_hard_delete_polar_failure");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("tombstones locally before Polar customer deletion during purge", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-delete-polar-failure",
				displayName: "Hard Delete Delete Polar Failure User",
			}),
		);
		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_users_hard_delete_delete_polar_failure",
			userId: seeded.userId,
		});
		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId: seeded.userId,
			jobId: "work_hard_delete_delete_polar_failure" as WorkId,
			updatedAt: 55_554,
		});

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 400 }));
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);

		try {
			await expect(
				t.action(internal.users.hard_delete_user_now, {
					userId: seeded.userId,
					purgeUserMod: "data_auth_and_user_record",
				}),
			).rejects.toThrow("Failed to delete Polar customer");

			const after = await t.run(async (ctx) => {
				const [user, requests, organization, workspace, customer, billingJob] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					requests,
					organization,
					workspace,
					customer,
					billingJob,
				};
			});

			expect(fetchSpy.mock.calls.map(([input]) => users_test_fetch_url(input))).toEqual([
				expect.stringContaining("/v1/customers/cust_users_hard_delete_delete_polar_failure?anonymize=false"),
			]);
			expect(cancelSpy).not.toHaveBeenCalled();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.requests).toHaveLength(0);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.customer?.id).toBe("cust_users_hard_delete_delete_polar_failure");
			expect(after.billingJob?.jobId).toBe("work_hard_delete_delete_polar_failure");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("resets a user whose scheduled deletion was already initialized", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-hard-delete-initialized",
				displayName: "Hard Delete Initialized User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_initialized_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_initialized",
			subscriptionId: "sub_users_hard_delete_initialized",
			polarProductId: "users_hard_delete_initialized_product",
		});
		await t.run(async (ctx) => {
			await Promise.all([
				users_test_seed_page(ctx, {
					userId: seeded.userId,
					organizationId: seeded.defaultOrganizationId,
					workspaceId: seeded.defaultWorkspaceId,
					tag: "hard-delete-initialized-page",
				}),
				ctx.runMutation(internal.data_deletion.init_user_deletion, {
					userId: seeded.userId,
					nowTs: 88_888,
				}),
			]);

			await ctx.db.insert("billing_usage_snapshots", {
				userId: seeded.userId,
				polarCustomerId: "cust_users_hard_delete_initialized",
				subscription: null,
				meter: null,
				lastSyncedAt: 88_889,
			});
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_hard_delete_initialized" as never);

		try {
			await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
			});

			const after = await t.run(async (ctx) => {
				const [user, requests, organization, workspace, files, snapshots, customer, subscriptions, billingJob] =
					await Promise.all([
						ctx.db.get("users", seeded.userId),
						ctx.db.query("data_deletion_requests").collect(),
						ctx.db.get("organizations", seeded.defaultOrganizationId),
						ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
						ctx.db
							.query("files_nodes")
							.collect()
							.then((rows) => rows.filter((row) => row.organizationId === seeded.defaultOrganizationId)),
						ctx.db
							.query("billing_usage_snapshots")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.collect(),
						ctx.runQuery(components.polar.lib.getCustomerByUserId, {
							userId: seeded.userId,
						}),
						ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
							userId: seeded.userId,
						}),
						ctx.db
							.query("billing_cancel_polar_subscription_jobs")
							.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
							.first(),
					]);

				return {
					user,
					requests,
					organization,
					workspace,
					files,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(enqueueActionSpy).not.toHaveBeenCalled();
			expect(after.user?.deletedAt).toBeUndefined();
			expect(after.user?.clerkUserId).toBe("clerk-user-hard-delete-initialized");
			expect(after.user?.defaultOrganizationId).toBe(seeded.defaultOrganizationId);
			expect(after.user?.defaultWorkspaceId).toBe(seeded.defaultWorkspaceId);
			expect(after.requests).toHaveLength(0);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.files).toHaveLength(0);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete_initialized");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("supports repeated purge requests after the tombstone is gone", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_anonymous_user(ctx, {
				displayName: "Hard Delete Purge Repeat User",
			}),
		);

		await t.action(internal.users.hard_delete_user_now, {
			userId: seeded.userId,
			purgeUserMod: "data_auth_and_user_record",
		});
		await t.action(internal.users.hard_delete_user_now, {
			userId: seeded.userId,
			purgeUserMod: "data_auth_and_user_record",
		});

		const after = await t.run(async (ctx) => {
			const [user, anagraphic, requests] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db.get("users_anagraphics", seeded.anagraphicId),
				ctx.db.query("data_deletion_requests").collect(),
			]);

			return {
				user,
				anagraphic,
				requests,
			};
		});

		expect(after.user).toBeNull();
		expect(after.anagraphic).toBeNull();
		expect(after.requests).toHaveLength(1);
	});

	test("throws when purging the tombstone of a non-deleted user", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-purge-guard-live",
				displayName: "Live User",
			}),
		);

		await expect(
			t.mutation(internal.users.purge_deleted_user_tombstone, {
				userId: seeded.userId,
			}),
		).rejects.toThrow("Cannot purge tombstone for a non-deleted user");

		const after = await t.run(async (ctx) => {
			const [user, anagraphic] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db.get("users_anagraphics", seeded.anagraphicId),
			]);

			return {
				user,
				anagraphic,
			};
		});

		expect(after.user?._id).toBe(seeded.userId);
		expect(after.anagraphic?._id).toBe(seeded.anagraphicId);
	});

	test("purges the tombstone even when dependent state remains", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-purge-guard-residual",
				displayName: "Residual User",
			}),
		);

		await t.run((ctx) =>
			ctx.db.patch("users", seeded.userId, {
				deletedAt: 77_777,
				clerkUserId: null,
			}),
		);

		await t.mutation(internal.users.purge_deleted_user_tombstone, {
			userId: seeded.userId,
		});

		const after = await t.run(async (ctx) => {
			const [user, anagraphic, memberships, quotas] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db.get("users_anagraphics", seeded.anagraphicId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", seeded.userId))
					.collect(),
				ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", seeded.userId))
					.collect(),
			]);

			return {
				user,
				anagraphic,
				memberships,
				quotas,
			};
		});

		expect(after.user).toBeNull();
		expect(after.anagraphic).toBeNull();
		expect(after.memberships.length).toBeGreaterThan(0);
		expect(after.quotas.length).toBeGreaterThan(0);
	});

	test("resets local-only users without deleting anonymous auth", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_anonymous_user(ctx, {
				displayName: "Hard Delete Anonymous User",
			}),
		);
		await users_test_seed_product(t, {
			polarProductId: "users_hard_delete_anonymous_product",
		});
		await users_test_seed_subscription(t, {
			userId: seeded.userId,
			customerId: "cust_users_hard_delete_anonymous",
			subscriptionId: "sub_users_hard_delete_anonymous",
			polarProductId: "users_hard_delete_anonymous_product",
		});
		await t.run((ctx) =>
			Promise.all([
				users_test_seed_page(ctx, {
					userId: seeded.userId,
					organizationId: seeded.defaultOrganizationId,
					workspaceId: seeded.defaultWorkspaceId,
					tag: "hard-delete-anonymous-page",
				}),
				ctx.db.insert("billing_usage_snapshots", {
					userId: seeded.userId,
					polarCustomerId: "cust_users_hard_delete_anonymous",
					subscription: null,
					meter: null,
					lastSyncedAt: 55_555,
				}),
			]),
		);
		const anonymousTokenId = await t.run(async (ctx) => {
			const tokenId = await ctx.db.insert("users_anon_tokens", {
				userId: seeded.userId,
				token: "hard-delete-anonymous-token",
				updatedAt: 44_444,
			});
			await ctx.db.patch("users", seeded.userId, {
				anonymousAuthToken: tokenId,
			});

			return tokenId;
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_hard_delete_anonymous" as never);

		try {
			await t.action(internal.users.hard_delete_user_now, {
				userId: seeded.userId,
			});

			const after = await t.run(async (ctx) => {
				const [
					user,
					anonymousToken,
					requests,
					organization,
					workspace,
					files,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db.get("users_anon_tokens", anonymousTokenId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("organizations", seeded.defaultOrganizationId),
					ctx.db.get("organizations_workspaces", seeded.defaultWorkspaceId),
					ctx.db
						.query("files_nodes")
						.collect()
						.then((rows) => rows.filter((row) => row.organizationId === seeded.defaultOrganizationId)),
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.runQuery(components.polar.lib.getCustomerByUserId, {
						userId: seeded.userId,
					}),
					ctx.runQuery(components.polar.lib.listAllUserSubscriptions, {
						userId: seeded.userId,
					}),
					ctx.db
						.query("billing_cancel_polar_subscription_jobs")
						.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
						.first(),
				]);

				return {
					user,
					anonymousToken,
					requests,
					organization,
					workspace,
					files,
					snapshots,
					customer,
					subscriptions,
					billingJob,
				};
			});

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(enqueueActionSpy).not.toHaveBeenCalled();
			expect(after.user?.deletedAt).toBeUndefined();
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.user?.anonymousAuthToken).toBe(anonymousTokenId);
			expect(after.anonymousToken?.token).toBe("hard-delete-anonymous-token");
			expect(after.requests).toHaveLength(0);
			expect(after.organization?._id).toBe(seeded.defaultOrganizationId);
			expect(after.workspace?._id).toBe(seeded.defaultWorkspaceId);
			expect(after.files).toHaveLength(0);
			expect(after.snapshots).toHaveLength(1);
			expect(after.customer?.id).toBe("cust_users_hard_delete_anonymous");
			expect(after.subscriptions).toHaveLength(1);
			expect(after.billingJob).toBeNull();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("removes anonymous auth while keeping the tombstoned user record in data-and-auth mode", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_anonymous_user(ctx, {
				displayName: "Hard Delete Anonymous Auth User",
			}),
		);
		const anonymousTokenId = await t.run(async (ctx) => {
			const tokenId = await ctx.db.insert("users_anon_tokens", {
				userId: seeded.userId,
				token: "hard-delete-anonymous-auth-token",
				updatedAt: 44_445,
			});
			await ctx.db.patch("users", seeded.userId, {
				anonymousAuthToken: tokenId,
			});

			return tokenId;
		});

		await t.action(internal.users.hard_delete_user_now, {
			userId: seeded.userId,
			purgeUserMod: "data_and_auth",
		});

		const after = await t.run(async (ctx) => {
			const [user, anonymousToken] = await Promise.all([
				ctx.db.get("users", seeded.userId),
				ctx.db.get("users_anon_tokens", anonymousTokenId),
			]);

			return {
				user,
				anonymousToken,
			};
		});

		expect(after.user?.deletedAt).toBeTypeOf("number");
		expect(after.user?.anonymousAuthToken).toBeUndefined();
		expect(after.anonymousToken).toBeNull();
	});
});

describe("anonymous billing snapshot lifecycle", () => {
	test("create_anonymous_user seeds a billing snapshot", async () => {
		const t = test_convex();
		await users_test_seed_product(t, {
			polarProductId: "users_create_anonymous_free_product",
			name: billing_PRODUCTS.Free.name,
		});
		const { userId } = await t.mutation(internal.users.create_anonymous_user, {});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.polarCustomerId).toBeNull();
		expect(usageSnapshot!.subscription?.id).toBeNull();
		expect(usageSnapshot!.subscription?.productId).toBe("users_create_anonymous_free_product");
		expect(usageSnapshot!.meter?.id).toBeNull();
		expect(usageSnapshot!.meter?.balance).toBeGreaterThan(0);
	});

	test("resolve_user anonymous-upgrade deletes the anonymous snapshot", async () => {
		const t = test_convex();
		await users_test_seed_product(t, {
			polarProductId: "users_resolve_anonymous_free_product",
			name: billing_PRODUCTS.Free.name,
		});

		// Create an anonymous user via the HTTP endpoint.
		const anonymousResponse = await t.fetch("/api/auth/anonymous", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const anonymousPayload = (await anonymousResponse.json()) as { token: string; userId: Id<"users"> };

		// Verify the anonymous snapshot exists.
		const usageSnapshotBefore = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", anonymousPayload.userId))
				.unique(),
		);
		expect(usageSnapshotBefore).not.toBeNull();
		expect(usageSnapshotBefore!.polarCustomerId).toBeNull();

		// Upgrade the anonymous user to a signed-in user.
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.users.resolve_user, {
				clerkUserId: "clerk-user-anon-snapshot-upgrade",
				email: "anon-snapshot-upgrade@test.local",
				anonymousUserToken: anonymousPayload.token,
				displayName: "Upgraded Anon User",
			}),
		);
		expect(result._yay).toBeDefined();

		// Verify the anonymous snapshot was deleted.
		const usageSnapshotAfter = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", anonymousPayload.userId))
				.unique(),
		);
		expect(usageSnapshotAfter).toBeNull();
	});
});
