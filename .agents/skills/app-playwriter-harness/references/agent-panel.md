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

ProseMirror ignores Playwright `fill`/`Input.insertText`. Focus the editor and use `execCommand`:

```js
await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
await state.page.evaluate((t) => {
	const editor = document.querySelector(".AiChatComposer-editor-content");
	editor.focus();
	document.execCommand("insertText", false, t);
}, prompt);
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
