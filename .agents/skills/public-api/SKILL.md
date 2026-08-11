---
name: public-api
description: Spec for the public HTTP API under `/api/v1` — routes, auth principals, scopes, rate buckets, batch semantics, file write/upload pipelines, and their limits. Use when changing `packages/app/convex/public_api.ts`, `packages/app/convex/public_api_http_routes.ts`, `packages/app/shared/api-schemas.ts` route entries, API-key scopes, public-API rate buckets or quotas, or the api-keys route UI.
---

# Mental model

The public API is the workspace file surface for external callers: import CLIs, scripts, and plugins. Every route is a Convex HTTP action with a typed entry in `api_schemas_Main` (`packages/app/shared/api-schemas.ts`). A route without a schema entry does not exist.

The HTTP wrappers are split by startup cost. `/api/v1/files/list` lives in `packages/app/convex/public_api_files_list_http.ts` and stays in the small static root graph because it is the hot plugin read path. The other route definitions live in the small `packages/app/convex/public_api_http_routes.ts` module. Each route loads its heavy implementation from `packages/app/convex/public_api.ts` with a literal dynamic import only when that route runs. Shared Bearer-token authorization lives in `packages/app/convex/public_api_http_auth.ts`. Public scopes and the plugin token formats that principal resolution and HTTP authorization must agree on live in `packages/app/shared/public-api.ts`; one-consumer credential and grant details stay private to their owning Convex module.

Plugin UI documents and `/api/v1/*` share the Convex HTTP origin. Their iframe keeps that origin through `sandbox="allow-scripts allow-same-origin"`, so the browser sends the existing JSON plus `Authorization` request directly without a CORS preflight. Do not add a `text/plain` token envelope or route calls through the host app. External browser callers on another origin still use normal CORS behavior.

A caller is never more powerful than the user behind it. `public_api_http_auth.ts` maps every `files:*` scope to its required app permission (`content.read` or `content.write`). Routes pass only their scope, so they cannot forget the app-permission check. Plugin runs still use scopes only. The write mutations re-check credential liveness, membership, and ACL transactionally at publish time (`db_revalidate_file_write_principal`).

# Principals and scopes

`public_api_authorize_request(ctx, request, { requiredScope, allowedKinds, route })` resolves the Bearer token into one principal kind:

Public API scopes and app permissions are separate concepts and use separate values. API scopes use colon names such as `files:read`; app permissions use dot names such as `content.read`. Several file scopes can map to the same app permission, so do not make their values identical or pass the permission from each route.

- `user_api_key` (`pk_<keyId>.<secret>`): user-bound key minted on the api-keys route. Only signed-in Clerk users can mint one. UI-mintable scopes: `files:list`, `files:read`, `files:write`, `files:download`.
- `public_api_grant` (64-hex, short-lived): list/read only — the grant validator accepts only `files:list` and `files:read`. Organization removal deletes the member's grants so a later invite cannot revive an old token.
- `plugin_run` (`plr_...`) and `plugin_ui` (`plu_...`): plugin runtime tokens with their own constraints (a backend plugin run can only write Markdown siblings of its triggering file, and can only download its own source upload). Organization removal also deletes that member's plugin UI sessions.

Routes restrict kinds with `allowedKinds`; a valid token of a disallowed kind gets 403. `write-many` and `upload-urls` are `user_api_key` only. `write` and `touch` also allow `plugin_run`. `download-urls` allows the plugin kinds too.

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

`files/list` applies `contentTypePrefixes` inside one Convex query before pagination. `limit` counts matching docs. `scanLimit` controls how many source docs the filtered query may inspect; the public route defaults it to 10,000, and the internal query caps it at 10,000 source docs. The query does not set `maximumBytesRead`. A sparse filtered page can still be short or empty while `isDone` is false, so callers must continue with the returned cursor. Direct internal callers such as AI file tools omit `scanLimit` and keep the 1,000-doc default. The prefix predicate uses lexicographic string ranges because Convex filters do not provide `startsWith`.

# Rate buckets and quota

Buckets live in `packages/app/convex/rate_limiter.ts`:

- `public_api_auth` (60/min, cap 10): charged per client+route for malformed or unknown tokens, so probing stays cheap to refuse.
- `public_api_principal` (120/min, cap 20): charged once per authorized request. `download-urls` and `upload-urls` charge `count - 1` extra units so a batch of N costs the same as N single calls.
- `public_api_files_write_bulk` (600/min, cap 100): `write-many` only. One up-front charge of `count: files.length` before any write; an over-budget batch is a whole-request 429 with zero files staged.

`public_api_upload_bytes` quota (org+workspace scope, 50 GB of declared bytes): consumed by `upload-urls` mints in the same mutation that creates the nodes and assets. Monotonic — deleting files does not refund. Seeded lazily at the first mint; see the quotas skill for the exception this creates.

# Markdown write pipeline

`/files/write` and `/files/write-many` stay Markdown-only by contract (a deliberate non-goal of the editable-text feature): they refuse non-`.md` paths. Reads serve every editable text class; plain-text files enter through `/upload-urls` or the app's agent tools.

`write_one_markdown_file` (module-private helper in `public_api.ts`) is the shared engine for `write` and `write-many`: decide create-vs-fill, stage (`prepare_file_write`), PUT the staged objects to R2, publish (`publish_file_write` / `publish_file_fill`), and sweep the stage on failure.

- Both routes normalize the incoming content at the request boundary, ABOVE the byte count: one leading BOM is dropped and CRLF/lone CR become LF (`files_normalize_text_document_input`). The document, the R2 content snapshot, the committed chunks, and the stored size all see the same normalized string.

- Writing over an existing **editable** Markdown file fills in place: the nodeId stays stable for open editors and links, and open Yjs sessions converge on the new content. Non-editable targets (stored uploads) archive-and-recreate.
- Paths must already be canonical: every name is checked with `files_normalize_name` and refused when the canonical form differs, unlike the app UI, which silently normalizes. One non-obvious corner: special names like `readme.md` canonicalize to uppercase `README.md`, so the lowercase spelling is refused (with the generic invalid-name message). Empty content is refused too — importers create empty placeholder files through `/api/v1/files/touch`.
- `overwrite: "fail"` returns 409 `A file already exists at this path`; a folder at the path is always 409.
- `skipIfUnchanged: true`: when projecting the incoming Markdown into the current doc is a semantic no-op (`fillUpdate === null`), the route returns 200 with `unchanged: true` before staging — no stage, no asset docs, no uploads, no new version snapshot. The skip first asks the same node-level write check the publish would ask; a caller the publish would refuse falls through to the normal write path and gets the same refusal, so the unchanged marker cannot confirm content to someone who cannot write the node. Only the fill path can be unchanged; comparison is Yjs-level, not byte-level, because materialized Markdown is not byte-stable. `null` never lies, but the reverse is not guaranteed: some semantically identical rewrites still publish.
- Failure vocabulary (per-item `errorCode` in `write-many`, plugin settle codes in `write`): `unauthenticated` (401), `permission_denied` (403), `conflict` (409), `storage_failure` (500).
- Frontmatter caps: 128 distinct fields (`files_metadata_MAX_FRONTMATTER_FIELDS`) and 512 index documents (`files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS`), both in `packages/app/shared/files-metadata.ts`. On the CREATE path the metadata insert helper's `Too many frontmatter fields` throw rolls the publish back, and the pipeline does not map that throw, so the API caller sees a generic error instead of a clean 400; the orphaned stage is swept by the hourly stage cleanup cron. On the FILL path the committed chunks refresh through materialization, which settles over-cap frontmatter with the `contentFrontmatterTooLarge*` marker pair instead of failing the request — the write returns 200 and the committed content stays at the last sequence that fit (see `../files-editable-text/SKILL.md`).

`write-many` batch semantics:

