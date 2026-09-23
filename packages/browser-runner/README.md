# bonobo-senate-browser-runner

A trusted host Cloudflare Worker for the cloud browser. It owns one Browser Run
session per user workspace, loads the private HTML snapshot into the existing
preview runtime, runs agent Playwright JavaScript inside an isolated Dynamic
Worker, and streams the live page to authorized viewers. It backs the Files
shared browser (file mode) and the workspace Browser route (web mode, see Web
mode).

The host Worker is trusted; snippets and page content are not. A snippet runs
in a fresh Dynamic Worker isolate with a trusted, one-command protocol bridge. It
cannot acquire browsers, list account sessions, change network rules, reach
other sessions, use the network, or read host secrets.

## Status

Live dev checks cover normal page actions, screenshots, tracing, viewport
changes, reload, and blocked provider capabilities. In file mode, delayed
navigation closes the session; delayed popups close while the assigned page stays usable.
Mocked tests also cover connection replay, drain failures, and late cleanup.

## Request contract

All `/internal/browser/*` routes need `Authorization: Bearer <BROWSER_RUNNER_SECRET>`.
Operational outcomes return HTTP 200 with `{ ok: true }` or
`{ ok: false, error: { code, message } }`. Transport failures (401, 400, 413,
503) use `{ ok: false, error }` with no session detail.

- `POST /internal/browser/open` — claim admission, acquire one provider
  browser, and load the snapshot. Body: `mode: "file"`, optional `attemptId`
  (1–128 characters; open logs carry it; the runner makes a UUID when it is
  missing), owner/org/workspace ids, node id,
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
  and the result is discarded). `succeeded` also has `downloads` (always `[]`
  in file mode; see Downloads and uploads). Refusals: `busy`, `control`, `stale_*`,
  `expired`, `closed`, `session_limit`, `busy_command`, `not_ready`, and in
  web mode `agent_access_off` and `agent_blocked_site`.
  Output is accepted only after the command bridge is revoked, drained, and
  checked by the trusted host. A snippet that is only a function (for example
  `async ({ page }) => { ... }`) never runs, so it returns `errored` with
  "Your code returned a function. Write the function body only, do not wrap it in a function."
- `POST /internal/browser/close` — close the provider browser, verify it is
  gone from the provider inventory, and free the slot. Works while disabled.
  Returns `{ ok: true, existed, verified, usage }`.
  Agent calls carry the same optional `expectedAgentLease` as reload; stale
  agent closes cannot end a session after human takeover. Web mode: only
  `saveProfile: true` (the human End) saves the cookies first. The optional
  `reason` (1–40 characters of `a-z` and `_`; any other value is dropped)
  names the app path that asked. Convex sends `human_end`, `agent_close`,
  `start_orphan`, `access_lost`, `member_removed`, `account_deleted`,
  `profile_listed`, `profile_site_cleared`, or `profile_cleared`. The runner
  only logs it, as `close_request` with `by` (`unknown` when absent) and
  `saveProfile`, so an unexpected close can be traced. It is not the usage
  receipt reason. Every viewer socket end logs `viewer_end` with its close code.
- `POST /internal/browser/status` — report `{ ok: true, alive: boolean }` for
  the requested session id, plus `session` metadata when alive. When not
  alive, it adds `closing` (the record still exists) and `usage` (the receipt,
  or null). Both shapes add `profileStored`: true while saved cookie bytes
  exist in the object (no id, no data). This read
  checks the object record and deadlines; it does not renew idle time or
  create a viewer grant. Works while disabled.
- `POST /internal/browser/keep-open` — extend the idle deadline (never the
  total cap). Returns `{ ok: true, idleUntil }`.
- `POST /internal/browser/viewer-grant` — mint a single-use 30-second viewer
  grant for an authorized session and navigation generation.
- `POST /internal/browser/viewer-renew` — extend a live viewer's grant by
  90 seconds after the caller re-checks access. Returns current session
  metadata, control, and deadlines. It does not extend session idle time.
- `POST /internal/browser/control-take` — hand control to a viewer: ready
  becomes human at once; a running command finishes first (pausing) and then
  hands over. Refuses new agent commands meanwhile.
- `POST /internal/browser/control-resume` — atomically end human input and
  ready the agent side for a fresh request lease.
- `POST /internal/browser/agent-access` — web mode only. Body: owner triple,
  `sessionId`, `on`. Every real change bumps `controlGen`, so a late reply cannot
  undo it in Convex. Turning it off also revokes a running command's bridge. New
  agent commands and agent reloads get `agent_access_off`.
- `POST /internal/browser/profile-summary` — body: owner triple, `profileId`,
  `profileKey`. Returns `{ ok: true, exists, savedAt, truncated, sites }`, where
  `sites` is `{ domain, cookies }[]` sorted by domain. Never names or values.
