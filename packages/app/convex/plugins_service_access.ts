import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { RegisteredMutation } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import schema from "./schema.ts";
import { access_control_changes_scope_key } from "./access_control_changes.ts";
import {
	organizations_membership_lifetimes_db_ensure as db_ensure_lifetime,
	organizations_membership_lifetimes_db_member_facts as db_member_facts,
} from "./organizations_membership_lifetimes.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import { plugins_service_events_db_wake_installation } from "./plugins_service_events.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";

const LEASE_MS = 30_000;
const SNAPSHOT_PAGE_SIZE = 50;

async function db_live_installation(
	ctx: QueryCtx | MutationCtx,
	installationId: Id<"plugins_workspace_installations">,
) {
	const installation = await ctx.db.get("plugins_workspace_installations", installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		!installation.acceptedCapabilities.includes("plugin.service.connect") ||
		!installation.acceptedCapabilities.includes("workspace.members.read")
	) {
		return null;
	}

	const [workspace, organization, version, account, deletionFence, registration] = await Promise.all([
		ctx.db.get("organizations_workspaces", installation.workspaceId),
		ctx.db.get("organizations", installation.organizationId),
		ctx.db.get("plugins_versions", installation.pluginVersionId),
		plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: installation.serviceAccountId }),
		ctx.db
			.query("plugins_registry_deletion_fences")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", installation.pluginName))
			.first(),
		ctx.db
			.query("plugins_service_registrations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", installation.pluginName))
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
		deletionFence ||
		!registration
	) {
		return null;
	}

	return { installation, registration, workspace, organization, defaultWorkspaceId: organization.defaultWorkspaceId };
}

/**
 * Return the retention doc, and create it when it is missing.
 *
 * The first lease creates it with the head. If it is missing later, for example after a partial data
 * reset, older feed docs and scope heads may be gone. So it starts at the current head. A cursor below
 * the head then takes one new snapshot, instead of getting "Snapshot required" forever.
 */
async function db_ensure_retention(ctx: MutationCtx, headRevision: number) {
	const retention = await ctx.db
		.query("access_control_change_retention")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	if (retention) return retention;

	const fields = { key: "main" as const, oldestRevision: headRevision + 1, scopeHeadsFromRevision: headRevision };
	return { _id: await ctx.db.insert("access_control_change_retention", fields), ...fields };
}

// Only a live page exchange may bind a registration, version or account to this connection.
async function db_connect(
	ctx: MutationCtx,
	args: { installation: Doc<"plugins_workspace_installations">; registrationId: Id<"plugins_service_registrations"> },
) {
	const { installation } = args;
	const connection = await ctx.db
		.query("plugins_service_connections")
		.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
		.first();

	const fields = {
		installationId: installation._id,
		organizationId: installation.organizationId,
		workspaceId: installation.workspaceId,
		registrationId: args.registrationId,
		pluginVersionId: installation.pluginVersionId,
		serviceAccountId: installation.serviceAccountId,
		createdAt: connection?.createdAt ?? Date.now(),
	};
	if (connection) await ctx.db.patch("plugins_service_connections", connection._id, fields);
	else await ctx.db.insert("plugins_service_connections", fields);
}

async function db_check_connection(args: {
	ctx: QueryCtx;
	connection: Doc<"plugins_service_connections">;
	serviceSecretHash: string;
}) {
	const { ctx, connection, serviceSecretHash } = args;

	const registration = await ctx.db.get("plugins_service_registrations", connection.registrationId);
	if (!registration || !crypto_timing_safe_equal(registration.exchangeSecretHash, serviceSecretHash)) return false;

	const installation = await ctx.db.get("plugins_workspace_installations", connection.installationId);
	// A deleted installation fails its own checks elsewhere; the connection doc itself is consistent.
	return (
		!installation ||
		(installation.pluginName === registration.pluginName &&
			installation.organizationId === connection.organizationId &&
			installation.workspaceId === connection.workspaceId)
	);
}

// #region create lease facts

