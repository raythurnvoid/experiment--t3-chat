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
- A file's write policy is separate from ACL. Check the request's subject first.
  Then apply that node's own `writePolicy`. Owners do not bypass a
  read-only or named-writer policy. See `../files-read-only/SKILL.md` for the policy rules.
- Changing a folder's write policy needs `content.permissions.manage` on that folder only. A locked
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
mutation must be sequential so they share one ordered counter. Bonobo Senate has no named plugin consumer
or remote wait in this path.

The public member and access-change APIs use `plugins_service_connections`. A live connection needs
the exact registration, installation version, service account, and accepted member capability.
An old or removed connection gets control events only. Another plugin's secret never authenticates
that connection. A valid page identity exchange is the only way to update its pins.

Plugin backends apply these facts and enforce their own access lease, which lasts at most 30 seconds.
They own their private groups and live queries. Bonobo Senate owns workspace membership, Files grants,
and `organizations_membership_lifetimes`. See [external plugin identity](../auth-system/SKILL.md#identity-for-external-plugin-backends).

## Paged media validation

Long Files reads also use `files_access_versions`. The mutation wrapper captures permission changes
through `server/files-access-version.ts`. Organization clocks cover owner changes, custom role
permissions, and role assignments. Workspace clocks cover human read grants, membership lifetimes,
active membership, and saved scope pointers. Each mutation bumps a changed scope once. Profile,
content, metadata, unchanged patches, and independent service-account grants do not bump it.
The clocks have no per-user file copies and do not depend on an external service lease.

A resumed Files resolver pins both clock identity and revision. It also pins the saved view, saved
structure, and the owner's pending revision. The caller checks live user, membership, chat, source,
and installation authority on each step and before returning a page. A changed pin invalidates old
permission answers. The canonical permission check still owns the rule for dead restricted scopes;
the resolver does not add another permission model. Workspace and organization purge remove these
clocks, and the wrapper never recreates them after the tenant is gone.

`files_media_validation.ts` keeps small organization and workspace version docs. Copy and Save
pin both doc identity and revision, plus the owner's pending version. These are validation tokens,
not permission caches. Final publication still checks current access.

- Organization role assignments, custom permission changes, role deletion, and ownership changes
  advance the organization version in the same transaction.
- Human/role file grants, root restriction, membership lifetime, saved media, placement, and write
  policy changes advance the workspace version. Unchanged or refused writes do not advance it.
- Plugin mirrored human readers follow the same rule, including rollback and empty-reader root
  restriction. Store-only changes and independent service-account grants are not human media access.
- Replaced content advances a separate content version (`files_content_versions`), not the
  workspace version. Copy and Save pin it too. A Move group pins only the organization, workspace
  and review versions. Data deletion removes it with the workspace.
- For a plain file with no pending replacement, `files_nodes_db_archive_nodes` skips the workspace
  version and `db_install_file_content_replacement` skips the content version. A plain file is not a
  stored image or video. Creating a node advances neither. Move cohorts, archive runs and subtree jobs
  always advance.
- A Copy or Save proof with no media refs skips the version check. The folder Move check and the
  Move cohort keep their pins, because the same pins catch write policy and access changes.
- Purge fencing invalidates proofs before docs are removed. A removed version doc also invalidates
  its proof. Never recreate a missing doc while checking an old proof.

Advance only for a change that can turn a passing proof into a failing one. Check all four readers:
Copy, pending Save, folder Move check, and Move cohort. See the pending and transfer specs.

## Service accounts

Service accounts are workspace identities for software. They are not users and have no roles,
owner rights, billing rights, public fallback, or private plugin-data scope rights. Their
`createdBy` field is audit data, not authority.

- Every file check acts as one **subject** (`access_control_Subject`). No check asks two
  principals.
  - A person (UI, Bash, chat, jobs): `{ kind: "user", userId, plugin: null }`.
  - A plugin run, page or service grant: its human plus `plugin: { installationId, roots }`, built
    by `plugins_sandbox_subject`.
  - An account-bound API key: `{ kind: "service_account", serviceAccountId }`. The key acts as the
    account. Its sponsor's own access does not matter. So a person who may manage service accounts
    can act as any account through a key, except inside plugin output folders.
  - A plugin writer request (write, inspect, ensure, reader set and undo) inside this installation's
    own private output folder: `{ kind: "service_account", serviceAccountId, installationId }`,
    built by `plugins_external_files_db_request_subject` only while its human can still read the
    folder. The account's own `manage` grant there decides, so the plugin writes where its human
    only reads. A human who cannot read the folder gets the human subject, so the plugin never
    reads or writes there for them. Only the owner, not a reader, manages that folder. The route
    gate still checks the human's workspace content permission.
- `access_control_db_has_permission` accepts either the existing user/public input or an exclusive
  `serviceAccountId`. The account branch runs before the human owner shortcut. It requires an
  active same-tenant account and its own content grant.
- Workspace grants cover unrestricted content. An unrestricted file/folder grant covers that
  exact node, not its descendants. Restricted content requires a grant at the nearest live
  restricted scope. A workspace grant never crosses that boundary.
- A plugin subject reaches a node only when its human can, and the node is inside one of the
  installation's **sandbox roots** at a level that gives the permission. An `open` root covers open
  content only. A folder root covers that folder and what is below it in the same restricted area;
  it stops at every restricted folder inside. A file root covers only that file (its `treePath` is
  not a prefix test). A root on a deleted or archived node gives nothing. Roots are empty while
  they rebuild, and after a rebuild that found more than 20 folders.
- The installation's own output folders (a live `plugins_external_file_bindings` row of this
  installation on the restricted folder) count as roots and take no slot. Their level is the
  account's live grant there, so lowering or removing that grant limits the plugin at once. They
  also work during a rebuild. The human must still reach them.
- An account subject reaches a plugin output folder only with that installation's
  `installationId`, so a key bound to a plugin's account cannot read that plugin's private folders.
- A create or replace checks the folder where the item lands with the full subject. A folder above
  it passes when the actor or the full subject can write it (the recursive create, used by
  `ensure_writer` and app creates, and the public API replace). The public API create starts at
  the nearest existing folder, so it walks no folder above it.
- Credentials, capabilities, source limits, and write policies remain separate limits. Do not
  require workspace-wide account access before a file check: an account may have only one
  restricted-folder grant.
- `access_control_db_filter_readable_file_nodes` and `access_control_db_can_act_on_file_node` take
  `subject`. Their loaded node inputs include `_id`; a plugin subject reads `treePath` when it is
  missing. Internal read queries also keep `visibilityUserId`: it picks personal rows, pins, and
  drafts only. Drafts are read only when `access_control_subject_reads_drafts(subject)`.
