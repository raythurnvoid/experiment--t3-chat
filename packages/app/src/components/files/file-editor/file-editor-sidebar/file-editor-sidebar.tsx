import "./file-editor-sidebar.css";
import { memo, useState, type Ref } from "react";
import { useQuery } from "convex/react";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { FileEditorSidebarDetails } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-details.tsx";
import { FileEditorSidebarPending } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx";
import { FileEditorCommentsSidebar } from "../file-editor-comments-sidebar.tsx";
import {
	FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
	FileEditorSidebarPendingTabBadge,
} from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_node_has_editable_text_content, files_node_has_editable_yjs_state } from "@/lib/files.ts";
import { cn } from "@/lib/utils.ts";
import { useGlobalCustomEvent } from "@/lib/global-event.tsx";
import type { file_quotes_Quote } from "../../../../../shared/file-quotes.ts";

const FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS = "app_file_editor_sidebar_tabs_comments" satisfies AppElementId;
const FILE_EDITOR_SIDEBAR_TAB_ID_AGENT = "app_file_editor_sidebar_tabs_agent" satisfies AppElementId;
const FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS = "app_file_editor_sidebar_tabs_details" satisfies AppElementId;

function FileEditorSidebarCommentsBadge(props: { fileNodeId: app_convex_Id<"files_nodes"> }) {
	const { membershipId } = AppTenantProvider.useContext();
	const channelId = useQuery(app_convex_api.channels.get_file_channel, { membershipId, fileNodeId: props.fileNodeId });
	const state = useQuery(app_convex_api.channels.get_channel_state, channelId ? { membershipId, channelId } : "skip");
	return state?.unread ? <span aria-label="Unread comments">●</span> : null;
}

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
	node: Omit<
		app_convex_Doc<"files_nodes">,
		"writePolicy" | "newChildWritePolicy" | "sortName" | "isRestrictedScopeRoot"
	> | null;
	isPrivate?: boolean;
	commentsContainerRef: Ref<HTMLDivElement>;
};

export const FileEditorSidebar = memo(function FileEditorSidebar(props: FileEditorSidebar_Props) {
	const { node, isPrivate = false, commentsContainerRef } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [quoteRequest, setQuoteRequest] = useState<file_quotes_Quote | null>(null);

	const [storedFilesLastTab, setStoredFilesLastTab] = useAppLocalStorageStateValue("app_state::files_last_tab");
	useGlobalCustomEvent("files::quote_selection", ({ detail }) => {
		if (detail.membershipId !== membershipId || detail.quote.fileNodeId !== node?._id || isPrivate) return;
		setStoredFilesLastTab(
			detail.target === "agent" ? FILE_EDITOR_SIDEBAR_TAB_ID_AGENT : FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS,
		);
		if (detail.target === "agent") setQuoteRequest(detail.quote);
	});

	// Every saved file has general comments. Editors add their anchored comments through the portal.
	const isEditableTextFile = node !== null && node.kind === "file" && files_node_has_editable_text_content(node);
	const hasCommentsTab = !isPrivate;
	const showsDetailsTab =
		isEditableTextFile && (node.textKind === "plain_text" || !files_node_has_editable_yjs_state(node));
	const availableTabIds: AppElementId[] = (
		[
			hasCommentsTab ? FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS : null,
			showsDetailsTab ? FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS : null,
			FILE_EDITOR_SIDEBAR_TAB_ID_AGENT,
			FILE_EDITOR_SIDEBAR_TAB_ID_PENDING,
		] satisfies (AppElementId | null)[]
	).filter((tabId) => tabId !== null);

	// If the selected tab is not available for this node, fall back to the first available one.
	// Keep the stored choice so another file restores the user's selected tab.
	const selectedTab =
		storedFilesLastTab ?? (isPrivate ? FILE_EDITOR_SIDEBAR_TAB_ID_PENDING : FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS);
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
						{hasCommentsTab ? (
							<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}>
								Comments{node?.kind === "file" && <FileEditorSidebarCommentsBadge fileNodeId={node._id} />}
							</MyTabsTab>
						) : null}
						{showsDetailsTab ? <MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_DETAILS}>Details</MyTabsTab> : null}
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}>Agent</MyTabsTab>
						<MyTabsTab id={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING}>
							Pending changes
							<FileEditorSidebarPendingTabBadge />
						</MyTabsTab>
					</MyTabsList>
				</div>
				<MyTabsPanels className={cn("FileEditorSidebar-tabs-panels" satisfies FileEditorSidebar_ClassNames)}>
					{hasCommentsTab ? (
						<MyTabsPanel
							className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
							tabId={FILE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}
						>
							<div
								ref={commentsContainerRef}
								className={cn("FileEditorSidebar-comments-host" satisfies FileEditorSidebar_ClassNames)}
							></div>
							{node?.kind === "file" && !isEditableTextFile && (
								<FileEditorCommentsSidebar key={node._id} fileNodeId={node._id} threadIds={[]} />
							)}
						</MyTabsPanel>
					) : null}
					{showsDetailsTab ? (
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
					) : null}
					<MyTabsPanel
						className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
						tabId={FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}
					>
						<FileEditorSidebarAgent
							isActive={filesLastTab === FILE_EDITOR_SIDEBAR_TAB_ID_AGENT}
							quoteRequest={quoteRequest}
							onQuoteInserted={() => setQuoteRequest(null)}
						/>
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("FileEditorSidebar-panel" satisfies FileEditorSidebar_ClassNames)}
						tabId={FILE_EDITOR_SIDEBAR_TAB_ID_PENDING}
						// The pending list reads every node of the workspace. Load it only while this tab is open.
						unmountOnHide
					>
						<FileEditorSidebarPending />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
});
// #endregion root
