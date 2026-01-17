// This and the `page-editor-rich-text-comments.tsx` component should be implemented in
// a very similar way

import "./page-editor-rich-text-tools-comment.css";
import { useEditor } from "novel";
import { useState, useEffect, type ComponentProps, useRef } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { MyInput, MyInputBox, MyInputArea } from "@/components/my-input.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import {
	PageEditorRichTextCommentComposer,
	type PageEditorRichTextCommentComposer_Props,
	type PageEditorRichTextCommentComposer_Ref,
} from "./page-editor-rich-text-comment-composer.tsx";

export type PageEditorRichTextToolsComment_ClassNames =
	| "PageEditorRichTextToolsComment"
	| "PageEditorRichTextToolsComment-form"
	| "PageEditorRichTextToolsComment-input"
	| "PageEditorRichTextToolsComment-submit-button";

export type PageEditorRichTextToolsComment_Props = {
	onClose: () => void;
};

export function PageEditorRichTextToolsComment(props: PageEditorRichTextToolsComment_Props) {
	const { onClose } = props;

	const createCommentsThread = useMutation(app_convex_api.human_thread_messages.human_thread_messages_threads_create);

	const { editor } = useEditor();
	const [isEmpty, setIsEmpty] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const formRef = useRef<HTMLFormElement>(null);
	const composerRef = useRef<PageEditorRichTextCommentComposer_Ref>(null);

	const handleChange: PageEditorRichTextCommentComposer_Props["onChange"] = () => {
		if (!composerRef.current) return;

		setIsEmpty(composerRef.current?.isEmpty());
	};

	const handleComposerEnter: PageEditorRichTextCommentComposer_Props["onEnter"] = () => {
		if (!formRef.current) return;

		formRef.current.requestSubmit();
	};

	const handleSubmit: ComponentProps<"form">["onSubmit"] = async (e) => {
		e?.preventDefault();

		if (!editor || !composerRef.current) {
			return;
		}

		if (isEmpty) {
			toast.error("Write a comment before submitting.");
			return;
		}

		const selection = editor.state.selection;
		if (selection.empty) {
			toast.error("Select some text to attach the comment to.");
			return;
		}

		const markdownContent = composerRef.current.getMarkdownContent();

		setIsSubmitting(true);

		// Create a new root message (thread) in Convex
		createCommentsThread({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			content: markdownContent.trim(),
		})
			.then((result) => {
				editor.chain().focus().addComment(result.thread_id).run();

				composerRef.current?.clear();
				setIsEmpty(true);

				onClose();
			})
			.catch((err) => {
				console.error(err);
				toast.error(err?.message ?? "Failed to create comment");
			})
			.finally(() => {
				setIsSubmitting(false);
			});
	};

	// Auto-close if selection becomes empty
	useEffect(() => {
		if (editor?.state.selection.empty) {
			onClose();
		}
	}, [editor?.state.selection.empty, onClose]);

	return (
		<div className={cn("PageEditorRichTextToolsComment" satisfies PageEditorRichTextToolsComment_ClassNames)}>
			<form
				ref={formRef}
				className={cn("PageEditorRichTextToolsComment-form" satisfies PageEditorRichTextToolsComment_ClassNames)}
				onSubmit={handleSubmit}
			>
				<MyInput
					className={cn("PageEditorRichTextToolsComment-input" satisfies PageEditorRichTextToolsComment_ClassNames)}
				>
					<MyInputBox />
					<MyInputArea>
						<PageEditorRichTextCommentComposer
							ref={composerRef}
							autoFocus
							disabled={editor?.state.selection.empty || isSubmitting}
							onChange={handleChange}
							onEnter={handleComposerEnter}
						/>
					</MyInputArea>
					<MyIconButton
						className={cn(
							"PageEditorRichTextToolsComment-submit-button" satisfies PageEditorRichTextToolsComment_ClassNames,
						)}
						type="submit"
						variant="default"
						disabled={isEmpty || editor?.state.selection.empty || isSubmitting}
					>
						<MyIconButtonIcon>
							<ArrowUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyInput>
			</form>
		</div>
	);
}
