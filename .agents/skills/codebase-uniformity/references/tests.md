# Test Organization Patterns

Use this reference when adding, moving, or reviewing tests.

## Cursor Test Discovery

- Keep Vitest's config exclusions in both `.vscode/settings.json` and the local, Git-ignored `t3-chat.code-workspace`. The setting has window scope, so Cursor ignores the folder copy when both workspace folders are open.
- Skip reference repos in both copies. The workspace copy must also skip personal `sources/` and `+ai/` folders, which can contain copied test configs. Keep the extension's default exclusions too.
- After changing these settings, use **Developer: Reload Window** in Cursor and check the Vitest output.

## Anchors

- Prefer a module-owned test file when a feature has a natural Convex module owner, such as `organizations.test.ts` for `convex/organizations.ts`.
- Keep tests beside established fixtures when moving would duplicate large setup. Metadata integration tests currently live in `files_nodes.search_metadata.test.ts` because they reuse the file-tree fixtures in `files_nodes.setup.test.ts`; record such placement as an intentional tradeoff.
- Shared utility tests should use top-level `describe("<public_function>")` groups.
- Script CLI tests live beside the script and run in the `scripts` Vitest project with Node. Keep filesystem fixtures and caches in the personal sibling folder. `scripts/typecheck.test.ts` is the example.
- `server/bash.test.ts` and `server/bash.*.test.ts` command tests should stay under the existing `bash_run_command` group and use behavior-first test names. `server/bash.ts` keeps in-source tests only for its private helpers.
- Browser tests are named `src/**/*.browser.test.{ts,tsx}` and run in the `browser` vitest project on Playwright Chromium. Use one when the code under test needs real browser behavior that happy-dom cannot show.
- Vitest browser 4.1.10 does not encode `iframeId` in its test URL. A worktree path with `+personal/+ai` then waits forever for a different ID. In an outside test config, transform only that query value to `encodeURIComponent(iframeId)`. Check the actual served orchestrator code and a real passing browser test. Keep the app, storage, dependency files and timeouts unchanged.
- The `src` and `browser` projects run the React Compiler with the same settings as `vite.config.ts`, so they run the same compiled code as the app. Keep the three configs in sync. A compiled component keeps its output when its props do not change, so `rerender` with the same props does not reach a child. When a mocked hook must change its value, let it subscribe with `useSyncExternalStore` and notify it inside `act`, like the thread query mock in `ai-chat-controller.browser.test.tsx`. The snapshot value has to be part of the value the component reads. An unused counter lets the compiler keep the old return.
- `src/lib/my-focus.browser.test.ts` is the plain DOM example. `src/hooks/ai-chat-controller.browser.test.tsx` is the integration example. It runs the real AI SDK `Chat` against a fake `fetch` that serves an SSE UI-message stream, and mocks only Convex, auth, and tenant context. It follows the layout of its module-owning sibling `src/hooks/ai-chat-controller.test.tsx`, not the other browser test: helpers above the `describe`, camelCase helper names, and lowercase behavior-first test names.

## Review

- Test through public or registered entrypoints unless production design already exposes a natural helper.
- Make mocks return the values that the real caller uses. If a submit result controls draft cleanup, assert that result or use the real composer. A mock that records only calls can pass while the real editor loses text or images.
- Direct file fixtures must use `files_content_heads_db_wrap` when creating saved files or changing content, repair markers, or sequence counters. This keeps the selected content head in sync, just like registered mutations. See `server/bash.setup.test.ts` and `convex/files_nodes.content_yjs_updates.test.ts`.
- Background Move tests use `test_finish_transfer_run` or `test_finish_pending_update_run` from `convex/setup.test.ts`. They run the real cohort and wake pages. They move the fake clock to a deferred overlay job's due time without firing unrelated jobs or expiry timers. Rename still returns its queued intake IDs after the helper finishes it.
- Use `test_seed_folder_chain` for repeated `a` folders in pages of 200. Use `test_folder_chain_path` for absolute paths. `test_db_hold_move_source` holds one saved subtree with a null user and generation 1. Keep different transaction, path, depth, or reservation setups inline.
- The Transfer helper reads fresh state after every `onStep` callback. Both helpers read their state together and skip extra scheduling advances while their own cohort runs. They finish that cohort before a scope repair waiting on it. Stop and atomic Review retries still advance. Only the release phase can complete a cohort, so the helpers check completion there.
- Track item and unit progress too. Empty Copy pages and Review dependency pages can advance without changing the run's counts. Scheduled budget tests use the next timer; reading all old job records on every step makes a long test slow.
- `convex/convex_test_indexes.test.ts` checks the vendored test fork through native queries. Its field read counters prove that `first()` stops at the first match and later pages seek past earlier docs. Keep cursor order, pending writes, rollback, component isolation and transaction metrics in those checks.
- These helpers do not finish another queued Move, Archive or Restore. For a halfway Restore clash, create the new occupant through the normal Create or Upload door. A Move into that folder must wait for Restore.
- Keep test comments precise when domain vocabulary overlaps. For example, use `chunk metadata` when the test is about chunk offsets, not frontmatter metadata.
- Do not add defensive test guards for required schema fields. Load the required value directly and let TypeScript/schema-backed fixtures keep the invariant obvious.
- When a storage refactor removes duplicated fields, prefer behavior tests through the public query/mutation plus the smallest direct fixture seed that exercises the missing edge case.
- Run the narrowest focused test command that covers the touched behavior.
