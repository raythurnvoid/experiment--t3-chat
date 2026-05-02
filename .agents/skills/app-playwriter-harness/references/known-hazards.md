# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Use `pnpm dlx playwriter@latest`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read and append skill files.
- Use extension mode by default. Do not use direct CDP unless the user explicitly asks for it.
- In PowerShell, use double quotes around `-e` and single quotes inside JavaScript strings. Single-quoted `-e` snippets can reach Playwriter with JavaScript string quotes stripped.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use hit-testing to identify the topmost element instead of retrying alternate selectors.

## App State

- Viewport and sidebar state may persist between sessions through browser storage.
- Main sidebar open/collapsed state is persisted in localStorage keys documented in `app-map.md`.


## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect .MainAppSidebar and .MySidebar-state-closed together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.