- `POST /internal/browser/profile-clear` — the same body plus `domain`. Removes
  the cookies of that site and its subdomains and returns `{ ok: true, removed }`.
  `savedAt` stays.
- Summary and clear refuse `busy` while a session is live in that object, and
  `profile_unreadable` when the stored bytes do not decrypt with this key.
  Clear also refuses `busy` if the stored bytes changed while it worked.
- `POST /internal/browser/profile-delete` — body: owner triple, `profileId`.
  Returns `{ ok: true, deleted: true }`, also when nothing was stored. It ends a
  live session of the same profile without saving. Works while disabled.
- `POST /internal/browser/download-info` — body: owner triple, `sessionId`,
  `downloadId`. Returns `{ ok: true, name, size, contentType, origin }` for a held
  human download. `origin` is the origin of the download URL, or `null` for
  `data:`. Refuses `download_gone` when the id is unknown, expired, or pushed.
- `POST /internal/browser/download-push` — the same body plus `url` (https,
  8192 characters max) and `headers` (up to 20 plain headers). The runner
  `PUT`s the bytes to `url` with those headers and `If-None-Match: *` (60 s
  limit), then
  frees them: `{ ok: true }`. A 412 counts as saved. A second push of a pushed
  id answers `{ ok: true }` without a new `PUT`. A failed `PUT` refuses
  `download_push_failed` and keeps the bytes until the 2-minute expiry. The
  expiry waits for a push that is still running.
- `POST /internal/browser/upload-fill` — body: owner triple, `sessionId`,
  `chooserId`, `controlGen`, `files` (1–10 of `{ name, contentType, url }`,
  https URLs). The runner reads all URLs at the same time (20 MiB total, shared)
  and gives the files to the open file chooser: `{ ok: true }`. The whole fill
  takes at most 120 seconds: the reads stop after 85 seconds (`fetch_failed`),
  then the origin check (5 s) and `setFiles` (30 s) follow. Convex must wait
  longer than 120 seconds. Refusals: `chooser_gone`, `not_human`, `too_large`,
  `fetch_failed`, `too_many_files`.
- `POST /internal/browser/upload-grant` — the same body without `files`.
  Returns `{ ok: true, grantId, expiresAt }`: one computer upload to that
  chooser within 2 minutes. Refusals: `chooser_gone`, `not_human`.
- `PUT /viewer/upload?ownerId=&organizationId=&workspaceId=&grantId=&name=` —
  public, no bearer: the grant is the secret and is used up on the first try.
  Raw body with `Content-Type` and `Content-Length` (20 MiB max). Replies
  `200 { ok: true }` or `4xx { ok: false, code }`: `origin_refused` (403),
  `grant_invalid` (403), `length_required` (411), `too_large` (413),
  `chooser_gone` or `not_human` (409), `invalid_request` (400), `disabled`
  (503, kill switch on), and
  `upload_failed` (400) for a body that breaks, is aborted, or takes over 60
  seconds (the runner then stops reading it). Any other failure answers
  `500 { ok: false, code: "upload_failed" }`, never a bare 500. Every reply after
  the origin check has the CORS headers. CORS: only the origins in
  `BROWSER_APP_ORIGINS`, also for the `OPTIONS` preflight (`PUT` with
  `Content-Type`). A `PUT` without an allowed `Origin` is refused.

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
6. The app renews every ~20 seconds. A grant unrenewed for 90 seconds ends
   the socket, including on a static page. The 90 seconds cover a background
   tab whose 20-second timer runs only once a minute. Session idle and total
   deadlines still apply. Copies, replays, and late renewals fail.
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
- Admission also caps two browsers per user and four per organization
  (`user_limit`, `organization_limit`). A running agent command returns
  `busy_command`. A reload holding the slot returns plain `busy`.
- Usage receipts: when a session record is deleted after its browser was
  acquired, the object stores `usage:<sessionId>` with `providerAcquiredAt`,
  `endedAt`, and the runner's own close reason (`close` for every app close
  request, `expired`, `tainted`, …; not the app's `reason`). `close` and
  `status` return it as `usage`.
  Receipts older than 7 days are deleted at the next close.

## Web mode

Open with `mode: "web"`, `navGen: 1`, `startUrl` (string or null),
`agentAccess`, `profileId` (the Convex profile doc id), `profileKey` (32 bytes,
base64), and `agentBlockedHosts` (up to 50 hosts, 253 characters each). A web
session shows one real tab on the open internet.

- The provider browser has no egress guardrails, `keep_alive` of 10 minutes,
  and recording off. The provider egress proxy still refuses private addresses.
