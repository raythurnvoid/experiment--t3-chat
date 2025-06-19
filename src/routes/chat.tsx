import { AssistantRuntimeProvider, useThread } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { Canvas } from "../components/canvas/canvas";
import { Thread } from "../components/assistant-ui/thread";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "../lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import { CreateArtifactToolUI } from "@/components/CreateArtifactHook.tsx";

export const Route = createFileRoute({
	component: Chat,
});

function ChatContent() {
	const { getCurrentArtifact } = useCanvasStore();
	const [chatCollapsed, setChatCollapsed] = useState(false);

	// Derive chatStarted from whether there are any messages
	const chatStarted = useThread((thread) => thread.messages.length > 0);

	// Get current artifact to determine layout
	const currentArtifact = getCurrentArtifact();

	return (
		<div className={cn("Chat", "h-full")}>
			{/* Show simple layout when no chat started and no artifact */}
			{!chatStarted && !currentArtifact ? (
				<div className={cn("Chat-initial-layout", "h-full flex")}>
					{/* Chat Panel */}
					<div
						className={cn(
							"Chat-panel",
							"w-1/3 min-w-[300px] border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 h-full overflow-hidden flex flex-col"
						)}
					>
						<div className={cn("Chat-content", "flex-1 overflow-y-auto")}>
							<Thread />
						</div>
					</div>
					{/* Canvas Panel */}
					<div
						className={cn("Chat-canvas-panel", "flex-1 h-full overflow-hidden")}
					>
						<Canvas />
					</div>
				</div>
			) : (
				/* Resizable layout when chat started or artifact exists */
				<PanelGroup direction="horizontal" className="h-full">
					{/* Chat Panel */}
					{!chatCollapsed && (
						<Panel defaultSize={30} minSize={20} maxSize={50}>
							<div
								className={cn(
									"Chat-panel",
									"h-full bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 relative overflow-hidden flex flex-col"
								)}
							>
								<div
									className={cn(
										"Chat-panel-controls",
										"absolute top-4 right-4 z-10"
									)}
								>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setChatCollapsed(true)}
										className={cn("Chat-panel-collapse-button", "h-8 w-8 p-0")}
									>
										<PanelLeftClose className="h-4 w-4" />
									</Button>
								</div>
								<div className={cn("Chat-content", "flex-1 overflow-y-auto")}>
									<Thread />
								</div>
							</div>
						</Panel>
					)}
					{!chatCollapsed && <PanelResizeHandle />}
					{/* Canvas Panel */}
					<Panel defaultSize={chatCollapsed ? 100 : 70}>
						<div
							className={cn(
								"Chat-canvas-panel",
								"h-full relative overflow-hidden"
							)}
						>
							{chatCollapsed && (
								<div
									className={cn(
										"Chat-canvas-panel-controls",
										"absolute top-4 left-4 z-10"
									)}
								>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setChatCollapsed(false)}
										className={cn(
											"Chat-canvas-panel-expand-button",
											"h-8 w-8 p-0"
										)}
									>
										<PanelLeft className="h-4 w-4" />
									</Button>
								</div>
							)}

							<Canvas />
						</div>
					</Panel>
				</PanelGroup>
			)}
		</div>
	);
}

function Chat() {
	const runtime = useChatRuntime({
		api: "http://localhost:3001/api/chat",
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ChatContent />
			<CreateArtifactToolUI />
		</AssistantRuntimeProvider>
	);
}
