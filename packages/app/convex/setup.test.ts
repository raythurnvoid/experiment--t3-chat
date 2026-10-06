import "./setup-env.test.ts";
import { afterEach, vi } from "vitest";
import { convexTest, type TestConvexRoot } from "convex-test";
import schema from "./schema.ts";
import { faker } from "@faker-js/faker";
import { make } from "../src/lib/utils.ts";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel";
import { files_ROOT_ID } from "../server/files.ts";
import { files_pending_overlay_db_flush, files_pending_overlay_db_wrap } from "../server/files-pending-overlay.ts";
import type { MutationCtx } from "./_generated/server";
import polar_test from "@convex-dev/polar/test";
import presence_test from "@convex-dev/presence/test";
import workpool_test from "@convex-dev/workpool/test";
import rate_limiter_test from "@convex-dev/rate-limiter/test";
import r2_test from "@convex-dev/r2/test";
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { api, components, internal } from "./_generated/api.js";
import { billing_PRODUCTS } from "../shared/billing.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// #region helpers

const convex_test_modules = import.meta.glob("./**/*.ts");

const test_convex_instances: Array<ReturnType<typeof convexTest>> = [];

// convex-test runs scheduled functions as floating promises — nothing awaits them, and teardown does
// not either. A README seed seeded by one test was still issuing its R2 writes while a later test
// ran, so those writes landed in that test's `globalThis.fetch` spy and failed an exact-compare
// assertion at random. Cancel what has not started yet, then wait for whatever already has, so every
// test owns its own background work instead of leaving it for the next one.
afterEach(async () => {
	const instances = test_convex_instances.splice(0);
	if (instances.length === 0) {
		return;
	}

	// Vitest registers this hook when the file is imported, and its default `stack` order runs such
	// hooks *after* each test file's own `afterEach` — including the ones that put the real `fetch`
	// back. So a request sent from here would really leave the machine. We block it: these leftover
	// jobs are checked by no test, and they fail with or without network, only slower.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => Promise.reject(new Error("fetch is closed during test teardown"))) as typeof fetch;

	try {
		for (const t of instances) {
			try {
				await t.run(async (ctx) => {
					const jobs = await ctx.db.system.query("_scheduled_functions").collect();
					for (const job of jobs) {
						if (job.state.kind === "pending") {
							await ctx.scheduler.cancel(job._id);
						}
					}
				});
				await t.finishInProgressScheduledFunctions();
			} catch {
				// Best-effort cleanup. A test that already deleted its own data can make this throw,
				// and a cleanup failure must not turn into a test failure.
			}
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});

// Keep the named return type; inferring it makes the full type check slower.
export function test_convex(
	options: {
		transactionLimits?: Parameters<typeof convexTest>[0]["transactionLimits"];
	} = {},
): TestConvexRoot<DataModel> {
	const t = convexTest({ schema, modules: convex_test_modules, transactionLimits: options.transactionLimits });
	test_convex_instances.push(t);
	const withIdentity = t.withIdentity.bind(t);
	t.withIdentity = ((identity) => {
		// Use realistic Clerk identities by default; tests that cover the missing
		// email invariant opt out explicitly with `email: undefined`.
		if (identity.issuer === "https://clerk.test" && !("email" in identity)) {
			return withIdentity({
				...identity,
				email: "test-user@example.com",
			});
		}

		return withIdentity(identity);
	}) as typeof t.withIdentity;
	t.registerComponent(
		"polar",
		polar_test.schema as unknown as Parameters<typeof t.registerComponent>[1],
		polar_test.modules as unknown as Parameters<typeof t.registerComponent>[2],
	);
	presence_test.register(t as unknown as Parameters<typeof presence_test.register>[0]);
	workpool_test.register(t, "billing_workpool_bootstrap");
	workpool_test.register(t, "billing_workpool_cancellation");
	workpool_test.register(t, "billing_workpool_usage_event");
	workpool_test.register(t, "files_content_materialization_workpool");
	workpool_test.register(t, "files_upload_conversion_workpool");
	workpool_test.register(t, "files_transfer_workpool");
	workpool_test.register(t, "data_deletion_workpool");
	workpool_test.register(t, "github_mounts_workpool");
	workpool_test.register(t, "plugins_runtime_workpool");
	workpool_test.register(t, "plugins_scheduled_runs_workpool");
	workpool_test.register(t, "ai_chat_bash_jobs_workpool");
	rate_limiter_test.register(t, "rate_limiter");
	r2_test.register(t as unknown as Parameters<typeof r2_test.register>[0]);
	return t;
}

/**
 * Like `t.run`, but the writes of `fn` go through the overlay capture of the mutation wrapper, and
 * the pending overlay flushes before the run ends. Run the jobs it schedules with
 * `t.finishAllScheduledFunctions`.
 */
export async function test_run_with_flush<T>(t: TestConvexRoot<DataModel>, fn: (ctx: MutationCtx) => Promise<T>) {
	return await t.run(async (ctx) => {
		const wrapped = { ...ctx, ...files_pending_overlay_db_wrap(ctx) };
		const result = await fn(wrapped);
		await files_pending_overlay_db_flush(wrapped);
		return result;
	});
}

/**
 * Wrap a registered mutation's handler for the rest of the test. convex-test runs a function through
 * its `_handler`, so `wrap` sees each run's ctx and args: it can read metrics inside the transaction
 * or make one run throw. It calls `handler` to run the real code.
 */
export function test_spy_handler(
	registered: unknown,
	wrap: (handler: (ctx: MutationCtx, args: unknown) => Promise<null>, ctx: MutationCtx, args: unknown) => Promise<null>,
) {
	const target = registered as { _handler: (ctx: MutationCtx, args: unknown) => Promise<null> };
	const handler = target._handler;
	vi.spyOn(target, "_handler").mockImplementation(async (ctx, args) => await wrap(handler, ctx, args));
}

export async function test_get_file_yjs_pointers(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
	return await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node?.yjsLastSequenceId || !node.yjsSnapshotId) {
			throw new Error("Expected the test file to have Yjs pointers");
		}

		return {
			yjsLastSequenceId: node.yjsLastSequenceId,
			yjsSnapshotId: node.yjsSnapshotId,
		};
	});
}

