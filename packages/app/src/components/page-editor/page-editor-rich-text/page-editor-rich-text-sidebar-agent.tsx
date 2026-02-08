import "./page-editor-rich-text-sidebar-agent.css";

import { useEffect, useRef } from "react";
import { Clock, Plus } from "lucide-react";

import { AiChatThread } from "@/components/ai-chat/ai-chat.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	MySearchSelectTrigger,
	type MySearchSelect_Props,
} from "@/components/my-search-select.tsx";
import { ai_chat_is_optimistic_thread, type AiChatController, useAiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { cn } from "@/lib/utils.ts";

// #region thread picker
type PageEditorRichTextSidebarAgentThreadPicker_ClassNames =
	| "PageEditorRichTextSidebarAgentThreadPicker"
	| "PageEditorRichTextSidebarAgentThreadPicker-item"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-title"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-empty";

type PageEditorRichTextSidebarAgentThreadPicker_Props = {
	controller: AiChatController;
};

function PageEditorRichTextSidebarAgentThreadPicker(props: PageEditorRichTextSidebarAgentThreadPicker_Props) {
	const { controller } = props;

	const threads = controller.currentThreadsWithOptimistic.unarchived.results;

	const handleSelectThread = (threadId: string) => {
		controller.selectThread(threadId);
	};

	const handleSelectValue: MySearchSelect_Props["setValue"] = (value) => {
		if (!value) {
			return;
		}

		handleSelectThread(value);
	};

	return (
		<div
			className={cn(
				"PageEditorRichTextSidebarAgentThreadPicker" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
			)}
		>
			<MySearchSelect value={controller.selectedThreadId ?? undefined} setValue={handleSelectValue}>
				<MySearchSelectTrigger>
					<MyIconButton variant="ghost-highlightable" tooltip="Chat history">
						<MyIcon>
							<Clock />
						</MyIcon>
					</MyIconButton>
				</MySearchSelectTrigger>
				<MySearchSelectPopover>
					<MySearchSelectPopoverScrollableArea>
						<MySearchSelectPopoverContent>
							<MySearchSelectSearch placeholder="Search chats..." />
							{threads.length === 0 ? (
								<div
									className={cn(
										"PageEditorRichTextSidebarAgentThreadPicker-item-empty" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
									)}
								>
									No chats found
								</div>
							) : (
								<MySearchSelectList>
									{threads.map((thread) => {
										const threadTitle = controller.streamingTitleByThreadId[thread._id] ?? (thread.title || "New Chat");
										const threadKey = ai_chat_is_optimistic_thread(thread)
											? (thread.clientGeneratedId ?? thread._id)
											: thread._id;

										return (
											<MySearchSelectItem
												key={threadKey}
												value={thread._id}
												className={cn(
													"PageEditorRichTextSidebarAgentThreadPicker-item" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
												)}
											>
												<span
													className={cn(
														"PageEditorRichTextSidebarAgentThreadPicker-item-title" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
													)}
												>
													{threadTitle}
												</span>
											</MySearchSelectItem>
										);
									})}
								</MySearchSelectList>
							)}
						</MySearchSelectPopoverContent>
					</MySearchSelectPopoverScrollableArea>
				</MySearchSelectPopover>
			</MySearchSelect>
		</div>
	);
}
// #endregion thread picker

// #region root
export type PageEditorRichTextSidebarAgent_ClassNames =
	| "PageEditorRichTextSidebarAgent"
	| "PageEditorRichTextSidebarAgent-header"
	| "PageEditorRichTextSidebarAgent-header-actions"
	| "PageEditorRichTextSidebarAgent-chat-area";

export function PageEditorRichTextSidebarAgent() {
	const controller = useAiChatController({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);

	const handleNewChat = () => {
		controller.startNewChat();
	};

	useEffect(() => {
		if (!hasAutoStartedRef.current && !controller.selectedThreadId) {
			hasAutoStartedRef.current = true;
			controller.startNewChat();
		}
	}, []);

	return (
		<div className={cn("PageEditorRichTextSidebarAgent" satisfies PageEditorRichTextSidebarAgent_ClassNames)}>
			<div className={cn("PageEditorRichTextSidebarAgent-header" satisfies PageEditorRichTextSidebarAgent_ClassNames)}>
				<div
					className={cn(
						"PageEditorRichTextSidebarAgent-header-actions" satisfies PageEditorRichTextSidebarAgent_ClassNames,
					)}
				>
					<PageEditorRichTextSidebarAgentThreadPicker controller={controller} />
					<MyIconButton variant="ghost-highlightable" tooltip="New chat" onClick={handleNewChat}>
						<MyIcon>
							<Plus />
						</MyIcon>
					</MyIconButton>
				</div>
			</div>
			<div
				className={cn("PageEditorRichTextSidebarAgent-chat-area" satisfies PageEditorRichTextSidebarAgent_ClassNames)}
			>
				<AiChatThread variant="sidebar" controller={controller} />
			</div>
		</div>
	);
}
// #endregion root
