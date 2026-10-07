import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";
import { encodeStateAsUpdate } from "yjs";
import { files_yjs_doc_create_from_text } from "../../../../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../../../../shared/files.ts";
import { files_table_filter_matches, type files_table_Filter } from "../../../../shared/files-table.ts";
import {
	files_sort_compare,
	files_sort_key_of,
	files_sort_text_key,
	type files_sort_Sort,
} from "../../../../shared/files-sort.ts";

import type {
	FileEditor_Props,
	FileEditorPendingUpdatesFloating_Props,
	FileEditorPresenceSupplier_Props,
} from "../file-editor/file-editor.tsx";
import type { FileHtmlPreview } from "./file-html-preview.tsx";
import { FilesClipboardProvider } from "../files-clipboard.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import type { files_VisibleEntry } from "@/lib/files.ts";
import type { useFilesSortedChildren } from "@/hooks/files-search-hooks.ts";
import { app_local_storage_get_value, app_local_storage_set_value } from "@/lib/storage.ts";
import { global_custom_event_dispatch, global_custom_event_listen } from "@/lib/global-event.tsx";

const {
	tenantContextMock,
	queryMock,
	querySetsMock,
	mutationMock,
	actionMock,
	queryPushListeners,
	editorRenderMock,
	editorMountMock,
	editorUnmountMock,
	pluginUnmountMock,
	loadMorePendingMock,
	sortedChildrenMock,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	queryMock: vi.fn(),
	querySetsMock: vi.fn<(id: string, queries: Record<string, { query: never; args: unknown }>) => void>(),
	mutationMock: vi.fn(),
	actionMock: vi.fn(),
	queryPushListeners: new Set<() => void>(),
	editorRenderMock: vi.fn<(props: FileEditor_Props) => void>(),
	editorMountMock: vi.fn(),
	editorUnmountMock: vi.fn(),
	pluginUnmountMock: vi.fn(),
	loadMorePendingMock: vi.fn(),
	sortedChildrenMock:
		vi.fn<(props: Parameters<typeof useFilesSortedChildren>[0]) => ReturnType<typeof useFilesSortedChildren>>(),
}));

// The pending list uses the convex-helpers hook. Serve it from the same mock as every other list.
vi.mock("convex-helpers/react", async () => ({
	usePaginatedQuery: (await import("convex/react")).usePaginatedQuery,
}));

// Most tests use the real hook. Filter state tests control its result and actions.
vi.mock("@/hooks/files-search-hooks.ts", async (importOriginal) => {
	const hooks = await importOriginal<typeof import("@/hooks/files-search-hooks.ts")>();
	const { useEffect, useState } = await import("react");
	return {
		...hooks,
		useFilesSortedChildren: (props: Parameters<typeof useFilesSortedChildren>[0]) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			return sortedChildrenMock.getMockImplementation()
				? sortedChildrenMock(props)
				: hooks.useFilesSortedChildren(props);
		},
	};
});

// Push query changes into memoized children, as the live Convex subscriptions do.
vi.mock("convex/react", async () => {
	const { useEffect, useId, useState } = await import("react");
	return {
		useConvex: () => ({
			query: (...args: unknown[]) => Promise.resolve(queryMock(...args)),
			mutation: mutationMock,
			action: actionMock,
		}),
		usePaginatedQuery: (query: never, args: unknown) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			// A test can answer with its own page status. Otherwise every list uses `pendingListStatus`.
			const result = queryMock(query, args);
			return result !== undefined && !Array.isArray(result)
				? { ...result, loadMore: loadMorePendingMock }
				: { results: result ?? [], status: pendingListStatus, loadMore: loadMorePendingMock };
		},
		useQueries: (queries: Record<string, { query: never; args: unknown }>) => {
			querySetsMock(useId(), queries);
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
	return { app_convex_api: api, app_convex: { query: queryMock, mutation: mutationMock, action: actionMock } };
});
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => tenantContextMock() },
}));
vi.mock("@/lib/files-tree-context.tsx", async () => {
	const { useQuery } = await import("convex/react");
	const { api } = await import("../../../../convex/_generated/api.js");
	return {
		// Serve every tree row at once. The store's paging has its own tests.
		FilesTreeProvider: {
			useFolders: (request: { pinnedNodeIds: string[] }) => {
				const membershipId = tenantContextMock().membershipId;
				// The query mock answers this list with plain rows, not pages.
				const rows = useQuery(api.files_nodes.list_tree, {
					membershipId,
					paginationOpts: { numItems: 500, cursor: null },
				}) as unknown as Array<{ _id: string }> | undefined;
				// Like the store, add the pinned node and its ancestors. The file view pins at most one node.
				const pin = useQuery(
					api.files_nodes.get_tree_ancestors,
					request.pinnedNodeIds[0] ? { membershipId, nodeId: request.pinnedNodeIds[0] } : "skip",
				);
				const pinRows = pin
					? [...pin.ancestors, pin.node].filter((row) => !rows?.some((item) => item._id === row._id))
					: [];
				return {
					rows: rows && [...rows, ...pinRows],
					statusByFolderId: new Map(),
					hoistedIds: new Set(),
					loadMore: () => {},
				};
			},
			// Unknown, so the folder table reads every stream.
			useIsOwner: () => null,
			useFullList: (enabled: boolean) =>
				useQuery(
					api.files_nodes.list_tree,
					enabled
						? { membershipId: tenantContextMock().membershipId, paginationOpts: { numItems: 500, cursor: null } }
						: "skip",
				),
		},
	};
});
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/components/app-hotkeys.tsx", () => ({ AppHotkeysProvider: { useHotkey: () => {} } }));
vi.mock("@/lib/activities.ts", () => ({ useFileNodeActivities: () => [] }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

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
	// Expose the link's search params, so a test can tell a saved crumb from a pending one. The
	// previous search holds a table filter and typed text, so a test can see a link drop them.
	MyLink: (props: {
		children?: ReactNode;
		"aria-label"?: string;
		search?: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>);
	}) => {
		const search =
			typeof props.search === "function"
				? props.search({ filter: "file.name:starts_with:a", view_q: "typed" })
				: props.search;
		return (
			<a
				href="#"
				aria-label={props["aria-label"]}
				data-node-id={search?.nodeId as string | undefined}
				data-pending-node-id={search?.pendingNodeId as string | undefined}
				data-filter={search?.filter as string | undefined}
				data-view-q={search?.view_q as string | undefined}
			>
				{props.children}
			</a>
		);
	},
	MyLinkIcon: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

import { FileNodeView, type FileNodeView_Props, type FileNodeView_SearchParams } from "./file-node-view.tsx";
import { FileEditorSidebarPending } from "../file-editor/file-editor-sidebar/file-editor-sidebar-pending.tsx";

const NODE = {
	_id: "node_html",
	_creationTime: 1,
	updatedAt: 1,
	parentId: "root",
	name: "page.html",
	path: "/page.html",
	kind: "file",
	contentType: "text/html",
	contentByteSize: null as number | null,
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
		expiresAt: 1,
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
// Rows in folders the view has not loaded. They show only through a pinned node's ancestors.
let unloadedTreeNodes: (typeof NODE)[];
let plugins: (typeof PLUGIN)[] | undefined;
let pendingUpdates: unknown[];
let savedPendingUpdate: unknown;
let pendingListStatus: "CanLoadMore" | "LoadingMore" | "Exhausted";
// Restricted children shared with this member, on their own share stream.
let sharedRows: (typeof NODE)[];
// What `has_tree_children_shared` answers.
let hasShared: boolean | null;
// What `has_drafts_in_folder` answers.
let hasDrafts: boolean;
let folderSort: unknown;
let privateView:
	| {
			entry: files_VisibleEntry;
			readiness: "ready" | "preparing";
			canEdit: boolean;
			canAccept: boolean;
			canAcceptWithParents: boolean;
			requiredParents: Array<{
				target: { kind: "private"; id: app_convex_Id<"files_pending_nodes"> };
				path: string;
				pendingUpdateId: app_convex_Id<"files_pending_updates">;
				reviewedRevision: number;
			}>;
			savedParentId: app_convex_Id<"files_nodes"> | null;
			recovery?: { savedParentId: app_convex_Id<"files_nodes">; expiresAt: number };
			copyDestination?: { folderPath: string; personal: boolean; replacement: boolean };
	  }
	| null
	| undefined;
let pendingChildren: unknown[];
let header: HTMLDivElement;
let appHoistingContainer: HTMLDivElement;
let browserSession: unknown;
let anagraphic: unknown;

function pushQueryChanges() {
	act(() => queryPushListeners.forEach((listener) => listener()));
}

beforeEach(() => {
	node = NODE;
	nodeQueryStatus = "ready";
	treeNodes = undefined;
	unloadedTreeNodes = [];
	plugins = undefined;
	pendingUpdates = [];
	savedPendingUpdate = undefined;
	pendingListStatus = "Exhausted";
	loadMorePendingMock.mockReset();
	sortedChildrenMock.mockReset();
	privateView = {
		entry: PRIVATE_ENTRY,
		readiness: "ready",
		canEdit: true,
		canAccept: true,
		canAcceptWithParents: true,
		requiredParents: [],
		savedParentId: null,
	};
	pendingChildren = [];
	sharedRows = [];
	hasShared = false;
	hasDrafts = false;
	folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: true };
	browserSession = null;
	anagraphic = null;
	tenantContextMock.mockReturnValue({
		membershipId: "membership_1",
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		organizationName: "team",
		workspaceName: "home",
	});
	queryMock.mockReset();
	querySetsMock.mockClear();
	queryMock.mockImplementation((reference: never, args: unknown) => {
		if (args === "skip") return undefined;
		switch (getFunctionName(reference)) {
			case "files_nodes:list_tree":
				return treeNodes ?? [node];
			case "files_nodes:get_tree_ancestors": {
				const nodes = [...(treeNodes ?? [node]), ...unloadedTreeNodes];
				const chain: (typeof NODE)[] = [];
				let row = nodes.find((item) => item._id === (args as { nodeId: string }).nodeId);
				while (row) {
					chain.unshift(row);
					const parentId = row.parentId;
					row = nodes.find((item) => item._id === parentId);
				}
				return chain.length === 0 ? null : { node: chain.at(-1), ancestors: chain.slice(0, -1) };
			}
			case "files_nodes:get_folder_readme": {
				const { folderId } = args as { folderId: string };
				return (
					(treeNodes ?? [node]).find(
						(item) =>
							item.parentId === folderId &&
							item.kind === "file" &&
							item.archiveOperationId === null &&
							item.name.toLowerCase() === "readme.md",
					) ?? null
				);
			}
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
			case "files_folder_sorts:get_folder_sort":
				return folderSort;
			case "files_nodes:list_tree_children_sorted":
			case "files_nodes:list_tree_children_shared": {
				// Serve a whole segment at once. The hook's paging has its own tests. The tree rows are open, and
				// `sharedRows` come on the member's own share stream.
				const { parentId, kind, segment, sort, filter, restricted, principalIndex } = args as {
					parentId: string;
					kind: string;
					segment: string;
					sort: files_sort_Sort;
					filter: files_table_Filter | null;
					restricted?: boolean;
					principalIndex?: number;
				};
				const source =
					principalIndex === undefined ? (restricted ? [] : (treeNodes ?? [])) : principalIndex === 0 ? sharedRows : [];
				return segment === "missing"
					? []
					: source
							.filter((item) => item.parentId === parentId && item.kind === kind && item.archiveOperationId === null)
							.filter((item) => {
								if (filter === null) return true;
								const dot = item.name.lastIndexOf(".");
								return files_table_filter_matches({
									filter,
									facts: {
										name: item.name,
										createdAt: item._creationTime,
										updatedAt: item.updatedAt,
										extension:
											item.kind === "file" && dot > 0 && dot < item.name.length - 1
												? item.name.slice(dot + 1).toLowerCase()
												: null,
										contentByteSize: item.kind === "file" ? item.contentByteSize : null,
									},
									scalar: "Open",
								});
							})
							.map((item) => ({
								...item,
								sortKey: files_sort_key_of({
									sort,
									facts: {
										kind: item.kind === "folder" ? "folder" : "file",
										name: item.name,
										createdAt: item._creationTime,
										updatedAt: item.updatedAt,
										extension: item.name.includes(".") ? item.name.split(".").at(-1)!.toLowerCase() : null,
										contentByteSize: item.contentByteSize,
									},
									metadataParts: new Map([["metadata.status", files_sort_text_key("Open")]]),
								}),
							}))
							.sort((a, b) => files_sort_compare({ a: a.sortKey, b: b.sortKey, sort }));
			}
			case "files_nodes:has_tree_children_shared":
				return hasShared;
			case "files_metadata:list_search_fields":
				return [{ fieldPath: "metadata.status", valueKinds: ["string"] }];
			case "files_metadata:list_folder_fields":
				return { fields: ["metadata.status"], afterField: "metadata.status", isDone: true };
			case "files_metadata:get_field_values": {
				const { fields } = args as { fields: string[] };
				return {
					values: fields.map((field) => ({ field, value: field === "metadata.status" ? "Open" : null })),
					afterField: fields.at(-1),
					isDone: true,
				};
			}
			case "files_visible:list_private_folder_children":
				return pendingChildren;
			case "files_nodes:has_drafts_in_folder":
				return hasDrafts;
			case "files_transfer:list_current":
				return [];
			case "files_transfer:get":
			case "files_pending_update_runs:get":
				return null;
			case "users:get_anagraphic":
				return anagraphic;
			case "plugins_ui:list_file_views":
				return plugins;
			case "r2:get_asset_by_file_node_id":
				return null;
			case "files_browser:current_browser_session": {
				const { mode } = args as { mode: "file" | "web" };
				return browserSession && (browserSession as { mode: "file" | "web" }).mode === mode ? browserSession : null;
			}
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
	vi.mocked(toast.success).mockClear();
	localStorage.clear();
	app_local_storage_set_value("app_state::files_folder_columns::scope::membership_1", {});
	header = document.createElement("div");
	header.id = "app_main_header_content";
	document.body.append(header);
	// The folder explorer row menus render into this container through a React portal.
	appHoistingContainer = document.createElement("div");
	appHoistingContainer.id = "app_hoisting_container" satisfies AppElementId;
	document.body.append(appHoistingContainer);
});

afterEach(() => {
	cleanup();
	header.remove();
	appHoistingContainer.remove();
});

function renderFileView(searchParams: FileNodeView_SearchParams = { nodeId: NODE._id }) {
	// Follow navigation like the router does, so views kept in the URL render after a pick. A
	// navigation during the first render is applied right after that render.
	let rerender: ((ui: ReactNode) => void) | undefined;
	let firstRenderSearch: FileNodeView_SearchParams | undefined;
	let currentSearch = searchParams;
	// Every navigation except the `replace` writes that keep the same node and query and only put the
	// shown view into the URL. Tests that check "this action did not navigate" read this one.
	const otherNavigations = vi.fn();
	const onNavigateSearch = vi.fn((search: FileNodeView_SearchParams, options?: { replace?: boolean }) => {
		const isViewWrite =
			options?.replace === true &&
			search.nodeId === currentSearch.nodeId &&
			search.pendingNodeId === currentSearch.pendingNodeId &&
			search.q === currentSearch.q;
		if (!isViewWrite) otherNavigations(search, options);
		currentSearch = search;
		if (rerender) rerender(<FileNodeView searchParams={search} onNavigateSearch={onNavigateSearch} />);
		else firstRenderSearch = search;
	});
	const result = render(<FileNodeView searchParams={searchParams} onNavigateSearch={onNavigateSearch} />, {
		wrapper: ({ children }) => (
			<AppActivitiesProvider key={tenantContextMock().membershipId} membershipId={tenantContextMock().membershipId}>
				<FilesClipboardProvider key={tenantContextMock().membershipId} membershipId={tenantContextMock().membershipId}>
					{children}
				</FilesClipboardProvider>
			</AppActivitiesProvider>
		),
	});
	rerender = result.rerender;
	if (firstRenderSearch) {
		result.rerender(<FileNodeView searchParams={firstRenderSearch} onNavigateSearch={onNavigateSearch} />);
	}
	return {
		...result,
		// Track the URL a test sets by hand too, so a later view write is compared with it.
		rerender: (ui: ReactElement<FileNodeView_Props>) => {
			currentSearch = ui.props.searchParams;
			result.rerender(ui);
		},
		onNavigateSearch,
		otherNavigations,
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
		const { onNavigateSearch, otherNavigations } = renderFileView();
		expect(await screen.findByText("Loading...")).toBeTruthy();
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(onNavigateSearch).not.toHaveBeenCalled();

		nodeQueryStatus = status;
		pushQueryChanges();
		if (status === "ready") {
			expect(await screen.findByRole("textbox", { name: "Code draft" })).toBeTruthy();
			expect(otherNavigations).not.toHaveBeenCalled();
		} else {
			expect(screen.queryByTestId("editor")).toBeNull();
			expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "root", view: undefined, q: undefined });
		}
	});

	test.each([true, false])("switching nodes never keeps the previous draft (next node loaded: %s)", async (loaded) => {
		const nextNode = { ...NODE, _id: "node_next", name: "next.html" };
		treeNodes = loaded ? [NODE, nextNode] : [NODE];
		nodeQueryStatus = "loading";
		const { rerender, onNavigateSearch, otherNavigations } = renderFileView();
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
		expect(otherNavigations).not.toHaveBeenCalled();
	});

	test("opens Home while the selected-node query is skipped", async () => {
		treeNodes = [];
		const { onNavigateSearch } = renderFileView({ nodeId: "root" });
		expect(await screen.findByRole("heading", { name: "No README.md" })).toBeTruthy();
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});
});

