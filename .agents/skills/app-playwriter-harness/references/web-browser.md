# Web Browser (Web Mode) QA

Recipes for the workspace web browser route `/w/<org>/<ws>/browser`. The file mode browser inside
Files has its own recipe in [files.md](files.md) under "Shared Cloud Browser End To End". Product
rules and limits live in `.agents/skills/cloud-browser/SKILL.md`. Verified 2026-09-23.

## Before you start

- Needs `AI_CHAT_BROWSER_ENABLED=true` on the dev deployment and a deployed dev runner
  (`bonobo-senate-browser-runner-dev`).
- Browser time is billed to the signed-in user: 0.3 credit cents per started minute, settled once per
  session. Keep sessions short and press `End browser` on every session you start.
- Limits: 60 min total, 9 min idle. Watching and page navigation do not extend idle. Input (address
  bar navigation included) and `Keep open` do.
- Test site: the checks below were run on a scratch Worker (`bonobo-browser-spike`), which was
  deleted on 2026-09-23 when the feature shipped. Before a new QA run, deploy a small scratch Worker
  from your personal task folder (never from the repo) with the same pages, or use a public site that
  has them. Pages it served under `/site/`:
  `login` (form; POST sets an HttpOnly cookie and redirects to `private`), `private` (`LOGGED IN` or
  `LOGGED OUT`), `links` (downloads, a `target=_blank` link, a `window.open` button, file inputs),
  `frames`, `redirect`. Every page title is `spike`, so check the address, not the title. Other paths
  answer 403, and the favicon 403 shows up as a console error. That one is expected.

## Selectors

- Panel: `getByRole("region", { name: "Web browser" })` with `data-browser-mode="web"`.
- Start card: button `Start web browser`. A user without a paid plan sees `The browser needs a Pay As
  You Go or Pro plan...` and no button. A user without `workspace.browser.use` (system role
  `viewer`) sees `The web browser is not available in this workspace.` and no `Browser` item in
  `[aria-label="Main navigation"]`. A live file browser shows `A file browser is open in Files.` with
  `End it and start here`.
- Live panel: toolbar `role=toolbar` named `Browser` (`Back`, `Forward`, `Reload`/`Stop`, textbox
  `Address`, `Go`, `Take control`/`Resume agent`, `Manage saved data`, `Keep open`, `End browser`, switch
  `Agent can use this browser` with `data-agent-access`).
- Status text: `.WebBrowserLive-title` (page title), the first `role=status` (`Live`, `You have
  control`, ...), `.WebBrowserLive-notice` (`role=status`, one-shot notices), and
  `.WebBrowserLive-address-error` (`role=alert`).
- Viewer: `role=application` inside the region, with an `img` whose natural size is 1280x800.
- Agent panel on the same route: `section[aria-label="Agent"]`.

## Drive the panel

The Playwriter tab is usually in the background. Locator `.click()` then hangs at "performing click
action" (see known-hazards). Use keyboard or mouse coordinates instead:

```js
// Address: focus + fill + Enter. Never locator.click() here.
const region = state.page.getByRole("region", { name: "Web browser" });
const addr = region.getByRole("textbox", { name: "Address" });
await addr.focus({ timeout: 2000 });
await addr.fill(state.goUrl, { timeout: 2000 });
await addr.press("Enter");
```

```js
// Toolbar button by name: focus + Enter.
const btn = region.getByRole("toolbar", { name: "Browser" }).getByRole("button", { name: state.toolBtn, exact: true });
await btn.focus({ timeout: 2000 });
await state.page.keyboard.press("Enter");
```

Page clicks go through the viewer image. Map remote page pixels to viewport pixels from the contained
image rectangle, and compute it again before every click:

