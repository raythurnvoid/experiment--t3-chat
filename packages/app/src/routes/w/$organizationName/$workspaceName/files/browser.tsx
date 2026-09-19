import "./browser.css";

import { FilesBrowser } from "@/components/files/file-node-view/files-browser.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useQuery } from "convex/react";
import { memo } from "react";
import { z } from "zod";

// #region root
type RouteBrowser_ClassNames = "RouteBrowser" | "RouteBrowser-message";

/**
 * Same-origin popout window for one live shared browser. Mounts the shared viewer only: it
 * never owns file navigation and never starts another cloud browser. The session id in the URL
 * binds the window to its session; anything else shows the ended card.
 */
const RouteBrowser = memo(function RouteBrowser() {
	const search = Route.useSearch();
	const { membershipId } = AppTenantProvider.useContext();
	const session = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });

	if (session === undefined) {
		return (
			<div className={"RouteBrowser" satisfies RouteBrowser_ClassNames}>
				<p
					className={"RouteBrowser-message" satisfies RouteBrowser_ClassNames}
					role="status"
					aria-live="polite"
				>
					Loading…
				</p>
			</div>
		);
	}

	if (!session || session.sessionId !== search.session) {
		return (
			<div className={"RouteBrowser" satisfies RouteBrowser_ClassNames}>
				<p
					className={"RouteBrowser-message" satisfies RouteBrowser_ClassNames}
					role="status"
					tabIndex={-1}
					autoFocus
				>
					This browser session ended. Close this window and start again from Files.
				</p>
			</div>
		);
	}

	return (
		<div className={"RouteBrowser" satisfies RouteBrowser_ClassNames}>
			<FilesBrowser
				targetKind={session.targetKind}
				nodeId={session.nodeId}
				path={session.path}
				host="detached"
				editorRevision={0}
				serverSequence={null}
				getDraftText={null}
				getDraftRevision={null}
				focusActive={false}
				onToggleFocus={null}
				onHide={null}
			/>
		</div>
	);
});

const Route = createFileRoute("/w/$organizationName/$workspaceName/files/browser")({
	component: RouteBrowser,
	validateSearch: zodValidator(
		z.object({
			session: z.string().catch(""),
		}),
	),
});

export { Route };
// #endregion root
