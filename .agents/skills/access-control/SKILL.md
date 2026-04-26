---
name: access-control
description: Backend access-control model for workspaces, projects, roles, ACL grants, permission checks, role display queries, ownership transfer, and access-row cleanup. Use when changing `packages/app/convex/access_control.ts`, `packages/app/shared/access-control.ts`, access-control schema tables, workspace/project permission checks, ownership transfer, role assignment seeding, or permission lifecycle behavior.
---

# Mental model

- Access control is a backend-first subsystem built on two Convex tables:
	- `access_control_role_assignments`
	- `access_control_permission_grants`
- `workspaces_projects_users` still represents project membership. Access control represents authority.
- Role assignments are project-scoped. A role assignment on `workspace.defaultProjectId` means workspace-wide authority; a role assignment on any other project is local to that project.
- Product flows maintain one role assignment per `(workspaceId, projectId, userId)`. Role display queries read the first matching row and do not resolve conflicts between multiple roles at the same scope.
- Grants are allow-only ACL rows. There are no deny grants.
- The current roles are `owner`, `admin`, and `member`.
- `owner` is a system role. Exactly one effective owner assignment should exist on the workspace default project for each non-default workspace that has an owner.
- `admin` and `member` permissions are data-driven through seeded grant rows. Tightening behavior should change grants/checks, not table shape. Member-management permissions are admin-only; regular members can leave a workspace but cannot add or remove other users.

# Tables

## `access_control_role_assignments`

Fields:

- `workspaceId`
- `projectId`
- `userId`
- `role`: `owner` | `admin` | `member`
- `createdAt`
- `updatedAt`

Important indexes:

- `by_workspace_project_user_role`: find a user's roles in a workspace/project.
- `by_workspace_project_role_user`: find owners or users by role in a workspace/project.
- `by_user_role_workspace_project`: find a user's role assignments globally, especially for account deletion and owned-workspace resolution.
- `by_workspace_user_project_role`: remove a user's access rows inside one workspace.

## `access_control_permission_grants`

Fields:

- `workspaceId`
- `projectId`
- `resourceKind`: `workspace` | `project` | `page` | `thread`
- `resourceId`: stringified Convex id
- `principalKind`: `role` | `user` | `public`
- optional `userId`
- optional `role`
- `permission`
- `createdAt`
- `updatedAt`

Initial permissions:

- `workspace.update`
- `workspace.delete`
- `workspace.members.manage`
- `workspace.roles.manage`
- `project.create`
- `project.update`
- `project.delete`
- `project.members.manage`
- `asset.read`
- `asset.write`
- `asset.permissions.manage`

Use the indexes that match the principal kind:

- `by_workspace_project_resource_role_permission`
- `by_workspace_project_resource_user_permission`
- `by_workspace_project_resource_public_permission`
- `by_workspace_user_project_resource_permission`
- `by_user_workspace_project_resource_permission`

# Shared types

- `packages/app/shared/access-control.ts` derives role, permission, resource-kind, and principal-kind types from the Convex schema through `Doc<...>`.
- When adding a new role, permission, resource kind, or principal kind, update `packages/app/convex/schema.ts` first and let the shared types follow.
- Do not add separate hand-written union types unless schema inference becomes insufficient.

# Permission checks

Use `access_control_db_has_permission(ctx, args)` from `packages/app/convex/access_control.ts` for backend permission checks.

Callers must load the protected resource, project, or workspace first and pass the derived `workspaceId`, `projectId`, `resourceKind`, `resourceId`, and workspace `defaultProjectId`. The checker does not fetch the workspace and does not validate resource scope; the owning mutation/action is responsible for proving the tuple from already-loaded rows before it calls access control.

The checker:

- gives the default-project owner full workspace authority
- checks an exact direct user grant
- checks an exact public grant only when `allowPublic` is passed
- checks role grants from the target project
- falls back to role grants from the default project as workspace-wide authority when the target project is not the default project

Important rules:

- Product flows maintain one role assignment per `(workspaceId, projectId, userId)`. Permission checks use the first matching role assignment instead of resolving multiple roles.
- Public grants are ignored unless the caller explicitly opts in with `allowPublic`.
- Direct user grants allow resource access without changing the user's role.
- Default-project fallback checks workspace-wide grants. Seeded workspace grants intentionally keep broad collaboration permissions, but member-management grants are reserved for admins.
- Keep high-risk backend writes guarded in the mutation/action itself. Frontend guards are convenience, not authority.
- For user-facing mutations, keep `Result({ _nay: { message: "Permission denied" } })` for resolved users who lack access.
- `workspaces.remove_user_from_workspace` allows non-owner members to remove only themself as a workspace leave action; removing another user requires `workspace.members.manage`.

# Role display queries

Frontend role display should use the narrow access-control queries instead of bundling role dictionaries into workspace list data:

- `access_control.get_current_user_role({ workspaceId, projectId })`
- `access_control.get_workspace_project_user_role({ workspaceId, projectId, userId })`

These queries return the assigned role for exactly the requested project scope. The home/default project is the workspace-role view; non-default projects are project-local role views. They intentionally do not merge default-project workspace-wide assignments into project-local role display.

`get_workspace_project_user_role` checks that the current user is a member of the requested project before returning a target role. It trusts the target user's role assignment as the product-level proof that the target user belongs to that project.

