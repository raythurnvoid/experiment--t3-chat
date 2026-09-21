import "@/app.css";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
	FileEditor_Props,
	FileEditorPendingUpdatesFloating_Props,
	FileEditorPresenceSupplier_Props,
} from "../file-editor/file-editor.tsx";
import { FilesClipboardProvider } from "../files-clipboard.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

// A deep path, so the 700px box cannot show every folder name in full.
const { FILE, NODES } = vi.hoisted(() => {
	const folderNames = ["Engineering", "Platform Team", "Quarterly Planning", "Infrastructure"];
	const folders = folderNames.map((name, index) => ({
		_id: `folder_${index}`,
		_creationTime: 1,
		updatedAt: 1,
		parentId: index === 0 ? "root" : `folder_${index - 1}`,
		name,
		path: `/${folderNames.slice(0, index + 1).join("/")}`,
		kind: "folder",
		contentType: null,
		assetId: null,
		textKind: null,
		collaborationEnabled: false,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		archiveOperationId: null,
		restrictedScopeNodeId: null,
		canWrite: true,
		writeBlockedReason: null,
		writePolicyState: "none",
	}));
	const file = {
		...folders[folders.length - 1]!,
		_id: "node_file",
		parentId: folders[folders.length - 1]!._id,
		name: "release-notes-final.md",
		path: `${folders[folders.length - 1]!.path}/release-notes-final.md`,
		kind: "file",
		contentType: "text/markdown",
		assetId: "asset_1",
		textKind: "plain_text",
	};
	return { FILE: file, NODES: [...folders, file] };
});

vi.mock("convex/react", async (importOriginal) => {
	const { getFunctionName } = await import("convex/server");
	const answer = (reference: never) => {
		switch (getFunctionName(reference)) {
			case "files_nodes:list_tree":
				return NODES;
			case "files_nodes:get_file_node_for_membership":
				return FILE;
			case "files_pending_updates:list_files_pending_updates":
			case "files_transfer:list_current":
			case "plugins_ui:list_file_views":
				return [];
			case "files_visible:get_path":
				return FILE.path;
			case "files_visible:list":
				return { _yay: { items: [], isDone: true, continueCursor: null } };
			case "files_pending_updates:get_file_pending_update":
			case "files_pending_updates:get_file_pending_target":
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
		usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }),
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
vi.mock("@/lib/files-tree-context.tsx", () => ({ FilesTreeProvider: { useContext: () => NODES } }));
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/components/app-hotkeys.tsx", () => ({ AppHotkeysProvider: { useHotkey: () => {} } }));
vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));

// Only the header is under test. The editor and the sibling surfaces stay out of the bundle.
vi.mock("../file-editor/file-editor.tsx", async () => {
	const { useImperativeHandle } = await import("react");
	return {
		FileEditor: function FileEditor(props: FileEditor_Props) {
			useImperativeHandle(props.ref, () => ({ getMode: () => props.editorMode, getPreviewSnapshot: () => null }));
			return <div data-testid="editor" />;
		},
		FileEditorPresenceSupplier: (props: FileEditorPresenceSupplier_Props) =>
			props.children({ presenceStore: null, onlineUsers: [] }),
		FileEditorPendingUpdatesFloating: (_props: FileEditorPendingUpdatesFloating_Props) => null,
	};
});
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

function renderHeader(width: number) {
	// The app's header slot is a flex row. The file view portals its header into it.
	const box = document.createElement("div");
	box.id = "app_main_header_content";
	box.style.display = "flex";
	box.style.width = `${width}px`;
	document.body.append(box);

	const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
	render(
		<RouterContextProvider router={router}>
			<AppActivitiesProvider membershipId={MEMBERSHIP_ID}>
				<FilesClipboardProvider membershipId={MEMBERSHIP_ID}>
					<FileNodeView searchParams={{ nodeId: FILE._id }} onNavigateSearch={() => {}} />
				</FilesClipboardProvider>
			</AppActivitiesProvider>
		</RouterContextProvider>,
	);
	return box;
}

function ancestorLinks(box: HTMLElement) {
	// The ancestors are their own list, nested in the breadcrumb list.
	const [, ancestors] = within(box).getAllByRole("list");
	return within(ancestors!).getAllByRole("link");
}

describe("FileNodeView header breadcrumb layout", () => {
	afterEach(() => {
		cleanup();
		document.getElementById("app_main_header_content")?.remove();
	});

	test("shortens the folder names to fit and grows them back", async () => {
		const box = renderHeader(700);
		const current = await within(box).findByRole("button", { name: FILE.name });

		// This is the check that fails when the ladder stops running: a shortened crumb shows `…`
		// while its `aria-label` keeps the whole name.
		await waitFor(() => {
			const shortened = ancestorLinks(box).filter(
				(link) => link.textContent!.endsWith("…") && link.textContent !== link.getAttribute("aria-label"),
			);
			expect(shortened.length).toBeGreaterThan(0);
		});
		expect(ancestorLinks(box)).toHaveLength(4);
		expect(current.textContent).toBe(FILE.name);
		expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);

		box.style.width = "1400px";
		await waitFor(() => {
			for (const link of ancestorLinks(box)) {
				expect(link.textContent).toBe(link.getAttribute("aria-label"));
			}
		});
		expect(current.textContent).toBe(FILE.name);
		expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
	});
});
