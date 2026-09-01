# Collaboration Regression Playbook (Yjs Provider + Comments)

Run this after any change to the integrated collaboration code that used to live in the vendored
Liveblocks fork. That code now lives in the app:

- `packages/app/src/lib/files-yjs-provider.ts` — Yjs provider (sync, connect, retry)
- `packages/app/src/lib/files-yjs-awareness.ts` — awareness / presence broadcast
- `packages/app/src/lib/files-yjs-doc.ts` — doc lifecycle and sync status
- `packages/app/src/lib/file-editor-rich-text-extension.ts` — TipTap extension wiring
- `packages/app/src/lib/file-editor-rich-text-utils.ts` — thread helpers
- `packages/app/src/lib/file-editor-rich-text-ai-extension.ts` — AI extension

Also run it after upgrading `@liveblocks/core` or `@liveblocks/react-ui`. The app imports **runtime
internals** from `@liveblocks/core` (`Signal`, `DerivedSignal`, `autoRetry`, `HttpError`), and those are
not covered by semver.

The checks below are ordered so each one builds on the previous. Use a disposable file; never type into a
real user document.

## Setup

```powershell
vp env exec pnpx playwriter browser list
# copy the exact KEY, then:
vp env exec pnpx playwriter session new --browser <KEY>
vp env exec pnpx playwriter -s <id> -f .agents/skills/app-playwriter-harness/scripts/install-harness.js
```

Bind or open the route. If no app tab is Playwriter-enabled, take the `about:blank` tab and navigate it —
the signed-in Edge profile carries the session cookies:

```js
state.page = context.pages().find(function (p) { return p.url() === "about:blank"; }) || (await context.newPage());
await state.page.goto("http://localhost:5173/w/personal/home/files", { waitUntil: "domcontentloaded" });
```

Use `-f` runner files for everything. Multi-line `-e` is truncated at the first newline on this machine, and
`--% -e` misparses arrow functions.

Keep `--timeout` under `5000`. A step that cannot finish in 5s is usually a broken script, a changed
selector, or a page that is not ready — not a slow page. When a runner times out, do not raise the timeout:
split it into smaller steps and read the page in between (`snapshot`, `getLatestLogs`, `url()`). Keep
in-script Playwright waits shorter than the CLI timeout too, otherwise the CLI gives up while the runner
keeps executing in the relay and the next run double-applies its actions.

## 1. Provider sync and persistence

The single most important check. It proves the Yjs provider connects, sends, and rehydrates from Convex.

1. Create a disposable file with the sidebar `New file` button (creates `new-file*.md` at root).
   When the root folder view is open there are **two** `New file` buttons and `getByRole` fails with a
   strict-mode violation. Scope to the sidebar one:
   `page.locator('button[aria-label="New file"].FilesSidebarTopSection-actions-icon-button')`.
   Assert the URL gained a real `nodeId`; if it still says `nodeId=root`, the file was not created and
   the rest of this playbook will test the wrong document.
2. Wait for `.FileEditorRichText-editor-content` to be visible, click it, `Control+A`, type a unique marker.
3. Reload the page.
4. Poll `.FileEditorRichText-editor-content` innerText for up to ~15s and assert the marker is still there.

Pass: marker survives the reload.
Fail here means the provider is not writing to Convex or not rehydrating — check `files-yjs-provider.ts`.

## 2. Inline comment creation

Exercises `CommentsExtension` and the comment popover.

1. Click the editor, `Control+Home`, then `Shift+End` to select the first line.
2. Click `button[aria-label="Add comment"]` — a floating popover trigger that only exists while a
   non-empty selection is live. It is **not** named `Comment`: `getByRole("button", { name: "Comment",
   exact: true })` matches nothing and the click then hangs until the CLI timeout.
3. Wait for the composer `[contenteditable="true"][aria-label="Add comment to selection"]` to be
   visible, not for `getByRole("form", { name: "New document comment" })`. That form is in the DOM from
   page load and stays hidden until the popover opens, so waiting on it passes before the composer exists.
4. Fill the composer and submit `getByRole("button", { name: "Submit comment" })`.
5. Assert `.FileEditorRichTextAnchoredComments-thread-container` count is 1 and `[data-lb-thread-id]`
   is present. Read this in a **separate** runner: submit plus the settle wait regularly overruns the
   CLI timeout even though the submit itself landed.

Pass: one thread container appears.

## 3. Comment visible in the sidebar

Do **not** assert on `document.body.innerText` before opening the Comments tab — the thread text is not in
the body until the tab is active, which reads as a false failure.

1. Click `#app_file_editor_sidebar_tabs_comments`.
2. Read `.FileEditorCommentsThread-summary` text nodes.
3. Assert the comment text is present.

## 4. Comment persistence

1. Reload.
2. Open the Comments tab again and poll `.FileEditorCommentsThread-summary` for the comment text.

Pass: the thread comes back after reload.

## 5. Thread id round-trips through Markdown

This is the check that catches serialization regressions in the comments extension.

1. Navigate to the same node with `&view=plain_text_editor`.
2. Read `.FileNodeView-content-panel` innerText.

Pass: the Markdown source contains the comment span with its thread id, for example

```
# <span data-type="comment" data-lb-thread-id="n97dbkq2tp5w13928qtgq6g6rn8b7y82">…</span>
```

