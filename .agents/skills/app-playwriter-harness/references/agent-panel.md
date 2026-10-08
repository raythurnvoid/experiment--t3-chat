# Agent Panel And AI Chat

Recipes for driving the in-app AI agent (files-page sidebar and `/chat` page). These rules include the 2026-06-12 agent eval and the 2026-07-24 queued-message QA passes.

## Stable selectors

| Surface                                                                               | Selector                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent tab in files sidebar                                                            | `#app_file_editor_sidebar_tabs_agent`                                                                                                                                                                                                                                                                                    |
| Composer (ProseMirror)                                                                | `.AiChatComposer-editor-content`                                                                                                                                                                                                                                                                                         |
| Send, queue, or save button                                                           | `[data-testid="ai-chat-send-button"]` (`aria-label` is `Send message`, `Queue message`, or `Save queued message`; Queue uses the normal send icon)                                                                                                                                                                       |
| Stop button (while running with empty input)                                          | `[aria-label="Stop generating"]` (the same action slot becomes Queue when the input has text)                                                                                                                                                                                                                            |
| Live jobs button (composer row; hidden at count 0 unless the popover is open)        | `getByRole("button", { name: /^Background jobs/ })` (`aria-label` is `Background jobs, N running`, or `Background jobs` while the open popover is empty)                                                                                                                                                                |
| Queued messages tray                                                                  | `[data-testid="ai-chat-queued-messages"]`                                                                                                                                                                                                                                                                                |
| Queued message                                                                        | `[data-testid^="ai-chat-queued-message-ai_message-"]` (DOM order is execution order; read `data-queued-message-id`)                                                                                                                                                                                                      |
| Edit or reorder queued message                                                        | `[data-testid="ai-chat-queued-message-edit"]`                                                                                                                                                                                                                                                                            |
| Remove queued message                                                                 | `[data-testid="ai-chat-queued-message-remove"]`                                                                                                                                                                                                                                                                          |
| Resume paused queue                                                                   | `[data-testid="ai-chat-queue-resume"]`                                                                                                                                                                                                                                                                                   |
| Cancel queued edit                                                                    | Press Escape in the textbox named `Edit queued message`                                                                                                                                                                                                                                                                  |
| Open chat tabs list                                                                   | `[aria-label="Open chats"]`                                                                                                                                                                                                                                                                                              |
| New full-page chat                                                                    | `getByRole('button', { name: 'New Chat', exact: true })`                                                                                                                                                                                                                                                                 |
| New files-sidebar chat                                                                | `getByRole('button', { name: 'New chat', exact: true })`                                                                                                                                                                                                                                                                 |
| Past chats picker items                                                               | `role=option` inside the picker popover                                                                                                                                                                                                                                                                                  |
| Message                                                                               | `.AiChatMessage`                                                                                                                                                                                                                                                                                                         |
| Bash tool disclosure                                                                  | `summary[aria-label^="Bash"]` (`aria-label="Bash: <cmd>"`, `aria-busy` while running)                                                                                                                                                                                                                                    |
| Bash terminal output                                                                  | `[aria-label="Bash terminal output"]` (`role=textbox`)                                                                                                                                                                                                                                                                   |
| Edit-file tool disclosure                                                             | `.AiChatMessagePartToolEditPage` (`summary` `aria-label="Edit file: <name>"`)                                                                                                                                                                                                                                            |
| Tool `Parameters` / `Result` / `Error` blocks                                         | `[aria-label="Result"]` etc. inside the card (`role=textbox`)                                                                                                                                                                                                                                                            |
| Generated file result                                                                 | `getByRole("button", { name: "Generate image", exact: true })`, then `getByRole("link", { name: "Open in Files" })` inside that tool card; pictures preview in Files, not chat                                                                                                                                           |
| Chat mode picker                                                                      | `getByRole("combobox", { name: /^Chat mode:/ })`, then `getByRole("option", { name: "Agent" \| "Ask" })`                                                                                                                                                                                                                 |
| Failed send                                                                           | `role=alert` holds only the text `Message failed to send.`; the `Show error details` and `Retry` buttons are its siblings inside `.AiChatMessageUserSendError`, so search at page scope, not inside `[role=alert]`. The details dialog is named `Error details`. Read `dialog.innerText()`. The raw message is named `Raw error message`, but it is not an input, so `inputValue()` throws. |
| Pending-changes strip (above composer, only when the OPEN CHAT touched pending files) | `.FileEditorSidebarPendingStrip` (one link per destination: Current workspace or Personal home; each opens that workspace's Pending changes tab; a fresh chat shows no strip) |
| Pending-changes tab count badge                                                       | `.FileEditorSidebarPendingTabBadge` (inside `#app_file_editor_sidebar_tabs_pending`; absent at count 0; always the workspace-wide count)                                                                                                                                                                                 |
| Composer image attachment badges                                                      | `[aria-label="Image attachments"] li` (each has an `<img>` data-URL preview, a name `<span>`, and a `Remove <filename>` button)                                                                                                                                                                                          |
| Chat model picker                                                                     | `getByRole("combobox", { name: /^Chat model:/ })` (the trigger is `role="combobox"` with `aria-label` `Chat model: <name>`, so a `button` role query matches nothing, and `button.MySearchSelectTrigger` also matches the View and Past chats triggers; verified 2026-09-27)                                             |
| Queued-message image count                                                            | `.AiChatQueuedMessages-attachments` inside the queued row                                                                                                                                                                                                                                                                |

`waitForSelector("[role=option]", { state: "visible" })` is a trap in the agent panel: the thread-picker options stay mounted while hidden, so the wait pins the first match — an invisible `FileEditorSidebarAgentThreadPicker-item` — and times out even when the popover you actually opened (for example the `Chat model:` picker) is showing its options. Read all `[role=option]` matches and filter by bounding rect instead of waiting on the first. Same family as the mounted-closed `[role=dialog]` hazard in `known-hazards.md`.

Before sending in a new chat, confirm its tab stays selected. The full-page URL loop was fixed on 2026-09-28. The URL must follow the selected chat without returning to the previous id. Use an existing chat only when it belongs to your QA run. See the optimistic-tab entries in `known-hazards.md` for the separate Files sidebar flow.

For full-page navigation QA, use the top `getByRole("button", { name: "New Chat", exact: true }).first()`: empty chat rows have the same name. Click it twice, then activate it with Enter. After each action, compare the URL's `threadId` with `[data-thread-id]` and check logs. Select an older row, use Back and Forward, then reload. Each action should change the URL once, and the selected id must remain stable between actions. Blank chats stay client-only until a message is sent, so this check needs no model call.

The Files route does not select a chat from `?threadId=`. Open the Agent tab, then use
`getByRole("combobox", { name: "Past chats" })`. It looks like a button but has the combobox role.
Pick a visible option with a title pattern, not an exact accessible name: the option's name also
includes its favorite and archive actions. For example, use `{ name: /My QA chat/ }`.

To check two-workspace review, select a chat with one proposal in each workspace. The pending strip
must show two review links. Focus the Personal home link and press Enter; check the destination URL,
selected Pending tab, and file content before Save. After saving there, read both targets again:
the personal target must be saved while the team target stays pending. Then review the team target
separately. Wait for the completed saved target, not just the Save button click.

For narrow layout, measure the strip's real width, not only the viewport. At a 360px viewport,
the existing split-panel minimum can leave about 150px for a strip even after closing the Files
tree. Require both destination labels to wrap without clipped text, keep Review inside each row,
then Tab from Current workspace to Personal home and press Enter. Check the destination and the
selected Pending tab. Emulate reduced motion and require no row animation. A smaller viewport
checks reflow, not real browser zoom; do not claim a zoom pass from unchanged shortcut metrics.

Run the accessibility screen on `.AiChatThread-composer-stack`, not the review link itself.
The screen checks descendants, so a link used as its root produces zero checked controls.
Require a non-zero control count before treating its result as evidence.

## Transcript edit switches

Use an idle chat with at least two user messages. Find each row through
`.AiChatMessage[data-ai-chat-message-role="user"]` and its visible text. Click its
`getByRole("button", { name: "Edit message", exact: true })`. Switch between the second
and first messages twice, then cancel with Escape. Also focus an Edit message button
and press `e` to open the editor, then Escape to cancel.

Before starting, save the `.AiChatMessageList` node and its message nodes in the page.
Use a `MutationObserver` to record removals and `.AiChatSkeleton` additions.
The list and all message nodes must stay connected through every switch and cancel.
The skeleton must never appear. Check that loaded older messages and any paused queue
stay present. Disconnect the observer when done.

On submit, the branch may change. In a reusable QA chat, edit a message whose parent
is above the current branch anchor and send a short reply request. Check that the new
user message and reply appear on that branch. Opening the editor alone must not change
the `ai_chat_runs:branch_page` query's `anchorId`. An accepted submit clears that anchor;
the request still uses the edited message's original parent. A rejected submit keeps the editor,
draft, and branch.

Also use the long chat in the QA catalog. Select its older long sibling and load older messages.
Edit a user message more than 50 nodes behind the leaf. Fail the first `/api/chat` request before
it reaches the server. Require the edited text and Retry on that failed user, then retry normally.
Check branch counts too: saved ancestors must not count as root siblings or appear twice.
Both requests must use the same original parent. Require one saved replacement and reply after
reload. Remove the failure route when done. This catches missing parents that short chats cannot.

To check a saved ancestor on another branch, edit a later user in the older long sibling.
Fail that send before saving. The earlier branch-point user must appear once in its sibling count,
even when the query now loads the newer branch and the SDK still holds the older ancestors.

For a rejected submit, check the real composer keeps its text and images. Its `onSubmit` callback
must return `false` through both message submit handlers. A mocked Save button that only calls
the handler misses this return-value contract. Check the returned value as well as the branch
and editor state, or use the real composer. A remount check alone does not prove submit or Retry.

## Private chat and access-loss check

Use a fresh anonymous member invited into a non-default QA organization, plus its owner in a
separate browser session. See `second-user-fixtures.md`. Create a named fixture chat through
`ai_chat.thread_create` as the member. Read its current args before calling it. No public door
saves a message without a run any more, so send one short message in the member's browser
(`Reply with OK. Do not call any tools.`). That costs one cheap model call.

- Open `/chat?threadId=<id>` as the member and confirm the fixture text. Read back the stored title
  and messages through the same member's public queries (`thread_get`, `ai_chat_runs.branch_page`).
- As the owner, `threads_list` must omit that chat; `thread_get` and `ai_chat_runs.branch_page` must
  return null. A direct route must clear the inaccessible ID without showing its title or text.
  An attempted `thread_update` must refuse. Re-read as the creator to prove the title stayed put.
- In the member's Files Agent panel, open the fixture chat and type an unsent draft. As the owner,
  give only that fixture member a temporary custom role without `content.read`. Use the default
  workspace ID in `set_user_role` for the organization role.
- The private text, draft, saved selected ID, and saved open tab must disappear. Check again on a
  later call: stale effects must not restore the tab or cause a render loop.
- Restore the member role. Reopen through `Past chats`; saved messages return, but the discarded
  private draft does not. Delete the temporary role. Keep account cleanup limited to the fixture.

For a real Bash smoke check, use an empty persisted fixture chat and request one `printf` command.
Read the chat with `ai_chat_runs.branch_page({ membershipId, threadId, anchorId: null, fromId: null,
stopId: null })`. It returns `{ nodes, nextId }` or `null`, not an array. Nodes come newest first,
at most 50 per page; pass `nextId` as `fromId` for the next older page. Read each node's
`content.parts`: for a reply, the query builds them from its step rows. A saved user message alone
does not prove the run finished: the reply node exists from the start and keeps
`status: "streaming"` until the run ends. Require `done`, and check that the thread's `activeRun`
cleared. Stored `tool-bash` output is `{ metadata, output, title }`, not `{ stdout, stderr }`. Check
the exact terminal text in `output` plus `metadata.exitCode`, `stdoutLength`, and truncation flags.
Also check the stored assistant text.

Put an exact shell command in its own paragraph or code block, without trailing prose punctuation.
A period beside a command can become a real operand. Check the stored command and exit code before
scoring the app; a model's success summary does not prove the command succeeded.

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

## Check assistant Markdown rendering with one cheap turn

To check a change in `ai-chat-markdown.tsx` in the real app, send one message on the default GPT-6 Luna model: `Reply with exactly the following Markdown and nothing else. Do not call any tools. <markdown>`. The prompt asks the model to copy the markdown and not call tools. Before the send, add `state.page.on("request", handler)` and collect the URLs you care about, so you can prove what the browser fetched and not only what the DOM holds. Reload the thread after the reply, then read the last `.AiChatMessagePartMarkdownAgent` (its `img` `src` values and `[data-streamdown='link']` texts). Reuse that thread for the break-on-purpose run: revert the change, reload, read again, restore. Remove the request listener with `state.page.off(...)` when done. Verified 2026-09-25 on the image-origin check: with the fix off the reload fetched the external image; with it on the DOM held a link and there was no request.

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

DOM `innerText()` can add extra blank lines between ProseMirror paragraphs. For a
shell prompt, compare the command paragraphs before Send. After Send, compare the
saved user text from `ai_chat_runs.branch_page` with the original prompt.
Do not require DOM text to match the prompt byte for byte.

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

- Popup: `[role=listbox][aria-label="Files and folders"]`, rows are `[role=option]`, 50 per page with a "Show more" row. It portals to the hoisting container, so locate it at document scope, not inside the composer.
- Empty text shows one folder. Clicking a folder row (or Enter on it) opens it instead of inserting a chip; the opened folder's first row "Mention this folder" inserts the folder chip, and the "Folder path" breadcrumb goes back. Typed text with a `/` searches names in the folder before the last `/` (`@/docs/api`). Not checked live yet.
- The `@` must start a word: an `@` typed directly after a letter (`doc@`) never opens the popup. Probes that retype a query after a previous one must add a leading space first.
- Enter or a click on a file row (or on "Mention this folder") inserts a chip (`.AiChatComposerFileMention`) without sending; folders serialize with a trailing slash. The message serializes chips to `@/path/to/file.md` text.
- Escape closes only the popup. The mention renderer calls `stopPropagation()` on that Escape, so it never reaches the form's close handler or the chat-level Escape branch — a message edit stays open. The next Escape (popup closed) closes the edit/queue surface as usual.
- `fill()` bypasses the suggestion plugin (it replaces content without typing). Use `keyboard.type("@doc")` to open the popup.

## Message ids flip when a stream finishes

While a response streams, the last assistant `.AiChatMessage` has `data-ai-chat-message-id="ai_message-…"` (the client-generated id). When the response finishes and the persisted row syncs back, that attribute flips in place to the Convex message id. A probe that stored the streaming id and later looks the message up by it finds nothing — re-read the id after idle instead. The rendered content must NOT remount at that flip (open tool-output `details` stay open); that is guarded by `keeps an open tool output open when the streamed message is persisted` in `ai-chat-message.test.tsx`. To prove a remount in the browser, tag the DOM node (`el.__qaTag = "x"`) before the transition and check the tag survives after. Verified 2026-08-02.

## Two traps around a failed send and a fast turn

The `Error details` dialog stays open after you read it, and it keeps focus, so the next `fill()` on the composer writes nothing and the send button stays disabled — the run then fails at a `waitForFunction` that looks like the app is stuck. Press `Escape` and confirm no visible `[role=dialog]` remains before sending again.

`state.qa.queue(text)` only works while a turn is still running, because it waits for the send button's accessible name to be `Queue message`, and that internal wait is 10 s regardless of the CLI `--timeout`. A short first prompt finishes before the second `queue()` call and the helper times out with the queue half-filled. Give the first turn real work ("write a 1500-word essay about …") when you need two or more messages queued behind it.

## Testing shell state across Bash calls: pin the shell name in the prompt

Shell state (variables, arrays, options, cwd) is kept per named shell, so a cross-call persistence check is only meaningful when both calls use the same shell. The agent picks a shell name on its own when the prompt does not give one — a 2026-09-16 run had it use `sh` for the first call and the default shell for the second, so the second call saw no variables and the starting cwd. That reads exactly like a broken state-restore bug and is not one.

Always write `Use the shell name <name> for BOTH calls` into the prompt. To confirm which shell actually ran, read the stored doc rather than the card: `convex data ai_chat_bash_shells --limit 10` prints each shell's `name`, `cwd`, and its saved `state`, including `arrays`.

## A finished job always posts and wakes, with no flag needed

Every job the agent started posts one finish text (`Background job <n> finished`) when it ends,
whether or not the Bash call set `wakeOnJobFinish`. The old flag-gated wake and the stderr
notes are gone (removed 2026-09-18): do not write `Set wakeOnJobFinish to true` into prompts, and do
not expect `bash: job N done` in later Bash output — its absence is the point.

Two more ways a wake check comes back empty without a defect:

- A job that finishes **while the run on its branch is live** does not get its own message. It waits
  in `ai_chat_run_inbox`, and the run shows it **inside the reply** at the next step, as a
  `data-job-finish` part (`.AiChatMessagePart-job-finish`) at the start of that step. No wake run
  starts for it. A finish still waiting when the run ends becomes a finish message under that reply.
- With no live run on its branch, the finish is a `system` message under the leaf of the job's
  branch. It renders as its own `.AiChatMessage`, so read roles, not only assistant text. A wake run
  then answers it.
- The finish goes to the branch of the reply that started the job, not to the branch on screen. If
  you switched branch meanwhile, look on the job's branch.

A good wake check therefore looks like: one turn that launches the job and replies at once (tell it
not to wait), then poll the message list with no further sends, then assert that new messages
appeared, that none of them is a `user` message, and that one holds `Background job <n> finished`.
To check the in-reply case, launch a job that ends in about 10 seconds and ask the same turn for
several slow steps (not verified live yet).

## Forcing the 409 wait path

A thread has one live run. A send while any run is live (a turn from another tab, or a job wake
run) gets 409 with `retryAfterMs` (at most 5 s). The server saves nothing; the client waits and
sends the same request again, so exactly one user message is stored.

Use two tabs on the same chat. In tab A, send a slow prompt (for example three `execute_code`
steps that each wait 5 seconds). While tab A's reply is `streaming`, send a short message in tab B.
Tab B shows no error UI and stays running. After tab A's run ends (or you press Stop in either tab),
tab B's turn starts by itself. Not verified live yet (phase C, 2026-09-30).

To end a held run from the CLI instead, read `runId` and `generation` from the thread's
`activeRun` and call the run's own last write:

```powershell
vp env exec pnpm --dir packages/app exec convex run ai_chat_runs:finish '{"runId": "<runId>", "generation": <generation>, "outcome": "stopped", "tail": null}'
```

Read back with `ai_chat_runs.branch_page`: exactly one `user` node holds tab B's text.

## Read a finished job's own output with `jobs -o N`, not a transcript tail

A job that paused writes one transcript entry per run, and the entries of other jobs land between them. A
`tail -c <n> /shells/default/transcript` therefore cuts the last run's output in the middle, and a check that greps the
tail for the job's final line reports a false failure. Ask for `jobs -o N` instead: it prints the whole job's stored
stdout and stderr, then one `[job N exit C]` line. Verified 2026-09-16.

A job killed or timed out before it printed anything is the one case `jobs -o N` cannot answer: it says
`bash: jobs: job N timed out and stored no output; read the shell transcript` and exits 1, because the job stored no
result and flushed no head. The status word is the Activity's own, so a killed job reads `stopped` there. That is not a
lost job. Read `convex data ai_chat_bash_shell_transcripts --limit 6 --order desc`: the job's pause entry and its
`job N finished (exit 143)` entry are both there, and each still names the script. Verified 2026-09-16.

## Stop cancels the turn, not the Bash call already running on the server

The Stop button's accessible name is `Stop generating` (`[aria-label="Stop generating"]`). Stop is a
server mutation (`ai_chat_runs.stop`), so Stop in any tab of the chat stops the run. It names the
streaming reply the tab shows, so a late Stop never stops the next run (a job wake run). It raises the
run's generation. The run's action notices within about 2 seconds, saves the unfinished step as
`partial`, and ends the reply as `stopped`. Sometimes the action dies before it can do that (a
stream error at the abort, or a closed tab). Then the Stop grace end ends the run exactly 30 seconds
after Stop and logs `Chat data not saved` with `reason: "finish_missing"`. So after Stop, wait up
to about 35 seconds for the reply to leave `streaming` before calling the run stuck. Verified 2026-09-30.

A Bash command already running in its own action still runs to the end, but none of its writes
land: app-file writes, `/tmp` changes, the shell state and its transcript entry are all refused,
because the run's generation changed (`save_shell` and `patch_thread_tmp_files` answer "Stopped").
The tool card is then left with only its command line and no output section.

So do not read an empty card as "the command was killed", and do not use Stop to exercise the engine's abort path. The transcript does not show the stopped command either. To drive a real in-engine abort, use the `timeout` command instead: `printf 'kept\n'; timeout 1 sleep 5; printf 'code=%s\n' "$?"` keeps `kept`, reports `code=124`, and drops the timed-out command's own output. Verified 2026-09-16.

## Count a reply's steps and bytes from the stored steps

A reply can have up to 25 model steps. To prove how many steps ran, or how big a reply got, read the
stored steps, not the cards. A reply node in `ai_chat_threads_messages_aisdk_5` holds no parts: each
model step is one row in `ai_chat_run_steps` (`messageId` = the reply node, `stepIndex`, `status`
`done` or `partial`, `parts`, `bytes`). The reply node's own `bytes` counts its content plus its
steps. Human messages and file comments use `channels_messages`. Export a few recent step rows to the task folder,
then count the rows per `messageId` and the tool parts in each row's `parts`:

```powershell
vp env exec pnpm --dir packages/app exec convex data ai_chat_run_steps --format jsonArray --limit 30 --order desc > "$d/steps.json"
```

To make a reply run many steps, ask for `execute_code` N times, one call per step (`return { call: K };`).
To test parallel calls, ask for three `execute_code` calls in the same step, each waiting 3 seconds
(`await new Promise((resolve) => setTimeout(resolve, 3000))`). Small file reads end too fast to overlap.
The 3rd call gets "Too many tool calls at once" and runs again in the next step. Verified 2026-09-27.

## Doneness: waitIdle pattern

The Stop button blinks out between agent steps (tool-exec gaps), so a single "no Stop button" check fires too early. Require sustained idle — no Stop button AND no **visible** `aria-busy` element — for 3 consecutive 2 s samples. Visible-only matters: hidden hoisted modals keep `aria-busy="true"` while closed (0x0 rect) and would otherwise report busy forever. Start the samples only after the turn visibly starts (wait for the Stop button first, up to 60 s): right after send, the transport is still preparing, so even sustained-idle checks pass on a turn that has not begun. Verified 2026-09-19.

## Rate limit + retry

`ai_chat_http` uses a token bucket (rate 4/min, capacity 1). The chat transport keeps an HTTP 429 inside the same AI SDK request: it reads the server's validated `retryAfterMs`, waits, then retries the same message id. Stop aborts this wait. Do not expect a queued message to disappear or show the failed-send UI for this normal rate-limit case.

QA tabs using one account share this limit. Tabs in one browser profile also share the selected chat. Run one chat QA lane at a time and leave its peer tabs idle. Check the selected thread and saved prompt before scoring a result.

Rapid fresh-chat checks can also log `ai_chat:thread_mark_read` rate limits and `Failed to move the read cursor`. A turn may still finish and save all tool results. Check that exact thread with a fresh `ai_chat_runs.branch_page` query before resubmitting the prompt.

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

`send`, `waitDone` and `newChat` wait far longer than the 5 s `--timeout` ceiling, so an awaited call fails with `Code execution timed out after 5000ms`. Start them without awaiting and keep the promise in `state`, then poll in short calls: `state.qaSend = state.qa.send(TEXT).then(() => "ok", (e) => String(e));`, and later `await Promise.race([state.qaSend, "pending"])` plus `state.qa.dump()`. If `dump()` shows `messageCount: 0`, the tab hit the HMR blank (see `known-hazards.md`): reload, and check the last message before you send again, because the send may not have gone out.

`state.qa.newChat()` can time out at its `aria-selected` wait even though the click worked (seen 2026-09-05 on the files sidebar with several open chat tabs): the `New chat` button appends a new `ai_thread-*` tab to `[aria-label="Open chats"]`, but the selection stays on the old thread, so a send would land in that old chat. Work around it by clicking the newest `[role="tab"][id^="ai_thread-"]` yourself, then check that the selected tab id starts with `ai_thread-` and the panel holds 0 `.AiChatMessage` before `state.qa.send`. Report the unselected new tab as a possible app bug; it is not a helper bug. The 2026-09-05 instance was a cross-tab storage race — a peer `/files` tab wrote the old id back because `selected_tab` was published before `open_tabs` — and was fixed 2026-09-12; if it recurs, capture incoming `storage` events before assuming an in-tab regression (see the App State section in `known-hazards.md`).

For long Bash-agent eval prompts in PowerShell, write one JavaScript runner under `../t3-chat-+personal/+ai/<topic>-YYYY-MM-DD/`, embed the prompt in that runner, and run it with `-f`. The CLI loads the runner before sandbox restrictions apply. Do not create a second prompt file in the repository or OS temp directory. Keep Playwriter calls sequential; concurrent calls against one session can destabilize the relay.

When evaluating through `/files`, the Agent sidebar tab is often more stable than switching to `/chat` because the file tree/editor context stays loaded. After a Convex deploy, reload the `/files` route, click `#app_file_editor_sidebar_tabs_agent`, and wait for `.AiChatComposer-editor-content` before sending the next prompt.

If a scenario asks the agent to edit an app file, manually accept and save pending edits before continuing unrelated browser work. The editor can show a pending-edits banner and a diff route with an `Accept all pending changes and save` button; leaving proposed edits unapplied can intentionally affect Bash pending-update scenarios but can also pollute later evals.

For `/tmp` eviction scenarios, require a second Bash call after file creation. Eviction and oversized-file discard happen after a command flushes scratch state, so same-command `ls` can show files that will not survive to the next Bash call. Avoid using diagnostic commands that write extra `/tmp` files, such as `tee /tmp/list.txt`, unless the side effect is part of the scenario; those files count toward the same path and byte caps and can trigger another eviction.

## Resolve Eval Recipe

Use the [copied-link and node-ID recipe](bash-tool-agent-eval.md#resolve-copied-file-links-and-node-ids) for `resolve` changes. Select a neutral file and open a fresh empty chat before each scored request, so the target path is not already in context. Capture a real sidebar Copy link and Copy node id, paste each into the composer, and check the exact text before Send.

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

`convex dev --once` (and Vite HMR) can blank a backgrounded localhost tab: empty `<body>`, every selector gone. Confirm `state.page` is the owned QA tab, read its current URL and logs, then start a reload:

```js
console.log(state.page.url());
state.page.reload({ waitUntil: "domcontentloaded" }).catch(error => {
  state.recoveryError = error.message;
});
```

Poll readiness in separate short calls. On Files, first wait for the Agent tab to be attached,
then click it normally. On the full chat route, wait directly for the composer:

```js
await state.page.waitForSelector(".AiChatComposer-editor-content", { state: "attached", timeout: 4000 });
```

If one reload still reports `useAppAuth must be used within AppAuthProvider`, let shared-tree HMR
settle, then open a fresh owned tab at the same URL. Bind the harness to it and repeat the affected
check. Keep the user's tabs and dev server in place. If a background click stalls, use the checked
mouse-click fallback below.

## Backgrounded-tab rules

When the app tab is not foregrounded:

- `snapshot()`, `screenshot()`, and `innerText` are unreliable — read via `evaluate()` with `textContent`, `getComputedStyle`, `getBoundingClientRect`.
- Playwright `locator.click()` can hang at `performing click action` on a background trigger. Read its current bounds, use the harness hit test to confirm the target is clear, then use a normal `page.mouse.click` at that observed point. Re-read the resulting state. Do not use forced or DOM clicks, or foreground the user's profile to work around it.
- The send and Stop buttons hit this too. To send, focus the composer and press Enter instead of clicking the send button. To stop, read the Stop button's box in page context (`document.querySelector('[aria-label="Stop generating"]').getBoundingClientRect()`) and call `page.mouse.click` at its center. `locator.click` on `Stop generating` can hang while the run keeps streaming.

## External links in chat

Assistant Markdown links are `a[data-streamdown="link"]`. A link to another site has `target="_blank"`.
A link to this app does not. There is no confirm window. A click leaves the chat page in place and
opens the site in a new browser tab. Playwriter's `popup` event may not list that tab.

A bare `https://` address in a tool result is plain text. It is not a link.

## Chat page and branching

- `/w/personal/home/chat?threadId=<id>` loads that thread; switching threads updates the URL. Allow ~10 s for messages to load before reading counts.
- `Branch chat here` (message action) creates a branched thread that inherits `/tmp` files and cwd; the new thread gets a sidebar tab with `aria-selected=true`. The action returns only after the whole copy is published, so a long chat takes a few seconds.
- Delete chat: the thread row's `More actions` button opens a menu with `Delete`, then a confirm modal whose first focus is `Cancel`. In an occluded tab, focus `More actions` and press Enter, then click the menu item with DOM `el.click()`. Do not press Enter again in the open menu: the first item is `Branch`, and Enter makes an extra branch you then have to delete. After the confirm, the row goes at once and the drain removes the data within a minute; read `ai_chat_threads` by id to see it gone.
- Stored tool output: a Bash or MCP result over 24 KiB shows `Show full output` under the tool card (`.AiChatMessagePartToolOutputFull`). Its `[role=status]` reads `Showing N of M bytes of the full output`; `Load more` reads the next 64 KiB page. A cheap fixture is one Bash call like `seq 1 18000` (about 97 KB). Inside the chat, `ls -l /tool-output` lists the stored files with real sizes.
- `state.qa.newChat()` is for the files-sidebar Agent tab only. On the full-page `/chat` route it waits forever on `[aria-label="Open chats"] [role="tab"][aria-selected="true"]`, because that route renders no tab strip. The route's own control is `New Chat` (capital C), and it can be rendered twice, so a plain `getByRole` click dies with a strict-mode violation — but do not click it at all right now, see the renderer wedge in `known-hazards.md`. To reach a new thread, start a fresh headless browser: with no session the app mints an anonymous user whose chat is empty, and `goto("/w/personal/home/chat")` lands on it. A `goto` without `threadId` in a browser that already has threads reopens the last one.
- `newChat()` also needs the Agent sidebar to be **open**. On `/files` with the sidebar closed there is no `New chat` button at all, so the helper burns its full 60 s click timeout and reports `locator.click: Timeout 60000ms exceeded` — which reads like a covered button rather than a closed panel. When you only need one more agent turn and do not care which thread it lands in, skip `newChat()`: `goto` the `/chat` route (it reopens the last thread), wait for `.AiChatComposer-editor-content`, and call `state.qa.send(...)` straight into it. Read the command's output with `state.qa.readTerminal()` — `[data-message-id]` matches nothing on that route.

### Make a second chat without clicking anything

A fresh headless browser gives you an empty chat, but it signs you in as a new anonymous user, so it
cannot be used when the second chat must belong to the **same** account — for example when two chats
have to write to one file and you need both `threadIds` on one pending row. Create the thread
through the door instead and navigate straight to it. This is the only way that worked on
2026-09-15; clicking `New Chat` opens the threads panel over the composer and the click promise
never settles, which wedges the tab.

The app does **not** put a client on `window`. Import the app's own module instead:

```js
const created = await state.page.evaluate(async (membershipId) => {
	const mod = await import("/src/lib/app-convex-client.ts");
	return await mod.app_convex.mutation("ai_chat:thread_create", {
		membershipId,
		clientGeneratedId: `qa-second-chat-${Date.now()}`,
		title: "QA second chat",
		lastMessageAt: Date.now(),
	});
}, MEMBERSHIP_ID);
await state.page.goto(`${APP_ORIGIN}/w/<org>/<workspace>/chat?threadId=${created._yay.threadId}`, {
	waitUntil: "domcontentloaded",
	timeout: 180000,
});
```

Then reinstall the chat helpers and rebind, because the navigation replaces the page context. Give
`goto` an explicit `timeout`: Playwright's own default for that call is 10 s and the CLI
`--timeout` does not cover it.

## Generated files (`image_generation` and `execute_code`)

Generated pictures, browser screenshots, and code output become private Files proposals. The user reviews them in Files. Use an owned QA chat and a unique folder for each run.

Valid editable UTF-8 becomes a text draft, using the normal upload text rules. Binary, invalid UTF-8, unsupported text, and text over the limits remain exact stored bytes. Generated Markdown also stays stored when its frontmatter or final text exceeds a limit. Do not expect every output to use the stored-file row.

`image_generation` is available only in Agent mode and on a model whose `supportsImageGeneration` flag is true in `shared/ai-chat.ts`. Try `Draw a small picture of a red circle on a white background.` Send once, then poll the running state in short calls. A slow model turn does not justify a long blocking browser wait.

The chat card is titled `Generate image`. It shows a safe status and `Open in Files`; it has no inline generated picture. Its stored output is:

```js
{
	title: "Generate image",
	output: "Generate image: succeeded.",
	metadata: { status: "succeeded", reason: null, files: [{ kind: "private", id: "<pending node id>" }] }
}
```

Read the owned thread through `ai_chat_runs.branch_page({ membershipId, threadId, anchorId: null, fromId: null, stopId: null })`. It returns `{ nodes, nextId }`, newest node first, and each node holds its UI message in `content`. Check the tool's `input` is `{}` and its output has only the safe fields above. There must be no image bytes, signed URL, or old `{ assetId, mediaType, size }` output. One successful image output must produce one Files target. Preview copies must not create extra files. Reload chat and confirm the same link still works.

File results use `succeeded`, `partial`, `errored`, `cancelled`, or `timed_out`. The `reason` field is always present. It is null or a fixed code such as `agent_required`, `unavailable`, `storage`, or `limit`. Check both fields. For `execute_code`, check `metadata.fileResult` separately from the runner's `metadata.status`. A calculation can succeed while file output fails. A later failure or Stop must keep earlier completed files and report `partial`.

Open a stored target in Files. In Pending changes, a stored draft is a normal row (`Added file`) with inline Accept and Discard; its path link opens the private file. Open the row's `<details>` (set `open = true` from page context when a click hangs). `.FileEditorSidebarPendingStoredFileDetails` shows MIME, size, creator, source chats, and Download. Safe images get a preview; assert its `complete` and `naturalWidth > 0`. HTML, SVG, ZIP, and unknown types use Download without an inline image. Text output uses the normal editor and text review. While preparing, the row shows `Preparing…` in the same `<details>` with no chevron and cannot open, Accept is blocked, and incomplete content must not be exposed. Discard remains available. When the row becomes ready, focus on its Discard button stays there.

In the stored-file row, Accept uses `getByRole("button", { name: "Accept changes to /<path>", exact: true })`. Discard uses `Discard changes to /<path>`. Download uses `Download <filename>`. Accept includes only the file's required parent folders. Discard leaves those parents and siblings alone.

The row's Accept and Discard and the private-file view's Save and Discard all use review Activities. This also applies when the file has no pending parent. Review jobs finish later than the click and the “Started accepting” or “Started saving” message. Check the Activity outcome and a fresh file query.

After Save or Discard finishes, its progress dialog stays open. Close it before clicking the chat mode picker or another control behind it. The footer and icon both have the accessible name `Close`, so select the footer text within the named dialog:

```js
await state.page.getByRole("dialog", { name: "Discard reviewed changes", exact: true })
	.getByText("Close", { exact: true }).click({ timeout: 4000 });
```

Use `Save reviewed changes` for a Save run. Read the page again after closing; do not force a click through the dialog.

### Deterministic arbitrary-file check

In Agent mode, ask for one `execute_code` call with the snippet below. Replace `RUN` with a unique run id. Inspect the app folder and its AGENTS.md rules with Bash in an earlier completed step. Put file paths in the snippet, not the tool's `input`. Keep binary bytes out of the normal return value and console logs.

`emitFile` takes a canonical Files path such as `/qa-binary-RUN/empty.zip`. This is not a Bash mount path or the Bash `/tmp` folder. It accepts `Uint8Array` or `ArrayBuffer`. One successful run may emit up to eight files and 8 MiB total. Existing paths receive a bounded name suffix; inspect the returned targets to learn the final paths.

```js
const folder = "/qa-binary-RUN";
emitFile({
	workspace: "current",
	path: `${folder}/nested/opaque`,
	contentType: "application/x-qa-binary",
	bytes: new Uint8Array([0, 255, 128, 65, 10]),
});
emitFile({
	workspace: "current",
	path: `${folder}/empty`,
	contentType: "application/octet-stream",
	bytes: new Uint8Array(0),
});
const zip = new Uint8Array(22);
zip.set([0x50, 0x4b, 0x05, 0x06]); // Empty ZIP: end record with no entries.
emitFile({ workspace: "current", path: `${folder}/empty.zip`, contentType: "application/zip", bytes: zip });
return { created: 3 };
```

Check these steps separately. A successful code result alone does not prove Save, Download, or Discard:

1. Inspect the actual code tool input and result. The result keeps its normal code/result view and has three `metadata.files` targets. Require `metadata.fileResult.metadata.status === "succeeded"` and `reason === null`. Capture the targets from the persisted message. Resolve each with `files_pending_updates.get_file_pending_target` and match its path. Do not assume target order from the sidebar.
2. In Pending changes, check 5 bytes for `opaque`, 0 bytes for `empty`, and 22 bytes for `empty.zip`. All three must be stored files. Download the pending ZIP and compare all 22 bytes before marking that path verified.
3. Save `nested/opaque`. Wait for its review job, then query its original private target again. It must resolve to a saved entry with no pending update. Only the required folders may be saved with it. Repeat for the empty file. Download both saved files and compare every byte, including the empty length.
4. Discard the remaining ZIP. Its old target must become unavailable and its chat link must show that state after reload. Check keyboard Accept/Discard and focus after a row disappears. Check the row at narrow width and 200% zoom.
5. In a later turn, use Bash `resolve` with the original private id or `pendingNodeId` URL. It must still resolve after Save. Use the current canonical Files path for the byte-read check below. For an image, call `view_image({ workspace: "current", path: "/qa-binary-RUN/picture.png" })` and ask about a visible detail. That tool takes no format, range, id, or URL fields. Its chat result stays text-only.
6. Repeat the emit request in Ask mode. It may run calculations, but it must create no pending file. Require `metadata.fileResult.metadata.status === "errored"` and `reason === "agent_required"`. Image generation must also stay unavailable in Ask. Test the model gate using an existing unsupported model; do not change shared source during another agent's QA.

### Read and transform stored bytes

After the folder check with Bash, run this through `execute_code` in Agent mode. Use the saved fixture's actual canonical path. The gateway supplies authorization; do not read or pass a token.

```js
const response = await fetch(`${process.env.T3_APP_ORIGIN}/api/v1/files/read-bytes`, {
	method: "POST",
	headers: { "Content-Type": "application/json", "X-Bonobo-Workspace": "current" },
	body: JSON.stringify({ path: "/qa-binary-RUN/nested/opaque", offset: 0, length: 32, revision: null }),
});
if (!response.ok) throw new Error(`File read failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const expected = [0, 255, 128, 65, 10];
if (bytes.length !== expected.length || !bytes.every((byte, index) => byte === expected[index])) {
	throw new Error("File bytes changed");
}
emitFile({ workspace: "current", path: "/qa-binary-RUN/reversed.bin", bytes: bytes.slice().reverse(), contentType: "application/octet-stream" });
return { checkedBytes: bytes.length, matched: true };
```

Download the new proposal and require `[10, 65, 128, 255, 0]`. Return only the check result from code. Code returns and logs are stored in chat, so returning the bytes would break this privacy check.

Each byte read allows 1 byte to 1 MiB. Later ranges must reuse `X-File-Revision` from the first response. Check `X-File-Size`, `X-File-Offset`, and `X-File-Content-Type`. The run has an 8 MiB read budget and charges requested length, including retries. A changed revision returns 409; start a fresh read. For editable text, these bytes represent current canonical UTF-8 text, including the caller's pending changes.

### Editable text output

In a separate Agent call, emit Markdown and JSON with their matching content types. Also emit `new Uint8Array([255])` as `text/plain`. Use a fresh canonical folder.

Require Markdown and JSON to become editable private text drafts. Check their pending content before Save. BOM and CRLF input should normalize like a normal upload. The invalid UTF-8 file must stay stored and download as the exact byte `255`.

Check Save and Discard through their normal review controls. Wait for the Activity result. A preparing text draft must not appear ready with empty content. Use Bash to read ready text; use `view_image` only for supported images.

For the Save readback, keep the owned membership and original target in `state.binaryQa`. Run this through Playwriter after the click, then poll in short calls until `kind` is `saved` and `hasPendingUpdate` is false:

```js
await state.page.evaluate(async ({ membershipId, target }) => {
	const { app_convex, app_convex_api } = await import("/src/lib/app-convex-client.ts");
	const file = await app_convex.query(app_convex_api.files_pending_updates.get_file_pending_target, {
		membershipId,
		target,
	});
	return file && {
		kind: file.entry.kind,
		path: file.entry.path,
		readiness: file.readiness,
		hasPendingUpdate: !!file.entry.pendingUpdate,
	};
}, state.binaryQa);
```

Verify the Download button itself. Capture the Blob passed to `URL.createObjectURL` while still calling the original function, then restore the spy. Compare its complete bytes with the fixture. Also read the matching native file using the actual download filename. In extension mode, `download.saveAs()` can fail even when the browser wrote the file to `~/Downloads`; see the download entry in [known-hazards.md](known-hazards.md). Do not treat that relay error as a failed app download, or treat a Blob check alone as proof of the native file. Keep owned downloads and evidence in the personal task folder.

## Workspace instructions and skills

Use an owned QA workspace. Import the five files under [assets/files/agent-skills](../assets/files/agent-skills/) through Files, keeping the `.agents/skills/plan-and-review` folder layout. They provide root and nested AGENTS, a portable skill, a reference, and a saved JavaScript check. See the [skills spec](../../ai-chat-skills/SKILL.md) for the feature gate and limits.

For a long skill-read fixture, use `seq 1 620 | awk '{ print "Reference note " $1 "." }'` between its YAML header and final marker. A shell loop that runs `echo` for each line hits Bash's 200-command limit. Check the stored tool result for the final marker and complete text; a model's summary alone does not prove it read the file or followed every rule.

1. Confirm the configured dev deployment and push the current functions when no watcher is running. Reuse the existing Vite server. Set `AI_CHAT_WORKSPACE_INSTRUCTIONS_ENABLED=true` for the check.
2. Prove the live check can fail: temporarily turn that dev gate off and run the browser assertion that expects an enabled catalog with the fixtures. Read its failed assertion and exit code. Restore the gate and run the same assertion unchanged. Do not break a shared source file while another task is doing live QA.
3. In a new chat, confirm the composer has no Instructions and skills control or skill chips. Ask the agent to use plan-and-review. Check that it reads the real SKILL.md path with Bash.
4. Ask the agent to read its checks reference, run the suitable JavaScript from total.js with values `[7, 11, 13]` through execute_code, and propose `reports/result.md`. The total is 31. Require `Workspace check: ready`, `SKILL_REFERENCE_0908`, and `SKILL_SCRIPT_0908`. Nested report rules should appear only after the agent touches that path. Inspect the proposal before accepting it.
5. After the run is idle, read `ai_chat_runs.branch_page` through the public query. A node's UI message is in `content`. Check that Bash output contains the read skill text and that execute_code keeps its result. Reload and continue the chat. No dedicated skill tool should appear. Use a SKILL.md larger than 40 lines with a marker at its end to prove the old preview limit is gone.
6. Check both the Files Agent panel and full chat route. Keep a reference to the composer DOM node during a real optimistic thread ID upgrade. It must remain connected. Edit a queued message and check its text, images, focus, and model/mode after persistence. Repeat with a pending edit to SKILL.md; a fresh read must see that pending text.
7. Follow [second-user-fixtures.md](second-user-fixtures.md). Prove a member can read a skill, then restrict its folder or remove content.read and prove a fresh read fails. Earlier tool output must remain in chat history. Also cover a pending rename and delete. Clean up only owned fixtures.
8. Run the quick accessibility screen on the composer. Check keyboard access, image chip removal, focus, narrow layout, and zoom. Save results and any skipped checks in the task report.

Plugin skills (verified 2026-09-28): the catalog also lists skills of enabled plugins in the current workspace, as `{"source":"plugin","plugin",...}` entries with a `/.plugins/<plugin>/dist/skills/<name>/SKILL.md` path. The body is never in the prompt, so ask the agent in a new Files sidebar chat to "list every entry in your skill catalog whose source is plugin; print plugin, name, path, and description exactly; do not run tools". To prove the browser runs your working tree, add a fake entry to `pluginSkills` in `convex/ai_chat_context.ts` `discover_sources`, wait for the watcher's next `Convex functions ready`, ask, then remove it and ask again (the reply must say none). Check that the `convex dev` watcher process is alive first: on 2026-09-28 it had exited, and the first ask silently answered from old code.

During shared-tree HMR, a background page can fail with `useAppAuth must be used within AppAuthProvider`. Reload only the owned tab and repeat the affected check. Avoid importing a second stale app Convex client during that state; a page-context call to the public Convex HTTP endpoint is suitable for readback. Keep tokens in the page. The stored anonymous token is a refresh token: exchange it through `/api/auth/anonymous` for a short-lived access token before an HTTP query, using the current app auth flow. A 401 from using the refresh token directly does not prove a permission refusal.

If `pnpx playwriter` is blocked by registry DNS while an installed session still works, locate its already installed package, verify its package.json version and bin entry, and invoke that bin with `vp env exec node <verified-bin>`. Keep using Vite Plus. Do not install another runtime or restart the shared relay for a registry failure.
