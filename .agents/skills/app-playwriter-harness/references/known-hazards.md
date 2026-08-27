# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

Before the first attempt at a new interaction type (upload, download, screenshot, toast, tooltip, hovercard, dialog, navigation, sign-in), search this file for that word — the recipe often already exists, and finding it before the attempt is much cheaper than after the failure. Routing hints:

- **File upload / folder import** — extension mode blocks `DOM.setFileInputFiles`; use the constructed-`File` recipe under Playwriter Availability.
- **Screenshots / downloads** — the sandbox never writes where you point it; use the Buffer + temp-dir recipe under Playwriter Availability.
- **Toasts** — bottom-edge action buttons need an offset click, and a toast must be read in the same execute call as the click that causes it (Playwriter Availability, Interaction Discipline).
- **Tooltips / hovercards** — they need a real pointer position change; see the Ariakit entries under Interaction Discipline.
- **Dialogs** — many stay mounted while closed; never trust the first `[role=dialog]` match (Interaction Discipline).
- **Navigation** — `goto`/`reload` need per-call timeouts, and an evaluate during an in-flight navigation dies while its side effects may still land (Playwriter Availability).
- **Editors** — Monaco and the ProseMirror surfaces have their own sections below.
- **Anything inside an iframe** — `snapshot()` answers about the wrong surface, sometimes without an
  error; see the plugin-frame section. This holds for same-origin frames too, so read it before your
  first frame check, not after a confusing result.
- **"The server looks down"** — before restarting anything, check how you probed it. Different local
  servers in this repo bind different hosts, and one of them refuses the IPv4 literal outright; search
  this file for the port. Restarting a server the user is already using is the expensive mistake here.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Run it through Vite Plus: `vp env exec pnpx playwriter`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read harness files and resolve repo-relative paths. Propose documentation memories through the harness, then edit them outside Playwriter with the agent's targeted edit tool.
