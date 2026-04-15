---
name: workspaces-tenancy
description: Workspaces, projects, default personal/home tenant, membership, invitations, edit/delete rules, shared deletion requests, delayed content purge, and account-deletion workspace cleanup. Use when changing Convex tenancy tables, `packages/app/convex/workspaces.ts`, `packages/app/convex/data_deletion.ts`, `packages/app/server/workspaces.ts`, `packages/app/server/data_deletion.ts`, user bootstrap, or URL/membership resolution tied to workspace/project scope.
---

# Mental model

- A **workspace** groups **projects**. Each workspace has exactly one **primary** (default) project referenced by `workspaces.defaultProjectId` and flagged `workspaces_projects.default === true` for that row.
- **Membership** is per **project**: table `workspaces_projects_users` keys `(userId, workspaceId, projectId)`. A user “sees” a workspace in `list` if they have **any active** project membership under that workspace (`active !== false`; run backfill so stored rows use `active: true` / `false` for index queries).
- **Product rule (workspace membership by primary project):** Workspace-level operations that mean “is this user a member of this workspace?” (e.g. `edit_workspace`) require a membership row on that workspace’s **primary/default project** (`defaultProjectId`), not merely on any project in the workspace.
- The **public API** (`api.workspaces.*` mutations/queries and server helpers they call) is the contract. The **database schema** is wider (optional fields, flags) so migrations and edge rows can exist; do not assume “schema allows it ⇒ product allows it.” Enforce invariants in Convex handlers and in `packages/app/server/workspaces.ts`.

# Default tenant (per user)

- On **user bootstrap** (anonymous create, Clerk resolve/link), the app ensures a **default workspace + default project** for that user via `workspaces_db_ensure_default_workspace_and_project_for_user` in `packages/app/server/workspaces.ts` (called from `packages/app/convex/users.ts`).
- **Stored names** (normalized slugs): workspace `personal`, project `home` (see `DEFAULT_WORKSPACE_NAME` / `DEFAULT_PROJECT_NAME` in `server/workspaces.ts`). UI may display title case; API/storage uses these slugs.
- **User row cache:** `users.defaultWorkspaceId` and `users.defaultProjectId` point at that default tenant. `workspaces_db_ensure_default_workspace_and_project_for_user` is an invariant-establishing helper: if the user already has a default workspace pointer, it trusts the existing tenant and does nothing; if no default exists yet, it creates `personal`/`home`. Do not add "repair" behavior for broken pointers or missing memberships here; that would hide a bug elsewhere.
- **Exactly one default tenant per user** in normal flows: the UI does not create a second default workspace; internal `workspaces_db_create(..., default: true)` is for provisioning that tenant. Non-default workspaces are created with `default: false`.

# Anonymous upgrade preserves tenancy and data

- When `resolve_user` receives an `anonymousUserToken`, it upgrades the **same** Convex `users` row to a Clerk-linked user in `packages/app/convex/users.ts`.
- The anonymous user record remains the canonical user record after upgrade. The code patches `clerkUserId` onto that same row instead of creating a replacement user for the upgraded account.
- Because the same user row is preserved, the user keeps the same `defaultWorkspaceId` and `defaultProjectId` during the normal upgrade path.
- The user therefore keeps the same workspace/project memberships and the same workspace/project-scoped data already attached to that identity and tenant.
- Treat "anonymous user upgrades to signed-in user and keeps the same personal workspace/home project and their data" as a product invariant, not a best-effort repair flow.

# Every new workspace gets a Home project

- `workspaces_db_create` always inserts a default project named `home` (`default: true`) and links `workspaces.defaultProjectId`.
- **`create_workspace`** (public) calls `workspaces_db_create` **without** `default: true`, so it creates a **non-default** workspace plus its `home` project. That workspace is not the user’s `personal` default.

# Edit and delete rules

| Rule | Enforcement (typical) |
|------|------------------------|
| Cannot **edit** the default workspace (`workspaces.default === true`) | `edit_workspace` |
| Cannot **edit** the default/primary project (`project.default` or `project._id === workspace.defaultProjectId`) | `edit_project` |
| Cannot **delete** the default workspace | `delete_workspace` |
| Cannot **delete** the default project | `delete_project` |
| May edit/delete **non-default** workspaces and **non-primary** projects | Same mutations, after guards; permissions use `user_is_workspace_admin` / `user_is_project_admin` (currently stubbed to allow — replace for real RBAC) |

**Refactoring note:** Only the **primary** default **project** is protected from edit across all workspaces. Do **not** block editing **all** projects in the user’s default `personal` workspace based solely on `workspace.default`; only the **`home`** (primary) project is special.

# Invitations / adding members

- **`add_user_to_workspace_project`:** adds a **single** `workspaces_projects_users` row for `(workspaceId, projectId, userIdToAdd)`.
- **Default workspace:** if `workspace.default`, mutation fails with `Cannot add user to default workspace`. That blocks inviting into **personal** and into **any project under personal** (including `home`), matching “no collaborators on the default tenant.”
- **Intended product detail (verify when implementing):** Some specs say “when a user is invited to a project, also add them to that workspace’s default `home` project” so workspace-level membership is always anchored on `home`. **Current code only inserts membership for the target `projectId` — it does not auto-add `home`.** If product requires both rows, extend `add_user_to_workspace_project` and update tests.

