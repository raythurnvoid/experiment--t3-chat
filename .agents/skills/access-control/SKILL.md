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
     ordinary ACL ownership before it reads any assignment. Plugin run-as consent has no owner
     shortcut. There is no `owner` role, and owners hold **no
     assignment doc** — you may rely on that. Both writers enforce it:
     `invite_user_to_organization_workspace` skips the assignment when the invitee is the owner, and
     ownership transfer deletes the new owner's assignments everywhere. The invite guard is
     load-bearing rather than defensive: its membership insert is conditional while the assignment
     write is not, so inviting the owner into a workspace they are not in would otherwise leave a
     stray `member` row on the default workspace and quietly falsify this invariant.
  2. **Role** — one `access_control_role_assignments` doc per `(organizationId, workspaceId, userId)`.
  3. **Direct grant** — an `access_control_permission_grants` doc for file sharing, private plugin
     scopes, or an exact plugin setup/management list.
- Grants are allow-only. There are no deny grants.
- A file's write policy is separate from ACL. Check the actor and any service account first.
  Then apply that node's own `writePolicy`. Owners do not bypass a
  read-only or named-writer policy. See `../files-read-only/SKILL.md` for the policy rules.
- Changing a folder's write policy needs `content.permissions.manage` on that folder only. A hidden
  restricted child keeps its own rule, but the folder's rule still blocks its rename and move-out.
- Human/role sharing changes detach the node's `plugins_file_access_bindings` only when they
  change sharing. Service-account grant edits preserve that reader binding. Unrestricting clears
  human/role grants and keeps independent service grants at their stored node.
- Plugin reader refreshes preserve service-account grants. Editable metadata and plugin names
  never grant authority.
- Plugin-managed file grants may carry `externalPluginMembershipLifetime`. The human grant
  lookup reads `organizations_membership_lifetimes` and accepts that grant only while its lifetime is active. Removing
  and reinviting an account does not restore its old private Files access. A real manual sharing
  change detaches `plugins_external_file_bindings` and clears these tags on remaining grants.
  Account grant edits and uninstall preserve the tags; old untagged grants keep their rules.
  A role change that removes workspace content access does not remove a separate Files
  grant while workspace membership remains active and the file grant still exists. Files grants are allow-only.
  An attached external binding with 50 tagged human readers reserves one additional slot for its
  own live installation account. Normal Files management and grant ceilings still apply. Other
  accounts and a 51st human stay refused. Manual detachment restores the normal cap and keeps
  existing grants; it does not remove an account that was already granted access.
  If an external service cannot commit after its Files readers were applied, public
  `/api/v1/files/plugin-access/undo` may restore the saved previous readers without the lost sponsor ACL.
  It requires the original reader receipt or operation ID and bearer proof, plus live
  installation/version/account/service checks. Restoring applied readers checks the exact attached
  revision and writer generation. An unapplied operation may be cancelled without changing readers.
  Only current membership lifetimes are restored. Manual or newer sharing is never overwritten,
  and account grants stay independent.

## Access changes for external services

`access_control_changes.ts` owns the ordered access ledger and its head. Role changes, ownership
transfer, service account changes, member changes, session revocation, installation changes, and
tenant deletion append scoped facts in the same transaction as their source writes. Calls from one
mutation must be sequential so they share one ordered counter. Press has no named plugin consumer
or remote wait in this path.

The public member and access-change APIs use `plugins_service_connections`. A live connection needs
the exact registration, installation version, service account, and accepted member capability.
An old or removed connection gets control events only. Another plugin's secret never authenticates
that connection. A valid page identity exchange is the only way to update its pins.

Plugin backends apply these facts and enforce their own access lease, which lasts at most 30 seconds.
They own their private groups and live queries. Press owns workspace membership, Files grants,
and `organizations_membership_lifetimes`. See [external plugin identity](../auth-system/SKILL.md#identity-for-external-plugin-backends).

## Paged media validation

`files_media_validation.ts` keeps small organization and workspace version docs. Copy and Save
pin both doc identity and revision, plus the owner's pending version. These are validation tokens,
not permission caches. Final publication still checks current access.

- Organization role assignments, custom permission changes, role deletion, and ownership changes
  advance the organization version in the same transaction.
- Human/role file grants, root restriction, membership lifetime, saved media, placement, and write
  policy changes advance the workspace version. Unchanged or refused writes do not advance it.
- Plugin mirrored human readers follow the same rule, including rollback and empty-reader root
  restriction. Store-only changes and independent service-account grants are not human media access.
- Purge fencing invalidates proofs before docs are removed. A removed version doc also invalidates
  its proof. Never recreate a missing doc while checking an old proof.

When adding a writer, check both Copy adoption and final Save. See the pending and transfer specs.

## Service accounts

Service accounts are workspace identities for software. They are not users and have no roles,
owner rights, billing rights, public fallback, or private plugin-data scope rights. Their
`createdBy` field is audit data, not authority.

- `access_control_db_has_permission` accepts either the existing user/public input or an exclusive
  `serviceAccountId`. The account branch runs before the human owner shortcut. It requires an
  active same-tenant account and its own content grant.
- Workspace grants cover unrestricted content. An unrestricted file/folder grant covers that
  exact node, not its descendants. Restricted content requires a grant at the nearest live
  restricted scope. A workspace grant never crosses that boundary.
- Delegated requests require both the human actor and account check on the actual resource.
  Credentials, capabilities, source limits, and write policies remain separate limits. Do not
  require workspace-wide account access before a file check: an account may have only one
  restricted-folder grant.
- `access_control_db_filter_readable_file_nodes` and `access_control_db_can_act_on_file_node`
  accept optional `serviceAccountId`. When present, they intersect both checks, including for
  owner and unrestricted nodes. Their loaded node inputs include `_id`.
- Any active workspace member may list/get active account labels for pickers. Revoked accounts
  and grant pages require `workspace.service_accounts.manage`. This permission is in the existing
  catalog and admin role. Personal/default workspaces support accounts.
- Create, rename, revoke, account binding, and grant management require that permission. Names
  are trimmed, nonempty, and at most `access_control_MAX_SERVICE_ACCOUNT_NAME_LENGTH` (80).
  Creating an account gives no grants or credentials.
- Grant edits also require the actor's `content.permissions.manage` on the actual resource.
  Every added level permission must already be held by that actor there. File-only managers
  do not need workspace content management. Removal checks management but gives no new level.
- Account controls, the service-account sharing branch, and explicit plugin setup reuse
  `access_control_db_authorize_service_account_grant` and
  `access_control_db_set_service_account_grant`. The latter edits only the account's three
  content docs and keeps the existing 50-principal file-sharing bound.
- Account grant pages paginate `content.read` docs (one per valid resource level) and read each
  resource's remaining docs. Names/paths are hidden unless the actor can read that resource.
  The management-state query works before a grant exists and resolves a selected restricted child
  to its actual scope. Removal still addresses the original stored ID if a later move made that
  exact-node grant ineffective.
- Revoke is idempotent and retains the account, grants, policies, and plugin bindings. Every live
  authorization refuses the revoked account. There is no restore or delete door. Tenant purge
  drains grants, bindings, then accounts through the existing bounded cleanup passes.

An allowed plugin installer may create an empty identity for a fresh trusted tuple. It gives no
file grants. Choosing an account, adding grants, or reusing a retained binding after uninstall
still needs account management. Install/update grants are explicit input, with at most 20 resources and the same actor
ceiling. Omitted grants stay unchanged. Updates, ensure calls, and reinstall never recreate grants
or reactivate an account. Explicit installation rebind changes only its trusted tuple binding and
installation pin. It does not move policies, copy grants, or rewrite old run/session/grant pins.
`plugins_db_get_live_service_account` checks the active account, saved pin, current version, and
exact publisher/source tuple without repairing them.

## Where a role binds

Two names, used everywhere in this subsystem. Nothing else should be called "extra" or "elevation".

- An assignment on `organization.defaultWorkspaceId` is the **organization role**. It reaches every
  workspace the user is an active member of.
- An assignment on any other workspace is a **workspace role**. It works in that workspace only, and
  it can only add: a weaker workspace role cannot take anything away. `set_user_role` refuses one
  that would change nothing, and takes `role: null` to remove the workspace role instead. Without
  that revoke the two guards deadlock: no weaker role is accepted, and `delete_role` refuses while
  it is held.
- A permission's `scope` in the catalog decides how far it reaches:
  - `scope: "organization"` binds only from the default-workspace assignment.
  - `scope: "workspace"` binds at the workspace the assignment sits on. The checker does not test
    membership there — the caller already proved it. Membership **is** tested when a workspace-scoped
    permission arrives from the organization role, because that role reaches workspaces the user
    may not belong to.

## Roles

- **System roles** are `admin`, `member`, `viewer`. They live in code in
  `access_control_SYSTEM_ROLE_MATRIX`, not in the database. No seeding, no migration when the matrix
  changes, and nobody can edit them.
  - `admin` — all catalog permissions except `organization.billing.manage` and
    `organization.integrations_policy.manage`. Plugin setup and management use exact access lists.
  - `member` — `workspace.create`, `workspace.update`, `content.read`, `content.write`,
    `workspace.browser.use`, `workspace.mcp.use`.
  - `viewer` — `content.read` only.
- **Custom roles** are `access_control_roles` docs, organization-wide, capped per organization by
  `MAX_CUSTOM_ROLES` in `convex/access_control.ts`. Users compose them from the fixed permission
  catalog; they can never invent a permission.
- **Edit includes view.** A custom role with `content.write` or `content.permissions.manage` must
  also have `content.read`. `validate_role_permissions` refuses any other list, for both
  `create_role` and `update_role`, with `"<label>" needs "View workspace content"`. Why: somebody
  who can edit but not read could put an open file they cannot read into a document that has a
  public link, and the link would show that file (see "Public file links"). The role editor keeps
  its checkboxes in a valid state: checking Edit or Manage file sharing also checks View, and
  unchecking View also unchecks both. The server rule is the real guard. System roles and file
  share levels already follow this rule. A custom role without Edit or Manage may still leave out
  View.
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
`thread` | `plugin_scope` | `plugin_installation`), `resourceId` (stringified id), `principalKind`
(`role` | `user` | `public` | `service_account`), optional `userId`, optional `role`, optional
`serviceAccountId`, `permission`, `createdAt`, `updatedAt`. A run-as grant also pins the user's
membership id, lifetime and API scopes in `runAs`.

