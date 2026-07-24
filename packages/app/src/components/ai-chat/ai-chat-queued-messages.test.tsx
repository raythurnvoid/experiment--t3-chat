import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AiChatQueuedUserMessage } from "@/hooks/ai-chat-controller.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { AiChatQueuedMessages } from "./ai-chat-queued-messages.tsx";

const messages = [
	{
		id: "ai_message-first",
		text: "First line\nSecond line",
		selectedModelId: "gpt-5.4-nano",
		selectedModeId: "agent",
	},
	{
		id: "ai_message-second",
		text: "Second queued message",
		selectedModelId: "gpt-5.4-mini",
		selectedModeId: "ask",
	},
	{
		id: "ai_message-third",
		text: "Third queued message",
		selectedModelId: "gpt-5.4-nano",
		selectedModeId: "ask",
	},
] satisfies readonly AiChatQueuedUserMessage[];

function renderQueue(
	overrides?: Partial<{
		messages: readonly AiChatQueuedUserMessage[];
		editingMessageId: AiChatQueuedUserMessage["id"] | null;
		isFull: boolean;
		isPaused: boolean;
		onEdit: (messageId: AiChatQueuedUserMessage["id"]) => void;
		onRemove: (messageId: AiChatQueuedUserMessage["id"]) => void;
		onReorderStateChange: (isReordering: boolean) => void;
		onReorder: (orderedMessageIds: readonly AiChatQueuedUserMessage["id"][]) => void;
		onResume: () => void;
	}>,
) {
	const props = {
		messages,
		editingMessageId: null,
		isFull: false,
		isPaused: false,
		onEdit: vi.fn(),
		onRemove: vi.fn(),
		onReorderStateChange: vi.fn(),
		onReorder: vi.fn(),
		onResume: vi.fn(),
		...overrides,
	};

	return {
		...render(
			<div>
				<AiChatQueuedMessages {...props} />
				<div role="textbox" tabIndex={0} />
			</div>,
		),
		props,
	};
}

