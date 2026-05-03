import "./file-editor.css";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { FileEditorRichText } from "./file-editor-rich-text/file-editor-rich-text.tsx";
import { FileEditorDiffSkeleton } from "./file-editor-diff/file-editor-diff-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { FileEditorPlainText } from "./file-editor-plain-text/file-editor-plain-text.tsx";
import { FileEditorPlainTextSkeleton } from "./file-editor-plain-text/file-editor-plain-text-skeleton.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn } from "@/lib/utils.ts";
import { FileEditorDiff } from "./file-editor-diff/file-editor-diff.tsx";
import { FileEditorSidebar } from "./file-editor-sidebar/file-editor-sidebar.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_ROOT_ID,
	files_create_room_id,
	type files_TreeItem,
	files_PresenceStore,
	type files_EditorView,
} from "@/lib/files.ts";
import { ChevronLeft, ChevronRight, Home, Sparkles } from "lucide-react";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { FilesSidebarToggle } from "@/components/files-sidebar-toggle.tsx";
import { MyButtonGroup, MyButtonGroupItem } from "../my-button-group.tsx";
import { MyButton } from "../my-button.tsx";
import { MyIcon } from "../my-icon.tsx";
import { MyIconButton } from "../my-icon-button.tsx";
import { MyLink, MyLinkIcon } from "../my-link.tsx";
import { FileEditorPresence } from "./file-editor-presence.tsx";
import { FileEditorRichTextSkeleton } from "./file-editor-rich-text/file-editor-rich-text-skeleton.tsx";
import {
	usePresence,
	usePresenceEnabled,
	usePresenceList,
	usePresenceSessions,
	usePresenceSessionsData,
} from "../../hooks/presence-hooks.ts";
import { CatchBoundary, useNavigate } from "@tanstack/react-router";
import { FileEditorError } from "./file-editor-error.tsx";
import {
	MyPanel,
	MyPanelGroup,
	type MyPanelGroup_Props,
	MyPanelResizeHandle,
	type MyPanelResizeHandle_Props,
} from "../my-resizable-panel-group.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useAppLocalStorageStateValue, useAppLocalStorageValue } from "@/lib/storage.ts";
import { useFn } from "@/hooks/utils-hooks.ts";

function get_breadcrumb_path(
	treeItemsList: files_TreeItem[] | undefined,
	nodeId: app_convex_Id<"files_nodes"> | null | undefined,
): files_TreeItem[] {
	if (!treeItemsList || !nodeId) return [];

	const path: files_TreeItem[] = [];
	let currentId: string = files_ROOT_ID;

	// Create a map for quick lookup
	const itemsMap = new Map<string, files_TreeItem>();
	for (const item of treeItemsList) {
		itemsMap.set(item.index, item);
		if (item._id === nodeId) {
			currentId = item.index;
		}
	}

	// Navigate up the tree using parentId
	while (currentId && currentId !== files_ROOT_ID) {
		const item = itemsMap.get(currentId);
		if (!item) break;

		path.unshift(item); // Add to beginning of array
		currentId = item.parentId;
	}

	return path;
}

// #region header
type FileEditorHeader_ClassNames =
	| "FileEditorHeader"
	| "FileEditorHeader-start"
	| "FileEditorHeader-sidebars-actions"
	| "FileEditorHeader-breadcrumb"
	| "FileEditorHeader-breadcrumb-home"
	| "FileEditorHeader-breadcrumb-segment"
	| "FileEditorHeader-breadcrumb-segment-current"
	| "FileEditorHeader-breadcrumb-separator"
	| "FileEditorHeader-diff-switch"
	| "FileEditorHeader-switch-container"
	| "FileEditorHeader-switch-group"
	| "FileEditorHeader-label-text"
	| "FileEditorHeader-switch-text";

type FileEditorHeader_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null | undefined;
	editorMode: FileEditor_Mode;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

