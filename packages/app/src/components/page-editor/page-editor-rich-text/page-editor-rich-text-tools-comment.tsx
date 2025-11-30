import "./page-editor-rich-text-tools-comment.css";
import { useEditor } from "novel";
import { useState, useEffect, type ComponentProps } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { tiptap_text_to_markdown } from "@/lib/tiptap-markdown.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";

export type PageEditorRichTextToolsComment_ClassNames =
	| "PageEditorRichTextToolsComment"
	| "PageEditorRichTextToolsComment-form"
	| "PageEditorRichTextToolsComment-input"
	| "PageEditorRichTextToolsComment-actions";

export type PageEditorRichTextToolsComment_Props = {
	onCancel: () => void;
};

export function PageEditorRichTextToolsComment(props: PageEditorRichTextToolsComment_Props) {
	const { onCancel } = props;

	const createHumanThreadRoot = useMutation(app_convex_api.human_thread_messages.human_thread_messages_threads_create);

	const { editor } = useEditor();
	const [text, setText] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleChange: ComponentProps<"input">["onChange"] = (e) => {
		setText(e.target.value);
	};

	const handleSubmit: ComponentProps<"form">["onSubmit"] = async (e) => {
		e?.preventDefault();

		if (!editor) {
			return;
		}

		if (!text.trim()) {
			toast.error("Write a comment before submitting.");
			return;
		}

		const selection = editor.state.selection;
		if (selection.empty) {
			toast.error("Select some text to attach the comment to.");
			return;
		}

		setIsSubmitting(true);

		try {
			// Convert text to markdown
			const markdownContent = tiptap_text_to_markdown(text.trim());

			// Create a new root message (thread) in Convex
			const result = await createHumanThreadRoot({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				content: markdownContent,
			});

			editor.commands.addComment(result.thread_id);

			setText("");
			onCancel();
		} catch (err: any) {
			console.error(err);
			toast.error(err?.message ?? "Failed to create comment");
		} finally {
			setIsSubmitting(false);
		}
	};

	// Auto-close if selection becomes empty
	useEffect(() => {
		if (editor?.state.selection.empty) {
			onCancel();
		}
	}, [editor?.state.selection.empty, onCancel]);

	return (
		<div className={cn("PageEditorRichTextToolsComment" satisfies PageEditorRichTextToolsComment_ClassNames)}>
			<form
				className={cn("PageEditorRichTextToolsComment-form" satisfies PageEditorRichTextToolsComment_ClassNames)}
				onSubmit={handleSubmit}
			>
				<MyInput
					className={cn("PageEditorRichTextToolsComment-input" satisfies PageEditorRichTextToolsComment_ClassNames)}
				>
					<MyInputBox />
					<MyInputArea>
						<MyInputControl
							type="text"
							placeholder="Add a comment..."
							autoFocus
							disabled={editor?.state.selection.empty}
							onChange={handleChange}
						/>
					</MyInputArea>
					<MyIconButton
						type="submit"
						variant="default"
						disabled={!text.trim() || editor?.state.selection.empty || isSubmitting}
					>
						<MyIconButtonIcon>
							<ArrowUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyInput>
			</form>

			<div className={cn("PageEditorRichTextToolsComment-actions" satisfies PageEditorRichTextToolsComment_ClassNames)}>
				<MyButton type="button" variant="ghost" onClick={onCancel}>
					<MyButtonIcon>
						<X />
					</MyButtonIcon>
					Cancel
				</MyButton>
			</div>
		</div>
	);
}
