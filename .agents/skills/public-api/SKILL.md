---
name: public-api
description: Spec for the public HTTP API under `/api/v1` — routes, auth principals, scopes, rate buckets, batch semantics, file write/upload pipelines, plugin-data routes, service upload routes, and their limits. Use when changing `packages/app/convex/public_api.ts`, `packages/app/convex/public_api_http_routes.ts`, `packages/app/convex/plugins_data_http.ts` or its routes module, `packages/app/convex/public_api_service_uploads.ts` or its http/routes modules, `packages/app/shared/api-schemas.ts` route entries, API-key scopes, public-API rate buckets or quotas, or the api-keys route UI.
---

# Mental model

The public API is the workspace file surface for external callers: import CLIs, scripts, and plugins. Every route is a Convex HTTP action with a typed entry in `api_schemas_Main` (`packages/app/shared/api-schemas.ts`). A route without a schema entry does not exist.

The HTTP wrappers are split by startup cost. `/api/v1/files/list` lives in `packages/app/convex/public_api_files_list_http.ts` and stays in the small static root graph because it is the hot plugin read path. The other route definitions live in the small `packages/app/convex/public_api_http_routes.ts` module, and the plugin-data routes in `packages/app/convex/plugins_data_http_routes.ts`. Each route loads its heavy implementation (`public_api.ts` or `plugins_data_http.ts`) with a literal dynamic import only when that route runs. Shared Bearer-token authorization lives in `packages/app/convex/public_api_http_auth.ts`. Public scopes and the plugin token formats that principal resolution and HTTP authorization must agree on live in `packages/app/shared/public-api.ts`; one-consumer credential and grant details stay private to their owning Convex module.

Plugin UI documents and `/api/v1/*` share the Convex HTTP origin. Their iframe keeps that origin through `sandbox="allow-scripts allow-same-origin allow-forms"`, so the browser sends the existing JSON plus `Authorization` request directly without a CORS preflight. Do not add a `text/plain` token envelope or route calls through the host app. External browser callers on another origin still use normal CORS behavior.

A caller is never more powerful than the user behind it. `public_api_http_auth.ts` maps every `files:*` and `plugin_data:*` scope to its required app permission (`content.read` or `content.write`). Routes pass only their scope, so they cannot forget the app-permission check. On the file routes a plugin run is exempt and uses scopes only. The plugin-data store is not exempt: `db_authorize` in `plugins_data.ts` asks for the actor user's `content.read`/`content.write` on every principal kind, plugin runs included, inside the same transaction as the read or write. The write mutations re-check credential liveness, membership, and ACL transactionally at publish time (`db_revalidate_file_write_principal`).

# Principals and scopes

`public_api_authorize_request(ctx, request, { requiredScope, allowedKinds, route })` resolves the Bearer token into one principal kind:

Public API scopes and app permissions are separate concepts and use separate values. API scopes use colon names such as `files:read`; app permissions use dot names such as `content.read`. Several file scopes can map to the same app permission, so do not make their values identical or pass the permission from each route.

