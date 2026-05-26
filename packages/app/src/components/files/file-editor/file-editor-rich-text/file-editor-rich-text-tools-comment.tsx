// This and the `file-editor-rich-text-comments.tsx` component should be implemented in
// a very similar way

import "./file-editor-rich-text-tools-comment.css";
import { useEditor } from "novel";
import { useState, useEffect, type ComponentProps, useRef } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { MyInput, MyInputBox, MyInputArea } from "@/components/my-input.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	FileEditorRichTextCommentComposer,
	type FileEditorRichTextCommentComposer_Props,
	type FileEditorRichTextCommentComposer_Ref,
} from "./file-editor-rich-text-comment-composer.tsx";

export type FileEditorRichTextToolsComment_ClassNames =
	| "FileEditorRichTextToolsComment"
	| "FileEditorRichTextToolsComment-form"
	| "FileEditorRichTextToolsComment-input"
	| "FileEditorRichTextToolsComment-submit-button";

export type FileEditorRichTextToolsComment_Props = {
	onClose: () => void;
};

export function FileEditorRichTextToolsComment(props: FileEditorRichTextToolsComment_Props) {
	const { onClose } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const createCommentsThread = useMutation(app_convex_api.chat_messages.chat_messages_threads_create);

	const { editor } = useEditor();
	const [isEmpty, setIsEmpty] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const formRef = useRef<HTMLFormElement>(null);
	const composerRef = useRef<FileEditorRichTextCommentComposer_Ref>(null);

	const handleChange: FileEditorRichTextCommentComposer_Props["onChange"] = () => {
		if (!composerRef.current) return;

		setIsEmpty(composerRef.current?.isEmpty());
	};

	const handleComposerEnter: FileEditorRichTextCommentComposer_Props["onEnter"] = () => {
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
			membershipId,
			content: markdownContent.trim(),
		})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to create comment");
					return;
				}

				editor.chain().focus().addComment(result._yay.threadId).run();

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
		<div className={cn("FileEditorRichTextToolsComment" satisfies FileEditorRichTextToolsComment_ClassNames)}>
			<form
				ref={formRef}
				className={cn("FileEditorRichTextToolsComment-form" satisfies FileEditorRichTextToolsComment_ClassNames)}
				onSubmit={handleSubmit}
			>
				<MyInput
					className={cn("FileEditorRichTextToolsComment-input" satisfies FileEditorRichTextToolsComment_ClassNames)}
				>
					<MyInputBox />
					<MyInputArea>
						<FileEditorRichTextCommentComposer
							ref={composerRef}
							autoFocus
							disabled={editor?.state.selection.empty || isSubmitting}
							onChange={handleChange}
							onEnter={handleComposerEnter}
						/>
					</MyInputArea>
					<MyIconButton
						className={cn(
							"FileEditorRichTextToolsComment-submit-button" satisfies FileEditorRichTextToolsComment_ClassNames,
						)}
						type="submit"
						variant="default"
						tooltip="Submit comment"
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