# Seeding and write paths

- `workspaces_db_create` creates the owner assignment on the default project and seeds default workspace and default project grants.
- `workspaces_db_create_project` seeds project-local grants and gives the creator a project-local `member` role.
- Access-control grant seeding is inline in the owning workspace creation and migration flows. Use `access_control_db_ensure_role_permission_grant` as the primitive instead of adding single-use seed helpers.
- `invite_user_to_workspace_project` creates `member` assignments on the workspace default project and, when different, on the selected project.
- `access_control_db_ensure_role_assignment` is idempotent: it returns the existing assignment id without patching timestamps when the same assignment already exists.
- Permission-grant helpers are split by principal kind so invalid argument combinations are not expressible:
	- `access_control_db_ensure_role_permission_grant`
	- `access_control_db_ensure_user_permission_grant`
	- `access_control_db_ensure_public_permission_grant`
- Permission-grant helpers return the grant id directly, not a `Result`. They are idempotent: they return the existing grant id without patching timestamps for the same principal/resource/permission tuple.

Seeded member grants stay broad for collaboration, but regular members do not receive `workspace.members.manage`, `project.members.manage`, `workspace.roles.manage`, or `asset.permissions.manage`. Future product tightening should remove or change grants and then add backend checks where needed.

# Ownership transfer

Use `access_control.transfer_workspace_ownership` for owner transfer.

Rules:

- only the current default-project owner can transfer
- default `personal` workspaces cannot be transferred
- the new owner must be an active member of the workspace default project
- the new owner must have an available `extra_workspaces` quota slot
- transfer decrements the old owner's extra-workspace counter and increments the new owner's counter
- transfer deletes existing owner assignments for that workspace default project, gives the old owner a `member` assignment, and gives the new owner the `owner` assignment

Quota details live in `../workspaces-limits/SKILL.md`.
Account-deletion transfer flow details live in `../auth-system/SKILL.md`.

# Access-row deletion

Access-row cleanup is owned by the lifecycle mutation that removes the related user/project/workspace. Keep cleanup local to those lifecycle flows unless a helper is genuinely reused and clearer.

Current cleanup locations:

- `workspaces.remove_user_from_workspace`: deletes the target user's workspace memberships plus that user's role assignments and direct user grants in the workspace.
- `workspaces.delete_project`: deletes project memberships plus role assignments and permission grants scoped to the project.
- `workspaces.delete_workspace`: queues workspace content purge, immediately deletes workspace memberships and all access-control rows for that workspace, and releases the owner's extra-workspace quota.
- `data_deletion.init_user_deletion`: for still-owned non-personal workspaces, queues workspace deletion and immediately deletes workspace memberships and access-control rows for each queued workspace.
- `data_deletion.process_workspace_deletion_request`: deletes remaining access-control rows for the workspace before deleting the workspace shell. This is idempotent with earlier immediate cleanup.
- `data_deletion.process_user_deletion_request`: hard account deletion deletes any remaining role assignments and direct user grants for the deleted user.

When deleting rows inline, prefer a single `Promise.all` phase where query results are chained into deletes:

```ts
await Promise.all([
	ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_user_permission", (q) => q.eq("workspaceId", workspaceId))
		.collect()
		.then((rows) => Promise.all(rows.map((row) => ctx.db.delete("access_control_permission_grants", row._id)))),
]);
```

# Resource ids and scope

- Store `resourceId` as `String(id)`.
- The owning mutation/action must load the protected resource first and derive `workspaceId`, `projectId`, `resourceKind`, and `resourceId` from that row before inserting grants or checking permissions.
- For a share mutation, load the page/thread by id first. If it is missing, return `_nay`; otherwise pass the workspace/project/resource tuple from that row into access control.
- Access control does not re-query protected resources to validate scope. It answers the grant/role tables directly, which keeps the subsystem flexible and avoids duplicating resource-specific ownership checks.
- `workspace` and `project` flows can use the already-loaded workspace/project docs as the source of truth for the tuple.

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

- `../workspaces-tenancy/SKILL.md`: workspace/project membership, invitations, workspace/project deletion lifecycle, data purge, and how access rows are cleaned during tenant deletion.
- `../workspaces-limits/SKILL.md`: extra-workspace quota updates during workspace creation, deletion, and ownership transfer.
- `../auth-system/SKILL.md`: current-user identity, anonymous upgrade behavior, account deletion, and public/private security goals.
- `../convex/SKILL.md`: Convex handler, validator, query/mutation, Result, and testing conventions.

# Related files

- `packages/app/convex/access_control.ts`
- `packages/app/shared/access-control.ts`
- `packages/app/convex/schema.ts`
- `packages/app/convex/workspaces.ts`
- `packages/app/convex/data_deletion.ts`
- `packages/app/convex/workspaces.test.ts`
- `packages/app/convex/data_deletion.test.ts`

# Future direction

- A catalog table such as `access_control_roles` or `access_control_permissions` can be added later if custom roles or UI-managed permission templates become real product requirements.
- Until then, roles and permissions remain schema literals and seeded grant rows.
- Add deny grants only with a deliberate product decision and a redesigned check order. The current system is allow-only.
- Keep role and permission-management UI decoupled from backend enforcement. Backend writes should be correct before UI gates are exhaustive.
