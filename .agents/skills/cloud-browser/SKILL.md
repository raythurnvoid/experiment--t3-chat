---
name: cloud-browser
description: Shared cloud browser for one selected HTML file (Cloudflare Browser Run + trusted runner + Playwright isolate, Convex session doors, Files viewer, agent tools, private results). Use when changing browser sessions, viewer/handoff behavior, browser agent tools, result privacy, or the Files browser panel.
---

# Source Of Truth Files

- `../../../packages/browser-runner/src/index.ts` (trusted Worker: sessions, isolate, viewer gateway)
- `../../../packages/browser-runner/src/agent-connection.ts` (trusted command protocol and cleanup)
- `../../../packages/app/convex/files_browser.ts` (Convex doors), `../../../packages/app/server/files-browser.ts` (runner client)
- `../../../packages/app/convex/schema.ts` (`files_browser_sessions`, `ai_chat_browser_results`, `files_browser_draft_captures`)
- `../../../packages/app/src/components/files/file-node-view/files-browser.tsx` (panel + viewer), `../../../packages/app/src/lib/files-browser-stream.ts` (socket client)
- `../../../packages/app/server/server-ai-tools.ts` (browser tools), `../../../packages/app/convex/ai_chat.ts` (binding, scrub, per-step checks)

# Architecture

One cloud page per selected HTML file, shared by the user and the agent. V1 is file-only: the page loads local file bytes, snippets cannot navigate or open pages, popups are blocked, and only `esm.sh` escapes the sandbox. The local Preview stays separate and starts no cloud use.

- The runner owns the provider browser, snippet isolation (Dynamic Worker), leases, deadlines, and the viewer gateway. The Convex app never touches provider credentials.
- Cloudflare guardrails own the network allowlist outside snippet code. A blocked navigation can change `page.url()` while returning a 403 guardrails page; check the response status and headers before calling it a network escape. The runner checks the registered page after command errors too and closes it if the check fails.
- A session loads exactly one file and source kind (`saved`, `proposed`, `draft`). Switching files ends the old session; edits only raise the Updates badge. Switching kinds needs a new Start. Reload re-reads the same kind (drafts need a fresh editor capture first).
- Control states: `starting`, `ready` (agent may act), `agent` (command running, runner-side only — the doc stays `ready`), `pausing` (take during a run), `human`, `closing`, `closed`. Generations (`navGen`, `loadGen`, `controlGen`) freeze per request; anything stale is refused, never rebound.
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
- Results: `store_browser_result` (internal), `read_browser_result` (action, signed URLs), `list_browser_results` and `browser_result_file` (queries for Files links). Creator-only with expiry; a copied id degrades to a placeholder.
- Cleanup: `cleanup_expired_browser_docs` cron plus workspace/user purge batches that enqueue exact-key R2 deletes.

# Viewer Protocol

- WebSocket `/viewer/stream` carries non-secret `ownerId`, `organizationId`, and `workspaceId` query fields to route it to the session Durable Object. The grant stays in the first JSON hello (`ownerId`, `organizationId`, `workspaceId`, `grantId`, `host: docked | detached`), due within 5 seconds. The object checks URL, hello, and stored scope match. It owns the sockets and answers `{t:"hello"}` with `viewerId`, viewport, control, and `controlGen`. No provider credentials or raw CDP surface reach the client.
- One shared CDP screencast produces JPEG frames for all viewers. Each `{t:"frame", seq, loadGen}` immediately precedes its binary JPEG. The client sends `{t:"frame-ack", seq}` after the synchronous frame callback, including on callback failure before closing. This confirms delivery, not decode or paint. Each viewer has at most two frames in flight; ACKs match the oldest first. Only the latest waiting frame is kept, so a slow viewer cannot block others. A new viewer gets the cached frame on a static page.
- `{t:"control"}` pushes control changes. `{t:"viewport", viewport}` precedes frames for a new load or size. Binary frames need adjacent valid metadata; viewport changes and close clear pending metadata. The producer applies the stored viewport. Start and stop are serialized; reload, viewport changes, and every completed agent command restart it. Agent tracing can replace the screencast, so the command stays locked through restart and a fresh session check before handoff.
- Client input is `{t:"input", seq, controlGen, loadGen, kind, ...}` (`mouse.move/click/down/up`, `wheel`, `key.press/down/up/type`). The client uses its observed control and last delivered image load. One ordered queue checks both generations and the durable lease, saves activity, and re-checks control before Playwright. It sends `{t:"input-ack", seq, ok, timings}` with queue, authorization, producer-ready, and apply durations. Only moves to the last applied position are skipped after authorization. Take, Resume, Reload, agent begin, and input-holder detach reject stale queued input, drain current input, and release held buttons and keys. Input failure or timeout closes the session. Close invalidates queued input and ends the page.
- Authenticated viewers may send `{t:"ping", seq}` once per second. The reply is `{t:"pong", seq}`. This reads no storage, calls no provider, and extends no deadline. Use it to separate socket latency from input work.
- The last viewer leaving stops the producer. Detach writes are ordered; command finish and reload wait for that cleanup before saving. Provider failure during held or in-flight input ends the session. Grant and session deadlines close sockets even without frames. Close codes: 4401 bad grant, 4404 session gone, 4408 grant expired, 1011 stream failure.
- The trusted Playwright connection remains open for input and command checks. Stream restarts use a new CDP session, so old frames cannot cross a load boundary. Viewport restore writes trusted device metrics explicitly because Playwright's cached size may miss another connection's changes.

