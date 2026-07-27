---
name: access-control
description: Backend access-control model for organizations, workspaces, system and custom roles, role assignment, ACL grants, permission checks, role display queries, ownership transfer, and access-control doc cleanup. Use when changing `packages/app/convex/access_control.ts`, `packages/app/shared/access-control.ts`, access-control schema tables, organization/workspace permission checks, ownership transfer, role assignment, or permission lifecycle behavior.
---

# Mental model

Membership says where you are. Access control says what you may do there.

- `organizations_workspaces_users` is membership. Access control is authority. Both are required: the
  permission check never proves membership, so every caller proves it first.
- Authority comes from three places, checked in this order:
  1. **Owner** — `organizations.ownerUserId`. The owner may do everything, and every check answers
     ownership before it reads any assignment. There is no `owner` role, and owners hold **no
     assignment doc** — you may rely on that. Both writers enforce it:
     `invite_user_to_organization_workspace` skips the assignment when the invitee is the owner, and
     ownership transfer deletes the new owner's assignments everywhere. The invite guard is
     load-bearing rather than defensive: its membership insert is conditional while the assignment
     write is not, so inviting the owner into a workspace they are not in would otherwise leave a
     stray `member` row on the default workspace and quietly falsify this invariant.
  2. **Role** — one `access_control_role_assignments` doc per `(organizationId, workspaceId, userId)`.
  3. **Direct grant** — an `access_control_permission_grants` doc for per-file sharing.
- Grants are allow-only. There are no deny grants.

## Where a role binds

- An assignment on `organization.defaultWorkspaceId` is the **organization-wide** role. It reaches
  every workspace the user is an active member of.
- An assignment on any other workspace is **extra elevation** in that workspace only. Roles only ever
  add, so a weaker workspace-local role cannot take anything away. `set_user_role` refuses one that
  would change nothing, and takes `role: null` to remove the elevation instead. Without that revoke
  the two guards deadlock: no weaker role is accepted, and `delete_role` refuses while it is held.
- A permission's `scope` in the catalog decides how far it reaches:
  - `scope: "organization"` binds only from the default-workspace assignment.
  - `scope: "workspace"` binds at the workspace the assignment sits on. The checker does not test
    membership there — the caller already proved it. Membership **is** tested when a workspace-scoped
    permission arrives from the organization-wide role, because that role reaches workspaces the user
    may not belong to.

## Roles

- **System roles** are `admin`, `member`, `viewer`. They live in code in
  `access_control_SYSTEM_ROLE_MATRIX`, not in the database. No seeding, no migration when the matrix
  changes, and nobody can edit them.
  - `admin` — everything except `organization.billing.manage` (it charges the owner) and
    `content.permissions.manage` (not enforced yet).
  - `member` — `workspace.create`, `workspace.update`, `content.read`, `content.write`.
  - `viewer` — `content.read` only.
- **Custom roles** are `access_control_roles` docs, organization-wide, at most 20 per organization.
  Users compose them from the fixed permission catalog; they can never invent a permission.
- An assignment's `role` field is either a system role key or a custom role doc id.

# Tables

## `access_control_roles`

Custom roles only. `createdBy` is kept after that user is deleted, because the role belongs to the
organization. UI must tolerate a missing author.

Index: `by_organization_normalizedName` — `normalizedName` is the trimmed lowercase name, unique per
organization, and never a system role key or `owner`.

## `access_control_role_assignments`

Fields: `organizationId`, `workspaceId`, `userId`, `role`, `createdAt`, `updatedAt`.

`role` is deliberately **not** part of the primary key: one assignment per
`(organizationId, workspaceId, userId)`, so changing a role patches the doc instead of inserting a
second one.

Indexes:

- `by_organization_workspace_user` — the caller's role at one workspace.
- `by_organization_user_workspace` — every assignment a user holds in one organization.
- `by_user_organization_workspace` — every assignment a user holds anywhere (account deletion).
- `by_organization_role_workspace_user` — who holds one role (`list_roles`, `delete_role`).

