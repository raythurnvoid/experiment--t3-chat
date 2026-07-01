---
name: files-agent-pending-updates
description: Describes the current `/files` route pending-update system for files files: Yjs-backed branch state, diff review, partial save, sync/rebase, AI file-tool integration, and TTL cleanup.
---

# When To Use This Skill

Use this when investigating or changing any part of the files pending-update lifecycle:

- Pending banner shows the wrong state or does not clear.
- AI `write_file` / `edit_file` proposals behave unexpectedly.
- Diff editor accept/discard/save/sync behavior is wrong.
- Rebasing, remote drift, or stale-base errors appear.
- Pending updates expire too early, not at all, or react incorrectly to presence reconnect/disconnect.

# Big Picture

Each pending update doc is a per-user, per-file Yjs snapshot that tracks three states:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, sync/rebase against newer live file state, and safe deletion when both branches collapse back to the live base.

# Data Model

Main table in `packages/app/convex/schema.ts`:

- `files_pending_updates`
  - `organizationId`
  - `workspaceId`
  - `userId`
  - `nodeId`
  - `baseYjsSequence`
  - `baseYjsUpdate`
  - `stagedBranchYjsUpdate`
  - `unstagedBranchYjsUpdate`
  - `size` (UTF-8 byte size of the current `unstaged` Markdown)
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
  - `nodeId`
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
- Generated upload outputs are Markdown-backed ordinary files, so they can also participate in pending review/edit flows once finalized.
- Raw uploaded source file nodes without Markdown Yjs ids do not directly participate in pending Markdown edits today.
- Uploaded source paths do not alias to generated outputs; pending edits attach to the exact Markdown file node being edited.

# End-To-End Flow

1. AI tools in `packages/app/server/server-ai-tools.ts` read file content through `internal.files_nodes.get_file_last_available_markdown_content_by_path`, an internal action that can fetch committed Markdown from R2.
2. That read path overlays the current user's pending `unstaged` branch when one exists.
3. `write_file` and `edit_file` normalize line endings/trailing newline shape, compute a preview diff, and call `internal.files_pending_updates.upsert_file_pending_update_internal_action` so the base Yjs state can be fetched from R2 before the mutation writes.
4. Agent calls omit `stagedMarkdown`, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a doc for `(organizationId, workspaceId, userId, nodeId)`.
6. `FileEditor` queries `list_files_pending_updates` and shows the floating pending banner whenever the user has any pending updates.
7. `Review changes` switches the `/files` route to `view=diff_editor`.
8. `FileEditorDiff` bootstraps from the pending update doc if present, otherwise from live file Yjs state.
9. In the diff editor, original side is `staged` and modified side is `unstaged`.
10. Local Monaco edits debounce back into `upsert_file_pending_update`.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. `Save` flushes pending upserts, then calls `save_file_pending_update`.
14. `save_file_pending_update` writes only the `staged` diff into the live file Yjs stream through `files_db_yjs_push_update`.
15. The Yjs push records the transactional update immediately and enqueues the content materialization workpool to compact the latest Markdown/Yjs state, write the committed Markdown asset to R2, refresh chunks, and create a version snapshot.
16. The saved-sequence marker is upserted even when the live file already matched the staged branch and no new Yjs packet was inserted.
17. If `unstaged` now matches the saved live file state, the doc is deleted.
18. If unresolved edits remain, the doc stays alive with `base` and `staged` advanced to saved live content.
19. `Sync` rebases both branches on top of the latest live Yjs state through `persist_file_pending_update_rebased_state`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions:

- `upsert_file_pending_update`
- `upsert_file_pending_update_internal_action`
- `upsert_file_pending_update_internal`
- `persist_file_pending_update_rebased_state`
- `get_file_pending_update`
- `get_file_pending_update_internal`
- `get_file_pending_update_last_sequence_saved`
- `list_files_pending_updates`
- `save_file_pending_update`
- `remove_file_pending_update_if_expired`

Important behavior:

- Upsert reconstructs existing branch docs or clones the live file base, applies incoming Markdown to `unstaged`, applies `staged` only when `stagedMarkdown` is provided, and deletes the pending update doc if both branches match base.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Save applies remote drift from base into both branches before saving, persists only the `staged` diff to the live file, writes the saved-sequence marker, enqueues R2 content materialization, and keeps the pending update doc alive on partial save.
- Public actions/mutations are rate-limited after membership validation and before writes.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.
- Every pending doc lifecycle path maintains pending `files_markdown_chunks`, pending `files_plain_text_chunks`, and pending `files_metadata_docs` in the same mutation: doc insert chunks the `unstaged` Markdown with the shared `files_chunk_markdown` chunker and extracts Markdown YAML frontmatter into field and value metadata docs, patches rebuild pending Markdown chunk docs, pending plain-text chunk docs, and metadata docs only when the unstaged content actually changed (staged-only changes like `Accept all` skip the rebuild), and doc deletion (collapse, full save, expiry, workspace purge, and user purge) deletes all pending Markdown chunks, plain-text chunks, and metadata docs.
- Committed materialization writes committed `files_markdown_chunks`, committed `files_plain_text_chunks`, and committed metadata docs; committed replacement deletes the old committed Markdown chunks, plain-text chunks, and metadata docs for that file before inserting new docs.
- Rename, move, archive, and unarchive patch denormalized `path`, `treePath`, and `archiveOperationId` on `files_plain_text_chunks` and metadata docs, so full-text and metadata search can filter scope before native pagination.
- Pending update doc writes also store `size` from the same current `unstaged` Markdown whenever the unstaged branch is created or replaced. Staged-only changes preserve the existing size.
- A chunking failure never fails the pending update doc write: the stale pending Markdown/plain-text chunk docs are already deleted, the failure is logged, and search just misses that file until the next upsert (its committed chunks stay hidden for that user).

# Client Responsibilities

`packages/app/src/components/file-editor/file-editor.tsx` owns:

- floating banner for "Pending changes"
- `Review changes` CTA
- previous/next pager across all pending files for the current user

`packages/app/src/components/file-editor/file-editor-diff/file-editor-diff.tsx` owns:

- bootstrapping from pending update doc or live file state
- Monaco diff editor state
- debounced pending update doc upserts
- per-hunk accept/discard widgets
- `Save`
- `Sync`
- `Accept all`
- `Accept all + save`
- `Discard all`

# Cleanup And Expiry Model

- Every active pending update doc gets a cleanup task.
- The expiry window is 4 hours from the last write, regardless of presence.
- Every upsert and partial save refreshes the 4-hour window; reconnect / new presence session also refreshes it.
- Presence disconnect never shortens cleanup, so unreviewed AI edits survive the user closing the app.
- Every scheduled cleanup carries `expectedUpdatedAt`.
- `remove_file_pending_update_if_expired` only deletes the doc if the current doc still has that exact `updatedAt`.

# Architectural Invariants

- Pending updates are per-user docs keyed by `(organizationId, workspaceId, userId, nodeId)`.
- A pending update doc exists only while either `staged` or `unstaged` differs from `base`.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.
- Pending Markdown chunk docs, pending plain-text chunk docs, and pending metadata docs are replaced in the same mutation as every pending doc write/delete, so no orphan or stale pending search/metadata docs should exist.
- Bash `search` (`text_search_files`) uses one Convex full-text search query against `files_plain_text_chunks` with Convex native cursor pagination, and renders directly from those docs without hydrating linked Markdown chunks. It filters pending chunks to the acting user, filters out other users' pending chunks, and hides committed chunks for files that user has pending edits on. Pending-first ordering is not an invariant.
- Bash `meta search` uses one Convex indexed query against `files_metadata_docs` per command. It filters pending metadata to the acting user, filters out other users' pending metadata, and hides committed metadata for files that user has pending edits on. Multi-predicate AND/OR is intentionally outside the command and should be composed by shell tools over path output.
- `Review changes` must switch into diff mode.
- `Accept all` does not save by itself.
- `Discard all` does not call a special clear mutation.
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
