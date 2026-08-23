# Plugin Marketplace QA (install / uninstall / update)

Recipes for driving the Plugins catalog and plugin detail pages. Selectors and behavior verified 2026-08-01 on the dev deployment.

## Naming trap

- `video` is the transcription plugin (auto-runs on video uploads, needs publisher secrets). `video-player` is the file-view player plugin. The catalog card titles ("Video" vs "Video Player") look alike — confirm the route name before installing. When unsure, read `name` in the plugin repo's `bonobo.plugin.json`.
- Detail page route: `/w/<org>/<workspace>/plugins/<pluginName>`.

## Page readiness

After `goto`, the SPA renders a bootstrap shell ("Preparing organization") first. Wait for real content, not a fixed timeout:

```js
await state.page.goto("http://localhost:5173/w/personal/home/plugins/video-player", {
	waitUntil: "domcontentloaded",
	timeout: 45000,
});
await state.page.waitForFunction(() => document.body.innerText.includes("Version"), { timeout: 30000 });
```

These in-script waits exceed the CLI's default 10s execute timeout. Size the CLI flag above the longest in-script wait (for example `--timeout 50000`), or split the `goto` and the readiness poll into separate short calls.

Read install state from the page text: the detail page shows `Installed` plus a `Version x.y.z` line, and the action button is `Install`, `Update`, or `Uninstall`.

## Install / update / uninstall

- Install: click `Install` (`exact: true`), then the consent modal's `Accept and install`.
- Update: click `Update` (`exact: true`), then `Accept and update`. Match `/Accept and (install|update)/` when the flow may be either.
- Uninstall: `Uninstall` (`exact: true`) applies immediately — there is no confirm dialog.
- The `plugins_manage` rate limiter is a token bucket (capacity 2, ~6/min). Space install/uninstall/update mutations ~15 seconds apart, or the next mutation fails.
- Before clicking, check that no open dialog backdrop covers the page. The org/workspace switcher is a frequent blocker — close it with its own `Cancel`. Do not treat `querySelector('[role="dialog"]')` as proof a dialog is open (see `known-hazards.md`: many dialogs stay mounted while closed).

## Publisher pages

After a successful publish, the publisher card turns into a link to the plugin detail page. The `Publish` button for a republish lives on the detail page, not on the card.

The claim form's submit button is named `Claim` (`exact: true`) — there is no button named "Claim repository".

## Publishing a QA fixture plugin without GitHub

When a check needs a plugin with an arbitrary manifest (for example specific `secrets[]` declarations), publishing through GitHub is overkill. Claim a fake repository URL through the publisher UI as the signed-in user, then register the version with the operator-invokable internal mutations from the CLI (see the CLI recipe in `snippets.md` for the command wrapper and the JSON5 args syntax):