# Agent Tools

`browser_run` (inspect/test via a Playwright snippet with `page, frame, expect, emitImage`), `browser_reload`, `browser_close`. Bound per request from the client's frozen `browserSessionId`; at most 20 commands and 20 KB of code per call. Storage keeps status plus an opaque result id; the model re-reads text and images through authorized conversion every time. Screenshots use AI SDK `image-data` so OpenAI receives image input. See the `ai-chat-agent` skill for the stream scrub, history rules, and per-step checks.

The server refreshes runner metadata once before freezing a new chat request's generations. Per-step checks never refresh or rebind that started request. Queued absence stays absent.

# UI

- Files panel (`files-browser.tsx`): Start card with source picker, status/controls/meta, live viewer, results list, renew loop. Editor/browser split keeps the editor mounted across toggles; focus collapses it; popout is a session-bound child route with attach → take → close transfer.
- A new socket hello replaces the previous socket's control. The newest control generation wins across the query and stream; a completed human handoff wins over pausing at the same generation. Grant renewal depends on session/viewer identity, so Take and metadata updates cannot restart its timer.
- A session-ended socket close retires that exact app session through `end_browser`, so idle expiry returns to Start even when it stops the renewal timer first. A viewer-moved close leaves the session live.
- The Files selection owner ends the previous session when another file or folder is selected. The popout receives the opener's selected chat through messages checked against origin, opener, and session id.
- `Open browser` selects the editor view and opens its browser panel, including from Preview or File details. The existing editor draft stays mounted.
- Chat is text-only: status plus an authorized file link (`Open in Files` on the chat page, `Open browser` in Files). Images and observations never render in chat.
- Stop aborts the stream, which is the lease release; queued bindings stay frozen per message.
- Queued absence is frozen too: a message queued with no browser does not adopt one opened later.

# Limits

One active browser per owner/workspace (two per workspace, ten per deployment); one command at a time; 30 s per command; 20 min total; 5 min idle (viewing alone never extends it); 20 commands per request, 60 per session; 32 loads and 8 MiB total HTML per session; 900,000-byte HTML cap; 2 images per call at 2 MiB, 16 Mpx, 8192 px edge. Daily per-workspace brakes: 30 fresh starts, 100 draft captures (date-keyed docs, swept after two days). Per-minute metering is future work.

# Runbook

- Env (Convex deployment): `BROWSER_RUNNER_URL`, `BROWSER_RUNNER_SECRET`, `AI_CHAT_BROWSER_ENABLED=true`. Runner secrets live in Wrangler, never in app code.
- Child bundle: retain class/function names with `--keep-names` and retain identifier names by using only `--minify-whitespace --minify-syntax`. Playwright serializes its screenshot helper into the page with `__name`; renaming that helper breaks `page.screenshot()`. Follow the [external scratch build commands](../../../packages/browser-runner/README.md#develop--deploy). The generated-bundle regression runs the actual helper and checks caret hiding and cleanup.
- Deploy the runner: `vp env exec pnpm --dir packages/browser-runner run deploy -- --env dev`. Tail it: `vp env exec pnpx wrangler tail bonobo-senate-browser-runner-dev`.
- Convex pushes through the normal `convex dev` watcher. The browser feature flag gates tools and runner calls; the UI degrades to errors when off.
- Live QA: open an HTML file in Files, Start, take control, drive the page, resume, then ask the Files agent to inspect it. Stay inside the 5-minute idle window or re-Start. The Playwriter recipe lives in `../app-playwriter-harness/references/files.md` under "Shared Cloud Browser End To End".
- Stream QA: check two viewers, slow delivery, a static page, reload, viewport changes, held-input handoff, and recovery after agent screenshots and tracing. Use at least 20 native counter clicks in a visible tab. Measure the time from each click to the changed image loading and report median and p95; this is not screen paint. Aim toward 100 ms, with p95 at or below 500 ms.
