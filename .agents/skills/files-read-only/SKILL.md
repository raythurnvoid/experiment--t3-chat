---
name: files-read-only
description: Spec for file write policies, selected human and service-account writers, parent policy checks, policy management, accepted-upload completion, exact-key R2 deletion jobs, and the stable read_only conflict. Use when changing file write checks, creation, moves, pending work, snapshot writes, public file doors, or the Files policy controls.
---

# Mental Model

File access and write policy are separate checks. Access control decides whether the current actor
and any bound service account have the requested permission. A write policy then limits which writer
may change the node. Selecting a writer grants no file access.

The writer is either a human user or a service account. Ordinary app, agent, and Bash operations use
the human. A service-bound key or plugin backend uses its bound account, with the current human actor
as a separate permission ceiling. Plugin names, labels, run IDs, and upload targets do not identify a
writer. They remain separate integration constraints.

Every policy above a node applies. A matching local writer cannot override a different parent writer
or a read-only parent. Owners and admins do not bypass policy. Management permission lets them change
the policy through the common setter. Named tenant, workspace, and account deletion flows remove
their whole scope and remain lifecycle exceptions.

Folder policies cover active and archived descendants. A descendant that refuses the current writer
also blocks operations that would rename, move, archive, or replace it through an ancestor. Readable
files may still be copied out. A copy follows its destination policy and existing sharing rules.
The synthetic root has no local policy.

# Data Model

`files_nodes` stores these fields beside `restrictedScopeNodeId`:

- `writePolicy`: `null` inherits; `{ mode: "read_only" }` blocks content writes;
  `{ mode: "writer", writer }` selects one human or service account.
- `writePolicyScopeNodeId`: `null` means no local or inherited policy. The node's own ID means it has
  a local policy. Another ID points to the nearest parent policy. Cascades use stored parent IDs,
  include archived descendants, and stop at nested local policies.

The writer value is `{ kind: "user", userId }` or `{ kind: "service_account", serviceAccountId }`.
An empty local choice keeps the parent's current pointer. A new local choice points to the node
itself. Moving or restoring a node updates inherited pointers; a local policy stays local and still
checks the new outer parents. Policy writes do not change `updatedAt` or `updatedBy`.

There is no policy history counter. Every final write checks the current policy. A past refusal does
not make later work stale once the current writer is allowed. Credential, ACL, scope, and content
staleness checks still apply. Editable `plugin-name` metadata changes neither policies nor grants.


## Upload fields

On `files_r2_assets`:

- Each external attempt gets a fresh asset ID and writes directly to its canonical `assets/<assetId>`
  key. The signed `If-None-Match: *` header prevents overwriting an existing object. Keep `r2Key`
  unset until the final mutation confirms the stored bytes and publishes their size and etag.
- `uploadUrlExpiresAt` stores when the signed PUT URL expires. Cleanup uses it to know how long another
  PUT may still arrive. It becomes `putMayArriveUntil` on the deletion job. An older asset without this
  field uses `unfinalizedExpiresAt` as a safe fallback.
- `unfinalizedExpiresAt` means the asset is not fully published, or its cleanup is still open. Clear it
  only after publication creates a live reference, or after cleanup reaches a confirmed final result.
  Having an `r2Key` alone is not enough.
- `uploadRetiredAt` fences a retained service placeholder after terminal cleanup starts. A late event
  cannot publish it. A service retry always creates a new asset and never clears this marker.

## R2 deletion jobs

`files_r2_object_deletion_jobs` stores cleanup work for exact R2 keys. It exists because the R2
component retries only a limited number of times and does not report final success. Starting its
delete flow does not prove that the file was deleted.

- Keep one live job for each exact key. A new cleanup handoff or a new R2 object-create event increases
  the job's `generation`. Delivering the same event id again makes no change.
- `failureCount` counts failed deletes in the current generation and resets when the generation advances.
- The processor reads `{ jobId, generation }` before it calls `deleteR2Object`. It may finish that job
  only when the stored generation still matches. A newer PUT increases the generation, so an older
  delete result cannot finish newer cleanup work.
