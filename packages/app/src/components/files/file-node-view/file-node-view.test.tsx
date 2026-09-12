import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
		PluginsUiFrame: (props: { pluginName: string }) => {
			useEffect(() => () => pluginUnmountMock(), []);
			return <div data-testid="plugin-frame" data-plugin={props.pluginName} />;
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
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: (props: { children?: ReactNode; "aria-label"?: string }) => (
		<a href="#" aria-label={props["aria-label"]}>
			{props.children}
		</a>
	),
}));
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
	updatedAt: 1,
	parentId: "root",
	name: "page.html",
	path: "/page.html",
	kind: "file",
	contentType: "text/html",
	assetId: "asset_1",
	textKind: "plain_text" as string | null,
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
let treeNodes: (typeof NODE)[] | undefined;
let plugins: (typeof PLUGIN)[] | undefined;
let pendingUpdates: unknown[];
let header: HTMLDivElement;

function pushQueryChanges() {
	act(() => queryPushListeners.forEach((listener) => listener()));
}

beforeEach(() => {
	node = NODE;
	treeNodes = undefined;
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
				return treeNodes ?? [node];
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

async function openViewPicker() {
	fireEvent.click(await screen.findByRole("combobox", { name: /^View: / }));
	return await screen.findByRole<HTMLInputElement>("combobox", { name: "Search views" });
}

async function selectView(name: string) {
	await openViewPicker();
	fireEvent.click(await screen.findByRole("option", { name }));
	await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search views" })).toBeNull());
}

describe("FileNodeView file views", () => {
	test("the view picker searches plain option names", async () => {
		plugins = [PLUGIN];
		renderFileView();
		const trigger = await screen.findByRole("combobox", { name: "View: Code" });
		const search = await openViewPicker();
		const list = screen.getByRole("listbox", { name: "File views" });
		expect(screen.getByRole("dialog", { name: "File views" })).toBeTruthy();
		expect(
			within(list)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["Code", "Review changes", "Preview", "File details", "File viewer"]);
		expect(within(list).getByRole("option", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
		expect(trigger.querySelector("svg")).toBeNull();
		expect(search.closest(".MySearchSelectPopover")?.querySelector("svg")).toBeNull();
		expect(within(list).queryByText(PLUGIN.pluginName)).toBeNull();

		fireEvent.change(search, { target: { value: " preVIEW " } });
		expect(await screen.findByRole("option", { name: "Preview" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "Code" })).toBeNull();
		expect(trigger.textContent).toBe("View: Code");

		fireEvent.change(search, { target: { value: "missing view" } });
		expect(await screen.findByText("No views found")).toBeTruthy();
		expect(screen.queryAllByRole("option")).toHaveLength(0);

		fireEvent.change(search, { target: { value: "" } });
		expect(await screen.findAllByRole("option")).toHaveLength(5);
		expect(screen.queryByRole("radio", { name: "Code" })).toBeNull();
		expect(screen.queryByRole("tablist", { name: "File views" })).toBeNull();
	});

	test.each([
		{
			name: "rich text",
			node: { ...NODE, name: "notes.md", contentType: "text/markdown", textKind: "rich_text" },
			selected: "Rich text",
			options: ["Rich text", "Markdown", "Review changes", "File details"],
		},
		{
			name: "JSON",
			node: { ...NODE, name: "data.json", contentType: "application/json" },
			selected: "Code",
			options: ["Code", "Review changes", "File details"],
		},
		{
			name: "plain text renamed to Markdown",
			node: { ...NODE, name: "notes.md", contentType: "text/markdown" },
			selected: "Code",
			options: ["Code", "Review changes", "File details"],
		},
		{
			name: "HTML",
			node: NODE,
			selected: "Code",
			options: ["Code", "Review changes", "Preview", "File details"],
		},
		{
			name: "stored image",
			node: { ...NODE, name: "image.png", contentType: "image/png", textKind: null },
			selected: "File details",
			options: ["File details"],
		},
		{
			name: "stored file renamed to HTML",
			node: { ...NODE, contentType: "application/octet-stream", textKind: null },
			selected: "File details",
			options: ["File details"],
		},
	])("$name uses its stored shape and content type", async (fixture) => {
		node = fixture.node;
		renderFileView();
		expect(await screen.findByRole("combobox", { name: `View: ${fixture.selected}` })).toBeTruthy();
		await openViewPicker();
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(fixture.options);
	});

	test("search and arrow keys leave the view unchanged until Enter selects an option", async () => {
		plugins = [PLUGIN];
		const { onNavigateSearch } = renderFileView();
		const trigger = await screen.findByRole("combobox", { name: "View: Code" });
		act(() => trigger.focus());
		const search = await openViewPicker();
		await waitFor(() => expect(document.activeElement).toBe(search));

		fireEvent.change(search, { target: { value: "File" } });
		const viewer = await screen.findByRole("option", { name: "File viewer" });
		fireEvent.mouseMove(viewer);
		await waitFor(() => expect(search.getAttribute("aria-activedescendant")).toBe(viewer.id));

		fireEvent.keyDown(search, { key: "ArrowUp" });
		await waitFor(() => {
			expect(search.getAttribute("aria-activedescendant")).toBe(
				screen.getByRole("option", { name: "File details" }).id,
			);
		});

		fireEvent.keyDown(search, { key: "ArrowDown" });
		await waitFor(() => expect(search.getAttribute("aria-activedescendant")).toBe(viewer.id));
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
		expect(screen.queryByTestId("html-preview")).toBeNull();
		expect(trigger.textContent).toBe("View: Code");
		expect(onNavigateSearch).not.toHaveBeenCalled();

		fireEvent.keyDown(search, { key: "Escape" });
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));

		fireEvent.click(trigger);
		const reopenedSearch = await screen.findByRole<HTMLInputElement>("combobox", { name: "Search views" });
		expect(reopenedSearch.value).toBe("");
		expect(screen.getAllByRole("option")).toHaveLength(5);
		expect(screen.getByRole("option", { name: "Code" }).getAttribute("aria-selected")).toBe("true");

		fireEvent.change(reopenedSearch, { target: { value: "File viewer" } });
		await waitFor(() => {
			expect(reopenedSearch.getAttribute("aria-activedescendant")).toBe(
				screen.getByRole("option", { name: "File viewer" }).id,
			);
		});

		fireEvent.keyDown(reopenedSearch, { key: "Enter" });
		expect(await screen.findByTestId("plugin-frame")).toHaveProperty("dataset.plugin", PLUGIN.pluginName);
		await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search views" })).toBeNull());
		expect(trigger.textContent).toBe("View: File viewer");
	});

	test.each(["ArrowUp", "ArrowDown", "p"])("the closed trigger does not select a view on %s", async (key) => {
		plugins = [PLUGIN];
		const { onNavigateSearch } = renderFileView();
		const trigger = await screen.findByRole("combobox", { name: "View: Code" });
		const search = await openViewPicker();
		fireEvent.change(search, { target: { value: "File viewer" } });
		await screen.findByRole("option", { name: "File viewer" });
		fireEvent.keyDown(search, { key: "Escape" });
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));

		act(() => trigger.focus());
		fireEvent.keyDown(trigger, { key });
		await act(async () => {});
		expect(trigger.textContent).toBe("View: Code");
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
		expect(screen.queryByTestId("html-preview")).toBeNull();
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("duplicate view names remain separate choices and switching unmounts the old frame", async () => {
		plugins = [PLUGIN, { ...PLUGIN, pluginName: "second-viewer", pluginVersionId: "plugin_version_2" }];
		renderFileView();
		await openViewPicker();
		const viewers = screen.getAllByRole("option", { name: "File viewer" });
		expect(viewers).toHaveLength(2);

		fireEvent.click(viewers[0]);
		expect(await screen.findByTestId("plugin-frame")).toHaveProperty("dataset.plugin", "file-viewer");
		await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search views" })).toBeNull());

		await openViewPicker();
		const reopenedViewers = screen.getAllByRole("option", { name: "File viewer" });
		expect(reopenedViewers[0].getAttribute("aria-selected")).toBe("true");
		expect(reopenedViewers[1].getAttribute("aria-selected")).toBe("false");

		fireEvent.click(reopenedViewers[1]);
		await waitFor(() => expect(screen.getByTestId("plugin-frame")).toHaveProperty("dataset.plugin", "second-viewer"));
		expect(screen.getAllByTestId("plugin-frame")).toHaveLength(1);
		expect(pluginUnmountMock).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search views" })).toBeNull());

		await selectView("File details");
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
		expect(pluginUnmountMock).toHaveBeenCalledTimes(2);
	});

	test.each(["rich_text", "plain_text"])("a folder picker uses its %s README shape", async (textKind) => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		treeNodes = [
			node,
			{ ...NODE, _id: "readme_1", parentId: node._id, name: "README.md", contentType: "text/markdown", textKind },
		];
		plugins = [PLUGIN];
		renderFileView({ nodeId: node._id });
		await openViewPicker();
		expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(
			textKind === "rich_text" ? ["Rich text", "Markdown", "Review changes"] : ["Code", "Review changes"],
		);
		expect(screen.getByTestId("editor").getAttribute("data-mode")).toBe(
			textKind === "rich_text" ? "rich_text_editor" : "plain_text_editor",
		);
	});

	test.each(["missing", "stored"])("a folder with a %s README has no view picker", async (readme) => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		if (readme === "stored") {
			treeNodes = [
				node,
				{
					...NODE,
					_id: "readme_1",
					parentId: node._id,
					name: "README.md",
					contentType: "text/markdown",
					textKind: null,
				},
			];
		}

		renderFileView({ nodeId: node._id });
		expect(await screen.findByRole("button", { name: "New file" })).toBeTruthy();
		expect(screen.queryByRole("combobox", { name: /^View: / })).toBeNull();
	});

	test.each(["Preview", "File details"])("%s keeps the editor draft mounted and hides its controls", async (view) => {
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "<h1>Local draft</h1>" } });
		expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();

		await selectView(view);
		if (view === "Preview") {
			expect(await screen.findByTestId("html-preview")).toHaveProperty("textContent", "<h1>Local draft</h1>");
		} else {
			expect(await screen.findByRole("heading", { name: "page.html" })).toBeTruthy();
			expect(screen.getByText("text/html")).toBeTruthy();
		}
		await waitFor(() => {
			expect(screen.getByTestId("editor").closest("[hidden]")?.hasAttribute("inert")).toBe(true);
			expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
		});
		expect(screen.getByRole("button", { name: "Download page.html" })).toBeTruthy();
		expect(screen.getByRole("combobox", { name: `View: ${view}` })).toBeTruthy();
		expect(screen.getByTestId("editor").getAttribute("data-active")).toBe("false");

		await selectView("Code");
		const restoredEditor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(restoredEditor).toHaveProperty("value", "<h1>Local draft</h1>");
		expect(restoredEditor).toBe(editor);
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		expect(editorUnmountMock).not.toHaveBeenCalled();
	});

	test("loading plugin options keeps the draft and removing the active plugin returns to Code", async () => {
		node = { ...NODE, name: "data.json", contentType: "application/json" };
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(screen.getByRole("combobox", { name: "View: Code" })).toBeTruthy();
		fireEvent.change(editor, { target: { value: '{"local":true}' } });

		plugins = [PLUGIN];
		pushQueryChanges();
		await selectView("File viewer");
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

	test.each(["Preview", "File details", "File viewer"])(
		"Review returns from %s even when the URL already selects Diff",
		async (view) => {
			plugins = [PLUGIN];
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
			await selectView(view);
			fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
			expect(await screen.findByRole("textbox", { name: "Code draft" })).toBeTruthy();
			expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: NODE._id, view: "diff_editor", q: "page" }, undefined);
		},
	);

	test("the Review option leaves a plugin and keeps the sidebar search in navigation", async () => {
		plugins = [PLUGIN];
		const { rerender, onNavigateSearch } = renderFileView({ nodeId: NODE._id, q: "page" });
		await selectView("File viewer");

		await selectView("Review changes");
		expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: NODE._id, view: "diff_editor", q: "page" }, undefined);

		rerender(
			<FileNodeView
				searchParams={{ nodeId: NODE._id, view: "diff_editor", q: "page" }}
				onNavigateSearch={onNavigateSearch}
			/>,
		);
		expect(screen.getByRole("combobox", { name: "View: Review changes" })).toBeTruthy();
		expect(screen.getByTestId("editor").getAttribute("data-mode")).toBe("diff_editor");
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
		expect(pluginUnmountMock).toHaveBeenCalledTimes(1);
	});

	test("an automatic Diff exit keeps Preview selected", async () => {
		const { rerender, onNavigateSearch } = renderFileView({ nodeId: NODE._id, view: "diff_editor" });
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Preview");
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
		expect(screen.getByRole("combobox", { name: "View: Preview" })).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull());
	});

	test.each(["node", "membership"])("changing the %s starts in Code with a new draft", async (scope) => {
		const { rerender, onNavigateSearch } = renderFileView();
		const oldEditor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(oldEditor, { target: { value: "old scope draft" } });
		await selectView("Preview");

		if (scope === "node") node = { ...NODE, _id: "node_next", name: "next.html" };
		else tenantContextMock.mockReturnValue({ ...tenantContextMock(), membershipId: "membership_2" });
		rerender(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={onNavigateSearch} />);
		const nextEditor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(nextEditor).not.toBe(oldEditor);
		expect((nextEditor as HTMLTextAreaElement).value).toBe("saved HTML");
		expect(screen.getByRole("combobox", { name: "View: Code" })).toBeTruthy();
		await waitFor(() => expect(screen.queryByTestId("html-preview")).toBeNull());
	});
});
