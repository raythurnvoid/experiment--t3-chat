import "./page-editor.css";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { PageEditorRichText } from "./page-editor-rich-text/page-editor-rich-text.tsx";
import { PageEditorSkeleton } from "./page-editor-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref, useEffect, useRef, useEffectEvent } from "react";
import { PageEditorPlainText } from "./page-editor-plain-text/page-editor-plain-text.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, cn, should_never_happen } from "@/lib/utils.ts";
import { PageEditorDiff, type PageEditorDiff_Ref } from "./page-editor-diff/page-editor-diff.tsx";
import { PageEditorSidebar } from "./page-editor-sidebar/page-editor-sidebar.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	pages_ROOT_ID,
	pages_create_room_id,
	type pages_TreeItem,
	pages_PresenceStore,
	type pages_EditorView,
} from "@/lib/pages.ts";
import { ChevronLeft, ChevronRight, Home, Sparkles } from "lucide-react";
import { MyButtonGroup, MyButtonGroupItem } from "../my-button-group.tsx";
import { MyButton } from "../my-button.tsx";
import { MyIcon } from "../my-icon.tsx";
import { MyIconButton } from "../my-icon-button.tsx";
import { MyLink } from "../my-link.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PageEditorPresence } from "./page-editor-presence.tsx";
import {
	usePresence,
	usePresenceList,
	usePresenceSessions,
	usePresenceSessionsData,
} from "../../hooks/presence-hooks.ts";
import { CatchBoundary, useNavigate } from "@tanstack/react-router";
import { PageEditorError } from "./page-editor-error.tsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { MySeparator_ClassNames } from "../my-separator.tsx";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";

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

// #region header
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
	editorMode: PageEditor_Mode;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
	onEditorModeChange: (mode: PageEditor_Mode) => void;
};

function PageEditorHeader(props: PageEditorHeader_Props) {
	const { pageId, editorMode, onlineUsers, onEditorModeChange } = props;

	const homePageId = useAppGlobalStore((state) => state.pages_home_id);

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
									search={{ pageId: homePageId, view: editorMode }}
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
												search={{ pageId: item.index, view: editorMode }}
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
				<MyButtonGroup
					value={editorMode}
					onValueChange={(mode) => onEditorModeChange(mode as PageEditorHeader_Props["editorMode"])}
				>
					<MyButtonGroupItem value="rich_text_editor">Rich</MyButtonGroupItem>
					<MyButtonGroupItem value="plain_text_editor">Markdown</MyButtonGroupItem>
					<MyButtonGroupItem value="diff_editor">Diff</MyButtonGroupItem>
				</MyButtonGroup>
			</div>
		</div>
	);
}
// #endregion header

// #region pending edits floating
type PageEditorPendingEditsFloating_ClassNames =
	| "PageEditorPendingEditsFloating"
	| "PageEditorPendingEditsFloating-icon"
	| "PageEditorPendingEditsFloating-review-button"
	| "PageEditorPendingEditsFloating-review-pager"
	| "PageEditorPendingEditsFloating-review-pager-button"
	| "PageEditorPendingEditsFloating-review-pager-label";

type PageEditorPendingEditsFloating_Props = {
	updatedAt?: number;
	showReviewButton: boolean;
	reviewPagerLabel: string;
	canNavigate: boolean;
	onReviewChanges: () => void;
	onNavigatePrevious: () => void;
	onNavigateNext: () => void;
};

