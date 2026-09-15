import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";

import type {
	FileEditor_Props,
	FileEditorPendingUpdatesFloating_Props,
	FileEditorPresenceSupplier_Props,
} from "../file-editor/file-editor.tsx";
import type { FileHtmlPreview } from "./file-html-preview.tsx";
import { FilesClipboardProvider } from "../files-clipboard.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_VisibleEntry } from "@/lib/files.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";

const {
	tenantContextMock,
	queryMock,
	mutationMock,
	actionMock,
	queryPushListeners,
	editorRenderMock,
	editorMountMock,
	editorUnmountMock,
	pluginUnmountMock,
	loadMorePendingMock,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	queryMock: vi.fn(),
	mutationMock: vi.fn(),
	actionMock: vi.fn(),
	queryPushListeners: new Set<() => void>(),
	editorRenderMock: vi.fn<(props: FileEditor_Props) => void>(),
	editorMountMock: vi.fn(),
	editorUnmountMock: vi.fn(),
	pluginUnmountMock: vi.fn(),
	loadMorePendingMock: vi.fn(),
}));

// Push query changes into memoized children, as the live Convex subscriptions do.
vi.mock("convex/react", async () => {
	const { useEffect, useState } = await import("react");
	return {
		useConvex: () => ({ mutation: mutationMock }),
		usePaginatedQuery: (query: never, args: unknown) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			return { results: queryMock(query, args), status: pendingListStatus, loadMore: loadMorePendingMock };
		},
		useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			return Object.fromEntries(
				Object.entries(queries).map(([key, request]) => [key, queryMock(request.query, request.args)]),
			);
		},
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
	return { app_convex_api: api, app_convex: { mutation: mutationMock, action: actionMock } };
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
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

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
					props.target
						? {
								text,
								sourceKind: "editor_draft",
								isDirty: text !== "saved HTML",
								membershipId: tenantContextMock().membershipId,
								target: props.target,
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
		FileEditorPendingUpdatesFloating: (props: FileEditorPendingUpdatesFloating_Props) => (
			<>
				{props.showReviewButton ? <button onClick={props.onReviewChanges}>Review changes</button> : null}
				{props.showLoadMore ? (
					<button disabled={props.isLoadingMore} onClick={props.onLoadMore}>
						Load more reviews
					</button>
				) : null}
			</>
		),
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
	archiveOperationId: null as string | null,
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

const PRIVATE_ENTRY = {
	kind: "private",
	node: {
		_id: "private_1" as app_convex_Id<"files_pending_nodes">,
		_creationTime: 1,
		organizationId: "organization_1" as app_convex_Id<"organizations">,
		workspaceId: "workspace_1" as app_convex_Id<"organizations_workspaces">,
		userId: "user_1" as app_convex_Id<"users">,
		kind: "file",
		name: "draft.html",
		parent: { kind: "root" },
		structuralRevision: 1,
		creationGeneration: 1,
		state: "active",
		closedAt: null,
	},
	pendingUpdate: {
		_id: "pending_private" as app_convex_Id<"files_pending_updates">,
		_creationTime: 1,
		organizationId: "organization_1" as app_convex_Id<"organizations">,
		workspaceId: "workspace_1" as app_convex_Id<"organizations_workspaces">,
		userId: "user_1" as app_convex_Id<"users">,
		size: 0,
		updatedAt: 1,
		target: { kind: "private", id: "private_1" as app_convex_Id<"files_pending_nodes"> },
		revision: 3,
		createIntent: {
			kind: "text",
			contentType: "text/html;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
			metadata: [],
		},
		content: {
			base: { kind: "new" },
			baseStateId: "private_base" as app_convex_Id<"files_pending_update_yjs_states">,
			stagedStateId: "private_staged" as app_convex_Id<"files_pending_update_yjs_states">,
			unstagedStateId: "private_unstaged" as app_convex_Id<"files_pending_update_yjs_states">,
		},
	},
	path: "/draft.html",
} as Extract<files_VisibleEntry, { kind: "private" }>;

let node = NODE;
let nodeQueryStatus: "loading" | "ready" | "missing";
let treeNodes: (typeof NODE)[] | undefined;
let plugins: (typeof PLUGIN)[] | undefined;
let pendingUpdates: unknown[];
let savedPendingUpdate: unknown;
let pendingListStatus: "CanLoadMore" | "LoadingMore" | "Exhausted";
let privateView:
	| { entry: typeof PRIVATE_ENTRY; readiness: "ready" | "preparing"; canEdit: boolean; canAccept: boolean }
	| null
	| undefined;
let pendingChildren: unknown[];
let header: HTMLDivElement;

function pushQueryChanges() {
	act(() => queryPushListeners.forEach((listener) => listener()));
}

beforeEach(() => {
	node = NODE;
	nodeQueryStatus = "ready";
	treeNodes = undefined;
	plugins = undefined;
	pendingUpdates = [];
	savedPendingUpdate = undefined;
	pendingListStatus = "Exhausted";
	loadMorePendingMock.mockReset();
	privateView = { entry: PRIVATE_ENTRY, readiness: "ready", canEdit: true, canAccept: true };
	pendingChildren = [];
	tenantContextMock.mockReturnValue({
		membershipId: "membership_1",
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		organizationName: "team",
		workspaceName: "home",
	});
	queryMock.mockReset();
	queryMock.mockImplementation((reference: never, args: unknown) => {
		if (args === "skip") return undefined;
		switch (getFunctionName(reference)) {
			case "files_nodes:list_tree":
				return treeNodes ?? [node];
			case "files_nodes:get_file_node_for_membership":
				return nodeQueryStatus === "loading" ? undefined : nodeQueryStatus === "missing" ? null : node;
			case "files_pending_updates:list_files_pending_updates":
				return pendingUpdates;
			case "files_pending_updates:get_file_pending_update": {
				if (savedPendingUpdate !== undefined) return savedPendingUpdate;
				const target = (args as { target: { kind: string; id: string } }).target;
				const views = pendingUpdates as Array<{
					kind: string;
					entry: { pendingUpdate: { target: { kind: string; id: string } } };
				}>;
				return (
					views.find(
						(view) =>
							view.kind === "entry" &&
							view.entry.pendingUpdate.target.kind === target.kind &&
							view.entry.pendingUpdate.target.id === target.id,
					)?.entry.pendingUpdate ?? null
				);
			}
			case "files_pending_updates:get_file_pending_target":
				return privateView;
			case "files_visible:get_path":
				return node.path;
			case "files_visible:list":
				return {
					_yay: {
						items:
							pendingChildren.length > 0
								? pendingChildren
								: (treeNodes ?? [])
										.filter((item) => item.parentId === node._id && item.archiveOperationId === null)
										.map((item) => ({
											target: { kind: "saved", id: item._id },
											name: item.name,
											kind: item.kind,
											path: item.path,
											updatedAt: item.updatedAt,
											updatedBy: "user_1",
											contentType: item.contentType,
											preparing: false,
										})),
						isDone: true,
						continueCursor: null,
					},
				};
			case "files_transfer:list_current":
				return [];
			case "files_transfer:get":
			case "files_pending_update_runs:get":
				return null;
			case "plugins_ui:list_file_views":
				return plugins;
			case "r2:get_asset_by_file_node_id":
				return null;
			default:
				return true;
		}
	});
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: { runId: "clipboard_run" } });
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: { target: { kind: "saved", id: NODE._id }, newSequence: null } });
	editorMountMock.mockClear();
	editorRenderMock.mockClear();
	editorUnmountMock.mockClear();
	pluginUnmountMock.mockClear();
	vi.mocked(toast.info).mockClear();
	vi.mocked(toast.error).mockClear();
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
		...render(<FileNodeView searchParams={searchParams} onNavigateSearch={onNavigateSearch} />, {
			wrapper: ({ children }) => (
				<AppActivitiesProvider key={tenantContextMock().membershipId} membershipId={tenantContextMock().membershipId}>
					<FilesClipboardProvider
						key={tenantContextMock().membershipId}
						membershipId={tenantContextMock().membershipId}
					>
						{children}
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			),
		}),
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

