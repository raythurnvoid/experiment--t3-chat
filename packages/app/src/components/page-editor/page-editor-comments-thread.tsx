import "./page-editor-comments-thread.css";
import { useMemo, useState, useRef, type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { human_thread_messages_Thread } from "@/lib/human-thread-messages.ts";
import { compute_fallback_user_name, forward_ref } from "@/lib/utils.ts";
import { format_relative_time } from "@/lib/date.ts";
import { pages_parse_markdown_to_html } from "@/lib/pages.ts";
import {
	MyAvatar,
	MyAvatarImage,
	MyAvatarFallback,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";
import { useQuery, useMutation } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { ArrowUp, Check } from "lucide-react";
import { toast } from "sonner";
import { MyInput, MyInputArea, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MySkeleton } from "@/components/ui/my-skeleton.tsx";
import {
	PageEditorRichTextCommentComposer,
	type PageEditorRichTextCommentComposer_Props,
	type PageEditorRichTextCommentComposer_Ref,
} from "./page-editor-rich-text/page-editor-rich-text-comment-composer.tsx";
import { useRenderPromise } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";

const comment_id_pattern = /^[a-z0-9]{32}$/;

// #region filter input
export type PageEditorCommentsFilterInput_ClassNames = "PageEditorCommentsFilterInput";

export type PageEditorCommentsFilterInput_Props = {
	id?: string;
	className?: string;
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
};

export const PageEditorCommentsFilterInput = ((/* iife */) => {
	function PageEditorCommentsFilterInput(props: PageEditorCommentsFilterInput_Props) {
		const {
			id,
			className,
			value,
			onValueChange,
			placeholder = "Search comments…",
			ariaLabel = "Search comments",
		} = props;

		return (
			<MyInput
				id={id}
				className={cn("PageEditorCommentsFilterInput" satisfies PageEditorCommentsFilterInput_ClassNames, className)}
			>
				<MyInputArea>
					<MyInputBox />
					<MyInputControl
						aria-label={ariaLabel}
						placeholder={placeholder}
						value={value}
						type="search"
						onChange={(e) => onValueChange(e.target.value)}
					/>
				</MyInputArea>
			</MyInput>
		);
	}

	function normalizeQuery(query: string) {
		return query.trim().toLowerCase();
	}

	function filterThreads<TThread extends { id: string; content: string }>(threads: readonly TThread[], query: string) {
		const normalizedQuery = normalizeQuery(query);
		if (!normalizedQuery) return threads.slice();

		const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
		const isIdQuery = tokens.length > 0 && tokens.every((t) => comment_id_pattern.test(t));
		const idSet = isIdQuery ? new Set(tokens) : null;

		return threads.filter((thread) => {
			const contentLower = thread.content.toLowerCase();

			if (isIdQuery && idSet) {
				const matchesId = idSet.has(thread.id);
				const matchesContent = contentLower.includes(normalizedQuery) || tokens.some((t) => contentLower.includes(t));
				return matchesId || matchesContent;
			}

			return contentLower.includes(normalizedQuery);
		});
	}

	return Object.assign(PageEditorCommentsFilterInput, {
		normalizeQuery,
		filterThreads,
	});
})();
// #endregion filter input

// #region message content
type PageEditorCommentsThreadMessageContent_ClassNames = "PageEditorCommentsThreadMessageContent";

type PageEditorCommentsThreadMessageContent_Props = HTMLAttributes<HTMLDivElement> & {
	markdown: string;
};

function PageEditorCommentsThreadMessageContent(props: PageEditorCommentsThreadMessageContent_Props) {
	const { markdown, ...restProps } = props;

	const htmlContent = useMemo(() => {
		if (!markdown) {
			return "";
		}
		return pages_parse_markdown_to_html(markdown);
	}, [markdown]);

	return (
		<div
			className={"PageEditorCommentsThreadMessageContent" satisfies PageEditorCommentsThreadMessageContent_ClassNames}
			dangerouslySetInnerHTML={{ __html: htmlContent }}
			{...restProps}
		/>
	);
}
// #endregion message content

// #region message
type PageEditorCommentsThreadMessage_ClassNames =
	| "PageEditorCommentsThreadMessage"
	| "PageEditorCommentsThreadMessage-avatar"
	| "PageEditorCommentsThreadMessage-header"
	| "PageEditorCommentsThreadMessage-actions";

type PageEditorCommentsThreadMessage_Props = ComponentProps<"div"> & {
	createdBy: Pick<human_thread_messages_Thread, "created_by">["created_by"];
	createdAt: Pick<human_thread_messages_Thread, "created_at">["created_at"];
	content: Pick<human_thread_messages_Thread, "content">["content"];
	avatarFallbackDelay: boolean;
	actionsSlot?: ReactNode;
};

function PageEditorCommentsThreadMessage(props: PageEditorCommentsThreadMessage_Props) {
	const { createdBy, createdAt, content, avatarFallbackDelay, actionsSlot, ...rest } = props;

	return (
		<div className={"PageEditorCommentsThreadMessage" satisfies PageEditorCommentsThreadMessage_ClassNames} {...rest}>
			<div className={"PageEditorCommentsThreadMessage-avatar" satisfies PageEditorCommentsThreadMessage_ClassNames}>
				<MyAvatar>
					<MyAvatarImage fallbackDelay={avatarFallbackDelay} />
					<MyAvatarFallback>{compute_fallback_user_name(createdBy)}</MyAvatarFallback>
					<MyAvatarLoading>
						<MyAvatarSkeleton />
					</MyAvatarLoading>
				</MyAvatar>
			</div>
			<div className={"PageEditorCommentsThreadMessage-header" satisfies PageEditorCommentsThreadMessage_ClassNames}>
				<b>{createdBy}</b>
				<small>{format_relative_time(createdAt)}</small>
			</div>
			{actionsSlot && (
				<div className={"PageEditorCommentsThreadMessage-actions" satisfies PageEditorCommentsThreadMessage_ClassNames}>
					{actionsSlot}
				</div>
			)}
			<PageEditorCommentsThreadMessageContent markdown={content} />
		</div>
	);
}
// #endregion message

// #region form
type PageEditorCommentsThreadForm_ClassNames =
	| "PageEditorCommentsThreadForm"
	| "PageEditorCommentsThreadForm-input"
	| "PageEditorCommentsThreadForm-submit-button";

type PageEditorCommentsThreadForm_Props = {
	threadId: Id<"human_thread_messages">;
	composerRef?: Ref<PageEditorRichTextCommentComposer_Ref>;
	onSubmit?: () => void;
};

function PageEditorCommentsThreadForm(props: PageEditorCommentsThreadForm_Props) {
	const { threadId, onSubmit } = props;

	const addMessage = useMutation(app_convex_api.human_thread_messages.human_thread_messages_add);

	const composerRef = useRef<PageEditorRichTextCommentComposer_Ref | null>(null);
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
			className={"PageEditorCommentsThreadForm" satisfies PageEditorCommentsThreadForm_ClassNames}
			onSubmit={handleSubmit}
		>
			<MyInput className={"PageEditorCommentsThreadForm-input" satisfies PageEditorCommentsThreadForm_ClassNames}>
				<MyInputBox />
				<MyInputArea>
					<PageEditorRichTextCommentComposer
						ref={(inst) => forward_ref(inst, composerRef, props.composerRef)}
						disabled={isSubmitting}
						onChange={handleChange}
						onEnter={handleComposerEnter}
					/>
				</MyInputArea>
				<MyIconButton
					className={"PageEditorCommentsThreadForm-submit-button" satisfies PageEditorCommentsThreadForm_ClassNames}
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
// #endregion form

// #region resolve button
type PageEditorCommentsThreadResolveButton_ClassNames = "PageEditorCommentsThreadResolveButton";

type PageEditorCommentsThreadResolveButton_Props = {
	isArchiving: boolean;
	onClick: () => void;
};

function PageEditorCommentsThreadResolveButton(props: PageEditorCommentsThreadResolveButton_Props) {
	const { isArchiving, onClick } = props;

	const handleClick: MyIconButton_Props["onClick"] = (event) => {
		onClick();
	};

	return (
		<MyIconButton
			className={"PageEditorCommentsThreadResolveButton" satisfies PageEditorCommentsThreadResolveButton_ClassNames}
			variant="ghost-secondary"
			tooltip="Mark as resolved"
			aria-busy={isArchiving}
			disabled={isArchiving}
			onClick={handleClick}
		>
			<MyIconButtonIcon>
				<Check />
			</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion resolve button

// #region skeleton
type PageEditorCommentsThreadSkeleton_ClassNames =
	| "PageEditorCommentsThreadSkeleton"
	| "PageEditorCommentsThreadSkeleton-avatar"
	| "PageEditorCommentsThreadSkeleton-header"
	| "PageEditorCommentsThreadSkeleton-content";

function PageEditorCommentsThreadSkeleton() {
	return (
		<div className={"PageEditorCommentsThreadSkeleton" satisfies PageEditorCommentsThreadSkeleton_ClassNames}>
			<MySkeleton
				className={"PageEditorCommentsThreadSkeleton-avatar" satisfies PageEditorCommentsThreadSkeleton_ClassNames}
			/>
			<MySkeleton
				className={"PageEditorCommentsThreadSkeleton-header" satisfies PageEditorCommentsThreadSkeleton_ClassNames}
			/>
			<MySkeleton
				className={"PageEditorCommentsThreadSkeleton-content" satisfies PageEditorCommentsThreadSkeleton_ClassNames}
			/>
		</div>
	);
}
// #endregion skeleton

// #region root
type PageEditorCommentsThread_ClassNames =
	| "PageEditorCommentsThread"
	| "PageEditorCommentsThread-active"
	| "PageEditorCommentsThread-content"
	| "PageEditorCommentsThread-summary"
	| "PageEditorCommentsThread-messages"
	| "PageEditorCommentsThread-no-messages-placeholder";

export type PageEditorCommentsThread_Props = {
	ref?: Ref<HTMLDetailsElement>;
	className?: string;
	thread: human_thread_messages_Thread;
	open: boolean;
	hidden: boolean;
	onToggle?: ComponentProps<"details">["onToggle"];
	onClick?: React.MouseEventHandler<HTMLElement>;
};

export function PageEditorCommentsThread(props: PageEditorCommentsThread_Props) {
	const { ref, className, thread, open, hidden, onToggle, onClick } = props;

	const renderPromise = useRenderPromise();

	const composerRef = useRef<PageEditorRichTextCommentComposer_Ref | null>(null);

	const archiveThread = useMutation(app_convex_api.human_thread_messages.human_thread_messages_archive);

	const [isArchiving, setIsArchiving] = useState(false);

	const messagesQuery = useQuery(
		app_convex_api.human_thread_messages.human_thread_messages_list,
		open
			? {
					threadId: thread.id,
					limit: 100,
				}
			: "skip",
	);

	const handleToggle: ComponentProps<"details">["onToggle"] = (e) => {
		const willBeOpen = e.currentTarget.open;

		// Call parent's onToggle first
		onToggle?.(e);

		// If opening and wasn't already open, focus the composer
		if (willBeOpen && !open) {
			renderPromise
				.wait()
				.then(() => {
					composerRef.current?.focus();
				})
				.catch(console.error);

			// @ts-expect-error onClick is from liveblocks expects a MouseEvent
			// but this works fine as well
			onClick?.(e);
		}
	};

	const handleResolve = async () => {
		if (!thread.id) {
			return;
		}

		setIsArchiving(true);
		try {
			await archiveThread({ messageId: thread.id });
			toast.success("Marked as resolved");
		} catch (error) {
			const err = error as Error;
			console.error(err);
			toast.error(err?.message ?? "Failed to resolve comment");
		} finally {
			setIsArchiving(false);
		}
	};

	return (
		<details
			ref={ref}
			className={cn(
				"PageEditorCommentsThread" satisfies PageEditorCommentsThread_ClassNames,
				open && ("PageEditorCommentsThread-active" satisfies PageEditorCommentsThread_ClassNames),
				className,
			)}
			open={open}
			hidden={hidden}
			onToggle={handleToggle}
		>
			{/* When not active, show the thread's content from props */}
			<summary
				className={"PageEditorCommentsThread-summary" satisfies PageEditorCommentsThread_ClassNames}
				hidden={open}
				aria-description={"Open comments thread"}
			>
				<PageEditorCommentsThreadMessage
					createdBy={thread.created_by}
					createdAt={thread.created_at}
					content={thread.content}
					avatarFallbackDelay
					actionsSlot={
						!thread.is_archived && (
							<PageEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
						)
					}
				/>
			</summary>
			<div className={"PageEditorCommentsThread-content" satisfies PageEditorCommentsThread_ClassNames}>
				<div className={"PageEditorCommentsThread-messages" satisfies PageEditorCommentsThread_ClassNames}>
					{
						// When active but query is still loading, show skeleton + thread content
						open &&
							(messagesQuery === undefined ? (
								<>
									<PageEditorCommentsThreadMessage
										createdBy={thread.created_by}
										createdAt={thread.created_at}
										content={thread.content}
										avatarFallbackDelay={false}
										actionsSlot={
											!thread.is_archived && (
												<PageEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
											)
										}
									/>
									<PageEditorCommentsThreadSkeleton />
								</>
							) : (
								<>
									{
										// When active and messages loaded, show all messages
										messagesQuery.messages.map((message, index) => (
											<PageEditorCommentsThreadMessage
												key={message._id}
												createdBy={message.created_by}
												createdAt={message._creationTime}
												content={message.content}
												avatarFallbackDelay={message.created_by !== thread.created_by}
												actionsSlot={
													index === 0 &&
													!thread.is_archived && (
														<PageEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
													)
												}
											/>
										))
									}
									{messagesQuery.messages.length === 1 && (
										<small
											className={
												"PageEditorCommentsThread-no-messages-placeholder" satisfies PageEditorCommentsThread_ClassNames
											}
										>
											<i>No messages yet</i>
										</small>
									)}
								</>
							))
					}
				</div>

				{open && thread.id && <PageEditorCommentsThreadForm composerRef={composerRef} threadId={thread.id} />}
			</div>
		</details>
	);
}
// #endregion root
