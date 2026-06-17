import { describe, expect, test, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { Workpool, type WorkId } from "@convex-dev/workpool";
import { api, components, internal } from "./_generated/api.js";
import {
	billing_polar,
	billing_db_ensure_anonymous_user_usage_snapshot,
	billing_db_check_credits,
	billing_ingest_events,
} from "./billing.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { customersCreate } from "@polar-sh/sdk/funcs/customersCreate.js";
import { eventsIngest } from "@polar-sh/sdk/funcs/eventsIngest.js";
import { subscriptionsCreate } from "@polar-sh/sdk/funcs/subscriptionsCreate.js";
import { subscriptionsRevoke } from "@polar-sh/sdk/funcs/subscriptionsRevoke.js";
import { subscriptionsUpdate } from "@polar-sh/sdk/funcs/subscriptionsUpdate.js";
import { AlreadyCanceledSubscription } from "@polar-sh/sdk/models/errors/alreadycanceledsubscription.js";
import { PaymentFailed } from "@polar-sh/sdk/models/errors/paymentfailed.js";
import { UnexpectedClientError } from "@polar-sh/sdk/models/errors/httpclienterrors.js";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
import { SubscriptionLocked } from "@polar-sh/sdk/models/errors/subscriptionlocked.js";
import { billing_POLAR_METER_EVENT, billing_event } from "../server/billing.ts";
import type { Id } from "./_generated/dataModel.js";

vi.mock("@polar-sh/sdk/core.js", () => ({
	PolarCore: class PolarCoreMock {
		constructor(_args: unknown) {}
	},
}));

vi.mock("@polar-sh/sdk/funcs/eventsIngest.js", () => ({
	eventsIngest: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/customersCreate.js", () => ({
	customersCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/customersGetState.js", () => ({
	customersGetState: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsCreate.js", () => ({
	subscriptionsCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsRevoke.js", () => ({
	subscriptionsRevoke: vi.fn(),
}));

vi.mock("@polar-sh/sdk/funcs/subscriptionsUpdate.js", () => ({
	subscriptionsUpdate: vi.fn(),
}));

const customersCreateMock = vi.mocked(customersCreate);
const eventsIngestMock = vi.mocked(eventsIngest);
const subscriptionsCreateMock = vi.mocked(subscriptionsCreate);
const subscriptionsRevokeMock = vi.mocked(subscriptionsRevoke);
const subscriptionsUpdateMock = vi.mocked(subscriptionsUpdate);

type BillingSeed = {
	polarProductId: string;
	polarProductName: string;
};

type BillingSeedBenefit = {
	id: string;
	createdAt: string;
	modifiedAt: string | null;
	type: string;
	description: string;
	selectable: boolean;
	deletable: boolean;
	organizationId: string;
	metadata?: Record<string, unknown>;
	properties?: unknown;
};

async function seed_pay_as_you_go_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "billing_test_org",
			name: polarProductName,
			description: args.description ?? null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${args.polarProductId}_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "metered_unit",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "usd",
					unitAmount: "5",
					recurringInterval: "month",
					meterId: "meter_units",
					meter: { id: "meter_units", name: "Billable units" },
				},
			],
			medias: [],
			benefits: args.benefits ?? [],
		},
	});
	return { polarProductId: args.polarProductId, polarProductName };
}

async function seed_free_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const polarProductName = billing_PRODUCTS.Free.name;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "billing_test_org",
			name: polarProductName,
			description: args.description ?? null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${args.polarProductId}_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "free",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					recurringInterval: "month",
				},
			],
			medias: [],
			benefits: args.benefits ?? [
				{
					id: "benefit_free_meter_credit",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: "Free Included Usage",
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 1000, rollover: true, meterId: "meter_press_usage" },
				},
			],
		},
	});
	return { polarProductId: args.polarProductId, polarProductName };
}

