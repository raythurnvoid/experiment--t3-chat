---
name: convex-admin-ops
description: Run live Convex admin/operational CLI tasks safely in this repo, especially destructive internal functions, one-off data cleanup, user hard deletion, environment/deployment checks, and targeted readback verification. Use when Codex needs to run `convex run`, `convex data`, `convex logs`, or similar Convex CLI operations against dev, preview, or production deployments.
---

# Convex Admin Ops

Use this skill for live Convex control-plane or data-plane operations. Also load the domain skill for the behavior being changed or invoked, such as `convex`, `auth-system`, `organizations-tenancy`, or `billing-system`.

## Safety Workflow

1. Identify the target deployment before running a write.
   - In this repo, deployment env lives under `packages/app`.
   - Read `packages/app/.env.local` for `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, and `VITE_CONVEX_HTTP_URL`.
   - All admin commands in this skill target the dev deployment configured in `packages/app/.env.local` only — never pass `--prod`. Use `--preview-name` or `--deployment-name` only when the user explicitly requests that target.
2. Confirm the function signature from source before constructing args.
   - Prefer `rg` first, then read the function registration and nearby tests.
   - For destructive account operations, read the relevant auth/data-deletion skill sections.
3. State the function, deployment, and destructive mode before the write.
4. Run the smallest targeted command.
5. Verify durable state with a readback command after the write.

## Windows CLI Invocation

Run Convex commands from `packages/app` through Vite Plus and the installed Node CLI. This direct invocation preserves JSON arguments on this machine:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable <module:function> '<json args>'
Pop-Location
```

Do not route JSON args through `pnpm.CMD`, `convex.ps1`, or a nested `powershell -Command`; those paths have stripped JSON quotes on this machine. If Convex reports unquoted keys or values, the function did not run. Fix the direct Node argument and verify it with a read-only function before retrying a write.

Do not use `npm`, `npx`, Bun, or `bunx`. If a one-off Convex package executable is needed outside an installed workspace binary, use `pnpx`.

For operational calls that do not depend on local code changes, use:

```powershell
--typecheck disable --codegen disable
```

Use `--push` only when you intentionally need to deploy local Convex source changes before running the function.

## JSON Args Pattern

For generated args, pass a PowerShell string variable as the final argument:

```powershell
$argsJson = @{
	userId = "m579b05e4rkd8n5af1qmjsee9x860cm5"
	purgeUserMod = "data"
} | ConvertTo-Json -Compress

vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable users:hard_delete_user_now $argsJson
```

If Convex reports a JSON parse error such as unquoted keys or values, stop and fix argument passing before retrying. A parse error means the function did not run.

## User Hard Deletion

The direct admin entrypoint is:

```powershell
users:hard_delete_user_now
```

Arguments:

```json
{
	"userId": "<users id>",
	"purgeUserMod": "data"
}
```

`purgeUserMod` behavior:

- `"data"`: hard-delete/reset app data while keeping the account live; preserve the `users` doc, Clerk and anonymous auth state, profile, billing/customer state, and a usable default tenant.
- `"data_and_auth"`: delete tenant/user data and auth state, attempt Clerk deletion, remove anonymous auth tokens, keep the final tombstoned `users` doc, and schedule period-end subscription cancellation when applicable. This is true cleanup cancellation, not the normal billing-panel cancellation flow that downgrades a live user to `Free`.
- `"data_auth_and_user_record"`: delete tenant/user data and auth state, revoke/delete billing state immediately, and purge the final local `users` doc. This is the only routine admin path that should immediately revoke/delete billing instead of preserving or downgrading the account.

Use `"data"` when the user wants to wipe app data while keeping the account usable. Use `"data_and_auth"` for account deletion that keeps the final tombstone. Use `"data_auth_and_user_record"` only when the user explicitly wants the final user record purged too.

The action returns `null`. One successful invocation per user is enough: it schedules the same user and mode when bounded user-local work remains, and it hands queued organization/workspace cleanup to the existing Workpool. If the invocation fails on Clerk, Polar, or another external dependency, correct that problem and retry the same user and mode. Record the reset start time and each successful user/mode invocation. Before writing replacement data, inspect only `hard_delete_user_now` scheduled rows created since that start time. Require no `pending` or `inProgress` row. A failed row remains unresolved unless a later explicit invocation for the same user and mode succeeded and left no later pending or running continuation. Scheduled history persists for seven days, so an older or superseded failed row does not fail the new reset. Verify `data_deletion_requests` is empty and confirm the target tables are still empty on a second readback.

## Remove A Registered Plugin