- `user_api_key` (`pk_<keyId>.<secret>`): user-bound key minted on the api-keys route. Only signed-in Clerk users can mint one. UI-mintable scopes: `files:list`, `files:read`, `files:write`, `files:download`, `plugin_data:read`, `plugin_data:write`.
- `public_api_grant` (64-hex, short-lived): list/read only — the grant validator accepts only `files:list` and `files:read`. Organization removal deletes the member's grants so a later invite cannot revive an old token.
- `plugin_run` (`plr_...`) and `plugin_ui` (`plu_...`): plugin runtime tokens with their own constraints (a backend plugin run can only write Markdown siblings of its triggering file, and can only download its own source upload). Organization removal also deletes that member's plugin UI sessions.
- `plugin_service` (`psg_...`, stored hashed in `plugin_service_grants`): a grant for an external service that acts for one installation. An outside server gets one by presenting a member's plugin-page token to `/api/internal/plugins/service-grants/exchange` together with the deployment's exchange secret, and keeps it alive through the sibling `renew` route; both live in `packages/app/convex/plugins_service.ts` (see `../plugin-system/SKILL.md#service-grant-exchange`). It is bound to the installation rather than to a user session, so a worker can finish work the member started. Its `principalKey` is stable across token rotation, which is what makes it a durable producer identity for versioned documents and reservations. Grants come in two phases. An `interactive` grant is what the exchange mints: one working day, renewable, `plugin_data:*` scopes only. A `processing` grant comes only from `/api/internal/plugins/service-grants/seal-processing`, which trades a live interactive grant for a new grant sealed to one exact destination path prefix, carrying `plugin_data:read`, `plugin_data:write`, and `files:write`, expiring six days after the seal; renewal rotates its token but never moves that deadline, and a processing grant cannot seal again. Both phases still need the actor's live membership and permissions on every call today. Every call also rechecks that the installation is enabled and still accepts the matching capabilities, so uninstalling or removing a capability revokes it. `resolve_principal` narrows scopes by the installation's live capabilities and drops `files:write` whenever `destinationPathPrefix` is null.

Scope names: `files:list`, `files:read`, `files:write`, `files:download`, `secrets:read`, `outbound:fetch`, `activities:write`, `plugin_data:read`, `plugin_data:write`. Six are UI-mintable on the api-keys route: the four `files:*` plus `plugin_data:read` and `plugin_data:write`. The rest belong to plugin tokens only.

Routes restrict kinds with `allowedKinds`; a valid token of a disallowed kind gets 403. `write-many` and `upload-urls` are `user_api_key` only. `write` and `touch` also allow `plugin_run`. `download-urls` allows the plugin kinds too. The generic file routes stay closed to `plugin_service` on purpose: a service grant's only file surface is the `/api/v1/files/service-uploads/*` pipeline below. A `plugin_ui` token may read and list plugin documents but never write them — a page that needs to write goes through its own backend or a service grant. Three separate things enforce that, and they are not redundant: `resolve_principal`'s `returns` validator makes `plugin_data:write` unrepresentable for a page token, every write route leaves `plugin_ui` out of `allowedKinds`, and `refuse_page_principal` refuses the kind inside the mutation itself. The in-transaction one is what a caller reaching the mutation directly, or one wrong edit to an `allowedKinds` list, still runs into. A page session can belong to an anonymous identity and is the first thing a scripting bug in a plugin reaches, so a write door there would turn one such bug into stored data that plugin backends later act on with their own secrets.

# Routes

All routes are POST and return JSON. Batch caps are tied to rate-bucket capacities — do not raise one without the other.