1. In the browser, claim a unique URL like `https://github.com/<user>/qa-health-<date>` with the `Claim` button.
2. Read the new claim's `_id` and `ownerUserId` back with `convex data plugins_publisher_repositories` — do not trust an older seeded claim, the owner differs.
3. Run `plugins:upsert_plugin` with the manifest fields (pass `createdBy` = the claim's `ownerUserId` so publisher-tier rules match), then `plugins:finalize_plugin_version` to flip it `ready`.
4. Cleanup: uninstall from every workspace, then run `plugins:hard_delete_plugin_from_registry "{pluginName:'<name>'}"` repeatedly until it returns `done: true`, and check the claim is gone from `plugins_publisher_repositories`.

## Manage secrets dialog

Reachable only for an **installed** plugin that declares `plugin.secrets.read` (`video` does,
`video-player` does not). The panel is `.RoutePluginsPluginSecrets`; open the dialog with the
`Manage secrets` button.

Inside the dialog the Name field is `input[placeholder=OPENAI_API_KEY]` — the placeholder is a
literal example, not the stored secret. Buttons are `Save`, `Close`, and one
`Delete workspace secret <NAME>` per stored secret. Scope with
`locator("[role=dialog]").filter({ hasText: "Manage secrets" })`; many dialogs stay mounted while
closed on this route.

To drive the **batch** (`.env`) import path, write the KEY=value text to the clipboard and paste into
the **Name** field — pasting multi-line text there is what triggers the batch mutation. A paste into
Value refuses multi-line input by design:

```js
await state.page.evaluate(() => navigator.clipboard.writeText("A=1\nB=2"));
await dialog.locator("input[placeholder=OPENAI_API_KEY]").click();
await state.page.keyboard.press("Control+v");
```

Read `[data-sonner-toast]` in the **same** execute call as the paste; the batch result is reported
only as a toast, and sonner auto-dismisses it.

## Minting a plugin_ui token for API checks

A file view's `plu_` token never appears in main-frame network traffic — `page.on("request")` on the
host page captures nothing, because the host mints the token over the Convex websocket and hands it
to the sandboxed iframe. To exercise the token directly, mint one through the app's own authenticated
client (this runs as the signed-in user, so it is a user path, not a bypass):

```js
const { app_convex, app_convex_api } = await import("/src/lib/app-convex-client.ts");
const { app_fetch_main_api_url } = await import("/src/lib/fetch.ts");
const membership = await app_convex.query(
	app_convex_api.organizations.get_membership_by_organization_workspace_name,
	{ organizationName: "personal", workspaceName: "home" },
);
const views = await app_convex.query(app_convex_api.plugins_ui.list_file_views, {
	membershipId: membership._id,
});
const minted = await app_convex.mutation(app_convex_api.plugins_ui.mint_file_view_session, {
	membershipId: membership._id,
	pluginName: views[0].pluginName,
	fileViewId: views[0].fileViews[0].id,
	fileNodeId: "<a node whose contentType the view declares>",
});
```

`membershipId` is not readable from the DOM; this query is the way to get it. `/api/v1/files/read`
takes a **path**, not a node id, so a cross-file check is `body: { path: "/README.md" }`.

## Driving `/api/v1/plugin-data/*` with a user API key

The plugin-data routes are the cheapest way to check plugin-data behaviour end to end, because a user
API key reaches them without a plugin run. Mint one on the API-keys route with `Read plugin data` and
`Write plugin data` (see `app-map.md`), then call the route from page context so the request comes
from the app origin:

```js
state.convexHttp = "https://<deployment>.convex.site"; // VITE_CONVEX_HTTP_URL in packages/app/.env.local
state.pdWrite = async (key, body) =>
	await state.page.evaluate(async (a) => {
		const r = await fetch(a.origin + "/api/v1/plugin-data/write", {
			method: "POST",
			headers: { Authorization: "Bearer " + a.key, "Content-Type": "application/json" },
			body: JSON.stringify(a.body),
		});
		return { status: r.status, body: await r.json() };
	}, { origin: state.convexHttp, key, body });
```

What a user API key can and cannot reach, so a check is not designed around an impossible refusal:

- The body **must** name `installationId` for a user API key, and the installation must have accepted
  the matching `plugin.data.*` capability. Omitting it is a 400 `installationId is required for an API
  key`; the plugin token kinds carry their own installation and are refused for naming a second.
- Read the installation id from `vp env exec pnpx convex data plugins_workspace_installations`; it is
  not in the DOM.
- Ordered writes (`/write-versioned`, `/delete-versioned`) and reservations (`/reserve`) require a
  `plugin_service` principal. A user key gets 403 `Permission denied`, never a conflict, so a 409
  check cannot be built from user keys alone: plain `/write` does not enforce writer ownership between
  two keys, and the conflicts that do exist need a document a service wrote first. A service grant
  needs the installation to declare `plugin.service.connect`.
- Revoking the key on the page takes effect immediately — the next call is 401 `Unauthenticated`.

Uninstalling the plugin drains its `plugins_data` and `plugins_data_usage` rows, which is the cleanup
step after this kind of check. Confirm with the dual-control counting rule below.

Checking tenant isolation and the uninstall drain needs a **second installation you own**, and the
signed-in account is the organization owner, so an owner-only run proves nothing about a refusal that
a permission check would have produced anyway. Build the second installation in a scratch workspace
instead of touching a pre-existing one, and never uninstall an installation you did not create:

1. Open the org switcher, `Create workspace`, name it (the submit-button collision in
   `known-hazards.md` applies). Read its id from `convex data organizations_workspaces`.
2. Go to `/w/<org>/<scratch>/plugins/<plugin>`, `Install`, `Accept and install`. Read the new
   installation id from `convex data plugins_workspace_installations` — the newest row.
3. Mint a second API key on `/w/<org>/<scratch>/api-keys`. Keys are per workspace, so this one cannot
   reach the first workspace's installation.
4. Cross-name the installations. Both directions answer `404 Not found` on read, write and list. The
   owner passes every permission check, so that 404 can only come from the installation-tenant check.
5. Write a few documents under the scratch installation, snapshot the row counts, then `Uninstall` it
   from its plugin page. The drain finishes in seconds: poll until the scratch installation has zero
   rows in all five owned tables — `plugins_data`, `plugins_data_usage`, `plugins_data_reservations`,
   `plugins_data_revision_tombstones` and `plugin_service_grants` — and confirm the other
   installation's rows are untouched. Counting only the first four passes while grants survive.
6. Clean up: delete any QA documents under an installation you will keep, revoke both keys, and delete
	the scratch workspace through the switcher's `More actions for workspace: <name>` -> `Delete` (it
	deletes immediately, with no confirmation step). Do not call `/delete` for the scratch installation
	after uninstall; that installation and its plugin data are already gone.

