# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Use `pnpx playwriter`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read and append skill files.
- Use extension mode by default. Do not use direct CDP unless the user explicitly asks for it.
- This repo forbids Bun and `bunx`; translate any Playwriter docs that mention `npx`/`bunx` to `pnpx playwriter`.
- In PowerShell, prefer `pnpx playwriter -s $session --% -e "..."` for Playwriter execute calls. Put `--%` after `-s $session` so PowerShell expands the session id but keeps JavaScript quotes intact.
- When `--%` is not usable, keep `-e` snippets very small and verify a trivial string command first, for example `console.log('hello')`.
- Avoid JavaScript template literals in PowerShell `-e` snippets. PowerShell treats backticks as escapes, so use string concatenation or put the script in a file/here-string before passing it to Playwriter.
- `pnpx playwriter session new` can print status text plus the session id. Parse the `Session <id> created` line instead of using the whole trimmed output as the id.
- If multiple Edge profiles are reported, choose the explicit `--browser profile:<key>` value. Do not use the auto-selected profile when Playwriter says multiple browsers were detected.
- For long or assertion-heavy Playwriter flows, write the JavaScript to a temporary file and run `pnpx playwriter -s $session -f $scriptPath --timeout <ms>`; this avoids PowerShell quote corruption and makes reruns safer.
- If the user says the extension is active but `pnpx playwriter browser list` reports `No browsers detected`, restart the relay with `pnpx playwriter serve --host localhost --replace`, then check again. If the relay still sees no extension, start a managed Edge profile with Playwriter's bundled extension: `pnpx playwriter browser start "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir $env:TEMP\playwriter-t3-chat-profile --headed`. Then run `pnpx playwriter browser list`, create a session with the reported `install:Edge:<id>` key, and navigate the target URL from that session.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use `hitTest(...)` or `inspectElement(...)` to identify the topmost element instead of retrying alternate selectors.
- If a visible button is blocked by a text-only tooltip portal, inspect `document.elementFromPoint(...)` at the button center. Tooltip content and its portal wrapper should have `pointer-events: none`; check `packages/app/src/components/my-tooltip.css` before working around it in Playwriter.

## App State

- Viewport and sidebar state may persist between sessions through browser storage.
- Main sidebar open/collapsed state is persisted in localStorage keys documented in `app-map.md`.
- Rapid files-tree create/move/archive sequences can hit the `files_tree_write` rate limiter. If a create dialog stays open with `Rate limit exceeded`, wait for the retry window, keep the dialog open, and submit the same draft again instead of restarting the flow.
- If using a temporary localhost tab, save `app::auth::anonymous_token` and `app::auth::anonymous_token_user_id` before clearing them to mint a fresh anonymous QA session. Restore both keys before closing the QA tab.
- Close only the localhost tabs created for QA. Leave unrelated user tabs open.

## R2 Upload Observability

- Browser R2 uploads can record both a `200` response and a `requestfailed` entry with `net::ERR_ABORTED` for the same signed `PUT`. Treat durable Convex state and generated file visibility as the source of truth when the `200` completed and conversion finalized.
- For generated PDF output QA, capture Cloudflare request metadata by filtering network entries whose origin contains `cloudflarestorage`; record method, origin, pathname, response status, and failure text without logging signed query strings.
- Conversion can finish quickly. To verify the pending generated output screen, poll for `<source>.pdf.md` every ~100ms immediately after upload and click it as soon as it appears. If content finalizes before the click, record that the pending state was too fast to observe and rely on backend tests for that state.


## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect `.MainAppSidebar` and `.MySidebar-state-closed` together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.
