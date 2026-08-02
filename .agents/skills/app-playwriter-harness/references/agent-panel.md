# Agent Panel And AI Chat

Recipes for driving the in-app AI agent (files-page sidebar and `/chat` page). These rules include the 2026-06-12 agent eval and the 2026-07-24 queued-message QA passes.

## Stable selectors

| Surface | Selector |
| --- | --- |
| Agent tab in files sidebar | `#app_file_editor_sidebar_tabs_agent` |
| Composer (ProseMirror) | `.AiChatComposer-editor-content` |
| Send, queue, or save button | `[data-testid="ai-chat-send-button"]` (`aria-label` is `Send message`, `Queue message`, or `Save queued message`; Queue uses the normal send icon) |
| Stop button (while running with empty input) | `[aria-label="Stop generating"]` (the same action slot becomes Queue when the input has text) |
| Queued messages tray | `[data-testid="ai-chat-queued-messages"]` |
| Queued message | `[data-testid^="ai-chat-queued-message-ai_message-"]` (DOM order is execution order; read `data-queued-message-id`) |
| Edit or reorder queued message | `[data-testid="ai-chat-queued-message-edit"]` |
| Remove queued message | `[data-testid="ai-chat-queued-message-remove"]` |
| Resume paused queue | `[data-testid="ai-chat-queue-resume"]` |
| Cancel queued edit | Press Escape in the textbox named `Edit queued message` |
| Open chat tabs list | `[aria-label="Open chats"]` |
| New full-page chat | `getByRole('button', { name: 'New Chat', exact: true })` |
| New files-sidebar chat | `getByRole('button', { name: 'New chat', exact: true })` |
| Past chats picker items | `role=option` inside the picker popover |
| Message | `.AiChatMessage` |
| Bash tool disclosure | `summary[aria-label^="Bash"]` (`aria-label="Bash: <cmd>"`, `aria-busy` while running) |
| Bash terminal output | `[aria-label="Bash terminal output"]` (`role=textbox`) |
| Failed send | `role=alert` containing `Message failed to send.` + a `Retry` button |
| Pending-changes strip (above composer, only when the OPEN CHAT touched pending files) | `.FileEditorSidebarPendingStrip` (whole row is a button; clicking switches to the Pending changes tab; counts only docs whose `threadIds` include the open chat, so a fresh chat shows no strip even when the workspace has pending changes) |
| Pending-changes tab count badge | `.FileEditorSidebarPendingTabBadge` (inside `#app_file_editor_sidebar_tabs_pending`; absent at count 0; always the workspace-wide count) |
| Composer image attachment badges | `[aria-label="Image attachments"] li` (each has an `<img>` data-URL preview, a name `<span>`, and a `Remove <filename>` button) |
| Queued-message image count | `.AiChatQueuedMessages-attachments` inside the queued row |

`waitForSelector("[role=option]", { state: "visible" })` is a trap in the agent panel: the thread-picker options stay mounted while hidden, so the wait pins the first match — an invisible `FileEditorSidebarAgentThreadPicker-item` — and times out even when the popover you actually opened (for example the `Chat model:` picker) is showing its options. Read all `[role=option]` matches and filter by bounding rect instead of waiting on the first. Same family as the mounted-closed `[role=dialog]` hazard in `known-hazards.md`.

## Composer input (ProseMirror)

Use Playwright `fill()` on the editor content element, then wait for the send
button to become enabled before clicking it:

```js
await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
await state.page.locator(".AiChatComposer-editor-content").fill(prompt);
await state.page.waitForFunction(() => {
	const button = document.querySelector('[data-testid="ai-chat-send-button"]');
	return button instanceof HTMLButtonElement && !button.disabled;
});
await state.page.locator('[data-testid="ai-chat-send-button"]').click();
```

The composer can briefly unmount during the optimistic→persisted thread swap right after `New chat`; always wait for the selector before typing.

## Attaching images to the composer

Two ways in, both verified 2026-08-02:

