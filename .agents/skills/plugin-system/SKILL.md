---
name: plugin-system
description: Plugin publishing limits, artifact cleanup, plugin UI pages, the Gallery plugin, and SDK/Gallery release mechanics. Use when changing plugin manifest validation (`packages/app/shared/plugins.ts`), the publish pipeline or artifact cleanup (`packages/app/convex/plugins.ts`), plugin UI assets/sessions (`packages/app/convex/plugins_ui.ts`), the plugin page host route, the Gallery plugin (`plugins/bonobo-plugin-gallery`), or the `bonobo-plugin-sdk` package.
---

# Scope

This skill covers the resource limits, cleanup lifecycles, Gallery behavior, and release mechanics of the plugin system. Trust-boundary and postMessage-protocol hardening are documented in the module docblocks (`packages/app/convex/plugins_ui.ts`, the host route) and are owned by separate security-review work — do not fold protocol-hardening guidance into this file.

Also load `../convex/SKILL.md` before changing Convex code, and `../data-deletion/SKILL.md` before changing plugin-related deletion behavior.

# Manifest and publishing limits

Validation lives in `plugins_validate_manifest` (`packages/app/shared/plugins.ts`); structural caps sit on the zod schemas, semantic/duplicate/aggregate checks are imperative first-failure loops returning `Result` `_nay` with short literal messages. Publish failures flow through `_nay` so `update_last_publish_attempt` records them — never throw for a limit rejection.

| Limit | Value | Where |
| --- | --- | --- |
| Listed files | 64 | `manifest_schema.files` |
| Pages | 16 | `manifest_schema.pages` |
| Navigation items (pages with `navItem`) | 8 | `plugins_validate_manifest` loop |
| Normalized file path length | 512 | `module_path_schema` |
| Content type length | 255 | `manifest_file_schema.contentType` |
| Declared and actual bytes per file | 900,000 | schema + streaming reader |
| Aggregate artifact bytes (declared and downloaded) | 16 MiB | `plugins_MAX_ARTIFACT_BYTES` |
| Manifest + text source files passed between actions | 900,000 | `sourceFiles` assembly in `publish_version_from_github` |
| Duplicate capabilities / origins / file paths / page ids | rejected | duplicate loops in `plugins_validate_manifest` |

Publishing behavior in `publish_version_from_github` (`packages/app/convex/plugins.ts`):

- Declared over-limit input is rejected before any file fetch, upload, or registration.
- Bodies are read through `read_response_body_bounded` — a streaming reader that cancels past the bound. `Content-Length` may pre-reject but is never the enforcement boundary. Exact byte-count and SHA-256 checks still run after the read.
- Downloads and uploads each run through a 4-wide shared-index worker loop (`ARTIFACT_DOWNLOAD_CONCURRENCY` / `ARTIFACT_UPLOAD_CONCURRENCY`), never unbounded `Promise.all`.

# Durable publish-artifact cleanup

Interrupted publishing must not orphan R2 objects. The lifecycle, all in `packages/app/convex/plugins.ts` plus the `plugins_publish_artifact_cleanup_attempts` table (`schema.ts`, indexed `by_cleanupAt`):

- Before the first upload, one mutation (`create_publish_artifact_cleanup_attempt`) inserts an attempt holding the exact object keys (manifest + files, at most 65) and schedules cleanup one hour later. The grace period protects a concurrent identical publish — never delete immediately on publish failure.
- `run_publish_artifact_cleanup_attempt` refuses before `cleanupAt`, checks exact `(name, version, artifactHash)` ownership, keeps keys owned by a registered version, deletes at most 10 unowned keys per operation, patches the remainder, and reschedules until empty. Object deletion is idempotent; external failure retains the batch and retries.
- Successful registration removes the attempt (`remove_publish_artifact_cleanup_attempt`) only once the registered version owns the exact keys.
- An hourly cron (`schedule_due_publish_artifact_cleanup_attempts`) schedules a bounded number of due attempts as a fallback.

There is no R2 list API in this codebase — cleanup is driven purely off the stored keys.

# Plugin UI pages

