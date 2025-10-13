import "./page-editor.css";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { useAuth } from "../../lib/auth.ts";
import { app_fetch_ai_docs_liveblocks_auth } from "../../lib/fetch.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";
import { PageRichTextEditor } from "./editor.tsx";
import { PageEditorSkeleton } from "./page-editor-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref } from "react";
import { Switch } from "../ui/switch.tsx";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor.tsx";
import { MonacoMarkdownDiffEditorAiEditsWrapper } from "./monaco-markdown-diff-editor-ai-edits-wrapper.tsx";
import { cn } from "../../lib/utils.ts";
import { MonacoMarkdownDiffEditor } from "./monaco-markdown-diff-editor.tsx";
import { useQuery } from "convex/react";
import { app_convex_api } from "../../lib/app-convex-client.ts";
import { pages_ROOT_ID, type pages_TreeItem } from "../../lib/pages.ts";
import { Home } from "lucide-react";
import { MyLink } from "../my-link.tsx";

function ai_docs_create_liveblocks_room_id(orgId: string, projectId: string, docId: string) {
	return `${orgId}:${projectId}:${docId}`;
}

function get_breadcrumb_path(
	treeItemsList: pages_TreeItem[] | undefined,
	pageId: string | null | undefined,
): pages_TreeItem[] {
	if (!treeItemsList || !pageId) return [];

	// Create a map for quick lookup
	const itemsMap = new Map<string, pages_TreeItem>();
	for (const item of treeItemsList) {
		itemsMap.set(item.index, item);
	}

	const path: pages_TreeItem[] = [];
	let currentId: string | null = pageId;

	// Navigate up the tree using parentId
	while (currentId && currentId !== pages_ROOT_ID) {
		const item = itemsMap.get(currentId);
		if (!item) break;

		path.unshift(item); // Add to beginning of array
		currentId = item.parentId || null;
	}

	return path;
}

type PageEditorHeader_ClassNames =
	| "PageEditorHeader"
	| "PageEditorHeader-breadcrumb"
	| "PageEditorHeader-breadcrumb-home"
	| "PageEditorHeader-breadcrumb-separator"
	| "PageEditorHeader-diff-switch"
	| "PageEditorHeader-switch-container"
	| "PageEditorHeader-switch-group"
	| "PageEditorHeader-label-text"
	| "PageEditorHeader-switch-text";

type PageEditorHeader_Props = {
	pageId: string | null | undefined;
	editorMode: "rich" | "markdown" | "diff";
	onEditorModeChange: (mode: "rich" | "markdown" | "diff") => void;
};

function PageEditorHeader(props: PageEditorHeader_Props) {
	const { pageId, editorMode, onEditorModeChange } = props;

	// Query tree items to build breadcrumb path
	const treeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});

	// Build breadcrumb path from pageId up to root
	const breadcrumbPath = get_breadcrumb_path(treeItemsList, pageId);

	return (
		<div className={cn("PageEditorHeader" satisfies PageEditorHeader_ClassNames)}>
			{/* Left: Breadcrumb path */}
			{treeItemsList && breadcrumbPath.length > 0 && (
				<div className={cn("PageEditorHeader-breadcrumb" satisfies PageEditorHeader_ClassNames)}>
					<MyLink to="/pages" variant="button-tertiary">
						<Home className={cn("PageEditorHeader-breadcrumb-home" satisfies PageEditorHeader_ClassNames)} size={16} />
					</MyLink>
					<span>/</span>
					{breadcrumbPath.map((item, index) => {
						const isCurrentPage = index === breadcrumbPath.length - 1;
						const breadcrumbItem = (
							<React.Fragment key={item.index}>
								{isCurrentPage ? (
									<span>{item.title}</span>
								) : (
									<MyLink to="/pages" search={{ pageId: item.index }}>
										{item.title}
									</MyLink>
								)}
								{index < breadcrumbPath.length - 1 && (
									<span className={cn("PageEditorHeader-breadcrumb-separator" satisfies PageEditorHeader_ClassNames)}>
										/
									</span>
								)}
							</React.Fragment>
						);
						return breadcrumbItem;
					})}
				</div>
			)}

			{/* Right: Both switches in a container */}
			<div className={cn("PageEditorHeader-switch-group" satisfies PageEditorHeader_ClassNames)}>
				{/* Diff switch (only in markdown mode) */}
				<div
					className={cn(
						"PageEditorHeader-diff-switch" satisfies PageEditorHeader_ClassNames,
						editorMode === "rich" && "invisible",
					)}
				>
					<span className={cn("PageEditorHeader-label-text" satisfies PageEditorHeader_ClassNames)}>Diff</span>
					<Switch
						checked={(editorMode as "diff" | "markdown") === "diff"}
						onCheckedChange={(checked: boolean) => onEditorModeChange(checked ? "diff" : "markdown")}
					/>
				</div>
				{/* Rich/Markdown switch */}
				<div className={cn("PageEditorHeader-switch-container" satisfies PageEditorHeader_ClassNames)}>
					<span className={cn("PageEditorHeader-switch-text" satisfies PageEditorHeader_ClassNames)}>Rich</span>
					<Switch
						checked={editorMode !== "rich"}
						onCheckedChange={(checked: boolean) => onEditorModeChange(checked ? "markdown" : "rich")}
					/>
					<span className={cn("PageEditorHeader-switch-text" satisfies PageEditorHeader_ClassNames)}>Markdown</span>
				</div>
			</div>
		</div>
	);
}