Workspace members can uninstall a plugin from its plugin detail page (`plugins.uninstall_version`): that deletes the workspace's event handlers, installation secrets, and installation doc, and keeps event runs/run calls as version-owned history. Registry-level removal remains the internal-only admin flow in `packages/app/convex/plugins.ts`. It targets one plugin name and hard-deletes its versions, reviews (including rejected first publishes with no version), interrupted-upload cleanup attempts and keys, per-version source trees (`/<pluginVersionId>/...` in GLOBAL/PLUGINS), workspace installations and children, version-owned run history, repository claims backing registered versions, and exact R2 artifact objects.

Run preview → delete → preview readback from `packages/app`:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:hard_delete_plugin_from_registry '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
Pop-Location
```

The delete command performs one bounded pass. Repeat the same command until it returns `done: true`, then run the preview again. If it returns `{ done: false, deleted: 0 }`, an active plugin run is finishing; wait and retry. The preview returns per-table counts (including `publishCleanupAttempts` and `sourceFileNodes`) plus the distinct known R2 keys; expect nonzero counts before the delete and all-zero after. Claim/secret counts include only claims this name cleanup can delete: claims shared with another plugin name or reclaimed by another user stay for their rightful owner or the later reset-wide repository-id step. An R2 deletion failure aborts the mutation and leaves the owning version or cleanup attempt retryable.

A claim can exist before its manifest reveals a plugin name. After all name-scoped previews are zero, delete each remaining exported claim id with:

```powershell
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:hard_delete_publisher_repository_now '{"repositoryId":"<id>"}'
```

This idempotent mutation deletes that claim and its publisher secrets only. Do not run it before name-scoped cleanup.

## Dev Reset Preserving Clerk Users

For a dev-environment reset where signed-in accounts should keep auth and Polar billing:

1. Confirm the target deployment is not production.
2. Record the reset start time. Enumerate every `users` doc with `data users --format jsonArray --limit 1000`. If the result contains exactly 1000 docs, double the limit until the returned count is below it. Do not infer user ids from auth provider ids. Record the completion time of each successful user/mode invocation.
3. First, for every user with a non-null `clerkUserId`, successfully invoke `users:hard_delete_user_now` with `purgeUserMod: "data"`.
4. Then, for every user without a `clerkUserId`, successfully invoke it with `purgeUserMod: "data_auth_and_user_record"`.
5. Poll `data_deletion_requests` until it is empty. The successful auth-removing calls already enqueue the Workpool. Do not enqueue a second worker while one is queued or running. A manual `data_deletion:enqueue_deletion_requests_processing` call is recovery only after logs and repeated readback show that the queue has stopped and no worker remains.
6. Inspect `hard_delete_user_now` scheduled rows created since the reset started and require no `pending` or `inProgress` continuation. Investigate and retry a failed user/mode pair; a later successful explicit retry resolves that failure when it leaves no later pending or running continuation. Ignore older or superseded failed history. Then verify Clerk-backed user docs and their Clerk/Polar links remain while non-Clerk user docs are gone.

The existing user deletion logic deletes an organization only after its last active user is removed. It preserves shared organizations that still have an active user. Do not add a separate all-users or shared-organization deletion function. Follow `../dev-data-reset/SKILL.md` for plugin cleanup and reseeding.

## Data Readback Via `convex data`

`convex data <table> --limit N` truncates columns to the terminal width, which silently hides ids and long fields. Prefer `--format jsonArray` for exact values. The command returns at most the requested limit and JSON output does not warn when more docs exist, so increase the limit whenever the returned count equals it. Pass CLI help through Vite Plus with `vp env exec -- node node_modules/convex/bin/main.js <command> --help`.

## Verification

Use the smallest readback that proves the requested state:

```powershell
$argsJson = @{ userId = "<users id>" } | ConvertTo-Json -Compress
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable users:get $argsJson
```

Interpret readback carefully:

- A printed user object means the `users` doc still exists.
- Warning-only output with exit code `0` means the function returned `null`; for `users:get`, that means the user doc is missing.
- Nonzero exit code means the verification failed, not that the doc is missing.

For bulk operations, track successes and failures explicitly, then perform a separate readback pass. Treat already-missing docs as idempotent only if the source function does so.

## Environment And Logs

Do not use `convex env get` or `convex env list` in agent workflows because they print secret values. Read non-secret deployment URLs from `packages/app/.env.local`. Confirm reset recovery secrets through a trusted operator channel without copying values into captured output.

Logs remain available through the local CLI:

```powershell
vp env exec node node_modules/convex/bin/main.js logs --history 100 --success
```

When reporting results, summarize which deployment and function were used. Do not paste secrets into the final answer.
