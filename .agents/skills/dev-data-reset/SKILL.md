---
name: dev-data-reset
description: Wipe the dev Convex deployment back to a from-scratch state (preserving Clerk-backed users and their auth/billing) and reseed the first-party plugins (image, video, pdf) by republishing and reinstalling them. Use when Ray asks to reset dev data, start from scratch, clean up the database, or erase data ahead of a schema change to avoid writing a migration.
---

# Dev Data Reset

Full reset of the dev deployment: delete all app data except `users` docs that have a `clerkUserId`, then republish and reinstall the three first-party plugins. Load `convex-admin-ops` for CLI mechanics (Windows invocation, JSON args, readback interpretation) and `app-playwriter-harness` for the browser reseed phase.

## What survives a reset

- `users` docs with a non-null `clerkUserId`, their Clerk auth state, profile, Polar billing/customer state, and a usable default tenant (org + workspace).
- Convex deployment env vars (including `PLUGIN_SECRETS_ENCRYPTION_KEY` — encrypted secrets are wiped, not the key).
- Everything else is deleted: plugin registry (versions, reviews, claims, publisher secrets, R2 artifacts), installations and installation secrets, event runs, tenant content, anonymous users (including their `users` docs).

## Preflight

1. Confirm the target from `packages/app/.env.local` (`CONVEX_DEPLOYMENT`, currently `dev:grand-finch-267`). Dev only — never `--prod`.
2. **Capture publisher secret values before wiping.** Reseed values come from the Convex deployment env via `convex env get <NAME>`. All required names are in env as of the 2026-07-06 reset: `OPENAI_API_KEY`, `MODAL_TOKEN`, `MISTRAL_API_KEY`, `MODAL_MEDIA_AUDIO_URL`, `MODAL_FILE_CONVERTER_URL`. If one ever goes missing, recover it BEFORE the wipe (decrypt the live publisher secret via `plugins:decrypt_secret_for_runtime` with a `{tier:"publisher", secret:<doc>}` payload — read the doc from a pre-wipe `convex export` snapshot — or ask Ray) and persist with `convex env set`. Take a `convex export --path <backup.zip>` snapshot first regardless; it doubles as the rollback artifact. Never paste secret values into answers.
3. Confirm the deployment env has `PLUGIN_IMPORT_GITHUB_TOKEN` and `OPENAI_API_KEY` — publishing imports from GitHub and runs the AI review.

## Phase 1 — Wipe (Convex CLI)

Run from `packages/app` with the direct Node CLI invocation (`vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable ...`); see `convex-admin-ops` for arg-quoting hazards.

1. **Plugin registry.** Enumerate distinct `name` values from `plugins_versions` (`convex data plugins_versions --limit 100 | Out-String -Width 500`). For each name run `plugins:preview_hard_delete_registered_plugin` → `plugins:hard_delete_registered_plugin_now` → preview readback (expect all-zero counts; rerun the delete if it throws on batch budget).
2. **Users.** Enumerate `users` (`convex data users --limit 100 | Out-String -Width 500`); record `_id` and `clerkUserId`. Then per user, `users:hard_delete_user_now`:
   - `clerkUserId` present → `{"userId":"<id>","purgeUserMod":"data"}`
   - no `clerkUserId` → `{"userId":"<id>","purgeUserMod":"data_auth_and_user_record"}`
3. **Deletion queue.** Run `data_deletion:run_process_deletion_requests_once` with `{}` until it returns `shouldReschedule: false` and `data_deletion_requests` is empty.
4. **Orphan sweep (conditional).** Plugin publishes materialize version-keyed source trees (`/<pluginVersionId>/...`) under the GLOBAL organization / PLUGINS workspace, and `plugins:hard_delete_registered_plugin_now` (step 1) already sweeps them per version. After step 1, count `files_nodes` for GLOBAL/PLUGINS — it should be zero; a nonzero count means a version doc was deleted outside the hard-delete flow, and the leftover trees can be drained with `plugins:delete_plugin_source_tree_batch` (`{"pluginVersionId":"<id>"}`, rerun until `done: true`). GitHub mirror mounts under GLOBAL/GITHUB are unrelated to plugins and are managed by `github_sources`.
5. **Expired grants (conditional).** If `public_api_grants` shows a backlog of expired docs, run `public_api:cleanup_expired_grants_until_done` with `{}`.