- Real clipboard paste. Draw the image in the page, `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`, click `.AiChatComposer-editor-content`, then `keyboard.press("Control+v")`. The extension-mode Edge profile allows the clipboard write without `grantPermissions`. The filename comes from the OS clipboard, so the badge reads `image.png`, not a name you chose.
- Synthetic paste when you need a specific filename or the clipboard already holds text. Build a `DataTransfer` with a `File`, then dispatch `new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true })` on `.AiChatComposer-editor-content`.

The composer prefers real text over files, so a synthetic paste is ignored while `clipboardData.getData("text/plain")` has non-whitespace content. **The OS clipboard is shared with the human using the machine**: a `Control+v` can paste whatever they copied last into the composer. Clear the editor (`Control+a`, `Delete`) before asserting on composer text.

Drag-and-drop is a `DragEvent` sequence with the same `DataTransfer`: `dragenter` (on the form and on the editor, to exercise the depth counter), `dragover`, then `drop`. The form-level capture handler consumes it, so nothing lands in ProseMirror. `form.AiChatComposer` carries `AiChatComposer-state-drop-target` while a file drag is over it — the class only appears after a render, so poll it in a short `setTimeout`, not synchronously after the dispatch.

Image ingest is async (decode + canvas re-encode). Wait for `[aria-label="Image attachments"] li` rather than asserting right after the paste, and read `[data-sonner-toast]` in the **same** execute call as a rejection check (sonner auto-dismisses in ~4s).

## File mentions (@) in the composer

Typing `@` in any AI chat composer (thread, message edit, file-editor agent sidebar) opens a file/folder picker. Verified 2026-08-02:

- Popup: `[role=listbox][aria-label="Files and folders"]`, rows are `[role=option]`, capped at 50. It portals to the hoisting container, so locate it at document scope, not inside the composer.
- The `@` must start a word: an `@` typed directly after a letter (`doc@`) never opens the popup. Probes that retype a query after a previous one must add a leading space first.
- Enter or row click inserts a chip (`.AiChatComposerFileMention`) without sending; folders serialize with a trailing slash. The message serializes chips to `@/path/to/file.md` text.
- Escape closes only the popup. The mention renderer calls `stopPropagation()` on that Escape, so it never reaches the form's close handler or the chat-level Escape branch — a message edit stays open. The next Escape (popup closed) closes the edit/queue surface as usual.
- `fill()` bypasses the suggestion plugin (it replaces content without typing). Use `keyboard.type("@doc")` to open the popup.

## Doneness: waitIdle pattern

The Stop button blinks out between agent steps (tool-exec gaps), so a single "no Stop button" check fires too early. Require sustained idle — no Stop button AND no **visible** `aria-busy` element — for 3 consecutive 2 s samples. Visible-only matters: hidden hoisted modals keep `aria-busy="true"` while closed (0x0 rect) and would otherwise report busy forever.

## Rate limit + retry

`ai_chat_http` uses a token bucket (rate 4/min, capacity 1). The chat transport keeps an HTTP 429 inside the same AI SDK request: it reads the server's validated `retryAfterMs`, waits, then retries the same message id. Stop aborts this wait. Do not expect a queued message to disappear or show the failed-send UI for this normal rate-limit case.

When later messages are queued, any other failed active turn pauses the queue. The failed user stays in the transcript with `Message failed to send.` and its normal Retry action. Every later queued row must keep its stable id, text, and order. This also applies when the thread is still optimistic, an empty assistant placeholder exists, or Convex persisted the failed user before the assistant stream failed. Resume retries the visible failed turn before the queue continues. The message Retry action follows the same path. If that retry fails, the queue pauses again without claiming a follower.

Stop aborts the active turn and keeps later messages in a paused queue, but it does not show failed-send feedback. Verify that the tray, order, and text stay unchanged through sustained idle. Wait for the rate-limit bucket to refill, then click Resume and verify that draining follows the current queue order. The aborted active turn is not added back to the queue.

