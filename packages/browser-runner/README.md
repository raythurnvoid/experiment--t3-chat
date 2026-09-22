# bonobo-senate-browser-runner

A trusted host Cloudflare Worker for the cloud browser. It owns one Browser Run
session per user workspace, loads the private HTML snapshot into the existing
preview runtime, runs agent Playwright JavaScript inside an isolated Dynamic
Worker, and streams the live page to authorized viewers. It backs the Files
shared browser.

The host Worker is trusted; snippets and page content are not. A snippet runs
in a fresh Dynamic Worker isolate with a trusted, one-command protocol bridge. It
cannot acquire browsers, list account sessions, change network rules, reach
other sessions, use the network, or read host secrets.

## Status

Live dev checks cover normal page actions, screenshots, tracing, viewport
changes, reload, and blocked provider capabilities. Delayed navigation closes
the session; delayed popups close while the assigned page stays usable.
Mocked tests also cover connection replay, drain failures, and late cleanup.

## Request contract

All `/internal/browser/*` routes need `Authorization: Bearer <BROWSER_RUNNER_SECRET>`.
Operational outcomes return HTTP 200 with `{ ok: true }` or
`{ ok: false, error: { code, message } }`. Transport failures (401, 400, 413,
503) use `{ ok: false, error }` with no session detail.

- `POST /internal/browser/open` — claim admission, acquire one provider
  browser, and load the snapshot. Body: owner/org/workspace ids, node id,
  navGen, sourceKind (`saved`/`proposed`/`draft`), sourceVersion, sourceHash,
  html (900,000 UTF-8 bytes max), viewport. Returns the session: opaque
  session id, generations, control state, source labels, page nonce, command
  and load counts, and idle/total deadlines. The runner owns these values.
- `POST /internal/browser/reload` — load a newer snapshot of the same node.
  Resets page input and scroll. Returns the new load generation and nonce.
  Agent calls include `expectedAgentLease` (`navGen`, `loadGen`, `controlGen`);
  the object requires the same generations and ready control before reserving
  the reload. Take control waits for an accepted reload to finish or fail before
  allowing viewer input. An overdue reload closes its page before the command
  slot can be reused. Explicit human reload omits this lease.
- `POST /internal/browser/run` — run one Playwright snippet. Body: owner
  triple, session/nav/load/control ids, command id, code (20 KB max). Returns
  `succeeded` with result, files, popups, console/page errors, and logs; or
  `errored`, `timed_out`, or `tainted` (target escape: the session is closed
  and the result is discarded). Refusals: `busy`, `control`, `stale_*`,
  `expired`, `closed`, `session_limit`. Output is accepted only after the
  command bridge is revoked, drained, and checked by the trusted host.
- `POST /internal/browser/close` — close the provider browser, verify it is
  gone from the provider inventory, and free the slot. Works while disabled.
  Agent calls carry the same optional `expectedAgentLease` as reload; stale
  agent closes cannot end a session after human takeover.
- `POST /internal/browser/status` — report `{ ok: true, alive: boolean }` for
  the requested session id, plus `session` metadata when alive. This read
  checks the object record and deadlines; it does not renew idle time or
  create a viewer grant. Works while disabled.
- `POST /internal/browser/keep-open` — extend the idle deadline (never the
  total cap).
- `POST /internal/browser/viewer-grant` — mint a single-use 30-second viewer
  grant for an authorized session and navigation generation.
- `POST /internal/browser/viewer-renew` — extend a live viewer's grant by
  30 seconds after the caller re-checks access. Returns current session
  metadata, control, and deadlines. It does not extend session idle time.
- `POST /internal/browser/control-take` — hand control to a viewer: ready
  becomes human at once; a running command finishes first (pausing) and then
  hands over. Refuses new agent commands meanwhile.
- `POST /internal/browser/control-resume` — atomically end human input and
  ready the agent side for a fresh request lease.

`GET /health` → `{ "ok": true }`.

## Viewer protocol

1. The app mints a grant over the trusted route, then opens
   `GET /viewer/stream` (WebSocket) with `ownerId`, `organizationId`, and
   `workspaceId` query fields. These non-secret ids route the socket to its
   session Durable Object. The grant stays in the hello, sent within 5 seconds:
   `{ ownerId, organizationId, workspaceId, grantId, host: "docked"|"detached" }`.
   The object checks that the URL, hello, and stored session have the same ids.
