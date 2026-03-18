---
name: pages-agent-pending-edits
description: describes the current `/pages` pending-edits system, Yjs-backed branch state, diff review, partial save, sync/rebase, and TTL cleanup. Use when fixing pending banners, save/sync/review bugs, AI page-tool behavior, or presence/expiry cleanup.
---

# When to use this skill

Use this when investigating or changing any part of the `/pages` pending-edits lifecycle:

- Pending banner shows the wrong state or does not clear.
- AI `write_page` / `edit_page` proposals behave unexpectedly.
- Diff editor accept/discard/save/sync behavior is wrong.
- Rebasing, remote drift, or stale-base errors appear.
- Pending edits expire too early, not at all, or react incorrectly to presence reconnect/disconnect.
- Playwriter or future UI automation needs stable mental models for pending edits.

# Commit landmarks

These two commits define the current architecture:

- `fadb7e41` - refactors pending edits from a simple markdown overlay into a Yjs-backed branch model with base, staged, and unstaged branches.
- `ac866684` - adds row-scoped expiry, stale-task protection, and presence-driven TTL shortening/restoration.

If current behavior seems confusing, read those commits first.

# Big picture

This is not a "one pending markdown blob" system anymore.

Each pending edit row is a per-user, per-page Yjs snapshot that tracks three states:

- `base`: the live page state the pending edit was built from.
- `staged`: the branch that save will persist.
- `unstaged`: the unresolved/proposed branch shown on the modified side of the diff editor.

That separation is what enables:

- per-hunk accept/discard;
- `Accept all` without saving;
- partial save that keeps unresolved edits pending;
- sync/rebase against newer live page state;
- safe deletion only when both branches collapse back to the live base.

There is also a separate save marker:

- `pages_pending_edits_last_sequence_saved` stores the last live page Yjs sequence produced by `save_pages_pending_edit` for `(workspaceId, projectId, userId, pageId)`.
- This marker exists so an already-open diff editor in another tab can distinguish "the pending row disappeared because of a real save" from "the pending row disappeared because local edits collapsed back to base without saving".

# End-to-end flow

1. AI tools in `packages/app/server/server-ai-tools.ts` read page content through `internal.ai_docs_temp.get_page_last_available_markdown_content_by_path`.
2. That read path overlays the current user's pending `unstaged` branch if one exists, so follow-up AI reads can see pending content instead of only committed markdown.
3. `write_page` and `edit_page` normalize line endings and trailing newline shape, compute a preview diff, then call `api.pages_pending_edits.upsert_pages_pending_edit_updates`.
4. Agent calls omit `stagedMarkdown`, so the backend preserves the current `staged` branch and updates only `unstaged`.
5. `upsert_pages_pending_edit_updates` in `packages/app/convex/pages_pending_edits.ts` creates or updates a row in `pages_pending_edits` for `(workspaceId, projectId, userId, pageId)`.
6. `PageEditor` in `packages/app/src/components/page-editor/page-editor.tsx` queries `list_pages_pending_edits` and shows a floating banner whenever the user has any pending edits, even on a different page.
7. `Review changes` switches the `/pages` route to `view=diff_editor`.
8. `PageEditorDiff` in `packages/app/src/components/page-editor/page-editor-diff/page-editor-diff.tsx` bootstraps from the pending row if present, otherwise from live page Yjs state.
9. In the diff editor:
   - original side = `staged` branch
   - modified side = `unstaged` branch
10. Local Monaco edits debounce back into `upsert_pages_pending_edit_updates`, so the backend row stays close to the current review state.
11. `Accept all` copies unstaged content into staged content.
12. `Discard all` copies staged content into unstaged content.
13. Those actions are editor-model operations first; the usual debounced upsert persists the new branch state and deletes the row if both branches now match the base.
14. `Save` and `Accept all + save` flush pending upserts, then call `save_pages_pending_edit`.
15. `save_pages_pending_edit` writes only the `staged` diff into the live page Yjs stream through `pages_db_yjs_push_update`.
16. `save_pages_pending_edit` also upserts `pages_pending_edits_last_sequence_saved` with the resolved saved base sequence, even when the live page already matched the staged branch and no new Yjs update packet was inserted.
17. If `unstaged` now matches the saved live page state, the row is deleted.
18. If unresolved edits remain, the row stays alive, with `base` and `staged` advanced to the saved live content and `unstaged` preserved as the unresolved branch.
19. `Sync` rebases both branches on top of the latest live Yjs state and persists the rebased row with `persist_pages_pending_edit_rebased_state`.

