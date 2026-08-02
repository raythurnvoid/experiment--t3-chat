---
name: public-api
description: Spec for the public HTTP API under `/api/v1` — routes, auth principals, scopes, rate buckets, batch semantics, file write/upload pipelines, and their limits. Use when changing `packages/app/convex/public_api.ts`, `packages/app/shared/api-schemas.ts` route entries, API-key scopes, public-API rate buckets or quotas, or the api-keys route UI.
---

# Mental model

The public API is the workspace file surface for external callers: import CLIs, scripts, and plugins. Every route is a Convex HTTP action registered in `packages/app/convex/public_api.ts` through the route-builder IIFE pattern, and every route has a typed entry in `api_schemas_Main` (`packages/app/shared/api-schemas.ts`). A route without a schema entry does not exist.

A caller is never more powerful than the user behind it. Every route passes `requiredUserPermission` to `authorize_request`, and the write mutations re-check credential liveness, membership, and ACL transactionally at publish time (`db_revalidate_file_write_principal`).

# Principals and scopes

`authorize_request(ctx, request, { requiredScope, allowedKinds, requiredUserPermission, route })` resolves the Bearer token into one principal kind:

- `user_api_key` (`pk_<keyId>.<secret>`): user-bound key minted on the api-keys route. Only signed-in Clerk users can mint one. UI-mintable scopes: `files:list`, `files:read`, `files:write`, `files:download`.
- `public_api_grant` (64-hex, short-lived): list/read only — the grant validator accepts only `files:list` and `files:read`.
- `plugin_run` (`plr_...`) and `plugin_ui` (`plu_...`): plugin runtime tokens with their own constraints (a backend plugin run can only write Markdown siblings of its triggering file, and can only download its own source upload).

Routes restrict kinds with `allowedKinds`; a valid token of a disallowed kind gets 403. `write-many` and `upload-urls` are `user_api_key` only. `write` also allows `plugin_run`. `download-urls` allows the plugin kinds too.

# Routes

All routes are POST and return JSON. Batch caps are tied to rate-bucket capacities — do not raise one without the other.

| Route                        | Scope            | Notes                                                                              |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `/api/v1/files/list`         | `files:list`     | File items carry `status` (`pending` until the R2 object is confirmed, then `ready`; `null` for folders) and `size` |
| `/api/v1/files/read`         | `files:read`     | User API keys read committed Markdown only; `public_api_grant` reads (and `read-many`) include the grant user's pending overlay |
| `/api/v1/files/read-many`    | `files:read`     | Up to 50 paths, per-item errors                                                    |
| `/api/v1/files/write`        | `files:write`    | One Markdown file; `overwrite: "replace" \| "fail"`, `skipIfUnchanged`             |
| `/api/v1/files/write-many`   | `files:write`    | Up to 20 files, 8 MB request cap, batch semantics below                            |
| `/api/v1/files/touch`        | `files:write`    | Up to 8 paths                                                                      |
| `/api/v1/files/download-urls`| `files:download` | Up to 20 node ids, presigned GET urls, TTL <= 15 min                               |
| `/api/v1/files/upload-urls`  | `files:write`    | Up to 20 files, presigned PUT urls, upload pipeline below                          |
| `/api/v1/activities/start`   | `activities:write` | Plugin-facing activity feed entry                                                |

# Rate buckets and quota

Buckets live in `packages/app/convex/rate_limiter.ts`:

- `public_api_auth` (60/min, cap 10): charged per client+route for malformed or unknown tokens, so probing stays cheap to refuse.
- `public_api_principal` (120/min, cap 20): charged once per authorized request. `download-urls` and `upload-urls` charge `count - 1` extra units so a batch of N costs the same as N single calls.
- `public_api_files_write_bulk` (600/min, cap 100): `write-many` only. One up-front charge of `count: files.length` before any write; an over-budget batch is a whole-request 429 with zero files staged.

`public_api_upload_bytes` quota (org+workspace scope, 50 GB of declared bytes): consumed by `upload-urls` mints in the same mutation that creates the nodes and assets. Monotonic — deleting files does not refund. Seeded lazily at the first mint; see the quotas skill for the exception this creates.

# Markdown write pipeline

`write_one_markdown_file` (module-private helper in `public_api.ts`) is the shared engine for `write` and `write-many`: decide create-vs-fill, stage (`prepare_file_write`), PUT the staged objects to R2, publish (`publish_file_write` / `publish_file_fill`), and sweep the stage on failure.

