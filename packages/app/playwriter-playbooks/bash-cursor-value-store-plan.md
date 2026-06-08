# Bash Cursor Value Store Plan

## Summary

Replace long raw Convex pagination cursors in Bash `Next page:` commands with short aliases backed by a simple internal Convex `value_store` table. Bash should print `--cursor @<value_store_id>`, resolve that id back to the raw cursor before querying Convex, and keep raw old-style cursors working for historical outputs.

The goal is agent smoothness: reduce cursor copy failures without changing DB-backed pagination semantics, limits, search behavior, glob/regex behavior, or adding JavaScript filtering.

## Implementation

- Add `value_store: defineTable({ value: v.string() })` in `packages/app/convex/schema.ts`.
- Do not add custom indexes. Use Convex `_id` as the alias and built-in `_creationTime` plus built-in `by_creation_time` for TTL cleanup.
- Add `packages/app/convex/value_store.ts` with internal-only functions:
  - `put`: internal mutation that inserts `{ value }` and returns the row id.
  - `get`: internal query that accepts a string id, uses `ctx.db.normalizeId("value_store", id)`, and returns `{ value, createdAt } | null`.
  - `get` returns `null` for malformed, missing, or older-than-one-day ids.
  - `cleanup_expired`: internal mutation that deletes rows older than one day in a bounded batch using `by_creation_time`.
- Add a daily cron in `packages/app/convex/crons.ts` calling `internal.value_store.cleanup_expired`.
- Update `packages/app/convex/bash.ts`:
  - Add a bounded module-level in-memory `Map` from alias id to raw cursor.
  - For `--cursor @<id>`, resolve from the map first, then fall back to `internal.value_store.get`.
  - Treat the map as a best-effort optimization only; correctness must come from Convex.
  - When `search`, `ls`, `find`, or `tree` receives a `continueCursor`, store it with `internal.value_store.put`, cache it in memory, and print `--cursor @<id>`.
  - If alias resolution fails, return a normal Bash error that tells the agent to rerun the original command for a fresh cursor.
- Update guidance in `packages/app/server/server-ai-tools.ts`, `packages/app/convex/ai_chat.ts`, `.agents/skills/ai-chat-agent/SKILL.md`, and `packages/app/playwriter-playbooks/bash-tool-agent-eval.md` so the agent treats `@...` cursors as normal app Bash syntax and runs the exact printed `Next page:` command.

## Tests

- Run codegen after the schema/module changes:

```powershell
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app exec convex codegen
```

- Add focused tests for:
  - `value_store.put/get` stores and retrieves values.
  - malformed, missing, and expired ids return `null`.
  - `cleanup_expired` deletes old rows and keeps fresh rows.
  - `search`, `ls`, `find`, and `tree` print `--cursor @...` instead of raw cursors.
  - `--cursor @...` resolves to the original raw cursor before the existing Convex pagination query.
  - raw old-style cursors still work.
  - missing or expired aliases produce clear recovery guidance.
  - memory cache hit avoids the value-store query; cache miss falls back to the query.

- Run:

```powershell
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app exec vitest run --project convex convex/bash.ts convex/value_store.ts convex/ai_chat.ts server/server-ai-tools.test.ts
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app run lint
git diff --check
```

## Live Evaluation

- Deploy local Convex functions before browser evaluation:

```powershell
vp env exec --node 24.16.0 -- pnpm.CMD --dir packages/app exec convex dev --once --typecheck disable
```

- Use the lightweight Playwriter protocol from `packages/app/playwriter-playbooks/bash-tool-agent-eval.md`: bind to the existing app tab, start a fresh chat, send one prompt, capture evidence, and score manually.
- Run each targeted scenario 3 times:
  - `tree <fixture> --limit 3`, then exactly one printed continuation.
  - `search --limit 1 <broad-token>`, then exactly one printed continuation.
  - `find <fixture> -type f --limit 1`, then exactly one printed continuation.
  - `ls --limit 1 <fixture>`, then exactly one printed continuation.
- Always rerun canaries:
  - `ls -t <fixture>` remains immediate-child recency.
  - search cursor continuation works.
  - tree cursor continuation works.
- Record before/after metrics in `../t3-chat-+personal/+ai/bash-tool-smoothness-eval.md`.
- Accept only if cursor correctness improves and no canary regresses.

## Assumptions

- `value_store.value` is string-only for v1.
- TTL is one day for all value-store entries.
- The value store is internal-only and accessed only through `packages/app/convex/value_store.ts`.
- No Cloudflare KV, schema migration, pagination semantic change, glob/regex behavior change, or JavaScript-side filtering is included.