export type PageEditor_ClassNames = "PageEditor" | "PageEditor-editor-container";

export type PageEditor_Ref = {
	requestOpenDiff: (args: { pageId: string; modifiedEditorValue: string }) => void;
	getMode: () => PageEditor_Mode;
};

export type PageEditor_Props = {
	ref?: Ref<PageEditor_Ref>;
	pageId: string | null | undefined;
	threadId?: string;
};

export function PageEditor(props: PageEditor_Props) {
	const { ref: refProp, pageId, threadId } = props;

	const auth = useAuth();
	const [editorMode, setEditorMode] = useState<PageEditor_Mode>("rich");

	const handleDiffExit = () => {
		setEditorMode("rich");
	};

	useImperativeHandle(
		refProp,
		() => ({
			requestOpenDiff: (_args: { pageId: string; modifiedEditorValue: string }) => {
				setEditorMode("diff");
			},
			getMode: () => editorMode,
		}),
		[editorMode],
	);

	if (!pageId) {
		return <div>No document selected</div>;
	}

	const roomId = ai_docs_create_liveblocks_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, pageId);

	return (
		<LiveblocksProvider
			authEndpoint={async (room) => {
				const result = await app_fetch_ai_docs_liveblocks_auth({
					input: { room },
					auth: auth.isAuthenticated,
				});

				if (result._nay) {
					throw new Error(`Failed to authenticate: ${result._nay.message}`);
				}

				return result._yay.payload;
			}}
		>
			<RoomProvider id={roomId}>
				<ClientSideSuspense fallback={<PageEditorSkeleton />}>
					<div className={cn("PageEditor" satisfies PageEditor_ClassNames)}>
						<div className={cn("PageEditor-editor-container" satisfies PageEditor_ClassNames)}>
							{editorMode === "rich" ? (
								<PageRichTextEditor
									pageId={pageId}
									headerSlot={
										<PageEditorHeader pageId={pageId} editorMode={editorMode} onEditorModeChange={setEditorMode} />
									}
								/>
							) : editorMode === "diff" ? (
								threadId ? (
									<MonacoMarkdownDiffEditorAiEditsWrapper pageId={pageId} threadId={threadId} onExit={handleDiffExit} />
								) : (
									<MonacoMarkdownDiffEditor pageId={pageId} onExit={handleDiffExit} />
								)
							) : (
								<MonacoMarkdownEditor pageId={pageId} />
							)}
						</div>
					</div>
				</ClientSideSuspense>
			</RoomProvider>
		</LiveblocksProvider>
	);
}

export type PageEditor_Mode = "rich" | "markdown" | "diff";