function PageEditorPendingEditsFloating(props: PageEditorPendingEditsFloating_Props) {
	const { showReviewButton, reviewPagerLabel, canNavigate, onReviewChanges, onNavigatePrevious, onNavigateNext } = props;

	const handleClickReviewChanges = () => {
		onReviewChanges();
	};

	return (
		<div
			className={cn("PageEditorPendingEditsFloating" satisfies PageEditorPendingEditsFloating_ClassNames)}
			role="status"
			aria-live="polite"
			data-testid="pending-edits-banner"
		>
			<MyIcon className={cn("PageEditorPendingEditsFloating-icon" satisfies PageEditorPendingEditsFloating_ClassNames)}>
				<Sparkles />
			</MyIcon>
			Agent edits are pending review
			{showReviewButton && (
				<MyButton
					variant="accent"
					data-testid="review-changes-button"
					className={cn(
						"PageEditorPendingEditsFloating-review-button" satisfies PageEditorPendingEditsFloating_ClassNames,
					)}
					onClick={handleClickReviewChanges}
				>
					Review changes
				</MyButton>
			)}
			<div className={cn("PageEditorPendingEditsFloating-review-pager" satisfies PageEditorPendingEditsFloating_ClassNames)}>
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Previous pending edit"
					className={cn(
						"PageEditorPendingEditsFloating-review-pager-button" satisfies PageEditorPendingEditsFloating_ClassNames,
					)}
					disabled={!canNavigate}
					onClick={onNavigatePrevious}
				>
					<ChevronLeft />
				</MyIconButton>
				<span
					className={cn(
						"PageEditorPendingEditsFloating-review-pager-label" satisfies PageEditorPendingEditsFloating_ClassNames,
					)}
				>
					{reviewPagerLabel}
				</span>
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Next pending edit"
					className={cn(
						"PageEditorPendingEditsFloating-review-pager-button" satisfies PageEditorPendingEditsFloating_ClassNames,
					)}
					disabled={!canNavigate}
					onClick={onNavigateNext}
				>
					<ChevronRight />
				</MyIconButton>
			</div>
		</div>
	);
}
// #endregion pending edits floating

// #region presence supplier

