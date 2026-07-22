---
name: files-agent-pending-updates
description: Current `/files` pending-changes system: per-user Yjs content branches plus structural move, copy, replace, delete, and eager-create proposals; diff review; accept, discard, save, and sync; AI and Bash file-tool overlays; indexed pending content; and TTL cleanup. Use when changing pending banners or tabs, bash shell write/write_file/edit_file/cp/mv/rm proposals, pending path or content reads, search overlays, review actions, rebase/save behavior, or expiry.
---

# Content And Structural Proposal States

Each `files_pending_updates` doc — the pending update doc — belongs to one user and one file node. It may contain a content proposal, a structural proposal, or both.

A content proposal sets all four Yjs fields together and tracks three states:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, and sync/rebase against newer live file state.

Structural state uses:

- `pendingMove` for move or rename intent.
- `copiedFrom` for copy or replace provenance.
- `pendingArchive` for delete intent (bash `rm`): accepting archives the node; a folder archives its whole subtree, computed at accept time. Setting it clears `pendingMove` — a delete supersedes a move. Content branches survive on the doc (accept ignores them; discard restores them as a Modified row).
- `eagerCreated` when `write_file`, a bash shell write, or `cp` eagerly created a destination node so discard or expiry can remove it safely. `rm` on such a doc cancels it immediately when the hard-delete gate passes, like Discard — no proposal remains; when the gate fails, `rm` falls back to a normal pending delete proposal.

Move-only docs have no Yjs fields and use `size: 0`. Docs do not always disappear when the three content states match: eager-created docs, replace-move docs, and content-plus-move docs (`content_and_move` in code) may still need structural review.

# Data Model

Main table in `packages/app/convex/schema.ts`:

- `files_pending_updates`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `fileNodeId`
  - optional content fields, always set together:
    - `baseYjsSequence`
    - `baseYjsUpdate`
    - `stagedBranchYjsUpdate`
    - `unstagedBranchYjsUpdate`
  - optional `pendingMove`
  - optional `copiedFrom`
  - optional `pendingArchive` (`fromPath` display metadata only; the node id is authoritative)
  - optional `eagerCreated`
  - optional `threadIds` (contributor set: the chat threads that touched this doc, deduped; agent writes append their thread id, client-driven writes leave the field out of their patches so it survives, and it dies with the doc; unset for client-only docs and rows older than the field)
  - `size` (UTF-8 byte size of current `unstaged` Markdown, or `0` for a structural-only doc)
  - `updatedAt`

Unified exact Markdown chunk table:

- `files_markdown_chunks`
  - `organizationId`
  - `workspaceId`
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
  - optional `yjsSequence` for committed docs
  - `chunkIndex`
  - `markdownChunk`
  - `startIndex` / `endIndex` / `lineStart` / `lineEnd` / `chunkFlags`
  - committed yjs-sequence indexes and pending-update indexes for exact reads and regex scans

Unified full-text search table:

- `files_plain_text_chunks`
  - `organizationId`
  - `workspaceId`
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
  - optional `yjsSequence` for committed docs
  - `markdownChunkId`
  - denormalized `path`
  - optional `archiveOperationId`
  - `chunkIndex`
  - `plainTextChunk`
  - `markdownChunk`
  - `startIndex` / `endIndex` / `lineStart` / `lineEnd` / `chunkFlags`
  - `hasChunkAbove` / `hasChunkBelow`
  - search index `search_by_plainTextChunk` (filter fields `organizationId`, `workspaceId`, `archiveOperationId`)
  - committed replacement, pending replacement, and scope patching indexes

The old separate search and pending chunk tables no longer exist. Bash full-text `search` uses the unified `files_plain_text_chunks` table as a self-contained search-result doc; exact Markdown reads use `files_markdown_chunks`, while plain-text regex search reads line numbers from `files_plain_text_chunks`.

Unified Markdown frontmatter metadata docs:

