import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AiChatComposer } from "./ai-chat-composer.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";

// The mention popup reads the workspace tree through a Convex subscription;
// serve a small fixed tree instead of a live client. Tests can override the
// mock per test (for example to render the loading state).
const { mentionTreeNodes, useQueryMock } = vi.hoisted(() => {
	const mentionTreeNodes = [
		{ name: "docs", path: "/docs", kind: "folder", archiveOperationId: undefined },
		{ name: "api.md", path: "/docs/api.md", kind: "file", archiveOperationId: undefined },
	];
	return { mentionTreeNodes, useQueryMock: vi.fn((): typeof mentionTreeNodes | undefined => mentionTreeNodes) };
});

vi.mock("convex/react", async (importOriginal) => {
	const original = await importOriginal<typeof import("convex/react")>();
	return {
		...original,
		useQuery: useQueryMock,
	};
});

// jsdom does not implement scrollIntoView; the popup calls it on the active row.
Element.prototype.scrollIntoView = vi.fn();

/**
 * Wrap the composer in the tenant context the mention popup reads.
 */
function render_with_tenant(ui: ReactElement) {
	return render(
		<AppTenantProvider
			membershipId={"membership-1" as app_convex_Id<"organizations_workspaces_users">}
			workspaceId={"workspace-1" as app_convex_Id<"organizations_workspaces">}
			workspaceName="home"
			organizationId={"organization-1" as app_convex_Id<"organizations">}
			organizationName="personal"
		>
			{ui}
		</AppTenantProvider>,
	);
}

