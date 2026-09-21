---
name: cloud-browser
description: Shared cloud browser for one selected HTML file (Cloudflare Browser Run, trusted runner, Files viewer, agent tools, pending file output). Use when changing browser sessions, viewer handoff, browser tools, screenshot privacy, or the Files browser panel.
---

# Source Of Truth Files

- `../../../packages/browser-runner/src/index.ts` (trusted Worker: sessions, isolate, viewer gateway)
- `../../../packages/browser-runner/src/agent-connection.ts` (trusted command protocol and cleanup)
- `../../../packages/app/convex/files_browser.ts` (Convex doors), `../../../packages/app/server/files-browser.ts` (runner client)
- `../../../packages/app/convex/schema.ts` (`files_browser_sessions`, `files_browser_draft_captures`, normal Files proposals and assets)
- `../../../packages/app/src/components/files/file-node-view/files-browser.tsx` (panel + viewer), `../../../packages/app/src/lib/files-browser-stream.ts` (socket client)
- `../../../packages/app/server/server-ai-tools.ts` (browser tools), `../../../packages/app/convex/ai_chat.ts` (binding, scrub, per-step checks)
- `../../../packages/app/server/files-ingestion.ts` (shared file writer), `../../../packages/app/convex/files_ingestion.ts` (retry receipts and cleanup), `../../../packages/app/server/ai-chat-file-tools.ts` (image reads)

# Architecture

One cloud page per selected HTML file, shared by the user and the agent. V1 is file-only: the page loads local file bytes, snippets cannot navigate or open pages, popups are blocked, and only `esm.sh` escapes the sandbox. The local Preview stays separate and starts no cloud use.

- The runner owns the provider browser, snippet isolation (Dynamic Worker), leases, deadlines, and the viewer gateway. The Convex app never touches provider credentials.
- Cloudflare guardrails own the network allowlist outside snippet code. A blocked navigation can change `page.url()` while returning a 403 guardrails page; check the response status and headers before calling it a network escape. The runner checks the registered page after command errors too and closes it if the check fails.
- A session loads exactly one file and source kind (`saved`, `proposed`, `draft`). Switching files ends the old session; edits only raise the Updates badge. Switching kinds needs a new Start. Reload re-reads the same kind (drafts need a fresh editor capture first).
- Control states: `starting`, `ready` (agent may act), `agent` (command running, runner-side only — the doc stays `ready`), `pausing` (take during a run), `human`, `closing`, `closed`. Each command checks its exact generations (`navGen`, `loadGen`, `controlGen`). A successful agent reload advances the turn binding only to the generations returned by that reload. It never adopts another live session or takeover.
- Detaching the last input holder releases `human` back to `ready` (never to agent work). A stale command closes its browser: a lost caller does not prove its work stopped. Every host run path finishes its command (`try/finally`); duplicates are harmless.
- Each agent command has one durable connection grant. The child sees an app session id, never the provider id. The trusted protocol bridge allows only the assigned page and its attached frames/workers. It refuses provider methods, raw CDP attachment, target creation, protocol tunnels, downloads, and provider file paths. Normal page actions, screenshots, and context tracing remain supported.
- Before returning output, the runner revokes the grant, drains accepted protocol calls, removes command scripts/bindings, and releases held input. It then checks Chromium's target/context inventory plus the controller URL and nonce. Only a settled command may release its lock. Lost or uncertain cleanup closes that exact browser; a restart cannot reuse an unproven connection.
- The trusted connection watches page navigation and popups for the whole session, including timers left after a command. Main-page navigation closes the session unless it belongs to a trusted reload. Popups close without ending the assigned page. Reconnect checks the full target/context inventory, controller URL, and nonce after installing listeners. Reload waits for that check and uses the same connection. An admitted reload failure closes that exact session because navigation may already have changed the page.
- A child socket close or error revokes new commands but leaves the provider connection open for draining and cleanup. Provider errors and failed cleanup close the session. The host still closes on isolate timeout or missing results.

# Convex Doors

