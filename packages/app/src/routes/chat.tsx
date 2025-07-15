import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Canvas } from "../components/canvas/canvas";
import { Thread } from "../components/assistant-ui/thread";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "../lib/utils";
import { CreateArtifactToolUI } from "@/components/create-artifact-tool-ui";
import { useBackendRuntime } from "@/lib/backend_runtime";
import { AiChatSidebar } from "@/components/app-sidebar";
import { MainAppSidebar } from "@/components/main-app-sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

export const Route = createFileRoute({
	component: Chat,
});

function ChatContent() {
	const [aiChatSidebarOpen, setAiChatSidebarOpen] = useState(true);

	return (
		<div className={cn("Chat", "flex h-screen w-full")}>
			<MainAppSidebar />
			<SidebarInset className="flex-1 flex overflow-hidden">
				<div className={cn("Chat-content-area", "flex h-full w-full")}>
					{/* AI Chat Sidebar - positioned as first column */}
					<div
						className={cn(
							"Chat-ai-sidebar-container",
							"transition-all duration-300 ease-in-out overflow-hidden",
							aiChatSidebarOpen ? "w-80 opacity-100" : "w-0 opacity-0",
						)}
					>
						{aiChatSidebarOpen && (
							<div className={cn("Chat-ai-sidebar-wrapper", "w-80 h-full")}>
								<AiChatSidebar onClose={() => setAiChatSidebarOpen(false)} />
							</div>
						)}
					</div>

					{/* Main Content Area - takes remaining space */}
					<div className={cn("Chat-main-content", "flex-1 flex flex-col h-full min-w-0")}>
						<PanelGroup direction="horizontal" className="h-full">
							{/* Thread Panel */}
							<Panel defaultSize={40} minSize={30} maxSize={60}>
								<div
									className={cn(
										"Chat-thread-panel",
										"h-full bg-gray-50 dark:bg-gray-900 relative overflow-hidden flex flex-col",
									)}
								>
									{!aiChatSidebarOpen && (
										<div className={cn("Chat-thread-panel-controls", "absolute top-4 left-4 z-10")}>
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
									<div className={cn("Chat-thread-content", "flex-1 flex min-h-0 overflow-hidden")}>
										<Thread />
									</div>
								</div>
							</Panel>

							<PanelResizeHandle />

							{/* Canvas Panel */}
							<Panel defaultSize={60}>
								<div className={cn("Chat-canvas-panel", "h-full relative overflow-hidden")}>
									<Canvas />
								</div>
							</Panel>
						</PanelGroup>
					</div>
				</div>
			</SidebarInset>
		</div>
	);
}

function Chat() {
	// Use the backend runtime with multi-thread support
	const runtime = useBackendRuntime();

	return (
		<SidebarProvider>
			<AssistantRuntimeProvider runtime={runtime}>
				<ChatContent />
				<CreateArtifactToolUI />
			</AssistantRuntimeProvider>
		</SidebarProvider>
	);
}
