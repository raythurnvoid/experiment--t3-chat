# Playwriter Snippets

Use these snippets from the repo root.

## Create Session

```powershell
$session = pnpx playwriter session new
```

## Install Harness

```powershell
pnpx playwriter -s $session -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

## Bind Existing Files Tab

```powershell
pnpx playwriter -s $session -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

## Observe

```powershell
pnpx playwriter -s $session -e "await state.appPlaywriterHarness.observe({ label: 'files route', search: /Files|Chat|Review|Toolbar/i });"
```

## Inspect Main Left Nav

```powershell
pnpx playwriter -s $session -e "await state.appPlaywriterHarness.inspectLeftNav();"
```

## Files Folder Create QA

Runs the current-folder toolbar, create modal defaults, deep-path creation, duplicate validation, and single-tab checks in the bound `/files` tab.

```powershell
pnpx playwriter -s $session -e "await state.appPlaywriterHarness.testFilesFolderCreateFlow();"
```

## Append A Durable Memory

```powershell
pnpx playwriter -s $session -e "state.appPlaywriterHarness.appendMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```
