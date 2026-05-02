# Playwriter Snippets

Use these snippets from the repo root.

## Create Session

```powershell
$session = pnpm dlx playwriter@latest session new
```

## Install Harness

```powershell
pnpm dlx playwriter@latest -s $session -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

## Bind Existing Pages Tab

```powershell
pnpm dlx playwriter@latest -s $session -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/pages' });"
```

## Observe

```powershell
pnpm dlx playwriter@latest -s $session -e "await state.appPlaywriterHarness.observe({ label: 'pages route', search: /Pages|Chat|Review|Toolbar/i });"
```

## Inspect Main Left Nav

```powershell
pnpm dlx playwriter@latest -s $session -e "await state.appPlaywriterHarness.inspectLeftNav();"
```

## Append A Durable Memory

```powershell
pnpm dlx playwriter@latest -s $session -e "state.appPlaywriterHarness.appendMemory({ file: 'known-hazards.md', title: 'Short reusable lesson', body: 'What future agents should remember.' });"
```