type PageEditorPresenceSupplier_Props = {
	userId: string | null | undefined;
	pageId: app_convex_Id<"pages">;

	children: (props: {
		presenceStore: pages_PresenceStore | null;
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

	return children({ presenceStore, onlineUsers });
}

// #endregion presence supplier

// #region page editor render
type PageEditorRender_Props = {
	pageId: app_convex_Id<"pages">;
	editorMode: PageEditor_Mode;
	presenceStore: pages_PresenceStore | null;
	commentsPortalHost: HTMLElement | null;
	diffEditorRef: Ref<PageEditorDiff_Ref>;
	modifiedInitialValue?: string;
	pendingEditUpdatedAt?: number;
	onDiffExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
};

function PageEditorRender(props: PageEditorRender_Props) {
	const {
		pageId,
		editorMode,
		presenceStore,
		commentsPortalHost,
		diffEditorRef,
		modifiedInitialValue,
		pendingEditUpdatedAt,
		onDiffExit,
		topStickyFloatingSlot,
	} = props;

	if (!presenceStore) {
		return <PageEditorSkeleton />;
	}

	if (editorMode === "rich_text_editor") {
		return (
			<PageEditorRichText
				pageId={pageId}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
			/>
		);
	}

	if (editorMode === "diff_editor") {
		return (
			<PageEditorDiff
				ref={diffEditorRef}
				pageId={pageId}
				presenceStore={presenceStore}
				modifiedInitialValue={modifiedInitialValue}
				pendingEditUpdatedAt={pendingEditUpdatedAt}
				onExit={onDiffExit}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
			/>
		);
	}

	return (
		<PageEditorPlainText
			pageId={pageId}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
		/>
	);
}
// #endregion page editor render

// #region root
export type PageEditor_Mode = pages_EditorView;

export type PageEditor_ClassNames =
	| "PageEditor"
	| "PageEditor-editor-area"
	| "PageEditor-panels-group"
	| "PageEditor-content-panel"
	| "PageEditor-sidebar"
	| "PageEditor-panel-size-handle-container"
	| "PageEditor-panel-size-handle";

type PageEditor_Inner_Props = {
	pageId: app_convex_Id<"pages">;
	editorMode: PageEditor_Mode;
	presenceStore: pages_PresenceStore | null;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
	onEditorModeChange: PageEditorHeader_Props["onEditorModeChange"];
	onReviewPendingEdits?: () => void;
	onNavigatePendingEdits?: (args: { pageId: app_convex_Id<"pages">; forceDiffEditor: boolean }) => void;
	onDiffExit?: () => void;
};

function PageEditor_Inner(props: PageEditor_Inner_Props) {
	const {
		pageId,
		editorMode,
		presenceStore,
		onlineUsers,
		onEditorModeChange,
		onReviewPendingEdits,
		onNavigatePendingEdits,
		onDiffExit,
	} = props;

	const pendingEditsResult = useQuery(app_convex_api.ai_chat.get_ai_pending_edit, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		pageId,
	});
	const allPendingEditsResult = useQuery(app_convex_api.ai_chat.list_ai_pending_edits, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});

	const pendingEditsOrdered = ((/* iife */) => {
		if (allPendingEditsResult && allPendingEditsResult.length > 0) {
			return allPendingEditsResult.toReversed();
		}
		return pendingEditsResult ? [pendingEditsResult] : [];
	})();
	const hasAnyPendingEdits = pendingEditsOrdered.length > 0;
	const hasPendingEdits = hasAnyPendingEdits;
	const currentPendingEditIndex = pendingEditsOrdered.findIndex((pendingEdit) => pendingEdit.pageId === pageId);
	const hasCurrentPendingEdits = currentPendingEditIndex >= 0;
	const activePendingEditIndex = hasCurrentPendingEdits ? currentPendingEditIndex : 0;
	const canNavigatePendingEdits = pendingEditsOrdered.length > 1 || (pendingEditsOrdered.length === 1 && !hasCurrentPendingEdits);
	const reviewPagerLabel = hasCurrentPendingEdits
		? `Review ${activePendingEditIndex + 1} of ${pendingEditsOrdered.length}`
		: "Review pending edits";

	const diffEditorRef = useRef<PageEditorDiff_Ref | null>(null);
	const [commentsPortalHost, setCommentsPortalHost] = useState<HTMLElement | null>(null);

	const handleDiffExit = () => {
		onEditorModeChange("rich_text_editor");
		onDiffExit?.();
	};

	const handleNavigatePendingEdits = (direction: "prev" | "next") => {
		if (!onNavigatePendingEdits) {
			return;
		}

		const navCount = pendingEditsOrdered.length;
		if (navCount <= 1) {
			const onlyPendingEdit = pendingEditsOrdered[0];
			if (!onlyPendingEdit || hasCurrentPendingEdits) {
				return;
			}

			onNavigatePendingEdits({
				pageId: onlyPendingEdit.pageId,
				forceDiffEditor: true,
			});
			return;
		}

		const nextIndex =
			direction === "prev"
				? (activePendingEditIndex - 1 + navCount) % navCount
				: (activePendingEditIndex + 1) % navCount;
		const nextPendingEdit = pendingEditsOrdered[nextIndex];
		if (!nextPendingEdit) {
			return;
		}

		onNavigatePendingEdits({
			pageId: nextPendingEdit.pageId,
			forceDiffEditor: !hasCurrentPendingEdits,
		});
	};

	const handleNavigatePendingEditsPrevious = () => {
		handleNavigatePendingEdits("prev");
	};

	const handleNavigatePendingEditsNext = () => {
		handleNavigatePendingEdits("next");
	};

	useEffect(() => {
		if (editorMode !== "diff_editor" || !pendingEditsResult) {
			return;
		}

		diffEditorRef.current?.setModifiedContent(pendingEditsResult.modifiedContent ?? "");
	}, [editorMode, pendingEditsResult?.modifiedContent]);

	const topStickyFloatingSlot =
		hasPendingEdits ? (
			<PageEditorPendingEditsFloating
				updatedAt={pendingEditsResult?.updatedAt}
				showReviewButton={hasCurrentPendingEdits && editorMode !== "diff_editor"}
				reviewPagerLabel={reviewPagerLabel}
				canNavigate={canNavigatePendingEdits}
				onReviewChanges={onReviewPendingEdits ?? (() => {})}
				onNavigatePrevious={handleNavigatePendingEditsPrevious}
				onNavigateNext={handleNavigatePendingEditsNext}
			/>
		) : null;

	const headerSlot = (
		<PageEditorHeader
			pageId={pageId}
			editorMode={editorMode}
			onEditorModeChange={onEditorModeChange}
			onlineUsers={onlineUsers}
		/>
	);

	const leftPanelStyle =
		editorMode === "rich_text_editor"
			? {
					minHeight: "100%",
					height: "max-content",
					/** required for sticky descendants to work */
					overflow: "visible",
				}
			: undefined;

	return (
		<div className={cn("PageEditor" satisfies PageEditor_ClassNames)}>
			{headerSlot}
			<div
				className={cn("PageEditor-editor-area" satisfies PageEditor_ClassNames)}
				style={editorMode === "rich_text_editor" ? undefined : { overflowY: "visible" }}
			>
				<PanelGroup
					direction="horizontal"
					className={cn("PageEditor-panels-group" satisfies PageEditor_ClassNames)}
					style={{
						height: "max-content",
						/** required for sticky descendants to work */
						overflow: "visible",
					}}
				>
					<Panel
						defaultSize={75}
						className={cn("PageEditor-content-panel" satisfies PageEditor_ClassNames)}
						style={leftPanelStyle}
					>
						<CatchBoundary
							getResetKey={() => 0}
							errorComponent={PageEditorError}
							onCatch={(err) => {
								console.error("[PageEditor_Inner]", err);
							}}
						>
							<PageEditorRender
								pageId={pageId}
								editorMode={editorMode}
								presenceStore={presenceStore}
								commentsPortalHost={commentsPortalHost}
								diffEditorRef={diffEditorRef}
								modifiedInitialValue={pendingEditsResult?.modifiedContent ?? undefined}
								pendingEditUpdatedAt={pendingEditsResult?.updatedAt ?? undefined}
								topStickyFloatingSlot={topStickyFloatingSlot}
								onDiffExit={handleDiffExit}
							/>
						</CatchBoundary>
					</Panel>
					<div className={cn("PageEditor-panel-size-handle-container" satisfies PageEditor_ClassNames)}>
						<PanelResizeHandle
							className={cn(
								"PageEditor-panel-size-handle" satisfies PageEditor_ClassNames,
								"MySeparator" satisfies MySeparator_ClassNames,
								"MySeparator-vertical" satisfies MySeparator_ClassNames,
							)}
						/>
					</div>
					<Panel
						className={"PageEditor-sidebar" satisfies PageEditor_ClassNames}
						collapsible={false}
						defaultSize={25}
						style={{
							overflow: "initial",
						}}
					>
						<PageEditorSidebar commentsContainerRef={setCommentsPortalHost} />
					</Panel>
				</PanelGroup>
			</div>
		</div>
	);
}

