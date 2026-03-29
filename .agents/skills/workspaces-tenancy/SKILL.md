---
name: workspaces-tenancy
description: Workspaces, projects, default personal/home tenant, membership, invitations, rename/delete rules, and delayed data purge. Use when changing Convex tenancy tables, `packages/app/convex/workspaces.ts`, `packages/app/server/workspaces.ts`, user bootstrap, or URL/membership resolution tied to workspace/project scope.
---

# Mental model

- A **workspace** groups **projects**. Each workspace has exactly one **primary** (default) project referenced by `workspaces.defaultProjectId` and flagged `workspaces_projects.default === true` for that row.
- **Membership** is per **project**: table `workspaces_projects_users` keys `(userId, workspaceId, projectId)`. A user “sees” a workspace in `list` if they have **any** project membership under that workspace.
- **Product rule (workspace membership by primary project):** Workspace-level operations that mean “is this user a member of this workspace?” (e.g. `rename_workspace`) require a membership row on that workspace’s **primary/default project** (`defaultProjectId`), not merely on any project in the workspace.
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

# Rename and delete rules

| Rule | Enforcement (typical) |
|------|------------------------|
| Cannot **rename** the default workspace (`workspaces.default === true`) | `rename_workspace` |
| Cannot **rename** the default/primary project (`project.default` or `project._id === workspace.defaultProjectId`) | `rename_project` |
| Cannot **delete** the default workspace | `delete_workspace` |
| Cannot **delete** the default project | `delete_project` |
| May rename/delete **non-default** workspaces and **non-primary** projects | Same mutations, after guards; permissions use `user_is_workspace_admin` / `user_is_project_admin` (currently stubbed to allow — replace for real RBAC) |

**Refactoring note:** Only the **primary** default **project** is protected from rename across all workspaces. Do **not** block renaming **all** projects in the user’s default `personal` workspace based solely on `workspace.default`; only the **`home`** (primary) project is special.

# Invitations / adding members

- **`add_user_to_workspace_project`:** adds a **single** `workspaces_projects_users` row for `(workspaceId, projectId, userIdToAdd)`.
- **Default workspace:** if `workspace.default`, mutation fails with `Cannot add user to default workspace`. That blocks inviting into **personal** and into **any project under personal** (including `home`), matching “no collaborators on the default tenant.”
- **Intended product detail (verify when implementing):** Some specs say “when a user is invited to a project, also add them to that workspace’s default `home` project” so workspace-level membership is always anchored on `home`. **Current code only inserts membership for the target `projectId` — it does not auto-add `home`.** If product requires both rows, extend `add_user_to_workspace_project` and update tests.

# Creating extra projects

- **`create_project`** is allowed in the **default** workspace as well as others (membership check: user must already have at least one membership in that workspace). Extra projects are **not** the primary project unless created by `workspaces_db_create`.

# Data lifecycle: delete workspace/project

- **`delete_workspace`** (non-default only): enqueues `workspaces_data_deletion_requests`, deletes project membership rows and project rows, deletes the workspace, then runs `workspaces_db_ensure_default_workspace_and_project_for_user` for each **affected user id**. In the current contract, `ensure` only provisions a default tenant when one is missing; it does not repair corrupted pointers.
- **`delete_project`** (non-default project only): same queue pattern for that project’s members, then `ensure` per affected user.
- **Delayed purge:** `purge_data_deletion_requests` (internal, cron-driven) removes downstream domain data (pages, chat, pending edits, etc.) for queued `(workspaceId, projectId)` pairs after retention.

# Resolution helpers

- **`get_membership_by_workspace_project_name`:** resolves validated names against the **current user’s** membership rows; **first matching** workspace+project pair wins (no global sort of candidates).
- **`list`:** sorts workspaces (default first) and projects (primary first, then name / id).

# Related files

- `packages/app/convex/workspaces.ts` — public API, delete/rename/purge, list, membership queries.
- `packages/app/server/workspaces.ts` — `workspaces_db_create`, `workspaces_db_create_project`, `workspaces_db_ensure_default_workspace_and_project_for_user`, name validation.
- `packages/app/convex/users.ts` — bootstrap calls to `ensure`.
- `packages/app/convex/schema.ts` — `workspaces`, `workspaces_projects`, `workspaces_projects_users`, `workspaces_data_deletion_requests`, `users.defaultWorkspaceId` / `defaultProjectId`.
- `packages/app/shared/workspaces.ts` — name autofix/validation and list sort helpers.
- `packages/app/convex/workspaces.test.ts` — behavioral tests for ensure, rename, delete, share restrictions.

# Auth skill cross-link

High-level auth and **planned** public/private semantics still live in `../auth-system/SKILL.md`. For **implementation-level** tenancy rules, prefer this skill.