2. The object owns all viewer sockets and answers
   `{ t: "hello", viewerId, viewport, control, controlGen }`. One shared CDP
   screencast produces JPEG frames for all viewers. Provider credentials and
   raw CDP commands never reach the client.
3. Each `{ t: "frame", seq, loadGen }` is immediately followed by its binary
   JPEG. The app assigns the image and sends `{ t: "frame-ack", seq }` after
   its synchronous frame callback, even if that callback fails. On failure, the
   client then closes the socket. This ACK confirms delivery, not decode or paint.
   Each viewer may have two frames in flight. ACKs must match the oldest frame;
   the object keeps only the latest waiting frame. A slow viewer cannot block
   the others. A new viewer receives the cached frame even on a static page.
4. Input messages `{ t: "input", seq, controlGen, loadGen, kind, ... }` carry
   mouse, wheel, and keyboard actions in page CSS pixels. The client uses the
   latest hello/control generation and the last delivered image's load
   generation. It sends no input until both are known. The object checks both
   against its durable lease before saving activity. One ordered queue applies
   input (50 pending max) and re-checks control before Playwright. The reply is
   `{ t: "input-ack", seq, ok, timings, code? }`; timings contain `queueMs`,
   `authorizeMs`, `readyMs`, and `applyMs` without input content.
   Only mouse moves to the last applied position are skipped after authorization.
   Mouse down/up accept `clickCount` from 1 to 10 for native multiple clicks.
5. Control changes are pushed as `{ t: "control", control, controlGen }`.
   `{ t: "viewport", viewport }` comes before frames for a new load or size.
   The client ignores binary frames without adjacent valid metadata and clears
   pending metadata on viewport changes and close.
6. The app renews every ~20 seconds. A grant unrenewed for 30 seconds ends
   the socket, including on a static page. Session idle and total deadlines
   still apply. Copies, replays, and late renewals fail.
7. An authenticated viewer may send `{ t: "ping", seq }` once per second,
   with a positive safe-integer sequence. The reply is `{ t: "pong", seq }`.
   This measures the socket round trip without storage writes, provider calls,
   activity changes, or deadline extensions.

The object retains one trusted Playwright connection for input and command
checks. The producer starts with the first viewer and stops after the last
leaves, without closing that connection. Each start gets a fresh page CDP
session so old frames cannot enter a new stream. Start and stop are serialized.
Reloads, viewport changes, and completed agent commands restart the producer.
Agent tracing can replace Chromium's screencast, so the command stays locked
through restart and re-checks the session before handing control back. Each
start forces the stored viewport through CDP; Playwright's cached size can be
stale after an agent command. A lost host connection closes the session.
Viewer detach writes are ordered, and command finish and reload wait for that
cleanup before saving their final state. A provider failure while input is held
or still running ends the session, since that connection cannot release it safely.

Socket close codes: 4401 bad grant, 4404 session gone, 4408 grant expired,
1011 stream failure.

## Session and control model

- One active browser per owner/organization/workspace (the object name is the
  slot), two per workspace, ten per deployment. Claims expire in 60 seconds
  so a crash cannot leak a slot.
- States: `starting`, `ready`, `agent`, `pausing`, `human`, `closing`.
  Generations invalidate late calls: a result or viewer from a retired file,
  load, or control holder is refused, never attached elsewhere.
- One command at a time (30 s each, 60 per session). The record stores the
  viewport, each command applies it, and valid snippet changes persist.
- Take, Resume, Reload, agent begin, and input-holder detach reject old queued
  input, wait for current input, and release held buttons and keys before
  changing control. Ending a session invalidates queued input and closes its page.
  Failed or timed-out input closes the session before it can be reused.
- Budgets: 20 minutes total, 5 idle minutes, 32 loads, 8 MiB cumulative HTML.
- Cleanup always closes the real provider browser and confirms it left the
  provider inventory. Alarms retry bounded cleanup; provider expiry backstops.
  A late duplicate close only removes its own session record and alarm.
- Every host run path finishes its begun command (`try/finally` around the
  executor). A finish for an old command is a no-op. A stale command, lost
  bridge, or uncertain cleanup closes that browser; its lock is never cleared
  for reuse. Takeover waits for a live command to finish. Detaching the last
  input holder releases `human` back to `ready` (never to agent work).

## File output

Snippets use the same `emitFile` helper as the code runner:

```js
emitFile({ workspace: "personal", path: "/reports/page.png", bytes: await page.screenshot() });
emitFile({ workspace: "current", path: "/reports/data.bin", bytes: new Uint8Array([0, 255, 128]) });
```

