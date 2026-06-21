---
name: codebase-uniformity
description: Code aesthetic and organization alignment for this repository. Use when implementing, reviewing, or polishing changes that must look native to the surrounding codebase, especially after broad feature work, sub-agent patches, new modules, command additions such as `packages/app/convex/bash.ts`, Convex backend work, shared utilities, tests, or documentation/spec updates.
---

# Codebase Uniformity

Make a change look like it was written by the same engineer, in the same codebase, on the same day.

The goal is not generic cleanliness. The goal is local fit: vocabulary, file shape, helper size, ordering, comments, tests, and error handling should match the closest existing code.

# Core Principle

Derive style from evidence, not preference.

Before editing, identify the smallest set of local anchors that already solve similar problems. Let those anchors decide:

- where code belongs
- what names look like
- how much abstraction is acceptable
- how errors are returned or thrown
- how tests are grouped
- how comments are used
- how long lines are wrapped
- what should stay inline

Prefer a slightly less elegant implementation that matches the module over a cleaner implementation that introduces a new local dialect.

# Workflow

1. Read the current diff first.
2. Read the target file around the changed area.
3. Read at least two nearby or similar implementations before editing.
4. Write down the local pattern in concrete terms, then edit to that pattern.
5. Split the review lens when the diff is broad: organization first, comments second, naming third.
6. Re-read the final diff as a style review, not only a correctness review.
7. Remove changes that are merely personal taste.
8. Run the vocabulary audit for broad changes.
9. Run the smallest focused verification that covers the touched surface.

Do not start from broad repository-wide style. Start from the file and its nearest neighbors.

# References

Load only the reference that matches the touched surface:

- `references/bash-command.md` for `packages/app/convex/bash.ts`.
- `references/convex-backend.md` for `packages/app/convex/**`.
- `references/shared-parsers.md` for parser/serializer utilities under `packages/app/shared/**`.
- `references/tests.md` for adding, moving, or reviewing tests.
- `references/style-review-checklist.md` before finalizing a broad implementation or PR plan.

# Pattern Checklist

Use this checklist before accepting a patch.

- **Placement:** Code is inserted beside the nearest similar helper, command, query, mutation, hook, component, or test.
- **Names:** Module-private helpers follow local naming. In `bash.ts`, command-owned helpers use command-specific prefixes such as `search_command_*`, `find_command_*`, or `meta_command_*`.
- **Regions and ordering:** If the file uses regions or ordered sections, preserve them. In `bash.ts`, keep command helpers inside the matching command region.
- **Granularity:** Keep one-off logic inline unless a helper removes real duplication or hides a necessary external-system detail.
- **Validators:** In Convex modules, keep one-off `args` and `returns` validators inline at the registered function unless there is real reuse.
- **Errors:** Match the local boundary. Use Result `_nay` where the surrounding code does; use structured `console.error(errorMessage, errorData)` plus `should_never_happen(errorMessage, errorData)` for impossible Convex invariants.
- **Indexes:** Name Convex indexes from the indexed fields in order. If the full name is too long, abbreviate the least domain-important field consistently and keep the main domain term readable.
- **Comments:** Add comments only for non-obvious intent, gotchas, or external-system behavior. Do not narrate obvious code. Use concrete nouns from the code instead of vague abstractions.
- **Tests:** Put tests under the same `describe(...)` grouping and naming rhythm as the file already uses. Test public behavior unless a private helper is already naturally exposed by an existing pattern.
- **Docs/specs:** Update durable skills or README/spec files only when product behavior, architecture, or agent-facing workflows changed.

# Vocabulary Pass

Code uniformity includes vocabulary. After editing comments, docs, names, and logs:

- Run `vp env exec node .agents/skills/codebase-uniformity/scripts/diff-vocabulary-audit.mjs` to scan staged and unstaged added diff lines. Treat output as warnings, not hard failures.
- Search for newly introduced terms with `rg`, especially abstract nouns such as `projection`, `data`, `state`, `thing`, `stuff`, `handler`, or `manager`.
- Replace vague terms with the concrete docs, tables, commands, or values involved, such as `search chunks`, `metadata docs`, `pending docs`, `indexed docs`, or `Yjs branch`.
- In Convex comments and project guidance, use `doc/docs` for entries in Convex tables. Avoid `row/rows` unless quoting an API field, external source, or fixed identifier.
- Do not invent new umbrella terms when listing concrete code nouns is clearer.
- If a user challenges a word choice, treat it as a signal to run a vocabulary pass over the affected diff.

# Bash Command Code

Treat `packages/app/convex/bash.ts` as its own style island.

When adding or polishing a command:

- keep option parsing in a `*_command_parse_*_args` helper when nearby commands do
- use existing `read_option_value`, `parse_limit`, cursor helpers, path conversion helpers, and command exit constants
- print continuation commands in the same `Next page:` style as search/listing commands
- place formatting helpers before `*_command_create`
- return `{ stdout, stderr, exitCode }` directly
- keep command tests in the existing in-source `action_run` group
- verify with a focused `vitest` filter for the command behavior

Do not make app Bash look like host shell code. It is an indexed Convex-backed command surface with native-looking syntax.

# Convex Backend Code

When polishing Convex modules:

- read `.agents/skills/convex/SKILL.md` and its referenced guidelines when changing `packages/app/convex/**`
- prefer `ctx.db.get` when an id is already available
- prefer indexed queries over filters when the schema supports it
- keep query/mutation/action validators inline unless reused
- avoid tiny pass-through helpers that only rename arguments
- keep impossible linked-doc failures structured and explicit
- keep pagination and cursor output consistent with adjacent functions
- align schema comments with the actual table purpose: say which docs exist and why they are indexed

# Shared Utility Code

Shared modules should stay runtime-portable and direct.

- Keep exported types/functions limited to real cross-module API.
- Keep parser normalization or coercion narrow and documented when it differs from a strict external format.
- Prefer explicit small helpers when they mark a boundary, such as extraction, normalization, parsing, or formatting.
- Keep tests close to supported behavior and edge cases found in real app flows.

# Sub-Agent Style Audit

Use sub-agents when a change is large enough that style drift is likely, or when the user asks for a native-codebase pass. For large backend changes, treat the three-auditor pass as standard before final verification when sub-agents are available. If sub-agents are unavailable, perform the same three passes yourself.

Give each sub-agent:

- a concrete style goal
- a disjoint file scope
- the instruction to inspect local patterns before editing
- permission to make small edits or report no-op with evidence
- a focused verification requirement
- a reminder not to stage or commit

For broad uniformity requests, use separate auditors for:

- organization, regions, helper placement, and test ownership
- comments, logs, docs, and durable skill wording
- names of variables, helpers, exported APIs, fields, indexes, and tests

After they finish:

1. Read their actual diffs.
2. Keep only changes that improve local fit.
3. Reject or adjust patches that are merely different taste.
4. Verify cross-file references, generated names, and schema/index call sites yourself.
5. Record important rejected recommendations in the final answer so future work does not repeat the same debate.

Do not accept sub-agent output because it sounds confident. Accept it because the diff matches the local evidence.

# Pattern Capture

When a review establishes a new canonical pattern:

- Update the domain skill that owns the behavior, such as `ai-chat-agent`, `files-agent-pending-updates`, `convex`, or this skill.
- Add or update a short reference file here when the pattern is aesthetic or organizational rather than product behavior.
- Keep rejected recommendations visible in the final answer when they are likely to recur.
- Prefer references over adding long examples to `SKILL.md`.

# Final Review

Before finishing a uniformity pass, answer these questions:

- Would this look surprising if found while reading the surrounding file?
- Did the change introduce a new naming dialect?
- Did it add an abstraction the file would not normally add?
- Did it move code away from the nearest similar pattern?
- Did tests prove behavior rather than private implementation details?
- Did the vocabulary audit warn about terms that should be replaced?
- Did verification cover the edited surface without running unnecessary suites?

If the answer exposes style drift, fix the style before reporting completion.