- Every address the runner opens is checked with
  `common/browser-web-url.ts` and `BROWSER_WEB_DENIED_HOSTS`: the start URL
  (refused with `address_blocked` before any browser is acquired), viewer
  navigation, popups, and agent `Page.navigate`. Only `http` and `https`
  are allowed, with no user name or password in the URL.
- Budgets: 60 minutes total, 9 idle minutes, 120 commands. Page navigation
  does not count as activity. Reload reloads the current page and keeps `loadGen`.
- The record keeps the page target id chosen at open. Reconnect keeps that
  page and closes any other page.
- Popups: with no agent command running, the popup closes and its address opens
  in the main page (`notice: popup_opened_here`). During a command it only
  closes (`popup_closed`). A blocked address gives `address_blocked`.
- File choosers and downloads: see Downloads and uploads below.
- Viewer messages may be 16,384 characters. New messages:
  `{ t: "nav", seq, controlGen, action: "go"|"back"|"forward"|"reload"|"stop", url? }`
  (answered by `{ t: "nav-ack", seq, ok, code? }`), and the input kind
  `text.insert` (1–4000 characters, one paste-like call). The object pushes
  `{ t: "location", url, title, loading, canGoBack, canGoForward }`,
  `{ t: "agent-access", on }`, and `{ t: "notice", code }`. The viewer may send
  `{ t: "file-chooser-cancel", chooserId }`.
- After the hello, a web viewer gets the waiting human download
  (`{ t: "download" }`) and the open chooser (`{ t: "file-chooser" }`) again, so
  a viewer that reconnects does not lose them. Convex saves are idempotent per
  `downloadId`.
- The agent bridge removes `Cookie`, `Set-Cookie`, `Authorization`, and
  `Proxy-Authorization` headers and cookie fields from `Network.*` events in
  both modes. In web mode it also allows `Page.navigate`, `Page.reload`,
  `Page.stopLoading`, and history calls, and forces isolated worlds to have
  no universal access. A revoked bridge answers new calls with an error.
- Logs never contain URLs or titles. Error text drops URL query and fragment.

### Saved logins

The object keeps the user's cookies between web sessions in storage key
`profile`: `{ v: 1, profileId, iv, ciphertext, savedAt, truncated }`.

- Encryption: AES-GCM. Key = SHA-256(`BROWSER_PROFILE_KEY` bytes, 0,
  `"browser-profile"`, 0, `profileKey` bytes). The extra data is
  `[profileId, ownerId, organizationId, workspaceId]`, so a blob from another
  owner or profile does not decrypt. The key lives only in memory. After a
  restart of the object, nothing is saved until the next open.
- Restore: at open, after the viewport and before the first page loads, with
  `Storage.setCookies` (no context id). Any failure starts empty.
- Save: `Storage.getCookies` (no context id). Cookies of `BROWSER_WEB_DENIED_HOSTS`
  are dropped. At most 3,000 cookies (the longest-living ones) and 1 MiB of JSON;
  more sets `truncated`. Saves happen at human End (`saveProfile: true`), at idle
  or total expiry, and on viewer renew when people or the agent used the page and
  the last save is over 2 minutes old. Other closes (security, failures, agent
  `browser_close`, profile delete) never save.
- Each put also writes `profileDeleteAt` = `savedAt` + 100 days. The alarm is
  the earliest of the session deadline, `profileDeleteAt`, and the oldest
  tombstone + 7 days. It deletes the profile when it is due. An early alarm
  keeps it.
- A save only writes when no newer save started after it, so a slow periodic
  save never overwrites the End save.
- `profile-delete` writes the tombstone `profileDeleted:<profileId>` first. A save
  checks it right before its put, so a save that raced a delete never brings the
  bytes back. The alarm deletes tombstones after 7 days, also in an object with
  no session and no profile left. Usage receipts are never touched by profile
  code.

### Sites the agent may not use

`agentBlockedHosts` is best effort (the UI says so). A host also covers its
subdomains.

- `run` refuses `agent_blocked_site` when the main page is on a blocked site,
  and `not_ready` when the page cannot be checked.
- During an agent command the host turns on `Fetch` at the request stage for
  page, XHR, and fetch requests and fails requests to blocked sites
  (`BlockedByClient`). When the command settles it drops these patterns. The
  download pattern stays, because one `Fetch.enable` sets the whole list.
- The bridge refuses `Page.navigate` to a blocked site, and history navigation
  to a blocked entry or to an entry it has not seen in a history reply.
- If the page ends on a blocked site, the command result is dropped and `run`
  returns `agent_blocked_site`. The session stays.

### Downloads and uploads

Chrome never saves a file (`Browser.setDownloadBehavior` `deny`). Web mode
catches downloads itself and keeps them only in object memory.

