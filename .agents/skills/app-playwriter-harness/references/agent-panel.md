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
| Edit-file tool disclosure | `.AiChatMessagePartToolEditPage` (`summary` `aria-label="Edit file: <name>"`) |
| Tool `Parameters` / `Result` / `Error` blocks | `[aria-label="Result"]` etc. inside the card (`role=textbox`) |
| Generated picture | `.AiChatMessage img[alt="Generated image"]` (class `AiChatMessagePartToolImageGeneration-image`; while it is still drawing, the part is the disclosure titled `Generate image`) |
| Chat mode picker | `getByRole("combobox", { name: /^Chat mode:/ })`, then `getByRole("option", { name: "Agent" \| "Ask" })` |
| Failed send | `role=alert` holds only the text `Message failed to send.`; the `Show error details` and `Retry` buttons are its siblings inside `.AiChatMessageUserSendError`, so search at page scope, not inside `[role=alert]`. The details dialog is named `Error details` and its raw message textbox is named `Raw error message` |
| Pending-changes strip (above composer, only when the OPEN CHAT touched pending files) | `.FileEditorSidebarPendingStrip` (whole row is a button; clicking switches to the Pending changes tab; counts only docs whose `threadIds` include the open chat, so a fresh chat shows no strip even when the workspace has pending changes) |
| Pending-changes tab count badge | `.FileEditorSidebarPendingTabBadge` (inside `#app_file_editor_sidebar_tabs_pending`; absent at count 0; always the workspace-wide count) |
| Composer image attachment badges | `[aria-label="Image attachments"] li` (each has an `<img>` data-URL preview, a name `<span>`, and a `Remove <filename>` button) |
| Chat model picker | `button.MySearchSelectTrigger` (its `aria-label` reads `Chat model: <name>`, but `getByRole("button", { name: /^Chat model:/ })` matches nothing — locate it by class) |
| Queued-message image count | `.AiChatQueuedMessages-attachments` inside the queued row |

`waitForSelector("[role=option]", { state: "visible" })` is a trap in the agent panel: the thread-picker options stay mounted while hidden, so the wait pins the first match — an invisible `FileEditorSidebarAgentThreadPicker-item` — and times out even when the popover you actually opened (for example the `Chat model:` picker) is showing its options. Read all `[role=option]` matches and filter by bounding rect instead of waiting on the first. Same family as the mounted-closed `[role=dialog]` hazard in `known-hazards.md`.

Before sending in a new chat, confirm its tab stays selected. `New Chat` on the full-page route can wedge the tab; a sidebar optimistic `ai_thread-*` tab can also disappear and return selection to an older chat. Do not assume the button created a usable chat. Use an existing chat only when it belongs to your QA run. See the stuck-tab and optimistic-tab entries in `known-hazards.md`.

## Tool cards keep a real rect while their disclosure is closed

A tool part renders as `<details class="AiChatMessagePartDisclosure">`, and the cards inside it (`.AiChatMessagePartToolTextAreaSection`, `.DiffMonospaceBlock`) still report a plausible `getBoundingClientRect` while the disclosure is closed. Neighbouring cards then report overlapping rects, and `document.elementFromPoint` at a card center returns `.AiChatMessagePartDisclosureButton` instead. A pointer probe aimed at those coordinates silently hovers the summary, so a hover test reports "nothing is hovered" and reads like a broken app.

Expand the disclosure first, then hit-test every candidate before using its coordinates:

```js
const disclosure = state.page.locator(".FileEditorSidebarAgent-chat-area-panel .AiChatMessagePartDisclosure").nth(7);
await disclosure.locator(".AiChatMessagePartDisclosureButton").first().scrollIntoViewIfNeeded();
await disclosure.locator(".AiChatMessagePartDisclosureButton").first().click({ timeout: 4000 });
// then, per candidate: document.elementFromPoint(x, y) must be inside the card
```

The layout does not settle in the same execute call as the expand: a hit test right after the click still reports every card unreachable. Hit-test in the next call.

## Read an edit_file card's diff without sending a new message