# Data model

Main table in `packages/app/convex/schema.ts`:

- `pages_pending_edits`
  - `workspaceId`
  - `projectId`
  - `userId`
  - `pageId`
  - `baseYjsSequence`
  - `baseYjsUpdate`
  - `stagedBranchYjsUpdate`
  - `unstagedBranchYjsUpdate`
  - `updatedAt`

Saved-sequence marker table:

- `pages_pending_edits_last_sequence_saved`
  - `workspaceId`
  - `projectId`
  - `userId`
  - `pageId`
  - `lastSequenceSaved`
  - `updatedAt`

Cleanup table:

- `pages_pending_edits_cleanup_tasks`
  - `pendingEditId`
  - `scheduledFunctionId`
  - `expectedUpdatedAt`

Important consequence:

- The authoritative identity is per user, not global per page.
- Two users can each have independent pending edits on the same page.
- The save marker is also per user, not global per page.
- The save marker is additive: old pages may legitimately have no row until that user performs the first pending-edit save after rollout.

# Backend responsibilities

# `packages/app/convex/ai_chat.ts`

Main pending-edit mutations and queries:

- `upsert_pages_pending_edit_updates`
- `persist_pages_pending_edit_rebased_state`
- `get_pages_pending_edit`
- `get_pages_pending_edit_last_sequence_saved`
- `list_pages_pending_edits`
- `save_pages_pending_edit`
- `remove_pages_pending_edit_if_expired`

Important behavior:

- `upsert_pages_pending_edit_updates` reconstructs existing Yjs branch docs or clones the live base, projects incoming markdown into `unstaged`, projects `staged` only when `stagedMarkdown` is provided, and deletes the row if both branches match the base.
- `persist_pages_pending_edit_rebased_state` rejects stale live bases and only accepts rebased state built from the current live page snapshot.
- `save_pages_pending_edit` applies remote drift from base into both branches before saving, persists only the `staged` diff to the live page, writes the saved-sequence marker, and keeps the row alive on partial save.
- `upsert_pages_pending_edit_updates` and `persist_pages_pending_edit_rebased_state` do not touch the saved-sequence marker.

# `packages/app/server/pages.ts`

Shared helpers:

- `pages_db_get_yjs_content_and_sequence`
- `pages_db_cancel_pending_edit_cleanup_tasks`
- `pages_db_schedule_pending_edit_cleanup`
- `pages_db_reschedule_pending_edit_cleanup_for_user`

These helpers make cleanup row-scoped and keep one scheduled cleanup task per pending row.

# `packages/app/convex/ai_docs_temp.ts`

Two important roles:

- `get_page_last_available_markdown_content_by_path` overlays the current user's pending `unstaged` branch onto reads.
- `pages_db_yjs_push_update` writes accepted changes back into the live Yjs page stream.

The overlay is easy to miss, but it is crucial: AI tools can chain from pending content before anything is committed.

# Client-side responsibilities

# `packages/app/src/components/page-editor/page-editor.tsx`

This file owns the global pending queue UI:

- floating banner for "Agent edits are pending review"
- `Review changes` CTA
- previous/next pager across all pending pages for the current user

Important nuance:

- The banner is global to the user's pending queue, not just the current page.
- The review button only shows when the current page has pending edits and the user is not already in diff mode.

# `packages/app/src/components/page-editor/page-editor-diff/page-editor-diff.tsx`

This file owns the review workflow:

- bootstrapping from pending row or live page state
- Monaco diff editor state
- debounced pending-row upserts
- per-hunk accept/discard widgets
- `Save`
- `Sync`
- `Accept all`
- `Accept all + save`
- `Discard all`

Important nuances:

- `Discard all` is not a dedicated backend clear mutation.
- `Accept all` and `Discard all` mutate editor models first; the regular upsert path later persists or deletes the row.
- Save and sync both flush pending debounced writes first to avoid races with older queued upserts.
- `PageEditorDiff` has two distinct client phases: bootstrap on mount, then reconcile later `pendingEdit` updates into already-mounted Monaco models.
- `PageEditorDiff` also reads `get_pages_pending_edit_last_sequence_saved`, but it must not treat that marker like a generic live-update subscription.
- The current intended behavior is: when there is no active pending row and `lastSequenceSaved` advances past the tab's in-memory `pageContentData.yjsSequence`, refetch the live page content once.
- Do not trigger that refetch from `get_page_last_yjs_sequence` alone, because unrelated live edits should still require explicit `Sync`.
- When the diff editor is already open and a newer remote pending row arrives, the reconcile path must not blindly preserve stale Monaco modified content.
- The current intended behavior is: if there is no real local unsynced draft, adopt the incoming remote pending state directly; only use the merge/rebase path when preserving actual local draft intent.
- If the diff editor is already mounted, treat Monaco model contents as local draft candidates, not automatically as authoritative local intent; provenance matters more than content equality.

# `packages/app/src/lib/pages.ts`

Key client helpers:

- `pages_fetch_page_yjs_state_and_markdown`
- `pages_yjs_rebase_branch_with_local_markdown`
- `pages_yjs_reconcile_branch_with_local_markdown`

These helpers make local diff-editor state survive remote drift and reconcile cleanly with refreshed server state.

Helper selection guidance:

- Use `pages_yjs_rebase_branch_with_local_markdown` when the problem is base drift: previous base -> next base while preserving a branch's local markdown.
- Use `pages_yjs_reconcile_branch_with_local_markdown` when the problem is previous remote branch -> next remote branch while preserving local editor intent.
- In `PageEditorDiff`, newer pending rows arriving into an already-mounted diff editor are usually a branch-reconciliation problem, not a base-rebase problem.

# Cleanup and expiry model

Expiry was hardened in `ac866684`.

Current rules:

- Every active pending row gets a cleanup task.
- Normal expiry window is 4 hours.
- On reconnect / new presence session, cleanup is rescheduled back to the long-lived TTL.
- When the last presence session disconnects, cleanup is shortened to 30 seconds.
- If another session is still online, disconnect does not shorten cleanup.

Race protection:

- Every scheduled cleanup carries `expectedUpdatedAt`.
- `remove_pages_pending_edit_if_expired` only deletes the row if the current row still has that exact `updatedAt`.
- Old scheduled tasks therefore become harmless no-ops after any newer edit, save, or rebase.

# Test coverage

The main backend coverage lives in `packages/app/convex/pages_pending_edits.test.ts`.

Important covered behaviors:

- deterministic upsert / replacement;
- deletion when branches collapse back to base;
- cleanup task refresh on new row versions;
- user-wide cleanup rescheduling;
- last-session disconnect shortens cleanup;
- multi-session disconnect leaves cleanup unchanged;
- partial save preserves unresolved row;
- full save clears row;
- save while live page drift exists;
- save marker row is written on full save;
- save marker row is written on partial save;
- save marker row is not written by non-save pending/rebase paths;
- rebased-state persistence;
- rebased-state deletion when no diff remains;
- stale-base rejection;
- stale scheduled cleanup no-op behavior;
- matching scheduled cleanup deletion.

Additional coverage:

- `packages/app/server/server-ai-tools.test.ts`
  - `write_page` stores generalized pending edits
  - `edit_page` stores generalized pending edits
- `packages/app/src/lib/pages.test.ts`
  - rebasing when local and remote already match
  - preserving a local unsynced draft over a newer remote base
  - rebasing an existing branch over a newer base
  - collapsing back to base when no branch diff remains

