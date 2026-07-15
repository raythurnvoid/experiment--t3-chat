---
name: plugin-system
description: Plugin publishing limits, artifact cleanup, plugin UI pages, the Gallery plugin, and SDK/Gallery release mechanics. Use when changing plugin manifest validation (`packages/app/shared/plugins.ts`), the publish pipeline or artifact cleanup (`packages/app/convex/plugins.ts`), plugin UI assets/sessions (`packages/app/convex/plugins_ui.ts`), the plugin page host route, the Gallery plugin (`plugins/bonobo-plugin-gallery`), or the `bonobo-plugin-sdk` package.
---

# Scope

This skill covers publishing limits, review results, the plugin UI protocol and assets, cleanup lifecycles, Gallery behavior, reset recovery, and release mechanics. The module docblocks remain the closest implementation notes; this file owns the durable cross-module contract.

Also load `../convex/SKILL.md` before changing Convex code, and `../data-deletion/SKILL.md` before changing plugin-related deletion behavior.

# Manifest and publishing limits

Validation lives in `plugins_validate_manifest` (`packages/app/shared/plugins.ts`); structural caps sit on the zod schemas, semantic/duplicate/aggregate checks are imperative first-failure loops returning `Result` `_nay` with short literal messages. Publish failures flow through `_nay` so `update_last_publish_attempt` records them — never throw for a limit rejection.

| Limit                                                    | Value    | Where                                                   |
| -------------------------------------------------------- | -------- | ------------------------------------------------------- |
| Listed files                                             | 64       | `manifest_schema.files`                                 |
| Pages                                                    | 16       | `manifest_schema.pages`                                 |
| Navigation items (pages with `navItem`)                  | 8        | `plugins_validate_manifest` loop                        |
| Events                                                   | 8        | `manifest_schema.events`                                |
| Content types per event                                  | 32       | `event_schema.contentTypes`                             |
| Expanded event/content-type subscriptions                | 64       | `plugins_validate_manifest` loop                        |
| Outbound origins                                         | 16       | `manifest_schema.outboundOrigins`                       |
| Outbound origin length                                   | 255      | `plugins_validate_origin`                               |
| Normalized file path length                              | 512      | `module_path_schema`                                    |
| Content type length                                      | 255      | `manifest_file_schema.contentType`                      |
| Secret name length                                       | 128      | `plugins_validate_secret_name`                          |
| Publisher secrets per repository                         | 64       | publisher-secret mutations                              |
| Declared and actual bytes per file                       | 900,000  | schema + streaming reader                               |
| Aggregate artifact bytes (declared and downloaded)       | 16 MiB   | `plugins_MAX_ARTIFACT_BYTES`                            |
| Manifest + text source files passed between actions      | 900,000  | `sourceFiles` assembly in `publish_version_from_github` |
| Duplicate capabilities / origins / file paths / page ids | rejected | duplicate loops in `plugins_validate_manifest`          |

Publishing behavior in `publish_version_from_github` (`packages/app/convex/plugins.ts`):

- Declared over-limit input is rejected before any file fetch, upload, or registration.
- After reading only branch HEAD and the manifest, publishing rejects foreign plugin-name ownership and conflicting immutable versions before artifact downloads, AI review, uploads, or cleanup-attempt writes.
- Bodies are read through `read_response_body_bounded` — a streaming reader that cancels past the bound. `Content-Length` may pre-reject but is never the enforcement boundary. Exact byte-count and SHA-256 checks still run after the read.
- Downloads and uploads each run through a 4-wide shared-index worker loop (`ARTIFACT_DOWNLOAD_CONCURRENCY` / `ARTIFACT_UPLOAD_CONCURRENCY`), never unbounded `Promise.all`.

Publication visibility uses the required `sourceStatus` lifecycle only:

- A new or resumed exact artifact is `preparing`, non-latest, and unavailable to marketplace, install, runtime, page, mint, and asset paths.
- Source files are written under the version id. A failed write marks the version `failed`; an exact retry resumes idempotently.
- Registration and the final visibility mutation both recheck the exact repository claim id, URL, and owner that authorized the publish. Removing or reclaiming the URL while external work is in flight leaves the version non-ready.
- One final mutation changes the complete version to `ready`, demotes the previous latest version, and promotes the new version in the same transaction.
- An exact artifact that is already ready is immutable: a later commit returns its stored version and source commit without replacing pointers or uploading another copy.

