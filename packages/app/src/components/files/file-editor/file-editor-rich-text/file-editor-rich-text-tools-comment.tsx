// This and the `file-editor-rich-text-comments.tsx` component should be implemented in
// a very similar way

import "./file-editor-rich-text-tools-comment.css";
import { MessageSquarePlus } from "lucide-react";
import { memo, useState, useEffect, useRef, type ComponentProps } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { useEditorState, type Editor } from "@tiptap/react";
import { MyPopover, MyPopoverTrigger, MyPopoverContent } from "@/components/my-popover.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	FileEditorCommentsComposer,
	type FileEditorCommentsComposerControl_Ref,
	type FileEditorCommentsComposer_Props,
} from "../file-editor-comments-composer.tsx";

// #region form
type FileEditorRichTextToolsCommentForm_ClassNames = "FileEditorRichTextToolsCommentForm";

type FileEditorRichTextToolsCommentForm_Props = {
	formRef: React.RefObject<HTMLFormElement | null>;
	composerControlRef: React.RefObject<FileEditorCommentsComposerControl_Ref | null>;
	isEmpty: boolean;
	isSubmitting: boolean;
	isSelectionEmpty: boolean;
	onChange: FileEditorCommentsComposer_Props["onChange"];
	onEnter: FileEditorCommentsComposer_Props["onEnter"];
	onSubmit: ComponentProps<"form">["onSubmit"];
};

const FileEditorRichTextToolsCommentForm = memo(function FileEditorRichTextToolsCommentForm(
	props: FileEditorRichTextToolsCommentForm_Props,
) {
	const { formRef, composerControlRef, isEmpty, isSubmitting, isSelectionEmpty, onChange, onEnter, onSubmit } = props;

	return (
		<form
			ref={formRef}
			className={cn("FileEditorRichTextToolsCommentForm" satisfies FileEditorRichTextToolsCommentForm_ClassNames)}
			aria-label="New document comment"
			onSubmit={onSubmit}
		>
			<FileEditorCommentsComposer
				variant="floating"
				controlRef={composerControlRef}
				disabled={isSelectionEmpty || isSubmitting}
				submitTooltip="Submit comment"
				submitDisabled={isEmpty || isSelectionEmpty || isSubmitting}
				ariaLabel="Add comment to selection"
				onChange={onChange}
				onEnter={onEnter}
			/>
		</form>
	);
});
// #endregion form

// #region root
export type FileEditorRichTextToolsComment_ClassNames =
	| "FileEditorRichTextToolsComment"
	| "FileEditorRichTextToolsComment-trigger-button"
	| "FileEditorRichTextToolsComment-popover-content";

export type FileEditorRichTextToolsComment_Props = {
	editor: Editor;
};

type FileEditorRichTextToolsCommentInner_Props = FileEditorRichTextToolsComment_Props & {
	isSelectionEmpty: boolean;
};

const FileEditorRichTextToolsCommentInner = memo(function FileEditorRichTextToolsCommentInner(
	props: FileEditorRichTextToolsCommentInner_Props,
) {
	const { editor, isSelectionEmpty } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const createCommentsThread = useMutation(app_convex_api.chat_messages.chat_messages_threads_create);

	const [open, setOpen] = useState(false);
	const [isEmpty, setIsEmpty] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const formRef = useRef<HTMLFormElement>(null);
	const composerControlRef = useRef<FileEditorCommentsComposerControl_Ref>(null);
	const openRef = useRef(false);

	const doSetOpen = useFn((next: boolean | ((prev: boolean) => boolean)) => {
		const prev = openRef.current;
		const nextOpen = typeof next === "function" ? next(prev) : next;

		openRef.current = nextOpen;
		setOpen(nextOpen);

		if (!nextOpen && prev) {
			composerControlRef.current?.clear();
			setIsEmpty(true);
		}
	});

	const handleChange: FileEditorCommentsComposer_Props["onChange"] = () => {
		if (!composerControlRef.current) return;

		setIsEmpty(composerControlRef.current.isEmpty());
	};

	const handleComposerEnter: FileEditorCommentsComposer_Props["onEnter"] = () => {
		if (!formRef.current) return;

		formRef.current.requestSubmit();
	};

	const handleSubmit = useFn<NonNullable<ComponentProps<"form">["onSubmit"]>>(async (e) => {
		e.preventDefault();

		if (!composerControlRef.current) {
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

		const markdownContent = composerControlRef.current.getMarkdownContent();

		setIsSubmitting(true);

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

				composerControlRef.current?.clear();
				setIsEmpty(true);

				doSetOpen(false);
			})
			.catch((err) => {
				console.error(err);
				toast.error(err?.message ?? "Failed to create comment");
			})
			.finally(() => {
				setIsSubmitting(false);
			});
	});

	// Autofocus only when the popover opens (not on every render).
	useEffect(() => {
		if (!open) {
			return;
		}

		const focusTimeout = setTimeout(() => {
			composerControlRef.current?.focus();
		});

		return () => {
			clearTimeout(focusTimeout);
		};
	}, [open]);

	return (
		<div className={cn("FileEditorRichTextToolsComment" satisfies FileEditorRichTextToolsComment_ClassNames)}>
			<MyPopover open={open} setOpen={doSetOpen} placement="bottom-end">
				<MyPopoverTrigger>
					<MyButton
						className={cn(
							"FileEditorRichTextToolsComment-trigger-button" satisfies FileEditorRichTextToolsComment_ClassNames,
						)}
						variant="ghost"
						aria-label="Add comment"
					>
						<MyButtonIcon>
							<MessageSquarePlus />
						</MyButtonIcon>
						Comment
					</MyButton>
				</MyPopoverTrigger>
				<MyPopoverContent
					className={cn(
						"FileEditorRichTextToolsComment-popover-content" satisfies FileEditorRichTextToolsComment_ClassNames,
					)}
					gutter={10}
				>
					<FileEditorRichTextToolsCommentForm
						formRef={formRef}
						composerControlRef={composerControlRef}
						isEmpty={isEmpty}
						isSubmitting={isSubmitting}
						isSelectionEmpty={isSelectionEmpty}
						onChange={handleChange}
						onEnter={handleComposerEnter}
						onSubmit={handleSubmit}
					/>
				</MyPopoverContent>
			</MyPopover>
		</div>
	);
});

export const FileEditorRichTextToolsComment = memo(function FileEditorRichTextToolsComment(
	props: FileEditorRichTextToolsComment_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	const editorState = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => {
			return {
				isSelectionEmpty: currentEditor.state.selection.empty,
			};
		},
	});

	return <FileEditorRichTextToolsCommentInner editor={editor} isSelectionEmpty={editorState.isSelectionEmpty} />;
});
// #endregion root
