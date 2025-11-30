import "./page-editor-rich-text-comments.css";
import {
	AnchoredThreads,
	type AnchoredThreadComponent_Props,
	AnchoredThreads_CssVars_DEFAULTS,
} from "@liveblocks/react-tiptap";
import { cn, sx } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";
import type { human_thread_messages_Thread } from "../../../lib/page-editor-human-thread-bridge.ts";
import type { ComponentPropsWithoutRef } from "react";
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

// #region Thread
export type PageEditorRichTextAnchoredCommentsThread_ClassNames =
	| "PageEditorRichTextThread"
	| "PageEditorRichTextThread-active"
	| "PageEditorRichTextThread-messages"
	| "PageEditorRichTextThread-empty"
	| "PageEditorRichTextThread-message"
	| "PageEditorRichTextThread-message-content"
	| "PageEditorRichTextThread-form"
	| "PageEditorRichTextThread-input"
	| "PageEditorRichTextThread-skeleton";

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

	const handleClick: ComponentPropsWithoutRef<"div">["onClick"] = (e) => {
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
								<MySkeleton className="h-16 w-full" />
							</div>
						</>
					) : (
						// When active and messages loaded, show all messages
						messagesQuery.messages.map((message) => (
							<div
								key={message._id}
								className={cn(
									"PageEditorRichTextThread-message" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
								)}
							>
								<Response
									className={cn(
										"PageEditorRichTextThread-message-content" satisfies PageEditorRichTextAnchoredCommentsThread_ClassNames,
									)}
								>
									{message.content}
								</Response>
							</div>
						))
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