If the span or `data-lb-thread-id` is gone, comments will silently detach from their anchor text.

## 6. Diff editor still mounts with comment marks

1. Navigate to `&view=diff_editor`.
2. Wait for `[aria-label="File diff editor"]`, assert it mounts and has 2 `[role="textbox"]` panes.
3. Assert the diff text still shows the comment span.

## 7. Awareness / presence

1. Presence lives in the collapsed main sidebar as `.MainAppSidebarPresenceControl`, wrapped in a
   `MySidebarSection aria-label="Presence"` — a real `<section>`, so `getByRole("region", { name:
   "Presence" })` does match it. A `/files` route carries at least four named regions (the workspace
   content region, `File editor`, `Pending changes`, and this one), so scope region queries by name.
   The class and the aria-label `Show details about N online users` work as fallbacks.
2. If disabled, the control is `getByRole("button", { name: "Enable presence" })`.
3. Enable it, type in the editor, wait ~2s.
4. Assert `.MainAppSidebarPresenceControl-online-label` reads `1 Online` and the logs stay clean. The
   label sits inside the closed hovercard, so it is in the DOM but `visible: false` — read `textContent`,
   do not wait for visibility.

## Log expectations

After every step call `getLatestLogs({ page: state.page, sinceLastCall: true })`.

These are **expected and benign** — do not report them as regressions:

- `[warning] Clerk: Clerk has been loaded with development keys …`
- `[warning] ProseMirror expects the CSS white-space property to be set …`
- `[debug] [vite] connecting… / connected.`
- `[pageerror] no diff result available` — this comes from Monaco's own
  `diffProviderFactoryService`, not from app code. It fires when leaving the diff editor. The app already
  documents and works around it in `file-editor-diff.tsx` (`handleVisibilityChangeDiffRecovery`).

Treat these as real failures: `should_never_happen`, `Maximum update depth`, `TypeError`, `Uncaught`,
`Rate limit exceeded`, `presence:disconnect`.

## Cleanup

- Archive the disposable file: park the pointer away from the tree (`mouse.move(1400, 20)`), press `Escape`,
  wait ~600ms, then use the sidebar row menu scoped to the tree:
  `getByRole("tree").first().getByRole("button", { name: "More actions for <name>", exact: true })`
  and choose menu item `Archive`.
- If you enabled presence, turn it back off. The `Disable` button lives in an Ariakit hover card, which
  synthetic hover opens fine as long as the pointer changes position first:

  ```js
  await page.mouse.move(900, 500); // park, so the next move has a non-zero screen delta
  await page.locator(".MainAppSidebarPresenceControl-primary-action").first().hover();
  await page.locator(".MainAppSidebarPresenceControl-hovercard .MainAppSidebarPresenceControl-disable").click();
  ```

  Scope the click to the hovercard — an identical `Disable` button is rendered outside the portal and is
  `hidden` while the sidebar is collapsed. See `known-hazards.md` for why the parking move matters.

## Result baseline (2026-07-25)

First full run after the Liveblocks fork was integrated into app source. All checks passed:
provider sync, reload persistence, comment create, comment persistence, Markdown thread-id round-trip,
diff editor mount, presence 1 online user. Only the benign logs above appeared.

## Run 2026-07-25b — Liveblocks dead-code removal from `file-editor-rich-text-extension.ts`

Passed: editor mounts and accepts typing, comment create (composer, thread container, comment mark),
comment in the sidebar, Markdown thread-id round-trip, plain text view, diff editor mount with the
comment span.

Not run: reload persistence and presence. The working tree had a broken returns validator in
`convex/files_nodes.ts`, so `files_nodes:list_tree` failed and every reload fell back to `nodeId=root`;
anonymous auth was also minting a new user per load. Re-run those two checks once the tree query is
healthy.

## Run 2026-07-25c — full playbook, after the `list_tree` validator fix

All seven checks passed on a signed-in Edge profile (42 tree items, no `ReturnsValidationError`):
provider sync and reload persistence, comment create, comment in the sidebar, comment persistence,
Markdown thread-id round-trip, diff editor mount with the comment span, presence `1 Online`. Console
carried only the benign logs listed above — zero `should_never_happen` / `TypeError` / `Uncaught` /
`ReturnsValidation`.

Two selectors in this playbook were stale and are corrected above: the comment trigger is
`Add comment`, not `Comment`, and presence is not a `role="region"`.

Presence was left enabled at the end of this run because the `Disable` click was reported as impossible.
That was wrong — the hover worked and the locator did not. Cleanup above now has a verified recipe.

## Run 2026-08-09 — dispose flush in `files-yjs-provider.ts`

Change: `FilesConvexYjsStream.dispose()` now sends any still-queued outgoing updates in one final
best-effort mutation instead of dropping them. Before the fix, any edit made in the last ~500ms
debounce window before the provider was destroyed (Rich/Markdown view toggle, opening another
file) was silently lost — reproduced with a typed marker that vanished after a fast view toggle.

Ran check 1 (provider sync and persistence) as the affected surface: with the fix, a marker typed
immediately before a view toggle survives the editor remount (the fresh provider rehydrates it
from Convex) and shows up in the materialized markdown once materialization catches up (~15-30s).
Checks 2-7 were skipped: the diff only touches the outgoing-update queue in `dispose()`, not
comments, awareness, or the sync path. Logs stayed clean.