- `files_metadata_docs`
  - one table for committed and pending indexed metadata docs
  - field docs use `docKind: "field"` and support existence search, including fields whose value is an object, array, unsupported value, or otherwise only searchable by existence
  - value docs use `docKind: "value"` and support one searchable primitive value per field value
  - `organizationId`
  - `workspaceId`
  - `fileNodeId`
  - `sourceKind: "committed" | "pending"`
  - optional `userId` for pending docs
  - optional `pendingUpdateId` for pending docs
  - optional `yjsSequence` for committed docs
  - denormalized `path`
  - denormalized `treePath`
  - optional `archiveOperationId`
  - `qualifiedField`, currently `frontmatter.*`
  - optional `valueKind: "string" | "number" | "boolean"` for value docs
  - one value column matching `valueKind`: `stringValue`, `numberValue`, or `booleanValue`
  - committed replacement, pending replacement, scope patching, field-existence search, string prefix/equality, numeric range/equality, and boolean equality indexes

Saved-sequence marker table:

- `files_pending_updates_last_sequence_saved`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `fileNodeId`
  - `lastSequenceSaved`
  - `updatedAt`

Cleanup table:

- `files_pending_updates_cleanup_tasks`
  - `pendingUpdateId`
  - `scheduledFunctionId`
  - `expectedUpdatedAt`

The authoritative identity is per user and per file node. Two users can each have independent pending updates on the same file.

# Markdown-Backed File Scope

Pending updates attach to Markdown-backed `files_nodes` docs.

- Editable Markdown files participate directly in pending review/edit flows.
- Plugin-generated Markdown outputs are ordinary files, so they can participate in pending review/edit flows after the plugin creates them.
- Raw uploaded source file nodes without Markdown Yjs ids do not directly participate in pending Markdown edits today.
- Uploaded source paths do not alias to generated outputs; pending edits attach to the exact Markdown file node being edited.
- Move-only and delete-only docs can represent folders and non-content file nodes. Those docs do not carry Yjs branches.

# End-To-End Flow

1. AI tools in `packages/app/server/server-ai-tools.ts` translate visible paths to committed paths through the current user's pending structural overlay, then read file content through `internal.files_nodes.get_file_last_available_markdown_content_by_path`, an internal action that can fetch committed Markdown from R2.
2. That read path overlays the current user's pending `unstaged` branch when content exists. Pending destinations are visible, vacated or replaced paths are hidden, and descendants follow a pending folder move.
3. `write_file`, `edit_file`, and Agent-mode bash shell writes (`bash_DbFilesFs.writeFile`/`appendFile` in `packages/app/server/bash-utils.ts`, reached by `>`/`>>` redirects, heredocs, `tee`, and `touch` on a new path — `touch` on an existing app file is a no-op) normalize CRLF line endings to LF (bash writes are otherwise byte-faithful, like a real shell) and call `internal.files_pending_updates.upsert_file_pending_update_internal_action` so the base Yjs state can be fetched from R2 before the mutation writes.
4. Agent calls omit `stagedMarkdown`, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a doc for `(organizationId, workspaceId, userId, fileNodeId)`. A missing `write_file` or bash shell write target may be eagerly created and recorded with `eagerCreated`.
6. `FileNodeView` queries `list_files_pending_updates`, filters content-bearing docs into the diff queue, and passes that queue to `FileEditor`, which renders the floating banner and pager.
7. `Review changes` switches the `/files` route to `view=diff_editor`.
8. `FileEditorDiff` bootstraps from the pending update doc if present, otherwise from live file Yjs state.
9. In the diff editor, original side is `staged` and modified side is `unstaged`.
10. Local Monaco edits debounce back into `upsert_file_pending_update`.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. `Save` flushes pending upserts, then calls `save_file_pending_update`.
14. `save_file_pending_update` writes only the `staged` diff into the live file Yjs stream through `files_db_yjs_push_update`.
15. The Yjs push records the transactional update immediately and enqueues the content materialization workpool to compact the latest Markdown/Yjs state, refresh the committed chunks (the read source for current content — editable files keep no current-content object in R2), write the Yjs snapshot to R2, and create a version snapshot.
16. The saved-sequence marker is upserted even when the live file already matched the staged branch and no new Yjs packet was inserted.
17. If `unstaged` now matches the saved live file state, the doc is deleted.
18. If unresolved edits remain, the doc stays alive with `base` and `staged` advanced to saved live content.
19. `Sync` rebases both branches on top of the latest live Yjs state through `persist_file_pending_update_rebased_state`.

