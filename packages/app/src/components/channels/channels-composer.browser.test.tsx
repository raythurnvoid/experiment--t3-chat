import "@/app.css";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRef } from "react";
import { userEvent } from "vitest/browser";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { ChannelsComposer, type ChannelsComposerControl_Ref } from "./channels-composer.tsx";
import { file_quotes_serialize_draft } from "../../../shared/file-quotes.ts";
import { app_convex, type app_convex_Id } from "@/lib/app-convex-client.ts";

const mocks = vi.hoisted(() => ({
	readable: true,
	file: { _id: "file-1", name: "notes.md", path: "/notes.md", kind: "file", archiveOperationId: null },
}));
vi.mock(import("convex/react"), async (importOriginal) => ({
	...(await importOriginal()),
	useQuery: (_query: unknown, args?: unknown) =>
		args && typeof args === "object" && "fileNodeIds" in args
			? [mocks.file._id]
			: args === "skip" || !mocks.readable
				? null
				: mocks.file,
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership", organizationName: "qa", workspaceName: "home" }),
	},
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useFullList: (enabled: boolean) => (enabled ? [mocks.file] : undefined) },
}));

afterEach(() => {
	cleanup();
	mocks.readable = true;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ChannelsComposer", () => {
	test("formatting commands keep the selection, update pressed state and survive restore", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const view = render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="Write formatted text"
				submitTooltip="Send"
				submitDisabled={false}
			/>,
		);
		const editor = await screen.findByLabelText("Write formatted text");
		await userEvent.fill(editor, "Keep these words");
		await userEvent.keyboard("{Control>}a{/Control}");
		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		const bold = screen.getByRole("button", { name: "Bold" });
		await userEvent.click(bold);
		await waitFor(() => expect(bold.getAttribute("aria-pressed")).toBe("true"));
		expect(ref.current?.getMarkdownContent()).toBe("**Keep these words**");
		await userEvent.click(screen.getByRole("button", { name: "Italic" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("true"),
		);
		const draft = ref.current!.getDraftContent();
		view.unmount();
		const restored = render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={draft}
				ariaLabel="Restored formatting"
				submitTooltip="Send"
				submitDisabled={false}
			/>,
		);
		await waitFor(() =>
			expect(restored.container.querySelector("strong em, em strong")?.textContent).toBe("Keep these words"),
		);
		expect(ref.current?.getDraftContent()).toBe(draft);
		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		await userEvent.click(screen.getByRole("button", { name: "Bullet list" }));
		await waitFor(() => expect(restored.container.querySelector("ul li")?.textContent).toBe("Keep these words"));
		await userEvent.click(screen.getByRole("button", { name: "Numbered list" }));
		await waitFor(() => expect(restored.container.querySelector("ol li")?.textContent).toBe("Keep these words"));
		await userEvent.click(screen.getByRole("button", { name: "Numbered list" }));
		await userEvent.click(screen.getByRole("textbox", { name: "Restored formatting" }));
		await userEvent.keyboard("{Control>}a{/Control}");
		await userEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
		await waitFor(() => expect(restored.container.querySelector("s")?.textContent).toBe("Keep these words"));
		await userEvent.click(screen.getByRole("button", { name: "Inline code" }));
		await waitFor(() => expect(restored.container.querySelector("code")?.textContent).toBe("Keep these words"));
	});

	test("code blocks keep Shift+Enter for a new line and Enter for sending", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const onEnter = vi.fn();
		const { container } = render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="Code message"
				submitTooltip="Send"
				submitDisabled={false}
				onEnter={onEnter}
			/>,
		);
		await userEvent.click(await screen.findByLabelText("Code message"));
		await userEvent.keyboard("first");
		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		await userEvent.click(screen.getByRole("button", { name: "Code block" }));
		await waitFor(() => expect(container.querySelector("pre code")?.textContent).toBe("first"));
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}second");
		expect(container.querySelector("pre code")?.textContent).toBe("first\nsecond");
		expect(onEnter).not.toHaveBeenCalled();
		await userEvent.keyboard("{Enter}");
		expect(onEnter).toHaveBeenCalledOnce();
	});

	test("links validate, preserve selected text and never submit the message form", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
		const { container } = render(
			<form onSubmit={submit}>
				<ChannelsComposer controlRef={ref} ariaLabel="Link message" submitTooltip="Send" submitDisabled={false} />
			</form>,
		);
		const editor = await screen.findByLabelText("Link message");
		await userEvent.fill(editor, "Read this");
		await userEvent.keyboard("{Control>}a{/Control}");
		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		await userEvent.click(screen.getByRole("button", { name: "Add link" }));
		const url = await screen.findByRole("textbox", { name: "Link address" });
		expect(container.querySelector("form form"), "the link form must sit outside the message form").toBeNull();
		await userEvent.fill(url, "javascript:alert(1)");
		await userEvent.click(screen.getByRole("button", { name: "Apply link" }));
		await screen.findByRole("alert");
		expect((url as HTMLInputElement).validity.valid).toBe(false);
		expect(submit).not.toHaveBeenCalled();
		await userEvent.fill(url, "https://example.com/docs");
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Message link" })).toBeNull());
		expect(ref.current?.getMarkdownContent()).toBe("[Read this](https://example.com/docs)");
		expect(submit).not.toHaveBeenCalled();
		expect(container.querySelector(".ChannelsComposerControl-editor a")?.textContent).toBe("Read this");
		await userEvent.click(screen.getByRole("button", { name: "Edit link" }));
		await userEvent.click(screen.getByRole("button", { name: "Remove link" }));
		await waitFor(() => expect(ref.current?.getMarkdownContent()).toBe("Read this"));
	});

	test("restoring a formatted draft keeps its marks, lists and code block", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const { container } = render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={
					"**Bold** *Italic* ~~Strike~~ [Link](https://example.com) `inline`\n\n- Bullet\n\n1. Numbered\n\n```js\nconst value = 1;\n```"
				}
				ariaLabel="Formatted draft"
				submitTooltip="Send"
				submitDisabled={false}
			/>,
		);
		await screen.findByLabelText("Formatted draft");
		await waitFor(() => expect(container.querySelector("strong")?.textContent).toBe("Bold"));
		expect(container.querySelector("em")?.textContent).toBe("Italic");
		expect(container.querySelector("s")?.textContent).toBe("Strike");
		expect(container.querySelector('a[href="https://example.com"]')?.textContent).toBe("Link");
		expect(container.querySelector("ul li")?.textContent).toBe("Bullet");
		expect(container.querySelector("ol li")?.textContent).toBe("Numbered");
		expect(container.querySelector("pre code")?.textContent).toBe("const value = 1;");
		expect(ref.current?.getMarkdownContent()).toContain("**Bold**");
		expect(ref.current?.getMarkdownContent()).toContain("[Link](https://example.com)");
		expect(ref.current?.getMarkdownContent()).toContain("```js\nconst value = 1;\n```");
	});

	test("pending uploads block Enter and send, then attachment-only content can send", async () => {
		const requests: {
			onload: (() => void) | null;
			upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
			status: number;
		}[] = [];
		class UploadRequest {
			status = 200;
			onload: (() => void) | null = null;
			upload = {
				onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
			};
			open = vi.fn();
			setRequestHeader = vi.fn();
			send = vi.fn(() => requests.push(this));
			abort = vi.fn();
		}
		vi.stubGlobal("XMLHttpRequest", UploadRequest);
		vi.spyOn(app_convex, "mutation").mockResolvedValue({
			_yay: { uploadId: "upload-1", url: "https://upload.invalid", headers: { "If-None-Match": "*" } },
		});
		const settled = Promise.withResolvers<{ _yay: null }>();
		vi.spyOn(app_convex, "action").mockReturnValue(settled.promise);
		const ref = createRef<ChannelsComposerControl_Ref>();
		const onEnter = vi.fn();
		render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="Upload message"
				attachmentTarget={{ kind: "channel", channelId: "channel" as app_convex_Id<"channels"> }}
				submitTooltip="Send upload"
				submitDisabled={false}
				onEnter={onEnter}
			/>,
		);
		const input = screen.getByLabelText("Choose files to upload");
		fireEvent.change(input, { target: { files: [new File(["hello"], "Report Ü.txt", { type: "text/plain" })] } });
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(ref.current?.isEmpty(), "a local attachment must make the composer nonempty").toBe(false);
		expect(ref.current?.hasPendingUploads()).toBe(true);
		expect(ref.current?.getAttachments(), "unfinished bytes must stay out of the payload").toEqual([]);
		expect(
			(screen.getByRole("button", { name: "Send upload" }) as HTMLButtonElement).disabled,
			"pending uploads must disable send",
		).toBe(true);
		await userEvent.click(await screen.findByLabelText("Upload message"));
		await userEvent.keyboard("{Enter}");
		expect(onEnter, "pending upload Enter must not send").not.toHaveBeenCalled();
		act(() => requests[0]!.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 5 }));
		await screen.findByText("Uploading 60%");
		act(() => requests[0]!.onload?.());
		await act(async () => settled.resolve({ _yay: null }));
		await screen.findByText("Ready");
		expect(ref.current?.getAttachments()).toEqual([{ kind: "upload", uploadId: "upload-1" }]);
		expect(ref.current?.hasPendingUploads()).toBe(false);
		await userEvent.keyboard("{Enter}");
		expect(onEnter).toHaveBeenCalledOnce();
		act(() => ref.current?.clear());
		expect(ref.current?.isEmpty()).toBe(true);
		expect(ref.current?.getAttachments()).toEqual([]);
	});

	test("a failed upload retries its settled attempt without a second target or PUT", async () => {
		const request = vi.fn();
		class UploadRequest {
			constructor() {
				request();
			}
			status = 200;
			onload: (() => void) | null = null;
			upload = {};
			open = vi.fn();
			setRequestHeader = vi.fn();
			send = vi.fn(() => queueMicrotask(() => this.onload?.()));
			abort = vi.fn();
		}
		vi.stubGlobal("XMLHttpRequest", UploadRequest);
		const create = vi
			.spyOn(app_convex, "mutation")
			.mockResolvedValue({ _yay: { uploadId: "upload-retry", url: "https://upload.invalid", headers: {} } });
		vi.spyOn(app_convex, "action")
			.mockRejectedValueOnce(new Error("Confirmation was lost"))
			.mockResolvedValue({ _yay: null });
		const ref = createRef<ChannelsComposerControl_Ref>();
		render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="Retry message"
				attachmentTarget={{ kind: "channel", channelId: "channel" as app_convex_Id<"channels"> }}
				submitTooltip="Send retry"
				submitDisabled={false}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Choose files to upload"), {
			target: { files: [new File(["hello"], "retry.txt")] },
		});
		await screen.findByText("Confirmation was lost");
		expect(ref.current?.hasPendingUploads()).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "Retry retry.txt" }));
		await screen.findByText("Ready");
		expect(create, "a settled retry must keep its original target").toHaveBeenCalledOnce();
		expect(request, "a settled retry must not put the bytes again").toHaveBeenCalledOnce();
		expect(ref.current?.getAttachments()).toEqual([{ kind: "upload", uploadId: "upload-retry" }]);
		act(() => ref.current?.resetUploads());
		await screen.findByText("The comment was not saved. Upload this file again.");
		expect(ref.current?.getAttachments(), "discarded comment bytes must leave the send payload").toEqual([]);
		expect(ref.current?.hasPendingUploads()).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "Remove retry.txt" }));
		expect(ref.current?.isEmpty()).toBe(true);
	});

	test("mention Enter chooses a person before sending and stores a neutral position", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const onEnter = vi.fn();
		render(
			<ChannelsComposer
				controlRef={ref}
				autoFocus="end"
				submitTooltip="Send"
				submitDisabled={false}
				ariaLabel="Message text"
				onEnter={onEnter}
				mentionItems={[{ kind: "user", id: "person-1", label: "Ana" }]}
			/>,
		);
		const composer = await screen.findByLabelText("Message text");
		expect(composer.getAttribute("role"), "the shared composer must expose a textbox role").toBe("textbox");
		await userEvent.click(composer);
		await userEvent.keyboard("@An");
		await screen.findByRole("option", { name: "Ana" });
		await userEvent.keyboard("{Enter}");
		expect(onEnter).not.toHaveBeenCalled();
		expect(ref.current?.getMentionUserIds()).toEqual(["person-1"]);
		expect(ref.current?.getMarkdownContent()).toContain('[@ id="user:0"]');
		expect(ref.current?.getMarkdownContent()).not.toContain("Ana");
		await userEvent.keyboard("{Enter}");
		expect(onEnter).toHaveBeenCalledOnce();
	});

	test("Escape closes a mention popup before its parent popover", async () => {
		render(
			<MyPopover>
				<MyPopoverTrigger>
					<button type="button">Write</button>
				</MyPopoverTrigger>
				<MyPopoverContent aria-label="Compose">
					<ChannelsComposer
						controlRef={null}
						autoFocus="end"
						submitTooltip="Send"
						submitDisabled
						ariaLabel="Mention text"
						mentionItems={[{ kind: "user", id: "person-1", label: "Ana" }]}
					/>
				</MyPopoverContent>
			</MyPopover>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Write" }));
		await userEvent.click(await screen.findByLabelText("Mention text"));
		await userEvent.keyboard("@An");
		await screen.findByRole("option", { name: "Ana" });
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("listbox", { name: "People and files" })).toBeNull());
		expect(screen.getByRole("dialog", { name: "Compose" })).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Compose" })).toBeNull());
	});

	test("Escape in the composer closes the popover around it", async () => {
		render(
			<MyPopover>
				<MyPopoverTrigger>
					<button type="button">Add comment</button>
				</MyPopoverTrigger>
				<MyPopoverContent aria-label="Comment">
					<form onSubmit={(event) => event.preventDefault()}>
						<ChannelsComposer
							controlRef={null}
							autoFocus="end"
							submitTooltip="Send"
							submitDisabled
							ariaLabel="Comment text"
						/>
					</form>
				</MyPopoverContent>
			</MyPopover>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
		const composer = await screen.findByLabelText("Comment text");
		await waitFor(() => expect(document.activeElement).toBe(composer));

		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		await userEvent.click(screen.getByRole("button", { name: "Add link" }));
		await screen.findByRole("textbox", { name: "Link address" });
		expect(screen.getByRole("dialog", { name: "Comment" })).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Message link" })).toBeNull());
		expect(screen.getByRole("dialog", { name: "Comment" })).toBeTruthy();
		await userEvent.click(composer);
		await userEvent.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull());
	});

	test("file Enter stores only a typed id and restores its current name", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const view = render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="File mention"
				mentionItems={[]}
				submitTooltip="Send"
				submitDisabled
			/>,
		);
		await userEvent.click(await screen.findByLabelText("File mention"));
		await userEvent.keyboard("@notes");
		await screen.findByRole("option", { name: "notes.md /notes.md" });
		await userEvent.keyboard("{Enter}");
		expect(ref.current?.getFileMentionIds()).toEqual(["file-1"]);
		expect(ref.current?.getMarkdownContent()).toContain('[@ id="file:0"]');
		expect(ref.current?.getMarkdownContent()).not.toContain("notes.md");
		const draft = ref.current!.getDraftContent();
		view.unmount();
		render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={draft}
				ariaLabel="Restored file"
				mentionItems={[]}
				submitTooltip="Send"
				submitDisabled
			/>,
		);
		await screen.findByText("@notes.md");
		expect(ref.current?.getFileMentionIds()).toEqual(["file-1"]);
	});

	test("people and files can share the same draft", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const onEnter = vi.fn();
		render(
			<ChannelsComposer
				controlRef={ref}
				ariaLabel="Shared mentions"
				mentionItems={[{ kind: "user", id: "person-1", label: "Ana" }]}
				submitTooltip="Send"
				submitDisabled={false}
				onEnter={onEnter}
			/>,
		);
		await userEvent.click(await screen.findByLabelText("Shared mentions"));
		await userEvent.keyboard("@An");
		await screen.findByRole("option", { name: "Ana" });
		await userEvent.keyboard("{Enter} @notes");
		await screen.findByRole("option", { name: "notes.md /notes.md" });
		await userEvent.keyboard("{Enter}");
		expect(onEnter).not.toHaveBeenCalled();
		expect(ref.current?.getMentionUserIds()).toEqual(["person-1"]);
		expect(ref.current?.getFileMentionIds()).toEqual(["file-1"]);
		expect(ref.current?.getMarkdownContent()).toContain('[@ id="user:0"]');
		expect(ref.current?.getMarkdownContent()).toContain('[@ id="file:0"]');
	});

	test("quotes survive restore in order and expose only numbered body markers", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const quotes = [
			{ fileNodeId: "file-1", text: "First\n<script>plain text</script>" },
			{ fileNodeId: null, text: "Second" },
		];
		const draft = `Before ${file_quotes_serialize_draft(quotes[0]!)} between ${file_quotes_serialize_draft(quotes[1]!)} after`;
		const { container } = render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={draft}
				ariaLabel="Quoted draft"
				submitTooltip="Send"
				submitDisabled
			/>,
		);
		await screen.findByText("Second");
		expect(ref.current?.getFileQuotes()).toEqual(quotes);
		expect(ref.current?.getMarkdownContent()).toBe('Before [file-quote id="0"] between [file-quote id="1"] after');
		expect(container.querySelector("script")).toBeNull();
		expect(ref.current?.getDraftContent()).toBe(draft);
	});

	test("formatting around a file quote keeps both text parts readable", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const quote = { fileNodeId: null, text: "Chosen words" };
		const draft = `Before ${file_quotes_serialize_draft(quote)} after`;
		const view = render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={draft}
				ariaLabel="Format a quote"
				submitTooltip="Send"
				submitDisabled
			/>,
		);
		await screen.findByText("Chosen words");
		await userEvent.click(screen.getByRole("textbox", { name: "Format a quote" }));
		await userEvent.keyboard("{Control>}a{/Control}");
		await userEvent.click(screen.getByRole("button", { name: "Formatting" }));
		await userEvent.click(screen.getByRole("button", { name: "Bold" }));
		expect(ref.current?.getMarkdownContent()).toBe('**Before** [file-quote id="0"] **after**');
		expect(ref.current?.getFileQuotes()).toEqual([quote]);
		const formatted = ref.current!.getDraftContent();
		view.unmount();
		const restored = render(
			<ChannelsComposer
				controlRef={ref}
				initialValue={formatted}
				ariaLabel="Restored quote formatting"
				submitTooltip="Send"
				submitDisabled
			/>,
		);
		await screen.findByText("Chosen words");
		expect(Array.from(restored.container.querySelectorAll("strong"), (node) => node.textContent)).toEqual([
			"Before",
			"after",
		]);
		expect(ref.current?.getFileQuotes()).toEqual([quote]);
	});

	test("a pending quote waits for the editor and keeps the existing draft", async () => {
		const ref = createRef<ChannelsComposerControl_Ref>();
		const onQuoteInserted = vi.fn();
		const quote = { fileNodeId: "file-1", text: "Chosen words" };
		const props = {
			controlRef: ref,
			initialValue: "Keep my draft",
			quoteRequest: quote,
			onQuoteInserted,
			ariaLabel: "Waiting draft",
			submitTooltip: "Send",
			submitDisabled: true,
		};
		const view = render(<ChannelsComposer {...props} disabled />);
		await screen.findByLabelText("Waiting draft");
		expect(onQuoteInserted).not.toHaveBeenCalled();
		view.rerender(<ChannelsComposer {...props} disabled={false} />);
		await screen.findByText("Chosen words");
		expect(ref.current?.getMarkdownContent()).toContain("Keep my draft");
		expect(ref.current?.getFileQuotes()).toEqual([quote]);
		expect(onQuoteInserted).toHaveBeenCalledOnce();
		view.rerender(<ChannelsComposer {...props} disabled={false} />);
		expect(ref.current?.getFileQuotes()).toHaveLength(1);
	});
});
