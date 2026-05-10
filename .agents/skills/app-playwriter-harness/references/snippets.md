# Playwriter Snippets

Use these snippets from the repo root.

## Create Session

```powershell
$sessionOutput = pnpx playwriter session new
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
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

## Inspect Main Left Nav

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.inspectElement({ selector: '[aria-label]', attribute: { name: 'aria-label', value: 'Main navigation' }, actionSelector: 'a, button, [role=link], [role=button]', localStorageKeys: ['app_state::sidebar::main_app_open', 'app_state::sidebar::main_app_collapsed'] });"
```

## Files Folder Create QA

See the Files Folder Create QA recipe in `references/files.md`. Keep the full flow there because it is route-specific.

## Inspect Files Resize Handle

Checks the files-sidebar splitter geometry, grip icon contrast, and cursor at the grip center.

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' }); await state.appPlaywriterHarness.inspectElement({ selector: '.MyPanelResizeHandle', attribute: { name: 'aria-label', value: 'Resize files sidebar' }, computedStyles: [{ name: 'pill', selector: '.MyPanelResizeHandleGrip-pill', properties: ['backgroundColor', 'outlineColor', 'outlineWidth'] }, { name: 'icon', selector: '.MyPanelResizeHandleGrip-icon', properties: ['stroke', 'color', 'zIndex'] }], hitTargets: [{ name: 'grip center', selector: '.MyPanelResizeHandleGrip' }] });"
```

## Append A Durable Memory

```powershell
pnpx playwriter -s $session --% -e "state.appPlaywriterHarness.appendMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```