export const create_lease_facts = internalMutation({
	args: {
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		exchangeId: v.string(),
		requestedExpiresAt: v.number(),
	},
	returns: v_result({
		_yay: v.object({
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
			audience: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query("plugins_ui_sessions")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.first();
		const now = Date.now();
		if (!session || session.expiresAt <= now) return Result({ _nay: { message: "Unauthorized" } });

		const live = await db_live_installation(ctx, session.installationId);
		if (
			!live ||
			!crypto_timing_safe_equal(live.registration.exchangeSecretHash, args.serviceSecretHash) ||
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
			key: `plugin-identity:${session._id}`,
		});
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		const state = await ctx.db
			.query("access_control_change_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		// The first valid exchange starts the ledger on a new deployment.
		if (!state) {
			await ctx.db.insert("access_control_change_state", { key: "main", revision: 0 });
			await db_ensure_retention(ctx, 0);
		}

		const lifetime = await db_ensure_lifetime(ctx, membership);
		await db_connect(ctx, {
			installation: live.installation,
			registrationId: live.registration._id,
		});
		await plugins_service_events_db_wake_installation(ctx, live.installation._id);

		return Result({
			_yay: {
				audience: `bonobo-plugin:${live.registration.pluginName}`,
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

export type plugins_service_access_create_lease_facts_Result =
	typeof create_lease_facts extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion create lease facts

// #region member snapshot

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
			members: v.array(
				v.object({
					hostUserId: v.string(),
					hostMembershipId: v.union(v.string(), v.null()),
					membershipLifetime: v.number(),
					displayName: v.union(v.string(), v.null()),
					active: v.boolean(),
					canRead: v.boolean(),
					canWrite: v.boolean(),
					isOwner: v.boolean(),
				}),
			),
			continueCursor: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const installationId = ctx.db.normalizeId("plugins_workspace_installations", args.installationId);
		if (!installationId) return Result({ _nay: { message: "Unauthorized" } });

		const connection = await ctx.db
			.query("plugins_service_connections")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first();
		if (!connection || !(await db_check_connection({ ctx, connection, serviceSecretHash: args.serviceSecretHash })))
			return Result({ _nay: { message: "Unauthorized" } });

		const limited = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `plugin-members:${installationId}`,
		});
		if (limited) return Result({ _nay: { message: limited.message } });

		const current = await db_live_installation(ctx, installationId);
		const live =
			current &&
			current.installation.pluginVersionId === connection.pluginVersionId &&
			current.installation.serviceAccountId === connection.serviceAccountId
				? current
				: null;
		if (!live) {
			const registration = await ctx.db.get("plugins_service_registrations", connection.registrationId);
			const [installation, workspace, organization, deletionFence] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", installationId),
				ctx.db.get("organizations_workspaces", connection.workspaceId),
				ctx.db.get("organizations", connection.organizationId),
				ctx.db
					.query("plugins_registry_deletion_fences")
					.withIndex("by_pluginName", (q) => q.eq("pluginName", registration!.pluginName))
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
			.query("access_control_change_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (!state) return Result({ _nay: { message: "Snapshot required" } });
		const retention = await db_ensure_retention(ctx, state.revision);
		const startRevision = args.startRevision ?? state.revision;
		if (args.cursor !== null && args.startRevision === null) return Result({ _nay: { message: "Snapshot required" } });
		if (startRevision < retention.oldestRevision - 1 || startRevision > state.revision)
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

export type plugins_service_access_get_snapshot_Result =
	typeof get_snapshot extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion member snapshot

// #region access changes

export const get_events = internalMutation({
	args: { serviceSecretHash: v.string(), installationId: v.string(), afterRevision: v.number(), limit: v.number() },
	returns: v_result({
		_yay: v.object({
			events: v.array(
				v.object({
					revision: v.number(),
					event: v.union(v.object({ kind: v.literal("noop") }), doc(schema, "access_control_changes").fields.event),
				}),
			),
			currentRevision: v.number(),
			continueRevision: v.number(),
			isDone: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const installationId = ctx.db.normalizeId("plugins_workspace_installations", args.installationId);
		if (!installationId) return Result({ _nay: { message: "Unauthorized" } });

		const connection = await ctx.db
			.query("plugins_service_connections")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.first();
		if (!connection || !(await db_check_connection({ ctx, connection, serviceSecretHash: args.serviceSecretHash })))
			return Result({ _nay: { message: "Unauthorized" } });

		const limited = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `plugin-access:${installationId}`,
		});
		if (limited) return Result({ _nay: { message: limited.message } });
		await plugins_service_events_db_wake_installation(ctx, installationId);

		const state = await ctx.db
			.query("access_control_change_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		if (!state || args.afterRevision > state.revision) return Result({ _nay: { message: "Snapshot required" } });
		const retention = await db_ensure_retention(ctx, state.revision);
		if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100 || !Number.isInteger(args.afterRevision))
			return Result({ _nay: { message: "Invalid event page" } });

		const [installation, registration] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", installationId),
			ctx.db.get("plugins_service_registrations", connection.registrationId),
		]);
		const current = await db_live_installation(ctx, installationId);
		const live =
			current &&
			current.installation.pluginVersionId === connection.pluginVersionId &&
			current.installation.serviceAccountId === connection.serviceAccountId
				? current
				: null;

		// The installation's feed is the merge of these ranges. Each one is an index range of its own.
		const scopeKeys = [
			access_control_changes_scope_key({ kind: "installation", installationId }),
			access_control_changes_scope_key({
				kind: "workspace",
				organizationId: connection.organizationId,
				workspaceId: connection.workspaceId,
			}),
			access_control_changes_scope_key({ kind: "organization", organizationId: connection.organizationId }),
			// The connection check above loaded this registration, so it exists.
			access_control_changes_scope_key({ kind: "plugin", pluginName: registration!.pluginName }),
			...(installation
				? [
						access_control_changes_scope_key({
							kind: "service_account",
							serviceAccountId: installation.serviceAccountId,
						}),
					]
				: []),
		];

		// A cursor older than retention may have lost changes. The scope heads say whether any of them was ours.
		if (args.afterRevision < retention.oldestRevision - 1) {
			if (!installation || args.afterRevision < retention.scopeHeadsFromRevision)
				return Result({ _nay: { message: "Snapshot required" } });
			const heads = await Promise.all(
				scopeKeys.map((scopeKey) =>
					ctx.db
						.query("access_control_change_scope_heads")
						.withIndex("by_scopeKey", (q) => q.eq("scopeKey", scopeKey))
						.first(),
				),
			);
			if (heads.some((head) => head !== null && head.revision > args.afterRevision))
				return Result({ _nay: { message: "Snapshot required" } });
			// No change of this installation ever came after the cursor, so nothing was lost.
			return Result({
				_yay: { events: [], currentRevision: state.revision, continueRevision: state.revision, isDone: true },
			});
		}

		const ranges = await Promise.all(
			scopeKeys.map((scopeKey) =>
				ctx.db
					.query("access_control_changes")
					.withIndex("by_scopeKey_revision", (q) => q.eq("scopeKey", scopeKey).gt("revision", args.afterRevision))
					.take(args.limit),
			),
		);
		// A full range may have more docs after its last one. Cut at the smallest such end, so every doc
		// at or below the cut is in this page. A short range returned all of its docs, and every doc up
		// to the head exists because the head moves in the same transaction as its docs.
		let continueRevision = state.revision;
		for (const range of ranges) {
			if (range.length === args.limit) continueRevision = Math.min(continueRevision, range.at(-1)!.revision);
		}
		let docs = ranges
			.flat()
			.filter((eventDoc) => eventDoc.revision <= continueRevision)
			.sort((a, b) => a.revision - b.revision);
		if (docs.length > args.limit) {
			docs = docs.slice(0, args.limit);
			continueRevision = docs.at(-1)!.revision;
		}

		const events = docs.map((eventDoc) => ({
			revision: eventDoc.revision,
			// A retired connection may receive control events, never new member profile facts.
			event: live !== null || eventDoc.event.kind !== "member" ? eventDoc.event : { kind: "noop" as const },
		}));
		return Result({
			_yay: { events, currentRevision: state.revision, continueRevision, isDone: continueRevision === state.revision },
		});
	},
});

export type plugins_service_access_get_events_Result =
	typeof get_events extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion access changes
