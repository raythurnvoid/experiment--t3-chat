---
name: pages-agent-pending-edits
description: Handles the Pages agent-edit review lifecycle (pending banner, diff review, accept/discard persistence). Use when fixing pending edits not clearing, diff newline noise, or Playwriter automation around `/pages` agent edits.
---

# Pages Agent Pending Edits

## What This Skill Covers

Use this skill for the `/pages` editor workflow where AI tools propose page edits and users review them in diff mode before persisting.

## Core Data Flow

1. AI tools (`write_page` / `edit_page`) in `packages/app/server/server-ai-tools.ts` generate proposed markdown.
2. Proposals are stored in `ai_chat_pending_edits` via `internal.ai_chat.upsert_ai_pending_edit`.
3. `PageEditor` queries `ai_chat.get_ai_pending_edit` and shows the pending-review banner.
4. User opens diff mode and reviews changes in `PageEditorDiff`.
5. On accepted-save or discard-all, pending edits must be explicitly cleared via `ai_chat.clear_ai_pending_edit`.

## Expected UX Invariants

- Pending banner appears in rich/plain editor when a pending edit exists.
- Clicking `Review changes` switches to `view=diff_editor`.
- `Accept all + save` persists to Yjs and removes pending edit DB state.
- `Discard all` removes pending edit DB state without persisting AI proposal.
- After clear, pending banner/CTA should not return on refresh unless a newer pending edit was created.

## Implementation Notes

- Use guarded clear to avoid races:
	- `clear_ai_pending_edit` accepts `expectedUpdatedAt`.
	- Clear only if current pending row matches expected timestamp.
- Normalize line endings at tool boundary (`\r\n` and `\r` -> `\n`) before diff creation and pending persistence to reduce noisy newline diffs.
- Keep changes minimal and colocated:
	- Convex lifecycle logic in `packages/app/convex/ai_chat.ts`
	- Tool normalization in `packages/app/server/server-ai-tools.ts`
	- Diff flow UX/actions in `packages/app/src/components/page-editor/page-editor.tsx` and `packages/app/src/components/page-editor/page-editor-diff/page-editor-diff.tsx`

## Playwriter QA Checklist

- Create a unique page on `/pages`.
- Use Agent sidebar chat to trigger `write_page`.
- Confirm pending banner appears (`Agent edits are pending review`).
- Open review, verify diff view opens.
- Run `Accept all + save`, refresh, confirm banner remains gone.
- Repeat with `Discard all`, confirm banner remains gone.
- Check diff for unexpected newline-only churn.

## Useful Stable Hooks

- `data-testid="pending-edits-banner"`
- `data-testid="review-changes-button"`
- `data-testid="page-diff-editor"`
- `data-testid="accept-all-save-button"`
- `data-testid="discard-all-button"`
