# Playwriter Snippets

Use these snippets from the repo root.

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

## Propose A Durable Memory

```powershell
vp env exec pnpx playwriter -s $session --% -e "state.appPlaywriterHarness.proposeMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```

Re-read the returned target file, check that the entry is reusable and does not duplicate existing guidance or expose private data, then add it with the agent's targeted edit tool.