export type PageEditor_Ref = {
	getMode: () => PageEditor_Mode;
};

export type PageEditor_Props = {
	ref?: Ref<PageEditor_Ref>;
	pageId: app_convex_Id<"pages"> | null | undefined;
	editorMode: PageEditor_Mode;
	onEditorModeChange: PageEditorHeader_Props["onEditorModeChange"];
};

export function PageEditor(props: PageEditor_Props) {
	const { ref, pageId, editorMode, onEditorModeChange } = props;

	const navigate = useNavigate();
	const authenticated = AppAuthProvider.useAuthenticated();

	useImperativeHandle(
		ref,
		() => ({
			getMode: () => editorMode,
		}),
		[editorMode],
	);

	const handleReviewPendingEdits = () => {
		onEditorModeChange("diff_editor");
	};

	const handleNavigatePendingEdits: NonNullable<PageEditor_Inner_Props["onNavigatePendingEdits"]> = (args) => {
		const nextView = args.forceDiffEditor ? "diff_editor" : editorMode;
		const nextSearch = {
			pageId: args.pageId,
			view: nextView === "rich_text_editor" ? undefined : nextView,
		};

		navigate({
			to: "/pages",
			search: nextSearch,
		}).catch((error) => {
			console.error("[PageEditor_Inner.handleNavigatePendingEdits] Error navigating to pending edits", { error });
		});
	};

	return pageId ? (
		<PageEditorPresenceSupplier userId={authenticated.userId} pageId={pageId}>
			{({ presenceStore, onlineUsers }) => (
				<PageEditor_Inner
					pageId={pageId}
					editorMode={editorMode}
					presenceStore={presenceStore}
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
					onReviewPendingEdits={handleReviewPendingEdits}
					onNavigatePendingEdits={handleNavigatePendingEdits}
				/>
			)}
		</PageEditorPresenceSupplier>
	) : (
		<div>No document selected</div>
	);
}
// #endregion root