```js
const box = await state.page.evaluate(() => {
	const el = document.querySelector('[role="region"][aria-label="Web browser"] [role="application"] img');
	const r = el.getBoundingClientRect();
	const scale = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
	const w = el.naturalWidth * scale, h = el.naturalHeight * scale;
	return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, scale };
});
const vx = box.x + state.clickAt[0] * box.scale;
const vy = box.y + state.clickAt[1] * box.scale;
await state.page.mouse.move(vx - 5, vy - 5);
await state.page.mouse.move(vx, vy);
await state.page.mouse.click(vx, vy);
```

Take control first and wait for `You have control` and `Resume agent`. A view-only click sends
nothing. A page reload or HMR remount of your tab drops human control back to `Live`, so read the
status before each input step. A viewer socket reconnect does the same, with the notice `You lost
control because the viewer reconnected. Take control again.` On runner `dd116c55` this hit 3 minutes
after Start on a background QA tab: the tab renews the viewer every 20 s, the grant lasted 30 s, and
the throttled background timer fired late. The tail then shows `viewer_end` with `code: 4408` and
`reason: "grant expired"`, then a new `viewer-grant` and `viewer_attach`. The grant now lasts 90 s,
so a late renew no longer drops control. Still check `You have control` inside the same call as the
click. Verified on runner `8bb9bb1a`: 5.7 min of control with one mouse move, renews 19-21 s apart,
no `4408`.

To prove "no reconnect" from the tail, count `POST /internal/browser/viewer-grant`, not
`viewer_attach`. In dev each viewer mount sends two grants in the same millisecond (React
StrictMode), so expect them in pairs. A viewer socket that stays open for many minutes may never
show its `GET /viewer/stream` event (and so its `viewer_attach`) in the tail, even after it closes;
a short-lived socket does show it.

On a background tab the two `mouse.move` calls plus `mouse.click` can take about 4 s. Take control
in one call and click in the next, or the 5 s CLI budget runs out (the click still lands).

To see the remote page, do not screenshot the viewer: on a background tab
`locator.screenshot()` stalls at "waiting for element to be stable". Save the frame the runner sent
instead, then open the file with your image reader. It works view-only too:

```js
const b64 = await state.page.evaluate(async () => {
	const el = document.querySelector('[role="region"][aria-label="Web browser"] [role="application"] img');
	const buf = new Uint8Array(await (await fetch(el.src)).arrayBuffer());
	let s = "";
	for (let i = 0; i < buf.length; i += 1) s += String.fromCharCode(buf[i]);
	return btoa(s);
});
require("node:fs").writeFileSync(state.framePath, Buffer.from(b64, "base64"));
```

Pixels in that JPEG are remote page pixels (1280x800), so they feed `state.clickAt` directly. On the
test site `login`, the `Log in` button is at about (210, 18).

## Checks

- Start: press `Start web browser`, wait for `Live` (the first start can take 20-60 s). Read
  `files_browser.current_browser_session` to get the session id.
- Navigation: Address to `/site/links`, click a link through the viewer, then `Back` and `Forward`.
  Poll the notice, address, and status every 250 ms for about 3 s; the address updates from the
  runner, not from your typing.
- Blocked addresses (the page must not change):
  - `ftp://x` → `Use an address that starts with http:// or https://.`
  - `http://user:pw@example.com` → `Remove the user name and password from the address.`
  - `localhost:5173` or an app, Convex, or Clerk host → `This address is blocked.`
- Popups on `/site/links`: the `target=_blank` link and the `window.open` button must each show the
  notice `Opened the new tab here` and load the target in the same viewer.
- Agent: send the first message in the Agent section, wait for the saved chat tab, then press `Resume
  agent`. An empty optimistic `New chat` does not enable Resume. A message sent while you still hold
  control gets no browser tool at all: the model answers that `browser_run` is not available (seen
  2026-09-23). Press `Resume agent` (status back to `Live`) before the message that must run. For a screenshot use the snippet
  from files.md with path `/qa-web-<runId>/page.png`. Send a second message in the same chat and
  require a second `Browser run` card.