1. Auth first, then the 8 MB bounded body read (`read_request_text_bounded`).
2. Validate every item with the single-route rules before writing anything — one bad item is a whole-request 400 with the offending `path`. Duplicate normalized paths in one batch are a 400 too.
3. One up-front bulk-bucket charge, then sequential writes (concurrent publishes would conflict on shared ancestor folders).
4. Per-item outcomes: `{ written: [{ path, nodeId, contentType, unchanged? }], errors: [{ path, message, errorCode }] }`. A mid-batch `unauthenticated` aborts the whole request with 401; other failures are reported per item and the batch continues.

# Binary upload pipeline

`upload-urls` mints, per file: an active `files_nodes` doc, a `files_r2_assets` doc, and a presigned PUT url for the deterministic key `organizations/<org>/workspaces/<ws>/assets/<assetId>`. The whole batch validates before any write (canonical paths, sizes, collisions, per-path ACL including restricted ancestors, quota) — one bad item is a 400/403/409 with the offending `path` and nothing minted.

- `upload-urls` is the deliberate public CREATE path for plain-text editable documents: an upload whose name has a recognized editable text extension converts into an editable document on finalization. The extension classifier beats the client-declared MIME — a recognized text extension stores the classifier's media type and ignores the caller's declared one; anything else keeps the client value (media uploads need it for plugin routing).
- `skipProcessing: true` inserts assets with `processingWorkId: null`: the R2 event finalizer records the object (r2Key, real size, etag) but starts no text conversion and no plugin dispatch. Import tools want this; app-like uploads omit it.
- Until the R2 event arrives, the asset has no `r2Key` and `files/list` reports the file as `pending`. Events can arrive minutes late through Cloudflare queue retries.
- Every asset is born with `unfinalizedExpiresAt` (now + 24 h). The same patch that records `r2Key` clears it. The hourly `cleanup expired unfinalized assets` cron (`r2.ts`) deletes expired assets with zero references across `files_nodes`, `files_yjs_snapshots`, and `files_snapshots`; referenced ones are only warned about and re-checked after 7 days, never deleted.
- Known residual: a presigned PUT url outlives key revocation for its TTL, and the finalizer records the real object size without a cap check (declared size is a mint-time check only).

# API-keys page quick-start

The workspace `API keys` page (`packages/app/src/routes/w/$organizationName/$workspaceName/api-keys/index.tsx`) explains the scopes and generates runnable samples:

- Scope descriptions: `files:read` is "Read the committed content of editable text files by path"; `files:write` is "Create and update Markdown files by path, and upload other files". The notes explain that reads cover Markdown plus recognized plain text, and that uploads with a recognized plain-text extension convert into editable documents.
- The curl and Node samples select any editable text file through `contentTypePrefixes: ["text/", "application/json", "application/yaml"]` — there is no `.md` filter anymore, and the empty-workspace error is `No editable text files found`. `api-keys/index.test.tsx` pins these sample semantics.

# Tests

- Coverage lives in `packages/app/convex/public_api.test.ts` (route behavior, batch semantics, quota, rate buckets), `packages/app/convex/http.test.ts` (root route inventory), and `packages/app/convex/r2.test.ts` (finalizer, sweeper).
- Focused command: `vp env exec pnpm --dir packages/app exec vitest run --project convex convex/public_api.test.ts`.

# Guardrails

- Keep `public_api_Scope` as the explicit scope union. Do not export one constant per scope. Check
  standalone scope literals and collections with `satisfies`, and keep the exhaustive
  scope-to-permission map checked with `satisfies Record<public_api_Scope, ...>`.
- Keep batch item caps <= their bucket capacities, and keep the caps named as constants next to the other `FILES_*` limits.
- Keep per-item error messages exact — importers match on them. Do not blur per-item errors to hide restricted-path existence; that leak is accepted and documented in the access-control skill.
- New routes need: schema entry in `api_schemas_Main`, a route definition in `public_api_http_routes.ts`, `public_api_authorize_request` with an explicit `requiredScope`, a rate-bucket decision, a root route-inventory entry, and tests for scope refusal plus at least one batch/limit edge. Add every new scope to the exhaustive scope-to-app-permission map in `public_api_http_auth.ts`; use `null` only when no app permission applies. Keep a cheap implementation static only when its imports stay small. Otherwise, load the heavy implementation through one literal dynamic import inside the registered route.