- `start_browser` (action): explicit Start only; reattaches the same live file/source/nav generation, otherwise `Browser busy`. Draft bytes arrive through `capture_browser_draft` + storage upload + `attach_draft_capture_blob`.
- Start and failed viewer grants/renewals ask the runner whether the session is still alive. Status and renew include current source/control generations and deadlines. Convex copies these values; it does not invent load generations. Source and control merge separately, so delayed replies cannot undo a newer load or takeover. Confirmed loss retires the app doc so Start can recover. An old mirrored idle deadline alone does not prove loss: human input can extend it at the runner.
- `current_browser_session` (query): the owner's live session or null. `browser_source_current_version` feeds the Updates badge.
- `grant_browser_viewer` / `renew_browser_viewer`: single-use short grants plus the socket URL. Renew re-checks access on a timer; refusal closes the stream. Renew also mirrors runner-led control changes (detach release, pausing finish) back to the session doc.
- `take_browser_control` / `resume_browser_agent` (agent resume authorizes the sidebar's selected chat), `reload_browser`, `keep_open_browser`, `end_browser`.
- Agent reload and close carry `expectedAgentLease` through Convex to the runner. The runner checks ready control plus the frozen control/load/navigation generations before accepting them. Take during an accepted reload waits for it to finish; an overdue reload closes the page before input can resume. Human buttons omit the agent-only guard.
- Viewer-side doors re-check live file access and close the session on loss (revoke, archive, delete, type change). The agent lease check refuses the same way without closing.
- File output uses thin internal `prepare_file_output` and `finalize_file_output` doors. They call the shared `files_ingestion` backend. Files owns paths, collision names, text or stored content, reservations, retry receipts, and cleanup. Fresh prepare and finalize check the browser source and exact lease in the same transaction. A completed retry needs current Files read access but no live browser. Abort retires only unfinished work. Stored holds remain until exact-key deletion settles after the last possible PUT.
- Cleanup: the browser cron keeps draft/session/daily-counter cleanup. Screenshots follow normal Files expiry, Discard, Save and purge. Saved screenshots stay until deleted.

# Viewer Protocol

- WebSocket `/viewer/stream` carries non-secret `ownerId`, `organizationId`, and `workspaceId` query fields to route it to the session Durable Object. The grant stays in the first JSON hello (`ownerId`, `organizationId`, `workspaceId`, `grantId`, `host: docked | detached`), due within 5 seconds. The object checks URL, hello, and stored scope match. It owns the sockets and answers `{t:"hello"}` with `viewerId`, viewport, control, and `controlGen`. No provider credentials or raw CDP surface reach the client.
- One shared CDP screencast produces JPEG frames for all viewers. Each `{t:"frame", seq, loadGen}` immediately precedes its binary JPEG. The client sends `{t:"frame-ack", seq}` after the synchronous frame callback, including on callback failure before closing. This confirms delivery, not decode or paint. Each viewer has at most two frames in flight; ACKs match the oldest first. Only the latest waiting frame is kept, so a slow viewer cannot block others. A new viewer gets the cached frame on a static page.
- `{t:"control"}` pushes control changes. `{t:"viewport", viewport}` precedes frames for a new load or size. Binary frames need adjacent valid metadata; viewport changes and close clear pending metadata. The producer applies the stored viewport. Start and stop are serialized; reload, viewport changes, and every completed agent command restart it. Agent tracing can replace the screencast, so the command stays locked through restart and a fresh session check before handoff.
- Client input is `{t:"input", seq, controlGen, loadGen, kind, ...}` (`mouse.move/click/down/up`, `wheel`, `key.press/down/up/type`). The client uses its observed control and last delivered image load. One ordered queue checks both generations and the durable lease, saves activity, and re-checks control before Playwright. It sends `{t:"input-ack", seq, ok, timings}` with queue, authorization, producer-ready, and apply durations. Only moves to the last applied position are skipped after authorization. Take, Resume, Reload, agent begin, and input-holder detach reject stale queued input, drain current input, and release held buttons and keys. Input failure or timeout closes the session. Close invalidates queued input and ends the page.
- Authenticated viewers may send `{t:"ping", seq}` once per second. The reply is `{t:"pong", seq}`. This reads no storage, calls no provider, and extends no deadline. Use it to separate socket latency from input work.
- The last viewer leaving stops the producer. Detach writes are ordered; command finish and reload wait for that cleanup before saving. Provider failure during held or in-flight input ends the session. Grant and session deadlines close sockets even without frames. Close codes: 4401 bad grant, 4404 session gone, 4408 grant expired, 1011 stream failure.
- The trusted Playwright connection remains open for input and command checks. Stream restarts use a new CDP session, so old frames cannot cross a load boundary. Viewport restore writes trusted device metrics explicitly because Playwright's cached size may miss another connection's changes.

# Agent Tools

`browser_run` exposes only required `code`. The snippet receives `page`, `frame`, `expect`, and `emitFile`. `browser_reload` and `browser_close` take empty objects. These tools bind to the message's selected `browserSessionId`. Each request allows 20 run commands, with 20 KB of code per call.

In Agent mode, `emitFile({path:"/reports/page.png",bytes:await page.screenshot(),contentType:"image/png"})` proposes a screenshot. The same helper accepts any file bytes, including empty files. It copies `Uint8Array` or `ArrayBuffer` input at emission. Paths are explicit canonical Files paths; there is no default browser output folder. Ask mode refuses emitted files before reserving storage, with status `errored` and reason `agent_required`.

The shared writer validates the whole output list, then creates items one at a time. Valid editable UTF-8 becomes normal private text through sealed pending states. Other content stays exact stored bytes. Name collisions get bounded suffixes. A later item failure or Stop keeps earlier completed files and reports a partial result. Completed files follow normal Save, Discard, and expiry rules; browser closure and retry-receipt cleanup do not delete them.

Execution stores raw browser observations only in the current turn's map, keyed by tool call ID. Its returned result has safe status, reason, tagged Files targets, and optional capped display text under `metadata.debug` (code 4,000, result 8,000, console 2,000, page errors 1,000, error 1,000; 16,000 total; empty fields omitted). Stored `input` is still `{}` and `part.input.code` is never used by the UI. `toModelOutput` reads that map without I/O. Before every provider call, the server rechecks the exact captured source and lease and replaces stale message content with safe text. Text markers carry no authority. Chat storage, history replay, and titles never rebuild raw observations or image bytes, and `file_stored` never sends debug text to the model. Old results without debug remain valid.

`view_image({path})` reads a PNG, JPEG, WEBP, or GIF in either mode without a browser session. It has an explicit SDK `strict: true` object schema with one required Files path. Execute checks current Files access and the exact source before and after the bounded read, then keeps pixels in the same private turn map. Screenshots are ordinary Files output; call `view_image` to inspect them. Read text with Bash and other bytes through `execute_code` and `/api/v1/files/read-bytes`. See `ai-chat-agent` for limits and provider conversion.

The server refreshes runner metadata once when binding a new turn. Step checks compare the current turn binding without refreshing it. Only the exact successful agent reload may advance it. A takeover, end, or changed lease removes browser tools from the next provider step; other tools and the final reply continue. Each tool still checks its own lease at execute time. A message queued without a browser stays unbound.

Files paths use `/` as the workspace root. A Files output at `/tmp/report.png` is a normal reviewable file. Bash `/tmp` is separate per-thread scratch; its Files counterpart is `/home/cloud-usr/w/<organization>/<workspace>/tmp/report.png`.

# UI

- Files panel (`files-browser.tsx`): Start card with source picker, status/controls/meta, live viewer and renew loop. Editor/browser split keeps the editor mounted across toggles; focus collapses it; popout is a session-bound child route with attach → take → close transfer.
- A new socket hello replaces the previous socket's control. The newest control generation wins across the query and stream; a completed human handoff wins over pausing at the same generation. Grant renewal depends on session/viewer identity, so Take and metadata updates cannot restart its timer.
- A session-ended socket close retires that exact app session through `end_browser`, so idle expiry returns to Start even when it stops the renewal timer first. A viewer-moved close leaves the session live.
- The Files selection owner ends the previous session when another file or folder is selected. The popout receives the opener's selected chat through messages checked against origin, opener, and session id.
- Browser and file tool cards show safe status and authorized Files links marked `Pending review` or `Saved`. Missing or denied targets show unavailable. File links use normal Files navigation. The browser card may also render capped display sections (Code, Result, Error, Console, Page errors) from `metadata.debug`. Raw lease JSON, provider/session IDs, inline images, and screenshot bytes never render in these cards.
- Private and saved File details share an image preview with expanded Pending rows. Save shows required private folders and submits their exact reviewed versions with the selected image. Other images remain pending. Discard removes only reviewed proposals. Saved origin links keep old chat targets usable after private receipt cleanup, with current Files ACL checks.
- Stop aborts the stream, which is the lease release; queued bindings stay frozen per message.
- Queued absence is frozen too: a message queued with no browser does not adopt one opened later.

# Limits

One active browser per owner/workspace (two per workspace, ten per deployment); one command at a time; 30 s per command; 20 min total; 5 min idle (viewing alone never extends it); 20 commands per request, 60 per session; 32 loads and 8 MiB total HTML per session; 900,000-byte HTML cap. File output allows eight files and 8 MiB total per call. Screenshots have separate trusted bridge limits: PNG/JPEG, 2 MiB each, 16 million pixels, and 8192 pixels per edge. There is no two-capture limit. Daily per-workspace brakes: 30 fresh starts, 100 draft captures (date-keyed docs, swept after two days). Per-minute metering is future work.

# Runbook

- Env (Convex deployment): `BROWSER_RUNNER_URL`, `BROWSER_RUNNER_SECRET`, `AI_CHAT_BROWSER_ENABLED=true`. Runner secrets live in Wrangler, never in app code.
- Child bundle: retain class/function names with `--keep-names` and retain identifier names by using only `--minify-whitespace --minify-syntax`. Playwright serializes its screenshot helper into the page with `__name`; renaming that helper breaks `page.screenshot()`. Follow the [external scratch build commands](../../../packages/browser-runner/README.md#develop--deploy). The generated-bundle regression runs the actual helper and checks caret hiding and cleanup.
- Deploy the runner: `vp env exec pnpm --dir packages/browser-runner run deploy -- --env dev`. Tail it: `vp env exec pnpx wrangler tail bonobo-senate-browser-runner-dev`.
- Convex pushes through the normal `convex dev` watcher. The browser feature flag gates tools and runner calls; the UI degrades to errors when off.
- Live QA: open an HTML file in Files, Start, take control, drive the page, resume, then ask the Files agent to inspect it. Stay inside the 5-minute idle window or re-Start. The Playwriter recipe lives in `../app-playwriter-harness/references/files.md` under "Shared Cloud Browser End To End".
- Stream QA: check two viewers, slow delivery, a static page, reload, viewport changes, held-input handoff, and recovery after agent screenshots and tracing. Use at least 20 native counter clicks in a visible tab. Measure the time from each click to the changed image loading and report median and p95; this is not screen paint. Aim toward 100 ms, with p95 at or below 500 ms.
