import "./file-editor-sidebar.css";
import { memo, type Ref } from "react";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { FileEditorSidebarPending } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx";
import {
	FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
	FileEditorSidebarPendingTabBadge,
} from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

const FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS = "app_file_editor_sidebar_tabs_comments" satisfies AppElementId;
const FILE_EDITOR_SIDEBAR_TAB_ID_AGENT = "app_file_editor_sidebar_tabs_agent" satisfies AppElementId;

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
	commentsContainerRef: Ref<HTMLDivElement>;
};

export const FileEditorSidebar = memo(function FileEditorSidebar(props: FileEditorSidebar_Props) {
	const { commentsContainerRef } = props;

	const [storedFilesLastTab, setStoredFilesLastTab] = useAppLocalStorageStateValue("app_state::files_last_tab");
	const filesLastTab = storedFilesLastTab ?? FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS;

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
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}>Comments</MyTabsTab>
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}>Agent</MyTabsTab>
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING}>
							Pending changes
							<FileEditorSidebarPendingTabBadge />
						</MyTabsTab>
					</MyTabsList>
				</div>
				<MyTabsPanels className={cn("FileEditorSidebar-tabs-panels" satisfies FileEditorSidebar_ClassNames)}>
					<MyTabsPanel
						className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
						tabId={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}
					>
						<div
							ref={commentsContainerRef}
							className={cn("FileEditorSidebar-comments-host" satisfies FileEditorSidebar_ClassNames)}
						></div>
					</MyTabsPanel>
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
