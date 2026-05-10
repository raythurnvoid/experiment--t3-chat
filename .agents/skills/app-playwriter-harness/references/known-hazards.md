# Known Browser Hazards

Use this file for reusable problems that affect app browser QA.

## Playwriter Availability

- The global `playwriter` command may not exist on this machine. Use `pnpx playwriter`.
- Create sessions from the repo root so the scoped Playwriter filesystem can read and append skill files.
- Use extension mode by default. Do not use direct CDP unless the user explicitly asks for it.
- In PowerShell, prefer `pnpx playwriter -s $session --% -e "..."` for Playwriter execute calls. Put `--%` after `-s $session` so PowerShell expands the session id but keeps JavaScript quotes intact.
- When `--%` is not usable, keep `-e` snippets very small and verify a trivial string command first, for example `console.log('hello')`.
- Avoid JavaScript template literals in PowerShell `-e` snippets. PowerShell treats backticks as escapes, so use string concatenation or put the script in a file/here-string before passing it to Playwriter.
- `pnpx playwriter session new` can print status text plus the session id. Parse the `Session <id> created` line instead of using the whole trimmed output as the id.

## Interaction Discipline

- Always bind `state.page` to the target tab before acting.
- Observe with `snapshot()` before clicking.
- Do not use `{ force: true }`, `dispatchEvent`, or DOM `element.click()` to bypass blockers.
- For clickability bugs, use `hitTest(...)` or `inspectElement(...)` to identify the topmost element instead of retrying alternate selectors.

## App State

- Viewport and sidebar state may persist between sessions through browser storage.
- Main sidebar open/collapsed state is persisted in localStorage keys documented in `app-map.md`.


## Closed main sidebar must actually leave layout

If the main sidebar looks visible but its links are not clickable, inspect `.MainAppSidebar` and `.MySidebar-state-closed` together. A component-layer display rule can override the shared closed-state display: none, leaving visible inert links whose hit-test target is RootLayout instead of the link.
