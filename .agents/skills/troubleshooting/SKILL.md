---
name: troubleshooting
description: Troubleshoot service integrations, async pipelines, and CLI-driven observability flows. Use when Codex needs to inspect recent logs, tail live logs, monitor background work, correlate events across services, verify Convex CLI state, use Cloudflare Wrangler for Workers/R2/Queues, or diagnose webhook, queue, upload, conversion, finalizer, or deployment issues.
---

# Prove Each Boundary With Durable Evidence

Prefer evidence from the control plane and data plane over assumptions from UI state.

# Core Workflow

1. Identify the active environment before debugging.
	- Read only the named deployment and service fields you need from local env files. Never print a complete environment file.
	- Use the CLI from the package directory that owns the deployment.
	- Confirm secret presence without printing values. Never put a secret literal in a command, script, captured transcript, or report.
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

# Convex CLI

For any command against a live Convex deployment, also load `.agents/skills/convex-admin-ops/SKILL.md`. Its deployment targeting, secret handling, destructive-operation gates, and readback rules take precedence.

Replace every `<...>` token in the command examples before running it. Raw placeholders are documentation syntax, not valid PowerShell arguments.

Run the repo-pinned Convex CLI with an explicit app package directory:

```powershell
vp env exec pnpm --dir packages/app exec convex data files_r2_assets --limit 20 --order desc --format json
```

Fetch recent logs:

```powershell
vp env exec pnpm --dir packages/app exec convex logs --history 100 --success
vp env exec pnpm --dir packages/app exec convex logs --history 100 --jsonl
vp env exec pnpm --dir packages/app exec convex logs --deployment "<deployment-name>" --history 100 --success
```

`convex logs` is a live stream. In this PowerShell environment, a logs pipeline may not flush promptly. Capture stdout and stderr from a background process, wait for the needed window, stop that process, and then search both files for the unique marker. Do not print the complete captures:

```powershell
$runStamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$marker = "<unique-marker>"
$logDirectory = "../t3-chat-+personal/+ai/troubleshooting-$runStamp"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stdoutPath = Join-Path $logDirectory "convex-logs.out.jsonl"
$stderrPath = Join-Path $logDirectory "convex-logs.err.log"
function ConvertTo-RedactedLogLine {
	param([Parameter(ValueFromPipeline)][string]$Line)

	process {
		$Line `
			-replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]' `
			-replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[JWT REDACTED]' `
			-replace '(?i)"?(authorization|cookie|token|secret|password)"?\s*[:=]\s*"[^"]*"', '"$1":"[REDACTED]"' `
			-replace '(?i)\b(authorization|cookie|token|secret|password)\b\s*[:=]\s*\S+', '$1=[REDACTED]' `
			-replace '(https?://[^?\s]+)\?\S+', '$1?[QUERY REDACTED]'
	}
}
function Write-RedactedLogTail([string]$Path) {
	Get-Content -LiteralPath $Path -Tail 20 | ConvertTo-RedactedLogLine
}
$vpExecutable = (Get-Command vp -ErrorAction Stop).Source
$convexLogProcess = Start-Process -FilePath $vpExecutable -ArgumentList @(
	"env", "exec", "pnpm", "--dir", "packages/app", "exec",
	"convex", "logs", "--history", "300", "--jsonl"
) -WorkingDirectory (Get-Location) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 10
$convexExitedBeforeStop = $convexLogProcess.HasExited
if (!$convexExitedBeforeStop) { & taskkill.exe /PID $convexLogProcess.Id /T /F | Out-Null }
$stdoutMatches = @(Select-String -LiteralPath $stdoutPath -SimpleMatch -Pattern $marker)
$stderrMatches = @(Select-String -LiteralPath $stderrPath -SimpleMatch -Pattern $marker)
$stdoutMatches | Select-Object Path, LineNumber
$stderrMatches | Select-Object Path, LineNumber
if (($convexExitedBeforeStop -and $convexLogProcess.ExitCode -ne 0) -or ($stdoutMatches.Count -eq 0 -and $stderrMatches.Count -eq 0)) {
	Write-RedactedLogTail -Path $stderrPath
}
```

If the sandbox blocks the personal AI folder, request approval. Do not fall back to the repo or the OS temp directory.

If a background process is unavailable, skip the live stream. Use bounded one-shot `data` or `run` calls to inspect durable state before and after the action:

```powershell
vp env exec pnpm --dir packages/app exec convex data "<table>" --limit 20 --order desc --format json
vp env exec pnpm --dir packages/app exec convex run --inline-query 'await ctx.db.query("<table>").order("desc").take(10)'
```

Manual boundary replay is useful when a queue or webhook should have called a Convex HTTP route but durable state did not change. Use the real object key/request payload from durable state, a unique synthetic message id, and the configured shared secret. Treat replay as a diagnostic mutation: only do it when duplicate handling is expected or when the target route is safe to retry.

Search captured logs for the unique marker instead of pasting whole files into chat or reports. The normal path prints only matching file paths and line numbers. If line content is needed, extract only known safe fields or a narrow excerpt after redaction; do not print the whole `MatchInfo.Line`. The bounded-tail helper above catches common credential shapes when startup fails or no marker appears; it is not a complete privacy filter. Review those 20 lines and remove signed URLs, private user content, and unrelated terminal commands before sharing any excerpt.

# Convex HTTP Action Latency

Load `.agents/skills/perf-profiling/SKILL.md` before measuring latency. It owns the sampling, module-import probe, and browser/CDP procedures. Use the bounded Convex log-capture workflow above for its server measurements.

For an HTTP route, use this short checklist:

1. Measure the current deployment. Do not reuse an old network floor, curl behavior, or dev/prod number. Take at least 5–7 interleaved samples per variant and compare medians.
2. Split the client round trip from Convex `executionTime` and `userExecutionTime`. `userExecutionTime` includes module evaluation. If a trivial function is slow, inspect its static import graph before changing handler logic.
3. Inside Convex queries and mutations, `Date.now()` is frozen for the execution and cannot measure phases. Use `console.time`, `console.timeLog`, and `console.timeEnd`. Use external timing or log timestamps for the whole HTTP round trip.
4. Count separate `ctx.runQuery` and `ctx.runMutation` calls and mark which ones are awaited in series. Serial dispatches add hop latency, but query work, module evaluation, and contention also matter.
5. Treat rate-limiter calls as a possible contention point. The current configs in `packages/app/convex/rate_limiter.ts` do not set `shards`, so calls with the same limiter name and key target one rate-limit doc and may serialize or OCC-retry under bursts. Re-check this statement if the app config adds shards.
6. Convex can reuse a query result only when the function and arguments stay the same, so passing a changing timestamp creates a new cache key on each call. Keep current-time verdicts action-side; liveness writes invalidate the stable `resolve_principal` fact query used by `public_api_resolve_live_principal` in `packages/app/convex/public_api.ts`.
7. Treat completion waves as a hypothesis. Confirm them against current client concurrency, server log samples, and the handler's serial calls.

Re-measure on the target deployment and build before optimizing.

# Cloudflare Wrangler

Use `vp env exec pnpx wrangler`; do not use global Wrangler, `npx`, or package-manager substitutes.

Replace every `<...>` token in the command examples before running it.

Inspect queue and R2 notification wiring:

```powershell
vp env exec pnpx wrangler queues info "<queue-name>"
vp env exec pnpx wrangler queues info "<dead-letter-queue-name>"
vp env exec pnpx wrangler r2 bucket notification list "<bucket-name>"
vp env exec pnpx wrangler deployments list --config "<path-to-wrangler.jsonc>"
```

Tail a Worker interactively:

```powershell
vp env exec pnpx wrangler tail "<worker-name>" --format json
vp env exec pnpx wrangler tail "<worker-name>" --format json --status error
vp env exec pnpx wrangler tail "<worker-name>" --format json --search "<marker>"
```

Worker tail can sample or drop events at high volume. A missing tail line is not proof that an event never ran; use durable state or Workers Logs when completeness matters.

For a reproducible test, redirect tail output to files and stop it after the async path has had time to run:

```powershell
$runStamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$marker = "<unique-marker>"
$tailDirectory = "../t3-chat-+personal/+ai/troubleshooting-$runStamp"
New-Item -ItemType Directory -Force -Path $tailDirectory | Out-Null
$out = Join-Path $tailDirectory ("worker-tail-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".out.log")
$err = Join-Path $tailDirectory ("worker-tail-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ".err.log")
function ConvertTo-RedactedLogLine {
	param([Parameter(ValueFromPipeline)][string]$Line)

	process {
		$Line `
			-replace '(?i)Bearer\s+\S+', 'Bearer [REDACTED]' `
			-replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[JWT REDACTED]' `
			-replace '(?i)"?(authorization|cookie|token|secret|password)"?\s*[:=]\s*"[^"]*"', '"$1":"[REDACTED]"' `
			-replace '(?i)\b(authorization|cookie|token|secret|password)\b\s*[:=]\s*\S+', '$1=[REDACTED]' `
			-replace '(https?://[^?\s]+)\?\S+', '$1?[QUERY REDACTED]'
	}
}
function Write-RedactedLogTail([string]$Path) {
	Get-Content -LiteralPath $Path -Tail 20 | ConvertTo-RedactedLogLine
}
$vpExecutable = (Get-Command vp -ErrorAction Stop).Source
$tail = Start-Process -FilePath $vpExecutable -ArgumentList @("env", "exec", "pnpx", "wrangler", "tail", "<worker-name>", "--format", "json", "--search", $marker) -WorkingDirectory (Get-Location) -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 10
# Trigger the action here.
Start-Sleep -Seconds 30
$tailExitedBeforeStop = $tail.HasExited
if (!$tailExitedBeforeStop) { & taskkill.exe /PID $tail.Id /T /F | Out-Null }
$outMatches = @(Select-String -LiteralPath $out -SimpleMatch -Pattern $marker)
$errMatches = @(Select-String -LiteralPath $err -SimpleMatch -Pattern $marker)
$outMatches | Select-Object Path, LineNumber
$errMatches | Select-Object Path, LineNumber
if (($tailExitedBeforeStop -and $tail.ExitCode -ne 0) -or ($outMatches.Count -eq 0 -and $errMatches.Count -eq 0)) {
	Write-RedactedLogTail -Path $err
}
```

If the sandbox blocks the personal AI folder, request approval. Do not fall back to the repo or the OS temp directory.

Use Wrangler's hidden interactive prompt when a secret is not already available through an approved process environment variable:

```powershell
vp env exec pnpx wrangler secret put CONVEX_HTTP_URL --config packages/r2-upload-finalizer/wrangler.jsonc
vp env exec pnpx wrangler secret put EVENTS_SECRET --config packages/r2-upload-finalizer/wrangler.jsonc
```

For agent automation, pipe an existing approved process environment variable directly to Wrangler without printing or copying it. Otherwise, stop and ask the user to run the interactive command or provide the value through an approved secure channel. Do not retrieve it from Convex, a browser page, or logs.

`wrangler secret put` immediately deploys a new Worker version. Do not run a second deploy only for that secret change. After changing Worker code, deploy before retesting:

```powershell
vp env exec pnpx wrangler deploy --config packages/r2-upload-finalizer/wrangler.jsonc
```

# What To Log In Silent Workers

If a Worker can acknowledge messages without visible evidence, add narrow operational logs:

```ts
console.warn("Downstream route returned a non-OK response", {
	status: response.status,
	responseLength: responseBody.length,
});

console.log("Processed queue message", {
	messageId: message.id,
	attempts: message.attempts,
	result,
});
```

Keep logs stable and structured. Include ids, attempts, status codes, and response sizes. Include a short body preview only after redacting secrets, signed URLs, tokens, and private user content.

# Debugging Pattern For Event Pipelines

Use this evidence ladder:

1. Producer created the source record or object.
2. Object/event exists in the storage or queue provider.
3. Queue notification rule points to the expected queue.
4. Queue has the expected consumer Worker.
5. Worker tail shows invocation for the marker.
6. Worker logs show downstream route response.
7. Downstream database state changed.
8. For a user-facing pipeline, the UI reflects the durable state. For a headless pipeline, verify the final downstream response or stored state instead.

Do not verify a feature from UI visibility alone. For a user-facing async pipeline, require both durable state and user-visible behavior. For a headless pipeline, require durable final state or a verified downstream response.

# Cursor Terminal Transcripts

When a user-owned terminal is already running dev servers or tails, inspect the transcript before restarting anything. For this repo, Cursor terminal logs are under:

```powershell
C:\Users\rt0\.cursor\projects\c-Users-rt0-Documents-workspace-rt0-t3-chat\terminals
```

Read the most recent terminal files with `Get-Content -Tail`. Use this to confirm whether servers are running, whether a previous CLI is stuck retrying, and which deployment a human configured. Search for the task marker and quote only the needed lines. Redact secrets, tokens, signed URLs, private content, and unrelated user commands.
