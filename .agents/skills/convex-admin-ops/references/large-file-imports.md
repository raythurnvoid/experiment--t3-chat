# Large file imports and recovery

Use this guide for operator imports with many files, binary reuse, or cleanup of an older import. Ordinary sidebar uploads use the Files tree skill. Keep run-specific IDs, source data, credentials, scripts, and logs in the personal task folder from AGENTS.md.

## Prepare the data and proof

- Freeze one manifest with source IDs, final paths, content types, byte sizes, hashes, and expected Properties. Keep the original export and baseline unchanged. Use IDs to distinguish records with similar names.
- Preserve all business fields, message roles, recipients for each send, timestamps, and source HTML. Keep missing attachment or recording records with a clear missing-asset note. An inline image URL does not prove the export contains image bytes.
- Check the current write and text-size limits before packing data. Split large records into linked parts and prove they rebuild the source exactly. Check every generated link. Do this before a full upload; do not keep repacking an already verified import.
- For exact Markdown, create with `nonCollaborative: true`. The flag does not convert an existing collaborative file. Check BOM/newline normalization before comparing bytes. Read the [editable text skill](../../files-editable-text/SKILL.md).
- Text frontmatter and binary Properties are separate indexing paths. Give binary files useful Properties and verify their values through the metadata read door. Do not add a second Properties pass to every Markdown page when its frontmatter already supplies the required fields.
- Estimate both storage use and cumulative upload-byte quota. Reusing a binary needs source identity and byte proof, then a native move of its existing node and asset IDs.

## Interrupted writes and rate limits

| Symptom | Correct next step |
| --- | --- |
| Socket closes, HTTP 500, or `storage_failure` after `write-many` | Stop launching batches, let all in-flight calls settle, then compare attempted paths with receipts. Read each uncertain path before retrying. |
| Successful response was lost | Accept the result only after exact path, node, shape, and byte readback. A transport error does not prove no write occurred. |
| Binary PUT times out or returns 412 | Read the exact accepted object. Reuse its saved upload target when safe; do not mint another target blindly. |
| R2 object exists but asset is not ready | Check the finalizer and its queue. Use a bounded wait for the exact asset, then inspect the failure. |
| HTTP 429 | Respect the route's rate limits and backoff. More parallel batches can make throughput worse. |
| Lock remains after a process ends | Confirm the exact owning process is dead and inspect its journal before removing that one stale lock. |

Record requested paths and flush the attempt journal before HTTP. Save receipts only for verified results. Keep one owner for each writer; a released HTTP lock does not mean all requests have settled. An uncertain response must never trigger a blind `overwrite: "replace"` retry.

Measure a small pilot with complete HTTP durations and readbacks before changing concurrency. Six batches beat eight in one large import, but that is an observation, not a universal limit. Keep upload-target creation within its own quota and rate rules. API-key last-used timestamp writes are throttled in the app; do not remove authentication or accounting to reduce contention.

## Verify the right representation

- Inspect `truncated` and per-file errors from `read-many`. Current limits are in the public API skill. Use full downloads when that door cannot return all bytes.
- Compare stored MIME with the app's canonical mapping. `text/plain` and `text/markdown` gain `;charset=utf-8`. Do not strip every MIME parameter or exempt a failing file. A plain-text upload can still follow the binary upload contract when processing was skipped.
- Text content snapshot assets do not supply the upload ETag used for binary checks. Do not infer a fresh text hash from asset size or a missing checksum field.
- State the exact strength of a check: full remote SHA-256, source hash plus upload MD5/remote ETag, database asset continuity, and metadata readback prove different things. A few full downloads do not prove that every binary was downloaded again.
- A Markdown parser failure can come from shared parser state or unsupported inline HTML. Check per-editor `Marked` ownership and the existing underline/highlight renderers before changing source content. Keep source fields intact and reconcile only affected paths after the fix.

## Large read-only audits

Whole-table `.collect()` diagnostics and terminal-truncated JSON are not complete large-workspace proofs. Use bounded pages and require the final cursor. Return only the data needed for the checks.

Pages that fetch each node's asset and versions can hit `SystemTimeoutError` even below document, return-size, and index limits. A fast first-page sample does not prove that the same page size will finish a full scan. Start conservatively and log progress during the scan.

For a confirmed read-only timeout, a reviewed retry can use the same cursor with a smaller page. It must append no rows from the failed request. Limit retries and stop on other errors. Do not apply this retry rule to mutations. Cursor-size changes need proof for the exact query.

For long audits, save a completed-scan marker after all row writes have finished. Include the query/source hash, exact inputs and hashes, row count/hash, and first/last server timestamps. Never label a partial pass complete. Two matching full scans show continuity across an interval; they are not one atomic database snapshot.