describe("FileEditorSidebarPending review focus", () => {
	test("shows replacement sharing rules even when the source is hidden", () => {
		pendingUpdates = [
			{
				...privateView,
				kind: "entry",
				entry: {
					kind: "saved",
					node: NODE,
					path: NODE.path,
					pendingUpdate: {
						...PRIVATE_ENTRY.pendingUpdate,
						target: { kind: "saved", id: NODE._id },
						createIntent: undefined,
						content: undefined,
						pendingReplacement: { assetId: "replacement", baseAssetId: "base", contentType: "image/png", size: 3 },
					},
				},
				copyDestination: { personal: false, replacement: true, folderPath: "/" },
			},
		];
		render(
			<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
				<FileEditorSidebarPending />
			</AppActivitiesProvider>,
		);
		expect(screen.getByText("This replaces content and keeps the destination file's sharing rules.")).toBeTruthy();
		expect(screen.queryByText("New copies use this folder's sharing rules. Source sharing is not copied.")).toBeNull();
		expect(screen.getByText("The destination organization owner can read saved copies.")).toBeTruthy();
	});

	test.each([true, false])("shows current Copy destination rules with no source path (personal %s)", (personal) => {
		pendingUpdates = [
			{
				...privateView,
				kind: "entry",
				copyDestination: { personal, replacement: false, folderPath: "/restricted/output" },
			},
		];
		render(
			<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
				<FileEditorSidebarPending />
			</AppActivitiesProvider>,
		);
		expect(screen.getByText("Destination: team/home · /restricted/output")).toBeTruthy();
		expect(screen.getByText("New copies use this folder's sharing rules. Source sharing is not copied.")).toBeTruthy();
		expect(
			screen.getByText(
				personal
					? "Saved copies here are private to you."
					: "The destination organization owner can read saved copies.",
			),
		).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each(["text", "folder", "stored"] as const)("shows recovery before opening a %s row", (kind) => {
		pendingUpdates = [
			{
				...privateView,
				kind: "entry",
				canAccept: false,
				canAcceptWithParents: false,
				recovery: { savedParentId: NODE._id, expiresAt: 2_000_000_000_000 },
				entry:
					kind === "text"
						? PRIVATE_ENTRY
						: {
								...PRIVATE_ENTRY,
								node: { ...PRIVATE_ENTRY.node, kind: kind === "folder" ? "folder" : "file" },
								pendingUpdate: {
									...PRIVATE_ENTRY.pendingUpdate,
									content: undefined,
									createIntent:
										kind === "folder"
											? { kind: "folder", metadata: [] }
											: {
													kind: "stored",
													metadata: [],
													contentType: "application/octet-stream",
													size: 4,
													assetId: "asset_private",
												},
								},
							},
			},
		];
		render(
			<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
				<FileEditorSidebarPending />
			</AppActivitiesProvider>,
		);
		expect(screen.getByText(/This draft's folder was archived/)).toBeTruthy();
		expect(screen.getByText(/Unsaved draft expires/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Accept all shown pending changes" }).matches(":disabled")).toBe(true);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each([
		{ kind: "text", action: "Accept changes to /draft.html" },
		{ kind: "text", action: "Discard changes to /draft.html" },
		{ kind: "folder", action: "Accept changes to /draft.html" },
		{ kind: "folder", action: "Discard changes to /draft.html" },
		{ kind: "text", action: "Accept all shown pending changes" },
		{ kind: "text", action: "Discard all shown pending changes" },
		{ kind: "restricted", action: "Discard unavailable draft" },
	])("keeps focus through delayed $action ($kind)", async ({ kind, action }) => {
		pendingUpdates = [
			kind === "restricted"
				? {
						kind: "restricted",
						target: PRIVATE_ENTRY.pendingUpdate.target,
						pendingUpdateId: "pending_private",
						revision: 3,
					}
				: {
						...privateView,
						kind: "entry",
						entry:
							kind === "folder"
								? {
										...PRIVATE_ENTRY,
										node: { ...PRIVATE_ENTRY.node, kind: "folder" },
										pendingUpdate: {
											...PRIVATE_ENTRY.pendingUpdate,
											content: undefined,
											createIntent: { kind: "folder", metadata: [] },
										},
									}
								: PRIVATE_ENTRY,
					},
		];
		const started = Promise.withResolvers<{ _yay: { runId: string } }>();
		mutationMock.mockImplementation((reference) =>
			getFunctionName(reference) === "files_pending_update_runs:start"
				? started.promise
				: Promise.resolve({ _yay: null }),
		);
		let completed = false;
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) === "files_pending_update_runs:get")
				return {
					run: { kind: action.startsWith("Accept") ? "accept" : "discard", step: "applying" },
					activity: { status: completed ? "succeeded" : "running", finishedAt: completed ? 2 : undefined },
					controls: { canStop: false },
				};
			if (getFunctionName(reference) === "files_pending_update_runs:list_items") return { page: [], isDone: true };
			return previousQuery(reference, args);
		});
		render(
			<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
				<FileEditorSidebarPending />
			</AppActivitiesProvider>,
		);
		const opener = screen.getByRole("button", { name: action });
		opener.focus();
		fireEvent.click(opener);

		// The start reply has not arrived. Busy buttons must keep focus until the modal can capture it.
		expect(opener.matches(":disabled")).toBe(false);
		expect(opener.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(opener);
		fireEvent.click(opener);
		expect(mutationMock).toHaveBeenCalledTimes(1);
		await act(async () => started.resolve({ _yay: { runId: "review_1" } }));
		await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));

		pendingUpdates = [];
		completed = true;
		pushQueryChanges();
		fireEvent.click(screen.getByText("Close"));
		await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Pending changes"));
	});
});

describe("FileNodeView private targets", () => {
	test("shows Copy disclosure in the saved detail view too", async () => {
		privateView = {
			...privateView!,
			entry: {
				kind: "saved",
				node: {
					...NODE,
					_id: NODE._id as app_convex_Id<"files_nodes">,
					organizationId: PRIVATE_ENTRY.node.organizationId,
					workspaceId: PRIVATE_ENTRY.node.workspaceId,
					createdBy: PRIVATE_ENTRY.node.userId,
					updatedBy: PRIVATE_ENTRY.node.userId,
					parentId: "root",
					kind: "file",
					sortName: NODE.name,
					assetId: NODE.assetId as app_convex_Id<"files_r2_assets">,
					contentByteSize: null,
					isRestrictedScopeRoot: false,
					textKind: "plain_text",
					treePath: `/${NODE._id}`,
					pathDepth: 1,
					lowercaseExtension: "html",
					writePolicy: null,
					statsId: null,
					contentTooLargeByteSize: null,
					contentShapeMismatchAt: null,
					contentYjsStateTooLargeByteSize: null,
					contentFrontmatterTooLargeFieldCount: null,
					contentFrontmatterTooLargeIndexDocumentCount: null,
				},
				path: NODE.path,
				pendingUpdate: null,
			},
			copyDestination: { personal: false, replacement: true, folderPath: "/" },
		};
		renderFileView({ nodeId: NODE._id });
		expect(
			await screen.findByText("This replaces content and keeps the destination file's sharing rules."),
		).toBeTruthy();
		expect(screen.getByText("Destination: team/home · /")).toBeTruthy();
	});

	test("shows Copy disclosure in the detail view without changing Save", async () => {
		privateView = { ...privateView!, copyDestination: { personal: true, replacement: false, folderPath: "/" } };
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		expect(await screen.findByText("Saved copies here are private to you.")).toBeTruthy();
		expect(screen.getByText("Destination: team/home · /")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each([false, true])("recovery reads both branches and rechecks access (revoked %s)", async (revoked) => {
		privateView = {
			...privateView!,
			canEdit: false,
			canAccept: false,
			canAcceptWithParents: false,
			recovery: { savedParentId: NODE._id as app_convex_Id<"files_nodes">, expiresAt: 2_000_000_000_000 },
		};
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) === "files_pending_updates:get_file_pending_update_state_page") {
				const text = args.stateId === "private_staged" ? "Accepted draft text" : "Proposed draft text";
				const doc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text });
				if ("_nay" in doc) throw new Error(doc._nay.message);
				const bytes = files_u8_to_array_buffer(encodeStateAsUpdate(doc));
				doc.destroy();
				return { bytes, pageCount: 1, totalBytes: bytes.byteLength, digest: "test" };
			}
			if (getFunctionName(reference) === "files_pending_updates:get_file_pending_update")
				return revoked ? null : PRIVATE_ENTRY.pendingUpdate;
			return previousQuery(reference, args);
		});
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		if (revoked) {
			expect(await screen.findByRole("alert")).toHaveProperty(
				"textContent",
				"This draft changed or access ended. Reopen it to try again.",
			);
			expect(screen.queryByRole("textbox", { name: "Accepted text" })).toBeNull();
		} else {
			expect(await screen.findByRole("textbox", { name: "Accepted text" })).toHaveProperty(
				"value",
				"Accepted draft text",
			);
			expect(screen.getByRole("textbox", { name: "Proposed text" })).toHaveProperty("value", "Proposed draft text");
			expect(screen.getByRole("textbox", { name: "Proposed text" })).toHaveProperty("readOnly", true);
			expect(screen.getByRole("button", { name: "Copy accepted text" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Copy proposed text" })).toBeTruthy();
		}
		expect(mutationMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("archived-parent recovery never mounts an editor or enables Save", async () => {
		privateView = {
			...privateView!,
			canEdit: false,
			canAccept: false,
			canAcceptWithParents: false,
			recovery: { savedParentId: NODE._id as app_convex_Id<"files_nodes">, expiresAt: 2_000_000_000_000 },
		};
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		expect(
			await screen.findByText(
				"This draft's folder was archived. You can copy or download your draft. Restore the folder before saving here.",
			),
		).toBeTruthy();
		expect(screen.getByText(/Unsaved draft expires/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open archived folder" }).getAttribute("data-node-id")).toBe(NODE._id);
		expect(screen.getByText("Restore the archived folder before saving this draft.")).toBeTruthy();
		expect(screen.queryByText("You don't have permission to save this draft here.")).toBeNull();
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(screen.queryByTestId("html-preview")).toBeNull();
		expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		privateView = null;
		pushQueryChanges();
		expect(await screen.findByText(/This draft is no longer available/)).toBeTruthy();
		expect(screen.queryByText(/Unsaved draft expires/)).toBeNull();
	});

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
		expect(onNavigateSearch.mock.calls.at(-1)?.[0]).toEqual({
			pendingNodeId: PRIVATE_ENTRY.node._id,
			fileView: "code",
			q: "draft",
		});
		expect(await screen.findByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editorMountMock).toHaveBeenCalledOnce();
	});

	test.each([false, true])("the first Save moves to the saved target and keeps Review: %s", async (keepReview) => {
		const { onNavigateSearch, otherNavigations, rerender } = renderFileView({
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
		expect(otherNavigations).toHaveBeenLastCalledWith(searchParams, { replace: true });
		rerender(<FileNodeView searchParams={searchParams} onNavigateSearch={onNavigateSearch} />);
		expect(await screen.findByRole("textbox", { name: "Code draft" })).not.toBe(editor);
		expect(editorRenderMock.mock.calls.at(-1)![0].target).toEqual({ kind: "saved", id: NODE._id });
	});

	test("a completed Save does not leave a different file opened during the request", async () => {
		const { onNavigateSearch, otherNavigations, rerender } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });
		const onTargetChange = editorRenderMock.mock.calls.at(-1)![0].onTargetChange;
		rerender(<FileNodeView searchParams={{ nodeId: NODE._id }} onNavigateSearch={onNavigateSearch} />);
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		act(() => onTargetChange?.({ kind: "saved", id: "published_1" as app_convex_Id<"files_nodes"> }));
		expect(otherNavigations).not.toHaveBeenCalled();
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
			canAcceptWithParents: false,
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
		privateView = { ...privateView!, canEdit: false, canAccept: false, canAcceptWithParents: false };
		const { otherNavigations } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });
		expect(editorRenderMock.mock.calls.at(-1)![0].privateCanEdit).toBe(false);
		expect(screen.getByRole("button", { name: "Discard" }).matches(":disabled")).toBe(false);
		privateView = null;
		pushQueryChanges();
		expect(await screen.findByText(/This draft is no longer available/)).toBeTruthy();
		expect(screen.queryByTestId("editor")).toBeNull();
		expect(otherNavigations).not.toHaveBeenCalled();
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
				kind: "file",
				preparing: true,
			},
			{
				target: { kind: "saved", id: NODE._id },
				name: NODE.name,
				kind: "file",
				preparing: false,
			},
		];
		const { otherNavigations } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		expect(await screen.findByText("Added folder")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "draft.html" }));
		expect(otherNavigations).toHaveBeenLastCalledWith(
			{ pendingNodeId: PRIVATE_ENTRY.node._id, view: undefined, q: undefined },
			undefined,
		);
		fireEvent.click(screen.getByRole("button", { name: "page.html" }));
		expect(otherNavigations).toHaveBeenLastCalledWith({ nodeId: NODE._id, view: undefined, q: undefined }, undefined);
	});

	test("a draft folder with an empty page and more pages says so and loads 50 more", async () => {
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
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: unknown) =>
			getFunctionName(reference) === "files_visible:list_private_folder_children"
				? { results: [], status: "CanLoadMore" }
				: query(reference, args),
		);
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });

		// The server leaves out rows the user cannot read, so the first page can be empty.
		expect(await screen.findByText("No matches loaded yet. Show more to keep looking.")).toBeTruthy();
		expect(queryMock).toHaveBeenCalledWith(expect.anything(), {
			membershipId: "membership_1",
			folderId: PRIVATE_ENTRY.node._id,
		});
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(loadMorePendingMock).toHaveBeenCalledWith(50);
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

		// An image draft shows its picture straight away. There is no Preview button to press first.
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

	// This draft sits in a folder that is itself still a proposal, so it cannot be saved on its own.
	// Save creates the folder too, in one run, and each item carries the revision the user reviewed.
	test.each([false, true])("saves through Activity with required parents=%s", async (withParents) => {
		privateView = {
			...privateView!,
			canAccept: !withParents,
			requiredParents: withParents
				? [
						{
							target: { kind: "private", id: "parent_1" as app_convex_Id<"files_pending_nodes"> },
							path: "/captures",
							pendingUpdateId: "pending_parent" as app_convex_Id<"files_pending_updates">,
							reviewedRevision: 8,
						},
					]
				: [],
			entry: {
				...PRIVATE_ENTRY,
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

		// The extra folder is named in the UI first, so Save never creates something the user did not see.
		if (withParents) expect(await screen.findByText("Save also creates: /captures")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(2));

		expect(mutationMock.mock.calls[0]![1]).toEqual({
			membershipId: "membership_1",
			requestId: expect.any(String),
			kind: "accept",
			expectedItemCount: withParents ? 2 : 1,
			items: [
				...(withParents
					? [{ pendingUpdateId: "pending_parent", reviewedRevision: 8, selectedContentStateId: null }]
					: []),
				{ pendingUpdateId: "pending_private", reviewedRevision: 3, selectedContentStateId: null },
			],
		});
		expect(
			actionMock.mock.calls.some(
				([reference]) => getFunctionName(reference) === "files_pending_updates:save_file_pending_update",
			),
		).toBe(false);
	});

	test("keeps the review progress and a failed Save visible", async () => {
		privateView = {
			...privateView!,
			entry: {
				...PRIVATE_ENTRY,
				pendingUpdate: {
					...PRIVATE_ENTRY.pendingUpdate,
					content: undefined,
					createIntent: {
						kind: "stored",
						contentType: "application/pdf",
						size: 18,
						metadata: [],
						assetId: "asset_pdf" as app_convex_Id<"files_r2_assets">,
					},
				},
			},
		};
		let failed = false;
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) === "files_pending_update_runs:get")
				return {
					run: { kind: "accept", step: "running" },
					activity: {
						status: failed ? "failed" : "running",
						finishedAt: failed ? 2 : undefined,
						errorMessage: failed ? "The draft changed. Review it again." : undefined,
						progress: { total: 1, completed: 0, skipped: 0, failed: failed ? 1 : 0, blocked: 0, canceled: 0 },
					},
					controls: { canStop: false },
				};
			if (getFunctionName(reference) === "files_pending_update_runs:list_items") return { page: [], isDone: true };
			return previousQuery(reference, args);
		});
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		fireEvent.click(await screen.findByRole("button", { name: "Save" }));
		expect(await screen.findByText("Saving reviewed changes…")).toBeTruthy();
		expect(screen.getByText(/1 remaining/)).toBeTruthy();
		failed = true;
		pushQueryChanges();
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The draft changed. Review it again.");
		expect(screen.getByText("Review could not finish. Check the remaining changes.")).toBeTruthy();
		expect(privateView?.entry.pendingUpdate?._id).toBe("pending_private");
	});

	test("restores focus when a focused private action disappears", async () => {
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		const discard = await screen.findByRole("button", { name: "Discard" });
		discard.focus();

		// Somebody else saved or discarded this draft, so the focused button unmounts. Keyboard focus must
		// land on the file content instead of falling back to the page body.
		privateView = null;
		pushQueryChanges();

		await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("File content"));
		expect(screen.getByText("This draft is no longer available.")).toBeTruthy();
	});

	test.each(["Save", "Discard"])("returns focus to file content after closing completed %s", async (action) => {
		privateView = {
			...privateView!,
			entry: {
				...PRIVATE_ENTRY,
				pendingUpdate: {
					...PRIVATE_ENTRY.pendingUpdate,
					content: undefined,
					createIntent: {
						kind: "stored",
						contentType: "application/octet-stream",
						size: 18,
						metadata: [],
						assetId: "asset_binary" as app_convex_Id<"files_r2_assets">,
					},
				},
			},
		};
		let completed = false;
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) === "files_pending_update_runs:get")
				return {
					run: { kind: action === "Save" ? "accept" : "discard", step: "applying" },
					activity: { status: completed ? "succeeded" : "running", finishedAt: completed ? 2 : undefined },
					controls: { canStop: false },
				};
			if (getFunctionName(reference) === "files_pending_update_runs:list_items") return { page: [], isDone: true };
			return previousQuery(reference, args);
		});
		const { rerender, onNavigateSearch } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		const opener = await screen.findByRole("button", { name: action });
		opener.focus();
		fireEvent.click(opener);
		await waitFor(() => expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true));

		privateView = null;
		completed = true;
		pushQueryChanges();
		if (action === "Save")
			rerender(<FileNodeView searchParams={{ nodeId: NODE._id }} onNavigateSearch={onNavigateSearch} />);
		expect(opener.isConnected).toBe(false);
		fireEvent.click(screen.getByText("Close"));

		await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("File content"));
	});

	test("shows a saved image without a file viewer plugin", async () => {
		node = {
			...NODE,
			name: "capture.png",
			path: "/capture.png",
			contentType: "image/png",
			textKind: null,
			collaborationEnabled: false,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
		};
		// No plugin can open this file. The view must still show the picture itself.
		plugins = [];

		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: unknown) =>
			getFunctionName(reference) === "r2:get_asset_by_file_node_id"
				? { r2Key: "capture.png", size: 18 }
				: query(reference, args),
		);
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/saved.png" } });

		renderFileView();

		expect(await screen.findByRole("img", { name: "capture.png" })).toHaveProperty(
			"src",
			"https://assets.test/saved.png",
		);
		expect(getFunctionName(actionMock.mock.calls[0]![0])).toBe("r2:create_signed_download_url");
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
	});

	// A chat link still points at the private draft, but that draft was saved in the meantime. Files
	// answers with the saved node, and the route swaps to it without adding a history entry.
	test("follows a published private link to the authorized saved target", async () => {
		privateView = {
			...privateView!,
			entry: { kind: "saved", node: NODE, pendingUpdate: null, path: NODE.path } as unknown as files_VisibleEntry,
		};
		const { onNavigateSearch } = renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id, q: "capture" });
		await waitFor(() =>
			expect(onNavigateSearch).toHaveBeenCalledWith(
				{ nodeId: NODE._id, q: "capture", view: undefined },
				{ replace: true },
			),
		);
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
	test("shows the first page at once, merges shared rows in order, and loads the next page by itself", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const children = ["a.html", "b.html", "c.html", "d.html", "e.html", "f.html"].map((name) => ({
			...NODE,
			_id: name,
			name,
			path: `/Docs/${name}`,
			parentId: node._id,
		}));
		treeNodes = [node, ...children];
		// Restricted children shared with this member. Their stream is done after one page.
		sharedRows = ["bb.html", "z.html"].map((name) => ({
			...NODE,
			_id: name,
			name,
			path: `/Docs/${name}`,
			parentId: node._id,
		}));
		let secondPageReady = false;
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: { kind?: string; restricted?: boolean }) => {
			if (
				getFunctionName(reference) !== "files_nodes:list_tree_children_sorted" ||
				args.kind !== "file" ||
				args.restricted
			) {
				return query(reference, args);
			}
			const page = children.map((child) => ({
				...child,
				sortKey: {
					parts: [[files_sort_text_key(child.name), child.name]],
					nameKey: [files_sort_text_key(child.name), child.name],
				},
			}));
			return secondPageReady
				? { results: page, status: "Exhausted" }
				: { results: page.slice(0, 3), status: "CanLoadMore" };
		});
		renderFileView({ nodeId: node._id });

		// The first page shows at once. A shared row shows where it sorts once the loaded rows reach it.
		expect(await screen.findByRole("link", { name: "Open c.html" })).toBeTruthy();
		expect(screen.getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("aria-label"))).toEqual([
			"Open a.html",
			"Open b.html",
			"Open bb.html",
			"Open c.html",
		]);
		// The table wants a full page of rows, so it asks for the next page without a click.
		expect(loadMorePendingMock).toHaveBeenCalledWith(100);

		secondPageReady = true;
		pushQueryChanges();
		expect(await screen.findByRole("link", { name: "Open d.html" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open z.html" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(screen.getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("aria-label"))).toEqual([
			"Open a.html",
			"Open b.html",
			"Open bb.html",
			"Open c.html",
			"Open d.html",
			"Open e.html",
			"Open f.html",
			"Open z.html",
		]);
		expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
		expect(screen.getByRole("link", { name: "Open d.html" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open e.html" })).toBeNull();
	});

	test("shows an archived folder's state and disables Create a README.md", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder", archiveOperationId: "qa-archive" };
		treeNodes = [node];
		renderFileView({ nodeId: node._id });
		expect(await screen.findByText("This folder is archived. Restore it before adding items.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Create a README.md" }).matches(":disabled")).toBe(true);
	});

	test("copies a row and pastes into a folder from its menu", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		const child = { ...NODE, parentId: node._id };
		const target = { ...node, _id: "folder_2", name: "Target", parentId: node._id };
		treeNodes = [node, child, target];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Copy$/ }));
		await waitFor(() => expect(screen.queryByRole("menuitem", { name: /^Copy$/ })).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "More actions for Target" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Paste$/ }));
		expect(getFunctionName(mutationMock.mock.calls[0]![0])).toBe("files_transfer:start");
		expect(mutationMock.mock.calls[0]![1]).toMatchObject({
			kind: "copy",
			sourceIds: [child._id],
			targetParentId: target._id,
		});
		// A one-source paste opens no dialog. The paste would open it right after the start call.
		await act(async () => {
			await mutationMock.mock.results[0]!.value;
		});
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "Paste files" })).toBeNull();
	});

	test("marks a cut row ready to move", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, parentId: node._id }];
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Cut$/ }));
		expect(screen.getByRole("row", { name: "page.html, ready to move" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open page.html, ready to move" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Clear file clipboard" })).toBeNull();
		expect(mutationMock).not.toHaveBeenCalled();
	});
});

