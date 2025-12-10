import "./page-editor.css";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";
import { ClientSideSuspense } from "@liveblocks/react";
import { useAuth } from "@/lib/auth.ts";
import { app_fetch_ai_docs_liveblocks_auth } from "@/lib/fetch.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { PageEditorRichText } from "./page-editor-rich-text/page-editor-rich-text.tsx";
import { PageEditorSkeleton } from "./page-editor-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref, useEffect, useEffectEvent, useRef } from "react";
import { Switch } from "../ui/switch.tsx";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor.tsx";
import { MonacoMarkdownDiffEditorAiEditsWrapper } from "./monaco-markdown-diff-editor-ai-edits-wrapper.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
import { MonacoMarkdownDiffEditor } from "./monaco-markdown-diff-editor.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import {
	pages_ROOT_ID,
	ai_docs_create_liveblocks_room_id,
	type pages_TreeItem,
	pages_PresenceStore,
} from "@/lib/pages.ts";
import { Home } from "lucide-react";
import { MyLink } from "../my-link.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import {
	usePresence,
	usePresenceSessions,
	usePresenceSessionsData,
	usePresenceUsersData,
} from "../../hooks/presence-hooks.ts";
import { useLiveRef } from "../../hooks/utils-hooks.ts";

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

// #region Header
type PageEditorHeader_ClassNames =
	| "PageEditorHeader"
	| "PageEditorHeader-breadcrumb"
	| "PageEditorHeader-breadcrumb-home"
	| "PageEditorHeader-breadcrumb-home-underline-hack"
	| "PageEditorHeader-breadcrumb-segment"
	| "PageEditorHeader-breadcrumb-segment-current"
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
			<ol className={cn("PageEditorHeader-breadcrumb" satisfies PageEditorHeader_ClassNames)}>
				{pageId && treeItemsList && breadcrumbPath.length > 0 ? (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<MyLink
									className={cn("PageEditorHeader-breadcrumb-home" satisfies PageEditorHeader_ClassNames)}
									to="/pages"
									variant="button-tertiary"
								>
									<li
										className={cn(
											"PageEditorHeader-breadcrumb-home-underline-hack" satisfies PageEditorHeader_ClassNames,
										)}
										inert
									>
										&nbsp;&nbsp;&nbsp;&nbsp;
									</li>
									<Home size={16} />
								</MyLink>
							</TooltipTrigger>
							<TooltipContent>
								<p>Home</p>
							</TooltipContent>
						</Tooltip>
						<span>/</span>
						{breadcrumbPath.map((item, index) => {
							const isCurrentPage = index === breadcrumbPath.length - 1;
							const breadcrumbItem = (
								<React.Fragment key={item.index}>
									{isCurrentPage ? (
										<li
											className={cn(
												"PageEditorHeader-breadcrumb-segment-current" satisfies PageEditorHeader_ClassNames,
											)}
										>
											{item.title}
										</li>
									) : (
										<li>
											<MyLink
												className={cn("PageEditorHeader-breadcrumb-segment" satisfies PageEditorHeader_ClassNames)}
												to="/pages"
												search={{ pageId: item.index }}
												variant="button-tertiary"
											>
												{item.title}
											</MyLink>
										</li>
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
					</>
				) : (
					<li className={cn("PageEditorHeader-breadcrumb-segment-current" satisfies PageEditorHeader_ClassNames)}>
						<Home size={16} />
						<span>Home</span>
					</li>
				)}
			</ol>

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
// #endregion Header

// #region Inner
type PageEditorInner_Props = {
	roomId: string;
	pageId: string;
	threadId?: string;
	editorMode: PageEditor_Mode;
	presenceStore: pages_PresenceStore;
	onEditorModeChange: PageEditorHeader_Props["onEditorModeChange"];
};

function PageEditorInner(props: PageEditorInner_Props) {
	const { roomId, pageId, editorMode, threadId, presenceStore, onEditorModeChange } = props;

	const auth = useAuth();

	const handleDiffExit = () => {
		onEditorModeChange("rich");
	};

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
			<RoomProvider
				// Setting the key is necessary to ensure the editor is properly re-created
				// including the liveblocks yjs extensions
				// to prevent showing content from the previous room.
				key={roomId}
				id={roomId}
			>
				<ClientSideSuspense fallback={<PageEditorSkeleton />}>
					<div className={cn("PageEditor" satisfies PageEditor_ClassNames)}>
						<div className={cn("PageEditor-editor-container" satisfies PageEditor_ClassNames)}>
							{editorMode === "rich" ? (
								<PageEditorRichText
									pageId={pageId}
									presenceStore={presenceStore}
									headerSlot={
										<PageEditorHeader pageId={pageId} editorMode={editorMode} onEditorModeChange={onEditorModeChange} />
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
// #endregion Inner

// #region PresenceSupplier

type PageEditorPresenceSupplier_Props = {
	userId: string | null | undefined;
	pageId: string;

	children: (props: {
		roomId: PageEditorInner_Props["roomId"];
		presenceStore: PageEditorInner_Props["presenceStore"];
	}) => React.ReactNode;
};

function PageEditorPresenceSupplier(props: PageEditorPresenceSupplier_Props) {
	const { userId, pageId, children } = props;

	const roomId = ai_docs_create_liveblocks_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, pageId);

	const presence = usePresence({
		roomId: roomId,
		userId: userId ?? "",
	});
	const presenceRef = useLiveRef(presence);

	const presenceSessions = usePresenceSessions({
		roomToken: presence.roomToken,
		userId: userId,
	});

	const presenceData = usePresenceUsersData({
		roomToken: presence.roomToken,
	});

	const presenceSessionsData = usePresenceSessionsData({
		roomToken: presence.roomToken,
	});

	const setSessionDataMutation = useMutation(app_convex_api.presence.setSessionData);
	const setSessionDataDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

	const [presenceStore, setPresenceStore] = useState<pages_PresenceStore | null>(null);
	const presenceStoreRef = useLiveRef<pages_PresenceStore | null>(presenceStore);

	useEffect(() => {
		// Reset on room changes so we don't keep rendering the old store while the new session connects.
		presenceStore?.dispose();
		setPresenceStore(null);
	}, [roomId]);

	useEffect(() => {
		if (
			presenceSessions &&
			presenceData &&
			presenceSessionsData &&
			presenceRef.current.sessionId &&
			presenceRef.current.roomToken &&
			presenceRef.current.sessionToken
		) {
			if (presenceStoreRef.current) {
				presenceStoreRef.current.sync({
					sessions: presenceSessions,
					sessionsData: presenceSessionsData,
					usersRoomData: presenceData,
				});
			} else {
				const presenceStore = new pages_PresenceStore({
					data: {
						sessions: presenceSessions,
						sessionsData: presenceSessionsData,
						usersRoomData: presenceData,
					},
					localSessionId: presenceRef.current.sessionId,
					onSetSessionData: (data) => {
						if (!presenceRef.current.sessionToken) {
							throw should_never_happen("Missing deps", {
								sessionToken: presenceRef.current.sessionToken,
							});
						}

						const localSessionToken = presenceRef.current.sessionToken;

						clearTimeout(setSessionDataDebounce.current);
						setSessionDataDebounce.current = setTimeout(() => {
							if (presenceRef.current.sessionToken !== localSessionToken) return;

							setSessionDataMutation({
								sessionToken: presenceRef.current.sessionToken,
								data,
							}).catch((error) => {
								console.error(error);
							});
						}, 100);
					},
				});
				setPresenceStore(presenceStore);
			}
		}
	}, [
		presenceSessions,
		presenceData,
		presenceSessionsData,
		presence.sessionId,
		presence.roomToken,
		presence.sessionToken,
		setSessionDataMutation,
	]);

	return presenceStore ? children({ roomId, presenceStore }) : <PageEditorSkeleton />;
}

// #endregion PresenceSupplier

// #region PageEditor
export type PageEditor_Mode = "rich" | "markdown" | "diff";

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

	return pageId ? (
		<PageEditorPresenceSupplier userId={auth.userId} pageId={pageId}>
			{({ roomId, presenceStore }) => (
				<PageEditorInner
					roomId={roomId}
					pageId={pageId}
					editorMode={editorMode}
					threadId={threadId}
					presenceStore={presenceStore}
					onEditorModeChange={setEditorMode}
				/>
			)}
		</PageEditorPresenceSupplier>
	) : (
		<div>No document selected</div>
	);
}
// #endregion PageEditor
