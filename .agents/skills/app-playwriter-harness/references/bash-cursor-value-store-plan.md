# Bash Cursor Value Store

## Current behavior

Bash prints short `value_store` IDs in `Next page:` commands. There is no `@` prefix. Run the exact printed command; raw Convex cursors are not accepted as an alternative.

`packages/app/server/bash-utils.ts` owns cursor creation and resolution. Each new cursor explicitly gets a 24-hour lifetime. Reads do not renew it. Every resolution reads Convex so expiry and explicit removal apply across action runtimes. There is no separate cursor memory cache.

Missing, removed, malformed, and expired IDs use the existing Bash recovery error. Rerun the original command to get a fresh cursor. The underlying Convex query still checks access and cursor validity.

## Internal store

`packages/app/convex/value_store.ts` exposes internal functions only. Browser clients and plugins cannot call these functions directly.

| Function | Contract |
| --- | --- |
| `put({ value, ttl })` | Insert a string and return its generated ID. TTL is required, in milliseconds. `null` means no expiry; zero means immediately expired. Negative and non-finite durations are rejected. |
| `get({ id })` | Return `{ value, createdAt }` or null. Reject expiry at `expiresAt <= Date.now()`. Reading does not delete or renew the value. |
| `remove({ id })` | Delete one value and its expiry metadata in one transaction. Repeated removal is harmless. |
| `remove_all({ before? })` | Delete values created at or before a fixed cutoff, defaulting to now. Delete five per batch and schedule the remaining batches. Values in later batches remain readable until their batch runs. Newer values survive. |
| `cleanup_expired({ expiresAt? })` | Scan expiry metadata and delete expired values in batches of ten. Keep the first cutoff across scheduled batches. Return `{ deletedCount, done }` for each batch. |

`value_store` holds `value: string`, `expiresAt: number | null`, and `metadataId: Id | null`. All fields are required and top-level. A get reads only this doc, including its expiry.

Only expiring values have a companion `value_store_metadata` doc with `valueId` and the same `expiresAt`, indexed by `by_expiresAt`. Compute the deadline once, then insert both docs and link them in the same mutation. The payload is stored only in `value_store`. Permanent values have null expiry and null metadata ID. Reads trust the atomic writer and do not load metadata or compare the two copies.

Convex deletion reads the old value. Expiry cleanup scans small metadata docs first, so ten values fit per batch. Global removal scans full values first and deletes five per batch. These limits keep large strings within the transaction read limit. Removal deletes both linked docs in one transaction. Single-value removal checks existence first because deleting a missing doc would throw. The daily cron at 04:30 UTC starts expiry cleanup; scheduled batches remove the remaining expired values.

The store has no user or workspace ownership fields. Keep it internal. Do not expose it as a public key-value API without a separate scope and access contract. Custom keys and plugin-data changes are separate work.

## Verification

Run the focused store and Bash tests, then full app lint:

```powershell
vp env exec -- pnpm --dir packages/app exec vitest run --project convex convex/value_store.test.ts server/bash.test.ts
vp env exec -- pnpm --dir packages/app run lint
git diff --check
```

The store tests cover matching expiry copies and links, no expiry, zero TTL, invalid durations, expiry boundaries, repeated removal of both docs, fixed cutoffs, scheduled batches, and large values with transaction limits enabled. Bash tests cover the explicit 24-hour policy, continuation, removed IDs, and expiry recovery.

Use [the Bash evaluation recipe](bash-tool-agent-eval.md) for live checks:

1. Use the configured QA profile and a verified folder with enough files to paginate.
2. Run `ls --limit 1 <folder>` through the in-app agent, then exactly one printed continuation.
3. Check search and tree continuations, plus immediate-child ordering with `ls -t`.
4. Read `expiresAt` on the new cursor doc and its linked metadata doc. The copies must match exactly. The deadline should be 24 hours after creation, allowing the sub-millisecond difference between `_creationTime` and `Date.now()`.
5. Remove only an ID created for this QA run through `value_store.remove`. Replay its exact continuation in the same chat and check the recovery error.
6. Keep run evidence in the personal task folder. Do not clear unrelated cursor IDs for a test.

Keep prompts within the selected model's tool-call limit. If the chat says a call was not run because the tool budget was reached, send that exact command in a new message. It is not a Bash failure.

For table-wide readback, paginate each table in a separate inline query. Convex permits only one paginated query per function. Check `isDone` for each table before reporting complete counts.