- `putMayArriveUntil` keeps the job through the signed URL's arrival window: at least
  `uploadUrlExpiresAt` plus five minutes. An early delete makes a create-only URL usable again,
  so the canonical key still needs this guard. Missing-asset events use a fresh 15-minute window
  plus the margin. Public write stages use `stage.expiresAt` plus the same margin. Internal PUTs
  that already finished before cleanup do not need this field.
- A successful delete before `putMayArriveUntil` keeps the job as a tombstone. It sets
  `nextAttemptAt = putMayArriveUntil`. A second confirmed delete at or after that time may remove the
  job and clear the asset deadline.
- A transaction must create every needed deletion job before it deletes the stage or asset docs.
- The hourly cron processes at most 50 due jobs per page. It schedules another run while more jobs are
  due.
- A successful Yjs repair also sends the old snapshot key to this table before deleting its last asset
  doc. Reserved scopes still use the component cleanup because this table accepts real tenant ids only.

# Operation Matrix

The table describes a node whose policy refuses the current writer. ACL still applies in every row.

| Operation | Result |
| --- | --- |
| Open, read, search, download, copy path/link/ID | Allow |
| Copy readable content or subtree out | Allow; destination policy applies |
| Edit/save content, metadata, Yjs marks, or collaboration mode | Refuse |
| Create children, upload, import, or paste media | Refuse at the destination |
| Rename, move, replace, archive, or restore | Refuse if any affected node refuses |
| Browse or download snapshots | Allow |
| Restore, archive, or unarchive snapshots | Refuse |
| Share or change policy | Require management permission separately |
| Reply to an existing comment | Allow with comment permission |
| Create or resolve an anchored comment | Refuse; this changes a Yjs mark |
| Discard a whole pending proposal | Allow; keep protected eager-created nodes |
| Accept, save, or rebase pending work | Refuse |
| Finish an already accepted upload or committed Yjs materialization | Allow |
| Delete a tenant, workspace, or account | Use the named deletion workflow |

Direct comment sidecar mutations keep their comment ACL rules. The editor uses content write access
for anchored Create and Resolve. The Yjs gate checks again if a race reaches the server.

# Policy Management

`files_nodes.ts` owns `set_node_write_policy`, `get_node_write_policy_management_state`, and the shared
internal management helpers. HTTP and plugin adapters use the same helpers after their own live
identity, token, capability, and resource checks.

The setter requires current actor and optional account `content.permissions.manage` on the actual
target. For a folder, it also checks every distinct nested restricted scope, including archived
descendants. It does not require an exact account grant on each unrestricted child. New selected
users must be active workspace members; new selected accounts must be active in the same workspace.
A stored revoked writer remains visible as a redacted choice that a manager can replace.

Creation preflights management on the actual nearest existing parent or root before inserting any
missing path segment. It does not pretend that the new child already has an exact-node account grant.
Choosing a local policy creates no grant. Intermediate folders inherit; only the requested leaf gets
the requested local policy. A refusal commits no partial folders, assets, policy, or sharing changes.

Inherit removes only the local choice and returns to the current parent policy. Setting a local choice
below a parent is allowed, but does not bypass the parent. Repeating the same local choice is an
idempotent success. Management stays separate from effective content write access.

# Enforcement Rules

- Use this order: current auth and membership, actor/account ACL, resource scope and policy, conflict
  details, then writes. Policy is outside ACL because owner permission does not bypass a policy.
- `files_nodes_db_require_writable` accepts trusted writer, actor, resource scope, and policy reach.
  It does not read plugin docs or infer identity from labels. Its callers establish current credentials
  and ACL. `files_nodes_db_require_user_writable` supplies the explicit human writer for ordinary
  callers. Action preflights use the Result query `get_user_file_write_access`, preserving `read_only`.
- A scope is workspace, subtree, exact node, or create at a pinned nearest existing parent/root plus
  normalized intended path. Check subtree membership through parent IDs, including after moves.
- Reach `none` passes no policy. Reach `ancestors` may match every applicable selected-writer rule.
  Reach `direct` may match only an existing target's own local rule; any outer policy refuses. During
  creation, the existing parent is not the new target, so even a matching parent policy refuses direct
  reach. Generic sealed service doors use direct reach and preserve their destination and target limits.
  The external own-file bridge may use ancestor reach only after its sealed destination, current
  service secret, `workspace.files.own-write`, actor/account ACL, labels, and pinned output scope pass.
