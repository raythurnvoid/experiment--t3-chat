import "@/app.css";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import {
	files_CommentsExtension,
	files_get_thread_ids_from_editor_state,
} from "../../../../../shared/files-tiptap-comments.ts";
import { app_convex, type app_convex_Id } from "@/lib/app-convex-client.ts";

const { send, confirm, discard } = vi.hoisted(() => ({ send: vi.fn(), confirm: vi.fn(), discard: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => ({ membershipId: "member" }) },
}));
vi.mock("@/components/channels/channels-people.ts", () => ({
	useChannelsPeople: () => ({ people: [] }),
	useChannelsMentionPeople: () => [],
}));
vi.mock("@/lib/app-convex-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-convex-client.ts")>()),
	app_convex_api: {
		channels_uploads: (await importOriginal<typeof import("@/lib/app-convex-client.ts")>()).app_convex_api
			.channels_uploads,
		channels_messages: {
			send_message: "send",
			confirm_comment_anchor: "confirm",
			discard_unconfirmed_comment: "discard",
		},
	},
}));
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useMutation: (name: string) => ({ send, confirm, discard })[name],
	useQuery: () => undefined,
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useFullList: () => [] },
}));

import { FileEditorRichTextToolsComment } from "./file-editor-rich-text-tools-comment.tsx";

let editor: Editor;

beforeEach(() => {
	send.mockReset().mockResolvedValue({ _yay: { rootMessageId: "new" } });
	confirm.mockReset().mockResolvedValue({ _yay: null });
	discard.mockReset().mockResolvedValue({ _yay: null });
	const element = document.createElement("div");
	document.body.append(element);
	editor = new Editor({
		element,
		injectCSS: false,
		extensions: [Document, Paragraph, Text, files_CommentsExtension],
		content: '<p><span data-type="comment" data-lb-thread-id="old">Selected text</span></p>',
	});
	editor.commands.setTextSelection({ from: 1, to: 9 });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	const element = editor.options.element;
	editor.destroy();
	if (element instanceof HTMLElement) element.remove();
});

async function submit(commit: () => Promise<boolean>) {
	render(
		<FileEditorRichTextToolsComment
			editor={editor}
			fileNodeId={"file" as app_convex_Id<"files_nodes">}
			commentCommit={{ disabledReason: null, commit }}
		/>,
	);
	await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
	await userEvent.click(await screen.findByRole("textbox", { name: "Add comment to selection" }));
	await userEvent.keyboard("Please check this.");
	await userEvent.click(screen.getByRole("button", { name: "Submit comment" }));
}

describe("FileEditorRichTextToolsComment", () => {
	test("confirms only after saving the mark", async () => {
		const saved = Promise.withResolvers<boolean>();
		await submit(() => saved.promise);
		await waitFor(() => expect(files_get_thread_ids_from_editor_state(editor.state)).toContain("new"));
		expect(confirm, "an unsaved anchor must not be confirmed").not.toHaveBeenCalled();
		await act(async () => saved.resolve(true));
		await waitFor(() => expect(confirm).toHaveBeenCalledWith({ membershipId: "member", rootMessageId: "new" }));
		expect(discard).not.toHaveBeenCalled();
	});

	test("a failed save keeps the draft and the older overlapping mark", async () => {
		await submit(async () => false);
		await waitFor(() => expect(discard).toHaveBeenCalledWith({ membershipId: "member", rootMessageId: "new" }));
		expect(files_get_thread_ids_from_editor_state(editor.state), "failed save must remove only the new mark").toEqual([
			"old",
		]);
		expect(confirm).not.toHaveBeenCalled();
		const composer = screen.queryByRole("textbox", { name: "Add comment to selection" });
		expect(composer, "failed save must keep the composer open").not.toBeNull();
		expect(composer?.textContent, "failed save must keep the draft").toBe("Please check this.");
	});

	test("a discarded upload needs fresh bytes before retrying the comment", async () => {
		const mint = vi
			.spyOn(app_convex, "mutation")
			.mockResolvedValueOnce({ _yay: { uploadId: "old-upload", url: "https://upload.test/first", headers: {} } })
			.mockResolvedValueOnce({ _yay: { uploadId: "fresh-upload", url: "https://upload.test/second", headers: {} } });
		vi.spyOn(app_convex, "action").mockResolvedValue({ _yay: null });
		vi.stubGlobal(
			"XMLHttpRequest",
			class {
				status = 200;
				upload = {};
				onload: (() => void) | null = null;
				open() {}
				setRequestHeader() {}
				send() {
					queueMicrotask(() => this.onload?.());
				}
				abort() {}
			},
		);
		const commit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		render(
			<FileEditorRichTextToolsComment
				editor={editor}
				fileNodeId={"file" as app_convex_Id<"files_nodes">}
				commentCommit={{ disabledReason: null, commit }}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		fireEvent.change(screen.getByLabelText("Choose files to upload"), {
			target: { files: [new File(["bytes"], "draft.bin")] },
		});
		await screen.findByText("Ready");
		await userEvent.click(screen.getByRole("button", { name: "Submit comment" }));
		await screen.findByText("The comment was not saved. Upload this file again.");
		expect(send.mock.calls[0]?.[0].attachments).toEqual([{ kind: "upload", uploadId: "old-upload" }]);
		expect(
			screen.getByRole("button", { name: "Submit comment" }).hasAttribute("disabled"),
			"discarded bytes must block another send",
		).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "Retry draft.bin" }));
		await screen.findByText("Ready");
		expect(mint, "discarded bytes need a new upload target").toHaveBeenCalledTimes(2);
		send.mockResolvedValueOnce({ _yay: { rootMessageId: "new-second" } });
		await userEvent.click(screen.getByRole("button", { name: "Submit comment" }));
		await waitFor(() => expect(confirm).toHaveBeenCalledWith({ membershipId: "member", rootMessageId: "new-second" }));
		expect(send.mock.calls[1]?.[0].attachments).toEqual([{ kind: "upload", uploadId: "fresh-upload" }]);
		expect(send.mock.calls[1]?.[0].clientMessageId, "discarded roots need a new send id").not.toBe(
			send.mock.calls[0]?.[0].clientMessageId,
		);
	});

	test("changed selected text discards the hidden root without saving a mark", async () => {
		const sent = Promise.withResolvers<{ _yay: { rootMessageId: string } }>();
		send.mockReturnValue(sent.promise);
		const commit = vi.fn(async () => true);
		await submit(commit);
		act(() => editor.commands.insertContentAt(1, "Changed "));
		await act(async () => sent.resolve({ _yay: { rootMessageId: "new" } }));
		await waitFor(() => expect(discard).toHaveBeenCalledOnce());
		expect(files_get_thread_ids_from_editor_state(editor.state)).toEqual(["old"]);
		expect(commit).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});
});
