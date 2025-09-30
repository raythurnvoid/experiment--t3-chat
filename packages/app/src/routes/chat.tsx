import { AssistantRuntimeProvider, useThreadListItem } from "@assistant-ui/react";
import { Canvas } from "../components/canvas/canvas.tsx";
import { AppAiChat } from "../components/app-ai-chat.tsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { PanelLeft, Menu } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { useBackendRuntime } from "@/lib/backend-runtime.tsx";
import { AiChatSidebar } from "@/components/ai-chat-sidebar.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";

export const Route = createFileRoute({
	component: Chat,
});

function ChatContent() {
	const [aiChatSidebarOpen, setAiChatSidebarOpen] = useState(true);
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	useThreadListItem((list_item) => {
		window.rt0_chat_current_thread_id = list_item.remoteId;
	});

	return (
		<div className={cn("Chat-content-area", "flex h-full w-full")}>
			{/* AI Chat Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"Chat-ai-sidebar-wrapper",
					"h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
					aiChatSidebarOpen ? "w-80 opacity-100" : "w-0 opacity-0",
				)}
			>
				<AiChatSidebar onClose={() => setAiChatSidebarOpen(false)} />
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("Chat-main-content", "flex h-full min-w-0 flex-1 flex-col")}>
				<PanelGroup direction="horizontal" className="h-full">
					{/* Thread Panel */}
					<Panel defaultSize={40} minSize={30} maxSize={60}>
						<div
							className={cn(
								"Chat-thread-panel",
								"relative flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900",
							)}
						>
							{!aiChatSidebarOpen && (
								<div className={cn("Chat-thread-panel-controls", "absolute top-4 left-4 z-10 flex items-center gap-2")}>
									{/* Hamburger Menu - mobile only */}
									<Button
										variant="outline"
										size="sm"
										onClick={toggleSidebar}
										className={cn("Chat-thread-panel-hamburger-button", "h-8 w-8 p-0 lg:hidden")}
									>
										<Menu className="h-4 w-4" />
									</Button>

									{/* Open AI Chat Sidebar button */}
									<Button
										variant="outline"
										size="sm"
										onClick={() => setAiChatSidebarOpen(true)}
										className={cn("Chat-thread-panel-expand-button", "h-8 w-8 p-0")}
									>
										<PanelLeft className="h-4 w-4" />
									</Button>
								</div>
							)}
							<div className={cn("Chat-thread-content", "flex min-h-0 flex-1 overflow-hidden")}>
								<AppAiChat />
							</div>
						</div>
					</Panel>

					<PanelResizeHandle />

					{/* Canvas Panel */}
					<Panel defaultSize={60}>
						<div className={cn("Chat-canvas-panel", "relative h-full overflow-hidden")}>
							<Canvas />
						</div>
					</Panel>
				</PanelGroup>
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
