import "@/app.css";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FilesClipboardProvider } from "../files-clipboard.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

// An open draft folder whose loaded pages hold no row yet, so only Show more is there.
const { VIEW, children } = vi.hoisted(() => {
	const scope = { organizationId: "organization_1", workspaceId: "workspace_1", userId: "user_1" };
	return {
		VIEW: {
			entry: {
				kind: "private",
				node: {
					_id: "private_1",
					_creationTime: 1,
					...scope,
					kind: "folder",
					name: "Draft folder",
					parent: { kind: "root" },
					structuralRevision: 1,
					creationGeneration: 1,
					state: "active",
					closedAt: null,
				},
				pendingUpdate: {
					_id: "pending_private",
					_creationTime: 1,
					...scope,
					size: 0,
					updatedAt: 1,
					expiresAt: 1,
					target: { kind: "private", id: "private_1" },
					revision: 3,
					createIntent: { kind: "folder", metadata: [] },
				},
				path: "/Draft folder",
			},
			readiness: "ready",
			canEdit: true,
			canAccept: true,
			canAcceptWithParents: true,
			requiredParents: [],
			savedParentId: null,
		},
		children: {
			status: "CanLoadMore" as "CanLoadMore" | "LoadingMore",
			loadMore: vi.fn(),
			listeners: new Set<() => void>(),
		},
	};
});

vi.mock("convex/react", async (importOriginal) => {
	const { getFunctionName } = await import("convex/server");
	const { useEffect, useState } = await import("react");
	const answer = (reference: never) => {
		switch (getFunctionName(reference)) {
			case "files_pending_updates:get_file_pending_target":
				return VIEW;
			case "files_visible:get_path":
				return VIEW.entry.path;
			case "files_transfer:list_current":
			case "plugins_ui:list_file_views":
				return [];
			case "files_pending_updates:get_file_pending_update":
			case "files_nodes:get_folder_readme":
			case "files_transfer:get":
			case "files_pending_update_runs:get":
			case "r2:get_asset_by_file_node_id":
			case "files_browser:current_browser_session":
				return null;
			default:
				return true;
		}
	};
	return {
		// The browser runner checks every named import, so keep the exports this test does not use.
		...(await importOriginal<typeof import("convex/react")>()),
		useConvex: () => ({ mutation: async () => ({ _yay: null }), action: async () => ({ _yay: null }) }),
		usePaginatedQuery: () => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				children.listeners.add(listener);
				return () => {
					children.listeners.delete(listener);
				};
			}, []);
			return { results: [], status: children.status, loadMore: children.loadMore };
		},
		useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
			Object.fromEntries(
				Object.entries(queries).map(([key, request]) => [
					key,
					request.args === "skip" ? undefined : answer(request.query),
				]),
			),
		useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : answer(reference)),
	};
});
vi.mock("@/lib/app-convex-client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-convex-client.ts")>()),
	app_convex: { mutation: async () => ({ _yay: null }), action: async () => ({ _yay: null }) },
}));
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({
			membershipId: "membership_1",
			organizationId: "organization_1",
			workspaceId: "workspace_1",
			organizationName: "team",
			workspaceName: "home",
		}),
	},
}));
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: {
		useFolders: () => ({ rows: [], statusByFolderId: new Map(), hoistedIds: new Set(), loadMore: () => {} }),
	},
}));
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/components/app-hotkeys.tsx", () => ({ AppHotkeysProvider: { useHotkey: () => {} } }));
vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));

// Only the draft folder is under test. The editor and the sibling surfaces stay out of the bundle.
vi.mock("../file-editor/file-editor.tsx", () => ({
	FileEditor: () => null,
	FileEditorPresenceSupplier: () => null,
	FileEditorPendingUpdatesFloating: () => null,
}));
vi.mock("./file-html-preview.tsx", () => ({ FileHtmlPreview: () => null }));
vi.mock("@/components/plugins-ui-frame.tsx", () => ({ PluginsUiFrame: () => null }));
vi.mock("../files-sidebar.tsx", () => ({ FilesSidebar: () => null }));
vi.mock("../file-editor/file-editor-sidebar/file-editor-sidebar.tsx", () => ({ FileEditorSidebar: () => null }));
vi.mock("../file-editor/file-editor-presence.tsx", () => ({ FileEditorPresence: () => null }));
vi.mock("../files-sidebar-toggle.tsx", () => ({ FilesSidebarToggle: () => null }));
vi.mock("../files-share-modal.tsx", () => ({ FilesShareModal: () => null }));
vi.mock("../files-properties-modal.tsx", () => ({ FilesPropertiesModal: () => null }));
vi.mock("@/components/main-app-header-billing-indicator.tsx", () => ({ MainAppHeaderBillingIndicator: () => null }));
vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({ MainAppSidebarToggle: () => null }));

import { FileNodeView } from "./file-node-view.tsx";

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

describe("FileNodeView draft folder", () => {
	afterEach(() => {
		cleanup();
		children.status = "CanLoadMore";
		children.loadMore.mockReset();
	});

	test("Show more keeps focus while its page loads", async () => {
		const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
		render(
			<RouterContextProvider router={router}>
				<AppActivitiesProvider membershipId={MEMBERSHIP_ID}>
					<FilesClipboardProvider membershipId={MEMBERSHIP_ID}>
						<FileNodeView searchParams={{ pendingNodeId: VIEW.entry.node._id }} onNavigateSearch={() => {}} />
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			</RouterContextProvider>,
		);
		const showMore = await screen.findByRole("button", { name: "Show more" });

		showMore.focus();
		showMore.click();
		expect(children.loadMore).toHaveBeenCalledWith(50);
		act(() => {
			children.status = "LoadingMore";
			for (const listener of children.listeners) listener();
		});

		// A real `disabled` button loses focus at the next rendering step, and a keyboard user is thrown
		// out of the view. So wait two frames before the check.
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(document.activeElement, "focus stays on Show more while its page loads").toBe(showMore);
		expect(showMore.getAttribute("aria-busy")).toBe("true");
		showMore.click();
		expect(children.loadMore, "a click while the page loads asks for nothing more").toHaveBeenCalledTimes(1);
	});
});
