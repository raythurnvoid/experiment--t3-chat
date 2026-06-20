# Agent Panel And AI Chat

Recipes for driving the in-app AI agent (files-page sidebar and `/chat` page). Everything here was proven during the 2026-06-12 QA + eval pass against a backgrounded tab.

## Stable selectors

| Surface | Selector |
| --- | --- |
| Agent tab in files sidebar | `#app_file_editor_sidebar_tabs_agent` |
| Composer (ProseMirror) | `.AiChatComposer-editor-content` |
| Send button | `[data-testid="ai-chat-send-button"]` |
| Stop button (while running) | `[aria-label="Stop generating"]` |
| Open chat tabs list | `[aria-label="Open chats"]` |
| New chat | `getByRole('button', { name: 'New chat', exact: true })` |
| Past chats picker items | `role=option` inside the picker popover |
| Message | `.AiChatMessage` |
| Bash tool disclosure | `summary[aria-label^="Bash"]` (`aria-label="Bash: <cmd>"`, `aria-busy` while running) |
| Bash terminal output | `[aria-label="Bash terminal output"]` (`role=textbox`) |
| Failed send | `role=alert` containing `Message failed to send.` + a `Retry` button |

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

## Doneness: waitIdle pattern

The Stop button blinks out between agent steps (tool-exec gaps), so a single "no Stop button" check fires too early. Require sustained idle — no Stop button AND no **visible** `aria-busy` element — for 3 consecutive 2 s samples. Visible-only matters: hidden hoisted modals keep `aria-busy="true"` while closed (0x0 rect) and would otherwise report busy forever.

## Rate limit + retry

`ai_chat_http` uses a token bucket (rate 4/min, capacity 1): a second send within ~15 s shows the designed `Message failed to send.` alert. Wait ~16 s and click the last `Retry` button; the same draft resends.

## Ready-made helpers

`scripts/agent-chat-helpers.js` installs `state.qa` (session-persistent) with `newChat()`, `send(text)`, `waitIdle(ms)`, `waitDone(ms)` (idle + automatic rate-limit retry), `dump()`, and `readTerminal(index)`:

```powershell
pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/agent-chat-helpers.js
```

A full scored scenario run is then: `state.qa.newChat()` → `state.qa.send(PROMPT)` → `state.qa.waitDone(280000)` → one `evaluate()` that dumps terminals + final `.AiChatMessage` text. Helper `console.log` output is lost across separate playwriter runs — log returned values from the calling script.

For long Bash-agent eval prompts in PowerShell, prefer writing one temporary JavaScript runner and one temporary prompt file, then run with `-f`. The Playwriter sandbox can read the OS temp directory, but do not rely on PowerShell environment variables being visible inside the sandbox. Keep Playwriter calls sequential; concurrent calls against one session can destabilize the relay.

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
$sessionOutput = vp env exec -- pnpx playwriter session new --browser profile:909172d3ee56c25e
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
vp env exec -- pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/install-harness.js --timeout 60000
vp env exec -- pnpx playwriter -s $session -f .agents/skills/app-playwriter-harness/scripts/agent-chat-helpers.js --timeout 60000
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