describe("FileNodeView node loading", () => {
	test.each([null, "archive_1"])(
		"keeps a loaded file draft when its query answers (archive: %s)",
		async (archiveOperationId) => {
			node = { ...NODE, archiveOperationId };
			treeNodes = [node];
			nodeQueryStatus = "loading";
			renderFileView();
			const editor = await screen.findByRole("textbox", { name: "Code draft" });
			fireEvent.change(editor, { target: { value: "Local draft" } });
			expect(
				queryMock.mock.calls.some(
					([reference, args]) =>
						getFunctionName(reference) === "files_nodes:get_file_node_for_membership" &&
						args.membershipId === "membership_1" &&
						args.fileNodeId === NODE._id,
				),
			).toBe(true);

			node = { ...node };
			nodeQueryStatus = "ready";
			pushQueryChanges();
			expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
			expect(editor).toHaveProperty("value", "Local draft");
			expect(editorMountMock).toHaveBeenCalledTimes(1);
			expect(editorUnmountMock).not.toHaveBeenCalled();
		},
	);

	test("opens a loaded folder before its query answers", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		nodeQueryStatus = "loading";
		renderFileView({ nodeId: node._id });
		expect(await screen.findByRole("heading", { name: "No README.md" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "New file" })).toBeTruthy();
	});

	test("keeps a loaded folder README draft when the folder query answers", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "readme_1", parentId: node._id, name: "README.md" }];
		nodeQueryStatus = "loading";
		renderFileView({ nodeId: node._id });
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "README draft" } });

		node = { ...node };
		nodeQueryStatus = "ready";
		pushQueryChanges();
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editor).toHaveProperty("value", "README draft");
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		expect(editorUnmountMock).not.toHaveBeenCalled();
	});

	test("uses the query's current shape and write access over an older tree node", async () => {
		treeNodes = [NODE];
		nodeQueryStatus = "loading";
		renderFileView();
		expect(await screen.findByRole("combobox", { name: "View: Code" })).toBeTruthy();

		node = { ...NODE, textKind: "rich_text", contentType: "text/markdown", canWrite: false };
		nodeQueryStatus = "ready";
		pushQueryChanges();
		expect(await screen.findByRole("combobox", { name: "View: Rich text" })).toBeTruthy();
		expect(screen.getByText("You don't have permission to edit this file.")).toBeTruthy();
	});

	test("removes a loaded file and returns Home when its query returns null", async () => {
		treeNodes = [NODE];
		nodeQueryStatus = "loading";
		const { onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });

		nodeQueryStatus = "missing";
		pushQueryChanges();
		await waitFor(() => expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull());
		expect(editorUnmountMock).toHaveBeenCalledTimes(1);
		expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "root", view: undefined, q: undefined });
	});

	test.each(["ready", "missing"] as const)("waits for an absent tree node's query to become %s", async (status) => {
		treeNodes = [];
		nodeQueryStatus = "loading";
		const { onNavigateSearch } = renderFileView();
		expect(await screen.findByText("Loading...")).toBeTruthy();
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(onNavigateSearch).not.toHaveBeenCalled();

		nodeQueryStatus = status;
		pushQueryChanges();
		if (status === "ready") {
			expect(await screen.findByRole("textbox", { name: "Code draft" })).toBeTruthy();
			expect(onNavigateSearch).not.toHaveBeenCalled();
		} else {
			expect(screen.queryByTestId("editor")).toBeNull();
			expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "root", view: undefined, q: undefined });
		}
	});

	test.each([true, false])("switching nodes never keeps the previous draft (next node loaded: %s)", async (loaded) => {
		const nextNode = { ...NODE, _id: "node_next", name: "next.html" };
		treeNodes = loaded ? [NODE, nextNode] : [NODE];
		nodeQueryStatus = "loading";
		const { rerender, onNavigateSearch } = renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "First file draft" } });

		rerender(<FileNodeView searchParams={{ nodeId: nextNode._id }} onNavigateSearch={onNavigateSearch} />);
		if (!loaded) {
			expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull();
			expect(screen.getByText("Loading...")).toBeTruthy();
			treeNodes = [NODE, nextNode];
			pushQueryChanges();
		}
		const nextEditor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(nextEditor).not.toBe(editor);
		expect(nextEditor).toHaveProperty("value", "saved HTML");
		expect(editorRenderMock.mock.calls.at(-1)![0].target).toEqual({ kind: "saved", id: nextNode._id });
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("opens Home while the selected-node query is skipped", async () => {
		treeNodes = [];
		const { onNavigateSearch } = renderFileView({ nodeId: "root" });
		expect(await screen.findByRole("heading", { name: "No README.md" })).toBeTruthy();
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});
});

