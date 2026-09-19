# bonobo-senate-browser-runner

A trusted host Cloudflare Worker for the cloud browser. It owns one Browser Run
session per user workspace, loads the private HTML snapshot into the existing
preview runtime, runs agent Playwright JavaScript inside an isolated Dynamic
Worker, and streams the live page to authorized viewers. It backs the Files
shared browser.

The host Worker is trusted; snippets and page content are not. A snippet runs
in a fresh Dynamic Worker isolate with a one-session browser connection. It
cannot acquire browsers, list account sessions, change network rules, reach
other sessions, use the network, or read host secrets.

## Status: 8D proof gate passed

Session open, reload, run, close, keep-open, viewer stream, input, and control
transfer are implemented and proven live against the dev deployment (see the
`cloud-browser-exec-2026-09-19` notes). The Worker Playwright path is suitable;
no Sandbox fallback was needed.

## Request contract

All `/internal/browser/*` routes need `Authorization: Bearer <BROWSER_RUNNER_SECRET>`.
Operational outcomes return HTTP 200 with `{ ok: true }` or
`{ ok: false, error: { code, message } }`. Transport failures (401, 400, 413,
503) use `{ ok: false, error }` with no session detail.

- `POST /internal/browser/open` — claim admission, acquire one provider
  browser, and load the snapshot. Body: owner/org/workspace ids, node id,
  navGen, sourceKind (`saved`/`proposed`/`draft`), sourceVersion, sourceHash,
  html (900,000 UTF-8 bytes max), viewport. Returns the session: opaque
  session id, generations, control state, source labels, page nonce.
- `POST /internal/browser/reload` — load a newer snapshot of the same node.
  Resets page input and scroll. Returns the new load generation and nonce.
  Agent calls include `expectedAgentLease` (`navGen`, `loadGen`, `controlGen`);
  the object requires the same generations and ready control before reserving
  the reload. Take control waits for an accepted reload to finish or fail before
  allowing viewer input. An overdue reload closes its page before the command
  slot can be reused. Explicit human reload omits this lease.
- `POST /internal/browser/run` — run one Playwright snippet. Body: owner
  triple, session/nav/load/control ids, command id, code (20 KB max). Returns
  `succeeded` with result, images, popups, console/page errors, and logs; or
  `errored`, `timed_out`, or `tainted` (target escape: the session is closed
  and the result is discarded). Refusals: `busy`, `control`, `stale_*`,
  `expired`, `closed`, `session_limit`.
- `POST /internal/browser/close` — close the provider browser, verify it is
  gone from the provider inventory, and free the slot. Works while disabled.
  Agent calls carry the same optional `expectedAgentLease` as reload; stale
  agent closes cannot end a session after human takeover.
- `POST /internal/browser/status` — report `{ ok: true, alive: boolean }` for
  the requested session id. This read checks the object record and deadlines;
  it does not renew idle time or create a viewer grant. Works while disabled.
- `POST /internal/browser/keep-open` — extend the idle deadline (never the
  total cap).
- `POST /internal/browser/viewer-grant` — mint a single-use 30-second viewer
  grant for an authorized session and navigation generation.
- `POST /internal/browser/viewer-renew` — extend a live viewer's grant by
  30 seconds after the caller re-checks access.
- `POST /internal/browser/control-take` — hand control to a viewer: ready
  becomes human at once; a running command finishes first (pausing) and then
  hands over. Refuses new agent commands meanwhile.
- `POST /internal/browser/control-resume` — atomically end human input and
  ready the agent side for a fresh request lease.

`GET /health` → `{ "ok": true }`.

## Viewer protocol

1. The app mints a grant over the trusted route, then opens
   `GET /viewer/stream` (WebSocket) and sends one hello within 5 seconds:
   `{ ownerId, organizationId, workspaceId, grantId, host: "docked"|"detached" }`.
2. The gateway attaches, answers `{ t: "hello", viewerId, viewport, control }`,
   and streams JPEG screenshots (~2/second) as binary messages.
3. Input messages `{ t: "input", seq, kind, ... }` carry mouse, wheel, and
   keyboard actions in page CSS pixels. Each is authorized against the live
   control lease and answered `{ t: "input-ack", seq, ok }`.
   Mouse down/up accept `clickCount` from 1 to 10 for native multiple clicks.
