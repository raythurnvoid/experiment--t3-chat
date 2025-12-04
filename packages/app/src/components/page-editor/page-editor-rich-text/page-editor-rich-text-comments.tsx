// The `PageEditorRichTextAnchoredCommentsForm` subcomponent
// and the `page-editor-rich-text-tools-comment.tsx` component
// should be implemented in a very similar way

import "./page-editor-rich-text-comments.css";
import {
	AnchoredThreads,
	type AnchoredThreadComponent_Props,
	AnchoredThreads_CssVars_DEFAULTS,
} from "@liveblocks/react-tiptap";
import { cn, compute_fallback_user_name, sx } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";
import type { human_thread_messages_Thread } from "../../../lib/human-thread-messages.ts";
import { useState, useRef, type ComponentProps } from "react";
import { useQuery, useMutation } from "convex/react";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { MyInput, MyInputBox, MyInputArea } from "@/components/my-input.tsx";
import {
	PageEditorRichTextCommentComposer,
	type PageEditorRichTextCommentComposer_Props,
	type PageEditorRichTextCommentComposer_Ref,
} from "./page-editor-rich-text-comment-composer.tsx";
import { MySkeleton } from "@/components/ui/my-skeleton.tsx";
import { format_relative_time } from "@/lib/date.ts";
import {
	MyAvatar,
	MyAvatarImage,
	MyAvatarFallback,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";
import { pages_parse_markdown_to_html } from "@/lib/pages.ts";
import { useMemo, type HTMLAttributes } from "react";

// #region PageEditorRichTextAnchoredCommentsMessageContent
type PageEditorRichTextAnchoredCommentsMessageContent_ClassNames = "PageEditorRichTextAnchoredCommentsMessageContent";

type PageEditorRichTextAnchoredCommentsMessageContent_Props = HTMLAttributes<HTMLDivElement> & {
	markdown: string;
};

function PageEditorRichTextAnchoredCommentsMessageContent(
	props: PageEditorRichTextAnchoredCommentsMessageContent_Props,
) {
	const { markdown, ...restProps } = props;

	const htmlContent = useMemo(() => {
		if (!markdown) {
			return "";
		}
		return pages_parse_markdown_to_html(markdown);
	}, [markdown]);

	return (
		<div
			className={
				"PageEditorRichTextAnchoredCommentsMessageContent" satisfies PageEditorRichTextAnchoredCommentsMessageContent_ClassNames
			}
			dangerouslySetInnerHTML={{ __html: htmlContent }}
			{...restProps}
		/>
	);
}
// #endregion PageEditorRichTextAnchoredCommentsMessageContent

// #region PageEditorRichTextAnchoredCommentsMessage
type PageEditorRichTextAnchoredCommentsMessage_ClassNames =
	| "PageEditorRichTextAnchoredCommentsMessage"
	| "PageEditorRichTextAnchoredCommentsMessage-avatar"
	| "PageEditorRichTextAnchoredCommentsMessage-header"
	| "PageEditorRichTextAnchoredCommentsMessage-content";

type PageEditorRichTextAnchoredCommentsMessage_Props = ComponentProps<"div"> & {
	createdBy: Pick<human_thread_messages_Thread, "created_by">["created_by"];
	createdAt: Pick<human_thread_messages_Thread, "created_at">["created_at"];
	content: Pick<human_thread_messages_Thread, "content">["content"];
	avatarFallbackDelay: boolean;
};

function PageEditorRichTextAnchoredCommentsMessage(props: PageEditorRichTextAnchoredCommentsMessage_Props) {
	const { createdBy, createdAt, content, avatarFallbackDelay, ...rest } = props;

	return (
		<div
			className={
				"PageEditorRichTextAnchoredCommentsMessage" satisfies PageEditorRichTextAnchoredCommentsMessage_ClassNames
			}
			{...rest}
		>
			<div
				className={
					"PageEditorRichTextAnchoredCommentsMessage-avatar" satisfies PageEditorRichTextAnchoredCommentsMessage_ClassNames
				}
			>
				<MyAvatar>
					<MyAvatarImage fallbackDelay={avatarFallbackDelay} />
					<MyAvatarFallback>{compute_fallback_user_name(createdBy)}</MyAvatarFallback>
					<MyAvatarLoading>
						<MyAvatarSkeleton />
					</MyAvatarLoading>
				</MyAvatar>
			</div>
			<div
				className={
					"PageEditorRichTextAnchoredCommentsMessage-header" satisfies PageEditorRichTextAnchoredCommentsMessage_ClassNames
				}
			>
				<b>{createdBy}</b> <small>{format_relative_time(createdAt)}</small>
			</div>
			<PageEditorRichTextAnchoredCommentsMessageContent markdown={content} />
		</div>
	);
}
// #endregion PageEditorRichTextAnchoredCommentsMessage

// #region PageEditorRichTextAnchoredCommentsMessageSkeleton
type PageEditorRichTextAnchoredCommentsMessageSkeleton_ClassNames =
	| "PageEditorRichTextAnchoredCommentsMessageSkeleton"
	| "PageEditorRichTextAnchoredCommentsMessageSkeleton-avatar"
	| "PageEditorRichTextAnchoredCommentsMessageSkeleton-header"
	| "PageEditorRichTextAnchoredCommentsMessageSkeleton-content";

function PageEditorRichTextAnchoredCommentsMessageSkeleton() {
	return (
		<div
			className={
				"PageEditorRichTextAnchoredCommentsMessageSkeleton" satisfies PageEditorRichTextAnchoredCommentsMessageSkeleton_ClassNames
			}
		>
			<MySkeleton
				className={
					"PageEditorRichTextAnchoredCommentsMessageSkeleton-avatar" satisfies PageEditorRichTextAnchoredCommentsMessageSkeleton_ClassNames
				}
			/>
			<MySkeleton
				className={
					"PageEditorRichTextAnchoredCommentsMessageSkeleton-header" satisfies PageEditorRichTextAnchoredCommentsMessageSkeleton_ClassNames
				}
			/>
			<MySkeleton
				className={
					"PageEditorRichTextAnchoredCommentsMessageSkeleton-content" satisfies PageEditorRichTextAnchoredCommentsMessageSkeleton_ClassNames
				}
			/>
		</div>
	);
}
// #endregion PageEditorRichTextAnchoredCommentsMessageSkeleton

// #region Form
type PageEditorRichTextAnchoredCommentsForm_ClassNames =
	| "PageEditorRichTextAnchoredCommentsForm"
	| "PageEditorRichTextAnchoredCommentsForm-input"
	| "PageEditorRichTextAnchoredCommentsForm-submit-button";

type PageEditorRichTextAnchoredCommentsForm_Props = {
	threadId: Id<"human_thread_messages">;
	onSubmit?: () => void;
};

function PageEditorRichTextAnchoredCommentsForm(props: PageEditorRichTextAnchoredCommentsForm_Props) {
	const { threadId, onSubmit } = props;

	const addMessage = useMutation(app_convex_api.human_thread_messages.human_thread_messages_add);

	const composerRef = useRef<PageEditorRichTextCommentComposer_Ref>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isEmpty, setIsEmpty] = useState(true);

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

		if (!composerRef.current) {
			return;
		}

		if (isEmpty) {
			toast.error("Write a comment before submitting.");
			return;
		}

		const markdownContent = composerRef.current.getMarkdownContent();

		if (!threadId) {
			toast.error("Thread ID is missing.");
			return;
		}

		setIsSubmitting(true);

		try {
			// Add new message to thread
			await addMessage({
				rootId: threadId,
				content: markdownContent.trim(),
			});

			// Clear the composer
			composerRef.current?.clear();
			setIsEmpty(true);
			onSubmit?.();
		} catch (e) {
			const error = e as Error;
			console.error(error);
			toast.error(error?.message ?? "Failed to add comment");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form
			ref={formRef}
			className={"PageEditorRichTextAnchoredCommentsForm" satisfies PageEditorRichTextAnchoredCommentsForm_ClassNames}
			onSubmit={handleSubmit}
		>
			<MyInput
				className={
					"PageEditorRichTextAnchoredCommentsForm-input" satisfies PageEditorRichTextAnchoredCommentsForm_ClassNames
				}
			>
				<MyInputBox />
				<MyInputArea>
					<PageEditorRichTextCommentComposer
						ref={composerRef}
						autoFocus
						disabled={isSubmitting}
						onChange={handleChange}
						onEnter={handleComposerEnter}
					/>
				</MyInputArea>
				<MyIconButton
					className={
						"PageEditorRichTextAnchoredCommentsForm-submit-button" satisfies PageEditorRichTextAnchoredCommentsForm_ClassNames
					}
					type="submit"
					variant="default"
					disabled={isEmpty || isSubmitting}
				>
					<MyIconButtonIcon>
						<ArrowUp />
					</MyIconButtonIcon>
				</MyIconButton>
			</MyInput>
		</form>
	);
}
// #endregion Form