## `access_control_permission_grants`

Fields: `organizationId`, `workspaceId`, `resourceKind` (`organization` | `workspace` | `file` |
`thread`), `resourceId` (stringified id), `principalKind` (`role` | `user` | `public`), optional
`userId`, optional `role`, `permission`, `createdAt`, `updatedAt`.

**Nothing in production writes grant docs today.** System role permissions moved into code, so the old
seeded organization and workspace grants are gone. The table stays for per-file sharing, which arrives
with the file-sharing milestone. The check already reads it, and
`access_control_db_ensure_user_permission_grant` / `..._public_permission_grant` exist but only tests
call them.

Pick the index that matches the principal kind:

- `by_organization_workspace_resource_role_permission`
- `by_organization_workspace_resource_user_permission`
- `by_organization_workspace_resource_public_permission`
- `by_organization_user_workspace_resource_permission`
- `by_user_organization_workspace_resource_permission`
- `by_organization_role_workspace_resource` — every grant that names one role (`delete_role`).

# Permission catalog

`packages/app/shared/access-control.ts` holds every permission with its `label`, `description`,
`group` and `scope`. It is the single source of truth for both the checker and the role editor.

| Permission | Scope |
| --- | --- |
| `organization.update` | organization |
| `organization.members.manage` | organization |
| `organization.roles.manage` | organization |
| `organization.billing.manage` | organization |
| `workspace.create` | organization |
| `workspace.update` | workspace |
| `workspace.delete` | workspace |
| `workspace.members.manage` | workspace |
| `content.read` | workspace |
| `content.write` | workspace |
| `content.permissions.manage` | workspace |
| `workspace.plugins.manage` | workspace |

Rule: **every permission in the catalog must be enforced somewhere**, or be marked
`enforcedBy: "file-sharing"`. A permission the role editor offers that nothing checks is a switch
that silently does nothing. `access_control_ENFORCED_PERMISSIONS` filters the marked ones out, and
`create_role` / `update_role` refuse them. Today `content.permissions.manage` is the only one.

To add a permission: add the literal to `access_control_permission_validator` in
`packages/app/convex/schema.ts`, add the catalog entry, then add the check that enforces it.

# Permission checks

## The retrofit helper

Most handlers should use `access_control_db_authorize_membership(ctx, { userAuth, membership,
permission, fileNode? })`. It takes the **already-loaded** membership doc (loading it inside would
create an import cycle with `organizations.ts`), loads the organization, and returns
`Result<{ organization }, { message }>` with `"Unauthenticated"`, `"Unauthorized"` or
`"Permission denied"`. It also returns `"Unauthenticated"` when the caller's `users` doc is missing or
tombstoned — any caller, anonymous or signed in — so that gap is closed once instead of in every
handler.

Pass the loaded `fileNode` when the operation targets one; the helper derives the scope tuple. Never
build a `file` resource by hand.

**Most node-targeting handlers do not pass it yet.** Exactly nine call sites do — `files_nodes.ts`
rename / get-node / get-by-path / the three yjs handlers, both sites in `r2.ts`, and
`save_file_pending_update_in_db` in `files_pending_updates.ts`. Everything else authorizes at the
workspace only:

- the snapshot family — `get_file_snapshots_list`, `get_file_snapshot`, `archive_snapshot`,
  `unarchive_snapshot`, `restore_snapshot_r2` and their data queries, plus
  `create_file_snapshot_content_url` and `yjs_prepare_doc_last_snapshot`
- the structural mutations — `create_folder_node`, `create_upload_node`, `move_nodes`,
  `archive_nodes`, `unarchive_nodes`. The two create mutations target a `parentId`, so a restricted
  *folder* is as reachable as a restricted file.
- the pending-update family — `apply_file_pending_move`, `apply_file_pending_archive`,
  `discard_file_pending_structural`, `persist_file_pending_update_rebased_state_in_db`,
  `get_file_pending_update`, `get_file_pending_update_last_sequence_saved`