export async function test_create_saved_text_file(
	t: ReturnType<typeof test_convex>,
	args: { membershipId: Id<"organizations_workspaces_users">; path: string; textContent?: string },
) {
	const membership = await t.run((ctx) => ctx.db.get("organizations_workspaces_users", args.membershipId));
	if (!membership) throw new Error("Expected a test membership");
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: membership.userId });
	const segments = args.path.split("/").slice(1);
	for (let depth = 1; depth <= segments.length; depth++) {
		const kind = depth === segments.length ? "file" : "folder";
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: `/${segments.slice(0, depth).join("/")}`,
			kind,
		});
		if (created._nay) throw new Error(created._nay.message);
		const { target, pendingUpdateId, operationBatchId } = created._yay;
		if (!created._yay.created) {
			// Never accept an existing parent's proposal as part of fixture setup.
			if (kind === "folder" && target.kind === "saved") continue;
			throw new Error(`Expected a new test ${kind}: ${args.path}`);
		}
		if (target.kind !== "private" || !pendingUpdateId) throw new Error("Expected a private test proposal");
		if (kind === "file") {
			if (!operationBatchId) throw new Error("Expected a private text batch");
			for (const role of ["staged", "unstaged"] as const) {
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId,
					role,
					text: args.textContent ?? "",
				});
				if (staged._nay) throw new Error(staged._nay.message);
			}
			const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				pendingUpdateId,
				operationBatchId,
			});
			if (ready._nay) throw new Error(ready._nay.message);
		}
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!proposal) throw new Error("Expected a proposal to save");
		// Save new parents first, then publish exact text at sequence 0.
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: args.membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (saved._yay.target.kind !== "saved") throw new Error("Expected a saved test node");
		if (kind === "file") return saved._yay.target.id;
	}
	throw new Error("Expected a test file path");
}

