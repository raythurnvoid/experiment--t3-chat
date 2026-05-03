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

Each pending row is a per-user, per-file Yjs snapshot that tracks three states:

- `base`: the live file state the pending update was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation enables per-hunk accept/discard, `Accept all` without saving, partial saves that keep unresolved edits pending, sync/rebase against newer live file state, and safe deletion when both branches collapse back to the live base.

# Data Model

Main table in `packages/app/convex/schema.ts`:

- `files_pending_updates`
  - `workspaceId`
  - `projectId`
  - `userId`
  - `nodeId`
  - `baseYjsSequence`
  - `baseYjsUpdate`
  - `stagedBranchYjsUpdate`
  - `unstagedBranchYjsUpdate`
  - `updatedAt`

Saved-sequence marker table:

- `files_pending_updates_last_sequence_saved`
  - `workspaceId`
  - `projectId`
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

# End-To-End Flow

1. AI tools in `packages/app/server/server-ai-tools.ts` read file content through `internal.files_nodes.get_file_last_available_markdown_content_by_path`.
2. That read path overlays the current user's pending `unstaged` branch when one exists.
3. `write_file` and `edit_file` normalize line endings/trailing newline shape, compute a preview diff, and call `internal.files_pending_updates.upsert_file_pending_update_internal`.
4. Agent calls omit `stagedMarkdown`, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `files_pending_updates` creates or updates a row for `(workspaceId, projectId, userId, nodeId)`.
6. `FileEditor` queries `list_files_pending_updates` and shows the floating pending banner whenever the user has any pending updates.
7. `Review changes` switches the `/files` route to `view=diff_editor`.
8. `FileEditorDiff` bootstraps from the pending row if present, otherwise from live file Yjs state.
9. In the diff editor, original side is `staged` and modified side is `unstaged`.
10. Local Monaco edits debounce back into `upsert_file_pending_update`.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. `Save` flushes pending upserts, then calls `save_file_pending_update`.
14. `save_file_pending_update` writes only the `staged` diff into the live file Yjs stream through `files_db_yjs_push_update`.
15. The saved-sequence marker is upserted even when the live file already matched the staged branch and no new Yjs packet was inserted.
16. If `unstaged` now matches the saved live file state, the row is deleted.
17. If unresolved edits remain, the row stays alive with `base` and `staged` advanced to saved live content.
18. `Sync` rebases both branches on top of the latest live Yjs state through `persist_file_pending_update_rebased_state`.

# Backend Responsibilities

Main module:

- `packages/app/convex/files_pending_updates.ts`

Public and internal functions:

- `upsert_file_pending_update`
- `upsert_file_pending_update_internal`
- `persist_file_pending_update_rebased_state`
- `get_file_pending_update`
- `get_file_pending_update_internal`
- `get_file_pending_update_last_sequence_saved`
- `list_files_pending_updates`
- `save_file_pending_update`
- `remove_file_pending_update_if_expired`

Important behavior:

- Upsert reconstructs existing branch docs or clones the live file base, projects incoming Markdown into `unstaged`, projects `staged` only when `stagedMarkdown` is provided, and deletes the row if both branches match base.
- Rebase persistence rejects stale live bases and only accepts rebased state built from the current live file snapshot.
- Save applies remote drift from base into both branches before saving, persists only the `staged` diff to the live file, writes the saved-sequence marker, and keeps the row alive on partial save.
- Public mutations are rate-limited after membership validation and before writes.
- Saves that push a live Yjs diff must pass the billing credit gate and emit one `file_save` usage event. The billing event name is intentionally unchanged for now to avoid a separate billing taxonomy migration.

# Client Responsibilities

`packages/app/src/components/file-editor/file-editor.tsx` owns:

- floating banner for "Agent edits are pending review"
- `Review changes` CTA
- previous/next pager across all pending files for the current user

`packages/app/src/components/file-editor/file-editor-diff/file-editor-diff.tsx` owns:

- bootstrapping from pending row or live file state
- Monaco diff editor state
- debounced pending-row upserts
- per-hunk accept/discard widgets
- `Save`
- `Sync`
- `Accept all`
- `Accept all + save`
- `Discard all`

# Cleanup And Expiry Model

- Every active pending row gets a cleanup task.
- Normal expiry window is 4 hours.
- On reconnect / new presence session, cleanup is rescheduled back to the long-lived TTL.
- When the last presence session disconnects, cleanup is shortened to 30 seconds.
- If another session is still online, disconnect does not shorten cleanup.
- Every scheduled cleanup carries `expectedUpdatedAt`.
- `remove_file_pending_update_if_expired` only deletes the row if the current row still has that exact `updatedAt`.

# Architectural Invariants

- Pending updates are per-user rows keyed by `(workspaceId, projectId, userId, nodeId)`.
- A pending row exists only while either `staged` or `unstaged` differs from `base`.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.
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
- `Save` should persist only the staged branch and keep the row if unresolved unstaged content remains.
- `Accept all + save` should clear the row when no unresolved changes remain.
- `Sync` should preserve local intent while rebasing on newer live file state.
