import "./file-editor-sidebar.css";
import { memo, type Ref } from "react";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { FileEditorSidebarDetails } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-details.tsx";
import { FileEditorSidebarPending } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx";
import {
	FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
	FileEditorSidebarPendingTabBadge,
} from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import type { app_convex_Doc } from "@/lib/app-convex-client.ts";
import { files_node_has_editable_yjs_state } from "@/lib/files.ts";
import { cn } from "@/lib/utils.ts";

const FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS = "app_file_editor_sidebar_tabs_comments" satisfies AppElementId;
const FILE_EDITOR_SIDEBAR_TAB_ID_AGENT = "app_file_editor_sidebar_tabs_agent" satisfies AppElementId;
const FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS = "app_file_editor_sidebar_tabs_details" satisfies AppElementId;

// #region root
export type FileEditorSidebar_ClassNames =
	| "FileEditorSidebar"
	| "FileEditorSidebar-toolbar"
	| "FileEditorSidebar-tabs-list"
	| "FileEditorSidebar-tabs-panels"
	| "FileEditorSidebar-panel"
	| "FileEditorSidebar-panel-empty"
	| "FileEditorSidebar-comments-host";

export type FileEditorSidebar_Props = {
	/** The route-resolved node, or null while nothing (or the root folder) is selected. */
	node: app_convex_Doc<"files_nodes"> | null;
	commentsContainerRef: Ref<HTMLDivElement>;
};

export const FileEditorSidebar = memo(function FileEditorSidebar(props: FileEditorSidebar_Props) {
	const { node, commentsContainerRef } = props;

	const [storedFilesLastTab, setStoredFilesLastTab] = useAppLocalStorageStateValue("app_state::files_last_tab");

	// Comment threads live in Markdown comment marks, so a plain text document cannot have them.
	// Hide Comments for plain-text nodes and show Details instead — the stored-file card does not
	// render for editable nodes, so these rows have no other owner.
	const isPlainTextFile =
		node !== null &&
		node.kind === "file" &&
		files_node_has_editable_yjs_state(node) &&
		node.yjsRootKind === "plain_text";
	const availableTabIds: AppElementId[] = (
		[
			isPlainTextFile ? FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS : FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS,
			FILE_EDITOR_SIDEBAR_TAB_ID_AGENT,
			FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
		] satisfies (AppElementId | null)[]
	).filter((tabId) => tabId !== null);

	// If the selected tab is not available for this node, fall back to the first available one.
	// This covers both a stored selection naming a hidden tab AND the Comments default on a
	// plain-text node. The stored value stays untouched, so opening a rich-text file again
	// restores the user's real selection.
	const selectedTab = storedFilesLastTab ?? FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS;
	const filesLastTab = availableTabIds.includes(selectedTab) ? selectedTab : availableTabIds[0];

	const handleTabChange = (nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === filesLastTab) {
			return;
		}

		setStoredFilesLastTab(nextSelectedId as AppElementId);
	};

	return (
		<>
			<MyTabs selectedId={filesLastTab} setSelectedId={handleTabChange}>
				<div className={cn("FileEditorSidebar-toolbar" satisfies FileEditorSidebar_ClassNames)}>
					<MyTabsList
						className={cn("FileEditorSidebar-tabs-list" satisfies FileEditorSidebar_ClassNames)}
						aria-label="Sidebar tabs"
					>
						{isPlainTextFile ? (
							<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS}>Details</MyTabsTab>
						) : (
							<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}>Comments</MyTabsTab>
						)}
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}>Agent</MyTabsTab>
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING}>
							Pending changes
							<FileEditorSidebarPendingTabBadge />
						</MyTabsTab>
					</MyTabsList>
				</div>
				<MyTabsPanels className={cn("FileEditorSidebar-tabs-panels" satisfies FileEditorSidebar_ClassNames)}>
					{isPlainTextFile ? (
						<MyTabsPanel
							className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
							tabId={FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS}
						>
							<FileEditorSidebarDetails
								// Re-query the asset and authors when another file opens.
								key={node._id}
								node={node}
							/>
						</MyTabsPanel>
					) : (
						<MyTabsPanel
							className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
							tabId={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}
						>
							<div
								ref={commentsContainerRef}
								className={cn("FileEditorSidebar-comments-host" satisfies FileEditorSidebar_ClassNames)}
							></div>
						</MyTabsPanel>
					)}
					<MyTabsPanel
						className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
						tabId={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}
					>
						<FileEditorSidebarAgent rootTabId={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT} />
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
						tabId={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING}
					>
						<FileEditorSidebarPending />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
});
// #endregion root