function FileEditorHeader(props: FileEditorHeader_Props) {
	const { nodeId, editorMode, onlineUsers, onEditorModeChange } = props;

	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();

	const homeNodeId = useAppGlobalStore((state) => state.files_home_id_by_membership_id[membershipId] ?? "");

	const filesSidebarOpen = useAppLocalStorageValue("app_state::sidebar::files_open");

	const handleEditorModeChange = useFn((mode: string) => {
		onEditorModeChange(mode as FileEditorHeader_Props["editorMode"]);
	});

	// Query tree items to build breadcrumb path
	const treeItemsList = useQuery(app_convex_api.files_nodes.get_tree_nodes_list, {
		membershipId,
	});

	// Build breadcrumb path from nodeId up to root
	const breadcrumbPath = get_breadcrumb_path(treeItemsList, nodeId);

	return (
		<div className={cn("FileEditorHeader" satisfies FileEditorHeader_ClassNames)}>
			<div className={cn("FileEditorHeader-start" satisfies FileEditorHeader_ClassNames)}>
				{!filesSidebarOpen && (
					<div className={cn("FileEditorHeader-sidebars-actions" satisfies FileEditorHeader_ClassNames)}>
						<MainAppSidebarToggle variant="ghost-highlightable" tooltip="Open app sidebar" />
						<FilesSidebarToggle variant="ghost-highlightable" tooltip="Open files sidebar" />
					</div>
				)}

				{/* Left: Breadcrumb path */}
				<ol className={cn("FileEditorHeader-breadcrumb" satisfies FileEditorHeader_ClassNames)}>
					{nodeId && treeItemsList && breadcrumbPath.length > 0 ? (
						<>
							<li>
								<MyLink
									aria-label="Home"
									className={cn("FileEditorHeader-breadcrumb-home" satisfies FileEditorHeader_ClassNames)}
									to="/w/$workspaceName/$projectName/files"
									params={{ workspaceName, projectName }}
									search={{ nodeId: homeNodeId, view: editorMode }}
									variant="button-icon-ghost-highlightable"
									tooltip="Home"
								>
									<MyLinkIcon aria-hidden>
										<Home />
									</MyLinkIcon>
								</MyLink>
							</li>
							<span>/</span>
							{breadcrumbPath.map((item, index) => {
								const isCurrentFile = index === breadcrumbPath.length - 1;
								const breadcrumbItem = (
									<React.Fragment key={item.index}>
										{isCurrentFile ? (
											<li
												className={cn(
													"FileEditorHeader-breadcrumb-segment-current" satisfies FileEditorHeader_ClassNames,
												)}
											>
												{item.title}
											</li>
										) : (
											<li>
												<MyLink
													className={cn("FileEditorHeader-breadcrumb-segment" satisfies FileEditorHeader_ClassNames)}
													to="/w/$workspaceName/$projectName/files"
													params={{ workspaceName, projectName }}
													search={{ nodeId: item.index, view: editorMode }}
													variant="button-tertiary"
												>
													{item.title}
												</MyLink>
											</li>
										)}
										{index < breadcrumbPath.length - 1 && (
											<span
												className={cn("FileEditorHeader-breadcrumb-separator" satisfies FileEditorHeader_ClassNames)}
											>
												/
											</span>
										)}
									</React.Fragment>
								);
								return breadcrumbItem;
							})}
						</>
					) : (
						<li className={cn("FileEditorHeader-breadcrumb-segment-current" satisfies FileEditorHeader_ClassNames)}>
							<Home size={16} />
							<span>Home</span>
						</li>
					)}
				</ol>
			</div>

			{/* Right: Presence indicator and switches */}
			<div className={cn("FileEditorHeader-switch-group" satisfies FileEditorHeader_ClassNames)}>
				<FileEditorPresence users={onlineUsers} />
				<MainAppHeaderBillingIndicator />
				<MyButtonGroup value={editorMode} onValueChange={handleEditorModeChange}>
					<MyButtonGroupItem value="rich_text_editor">Rich</MyButtonGroupItem>
					<MyButtonGroupItem value="plain_text_editor">Markdown</MyButtonGroupItem>
					<MyButtonGroupItem value="diff_editor">Diff</MyButtonGroupItem>
				</MyButtonGroup>
			</div>
		</div>
	);
}
// #endregion header