- Sessions (`plugins_ui_sessions`) are minted per (user, installation), hashed, 30-minute TTL, liveness re-checked per call. Expired sessions drain via `cleanup_expired_ui_sessions` (batched, daily cron). Deletion paths are bounded on uninstall, workspace purge, user deletion, and admin hard-delete — see `../data-deletion/SKILL.md`.
- The asset route (`/plugins-ui/<versionId>/<path>`) 404s on malformed percent-encoding and path-shape misses, and returns 502 with `Cache-Control: no-store` + `Retry-After: 3` when the object fetch fails. `no-store` is load-bearing: the 200 path is cached immutably by Cloudflare, and a cached 502 would never heal. `Access-Control-Allow-Origin: *` on the 200 path is also load-bearing (Vite crossorigin module scripts from the opaque-origin sandbox). Never log raw errors from the object fetch — `ConvexError.message` stringifies the payload including the R2 key; log `error.data.message`.
- The host route (`$pluginName_.pages.$pageId.tsx`) enforces a 15-second startup deadline (`PAGE_STARTUP_DEADLINE_MS`), cleared once `bonobo:init` posts. Startup failures render a `role="alert"` error with a focused Retry button; Retry bumps an attempt generation that re-keys the iframe and re-arms the bridge effect.

# Gallery plugin (`plugins/bonobo-plugin-gallery`)

Git submodule with its own repo (`raythurnvoid/bonobo-plugin-gallery`). `dist/` is committed; publish fetches raw files from GitHub at the pinned commit; `scripts/build-manifest.mjs` recomputes manifest hashes. Vite builds with `minify: false` (reviewable output; bundle must stay under the 900,000-byte per-file cap) and fixed un-hashed output names.

- List scanning (`src/list-scan.ts`): each "Load more" drains buffered `pending_items` first, then requests `/api/v1/files/list` with `limit: 100`, `kind: "file"`, media `contentTypePrefixes`, and the current cursor; stops at 12 new unique tiles, source completion, or 30 successfully advanced pages; overflow buffers for the next click; dedup by nodeId against everything ever seen; cursor and partial progress survive failures. Visible completion (empty state allowed) is `sourceIsDone && pendingItems empty` — a capped scan keeps "Load more".
- 429 handling (`src/retry.ts`): same-body retry after 3 s then 6 s; retries never consume the page budget.
- Media URLs (`src/media-urls.ts`): `{url, expiresAt}` values; initial loads and renewals share one 4-slot pool with per-node in-flight dedup. The `use_media_url` hook in `app.tsx` permits one automatic renewal per failure episode, resets the budget only after a successful replacement load, and offers manual Retry after renewal failure. Video renewal restores `currentTime` and paused state after `loadedmetadata` and catches rejected `play()`.
- Accessibility: loading uses `role="status"`/`aria-live="polite"`, errors use `role="alert"`, Retry controls are real buttons, tile labels reveal on `:focus-visible` as well as hover, `prefers-reduced-motion: reduce` disables animation/transitions, targets are at least 24px.

# Releases (SDK + Gallery)

`packages/bonobo-plugin-sdk` is a root-repo folder mirrored to the standalone `raythurnvoid/bonobo-plugin-sdk` repo (release = fresh clone of the mirror, copy files, commit, push). The Gallery pins the SDK by commit SHA in `package.json` + `pnpm-lock.yaml`.

- Always run pnpm with `--ignore-workspace` inside `plugins/*` and inside `packages/bonobo-plugin-sdk` — installing through the root workspace pollutes the parent lockfile and produces stale git-dep pins.
- Published plugin versions are immutable — never rewrite one; bump to the first unused patch version.
- A release must reconcile six touchpoints: SDK remote SHA, Gallery `package.json` SDK pin, Gallery lockfile resolution, Gallery plugin version (`package.json` + `bonobo.plugin.json`), Gallery remote commit = checked-out submodule HEAD, and the parent gitlink (staged only by the user, never by agents).
- Run the Gallery build twice before releasing; the second build must produce no tracked diff.

# Tests

- Manifest caps, duplicates, zero-fetch-on-declared-over-limit, streaming bounds, 4-wide concurrency, and the cleanup-attempt lifecycle: `packages/app/convex/plugins.test.ts`.
- Bounded session deletion on all three paths: `packages/app/convex/data_deletion.test.ts`.
- Asset-route 404/502 and session behavior: `packages/app/convex/plugins_ui.test.ts`.
- Host-route deadline/Retry/focus: `packages/app/src/routes/w/$organizationName/$workspaceName/plugins/$pluginName_.pages.$pageId.test.tsx`.
- Gallery scan/media/a11y behavior: `plugins/bonobo-plugin-gallery/src/*.test.ts(x)` (`pnpm run test:once`); SDK handshake/fetchJson: `packages/bonobo-plugin-sdk/frontend.test.ts`.

Focused runs only, through `vp env exec pnpm --dir <package> ...`.