# Durable publish-artifact cleanup

Interrupted publishing must not orphan R2 objects. The lifecycle, all in `packages/app/convex/plugins.ts` plus the `plugins_publish_artifact_cleanup_attempts` table (`schema.ts`, indexed `by_cleanupAt`):

- Every publish attempt creates a fresh `uploadId` and embeds it in every R2 key. Before the first upload, one mutation (`create_publish_artifact_cleanup_attempt`) inserts the exact key set (manifest + files, at most 65) and schedules cleanup one hour later. Attempts never share keys, so an old cleanup cannot delete a retry's uploads.
- `run_publish_artifact_cleanup_attempt` refuses before `cleanupAt`, keeps only exact keys owned by a ready version, deletes at most 10 unowned keys per operation, patches the remainder, and reschedules until empty. If the matching version is still `preparing` or `failed` and its manifest key belongs to this attempt's `uploadId`, the same attempt then drains its partial source tree and deletes the incomplete version. An older attempt never deletes a version now owned by a newer retry. Object deletion is idempotent; external failure retains the batch and retries.
- Successful registration removes the attempt (`remove_publish_artifact_cleanup_attempt`) only once the registered version owns the exact keys.
- An hourly cron (`schedule_due_publish_artifact_cleanup_attempts`) schedules a bounded number of due attempts as a fallback.

There is no R2 list API in this codebase — cleanup is driven purely off the stored keys.

Admin registry deletion is name-scoped and requires publishing to be quiescent. Preview and deletion find versions, all reviews by plugin name, cleanup attempts by plugin name, installations, and run/call history by immutable plugin version id. This version-keyed traversal is required because uninstall keeps run history and upgrade can move the live installation to a newer version. Call `hard_delete_plugin_from_registry` repeatedly for one plugin name until it returns `done: true`; a running event run requests cancellation and returns `{ done: false, deleted: 0 }`, so retry after the run reaches a terminal status. For the repository's last version, deletion drains publisher secrets before deleting each exact R2 key once, then removes the claim and version together. Name cleanup deletes a repository claim only when no other plugin version uses that URL and the current claimant is the version creator; it never deletes another user's reclaimed claim. Once a name preview is zero, `hard_delete_publisher_repository_now` removes any remaining claim-only repository and its secrets by repository id; claims cannot carry a plugin name because claiming happens before the manifest is fetched.

# Review pipeline

- Publishing reviews every executable or renderable text file, not only the backend entrypoint. File selection uses both MIME and extension, decoding is fatal UTF-8, and mismatches reject deterministically. Backend entries must be JavaScript by both classifications.
- Immutable reviewer policy is sent as developer/system content. Manifest facts, names, current source, and the optional previous-version diff are sent only as untrusted user content.
- Each review generates a fresh boundary sentinel that is absent from every current and previous untrusted value. Current and previous records use the same sentinel before the host creates the diff, so source text cannot forge a record boundary.
- Sorted `{ path, contentType, source }` records form the deterministic full-artifact input. The formatted current artifact plus any optional previous-version diff stays within the 900,000-byte review-input cap. The OpenAI input-token count endpoint then counts the exact developer message, user message, and JSON schema; input above 240,000 tokens is rejected before the model call, and count failure rejects the publish.
- The first terminal review result is cached by artifact hash, including `passed`, `rejected`, and `flagged`. An exact artifact never resamples; changing one byte creates a new artifact hash. Previous-version baseline R2 reads are bounded and verify stored size and SHA-256; a missing baseline omits the optional diff rather than blocking the complete current-artifact review.
- A binary-only artifact with no page or backend may auto-pass because it has no executable/renderable text. A page-bearing artifact never auto-passes for lacking a backend.
- Install/update, `list_ui_pages`, `mint_page_session`, and `get_ui_asset` require `reviewStatus: "passed"` for page-bearing versions.
- There is no review-policy generation or re-review migration path. This pre-production system deletes disposable plugin registry data and republishes current artifacts when the review implementation changes.

Repository claims intentionally remain normalized URL reservations without proof of repository control. This is an accepted provenance/name-reservation risk; do not describe the claim as verified ownership.

