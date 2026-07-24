import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AiChatComposer } from "./ai-chat-composer.tsx";

describe("AiChatComposer", () => {
	afterEach(() => {
		cleanup();
	});

	test("names the composer textbox and configuration comboboxes", () => {
		render(
			<AiChatComposer
				canCancel={false}
				canQueue={true}
				canSend={true}
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByRole("textbox", { name: "Send a message..." })).not.toBeNull();
		expect(screen.getByRole("combobox", { name: "Chat mode: Agent" })).not.toBeNull();
		expect(screen.getByRole("combobox", { name: "Chat model: GPT-5.4 Nano" })).not.toBeNull();
	});

	test("disables send when the parent controller says sending is unsafe", () => {
		render(
			<AiChatComposer
				canCancel={false}
				canQueue={true}
				canSend={false}
				isQueueing={false}
				isRunning={false}
				initialValue="next message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
	});

	test("keeps the draft when onSubmit returns false", () => {
		const onSubmit = vi.fn(() => false);
		render(
			<AiChatComposer
				canCancel
				canQueue
				canSend={false}
				isQueueing
				isRunning
				initialValue="keep this draft"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const queueButton = screen.getByRole<HTMLButtonElement>("button", { name: "Queue message" });
		expect(queueButton.disabled).toBe(false);
		expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
		expect(queueButton.querySelector(".AiChatComposer-send-icon")).not.toBeNull();
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("keep this draft");

		fireEvent.click(queueButton);

		expect(onSubmit).toHaveBeenCalledWith("keep this draft");
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("keep this draft");
	});

	test("uses one action for Stop while empty and Queue while text is present", () => {
		const onCancel = vi.fn();
		const onSubmit = vi.fn();
		render(
			<AiChatComposer
				canCancel
				canQueue
				canSend={false}
				isQueueing
				isRunning
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
				onCancel={onCancel}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		const actionButtons = textbox.closest("form")?.querySelectorAll(".AiChatComposer-actions button");
		expect(actionButtons).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();

		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "Queue this next",
				types: ["text/plain"],
			},
		});

		const queueButton = screen.getByRole("button", { name: "Queue message" });
		expect(actionButtons).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
		expect(queueButton.querySelector(".AiChatComposer-send-icon")).not.toBeNull();

		fireEvent.click(queueButton);
		expect(onSubmit).toHaveBeenCalledWith("Queue this next");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("flushes a pending draft change before the composer unmounts", () => {
		const onValueChange = vi.fn();
		const result = render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue="normal draft prefix"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onValueChange={onValueChange}
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		const textNode = textbox.querySelector("p")?.firstChild;
		expect(textNode).not.toBeNull();
		const range = document.createRange();
		range.setStart(textNode as ChildNode, textNode?.textContent?.length ?? 0);
		range.collapse(true);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "-suffix",
				types: ["text/plain"],
			},
		});
		expect(textbox.textContent).toBe("normal draft prefix-suffix");
		expect(onValueChange).not.toHaveBeenCalled();

		result.unmount();

		expect(onValueChange).toHaveBeenCalledWith("normal draft prefix-suffix");
	});

	test("keeps the full queue button disabled and preserves the draft", () => {
		const onSubmit = vi.fn(() => true);
		render(
			<AiChatComposer
				canCancel
				canQueue={false}
				canSend={false}
				isQueueing
				isRunning
				initialValue="wait for queue space"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const queueButton = screen.getByRole<HTMLButtonElement>("button", { name: "Queue message" });
		expect(queueButton.disabled).toBe(true);
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("wait for queue space");

		fireEvent.click(queueButton);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("wait for queue space");
	});

	test("shows only the Save action and accepts unchanged queue text", () => {
		const onSubmit = vi.fn(() => true);
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend={false}
				isQueueing
				isQueueEditing
				isRunning={false}
				initialValue="Edit this queued message"
				inputLabel="Edit queued message"
				submitLabel="Save queued message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		expect(screen.getByRole("textbox", { name: "Edit queued message" }).textContent).toBe(
			"Edit this queued message",
		);
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save queued message" }).disabled).toBe(false);
		expect(screen.queryByRole("button", { name: "Cancel editing queued message" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

		expect(onSubmit).toHaveBeenCalledWith("Edit this queued message");
	});

	test("hides Stop while editing a queued message during an active response", () => {
		const onCancel = vi.fn();
		const onSubmit = vi.fn(() => true);
		render(
			<AiChatComposer
				canCancel
				canQueue
				canSend={false}
				isQueueing
				isQueueEditing
				isRunning
				initialValue="Edit this queued message"
				inputLabel="Edit queued message"
				submitLabel="Save queued message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
				onCancel={onCancel}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Cancel editing queued message" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

		expect(onSubmit).toHaveBeenCalledWith("Edit this queued message");
		expect(onCancel).not.toHaveBeenCalled();
	});

	test("forwards Escape to the queue edit close handler", () => {
		const onClose = vi.fn();
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend={false}
				isQueueing
				isQueueEditing
				isRunning={false}
				initialValue="Edit this queued message"
				inputLabel="Edit queued message"
				submitLabel="Save queued message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
				onClose={onClose}
			/>,
		);

		fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit queued message" }), {
			key: "Escape",
		});

		expect(onClose).toHaveBeenCalledOnce();
	});

	test("does not close a queued edit while IME composition is active", () => {
		const onClose = vi.fn();
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend={false}
				isQueueing
				isQueueEditing
				isRunning={false}
				initialValue="Edit this queued message"
				inputLabel="Edit queued message"
				submitLabel="Save queued message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
				onClose={onClose}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Edit queued message" });
		fireEvent.keyDown(textbox, { key: "Escape", isComposing: true });
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.keyDown(textbox, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});

	test("does not save a queued edit when Enter confirms IME text", () => {
		const onSubmit = vi.fn();
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend={false}
				isQueueing
				isQueueEditing
				isRunning={false}
				initialValue="Edit this queued message"
				inputLabel="Edit queued message"
				submitLabel="Save queued message"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Edit queued message" });
		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", isComposing: true });
		expect(onSubmit).not.toHaveBeenCalled();

		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
		expect(onSubmit).toHaveBeenCalledOnce();
		expect((onSubmit.mock.calls[0]?.[0] as string | undefined)?.trim()).toBe("Edit this queued message");
	});
});
