---
name: access-control
description: Backend access-control model for organizations, workspaces, roles, ACL grants, permission checks, role display queries, ownership transfer, and access-control doc cleanup. Use when changing `packages/app/convex/access_control.ts`, `packages/app/shared/access-control.ts`, access-control schema tables, organization/workspace permission checks, ownership transfer, role assignment seeding, or permission lifecycle behavior.
---

# Mental model

- Access control is a backend-first subsystem built on two Convex tables:
  - `access_control_role_assignments`
  - `access_control_permission_grants`
- `organizations_workspaces_users` still represents workspace membership. Access control represents authority.
- Role assignments are workspace-scoped. A role assignment on `organization.defaultWorkspaceId` means organization-wide authority; a role assignment on any other workspace is local to that workspace.
- Product flows maintain one role assignment per `(organizationId, workspaceId, userId)`. Role display queries read the first matching doc and do not resolve conflicts between multiple roles at the same scope.
- Grants are allow-only ACL docs. There are no deny grants.
- The current roles are `owner`, `admin`, and `member`.
- `organizations.ownerUserId` is the source of truth for the organization owner user id. `owner` is still a system role, and exactly one mirrored owner assignment should exist on the organization default workspace for each non-default organization that has an owner.
- `admin` and `member` permissions are data-driven through seeded grant docs. Tightening behavior should change grants/checks, not table shape. Member-management permissions are admin-only; regular members can leave an organization but cannot add or remove other users.

# Tables

## `access_control_role_assignments`

Fields:

- `organizationId`
- `workspaceId`
- `userId`
- `role`: `owner` | `admin` | `member`
- `createdAt`
- `updatedAt`

Important indexes:

- `by_organization_workspace_user_role`: find a user's roles in an organization/workspace.
- `by_organization_workspace_role_user`: find owners or users by role in an organization/workspace.
- `by_user_role_organization_workspace`: find a user's role assignments globally when role cleanup or role display needs it. Owned-organization resolution should query `organizations.by_ownerUser`.
- `by_organization_user_workspace_role`: remove a user's access-control docs inside one organization.

## `access_control_permission_grants`

Fields:

- `organizationId`
- `workspaceId`
- `resourceKind`: `organization` | `workspace` | `file` | `thread`
- `resourceId`: stringified Convex id
- `principalKind`: `role` | `user` | `public`
- optional `userId`
- optional `role`
- `permission`
- `createdAt`
- `updatedAt`

Initial permissions:

- `organization.update`
- `organization.delete`
- `organization.members.manage`
- `organization.roles.manage`
- `workspace.create`
- `workspace.update`
- `workspace.delete`
- `workspace.members.manage`
- `asset.read`
- `asset.write`
- `asset.permissions.manage`
- `api.credentials.manage`

Use the indexes that match the principal kind:

- `by_organization_workspace_resource_role_permission`
- `by_organization_workspace_resource_user_permission`
- `by_organization_workspace_resource_public_permission`
- `by_organization_user_workspace_resource_permission`
- `by_user_organization_workspace_resource_permission`

# Shared types

- `packages/app/shared/access-control.ts` derives role, permission, resource-kind, and principal-kind types from the Convex schema through `Doc<...>`.
- When adding a new role, permission, resource kind, or principal kind, update `packages/app/convex/schema.ts` first and let the shared types follow.
- Do not add separate hand-written union types unless schema inference becomes insufficient.

# Permission checks

Use `access_control_db_has_permission(ctx, args)` from `packages/app/convex/access_control.ts` for backend permission checks.

Callers must load the protected resource, workspace, or organization first and pass the derived `organizationId`, `workspaceId`, `resourceKind`, `resourceId`, organization `defaultWorkspaceId`, and standalone `organizationOwnerUserId` from the organization `ownerUserId` field. The checker does not fetch the organization and does not validate resource scope; the owning mutation/action is responsible for proving the tuple from already-loaded docs before it calls access control.

The checker:

- gives `organizations.ownerUserId` full organization authority
- checks an exact direct user grant
- checks an exact public grant only when `allowPublic` is passed
- checks role grants from the target workspace
- falls back to role grants from the default workspace as organization-wide authority when the target workspace is not the default workspace

