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
	ChannelsComposer,
	type ChannelsComposerControl_Ref,
	type ChannelsComposer_Props,
} from "@/components/channels/channels-composer.tsx";
import { files_COMMENT_MARK_TYPE } from "../../../../../shared/files-tiptap-comments.ts";
import { useChannelsMentionPeople, useChannelsPeople } from "@/components/channels/channels-people.ts";
import type { ChannelsMentionItem } from "@/components/channels/channels-composer-mention.tsx";

// #region form
type FileEditorRichTextToolsCommentForm_ClassNames = "FileEditorRichTextToolsCommentForm";

type FileEditorRichTextToolsCommentForm_Props = {
	formRef: React.RefObject<HTMLFormElement | null>;
	composerControlRef: React.RefObject<ChannelsComposerControl_Ref | null>;
	fileNodeId: app_convex_Id<"files_nodes">;
	isEmpty: boolean;
	isSubmitting: boolean;
	isSelectionEmpty: boolean;
	onChange: ChannelsComposer_Props["onChange"];
	onEnter: ChannelsComposer_Props["onEnter"];
	onSubmit: ComponentProps<"form">["onSubmit"];
	mentionItems: readonly ChannelsMentionItem[];
};

const FileEditorRichTextToolsCommentForm = memo(function FileEditorRichTextToolsCommentForm(
	props: FileEditorRichTextToolsCommentForm_Props,
) {
	const {
		formRef,
		composerControlRef,
		fileNodeId,
		isEmpty,
		isSubmitting,
		isSelectionEmpty,
		onChange,
		onEnter,
		onSubmit,
		mentionItems,
	} = props;

	return (
		<form
			ref={formRef}
			className={cn("FileEditorRichTextToolsCommentForm" satisfies FileEditorRichTextToolsCommentForm_ClassNames)}
			aria-label="New document comment"
			onSubmit={onSubmit}
		>
			<ChannelsComposer
				variant="floating"
				controlRef={composerControlRef}
				disabled={isSelectionEmpty || isSubmitting}
				submitTooltip="Submit comment"
				submitDisabled={isEmpty || isSelectionEmpty || isSubmitting}
				ariaLabel="Add comment to selection"
				attachmentTarget={{ kind: "file", fileNodeId }}
				onChange={onChange}
				onEnter={onEnter}
				mentionItems={mentionItems}
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
	 * Wait until the new mark reaches the stored file. Collaborative files wait for Yjs;
	 * non-collaborative files save the mark right away.
	 */
	commentCommit: {
		/**
		 * Why the member cannot comment right now, or `null` when they can.
		 *
		 * Non-collaborative files must be clean: saving a mark also saves their text.
		 */
		disabledReason: string | null;
		/**
		 * Save the new mark or wait for Yjs to save it. Return `false` on failure,
		 * so the caller can remove the mark.
		 */
		commit: () => Promise<boolean>;
	};
	buttonVariant?: MyButton_Props["variant"];
};

type FileEditorRichTextToolsCommentInner_Props = FileEditorRichTextToolsComment_Props & {
	isSelectionEmpty: boolean;
};

/**
 * Remove only the mark of one thread. `unsetMark` would also drop an older thread's mark
 * wherever the selection overlaps it.
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
	const { editor, fileNodeId, commentCommit, buttonVariant = "ghost-highlightable", isSelectionEmpty } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const sendMessage = useMutation(app_convex_api.channels_messages.send_message);
	const confirmAnchor = useMutation(app_convex_api.channels_messages.confirm_comment_anchor);
	const discardComment = useMutation(app_convex_api.channels_messages.discard_unconfirmed_comment);
	const { people } = useChannelsPeople();
	const mentionItems = useChannelsMentionPeople({ fileNodeId }, people);

	const [open, setOpen] = useState(false);
	const [isEmpty, setIsEmpty] = useState(true);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const formRef = useRef<HTMLFormElement>(null);
	const composerControlRef = useRef<ChannelsComposerControl_Ref>(null);
	const openRef = useRef(false);
	const retry = useRef<{ signature: string; id: string } | null>(null);

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

	const handleChange: ChannelsComposer_Props["onChange"] = () => {
		if (!composerControlRef.current) return;

		setIsEmpty(composerControlRef.current.isEmpty());
	};

	const handleComposerEnter: ChannelsComposer_Props["onEnter"] = () => {
		if (!formRef.current) return;

		formRef.current.requestSubmit();
	};

	const handleSubmit = useFn<NonNullable<ComponentProps<"form">["onSubmit"]>>(async (e) => {
		e.preventDefault();

		if (!composerControlRef.current || isSubmitting || composerControlRef.current.hasPendingUploads()) {
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
		if (commentCommit?.disabledReason) {
			toast.error(commentCommit.disabledReason);
			return;
		}

		// The mutation waits for the server, and the member can keep typing meanwhile. Capture the
		// document and selection now so the mark is only added when both are still the same.
		const capturedDoc = editor.state.doc;
		const capturedSelection = editor.state.selection;

		const markdownContent = composerControlRef.current.getMarkdownContent();
		const mentionUserIds = composerControlRef.current.getMentionUserIds();
		const fileMentionIds = composerControlRef.current.getFileMentionIds();
		const fileQuotes = composerControlRef.current.getFileQuotes();
		const attachments = composerControlRef.current.getAttachments();
		const anchorExcerpt = capturedDoc.textBetween(capturedSelection.from, capturedSelection.to, "\n").slice(0, 280);
		const signature = JSON.stringify({
			markdownContent,
			mentionUserIds,
			fileMentionIds,
			fileQuotes,
			attachments,
			anchorExcerpt,
			from: capturedSelection.from,
			to: capturedSelection.to,
		});
		if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };

		setIsSubmitting(true);

		sendMessage({
			membershipId,
			target: { kind: "file_comment", fileNodeId, anchorExcerpt },
			clientMessageId: retry.current.id,
			body: markdownContent.trim(),
			mentionUserIds,
			fileMentionIds,
			fileQuotes,
			replyTo: null,
			attachments,
			alsoInChannel: false,
			title: null,
		})
			.then(async (result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to create comment");
					return;
				}

				const threadId = result._yay.rootMessageId;
				const discard = async () => {
					const discarded = await discardComment({ membershipId, rootMessageId: threadId }).catch((error: unknown) => {
						console.error("[FileEditorRichTextToolsComment.discard] Failed to discard comment", { error });
						return null;
					});
					// Discard releases the linked bytes. Keep the local files ready for a new upload attempt.
					if (discarded && !discarded._nay) {
						retry.current = null;
						composerControlRef.current?.resetUploads();
					}
				};
				// Never move the anchor to text changed while the send was waiting.
				if (editor.isDestroyed || !editor.state.doc.eq(capturedDoc) || !editor.state.selection.eq(capturedSelection)) {
					await discard();
					toast.error("The selected text changed. Select it again.");
					return;
				}
				// Keep the composer open until saving succeeds, so a failed save keeps its draft.
				if (!editor.chain().addComment(threadId).run()) {
					await discard();
					toast.error("Could not add the comment mark");
					return;
				}
				const committed = await commentCommit.commit().catch((error: unknown) => {
					console.error(error);
					return false;
				});
				if (!committed) {
					if (!editor.isDestroyed) remove_comment_mark(editor, threadId);
					await discard();
					toast.error("Could not save the comment mark. Try again.");
					return;
				}
				const confirmed = await confirmAnchor({ membershipId, rootMessageId: threadId });
				if (confirmed._nay) {
					toast.error(confirmed._nay.message);
					return;
				}
				retry.current = null;
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
					    events, so a hover tooltip would never show. The native `title` and the
					    dynamic accessible name both work on a disabled button. */}
					<MyButton
						className={cn(
							"FileEditorRichTextToolsComment-trigger-button" satisfies FileEditorRichTextToolsComment_ClassNames,
						)}
						variant={buttonVariant}
						disabled={commentCommit?.disabledReason != null}
						title={commentCommit?.disabledReason ?? undefined}
						aria-label={commentCommit?.disabledReason ? "Add comment — save your changes first" : "Add comment"}
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
					aria-label="Comment"
					gutter={10}
				>
					<FileEditorRichTextToolsCommentForm
						formRef={formRef}
						composerControlRef={composerControlRef}
						fileNodeId={fileNodeId}
						isEmpty={isEmpty}
						isSubmitting={isSubmitting}
						isSelectionEmpty={isSelectionEmpty}
						mentionItems={mentionItems}
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

	const { editor, fileNodeId, commentCommit, buttonVariant = "ghost-highlightable" } = props;

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
			commentCommit={commentCommit}
			buttonVariant={buttonVariant}
			isSelectionEmpty={editorState.isSelectionEmpty}
		/>
	);
});
// #endregion root