Readback gate before declaring the wipe done: `plugins_versions`, `plugins_publisher_repositories`, `plugins_publisher_repository_secrets`, `plugins_workspace_installations`, `plugins_workspace_installation_secrets`, and `data_deletion_requests` all empty; `users` contains only Clerk-backed docs, each still with its `clerkUserId`.

## Phase 2 — Reseed plugins (app UI via Playwriter)

Drive Ray's signed-in app tab (Clerk user preserved by the wipe). Reload the tab first — the default tenant may have been recreated, so navigate fresh from the app root. Mind two known frictions: the Convex dev cold start (first action can take ~60s+) and the `plugins_manage` rate limiter (token bucket, capacity 2, ~6/min — space plugin mutations ~15s apart).

Browser driving (verified 2026-07-06): Edge's own `--remote-debugging-port=9222` no longer binds on the default user-data-dir (Chromium M136+ restriction) — use the Playwriter CLI instead (`pnpx playwriter session new`, then `pnpx playwriter -s <id> -f <script.js>`). On this machine multi-line `-e` code is truncated at the first newline, so always use `-f` with a script file; each execute call has a ~10s cap, so keep calls to one action and verify state via `convex data` readbacks instead of in-page sleeps. If the app tab shows the "Something went wrong" error boundary, `page.reload()` and continue.

First-party plugin repositories (git submodules under `plugins/`):

- `https://github.com/raythurnvoid/bonobo-plugin-image`
- `https://github.com/raythurnvoid/bonobo-plugin-video`
- `https://github.com/raythurnvoid/bonobo-plugin-pdf`

For each plugin, in order:

1. **Claim + publish.** On `/w/:organizationName/:workspaceName/plugins/publisher`, paste the repository URL into the claim input (placeholder `https://github.com/owner/plugin-repo`), click `Claim`, then `Publish` on the repository card. Publishing imports the artifact from GitHub and runs the AI review — allow a few minutes; the card shows the last attempt outcome. A `rejected`/`failed` status message on the card is the triage starting point (review verdict vs GitHub fetch).
2. **Publisher secrets.** On the plugin detail page (`/w/:organizationName/:workspaceName/plugins/<name>`), Secrets section of the publisher panel. Values come from `convex env get` (Preflight step 2):
   - `image`: `OPENAI_API_KEY` — origins `https://api.openai.com`
   - `video`: `MISTRAL_API_KEY` (`https://api.mistral.ai`), `OPENAI_API_KEY` (`https://api.openai.com`), `MODAL_MEDIA_AUDIO_URL` and `MODAL_TOKEN` (origin = the Modal extractor origin, i.e. the origin of the `MODAL_MEDIA_AUDIO_URL` value)
   - `pdf`: `MODAL_FILE_CONVERTER_URL` and `MODAL_TOKEN` (origin = the file-converter origin, i.e. the origin of the `MODAL_FILE_CONVERTER_URL` value). The pdf worker reads both via `secrets.get` — before the 2026-07-06 reset they were never configured and pdf runs would have failed at secret resolution.
3. **Install.** On the same detail page, click `Install` and accept the consent modal (capabilities + outbound origins). The button reads `Update`/`Reinstall` if an installation already exists.

## Verification

- `plugins_versions` has all three plugins with `reviewStatus: "passed"`; `plugins_workspace_installations` has one row per plugin for the workspace; publisher secrets show `valuePreview: "configured"` for the five expected rows (1 image + 4 video).
- Functional smoke: upload a small image into a files workspace and poll for the `.description.md` sibling (~2 min). For deep QA use the playbooks: `packages/app/playwriter-playbooks/image-plugin-description.md` and `video-plugin-transcription.md`.
- Report which deployment was reset, per-user purge modes used, and any skipped step with its real blocker.
