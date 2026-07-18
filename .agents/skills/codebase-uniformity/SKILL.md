---
name: codebase-uniformity
description: Code aesthetic and organization alignment for this repository. Use when implementing, reviewing, or polishing changes that must look native to the surrounding codebase, especially after broad feature work, sub-agent patches, new modules, command additions such as `packages/app/server/bash.ts`, Convex backend work, shared utilities, tests, or documentation/spec updates.
---

# Derive Style From Local Evidence

Make each change look like it was written by the same engineer, in the same codebase, on the same day. Match the closest existing code's vocabulary, file shape, helper size, ordering, comments, tests, and error handling instead of applying generic cleanliness preferences.

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
6. Re-read the final diff as a style review, not only a correctness review. Check JSDoc layout and the empty lines between logical chunks.
7. Remove changes that are merely personal taste.
8. Run the vocabulary audit for broad changes.
9. Run the smallest focused verification that covers the touched surface.

Do not start from broad repository-wide style. Start from the file and its nearest neighbors.

# References

Load only the reference that matches the touched surface:

- `references/bash-command.md` for `packages/app/server/bash.ts`, `packages/app/server/bash-delegate.ts`, `packages/app/server/bash-cat-command.ts`, `packages/app/server/bash-cp-command.ts`, `packages/app/server/bash-find-command.ts`, `packages/app/server/bash-grep-command.ts`, `packages/app/server/bash-head-tail-wc-command.ts`, `packages/app/server/bash-ls-command.ts`, `packages/app/server/bash-meta-command.ts`, `packages/app/server/bash-mv-command.ts`, `packages/app/server/bash-nested-shell-command.ts`, `packages/app/server/bash-rm-command.ts`, `packages/app/server/bash-search-command.ts`, `packages/app/server/bash-sed-command.ts`, `packages/app/server/bash-stat-command.ts`, `packages/app/server/bash-tee-command.ts`, `packages/app/server/bash-textgrep-command.ts`, `packages/app/server/bash-touch-command.ts`, `packages/app/server/bash-tree-command.ts`, `packages/app/server/bash-utils.ts`, `packages/app/server/bash-xargs-command.ts`, and `packages/app/server/bash-which-command.ts`.
- `references/convex-backend.md` for `packages/app/convex/**`.
- `references/frontend-app-code.md` for `packages/app/src/**` React components and frontend lib utilities.
- `references/shared-parsers.md` for parser/serializer utilities under `packages/app/shared/**`.
- `references/tests.md` for adding, moving, or reviewing tests.
- `references/style-review-checklist.md` before finalizing a broad implementation or PR plan.

# Pattern Checklist

Use this checklist before accepting a patch.