// #endregion

// #region mocks

export const test_mocks_hardcoded = ((/* iife */) => {
	const organization_id = {
		organization_1: "app_organization_test_1" as Id<"organizations">,
		organization_2: "app_organization_test_2" as Id<"organizations">,
	} as const;

	const workspace_id = {
		workspace_1: "app_workspace_test_1" as Id<"organizations_workspaces">,
		workspace_2: "app_workspace_test_2" as Id<"organizations_workspaces">,
	} as const;

	const membership_id = {
		membership_1: "test_membership" as Id<"organizations_workspaces_users">,
	} as const;

	const user = {
		user_1: {
			id: "user_1",
		},
		user_2: {
			id: "user_2",
		},
	} as const;

	const file_root_generic = {
		parentId: files_ROOT_ID,
	} as const;

	const file_root_1 = {
		name: "file_root_1_name",
		parentId: files_ROOT_ID,
	} as const;

	const file_root_2 = {
		name: "file_root_2_name",
		parentId: files_ROOT_ID,
	} as const;

	const file_root_1_child_1 = {
		name: "file_root_1_child_1_name",
	} as const;

	const file_root_1_child_2 = {
		name: "file_root_1_child_2_name",
	} as const;

	const file_root_1_child_1_deep_1 = {
		name: "file_root_1_child_1_deep_1_name",
	} as const;

	return {
		organization_id,
		workspace_id,
		membership_id,
		user,
		files: {
			file_root_generic,
			file_root_1,
			file_root_2,
			file_root_1_child_1,
			file_root_1_child_2,
			file_root_1_child_1_deep_1,
		},
	} as const;
})();

export const test_mocks = {
	files: ((/* iife */) => {
		const base = () => {
			const updatedAt = faker.date.recent().getTime();
			const name = faker.lorem.words({
				min: 1,
				max: 3,
			});

			return make<ConvexDocUserData<"files_nodes">>({
				organizationId: test_mocks_hardcoded.organization_id.organization_1,
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				createdBy: test_mocks_hardcoded.user.user_1.id as Id<"users">,
				updatedAt: updatedAt,
				updatedBy: test_mocks_hardcoded.user.user_1.id as Id<"users">,
				parentId: test_mocks_hardcoded.files.file_root_1.parentId,
				name: name,
				sortName: files_sort_text_key(name),
				kind: "folder",
				path: `/${name}`,
				treePath: `/${name}/`,
				pathDepth: 1,
				lowercaseExtension: null,
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,
				archiveOperationId: null,
			});
		};

		return {
			base,
		};
	})(),
};

/**
 * Workspace creation schedules a README seed action. Cancel it so test
 * workspaces stay empty and no background action races test assertions.
 */
export async function test_mocks_cancel_pending_home_file_seeds(ctx: MutationCtx) {
	const jobs = await ctx.db.system.query("_scheduled_functions").collect();
	for (const job of jobs) {
		if (job.state.kind === "pending" && job.name.includes("create_home_file")) {
			await ctx.scheduler.cancel(job._id);
		}
	}
}

const test_plan_product_ids: Record<keyof typeof billing_PRODUCTS, string> = {
	Free: "prod_test_free",
	"Pay As You Go": "prod_test_pay_as_you_go",
	Pro: "prod_test_pro",
};

