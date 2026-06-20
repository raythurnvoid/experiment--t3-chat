# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Use `pnpx playwriter`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read and append skill files.
- In this repo, run Playwriter through Vite Plus, for example `& "$env:USERPROFILE\.vite-plus\bin\vp.exe" exec -- pnpx playwriter session new`.
- Do not use `vp exec -F t3-chat-clone-app -- pnpx playwriter session new` when the flow needs `.agents/skills/**`; the package-filtered session cwd becomes `packages/app` and cannot read repo-root harness files.
- Use extension mode by default. Do not use direct CDP unless the user explicitly asks for it.
- This repo forbids Bun and `bunx`; translate any Playwriter docs that mention `npx`/`bunx` to `pnpx playwriter`.
- In PowerShell, prefer `pnpx playwriter -s $session --% -e "..."` for Playwriter execute calls. Put `--%` after `-s $session` so PowerShell expands the session id but keeps JavaScript quotes intact.
- When `--%` is not usable, keep `-e` snippets very small and verify a trivial string command first, for example `console.log('hello')`.
- Through `vp env exec ... pnpx.CMD playwriter`, `--% -e` can still misparse JavaScript with object literals or arrow functions. Use `-f` runner files for any nontrivial probe, even when the script is only a few lines.
- Avoid JavaScript template literals in PowerShell `-e` snippets. PowerShell treats backticks as escapes, so use string concatenation or put the script in a file/here-string before passing it to Playwriter.
- `pnpx playwriter session new` can print status text plus the session id. Parse the `Session <id> created` line instead of using the whole trimmed output as the id.
- If multiple Edge profiles are reported, choose the explicit `--browser profile:<key>` value. Do not use the auto-selected profile when Playwriter says multiple browsers were detected.
- The t3-chat app tabs live in the personal Edge profile (`profile:909172d3ee56c25e`). With both profiles connected, the Playwriter MCP fails with "Multiple extensions connected" — use the raw CLI with the explicit profile key for every session.
- Extension mode can be connected and able to create/control its own blank tab while `bindOpenTab({ urlIncludes: 'localhost:5173' })` still fails because the existing app tab was not Playwriter-enabled. If CDP `http://127.0.0.1:9222/json/list` shows the target tab and extension binding cannot see it, either enable Playwriter on that tab or use direct CDP as the documented fallback; when the dev server is down, the same tab may appear to Playwright as `chrome-error://chromewebdata/` with title `localhost`.
- For long or assertion-heavy Playwriter flows, write the JavaScript to a temporary file and run `pnpx playwriter -s $session -f $scriptPath --timeout <ms>`; this avoids PowerShell quote corruption and makes reruns safer.
- If a temp Playwriter runner needs dynamic input, write that input to the OS temp directory and have the runner read it by fixed path. Do not assume PowerShell environment variables are available inside the Playwriter sandbox.
- Playwriter execute snippets do not automatically provide Playwright Test's `expect`. Use manual polling or import only the small assertion utility you need.
- If the user says the extension is active but `pnpx playwriter browser list` reports `No browsers detected`, restart the relay with `pnpx playwriter serve --host localhost --replace`, then check again. If the relay still sees no extension, start a managed Edge profile with Playwriter's bundled extension: `pnpx playwriter browser start "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir $env:TEMP\playwriter-t3-chat-profile --headed`. Then run `pnpx playwriter browser list`, create a session with the reported `install:Edge:<id>` key, and navigate the target URL from that session.
- After restarting the relay with `--host localhost`, include `--host localhost` on subsequent `playwriter` commands. For direct CDP sessions through that relay, auto-discovery is treated as remote; read `http://127.0.0.1:9222/json/version` and pass the explicit `webSocketDebuggerUrl` to `session new --direct`.
- Edge can relaunch itself after an OS/Edge upgrade (`--os-upgraded-session` on the main process), dropping the personal-profile window and the Playwriter extension (`not connected`, exit 9); active sessions die. Recovery: follow CLAUDE.md 10a and run `node C:\Users\rt0\.cursor\skills\edge-remote-debugging-mcp\scripts\start-edge-personal-browser.mjs` (safe — opens a window in the running instance, no kill), confirm `pnpx playwriter browser list` shows the personal profile key again, create a new session with `--browser profile:<key>`, then re-bind the app tab and re-install helpers.
- Fresh Playwriter sessions start with an empty `state` (`{}`); executor scripts receive a bare global `context` (the Playwright BrowserContext), not `state.context`. Bind with `context.pages()` / `context.newPage()` and assign `state.page` yourself before relying on it.
- A React render loop can overwhelm the Playwriter relay and make the tab appear frozen. Check `getLatestLogs({ search: /Maximum update depth|too much recursion|render/i })` and the relay/CDP logs before retrying. After fixing the app loop, close or kill only the stuck localhost renderer tab, restart the relay with `pnpx playwriter serve --host localhost --replace`, recreate/bind a session, and reload the `/files` route.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use `hitTest(...)` or `inspectElement(...)` to identify the topmost element instead of retrying alternate selectors.
- If a visible button is blocked by a text-only tooltip portal, inspect `document.elementFromPoint(...)` at the button center. Tooltip content and its portal wrapper should have `pointer-events: none`; check `packages/app/src/components/my-tooltip.css` before working around it in Playwriter.

