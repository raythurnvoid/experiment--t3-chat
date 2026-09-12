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
- A WebSocket `message` listener added after the app's listener can run after the app has already rendered. Its timestamp is not the network arrival time. Use CDP for arrival and match the exact query id and frame size. With several tabs, keep each tab's frame array separate and remove its handlers before detaching CDP.
- A CPU profile also includes time spent waiting for automation commands. For interaction totals, trim samples to the in-page click and completion times, using the outgoing WebSocket frame to align the clocks. Report the row appearing, rename focus, and next animation frame separately; DOM changes do not prove a paint has happened.
- The React DevTools extension pollutes CPU profiles and slows commits: its hook walks every fiber on commit (`measureHostInstance` — shows up as huge `get scrollX` self time). Neutralize before measuring: `page.addInitScript` a stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` ({isDisabled:true, inject:()=>0, onCommitFiberRoot(){} ...}), then reload.
- React dev builds add overhead from `jsxDEV` element creation, `createTask` stack tracking, and StrictMode double-render. Normally compare production too. When the task targets dev performance, keep the dev build and its checks enabled and reduce repeated app work.
- React 19 dev builds emit component timing measures. Group `performance.getEntriesByType("measure")` by name inside the interaction window to compare render counts and durations. Parent durations include children; do not add them together. A disabled DevTools hook does not disable these built-in tracks.
- Compare the same viewport, sidebar width, loaded node count, and starting view. Leaving an editor adds work that an empty folder view does not. Record mounted rows too. Keep tests, builds, HMR updates, and other CPU work out of timing runs; repeat the final comparison without the CPU profiler.

## Procedure

Ready-to-use scripts live in `scripts/` next to this file:

- `scripts/neutralize-react-devtools.js` — stub the DevTools hook + reload (run first, generic).
- `scripts/ui-latency-rig-example.js` — in-page timing rig template (adapt the `ADAPT:` marks).
- `scripts/cpu-profile-example.js` — CDP Profiler around one interaction (template).
- `scripts/analyze-cpu-profile.mjs` — `vp env exec node .agents/skills/perf-profiling/scripts/analyze-cpu-profile.mjs file.cpuprofile` → self time per function/file.

1. In-page timing rig: patch `WebSocket.prototype.send` to timestamp outgoing mutations; a `MutationObserver` timestamps when the awaited DOM state appears; CDP `Network.webSocketFrame*` events (monotonic seconds) time the network legs. Align the CDP clock with `performance.now()` via the shared send event. Call `await state.cleanupLatencyRig()` after reading the result so the template restores the WebSocket method and removes its page and CDP listeners.
2. CPU profile via CDP: create a dated personal AI folder first and assign an absolute `.cpuprofile` path there to `state.perfProfilePath`. The CPU template first cleans up an earlier latency rig, then creates and detaches its own CDP session. It runs `Profiler.enable` → `setSamplingInterval {interval:100}` → `Profiler.start` → the interaction → `Profiler.stop`. The template serializes the profile through a browser download and saves it with `download.saveAs(...)`, which avoids sandboxed filesystem limits. Analyze self time from `nodes` + `samples` + `timeDeltas`. To attribute a native getter such as `get scrollX`, build a reverse parent map from every node's `children`, then walk parent ids from the hot node to its calling frames.
3. Attribute before optimizing: remove extension overhead, separate dev-only costs, then test changes in the build the task targets. Keep both timing evidence and render counts so a quieter measurement setup cannot be mistaken for a code improvement.
4. Use a dedicated fresh tab for measurements and close it after — never instrument the user's tab (they may navigate and wipe the rig mid-run).

## Test A Small Dev Variant In One Tab

Use a page-scoped request route for a short diagnostic change when other tasks share the checkout.
Fetch the observed Vite module response, require exactly one match for the changed expression,
and fulfill that request with the replacement. Match the compiled response, not the original TSX;
the React Compiler may rename variables. Route the baseline through the same handler too.

Add a temporary page marker for the served variant, reload, and verify the marker before measuring.
Repeat variants in alternating order with the same route and viewport. Keep every result. A variant
that skips behavior only shows that behavior's cost; it is not a safe fix. For example, bypassing a
row's busy state does not preserve disabled controls. Report React work and total latency separately.
Remove the exact route handler, reload, and verify the marker is gone before final QA and cleanup.

## Compare A Production Build Without Replacing The Dev Server

Use an owned Playwriter tab with page-specific request routes when other work still needs the dev server.

1. Build with `vp env exec pnpm --dir packages/app exec vite build --outDir <absolute-task-scratch-directory>`. Check the destination first and use a new directory for each build.
2. Keep the same app origin and backend. In that one tab, serve the compiled `index.html` for the app's main document and exact built files for their asset URLs. Let API, plugin, and other requests use the normal server. A missing compiled asset must fail the check instead of falling back to a different build.
3. Install the DevTools hook stub before that tab's first navigation. Record the built index hash, served asset paths, and route errors. Compare the page's script URLs against that exact build. Confirm that no Vite client, React refresh script, or source entry loaded. A healthy server or matching source file on disk does not prove the page runs the new build.
4. Wait for the real data to load before timing an interaction. Measure the click and render inside the page. Keep initial data loading separate from rendering time.
5. Await cleanup of the page's request routes before closing the owned tab. Restore harness page references to the owned dev tab. Do not change browser-wide routes or leave instrumentation on the user's tab.

Native QA scripts that import `/src/lib/app-convex-client.ts` should keep using a separate normal dev tab.

For a large Files workspace, record document load, first complete tree, and expansion as separate
times. `FilesTreeProvider` waits for all pages before showing the first tree. Use an in-page observer
for the ready state, record whether an import is still writing, and keep timed-out samples as limits.
Do not report a CLI timeout as render time or use a late observer to claim when an earlier state began.