- Generic account keys use account permissions and their validated resource scope. Invoke plugins
  also keep accepted capability, editable label, source, and current installation checks. UI sessions
  keep their read-only backend contract. The generic helper adds no integration bypass.
- Every final content, Yjs, create, snapshot, repair, pending, import, or public publish transaction
  checks current policy before its first write. Both collaboration toggles require content write,
  not policy-management permission.
- Rename, move, archive, unarchive, and replace check their complete affected set before any write.
  Archived descendants use their real parent links. Equal paths in separate archived and active trees
  do not make them the same policy scope. Hidden refusals reveal no hidden node name, ID, or path.
- Keep expected target IDs and ordered pending source IDs. These stop stale work from changing a
  different file; they are separate from policy history.
- If an external write already happened before a final refusal, queue every exact key for durable
  cleanup before removing its temporary docs. Do not treat starting a vendor retry as final deletion.
- Plugin policy changes use common management checks. A requested `readOnly: true` maps to a local
  selected-account policy, including below a matching account parent. Ensure keeps existing folders'
  access unchanged. Policy changes never restore removed account grants.
  External ensure may recover only the IDs of an exact empty, attached private setup while its account
  awaits a file grant. Live credentials, pinned scope, labels, and sponsor read access still apply.
  This metadata-only path changes no files or grants; all write and policy doors stay unchanged.
- Service archive may clear an allowed direct policy only through the common managed setter in the
  same transaction. It still checks each swept node and refuses parent policy. Reader binding edits
  preserve independently managed account grants; ordinary reader refreshes cannot add them back.
- External transcript writes keep their writer generation and expected content/reader revisions in
  the trusted file stage. The final transaction repeats these checks and saves the write receipt
  with publication. A worker abort or a receipt stored only in the external app cannot replace this.
  File archive can also pin `expectedContentRevision`, checked in its final transaction.
- The external `rollback-readers` door is a narrow ACL undo after a failed native private change.
  Its saved receipt, original credential proof, live service/account binding, and exact current reader
  revision/generation replace sponsor write authority only for restoring the recorded previous readers.
  The saved service writer still checks the current target and every ancestor policy before an undo.
  A new lock returns the normal `read_only` conflict and leaves the native change blocked.
  It changes no content or policy, preserves account grants, filters stale lifetimes, and leaves manual
  or newer sharing untouched. It is not a general file or sharing permission bypass.
  If the original HTTP result was lost, the worker can name the original operation ID. An unapplied
  operation is cancelled with a durable receipt before success is returned; late reader calls refuse.
  This cancellation changes no sharing and requires a recognized sealed grant for the pinned root.
  After an upgrade or account rebind, an old proof cannot authorize the undo. A current sealed
  grant for the same installation and exact root may recover that recorded operation. The current
  actor and account need Files write and sharing-management access. Current labels, policies,
  membership lifetimes, writer generation, and reader revision still apply. A detached binding is
  acknowledged without changing sharing. No old credential grants new authority.
- Eager-created cleanup checks the proposer's current policy access on the file and every created
  ancestor before deleting any node. If one refuses, remove pending docs but keep the committed tree.
  The existing untouched-node checks still apply. Bash `/tmp` stays writable; copy-out stays allowed.
- Raw path/overlay resolution remains unfiltered so hidden occupied paths still conflict. Authorized
  read entrypoints apply actor and optional account visibility after lookup. Lists never expose raw
  policy fields or hidden writer/source identity.

# Error Contract

- Internal: `Result({ _nay: { name: "read_only", message: "This item is read-only." } })`.
  Branch on `_nay.name`. Do not turn a policy refusal into a generic permission refusal.
- HTTP: `409 Conflict`, existing code `conflict`, same message. Missing ACL remains a permission error.
- `/files/write-many` keeps per-item conflicts and continues. `/files/touch` keeps its sequential,
  request-level conflict. `/files/upload-urls` preflights the batch and mints nothing on refusal.
  Single and plugin routes keep their existing error shapes. `skipIfUnchanged` still checks policy.

