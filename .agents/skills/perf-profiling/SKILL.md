---
name: perf-profiling
description: How to correctly measure and profile latency in Convex functions, Cloudflare Workers, and web apps driven through Playwriter/CDP. Load this BEFORE measuring "why is X slow", profiling a Convex mutation/query, timing UI interactions, or capturing CPU profiles. It prevents known measurement traps (frozen clocks, module-eval cost hiding in userExecutionTime, throttled backgrounded tabs, React DevTools polluting profiles, dev-build overhead).
---

# Measure Convex, Worker, And Browser Latency Separately

Use the relevant section before measuring latency. To drive the live app in the browser, also load `app-playwriter-harness`.

# Convex Functions

## Facts That Change How You Measure

- `Date.now()` is FROZEN for the whole execution of a query/mutation (determinism). Inline `Date.now()` deltas always read 0. Docs: https://docs.convex.dev/functions/runtimes
- `console.time` / `console.timeLog` / `console.timeEnd` use Convex's non-deterministic runtime clock and can measure phases without exposing time to deterministic function code.
- A mutation's `executionTime` can stop before commit. Compare `timestamp - executionTimestamp` for the wider span through completion logging. That span also includes usage tracking, so the difference is not pure disk time. A parent action timer around `runMutation` measures the full await. On 2026-10-27, source-page mutations logged 69–93 ms of execution but took 438–984 ms through completion; the next call started only a few milliseconds later.
- When Convex builds a fresh context, module evaluation is included in user execution time. A heavy static import graph can dominate a small handler. Compare a lean probe with one suspect import before changing handler logic.
- Convex must discover a function's dependencies at bundle time. Do not use runtime-resolved dynamic dependencies in the default V8 runtime. A literal `import()` may still be bundled, so do not assume it defers module evaluation. Split heavy code into separate function modules when import cost is the problem. Docs: https://docs.convex.dev/functions/bundling
- Many current query and mutation modules export `experimental_reuseContext = true`. This can let an eligible successful call reuse a context from the same module when its module-load reads are still valid, so warm samples may skip module evaluation. Handler reads and writes still run on every call. Reuse is not guaranteed and does not apply to actions or HTTP actions. Never keep mutable module-level state in these modules. Treat the flag as current repo behavior to verify against the bundled Convex source, not as a default optimization; prefer splitting heavy modules before adding it elsewhere.

## Procedure

1. Get real per-execution numbers without changing code. Use the bounded Convex log-capture workflow in `.agents/skills/troubleshooting/SKILL.md` so the live stream is handled correctly in PowerShell. JSONL `executionTime` and `userExecutionTime` are in seconds; `userExecutionTime` includes user code and module evaluation. `usageStats` reports read/write bytes, document counts, storage/index/network usage, and memory. Check which fields the current logs provide; keep missing values unknown. The human log line rounds `executionTime` to milliseconds. `caller: "SyncWorker"` marks real client-driven executions.
2. Check module startup with matching no-op mutations in the real heavy module and the intended small production module. Both must use `internalMutation` from `./functions.ts`, with the same args, return shape, and context-reuse setting. Keep them in separate files so the small control does not load the heavy imports. Run at least seven alternating calls per control. Use the direct Node CLI form in `convex-admin-ops`; internal controls need admin auth without `--identity`. Warm controls may hide startup cost, so they provide supporting evidence only. Remove every control before the final deployment.
3. Phase-time the handler with `console.time("phase")` / `console.timeEnd("phase")` around each await. Output appears in `convex logs` log lines.
4. Dashboard per-function p50/p90/p95/p99 charts exist for trends; no in-function breakdown.

Choose the native workload, warm-up count and speed assertion before measuring. Keep every sample. For an import fix, add a real heavy value import while keeping the handler, caller, key, builder and reuse setting unchanged. For a reuse fix, turn only the flag off. Verify the changed source on the exact uncached mutation child, make the assertion fail, then restore the fixed source bytes and make it pass. Check the real API route and saved data too; a missing function hidden by an error catch is not a speed fix. Deploy the final source without controls and repeat the same check.