async function seed_pro_product(
	t: ReturnType<typeof test_convex>,
	args: {
		polarProductId: string;
		description?: string | null;
		benefits?: BillingSeedBenefit[];
	},
): Promise<BillingSeed> {
	const polarProductName = billing_PRODUCTS.Pro.name;
	await t.mutation(components.polar.lib.createProduct, {
		product: {
			id: args.polarProductId,
			organizationId: "billing_test_org",
			name: polarProductName,
			description: args.description ?? null,
			isRecurring: true,
			isArchived: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: null,
			recurringInterval: "month",
			metadata: {},
			prices: [
				{
					id: `${args.polarProductId}_fixed_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "fixed",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					priceAmount: 4000,
					recurringInterval: "month",
				},
				{
					id: `${args.polarProductId}_metered_price`,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					amountType: "metered_unit",
					isArchived: false,
					productId: args.polarProductId,
					priceCurrency: "eur",
					unitAmount: "1",
					recurringInterval: "month",
					meterId: "meter_press_usage",
					meter: { id: "meter_press_usage", name: "Press app usage" },
				},
			],
			medias: [],
			benefits: args.benefits ?? [
				{
					id: "benefit_pro_meter_credit",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: "Pro Included Usage",
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 5000 },
				},
			],
		},
	});
	return { polarProductId: args.polarProductId, polarProductName };
}

async function seed_user_id(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => {
		return await ctx.db.insert("users", {
			clerkUserId: null,
		});
	});
}

let seed_signed_in_user_id_counter = 0;

async function seed_signed_in_user_id(t: ReturnType<typeof test_convex>) {
	const clerkUserId = `clerk_test_${seed_signed_in_user_id_counter++}`;
	return await t.run(async (ctx) => {
		return await ctx.db.insert("users", {
			clerkUserId,
		});
	});
}

async function seed_signed_in_user_with_anagraphic(
	t: ReturnType<typeof test_convex>,
	args: {
		displayName: string;
		email: string;
		deletedAt?: number;
	},
) {
	const clerkUserId = `clerk_test_${seed_signed_in_user_id_counter++}`;
	return await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId,
			...(args.deletedAt ? { deletedAt: args.deletedAt } : {}),
		});
		const anagraphicId = await ctx.db.insert("users_anagraphics", {
			userId,
			displayName: args.displayName,
			email: args.email,
			updatedAt: Date.now(),
		});
		await ctx.db.patch("users", userId, {
			anagraphic: anagraphicId,
		});

		return userId;
	});
}

async function seed_billing_usage_snapshot(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: Id<"users">;
		polarProductId: string;
		balanceCents: number;
		amountDueCents?: number;
		lastSyncedAt?: number;
	},
) {
	const lastSyncedAt = args.lastSyncedAt ?? Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("billing_usage_snapshots", {
			userId: args.userId,
			polarCustomerId: `cust_${args.userId}`,
			subscription: {
				id: `sub_${args.userId}`,
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
				amountDueCents: args.amountDueCents ?? 0,
			},
			lastSyncedAt,
		});
	});
}

let seed_workspace_billing_scope_counter = 0;

async function seed_workspace_billing_scope(
	t: ReturnType<typeof test_convex>,
	args: {
		billingMode: "user" | "workspace_owner";
		member?: boolean;
	},
) {
	const suffix = seed_workspace_billing_scope_counter++;

	return await t.run(async (ctx) => {
		const now = Date.now();
		const ownerId = await ctx.db.insert("users", {
			clerkUserId: `clerk-workspace-billing-owner-${suffix}`,
		});
		const ownerMembership = await test_mocks_fill_db_with.membership(ctx, {
			userId: ownerId,
			workspaceName: `billing-workspace-${suffix}`,
			projectName: "home",
		});
		await ctx.db.patch("workspaces", ownerMembership.workspaceId, {
			billingMode: args.billingMode,
		});

		if (!args.member) {
			return {
				ownerId,
				actorUserId: ownerId,
				workspaceId: ownerMembership.workspaceId,
				projectId: ownerMembership.projectId,
			};
		}

		const memberId = await ctx.db.insert("users", {
			clerkUserId: `clerk-workspace-billing-member-${suffix}`,
		});
		await test_mocks_fill_db_with.membership(ctx, {
			userId: memberId,
			workspaceName: "personal",
			projectName: "home",
		});
		await ctx.db.insert("workspaces_projects_users", {
			workspaceId: ownerMembership.workspaceId,
			projectId: ownerMembership.projectId,
			userId: memberId,
			active: true,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			workspaceId: ownerMembership.workspaceId,
			projectId: ownerMembership.projectId,
			userId: memberId,
			role: "member",
			now,
		});

		return {
			ownerId,
			actorUserId: memberId,
			workspaceId: ownerMembership.workspaceId,
			projectId: ownerMembership.projectId,
		};
	});
}

async function get_cancel_polar_subscription_job(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	return await t.run((ctx) =>
		ctx.db
			.query("billing_cancel_polar_subscription_jobs")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
	);
}

async function seed_subscription(
	t: ReturnType<typeof test_convex>,
	args: {
		userId: string;
		customerId: string;
		subscriptionId: string;
		polarProductId: string;
		status?: "active" | "trialing";
		cancelAtPeriodEnd?: boolean;
		canceledAt?: string | null;
		endsAt?: string | null;
		endedAt?: string | null;
		pendingUpdate?: {
			id: string;
			appliesAt: string;
			productId: string | null;
			seats: number | null;
		} | null;
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
			status: args.status ?? "active",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			cancelAtPeriodEnd: args.cancelAtPeriodEnd ?? false,
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: args.endedAt ?? null,
			metadata: {},
			pendingUpdate: args.pendingUpdate ?? null,
			...(args.canceledAt !== undefined ? { canceledAt: args.canceledAt } : {}),
			...(args.endsAt !== undefined ? { endsAt: args.endsAt } : {}),
		},
	});
}

function create_updated_polar_subscription(args: {
	subscriptionId: string;
	customerId: string;
	productId: string;
	pendingUpdate?: {
		id: string;
		appliesAt: string;
		productId: string | null;
		seats: number | null;
	} | null;
}) {
	return {
		id: args.subscriptionId,
		customerId: args.customerId,
		productId: args.productId,
		checkoutId: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		modifiedAt: new Date("2026-01-03T00:00:00.000Z"),
		amount: 1000,
		currency: "eur",
		recurringInterval: "month",
		recurringIntervalCount: 1,
		status: "active",
		currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
		currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
		trialStart: null,
		trialEnd: null,
		cancelAtPeriodEnd: false,
		canceledAt: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		endsAt: null,
		endedAt: null,
		discountId: null,
		seats: null,
		customerCancellationReason: null,
		customerCancellationComment: null,
		metadata: {},
		customFieldData: {},
		pendingUpdate: args.pendingUpdate
			? {
					id: args.pendingUpdate.id,
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
					modifiedAt: null,
					appliesAt: new Date(args.pendingUpdate.appliesAt),
					productId: args.pendingUpdate.productId,
					seats: args.pendingUpdate.seats,
				}
			: null,
	};
}

function create_polar_customer_state(args: {
	customerId: string;
	userId: string | null;
	productId: string;
	subscriptionId: string;
	currentPeriodStart: string;
	currentPeriodEnd: string;
	activeMeters?: Array<{
		meterId: string;
		consumedUnits: number;
		creditedUnits: number;
		balance: number;
	}>;
}) {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	return {
		id: args.customerId,
		createdAt,
		modifiedAt: null,
		metadata: {},
		externalId: args.userId,
		email: "billing-test@example.com",
		emailVerified: true,
		type: "individual",
		name: "Billing Test Customer",
		billingAddress: null,
		taxId: null,
		locale: null,
		organizationId: "billing_test_org",
		deletedAt: null,
		activeSubscriptions: [
			{
				id: args.subscriptionId,
				createdAt,
				modifiedAt: null,
				customFieldData: {},
				metadata: {},
				status: "active",
				amount: 0,
				productId: args.productId,
				currency: "eur",
				recurringInterval: "month",
				currentPeriodStart: new Date(args.currentPeriodStart),
				currentPeriodEnd: new Date(args.currentPeriodEnd),
				trialStart: null,
				trialEnd: null,
				cancelAtPeriodEnd: false,
				canceledAt: null,
				startedAt: new Date(args.currentPeriodStart),
				endsAt: null,
				discountId: null,
				meters: [],
			},
		],
		grantedBenefits: [],
		activeMeters: (args.activeMeters ?? []).map((meter) => ({
			id: `${meter.meterId}_state`,
			createdAt,
			modifiedAt: null,
			meterId: meter.meterId,
			consumedUnits: meter.consumedUnits,
			creditedUnits: meter.creditedUnits,
			balance: meter.balance,
		})),
		avatarUrl: "",
	} satisfies NonNullable<Awaited<ReturnType<typeof billing_polar.getCustomerState>>>;
}

beforeEach(() => {
	customersCreateMock.mockReset();
	eventsIngestMock.mockReset();
	subscriptionsCreateMock.mockReset();
	subscriptionsRevokeMock.mockReset();
	subscriptionsUpdateMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("check_credits", () => {
	test("allows a signed-in Free user with current credits to start chat", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, { polarProductId: "prod_free_allow" });
		await seed_billing_usage_snapshot(t, { userId, polarProductId, balanceCents: 1 });

		const result = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});

		expect(result).toEqual({
			hasCredits: true,
		});
	});

	test("reports no credits when the billing snapshot is missing", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});

		expect(result).toEqual({
			hasCredits: false,
		});
	});

	test("reports no credits when the billing snapshot has no subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId,
				polarCustomerId: `cust_${userId}`,
				subscription: null,
				meter: null,
				lastSyncedAt: Date.now(),
			});
		});

		const result = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});

		expect(result).toEqual({
			hasCredits: false,
		});
	});

	test("denies a signed-in Free user at zero balance for chat and file save", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, { polarProductId: "prod_free_zero" });
		await seed_billing_usage_snapshot(t, { userId, polarProductId, balanceCents: 0 });

		const chatResult = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});
		const fileSaveResult = await t.run(async (ctx) =>
			billing_db_check_credits(ctx, {
				userId,
				minimumRequiredCents: 1,
			}),
		);

		expect(chatResult).toEqual({
			hasCredits: false,
		});
		expect(fileSaveResult).toEqual({
			hasCredits: false,
		});
	});

	test("allows paid plans even with a negative balance", async () => {
		for (const seedProduct of [seed_pay_as_you_go_product, seed_pro_product] as const) {
			const t = test_convex();
			const userId = await seed_user_id(t);
			const { polarProductId } = await seedProduct(t, { polarProductId: `prod_paid_negative_${userId}` });
			await seed_billing_usage_snapshot(t, { userId, polarProductId, balanceCents: -100 });

			const result = await t.query(internal.billing.check_credits, {
				userId,
				minimumRequiredCents: 1,
			});

			expect(result).toEqual({
				hasCredits: true,
			});
		}
	});
});

describe("workspace billing check", () => {
	test("personal workspaces bill the actor", async () => {
		const t = test_convex();
		const personalScope = await t.run(async (ctx) => {
			return await test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
			});
		});
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_personal_actor",
		});
		await seed_billing_usage_snapshot(t, {
			userId: personalScope.userId,
			polarProductId,
			balanceCents: 10,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: personalScope.userId,
			workspaceId: personalScope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(personalScope.userId);
	});

	test("created user-billed workspaces bill the actor", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "user", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_user_billing_actor",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.actorUserId,
			polarProductId,
			balanceCents: 10,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.actorUserId);
	});

	test("owner-billed workspaces bill the current workspace owner", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_owner_billing_owner",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: 10,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});

	test("owner acting in their own owner-billed workspace bills the owner", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner" });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_owner_billing_owner_actor",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: 10,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.ownerId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});

	test("ownership transfer changes future owner-billed usage", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_owner_billing_transfer",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.actorUserId,
			polarProductId,
			balanceCents: 10,
		});
		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: scope.ownerId,
			name: "Workspace Billing Owner",
			email: "workspace-billing-owner@test.local",
		});

		const transferResult = await ownerClient.mutation(api.access_control.transfer_workspace_ownership, {
			workspaceId: scope.workspaceId,
			newOwnerUserId: scope.actorUserId,
		});
		expect(transferResult._yay).toBeNull();

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.ownerId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.actorUserId);
	});

	test("ownership transfer does not affect user-billed workspace usage", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "user", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_user_billing_transfer",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: 10,
		});
		const ownerClient = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: scope.ownerId,
			name: "User Billing Owner",
			email: "user-billing-owner@test.local",
		});

		const transferResult = await ownerClient.mutation(api.access_control.transfer_workspace_ownership, {
			workspaceId: scope.workspaceId,
			newOwnerUserId: scope.actorUserId,
		});
		expect(transferResult._yay).toBeNull();

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.ownerId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});

	test("owner-billed workspaces read the owner from the workspace doc", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_owner_billing_doc_owner",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: 10,
		});
		await t.run(async (ctx) => {
			const ownerAssignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_role_user", (q) =>
					q.eq("workspaceId", scope.workspaceId).eq("projectId", scope.projectId).eq("role", "owner"),
				)
				.first();
			if (!ownerAssignment) {
				throw new Error("Expected owner assignment");
			}
			await ctx.db.delete("access_control_role_assignments", ownerAssignment._id);
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});

	test("checks the relevant payer snapshot", async () => {
		const t = test_convex();
		const userBilledScope = await seed_workspace_billing_scope(t, { billingMode: "user", member: true });
		const ownerBilledScope = await seed_workspace_billing_scope(t, {
			billingMode: "workspace_owner",
			member: true,
		});
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_context_relevant_payer",
		});
		await seed_billing_usage_snapshot(t, {
			userId: ownerBilledScope.ownerId,
			polarProductId,
			balanceCents: 10,
		});
		await seed_billing_usage_snapshot(t, {
			userId: ownerBilledScope.actorUserId,
			polarProductId,
			balanceCents: 0,
		});

		const userBilledResult = await t.query(internal.billing.check_credits, {
			userId: userBilledScope.actorUserId,
			workspaceId: userBilledScope.workspaceId,
			minimumRequiredCents: 1,
		});
		const ownerBilledResult = await t.query(internal.billing.check_credits, {
			userId: ownerBilledScope.actorUserId,
			workspaceId: ownerBilledScope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(userBilledResult.hasCredits).toBe(false);
		expect(userBilledResult.billedUser?._id).toBe(userBilledScope.actorUserId);
		expect(ownerBilledResult.hasCredits).toBe(true);
		expect(ownerBilledResult.billedUser?._id).toBe(ownerBilledScope.ownerId);
	});

	test("allows paid owner-billed usage even when the owner balance is negative", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner", member: true });
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "prod_workspace_paid_owner_negative",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: -100,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(true);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});

	test("blocks owner-billed member usage when the free owner is below the minimum", async () => {
		const t = test_convex();
		const scope = await seed_workspace_billing_scope(t, { billingMode: "workspace_owner", member: true });
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_workspace_free_owner_zero",
		});
		await seed_billing_usage_snapshot(t, {
			userId: scope.ownerId,
			polarProductId,
			balanceCents: 0,
		});

		const result = await t.query(internal.billing.check_credits, {
			userId: scope.actorUserId,
			workspaceId: scope.workspaceId,
			minimumRequiredCents: 1,
		});

		expect(result.hasCredits).toBe(false);
		expect(result.billedUser?._id).toBe(scope.ownerId);
	});
});

describe("anonymous credit gate", () => {
	test("ensure_snapshot creates the expected synthetic snapshot", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "prod_free_anon_ensure_snapshot",
		});
		const now = Date.parse("2026-01-13T15:20:38.364Z");

		const usageSnapshot = await t.run(async (ctx) => {
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now });
			return await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique();
		});
		if (!usageSnapshot) {
			throw new Error("Snapshot missing");
		}

		expect(usageSnapshot.polarCustomerId).toBeNull();
		expect(usageSnapshot.subscription).toMatchObject({
			id: null,
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-01-13T00:00:00.000Z",
			currentPeriodEnd: "2026-02-12T00:00:00.000Z",
		});
		expect(usageSnapshot.meter).toMatchObject({
			id: null,
			consumedUnits: 0,
			creditedUnits: billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name),
			balance: billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name),
			amountDueCents: 0,
		});
	});

	test("ensure_snapshot is idempotent and does not insert a duplicate", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_anon_idempotent",
		});
		const now = Date.now();

		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now }));
		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now }));

		const usageSnapshots = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.collect(),
		);
		expect(usageSnapshots).toHaveLength(1);
	});

	test("check_credits returns hasCredits: true for an anonymous user with balance", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_anon_has_credits",
		});
		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now: Date.now() }));

		const result = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});

		expect(result).toEqual({ hasCredits: true });
	});

	test("check_credits returns hasCredits: false after draining anonymous balance", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_anon_drained",
		});
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now: Date.now() }));

		// Drain the full balance.
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}

			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: userId,
							externalId: "manual_credit::anonymous_drain_balance::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
		});

		const result = await t.query(internal.billing.check_credits, {
			userId,
			minimumRequiredCents: 1,
		});

		expect(result).toEqual({ hasCredits: false });
	});

	test("check_credits stays false after the period ends until the daily reset runs", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_anon_period_end",
		});
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		const now = Date.now();
		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now }));

		// Drain the full balance.
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}

			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: userId,
							externalId: "manual_credit::anonymous_period_end::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
		});

		// Advance the period end into the past.
		await t.run(async (ctx) => {
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique();
			if (!usageSnapshot?.subscription) throw new Error("Snapshot missing");
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				subscription: {
					...usageSnapshot.subscription,
					currentPeriodEnd: new Date(now - 1).toISOString(),
				},
			});
		});

		const result = await t.run(async (ctx) => billing_db_check_credits(ctx, { userId, minimumRequiredCents: 1 }));

		expect(result).toEqual({ hasCredits: false });
	});

	test("reset_due_anonymous_credits refills the balance and advances the period on the due UTC day", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_anon_reset",
		});
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		const now = Date.parse("2026-01-13T15:20:38.364Z");
		await t.run(async (ctx) => billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now }));

		// Drain the full balance.
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}

			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: userId,
							externalId: "manual_credit::anonymous_reset_due::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
		});

		const resetDay = Date.parse("2026-02-12T12:00:00.000Z");
		await t.mutation(internal.billing.reset_due_anonymous_credits, {
			_test_now: resetDay,
		});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits);
		expect(usageSnapshot?.subscription).toMatchObject({
			currentPeriodStart: "2026-02-12T00:00:00.000Z",
			currentPeriodEnd: "2026-03-14T00:00:00.000Z",
		});
	});

	test("ingest_anonymous_user_events does not mutate a signed-in billed user snapshot", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, { polarProductId: "prod_free_anon_guard" });
		await seed_billing_usage_snapshot(t, { userId, polarProductId, balanceCents: 500 });

		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}

			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: userId,
							externalId: "manual_credit::non_anonymous_snapshot::1",
							metadata: {
								amount: 1,
							},
						}),
					},
				],
			});
		});

		// Balance should remain unchanged.
		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.balance).toBe(500);
	});
});

describe("billing list_products", () => {
	test("returns empty array when unauthenticated", async () => {
		const t = test_convex();

		const products = await t.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns empty array for anonymous JWT users", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_billing_overview_anonymous" as Id<"users">,
			name: "Overview Anonymous",
		});

		const products = await asAnonymous.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns empty array when Clerk external_id is not set yet", async () => {
		const t = test_convex();
		const asSignedInWithoutExternalId = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-without-external-id",
			name: "Overview No External Id",
			email: "overview-no-external-id@test.local",
		});

		const products = await asSignedInWithoutExternalId.query(api.billing.list_products, {});

		expect(products).toEqual([]);
	});

	test("returns products when user has no Polar customer row", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_none",
			description: "A flexible plan for teams that want to pay only for what they use.",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_none" as Id<"users">,
			name: "Overview None",
			email: "overview-none@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.find((product) => product.id === polarProductId)?.description).toBe(
			"A flexible plan for teams that want to pay only for what they use.",
		);
		expect(products.find((product) => product.id === polarProductId)?.prices[0]?.unitAmount).toBe("5");
		expect(products.find((product) => product.id === polarProductId)?.prices[0]?.meter?.name).toBe("Billable units");
		expect(products.find((product) => product.id === polarProductId)?.benefits).toEqual([]);
	});

	test("returns both known products from list_products", async () => {
		const t = test_convex();
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_overview_prod_pro",
		});
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_payg",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_known_products" as Id<"users">,
			name: "Overview Known Products",
			email: "overview-known-products@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});

		expect(products.some((product) => product.id === polarProProductId)).toBe(true);
		expect(products.some((product) => product.id === polarPaygProductId)).toBe(true);
		expect(
			products
				.find((product) => product.id === polarProProductId)
				?.prices?.some((price) => {
					return price.amountType === "fixed" && price.priceAmount === 4000;
				}),
		).toBe(true);
		expect(
			products
				.find((product) => product.id === polarProProductId)
				?.benefits?.some((benefit) => {
					return benefit.description === "Pro Included Usage";
				}),
		).toBe(true);
	});

	test("parses included meter credits from meter_credit benefit properties", async () => {
		const t = test_convex();
		await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_credits",
			benefits: [
				{
					id: "ben_mc_1",
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					type: "meter_credit",
					description: "Free Usage",
					selectable: false,
					deletable: false,
					organizationId: "billing_test_org",
					properties: { units: 250 },
				},
			],
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_credits" as Id<"users">,
			name: "Overview Credits",
			email: "overview-credits@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		const paygProduct = products.find((product) => product.id === "billing_overview_prod_credits");
		expect(paygProduct?.benefits?.find((benefit) => benefit.type === "meter_credit")?.properties).toEqual({
			units: 250,
		});
		expect(paygProduct?.benefits?.some((benefit) => benefit.type === "meter_credit")).toBe(true);
		expect(paygProduct?.benefits?.map((benefit) => benefit.description)).toContain("Free Usage");
	});

	test("returns products while the user has an active subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_active",
			userId: "user_billing_overview_active",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_active",
				customerId: "cust_overview_active",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_active" as Id<"users">,
			name: "Overview Active",
			email: "overview-active@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns products while the user has a cancel_at_period_end subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_cancel",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_cancel",
			userId: "user_billing_overview_cancel",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_cancel",
				customerId: "cust_overview_cancel",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_cancel" as Id<"users">,
			name: "Overview Cancel",
			email: "overview-cancel@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns products while the user has a trialing subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_overview_prod_trial",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_overview_trial",
			userId: "user_billing_overview_trial",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_overview_trial",
				customerId: "cust_overview_trial",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: null,
				currency: "usd",
				recurringInterval: "month",
				status: "trialing",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-01-08T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_trial" as Id<"users">,
			name: "Overview Trial",
			email: "overview-trial@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products.some((product) => product.id === polarProductId)).toBe(true);
	});

	test("returns empty array when billing is misconfigured", async () => {
		const t = test_convex();

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_overview_misconfigured" as Id<"users">,
			name: "Overview Misconfigured",
			email: "overview-misconfigured@test.local",
		});

		const products = await asUser.query(api.billing.list_products, {});
		expect(products).toEqual([]);
	});
});

describe("billing get_current_user_subscription", () => {
	test("returns null when unauthenticated", async () => {
		const t = test_convex();

		const subscription = await t.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns null when the user has no subscriptions", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_empty" as Id<"users">,
			name: "Subscription Empty",
			email: "subscription-empty@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns null when the user only has ended subscriptions", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_current_subscription_prod_ended",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_current_subscription_ended",
			userId: "user_billing_current_subscription_ended",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_current_subscription_ended",
				customerId: "cust_current_subscription_ended",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "canceled",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-02-01T00:00:00.000Z",
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_current_subscription_ended" as Id<"users">,
			name: "Current Subscription Ended",
			email: "current-subscription-ended@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});

		expect(subscription).toBeNull();
	});

	test("returns the current active subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_active",
			userId: "user_billing_subscription_active",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_active",
				customerId: "cust_subscription_active",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_active" as Id<"users">,
			name: "Subscription Active",
			email: "subscription-active@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("active");
		expect(subscription?.startedAt).toBe("2026-01-01T00:00:00.000Z");
		expect("product" in (subscription ?? {})).toBe(false);
	});

	test("returns the current cancel_at_period_end subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_cancel",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_cancel",
			userId: "user_billing_subscription_cancel",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_cancel",
				customerId: "cust_subscription_cancel",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
				recurringInterval: "month",
				status: "active",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				cancelAtPeriodEnd: true,
				canceledAt: "2026-01-15T00:00:00.000Z",
				startedAt: "2026-01-01T00:00:00.000Z",
				endsAt: "2026-02-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_cancel" as Id<"users">,
			name: "Subscription Cancel",
			email: "subscription-cancel@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("active");
		expect(subscription?.cancelAtPeriodEnd).toBe(true);
		expect(subscription?.canceledAt).toBe("2026-01-15T00:00:00.000Z");
		expect(subscription?.endsAt).toBe("2026-02-01T00:00:00.000Z");
	});

	test("returns the current trialing subscription", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_subscription_prod_trial",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_subscription_trial",
			userId: "user_billing_subscription_trial",
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_subscription_trial",
				customerId: "cust_subscription_trial",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: null,
				currency: "usd",
				recurringInterval: "month",
				status: "trialing",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-01-08T00:00:00.000Z",
				cancelAtPeriodEnd: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_subscription_trial" as Id<"users">,
			name: "Subscription Trial",
			email: "subscription-trial@test.local",
		});

		const subscription = await asUser.query(api.billing.get_current_user_subscription, {});
		expect(subscription?.productId).toBe(polarProductId);
		expect(subscription?.status).toBe("trialing");
	});
});

describe("billing get_usage_snapshot", () => {
	test("returns null when unauthenticated", async () => {
		const t = test_convex();

		const usageSnapshot = await t.query(api.billing.get_usage_snapshot, {});

		expect(usageSnapshot).toBeNull();
	});

	test("returns null when no snapshot exists", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_billing_usage_empty" as Id<"users">,
			name: "Usage Empty",
			email: "usage-empty@test.local",
		});

		const usageSnapshot = await asUser.query(api.billing.get_usage_snapshot, {});

		expect(usageSnapshot).toBeNull();
	});

	test("returns snapshot fields when a billing_usage_snapshots row exists", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_usage_prod_ready",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_usage_ready",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_usage_ready",
				customerId: "cust_usage_ready",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId,
				polarCustomerId: "cust_usage_ready",
				subscription: {
					id: "sub_usage_ready",
					productId: polarProductId,
					currency: "usd",
					currentPeriodStart: "2026-01-01T00:00:00.000Z",
					currentPeriodEnd: "2026-02-01T00:00:00.000Z",
				},
				meter: {
					id: "meter_units",
					consumedUnits: 4,
					creditedUnits: 100,
					balance: 96,
					amountDueCents: 250,
				},
				lastSyncedAt: now,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Usage Ready",
			email: "usage-ready@test.local",
		});

		const usageSnapshot = await asUser.query(api.billing.get_usage_snapshot, {});
		expect(usageSnapshot).not.toBeNull();
		if (!usageSnapshot) {
			throw new Error("Expected usage snapshot");
		}
		expect(usageSnapshot.subscription?.productId).toBe(polarProductId);
		expect(usageSnapshot.meter?.consumedUnits).toBe(4);
		expect(usageSnapshot.meter?.amountDueCents).toBe(250);
		expect(usageSnapshot.meter?.balance).toBe(96);
		expect(usageSnapshot.lastSyncedAt).toBe(now);
	});
});

describe("billing bootstrap_free_subscription", () => {
	beforeEach(() => {
		vi.spyOn(billing_polar, "getCustomerState").mockResolvedValue(null);
	});

	test("creates a Polar customer and Free subscription for a newly resolved user", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_free_product",
		});

		customersCreateMock.mockResolvedValue({
			ok: true,
			value: {
				id: "cust_bootstrap_free",
			},
		} as never);
		subscriptionsCreateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_bootstrap_free",
				customerId: "cust_bootstrap_free",
				productId: polarProductId,
			}),
		} as never);

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-free@test.local",
			name: "Bootstrap Free User",
		});

		expect(result).toBeNull();
		expect(customersCreateMock).toHaveBeenCalledWith(expect.anything(), {
			externalId: userId,
			email: "bootstrap-free@test.local",
			name: "Bootstrap Free User",
		});
		expect(subscriptionsCreateMock).toHaveBeenCalledWith(expect.anything(), {
			customerId: "cust_bootstrap_free",
			productId: polarProductId,
		});

		const [customer, subscription] = await Promise.all([
			t.query(components.polar.lib.getCustomerByUserId, { userId }),
			t.query(components.polar.lib.getCurrentSubscription, { userId }),
		]);
		expect(customer?.id).toBe("cust_bootstrap_free");
		expect(subscription?.id).toBe("sub_bootstrap_free");
		expect(subscription?.productId).toBe(polarProductId);
	});

	test("skips bootstrap and Polar refresh when the user already has synced local state", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "billing_bootstrap_existing_free_product",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_bootstrap_existing_pro_product",
		});

		await seed_subscription(t, {
			userId,
			customerId: "cust_bootstrap_existing",
			subscriptionId: "sub_bootstrap_existing",
			polarProductId: polarProProductId,
		});
		await seed_billing_usage_snapshot(t, {
			userId,
			polarProductId: polarProProductId,
			balanceCents: 500,
		});
		const getCustomerStateSpy = vi.spyOn(billing_polar, "getCustomerState");

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-existing@test.local",
			name: "Bootstrap Existing User",
		});

		expect(result).toBeNull();
		expect(customersCreateMock).not.toHaveBeenCalled();
		expect(subscriptionsCreateMock).not.toHaveBeenCalled();
		expect(getCustomerStateSpy).not.toHaveBeenCalled();
	});

	test("recreates a missing usage snapshot when an existing subscription is found", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_existing_missing_snapshot_free_product",
		});
		await seed_subscription(t, {
			userId,
			customerId: "cust_bootstrap_existing_missing_snapshot",
			subscriptionId: "sub_bootstrap_existing_missing_snapshot",
			polarProductId,
		});
		const getCustomerStateSpy = vi.spyOn(billing_polar, "getCustomerState").mockResolvedValue(
			create_polar_customer_state({
				customerId: "cust_bootstrap_existing_missing_snapshot",
				userId,
				productId: polarProductId,
				subscriptionId: "sub_bootstrap_existing_missing_snapshot",
				currentPeriodStart: "2026-04-13T03:20:38.364Z",
				currentPeriodEnd: "2026-05-13T03:20:38.364Z",
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_bootstrap_existing_missing_snapshot" as never);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T03:20:41.064Z"));

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-existing-missing-snapshot@test.local",
			name: "Bootstrap Existing Missing Snapshot User",
		});

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const freeRecurringCents = billing_PRODUCTS.Free.recurringCreditsCents;
		expect(result).toBeNull();
		expect(customersCreateMock).not.toHaveBeenCalled();
		expect(subscriptionsCreateMock).not.toHaveBeenCalled();
		expect(getCustomerStateSpy).toHaveBeenCalledWith(expect.anything(), { userId });
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.polarCustomerId).toBe("cust_bootstrap_existing_missing_snapshot");
		expect(usageSnapshot!.subscription).toEqual({
			id: "sub_bootstrap_existing_missing_snapshot",
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-04-13T03:20:38.364Z",
			currentPeriodEnd: "2026-05-13T03:20:38.364Z",
		});
		expect(usageSnapshot!.meter).toEqual({
			id: "meter_press_usage",
			consumedUnits: -freeRecurringCents,
			creditedUnits: 0,
			balance: freeRecurringCents,
			amountDueCents: 0,
		});
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "monthly_credit",
					externalCustomerId: userId,
					externalId: `monthly_credit::${userId}::sub_bootstrap_existing_missing_snapshot::2026-04-13T03:20:38.364Z`,
				}),
			],
		});
	});

	test("restores a recovered account subscription that is pending period-end cancellation", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_restore_free_product",
		});

		await seed_subscription(t, {
			userId,
			customerId: "cust_bootstrap_restore_pending",
			subscriptionId: "sub_bootstrap_restore_pending",
			polarProductId,
			cancelAtPeriodEnd: true,
			canceledAt: "2026-01-15T00:00:00.000Z",
			endsAt: "2026-02-01T00:00:00.000Z",
		});
		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_bootstrap_restore_pending" as WorkId,
			updatedAt: 30_001,
		});

		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_bootstrap_restore_pending",
				customerId: "cust_bootstrap_restore_pending",
				productId: polarProductId,
			}),
		} as never);

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-restore@test.local",
			name: "Bootstrap Restore User",
			restoreCanceledSubscription: true,
		});

		const [subscription, cancellationJob] = await Promise.all([
			t.query(components.polar.lib.getCurrentSubscription, { userId }),
			get_cancel_polar_subscription_job(t, userId),
		]);

		expect(result).toBeNull();
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_bootstrap_restore_pending");
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_bootstrap_restore_pending",
			subscriptionUpdate: {
				cancelAtPeriodEnd: false,
			},
		});
		expect(subscriptionsCreateMock).not.toHaveBeenCalled();
		expect(cancellationJob).toBeNull();
		expect(subscription?.cancelAtPeriodEnd).toBe(false);
		expect(subscription?.canceledAt).toBeNull();
		expect(subscription?.endsAt).toBeNull();
	});

	test("does not uncancel an existing subscription without the account-restore flag", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_non_restore_free_product",
		});

		await seed_subscription(t, {
			userId,
			customerId: "cust_bootstrap_non_restore",
			subscriptionId: "sub_bootstrap_non_restore",
			polarProductId,
			cancelAtPeriodEnd: true,
			canceledAt: "2026-01-15T00:00:00.000Z",
			endsAt: "2026-02-01T00:00:00.000Z",
		});

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-non-restore@test.local",
			name: "Bootstrap Non Restore User",
		});

		const subscription = await t.query(components.polar.lib.getCurrentSubscription, { userId });

		expect(result).toBeNull();
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
		expect(subscriptionsCreateMock).not.toHaveBeenCalled();
		expect(subscription?.cancelAtPeriodEnd).toBe(true);
	});

	test("creates a Free subscription for a recovered account with no current subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_restore_missing_subscription_product",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_bootstrap_restore_missing_subscription",
			userId,
		});
		subscriptionsCreateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_bootstrap_restore_missing_subscription",
				customerId: "cust_bootstrap_restore_missing_subscription",
				productId: polarProductId,
			}),
		} as never);

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-restore-missing-subscription@test.local",
			name: "Bootstrap Restore Missing Subscription User",
			restoreCanceledSubscription: true,
		});

		const subscription = await t.query(components.polar.lib.getCurrentSubscription, { userId });

		expect(result).toBeNull();
		expect(customersCreateMock).not.toHaveBeenCalled();
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
		expect(subscriptionsCreateMock).toHaveBeenCalledWith(expect.anything(), {
			customerId: "cust_bootstrap_restore_missing_subscription",
			productId: polarProductId,
		});
		expect(subscription?.id).toBe("sub_bootstrap_restore_missing_subscription");
	});

	test("repairs a stranded usage snapshot after creating a missing Free subscription", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_bootstrap_stranded_snapshot_free_product",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_bootstrap_stranded_snapshot",
			userId,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId,
				polarCustomerId: "cust_bootstrap_stranded_snapshot",
				subscription: null,
				meter: null,
				lastSyncedAt: Date.parse("2026-04-01T00:00:00.000Z"),
			});
		});
		subscriptionsCreateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_bootstrap_stranded_snapshot",
				customerId: "cust_bootstrap_stranded_snapshot",
				productId: polarProductId,
			}),
		} as never);
		const getCustomerStateSpy = vi.spyOn(billing_polar, "getCustomerState").mockResolvedValue(
			create_polar_customer_state({
				customerId: "cust_bootstrap_stranded_snapshot",
				userId,
				productId: polarProductId,
				subscriptionId: "sub_bootstrap_stranded_snapshot",
				currentPeriodStart: "2026-04-13T03:20:38.364Z",
				currentPeriodEnd: "2026-05-13T03:20:38.364Z",
			}),
		);
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_bootstrap_stranded_snapshot" as never);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T03:20:41.064Z"));

		const result = await t.action(internal.billing.bootstrap_free_subscription, {
			userId,
			email: "bootstrap-stranded@test.local",
			name: "Bootstrap Stranded Snapshot User",
		});

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		expect(result).toBeNull();
		expect(getCustomerStateSpy).toHaveBeenCalledWith(expect.anything(), { userId });
		expect(usageSnapshot?.subscription?.id).toBe("sub_bootstrap_stranded_snapshot");
		expect(usageSnapshot?.subscription?.productId).toBe(polarProductId);
	});

	test("throws when bootstrap fails so the workpool can retry it", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "billing_bootstrap_retry_free_product",
		});

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		customersCreateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("bootstrap customer exploded"),
		} as never);

		await expect(
			t.action(internal.billing.bootstrap_free_subscription, {
				userId,
				email: "bootstrap-retry@test.local",
				name: "Bootstrap Retry User",
			}),
		).rejects.toThrow("Failed to bootstrap Free subscription");
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Failed to bootstrap Free subscription",
			expect.objectContaining({
				error: expect.objectContaining({
					data: expect.objectContaining({
						message: "Failed to create Polar customer",
						cause: expect.objectContaining({
							message: "bootstrap customer exploded",
							name: "UnexpectedClientError",
						}),
						data: expect.objectContaining({
							email: "bootstrap-retry@test.local",
							userId,
						}),
					}),
				}),
				userId,
			}),
		);
	});
});

describe("billing generate_checkout_link url validation", () => {
	test("returns nay for invalid checkout URLs", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "not-a-url",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Invalid checkout URL");
	});

	test("returns nay when origin is not allowed", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://evil.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Origin is not allowed for checkout");
	});

	test("returns nay when success URL is not allowed", async () => {
		const t = test_convex();

		const result = await t.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://app.test",
			successUrl: "https://evil.test/ok",
		});

		expect(result._nay?.message).toBe("Success URL is not allowed for checkout");
	});
});

describe("billing generate_checkout_link auth", () => {
	test("returns nay for anonymous identity before Polar SDK", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_anon_checkout",
			name: "Anon Checkout",
		});

		const result = await asAnonymous.action(api.billing.generate_checkout_link, {
			productId: "prod_x",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("A signed-in account is required for checkout");
	});

	test("throws a Convex impossible-state error for Clerk identity without email", async () => {
		const t = test_convex();
		const asUserNoEmail = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_no_email_checkout" as Id<"users">,
			name: "No Email",
			email: undefined,
		});

		await expect(
			asUserNoEmail.action(api.billing.generate_checkout_link, {
				productId: "prod_x",
				origin: "https://app.test",
				successUrl: "https://app.test/ok",
			}),
		).rejects.toThrow("Email required for signed-in users");
	});
});

describe("handle_polar_customer_state_update", () => {
	test("treats deleted customer state changes as customer cleanup", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_deleted_customer_state" as never);

		await seed_subscription(t, {
			userId,
			customerId: "cust_deleted_customer_state",
			subscriptionId: "sub_deleted_customer_state",
			polarProductId: "prod_deleted_customer_state",
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId,
				polarCustomerId: "cust_deleted_customer_state",
				subscription: {
					id: "sub_deleted_customer_state",
					productId: "prod_deleted_customer_state",
					currency: "eur",
					currentPeriodStart: "2026-04-01T00:00:00.000Z",
					currentPeriodEnd: "2026-05-01T00:00:00.000Z",
				},
				meter: null,
				lastSyncedAt: Date.parse("2026-04-01T00:00:00.000Z"),
			});
		});

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_deleted_customer_state",
					external_id: null,
					deleted_at: "2026-04-19T20:49:18.435490Z",
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		const customer = await t.query(components.polar.lib.getCustomerByUserId, {
			userId,
		});
		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);
		const subscriptions = await t.query(components.polar.lib.listCustomerSubscriptions, {
			customerId: "cust_deleted_customer_state",
		});

		expect(customer).toBeNull();
		expect(usageSnapshot).toBeNull();
		expect(subscriptions).toEqual([]);
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("enqueues Free bootstrap when a signed-in customer has no active subscriptions", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_with_anagraphic(t, {
			displayName: "Zero Active Billing",
			email: "zero-active-billing@test.local",
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_zero_active_subscription" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_zero_active_subscription",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.bootstrap_free_subscription, {
			userId,
			email: "zero-active-billing@test.local",
			name: "Zero Active Billing",
		});
	});

	test("logs and skips Free bootstrap when a zero-active customer external id is invalid", async () => {
		const t = test_convex();
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_zero_active_invalid_user" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_zero_active_invalid_user",
					external_id: "not_a_user_id",
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Cannot enqueue Free subscription bootstrap after cancellation: invalid user id",
			{
				externalId: "not_a_user_id",
				polarCustomerId: "cust_zero_active_invalid_user",
				reason: "customer.state_changed:zero_active_subscriptions",
			},
		);
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("logs and skips Free bootstrap when a zero-active customer user row is missing", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await t.run(async (ctx) => {
			await ctx.db.delete("users", userId);
		});
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_zero_active_missing_user" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_zero_active_missing_user",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Cannot enqueue Free subscription bootstrap after cancellation: missing user",
			{
				polarCustomerId: "cust_zero_active_missing_user",
				reason: "customer.state_changed:zero_active_subscriptions",
				userId,
			},
		);
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("does not enqueue Free bootstrap for anonymous zero-active customer state", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_zero_active_anonymous" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_zero_active_anonymous",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("does not enqueue Free bootstrap for deleted signed-in zero-active customer state", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_with_anagraphic(t, {
			displayName: "Deleted Billing",
			email: "deleted-billing@test.local",
			deletedAt: Date.parse("2026-04-19T20:49:20.577Z"),
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_zero_active_deleted" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-19T20:49:20.577120Z",
				data: {
					id: "cust_zero_active_deleted",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("writes the usage snapshot directly from the active subscription meter in the webhook payload", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const polarProductId = "billing_refresh_snapshot_webhook_product";
		const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_refresh_snapshot_webhook" as never);

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
				prices: [
					{
						id: "price_old_webhook_meter",
						createdAt: "2025-12-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "metered_unit",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						unitAmount: "1",
						recurringInterval: "month",
						meterId: "meter_old_webhook",
						meter: { id: "meter_old_webhook", name: "Legacy usage" },
					},
					{
						id: "price_new_webhook_meter",
						createdAt: "2026-01-01T00:00:00.000Z",
						modifiedAt: null,
						amountType: "metered_unit",
						isArchived: false,
						productId: polarProductId,
						priceCurrency: "eur",
						unitAmount: "1",
						recurringInterval: "month",
						meterId: "meter_new_webhook",
						meter: { id: "meter_new_webhook", name: "Press usage" },
					},
				],
				medias: [],
				benefits: [],
			},
		});

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-11T05:30:11.300891Z",
				data: {
					id: "cust_refresh_snapshot_webhook",
					external_id: userId,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_webhook",
							currency: "eur",
							product_id: polarProductId,
							current_period_start: "2026-04-07T12:51:57.211492Z",
							current_period_end: "2026-05-07T12:51:57.211492Z",
							meters: [
								{
									meter_id: "meter_new_webhook",
									consumed_units: 6,
									credited_units: 0,
									amount: 6,
								},
							],
						},
					],
					active_meters: [
						{
							meter_id: "meter_new_webhook",
							consumed_units: 6,
							credited_units: 2178,
							balance: 2172,
						},
					],
				},
			},
		});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const paygRecurringCents = billing_PRODUCTS["Pay As You Go"].recurringCreditsCents;
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.subscription?.id).toBe("sub_refresh_snapshot_webhook");
		expect(usageSnapshot!.meter?.id).toBe("meter_new_webhook");
		// The inline credit only changes `consumedUnits` and `balance`.
		expect(usageSnapshot!.meter?.amountDueCents).toBe(6);
		expect(usageSnapshot!.meter?.balance).toBe(2172 + paygRecurringCents);
	});

	test("throws when the webhook payload contains multiple active subscriptions", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_refresh_snapshot_multiple_active_product",
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_refresh_snapshot_multiple_active" as never);

		await expect(
			t.mutation(internal.billing.handle_polar_customer_state_update, {
				payload: {
					type: "customer.state_changed",
					timestamp: "2026-04-13T03:20:41.064Z",
					data: {
						id: "cust_refresh_snapshot_multiple_active",
						external_id: userId,
						active_subscriptions: [
							{
								id: "sub_refresh_snapshot_multiple_active_1",
								product_id: polarProductId,
								currency: "eur",
								current_period_start: "2026-04-13T03:20:38.364476Z",
								current_period_end: "2026-05-13T03:20:38.364476Z",
								meters: [],
							},
							{
								id: "sub_refresh_snapshot_multiple_active_2",
								product_id: polarProductId,
								currency: "eur",
								current_period_start: "2026-04-13T03:20:38.364476Z",
								current_period_end: "2026-05-13T03:20:38.364476Z",
								meters: [],
							},
						],
						active_meters: [],
					},
				},
			}),
		).rejects.toThrow("Multiple active subscriptions are not supported");
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("writes the Free subscription snapshot with the customer meter balance and zero amount due", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_refresh_snapshot_free_product",
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_refresh_snapshot_free" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-13T03:20:41.064Z",
				data: {
					id: "cust_refresh_snapshot_free",
					external_id: userId,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_free",
							product_id: polarProductId,
							currency: "eur",
							current_period_start: "2026-04-13T03:20:38.364476Z",
							current_period_end: "2026-05-13T03:20:38.364476Z",
							meters: [],
						},
					],
					active_meters: [
						{
							meter_id: "meter_press_usage",
							consumed_units: 240,
							credited_units: 1000,
							balance: 760,
						},
					],
				},
			},
		});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const freeRecurringCents = billing_PRODUCTS.Free.recurringCreditsCents;
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.subscription?.id).toBe("sub_refresh_snapshot_free");
		// First-period refresh applies the recurring credit on top of the webhook meter.
		expect(usageSnapshot!.meter).toEqual({
			id: "meter_press_usage",
			consumedUnits: 240 - freeRecurringCents,
			creditedUnits: 1000,
			balance: 760 + freeRecurringCents,
			amountDueCents: 0,
		});
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "monthly_credit",
					externalCustomerId: userId,
					externalId: `monthly_credit::${userId}::sub_refresh_snapshot_free::2026-04-13T03:20:38.364476Z`,
					metadata: expect.objectContaining({
						amount: -freeRecurringCents,
						subscriptionId: "sub_refresh_snapshot_free",
						productId: polarProductId,
						periodStart: "2026-04-13T03:20:38.364476Z",
					}),
				}),
			],
		});
	});

	test("stores the customer meter balance and subscription meter amount due for paid plans", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_pro_product(t, {
			polarProductId: "billing_refresh_snapshot_pro_product",
		});
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_refresh_snapshot_pro" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-13T03:20:41.064Z",
				data: {
					id: "cust_refresh_snapshot_pro",
					external_id: userId,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_pro",
							product_id: polarProductId,
							currency: "eur",
							current_period_start: "2026-04-13T03:20:38.364476Z",
							current_period_end: "2026-05-13T03:20:38.364476Z",
							meters: [
								{
									meter_id: "meter_press_usage",
									consumed_units: 123,
									credited_units: 1000,
									amount: 123,
								},
							],
						},
					],
					active_meters: [
						{
							meter_id: "meter_press_usage",
							consumed_units: 123,
							credited_units: 1000,
							balance: 877,
						},
					],
				},
			},
		});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const proRecurringCents = billing_PRODUCTS.Pro.recurringCreditsCents;
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.meter?.id).toBe("meter_press_usage");
		// The inline credit only changes `consumedUnits` and `balance`.
		expect(usageSnapshot!.meter?.amountDueCents).toBe(123);
		expect(usageSnapshot!.meter?.balance).toBe(877 + proRecurringCents);
	});

	test("writes the subscription snapshot and enqueues credits when no usage meter is resolvable yet", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_refresh_snapshot_missing_meter_product",
			benefits: [],
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_refresh_snapshot_missing_meter" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-04-13T03:20:41.064Z",
				data: {
					id: "cust_refresh_snapshot_missing_meter",
					external_id: userId,
					active_subscriptions: [
						{
							id: "sub_refresh_snapshot_missing_meter",
							product_id: polarProductId,
							currency: "eur",
							current_period_start: "2026-04-13T03:20:38.364476Z",
							current_period_end: "2026-05-13T03:20:38.364476Z",
							meters: [],
						},
					],
					active_meters: [],
				},
			},
		});

		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const freeRecurringCents = billing_PRODUCTS.Free.recurringCreditsCents;
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.subscription?.id).toBe("sub_refresh_snapshot_missing_meter");
		// No meter resolves here, so the optimistic write leaves `meter` as `null`.
		expect(usageSnapshot!.meter).toBeNull();
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "monthly_credit",
					externalCustomerId: userId,
					externalId: `monthly_credit::${userId}::sub_refresh_snapshot_missing_meter::2026-04-13T03:20:38.364476Z`,
					metadata: expect.objectContaining({
						amount: -freeRecurringCents,
						subscriptionId: "sub_refresh_snapshot_missing_meter",
						productId: polarProductId,
						periodStart: "2026-04-13T03:20:38.364476Z",
					}),
				}),
			],
		});
	});
});

describe("refresh_from_polar_customer_state", () => {
	test("replays the SDK customer state through the shared refresh flow", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_admin_refresh_free_product",
		});
		const getCustomerStateSpy = vi.spyOn(billing_polar, "getCustomerState").mockResolvedValue(
			create_polar_customer_state({
				customerId: "cust_admin_refresh_free",
				userId,
				productId: polarProductId,
				subscriptionId: "sub_admin_refresh_free",
				currentPeriodStart: "2026-04-13T03:20:38.364Z",
				currentPeriodEnd: "2026-05-13T03:20:38.364Z",
			}),
		);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_admin_refresh_free" as never);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T03:20:41.064Z"));

		await t.action(internal.billing.refresh_from_polar_customer_state, {
			userId,
		});

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		const freeRecurringCents = billing_PRODUCTS.Free.recurringCreditsCents;
		expect(getCustomerStateSpy).toHaveBeenCalledWith(expect.anything(), { userId });
		expect(usageSnapshot).not.toBeNull();
		expect(usageSnapshot!.polarCustomerId).toBe("cust_admin_refresh_free");
		expect(usageSnapshot!.subscription).toEqual({
			id: "sub_admin_refresh_free",
			productId: polarProductId,
			currency: "eur",
			currentPeriodStart: "2026-04-13T03:20:38.364Z",
			currentPeriodEnd: "2026-05-13T03:20:38.364Z",
		});
		expect(usageSnapshot!.lastSyncedAt).toBe(Date.parse("2026-04-13T03:20:41.064Z"));
		expect(usageSnapshot!.meter).toEqual({
			id: "meter_press_usage",
			consumedUnits: -freeRecurringCents,
			creditedUnits: 0,
			balance: freeRecurringCents,
			amountDueCents: 0,
		});
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "monthly_credit",
					externalCustomerId: userId,
					externalId: `monthly_credit::${userId}::sub_admin_refresh_free::2026-04-13T03:20:38.364Z`,
					metadata: expect.objectContaining({
						amount: -freeRecurringCents,
						subscriptionId: "sub_admin_refresh_free",
						productId: polarProductId,
						periodStart: "2026-04-13T03:20:38.364Z",
					}),
				}),
			],
		});
	});

	test("skips the same-period replay when the snapshot already exists", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_free_product(t, {
			polarProductId: "billing_admin_refresh_same_period_free_product",
		});
		const sdkState = create_polar_customer_state({
			customerId: "cust_admin_refresh_same_period",
			userId,
			productId: polarProductId,
			subscriptionId: "sub_admin_refresh_same_period",
			currentPeriodStart: "2026-04-13T03:20:38.364476Z",
			currentPeriodEnd: "2026-05-13T03:20:38.364476Z",
		});
		vi.spyOn(billing_polar, "getCustomerState").mockResolvedValue(sdkState);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_admin_refresh_same_period" as never);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-13T03:20:41.064Z"));

		await t.action(internal.billing.refresh_from_polar_customer_state, {
			userId,
		});

		const usageSnapshotAfterFirstReplay = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		enqueueActionSpy.mockClear();

		await t.action(internal.billing.refresh_from_polar_customer_state, {
			userId,
		});

		const usageSnapshotAfterSecondReplay = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);

		expect(usageSnapshotAfterFirstReplay).not.toBeNull();
		expect(usageSnapshotAfterSecondReplay).toEqual(usageSnapshotAfterFirstReplay);
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});
});

describe("billing generate_checkout_link product id", () => {
	test("returns nay when productId does not match a synced non-archived Polar product", async () => {
		const t = test_convex();
		const polarProductName = billing_PRODUCTS["Pay As You Go"].name;
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
			external_id: "user_curated_checkout" as Id<"users">,
			name: "Curated Checkout",
			email: "curated-checkout@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: "some_other_product_id",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Invalid checkout product");
	});
});

describe("billing generate_checkout_link create session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns nay when Polar checkout session creation fails", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_checkout_session_fail",
		});

		vi.spyOn(billing_polar, "createCheckoutSession").mockRejectedValue(new Error("polar checkout exploded"));

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_fail" as Id<"users">,
			name: "Checkout Session Fail",
			email: "checkout-session-fail@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._nay?.message).toBe("Failed to create a checkout link");
		expect(result._nay?.cause).toMatchObject({
			message: "polar checkout exploded",
			name: "Error",
		});
	});

	test("returns yay with the checkout URL", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_checkout_session_success",
		});

		vi.spyOn(billing_polar, "createCheckoutSession").mockResolvedValue({
			url: "https://checkout.test/session",
		} as never);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_success" as Id<"users">,
			name: "Checkout Session Success",
			email: "checkout-session-success@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
			locale: "it",
		});

		expect(result._yay?.url).toBe("https://checkout.test/session?locale=it");
	});

	test("forwards subscriptionId to checkout creation", async () => {
		const t = test_convex();
		const { polarProductId } = await seed_pro_product(t, {
			polarProductId: "billing_checkout_session_upgrade_from_free",
		});

		const createCheckoutSessionSpy = vi.spyOn(billing_polar, "createCheckoutSession").mockResolvedValue({
			url: "https://checkout.test/session",
		} as never);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_checkout_session_upgrade_from_free" as Id<"users">,
			name: "Checkout Session Upgrade From Free",
			email: "checkout-session-upgrade-from-free@test.local",
		});

		const result = await asUser.action(api.billing.generate_checkout_link, {
			productId: polarProductId,
			subscriptionId: "sub_free_upgrade",
			origin: "https://app.test",
			successUrl: "https://app.test/ok",
		});

		expect(result._yay?.url).toBe("https://checkout.test/session");
		expect(createCheckoutSessionSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				productIds: [polarProductId],
				subscriptionId: "sub_free_upgrade",
			}),
		);
	});
});

describe("billing change_current_subscription", () => {
	beforeEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	afterEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	test("upgrades immediately with invoice proration and waits for the subscription webhook", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payg_upgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_upgrade",
		});

		await seed_subscription(t, {
			userId: "user_upgrade_plan",
			customerId: "cust_upgrade_plan",
			subscriptionId: "sub_upgrade_plan",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_upgrade_plan",
				customerId: "cust_upgrade_plan",
				productId: polarProProductId,
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_upgrade_plan" as Id<"users">,
			name: "Upgrade Plan",
			email: "upgrade-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_upgrade_plan",
			subscriptionUpdate: {
				productId: polarProProductId,
				prorationBehavior: "invoice",
			},
		});

		const storedSubscription = await t.query(components.polar.lib.getSubscription, {
			id: "sub_upgrade_plan",
		});
		expect(storedSubscription?.productId).toBe(polarPaygProductId);
		expect(storedSubscription?.pendingUpdate).toBeNull();
	});

	test("schedules downgrades for the next period and waits for the subscription webhook", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payg_downgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_downgrade",
		});

		await seed_subscription(t, {
			userId: "user_downgrade_plan",
			customerId: "cust_downgrade_plan",
			subscriptionId: "sub_downgrade_plan",
			polarProductId: polarProProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_downgrade_plan",
				customerId: "cust_downgrade_plan",
				productId: polarProProductId,
				pendingUpdate: {
					id: "pending_downgrade_plan",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: polarPaygProductId,
					seats: null,
				},
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_downgrade_plan" as Id<"users">,
			name: "Downgrade Plan",
			email: "downgrade-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarPaygProductId,
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_downgrade_plan",
			subscriptionUpdate: {
				productId: polarPaygProductId,
				prorationBehavior: "next_period",
			},
		});

		const storedSubscription = await t.query(components.polar.lib.getSubscription, {
			id: "sub_downgrade_plan",
		});
		expect(storedSubscription?.productId).toBe(polarProProductId);
		expect(storedSubscription?.pendingUpdate).toBeNull();
	});

	test("schedules paid to Free downgrades for the next period", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_change_free_downgrade",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_pro_to_free",
		});

		await seed_subscription(t, {
			userId: "user_downgrade_free_plan",
			customerId: "cust_downgrade_free_plan",
			subscriptionId: "sub_downgrade_free_plan",
			polarProductId: polarProProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_downgrade_free_plan",
				customerId: "cust_downgrade_free_plan",
				productId: polarProProductId,
				pendingUpdate: {
					id: "pending_downgrade_free_plan",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: polarFreeProductId,
					seats: null,
				},
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_downgrade_free_plan" as Id<"users">,
			name: "Downgrade Free Plan",
			email: "downgrade-free-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarFreeProductId,
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_downgrade_free_plan",
			subscriptionUpdate: {
				productId: polarFreeProductId,
				prorationBehavior: "next_period",
			},
		});
	});

	test("returns nay when upgrading from Free", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_change_current_free",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_target_pro_from_free",
		});

		await seed_subscription(t, {
			userId: "user_current_free",
			customerId: "cust_current_free",
			subscriptionId: "sub_current_free",
			polarProductId: polarFreeProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_current_free" as Id<"users">,
			name: "Current Free",
			email: "current-free@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Use checkout to upgrade from Free");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the user selects the current product", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_same_plan",
		});

		await seed_subscription(t, {
			userId: "user_same_plan",
			customerId: "cust_same_plan",
			subscriptionId: "sub_same_plan",
			polarProductId: polarPaygProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_same_plan" as Id<"users">,
			name: "Same Plan",
			email: "same-plan@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarPaygProductId,
		});

		expect(result._nay?.message).toBe("You're already on this plan");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the target product is unknown", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_unknown_current",
		});

		await seed_subscription(t, {
			userId: "user_unknown_target",
			customerId: "cust_unknown_target",
			subscriptionId: "sub_unknown_target",
			polarProductId: polarPaygProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_unknown_target" as Id<"users">,
			name: "Unknown Target",
			email: "unknown-target@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: "missing_product",
		});

		expect(result._nay?.message).toBe("Invalid target plan");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay for anonymous users", async () => {
		const t = test_convex();
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: "user_change_subscription_anonymous",
			name: "Anonymous Plan Change",
		});

		const result = await asAnonymous.action(api.billing.change_current_subscription, {
			productId: "any_product",
		});

		expect(result._nay?.message).toBe("A signed-in account is required for billing");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns nay when the user has no current subscription", async () => {
		const t = test_convex();
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_without_subscription" as Id<"users">,
			name: "No Current Subscription",
			email: "no-current-subscription@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: "any_product",
		});

		expect(result._nay?.message).toBe("No active subscription found");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});

	test("returns a payment failure as a user-safe nay", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_payment_failed_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_payment_failed_target",
		});

		await seed_subscription(t, {
			userId: "user_payment_failed",
			customerId: "cust_payment_failed",
			subscriptionId: "sub_payment_failed",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new PaymentFailed(
				{
					error: "PaymentFailed",
					detail: "Card was declined",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_payment_failed"),
					response: new Response(JSON.stringify({ error: "PaymentFailed" }), { status: 402 }),
					body: JSON.stringify({ error: "PaymentFailed" }),
				},
			),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_payment_failed" as Id<"users">,
			name: "Payment Failed",
			email: "payment-failed@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Payment failed while updating the subscription");
	});

	test("returns a subscription lock as a user-safe nay", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_locked_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_locked_target",
		});

		await seed_subscription(t, {
			userId: "user_subscription_locked",
			customerId: "cust_subscription_locked",
			subscriptionId: "sub_subscription_locked",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new SubscriptionLocked(
				{
					error: "SubscriptionLocked",
					detail: "Subscription is locked",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_subscription_locked"),
					response: new Response(JSON.stringify({ error: "SubscriptionLocked" }), { status: 409 }),
					body: JSON.stringify({ error: "SubscriptionLocked" }),
				},
			),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_subscription_locked" as Id<"users">,
			name: "Subscription Locked",
			email: "subscription-locked@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Subscription is locked and cannot be changed right now");
	});

	test("returns a generic nay for unexpected Polar errors", async () => {
		const t = test_convex();
		const { polarProductId: polarPaygProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_change_generic_error_current",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_change_generic_error_target",
		});

		await seed_subscription(t, {
			userId: "user_generic_plan_change_error",
			customerId: "cust_generic_plan_change_error",
			subscriptionId: "sub_generic_plan_change_error",
			polarProductId: polarPaygProductId,
		});

		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar change exploded"),
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_generic_plan_change_error" as Id<"users">,
			name: "Generic Plan Change Error",
			email: "generic-plan-change-error@test.local",
		});

		const result = await asUser.action(api.billing.change_current_subscription, {
			productId: polarProProductId,
		});

		expect(result._nay?.message).toBe("Failed to change the subscription");
	});
});

describe("billing cancel_current_subscription", () => {
	beforeEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	afterEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	test("schedules paid subscriptions to Free for the next period", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_cancel_to_free_product",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_cancel_to_free_pro_product",
		});

		await seed_subscription(t, {
			userId: "user_cancel_to_free",
			customerId: "cust_cancel_to_free",
			subscriptionId: "sub_cancel_to_free",
			polarProductId: polarProProductId,
		});
		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: create_updated_polar_subscription({
				subscriptionId: "sub_cancel_to_free",
				customerId: "cust_cancel_to_free",
				productId: polarProProductId,
				pendingUpdate: {
					id: "pending_cancel_to_free",
					appliesAt: "2026-02-01T00:00:00.000Z",
					productId: polarFreeProductId,
					seats: null,
				},
			}) as never,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_cancel_to_free" as Id<"users">,
			name: "Cancel To Free",
			email: "cancel-to-free@test.local",
		});

		const result = await asUser.action(api.billing.cancel_current_subscription, {});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_cancel_to_free",
			subscriptionUpdate: {
				productId: polarFreeProductId,
				prorationBehavior: "next_period",
			},
		});
	});

	test("uncancels pending-cancel subscriptions before scheduling Free", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_cancel_pending_to_free_product",
		});
		const { polarProductId: polarProProductId } = await seed_pro_product(t, {
			polarProductId: "billing_cancel_pending_to_free_pro_product",
		});

		await seed_subscription(t, {
			userId: "user_cancel_pending_to_free",
			customerId: "cust_cancel_pending_to_free",
			subscriptionId: "sub_cancel_pending_to_free",
			polarProductId: polarProProductId,
			cancelAtPeriodEnd: true,
			canceledAt: "2026-01-15T00:00:00.000Z",
			endsAt: "2026-02-01T00:00:00.000Z",
		});
		subscriptionsUpdateMock
			.mockResolvedValueOnce({
				ok: true,
				value: create_updated_polar_subscription({
					subscriptionId: "sub_cancel_pending_to_free",
					customerId: "cust_cancel_pending_to_free",
					productId: polarProProductId,
				}) as never,
			})
			.mockResolvedValueOnce({
				ok: true,
				value: create_updated_polar_subscription({
					subscriptionId: "sub_cancel_pending_to_free",
					customerId: "cust_cancel_pending_to_free",
					productId: polarProProductId,
					pendingUpdate: {
						id: "pending_cancel_pending_to_free",
						appliesAt: "2026-02-01T00:00:00.000Z",
						productId: polarFreeProductId,
						seats: null,
					},
				}) as never,
			});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_cancel_pending_to_free" as Id<"users">,
			name: "Cancel Pending To Free",
			email: "cancel-pending-to-free@test.local",
		});

		const result = await asUser.action(api.billing.cancel_current_subscription, {});
		const storedSubscription = await t.query(components.polar.lib.getSubscription, {
			id: "sub_cancel_pending_to_free",
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsUpdateMock).toHaveBeenNthCalledWith(1, expect.anything(), {
			id: "sub_cancel_pending_to_free",
			subscriptionUpdate: {
				cancelAtPeriodEnd: false,
			},
		});
		expect(subscriptionsUpdateMock).toHaveBeenNthCalledWith(2, expect.anything(), {
			id: "sub_cancel_pending_to_free",
			subscriptionUpdate: {
				productId: polarFreeProductId,
				prorationBehavior: "next_period",
			},
		});
		expect(storedSubscription?.cancelAtPeriodEnd).toBe(false);
		expect(storedSubscription?.canceledAt).toBeNull();
		expect(storedSubscription?.endsAt).toBeNull();
	});

	test("does not cancel subscriptions already on Free", async () => {
		const t = test_convex();
		const { polarProductId: polarFreeProductId } = await seed_free_product(t, {
			polarProductId: "billing_cancel_current_free_product",
		});

		await seed_subscription(t, {
			userId: "user_cancel_current_free",
			customerId: "cust_cancel_current_free",
			subscriptionId: "sub_cancel_current_free",
			polarProductId: polarFreeProductId,
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: "user_cancel_current_free" as Id<"users">,
			name: "Cancel Current Free",
			email: "cancel-current-free@test.local",
		});

		const result = await asUser.action(api.billing.cancel_current_subscription, {});

		expect(result._nay?.message).toBe("You're already on this plan");
		expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
	});
});

describe("billing revoke_subscription", () => {
	beforeEach(() => {
		subscriptionsRevokeMock.mockReset();
	});

	afterEach(() => {
		subscriptionsRevokeMock.mockReset();
	});

	test("returns not found when the user has no current subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription not found");
	});

	test("revokes the current subscription for the target user", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: true,
			value: {} as never,
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_active",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_active",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_active",
				customerId: "cust_billing_revoke_active",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result).toEqual({ _yay: null });
		expect(subscriptionsRevokeMock).toHaveBeenCalledTimes(1);
		expect(subscriptionsRevokeMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_billing_revoke_active",
		});
	});

	test("returns already canceled when Polar reports an already canceled subscription", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new AlreadyCanceledSubscription(
				{
					error: "AlreadyCanceledSubscription",
					detail: "Subscription already canceled",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_revoke_already_canceled"),
					response: new Response(JSON.stringify({ error: "AlreadyCanceledSubscription" }), { status: 403 }),
					body: JSON.stringify({ error: "AlreadyCanceledSubscription" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_already_canceled",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_already_canceled",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_already_canceled",
				customerId: "cust_billing_revoke_already_canceled",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription already canceled");
	});

	test("returns not found when Polar reports the subscription is missing", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new ResourceNotFound(
				{
					error: "ResourceNotFound",
					detail: "Subscription not found",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_revoke_resource_not_found"),
					response: new Response(JSON.stringify({ error: "ResourceNotFound" }), { status: 404 }),
					body: JSON.stringify({ error: "ResourceNotFound" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_resource_not_found",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_resource_not_found",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_resource_not_found",
				customerId: "cust_billing_revoke_resource_not_found",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		const result = await t.action(internal.billing.revoke_subscription, {
			userId,
		});

		expect(result._nay?.message).toBe("Subscription not found");
	});

	test("throws when Polar returns an unexpected revoke error", async () => {
		subscriptionsRevokeMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar revoke exploded"),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_revoke_prod_unexpected_error",
		});

		await t.mutation(components.polar.lib.insertCustomer, {
			id: "cust_billing_revoke_unexpected_error",
			userId,
		});

		await t.mutation(components.polar.lib.createSubscription, {
			subscription: {
				id: "sub_billing_revoke_unexpected_error",
				customerId: "cust_billing_revoke_unexpected_error",
				productId: polarProductId,
				checkoutId: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:00:00.000Z",
				amount: 1000,
				currency: "usd",
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

		await expect(
			t.action(internal.billing.revoke_subscription, {
				userId,
			}),
		).rejects.toThrow("Failed to revoke subscription");
	});
});

describe("billing schedule_polar_subscription_period_end_cancellation", () => {
	test("schedules a billing-owned row and enqueues the retryable cancellation with the configured backoff", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async function (
			this: Workpool,
			_ctx,
			fn,
			fnArgs,
			options,
		) {
			expect(this.options.defaultRetryBehavior).toEqual({
				initialBackoffMs: 10 * 60 * 1000,
				base: 1.2,
				maxAttempts: Number.POSITIVE_INFINITY,
			});
			expect(fn).toBeDefined();
			expect(fnArgs).toEqual({
				userId,
				subscriptionId: "sub_schedule_initial",
			});
			expect(options?.context).toEqual({
				userId,
			});
			expect(options?.onComplete).toBeDefined();

			return "work_schedule_initial" as never;
		});

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_initial",
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(row?.jobId).toBe("work_schedule_initial");
		expect(row?.updatedAt).toBeTypeOf("number");
	});

	test("cancels the previous work and overwrites the row when scheduling again for the same user", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValueOnce("work_schedule_old" as never)
			.mockResolvedValueOnce("work_schedule_new" as never);

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_old",
		});
		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_new",
		});

		const row = await get_cancel_polar_subscription_job(t, userId);
		const rowCount = await t.run((ctx) =>
			ctx.db
				.query("billing_cancel_polar_subscription_jobs")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.collect()
				.then((rows) => rows.length),
		);

		expect(enqueueActionSpy).toHaveBeenCalledTimes(2);
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_schedule_old");
		expect(rowCount).toBe(1);
		expect(row?.jobId).toBe("work_schedule_new");
	});

	test("cancels and deletes the row when the scheduler is cleared explicitly", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_schedule_delete" as never);
		const cancelSpy = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);

		await t.action(internal.billing.schedule_polar_subscription_period_end_cancellation, {
			userId,
			subscriptionId: "sub_schedule_delete",
		});
		await t.action(internal.billing.cancel_scheduled_polar_subscription_period_end_cancellation, {
			userId,
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(cancelSpy).toHaveBeenCalledTimes(1);
		expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "work_schedule_delete");
		expect(row).toBeNull();
	});

	test("clears the matching row when the work completes successfully", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_success" as WorkId,
			updatedAt: 12_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_success",
			context: {
				userId,
			},
			result: {
				kind: "success",
				returnValue: null,
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row).toBeNull();
	});

	test("keeps the row when the work fails", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_failed" as WorkId,
			updatedAt: 22_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_failed",
			context: {
				userId,
			},
			result: {
				kind: "failed",
				error: "polar down",
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row?.jobId).toBe("work_complete_failed");
	});

	test("ignores completion from an older replaced job", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		await t.mutation(internal.billing.upsert_cancel_polar_subscription_job, {
			userId,
			jobId: "work_complete_new" as WorkId,
			updatedAt: 32_345,
		});

		await t.mutation(internal.billing.complete_polar_subscription_period_end_cancellation, {
			workId: "work_complete_old",
			context: {
				userId,
			},
			result: {
				kind: "canceled",
			},
		});

		const row = await get_cancel_polar_subscription_job(t, userId);

		expect(row?.jobId).toBe("work_complete_new");
	});
});

describe("billing cancel_polar_subscription_at_period_end", () => {
	beforeEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	afterEach(() => {
		subscriptionsUpdateMock.mockReset();
	});

	test("cancels the captured subscription id without requiring a local subscription mirror", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: true,
			value: {
				id: "sub_billing_cancel_period_end",
			} as never,
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end",
		});

		expect(result).toBeNull();
		expect(subscriptionsUpdateMock).toHaveBeenCalledWith(expect.anything(), {
			id: "sub_billing_cancel_period_end",
			subscriptionUpdate: {
				cancelAtPeriodEnd: true,
			},
		});
	});

	test("treats an already canceled subscription as success", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new AlreadyCanceledSubscription(
				{
					error: "AlreadyCanceledSubscription",
					detail: "Subscription already canceled",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_cancel_period_end_already_canceled"),
					response: new Response(JSON.stringify({ error: "AlreadyCanceledSubscription" }), { status: 403 }),
					body: JSON.stringify({ error: "AlreadyCanceledSubscription" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end_already_canceled",
		});

		expect(result).toBeNull();
	});

	test("treats a missing subscription as success", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new ResourceNotFound(
				{
					error: "ResourceNotFound",
					detail: "Subscription not found",
				},
				{
					request: new Request("https://polar.test/v1/subscriptions/sub_billing_cancel_period_end_missing"),
					response: new Response(JSON.stringify({ error: "ResourceNotFound" }), { status: 404 }),
					body: JSON.stringify({ error: "ResourceNotFound" }),
				},
			),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		const result = await t.action(internal.billing.cancel_polar_subscription_at_period_end, {
			userId,
			subscriptionId: "sub_billing_cancel_period_end_missing",
		});

		expect(result).toBeNull();
	});

	test("throws when Polar returns an unexpected cancel-at-period-end error", async () => {
		subscriptionsUpdateMock.mockResolvedValue({
			ok: false,
			error: new UnexpectedClientError("polar cancel-at-period-end exploded"),
		});

		const t = test_convex();
		const userId = await seed_user_id(t);

		await expect(
			t.action(internal.billing.cancel_polar_subscription_at_period_end, {
				userId,
				subscriptionId: "sub_billing_cancel_period_end_error",
			}),
		).rejects.toThrow("Failed to cancel Polar subscription at period end");
	});
});

describe("ingest_events", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("skips direct Polar calls in test env", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await t.action(internal.billing.ingest_events, {
			events: [
				{
					name: "manual_credit",
					externalCustomerId: userId,
					externalId: "manual_credit::u::123",
					metadata: {
						amount: -2500,
					},
				},
			],
		});

		expect(eventsIngestMock).not.toHaveBeenCalled();
	});

	test("passes externalMemberId through to the Polar payload when present", async () => {
		const t = test_convex();
		const billedUserId = await seed_user_id(t);
		const actorUserId = await seed_user_id(t);
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		eventsIngestMock.mockResolvedValue({ ok: true } as never);

		try {
			await t.action(internal.billing.ingest_events, {
				events: [
					{
						name: "file_save",
						externalCustomerId: billedUserId,
						externalMemberId: actorUserId,
						externalId: `file_save::${billedUserId}::${actorUserId}::workspace_1::project_1::file_1::1`,
						metadata: {
							amount: 1,
							actorUserId,
							billedUserId,
							workspaceId: "workspace_1",
							projectId: "project_1",
							nodeId: "file_1",
							yjsSequence: "1",
						},
					},
				],
			});
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
		}

		expect(eventsIngestMock).toHaveBeenCalledWith(expect.anything(), {
			events: [
				expect.objectContaining({
					name: billing_POLAR_METER_EVENT,
					externalCustomerId: billedUserId,
					externalMemberId: actorUserId,
					metadata: expect.objectContaining({
						name: "file_save",
						actorUserId,
						billedUserId,
					}),
				}),
			],
		});
	});

	test("billing_ingest_events splits signed-in and anonymous billedUserEvents", async () => {
		const t = test_convex();
		const anonymousUserId = await seed_user_id(t);
		const signedInUserId = await seed_signed_in_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_ingest_split",
		});
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		await t.run(async (ctx) => {
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: anonymousUserId, now: Date.now() });
		});
		const { captured, enqueueActionSpy } = mock_billing_ingest_enqueue("work_split_user_events");

		await t.run(async (ctx) => {
			const anonymousUser = await ctx.db.get("users", anonymousUserId);
			const signedInUser = await ctx.db.get("users", signedInUserId);
			if (!anonymousUser || !signedInUser) {
				throw new Error("Expected seeded users");
			}

			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser: signedInUser,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: signedInUserId,
							externalId: "manual_credit::signed_in::1",
							metadata: {
								amount: -1500,
							},
						}),
					},
					{
						billedUser: anonymousUser,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: anonymousUserId,
							externalId: "manual_credit::anonymous::1",
							metadata: {
								amount: -2500,
							},
						}),
					},
				],
			});
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect(captured.ingestPayload).toEqual({
			events: [
				expect.objectContaining({
					name: "manual_credit",
					externalCustomerId: signedInUserId,
					externalId: "manual_credit::signed_in::1",
					metadata: {
						amount: -1500,
					},
				}),
			],
		});

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", anonymousUserId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.consumedUnits).toBe(-2500);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits + 2500);
	});

	test("billing_ingest_events applies anonymous usage amounts locally without queuing Polar work", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);
		await seed_free_product(t, {
			polarProductId: "prod_free_ingest_local_usage",
		});
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);
		await t.run(async (ctx) => {
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now: Date.now() });
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_anonymous_usage_local" as never);

		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}

			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "file_save",
							externalCustomerId: userId,
							externalId: "file_save::anonymous::1",
							metadata: {
								amount: 1,
								actorUserId: userId,
								billedUserId: userId,
								workspaceId: "workspace_1",
								projectId: "project_1",
								nodeId: "file_1",
								yjsSequence: "1",
							},
						}),
					},
				],
			});
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.consumedUnits).toBe(1);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits - 1);
	});
});

function mock_billing_ingest_enqueue(workId: string) {
	const captured: {
		ingestPayload: {
			events: Array<{
				externalId: string;
				externalCustomerId: string;
				metadata: { amount: number };
				name: string;
			}>;
		} | null;
	} = { ingestPayload: null };
	const enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockImplementation(async (_ctx, _functionReference, args) => {
			captured.ingestPayload = args as NonNullable<typeof captured.ingestPayload>;
			return workId as never;
		});

	return { captured, enqueueActionSpy };
}

describe("grant_credit", () => {
	beforeEach(() => {
		eventsIngestMock.mockReset();
	});

	afterEach(() => {
		eventsIngestMock.mockReset();
	});

	test("enqueues the canonical manual_credit event through the ingest workpool", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123_456);
		const { captured, enqueueActionSpy } = mock_billing_ingest_enqueue("work_manual_credit");

		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);

		const result = await t.action(internal.billing.grant_credit, {
			userId,
			amount: 2500,
		});

		expect(result).toEqual({ _yay: null });
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const ingestPayload = captured.ingestPayload;
		if (!ingestPayload) {
			throw new Error("Expected manual credit ingest payload to be captured");
		}
		expect(ingestPayload.events).toHaveLength(1);
		expect(ingestPayload.events[0]!.externalId).toBe(`manual_credit::${userId}::123456`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe(userId);
		expect(ingestPayload.events[0]!.metadata).toEqual({
			amount: -2500,
		});
		expect(ingestPayload.events[0]!.name).toBe("manual_credit");
	});

	test("normalizes negative input to a credit grant", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123_457);
		const { captured, enqueueActionSpy } = mock_billing_ingest_enqueue("work_manual_credit_negative");

		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);

		const result = await t.action(internal.billing.grant_credit, {
			userId,
			amount: -2500,
		});

		expect(result).toEqual({ _yay: null });
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const ingestPayload = captured.ingestPayload;
		if (!ingestPayload) {
			throw new Error("Expected manual credit ingest payload to be captured");
		}
		expect(ingestPayload.events[0]!.externalId).toBe(`manual_credit::${userId}::123457`);
		expect(ingestPayload.events[0]!.metadata).toEqual({
			amount: -2500,
		});
		expect(ingestPayload.events[0]!.name).toBe("manual_credit");
	});

	test("allows negative input to reduce the balance when explicitly enabled", async () => {
		vi.spyOn(Date, "now").mockReturnValue(123_458);
		const { captured, enqueueActionSpy } = mock_billing_ingest_enqueue("work_manual_credit_allowed_negative");

		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);

		const result = await t.action(internal.billing.grant_credit, {
			userId,
			amount: -2495,
			allowNegative: true,
		});

		expect(result).toEqual({ _yay: null });
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		const ingestPayload = captured.ingestPayload;
		if (!ingestPayload) {
			throw new Error("Expected manual adjustment ingest payload to be captured");
		}
		expect(ingestPayload.events[0]!.externalId).toBe(`manual_credit::${userId}::123458`);
		expect(ingestPayload.events[0]!.externalCustomerId).toBe(userId);
		expect(ingestPayload.events[0]!.metadata).toEqual({
			amount: 2495,
		});
		expect(ingestPayload.events[0]!.name).toBe("manual_credit");
	});

	test("returns nay when the target user does not exist", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		await t.run(async (ctx) => {
			await ctx.db.delete("users", userId);
		});
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_manual_credit_missing_user" as never);

		const result = await t.action(internal.billing.grant_credit, {
			userId,
			amount: 2500,
		});

		expect(result).toEqual({
			_nay: {
				message: "User not found",
			},
		});
		expect(eventsIngestMock).not.toHaveBeenCalled();
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});
});

describe("monthly credits engine via handle_polar_customer_state_update", () => {
	async function seed_usage_snapshot(
		t: ReturnType<typeof test_convex>,
		args: {
			userId: Id<"users">;
			polarCustomerId: string;
			subscription: {
				id: string;
				productId: string;
				currency: string;
				currentPeriodStart: string;
				currentPeriodEnd: string;
			} | null;
		},
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert("billing_usage_snapshots", {
				userId: args.userId,
				polarCustomerId: args.polarCustomerId,
				subscription: args.subscription,
				meter: args.subscription
					? {
							id: "meter_units",
							consumedUnits: 0,
							creditedUnits: 0,
							balance: 0,
							amountDueCents: 0,
						}
					: null,
				lastSyncedAt: Date.now(),
			});
		});
	}

	function payg_active_subscription(args: {
		subscriptionId: string;
		product_id: string;
		current_period_start: string;
		current_period_end: string;
	}) {
		return {
			id: args.subscriptionId,
			product_id: args.product_id,
			currency: "eur",
			current_period_start: args.current_period_start,
			current_period_end: args.current_period_end,
			meters: [
				{
					meter_id: "meter_units",
					consumed_units: 0,
					credited_units: 0,
					amount: 0,
				},
			],
		};
	}

	function active_meter() {
		return {
			meter_id: "meter_units",
			consumed_units: 0,
			credited_units: 0,
			balance: 0,
		};
	}

	function expect_monthly_credit_ingest(
		spy: MockInstance,
		args: {
			callIndex: number;
			userId: Id<"users">;
			subscriptionId: string;
			productId: string;
			periodStart: string;
		},
	) {
		const recurringCents = billing_PRODUCTS["Pay As You Go"].recurringCreditsCents;
		expect(spy).toHaveBeenNthCalledWith(args.callIndex, expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "monthly_credit",
					externalCustomerId: args.userId,
					externalId: `monthly_credit::${args.userId}::${args.subscriptionId}::${args.periodStart}`,
					metadata: expect.objectContaining({
						amount: -recurringCents,
						subscriptionId: args.subscriptionId,
						productId: args.productId,
						periodStart: args.periodStart,
					}),
				}),
			],
		});
	}

	test("grants a monthly credit for the first period of an active subscription", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_first_period_product",
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_first_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-01T00:00:00.000Z",
				data: {
					id: "cust_grant_first_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_first_period",
							product_id: polarProductId,
							current_period_start: "2026-01-01T00:00:00.000Z",
							current_period_end: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect_monthly_credit_ingest(enqueueActionSpy, {
			callIndex: 1,
			userId,
			subscriptionId: "sub_grant_first_period",
			productId: polarProductId,
			periodStart: "2026-01-01T00:00:00.000Z",
		});

		const recurringCents = billing_PRODUCTS["Pay As You Go"].recurringCreditsCents;
		const usageSnapshot = await t.run(async (ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(usageSnapshot?.meter).toEqual({
			id: "meter_units",
			consumedUnits: -recurringCents,
			creditedUnits: 0,
			balance: recurringCents,
			amountDueCents: 0,
		});
	});

	test("skips the monthly credit on a same-period repeat webhook delivery", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_same_period_product",
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_same_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:00.000Z",
				data: {
					id: "cust_grant_same_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_same_period",
							product_id: polarProductId,
							current_period_start: "2026-01-01T00:00:00.000Z",
							current_period_end: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:01.000Z",
				data: {
					id: "cust_grant_same_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_same_period",
							product_id: polarProductId,
							current_period_start: "2026-01-01T00:00:00.000Z",
							current_period_end: "2026-02-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		// Period unchanged: no second grant ingest, and Polar dedupes the
		// already-ingested `monthly_credit` event by its deterministic
		// `externalId` if a webhook ever does files another attempt.
		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
	});

	test("grants a monthly credit when the subscription has rolled into a new period", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_advanced_period_product",
		});
		await seed_usage_snapshot(t, {
			userId,
			polarCustomerId: "cust_grant_advanced_period",
			subscription: {
				id: "sub_grant_advanced_period",
				productId: polarProductId,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_advanced_period" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-02-01T00:00:00.000Z",
				data: {
					id: "cust_grant_advanced_period",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_advanced_period",
							product_id: polarProductId,
							current_period_start: "2026-02-01T00:00:00.000Z",
							current_period_end: "2026-03-01T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect_monthly_credit_ingest(enqueueActionSpy, {
			callIndex: 1,
			userId,
			subscriptionId: "sub_grant_advanced_period",
			productId: polarProductId,
			periodStart: "2026-02-01T00:00:00.000Z",
		});
	});

	test("grants a monthly credit when the webhook moves the snapshot to a new subscription mid-period after a plan upgrade", async () => {
		const t = test_convex();
		const userId = await seed_signed_in_user_id(t);
		const { polarProductId: oldProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_upgrade_old_product",
		});
		const { polarProductId: newProductId } = await seed_pay_as_you_go_product(t, {
			polarProductId: "billing_grant_upgrade_new_product",
		});
		await seed_usage_snapshot(t, {
			userId,
			polarCustomerId: "cust_grant_upgrade",
			subscription: {
				id: "sub_grant_upgrade_old",
				productId: oldProductId,
				currency: "eur",
				currentPeriodStart: "2026-01-01T00:00:00.000Z",
				currentPeriodEnd: "2026-02-01T00:00:00.000Z",
			},
		});

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_upgrade" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-15T00:00:00.000Z",
				data: {
					id: "cust_grant_upgrade",
					external_id: userId,
					active_subscriptions: [
						payg_active_subscription({
							subscriptionId: "sub_grant_upgrade_new",
							product_id: newProductId,
							current_period_start: "2026-01-15T00:00:00.000Z",
							current_period_end: "2026-02-15T00:00:00.000Z",
						}),
					],
					active_meters: [active_meter()],
				},
			},
		});

		expect(enqueueActionSpy).toHaveBeenCalledTimes(1);
		expect_monthly_credit_ingest(enqueueActionSpy, {
			callIndex: 1,
			userId,
			subscriptionId: "sub_grant_upgrade_new",
			productId: newProductId,
			periodStart: "2026-01-15T00:00:00.000Z",
		});
	});

	test("is a no-op when the webhook reports no active subscription", async () => {
		const t = test_convex();
		const userId = await seed_user_id(t);

		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_grant_no_subscription" as never);

		await t.mutation(internal.billing.handle_polar_customer_state_update, {
			payload: {
				type: "customer.state_changed",
				timestamp: "2026-01-01T00:00:00.000Z",
				data: {
					id: "cust_grant_no_subscription",
					external_id: userId,
					active_subscriptions: [],
					active_meters: [],
				},
			},
		});

		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});
});