- In this repo, run Playwriter through Vite Plus, for example `vp env exec pnpx playwriter browser list`.
- Do not use Vite Plus package-filtered execution when the flow needs `.agents/skills/**`; that changes the session cwd to `packages/app` and prevents repo-root harness reads.
- Use extension mode by default. Use direct CDP only when the user asks or when the documented Edge/Playwriter recovery flow requires it. Load the Edge remote-debugging skill before that recovery.
- This repo forbids Bun and `bunx`; translate any Playwriter docs that mention `npx`/`bunx` to `vp env exec pnpx playwriter`.
- In PowerShell, do not use the `--%` stop-parsing token with `vp env exec pnpx playwriter` — `vp env exec` consumes the token and the CLI then misreads the JavaScript as a command name (`Unknown command: ...`; observed twice, latest 2026-08-01). For short snippets use PowerShell single quotes around `-e` with double quotes inside the JavaScript; for anything longer use `-f`.
- When `--%` is not usable, keep `-e` snippets very small and verify a trivial string command first, for example `console.log('hello')`.
- Through `vp env exec ... pnpx.CMD playwriter`, `--% -e` can still misparse JavaScript with object literals or arrow functions. Use `-f` runner files for any nontrivial probe, even when the script is only a few lines.
- Avoid JavaScript template literals in PowerShell `-e` snippets. PowerShell treats backticks as escapes, so use string concatenation or put the script in a file/here-string before passing it to Playwriter.
- **Runner code is plain JavaScript, not TypeScript.** The executor compiles the snippet with `node:vm`, so any TypeScript syntax is a parse error: `el as HTMLElement`, `(x as any)`, and parameter or return type annotations all fail with `SyntaxError: Unexpected identifier 'as'`, and the CLI then exits 9 with the libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. The relay is fine — read the `SyntaxError` above the assertion instead of starting recovery. This bites hardest when copying a snippet out of repo `.ts` source. Drop the casts; inside `page.evaluate` the DOM values are already untyped. `import.meta` is unavailable there too, so read Vite env values from `packages/app/.env.local` instead of the page. Verified 2026-08-14.
- **`fs` and `os` are not globals in the sandbox, and `await import(...)` is a trap.** Only `require` is there. Verified 2026-08-23: bare `fs.readFileSync(...)` throws `ReferenceError: fs is not defined`, while `require("node:fs")` and `require("node:os")` both work and `os.tmpdir()` answers the real `%TEMP%` under a Windows relay. The repair everyone reaches for next is the dangerous one: the executor compiles with `node:vm`, so `await import("node:fs")` throws `TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]`, and left uncaught it takes the CLI client down with the same libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 9) as the entries above. **That exit looks exactly like a dead relay, and it is not one.** Do not restart the relay for it — other agents share it and a restart destroys every session in every repo. Wrap the call in `try/catch` if you want to see the error cleanly, or just use `require`. Better still, when the goal is only to get a file onto the page, skip the sandbox filesystem and pass `addScriptTag({ path })` so Playwright reads the file itself.
- **`vp env exec` passes only the FIRST line of a multi-line `-e` argument.** Everything after the first newline is dropped with no error, and this one cause explains every confusing `-e` failure below it. Verified 2026-08-23, four measurements: a two-line `-e` printed `LINE-ONE` and never `LINE-TWO`; the same shape with a silent first line printed `Code executed successfully (no output)` and exited 0, which reads exactly like a script that ran and had nothing to report; a `//` comment on the first line left the executor's own wrapper commented out, so the run died with `SyntaxError: Unexpected end of input` on the rendered source `(async () => { // a note })()` and the CLI exited with the libuv assertion; and a single-line `-e` with a trailing `//` comment ran fine, so the comment is not the problem — the newline is. Put any multi-line script in a `-f` runner file.
- **A helper's own `console.log` is dropped when a later call invokes it.** Each `-e`/`-f` call compiles a fresh `node:vm` script, and a function parked on `state` keeps the `console` of the call that installed it. Verified 2026-08-23: a logger installed in call 1 printed normally in call 1, and in call 2 it still ran and still returned its value while its log line never reached the CLI. So `sweep()` in `overlay-blocking-helpers.js` and the trailing `console.log` in `auditAccessibility` print only when the sweep or audit runs in the same call that installed the file. Read the **returned** value in your own call instead of expecting a helper to narrate, and do not read a silent helper as a helper that did nothing.
- `vp env exec pnpx playwriter session new --browser $browserKey` can print status text plus the session id. Parse the `Session <id> created` line instead of using the whole trimmed output as the id.
- Never pipe `playwriter session list` to `head`, `Select-Object -First`, or any other early-close consumer. The CLI then waits on a half-closed pipe and the process hangs until it is killed. Read the full `session list` output. Verified 2026-08-16.
- If multiple browsers are reported, do not use auto-selection. Run `vp env exec pnpx playwriter browser list`, identify the browser that exposes the target app tab, and pass its exact full reported key to `--browser`. Current keys can look like `install:Edge:<id>`; do not add a `profile:` prefix or copy an old key from this file.
- Extension mode can be connected and able to create/control its own blank tab while `bindOpenTab({ urlIncludes: 'localhost:5173' })` still fails because the existing app tab was not Playwriter-enabled. If CDP `http://127.0.0.1:9222/json/list` shows the target tab and extension binding cannot see it, either enable Playwriter on that tab or use direct CDP as the documented fallback; when the dev server is down, the same tab may appear to Playwright as `chrome-error://chromewebdata/` with title `localhost`.
- The cheapest answer to that failure is usually **not** enabling the extension on the user's tab: open your own with `state.page = await context.newPage()`, set `state.appPlaywriterHarness.page` to it as well, and `goto` the route. A tab Playwriter created is enabled by construction, and the run then owns the tab, which the "the human can drive your bound tab" entry below recommends anyway. Verified 2026-08-13 after `bindOpenTab` found nothing while `context.pages()` listed only an unrelated app. Two follow-ups: `goto` on `/files` does not finish inside the CLI budget (use the fire-and-forget + poll pattern below), and `data-app-ready` can read `false` for a few seconds after the URL is already correct.
- A **strict-mode ambiguous locator click can crash the CLI the same way instead of reporting the violation.** Verified 2026-08-24: `frameLocator(...).getByRole("button", { name: /^#design-review/ }).click()` matched two buttons (a channel link and a Threads-view summary whose text starts with the channel name), and instead of Playwright's strict-mode error the CLI died with the libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 9). The session survived. Treat an assertion exit right after a `click()` as a possible ambiguity: re-run a `count()` on the same locator before retrying, and prefer a class-scoped locator with `hasText`.
- A **throwing harness helper** (for example `bindOpenTab` with no match) kills the CLI client with the same libuv assertion as the out-of-CWD `fs` read below (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit 9). The stack above it is the real error — read it first, do not start relay recovery on the assertion alone. The relay usually survives, but not always: on 2026-08-21 one of these crashes was followed by `session list` printing `No active sessions`, so a long-lived session and everything on its `state` were gone (and the app tab it had been driving was closed). Keep the values a run depends on — ids, paths, keys — in the runner file or in your own notes, not only on `state`, and re-check `session list` after any assertion exit before assuming your session is still there.
- For long or assertion-heavy flows, keep the runner under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/` and run `vp env exec pnpx playwriter -s $session -f $scriptPath --timeout <ms>`. The CLI reads the `-f` file before sandboxed code runs, so the sibling-directory path works. Embed dynamic input in the runner or assign it to `state` in a short separate call. Do not put runners, prompts, or output in the repository or OS temp directory.
- **The sandbox `fs` runs inside the relay server process, and the relay can live on Windows or in WSL.** The CLI always runs on Windows here, but the executor runs wherever the relay was started: whichever side runs Playwriter first after a reboot spawns the relay and owns port 19988, and WSL2 forwards that port to Windows, so the Windows CLI silently talks to a WSL relay. Confirmed 2026-08-02: the relay was a WSL process from 2026-07-31 to 2026-08-02 (spawned under the Cursor WSL remote agent), which made the sandbox report `process.platform === "linux"` and a POSIX `/tmp`. It is back on Windows since 2026-08-02, and a logon Scheduled Task (`playwriter-relay-windows`) now triggers a Windows relay spawn at every logon so Windows wins the port race after reboots. Upstream bug report: https://github.com/remorses/playwriter/issues/107. Detection: run `vp env exec pnpx playwriter session list` — a CWD column like `/home/rt0/C:\Users\...` means a WSL relay. Root cause in playwriter 0.4.0 (latest, same code on main): the CLI sends its Windows cwd, and the Linux relay joins it naively with `path.resolve` (`dist/executor.js:259`, `dist/scoped-fs.js:19,41`). There is no option or env var to set the allowed dirs. Also `playwriter logfile` always prints the Windows log paths, but a WSL relay writes to WSL `~/.playwriter/relay-server.log` — read that one through `wsl -d Ubuntu`.
- To move the relay back to Windows: coordinate with any other agent using Playwriter first (killing the relay destroys ALL sessions, including the other repo's), then `wsl -d Ubuntu -- pkill -f playwriter-ws-server`, then run any Playwriter command from PowerShell — the CLI spawns a Windows relay itself. After that, sandbox fs writes reach the real Windows disk again and `--browser headless` works. A later WSL-side Playwriter run spawns its own second relay inside WSL without stealing the Windows port; the race only restarts at the next reboot, and the `playwriter-relay-windows` logon task exists to win it. Verified 2026-08-02: this recovery worked end to end (sandbox reports `win32`, a tmpdir write landed in `C:\Users\rt0\AppData\Local\Temp`, repo-relative reads work, headless session creation works). Do not use `playwriter serve --host localhost` for this: it can bind only IPv6 `::1`, which the CLI's IPv4 `/version` check never sees.
- Which sandbox paths work depends on where the relay runs. Under a **Windows** relay, relative output paths such as `page.screenshot({ path })` resolve against a non-repo CWD (observed `C:\Users\rt0`), and `fs.readFileSync` rejects absolute repo paths with "access outside allowed directories" while repo-root-relative read paths work. Under a **WSL** relay (the state from 2026-07-31 to 2026-08-02), no repo path works at all: repo-relative, absolute `C:/...`, and session-cwd-relative paths all fail with ENOENT on the joined `/home/rt0/C:\...` path, and only sandbox `/tmp` (= WSL `/tmp`) reaches a real disk. Either way, install helpers with `-f` and an absolute path so the CLI reads the file from the real Windows disk before the sandbox starts.
- With a Windows relay (the state since 2026-08-02), absolute Windows output paths and `os.tmpdir()` writes work normally; everything below applies while the relay is in WSL (check `session list` first, see the relay-topology entry). `page.screenshot({ path })` never reaches the real Windows disk while the relay runs in WSL, not even with an absolute `C:/...` path. The sandbox fs is the relay host's real filesystem, and on POSIX a `C:/Users/...` path is not absolute, so it is joined under the session's mangled base dir inside WSL instead of the Windows disk. The old temp-dir route is dead too (re-verified 2026-08-02 on playwriter 0.4.0): `os.tmpdir()` resolves to WSL `/tmp`, and a session-cwd write fails with the joined-path ENOENT (`/home/rt0/C:\Users\...`), so no sandbox `fs` write reaches the Windows disk at all. **Working route: write the Buffer to sandbox `/tmp`, then copy it out with WSL.** The sandbox `/tmp` IS WSL Ubuntu's `/tmp` (verified 2026-08-02: a file written by the sandbox shows up in `wsl -d Ubuntu -- ls /tmp`), so `wsl -d Ubuntu -- cp /tmp/shot.png "/mnt/c/Users/rt0/...target..."` lands the real file. The reverse direction works too: `wsl -d Ubuntu -- cp /mnt/c/...source... /tmp/ref.png` stages files the sandbox can read (for example upload references). Fallback if WSL copy is ever unavailable: print `buf.toString("base64")` in `CHUNK:`-prefixed slices of ~2500 chars (the executor caps one call's total output at 10000 characters — `dist/executor.js:1314`, no flag to raise it — and strings nested inside logged objects are cut at 1000 by `util.inspect`; a string logged directly is only subject to the 10000 total, so park the string on `state` and print the remainder in later calls), then collect in PowerShell (`Select-String -Pattern "CHUNK:([A-Za-z0-9+/=]+)"`, join, `[Convert]::FromBase64String`). Use the browser-download trick below only if that write is rejected: `await page.bringToFront()` (a backgrounded tab makes `Page.captureScreenshot` time out), `const buffer = await page.screenshot({ scale: "css" })`, then open `context.newPage()`, `setContent` a `data:image/png;base64,...` anchor with a `download` attribute, click it through Playwright so it counts as a user gesture, and close the tab. Move the file out of `~/Downloads` afterwards with a normal shell command. Use a fresh tab every time: Chromium blocks repeated automatic downloads from the same origin after the second one, and `Page.setDownloadBehavior` over CDP does not lift that block.
- In extension mode, `download.saveAs(<path>)` fails with `ENOENT` on a relay artifact path, but the download itself succeeds and lands in the real `~/Downloads` folder under `download.suggestedFilename()`. Read or hash it there with a normal shell command, then delete the copy. Verified 2026-08-01 with a PDF download from `/files`.
- `resizeImageForAgent` does **not** put the picture in front of the agent, even though the Playwriter docs say the resized image is included in the response. It returns `{ buffer, mimeType, path }` and nothing renders. To actually look at a screenshot, save it with `page.screenshot({ path: <absolute Windows path>, scale: "css" })` and then open that file with the agent's own file-read tool. Verified 2026-08-12 in Claude Code.
- `context.newCDPSession(state.page)` fails in extension mode (`Protocol error (Target.attachToBrowserTarget): No tab found`) and takes the CLI client down with the libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 9). The relay is fine — do not run relay recovery. **Amended 2026-08-23: the CDP conclusion on this line was wrong, the rest of it is not.** `newCDPSession` really does fail this way, and "the relay is fine — do not run relay recovery" really does hold; relay recovery kills every Playwriter session in every repo. But `Emulation.setDeviceMetricsOverride` IS reachable, through `context.newCDPSession(state.page)` in the non-extension session shape and through `SKILL.md:59`'s route, so you CAN narrow the viewport. Squeezing the container in the page (`el.style.maxWidth = "560px"`, screenshot, then clear the inline style — the truncation recipe in `snippets.md`) is still the cheaper move when you only need one element narrow, because it changes no page-level media queries. Reach for real emulation when the layout you are chasing depends on a media query. Verified 2026-08-13, amended 2026-08-23.
- **What actually works for emulating a viewport here, measured 2026-08-23.** Four calls, and only two of them do anything. `page.setViewportSize` **works**. CDP `Emulation.setDeviceMetricsOverride` **works** (see the amended CDP entry above). `Emulation.setPageScaleFactor` is **accepted and has no layout effect** — it returns success, so a run that relies on it reports a pass while every element keeps its old size. `page.emulateMedia` **fails** with `No tab found for method Emulation.setEmulatedMedia`, so a check that depends on a media feature (`prefers-color-scheme`, `prefers-reduced-motion`, print) cannot be driven that way; set the app's own theme or class instead. The dangerous one is the third: silent no-ops are the only kind of failure that produces a green report.
- **The sandbox `fs` cannot write into the personal `+ai` folder**, even with a Windows relay and an absolute path: ScopedFS allows only the session's own directories, and the folder is outside every one of them. The write fails with "access outside allowed directories", which reads like a permissions problem with the folder and is not. Write to `os.tmpdir()` from inside the sandbox, then move the file with a normal shell command. Runners passed with `-f` are unaffected — the CLI reads those from the real disk before the sandbox starts — so a runner may live in `+ai` while its OUTPUT may not be written there directly.
- **A plugin frame is narrower than the layout viewport, and the difference is not a constant.** The host chrome around the frame takes width, so a frame inside a 1440px viewport is not 1440px wide. Measured 2026-08-23: **−40px from 720 up to 1440, and −55px at 390** — so a value derived by subtracting a fixed number from the viewport is wrong at one end or the other. Never compute the frame width from the viewport. Read it from inside the frame (`window.innerWidth` in frame context, or the frame element's own `getBoundingClientRect().width`) before asserting anything about a breakpoint, or a reflow check lands on the wrong side of one.
- Playwriter execute snippets do not automatically provide Playwright Test's `expect`. Use manual polling or import only the small assertion utility you need.
- The CLI's cwd is not always the repo root even without `--filter`: after any earlier `pnpm --filter <pkg> exec` in the same shell it can be `packages/app`, and `-f .agents/skills/...` then fails with `File not found: packages\app\.agents\...`. Pass the harness script as an absolute path instead of a repo-relative one.
- Assigning `state.page = await context.newPage()` does **not** move the harness. `getHarnessPage()` prefers `state.appPlaywriterHarness.page`, pinned when the harness was installed, so `observe()` and `auditAccessibility()` keep reporting the **old** tab while every raw `snapshot({ page: state.page })` shows the new one — the two disagree in silence and the run looks merely confusing rather than wrong. Harness 0.6.1 logs `[harness] state.page … is not the bound tab` when they differ and skips closed tabs. Call `bindOpenTab(...)` (it sets both) or assign `state.appPlaywriterHarness.page` yourself. The pin also survives across sessions on the same relay: on 2026-08-18 it still pointed at another app (`http://127.0.0.1:7373/#/grid`) from an earlier run, and `auditAccessibility` did not report the wrong tab — it just timed out. Read `state.appPlaywriterHarness.page.url()` before debugging a harness call that hangs.
- **The Playwriter default `page` global is not the bound tab.** After `bindOpenTab`, `state.page` and `state.appPlaywriterHarness.page` point at Council, but a runner that uses the injected `page` still drives the session's first tab. Verified 2026-08-26: that first tab was another local app, so `page.frameLocator(".PluginsUiFrame")` found 0 meetings, `Get host room link` timed out, and a card dump looked like the Council list had vanished. Use `state.appPlaywriterHarness.page` (or `state.page` after a proven bind) in every Council click and read. Print only whether the URL contains `/plugins/council/`, never the full URL if it can carry ids.
- **The human can also CLOSE the bound tab while you run**, and that failure does not look like a closed tab. The call prints `[WARNING] Page closed (url: …) for state.page`, then `page.evaluate: Target page, context or browser has been closed`, and ends with the same libuv `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 9) as the out-of-CWD `fs` read below. The relay is fine and `state` survives. Do not run relay recovery or `session reset`: print `context.pages().map((p) => p.url())`, then either open your own tab (`context.newPage()`, set both `state.page` and `state.appPlaywriterHarness.page`) or re-`bindOpenTab(...)`. Verified 2026-08-13.
- **The human can drive the bound tab while you run.** It is their browser: a tab bound to `/files` can be on `/chat` by the next call, and every probe then reports the new route's DOM as if the old one had broken (0 treeitems, `controlCount: 0`). Print `state.page.url()` alongside any surprising empty result before debugging the app. For anything long or blocking, work in a tab the run owns — `context.newPage()`, set **both** `state.page` and `state.appPlaywriterHarness.page`, then close only that tab at the end and reassign both back.
- **Playwriter injects its own toolbar over the app header's top-right corner, and it blocks clicks there.** `<div data-playwriter-toolbar="1">` is appended to `<html>` (not `<body>`, so a `document.body.children` dump never shows it) at `position: fixed; top: 12px; right: 12px; z-index: 2147483647`, covering roughly a 65×32 box. Despite its inline `pointer-events: none`, both `document.elementFromPoint` and Playwright's actionability check return it, so `locator.click()` on a header icon button fails with `<div data-playwriter-toolbar="1"></div> intercepts pointer events`, and `auditAccessibility` lists those buttons under `blockedHitTargets` with a class-less `div` as `topAtCenter`. On `/files` that is `Search file contents (Ctrl+Shift+F)` and `Notifications`. It is a Playwriter artifact — a real user without the extension attached is unaffected — so do not report it as an app bug and do not chase the app's z-index. Activate the button with `locator.focus()` + `keyboard.press("Enter")` instead (verified 2026-08-11: the search palette opened, `Escape` closed it). Tell it apart from a stuck Ariakit tooltip portal (also a bare `div` on `<body>`) by reading the element's attributes rather than its class. The toolbar also takes **keyboard** focus: it is a shadow host with focusable children, and because it sits on `<html>` Ariakit's modal `inert` marking never covers it, so a focus-trap Tab walk on any open MyModal dialog records two out-of-dialog stops on `[data-playwriter-toolbar]` (then one transient `BODY` stop) before wrapping back into the dialog. That reads exactly like a trap leak and is the harness, not the app — check `activeElement.closest("[data-playwriter-toolbar]")` before reporting one (verified 2026-08-25 on the plugin update-consent dialog).
- `auditAccessibility({ selector })` resolves with `document.querySelector`, so it audits exactly **one** element. A comma-separated list like `"main, aside, [role=tree]"` silently audits only the first match and reports a small `controlCount` that looks like a clean route. It also returns `controlCount: 0` with all-empty finding lists when it runs against a blank/reloading tab, which reads identically to "no problems found". Use the default `"body"`, and sanity-check `controlCount` against `document.querySelectorAll("button").length` before believing a clean result.
- `latestLogs()` without a prior `bindOpenTab(...)` reads whatever tab the harness defaulted to, which may be a completely different app. Symptom: logs full of third-party SDK noise (Intercom, FullStory, Churnkey) that the app under test does not use. Always `bindOpenTab({ urlIncludes: 'localhost:5173' })` before trusting a log read, and note that passing `{ page: state.page }` alone does not fix it.
- `latestLogs()` returns an array of **preformatted strings** (`"[error] Sending form data..."`), not `{ type, text }` objects. A filter that reads `l.type` / `l.text` sees empty fields and reports zero matches, which looks like the log never happened. Match with a regex over the whole string. Verified 2026-08-16.
- If the user says the extension is active but `vp env exec pnpx playwriter browser list` reports `No browsers detected`, use the background relay-restart recipe in `snippets.md`, then check again. If Edge itself must be restarted or direct CDP is required, load `C:/Users/rt0/.cursor/skills/edge-remote-debugging-mcp/SKILL.md` and follow its profile validation and bundled-script workflow. Do not invent an Edge profile path or launch command here.
- After restarting the relay with `--host localhost`, include `--host localhost` on subsequent `playwriter` commands. For direct CDP sessions through that relay, auto-discovery is treated as remote; read `http://127.0.0.1:9222/json/version` and pass the explicit `webSocketDebuggerUrl` to `session new --direct`.
- Edge can relaunch itself after an OS/Edge upgrade (`--os-upgraded-session` on the main process), dropping the profile window and Playwriter extension (`not connected`, exit 9); active sessions die. Load the Edge remote-debugging skill named above and use its verified bundled-script workflow. Then confirm `vp env exec pnpx playwriter browser list` reports the needed browser, pass its exact full key to `--browser`, re-bind the app tab, and re-install helpers.
- Fresh Playwriter sessions start with an empty `state` (`{}`); executor scripts receive a bare global `context` (the Playwright BrowserContext), not `state.context`. Bind with `context.pages()` / `context.newPage()` and assign `state.page` yourself before relying on it.
- The CLI's `--timeout` defaults to 10000ms per execute, and a timed-out runner KEEPS RUNNING to completion inside the relay (the CLI just stops waiting). Always pass `--timeout <ms>` sized to the runner, and never assume a timed-out run performed no actions — verify state before re-running, or the retry doubles clicks/mutations.
- To run work that genuinely takes longer than the 5000ms budget (an axe scan, a Tab-order sweep, a poll for a slow state change), do not raise `--timeout`. Start the work without `await`, park the result on `state`, and read it in a later call: `state.done = false; state.page.evaluate(...).then(r => { state.out = r; state.done = true }).catch(e => { state.out = { err: e.message }; state.done = true }); console.log("STARTED")`, then a second runner prints `state.done` / `state.out`. The relay keeps the runner alive after the CLI returns, so this is reliable and each call stays well under budget.
- A fire-and-forget runner's **wall-clock** numbers are worthless. Once the CLI stops waiting, the relay keeps running it but the many small CDP round trips it makes are starved: the same 95-step `mouse.move` sweep took 672ms in the foreground call and 55s after the CLI returned. Measure with `performance.now()` **inside** `page.evaluate` (per-event or per-loop timings stay valid), and never derive an event rate from the runner's own elapsed time. Verified 2026-08-13 while timing a `pointerover` handler.
- Keep `--timeout` under 5000ms. A step that needs more is almost always a wrong selector, a page that is not ready, or a script that does too much in one call — not a slow app. Do not raise the timeout to make a step pass: split the runner into smaller steps and observe between them (`state.page.url()`, `snapshot(...)`, `getLatestLogs({ sinceLastCall: true })`). Long timeouts hide the real failure and burn minutes per retry. Keep in-script waits (`waitFor`, `waitForSelector`, `click({ timeout })`) shorter than the CLI timeout, or the CLI returns while the runner keeps mutating the page.
- The CLI `--timeout` does not raise Playwright's own default navigation timeout. `page.reload()` and `page.goto()` still fail at `Timeout 10000ms exceeded` under `--timeout 120000`, because that default lives on the page, not the CLI. Pass `{ timeout }` on the call itself: `reload({ waitUntil: "domcontentloaded", timeout: 60000 })` followed by `waitForPageLoad({ page, timeout: 25000 })` is the shape that works on `/files`.
- `playwriter session reset <id>` (the recovery for "Frame has been detached" / `Target.createTarget` extension timeouts after the bound tab is closed) clears every `state.*` key except `page` — the installed harness is gone afterwards. Re-run `install-harness.js` and `bindOpenTab(...)` before the next helper call. Also, a `goto` inside a CLI-timed-out call can still land: probe `state.page.url()` before assuming the navigation failed and re-running it.
- **When an Edge profile has no Playwriter-enabled tab left, its extension stops answering and every session on it fails the same way**, including a brand-new one: `browserContext.newPage: Protocol error (Target.createTarget): Extension request timeout after 30000ms: forwardCDPCommand`, thrown from `ensurePageForContext` before your code runs. `browser list` still lists the install, so the browser looks connected and the failure reads like a dead relay. Confirm the relay is fine with `session new --browser headless` (it works), then give the profile a tab again from PowerShell: `Start-Process msedge.exe -ArgumentList @('--profile-directory=Default', '--new-window', '<url>')`. Pass only those switches — Edge is already running with the default user-data-dir, so omitting `--user-data-dir` avoids the `User Data` quoting trap entirely. Do **not** run the Edge remote-debugging skill's scripts for this: they kill every `msedge.exe`, which also kills the other agent's work-profile sessions. Verified 2026-08-13.
- **A QA tab in its own Edge window gets discarded once it loses focus**, and the symptom is not obviously a discard: `locator.click()` on a normal button hangs to its timeout ("performing click action" and nothing after), the next call dies with `Execution context was destroyed`, and the one after that reports the page closed with no pages remaining. It looks exactly like the app crashing on the action you just clicked — reproduce in the `headless` browser before filing an app bug. (The New Chat click that "crashed" Edge three times looked clean headless on 2026-08-13, but see the next entry: it is a real app bug and headless reproduces it too.)
- **Clicking `New Chat` on `/w/:org/:workspace/chat` wedges the renderer** (found 2026-08-14, `main` at `b1cb761e`). The URL does switch to the optimistic `?threadId=ai_thread-…`, then the renderer pins at ~150% CPU and grows ~15-90 MB/s until the tab is dead: `click` hangs at `performing click action`, and `evaluate`, `newCDPSession`, and `reload` all hang after it. Since every `localhost:5173` tab shares one renderer, the tab you open next dies too, which makes it look like a relay problem. Confirm with `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` filtered on `playwright_chromiumdev_profile` + `--type=renderer` and watch `WS` climb past 3 GB. It is not caused by any one branch: it reproduced with an image-generation branch applied and again after `git stash`-ing that whole change. Recovery is to kill the headless browser (`Stop-Process` on those PIDs; safe, it is Playwright's own temp-profile Chrome and only your session uses it) and create a new session. Until it is fixed, do not click `New Chat` — start a fresh headless browser to get an empty chat instead (see `agent-panel.md`). For long unattended chat QA prefer `session new --browser headless`: the app mints an anonymous user for a visitor with no session, which is enough for chat, tools, and `/files`, but not for plugin publishing (`publish_version` refuses anyone who is not `signed_in`). Verified 2026-08-13.
- The CDP relay can die silently between runs, taking all sessions with it. The next CLI call restarts the relay and waits minutes for the extension to reconnect before failing with `Session <id> not found`; if a runner seems hung, check `vp env exec pnpx playwriter session list` for a relay restart (state keys reset to `-`) instead of waiting, then create/rebind a session (`state.page` from `context.pages()`). A direct-CDP session dies with the relay too, but the scratch browser it was attached to keeps running — recreate with `session new --direct 127.0.0.1:9223` and rebind; no browser restart needed (verified 2026-08-02 mid sign-in flow).
- Installing the harness by having the runner `readFileSync` it can fail in a way neither the absolute-path nor the repo-relative advice above fixes. Observed 2026-08-01: the sandbox resolved **both** forms against a joined POSIX+Windows root (`/home/rt0/C:\Users\rt0\…\t3-chat/…`) and returned ENOENT either way (cause confirmed 2026-08-02: WSL relay, see the relay-topology entry above), and `--% -e` was unusable because `vp env exec` consumed the stop-parsing token. What always works: build a **self-contained** runner — concatenate `install-harness.js` itself into the `-f` file (`$h = Get-Content -Raw …\install-harness.js`, then `Set-Content $runner ($h + $check)`) — because the CLI reads the `-f` file from the real disk before the sandbox exists. After that, plain `-e '…'` with PowerShell **single** quotes works fine for the rest of the session.
- **Sandbox `fs` reads of a path outside the session CWD crash the CLI client** with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (libuv, exit code 9) instead of a clean EPERM. Verified 2026-08-08 under a Windows relay: `require("node:fs").readFileSync("<personal-AI-folder path>")` from a session whose CWD is the repo root crashed twice; the same data embedded in a `-f` runner worked. The crash looks like a dead relay but is not one: `session list` still shows every session with its state keys, and the very next command works. Do not start relay recovery for it — just re-run with the data embedded in the runner.
- **A `frame.evaluate` into an OOPIF plugin frame that calls `.focus()`/`.click()` on a hover-revealed control can crash the CLI client** with the same `UV_HANDLE_CLOSING` assertion (exit 9), reproducibly — twice in a row on 2026-08-24 against Chitchat's "Reply in thread" button, over a direct-CDP session. The session and `state` survived; only the CLI invocation died, and the click never landed. Do not retry the same call shape: drive the interaction through locators instead — `frameLocator(...).locator("li.message").last().hover()` then `getByRole("button", { name: ... }).click()` worked first try. Plain read-only `frame.evaluate` calls in the same session were unaffected.
- Sandbox `fs` **writes** outside the session CWD fail with a clean `EPERM: ... access outside allowed directories` (no crash, unlike the read case above). The session CWD is whatever directory the shell was in when `session new` ran, so a session created from a repo subfolder cannot write to the personal `+ai` folder even under a Windows relay. Recovery that works: write the buffer to `require("node:os").tmpdir()` (real Windows temp under a Windows relay), then `Move-Item` it to the artifact folder from PowerShell. Verified 2026-08-15 saving a screenshot. Cheaper than the recovery, when the run is going to write a lot of artifacts: run `session new` from `C:\Users\rt0\Documents\workspace\rt0`, the parent of both `t3-chat` and `t3-chat-+personal`. Both then sit under the session CWD, and `page.screenshot({ path })` writes straight into the personal `+ai` folder with no move step. Harness install still works, because `-f` with an absolute path is read from the real disk before the sandbox starts, and `vp env exec` resolves the pinned Node from that directory too. Verified 2026-08-24 writing five screenshots.
- A React render loop can overwhelm the Playwriter relay and make the tab appear frozen. Check `getLatestLogs({ search: /Maximum update depth|too much recursion|render/i })` and the relay/CDP logs before retrying. After fixing the app loop, close only the stuck localhost renderer tab, use the background relay-restart recipe in `snippets.md`, recreate/bind a session with `--host localhost`, and reload the `/files` route.

- **`setInputFiles` works under a Windows relay — try it first for uploads.** Verified 2026-08-08: `locator(".FilesSidebar input[type=file]:not([webkitdirectory])").setInputFiles("C:/absolute/windows/path")` uploaded three files through the sidebar's hidden input, no dialog, no menu click — select the target folder row first, since the handler uploads into the selected folder. The 2026-08-02 finding that this is impossible (`Protocol error (DOM.setFileInputFiles): Not allowed`, plus WSL path ENOENTs) was recorded while the relay ran in WSL; do not treat it as a property of extension mode. If `setInputFiles` does fail, check `session list` for a WSL relay before switching recipes, and only then fall back to the DataTransfer route: construct `File` objects in `page.evaluate`, `Object.defineProperty(file, "path", { value: "folder/name.ext" })` (file-selector's `toFileWithPath` keeps a pre-set `path`), put them in a `DataTransfer`, assign `input.files = dt.files`, and dispatch a bubbling `change` event on the real input. Verified 2026-08-02 on the Files sidebar folder import.
- A sonner toast action button sitting at the bottom edge of the viewport (progress toasts on `/files`) can have its center below the viewport bottom; `locator.click()` then reports the click blocked by `.AiChatThread-composer` even though the toaster's z-index (999999999) is on top and a real user clicks it fine. Click the visible part instead: `locator("[data-sonner-toast] button[data-action]").click({ position: { x: 26, y: 6 } })`. Verified 2026-08-02.
- **A tab the app opens with `window.open` never appears in `context.pages()`.** The extension only sees tabs it is attached to, so a `window.open(url, "_blank", "noopener,noreferrer")` (the billing `Select plan` button does exactly this) lands a real tab in the user's Edge that your run cannot read, and the click looks like it did nothing: same URL, no new page, no console log, no snapshot change. Do not retry the click — you are just piling up tabs the user has to close. Get the URL yourself and open it in a page the run owns: `await state.page.evaluate(async () => { const m = await import("/src/lib/app-convex-client.ts"); ... })` reaches any app module through the Vite dev server, so you can call the same Convex action the button calls and then `context.newPage()` + `goto` it. Read the button's source first and pass every argument it passes — the billing checkout button sends `subscriptionId` on a `Free -> paid` upgrade, and omitting it makes Polar create a *second* active subscription, which the app treats as an impossible state. Verified 2026-08-21.
- **Stripe's payment iframe answers nothing through the relay.** On the Polar checkout page, `frameLocator('iframe[title="Secure payment input frame"]').locator("input")`, `frame.evaluate(...)`, the iframe element screenshot, and even a full-page `screenshot()` of that tab all hang until the CLI timeout with no error. `snapshot()` works but shows the frame as one opaque `iframepresentational` node. Type blind instead: read the iframe's `boundingBox()`, `mouse.click(box.x + 200, box.y + 30)` for the card number field, then `keyboard.type` the number, the expiry, and the CVC in three calls — Stripe advances between its own fields. Verify by submitting, not by reading the frame. Verified 2026-08-21 with the sandbox card `4242 4242 4242 4242`, `12/30`, `123`.
- A `page.evaluate` fired while a previous call's fire-and-forget `goto`/`reload` is still in flight dies with `Execution context was destroyed, most likely because of a navigation`, and its DOM side effects may still have landed. Poll for the route's content (non-zero `[role="treeitem"]` count on `/files`) before the next evaluate, and after this error re-read state instead of blindly re-running a dispatch.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use `hitTest(...)` or `inspectElement(...)` to identify the topmost element instead of retrying alternate selectors.
- A `locator.click` that fails with `Timeout … - performing click action` has often **already landed** — the post-click actionability check is what timed out. Seen repeatedly on the organization switcher trigger, its row ⋮ buttons, and its menu items. Re-read state (modal open? menu items present? row gone?) before retrying, or the retry double-applies a mutation. Parking the pointer away first (`mouse.move(1400, 500)`) makes the next click more likely to return cleanly.
- A `locator.click`/`locator.focus` that times out on a selector you just read successfully usually means the tab blanked mid-run, not that the selector is wrong. Check `document.getElementById("root").children.length` before rewriting the locator: `0` means the HMR blank described below, and only a reload fixes it.
- Submit buttons in the org-switcher's nested form dialogs (`Create workspace`, and the plugin Install/consent buttons on the Plugins pages) can refuse every pointer path: `locator.click` times out **without landing** (re-read state to confirm — the workspace list stays unchanged), and `focus()` + `keyboard.press("Enter")` can silently do nothing too. What works: for a dialog with a text field, focus the field and press `Enter` (native form submit); for the plugin Install/consent buttons, `focus()` + `Enter` on the button itself does work. Verified 2026-08-01 on `Create workspace` (only the in-input Enter submitted) after both button paths failed. Before trying those fallbacks, check the locator itself: `getByRole("dialog").getByRole("button", { name: "Create workspace" })` is a strict-mode violation with **three** matches, because the section's opener icon button, the submit button, and the close button (`Close create workspace dialog`) all carry that name. `page.locator("button[type=submit]", { hasText: "Create workspace" }).click()` submitted on the first try (verified 2026-08-15). The same collision hits `Create API key` on `/api-keys`.
- `MyCheckboxButton` (the API-key permission list, `my-checkbox-button.tsx`) is the same visually-hidden-input pattern as `MyButtonGroupItem` above: a 1x1 `input.MyCheckboxButton-control` plus a visible `<label>`. `getByRole("checkbox", …).check()` waits for the input to become visible and burns the whole CLI timeout with no error text, which reads like a hung page. `isChecked()` and `focus()` work (no actionability wait), so a probe that only reads state looks fine right before the toggle hangs. Click the label text instead: `dialog.getByText("Read plugin data", { exact: true }).click()`. The inputs are keyboard focusable and `Space` toggles them, so the 1x1 size in `auditAccessibility` is by design, not a finding. Verified 2026-08-15.
- If a visible button is blocked by a text-only tooltip portal, inspect `document.elementFromPoint(...)` at the button center. Tooltip content and its portal wrapper should have `pointer-events: none`; check `packages/app/src/components/my-tooltip.css` before working around it in Playwriter.
- `.MyTooltipContent` does set `pointer-events: none`, but the Ariakit portal wrapper around it does not, so a sidebar row's own metadata tooltip can cover that row's `More actions` button and make `click()` retry until it times out. Park the pointer away from the tree (`mouse.move(1400, 20)`), press `Escape`, wait ~600ms, then click. Do not force-click.
- A sidebar file row is `<div role="treeitem" aria-label="<name>" data-file-id="…" class="FilesSidebarTreeItem">`, and the click target is a **separate** `div.FilesSidebarTreeItemPrimaryAction` inside it (also `aria-hidden` and carrying the same `data-file-id`). So `getByRole("button", { name: "README.md" })` never matches it, and neither does the old `button.FilesSidebarTreeItemPrimaryAction[aria-label="<name>"]` — that selector returns an empty list, which reads like an empty sidebar (corrected 2026-08-13; the row was a single `<button role="treeitem">` before). Click `[role=treeitem][data-file-id=<id>] .FilesSidebarTreeItemPrimaryAction`, and read the name from the row's own `aria-label`. If the click hangs at `performing click action` even on a visible, focused tab, stop retrying and open the node by URL (`?nodeId=<id>`) instead.
- Folder-explorer rows (the file list shown when a folder is selected) are **links**, not buttons: `role=link[name="Open <name>"]`. The list is virtualized, so rows deep in a large folder are not in the DOM and every locator wait on them times out. Do not scroll-hunt: resolve the target's `nodeId` (via the public `/api/v1/files/list` route or the sidebar row's `data-file-id`) and navigate to `?nodeId=<id>` directly. Verified 2026-08-01 on a 750+ file workspace.
- `input.FilesSidebarTreeItemTitle-input` is **always** in the DOM and visible for every sidebar row — it is the row title, not a rename state. It survives a full reload. Two traps: its presence proves nothing about whether a rename is in progress, and `locator.fill()` on it never resolves (it is `tabindex="-1"`), so a runner that fills it burns the whole CLI timeout and looks like a hung page. Type with `page.keyboard` after clicking the real target instead. Verified 2026-07-28.
- Creating a file or folder has **no draft row and no dialog**. `New file` / `New folder` call the mutation straight away with a generated default name (`files-sidebar.tsx`, `handleCreateNodeClick`), and the row appears only after the server accepts. A refusal therefore shows up as a toast and nothing else, so a probe that only looks for a new tree row or an open dialog reports "nothing happened" and reads like a silent failure when it is not. Always read `[data-sonner-toast]` in the **same** execute call as the click.
- `getByRole("button", { name: "Close" }).first()` on `/files` closes the **files sidebar**, not the dialog you meant — the sidebar header owns a `Close` button too. The tree then disappears, every `[role=treeitem]` lookup returns 0, and it survives reloads because the state persists in `app_state::sidebar::files_open` (`"1"`/`"0"`). Close a dialog with its own scoped control (`modal.getByRole("button", { name: "Done" })`) and restore the sidebar by setting that key back to `"1"`.
- `.ProseMirror` matches three elements on `/files`: the file editor, the AI chat composer, and the comment composer. Scope to `.FileEditorRichText-editor-content` or a strict-mode violation ends the run.
- **A sidebar row's `aria-label` carries its state, so a remembered name goes stale the moment the row changes.** Restricting a folder through `Share` renames the row to `<name> restricted`, archiving adds ` archived`, and they stack in that order (`qa-closed-0802 restricted archived`). Every derived label follows: `More actions for <name> restricted archived`, `Expand folder <name> restricted`. A locator built from the name you created the node with then matches nothing, and `locator.click()` burns the whole CLI timeout looking for it. Resolve the row by `data-file-id`, read its **live** `aria-label` in the same call, and build `More actions for <label>` from that. Verified 2026-08-02.
- `New file` and `New folder` each match **two** buttons on `/files` — the sidebar header (`.FilesSidebarTopSection-actions-icon-button`) and the main-view `toolbar[name="File actions"]` — so `getByRole("button", { name: "New folder", exact: true })` is a strict-mode violation, not a missing control. They also behave differently (sidebar creates immediately at root, toolbar opens a modal for the current folder). Scope with `getByRole("complementary", { name: "Files" })`.
- The row's inline `Add file to <folder>` button creates a committed `new-file.md` inside that folder immediately, but it does **not** enter rename mode (`document.activeElement` stays `BODY`) and it does **not** expand the folder, so no new treeitem appears and a probe that waits for one reports a silent failure. Confirm the child through `list_tree`, then rename it with `F2` on the row located by `data-file-id`.
- `More actions for <name>` matches BOTH the sidebar tree row button and the folder-explorer child-row button, and their menus differ (the folder-view file menu is Archive-only; the sidebar file menu has Copy path/Rename/Run &lt;plugin&gt;/Archive). Scope with `state.page.getByRole("tree").first().getByRole("button", ...)` for the sidebar one. Sidebar rows only exist for expanded ancestors — expand via the chevron `button[aria-label="Expand folder <name>"]` / `Collapse folder <name>` (locatable and working, but the click routinely times out at `performing click action` while still landing — verify `aria-expanded` instead of trusting the click result; verified 2026-08-12), or via the folder's sidebar menu item `Expand subtree` (row clicks select without expanding). A chevron click can also leave that trigger's Ariakit tooltip stuck open and its focus ring painted; `document.activeElement.blur()` plus a pointer move clears both before a screenshot.
- The folder-explorer row's `More actions` menu items (observed on `Archive`) can refuse both pointer clicks and `focus()` + `Enter` — every path times out with the menu still open. Fallback that works: archive through the page-context authenticated Convex client instead (`const { app_convex, app_convex_api } = await import("/src/lib/app-convex-client.ts")`, then `app_convex.mutation(app_convex_api.files_nodes.archive_nodes, { membershipId, nodeIds })`). The exports are `app_convex` and `app_convex_api` — there is no `app_convex_client` export, and importing `/convex/_generated/api.js` directly is unnecessary (verified 2026-08-02). This runs as the signed-in user, so it is a legitimate user-path mutation, not a bypass. Verified 2026-08-01.
- On the Plugins page, installs go through the catalog consent flow (there is no GitHub import form). Manage an installed plugin's secrets on its detail page through `.RoutePluginsPluginSecrets` and the `Manage secrets` dialog. Catalog cards are links and do not contain secret forms.
- `MyHovercardAction` (`my-hovercard.tsx`) renders two nodes with the same accessible name **by design**: a non-focusable visible `div` anchor that opens the card on pointer hover, plus an `sr-only` `Ariakit.HovercardDisclosure` button that is the single tab stop and opens the card by keyboard. This is not an app bug. It does mean `getByRole("button", { name: <label> })` resolves to the `sr-only` disclosure, which the visible anchor covers, so clicking it fails with "intercepts pointer events".
- Synthetic hover **does** open these cards, but only if the pointer actually changes position. Ariakit gates the anchor's `onMouseMove` behind a module-level `mouseMoving` flag (`@ariakit/react-core` `useIsMouseMoving`), set by a global capture `mousemove` listener only when `event.movementX || event.screenX - previousScreenX` is non-zero. CDP-dispatched mouse events carry `movementX: 0`, so the screen-coordinate delta is the only thing that counts, and `mousedown` / `mouseup` / `keydown` / `scroll` all reset the flag to `false`. Two consequences: a `mouse.move()` to the coordinates the pointer already occupies is a **no-op**, and a hover straight after typing or pressing `Escape` needs a real position change. Recipe: `await page.mouse.move(900, 500)` to park, then `locator.hover()` — one move is enough (`showTimeout={0}` on the presence card). If a card refuses to open, nudge 3px (`mouse.move(cx + 3, cy + 3)`) rather than repeating the same coordinates. Verified 2026-07-25 on the presence control. The `sr-only` `.MyHovercardAction-disclosure` + `Enter` keyboard path also works and needs no pointer bookkeeping.
- Read hovercard contents through the card itself, not a bare button locator. The card is portalled, and the same action often exists a second time outside the portal inside a `hidden` div (the presence `Disable` button is rendered in both branches of `sidebarCollapsed`). A `.first()` over `button:has-text("Disable")` picks the hidden non-portal copy and reports `visible: false` even though the card is open. Scope to the card: `.MainAppSidebarPresenceControl-hovercard .MainAppSidebarPresenceControl-disable`.
- Concretely for presence: enabling is a plain button (`Enable presence`); once enabled the control becomes a `MyHovercardAction` and `Disable` (`.MainAppSidebarPresenceControl-disable`) only exists inside `.MainAppSidebarPresenceControl-hovercard`. The state is one global localStorage key, `app_state::presence::enabled` (`"1"`/`"0"`) — read it rather than inferring the state from the rendered control, and restore it if a run changed it. With the main sidebar collapsed the enable button is a `MyTooltipTrigger` and `locator.click()` hangs at `performing click action` **without landing**; `locator.focus()` + `keyboard.press("Enter")` activates it cleanly.
- The presence toggle is **not** an opt-out for the global room, but it is not purely cosmetic either (verified in-browser 2026-07-26). `MainAppSidebarPresenceControl` calls `usePresence(app_presence_GLOBAL_ROOM_ID)` **before** the enabled/disabled branch, so with the toggle off the tab still sends `presence:heartbeat` for `app_presence_global` every 10s and `presence:list` (with the room token that heartbeat mints) still returns that user as `online: true`. Check it through `list`, not `listRoom` — `listRoom` refuses the global room outright now, which says nothing about whether the user is still registered. Never treat `Disable` as "this user is no longer visible" when checking a presence leak. What the flag _does_ gate is `FileEditorPresenceSupplier` (`file-editor.tsx`), which swaps to `_Disabled`: on Disable the tab sends one `presence:disconnect` and stops all `files_nodes::<org>::<workspace>::<nodeId>` heartbeats, so per-file collaboration presence really is off. (`OnlinePresenceIndicator` also gates on the flag but is mounted nowhere.)
- Ariakit tooltips can be left **stuck open** by a synthetic focus sequence: `evaluate(el.focus())` on a `MyTooltipTrigger` followed by a real `keyboard.press("Tab")` opens that trigger's tooltip and it stays open after focus moves away. Its portal is a bare `<div>` on `<body>` that lands over the _next_ row's controls, so a following `elementFromPoint` reports the control as covered and a click on it gets intercepted — a false "this button is blocked" finding. Pure keyboard traversal (`Tab` through the real tab order) opens **no** tooltip on these rows. Establish focus by tabbing, not by `focus()` + `Tab`, and assert `[role="tooltip"]` visible-count is 0 before trusting a hit test.
- Comment text is not in `document.body.innerText` until `#app_file_editor_sidebar_tabs_comments` is the active tab, even though `.FileEditorRichTextAnchoredComments-thread-container` already exists. Assert on `.FileEditorCommentsThread-summary` after opening the Comments tab, or the check reports a false failure.
- Ariakit tooltips do **not** open on a programmatic `locator.focus()` — the trigger takes focus, `[role="tooltip"]` never appears, and the check looks like a missing tooltip. They need a real pointer move (park away, then `mouse.move` onto the target, then nudge 3px, same rule as the hovercards above) or genuine keyboard focus-visible from a `Tab` press. Dismiss them again before any document-scope axe run: the open portal is a bare `<div>` on `<body>`, outside every landmark, and it trips `region` on its own.
- `document.querySelector("[role=dialog]")` is almost never the dialog you just opened. This app keeps many dialogs mounted at once (organization switcher, New file, billing, snapshots, share), so the first match is usually the org switcher and a probe reads its text as if the share modal had failed. Enumerate them — `Array.from(document.querySelectorAll("[role=dialog]")).map(d => d.innerText.slice(0,300))` — and pick by content. For the same reason, `Boolean(querySelector("[role=dialog]"))` is not "a modal is open": mounted-closed dialogs match too, so a close-the-modal probe can report `stillOpen: true` forever while nothing is visible. Check visibility (rect size, backdrop presence) before concluding a dialog blocks the page. `auditAccessibility({ selector: "[role=dialog]" })` hits the same trap and reports a clean `controlCount: 0` for a closed dialog. Audit the owner class instead — `.MainAppAccountManagement` for the account modal — after listing the mounted dialogs with their `getComputedStyle(d).display` to see which one is really open. On 2026-08-21 the account modal was the eleventh `[role=dialog]` on the page.
- The files `Share` modal follows that same mounted-while-closed rule: `.FilesShareModal` resolves to **two** elements (the open one plus a hidden one), so a bare `locator(".FilesShareModal")` is a strict-mode violation. Scope to `.FilesShareModal[data-open="true"]`. Its controls are `Restrict access` / `Stop restricting`, `Person or role to add`, `Access level for the new person or role`, `Add`, and `Done`; while restricted it lists the org owner as `Full access`, which is the quickest in-app confirmation that the signed-in user is the owner and therefore bypasses every permission check.
- `el.className` is an `SVGAnimatedString`, not a string, on any SVG element, so a sweep like `document.querySelectorAll("[class*=Foo]")` that calls `.className.split(" ")` dies with `split is not a function` as soon as it reaches an icon. Use `el.getAttribute("class") || ""`.
- After the Clerk OTP is accepted, `window.Clerk.user` still reads `undefined` for several seconds while the session settles — a check right after typing the code reports `anonymous` and looks like a failed sign-in. Re-read it in a **later** execute call before concluding anything; `window.Clerk.session` flips first.
- `MyButtonGroupItem` (the editor view switcher) is a visually hidden radio plus a `<label>`, which is the real pointer target — correct a11y, same shape as `MyHovercardAction` above, not an app bug. `getByRole("radio").click()` fails with "intercepts pointer events"; click the `<label>` (`.MyButtonGroupItem-button`) instead. The already-selected item also has `pointer-events: none` (`my-button-group.css`), so clicking the active view times out by design. Since 2026-08-10 the items depend on the node: a Markdown node shows `Rich` / `Markdown` / `Diff`, a plain-text node (`.json`, `.yaml`, ...) shows `Code` / `Diff` with no Rich, and a stored file shows no editor switcher. Each node opens on its extension's own default view (`.md` rich, the 19 plain-text extensions plain, anything else the stored card): the `?view` param no longer carries forward between files (verified 2026-08-10 with an explicit `view=diff_editor` leak trap), and a stale `?view=rich_text_editor` on a plain-text node is clamped to the plain editor. Switching views by URL (`?view=rich_text_editor` / `plain_text_editor` / `diff_editor`) is still the most reliable route for a view the node supports.