Current gap to remember:

- There is no strong frontend/E2E coverage for the full `/pages` review lifecycle yet.

# Stable UI hooks

Current stable selectors / labels that exist in code:

- `data-testid="pending-edits-banner"`
- `data-testid="review-changes-button"`
- diff root has `aria-label="Page diff editor"`
- toolbar buttons use visible labels:
  - `Save`
  - `Sync`
  - `Accept all`
  - `Accept all + save`
  - `Discard all`

Do not rely on the older nonexistent hooks:

- `data-testid="page-diff-editor"`
- `data-testid="accept-all-save-button"`
- `data-testid="discard-all-button"`

# Architectural invariants

- Pending edits are per-user rows keyed by `(workspaceId, projectId, userId, pageId)`.
- A pending row exists only while either `staged` or `unstaged` differs from `base`.
- `Review changes` must switch into diff mode.
- `Accept all` does not save by itself.
- `Discard all` does not call a special clear mutation.
- `Save` can partially resolve a pending edit and keep the unresolved branch alive.
- `Sync` must rebase on top of the latest live page state before persisting.
- Stale rebases must be rejected.
- Active edits must keep refreshing their expiry window.
- AI reads must continue to see the current user's pending `unstaged` branch overlay.

# Common failure modes

- Banner reappears because a debounced upsert lands after a save/sync path that did not flush first.
- Pending row never clears because `unstaged` still differs from the saved live base after a partial save.
- An already-open diff editor in another tab can stay stale if it relies only on pending-row deletion and never checks the saved-sequence marker against its local page sequence.
- Sync fails with a stale-base error because the caller persisted a rebase built from an outdated live page state.
- Follow-up AI tools appear inconsistent because they read overlayed pending content, not only committed markdown.
- An already-open diff editor can fail to show a new agent proposal immediately if the client reconcile path preserves stale Monaco modified content over the newer remote pending row.
- Cleanup deletes the wrong version unless `expectedUpdatedAt` protection remains intact.
- Multi-session presence behavior becomes wrong if disconnect always shortens cleanup, even with another session still online.

# Debugging checklist

When debugging, inspect these in order:

1. Does `list_pages_pending_edits` or `get_pages_pending_edit` return the row you expect?
2. What does `get_pages_pending_edit_last_sequence_saved` return for this user/page, and is `lastSequenceSaved` newer than the tab's local `pageContentData.yjsSequence`?
3. Does the row's `base / staged / unstaged` state explain the UI, or are you assuming a simpler single-markdown model?
4. If the page is already open in `diff_editor`, did the mounted Monaco models actually adopt the latest pending row, or did client-side reconcile preserve older local model content?
5. Did a save or sync path flush pending debounced upserts first?
6. Is the row supposed to clear, or is this actually a partial-save case with unresolved `unstaged` content?
7. Is the live page state newer than the pending row's base?
8. Is cleanup being rescheduled correctly for the latest `updatedAt`?
9. Is presence shortening cleanup only after the last session disconnects?

# Verification checklist

- Trigger an AI proposal and confirm the floating pending banner appears.
- Confirm `Review changes` enters diff mode for the current page.
- With the page already open in diff mode, trigger a new AI proposal and confirm the mounted diff updates immediately without reload or remount.
- Confirm previous/next navigation can move across the pending queue.
- In diff mode, verify per-hunk accept/discard updates the correct side.
- `Accept all` should stage everything without saving.
- `Discard all` should revert unstaged content back to staged content.
- `Save` should persist only the staged branch and keep the row if unresolved unstaged content remains.
- `Accept all + save` should clear the row when no unresolved changes remain.
- With two tabs open in diff mode, save from one tab and confirm the other tab refetches only because `lastSequenceSaved` advanced past its local page sequence.
- Collapse a pending row back to base without saving and confirm the other tab does not perform that same refetch.
- `Sync` should preserve local intent while rebasing on newer live page state.
- Refresh after save/discard and confirm the row stays cleared unless a newer proposal exists.