Important rules:

- Product flows maintain one role assignment per `(organizationId, workspaceId, userId)`. Permission checks use the first matching role assignment doc instead of resolving multiple roles.
- Public grants are ignored unless the caller explicitly opts in with `allowPublic`.
- Direct user grants allow resource access without changing the user's role.
- Default-workspace fallback checks organization-wide grants. Seeded organization grants intentionally keep broad collaboration permissions, but member-management grants are reserved for admins.
- Keep high-risk backend writes guarded in the mutation/action itself. Frontend guards are convenience, not authority.
- For user-facing mutations, keep `Result({ _nay: { message: "Permission denied" } })` for resolved users who lack access.
- `organizations.remove_user_from_organization` allows non-owner members to remove only themself as an organization leave action; removing another user requires `organization.members.manage`.

# Role display queries

Frontend role display should use the narrow access-control queries instead of bundling role dictionaries into organization list data:

- `access_control.get_current_user_role({ organizationId, workspaceId })`
- `access_control.get_organization_workspace_user_role({ organizationId, workspaceId, userId })`

These queries return the assigned role for exactly the requested workspace scope. The home/default workspace is the organization-role view; non-default workspaces are workspace-local role views. They intentionally do not merge default-workspace organization-wide assignments into workspace-local role display.

`get_organization_workspace_user_role` checks that the current user is a member of the requested workspace before returning a target role. It trusts the target user's role assignment as the product-level proof that the target user belongs to that workspace.

# Seeding and write paths

- `organizations_db_create` stores `organizations.ownerUserId`, creates the mirrored owner assignment on the default workspace, and seeds default organization and default workspace grants.
- `organizations_db_create_workspace` seeds workspace-local grants and gives the creator a workspace-local `member` role.
- Access-control grant seeding is inline in the owning organization creation and migration flows. Use `access_control_db_ensure_role_permission_grant` as the primitive instead of adding single-use seed helpers.
- `invite_user_to_organization_workspace` creates `member` assignments on the organization default workspace and, when different, on the selected workspace.
- `access_control_db_ensure_role_assignment` is idempotent: it returns the existing assignment id without patching timestamps when the same assignment already exists.
- Permission-grant helpers are split by principal kind so invalid argument combinations are not expressible:
  - `access_control_db_ensure_role_permission_grant`
  - `access_control_db_ensure_user_permission_grant`
  - `access_control_db_ensure_public_permission_grant`
- Permission-grant helpers return the grant id directly, not a `Result`. They are idempotent: they return the existing grant id without patching timestamps for the same principal/resource/permission tuple.

Seeded member grants stay broad for collaboration, but regular members do not receive `organization.members.manage`, `workspace.members.manage`, `organization.roles.manage`, `asset.permissions.manage`, or `api.credentials.manage`. Future product tightening should remove or change grants and then add backend checks where needed.

# Ownership transfer

Use `access_control.transfer_organization_ownership` for owner transfer.

Rules:

- only the current `organizations.ownerUserId` can transfer
- default `personal` organizations cannot be transferred
- the new owner must be an active member of the organization default workspace
- the new owner must have an available `extra_organizations` quota slot
- transfer releases one old-owner extra-organization quota unit and consumes one new-owner quota unit
- transfer patches `organizations.ownerUserId`, deletes existing owner assignments and the new owner's previous default-workspace role, gives the old owner a `member` assignment, and gives the new owner the single mirrored `owner` assignment
- auth-removing user finalization transfers each surviving shared organization to its first remaining active default-workspace member before the old owner is removed; it moves the quota charge and replaces that member's previous role with `owner`

Quota details live in `../quotas/SKILL.md`.
Account-deletion resolution flow details live in `../auth-system/SKILL.md`. Account management blocks deletion while the user still owns non-personal organizations, links to the regular organization Users page for ownership transfer, and may call `organizations.delete_organization` after explicit organization-delete confirmation.

# Access-row deletion

Access-control doc cleanup is owned by the lifecycle mutation that removes the related user/organization/workspace. Keep cleanup local to those lifecycle flows unless a helper is genuinely reused and clearer.