- the workspace-wide listings — `list_tree` and `list_files_pending_updates`. These take no node
  argument, so `fileNode` cannot fix them; they need a per-node filter, or a restricted node's name
  and path stay visible to everyone in the workspace.

That is the same answer today, because nothing writes `restrictedScopeNodeId`. But every one of them
carries, moves or lists file content, so they all need the node leg before file sharing ships. Fixing
only the snapshot family would ship restricted files that anybody in the workspace can still move,
archive, or read the pending content of.

This list covers handlers that authorize and pass no node. `files_metadata.ts`, `files_snapshot.ts`,
`ai_chat_files.ts` and `github_mounts.ts` are absent because they export no public query, mutation or
action at all — they are reached through internal functions, which is the separate unguarded surface
described under "Not enforced yet".

## The raw checker

`access_control_db_has_permission(ctx, { organizationId, workspaceId, defaultWorkspaceId,
organizationOwnerUserId, resource, permission, userId?, allowPublic? })` is for callers that already
hold the organization doc. It does not fetch anything to validate scope, and it does not prove
membership.

Order, short-circuiting on the first pass:

1. owner
2. restricted-file branch — for a `file` resource with a live restricted scope, and it **never falls
   through** to workspace access
3. exact direct user grant
4. exact public grant, only when `allowPublic` is passed
5. role at the target workspace — skipped for an `organization`-scoped permission unless that
   workspace *is* the default one
6. role from the default workspace — an `organization`-scoped permission binds outright; a
   `workspace`-scoped one only if the user is an active member of the target workspace

A grant that governs a restricted subtree carries the **restricted scope node** as its `resourceId`,
never the accessed node. When a node has no scope the check still looks for a grant on the node itself
before falling back to the caller's role; no `workspace`-resource grant is ever consulted for a file,
and nothing writes a node grant, so that lookup always misses today.

The consequence that matters most for the file-sharing milestone: **inside a restricted subtree a
role's permissions grant nothing.** `has_restricted_file_permission` consults user grants, public
grants, and grant docs that name a role — never the role's own permission set. So a non-owner admin is
locked out of a restricted file unless a grant names them or a role they hold. Only the owner bypasses
it.

## Effective permissions

`access_control_db_resolve_effective_permissions` returns the whole set (or `"all"` for the owner).
Use it when one handler needs several answers, such as comparing what a caller may hand out.

It reads roles only and **ignores direct grants** on purpose. Every ceiling in the subsystem compares
through it, so a grant can never widen what a caller may hand out. Keep it that way once file sharing
starts writing grants.

## Conventions

- Rate limit first, permission second, in new handlers. A denied call still costs a token, so
  permission probing is not free. Two sets of exceptions exist, both deliberate:
  `ai_chat.thread_messages_add`, whose cost depends on a prior read; and the older
  `organizations.ts` handlers (`remove_user_from_organization`, `edit_organization`,
  `edit_workspace`, `delete_workspace`, `delete_organization`), which resolve authorization first.
  Match the local order when editing those; do not reorder them for tidiness.
- Charge the bucket once per operation. An action whose inner mutation already takes a token must not
  take one too, or the user's real budget halves. `files_pending_updates.save_file_pending_update` and
  `persist_file_pending_update_rebased_state` are the two that would.
- Role mutations use the `roles_write` bucket; `transfer_organization_ownership` stays on
  `organizations_write`.