- Any active workspace member may list/get active account labels for pickers. Revoked accounts
  and grant pages require `workspace.service_accounts.manage`. This permission is in the existing
  catalog and admin role. Personal/default workspaces support accounts.
- Create, rename, revoke, account binding, and grant management require that permission. Names
  are trimmed, nonempty, and at most `access_control_MAX_SERVICE_ACCOUNT_NAME_LENGTH` (80).
  Creating an account gives no grants or credentials.
- An account may hold one role (`role` on the account, missing = none). The role gives only the
  restricted-folder shares that name it, as it does for a member, never the role's workspace
  permission list. Lists read the role's share rows too. Plugin sandbox roots never include role
  shares. `set_service_account_role` needs `workspace.service_accounts.manage`, the member-role rule
  of `set_user_role`, and the same ceiling (`db_caller_cannot_assign_role`): a key bound to the
  account acts as the account, so nobody may give it more than they could give a member.
  Anyone with `workspace.service_accounts.manage` can mint a key for the account and so use the
  role's reach, which grows when someone shares another restricted folder with the role.
  A revoked account cannot get a role, and revoke removes it. `delete_role` refuses while an
  account holds the role, and names the account and its workspace.
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
It rebuilds the installation's sandbox roots (a copy of the account's grants) in a background
job; see "Sandbox roots" in `../plugin-system/SKILL.md`.
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
has no `public` arm. A file share also has a share row (see "Share rows" under "File sharing").

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
"You cannot use MCP servers in this workspace." Both checks also need `content.read`: MCP tools are
not files, so a guest (a member without workspace read) gets none. Ask mode never loads MCP tools,
whatever the role.
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
  It loads the selected saved placement. History and snapshot URL reads use the published folder
  scope at the group switch, before physical header cleanup.
- `access_control_db_authorize_file_write(ctx, { nodeId })` in `access_control.ts` for a **write target**, where `nodeId`
  is the node itself for a change to an existing node, or the parent folder for a new node or a move
  destination. `files_ROOT_ID` falls back to the workspace. An action cannot read the database, so
  actions ask the same question through `files_tree.get_current_user_file_write_permission`.

Rules that are easy to miss, all of which were real holes:

- **A write has three legs when it moves something.** The `files_transfer` Move worker, path-like `rename_node`, and reviewed pending Save
  check the destination *and* the node. Checking only one lets a grant on a single folder push files
  into a restricted folder. The third leg is `authorize_leaving_restricted_scope` in `files_nodes.ts`:
  taking a node out of the restricted folder it sits in changes who can read it, so it takes
  `content.permissions.manage` on that folder, not `content.write`. A folder that is the restricted
  scope itself carries its scope along and is not asked. Rename resolves paths from the node's own
  parent, then queues the shared `files_move_cohorts` worker. It checks the current and final scopes
  before publication. A name-only rename in the same saved parent
  needs the source grant. Reparenting or creating missing folders also needs destination write.
  `unarchive_nodes` restores a node to a new parent when its own parent is still archived, so it is a
  move and asks the same questions. It skips both of them for a node that is its own restricted
  scope, and that skip is deliberate — reviewers keep reporting it. The destination there is picked
  by this code, not by the caller, and a node carrying its own scope stays closed wherever it lands,
  so the move opens it to nobody; refusing would strand the folder where only its share list can see
  it. A node that only *inherits* a restriction does lose it at the root, so that one is asked both
  questions: the destination write and the leaving check. Asking only the first was a real hole — a
  write grant on a folder was enough to archive it and then restore one file out of it, which handed
  that file to the whole workspace while the shared Move core refused the identical move. Every case here has
  a test in `access_control.test.ts`.
- **A mutation an action calls proves its own permission.** Only a check inside the writing mutation
  runs in the same transaction as the write; a check in the action is advisory, because a role taken
  away in between still lands the write. So an internal mutation reached from an action asks again,
  in itself — `create_file_node` and `create_folder_node_by_path` both do. A mutation called by
  another mutation does not: it already runs inside the caller's transaction. Watch the brand-new
  path in particular: the node walk only checks nodes that already exist, so when nothing is there
  yet the workspace is the only thing left to ask.
- **A cascade is not covered by the node you named.** Archive checks every removed descendant.
  A Move group walks exact saved child ranges in background transactions. A nested restricted
  root moves along with its own people, even when the mover cannot open it, like a folder on Linux
  or Windows (decided 2026-10-18). Ordinary protected descendants travel with their rules
  unchanged.
  Replacement checks every descendant it hides. Existing Move and scope repairs finish before
  new planning uses stored scopes. Access changes advance the clocks that each group checks.
  Restrict, folder protection and Archive wait while any Move holds the workspace. Their walk reads
  only nodes no Move holds, so waiting is how it reaches every node. They do not poll: the Move's
  release wakes them.
  A move that keeps the same parent and path does not change descendants. A
  name-only rename in the same saved parent carries nested shares without asking for write access to
  each one. Reparenting through Rename carries them the same way.
- **Preparation grants no later access.** Every unpublished cohort transaction checks the active
  membership and its original lifetime, current run, purge state and access clocks. Final publication
  uses the same proof. Reserved sources and names reject competing content writes. Security writes
  may still revoke access. Stop or revoked access aborts unpublished work. A published group only
  finishes its already approved physical repair; it cannot add files or grant new access.
- **A paged Move proves access again.** `files_transfer.advance` loads the exact active membership
  lifetime once per transaction. Joined steps share that check. Stop and the deadline are still read
  on every step. `advance` waits for running path/scope repairs. The final root mutation checks
  the access-version pins and direct source/destination access. A leave and re-invite cannot
  revive the old run.
  Stop or lost access keeps completed roots and ends the remaining work.
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

**Plugin activities answer to the files they name.** `activities_feed_db_filter_visible` in `convex/activities_feed.ts`
is the one rule, used by `activities_feed.list_page`, `archive_activity` and `archive_all_activities`. One
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

