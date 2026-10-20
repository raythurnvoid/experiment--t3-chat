# Plugin runtime contracts

These routes are for plugin callers listed in the [route index](references/route-index.md). A personal API key cannot replace a Frame, Run, Service grant, or registered service secret. Scope, accepted capabilities, current membership, installation/account binding, target access, and file policy all still apply.

## Sealed service grants

Lifecycle routes use `X-Bonobo-Service-Authorization: Bearer <registered secret>` plus `Authorization: Bearer <frame or service token>`. Send both only to the intended Bonobo Senate API origin.

| Suffix under `/api/v1/plugins/service-grants/` | Bearer | Body |
| --- | --- | --- |
| `exchange` | Frame | `{ requestId? }` |
| `renew` | Service grant | `{ requestId? }` |
| `seal-processing` | Interactive Service grant | `{ destinationPathPrefix, requestId? }` |
| `recover` | Original bearer of the operation | `{ operation: "exchange" | "renew" | "seal", requestId, destinationPathPrefix? }` |
| `verify-live` | Service grant | `{ installationId, phase, destinationPathPrefix, scopes }` |

Exchange returns a token, expiry, scopes, stable principal key, and installation/actor/tenant IDs. It grants one working day of interactive access with registered scopes except `files:write`. Seal trades it for a processing grant scoped strictly below one canonical destination prefix. Processing access ends six days after sealing; renewal rotates its token without moving that deadline. A processing grant cannot seal again. Verify-live checks the claimed phase, exact prefix, and scopes; it never widens them.

Save `requestId` before sending a lifecycle request. If its reply is lost, recover with that exact ID, operation, original bearer, and original seal destination. Recovery returns only the saved result while it remains current. The saved credential can be recovered for at most 24 hours. Do not start another exchange or rotation just because the first reply timed out.

## Plugin folders and conditional writers

Ordinary file operations are described in [Files](references/files.md). Plugin file writes also require the correct labels and accepted own-write/own-access capabilities. Inside a plugin's allowed roots it acts as the member; its own output folder has the installation account's writer rules. A label or selected writer does not grant file access. Manual sharing can detach external reader control.

Invoke Runs and registered sealed writers use these shared routes:

| Route | Body |
| --- | --- |
| `/api/v1/files/plugin-folders/ensure` | `{ path, access?, writer?: { resourceKey, rootNodeId } }` |
| `/api/v1/files/plugin-archive` | `{ path, writer?: { writerId, operationId, writerGeneration, sequence, nodeId, expectedContentRevision? } }` |
| `/api/v1/files/plugin-access/set` | `{ path, access, writer?: { writerId, operationId, writerGeneration, expectedReaderRevision } }` |

`access` accepts `readOnly?`, `readScopeId?`, and `readers?: [{ userId, membershipLifetime }]`. Use at most 50 different readers. A reader list and a store read scope cannot be combined. New folder access is applied at creation; retries never silently take over an existing folder or restore removed grants. A null writer root creates a new unused sealed root; a supplied root must match the saved writer. Save returned writer/folder IDs.

Registered writer mode needs the service secret too. Inspect before a conditional write:

| Route | Body |
| --- | --- |
| `/api/v1/files/plugin-writers/inspect` | `{ writerId, path, maxBytes }` |
| `/api/v1/files/plugin-writers/advance` | `{ writerId, operationId, writerGeneration, nextGeneration }` |
| `/api/v1/files/plugin-access/undo` | `{ writerId, operationId, writerGeneration, receiptId? , originalReaderOperationId? }` |

Inspect returns `nodeId`, bounded `content`, `contentType`, `contentRevision`, `expectedParentNodeId`, `writerGeneration`, `readerRevision`, and `detached`. A changed or too-large read refuses rather than returning partial editable text.

For `/api/v1/files/write`, supply normal text fields, required `expectedParentNodeId`, and `writer: { writerId, operationId, writerGeneration, sequence, expectedNodeId, expectedContentRevision, expectedReaderRevision, contentHash }`. `contentHash` is the SHA-256 hex of normalized content: drop one leading BOM and change CRLF or lone CR to LF before hashing. Preserve inspected revisions and exact target IDs. Writer mode derives create/replace from the expected target, and refuses conflicting overwrite or `skipIfUnchanged: true`. Normalization and create options are part of the replay proof; keep them unchanged on retry.

Save operation IDs before calls and save receipts after success. Exact retries return the committed receipt. A changed replay, old sequence, old generation, changed content, or changed reader revision can return 409. Advance moves exactly one generation. Archive pins one exact node, so a replacement at the same path is not archived by a stale call. Ordinary sealed archive without writer conditions archives one matching file; invoke archive may cover up to 256 nodes.

Undo takes exactly one of `receiptId` or `originalReaderOperationId`; its own operation ID must differ from the original. It reverses only the recorded reader change, not arbitrary sharing. Keep the original bearer until the external change finishes. Recorded proof can allow this narrow undo after bearer expiry, rotation, or actor access loss, while current installation/account/service/policy checks still apply. Lost responses can be canceled by original operation ID. A detached binding returns `restored: false` without a sharing change. Newer reader/writer state conflicts. Replace saved proof only after 401 `code: "reader_proof_mismatch"`, not after a network error or another refusal.

