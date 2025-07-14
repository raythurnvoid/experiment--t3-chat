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
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

export const Route = createFileRoute({
	component: Chat,
});

function ChatContent() {
	const [chatCollapsed, setChatCollapsed] = useState(false);

	return (
		<div className={cn("Chat", "h-full")}>
			<SidebarProvider>
				<AppSidebar />
				<SidebarInset>
					<PanelGroup direction="horizontal" className="h-full">
						{/* Chat Panel */}
						{!chatCollapsed && (
							<Panel defaultSize={30} minSize={20} maxSize={50}>
								<div
									className={cn(
										"Chat-panel",
										"h-full bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 relative overflow-hidden flex flex-col",
									)}
								>
									<div className={cn("Chat-panel-controls", "absolute top-4 right-4 z-10")}>
										<Button
											variant="outline"
											size="sm"
											onClick={() => setChatCollapsed(true)}
											className={cn("Chat-panel-collapse-button", "h-8 w-8 p-0")}
										>
											<PanelLeftClose className="h-4 w-4" />
										</Button>
									</div>
									<div className={cn("Chat-content", "flex-1 flex min-h-0 overflow-hidden")}>
										<Thread />
									</div>
								</div>
							</Panel>
						)}
						{!chatCollapsed && <PanelResizeHandle />}
						{/* Canvas Panel */}
						<Panel defaultSize={chatCollapsed ? 100 : 70}>
							<div className={cn("Chat-canvas-panel", "h-full relative overflow-hidden")}>
								{chatCollapsed && (
									<div className={cn("Chat-canvas-panel-controls", "absolute top-4 left-4 z-10")}>
										<Button
											variant="outline"
											size="sm"
											onClick={() => setChatCollapsed(false)}
											className={cn("Chat-canvas-panel-expand-button", "h-8 w-8 p-0")}
										>
											<PanelLeft className="h-4 w-4" />
										</Button>
									</div>
								)}

								<Canvas />
							</div>
						</Panel>
					</PanelGroup>
				</SidebarInset>
			</SidebarProvider>
		</div>
	);
}

function Chat() {
	// Use the backend runtime with multi-thread support
	const runtime = useBackendRuntime();

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ChatContent />
			<CreateArtifactToolUI />
		</AssistantRuntimeProvider>
	);
}
