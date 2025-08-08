import React from "react";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { app_fetch_ai_docs_liveblocks_auth } from "../lib/fetch.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../lib/ai-chat.ts";
import { DocsSidebar } from "../components/docs-sidebar-v2";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { PanelLeft } from "lucide-react";
import { cn } from "../lib/utils";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { useAuth } from "../lib/auth.ts";

export const Route = createFileRoute({
	component: Docs,
	validateSearch: zodValidator(
		z.object({
			docId: z.string().optional().catch(undefined),
		}),
	),
});

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

const TiptapEditor = React.lazy(() =>
	import("../components/ai-docs-temp/editor").then((module) => ({ default: module.RichTextDocEditor })),
);

function DocsContent() {
	const searchParams = Route.useSearch();

	const auth = useAuth();

	const roomId = searchParams.docId
		? ai_docs_create_liveblocks_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, searchParams.docId)
		: undefined;

	if (!roomId || !searchParams.docId) {
		return <div>No document selected</div>;
	}

	return (
		<LiveblocksProvider
			authEndpoint={async (room) => {
				const result = await app_fetch_ai_docs_liveblocks_auth({
					input: { room },
					auth: auth.isAuthenticated,
				});

				if (result.ok) {
					return result.ok.payload;
				} else {
					throw new Error(`Failed to authenticate: ${result.bad.message}`);
				}
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
			<RoomProvider id={roomId}>
				<ClientSideSuspense fallback={<LoadingEditor />}>
					<div className="h-full w-full">
						<TiptapEditor doc_id={searchParams.docId} />
					</div>
				</ClientSideSuspense>
			</RoomProvider>
		</LiveblocksProvider>
	);
}

function Docs() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();

	const [docsSidebarOpen, setDocsSidebarOpen] = useState(true);

	// Navigation function to update URL with selected document
	const navigateToDocument = (docId: string | null) => {
		navigate({
			to: "/docs",
			search: { docId },
		});
	};

	const handleAddChild = (parentId: string, newItemId: string) => {
		// When a new document is created, open it
		navigateToDocument(newItemId);
	};

	const handleArchive = (itemId: string) => {
		// When a document is archived, clear selection if it was the selected one
		if (searchParams.docId === itemId) {
			navigateToDocument(null);
		}
	};

	const handlePrimaryAction = (itemId: string, itemType: string) => {
		// Only navigate if it's not already selected
		if (searchParams.docId !== itemId) {
			navigateToDocument(itemId);
		}
	};

	const handleClose = () => {
		setDocsSidebarOpen(false);
	};

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
				<DocsSidebar
					selectedDocId={searchParams.docId}
					onClose={handleClose}
					onAddChild={handleAddChild}
					onArchive={handleArchive}
					onPrimaryAction={handlePrimaryAction}
				/>
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

function ai_docs_create_liveblocks_room_id(orgId: string, projectId: string, docId: string) {
	return `${orgId}:${projectId}:${docId}`;
}
