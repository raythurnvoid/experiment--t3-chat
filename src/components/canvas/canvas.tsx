import { useCanvasStore } from "../../stores/canvas-store";
import { ArtifactRenderer } from "./artifact-renderer";
import { QuickStart } from "./quick-start";
import { Thread } from "../assistant-ui/thread";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../ui/button";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { cn } from "../../lib/utils";

export function Canvas() {
	const { chatStarted, artifact } = useCanvasStore();
	const [chatCollapsed, setChatCollapsed] = useState(false);

	// Show quick start if no chat has started and no artifact exists
	if (!chatStarted && !artifact) {
		return (
			<div className={cn("Canvas", "h-full flex")}>
				{/* Chat Panel */}
				<div
					className={cn(
						"Canvas-chat-panel",
						"w-1/3 min-w-[300px] border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 h-full overflow-hidden flex flex-col"
					)}
				>
					<div className={cn("Canvas-chat-content", "flex-1 overflow-y-auto")}>
						<Thread />
					</div>
				</div>

				{/* Canvas Panel */}
				<div className={cn("Canvas-content-panel", "flex-1 h-full overflow-hidden")}>
					<QuickStart />
				</div>
			</div>
		);
	}

	return (
		<div className={cn("Canvas", "h-full")}>
			<PanelGroup direction="horizontal" className="h-full">
				{/* Chat Panel */}
				{!chatCollapsed && (
					<Panel defaultSize={30} minSize={20} maxSize={50}>
						<div
							className={cn(
								"Canvas-chat-panel",
								"h-full bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 relative overflow-hidden flex flex-col"
							)}
						>
							<div className={cn("Canvas-chat-panel-controls", "absolute top-4 right-4 z-10")}>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setChatCollapsed(true)}
									className={cn("Canvas-chat-panel-collapse-button", "h-8 w-8 p-0")}
								>
									<PanelLeftClose className="h-4 w-4" />
								</Button>
							</div>
							<div className={cn("Canvas-chat-content", "flex-1 overflow-y-auto")}>
								<Thread />
							</div>
						</div>
					</Panel>
				)}

				{!chatCollapsed && <PanelResizeHandle />}

				{/* Canvas Panel */}
				<Panel defaultSize={chatCollapsed ? 100 : 70}>
					<div className={cn("Canvas-content-panel", "h-full relative overflow-hidden")}>
						{chatCollapsed && (
							<div className={cn("Canvas-content-panel-controls", "absolute top-4 left-4 z-10")}>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setChatCollapsed(false)}
									className={cn("Canvas-content-panel-expand-button", "h-8 w-8 p-0")}
								>
									<PanelLeft className="h-4 w-4" />
								</Button>
							</div>
						)}

						{artifact ? <ArtifactRenderer /> : <QuickStart />}
					</div>
				</Panel>
			</PanelGroup>
		</div>
	);
}