**Comments answer to their file channel.** `channels_db_get_access` checks the channel's saved file:
`content.write` starts a post, replies, or resolves; `content.read` lists or gets comments. Current
file shares apply to every read. General comments and resolve ignore the file's write policy.
New text anchors also require permission to change the file. A hidden anchor becomes public only
after its mark is saved. File editors read each marked root and check that it belongs to this file.
See the [Channels spec](../channels/SKILL.md).

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
is a disclosure. This rule concerns Bonobo Senate plugin-store scopes. A plugin's separate database owns
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
- A draft move into a folder the user can no longer read never shows that folder in the user's
  paths. See `destinationAccessNodeIds` under "Pending Overlay" in
  `../files-agent-pending-updates/SKILL.md`.
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
- Human Messages channels use `channels_db_get_access` in `convex/channels.ts`. Public channels use
  workspace read/write access. Private and direct channels also pin each participant to their current
  workspace membership doc id. The owner can read both, but can post in a direct channel only as a
  participant. File channels check the live file ACL; their comments ignore the file write policy.
- `workspace.channels.manage` lets a holder rename, archive, and moderate public channels. It is in
  the admin role. It gives no extra private, direct, or file access. Role and invite ceilings compare
  the full list, so an admin-like custom role also needs this permission before it can grant admin.
- Chat threads are private to their creator. Every read and change also needs a current active
  membership (`permission: null` in `ai_chat.ts`), not workspace `content.read`: a
  guest can chat, and each file door checks the node. Team owners, admins, and writers have no
  override. Lists and branch title numbering use a creator-filtered index. Direct reads return
  null for another creator's thread. Mark-read changes only the creator's private read cursor.
  A viewer can manage its own chats; file writes still need their separate file permissions.

## Known gaps

These are real and confirmed against the code. None is an oversight to patch quietly: each needs a
product decision, so record the answer here before changing the behaviour. An entry that starts with
**Decided** already has its answer. Do not report it again as a finding.

- **Fixed: the public API serves a grant-only person.** The file scopes (`files:list`, `files:read`,
  `files:write`, `files:download`) no longer map to a workspace permission in
  `REQUIRED_APP_PERMISSION_BY_SCOPE`. Every file read and write checks the node for the person, so a
  guest's key uses the grants the UI honours. A person's write checks the target, or the deepest
  folder that exists on the way.
- **An outgoing owner keeps nothing.** The owner holds no grant docs anywhere — `restrict_node` skips
  the self-grant for them on purpose — and `transfer_organization_ownership` gives them the `member`
  role. A role gives nothing inside a restricted scope, so the moment they hand the organization over
  they lose every folder they restricted, and only the new owner can let them back in.
- **Decided: archiving a restricted folder stays at `content.write`.** A `write` grantee can archive
  the restricted folder itself, not only what is inside it, and that is intentional. They could
  already archive every child one by one — `archive_nodes` checks `content.write` per node on purpose
  — so refusing them the folder would mean "you may empty the room but not close the door". Archiving
  discloses nothing and changes nobody's read set. Leaving a restricted scope is the separate
  question, and `content.permissions.manage` guards that in Move and `unarchive_nodes`.
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
- **Decided: the search box pages can tell that a file you cannot open matches.**
  `files_nodes.search_saved` drops rows the caller cannot read after the search reads its page. A
  name or path hit whose folder the caller can open stays, as a locked row. So a member who calls it
  with a small page size and gets an empty page with `isDone: false` learns that some file they
  cannot open matches a content word, a public link, or a name word inside a locked folder. They
  never learn which file, its path, or its text. This is accepted: a full answer would need access
  filters inside the search index. Custom-field search (`search_saved_metadata`, through the walk)
  and the tree pages do not give this signal (see "Files tree reads").

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

## Locked, not hidden (decided 2026-10-17)

Files work like a file system. Everyone who can open a folder sees all of its items. An item they
cannot open is a **locked row**: name, type, size and created/updated dates only. Opening it answers
403 / "Permission denied". Inside a locked folder every path answers the same 403, whether it exists
or not. Recursive reads (`ls -R`, `find`, `tree`, API `recursive: true`) stop at locked folders and
say "Permission denied". One subject per request: a user or a service account, never both checked per
row.

**Why hiding was removed. Do not bring it back.**

- A full page under hiding needs rows per reader: the list can only skip what the reader cannot see if
  an index already holds "what this reader can see". That multiplies by files × readers, and every
  share change rewrites it. Reading a page and dropping rows instead gives short or empty pages and
  cursors that show where hidden rows are.
- A plugin list checks every row, because its sandbox roots have no share rows that an index could
  read. Under hiding that per-row filter gives short or empty pages.
- With locked rows, a folder list reads one index range for everyone. A recursive read only has to
  check the restricted folders on its way, not every row.

**What other systems do.**

- Windows: with "bypass traverse checking" (on by default) you can open a path below a folder you
  cannot list. A folder list shows all names; "access-based enumeration" (hiding) is an opt-in server
  feature that Microsoft documents as costly for large folders.
- POSIX / GNU: `ls` on a folder shows every name; opening an item you cannot read fails with
  `EACCES` ("Permission denied"); `find` prints `find: '<path>': Permission denied` and goes on. Samba
  has `hide unreadable`, off by default.
- Linux Landlock: a sandboxed process gets a set of allowed folders (roots) on top of its user's
  rights. Plugin requests work this way here: every file check of a plugin run, page or service
  grant also needs one of the installation's sandbox roots (see "Service accounts").
- Do not add a hide switch (access-based enumeration) to Files. It brings back every problem above.

**The leak rule.** A locked row is visible; its content, custom fields and members are not. Any output
that changes with a locked row's custom field or content leaks it, including which rows show, page
size, empty pages, cursors and reactive reruns.

**Locked or missing.** The path and id lookups still answer `null` for both, so a caller that does
not ask fails closed. After a `null`, a surface that must say "Permission denied" asks
`files_db_get_path_access` (`server/files.ts`; internal query `get_path_access` in `convex/files_nodes.ts`, page
query `get_path_access_for_membership`) or, by id, `files_tree.get_file_node_access_for_membership`.
`locked` means the item exists and the subject cannot open it, or the path is below a folder they
cannot open (a missing name there is locked too). `missing` means nothing is there and the nearest
folder is readable. The path helper sends the node only when its parent is readable.

