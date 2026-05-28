---
name: workspaces-tenancy
description: Workspaces, projects, default personal/home tenant, membership, invitations, edit/delete rules, shared deletion requests, delayed content purge, and account-deletion workspace cleanup. Use when changing Convex tenancy tables, `packages/app/convex/workspaces.ts`, `packages/app/convex/data_deletion.ts`, `packages/app/server/data_deletion.ts`, user bootstrap, or URL/membership resolution tied to workspace/project scope.
---

# Mental model

- A **workspace** groups **projects**. Each workspace has exactly one **primary** (default) project referenced by `workspaces.defaultProjectId` and flagged `workspaces_projects.default === true` for that row.
- **Membership** is per **project**: table `workspaces_projects_users` keys `(userId, workspaceId, projectId)`. A user “sees” a workspace in `list` if they have **any active** project membership under that workspace (`active !== false`; run backfill so stored rows use `active: true` / `false` for index queries).
- **Product rule (workspace membership by primary project):** Workspace-level operations that mean “is this user a member of this workspace?” (e.g. `edit_workspace`) require a membership row on that workspace’s **primary/default project** (`defaultProjectId`), not merely on any project in the workspace.
- **Workspace ownership** lives on `workspaces.ownerUserId`, a required `users` id. Access-control role assignments still represent role membership: `owner`, `admin`, and `member` assignments are scoped to a project, and the workspace default project means workspace-wide authority. Keep the default-project `owner` role assignment as a mirror for role display and ACL compatibility, not as the source of truth for the workspace owner id.
- **Billing mode** lives on `workspaces.billingMode`. Default/personal workspaces always behave as `"user"` billing. Non-personal workspaces are created with `"user"` billing by default and the workspace owner may switch them to `"workspace_owner"`.
- `workspaces.ownerUserId` is the billing payer only when `workspaces.billingMode === "workspace_owner"`. In `"user"` mode, the actor/member remains the payer.
- Ownership transfer changes future owner-billed usage only. It does not rewrite historical usage, move snapshots, transfer credits, or affect `"user"` mode billing.
- Tenant-scoped APIs should take `membershipId` whenever the caller is operating inside a current workspace/project. Derive `workspaceId` and `projectId` from the active membership row instead of trusting client-provided scope strings. Comment APIs (`chat_messages.*`) follow this rule for create/add/archive/list/get.
- The **public API** (`api.workspaces.*` mutations/queries and Convex helpers they call) is the contract. The **database schema** is wider (optional fields, flags) so migrations and edge rows can exist; do not assume “schema allows it ⇒ product allows it.” Enforce invariants in Convex handlers and in `packages/app/convex/workspaces.ts`.

# Default tenant (per user)

- On **user bootstrap** (anonymous create, Clerk resolve/link), the app ensures a **default workspace + default project** for that user via `workspaces_db_ensure_default_workspace_and_project_for_user` in `packages/app/convex/workspaces.ts` (called from `packages/app/convex/users.ts`).
- **Stored names** (normalized slugs): workspace `personal`, project `home` (see `DEFAULT_WORKSPACE_NAME` / `DEFAULT_PROJECT_NAME` in `packages/app/convex/workspaces.ts`). UI may display title case; API/storage uses these slugs.
- **User row cache:** `users.defaultWorkspaceId` and `users.defaultProjectId` point at that default tenant. `workspaces_db_ensure_default_workspace_and_project_for_user` is an invariant-establishing helper: if the user already has a default workspace pointer, it trusts the existing tenant and does nothing; if no default exists yet, it creates `personal`/`home`. Do not add "repair" behavior for broken pointers or missing memberships here; that would hide a bug elsewhere.
- **Exactly one default tenant per user** in normal flows: the UI does not create a second default workspace; internal `workspaces_db_create(..., default: true)` is for provisioning that tenant. Non-default workspaces are created with `default: false`.
- Default workspaces use `billingMode: "user"` and do not expose workspace billing management.
- The default `personal` workspace remains private. Invitation/member-management mutations must reject it, and the main nav hides the Users entry for default workspaces even though the Users page may render for direct/debug URLs.

# Anonymous upgrade preserves tenancy and data

- When `resolve_user` receives an `anonymousUserToken`, it upgrades the **same** Convex `users` row to a Clerk-linked user in `packages/app/convex/users.ts`.
- The anonymous user record remains the canonical user record after upgrade. The code patches `clerkUserId` onto that same row instead of creating a replacement user for the upgraded account.
- Because the same user row is preserved, the user keeps the same `defaultWorkspaceId` and `defaultProjectId` during the normal upgrade path.
- The user therefore keeps the same workspace/project memberships and the same workspace/project-scoped data already attached to that identity and tenant.
- Treat "anonymous user upgrades to signed-in user and keeps the same personal workspace/home project and their data" as a product invariant, not a best-effort repair flow.

