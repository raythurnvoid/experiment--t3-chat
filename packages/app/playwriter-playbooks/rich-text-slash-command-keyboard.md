# Rich Text Slash Command Keyboard

Goal: verify the rich text editor slash command menu supports ArrowDown,
ArrowUp, and Enter through `browser-harness-js`.

Route: `http://localhost:5173/w/personal/home/pages`

Runner: `browser-harness-js` through the local CDP skill. Use Playwriter only
for visual screenshots if CDP evidence is insufficient.

## Setup

- Use a test page titled `New Page`.
- Avoid pages matching `todo`, `to-do`, or similar unless the test explicitly targets task content.
- If `await session.connect()` picks a stale Edge `DevToolsActivePort`, fetch
  `http://127.0.0.1:9222/json/version` and connect with the returned
  `webSocketDebuggerUrl`.

## Harness helpers

Run from the repo root:

```powershell
@'
try {
	await session.connect();
} catch (error) {
	const versionResponse = await fetch("http://127.0.0.1:9222/json/version");
	if (!versionResponse.ok) throw error;
	const version = await versionResponse.json();
	await session.connect({ wsUrl: version.webSocketDebuggerUrl });
}
let target = (await listPageTargets()).find((tab) => tab.url.includes("localhost:5173/w/personal/home/pages"));
if (!target) {
	const created = await session.Target.createTarget({ url: "http://localhost:5173/w/personal/home/pages" });
	target = { targetId: created.targetId };
}
globalThis.richTextSlashTargetId = target.targetId;
await session.use(globalThis.richTextSlashTargetId);
await session.Page.enable();
await session.Runtime.enable();
await new Promise((resolve) => setTimeout(resolve, 5000));

globalThis.richTextSlashQa = {
	async focusEditorEnd() {
		await session.Runtime.evaluate({
			expression: `(() => {
				const editor = document.querySelector(".PageEditorRichText-editor-content");
				if (!editor) throw new Error("No rich text editor");
				editor.focus();
				const range = document.createRange();
				range.selectNodeContents(editor);
				range.collapse(false);
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
			})()`,
			returnByValue: true,
		});
	},
	async open(query = "/sl") {
		await this.focusEditorEnd();
		await session.Input.insertText({ text: `\n${query}` });
		await new Promise((resolve) => setTimeout(resolve, 800));
		return await this.state();
	},
	async key(key) {
		const byKey = {
			ArrowDown: { code: "ArrowDown", keyCode: 40 },
			ArrowUp: { code: "ArrowUp", keyCode: 38 },
			Enter: { code: "Enter", keyCode: 13 },
			Escape: { code: "Escape", keyCode: 27 },
		};
		const value = byKey[key];
		if (!value) throw new Error("Unsupported key: " + key);
		await session.Input.dispatchKeyEvent({
			type: "keyDown",
			key,
			code: value.code,
			windowsVirtualKeyCode: value.keyCode,
			nativeVirtualKeyCode: value.keyCode,
		});
		await session.Input.dispatchKeyEvent({
			type: "keyUp",
			key,
			code: value.code,
			windowsVirtualKeyCode: value.keyCode,
			nativeVirtualKeyCode: value.keyCode,
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		return await this.state();
	},
	async state() {
		return await session.Runtime.evaluate({
			expression: `(() => ({
				menuNodes: Array.from(document.querySelectorAll("#slash-command, #slash-command-renderer")).map((node, index) => ({
					index,
					id: node.id,
					tag: node.tagName,
					className: String(node.className || ""),
					text: node.textContent?.slice(0, 160) ?? "",
				})),
				items: Array.from(document.querySelectorAll("[cmdk-item]")).map((item, index) => ({
					index,
					value: item.getAttribute("data-value"),
					selected: item.getAttribute("data-selected"),
					text: item.textContent?.trim() ?? "",
				})),
				status: document.querySelector(".PageEditorRichText-status-badge, .PageEditorRichTextToolbar-status-badge")?.textContent?.trim() ?? null,
			}))()`,
			returnByValue: true,
		}).then((value) => value.result.value);
	},
};

return { targetId: globalThis.richTextSlashTargetId, url: location.href };
'@ | bash .agents/skills/cdp/sdk/browser-harness-js
```

## Browser steps

Open the menu:

```powershell
@'
await session.use(globalThis.richTextSlashTargetId);
return await globalThis.richTextSlashQa.open("/sl");
'@ | bash .agents/skills/cdp/sdk/browser-harness-js
```

Verify ArrowDown:

```powershell
@'
await session.use(globalThis.richTextSlashTargetId);
return await globalThis.richTextSlashQa.key("ArrowDown");
'@ | bash .agents/skills/cdp/sdk/browser-harness-js
```

Verify ArrowUp:

```powershell
@'
await session.use(globalThis.richTextSlashTargetId);
return await globalThis.richTextSlashQa.key("ArrowUp");
'@ | bash .agents/skills/cdp/sdk/browser-harness-js
```

Verify Enter:

```powershell
@'
await session.use(globalThis.richTextSlashTargetId);
return await globalThis.richTextSlashQa.key("Enter");
'@ | bash .agents/skills/cdp/sdk/browser-harness-js
```

## Expected results

- The menu has one `#slash-command-renderer` wrapper and one `#slash-command` cmdk root.
- The first `[cmdk-item]` starts with `data-selected="true"`.
- ArrowDown moves selection to the next item.
- ArrowUp moves selection back to the previous item.
- Enter closes the menu and applies the selected block command.

## Evidence

- Save the JSON output for each step.
- If the behavior fails, include `menuNodes`, `items`, active editor state, and the selected page title.
- Screenshot only when visual positioning is part of the failure.