API key usage writes live in `convex/public_api_credential_usage.ts`. This small module keeps file editor imports out of timestamp calls.

The principal limiter in `convex/rate_limiter.ts` reuses its loaded module too. Each call still charges the live token docs through the component. Use sequential calls to test eligible reuse; a burst can need more fresh contexts. Keep those fresh calls in the sample and report burst delays separately.

## Traps

- In this repo, run Convex CLI commands through Vite Plus with an explicit app package directory: `vp env exec pnpm --dir packages/app exec convex ...`. The repo root `.env.local` may point at a local backend that is not running.
- Rate-limiter probes consume real tokens. Read the current limiter configuration before a probe and use a throwaway key for that run, never a real user key.
- Probe mutations that insert data should delete it in the same transaction (net no-op).
- Dev deployments are noisy; take ≥5-7 samples per variant, interleave variants round-robin, compare medians.
- Exclude `cachedResult: true` records from execution-cost totals. A cache hit can keep the original execution timestamp and user execution time while reporting zero total time. Use its current `requestId` only to trace the call, not to time new work.
- A module-init marker on an uncached mutation shows a fresh module load. Reused mutations do not replay that marker. Its absence alone does not prove reuse; query cache hits can replay old logs.
- Query logs are part of subscription results. Adding phase logs can cause extra WebSocket updates, so do not use that run as a clean product speed comparison.
- A module imported by both an HTTP root and a mutation can log the same marker in both. Require the marker on the exact uncached mutation child when proving its loaded source.
- `userExecutionTime` is runtime time, not CPU time. Handler timers include waits that runtime time may exclude. Do not subtract separate medians to claim an exact startup time.
- A `console.time` started in a first import and ended at the bottom of a module always reads 0ms (observed on actions and queries in 2026-10). It cannot time module loading. Compare no-op mutation controls instead (procedure step 2), and time handler phases with timers inside the handler.
- To see which imports make a module heavy, bundle it with the esbuild that `convex` depends on (`platform: "browser"`, `conditions: ["convex"]`, `metafile: true`) and group `bytesInOutput` by package. One module alone undercounts the total; for byte totals, use the full bundle check in `.agents/skills/convex/references/additional-guidelines.md`. Most modules import `schema.ts`, which brings zod and yaml through `shared/plugins.ts`. Before you move code to a "small" module, check that its helpers do not already import `schema.ts`.
- `--identity` creates an acting user. Automatic CLI dispatch can hide internal functions from that identity even when native metadata lists them. Use it for public auth checks. Run internal timing controls without it.
- For HTTP checks, send a unique 16-hex `convex-request-id` and join that exact ID to the root and its children. Do not assume the response has a request-ID header. Match log labels with exact delimiters, so label `1` cannot match `10`.
- Convex can send distinct one-line `Progress` records with the same record timestamp and line index. Deduplicate phase logs only within the exact request and execution. Include the parsed marker label and event field in the key too. Reject conflicting values. Test split records as well as several lines in one record.
- Server exec time is only one leg. The client perceives: WS round trip + mutation exec + subscription update pushed to the client + client render. Capture Convex WS frames (CDP `Network.webSocketFrameSent/Received`) to split those legs.
- In Convex 1.46 and 1.47, a successful `convex.mutation()` promise waits for query updates to reach its commit timestamp. The raw `MutationResponse` can arrive earlier. Do not call that whole gap React time. `ActionResponse` does not wait for this query fence, but changing transport alone does not update list rows. Check the installed SDK's `browser/sync/request_manager.ts` before relying on this rule.
- A `Transition` sends changed query results. It need not include every watched query or every temporary Move view. Cleanup can finish before a view reaches the browser. Keep mutation timing, exact native joins and saved data checks separate from directory update counts. Fewer directory updates do not by themselves mean Move failed. The reference sync code skips equal result/log hashes in `crates/sync/src/state.rs`.
- Before comparing numbers across dependency versions, verify what actually resolves with `vp env exec pnpm --dir packages/app exec node -p "require('<pkg>/package.json').version"`. A pnpm-workspace `overrides:` entry can pin the whole workspace regardless of package.json ranges.