Publisher secrets remain bound to the immutable version creator. Runtime resolution and publisher-only management queries require the current repository claim owner to equal `plugins_versions.createdBy`; a different user who later claims the same URL cannot supply secrets or inherit the historical publisher panel.

# Plugin UI pages

- The current message contract is strict and has no compatibility version field. The query-free ready message contains only its type. The host's first init supplies the frame's `bridgeNonce`; later refresh messages carry that nonce and a bounded request id. The nonce correlates one iframe generation; it is visible to the page and is not an authentication secret.
- The host keys the child frame by membership, plugin version, page, and Retry attempt. Its layout effect attaches listeners before assigning the canonical `src`, captures the exact iframe node/generation in async work, accepts ready only from the direct opaque-origin WindowProxy, requires the current nonce for refresh, serializes refreshes, and revokes the host-only session id when the frame stops or navigates.
- The SDK installs its listener before sending ready, repeats ready every 500ms until init or page unload, and rejects an unanswered refresh after 10 seconds. The host alone owns the 15-second startup deadline and Retry UI. `fetchJson` retains exactly one 401 retry; a late 401 reuses a token that another request already rotated instead of rotating it again.
- Sessions (`plugins_ui_sessions`) are minted per (user, installation), hashed, and have a 30-minute TTL. Refresh updates one session doc in place; the old token hash stops resolving. Public API rate accounting uses a stable organization/workspace/user/installation principal key, while the route remains a separate bucket dimension.
- `/api/v1/files/download-urls` is the only download URL route. Every caller sends `fileNodeIds`, including one-item requests. Backend runs may send only their triggering upload id and still sign the original source asset. The route resolves the exact presented bearer again after file materialization and immediately before signing. The signer TTL keeps a one-second margin inside the remaining plugin authority, and the route repeats the same scope, `asset.read`, tenant, credential/session/run, and installation/version checks after signing before returning any URL. Reported `expiresAt` is the same conservative boundary. Requests are limited to 100 ids and 32 KB before authentication, reject duplicates before authorization or file work, then process at most the first 20 ids in request order and report truncation and per-id errors.
- Expired sessions drain through `cleanup_expired_ui_sessions`. Uninstall/workspace/user/admin deletion remains bounded — see `../data-deletion/SKILL.md`.
- Canonical assets use the single direct route `/plugins-ui/<versionId>/<path>`. Published plugin versions are immutable, so asset or response-policy changes require a new plugin version and republish; there is no compatibility redirect or asset-policy path generation.
- Canonical asset responses retain CSP, `nosniff`, immutable cache, CORP, and wildcard CORS required by module/style fetches from the opaque-origin frame. R2 failures return 502 with `Cache-Control: no-store` + `Retry-After: 3`. Never log raw R2 errors or keys.
- The host startup deadline is 15 seconds and clears once `bonobo:init` posts. Failure replaces the iframe with a `role="alert"` and focused Retry button; Retry creates a fresh frame, nonce, and session. The immutable iframe URL has no host origin, page id, token, or nonce query parameters.
- A page that already received its read-only token can self-navigate before the host observes the next load. The host disables the bridge and revokes on that load, while per-call liveness and TTL remain the backstop; do not claim already-authorized in-flight work can be recalled.

# Clean-slate changes and recovery

This plugin system is pre-production. Change the manifest, SDK, host, schema, and current plugins together; do not add legacy protocol handling, dual database shapes, redirect routes, or review-policy migrations. Stored plugin pages are always a required array; an omitted manifest `pages` field is normalized once to `[]` during registration. The stored `runtimeVersion` field and the UI message protocol version are gone. Manifests still require `compatibility.bonoboPluginRuntime: "1"` as the single current runtime stamp; there is no fallback or multi-version runtime path. If persisted plugin data conflicts with the current contract, use `../dev-data-reset/SKILL.md` to remove the registry and republish the current source commits. Preserve Clerk-backed user docs and their Polar state during that reset.

Recovery uses trusted sources only: current Git submodules/remotes for plugin artifacts, Convex deployment environment variables for known publisher values, and provider-supported credential creation or explicit user input for a missing value. Never use Playwriter or other browser automation to extract tokens from provider pages, and never print secret values in logs or reports.

