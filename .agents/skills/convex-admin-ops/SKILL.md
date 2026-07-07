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

Run Convex commands from `packages/app` through Vite Plus and prefer the local PowerShell shim:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec --node 24.16.0 powershell -NoProfile -Command "& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable <module:function> '<json args>'"
Pop-Location
```

Avoid `pnpm exec convex run ...` for JSON args in PowerShell unless you have verified argv first. On this machine, the `pnpm.CMD` path stripped JSON quotes before Convex parsed args. In one nested `vp env exec powershell -Command ...` path, `convex.ps1` also stripped JSON quotes; a direct Node CLI invocation preserved JSON:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable <module:function> '{"userId":"...","purgeUserMod":"data"}'
Pop-Location
```

If the shim reports a JSON parse error such as unquoted keys or values, switch to the direct Node invocation and first verify it with a read-only function.

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

vp env exec --node 24.16.0 powershell -NoProfile -Command "& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable users:hard_delete_user_now '$argsJson'"
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

## Remove A Registered Plugin

Workspace members can uninstall a plugin from its plugin detail page (`plugins.uninstall_version`): that deletes the workspace's event handlers, installation secrets, and installation doc, and keeps event runs/run calls as history. Registry-level removal remains the internal-only admin flow in `packages/app/convex/plugins.ts`. It targets one plugin name and hard-deletes its versions, version reviews, per-version source trees (`/<pluginVersionId>/...` file nodes, chunks, stats, metadata docs, and R2 assets in the reserved GLOBAL/PLUGINS scope), workspace installations (all workspaces and all versions), event handlers, installation secrets, event runs, run calls, the publisher repository claim(s) backing the plugin, and the R2 artifact objects (manifest, artifact, bundled files). Publisher secrets (`plugins_publisher_repository_secrets`) are scoped to one repository claim and cascade with it: deleting a claim deletes its secrets, and the preview counts them as `publisherSecrets`.

Run preview → delete → preview readback from `packages/app`:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:hard_delete_registered_plugin_now '{"pluginName":"<name>"}'
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable plugins:preview_hard_delete_registered_plugin '{"pluginName":"<name>"}'
Pop-Location
```

The preview returns per-table counts (including `sourceFileNodes`, the reserved-scope file nodes across the plugin's version trees) plus the number of R2 artifact keys; expect nonzero counts before the delete and all-zero after. `hard_delete_registered_plugin_now` throws if an unusually large plugin exhausts its batch budget; rerun it until the preview readback is all-zero. R2 object deletion is best effort: individual failures are logged and do not block the registry delete. The hard delete sweeps each version's GLOBAL/PLUGINS source tree before deleting the version doc, so registry removal leaves no orphan reserved-scope file rows.

## Dev Reset Preserving Clerk Users

For a dev-environment reset where signed-in accounts should keep auth and Polar billing:

1. Confirm the target deployment is not production.
2. Enumerate `users` docs with a read-only admin path or Convex data read after confirming the available source/API. Do not infer user ids from auth provider ids.
3. For every user with a non-null `clerkUserId`, run `users:hard_delete_user_now` with `purgeUserMod: "data"`. This deletes app/tenant content while preserving the `users` doc, Clerk/anonymous auth state, anagraphic/profile, billing/customer state, and a usable default tenant.
4. For every user without a `clerkUserId`, run `users:hard_delete_user_now` with `purgeUserMod: "data_auth_and_user_record"`. This removes disposable anonymous/local user data, auth state, billing state, and the final local user doc.
5. Verify with a separate readback pass: Clerk-backed user ids should still return user docs, non-Clerk user ids should return `null`, preserved user docs should still have their Clerk id, and reset-owned tenant content should be gone.
6. Expired `public_api_grants` docs are normally removed by the daily Convex cron via `public_api:cleanup_expired_grants_until_done`. If an older deployment or interrupted reset leaves a backlog, run that function with `{}` and read back the table again. Use `public_api:cleanup_expired_grants` only when you intentionally want one bounded batch. Both functions delete only grants whose `expiresAt` is already in the past.

Do not use `"data_auth_and_user_record"` for Clerk-backed users unless the user explicitly wants to destroy the local account and billing identity.

Reset gotchas observed on this deployment:

- Organization deletion is queued through `data_deletion_requests` and drained by `data_deletion:run_process_deletion_requests_once`. If a readback shows orphan organizations lingering after user purges and the table still has rows, run that function manually (repeat until it returns `shouldReschedule: false` and the table is empty) instead of re-deleting users.
- Plugin publishes materialize version-keyed source trees under the virtual global tenant (`organizations_GLOBAL_ORGANIZATION_ID` "GLOBAL" / `organizations_GLOBAL_PLUGINS_WORKSPACE_ID` "PLUGINS") at `/<pluginVersionId>/...`. User/tenant purges do not touch them, but `plugins:hard_delete_registered_plugin_now` sweeps each version's tree, so a registry wipe leaves no orphans. If a version doc was ever deleted outside that flow, drain the leftover tree with `plugins:delete_plugin_source_tree_batch` (`{"pluginVersionId":"<id>"}`, rerun until `done: true`) and verify with a count over `files_nodes.by_organization_workspace_treePath` for GLOBAL/PLUGINS.
- For staged wipes, deploy a temporary `admin_wipe.ts` module with a read-only preview (counts per table + per-user summary) and bounded batch deletes; run preview → writes → preview readback, then delete the module and redeploy so the admin surface does not linger.

## Data Readback Via `convex data`

`convex data <table> --limit N` truncates columns to the terminal width, which silently hides ids and long fields. Pipe through `Out-String -Width 500` (PowerShell) or read a small `--limit` before drawing conclusions. `--help` cannot be reached through `vp env exec` (vp swallows the flag); consult the Convex docs instead.

## Verification

Use the smallest readback that proves the requested state:

```powershell
$argsJson = @{ userId = "<users id>" } | ConvertTo-Json -Compress
& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable users:get $argsJson
```

Interpret readback carefully:

- A printed user object means the `users` doc still exists.
- Warning-only output with exit code `0` means the function returned `null`; for `users:get`, that means the user doc is missing.
- Nonzero exit code means the verification failed, not that the doc is missing.

For bulk operations, track successes and failures explicitly, then perform a separate readback pass. Treat already-missing docs as idempotent only if the source function does so.

## Environment And Logs

Avoid broad `convex env list` unless necessary because it can print secrets. Prefer:

```powershell
& .\node_modules\.bin\convex.ps1 env get VITE_CONVEX_HTTP_URL
& .\node_modules\.bin\convex.ps1 logs --history 100 --success
```

When reporting results, summarize which deployment and function were used. Do not paste secrets into the final answer.
