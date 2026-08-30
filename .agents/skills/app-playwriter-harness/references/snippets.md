# Playwriter Snippets

Use these snippets from the repo root.

## Call An App HTTP Route As The Signed-In User, From The Sandbox

Use this when the check is about the route's own answer (status code, error body) rather than the UI. Running the request from the sandbox means an app reload cannot destroy it — see the navigation hazard in `known-hazards.md`.

```js
// Call 1: lift the credentials out of the page and park them on `state`.
state.craft = await state.page.evaluate(async () => {
	const { app_convex } = await import("/src/lib/app-convex-client.ts");
	const { api } = await import("/convex/_generated/api.js");
	const { app_fetch_main_api_url } = await import("/src/lib/fetch.ts");
	const membership = await app_convex.query(api.organizations.get_membership_by_organization_workspace_name, {
		organizationName: "<org>",
		workspaceName: "<workspace>",
	});
	return {
		membershipId: membership?._id ?? null,
		token: await window.Clerk.session.getToken({ template: "convex" }),
		url: app_fetch_main_api_url("/api/chat"),
	};
});

// Call 2 (and later): one request per run, from the sandbox.
const response = await fetch(state.craft.url, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.craft.token}` },
	body: JSON.stringify({ /* ... */ membershipId: state.craft.membershipId }),
});
console.log(JSON.stringify({ status: response.status, body: (await response.text()).slice(0, 160) }));
```

The Convex client is exported as `app_convex`, not `app_convex_client`. `/api/chat` allows about one request per 15s (`ai_chat_http`, capacity 1), so send one request per run and do other work in between instead of sleeping inside the runner; a `429` answers with `retryAfterMs`.

## Drive The Plugin Service Upload Routes With A Minted Grant

The `/api/v1/files/service-uploads/*` routes only answer a sealed **processing-phase** plugin service grant, which the plugin runtime normally mints during an event run. For QA, mint one yourself against an installation that already accepted `plugin.service.connect` and `workspace.files.write`, then drive the routes from Node — no browser involved.

```bash
# 1. Mint the grant. Send the output to a scratch file: the response contains a live token.
cd packages/app
vp env exec node node_modules/convex/bin/main.js run --typecheck disable --codegen disable \
  public_api:create_plugin_service_grant \
  "{\"organizationId\":\"<org>\",\"workspaceId\":\"<ws>\",\"installationId\":\"<installation>\",\"actorUserId\":\"<user>\",\"requestedScopes\":[\"files:write\"],\"destinationPathPrefix\":\"/meetings/qa-<run-id>\",\"phase\":\"processing\",\"now\":$(date +%s000)}" \
  > "$SCRATCH/grant.json"
```

```js
// 2. Read the token out of the file inside the runner and never print it.
const raw = fs.readFileSync(grantFile, "utf8");
const token = JSON.parse(raw.slice(raw.indexOf("{")))._yay.token; // `convex run` prints a banner first
// create-target -> signed PUT -> finalize, all with { idempotencyKey, targetKey }.
// create-target's body is strict and every field is required:
// { idempotencyKey, targetKey, path, contentType, size, readOnly, nonCollaborative }
```

What cost time on the first run:

- `create-target` is closed to `Free`. Every dev account starts on `Free`, so the first call answers `403 This workspace's plan does not include plugin service file storage` and nothing else runs. The honest fix is to buy a paid plan in the sandbox — see "Move The QA Account To A Paid Plan Through Polar Checkout" below. When you only need the paid state for one check and want it reverted exactly, patch the snapshot instead: export `billing_usage_snapshots` with `data --format jsonLines`, copy the file, change only that user's `subscription.productId` to the `Pay As You Go` product id (read the ids with `data products --component polar`), `import --table billing_usage_snapshots --replace --yes --format jsonLines <file>`, run the check, then import the untouched export back and diff the readback against it. `import --replace` keeps `_id` and `_creationTime`, so the restore is byte-identical. The payer is the billed user, so in an owner-billed organization it is the owner's row, not the acting member's. Only `create-target` is gated: `remint`, `finalize`, `delete`, and `archive-destination` keep answering on `Free`.
- `convex run` prints a deployment banner before the JSON, so `JSON.parse` needs `raw.slice(raw.indexOf("{"))`.
- The grant's `destinationPathPrefix` is the fence. `create-target` creates the destination folder itself, so the path does not have to exist.
- `create-target`'s body is strict, and `readOnly` and `nonCollaborative` are required booleans like every other field — leaving one out answers `400` before anything else runs. `readOnly: true` also needs the installation to have accepted `workspace.files.create-read-only`, or the call answers `403 Permission denied`. `nonCollaborative: true` is only allowed for an editable text file; anything else answers `400 Only editable text files can be non-collaborative`. Both booleans are part of the replay fingerprint, so a retry that flips one is a different file: `409 This target key was already used for a different file`.
- `finalize` answers `200` with `state: "pending"` and `actualBytes: null` while the R2 event has not arrived yet. Call it again a few seconds later to see `committed`. The R2 queue decides when, not the route.
- For `create-target`, `remint`, and `finalize`, the pair `{ idempotencyKey, targetKey }` identifies one file in one upload run. The target also stays bound to the exact destination seal that created it. Active replay, remint, and finalize recheck the current path, archive state, and restricted ACL; a later read-only lock still allows the accepted upload to finish. An exact create replay still returns that target when either 16-target cap is full: one run, or one live cross-run delete group at the sealed destination. The one temporary exception is an old staging deletion job: both a pending create replay and `remint` answer 409 until it settles, then the retry reuses the same asset and staging key and you send the whole file again. `delete` is different: it finds the bounded live `{ installation, destination, targetKey }` group across upload runs, so its `idempotencyKey` does not limit cleanup to one run. It rechecks each node's current path, restricted ACL, and lock before the first write. Released history is not listed in full on replay.
- To prove where the quota is charged, declare a size that is deliberately wrong (for example declare 1 byte and PUT 4096) and read the `quotas` doc between `create-target` and the PUT. `create-target` must leave `usedCount` unchanged; the R2 settlement then adds exactly the stored size. Read it with `convex data quotas --limit 200 --format jsonLines` and pick the row with `quotaName: "plugin_service_storage_bytes"` for the workspace. The final total alone cannot tell the two models apart, because charging the guess plus the difference lands on the same number.
- Choose one cleanup door. Use `delete` for one target key across upload runs, or use `archive-destination` for the whole sealed folder like Council does. `delete` archives committed files but cancels and removes unfinished placeholders. `archive-destination` keeps the folder as one restorable set. Neither door gives quota bytes back. `plugin_service_storage_bytes` only counts up.

## Move The QA Account To A Paid Plan Through Polar Checkout

Dev runs on the Polar **sandbox** (`convex env get POLAR_SERVER` says `sandbox`, and the checkout host is `sandbox.polar.sh`), so no real money moves. Check that before touching billing. Every dev account starts on `Free`, and `Free` cannot open a plugin service upload, so this is the recipe when a check needs a paying workspace.

The account modal is behind `Account: <name>` → `Manage account` → the `Billing` tab. `Select plan` calls `billing.generate_checkout_link` and then `window.open`, and that tab is invisible to the run (see `known-hazards.md`). Do the same call yourself and open the link in a page the run owns:

```js
state.checkoutUrl = await state.page.evaluate(async () => {
	const m = await import("/src/lib/app-convex-client.ts");
	// `Free -> paid` must carry the current subscription id, or Polar adds a SECOND active
	// subscription and the app treats that as an impossible billing state.
	const sub = await m.app_convex.query(m.app_convex_api.billing.get_current_user_subscription, {});
	const r = await m.app_convex.action(m.app_convex_api.billing.generate_checkout_link, {
		productId: "<Pay As You Go product id>",
		origin: window.location.origin,
		successUrl: window.location.href,
		subscriptionId: sub.id,
	});
	return r._yay.url;
});
state.checkoutPage = await context.newPage();
await state.checkoutPage.goto(state.checkoutUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
```

Read the product ids with `convex data products --component polar --format jsonLines`. On the checkout page: email and cardholder name are prefilled, pick a `Country` from the combobox, then type the sandbox card blind into the Stripe iframe (that recipe is in `known-hazards.md`), then click `Subscribe now`. Success redirects back to `successUrl` with a `customer_session_token` query parameter — that redirect is the confirmation, because the Stripe frame shows you nothing.

The `customer.state_changed` webhook updates `billing_usage_snapshots` within a few seconds. Confirm with `convex data billing_usage_snapshots --format jsonLines`: `subscription.productId` moves to the new plan on the **same** `subscription.id`, and the plan's monthly credit lands on the meter balance. The billing panel shows the new plan after a reload, and the other plan cards switch from `Select plan` to `Upgrade` / `Downgrade at renewal`.

## Create Session

```powershell
vp env exec pnpx playwriter browser list
$browserKey = "<exact KEY from browser list>"
$sessionOutput = vp env exec pnpx playwriter session new --browser $browserKey
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
```

When Playwriter reports multiple browsers, create the session with the exact full browser key:

```powershell
vp env exec pnpx playwriter browser list
$browserKey = "<exact KEY from browser list>"
vp env exec pnpx playwriter session new --browser $browserKey
```

## Recover Missing Extension Connection

Use this when the Playwriter extension looks active in the browser but `vp env exec pnpx playwriter browser list` says `No browsers detected`.

```powershell
$vpExecutable = (Get-Command vp -ErrorAction Stop).Source
Start-Process -FilePath $vpExecutable -ArgumentList @(
	"env", "exec", "pnpx", "playwriter", "serve", "--host", "localhost", "--replace"
) -WorkingDirectory (Get-Location) -WindowStyle Hidden
Start-Sleep -Seconds 3
vp env exec pnpx playwriter browser list --host localhost
```

Include `--host localhost` on later Playwriter commands that use this restarted relay.

If no extension is still detected and Edge must be restarted, load `C:/Users/rt0/.cursor/skills/edge-remote-debugging-mcp/SKILL.md` and follow its profile validation and bundled-script workflow. Do not invent a profile path or Edge launch command here.

## Install Harness

```powershell
vp env exec pnpx playwriter -s $session --% -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

## Bind Existing Files Tab

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

## Observe

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.observe({ label: 'files route', search: /Files|Chat|Review|Toolbar/i });"
```

## Startup Redirect QA

Use this after installing the harness. Keep binding, navigation, and observation in separate calls. `latestLogs({ sinceLastCall: true })` reads the action's built-in Playwriter logs, including logs emitted during navigation.

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: 'localhost:5173' });"
vp env exec pnpx playwriter -s $session --% -e "await state.page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });"
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.latestLogs({ search: /IndexRedirect|Missing default|Unauthenticated|organization|error/i, sinceLastCall: true });"
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.waitForUrlIncludes({ urlIncludes: '/w/personal/home/files', timeout: 15000 }); await state.appPlaywriterHarness.observeRoute({ label: 'post-reset startup', search: /Files|Open organization|Preparing organization|Redirecting/i }); await state.appPlaywriterHarness.authSummary();"
```

## Read Logs Since The Last Check

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.latestLogs({ count: 50, sinceLastCall: true });"
```

## Inspect Main Left Nav

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.inspectElement({ selector: '[aria-label]', attribute: { name: 'aria-label', value: 'Main navigation' }, actionSelector: 'a, button, [role=link], [role=button]', localStorageKeys: ['app_state::sidebar::main_app_open', 'app_state::sidebar::main_app_collapsed'] });"
```

## Inspect Organization Switcher Lists

Open the header switcher by its accessible name, then inspect the workspace list scroll metrics.

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/' }); await state.page.getByRole('button', { name: /Open organization and workspace switcher/i }).click(); await state.appPlaywriterHarness.observe({ label: 'organization switcher', search: /Organizations and workspaces|Create organization|Create workspace/i }); await state.appPlaywriterHarness.inspectElement({ selector: '.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label=\"Workspaces\"]', actionSelector: 'button, [role=button]', computedStyles: [{ name: 'workspace list', selector: '.MainAppHeaderOrganizationSwitcherModalSelectList', properties: ['maxHeight', 'overflowY', 'scrollbarGutter'] }] });"
```

## Close Organization Switcher

Use the specific close label so the file sidebar and nested modal close buttons do not make the locator ambiguous.

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.page.getByRole('button', { name: 'Close organization switcher' }).click(); await state.appPlaywriterHarness.observe({ label: 'after closing organization switcher', search: /Open organization and workspace switcher/i });"
```

## Files Folder Create QA

See the Files Folder Create QA recipe in `references/files.md`. Keep the full flow there because it is route-specific.

## Long Playwriter Script From Personal AI Folder

Use one runner in a dated personal AI folder for generated PDF sibling QA or any flow with many assertions. This avoids PowerShell quote parsing issues, especially with selectors containing quotes or JavaScript regexes.

```powershell
$runDirectory = "../t3-chat-+personal/+ai/generated-pdf-qa-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$scriptPath = Join-Path $runDirectory "playwriter-generated-pdf-qa.js"
# Create this runner with the agent's targeted edit tool. Do not write it with a shell rewrite.
vp env exec pnpx playwriter -s $session -f $scriptPath --timeout 180000
```

For generated PDF sibling QA, see `references/files.md` and use fixture `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.

## Inspect Files Resize Handle

Checks the files-sidebar splitter geometry, grip icon contrast, and cursor at the grip center.

```powershell
vp env exec pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' }); await state.appPlaywriterHarness.inspectElement({ selector: '.MyPanelResizeHandle', attribute: { name: 'aria-label', value: 'Resize files sidebar' }, computedStyles: [{ name: 'pill', selector: '.MyPanelResizeHandleGrip-pill', properties: ['backgroundColor', 'outlineColor', 'outlineWidth'] }, { name: 'icon', selector: '.MyPanelResizeHandleGrip-icon', properties: ['stroke', 'color', 'zIndex'] }], hitTargets: [{ name: 'grip center', selector: '.MyPanelResizeHandleGrip' }] });"
```

## Check Whether A Value Is Truncated Or Just Cut Off

Use this for any "this text should end with …" report. It separates the three states that look alike on screen: fitting, ellipsized, and hard-clipped. `overflowing` is `scrollWidth > clientWidth`; a clipped element with `textOverflow: "clip"` is the bug, `"ellipsis"` on the *overflowing* element is the fix.

```js
const read = (el) => {
	if (!el) return null;
	const cs = getComputedStyle(el);
	return {
		text: (el.textContent || "").trim(),
		display: cs.display,
		overflow: cs.overflow,
		textOverflow: cs.textOverflow,
		whiteSpace: cs.whiteSpace,
		clientWidth: el.clientWidth,
		scrollWidth: el.scrollWidth,
		overflowing: el.scrollWidth > el.clientWidth,
		childElementCount: el.childElementCount,
	};
};
```

Read `display` and `childElementCount` together, because they name the most common cause. `text-overflow` only works on a block box whose text is a direct child. A bare text node inside a flex or grid container becomes an anonymous item that the container's own `text-overflow` never reaches, so the value is cut off with no `…` while every computed style still reads `ellipsis` — `display: "flex"` plus `childElementCount: 0` is that trap (found 2026-08-11 on the `/files` folder table's "updated by" column). The fix is to give the text its own element; on that element `overflow: hidden` alone is enough, because it already zeroes a flex item's automatic minimum size — `min-width: 0` next to it is dead code (verified by turning it off and re-measuring).

Prove a fix this way rather than by screenshot alone: flip `text-overflow` to `clip` in the CSS, screenshot the same region, and confirm the `…` disappears and comes back. A screenshot on its own cannot tell a working ellipsis from a stale frame.

After changing a flex property on such a text element (for example `flex: 1 1 auto` → `0 1 auto`), the visible rows often all fit, so nothing on screen proves truncation still works. Squeeze one row in the page and put it back in the same call, instead of resizing the window or the user's panels:

```js
const before = read(text);
row.style.width = "150px"; // row = the flex container
const squeezed = read(text);
row.style.width = "";
const after = read(text);
```

`squeezed.overflowing` must be `true`, and any sibling that must stay readable (a status word, a badge) must keep its full width and stay inside the row's right edge. Compare `before` and `after` to confirm the probe left nothing behind.

## Read Real Pixels Out Of A Screenshot

Use this when the thing under test has no computed style to read: a scrollbar track or thumb, a canvas, a shadow, a blend. Take one clipped screenshot with the fix on and one with it off (flip it with an inline style in the page), then compare the same pixels in PowerShell.

```powershell
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile("C:/.../after.png")
foreach ($y in 48..70) { $p = $b.GetPixel(200, $y); "y=$y : $($p.R),$($p.G),$($p.B)" }
$b.Dispose()
```

Sample a whole column, not one point: one pixel cannot tell you which band you landed in, and a control's own background inside a bar reads nothing like the bar. Map image coordinates from the clip (`imageY = pageY - clip.y`) and from `getBoundingClientRect()` of the element, and remember `page.screenshot({ scale: "css" })` plus `bringToFront()` (a backgrounded tab returns a stale frame).

## Run A Real axe-core Audit

`auditAccessibility(...)` is only a screen. For rule-level findings, inject axe-core. The dev server sets no CSP that blocks it, so `addScriptTag` works (verified 2026-07-26, axe-core 4.12.1, 572KB).

Install axe-core outside the repo first, so no `node_modules` appears in `git status`:

```powershell
$axeDir = Join-Path $env:TEMP "axe-install"
New-Item -ItemType Directory -Force $axeDir | Out-Null
Set-Location $axeDir
if (-not (Test-Path "$axeDir/package.json")) { '{"name":"axe-tmp","private":true}' | Set-Content "$axeDir/package.json" }
vp env exec pnpm add axe-core@4.12.1
```

Pin the version. Unpinned, this line installs whatever is latest, and the audit results recorded above
were measured against 4.12.1. A run that quietly used a newer axe would report a different rule set and
look like a regression in the app.

Run `pnpm add` **unconditionally**, every time. The `Test-Path` guard above covers only the throwaway
`package.json`; do not extend it over the install. Observed 2026-08-22: a reviewer wrapped the whole
block in `if (-not (Test-Path ...))`, so a cached install from an earlier session was reused and the run
used **axe 4.13.0** against this recipe's 4.12.1 pin. A pinned version you skip installing is not a pin.

Then read the version back before you trust a single result. The `AXE:` line the injector logs below is
the only proof of what actually ran — put it in the evidence file next to the findings. If it does not
say the pinned version, the audit is measuring a different rule set than the one recorded here.

Then in a runner: hand Playwright the **path** and let it read the file itself, then run with the fire-and-forget pattern from `known-hazards.md` so each CLI call stays under 5000ms.

```js
// runner 1: inject — Playwright reads the file on the relay host, so the sandbox `fs` is not involved
await state.page.addScriptTag({ path: process.env.TEMP + "/axe-install/node_modules/axe-core/axe.min.js" });
console.log("AXE:", await state.page.evaluate(() => window.axe && window.axe.version));

// runner 2: start (scope to a selector to keep it fast, e.g. ".MainAppHeaderOrganizationSwitcherModal")
state.axeDone = false;
state.page.evaluate(async () => {
	const r = await window.axe.run(document);
	const map = (a) => a.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, t: v.nodes.slice(0, 3).map((x) => x.target.join(" ")) }));
	return { violations: map(r.violations), incomplete: map(r.incomplete) };
}).then((r) => { state.axe = r; state.axeDone = true; }).catch((e) => { state.axe = { err: e.message }; state.axeDone = true; });
console.log("STARTED");

// runner 3: read state.axeDone / state.axe
```

Run each of those three blocks with `-f` and a runner file, not with `-e`. **`vp env exec` hands the
CLI only the FIRST line of a multi-line `-e` argument and drops the rest**, without any error.
Verified 2026-08-23: a two-line `-e` printed `LINE-ONE` and never `LINE-TWO`, and the same script with
a silent first line printed `Code executed successfully (no output)` and exited 0 — which reads
exactly like a script that ran and had nothing to say.

Do not reach for the sandbox `fs` here, and be careful copying only part of runner 1. The older form
of this recipe read the bytes itself with `const fs = require("node:fs"), os = require("node:os")`
before injecting them, and that form does still work. But copy its `addScriptTag` line without the
`require` line above it and you get `ReferenceError: fs is not defined`, because **`fs` and `os` are
not globals in the sandbox** — only `require` is. The obvious repair is worse than the bug: `await
import("node:fs")` throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, and uncaught it takes the CLI
client down with the libuv assertion that looks exactly like a dead relay. Do not restart the relay
over it — see `known-hazards.md`. The `{ path }` form above avoids the whole area.

Always report `incomplete` too — the app's ARIA-on-`<span>` badges and gradient backgrounds land there, not in `violations`. `window.axe` is lost on every reload and `goto`, so re-inject after each navigation.

Scope traps that silently change the result:

- Close every tooltip before a document-scope run. An open Ariakit tooltip portals a bare `<div>` onto `<body>`, outside all landmarks, and that alone produces a `region` violation that is yours, not the app's.
- With an Ariakit modal open the app shell goes `inert`, so axe skips it and a document-scope run audits **only the modal**. App-shell rules then come back `PASS` or `INAPPLICABLE` for a reason that has nothing to do with the app shell. `#root` itself does **not** carry the attribute — probe `document.querySelector("header.MainAppHeader").closest("[inert]")`, not `#root.hasAttribute("inert")`, or you will conclude the shell is in scope when it is not. Confirm scope from the result: read the checked nodes of `landmark-no-duplicate-banner`; if `.MainAppHeader` is absent, the PASS only covers modal content.

## Prove A Live Region Actually Announces

A `role="status"` / `aria-live` element is only half the claim. The other half is that text really lands in it, and a live region is usually written and then cleared again a moment later, so a single poll after the action reads `""` and looks like the feature is dead. Record every change instead, with a `MutationObserver` installed **before** the action:

```js
await frame.evaluate(() => {
	const region = document.querySelector(".council-announcer");
	window.__annLog = [{ t: Date.now(), text: region.textContent, note: "baseline" }];
	window.__annObserver = new MutationObserver(() => {
		const text = region.textContent;
		if (window.__annLog[window.__annLog.length - 1].text !== text) {
			window.__annLog.push({ t: Date.now(), text });
		}
	});
	window.__annObserver.observe(region, { childList: true, characterData: true, subtree: true });
});
```

Then drive the action and read `window.__annLog` in a later call. An interleaved `""` between two messages is normal for the common "recompute the message on every refresh" shape — a refresh that finds no change writes the empty string back. Assert on the sequence of non-empty entries, not on the current text.

Two things that make such a region correct and are worth asserting together with the text: it must be **permanently mounted** (a region that appears together with its first message is announced unreliably), and it must be hidden without leaving the accessibility tree — `position: absolute` with a 1x1 rect and `clip-path: inset(50%)` is right, `display: none` or `visibility: hidden` is not. Read those from `getComputedStyle`, not from the class name.

## A React focus-management effect loses a same-call read

`document.activeElement` read in the **same** execute call as the click that opens a panel reports the element the click focused, not the one the component's `useEffect` moves focus to. The effect has not run yet at that point, so a correct focus-management implementation reads as broken. Split it: click in one call, read `activeElement` in the next. Confirmed 2026-08-16 on the Council delete confirmation, where the same-call read said `Delete` and the next call said `Confirm delete`.

For a control inside a cross-origin plugin iframe, check both sides: the frame's own `document.activeElement` is the button, and the **host** page's `document.activeElement` is the `IFRAME` element. Reading only the host page makes every in-frame focus move look like it failed.

## Read The Chrome Accessibility Tree

Use this when the DOM and assistive tech disagree — `aria-describedby` can be present while the AX `description` is null, and `aria-disabled` shows up as AX `disabled` with `focusable: true`.

The sandbox global is `getCDPSession({ page })`. Passing the page directly (`getCDPSession(state.page)`) throws `Cannot read properties of undefined (reading 'isClosed')` and can take the Node host down with a libuv assertion.

```js
// runner 1: install once per session
state.cdp = await getCDPSession({ page: state.page });
await state.cdp.send("DOM.enable");
await state.cdp.send("Accessibility.enable");
state.axFor = async function (selector) {
	const doc = await state.cdp.send("DOM.getDocument", { depth: 1 });
	const q = await state.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
	if (!q.nodeId) return { selector, found: false };
	const ax = await state.cdp.send("Accessibility.queryAXTree", { nodeId: q.nodeId });
	return ax.nodes.filter((n) => !n.ignored).map((n) => {
		const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value && p.value.value]));
		return { role: n.role?.value, name: n.name?.value ?? null, description: n.description?.value ?? null, focusable: props.focusable, disabled: props.disabled };
	});
};

// later runners: log from the CALLER, never from inside the state function
console.log(JSON.stringify(await state.axFor("button.Something")));
```

`depth: 1` is enough — `DOM.querySelector` pushes the matched node itself. The CDP session survives `page.reload()`, so `state.axFor` keeps working after a navigation.

**Never run two of these helpers concurrently.** Each one calls `DOM.getDocument`, which invalidates the node ids handed out by the previous call, so `Promise.all([axFor(a), axFor(b)])` fails with `Protocol error (DOM.querySelector): Could not find node with given id`. Await them in sequence inside one async IIFE and park the result on `state`.

**`axFor` against a large open modal can wedge the renderer for the rest of the session.** Verified 2026-08-02: one `axFor(".MainAppAccountManagement")` on the open account-management modal left every later `page.evaluate`/`page.title` on that tab timing out (renderer alive enough for `bringToFront`, dead for CDP evaluate), and the `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` libuv message printed in the same run. Recovery then made it worse: `context.newPage()` on the poisoned context threw `Extension request timeout … forwardCDPCommand` and `Extension disconnected`, stranded `about:blank` tabs in the user's Edge, and eventually forced a relay restart that dropped every session. So for modal-heavy or otherwise huge DOMs, get accessible names from the DOM instead of the AX tree — resolve `aria-label` / `aria-labelledby` (`getElementById(id).textContent`) / `element.labels[0].textContent`, and prove tab→panel wiring with `document.getElementById(tab.getAttribute("aria-controls"))`. That is enough to confirm a name reaches AT for buttons/tabs/dialogs, and it never touches CDP. Reserve `axFor` for the roles whose name genuinely cannot come from content (`combobox`/`listbox`/`textbox`/etc.), and run it on the smallest possible selector. If a tab does wedge, do NOT `newPage` to escape it — rebind to a different already-open app tab from a clean session and continue there.

To count landmarks for a whole page, query `"html"` and filter roles — `Accessibility.queryAXTree` returns the full subtree (~2900 nodes on `/files`), and the non-ignored subset is small enough to scan for `banner` / `contentinfo` / `region` duplicates. This is the ground truth when axe's scope is in doubt.

## Measure Contrast Yourself When axe Says INCOMPLETE

This app writes colours as `oklch(...)` and paints panel backgrounds with `linear-gradient`. Two consequences:

- axe cannot resolve a gradient background and reports `color-contrast` as `incomplete` ("background color could not be determined"), so those elements are neither pass nor fail until you measure them.
- `getComputedStyle(el).color` returns the literal `oklch(...)`, so any `rgba?\(...\)` regex parser returns null. Resolve colours through a 1x1 canvas instead, which accepts every CSS colour syntax.

```js
const cv = document.createElement("canvas"); cv.width = cv.height = 1;
const ctx = cv.getContext("2d", { willReadFrequently: true });
const toRgb = (css) => { ctx.globalCompositeOperation = "copy"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
	ctx.globalCompositeOperation = "source-over"; const d = ctx.getImageData(0, 0, 1, 1).data;
	return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
```

Then walk ancestors for the background: stop at the first opaque `backgroundColor`, but also read `backgroundImage` on the way up and pull its colour stops out with `/oklch\([^)]*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi`. Compose against the **lightest** stop for light-on-dark text — that is the worst case and matches what axe reports when it can measure. A plain ancestor walk that ignores `backgroundImage` runs straight past `.MyModalPopover` / `.MainAppHeader` to `<body>` and reports a contrast ratio that is too generous.

Cross-check a single element without trusting your own maths by asking axe for just that node:

```js
await window.axe.run({ include: [[".Some-selector"]] }, { runOnly: { type: "rule", values: ["color-contrast"] } });
```

Its `passes[0].nodes[0].any[0].data` carries `fgColor`, `bgColor`, `contrastRatio`, `fontSize`, and `expectedContrastRatio`.

`Page.captureScreenshot` is not a usable fallback here: it hangs indefinitely whenever the browser window is occluded, even though `evaluate` keeps working.

## Find Who Moved A React Node (`removeChild` crash)

Use this when the route error boundary shows `Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node`. React only fails that way when something moved a node React rendered into a different DOM parent. React's own stack names no component (only `The above error occurred in the <div> component`), so patch the DOM call and let it name the node itself.

```js
await state.page.evaluate(() => {
	const w = window;
	if (w.__rcPatched) return;
	w.__rcPatched = true;
	w.__rcFails = [];
	const orig = Node.prototype.removeChild;
	const describe = (n) =>
		!n ? String(n) : n.nodeType === 1 ? `<${n.tagName.toLowerCase()} class="${n.getAttribute("class") || ""}">` : "#text";
	const chain = (n, max) => {
		const out = [];
		for (let cur = n; cur && out.length < max; cur = cur.parentNode) out.push(describe(cur));
		return out;
	};
	Node.prototype.removeChild = function (child) {
		if (child && child.parentNode !== this) {
			w.__rcFails.push({
				expectedParent: chain(this, 6), // where React thinks the node lives
				child: describe(child),
				actualParent: chain(child.parentNode, 8), // where the node really is
			});
		}
		return orig.call(this, child);
	};
});
```

Then reproduce and read `window.__rcFails`. `child` is the moved node, and comparing the two chains tells you which library moved it. Read `expectedParent` carefully: if that chain still reaches a long-lived container, React was deleting only part of the subtree, so the trigger is a conditional render inside a component that stayed mounted — not the whole editor unmounting.

`__rcFails.length` also makes a good pass/fail assertion: it is `0` on a healthy run, so it catches the mismatch even when the error boundary happens not to fire.

This found the 2026-08-13 `/files` editor crash: tiptap's `DragHandle` rendered its element in the React tree while `DragHandlePlugin` moved that element into a wrapper of its own inside the editor DOM.

## Watch Convex Mutations On The Wire

Use this to prove a feature is or is not still talking to the server (heartbeats, background writes) instead of guessing from the UI. Convex sends every mutation as a WebSocket frame, so one CDP listener catches them all.

```js
// runner 1: install
state.cdp = await getCDPSession({ page: state.page });
await state.cdp.send("Network.enable");
state.frames = [];
state.cdp.on("Network.webSocketFrameSent", (e) => {
	const p = e.response && e.response.payloadData;
	if (typeof p === "string" && p.indexOf("presence:") !== -1) state.frames.push({ t: Date.now(), p: p.slice(0, 260) });
});

// later runners: group by udfPath, and print the age of each frame
// {"type":"Mutation","requestId":168,"udfPath":"presence:heartbeat","args":[{...}]}
```

Frames carry the real arguments, so they double as an identity probe (a `presence:heartbeat` frame contains `roomId` and `userId`). Filter with `indexOf` on the udf prefix, not a broad regex — `ModifyQuerySet` subscription frames mention the same paths.

Clean up with `await state.cdp.send("Network.disable")`. The session object has **no** `removeAllListeners` (it is a thin proxy, only `_playwrightSession` is enumerable); use `state.cdp.off(event, handler)` if you kept the handler reference.

## Query Convex Directly From Outside The Page

To read server state with no browser involved, run a query from the CLI. `pnpm exec convex` is not linked in this repo, so go through the binary:

```powershell
cd packages/app
$raw = vp env exec node node_modules/convex/bin/main.js run users:get '{"userId":"<id>"}' 2>&1 | Out-String
$json = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
$json._id
```

The CLI prints progress text before the JSON, so slice from the first `{` before `ConvertFrom-Json`. A function returning null prints **empty** stdout — treat that as null instead of parsing it. Long results are worse to filter in PowerShell than in the query: pass the query's own filter args when it has them.

Args survive `vp env exec` best as JSON5 with single-quoted strings inside one double-quoted PowerShell string: `"{pluginName:'media',userId:'<id>'}"`. Backslash-escaped double quotes get mangled on the way through and the CLI fails with `JSON5: invalid character '\"'`.

⚠ `convex run` carries an **admin key, not a user identity**, so `ctx.auth.getUserIdentity()` is null by default and any handler that resolves a current user refuses it. There is no single `require_identity` helper to grep for — the shape is `server_convex_get_user_fallback_to_anonymous(ctx)` (from `server/server-utils.ts`) followed by a `throw convex_error({ message: "Unauthenticated" })` when it answers null. Grep for that helper name to find the gated handlers. Pass `--identity '<json>'` to supply a fake identity when you need one; the admin key still authorizes the call, so this reaches internal functions too.

To act as a real app user, pass `external_id` as that user's Convex `users` `_id`. Dummy `subject` / `email` values are enough — the helper keys signed-in users on `external_id`, not on the email string. `email` still has to be present, or the helper throws `Email required for signed-in users`. Use a Clerk-like issuer (not the anonymous JWT issuer), or `create_organization` and other signed-in-only doors answer `Unauthenticated`. Do not `gh auth switch` to "fix" this, and do not print a real email. From `packages/app`, JSON5 args, Git Bash, first read the candidate HEAD:

```bash
vp env exec -- node node_modules/convex/bin/main.js run --typecheck disable --codegen disable \
  plugins:get_publish_candidate_head "{repositoryId:'<plugins_publisher_repositories id>'}" \
  --identity "{subject:'cli-publisher',issuer:'https://clerk.example',email:'qa-publisher@example.com',external_id:'<users id>'}"
```

Check the returned 40-character SHA against the repository HEAD with an independent source. Do not reuse a SHA you read only from this Convex result. After that review, publish that exact SHA:

```bash
vp env exec -- node node_modules/convex/bin/main.js run --typecheck disable --codegen disable \
  plugins:publish_version "{repositoryId:'<plugins_publisher_repositories id>',expectedSourceCommitSha:'<reviewed 40-character SHA>'}" \
  --identity "{subject:'cli-publisher',issuer:'https://clerk.example',email:'qa-publisher@example.com',external_id:'<users id>'}"
```

The same `--identity` shape works for `organizations:create_organization`, `organizations:invite_user_to_organization_workspace`, and `plugins:install_version`. Read the claim's `ownerUserId` from `plugins_publisher_repositories` — the QA Edge profile can be signed out of Clerk, and then the detail page has no Publish button.

Presence is no longer usable as the "is the client registered" probe from here. All eight exported handlers in `presence.ts` require an identity — seven throw the plain `Unauthenticated`, and `heartbeat` throws its own `"Presence heartbeat requires an authenticated user"` — and `listRoom` refuses `app_presence_global` outright even *with* one, so it is not a `convex run` workaround either. Check presence registration from **inside the page** instead, where the app's own identity is live: `presence:heartbeat` for the room, then `presence:list` with the returned room token.

## Prove A Public Convex Query Needs No Auth (truly anonymous)

`convex run` reaches the deployment with an admin key, so it proves the *handler* ignores identity but is not a faithful "attacker with no account". For an unauthenticated-access repro, POST to the public HTTP query endpoint with **no `Authorization` header** from the sandbox's Node `fetch`. Node `fetch` runs in the relay process, not the page, so it carries no browser cookies and no Clerk/anonymous token — a genuine no-account request. Get the public deployment URL from the live page module, never from `.env`:

```js
// runner: get URL (public value shipped to every client), park on state
state.convexUrl = await state.page.evaluate(async () => (await import("/src/lib/app-convex-client.ts")).app_convex_deployment_url);

// runner: unauthenticated query
const resp = await fetch(state.convexUrl + "/api/query", {
	method: "POST",
	headers: { "Content-Type": "application/json" }, // no Authorization = unauthenticated
	body: JSON.stringify({ path: "presence:listRoom", args: { roomId: "app_presence_global" }, format: "json" }),
});
const json = await resp.json(); // { status: "success" | "error", value | errorMessage }
```

HTTP `200` + `{ status: "success" }` proves the query executed with no identity. Both `presence:listRoom` and `users:get_anagraphic({ userId })` used to answer unauthenticated, and chaining them walked a room roster into an address book. Both are gated now — `listRoom` throws `Unauthenticated`, `get_anagraphic` returns `null` — so this probe is the **regression check**, not a live repro.

Run it a second time **signed in**. `listRoom` must still refuse, now with `Unauthorized`: the global room is refused for any caller, because an identity is not a tenant and an anonymous account costs one unauthenticated POST. A `200` with a user list from a signed-in session is the regression this second probe exists to catch.

Do **not** read either result as "the roster is protected". It is not. `presence:heartbeat` mints the global room's token for any caller and `presence:list` then answers with the same roster — verified against `grand-finch-267`, where one anonymous identity got `Unauthorized` from `listRoom` and 104 users from `heartbeat` + `list` in the same session. These two probes guard the `listRoom` door only.

⚠ A source fix is not a deployed fix. These handlers live in Convex, so an edit in the working tree changes nothing until someone pushes it. A verification run once reported this leak as still open when the fix was already written and its tests passing: no `convex dev` was running, and the deployment was serving an *intermediate* version whose `returns` validator already matched the new shape while the handler did not. Check the deployment before concluding, and never read a matching validator as proof the whole file shipped.

`users_anagraphics.email` is a required field on the returned doc: a real address for signed-in (Clerk) users, `""` for anonymous ones — and `""` for anyone the caller is not, which is exactly what the fix does. When reproducing an email leak, redact in the report — log `{ present, length, hasAt }`, never the value. To chain many ids for a blast-radius count, use `Promise.all` over the presence ids with the fire-and-forget pattern (stays under the 5000ms CLI budget).

## Prove A Cross-Origin Iframe Permissions-Policy Grant Without The Host App

You do not need the real host to test what an `<iframe>`'s `allow` attribute grants.
`http://localhost:<port>` and `http://[::1]:<port>` are the same server on two different origins, so
any local page can embed another one cross-origin with the host's exact `sandbox` list.

Build the frame both ways and read the answer **from inside the child** — the parent's own
`allowsFeature(feature, childOrigin)` reports the parent's policy, not the delegation, and answers
`false` either way. Then drive the app's real button, because `page.evaluate` carries no user
activation and its `writeText` rejects in both frames.

```js
// inside the child frame
const allowed = document.featurePolicy.allowsFeature("clipboard-write");
const allowlist = document.featurePolicy.getAllowlistForFeature("clipboard-write");
```

| frame | `allowed` | `allowlist` | real `locator.click()` | `document.execCommand("copy")` |
| --- | --- | --- | --- | --- |
| with `allow="clipboard-write"` | `true` | `["http://localhost:5199"]` | resolves | `true` |
| without `allow` | `false` | `[]` | rejects `NotAllowedError` | `true` |

Read the status the app itself renders after the click. That is the only reading that covers the
policy and the gesture at the same time.

## Propose A Durable Memory

```powershell
vp env exec pnpx playwriter -s $session --% -e "state.appPlaywriterHarness.proposeMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```

Re-read the returned target file, check that the entry is reusable and does not duplicate existing guidance or expose private data, then add it with the agent's targeted edit tool.
