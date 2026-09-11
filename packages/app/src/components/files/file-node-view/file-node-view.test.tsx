import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";

import type { FileEditor_Props, FileEditorPresenceSupplier_Props } from "../file-editor/file-editor.tsx";
import type { FileHtmlPreview } from "./file-html-preview.tsx";

const {
	tenantContextMock,
	queryMock,
	queryPushListeners,
	editorRenderMock,
	editorMountMock,
	editorUnmountMock,
	pluginUnmountMock,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	queryMock: vi.fn(),
	queryPushListeners: new Set<() => void>(),
	editorRenderMock: vi.fn<(props: FileEditor_Props) => void>(),
	editorMountMock: vi.fn(),
	editorUnmountMock: vi.fn(),
	pluginUnmountMock: vi.fn(),
}));

// Push query changes into memoized children, as the live Convex subscriptions do.
vi.mock("convex/react", async () => {
	const { useEffect, useState } = await import("react");
	return {
		useConvex: () => ({}),
		useQueries: () => ({}),
		useQuery: (...args: unknown[]) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			return queryMock(...args);
		},
	};
});
vi.mock("@/lib/app-convex-client.ts", async () => {
	const { api } = await import("../../../../convex/_generated/api.js");
	return { app_convex_api: api, app_convex: {} };
});
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => tenantContextMock() },
}));
vi.mock("@/lib/files-tree-context.tsx", async () => {
	const { useQuery } = await import("convex/react");
	const { api } = await import("../../../../convex/_generated/api.js");
	return {
		FilesTreeProvider: {
			useContext: () =>
				useQuery(api.files_nodes.list_tree, {
					membershipId: tenantContextMock().membershipId,
					paginationOpts: { numItems: 500, cursor: null },
				}),
		},
	};
});
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/components/app-hotkeys.tsx", () => ({ AppHotkeysProvider: { useHotkey: () => {} } }));
vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

// Monaco and the preview frame have separate tests. A local draft makes remounts visible here.
vi.mock("../file-editor/file-editor.tsx", async () => {
	const { useEffect, useImperativeHandle, useState } = await import("react");
	const { createPortal } = await import("react-dom");
	return {
		FileEditor: function FileEditor(props: FileEditor_Props) {
			editorRenderMock(props);
			const [text, setText] = useState("saved HTML");
			useEffect(() => {
				editorMountMock();
				return () => editorUnmountMock();
			}, []);
			useImperativeHandle(props.ref, () => ({
				getMode: () => props.editorMode,
				getPreviewSnapshot: () =>
					props.nodeId
						? {
								text,
								sourceKind: "editor_draft",
								isDirty: text !== "saved HTML",
								membershipId: tenantContextMock().membershipId,
								nodeId: props.nodeId,
								rootKind: props.rootKind,
								yjsLastSequenceId: null,
								pendingUpdate: null,
							}
						: null,
			}));
			return (
				<div data-testid="editor" data-active={props.isActive} data-mode={props.editorMode}>
					<textarea aria-label="Code draft" value={text} onChange={(event) => setText(event.target.value)} />
					{createPortal(<button>Save draft</button>, props.toolbarPortalHost)}
				</div>
			);
		},
		FileEditorPresenceSupplier: (props: FileEditorPresenceSupplier_Props) =>
			props.children({ presenceStore: null, onlineUsers: [] }),
		FileEditorPendingUpdatesFloating: (props: { showReviewButton: boolean; onReviewChanges: () => void }) =>
			props.showReviewButton ? <button onClick={props.onReviewChanges}>Review changes</button> : null,
	};
});
vi.mock("./file-html-preview.tsx", () => ({
	FileHtmlPreview: (props: ComponentProps<typeof FileHtmlPreview>) => (
		<div data-testid="html-preview">{props.getEditorSnapshot()?.text}</div>
	),
}));
vi.mock("@/components/plugins-ui-frame.tsx", async () => {
	const { useEffect } = await import("react");
	return {
		PluginsUiFrame: () => {
			useEffect(() => () => pluginUnmountMock(), []);
			return <div data-testid="plugin-frame" />;
		},
	};
});

