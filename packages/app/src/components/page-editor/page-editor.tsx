import "./page-editor.css";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { PageEditorRichText } from "./page-editor-rich-text/page-editor-rich-text.tsx";
import { PageEditorSkeleton } from "./page-editor-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref, useEffect, useRef, useEffectEvent } from "react";
import { Switch } from "../ui/switch.tsx";
import { PageEditorPlainText } from "./page-editor-plain-text/page-editor-plain-text.tsx";
import { MonacoMarkdownDiffEditorAiEditsWrapper } from "./monaco-markdown-diff-editor-ai-edits-wrapper.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
import { PageEditorDiff } from "./page-editor-diff/page-editor-diff.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { pages_ROOT_ID, pages_create_room_id, type pages_TreeItem, pages_PresenceStore } from "@/lib/pages.ts";
import { Home } from "lucide-react";
import { MyLink } from "../my-link.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PageEditorPresence } from "./page-editor-presence.tsx";
import {
	usePresence,
	usePresenceList,
	usePresenceSessions,
	usePresenceSessionsData,
} from "../../hooks/presence-hooks.ts";
import { CatchBoundary } from "@tanstack/react-router";
import { PageEditorError } from "./page-editor-error.tsx";

function get_breadcrumb_path(
	treeItemsList: pages_TreeItem[] | undefined,
	pageId: app_convex_Id<"pages"> | null | undefined,
): pages_TreeItem[] {
	if (!treeItemsList || !pageId) return [];

	const path: pages_TreeItem[] = [];
	let currentId: string = pages_ROOT_ID;

	// Create a map for quick lookup
	const itemsMap = new Map<string, pages_TreeItem>();
	for (const item of treeItemsList) {
		itemsMap.set(item.index, item);
		if (item._id === pageId) {
			currentId = item.index;
		}
	}

	// Navigate up the tree using parentId
	while (currentId && currentId !== pages_ROOT_ID) {
		const item = itemsMap.get(currentId);
		if (!item) break;

		path.unshift(item); // Add to beginning of array
		currentId = item.parentId;
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
	pageId: app_convex_Id<"pages"> | null | undefined;
	editorMode: "rich" | "markdown" | "diff";
	onEditorModeChange: (mode: "rich" | "markdown" | "diff") => void;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
};

function PageEditorHeader(props: PageEditorHeader_Props) {
	const { pageId, editorMode, onEditorModeChange, onlineUsers } = props;

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

			{/* Right: Presence indicator and switches */}
			<div className={cn("PageEditorHeader-switch-group" satisfies PageEditorHeader_ClassNames)}>
				<PageEditorPresence users={onlineUsers} />
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

// #region PresenceSupplier

type PageEditorPresenceSupplier_Props = {
	userId: string | null | undefined;
	pageId: app_convex_Id<"pages">;

	children: (props: {
		presenceStore: PageEditor_Inner_Props["presenceStore"];
		onlineUsers: Array<{
			userId: string;
			isSelf: boolean;
			anagraphic: { displayName: string; avatarUrl?: string };
			color: string;
		}>;
	}) => React.ReactNode;
};

function PageEditorPresenceSupplier(props: PageEditorPresenceSupplier_Props) {
	const { userId, pageId, children } = props;

	const roomId = pages_create_room_id(ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, pageId);

	const presence = usePresence({
		roomId: roomId,
		userId: userId ?? "",
	});

	const presenceSessions = usePresenceSessions({
		roomToken: presence.roomToken,
		userId: userId,
	});

	const presenceSessionsData = usePresenceSessionsData({
		roomToken: presence.roomToken,
	});

	const presenceList = usePresenceList({
		roomToken: presence.roomToken,
		userId: userId,
	});

	const setSessionDataMutation = useMutation(app_convex_api.presence.setSessionData);
	const setSessionDataDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

	const [presenceStore, setPresenceStore] = useState<pages_PresenceStore | null>(null);

	// Compute onlineUsers from presenceList (user-level, online only, self first)
	// Map userId -> color via presenceSessions and presenceSessionsData
	const userIdToColorMap = new Map<string, string>();
	if (presenceSessions && presenceSessionsData) {
		for (const session of presenceSessions) {
			const sessionColor = presenceSessionsData[session.sessionId]?.color;
			if (sessionColor && !userIdToColorMap.has(session.userId)) {
				userIdToColorMap.set(session.userId, sessionColor);
			}
		}
	}

	const onlineUsers =
		presenceList?.users
			.filter((user) => user.online)
			.map((user) => {
				return {
					userId: user.userId,
					isSelf: user.userId === userId,
					anagraphic: user.anagraphic,
					color: userIdToColorMap.get(user.userId) ?? "var(--color-base-1-10)", // fallback to CSS var
				};
			}) ?? [];

	/**
	 * Must be a effect event in order to access the current value of `presence`
	 */
	const handlePresenceStoreSetSessionDataDebounced = useEffectEvent((localSessionToken: string) => {
		setSessionDataDebounce.current = undefined;

		// Prevent to send updates when navigating to a different page
		if (presence.sessionToken !== localSessionToken) return;

		const data = presenceStore?.sessionsData.get(presence.sessionId);
		if (!data) {
			// This means the session got disconnected before the debounced logic ran.
			// It can happen while switching tabs.
			return;
		}

		setSessionDataMutation({
			sessionToken: presence.sessionToken,
			data,
		}).catch((error) => {
			console.error(error);
		});
	});

	/**
	 * Must be a effect event in order to access the current value of `presence`
	 */
	const handlePresenceStoreSetSessionData = useEffectEvent(() => {
		if (!presence.sessionToken) {
			throw should_never_happen("Missing deps", {
				sessionToken: presence.sessionToken,
			});
		}

		const localSessionToken = presence.sessionToken;

		if (!setSessionDataDebounce.current) {
			setSessionDataDebounce.current = setTimeout(() => {
				handlePresenceStoreSetSessionDataDebounced(localSessionToken);
			}, 550);
		}
	});

	useEffect(() => {
		if (setSessionDataDebounce.current) {
			clearTimeout(setSessionDataDebounce.current);
			setSessionDataDebounce.current = undefined;
		}

		// Reset on room changes so we don't keep rendering the old store while the new session connects.
		presenceStore?.dispose();
		setPresenceStore(null);
	}, [roomId]);

	useEffect(() => {
		if (
			presenceSessions &&
			presenceList &&
			presenceSessionsData &&
			presence.sessionId &&
			presence.roomToken &&
			presence.sessionToken
		) {
			if (presenceStore) {
				presenceStore.sync({
					sessionToken: presence.sessionToken,
					sessions: presenceSessions,
					sessionsData: presenceSessionsData,
					usersAnagraphics: presenceList.usersAnagraphics,
				});
			} else {
				if (Object.values(presenceSessions).length === 0) {
					return;
				}

				const presenceStore = new pages_PresenceStore({
					data: {
						sessionToken: presence.sessionToken,
						sessions: presenceSessions,
						sessionsData: presenceSessionsData,
						usersAnagraphics: presenceList.usersAnagraphics,
					},
					localSessionId: presence.sessionId,
					onSetSessionData: () => {
						handlePresenceStoreSetSessionData();
					},
				});
				setPresenceStore(presenceStore);
			}
		}
	}, [
		presenceSessions,
		presenceList,
		presenceSessionsData,
		presence.sessionId,
		presence.roomToken,
		presence.sessionToken,
		setSessionDataMutation,
	]);

	return presenceStore ? children({ presenceStore, onlineUsers }) : <PageEditorSkeleton />;
}

// #endregion PresenceSupplier

// #region PageEditor
export type PageEditor_Mode = "rich" | "markdown" | "diff";

export type PageEditor_ClassNames = "PageEditor" | "PageEditor-editor-container";

type PageEditor_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	threadId?: string;
	editorMode: PageEditor_Mode;
	presenceStore: pages_PresenceStore;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
	onEditorModeChange: PageEditorHeader_Props["onEditorModeChange"];
	diffModifiedInitialValue?: string;
};

function PageEditor_Inner(props: PageEditor_Inner_Props) {
	const { pageId, editorMode, threadId, presenceStore, onlineUsers, onEditorModeChange, diffModifiedInitialValue } =
		props;

	const handleDiffExit = () => {
		onEditorModeChange("rich");
	};

	const headerSlot = (
		<PageEditorHeader
			pageId={pageId}
			editorMode={editorMode}
			onEditorModeChange={onEditorModeChange}
			onlineUsers={onlineUsers}
		/>
	);

	return (
		<div className={cn("PageEditor" satisfies PageEditor_ClassNames)}>
			<div className={cn("PageEditor-editor-container" satisfies PageEditor_ClassNames)}>
				<CatchBoundary
					getResetKey={() => 0}
					errorComponent={PageEditorError}
					onCatch={(err) => {
						console.error("[PageEditor_Inner]", err);
					}}
				>
					{editorMode === "rich" ? (
						<PageEditorRichText pageId={pageId} presenceStore={presenceStore} headerSlot={headerSlot} />
					) : editorMode === "diff" ? (
						threadId ? (
							<MonacoMarkdownDiffEditorAiEditsWrapper pageId={pageId} threadId={threadId} onExit={handleDiffExit} />
						) : (
							<PageEditorDiff
								pageId={pageId}
								presenceStore={presenceStore}
								headerSlot={headerSlot}
								modifiedInitialValue={diffModifiedInitialValue}
								onExit={handleDiffExit}
							/>
						)
					) : (
						<PageEditorPlainText pageId={pageId} presenceStore={presenceStore} headerSlot={headerSlot} />
					)}
				</CatchBoundary>
			</div>
		</div>
	);
}

export type PageEditor_Ref = {
	requestOpenDiff: (args: { pageId: app_convex_Id<"pages">; modifiedEditorValue: string }) => void;
	getMode: () => PageEditor_Mode;
};

export type PageEditor_Props = {
	ref?: Ref<PageEditor_Ref>;
	pageId: app_convex_Id<"pages"> | null | undefined;
	threadId?: string;
};

export function PageEditor(props: PageEditor_Props) {
	const { ref: refProp, pageId, threadId } = props;

	const authenticated = AppAuthProvider.useAuthenticated();

	const [editorMode, setEditorMode] = useState<PageEditor_Mode>("rich");
	const [diffModifiedInitialValue, setDiffModifiedInitialValue] = useState<string | undefined>(undefined);
	const [diffModifiedInitialValuePageId, setDiffModifiedInitialValuePageId] = useState<app_convex_Id<"pages"> | null>(
		null,
	);

	const diffModifiedInitialValueForPage =
		pageId && diffModifiedInitialValuePageId === pageId ? diffModifiedInitialValue : undefined;

	useImperativeHandle(
		refProp,
		() => ({
			requestOpenDiff: (_args: { pageId: app_convex_Id<"pages">; modifiedEditorValue: string }) => {
				setDiffModifiedInitialValuePageId(_args.pageId);
				setDiffModifiedInitialValue(_args.modifiedEditorValue);
				setEditorMode("diff");
			},
			getMode: () => editorMode,
		}),
		[editorMode],
	);

	return pageId ? (
		<PageEditorPresenceSupplier userId={authenticated.userId} pageId={pageId}>
			{({ presenceStore, onlineUsers }) => (
				<PageEditor_Inner
					pageId={pageId}
					editorMode={editorMode}
					threadId={threadId}
					presenceStore={presenceStore}
					onlineUsers={onlineUsers}
					diffModifiedInitialValue={diffModifiedInitialValueForPage}
					onEditorModeChange={setEditorMode}
				/>
			)}
		</PageEditorPresenceSupplier>
	) : (
		<div>No document selected</div>
	);
}
// #endregion PageEditor