Do not validate post-Stop draining with a route that intercepts `/api/chat` before Convex. That stub cannot persist the stopped turn's user or assistant anchor, so the queue must wait and the test reports a false idle state. Use the real route. Before Stop, require a 200 response, visible assistant text, and a visible Stop button. This proves that the active turn reached the normal persistence flow.

Click queued message text to edit it in the main composer. The composer changes to `data-composer-mode="queue-edit"`, its textbox is named `Edit queued message`, and its only message action is `Save queued message`. Saving updates the same queued item and does not send by itself, but it can unblock the normal drain and let `/api/chat` start right away. Escape restores the normal draft without changing the queued item. Earlier messages keep draining while a later item is being edited; draining waits only when the edited item is next. An edit does not set or clear the separate Stop-owned paused state.

Drag from the queued message's primary action. A click edits the message, while a pointer or keyboard drag reorders it. Pointer and keyboard moves change the DOM order and the later request order. Queue draining waits for the drag to finish. Use stable row ids and text when checking the result; visible handles, position chips, and counters do not exist.

## Ready-made helpers

`scripts/agent-chat-helpers.js` installs `state.qa` (session-persistent) with `newChat()`, `send(text)`, `queue(text)`, `queueSnapshot()`, `editQueued(index, text)`, `cancelQueuedEdit(index)`, `reorderQueued(fromIndex, toIndex)`, `keyboardReorderQueued(fromIndex, direction, count)`, `stopQueue(ms)`, `resumeQueue()`, `waitIdle(ms)`, `waitDone(ms)` (idle + automatic rate-limit retry), `dump()`, and `readTerminal(index)`. `queue(text)` requires the accessible `Queue message` state and verifies the new stable row id and exact text. `queueSnapshot()` returns stable ids, exact text, edit state, composer text/labels, paused/full/running state, and the live status. Reorder helpers use the real pointer or keyboard drag sensors. Pointer reorder scrolls the source row into the tray before measuring it. Keep the destination close enough to stay visible, and use keyboard reorder for long offscreen moves. `stopQueue()` waits for both the Resume control and sustained idle. `newChat()` is for the files-sidebar Agent tab; it uses the accessible button and verifies that the app selected a new `ai_thread-*` tab. `waitDone()` throws when retries still fail or the message DOM never settles:

```powershell
vp env exec pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/agent-chat-helpers.js
```

A full scored scenario run is then: `state.qa.newChat()` → `state.qa.send(PROMPT)` → `state.qa.waitDone(280000)` → one `evaluate()` that dumps terminals + final `.AiChatMessage` text. Helper `console.log` output is lost across separate playwriter runs — log returned values from the calling script.

For long Bash-agent eval prompts in PowerShell, write one JavaScript runner under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/`, embed the prompt in that runner, and run it with `-f`. The CLI loads the runner before sandbox restrictions apply. Do not create a second prompt file in the repository or OS temp directory. Keep Playwriter calls sequential; concurrent calls against one session can destabilize the relay.

When evaluating through `/files`, the Agent sidebar tab is often more stable than switching to `/chat` because the file tree/editor context stays loaded. After a Convex deploy, reload the `/files` route, click `#app_file_editor_sidebar_tabs_agent`, and wait for `.AiChatComposer-editor-content` before sending the next prompt.

If a scenario asks the agent to edit an app file, manually accept and save pending edits before continuing unrelated browser work. The editor can show a pending-edits banner and a diff route with an `Accept all pending changes and save` button; leaving proposed edits unapplied can intentionally affect Bash pending-update scenarios but can also pollute later evals.

For `/tmp` eviction scenarios, require a second Bash call after file creation. Eviction and oversized-file discard happen after a command flushes scratch state, so same-command `ls` can show files that will not survive to the next Bash call. Avoid using diagnostic commands that write extra `/tmp` files, such as `tee /tmp/list.txt`, unless the side effect is part of the scenario; those files count toward the same path and byte caps and can trigger another eviction.

## Grep Eval Recipe