# Cloudflare Workers

- In deployed Workers, both `Date.now()` and `performance.now()` advance only after I/O. Time around awaited storage or provider calls, but do not use these clocks to measure synchronous parsing or encoding. A zero result does not mean that work was free. Local Workers do not freeze these clocks. Docs: https://developers.cloudflare.com/workers/runtime-apis/performance/
- Report Worker phase durations separately from browser interaction times. Do not subtract timestamps from different machines without aligning their clocks. Keep the full user interaction on the browser's `performance.now()` clock.

# Browser And UI Latency With Playwriter And CDP

## Facts That Change How You Measure

- Do not measure an interaction by timing around Playwright waits. That duration can include relay, polling, actionability, and background-tab delays. Capture the start and completion inside the page with event listeners, `MutationObserver`, and `performance.now()`. `waitForFunction` uses `requestAnimationFrame` polling by default; pass a numeric `polling` interval when you need controlled completion polling, and do not treat the wait duration as the product latency.
- A WebSocket `message` listener added after the app's listener can run after the app has already rendered. Its timestamp is not the network arrival time. Use CDP for arrival and match the exact query id and frame size. With several tabs, keep each tab's frame array separate and remove its handlers before detaching CDP.
- To capture a full WebSocket lifetime, use an owned `about:blank` tab. Install init scripts and the CDP observer before the first app navigation. Keep the harness and observer on that same Page. A socket can open before a later reload; missing socket creation or query Add makes the capture incomplete.
- A connection may close after an action's reply and visible frame. That later close does not erase the completed action. Track request and query IDs together with their connection ID. Check that each send and reply falls inside its recorded connection lifetime. Keep reconnects and slow rows; still reject missing events or ambiguous retries.
- A CPU profile also includes time spent waiting for automation commands. For interaction totals, trim samples to the in-page click and completion times, using the outgoing WebSocket frame to align the clocks. Report the row appearing, rename focus, and next animation frame separately; DOM changes do not prove a paint has happened.
- The React DevTools extension pollutes CPU profiles and slows commits: its hook walks every fiber on commit (`measureHostInstance` — shows up as huge `get scrollX` self time). Neutralize before measuring: `page.addInitScript` a stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` ({isDisabled:true, inject:()=>0, onCommitFiberRoot(){} ...}), then reload.
- The DevTools stub also turns off Fast Refresh (Vite warns "Something has shimmed the React DevTools global hook"). A source edit then logs "hot updated" but the page keeps the old module. Reload the page after every edit. To prove which code is served, fetch the module URL and look for a changed expression: Vite's transform drops comments, so a `// marker` comment is never there.
- Before trusting a loading state, check when the first frame after the click runs. If a long task blocks the main thread past the server answer, the loading state never paints, and a check that waits for it passes with the fix on or off.
- To test a cached revisit, read the URL after each reload before you click. A reload keeps the URL, so the page may already show the folder you plan to "leave". The first click then does nothing, and the next one is a cold visit that looks like a cache miss. Count only a visit to a folder the same page load has already shown.
- A Playwriter relay restart can keep the tab but lose its future init scripts. Restore the DevTools stub after reconnecting, reload, and require `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.isDisabled === true` before every timed run. Keep samples with a missing setup marked invalid and repeat them.
- Some extension connections reject `Profiler.enable` with "method not found" (Playwriter's extension session has done this with `'Profiler.enable' wasn't found`). Check support before the timed action. Then use `scripts/trace-cpu-profile.js`: CDP `Tracing` with the `disabled-by-default-v8.cpu_profiler` category still worked there on 2026-10-18, and the script rebuilds a `.cpuprofile` from the trace's `ProfileChunk` events. Tracing slows the page, so take timings from separate runs without it. Do not reset a shared relay just for this error. Long tasks, React `performance` measures, and `long-animation-frame` script entries still work in the page.
- When the relay runs from the Claude desktop app, `download.saveAs(...)` can fail with `ENOENT` on the relay's temp copy. Keep the profile in `state` and summarize it inside the sandbox, as `scripts/trace-cpu-profile.js` does. The JS Self-Profiling API is no way out here: it needs a `Document-Policy: js-profiling` response header, and page routes did not see the app's document request.
- A `scrollTop` write can return in under 1ms while the row render runs as a later task. `requestAnimationFrame` then waits on that render, so the frame gap is not the paint time. Read long tasks and React measures for the scroll window. Compare the rows immediately, in a microtask, and after the long task.
- React dev builds add overhead from `jsxDEV` element creation, `createTask` stack tracking, and dev-only checks. The app does not use `StrictMode`, so dev does not render or run effects twice. Normally compare production too. When the task targets dev performance, keep the dev build and its checks enabled and reduce repeated app work.
- React 19 dev builds emit component timing measures. Group `performance.getEntriesByType("measure")` by name inside the interaction window to compare render counts and durations. Parent durations include children; do not add them together. A disabled DevTools hook does not disable these built-in tracks. In this app on 2026-10-18, `getEntriesByType("measure")` stayed empty after a click. Then count renders with temporary counters instead: one marker-tagged line per component body and memo comparator that adds to a `globalThis` object, reset before the click and read after it. Record which compared prop differs to find the cause. Remove every marker line after.
- When wrapping a Vite module singleton, import the exact URL the page loaded, including its `?t=` value. Read that URL from resource timing entries or the loaded module's imports. An unversioned import can create a second router, so its navigation wrapper and event listeners observe nothing. Confirm that the wrapper records one real UI action before trusting it.
- Before the first navigation, use `page.addInitScript(() => performance.setResourceTimingBufferSize(5000))` when finding loaded modules through resource timing. The default buffer can fill before a large dev app loads its target module. If it already filled, install this init script and reload before looking up the URL.
- Compare the same viewport, sidebar width, loaded node count, and starting view. Leaving an editor adds work that an empty folder view does not. Record mounted rows too. Keep tests, builds, HMR updates, and other CPU work out of timing runs; repeat the final comparison without the CPU profiler.
- After restarting Vite, wait for dependency optimization and automatic reloads to stop, then check the real UI is ready. HTTP 200 alone is not enough: startup can still serve `504 Outdated Optimize Dep` while rebuilding its cache.

## Procedure

Ready-to-use scripts live in `scripts/` next to this file:

- `scripts/neutralize-react-devtools.js` — stub the DevTools hook + reload (run first, generic).
- `scripts/ui-latency-rig-example.js` — in-page timing rig template (adapt the `ADAPT:` marks).
- `scripts/cpu-profile-example.js` — CDP Profiler around one interaction (template).
- `scripts/trace-cpu-profile.js` — CPU samples through CDP Tracing when `Profiler.enable` is missing. Run it before and after the interaction; it charges busy time to app frames.
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
   Set `charset=utf-8` on text asset MIME types. Keep binary assets unchanged. A missing charset can make the browser read non-ASCII text with the wrong encoding. Read the browser's response bodies through CDP and compare their bytes with the build before timing.
3. Install the DevTools hook stub before that tab's first navigation. Record the built index hash, served asset paths, and route errors. Compare the page's script URLs against that exact build. Confirm that no Vite client, React refresh script, or source entry loaded. A healthy server or matching source file on disk does not prove the page runs the new build.
4. Wait for the real data to load before timing an interaction. Measure the click and render inside the page. Keep initial data loading separate from rendering time.
5. Await cleanup of the page's request routes before closing the owned tab. Restore harness page references to the owned dev tab. Do not change browser-wide routes or leave instrumentation on the user's tab.

Native QA scripts that import `/src/lib/app-convex-client.ts` should keep using a separate normal dev tab.

For a large Files workspace, record document load, first settled root pages, and expansion as separate
times. Record the loaded pages and rows; the provider does not load the whole tree. Use an in-page
observer for the ready state, record whether an import is still writing, and keep timed-out samples as limits.
Do not report a CLI timeout as render time or use a late observer to claim when an earlier state began.
