---
name: pages-agent-pending-edits
description: Handles the Pages agent-edit review lifecycle (pending banner, diff review, accept/discard persistence). Use when fixing pending edits not clearing, diff newline noise, or Playwriter automation around `/pages` agent edits.
---

# Pages Agent Pending Edits

## Architecture overview

This feature implements a reviewable AI-edit pipeline for `/pages`:

1. AI tools propose markdown changes for a page path.
2. Proposed content is persisted as a pending edit row.
3. Editor surfaces pending state in normal editor mode.
4. User opens diff mode and decides to accept-save or discard.
5. Pending row is cleared after a terminal action.

The goal is to keep AI writes explicit and user-reviewable before persistence.

## Core data flow

1. `write_page` / `edit_page` in `packages/app/server/server-ai-tools.ts` produce proposed markdown.
2. Server stores proposal via `internal.ai_chat.upsert_ai_pending_edit` (table: `ai_chat_pending_edits`).
3. UI queries pending state through `ai_chat.get_ai_pending_edit`.
4. Rich/plain editor shows pending banner and review CTA.
5. Diff editor compares current content vs pending proposal.
6. Terminal actions clear pending state through `ai_chat.clear_ai_pending_edit`.

## State model and transitions

States:

- `idle`: no pending row for `(workspaceId, projectId, pagePath)`.
- `pending`: pending row exists; editor shows review affordance.
- `reviewing`: user is in `view=diff_editor`.
- `resolved`: accept-save or discard cleared pending row.

Transitions:

- `idle -> pending`: AI tool upsert.
- `pending -> reviewing`: `Review changes`.
- `reviewing -> resolved`: `Accept all + save` or `Discard all`.
- `resolved -> pending`: a newer AI tool proposal is created.

## Data consistency and race protection

- Pending clear is guarded by `expectedUpdatedAt` so stale clients cannot clear newer proposals.
- Clear operation should be a no-op if timestamps do not match current row.
- UI should treat pending presence as source of truth and re-check on refresh/reload.

## Diff correctness and normalization

- Normalize line endings at tool boundary before persistence/diffing:
	- `\r\n` -> `\n`
	- `\r` -> `\n`
- This reduces noisy newline-only churn and keeps diff semantics stable across OS/editor sources.

## UI integration points

- Pending indicators live in editor mode (rich/plain).
- `Review changes` switches route/query to diff editor mode.
- Diff editor exposes accept/discard controls and should clear pending state on terminal actions.

Stable hooks:

- `data-testid="pending-edits-banner"`
- `data-testid="review-changes-button"`
- `data-testid="page-diff-editor"`
- `data-testid="accept-all-save-button"`
- `data-testid="discard-all-button"`

## Source files

- `packages/app/server/server-ai-tools.ts`
- `packages/app/convex/ai_chat.ts`
- `packages/app/src/components/page-editor/page-editor.tsx`
- `packages/app/src/components/page-editor/page-editor-diff/page-editor-diff.tsx`

## Architectural invariants

- Pending UI appears iff pending row exists for the current page context.
- `Review changes` must always navigate to diff editor mode.
- Accept-save persists proposal and clears pending state.
- Discard clears pending state without persisting proposal.
- Cleared pending state must remain cleared after refresh unless a newer proposal exists.
- Guarded clear (`expectedUpdatedAt`) must remain enforced.

## Failure modes to watch

- Pending banner reappears after accept/discard due to clear race or stale query state.
- Diff view opens but terminal actions do not clear DB state.
- Newline normalization regression causing unstable/noisy diffs.
- Baseline/proposal source mismatch causing confusing or incorrect hunks.

## Verification checklist

- Trigger proposal from AI tool and confirm pending banner appears.
- Open review and verify diff editor mode and controls render.
- Accept-save path: confirm content persisted and pending state cleared after refresh.
- Discard path: confirm proposal not persisted and pending state cleared after refresh.
- Repeat with a rapid successive proposal to validate guarded clear behavior.