# Every new workspace gets a Home project

- `workspaces_db_create` always inserts a default project named `home` (`default: true`) and links `workspaces.defaultProjectId`.
- **`create_workspace`** (public) calls `workspaces_db_create` **without** `default: true`, so it creates a **non-default** workspace plus its `home` project. That workspace is not the user’s `personal` default.
- `workspaces_db_create` stores `workspaces.ownerUserId = userId`, creates the mirrored owner assignment on the default project, seeds default access-control grants, and stores `billingMode: "user"`. This applies to both default and non-default workspaces, but only non-default ownership consumes the user’s `extra_workspaces` quota.

# Access control model

Canonical access-control details live in `../access-control/SKILL.md`.

- Roles are `owner`, `admin`, and `member`.
- The single effective workspace owner is `workspaces.ownerUserId`. A matching `role: "owner"` assignment on `workspace.defaultProjectId` is maintained for role display and ACL compatibility. Owner is a system role with full workspace authority.
- `admin` and `member` authority comes from rows in `access_control_permission_grants`. Current seeded member grants intentionally preserve broad collaborator behavior except member management; future tightening should change grants/checks rather than table shape.
- Non-default project role assignments are local to that project. Default-project role assignments act as workspace-wide fallback.
- ACL grants support `principalKind: "role"`, `"user"`, and `"public"` for resource kinds `workspace`, `project`, `file`, and `thread`. `resourceId` is stored as a stringified Convex id; owning mutations/actions load the resource first and derive the access-control scope from that row.
- Permission checks order: `workspaces.ownerUserId`, direct user grant, public grant when explicitly allowed, target-project role grants, then default-project workspace-wide role grants.
- Use `access_control.get_current_user_role({ workspaceId, projectId })` for current-user UI role display at the requested scope, and `access_control.get_workspace_project_user_role({ workspaceId, projectId, userId })` when a UI needs one listed user's role at that same scope. The default/home project role view is the workspace role view; non-default project views show project-local roles. Do not embed role dictionaries into `workspaces.list`; keep role lookups cached by the concrete workspace/project/user scope.

# Edit and delete rules

| Rule | Enforcement (typical) |
|------|------------------------|
| Cannot **edit** the default workspace (`workspaces.default === true`) | `edit_workspace` |
| Cannot **edit** the default/primary project (`project.default` or `project._id === workspace.defaultProjectId`) | `edit_project` |
| Cannot **delete** the default workspace | `delete_workspace` |
| Cannot **delete** the default project | `delete_project` |
| Only the workspace owner may **delete** a non-default workspace | `delete_workspace` checks `workspaces.ownerUserId` |
| Regular members keep broad current workspace/project abilities except workspace deletion, default-project deletion, and member management | Seeded `access_control_permission_grants` keep current broad behavior while reserving `workspace.members.manage` and `project.members.manage` for admins/owners; `remove_user_from_workspace` still lets members leave themselves |

**Refactoring note:** Only the **primary** default **project** is protected from edit across all workspaces. Do **not** block editing **all** projects in the user’s default `personal` workspace based solely on `workspace.default`; only the **`home`** (primary) project is special.

# Invitations / adding members

- **`invite_user_to_workspace_project`:** accepts either `userIdToAdd` or an exact normalized email resolved from `users_anagraphics.by_email` (id wins when both are provided), rejects missing/deleted/current users, rejects default workspaces, adds membership and `member` role assignment to the workspace `home` project, adds membership and `member` role assignment to the selected project when different, and creates an unread `notifications` row for the invited user.
- **Default workspace:** if `workspace.default`, mutations fail with `Cannot add user to default workspace`. That blocks inviting into **personal** and into **any project under personal** (including `home`), matching “no collaborators on the default tenant.”
- **Users page:** `/w/$workspaceName/$projectName/users` composes granular queries: `workspaces.list` for the visible workspace/projects, `workspaces.list_workspace_project_users` for the `home` roster plus per-project user ids, `users.get_anagraphic` for profile details, and access-control role queries for badges/actions. The workspace `home` project remains the workspace user roster, invite/remove/transfer actions stay disabled for `personal`, and the main sidebar hides the Users nav item whenever `workspace.default === true`; direct URLs may still render this guarded/read-only page.
- **Removing/leaving:** `remove_user_from_workspace` deletes all active memberships and access-control rows for the target user in that workspace, rejects removing the owner, lets a non-owner member remove only themself as a workspace leave action, and requires `workspace.members.manage` to remove another user.
- **Notifications:** invite notifications are in-app only in v1; no outbound email is sent. Backend notification listing treats `notifications` rows as the source of truth and lists the current user's rows without rechecking workspace membership. `projectId` is retained for display/navigation when the originally invited project still exists; if that project is gone, the UI opens the workspace primary/home project. Workspace member removal, project deletion, and workspace deletion delete affected invite notifications so invalid rows do not stay visible.