describe("FileNodeView folder draft hint", () => {
	test("points to the Pending tab only while the user's drafts change this folder", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, parentId: node._id }];
		renderFileView({ nodeId: node._id });
		expect(await screen.findByRole("link", { name: "Open page.html" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Open Pending changes" })).toBeNull();

		hasDrafts = true;
		pushQueryChanges();
		expect(
			screen.getByText("Your drafts add, move or remove items in this folder. Review them in the Pending changes tab."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Open Pending changes" }));
		expect(app_local_storage_get_value("app_state::files_last_tab")).toBe(
			"app_file_editor_sidebar_tabs_pending" satisfies AppElementId,
		);
	});
});

describe("FileNodeView folder sort", () => {
	test("keeps a saved sort applying while its first page is pending", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, parentId: node._id }];
		const sort: files_sort_Sort = [{ field: "updated", direction: "desc" }];
		folderSort = { sort, canSave: false };
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) =>
			getFunctionName(reference) === "files_nodes:list_tree_children_sorted"
				? { results: [], status: "LoadingFirstPage" }
				: query(reference, args),
		);
		expect(sortedChildrenMock.getMockImplementation()).toBeUndefined();
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		await waitFor(() =>
			expect(
				queryMock.mock.calls.some(
					([reference, args]) =>
						getFunctionName(reference) === "files_nodes:list_tree_children_sorted" &&
						args !== "skip" &&
						JSON.stringify(args.sort) === JSON.stringify(sort),
				),
			).toBe(true),
		);
		expect(table.getAttribute("aria-busy")).toBe("true");
		expect(screen.getByText("Loading folder contents…")).toBeTruthy();
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-sort-state")).toBe("applying");
	});

	test("a header click writes sort tokens to the URL and saves nothing", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		const { onNavigateSearch } = renderFileView({ nodeId: node._id });

		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(within(table).getByRole("columnheader", { name: /^file\.name/ }).getAttribute("aria-sort")).toBe("ascending");

		fireEvent.click(within(table).getByRole("button", { name: /^file\.updated/ }));
		expect(
			within(table)
				.getByRole("columnheader", { name: /^file\.updated ↓/ })
				.getAttribute("aria-sort"),
		).toBe("descending");
		expect(within(table).getByRole("columnheader", { name: /^file\.name/ }).getAttribute("aria-sort")).toBeNull();
		expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify([{ field: "updated", direction: "desc" }]));
		expect(onNavigateSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ filter: "sort_by:file.updated:desc" }),
			expect.anything(),
		);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("a writer saves the sort from the URL for everyone, and a failed save says so", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: true };
		mutationMock
			.mockResolvedValueOnce({ _yay: null })
			.mockResolvedValueOnce({ _nay: { message: "Permission denied" } });
		renderFileView({ nodeId: node._id, filter: "sort_by:file.updated:desc" });

		await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(screen.getByRole("button", { name: "Save sort for everyone" }));
		await waitFor(() =>
			expect(mutationMock).toHaveBeenCalledWith(expect.anything(), {
				membershipId: "membership_1",
				folderId: node._id,
				sort: [{ field: "updated", direction: "desc" }],
			}),
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sort saved for everyone."));

		fireEvent.click(screen.getByRole("button", { name: "Save sort for everyone" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The sort could not be saved. Try again."));
	});

	test("the Save sort button is hidden while the URL has no sort", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: true };
		renderFileView({ nodeId: node._id });

		await screen.findByRole("table", { name: "Folder contents" });
		expect(screen.queryByRole("button", { name: "Save sort for everyone" })).toBeNull();
	});

	test("the Save sort button is hidden while a filter is on", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: true };
		// The sort token names the filter's own field, so it is the order on screen, but only for the filter.
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:a sort_by:file.name:desc" });

		await screen.findByRole("table", { name: "Folder contents" });
		expect(screen.queryByRole("button", { name: "Save sort for everyone" })).toBeNull();
	});

	test("a reader sorts only their own view", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: false };
		renderFileView({ nodeId: node._id });

		const table = await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(within(table).getByRole("button", { name: /^file\.name/ }));
		expect(within(table).getByRole("columnheader", { name: /^file\.name/ }).getAttribute("aria-sort")).toBe("descending");
		expect(screen.queryByRole("button", { name: "Save sort for everyone" })).toBeNull();
		expect(mutationMock.mock.calls.length).toBe(0);
	});

	test("the column menu sorts by its field, starts a filter on its field, and hides the column", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: false };
		renderFileView({ nodeId: node._id });

		const table = await screen.findByRole("table", { name: "Folder contents" });
		// file.updated_by cannot sort, so its header has no sort button, only the column options.
		expect(
			within(within(table).getByRole("columnheader", { name: /^file\.updated_by/ }))
				.getAllByRole("button")
				.map((button) => button.getAttribute("aria-label")),
		).toEqual(["Column options for file.updated_by"]);
		fireEvent.click(within(table).getByRole("button", { name: "Column options for file.updated" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Newest first" }));
		expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify([{ field: "updated", direction: "desc" }]));

		fireEvent.click(within(table).getByRole("button", { name: "Column options for file.updated" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Filter by file.updated" }));
		expect(screen.getByRole("combobox", { name: "Filter and sort this folder" })).toHaveProperty(
			"value",
			"file.updated:",
		);

		fireEvent.click(within(table).getByRole("button", { name: "Column options for file.updated" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Hide column" }));
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.getAttribute("data-column-field")),
		).toEqual(["name", "updated_by", "actions"]);
	});

	test("sorting does not add a hidden column, and a chosen Size column reads row facts", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const file = {
			...NODE,
			_id: "a.html",
			name: "a.html",
			path: "/Docs/a.html",
			parentId: node._id,
			contentByteSize: 2048,
		};
		const folder = { ...NODE, _id: "sub", name: "Sub", path: "/Docs/Sub", kind: "folder", parentId: node._id };
		treeNodes = [node, file, folder];
		folderSort = { sort: [{ field: "size", direction: "desc" }], canSave: true };
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: { kind?: string; segment?: string }) => {
			if (getFunctionName(reference) !== "files_nodes:list_tree_children_sorted" || args.segment !== "value") {
				return query(reference, args);
			}
			return args.kind === "file"
				? [{ ...file, sortKey: { parts: [[2048, "a.html", "a.html"]], nameKey: ["a.html", "a.html"] } }]
				: [{ ...folder, sortKey: { parts: [null], nameKey: ["sub", "Sub"] } }];
		});
		renderFileView({ nodeId: node._id });

		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(within(table).queryByRole("columnheader", { name: /^file\.size/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Columns" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "file.size" }));
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(within(table).getByRole("columnheader", { name: /^file\.size/ }).getAttribute("aria-sort")).toBe("descending");
		const [folderRow, fileRow] = within(table).getAllByRole("row").slice(1);
		expect(
			within(folderRow!)
				.getAllByRole("cell")
				.map((cell) => cell.textContent),
		).toContain("—");
		expect(
			within(fileRow!)
				.getAllByRole("cell")
				.map((cell) => cell.textContent),
		).toContain("2.0 KB");
	});

	test("shows a dash for a row in the missing segment, even when its key starts with text", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const file = { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id };
		const folder = { ...NODE, _id: "sub", name: "Sub", path: "/Docs/Sub", kind: "folder", parentId: node._id };
		treeNodes = [node, file, folder];
		folderSort = { sort: [{ field: "extension", direction: "asc" }], canSave: true };
		const query = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference: never, args: { kind?: string; segment?: string }) => {
			if (getFunctionName(reference) !== "files_nodes:list_tree_children_sorted") {
				return query(reference, args);
			}
			// Folders have no file.extension, so they are all in the missing segment, keyed by name.
			if (args.kind === "folder") {
				return args.segment === "missing" ? [{ ...folder, sortKey: { parts: [null], nameKey: ["sub", "Sub"] } }] : [];
			}
			return args.segment === "value"
				? [{ ...file, sortKey: { parts: [["html", "a.html", "a.html"]], nameKey: ["a.html", "a.html"] } }]
				: [];
		});
		renderFileView({ nodeId: node._id });

		const table = await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(screen.getByRole("button", { name: "Columns" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "file.extension" }));
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(within(table).getByRole("columnheader", { name: /^file\.extension/ })).toBeTruthy();
		await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
		const [folderRow, fileRow] = within(table).getAllByRole("row").slice(1);
		expect(
			within(folderRow!)
				.getAllByRole("cell")
				.map((cell) => cell.textContent),
		).toContain("—");
		expect(
			within(fileRow!)
				.getAllByRole("cell")
				.map((cell) => cell.textContent),
		).toContain("html");
	});

	test("tells a member with shares here that a metadata sort does not show them", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		sharedRows = [{ ...NODE, _id: "shared.html", name: "shared.html", path: "/Docs/shared.html", parentId: node._id }];
		hasShared = true;
		folderSort = { sort: [{ field: "metadata.status", direction: "asc" }], canSave: false };
		renderFileView({ nodeId: node._id });

		expect(
			await screen.findByText("Items shared with you are not shown while sorting or filtering by metadata.status."),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open a.html" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open shared.html" })).toBeNull();
	});

	test("the Columns menu reads the folder field list only, never the fields of a shared row", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", path: "/Docs/a.html", parentId: node._id }];
		sharedRows = [{ ...NODE, _id: "shared.html", name: "shared.html", path: "/Docs/shared.html", parentId: node._id }];
		renderFileView({ nodeId: node._id });
		expect(await screen.findByRole("link", { name: "Open shared.html" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Columns" }));
		const chooser = await screen.findByRole("dialog", { name: "Columns" });
		expect(await within(chooser).findByRole("checkbox", { name: "metadata.status" })).toBeTruthy();
		expect(
			queryMock.mock.calls.some(([reference]) => getFunctionName(reference) === "files_metadata:list_node_fields"),
		).toBe(false);
	});
});