# Gallery plugin (`plugins/bonobo-plugin-gallery`)

Git submodule with its own repo (`raythurnvoid/bonobo-plugin-gallery`). `dist/` is committed; publish fetches raw files from GitHub at the pinned commit; `scripts/build-manifest.mjs` recomputes manifest hashes. Vite builds with `minify: false` and fixed un-hashed output names, then Prettier formats the generated JS/CSS. The manifest build rejects text files with a line over 1,000 characters, and every bundle must stay under the 900,000-byte per-file cap.

- List scanning (`src/list-scan.ts`): each "Load more" drains buffered `pending_items` first, then requests `/api/v1/files/list` with `limit: 100`, `kind: "file"`, media `contentTypePrefixes`, and the current cursor; stops at 12 new unique tiles, source completion, or 30 successfully advanced pages; overflow buffers for the next click; dedup by nodeId against everything ever seen; cursor and partial progress survive failures. Visible completion (empty state allowed) is `sourceIsDone && pendingItems empty` — a capped scan keeps "Load more".
- 429 handling (`src/retry.ts`): same-body retry after 3 s then 6 s; retries never consume the page budget.
- Media URLs (`src/media-urls.ts`): `{url, expiresAt}` values; initial loads and renewals share one 4-slot pool with per-node in-flight dedup. The `use_media_url` hook in `app.tsx` permits one automatic renewal per failure episode, resets the budget only after a successful replacement load, and offers manual Retry after renewal failure. Video renewal restores `currentTime` and paused state after `loadedmetadata` and catches rejected `play()`.
- Accessibility: loading uses `role="status"`/`aria-live="polite"`, errors use `role="alert"`, Retry controls are real buttons, tile labels reveal on `:focus-visible` as well as hover, and `prefers-reduced-motion: reduce` disables animation/transitions. Buttons and the viewer back control are at least 44px high; the grid and media padding keep controls and tiles usable at a 360px viewport and 200% zoom.

# Releases (SDK + Gallery)

`packages/bonobo-plugin-sdk` is a root-repo folder mirrored to the standalone `raythurnvoid/bonobo-plugin-sdk` repo (release = fresh clone of the mirror, copy files, commit, push). The Gallery pins the SDK by commit SHA in `package.json` + `pnpm-lock.yaml`.

- Always run pnpm with `--ignore-workspace` inside `plugins/*` and inside `packages/bonobo-plugin-sdk` — installing through the root workspace pollutes the parent lockfile and produces stale git-dep pins.
- Published plugin versions are immutable — never rewrite one; bump to the first unused patch version.
- A release must reconcile six touchpoints: SDK remote SHA, Gallery `package.json` SDK pin, Gallery lockfile resolution, Gallery plugin version (`package.json` + `bonobo.plugin.json`), Gallery remote commit = checked-out submodule HEAD, and the parent gitlink (staged only by the user, never by agents).
- Run the Gallery build twice before releasing; the second build must produce no tracked diff.

# Tests

- Manifest caps, duplicates, zero-fetch-on-declared-over-limit, streaming bounds, 4-wide concurrency, and the cleanup-attempt lifecycle: `packages/app/convex/plugins.test.ts`.
- Bounded session deletion on all three paths: `packages/app/convex/data_deletion.test.ts`.
- Full-artifact review, artifact-hash cache, bounded stored reads, and backend/page classification: `packages/app/convex/plugins.test.ts` plus `packages/app/shared/plugins.test.ts`.
- Direct asset routes, passed-review gates, rotation/revocation, stable rate identity, expiry cleanup, and session behavior: `packages/app/convex/plugins_ui.test.ts`.
- Host protocol fields, deadline/Retry/focus, refresh serialization, and stale-generation cancellation: `packages/app/src/routes/w/$organizationName/$workspaceName/plugins/$pluginName_.pages.$pageId.test.tsx`. Real WindowProxy/load ordering still requires Chromium/Playwriter.
- Gallery scan/media/a11y behavior: `plugins/bonobo-plugin-gallery/src/*.test.ts(x)` (`pnpm run test:once`); SDK handshake/fetchJson: `packages/bonobo-plugin-sdk/frontend.test.ts`.

Focused runs only, through `vp env exec pnpm --dir <package> ...`.