Every descriptor requires `workspace: "current" | "personal"`. Missing and invalid
values are refused; there is no default. A single snippet can emit into both roots.
This selects the output destination only. It does not change the browser session,
its source file, or its access grant. The app resolves and authorizes each destination.

`bytes` accepts `Uint8Array` or `ArrayBuffer`. The call copies bytes at once,
including only the selected range of a typed-array view. Any content type and
empty files are allowed. Optional `contentType` stays absent when omitted.
The runner checks transport bounds: eight files and 8 MiB combined across both workspaces, paths of
1–1024 characters, and content types of 1–255 characters. The app checks
canonical workspace paths such as `/reports/data.bin` and MIME syntax.

RPC carries typed arrays and the required workspace selector. The trusted host returns
`files: [{ workspace, path, contentType?, dataBase64 }]` in HTTP JSON. Both the
harness and the host validate the workspace. Errors and timeouts return `files: []`.
A forged RPC file with a missing or invalid workspace taints the command, drops
the whole output batch, and closes the session through the existing cleanup path.
File bytes stay out of result text and logs. The app stores
files as pending changes after its Agent, lease, and Files access checks.

Screenshots have separate limits at the trusted CDP bridge: PNG/JPEG,
2 MiB, an 8192-pixel edge, and 16 million pixels. The bridge checks the matching
capture reply before the snippet receives it. A large capture returns a command
error and leaves the connection usable. A malformed provider reply closes it.
The header check bounds image dimensions; it does not decode the full image.
There is no two-capture limit. Generic file exports do not use image checks.

## Isolation posture

- **One-command gate.** The snippet's only binding allows exactly
  `GET /v1/devtools/browser/<app-session-id>?persistent=true` with a WebSocket
  upgrade. The trusted binding routes it to the session object with the command
  id. The object consumes a one-use connection grant before opening the provider
  socket. Acquisition, inventory, other ids, and other queries get 403.
- **Trusted protocol bridge.** `src/agent-connection.ts` checks CDP methods,
  parameters, and target/session ids outside the child isolate. It allows the
  registered page and its attached frames/workers. It blocks `Cloudflare.*`,
  `Browser.close`, target creation, raw target attachment, nested forwarding,
  and provider file access. Download setup is forced to deny. The allowlist
  covers normal Playwright actions, screenshots, and context tracing.
- **Command lifetime.** The connection moves from available to consumed,
  revoked, then settled. Revocation refuses new calls. The bridge drains
  accepted calls, removes its scripts and bindings, releases held input, and
  stops its screencast. The trusted host then checks provider context/target
  inventory, controller URL, and page nonce before marking the command settled.
  Only a settled command may release its slot without closing the browser.
- **No snippet network.** `globalOutbound: null` makes fetch/connect throw.
  The snippet module exports only `connect` and `expect`.
- **No ambient authority.** User code runs with an undefined receiver, so it
  cannot reach the loader env. The provider session id never leaves the
  runner; both callers and the child use the opaque app session id.
- **Bounded child.** CPU/subrequest loader limits, an in-snippet timeout, and
  a parent wall clock. Infinite loops map to `timed_out`.