**The search rule.** Search returns a locked item only for a name or path match, and a name match
only where a recursive read would reach it. Custom-field searches read by restricted area (see "The
walk"). Accepted exception: content (text) search filters after the search
index; its page shape can show only that some unreadable file matches, never which one.

**Guests.** A guest is an active member without workspace `content.read`. They open only what is
shared with them. The workspace root is locked for them: Bash `ls /`, `ls -R /`, `find /` (also with
`-name`), `tree /` and API `files/list` of `/` (also `recursive`) say "Permission denied" (403), so
they reach a shared item by its exact path. The UI root page shows nothing for them, including with
a custom-field filter; they use "Shared with you". The UI search box still searches from the root
and finds only what they can open. Their
agent can `cp` and `mv`: each item checks read on its source and write on its destination. Chat, the agent's file tools
and the public API file routes need only the active membership; each file door checks the node.
Plugins stay closed to guests: MCP tools, volume mounts (`list_bash_volume_mounts`,
`files_db_authorize_volume_read`), `/.plugins` source mounts (`list_bash_source_mounts`), plugin
skills in chat, plugin pages, plugin data and backend invoke still need workspace read or write.
`/.mounts/t3-chat` stays open. For a guest, the content search exception above covers the whole open workspace, since
they cannot open any open file. It still never names the file.

Sources:

- NTFS rights: https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants
- Folder rights, traverse, list: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2003/cc787794(v=ws.10)
- File security: https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights
- Bypass traverse checking: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/security-policy-settings/bypass-traverse-checking
- Raymond Chen on bypass traverse: https://devblogs.microsoft.com/oldnewthing/20200113-00/?p=103322
- ABE concepts and cost: https://learn.microsoft.com/en-us/archive/blogs/askds/access-based-enumeration-abe-concepts-part-1-of-2 ,
  https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2003/cc784710(v=ws.10) ,
  https://support.microsoft.com/kb/2732618
- Samba `hide unreadable`: https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html
- POSIX / GNU: https://www.gnu.org/software/coreutils/manual/html_node/Mode-Structure.html ,
  https://man7.org/linux/man-pages/man7/path_resolution.7.html ,
  https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html ,
  https://man7.org/linux/man-pages/man1/ls.1.html , https://man7.org/linux/man-pages/man1/find.1.html
- Linux Landlock: https://docs.kernel.org/userspace-api/landlock.html
- Google Drive limited access: https://developers.google.com/workspace/drive/api/guides/limited-expansive-access

## Files tree reads

The sidebar loads the tree one open folder at a time through the `files_nodes` queries below. All of
them resolve the reader with `files_nodes_db_get_tree_reader`. A node the caller cannot
`content.read` shows only as a locked row (see below). `files_share_links.list_workspace_links` resolves its reader with the same helper.

- `files_nodes_db_get_tree_reader` requires a live `users` doc before reading membership. Missing auth or a
  missing user throws `Unauthenticated`. An anonymous user with `deletedAt` does too, even when
  the supplied membership is inactive. The helper keeps the caller's auth kind.
  It returns `null` for an inactive or foreign membership and for every refusal
  except "Permission denied". "Permission denied" means the member has no workspace-wide read, so the
  queries continue in grant-only mode and show only what was shared with them.
- `list_tree_children` pages one kind of child of one folder, with the same open stream and
  restricted twin as `list_tree_children_sorted` below. A missing or foreign parent, or one the
  caller cannot open, gets the same empty, done page as any other refusal. That page only means
  "cannot open": a locked folder still shows as a locked row in its parent. A grant-only member gets
  nothing for the root: their root rows come from `list_tree_shared_roots`. The public `files/list` route answers
  instead: a missing or archived folder gets 404 `Folder not found: <path>`, and a locked folder gets
  403 `Permission denied: <path>` (see the public-api skill). A member who can read only
  `/Clients/Acme` gets that 403 for `/Clients`.
- `get_tree_ancestors` takes a raw id string, so a bad `?nodeId=` returns `null` instead of an argument
  error. It walks up from the node and stops at the first folder the caller cannot read, because the
  tree cannot open a locked folder. This hides no names: every tree row carries its
  `path`, `parentId`, and `restrictedScopeNodeId`, the same as `list_tree_children` rows, so a shared node's
  path still names the locked folders above it.
- `list_tree_shared_roots` pages every share of the member for the "Shared with you" group, one
  principal at a time (see "Share rows" under "File sharing"). It has no cap: it reads the share
  rows with one index range per page and checks each row like `list_tree_children_shared`. The owner
  gets nothing, because the owner reads the whole tree.
- `list_tree_children_sorted` (the sorted Files table) uses the same folder gate, and a grant-only
  member gets nothing for the root. It reads saved rows only (see the `files-explorer-tree` skill,
  "Saved-only lists"). Each stream is one kind and either the open or the restricted children:
  - Every row a stream reads is returned, open or locked. No row is filtered after paging, so a page
    is full. A row the caller cannot `content.read` comes back as a locked row: `locked: true` and
    only its name, path, parent, kind, type, size and dates (`files_tree_locked_row_fields`). No
    metadata, updater or members. An open row has `locked: false`. `files_tree_db_get_list_rows`
    builds both, for `list_tree_children` and `list_tree_children_sorted`.
  - The open stream reads only rows with `isRestrictedScopeRoot: false`. A row whose scope pair
    (`restrictedScopeNodeId`, `extendedScopeNodeId`) equals the folder's, or that is its own
    extended root on top of the folder's pair, is readable by anybody who can read the folder, so it
    needs no check. Any other row (a scope or move job has not reached it yet) gets a full check
    (`files_tree_db_get_locked_node_ids`). The checker caches each scope, so each pair costs reads
    once.
  - The restricted twin reads the rows with `isRestrictedScopeRoot: true`, for every reader, and
    checks each row. The tree queries always check as a person, never as a plugin.
  - Every returned row must match its stream: the reader's organization and workspace, right
    parent, active, and both `isRestrictedScopeRoot` and `restrictedScopeNodeId === _id` equal to
    the stream's `restricted`.
    A mismatch throws `should_never_happen`, because a stale flag would put a row in the wrong stream.
  - Name, size, dates and extension show on a locked row, so built-in sorts and filters read the
    twin like the open stream.
  - A custom field is never read for a locked row. Only the owner reads the twin by a custom-field
    value. For a custom-field sort, other readers get the twin by name, as a trailing group after
    the value rows (`parts: [null]`). For a custom-field filter, their twin is refused and they read
    `list_tree_children_shared` instead. In the open stream a custom-field page leaves out a row
    that comes back locked (job lag), so its value never places it.
- `list_tree_children_shared` gives a member the restricted children shared with them that match a
  custom-field text filter, one share stream per principal, for the table. It reads no drafts. The
  owner, and any other order, gets an empty, done page.
  - A non-owner can read a restricted scope root only through a user or role `content.read` grant
    on it, so the share rows hold every candidate. Scanning the folder instead would not scale: a
    folder of one private folder per person has thousands of restricted children.
  - The server builds the `principalKey` from the caller (`principalIndex` 0 is the user, 1 and 2
    their roles from `access_control_db_resolve_role_refs`), never from the client. A role the
    member does not have gets an empty, done page.
  - A member's filtered page must never depend on a custom field they cannot read. Otherwise a cut
    would move when a locked child's value changes and leak that value. The stream reads only the
    member's share rows (by name), then each row's own committed field doc, so a locked child's
    value never changes a page, its cursor, or its length.
  - A share row is a copy, and a grant can outlive the access, for example a plugin grant whose
    membership ended. So each row is checked again: its node must be a restricted root of the
    reader's organization and workspace, still under this parent, active, and readable. A plugin
    grant's row must also carry the member's live membership lifetime, so after a re-invite the old
    grant reads nothing, even while another grant keeps the node readable. A row that fails, or
    whose field doc does not match, is dropped, so a page can be short.
- A folder that the caller can read but that is archived gets empty pages, not a refusal, so the
  table shows no error there.
- `isRestrictedScopeRoot` on `files_nodes` is a stored copy of `restrictedScopeNodeId === _id`, and
  committed metadata field docs carry the same copy. `files_nodes_db_set_restricted_scope` writes
  both whenever a node is restricted or unrestricted. The node streams of `list_tree_children` and
  `list_tree_children_sorted` throw `should_never_happen` when a node's flag does not match the range
  it came from. The metadata stream leaves out a field doc whose node is archived, has another
  parent, or has another flag: a background job copies the node's scope onto its docs later, so the
  page can be short. A node of another workspace still throws. The share streams
  need no such guard: they check every row.
- `files_metadata.list_folder_fields` checks active membership and folder `content.read`, then reads
  one range of the metadata catalog's `parent` family. The root needs workspace read; a grant-only
  member gets an empty, done page there. A readable archived folder, a missing folder and a denied
  folder get the same empty, done page. Like the folder table, it has a restricted twin
  (`restricted: true`, the `parent_restricted` family) that only the owner reads. So the keys of a
  restricted child show to the owner only, also when the child is shared with a member. A field doc
  without the `isRestrictedScopeRoot` copy counts in the twin (fail closed).
- **Metadata suggestions read one area.** `list_search_fields`, `get_search_field` and
  `list_search_values` read the metadata catalog, which counts saved keys and values with no access
  data, so the door picks the rows. The owner reads the whole workspace (`key`, `value`). A member
  reads the `area_*` rows of the area their `folderPath` is in: the open area (needs workspace read),
  or a restricted area R (needs `content.read` on R itself, so added people inside R get nothing).
  One area per call; a member never reads rows of an area they cannot open, and every refusal gets
  the same empty answer. A grant change writes no catalog row. After a restrict the area rows follow
  the saved scope job ("late is fine"). `list_folder_fields` shows restricted children's keys to the
  owner only (see above). See the `file-metadata` skill, "Suggestions".
- `files_metadata.list_node_fields` and `get_field_values` check the node on every call: they load
  the saved node, check tenant and active state, then `access_control_db_authorize_membership(...,
  { fileNode })` with `content.read`. A private target or a refusal returns null, including after a
  grant is revoked. A prior shared row never grants access. They read committed docs only; a doc of
  another node or tenant throws instead of becoming a key name or a value. These queries keep
  whole-query byte and call budgets, and throw when no field can finish. They do not scan hidden
  child partitions to decide a catalog cap. Columns are personal browser preferences; choosing a
  key does not publish its name as shared folder settings.
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
  tell a reader that a folder holds files they cannot see. A child they cannot open shows as a
  locked row instead (see `list_tree_children` above).

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
- Until a scope job writes a child, the child keeps its stored scope. Every permission check, for
  reads and writes, trusts that stored scope. So a child of a newly restricted folder keeps its old
  access until the job rewrites it. This short window is accepted on purpose. Do not patch it by
  reading the parent folders: that does not scale, and it breaks the simple rule that a node's access
  comes from the scope stored on it. A Move publishes its nodes and inherited scopes together through
  the selected saved view.
- A child of an unrestricted folder is different: it still points at that folder, which is not its
  own scope any more (a **dead pointer**). `unrestrict_node` gives the folder the scope stored on its
  parent, so `access_control_db_resolve_live_restricted_scope` follows the dead folder's own pointer
  to the next restricted folder above. So during the job a child of `/outer/closed` still answers to
  `/outer`'s grants, not to workspace read. A folder above can be unrestricted too before its own
  job reaches the dead folder, so the reader follows up to 8 dead folders. Past that it keeps the
  stored scope, which stays closed: the unrestrict deleted its people and role grants. A pointer
  chain that ends at `null`, at a deleted node, or in another workspace means open. Every reader of
  the stored pointer uses this one helper: the permission check, the list filter,
  `access_control_db_can_act_on_file_node`, the service account grant state, and
  `get_node_share_state`.
- Grants are always written on a **scope root**: a restricted root, or an extended root (see "Add
  people" below). A grant on any other item makes that item an extended root first.
- Three levels — `read`, `write`, `manage` — each a superset of the last, saved as one grant doc per
  permission. `access_control_FILE_SHARE_LEVELS` is the source of truth.

### Add people

Any file or folder can get added people, open or inside a restricted folder. The item becomes an
**extended root**. Its added people get the item and everything inside it, except restricted items
inside it. Everybody who had access before keeps it: added people only add access.

- Fields on `files_nodes` (and on Move places): `extendedScopeNodeId` is the nearest extended root at
  or above the node, below its restricted root, or `null`. A restricted root has `null`. An extended
  root points at itself and also stores `parentExtendedScopeNodeId`, its parent's
  `extendedScopeNodeId`. The field exists only on extended roots, so "is an extended root" is
  `parentExtendedScopeNodeId !== undefined`. Every writer uses one rule: `extended = restricted ===
  self ? null : isExtendedRoot ? self : parent.extendedScopeNodeId`.
- Writers: `set_node_share_grant` (people and roles) and `access_control_db_set_service_account_grant`
  (accounts) make the item an extended root, then start a scope job (`files_subtree_ops_db_start_rebuild`,
  kind `scope`) for the items inside. Both check every refusal before any write, so a refused share
  leaves no extended root. `remove_node_share_grant` makes the item plain again when its last grant
  goes, and starts the job. The account writer is used inside `access_control.ts`, a light module, so
  it extends through `ctx.runMutation(internal.files_subtree_ops.extend_node)` (same transaction).
- The check (`access_control_db_extended_chain_allows`): when the restricted or workspace check
  fails, follow `extendedScopeNodeId`, then each root's `parentExtendedScopeNodeId`, and ask each
  root for a grant. A pointer at a node that is no longer an extended root (its job still runs)
  follows that node's own pointer, at most 8 dead hops in a row. The chain stops closed at a missing
  node, another tenant, a root not above the node, or a root in another restricted area. There is no
  depth cap: the 500-level cost test in `files_sharing.extended.test.ts` stays under the limits. The
  checker caches each root's answer per request.
- Levels: added people get **Can view** or **Can edit** only. `manage` is only on a restricted root
  or from the workspace, so `content.permissions.manage` never comes from the chain. Message:
  `access_control_ADDED_PEOPLE_LEVEL_MESSAGE`.
- **Restrict starts alone.** `restrict_node` on an extended root deletes its grants first (accounts
  through the account writer with `level: null`, so plugin folders stay in sync), then gives the
  caller `manage`. The plugin binding restrict does the same for accounts.
- **Unrestrict keeps accounts.** `unrestrict_node` deletes people and role grants. Account grants stay,
  so the item becomes an extended root, and a kept `manage` is lowered to `write`.
- A Move keeps an item's added people: an extended root moved into a restricted folder still gives
  its people that item. Items inside it take the chain of their new place.
- `get_node_share_state` returns `access` (`restricted_root`, `extended_root` or `inherits`),
  `canAddPeople`, `entries` (the grants on this node only), and `inheritedFrom`: the restricted root
  (`null` means everyone in the workspace) and the extended roots above, nearest first. Inherited
  names are sent only to a caller who manages the node or reads the whole area (its restricted root,
  or the workspace when it is open). A person who gets in only through added people must not learn
  who reads the folders above. The dialog shows one line per folder above (with its names and
  "Manage on <name>" only when they were sent), then "Added here" with this node's entries. It offers
  "Can manage" only on a restricted root, and Restrict asks first, with the count of people added here.
- History: one-time migrations moved every old file grant onto a scope root. A
  grant on an open item made it an extended root; a grant on a plain item inside a restricted folder
  gave nothing (a dormant grant) and was deleted; a `manage` grant on an extended root was lowered to
  `write`.

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

### Share rows

`files_share_rows` holds one row per share, so a member's shared items can be paged with indexes like
the folder table. Code: `packages/app/server/files-share-rows.ts`.

- A share is a file `content.read` grant to a user, a role or a service account. Its row lives while
  the grant lives and its node is a scope root (restricted or extended) in the grant's organization
  and workspace, active or archived. A public grant has no row. "Shared with you"
  (`list_tree_shared_roots`) lists both kinds; the custom-field filter streams
  (`list_tree_children_shared`) list restricted roots only, by name
  (`by_org_ws_principal_parent_kind_archive_sortName_name`).
- `principalKey` is `user:<userId>`, `role:<role>` or `service_account:<serviceAccountId>`. A role
  share is one row, not one row per member.
- A row copies the node's list fields (parent, kind, archive, names, `treePath`, `updatedAt`,
  extension, size, creation time) and the grant's `externalPluginMembershipLifetime` (`null` when
  missing).