Use a deterministic app folder displayed as `/grep-eval` with synthetic Markdown files. In Bash, refer to it as `/home/cloud-usr/w/personal/home/grep-eval` or relative `grep-eval`, not raw `/grep-eval`. Cover single-file grep, no matches, `-n`, `-c`, `-l`, `-v`, `-A`/`-B`/`-C`, regex-looking literals, unsupported flags, recursive folder requests, Markdown formatting, and capped output. Keep setup batches small and verify with `find /home/cloud-usr/w/personal/home/grep-eval -type f --limit 20`.

Run each prompt in a fresh chat and record:

- first Bash command label
- Bash terminal output
- final assistant text
- elapsed seconds from `send` to `waitDone`
- whether the answer used only actual stdout/stderr

Score as pass only when single-file requests use `grep`, folder/recursive content requests use `search --path` or the supported `grep -R` recovery, empty stdout with exit 1 is treated as no match, warnings do not cause retry loops, and unsupported flags lead to a concise explanation or a corrected supported command.

PowerShell command shape from the repo root:

```powershell
vp env exec pnpx playwriter browser list
# Choose the exact browser key whose browser exposes the target app tab.
$browserKey = "<exact KEY from browser list>"
$sessionOutput = vp env exec pnpx playwriter session new --browser $browserKey
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
vp env exec pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/install-harness.js --timeout 60000
vp env exec pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/agent-chat-helpers.js --timeout 60000
```

## Cat Eval Recipe

Use a deterministic app folder displayed as `/cat-eval` with synthetic Markdown files. In Bash, refer to it as `/home/cloud-usr/w/personal/home/cat-eval` or relative `cat-eval`, not raw `/cat-eval`. Cover simple `cat`, `cat -n`, `cat -- -dash.md`, `cat -- -` stdin, missing file, directory, large first-page behavior, multi-file small concatenation, multi-file large refusal, unreadable-file stderr advisories, and `cat file | grep`. Verify setup preconditions with `find` or `wc` before scoring edge cases, especially dash-leading names and over-cap files; if setup normalized or failed to materialize the fixture, record that as setup failure rather than a cat failure.

Run each prompt in a fresh chat and record:

- first Bash command label
- Bash terminal stdout and stderr separately
- final assistant text
- elapsed seconds from `send` to `waitDone`
- whether the answer treated stderr advisories as diagnostics rather than file content

Score as pass only when the agent does not hallucinate file content, uses `head`/`sed` continuation when a large `cat` reports a bounded page, does not pipe unreadable-file advisory text into later reasoning, and does not retry-loop on missing files, directories, or unreadable source files.

## Recover a blanked tab after Convex deploy

`convex dev --once` (and Vite HMR) can blank a backgrounded localhost tab: empty `<body>`, every selector gone. Recover with:

```js
await state.page.goto("http://localhost:5173/w/personal/home/files?nodeId=<id>", { waitUntil: "domcontentloaded" });
await state.page.waitForSelector("#app_file_editor_sidebar_tabs_agent", { state: "attached", timeout: 30000 });
await state.page.evaluate(() => document.querySelector("#app_file_editor_sidebar_tabs_agent").click());
await state.page.waitForSelector(".AiChatComposer-editor-content", { state: "attached", timeout: 30000 });
```

Run it after every deploy before sending the next prompt.

## Backgrounded-tab rules

When the app tab is not foregrounded:

- `snapshot()`, `screenshot()`, and `innerText` are unreliable — read via `evaluate()` with `textContent`, `getComputedStyle`, `getBoundingClientRect`.
- Playwright `locator.click()` on popover triggers (thread picker) can hang; DOM `el.click()` works, and picker `role=option` items need a pointer+mouse event sequence. Prefer foregrounding the tab when interaction discipline matters; treat DOM clicks as the documented backgrounded-tab exception to the no-`element.click()` rule.

## Chat page and branching

- `/w/personal/home/chat?threadId=<id>` loads that thread; switching threads updates the URL. Allow ~10 s for messages to load before reading counts.
- `Branch chat here` (message action) creates a branched thread that inherits `/tmp` files and cwd; the new thread gets a sidebar tab with `aria-selected=true`.