4. Control changes are pushed as `{ t: "control", control, controlGen }`.
5. The app renews every ~20 seconds. A grant unrenewed for 30 seconds ends
   the socket. Copies, replays, and late renewals fail.

Socket close codes: 4401 bad grant, 4404 session gone, 4408 grant expired,
4410 unexpected targets. (4409 stays reserved for a moved viewer; nothing sends it yet.)

## Session and control model

- One active browser per owner/organization/workspace (the object name is the
  slot), two per workspace, ten per deployment. Claims expire in 60 seconds
  so a crash cannot leak a slot.
- States: `starting`, `ready`, `agent`, `pausing`, `human`, `closing`.
  Generations invalidate late calls: a result or viewer from a retired file,
  load, or control holder is refused, never attached elsewhere.
- One command at a time (30 s each, 60 per session). The viewport is
  per-connection server-side: the record stores it, every lease re-applies
  it, and snippet changes persist.
- Budgets: 20 minutes total, 5 idle minutes, 32 loads, 8 MiB cumulative HTML.
- Cleanup always closes the real provider browser and confirms it left the
  provider inventory. Alarms retry bounded cleanup; provider expiry backstops.
  A late duplicate close only removes its own session record and alarm.
- Every host run path finishes its begun command (`try/finally` around the
  extracted executor); a duplicate finish is a no-op, and take/begin clear a
  stale lock. Takeover heals a dead command at once instead of wedging in
  `pausing`, and detaching the last input holder releases `human` back to
  `ready` (never to agent work).

## Isolation posture

- **One-session gate.** The snippet's only binding allows exactly
  `GET /v1/devtools/browser/<assigned>?persistent=true` with a WebSocket
  upgrade, rebuilt from trusted values. Acquisition, inventory, history,
  limits, other ids, and other queries get 403.
- **No snippet network.** `globalOutbound: null` makes fetch/connect throw.
  The snippet module exports only `connect` and `expect`.
- **No ambient authority.** User code runs with an undefined receiver, so it
  cannot reach the loader env. The provider session id never leaves the
  runner; callers use the opaque app session id.
- **Bounded child.** CPU/subrequest loader limits, an in-snippet timeout, and
  a parent wall clock. Infinite loops map to `timed_out`.
- **Network egress.** Acquisition guardrails latch `["esm.sh"]` for the
  session lifetime. They cover HTTP/HTTPS navigation and subresources outside
  that list, even when a snippet removes its Playwright routes. A blocked
  navigation returns a 403 with `cf-mitigated: guardrails` and
  `cf-brapi-guardrails-reason: not-in-allowlist`; the page URL still changes.
  The earlier proof mistook that URL change for a network-policy bypass.
  A fresh live check confirmed the provider block, so no mutable snippet
  firewall is used. See [Cloudflare's guardrail contract](https://developers.cloudflare.com/browser-run/features/guardrails/).
- **Registered target.** The harness resolves exactly one page and its inner
  preview frame, closes popups at once (reported, session survives), and the
  host re-verifies a single context/page, the controller URL, and the page
  nonce after successful and failed commands. Any escape taints: all output
  is discarded and the session closes. Timeouts and lost isolate calls also
  close the session, since unfinished work may still be running. Navigation
  of any kind is fatal by design; use reload.
- **Validated output.** PNG/JPEG magic plus decoded dimensions are checked on
  the host before any image is returned. Text, logs, console, and page-error
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
vp env exec pnpm --filter bonobo-senate-browser-runner build:child  # rebuild src/child-bundle.gen.ts (committed)

# dev environment only, until the product gates pass
vp env exec pnpx wrangler deploy --env dev --config packages/browser-runner/wrangler.jsonc
```

`src/child-bundle.gen.ts` is generated from `src/child-entry.ts` by esbuild
(bundle + minify + kept names). Keep-names is required: Playwright's expect
matchers check `receiver.constructor.name`. Rebuild after changing the entry
or the pinned `@cloudflare/playwright` version, then typecheck, test, and
redeploy.

The unit suite covers routing, auth, validation, admission, generations,
locks, deadlines, alarms, the connection gate, image validation, the
controller/harness builders, and viewer/control transitions with mocked
bindings. Provider behavior (acquire, bootstrap, reconnect, viewer stream,
cleanup verification) is proven live; mocked Worker tests alone never claim
cloud isolation.
