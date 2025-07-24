import React, { Suspense } from "react";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../lib/ai-chat.ts";
import { auth_get_token } from "../lib/auth.ts";
import { DocsSidebar } from "../components/docs-sidebar";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PanelLeft } from "lucide-react";
import { cn } from "../lib/utils";
import { SidebarProvider } from "../components/ui/sidebar.tsx";

export const Route = createFileRoute({
	component: Docs,
});

// Get Convex HTTP URL for HTTP endpoints
const CONVEX_HTTP_URL = import.meta.env.VITE_CONVEX_HTTP_URL;

if (!CONVEX_HTTP_URL) {
	throw new Error("`VITE_CONVEX_HTTP_URL` env var is not set");
}

// Loading fallback component
function LoadingEditor() {
	return (
		<div className="relative flex h-full flex-col bg-background">
			<div className="flex h-[60px] items-center justify-end border-b border-border/80 bg-background px-4">
				<div className="text-sm font-medium text-foreground">Loading AI Document Editor...</div>
			</div>
			<div className="border-b border-border/80 bg-background">
				<div className="h-12 animate-pulse bg-muted/50"></div>
			</div>
			<div className="flex-1 p-8">
				<div className="mx-auto max-w-4xl animate-pulse rounded-lg bg-muted/30 p-8">
					<div className="mb-4 h-8 w-3/4 rounded bg-muted/50"></div>
					<div className="mb-2 h-4 rounded bg-muted/50"></div>
					<div className="mb-2 h-4 w-5/6 rounded bg-muted/50"></div>
					<div className="h-4 w-4/5 rounded bg-muted/50"></div>
				</div>
			</div>
		</div>
	);
}

// Dynamic import for the Tiptap editor with error boundary
const TiptapEditor = React.lazy(() =>
	import("../components/ai-docs-temp/editor").catch((e) => {
		console.error("Error loading TiptapEditor:", e);

		return {
			default: () => (
				<div className="flex h-full items-center justify-center">
					<div className="text-center">
						<h3 className="mb-2 text-lg font-medium text-foreground">Editor Loading Error</h3>
						<p className="text-sm text-muted-foreground">Please refresh the page to try again.</p>
					</div>
				</div>
			),
		};
	}),
);

function DocsContent() {
	// Create room ID following the naming pattern: <workspace_id>:<project_id>:<document_id>
	const room_id = `${ai_chat_HARDCODED_ORG_ID}:${ai_chat_HARDCODED_PROJECT_ID}:docs-editor`;

	return (
		<LiveblocksProvider
			authEndpoint={async (room) => {
				// Get the JWT token from the auth system (same pattern as chat)
				const token = await auth_get_token();

				// Make the request to Convex HTTP action with Authorization header
				const response = await fetch(`${CONVEX_HTTP_URL}/api/ai-docs-temp/liveblocks-auth`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						// Pass the JWT token in Authorization header for Convex HTTP actions
						...(token && { Authorization: `Bearer ${token}` }),
					},
					body: JSON.stringify({ room }),
				});

				if (!response.ok) {
					throw new Error(`Failed to authenticate: ${response.status}`);
				}

				return await response.json();
			}}
			resolveUsers={async ({ userIds }: { userIds: string[] }) => {
				// Mock user resolution for development
				return userIds.map((id: string) => ({
					id,
					name: "Development User",
					avatar: "https://via.placeholder.com/32",
				}));
			}}
		>
			<RoomProvider id={room_id}>
				<ClientSideSuspense fallback={<LoadingEditor />}>
					<div className="h-full w-full">
						<Suspense fallback={<LoadingEditor />}>
							<TiptapEditor />
						</Suspense>
					</div>
				</ClientSideSuspense>
			</RoomProvider>
		</LiveblocksProvider>
	);
}

function Docs() {
	const [docsSidebarOpen, setDocsSidebarOpen] = useState(true);

	return (
		<div className={cn("Docs-content-area", "flex h-full w-full")}>
			{/* Docs Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"Docs-sidebar-wrapper",
					"h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
					docsSidebarOpen ? "w-80 opacity-100" : "w-0 opacity-0",
				)}
			>
				{docsSidebarOpen && <DocsSidebar onClose={() => setDocsSidebarOpen(false)} />}
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("Docs-main-content", "flex h-full min-w-0 flex-1 flex-col")}>
				<PanelGroup direction="horizontal" className="h-full">
					{/* Docs Editor Panel */}
					<Panel defaultSize={100} minSize={50}>
						<div className={cn("Docs-editor-panel", "relative flex h-full flex-col overflow-hidden bg-background")}>
							{!docsSidebarOpen && (
								<div className={cn("Docs-editor-panel-controls", "absolute top-4 left-4 z-10")}>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setDocsSidebarOpen(true)}
										className={cn("Docs-editor-panel-expand-button", "h-8 w-8 p-0")}
									>
										<PanelLeft className="h-4 w-4" />
									</Button>
								</div>
							)}
							<div className={cn("Docs-editor-content", "flex min-h-0 flex-1 overflow-hidden")}>
								<DocsContent />
							</div>
						</div>
					</Panel>
				</PanelGroup>
			</div>
		</div>
	);
}