The `Result` block of an `edit_file` card renders the patch through `DiffMonospaceBlock`, one `<span>` per line, so a past chat is enough to check diff rendering — no new agent turn needed. Read the classes, not the colors:

```js
const card = Array.from(document.querySelectorAll(".AiChatMessagePartToolEditPage")).find((node) => node.open);
const pre = card.querySelector("[aria-label=Result]");
Array.from(pre.children).map((line) => [line.getAttribute("class"), line.textContent]);
// DiffMonospaceBlock-line-header | -added | -removed | -context
```

The `edit_file` tool already sends the patch trimmed to its changed lines: no `createPatch` file header (`Index:`, `===`, `---`, `+++`) and no `@@ -1,6 +1,6 @@` position lines, with an empty line where a later hunk starts. So the first line is already a diff line, and a `-header` class never appears. Messages persisted before 2026-08-13 still hold the full patch and render its header lines. The block's own box styles lose to `.AiChatMessagePartToolTextAreaSection-textarea` on purpose: inside a tool card it has no border, no background, `overflow: visible`, and the section scrolls instead.

## Scrollbar highlight probe

To check the app's scrollbar highlight standard (`app.css`, `@layer base`), read the computed `scrollbar-color` of the chat panel `.FileEditorSidebarAgent-chat-area-panel` while the pointer sits on a card. Dim is `oklch(0.305 0.008 85)` (`--color-base-1-07`), bright is `oklch(0.395 0.011 85)` (`--color-base-1-10`).

Two traps: a click leaves focus inside the panel and `:focus-within` keeps it bright no matter where the pointer is, so `document.activeElement.blur()` before a hover read; and park the pointer outside the panel between hovers so each `mouse.move` is a real position change. A card whose content fits carries the `app-scrollable-fits` class after the pointer or focus enters it (written by `app_scrollbar_install`), and a bar-less card must leave the panel bright.

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

## Message ids flip when a stream finishes

While a response streams, the last assistant `.AiChatMessage` has `data-ai-chat-message-id="ai_message-…"` (the client-generated id). When the response finishes and the persisted row syncs back, that attribute flips in place to the Convex message id. A probe that stored the streaming id and later looks the message up by it finds nothing — re-read the id after idle instead. The rendered content must NOT remount at that flip (open tool-output `details` stay open); that is guarded by `keeps an open tool output open when the streamed message is persisted` in `ai-chat-message.test.tsx`. To prove a remount in the browser, tag the DOM node (`el.__qaTag = "x"`) before the transition and check the tag survives after. Verified 2026-08-02.

## Two traps around a failed send and a fast turn

The `Error details` dialog stays open after you read it, and it keeps focus, so the next `fill()` on the composer writes nothing and the send button stays disabled — the run then fails at a `waitForFunction` that looks like the app is stuck. Press `Escape` and confirm no visible `[role=dialog]` remains before sending again.

`state.qa.queue(text)` only works while a turn is still running, because it waits for the send button's accessible name to be `Queue message`, and that internal wait is 10 s regardless of the CLI `--timeout`. A short first prompt finishes before the second `queue()` call and the helper times out with the queue half-filled. Give the first turn real work ("write a 1500-word essay about …") when you need two or more messages queued behind it.

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

`state.qa.newChat()` can time out at its `aria-selected` wait even though the click worked (seen 2026-09-05 on the files sidebar with several open chat tabs): the `New chat` button appends a new `ai_thread-*` tab to `[aria-label="Open chats"]`, but the selection stays on the old thread, so a send would land in that old chat. Work around it by clicking the newest `[role="tab"][id^="ai_thread-"]` yourself, then check that the selected tab id starts with `ai_thread-` and the panel holds 0 `.AiChatMessage` before `state.qa.send`. Report the unselected new tab as a possible app bug; it is not a helper bug.

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

`convex dev --once` (and Vite HMR) can blank a backgrounded localhost tab: empty `<body>`, every selector gone. If this happens, confirm `state.page` is the owned QA tab and read its current URL. Reload that page; keep its workspace and route:

```js
console.log(state.page.url());
await state.page.reload({ waitUntil: "domcontentloaded" });
await state.page.waitForSelector("#app_file_editor_sidebar_tabs_agent", { state: "attached", timeout: 30000 });
await state.page.locator("#app_file_editor_sidebar_tabs_agent").click();
await state.page.waitForSelector(".AiChatComposer-editor-content", { state: "attached", timeout: 30000 });
```

The Agent tab click is for the Files route. On the full chat route, wait for the composer after reloading. If a background click stalls, use the checked mouse-click fallback below. Repeat the affected check after recovery.

## Backgrounded-tab rules

When the app tab is not foregrounded:

- `snapshot()`, `screenshot()`, and `innerText` are unreliable — read via `evaluate()` with `textContent`, `getComputedStyle`, `getBoundingClientRect`.
- Playwright `locator.click()` can hang at `performing click action` on a background trigger. Read its current bounds, use the harness hit test to confirm the target is clear, then use a normal `page.mouse.click` at that observed point. Re-read the resulting state. Do not use forced or DOM clicks, or foreground the user's profile to work around it.

## Chat page and branching

- `/w/personal/home/chat?threadId=<id>` loads that thread; switching threads updates the URL. Allow ~10 s for messages to load before reading counts.
- `Branch chat here` (message action) creates a branched thread that inherits `/tmp` files and cwd; the new thread gets a sidebar tab with `aria-selected=true`.
- `state.qa.newChat()` is for the files-sidebar Agent tab only. On the full-page `/chat` route it waits forever on `[aria-label="Open chats"] [role="tab"][aria-selected="true"]`, because that route renders no tab strip. The route's own control is `New Chat` (capital C), and it can be rendered twice, so a plain `getByRole` click dies with a strict-mode violation — but do not click it at all right now, see the renderer wedge in `known-hazards.md`. To reach a new thread, start a fresh headless browser: with no session the app mints an anonymous user whose chat is empty, and `goto("/w/personal/home/chat")` lands on it. A `goto` without `threadId` in a browser that already has threads reopens the last one.

## Generated pictures (`image_generation`)

Prompt that reliably draws one: `Draw a small picture of a red circle on a white background.` The turn takes ~30-60 s. It works in both `Agent` and `Ask` mode; switch with the chat mode picker in the selector table.

Assert the DOM, not a screenshot:

```js
await state.qa.send("Draw a small picture of a red circle on a white background.");
await state.qa.waitDone(280000);
await state.page.evaluate(() =>
	Array.from(document.querySelectorAll('.AiChatMessage img[alt="Generated image"]')).map((img) => ({
		naturalWidth: img.naturalWidth, // > 0 proves R2 really served the bytes
		complete: img.complete,
	})),
);
```

The message stores only a reference, so check the persisted doc separately (`output` must be `{ assetId, mediaType, size }`, and the whole thread must hold no long base64 run):

```js
const { app_convex, app_convex_api } = await import("/src/lib/app-convex-client.ts");
const membership = await app_convex.query(app_convex_api.organizations.get_membership_by_organization_workspace_name, {
	organizationName: "personal",
	workspaceName: "home",
});
const listed = await app_convex.query(app_convex_api.ai_chat.thread_messages_list, {
	membershipId: membership._id,
	threadId: new URL(location.href).searchParams.get("threadId"),
});
```

Reload the page before believing the picture works: the live stream and the reload use different paths, and only the reload exercises `r2.create_signed_chat_image_url`.

Asset state lives outside the browser. Read it with `vp env exec pnpm --dir packages/app exec convex data files_r2_assets --limit 3 --order desc`: one `generated_image` doc per picture, `r2Key` set and `unfinalizedExpiresAt` empty once the message is stored. Two docs with the same `size` for one turn means the preview copy is being stored again (see the `image_generation` section of the `ai-chat-agent` skill).

`ai_chat.threads_list` needs `paginationOpts: { cursor: null, numItems: 10 }` and returns `{ page: [...] }`; without it the query throws `ArgumentValidationError`.

