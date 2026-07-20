# Pending Path Overlay (mv/cp) Regression

Goal: validate the bash `mv`/`cp` pending-move overlay end to end: pending update docs, path-overlay reads, accept ordering guard, swap cycle accept (files and folders), cancel-on-return, cp-onto-vacated guard, and the live "Replaces" caption.

Route: an already-open Playwriter-enabled `/w/:organizationName/:workspaceName/files` tab.

## Scope

Covers the user-facing flows around `files_pending_updates` move/copy proposals driven from the Agent chat bash tool, and the Files sidebar pending panel that reviews them. Run it after changes to `packages/app/server/bash-mv-command.ts`, `packages/app/server/bash.ts`, `packages/app/convex/files_pending_updates.ts`, or `file-editor-sidebar-pending.tsx`.

## Preflight

1. Confirm the dev app is running at `http://localhost:5173` and a `/files` tab is open with the Playwriter extension enabled. Keep everything in ONE tab.
2. Read the Playwriter docs once per session (`vp env exec pnpx playwriter skill`), then `vp env exec pnpx playwriter session new` (extension mode — do not fight Edge CDP; Edge 150+ never binds 9222 on the default profile).
3. Bind the tab: `state.page = context.pages().find((p) => p.url().includes("localhost:5173"))`.
4. Windows gotcha: multiline `-e` args get mangled by PowerShell — put every multiline snippet in a file and run `vp env exec pnpx playwriter -s <id> -f <file>`. Poll loops longer than 10s need `--timeout <ms>` on the CLI call.
5. Verify clean state: pending panel empty and no leftover test-prefixed tree rows.

## Durable selectors

- Files tree: container `role="tree"` named `Files`; rows are `[role="treeitem"]` buttons with `aria-label` = node name and `data-file-id` = the `files_nodes` id (use it to disambiguate duplicate names); rename input `.FilesSidebarTreeItemTitle-input` (F2 on a clicked row). One row always keeps `tabindex="0"`, so Tab reaches the tree and arrow keys rove.
- Pending panel (stays in DOM even when its tab is hidden — readable always, clickable only when the tab is active): scope everything to `.FileEditorSidebarPending`; rows `.FileEditorSidebarPending-item`, caption `.FileEditorSidebarPending-item-caption`, per-row accept `button.FileEditorSidebarPending-accept`, per-row Discard button by text.
- Row action buttons carry aria-labels derived from row data: `Accept move of /a.md to /b.md`, `Discard move of /a.md to /b.md`; content/replace-move rows use `Accept changes to <destPath>` / `Discard changes to <destPath>`. Prefer `getByRole("button", { name: ... })` with these over CSS + text filtering when targeting one row. The labels and row paths are LIVE — a UI rename/move of the source node re-derives them immediately, so always re-read the row right before clicking.
- Settled signal: `.FileEditorSidebarPending-status` is an sr-only `role="status"` span inside the panel. On success it gets `Accepted <action>` / `Discarded <action>` / `Accepted N pending changes` / `Discarded N pending changes`. It KEEPS the last message — snapshot its textContent before clicking and treat a CHANGE as the settled signal, then stop polling immediately (typically well under 1s; no fixed waits). GOTCHA: the span does NOT exist before the first accept/discard of the browser session — `locator.textContent()` on it auto-waits 30s and hangs the script. Read it via `page.evaluate(() => document.querySelector(".FileEditorSidebarPending-status")?.textContent ?? null)` or pass `{ timeout: 500 }`.
- Row clearance can lag the status change by up to a few seconds (Convex reactivity) — after the status fires, poll row count instead of asserting immediately.
- Archived files: archived nodes disappear from the tree; the reveal affordance is a `menuitemcheckbox` named `Show N items archived` / `Hide N items archived` inside the sidebar-header `More options` (ellipsis) menu (`unmountOnHide` — absent from DOM until the menu opens). While shown, archived rows get aria-label `<name> archived`. The checkbox does NOT close the menu on click — press Escape or click elsewhere before re-clicking `More options`, else the second trigger click just closes the menu and the item click hangs.
- Sidebar tabs: `#app_file_editor_sidebar_tabs_pending` / `#app_file_editor_sidebar_tabs_agent` — click the tab before clicking inside its panel.
- Chat composer: `[contenteditable="true"][aria-label="Send a message..."]`; send `[data-testid="ai-chat-send-button"]`.
- Chat run state: the thread root exposes `data-ai-chat-state` = `idle` | `streaming` | `tool-running`. Preferred turn-done check: poll `[data-ai-chat-state]` at ~250ms until it returns to `idle` (guard against "never saw it running" with an assistant-message count baseline). Fallback heuristic: send button present again plus no `.AiChatMessagePartToolStatus-state-loading`.
- Assistant turn: last `.AiChatMessage[data-ai-chat-message-role="assistant"]`; bash output in `.AiChatMessagePartToolBash-terminal` (`<pre>`, textContent-safe while collapsed).
- Toasts: `[data-sonner-toast]` — poll at ~300ms right after Accept clicks; error toasts appear within ~1s.
- Editor content: `.FileEditorRichText-editor-content` (tiptap). Typed first line becomes an H1, so `cat` output shows `# <word>`.

