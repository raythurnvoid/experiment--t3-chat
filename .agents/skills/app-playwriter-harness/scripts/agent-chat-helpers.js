// Reusable QA helpers stored on state.qa (session-persistent).
state.qa = {
	async newChat() {
		const clicked = await state.page
			.evaluate(() => {
				const btn =
					document.querySelector('button[aria-label="New chat"]') ||
					Array.from(document.querySelectorAll("button")).find(
						(button) => (button.textContent || "").trim() === "New Chat",
					);
				if (!btn) return false;
				btn.click();
				return true;
			})
			.catch((error) => {
				if (String(error).includes("Execution context was destroyed")) return true;
				throw error;
			});
		if (!clicked) throw new Error("New Chat button not found");
		await state.page.waitForTimeout(900);
		// The sidebar agent keeps every thread as a tab and does NOT reliably auto-select the
		// freshly-created one, so a send would otherwise land in the previously-selected (accumulated)
		// thread and answer from its context. Explicitly select the last empty "New chat" tab so the
		// send isolates into a clean thread.
		await state.page
			.evaluate(() => {
				const emptyTabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(
					(tab) => (tab.textContent || "").trim() === "New chat",
				);
				const target = emptyTabs[emptyTabs.length - 1];
				if (target) target.click();
			})
			.catch((error) => {
				if (String(error).includes("Execution context was destroyed")) return;
				throw error;
			});
		await state.page.waitForTimeout(700);
		const tabs = await state.page
			.evaluate(() => {
				const list = document.querySelector('[aria-label="Open chats"]');
				return list ? (list.textContent || "").slice(0, 200) : null;
			})
			.catch((error) => {
				if (String(error).includes("Execution context was destroyed")) return null;
				throw error;
			});
		console.log("newChat → tabs:", tabs);
	},

	async send(text) {
		// The composer can briefly unmount during optimistic→persisted thread swaps.
		await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
		await state.page.locator(".AiChatComposer-editor-content").fill(text);
		await state.page.waitForFunction(() => {
			const button = document.querySelector('[data-testid="ai-chat-send-button"]');
			return button instanceof HTMLButtonElement && !button.disabled;
		});
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
			const busy = await state.page
				.evaluate(() => {
					const stop = !!document.querySelector('[aria-label="Stop generating"]');
					// Hidden hoisted modals keep aria-busy=true while closed (0x0 rect) — only count visible ones.
					const busyEl = Array.from(document.querySelectorAll('[aria-busy="true"]')).some((el) => {
						const r = el.getBoundingClientRect();
						return r.width > 0 && r.height > 0;
					});
					return stop || busyEl;
				})
				.catch((error) => {
					if (String(error).includes("Execution context was destroyed")) return true;
					throw error;
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
		// waitIdle can return during a brief between-steps lull (the Stop button blinks off after a
		// tool result, before the next step starts), so the turn may still be streaming — and a
		// turn that ends without a concluding sentence has no prose to anchor on. Settle on overall
		// DOM stability instead: require the message count, terminal count, and last-message text to
		// hold UNCHANGED across two consecutive 3s samples with no Stop button. This fully drains the
		// turn before the caller starts the next case, which is what prevents thread-to-thread bleed.
		let sig = null;
		let stableStreak = 0;
		for (let i = 0; i < 24 && Date.now() - start < timeoutMs; i++) {
			const cur = await state.page
				.evaluate(() => {
					const msgs = document.querySelectorAll(".AiChatMessage");
					const last = msgs[msgs.length - 1];
					const terms = document.querySelectorAll('summary[aria-label^="Bash"]').length;
					const stop = !!document.querySelector('[aria-label="Stop generating"]');
					return JSON.stringify({ m: msgs.length, t: terms, stop, len: last ? (last.textContent || "").length : 0 });
				})
				.catch((error) => {
					if (String(error).includes("Execution context was destroyed")) return null;
					throw error;
				});
			const busy = !cur || JSON.parse(cur).stop;
			stableStreak = !busy && cur === sig ? stableStreak + 1 : 0;
			sig = cur;
			if (stableStreak >= 2) break;
			await state.page.waitForTimeout(3000);
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