# Race Rules

- A final transaction checks current policy again after action work. If the writer is allowed then,
  the write can finish subject to its other checks. Revoked credentials and changed resource identity
  still refuse. An absent destination is resolved again before publication.
- Upload acceptance creates the node, asset, and signed create-only target. A later policy change
  does not cancel accepted object publication, conversion, or its upload-completed event. A reused
  URL cannot overwrite a published object.
- `yjs_push_update` applies the current rule. A final `read_only` refusal drops queued local edits,
  reloads the saved document, and explains that the unsaved changes were not saved. A permission
  refusal keeps its existing warning. Network/rate failures keep edits and retry every five seconds.
  Compaction retries five times with the existing delay, then shows the final refusal on the sixth.
- Pending proposals remain visible through policy changes. Save, Accept, and rebase can resume when
  every affected node allows the writer. Whole-proposal Discard stays available.


# Accepted Upload Completion

The upload flow is:

1. The signed PUT creates the object at `assets/<assetId>`. Reusing that URL gets 412 while the object exists.
2. The event action matches the exact stored bucket and canonical key, then reads the object's metadata.
3. The final mutation rechecks ownership and retirement, publishes size and etag, and starts processing once.
4. A stale or retired attempt goes to exact-key cleanup. It cannot change a newer node or service target.

An already published event changes no metadata and starts no new work. If notification or publication
fails, recovery reads the same direct object. Keep `unfinalizedExpiresAt` until publication or cleanup
finishes. Recovery retries hourly for the first 30 hours after the signed URL was issued, then weekly.
After eight days, it checks the object once more before retiring an ordinary failed placeholder.
A placeholder whose policy refuses cleanup stays and is checked later. A pending service placeholder that permits cleanup also stays,
but terminal cleanup sets `uploadRetiredAt` and queues its canonical key in one mutation.

Pending service remint and create replay rotate the node and target to a fresh asset in one mutation.
That mutation queues the old key before removing the old asset. It does not wait for old cleanup.
A committed target stays terminal. Only a named tenant, workspace, or account deletion bypasses file policy;
these use `db_purge_organization_workspace_content_batch` in `data_deletion.ts`.

Those retry doors still recheck the target's original destination seal, active current path, and
current actor/account authority and restricted-file ACL. Policy is the one check they skip because it happened after upload acceptance.
If a service call observes that a member moved the file outside the seal, it closes those doors
permanently for that target. The accepted R2 event can still finish and charge the file's real size.

The service `delete` route also checks current policy before any write. It archives a committed upload,
because that file may now hold normal editable state and history. It hard-deletes only a pending
service placeholder, which has no accepted content yet.

The R2 event settles a service target in the publication transaction. `actualBytes` is the winning
object's size. `chargedBytes` is the largest observed attempt size; only an increase is charged.
`plugin_service_storage_attempts` keeps each old asset's target link after asset removal. Late events
may increase the target's charge, but cannot change its winning size, pointers, or file-save event.
Duplicate and smaller events add no charge. Cleanup never refunds bytes.

Failed-placeholder discard queues the canonical key with its signed-URL arrival window before deleting
the asset and node. It also releases the current service target when present. Missing-asset events
refresh the same job. Stale operator-repair uploads use this durable table for real tenants. Reserved
scopes keep their component cleanup.

After acceptance, a policy change only affects what may start next. The R2 event still publishes the file, text conversion still creates the editable representation, and upload-completed plugins still receive the event. The finished node keeps its local or inherited policy. New edits, replacements, renames, moves, and deletes still check that policy.

- UI: the normal waiting/processing state changes to the normal ready state. No separate read-only recovery action is needed.
- Rich-text media: the asset upload may finish after its destination policy changes. Inserting the reference still checks whether the document is editable. If the document stops allowing edits during the upload, keep the visible asset file and explain that it uploaded but was not inserted.

# UI Capability Model

Public node queries return `canWrite`, `writeBlockedReason` (`null`, `permission`, or `read_only`), and
`writePolicyState` (`none`, `self`, or `inherited`). The state describes policy location, not the human's
write permission. A selected human can edit while a policy is present. Source ID/path appear only
when readable. Lists do not join account names or expose raw authority fields.

