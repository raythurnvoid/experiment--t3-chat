// Press owns Chitchat identity. The event ledger records access changes in their source transaction.
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import schema from "./schema.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";

const LEASE_MS = 30_000;
const SNAPSHOT_PAGE_SIZE = 50;

const member_validator = v.object({
	hostUserId: v.string(),
	hostMembershipId: v.union(v.string(), v.null()),
	membershipLifetime: v.number(),
	displayName: v.union(v.string(), v.null()),
	active: v.boolean(),
	canRead: v.boolean(),
	canWrite: v.boolean(),
	isOwner: v.boolean(),
});

const lease_facts_validator = v.object({
	hostSessionId: v.string(),
	hostUserId: v.string(),
	hostMembershipId: v.string(),
	hostOrganizationId: v.string(),
	hostWorkspaceId: v.string(),
	hostInstallationId: v.string(),
	hostPluginVersionId: v.string(),
	hostServiceAccountId: v.string(),
	membershipLifetime: v.number(),
	requiredRevision: v.number(),
	canRead: v.boolean(),
	canWrite: v.boolean(),
	isOwner: v.boolean(),
	organizationOwnerUserId: v.string(),
	displayName: v.union(v.string(), v.null()),
	exchangeId: v.string(),
	validatedAt: v.number(),
	expiresAt: v.number(),
});

async function db_check_service(ctx: QueryCtx | MutationCtx, secretHash: string) {
	const registration = await ctx.db
		.query("plugins_service_registrations")
		.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
		.first();
	return registration && crypto_timing_safe_equal(registration.exchangeSecretHash, secretHash);
}

async function db_live_installation(
	ctx: QueryCtx | MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
) {
	const installation = await ctx.db.get("plugins_workspace_installations", installationId);
	if (
		!installation ||
		installation.pluginName !== "chitchat" ||
		installation.status !== "enabled" ||
		!installation.acceptedCapabilities.includes("plugin.service.connect") ||
		!installation.acceptedCapabilities.includes("workspace.members.read")
	) {
		return null;
	}
	const [workspace, organization, version, account, deletionFence] = await Promise.all([
		ctx.db.get("organizations_workspaces", installation.workspaceId),
		ctx.db.get("organizations", installation.organizationId),
		ctx.db.get("plugins_versions", installation.pluginVersionId),
		plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: installation.serviceAccountId }),
		ctx.db
			.query("plugins_registry_deletion_fences")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
			.first(),
	]);
	if (
		!workspace ||
		workspace.organizationId !== installation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!organization?.defaultWorkspaceId ||
		!version ||
		!version.capabilities.includes("plugin.service.connect") ||
		!version.capabilities.includes("workspace.members.read") ||
		!account ||
		deletionFence
	) {
		return null;
	}
	return { installation, workspace, organization, defaultWorkspaceId: organization.defaultWorkspaceId };
}

async function db_member_facts(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		lifetime: number;
		organization: Doc<"organizations">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
	},
) {
	const user = await ctx.db.get("users", args.membership.userId);
	const active = args.membership.active && user !== null && user.deletedAt == null;
	const anagraphic = active && user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	const permissionArgs = {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		defaultWorkspaceId: args.defaultWorkspaceId,
		organizationOwnerUserId: args.organization.ownerUserId,
		resource: { kind: "workspace" as const, id: String(args.membership.workspaceId) },
		userId: args.membership.userId,
	};
	const [canRead, canWrite] = active
		? await Promise.all([
				access_control_db_has_permission(ctx, { ...permissionArgs, permission: "content.read" }),
				access_control_db_has_permission(ctx, { ...permissionArgs, permission: "content.write" }),
			])
		: [false, false];
	return {
		hostUserId: String(args.membership.userId),
		hostMembershipId: String(args.membership._id),
		membershipLifetime: args.lifetime,
		displayName: anagraphic?.displayName ?? null,
		active,
		canRead,
		canWrite,
		isOwner: active && args.membership.userId === args.organization.ownerUserId,
	};
}

async function db_ensure_lifetime(ctx: MutationCtx, membership: Doc<"organizations_workspaces_users">) {
	const existing = await ctx.db
		.query("plugins_chitchat_memberships")
		.withIndex("by_workspace_user", (q) => q.eq("workspaceId", membership.workspaceId).eq("userId", membership.userId))
		.first();
	if (existing) {
		const lifetime = existing.lifetime + (existing.active && existing.membershipId !== membership._id ? 1 : 0);
		if (!existing.active || existing.membershipId !== membership._id) {
			await ctx.db.patch("plugins_chitchat_memberships", existing._id, {
				membershipId: membership._id,
				active: true,
				lifetime,
			});
		}
		return lifetime;
	}
	await ctx.db.insert("plugins_chitchat_memberships", {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
		membershipId: membership._id,
		lifetime: 1,
		active: true,
	});
	return 1;
}