## Plugin UI frames: forms submit in JS only

Fixed 2026-08-16: the plugin iframe sandbox now includes `allow-forms` (`packages/app/src/components/plugins-ui-frame.tsx`), so clicking a `type=submit` button fires the `submit` event and React `onSubmit` handlers run normally. The asset CSP keeps `form-action 'none'`, so a page whose handler forgets `preventDefault` gets a CSP violation in the console instead of a real HTTP submission — a plugin form can never navigate or POST natively. Before the fix, the sandbox blocked the submit event itself (console tell: `Blocked form submission to '' ... 'allow-forms' permission is not set`) and submit buttons read as dead; a frame served by a host built before the fix still behaves that way.

Two facts that stay true for driving frames:

- Playwright locator clicks **inside** the sandboxed cross-origin frame land fine — a console error appearing right after the click proves the click reached the button. Do not rewrite the locator.
- On a pre-fix frame, run the handler without any native submission by dispatching the event from `frame.evaluate`: `form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))`.
- Verified live 2026-08-16 (Council page frame): a submit-listener form fires normally on a real button click, and a no-`preventDefault` form with a real `action` never navigates — the frame logs `[error] Sending form data to '<url>' violates the following Content Security Policy directive: "form-action 'none'". The request has been blocked.` The deterministic assert is a frame-document `securitypolicyviolation` listener (`violatedDirective: "form-action"`, `disposition: "enforce"`) plus an unchanged `frame.url()`; the console string also reaches Playwright's console capture, so `latestLogs` sees it (as a plain string — see the `latestLogs` shape entry above).

## Plugin UI frames and iframes: driving them without wedging the session

Verified 2026-08-17 while driving the Chitchat page frame through the extension relay, except where a
bullet gives its own date. The `snapshot()` bullet applies to **every** iframe, same-origin ones
included; the rest are about the cross-origin plugin frame:

- `state.page.locator(".PluginsUiFrame").contentFrame()` returns a **FrameLocator**, and `snapshot({ frame })` with a FrameLocator silently falls back to the shared default `page` — the snapshot renders a DIFFERENT TAB and nothing errors. Get a real Frame handle instead: `state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1)`. Even then, `snapshot({ frame })` on the plugin frame fails with `Frame with the given frameId is not found` because the cross-origin frame is an out-of-process iframe whose AX tree lives in another CDP target. Read the frame with `frame.evaluate` DOM reads and drive it with `frameLocator` clicks; do not snapshot it.
- **`snapshot()` reads the wrong surface for ANY iframe, not just the cross-origin one — and one form of it does so silently.** Verified 2026-08-22 on playwriter 0.4.0 against a **same-origin** iframe, so this is not about process isolation: `snapshot({ frame })` throws `Frame with the given frameId is not found` for a real `Frame` handle **and** for a FrameLocator, while `snapshot({ locator: page.frameLocator(sel).locator(inner) })` returns a tree byte-identical to `snapshot({ page })` of the shared default `page` — a different tab entirely, with no error. That answer is a complete, plausible accessibility tree of a surface you are not testing, so it reads as a successful check. The locator is not the problem: the same locator with a selector the frame does not contain waits and times out against the frame, correctly. Only `snapshot()` misreads it. Inside any frame, use `getCleanHTML({ locator: frameLocator(sel).locator(inner) })` for structure (it reads the right frame), `frame.evaluate` for exact values, and `frameLocator` for clicks and role queries. Note this run put the silent fallback on `snapshot({ locator })` and got a throw from `snapshot({ frame })`, where the 2026-08-17 bullet above puts the silent fallback on `snapshot({ frame })` with a FrameLocator. Both were observed; which one you hit is not worth predicting. The safe rule covers both: do not call `snapshot()` for anything inside a frame. Verified 2026-08-27 on the Council plugin iframe: `snapshot({ locator: page.frameLocator(".PluginsUiFrame").locator("body") })` hung until the 30 s CLI timeout with no tree. Same rule — do not snapshot that frame.
- A normal top-level `page.screenshot()` can also hang while that OOPIF is visible, even though the host page and frame still answer DOM reads. Capture the composed top-level pixels through CDP instead: `const cdp = await getCDPSession({ page: state.page }); const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }); require("node:fs").writeFileSync(<absolute-path>, Buffer.from(shot.data, "base64"));`. This includes the plugin frame without attaching to its separate target. Verified 2026-08-22 on the Council page.
- **`Page.captureScreenshot` loses the clip's `x`/`y` when `scale` is not 1.** Through the Playwriter extension bridge, `clip: { x: 1339, y: 73, width: 98, height: 96, scale: 4 }` returned a 392x384 image of the page's **top-left corner** at 1x — the size scaled, the offset did not, and the answer looks like a valid screenshot of the wrong element. The same call with `scale: 1` clipped correctly. So never pass a scale on a clipped capture: take the clip at `scale: 1`, and if you need it bigger, enlarge the PNG afterwards or zoom the element in the page first. Verified 2026-08-22.
- After `playwriter session reset`, the fresh connection has NO plugin frame: `frames()` lists only the host page and frameLocator fails with `Failed to find frame for selector ".PluginsUiFrame >> internal:control=enter-frame"`. The relay adopts the OOPIF only when it attaches, so reload the tab once after every reset before touching the frame.
- **A tab you bound with `bindOpenTab` can show a Chitchat `<iframe title="Chitchat">` in the host DOM while `page.frames()` still lists only the host.** `page.frameLocator('iframe[title="Chitchat"]')` then fails with `Failed to find frame for selector "iframe[title=\"Chitchat\"] >> internal:control=enter-frame"` and the CLI exits 9. A tab the run owns with `context.newPage()` (set both `state.page` and `state.appPlaywriterHarness.page`, then fire-and-forget `goto`) attaches the OOPIF: `frames()` includes the `/plugins-ui/` URL and Frame-handle locators work. Verified 2026-08-26. Do not retry `frameLocator` on the bound tab — open an owned tab.
- A long `page.evaluate` (30 s+) through the **extension** relay can die with `Execution context was destroyed, most likely because of a navigation` while the in-page loop KEEPS RUNNING — its writes still land, only the result is lost. Direct-CDP sessions do not suffer this. Put long in-page loops in the direct-CDP scratch session, or split them into short batches; recount server-side instead of trusting the lost return value.
- A scratch-browser anonymous user's page-context Convex calls start throwing `Unauthenticated` after the tab idles a few minutes. The UI recovers on its own auth loop, but `page.evaluate` callers should reload the tab and wait ~5 s to re-mint before retrying.
- Uninstalling a plugin while its page route is open never reaches the plugin's own in-frame dead-state UI: the host route reacts first, unmounts the frame, and shows `This plugin page is not available.`. The same is true for org-membership removal (route-level kill). Today no revocation flavor exercises the in-frame `docs: null` dead path end to end; it stays unit-covered. The teardown also fired a host pageerror `useAppAuth must be used within AppAuthProvider` followed by a recovery reload — a host-app bug, not a plugin bug; do not chase it as a plugin regression.

## A plugin frame keeps its last hover after the pointer leaves it, and the OS cursor lands in the screenshot

Both verified 2026-08-24 on a direct-CDP scratch Chrome while shooting Chitchat baselines. They bite
any element screenshot of `.PluginsUiFrame`.

- **Moving the host pointer off the iframe does not clear hover inside it.** The cross-origin frame
  only restyles on events it receives, so after `mouse.move(3, 3)` the channel row the pointer had
  left still matched `:hover` and still showed its hover-revealed actions. A "resting state"
  screenshot taken that way quietly contains a hover state.
- **`mouse.move` with `steps` re-hovers everything on the way out, and the last in-frame sample
  wins.** Leaving diagonally across the channel rail parked the hover on a channel row the pointer
  only passed over.
- **The screenshot paints the OS cursor.** An arrow appears in the PNG wherever the pointer sits
  inside the element box, so a shot taken with the pointer over the message log shows both a cursor
  and that row's hover highlight.

Park the pointer like this before any frame screenshot: move onto a neutral element inside the frame,
then leave straight out sideways so the exit path crosses nothing, ending well outside the element
box so no cursor pixels land in the shot.

```js
const box = await state.page.locator(".PluginsUiFrame").boundingBox();
await state.page.mouse.move(box.x + 90, box.y + box.height - 30, { steps: 4 }); // neutral, in-frame
await state.page.mouse.move(box.x - 110, box.y + box.height - 30); // straight out, cursor off-frame
await state.frame.evaluate(() => document.activeElement?.blur?.());
```

Assert it instead of trusting it: the count of `li.message` rows matching `:hover`, and the same over
`.channel-item`, must both be 0 before you shoot.

The same quirk is also a tool. To photograph a hover state with no cursor in the frame, hover the
target and then leave straight out sideways: the frame keeps the hover, the cursor is gone, and the
shot shows the hovered state cleanly.

## `page.route` needs a session with no plugin frame attached, and one form of it kills the relay

Hit 2026-08-24 while swapping a plugin bundle. Two separate failures, one recovery.

- **`route.fetch()` on the plugin frame's own navigation request took the whole relay down.** Not
  the session — the relay: `playwriter session list` then answered `No active sessions`, so every
  agent's session in every repo was gone, and the log's first line was `CDP relay server started`
  again. Do not refetch an out-of-process frame's request through the extension bridge. Fetch the
  bytes you want to serve yourself (a plain `fetch` inside the runner to a local static server is
  fine) and `route.fulfill` from memory, so the handler touches no browser network path.
- **`page.route` itself fails once the plugin OOPIF is attached**, with
  `Protocol error (Network.setCacheDisabled): No tab found for method Network.setCacheDisabled
  sessionId: <hex>`. Playwright turns the cache off on every attached session and the extension
  relay cannot address the separate plugin target. **Navigating away does not fix it** — the
  connection still tracks the dead session and the next `page.route` fails with the same session
  id. Only `playwriter session reset <id>` clears it. So the working order is: reset, reinstall the
  harness, `bindOpenTab`, install the route, and only then navigate to the plugin page. A fresh
  session that has never opened a plugin page can install the route straight away.
- **`page.unrouteAll()` and `page.context().newCDPSession(page)` kill the session the same way**,
  measured 2026-08-24 on playwriter 0.4.0. Both go through the same cache-disabling step, so both
  print the `Network.setCacheDisabled ... No tab found` error, and every later call in that session
  then fails with a hono stack ending in
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. `playwriter session delete <id>`
  followed by `session new` recovers just as well as `session reset` and is what these notes were
  written from.
- So install the route **once**, right after `bindOpenTab`, and never touch `route`, `unrouteAll`,
  or `newCDPSession` again in that session. To take a swap back off, delete the session — that
  drops its handler — then make a new one and navigate the tab so the frame reloads the real
  published bundle.

## `page.route` never sees a plugin frame's subresource requests

Hit 2026-08-24 while serving a working-tree plugin build at the published asset URL. Through the
extension relay, a `page.route` on the asset prefix is called **exactly once per load** — for the
frame's own navigation request. The frame is an out-of-process iframe, and the requests it then
makes for `assets/index.js` and `assets/index.css` never reach the handler at all.

Nothing reports this. The handler serves a working-tree `index.html`, the two script and link tags
in it load the **published** bundle, and the page comes up looking swapped. Two runs of QA were
recorded against the published code before a CSSOM read of a rule that only exists in the working
tree showed the swap had never happened.

So make the route handler record what it was asked for, and read that back after every load:

```js
state.seen = []
await state.page.route((url) => url.pathname.startsWith(prefix), async (route) => {
	state.seen.push(new URL(route.request().url()).pathname.slice(prefix.length))
	// …
})
```

`state.seen` holding one entry means the subresources went around you. And prove the swap itself
with something only the new build has — a CSSOM rule, a new string, a changed constant — not with
"the page loaded".

The fix is to inline the assets into the one response the route really controls: read the JS and
CSS yourself (a plain `fetch` in the runner to a local static server), and emit them as a `<style>`
and an inline `<script type="module">` inside the served HTML.

That needs a CSP source, because the asset policy is `script-src 'self'` with no `'unsafe-inline'`.
Do not add `'unsafe-inline'` — the frame would then run under rules the real one does not have.
Compute the script's own `sha256-` and add just that, copying the rest of the policy verbatim from
the published response:

```js
const scriptInner = "\n" + script + "\n"
const hash = crypto.createHash("sha256").update(scriptInner, "utf8").digest("base64")
const csp = "default-src 'none'; script-src 'self' 'sha256-" + hash + "'; …"
```

**Hash the exact bytes that go between the tags.** CSP hashes the element's text content, so
hashing `script` and then writing `"\n" + script + "\n"` produces a hash the browser refuses. The
console names the hash it wanted, which is the fastest way to notice.

A working runner is
`t3-chat-+personal/+ai/chitchat-slack-planning-2026-08-23/runners/swap-plugin-bundle-v3.js`.

## A fulfilled body outlives the session that produced it, and the handler still says it fulfilled

Measured 2026-08-24 on playwriter 0.4.0, swapping the Chitchat bundle at the published asset URL.

A brand new session installed a handler, logged the body it had built, and `state.seen` recorded
the navigation request. The frame ran a **different** body — one built by a handler two deleted
sessions earlier. Nothing in the session reports this: the log line, `state.seen`, and
`state.swapped` all describe the body you meant to serve.

The browser cache is not the cause. Every response carries `cache-control: no-store`, and the
frame's navigation timing entry reported a real transfer, not a cache hit.

Two things made it visible, and both are worth keeping:

- **Read `encodedBodySize` from the frame** and compare it with the byte length of the body you
  built. It matched an older variant exactly, which is what turned a vague suspicion into a fact:

  ```js
  await frame.evaluate(() => performance.getEntriesByType("navigation")[0].encodedBodySize)
  ```