## Backgrounded Tabs

- On a backgrounded localhost tab, `snapshot()`, `screenshot()`, and `innerText` are unreliable. Read state via `evaluate()` with `textContent`, `getComputedStyle`, and `getBoundingClientRect`.
- `locator.click()` on popover triggers can hang on a backgrounded tab. Prefer foregrounding the tab; if that is not possible, DOM `el.click()` is the documented exception to the no-`element.click()` rule (see `agent-panel.md`).
- Convex deploy (`convex dev --once`) and Vite HMR can blank a backgrounded tab entirely (empty body, all selectors gone). Recover with the reload recipe in `agent-panel.md` before the next interaction.
- Hidden hoisted modals keep `aria-busy="true"` while closed (0x0 rect). Busy/idle checks must count only visible `aria-busy` elements or they will report busy forever.

## App State

- Viewport and sidebar state may persist between sessions through browser storage.
- Main sidebar open/collapsed state is persisted in localStorage keys documented in `app-map.md`.
- Agent `New chat` creates a client-only `ai_thread-*` tab before Convex persists the real thread. If cleanup removes that optimistic tab too early, sends land in an older chat or the tab appears to vanish. If reload restores it, verify the tab still has an optimistic session and the first `/api/chat` request uses `clientGeneratedThreadId`.
- Multi-file agent setup prompts can overstate success. For corpus generation or bulk QA data, keep batches small and verify persisted file nodes through the app Convex client after each batch.
- Rapid AI chat sends can hit the `/api/chat` rate limiter and produce a recoverable `429` response with `retryAfterMs`. Wait for that window and click the visible `Retry` button for the same draft instead of sending a duplicate prompt.
- The chat stop control is labelled `Stop generating`. Playwriter waits that look for `Stop generation` will miss the running state and can send the next prompt too early, producing avoidable `429` failures or branched transcript confusion.
- Keep AI chat Playwriter scripts short when exercising multiple LLM turns. Long monolithic execute calls can lose the Playwriter relay connection with `fetch failed`; prefer one prompt per execute or a small batch with clear idle waits.
- Rapid files-tree create/move/archive sequences can hit the `files_tree_write` rate limiter. If a create dialog stays open with `Rate limit exceeded`, wait for the retry window, keep the dialog open, and submit the same draft again instead of restarting the flow.
- If using a temporary localhost tab, save `app::auth::anonymous_token` and `app::auth::anonymous_token_user_id` before clearing them to mint a fresh anonymous QA session. Restore both keys before closing the QA tab.
- Close only the localhost tabs created for QA. Leave unrelated user tabs open.

## R2 Upload Observability

- Browser R2 uploads can record both a `200` response and a `requestfailed` entry with `net::ERR_ABORTED` for the same signed `PUT`. Treat durable Convex state and generated file visibility as the source of truth when the `200` completed and conversion finalized.
- For generated PDF output QA, capture Cloudflare request metadata by filtering network entries whose origin contains `cloudflarestorage`; record method, origin, pathname, response status, and failure text without logging signed query strings.
- Conversion can finish quickly. To verify the pending generated output screen, poll for `<source>.pdf.md` every ~100ms immediately after upload and click it as soon as it appears. If content finalizes before the click, record that the pending state was too fast to observe and rely on backend tests for that state.


## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect `.MainAppSidebar` and `.MySidebar-state-closed` together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.
