import "./page-editor-rich-text-comments.css";
import {
	AnchoredThreads,
	type AnchoredThreadComponent_Props,
	AnchoredThreads_CssVars_DEFAULTS,
} from "@liveblocks/react-tiptap";
import { cn, compute_fallback_user_name, sx } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";
import type { human_thread_messages_Thread } from "../../../lib/page-editor-human-thread-bridge.ts";
import { useState, type ComponentProps } from "react";
import { useQuery, useMutation } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { MyInput, MyInputBox, MyInputArea, MyInputControl } from "@/components/my-input.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { ArrowUp } from "lucide-react";
import { tiptap_text_to_markdown } from "@/lib/tiptap-markdown.ts";
import { Response } from "@/components/ai-elements/response.tsx";
import { toast } from "sonner";
import { MySkeleton } from "@/components/ui/my-skeleton.tsx";
import { format_relative_time } from "@/lib/date.ts";
import {
	MyAvatar,
	MyAvatarImage,
	MyAvatarFallback,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";

// #region Thread
export type PageEditorRichTextAnchoredCommentsThread_ClassNames =
	| "PageEditorRichTextThread"
	| "PageEditorRichTextThread-active"
	| "PageEditorRichTextThread-messages"
	| "PageEditorRichTextThread-message"
	| "PageEditorRichTextThread-message-avatar"
	| "PageEditorRichTextThread-message-header"
	| "PageEditorRichTextThread-message-content"
	| "PageEditorRichTextThread-no-messages-placeholder"
	| "PageEditorRichTextThread-form"
	| "PageEditorRichTextThread-input"
	| "PageEditorRichTextThread-skeleton"
	| "PageEditorRichTextThread-skeleton-avatar"
	| "PageEditorRichTextThread-skeleton-header"
	| "PageEditorRichTextThread-skeleton-content";

export type PageEditorRichTextAnchoredCommentsThread_Props = AnchoredThreadComponent_Props & { editor: Editor };

function PageEditorRichTextAnchoredCommentsThread(props: AnchoredThreadComponent_Props & { editor: Editor }) {
	const { thread, isActive, onClick, className, style } = props;

	const messagesQuery = useQuery(
		app_convex_api.human_thread_messages.human_thread_messages_list,
		isActive
			? {
					threadId: thread.id,
					limit: 100,
				}
			: "skip",
	);

	const addMessage = useMutation(app_convex_api.human_thread_messages.human_thread_messages_add);

	const [text, setText] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleChange: ComponentProps<"input">["onChange"] = (e) => {
		setText(e.target.value);
	};

	const handleSubmit: ComponentProps<"form">["onSubmit"] = async (e) => {
		e?.preventDefault();

		if (!text.trim()) {
			toast.error("Write a comment before submitting.");
			return;
		}

		if (!thread.id) {
			toast.error("Thread ID is missing.");
			return;
		}

		setIsSubmitting(true);

		try {
			// Convert text to markdown
			const markdownContent = tiptap_text_to_markdown(text.trim());

			// Add new message to thread
			await addMessage({
				rootId: thread.id,
				content: markdownContent,
			});

			setText("");
		} catch (e) {
			const error = e as Error;
			console.error(error);
			toast.error(error?.message ?? "Failed to add comment");
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleClick: ComponentProps<"div">["onClick"] = (e) => {
		onClick?.(e);
	};

	return (
		<div
			className={cn(
				"PageEditorRichTextThread" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
				isActive && ("PageEditorRichTextThread-active" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames),
				className,
			)}
			style={style}
			onClick={handleClick}
		>
			<div
				className={cn(
					"PageEditorRichTextThread-messages" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
				)}
			>
				{
					// When not active, show the thread's content from props
					!isActive ? (
						<div
							className={cn(
								"PageEditorRichTextThread-message" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
							)}
						>
							<div
								className={cn(
									"PageEditorRichTextThread-message-avatar" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								<MyAvatar>
									<MyAvatarImage />
									<MyAvatarFallback>{compute_fallback_user_name(thread.created_by ?? "AN")}</MyAvatarFallback>
									<MyAvatarLoading>
										<MyAvatarSkeleton />
									</MyAvatarLoading>
								</MyAvatar>
							</div>
							<div
								className={cn(
									"PageEditorRichTextThread-message-header" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								<b>{thread.created_by}</b> <small>{format_relative_time(thread.created_at)}</small>
							</div>
							<Response
								className={cn(
									"PageEditorRichTextThread-message-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								{thread.content}
							</Response>
						</div>
					) : // When active but query is still loading, show skeleton + thread content
					messagesQuery === undefined ? (
						<>
							<div
								className={cn(
									"PageEditorRichTextThread-message" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								<div
									className={cn(
										"PageEditorRichTextThread-message-avatar" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								>
									<MyAvatar>
										<MyAvatarImage />
										<MyAvatarFallback>{(thread.created_by ?? "AN").slice(0, 2).toUpperCase()}</MyAvatarFallback>
									</MyAvatar>
								</div>
								<div
									className={cn(
										"PageEditorRichTextThread-message-header" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								>
									<b>{thread.created_by}</b> <small>{format_relative_time(thread.created_at)}</small>
								</div>
								<Response
									className={cn(
										"PageEditorRichTextThread-message-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								>
									{thread.content}
								</Response>
							</div>
							<div
								className={cn(
									"PageEditorRichTextThread-skeleton" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								<MySkeleton
									className={cn(
										"PageEditorRichTextThread-skeleton-avatar" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								/>
								<MySkeleton
									className={cn(
										"PageEditorRichTextThread-skeleton-header" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								/>
								<MySkeleton
									className={cn(
										"PageEditorRichTextThread-skeleton-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								/>
							</div>
						</>
					) : (
						<>
							{
								// When active and messages loaded, show all messages
								messagesQuery.messages.map((message) => (
									<div
										key={message._id}
										className={cn(
											"PageEditorRichTextThread-message" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
										)}
									>
										<div
											className={cn(
												"PageEditorRichTextThread-message-avatar" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
											)}
										>
											<MyAvatar>
												<MyAvatarImage />
												<MyAvatarFallback>{(message.created_by ?? "AN").slice(0, 2).toUpperCase()}</MyAvatarFallback>
											</MyAvatar>
										</div>
										<div
											className={cn(
												"PageEditorRichTextThread-message-header" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
											)}
										>
											<b>{message.created_by}</b> <small>{format_relative_time(message._creationTime)}</small>
										</div>
										<Response
											className={cn(
												"PageEditorRichTextThread-message-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
											)}
										>
											{message.content}
										</Response>
									</div>
								))
							}
							{messagesQuery.messages.length === 1 && (
								<small
									className={
										"PageEditorRichTextThread-no-messages-placeholder" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames
									}
								>
									<i>No messages yet</i>
								</small>
							)}
						</>
					)
				}
			</div>

			{isActive && (
				<form
					className={cn("PageEditorRichTextThread-form" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames)}
					onSubmit={handleSubmit}
				>
					<MyInput
						className={cn(
							"PageEditorRichTextThread-input" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
						)}
					>
						<MyInputBox />
						<MyInputArea>
							<MyInputControl
								type="text"
								placeholder="Add a comment..."
								autoFocus
								value={text}
								onChange={handleChange}
								disabled={isSubmitting}
							/>
						</MyInputArea>
						<MyIconButton type="submit" variant="default" disabled={!text.trim() || isSubmitting}>
							<MyIconButtonIcon>
								<ArrowUp />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyInput>
				</form>
			)}
		</div>
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
		<AnchoredThreads
			className={cn("PageEditorRichTextAnchoredComments" satisfies PageEditorRichTextAnchoredComments_ClassNames)}
			editor={editor}
			threads={threads}
			components={{ Thread: (props) => <PageEditorRichTextAnchoredCommentsThread {...props} editor={editor} /> }}
			style={sx({
				...AnchoredThreads_CssVars_DEFAULTS,
				"--lb-tiptap-anchored-threads-active-thread-offset": "0px",
			})}
		/>
	);
}
// #endregion PageEditorRichTextAnchoredComments