- Return `Result({ _nay: { message: "Permission denied" } })` for a resolved user who lacks access.
- Frontend gates are convenience. The backend write is the authority.
- Nobody may hand out more than they hold. `create_role`, `update_role`, `delete_role`,
  `set_user_role` and `invite_user_to_organization_workspace` all compare the target role's
  permissions against the caller's own set. Without this an admin mints a custom role above itself.
  The rule forbids **escalation, not destruction**. Revoking takes no ceiling: it hands out nothing,
  and it can only return the target to their organization-wide role, so it never reaches past the
  caller's own level and never drops anyone below the floor every member stands on. Nor do
  `set_user_role` demoting someone out of a strong role, or
  `organizations.remove_user_from_organization`, which has no ceiling at all — an admin can strip a
  billing-only role from its holder even though `delete_role` refuses to delete that role. Not a
  contradiction: `delete_role`'s ceiling protects the role **definition**, which nobody can restore
  once it is gone, while a demotion or removal is undone by the owner in a click. Do not read the
  `delete_role` refusal as "this authority cannot be taken away".
  Only `set_user_role` reads its ceiling at the target workspace, which the caller need not belong to;
  the other four read it at the default workspace. Note the ceiling is the caller's organization-wide
  role's *full* permission list, so at a workspace they do not belong to it can be slightly wider than
  what they could exercise there — bounded by the role they hold, and not exploitable, so do not
  "fix" it.
- One action does not always map to one permission. `edit_workspace` accepts `workspace.update` **or**
  `organization.update`, and the frontend mirrors the same pair. Only custom roles make the disjunction
  matter, because every system role that has one has the other.
- `organization.members.manage` and `workspace.members.manage` are not the same capability at two
  scopes. The organization one gates invite, remove and role changes. The workspace one gates only
  role changes inside one workspace — its holder cannot invite or remove anyone. The catalog label
  says so; the key does not.
- Chat threads are workspace-wide, not private to their author, so they gate on `content.read`
  (`THREAD_PERMISSION` in `ai_chat.ts`). Changing somebody else's thread — retitle, archive, add
  messages — needs `content.write` on top, through `authorize_thread_mutation`; the author is exempt.
  `thread_mark_read` is the deliberate exception and takes no such check: `readAt` is one field on the
  shared thread, so the unread badge is a workspace-wide signal that anyone who may read the thread
  may clear, and gating it would leave a read-only role with badges it can never clear.

# Endpoints

## Roles

- `list_roles({ organizationId })` — any member with an active membership on the **default**
  workspace; `[]` when not one. `assignmentCount` counts assignment **docs, not people** — UI copy has
  to say "assignments". It saturates at `MAX_ROLE_ASSIGNMENT_COUNT`, includes holders in retention, and
  counts a workspace-local elevation separately, so it can exceed the number of people who actually
  have to be moved before a delete.
- `create_role`, `update_role`, `delete_role` — need `organization.roles.manage`. `delete_role` refuses
  while any holder with an active membership still has the role, and refuses above the assignment cap
  rather than deleting a partial page. An assignment whose holder has no active membership **at that
  assignment's own workspace** is the exception, and is demoted instead: default-workspace rows drop to
  `viewer`, workspace-local rows are deleted. That demotion is a role hand-out like any other, so it
  takes the same ceiling — the delete is refused when the caller cannot hand out what `viewer` grants,
  which is reachable because nothing forces a custom role to include `content.read`. Full reasoning
  lives in the code comment above the demotion.

## Assignment

- `set_user_role({ organizationId, workspaceId, userId, role })` — needs
  `organization.members.manage`, or `workspace.members.manage` **plus** the caller's own active
  membership at that workspace and a workspace that is not the default one. Three refusals fire before
  that disjunction, and each is a state the UI has to render: the caller needs an active membership on
  the **default** workspace whatever their permissions; the target may never be the owner; and the
  target needs an active membership at the workspace being changed. `role: null` revokes a
  workspace-local elevation; at the default workspace it is refused, because every member needs an
  organization role and weakening it says the same thing readably. No single handler *checks* that
  invariant; the write paths below establish, preserve and repair it between them.
- `organization.roles.manage` reaches member authority indirectly: editing a role's permissions
  changes what everyone holding it can do, without `organization.members.manage`. The ceiling still
  caps it at the editor's own level, so it is not an escalation, but it is a wider capability than
  the label suggests.