// These sibling surfaces own their own subscriptions and browser integrations.
vi.mock("../files-sidebar.tsx", () => ({ FilesSidebar: () => null }));
vi.mock("../file-editor/file-editor-sidebar/file-editor-sidebar.tsx", () => ({ FileEditorSidebar: () => null }));
vi.mock("../file-editor/file-editor-presence.tsx", () => ({ FileEditorPresence: () => null }));
vi.mock("../files-sidebar-toggle.tsx", () => ({ FilesSidebarToggle: () => null }));
vi.mock("../files-share-modal.tsx", () => ({ FilesShareModal: () => null }));
vi.mock("../files-properties-modal.tsx", () => ({ FilesPropertiesModal: () => null }));
vi.mock("@/components/main-app-header-billing-indicator.tsx", () => ({ MainAppHeaderBillingIndicator: () => null }));
vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({ MainAppSidebarToggle: () => null }));
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: (props: { children?: ReactNode; "aria-label"?: string }) => (
		<a href="#" aria-label={props["aria-label"]}>
			{props.children}
		</a>
	),
	MyLinkIcon: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

import { FileNodeView, type FileNodeView_SearchParams } from "./file-node-view.tsx";

const NODE = {
	_id: "node_html",
	_creationTime: 1,
	parentId: "root",
	name: "page.html",
	path: "/page.html",
	kind: "file",
	contentType: "text/html",
	assetId: "asset_1",
	textKind: "plain_text",
	collaborationEnabled: false,
	yjsSnapshotId: null,
	yjsLastSequenceId: null,
	archiveOperationId: null,
	restrictedScopeNodeId: null,
	canWrite: true,
	writeBlockedReason: null,
	writePolicyState: "none",
};
const PLUGIN = {
	pluginName: "file-viewer",
	pluginVersionId: "plugin_version_1",
	installationCreatedAt: 1,
	fileViews: [
		{ id: "file", title: "File viewer", contentTypes: ["text/html", "application/json"], entry: "index.html" },
	],
};

let node = NODE;
let plugins: (typeof PLUGIN)[] | undefined;
let pendingUpdates: unknown[];
let header: HTMLDivElement;

function pushQueryChanges() {
	act(() => queryPushListeners.forEach((listener) => listener()));
}

beforeEach(() => {
	node = NODE;
	plugins = undefined;
	pendingUpdates = [];
	tenantContextMock.mockReturnValue({
		membershipId: "membership_1",
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		organizationName: "team",
		workspaceName: "home",
	});
	queryMock.mockImplementation((reference: never, args: unknown) => {
		if (args === "skip") return undefined;
		switch (getFunctionName(reference)) {
			case "files_nodes:list_tree":
				return [node];
			case "files_nodes:get_file_node_for_membership":
				return node;
			case "files_pending_updates:list_files_pending_updates":
				return pendingUpdates;
			case "plugins_ui:list_file_views":
				return plugins;
			case "r2:get_asset_by_file_node_id":
				return null;
			default:
				return true;
		}
	});
	editorMountMock.mockClear();
	editorRenderMock.mockClear();
	editorUnmountMock.mockClear();
	pluginUnmountMock.mockClear();
	vi.mocked(toast.info).mockClear();
	localStorage.clear();
	header = document.createElement("div");
	header.id = "app_main_header_content";
	document.body.append(header);
});

afterEach(() => {
	cleanup();
	header.remove();
});

function renderFileView(searchParams: FileNodeView_SearchParams = { nodeId: NODE._id }) {
	const onNavigateSearch = vi.fn();
	return {
		...render(<FileNodeView searchParams={searchParams} onNavigateSearch={onNavigateSearch} />),
		onNavigateSearch,
	};
}

