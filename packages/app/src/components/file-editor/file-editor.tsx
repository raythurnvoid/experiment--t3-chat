import "./file-editor.css";
import { FileEditorRichText } from "./file-editor-rich-text/file-editor-rich-text.tsx";
import { FileEditorDiffSkeleton } from "./file-editor-diff/file-editor-diff-skeleton.tsx";
import React, { useState, useImperativeHandle, type Ref, useEffect, useRef } from "react";
import { FileEditorPlainText } from "./file-editor-plain-text/file-editor-plain-text.tsx";
import { FileEditorPlainTextSkeleton } from "./file-editor-plain-text/file-editor-plain-text-skeleton.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn } from "@/lib/utils.ts";
import { FileEditorDiff } from "./file-editor-diff/file-editor-diff.tsx";
import { useMutation, useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_create_room_id,
	files_PresenceStore,
	type files_EditorView,
} from "@/lib/files.ts";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { MyButton } from "../my-button.tsx";
import { MyIcon } from "../my-icon.tsx";
import { MyIconButton } from "../my-icon-button.tsx";
import { FileEditorRichTextSkeleton } from "./file-editor-rich-text/file-editor-rich-text-skeleton.tsx";
import {
	usePresence,
	usePresenceEnabled,
	usePresenceList,
	usePresenceSessions,
	usePresenceSessionsData,
} from "@/hooks/presence-hooks.ts";
import { CatchBoundary } from "@tanstack/react-router";
import { FileEditorError } from "./file-editor-error.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";

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

export type FileEditor_OnlineUser = {
	userId: string;
	isSelf: boolean;
	anagraphic: { displayName: string; avatarUrl?: string };
	color: string;
};

export type FileEditorPresenceSupplier_Props = {
	userId: string | null | undefined;
	nodeId: app_convex_Id<"files_nodes">;

	children: (props: {
		presenceStore: files_PresenceStore | null;
		onlineUsers: FileEditor_OnlineUser[];
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

export function FileEditorPresenceSupplier(props: FileEditorPresenceSupplier_Props) {
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
	toolbarPortalHost?: HTMLElement | null;
	onDiffExit: () => void;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
};

function FileEditorRender(props: FileEditorRender_Props) {
	const {
		nodeId,
		pendingUpdateId,
		editorMode,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onDiffExit,
		topStickyFloatingSlot,
		topViewZoneSlot,
	} = props;

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
				toolbarPortalHost={toolbarPortalHost}
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
				toolbarPortalHost={toolbarPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
				topViewZoneSlot={topViewZoneSlot}
			/>
		);
	}

	return (
		<FileEditorPlainText
			nodeId={nodeId}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
}
// #endregion file editor render

// #region root
export type FileEditor_Mode = files_EditorView;

export type FileEditor_ClassNames =
	| "FileEditor"
	| "FileEditor-layout-embedded"
	| "FileEditor-layout-route"
	| "FileEditor-mode-diff"
	| "FileEditor-mode-plain-text"
	| "FileEditor-mode-rich-text"
	| "FileEditor-editor-area";

export type FileEditor_NavigatePendingUpdates = (args: {
	nodeId: app_convex_Id<"files_nodes">;
	forceDiffEditor: boolean;
}) => void;

export type FileEditor_Layout = "route" | "embedded";

type FileEditorInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editorMode: FileEditor_Mode;
	layout: FileEditor_Layout;
	presenceStore: files_PresenceStore | null;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost?: HTMLElement | null;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onReviewPendingUpdates?: () => void;
	onNavigatePendingUpdates?: FileEditor_NavigatePendingUpdates;
	onDiffExit?: () => void;
	topViewZoneSlot?: React.ReactNode;
};

function FileEditorInner(props: FileEditorInner_Props) {
	const {
		nodeId,
		editorMode,
		layout,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
		onReviewPendingUpdates,
		onNavigatePendingUpdates,
		onDiffExit,
		topViewZoneSlot,
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

	const renderHostStyle =
		editorMode === "rich_text_editor"
			? layout === "embedded"
				? {
						flex: "0 0 auto",
						minHeight: 0,
						height: "max-content",
						/** required for sticky descendants to work */
						overflow: "visible",
					}
				: {
						flex: "1 0 auto",
						minHeight: "100%",
						height: "max-content",
						/** required for sticky descendants to work */
						overflow: "visible",
					}
			: {
					flex: "1 1 auto",
					minHeight: 0,
					height: "100%",
				};

	const editorModeClass =
		editorMode === "rich_text_editor"
			? ("FileEditor-mode-rich-text" satisfies FileEditor_ClassNames)
			: editorMode === "plain_text_editor"
				? ("FileEditor-mode-plain-text" satisfies FileEditor_ClassNames)
				: ("FileEditor-mode-diff" satisfies FileEditor_ClassNames);

	return (
		<div
			className={cn(
				"FileEditor" satisfies FileEditor_ClassNames,
				layout === "embedded"
					? ("FileEditor-layout-embedded" satisfies FileEditor_ClassNames)
					: ("FileEditor-layout-route" satisfies FileEditor_ClassNames),
				editorModeClass,
			)}
			role="region"
			aria-label="File editor"
		>
			<div
				className={cn("FileEditor-editor-area" satisfies FileEditor_ClassNames)}
				style={editorMode === "rich_text_editor" ? undefined : { overflowY: "visible" }}
			>
				<CatchBoundary
					getResetKey={getCatchBoundaryResetKey}
					errorComponent={FileEditorError}
					onCatch={handleCatchBoundaryError}
				>
					<div style={renderHostStyle}>
						<FileEditorRender
							nodeId={nodeId}
							pendingUpdateId={currentPendingUpdate?._id}
							editorMode={editorMode}
							presenceStore={presenceStore}
							commentsPortalHost={commentsPortalHost}
							toolbarPortalHost={toolbarPortalHost}
							topStickyFloatingSlot={topStickyFloatingSlot}
							topViewZoneSlot={topViewZoneSlot}
							onDiffExit={handleDiffExit}
						/>
					</div>
				</CatchBoundary>
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
	layout?: FileEditor_Layout;
	presenceStore: files_PresenceStore | null;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost?: HTMLElement | null;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onNavigatePendingUpdates?: FileEditor_NavigatePendingUpdates;
	topViewZoneSlot?: React.ReactNode;
};

export function FileEditor(props: FileEditor_Props) {
	const {
		ref,
		nodeId,
		editorMode,
		layout = "route",
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
		onNavigatePendingUpdates,
		topViewZoneSlot,
	} = props;

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

	return nodeId ? (
		<FileEditorInner
			nodeId={nodeId}
			editorMode={editorMode}
			layout={layout}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
			onReviewPendingUpdates={handleReviewPendingUpdates}
			onNavigatePendingUpdates={onNavigatePendingUpdates}
			topViewZoneSlot={topViewZoneSlot}
		/>
	) : (
		<div>No document selected</div>
	);
}
// #endregion root
