# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Run it through Vite Plus: `vp env exec pnpx playwriter`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read harness files and resolve repo-relative paths. Propose documentation memories through the harness, then edit them outside Playwriter with the agent's targeted edit tool.
- In this repo, run Playwriter through Vite Plus, for example `vp env exec pnpx playwriter browser list`.
- Do not use Vite Plus package-filtered execution when the flow needs `.agents/skills/**`; that changes the session cwd to `packages/app` and prevents repo-root harness reads.
- Use extension mode by default. Use direct CDP only when the user asks or when the documented Edge/Playwriter recovery flow requires it. Load the Edge remote-debugging skill before that recovery.
- This repo forbids Bun and `bunx`; translate any Playwriter docs that mention `npx`/`bunx` to `vp env exec pnpx playwriter`.
- In PowerShell, prefer `vp env exec pnpx playwriter -s $session --% -e "..."` for Playwriter execute calls. Put `--%` after `-s $session` so PowerShell expands the session id but keeps JavaScript quotes intact.
- When `--%` is not usable, keep `-e` snippets very small and verify a trivial string command first, for example `console.log('hello')`.
- Through `vp env exec ... pnpx.CMD playwriter`, `--% -e` can still misparse JavaScript with object literals or arrow functions. Use `-f` runner files for any nontrivial probe, even when the script is only a few lines.
- Avoid JavaScript template literals in PowerShell `-e` snippets. PowerShell treats backticks as escapes, so use string concatenation or put the script in a file/here-string before passing it to Playwriter.
- `vp env exec pnpx playwriter session new --browser $browserKey` can print status text plus the session id. Parse the `Session <id> created` line instead of using the whole trimmed output as the id.
- If multiple browsers are reported, do not use auto-selection. Run `vp env exec pnpx playwriter browser list`, identify the browser that exposes the target app tab, and pass its exact full reported key to `--browser`. Current keys can look like `install:Edge:<id>`; do not add a `profile:` prefix or copy an old key from this file.
- Extension mode can be connected and able to create/control its own blank tab while `bindOpenTab({ urlIncludes: 'localhost:5173' })` still fails because the existing app tab was not Playwriter-enabled. If CDP `http://127.0.0.1:9222/json/list` shows the target tab and extension binding cannot see it, either enable Playwriter on that tab or use direct CDP as the documented fallback; when the dev server is down, the same tab may appear to Playwright as `chrome-error://chromewebdata/` with title `localhost`.
- For long or assertion-heavy flows, keep the runner under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/` and run `vp env exec pnpx playwriter -s $session -f $scriptPath --timeout <ms>`. The CLI reads the `-f` file before sandboxed code runs, so the sibling-directory path works. Embed dynamic input in the runner or assign it to `state` in a short separate call. Do not put runners, prompts, or output in the repository or OS temp directory.
- Inside the sandbox, relative output paths such as `page.screenshot({ path })` resolve against a non-repo CWD (observed `C:\Users\rt0`), and `fs.readFileSync` rejects absolute repo paths with "access outside allowed directories" while repo-root-relative read paths work. Read harness files with repo-relative paths and write screenshots/outputs with absolute `C:/Users/rt0/Documents/workspace/rt0/t3-chat-+personal/+ai/...` paths.
- Playwriter execute snippets do not automatically provide Playwright Test's `expect`. Use manual polling or import only the small assertion utility you need.
- If the user says the extension is active but `vp env exec pnpx playwriter browser list` reports `No browsers detected`, use the background relay-restart recipe in `snippets.md`, then check again. If Edge itself must be restarted or direct CDP is required, load `C:/Users/rt0/.cursor/skills/edge-remote-debugging-mcp/SKILL.md` and follow its profile validation and bundled-script workflow. Do not invent an Edge profile path or launch command here.
- After restarting the relay with `--host localhost`, include `--host localhost` on subsequent `playwriter` commands. For direct CDP sessions through that relay, auto-discovery is treated as remote; read `http://127.0.0.1:9222/json/version` and pass the explicit `webSocketDebuggerUrl` to `session new --direct`.
- Edge can relaunch itself after an OS/Edge upgrade (`--os-upgraded-session` on the main process), dropping the profile window and Playwriter extension (`not connected`, exit 9); active sessions die. Load the Edge remote-debugging skill named above and use its verified bundled-script workflow. Then confirm `vp env exec pnpx playwriter browser list` reports the needed browser, pass its exact full key to `--browser`, re-bind the app tab, and re-install helpers.
- Fresh Playwriter sessions start with an empty `state` (`{}`); executor scripts receive a bare global `context` (the Playwright BrowserContext), not `state.context`. Bind with `context.pages()` / `context.newPage()` and assign `state.page` yourself before relying on it.
- The CLI's `--timeout` defaults to 10000ms per execute, and a timed-out runner KEEPS RUNNING to completion inside the relay (the CLI just stops waiting). Always pass `--timeout <ms>` sized to the runner, and never assume a timed-out run performed no actions — verify state before re-running, or the retry doubles clicks/mutations.
- The CDP relay can die silently between runs, taking all sessions with it. The next CLI call restarts the relay and waits minutes for the extension to reconnect before failing with `Session <id> not found`; if a runner seems hung, check `vp env exec pnpx playwriter session list` for a relay restart (state keys reset to `-`) instead of waiting, then create/rebind a session (`state.page` from `context.pages()`).
- A React render loop can overwhelm the Playwriter relay and make the tab appear frozen. Check `getLatestLogs({ search: /Maximum update depth|too much recursion|render/i })` and the relay/CDP logs before retrying. After fixing the app loop, close only the stuck localhost renderer tab, use the background relay-restart recipe in `snippets.md`, recreate/bind a session with `--host localhost`, and reload the `/files` route.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use `hitTest(...)` or `inspectElement(...)` to identify the topmost element instead of retrying alternate selectors.
- If a visible button is blocked by a text-only tooltip portal, inspect `document.elementFromPoint(...)` at the button center. Tooltip content and its portal wrapper should have `pointer-events: none`; check `packages/app/src/components/my-tooltip.css` before working around it in Playwriter.
- `More actions for <name>` matches BOTH the sidebar tree row button and the folder-explorer child-row button, and their menus differ (the folder-view file menu is Archive-only; the sidebar file menu has Copy path/Rename/Run &lt;plugin&gt;/Archive). Scope with `state.page.getByRole("tree").first().getByRole("button", ...)` for the sidebar one. Sidebar rows only exist for expanded ancestors — expand via the folder's sidebar menu item `Expand subtree` (row clicks select without expanding, and the `.FilesSidebarTreeItemArrow-icon-button` may not be locatable).
- On the Plugins page, installs go through the catalog consent flow (there is no GitHub import form). Manage an installed plugin's secrets on its detail page through `.RoutePluginsPluginSecrets` and the `Manage secrets` dialog. Catalog cards are links and do not contain secret forms.

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
- Rapid AI chat sends can hit the `/api/chat` rate limiter and produce a recoverable `429` response with `retryAfterMs`. The chat transport waits and retries the same request automatically. Do not send a duplicate prompt while that request is still running.
- The chat stop control is labelled `Stop generating`. Playwriter waits that look for `Stop generation` will miss the running state and can send the next prompt too early, producing avoidable `429` failures or branched transcript confusion.
- Keep AI chat Playwriter scripts short when exercising multiple LLM turns. Long monolithic execute calls can lose the Playwriter relay connection with `fetch failed`; prefer one prompt per execute or a small batch with clear idle waits.
- Rapid files-tree create/move/archive sequences can hit the `files_tree_write` rate limiter. If a create dialog stays open with `Rate limit exceeded`, wait for the retry window, keep the dialog open, and submit the same draft again instead of restarting the flow.
- If using a temporary localhost tab, save `app::auth::anonymous_token` and `app::auth::anonymous_token_user_id` before clearing them to mint a fresh anonymous QA session. Restore both keys before closing the QA tab.
- For anonymous-vs-signed-in QA, prefer a fresh headless browser over mutating the user's real Edge auth state: run `vp env exec pnpx playwriter browser install` once, then `vp env exec pnpx playwriter session new --browser headless`. The fresh profile mints a new anonymous app user on first load, the user's signed-in tabs stay untouched, and headless pages are foregrounded so screenshots, `waitForSelector`, and layout APIs work. Delete the session when done.
- Clerk sign-up may be blocked in headless browsers because its Turnstile challenge does not finish. Do not retrieve Clerk secrets from Convex, browser pages, or logs to bypass that flow. Use an already approved signed-in test session or record the blocker and verify the anonymous path instead.
- Close only the localhost tabs created for QA. Leave unrelated user tabs open.
- Do not hand-launch Edge or infer CDP readiness from the presence of `--remote-debugging-port`. When direct CDP is required, load the Edge remote-debugging skill, run its bundled Node script through `vp env exec node`, and verify the process arguments and `/json/version` endpoint.
- On this Windows machine, multi-line code passed to `vp env exec pnpx playwriter -e "..."` is truncated at the first newline — only the first statement runs, and it still reports `Code executed successfully`. Always use `-f <script.js>` for multi-statement code.
- The CLI wait timeout defaults to 10 seconds; it is not a sandbox cap. Pass a suitable `--timeout`. A CLI timeout does not cancel the runner, so verify app state before retrying. Keep interactive calls short, and poll durable state from outside through `convex data` or read-only `convex run` calls.
- In multi-statement scripts, only `console.log(...)` output is printed; a bare trailing expression is not echoed (single-expression `-e` calls do echo their value as `[return value]`). A `console.log` after an in-call navigation can also be lost — split navigation and observation into separate calls.

## R2 Upload Observability

- Browser R2 uploads can record both a `200` response and a `requestfailed` entry with `net::ERR_ABORTED` for the same signed `PUT`. Treat durable Convex state and generated file visibility as the source of truth when the `200` completed and conversion finalized.
- For generated PDF output QA, capture Cloudflare request metadata by filtering network entries whose origin contains `cloudflarestorage`; record method, origin, pathname, response status, and failure text without logging signed query strings.
- Conversion can finish quickly. To verify the pending generated output screen, poll for `<source>.pdf.md` every ~100ms immediately after upload and click it as soon as it appears. If content finalizes before the click, record that the pending state was too fast to observe and rely on backend tests for that state.


## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect `.MainAppSidebar` and `.MySidebar-state-closed` together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.