## Chat-driving rules

- Always prefix prompts with "The app files are in your current directory." and use cwd-relative paths (`mv a.md b.md`). Absolute `/a.md` paths are OUTSIDE the sandboxed app tree and fail with EROFS instead of creating proposals.
- Keep prompts single-line (`keyboard.type` submits on `\n`). End with "Do not do anything else."
- Start a fresh chat per scenario ("New chat" button in the Agent tab); follow-ups within a scenario can reuse the chat.
- Trust the bash tool-part terminal text over the model's prose summary.

## Fixture helper (committed file/folder creation)

1. There are TWO "New file" buttons with different behavior:
   - Sidebar tree header `role=button[name="New file"]` (nth=0): creates a committed `new-file.md` at the ROOT instantly, no dialog. Same for "New folder".
   - Main-view `role=toolbar[name="File actions"]` New file (nth=1): opens a MODAL dialog (accessible name `New file` / `New folder` via its heading, so `getByRole("dialog", { name: "New file" })` works; contains `textbox "Name"` + `Create file`) and creates in the CURRENT main-view folder. While it is open, `.MyModalBackdrop` swallows every click in the app — a hung row click usually means this dialog is up.
2. Rename flow: click the new row, press F2, wait for `.FilesSidebarTreeItemTitle-input:focus`, `Control+a`, type the target name, Enter.
3. To create a child inside a folder: clicking the folder row navigates the main view into it (URL `?nodeId=<id>`); then use the File actions toolbar New file dialog. Selecting the folder row does NOT retarget the sidebar-header New file button — that one still creates at root. The row "More actions" menu has no Add file item (only Copy path / Rename / Expand subtree / Collapse subtree / Archive).
4. Collapsed folders render no child `[role="treeitem"]` rows — expand before asserting child presence. Use the chevron `button[aria-label="Expand folder <name>"]` (visible, but rendered outside the treeitem element) or row click + `ArrowRight`. Do NOT use `Add file to <name>` just to expand — it also creates a committed child (intended product design, not a bug; just a QA click hazard).
5. For content: click the row, click `.FileEditorRichText-editor-content`, `Control+a`, type one word. Select-all replace is imperfect (template fragments can survive) and the first typed line becomes an H1 — treat the typed word as a marker substring, do not assert exact content.

## Scenario 1 — simple rename with overlay reads

1. Create committed `/pwl-a.md` with marker word content.
2. Chat: `mv pwl-a.md pwl-b.md`.
3. Expect bash `exit 0`, stdout `pending move created: /pwl-a.md -> /pwl-b.md — review in Files`.
4. Pending panel: one row `/pwl-a.md → /pwl-b.md`, caption `Moved`.
5. Chat follow-up: `cat pwl-b.md` then `cat pwl-a.md`.
6. Expect: `cat pwl-b.md` exit 0 printing the file content (the overlay projects the file at its NEW path pre-accept); `cat pwl-a.md` exit 1 `No such file or directory`.
7. Switch to the pending tab, click the row's Accept (aria-label `Accept move of /pwl-a.md to /pwl-b.md`). The status region flips to `Accepted move of /pwl-a.md to /pwl-b.md`, the row clears, zero toasts, tree shows `pwl-b.md` and no `pwl-a.md`.

Expected result: overlay reads reflect the pending rename before accept; accept applies it without toasts.

## Scenario 2 — folder move with subtree overlay

1. Create committed folder `/pwl-dir` containing `/pwl-dir/pwl-child.md` (see fixture helper step 3).
2. Chat: `mv pwl-dir pwl-moved`.
3. Expect exit 0, `pending move created: /pwl-dir -> /pwl-moved`; panel row `/pwl-dir → /pwl-moved`, caption `Moved`.
4. Chat follow-up: `tree pwl-moved` then `tree pwl-dir`. Target the paths directly — plain `tree .` paginates (10 default, `--limit` clamps at 20) and alphabetically late names fall off the first page.
5. Expect: `tree pwl-moved` exit 0 listing `pwl-child.md`; `tree pwl-dir` exit 1 `No such file or directory`.
6. Accept the row: the status region fires and the row clears, no toasts; committed tree shows `pwl-moved` at level 1 with `pwl-child.md` at level 2 after expanding, and no `pwl-dir`.

