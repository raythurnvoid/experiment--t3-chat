---
name: convex-admin-ops
description: Run live Convex admin/operational CLI tasks safely in this repo, especially destructive internal functions, one-off data cleanup, user hard deletion, environment/deployment checks, and targeted readback verification. Use when Codex needs to run `convex run`, `convex data`, `convex logs`, or similar Convex CLI operations against dev, preview, or production deployments.
---

# Convex Admin Ops

Use this skill for live Convex control-plane or data-plane operations. Also load the domain skill for the behavior being changed or invoked, such as `convex`, `auth-system`, `workspaces-tenancy`, or `billing-system`.

## Safety Workflow

1. Identify the target deployment before running a write.
	- In this repo, deployment env lives under `packages/app`.
	- Read `packages/app/.env.local` for `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, and `VITE_CONVEX_HTTP_URL`.
	- Default to the configured dev deployment. Use `--prod`, `--preview-name`, or `--deployment-name` only when the user explicitly requests that target.
2. Confirm the function signature from source before constructing args.
	- Prefer `rg` first, then read the function registration and nearby tests.
	- For destructive account operations, read the relevant auth/data-deletion skill sections.
3. State the function, deployment, and destructive mode before the write.
4. Run the smallest targeted command.
5. Verify durable state with a readback command after the write.

## Windows CLI Invocation

Run Convex commands from `packages/app` and prefer the local PowerShell shim:

```powershell
Push-Location C:\Users\rt0\Documents\workspace\rt0\t3-chat\packages\app
& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable <module:function> '<json args>'
Pop-Location
```

Avoid `pnpm exec convex run ...` for JSON args in PowerShell unless you have verified argv first. On this machine, the `pnpm.CMD` path stripped JSON quotes before Convex parsed args. The local `convex.ps1` shim preserved JSON args correctly.

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

& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable users:hard_delete_user_now $argsJson
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

- `"data"`: hard-delete/reset app data while keeping the account live; preserve the `users` row, Clerk and anonymous auth state, profile, billing/customer state, and a usable default tenant.
- `"data_and_auth"`: delete tenant/user data and auth state, attempt Clerk deletion, remove anonymous auth tokens, keep the final tombstoned `users` row, and schedule period-end subscription cancellation when applicable. This is true cleanup cancellation, not the normal billing-panel cancellation flow that downgrades a live user to `Free`.
- `"data_auth_and_user_record"`: delete tenant/user data and auth state, revoke/delete billing state immediately, and purge the final local `users` row. This is the only routine admin path that should immediately revoke/delete billing instead of preserving or downgrading the account.

Use `"data"` when the user wants to wipe app data while keeping the account usable. Use `"data_and_auth"` for account deletion that keeps the final tombstone. Use `"data_auth_and_user_record"` only when the user explicitly wants the final user record purged too.

## Verification

Use the smallest readback that proves the requested state:

```powershell
$argsJson = @{ userId = "<users id>" } | ConvertTo-Json -Compress
& .\node_modules\.bin\convex.ps1 run --typecheck disable --codegen disable users:get $argsJson
```

Interpret readback carefully:

- A printed user object means the `users` row still exists.
- Warning-only output with exit code `0` means the function returned `null`; for `users:get`, that means the user row is missing.
- Nonzero exit code means the verification failed, not that the row is missing.

For bulk operations, track successes and failures explicitly, then perform a separate readback pass. Treat already-missing rows as idempotent only if the source function does so.

## Environment And Logs

Avoid broad `convex env list` unless necessary because it can print secrets. Prefer:

```powershell
& .\node_modules\.bin\convex.ps1 env get VITE_CONVEX_HTTP_URL
& .\node_modules\.bin\convex.ps1 logs --history 100 --success
```

When reporting results, summarize which deployment and function were used. Do not paste secrets into the final answer.
