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

- **Read the installed version before you QA anything.** Publishing a version does not upgrade an
  installation — nothing does, until someone clicks `Update`. On 2026-09-01 the QA org still ran
  council 0.2.2 a day after 0.2.3 became `isLatest`, so a Council check there was measuring the old
  plugin and reading as a pass. The detail page shows `Installed version x.y.z` under the version
  heading whenever the two differ; from the CLI, compare `plugins_workspace_installations
  .pluginVersionId` with the `isLatest` row for that name. The consent modal on the update names what
  changed — for 0.2.3 it flagged `https://council.bonobo-senate.com` as a new UI outbound origin.
- Install: click `Install` (`exact: true`), then the consent modal's `Accept and install`.
- Update: click `Update` (`exact: true`), then `Accept and update`. Match `/Accept and (install|update)/` when the flow may be either.
- Uninstall: `Uninstall` (`exact: true`) applies immediately — there is no confirm dialog.
- The `plugins_manage` rate limiter is a token bucket (capacity 2, ~6/min). Space install/uninstall/update mutations ~15 seconds apart, or the next mutation fails.
- Before clicking, check that no open dialog backdrop covers the page. The org/workspace switcher is a frequent blocker — close it with its own `Cancel`. Do not treat `querySelector('[role="dialog"]')` as proof a dialog is open (see `known-hazards.md`: many dialogs stay mounted while closed).
- **Post-update tell (verified 2026-08-25):** the `Installed version x.y.z` line renders only while the installed version differs from the latest. After a successful update it DISAPPEARS — a poll waiting for `Installed version <new>` never resolves and reads like a hung update. Assert instead on the consent modal closing plus the `Update` button being gone (only `Uninstall` remains), then confirm from the CLI: the workspace's `plugins_workspace_installations` row flips `pluginVersionId` to the new version id, and the plugin frame's URL / `.PluginsUiFrame` src carry that id (`/plugins-ui/<versionId>/...`).
- **Consent modal audit anchors (verified 2026-08-25):** the dialog is `.RoutePluginsPluginConsentModal` (audit by that class, never `[role=dialog]`). Accessible name comes from the `MyModalHeading` via `aria-labelledby` — `"<Install|Update> <displayName>"` — and the description from `MyModalDescription` (`<name>@<version> · <publisher>`). Its 3 controls are `Cancel`, `Accept and <install|update>`, and `Close`. Initial focus lands on `Cancel`; `Escape` closes and returns focus to the page's `Install`/`Update` trigger. The capabilities list always shows the FULL grant surface; the consent diff renders only as `new` badges on added rows (`consentDiff` in `$pluginName.tsx`), so for an update with no new grants the pass condition is zero badges in `.RoutePluginsPluginConsentModal-item` — there is no "no new permissions" sentence. Each capability row keeps the raw manifest id in its `title` attribute.

## Publisher pages

After a successful publish, the publisher card turns into a link to the plugin detail page. The `Publish` button for a republish lives on the detail page, not on the card.

The claim form's submit button is named `Claim` (`exact: true`) — there is no button named "Claim repository".

**Publish when the QA Edge profile is signed out of Clerk (verified 2026-08-25).** Only the claim owner sees `Publish` on the detail page. An anonymous tab minted in that profile cannot publish. Do not sign the user into Clerk there. Use the Convex CLI recipe in `snippets.md` with `--identity` whose `external_id` is the claim's `ownerUserId`. First read the candidate HEAD. Check that exact SHA through an independent source, then pass it to `plugins:publish_version` as `expectedSourceCommitSha`. That path still reviews, uploads to R2, and marks the version `ready` / `passed`. After it returns a `pluginVersionId`, wait until `sourceStatus` is `ready` and `reviewStatus` is `passed` before installing. A publisher-rate-limit wait is not needed when the installer is a different user than the publisher.

A CLI `install_version` does not refresh an already-open plugin frame. Reload the plugin page tab, then wait for `/plugins-ui/` again. Verified 2026-08-27 on Council after upgrading `0.2.0` to `0.2.1`.

**Publish confirmation dialog anchors (fresh build, verified 2026-08-30 on the redeployed Pages host).** The detail-page Publish button's accessible name is `Publish <owner>/<repo>` (aria-label), so `getByRole("button", { name: "Publish", exact: true })` matches nothing — use the full name or a non-exact match. Clicking it opens `.PluginPublishConfirmationModal`: heading `Publish <owner>/<repo>`, a read-only "Current default-branch HEAD" SHA (from `get_publish_candidate_head`), a `Reviewed commit SHA` textbox, `Cancel`, and `Publish reviewed commit`. The modal is MOUNTED WHILE CLOSED, so its `Publish reviewed commit` button appears (hidden) in DOM dumps before any click — check visibility before concluding the dialog is open. `Cancel` closes it without any mutation; the preflight HEAD read is safe. Also: on the Pages host every deep-link document request logs `Failed to load resource ... 404` in the console — that is GitHub Pages' 404.html SPA fallback booting the app, not an app error.

