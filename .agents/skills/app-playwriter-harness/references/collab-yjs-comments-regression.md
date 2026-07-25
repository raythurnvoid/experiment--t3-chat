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
2. Wait for `.FileEditorRichText-editor-content` to be visible, click it, `Control+A`, type a unique marker.
3. Reload the page.
4. Poll `.FileEditorRichText-editor-content` innerText for up to ~15s and assert the marker is still there.

Pass: marker survives the reload.
Fail here means the provider is not writing to Convex or not rehydrating — check `files-yjs-provider.ts`.

## 2. Inline comment creation

Exercises `CommentsExtension` and the comment popover.

1. Click the editor, `Control+Home`, then `Shift+End` to select the first line.
   The **Comment** button only exists while a non-empty selection is live.
2. Click `Comment`, wait for `getByRole("form", { name: "New document comment" })`.
3. Fill `[contenteditable="true"][aria-label="Add comment to selection"]` and submit
   `getByRole("button", { name: "Submit comment" })`.
4. Assert `.FileEditorRichTextAnchoredComments-thread-container` count is 1.

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

1. Presence lives in the collapsed main sidebar under `region "Presence"`.
2. If disabled, the control is `getByRole("button", { name: "Enable presence" })`.
3. Enable it, type in the editor, wait ~8s.
4. Assert the presence region reports at least 1 online user and the logs stay clean.

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
- If you enabled presence, note that turning it back off is unreliable from Playwriter (see
  `known-hazards.md`). Tell the user instead of leaving it silently changed.

## Result baseline (2026-07-25)

First full run after the Liveblocks fork was integrated into app source. All checks passed:
provider sync, reload persistence, comment create, comment persistence, Markdown thread-id round-trip,
diff editor mount, presence 1 online user. Only the benign logs above appeared.
