import "./file-editor-comments-thread.css";
import { useMemo, useState, useRef, type ComponentProps, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { chat_messages_Thread } from "@/lib/chat-messages.ts";
import { compute_fallback_user_name, forward_ref } from "@/lib/utils.ts";
import { format_relative_time } from "@/lib/date.ts";
import { files_parse_markdown_to_html } from "@/lib/files.ts";
import {
	MyAvatar,
	MyAvatarImage,
	MyAvatarFallback,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";
import { useQuery, useMutation } from "convex/react";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { ArrowUp, Check } from "lucide-react";
import { toast } from "sonner";
import { MyInput, MyInputArea, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import {
	FileEditorRichTextCommentComposer,
	type FileEditorRichTextCommentComposer_Props,
	type FileEditorRichTextCommentComposer_Ref,
} from "./file-editor-rich-text/file-editor-rich-text-comment-composer.tsx";
import { useRenderPromise } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

const comment_id_pattern = /^[a-z0-9]{32}$/;

// #region filter input
export type FileEditorCommentsFilterInput_ClassNames = "FileEditorCommentsFilterInput";

export type FileEditorCommentsFilterInput_Props = {
	id?: string;
	className?: string;
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
};

export function FileEditorCommentsFilterInput(props: FileEditorCommentsFilterInput_Props) {
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
			variant="surface"
			className={cn("FileEditorCommentsFilterInput" satisfies FileEditorCommentsFilterInput_ClassNames, className)}
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

FileEditorCommentsFilterInput.filterThreads = <TThread extends { id: string; content: string }>(
	threads: readonly TThread[],
	query: string,
) => {
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
};
// #endregion filter input

// #region message content
type FileEditorCommentsThreadMessageContent_ClassNames = "FileEditorCommentsThreadMessageContent";

type FileEditorCommentsThreadMessageContent_Props = HTMLAttributes<HTMLDivElement> & {
	markdown: string;
};

function FileEditorCommentsThreadMessageContent(props: FileEditorCommentsThreadMessageContent_Props) {
	const { markdown, ...restProps } = props;

	const htmlContent = useMemo(() => {
		if (!markdown) {
			return "";
		}
		const result = files_parse_markdown_to_html(markdown);
		if (result._nay) {
			console.error(result._nay);
			return "";
		}
		return result._yay;
	}, [markdown]);

	return (
		<div
			className={"FileEditorCommentsThreadMessageContent" satisfies FileEditorCommentsThreadMessageContent_ClassNames}
			dangerouslySetInnerHTML={{ __html: htmlContent }}
			{...restProps}
		/>
	);
}
// #endregion message content

// #region message
type FileEditorCommentsThreadMessage_ClassNames =
	| "FileEditorCommentsThreadMessage"
	| "FileEditorCommentsThreadMessage-avatar"
	| "FileEditorCommentsThreadMessage-header"
	| "FileEditorCommentsThreadMessage-actions";

type FileEditorCommentsThreadMessage_Props = ComponentProps<"div"> & {
	createdBy: Pick<chat_messages_Thread, "createdBy">["createdBy"];
	createdAt: Pick<chat_messages_Thread, "createdAt">["createdAt"];
	content: Pick<chat_messages_Thread, "content">["content"];
	avatarFallbackDelay: boolean;
	actionsSlot?: ReactNode;
};

function FileEditorCommentsThreadMessage(props: FileEditorCommentsThreadMessage_Props) {
	const { createdBy, createdAt, content, avatarFallbackDelay, actionsSlot, ...rest } = props;

	return (
		<div className={"FileEditorCommentsThreadMessage" satisfies FileEditorCommentsThreadMessage_ClassNames} {...rest}>
			<div className={"FileEditorCommentsThreadMessage-avatar" satisfies FileEditorCommentsThreadMessage_ClassNames}>
				<MyAvatar>
					<MyAvatarImage fallbackDelay={avatarFallbackDelay} />
					<MyAvatarFallback>{compute_fallback_user_name(createdBy)}</MyAvatarFallback>
					<MyAvatarLoading>
						<MyAvatarSkeleton />
					</MyAvatarLoading>
				</MyAvatar>
			</div>
			<div className={"FileEditorCommentsThreadMessage-header" satisfies FileEditorCommentsThreadMessage_ClassNames}>
				<b>{createdBy}</b>
				<small>{format_relative_time(createdAt)}</small>
			</div>
			{actionsSlot && (
				<div className={"FileEditorCommentsThreadMessage-actions" satisfies FileEditorCommentsThreadMessage_ClassNames}>
					{actionsSlot}
				</div>
			)}
			<FileEditorCommentsThreadMessageContent markdown={content} />
		</div>
	);
}
// #endregion message

// #region form
type FileEditorCommentsThreadForm_ClassNames =
	| "FileEditorCommentsThreadForm"
	| "FileEditorCommentsThreadForm-input"
	| "FileEditorCommentsThreadForm-submit-button";

type FileEditorCommentsThreadForm_Props = {
	threadId: Id<"chat_messages">;
	composerRef?: Ref<FileEditorRichTextCommentComposer_Ref>;
	onSubmit?: () => void;
};

function FileEditorCommentsThreadForm(props: FileEditorCommentsThreadForm_Props) {
	const { threadId, onSubmit } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const addMessage = useMutation(app_convex_api.chat_messages.chat_messages_add);

	const composerRef = useRef<FileEditorRichTextCommentComposer_Ref | null>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isEmpty, setIsEmpty] = useState(true);

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

		// Add new message to thread
		addMessage({
			membershipId,
			rootId: threadId,
			content: markdownContent.trim(),
		})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to add comment");
					return;
				}

				composerRef.current?.clear();
				setIsEmpty(true);
				onSubmit?.();
			})
			.catch((e) => {
				const error = e as Error;
				console.error(error);
				toast.error(error?.message ?? "Failed to add comment");
			})
			.finally(() => {
				setIsSubmitting(false);
			});
	};

	return (
		<form
			ref={formRef}
			className={"FileEditorCommentsThreadForm" satisfies FileEditorCommentsThreadForm_ClassNames}
			onSubmit={handleSubmit}
		>
			<MyInput
				variant="surface"
				className={"FileEditorCommentsThreadForm-input" satisfies FileEditorCommentsThreadForm_ClassNames}
			>
				<MyInputBox />
				<MyInputArea>
					<FileEditorRichTextCommentComposer
						ref={(inst) => forward_ref(inst, composerRef, props.composerRef)}
						disabled={isSubmitting}
						onChange={handleChange}
						onEnter={handleComposerEnter}
					/>
				</MyInputArea>
				<MyIconButton
					className={"FileEditorCommentsThreadForm-submit-button" satisfies FileEditorCommentsThreadForm_ClassNames}
					type="submit"
					variant="default"
					tooltip="Reply to comment"
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
type FileEditorCommentsThreadResolveButton_ClassNames = "FileEditorCommentsThreadResolveButton";

type FileEditorCommentsThreadResolveButton_Props = {
	isArchiving: boolean;
	onClick: () => void;
};

function FileEditorCommentsThreadResolveButton(props: FileEditorCommentsThreadResolveButton_Props) {
	const { isArchiving, onClick } = props;

	const handleClick: MyIconButton_Props["onClick"] = (event) => {
		onClick();
	};

	return (
		<MyIconButton
			className={"FileEditorCommentsThreadResolveButton" satisfies FileEditorCommentsThreadResolveButton_ClassNames}
			variant="outline"
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
type FileEditorCommentsThreadSkeleton_ClassNames =
	| "FileEditorCommentsThreadSkeleton"
	| "FileEditorCommentsThreadSkeleton-avatar"
	| "FileEditorCommentsThreadSkeleton-header"
	| "FileEditorCommentsThreadSkeleton-content";

function FileEditorCommentsThreadSkeleton() {
	return (
		<div className={"FileEditorCommentsThreadSkeleton" satisfies FileEditorCommentsThreadSkeleton_ClassNames}>
			<MySkeleton
				className={"FileEditorCommentsThreadSkeleton-avatar" satisfies FileEditorCommentsThreadSkeleton_ClassNames}
			/>
			<MySkeleton
				className={"FileEditorCommentsThreadSkeleton-header" satisfies FileEditorCommentsThreadSkeleton_ClassNames}
			/>
			<MySkeleton
				className={"FileEditorCommentsThreadSkeleton-content" satisfies FileEditorCommentsThreadSkeleton_ClassNames}
			/>
		</div>
	);
}
// #endregion skeleton

// #region root
type FileEditorCommentsThread_ClassNames =
	| "FileEditorCommentsThread"
	| "FileEditorCommentsThread-active"
	| "FileEditorCommentsThread-content"
	| "FileEditorCommentsThread-summary"
	| "FileEditorCommentsThread-messages"
	| "FileEditorCommentsThread-no-messages-placeholder";

export type FileEditorCommentsThread_Props = {
	ref?: Ref<HTMLDetailsElement>;
	className?: string;
	thread: chat_messages_Thread;
	open: boolean;
	hidden: boolean;
	onToggle?: ComponentProps<"details">["onToggle"];
	onClick?: React.MouseEventHandler<HTMLElement>;
};

export function FileEditorCommentsThread(props: FileEditorCommentsThread_Props) {
	const { ref, className, thread, open, hidden, onToggle, onClick } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const renderPromise = useRenderPromise();

	const composerRef = useRef<FileEditorRichTextCommentComposer_Ref | null>(null);

	const archiveThread = useMutation(app_convex_api.chat_messages.chat_messages_archive);

	const [isArchiving, setIsArchiving] = useState(false);

	const messagesQuery = useQuery(
		app_convex_api.chat_messages.chat_messages_list,
		open
			? {
					membershipId,
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
				.catch((error) => {
					console.error("[FileEditorCommentsThread.handleToggle] Error focusing composer", { error });
				});

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

		archiveThread({ membershipId, messageId: thread.id })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message ?? "Failed to resolve comment");
					return;
				}

				toast.success("Marked as resolved");
			})
			.catch((e) => {
				const error = e as Error;
				console.error(error);
				toast.error(error?.message ?? "Failed to resolve comment");
			})
			.finally(() => {
				setIsArchiving(false);
			});
	};

	return (
		<details
			ref={ref}
			className={cn(
				"FileEditorCommentsThread" satisfies FileEditorCommentsThread_ClassNames,
				open && ("FileEditorCommentsThread-active" satisfies FileEditorCommentsThread_ClassNames),
				className,
			)}
			open={open}
			hidden={hidden}
			onToggle={handleToggle}
		>
			{/* When not active, show the thread's content from props */}
			<summary
				className={"FileEditorCommentsThread-summary" satisfies FileEditorCommentsThread_ClassNames}
				hidden={open}
				aria-description={"Open comments thread"}
			>
				<FileEditorCommentsThreadMessage
					createdBy={thread.createdBy}
					createdAt={thread.createdAt}
					content={thread.content}
					avatarFallbackDelay
					actionsSlot={
						!thread.isArchived && (
							<FileEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
						)
					}
				/>
			</summary>
			<div className={"FileEditorCommentsThread-content" satisfies FileEditorCommentsThread_ClassNames}>
				<div className={"FileEditorCommentsThread-messages" satisfies FileEditorCommentsThread_ClassNames}>
					{
						// When active but query is still loading, show skeleton + thread content
						open &&
							(messagesQuery === undefined ? (
								<>
									<FileEditorCommentsThreadMessage
										createdBy={thread.createdBy}
										createdAt={thread.createdAt}
										content={thread.content}
										avatarFallbackDelay={false}
										actionsSlot={
											!thread.isArchived && (
												<FileEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
											)
										}
									/>
									<FileEditorCommentsThreadSkeleton />
								</>
							) : (
								<>
									{
										// When active and messages loaded, show all messages
										messagesQuery.messages.map((message, index) => (
											<FileEditorCommentsThreadMessage
												key={message._id}
												createdBy={message.createdBy}
												createdAt={message._creationTime}
												content={message.content}
												avatarFallbackDelay={message.createdBy !== thread.createdBy}
												actionsSlot={
													index === 0 &&
													!thread.isArchived && (
														<FileEditorCommentsThreadResolveButton isArchiving={isArchiving} onClick={handleResolve} />
													)
												}
											/>
										))
									}
									{messagesQuery.messages.length === 1 && (
										<small
											className={
												"FileEditorCommentsThread-no-messages-placeholder" satisfies FileEditorCommentsThread_ClassNames
											}
										>
											<i>No messages yet</i>
										</small>
									)}
								</>
							))
					}
				</div>

				{open && thread.id && <FileEditorCommentsThreadForm composerRef={composerRef} threadId={thread.id} />}
			</div>
		</details>
	);
}
// #endregion root
