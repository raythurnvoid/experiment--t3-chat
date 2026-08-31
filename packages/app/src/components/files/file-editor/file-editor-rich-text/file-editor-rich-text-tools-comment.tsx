// This and the `file-editor-rich-text-comments.tsx` component should be implemented in
// a very similar way

import "./file-editor-rich-text-tools-comment.css";
import { MessageSquarePlus } from "lucide-react";
import { memo, useState, useEffect, useRef, type ComponentProps } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { useEditorState, type Editor } from "@tiptap/react";
import { MyPopover, MyPopoverTrigger, MyPopoverContent } from "@/components/my-popover.tsx";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	FileEditorCommentsComposer,
	type FileEditorCommentsComposerControl_Ref,
	type FileEditorCommentsComposer_Props,
} from "../file-editor-comments-composer.tsx";
import { files_COMMENT_MARK_TYPE } from "../../../../../shared/files-tiptap-comments.ts";

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
	fileNodeId: app_convex_Id<"files_nodes">;
	/**
	 * Why the member cannot comment right now, or `null` when they can.
	 * A file with collaboration turned off has no live sync, so a comment has to be saved
	 * into the file. Saving unsaved text edits at the same time would publish work the member
	 * did not ask to publish, so the button waits until the editor is clean.
	 */
	disabledReason: string | null;
	/**
	 * How the new comment mark reaches the stored file.
	 * A collaborative file leaves this undefined: the Yjs provider syncs the mark on its own.
	 * A file with collaboration turned off passes a handler that saves the file right away,
	 * because a mark that only lives in the open editor would be gone after a reload.
	 * Return `false` when the save failed, so the caller can take the mark back out.
	 */
	commitComment?: (threadId: string) => Promise<boolean>;
	buttonVariant?: MyButton_Props["variant"];
};

type FileEditorRichTextToolsCommentInner_Props = FileEditorRichTextToolsComment_Props & {
	isSelectionEmpty: boolean;
};

/**
 * Remove only the mark of one thread. `unsetMark` would also drop an older thread's mark
 * wherever the selection overlaps it, and `files_CommentsExtension` has no
 * "remove one comment" command, so walk the document the way `markCommentAsOrphan` does.
 */
function remove_comment_mark(editor: Editor, threadId: string) {
	const markType = editor.schema.marks[files_COMMENT_MARK_TYPE];
	const tr = editor.state.tr;
	editor.state.doc.descendants((node, pos) => {
		for (const mark of node.marks) {
			if (mark.type === markType && mark.attrs.threadId === threadId) {
				tr.removeMark(pos, pos + node.nodeSize, mark);
			}
		}
	});
	editor.view.dispatch(tr);
}

const FileEditorRichTextToolsCommentInner = memo(function FileEditorRichTextToolsCommentInner(
	props: FileEditorRichTextToolsCommentInner_Props,
) {
	const { editor, fileNodeId, disabledReason, commitComment, buttonVariant = "ghost-highlightable", isSelectionEmpty } = props;

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

		// The button is disabled, but the member can type in the document while the popover is open.
		if (disabledReason) {
			toast.error(disabledReason);
			return;
		}

		// The mutation waits for the server, and the member can keep typing meanwhile. Capture the
		// document and selection now so the mark is only added when both are still the same.
		const capturedDoc = editor.state.doc;
		const capturedSelection = editor.state.selection;

		const markdownContent = composerControlRef.current.getMarkdownContent();

		setIsSubmitting(true);

		createCommentsThread({
			membershipId,
			fileNodeId,
			content: markdownContent.trim(),
		})
			.then(async (result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to create comment");
					return;
				}

				// The save-first gate cannot see typing that happened while the mutation was waiting.
				// On a file that saves the mark right away, a changed document or selection would
				// anchor the mark to text the member never chose, so refuse and leave the composer
				// open. The thread row stays unreferenced, which is invisible and accepted.
				if (commitComment && (!editor.state.doc.eq(capturedDoc) || !editor.state.selection.eq(capturedSelection))) {
					toast.error("Save your changes before adding a comment.");
					return;
				}

				const threadId = result._yay.threadId;

				editor.chain().focus().addComment(threadId).run();

				// A collaborative file syncs the mark through Yjs on its own. A file with
				// collaboration turned off must save it now, and the popover only closes once the
				// save is known to have worked, so the member has something to retry in.
				if (commitComment) {
					// A rejected commit (a network drop, not a refusal) must also take the mark
					// back out, or it would ride along unsaved and publish with the next Save.
					const committed = await commitComment(threadId).catch((error: unknown) => {
						console.error(error);
						toast.error("Failed to save the comment");
						return false;
					});
					if (!committed) {
						remove_comment_mark(editor, threadId);
						return;
					}
				}

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
					{/* A disabled trigger cannot open the popover at all, which is the strongest block.
					    The reason cannot use the `tooltip` prop: a disabled button fires no pointer
					    events, so an Ariakit hover tooltip would never show. The native `title` and the
					    dynamic accessible name both work on a disabled button. */}
					<MyButton
						className={cn(
							"FileEditorRichTextToolsComment-trigger-button" satisfies FileEditorRichTextToolsComment_ClassNames,
						)}
						variant={buttonVariant}
						disabled={disabledReason != null}
						title={disabledReason ?? undefined}
						aria-label={disabledReason ? "Add comment — save your changes first" : "Add comment"}
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

	const { editor, fileNodeId, disabledReason, commitComment, buttonVariant = "ghost-highlightable" } = props;

	const editorState = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => {
			return {
				isSelectionEmpty: currentEditor.state.selection.empty,
			};
		},
	});

	return (
		<FileEditorRichTextToolsCommentInner
			editor={editor}
			fileNodeId={fileNodeId}
			disabledReason={disabledReason}
			commitComment={commitComment}
			buttonVariant={buttonVariant}
			isSelectionEmpty={editorState.isSelectionEmpty}
		/>
	);
});
// #endregion root