Current cleanup locations:

- `organizations.remove_user_from_organization`: deletes the target user's organization memberships plus that user's role assignments and direct user grants in the organization.
- `organizations.delete_workspace`: deletes workspace memberships plus role assignments and permission grants scoped to the workspace.
- `organizations.delete_organization`: queues organization content purge, immediately deletes organization memberships and all access-control docs for that organization, and releases the owner's extra-organization quota.
- `users.list_current_user_account_deletion_blocking_organizations` and `users.delete_current_user_account`: use `organizations.by_ownerUser` to find non-personal organizations where the current user is owner, ignore organizations already queued with an organization deletion request, then block user-facing account deletion until each remaining blocker is transferred or deleted through the normal organization endpoints.
- `data_deletion.init_user_deletion`: for still-owned non-personal organizations, queues organization deletion and immediately deletes organization memberships and access-control docs for each queued organization.
- `data_deletion.process_organization_deletion_request`: deletes remaining access-control docs for the organization before deleting the organization doc and related structure. This is idempotent with earlier immediate cleanup.
- `data_deletion.process_user_deletion_request`: hard account deletion deletes any remaining role assignments and direct user grants for the deleted user.

When deleting rows inline, prefer a single `Promise.all` phase where query results are chained into deletes:

```ts
await Promise.all([
	ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) => q.eq("organizationId", organizationId))
		.collect()
		.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_permission_grants", row._id)))),
]);
```

# Resource ids and scope

- Store `resourceId` as `String(id)`.
- The owning mutation/action must load the protected resource first and derive `organizationId`, `workspaceId`, `resourceKind`, and `resourceId` from that doc before inserting grants or checking permissions.
- For a share mutation, load the page/thread by id first. If it is missing, return `_nay`; otherwise pass the organization/workspace/resource tuple from that doc into access control.
- Access control does not re-query protected resources to validate scope. It answers the grant/role tables directly, which keeps the subsystem flexible and avoids duplicating resource-specific ownership checks.
- `organization` and `workspace` flows can use the already-loaded organization/workspace docs as the source of truth for the tuple.

If a new protected resource kind is added, update:

- `packages/app/convex/schema.ts`
- `packages/app/shared/access-control.ts` through regenerated schema types
- the owning mutation/action so it loads that resource and derives the access-control tuple before using grants
- permission checks at the owning backend mutations/actions
- tests for direct user grants, public grants if applicable, and role grants

# Public access

Public ACL rows are capability-like access, not user membership.

- Public access should be checked only on read/write flows that intentionally support link/public access.
- `allowPublic` must be explicit at the permission-check call site.
- Do not enable public write by default.
- Anonymous user-specific grants should use `principalKind: "user"` with the anonymous Convex `users` id, not `public`.

Public/private upgrade semantics for anonymous users are documented in `../auth-system/SKILL.md`.

# Related skills

- `../organizations-tenancy/SKILL.md`: organization/workspace membership, invitations, organization/workspace deletion lifecycle, data purge, and how access-control docs are cleaned during tenant deletion.
- `../quotas/SKILL.md`: extra-organization quota updates during organization creation, deletion, and ownership transfer.
- `../auth-system/SKILL.md`: current-user identity, anonymous upgrade behavior, account deletion, and public/private security goals.
- `../convex/SKILL.md`: Convex handler, validator, query/mutation, Result, and testing conventions.

# Related files

- `packages/app/convex/access_control.ts`
- `packages/app/shared/access-control.ts`
- `packages/app/convex/schema.ts`
- `packages/app/convex/organizations.ts`
- `packages/app/convex/data_deletion.ts`
- `packages/app/convex/organizations.test.ts`
- `packages/app/convex/data_deletion.test.ts`

# Future direction

- A catalog table such as `access_control_roles` or `access_control_permissions` can be added later if custom roles or UI-managed permission templates become real product requirements.
- Until then, roles and permissions remain schema literals and seeded grant rows.
- Add deny grants only with a deliberate product decision and a redesigned check order. The current system is allow-only.
- Keep role and permission-management UI decoupled from backend enforcement. Backend writes should be correct before UI gates are exhaustive.