- **Tag the served HTML.** `swap-plugin-bundle-v3.js` now writes
  `<meta name="cc-swap" content="<variant>|<hash12>" />` into every body it serves, so the frame can
  say which body arrived. The tag was absent, which named the stale body without any arithmetic.

`page.reload()` kept handing back the old body over several tries. What finally delivered a newer
one was a top-level `page.goto` to another app route and back — the plugin frame is then built from
scratch. It still arrived one body behind, so read the tag again after the navigation instead of
assuming the second attempt worked.

`page.goto` has its own 10 s navigation timeout and ignores the CLI `--timeout`: with
`--timeout 180000` on the command line it still failed with `page.goto: Timeout 10000ms exceeded`.
The app shell takes longer than that here, so pass
`{ waitUntil: "domcontentloaded", timeout: 60000 }` on every `goto`.

## A Vite dev server does not serve a `dist/` file as written

Do not point a QA check at `http://localhost:<vite>/dist/…` expecting the built bytes. Vite serves
files under its root through its transform pipeline: measured 2026-08-24 on the Chitchat build, the
dev server answered 200 for all three files but with **1,380,727 bytes for a 431,488-byte
`index.js`** and 612 for a 361-byte `index.html` (an HMR client injected into the head). The
status code and the path both look right, which is what makes it dangerous — the check runs against
a different program. Serve a build with a plain static server (a ten-line `node:http` script) when
the bytes have to be the built ones.

## An action button that is `pointer-events: none` until hover reads as an overlay bug

Chitchat's message rows keep their actions at `opacity: 0; pointer-events: none` until
`.message:hover` or `:focus-within`. A plain `click()` on one times out with
`<li class="message"> intercepts pointer events`, which reads like an overlay covering the button —
it is not, and hit-testing it will not explain it. Hover the row first, wait a moment, then click:

```js
const row = fl.locator("[role=log] li").filter({ hasText: "second message" })
await row.hover()
await state.page.waitForTimeout(400)
await row.getByRole("button", { name: "Add reaction" }).click({ timeout: 15000 })
```

Before filing a finding like this, check the owning stylesheet for a hover-revealed actions block.
Keyboard users reach these through `:focus-within`, so the pattern is not an accessibility defect
by itself.

## A `matchMedia` component in a plugin frame lags a viewport change by more than a second

Two findings were filed and withdrawn on 2026-08-24 for this. After `setViewportSize` and again
after `Emulation.clearDeviceMetricsOverride`, the Chitchat frame still reported the previous
breakpoint's UI **1.5 s later**: the back button read `Close thread` where the narrow layout wants
`Back to messages`, and the drawer's `inert` attribute still described the wide layout. Both were
correct components; the read was early. The frame is out of process, so the resize has to reach
another renderer, run its `matchMedia` listener, and finish a React commit before any of it is
observable.

Wait ~2.5 s after any viewport change before reading breakpoint-driven state in a plugin frame, or
poll the value you expect rather than sampling once. And before filing a responsive-layout finding,
re-read it once more after a further wait — a component that "does not react to the breakpoint" is
usually one that reacted after you looked.

## Injecting axe into a plugin frame: it has to ride in with the bundle

The plugin asset CSP is `script-src 'self'` with **no** `'unsafe-inline'`, so
`addScriptTag({ path })` — which injects the file's contents inline — is refused inside the frame,
unlike the Council room and the dev server described above.

`addScriptTag({ url })` pointing at the plugin's own asset prefix does not rescue it either, even
when a run already swaps the bundle through `page.route`. That URL is a frame **subresource**, and
the route handler never sees those (see the subresource entry above), so the request goes to the
real asset server and 404s. This entry recommended exactly that until 2026-08-24; it never worked.

What works is serving axe inside the same navigation response as the swapped bundle: read its bytes
in the runner, emit it as a classic `<script>` before the module script, and give it its own
`sha256-` source in the CSP. Read the bytes over HTTP from a small local server rather than off
disk — `readFileSync` on the OS temp folder killed the whole CLI invocation here (see the sandbox
`fs` entries under Playwriter Availability). Then:

```js
const report = await frame.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }))
```

Read `window.axe.version` back and put it in the evidence — see the pinning entry above.

## Rich text editor (ProseMirror): read the right editor, and read its schema

- **`document.querySelector(".ProseMirror")` on `/files` usually does NOT return the file editor.** The route mounts at least three ProseMirror instances: the file editor (`.FileEditorRichText-editor-content`), the AI chat composer (`.AiChatComposer-editor-content`), and the comment composer (`.FileEditorCommentsComposerControl-editor`). Which one comes first in DOM order changes with mount timing, so the same probe can read the file editor before a reload and the chat composer after one. The composers have tiny schemas (5 and 3 node types), so a probe for an editor feature reports it missing and the run looks like a real regression. Verified 2026-08-04: this produced a false "the feature is gone" reading that survived two full reloads. Always scope to `.FileEditorRichText-editor-content`, and sanity-check identity with a node only the file editor has (`youtube`).
- **Reading the live ProseMirror schema is the cheapest proof that the browser runs your working tree**, and it needs no document edit and no writable workspace. ProseMirror parks its view description on the DOM node:

```js
const el = document.querySelector(".FileEditorRichText-editor-content");
const schema = el && el.pmViewDesc && el.pmViewDesc.node.type.schema;
Object.keys(schema.nodes); // registered node names
schema.nodes.image?.isInline; // and per-node spec facts
```

  Poll it: the editor mounts a few seconds after `domcontentloaded`, and until then `pmViewDesc` is undefined, which reads the same as "the node is missing".
- **Editing a rich-text editor module and letting HMR apply it crashes the app tree** with `useAppAuth must be used within AppAuthProvider` (a pageerror, followed by a `ConvexProviderWithAuth` error-boundary warning) and leaves no `.ProseMirror` mounted at all. Verified 2026-08-04 after a hot update of `file-editor-rich-text.tsx`. Do a full `reload(...)` after touching editor modules instead of trusting the hot update, and do not read the post-HMR blank state as a fault in the change.
- That crash's damage outlives the blank screen: the dead React tree took the Convex auth refresh loop with it, so on that same page a later `page.evaluate` Convex action answers `Unauthenticated` even though the user is signed in and a fresh tab works fine. Always `goto`/`reload` first and wait for the route content, then run evaluate-driven Convex calls. Hit twice on `create_text_node` 2026-08-08.
- The sidebar `New file` / `New folder` buttons being disabled on every cold page load was an app bug, found 2026-08-04 and fixed 2026-08-08: `files-sidebar.tsx` called the `canWriteParentId` useFn during render, so the React Compiler cached the first render's answer from before the write-permission query resolved. If a permission-gated control looks wrongly disabled again, run this differential first — it separates a real permission refusal from a frozen render value in one minute: (1) probe the backend answer directly from page context (`app_convex.query(app_convex_api.access_control.get_current_user_workspace_permission, { membershipId, permission: "content.write" })`); (2) client-navigate away and back (two link clicks, no reload). Backend true + enabled-after-remount means a useFn (or other stable-identity function) is being called during render and the compiler memoized it.
- Creating fixtures through the app's own Convex client from page context (`await import("/src/lib/app-convex-client.ts")`) works for any mutation the signed-in user may call, and is the fastest route when UI would need many steps. Get the membershipId with `organizations.get_membership_by_organization_workspace_name({ organizationName, workspaceName })`.

## Monaco (plain text and diff editors)