# Ownership transfer

- `access_control.transfer_workspace_ownership` is owner-only and rejects the default workspace.
- The new owner must be an active member of the workspace `home` project.
- The new owner must have an available `extra_workspaces` quota slot. Transfer releases one old-owner quota unit and consumes one new-owner quota unit.
- The old owner remains a regular member through existing memberships and a default-project `member` assignment unless a separate flow removes them.
- Owner-billed workspaces automatically bill the new owner for operations started after transfer because billing resolves `workspaces.ownerUserId` at operation start.

# Active memberships

- **Field:** `workspaces_projects_users.active` — `false` only during account-deletion retention so rows stay for recovery but are non-effective; normal rows store `active: true`. Treat **inactive** only as `active === false` (omit/`undefined` counts as active for legacy rows that predate the field).
- **Indexes:** `by_project_user_active`, `by_user_workspace_project_active`, `by_active_workspace_project_user`, `by_active_user_workspace_project` — prefix with `eq("active", true)` so hot paths avoid post-query filtering.

# Creating extra projects

- **`create_project`** is allowed in the **default** workspace as well as others (membership check: user must already have at least one membership in that workspace). Extra projects are **not** the primary project unless created by `workspaces_db_create`.

# Workspace and project deletion and data purge

**Phase 1 — UI-facing / structural (immediate)** | **Phase 2 — Heavy content (one cron)**

| Entrypoint | Phase 1 | Queue row | Phase 2 |
|------------|---------|-----------|---------|
| `workspaces.delete_project` | Queue purge + delete all memberships on that project + delete `workspaces_projects` row + release one workspace `extra_projects` quota unit | One `data_deletion_requests` row with `scope: "project"` plus `userId`, `workspaceId`, `projectId` | `process_project_deletion_request` wipes tenant-scoped tables for that `(workspaceId, projectId)`, then deletes the queue doc |
| `workspaces.delete_workspace` | Owner-only. Queue one row (`scope: "workspace"`, `workspaceId` only); delete all **memberships** and access-control rows immediately; release one owner `extra_workspaces` quota unit; **defer** deleting `workspaces`, `workspaces_projects`, and workspace quota docs until cron | One `data_deletion_requests` row with `scope: "workspace"` plus `userId`, `workspaceId` | `process_workspace_deletion_request` resolves project ids from `workspaces_projects`, purges tenant content per project, then deletes projects + workspace quota docs + workspace and removes the queue doc |
| `access_control.transfer_workspace_ownership` / `workspaces.delete_workspace` + `users.delete_current_user_account` | Account management calls `users.list_current_user_account_deletion_blocking_workspaces` as a preflight and opens one resolver modal for owned non-personal workspaces. Each row links to `/w/{workspace}/{home}/users` for the regular Users route ownership-transfer flow, or lets the user confirm deleting the workspace through `workspaces.delete_workspace`. The user-facing `users.delete_current_user_account` repeats the same `workspaces.ownerUserId` blocker check, ignores workspaces already queued with a `scope: "workspace"` deletion request, and refuses deletion until every remaining blocker has been transferred or deleted. After blockers are gone, the user tombstone creates/reuses one `scope: "user"` row, sets `users.deletedAt`, and sets `active: false` on remaining memberships. `internal.data_deletion.init_user_deletion` still queues still-owned non-personal workspaces for deletion when called directly by internal/admin lifecycle paths. | One `scope: "user"` row for normal user-facing account deletion; resolver workspace-delete rows create their own `scope: "workspace"` rows through `workspaces.delete_workspace`; internal/admin direct initializer calls may also create workspace rows for still-owned workspace cleanup | Eligible only after `_creationTime + RETENTION_MS`: `process_user_deletion_request` hard-deletes user-owned state, deletes remaining access-control rows for the deleted user, then deletes an entire workspace only when it has no active users left; shared transferred workspaces remain untouched when active users still exist |

Workspace deletion requests are expected to reference an existing workspace. The worker deletes by the request workspace id without prefetching the workspace doc, clearing matching scoped cleanup docs such as quotas before deleting the workspace shell and queue doc.

**Unified cron:** [crons.ts](../../../packages/app/convex/crons.ts) runs **`data_deletion.process_deletion_requests`** daily: eligible `user` requests (batch), then `workspace` requests (batch), then `project` requests (batch), each with its own per-run limit.