describe("FileNodeView folder sort states", () => {
	let rows: NonNullable<ReturnType<typeof useFilesSortedChildren>["rows"]>;
	let result: Partial<ReturnType<typeof useFilesSortedChildren>>;
	const retry = vi.fn();

	beforeEach(() => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const children = Array.from({ length: 7 }, (_, index) => ({
			...NODE,
			_id: `file_${index}`,
			name: `file-${index}.html`,
			path: `/Docs/file-${index}.html`,
			parentId: node._id,
		}));
		treeNodes = [node, ...children];
		rows = children.map((child) => ({
			target: { kind: "saved", id: child._id as app_convex_Id<"files_nodes"> },
			name: child.name,
			kind: "file",
			createdAt: child._creationTime,
			updatedAt: child.updatedAt,
			contentByteSize: child.contentByteSize,
			updatedBy: "user_1" as app_convex_Id<"users">,
			contentType: child.contentType,
			treeRow: child as NonNullable<(typeof rows)[number]["treeRow"]>,
			segment: "value",
			sortKey: {
				parts: [[files_sort_text_key(child.name), child.name]],
				nameKey: [files_sort_text_key(child.name), child.name],
			},
		}));
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: false };
		result = {};
		retry.mockReset();
		sortedChildrenMock.mockImplementation((props) => ({
			rows,
			rowsSort: props.sort,
			rowsFilter: props.filter,
			rowsNamePrefix: props.namePrefix,
			isBusy: false,
			isDone: true,
			isFailed: false,
			isFolderRefused: false,
			hiddenSharedKey: null,
			loadMore: loadMorePendingMock,
			retry,
			...result,
		}));
	});

	test("a header click sorts by that column and flips the direction of the sorted column", async () => {
		folderSort = { sort: [{ field: "updated", direction: "asc" }], canSave: false };
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(within(table).getByRole("button", { name: /^file\.updated/ }));
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "updated", direction: "desc" }]);
		fireEvent.click(within(table).getByRole("button", { name: /^file\.updated/ }));
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "updated", direction: "asc" }]);
		fireEvent.click(within(table).getByRole("button", { name: /^file\.name/ }));
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "name", direction: "asc" }]);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("shows no aria-sort while the sorted column is hidden, and says rows without the key are hidden", async () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "desc" }];
		folderSort = { sort, canSave: false };
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify(sort));
		expect(table.querySelector('[data-column-field="metadata.status"]')).toBeNull();
		expect(table.querySelector("[aria-sort]")).toBeNull();
		expect(screen.getByText("Rows without metadata.status are hidden.")).toBeTruthy();
		expect(
			queryMock.mock.calls.filter(([reference]) => getFunctionName(reference) === "files_metadata:get_field_values"),
		).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Columns" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "metadata.status" }));
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(table.querySelectorAll("[aria-sort]")).toHaveLength(1);
		expect(
			within(table)
				.getByRole("columnheader", { name: /^metadata\.status ↓/ })
				.getAttribute("aria-sort"),
		).toBe("descending");
	});

	test("under a metadata sort with no rows, says no row has the key instead of an empty folder", async () => {
		folderSort = { sort: [{ field: "metadata.status", direction: "asc" }], canSave: false };
		result = { rows: [] };
		renderFileView({ nodeId: node._id });
		await screen.findByRole("table", { name: "Folder contents" });
		expect(screen.getByText("No rows have metadata.status")).toBeTruthy();
		expect(screen.queryByText("This folder is empty")).toBeNull();
	});

	test("keeps the held full list and shows the requested sort in the header during newer sort requests", async () => {
		const oldSort: files_sort_Sort = [{ field: "metadata.status", direction: "desc" }];
		folderSort = { sort: oldSort, canSave: false };
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		result = { rowsSort: oldSort, rows: [rows[0]!], isBusy: true, isDone: false };
		for (const [field, arrow, ariaSort] of [
			["file.updated", "↓", "descending"],
			["file.name", "↑", "ascending"],
		] as const) {
			fireEvent.click(within(table).getByRole("button", { name: new RegExp(`^${field}`) }));
			expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify(oldSort));
			expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-sort-state")).toBe("applying");
			// A sort change alone shows no notice.
			expect(screen.queryByText(/^Showing:/)).toBeNull();
			expect(screen.queryByText(/^Applying sort…/)).toBeNull();
			expect(table.querySelectorAll("[aria-sort]")).toHaveLength(1);
			expect(
				within(table)
					.getByRole("columnheader", { name: new RegExp(`^${field} ${arrow}`) })
					.getAttribute("aria-sort"),
			).toBe(ariaSort);
			expect(screen.getByRole("button", { name: "Show more" })).toHaveProperty("disabled", true);
		}
		result = {};
		pushQueryChanges();
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-sort-state")).toBe("ready");
		expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify([{ field: "name", direction: "asc" }]));
	});

	test("keeps the sort controls during a failure and offers Retry", async () => {
		result = { rows: [rows[0]!], isFailed: true, isDone: false };
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-sort-state")).toBe("failed");
		expect(screen.getByText("Folder contents could not be loaded.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Columns" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(retry).toHaveBeenCalledTimes(1);
	});
});