Expected result: the whole subtree is projected at the new folder path pre-accept, and accept commits the folder rename.

## Scenario 3 — dependent moves and the accept-ordering guard

1. Create committed `/pwl-c.md` and `/pwl-d.md`.
2. Chat: `mv pwl-d.md pwl-e.md`, then `mv pwl-c.md pwl-d.md` (both exit 0; two pending rows, both caption `Moved`).
3. Click Accept on the DEPENDENT row (`/pwl-c.md → /pwl-d.md`) first.
4. Expect: sonner toast exactly `Accept the pending move of "pwl-d.md" first`, and BOTH rows survive (poll rows + toasts; the toast shows within ~1s and the status region does NOT change — exit on the toast).
5. Click the panel's Accept all button (filter panel buttons by `/accept all/i`).
6. Expect: status region reports `Accepted 2 pending changes`, both rows clear, no toasts; tree shows `pwl-d.md` and `pwl-e.md`, no `pwl-c.md`.

Expected result: single-accept enforces dependency order with the exact toast; Accept all resolves the whole dependency unit itself.

## Scenario 4 — file swap cycle accepted atomically

1. Create `/pwl-x.md` (marker "xray") and `/pwl-y.md` (marker "yankee").
2. Chat, one turn: `mv pwl-x.md pwl-tmp.md`, then `mv pwl-y.md pwl-x.md`, then `mv pwl-tmp.md pwl-y.md`.
3. Expect three exit-0 outputs; the third replaces the first proposal so the panel shows exactly TWO mirrored rows (`/pwl-x.md → /pwl-y.md` and `/pwl-y.md → /pwl-x.md`), both caption `Moved`, NEITHER showing `Replaces`.
4. Accept ONE row (filter by the FULL arrow text — both rows contain both file names).
5. Expect: the status region fires and BOTH rows clear (the swap cycle applies atomically), zero toasts; tree still shows `pwl-x.md` + `pwl-y.md` and no `pwl-tmp.md`; opening the files shows the contents swapped.

Regression signature (old bug): toast `Accept the pending move of ...` on a 2-member swap cycle and rows surviving.

## Scenario 4b — folder swap cycle accepted atomically

1. Create committed folders `/pwl-p` and `/pwl-q`, each with one child file (`/pwl-p/pwl-p-child.md` marker "papa", `/pwl-q/pwl-q-child.md` marker "quebec" — fixture helper step 3).
2. Chat, one turn: `mv pwl-q pwl-tmp-dir`, then `mv pwl-p pwl-q`, then `mv pwl-tmp-dir pwl-p`.
3. Expect three exit-0 outputs; the panel shows exactly TWO mirrored rows (`/pwl-p → /pwl-q` and `/pwl-q → /pwl-p`), both caption `Moved`.
4. Accept ONE row (full arrow text, as in scenario 4).
5. Expect: the status region fires and BOTH rows clear, zero toasts; tree still shows `pwl-p` + `pwl-q` and no `pwl-tmp-dir`; expanding the folders shows the children traveled with them (`pwl-q` now contains `pwl-p-child.md` and `pwl-p` contains `pwl-q-child.md`), and opening a child shows its marker at the new path.

Regression signature (round-16 bug): the closing `mv` fails instead of creating the swap cycle, or accept leaves both rows stuck with toast `Accept the pending move of ...`.

## Scenario 5 — cancel-on-return

1. Create committed `/pwl-m.md`.
2. Chat: `mv pwl-m.md pwl-n.md`, then `mv pwl-n.md pwl-m.md`.
3. Expect: first command creates the pending move; second prints exactly `pending move cancelled: the file stays at /pwl-m.md` with exit 0, and the panel goes empty (`.FileEditorSidebarPending-empty`).

Expected result: moving a pending file back to its source cancels the proposal instead of stacking a second one.

## Scenario 6 — cp onto a vacated path is rejected

1. Create committed `/pwl-src.md` (and have `/pwl-m.md` committed from scenario 5).
2. Chat: `mv pwl-m.md pwl-gone.md`, then `cp pwl-src.md pwl-m.md`.
3. Expect: mv exit 0 with a pending move; cp exit 1 with stderr `cp: cannot create '/pwl-m.md': the path is vacated by your pending move. Accept or discard that proposal first, or choose a different destination path.`; the panel shows ONLY the move-only row (no content or copy row); the agent's prose reports the failure.
4. Discard the row (per-row Discard button); panel returns to empty.

