import "./page-editor-sidebar.css";
import type { Ref } from "react";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { useAppLocalStorageState } from "@/lib/app-local-storage-state.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import { PageEditorRichTextSidebarAgent } from "../page-editor-rich-text/page-editor-rich-text-sidebar-agent.tsx";

// #region root
export type PageEditorSidebar_ClassNames =
	| "PageEditorRichTextSidebar"
	| "PageEditorRichTextSidebar-background"
	| "PageEditorRichTextSidebar-toolbar"
	| "PageEditorRichTextSidebar-toolbar-scrollable-area"
	| "PageEditorRichTextSidebar-tabs-list"
	| "PageEditorRichTextSidebar-tabs-panels"
	| "PageEditorRichTextSidebar-panel"
	| "PageEditorRichTextSidebar-panel-empty"
	| "PageEditorRichTextSidebar-comments-host";

export type PageEditorSidebar_Props = {
	commentsContainerRef: Ref<HTMLDivElement>;
};

export function PageEditorSidebar(props: PageEditorSidebar_Props) {
	const { commentsContainerRef } = props;

	const pagesLastTab =
		useAppLocalStorageState((state) => state.pages_last_tab) ??
		("app_page_editor_sidebar_tabs_comments" satisfies AppElementId);
	const selectedTabId = pagesLastTab ?? ("app_page_editor_sidebar_tabs_comments" satisfies AppElementId);

	const handleTabChange = (nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === pagesLastTab) {
			return;
		}

		useAppLocalStorageState.setState({ pages_last_tab: nextSelectedId as AppElementId });
	};

	return (
		<>
			<div className={cn("PageEditorRichTextSidebar-background" satisfies PageEditorSidebar_ClassNames)}></div>
			<MyTabs selectedId={selectedTabId} setSelectedId={handleTabChange}>
				<div className={cn("PageEditorRichTextSidebar-toolbar" satisfies PageEditorSidebar_ClassNames)}>
					<div
						className={cn("PageEditorRichTextSidebar-toolbar-scrollable-area" satisfies PageEditorSidebar_ClassNames)}
					>
						<MyTabsList
							className={cn("PageEditorRichTextSidebar-tabs-list" satisfies PageEditorSidebar_ClassNames)}
							aria-label="Sidebar tabs"
						>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_comments" satisfies AppElementId}>Comments</MyTabsTab>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_agent" satisfies AppElementId}>Agent</MyTabsTab>
						</MyTabsList>
					</div>
				</div>
				<MyTabsPanels className={cn("PageEditorRichTextSidebar-tabs-panels" satisfies PageEditorSidebar_ClassNames)}>
					<MyTabsPanel
						className={cn("PageEditorRichTextSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_comments" satisfies AppElementId}
					>
						<div
							ref={commentsContainerRef}
							className={cn("PageEditorRichTextSidebar-comments-host" satisfies PageEditorSidebar_ClassNames)}
						></div>
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("PageEditorRichTextSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_agent" satisfies AppElementId}
					>
						<PageEditorRichTextSidebarAgent />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
}
// #endregion root