- Writing over an existing **editable** Markdown file fills in place: the nodeId stays stable for open editors and links, and open Yjs sessions converge on the new content. Non-editable targets (stored uploads) archive-and-recreate.
- Paths must already be canonical: every name is checked with `files_normalize_name` and refused when the canonical form differs, unlike the app UI, which silently normalizes. One non-obvious corner: special names like `readme.md` canonicalize to uppercase `README.md`, so the lowercase spelling is refused (with the generic invalid-name message). Empty content is refused too — importers create empty placeholder files through `/api/v1/files/touch`.
- `overwrite: "fail"` returns 409 `A file already exists at this path`; a folder at the path is always 409.
- `skipIfUnchanged: true`: when projecting the incoming Markdown into the current doc is a semantic no-op (`fillUpdate === null`), the route returns 200 with `unchanged: true` before staging — no stage, no asset docs, no uploads, no new version snapshot. The skip first asks the same node-level write check the publish would ask; a caller the publish would refuse falls through to the normal write path and gets the same refusal, so the unchanged marker cannot confirm content to someone who cannot write the node. Only the fill path can be unchanged; comparison is Yjs-level, not byte-level, because materialized Markdown is not byte-stable. `null` never lies, but the reverse is not guaranteed: some semantically identical rewrites still publish.
- Failure vocabulary (per-item `errorCode` in `write-many`, plugin settle codes in `write`): `unauthenticated` (401), `permission_denied` (403), `conflict` (409), `storage_failure` (500).
- Frontmatter field cap: markdown whose frontmatter extracts more than 128 distinct fields (`files_metadata_MAX_FRONTMATTER_FIELDS` in `packages/app/shared/files-metadata.ts`) is refused by the metadata insert helpers with a thrown `Too many frontmatter fields` ConvexError. The publish mutation rolls back, but the pipeline does not map that throw, so the API caller sees a generic error instead of a clean 400; the orphaned stage is swept by the hourly stage cleanup cron.

`write-many` batch semantics:

1. Auth first, then the 8 MB bounded body read (`read_request_text_bounded`).
2. Validate every item with the single-route rules before writing anything — one bad item is a whole-request 400 with the offending `path`. Duplicate normalized paths in one batch are a 400 too.
3. One up-front bulk-bucket charge, then sequential writes (concurrent publishes would conflict on shared ancestor folders).
4. Per-item outcomes: `{ written: [{ path, nodeId, contentType, unchanged? }], errors: [{ path, message, errorCode }] }`. A mid-batch `unauthenticated` aborts the whole request with 401; other failures are reported per item and the batch continues.

# Binary upload pipeline

`upload-urls` mints, per file: an active `files_nodes` doc, a `files_r2_assets` doc, and a presigned PUT url for the deterministic key `organizations/<org>/workspaces/<ws>/assets/<assetId>`. The whole batch validates before any write (canonical paths, sizes, collisions, per-path ACL including restricted ancestors, quota) — one bad item is a 400/403/409 with the offending `path` and nothing minted.

- `skipProcessing: true` inserts assets with `processingWorkId: null`: the R2 event finalizer records the object (r2Key, real size, etag) but starts no Markdown conversion and no plugin dispatch. Import tools want this; app-like uploads omit it.
- Until the R2 event arrives, the asset has no `r2Key` and `files/list` reports the file as `pending`. Events can arrive minutes late through Cloudflare queue retries.
- Every asset is born with `unfinalizedExpiresAt` (now + 24 h). The same patch that records `r2Key` clears it. The hourly `cleanup expired unfinalized assets` cron (`r2.ts`) deletes expired assets with zero references across `files_nodes`, `files_yjs_snapshots`, and `files_snapshots`; referenced ones are only warned about and re-checked after 7 days, never deleted.
- Known residual: a presigned PUT url outlives key revocation for its TTL, and the finalizer records the real object size without a cap check (declared size is a mint-time check only).

# Tests

- Coverage lives in `packages/app/convex/public_api.test.ts` (routes, batch semantics, quota, rate buckets) and `packages/app/convex/r2.test.ts` (finalizer, sweeper).
- Focused command: `vp env exec pnpm --dir packages/app exec vitest run --project convex convex/public_api.test.ts`.

# Guardrails

- Keep batch item caps <= their bucket capacities, and keep the caps named as constants next to the other `FILES_*` limits.
- Keep per-item error messages exact — importers match on them. Do not blur per-item errors to hide restricted-path existence; that leak is accepted and documented in the access-control skill.
- New routes need: schema entry in `api_schemas_Main`, `authorize_request` with an explicit `requiredUserPermission`, a rate-bucket decision, and tests for scope refusal plus at least one batch/limit edge.