- **Synthetic input does not reach Monaco at all since `monaco-editor` 0.56.0** (verified 2026-08-03, in Edge extension mode AND headless direct CDP, on a writable editor). `locator.click()` on `.view-lines` does not focus the editor: no `.focused` class appears and `document.activeElement` stays on `<body>`. `keyboard.type`, `keyboard.insertText`, clipboard paste (`Control+v`), and shortcuts (`Control+a`, `Control+c`, `Control+End`) never reach the model, even when focus is confirmed. The focus target is now `div.native-edit-context` (tabindex 0, `role="textbox"`); `textarea.ime-text-area` still exists but has tabindex -1 and is not the input path. A programmatic `.focus()` on `.native-edit-context` does set `document.activeElement`, but typed input still does not land. Do not burn retries on alternate click or typing recipes, and do not read "typing does nothing" as a read-only editor — probe `aria-readonly` and the toolbar instead.
- **Working route to a live editor handle (verified 2026-08-10 in the joint 4/5 QA run):** two equivalent page-context forms. The dev-only keyed accessor `window.__qa.monaco()` returns `{ plainText?, diffOriginal?, diffModified? }`, so a runner can tell the diff panes apart. The namespace import `const m = await import("/@id/monaco-editor")` gives `m.editor.getEditors()` (mount order — ambiguous once the diff editor's two panes are up) plus the full API. A bare `import("monaco-editor")` throws in page context; `/@id/monaco-editor` is the Vite-transformed id.
- To CHANGE local editor content through the app's own command pipeline, use the handle: `ed.trigger("keyboard", "type", { text })` runs the same command path as typing (change events, dirty check, undo stack), and `ed.executeEdits("qa", [{ range: ed.getModel().getFullModelRange(), text }])` replaces the document without auto-indent/auto-closing interference. Position the caret first with `ed.setSelection(...)` / `ed.setPosition(...)`; undo with `ed.trigger("keyboard", "undo", null)`. Honesty line for reports: `trigger` proves the editor→model pipeline, not the broken browser→Monaco input path (`native-edit-context`), so it cannot prove a real-user typing regression.
- To READ the language, read `data-mode-id` from the editor root (`document.querySelector(".FileEditorPlainText .monaco-editor").getAttribute("data-mode-id")`) or `ed.getModel().getLanguageId()` — `json` for a `.json` node, and so on. Verified 2026-08-10; pair it with the distinct `mtk*` token classes under `.view-lines` to prove tokenization actually ran.
- To create a pending draft as server state instead of a local edit, use the client helper recipe in `file-node-view.md` (`files_upsert_file_pending_update` from `/src/lib/files.ts`). The old direct `upsert_file_pending_update({ unstagedMarkdown })` action shape is gone since the 2026-08-10 paged staging flow.
- To READ pane text, do not trust `.view-lines` `innerText`: the line divs are not in document order. Collect `.view-line` nodes and sort them by `style.top`:

```js
const lines = Array.from(vl.querySelectorAll(".view-line"))
	.map((l) => ({ top: parseFloat(l.style.top || "0"), text: l.textContent.replace(new RegExp("\\u00a0", "g"), " ") }))
	.sort((a, b) => a.top - b.top)
	.map((l) => l.text);
```

Two caveats: only rendered lines exist in the DOM (fine for short fixtures, wrong for the tail of a long document), and a soft-wrapped long line produces several `.view-line` entries that join without a separator — prefer short lines in fixtures.

- Monaco can take well over 20s to mount on the `/files` route. A check at ~9s reports `monaco visible: false` for an editor that is merely still loading. Do NOT raise `--timeout` to cover this (keep it under 5000ms per the rule above) — poll `.monaco-editor` across several short execute calls and observe between them.
- `context.grantPermissions([...], { origin })` fails in extension mode with `No tab found for method Browser.grantPermissions`, but `navigator.clipboard.writeText` from `page.evaluate` still succeeds. In a headless direct-CDP session `grantPermissions` works, and `clipboard.readText` needs it.
- Monaco applies an app-driven `executeEdits` write slightly after the call returns, so a pane read in the same execute call can still show the old text. Assert the new text in the next observe step instead of treating the first read as a failure.
- `auditAccessibility` always flags Monaco's own input host. `div.native-edit-context` (role `textbox`) is reported as a small target (measured 436x19 for a 220px-tall editor) and as covered by the `.view-line` above it. Both are Monaco internals, not app bugs: the real hit target is the editor box around them. Discount them the same way as `.MyCheckboxButton-control`, and read `controlCount` to check the audit found the panel at all (verified 2026-08-18 on the Properties modal's Metadata section: controlCount 2, no unlabeled controls).
- **Monaco traps Tab by default, which is a keyboard trap in any small embedded editor.** A user who tabs into the editor can never tab out to the Save button. The fix is `tabFocusMode: true` in the editor options (the Properties modal's Metadata editor sets it; verified 2026-08-18). Include a Tab-out check whenever a route embeds Monaco next to other controls. The plugin configuration YAML editor still has this trap.

## Diff editor

- **The two panes are inverted from the usual diff mental model.** `.FileEditorDiff .editor.original` is the **staged** side and is read-only in the UI (`originalEditable: false`); `.FileEditorDiff .editor.modified` is the **unstaged** side and is where typing lands. Save publishes the **staged** side, so a test that puts content into `.modified` and clicks Save changes nothing until it also accepts. Synthetic typing cannot drive either pane (see the Monaco section above); use the keyed handles (`window.__qa.monaco().diffModified`) for local edits, or create/update the unstaged draft with the `files_upsert_file_pending_update` client helper from page context (recipe in `file-node-view.md`).
- **Toolbar `aria-label`s do not match the visible text.** `getByRole("button", { name: "Accept all + save" })` finds nothing. The real names are `Save staged changes`, `Sync with live file`, `Accept all pending changes in this file`, `Accept all pending changes and save`, `Discard all pending changes in this file`, `Open file snapshots`. Read the labels with `.FileEditorDiffToolbarActions button` + `getAttribute("aria-label")` before guessing.
- Switch views without a page load (which costs an auth-token refresh) by clicking the view switcher label: `.MyButtonGroupItem-button` filtered by text `Rich` / `Markdown` / `Diff` on a Markdown node, `Code` / `Diff` on a plain-text node.
- The content-size cap surfaces as `.FileEditorDiffToolbarActions-size-badge` (`MyBadge-variant-secondary` near the cap, `-destructive` over it) plus an `sr-only` `role="status"` live region. The badge tracks `max(staged, unstaged)`, so after an accept it can stay red even though the pane you were typing in looks small — the staged side is the one still over the cap. The same badge/live-region pair exists in the rich text and plain text editors.
- Draft edits sync through a 250ms debounce and failures there are `console.error` only, never a toast. To assert a draft sync did or did not happen, use `getLatestLogs({ search: /Failed to sync pending updates/i })` rather than looking for UI.
- Over-cap content blocks `Save`, `Accept all pending changes in this file`, and `Accept all pending changes and save`. All three show the same `toast.error` and change nothing: the staged pane keeps its old text and the accept buttons stay enabled. Read the toast in the **same** execute call as the click — sonner auto-dismisses in ~4s and a second CLI round trip is already too slow, so a separate observe step reports `toasts: []` and looks like no toast fired.
- Nothing over-cap ever persists, so a reload is the cheapest way to reset a wedged over-cap draft back to committed content.
- Monaco applies programmatic edits asynchronously enough that a pane read in the same execute call still shows the old text. Assert the new text in the next observe step instead of treating the first read as a failure.

## Backgrounded Tabs

- On a backgrounded localhost tab, `snapshot()`, `screenshot()`, and `innerText` are unreliable. Read state via `evaluate()` with `textContent`, `getComputedStyle`, and `getBoundingClientRect`.
- `getComputedStyle` is reliable on a backgrounded tab **except while a CSS transition is running on the property you are reading**. A backgrounded tab does not run animation frames, so a transition you just started freezes on its first frame, and the value you read back is the start value serialized in the transition's own interpolation space. Measured 2026-08-23 on the Council dashboard preview: toggling `aria-busy="true"` on a `.button` should have computed `background-color` to `color(srgb 0.33 0.38 0.91 / 0.55)`, and returned an opaque `oklab(...)` instead. That reads exactly like `color-mix()` failing to resolve, so the first guess is a broken stylesheet or a stale file being served, and both are wrong. Waiting longer does not help either, because the frames never arrive. Set `el.style.transition = "none"` before the change you want to read, or front the tab.
- A screenshot of a backgrounded tab can return a STALE frame: the capture succeeds and the file looks valid, but it shows the page as it was before your last change (observed 2026-08-02: a theme switch to light returned the previous dark frame; the new file was nearly byte-identical to the prior capture). Near-identical file size to the previous screenshot is the signature. Call `state.page.bringToFront()` before any screenshot you intend to trust, or verify the change with `getComputedStyle` readbacks instead.
- `locator.click()` on popover triggers can hang on a backgrounded tab. Prefer foregrounding the tab; if that is not possible, DOM `el.click()` is the documented exception to the no-`element.click()` rule (see `agent-panel.md`).
- Real wheel input (`mouse.wheel`) is silently dropped on a backgrounded tab: `scrollLeft`/`scrollTop` stays 0 with no error. To prove a wheel handler works, dispatch a synthetic `WheelEvent` with `evaluate()` (`el.dispatchEvent(new WheelEvent("wheel", { deltaY: 220, bubbles: true }))`) and read the scroll position after. A zero from a real wheel on a backgrounded tab is a delivery artifact, not proof the handler is broken.
- Convex deploy (`convex dev --once`) and Vite HMR can blank a backgrounded tab entirely (empty body, all selectors gone). Recover with the reload recipe in `agent-panel.md` before the next interaction.
- The route error boundary is `#root > div.AppRouteError.AppRouteError-layout-fullscreen` (body text `Something went wrong`). Check that class before anything else when a probe returns zero landmarks — it is cheaper than a snapshot and unambiguous. It can appear with **no** `pageerror` in `latestLogs` at all (only `[vite] hot updated: /src/app.css` lines), so absence of an error log is not evidence the app is healthy. Only `page.reload()` recovers; `Try again` does not, and one reload is sometimes not enough while sources are still being saved.
- A `/files` reload does not finish inside the 5000 ms CLI budget. Start it with the fire-and-forget pattern, then poll `document.querySelectorAll("main").length` and `[role="treeitem"]` count in **separate** short calls until both are non-zero — a single in-runner poll loop just burns the whole budget and reports a timeout.
- Someone editing app sources while you drive the browser will blank the tab repeatedly. The signature in `latestLogs`: `[vite] hot updated: <file>`, then `[pageerror] useAppAuth must be used within AppAuthProvider` plus an `<ConvexProviderWithAuth>` error-boundary warning, and `#root` drops to 0 children with an empty body. Editing a TanStack route file adds `Could not Fast Refresh ("Route" export is incompatible)`, `failed to apply HMR as it's within a circular import`, and `ReferenceError: Cannot access 'rootRouteImport' before initialization` from `routeTree.gen.ts`; that combination forces a full reload. Only `page.reload()` recovers — the error boundary's `Try again` does not. If this keeps happening, say so in the report: findings taken across those reloads are against a moving build and need re-verification on a settled one.
- Hidden hoisted modals keep `aria-busy="true"` while closed (0x0 rect). Busy/idle checks must count only visible `aria-busy` elements or they will report busy forever.
- Edge gives all `localhost:5173` tabs one shared renderer process. Killing a wedged renderer PID therefore crashes **every** localhost tab, including the user's own. Observed 2026-08-02: a `New chat` click wedged the renderer at full CPU; killing the PID took down the user's other app tabs, which then had to be reopened by URL. Before considering a process kill, record every localhost tab URL (`context.pages().map((p) => p.url())`), try closing only the stuck tab or replacing it with a fresh one (next entry), and treat the PID kill as a last resort that needs tab-restore work afterwards.
- To photograph a UI state that lasts under a second (a flash, a spinner blip): `Page.startScreencast` looks like the obvious tool but is a trap when the browser window is occluded on the user's desktop — the compositor stops painting, so every screencast frame is the same stale image (byte-identical files are the signature; hash them). `Page.captureScreenshot` over `getCDPSession(...)` DOES force a fresh paint even while occluded and takes ~70-100 ms per shot. The recipe that worked (2026-08-08, ~130-600 ms flash): set a `window` flag from a MutationObserver when the target state appears, `waitForFunction` on that flag with `{ polling: 15 }`, then fire 4 `Page.captureScreenshot` calls back to back and pick the good frame afterwards. Two extra gotchas: the state must be inside the viewport (scroll the target element into view first — an off-screen flash produces identical screenshots of an unchanged viewport), and JS/MutationObservers keep running normally while occluded, so DOM-level logs stay trustworthy even when pixels are stale.
- A tab that has been open for many hours can wedge in a way reloads do not fix: a `[pageerror] Failed to execute 'measure' on 'Performance': Data cannot be cloned, out of memory` appears, and then **every** navigation or reload lands in the route error boundary with the HMR-blank signature (`useAppAuth must be used within AppAuthProvider`), even though the dev server and React Compiler are fine (`curl localhost:5173/src/components/my-button.tsx | grep -c '_c('` is non-zero). Stop reloading: open a fresh tab (`context.newPage()` + `goto`), point the harness at it (`state.page = p; state.appPlaywriterHarness.page = p`), and close the old tab. The fresh tab loads the same routes cleanly. Verified 2026-08-02.

## Ariakit wrappers must never re-forward `id`

Tab `aria-controls` resolves correctly again (fixed 2026-07-26): on `/files` all three `[aria-label="Sidebar tabs"]` tabs, the selected `[aria-label="Open chats"]` tab, and all three account-modal `[aria-label="Account sections"]` tabs point at a real panel whose `aria-labelledby` points back at the tab. `document.getElementById(tab.getAttribute("aria-controls"))` is a valid probe now, and `[role="tabpanel"][aria-labelledby="<tab id>"]` remains valid as a cross-check.

Keep the failure mode in mind, because any Ariakit wrapper can reintroduce it:

- A wrapper that destructures `id` and re-passes `id={id}` hands Ariakit an explicit `id: undefined` when no caller passed one. `useTabPanel` builds `props = { id: <generated A>, …, ...props }`, the spread overwrites `A` with `undefined`, `useFocusable` drops the key via `removeUndefinedValues`, and `useDisclosureContent` stamps a fresh id `B` on the DOM — while the store still registers `A`. The tab then advertises an `aria-controls` that matches nothing (axe `aria-valid-attr-value`, critical), and a probe reads it as an unmounted panel when the panel is right there.
- The fix is to let `id` ride in `...rest`. `packages/app/src/components/my-tabs.tsx` does this for `MyTabsTab`, `MyTabsTabPrimaryAction`, `MyTabsPanel`, and `MyTabsList`.
- Chat tabs in `[aria-label="Open chats"]` legitimately carry **no** `aria-controls` (they own no panel); only the selected one does. Absent is not dangling — do not report it.
- Popup triggers (`MyModalTrigger`, `Past chats`, `Chat mode: …`, `Chat model: …`, the rich-text link setter) keep `aria-controls` pointing at an `unmountOnHide` popover. axe reports these as `aria-valid-attr-value` **incomplete** ("Unable to determine … while using aria-haspopup"), which is the expected result for that pattern, not a defect.

## Finding `axe.min.js`, and why the obvious way to load it fails

There is **no `axe-core` in this repo's own `node_modules`**, so a runner that reaches for a repo path
finds nothing. Two copies exist on this machine:

- The pinned **4.12.1** used for the room reviews, under
  `t3-chat-+personal/+ai/council-production-room-2026-08-22/axe-install/node_modules/axe-core/axe.min.js`
  (572,599 bytes). This is the one to reuse when a result has to line up with an earlier run.
- An unrelated **4.10.3** inside `references-submodules/assistant-ui/node_modules/`. It belongs to that
  submodule, not to us — do not audit this app with it and assume the rule set matches.

`snippets.md` owns the install recipe and puts a fresh copy in the OS temp folder. That recipe **is**
version-pinned — it runs `pnpm add axe-core@4.12.1`. The way runs still drift apart is skipping the
install, not missing the pin: on 2026-08-22 a reviewer wrapped the whole install block in a
`Test-Path` guard, so an earlier session's cached **4.13.0** was reused and the audit ran a different
rule set under the pinned recipe's name. A pinned version you skip installing is not a pin. So read
`window.axe.version` back in the page before you compare findings across runs, and put that line in
the evidence next to the results.

Load it with `page.addScriptTag({ path })` and an **absolute** path. Playwright reads that file itself
rather than through the runner's sandboxed `fs`, so the sandbox's path restriction never applies — use
an absolute literal because a relative one resolves against the relay's working directory, not yours
(see the `path.resolve` entry below). Reading the bytes yourself first is the way that fails:
`require("node:fs").readFileSync(...)` on a path outside the session cwd is refused, and under a
Windows relay it takes the CLI down with it rather than returning a clean error (see the sandbox
`fs` entries under Playwriter Availability). **The OS temp folder is not the safe harbour this
entry used to promise.** Verified 2026-08-24: a `readFileSync` of a 573 KB file the shell had just
written under `%TEMP%` killed the CLI invocation with the same libuv
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, from a session whose cwd was the repo
root. So if you genuinely need the bytes inside the runner, do not read them — serve them over
HTTP from a small local `node:http` server and `fetch` them, or embed them in the `-f` runner.

Two reviewers hit this from opposite directions in the same round on 2026-08-22. CSP is not the
obstacle it looks like. `addScriptTag({ path })` injects the file's contents as an inline script, and
the Council room builds `script-src 'self' 'unsafe-inline' <SDK origins>` (`room-page.ts`), so the
injection is allowed there; the dev server sets nothing that blocks it either.

## axe `color-contrast` INCOMPLETE hides real failures in this app

`incomplete` is not "probably fine". Always resolve the whole incomplete list with the canvas recipe in `snippets.md` before calling a route clean, and check the **token**, not just the one element axe happened to resolve.

Token reference on these dark surfaces (measured 2026-07-26): `--color-fg-04` (`oklch(0.405 0.008 81)`, `#4b4944`) lands at **2.1:1** and fails AA badly; `--color-fg-06` (`oklch(0.541 0.011 81)`, `#726e68`) lands at **3.57–3.72:1** and fails AA at normal weight; `--color-fg-07` (`#87827b`) measures **4.74–4.95:1** and clears AA; `--color-fg-09`/`-10`/`-11` measure 5.9–12.1:1. So a gradient-undetermined node is not automatically a defect, but any `--color-fg-04` or `--color-fg-06` body text is.

Current state after the `--color-fg-06` → `--color-fg-07` and `--color-fg-04` → `--color-fg-07` sweeps finished (2026-07-26): `/files` (`nodeId=root` and nested) resolves 50–52 incomplete nodes with **0** app-code failures, `/users` resolves 5 with **0**, an open modal resolves 5 with **0**, and a chat thread measures 28 disclosure labels with **0**. `.AiChatMarkdown-code-header` now measures **4.74:1** on `#171614` and passes. The only remaining "failure" on every route is `.go1561890071`, the TanStack Router devtools badge — dev-tools overlay, not app code, always exclude it.

`.AiChatMessagePartDisclosureButton` / `.AiChatMessagePartThinking-text-only` (`packages/app/src/components/ai-chat/ai-chat-message.css`, the `#region part disclosure button` block) used to set `color: var(--color-fg-04)` at `font-size: 0.875rem` — **2.1:1**, repeated once per tool part, so a thread with many `bash` calls resolved ~29 real failures at once. Fixed to `--color-fg-07` (2026-07-26) = **4.95:1** on `#121111`; a 14-disclosure thread now measures 28 labels with 0 failures. When re-checking, measure a chat route explicitly: none of these nodes exist on `/files` or `/users`, so a clean sweep there says nothing about them. Check the ancestor `opacity`/`filter`/`mix-blend-mode` chain before filing a low ratio — here every ancestor is `opacity: 1`, so the number is real.

The streaming label shimmer (`.AiChatMessagePartThinking-streaming`) paints through `background-clip: text` with `color: transparent`, so `getComputedStyle(el).color` reads `rgba(0,0,0,0)` and the canvas recipe cannot score it. Read `backgroundImage` instead and score its **stops**: they are now `fg-07 → fg-10` (4.95:1 → 10.54:1), i.e. the wave starts at the settled colour and only brightens. It previously ran `fg-04 → fg-07`, dipping below AA for most of each cycle. To render it without spending a model call, add the `AiChatMessagePartThinking-streaming` class to an existing `.AiChatMessagePartDisclosure` and remove it after; `animationPlayState: paused` + a negative `animationDelay` freezes any phase, and `backgroundPosition` sweeps 91% → -50% across the cycle.

axe targets the code-fence label through its `[data-streamdown="list-item"]` ancestor, so it reads as a "markdown list item" in a report, and reports it as `incomplete` with `messageKey: "bgOverlap"` rather than a ratio — always resolve the real element before naming the rule.

`.go1561890071` (`TanStack Router` devtools badge, 1.03:1) shows up on every route. It is the dev-tools overlay, not app code — exclude it. axe classifies it inconsistently: it lands in `violations` on some runs and in `incomplete` on others, which alone moves the `/files` distinct-violation count between 3 and 2. **Do not regression-test on the violation count** — compare rule ids and node targets (expected `/files` baseline since 2026-08-08: `nested-interactive` on the chat tabs, accepted by design; the 2026-07-26 `aria-required-children` and `region` violations are fixed), and resolve the contrast question separately with the canvas recipe.

The 2026-08-10 plain-text QA runs extended the same baseline to the Monaco surfaces without replacing it. On the plain editor route (a `.json` node, default plain view) and the diff route: no new rule ids or node targets beyond the baseline above; the `auditAccessibility` screen reported **0 unlabeled controls and 0 negative-tabindex problems** on both runs. Monaco's focus target (`div.native-edit-context`, role `textbox`) is labeled `File content editor`, and each diff pane carries its own aria label. Two rows to know when comparing:

- `Open file snapshots` can be reported as a blocked hit target on the editor toolbar. That is toolbar **overflow**, not an overlay: check `scrollWidth > clientWidth` on `.FileNodeViewToolbar` before filing it — with a narrow panel the trailing buttons clip under the Comments tab strip (a recorded design question, not a broken control).
- The `Rich` / `Markdown` / `Diff` small-target rows in the pre-slice baseline read `Code` / `Diff` on plain-text nodes — same 1×1 visually-hidden radios, same accepted pattern, only the labels differ.

## Reading real painted pixels: a `data:` fetch is CSP-blocked, and a rounded box leaks its backdrop

`getComputedStyle` reports the declared colour, not the pixel that was painted, so it cannot score a `backdrop-filter`, an opacity-composited group, or an outline drawn over moving video. The only way to score those is to capture the composed frame with CDP `Page.captureScreenshot` and sample it. Two things bite while doing that:

- **`fetch("data:image/png;base64,…")` is refused on a page with a strict `connect-src`.** The usual decode step — fetch the data URL, take the blob, draw it — dies with `TypeError: Failed to fetch`, which reads as a broken page rather than a policy refusal. `data:` is not covered by `'self'` and has to be listed on its own, and the Council room's policy (`packages/council-service/src/room-page.ts`) is `default-src 'none'` with `connect-src 'self' <provider origins>`. Decode without the network instead: `atob` -> `Uint8Array` -> `new Blob([bytes])` -> `createImageBitmap(blob)` -> draw to a canvas -> `getImageData`. That path asks no directive for permission. An `<img src="data:…">` also loads on the room, because its `img-src` does list `data:`, but the blob route works on any page and skips the image load wait.
- **Sampling a rounded box by its bounding rect reads the backdrop through the corners.** The rect covers the corner squares that the border radius cut away, so those samples are whatever sits behind the element. In a pixel histogram they show up as false extremes — a near-black sample on a light chip — and they move the worst-case number the whole measurement is about. Inset every sample past the border radius before reading it.

Measured 2026-08-22 on the Council room. Related: keep `scale: 1` on a clipped capture, see the `Page.captureScreenshot` clip entry above.

## A canvas hands an `oklch()` colour straight back, so a contrast probe scores every pair at 1.0

The usual way to normalise a CSS colour is to assign it to `ctx.fillStyle` and read the property
back, because the canvas answers `#rrggbb` for anything it understands. Chrome understands
`oklch()` and answers the **same `oklch(...)` string**. A probe that then scrapes numbers out of
that string reads lightness, chroma, and hue as if they were red, green, and blue.

This app is written entirely in `oklch()` — the whole `--color-base-*` / `--color-fg-*` palette and
everything a plugin frame inherits from it — so this hits every contrast probe here. Measured
2026-08-24 in the Chitchat frame: pairs that really run from 5.2:1 to 17.2:1 all scored between
1.00 and 1.08. That reads as a page with no contrast at all, which is alarming enough to send you
hunting for a styling bug that does not exist.

Convert through real pixels instead. Paint the colour on a 1×1 canvas and read it back:

```js
const cv = document.createElement("canvas")
cv.width = 1
cv.height = 1
const ctx = cv.getContext("2d")
const rgb = (color) => {
	ctx.fillStyle = "#000" // A colour the canvas refuses leaves the previous value in place.
	ctx.fillStyle = color
	ctx.fillRect(0, 0, 1, 1)
	const d = ctx.getImageData(0, 0, 1, 1).data
	return [d[0], d[1], d[2]]
}
```

`getComputedStyle(el).backgroundColor` is `rgba(0, 0, 0, 0)` on most elements, so walk up to the
first ancestor that paints one before scoring the pair.

## axe `aria-required-children` ignores `aria-owns` — restructure the DOM instead

Proven in-page 2026-08-08 while fixing the `/files` tree: an element that a `role="treeitem"` claims with `aria-owns` still counts as a direct child of its DOM-ancestor `role="tree"` for axe's `aria-required-children`, so the rule keeps failing. The old tree already used `aria-owns` for the chevron and axe flagged it anyway, and injecting `aria-owns` for every stray child changed nothing. Do not try to satisfy this rule with ARIA attributes — move the flagged elements inside an allowed-role element (the VS Code shape: everything row-related inside the `treeitem`). Note the trade documented in `app-map.md`: putting focusable controls inside a children-presentational role (`tab`) then triggers `nested-interactive` instead; `treeitem` is not children-presentational, so tree rows stay clean.

## axe findings that are by design — do not report

- `autocomplete-valid` (WCAG 1.3.5) on the Search-chats input (`ai-chat-threads.tsx`): the input sets `autocomplete="off=<timestamp>"` from `ui_create_auto_complete_off_value()` (`src/lib/utils.ts`) because Chromium ignores a plain `off` and would autofill the field. The invalid token is deliberate and the axe failure is a user-accepted trade-off — skip it in audits and do not "fix" it.
- `nested-interactive` (serious) on every `.FileEditorSidebarAgentHeaderTabs` chat tab since 2026-08-08: the `Close tab` button lives inside the `role="tab"` element. Accepted deliberately — see the tab bullet in `app-map.md` for the full rationale. Report it only if the flagged nodes are something other than these tabs.
- `auditAccessibility` `smallTargets` on every `input.MyCheckboxButton-control`: the real `<input type=checkbox>` is a 1×1 `position: absolute` element with `pointer-events: none`, wrapped by a `<label>` that carries the whole visible row (448×54 on the API-keys scope list). The label is the hit target and it is far above the 24px minimum, so the finding is a false positive of the size heuristic, which measures the input. It also makes `locator.click()` on the checkbox role fail with `<li>…</li> intercepts pointer events` — click the label instead (see `app-map.md`). Keyboard access is fine: `focus()` lands on the input and `Space` toggles it. Verified 2026-08-14.

## A control can look named in the DOM and still reach a screen reader with no name

`combobox`, `listbox`, `textbox`, `searchbox`, `spinbutton`, `slider` and `progressbar` never take their accessible name from their own content. An Ariakit select trigger rendering `<span>home</span>` therefore computes `name=""`, even though the DOM plainly shows text.

`auditAccessibility` used to miss exactly this: its `accessibleName()` fell back to `textContent` for every role, so a value-showing combobox counted as labeled. Harness 0.6.1 stops that fallback for the roles above. Found this way on the invite dialog's workspace picker (`.RouteUsersInviteModal-workspace-trigger`, 2026-08-01), which chose which workspace an invite writes a membership in and announced nothing; fixed with `aria-label`.

The audit also over-flagged in the other direction until harness 0.6.2 (2026-08-08): the control selector includes `[tabindex]`, so every role-less `tabindex="-1"` div (tooltip anchors like the sidebar's `FilesSidebarTreeItemTitle` wrapper) counted as an unlabeled control — one false positive per sidebar row, while assistive tech announces nothing for such a div. 0.6.2 skips elements that matched only through a negative tabindex, and stops reporting negative tabindex on items inside composite widgets (`[role=tree]`, menus, listboxes, ...) where roving tabindex is the correct pattern. If an unlabeled-control report is dominated by one repeated wrapper class, check what the browser's own accessibility tree says before editing the app.

In a Playwright `snapshot()` the tell is a bare `- role=combobox:` with the value hanging under it as a child `- text:` line, instead of `role=combobox[name="…"]`. Confirm against the browser's own tree rather than DOM attributes:

```js
const client = await getCDPSession({ page: state.page });
const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: "<selector>" });
const { nodes } = await client.send("Accessibility.queryAXTree", { nodeId });
```

## A per-row action button is named after its row, so its visible text alone finds nothing

On `/api-keys` the row buttons read `Rotate` and `Revoke`, but their accessible names are `Rotate <key name>` and `Revoke <key name>`. That is correct — several key rows would otherwise offer several identically named buttons — but `getByRole("button", { name: "Revoke", exact: true })` matches **zero** elements. Playwright's `.click()` then waits for actionability on a locator that will never resolve and the whole execute call dies on the CLI timeout, which reads like a covered or disabled button rather than a locator miss (verified 2026-08-15).

Check `await locator.count()` before clicking anything whose name you guessed from the screen. When the count is 0 but `document.querySelectorAll("button")` finds the text, read `aria-label` — do not switch to a text selector or a forced click. Use the substring form (`name: "Revoke qa-key"`, no `exact`) or pass the full row-scoped name.

The confirm step is a separate dialog whose own button is `Revoke key` (`exact: true`) next to `Cancel`. Expect the same row-scoped naming on other per-item action lists.

## `auditAccessibility({ selector: "[role=dialog]" })` audits the wrong dialog and reports a clean pass

`auditAccessibility` scopes with `document.querySelector(selector)`, which returns the FIRST match in the DOM. Ariakit dialogs here stay mounted while closed, so a route can hold many of them at once: on `/api-keys` with the create dialog open there were eight `[role=dialog]` nodes, and only index 1 was the open one. The audit picked index 0 (`MainAppHeaderOrganizationSwitcherModal`, `hidden`, `display: none`), skipped all of its controls as invisible, and returned `controlCount: 0` with every finding list empty. That reads exactly like a passing audit of the dialog you meant (verified 2026-08-14).

The dialog's own component class or data attribute is not enough on its own when the route can hold two instances of the SAME dialog: `[data-files-properties-modal]` matched a closed one first and returned `controlCount: 0` again (hit 2026-08-21). Add the open flag — `[data-files-properties-modal][data-open="true"]`.

Scope the audit by the dialog's own component class instead — `.RouteApiKeysCreateModal`, not `[role=dialog]`. Playwright's `getByRole("dialog")` filters by visibility and does find the open one, so a `getByRole` probe agreeing with your expectation does not mean the audit looked at the same node. Always read `controlCount`: a zero there on a dialog that visibly has buttons means the selector missed, not that the dialog is clean.

Then discount `smallTargets` on `.MyCheckboxButton-control`. That pattern is a visually-hidden 1x1 `<input type=checkbox>` inside a `<label>`, so the heuristic flags every row while the real hit target is the label — measured 448x54 for the API-key permission rows. Measure `input.closest("label").getBoundingClientRect()` before treating one of these as a finding. The same shape is why `getByRole("checkbox", { name: ... }).check()` times out; click the visible label text instead.

## `auditAccessibility` sees nothing inside a plugin frame unless you hand it the frame

A cross-origin plugin frame runs in its own process, so an audit evaluated on the top page cannot read
one node inside it. Before harness 0.6.4 the call had no way to say otherwise, and it answered for the
host page instead: a clean report about a route nobody screened. Pass the frame:

```js
const frame = state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1);
await state.appPlaywriterHarness.auditAccessibility({ frame, selector: "body" });
```

`frame` accepts any Playwright `Frame`; it takes the same `waitForSelector` and `evaluate` calls as a
page, so everything else about the audit is unchanged. Read `url` in the result to confirm which
document was screened. Added 2026-08-24 while screening Chitchat. `page.frameLocator(...)` is not a
`Frame`. Passing it throws `target.waitForSelector is not a function` and the CLI dies with the libuv
assertion (exit 9). Use `page.frames()` as above. Verified 2026-08-26.

## A blocked hit target on a hover-revealed action is the resting state, not a bug

`auditAccessibility` measures where the pointer lands right now. A row action or message action that is
`opacity: 0` or `display: none` until its row is hovered therefore reports as blocked by the text behind
it, every time. That is the pattern working, not a finding — but only if the same rule fires on
`:focus-within` as well as `:hover`, or the control is unreachable by keyboard. Check the CSS for both,
then walk the real Tab order (focus the row's primary control, press Tab, read `document.activeElement`)
before writing it off. In Chitchat the actions are `display: none` at rest and Tab reaches People, Rename
and Archive in order once the row holds focus.

## A relay restart kills every session, and takes your `page.route` bundle swap with it

Sessions do not survive the Playwriter relay restarting; `playwriter session list` then shows fewer
sessions than you created and commands answer `No active sessions`. Scratch browsers survive, so the app
looks fine — and that is the trap. A `page.route` handler lives in the session, so a bundle swap dies
silently with it and **the frame serves the published bundle again on its next navigation**. Every later
reading then describes released code while you believe you are testing your working tree. After any
`No active sessions`, re-create the session, re-install the harness, re-install the route, and reload
before trusting one more result. Hit 2026-08-24.

## A CDP-attached scratch browser is invisible to `browser list`

`playwriter browser list` shows extension-connected browsers and `headless`. A Chrome you started
yourself with `--remote-debugging-port` is not in it, and there is no `--cdp` flag:

```powershell
vp env exec pnpx playwriter session new --direct 127.0.0.1:9223
```

`--direct` also accepts a `ws://`/`wss://` endpoint, or `1` to auto-discover Chrome on 9222. Screen
recording is unavailable in this mode. Probe `http://127.0.0.1:<port>/json/version` first to confirm the
browser is still up, since a dead scratch browser and a wrong flag fail the same way.

## App State

- Right after `goto`, routes render a bootstrap shell first — `Preparing organization` / `Redirecting to organization` with an otherwise empty page. A DOM probe at that moment sees 0 treeitems or no buttons and looks like access denied or missing data. Since 2026-08-08 the app stamps `data-app-ready` on `<html>` the moment auth, organization access, and billing bootstrap are all done: `waitForFunction(() => document.documentElement.hasAttribute("data-app-ready"))` first, then wait for route content (a non-zero `[role="treeitem"]` count for `/files`, `document.body.innerText.includes("Version")` for plugin detail pages). The attribute value is `""`, not `"true"`. A locator `[data-app-ready="true"]` stays at 0 on a ready page, including GitHub Pages. Verified 2026-08-26.
- **You cannot put the signed-in account on `Free` by patching `billing_usage_snapshots` alone.** `__root.tsx` holds the whole app behind a check that the snapshot subscription and the Polar subscription mirror agree (`billingUsageSnapshot.subscription.productId !== subscription.productId` → keep showing `Preparing organization`). Rewrite only the snapshot and every route goes blank until you put it back, so nothing about the plan can be observed. For any check that needs a non-paying identity — the upload plan gate, credit refusals — use the anonymous visitor in `second-user-fixtures.md` instead: it is a real Free payer with no data surgery. Verified 2026-08-21.
- An `Organization access denied` alert on `/w/<org>/...` usually means the signed-in user changed, not that the route broke. The browser profile's signed-in account can change between sessions (a human uses the same Edge). Read the sidebar account button (`Account: <name>`) before debugging the route, and re-plan QA around the account that is actually signed in.
- A live demotion (`files_sharing.restrict_node`, then `set_node_share_grant`) has a no-access window between the two mutations. A tab that is open on that node can silently fall back to `?nodeId=root` during the window. Every later `page.reload()` then re-mounts the WRONG file — often `README.md`, whose template content looks exactly like a fresh fixture — and probes read like "the pending draft is not loading" (verified 2026-08-03; it cost a false FAIL verdict). After any demotion, navigate with a full `goto(<fixture URL>)` instead of `reload()`. When a mount looks wrong, verify what the editor is really subscribed to with the dev-only QA hook (installed 2026-08-08): `window.__qa.filesYjs()` lists each live Yjs provider's `nodeId`, sync `status`, and `loadFailed`, and `window.__qa.convexSubscriptions()` lists every active Convex subscription as `{ udfPath, args }` — the `nodeId` in there is the truth, not the URL. (Note the two can legitimately differ: opening a folder keeps the folder id in the URL while the editor below the explorer holds a child document.) The old fallback — importing `/src/lib/app-convex-client.ts` in page context and parsing `app_convex.listeners` keys — is only needed if `__qa` is ever missing.
- Theme QA on `/files`: the editor surfaces are built on the numbered `--color-base-1-*` / `--color-fg-*` scales, which are dark-fixed and NOT swapped by the theme provider. Switching to light theme changes the app chrome but the rich-text editor area still renders dark, so a "light theme" screenshot of the editor looks identical to the dark one. That is the current design, not a broken theme switch — do not spend time debugging it, and do not treat a matching screenshot as the stale-frame hazard above without checking the chrome.
- Theme QA: the app stamps `.light`/`.dark` on `<html>` from a `matchMedia` listener whenever the stored mode (localStorage `ai-chat-theme-mode`) is `system`. `page.emulateMedia({ colorScheme })` therefore makes the app re-stamp the class asynchronously, silently overwriting a manual `classList` flip made in the same runner call. To probe a class+media combination the app would never produce itself (for example `.dark` class with light media), emulate the media first, let the effect settle, then flip the class in a later call. Restore by clearing the emulation (`emulateMedia({ colorScheme: null })`) — the app re-stamps the correct class on its own. Class flips and media emulation are per-tab; localStorage is shared across tabs, so never write the theme key during probes.
- Viewport and sidebar state may persist between sessions through browser storage.
- Main sidebar open/collapsed state is persisted in localStorage keys documented in `app-map.md`.
- Agent `New chat` creates a client-only `ai_thread-*` tab before Convex persists the real thread. If cleanup removes that optimistic tab too early, sends land in an older chat or the tab appears to vanish. If reload restores it, verify the tab still has an optimistic session and the first `/api/chat` request uses `clientGeneratedThreadId`.
- `nodeId=root` is the synthetic root folder, not a stored file node. Its editor renders and accepts a comment, but never use it for a reload-persistence check — a fixture created there cannot be re-resolved after a load. Always create a real file first and assert on its own `nodeId`.
- Before blaming the editor for "my content disappeared", read the app logs for `[CONVEX Q(files_nodes:list_tree)] ... ReturnsValidationError`. A broken returns validator in `files_nodes.ts` empties the tree and makes every reload fall back to `nodeId=root`, which looks exactly like a collaboration/persistence regression but is a backend validator problem.
- The cause side of that error was fixed 2026-07-26 (commit `1b3c46e6`): `list_tree` now spreads `doc(app_convex_schema, "files_nodes").fields`, so new schema fields flow through automatically. The lesson stays: a returns-validation error in any query the route depends on empties the UI or crashes it into `Something went wrong`, `Technical details` renders empty, and tests do not catch it when they never call the query — read the error from `page.on("console")`/`pageerror`, attaching the listeners and then reloading, because logs from before the listeners are gone.
- `convex dev --once` can report `Convex functions ready!` while the deployment still serves the previous validator for a function. Before concluding the client is at fault, dump the deployed contract with `vp env exec pnpm exec convex function-spec` (from `packages/app`) and check the field is in the function you expect; pushing again fixed it in one observed run.
- Renaming a field breaks the next push, not the current one: schema validation rejects existing documents that still carry the old field (`Object contains extra field …`). Clearing them needs a push, and the push is what is blocked. Break the cycle by temporarily widening the schema (`oldField: v.optional(v.any())`) together with a throwaway `internalMutation` that patches the field to `undefined`, push, run it, then revert both and push again.
- Reload-persistence checks used to be unreliable while anonymous auth churned: one run produced four distinct `app::auth::anonymous_token_user_id` values across four page loads, each a fresh empty tenant. Fixed 2026-07-26, see the anonymous-rotation note below. Still prefer client-side view switches (`.MyButtonGroupItem-button` filtered by `Rich`/`Markdown`/`Diff`, or `Code`/`Diff` on a plain-text node) over `goto`, which costs a load every time.
- Multi-file agent setup prompts can overstate success. For corpus generation or bulk QA data, keep batches small and verify persisted file nodes through the app Convex client after each batch.
- Rapid AI chat sends can hit the `/api/chat` rate limiter and produce a recoverable `429` response with `retryAfterMs`. The chat transport waits and retries the same request automatically. Do not send a duplicate prompt while that request is still running.
- The chat stop control is labelled `Stop generating`. Playwriter waits that look for `Stop generation` will miss the running state and can send the next prompt too early, producing avoidable `429` failures or branched transcript confusion.
- Keep AI chat Playwriter scripts short when exercising multiple LLM turns. Long monolithic execute calls can lose the Playwriter relay connection with `fetch failed`; prefer one prompt per execute or a small batch with clear idle waits.
- Rapid files-tree create/move/archive sequences can hit the `files_tree_write` rate limiter. If a create dialog stays open with `Rate limit exceeded`, wait for the retry window, keep the dialog open, and submit the same draft again instead of restarting the flow.
- If using a temporary localhost tab, save `app::auth::anonymous_token` and `app::auth::anonymous_token_user_id` before clearing them to mint a fresh anonymous QA session. Restore both keys before closing the QA tab. Since the 2026-08-09 token split, `app::auth::anonymous_token` holds the long-lived refresh JWT (aud `"anonymous-refresh"`), not a token Convex accepts; the short-lived access token lives only in memory.
- Anonymous QA sessions no longer rotate on reload (fixed 2026-07-26). Validating the stored token is charged to `auth_http_refresh` (capacity 10) instead of the strict `auth_http` bucket, and the client clears storage only when `/api/auth/anonymous` answers `401` or `400`. On a `429`, a `5xx` or a network failure the client keeps the stored refresh token and retries with backoff until the server answers, so the identity survives — but the app stays in its loading state during that retry window instead of rendering with a cached token. Still assert `app::auth::anonymous_token_user_id` after a load when a run depends on tenant identity: a `401` (dev data reset, deleted user row) does still mint a new anonymous user with its own empty `personal`/`home`, and the UI reports nothing.
- For anonymous-vs-signed-in QA, prefer a fresh headless browser over mutating the user's real Edge auth state: run `vp env exec pnpx playwriter browser install` once, then `vp env exec pnpx playwriter session new --browser headless`. The fresh profile mints a new anonymous app user on first load, the user's signed-in tabs stay untouched, and headless pages are foregrounded so screenshots, `waitForSelector`, and layout APIs work. Delete the session when done. **Broken 2026-08-01 while the relay ran in WSL; fixed 2026-08-02 by moving the relay back to Windows (verified: `session new --browser headless` creates a session again).** The failure mode: `session new --browser headless` fails with `No Chrome browser found` even though `browser install` reports Chrome already installed at `C:\Users\rt0\.playwriter\browsers\...` — `browser install` ran on the Windows CLI and installed Chrome under the Windows profile, but a WSL relay looks for Chrome on the WSL filesystem, so it cannot see or launch the Windows Chrome. If this error ever returns, check for a WSL relay first (see the relay-topology entry) instead of reinstalling browsers.
- Clerk sign-up may be blocked in **headless** browsers because its Turnstile challenge does not finish. It is **not** blocked in the user's real Edge through extension mode: four `+clerk_test` accounts were created there by automation on 2026-07-28 and Turnstile never appeared. So do not skip a two-user test on the assumption that no second account can be made — try the real browser first. Do not retrieve Clerk secrets from Convex, browser pages, or logs to bypass any of this.
- Making a throwaway app user, verified 2026-07-28 on the `direct-bass-17` development instance (`pk_test_`, read the prefix from `window.Clerk.publishableKey` — the publishable key is public, unlike the secret key). Any address containing `+clerk_test` skips real email delivery and always accepts the code `424242`. Drive it with `window.Clerk.openSignUp()` / `openSignIn()`, fill `#emailAddress-field` (sign-up) or `#identifier-field` (sign-in), click `Continue` scoped to `.cl-rootBox, .cl-modalContent`, then type the code into `.cl-otpCodeField input`. Sign out with `window.Clerk.signOut()`. One browser holds one signed-in user, so cycle users through a profile rather than expecting two at once. The Convex `users` id is the `external_id` claim of `Clerk.session.getToken({ template: "convex" })`. For signing in as the seeded QA accounts (with the isolated-browser rule and the code-before-send race), read `clerk-test-accounts.md`.
- **`getByRole("button", { name: "Continue" })` in the Clerk modal matches `Continue with Google` first and opens a real Google account chooser listing the machine's actual Google logins.** Nothing about the failure looks like a mis-click — the modal simply becomes a Google page. Always pass `exact: true`. The sign-in modal's controls are, in DOM order: `Close modal`, `Continue with Google`, an unnamed button, `#identifier-field`, then the real `Continue`. If a Google chooser does appear, navigate back to `localhost:5173` and start over; do not click an account.
- The Clerk sign-up **modal UI can stall**: the email field turns disabled, no OTP field appears, and `Clerk.client.signUp.status` stays `null`. When that happens, `page.reload()` first, then drive the Clerk JS API directly — it works where the modal does not. Sign-up: `const su = await window.Clerk.client.signUp.create({ emailAddress })`, `await su.prepareEmailAddressVerification({ strategy: "email_code" })`, `const done = await su.attemptEmailAddressVerification({ code: "424242" })`, `await window.Clerk.setActive({ session: done.createdSessionId })`. Sign-in: `const si = await window.Clerk.client.signIn.create({ identifier })`, find the `email_code` factor in `si.supportedFirstFactors`, `prepareFirstFactor` with its `emailAddressId`, `attemptFirstFactor({ strategy: "email_code", code: "424242" })`, then `setActive`. Only for `+clerk_test` addresses on the dev instance. Verified 2026-08-01.
- Re-signing-in the user's own Google account: `window.Clerk.openSignIn()`, click `Continue with Google` (accessible name is `Sign in with Google Continue with Google`), then click the user's address on the Google account chooser. The chooser reuses the profile's active Google session, so no password is ever typed — if Google asks for a password instead, stop and hand back to the user. The chooser click often reports a Playwright timeout while it **has** landed (the page moves to the Clerk handshake URL); re-read `window.Clerk.user` in a later call before retrying. Verified 2026-08-01.
- `await window.Clerk.signOut()` reloads the page and destroys the execution context, so a runner that calls it and then does anything else dies with an `evalmachine`/`UtilityScript` stack and no useful message. Sign out in its own call, then sign in in the next one. Splitting the identifier step from the OTP step is worth it too: each is one short call that can be observed.
- After a sign-in or sign-up the app needs a few seconds before `Clerk.user` and the Convex identity are both readable; a probe run immediately after the code is entered reports `email: null` and looks like a failure. Read it again instead of retrying the sign-in.
- Close only the localhost tabs created for QA. Leave unrelated user tabs open.
- Do not hand-launch Edge or infer CDP readiness from the presence of `--remote-debugging-port`. When direct CDP is required, load the Edge remote-debugging skill, run its bundled Node script through `vp env exec node`, and verify the process arguments and `/json/version` endpoint.
- On this Windows machine, multi-line code passed to `vp env exec pnpx playwriter -e "..."` is truncated at the first newline — only the first statement runs, and it still reports `Code executed successfully`. Always use `-f <script.js>` for multi-statement code.
- The CLI wait timeout defaults to 10 seconds; it is not a sandbox cap. Pass a suitable `--timeout`. A CLI timeout does not cancel the runner, so verify app state before retrying. Keep interactive calls short, and poll durable state from outside through `convex data` or read-only `convex run` calls.
- In multi-statement scripts, only `console.log(...)` output is printed; a bare trailing expression is not echoed (single-expression `-e` calls do echo their value as `[return value]`). A `console.log` after an in-call navigation can also be lost — split navigation and observation into separate calls.
- A long-running `page.evaluate(...)` parked on `state` (the "start work, read it later" pattern above) dies with `Execution context was destroyed, most likely because of a navigation` whenever the app reloads mid-run — an HMR full reload or the route's own navigation is enough, and on this app that happens often. The whole run is lost, including work it already did. Keep page-side async work to a few seconds. When the work is a series of HTTP calls rather than DOM interaction, run it from the **sandbox** instead: read the auth token and any ids out of the page in one short call, park them on `state`, then `fetch(...)` from the runner itself. Sandbox `fetch` works and no navigation can kill it. Verified 2026-08-02 against `/api/chat`.
- Two Playwright accessibility APIs are unavailable through the relay: `context.newCDPSession(page)` fails with `Target.attachToBrowserTarget: No tab found`, and `page.accessibility` is `undefined`. To settle what name assistive tech actually receives, count locators instead: `await page.getByRole("searchbox", { name: "Search" }).count()`. Playwright resolves the accessible name by the accname spec, so a wrapping `<label>` or `aria-labelledby` is honoured — which a hand-rolled DOM check reading only `aria-label`/`title`/`textContent` is not. Such a check reports every correctly labelled text input as unnamed. Verified 2026-08-06.
- When the app under test is a **built bundle** served by a local server rather than a dev server, a plain `page.goto`/`reload` can keep running the previous build: the browser serves `index.html` from its own cache, and that document still points at the old hashed asset. The server is fine — `curl` shows the new hash while the tab shows the old one. Prove which build the tab is running before trusting any result: `await page.evaluate(() => [...document.querySelectorAll("script")].map((s) => s.src))`, and compare it against the hash the build printed. A cache-busting query (`/?cb=<random>#/route`) reliably forces the new document. Verified 2026-08-06.
- **`page.addInitScript` is effectively permanent — treat it as a last resort on the user's own tab.** It is the only way to observe the first frames after a reload (mount-order races, loading flicker), but nothing removes it afterwards: `session delete`, `resetPlaywright()`, and CDP `Page.removeScriptToEvaluateOnNewDocument` from a fresh `getCDPSession` all leave it installed, because the relay keeps its own Playwright/CDP attachment to that tab. Verified 2026-07-26. The only clean removal is to replace the tab: `context.newPage()`, `goto` the same URL, confirm your marker global is `undefined` there, then `old.close()`. A fresh page does not inherit a page-level init script. Keep the script cheap and self-terminating (clear its own timers) in case cleanup fails, and always verify removal instead of assuming it.
- In extension mode, a later `page.addInitScript` on an otherwise working owned tab can fail with `Page.addScriptToEvaluateOnNewDocument: No tab found` and the CLI can then print a libuv assertion. The tab, relay, and session may still be healthy. Check `session list` and the page URL before recovery. For the current document, use `page.evaluate` with buffered performance entries. When first-navigation instrumentation is required, replace the owned tab and install the one needed init script before navigating. Do not retry this on the user's tab because init scripts remain attached as described above. Observed 2026-08-11 with Playwriter 0.4.0.

## A stale dev server silently disables the React Compiler

Observed 2026-07-26: every route rendered `Something went wrong`, with `Too many re-renders` thrown from `MainAppHeaderOrganizationControls` — a component nobody had touched in 100 commits. The cause was not the component. The running Vite dev server was serving **uncompiled** modules: the React Compiler was applied to nothing under `src/`.

- This repo relies on compiler memoization for correctness, not just speed. `AGENTS.md > Memoization` forbids `useMemo`/`useCallback` for identity stabilization because the compiler supplies it. So when the compiler stops, most components only get slower, but any component whose contract needs a stable identity breaks outright.
- The one that breaks first is `main-app-header.tsx`: it passes an inline `Object.fromEntries(...)` to Convex `useQueries`, which memoizes its subscription on `[observer, queries]`, and Convex's `useSubscription` runs a render-phase `setState` whenever that identity changes. New object every render → `setState` every render → render loop.
- Check whether the compiler is live by reading a module straight off the dev server: `curl -s localhost:5173/src/components/my-button.tsx | grep -c '_c('`. Greater than zero means compiled. Zero, plus no `react/compiler-runtime` import and no memoization comments (`enableMemoizationComments: true` is set in `vite.config.ts`), means it is not running.
- The fix is restarting the dev server; touching `vite.config.ts` forces it. No source change. Root cause of the staleness was not identified — a poisoned transform cache from the Vite 8 upgrade is the suspect, on timing alone.
- Do not "fix" the render loop by adding `useMemo` to the component. That contradicts the repo guideline and hides a dead compiler that is also silently costing every other component its memoization.
- The same loop can also be a source-level bug while the compiler is fully live: the compiler memoizes arguments flowing into hook calls in some shapes but not others. Observed 2026-08-03 after a cleanup removed the `useMemo` wrappers around the `useQueries` arguments in `files-sidebar.tsx` and `file-node-view.tsx` — the served output had cache slots on neighboring values but none on the queries objects, and every `/files` load crashed with the same `Too many re-renders`. Tell the two cases apart with the probe above: `_c(` slots present but the suspect hook argument unmemoized means a source bug (restore the `useMemo` with a comment, like `app-notifications.tsx` does), zero slots means a dead compiler (restart the dev server).

## A backtick inside the room's CSS wedges the whole local Worker, for every agent using it

`ROOM_CSS` in `packages/council-service/src/room/page.ts` is a JS template literal, so a backtick anywhere inside it — **including inside a CSS comment** — closes the string early and turns the rest of the stylesheet into JavaScript. Observed 2026-08-22: writing `` `aspect-ratio: 1` `` in a CSS comment stopped `127.0.0.1:8787` answering **any** request. The port stays `LISTENING` and connections sit in `CLOSE_WAIT`, so the symptom reads as a dead or hung Worker, not as a syntax error, and the instinct is to restart a server that is fine.

- Name it instantly with the typecheck instead of guessing: `vp env exec pnpm --dir packages/council-service typecheck` prints `page.ts(979,6): error TS1005`.
- This is shared blast radius. One agent's unbalanced backtick takes the Worker away from every other agent driving the room, and it also aborts unrelated test suites that import the module — six at once in the observed case. If the Worker goes silent while you did not touch `page.ts`, check whether someone else is mid-edit before restarting anything.
- Write CSS comments in that literal without backticks. Quote a property name as `aspect-ratio: 1` in plain words, not in code ticks.

## A dev server on the usual port can serve a completely different checkout

**Run this check before your first assertion, not after your first surprise.** Two reviewers on
2026-08-22 read this entry only once the page had already contradicted the source. One lost a full pass
of browser evidence; the other reported a defect measured against a two-commit-old tree. The check
below costs one call. Make it the first thing a browser run does, and name the server you used when you
report evidence.

The pull toward the wrong port is structural, not carelessness: repo `CLAUDE.md` documents
`http://localhost:5173/` as *the* dev address, so an agent told nothing else goes there by default. If
your task brief names a different port, the brief wins.

Observed 2026-08-22: `localhost:5173` was a healthy Vite dev server — react-refresh live, `/@vite/client` served, every route rendering — and it was rooted at **another copy of the repo**, at `t3-chat-+personal/+ai/council-production-room-2026-08-22/final-maintenance/packages/app/`. An agent verifying a frontend edit there saw its change missing from the DOM and had no reason to suspect the server rather than the edit.

- This is the frontend twin of the `convex dev` rule in `AGENTS.md`. That rule says a browser result about `convex/` code means nothing unless `convex dev` is pushing your tree. The same is true of `src/`: a dev server you did not start is not necessarily serving the checkout you are editing.
- Check it in one call. The path in `_jsxFileName` is the real Vite root:

```bash
curl -s 'http://localhost:5173/src/main.tsx' | grep -o '_jsxFileName = "[^"]*"'
```

- A second checkout is a normal thing to find on this machine — a release or maintenance copy under `+ai/` is a working pattern, not a mistake. Do not delete it, do not restart the server, and do not assume it is stale. Just prove which root you are looking at before trusting a browser result, and say which server you used when you report evidence.
- Combine this with the React Compiler probe above. `grep -c '_c('` tells you whether the compiler is live; `_jsxFileName` tells you whose files it compiled. A run can pass the first check and fail the second.

## The Playwriter CLI's default `--timeout` is 10 s, and it kills a runner mid-wait

Any runner that waits on a real product deadline needs `--timeout` sized above that deadline — the Council room's join timeout alone is 30 s, so a runner watching it needs `--timeout 180000` or more. The default kill looks like a hung script rather than a timeout, so the usual reaction is to rewrite a runner that was correct. Note this is the opposite of the guidance in `collab-yjs-comments-regression.md`, which caps the timeout at 5 s on purpose: there, a step that cannot finish in 5 s really is a broken script. Size the timeout to what the step legitimately waits for.

The failure prints `Code execution timed out` and nothing else, which reads as a hung page rather than as the CLI killing your script. Even a plain room script that navigates, fills the guest form, submits, and waits for the answer runs past 10 s, so `--timeout 90000` is the floor there, not an unusual precaution.

PowerShell has no heredoc, so a multi-line `-e` script is not viable on this machine. Write the runner to a file and pass `-f "<absolute path>"`.

Both `-e` failures reported on 2026-08-22 — a `//` comment "anywhere" breaking the run, and an
invocation that swallowed every `console.log` and reported `Code executed successfully (no output)` —
turned out to be one cause, measured on 2026-08-23: **`vp env exec` keeps only the first line of the
`-e` argument.** See the first-line bullet under Playwriter Availability for the four measurements. A
trailing `//` comment on a genuinely single-line `-e` is fine; a `//` on the first line of a
multi-line one is not. If a probe reports no output, suspect the invocation before you believe the
result.

## Vite Plus eats a `--flag` meant for the wrapped command

`vp env exec pnpx playwriter --help` prints **Vite Plus's** help, not Playwriter's: `vp` parses the flag as its own before it hands the rest over, and there is no error to notice. The same swallows any leading `--flag` you meant for the wrapped tool. Put `--` after `exec` so `vp` stops parsing:

```bash
vp env exec -- pnpx playwriter --help
```

A flag that comes after a subcommand (`vp env exec pnpx playwriter -s $session -e '…'`) is not affected, because `vp` stops at the first non-flag word. Only a flag in the leading position is taken. Verified 2026-08-22.

## The local Worker cannot answer the guest form until the request carries a client IP

`handle_guest_session` (`packages/council-service/src/routes-room.ts`) reads `CF-Connecting-IP` **before** it reads the body, and answers `400 Missing client address` when the header is absent. Cloudflare's edge sets that header in production; `wrangler dev` does not. So on the local Worker the guest form looks broken — submit answers 400 with a message about an address the form never asked for.

The workaround that keeps the production code path is a route handler that adds the header:

```js
await page.route("**/room/api/**", (route) =>
	route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": "198.51.100.61" } }),
);
```

Prefer this over the escape hatch, because it also lets you choose the rate-limit key. The guest bucket is **50 attempts per 10 minutes per IP** (`council_RATE_LIMITS.guest_join_ip` in `packages/council-service/src/db.ts:144`). That number has been raised before, so read the constant rather than trusting this line. A second run from the same address starts partly spent, so varying the last octet keeps runs apart. It does not buy a clean slate, though: `guest_join_code` (in `council_RATE_LIMITS`, also 50 per 10 minutes) is keyed on the hash of the code you present, so every run against the same meeting spends the same bucket whatever address it comes from. `COUNCIL_ALLOW_MISSING_CLIENT_IP=true` also exists and makes the Worker use the literal key `loopback`, but then every run shares one bucket and the header path is never exercised.

## A Vite preview can bind IPv6 only, so the `127.0.0.1` literal looks like a dead server

The Council plugin preview (`vite --port 5199 --strictPort`) answers `http://localhost:5199/` and `http://[::1]:5199/` with `200` but **refuses** `http://127.0.0.1:5199/` — curl exits `7` with no status. Vite binds the `localhost` host name, and on this machine that resolves to `::1` only, so the IPv4 literal reaches nothing. An agent that hardcodes `127.0.0.1` concludes the server is down and restarts a server the user is already using. Always probe the `localhost` name, and try `[::1]` before deciding a preview is dead. Verified 2026-08-22. Note that this is per server: the Council Worker's `wrangler dev` binds `127.0.0.1:8787` instead.

## Grep output can misrender comment lines

Grep/`rg` tool output can render a source line's leading `//` as `\ `. It looks like a stray backslash at line start — a syntax error the dev server would never accept. It is a rendering artifact, not file content: open the file at that line before diagnosing (observed 2026-08-03 on comment lines in `files_pending_updates.ts` and `file-editor-diff.tsx`; both files were clean on disk).

## Driving the public HTTP API (`/api/v1/…`) from a QA session

- Do **not** use `state.page.request` (Playwright's `APIRequestContext`). Through the Playwriter CDP relay it dies immediately with `Protocol error (Storage.getCookies): No tab found for method Storage.getCookies`, and the CLI prints a long hono stack that looks like a relay crash. Send the request from page context instead: `state.page.evaluate(async ({ origin, key, body }) => { const res = await fetch(...); return res.status + " " + await res.text(); }, {...})`. The Convex site origin allows `http://localhost:5173` through the app's CORS router, so this works for every `/api/v1/…` route. Verified 2026-08-15.
- A Convex HTTP action that **throws** answers 500 without CORS headers, so a page-context `fetch` reports `TypeError: Failed to fetch` and you cannot see the status or the message. That is not a network problem and not a broken key. Read the real error with `vp env exec pnpm --dir packages/app exec convex logs --history 12` — it prints `Uncaught Error: …` with the source line. This is also the fastest break-on-purpose signal for a route: a working refusal answers a JSON status, an unhandled defect answers `Failed to fetch`.
- An API key is `pk_<32 hex>.<64 hex>` — **it contains a dot**. A capture regex like `/pk_[A-Za-z0-9_\-]+/` silently grabs only the key id, and every call then answers `401 Unauthenticated`, which reads like a scope or permission bug. Match `/pk_[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/` and sanity-check the length (100). Keep the secret in `state`, pass it into `page.evaluate` as an argument, and print only its length — never the value, and mask `pk_[\w.\-]+` before printing any page text.
- The **Bash tool on this machine has no outbound network**: `curl` exits 43 and reports HTTP `000` for every host, which reads exactly like a dead server or a blocked route. Send the request from PowerShell instead, and use `-SkipHttpErrorCheck` so a 4xx comes back as a value rather than a throw: `$r = Invoke-WebRequest -UseBasicParsing -SkipHttpErrorCheck -Method POST -Uri "$origin/api/v1/auth/verify" -Headers @{ Authorization = "Bearer $key" }; $r.StatusCode; $r.Content`. Do not reach for `$_.Exception.Response.GetResponseStream()` on failure — PowerShell 7 hands back an `HttpResponseMessage`, which has no such method, and the recovery attempt fails with a second, unrelated error. Hit 2026-08-24.
- The reveal dialog after `Create API key` stays mounted with its `MyModalBackdrop`, which intercepts pointer events on the key list underneath, so the next click fails with `<div class="MyModalBackdrop"> … intercepts pointer events`. That backdrop is also the signal the secret is **still on screen**: if a capture regex missed it, re-read it from the open dialog instead of rotating the key.

## A `route` handler that just returns does not hold the request open

Playwright treats a `page.route` handler that ends without calling `route.fulfill`, `route.abort`, `route.continue`, or `route.fallback` as "not handled": the request falls through to the next handler, or to the real server. So a handler written to model "no answer ever arrives" quietly becomes "the real server answered", and the check passes for the wrong reason while proving nothing about the stalled state. To really hold a request open, never resolve the handler: `await page.route(url, async () => { await new Promise(() => {}); })`. Verified 2026-08-22 while modelling a stalled `POST /room/api/host/close`.

## R2 Upload Observability

- Browser R2 uploads can record both a `200` response and a `requestfailed` entry with `net::ERR_ABORTED` for the same signed `PUT`. Treat durable Convex state and generated file visibility as the source of truth when the `200` completed and conversion finalized.
- For generated PDF output QA, capture Cloudflare request metadata by filtering network entries whose origin contains `cloudflarestorage`; record method, origin, pathname, response status, and failure text without logging signed query strings.
- Conversion can finish quickly. To verify the pending generated output screen, poll for `<source>.pdf.md` every ~100ms immediately after upload and click it as soon as it appears. If content finalizes before the click, record that the pending state was too fast to observe and rely on backend tests for that state.

## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect `.MainAppSidebar` and `.MySidebar-state-closed` together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.

## Clicking the rich-text editor on a long document

`locator.click()` on `.FileEditorRichText-editor-content .ProseMirror` can burn the whole CLI timeout on a long document: the element is thousands of pixels tall, and Playwright's scroll-into-view plus actionability check on it stalls. To focus the editor, `mouse.click(x, y)` on a visible point inside the document column instead (compute the point from `.FileNodeView-editor-area` and the agent panel rects). Verified 2026-08-02. Related: the chat thread's auto-scroll can revert `scrollIntoView()` on a message element right after it runs — set `thread.scrollTop` directly and re-read the rect before hovering.

## Node's stack limit is not the Convex runtime's

A fixture sized to blow the JS stack in a unit test can parse fine in a deployed Convex function.
Measured 2026-08-18 with flow-style YAML frontmatter (`a: {b: {b: …`): Node throws
`RangeError: Maximum call stack size exceeded` at about 1000 nesting levels, and so does
convex-test, because it runs on Node. The real deployment read 1000 levels without complaining and
only threw somewhere before 5000. The upload published with `contentFrontmatterTooLargeFieldCount:
1001`, which looks like a passing check but proves the opposite of what the run was meant to prove.

So when a browser check needs a deployed function to hit a recursion limit, escalate the depth
against the deployment and read the durable state, instead of reusing the depth that failed in the
test. Reading `convex data files_nodes` for the marker fields separated the two outcomes here; the
`convex logs` warning line named the exact code path.

## A modal popover is the wrong home for hoisted Monaco widgets

`MyModalPopover` is an Ariakit dialog with `modal` and `portal`, and it sets `contain: content`. Two
things follow, and both bite a Monaco editor placed inside it.

The app-wide `#app_monaco_hoisting_container` is outside the dialog, so Ariakit marks it inert and
aria-hidden while the dialog is open. Widgets hoisted there paint behind the dialog and refuse the
keyboard. Moving the container inside the dialog does not fix it either: `contain: paint` makes the
popover the containing block for `position: fixed`, and `fixedOverflowWidgets` writes viewport
coordinates, so the widget lands at the wrong place by the popover's own offset.

So an editor inside a modal hoists nothing. `files-properties-modal.tsx` omits both
`overflowWidgetsDomNode` and `fixedOverflowWidgets` on purpose, and its suggest and hover widgets
clip at the editor box. Do not "fix" a clipped widget there by pointing it at the app container.
Verified by reading the layering 2026-08-18; the file editors outside modals still hoist normally.

## chatgpt.com composer: the image-mode selectors in the skill are stale

Hit 2026-08-18 while driving the `chatgpt-image-generator` skill. Three of its documented signals no
longer exist, and the guard built on them blocks sends that would have worked:

- The plus-menu entries carry **no ARIA role at all**, so `getByRole('menuitemradio', { name: 'Create image' })`
  matches nothing. Use `page.locator("div.__menu-item").filter({ hasText: "Create image" }).first()`.
  There is no `[role=menu]` either — probe `[data-testid=composer-plus-btn]`'s `aria-expanded` to
  tell whether the menu opened.
- Image mode shows as **text inside the contenteditable**, at the very end, not as a composer chip
  button. Check `/Create image/.test(contenteditable.innerText)`. The skill's three confirmations
  (chip button, `Describe or edit an image` placeholder, aspect-ratio control) all read as absent
  while image mode is genuinely on.
- `fill()` wipes that inline chip. Fill the prompt **first**, then open the plus menu and pick
  `Create image`, which appends the chip at the end.
- There is no aspect-ratio control any more. Ask for the ratio in the prompt text; a 16:9 request
  came back as 1672x941.
- `snapshot()` first is expensive there: the conversation sidebar floods any button enumeration with
  dozens of `Pin <conversation>` entries. Scope probes to `document.querySelector("form")`.

## `download.saveAs()` fails in extension mode even under a Windows relay

Extends the download entry above. `saveAs` throws `ENOENT … copyfile 'C:\…\Temp\playwright-artifacts-…\<uuid>' -> <dest>`,
and writing into `os.tmpdir()` first does not help, because the missing file is the *source*
artifact, not the destination. The download itself does succeed and lands in `C:\Users\rt0\Downloads\<suggestedFilename>`
(verified byte-exact against `blob.size` twice, 2026-08-18). The reliable recipe is a page-context
Blob download followed by `Move-Item` from `~/Downloads`.

## Harness helpers follow `bindOpenTab`, not a hand-assigned `state.page`

A runner that picks its own tab with `state.page = context.pages().find(...)` drives Playwright
fine, but every `state.appPlaywriterHarness.*` helper still targets whatever tab was bound last.
`auditAccessibility` then fails with `page.waitForSelector: Timeout 15000ms exceeded` on a selector
that is plainly on screen — and it fails the same way on `.FilesSidebar`, so the message points at
the selector while the real cause is the binding. Hit 2026-08-18.

Worse: the timeout is the *loud* version. `install-harness.js` seeds its pinned page from the
global `page` when `state.page` does not exist yet, so installing the harness before you open your
tab pins whatever unrelated app the shared browser already had open. Every helper then answers about
that tab without failing — `auditAccessibility` returns a clean report for another product and
`latestLogs` returns `[]`, which reads as "no console errors on my route". Hit 2026-08-20, where an
audit of the files route came back describing `personal-market-radar` widgets. Hit again
2026-08-23: a session that never called `bindOpenTab` ran `auditAccessibility(...)` with its page
held only in its own `state`, and the report silently described a peer agent's dashboard-preview
tab on `localhost:5199` — a surface from this same repo, so nothing about the numbers looked wrong.

Call `await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: "/files" })` first; it sets
`state.page` too, so the hand assignment is not needed. The audit also tells you which tab it
answered about: its report carries a `url` field for exactly this, so reading that field before
believing the report is the check — the peer-tab and `about:blank` entries below rely on the same
field. When a helper times out on a selector you
can see in a screenshot, re-probe it against a selector that certainly exists (`.FilesSidebar`)
before editing the selector — a helper that fails on both is not a selector problem.

## `bindOpenTab` can bind you to another agent's tab

Several agents often drive the same origin at the same time in this repo. `urlIncludes` matches the
first tab whose URL contains the string, and it does not know which tab is yours. Binding on the
route alone therefore lands on whichever agent got there first. Hit 2026-08-23: a bind on
`"8787/room"` matched a peer fixer's room tab, and the audit that followed described that agent's
half-finished experiment.

This one does not announce itself. The bind succeeds, the helper answers, and the numbers look real
— they are simply about someone else's work. It is worse than binding to an unrelated app, because
an unrelated product looks obviously wrong while a peer's tab shows the same route you expected.

So bind on something that identifies **your** tab, not the route: a query parameter you chose
yourself (`urlIncludes: "m=probe"`), or the page object you opened. Read the `url` field that
`auditAccessibility` returns before you believe its report, and treat any finding taken from a tab
you did not open as an observation to confirm on a clean page — never as a defect. If it does turn
out to be real, route it to the agent that owns that surface instead of filing it yourself.

## `getLatestLogs({ page })` returns console errors from other tabs, not only yours

Passing `page` does not scope the buffer to that page. The browser is shared, so the lines you read
back can belong to any tab open in it — and this repo leaves a lot of them open. Hit 2026-08-22: a
freshly created Council room page had **all-200 responses**, proved with a `page.on("response")`
listener on that page, while the log buffer for the same call showed `401`, `502`, `503` and
`ERR_FAILED` lines. They came from roughly 45 leftover sessions still holding room tabs against
`127.0.0.1:8787`. Such a tab is not idle: one left inside a call polls meeting state every 10 s
(`startPolling` in `room/client.ts`, stopped only by `teardownCall`), so it keeps generating traffic
and failures by itself long after the run that opened it ended.

This reads exactly like a broken route mock, and it sent a reviewer hunting for a fixture bug that did
not exist. Before you believe any status you saw in the log buffer, confirm it on your own page:

```js
state.seen = [];
state.page.on("response", (r) => state.seen.push([r.status(), r.url()]));
```

The failure direction is the dangerous one — it invents problems rather than hiding them, so the cost
is a whole run spent debugging someone else's tab. The reverse case, a helper pinned to the wrong tab
answering `[]`, is the section above. Closing your own stale tabs at the end of a run is what keeps
this from growing.

## `path.resolve` in a runner resolves against the relay's repo, not yours

The relay process is shared across repositories, and whichever one started it owns its working
directory. A runner that builds a fixture path with `path.resolve(".agents/skills/...")` then points
at the *other* repo — hit 2026-08-18 as
`ENOENT … 'C:\Users\rt0\Documents\workspace\rt0\personal-market-radar\.agents\skills\…'` while
running from `t3-chat`. Write fixture paths as absolute literals. This is the same relay-ownership
root cause as the WSL entry above, in a form that survives a Windows-only relay, so `session list`
showing a clean Windows CWD does not rule it out.

## Turning a CSS declaration off in the live page only proves anything if the content still fits

Toggling `element.style.*` inside `page.evaluate` is the fastest way to find which declaration
actually fixes a layout, but the content you measure with decides the answer. Hit 2026-08-18 on the
file Properties dialog: the probe replaced the checkbox description with a long sentence so it would
wrap, then reported that removing `justify-content`, `flex: 1` and `width: 100%` all changed nothing.
That was true and useless — a text block wider than the row clamps to the row in every variant, so
free space on the line is zero and there is nothing left for the alignment properties to do.

Measure alignment with the content the user really sees, and only swap in longer text for the
wrapping question. Re-run with the short string and the same probe separated the three declarations
immediately: `width: 100%` was dead, `justify-content: start` was redundant, and `flex: 1` on the
text was the whole fix. Toggle one declaration at a time and include an all-off variant — if the
all-off variant does not reproduce the original bug, the probe is not measuring the bug.

## A half-scrolled item inside a scroll container is reported as a blocked hit target

`auditAccessibility` hit-tests an element at five points — its centre and its four inset corners.
When a scroll container has scrolled an item half out of view, those points land below the container,
and whatever is painted there — usually the next pinned control — is reported as the blocker. Hit
2026-08-20 in a 550px-tall window: the last main-nav plugin link came back "blocked by Theme", which
reads like a click-through bug.

The out-of-window skip does not save you here. These points are still inside the window; it is the
scroll container, not the viewport, that clipped the item, so a real element answers at each one.

Before reporting one, walk the element's ancestors and compare its rect with the nearest
`overflow-y: auto` ancestor's rect. When the item extends past the scroll area's bottom, it is clipped,
not covered, and the finding is noise. A real overlap has the blocker inside or above the same
container.

## Playwriter's own toolbar covers the top-right header controls

Playwriter injects `<div data-playwriter-toolbar="1">` as a direct child of `<html>`, fixed at the
top right with `z-index: 2147483647`. It sits over the header buttons in that corner. On the files
route, `auditAccessibility` then lists "Search file contents" and "Notifications" in
`blockedHitTargets` with an unnamed `div` as the blocker, and a real `click()` on them fails with
"<div data-playwriter-toolbar="1"> intercepts pointer events". Hit 2026-08-21 at a 1432px viewport.

The blocker is the tool, not the app. Its `name` is empty and its parent is `html`, so any blocked
finding whose blocker is an unnamed element outside `body` is noise. To confirm, hide it, re-run the
audit, and put it back:

```js
await state.page.evaluate(() => { document.querySelector("[data-playwriter-toolbar]").style.display = "none"; });
const report = await state.appPlaywriterHarness.auditAccessibility({});
await state.page.evaluate(() => { document.querySelector("[data-playwriter-toolbar]").style.display = ""; });
```

The toolbar's own "Close Playwriter toolbar" button is not clickable through Playwright: it lives in
the same overlay, so `getByRole` waits forever. Hide it from the page instead.

## `auditAccessibility` returns `blockedHitTargets`, and a summary script reading another name reports "none"

The result keys are `unlabeled`, `blockedHitTargets`, `smallTargets` and `negativeTabIndex`. A
wrapper that reads `audit.blocked` or `audit.blockedTargets` gets `undefined`, and a
`?? []` fallback next to it then prints an empty list. The run looks clean and nothing warns you,
because reading a key that does not exist is not an error in JavaScript. Hit 2026-08-19: a summary
runner reported "no blocked hit targets" for the file Properties dialog while the raw result held
one entry.

Return the raw audit object, or read the four names above exactly. Also expect two benign entries on
any dialog holding a Monaco editor: Monaco's `div.native-edit-context` appears in `smallTargets` and
in `blockedHitTargets`, covered by its own `div.view-line`. A `MyCheckboxButton` adds a third, its
1px `input.MyCheckboxButton-control`, whose `<label>` is the real click target.

## Disabling a focused control mid-action throws keyboard focus to `<body>`

A control that disables itself while its own async work runs looks correct and tests green, but the
browser blurs a focused element the moment it becomes disabled, and nothing restores focus when it
is re-enabled. In a modal that is a focus-trap escape: the next Tab restarts from the top of the
document. Found 2026-08-19 on the read-only checkbox in the file Properties dialog, on the happy
path, not only on a refusal.

jsdom does not reproduce the blur, so a unit test asserting focus passes while the real app fails.
Catch it in the browser by recording the trail rather than sampling the end state — add `focusin` /
`focusout` listeners plus a `MutationObserver` on the control's `disabled` attribute, then read them
after the action:

```
focusout input.MyCheckboxButton-control
checkbox disabled=true  active=body   ← the write disables it
checkbox disabled=false active=body   ← re-enabled, focus never returns
```

The fix is the pattern the repo already uses for a blocked Save: keep the element focusable, report
the transient state with `aria-busy`, and let the click handler ignore the repeat press. Reserve the
real `disabled` property for static reasons that are already true before the control can be focused.

**Headless Chromium gets this timing wrong too, in the opposite direction, so it produces false
findings.** jsdom misses the blur entirely (above), but headless does something worse: it reports
the blur late. Measured 2026-08-22, disabling a focused button in headless left `document.activeElement`
on that button until the *second* `requestAnimationFrame`, while the user's real Edge blurred it
**synchronously** (`["focus","leave-button"],["sync","BODY"]`). A reviewer used the headless result to
conclude that an `activeElement === document.body` guard was unreachable and the comment beside it
was factually wrong — a P2 report that was about to be filed against correct code. The headless
result was an artifact of an unfocused window.

So: never write down a finding about focus loss, `activeElement === body` guards, or
`:focus-visible` from a headless measurement. Confirm it in the attached browser first. Headless is
fine for finding the flow; it is not evidence about focus.

**This warning was not enough, and it is worth knowing why.** On 2026-08-23, one day after the entry
above was written, a reviewer measured this in headless anyway, filed the same P2 against the same
kind of guard, and the fix shipped — with the false claim copied into a comment in
`room/client.ts` and into a test comment. Re-measured in attached Edge on the live Worker
(`council-room-r22`, `document.hasFocus()` true), the trail is
`sync: BODY, focusoutFired=true` — synchronous, exactly as this entry says.

The reason it survived review is the part to remember: **the unit test agreed with headless.**
happy-dom does not blur on disable either, so after the control disables, the test still reports the
button, the body-only guard finds nothing, and adding a `disabled` check makes the test pass. Red
before the fix, green after — the whole ritual ran perfectly. Two checks confirmed each other and
both were wrong in the same direction, because both model the same missing browser behaviour.

A green test proves the code matches the model the test encodes. It never proves the model matches
the browser. When the subject is focus, the model is happy-dom or headless, and neither is a
browser. Breaking the fix on purpose does not rescue you here — it only shows the test notices the
change, not that the scenario exists. **Measure focus in the attached browser first, then write the
test to match what you measured**, and say in the comment which browser produced the number.

## A page that patches `window.fetch` answers your own network probe

The Council plugin preview replaces `window.fetch` with a mock router. A
`page.evaluate(() => fetch("/some/path"))` probe meant to ask "is the dev server up?" is then answered
by the page's own stub, not by the network. Found 2026-08-22: a probe came back `404` from the plugin's
mock while the server was serving normally.

Any page under test may do this. Do not ask the page whether a server is reachable. Ask from outside
the page — `page.request.get(url)` uses Playwright's own network stack and ignores the page's patched
`fetch` — or check the server from the shell.

## `featurePolicy.allowsFeature` must be read from inside the frame you are asking about

Reading `document.featurePolicy.allowsFeature("clipboard-write", childOrigin)` from the **parent** page
returns the parent's own policy for that origin, not the `allow` delegation the parent gave that
`<iframe>`. It answered `false` both with and without `allow="clipboard-write"` on the frame, which
looks like proof the grant does not work.

Read it from inside the child instead. There the answer is exact, and
`document.featurePolicy.getAllowlistForFeature("clipboard-write")` shows the delegated origin:

| frame | `allowsFeature` inside the child | allowlist |
| --- | --- | --- |
| with `allow="clipboard-write"` | `true` | `["http://localhost:5199"]` |
| without `allow` | `false` | `[]` |

You do not need the real host app to test this. `http://localhost:<port>` and `http://[::1]:<port>` are
the same server on two different origins, so any local page can embed another cross-origin with the
host's exact `sandbox` list. Verified 2026-08-22 against the plugin frame's
`sandbox="allow-scripts allow-same-origin allow-forms"`.

## `navigator.clipboard.writeText` from `page.evaluate` always fails, but a real click works

`page.evaluate(() => navigator.clipboard.writeText("x"))` rejects with `NotAllowedError` whether or not
the frame holds `clipboard-write`, because an evaluate call carries no transient user activation. A
Playwright `locator.click()` on a button whose handler calls `writeText` does grant activation, and
then the permissions policy is what decides.

So a bare evaluate cannot distinguish "the policy denies this" from "there was no gesture", and the
blanket advice to avoid `navigator.clipboard.writeText` in a QA session is wrong for the click case.
Drive the app's own button and read the status the app renders. Verified 2026-08-22 on the Council
plugin's Copy control.

## `auditAccessibility` on `about:blank` looks exactly like a clean audit

`install-harness.js` builds the object its installer returns (the one carrying `auditAccessibility`)
with the `page: … || state.page || page` fallback chain evaluated **once, at install time**. A page
you create afterwards with `context.newPage()` is never picked up, so the helpers keep pointing at
whatever page existed when you installed them.

The failure is silent and reads as a pass:

```
{ url: "about:blank", controlCount: 0, unlabeled: [], blockedHitTargets: [], smallTargets: [] }
```

Empty finding lists with a zero control count is not a clean surface, it is the wrong page. Always read
`url` and `controlCount` before believing an audit, and sanity-check the count against the number of
controls you can see. Install the harness after the page you mean to drive exists, or re-install once it
does. The real fix at the source is to make that field a getter, or read `state.page` at call time.
Found 2026-08-22; it cost one silently-wrong audit.

## `locator("#id[hidden]").waitFor()` can never resolve

`waitFor` defaults to `state: "visible"`, so waiting on a selector that matches only while the element
is hidden burns the whole timeout and then throws, logging lines like
`N x locator resolved to hidden <div hidden …>` on the way.

Wait on the property instead:

```js
await page.waitForFunction(() => document.getElementById("host-confirm").hidden === true);
```

Or pass `waitFor({ state: "hidden" })` on a selector that matches the element in both states.

## A screenshot's pixels are not CSS pixels, so geometry read off the image is scaled

A saved screenshot can come back at a different scale than the viewport you set. If you then measure
something in an image editor, or compute a ratio from the image's width, every number is off by that
scale and the error is invisible: the picture looks right, and the arithmetic is self-consistent.

Ask the page what its own width is and compare:

```js
const cssWidth = await page.evaluate(() => window.innerWidth);
// Divide the image's pixel width by this to learn the real scale before trusting any measurement.
```

Prefer measuring in the page with `getBoundingClientRect()` and `elementFromPoint`, and keep the
screenshot as the thing a person looks at rather than the thing you measure. A blocked-control list
read from the live DOM cannot drift out of scale; a pixel counted on an image can.

## A backgrounded tab can screenshot stale or blank, so bring it to front first

A tab that is not the frontmost one may not composite new frames. `Page.captureScreenshot` against it
can return the last painted frame or an empty one, so a shot taken right after a viewport change or a
state change shows the state *before* it — which reads as "the fix did nothing".

Call `bringToFront()` on the page before capturing, and re-check that the content you expect is in the
DOM at capture time rather than trusting the image alone. This matters most in a sweep across several
viewports, where every shot after the first is taken on a page nothing has touched in the foreground.

**Fronting the tab is not always enough on the extension transport.** Measured 2026-08-22:
`Page.captureScreenshot` / `page.screenshot` through the extension bridge timed out on a fronted tab
(`Extension request timeout after 30000ms: forwardCDPCommand`), and on the attempts that did return,
the sampled pixels were internally inconsistent with the element box measured in the same page.

So do not try to prove a colour claim with a screenshot on that transport. Read `getComputedStyle`
values out of the page and do the compositing arithmetic yourself — that is reproducible and a
reviewer can check it. Keep screenshots for the things a person looks at. Two arithmetic traps when
you do: the sRGB divisor is **1.055, not 2.055**, and a contrast ratio must be computed against the
**composited** background, not against the translucent layer's own colour. A reviewer this round
reported a wrong ratio by compositing text over an already-composited background; redoing it
correctly reproduced the source comment exactly.

Group `opacity` is a third trap, and this one turns a failure into a pass. When a rule fades a whole
control — `.button[aria-busy="true"] { opacity: 0.55 }` — the browser paints that element into one
layer and then composites the finished layer over the backdrop. The label never lands on top of the
faded fill. Fill and glyph each composite over the **same** backdrop at the **same** alpha, so both
slide toward the backdrop together and the contrast between them collapses. Compositing the glyph over
the already-faded fill is the intuitive model and it is wrong: on the Council room's join button it
answered 4.10:1 where the painted pixels give 3.19:1, so a WCAG 1.4.3 failure scored as a pass.
Measured 2026-08-23.

Calibrate the probe in both directions before you trust any number it prints. Send it a known-good
sample (the resting control, no opacity) and a known-bad one (the same two colours at the group alpha).
If the known-bad sample does not come back below the threshold, the arithmetic is wrong and the page is
fine — which is the opposite of what the report would have said.

## Proving an overlay blocks a control needs a hit test, not a screenshot

An overlay that visually covers a button is a picture; whether a person can still press the button is
a hit test. `document.elementFromPoint` answers the second question, because it is the same test the
browser runs for a real press.

**Sample five points per control, never the centre alone**, and read `blockedPoints`. A control can
have its centre clear and its edge covered, and then a press aimed at the covered edge lands on the
overlay. Proven on a fixture at 512x384 on 2026-08-23: a button whose top 20px sat under an overlay
answered with its own id at the centre, so a centre-only probe called it reachable, while a real
`mouse.click` on that top strip was received by the overlay. Note what this case is not: Playwright's
own `locator.click()` aims at the centre, so it **resolved** on that button — only a fully covered
control gets the `… subtree intercepts pointer events` refusal. A partly covered control passes every
click you make through Playwright and still has a dead strip for a person.

Also **skip a sample that falls outside the window; never count it as clear.** `elementFromPoint`
answers `null` there, and reading that `null` as "nothing is covering it" reports a control that is
scrolled or clipped out of view as reachable. The zoom viewports below are exactly the sizes where a
stage scrolls its lower rows away, so this used to hide the case at the helper's own defaults.

A sample that has scrolled out of a **clipping container** fails the other way, and reports blocked.
`elementFromPoint` answers with whatever paints at that screen position, so a control scrolled above its
own `overflow-y: auto` container answers with an ancestor — and the audit then names that ancestor as
the blocker. A reviewer this round reported two `button.participant-pin` blocked at all five points by
`#room-header`, which is `position: static` with `z-index: auto` and cannot cover anything. Compare the
control's `rect.top` with the scroll container's `top` before believing a blocker: above it means
clipped, not covered. Scroll the control into view and re-check. Measured 2026-08-23 on
`council-room-r22`.

`scripts/overlay-blocking-helpers.js` installs `state.qa.overlay` with `blocked()`, `sweep()` and a
`ZOOM_VIEWPORTS` list, and it applies both rules above — same sampler as `auditAccessibility` in
`install-harness.js`, which was corrected the same way. It returns `blocked` (any point covered),
`outOfView` (no point could be sampled — a scroll finding, not a pass), and per control `sampled`
plus `blockedPoints`, so a fully covered control reads differently from a partly covered one and a
zero-blocked result can be trusted. Two more things it handles that a hand-written probe usually gets
wrong: it reports a missing selector as an error instead of as "nothing blocked" — those have the
same shape otherwise — and it treats a hit on any DESCENDANT of the overlay as blocked, because
`elementFromPoint` answers with the deepest node, so an overlay with inner markup never matches its
own id.

The narrow viewports in that list are not phones. They are ordinary desktop displays at 200% and 250%
browser zoom, which WCAG 1.4.4 requires to keep working, and they land in media blocks authors wrote
for phones and never tested at zoom. 512x384 is a 1024x768 display at 200%.

## Your page can be closed by another agent sharing the same Edge browser

Several agents drive the same Edge install at once in this repo, and a page one of them closes is
gone for everyone. The symptom names your own state key, so it reads as your bug: `The current page
in state.dashPage was closed`. It happened twice in one session on 2026-08-22.

Do not assume your own script closed it, and do not start hunting for the call that did. Recover
with `context.newPage()` and re-run whatever boot runner set your state up, then carry on.

This is the same shared blast radius as the Worker entry above: check whether another agent is
working before you treat a disappearance as evidence about the app.

## `auditAccessibility` cannot see a focus-trap leak, so a clean audit on a dialog proves nothing about it

Measured 2026-08-22 on the Council room: `auditAccessibility` came back clean on `#view-call` with
eight controls and clean again on the open `#host-confirm` dialog — no unlabeled controls, no blocked
hit targets, no small targets, no negative tabindex. The dialog was leaking keyboard focus onto a
button behind it the whole time, and pressing Enter there took a destructive action the dialog was
asking about.

The audit reports labelling, target size and hit-blocking. A focus trap is none of those — it is
focus ORDER, and nothing in the audit walks it. `aria-modal="true"` is likewise a promise in markup,
not a behaviour the audit verifies.

So when a dialog is in scope, walk it explicitly: click a non-button inside the dialog (the backdrop,
the heading, its own text) so focus lands on `<body>`, then press Tab and Shift+Tab and assert the
active element is still inside the dialog. A trap written as `activeElement === firstButton ||
activeElement === lastButton` passes every audit and fails this walk.

Also note a clean pointer result says nothing here: `elementFromPoint` correctly reported the overlay
at every control centre, so the mouse was properly sealed. The overlay sealing the pointer is exactly
what makes a keyboard leak survive review — the dialog looks sealed.

Two non-findings to expect when walking a MyModal (Ariakit) dialog in this app (verified 2026-08-25 on
the plugin update-consent dialog): the CDP `Accessibility.queryAXTree` node reports `modal: false`
because Ariakit sets no `aria-modal` — it confines by stamping `inert` on everything outside instead
(the `RootLayout` div, the hoisting containers, and every other mounted-closed modal all carry `inert`
while the dialog is open), which removes background content from both keyboard and AT, so the missing
attribute is not a gap. And the Tab walk's only out-of-dialog stops are Playwriter's own injected
toolbar plus one transient `BODY` stop before the cycle returns to the first dialog control — see the
toolbar entry under Playwriter Availability.

## An injected stylesheet outlives the runner that injected it

`page.addStyleTag` stays on the page for every later probe in the same session. So a runner that
verifies a CSS fix by injecting it leaves that fix live, and the next runner measures the **fixed**
layout while believing it is reading shipped CSS.

Observed 2026-08-22: a reviewer proved a header-overlap defect at 683x384, injected a candidate fix to
check it, and then re-measured the same viewport in a fresh `-f` runner. It came back clean. The defect
was real and already proven; the second measurement was reading the injected rule.

- A new `-f` runner does not start from a clean page. Only a navigation or a reload clears injected
  nodes.
- Before re-measuring shipped CSS after any injection, remove the injected nodes and **assert they are
  gone** — count `document.querySelectorAll("style")` and compare against what the page ships, or
  reload and re-establish state.
- This is worse than an ordinary flake, because it fails in the direction of "no problem here". A
  defect you have already measured turning clean is the signature; treat it as evidence of your own
  injection, not of a fix landing somewhere else.

## `document.body.focus()` does not reset Chromium's sequential focus starting point

A focus-order walk that begins with `document.body.focus()` skips its first stop, so the reported tab
order is wrong from the very first entry — and it looks like a real finding about the page.

`<body>` is not focusable by default, so the call is a no-op and the sequential focus navigation
starting point stays wherever it was. Click a non-focusable element at the top of the document instead
(`#meeting-title` in the room, `.council-header h1` on the dashboard), then start pressing Tab.

Verified 2026-08-22 while walking both Council surfaces in real Edge.


## A wrong `vp.exe` path makes every mutation read as KILLED, so the package looks perfectly tested

`vp.exe` is at `C:/Users/rt0/.vite-plus/bin/vp.exe`. It is **not** under `WindowsApps`. A mutation
runner that spawns the wrong path gets `ENOENT`, `execFileSync` throws on every single mutation, and the
harness scores each throw as "the suite failed, so the mutation was killed".

Observed 2026-08-22: a reviewer's first campaign reported **116 killed, 0 survived** across
`packages/council-service/src`. That is not a suspicious number — it reads as a very well-tested
package, which is exactly why nobody questions it. The corrected run gave 88 killed, **57 survived**.

- Run two controls before believing any campaign result, and state both outcomes in the report:
  a **negative control** (a comment-only mutation that must SURVIVE) and a **positive control** (a real
  change that must KILL a test you can name).
- If the negative control reports "killed", your runner is broken, not the package.
- Like the injected-stylesheet hazard above, this fails in the direction of good news. A campaign that
  finds nothing is the one to distrust first.

## In Chrome, `CSSStyleRule.cssRules` is a truthy empty list, so a selector sweep reports zero selectors

Chrome supports nested CSS, so **every** `CSSStyleRule` carries a `cssRules` property. On a plain rule
it is an empty `CSSRuleList` — and an empty `CSSRuleList` is truthy.

So the natural recursion skips every plain style rule:

```js
// wrong: takes the branch for every rule, so no selectorText is ever read
if (rule.cssRules) { walk(rule.cssRules); continue; }
```

The sweep then reports `totalSelectors: 0` while `document.styleSheets` is plainly readable, which looks
like a permissions or cross-origin problem rather than a logic bug.

Read `rule.selectorText` first, and recurse only on `rule.cssRules.length > 0`.

Verified 2026-08-22 while matching all 113 room CSS selectors against a live DOM.

## `--reporter=basic` no longer exists in vitest 4, and the failure reads like a broken config

Vitest 4 removed the `basic` reporter. Passing it does not print "unknown reporter". Vitest treats any
name it does not know as a module to import, fails to resolve it, and dies before a single test runs:

```
⎯⎯⎯ Startup Error ⎯⎯⎯
Error: Failed to load custom Reporter from basic
    at loadCustomReporterModule (.../vitest/dist/chunks/cli-api.*.js)
  [cause]: Error: Failed to load url basic (resolved id: basic). Does the file exist?
```

The stack is all `vite`/`vitest` internals, so it reads as a broken vitest config or a bad install, and
you can lose a run chasing that instead of the flag. Reproduced 2026-08-23 on vitest 4.1.10 with
`vp env exec pnpm --dir packages/council-service run test --reporter=basic` (exit 1, zero tests run).

The reason anyone reaches for it is per-file test counts, and **the default reporter does not print
them** — it lists only the files that failed, then one summary line. To get counts per file, write a
JSON report and read it:

```sh
vp env exec pnpm --dir packages/council-service run test --reporter=json --outputFile="$SP/base.json"
```

Then sum `assertionResults.length` per entry in `testResults`. A ready script is
`per-file.mjs` under `t3-chat-+personal/+ai/fixer-bk-2026-08-23/`. It printed 22 files / 537 tests for
`packages/council-service`, matching the default reporter's own summary line — check that they agree,
because a JSON report written by a crashed run still parses.

## A script `focus()` never matches `:focus-visible`, so every ring probe reads `none`

`:focus-visible` follows the last input modality. When a probe focuses an element from
`page.evaluate` and no real key has been pressed in that tab, Chromium does not mark it focus-visible,
and a rule written as `:focus-visible { outline: ... }` never applies. The probe then reports
`outline-style: none` and a default `outline-color`, which looks exactly like "this element is missing
from the focus rule".

This fails in the direction of a finding, so it invents accessibility bugs rather than hiding them.
Measured 2026-08-23 in the attached Edge on the Council room, on a `<p>` in the room header that was
given `tabindex="-1"` at runtime so it could take focus at all:

| how focus was given | `matches(":focus-visible")` | computed outline |
| --- | --- | --- |
| `el.focus()` from `page.evaluate`, no prior key press | `false` | `none 3px rgb(244, 245, 247)` |
| real `Tab` presses first, then the same `el.focus()` | `true` | `solid 3px rgb(142, 171, 255)` |

Same element, same page, opposite conclusions. So: **reach the control with real
`page.keyboard.press("Tab")` before reading any ring**, and calibrate on a control you know is styled —
if a real button under real keyboard focus reads `none`, the probe is measuring the browser, not the
page. Note this is the reverse of the headless trap above: there the browser was wrong, here the probe
was.

## The relay refuses `file:///` navigation, so a local-fixture page needs `page.route` instead

`page.goto("file:///C:/...")` (and `setContent` pointed at local resources) fails through the relay:
the browser process never gets a usable `file://` origin, and the error reads like a bad path even when
the file exists. Observed 2026-08-23 while trying to serve a scratch HTML fixture to the attached Edge.

Do not fight it and do not start a throwaway web server for one fixture. Intercept a normal `http://`
URL and answer it with the fixture body from the runner:

```js
await state.page.route("http://qa-fixture.localhost/**", (route) =>
	route.fulfill({ contentType: "text/html", body: state.fixtureHtml }),
);
await state.page.goto("http://qa-fixture.localhost/");
```

Read the fixture file on the CLI side (`-f` runner embedding the string, or assign it to `state` in a
separate call) — the sandbox `fs` cannot reliably read repo paths, and the relay may not even run on
the Windows side (see the relay-topology entry above). A `page.route` fixture also keeps the page on a
real secure-ish origin, so cookies and `fetch` behave like a normal tab, which `file://` never does.

## Moving the pointer out of a plugin iframe leaves its `:hover` stuck on

The plugin UI runs in an out-of-process iframe. When `page.mouse.move(...)` takes the pointer to a
host coordinate outside that iframe's box, the iframe never receives the matching leave event, so the
last row the pointer touched keeps matching `:hover`. Every screenshot taken afterwards shows that
row's hover affordance — in Chitchat, a channel row that answers a click by covering its own name with
Rename and Archive. It looks exactly like a CSS bug in the app. Measured 2026-08-24: with the pointer
parked at host `y = 40` and the frame starting at `y = 48`, the row reported `opacity: 1`; with the
pointer parked inside the frame the same row reported `opacity: 0`.

Park the pointer **inside** the frame, on a strip that has no hover affordance of its own — the
channel header works, an empty area of the message log does not, because message rows reveal their own
actions and the cursor is painted into the screenshot.

```js
const box = await state.page.locator(".PluginsUiFrame").boundingBox();
await state.page.mouse.move(box.x + box.width - 60, box.y + 18); // channel header strip
await state.page.waitForTimeout(600);
```

Before believing any hover-looking finding, read the state instead of the picture:

```js
row.matches(":hover"); // stale-hover tells you here, the screenshot never will
```

## Windows backslash paths inside `-e` JavaScript are eaten before Node sees them

`-e 'await ...setInputFiles(["C:\Users\rt0\AppData\..."])'` arrives at the executor as
`C:Userst0AppData...`: the shell collapses `\` to `\`, and JavaScript then reads `\U` as `U` and
`\r` as a carriage return. The path is no longer absolute, so the relay resolves it against its own
CWD and the error reads `ENOENT ... 'C:\...\t3-chat\Userst0AppData...'`, which looks like a missing
file rather than a mangled string. Observed 2026-08-24.

Use forward slashes in every path you pass through `-e`. Node and Playwright accept them on Windows:

```js
setInputFiles(["C:/Users/rt0/AppData/Local/Temp/cc-verify/A-reference-mockup.png"]);
```

A `-f` runner written with a quoted heredoc (`<<'EOF'`) keeps `\` intact and is safe either way, but
forward slashes work there too and remove the question.

## `page.screenshot({ path })` writes anywhere, but the sandbox `fs` that reads it back does not

The two filesystems in a runner are not the same one. Playwright's own output APIs run in the relay
process with normal file access, so `page.screenshot({ path })` happily writes to the personal `+ai`
folder. `require("node:fs")` inside the same runner is the **scoped** sandbox, allowed only in the
relay's CWD, `C:\tmp`, and `%TEMP%`. Reading a screenshot back to log its size therefore throws
`EPERM: operation not permitted, access outside allowed directories` — after the file was already
written. The runner aborts on that line, so every later step is skipped and the whole run reads as a
failed screenshot when the screenshot is sitting on disk. Observed 2026-08-24.

The allowed set follows the **relay's** CWD, which is where the relay was started, not where the CLI
is invoked. `playwriter session list` prints it. A relay started at a repo root cannot read that
repo's sibling `-+personal` folder at all.

So: write screenshots straight to their final path, and check the size from the shell instead of
`statSync`. When a runner genuinely needs to read bytes back, stage the file under `%TEMP%` first.

## Park the pointer INSIDE the plugin frame before a screenshot, never outside it

This is the screenshot-side consequence of the stale-hover entry above. Moving the pointer out of the
frame to keep it out of the picture leaves the last `:hover` latched, so the shot shows a revealed
hover cluster on whatever row the pointer last crossed — and the run reports a clean state, because
the DOM agrees with the paint. Park on dead space inside the frame instead (the empty sidebar below
the channel list works), then assert it:

```js
await state.page.mouse.move(box.x + 60, box.y + box.height - 60, { steps: 6 });
// 0, or the shot has a hover state in it
[...document.querySelectorAll(".channel-item")].filter((r) => r.matches(":hover")).length;
```

The pointer is captured in the image, so pick a corner where an arrow costs nothing. Note that a
mouse-driven `click()` also leaves the pointer where it landed: blurring focus is not enough on its
own, the pointer has to be moved as well.

## A CSS bug can exist only in the production build, because layer order differs from dev

`pnpm run dev` serves CSS as `<style>` tags that Vite injects in module-graph order. `vite build`
splits CSS per chunk and links one file per chunk. A cascade layer's position is fixed by the **first**
declaration the browser sees, and a later `@layer a, b, c;` statement cannot reorder layers that
already exist. So the two modes can establish two different orders from the same source, and only the
production one is broken.

That is what happened on 2026-08-24. `src/app.css` declares the order, its chunk was linked **last**,
and the browser ended up with `common_components, components, properties, external, theme, normalize,
base, utilities, top_layer`. Tailwind preflight sits in `@layer base` and resets `padding`, `margin`
and `border` on every element, so it won against both component layers. The whole app lost its
padding, its buttons and its tabs. The `app-css-layer-order` plugin in `vite.config.ts` now copies the statement app.css
declares onto the top of every stylesheet, in dev and in the build, so whichever one loads first
establishes the right order and the rest are no-ops. app.css stays the only place a person edits it.

Two rules follow. First, **QA visual changes against `vite build` + `vite preview`, not only the dev
server** — a dev-only check cannot see this class of bug at all. Second, when a page looks unstyled or
flatly spaced, read the order the browser actually built before suspecting the components:

```js
const order = [];
const walk = (rules) => {
	for (const rule of rules) {
		const kind = rule.constructor?.name ?? "";
		if (kind === "CSSLayerStatementRule") { for (const n of rule.nameList) if (!order.includes(n)) order.push(n); }
		else if (kind === "CSSLayerBlockRule") { if (rule.name && !order.includes(rule.name)) order.push(rule.name); walk(rule.cssRules); }
		else if (kind === "CSSMediaRule" || kind === "CSSSupportsRule") walk(rule.cssRules);
	}
};
for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin */ } }
```

To measure the damage rather than infer it, walk the same sheets for rules inside `components` /
`common_components` that declare padding, `querySelector` each one, and compare the declared value
with `getComputedStyle`. Anything computing to `0px 0px 0px 0px` is being overridden. Two selectors
legitimately compute to zero (`.MyPopoverContent` under the link setter, and the chat composer's
`--AiChatComposer-editor-content-padding: 0px`), so a nonzero result is not automatically a bug —
check the source before reporting one.