- A re-invite schedules `plugins_external_files.delete_old_reader_grants`, which deletes the member's
  plugin reader grants of older lifetimes in that workspace (100 a page), so their rows go too. Until it
  ends, the share readers drop those rows.
- Nothing writes rows by hand. The pending overlay flush keeps them true in the writer's transaction
  (grants are one of its source tables): a file grant insert, patch or delete syncs that grant's row,
  and a write to a node that is or was a scope root syncs the node's rows. Outside a Move another
  node has no rows. A node a Move holds can be a root in one view only, so it syncs when it has rows
  and a copied field changed (one `by_node` range). A restore or scope job
  writes a new `treePath` through the flush. A move or rename of an ancestor changes `treePath`, and its Move cohort syncs each node it writes.
- A node sync reads the node's `content.read` grants in the node's own workspace with one range
  (`by_resource_permission`). The share caps (`MAX_FILE_SHARE_PRINCIPALS`, 50 people and roles, in
  `files_sharing.ts`, the same 50 with service accounts in
  `access_control_db_set_service_account_grant`, and `MAX_READERS`, 50 plugin readers, in
  `plugins_external_files.ts`) bound it to about 100 rows.
- Move stages share docs in pages before the group switch. Ordinary selections and connected
  Pending Save groups use the same worker. Share docs count in each transaction's measured
  budget. They do not create a total selection cap.