- The host page always has the `Fetch` pattern `{ urlPattern: "*",
  resourceType: "Document", requestStage: "Response" }`. Every pause gets
  exactly one answer, even when a step throws. 3xx, 204, 205, HEAD, and network
  errors continue. A download is `Content-Disposition: attachment` or a type
  Chrome does not show. Chrome shows `text/html`, `text/plain`, `text/css`,
  `text/javascript`, `text/xml`, `application/xhtml+xml`, `application/xml`,
  `application/json`, `application/javascript`, `application/pdf`, `image/png`,
  `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`, `image/avif`,
  `image/bmp`, `image/x-icon`, `image/vnd.microsoft.icon`, `audio/*`, and
  `video/*`. Any other type (for example `text/csv` or `image/tiff`) is a
  download. A response with no type continues. The body is read with
  `Fetch.takeResponseBodyAsStream` and `IO.read`, then the request fails with
  `Aborted`, so the page stays. (`fulfillRequest` is refused after the body is
  taken.)
- A body with fewer or more bytes than its `Content-Length` (when there is no
  `Content-Encoding`) did not finish: it is dropped with `download_failed`. A
  read error or a capture over 30 seconds gives `download_failed` too. A
  timed-out read stops at its next chunk, and the next capture waits until then.
- Safety net: `eventsEnabled` gives `Browser.downloadWillBegin` for downloads
  that skip the network. A `data:` URL is decoded. A same-origin `http(s)` file
  is read again with the page's cookies in an isolated world (no universal
  access) and returned in 1 MiB chunks. Anything else gives
  `download_unsupported`. `blob:` downloads send no event.
- Name: `filename*`, then `filename`, then the last URL path segment, then
  `download`, cut to 255 characters. Convex normalizes it.
- Owner: decided when the download shows up, before any wait. During an agent
  command the download belongs to the command. With a human in control, a
  click, Enter, or address bar "go" in the last 10 seconds allows one
  main-frame download. Anything else (a page timer, a subframe) is dropped with
  `download_blocked`.
- Caps: 25 MiB per human file, 8 MiB per agent file, 20 files and 100 MiB per
  session, one capture at a time, 3 starts per 10 seconds, and one unclaimed
  human download. Notices: `download_too_large` (file cap), `download_limit`
  (session caps, rate, one at a time), `download_busy` (unclaimed download).
- A human download is pushed to the viewers as
  `{ t: "download", downloadId, name, size, contentType }`. Convex saves it with
  `download-info` and `download-push`. Unclaimed after 2 minutes or at close, it
  is dropped with `download_lost`. A push that is still running decides first:
  `download_lost` comes only when that push fails.
- Agent downloads come back in the `run` result as
  `downloads: [{ name, contentType, dataBase64 }]`. `run/finish` waits for
  captures and safety-net checks that are still running, so a download from the
  command's last step joins its result. They share the limit of 8 files and 8
  MiB with `files` (files first). Downloads of the command that were refused
  (caps, `download_failed`, `download_unsupported`) or dropped by that limit are
  counted in `downloadsDropped` (absent when 0).
- File choosers: in human control only, a chooser with an input element is
  pushed as `{ t: "file-chooser", chooserId, multiple, accept, origin }`
  (`accept` is the raw attribute, 512 characters max; `origin` is the frame
  origin). A chooser is gone after a main-frame navigation, a `controlGen`
  change, 5 minutes, a fill, or a cancel, with `{ t: "file-chooser-closed",
  chooserId }`. A new chooser replaces the old one. During agent commands the
  snippet handles its own choosers. A chooser with no input element gives
  `upload_unsupported`.
- A fill checks the frame origin after reading the files, and then the chooser
  again right before `setFiles`, so a chooser that closed during the origin
  check gets no files. `multiple: false` takes exactly one file. A computer
  upload gives one file.
- Cancel dispatches a `cancel` event on the input, like a closed Chrome
  dialog, and keeps the page's current files.
- Logs never contain file names, URLs, or hosts.

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
  registered page and its attached frames/workers. Service and shared workers get
  no session: the bridge resumes and detaches them. It does not wait for those
  replies, because Chrome drops the resume reply once the detach closes the worker. It blocks `Cloudflare.*`,
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
| `BROWSER_PROFILE_KEY`    | secret (required) | 32 random bytes, base64. One half of the saved-cookie key.     |
| `BROWSER_RUNNER_DISABLED`| var (optional)    | Set to `"true"` to refuse new work (503 kill switch).          |
| `BROWSER_PREVIEW_URL`    | var               | The `/v0` runtime URL the browser bytes come from.             |
| `BROWSER_WEB_DENIED_HOSTS` | var             | Comma list of hosts web mode may not open (and their subdomains). |
| `BROWSER_APP_ORIGINS`    | var               | Comma list of app origins allowed to call `PUT /viewer/upload` (CORS). |
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