describe("FileNodeView folder columns", () => {
	let observers: FolderObserver[];
	let visibleNodeId: string | null;

	class FolderObserver implements IntersectionObserver {
		root: Element | Document | null;
		rootMargin: string;
		scrollMargin = "0px";
		thresholds = [0];
		targets = new Set<Element>();
		observe = vi.fn((target: Element) => this.targets.add(target));
		unobserve = vi.fn((target: Element) => this.targets.delete(target));
		disconnect = vi.fn(() => this.targets.clear());
		takeRecords = () => [];

		constructor(
			readonly callback: IntersectionObserverCallback,
			options?: IntersectionObserverInit,
		) {
			this.root = options?.root ?? null;
			this.rootMargin = options?.rootMargin ?? "0px";
			observers.push(this);
		}

		emit() {
			this.callback(
				[...this.targets].map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
				this,
			);
		}
	}

	beforeEach(() => {
		observers = [];
		visibleNodeId = null;
		vi.stubGlobal("IntersectionObserver", FolderObserver);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("FileNodeView-editor-area") ? 600 : 0;
		});
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
			return this.classList.contains("FileNodeView-editor-area") ? 600 : 0;
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.classList.contains("FileNodeViewFolderExplorer-row")) {
				return new DOMRect(0, this.getAttribute("data-file-node-id") === visibleNodeId ? 0 : 650, 400, 20);
			}
			return this.classList.contains("FileNodeView-editor-area") ? new DOMRect(0, 0, 600, 600) : new DOMRect();
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("keeps the empty table and chooser, saves fixed column order, and restores defaults", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node];
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) =>
			getFunctionName(reference) === "files_metadata:list_folder_fields"
				? { fields: ["metadata.alpha", "metadata.beta", "metadata.zeta"], afterField: "metadata.zeta", isDone: true }
				: previousQuery(reference, args),
		);
		const view = renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(screen.getByText("This folder is empty")).toBeTruthy();
		expect(
			queryMock.mock.calls.some(([reference]) => getFunctionName(reference) === "files_metadata:list_folder_fields"),
		).toBe(false);
		const trigger = screen.getByRole("button", { name: "Columns" });
		fireEvent.click(trigger);
		const chooser = await screen.findByRole("dialog", { name: "Columns" });
		expect(within(chooser).getByRole("checkbox", { name: "file.name Always shown" })).toHaveProperty("disabled", true);
		expect(within(chooser).getByRole("checkbox", { name: "file.name Always shown" })).toHaveProperty("checked", true);
		for (const field of ["metadata.zeta", "file.size", "metadata.alpha", "file.extension", "file.created"]) {
			fireEvent.click(within(chooser).getByRole("checkbox", { name: field }));
		}
		expect(within(chooser).getByText("Show up to 8 columns. Hide one to add another.")).toBeTruthy();
		expect(within(chooser).getByRole("checkbox", { name: "metadata.beta" })).toHaveProperty("disabled", true);
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.getAttribute("data-column-field")),
		).toEqual([
			"name",
			"updated_by",
			"updated",
			"created",
			"extension",
			"size",
			"metadata.alpha",
			"metadata.zeta",
			"actions",
		]);
		fireEvent.click(within(chooser).getByRole("button", { name: "Done" }));
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		view.unmount();
		renderFileView({ nodeId: node._id });
		const restored = await screen.findByRole("table", { name: "Folder contents" });
		expect(
			within(restored)
				.getAllByRole("columnheader")
				.map((cell) => cell.getAttribute("data-column-field")),
		).toEqual([
			"name",
			"updated_by",
			"updated",
			"created",
			"extension",
			"size",
			"metadata.alpha",
			"metadata.zeta",
			"actions",
		]);
		fireEvent.click(screen.getByRole("button", { name: "Columns" }));
		fireEvent.click(await screen.findByRole("button", { name: "Reset columns" }));
		expect(
			within(restored)
				.getAllByRole("columnheader")
				.map((cell) => cell.getAttribute("data-column-field")),
		).toEqual(["name", "updated_by", "updated", "actions"]);
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test("keeps a hidden selected field focusable and closes with Escape", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node];
		app_local_storage_set_value("app_state::files_folder_columns::scope::membership_1", {
			folder_1: ["name", "metadata.old"],
		});
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) =>
			getFunctionName(reference) === "files_metadata:list_folder_fields"
				? { fields: [], afterField: null, isDone: true }
				: previousQuery(reference, args),
		);
		renderFileView({ nodeId: node._id });
		const trigger = await screen.findByRole("button", { name: "Columns" });
		fireEvent.click(trigger);
		const chooser = await screen.findByRole("dialog", { name: "Columns" });
		const field = within(chooser).getByRole("checkbox", { name: "metadata.old" });
		field.focus();
		fireEvent.click(field);
		expect(field).toHaveProperty("checked", false);
		expect(field.isConnected).toBe(true);
		expect(document.activeElement).toBe(field);
		fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	test("loads another catalog page only on Show more fields and retries a failed page from the start", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node];
		let failed = true;
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) !== "files_metadata:list_folder_fields") return previousQuery(reference, args);
			if (args.afterField === null) return { fields: ["metadata.alpha"], afterField: "metadata.alpha", isDone: false };
			return failed
				? new Error("Read failed")
				: { fields: ["metadata.beta"], afterField: "metadata.beta", isDone: true };
		});
		renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "Columns" }));
		const chooser = await screen.findByRole("dialog", { name: "Columns" });
		expect(within(chooser).getByRole("checkbox", { name: "metadata.alpha" })).toBeTruthy();
		expect(
			queryMock.mock.calls.some(
				([reference, args]) =>
					getFunctionName(reference) === "files_metadata:list_folder_fields" && args.afterField !== null,
			),
		).toBe(false);
		fireEvent.change(within(chooser).getByRole("textbox", { name: "Search columns" }), { target: { value: "beta" } });
		expect(within(chooser).getByText("No loaded fields match")).toBeTruthy();
		fireEvent.change(within(chooser).getByRole("textbox", { name: "Search columns" }), { target: { value: "" } });
		fireEvent.click(within(chooser).getByRole("button", { name: "Show more fields" }));
		expect(await within(chooser).findByText("Fields could not be loaded")).toBeTruthy();
		expect(within(chooser).queryByRole("checkbox", { name: "metadata.alpha" })).toBeNull();
		const callsAtFailure = queryMock.mock.calls.filter(
			([reference]) => getFunctionName(reference) === "files_metadata:list_folder_fields",
		).length;
		await act(async () => {});
		expect(
			queryMock.mock.calls.filter(([reference]) => getFunctionName(reference) === "files_metadata:list_folder_fields"),
		).toHaveLength(callsAtFailure);
		const hookId = querySetsMock.mock.calls.findLast(([, queries]) =>
			Object.values(queries).some((query) => getFunctionName(query.query) === "files_metadata:list_folder_fields"),
		)![0];
		querySetsMock.mockClear();
		failed = false;
		fireEvent.click(within(chooser).getByRole("button", { name: "Retry" }));
		expect(await within(chooser).findByRole("checkbox", { name: "metadata.beta" })).toBeTruthy();
		expect(querySetsMock.mock.calls.some(([id, queries]) => id === hookId && Object.keys(queries).length === 0)).toBe(
			true,
		);
		expect(within(chooser).queryByText("Fields could not be loaded")).toBeNull();
	});

	test("shows the updater's name, Loading… while it loads, and Unknown when no name is found", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", parentId: node._id }];
		anagraphic = undefined;
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		const cell = () => within(table).getAllByRole("row")[1]!.querySelector('[data-column-field="updated_by"]');
		expect(cell()).toHaveProperty("textContent", "Loading…");
		expect(cell()?.getAttribute("data-value-state")).toBe("loading");
		anagraphic = { displayName: "Ada Lovelace" };
		pushQueryChanges();
		// The name replaces the raw user id.
		expect(cell()).toHaveProperty("textContent", "Ada Lovelace");
		expect(cell()?.getAttribute("data-value-state")).toBe("ready");
		anagraphic = null;
		pushQueryChanges();
		expect(cell()).toHaveProperty("textContent", "Unknown");
	});

	test("loads real scalar cells through the editor observer and puts Retry values in Actions", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		treeNodes = [node, { ...NODE, _id: "a.html", name: "a.html", parentId: node._id }];
		const fields = ["metadata.empty", "metadata.flag", "metadata.missing", "metadata.number"];
		app_local_storage_set_value("app_state::files_folder_columns::scope::membership_1", {
			folder_1: ["name", ...fields],
		});
		let response: unknown;
		const ready = {
			values: [
				{ field: "metadata.empty", value: "" },
				{ field: "metadata.flag", value: false },
				{ field: "metadata.missing", value: null },
				{ field: "metadata.number", value: 0 },
			],
			afterField: "metadata.number",
			isDone: true,
		};
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) =>
			getFunctionName(reference) === "files_metadata:get_field_values" ? response : previousQuery(reference, args),
		);
		renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		const row = within(table).getAllByRole("row")[1]!;
		expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty(
			"textContent",
			"Loads when row is visible",
		);
		expect(
			queryMock.mock.calls.some(([reference]) => getFunctionName(reference) === "files_metadata:get_field_values"),
		).toBe(false);
		const observer = observers[0]!;
		expect(observer.root).toBe(table.closest(".FileNodeView-editor-area"));
		expect(observer.rootMargin).toBe("400px 0px");
		act(() => observer.emit());
		expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty("textContent", "Loading…");
		response = ready;
		pushQueryChanges();
		expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty("textContent", "0");
		expect(row.querySelector('[data-column-field="metadata.flag"]')).toHaveProperty("textContent", "false");
		expect(row.querySelector('[data-column-field="metadata.empty"]')).toHaveProperty("textContent", "");
		expect(row.querySelector('[data-column-field="metadata.empty"]')?.getAttribute("data-value-state")).toBe("ready");
		expect(row.querySelector('[data-column-field="metadata.missing"]')).toHaveProperty("textContent", "—");
		response = new Error("Read failed");
		pushQueryChanges();
		expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty("textContent", "Could not load");
		const actions = row.querySelector<HTMLElement>('[data-column-field="actions"]')!;
		const retry = within(actions).getByRole("button", { name: "Retry values" });
		const hookId = querySetsMock.mock.calls.findLast(([, queries]) =>
			Object.values(queries).some((query) => getFunctionName(query.query) === "files_metadata:get_field_values"),
		)![0];
		querySetsMock.mockClear();
		response = ready;
		fireEvent.click(retry);
		await waitFor(() =>
			expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty("textContent", "0"),
		);
		expect(querySetsMock.mock.calls.some(([id, queries]) => id === hookId && Object.keys(queries).length === 0)).toBe(
			true,
		);
		response = null;
		pushQueryChanges();
		expect(row.querySelector('[data-column-field="metadata.number"]')).toHaveProperty("textContent", "Unavailable");
		expect(within(actions).queryByRole("button", { name: "Retry values" })).toBeNull();
	});

	test("caps 1,000 rendered rows at 100 targets and 700 pages and updates visible and focused priority", async () => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const children = Array.from({ length: 1000 }, (_, index) => ({
			...NODE,
			_id: `file_${index}`,
			name: `${String(index).padStart(4, "0")}.html`,
			parentId: node._id,
		}));
		treeNodes = [node, ...children];
		const fields = Array.from({ length: 7 }, (_, index) => `metadata.field${index}`);
		app_local_storage_set_value("app_state::files_folder_columns::scope::membership_1", {
			folder_1: ["name", ...fields],
		});
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) !== "files_metadata:get_field_values") return previousQuery(reference, args);
			const index = args.afterField === null ? 0 : fields.indexOf(args.afterField) + 1;
			return {
				values: [{ field: fields[index], value: index }],
				afterField: fields[index],
				isDone: index === 6,
			};
		});
		const view = renderFileView({ nodeId: node._id });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(table.querySelectorAll(".FileNodeViewFolderExplorer-row")).toHaveLength(1000);
		const observer = observers[0]!;
		act(() => observer.emit());
		await waitFor(() => expect(table.getAttribute("data-value-target-count")).toBe("100"));
		await waitFor(() => expect(table.getAttribute("data-value-page-count")).toBe("700"));
		const deferred = table.querySelector<HTMLElement>('[data-file-node-id="file_500"]')!;
		expect(deferred.querySelector('[data-column-field="metadata.field0"]')?.getAttribute("data-value-state")).toBe(
			"deferred",
		);
		visibleNodeId = "file_500";
		fireEvent.scroll(observer.root!);
		await waitFor(() =>
			expect(deferred.querySelector('[data-column-field="metadata.field6"]')).toHaveProperty("textContent", "6"),
		);
		expect(
			table
				.querySelector('[data-file-node-id="file_99"] [data-column-field="metadata.field0"]')
				?.getAttribute("data-value-state"),
		).toBe("deferred");
		const focused = table.querySelector<HTMLElement>('[data-file-node-id="file_900"]')!;
		act(() => within(focused).getByRole("link").focus());
		await waitFor(() =>
			expect(focused.querySelector('[data-column-field="metadata.field6"]')).toHaveProperty("textContent", "6"),
		);
		expect(table.getAttribute("data-value-target-count")).toBe("100");
		expect(table.getAttribute("data-value-page-count")).toBe("700");
		for (const [, queries] of querySetsMock.mock.calls) {
			const values = Object.values(queries).filter(
				(query) => getFunctionName(query.query) === "files_metadata:get_field_values",
			);
			expect(values.length).toBeLessThanOrEqual(700);
			expect(
				new Set(values.map((query) => JSON.stringify((query.args as { target: unknown }).target))).size,
			).toBeLessThanOrEqual(100);
		}
		view.unmount();
		expect(observer.disconnect).toHaveBeenCalledTimes(1);
		expect(observer.targets.size).toBe(0);
	}, 60_000);
});