- `transfer_organization_ownership({ organizationId, newOwnerUserId })` — only the current owner;
  never the default `personal` organization; the new owner must be an active member of the default
  workspace and have an `extra_organizations` quota slot. It patches `ownerUserId`, moves one quota
  unit, deletes **all** of the new owner's assignments in that organization, and gives the old owner
  `member`.

## Display and gating queries

- `get_current_user_role`, `get_organization_workspace_user_role` — return `null` or
  `{ kind: "owner" }` / `{ kind: "system", role }` / `{ kind: "custom", roleId, name }`. Both load the
  organization and answer `owner` before reading assignments, or the owner renders as "Member".
- `get_current_user_organization_permission`, `get_current_user_workspace_permission` — booleans for
  UI gating. Use the workspace one for content gating; the organization one always resolves at the
  default workspace.
- `organizations.list` also returns `workspaceIdsPermissionsDict`, so the tenant switcher can gate
  every row without one query per row.
- `users.get_anagraphic` is not permission-gated — any signed-in caller resolves any `users` id to a
  display name and avatar, because those render next to file edits, snapshots and notifications where
  the caller often shares no tenant with the person named. It carries **one** rule: `email` comes back
  only when you ask for yourself, and is `""` for everyone else. That is not cosmetic. The argument is
  a bare `users` id, and ids are handed out in bulk by presence rosters, so without it anyone who
  could call at all could walk a roster into an address book. `""` is the value anonymous users
  already carry, so every reader already has a no-email branch — do not "fix" one by widening the
  query.

# Write paths that create an assignment

After seeded grants were removed, the assignment doc is the only source of member authority for a
non-owner. Production writers are few on purpose:

- `organizations.invite_user_to_organization_workspace` — one `member` assignment on the default
  workspace. That one doc is the organization-wide role, so no second doc for the invited workspace.
- `access_control.set_user_role` — the only handler whose *purpose* is changing or revoking a role.
  Three other paths rewrite assignments as a side effect: the two below, and `delete_role` (demote to
  `viewer`, delete elevations).
- `access_control.transfer_organization_ownership` — deletes **all** of the new owner's assignments in
  the organization, and gives the old owner `member`.
- the ownership handoff in `data_deletion.ts` — when a deleted user owns a non-default organization
  that still has members, ownership moves to whichever member the index returns first, that member's
  assignments across every workspace are deleted, and `billingMode` is forced to `"user"`. Unconsented,
  and a second ownership-establishing path next to `transfer_organization_ownership`.
- `migrations.backfill_access_control_member_assignments` — gives a `member` assignment to every active
  default-workspace membership written before authority moved off membership. Skips owners outright.
- `migrations.backfill_organization_home_memberships` — mainly inserts a *missing* default-workspace
  membership for a user who only has a non-default one, then gives it a `member` assignment. Its owner
  check guards only the assignment, so an owner can get a repaired membership but never a role.
- Both backfills are safe to re-run, and both skip **inactive** memberships, so neither repairs an
  account that was in retention when they ran; `users.resolve_user` covers that on the way back in.
- `users.resolve_user` — reclaiming a deleted account reactivates its memberships, so it ensures a
  `member` assignment on each reactivated default-workspace membership, skipping owners. `ensure`
  leaves a surviving assignment alone whatever its role, so this only fills a hole — and after the
  `delete_role` demotion above, the only hole left is a legacy membership the backfill skipped, which
  is exactly the case `member` is right for.

Paths that deliberately write **none**:

- `organizations_db_create` and every personal-organization creation in `data_deletion.ts` — the
  creator becomes the owner, and owners hold no assignment.
- `organizations_db_create_workspace` — the creator's organization-wide role already reaches the new
  workspace.

`access_control_db_ensure_role_assignment` inserts when absent, so a repeat call is a no-op.
`db_set_role_assignment` patches or inserts on the unique key — use it when changing an existing
role. It is module-private to `access_control.ts`: role writes go through the mutations there, not
through a shared helper.

# Access-doc deletion

Cleanup belongs to the lifecycle mutation that removes the user, workspace, or organization:

- `organizations.remove_user_from_organization` — that user's assignments and direct grants in the
  organization.
- `organizations.delete_workspace` — memberships, assignments, and grants scoped to the workspace. It
  requires `workspace.delete`, and it refuses the **default** workspace. That refusal is what protects
  the every-member-needs-an-organization-role invariant: deleting the default workspace would delete
  every member's organization-wide assignment at once. It keys off the workspace's own `default` flag,
  a second source of truth next to `organization.defaultWorkspaceId`.
- `organizations.delete_organization` — all access-control docs for the organization, plus the quota
  release.
- `data_deletion.init_user_deletion`, `process_organization_deletion_request`,
  `process_user_deletion_request` — the remaining docs. Idempotent with the immediate cleanup above.

`delete_organization` and the data-deletion paths also delete the organization's `access_control_roles`
docs.

# Not enforced yet

Be explicit about this when planning work; do not assume the subsystem is complete.

- **AI tools and the bash shell** reach files through internal functions that take `userId` as an
  argument and check nothing. `/api/chat` is the entry point for the tool-bearing agent, and it asks
  two questions: `content.read` in both modes, plus `content.write` for agent mode. Two questions and
  not one, because the catalog lets an owner compose write-without-read. That role never actually
  reached bash — `thread_get` and `thread_create` gate on `content.read` too — but it got a 400 that
  reads like a malformed request, and the route was leaning on another handler's gate to stop it.
  Asking here makes the route self-gating and the answer a correct 403. Ask mode has a second layer
  besides that boolean: its one
  write tool (`edit_file`, the whole of `ai_chat_WRITE_TOOL_NAMES`) is removed from the `tools` record
  `streamText` receives — not merely from `activeTools`, which is advisory and only shapes the
  provider payload — and app-file `writeFile`, `mkdir` and `utimes` are all refused by
  `allowDbFilesMkdir: false`, which despite its name gates every db-files write rather than just
  directory creation. The internals themselves are still unguarded, so any new caller has to check for
  itself. The agent has one other door onto file content: `execute_code` mints a public-API grant
  token scoped to file list and read, which re-enters through the public API and *is* re-checked there.
- **Plugin runs skip the content check outright.** `public_api_resolve_live_principal` applies
  `requiredUserPermission` to every principal kind except `plugin_run`. The skip is structural, not a
  missing branch: the `plugin_run` principal carries no `contentPermissions` field at all — its
  authority is a platform baseline of files download, files write and activities write, plus
  secrets-read and outbound-fetch from the run's accepted capabilities — so the milestone has to give
  it a content-permission source before the check can include it. Note the baseline half: a plugin run
  downloads and writes files having accepted **no** capability, so do not scope this work as "bound
  plugin authority by what the user consented to". A latent footgun sits next to it:
  `requiredUserPermission` is optional, so a route that omits it runs no user ACL check for *any*
  principal kind. The activities route omits it, which costs nothing today because its `allowedKinds`
  is `["plugin_run"]` and plugin runs skip the check anyway — but the next route that omits it while
  accepting `user_api_key`, `public_api_grant` or `plugin_ui` is a real hole. Everything else binds on
  a plugin run — token
  expiry, quota, `allowedKinds`, `requiredScope`, and the transactional write revalidation — so the gap
  is content-check-only. Restricted files will not hold against a plugin until that changes.