To check the per-model gate, count `.AiChatMessagePartToolImageGeneration-image` before and after a turn instead of creating a thread per model. Flip the selected model's `supportsImageGeneration` in `packages/app/shared/ai-chat.ts`, wait ~30 s for `convex dev` to push, reload, and send the same prompt in the same thread: the count must stay put and the assistant must say it cannot draw. Restore the flag and send once more to prove the count moves again. Editing a `shared/` file triggers a Vite reload, so the composer disappears for a moment — always reload and wait for `.AiChatComposer-editor-content` before `state.qa.send`, or the send times out on that selector.

## Workspace instructions and skills

Use an owned QA workspace. Import the five files under [assets/files/agent-skills](../assets/files/agent-skills/) through Files, keeping the `.agents/skills/plan-and-review` folder layout. They provide root and nested AGENTS, a portable skill, a reference, and a saved JavaScript check. See the [skills spec](../../ai-chat-skills/SKILL.md) for the feature gate and limits.

For a long skill-read fixture, use `seq 1 620 | awk '{ print "Reference note " $1 "." }'` between its YAML header and final marker. A shell loop that runs `echo` for each line hits Bash's 200-command limit. Check the stored tool result for the final marker and complete text; a model's summary alone does not prove it read the file or followed every rule.

1. Confirm the configured dev deployment and push the current functions when no watcher is running. Reuse the existing Vite server. Set `AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED=true` for the check.
2. Prove the live check can fail: temporarily turn that dev gate off and run the browser assertion that expects an enabled catalog with the fixtures. Read its failed assertion and exit code. Restore the gate and run the same assertion unchanged. Do not break a shared source file while another task is doing live QA.
3. In a new chat, confirm the composer has no Instructions and skills control or skill chips. Ask the agent to use plan-and-review. Check that it reads the real SKILL.md path with Bash.
4. Ask the agent to read its checks reference, run the suitable JavaScript from total.js with values `[7, 11, 13]` through execute_code, and propose `reports/result.md`. The total is 31. Require `Workspace check: ready`, `SKILL_REFERENCE_0908`, and `SKILL_SCRIPT_0908`. Nested report rules should appear only after the agent touches that path. Inspect the proposal before accepting it.
5. After the run is idle, read `ai_chat.thread_messages_list` through the public query. A saved doc's UI message is in `content`. Check that Bash output contains the read skill text and that execute_code keeps its result. Reload and continue the chat. No dedicated skill tool should appear. Use a SKILL.md larger than 40 lines with a marker at its end to prove the old preview limit is gone.
6. Check both the Files Agent panel and full chat route. Keep a reference to the composer DOM node during a real optimistic thread ID upgrade. It must remain connected. Edit a queued message and check its text, images, focus, and model/mode after persistence. Repeat with a pending edit to SKILL.md; a fresh read must see that pending text.
7. Follow [second-user-fixtures.md](second-user-fixtures.md). Prove a member can read a skill, then restrict its folder or remove content.read and prove a fresh read fails. Earlier tool output must remain in chat history. Also cover a pending rename and delete. Clean up only owned fixtures.
8. Run the quick accessibility screen on the composer. Check keyboard access, image chip removal, focus, narrow layout, and zoom. Save results and any skipped checks in the task report.

During shared-tree HMR, a background page can fail with `useAppAuth must be used within AppAuthProvider`. Reload only the owned tab and repeat the affected check. Avoid importing a second stale app Convex client during that state; a page-context call to the public Convex HTTP endpoint is suitable for readback. Keep tokens in the page. The stored anonymous token is a refresh token: exchange it through `/api/auth/anonymous` for a short-lived access token before an HTTP query, using the current app auth flow. A 401 from using the refresh token directly does not prove a permission refusal.

If `pnpx playwriter` is blocked by registry DNS while an installed session still works, locate its already installed package, verify its package.json version and bin entry, and invoke that bin with `vp env exec node <verified-bin>`. Keep using Vite Plus. Do not install another runtime or restart the shared relay for a registry failure.