/**
 * Record one source transaction's events together. Call once after its authority writes.
 */
export async function plugins_chitchat_db_record_events(
	ctx: MutationCtx,
	events: Array<Pick<Doc<"plugins_chitchat_access_events">, "scope" | "event">>,
) {
	if (events.length === 0) return;
	const state = await ctx.db
		.query("plugins_chitchat_access_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	// Before the first lease there is no remote authority to invalidate.
	if (!state) return;
	const now = Date.now();
	await Promise.all(
		events.map((event, index) =>
			ctx.db.insert("plugins_chitchat_access_events", {
				...event,
				revision: state.revision + index + 1,
				createdAt: now,
			}),
		),
	);
	await ctx.db.patch("plugins_chitchat_access_state", state._id, { revision: state.revision + events.length });
	if (state.lastPushedRevision === state.revision) {
		await ctx.scheduler.runAfter(0, internal.plugins_chitchat_http.push_access_events, {});
	}
}

/**
 * Save membership lifetime before publishing its immutable event. Removal never reuses a lifetime.
 */
export async function plugins_chitchat_db_record_memberships(
	ctx: MutationCtx,
	memberships: Array<{ membership: Doc<"organizations_workspaces_users">; active: boolean }>,
) {
	const state = await ctx.db
		.query("plugins_chitchat_access_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	if (!state) return;
	const events = await Promise.all(
		memberships.map(async ({ membership, active }) => {
			let lifetime: number;
			if (active) {
				lifetime = await db_ensure_lifetime(ctx, membership);
			} else {
				const existing = await ctx.db
					.query("plugins_chitchat_memberships")
					.withIndex("by_workspace_user", (q) =>
						q.eq("workspaceId", membership.workspaceId).eq("userId", membership.userId),
					)
					.first();
				lifetime = existing ? existing.lifetime + (existing.active ? 1 : 0) : 1;
				if (existing) {
					await ctx.db.patch("plugins_chitchat_memberships", existing._id, { lifetime, active: false });
				} else {
					await ctx.db.insert("plugins_chitchat_memberships", {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: membership.userId,
						membershipId: membership._id,
						lifetime,
						active: false,
					});
				}
			}
			const organization = active ? await ctx.db.get("organizations", membership.organizationId) : null;
			const member = organization?.defaultWorkspaceId
				? await db_member_facts(ctx, {
						membership: { ...membership, active },
						lifetime,
						organization,
						defaultWorkspaceId: organization.defaultWorkspaceId,
					})
				: {
						hostUserId: String(membership.userId),
						hostMembershipId: String(membership._id),
						membershipLifetime: lifetime,
						displayName: null,
						active: false,
						canRead: false,
						canWrite: false,
						isOwner: false,
					};
			return {
				scope: {
					kind: "workspace" as const,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
				},
				event: { kind: "member" as const, member },
			};
		}),
	);
	await plugins_chitchat_db_record_events(ctx, events);
}

export const create_lease_facts = internalMutation({
	args: {
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		exchangeId: v.string(),
		requestedExpiresAt: v.number(),
	},
	returns: v_result({ _yay: lease_facts_validator }),
	handler: async (ctx, args) => {
		if (!(await db_check_service(ctx, args.serviceSecretHash))) return Result({ _nay: { message: "Unauthorized" } });
		const session = await ctx.db
			.query("plugins_ui_sessions")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.first();
		const now = Date.now();
		if (!session || session.expiresAt <= now) return Result({ _nay: { message: "Unauthorized" } });
		const live = await db_live_installation(ctx, session.installationId);
		if (
			!live ||
			live.installation.pluginVersionId !== session.pluginVersionId ||
			live.installation.serviceAccountId !== session.serviceAccountId ||
			live.installation.organizationId !== session.organizationId ||
			live.installation.workspaceId !== session.workspaceId
		)
			return Result({ _nay: { message: "Unauthorized" } });
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", session.userId)
					.eq("organizationId", session.organizationId)
					.eq("workspaceId", session.workspaceId),
			)
			.first();
		const user = await ctx.db.get("users", session.userId);
		if (!membership || !user || user.deletedAt != null) return Result({ _nay: { message: "Unauthorized" } });
		const expiresAt = Math.min(args.requestedExpiresAt, now + LEASE_MS, session.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= now) return Result({ _nay: { message: "Lease has expired" } });
		const member = await db_member_facts(ctx, {
			membership,
			lifetime: 0,
			organization: live.organization,
			defaultWorkspaceId: live.defaultWorkspaceId,
		});
		if (!member.canRead) return Result({ _nay: { message: "Permission denied" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_ui_session_jwt_exchange",
			key: `chitchat:${session._id}`,
		});
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const lifetime = await db_ensure_lifetime(ctx, membership);
		const state = await ctx.db
			.query("plugins_chitchat_access_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (!state) {
			await ctx.db.insert("plugins_chitchat_access_state", {
				key: "main",
				revision: 0,
				oldestRevision: 1,
				lastPushedRevision: 0,
			});
		}
		const connection = await ctx.db
			.query("plugins_chitchat_connections")
			.withIndex("by_installation", (q) => q.eq("installationId", session.installationId))
			.first();
		if (!connection)
			await ctx.db.insert("plugins_chitchat_connections", {
				installationId: session.installationId,
				organizationId: session.organizationId,
				workspaceId: session.workspaceId,
				createdAt: now,
			});
		return Result({
			_yay: {
				hostSessionId: String(session._id),
				hostUserId: String(session.userId),
				hostMembershipId: String(membership._id),
				hostOrganizationId: String(session.organizationId),
				hostWorkspaceId: String(session.workspaceId),
				hostInstallationId: String(session.installationId),
				hostPluginVersionId: String(session.pluginVersionId),
				hostServiceAccountId: String(session.serviceAccountId),
				membershipLifetime: lifetime,
				requiredRevision: state?.revision ?? 0,
				canRead: member.canRead,
				canWrite: member.canWrite,
				isOwner: member.isOwner,
				organizationOwnerUserId: String(live.organization.ownerUserId),
				displayName: member.displayName,
				exchangeId: args.exchangeId,
				validatedAt: now,
				expiresAt,
			},
		});
	},
});

export type plugins_chitchat_create_lease_facts_Result =
	typeof create_lease_facts extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const get_snapshot = internalMutation({
	args: {
		serviceSecretHash: v.string(),
		installationId: v.string(),
		cursor: v.union(v.string(), v.null()),
		startRevision: v.union(v.number(), v.null()),
	},
	returns: v_result({
		_yay: v.object({
			startRevision: v.number(),
			currentRevision: v.number(),
			members: v.array(member_validator),
			continueCursor: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		if (!(await db_check_service(ctx, args.serviceSecretHash))) return Result({ _nay: { message: "Unauthorized" } });
		const installationId = ctx.db.normalizeId("plugins_workspace_installations", args.installationId);
		if (!installationId) return Result({ _nay: { message: "Unauthorized" } });
		const connection = await ctx.db
			.query("plugins_chitchat_connections")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first();
		if (!connection) return Result({ _nay: { message: "Unauthorized" } });
		const live = await db_live_installation(ctx, installationId);
		if (!live) {
			const [installation, workspace, organization, deletionFence] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", installationId),
				ctx.db.get("organizations_workspaces", connection.workspaceId),
				ctx.db.get("organizations", connection.organizationId),
				ctx.db
					.query("plugins_registry_deletion_fences")
					.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
					.first(),
			]);
			const removed =
				!installation ||
				!workspace ||
				!organization ||
				workspace.pluginDataPurgeStartedAt !== undefined ||
				deletionFence !== null;
			return Result({ _nay: { message: removed ? "Installation has been removed" : "Installation is unavailable" } });
		}
		const state = await ctx.db
			.query("plugins_chitchat_access_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (!state) return Result({ _nay: { message: "Snapshot required" } });
		const startRevision = args.startRevision ?? state.revision;
		if (args.cursor !== null && args.startRevision === null) return Result({ _nay: { message: "Snapshot required" } });
		if (startRevision < state.oldestRevision - 1 || startRevision > state.revision)
			return Result({ _nay: { message: "Snapshot required" } });
		const page = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_organization_workspace_user", (q) =>
				q.eq("active", true).eq("organizationId", connection.organizationId).eq("workspaceId", connection.workspaceId),
			)
			.paginate({ numItems: SNAPSHOT_PAGE_SIZE, cursor: args.cursor });
		const members = await Promise.all(
			page.page.map(async (membership) => {
				const lifetime = await db_ensure_lifetime(ctx, membership);
				return await db_member_facts(ctx, {
					membership,
					lifetime,
					organization: live.organization,
					defaultWorkspaceId: live.defaultWorkspaceId,
				});
			}),
		);
		return Result({
			_yay: {
				startRevision,
				currentRevision: state.revision,
				members: members.filter((member) => member.active),
				continueCursor: page.isDone ? null : page.continueCursor,
			},
		});
	},
});

export type plugins_chitchat_get_snapshot_Result =
	typeof get_snapshot extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const get_events = internalQuery({
	args: { serviceSecretHash: v.string(), installationId: v.string(), afterRevision: v.number(), limit: v.number() },
	returns: v_result({
		_yay: v.object({
			events: v.array(
				v.object({
					revision: v.number(),
					event: v.union(
						v.object({ kind: v.literal("noop") }),
						doc(schema, "plugins_chitchat_access_events").fields.event,
					),
				}),
			),
			currentRevision: v.number(),
			continueRevision: v.number(),
			isDone: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		if (!(await db_check_service(ctx, args.serviceSecretHash))) return Result({ _nay: { message: "Unauthorized" } });
		const installationId = ctx.db.normalizeId("plugins_workspace_installations", args.installationId);
		if (!installationId) return Result({ _nay: { message: "Unauthorized" } });
		const connection = await ctx.db
			.query("plugins_chitchat_connections")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first();
		if (!connection) return Result({ _nay: { message: "Unauthorized" } });
		const state = await ctx.db
			.query("plugins_chitchat_access_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (!state || args.afterRevision < state.oldestRevision - 1 || args.afterRevision > state.revision)
			return Result({ _nay: { message: "Snapshot required" } });
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100 || !Number.isInteger(args.afterRevision))
			return Result({ _nay: { message: "Invalid event page" } });
		const installation = await ctx.db.get("plugins_workspace_installations", installationId);
		const live = await db_live_installation(ctx, installationId);
		const docs = await ctx.db
			.query("plugins_chitchat_access_events")
			.withIndex("by_revision", (q) => q.gt("revision", args.afterRevision))
			.take(args.limit);
		const events = await Promise.all(
			docs.map(async (eventDoc) => {
				const scope = eventDoc.scope;
				let matches: boolean;
				switch (scope.kind) {
					case "all":
						matches = true;
						break;
					case "organization":
						matches = scope.organizationId === connection.organizationId;
						break;
					case "workspace":
						matches =
							scope.organizationId === connection.organizationId && scope.workspaceId === connection.workspaceId;
						break;
					case "installation":
						matches = scope.installationId === installationId;
						break;
					case "service_account":
						matches = scope.serviceAccountId === installation?.serviceAccountId;
						break;
					case "user": {
						const member = await ctx.db
							.query("plugins_chitchat_memberships")
							.withIndex("by_workspace_user", (q) =>
								q.eq("workspaceId", connection.workspaceId).eq("userId", scope.userId),
							)
							.first();
						matches = member !== null;
						break;
					}
				}
				// A retired connection may receive control events, never new member profile facts.
				const canDeliver = matches && (live !== null || eventDoc.event.kind !== "member");
				return { revision: eventDoc.revision, event: canDeliver ? eventDoc.event : { kind: "noop" as const } };
			}),
		);
		const continueRevision = docs.at(-1)?.revision ?? args.afterRevision;
		return Result({
			_yay: { events, currentRevision: state.revision, continueRevision, isDone: continueRevision === state.revision },
		});
	},
});

export type plugins_chitchat_get_events_Result =
	typeof get_events extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const get_push_head = internalQuery({
	args: {},
	returns: v.union(v.number(), v.null()),
	handler: async (ctx) => {
		const state = await ctx.db
			.query("plugins_chitchat_access_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		return state && state.lastPushedRevision < state.revision ? state.revision : null;
	},
});

export const acknowledge_push = internalMutation({
	args: { revision: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("plugins_chitchat_access_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (state && args.revision > state.lastPushedRevision && args.revision <= state.revision) {
			await ctx.db.patch("plugins_chitchat_access_state", state._id, { lastPushedRevision: args.revision });
			if (args.revision < state.revision)
				await ctx.scheduler.runAfter(0, internal.plugins_chitchat_http.push_access_events, {});
		}
		return null;
	},
});