- **The global presence roster is readable by any account, and the `listRoom` gate does not change
  that.** Read this bullet as one fact, not two: `listRoom` refuses a caller with no identity and
  refuses `app_presence_GLOBAL_ROOM_ID` outright, and **that closes one door of two**. The other door
  is open and the app itself uses it — `MainAppSidebarPresenceControl` heartbeats the global room,
  takes the room token `heartbeat` mints for any id, and passes it to `list`, which authorizes
  nothing beyond `require_identity`. Anonymous accounts satisfy that, and one unauthenticated POST
  mints an anonymous account. Reproduced live against `grand-finch-267`: `listRoom` on the global room
  answered `Unauthorized` while `heartbeat` + `list` returned 104 users with `displayName` and
  `avatarUrl` to the *same* anonymous caller. So the `listRoom` special case buys close to zero
  marginal protection today; it is kept because it is the handler that takes a raw `roomId`, and the
  real fix is binding a room to its tenant. Presence projects `displayName` and `avatarUrl` only,
  never `email`. `listRoom` also still authorizes no *other* room, so any signed-in user can name
  everyone in any room id they derive, and room ids are derivable client-side. `listRoom` is the
  entry, not the whole surface: `list`, `listSessions`, `getSessionsData`, `setSessionData`,
  `removeSessionData` and `disconnect` authorize nothing beyond that room token. The sidebar's
  presence toggle is **not** an opt-out from this room:
  `MainAppSidebarPresenceControl` calls `usePresence` on the global room *before* the
  enabled/disabled branch, so a user who clicked Disable still sends a heartbeat every 10s and still
  comes back from `listRoom` as online — verified on the wire. The flag does gate per-file presence
  (`FileEditorPresenceSupplier`), which disconnects properly; only the global room is unconditional.
- **Plugin runs still expose one content field.** `plugins.list_recent_runs` now drops a run's file
  name, path, content type and size unless the caller also holds `content.read`, so a custom role
  carrying only `workspace.plugins.manage` sees run status without file identity. Nothing else on the
  plugin surface takes the content check yet.
- **File and folder ACL.** `files_nodes.restrictedScopeNodeId` is read by the checker but nothing
  writes it, so it is always unset and every node inherits workspace access. The whole
  `content.permissions.manage` surface arrives with that milestone.
- **No listing surface filters per node.** `list_tree`, `list_children`, `list_subtree`,
  `search_paths`, `text_search_files`, `files_metadata.search`, `files_metadata.get_by_path` and
  `activities.list_recent` gate on
  workspace `content.read` and then return every node they find. `activities.list_recent` belongs on
  this list because its rows carry `targets[].path`, so it leaks file paths the same way — the
  neighbouring `plugins.list_recent_runs` bullet already drops a run's file details for exactly that
  reason. There is no
  `filter_readable_file_nodes` helper and no `visibilityUserId` argument anywhere yet. Deferred on
  purpose: with nothing writing `restrictedScopeNodeId`, every one of those filters is a no-op today,
  and the internal ones are reached only from the still-unguarded bash surface. They must land in the
  same change that first writes a restricted scope, or a restricted node's name and path leak through
  every list and search.
- **Nothing proves a shared tenant before naming a user.** `users.get_anagraphic` requires an
  identity and hides other people's email, but any signed-in caller still turns any `users` id into a
  display name and avatar. Closing that needs a relationship check the query has no argument for
  today, and the same rule would have to reach `presence.listRoom`.

# Public access

Public grant docs are capability-like access, not membership.

- Check them only on flows that intentionally support link or public access.
- `allowPublic` must be explicit at the call site. Never default public write on.
- For an anonymous user, prefer `principalKind: "user"` with their Convex `users` id over `public`.

Anonymous upgrade semantics live in `../auth-system/SKILL.md`.

# Load the skill that owns each adjacent rule

- `../organizations-tenancy/SKILL.md` — membership, invitations, tenant deletion lifecycle.
- `../quotas/SKILL.md` — `extra_organizations` quota on create, delete, and ownership transfer.
- `../auth-system/SKILL.md` — identity, anonymous upgrade, account deletion.
- `../convex/SKILL.md` — handler, validator, `Result`, and testing conventions.

# Implementation files

- `packages/app/convex/access_control.ts`
- `packages/app/shared/access-control.ts`
- `packages/app/convex/schema.ts`
- `packages/app/convex/organizations.ts`
- `packages/app/convex/data_deletion.ts`
- `packages/app/convex/access_control.test.ts`
- `packages/app/convex/organizations.test.ts`
- `packages/app/convex/data_deletion.test.ts`