// #region pending updates floating
type FileEditorPendingUpdatesFloating_ClassNames =
	| "FileEditorPendingUpdatesFloating"
	| "FileEditorPendingUpdatesFloating-icon"
	| "FileEditorPendingUpdatesFloating-review-button"
	| "FileEditorPendingUpdatesFloating-review-pager"
	| "FileEditorPendingUpdatesFloating-review-pager-button"
	| "FileEditorPendingUpdatesFloating-review-pager-label";

type FileEditorPendingUpdatesFloating_Props = {
	updatedAt?: number;
	showReviewButton: boolean;
	reviewPagerLabel: string;
	canNavigate: boolean;
	onReviewChanges: () => void;
	onNavigatePrevious: () => void;
	onNavigateNext: () => void;
};

function FileEditorPendingUpdatesFloating(props: FileEditorPendingUpdatesFloating_Props) {
	const { showReviewButton, reviewPagerLabel, canNavigate, onReviewChanges, onNavigatePrevious, onNavigateNext } =
		props;

	const handleClickReviewChanges = useFn(() => {
		onReviewChanges();
	});

	return (
		<div
			className={cn("FileEditorPendingUpdatesFloating" satisfies FileEditorPendingUpdatesFloating_ClassNames)}
			role="status"
			aria-live="polite"
			data-testid="pending-edits-banner"
		>
			<MyIcon className={cn("FileEditorPendingUpdatesFloating-icon" satisfies FileEditorPendingUpdatesFloating_ClassNames)}>
				<Sparkles />
			</MyIcon>
			Agent edits are pending review
			{showReviewButton && (
				<MyButton
					variant="accent"
					data-testid="review-changes-button"
					className={cn(
						"FileEditorPendingUpdatesFloating-review-button" satisfies FileEditorPendingUpdatesFloating_ClassNames,
					)}
					onClick={handleClickReviewChanges}
				>
					Review changes
				</MyButton>
			)}
			<div
				className={cn(
					"FileEditorPendingUpdatesFloating-review-pager" satisfies FileEditorPendingUpdatesFloating_ClassNames,
				)}
			>
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Previous pending update"
					className={cn(
						"FileEditorPendingUpdatesFloating-review-pager-button" satisfies FileEditorPendingUpdatesFloating_ClassNames,
					)}
					disabled={!canNavigate}
					onClick={onNavigatePrevious}
				>
					<ChevronLeft />
				</MyIconButton>
				<span
					className={cn(
						"FileEditorPendingUpdatesFloating-review-pager-label" satisfies FileEditorPendingUpdatesFloating_ClassNames,
					)}
				>
					{reviewPagerLabel}
				</span>
				<MyIconButton
					variant="ghost-highlightable"
					tooltip="Next pending update"
					className={cn(
						"FileEditorPendingUpdatesFloating-review-pager-button" satisfies FileEditorPendingUpdatesFloating_ClassNames,
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
// #endregion pending updates floating

// #region presence supplier

type FileEditorPresenceSupplier_Props = {
	userId: string | null | undefined;
	nodeId: app_convex_Id<"files_nodes">;

	children: (props: {
		presenceStore: files_PresenceStore | null;
		onlineUsers: Array<{
			userId: string;
			isSelf: boolean;
			anagraphic: { displayName: string; avatarUrl?: string };
			color: string;
		}>;
	}) => React.ReactNode;
};

function FileEditorPresenceSupplier_Enabled(props: FileEditorPresenceSupplier_Props) {
	const { userId, nodeId, children } = props;

	const { workspaceId, projectId } = AppTenantProvider.useContext();

	const roomId = files_create_room_id(workspaceId, projectId, nodeId);

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
	const setSessionDataPending = useRef<{
		localSessionToken: string;
		data: Parameters<ConstructorParameters<typeof files_PresenceStore>[0]["onSetSessionData"]>[0];
	} | null>(null);

	const [presenceStoreState, setPresenceStoreState] = useState<{
		roomId: string;
		sessionId: string;
		store: files_PresenceStore;
	} | null>(null);
	const presenceStore =
		presenceStoreState?.roomId === roomId && presenceStoreState.sessionId === presence.sessionId
			? presenceStoreState.store
			: null;

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

	const getCurrentSessionToken = useFn(() => presence.sessionToken);

	useEffect(() => {
		if (setSessionDataDebounce.current) {
			clearTimeout(setSessionDataDebounce.current);
			setSessionDataDebounce.current = undefined;
		}
		setSessionDataPending.current = null;

		// Reset on explicit presence identity changes so editor integrations never retain old-room cursors.
		setPresenceStoreState((previous) => {
			previous?.store.dispose();
			return null;
		});
	}, [roomId, presence.sessionId]);

	useEffect(() => {
		if (
			presenceSessions &&
			presenceList &&
			presenceSessionsData &&
			presence.sessionId &&
			presence.roomToken &&
			presence.sessionToken
		) {
			const localSessionIsPresent = presenceSessions.some((session) => session.sessionId === presence.sessionId);
			if (!localSessionIsPresent) {
				// Wait for Convex subscriptions to catch up to the successful heartbeat before
				// creating a cursor store for this local session.
				return;
			}

			if (presenceStore) {
				presenceStore.sync({
					sessionToken: presence.sessionToken,
					sessions: presenceSessions,
					sessionsData: presenceSessionsData,
					usersAnagraphics: presenceList.usersAnagraphics,
				});
			} else {
				const nextPresenceStore = new files_PresenceStore({
					data: {
						sessionToken: presence.sessionToken,
						sessions: presenceSessions,
						sessionsData: presenceSessionsData,
						usersAnagraphics: presenceList.usersAnagraphics,
					},
					localSessionId: presence.sessionId,
					onSetSessionData: (data) => {
						setSessionDataPending.current = {
							localSessionToken: nextPresenceStore.localSessionToken,
							data,
						};

						if (setSessionDataDebounce.current) return;

						setSessionDataDebounce.current = setTimeout(() => {
							const pending = setSessionDataPending.current;
							setSessionDataDebounce.current = undefined;
							setSessionDataPending.current = null;

							if (!pending) return;

							// Old editor cleanups can still update their old store during a route transition.
							// Only the currently connected local session is allowed to publish presence data.
							if (getCurrentSessionToken() !== pending.localSessionToken) return;

							setSessionDataMutation({
								sessionToken: pending.localSessionToken,
								data: pending.data,
							}).catch((error) => {
								console.error(error);
							});
						}, 550);
					},
				});
				setPresenceStoreState({ roomId, sessionId: presence.sessionId, store: nextPresenceStore });
			}
		}
	}, [
		presenceSessions,
		presenceList,
		presenceSessionsData,
		presence.sessionId,
		presence.roomToken,
		presence.sessionToken,
		presenceStore,
		roomId,
		setSessionDataMutation,
	]);

	return children({ presenceStore, onlineUsers });
}

function FileEditorPresenceSupplier_Disabled(props: FileEditorPresenceSupplier_Props) {
	const { userId, children } = props;

	const [presenceStore] = useState(() => {
		const localSessionId = crypto.randomUUID();
		const localUserId = userId ?? "presence-disabled-user";

		type FileEditorPresenceSupplier_Disabled_PresenceStoreData = ConstructorParameters<
			typeof files_PresenceStore
		>[0]["data"];

		return new files_PresenceStore({
			data: {
				sessionToken: "presence-disabled-session-token",
				sessions: [{ sessionId: localSessionId, userId: localUserId }],
				sessionsData: {
					[localSessionId]: {
						color: "var(--color-base-1-10)",
					},
				},
				usersAnagraphics: {
					[localUserId]: {
						displayName: "Presence disabled",
						avatarUrl: undefined,
					} as FileEditorPresenceSupplier_Disabled_PresenceStoreData["usersAnagraphics"][string],
				},
			},
			localSessionId,
			onSetSessionData: () => {},
		});
	});

	useEffect(() => {
		return () => {
			presenceStore.dispose();
		};
	}, [presenceStore]);

	return children({ presenceStore, onlineUsers: [] });
}

function FileEditorPresenceSupplier(props: FileEditorPresenceSupplier_Props) {
	const presenceEnabled = usePresenceEnabled();

	if (!presenceEnabled) {
		return <FileEditorPresenceSupplier_Disabled {...props} />;
	}

	return <FileEditorPresenceSupplier_Enabled {...props} />;
}

// #endregion presence supplier

// #region file editor render
type FileEditorRender_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	editorMode: FileEditor_Mode;
	presenceStore: files_PresenceStore | null;
	commentsPortalHost: HTMLElement | null;
	onDiffExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
};

function FileEditorRender(props: FileEditorRender_Props) {
	const { nodeId, pendingUpdateId, editorMode, presenceStore, commentsPortalHost, onDiffExit, topStickyFloatingSlot } =
		props;

	if (!presenceStore) {
		if (editorMode === "diff_editor") {
			return <FileEditorDiffSkeleton />;
		}

		if (editorMode === "plain_text_editor") {
			return <FileEditorPlainTextSkeleton />;
		}

		return <FileEditorRichTextSkeleton />;
	}

	if (editorMode === "rich_text_editor") {
		return (
			<FileEditorRichText
				nodeId={nodeId}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
			/>
		);
	}

	if (editorMode === "diff_editor") {
		return (
			<FileEditorDiff
				key={nodeId}
				nodeId={nodeId}
				pendingUpdateId={pendingUpdateId}
				presenceStore={presenceStore}
				onExit={onDiffExit}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
			/>
		);
	}

	return (
		<FileEditorPlainText
			nodeId={nodeId}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
		/>
	);
}
// #endregion file editor render

// #region root
export type FileEditor_Mode = files_EditorView;

export type FileEditor_ClassNames =
	| "FileEditor"
	| "FileEditor-editor-area"
	| "FileEditor-panels-group"
	| "FileEditor-content-panel"
	| "FileEditor-sidebar";

type FileEditorInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editorMode: FileEditor_Mode;
	presenceStore: files_PresenceStore | null;
	onlineUsers: Array<{
		userId: string;
		isSelf: boolean;
		anagraphic: { displayName: string; avatarUrl?: string };
		color: string;
	}>;
	onEditorModeChange: FileEditorHeader_Props["onEditorModeChange"];
	onReviewPendingUpdates?: () => void;
	onNavigatePendingUpdates?: (args: { nodeId: app_convex_Id<"files_nodes">; forceDiffEditor: boolean }) => void;
	onDiffExit?: () => void;
};

function FileEditorInner(props: FileEditorInner_Props) {
	const {
		nodeId,
		editorMode,
		presenceStore,
		onlineUsers,
		onEditorModeChange,
		onReviewPendingUpdates,
		onNavigatePendingUpdates,
		onDiffExit,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const allPendingUpdatesResult = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, {
		membershipId,
	});

	const pendingUpdatesOrdered = allPendingUpdatesResult ? allPendingUpdatesResult.toReversed() : [];
	const hasAnyPendingUpdates = pendingUpdatesOrdered.length > 0;
	const hasPendingUpdates = hasAnyPendingUpdates;
	const currentPendingUpdateIndex = pendingUpdatesOrdered.findIndex((pendingUpdate) => pendingUpdate.nodeId === nodeId);
	const currentPendingUpdate = pendingUpdatesOrdered[currentPendingUpdateIndex];
	const hasCurrentPendingUpdates = currentPendingUpdateIndex >= 0;
	const activePendingUpdateIndex = hasCurrentPendingUpdates ? currentPendingUpdateIndex : 0;
	const canNavigatePendingUpdates =
		pendingUpdatesOrdered.length > 1 || (pendingUpdatesOrdered.length === 1 && !hasCurrentPendingUpdates);
	const reviewPagerLabel = hasCurrentPendingUpdates
		? `Review ${activePendingUpdateIndex + 1} of ${pendingUpdatesOrdered.length}`
		: "Review pending updates";

	const [commentsPortalHost, setCommentsPortalHost] = useState<HTMLElement | null>(null);
	const [savedPanelLayout, setSavedPanelLayout] = useAppLocalStorageStateValue(
		"app_state::resizable_panel::file_editor_panel",
	);
	const panelLayoutRef = useRef(savedPanelLayout ?? [75, 25]);

	const handleDiffExit = useFn(() => {
		onEditorModeChange("rich_text_editor");
		onDiffExit?.();
	});

	const handleNavigatePendingUpdates = useFn((direction: "prev" | "next") => {
		if (!onNavigatePendingUpdates) {
			return;
		}

		const navCount = pendingUpdatesOrdered.length;
		if (navCount <= 1) {
			const onlyPendingUpdate = pendingUpdatesOrdered[0];
			if (!onlyPendingUpdate || hasCurrentPendingUpdates) {
				return;
			}

			onNavigatePendingUpdates({
				nodeId: onlyPendingUpdate.nodeId,
				forceDiffEditor: true,
			});
			return;
		}

		const nextIndex =
			direction === "prev"
				? (activePendingUpdateIndex - 1 + navCount) % navCount
				: (activePendingUpdateIndex + 1) % navCount;
		const nextPendingUpdate = pendingUpdatesOrdered[nextIndex];
		if (!nextPendingUpdate) {
			return;
		}

		onNavigatePendingUpdates({
			nodeId: nextPendingUpdate.nodeId,
			forceDiffEditor: !hasCurrentPendingUpdates,
		});
	});

	const handleNavigatePendingUpdatesPrevious = useFn(() => {
		handleNavigatePendingUpdates("prev");
	});

	const handleNavigatePendingUpdatesNext = useFn(() => {
		handleNavigatePendingUpdates("next");
	});

	const handlePanelLayout = useFn<NonNullable<MyPanelGroup_Props["onLayout"]>>((layout) => {
		panelLayoutRef.current = layout;
	});

	const handlePanelDragging = useFn<NonNullable<MyPanelResizeHandle_Props["onDragging"]>>((isDragging) => {
		if (isDragging) {
			return;
		}

		setSavedPanelLayout(panelLayoutRef.current);
	});

	const handleCatchBoundaryError = useFn((err: Error) => {
		console.error("[FileEditorInner]", err);
	});

	const getCatchBoundaryResetKey = useFn(() => 0);

	const topStickyFloatingSlot = hasPendingUpdates ? (
		<FileEditorPendingUpdatesFloating
			updatedAt={currentPendingUpdate?.updatedAt}
			showReviewButton={hasCurrentPendingUpdates && editorMode !== "diff_editor"}
			reviewPagerLabel={reviewPagerLabel}
			canNavigate={canNavigatePendingUpdates}
			onReviewChanges={onReviewPendingUpdates ?? (() => {})}
			onNavigatePrevious={handleNavigatePendingUpdatesPrevious}
			onNavigateNext={handleNavigatePendingUpdatesNext}
		/>
	) : null;

	const headerPortalElement = document.getElementById("app_main_header_content" satisfies AppElementId);

	const headerSlot = headerPortalElement
		? createPortal(
				<FileEditorHeader
					nodeId={nodeId}
					editorMode={editorMode}
					onEditorModeChange={onEditorModeChange}
					onlineUsers={onlineUsers}
				/>,
				headerPortalElement,
			)
		: null;

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
		<div className={cn("FileEditor" satisfies FileEditor_ClassNames)}>
			{headerSlot}
			<div
				className={cn("FileEditor-editor-area" satisfies FileEditor_ClassNames)}
				style={editorMode === "rich_text_editor" ? undefined : { overflowY: "visible" }}
			>
				<MyPanelGroup
					direction="horizontal"
					className={cn("FileEditor-panels-group" satisfies FileEditor_ClassNames)}
					onLayout={handlePanelLayout}
					style={{
						height: "max-content",
						/** required for sticky descendants to work */
						overflow: "visible",
					}}
				>
					<MyPanel
						defaultSize={savedPanelLayout?.[0] ?? 75}
						className={cn("FileEditor-content-panel" satisfies FileEditor_ClassNames)}
						style={leftPanelStyle}
					>
						<CatchBoundary
							getResetKey={getCatchBoundaryResetKey}
							errorComponent={FileEditorError}
							onCatch={handleCatchBoundaryError}
						>
							<FileEditorRender
								nodeId={nodeId}
								pendingUpdateId={currentPendingUpdate?._id}
								editorMode={editorMode}
								presenceStore={presenceStore}
								commentsPortalHost={commentsPortalHost}
								topStickyFloatingSlot={topStickyFloatingSlot}
								onDiffExit={handleDiffExit}
							/>
						</CatchBoundary>
					</MyPanel>
					<MyPanelResizeHandle onDragging={handlePanelDragging} />
					<MyPanel
						className={"FileEditor-sidebar" satisfies FileEditor_ClassNames}
						collapsible={false}
						defaultSize={savedPanelLayout?.[1] ?? 25}
						style={{
							overflow: "initial",
						}}
					>
						<FileEditorSidebar commentsContainerRef={setCommentsPortalHost} />
					</MyPanel>
				</MyPanelGroup>
			</div>
		</div>
	);
}

export type FileEditor_Ref = {
	getMode: () => FileEditor_Mode;
};

export type FileEditor_Props = {
	ref?: Ref<FileEditor_Ref>;
	nodeId: app_convex_Id<"files_nodes"> | null | undefined;
	editorMode: FileEditor_Mode;
	onEditorModeChange: FileEditorHeader_Props["onEditorModeChange"];
};

export function FileEditor(props: FileEditor_Props) {
	const { ref, nodeId, editorMode, onEditorModeChange } = props;

	const navigate = useNavigate();
	const authenticated = AppAuthProvider.useAuthenticated();
	const { workspaceName, projectName } = AppTenantProvider.useContext();

	useImperativeHandle(
		ref,
		() => ({
			getMode: () => editorMode,
		}),
		[editorMode],
	);

	const handleReviewPendingUpdates = useFn(() => {
		onEditorModeChange("diff_editor");
	});

	const handleNavigatePendingUpdates = useFn<NonNullable<FileEditorInner_Props["onNavigatePendingUpdates"]>>((args) => {
		const nextView = args.forceDiffEditor ? "diff_editor" : editorMode;
		const nextSearch = {
			nodeId: args.nodeId,
			view: nextView === "rich_text_editor" ? undefined : nextView,
		};

		navigate({
			to: "/w/$workspaceName/$projectName/files",
			params: { workspaceName, projectName },
			search: nextSearch,
		}).catch((error) => {
			console.error("[FileEditorInner.handleNavigatePendingUpdates] Error navigating to pending updates", { error });
		});
	});

	return nodeId ? (
		<FileEditorPresenceSupplier userId={authenticated.userId} nodeId={nodeId}>
			{({ presenceStore, onlineUsers }) => (
				<FileEditorInner
					nodeId={nodeId}
					editorMode={editorMode}
					presenceStore={presenceStore}
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
					onReviewPendingUpdates={handleReviewPendingUpdates}
					onNavigatePendingUpdates={handleNavigatePendingUpdates}
				/>
			)}
		</FileEditorPresenceSupplier>
	) : (
		<div>No document selected</div>
	);
}
// #endregion root
