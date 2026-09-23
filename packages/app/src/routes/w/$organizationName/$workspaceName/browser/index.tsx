import "./index.css";

import { WebBrowser } from "@/components/browser/web-browser.tsx";
import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { memo } from "react";

type RouteWebBrowser_ClassNames = "RouteWebBrowser" | "RouteWebBrowser-panel" | "RouteWebBrowser-agent";

/**
 * The cloud web browser page: the browser on the left and the agent chat on the right. The agent
 * panel shares its chat tabs with the Files agent panel, and its requests bind the web browser.
 */
const RouteWebBrowser = memo(function RouteWebBrowser() {
	return (
		<main className={"RouteWebBrowser" satisfies RouteWebBrowser_ClassNames}>
			<MyPanelGroup direction="horizontal">
				<MyPanel id="route-web-browser-browser" order={1} defaultSize={70} minSize={40}>
					<div className={"RouteWebBrowser-panel" satisfies RouteWebBrowser_ClassNames}>
						<WebBrowser />
					</div>
				</MyPanel>
				<MyPanelResizeHandle aria-label="Resize browser and agent panel" />
				<MyPanel id="route-web-browser-agent" order={2} defaultSize={30} minSize={20}>
					<section className={"RouteWebBrowser-agent" satisfies RouteWebBrowser_ClassNames} aria-label="Agent">
						<FileEditorSidebarAgent isActive browserBinding={{ mode: "web" }} />
					</section>
				</MyPanel>
			</MyPanelGroup>
		</main>
	);
});

const Route = createFileRoute("/w/$organizationName/$workspaceName/browser/")({
	component: RouteWebBrowser,
});

export { Route };
