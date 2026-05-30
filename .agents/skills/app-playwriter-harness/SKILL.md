---
name: app-playwriter-harness
description: Use Playwriter to inspect, debug, test, and learn this browser app through the user's existing Chrome tabs. Use when working on localhost app flows, /files editor behavior, sidebar/navigation clickability, browser QA, app-specific Playwriter helpers, or durable Markdown memories for repeated browser actions.
---

# App Playwriter Harness

Use this skill when a task needs the live t3-chat app in the user's browser. Keep the installed harness small and generic: use Playwriter directly, add only reusable primitives, and save task-specific workflows as Markdown recipes.

## Organization

- Keep `scripts/install-harness.js` limited to generic browser QA primitives: tab binding, observation, logs, hit testing, generic element inspection, and durable memory writes.
- Do not add feature-specific helpers or one-off QA flows to the installed harness. If a helper name contains a feature, component, route, or bug name, it probably belongs in `references/*.md` instead.
- Put reusable feature recipes in the nearest reference doc, such as `references/files.md` for `/files` behavior or `references/snippets.md` for short copyable commands.
- Prefer composing generic helpers from docs over growing the helper namespace. Promote a recipe into the harness only when it is broadly reusable across routes and components.

## Start

1. Read the installed `playwriter` skill first. If `playwriter` is not on PATH here, use `pnpx playwriter`.
2. Create an isolated session from the repo root:

```powershell
$sessionOutput = pnpx playwriter session new
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
```

3. Install the helper namespace in that session:

```powershell
pnpx playwriter -s $session --% -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

4. Bind to the target app tab before acting:

```powershell
pnpx playwriter -s $session --% -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

## Workflow

- Observe before acting: print the URL and call `state.appPlaywriterHarness.observe(...)` or raw `snapshot({ page: state.page })`.
- Prefer Playwriter accessibility locators and normal clicks. Do not use `{ force: true }`, `dispatchEvent`, or `element.click()` to bypass blockers.
- Use `state.appPlaywriterHarness.inspectElement(...)` or `hitTest(...)` for layout and clickability bugs before trying alternate clicks.
- Use `state.appPlaywriterHarness.latestLogs()` when a UI action fails or the app looks blank.
- Use `state.appPlaywriterHarness.hitTest({ x, y })` only for layout or clickability bugs where a visible element may be covered.
- For route-specific checks, read the relevant reference recipe and run it with generic helpers instead of adding a new helper function.
- Keep each execute call focused on one observation or one action, then observe again.

## Memories

Use `state.appPlaywriterHarness.appendMemory({ file, title, body })` only for reusable knowledge, such as stable selectors, route behavior, recurring blockers, or proven snippets.

Allowed memory files:

- `app-map.md`
- `files.md`
- `known-hazards.md`
- `snippets.md`

Do not store secrets, cookies, tokens, user-private payloads, run diaries, raw coordinates, or one-off app state.

## References

- Read `references/app-map.md` for stable app routes, landmarks, and selectors.
- Read `references/files.md` for `/files` route and file/sidebar basics.
- Read `references/file-node-view.md` for selected-file editor surfaces, comments, diff, and right-sidebar workflows.
- Read `references/known-hazards.md` before debugging browser interaction failures.
- Read `references/snippets.md` for short Playwriter commands.