- **Placement:** Code is inserted beside the nearest similar helper, command, query, mutation, hook, component, or test.
- **Definition order:** Prefer defining module-private helpers before their users when the file can do so without breaking a stronger local grouping. Avoid leaving a new helper below its first call site.
- **Names:** Module-private helpers follow local naming. Do not add a file, feature, or domain prefix by default. Prefix symbols when they are exported and need import-site context, or when several owned helpers share one file. In a dedicated command module such as `bash-search-command.ts`, private helpers can drop the module prefix while exported symbols keep import-site context. Private helpers should stay plainly descriptive unless nearby code has a stronger local convention.
- **Regions and ordering:** If the file uses regions or ordered sections, preserve them. Never introduce nested regions. If you add a `// #region`, close it with `// #endregion` before the next region begins; otherwise prefer plain `// Section name` comments. In `bash.ts`, keep command helpers inside the matching command region. Dedicated `bash-*-command.ts` modules do not use command-region markers.
- **Granularity:** Keep one-off logic inline unless a helper removes real duplication or hides a necessary external-system detail.
- **Existing dependencies:** Before hand-rolling algorithmic code (diffing, parsing, formatting), check `package.json` and existing usage for a dependency that already does it — for example unified diffs come from `createPatch` in the `diff` package, already used in `server/server-ai-tools.ts` and the file editor.
- **Prompt literals:** Follow the closest owning module. In `ai_chat.ts`, keep one prompt sentence per array entry and join the entries with `"\n"`, matching `TITLE_SYSTEM_PROMPT` and `ai_chat_system_prompt`. Keep `+` concatenation and explicit `\n` line endings where nearby conditional or interpolated prompts use that form. Do not rewrite one valid form into the other as style-only churn.
- **Types:** Keep one-off callback and object shapes inline unless a named type is exported, reused, recursive, derived from an external API, or gives a real domain concept a name. In extracted Bash command modules, preserve the original `*_command_create` signatures instead of adding dependency object plumbing.
- **Validators:** In Convex modules, keep one-off `args` and `returns` validators inline at the registered function unless there is real reuse.
- **Errors:** Match the local boundary. Use Result `_nay` where the surrounding code does; use structured `console.error(errorMessage, errorData)` plus `should_never_happen(errorMessage, errorData)` for impossible Convex invariants.
- **Indexes:** Name Convex indexes from the indexed fields in order. If the full name is too long, abbreviate the least domain-important field consistently and keep the main domain term readable.
- **Comments:** Add comments only for non-obvious intent, gotchas, or external-system behavior. Do not narrate obvious code. Use concrete nouns from the code instead of vague abstractions. Use JSDoc only when the comment documents the symbol immediately below it. For module-level notes, file overview comments, and section headers, use ordinary `//` comments instead of orphan `/** ... */` blocks.
- **JSDoc layout:** Use multi-line JSDoc by default, including one-sentence docs. Keep a single-line JSDoc only for a very short label when the compact form makes a tight group of small symbols easier to scan. Reasons, lifecycles, constraints, warnings, wrapped text, and tags always use the multi-line form. When unsure, use multi-line JSDoc.
- **Comment placement:** Put comments that explain a branch or loop before the `if`, `else if`, `else`, `for`, or `while` block so the intent remains visible when the block is collapsed in the IDE. Keep comments inside the block only when they explain a specific statement inside it.
- **Vertical spacing:** Use one empty line between different logical chunks, such as configuration, validation, reads, calculations, writes, and the final result. Keep the statements that complete one small step together. Do not add an empty line after every statement.
- **Retry helpers:** When an option changes retry acceptance, add a short JSDoc to the helper. Name the exact value being waited for, why a weaker condition is insufficient, and which external system can return stale data.
- **Tests:** Put tests under the same `describe(...)` grouping and naming rhythm as the file already uses. Test public behavior unless a private helper is already naturally exposed by an existing pattern.
- **Docs/specs:** Update durable skills or README/spec files only when product behavior, architecture, or agent-facing workflows changed.

# Vocabulary Pass

Code uniformity includes vocabulary. After editing comments, docs, names, and logs:

- Run `vp env exec node .agents/skills/codebase-uniformity/scripts/diff-vocabulary-audit.mjs --all -- "<touched-paths>"` for a broad change, after replacing the quoted placeholder with one or more real paths. The scoped form also scans matching untracked files and keeps warnings reviewable. Omit the path scope only when a whole-repository diff review is useful. Treat output as warnings, not hard failures.
- Search for newly introduced terms with `rg`, especially abstract nouns such as `projection`, `data`, `state`, `thing`, `stuff`, `handler`, or `manager`.
- Replace vague terms with the concrete docs, tables, commands, or values involved, such as `search chunks`, `metadata docs`, `pending docs`, `indexed docs`, or `Yjs branch`.
- In Convex comments and project guidance, use `doc/docs` for entries in Convex tables. Avoid `row/rows` unless quoting an API field, external source, or fixed identifier.
- Do not invent new umbrella terms when listing concrete code nouns is clearer.
- If a user challenges a word choice, treat it as a signal to run a vocabulary pass over the affected diff.

# Bash Command Code