describe("FileNodeView folder filter", () => {
	let rows: NonNullable<ReturnType<typeof useFilesSortedChildren>["rows"]>;
	let result: Partial<ReturnType<typeof useFilesSortedChildren>>;
	let rowsByScope: Map<string, typeof rows>;
	const retry = vi.fn();

	beforeEach(() => {
		node = { ...NODE, _id: "folder_1", name: "Docs", path: "/Docs", kind: "folder" };
		const children = Array.from({ length: 7 }, (_, index) => ({
			...NODE,
			_id: `file_${index}`,
			name: `file-${index}.html`,
			path: `/Docs/file-${index}.html`,
			parentId: node._id,
		}));
		treeNodes = [node, ...children];
		rows = children.map((child) => ({
			target: { kind: "saved", id: child._id as app_convex_Id<"files_nodes"> },
			name: child.name,
			kind: "file",
			createdAt: child._creationTime,
			updatedAt: child.updatedAt,
			contentByteSize: child.contentByteSize,
			updatedBy: "user_1" as app_convex_Id<"users">,
			contentType: child.contentType,
			treeRow: child as NonNullable<(typeof rows)[number]["treeRow"]>,
			segment: "value",
			sortKey: {
				parts: [[files_sort_text_key(child.name), child.name]],
				nameKey: [files_sort_text_key(child.name), child.name],
			},
		}));
		result = {};
		rowsByScope = new Map();
		retry.mockReset();
		sortedChildrenMock.mockImplementation((props) => ({
			rows:
				props.filter === null
					? rows
					: (rowsByScope.get(JSON.stringify([props.membershipId, props.folderId, props.sort, props.filter])) ?? []),
			rowsSort: props.sort,
			rowsFilter: props.filter,
			rowsNamePrefix: props.namePrefix,
			isBusy: false,
			isDone: true,
			isFailed: false,
			isFolderRefused: false,
			hiddenSharedKey: null,
			loadMore: loadMorePendingMock,
			retry,
			...result,
		}));
	});

	test("a filter token narrows the rows in its own order, and Clear brings the saved sort back", async () => {
		const sort: files_sort_Sort = [{ field: "updated", direction: "desc" }];
		folderSort = { sort, canSave: false };
		app_local_storage_set_value("app_state::files_folder_columns::scope::membership_1", {
			folder_1: ["name", "extension"],
		});
		// A name filter reads rows in name order, whatever the saved sort is.
		const filterSort: files_sort_Sort = [{ field: "name", direction: "asc" }];
		const filter: files_table_Filter = { kind: "name", field: "name", op: "starts_with", value: "file-2." };
		rowsByScope.set(JSON.stringify(["membership_1", node._id, filterSort, filter]), [rows[2]!]);
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:file-2." });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(sortedChildrenMock.mock.calls.at(-1)![0]).toMatchObject({
			membershipId: "membership_1",
			folderId: node._id,
			sort: filterSort,
			filter,
			namePrefix: null,
		});
		expect(within(table).getAllByRole("link", { name: /^Open / })).toHaveLength(1);
		expect(screen.getByRole("link", { name: "Open file-2.html" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Clear filter and sort" }));
		expect(sortedChildrenMock.mock.calls.at(-1)![0].filter).toBeNull();
		expect(within(table).getAllByRole("link", { name: /^Open / })).toHaveLength(5);
		expect(table.getAttribute("data-sort-fields")).toBe(JSON.stringify(sort));
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.getAttribute("data-column-field")),
		).toEqual(["name", "extension", "actions"]);
		expect(mutationMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
	});

	test("under a filter, other columns say why they cannot sort, and aria-sort follows the filter order", async () => {
		folderSort = { sort: [{ field: "updated", direction: "desc" }], canSave: false };
		const { otherNavigations } = renderFileView({
			nodeId: node._id,
			filter: "file.extension:is:html sort_by:file.name:desc",
		});
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "name", direction: "desc" }]);
		const note = screen.getByText("Sorted by file.name because of the filter");
		expect(table.getAttribute("aria-describedby")).toBe(note.id);
		expect(table.querySelectorAll("[aria-sort]")).toHaveLength(1);
		expect(within(table).getByRole("columnheader", { name: /^file\.name ↓/ }).getAttribute("aria-sort")).toBe(
			"descending",
		);

		// The disabled header stays focusable, so a click can say why it does not sort. It points at the
		// visible note.
		const updated = within(table).getByRole("button", { name: /^file\.updated/ });
		expect(updated.getAttribute("aria-disabled")).toBe("true");
		expect(updated.getAttribute("aria-describedby")).toBe(note.id);
		// The status region is there before the first message, so a screen reader hears the first one.
		const status = screen.getAllByRole("status").find((element) => element.textContent === "")!;
		// Enter on a button fires a click.
		fireEvent.click(updated);
		expect(status.textContent).toBe("Remove the filter to sort by file.updated");
		const firstMessage = status.firstElementChild;
		// A second press puts in a new text node, so the same message is read again.
		fireEvent.click(updated);
		expect(status.textContent).toBe("Remove the filter to sort by file.updated");
		expect(status.firstElementChild).not.toBe(firstMessage);
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "name", direction: "desc" }]);
		expect(otherNavigations).not.toHaveBeenCalled();

		fireEvent.click(within(table).getByRole("button", { name: "Column options for file.updated" }));
		// The name is the direction only. The reason is the description, so it is not read twice.
		const newestFirst = await screen.findByRole("menuitem", { name: "Newest first" });
		const oldestFirst = screen.getByRole("menuitem", { name: "Oldest first" });
		const menu = newestFirst.closest<HTMLElement>('[role="menu"]')!;
		for (const item of [oldestFirst, newestFirst]) {
			expect(item.getAttribute("aria-disabled")).toBe("true");
			// The reason stays visible inside the item and is linked to it.
			const reason = document.getElementById(item.getAttribute("aria-describedby")!);
			expect(reason?.textContent).toBe("Remove the filter to sort by file.updated");
			expect(item.contains(reason)).toBe(true);
		}
		// The keys still reach the disabled items, so a keyboard user can read the reason. A click with no
		// detail is a keyboard open, so the first item is active. Enter does nothing.
		expect(menu.getAttribute("aria-activedescendant")).toBe(oldestFirst.id);
		fireEvent.keyDown(menu, { key: "ArrowDown", code: "ArrowDown" });
		expect(menu.getAttribute("aria-activedescendant")).toBe(newestFirst.id);
		fireEvent.keyDown(menu, { key: "Enter", code: "Enter" });
		expect(newestFirst.isConnected).toBe(true);
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "name", direction: "desc" }]);
		fireEvent.keyDown(menu, { key: "Escape", code: "Escape" });

		// The filter's own order field still sorts both ways.
		fireEvent.click(within(table).getByRole("button", { name: /^file\.name/ }));
		expect(sortedChildrenMock.mock.calls.at(-1)![0].sort).toEqual([{ field: "name", direction: "asc" }]);
		expect(within(table).getByRole("columnheader", { name: /^file\.name ↑/ }).getAttribute("aria-sort")).toBe(
			"ascending",
		);
	});

	test("a filter change clears the sort reason, and it does not come back", async () => {
		const view = renderFileView({ nodeId: node._id, filter: "file.extension:is:html" });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		const status = screen.getAllByRole("status").find((element) => element.textContent === "")!;
		fireEvent.click(within(table).getByRole("button", { name: /^file\.updated/ }));
		expect(status.textContent).toBe("Remove the filter to sort by file.updated");

		// file.updated still cannot sort under the new filter, but the message was about the old one. Going
		// back to the first filter does not bring it back either.
		for (const filter of ["file.extension:is:md", "file.extension:is:html"]) {
			view.rerender(<FileNodeView searchParams={{ nodeId: node._id, filter }} onNavigateSearch={view.onNavigateSearch} />);
			expect(status.isConnected).toBe(true);
			expect(status.textContent).toBe("");
		}
	});

	test("a change of the name prefix alone keeps the old rows and names the old prefix", async () => {
		result = { rows: [rows[0]!] };
		const view = renderFileView({ nodeId: node._id, filter: "file.name:starts_with:file file.extension:is:html" });
		await screen.findByRole("table", { name: "Folder contents" });
		const filter = sortedChildrenMock.mock.calls.at(-1)![0].filter;
		result = { rows: [rows[0]!], rowsFilter: filter, rowsNamePrefix: "file", isBusy: true, isDone: false };

		view.rerender(
			<FileNodeView
				searchParams={{ nodeId: node._id, filter: "file.name:starts_with:other file.extension:is:html" }}
				onNavigateSearch={view.onNavigateSearch}
			/>,
		);
		expect(sortedChildrenMock.mock.calls.at(-1)![0]).toMatchObject({ filter, namePrefix: "other" });
		// The filter and the sort are the same, so only the prefix shows that these rows are held.
		expect(
			screen.getByText("Showing: file.name starts with file and file.extension is html. Sort: file.name ↑."),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Show more" })).toHaveProperty("disabled", true);
	});

	test("Enter commits a typed filter into the URL, and a second filter is refused with a reason", async () => {
		const { onNavigateSearch } = renderFileView({ nodeId: node._id });
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });

		fireEvent.change(input, { target: { value: "file.name:starts_with:abc" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(onNavigateSearch).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "file.name:starts_with:abc" }), {
			replace: false,
		});

		fireEvent.change(input, { target: { value: "file.name:starts_with:xyz" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(screen.getByRole("alert").textContent).toContain("Use one filter, or 'name starts with' plus one 'is' filter.");
		expect(input).toHaveProperty("value", "file.name:starts_with:xyz");
	});

	test("the bar suggests only the filters that can join the committed one", async () => {
		const suggestions = (heading: string) =>
			within(screen.getByRole("group", { name: heading }))
				.getAllByRole("option")
				.map((option) => option.querySelector(".FileNodeViewFolderFilterBar-suggestion-label")?.textContent);
		const view = renderFileView({ nodeId: node._id, filter: "file.name:starts_with:abc" });
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });
		act(() => input.focus());

		// Next to a name prefix only an "is" filter can join.
		const nextToPrefix = suggestions("Filter by");
		expect(nextToPrefix).toEqual(expect.arrayContaining(["file.extension", "file.size"]));
		for (const field of ["file.name", "file.updated", "file.created"]) expect(nextToPrefix).not.toContain(field);
		fireEvent.change(input, { target: { value: "file.size:" } });
		const sizeOperations = suggestions("How to compare file.size");
		expect(sizeOperations).toContain("is");
		expect(sizeOperations).not.toContain("at_least");
		expect(sizeOperations).not.toContain("at_most");

		// Next to an "is" filter only the name prefix can join.
		fireEvent.change(input, { target: { value: "" } });
		view.rerender(
			<FileNodeView
				searchParams={{ nodeId: node._id, filter: "file.extension:is:html" }}
				onNavigateSearch={view.onNavigateSearch}
			/>,
		);
		expect(suggestions("Filter by")).toEqual(["file.name"]);

		// A range filter takes no second filter.
		view.rerender(
			<FileNodeView
				searchParams={{ nodeId: node._id, filter: "file.size:at_least:1" }}
				onNavigateSearch={view.onNavigateSearch}
			/>,
		);
		expect(screen.queryByRole("group", { name: "Filter by" })).toBeNull();
		expect(screen.getByText("Use one filter, or 'name starts with' plus one 'is' filter.")).toBeTruthy();
	});

	test("typing writes view_q after the debounce, and the column menu starts a new filter", async () => {
		// Render by hand: the debounce writes from an effect, and the harness would rerender inside it.
		result = { rows: [rows[0]!] };
		const onNavigateSearch = vi.fn();
		render(
			<FileNodeView
				searchParams={{ nodeId: node._id, filter: "file.name:starts_with:abc", view_q: "" }}
				onNavigateSearch={onNavigateSearch}
			/>,
			{
				wrapper: ({ children }) => (
					<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
						<FilesClipboardProvider membershipId={tenantContextMock().membershipId}>{children}</FilesClipboardProvider>
					</AppActivitiesProvider>
				),
			},
		);
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });

		fireEvent.change(input, { target: { value: "file.na" } });
		await waitFor(() =>
			expect(onNavigateSearch).toHaveBeenLastCalledWith(expect.objectContaining({ view_q: "file.na" }), {
				replace: true,
			}),
		);

		// "Filter by" drops the committed filter and keeps its field in the text.
		const table = await screen.findByRole("table", { name: "Folder contents" });
		fireEvent.click(within(table).getByRole("button", { name: "Column options for file.updated" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Filter by file.updated" }));
		expect(onNavigateSearch).toHaveBeenLastCalledWith(expect.objectContaining({ filter: undefined }), {
			replace: false,
		});
		expect(input).toHaveProperty("value", "file.updated:");
	});

	test("Backspace on an empty text reaches the last chip, and removing a chip drops its token", async () => {
		const { onNavigateSearch } = renderFileView({
			nodeId: node._id,
			filter: "file.name:starts_with:abc sort_by:file.name:desc",
		});
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });

		fireEvent.keyDown(input, { key: "Backspace", code: "Backspace" });
		const removeButton = screen.getByRole("button", { name: "Remove sort_by:file.name:desc" });
		expect(document.activeElement).toBe(removeButton);

		fireEvent.click(removeButton);
		expect(onNavigateSearch).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "file.name:starts_with:abc" }), {
			replace: false,
		});
	});

	test("a day filter covers the local calendar day, 25 hours on the day the clocks go back", async () => {
		renderFileView({ nodeId: node._id, filter: "file.updated:on:2026-10-25" });
		await screen.findByRole("table", { name: "Folder contents" });

		// The test time zone is Europe/London.
		const filter = sortedChildrenMock.mock.calls.at(-1)![0].filter;
		if (filter?.kind !== "date") throw new Error("Expected a date filter");
		expect(filter.end - filter.start).toBe(25 * 60 * 60 * 1000);
	});

	test("links to another node drop the filter and the typed text", async () => {
		result = { rows: [rows[0]!] };
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:a", view_q: "typed" });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		const links = Array.from(document.querySelectorAll("a[data-node-id]"));

		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(link.getAttribute("data-filter")).toBeNull();
			expect(link.getAttribute("data-view-q")).toBeNull();
		}
		expect(within(table).getAllByRole("link", { name: /^Open / }).length).toBeGreaterThan(0);
	});

	test("keeps the old filter label and rows through newer filter changes", async () => {
		folderSort = { sort: [{ field: "name", direction: "asc" }], canSave: false };
		result = { rows: [rows[0]!] };
		const view = renderFileView({ nodeId: node._id, filter: "file.updated:on:2026-10-25" });
		await screen.findByRole("table", { name: "Folder contents" });
		const oldFilter = sortedChildrenMock.mock.calls.at(-1)![0].filter;
		result = {
			rows: [rows[0]!],
			rowsFilter: oldFilter,
			rowsSort: [{ field: "name", direction: "asc" }],
			isBusy: true,
			isDone: false,
		};

		for (const value of ["second", "third"]) {
			view.rerender(
				<FileNodeView
					searchParams={{ nodeId: node._id, filter: `file.name:starts_with:${value}` }}
					onNavigateSearch={view.onNavigateSearch}
				/>,
			);
			expect(screen.getByText("Showing: file.updated on 2026-10-25. Sort: file.name ↑.")).toBeTruthy();
			expect(screen.getByText("Applying filter…")).toBeTruthy();
			const table = screen.getByRole("table", { name: "Folder contents" });
			expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-filter-state")).toBe("applying");
			expect(screen.getByRole("button", { name: "Show more" })).toHaveProperty("disabled", true);
			expect(screen.getByRole("link", { name: "Open file-0.html" })).toBeTruthy();
		}
		expect(mutationMock).not.toHaveBeenCalled();
	});

	test.each([
		{ name: "finished", overrides: { isDone: true }, message: "No rows match this filter" },
		{
			name: "short page",
			overrides: { isDone: false, isBusy: false },
			message: "No matches loaded yet. Show more to keep looking.",
		},
	])("shows the honest zero-row state for $name and keeps the toolbar", async ({ overrides, message }) => {
		result = { rows: [], ...overrides };
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:absent" });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-filter-state")).toBe("ready");
		expect(screen.getByText(message)).toBeTruthy();
		expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
		for (const name of ["Columns", "Clear filter and sort"]) expect(screen.getByRole("button", { name })).toBeTruthy();
		if (message !== "No rows match this filter") expect(screen.queryByText("No rows match this filter")).toBeNull();
	});

	test("keeps a loading filter out of the empty state, and Show more keeps looking after a short page", async () => {
		result = { rows: undefined, isBusy: true, isDone: false };
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:rare" });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(screen.getByText("Applying filter…")).toBeTruthy();
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-filter-state")).toBe("applying");
		expect(screen.queryByText("No rows match this filter")).toBeNull();
		result = { rows: [], isBusy: false, isDone: false };
		pushQueryChanges();
		expect(table.closest(".FileNodeViewFolderExplorer")!.getAttribute("data-filter-state")).toBe("ready");
		expect(table.getAttribute("aria-busy")).toBe("false");
		expect(screen.getByText("No matches loaded yet. Show more to keep looking.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(loadMorePendingMock).toHaveBeenCalledTimes(1);
		expect(sortedChildrenMock.mock.calls.at(-1)![0].filter).toEqual({
			kind: "name",
			field: "name",
			op: "starts_with",
			value: "rare",
		});
	});

	test("Show more shows the hidden rows first, then loads more, and Show less collapses", async () => {
		result = { rows, isDone: false };
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:file" });
		const table = await screen.findByRole("table", { name: "Folder contents" });
		expect(within(table).getAllByRole("link", { name: /^Open / })).toHaveLength(5);
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(within(table).getAllByRole("link", { name: /^Open / })).toHaveLength(7);
		expect(loadMorePendingMock).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Show more" }));
		expect(loadMorePendingMock).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Show less" }));
		expect(within(table).getAllByRole("link", { name: /^Open / })).toHaveLength(5);
	});

	test("keeps Clear and Retry on an error but removes the table when the folder is refused", async () => {
		result = { rows: [], isDone: false };
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:file" });
		await screen.findByRole("table", { name: "Folder contents" });
		result = { rows: [], isDone: false, isFailed: true };
		pushQueryChanges();
		expect(screen.getByRole("alert").textContent).toBe("Filter could not be applied");
		expect(screen.getByRole("button", { name: "Clear filter and sort" })).toBeTruthy();
		expect(screen.getByRole("table", { name: "Folder contents" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(retry).toHaveBeenCalledTimes(1);
		result = { rows: undefined, isFailed: true, isFolderRefused: true };
		pushQueryChanges();
		expect(screen.getByRole("alert").textContent).toBe("This folder could not be loaded.");
		expect(screen.queryByRole("table", { name: "Folder contents" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Clear filter and sort" })).toBeNull();
	});

	test("a metadata filter shows no shared row and says why, through the real hook", async () => {
		sortedChildrenMock.mockReset();
		sharedRows = [
			{ ...NODE, _id: "a-shared.html", name: "a-shared.html", path: "/Docs/a-shared.html", parentId: node._id },
		];
		hasShared = true;
		renderFileView({ nodeId: node._id, filter: "metadata.status:is:Open" });
		await screen.findByRole("link", { name: "Open file-1.html" });
		expect(screen.queryByRole("link", { name: "Open a-shared.html" })).toBeNull();
		expect(
			screen.getByText("Items shared with you are not shown while sorting or filtering by metadata.status."),
		).toBeTruthy();

		// A name filter reads the share stream, so the shared row shows and the note goes.
		cleanup();
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:a" });
		expect(await screen.findByRole("link", { name: "Open a-shared.html" })).toBeTruthy();
		expect(screen.queryByText(/^Items shared with you/)).toBeNull();
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
		).toEqual([
			"Code",
			"Review changes",
			"Preview",
			"Browser",
			"Code + Browser",
			"Review changes + Browser",
			"File details",
			"File viewer",
		]);
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
		expect(await screen.findAllByRole("option")).toHaveLength(8);
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
			options: [
				"Code",
				"Review changes",
				"Preview",
				"Browser",
				"Code + Browser",
				"Review changes + Browser",
				"File details",
			],
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

	test.each([
		{
			name: "rich text",
			node: { ...NODE, name: "notes.md", contentType: "text/markdown", textKind: "rich_text" },
			search: { view: "rich_text_editor" },
		},
		{
			name: "plain text asked for rich text",
			node: { ...NODE, name: "data.json", contentType: "application/json" },
			search: { view: "plain_text_editor" },
		},
		{ name: "HTML", node: NODE, search: { fileView: "code" } },
		{
			name: "stored image",
			node: { ...NODE, name: "image.png", contentType: "image/png", textKind: null },
			search: { fileView: "details" },
		},
	])("writes the shown $name view into the URL once", async (fixture) => {
		node = fixture.node;
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, q: "page" });
		await screen.findByRole("combobox", { name: /^View: / });
		await act(async () => {});
		expect(onNavigateSearch.mock.calls).toEqual([
			[{ nodeId: NODE._id, q: "page", ...fixture.search }, { replace: true }],
		]);
	});

	test("writes nothing when the URL already names the shown view", async () => {
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, fileView: "code" });
		await screen.findByRole("combobox", { name: "View: Code" });
		await act(async () => {});
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("search and arrow keys leave the view unchanged until Enter selects an option", async () => {
		plugins = [PLUGIN];
		const { otherNavigations } = renderFileView();
		const trigger = await screen.findByRole("combobox", { name: "View: Code" });
		act(() => trigger.focus());
		const search = await openViewPicker();
		await waitFor(() => expect(document.activeElement).toBe(search));

		fireEvent.change(search, { target: { value: "File" } });
		const viewer = await screen.findByRole("option", { name: "File viewer" });
		fireEvent.pointerMove(viewer);
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
		expect(otherNavigations).not.toHaveBeenCalled();

		fireEvent.keyDown(search, { key: "Escape" });
		await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));

		fireEvent.click(trigger);
		const reopenedSearch = await screen.findByRole<HTMLInputElement>("combobox", { name: "Search views" });
		expect(reopenedSearch.value).toBe("");
		expect(screen.getAllByRole("option")).toHaveLength(8);
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
		const { otherNavigations } = renderFileView();
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
		expect(otherNavigations).not.toHaveBeenCalled();
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
		"Review opens the flat review view from %s and keeps it in the URL",
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
			expect(await screen.findByRole("combobox", { name: "View: Review changes" })).toBeTruthy();
			expect(screen.getByTestId("editor").getAttribute("data-mode")).toBe("diff_editor");
			expect(onNavigateSearch.mock.calls.at(-1)?.[0]).toEqual({
				nodeId: NODE._id,
				view: "diff_editor",
				fileView: "review",
				q: "page",
			});
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

	test("the Review option leaves a plugin and keeps Review in the URL", async () => {
		plugins = [PLUGIN];
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, q: "page" });
		await selectView("File viewer");
		expect(onNavigateSearch.mock.calls.at(-1)?.[0]).toEqual({
			nodeId: NODE._id,
			fileView: "plugin_file-viewer_file",
			q: "page",
		});

		await selectView("Review changes");
		expect(onNavigateSearch.mock.calls.at(-1)?.[0]).toEqual({ nodeId: NODE._id, fileView: "review", q: "page" });
		expect(screen.getByRole("combobox", { name: "View: Review changes" })).toBeTruthy();
		expect(screen.getByTestId("editor").getAttribute("data-mode")).toBe("diff_editor");
		expect(screen.queryByTestId("plugin-frame")).toBeNull();
		expect(pluginUnmountMock).toHaveBeenCalledTimes(1);
	});

	test("an automatic Diff exit keeps Preview selected", async () => {
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, view: "diff_editor" });
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Preview");
		await screen.findByTestId("html-preview");

		const editorProps = editorRenderMock.mock.calls.at(-1)![0];
		act(() => editorProps.onAutomaticEditorModeChange?.("plain_text_editor", { replace: true }));
		expect(onNavigateSearch).toHaveBeenLastCalledWith(
			{ nodeId: NODE._id, view: "plain_text_editor", fileView: "preview", q: undefined },
			{ replace: true },
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

describe("FileNodeView browser views", () => {
	test.each(["file", "folder", "root"])("keeps the session when selecting a %s", async (kind) => {
		const { rerender, onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		browserSession = { mode: "file", sessionId: "session_previous", nodeId: NODE._id, targetKind: "saved" };
		node = {
			...NODE,
			_id: "node_next",
			name: "notes.txt",
			contentType: "text/plain",
			kind: kind === "folder" ? "folder" : "file",
		};
		rerender(
			<FileNodeView
				searchParams={{ nodeId: kind === "root" ? "root" : node._id }}
				onNavigateSearch={onNavigateSearch}
			/>,
		);
		await act(async () => {});
		const endCalls = actionMock.mock.calls.filter((call) => getFunctionName(call[0]) === "files_browser:end_browser");
		expect(endCalls.map(([, args]) => args)).toEqual([]);
	});

	test("keeps the Browser view in the URL and opens it again from the URL", async () => {
		treeNodes = [NODE];
		const { onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Browser");
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
		expect(onNavigateSearch.mock.calls.at(-1)?.[0]).toEqual({ nodeId: NODE._id, fileView: "browser" });

		cleanup();
		renderFileView({ nodeId: NODE._id, fileView: "browser" });
		expect(await screen.findByRole("combobox", { name: "View: Browser" })).toBeTruthy();
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
	});

	test("opens a plugin view from the URL once the plugin views load", async () => {
		renderFileView({ nodeId: NODE._id, fileView: "plugin_file-viewer_file" });
		await screen.findByRole("combobox", { name: /^View: / });

		plugins = [PLUGIN];
		pushQueryChanges();
		expect(await screen.findByTestId("plugin-frame")).toHaveProperty("dataset.plugin", PLUGIN.pluginName);
		expect(toast.info).not.toHaveBeenCalled();
	});

	test("lists the flat browser views for HTML files", async () => {
		treeNodes = [NODE];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await openViewPicker();
		for (const name of [
			"Code",
			"Review changes",
			"Preview",
			"Browser",
			"Code + Browser",
			"Review changes + Browser",
			"File details",
		]) {
			expect(screen.getByRole("option", { name })).toBeTruthy();
		}
	});

	test("hides the browser views for non-HTML files", async () => {
		node = { ...NODE, name: "notes.txt", contentType: "text/plain" };
		treeNodes = [node];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await openViewPicker();
		expect(screen.queryByRole("option", { name: "Browser" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Code + Browser" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Review changes + Browser" })).toBeNull();
	});

	test("the Browser view fills the page and keeps the editor draft mounted once", async () => {
		treeNodes = [NODE];
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "local draft" } });
		await selectView("Browser");
		// Browser-only view hides the editor panel but keeps it mounted.
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Code draft" })).toBeNull();
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		await selectView("Code");
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editor).toHaveProperty("value", "local draft");
		expect(editorMountMock).toHaveBeenCalledTimes(1);
	});

	test("shows both editor and browser in Code + Browser", async () => {
		treeNodes = [NODE];
		renderFileView();
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Code + Browser");
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editorMountMock).toHaveBeenCalledTimes(1);
	});

	test("an open_browser event selects the file and opens the Browser view", async () => {
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Preview");
		act(() =>
			global_custom_event_dispatch("files::open_browser", {
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: NODE._id,
				targetKind: "saved",
			}),
		);
		const panel = await screen.findByRole("region", { name: "Shared browser" });
		expect(panel.closest("[hidden]")).toBeNull();
		expect(editorMountMock).toHaveBeenCalledTimes(1);
	});

	test("an open_browser event keeps a view that already shows the browser", async () => {
		treeNodes = [NODE];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Code + Browser");
		act(() =>
			global_custom_event_dispatch("files::open_browser", {
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: NODE._id,
				targetKind: "saved",
			}),
		);
		expect(screen.getByRole("combobox", { name: "View: Code + Browser" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBeTruthy();
	});

	test("an open_browser event for another file navigates to it", async () => {
		const { rerender, onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		act(() =>
			global_custom_event_dispatch("files::open_browser", {
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: "node_next",
				targetKind: "saved",
			}),
		);
		expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "node_next", fileView: "browser", q: undefined });
		node = { ...NODE, _id: "node_next" };
		rerender(
			<FileNodeView searchParams={{ nodeId: node._id, fileView: "browser" }} onNavigateSearch={onNavigateSearch} />,
		);
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
	});

	test("leaving a browser view keeps its session", async () => {
		treeNodes = [NODE];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Browser");
		browserSession = {
			mode: "file",
			sessionId: "session_1",
			targetKind: "saved",
			nodeId: NODE._id,
			path: NODE.path,
			navigationGeneration: 1,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			controlGen: 1,
			control: "ready",
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 1_200_000,
		};
		pushQueryChanges();
		await screen.findByRole("region", { name: "Shared browser" });
		actionMock.mockClear();
		await selectView("Code");
		await act(async () => {});
		const endCalls = actionMock.mock.calls.filter((call) => getFunctionName(call[0]) === "files_browser:end_browser");
		expect(endCalls.map(([, args]) => args)).toEqual([]);
		expect(screen.queryByRole("region", { name: "Shared browser" })).toBeNull();
	});

	test("never ends a web session when the view or the selection changes", async () => {
		treeNodes = [NODE];
		const { rerender, onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		browserSession = {
			mode: "web",
			sessionId: "session_web",
			navigationGeneration: 1,
			loadGen: 1,
			controlGen: 1,
			control: "ready",
			agentAccess: true,
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 1_200_000,
		};
		pushQueryChanges();
		await selectView("Browser");
		expect(await screen.findByRole("button", { name: "Start shared browser" })).toBeTruthy();
		const browserQueries = queryMock.mock.calls.filter(
			([reference]) => getFunctionName(reference) === "files_browser:current_browser_session",
		);
		expect(browserQueries.map(([, args]) => args)).toEqual(
			browserQueries.map(() => ({ membershipId: "membership_1", mode: "file" })),
		);
		await selectView("Code");
		node = { ...NODE, _id: "node_next", name: "notes.txt", contentType: "text/plain" };
		rerender(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={onNavigateSearch} />);
		await screen.findByRole("textbox", { name: "Code draft" });
		await act(async () => {});
		const endCalls = actionMock.mock.calls.filter((call) => getFunctionName(call[0]) === "files_browser:end_browser");
		expect(endCalls.map(([, args]) => args)).toEqual([]);
	});

	test("a live session does not steal the Code view", async () => {
		treeNodes = [NODE];
		browserSession = {
			mode: "file",
			sessionId: "session_1",
			targetKind: "saved",
			nodeId: NODE._id,
			path: NODE.path,
			navigationGeneration: 1,
			sourceKind: "saved",
			sourceVersion: "v1",
			sourceHash: "hash",
			loadGen: 1,
			controlGen: 1,
			control: "ready",
			idleUntil: Date.now() + 300_000,
			totalUntil: Date.now() + 1_200_000,
		};
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		expect(screen.queryByRole("region", { name: "Shared browser" })).toBeNull();
	});

	test("an open_browser event for a non-HTML file stays on Code quietly", async () => {
		node = { ...NODE, name: "notes.txt", contentType: "text/plain" };
		treeNodes = [node];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		act(() =>
			global_custom_event_dispatch("files::open_browser", {
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: node._id,
				targetKind: "saved",
			}),
		);
		await waitFor(() => expect(screen.getByRole("combobox", { name: "View: Code" })).toBeTruthy());
		expect(screen.queryByRole("region", { name: "Shared browser" })).toBeNull();
		expect(toast.info).not.toHaveBeenCalled();
	});

	test("the Review button from Code + Browser keeps the split", async () => {
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
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Code + Browser");
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
		fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
		expect(await screen.findByRole("combobox", { name: "View: Review changes + Browser" })).toBeTruthy();
		expect(screen.getByTestId("editor").getAttribute("data-mode")).toBe("diff_editor");
		expect(screen.getByRole("region", { name: "Shared browser" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBeTruthy();
	});

	test("a private Browser view keeps the draft mounted once", async () => {
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		const editor = await screen.findByRole("textbox", { name: "Code draft" });
		fireEvent.change(editor, { target: { value: "<p>Private local draft</p>" } });
		act(() =>
			global_custom_event_dispatch("files::open_browser", {
				membershipId: "membership_1" as app_convex_Id<"organizations_workspaces_users">,
				nodeId: PRIVATE_ENTRY.node._id,
				targetKind: "private",
			}),
		);
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
		expect(editorMountMock).toHaveBeenCalledTimes(1);
		await selectView("Code");
		expect(screen.getByRole("textbox", { name: "Code draft" })).toBe(editor);
		expect(editor).toHaveProperty("value", "<p>Private local draft</p>");
		expect(editorMountMock).toHaveBeenCalledTimes(1);
	});
});

describe("FileNodeView header breadcrumb", () => {
	const DOCS = { ...NODE, _id: "folder_docs", name: "Docs", path: "/Docs", kind: "folder" };
	const PAGE_IN_DOCS = { ...NODE, parentId: DOCS._id, path: "/Docs/page.html" };

	function currentCrumb() {
		return header.querySelector<HTMLElement>('[aria-current="page"]')!;
	}

	async function openCurrentCrumbMenu(name: string) {
		fireEvent.click(within(currentCrumb()).getByRole("button", { name }));
		return await screen.findByRole("menu");
	}

	function archiveCalls() {
		return mutationMock.mock.calls.filter(([reference]) => getFunctionName(reference) === "files_nodes:archive_nodes");
	}

	test("renders the ancestors as links and the open file as a menu button", async () => {
		node = PAGE_IN_DOCS;
		treeNodes = [DOCS, node];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });

		// The ancestors are their own list, nested in the breadcrumb list.
		const [breadcrumb, ancestors] = within(header).getAllByRole("list");
		expect(ancestors!.parentElement!.parentElement).toBe(breadcrumb);
		expect(
			within(ancestors!)
				.getAllByRole("link")
				.map((link) => link.getAttribute("aria-label")),
		).toEqual(["Docs"]);
		const current = within(currentCrumb()).getByRole("button", { name: "page.html" });
		expect(current.getAttribute("aria-haspopup")).toBe("menu");

		const menu = await openCurrentCrumbMenu("page.html");
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Reveal in sidebar", "Duplicate tab", "Copy node id", "Archive"]);
	});

	test.each(["a read-only file", "a folder with a protected descendant"])("hides Archive for %s", async (kind) => {
		if (kind === "a read-only file") {
			node = { ...NODE, canWrite: false };
			treeNodes = [node];
		} else {
			node = DOCS;
			treeNodes = [DOCS, { ...PAGE_IN_DOCS, canWrite: false }];
		}
		renderFileView({ nodeId: node._id });
		await screen.findByRole("button", { name: `Properties of ${node.name}` });

		const menu = await openCurrentCrumbMenu(node.name);
		expect(within(menu).getByRole("menuitem", { name: "Copy node id" })).toBeTruthy();
		expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
	});

	test("hides Reveal in sidebar for an archived file", async () => {
		node = { ...NODE, archiveOperationId: "qa-archive" };
		treeNodes = [node];
		renderFileView();
		await screen.findByRole("button", { name: `Properties of ${node.name}` });

		const menu = await openCurrentCrumbMenu("page.html");
		expect(within(menu).getByRole("menuitem", { name: "Copy node id" })).toBeTruthy();
		expect(within(menu).queryByRole("menuitem", { name: "Reveal in sidebar" })).toBeNull();
	});

	test("Archive asks first, then archives the open file and returns Home", async () => {
		mutationMock.mockResolvedValue({ _yay: null });
		const { onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		const menu = await openCurrentCrumbMenu("page.html");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));

		const dialog = await screen.findByRole("dialog", { name: "Archive “page.html”?" });
		expect(archiveCalls()).toEqual([]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(archiveCalls()).toHaveLength(1));
		expect(archiveCalls()[0]![1]).toEqual({ membershipId: "membership_1", nodeIds: [NODE._id] });
		await waitFor(() =>
			expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "root", view: undefined, q: undefined }),
		);
	});

	test("Cancel closes the Archive dialog without a write", async () => {
		const { otherNavigations } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		const menu = await openCurrentCrumbMenu("page.html");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));

		const dialog = await screen.findByRole("dialog", { name: "Archive “page.html”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(archiveCalls()).toEqual([]);
		expect(otherNavigations).not.toHaveBeenCalled();
	});

	test("the folder explorer row menu archives that row through the same dialog", async () => {
		mutationMock.mockResolvedValue({ _yay: null });
		node = DOCS;
		treeNodes = [DOCS, PAGE_IN_DOCS];
		const { onNavigateSearch } = renderFileView({ nodeId: node._id });
		fireEvent.click(await screen.findByRole("button", { name: "More actions for page.html" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

		const dialog = await screen.findByRole("dialog", { name: "Archive “page.html”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

		await waitFor(() => expect(archiveCalls()).toHaveLength(1));
		expect(archiveCalls()[0]![1]).toEqual({ membershipId: "membership_1", nodeIds: [PAGE_IN_DOCS._id] });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// The row leaves through the live tree query. The open folder stays open.
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("Reveal in sidebar sends the reveal event for the open file", async () => {
		const handleReveal = vi.fn();
		const stopListening = global_custom_event_listen({ event: "files::reveal_node", handler: handleReveal });
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		const menu = await openCurrentCrumbMenu("page.html");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Reveal in sidebar" }));

		expect(handleReveal).toHaveBeenCalled();
		expect(handleReveal.mock.calls[0]![0].detail).toEqual({ membershipId: "membership_1", nodeId: NODE._id });
		stopListening();
	});

	test("Duplicate tab opens the current URL in a new tab", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		const menu = await openCurrentCrumbMenu("page.html");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Duplicate tab" }));

		expect(open).toHaveBeenCalledWith(window.location.href, "_blank", "noopener");
		open.mockRestore();
	});

	test("the root crumb is not a menu button", async () => {
		treeNodes = [];
		renderFileView({ nodeId: "root" });
		await screen.findByRole("heading", { name: "No README.md" });

		const [breadcrumb] = within(header).getAllByRole("list");
		expect(within(breadcrumb!).getByText("Home")).toBeTruthy();
		expect(within(breadcrumb!).queryAllByRole("button")).toEqual([]);
		expect(header.querySelector('[aria-current="page"]')).toBeNull();
	});

	test("a pending entry gets crumbs for its saved and pending parents", async () => {
		const reports = { ...DOCS, _id: "folder_reports", name: "Reports", path: "/Reports" };
		treeNodes = [reports];
		privateView = {
			...privateView!,
			entry: { ...PRIVATE_ENTRY, path: "/Reports/Drafts/draft.html" },
			requiredParents: [
				{
					target: { kind: "private", id: "private_parent" as app_convex_Id<"files_pending_nodes"> },
					path: "/Reports/Drafts",
					pendingUpdateId: "pending_parent" as app_convex_Id<"files_pending_updates">,
					reviewedRevision: 1,
				},
			],
			savedParentId: reports._id as app_convex_Id<"files_nodes">,
		};
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });

		const [, ancestors] = within(header).getAllByRole("list");
		expect(
			within(ancestors!)
				.getAllByRole("link")
				.map((link) => [link.getAttribute("aria-label"), link.dataset.nodeId, link.dataset.pendingNodeId]),
		).toEqual([
			["Reports", reports._id, undefined],
			["Drafts", undefined, "private_parent"],
		]);
		const menu = await openCurrentCrumbMenu("draft.html");
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Duplicate tab", "Copy node id"]);
	});

	test("a pending entry gets crumbs for every saved parent when its folders are not loaded", async () => {
		const a = { ...DOCS, _id: "folder_a", parentId: "root", name: "a", path: "/a" };
		const b = { ...DOCS, _id: "folder_b", parentId: a._id, name: "b", path: "/a/b" };
		const c = { ...DOCS, _id: "folder_c", parentId: b._id, name: "c", path: "/a/b/c" };
		// Only the root folder is loaded, so `b` and `c` come only from pinning the saved parent.
		treeNodes = [a];
		unloadedTreeNodes = [b, c];
		privateView = {
			...privateView!,
			entry: { ...PRIVATE_ENTRY, path: "/a/b/c/Drafts/draft.html" },
			requiredParents: [
				{
					target: { kind: "private", id: "private_parent" as app_convex_Id<"files_pending_nodes"> },
					path: "/a/b/c/Drafts",
					pendingUpdateId: "pending_parent" as app_convex_Id<"files_pending_updates">,
					reviewedRevision: 1,
				},
			],
			savedParentId: c._id as app_convex_Id<"files_nodes">,
		};
		renderFileView({ pendingNodeId: PRIVATE_ENTRY.node._id });
		await screen.findByRole("textbox", { name: "Code draft" });

		const [, ancestors] = within(header).getAllByRole("list");
		expect(
			within(ancestors!)
				.getAllByRole("link")
				.map((link) => [link.getAttribute("aria-label"), link.dataset.nodeId, link.dataset.pendingNodeId]),
		).toEqual([
			["a", a._id, undefined],
			["b", b._id, undefined],
			["c", c._id, undefined],
			["Drafts", undefined, "private_parent"],
		]);
	});
});
