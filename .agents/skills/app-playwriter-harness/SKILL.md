---
name: app-playwriter-harness
description: Use Playwriter to inspect, debug, test, and learn this browser app through the user's existing Chrome tabs. Use when working on localhost app flows, /files editor behavior, sidebar/navigation clickability, browser QA, app-specific Playwriter helpers, or durable Markdown memories for repeated browser actions.
---

# App Playwriter Harness

Use this skill when a task needs the live t3-chat app in the user's browser. Keep the harness small: use Playwriter directly, add only tiny helpers, and save only durable lessons that will help future browser work.

## Start

1. Read the installed `playwriter` skill first. If `playwriter` is not on PATH here, use `pnpm dlx playwriter@latest`.
2. Create an isolated session from the repo root:

```powershell
$session = pnpm dlx playwriter@latest session new
```

3. Install the helper namespace in that session:

```powershell
pnpm dlx playwriter@latest -s $session -e "const fs = require('node:fs'); const code = fs.readFileSync('.agents/skills/app-playwriter-harness/scripts/install-harness.js', 'utf8'); await eval(code);"
```

4. Bind to the target app tab before acting:

```powershell
pnpm dlx playwriter@latest -s $session -e "await state.appPlaywriterHarness.bindOpenTab({ urlIncludes: '/w/personal/home/files' });"
```

## Workflow

- Observe before acting: print the URL and call `state.appPlaywriterHarness.observe(...)` or raw `snapshot({ page: state.page })`.
- Prefer Playwriter accessibility locators and normal clicks. Do not use `{ force: true }`, `dispatchEvent`, or `element.click()` to bypass blockers.
- Use `state.appPlaywriterHarness.inspectLeftNav()` for sidebar/nav click bugs before trying alternate clicks.
- Use `state.appPlaywriterHarness.latestLogs()` when a UI action fails or the app looks blank.
- Use `state.appPlaywriterHarness.hitTest({ x, y })` only for layout or clickability bugs where a visible element may be covered.
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
- Read `references/files.md` for `/files` editor and sidebar notes.
- Read `references/known-hazards.md` before debugging browser interaction failures.
- Read `references/snippets.md` for short Playwriter commands.