The first accepted write **creates** a `plugins_data_usage` row for that installation, and deleting the
last document only zeroes it. A pre-existing installation may therefore keep one zeroed accounting row;
this is expected. Never call `drain_uninstalled_installation` to remove it from an installed or
pre-existing installation. That mutation does not check uninstall state. It deletes all five plugin-data
tables for the named installation, including live `plugin_service_grants`. For QA that needs a zero-table
readback, create a scratch installation and uninstall it through the product flow.
Verified 2026-08-15.

## Upload fixtures for file-view QA

The sandbox cannot read repo or personal-folder files, so an upload runner must embed its payload. Generate the runner from a fixture with PowerShell, then run it with `-f`:

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("path/to/fixture.mp4"))
Set-Content runner.js ("const FILE_B64 = `"$b64`";`n" + (Get-Content -Raw upload-template.js))
```

In the runner, target the hidden file input on the `/files` route:

```js
const input = state.page.locator('input[type="file"][aria-hidden="true"]');
await input.setInputFiles({ name: "fixture.mp4", mimeType: "video/mp4", buffer: Buffer.from(FILE_B64, "base64") });
```

## Publishing a plugin from a repository, end to end

The publisher route is `/w/<org>/<workspace>/plugins/publisher`. Claiming and publishing are two
separate steps and both are one click:

```js
await state.page.getByRole("textbox", { name: /GitHub repository URL/i }).fill(repoUrl);
await state.page.getByRole("button", { name: "Claim", exact: true }).click();
// The claimed card appears in the same list; its Publish button is the first one on the page.
await state.page.getByRole("button", { name: "Publish", exact: true }).first().click();
```

Keep the click in its own short eval and return immediately. A publish takes 60–120 seconds, and an
eval that polls for the result inside the browser crashes the relay (see `known-hazards.md`). Read the
outcome from the CLI instead — `lastPublishAttempt` on the repository row carries `status`, `message`,
`commitSha`, `artifactHash` and `reviewId`:

```powershell
vp env exec pnpx convex data plugins_publisher_repositories --limit 5
```

The plugin detail page shows the same thing in the release history, including the review verdict, for
example `data-probe@0.1.0 · published Aug 14, 10:32 AM · e0e7d066 · reviewed by gpt-5.4-mini · passed`.

A rejection can land in ~5 seconds instead of the usual 60–120s publish: the mechanical dist gate
(`plugins_dist_review_mechanical_findings` in `packages/app/shared/plugins.ts`) runs before the AI
review, and its rejecting findings (dense escapes, huge base64 literal, `Function` constructor) use
the same `Plugin review rejected this version: ...` message shape on the card. The attempt row then
has `status: "rejected"` with `commitSha: null`. This is deterministic per commit — do not retry the
same HEAD. Known real-world trigger: a bundled dependency's `new Function("")` feature-detection
(Zod v4 `allowsEval`) trips the case-sensitive `\bFunction\s*\(` check. When reproducing a finding
against the repo's dist yourself, remember PowerShell `-match` is case-insensitive by default and
over-reports lowercase `function (` lines.

## Triggering a plugin backend

Plugin backends run on `files.upload.completed`, and **a text upload does not trigger one**. An upload
whose name has a recognized editable-text extension (`.txt`, `.md`, `.json`, …) is converted into an
editable document, and `r2.ts` suppresses the plugin event on that path — only a stored blob dispatches,
and a blob a plugin service stored (a `plugin_service_storage_targets` row owns its asset) never does.
Use an image instead. A 1×1 PNG is enough and needs no fixture file:

```js
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const input = state.page.locator('input[type="file"][aria-hidden="true"]').first();
await input.setInputFiles({ name: `probe-${Date.now()}.png`, mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") });
```

Allow about 30 seconds after the upload: the R2 event, the conversion pass and the plugin dispatch are
all asynchronous. Then read `plugins_event_runs` to see whether the run happened and what it settled as.

`raythurnvoid/bonobo-plugin-data-probe` is the fixture plugin for plugin-data QA — its backend writes one
document per upload and its page lists them. Its page still runs a hand-vendored pre-0.8.0 bridge
(`fetchJson` reads, no `client.data.*`), and it works on the direct-Convex host — verified 2026-08-18
on 0.1.0 (`/w/personal/home/plugins/data-probe/pages/data-probe` renders "Recorded uploads (N)"). Do
not chase a "data-probe page hangs" report without re-checking it live.

## Council page smoke (page → Worker → Convex exchange)

The Council plugin page (`/w/<org>/<workspace>/plugins/council/pages/council`) proves the whole
service-connect auth chain: on load it POSTs to the Council Worker
(`https://bonobo-council-service.ray-thurne-void.workers.dev/api/meetings/list`), and the Worker trades
the page token for a service grant at Convex `/api/internal/plugins/service-grants/exchange`
(`plugins_service.ts`). An empty meetings list with no `role="alert"` is the pass signal.

- Capture the iframe's Worker calls with plain `state.page.on("request"/"response")` listeners on the
  HOST page, installed before navigating — Playwright page listeners see subframe fetches, including the
  sandboxed cross-origin plugin frame. No CDP session needed.
- The frame renders errors as a `role="alert"` with a `Retry` button. Read it with `frame.evaluate`
  (anchor the frame per the Gallery playbook).
- A first-open alert saying `Rate limit exceeded` is usually the host's `plugins_ui_session_mint`
  bucket (STRICT_WRITE: capacity 2, 12/min, keyed per user — the user's own open plugin tabs share it).
  Retry recovers in seconds; it is not a Worker or exchange fault.
- An alert naming the exchange (`Convex /api/internal/plugins/service-grants/exchange returned HTTP
  401`) means the Worker reached Convex and Convex refused. The exchange 401s for: wrong/unset
  `COUNCIL_SERVICE_EXCHANGE_SECRET`, bad bearer, dead page token. To check the deployment secret
  without ever printing it, probe its SHAPE: pipe `convex env get COUNCIL_SERVICE_EXCHANGE_SECRET`
  into a Node one-liner that prints only length, line count, and char classes. A value with an embedded
  newline can never match — HTTP headers cannot carry raw newlines and the stored value is compared
  untrimmed — so a 2-line value is proof of a mis-set env var (found 2026-08-15: 43 chars + trailing
  `\n`; `convex env list` shows such a value as a stray `'` continuation line).

## Council page: driving meeting creation

Drive the whole meeting loop with plain frame-handle clicks. Council 0.1.2+ renders every action as a
`type="button"` with an onClick handler, and the host added `allow-forms` to the plugin sandbox on
2026-08-16, so the dispatched-submit workaround in `known-hazards.md` ("Plugin UI frames: forms submit
in JS only") is needed only for an older plugin build served by a pre-fix host. Reach for it after a
click provably does nothing, not before.

- The create form's title field carries a React `useId` id (`P0-0`), not a stable `#meeting-title`. A
  guessed id selector never resolves and `fill()` burns the whole CLI timeout, which reads like a frozen
  frame. Use the label instead: `frame.getByRole("textbox", { name: /Meeting title/i })`. Enumerate
  `document.querySelectorAll("input")` ids before trusting any id-based selector in this frame.
  Verified 2026-08-16: even after that locator **resolves** to `#P0-0`, `fill()` can still hang on
  actionability inside the Convex `plugins-ui` iframe. Click the input, `Control+A`, then
  `pressSequentially` the title. Do not `{ force: true }`.
- Prefer `page.frameLocator(".PluginsUiFrame")` over `frames().filter(...).evaluate(...)` for later
  Council clicks. A plugin-frame `evaluate` during a remount dies with `Execution context was destroyed`
  and can take the CLI down with the libuv assertion. `Get room link` itself is a locator click; give
  it 10–15s, not 800ms retries that miss the remount window.
- The create response is the ONLY place the join code and guest link exist (`{meeting, joinCode, guestUrl}`;
  the service stores only hashes). Capture it with a host-page `state.page.on("response")` listener filtered
  on `/api/meetings/create`, park the values on `state`, and never print them — the meeting id is the one
  reportable field. Read success from the captured body, not the panel alone.
- Delete is a two-step inline confirm: `Delete` renders a `Confirm delete` / `Cancel` panel below the
  row while the original `Delete` button stays in place, so scope the second click by exact name. After
  confirming, a body-text check can race the follow-up
  `meetings/list` refresh — re-read the list a moment later before asserting the row survived. A
  no-recording meeting settles `Created → Open → Ready` within ~10 seconds of Close and writes no
  files, so it leaves no `/meetings/<id>` folder to clean up (verified 2026-08-16 from a real
  signed-in session).
- Council 0.1.6 accessibility anchors (verified 2026-08-16). The page keeps one permanently mounted live
  region as the last child of `.council`: `div.council-announcer.visually-hidden[role=status][aria-live=polite]`,
  empty on first load by design. It is written only when a list refresh sees a change, as
  `Meeting <title> is now <Status>`, `Meeting <title> was added`, or `Meeting <title> was deleted`.
  Capture its text with the MutationObserver recipe in
  `snippets.md` — a single poll misses it, since a refresh with no change writes `""` back. The delete
  confirmation moves focus to `Confirm delete`, which carries `aria-describedby` pointing at the warning
  paragraph, and `Cancel` returns focus to the row's `Delete` button; read `activeElement` in a **separate**
  execute call from the click, or the focus-moving effect has not run yet. The only other `[role=status]`
  in the frame is the transient copy-confirmation inside the join-code panel — the empty state
  (`.council-status`, "No meetings yet.") deliberately carries no role, matching the Gallery plugin.
- Deleting a meeting that never opened is the cheapest way to exercise both announcer branches
  (`is now Deleting`, then `was deleted`) and it self-cleans: no pipeline ran, so no `/meetings/<id>` folder
  is written, and D1 shows `status: "deleted_tombstone"` with `title` scrubbed within ~15 seconds.
- Guest join checks (verified 2026-08-16 on the status-specific guest-session messages): the guest link
  is `https://<council-worker>/room?m=<meetingId>` — a plain query param, no fragment — and the guest
  types the join code manually. The page is public (no app auth) and is NOT sandboxed, so normal fills
  and clicks work: `#guest-code`, `#guest-name` (email optional), `#guest-submit`, and refusals render
  inline in `#guest-error` (assert `textContent` + computed visibility, not a screenshot). After create,
  the row shows a one-time join-code panel that hides the status line — dismiss it with the
  `Done, I saved the code` button. Right after clicking `Delete`, a row-scoped `allTextContents` can
  transiently report both `Delete` and `Confirm delete` — just click `Confirm delete`.
- The list always polls every 5 s (`setInterval(refresh, 5000)` in `app.tsx`). Waiting for polling to
  stop never ends. A delete or a close settles in the open page with no reload because the next poll
  picks it up. A D1 `UPDATE` on a settled row also appears within one poll interval. Corrected 2026-08-16
  — earlier notes said the list does not poll, then that it polls only while transitional; both were wrong.
- The meeting row does NOT render the meeting id, so you cannot pick a row by id from the DOM. It shows
  only the title, the status label, and the action buttons (`Details` adds artifact `fileNodeId`s, still
  not the meeting id). To bind a row to an id, capture the `/api/meetings/list` response with a host-page
  `state.page.on("response")` listener and keep only `{id, title, status}` — that response also carries
  fields you must not store. Then match the row by its title. Verified 2026-08-16.
  Details lists each artifact as `name` plus a `.meeting-artifact-id` span whose text is ` · <fileNodeId>`.
  Strip the leading `·` and spaces before using that text as `?nodeId=`. Passing the raw span text
  navigates to `?nodeId=root` instead of the file. Verified 2026-08-16.
- Delete end state: `POST /api/meetings/delete` answers `200 {"status":"deleting"}`. That 200 means the
  delete was enqueued, not that the meeting is gone — do not treat Confirm delete as `was deleted`,
  and do not expect a `role="alert"` on that 200. The status label flips to `Deleting`. A happy-path
  meeting drops out of the list once D1 is `deleted_tombstone` (title scrubbed). A locked child file
  must fail visibly without unlocking: keep the lock, wait ~5 s, and assert the row is `Delete failed`
  with the failure reason on the row (`role="status"`). Unlocking first would hide the hang that Round
  2 found. Read-only ground truth: `vp env exec pnpx wrangler d1 execute bonobo-council --remote --json
  --command "SELECT id, status, title, failure_reason FROM meetings WHERE id = '<id>'"`. There is no
  `deleted_at` column — selecting one fails the whole query with `SQLITE_ERROR 7500`. Verified
  2026-08-16 on a `ready` meeting with a real recorded transcript.
- Recorded-meeting host-only E2E (verified 2026-08-16): create/open via the page UI, then join the room
  in a scratch Chrome launched with `--use-fake-ui-for-media-capture --use-fake-device-for-media-capture
  --use-file-for-fake-audio-capture=<wav> --autoplay-policy=no-user-gesture-required` plus a scratch
  `--user-data-dir` and `--remote-debugging-port=9223` (`session new --direct 127.0.0.1:9223`). Mint the
  room ticket only AFTER that browser is up (2-minute TTL). Two verified handoffs (2026-08-16): a fresh
  direct-CDP session can list the launched tab as one page with an EMPTY url (`context.pages()` →
  `[""]`) — bind `pages()[0]` and `goto` the target instead of matching by URL. And to move the
  single-use host room link across browsers without printing or storing it: in the Edge frame click
  `Get room link`, read the `.meeting-room-link input` value, `navigator.clipboard.writeText(value)`
  from the HOST page (extension mode allows the write); in the scratch session
  `grantPermissions(["clipboard-read"], { origin })` (works in direct CDP), park the scratch tab on
  `/room?m=<id>` first
  (real origin for the grant, and the query makes the later hash-carrying `location.assign` a full
  document load that consumes the ticket), then read the clipboard in-page and `location.assign` it;
  clear the clipboard afterwards. The link never appears in CLI output or on disk.
  Direct-CDP `grantPermissions(["clipboard-read"])` works on the Worker origin; `clipboard.writeText` there throws `NotAllowedError`. Copy join codes and room links from the app host page (extension mode), then only *read* them in the scratch session. Clear the clipboard from the host page afterwards.
  Do not Join from the Edge QA profile: `grantPermissions` cannot grant the microphone there, the
  permission prompt wedges `getUserMedia`, Join stays disabled, and later Council iframe CDP calls
  hang. Keep Edge on the Council page only. Join in the scratch Chrome.
- Hashchange after Join (Round 3 L4-H1, verified 2026-08-16): park-then-assign **before** Join does
  not cover this. Join until `#view-call` is visible, mint a **fresh** host ticket from Council, copy
  it from the app host page, then `location.assign` that URL on the **same** scratch-Chrome room tab.
  Do not hop `about:blank` first — that hides the bug. Success is `#view-lobby` visible, `#view-ended`
  hidden, `#join-button` enabled, role Host, hash erased. Join again on that lobby to prove the button
  was re-armed.
  Chrome 151 on this machine still lists the real microphones when launched with `--use-fake-device-for-media-capture` and a 48 kHz stereo fake-audio WAV. `getUserMedia` then captures the default hardware device, not the file. Call `context.grantPermissions(["microphone"], { origin })` before Join or Unmute, or `getUserMedia` returns `NotAllowedError`. Treat missing phrase attribution after that as an environment/provider blocker, not as proof the lobby names failed — the transcript still carries the typed display names.
  ~30 seconds of looping speech WAV produces a real `transcript.md`. Processing can take ~5 minutes when the best-effort provider-transcript polling
  runs its sleeps, and `provider-transcript.json` may legitimately never appear — poll the D1
  `meetings.status` (read-only `wrangler d1 execute bonobo-council --remote`) instead of trusting a
  3-minute budget. The list always polls every 5 s, including after a D1 `UPDATE` on a settled row —
  see the polling hazards bullet above. Do not reload the host page to pick up that change.
- Since the 2026-08-16 upload-conversion change, the pipeline's `transcript.md` becomes a normal
  editable rich text document (`yjsRootKind: "rich_text"`, chunk-readable) and a produced
  `provider-transcript.json` becomes an editable plain-text document; the `.webm` track files stay
  stored blobs. Deleting a meeting archives the whole `/meetings/<meetingId>` folder through the
  service `archive-destination` door and tombstones the D1 row. Check it by reading the file nodes,
  not the tree alone: the folder and every file in it get ONE shared `archiveOperationId`, so they
  leave the active tree together and a member can restore them. Their bytes stay charged, and the R2
  objects stay — that is the archive working, not failed QA cleanup.
- A create failure renders only as a `role="alert"` inside the frame with the Worker's generic message.
  `Failed to reserve storage for the meeting` (HTTP 502) wraps ANY non-auth Convex `plugin-data/reserve`
  refusal: `convex_post` in `packages/council-service/src/convex-api.ts` collapses every non-401/403/404/409/429
  status to `refused`, the route maps that to 502, and neither side logs the underlying reason —
  `wrangler tail` shows `logs: []` and `convex logs` shows nothing. Diagnose by reading the reserve args in
  `routes-page.ts` against the caps in `packages/app/convex/plugins_data.ts` (`MAX_RESERVATION_TTL_MS`,
  `MAX_VALUE_BYTES`, name rules) instead of retrying.

## Chitchat page smoke (channels + messages)

The Chitchat plugin page (`/w/<org>/<workspace>/plugins/chitchat/pages/chat`) drives cleanly with
plain `page.frameLocator(".PluginsUiFrame")` clicks — no dispatched-submit workarounds needed.
Chitchat 0.1.5 (published 2026-08-18) changed no page behavior — it repointed the SDK pin to 0.9.1
(transient-retry JWT exchange) and rewrote stale source comments — so the 0.1.4 recipes below hold.
Verified 2026-08-17 on chitchat@0.1.0:

- Empty state body text: `No channels yet — create the first one.`
- `Create channel` opens an inline dialog (`Channel name` text input, `Cancel` / `Create`); the new
  channel renders as `#<name>` in the list and opens itself.
- The composer is a `textarea` with `aria-label="Message #<channel>"`; `pressSequentially` the text
  and press `Enter` to send (`Enter sends · Shift+Enter for a new line`). The sent message renders
  with author display name and a locale timestamp.
- **Capabilities are shown as friendly labels in both places, not as raw ids.** The install consent
  dialog and the detail page's Capabilities section both render `format_capability_label(capability)`
  (`$pluginName.tsx`), and both keep the raw manifest id reachable as the `title` tooltip on the same
  row. So `plugin.data.read` reads as `Plugin Data Read` on screen. Three ids do not follow that
  title-case rule at all — they have written-out labels: `workspace.files.create-read-only` →
  `Create read-only workspace files`, `plugin.data.user-write` →
  `Write its plugin data as the acting member, from its pages and file views`, and `ui.outbound.fetch`
  → `Call allowed outside origins from its pages and file views`. Never locate a capability row by its
  raw id text; match the label, or read the `title` attribute.
  (Corrected 2026-08-23 by reading `$pluginName.tsx`. Source-read only — not re-driven in a browser,
  because no server in this tree serves the app.)

Threads (verified 2026-08-17 on chitchat@0.1.2):

- Message rows are `li.message`; their action buttons (`Reply in thread`, `Add reaction`, `Edit`,
  `Delete`) are hover-revealed — a direct click fails with "`li.message` intercepts pointer events".
  Park the pointer away, `row.hover()`, then click the button scoped to that row.
- Once a message's thread has replies, `Reply in thread` is REPLACED by an `N replies` button — a
  locator on the old name waits forever. Enumerate the row's buttons when a name stops matching.
- The thread panel's composer (`textarea[aria-label="Reply in thread"]`) comes BEFORE the channel
  composer (`Message #<channel>`) in DOM order, so `locator("textarea").last()` posts to the CHANNEL.
  Target by aria-label. Deleting a mis-sent message is a two-step confirm (`Delete` → dialog
  `Delete message`) and leaves a "Message deleted" placeholder row.

Windows and CAS (verified 2026-08-17, two-user E2E on 0.1.3):

- Reads are reactive document windows since 0.1.3: opening a 200+ message channel renders exactly
  the newest 100 rows with a `Load older` button; each click adds up to 100 older rows (`fetchJson`
  is not involved — the HTTP paging path is gone), and the button disappears at full history. A
  remote arrival appends without collapsing loaded history. Since 0.1.4 the windows run inside the
  page on the SDK's own ConvexClient — there is no data bridge to observe (see below).
- Channel rename/archive are hover-revealed row actions: `li.channel-item` holds
  `aria-label="Rename #<name>"` / `"Archive #<name>"` buttons. Rename is compare-and-set: save from
  a dialog opened before someone else's rename keeps the dialog open with a `role="alert"` reading
  `Someone else changed this channel while the dialog was open. Close it and try again.` The winner's
  name stays in the list.
- A reply badge reads `1 reply` / `N replies` (the `1 replies` wording was fixed in 0.1.4 —
  verified live). Reactions and reply counts on rows deep beyond the newest-100 update live on both
  sides once each side has extended its own window with `Load older`.
- The hidden polite announcer (`.chitchat-announcer`) makes `getByText("<message text>")` resolve to
  TWO elements right after a remote arrival (the row and the announcer) — scope text asserts to
  `li.message` or `.message-text`.
- Reaching the plugin iframe: use
  `state.page.frames().filter(f => f.url().includes("/plugins-ui/")).pop()`. Take the LAST match —
  stale Playwright frame references linger after the host remounts the iframe (a `.first()` frame
  can hang every locator call until the execute timeout). One `<iframe>` element in the DOM with two
  reported frames is that artifact, not a leaked node.
- Since 0.1.4 there are no `bonobo:data-*` messages, so the old crafted-message bridge recipe is
  gone; window payloads are not observable via postMessage in either direction. Refusal reasons
  (`capacity`/`invalid`; `budget` is retired) live in the SDK's own suite
  (`packages/bonobo-plugin-sdk/frontend.test.ts`). To prove bridge absence: install a top-window
  `message` listener recording `event.data.type` (in `page.evaluate` — a `page.goto` wipes it, so
  remount the frame with SPA sidebar navigation instead), then drive sends and deliveries; expect
  `bonobo:ready` (positive control: the handshake still uses postMessage) and zero
  `bonobo:data-*` entries. Verified 2026-08-18 on 0.1.4.
- Session revocation break-test (verified 2026-08-18): list `plugins_ui_sessions` for the newest
  session, find the member's `organizations_workspaces_users` id, then call the host's own
  revocation door through the app's authed client from the HOST page context —
  `state.page.evaluate` with `const { app_convex } = await import("/src/lib/app-convex-client.ts")`
  and `const { api } = await import("/convex/_generated/api.js")`, then
  `app_convex.mutation(api.plugins_ui.revoke_ui_session, { membershipId, sessionId })` (Vite serves
  the same module singletons the app runs). Within seconds the revoked tab renders "Access to this
  plugin's data ended…" with the composer disabled while other tabs stay live (one session per
  mount, 1:1 — verified); a reload mints a fresh session and recovers. Since the host's
  sleep-recovery change (2026-08-18) the tab also recovers on its own: when the page's ConvexClient
  refetches its JWT (~10 min after boot), the refresh chain hits the gone session, the host gets
  "Unauthorized" and remounts the frame with a fresh session and nonce — verified live (revoke →
  dead state → one auto-remount ~9 min later, exactly one new session doc, no loop). To watch it,
  poll the iframe `src` fragment for a `bridgeNonce` change instead of holding a frame reference.
- The composer swallows Enter while a send is in flight and keeps the unsent text in place. For
  scripted sends, wait for the composer to empty between messages; a single composer maxes out
  around 3 sends per 10 seconds, below the write bucket's refill, so UI-driven sending cannot trip
  the `plugins_data_page_user_write` bucket.

Deeper driving anchors (verified 2026-08-17, two-user E2E on 0.1.0):

- Message rows are `li.message[data-key]`; per-row actions (`Reply in thread` / `Add reaction` /
  `Edit` / `Delete`) live in `.message-actions`, which is `display:none` until the row is hovered
  or contains focus — `row.hover()` before clicking, or focus a reaction chip. Keyboard-only:
  in 0.1.0 a plain row had zero focusable children (actions Tab-unreachable); fixed in 0.1.1
  (`opacity:0`/`pointer-events:none` keeps the buttons in the tab order — Shift+Tab from the
  composer lands on the newest row's Delete first).
- Reaction palette: `role="group"` `aria-label="Choose a reaction"`, items
  `.reaction-palette-item`; arrows rove, Escape returns focus to `Add reaction`. Chips are
  `button.reaction-chip[aria-pressed]` labeled `"<Token>, N reaction(s)"`.
- Delete dialog: `role="dialog" aria-modal="true"`, initial focus on Cancel, Tab trap holds,
  Escape returns focus to the row's Delete button.
- 0.1.0-only bug (fixed in 0.1.1, re-verified 2/2): ANY remote arrival (or reconnect) rebuilt the
  message store and collapsed `Load older` history back to the newest-100 window. On 0.1.0
  fixtures, do pagination assertions before generating new traffic; 0.1.1+ accumulates correctly.
- Removing the second user from the org kills the HOST route reactively ("You do not have access
  to this organization/workspace.") and unmounts `.PluginsUiFrame` entirely — the plugin-level
  dead state (since 0.1.4 a watch dying to null on the page's own Convex client) never renders for
  org-membership revocation. Use the session revocation break-test above for a narrower kill.

## Reading a table count without fooling yourself

`convex data <table>` prints "There are no documents in this table" for a table that does not exist, so
a misspelled name reads exactly like a clean zero. Count rows by the quoted id at line start, and run
**two** controls in the same pass: one table name that cannot exist (must be 0) and one you know is
populated (must not be 0).

```bash
for t in plugins_data plugins_data_usage totally_bogus_table_xyz plugins_workspace_installations; do
	printf "%-36s " "$t"; vp env exec pnpx convex data "$t" --limit 200 2>&1 | grep -c '^"'
done
```