- **Network egress.** Acquisition guardrails latch `["esm.sh"]` for the
  session lifetime. They cover HTTP/HTTPS navigation and subresources outside
  that list, even when a snippet removes its Playwright routes. A blocked
  navigation returns a 403 with `cf-mitigated: guardrails` and
  `cf-brapi-guardrails-reason: not-in-allowlist`; the page URL still changes.
  No mutable snippet firewall is used. See [Cloudflare's guardrail contract](https://developers.cloudflare.com/browser-run/features/guardrails/).
- **Registered target.** The harness resolves the registered page and its inner
  preview frame. The trusted host closes popups throughout the session; the
  command bridge also reports popups it observes. Main-page navigation closes
  the session, including a timer that fires after command finish. Only trusted
  reload may navigate to the controller. Reconnect checks the target/context
  inventory, URL, and nonce after installing listeners. Reload waits for that
  check and uses the same host connection. An admitted reload failure closes
  that exact session because the page may already have changed.
  Host checks also run after successful and failed commands.
  A changed target, controller URL, or nonce discards all output and closes the
  session. Timeouts and lost isolate calls also close it, since unfinished work
  may still be running. Use reload to load another snapshot.
- **Validated output.** The trusted host checks each file's workspace, shape, count, and raw byte
  totals. The protocol bridge checks screenshot headers and dimensions before
  forwarding bytes to the child. Text, logs, console, and page-error
  channels are separately bounded in UTF-8 bytes without splitting characters.
- **Same-origin serving.** The provider transport does not report
  cross-origin child frames (proven with probes), so the trusted bootstrap
  fetches the exact runtime bytes and security headers from the deployed
  preview host and serves them through the controller route under the
  synthetic origin. Same bytes, same policy, no preview change.
- **Privacy.** Operational logs carry only metadata (ids, generations,
  counts, byte sizes, status) — never code, HTML, DOM, viewer URLs, tokens,
  cookies, input text, or captured console text.

## Configuration

| Name                     | Kind              | Purpose                                                        |
| ------------------------ | ----------------- | -------------------------------------------------------------- |
| `BROWSER_RUNNER_SECRET`  | secret (required) | Bearer token the caller must present.                          |
| `BROWSER_RUNNER_DISABLED`| var (optional)    | Set to `"true"` to refuse new work (503 kill switch).          |
| `BROWSER_PREVIEW_URL`    | var               | The `/v0` runtime URL the browser bytes come from.             |
| `BROWSER`                | browser binding   | The Browser Run binding (declared in `wrangler.jsonc`).        |
| `LOADER`                 | worker_loaders    | The Worker Loader binding (declared in `wrangler.jsonc`).      |
| `BROWSER_SESSIONS`       | durable object    | Session, lease, and deadline state.                            |
| `BROWSER_REGISTRY`       | durable object    | Deployment and workspace admission slots.                      |

The `dev` environment repeats every binding explicitly and deploys as
`bonobo-senate-browser-runner-dev`. The top-level (prod) name stays disabled
and undeployed until the product gates pass.

## Develop / deploy

```sh
vp env exec pnpm --filter bonobo-senate-browser-runner test       # vitest (node env, mocked bindings)
vp env exec pnpm --filter bonobo-senate-browser-runner typecheck

# dev environment only, until the product gates pass
vp env exec pnpx wrangler deploy --env dev --config packages/browser-runner/wrangler.jsonc
```

`src/child-bundle.gen.ts` is generated from `src/child-entry.ts` by esbuild
(bundle + whitespace/syntax minification). `--keep-names` preserves class and
function names for Playwright's `receiver.constructor.name` checks. Identifier
names must stay intact too: Playwright serializes its screenshot helper and
runs it in the page with a helper named `__name`. Renaming that identifier
causes `ReferenceError: a is not defined` during `page.screenshot()`.

Rebuild after changing the entry or the pinned `@cloudflare/playwright` version.
From the repo root, use an absolute `.js` path in the task's scratch folder
outside the repo for the intermediate bundle:

```sh
vp env exec pnpm --dir packages/app exec esbuild ../browser-runner/src/child-entry.ts --bundle --minify-whitespace --minify-syntax --keep-names --format=esm --target=es2022 --platform=node --external:cloudflare:workers "--outfile=<absolute scratch path>"
```

After esbuild succeeds, pass that same path to the wrapper:

```sh
vp env exec node packages/browser-runner/scripts/wrap-child.mjs "<absolute scratch path>"
```

The wrapper's optional absolute input path keeps the intermediate outside the
repo. It writes the committed `src/child-bundle.gen.ts` and removes the input.
Then typecheck, test, and redeploy.

The unit suite covers routing, auth, validation, admission, generations,
locks, deadlines, alarms, bridge method/session checks, revocation and cleanup,
file output (including both destinations and missing/invalid workspace refusal in the harness,
RPC validation, and HTTP results), screenshot bounds, controller/harness builders, and viewer/control transitions
with mocked bindings. The generated-bundle regression runs the actual
screenshot helper in a separate context and checks caret hiding and cleanup.
Live QA must also check acquire, bootstrap, reconnect, Playwright operations,
viewer streaming, command cleanup, and provider cleanup verification.

For viewer latency QA, use at least 20 native clicks on a visible counter page.
Measure the time from each click to the changed image loading. Report median
and p95, and state that image load is not screen paint. Aim toward 100 ms;
p95 must stay at or below 500 ms.
Use authenticated ping and input ACK phases to locate delays. Worker clocks
advance only after I/O; these phases do not measure pure CPU work (see the
[profiling skill](../../.agents/skills/perf-profiling/SKILL.md)).
Also check two viewers, a slow viewer, a static page, reload, viewport changes,
held-input handoff, and stream recovery after agent screenshots and tracing.
