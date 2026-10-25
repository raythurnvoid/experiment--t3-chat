import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { access_control_db_has_permission } from "./access_control.ts";
import { access_control_changes_db_record } from "./access_control_changes.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { internalMutation } from "./functions.ts";
import { plugins_schedules_db_cancel } from "./plugins_schedules_db.ts";

const DISPLAY_NAME_BATCH_SIZE = 50;

export async function organizations_membership_lifetimes_db_get(
	ctx: QueryCtx | MutationCtx,
	args: { workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	return await ctx.db
		.query("organizations_membership_lifetimes")
		.withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", args.userId))
		.first();
}

export async function organizations_membership_lifetimes_db_member_facts(
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

export async function organizations_membership_lifetimes_db_ensure(
	ctx: MutationCtx,
	membership: Doc<"organizations_workspaces_users">,
) {
	const existing = await ctx.db
		.query("organizations_membership_lifetimes")
		.withIndex("by_workspace_user", (q) => q.eq("workspaceId", membership.workspaceId).eq("userId", membership.userId))
		.first();

	if (existing) {
		// Bump only when a new membership replaces an active one; a same-doc reactivation keeps it.
		const lifetime = existing.lifetime + (existing.active && existing.membershipId !== membership._id ? 1 : 0);
		if (!existing.active || existing.membershipId !== membership._id) {
			await ctx.db.patch("organizations_membership_lifetimes", existing._id, {
				membershipId: membership._id,
				active: true,
				lifetime,
			});
			await files_media_validation_db_advance_version(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
			});
		}

		return lifetime;
	}

	await ctx.db.insert("organizations_membership_lifetimes", {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
		membershipId: membership._id,
		lifetime: 1,
		active: true,
	});
	await files_media_validation_db_advance_version(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
	});

	return 1;
}

export async function organizations_membership_lifetimes_db_record(
	ctx: MutationCtx,
	memberships: Array<{ membership: Doc<"organizations_workspaces_users">; active: boolean }>,
) {
	const state = await ctx.db
		.query("access_control_change_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();

	const events = [];
	// Several members can share one workspace clock. Advance it in order.
	for (const { membership, active } of memberships) {
		let lifetime: number;
		if (active) {
			lifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		} else {
			const existing = await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) =>
					q.eq("workspaceId", membership.workspaceId).eq("userId", membership.userId),
				)
				.first();
			lifetime = existing ? existing.lifetime + (existing.active ? 1 : 0) : 1;
			if (existing) {
				if (existing.active) {
					await ctx.db.patch("organizations_membership_lifetimes", existing._id, { lifetime, active: false });
					await files_media_validation_db_advance_version(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
					});
				}
			} else {
				await ctx.db.insert("organizations_membership_lifetimes", {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: membership.userId,
					membershipId: membership._id,
					lifetime,
					active: false,
				});
				await files_media_validation_db_advance_version(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
				});
			}
		}

		// Local jobs also use this lifetime, before an external service starts the change feed.
		if (!active)
			await plugins_schedules_db_cancel(ctx, { workspaceId: membership.workspaceId, userId: membership.userId });
		// A re-invite leaves plugin reader grants of older lifetimes. They read nothing, so delete them.
		if (active && lifetime > 1)
			await ctx.scheduler.runAfter(0, internal.plugins_external_files.delete_old_reader_grants, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				lifetime,
				cursor: null,
			});
		if (!state) continue;
		const organization = active ? await ctx.db.get("organizations", membership.organizationId) : null;
		const member = organization?.defaultWorkspaceId
			? await organizations_membership_lifetimes_db_member_facts(ctx, {
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

		events.push({
			scope: {
				kind: "workspace" as const,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
			},
			event: { kind: "member" as const, member },
		});
	}
	await access_control_changes_db_record(ctx, events);
}

/**
 * Tell plugin services about a new display name. Write one `member` feed doc with fresh facts for each
 * active membership of the user, in pages of 50.
 *
 * A user can belong to many workspaces, so this runs in the background and no user waits on it.
 */
export const record_display_name_change = internalMutation({
	args: {
		userId: v.id("users"),
		cursor: v.union(v.string(), v.null()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("access_control_change_state")
			.withIndex("by_key", (q) => q.eq("key", "main"))
			.first();
		// Before the first lease no plugin service reads the feed.
		if (!state) return null;

		const page = await ctx.db
			.query("organizations_membership_lifetimes")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.paginate({ numItems: args._test_batchSize ?? DISPLAY_NAME_BATCH_SIZE, cursor: args.cursor });

		const events = [];
		// Background job: it may read and skip ended memberships. Their services already got the removal.
		for (const lifetime of page.page) {
			if (!lifetime.active || !lifetime.membershipId) continue;
			const [membership, organization] = await Promise.all([
				ctx.db.get("organizations_workspaces_users", lifetime.membershipId),
				ctx.db.get("organizations", lifetime.organizationId),
			]);
			if (!membership?.active || !organization?.defaultWorkspaceId) continue;

			const member = await organizations_membership_lifetimes_db_member_facts(ctx, {
				membership,
				lifetime: lifetime.lifetime,
				organization,
				defaultWorkspaceId: organization.defaultWorkspaceId,
			});
			events.push({
				scope: {
					kind: "workspace" as const,
					organizationId: lifetime.organizationId,
					workspaceId: lifetime.workspaceId,
				},
				event: { kind: "member" as const, member },
			});
		}
		await access_control_changes_db_record(ctx, events);

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.organizations_membership_lifetimes.record_display_name_change, {
				userId: args.userId,
				cursor: page.continueCursor,
				_test_batchSize: args._test_batchSize,
			});
		}
		return null;
	},
});