Structural review follows a parallel path:

1. Agent-mode Bash `mv` stores `pendingMove` instead of moving the committed node immediately.
2. Agent-mode app-to-app `cp` and replace-moves may create or update a doc with `copiedFrom`, `eagerCreated`, or both.
3. Agent-mode Bash `rm` stores `pendingArchive` (per operand, builtin flag semantics: `-r` for folders, `-f` silences missing paths, folder without `-r` fails with `Is a directory`). Accepting archives; nothing is ever hard-deleted except the own-Added-file cancel path.
4. Bash and legacy file reads/listings/searches apply the proposing user's pending path overlay. A pending-deleted node reads as gone (a deleted folder hides its whole subtree). Other users continue to see the committed tree, and the sidebar file tree shows no delete indicator until accept.
5. The Pending changes tab renders content-only, move-only, copy, content-plus-move, and delete rows. It applies moves through `apply_file_pending_move`, deletes through `apply_file_pending_archive`, saves content through the normal save path, and discards structural state through `discard_file_pending_structural`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions:

- `upsert_file_pending_update`
- `apply_file_pending_move`
- `apply_file_pending_archive`
- `discard_file_pending_structural`
- `persist_file_pending_update_rebased_state`
- `get_file_pending_update`
- `list_files_pending_updates`
- `get_file_pending_update_last_sequence_saved`
- `save_file_pending_update`
- `get_by_file_node`
- `remove_file_pending_update_if_expired`
- `upsert_file_pending_update_in_db`
- `upsert_file_pending_update_internal_action`
- `upsert_file_pending_move_in_db`
- `upsert_file_pending_archive_in_db`
- `persist_file_pending_update_rebased_state_in_db`
- `get_file_pending_update_internal`
- `get_pending_path_overlay_data`
- `save_file_pending_update_in_db`

Important behavior:

- Upsert reconstructs existing branch docs or clones the live file base, applies incoming Markdown to `unstaged`, applies `staged` only when `stagedMarkdown` is provided, and deletes the pending update doc if both branches match base.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Rebase persistence is update-only and patches only the exact doc id the client synced. When that doc was discarded, fully accepted, or replaced by a newer proposal while the sync was in flight, it returns a benign `Not found` and never recreates or overwrites anything.
- Two more rebase guards. A sync whose captured base is older than the doc's current base returns a benign `Stale save` (a tab that saved meanwhile wins). A sync against a doc that degraded to move-only returns `Not found` (in-flight syncs cannot resurrect reverted content).
- Accept and discard are deliberately simple: `apply_file_pending_move` and `discard_file_pending_structural` take only `{membershipId, nodeId}` and act on the user's CURRENT doc for that node.
- A click that raced a newer proposal applies or discards the doc's current state. The stale-panel window is sub-second (Convex reactivity) and accepted by design; there are no rendered-snapshot bindings.
- Discard is idempotent: a missing doc or a doc with nothing structural returns `_yay`, so bulk flows and already-settled swap cycle members just no-op.
- Deliberate non-guarantees: other members of a swap cycle apply their current destinations, and equal-base concurrent content edits stay last-write-wins.
- Same-user swap cycles accept atomically for any kind mix (files, folders, or both): accepting one member applies every member's move in one transaction, folder members cascade their descendants, and the other members' rows settle so a later accept on them no-ops.
- Folder replaces follow rename() semantics: a folder move soft-archives and replaces an EMPTY folder occupant, both when `mv` resolves into a folder with a same-named empty folder child and with `mv -T`; no `-f` is needed. A non-empty occupant is rejected with `Directory not empty` — committed children count, and so do the user's own pending moves into that folder. Accept also replaces an empty folder occupant that appears after proposal time, the same way it auto-replaces a file occupant. A file never replaces a folder, and a folder never replaces a file.
- The only stale literal the client treats as benign is `Stale save` (plus `Not found` on in-flight syncs); both come from multi-second ACTIONS, not from panel clicks.
- One documented cross-tab edge (accepted editing model): an OPEN diff editor owns a live local draft, and a dead doc id with no replacement doc deliberately falls through to the create path — so a diff tab left open on a file can recreate a proposal that was discarded in another tab. The recreated content is pending only (never committed or billed) and shows up in the panel like any proposal. Making Discard authoritative across tabs would need a separate draft-cancellation design.
- Every proposal write refreshes the 4-hour expiry, including the identical-content short-circuits (upsert and sync). An identical re-write still bumps `updatedAt`, reschedules cleanup, and records new structural intent (`copiedFrom` changes and a missing `eagerCreated` stamp still land).
- Save applies remote drift from base into both branches before saving, persists only the `staged` diff to the live file, writes the saved-sequence marker, enqueues R2 content materialization, and keeps the pending update doc alive on partial save.
- Save guards the target node before any write: a missing, out-of-scope, non-file, or archived target returns `Not found` and the doc survives.
- A save whose action-read base sequence no longer matches the file's CURRENT committed last sequence returns `Stale save` before any write or billing. This one check covers two races: a second tab replaying an old save (no double billing), and another user committing between the action's read and the mutation (the doc's new base can never silently hide that commit).
- A replace-move save (`copiedFrom.archivesSourceOnAccept`) archives the replace source and deletes the acting user's leftover doc on it. When that doc is itself a replace-move (chained `mv -f`), the walk continues down the replace chain to the deeper replace sources, so accepting the head of a chain consumes every hop in either accept order.
- `apply_file_pending_archive` re-validates at accept time: a missing doc or one without `pendingArchive` no-ops; a missing/out-of-scope/already-archived node just drops the doc. A folder computes its subtree by path prefix at accept time (nodes added after the proposal are archived too) and everything gets ONE `archiveOperationId`, so Unarchive restores the delete as one unit. The acting user's docs on all archived nodes are removed; other users' docs stay and go inert through the existing archived-node filters. Accepting a delete never runs the mv‑f replace-source chain.
- Save on a doc with `pendingArchive` is rejected with `File has a pending delete` (discard the delete first). Discarding a delete only clears `pendingArchive`: a doc that still has content or copy provenance survives as a content row; a delete-only doc is removed.
- Keep each public endpoint's current auth, membership, and rate-limit order. Do not infer one shared order: content upsert validates membership before its rate limit, while structural accept/discard and save perform the rate-limit check earlier.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.
- Content-bearing doc lifecycle paths maintain pending `files_markdown_chunks`, pending `files_plain_text_chunks`, and pending `files_metadata_docs` in the same mutation. Insert chunks the `unstaged` Markdown and extracts YAML frontmatter. Replacing the `unstaged` Markdown rebuilds those docs; a staged-only change reuses them. Doc deletion removes them. Structural-only docs own no pending indexed docs. If content collapses while `pendingMove` remains, remove the pending indexed docs and retain the structural doc.
- Committed materialization writes committed `files_markdown_chunks`, committed `files_plain_text_chunks`, and committed metadata docs; committed replacement deletes the old committed Markdown chunks, plain-text chunks, and metadata docs for that file before inserting new docs.
- Rename, move, archive, and unarchive patch denormalized `path` and `archiveOperationId` on `files_plain_text_chunks`, and `path`, `treePath`, and `archiveOperationId` on `files_metadata_docs`, so full-text and metadata search can filter scope before native pagination.
- Pending update doc writes also store `size` from the same current `unstaged` Markdown whenever the unstaged branch is created or replaced. Staged-only changes preserve the existing size.
- A chunking failure never fails the pending update doc write: the stale pending Markdown/plain-text chunk docs are already deleted, the failure is logged, and search just misses that file until the next upsert (its committed chunks stay hidden for that user).

# Client Responsibilities

`packages/app/src/components/files/file-editor/file-editor.tsx` owns:

- floating banner for "Pending changes"
- `Review changes` CTA
- previous/next pager across content-bearing pending files for the current user

`packages/app/src/components/files/file-editor/file-editor-diff/file-editor-diff.tsx` owns:

- bootstrapping from pending update doc or live file state
- Monaco diff editor state
- debounced pending update doc upserts
- per-hunk accept/discard widgets
- `Save`
- `Sync`
- `Accept all`
- `Accept all + save`
- `Discard all`

`packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx` owns:

- the Pending changes tab content
- the source selector: `All changes`, `You`, and every persisted agent chat referenced by a pending doc. `You` means docs with no `threadIds`; it stays visible with a zero count. Thread options use the membership-scoped `ai_chat.thread_get` query, so archived contributing chats remain selectable
- source filtering after the full pending-row model is built. A doc with multiple `threadIds` appears with its same combined pending content under every linked chat, and source counts can overlap. The UI never tries to split one doc's changes by chat
- bulk Accept/Discard over only the rows shown by the selected source. A source-scoped accept that would also settle or invalidate a hidden row asks the user to switch to `All changes`; this covers cross-source move chains/cycles, folder deletes with hidden descendants, replacements, and archive-source copies. If a selected chat stops contributing, the selector returns to `All changes`; a zero-row source disables both bulk actions
- content-only, move-only, copy, content-plus-move, and delete row rendering; the "Deleted" caption wins over every other caption
- editable Markdown delete rows prefetch committed Markdown and expand to an inline fully-removed diff; binary and folder delete rows are plain rows without a disclosure control
- binary structural replacements query both asset sizes while the row is mounted, then expand to removed and added size lines or `Size unchanged`
- delete and binary-replacement links open the file, never the diff editor
- per-row Accept/Discard actions, with the same `All changes` guard when accept would affect a hidden source
- move-before-content ordering for content-plus-move row acceptance
- delete rows run as their own trailing bulk phase (accepting a folder delete first would archive descendants and fail sibling accepts)
- safe eager-created destination deletion during discard

`packages/app/src/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx` owns:

- the pending-changes strip above the Agent-tab chat composer (rendered through `AiChatThread`'s `composerTopSlot`): a one-line clickable row, hidden at 0, never dismissable. With a `threadId` prop (the agent panel passes the selected persisted thread id) it counts only the docs whose `threadIds` contributor set includes that chat and labels them "from this chat"; without the prop it shows the user's workspace-wide count
- the amber count badge inside the "Pending changes" sidebar tab label, hidden at 0 (always the workspace-wide count)
- both switch the sidebar to the Pending changes tab by writing `app_state::files_last_tab` (the strip on click; the badge is display-only)
- the shared `FILE_EDITOR_SIDEBAR_TAB_ID_PENDING` constant (moved here so the sidebar tabs, the strip, and the agent panel import it without a cycle)

# Cleanup And Expiry Model

- Every write that leaves a pending update doc alive refreshes its four-hour cleanup task. This includes content upserts, move upserts, rebases, partial saves, and structural accept/discard paths that preserve part of a content-plus-move doc.
- If an operation deletes or fully resolves the doc, it removes the cleanup task instead.
- A new presence session reschedules cleanup for four hours from that session without changing the doc's `updatedAt`. Disconnect does not shorten the lifetime, so unreviewed proposals survive the user closing the app.
- Every scheduled cleanup carries `expectedUpdatedAt`; stale scheduled work cannot delete a newer doc.
- Expiry hard-deletes the file node only when every check passes: the doc has an `eagerCreated` stamp, the node's committed sequence still matches that stamp, the node's `updatedBy` is still the proposer, and no other pending update doc uses the node. The `updatedBy` check exists because a committed rename or move by another user never advances the Yjs sequence, so the stamp alone cannot catch it; `rename_node` and `move_nodes` both stamp `updatedBy`.
- An ancestor-folder move does not restamp descendants and does not block the hard delete — removing the eager-created node does not undo the ancestor's move.
- When the node is not eligible, expiry deletes only the pending update doc and its pending indexes/task, and the node stays active. Expiry never hard-deletes a pre-existing node targeted by a replace proposal. A delete-only doc expires the same way: the doc goes, the node is untouched.
- Eager creates commit missing parent folders, and the doc's `eagerCreated.createdAncestorIds` remembers them (deepest first).
- Every path that safely hard-deletes the eager-created leaf — discard, expiry, and the failed-upsert compensation — then removes those folders too, but only while each folder is provably untouched: created AND last updated by the proposer, zero children in any archive state, no pending update doc ON the folder (`by_fileNode`), and no pending move TARGETING it as a destination (`by_pendingMove_destParentId` — another user's proposed move into the folder keeps it alive).
- The first kept folder stops the walk (everything shallower contains it).

# Architectural Invariants

- Pending updates are per-user docs keyed by `(organizationId, workspaceId, userId, fileNodeId)`.
- A content-only doc normally exists while `staged` or `unstaged` differs from `base`. Structural docs, eager-created destinations, and replace-moves may persist even when the content branches match.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.
- Only content-bearing docs own pending Markdown chunks, plain-text chunks, and metadata docs. Content insert, `unstaged` Markdown replacement, deletion, save, and expiry keep those docs in sync with the pending update doc; staged-only changes reuse them.
- Bash `search` (`text_search_files`) uses one Convex full-text search query against `files_plain_text_chunks` with Convex native cursor pagination, and renders directly from those docs without hydrating linked Markdown chunks. It filters pending chunks to the acting user, filters out other users' pending chunks, and hides committed chunks for files that user has pending edits on. Pending-first ordering is not an invariant.
- Bash `meta search` uses one Convex indexed query against `files_metadata_docs` per command. It filters pending metadata to the acting user, filters out other users' pending metadata, and hides committed metadata for files that user has pending edits on. Multi-predicate AND/OR is intentionally outside the command and should be composed by shell tools over path output.
- Metadata search hides committed metadata only for docs that carry a content proposal (`files_pending_update_content_of` returns non-null), the same rule full-text search uses. A move-only doc does not mask the file's committed metadata.
- `Review changes` must switch into diff mode.
- In the diff editor, `Accept all` only copies unstaged content into staged content; it does not save by itself. In the Pending changes tab, bulk Accept applies or saves every row shown by the selected source.
- In the diff editor, `Discard all` copies staged content into unstaged content without a special clear mutation. The Pending changes tab uses backend discard mutations for its rows.
- `Save` can partially resolve a pending update and keep the unresolved branch alive.
- `Sync` must rebase on top of the latest live file state before persisting.
- Stale rebases must be rejected.
- Live rich-text Yjs sync must serialize outgoing local update batches and retain/retry failed batches ahead of newer edits.

# Verification Checklist

- Trigger an AI proposal and confirm the floating pending banner appears.
- Confirm `Review changes` enters diff mode for the current file.
- Confirm previous/next navigation can move across the pending queue.
- In diff mode, verify per-hunk accept/discard updates the correct side.
- `Accept all` should stage everything without saving.
- `Discard all` should revert unstaged content back to staged content.
- `Save` should persist only the staged branch and keep the pending update doc if unresolved unstaged content remains.
- `Accept all + save` should clear the pending update doc when no unresolved changes remain.
- `Sync` should preserve local intent while rebasing on newer live file state.
- Verify the Pending changes tab renders and sorts content-only, move-only, copy, content-plus-move, and delete rows.
- Verify the source selector shows All, threadless You, archived chats, and contributing chats newest first. A shared pending doc should appear as the same complete row under every linked chat.
- Verify source-scoped bulk actions touch only shown rows, a selected chat falls back to All after its last row settles, and You stays available at zero with disabled bulk actions.
- Verify source-scoped accept asks for All instead of settling hidden move-chain/cycle members, hidden folder descendants, hidden replacement occupants, or hidden archive-source rows.
- Verify editable Markdown delete rows start fetching committed content before expansion and render it as fully removed.
- Verify binary and folder delete rows have no disclosure control and do not fetch committed Markdown.
- Verify binary replacements prefetch both asset sizes and show removed and added size lines, or `Size unchanged` when the sizes match.
- Verify bash `rm` hides the path from the proposer's reads, accept archives (folder cascade, one operation id), and discard restores visibility without touching the node.
- Verify pure moves do not enter the diff pager.
- Verify accept/discard applies pending paths, archive behavior, content, and move-before-save ordering for content-plus-move rows.
- Verify discard and expiry hard-delete only eligible eager-created destinations.
- Verify the proposing user sees the pending structural path overlay while another user sees the committed tree.