# Active memberships

- **Field:** `workspaces_projects_users.active` — `false` only during account-deletion retention so rows stay for recovery but are non-effective; normal rows store `active: true`. Treat **inactive** only as `active === false` (omit/`undefined` counts as active for legacy rows that predate the field).
- **Indexes:** `by_project_user_active`, `by_user_workspace_project_active`, `by_active_workspace_project_user`, `by_active_user_workspace_project` — prefix with `eq("active", true)` so hot paths avoid post-query filtering.

# Creating extra projects

- **`create_project`** is allowed in the **default** workspace as well as others (membership check: user must already have at least one membership in that workspace). Extra projects are **not** the primary project unless created by `workspaces_db_create`.

# Workspace and project deletion and data purge

**Phase 1 — UI-facing / structural (immediate)** | **Phase 2 — Heavy content (one cron)**

| Entrypoint | Phase 1 | Queue row | Phase 2 |
|------------|---------|-----------|---------|
| `workspaces.delete_project` | Queue purge + delete all memberships on that project + delete `workspaces_projects` row + decrement `limits_per_workspace` | One `data_deletion_requests` row with `scope: "project"` plus `userId`, `workspaceId`, `projectId` | `process_project_deletion_request` wipes tenant-scoped tables for that `(workspaceId, projectId)`, then deletes the queue doc |
| `workspaces.delete_workspace` | Queue one row (`scope: "workspace"`, `workspaceId` only); delete all **memberships** immediately; decrement owner `extra_workspaces` limit; **defer** deleting `workspaces`, `workspaces_projects`, and `limits_per_workspace` until cron | One `data_deletion_requests` row with `scope: "workspace"` plus `userId`, `workspaceId` | `process_workspace_deletion_request` resolves project ids from `workspaces_projects`, purges tenant content per project, then deletes projects + `limits_per_workspace` + workspace and removes the queue doc |
| `users.delete_current_user_account` | `init_user_deletion`: creates/reuses one `scope: "user"` row in `data_deletion_requests`, sets `users.deletedAt`, and sets `active: false` on all of the user’s memberships; schedule any paid subscription to end at period close and clear the local subscription mirror immediately | One `scope: "user"` row for the user | Eligible only after `_creationTime + RETENTION_MS`: `process_user_deletion_request` hard-deletes user-owned state, then deletes an entire workspace only when it has no active users left; shared workspaces and their projects remain untouched when active users still exist |

**Unified cron:** [crons.ts](../../../packages/app/convex/crons.ts) runs **`data_deletion.process_deletion_requests`** daily: eligible `user` requests (batch), then `workspace` requests (batch), then `project` requests (batch), each with its own per-run limit.

**Auth identity:** `server_convex_get_user_fallback_to_anonymous` only reads the JWT; it does not load `users` or gate on `deletedAt`. Enforce soft-delete or missing-user rules in specific handlers if required.

## Content purge coverage (`process_workspace_deletion_request` / `process_project_deletion_request`)

**Included (tenant-scoped by workspace + project):** `pages` and related markdown/Yjs/snapshot tables, `ai_chat_threads`, `ai_chat_threads_messages_aisdk_5`, `chat_messages`, `pages_pending_edits` (+ cleanup tasks / last-sequence rows).

**Not present in Convex schema:** there is no `human_thread_messages` table; comments/human threads are not a separate purge target in this codebase today.

**Scale note:** Some slices still use full-table scans + in-memory filters; see index TODO below.

## Queue table (summary)

| Table | Purpose |
|-------|---------|
| `data_deletion_requests` | Shared delayed deletion queue. `scope` means what is being deleted: `project` \| `workspace` \| `user`. `userId` is always required; `workspaceId`/`projectId` are present for workspace/project rows. Retention is based on `_creationTime + RETENTION_MS`. Account deletion uses only the `user` scope row. |

# Resolution helpers

- **`get_membership_by_workspace_project_name`:** resolves validated names against the **current user’s** membership rows; **first matching** workspace+project pair wins (no global sort of candidates).
- **`list`:** sorts workspaces (default first) and projects (primary first, then name / id).

# Related files

- `packages/app/convex/workspaces.ts` — public API, delete/edit, list, membership queries.
- `packages/app/server/workspaces.ts` — `workspaces_db_create`, `workspaces_db_create_project`, `workspaces_db_ensure_default_workspace_and_project_for_user`, name validation.
- `packages/app/server/data_deletion.ts` — shared `data_deletion_db_request` helper and `data_deletion_RequestScope`.
- `packages/app/convex/users.ts` — bootstrap calls to `ensure`.
- `packages/app/convex/data_deletion.ts` — `init_user_deletion`, `process_user_deletion_request`, `process_workspace_deletion_request`, `process_project_deletion_request`, `process_deletion_requests`, `list_deletion_request_ids_by_scope`.
- `packages/app/convex/schema.ts` — `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `data_deletion_requests`, `users.defaultWorkspaceId` / `defaultProjectId`.
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