| Route                         | Scope              | Notes                                                                                                                                                                                      |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/v1/files/list`          | `files:list`       | File items carry `status` (`pending` until the R2 object is confirmed, then `ready`; `null` for folders) and `size`                                                                        |
| `/api/v1/files/read`          | `files:read`       | Serves every editable text class (Markdown and plain text); user API keys read committed content only, `public_api_grant` reads (and `read-many`) include the grant user's pending overlay |
| `/api/v1/files/read-many`     | `files:read`       | Up to 50 paths, per-item errors                                                                                                                                                            |
| `/api/v1/files/write`         | `files:write`      | One Markdown file; `overwrite: "replace" \| "fail"`, `skipIfUnchanged`                                                                                                                     |
| `/api/v1/files/write-many`    | `files:write`      | Up to 20 files, 8 MB request cap, batch semantics below                                                                                                                                    |
| `/api/v1/files/touch`         | `files:write`      | Up to 8 paths                                                                                                                                                                              |
| `/api/v1/files/download-urls` | `files:download`   | Up to 20 node ids, presigned GET urls, TTL <= 15 min                                                                                                                                       |
| `/api/v1/files/upload-urls`   | `files:write`      | Up to 20 files, presigned PUT urls, upload pipeline below                                                                                                                                  |
| `/api/v1/activities/start`    | `activities:write` | Plugin-facing activity feed entry; its durable mutation rechecks the live installation/version, active actor membership, and unarchived source file                                        |
| `/api/v1/auth/verify`         | none               | `user_api_key` only, empty body; answers the key's tenant and the scopes it can still use today                                                                                            |

`/api/v1/auth/verify` is the one route with no required scope, so it uses `public_api_authorize_key_inspection` instead of `public_api_authorize_request`. Keep them separate: making `requiredScope` nullable would let an ordinary route forget its app-permission check. The helper filters the key's stored scopes through the same scope-to-permission map against the caller's live `contentPermissions`, so a key whose owner lost `content.write` reports only its read scopes. An empty list is a valid answer, not an error.

## Plugin document store routes

The nine `/api/v1/plugin-data/*` routes are registered in `plugins_data_http_routes.ts` and implemented in `plugins_data_http.ts`. The store itself and its limits are documented in `../plugin-system/SKILL.md`.

| Route                                     | Scope               | Kinds                                                       |
| ----------------------------------------- | ------------------- | ----------------------------------------------------------- |
| `/api/v1/plugin-data/read`                | `plugin_data:read`  | `user_api_key`, `plugin_run`, `plugin_ui`, `plugin_service` |
| `/api/v1/plugin-data/list`                | `plugin_data:read`  | same as read                                                |
| `/api/v1/plugin-data/write`               | `plugin_data:write` | `user_api_key`, `plugin_run`, `plugin_service`              |
| `/api/v1/plugin-data/write-batch`         | `plugin_data:write` | same as write; up to 50 documents                           |
| `/api/v1/plugin-data/delete`              | `plugin_data:write` | same as write                                               |
| `/api/v1/plugin-data/write-versioned`     | `plugin_data:write` | `plugin_service` only                                       |
| `/api/v1/plugin-data/delete-versioned`    | `plugin_data:write` | `plugin_service` only                                       |
| `/api/v1/plugin-data/reserve`             | `plugin_data:write` | `plugin_service` only                                       |
| `/api/v1/plugin-data/release-reservation` | `plugin_data:write` | `plugin_service` only                                       |

A plugin token derives its installation from the token itself. A `user_api_key` has no installation of its own, so its request body names one; the store normalizes that id and answers `Not found` for anything outside the key's tenant. The id arrives as a plain string on purpose — a `v.id` argument validator throws on a malformed value, which at an HTTP boundary is a 500 instead of a refusal.

All nine bodies therefore accept the same optional `installationId`, including the four service-only ones. A user key that omits it gets 400 `installationId is required for an API key`, and any plugin token that sends it gets 400 `installationId is not allowed for this token`. The four service-only bodies need the field for the refusal alone: leaving it out of those validators would make Zod strip it before `to_store_principal` ever sees it, so a service naming another installation would be answered as if it had named nothing.

Every request body is strict, so unknown fields return 400. The raw JSON body limit is 64 KiB for every route except `write-batch`, which allows 4 MiB for up to 50 documents. The limit includes property names, JSON escapes, and whitespace. Crossing it returns 400 `Request body is too large`. The larger batch limit is transport headroom only; every canonical document value still has the 16 KiB store limit.

`value` on the three routes that carry one is checked for every shape Convex cannot store: a field name that starts with `$`, holds a non-printable-ASCII character, or is longer than 1024 characters; an object with more than 1024 fields; an array with more than 8192 items; and a value nested deeper than 15 levels (the document holds the value one level inside itself, and Convex's own ceiling is 16). Convex applies the name rules while serializing the mutation arguments and the other three while validating the document, and every one of them **throws** rather than returning a refusal, so without the check at the HTTP boundary a caller's bad value is a 500 with no message instead of a 400. The check walks nested objects and arrays, because the rules apply at every depth, and the depth limit is what bounds the walk.

Every string in a request body is also checked for an unpaired Unicode surrogate, which `JSON.parse` accepts and Convex refuses. Write the check as "does this code unit complete the pair", never as "is it outside the low-surrogate range": past the last character `charCodeAt` answers `NaN`, every comparison against `NaN` is false, and the second form therefore calls a string ending in a high surrogate well formed.

A refused body answers 400 `Request body validation failed` and does **not** say which field was wrong. That is one message for a bad collection name, an unknown extra field, a malformed string, and an unstorable value alike, so a caller debugging a 400 has to bisect its own body. Callers relying on the message to locate the problem should not.

Store refusals map to status by the name the store tagged, so rewording a refusal cannot change its status: 409 for the whole conflict family (another writer, a live reservation, a replayed idempotency key with different fields, a replay of an already-released reservation, a deleted key, a revision out of order, a revision replayed with a different value) and 403 for the two storage-ceiling messages. Only three untagged refusals map by message — 401 `Unauthenticated`, 403 `Permission denied`, 404 `Not found` — and everything else is 400. The ceilings answer 403 rather than 507 to match `/api/v1/files/upload-urls`, which already answers a full quota with 403.

`files/list` applies `contentTypePrefixes` inside one Convex query before pagination. `limit` counts matching docs. `scanLimit` controls how many source docs the filtered query may inspect; the public route defaults it to 10,000, and the internal query caps it at 10,000 source docs. The query does not set `maximumBytesRead`. A sparse filtered page can still be short or empty while `isDone` is false, so callers must continue with the returned cursor. Direct internal callers such as AI file tools omit `scanLimit` and keep the 1,000-doc default. The prefix predicate uses lexicographic string ranges because Convex filters do not provide `startsWith`.

## Service upload routes

The seven `/api/v1/files/service-uploads/*` routes are registered in `public_api_service_uploads_http_routes.ts`, implemented in `public_api_service_uploads_http.ts`, with the storage mutations in `public_api_service_uploads.ts`. All are POST, scope `files:write`, `allowedKinds: ["plugin_service"]`, and the route refuses any grant whose phase is not `processing`. The mutations re-check the grant doc, installation state, capabilities (`plugin.service.connect` + `workspace.files.write`), actor liveness/membership, and workspace `content.write` inside the transaction.

| Route                                               | Body                                                     | Answer                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/files/service-uploads/reserve`             | `{ idempotencyKey, reservedBytes, expiresAt }`           | `{ reservationId, remainingBytes, expiresAt }`                                                                                |
| `/api/v1/files/service-uploads/create-target`       | `{ idempotencyKey, targetKey, path, contentType, size }` | pending `{ state, path, nodeId, uploadUrl, headers, uploadUrlExpiresAt }` or committed `{ state, path, nodeId, actualBytes }` |
| `/api/v1/files/service-uploads/remint`              | `{ idempotencyKey, targetKey }`                          | same union: fresh URL for the same staging key, or committed                                                                  |
| `/api/v1/files/service-uploads/finalize`            | `{ idempotencyKey, targetKey }`                          | `{ state: "pending" \| "committed" \| "released", path, nodeId, actualBytes \| null }`                                        |
| `/api/v1/files/service-uploads/release`             | `{ idempotencyKey }`                                     | `{ releasedBytes }` (frozen replay answer)                                                                                    |
| `/api/v1/files/service-uploads/delete`              | `{ idempotencyKey, targetKey }`                          | `{ state: "deleting" \| "deleted", paths }`                                                                                   |
| `/api/v1/files/service-uploads/archive-destination` | `{}`                                                     | `{ archivedNodes }`                                                                                                           |

Semantics that must not drift:

- `idempotencyKey` names one reservation (the meeting); `targetKey` names one file inside it. Replays with the same fingerprint answer the same thing; the same key with different fields is 409. A released reservation or target answers 409 on reserve/create/remint, and `release` replays its frozen `releasedBytes`.
- Reserve charges the whole envelope (≤ 532 MiB) against the `plugin_service_storage_bytes` quota up front; each target's declared `size` spends from the envelope's `remainingBytes`, never from the quota directly. At most 16 targets per reservation.
- Every target `path` must be canonical (same rules as `upload-urls`) and strictly inside the grant's `destinationPathPrefix` — the prefix itself, a string-prefix sibling, or anything outside answers 403 `Path is outside this grant's destination`. A path collision with an existing file is 409; the service path never overwrites.
- Targets reuse the standard staging→canonical R2 pipeline (`upload-staging/<assetId>` then `assets/<assetId>`). An editable-text file name runs the same upload conversion as a member upload (the asset's `processingWorkId` is left unset), so a service-uploaded `.md` or `.json` becomes a normal editable document; any other name is inserted with `processingWorkId: null` and stays a stored blob. Plugin upload events never fire for a service upload either way: `plugins_runtime_db_enqueue_upload_completed_runs` refuses any asset a `plugin_service_storage_targets` row owns (the `by_asset` index), which also covers an editable-text conversion that falls back to a stored blob.
- Finalize settles a canonicalized target: the declared bytes go back to the envelope and the confirmed actual bytes stay charged through the committed target doc (`plugin_service_storage_targets`). If the real object is larger than declared, the excess comes out of the envelope and any residual is charged straight to the quota (over its ceiling if needed) with a warning. If the unfinalized-asset cleanup already deleted the asset doc, finalize releases the target and refunds its declared bytes — retry under a new `targetKey`.
- A new target stores the sealed destination path and stable folder node id. Archive resolves the target by its original path and then follows the node id, so renaming the meeting folder does not make deletion report a false success. Existing dev targets keep those fields optional only for the backfill rollout; archive refuses a moved legacy destination instead of deleting the meeting record. The subtree walk reads at most 256 folder/file docs, including already archived descendants.
- `release` settles canonicalized pending targets to committed, deletes the other pending placeholders (node + asset doc, with R2 deletion jobs enqueued first for the exact staging and canonical keys), and refunds `remainingBytes` plus the deleted targets' declared bytes to the quota. It keeps each released target doc because that doc carries the stable destination folder id used by the following archive step. A read-only pending placeholder refuses the whole release with 409; the expiry cron waits a week before checking it again. Named workspace deletion keeps its lifecycle bypass. Committed files survive release, still charged.
- `delete` removes the committed files one `targetKey` stored. No caller uses it since the Council workflow moved to `archive-destination`; it stays as the per-file door for a service that really wants one file gone. The original reservation may be released and even cron-deleted by then, so the lookup goes by installation + target key (`by_organization_workspace_installation_targetKey`), fenced to targets whose stored path is inside the presenting grant's `destinationPathPrefix` — a grant sealed elsewhere answers 404, not 403, so it cannot learn the key exists. Every committed match inside the fence is deleted (a reprocessed meeting can store two files under one key; refusing would wedge the workflow). The route enqueues the R2 deletion jobs and hard-deletes the node/asset docs, marks the target with `deleteRequestedAt`, and answers `"deleting"`; it never refunds. A pending match answers 409 (release owns those); replays keep answering, `"deleted"` once every match is settled.
- `archive-destination` is how a service cleans up after itself, and it is what the Council delete-meeting workflow calls. It takes no body fields: the door archives the active node at the grant's own `destinationPathPrefix` together with every active descendant, in one `archiveOperationId`, so a member can restore the exact set. Deleting a file from the UI archives it in this product, and a stored service file is a real file, so the service archives too — the bytes stay charged, and no R2 object is deleted. The seal is the whole fence (no caller-chosen path), and `workspace.files.write` scoped to that seal is what makes archiving inside it allowed. Inside the fence the door asks what `archive_nodes` asks a member, because a member can nest their own content there: the destination node itself is checked with `content.write` (a restricted folder subtracts from workspace permission, so the seal alone is not enough), a restricted subtree the actor cannot write answers 403, a read-only node answers 409, and either refuses the whole call rather than archiving part of a folder. A destination that does not exist, or one already archived, answers `{ archivedNodes: 0 }`, which is what makes a replayed delete safe. At most 256 nodes per call.
- Stored bytes are refunded only by physical deletion of the charged canonical object: the final-confirm branch of `settle_object_deletion_job` in `r2_client.ts` finds the committed target by asset id and refunds the workspace quota exactly once. It consumes the target doc — except a target marked `deleteRequestedAt`, which it patches to a `released` tombstone instead so the service's delete replays keep getting an answer.
- The hourly `cleanup expired service upload reservations` cron releases expired live reservations and deletes released docs past their 24-hour retry horizon. Uninstall and workspace drains run `public_api_service_uploads_db_drain_batch` (called from `plugins_data_db_drain_batch`); an installation-scoped drain keeps committed targets because the uploaded files stay in the workspace.

# Rate buckets and quota

Buckets live in `packages/app/convex/rate_limiter.ts`:

- `public_api_auth` (60/min, cap 10): charged per client+route for malformed or unknown tokens, so probing stays cheap to refuse.
- `public_api_principal` (120/min, cap 20): charged once per authorized request. `download-urls` and `upload-urls` charge `count - 1` extra units so a batch of N costs the same as N single calls.
- `public_api_files_write_bulk` (600/min, cap 100): `write-many` only. One up-front charge of `count: files.length` before any write; an over-budget batch is a whole-request 429 with zero files staged.
- `public_api_plugin_data_write_bulk` (600/min, cap 100): `plugin-data/write-batch` only, charged the same way with `count: documents.length`.

`public_api_upload_bytes` quota (org+workspace scope, 50 GB of declared bytes): consumed by `upload-urls` mints in the same mutation that creates the nodes and assets. Monotonic — deleting files does not refund. Seeded lazily at the first mint; see the quotas skill for the exception this creates.

`plugin_service_storage_bytes` quota (org+workspace scope, 10 GiB): the service-upload envelope budget. Unlike `public_api_upload_bytes` it is NOT monotonic — release refunds the unspent envelope, and the confirmed physical deletion of a stored file's canonical object refunds its actual bytes. Also seeded lazily, at the first reservation.

# Markdown write pipeline

`/files/write` and `/files/write-many` stay Markdown-only by contract (a deliberate non-goal of the editable-text feature): they refuse non-`.md` paths. Reads serve every editable text class; plain-text files enter through `/upload-urls` or the app's agent tools.

`write_one_markdown_file` (module-private helper in `public_api.ts`) is the shared engine for `write` and `write-many`: decide create-vs-fill, stage (`prepare_file_write`), PUT the staged objects to R2, publish (`publish_file_write` / `publish_file_fill`), and sweep the stage on failure.

- Both routes normalize the incoming content at the request boundary, ABOVE the byte count: one leading BOM is dropped and CRLF/lone CR become LF (`files_normalize_text_document_input`). The document, the R2 content snapshot, the committed chunks, and the stored size all see the same normalized string.

- Writing over an existing **editable** Markdown file fills in place: the nodeId stays stable for open editors and links, and open Yjs sessions converge on the new content. Non-editable targets (stored uploads) archive-and-recreate.
- Paths must already be canonical: every name is checked with `files_normalize_name` and refused when the canonical form differs, unlike the app UI, which silently normalizes. One non-obvious corner: special names like `readme.md` canonicalize to uppercase `README.md`, so the lowercase spelling is refused (with the generic invalid-name message). Empty content is refused too — importers create empty placeholder files through `/api/v1/files/touch`.
- `overwrite: "fail"` returns 409 `A file already exists at this path`; a folder at the path is always 409.
- `skipIfUnchanged: true`: when projecting the incoming Markdown into the current doc is a semantic no-op (`fillUpdate === null`), the route returns 200 with `unchanged: true` before staging — no stage, no asset docs, no uploads, no new version snapshot. The skip first asks the same node-level write check the publish would ask; a caller the publish would refuse falls through to the normal write path and gets the same refusal, so the unchanged marker cannot confirm content to someone who cannot write the node. Only the fill path can be unchanged; comparison is Yjs-level, not byte-level, because materialized Markdown is not byte-stable. `null` never lies, but the reverse is not guaranteed: some semantically identical rewrites still publish.
- Failure vocabulary (per-item `errorCode` in `write-many`, plugin settle codes in `write`): `unauthenticated` (401), `permission_denied` (403), `conflict` (409), `storage_failure` (500).
- A read-only target or destination folder returns 409 `conflict` with `This item is read-only.` It does
  not return `permission_denied` because the caller may have permission but still be blocked by the
  lock. `prepare_file_write` checks the lock after auth and ACL. The publish mutation resolves the
  path again and checks current ACL and lock before its first write. A lock removed before publish
  does not refuse the write.
- A stage for an existing target keeps that target's node id. This prevents stale work from
  overwriting a different node. Refused staged keys go to `files_r2_object_deletion_jobs`. Plugin runs
  do not bypass locks. Their call settles with `conflict` and writes no output.
- Stage cleanup also uses `files_r2_object_deletion_jobs`. Plugin completion or tenant deletion may
  remove a stage while its action still has R2 PUTs in progress. Keep each stage job until
  `stage.expiresAt` plus five minutes. If the action later finds the stage missing, it advances the
  same jobs after its PUTs finish. It must not shorten the cleanup window.
- Frontmatter caps: 128 distinct fields (`files_metadata_MAX_FRONTMATTER_FIELDS`) and 512 index documents (`files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS`), both in `packages/app/shared/files-metadata.ts`. On the CREATE path the metadata insert helper's `Too many frontmatter fields` throw rolls the publish back, and the pipeline does not map that throw, so the API caller sees a generic error instead of a clean 400; the orphaned stage is swept by the hourly stage cleanup cron. On the FILL path the committed chunks refresh through materialization, which settles over-cap frontmatter with the `contentFrontmatterTooLarge*` marker pair instead of failing the request — the write returns 200 and the committed content stays at the last sequence that fit (see `../files-editable-text/SKILL.md`).

`write-many` batch semantics:

1. Auth first, then the 8 MB bounded body read (`read_request_text_bounded`).
2. Validate every item with the single-route rules before writing anything — one bad item is a whole-request 400 with the offending `path`. Duplicate normalized paths in one batch are a 400 too.
3. One up-front bulk-bucket charge, then sequential writes (concurrent publishes would conflict on shared ancestor folders).
4. Per-item outcomes: `{ written: [{ path, nodeId, contentType, unchanged? }], errors: [{ path, message, errorCode }] }`. A mid-batch `unauthenticated` aborts the whole request with 401; other failures are reported per item and the batch continues.

# Binary upload pipeline

For each file, `upload-urls` creates an active `files_nodes` doc, a `files_r2_assets` doc, and a signed
PUT URL. The URL writes to the temporary key
`organizations/<org>/workspaces/<ws>/upload-staging/<assetId>`. The R2 finalizer verifies that staging
event and copies the bytes once to the immutable live key under `assets/<assetId>`.

The whole batch validates before any write. It checks canonical paths, sizes, collisions, per-path
ACL including restricted ancestors, read-only locks on replacement files and destination ancestors,
and quota. One bad item returns 400, 403, or 409 with its `path`, and creates nothing. Each asset stores
`uploadUrlExpiresAt` and `uploadStagingR2Key`, like `create_upload_node`. Creating these docs accepts
the upload. A later lock does not cancel publication or processing. The finished node stays locked.

- `upload-urls` is the deliberate public CREATE path for plain-text editable documents: an upload whose name has a recognized editable text extension converts into an editable document on finalization. The extension classifier beats the client-declared MIME — a recognized text extension stores the classifier's media type and ignores the caller's declared one; anything else keeps the client value (media uploads need it for plugin routing).
- `skipProcessing: true` inserts assets with `processingWorkId: null`: the R2 event finalizer records the object (r2Key, real size, etag) but starts no text conversion and no plugin dispatch. Import tools want this; app-like uploads omit it.
- Until the R2 event arrives, the asset has no `r2Key` and `files/list` reports the file as `pending`. Events can arrive minutes late through Cloudflare queue retries.
- Every asset is born with `unfinalizedExpiresAt` (now + 24 h). The same patch that records `r2Key` clears it. The hourly `cleanup expired unfinalized assets` cron (`r2.ts`) deletes expired assets with zero references across `files_nodes`, `files_yjs_snapshots`, and `files_snapshots`; referenced non-upload assets are warned about and re-checked after 7 days. A referenced upload that never received its R2 event retries the staging-to-live copy hourly for 30 hours after the latest signed URL was issued, then weekly. Eight days after that latest URL, recovery stops: the placeholder file and asset are deleted and both possible R2 keys go to the durable deletion ledger. Reminting moves both recovery windows.
- Known residual: a presigned PUT url outlives key revocation for its TTL, and the finalizer records the real object size without a cap check (declared size is a mint-time check only).

# API-keys page quick-start

The workspace `API keys` page (`packages/app/src/routes/w/$organizationName/$workspaceName/api-keys/index.tsx`) explains the scopes and generates runnable samples:

- Scope descriptions: `files:read` is "Read the committed content of editable text files by path"; `files:write` is "Create and update Markdown files by path, and upload other files". The notes explain that reads cover Markdown plus recognized plain text, and that uploads with a recognized plain-text extension convert into editable documents.
- The page also mints the two plugin-data scopes: `plugin_data:read` ("Read the documents an installed plugin stores in this workspace.") and `plugin_data:write` ("Create, change, and delete those plugin documents."). Both start unchecked, unlike the two read scopes, because most keys never touch plugin data and a plugin's documents can hold whatever that plugin collected. `plugin_data:write` is a write scope alongside `files:write`, so checking it shows the same write warning through `aria-describedby`.
- A minted key has a `Test key` button that POSTs it to `/api/v1/auth/verify` and reports whether the key is live and which scopes it carries. It is the only place the page calls the API itself. It sends the key in the `Authorization` header with `credentials: "omit"`, never in a URL.
- The curl and Node samples select any editable text file through `contentTypePrefixes: ["text/", "application/json", "application/yaml"]` — there is no `.md` filter anymore, and the empty-workspace error is `No editable text files found`. `api-keys/index.test.tsx` pins these sample semantics.

# Tests

- Coverage lives in `packages/app/convex/public_api.test.ts` (route behavior, batch semantics, quota, rate buckets), `packages/app/convex/http.test.ts` (root route inventory), and `packages/app/convex/r2.test.ts` (finalizer, sweeper).
- The plugin-data routes, the service-grant mint and resolver, and `/api/v1/auth/verify` live in `packages/app/convex/plugins_data.test.ts`. The three service-grant exchange routes live in `packages/app/convex/plugins_service.test.ts`. The api-keys page's verify button is covered in `src/routes/w/$organizationName/$workspaceName/api-keys/index.test.tsx`.
- Focused command: `vp env exec pnpm --dir packages/app exec vitest run --project convex convex/public_api.test.ts`.

# Guardrails

- Keep `public_api_Scope` as the explicit scope union. Do not export one constant per scope. Check
  standalone scope literals and collections with `satisfies`, and keep the exhaustive
  scope-to-permission map checked with `satisfies Record<public_api_Scope, ...>`.
- Keep batch item caps <= their bucket capacities, and keep the caps named as constants next to the other `FILES_*` limits.
- Keep per-item error messages exact — importers match on them. Do not blur per-item errors to hide restricted-path existence; that leak is accepted and documented in the access-control skill.
- New routes need: schema entry in `api_schemas_Main`, a route definition in `public_api_http_routes.ts` (or the matching feature route module), `public_api_authorize_request` with an explicit `requiredScope`, a rate-bucket decision, a root route-inventory entry, and tests for scope refusal plus at least one batch/limit edge. Add every new scope to the exhaustive scope-to-app-permission map in `public_api_http_auth.ts`; use `null` only when no app permission applies. Keep a cheap implementation static only when its imports stay small. Otherwise, load the heavy implementation through one literal dynamic import inside the registered route.
- A route that a plugin call reaches must settle its `plugins_event_run_calls` row on every exit, including refusals. The plugin-data routes that a `plugin_run` may reach do this through one `settle(...)` helper so a new early return cannot leave a call hanging. The four service-only routes (versioned write/delete, reserve, release) never settle, because `allowedKinds` excludes `plugin_run` so their `pluginCallId` is always null. Adding `plugin_run` to one of those lists means adding its settle calls in the same change.