describe("FileNodeView file views", () => {
	test("Preview keeps the editor draft mounted and hides its controls", async () => {
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "<h1>Local draft</h1>" } });
		expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
		expect(screen.getByText("Code")).toBeTruthy();
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		expect(await screen.findByTestId("html-preview")).toHaveProperty("textContent", "<h1>Local draft</h1>");
		// The preview can mount before Ariakit finishes hiding the editor panel.
		await waitFor(() => {
			expect(editor.closest('[role="tabpanel"]')).toHaveProperty("hidden", true);
			expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
		});
		expect(screen.getByRole("button", { name: "Download page.html" })).toBeTruthy();
		expect(screen.queryByText("Code")).toBeNull();
		expect(screen.getByTestId("editor").getAttribute("data-active")).toBe("false");
		fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
		expect(await screen.findByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect((editor as HTMLTextAreaElement).value).toBe("<h1>Local draft</h1>");
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		expect(editorUnmountMock).not.toHaveBeenCalled();
	});

	test("loading plugin tabs keeps the editor draft and removing the active plugin returns to Editor", async () => {
		node = { ...NODE, name: "data.json", contentType: "application/json" };
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(screen.queryByRole("tablist", { name: "File views" })).toBeNull();
		fireEvent.change(editor, { target: { value: '{"local":true}' } });
		plugins = [PLUGIN];
		pushQueryChanges();
		fireEvent.click(await screen.findByRole("tab", { name: "File viewer" }));
		expect(await screen.findByTestId("plugin-frame")).toBeTruthy();
		plugins = [];
		pushQueryChanges();
		expect(await screen.findByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect((editor as HTMLTextAreaElement).value).toBe('{"local":true}');
		expect(screen.getByTestId("editor").getAttribute("data-active")).toBe("true");
		expect(pluginUnmountMock).toHaveBeenCalledTimes(1);
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		expect(toast.info).toHaveBeenCalledWith("This file view is no longer available. Showing the editor.");
	});

	test("Review opens Editor even when the URL already selects Diff", async () => {
		pendingUpdates = [
			{
				_id: "pending_1",
				fileNodeId: NODE._id,
				baseAssetId: "asset_1",
				baseStateId: "base_1",
				stagedStateId: "staged_1",
				unstagedStateId: "unstaged_1",
			},
		];
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, view: "diff_editor", q: "page" });
		await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
		expect(await screen.findByRole("textbox", { name: "Code draft" })).toBeTruthy();
		expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: NODE._id, view: "diff_editor", q: "page" }, undefined);
	});

	test("an automatic Diff exit keeps Preview selected", async () => {
		const { rerender, onNavigateSearch } = renderFileView({ nodeId: NODE._id, view: "diff_editor" });
		await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		await screen.findByTestId("html-preview");
		const editorProps = editorRenderMock.mock.calls.at(-1)![0];
		act(() => editorProps.onAutomaticEditorModeChange?.("plain_text_editor", { replace: true }));
		expect(onNavigateSearch).toHaveBeenCalledWith(
			{ nodeId: NODE._id, view: "plain_text_editor", q: undefined },
			{ replace: true },
		);
		rerender(
			<FileNodeView
				searchParams={{ nodeId: NODE._id, view: "plain_text_editor" }}
				onNavigateSearch={onNavigateSearch}
			/>,
		);
		expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull());
	});

	test.each(["node", "membership"])("changing the %s starts in Editor with a new draft", async (scope) => {
		const { rerender, onNavigateSearch } = renderFileView();
		const oldEditor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(oldEditor, { target: { value: "old scope draft" } });
		fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
		if (scope === "node") node = { ...NODE, _id: "node_next", name: "next.html" };
		else tenantContextMock.mockReturnValue({ ...tenantContextMock(), membershipId: "membership_2" });
		rerender(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={onNavigateSearch} />);
		const nextEditor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(nextEditor).not.toBe(oldEditor);
		expect((nextEditor as HTMLTextAreaElement).value).toBe("saved HTML");
		expect(screen.getByRole("tab", { name: "Editor" }).getAttribute("aria-selected")).toBe("true");
		await waitFor(() => expect(screen.queryByTestId("html-preview")).toBeNull());
	});
});