## Scenario 7 — Replaces caption is live and accept archives the occupant

1. Chat: `mv pwl-src.md pwl-occ.md` while `/pwl-occ.md` does NOT exist. Row caption is `Moved`.
2. Create committed `/pwl-occ.md` in the Files UI.
3. Expect: the row caption flips to `Replaces pwl-occ.md` immediately (reactive — it is already flipped by the time a poller starts right after the rename commits).
4. Accept the row.
5. Expect: the status region fires and the row clears, no toasts; tree shows exactly one `pwl-occ.md` and no `pwl-src.md` (the occupant was archived, the moved file now owns the path).

## Scenario 8 — chained mv -f replaces consume the whole chain

1. Create committed `/pwl-f.md` ("alpha"), `/pwl-g.md` ("beta"), `/pwl-h.md` ("gamma") — e.g. via chat `write_file` + Accept all.
2. Chat, one turn: `mv -f pwl-f.md pwl-g.md && mv -f pwl-g.md pwl-h.md`.
3. Expect exit 0 with TWO stdout lines `pending replace created: /pwl-f.md -> /pwl-g.md ...` and `... /pwl-g.md -> /pwl-h.md ...`; panel shows two rows caption `Replaced` (`/pwl-f.md → /pwl-g.md`, `/pwl-g.md → /pwl-h.md`); replace-move rows use `Accept changes to <destPath>` labels.
4. Accept the SECOND link FIRST (`Accept changes to /pwl-h.md`).
5. Expect: status fires `Accepted changes to /pwl-h.md`, then BOTH rows clear (poll — clearance can lag the status by a few seconds), zero toasts; `pwl-h.md` content is "alpha" (the chain result); `pwl-f.md` AND `pwl-g.md` both leave the active tree and both show under `Show N items archived` with aria-label `<name> archived`. The Versions entry for the new content may lag ~30s (async materialization) — do not wait for it.

Regression signature (old bug): accepting the second link left the first file active and silently lost its proposal (only one row consumed).

## Cleanup

1. Discard any leftover pending rows (scope to `.FileEditorSidebarPending`, filter rows by the FULL `"/x.md → /y.md"` text — swap cycles produce mirrored rows where a single file name matches both).
2. Archive every test-prefixed tree row: `role=button[name="More actions for <name>"]` → menuitem `Archive`.
3. Verify: pending panel `.FileEditorSidebarPending-empty` present, zero test-prefixed `[role="treeitem"]`, no error toasts, `getLatestLogs` clean.

## Live-session stability (critical gotcha)

Writing or editing app source files under `packages/app/` while the vite dev server runs triggers HMR/full reloads in the live tab. Agent/docs paths are excluded from the watcher (`.claude/**`, `.agents/**`, `AGENTS.md`, `CLAUDE.md` — see `vite.config.ts` `server.watch.ignored`), so editing this playbook or agent memory mid-session is safe. Two observed failure shapes for real source edits, both dev-only:

- Blank page: body collapses to the index.html shell with an empty `#root` and a `?t=<ts>` on the main script; no console errors; it does NOT self-recover — `page.reload()` fixes it.
- Error boundary: `Something went wrong` with `Error: useAppAuth must be used within AppAuthProvider` and `?t=`-stamped module URLs (HMR broke React context identity). `Try again` does NOT recover; only a full reload does. Read the stack from the `Technical details` disclosure via `snapshot()` (its textbox is not exposed through `innerText`).

Rules: batch any repo-file writes to BEFORE or AFTER the browser-driving phase; after any unexpected blank/crash, reload, re-verify the tree/panel state (pending proposals and chats survive reloads), and continue.

## Failure Triage

- Accept clicked but row survives + toast `Accept the pending move of "..." first`: dependency-ordering guard fired — this is EXPECTED when accepting a move whose destination is vacated by another pending move (see scenario 3); it is a BUG only for swap cycles (file or folder), which must clear atomically.
- Click timeouts on pending rows: the pending tab is probably not active — panels stay mounted but hidden; click `#app_file_editor_sidebar_tabs_pending` first.
- `EROFS: read-only file system`: the prompt used absolute paths; re-send with cwd-relative paths.
- Turn never goes idle: read `[data-ai-chat-state]` directly (`streaming` vs `tool-running` tells you where it is stuck), then check `.AiChatMessagePartToolStatus-state-loading` and the send/stop button; cold Convex deployments can make the first turn take 30s+.