// #region Thread
type PageEditorRichTextAnchoredCommentsThread_ClassNames =
	| "PageEditorRichTextAnchoredCommentsThread"
	| "PageEditorRichTextAnchoredCommentsThread-active"
	| "PageEditorRichTextAnchoredCommentsThread-content"
	| "PageEditorRichTextAnchoredCommentsThread-summary"
	| "PageEditorRichTextAnchoredCommentsThread-messages"
	| "PageEditorRichTextAnchoredCommentsThread-no-messages-placeholder";

type PageEditorRichTextAnchoredCommentsThread_Props = AnchoredThreadComponent_Props & { editor: Editor };

function PageEditorRichTextAnchoredCommentsThread(props: PageEditorRichTextAnchoredCommentsThread_Props) {
	const { thread, isActive, onClick } = props;

	const messagesQuery = useQuery(
		app_convex_api.human_thread_messages.human_thread_messages_list,
		isActive
			? {
					threadId: thread.id,
					limit: 100,
				}
			: "skip",
	);

	const handleToggle: ComponentProps<"details">["onToggle"] = (e) => {
		if (e.currentTarget.open) {
			// @ts-expect-error onClick is a from liveblocks exptect a MouseEvent
			// but this works fine as well
			onClick?.(e);
		}
	};

	return (
		<details
			className={cn(
				"PageEditorRichTextAnchoredCommentsThread" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
				isActive &&
					("PageEditorRichTextAnchoredCommentsThread-active" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames),
			)}
			open={isActive}
			onToggle={handleToggle}
		>
			{/* When not active, show the thread's content from props */}
			<summary
				className={
					"PageEditorRichTextAnchoredCommentsThread-summary" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames
				}
				hidden={isActive}
				aria-description={"Open comments thread"}
			>
				<PageEditorRichTextAnchoredCommentsMessage
					createdBy={thread.created_by}
					createdAt={thread.created_at}
					content={thread.content}
					avatarFallbackDelay
				/>
			</summary>
			<div
				className={
					"PageEditorRichTextAnchoredCommentsThread-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames
				}
			>
				<div
					className={
						"PageEditorRichTextAnchoredCommentsThread-messages" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames
					}
				>
					{
						// When active but query is still loading, show skeleton + thread content
						isActive &&
							(messagesQuery === undefined ? (
								<>
									<PageEditorRichTextAnchoredCommentsMessage
										createdBy={thread.created_by}
										createdAt={thread.created_at}
										content={thread.content}
										avatarFallbackDelay={false}
									/>
									<PageEditorRichTextAnchoredCommentsMessageSkeleton />
								</>
							) : (
								<>
									{
										// When active and messages loaded, show all messages
										messagesQuery.messages.map((message) => (
											<PageEditorRichTextAnchoredCommentsMessage
												key={message._id}
												createdBy={message.created_by}
												createdAt={message._creationTime}
												content={message.content}
												avatarFallbackDelay={message.created_by !== thread.created_by}
											/>
										))
									}
									{messagesQuery.messages.length === 1 && (
										<small
											className={
												"PageEditorRichTextAnchoredCommentsThread-no-messages-placeholder" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames
											}
										>
											<i>No messages yet</i>
										</small>
									)}
								</>
							))
					}
				</div>

				{isActive && thread.id && <PageEditorRichTextAnchoredCommentsForm threadId={thread.id} />}
			</div>
		</details>
	);
}
// #endregion Thread

// #region PageEditorRichTextAnchoredComments
export type PageEditorRichTextAnchoredComments_ClassNames = "PageEditorRichTextAnchoredComments";

export type PageEditorRichTextAnchoredComments_Props = {
	editor: Editor;
	threads: human_thread_messages_Thread[];
};

export function PageEditorRichTextAnchoredComments(props: PageEditorRichTextAnchoredComments_Props) {
	const { editor, threads } = props;

	// {isMobile ? (
	// 	<FloatingThreads editor={editor} threads={threads} style={{ width: "350px" }} />
	// )

	return (
		<aside className={"PageEditorRichTextAnchoredComments" satisfies PageEditorRichTextAnchoredComments_ClassNames}>
			<AnchoredThreads
				editor={editor}
				threads={threads}
				components={{ Thread: (props) => <PageEditorRichTextAnchoredCommentsThread {...props} editor={editor} /> }}
				style={sx({
					...AnchoredThreads_CssVars_DEFAULTS,
					"--lb-tiptap-anchored-threads-active-thread-offset": "0px",
				})}
			/>
		</aside>
	);
}
// #endregion PageEditorRichTextAnchoredComments