**Auth identity:** `server_convex_get_user_fallback_to_anonymous` only reads the JWT; it does not load `users` or gate on `deletedAt`. Enforce soft-delete or missing-user rules in specific handlers if required.

## Data-only account reset

`users.hard_delete_user_now` with omitted `purgeUserMod` or `"data"` is a live reset, not account deletion. It preserves the auth-capable `users` row, profile, billing state, default `personal` workspace, and default `home` project. It cancels queued deletion requests owned by the reset user so stale user/workspace/project purge rows cannot run after the live account is restored. It purges content inside `home`, deletes extra projects under `personal`, deletes owned non-default workspaces only when no other active user belongs to that workspace, and deletes extra shared projects only when the reset user is the sole active member of that project.

## Content purge coverage (`process_workspace_deletion_request` / `process_project_deletion_request`)

**Included (tenant-scoped by workspace + project):** `files` and related markdown/Yjs/snapshot tables, `files_r2_assets` and their R2 objects, `ai_chat_threads`, `ai_chat_threads_messages_aisdk_5`, `chat_messages`, `files_pending_updates` (+ cleanup tasks / last-sequence rows).

**Not present in Convex schema:** there is no `human_thread_messages` table; comments/human threads are not a separate purge target in this codebase today.

**Scale note:** Some slices still use full-table scans + in-memory filters; see index TODO below.

## Queue table (summary)

| Table | Purpose |
|-------|---------|
| `data_deletion_requests` | Shared delayed deletion queue. `scope` means what is being deleted: `project` \| `workspace` \| `user`. `userId` is always required; `workspaceId`/`projectId` are present for workspace/project rows. Retention is based on `_creationTime + RETENTION_MS`. Account deletion always creates/reuses a `user` scope row and may also create `workspace` scope rows for still-owned workspaces. |

# Resolution helpers

- **`get_membership_by_workspace_project_name`:** resolves validated names against the **current user’s** membership rows and returns only the matching membership row; **first matching** workspace+project pair wins (no global sort of candidates). UI that needs workspace metadata, including `workspace.default`, should compose it from `workspaces.list` instead of carrying it in tenant context.
- **`list`:** sorts workspaces (default first) and projects (primary first, then name / id). Workspace docs include `owner`, so UI can label owner-billed workspaces without querying billing state.

# Related files

- `packages/app/convex/workspaces.ts` — public API, DB helpers, create/bootstrap, delete/edit, list, membership queries.
- `packages/app/convex/access_control.ts` — public access-control API plus role assignment helpers, seeded grants, effective permission checks, and ownership transfer.
- `packages/app/server/data_deletion.ts` — shared `data_deletion_db_request` helper and `data_deletion_RequestScope`.
- `packages/app/convex/users.ts` — bootstrap calls to `ensure`.
- `packages/app/convex/data_deletion.ts` — `hard_delete_user_data` for live data resets, `finalize_user_deletion_data` for tombstone/deletion finalization, `init_user_deletion`, automatic owned-workspace deletion queueing, `process_user_deletion_request`, `process_workspace_deletion_request`, `process_project_deletion_request`, `process_deletion_requests`, `list_deletion_request_ids_by_scope`.
- `packages/app/convex/notifications.ts` — in-app invite notifications.
- `packages/app/convex/schema.ts` — `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `access_control_role_assignments`, `access_control_permission_grants`, `notifications`, `data_deletion_requests`, `users.defaultWorkspaceId` / `defaultProjectId`.
- `packages/app/shared/access-control.ts` — shared role, permission, principal-kind, and resource-kind types.
- `packages/app/shared/workspaces.ts` — name autofix/validation and list sort helpers.
- `packages/app/convex/workspaces.test.ts` — behavioral tests for ensure, edit, delete, share restrictions.
- `packages/app/convex/data_deletion.test.ts` — user deletion + shared deletion-request behavior.
- `packages/app/convex/crons.ts` — `data_deletion.process_deletion_requests` (workspace/project purge then user hard-delete batch).

## Purge worker index TODO

- Prefer **narrow index reads** per `(workspaceId, projectId)` (and eligible queue rows by due time) instead of whole-table scans where tables may grow; project/workspace purge still does some full-table scans and in-memory filtering today.

## Account-deletion retention TODO

- Today, phase 2 still runs after the fixed retention window even if a paid subscription was only scheduled to end at billing-period close.
- In the future, once long-running plans such as yearly subscriptions exist, phase 2 should wait until subscription end when that is later than retention so paid users do not lose their data before the paid term finishes.

# Auth skill cross-link

High-level auth, **account deletion**, and **planned** public/private semantics live in `../auth-system/SKILL.md`. For **workspace/project structure, deletion queues, and data purge**, prefer this skill (section [Workspace and project deletion and data purge](#workspace-and-project-deletion-and-data-purge)).