**The GitHub Pages host can serve a frontend older than the deployed backend, and its Publish button then cannot publish at all.** Verified 2026-08-30: the deployed bundle predated the SHA-confirmation dialog, so `Publish` called `plugins:publish_version` with only `{repositoryId}` and the backend refused with `ArgumentValidationError: missing expectedSourceCommitSha` — no dialog ever opens, the page shows nothing (the error is only in the console), and the click itself LANDS, so a focus+Enter "retry" just logs a second refused attempt. Arg validation runs before the handler, so these refused attempts publish nothing. Recovery: the signed-in CLI recipe above (`plugins:get_publish_candidate_head` → verify the SHA independently, e.g. `git ls-remote` → `plugins:publish_version` with `--identity` on the claim's `ownerUserId`). The update/consent flow on that same stale frontend works fine.

## Publishing a QA fixture plugin without GitHub

When a check needs a plugin with an arbitrary manifest (for example specific `secrets[]` declarations), publishing through GitHub is overkill. Claim a fake repository URL through the publisher UI as the signed-in user, then register the version with the operator-invokable internal mutations from the CLI (see the CLI recipe in `snippets.md` for the command wrapper and the JSON5 args syntax):

1. In the browser, claim a unique URL like `https://github.com/<user>/qa-health-<date>` with the `Claim` button.
2. Read the new claim's `_id` and `ownerUserId` back with `convex data plugins_publisher_repositories` — do not trust an older seeded claim, the owner differs.
3. Run `plugins:upsert_plugin` with the manifest fields (pass `createdBy` = the claim's `ownerUserId` so publisher-tier rules match), then `plugins:finalize_plugin_version` to flip it `ready`.
4. Cleanup: uninstall from every workspace, then run `plugins:hard_delete_plugin_from_registry "{pluginName:'<name>'}"` repeatedly until it returns `done: true`, and check the claim is gone from `plugins_publisher_repositories`.

## Checking an UNPUBLISHED plugin build in the real frame

Verified 2026-08-24 on Chitchat. Publishing is gated, so a working-tree build has to reach the
browser some other way. There are two doors: the app's dev override (simplest; needs one Convex
variable to give the page working data) and swapping the served bytes at the published URL (exact
production CSP and headers).

**The app's own dev override gives the page working data by itself since SDK 0.11.0.**
`VITE_PLUGIN_UI_DEV_VERSION_ID` + `VITE_PLUGIN_UI_DEV_ORIGIN` in `packages/app/.env.local` really do
point one plugin's frame at a local dev server, and the bridge hands that frame its session token
together with its plugin-session JWT, so the frame's own Convex client authenticates from the init
message. A frame on an SDK older than 0.11.0 exchanges the token at the **asset** origin's
`/plugins-ui/session-jwt` instead, which is same-origin only for a published bundle. From a dev
origin that POST is cross-origin, and the route refuses it on purpose (`plugins_ui.ts`: it must
never gain CORS headers). Such a frame loads and shows its access-ended state: fine for markup, CSS
and layout, not for anything that reads plugin data.

For that older SDK, set the matching Convex env var once per dev deployment:
`convex env set PLUGINS_UI_DEV_EXCHANGE_ORIGIN http://localhost:5174` (the same bare origin as
`VITE_PLUGIN_UI_DEV_ORIGIN`). The exchange then accepts exactly that origin, answers its preflight,
and the frame's own Convex client authenticates. Unset the variable to return to production
behavior. The published-URL swap below still matters when you need the real CSP or want to check
the page under production's exact response headers.

**Swap the bytes at the published URL instead.** The frame keeps the asset origin, so the exchange,
the capability consent, the version binding and session revocation all behave exactly as in
production — only the body of the frame's own navigation response changes.

That last word matters: `page.route` sees the frame's navigation request and **nothing else**. The
`assets/index.js` and `assets/index.css` requests the frame makes next are subresources of an
out-of-process iframe and never reach the handler, so serving a working-tree `index.html` leaves
the published bundle running behind it, silently (`known-hazards.md`). Inline both assets into the
served HTML instead.

1. Build the plugin, then serve `dist/frontend` with a plain static `node:http` script. Do **not**
   use the plugin's Vite dev server: it transforms those files (see `known-hazards.md`).
2. Read the published response headers once with `curl -D -` and copy the `content-security-policy`
   verbatim into the runner, so the frame runs under the real policy. Add one thing to it: the
   `sha256-` of the inline script, hashed over the exact bytes placed between the tags. Do not add
   `'unsafe-inline'`, which would run the frame under rules the real one does not have.
3. Install `page.route` on `/plugins-ui/<versionId>/` **before** the tab ever opens the plugin page
   — once the out-of-process frame is attached, `page.route` fails and only `session reset` clears
   it (`known-hazards.md`). Fetch the bodies into memory first and `route.fulfill` from there;
   never `route.fetch()`. Record every request the handler saw in `state`, so a swap that was never
   asked for is visible instead of being read as a load that went fine.
4. Prove the swap took, rather than assuming it: pick a string that exists in the working-tree
   bundle and not in the published one, and read it back **from the browser**, not from disk. A CSS
   selector is the cheapest proof, because the CSSOM answers directly:
   `[...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => r.selectorText)`.

**The same route can shrink a cap so a limit is reachable.** A "you are seeing only the first N"
notice normally needs N+1 documents. Patching the served bytes — `limit: 100` to `limit: 3` —
reaches the same code path with five. Assert on the anchor being unique before replacing it, and say
in the report that the cap was patched. The same trick gives a real break-on-purpose: serve the
bundle again with the fix's own line reverted and watch the notice disappear while the data is
unchanged.

A working runner lives at
`t3-chat-+personal/+ai/chitchat-slack-planning-2026-08-23/runners/swap-plugin-bundle-v3.js`. Its v1
and v2 siblings are the versions that served the published bundle without saying so — keep them
only as the record of that failure.

## Manage secrets dialog

Two ways in. An **installed** plugin that declares `plugin.secrets.read` (`video` does,
`video-player` does not) gets the `Workspace secrets` panel. The plugin's **publisher** always gets
the section and a usable `Plugin secrets` panel, with no installation and no `plugin.secrets.read` at
all — and since the QA account publishes the first-party plugins, that is the common case here. When
both apply the dialog grows a `Secret scope` tab list, and the per-row delete reads
`Delete plugin secret <NAME>` on the publisher tab. The panel is `.RoutePluginsPluginSecrets`; open
the dialog with the `Manage secrets` button.

Inside the dialog the Name field is `input[placeholder=OPENAI_API_KEY]` — the placeholder is a
literal example, not the stored secret. Buttons are `Save`, `Close`, and one
`Delete workspace secret <NAME>` per stored secret. Scope with
`locator("[role=dialog]").filter({ hasText: "Manage secrets" })`; many dialogs stay mounted while
closed on this route.

To drive the **batch** (`.env`) import path, write the KEY=value text to the clipboard and paste into
the **Name** field. A paste into **Value** runs the same batch import when the text parses as `.env`
— including the `A=1\nB=2` fixture below. Value only refuses multi-line text (`Multi-line values are
not supported`) when the parse fails, so use text that is not `KEY=value` to drive that refusal:

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
// An action since 2026-09-02: the mint signs the plugin-session JWT, which a mutation cannot do.
const minted = await app_convex.action(app_convex_api.plugins_ui.mint_file_view_session, {
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
   rows in all twelve installation-scoped tables the drain walks — `plugins_ui_sessions`,
   `plugins_data_reservations`, `plugins_data_append_replay_receipts`,
   `plugins_data_revision_tombstones`, `plugins_data`, `plugin_service_grants`,
   `plugins_file_access_bindings`, `access_control_permission_grants` (`resourceKind:
   "plugin_scope"`), `plugins_data_scopes`, `plugins_data_released_scope_ranges`,
   `plugins_data_member_usage`, `plugins_data_usage` — and confirm the other installation's rows are
   untouched. Counting a subset passes while scopes, grants, bindings, or receipts survive.
6. Clean up: delete any QA documents under an installation you will keep, revoke both keys, and delete
	the scratch workspace through the switcher's `More actions for workspace: <name>` -> `Delete` (it
	deletes immediately, with no confirmation step). Do not call `/delete` for the scratch installation
	after uninstall; that installation and its plugin data are already gone.

The first accepted write **creates** a `plugins_data_usage` row for that installation, and deleting the
last document only zeroes it. A pre-existing installation may therefore keep one zeroed accounting row;
this is expected. Never call `drain_uninstalled_installation` to remove it from an installed or
pre-existing installation. That mutation does not check uninstall state. It deletes all twelve
installation-scoped tables listed above, including live `plugin_service_grants` and the plugin's
private scopes and their member grants. For QA that needs a zero-table
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

The publisher route is `/w/<org>/<workspace>/plugins/publisher`. Claiming and publishing are separate
steps. Claim the repository, then open the reviewed-commit dialog:

```js
await state.page.getByRole("textbox", { name: /GitHub repository URL/i }).fill(repoUrl);
await state.page.getByRole("button", { name: "Claim", exact: true }).click();
// The button's accessible name includes the repository, for example `Publish octo/new-plugin`.
await state.page.getByRole("button", { name: /^Publish / }).first().click();
```

The app reads the candidate default-branch HEAD before it opens `Publish <owner>/<repo>`. Initial
focus is on `Cancel`. Paste the exact lowercase 40-character SHA shown under `Current default-branch
HEAD`. A wrong SHA shows an alert and keeps `Publish reviewed commit` disabled. The exact SHA enables
it.

Opening and filling the dialog is read-only. Do not click `Publish reviewed commit` in a live QA run
unless the release is approved. A safe routed-bundle fixture may hold the publish call open to check
the pending state. While it is pending, `Cancel`, `Close`, the SHA field, and the publish action must
be disabled. `Escape` and an outside click must not close the dialog, and keyboard focus must stay
inside it. On the plugin detail page, that pending publish must also disable Install/Update,
Uninstall, and Remove claim. A pending install or uninstall must disable Publish and Remove claim;
the active action's own control stays enabled so focus is not lost.

When a real release is approved, keep the final click in its own short eval and return immediately. A
publish takes 60–120 seconds, and an eval that polls for the result inside the browser crashes the
relay (see `known-hazards.md`). Read the outcome from the CLI instead — `lastPublishAttempt` on the
repository row carries `status`, `message`, `commitSha`, `artifactHash` and `reviewId`:

```powershell
vp env exec pnpx convex data plugins_publisher_repositories --limit 5
```

The plugin detail page shows the same thing in the release history, including the review verdict, for
example `data-probe@0.1.0 · published Aug 14, 10:32 AM · e0e7d066 · reviewed by gpt-5.4-mini · passed`.

**A publish that fails with a bare `Error` is often just the review timing out, and the retry works.**
Verified 2026-09-01 on Chitchat 0.6.1: the CLI `plugins:publish_version` printed only `Error`, and the
reason was on the repository row's `lastPublishAttempt` — `"Plugin review did not finish within its
time limit; try again"`. Re-running the exact same call published the version. So read
`lastPublishAttempt.status` and `.message` before concluding anything about the build, and do not
change the manifest or the commit between attempts. This is a different case from the rejection below,
which is deterministic per commit and must not be retried.

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
(`fetchJson` reads, none of the SDK data wrappers that 0.13.0 later deleted), and it works on the direct-Convex host — verified 2026-08-18
on 0.1.0 (`/w/personal/home/plugins/data-probe/pages/data-probe` renders "Recorded uploads (N)"). Do
not chase a "data-probe page hangs" report without re-checking it live.

## Council page smoke (page → Worker → Convex exchange)

The Council plugin page (`/w/<org>/<workspace>/plugins/council/pages/council`) proves the whole
service-connect auth chain: on load it POSTs to the Council Worker
(`https://council.bonobo-senate.com/api/meetings/list` since plugin 0.2.3), and the Worker trades
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
  401`) means the Worker reached Convex and Convex refused. The exchange 401s for: a Worker-side
  `COUNCIL_SERVICE_EXCHANGE_SECRET` that does not hash-match the publisher's service registration, a
  bad bearer, or a dead page token. Since the registration migration there is NO Convex env var to
  check: `plugins_service_registrations` stores only the SHA-256 hash of the registered secret, and
  the old `convex env get COUNCIL_SERVICE_EXCHANGE_SECRET` shape probe is gone with the env var. A
  value with an embedded or trailing newline can never match — HTTP headers cannot carry raw
  newlines and the presented value is hashed untrimmed — so on a stubborn 401, re-run
  `wrangler secret put` for the Worker secret rather than probing Convex (the 2026-08-15 incident
  was exactly a 2-line value: 43 chars + trailing `\n`).

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
  The submit control's accessible name is `Create meeting`, not `Create`.
  `getByRole("button", { name: /^Create$/ })` never matches and hangs until the CLI timeout.
  Use `/Create meeting/i`. Verified 2026-08-27.
- Prefer `page.frameLocator(".PluginsUiFrame")` over `frames().filter(...).evaluate(...)` for later
  Council clicks. A plugin-frame `evaluate` during a remount dies with `Execution context was destroyed`
  and can take the CLI down with the libuv assertion. `Get host room link` itself is a locator click; give
  it 10–15s, not 800ms retries that miss the remount window.
- The create response is the ONLY place the join code and guest link exist (`{meeting, joinCode, guestUrl}`;
  the service stores only hashes). Capture it with a host-page `state.page.on("response")` listener filtered
  on `/api/meetings/create`, park the values on `state`, and never print them — the meeting id is the one
  reportable field. Read success from the captured body, not the panel alone.
- The one-time join code is only in `section.created-panel`. `li.meeting` rebuilds the guest link and
  never has the code. Reading the row first looks like the invite is gone. Verified 2026-08-27.
- On the GitHub Pages app origin, `navigator.clipboard.writeText` from `page.evaluate` can hang until
  the CLI timeout (it does not always reject). Copy with a host-page textarea and
  `document.execCommand("copy")`. Scratch Chrome only *reads* the clipboard, on the Worker origin.
  Verified 2026-08-27.
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
  `Done, I saved the invite` button. Right after clicking `Delete`, a row-scoped `allTextContents` can
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
  `Get host room link`, read the `.meeting-room-link input` value, `navigator.clipboard.writeText(value)`
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
  Chrome 151 on this machine still lists the real microphones when launched with `--use-fake-device-for-media-capture` and a 48 kHz stereo fake-audio WAV. `getUserMedia` then captures the default hardware device, not the file. Call `context.grantPermissions(["microphone"], { origin })` before Join or Unmute, or `getUserMedia` returns `NotAllowedError`. Treat a missing spoken phrase after that as an environment/provider blocker, not as proof Join failed. Composite transcripts label every line `Meeting`. They do not use the typed lobby names.
- Live share smoke on Chrome 151 (verified 2026-08-27). `sdk.self.enableScreenShare()` follows the
  desktop-capture picker. `--auto-select-tab-capture-source-by-title=<fixture-title>` did not pick
  the tab. `--auto-select-desktop-capture-source` is a substring match; when nothing matches, this
  machine captured DISPLAY1 (`1680x1050` at `X=-1680`). Do not set both flags. After Share is
  pressed, read host `#share-video` `videoWidth`/`videoHeight`. If that size is a monitor, move the
  fixture Chrome onto that monitor and pin it topmost (`HWND_TOPMOST`) so the live share shows the
  fixture text. Unpin when the meeting ends. Prove the host stage shows the fixture *before*
  recording. Chrome's floating Stop sharing bar ends the capture without clicking Share. After that
  stop, `#share-button` must have `aria-pressed="false"` even though `toggleScreenShare` did not
  run. A failed in-app stop must not say to check the screen-share permission. `assets/files/speakers.wav` is documented but may be absent; generate a short speech
  WAV into `../t3-chat-+personal/+ai/` with Windows SAPI. Files toolbar Download of `recording.mp4`
  lands in the QA Edge Downloads folder. Playwriter `download.saveAs` fails here because the relay
  artifact path is already gone. Do not call `window.getScreenDetails()` from the fixture; it opens
  a "Manage windows on all your displays" prompt on the captured screen.
- `auditAccessibility({ frame })` needs a Playwright `Frame` from `page.frames()`. See the
  FrameLocator hazard in `known-hazards.md`. Re-hit 2026-08-27 on Council.
  ~30 seconds of looping speech WAV produces a real `transcript.md`. Processing can take ~5 minutes when the best-effort provider-transcript polling
  runs its sleeps, and `provider-transcript.json` may legitimately never appear — poll the D1
  `meetings.status` (read-only `wrangler d1 execute bonobo-council --remote`) instead of trusting a
  3-minute budget. The list always polls every 5 s, including after a D1 `UPDATE` on a settled row —
  see the polling hazards bullet above. Do not reload the host page to pick up that change.
- Since the 2026-08-16 upload-conversion change, the pipeline's `transcript.md` becomes a normal
  editable rich text document (`yjsRootKind: "rich_text"`, chunk-readable) and a produced
  `provider-transcript.json` becomes an editable plain-text document; the recording files stay
  stored blobs. Deleting a meeting archives the whole `/meetings/<meetingId>` folder through the
  service `archive-destination` door and tombstones the D1 row. Check it by reading the file nodes,
  not the tree alone: the folder and every file in it get ONE shared `archiveOperationId`, so they
  leave the active tree together and a member can restore them. Their bytes stay charged, and the R2
  objects stay — that is the archive working, not failed QA cleanup.
- A create failure renders only as a `role="alert"` inside the frame with the Worker's generic message.
  `Failed to reserve storage for the meeting` (HTTP 502) wraps ANY non-auth Convex `plugin-data/reserve`
  refusal: `convex_post` in `packages/council/src/convex-api.ts` collapses every non-401/403/404/409/429
  status to `refused`, the route maps that to 502, and neither side logs the underlying reason —
  `wrangler tail` shows `logs: []` and `convex logs` shows nothing. Diagnose by reading the reserve args in
  `routes-page.ts` against the caps in `packages/app/convex/plugins_data.ts` (`MAX_RESERVATION_TTL_MS`,
  `MAX_VALUE_BYTES`, name rules) instead of retrying.

## Colleague recording on the live Worker

Use this when a person wants a real call with guests and files in `/meetings/<id>/`. It is not the
fake-audio scratch-Chrome loop above.

- **Paid plan first.** Service uploads refuse Free and anonymous users (`This workspace's plan does
  not include plugin service file storage`). Only `Pay As You Go` and `Pro` store recording files. Prove it
  from the signed-in account: `app_convex.query(app_convex_api.billing.get_current_user_subscription)`
  is null for anonymous, and that session is treated as Free. Do not start a recorded call on the QA
  Edge anonymous tab and expect Files to fill.
- **Guests do not need app accounts.** Share the one-time join code plus the guest link
  (`https://<council-worker>/room?m=<meetingId>`). The default `personal` org cannot Invite members
  (`Users` → Invite is `aria-disabled`). If colleagues must also open the files in the app, create a
  non-personal organization, invite them there, install Council, and run the meeting in that
  workspace.
- **Save the join code before `Done, I saved the invite`, and before Open if you are driving the
  page from Playwriter.** The service stores only the hash. The open meeting card can rebuild the
  guest link, never the code. The yellow panel is React state in the plugin frame, so a frame
  remount (Retry, session lost, or a later Open click) wipes it. Copy join code to the clipboard
  and a note first. Then the member clicks Open.
- **Mint the host room link only when the host is ready to open it.** It is single-use and lasts two
  minutes. After create, the list card only has `Open meeting` and `Delete`. `Get host room link`
  appears only after `Open meeting`. Click `Get host room link`, copy it from the card, and open it
  in a **new tab**. Do not Join from the QA Edge profile (mic permission wedges `getUserMedia`). The
  human host may Join in their own browser; an agent Join still belongs in scratch Chrome.
- **A leftover host cookie must not open the wrong meeting.** One `__Host-council_session` cookie
  covers the whole Worker origin. The room page must name `?m=` on resume so a cookie from another
  meeting is refused and the guest form appears. If the served `council-room-revision` lags the tree,
  the page posts `{}` and the leftover host lobby comes back (Host + old title; Join says the old
  meeting ended). Re-measured 2026-08-26 after deploying this package: leftover cookie + live guest
  URL → `{ meetingId }` → 401 → `#view-guest`. The marker is build-derived since the 2026-08-31
  room refactor — compare the served marker with the value the deploying build printed (there is
  no constant to read any more) before trusting the live Worker. Do not Join from the
  QA Edge profile (mic permission). Colleagues should open the guest link in their own browser.
- **Start recording in the room.** Close without that click settles `ready` with no recording files.
  The Council Worker writes `/meetings/<meetingId>/meeting.md` through its sealed service grant; the
  host copies nothing. After Close, the card moves `processing → ready` (often a few minutes). Recordings land
  under `/meetings/<meetingId>/`: `recording.mp4`, `recording-audio.m4a`, `transcript.md`,
  `summary.md`, and maybe `provider-transcript.json`. Composite transcript lines are labeled
  `Meeting`. Those blob uploads need a paid plan; the meeting note does not.
- **`Saved to /meetings/<id>` on the card is still a planned recording path.** The service writes
  `destinationPath` at create time. Recordings appear in Files only on the first successful upload.
  Installed Council 0.2.0 still prints `Saved to` on every card even when `artifactCount` is 0.
  Current plugin source hides the path unless `artifacts.length > 0` and says `Council saved no
  files for this meeting.` instead. The Files tree can still show `meeting.md`, written by the
  Council Worker itself, for that same meeting. The card label next to it is `Ended` (close time),
  not a Files destination.
- **Meeting note Files tree (no Join).** The Council Worker writes each meeting's note to
  `/meetings/<meetingId>/meeting.md` through its sealed service grant on `/api/v1/files/write` —
  the host copies nothing any more. The 2026-08 data erase removed every old note, and the Worker
  rebuilds them only after its pending redeploy (D1 `0010` resets `file_projection_revision` to 0
  so every meeting rebuilds); until then absent notes are expected. To check: open
  `/w/personal/home/files?nodeId=root` in an owned tab. Root shows
  `meetings, contains read-only items` (not `meetings, read-only`). `Add file` / `Add folder` on
  that row stay enabled; the same actions on `chitchat, read-only` stay disabled. Expand
  `meetings` → the uuid folders → `meeting.md, read-only`. Open it and read
  `.FileNodeView-content-panel`: title, `Status:`, `Meeting id:`, and either artifact file names
  or `Council stored no recording files for this meeting.` A leftover uuid folder with no D1 row
  stays without `meeting.md` (delete archives the note and leaves the folder). Do not Join from QA
  Edge for this check.
- **A Failed card is not enough.** The page always shows the same save-failed sentence. D1
  `failure_reason` is the operator text, but a Durable Object reset mid-run can write that column
  first (`Durable Object reset because its code was updated.`) and then the catch cannot overwrite
  it because the row is already `failed`. The real step error lives on the Workflow instance:
  `vp env exec -- pnpx wrangler workflows instances describe bonobo-council-workflow council-process_meeting-<meetingId>-g<generation> --config packages/council/wrangler.jsonc`
  (the workflow becomes `bonobo-senate-council-workflow` at the pending Worker cutover).
  Also read artifacts (`kind, file_name, status`, never `upload_body`) and the outbox generation.
  Do not run `wrangler tail` on `bonobo-council-service` while a meeting is `processing`: enabling
  tail or dashboard logs can reset the Workflow Durable Object. Hourly cron redrives after one
  hour if the sealed grant still lives. Convex will only show the service-grant exchange and
  `meeting.md` writes until create-target runs. Do not Join from QA Edge for this. QA Edge is not signed into the
  Cloudflare or Convex dashboards — use Wrangler and `convex logs`, and do not sign in.
  If the Workflow error is `The provider never published the recording's track files`, ask
  RealtimeKit live (Cloudflare API MCP `GET .../recordings/{id}`, or list today's recordings).
  Print only `status`, `recording_duration`, whether `download_url` exists, and `err_message`.
  Through the Cloudflare API MCP, RealtimeKit list calls return `{ success, data, paging }`,
  not `result`. Filter with `search` set to the meeting title so you do not need the
  meeting id. Never print `access_token` from the apps list.
  Never print recording ids or download URLs. A real upload-in-progress still looks like
  `UPLOADING`, but a hang looks like `UPLOADING` plus `recording_duration: 0`, no `download_url`,
  and a null `err_message` long after `stopped_time`. That same shape was still live on a
  2026-08-16 track recording ten days later.
  **Close order (deployed 2026-08-26, Worker `39a33ead`).** `council_close_meeting`
  now stops the recording while the session is still live, then kicks everyone. Room
  End meeting, dashboard Close, and the deadline cron all use this one function. A
  refused first stop still kicks and still hands the meeting to processing. Do not
  wait for `UPLOADED` inside close — the room has a 30 second budget.
  **Live proof failed (verified 2026-08-27).** Stop-then-kick did not fix the hang.
  Title `Stop first 27 Aug`, same flow: host records alone, guest joins about two
  minutes later, stay ~13 minutes (791 s), End meeting, no Stop. RealtimeKit was
  `UPLOADING`, `recording_duration: 0`, no `download_url`, null `err_message`, no
  file size at 67 s after `stopped_time`, and still the same at 343 s. D1 stayed
  `processing` generation 1 with 2 participants. The kick-order guess is wrong.
  Next RK-only step was the start path: composite `POST /recordings` instead of
  track. **Live proof passed (verified 2026-08-27).** Title `Composite first 27 Aug`,
  same long flow (~14 minutes 37 seconds, no Stop). RealtimeKit was `UPLOADED`
  with duration above 0, a string `download_url`, and an `audio_download_url`.
  Council discovered `recording.mp4` and `recording-audio.m4a`. The hang is gone
  on composite start. The first save failed because QA Edge `personal/home` was
  anonymous/`Free` (`403` plugin service file storage). After that billed user's
  snapshot was moved to `Pay As You Go`, generation 2 finished `ready` with
  finalized `recording.mp4`, `recording-audio.m4a`, `transcript.md`,
  `summary.md`, and `provider-transcript.json`. The Council card then showed
  Ready, Recording, Transcript, Summary, and Saved to. Do not invent files for
  meetings that already hung — there is no retry-upload API. Do not Join from QA Edge. Use two scratch Chromes. Copy the
  guest URL immediately before the scratch clipboard read. Drive Council clicks
  through `state.appPlaywriterHarness.page`. Installed Open is named
  `Open meeting` only. Scope it with `li.meeting` plus the title text. A bound
  Council tab can show the plugin iframe in the DOM while `page.frames()` still
  lists only the host — open an owned tab so the frame attaches. Do not
  snapshot the plugin iframe.
  **Live hang before the fix (verified 2026-08-26).** The hang is not only the old TEST
  meeting. A new ~13 minute call that copied that flow reproduced it on the first try
  with kick-then-stop. RealtimeKit went to `UPLOADING` with `recording_duration: 0`,
  no `download_url`, null `err_message`, and null `file_size` as soon as
  `stopped_time` was set. Five minutes later it had not moved. A short older row in
  the same list was `UPLOADED` with a real duration, so this is not "every recording
  looks like this while files copy."
  After the full poll, Council still finishes `ready`
  from the provider transcript when it sees that hang (`duration === 0`). A slow upload with
  no duration still fails so a later redrive can pick up files. RealtimeKit's only recording
  actions are `stop` / `pause` / `resume`. There is no retry-upload API. A leftover provider
  meeting can stay `ACTIVE` after the session ended; marking it `INACTIVE` did not finish a
  hung upload. A Durable Object reset can write D1 `failed` while the Workflow instance is
  still polling. If that happens, set the row back to `processing` on the same generation so a
  later `UPLOADED` can still write `ready`. A Workflow that stays `Running` on one sleep step
  for far longer than 30 seconds may be paused: `wrangler workflows instances resume
  bonobo-council-workflow <instanceId> --config packages/council/wrangler.jsonc`
  unstuck generation 2 of the 2026-08-26 TEST meeting. Do not start `wrangler tail` to watch
  this. The hung-upload recovery is deployed. Generation 3 of that TEST meeting finished
  `ready` from the provider transcript after every poll stayed `UPLOADING` with
  `recordingDuration: 0` and no files. A hang-recovered card shows three artifact badges
  (`Transcript`, `Summary`, `Provider transcript`) and `Saved to`, not a `Recording` badge
  and not the failed-save sentence. The leftover D1 `failure_reason` stays on a `ready` row
  and the page hides it. QA Edge `personal/home` is the anonymous install and will not list
  another account's TEST meeting. Do not sign in to reach it. Confirm on the owner's Council
  page, or from D1 (`status=ready`) plus the Files folder names (`transcript.md`,
  `summary.md`, `provider-transcript.json`, `meeting.md`). Do not start a new generation on a
  meeting that is already `ready`: a redrive skips a finalized `transcript.md`.

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
  page on the SDK's own Convex client — there is no data bridge to observe (see below). Since
  Chitchat 0.7.0 the page reads `watch_documents_page` through `usePaginatedQuery`, so the `Load
  older` button is that hook's `loadMore` (see `chitchat.md`).
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
  the same module singletons the app runs). Within seconds the revoked tab renders the plugin's
  `denied` screen (Chitchat 0.6.3: "Chitchat can no longer read its data. Reload the page to try
  again." with the composer unmounted; older builds said "Access to this plugin's data ended…")
  while other tabs stay live (one session per mount, 1:1 — verified). That watch is dead and does
  not recover in place; a reload mints a fresh session and recovers. A revoke while the page is
  ONLINE is not the sleep path: the doors answer null at once and the SDK reports `denied`, never
  `session_expired` (that reason needs the token's own expiry to have passed). Re-verified
  2026-09-02 on SDK 0.11.0 with the JWT delivered in init: same nonce, zero exchange requests.

  A page kept offline while its session disappears is different. When its Convex client later
  needs a JWT, the refresh chain hits the gone session and the host gets "Unauthorized". Since the
  host's re-mint change (2026-09-02), it mints a new session for the SAME frame and answers that
  refresh with `bonobo:token`: the iframe `src` and its `nonce` do not change, the composer draft
  survives, and exactly one new `plugins_ui_sessions` doc appears. To watch this, poll the table for
  the new doc and read the iframe `src` fragment; a `nonce` change now means a remount, which is a
  regression. Use the offline recipe below. Verified again 2026-09-02 on SDK 0.11.0 with the JWT
  delivered over the bridge: after a proven 80-second renderer suspension with the network back
  2.6 s after resume, the host saw one `bonobo:token-refresh-request` 1.5 s after resume and
  minted S2 4.9 s after resume; the frame kept its nonce, its draft, an enabled composer, and zero
  exchange requests. The frame's client first logged `Failed to authenticate: … Token expired 9
  seconds ago` for the old JWT, then authenticated with the delivered one, and a message sent from
  a second tab arrived in the first frame.

Offline session re-mint recipe (Windows, updated 2026-09-02):

1. Use a dedicated Playwriter session and install any plugin-bundle swap route before opening the
   plugin page. Confirm the served bundle has the current SDK and read a bundle-only marker from the
   frame. Keep one app tab as the owned primary page.
2. Temporarily set `SESSION_TTL_MS` in `plugins_ui.ts` to 90 seconds (the JWT expires with the
   session, so this is the only clock), push with
   `vp env exec pnpm --dir packages/app exec convex dev --once`, and require `Convex functions
   ready`. Restore 30 minutes and push again as soon as the run ends.
3. Navigate to the plugin page, record T0 after the host document loads, wait 10 seconds, and record
   the frame nonce, one unsent draft, and the one `plugins_ui_sessions` doc S1. A stale doc makes the
   result ambiguous; navigate away and revoke it before restarting.
4. Find the renderer process ids for THIS load. Take a three-second idle baseline of
   `Get-CimInstance Win32_Process` CPU time for `msedge.exe` (read the `--type=` value from each
   command line) and drop every process that was busy in it. Then run a three-second busy loop in
   the host and take the largest delta among the remaining `--type=renderer` processes. Repeat for
   the last `/plugins-ui/` frame; the host and the OOPIF normally name two different pids. On
   2026-09-02 a renderer burning 4 s of CPU per window at idle won "largest delta" for both probes,
   and the tab was never suspended. Reloading invalidates the ids. Suspend each proven pid with
   its own `suspend-process.ps1` call: the script takes `[int[]]`, and both `-Pids "a,b"` and
   `-Pids a,b` fail to bind through `pwsh -File`. Prove the suspension without CDP: every thread
   in `(Get-Process -Id <pid>).Threads` reports `WaitReason` `Suspended`. A CDP command sent to a
   suspended renderer (an evaluate, or `setOffline` itself) wedges the extension for every session
   on that profile until Edge is restarted (see `known-hazards.md`).
5. Before T0 +45 seconds, call `context.setOffline(true)`, prove both documents report offline, then
   suspend the proven renderer ids with `suspend-process.ps1`. Revoke S1 through
   `plugins_ui:revoke_ui_session` and require the session-table readback to be empty. Close every
   other tab of the Playwriter session before this step (the dead tabs of an earlier run):
   `setOffline` sends one CDP command per attached target and waits 30 seconds for each one that
   does not answer, which is what made the online step take 31–34 s in the runs of 2026-09-02.
6. Wait until at least T0 +100 seconds. Resume each renderer first (one script call per pid), then
   call `context.setOffline(false)` at once and require it to finish. The network must be back
   within the SDK's 10-second refresh deadline: otherwise the refresh the frame sends on wake times
   out, its two retries get "Another session refresh is in progress", the auth callback answers
   null, and the page dies as `session_expired` while the host still re-mints a session nobody
   uses (seen 2026-09-02 in three awake-offline runs; that deadline is unchanged since SDK 0.10.0).
   Wait 15 seconds.
7. Require the same nonce, the exact draft, the bundle marker, no host alert, and exactly one new
   session doc S2 for the same user. Open one owned second page with its own swap route, send a
   unique Chitchat message, and require the first frame to receive it. This proves the old live
   subscriptions were not replaced with a dead document.
8. Navigate owned pages away before cleanup, revoke every remaining test doc, require the table to
   be empty, delete the Playwriter session, and stop any scratch static server.

The SDK's one-second wake poll is part of this proof. A wall-clock gap of 30 seconds calls
`setAuth` on the SDK's Convex client again (a `ConvexReactClient` since SDK 0.13.0) before the old
socket can reconnect. Without it, the host can create S2
but the old identity can still deliver a permanent null first and kill the page.

Plugin-session JWT startup check (added 2026-09-02 with SDK 0.11.0). A frame on the current host
and SDK must start with ZERO `POST /plugins-ui/session-jwt` requests, because the host delivers the
JWT inside `bonobo:init`. Open the plugin page in an owned tab, wait about 12 seconds so the client
has confirmed its auth, then read the frame's own resource timing from inside the OOPIF with
`frame.evaluate` (never `snapshot()` inside a plugin frame):

```js
const frame = page.frames().findLast((f) => f.url().includes("/plugins-ui/"));
await frame.evaluate(() =>
	performance
		.getEntriesByType("resource")
		.filter((entry) => entry.name.includes("/plugins-ui/session-jwt"))
		.map((entry) => Math.round(entry.startTime)),
);
```

The old-code baseline (Chitchat 0.6.2 on SDK 0.10.0, host before the mint change) answered two
entries at about 1.8 and 2.8 seconds: the initial exchange and the client's forced refetch right
after it confirmed the first. An older-SDK bundle against the new host still shows those two —
that is the fallback working, not a regression. Observed 2026-09-02 on the dev host: the 0.6.2
frame on the new host answered 1598 and 2312 ms; the Chitchat 0.6.3, Council 0.2.5, Gallery
0.1.14, and Video Player 0.1.3 (file view on `/meetings/<id>/recording.mp4`) frames on SDK 0.11.0
answered an empty list with no host alert, and so did Chitchat 0.6.3 on the Pages host
(`chitchat-qa/home`, deploy of `af9d0968`). Pair the empty list with the composer being enabled and
the channel list rendered (or the `<video>` element carrying a source), so an empty list cannot
come from a frame that never authenticated at all.

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

## Reading the host theme inside any plugin frame

Since SDK 0.10.0 the host sends the frame the app's nine numbered colour scales (104 custom
properties, `--color-base-1-01` … `--color-red-12`) plus `mode`, and the SDK writes them onto the
frame's `document.documentElement.style` and toggles a root `light` / `dark` class. This holds for a
plugin page and for a file view alike, and for plugins that never read the theme themselves (Gallery,
Video Player, Council). Verified 2026-09-02 on the dev host in all four frames (Gallery page, Council
page, Video Player file view, Chitchat page) and on the Pages host (Chitchat page in `chitchat-qa`).

Read it with a real `Frame` handle (never `snapshot()`, see `known-hazards.md`), and compare against
the host's computed value in the same call:

```js
const frame = state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1);
const inFrame = await frame.evaluate(() => {
	const r = document.documentElement;
	return {
		cls: r.className, // "dark" or "light" — from the surface lightness, NOT the host class
		scales: [...r.style].filter((n) => n.startsWith("--color-")).length, // 104
		base: r.style.getPropertyValue("--color-base-1-01"),
	};
});
const hostBase = await state.page.evaluate(() =>
	getComputedStyle(document.documentElement).getPropertyValue("--color-base-1-01").trim(),
);
// pass: inFrame.scales === 104 && inFrame.base === hostBase
```

Three things that look wrong and are not:

- The host root says `light` while every frame says `dark`. The app's palette does not swap with the
  theme yet, so `mode` is read from the lightness of `--color-base-1-01`; a member on "light" still
  paints dark surfaces and the frame follows the paint.
- A frame that has been open for a while can read `scales: 104` from a theme message that arrived
  after init. The count is the same either way; read `base` to know which theme is applied.
- The host's frame observer watches the root `class` attribute only. Changing a scale value on the host
  root sends nothing until the class also changes. To push a change live, set the property, then
  toggle `light` and `dark` on the root; the frame receives one `bonobo:theme` and the SDK repaints.

Break-on-purpose: set `--color-green-12` to `initial` on the host root (its computed value becomes
empty) and toggle the class. The SDK writes the empty string, which removes the property, so the frame
count drops to 103. Remove the override and toggle again to get 104 back. Chitchat's own readback is
`frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-surface").trim())`, which must equal
`hostBase` — the recipe with the light-surface fixture lives in `chitchat.md`.

## Calling the plugin doors from inside a frame

Since SDK 0.12.0 the SDK client carries `convex` (the frame's own authenticated Convex client) and
`api` (references to the plugin doors). Since SDK 0.13.0 that client is a **`ConvexReactClient`**,
because the plugin's own tree runs `convex/react` hooks on it, and the client also carries
`session` (`expiresAt()` and `fetchJwt`). A plugin never puts the client on `window`, so reach it
through the plugin's React root: Chitchat renders `<App client={client} />`, and the `client` prop
sits on the first fiber below the container. Verified 2026-09-02 on Chitchat 0.6.4 (dev host); the
same walk on 0.6.3 found the client with `convex` and `api` both `undefined`, which is the negative
control for "this frame really runs the 0.12.0 SDK".

Re-verified 2026-09-02 on Chitchat 0.7.0 / SDK 0.13.0 (dev host, QA workspace). `Object.keys(client)`
answered `api, apiOrigin, backend, context, convex, fetchJson, getToken, refreshToken, session,
theme` — so the fastest live check for a 0.13.0 frame is that `data`, `members` and `scopes` are all
**absent**. In the same call `client.session.expiresAt()` sat 27 minutes ahead of `Date.now()`,
`client.convex.query(client.api.plugins_data.list_members, { limit: 5 })` answered the one QA member,
and `client.convex.query(client.api.plugins_data.watch_documents_page, { collection: "channels",
paginationOpts: { numItems: 3, cursor: null } })` answered 3 documents with `isDone: false`. The
runner is `t3-chat-+personal/+ai/plugin-infra-primitives-2026-09-02/probe-frame.js`.

```js
const frame = state.page.frames().filter((f) => f.url().includes("/plugins-ui/")).at(-1);
const out = await frame.evaluate(async () => {
	const container = document.getElementById("root");
	const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
	const queue = [container[key]];
	let client = null;
	while (queue.length && !client) {
		const f = queue.shift();
		if (f?.memoizedProps?.client?.context) client = f.memoizedProps.client;
		if (f?.child) queue.push(f.child);
		if (f?.sibling) queue.push(f.sibling);
	}
	const page = await client.convex.query(client.api.plugins_data.list_members, { limit: 5 });
	// A door outside `api`: a string "file:function" is a valid function reference at run time.
	const anagraphic = await client.convex.query("users:get_anagraphic", { userId: client.context.userId });
	return { hasConvex: !!client.convex, members: page?.members?.length, anagraphic };
});
```

- `Object.keys(client.api.plugins_data)` is `[]`: the runtime object is Convex's `anyApi` proxy, and
  only the types are generated. Read a door's name with `ref[Symbol.for("functionName")]`
  (`"plugins_data:list_members"`), not by enumerating.
- The roster call answers the real members (the QA workspace has one, the anonymous QA user). The
  `users:get_anagraphic` call answers `null` and `ai_chat:thread_create` answers
  `{ _nay: { message: "Unauthenticated" } }`, because the plugin-session JWT resolves to a member only
  inside the doors. Pair every refusal with a positive control from the host tab as the same user:
  `await state.page.evaluate(async () => (await import("/src/lib/app-convex-client.ts")).app_convex.query("users:get_anagraphic", { userId }))`
  returned the anagraphic row on 2026-09-02, so the frame's `null` is a refusal and not an absent row.
  Read `ai_chat_threads` back after the mutation attempt (0 rows with the probe title).
- Gallery is Preact, not React: the `__reactContainer$` key does not exist there. Judge its frame by
  the `.gallery-grid` render instead (`plugin-gallery.md`).

## Proving a page really pages over Convex, not over HTTP

A plugin that grows a history with `usePaginatedQuery` must load the next page over the Convex
websocket. The claim to check is that pressing the page's "load more" control sends **no** request to
`/api/v1/plugin-data/list`. `page.route` never sees a plugin frame's subresource requests, so read
the frame's own resource timeline instead:

```js
await frame.evaluate(() =>
	performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/v1/plugin-data/list")).length,
);
```

Take the count before and after the press. **Watch it not change; do not expect zero** — a page can
use that route for other reads at the same time (Chitchat's reaction and reply companion lists do).

The live subscriptions are readable too, on `client.convex.sync.state.querySet` (a Map). Each value
carries `canonicalizedUdfPath` (not `udfPath`) and `args`, and `args` is the **args object**, not a
positional array — indexing `args[0]` answers `undefined` for every field, so the probe reports rows
that look empty instead of failing, and the run reads as "the door was never called". Do not turn a
subscription count into a press count: Convex splits a loaded page in two when the server flags
`SplitRecommended` or `SplitRequired` (`convex/dist/esm/react/use_paginated_query.js:160`), which the
`watch_documents_page` door invites by pinning `maximumRowsRead: 100`.

Measured 2026-09-02 on Chitchat 0.7.0, a 103-message channel: one press moved the list from 100 to
103 rows, removed the "Load older" button, left the `/plugin-data/list` count at 4, and left three
live `plugins_data:watch_documents_page` subscriptions on the same collection and `keyPrefix`
(`numItems: 100`, one at `cursor: null`, two at stored cursors). Runners: `load-older.js` and
`query-set.js` in `t3-chat-+personal/+ai/plugin-infra-primitives-2026-09-02/`.

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