describe("AiChatQueuedMessages", () => {
	afterEach(() => {
		cleanup();
		document.getElementById("app_hoisting_container" satisfies AppElementId)?.remove();
	});

	test("shows the simple title and message text without counters, Clear, or position chips", () => {
		renderQueue();

		expect(screen.getByRole("heading", { name: "Queue Messages" })).not.toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(screen.getByTestId("ai-chat-queued-message-ai_message-first").textContent).toContain(
			"First line\nSecond line",
		);
		expect(screen.getByText("Second queued message")).not.toBeNull();
		expect(screen.getByText("Third queued message")).not.toBeNull();
		expect(screen.queryByText("3 / 10")).toBeNull();
		expect(screen.queryByText("Next")).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
	});

	test("uses the message as both the edit action and drag target", () => {
		const onEdit = vi.fn();
		renderQueue({ onEdit });

		const messageAction = screen.getByRole("button", {
			name: "Edit queued message: Second queued message",
		});
		expect(messageAction.hasAttribute("data-rfd-drag-handle-context-id")).toBe(true);

		fireEvent.click(messageAction);
		expect(onEdit).toHaveBeenCalledWith("ai_message-second");
	});

	test("keeps the remove action separate from the message action", () => {
		const onEdit = vi.fn();
		const onRemove = vi.fn();
		renderQueue({ onEdit, onRemove });

		fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Second queued message" }));

		expect(onEdit).not.toHaveBeenCalled();
		expect(onRemove).toHaveBeenCalledWith("ai_message-second");
	});

	test("marks the edited row by id and keeps that state when order changes", () => {
		const view = renderQueue({ editingMessageId: "ai_message-second" });

		expect(screen.getByTestId("ai-chat-queued-message-ai_message-second").dataset.editing).toBe("true");
		expect(screen.getByRole("button", { name: "Editing queued message: Second queued message" })).not.toBeNull();

		view.rerender(
			<div>
				<AiChatQueuedMessages
					messages={[messages[2]!, messages[1]!, messages[0]!]}
					editingMessageId="ai_message-second"
					isFull={false}
					isPaused={false}
					onEdit={vi.fn()}
					onRemove={vi.fn()}
					onReorderStateChange={vi.fn()}
					onReorder={vi.fn()}
					onResume={vi.fn()}
				/>
				<div role="textbox" tabIndex={0} />
			</div>,
		);

		expect(screen.getByTestId("ai-chat-queued-message-ai_message-second").dataset.editing).toBe("true");
	});

	test("shows full and paused messages while keeping Resume", () => {
		const fullView = renderQueue({ isFull: true });
		expect(screen.getByText("Queue is full. Remove a message to add another.")).not.toBeNull();

		fullView.unmount();
		const onResume = vi.fn();
		renderQueue({ isFull: true, isPaused: true, onResume });
		expect(screen.getByText("Queue paused. Resume when you are ready.")).not.toBeNull();
		expect(screen.queryByText("Queue is full. Remove a message to add another.")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(onResume).toHaveBeenCalledOnce();
	});

	test("exposes the drag library keyboard instructions on each message action", () => {
		renderQueue();
		const secondMessageAction = screen.getByRole("button", {
			name: "Edit queued message: Second queued message",
		});
		const instructionsId = secondMessageAction.getAttribute("aria-describedby");
		expect(instructionsId).not.toBeNull();
		expect(document.getElementById(instructionsId ?? "")?.textContent).toContain(
			"Press space bar to start a drag",
		);
	});

	test("cancels keyboard drag without changing order", async () => {
		const onReorder = vi.fn();
		renderQueue({ onReorder });

		const secondMessageAction = screen.getByRole("button", {
			name: "Edit queued message: Second queued message",
		});
		secondMessageAction.focus();
		fireEvent.keyDown(secondMessageAction, { key: " ", code: "Space", keyCode: 32 });
		fireEvent.keyDown(secondMessageAction, { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
		fireEvent.keyDown(secondMessageAction, { key: "Escape", code: "Escape", keyCode: 27 });

		await waitFor(() => {
			expect(onReorder).not.toHaveBeenCalled();
		});
	});

	test("portals the dragged message outside the composer", async () => {
		const appHoistingContainer = document.createElement("div");
		appHoistingContainer.id = "app_hoisting_container" satisfies AppElementId;
		document.body.append(appHoistingContainer);
		renderQueue();

		const secondMessageAction = screen.getByRole("button", {
			name: "Edit queued message: Second queued message",
		});
		secondMessageAction.focus();
		fireEvent.keyDown(secondMessageAction, { key: " ", code: "Space", keyCode: 32 });

		await waitFor(() => {
			expect(screen.getByTestId("ai-chat-queued-message-ai_message-second").parentElement).toBe(appHoistingContainer);
		});

		fireEvent.keyDown(secondMessageAction, { key: "Escape", code: "Escape", keyCode: 27 });
	});

	test("keeps the message action enabled when one message cannot be reordered", () => {
		renderQueue({ messages: [messages[0]!] });

		const messageAction = screen.getByRole("button", {
			name: "Edit queued message: First line\nSecond line",
		});
		expect((messageAction as HTMLButtonElement).disabled).toBe(false);
		expect(messageAction.hasAttribute("data-rfd-drag-handle-context-id")).toBe(false);
	});

	test("keeps focus at the same queue position when a message disappears", () => {
		const view = renderQueue();

		screen.getByRole("button", { name: "Edit queued message: Second queued message" }).focus();
		view.rerender(
			<div>
				<AiChatQueuedMessages
					messages={[messages[0]!, messages[2]!]}
					editingMessageId={null}
					isFull={false}
					isPaused={false}
					onEdit={vi.fn()}
					onRemove={vi.fn()}
					onReorderStateChange={vi.fn()}
					onReorder={vi.fn()}
					onResume={vi.fn()}
				/>
				<div role="textbox" tabIndex={0} />
			</div>,
		);

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Edit queued message: Third queued message" }),
		);
	});

	test("returns focus to the composer when the final message disappears", () => {
		const view = renderQueue({ messages: [messages[0]!] });

		const editButton = screen
			.getByTestId("ai-chat-queued-message-ai_message-first")
			.querySelector<HTMLButtonElement>('[data-testid="ai-chat-queued-message-edit"]');
		expect(editButton).not.toBeNull();
		editButton?.focus();
		view.rerender(
			<div>
				<AiChatQueuedMessages
					messages={[]}
					editingMessageId={null}
					isFull={false}
					isPaused={false}
					onEdit={vi.fn()}
					onRemove={vi.fn()}
					onReorderStateChange={vi.fn()}
					onReorder={vi.fn()}
					onResume={vi.fn()}
				/>
				<div role="textbox" tabIndex={0} />
			</div>,
		);

		expect(document.activeElement).toBe(screen.getByRole("textbox"));
	});
});
