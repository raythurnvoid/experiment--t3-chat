---
name: perf-profiling
description: How to correctly measure and profile latency in Convex functions and in web apps driven through Playwriter/CDP. Load this BEFORE measuring "why is X slow", profiling a Convex mutation/query, timing UI interactions, or capturing CPU profiles. It prevents known measurement traps (frozen Date.now in Convex, module-eval cost hiding in userExecutionTime, throttled backgrounded tabs, React DevTools polluting profiles, dev-build overhead).
---

# Measure Convex And Browser Latency Separately

Use the relevant half before measuring Convex or browser latency. To drive the live app in the browser, also load `app-playwriter-harness`.

# Convex Functions

## Facts That Change How You Measure

- `Date.now()` is FROZEN for the whole execution of a query/mutation (determinism). Inline `Date.now()` deltas always read 0. Docs: https://docs.convex.dev/functions/runtimes
- `console.time` / `console.timeLog` / `console.timeEnd` use Convex's non-deterministic runtime clock and can measure phases without exposing time to deterministic function code.
- When Convex builds a fresh context, module evaluation is included in user execution time. A heavy static import graph can dominate a small handler. Compare a lean probe with one suspect import before changing handler logic.
- Convex must discover a function's dependencies at bundle time. Do not use runtime-resolved dynamic dependencies in the default V8 runtime. A literal `import()` may still be bundled, so do not assume it defers module evaluation. Split heavy code into separate function modules when import cost is the problem. Docs: https://docs.convex.dev/functions/bundling
- Many current query and mutation modules export `experimental_reuseContext = true`. This can let an eligible successful call reuse a context from the same module when its saved reads are still valid, so warm samples may skip module evaluation. Reuse is not guaranteed and does not apply to actions or HTTP actions. Never keep mutable module-level state in these modules. Treat the flag as current repo behavior to verify against the bundled Convex source, not as a default optimization; prefer splitting heavy modules before adding it elsewhere.

## Procedure

1. Get real per-execution numbers without changing code. Use the bounded Convex log-capture workflow in `.agents/skills/troubleshooting/SKILL.md` so the live stream is handled correctly in PowerShell. JSONL `executionTime` and `userExecutionTime` are in seconds; `userExecutionTime` includes user code and module evaluation. `usageStats` reports read/write bytes, docs read, storage/index/network usage, and memory, but not a docs-written count. The human log line rounds `executionTime` to milliseconds. `caller: "SyncWorker"` marks real client-driven executions.
2. Check module tax: deploy a noop `internalMutation` in a new lean file (imports only `./_generated/server.js` + `convex/values`) and a noop that imports one symbol from the suspect module (reference it with `void theImport;` so bundling keeps it). Run each about six times with `vp env exec pnpm --dir packages/app exec convex run`, then compare them. A large gap means the module should be split. Use one probe module per suspect import; if several probes share one file, every probe pays the union of all imports, including the control. Capture timings with the troubleshooting skill's bounded `convex logs` workflow and compare `identifier` and `executionTime`.
3. Phase-time the handler with `console.time("phase")` / `console.timeEnd("phase")` around each await. Output appears in `convex logs` log lines.
4. Dashboard per-function p50/p90/p95/p99 charts exist for trends; no in-function breakdown.

## Traps

- In this repo, run Convex CLI commands through Vite Plus with an explicit app package directory: `vp env exec pnpm --dir packages/app exec convex ...`. The repo root `.env.local` may point at a local backend that is not running.
- Rate-limiter probes consume real tokens. Read the current limiter configuration before a probe and use a throwaway key for that run, never a real user key.
- Probe mutations that insert data should delete it in the same transaction (net no-op).
- Dev deployments are noisy; take ≥5-7 samples per variant, interleave variants round-robin, compare medians.
- Server exec time is only one leg. The client perceives: WS round trip + mutation exec + subscription update pushed to the client + client render. Capture Convex WS frames (CDP `Network.webSocketFrameSent/Received`) to split those legs.
- Before comparing numbers across dependency versions, verify what actually resolves with `vp env exec pnpm --dir packages/app exec node -p "require('<pkg>/package.json').version"`. A pnpm-workspace `overrides:` entry can pin the whole workspace regardless of package.json ranges.

# Browser And UI Latency With Playwriter And CDP

## Facts That Change How You Measure

- Do not measure an interaction by timing around Playwright waits. That duration can include relay, polling, actionability, and background-tab delays. Capture the start and completion inside the page with event listeners, `MutationObserver`, and `performance.now()`. `waitForFunction` uses `requestAnimationFrame` polling by default; pass a numeric `polling` interval when you need controlled completion polling, and do not treat the wait duration as the product latency.
- The React DevTools extension pollutes CPU profiles and slows commits: its hook walks every fiber on commit (`measureHostInstance` — shows up as huge `get scrollX` self time). Neutralize before measuring: `page.addInitScript` a stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` ({isDisabled:true, inject:()=>0, onCommitFiberRoot(){} ...}), then reload.
- React dev builds add large overhead that vanishes in prod: `jsxDEV` element creation, `createTask` stack tracking, StrictMode double-render. Before optimizing a "slow render", check how much of the profile is `react_jsx-dev-runtime` / dev-only frames — and re-measure on a prod build before writing code.

## Procedure

Ready-to-use scripts live in `scripts/` next to this file:

- `scripts/neutralize-react-devtools.js` — stub the DevTools hook + reload (run first, generic).
- `scripts/ui-latency-rig-example.js` — in-page timing rig template (adapt the `ADAPT:` marks).
- `scripts/cpu-profile-example.js` — CDP Profiler around one interaction (template).
- `scripts/analyze-cpu-profile.mjs` — `vp env exec node .agents/skills/perf-profiling/scripts/analyze-cpu-profile.mjs file.cpuprofile` → self time per function/file.

1. In-page timing rig: patch `WebSocket.prototype.send` to timestamp outgoing mutations; a `MutationObserver` timestamps when the awaited DOM state appears; CDP `Network.webSocketFrame*` events (monotonic seconds) time the network legs. Align the CDP clock with `performance.now()` via the shared send event. Call `await state.cleanupLatencyRig()` after reading the result so the template restores the WebSocket method and removes its page and CDP listeners.
2. CPU profile via CDP: create a dated personal AI folder first and assign an absolute `.cpuprofile` path there to `state.perfProfilePath`. The CPU template first cleans up an earlier latency rig, then creates and detaches its own CDP session. It runs `Profiler.enable` → `setSamplingInterval {interval:100}` → `Profiler.start` → the interaction → `Profiler.stop`. The template serializes the profile through a browser download and saves it with `download.saveAs(...)`, which avoids sandboxed filesystem limits. Analyze self time from `nodes` + `samples` + `timeDeltas`. To attribute a native getter such as `get scrollX`, build a reverse parent map from every node's `children`, then walk parent ids from the hot node to its calling frames.
3. Attribute before optimizing: remove extension and dev-build overhead, then optimize only app frames that remain hot.
4. Use a dedicated fresh tab for measurements and close it after — never instrument the user's tab (they may navigate and wipe the rig mid-run).
