---
name: perf-profiling
description: How to correctly measure and profile latency in Convex functions and in web apps driven through Playwriter/CDP. Load this BEFORE measuring "why is X slow", profiling a Convex mutation/query, timing UI interactions, or capturing CPU profiles. It prevents known measurement traps (frozen Date.now in Convex, module-eval cost hiding in userExecutionTime, throttled backgrounded tabs, React DevTools polluting profiles, dev-build overhead).
---

# Performance profiling: Convex + browser

Lessons learned measuring folder-create latency in this repo (2026-07-15). Two halves: server (Convex) and client (browser). Read the half you need. To drive the live app in the browser, also load `app-playwriter-harness`.

## Convex functions

### Facts that change how you measure

- `Date.now()` is FROZEN for the whole execution of a query/mutation (determinism). Inline `Date.now()` deltas always read 0. Docs: https://docs.convex.dev/functions/runtimes
- `console.time` / `console.timeLog` / `console.timeEnd` DO use a real clock inside that same runtime. This is the correct inline phase-timing tool. Verified: a `ctx.db.get` showed `2ms`, a 5M-iteration loop `7ms`.
- **Module evaluation is billed to the function's execution time on every invocation.** A noop mutation in a lean module runs in 4-6 ms; the same noop importing one symbol from a heavy module (tiptap/yjs/ai-sdk import graph) runs in 180-280 ms. If a trivial mutation looks slow, suspect its module's import graph FIRST, before touching handler code.
- Convex bundles everything a module statically imports. Dynamic `import()` is NOT supported in the default V8 runtime, so the fix for module tax is splitting files, not lazy imports. Docs: https://docs.convex.dev/functions/bundling
- Second fix option (verified on cloud dev, 2026-07-15): `export const experimental_reuseContext = true;` at module level makes the backend reuse the V8 context across invocations (469 ms cold → 3 ms warm). It is experimental and undocumented (read from convex-backend source: `crates/isolate/src/context_cache.rs`, `environment/analyze.rs`). Prefer file splitting for shipped code; keep this for modules too tangled to split.

### Procedure

1. Get real per-execution numbers, no code changes:
   ```bash
   timeout 30 pnpx convex logs --success --history 200 --jsonl > logs.jsonl; true
   ```
   `convex logs` STREAMS FOREVER after printing history — bound it with `timeout` and parse the file. Do not pipe it through `grep` in a background task: the pipe buffers and the output file stays empty. Each event has `executionTime`, `userExecutionTime` (user code INCLUDING module eval), and `usageStats` (db read/write bytes + document counts). The plain-log line "Function executed in N ms" is `executionTime`. `caller: "SyncWorker"` marks real client-driven executions.
2. Check module tax: deploy a noop `internalMutation` in a new lean file (imports only `./_generated/server.js` + `convex/values`) and a noop that imports one symbol from the suspect module (reference it with `void theImport;` so bundling keeps it). Run each ~6 times with `pnpx convex run`, compare. Big gap = split the module. IMPORTANT: one probe MODULE per suspect import — if several probes share one file, every probe pays the union of all imports (including the control). Parse timings from `pnpx convex logs --success --history N --jsonl` (field `identifier`, `executionTime` in seconds); the logs command streams forever, so wrap it in `timeout N ... > file`.
3. Phase-time the handler with `console.time("phase")` / `console.timeEnd("phase")` around each await. Output appears in `convex logs` log lines.
4. Dashboard per-function p50/p90/p95/p99 charts exist for trends; no in-function breakdown.

### Traps

- In this repo, run all convex CLI commands from `packages/app` — the repo ROOT `.env.local` points at a local backend that is usually not running ("Local backend isn't running" error means wrong cwd).
- Rate-limiter probes consume real tokens (e.g. `files_tree_write` bucket has capacity 2). Use a throwaway key per probe run, never the real user key.
- Probe mutations that insert data should delete it in the same transaction (net no-op).
- Dev deployments are noisy; take ≥5-7 samples per variant, interleave variants round-robin, compare medians.
- Server exec time is only one leg. The client perceives: WS round trip + mutation exec + subscription Transition push + client render. Capture Convex WS frames (CDP `Network.webSocketFrameSent/Received`) to split those legs.
- Before comparing numbers across dependency versions, verify what actually resolves: `node -p "require('<pkg>/package.json').version"` from the app package. A pnpm-workspace `overrides:` entry silently pins the whole workspace regardless of package.json ranges.

## Browser / UI latency (Playwriter, CDP)

### Facts that change how you measure

- On backgrounded tabs, Playwright waits (`waitFor`, `waitForSelector`) poll via rAF, which Chromium throttles — Node-side timing around them overstates real latency by seconds. Measure IN-PAGE instead: capture-phase event listeners + `MutationObserver` recording `performance.now()` (neither is throttled).
- The React DevTools extension pollutes CPU profiles and slows commits: its hook walks every fiber on commit (`measureHostInstance` — shows up as huge `get scrollX` self time). Neutralize before measuring: `page.addInitScript` a stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` ({isDisabled:true, inject:()=>0, onCommitFiberRoot(){} ...}), then reload.
- React dev builds add large overhead that vanishes in prod: `jsxDEV` element creation, `createTask` stack tracking, StrictMode double-render. Before optimizing a "slow render", check how much of the profile is `react_jsx-dev-runtime` / dev-only frames — and re-measure on a prod build before writing code.

### Procedure

Ready-to-use scripts live in `scripts/` next to this file:

- `scripts/neutralize-react-devtools.js` — stub the DevTools hook + reload (run first, generic).
- `scripts/ui-latency-rig-example.js` — in-page timing rig template (adapt the `ADAPT:` marks).
- `scripts/cpu-profile-example.js` — CDP Profiler around one interaction (template).
- `scripts/analyze-cpu-profile.mjs` — `node analyze-cpu-profile.mjs file.cpuprofile` → self time per function/file.

1. In-page timing rig: patch `WebSocket.prototype.send` to timestamp outgoing mutations; a `MutationObserver` timestamps when the awaited DOM state appears; CDP `Network.webSocketFrame*` events (monotonic seconds) time the network legs. Align the CDP clock with `performance.now()` via the shared send event.
2. CPU profile via CDP: `Profiler.enable` → `setSamplingInterval {interval:100}` → `Profiler.start` → do the interaction → `Profiler.stop`. Analyze self time from `nodes` + `samples` + `timeDeltas`; attribute native getters (like `get scrollX`) by walking `children` parent links to the calling frames.
3. Attribute before optimizing: separate (a) extension overhead, (b) dev-build overhead, (c) actual app code. In the measured case app code was ~30 ms of a "300 ms" render leg.
4. Use a dedicated fresh tab for measurements and close it after — never instrument the user's tab (they may navigate and wipe the rig mid-run).

See memory `folder-create-latency-baseline` for the concrete numbers behind these rules.