- Two chats: start a long `browser_run` in chat A (for example `await page.waitForTimeout(24000)`),
  wait for its card to be `aria-busy="true"`, then send in chat B. Chat B's card must fail with
  `Another chat is using the browser. Try again later.` Chat sends share a rate limit (a new token
  every 15 s), so a send in B right after A waits about 15 s before its tool call. Send B about 14 s
  after A. Keep A's wait under 30 s: a command that times out closes the session.
- Agent access switch: it is an `input type=checkbox role=switch`, so `aria-checked` reads null.
  Focus it, press Space, then read `.checked` and `data-agent-access` (`on`/`off`). While off, an
  agent `browser_run` must be refused. Test two paths: off before the turn starts (the model gets no
  browser tool and a note, so there is no card), and off while a card is `aria-busy="true"` (the
  card must show the access-off reason).
- Service worker sites: `https://squoosh.app/` registers a service worker. Ask for a goto plus a
  3 s wait, then a second command. The session must stay open. The tail must show two `run`
  lines with `status: succeeded` and no `drain_timeout`, and the doc must stay `control: "ready"`.

## Agent result traps

- The model can wrap the code in `async ({ page }) => { ... }`. That only defines a function, so the
  runner refuses it: the card shows `errored` with "Your code returned a function. Write the function
  body only, do not wrap it in a function." The model usually retries without the wrapper. Read the
  card's `Result` block, not the model's reply.
- For close reasons, tail the dev runner while you test:
  `vp env exec pnpx wrangler tail bonobo-senate-browser-runner-dev --format json > <scratch>/tail.jsonl`.
  Lines tagged `browser_runner` carry `route` and `reason` (for example `run` `tainted`/`settle`,
  `close` `agent_settle_failed`, `agent_connection` `drain_timeout`). Stop the tail when done.
  The file is not JSONL: each event is a pretty-printed multi-line object, and the runner lines
  sit as escaped strings inside `logs[].message`. Split it by brace depth in a small Node script,
  or grep for `browser_runner`. A log line is listed under the event that carried it, and a
  WebSocket event (`GET /viewer/stream`, with its `viewer_attach`) appears only when the socket
  closes.
- Every close logs `close_request` with `by` and `saveProfile` before `close` (runner `dd116c55`).
  `by` is one of `human_end`, `agent_close`, `access_lost`, `profile_listed`,
  `profile_site_cleared`, `profile_cleared`, `start_orphan`, `account_deleted`, `member_removed`.
  Only `human_end` has `saveProfile: true` and is followed by `profile_save`. A `close` with no
  `close_request` before it came from the runner itself (idle or total expiry, lost host). Each open viewer
  logs `viewer_end` with the socket close code: `4404` `session gone` on a close, `4408`
  `grant expired` on a late renew. The runner also logs `profile_save` about every 2 minutes
  while a session is live, so a `profile_save` alone does not mean a close.
- Idle: leave the session without input. After `idleUntil` the Start card must return and
  `current_browser_session` must be null.
- Busy both ways: with a web session live, the Files browser panel shows `A web browser is open.`
  with `Open the web browser` and `End it`, and no Start button. With a file session live, the web
  route shows `A file browser is open in Files.` with `End it and start here`. The door check is
  `start_web_browser` while a file session is live, and `start_browser` while a web session is live;
  both must return `_nay` `Browser busy` without a new row.
