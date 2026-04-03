---
name: workspaces-tenancy
description: Workspaces, projects, default personal/home tenant, membership, invitations, edit/delete rules, deletion queues, delayed content purge (`purge_data_deletion_requests`), and immediate account-deletion workspace cleanup. Use when changing Convex tenancy tables, `packages/app/convex/workspaces.ts`, `packages/app/convex/account_deletion.ts`, `packages/app/server/workspaces.ts`, `packages/app/server/users.ts` (user-level data deletion retention/scope), user bootstrap, or URL/membership resolution tied to workspace/project scope.
---

# Mental model

- A **workspace** groups **projects**. Each workspace has exactly one **primary** (default) project referenced by `workspaces.defaultProjectId` and flagged `workspaces_projects.default === true` for that row.
- **Membership** is per **project**: table `workspaces_projects_users` keys `(userId, workspaceId, projectId)`. A user “sees” a workspace in `list` if they have **any** project membership under that workspace.
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

# Open points

- **Recovery-friendly account deletion:** Current planning direction keeps membership rows for deleted users during the retention window, but marks them **inactive/non-effective** immediately so the user disappears from product behavior while still being recoverable.
- **Membership reactivation semantics:** Not decided yet. If a user recovers the account, or is re-invited while an inactive membership row already exists, decide whether to **reactivate the same row** or create a **new row** and keep the inactive one as history.
- **Active membership queries:** Once inactive memberships exist, all membership-driven reads (lists, counts, admin checks, visibility resolution, orphan detection) must use **active memberships only**, not raw `workspaces_projects_users` rows.

# Creating extra projects

- **`create_project`** is allowed in the **default** workspace as well as others (membership check: user must already have at least one membership in that workspace). Extra projects are **not** the primary project unless created by `workspaces_db_create`.

# Workspace and project deletion and data purge

Two phases:

1. **Structure (immediate, in the delete mutation/action):** delete membership rows, delete workspace/project documents, adjust limits, and for account deletion immediately resolve any now-orphaned workspaces before returning.
2. **Heavy data (batched, cron):** `purge_data_deletion_requests` deletes pages, chat, pending edits, Yjs/snapshots, and related tables for each queued `(workspaceId, projectId)`, then deletes the queue row.

## Direct deletes (`packages/app/convex/workspaces.ts`)

- **`delete_project`** (non-default project only): inserts one `workspaces_data_deletion_requests` row (`scope: "project"`) for that workspace+project, then removes project memberships and the **`workspaces_projects`** document in the same transaction.
- **`delete_workspace`** (non-default only): inserts one `workspaces_data_deletion_requests` row **per project** in that workspace (`scope: "workspace"`), removes memberships and **all** **`workspaces_projects`** rows, deletes **`limits_per_workspace`** rows for that workspace, deletes the **`workspaces`** document, then `ensure` per affected user.

## Account / user deletion path (`packages/app/convex/account_deletion.ts`)

- **`process_user_deletion_request`** removes the user’s memberships and related rows, clears default workspace/project pointers on the user, tombstones the user, then immediately checks each affected workspace in the current database state.
- If a workspace now has **no** `workspaces_projects_users` rows, the mutation deletes that workspace’s project structure right away and inserts `workspaces_data_deletion_requests` rows with `scope: "user"` (same delayed content purge as manual deletes).
- There is no separate orphan-cleanup cron stage in the current flow; the normal purge cron handles the queued content rows after that immediate structural cleanup.

## Content purge worker

- **internal:** `purge_data_deletion_requests` in `workspaces.ts` (uses Convex’s built-in `by_creation_time` index on `_creationTime`).
- **schedule:** [crons.ts](../../../packages/app/convex/crons.ts) (`purge queued workspace data deletions`).
- **Retention:** every queue row becomes eligible only when **`_creationTime`** is at least **`user_DATA_DELETION_RETENTION_MS`** in the past (see [server/users.ts](../../../packages/app/server/users.ts)). There is no special-case immediate purge by origin.

## Queue tables (summary)

| Table | Purpose |
|-------|---------|
| `workspaces_data_deletion_requests` | Pending **content** purge per `(workspaceId, projectId)`; retention is based on document `_creationTime`; `scope` records origin (`project` \| `workspace` \| `user`). |

# Resolution helpers

- **`get_membership_by_workspace_project_name`:** resolves validated names against the **current user’s** membership rows; **first matching** workspace+project pair wins (no global sort of candidates).
- **`list`:** sorts workspaces (default first) and projects (primary first, then name / id).

# Related files

- `packages/app/convex/workspaces.ts` — public API, delete/edit/purge, list, membership queries.
- `packages/app/server/workspaces.ts` — `workspaces_db_create`, `workspaces_db_create_project`, `workspaces_db_ensure_default_workspace_and_project_for_user`, name validation.
- `packages/app/server/users.ts` — user-level delayed content deletion retention (`user_DATA_DELETION_RETENTION_MS`); `user_DataDeletionRequestScope` matches `workspaces_data_deletion_requests.scope` in the Convex schema (via `Doc`).
- `packages/app/convex/users.ts` — bootstrap calls to `ensure`.
- `packages/app/convex/schema.ts` — `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `workspaces_data_deletion_requests`, `users.defaultWorkspaceId` / `defaultProjectId`.
- `packages/app/shared/workspaces.ts` — name autofix/validation and list sort helpers.
- `packages/app/convex/workspaces.test.ts` — behavioral tests for ensure, edit, delete, share restrictions.
- `packages/app/convex/account_deletion.ts` — user deletion, immediate orphaned-workspace teardown, enqueue of delayed content purge rows.
- `packages/app/convex/crons.ts` — user deletion processing and purge cron ordering.

# Auth skill cross-link

High-level auth, **account deletion**, and **planned** public/private semantics live in `../auth-system/SKILL.md`. For **workspace/project structure, deletion queues, and data purge**, prefer this skill (section [Workspace and project deletion and data purge](#workspace-and-project-deletion-and-data-purge)).
