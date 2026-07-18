---
name: files-agent-pending-updates
description: Current `/files` pending-changes system: per-user Yjs content branches plus structural move, copy, replace, and eager-create proposals; diff review; accept, discard, save, and sync; AI and Bash file-tool overlays; indexed pending content; and TTL cleanup. Use when changing pending banners or tabs, write_file/edit_file/cp/mv proposals, pending path or content reads, search overlays, review actions, rebase/save behavior, or expiry.
---

# Content And Structural Proposal States

Each `files_pending_updates` row belongs to one user and one file node. It may contain a content proposal, a structural proposal, or both.

A content proposal sets all four Yjs fields together and tracks three states:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, and sync/rebase against newer live file state.

Structural state uses:

- `pendingMove` for move or rename intent.
- `copiedFrom` for copy or replace provenance.
- `eagerCreated` when `write_file` or `cp` created a destination node early so discard or expiry can remove it safely.

Pure structural move rows have no Yjs fields and use `size: 0`. Rows do not always disappear when the three content states match: eager-created rows, replace moves, and mixed content-plus-move rows may still need structural review.

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
  - optional `eagerCreated`
  - `size` (UTF-8 byte size of current `unstaged` Markdown, or `0` for a structural-only row)
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
- Structural move rows can represent folders and non-content file nodes. Those rows do not carry Yjs branches.

# End-To-End Flow

1. AI tools in `packages/app/server/server-ai-tools.ts` resolve visible paths through the current user's pending structural overlay, then read file content through `internal.files_nodes.get_file_last_available_markdown_content_by_path`, an internal action that can fetch committed Markdown from R2.
2. That read path overlays the current user's pending `unstaged` branch when content exists. Pending destinations are visible, vacated or replaced paths are hidden, and descendants follow a pending folder move.
3. `write_file` and `edit_file` normalize line endings/trailing newline shape, compute a preview diff, and call `internal.files_pending_updates.upsert_file_pending_update_internal_action` so the base Yjs state can be fetched from R2 before the mutation writes.
4. Agent calls omit `stagedMarkdown`, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a row for `(organizationId, workspaceId, userId, fileNodeId)`. A missing `write_file` target may be created early and recorded with `eagerCreated`.
6. `FileNodeView` queries `list_files_pending_updates`, filters content-bearing rows into the diff queue, and passes that queue to `FileEditor`, which renders the floating banner and pager.
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
2. Agent-mode app-to-app `cp` and replacement moves may create or update a row with `copiedFrom`, `eagerCreated`, or both.
3. Bash and legacy file reads/listings/searches apply the proposing user's pending path overlay. Other users continue to see the committed tree.
4. The Pending changes tab renders content, move, copy, and mixed rows. It applies moves through `apply_file_pending_move`, saves content through the normal save path, and discards structural state through `discard_file_pending_structural`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions:

- `upsert_file_pending_update`
- `apply_file_pending_move`
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
- `persist_file_pending_update_rebased_state_in_db`
- `get_file_pending_update_internal`
- `get_pending_path_overlay_data`
- `save_file_pending_update_in_db`

Important behavior:

- Upsert reconstructs existing branch docs or clones the live file base, applies incoming Markdown to `unstaged`, applies `staged` only when `stagedMarkdown` is provided, and deletes the pending update doc if both branches match base.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Save applies remote drift from base into both branches before saving, persists only the `staged` diff to the live file, writes the saved-sequence marker, enqueues R2 content materialization, and keeps the pending update doc alive on partial save.
- Keep each public endpoint's current auth, membership, and rate-limit order. Do not infer one shared order: content upsert validates membership before its rate limit, while structural accept/discard and save perform the rate-limit check earlier.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.
- Content-bearing row lifecycle paths maintain pending `files_markdown_chunks`, pending `files_plain_text_chunks`, and pending `files_metadata_docs` in the same mutation. Insert chunks `unstaged` Markdown and extracts YAML frontmatter. An unstaged-content replacement rebuilds those docs; a staged-only change reuses them. Row deletion removes them. Pure structural rows own no pending indexed docs. If content collapses while `pendingMove` remains, remove the pending indexed docs and retain the structural row.
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
- content, move, copy, and content-plus-move row rendering
- per-row and bulk Accept/Discard actions
- move-before-content ordering for mixed-row acceptance
- safe eager-created destination deletion during discard

# Cleanup And Expiry Model

- Every write that leaves a pending row alive refreshes its four-hour cleanup task. This includes content upserts, move upserts, rebases, partial saves, and structural accept/discard paths that preserve part of a mixed row.
- If an operation deletes or fully resolves the row, it removes the cleanup task instead.
- A new presence session reschedules cleanup for four hours from that session without changing the row's `updatedAt`. Disconnect does not shorten the lifetime, so unreviewed proposals survive the user closing the app.
- Every scheduled cleanup carries `expectedUpdatedAt`; stale scheduled work cannot delete a newer row.
- Expiry hard-deletes the file node only when the row has an `eagerCreated` stamp, the node's committed sequence still matches that stamp, and no other pending row uses the node. Otherwise it deletes only this pending row and its pending indexes/task. A replace proposal against a pre-existing node is never hard-deleted by expiry.

# Architectural Invariants

- Pending updates are per-user rows keyed by `(organizationId, workspaceId, userId, fileNodeId)`.
- A content-only row normally exists while `staged` or `unstaged` differs from `base`. Structural rows, eager-created destinations, and replace moves may persist even when the content branches match.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.
- Only content-bearing rows own pending Markdown chunks, plain-text chunks, and metadata docs. Content insert, unstaged-content replacement, deletion, save, and expiry keep those docs in sync with the row; staged-only changes reuse them.
- Bash `search` (`text_search_files`) uses one Convex full-text search query against `files_plain_text_chunks` with Convex native cursor pagination, and renders directly from those docs without hydrating linked Markdown chunks. It filters pending chunks to the acting user, filters out other users' pending chunks, and hides committed chunks for files that user has pending edits on. Pending-first ordering is not an invariant.
- Bash `meta search` uses one Convex indexed query against `files_metadata_docs` per command. It filters pending metadata to the acting user, filters out other users' pending metadata, and hides committed metadata for files that user has pending edits on. Multi-predicate AND/OR is intentionally outside the command and should be composed by shell tools over path output.
- Known limitation: metadata search treats every pending row as a content overlay. A structural-only move has no pending metadata docs, but its row still causes committed metadata for that file to be hidden. The file disappears from `meta search` until the move is accepted, discarded, or gains pending content. Full-text search does not have this problem because it hides committed chunks only for rows that contain a content proposal.
- `Review changes` must switch into diff mode.
- In the diff editor, `Accept all` only copies unstaged content into staged content; it does not save by itself. In the Pending changes tab, bulk Accept applies or saves every listed row.
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
- Verify the Pending changes tab renders and sorts content, move, copy, and mixed rows.
- Verify pure moves do not enter the diff pager.
- Verify accept/discard applies pending paths, archive behavior, content, and move-before-save ordering for mixed rows.
- Verify discard and expiry hard-delete only eligible eager-created destinations.
- Verify the proposing user sees the pending structural path overlay while another user sees the committed tree.