Treat `packages/app/server/bash.ts`, `packages/app/server/bash-delegate.ts`, `packages/app/server/bash-cat-command.ts`, `packages/app/server/bash-cp-command.ts`, `packages/app/server/bash-find-command.ts`, `packages/app/server/bash-grep-command.ts`, `packages/app/server/bash-head-tail-wc-command.ts`, `packages/app/server/bash-ls-command.ts`, `packages/app/server/bash-meta-command.ts`, `packages/app/server/bash-mv-command.ts`, `packages/app/server/bash-nested-shell-command.ts`, `packages/app/server/bash-rm-command.ts`, `packages/app/server/bash-search-command.ts`, `packages/app/server/bash-sed-command.ts`, `packages/app/server/bash-stat-command.ts`, `packages/app/server/bash-tee-command.ts`, `packages/app/server/bash-textgrep-command.ts`, `packages/app/server/bash-touch-command.ts`, `packages/app/server/bash-tree-command.ts`, `packages/app/server/bash-utils.ts`, `packages/app/server/bash-xargs-command.ts`, and `packages/app/server/bash-which-command.ts` as their own style island.

When adding or polishing a command:

- keep option parsing in a `*_command_parse_*_args` helper when several commands share one file; use plain private names like `parse_args` inside a dedicated command module
- keep extracted command modules unregioned; reserve command regions for `server/bash.ts`
- in extracted Bash command modules, preserve the original `*_command_create` signatures instead of adding dependency object plumbing, and prefix exported command entrypoints with `bash_`, such as `bash_grep_command_*`
- use existing `read_option_value`, `parse_limit`, cursor helpers, path conversion helpers, and command exit constants
- print continuation commands in the same `Next page:` style as search/listing commands
- place formatting helpers before `*_command_create`
- return `{ stdout, stderr, exitCode }` directly
- keep command tests in the existing in-source `action_run` group unless a nearby focused test file, such as `bash-meta-command.test.ts`, already owns the behavior
- keep `convex/bash.ts` to action registration and validators; `server/bash.ts` exports `bash_run_command` for that action boundary; `server/bash-delegate.ts` owns native Just Bash value imports and built-in delegation; `server/bash-utils.ts` owns prefixed path helpers, shared bash constants, db-files helpers, and the `cp`/`mv` operand parser used by extracted command modules; and `bash_fs_create`, raw filesystem classes, command factories, tmp helpers, and formatting helpers stay module-private unless preserving an original moved signature requires exporting an existing symbol
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

# Auth And External State Comments

Auth bootstrap code often coordinates two authorities, such as Clerk token claims and Convex `users` docs. Comments in that code should explain the authority boundary and stale-state window, not restate the branch:

- Name the exact external value that can lag, such as Clerk's `external_id` JWT claim.
- Name the app-owned value that is authoritative, such as the Convex `users` id returned by `resolve_user`.
- When retrying, document the acceptance condition. For example, say that `expectedUserId` waits for a token whose `external_id` equals the resolved Convex user id, not merely any non-empty `external_id`.
- Mention development data resets only when they are the real reachable cause of the mismatch; otherwise keep the comment about the product invariant.

# Sub-Agent Style Audit

Use sub-agents when a change is large enough that style drift is likely, or when the user asks for a native-codebase pass. For large backend changes, treat the three-auditor pass as standard before final verification when sub-agents are available. If sub-agents are unavailable, perform the same three passes yourself.

Give each sub-agent:

- a concrete style goal
- a disjoint file scope
- the instruction to inspect local patterns before editing
- authority that matches the user's request: report-only for review or investigation tasks, and permission for small edits only when the task authorizes changes
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

- When the parent task authorizes documentation changes, update the domain skill that owns the behavior, such as `ai-chat-agent`, `files-agent-pending-updates`, `convex`, or this skill. For a review-only task, report the recommended update without editing.
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
- Are JSDoc blocks multi-line by default, with every single-line exception clearly helping scanability?
- Do empty lines show the logical chunks without splitting statements that belong to one step?
- Did the vocabulary audit warn about terms that should be replaced?
- Did verification cover the edited surface without running unnecessary suites?

If the answer exposes style drift, fix the style before reporting completion.
