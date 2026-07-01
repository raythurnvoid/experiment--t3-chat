# Playwriter Snippets

Use these snippets from the repo root.

## Create Session

```powershell
$sessionOutput = pnpx playwriter session new
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
```

When Playwriter reports multiple Edge profiles, create the session with the explicit profile key:

```powershell
pnpx playwriter session new --browser profile:22d27012fb891135
```

## Recover Missing Extension Connection

Use this when the Playwriter extension looks active in the browser but `pnpx playwriter browser list` says `No browsers detected`.

```powershell
Start-Process -FilePath pnpx -ArgumentList @('playwriter','serve','--host','localhost','--replace') -WindowStyle Hidden
Start-Sleep -Seconds 3
pnpx playwriter browser list
```

If no extension is still detected, start a managed Edge profile with Playwriter's bundled extension and create a session from the reported `install:Edge:<id>` key:

```powershell
$profile = Join-Path $env:TEMP 'playwriter-t3-chat-profile'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
pnpx playwriter browser start $edge --user-data-dir $profile --headed
pnpx playwriter browser list
pnpx playwriter session new --browser install:Edge:<id>
```

## Install Harness

```powershell
pnpx playwriter -s $session --% -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

## Bind Existing Files Tab

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

## Observe

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.observe({ label: 'files route', search: /Files|Chat|Review|Toolbar/i });"
```

## Startup Redirect QA

Use this after installing the harness and binding the localhost tab. The console capture is filtered so noisy extension/browser logs do not hide app startup failures.

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: 'localhost:5173' }); await state.appPlaywriterHarness.startConsoleCapture({ search: /IndexRedirect|Missing default|Unauthenticated|organization|error/i }); await state.page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' }); await state.appPlaywriterHarness.waitForUrlIncludes({ urlIncludes: '/w/personal/home/files', timeout: 15000 }); await state.appPlaywriterHarness.observeRoute({ label: 'post-reset startup', search: /Files|Open organization|Preparing organization|Redirecting/i }); await state.appPlaywriterHarness.authSummary();"
```

## Read Captured Console

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.readConsoleCapture({ count: 50 });"
```

## Inspect Main Left Nav

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.inspectElement({ selector: '[aria-label]', attribute: { name: 'aria-label', value: 'Main navigation' }, actionSelector: 'a, button, [role=link], [role=button]', localStorageKeys: ['app_state::sidebar::main_app_open', 'app_state::sidebar::main_app_collapsed'] });"
```

## Inspect Organization Switcher Lists

Open the header switcher by its accessible name, then inspect the workspace list scroll metrics.

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/' }); await state.page.getByRole('button', { name: /Open organization and workspace switcher/i }).click(); await state.appPlaywriterHarness.observe({ label: 'organization switcher', search: /Organizations and workspaces|Create organization|Create workspace/i }); await state.appPlaywriterHarness.inspectElement({ selector: '.MainAppHeaderOrganizationSwitcherModalSelectPane[aria-label=\"Workspaces\"]', actionSelector: 'button, [role=button]', computedStyles: [{ name: 'workspace list', selector: '.MainAppHeaderOrganizationSwitcherModalSelectList', properties: ['maxHeight', 'overflowY', 'scrollbarGutter'] }] });"
```

## Close Organization Switcher

Use the specific close label so the file sidebar and nested modal close buttons do not make the locator ambiguous.

```powershell
pnpx playwriter -s $session --% -e "await state.page.getByRole('button', { name: 'Close organization switcher' }).click(); await state.appPlaywriterHarness.observe({ label: 'after closing organization switcher', search: /Open organization and workspace switcher/i });"
```

## Files Folder Create QA

See the Files Folder Create QA recipe in `references/files.md`. Keep the full flow there because it is route-specific.

## Long Playwriter Script From Temp File

Use a temp file for generated PDF sibling QA or any flow with many assertions. This avoids PowerShell quote parsing issues, especially with selectors containing quotes or JavaScript regexes.

```powershell
$scriptPath = Join-Path $env:TEMP 'playwriter-generated-pdf-qa.js'
@'
const fs = require("node:fs");
const path = require("node:path");
// Assign state.page, install network listeners, and run the QA flow here.
'@ | Set-Content -LiteralPath $scriptPath -Encoding utf8
pnpx playwriter -s $session -f $scriptPath --timeout 180000
```

For generated PDF sibling QA, see `references/files.md` and use fixture `.agents/skills/app-playwriter-harness/assets/files/r2-upload-sample.pdf`.

## Inspect Files Resize Handle

Checks the files-sidebar splitter geometry, grip icon contrast, and cursor at the grip center.

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' }); await state.appPlaywriterHarness.inspectElement({ selector: '.MyPanelResizeHandle', attribute: { name: 'aria-label', value: 'Resize files sidebar' }, computedStyles: [{ name: 'pill', selector: '.MyPanelResizeHandleGrip-pill', properties: ['backgroundColor', 'outlineColor', 'outlineWidth'] }, { name: 'icon', selector: '.MyPanelResizeHandleGrip-icon', properties: ['stroke', 'color', 'zIndex'] }], hitTargets: [{ name: 'grip center', selector: '.MyPanelResizeHandleGrip' }] });"
```

## Append A Durable Memory

```powershell
pnpx playwriter -s $session --% -e "state.appPlaywriterHarness.appendMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```
