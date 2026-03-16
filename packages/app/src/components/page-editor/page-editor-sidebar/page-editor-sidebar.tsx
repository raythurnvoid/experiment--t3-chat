import "./page-editor-sidebar.css";
import { memo, type Ref } from "react";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { PageEditorSidebarAgent } from "@/components/page-editor/page-editor-sidebar/page-editor-sidebar-agent.tsx";
import { useAppLocalStorageState } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

const PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS = "app_page_editor_sidebar_tabs_comments" satisfies AppElementId;
const PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT = "app_page_editor_sidebar_tabs_agent" satisfies AppElementId;

// #region root
export type PageEditorSidebar_ClassNames =
	| "PageEditorSidebar"
	| "PageEditorSidebar-toolbar"
	| "PageEditorSidebar-toolbar-scrollable-area"
	| "PageEditorSidebar-tabs-list"
	| "PageEditorSidebar-tabs-panels"
	| "PageEditorSidebar-panel"
	| "PageEditorSidebar-panel-empty"
	| "PageEditorSidebar-comments-host";

export type PageEditorSidebar_Props = {
	commentsContainerRef: Ref<HTMLDivElement>;
};

export const PageEditorSidebar = memo(function PageEditorSidebar(props: PageEditorSidebar_Props) {
	const { commentsContainerRef } = props;

	const pagesLastTab = useAppLocalStorageState((state) => state.pages_last_tab) ?? PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS;

	const handleTabChange = (nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === pagesLastTab) {
			return;
		}

		useAppLocalStorageState.setState({ pages_last_tab: nextSelectedId as AppElementId });
	};

	return (
		<>
			<MyTabs selectedId={pagesLastTab} setSelectedId={handleTabChange}>
				<div className={cn("PageEditorSidebar-toolbar" satisfies PageEditorSidebar_ClassNames)}>
					<div className={cn("PageEditorSidebar-toolbar-scrollable-area" satisfies PageEditorSidebar_ClassNames)}>
						<MyTabsList
							className={cn("PageEditorSidebar-tabs-list" satisfies PageEditorSidebar_ClassNames)}
							aria-label="Sidebar tabs"
						>
							<MyTabsTab id={PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}>Comments</MyTabsTab>
							<MyTabsTab id={PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT}>Agent</MyTabsTab>
						</MyTabsList>
					</div>
				</div>
				<MyTabsPanels className={cn("PageEditorSidebar-tabs-panels" satisfies PageEditorSidebar_ClassNames)}>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}
					>
						<div
							ref={commentsContainerRef}
							className={cn("PageEditorSidebar-comments-host" satisfies PageEditorSidebar_ClassNames)}
						></div>
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT}
					>
						<PageEditorSidebarAgent rootTabId={PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT} />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
});
// #endregion root
