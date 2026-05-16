---
name: troubleshooting
description: Troubleshoot service integrations, async pipelines, and CLI-driven observability flows. Use when Codex needs to inspect recent logs, tail live logs, monitor background work, correlate events across services, verify Convex CLI state, use Cloudflare Wrangler for Workers/R2/Queues, or diagnose webhook, queue, upload, conversion, finalizer, or deployment issues.
---

# Troubleshooting

Use this skill when the task depends on proving what happened across CLIs, logs, queues, webhooks, workers, or database state. Prefer evidence from the control plane and data plane over assumptions from UI state.

## Core Workflow

1. Identify the active environment before debugging.
	- Read local env files for deployment names and service URLs.
	- Use the CLI from the package directory that owns the deployment.
	- Avoid printing secrets unless the task specifically requires checking them; prefer `env get NAME` over broad env dumps.
2. Record a unique marker for each reproduced action.
	- Use a unique filename, request id, message id, or timestamp.
	- Search for that marker in logs and durable state.
3. Check durable state before and after the action.
	- For Convex, inspect the relevant tables with `convex data`.
	- For Cloudflare, inspect queue, notification, deployment, and Worker state with Wrangler.
4. Tail live logs while reproducing.
	- Start the tail before triggering the action.
	- Redirect tail output to a file when using a long-running stream.
	- Stop the tail after enough time has passed for the async path to run.
5. Isolate the failing boundary.
	- If downstream state is missing, manually replay the smallest safe event into the next boundary.
	- If replay succeeds, the failure is upstream of that boundary.
	- If replay fails, debug that boundary directly with logs, response bodies, and durable state.

## Convex CLI

Run Convex commands from the app package directory when the deployment is configured there:

```powershell
Push-Location packages/app
pnpx convex data files_uploads --limit 20 --order desc --format json
Pop-Location
```

Fetch recent logs:

```powershell
pnpx convex logs --history 100 --success
pnpx convex logs --history 100 --jsonl
pnpx convex logs --deployment-name <deployment-name> --history 100 --success
```

If `convex logs` behaves like a stream and does not return promptly, use a bounded shell timeout and fall back to:

```powershell
pnpx convex data <table> --limit 20 --order desc --format json
pnpx convex run --inline-query 'await ctx.db.query("<table>").order("desc").take(10)'
```

Inspect environment deliberately:

```powershell
pnpx convex env get VITE_CONVEX_HTTP_URL
pnpx convex env get CLOUDFLARE_EVENTS_SECRET
pnpx convex env list
```

Use `env list` only when necessary, because it can print secrets. In final answers and issue notes, summarize which variables were present instead of copying secret values.

Manual boundary replay is useful when a queue or webhook should have called a Convex HTTP route but durable state did not change. Use the real object key/request payload from durable state, a unique synthetic message id, and the configured shared secret. Treat replay as a diagnostic mutation: only do it when duplicate handling is expected or when the target route is safe to retry.

## Cloudflare Wrangler

Use `pnpx wrangler`; do not use global Wrangler, `npx`, or package-manager substitutes.

Inspect queue and R2 notification wiring:

```powershell
pnpx wrangler queues info <queue-name>
pnpx wrangler queues info <dead-letter-queue-name>
pnpx wrangler r2 bucket notification list <bucket-name>
pnpx wrangler deployments list --config <path-to-wrangler.jsonc>
```

Tail a Worker interactively:

```powershell
pnpx wrangler tail <worker-name> --format json
pnpx wrangler tail <worker-name> --format json --status error
pnpx wrangler tail <worker-name> --format json --search "<marker>"
```

For a reproducible test, redirect tail output to files and stop it after the async path has had time to run:

```powershell
$out = Join-Path $env:TEMP ("worker-tail-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".out.log")
$err = Join-Path $env:TEMP ("worker-tail-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".err.log")
$tail = Start-Process -FilePath "pnpx" -ArgumentList @("wrangler", "tail", "<worker-name>", "--format", "json") -WorkingDirectory (Get-Location) -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 10
# Trigger the action here.
Start-Sleep -Seconds 30
if (!$tail.HasExited) { Stop-Process -Id $tail.Id -Force }
Get-Content -Path $out
Get-Content -Path $err
```

Set Worker secrets from stdin so values are not typed into an interactive prompt:

```powershell
"https://example.convex.site" | pnpx wrangler secret put CONVEX_HTTP_URL --config packages/r2-upload-finalizer/wrangler.jsonc
$secret | pnpx wrangler secret put EVENTS_SECRET --config packages/r2-upload-finalizer/wrangler.jsonc
```

After changing Worker code or required secrets, deploy before retesting:

```powershell
pnpx wrangler deploy --config packages/r2-upload-finalizer/wrangler.jsonc
```

## What To Log In Silent Workers

If a Worker can acknowledge messages without visible evidence, add narrow operational logs:

```ts
console.warn("Downstream route returned a non-OK response", {
	status: response.status,
	body: responseBody.slice(0, 500),
});

console.log("Processed queue message", {
	messageId: message.id,
	attempts: message.attempts,
	result,
});
```

Keep logs stable and structured. Include ids, attempts, status codes, and short response bodies. Do not log secrets or full signed URLs.

## Debugging Pattern For Event Pipelines

Use this evidence ladder:

1. Producer created the source record or object.
2. Object/event exists in the storage or queue provider.
3. Queue notification rule points to the expected queue.
4. Queue has the expected consumer Worker.
5. Worker tail shows invocation for the marker.
6. Worker logs show downstream route response.
7. Downstream database state changed.
8. UI reflects the durable state.

Do not call a feature verified from UI visibility alone. For async pipelines, require both durable state and user-visible behavior.

## Cursor Terminal Transcripts

When a user-owned terminal is already running dev servers or tails, inspect the transcript before restarting anything. For this repo, Cursor terminal logs are under:

```powershell
C:\Users\rt0\.cursor\projects\c-Users-rt0-Documents-workspace-rt0-t3-chat\terminals
```

Read the most recent terminal files with `Get-Content -Tail`. Use this to confirm whether servers are running, whether a previous CLI is stuck retrying, and which deployment a human configured.