Operation capabilities use actual `canWrite`. Rename, move, and archive also check the set of visible
ancestors with a refusing descendant. The server checks hidden descendants again. Rows stay readable,
selectable, searchable, and expandable. Policy and restricted-sharing indicators stay separate.

Files Properties offers Inherit, Read-only, and Selected writer. Its picker lists visible active
workspace users and accounts. It shows local choice, inherited source, and effective refusal
separately. The shared management state returns `canManage`, safe `localPolicy`, `hasInheritedPolicy`,
safe `inheritedSource`, and `blockedByAncestor`, as well as write access. A hidden or revoked writer
is redacted to null while the local mode stays `writer`. A protected parent cannot be bypassed by the
local choice. A manager may still change that choice or navigate to a readable source.

Policy saves use the dedicated setter. Metadata Save remains a separate action. Keep keyboard focus,
clear pending feedback, accessible labels, and usable layout at 200% zoom. Do not disable a focused
control only because its save is running.

# Requirements

| ID | Requirement |
| --- | --- |
| RO-01 | Every content write passes ACL and every applicable current policy |
| RO-02 | A refusing affected node blocks name, path, parent, archive, and child changes |
| RO-03 | Owners/admins do not bypass policies; selecting a writer grants no access |
| RO-04 | Policy configuration requires actual target/creation-scope management |
| RO-05 | Parent rules cover active and archived descendants and preserve nested local choices |
| RO-06 | Reads, sharing, safe comment replies, downloads, and readable copy-out keep working |
| RO-07 | Final transactions check current actor, account, scope, and policy before writes |
| RO-08 | Past policy state does not replace current checks or content-staleness checks |
| RO-09 | Pending work remains visible; Discard remains available through a refusal |
| RO-10 | Queries and refusals hide inaccessible source and writer identity |
| RO-11 | Accepted uploads and committed Yjs convergence finish; node cleanup checks current policy |
| RO-12 | UI uses actual human write access and remains keyboard/zoom accessible |
| RO-13 | Policy refusal keeps the stable read_only and HTTP conflict vocabulary |
| RO-14 | Refused operations commit no partial state and retain durable external cleanup |

# Test Map

- `convex/files_nodes.test.ts`: selected writers, ACL independence, every parent policy, direct-create
  refusal, creation management, moved scope, archived restrictions, redaction, cascades, and writes.
- `convex/files_pending_updates.test.ts`: current-policy proposal/commit checks and eager cleanup.
- `convex/files_nodes_content.test.ts`: replacement, collaboration, snapshots, and materialization.
- `convex/public_api*.test.ts`: bound accounts, current credentials/scopes, service targets, conflicts,
  policy management, accepted uploads, and no partial publication.
- `convex/access_control.test.ts`: human/account permissions, management authority, and source privacy.
- `convex/r2.test.ts`: accepted-upload completion and exact-key cleanup generations and tombstones.
- `convex/data_deletion*.test.ts`: lifecycle deletion and durable asset ownership.
- `convex/data_import.test.ts`, `server/bash.test.ts`: ordinary imports and human pending writes.
- Frontend policy, pending sidebar, editor, and Yjs provider tests: safe state, actual write access,
  current-policy refusals, and retry behavior.

# Related Skills

- `../access-control/SKILL.md`: actor/account permissions, grants, and account management.
- `../files-agent-pending-updates/SKILL.md`: proposal, commit, discard, and eager cleanup.
- `../files-editable-text/SKILL.md`: Yjs write doors and shape guards.
- `../files-explorer-tree/SKILL.md`: tree operations and row interactions.
- `../public-api/SKILL.md`: credentials, scopes, plugin adapters, and conflict responses.
- `../data-deletion/SKILL.md`: named lifecycle deletion and durable asset cleanup.
- `../ai-chat-agent/SKILL.md`: ordinary human agent/Bash behavior.
- `../files-rich-text-embeds/SKILL.md`: document and destination checks for embeds.
- `../plugin-system/SKILL.md`: installation account bindings and integration limits.