describe("AiChatComposer", () => {
	afterEach(() => {
		cleanup();
		// Drop per-test overrides (like the loading state) and restore the tree.
		useQueryMock.mockReset();
		useQueryMock.mockImplementation(() => mentionTreeNodes);
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

		expect(onSubmit).toHaveBeenCalledWith("keep this draft", []);
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
		expect(onSubmit).toHaveBeenCalledWith("Queue this next", []);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	test("attaches a pasted image as a removable chip and submits it as a file part", async () => {
		const onSubmit = vi.fn();
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [imageFile],
				getData: () => "",
				types: ["Files"],
			},
		});

		// Image processing is async; the chip appears when the data URL is ready.
		await screen.findByRole("button", { name: "Remove shot.png" });
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("");

		// An image-only message is sendable even with empty text.
		const sendButton = screen.getByRole<HTMLButtonElement>("button", { name: "Send message" });
		expect(sendButton.disabled).toBe(false);
		fireEvent.click(sendButton);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		const [submittedText, submittedAttachments] = onSubmit.mock.calls[0];
		expect(submittedText).toBe("");
		expect(submittedAttachments).toMatchObject([{ type: "file", mediaType: "image/png", filename: "shot.png" }]);
		expect(submittedAttachments[0].url.startsWith("data:image/png;base64,")).toBe(true);
	});

	test("removing the attachment chip disables an image-only send again", async () => {
		const onSubmit = vi.fn();
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [imageFile],
				getData: () => "",
				types: ["Files"],
			},
		});

		const removeButton = await screen.findByRole("button", { name: "Remove shot.png" });
		fireEvent.click(removeButton);

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove shot.png" })).toBeNull();
		});
		// Removing the last chip unmounts the whole attachments bar.
		expect(screen.queryByLabelText("Image attachments")).toBeNull();
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send message" }).disabled).toBe(true);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	test("attaches an image picked through the file input", async () => {
		const result = render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
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

		// With no attachments the attach button sits in the configurations row and
		// the chip bar is not rendered at all.
		expect(screen.getByRole("button", { name: "Attach images" })).not.toBeNull();
		expect(screen.queryByLabelText("Image attachments")).toBeNull();

		const fileInput = result.container.querySelector<HTMLInputElement>('input[type="file"]');
		expect(fileInput).not.toBeNull();
		const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		fireEvent.change(fileInput!, { target: { files: [imageFile] } });

		await screen.findByRole("button", { name: "Remove shot.png" });
	});

	test("ignores pasted files when the clipboard also carries text", () => {
		render(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
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

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "cells.png", { type: "image/png" });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [imageFile],
				getData: () => "A1 B1",
				types: ["text/plain", "Files"],
			},
		});

		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("A1 B1");
		expect(screen.queryByRole("button", { name: "Remove cells.png" })).toBeNull();
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

		expect(screen.getByRole("textbox", { name: "Edit queued message" }).textContent).toBe("Edit this queued message");
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save queued message" }).disabled).toBe(false);
		expect(screen.queryByRole("button", { name: "Cancel editing queued message" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

		expect(onSubmit).toHaveBeenCalledWith("Edit this queued message", []);
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

		expect(onSubmit).toHaveBeenCalledWith("Edit this queued message", []);
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

	test("forwards Escape from a chip remove button to the queue edit close handler", async () => {
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
		const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [imageFile],
				getData: () => "",
				types: ["Files"],
			},
		});

		// The chip row's keydown interception must not swallow Escape: it has to
		// keep bubbling to the form so the edit still closes from a chip.
		const removeButton = await screen.findByRole("button", { name: "Remove shot.png" });
		removeButton.focus();
		fireEvent.keyDown(removeButton, { key: "Escape" });

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

	test("opens the mention popup on @ and submits the picked file as a path token", async () => {
		const onSubmit = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});

		// The popup lists the workspace tree; ArrowDown moves the highlight from
		// the folder row to the file row, Enter picks it without submitting.
		const listbox = await screen.findByRole("listbox", { name: "Files and folders" });
		expect(useQueryMock).toHaveBeenCalledWith(app_convex_api.files_nodes.list_tree, {
			membershipId: "membership-1",
		});

		// The editor keeps DOM focus, so the popup is exposed through the
		// textbox's aria-controls and aria-activedescendant.
		expect(textbox.getAttribute("aria-controls")).toBe(listbox.id);
		const [folderOption, fileOption] = screen.getAllByRole("option");
		expect(textbox.getAttribute("aria-activedescendant")).toBe(folderOption!.id);

		fireEvent.keyDown(textbox, { key: "ArrowDown" });
		expect(textbox.getAttribute("aria-activedescendant")).toBe(fileOption!.id);
		// The popup owns ArrowDown, so the composer's caret-at-end scroll flag
		// must not be set while it is open.
		expect(useAppGlobalStore.getState().ai_chat_composer_selection_collapsed_and_at_end).not.toBe(true);

		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();

		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
		});
		expect(textbox.getAttribute("aria-controls")).toBeNull();
		expect(textbox.getAttribute("aria-activedescendant")).toBeNull();
		expect(textbox.querySelector(".AiChatComposerFileMention")?.textContent).toBe("@api.md");

		// The next Enter submits; the chip serializes to the full path token.
		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
		expect(onSubmit).toHaveBeenCalledWith("@/docs/api.md ", []);
	});

	test("closes only the mention popup on Escape, keeping the composer open", async () => {
		const onClose = vi.fn();
		const outerKeyDown = vi.fn();
		render_with_tenant(
			<div onKeyDown={outerKeyDown}>
				<AiChatComposer
					canCancel={false}
					canQueue
					canSend
					isQueueing={false}
					isRunning={false}
					initialValue=""
					selectedModelId="gpt-5.4-nano"
					selectedModeId="agent"
					onSelectedModelIdChange={vi.fn()}
					onSelectedModeIdChange={vi.fn()}
					onSubmit={vi.fn()}
					onClose={onClose}
				/>
			</div>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});
		await screen.findByRole("listbox", { name: "Files and folders" });

		// The popup Escape must not reach ancestors: the chat-level keydown
		// handler cancels a message edit on Escape even when defaultPrevented.
		fireEvent.keyDown(textbox, { key: "Escape" });
		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
		});
		expect(onClose).not.toHaveBeenCalled();
		expect(outerKeyDown).not.toHaveBeenCalled();

		// With the popup closed, Escape closes the composer and still bubbles,
		// which proves the wrapper receives keydown events at all.
		fireEvent.keyDown(textbox, { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
		expect(outerKeyDown).toHaveBeenCalledOnce();
	});

	test("inserts a folder mention with a trailing slash on row click", async () => {
		const onSubmit = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});

		const [folderOption] = await screen.findAllByRole("option");
		expect(folderOption).not.toBeUndefined();
		fireEvent.mouseDown(folderOption!);
		fireEvent.click(folderOption!);

		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
		});
		expect(textbox.querySelector(".AiChatComposerFileMention")?.textContent).toBe("@docs/");

		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		expect(onSubmit).toHaveBeenCalledWith("@/docs/ ", []);
	});

	test("does not pick a mention row while IME composition is active", async () => {
		const onSubmit = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});
		await screen.findByRole("listbox", { name: "Files and folders" });

		// Enter during composition must commit the IME text, not the highlighted
		// row, and must not send the message.
		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", isComposing: true });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textbox.querySelector(".AiChatComposerFileMention")).toBeNull();
	});

	test("treats mention popup clicks as inside the composer for the outside-interaction check", async () => {
		const onInteractedOutside = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={vi.fn()}
				onInteractedOutside={onInteractedOutside}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});
		await screen.findByRole("listbox", { name: "Files and folders" });

		// The outside-interaction hook arms one frame after mount; prove it is
		// armed with a real outside pointerdown first, as the control.
		await waitFor(() => {
			fireEvent.pointerDown(document.body);
			expect(onInteractedOutside).toHaveBeenCalled();
		});
		onInteractedOutside.mockClear();

		const [popupRow] = screen.getAllByRole("option");
		fireEvent.pointerDown(popupRow!);
		expect(onInteractedOutside).not.toHaveBeenCalled();
	});

	test("swallows Enter while the mention popup shows no results", async () => {
		const onSubmit = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@zzz",
				types: ["text/plain"],
			},
		});
		await screen.findByText("No results");

		// Letting ProseMirror handle Enter here would split the paragraph and
		// break the one-paragraph message invariant.
		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textbox.querySelectorAll("p")).toHaveLength(1);
	});

	test("shows a loading row while the workspace tree has not arrived", async () => {
		const onSubmit = vi.fn();
		useQueryMock.mockReturnValue(undefined);
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue=""
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});
		await screen.findByText("Loading…");

		fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textbox.querySelector(".AiChatComposerFileMention")).toBeNull();
	});

	test("closes the mention popup when the editor loses focus", async () => {
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
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

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "@",
				types: ["text/plain"],
			},
		});
		await screen.findByRole("listbox", { name: "Files and folders" });

		fireEvent.blur(textbox);
		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
		});
	});

	test("does not open the mention popup for an @ inside a word", async () => {
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
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

		const textbox = screen.getByRole("textbox", { name: "Send a message..." });
		fireEvent.paste(textbox, {
			clipboardData: {
				files: [],
				getData: () => "user@example",
				types: ["text/plain"],
			},
		});
		await expect(screen.findByRole("listbox", { name: "Files and folders" }, { timeout: 150 })).rejects.toThrow();

		// The "@" really is in the doc right before the caret, so the popup
		// stayed closed because of the word prefix, not a failed paste.
		expect(textbox.textContent).toBe("user@example");
	});

	test("reloads a stored mention token as plain text without opening the popup", () => {
		const onSubmit = vi.fn();
		render_with_tenant(
			<AiChatComposer
				canCancel={false}
				canQueue
				canSend
				isQueueing={false}
				isRunning={false}
				initialValue="see @/docs/api.md please"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="agent"
				onSelectedModelIdChange={vi.fn()}
				onSelectedModeIdChange={vi.fn()}
				onSubmit={onSubmit}
			/>,
		);

		expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();

		// The token round-trips as plain text and sends unchanged.
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		expect(onSubmit).toHaveBeenCalledWith("see @/docs/api.md please", []);
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
