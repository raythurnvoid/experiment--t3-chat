---
name: AI Tools Upgrade
overview: Improve only `write_page` and `edit_page`, with the main goal of making `edit_page` replacements far more reliable and easier to recover when matching fails.
todos:
  - id: edit-match-engine
    content: Make `edit_page` matching deterministic and resilient with candidate ranges, ranking, and safer replaceAll behavior.
    status: pending
  - id: edit-input-normalization
    content: Add preprocessing for common model artifacts (line-number prefixes, newline/escape/unicode normalization) before matching.
    status: pending
  - id: edit-error-ux
    content: Return actionable edit failures with candidate snippets and retry guidance instead of generic not-found/ambiguous errors.
    status: pending
  - id: write-edit-tests
    content: Add focused tests for write/edit reliability edge cases and regressions.
    status: pending
isProject: false
---

# Write/Edit Reliability Plan

## Scope

- Only touch write/edit behavior in:
  - [`packages/app/server/server-ai-tools.ts`](packages/app/server/server-ai-tools.ts)
  - [`packages/app/server/server-ai-tools.test.ts`](packages/app/server/server-ai-tools.test.ts)
- No wrappers, no policy system, no broader tool/runtime work.

## Main Problem

- `edit_page` currently depends on heuristic text replacement and often fails when model output is slightly transformed (prefixes, whitespace drift, escaping, duplicated blocks).
- Goal: increase successful replacements while preserving safety (no risky silent edits).

## Phase 1: Improve Matching Core (`replace_once_or_all`)

- Rework `replace_once_or_all` to operate on matched ranges (`start`, `end`) instead of only replacing by candidate text.
- Keep current replacer priority order, but gather all candidates, dedupe by range, and pick one deterministic winner when confidence is high.
- For `replaceAll`, replace explicit matched ranges in stable order (instead of global `split/join` on candidate text).
- Preserve safety behavior: if candidates remain ambiguous, fail with explicit reason.

## Phase 2: Normalize Inputs Before Matching

- Add a preprocessing step for `oldString` and `newString`:
  - normalize CRLF/LF
  - strip accidental `read_page` line prefixes like `00001| `
  - normalize common escaped newline artifacts
  - normalize common smart-quote/dash unicode variants
- Reuse the same normalization path in both `edit_page` and `write_page` where applicable.

## Phase 3: Better Failure Feedback

- Replace generic edit failures with structured output:
  - `reason`: `not_found` or `ambiguous`
  - `candidateCount`
  - up to 3 nearby snippet previews for retry
- Include concise retry guidance for the model:
  - include 3-5 lines before and after target block
  - avoid line-number prefixes from `read_page`
  - prefer unique anchored blocks

## Phase 4: Focused Test Coverage

- Expand `server-ai-tools.test.ts` for:
  - line-prefix contamination from `read_page`
  - newline/escape/unicode normalization
  - ambiguous duplicate blocks
  - `replaceAll` correctness on repeated sections
  - guardrails: empty `oldString`, no-op replacement (`oldString === newString`)

## Delivery Order

1. Matching core update
2. Input normalization
3. Error feedback improvements
4. Test coverage
