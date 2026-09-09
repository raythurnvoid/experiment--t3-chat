import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { access_control_db_has_permission } from "./access_control.ts";
import { access_control_changes_db_record } from "./access_control_changes.ts";

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
		const lifetime = existing.lifetime + (existing.active && existing.membershipId !== membership._id ? 1 : 0);
		if (!existing.active || existing.membershipId !== membership._id) {
			await ctx.db.patch("organizations_membership_lifetimes", existing._id, {
				membershipId: membership._id,
				active: true,
				lifetime,
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
	if (!state) return;

	const events = await Promise.all(
		memberships.map(async ({ membership, active }) => {
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
					await ctx.db.patch("organizations_membership_lifetimes", existing._id, { lifetime, active: false });
				} else {
					await ctx.db.insert("organizations_membership_lifetimes", {
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
	await access_control_changes_db_record(ctx, events);
}