describe("FileNodeView private targets", () => {
	test("opens only the owner target and keeps the local draft through Preview", async () => {
		const { onNavigateSearch } = renderFileView({
			pendingNodeId: PRIVATE_ENTRY.node._id,
			nodeId: NODE._id,
			q: "draft",
		});
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(screen.getByText("Added file")).toBeTruthy();
		expect(editorRenderMock.mock.calls.at(-1)![0]).toMatchObject({
			target: PRIVATE_ENTRY.pendingUpdate.target,
			privateCanEdit: true,
			pendingUpdateId: "pending_private",
			nonCollaborative: true,
		});
		expect(
			queryMock.mock.calls.filter(
				([reference, args]) =>
					args !== "skip" &&
					[
						"files_nodes:get_file_node_for_membership",
						"files_nodes:get_file_last_yjs_sequence",
						"r2:get_asset_by_file_node_id",
					].includes(getFunctionName(reference)),
			),
		).toEqual([]);
		fireEvent.change(editor, { target: { value: "<p>Private local draft</p>" } });
		await selectView("Preview");
		expect(await screen.findByTestId("html-preview")).toHaveProperty("textContent", "<p>Private local draft</p>");
		expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
		await selectView("Code");
		expect(onNavigateSearch).toHaveBeenCalledWith(
			{ pendingNodeId: PRIVATE_ENTRY.node._id, view: "plain_text_editor", q: "draft" },
			undefined,
		);
		expect(await screen.findByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editorMountMock).toHaveBeenCalledOnce();
	});

	test.each([false, true])("the first Save moves to the saved target and keeps Review: %s", async (keepReview) => {
		const { onNavigateSearch, rerender } = renderFileView({
			pendingNodeId: PRIVATE_ENTRY.node._id,
			view: "diff_editor",
			q: "draft",
		});
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "Private edits" } });
		const onTargetChange = editorRenderMock.mock.calls.at(-1)![0].onTargetChange;
		// Publication can close the owner query before its action returns.
		privateView = null;
		pushQueryChanges();
		act(() => onTargetChange?.({ kind: "saved", id: NODE._id as app_convex_Id<"files_nodes"> }, { keepReview }));
		const searchParams = { nodeId: NODE._id, view: keepReview ? ("diff_editor" as const) : undefined, q: "draft" };
		expect(onNavigateSearch).toHaveBeenLastCalledWith(searchParams, { replace: true });
		rerender(<FileNodeView searchParams={searchParams} onNavigateSearch={onNavigateSearch} />);
		expect(await screen.findByRole("textbox", { name: "Code draft" })).not.toBe(editor);
		expect(editorRenderMock.mock.calls.at(-1)![0].target).toEqual({ kind: "saved", id: NODE._id });
	});

	test("a completed Save does not leave a different file opened during the request", async () => {
		const { onNavigateSearch, rerender } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });
		const onTargetChange = editorRenderMock.mock.calls.at(-1)![0].onTargetChange;
		rerender(<FileNodeView searchParams={{ nodeId: NODE._id }} onNavigateSearch={onNavigateSearch} />);
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		act(() => onTargetChange?.({ kind: "saved", id: "published_1" as app_convex_Id<"files_nodes"> }));
		expect(onNavigateSearch).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
	});

	test("a new owner draft generation starts with a new editor", async () => {
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "Old generation draft" } });
		privateView = {
			...privateView!,
			entry: { ...PRIVATE_ENTRY, node: { ...PRIVATE_ENTRY.node, creationGeneration: 2 } },
		};
		pushQueryChanges();
		const nextEditor = await screen.findByRole("textbox", { name: "Code draft" });
		expect(nextEditor).not.toBe(editor);
		expect(nextEditor).toHaveProperty("value", "saved HTML");
	});

	test("preparation keeps Save disabled and still permits owner Discard", async () => {
		privateView = {
			...privateView!,
			readiness: "preparing",
			canAccept: false,
			entry: {
				...PRIVATE_ENTRY,
				pendingUpdate: {
					...PRIVATE_ENTRY.pendingUpdate,
					createIntent: undefined,
					content: undefined,
					preparation: {
						transferItemId: "transfer_item" as app_convex_Id<"files_transfer_items">,
						creationGeneration: 1,
					},
				},
			},
		};
		const { onNavigateSearch } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		expect(await screen.findByText("Preparing this file…")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Save" }).matches(":disabled")).toBe(true);
		expect(screen.queryByTestId("editor")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Discard" }));
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));
		expect(onNavigateSearch).not.toHaveBeenCalled();
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_pending_update_runs:start");
		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership_1",
			requestId: expect.any(String),
			kind: "discard",
			expectedItemCount: 1,
			items: [{ pendingUpdateId: "pending_private", reviewedRevision: 3, selectedContentStateId: null }],
		});
		expect(getFunctionName(mutationMock.mock.calls[1]![0])).toBe("files_pending_update_runs:seal");
	});

	test("write loss keeps the draft readable and read loss removes it", async () => {
		privateView = { ...privateView!, canEdit: false, canAccept: false };
		const { onNavigateSearch } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });
		expect(editorRenderMock.mock.calls.at(-1)![0].privateCanEdit).toBe(false);
		expect(screen.getByRole("button", { name: "Discard" }).matches(":disabled")).toBe(false);
		privateView = null;
		pushQueryChanges();
		expect(await screen.findByText(/This draft is no longer available/)).toBeTruthy();
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("opens private and saved children through their own target kinds", async () => {
		privateView = {
			...privateView!,
			entry: {
				...PRIVATE_ENTRY,
				node: { ...PRIVATE_ENTRY.node, kind: "folder", name: "Draft folder" },
				pendingUpdate: {
					...PRIVATE_ENTRY.pendingUpdate,
					content: undefined,
					createIntent: { kind: "folder", metadata: [] },
				},
			},
		};
		pendingChildren = [
			{
				target: { kind: "private", id: PRIVATE_ENTRY.node._id },
				name: PRIVATE_ENTRY.node.name,
				path: PRIVATE_ENTRY.path,
				kind: "file",
				preparing: true,
				updatedAt: 1,
				updatedBy: "user_1",
				contentType: "text/html",
			},
			{
				target: { kind: "saved", id: NODE._id },
				name: NODE.name,
				path: NODE.path,
				kind: "file",
				preparing: false,
				updatedAt: 1,
				updatedBy: "user_1",
				contentType: "text/html",
			},
		];
		const { onNavigateSearch } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		expect(await screen.findByText("Added folder")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "draft.html" }));
		expect(onNavigateSearch).toHaveBeenLastCalledWith({
			pendingNodeId: PRIVATE_ENTRY.node._id,
			view: undefined,
			q: undefined,
		});
		fireEvent.click(screen.getByRole("button", { name: "page.html" }));
		expect(onNavigateSearch).toHaveBeenLastCalledWith({ nodeId: NODE._id, view: undefined, q: undefined });
	});

	test("the media preview signs only the captured private asset", async () => {
		privateView = {
			...privateView!,
			entry: {
				...PRIVATE_ENTRY,
				node: { ...PRIVATE_ENTRY.node, name: "image.png" },
				pendingUpdate: {
					...PRIVATE_ENTRY.pendingUpdate,
					content: undefined,
					createIntent: {
						kind: "stored",
						contentType: "image/png",
						size: 18,
						metadata: [],
						assetId: "private_asset" as app_convex_Id<"files_r2_assets">,
					},
				},
			},
		};
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/private.png" } });
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
		expect(await screen.findByRole("img", { name: "image.png" })).toHaveProperty(
			"src",
			"https://assets.test/private.png",
		);
		expect(getFunctionName(actionMock.mock.calls[0]![0])).toBe(
			"files_pending_updates:create_private_pending_download_url",
		);
		expect(actionMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership_1",
			target: PRIVATE_ENTRY.pendingUpdate.target,
			pendingUpdateId: "pending_private",
			reviewedRevision: 3,
			creationGeneration: 1,
		});
	});

	test("restores a tagged private selection and never falls back to saved lookup", async () => {
		app_local_storage_set_value("app_state::files_last_open_target::scope::membership_1", {
			kind: "private",
			id: "missing_private",
		});
		const { onNavigateSearch, rerender } = renderFileView({ q: "draft" });
		expect(onNavigateSearch).toHaveBeenCalledWith({ pendingNodeId: "missing_private", q: "draft" }, { replace: true });
		privateView = null;
		rerender(
			<FileNodeView
				searchParams={{ pendingNodeId: "missing_private", q: "draft" }}
				onNavigateSearch={onNavigateSearch}
			/>,
		);
		expect(await screen.findByText(/This draft is no longer available/)).toBeTruthy();
		expect(
			queryMock.mock.calls.some(
				([reference, args]) =>
					getFunctionName(reference) === "files_nodes:get_file_node_for_membership" && args !== "skip",
			),
		).toBe(false);
	});
});

