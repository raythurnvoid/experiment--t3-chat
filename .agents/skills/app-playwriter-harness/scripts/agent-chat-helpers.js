// Reusable QA helpers stored on state.qa (session-persistent).
state.qa = {
	async newChat() {
		const btn = state.page.getByRole("button", { name: "New chat", exact: true });
		await btn.click();
		await state.page.waitForTimeout(500);
		const tabs = await state.page.evaluate(() => {
			const list = document.querySelector('[aria-label="Open chats"]');
			return list ? (list.textContent || "").slice(0, 200) : null;
		});
		console.log("newChat → tabs:", tabs);
	},

	async send(text) {
		// The composer can briefly unmount during optimistic→persisted thread swaps.
		await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
		await state.page.evaluate((t) => {
			const editor = document.querySelector(".AiChatComposer-editor-content");
			if (!editor) throw new Error("composer not found");
			editor.focus();
			document.execCommand("insertText", false, t);
		}, text);
		await state.page.locator('[data-testid="ai-chat-send-button"]').click();
		// Wait until the run starts (Stop generating appears) or an assistant message lands fast.
		await state.page
			.waitForSelector('[aria-label="Stop generating"]', { timeout: 10000 })
			.catch(() => console.log("send: stop button never appeared (run may have finished instantly)"));
		console.log("send: dispatched:", text.slice(0, 80));
	},

	// The Stop button blinks out between agent steps (tool exec gaps), so doneness needs
	// sustained idle: no Stop button AND no aria-busy elements for 3 consecutive 2s samples.
	async waitIdle(timeoutMs) {
		const start = Date.now();
		let idleStreak = 0;
		while (Date.now() - start < timeoutMs) {
			const busy = await state.page.evaluate(() => {
				const stop = !!document.querySelector('[aria-label="Stop generating"]');
				// Hidden hoisted modals keep aria-busy=true while closed (0x0 rect) — only count visible ones.
				const busyEl = Array.from(document.querySelectorAll('[aria-busy="true"]')).some((el) => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && r.height > 0;
				});
				return stop || busyEl;
			});
			idleStreak = busy ? 0 : idleStreak + 1;
			if (idleStreak >= 3) return true;
			await state.page.waitForTimeout(2000);
		}
		throw new Error(`waitIdle: still busy after ${timeoutMs}ms`);
	},

	async waitDone(timeoutMs = 120000) {
		const start = Date.now();
		await state.qa.waitIdle(timeoutMs);
		// ai_chat_http rate limit is 4/min capacity 1: retry failed sends via the UI.
		for (let attempt = 0; attempt < 4; attempt++) {
			const failed = await state.page.evaluate(() =>
				Boolean(
					Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
						(el.textContent || "").includes("Message failed to send."),
					),
				),
			);
			if (!failed) break;
			await state.page.waitForTimeout(16000);
			await state.page.getByRole("button", { name: "Retry" }).last().click();
			await state.page
				.waitForSelector('[aria-label="Stop generating"]', { timeout: 15000 })
				.catch(() => undefined);
			await state.qa.waitIdle(timeoutMs);
		}
		console.log("waitDone: finished in", Math.round((Date.now() - start) / 1000), "s");
	},

	async dump() {
		const info = await state.page.evaluate(() => {
			const messages = Array.from(document.querySelectorAll(".AiChatMessage"));
			const last = messages[messages.length - 1] || null;
			const bashButtons = Array.from(document.querySelectorAll('summary[aria-label^="Bash"]')).map((el) => ({
				ariaLabel: el.getAttribute("aria-label"),
				busy: el.getAttribute("aria-busy"),
				open: el.closest("details")?.open ?? null,
			}));
			return {
				messageCount: messages.length,
				lastMessageText: last ? (last.textContent || "").slice(0, 600) : null,
				bashButtons,
			};
		});
		console.log("dump:", JSON.stringify(info, null, 2));
		return info;
	},

	async readTerminal(index = -1) {
		const result = await state.page.evaluate((idx) => {
			const summaries = Array.from(document.querySelectorAll('summary[aria-label^="Bash"]'));
			const summary = idx >= 0 ? summaries[idx] : summaries[summaries.length - 1];
			if (!summary) return { error: "no bash summary found" };
			const details = summary.closest("details");
			if (details && !details.open) details.open = true;
			const container = details || document;
			const terminal = container.querySelector('[aria-label="Bash terminal output"]');
			return {
				summaryLabel: summary.getAttribute("aria-label"),
				terminalRole: terminal?.getAttribute("role") ?? null,
				terminalText: terminal ? (terminal.textContent || "").slice(0, 1500) : null,
			};
		}, index);
		console.log("terminal:", JSON.stringify(result, null, 2));
		return result;
	},
};
console.log("state.qa installed");