- After a dashboard edit or `convex import`, run `files_pending_overlay:check_share_rows`
  (organization, workspace, `cursor: null`; call again with the returned cursor until it is null).
  There is no repair door. To fix drift, write a one-time mutation that calls
  `files_share_rows_db_sync_grant` (`server/files-share-rows.ts`) for each reported grant.
- Data deletion: see `../data-deletion/SKILL.md`.

### The walk

Recursive reads (`ls -R`, `find`, `tree`, `meta search` `eq` / `exists`, the API's `recursive: true`
and the search box's custom-field search) walk the tree one restricted area at a time, so they never
read a row under a folder the caller cannot open. Code: `server/files-tree-walk.ts`, run by
`files_pending_overlay_list` (Bash, search box) and `files_saved_list_page` (API).

- An **area** is all nodes with the same stored `restrictedScopeNodeId` (`null` for open content).
  Whoever can open an area's root can open every row of it, so a frame reads its rows with no check
  per row. A row a scope job has not reached yet still points at its old area; it gets its own check
  (locked in `ls` and the API, dropped from `meta search`).
- A **boundary** is a node with `parentScopeNodeId` set: a live restricted root, or a former root
  while its unrestrict op runs. `parentScopeNodeId` is the scope of its parent (`null` for an open
  parent), on the node and on Move places. Index: `files_nodes.by_org_ws_parentScope_archive_treePath`
  (`files_saved_places.by_parent_scope_archive_tree` for a Move view). A root's `scopeOpId` names its
  newest scope op, and that op's end clears `parentScopeNodeId` from a former root. A file has no op,
  so it loses the field at once. A Move of a former root drops it at the new place.
- Each frame reads two kinds of streams, each one internal query with one `.paginate()`: the rows of
  its area (`by_org_ws_scope_archive_*` on `files_nodes`, `by_view_scope_archive_*` on Move places,
  the `_scope_tree` metadata indexes) and its boundaries. Only the top frame is read (depth first).
  At a readable boundary the walk enters a new frame. At a locked one it lists the locked row and a
  "Permission denied" path, and reads nothing under it. A locked former root's old area stays closed,
  with no line.
- Locked items show only when the folder that holds them is readable. Every frame root is, except the
  workspace root: a guest with one shared folder, or an account with no grant, cannot open it. That
  frame lists only what the caller can open, with no locked rows and no "Permission denied" lines,
  like the folder list of the root. The walk still enters the readable roots it meets there.
- Rows under a folder the user's drafts hide are skipped as a range: the rows stream answers the
  folder's end as its frontier (a key of only a path), so the walk does not read the rest of it.
- The cursor holds the start folder's `treePath`, the top frame's root (`nodeId`, `treePath`) and one
  key. `files_nodes.resolve_walk_stack` / `files_visible.internal_resolve_walk_stack` rebuild the
  frames above by following `parentScopeNodeId`, once per page, in the view the frames came from. It
  is its own query, apart from the start folder's check (`internal_get_walk_start`), so the two read
  budgets do not add up. A rename or a lost grant on the way answers "The folder changed since the
  last page. Run the command again." (Bash: rerun without `--cursor`).
- A page stops at its row count or at 64 stream calls (`files_tree_walk_MAX_CALLS`). The Bash merge
  can run the walk once per round; its walk streams share that one budget and keep the frames in
  memory between rounds. Each call moves forward, so a page over many small restricted folders can
  be short; the next page goes on.
- A name search hit shows only when the walk from the search folder would reach it: every restricted
  folder between them is readable (`internal_search_name_saved`, one check per area per page). A guest
  added inside a locked folder finds names by searching from that folder.
- `server/files-tree-walk.test.ts` checks the read cost and the cursor size at 500 nested restricted
  folders against the Convex limits, without drafts (the API view).
- Known limit with drafts (the Bash view): the draft reader resolves every folder on the path. A list
  that starts a few dozen restricted levels deep answers "Listing is too broad", and a name search
  through a few hundred levels runs out of reads.
- Custom-field `prefix` / `range` keep value order, so they cannot walk. A member reads the open area
  only, and a folder is refused. The owner, plugin volumes and GLOBAL workspaces read every area.
- Known gap: `find --content-type` keeps its old type indexes and does not walk yet.

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
- The doc also stores `restrictedScopeNodeId`, the file's stored scope when the link was turned on.
  `by_organization_workspace_scope` finds every link of one area. The field never leaves the server.
- `createdBy` and `createdAt` are display data. The link does not depend on the creator's
  membership, role, or account.
- A workspace has at most 500 links (`files_share_links_MAX_PER_WORKSPACE`). This is a code bound
  on query and cleanup cost, not a quota.

### Turning it on and off

`files_sharing.set_node_share_link({ membershipId, nodeId, enabled })` returns a Result.

- It charges `files_sharing_write` first.
- Both On and Off need an active membership and `content.permissions.manage` on the file's
  **stored** scope. No check walks the folders above. While a scope job runs, a file it has not
  reached keeps its old scope, so a manager of the old area can still turn its link on. The job
  ends that link when it writes the file (see "Lifecycle" below).
- On also needs all of these:
  - a signed-in user, not an anonymous one ("Sign in to create a public link"). So an anonymous
    upgrade never has to find and secure links;
  - `content.read` on the stored scope. Nobody publishes what they cannot read;
  - every check in `files_share_links_db_check_live_file`: the node is a file, not a folder, and is
    not archived; the organization and workspace are live (see check 4 below); the scope node is
    live (`db_check_scope`, below); a finished asset; and a supported text shape;
  - fewer than 500 links in the workspace.
- `db_check_scope` reads the stored scope node and its plugin bindings, at most 5 docs. `dead`
  means the node is gone, in another tenant, or no longer its own restricted root, and On refuses
  with "Wait until the access change of a folder above finishes". `bound` means a plugin decides
  who reads the area, and On refuses. A null scope is always fine.
- Off needs only the manage permission. It skips On's file checks, so a manager can turn a link off
  while a job runs or after the file is archived. A missing link is a success.
- Agents, bash tools, API keys, and `/api/v1` never reach this mutation.
- `get_node_share_state` returns `link: { token, createdBy, createdAt } | null`. Only a caller with
  `content.permissions.manage` on the stored scope gets the link. Every other reader gets
  `link: null`.

### What the public view checks on every read

`files_share_links.get_share_link_view({ token })` never reads `ctx.auth`. Every refusal answers
`null`, so a wrong token, a turned-off link, an archived file, and a deleted workspace look the
same. **A link checks only the file's stored state and its scope node, with a fixed number of exact
reads and no folder walk. It ends when a job writes the file, or at once for its whole area when its
scope node changes.** So every read checks:

1. The doc exists. Its node exists, is a file of the doc's organization and workspace, and is not
   archived.
2. The file's stored `restrictedScopeNodeId` equals the doc's.
3. `db_check_scope` answers `ok`: the scope is null, or the scope node is a live restricted root of
   the same tenant with no `plugins_file_access_bindings` doc and no attached
   `plugins_external_file_bindings` doc (`detachedAt === null`). A plugin reader list would be
   bypassed by a public link.
4. The organization and workspace exist, the workspace has no `pluginDataPurgeStartedAt`, and
   `data_deletion_requests` has no doc for the organization and no doc for this workspace. Both
   are exact lookups: a deletion of another workspace in the organization does not hide the file.
5. The file's asset belongs to the same tenant, has an `r2Key`, and has no
   `unfinalizedExpiresAt`. The stored text shape matches the content type. A stored blob with an
   editable text type and `textKind: null` cannot be shared.
6. The whole view stays inside a read budget (1,500 calls, 16,000 docs, 8 MiB) and returns at most
   1,000,000 bytes. Past a budget the view refuses, or the rest of the embeds show as unavailable.

A folder above that is archived, restricted, or bound while its job runs does not hide the file at
once. The file shows until the job writes it, and that write ends the link. These windows are an
accepted product rule. The one exception is the scope node itself: a change to it ends every link
of its area in the same transaction.

The query is reactive. A change to the doc, the file, its scope node, or an embed runs it again, and
an open page clears when the answer turns `null`.

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
4. E is not archived and has a finished asset.
5. **Same audience:** E's stored restricted scope equals D's stored restricted scope, so D's scope
   check answers for E too. Both are open to
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
- `files_share_links_db_delete_for_scope` deletes every link whose stored scope is one node, on
  `by_organization_workspace_scope`. It reads at most 501 docs and throws past 500, which the
  workspace cap makes unreachable. Call it when the node becomes or stops being a restricted root,
  or gets a plugin binding: the files inside keep the same scope id then, so no job deletes their
  links.

A link inside a folder never needs a walk to end. Each job that changes the files below a folder
ends each file's link when it writes that file. Only the scope node's own change needs the area
delete.

Both skip global, plugin-volume, and reserved scopes, which never hold links. The module imports no
lifecycle or access-control module, so every caller can import it without a cycle.

| Event | Where the delete runs |
| --- | --- |
| Turn the link off | `set_node_share_link` with `enabled: false` |
| Restrict or unrestrict the file or a folder above it | `files_nodes_db_set_restricted_scope`, only when the scope really changes, before the patch: the node's own link and every link of its area (`delete_for_scope`). This covers `restrict_node` and `unrestrict_node`. A restrict then unrestrict before the scope job reaches the file does not bring the link back |
| A scope job gives the file a new scope | `files_nodes_db_rebuild_node`, only when the scope changes. A new path alone (a folder above was renamed) keeps the link |
| Move to another folder, including replacement and a new parent created by the same Move | The cohort worker stages link revocation for reparented roots and replaced occupants in pages. The group switch ends their links. Rename in the same folder keeps links. Move ends a link even when the new folder has the same audience |
| Archive | `files_nodes_db_archive_node`, once per stamped node. `files_nodes_db_archive_nodes` stamps only the nodes it is given, so a caller names a folder with all its active descendants, or uses the archive job. The archive job ends each file's link in the apply step that stamps it, and the apply has no stop: user deletion waits for it (`db_drain_user_archive_runs_batch`). A queued, refused, or stopped check keeps the links |
| Restore from the archive | `files_nodes_db_restore_node`. A restored file comes back with no link |
| Archive-and-create replacement | The archive helpers above. This covers a replacing upload (`create_upload_node`, `create_upload_nodes`, `/api/v1/files/upload-urls`, `data_import`), `/api/v1/files/write` over a stored file, and plugin and service paths that archive and recreate. The new file has no link |
| Remove a failed file creation | `files_nodes_db_hard_delete_node` |
| A plugin reader list takes over a file or a restricted folder | `plugins_data_db_apply_file_access_binding`: the node's own link and every link of its area. A folder must already be a restricted root whose scope job has ended and that holds no restricted folder, so its area is the whole folder. A file binds in one step, and the restrict in the bind ends its link |
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

- A plugin binding that is detached or cleaned up (`db_detach_file_access_binding`,
  `db_sync_file_access_bindings` with `removeUserIds: "all"`, and the uninstall binding drain).
  A bound area holds no links, because the bind ended them and On refuses there, so there is
  nothing to end.

A file node that is gone or archived without a hook still shows nothing, because the view reads
the file on every read.

**A bound area holds no other restricted item.** A bound area is an area whose scope node has a
plugin binding. The plugin decides who reads the whole area. A restricted item inside would have its
own reader list, and once it has no binding of its own it could get links again. So these refuse:

- `restrict_node` on an item inside a bound area, or on an item that a Move has staged into one
  (its "after" place): "A plugin decides who can read this item, so it cannot be restricted on its
  own".
- A Move that puts a restricted item, or a folder that holds one, into a bound area
  (`files_move_cohorts.ts`, checked for every moved node that lands in a new area): "A plugin
  decides who can read the destination, so a restricted item cannot move there." A destination
  folder that does not move is not checked.
- A restore that brings a restricted item back into a bound area (`db_land_node` in
  `files_archive_runs.ts`): "A plugin decides who can read the folder it comes back to, so a
  restricted item cannot be restored there."
- A bind inside a bound area, for an existing node, a new one, or one a Move has staged into a bound
  area (`plugins_data_db_prepare_file_access_binding`
  and `plugins_external_files.ensure_writer`): "A plugin already decides who can read the folder
  around this item".
- A bind of a folder that holds a restricted item, read on
  `by_org_ws_parentScope_archive_treePath` and, while a Move holds the workspace, on both Move views
  of `files_saved_places`.

Data from before these rules may still hold a restricted item inside a bound area. On 2026-10-20 the
dev deployment had none.

### Seeing links inside Files

`files_share_links.list_workspace_links({ membershipId })` returns
`{ nodeId, createdBy, createdAt }[]` for the linked files the caller can read. It feeds the link
mark in the Files tree and the `file.link:public` search filter.

- Missing current-user auth throws `Unauthenticated`. A bad membership or tenant answers `null`.
- A member with only file grants (no workspace `content.read`) is allowed, like the tree reader:
  it filters with the person subject, and an open node needs the workspace permission, so a guest
  keeps only its granted files.
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

Paths that deliberately write **none**:

- `organizations_db_create` and every personal-organization creation in `data_deletion.ts` — the
  creator becomes the owner, and owners hold no assignment.
- `organizations_db_create_workspace` — the creator's organization role already reaches the new
  workspace.
- `users.resolve_user` — reclaiming a deleted account reactivates its ordinary inactive memberships,
  but skips memberships marked `pendingOrganizationRemoval` because that separate drain still owns
  them. The assignments survived retention, because `delete_role` lowers an inactive holder instead
  of deleting it.

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
  `/api/chat` and background jobs need only the active source membership in both modes, so a guest
  can chat. A team viewer can use Agent mode in their own home. Each file door checks the selected workspace, the current
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
  Their folder layout belongs in their repository; Bonobo Senate does not recognize their private groups.
  If the different answers become a product concern, collapse them as `create_upload_nodes` does.
- **The folder import widens that oracle's budget, on purpose.** `files_nodes.create_upload_nodes`
  reports per-item skips, and a skip is the same class of probe. The payload never says why: a
  permission refusal and a user-chosen skip both answer the one literal `"conflict"`. Each item is
  charged one `files_bulk_import` token (rate 100/min, capacity 300, per user), so the burst budget
  is 6× the single-file create oracle and sustained is 2×. The companion query
  `files_nodes.get_upload_conflicts` cannot be rate-limited (queries cannot charge the limiter), so
  it filters by per-node `content.read` and answers "no conflict" for anything the caller cannot
  read — it must never reveal more than the tree pages (`list_tree_children` and the share streams)
  do. The other skip reason, `"path_blocked"`,
  says what kind of node blocks the path, so the mutation only answers it when the caller can
  `content.read` the blocking node; a locked folder at the target and a locked file at an ancestor
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
- `packages/app/convex/files_share_links.ts`, `packages/app/convex/files_share_links_db.ts` (+ `files_share_links*.test.ts`)
- `packages/app/convex/access_control.test.ts`
- `packages/app/convex/organizations.test.ts`
- `packages/app/convex/data_deletion.test.ts`
- `packages/app/src/routes/w/$organizationName/$workspaceName/roles/index.tsx` (+ `index.css`, `index.test.tsx`)
- `packages/app/src/routes/w/$organizationName/$workspaceName/users/index.tsx` (+ `index.test.tsx`)