- End: `End browser` must bring the Start card back.
- A session that closes on its own: the `files_browser_sessions` row keeps no close reason, and the
  runner logs `close` with `reason: "close"` for every app-sent close. A human End logs
  `profile_save` right before that `close`; a close without it came from a path that does not save
  (access loss, a saved-data action, the agent's close) or from a runner that lost its memory. To
  tell them apart you need the Convex calls, so start `convex logs --jsonl` in the background
  before the run (see known-hazards) and look for `begin_close_browser_session` (End) versus
  `begin_close_browser_session_internal`.

## Saved logins

Verified 2026-09-23 on runner version `ac58f65d`.

- Keep-login check: log in on `/site/login`, press `End browser`, then Start again with the Start
  card's `Start address (optional)` field set to `/site/private`. The page must show `LOGGED IN`
  with no input from you. This also proves the restore runs before the first navigation.
- Runner status: POST `/internal/browser/status` with the doc's `runnerSessionId` (not its `_id`),
  `ownerId`, `organizationId`, and `workspaceId`. It answers `profileStored`. That flag belongs to the
  owner and workspace, not to the session, so it reads the same for any session id; `alive` needs the
  real `runnerSessionId`. Keep the runner secret in a variable and never print it.
- The runner tail logs only counts: `profile_restore` with `cookies`, and `profile_save` with
  `cookies` and `truncated`. A human End logs `profile_save` before `close`.
- Agent cookie probe: ask for one `browser_run` that returns `document.cookie`,
  `page.context().cookies()`, `page.context().newCDPSession(page)`, and request and response headers
  from `page.on("request"/"response")` plus `allHeaders()` during a fresh login. Expected:
  `document.cookie` holds only the non-HttpOnly `sesscookie=1`; `cookies()` and `page.request` fail
  with `Browser command is not allowed: Storage.getCookies`; `newCDPSession` fails with
  `Target.attachToBrowserTarget`, so no CDP cookie call is reachable at all; every `cookie=` and
  `set-cookie=` header reads empty, including on the 303 login response. Return cookie values in the
  probe on purpose, so a leak shows `abc123`. Then search the page HTML and the stored
  `ai_chat_threads_messages_aisdk_5` rows of that thread for `abc123`.
- `files_browser_profiles.profileKey` must never be printed. `convex data` prints it as
  `Bytes("...")`, not as a JSON string, so a filter that only hides `"profileKey": "..."` still
  prints it. Do not read that table with full rows; count rows or print only other fields.
- Manage saved data dialog (`.WebBrowserSavedData`, open it from the Start card or the live toolbar
  button `Manage saved data`): `Show saved sites` lists one row per site with a cookie count and no
  values. Each row has its own button named `Clear <domain>`, and
  the dialog also has the blocked-sites `Add a site` input and `Clear all saved data`, which asks
  for a confirm step. Escape closes it and focus returns to `Manage saved data`. Focus checks
  (verified 2026-09-23 on the fixed build): after `Show saved sites` focus moves to the `Saved
  sites` heading (`h3`); after `Add` or a row's `Remove` it lands in the `Add a site` input. Trace
  focus with a 50 ms page-side poll of `document.activeElement` started in the same call as the key
  press; a single read after the call can miss a short stop on `<body>`. A row's `Clear <domain>`
  moves focus to the `Saved sites` heading before the row goes away (verified again on
  2026-09-23). The poll can also miss the pressed button itself, because `focus()` plus Enter can
  finish between two samples. Add a `focusin` listener in the same call if you need that stop.
- The row clear check needs a saved site. If the list is empty, Start on
  `/site/login`, press `Log in`, then `End browser`: the tail logs `profile_save` with `cookies: 2`
  and the list shows the test site with 2 cookies.
- `Show saved sites` while a browser is live first shows `Your browser is open. Showing saved sites
  ends it first.` with `End browser and show sites` and `Cancel` (focus on `Cancel`). Confirming
  ends the session: the tail logs `close_request` with `by: "profile_listed"` and
  `saveProfile: false`, no `profile_save`, then `close`.
- Texts to expect: an empty list reads `No saved sites.` (with `Nothing was saved yet.` when there
  is no profile at all); a row clear shows `Cleared <domain>.` and the tail logs `profile_clear`
  with `removed`; `Clear all saved data` asks for `Clear all` / `Cancel`, then shows `All saved
  data is cleared.` and moves focus to the `Clear all saved data` heading.
- Blocked site check: add the site's host, Start on a page of that site, and ask the agent for one
  `browser_run`. The tool card must fail with `This site is on the list of sites the agent may not
  use.` and hold no page text. The runner tail logs `run_begin` refused with `agent_blocked_site`.
  Remove the host at the end.
- Clear all, member removal, and account deletion all delete the profile row and ask the runner to
  delete its copy. The wipe row is processed in about 1 s, so a 4 s poll never sees it. Use these as
  evidence instead: the `files_browser_profiles` row is gone, the runner tail logs
  `POST /internal/browser/profile-delete` and `profile_delete` with `deleted: true` (2 s after the
  confirm on 2026-09-23), and status answers `profileStored: false`. To prove the profile row is
  gone without printing `profileKey`, keep only the `There are no documents in this table.` line
  of `convex data files_browser_profiles`. Then Start again on the private
  page; it must show `LOGGED OUT`.
- Member removal: the owner's `Remove` on the Users page has no confirm step. To restore the member,
  invite the same email again. The new membership has a new id.
- Account deletion: `Manage account` > `Security` > delete account, then type `delete`. This deletes
  the Clerk user at once, so the `+clerk_test` account is gone for later runs ("Couldn't find your
  account"). The users row keeps a `deletedAt`, and a `data_deletion_requests` row waits 7 days. Use
  only an account you are allowed to lose.
- These checks need a paid plan on the second identity (see the next sections).
- Starts and the status POST for one owner can fail for a few minutes with `Network connection lost`
  (Cloudflare error 1101) while other owners still work. Seen once on 2026-09-23; it recovered by
  itself in about 3 minutes. Wait and retry. Failed starts create no session row.

## Downloads and uploads

Verified 2026-09-23 on runner version `7bbfca50`, and again on `dd116c55` after the Convex-to-runner
routes moved to hyphen names. The tail request paths are now `/internal/browser/download-info`,
`download-push`, `upload-fill`, `upload-grant`, `profile-summary`, `profile-clear`, and
`profile-delete`. Take control first; a view-only click sends
nothing. On the test site `links` page the remote pixels are: `attach` (27, 18), `octet` (65, 18),
`pdf` (95, 18), `a download` (147, 18), `redirect attach` (234, 18), `data` (297, 18), `blob`
(335, 18), `blobkeep` (395, 18), `post` (28, 39), `#file1` (150, 60), `#filem` (406, 60), `picker`
(642, 60). `#out` (under the inputs) shows `name:size` after a file is given.

- Toasts and notices are short-lived and CLI calls are slow. Install a page-side recorder once: a
  100 ms `setInterval` that pushes each new text of `[data-sonner-toast]`, `.WebBrowserLive-notice`,
  `.WebBrowserFileChooser`, and the Address value to a `window` array with a timestamp. Read the
  array after each step. It survives between calls because the SPA does not reload.
- Human download: the toast `Saved to .system/downloads/<name>` comes 1-8 s after the click, with
  `Open` and `Delete`. Press them with focus + Enter in a call that waits for the toast: on a
  background tab the toast buttons measure just below the viewport. `Delete` archives the file
  (toast `Download deleted. You can restore it from the archived items in Files.`). `Open` goes to
  `/files?nodeId=<id>`.
- Readback: `get_authorized_by_path` for `/.system/downloads/<name>`, `get_entries` for the
  metadata (`source: browser-download`, `original-url` = origin only, none for `data:`), then the
  signed download from [files.md](files.md) fetched in the sandbox. The test bodies are all `0x41`
  (attach, redirect, post) or `0x42` (octet). Names: `réport-N.bin` is stored as `report-N.bin`
  (the name rule drops the accent); `octet` keeps no extension; a second save gets `-2`. The
  `octet` link answers `Content-Type: application/zip`, so its node says `application/zip` while
  the signed download serves `application/octet-stream`. That is the test site, not a bug.
- Save rows: each human save writes a `files_browser_download_saves` row. `pushedAt` must be a
  number about 1 s after `createdAt` once the bytes reached Files (`null` means the push has not
  finished and a later save pushes again). This table has no secrets, so
  `convex data files_browser_download_saves` is safe to print.
- What each link gives: `pdf` shows inline (no toast), but the PDF viewer's own download button
  (1175, 28) saves `pdf.pdf`. `blob`/`blobkeep` give nothing. `/site/links?size=31457280` then
  `attach` gives the notice `Download not saved: over 25 MB.` in under 1 s.
- Page timer download: ask the agent for one `browser_run` that sets
  `setTimeout(() => { location.href = "/site/attach?size=10"; }, 8000)` and returns. Use 8 s, not
  3 s, so the timer fires after the command has ended; inside the command it would be an agent
  download. Expected notice: `A download started without a click was blocked.`
- Agent download: a `browser_run` that clicks `#attach` and waits 3 s. The card lists
  `/.system/downloads/<name> · Pending review`; read the bytes with the pending recipe in
  [files.md](files.md). Go to `/site/links` in the same snippet, or the agent gets the 30 MiB link.
- Runner tail lines: `download` with `owner` `human`/`agent` and `bytes`, `download` `refused`
  (`download_blocked`, `download_too_large`), `download_push`, `file_chooser` with `multiple`,
  `file_chooser_fill`, and `run` with `downloadCount`.

File chooser dialog (`.WebBrowserFileChooser`, a MyModal `role=dialog`):

- `Choose from Files` is `role=combobox`, not a button. Its popover
  (`.WebBrowserFileChooser-picker`, `aria-label="Choose a file from Files"`) opens with focus in
  `Search files`. Type part of the path, then Enter picks the active item and the list shows
  `Remove <name>` plus `Give to the page`.
- Do not press `From your computer` from Playwriter: it opens the real OS file dialog. Call
  `setInputFiles` on `.WebBrowserFileChooser input[type=file]` (hidden) with an absolute Windows
  path instead. It fires the same change handler, so the grant and the `PUT /viewer/upload` run.
- The upload `PUT` URL carries the grant id. Keep it in `state` through a `page.on("request")`
  filter on `/viewer/upload` and never print it. Replay it from the app page (origin
  `localhost:5173`); from another origin the runner answers `origin_refused`. A used grant answers
  `403 {"ok":false,"code":"grant_invalid"}`.
- If control is lost while the dialog is open, the runner has already dropped the chooser (a
  chooser belongs to one human turn, so taking control again cannot bring it back). The dialog then
  says `Control of the browser changed, so the page no longer waits for this file...`, disables
  both sources, and shows a focused `Close` button instead of `Cancel`. Close it, take control, and
  click the page's file input again.
- A second tab on the same route cannot be used to lose control while the chooser is open. Its new
  viewer gets the same open chooser, so its toolbar is `inert` too and `Resume agent` cannot be
  reached. That tab also shows `You have control` and an active chooser although its own viewer
  does not hold control. Seen 2026-09-23 on runner `8bb9bb1a`.
- The open modal makes the browser toolbar `inert`, so a toolbar focus + Enter silently does
  nothing. To test "navigation while a chooser is open", call `sendNav({ action: "reload" })` on
  the viewer ref: walk up from the `[role="application"]` element's `__reactFiber$` key to the fiber
  whose `memoizedProps.ref.current.sendNav` is a function. The chooser's own props (`chooserId`,
  `controlGen`, `sessionId`) sit on a parent fiber of `.WebBrowserFileChooser-content`
  (`memoizedProps.chooser`). With them you can call `grant_browser_upload` and
  `fill_browser_chooser_from_files` from page context. After the reload the dialog closes by
  itself, the old grant answers `grant_invalid`, and the old chooser fill answers `_nay`
  `chooser_gone`.
- A valid grant `PUT` from outside the dialog also fills the page, and the runner then closes the
  dialog (`file-chooser-closed`). One fill per chooser: a Files fill after it gets `chooser_gone`.
- `picker` (showOpenFilePicker) shows the notice `This site uses a file picker the cloud browser
  does not support.`, and the page's call ends with `AbortError` (page title `picker:AbortError`).
- Keyboard: focus starts on `Choose from Files`; Tab goes `From your computer`, `Cancel`, `Close`,
  then Playwriter's own toolbar (a harness artifact, see known-hazards). Escape and `Cancel` close
  the dialog and focus returns to the viewer `role=application`. Opening the input again gives a
  new dialog.

## Billing readback

Read the rows from the repo root. Do not pipe the command when you read its exit code:

```powershell
vp env exec pnpm --dir packages/app exec convex data files_browser_sessions --limit 5
```

A closed row has `control: "closed"`, `closedAt`, and `billing: { state: "settled", billedMs,
amountCents, settledAt }`. The payer is the top-level `billedUserId` (not inside `billing`); for a
web session it equals `ownerId`. Save the rows with `--format jsonl` to a scratch file and read
only the fields you need: a row also carries `runnerSessionId`. Check
`amountCents === Math.round(Math.ceil(billedMs / 60000) * 0.3 * 10) / 10`: Convex stores the amount
rounded to tenths of a cent, and a plain `* 0.3` gives values like `0.8999999999999999`. A live row has
`billing: { state: "pending" }`. `billedMs` is the runner receipt's `endedAt - providerAcquiredAt`,
not `closedAt - createdAt`. It includes the start-up time after the browser was acquired and before
`Live`.

## Second identities (viewer role, no plan)

Use an isolated headless Playwriter session and the seeded `+clerk_test` accounts from
[clerk-test-accounts.md](clerk-test-accounts.md). Never sign in or out in the user's profile.

- The `qa-browser/home` workspace has an owner (`qa.perm.owner`) and a member (`qa.perm.viewer`).
  Neither account has billing state, so both behave like a no-plan user.
- To test the viewer role, the owner calls `access_control.set_user_role({ organizationId,
  workspaceId, userId, role: "viewer" })` from page context, and reads it back with
  `access_control.get_organization_workspace_user_role`. Restore `role: "member"` at the end and read
  it back again.
- Expected: as viewer, `web_browser_available` answers `{ enabled: false, paidPlan: false }`,
  `start_web_browser` answers `_nay` `Permission denied`, and the nav has no `Browser` item. As a
  no-plan member, the nav has `Browser`, the route shows the plan text, and there is no Start button.
- The Files browser shows the same plan text to a no-plan user and no `Start shared browser` button.
  Get the ids with `organizations.get_membership_by_organization_workspace_name`.
- `qa-browser` bills per user, so a member needs its own plan to Start. Give one with
  `billing:apply_polar_customer_state_refresh` (see [clerk-test-accounts.md](clerk-test-accounts.md)):
  a fake customer id, `externalId` set to the users id, and one active subscription on the Pay As You
  Go product `3174b1ac-cf0a-4b3b-9fd7-bb577081a702` with a meter entry for
  `7bbb2570-a40b-491b-b426-274fe7bb66f9`. Remove the plan afterwards by sending the same customer with
  `deletedAt` set; that deletes the snapshot row. Read the snapshot before and after, so you restore
  the state you found.

## Accessibility screen

- Run `auditAccessibility({ selector: '[role="region"][aria-label="Web browser"]' })` once view-only
  and once with human control.
- With control, the audit reports one `blockedHitTarget` on the viewer `role=application`. That is a
  false positive: the element at its center is its own `img`.
- Tab walk with control: `Reload`, `Address`, `Go`, `Resume agent`, `Manage saved data`, `Keep open`,
  `End browser`, the switch, then the viewer. `Back` and `Forward` are skipped while disabled. The
  Address focus ring is drawn on its `MyInputBox` wrapper, not on the `input`.