`files_sharing.ts`, `plugins_data.ts`, service account doors, and `plugins_access.ts` write grants.
System role permissions live in code. File shares use one doc per permission per principal, with
the **restricted scope node** as `resourceId`. Plugin setup uses the exact workspace; plugin
management uses the exact installation. Nothing writes a `public` grant, and the share validator
has no `public` arm.

The declarative access bindings (`plugins_file_access_bindings` in `plugins_data.ts`) are the
host-maintained file-grant mirror: a plugin binds one of its owned nodes to one of its private scopes
(`access.readScopeId` on the plugin file doors), and the host restricts the node and keeps exactly one
`content.read` grant per scope member on it — at most 4 bound nodes per scope, readers bounded by the
50-person scope cap. BOTH directions are synchronous inside
`user_manage_scope` (`db_sync_file_access_bindings`): no file write interleaves, so adds
do not wait for a sync, and a removed member loses the bound files in the same transaction. The
mirror hands out only `content.read` (a file `manage` grant would let a channel manager unrestrict or
re-share the node). Scope deletion and stranded-scope cleanup (`cleanup_stranded_scopes`, after
account or organization teardown empties a scope) delete the mirrored grants and the binding rows; the
node stays restricted, so nothing widens when the readers go away. Uninstall drains only the binding
rows and leaves the mirrored grants with their files — member removal and workspace purge find those
grants through their own tenant indexes. The organization owner still reads
everything. Plugins never name users — the only principal input is a scope id.

`plugins_data.user_manage_scope` writes the `plugin_scope` grants. `resourceId` is
`"<installationId>:<scopeId>"` — the installation is part of it because two installations may mint the
same scope id, and a grant must never cross from one to the other. Two levels, one doc per permission:
`member` gets `content.read` and `content.write`, `manage` adds `content.permissions.manage`.
Any principal may leave. The same mutation ignores deleted and inactive members, then promotes the
remaining active user with the lowest stable ID when no active manager would remain. If no active user
remains, it releases the scope. Bounded member-removal cleanup applies the same repair after each grant
batch. This keeps the scope repairable without blocking a member from leaving.

`plugins_data.watch_my_scopes` reads those grants back the other way, so a member can find the private
ranges they are in. It walks the caller's own grants on `by_user_organization_workspace_resource_permission`,
keeps the ones whose `resourceId` starts with this installation's id, and folds the per-permission docs
back into one level per scope, with `manage` winning. It is the only listing, and it follows the grant
rather than the workspace: the organization owner may read every scope through the owner short-circuit,
but an owner who holds no grant is listed nothing.

**Private plugin-scope grants name users, never roles.** A role would give its private data to
everyone holding that role. Plugin management lists may name roles. Role deletion refuses while
any grant still names the role and tells the user whether it is used by Files or a plugin list.
Role assignment, editing and invitations check both kinds of grant before giving new access.

Pick the index that matches the principal kind:

- `by_organization_workspace_resource_role_permission`
- `by_organization_workspace_resource_user_permission`
- `by_organization_workspace_resource_public_permission`
- `by_organization_user_workspace_resource_permission`
- `by_user_organization_workspace_resource_permission`
- `by_user_org_workspace_kind_principal_permission_resource` — count one `content.read` doc per private scope for the member cap.
- `by_organization_role_workspace_resource` — every grant that names one role (`delete_role`).

## Plugin setup and management

`plugins_access.ts` owns access settings. New workspaces start Owner only. New installations use
Selected; a non-owner installer gets a direct grant to that installation. The owner always manages
it without a redundant grant. `installedBy` is history and gives no access.

- Owner only (`owner`): clear management grants; only the organization owner manages.
- Selected (`selected`): the owner plus named active users and roles manage.
- Everybody (`workspace`): every active workspace member manages. Removing a name from its
  retained list does not exclude that person.

Only the owner changes workspace setup access. An exact installation manager changes that
installation's management list. Both doors prove a live user, owned membership, real tenant and
no workspace purge fence. Validate the whole list before writes. Cap each list at 50 principals
and each role at 50 distinct plugin lists in the organization.

Adding or assigning a role cannot give more file or plugin access than the caller has. Everybody
lists add no extra authority to a current member. Files counts filter file grants before applying
their read bound, so plugin grants do not use file-sharing slots. Management edits preserve
independent run-as grants.

The public catalog returns safe version facts to active members and separate `canInstall` and
`canManage` flags. `canInstall` means a fresh install is allowed. `list_installations` returns only
exactly managed installations. YAML, secrets, health, storage and run details stay behind that
installation's management check. `organizations.list` is role display data and must not gate
these plugin lists.

# Permission catalog

Plugin setup and management use `workspace.plugins.manage` as a grant-only permission. It is absent
from the role editor. Exact plugin access modes and grants decide it. Broad roles cannot bypass them.

`plugin.run_as` is a grant-only permission. It is absent from the role editor. The checker accepts
only the exact user's direct installation grant with its live membership id and lifetime. An owner
or role cannot grant another person's consent.

`plugins_access.grant_run_as_me` validates all proposed scopes before replacing the caller's grant.
Files scope consent needs a readable workspace or saved file/folder; the proof grants no extra Files
access. Other scopes check the caller's live workspace or exact installation rights. Selection uses
only a live direct grant. Every scheduled operation intersects that consent with accepted capabilities
and the user's current access. A membership removal or authority change cancels active chains in the
same transaction, even before the external change feed starts. Rejoin needs fresh consent.

`packages/app/shared/access-control.ts` holds ordinary role permissions with their `label`, `description`,
`group` and `scope`. The checker and role editor use it for role permissions. Grant-only consent
uses the separate check above.

| Permission | Scope |
| --- | --- |
| `organization.update` | organization |
| `organization.members.manage` | organization |
| `organization.roles.manage` | organization |
| `organization.billing.manage` | organization |
| `organization.integrations_policy.manage` | organization |
| `workspace.create` | organization |
| `workspace.update` | workspace |
| `workspace.delete` | workspace |
| `workspace.members.manage` | workspace |
| `content.read` | workspace |
| `content.write` | workspace |
| `content.permissions.manage` | workspace |
| `workspace.browser.use` | workspace |
| `workspace.mcp.use` | workspace |

`workspace.browser.use` ("Use the web browser") lets a member open the cloud browser in web mode,
where it can visit any public address. `admin` and `member` have it. `viewer` does not. File mode
(showing a workspace file) does not need it; file mode only needs file access.
`browser_db_authorize_web_use` in `convex/files_browser.ts` checks it. That helper first checks the
`AI_CHAT_BROWSER_ENABLED` flag and returns `Browser unavailable` when the flag is off. The check runs
at start, in `authorize_live_browser_session` (reload, keep open, viewer grant and renew, take
control, resume, agent access, save download, file-chooser fill, upload grant), in the agent's
`check_browser_session_access`, in `current_browser_session`, `web_browser_available`,
`set_browser_agent_blocked_hosts`, on every agent file output from a web session, and in the
5-minute cron `close_web_browser_sessions_without_access`. The saved-data doors
(`list_browser_profile_sites`, `clear_browser_profile_site`, `clear_browser_profile`) do not need
it: a user may always see and delete their own data. If a live session loses the permission, the
server closes it with `end_browser_session_internal` and does not save the browser profile.

`workspace.mcp.use` ("Use MCP servers") lets the member's agent chats in this workspace call the tools
of MCP servers. `admin` and `member` have it. `viewer` does not. The chat route checks it before it
loads any MCP tool for a turn (`/api/chat` in `convex/ai_chat.ts`), and `plugins_mcp.recheck_call`
checks it again right before each tool call, so a member who loses it mid-reply is refused with
"You cannot use MCP servers in this workspace." Ask mode never loads MCP tools, whatever the role.
The "MCP servers" page (`convex/mcp_custom_servers.ts`) needs it to add, edit, test, or turn on the
member's own servers. Starting an MCP sign-in (`plugins_mcp_oauth.start`) needs it too, and the
check runs again before the pending sign-in and the grant are written, because the sign-in waits on
outside servers between steps. Like the web browser's saved data, a member who lost it can still list, turn off,
and delete their own servers and disconnect their own sign-ins (`plugins_mcp_oauth.disconnect`). Each
member sees only their own servers; another member's server id answers "Not found".

`organization.integrations_policy.manage` ("Manage plugins and MCP servers") lets a holder change
which plugins and member-added MCP servers the organization allows. No system role has it, like
`organization.billing.manage`: the owner holds it by ownership and can give it through a custom role.
`organizations_integration_policy.update_policy`, `get_policy` (full view), and the two candidate
lists check it at the organization's default workspace, after checking an active membership there. See `../organizations-tenancy/SKILL.md`,
"Plugins and MCP servers policy".

Inviting someone as `member` also hands out `workspace.browser.use` and `workspace.mcp.use`. The invite ceiling still
applies: an inviter who lacks it cannot invite someone as `member`.

Rule: **every permission in the catalog must be enforced somewhere**, or be marked
`enforcedBy: "file-sharing"`. A permission the role editor offers that nothing checks is a switch
that silently does nothing. `access_control_ENFORCED_PERMISSIONS` filters the marked ones out, and
`create_role` / `update_role` refuse them. **Nothing carries the mark today**:
`content.permissions.manage` was the last one, and file sharing now enforces it on every share
change. A test asserts the two lists are equal, so adding a mark without an enforcement fails.

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

**Every handler that names a node passes it now.** The snapshot family, the structural mutations, the
pending-update family and the yjs handlers all ask about the node. Three shapes are in use, and a new
handler should copy whichever fits:

- `access_control_db_authorize_membership(..., { fileNode })` when the node is already loaded.
- `access_control_db_authorize_node(..., { nodeId })` when it is not — it loads and checks in one call.
- `authorize_file_write(ctx, { nodeId })` in `files_nodes.ts` for a **write target**, where `nodeId`
  is the node itself for a change to an existing node, or the parent folder for a new node or a move
  destination. `files_ROOT_ID` falls back to the workspace. An action cannot read the database, so
  actions ask the same question through the `get_current_user_file_write_permission` query.

Rules that are easy to miss, all of which were real holes:

- **A write has three legs when it moves something.** `move_nodes`, path-like `rename_node`, and `apply_file_pending_move`
  check the destination *and* the node. Checking only one lets a grant on a single folder push files
  into a restricted folder. The third leg is `authorize_leaving_restricted_scope` in `files_nodes.ts`:
  taking a node out of the restricted folder it sits in changes who can read it, so it takes
  `content.permissions.manage` on that folder, not `content.write`. A folder that is the restricted
  scope itself carries its scope along and is not asked. Rename resolves paths from the node's own
  parent, then uses `files_nodes_db_preflight_move` and `files_nodes_db_apply_move`. The shared core
  checks the current and final scopes before writing. A name-only rename in the same saved parent
  needs the source grant. Reparenting or creating missing folders also needs destination write.
  `unarchive_nodes` restores a node to a new parent when its own parent is still archived, so it is a
  move and asks the same questions. It skips both of them for a node that is its own restricted
  scope, and that skip is deliberate — reviewers keep reporting it. The destination there is picked
  by this code, not by the caller, and a node carrying its own scope stays closed wherever it lands,
  so the move opens it to nobody; refusing would strand the folder where only its share list can see
  it. A node that only *inherits* a restriction does lose it at the root, so that one is asked both
  questions: the destination write and the leaving check. Asking only the first was a real hole — a
  write grant on a folder was enough to archive it and then restore one file out of it, which handed
  that file to the whole workspace while `move_nodes` refused the identical move. Every case here has
  a test in `access_control.test.ts`.
- **A mutation an action calls proves its own permission.** Only a check inside the writing mutation
  runs in the same transaction as the write; a check in the action is advisory, because a role taken
  away in between still lands the write. So an internal mutation reached from an action asks again,
  in itself — `create_file_node` and `create_folder_node_by_path` both do. A mutation called by
  another mutation does not: it already runs inside the caller's transaction. Watch the brand-new
  path in particular: the node walk only checks nodes that already exist, so when nothing is there
  yet the workspace is the only thing left to ask.
- **A cascade is not covered by the node you named.** `archive_nodes` and `move_nodes` check
  `content.write` on each distinct restricted scope in their affected descendants, once per scope.
  The archive job's check walk reads every descendant by `parentId` before the first stamp. A move
  reads no ordinary descendant: preflight finds the restricted folders inside a reparented folder by
  their stored `treePath` (`isRestrictedScopeRoot: true`, archived ones too) and asks each one for
  write access. A hidden restricted child can refuse the whole move with `Permission denied`, without
  exposing its name. While a move op runs, a child can still store an old `treePath`. So preflight
  also looks under the old and new paths of each running move op, and keeps only restricted folders
  whose live `parentId` chain leads to the moved folder. While a scope op or a move op runs, a child
  can still store an old `restrictedScopeNodeId`. So preflight reads the scope of each item it checks
  from its live parents instead (the nearest folder that is its own restricted root): the moved items,
  the item in the way, and the items inside a folder it replaces. Every check of the move uses that
  scope: source, destination, content write, service account, and Can manage. So do the checks
  `rename_node` makes before the preflight. Otherwise an item could leave a folder that was just
  restricted, or a folder just moved into a restricted one, without the check. Once out, the op never
  reaches it, so it would stay open for good. For these checks, a child of an inner folder that was
  just unrestricted is under the outer restricted folder at once, even while it still stores the inner
  folder.
  A move that keeps the same parent and path does not change descendants. A
  name-only rename in the same saved parent carries nested shares without asking for write access to
  each one. Reparenting through Rename uses the same nested-scope checks as other moves.
- **Every refusal comes before the first write.** A Convex mutation that returns normally commits, so
  a `Result({ _nay })` after a write keeps that write and reports failure at the same time. Ask every
  question first. `create_upload_node` shows the shape: a filename may carry path segments, so it
  walks the folders between `parentId` and the file before it archives the old file or inserts the
  asset doc, because the create below it would otherwise refuse after both writes landed. When the
  failing step is an internal invariant rather than a question the caller can answer — Markdown that
  will not chunk, a Yjs doc that will not serialize — `throw should_never_happen(...)` instead, so the
  transaction rolls back. `restore_snapshot` (`files_nodes_content.ts`) and
  `save_file_pending_update_in_db` (`files_pending_updates.ts`) both do this; returning
  there left a file with no committed text, or content published and billed with the pending doc still
  showing unsaved changes.

For listings, use `access_control_db_filter_readable_file_nodes`. For **file content and exact
statistics**, the check lives inside the five readers that resolve a node and then answer from it:
`read_file_content_from_chunks`, `get_file_text_content_db_state_by_path`,
`db_resolve_committed_chunk_source`, `match_text_file_lines`, and
`match_plain_text_file_lines`. The stats reader returns no text, but exact line, word and byte counts
still reveal a file. Every bash command, AI tool and public API read route that answers with text or
stats reaches one of these readers, sometimes through a second function: `/api/v1/files/read` calls
`get_file_last_available_text_content_by_path`, which asks `get_file_text_content_db_state_by_path`. A
check in each of those callers would be a check waiting to be forgotten. Asset bytes are the one
exception, and they touch none of the five. `/api/v1/files/download-urls` signs an R2 URL through
`get_data_for_public_download_url` (`convex/r2.ts`), and that query asks
`access_control_db_filter_readable_file_nodes` about each node itself. Copy that shape for a new route
that answers with bytes. Keep `visibilityUserId` a required argument, so a later caller cannot forget
to pass it. Count the readers before you trust this list: a sixth one added later is a sixth door.

**The public link reader is separate on purpose.** `db_prepare_share_link_view` in
`convex/files_share_links.ts` reads a linked file's committed chunks and media assets for a visitor
with no account. It uses none of the five readers above, because there is no user to check. Its
authority is the link token plus the live checks in "Public file links" below. Both
`get_share_link_view` and the signer `create_share_link_download_urls` go through it. Do not call it
from a member-facing door, and do not add a member reader that skips the five.

**Plugin activities answer to the files they name.** `db_filter_visible_activities` in `convex/activities.ts`
is the one rule, used by `list_page`, `archive_activity` and `archive_all_activities`. One
unreadable target hides the whole activity, because the title usually carries the file's name. A
target whose current path differs from its stored activity path also hides the whole activity: the
stored path, title, target message, and error belong to the old location and cannot be made safe by
current access alone. Both dismiss mutations use the same rule as the feed. Dismissals live in
`activities_user_states`, one per viewer and Activity. A viewer can dismiss a visible finished
Activity without workspace write access. Another viewer's feed is unchanged. Bulk dismiss follows
bounded history pages and must never reach hidden Activities. See the [Activity spec](../activities/SKILL.md).