describe("FileNodeView folder clipboard", () => {
	test("waits for every page and shows more across saved and private children", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const children = ["a.html", "c.html", "e.html"].map((name) => ({
			...NODE,
			_id: name,
			name,
			path: `/Docs/${name}`,
			parentId: node._id,
		}));
		treeNodes = [node, ...children];
		const savedPage = children.map((child) => ({
			target: { kind: "saved", id: child._id },
			name: child.name,
			path: child.path,
			kind: "file",
			preparing: false,
			updatedAt: 1,
			updatedBy: "user_1",
			contentType: "text/html",
		}));
		const privatePage = ["b.html", "d.html", "f.html"].map((name) => ({
			target: { kind: "private", id: name },
			name,
			path: `/Docs/${name}`,
			kind: "file",
			preparing: false,
			updatedAt: 1,
			updatedBy: "user_1",
			contentType: "text/html",
		}));
		let secondPageReady = false;
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: { cursor?: string | null }) => {
			if (getFunctionName(reference) !== "files_visible:list") return query(reference, args);
			if (args.cursor && !secondPageReady) return undefined;
			return {
				_yay: {
					items: args.cursor ? privatePage : savedPage,
					isDone: Boolean(args.cursor),
					continueCursor: args.cursor ? null : "private-page",
				},
			};
		});
		renderFileView({ nodeId: node._id });
		expect(await screen.findByText("Loading folder…")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open a.html" })).toBeNull();
		secondPageReady = true;
		pushQueryChanges();
		await screen.findByRole("link", { name: "Open b.html" });
		expect(screen.queryByRole("link", { name: "Open f.html" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(await screen.findByRole("link", { name: "Open f.html" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
		expect(screen.queryByRole("link", { name: "Open f.html" })).toBeNull();
	});

	test("disables toolbar Paste when the open folder is archived", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		const child = { ...NODE, parentId: node._id };
		treeNodes = [node, child];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Copy$/ })).toBeNull());
		node = { ...node, archiveOperationId: "qa-archive" };
		treeNodes = [node, { ...child, archiveOperationId: "qa-archive" }];
		pushQueryChanges();
		const paste = screen.getByRole("button", { name: "Paste files" });
		expect(paste.matches(":disabled")).toBe(true);
		fireEvent.click(paste);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("explains Paste is busy while a folder is being created", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, parentId: node._id }];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Copy$/ })).toBeNull());
		const response = Promise.withResolvers<{ _yay: { nodeId: string } }>();
		mutationMock.mockReturnValue(response.promise);
		fireEvent.click(screen.getByRole("button", { name: "New folder" }));
		fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "New folder" } });
		fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
		const paste = screen.getByRole("button", { name: "Paste files", hidden: true });
		expect(paste.matches(":disabled")).toBe(true);
		expect(document.getElementById(paste.getAttribute("aria-describedby")!)?.textContent).toContain(
			"Wait for the current file operation to finish.",
		);
		await act(async () => response.resolve({ _yay: { nodeId: "new-folder" } }));
	});

	test.each(["toolbar", "folder menu"])("copies a row and pastes into the %s destination", async (destination) => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		const child = { ...NODE, parentId: node._id };
		const target = { ...node, _id: "folder_2", name: "Target", parentId: node._id };
		treeNodes = [node, child, target];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Copy$/ })).toBeNull());
		expect(screen.getByText("1 ready to copy")).toBeTruthy();
		if (destination === "toolbar") {
			fireEvent.click(screen.getByRole("button", { name: "Paste files" }));
		} else {
			fireEvent.click(screen.getByRole("button", { name: "More actions for Target" }));
			fireEvent.click(await screen.findByRole("menuitem", { name: /^Paste$/ }));
		}
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:start");
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			kind: "copy",
			sourceIds: [child._id],
			targetParentId: destination === "toolbar" ? node._id : target._id,
		});
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
	});

	test("marks a cut row ready to move and Clear removes the mark", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, parentId: node._id }];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Cut$/ }));
		expect(screen.getByRole("link", { name: "Open page.html, ready to move" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Clear file clipboard" }));
		expect(screen.getByRole("link", { name: /^Open page\.html$/ })).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();
	});
});

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
					kind: "entry",
					readiness: "ready",
					canEdit: true,
					canAccept: true,
					entry: {
						kind: "saved",
						node: NODE,
						path: NODE.path,
						pendingUpdate: {
							_id: "pending_1",
							target: { kind: "saved", id: NODE._id },
							revision: 1,
							content: {
								base: { kind: "asset", assetId: "asset_1" },
								baseStateId: "base_1",
								stagedStateId: "staged_1",
								unstagedStateId: "unstaged_1",
							},
						},
					},
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

	test("the open editor finds its proposal before its review page is loaded", async () => {
		savedPendingUpdate = {
			...PRIVATE_ENTRY.pendingUpdate,
			_id: "pending_later_page",
			target: { kind: "saved", id: NODE._id },
		};
		pendingListStatus = "CanLoadMore";
		renderFileView();
		expect(await screen.findByRole("button", { name: "Review changes" })).toBeTruthy();
		expect(editorRenderMock.mock.calls.at(-1)![0].pendingUpdateId).toBe("pending_later_page");
		expect(editorRenderMock.mock.calls.at(-1)![0].pendingUpdatesLoaded).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Load more reviews" }));
		expect(loadMorePendingMock).toHaveBeenCalledWith(20);
	});

	test("private proposals do not become the current saved file review", async () => {
		pendingUpdates = [
			{
				kind: "entry",
				readiness: "ready",
				canEdit: true,
				canAccept: true,
				entry: PRIVATE_ENTRY,
			},
		];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
	});

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