Reuse a completed scan only when its exact source, rows, complete marker, and full input set are pinned and validated. A fresh complete comparison scan is still required. If historic page times were not saved, report them as unavailable. Do not invent timestamps or promote an offline check to a live audit.

Some continuity proofs depend on version retention. In this app, a proof based on an imported file still being under one day old expires: version cleanup may later hide an intervening change. Record that deadline in the handoff and use server time for the age check. If it expires, obtain fresh full-byte readbacks and current asset/version pins through a reviewed audit change. Do not raise the age limit, remove the check, overwrite receipts, or treat the old offline result as success.

## Replace old content safely

1. Complete the new import and its byte/asset/metadata checks first. Record the exact baseline IDs eligible for archive. Keep user edits, notes, comments, pending work, and changed Properties.
2. Move verified reused binaries through the normal member doors. Preserve node and asset IDs. Set new Properties only after the move has a durable completion receipt.
3. Stop import and metadata writers before the final audit. Keep a successful report and its input/path/identity pins.
4. Archive only the reviewed IDs in small batches. Read all users' pending work, comments, stored write stages, content jobs, active children, Properties, and ancestors before each batch. A capped guard read must stop; it is not an empty result.
5. Measure a short freshness budget using local elapsed time from before the read through imports/auth and just before the mutation. Server and Windows clocks differ. Use server timestamps only for comparisons between server-produced dates.
6. Flush the prepared journal before calling the native archive door. Read back the exact archive operation membership and content state. A new child swept into a folder archive is a conflict.
7. Archive empty folders deepest first. If replacing the root overview, archive it alone, last, then create its replacement immediately with `overwrite: "fail"`. Verify full bytes, new IDs, receipts, and required Properties before the final audit.

A mocked check that asserts an index name only proves that the code and the test agree. It cannot prove the index exists, because in-memory mocks never resolve a name against the real schema. A wrong name passes every mock and then throws on the first live call. That hurts most right after the old root is archived, because the path is already empty at that moment. Before the step that depends on it, check every index name a runner uses against `packages/app/convex/schema.ts`, or run the runner once in a read-only mode against the real deployment.

Never undo a folder archive with a blind `unarchive_nodes` call. That door restores all archived descendants, including earlier operations, and can move a file to root when its parent is archived. Only a reviewed exact-leaf recovery with a free path, active parent, and matching operation is narrow enough for automatic restore.

A native exception with unknown send status stays unresolved until readback. Do not call it `not-sent` merely because the first read looks unchanged. A pre-RPC guard refusal can be proved not sent; a timeout after RPC cannot. Do not remove journals or checks to make a retry run.

## Billing and upload finalization

R2 finalization, text indexing, and Polar billing are separate queues. A ready upload and a durable file-save billing job do not mean Polar has ingested the event. Confirm the billing environment; never infer sandbox from a development app URL alone.

For a healthy sandbox backlog, verify scoped event IDs, payer, amount, duplicates, retries, and recent worker progress. The queue contains current jobs, not the full historical billing ledger; an event absent from it may already have completed. Report pending accounting separately from file readiness. A full queue drain is not an import gate unless the task requires provider settlement. Failed or canceled work needs investigation. Do not alter billing rates, skip billing, or drain unrelated jobs as an import shortcut.

## App checks and session handoff

Use the app agent to find source-backed answers across email, workspace messages, meetings, attachments, and a no-match case. Check tool evidence and every claimed source detail. A first answer can omit a later reply; compare against the full source record. Verify native Files citation paths and actual metadata search separately.

For UI slowness, distinguish the first paginated tree load from row rendering. Use the [performance skill](../../perf-profiling/SKILL.md), [Files tree skill](../../files-explorer-tree/SKILL.md), and [browser hazards](../../app-playwriter-harness/references/known-hazards.md). Do not restart a shared server or browser to recover one owned tab. PDF/video File details can be correct when no matching viewer plugin is installed; do not report playback as tested.

At a requested stop, leave one short handoff with completed counts, exact next commands, frozen script hashes, successful versus incomplete reports, pending journal/lock state, owned processes/tabs, credential status, time-sensitive proof limits, and known UI limits. Preserve existing approval and the exact cleanup scope. Do not relaunch completed work. Keep a temporary credential private and record whether the remaining step still needs it; revoke that exact key after completion. Do not log its token or revoke another task's key.

On resume, read back that key's exact metadata and revoked state before reuse. Do not silently replace a revoked key. Rediscover the browser/session and rebind an owned page; old session numbers are not an identity check. Verify the origin, deployment, account, and membership again. Load the reviewed runner by its hash when a persistent session may still cache an older module.
