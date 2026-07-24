// Reusable QA helpers stored on state.qa (session-persistent).
state.qa = {
	async newChat() {
		const selectedChatTab = state.page.locator('[aria-label="Open chats"] [role="tab"][aria-selected="true"]');
		const previousSelectedId = await selectedChatTab.getAttribute("id");
		await state.page.getByRole("button", { name: "New chat", exact: true }).click();
		await state.page.waitForFunction(
			(previousId) => {
				const selected = document.querySelector('[aria-label="Open chats"] [role="tab"][aria-selected="true"]');
				return selected?.id.startsWith("ai_thread-") && selected.id !== previousId;
			},
			previousSelectedId,
			{ timeout: 10000 },
		);
		const selectedId = await selectedChatTab.getAttribute("id");
		console.log("newChat → selected optimistic tab:", selectedId);
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

	async queue(text) {
		const previousIds = await state.page.locator("[data-queued-message-id]").evaluateAll((elements) => {
			return elements.map((element) => element.getAttribute("data-queued-message-id"));
		});
		await state.page.waitForSelector(".AiChatComposer-editor-content", { timeout: 15000 });
		await state.page.locator(".AiChatComposer-editor-content").fill(text);
		await state.page.waitForFunction(() => {
			const button = document.querySelector('[data-testid="ai-chat-send-button"]');
			return (
				button instanceof HTMLButtonElement &&
				button.getAttribute("aria-label") === "Queue message" &&
				!button.disabled
			);
		});
		await state.page.locator('[data-testid="ai-chat-send-button"]').click();
		await state.page.waitForFunction(
			(args) => {
				return Array.from(document.querySelectorAll("[data-queued-message-id]")).some((item) => {
					const messageId = item.getAttribute("data-queued-message-id");
					const messageText = item.querySelector(".AiChatQueuedMessages-text")?.textContent || "";
					return Boolean(messageId && !args.previousIds.includes(messageId) && messageText === args.text);
				});
			},
			{ previousIds, text },
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
	},

	async queueSnapshot() {
		const snapshot = await state.page.evaluate(() => {
			const tray = document.querySelector('[data-testid="ai-chat-queued-messages"]');
			const sendButton = document.querySelector('[data-testid="ai-chat-send-button"]');
			const composer = document.querySelector(".AiChatComposer");
			const textbox = composer?.querySelector('[role="textbox"]');
			const status = Array.from(document.querySelectorAll('[role="status"]')).find((element) =>
				(element.textContent || "").includes("queued message"),
			);
			return {
				messages: Array.from(
					tray?.querySelectorAll('[data-queued-message-id]') ?? [],
				).map((element) => ({
					id: element.getAttribute("data-queued-message-id"),
					text: element.querySelector(".AiChatQueuedMessages-text")?.textContent || "",
					index: Number(element.getAttribute("data-queue-index")),
					isEditing: element.getAttribute("data-editing") === "true",
				})),
				isPaused: Boolean(tray?.querySelector('[data-testid="ai-chat-queue-resume"]')),
				isFull: (tray?.textContent || "").includes("Queue is full."),
				status: status?.textContent || "",
				sendLabel: sendButton?.getAttribute("aria-label") || null,
				sendDisabled: sendButton instanceof HTMLButtonElement ? sendButton.disabled : null,
				isRunning: Boolean(document.querySelector('[aria-label="Stop generating"]')),
				composerMode: composer?.getAttribute("data-composer-mode") || null,
				composerText: textbox?.textContent || "",
				textboxLabel: textbox?.getAttribute("aria-label") || null,
			};
		});
		console.log("queue:", JSON.stringify(snapshot, null, 2));
		return snapshot;
	},

	async editQueued(index, text) {
		const row = state.page.locator('[data-queued-message-id]').nth(index);
		const messageId = await row.getAttribute("data-queued-message-id");
		if (!messageId) {
			throw new Error("editQueued: queued message is missing");
		}
		const targetRow = state.page.getByTestId(`ai-chat-queued-message-${messageId}`);
		await targetRow.locator('[data-testid="ai-chat-queued-message-edit"]').click();
		await state.page.waitForSelector('.AiChatComposer[data-composer-mode="queue-edit"]', {
			timeout: 10000,
		});
		await state.page.getByRole("textbox", { name: "Edit queued message" }).fill(text);
		await state.page.getByRole("button", { name: "Save queued message" }).click();
		// Saving can unblock normal draining, so the edited row may start and disappear.
		await state.page.waitForFunction(
			(args) => {
				const row = document.querySelector(`[data-queued-message-id="${CSS.escape(args.messageId)}"]`);
				return (
					document.querySelector(".AiChatComposer")?.getAttribute("data-composer-mode") === "message" &&
					(!row ||
						(row.getAttribute("data-editing") !== "true" &&
							(row.querySelector(".AiChatQueuedMessages-text")?.textContent || "") === args.text))
				);
			},
			{ messageId, text },
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
	},

	async cancelQueuedEdit(index) {
		const row = state.page.locator('[data-queued-message-id]').nth(index);
		const messageId = await row.getAttribute("data-queued-message-id");
		if (!messageId) {
			throw new Error("cancelQueuedEdit: queued message is missing");
		}
		const targetRow = state.page.getByTestId(`ai-chat-queued-message-${messageId}`);
		const originalText = await targetRow.locator(".AiChatQueuedMessages-text").textContent();
		await targetRow.locator('[data-testid="ai-chat-queued-message-edit"]').click();
		await state.page.waitForSelector('.AiChatComposer[data-composer-mode="queue-edit"]', {
			timeout: 10000,
		});
		await state.page.getByRole("textbox", { name: "Edit queued message" }).press("Escape");
		await state.page.waitForFunction(
			(args) => {
				const row = document.querySelector(`[data-queued-message-id="${CSS.escape(args.messageId)}"]`);
				const composer = document.querySelector(".AiChatComposer");
				return (
					composer?.getAttribute("data-composer-mode") === "message" &&
					(!row ||
						(row.getAttribute("data-editing") !== "true" &&
							(row.querySelector(".AiChatQueuedMessages-text")?.textContent || "") ===
								args.originalText))
				);
			},
			{ messageId, originalText },
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
	},

	async reorderQueued(fromIndex, toIndex) {
		const rows = state.page.locator('[data-queued-message-id]');
		const fromRow = rows.nth(fromIndex);
		const targetRow = rows.nth(toIndex);
		const movedId = await fromRow.getAttribute("data-queued-message-id");
		await fromRow.scrollIntoViewIfNeeded();
		const messageActionBox = await fromRow.locator('[data-testid="ai-chat-queued-message-edit"]').boundingBox();
		const targetBox = await targetRow.boundingBox();
		if (!movedId || !messageActionBox || !targetBox) {
			throw new Error("reorderQueued: queue row or message action is not visible");
		}

		await state.page.mouse.move(
			messageActionBox.x + messageActionBox.width / 2,
			messageActionBox.y + messageActionBox.height / 2,
		);
		await state.page.mouse.down();
		await state.page.mouse.move(
			targetBox.x + targetBox.width / 2,
			toIndex > fromIndex ? targetBox.y + targetBox.height - 2 : targetBox.y + 2,
			{ steps: 12 },
		);
		await state.page.mouse.up();
		await state.page.waitForFunction(
			(args) =>
				document.querySelectorAll('[data-queued-message-id]')[args.toIndex]?.getAttribute(
					"data-queued-message-id",
				) === args.movedId,
			{ movedId, toIndex },
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
	},

	async keyboardReorderQueued(fromIndex, direction, count = 1) {
		if (direction !== "up" && direction !== "down") {
			throw new Error('keyboardReorderQueued: direction must be "up" or "down"');
		}
		const rows = state.page.locator('[data-queued-message-id]');
		const rowCount = await rows.count();
		const row = rows.nth(fromIndex);
		const messageAction = row.locator('[data-testid="ai-chat-queued-message-edit"]');
		const movedId = await row.getAttribute("data-queued-message-id");
		if (!movedId) {
			throw new Error("keyboardReorderQueued: queued message is missing");
		}
		await messageAction.focus();
		await state.page.keyboard.press("Space");
		for (let step = 0; step < count; step += 1) {
			await state.page.keyboard.press(direction === "up" ? "ArrowUp" : "ArrowDown");
		}
		await state.page.keyboard.press("Space");
		const destinationIndex = Math.min(
			rowCount - 1,
			Math.max(0, fromIndex + (direction === "up" ? -count : count)),
		);
		await state.page.waitForFunction(
			(args) =>
				document.querySelectorAll('[data-queued-message-id]')[args.destinationIndex]?.getAttribute(
					"data-queued-message-id",
				) === args.movedId,
			{ movedId, destinationIndex },
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
	},

	async stopQueue(timeoutMs = 60000) {
		await state.page.getByRole("button", { name: "Stop generating" }).click();
		await state.page.waitForSelector('[data-testid="ai-chat-queue-resume"]', { timeout: 10000 });
		await state.qa.waitIdle(timeoutMs);
		return state.qa.queueSnapshot();
	},

	async resumeQueue() {
		await state.page.locator('[data-testid="ai-chat-queue-resume"]').click();
		await state.page.waitForFunction(
			() => !document.querySelector('[data-testid="ai-chat-queue-resume"]'),
			undefined,
			{ timeout: 10000 },
		);
		return state.qa.queueSnapshot();
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
		const stillFailed = await state.page.evaluate(() =>
			Boolean(
				Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
					(el.textContent || "").includes("Message failed to send."),
				),
			),
		);
		if (stillFailed) {
			throw new Error("waitDone: message still failed after retries");
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
		if (stableStreak < 2) {
			throw new Error(`waitDone: message DOM did not settle within ${timeoutMs}ms`);
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
