import "./chat-v2.css";
import { AssistantRuntimeProvider, useAssistantState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { PanelLeft, Menu } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { useBackendRuntime } from "@/lib/backend-runtime.tsx";
import { AiChatThreads } from "@/components/ai-chat/ai-chat-threads.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { AppAiChat } from "../components/app-ai-chat.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";

type ChatV2_ClassNames =
	| "ChatV2"
	| "ChatV2-ai-sidebar"
	| "ChatV2-ai-sidebar-state-open"
	| "ChatV2-ai-sidebar-state-closed"
	| "ChatV2-main"
	| "ChatV2-thread-panel"
	| "ChatV2-thread-controls"
	| "ChatV2-thread-control-button"
	| "ChatV2-thread-control-icon"
	| "ChatV2-thread-content";

export const Route = createFileRoute({
	component: Chat,
});

function ChatContent() {
	const [aiChatSidebarOpen, setAiChatSidebarOpen] = useState(true);
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const mainThreadId = useAssistantState(({ threads }) => threads.mainThreadId);
	const threadItems = useAssistantState(({ threads }) => threads.threadItems);

	useEffect(() => {
		const mainItem = threadItems.find((item) => item.id === mainThreadId);
		window.rt0_chat_current_thread_id = mainItem?.remoteId;
	}, [mainThreadId, threadItems]);

	return (
		<div className={cn("ChatV2" satisfies ChatV2_ClassNames)}>
			{/* AI Chat Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"ChatV2-ai-sidebar" satisfies ChatV2_ClassNames,
					aiChatSidebarOpen
						? ("ChatV2-ai-sidebar-state-open" satisfies ChatV2_ClassNames)
						: ("ChatV2-ai-sidebar-state-closed" satisfies ChatV2_ClassNames),
				)}
			>
				<AiChatThreads onClose={() => setAiChatSidebarOpen(false)} />
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("ChatV2-main" satisfies ChatV2_ClassNames)}>
				<div className={cn("ChatV2-thread-panel" satisfies ChatV2_ClassNames)}>
					{!aiChatSidebarOpen && (
						<div className={cn("ChatV2-thread-controls" satisfies ChatV2_ClassNames)}>
							<MyIconButton
								variant="outline"
								tooltip="Open app sidebar"
								onClick={toggleSidebar}
								className={cn("ChatV2-thread-control-button" satisfies ChatV2_ClassNames)}
							>
								<Menu className={cn("ChatV2-thread-control-icon" satisfies ChatV2_ClassNames)} />
							</MyIconButton>

							<MyIconButton
								variant="outline"
								tooltip="Open chat threads"
								onClick={() => setAiChatSidebarOpen(true)}
								className={cn("ChatV2-thread-control-button" satisfies ChatV2_ClassNames)}
							>
								<PanelLeft className={cn("ChatV2-thread-control-icon" satisfies ChatV2_ClassNames)} />
							</MyIconButton>
						</div>
					)}
					<div className={cn("ChatV2-thread-content" satisfies ChatV2_ClassNames)}>
						<AppAiChat />
					</div>
				</div>
			</div>
		</div>
	);
}

function Chat() {
	// Use the backend runtime with multi-thread support
	const runtime = useBackendRuntime();

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ChatContent />
		</AssistantRuntimeProvider>
	);
}