export const test_mocks_fill_db_with = {
	/** A saved file comment for deletion tests, without running the live send door. */
	file_comment: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			fileNodeId: Id<"files_nodes">;
			body: string;
		},
	) => {
		const { organizationId, workspaceId, userId, fileNodeId, body } = args;
		const now = Date.now();
		const channelId = await ctx.db.insert("channels", {
			kind: "file",
			organizationId,
			workspaceId,
			fileNodeId,
			createdBy: userId,
			createdAt: now,
		});
		await ctx.db.insert("channels_activity", {
			channelId,
			organizationId,
			workspaceId,
			lastMainSequence: 0,
			lastChannelSequence: 1,
			lastMessageAt: now,
			memberCount: 1,
		});
		const rootMessageId = await ctx.db.insert("channels_messages", {
			channelId,
			organizationId,
			workspaceId,
			authorUserId: userId,
			channelSequence: 1,
			mainSequence: null,
			threadRootId: null,
			threadSequence: null,
			replyTo: null,
			body,
			mentionUserIds: [],
			fileMentionIds: [],
			fileQuotes: [],
			attachments: [],
			hasAttachments: false,
			clientMessageId: crypto.randomUUID(),
			revision: 0,
			editedAt: null,
			deletedAt: null,
		});
		const threadId = await ctx.db.insert("channels_threads", {
			channelId,
			organizationId,
			workspaceId,
			rootMessageId,
			title: null,
			anchor: null,
			lastReplySequence: 0,
			lastActivitySequence: 1,
			replyCount: 0,
			recentReplierUserIds: [],
			lastActivityAt: now,
			isResolved: false,
			resolvedAt: null,
			resolvedBy: null,
			followerSyncPending: false,
		});
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", workspaceId).eq("userId", userId).eq("active", true),
			)
			.unique();
		if (!membership) throw new Error("The file-comment fixture needs a workspace membership");
		await Promise.all([
			ctx.db.insert("channels_members", {
				channelId,
				organizationId,
				workspaceId,
				userId,
				workspaceMembershipId: membership._id,
				level: "member",
				addedBy: null,
				notify: "mentions",
				starred: false,
				hiddenAtMainSequence: null,
				joinedAt: now,
			}),
			ctx.db.insert("channels_read_states", {
				channelId,
				organizationId,
				workspaceId,
				userId,
				readSequence: 0,
				updatedAt: now,
			}),
			ctx.db.insert("channels_thread_followers", {
				threadId,
				rootMessageId,
				channelId,
				organizationId,
				workspaceId,
				userId,
				readReplySequence: 0,
				following: true,
				pendingRootMention: false,
				threadLastActivityAt: now,
				followedAt: now,
			}),
			ctx.db.insert("channels_reactions", {
				channelId,
				organizationId,
				workspaceId,
				userId,
				messageId: rootMessageId,
				emoji: "👍",
			}),
			ctx.db.insert("channels_reaction_counts", {
				organizationId,
				workspaceId,
				messageId: rootMessageId,
				emoji: "👍",
				count: 1,
			}),
			ctx.db.insert("channels_inbox", {
				recipientUserId: userId,
				organizationId,
				workspaceId,
				channelId,
				messageId: rootMessageId,
				kind: "mention",
				mainSequence: null,
				threadRootId: rootMessageId,
				threadSequence: 0,
				createdAt: now,
			}),
		]);
		return { channelId, rootMessageId };
	},
	/**
	 * Put one user on a plan: a synced Polar product plus the usage snapshot that points at it.
	 * This is what the billing gates read.
	 */
	plan: async (ctx: MutationCtx, args: { userId: Id<"users">; plan: keyof typeof billing_PRODUCTS }) => {
		const productId = test_plan_product_ids[args.plan];
		// Two fixtures in one test may share a plan, and the component rejects a duplicate id.
		const product = await ctx.runQuery(components.polar.lib.getProduct, { id: productId });
		if (!product) {
			await ctx.runMutation(components.polar.lib.createProduct, {
				product: {
					id: productId,
					organizationId: "test_billing_org",
					name: billing_PRODUCTS[args.plan].name,
					description: null,
					isRecurring: true,
					isArchived: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					modifiedAt: null,
					recurringInterval: "month",
					metadata: {},
					prices: [
						{
							id: `${productId}_price`,
							createdAt: "2026-01-01T00:00:00.000Z",
							modifiedAt: null,
							amountType: "free",
							isArchived: false,
							productId,
							priceCurrency: "eur",
							recurringInterval: "month",
						},
					],
					medias: [],
					benefits: [],
				},
			});
		}

		const subscription = {
			id: `test_subscription_${args.userId}`,
			productId,
			currency: "eur",
			currentPeriodStart: "2026-01-01T00:00:00.000Z",
			currentPeriodEnd: "2026-02-01T00:00:00.000Z",
		};
		const snapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.first();
		// Called again to move a user between plans mid-test, the way a real upgrade or downgrade does.
		if (snapshot) {
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { subscription });
			return;
		}

		await ctx.db.insert("billing_usage_snapshots", {
			userId: args.userId,
			polarCustomerId: `test_customer_${args.userId}`,
			subscription,
			meter: {
				id: "meter_press_usage",
				consumedUnits: 0,
				creditedUnits: 100_000,
				balance: 100_000,
				amountDueCents: 0,
			},
			lastSyncedAt: Date.now(),
		});
	},

	membership: async (
		ctx: MutationCtx,
		args?: {
			userId?: Id<"users">;
			organizationName?: string;
			workspaceName?: string;
			/**
			 * The plan the seeded user pays for. Uploads are closed to `Free`, so the fixture pays by
			 * default and a test about files fails on files instead of on billing. Pass `"Free"` to
			 * test a refusal, or `null` for a user with no billing state at all.
			 */
			plan?: keyof typeof billing_PRODUCTS | null;
			/**
			 * A custom organization with no policy doc allows no plugin and no MCP server. Most tests are
			 * not about the policy, so the fixture allows everything. Pass `null` to test the policy.
			 */
			integrationPolicy?: "allow_all" | null;
		},
	) => {
		const now = Date.now();
		const organizationName = args?.organizationName ?? "test-organization";
		const workspaceName = args?.workspaceName ?? "test-workspace";
		const userId =
			args?.userId ??
			(await ctx.db.insert("users", {
				clerkUserId: null,
			}));

		if (args?.plan !== null) {
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: args?.plan ?? "Pay As You Go" });
		}

		await quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId,
			now,
		});

		await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
			userId,
			now,
		});

		const user = await ctx.db.get("users", userId);
		if (!user?.defaultOrganizationId || !user.defaultWorkspaceId) {
			throw new Error("Expected default organization bootstrap to set user defaults");
		}

		if (organizationName === "personal" && workspaceName === "home") {
			const membershipId = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", user.defaultWorkspaceId!).eq("userId", userId),
				)
				.first()
				.then((membership) => membership?._id);
			if (!membershipId) {
				throw new Error("Expected default organization membership after bootstrap");
			}

			await test_mocks_cancel_pending_home_file_seeds(ctx);

			return {
				userId,
				organizationId: user.defaultOrganizationId,
				workspaceId: user.defaultWorkspaceId,
				membershipId,
			} as const;
		}

		const organizationResult = await organizations_db_create(ctx, {
			userId,
			name: organizationName,
			description: "",
			now,
		});
		if (organizationResult._nay) {
			throw new Error(`Failed to seed organization membership: ${organizationResult._nay.message}`);
		}
		if (args?.integrationPolicy !== null) {
			await ctx.db.insert("organizations_integration_policies", {
				organizationId: organizationResult._yay.organizationId,
				plugins: { mode: "allow_all", allowlist: [] },
				mcpServers: { mode: "allow_all", allowlist: [] },
				updatedBy: userId,
				updatedAt: now,
			});
		}

		let workspaceId = organizationResult._yay.defaultWorkspaceId;
		if (workspaceName !== "home") {
			const workspaceResult = await organizations_db_create_workspace(ctx, {
				userId,
				organizationId: organizationResult._yay.organizationId,
				name: workspaceName,
				description: "",
				now,
			});
			if (workspaceResult._nay) {
				throw new Error(`Failed to seed workspace membership: ${workspaceResult._nay.message}`);
			}

			workspaceId = workspaceResult._yay.workspaceId;
		}

		const membershipId = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
			.first()
			.then((membership) => membership?._id);
		if (!membershipId) {
			throw new Error("Expected organization membership after seed setup");
		}

		await test_mocks_cancel_pending_home_file_seeds(ctx);

		return {
			userId,
			organizationId: organizationResult._yay.organizationId,
			workspaceId,
			membershipId,
		} as const;
	},

	plugin_service_account: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			pluginVersionId: Id<"plugins_versions">;
		},
	) => {
		const version = await ctx.db.get("plugins_versions", args.pluginVersionId);
		if (!version) {
			throw new Error("Expected plugin version");
		}
		const now = Date.now();
		const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			name: version.name,
			createdBy: version.createdBy,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
		});
		await ctx.db.insert("plugins_service_account_bindings", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			pluginName: version.name,
			publisherUserId: version.createdBy,
			sourceRepositoryUrl: version.sourceRepositoryUrl,
			serviceAccountId,
		});
		return serviceAccountId;
	},

	/**
	 * One member's MCP sign-in for one server. It holds a refresh token and a revocation endpoint, so
	 * deleting it leaves a revocation row.
	 */
	mcp_oauth_grant: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			target: Doc<"plugins_mcp_oauth_grants">["target"];
			connectedAt?: number;
		},
	) => {
		return await ctx.db.insert("plugins_mcp_oauth_grants", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: args.target,
			issuer: "https://auth.example.com",
			resource: "https://mcp.example.com/mcp",
			tokenEndpoint: "https://auth.example.com/token",
			revocationEndpoint: "https://auth.example.com/revoke",
			clientId: "client-1",
			clientKind: "cimd",
			tokenEndpointAuthMethod: "none",
			accessToken: null,
			refreshToken: { ciphertext: new ArrayBuffer(8), nonce: new ArrayBuffer(12), keyId: "v1" },
			expiresAt: null,
			scope: "read",
			requestedScopes: ["read"],
			stepUpScope: null,
			connectedAt: args.connectedAt ?? Date.now(),
			status: "connected",
			version: 1,
			leaseId: null,
			leaseUntil: null,
		});
	},

	/**
	 * One member's MCP sign-in that has not come back from the sign-in server yet.
	 */
	mcp_oauth_pending: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			target: Doc<"plugins_mcp_oauth_pending">["target"];
		},
	) => {
		return await ctx.db.insert("plugins_mcp_oauth_pending", {
			stateHash: faker.string.hexadecimal({ length: 64, prefix: "" }),
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: args.target,
			destinationFingerprint: "sha256:pending",
			serverUrl: "https://mcp.example.com/mcp",
			resource: "https://mcp.example.com/mcp",
			issuer: "https://auth.example.com",
			authorizationEndpoint: "https://auth.example.com/authorize",
			tokenEndpoint: "https://auth.example.com/token",
			revocationEndpoint: null,
			issParameterSupported: true,
			clientId: "client-1",
			clientKind: "cimd",
			tokenEndpointAuthMethod: "none",
			scopes: ["read"],
			codeVerifier: { ciphertext: new ArrayBuffer(8), nonce: new ArrayBuffer(12), keyId: "v1" },
			returnPath: "/",
			expiresAt: Date.now() + 10 * 60 * 1000,
		});
	},

	/**
	 * One MCP tool call in the call ledger.
	 */
	mcp_call: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			threadId: Id<"ai_chat_threads">;
			target: Doc<"plugins_mcp_calls">["target"];
		},
	) => {
		return await ctx.db.insert("plugins_mcp_calls", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			threadId: args.threadId,
			target: args.target,
			toolName: "search",
			startedAt: Date.now(),
			durationMs: 120,
			bytesIn: 64,
			bytesOut: 256,
			outcome: "ok",
		});
	},

	/**
	 * One member's own MCP server, with one secret row per secret name.
	 */
	mcp_custom_server: async (
		ctx: MutationCtx,
		args: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			secretNames?: string[];
		},
	) => {
		const secretNames = args.secretNames ?? [];
		const customServerId = await ctx.db.insert("mcp_custom_servers", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			name: "Tracker",
			toolPrefix: "my-tracker",
			url: "https://mcp.example.com/mcp",
			headers: secretNames.map((secretName) => ({
				name: `X-${secretName}`,
				parts: [{ kind: "secret" as const, secretName }],
			})),
			auth: secretNames.length > 0 ? { kind: "headers" } : { kind: "none" },
			destinationFingerprint: "sha256:custom",
			enabled: true,
			lastTest: null,
			failures: 0,
			unhealthyUntil: null,
			updatedAt: Date.now(),
		});
		for (const secretName of secretNames) {
			await ctx.db.insert("mcp_custom_server_secrets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				customServerId,
				name: secretName,
				value: { ciphertext: new ArrayBuffer(8), nonce: new ArrayBuffer(12), keyId: "v1" },
				updatedAt: Date.now(),
			});
		}
		return customServerId;
	},

	nested_files: async (ctx: MutationCtx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx);
		const createdByUserId = membership.userId;

		/** /root_1 */
		const file_root_1 = await ctx.db.get(
			"files_nodes",
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.files.file_root_1.name,
				parentId: test_mocks_hardcoded.files.file_root_1.parentId,
				path: `/${test_mocks_hardcoded.files.file_root_1.name}`,
				treePath: `/${test_mocks_hardcoded.files.file_root_1.name}/`,
				pathDepth: 1,
			}),
		);
		if (!file_root_1) throw new Error("file_root_1 not found");

		/** /root_1/child_1 */
		const file_root_1_child_1 = await ctx.db.get(
			"files_nodes",
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.files.file_root_1_child_1.name,
				parentId: file_root_1._id,
				path: `/${file_root_1.name}/${test_mocks_hardcoded.files.file_root_1_child_1.name}`,
				treePath: `/${file_root_1.name}/${test_mocks_hardcoded.files.file_root_1_child_1.name}/`,
				pathDepth: 2,
			}),
		);
		if (!file_root_1_child_1) throw new Error("file_root_1_child_1 not found");

		/** /root_1/child_1/deep_1 */
		const file_root_1_child_1_deep_1 = await ctx.db.get(
			"files_nodes",
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.files.file_root_1_child_1_deep_1.name,
				parentId: file_root_1_child_1._id,
				path: `/${file_root_1.name}/${file_root_1_child_1.name}/${test_mocks_hardcoded.files.file_root_1_child_1_deep_1.name}`,
				treePath: `/${file_root_1.name}/${file_root_1_child_1.name}/${test_mocks_hardcoded.files.file_root_1_child_1_deep_1.name}/`,
				pathDepth: 3,
			}),
		);
		if (!file_root_1_child_1_deep_1) throw new Error("file_root_1_child_1_deep_1 not found");

		/** /root_1/child_2 */
		const file_root_1_child_2 = await ctx.db.get(
			"files_nodes",
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.files.file_root_1_child_2.name,
				parentId: file_root_1._id,
				path: `/${file_root_1.name}/${test_mocks_hardcoded.files.file_root_1_child_2.name}`,
				treePath: `/${file_root_1.name}/${test_mocks_hardcoded.files.file_root_1_child_2.name}/`,
				pathDepth: 2,
			}),
		);
		if (!file_root_1_child_2) throw new Error("file_root_1_child_2 not found");

		/** /root_2 */
		const file_root_2 = await ctx.db.get(
			"files_nodes",
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				createdBy: createdByUserId,
				updatedBy: createdByUserId,
				name: test_mocks_hardcoded.files.file_root_2.name,
				parentId: test_mocks_hardcoded.files.file_root_2.parentId,
				path: `/${test_mocks_hardcoded.files.file_root_2.name}`,
				treePath: `/${test_mocks_hardcoded.files.file_root_2.name}/`,
				pathDepth: 1,
			}),
		);
		if (!file_root_2) throw new Error("file_root_2 not found");

		return {
			userId: createdByUserId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			membershipId: membership.membershipId,
			files: {
				file_root_1,
				file_root_1_child_1,
				file_root_1_child_1_deep_1,
				file_root_1_child_2,
				file_root_2,
			},
		} as const;
	},
};

type ConvexDocUserData<T extends TableNames> = Omit<Doc<T>, "_creationTime" | "_id">;

// #endregion