## Service uploads

All five `/api/v1/files/service-uploads/` routes need a sealed processing Service grant with `files:write`. They do not use a personal-key upload flow.

| Suffix | Body | Result |
| --- | --- | --- |
| `create-target` | `{ idempotencyKey, targetKey, path, contentType, size, readOnly, nonCollaborative }` | Pending PUT details or the committed result |
| `remint` | `{ idempotencyKey, targetKey }` | Fresh PUT details while pending, or committed result |
| `finalize` | `{ idempotencyKey, targetKey }` | Current pending/committed state |
| `delete` | `{ idempotencyKey, targetKey }` | Delete acknowledgement |
| `archive-destination` | `{}` | `{ archivedNodes }` |

Keep both keys stable. A changed create replay is 409. A path must be canonical and strictly below the sealed prefix. Both mode booleans are required; `nonCollaborative: true` is for editable text. Selecting `readOnly` needs the accepted creation capability and target management rights. New pending attempts require an upload plan and available storage. There are at most 16 targets per upload run and per destination/key group.

PUT the full file using the returned URL and required headers, without the API bearer. Remint starts a fresh attempt; it is not byte-range resume. Finalize is safe to poll through normal rate limits. A current lock does not cancel an already accepted upload. A moved-out target, released target, closed destination, or changed live access can still refuse the service. Never treat an old URL or a same-path replacement as the same target.

Delete cancels pending placeholders or archives committed output. Archive-destination archives up to 256 nodes in the bound destination. Both keep current access and policy checks. Neither refunds storage or billing. Save each result; a failed later item does not undo earlier accepted uploads.

## Identity and member access

`/api/v1/plugins/identity/exchange` takes `{ exchangeId, requestedExpiresAt }`, a Frame bearer, and the service secret. It returns `{ jwt }`: a short identity lease for this installation, audience, user, and membership lifetime. Its expiry is at most 30 seconds after validation, also bounded by the frame and requested expiry. It grants no Files or store access by itself.

The next routes use the service-secret header and that verified installation connection:

- `/api/v1/plugins/members/list`: `{ installationId, cursor: null, startRevision: null }` starts a snapshot. It returns up to 50 `members`, `startRevision`, `currentRevision`, and `continueCursor`. Preserve the returned start revision and follow its cursor until null.
- `/api/v1/plugins/access/changes`: `{ installationId, afterRevision, limit }`, with limit 1–100. It returns ordered `events`, `currentRevision`, `continueRevision`, and `isDone`. Continue from `continueRevision`.

Both require accepted service-connect and member-read capabilities. Stale history returns 410 and needs a new snapshot. Removed installations return terminal information. The external service must enforce lease expiry on its own live reads too.

## Volumes, invocation, and follow-ups

The five `/api/v1/volumes/` routes require a Run with `volumes:write`, accepted Mounts capability, and current installation management. Scheduled volume calls remain unsupported. Volumes are read-only agent source mounts, not ordinary workspace Files.

| Suffix | Body | Result |
| --- | --- | --- |
| `list` | `{ mountId? }` | Configured mounts, volume states, and usage |
| `stage` | `{ mountId, volumeKey, revision }` | New `stagingId` |
| `write-many` | `{ stagingId, files: [{ path, content }] }` | Written paths/bytes and per-item errors |
| `publish` | `{ stagingId }` | Published revision, counts, and time |
| `delete` | `{ mountId, volumeKey }` | `{ deleted: true }` |

Stage, write, then publish only after checking every item error. A batch has at most 100 files and 8,000,000 request bytes. Each text file is at most 900,000 UTF-8 bytes; empty files are allowed. Paths are exact and absolute within the volume, at most 1,024 characters and depth 32. A staged copy holds at most 5,000 files/30,000,000 bytes; an installation at most 20,000/200,000,000. The daily new-path cap is 10,000. Staging expires after 26 hours without a stage/write. Publish switches the visible copy only after success. Deleted volumes remain unavailable while cleanup runs. New mount paths have a separate write charge.

`/api/v1/plugin-backend/invoke` is Frame-only with `backend:invoke`: `{ endpoint, input?, serializationKey? }`. It synchronously returns the declared backend reply. A busy serialized endpoint gives 409 with `retryAfterMs`; a runner timeout can give 504. A backend can already have committed work before its reply is lost. Use the plugin's own retry contract; do not blindly replay a write.

`/api/v1/activities/start` is Run-only with `activities:write`: `{ title, timeoutMs }`. An empty title uses the host's default. It opts that run into the Activity feed. It is not a generic Activity status reader.

`/api/v1/plugin-runs/follow-up` is Scheduled-Run-only with `runs:follow_up`: `{ state }`, where state is valid JSON text of at most 16 KiB. Only successful completion queues it. One outgoing follow-up, at most 20 runs and 30 minutes per chain. 409 codes include `follow_up_already_requested` and `chain_limit`; an expired root deadline gives 401. Do not retry a refused chain under a new identity.