Clipboard Activity is private to the requester, even from other workspace owners. Current
membership is required. A folder guest can view and stop their own run, and dismiss it after it
finishes, without workspace-wide write permission. These activities contain no file names or paths.
The conflict dialog separately checks current source access before showing either. See
[Files transfer runs](../files-explorer-tree/references/transfer.md#stop-activity-and-cleanup).

**Comments answer to their file.** Every `chat_messages` row carries a required `fileNodeId`, and all
six handlers in `convex/chat_messages.ts` check that node instead of the workspace: `content.write`
to start a thread, reply, or resolve, `content.read` to list or get. A comment quotes the document, so
somebody who may not open a restricted file may not read what was said about it either. Children copy
`fileNodeId` from their root, so one thread always answers to one file. `chat_messages_threads_list`
asks per thread, because the caller passes ids from a file's Tiptap marks and nothing stops them
passing ids from another file.

## The raw checker

`access_control_db_has_permission(ctx, { organizationId, workspaceId, defaultWorkspaceId,
organizationOwnerUserId, resource, permission, userId?, allowPublic? })` is for callers that already
hold the organization doc. It does not fetch anything to validate scope, and it does not prove
membership.

Order, short-circuiting on the first pass:

Before this ordinary ACL order, service accounts use their own grants. Plugin management uses
the exact workspace/installation mode and live membership. Run-as consent uses the direct human
grant and its membership pin. These branches never fall through to ordinary role permissions.

1. owner
2. restricted-file branch — for a `file` resource with a live restricted scope, and it **never falls
   through** to workspace access
2a. plugin-scope branch — for a `plugin_scope` resource. Grant only, and it **never falls through**
   either: the answer is whether this user holds that exact grant on that exact scope, and a role's own
   permissions give nothing. Without this branch the check would fall through to step 5, where both
   `member` and `viewer` hold `content.read` — so it would answer `true` for every member and a
   "private" channel would be readable by the whole workspace. Adding the resource kind without the
   branch is worse than adding nothing, because it looks like a check.
3. exact direct user grant
4. exact public grant, only when `allowPublic` is passed
5. role at the target workspace — skipped for an `organization`-scoped permission unless that
   workspace *is* the default one
6. role from the default workspace — an `organization`-scoped permission binds outright; a
   `workspace`-scoped one only if the user is an active member of the target workspace

A grant that governs a restricted subtree carries the **restricted scope node** as its `resourceId`,
never the accessed node. When a node has no scope the check still looks for a grant on the node itself
before falling back to the caller's role; no `workspace`-resource grant is ever consulted for a file,
and sharing only ever writes grants on a restricted node, so that lookup misses for everything else.

**Step 1 comes before every grant lookup, and a plugin scope inherits that.** The organization owner
reads every private channel and every private direct message in the workspace, with no grant and no
audit trail, and no revocation can take it away. That is deliberate — it mirrors the file rule rather
than inventing a second one — but a plugin whose UI says "private" has to say this too, or the feature
is a disclosure. This rule concerns Press plugin-store scopes. A plugin's separate database owns
its own group rules and must document them in that plugin's repository.

The consequence that matters most: **inside a restricted subtree a role's permissions grant
nothing.** `has_restricted_file_permission` consults user grants, public
grants, and grant docs that name a role — never the role's own permission set. So a non-owner admin is
locked out of a restricted file unless a grant names them or a role they hold. Only the owner bypasses
it.

## Effective permissions

`access_control_db_resolve_effective_permissions` returns the whole set (or `"all"` for the owner).
Use it when one handler needs several answers, such as comparing what a caller may hand out.

It reads roles only and **ignores direct grants** on purpose. Every ceiling in the subsystem compares
through it, so a grant can never widen what a caller may hand out. Keep it that way. File sharing has
its own ceiling, `caller_can_hand_out_level`, which asks against the node instead, because a manager
of a restricted folder has to be able to share what the grant gave them and nothing more.

## Conventions

- Rate limit first, permission second, in new handlers. A denied call still costs a token, so
  permission probing is not free. Two sets of exceptions exist, both deliberate:
  the internal `ai_chat.thread_run_begin`, which charges only for request messages it has not
  saved yet, so its cost depends on a prior read; and the older
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
- Discarding the caller's exact existing pending draft is a deliberate write exception. It gives
  nobody access, so content and structural discard remain available after `content.write` is taken
  away. General pending upserts and every accept/save path still require current write access.
- Nobody may hand out more than they hold. `create_role`, `update_role`, `delete_role`,
  `set_user_role` and `invite_user_to_organization_workspace` all compare the target role's
  permissions against the caller's own set. Without this an admin mints a custom role above itself.
  The rule forbids **escalation, not destruction**. Revoking takes no ceiling: it hands out nothing,
  and it can only return the target to their organization role, so it never reaches past the
  caller's own level and never drops anyone below the floor every member stands on. Nor do
  `set_user_role` demoting someone out of a strong role, or
  `organizations.remove_user_from_organization`, which has no ceiling at all — an admin can strip a
  billing-only role from its holder even though `delete_role` refuses to delete that role. Not a
  contradiction: `delete_role`'s ceiling protects the role **definition**, which nobody can restore
  once it is gone, while a demotion or removal is undone by the owner in a click. Do not read the
  `delete_role` refusal as "this authority cannot be taken away".
  For a default-workspace assignment, the file-grant half of this ceiling scans only the target's
  current active workspaces. The organization role reaches files only where that target is also a
  member; a share in an unrelated workspace must not block the assignment. Role edit/delete checks
  still scan the whole organization because they can affect current holders in every workspace.
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
- Chat threads are private to their creator. Every read and change also needs current workspace
  `content.read` (`THREAD_PERMISSION` in `ai_chat.ts`). Team owners, admins, and writers have no
  override. Lists and branch title numbering use a creator-filtered index. Direct reads return
  null for another creator's thread. Mark-read changes only the creator's private read cursor.
  A viewer can manage its own chats; file writes still need their separate file permissions.

## Known gaps

These are real and confirmed against the code. None is an oversight to patch quietly: each needs a
product decision, so record the answer here before changing the behaviour. An entry that starts with
**Decided** already has its answer. Do not report it again as a finding.

- **The public API refuses a grant-only user.** Each file scope maps to an app permission, which
  `has_workspace_content_permission` answers about the *workspace*.
  Somebody whose only access is a direct grant on one restricted file gets 403 before any per-file
  check, so their API key cannot use the grant the UI honours. This is under-permission, not a leak.
- **An outgoing owner keeps nothing.** The owner holds no grant docs anywhere — `restrict_node` skips
  the self-grant for them on purpose — and `transfer_organization_ownership` gives them the `member`
  role. A role gives nothing inside a restricted scope, so the moment they hand the organization over
  they lose every folder they restricted, and only the new owner can let them back in.
- **Decided: archiving a restricted folder stays at `content.write`.** A `write` grantee can archive
  the restricted folder itself, not only what is inside it, and that is intentional. They could
  already archive every child one by one — `archive_nodes` checks `content.write` per node on purpose
  — so refusing them the folder would mean "you may empty the room but not close the door". Archiving
  discloses nothing and changes nobody's read set. Leaving a restricted scope is the separate
  question, and `content.permissions.manage` guards that in `move_nodes` and `unarchive_nodes`.
  Recovery is real, not theoretical: `list_tree_children` with `archived: true` lists a folder's
  archived children, `access_control_db_filter_readable_file_nodes` lets the owner read everything,
  and the sidebar has a "Show archived items" toggle whose rows carry a Restore action. Known property, not a bug: while
  the folder sits in the archive nobody can open its share dialog, so restore it first to manage
  sharing.
- **Removing a member drains direct grants in bounded passes.** `remove_user_from_organization`
  deletes the first indexed batch and writes `pendingOrganizationRemoval: true` while making the
  member's memberships inactive when more grants remain. A scheduled continuation drains the rest
  before deleting only those marked memberships. A repeated self-leave reads this marker before its
  active-membership guard and restarts the continuation. Invite does the same but refuses while the
  marker remains, so a lost job or quick re-invite cannot restore grants that have not been deleted yet.
  The other member cleanup stays in the first mutation and is bounded by existing tenant and token caps.
- **A batch download re-checks the bearer, not every file.** `/api/v1/files/download-urls` reads each
  node through `get_data_for_public_download_url`, which filters per node, then materializes, then
  re-resolves the principal before signing. The re-resolve is a workspace question, and only the nodes
  that were materialized are read again. A per-file grant revoked during a slow materialization is
  therefore still signed for the other files in the same batch.
- **A `plugin_ui` file-view token is not scoped to its file.** `mint_file_view_session` stores
  `fileNodeId` on the session (`plugins_ui.ts`), but `resolve_principal` never carries it into the
  principal (`public_api.ts`), so the token reaches files list/read/download for everything the
  minting user may read, gated only by the install-time `workspace.files.read` capability. Confirmed
  in the browser on 2026-08-02: a token minted for `/speakers.mp4` returned 404 for that file and
  **200 with full content** for `/README.md`. This is bounded by the minting user's own authority, so
  it is not a privilege leak — but `plugin_run` **is** pinned to its `sourceFileNodeId`, and that
  asymmetry plus the stored-but-ignored field is undecided. Do not "fix" it silently either way.
- **`github_mounts` never checks that a mounted repo is public.** `github_fetch_repo_head` parses only
  `default_branch` and never `private`/`visibility`, while `github_headers` attaches
  `GITHUB_TOKEN_IMPORT` to every request including codeload. Mount content lands in the reserved
  `GLOBAL`/`GITHUB` scope, which every user with the bash tool reads at `/.mounts/<name>` with no
  per-user check, so the only thing keeping private source out of a world-readable scope is how that
  token happens to be scoped. `upsert_mount` is an internal mutation reached by `convex run`, so no
  user can trigger it and this is not a user-reachable hole. Whether to refuse a `private` repo
  outright is undecided.

# Endpoints

## Roles

- `list_roles({ organizationId })` — any member with an active membership on the **default**
  workspace; `[]` when not one. `assignmentCount` counts assignment **docs, not people** — UI copy has
  to say "assignments". It saturates at `MAX_ROLE_ASSIGNMENT_COUNT`, includes holders in retention, and
  counts a workspace role separately, so it can exceed the number of people who actually
  have to be moved before a delete.
- `create_role`, `update_role`, `delete_role` — need `organization.roles.manage`. `delete_role` refuses
  while any holder with an active membership still has the role, and refuses above the assignment cap
  rather than deleting a partial page. An assignment whose holder has no active membership **at that
  assignment's own workspace** is the exception, and is demoted instead: default-workspace rows drop to
  `viewer`, workspace role rows are deleted. That demotion is a role hand-out like any other, so it
  takes the same ceiling — the delete is refused when the caller cannot hand out what `viewer` grants,
  which is reachable because a role without Edit or Manage may leave out `content.read`. Full reasoning
  lives in the code comment above the demotion.

## Assignment

- `set_user_role({ organizationId, workspaceId, userId, role })` — needs
  `organization.members.manage`, or `workspace.members.manage` **plus** the caller's own active
  membership at that workspace and a workspace that is not the default one. Three refusals fire before
  that disjunction, and each is a state the UI has to render: the caller needs an active membership on
  the **default** workspace whatever their permissions; the target may never be the owner; and the
  target needs an active membership at the workspace being changed. `role: null` revokes a
  workspace role; at the default workspace it is refused, because every member needs an
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
  `member`. It also gives the new owner a membership in every workspace they were not in, through
  `access_control_db_ensure_owner_memberships`. The owner must be a member of every workspace (see
  `../organizations-tenancy/SKILL.md#owner-is-a-member-of-every-workspace`).

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
  query. Same-workspace callers use `users.get_workspace_member_anagraphic`, which
  proves both people are active members of that workspace before it returns the address. The Users
  page is the current caller.

## Files tree reads

The sidebar loads the tree one open folder at a time through four `files_nodes` queries. All of them
resolve the reader with `files_nodes_db_get_tree_reader` and filter every row with
`access_control_db_filter_readable_file_nodes`, so they never show more than `list_tree` does.
`files_share_links.list_workspace_links` resolves its reader with the same helper.

- `files_nodes_db_get_tree_reader` requires a live `users` doc before reading membership. Missing auth or a
  missing user throws `Unauthenticated`. An anonymous user with `deletedAt` does too, even when
  the supplied membership is inactive. The helper keeps the caller's auth kind.
  It returns `null` for an inactive or foreign membership and for every refusal
  except "Permission denied". "Permission denied" means the member has no workspace-wide read, so the
  queries continue in grant-only mode and show only what was shared with them.
- `list_tree_children` pages one kind of child of one folder. A missing, foreign, or hidden parent
  gets the same empty, done page as any other refusal, so the answer does not tell the caller that a
  hidden folder exists. A grant-only member gets nothing for the root: their root rows come from
  `list_tree_shared_roots`.
- `get_tree_ancestors` takes a raw id string, so a bad `?nodeId=` returns `null` instead of an argument
  error. It walks up from the node and stops at the first folder the caller cannot read, because the
  tree cannot show a row under a hidden folder. This hides no names: every tree row carries its
  `path`, `parentId`, and `restrictedScopeNodeId`, the same as `list_tree` rows, so a shared node's
  path still names the hidden folders above it.
- `list_tree_shared_roots` returns restricted scope nodes the member can read while the folder above
  them is hidden. It reads the member's own `content.read` grants and the grants of their workspace
  and organization roles, capped at `TREE_SHARED_ROOTS_MAX_GRANTS` per list, and checks every
  candidate again with the readable filter. The owner gets nothing, because the owner reads the whole
  tree. Known limit: past the cap the query logs a warning and returns `truncated: true`, but the
  sidebar ignores that flag, so a member with more than 500 grants in one list can miss shared roots
  without any sign in the UI.
- `list_tree_children_sorted` (the sorted Files table) uses the same folder gate, and a grant-only
  member gets nothing for the root. It reads only rows with `isRestrictedScopeRoot: false`. Such a
  row shares its folder's restricted scope, so every row in that index range is readable by anybody
  who can read the folder. That is why no row is filtered after paging, and a hidden row never takes
  a page slot or shows its sort value. Rows with `isRestrictedScopeRoot: true` come from
  `list_tree_children_sort_side_rows`, which checks each one with the visible reader (read access
  plus the pending hide rules) and caps them at 200. A grant-only member's root rows come from these
  side rows.
  - A local table filter scans that same readable ordinary range. It never scans hidden nodes and
    then drops them for access. Custom cursors bind the exact membership, folder, kind, segment,
    sort, and filter. They carry the full index suffix, including Created time/id ties.
  - Every page returns `scanBoundary`, `scannedCount`, and `workCount`. Native unfiltered pages
    count raw rows before pending hides and use `workCount: 0`. Custom pages advance only after a
    whole candidate is checked. Rejected readable candidates still advance the boundary.
    Refusals return an empty, done page with a null boundary and zero counts.
  - A sort has one to eight ordered clauses (`files_sort_MAX_CLAUSES`). Multi-sort proves only readable ordinary groups.
    It uses the primary index and a Name range when that index supports the next clause. Other
    groups are limited to 200 candidates, with a 201st probe. Hidden restricted children never
    affect that proof, its cap, cursor, bytes, or work count. Complete groups pack up to 50
    processed candidates. A cumulative budget stop keeps only the completed prefix.
    `sortLimit` reports a real group limit. `workPaused` reports a smaller request allowance that
    cannot prove the next group. Every result carries both fields, including native and refused pages.
  - With one clause, filtered walks spend at most 50 candidate/proof visits per query. Custom walks
    check whole-query bytes and calls with a 4 MiB budget and a 1,000-call budget. They reserve
    1 MiB and 16 calls before another read. The metadata-missing walk keeps both Name streams. Each new field witness is
    joined to its current ordinary node before its position is used. Stale scope fields throw.
    A stopped join keeps the last completed cursor. With one clause, no first progress throws a
    work error.
  - `get_table_filter_match({ membershipId, parentId, target, filter })` checks one side target
    again. It resolves current access, private ownership, visible parent, and metadata readiness.
    It returns `{ matches, preparing }`, or null for refusal or a target no longer visible here.
    Missing auth throws. Read exhaustion throws; it never means false, null, or an absent scalar.
    The side-row list keeps its full unfiltered name claims and both cap flags.
  - Side enumeration has no sort argument and reads no metadata keys. Built-in keys use its
    authorized facts locally. `get_table_sort_key({ membershipId, parentId, target, sort })`
    independently checks current auth, access, visible parent, private owner, and proposal revision.
    It returns one full fresh row key. All built-in and metadata parts come from the same read.
    Private metadata still preparing has null sort parts. Refusal is null; byte/call or visible
    reader exhaustion throws. A refused key cannot revive a held row or remove its current name claim.
  - The owner reads every row, so the owner scans the folder's restricted children by name and gets
    the first 200.
  - A non-owner can read a restricted scope root only through a user or role `content.read` grant
    on it. So a member's candidates come from `db_list_granted_restricted_scope_nodes`, the same
    grant lists `list_tree_shared_roots` reads, kept when their parent is this folder. Scanning the
    folder instead would not scale: a folder of one private folder per person has thousands of
    restricted children, and each visible-reader check costs about 9 to 14 `db.get` and `db.query`
    calls. Convex allows 4,096 such calls per query.
  - A member's cut-off must never depend on a row hidden from them. Otherwise the cut would move
    when a hidden row is added and leak that it exists. A grant doc can outlive the access, for
    example a plugin-tagged grant whose membership ended. So the query walks the candidates in name
    order through the visible reader, skips the ones it refuses, and stops when a 201st row would
    show. The member gets the first 200 readable rows, with `tooManyShared` when there are more.
  - When a grant list passes `TREE_SHARED_ROOTS_MAX_GRANTS` (500), some candidates are missing. Then
    the query scans the folder like the owner path: up to 200 restricted children are all checked,
    and over 200 the member gets none of them, with `tooManyShared`. That answer depends on the
    folder's count of all restricted children, like before this change. No name or order leaks, but
    a member who can add restricted children there can add them one by one and learn that count.
  - Known limit: loading the grant lists costs one `db.get` per grant. Only the user's own list can
    reach 500. A role list holds at most 50 nodes, because `set_node_share_grant` puts a role on at
    most 50 share lists in the organization, and it is the only writer of role grants. So the lists
    cost about 500 plus 50 per role. The walk costs about 9 to 14 calls per candidate
    (a review estimate, not measured). The visible reader's own 4096-read budget counts only part of
    that, so the query can throw at Convex's 4,096-call limit before `exhausted` is set. 200 shown
    rows alone stay under it. It needs extra checks in the same folder: a member with 200 shared rows
    plus about 100 stale grants there, or 200 shared rows plus many pending changes there.
- A folder that the caller can read but that the Files view hides (archived, or hidden by the
  caller's own pending delete or move) gets empty side rows, not a refusal, so the table shows no
  error there.
- `isRestrictedScopeRoot` on `files_nodes` is a stored copy of `restrictedScopeNodeId === _id`, and
  committed metadata field docs carry the same copy. `files_nodes_db_set_restricted_scope` writes
  both whenever a node is restricted or unrestricted. `list_tree_children_sorted` throws
  `should_never_happen` when a returned row is a restricted root, because a stale `false` would
  show a hidden row. The side rows need no such guard: they check every row with the visible reader.
- `files_metadata.list_folder_fields` checks active membership and folder `content.read` before
  listing direct-child committed keys. The root needs workspace read; a grant-only member gets an
  empty, done ordinary catalog there. A readable folder hidden by archive or the caller's pending
  move or delete also gets an empty, done page. Missing or denied folders return null.
  The parent-first index contains only active ordinary field docs. It seeks after each distinct key,
  so hidden restricted children cannot change the catalog's fields, page length, or cursor.
  Each witness node must still have the same tenant and parent, be active, and have neither a
  restricted-root flag nor itself as `restrictedScopeNodeId`. A mismatch throws an invariant error.
- `files_metadata.list_node_fields` and `get_field_values` resolve one target through the visible
  reader on every call. A prior side row never grants access. Missing access returns null, including
  after a grant is revoked. Private targets also require the caller to own the node and current
  proposal. Every private metadata witness must match the current proposal id and revision, tenant,
  target, and owner. Stale docs throw instead of becoming key names, values, or a false missing cell.
  Preparing private targets expose no keys or values. Their source token binds the proposal and
  revision, so the client cannot keep old pages after a source change. These queries keep whole-query
  byte and call budgets, and throw when no field can finish. They do not scan hidden child partitions
  to decide a catalog cap. Columns are personal browser preferences; choosing a key does not publish
  its name as shared folder settings.
- `files_folder_sorts.get_folder_sort` returns null unless the caller can `content.read` the folder
  (or the workspace, at the root). A grant-only member at the root gets Name, A to Z with
  `canSave: false`, not the saved root sort: a saved metadata sort would name a key they may not see. `canSave` and `set_folder_sort` need what a metadata write needs:
  `content.write` on the folder and a folder whose write policy lets the user write. At the root only
  the workspace permission applies. The saved sort is shared by every member; a reader's own sort is
  never stored.
- No query returns `files_updated_by_docs` (updater sort docs) yet. Their name keys can lag behind a
  name change until `drain_user_name` reaches them; that delay is accepted, because cells read the
  live name.
- `get_folder_readme` uses the same folder gate as `list_tree_children`. Known limit: it reads at most
  50 active files per case variant of the prefix `rea`, so a folder with 50+ names like `reaction-*.md`
  before `README.md` shows no README in the Files table.
- Every folder row shows a chevron, even an empty one. A chevron only on folders with children would
  tell a reader that a folder holds files they cannot see. Paging is not that tight: the filter runs
  after the index page, so a caller who pages with `numItems: 1` gets empty pages with
  `isDone: false` for hidden children and can count them. `list_tree` pages the same way, so this is
  not new.

## File sharing

`convex/files_sharing.ts` owns member sharing. Five mutations plus one query:
`get_node_share_state`, `restrict_node`, `unrestrict_node`, `set_node_share_grant`,
`remove_node_share_grant`, `set_node_share_link`. The five writes take `content.permissions.manage`
**on the node**, and the `files_sharing_write` bucket first. `get_node_share_state` only takes
`content.read` on the node: the dialog opens for anybody who can see the file, and `canManage` in its
answer is what hides the controls from a reader.
`set_node_share_link` turns a file's public link on and off. The public doors that serve the link
live in `convex/files_share_links.ts`. See "Public file links" below.

The model:

- A node is restricted exactly when `restrictedScopeNodeId === _id`. Everything under it points at
  the same id. `restrict_node` and `unrestrict_node` set the node's own scope now, then start a scope
  job with `files_subtree_ops_db_start_rebuild` (kind `scope`). The plugin access binding
  (`plugins_data_db_apply_file_access_binding`, which takes the acting `userId`) and plugin external
  files (`plugins_external_files.ts`) do the same. The job walks children by `parentId` and writes
  each child's `restrictedScopeNodeId` from its live parent. A child that is its own restricted folder
  keeps its own scope. The first step runs inside the request, so a small folder is done at once. A
  bigger one leaves a hidden Activity ("Restrict files", `feedVisible: false`) only so the recover
  cron finds the op. A move job rewrites scope the same way.
- Until the job writes a child, the child keeps its stored scope. The tree, search, and download
  trust that stored scope. So a child moved into a restricted folder stays open to the workspace until
  the job rewrites it, and a child of a newly restricted folder stays open for that time too. This
  short window is accepted.
- Grants are always written on the **scope node**, never on the node being opened. Sending a child's
  id to `set_node_share_grant` is refused; the dialog sends the folder's id for exactly this reason.
- Three levels — `read`, `write`, `manage` — each a superset of the last, saved as one grant doc per
  permission. `access_control_FILE_SHARE_LEVELS` is the source of truth.

Five rules that look like details and are not:

- **The owner holds no grant doc** and never appears in the list. They pass every check anyway, so a
  row for them would be a switch that changes nothing. `set_node_share_grant` refuses them as a
  principal, and the dialog shows them as a fixed row instead.
- **`restrict_node` writes the caller their own `manage` grant**, unless they are the owner. Without
  it an admin would restrict a folder and lose it in the same click, because a role gives nothing
  inside a restricted scope.
- **`would_leave_no_manager`** stops the last manager taking themselves off, so the list stays
  repairable. It only triggers for somebody who manages it *today* — a list with no manager at all is
  normal, and is what an owner-restricted folder looks like. The owner is exempt: they are the repair.
- **Deleting a role is blocked while it is shared.** `delete_role` refuses when any grant names the
  role. Remove the role from the share list, or unrestrict the node, first.
- **A role may be on at most `MAX_FILE_SHARES_PER_ROLE` (50) share lists.** Giving somebody a role,
  or inviting them, has to walk every share that names it, because the role hands its shares out
  along with itself. That walk has no page limit and does not need one: `set_node_share_grant`
  refuses the share that would go past 50. The bound sits where the count grows, so the refusal
  reaches somebody who can act on it — share with the people instead — rather than an inviter who
  can fix nothing. Changing a level the role already has on a node writes no new share and is not
  counted.

## Public file links

"Anyone with the link can view" publishes one saved file to people with no account. The code:
`convex/files_share_links.ts` (public view, signer, `list_workspace_links`, live checks),
`convex/files_share_links_db.ts` (lifecycle delete helpers), `set_node_share_link` and
`get_node_share_state` in `convex/files_sharing.ts`, and `shared/files-share-rich-text.ts` (safe
content). The share page is `/share/<token>`; the auth skill describes its public boundary.

### The link doc and its token

- A link is one `files_share_links` doc. A file has at most one. The doc holds a random `token`:
  32 random bytes as lowercase hex, from `crypto_random_hex`.
- The token is the only authority. A file id is not a secret and opens nothing. Ids appear in
  URLs, embeds, tree rows, API answers, and logs, and former members keep them.
- The public doors find the doc by exact token on `by_token`. They never take a node id. A token
  that is not 64 lowercase hex characters makes the view return null and the signer return
  `Not found`. Both stop before any read.
- Turning the link off deletes the doc. Turning it on again makes a new token, so an old link never
  works again. Turning it on while a link exists keeps the first token.
- The token is stored as plain text, so a manager can copy the link again. Never log it. The
  signer's rate limit key is the doc `_id`, never the token.
- A link is not a `public` grant. It does not use `principalKind: "public"` or `allowPublic`. A
  grant would not work here: the checker reads grants on the restricted scope node, so a grant on
  one file inside a restricted folder would never match, and a grant on the folder would open
  every file in it.
- The doc also stores `restrictedScopeNodeId` (the file's live scope when the link was turned on)
  and `ancestorNodeIds` (the folders from the parent up to the root, at most 64). The lifecycle
  helpers use the ancestor list to find links under a folder without loading nodes. Neither field
  leaves the server.
- `createdBy` and `createdAt` are display data. The link does not depend on the creator's
  membership, role, or account.
- A workspace has at most 500 links (`files_share_links_MAX_PER_WORKSPACE`). This is a code bound
  on query and cleanup cost, not a quota.

### Turning it on and off

`files_sharing.set_node_share_link({ membershipId, nodeId, enabled })` returns a Result.

- It charges `files_sharing_write` first.
- Both On and Off need an active membership and `content.permissions.manage` on the file's
  **live** scope. `files_share_links_db_resolve_live_scope` walks `parentId` up to the root (at most
  64 folders) and finds the nearest restricted root. The stored scope can be old while a scope job
  runs, and a manager must not publish a file inside a folder that was just restricted.
- On also needs all of these:
  - a signed-in user, not an anonymous one ("Sign in to create a public link"). So an anonymous
    upgrade never has to find and secure links;
  - `content.read` on the live scope. Nobody publishes what they cannot read;
  - every check in `files_share_links_db_check_live_file`: the node is a file, not a folder; it
    and every folder above it are not archived; the organization and workspace are live (see
    check 4 below); no plugin binding on the file or a folder above it; a finished asset; a
    supported text shape; and no queued or running subtree job on the file's path;
  - fewer than 500 links in the workspace.
- Off needs only the live manage permission. It skips On's file checks, so a manager can turn a
  link off while a job runs or after the file is archived. A missing link is a success.
- Agents, bash tools, API keys, and `/api/v1` never reach this mutation.
- `get_node_share_state` returns `link: { token, createdBy, createdAt } | null`. Only a caller with
  live `content.permissions.manage` gets the link. Every other reader gets `link: null`.

### What the public view checks on every read

`files_share_links.get_share_link_view({ token })` never reads `ctx.auth`. Every refusal answers
`null`, so a wrong token, a turned-off link, an archived file, and a deleted workspace look the
same. Stored fields are not enough, because a background job updates the items inside a folder
later. A file can still store "open" while a folder above it is already restricted or archived. So
every read checks the live state again:

1. The doc exists. Its node exists, is a file of the doc's organization and workspace, and is not
   archived.
2. Every folder above the file, read by `parentId` up to the root (at most 64), exists, is a folder
   of the same tenant, and is not archived. The live scope must equal the doc's
   `restrictedScopeNodeId`.
3. The file and every folder above it have no `plugins_file_access_bindings` doc and no attached
   `plugins_external_file_bindings` doc (`detachedAt === null`). A plugin reader list would be
   bypassed by a public link.
4. The organization and workspace exist, the workspace has no `pluginDataPurgeStartedAt`, and
   `data_deletion_requests` has no doc for the organization and no doc for this workspace. Both
   are exact lookups: a deletion of another workspace in the organization does not hide the file.
5. The file's asset belongs to the same tenant, has an `r2Key`, and has no
   `unfinalizedExpiresAt`. The stored text shape matches the content type. A stored blob with an
   editable text type and `textKind: null` cannot be shared.
6. No queued or running subtree job overlaps the file's path. `files_subtree_ops_db_find_blocked_paths`
   reads the workspace's jobs once for the file and every embed. More than 500 jobs refuses the
   view, because a partial scan could miss the blocking job.
7. The whole view stays inside a read budget (1,500 calls, 16,000 docs, 8 MiB) and returns at most
   1,000,000 bytes. Past a budget the view refuses, or the rest of the embeds show as unavailable.

The query is reactive. A change to the doc, the file, a folder above it, an embed, or a workspace
job runs it again, and an open page clears when the answer turns `null`.

### What the visitor sees

The view returns only the file name, `textKind`, `contentType`, size, the content, at most 50 embed
descriptors, and an opaque `revision`. The revision is a SHA-256 hash, so it shows no ids. The
content is one of:

- `{ kind: "rich_text", json }`: JSON for a small fixed schema. The browser never gets HTML or
  Markdown.
- `{ kind: "plain_text", text, formattingFallback }`: text only. A rich file with too much
  formatting falls back to its visible text, with `formattingFallback: true` and no embeds.
- `{ kind: "binary" }`: no bytes. The page asks the signer below.

Rules for that content:

- The view reads only committed chunks. It never reads a pending draft, a branch, or the live Yjs
  head. So visitors see saved changes, usually a few seconds behind live edits.
- The server removes comment marks. It replaces visible `bonobo-file://` references with
  `[file reference]` and literal `data-lb-thread-id` text with `[comment reference]`.
- The view never returns the path, parent or folder ids or names, organization or workspace ids or
  names, people, metadata docs, version history, comments, presence, or pending changes.
- Frontmatter and body text are shown. The author chose them. The server does not try to find ids
  or secrets typed as ordinary text.
- Editable text is never downloaded. The visitor sees only the safe content.

### Signed URLs

`create_share_link_download_urls({ token, revision, targets })` is a public action. A target is
`{ kind: "file" }` (the shared file) or `{ kind: "embed", index }` (one embed of the page). The
visitor never sends a node id, an asset id, or a file name.

- It takes 1 to 50 unique targets. An embed index is an integer from 0 to 49.
- It charges the `files_share_link_download` bucket (200 per minute) once per target, before the
  costly preparation. The key is the link doc id, so all visitors of one link share it.
- Then `prepare_share_link_download` prepares the whole view again, with every check above. A
  revision that differs from the page's answers `stale` with no URLs. A rate-limited call answers
  `_nay` with `retryAfterMs`. Every other refusal answers the same `Not found`.
- A text file's bytes are never signed. Other files download their original bytes through
  `files_get_signed_download_serving`, as attachments unless they are inline-safe media.
- Embeds are signed under a neutral name such as `image.png`, because the media file's own name
  can be private.
- Signed URLs work for 15 minutes. Turning the link off, or any lifecycle event below, stops new
  URLs at once. A URL that was already issued keeps working until it expires, for up to 15
  minutes after the link ends. The same is true when an embed stops being available.
- The R2 key in a signed URL shows the organization, workspace, and asset ids, the R2 endpoint,
  and the signing access key ID. These are not secrets and give no access alone. The secret access
  key never leaves the server.

### Images and videos in a shared document

An embed E inside the shared document D shows only when all of these hold. Otherwise the page
shows a gray box, and the descriptor is `{ index, available: false }`, which tells nothing about E.

1. E is a real image or video source in D's committed content. One server preparation builds the
   media map. Text, code, frontmatter, and ordinary links never become embeds.
2. E is a saved file in D's organization and workspace. `bonobo-file://<id>` is normalized as a
   `files_nodes` id. `bonobo-file://private/<id>` shows only through the saved file it was
   published as (`files_pending_nodes_db_resolve_read_target` answers `kind: "saved"`), never
   through a draft.
3. E's content type is an inline-safe image or video type (`files_is_inline_media_content_type`),
   and it matches the node: an image node needs an image file, a video node needs a video file.
4. E passes the same live checks as D: not archived, live folders, no plugin binding, no running
   job on its path, and a finished asset.
5. **Same audience:** E's live restricted scope equals D's live restricted scope. Both are open to
   the workspace, or both sit inside the same restricted folder. Everyone who can read or write D
   can then read E: inside a restricted folder all grants sit on the scope node and write includes
   read, and in an open scope members read every open file through their roles. Without this rule,
   a writer of D could embed a restricted file whose id they know and publish it.
6. **No narrow writers (open scope only):** a service account can hold `content.write` on one exact
   open file without reading others. So when D is open, every service account with an exact
   `content.write` grant on D must be live (not revoked), belong to this workspace, and read E
   through an exact `content.read` grant on E or a workspace `content.read` grant. A revoked or
   missing account is never skipped: E stays hidden. More than 50 grants hides E.

Rule 5 relies on "edit includes view" for custom roles (see "Roles"). A document inside a
restricted folder that embeds an image from an open folder shows the gray box too. Move or copy the
image next to the document. E having its own public link does not help: that would make file ids
secrets again.

**Automatic publishing (approved product rule).** A successful in-place edit of D keeps D's link and
token. This holds for human saves, API writes, and plugin writes. Images and videos that the edit
adds publish through D's link when rules 1 to 6 allow them. Credential download limits do not limit
these embeds on the public page: a key or plugin run without `files:download`, or one whose direct
downloads are source-only, can still add an eligible image that visitors of D then see. This is a
deliberate wider access, not a bug. The public view has no credential-scope filter and tracks no
per-embed writer history. Private API scope checks do not change: the same key still gets 403 from
`/api/v1/files/download-urls`. No file becomes public just because somebody knows its id, and no
link is created for E. Removing the reference, archiving E, turning D off, or an access change that
makes E fail rules 1 to 6 stops new URLs for E.

### Lifecycle: what ends a link

A link publishes one file in its current place. When the file's access situation changes, the
lifecycle helper deletes the link doc for good. Turning it on again is a new decision with a new
token. There are two helpers in `files_share_links_db.ts`:

- `files_share_links_db_delete_for_node` deletes the link of one exact file.
- `files_share_links_db_delete_for_roots` deletes every link on a set of roots or below them. It
  matches `nodeId` and `ancestorNodeIds` in memory and never loads file nodes. A
  `files_share_links_CleanupState` belongs to one mutation. It loads each workspace's link docs at
  most once, so a batch does not reload 500 links per item. Never keep it in a module cache.

Both skip global, plugin-volume, and reserved scopes, which never hold links. The module imports no
lifecycle or access-control module, so every caller can import it without a cycle.

| Event | Where the delete runs |
| --- | --- |
| Turn the link off | `set_node_share_link` with `enabled: false` |
| Restrict or unrestrict the file or a folder above it | `files_nodes_db_set_restricted_scope`, for the node and everything below, only when the scope really changes, before the patch. This covers `restrict_node`, `unrestrict_node`, and plugin bindings. A restrict then unrestrict before the scope job reaches the file does not bring the link back |
| A scope job gives the file a new scope | `files_nodes_db_rebuild_node`, only when the scope changes. A new path alone (a folder above was renamed) keeps the link |
| Move to another folder, including move-overwrite and a move into a folder created by the same move | `files_nodes_db_apply_move`, for the reparented roots and the archived occupants, before any patch. This covers `move_nodes`, a rename that changes the parent, and an accepted pending Save move. A move ends the link even when the new folder has the same audience |
| Archive | `files_nodes_db_archive_node` (the exact node), `files_nodes_db_archive_nodes` (the named roots and below, once per workspace), and the archive job when its check passes, for the roots the check kept. A queued, refused, or stopped check keeps the links |
| Restore from the archive | `files_nodes_db_restore_node`. A restored file comes back with no link |
| Archive-and-create replacement | The archive helpers above. This covers a replacing upload (`create_upload_node`, `create_upload_nodes`, `/api/v1/files/upload-urls`, `data_import`), `/api/v1/files/write` over a stored file, and plugin and service paths that archive and recreate. The new file has no link |
| Remove a failed file creation | `files_nodes_db_hard_delete_node` |
| A plugin reader list takes over the file or a folder above it, or lets go of it | `plugins_data_db_apply_file_access_binding`, even when the node was already restricted |
| A plugin binding is detached or cleaned up | `db_detach_file_access_binding` (a manual sharing change), `db_sync_file_access_bindings` with `removeUserIds: "all"` (scope deletion and stranded-scope cleanup), and the uninstall binding drain. A detach never brings a link back |
| An exact service-account `content.write` grant on the file is removed or lowered to View | `access_control_db_set_service_account_grant`, before it deletes the grant. Rule 6 no longer sees that account after the grant goes, but the account may have added images before |
| Workspace or organization purge | The `data_deletion.ts` content purge drains `files_share_links` in batches, before grants and file nodes. The deletion request, or `pluginDataPurgeStartedAt` for a preserved-home data reset, already hides every link before the purge starts |

What keeps a link:

- In-place content edits: human saves, `/api/v1/files/write` fills of an editable file
  (`publish_file_fill`), and plugin fills (`db_install_file_content_replacement`). Failed or
  skipped writes keep it too. A write staged before the link was turned on and published after it
  keeps the new token.
- A rename that keeps the parent, and a rename of a folder above.
- Metadata and write-policy edits.
- Human or role share grant changes that do not restrict or unrestrict anything, and role or
  membership changes. These change who can read the file in Files, not the public link.
- Service-account grant changes other than losing an exact `content.write` grant on the file.
  Revoking an account keeps its grants and the link, but rule 6 then hides embeds that depend on
  it.
- The creator leaving, losing rights, or deleting their account.
- Copies. A copy is a new file with no link.

A file node that is gone or archived without a hook still shows nothing, because the view checks
the live state on every read.

### Seeing links inside Files

`files_share_links.list_workspace_links({ membershipId })` returns
`{ nodeId, createdBy, createdAt }[]` for the linked files the caller can read. It feeds the link
mark in the Files tree and the `file.link:public` search filter.

- Missing current-user auth throws `Unauthenticated`. A bad membership or tenant answers `null`.
- A member with only file grants (no workspace `content.read`) is allowed, like the tree reader:
  on "Permission denied" it filters with `hasWorkspaceRead: false`.
- It filters the docs with `access_control_db_filter_readable_file_nodes`, using the scope stored
  on each link. It does not load the nodes: the hooks that change a file's scope delete its link
  in the same write.
- It never returns the token or names. Only a manager gets the token, from `get_node_share_state`.

# Write paths that create an assignment

An assignment supplies a non-owner's role permissions. Direct file and plugin grants can add
exact access too. Assignment writers are few on purpose:

- `organizations.invite_user_to_organization_workspace` — one `member` assignment on the default
  workspace. That one doc is the organization role, so no second doc for the invited workspace.
- `access_control.set_user_role` — the only handler whose *purpose* is changing or revoking a role.
  Three other paths rewrite assignments as a side effect: the two below, and `delete_role` (demote to
  `viewer`, delete workspace roles).
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
- `users.resolve_user` — reclaiming a deleted account reactivates its ordinary inactive memberships,
  but skips memberships marked `pendingOrganizationRemoval` because that separate drain still owns
  them. It ensures a `member` assignment on each membership it did reactivate, skipping owners. `ensure`
  leaves a surviving assignment alone whatever its role, so this only fills a hole — and after the
  `delete_role` demotion above, the only hole left is a legacy membership the backfill skipped, which
  is exactly the case `member` is right for.

Paths that deliberately write **none**:

- `organizations_db_create` and every personal-organization creation in `data_deletion.ts` — the
  creator becomes the owner, and owners hold no assignment.
- `organizations_db_create_workspace` — the creator's organization role already reaches the new
  workspace.

`access_control_db_ensure_role_assignment` inserts when absent, so a repeat call is a no-op.
`db_set_role_assignment` patches or inserts on the unique key — use it when changing an existing
role. It is module-private to `access_control.ts`: role writes go through the mutations there, not
through a shared helper.

# Access-doc deletion

Cleanup belongs to the lifecycle mutation that removes the user, workspace, or organization:

- `organizations.remove_user_from_organization` — that user's assignments and direct grants in the
  organization.
- `organizations.delete_workspace` — memberships and assignments scoped to the workspace. It
  requires `workspace.delete`, and it refuses the **default** workspace. That refusal is what protects
  the every-member-needs-an-organization-role invariant: deleting the default workspace would delete
  every member's organization-wide assignment at once. It keys off `organization.defaultWorkspaceId`,
  not the workspace's own `default` flag.
- `organizations.delete_organization` — memberships, assignments, and custom roles for the organization,
  plus the quota release. It also fences retained workspaces against plugin authority.
- Both public tenant delete mutations leave permission grant docs to the worker's bounded purge.
  Missing memberships block user access. A deleted workspace or its plugin fence blocks plugin access.
- `data_deletion.init_user_deletion`, `process_organization_deletion_request`,
  `process_user_deletion_request` — the remaining docs. Idempotent with the immediate cleanup above.

`delete_organization` and the data-deletion paths also delete the organization's `access_control_roles`
docs.

# Not enforced yet

Be explicit about this when planning work; do not assume the subsystem is complete.

- **AI tools and the bash shell** keep the original chat separate from the file workspace.
  `/api/chat` and background jobs require source `content.read` in both modes. A team viewer can
  use Agent mode in their own home. Each file door checks the selected workspace, the current
  node permission and its write policy. Original membership lifetime checks prevent an old run
  from returning private data or writing after leave/re-invite. Reads check again after external I/O.
  Ask mode removes write tools from the `tools` registry, not only from advisory `activeTools`.
  `allowDbFilesMkdir: false` refuses all app-file writes while leaving thread `/tmp` writable.
  Code execution uses separate current/home read grants with one shared byte budget. The public
  API checks each grant and its original source again. New internal callers must keep these checks.
- **Plugin runs have platform file scopes, but writes still answer to the actor and source file.** A
  run gets the platform baseline needed to download its exact triggering upload and write Markdown
  siblings. `db_revalidate_file_write_principal` then reloads the run, installation, source node, and
  actor's active membership in both the prepare and publish transactions. It requires the actor's
  current `content.write` on the source node before output can land. The separate intrinsic
  write-policy check also protects the output destination, even for an owner-backed run. The pinned
  service account must independently hold the required grant on the actual target. This does not turn
  accepted plugin capabilities into ACL permissions; it is a live actor/source ceiling on the
  platform baseline.
- **The global presence roster is readable by any account, and the `listRoom` gate does not change
  that.** Read this bullet as one fact, not two: `listRoom` refuses a caller with no identity and
  refuses `app_presence_GLOBAL_ROOM_ID` outright, and **that closes one door of two**. The other door
  is open and the app itself uses it — `MainAppSidebarPresenceControl` heartbeats the global room,
  takes the room token `heartbeat` mints for any id, and passes it to `list`, which authorizes
  nothing beyond "some account resolved" — `server_convex_get_user_fallback_to_anonymous`, then
  `throw convex_error({ message: "Unauthenticated" })` when it answers null (`presence.ts`).
  Anonymous accounts satisfy that, and one unauthenticated POST
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
  name, path, content type and size unless the caller also holds `content.read`, so a member with
  exact plugin management access can see run status without file identity. The plugin document store is the other
  content-checked plugin surface: `db_authorize` in `plugins_data.ts` asks for `content.read` or
  `content.write` on the workspace for the acting member, on every principal kind including
  `plugin_run` and the `plugin_service` grant, in the same transaction as the read or write. The
  page-facing doors do the same from a plugin-session JWT: `db_authorize_page_write` resolves the
  member from the session doc (deleted session = revoked identity) and checks `content.write`
  through `access_control_db_has_permission` in the same transaction.
- **A restricted path is still an existence oracle.** A path holds one active node, so creating a
  file where a restricted one already sits has to fail, and the refusal tells the caller something is
  there. `files_nodes_db_create_node_recursively_at_path` answers `"This file already exists."`, and
  the public write route answers `"Permission denied"`. Neither hands over the name, the content or
  the author, and hiding it would need two nodes on one path. Accepted, not overlooked.
- **Plugin-owned private paths have the same name-probing risk.** Under a locked parent,
  `create_folder_node` can answer `"Permission denied"` for an unreadable existing child and
  `"This item is read-only."` for a free name. Plugin authors should avoid guessable private paths.
  Their folder layout belongs in their repository; Press does not recognize their private groups.
  If the different answers become a product concern, collapse them as `create_upload_nodes` does.
- **The folder import widens that oracle's budget, on purpose.** `files_nodes.create_upload_nodes`
  reports per-item skips, and a skip is the same class of probe. The payload never says why: a
  permission refusal and a user-chosen skip both answer the one literal `"conflict"`. Each item is
  charged one `files_bulk_import` token (rate 100/min, capacity 300, per user), so the burst budget
  is 6× the single-file create oracle and sustained is 2×. The companion query
  `files_nodes.get_upload_conflicts` cannot be rate-limited (queries cannot charge the limiter), so
  it filters by per-node `content.read` and answers "no conflict" for anything the caller cannot
  read — it must never reveal more than `list_tree` does. The other skip reason, `"path_blocked"`,
  says what kind of node blocks the path, so the mutation only answers it when the caller can
  `content.read` the blocking node; a hidden folder at the target and a hidden file at an ancestor
  both fall back to `"conflict"`.
- **The public API batch writes widen it again, faster.** `/api/v1/files/write-many` answers the same
  literal `"Permission denied"` per item, charged up front on `public_api_files_write_bulk` (rate
  600/min, capacity 100, per API key), and `/api/v1/files/upload-urls` refuses its whole batch at the
  first restricted path it hits. The caller already holds workspace `content.write`, and the payload
  still never says why beyond the literal. Accepted at this speed; if it ever matters, lower the
  bucket rather than blurring the per-item errors, which importers need.
- **Service-upload delete checks the live file.** `/api/v1/files/service-uploads/delete` starts
  from a sealed destination and target key, but a member may have moved or restricted a matching file
  since upload. The mutation loads every bounded live match before its first write, drops nodes now
  outside the seal, and asks `content.write` on each remaining node. Workspace permission from the
  processing grant never opens a restricted file by itself. It archives committed files and
  hard-deletes only unfinished placeholders.
- **Service-upload target retries check the live file too.** Exact create replay, remint, and
  finalize bind the target to its original destination seal, then check its active current path and
  the presenting actor's `content.write` access. This prevents another grant in the installation,
  or a grant whose placeholder was moved or restricted, from extending the signed PUT window.
- **Nothing proves a shared tenant before naming a user.** `users.get_anagraphic` requires an
  identity and hides other people's email, but any signed-in caller still turns any `users` id into a
  display name and avatar. Closing that needs a relationship check the query has no argument for
  today, and the same rule would have to reach `presence.listRoom`. Email is already gated:
  same-workspace callers use `users.get_workspace_member_anagraphic`.

# Public access

Public grant docs are capability-like access, not membership.

- Check them only on flows that intentionally support link or public access.
- `allowPublic` must be explicit at the call site. Never default public write on.
- For an anonymous user, prefer `principalKind: "user"` with their Convex `users` id over `public`.
- "Anyone with the link can view" does not use public grants. It uses a token doc in
  `files_share_links`; see "Public file links".

Anonymous upgrade semantics live in `../auth-system/SKILL.md`.

# UI surfaces

Two routes reach the whole model. Both are gated by queries, not by route guards, like `users/` and
`api-keys/` next to them; a member who types the URL gets a read-only page, not a redirect.

- **`/w/:org/:workspace/roles`** authors custom roles. System roles render read-only from
  `access_control_SYSTEM_ROLE_MATRIX`; custom roles come from `list_roles`. The permission picker
  offers exactly `access_control_ENFORCED_PERMISSIONS`, grouped by the catalog's `group` in
  `access_control_PERMISSION_GROUPS` order.
- **`/w/:org/:workspace/users`** assigns them, through a role select in each member row.

Both mirror the server's ceiling client-side from
`organizations.list().workspaceIdsPermissionsDict`, which is built by
`access_control_db_resolve_effective_permissions` with the same arguments the server uses. **The two
routes read it at different workspaces, on purpose, because the server does:**

- Role CRUD measures the ceiling at the **default** workspace (`authorize_role_management`), so the
  roles page reads `workspaceIdsPermissionsDict[organization.defaultWorkspaceId]`.
- `set_user_role` measures it at **`args.workspaceId`**, so the users page reads
  `workspaceIdsPermissionsDict[workspaceId]`.

Consequences the UI has to carry, each of which is a server rule and not a style choice:

- A role holding a permission the caller lacks **keeps** its Edit and Delete buttons, but they carry
  `aria-disabled="true"` (never the `disabled` attribute, so they stay focusable and hoverable) and
  an `aria-describedby` reason naming the missing permission. `update_role` and `delete_role` both
  refuse that role, so the click does nothing — but a button that silently vanishes teaches nobody
  the ceiling rule, and this is the rule users hit without warning. The buttons are gone entirely
  only when the caller may not manage roles at all; the header's `New role` tooltip covers that case.
- The users-page select lists only roles the caller could hand out, for the same reason.
- Outside the default workspace the select adds a **`No workspace role`** option that sends
  `role: null`. Without it a workspace role is permanent: every weaker role is refused by
  the "adds nothing" rule, and `delete_role` then refuses forever because somebody still holds it.
- Outside the default workspace the select also appears for `workspace.members.manage`, which
  `set_user_role` accepts there. Invite and Remove stay on `organization.members.manage`, so those
  two flags must not be merged into one.
- The delete dialog must not promise that members are demoted. `delete_role` **refuses** while an
  active member holds the role; it only demotes holders with no active membership.

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
- `packages/app/convex/files_share_links.ts`, `packages/app/convex/files_share_links_db.ts` (+ `files_share_links.test.ts`)
- `packages/app/convex/access_control.test.ts`
- `packages/app/convex/organizations.test.ts`
- `packages/app/convex/data_deletion.test.ts`
- `packages/app/src/routes/w/$organizationName/$workspaceName/roles/index.tsx` (+ `index.css`, `index.test.tsx`)
- `packages/app/src/routes/w/$organizationName/$workspaceName/users/index.tsx` (+ `index.test.tsx`)
