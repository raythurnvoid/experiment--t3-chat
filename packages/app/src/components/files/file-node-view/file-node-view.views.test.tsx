// The folder filter, file view, browser view and header breadcrumb tests, split from file-node-view.test.tsx
// so the two files can run at the same time. Keep the mocks the same as in that file.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";
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
import { app_local_storage_set_value } from "@/lib/storage.ts";
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
// Keep the fixed pager results used by this component test.
vi.mock("@/hooks/files-paginated-query-hooks.ts", async () => {
	const { usePaginatedQuery } = await import("convex/react");
	return { useFilesPaginatedQuery: usePaginatedQuery };
});

// The cached hooks use the `convex/react` mock below.
vi.mock("convex-helpers/react/cache", async () => {
	const { useQueries, useQuery } = await import("convex/react");
	return { useQueries, useQuery };
});

vi.mock("convex/react", async () => {
	const { useEffect, useId, useMemo, useState } = await import("react");
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
			const [revision, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			// Convex keeps the same result until the queries or a server answer change.
			return useMemo(
				() =>
					Object.fromEntries(
						Object.entries(queries).map(([key, request]) => [key, queryMock(request.query, request.args)]),
					),
				[queries, revision],
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
				// The query mock ignores these args and answers with every tree row as a plain array, not one folder page.
				const rows = useQuery(api.files_tree.list_tree_children, {
					membershipId,
					parentId: "root",
					kind: "folder",
					archived: false,
					restricted: false,
					paginationOpts: { numItems: 500, cursor: null },
				}) as unknown as Array<{ _id: string }> | undefined;
				// Like the store, add the pinned node and its ancestors. The file view pins at most one node.
				const pin = useQuery(
					api.files_tree.get_tree_ancestors,
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
			// `useFolders` already serves every row.
			useLoadedNode: () => undefined,
			// Unknown by default, so the folder table reads every stream.
			useIsOwner: () => isOwner,
		},
	};
});
vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { useAuthenticated: () => ({ userId: "user_1" }) },
}));
vi.mock("@/lib/files-move-intake.ts", () => ({
	files_move_intake_load: async () => null,
	files_move_intake_save: vi.fn(),
	files_move_intake_read_page: vi.fn(),
	files_move_intake_update: vi.fn(),
	files_move_intake_delete: vi.fn(),
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
type PendingViewFixture =
	| { kind: "restricted"; target: { kind: string; id: string }; pendingUpdateId: string; revision: number }
	| {
			kind: "entry";
			readiness: "ready" | "preparing";
			entry: {
				pendingUpdate: { _id: string; target: { kind: string; id: string }; revision: number; content?: unknown };
			};
	  };
let savedPendingUpdate: unknown;
let pendingListStatus: "CanLoadMore" | "LoadingMore" | "Exhausted";

/**
 * A page of folder keys: the keys that start with the request's prefix, without case.
 */
function test_folder_keys(fields: string[], args: unknown) {
	// Like the server for a member, the restricted twin is empty.
	if (args === "skip" || (args as { restricted: boolean }).restricted) return [];
	const prefix = (args as { prefix: string }).prefix.toLowerCase();
	return fields.filter((field) => field.toLowerCase().startsWith(prefix));
}
// Restricted children shared with this member, on their own share stream. A member reads it only for
// a custom-field filter.
let sharedRows: (typeof NODE)[];
// Children this member cannot open. The restricted twin gives them as locked rows.
let lockedRows: (typeof NODE)[];
// What `has_drafts_in_folder` answers.
let hasDrafts: boolean;
// The caller's permissions in `workspace_1`, from `organizations.list`.
let workspacePermissions: "all" | string[];
// What `FilesTreeProvider.useIsOwner` answers.
let isOwner: boolean | null;
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
	lockedRows = [];
	hasDrafts = false;
	workspacePermissions = "all";
	isOwner = null;
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
			case "files_tree:get_workspace_move_view":
				return { cohortId: null, view: null, generation: 0, searchGeneration: 0 };
			case "files_tree:list_tree_children":
				return treeNodes ?? [node];
			case "files_tree:get_tree_ancestors": {
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
			case "files_tree:get_folder_readme": {
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
			case "files_tree:get_file_node_for_membership":
				return nodeQueryStatus === "loading" ? undefined : nodeQueryStatus === "missing" ? null : node;
			// Tests write owner views. The list returns only the stored fields of each row, and each row
			// loads its view with `get_file_pending_target`.
			case "files_pending_list:list_files_pending_updates":
				return (pendingUpdates as PendingViewFixture[]).map((view, index) => ({
					...(view.kind === "restricted"
						? {
								target: view.target,
								pendingUpdateId: view.pendingUpdateId,
								revision: view.revision,
								hasReadyContent: false,
							}
						: {
								target: view.entry.pendingUpdate.target,
								pendingUpdateId: view.entry.pendingUpdate._id,
								revision: view.entry.pendingUpdate.revision,
								hasReadyContent: view.readiness === "ready" && view.entry.pendingUpdate.content !== undefined,
							}),
					updatedAt: pendingUpdates.length - index,
					listRowCreationTime: index,
					listRowId: `pending_row_${index}`,
				}));
			case "files_pending_list:list_files_pending_sources":
				return pendingUpdates.length > 0
					? [{ listKey: "own", lastUpdatedAt: 1, keyCreationTime: 1, keyId: "own_key" }]
					: [];
			case "files_pending_list:get_files_pending_updates_summary":
				return { count: pendingUpdates.length, truncated: false };
			case "files_pending_updates:get_pending_move_occupant":
				return null;
			case "files_pending_target:get_file_pending_update": {
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
			case "files_pending_target:get_file_pending_target": {
				// A Pending row's view, or else the open draft's view.
				const target = (args as { target: { kind: string; id: string } }).target;
				const view = (pendingUpdates as PendingViewFixture[]).find((view) => {
					const viewTarget = view.kind === "restricted" ? view.target : view.entry.pendingUpdate.target;
					return viewTarget.kind === target.kind && viewTarget.id === target.id;
				});
				return view ? (view.kind === "restricted" ? null : view) : privateView;
			}
			case "files_visible:get_path":
				return node.path;
			case "files_folder_sorts:get_folder_sort":
				return folderSort;
			case "files_tree:list_tree_children_sorted":
			case "files_tree:list_tree_children_shared": {
				// Serve a whole segment at once. The hook's paging has its own tests. The tree rows are open,
				// `lockedRows` come on the twin, and `sharedRows` come on the member's own share stream.
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
					principalIndex === undefined
						? restricted
							? lockedRows
							: (treeNodes ?? [])
						: principalIndex === 0
							? sharedRows
							: [];
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
								...(restricted ? { locked: true } : {}),
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
			case "files_metadata:list_search_fields":
				return [{ fieldPath: "metadata.status", valueKinds: ["string"] }];
			case "files_metadata:list_folder_fields":
				return test_folder_keys(["metadata.status"], args);
			case "files_metadata:get_field_values": {
				const { fields } = args as { fields: string[] };
				return {
					values: fields.map((field) => ({
						field,
						value: field === "metadata.status" ? "Open" : null,
						isPreview: false,
					})),
					afterField: fields.at(-1),
					isDone: true,
				};
			}
			case "files_visible:list_private_folder_children":
				return pendingChildren;
			case "files_tree:has_drafts_in_folder":
				return hasDrafts;
			case "organizations:list":
				return { workspaceIdsPermissionsDict: { workspace_1: workspacePermissions } };
			case "files_transfer_queries:list_current":
				return [];
			case "files_transfer_queries:get":
			case "files_pending_update_runs:get":
				return null;
			case "users:get_anagraphic":
				return anagraphic;
			case "plugins_ui_installed:list_file_views":
				return plugins;
			case "files_node_asset:get_asset_by_file_node_id":
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
				<FilesClipboardProvider
					key={tenantContextMock().membershipId}
					userId={"user_1" as app_convex_Id<"users">}
					membershipId={tenantContextMock().membershipId}
				>
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

describe("FileNodeView folder filter", () => {
	let rows: NonNullable<ReturnType<typeof useFilesSortedChildren>["rows"]>;
	let result: Partial<ReturnType<typeof useFilesSortedChildren>>;
	let rowsByScope: Map<string, typeof rows>;

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
			restrictedNote: null,
			loadMore: loadMorePendingMock,
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
		expect(
			within(table)
				.getByRole("columnheader", { name: /^file\.name ↓/ })
				.getAttribute("aria-sort"),
		).toBe("descending");

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
		expect(
			within(table)
				.getByRole("columnheader", { name: /^file\.name ↑/ })
				.getAttribute("aria-sort"),
		).toBe("ascending");
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
			view.rerender(
				<FileNodeView searchParams={{ nodeId: node._id, filter }} onNavigateSearch={view.onNavigateSearch} />,
			);
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
		expect(onNavigateSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ filter: "file.name:starts_with:abc" }),
			{
				replace: false,
			},
		);

		fireEvent.change(input, { target: { value: "file.name:starts_with:xyz" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		expect(screen.getByRole("alert").textContent).toContain(
			"Use one filter, or 'name starts with' plus one 'is' filter",
		);
		expect(input).toHaveProperty("value", "file.name:starts_with:xyz");
	});

	test("the bar pages the folder's keys and saved values from the server, and retries a failed list", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		let failed = false;
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			const name = getFunctionName(reference);
			if (name === "files_metadata:list_folder_fields") {
				return test_folder_keys(["metadata.status", "metadata.stage", "frontmatter.title"], args);
			}
			if (name !== "files_metadata:list_search_values") return previousQuery(reference, args);
			if (args === "skip") return [];
			if (failed) throw new Error("Read failed");
			// The values of metadata.stage never load.
			if (args.fieldPath === "metadata.stage") return { results: [], status: "LoadingFirstPage" };
			const values = ["open", "opened", "fixed"].filter((value) => value.startsWith(args.prefix));
			return { results: values, status: args.prefix === "" ? "CanLoadMore" : "Exhausted" };
		});
		// Render by hand: the debounce writes from an effect, and the harness would rerender inside it.
		render(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={vi.fn()} />, {
			wrapper: ({ children }) => (
				<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
					<FilesClipboardProvider userId={"user_1" as app_convex_Id<"users">} membershipId={tenantContextMock().membershipId}>
						{children}
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			),
		});
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });
		act(() => input.focus());
		const labels = (heading: string) =>
			within(screen.getByRole("group", { name: heading }))
				.getAllByRole("option")
				.map((option) => option.querySelector(".FileNodeViewFolderFilterBar-suggestion-label")?.textContent ?? option.textContent);

		// A key prefix asks the server, one prefix per namespace, without case.
		fireEvent.change(input, { target: { value: "ST" } });
		await waitFor(() => expect(labels("Filter by")).toEqual(["metadata.stage", "metadata.status"]));
		expect(queryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prefix: "frontmatter.ST" }));
		fireEvent.change(input, { target: { value: "sort_by:tit" } });
		await waitFor(() => expect(labels("Sort by")).toEqual(["frontmatter.title"]));
		fireEvent.change(input, { target: { value: "zzz" } });
		expect(await screen.findByRole("option", { name: "No keys start with zzz" })).toBeTruthy();

		// Values page with Show more, and keep exact case.
		fireEvent.change(input, { target: { value: "metadata.status:is:" } });
		await waitFor(() => expect(labels("Values for metadata.status")).toEqual(["fixed", "open", "opened", "Show more"]));
		fireEvent.click(screen.getByRole("option", { name: "Show more values" }));
		expect(loadMorePendingMock).toHaveBeenCalledWith(50);
		fireEvent.change(input, { target: { value: "metadata.status:is:op" } });
		await waitFor(() => expect(labels("Values for metadata.status")).toEqual(["open", "opened"]));
		// While another key's values load, the held values of this key do not show.
		fireEvent.change(input, { target: { value: "metadata.stage:is:op" } });
		expect(labels("Values for metadata.stage")).toEqual(["Updating suggestions…"]);

		// New typed text clears a failed list, without Retry.
		failed = true;
		fireEvent.change(input, { target: { value: "metadata.status:is:" } });
		expect(await screen.findByRole("option", { name: "Could not load suggestions." })).toBeTruthy();
		failed = false;
		fireEvent.change(input, { target: { value: "metadata.status:is:fi" } });
		await waitFor(() => expect(labels("Values for metadata.status")).toEqual(["fixed"]));

		// A failed list stays in its group, keeps the text, and retries.
		failed = true;
		fireEvent.change(input, { target: { value: "metadata.status:is:f" } });
		// Wait for the debounced text, so only Retry can bring the list back.
		await waitFor(() =>
			expect(queryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prefix: "f" })),
		);
		expect(await screen.findByRole("option", { name: "Could not load suggestions." })).toBeTruthy();
		expect(input).toHaveProperty("value", "metadata.status:is:f");
		failed = false;
		fireEvent.click(screen.getByRole("option", { name: "Retry" }));
		await waitFor(() => expect(labels("Values for metadata.status")).toEqual(["fixed"]));
		consoleError.mockRestore();
	});

	test("the bar tells a member without workspace read why no values are suggested", async () => {
		workspacePermissions = ["files.read"];
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) =>
			// Like the server, a guest gets an empty page.
			getFunctionName(reference) === "files_metadata:list_search_values"
				? { results: [], status: "Exhausted" }
				: previousQuery(reference, args),
		);
		// Render by hand: the debounce writes from an effect, and the harness would rerender inside it.
		render(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={vi.fn()} />, {
			wrapper: ({ children }) => (
				<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
					<FilesClipboardProvider userId={"user_1" as app_convex_Id<"users">} membershipId={tenantContextMock().membershipId}>
						{children}
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			),
		});
		const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });
		act(() => input.focus());
		fireEvent.change(input, { target: { value: "metadata.status:is:" } });
		expect(
			await screen.findByRole("option", {
				name: "Suggestions need access to the whole workspace. You can still type a filter, like metadata.status:open.",
			}),
		).toBeTruthy();
		expect(screen.queryByRole("option", { name: "No saved values" })).toBeNull();
	});

	test.each([
		{ surface: "Columns", text: null, group: "Metadata", more: { role: "button", name: "Show more fields" } },
		{ surface: "filter keys", text: "", group: "Filter by", more: { role: "option", name: "Show more keys" } },
		{ surface: "sort keys", text: "sort_by:", group: "Sort by", more: { role: "option", name: "Show more keys" } },
	])("$surface shows every loaded folder key, and Show more adds the next page", async ({ text, group, more }) => {
		const keys = Array.from({ length: 60 }, (_, index) => `metadata.k${String(index + 1).padStart(2, "0")}`);
		// The server sends 50 keys a page, and Show more adds one page.
		let pageCount = 1;
		loadMorePendingMock.mockImplementation(() => {
			pageCount++;
			queryPushListeners.forEach((listener) => listener());
		});
		const previousQuery = queryMock.getMockImplementation()!;
		queryMock.mockImplementation((reference, args) => {
			if (getFunctionName(reference) !== "files_metadata:list_folder_fields") return previousQuery(reference, args);
			const page = test_folder_keys(keys, args);
			return { results: page.slice(0, pageCount * 50), status: page.length > pageCount * 50 ? "CanLoadMore" : "Exhausted" };
		});
		// Render by hand: the debounce writes from an effect, and the harness would rerender inside it.
		render(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={vi.fn()} />, {
			wrapper: ({ children }) => (
				<AppActivitiesProvider membershipId={tenantContextMock().membershipId}>
					<FilesClipboardProvider userId={"user_1" as app_convex_Id<"users">} membershipId={tenantContextMock().membershipId}>
						{children}
					</FilesClipboardProvider>
				</AppActivitiesProvider>
			),
		});
		if (text === null) {
			fireEvent.click(await screen.findByRole("button", { name: "Columns" }));
		} else {
			const input = await screen.findByRole("combobox", { name: "Filter and sort this folder" });
			act(() => input.focus());
			fireEvent.change(input, { target: { value: text } });
		}
		const labels = () =>
			Array.from(
				screen
					.getByRole("group", { name: group })
					.querySelectorAll("[data-column-field], .FileNodeViewFolderFilterBar-suggestion-label"),
				(label) => label.getAttribute("data-column-field") ?? label.textContent,
			).filter((label) => label.startsWith("metadata."));

		await waitFor(() => expect(labels()).toEqual(keys.slice(0, 50)));
		fireEvent.click(screen.getByRole(more.role, { name: more.name }));
		await waitFor(() => expect(labels()).toEqual(keys));
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
		expect(screen.getByText("Use one filter, or 'name starts with' plus one 'is' filter")).toBeTruthy();
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
						<FilesClipboardProvider
							userId={"user_1" as app_convex_Id<"users">}
							membershipId={tenantContextMock().membershipId}
						>
							{children}
						</FilesClipboardProvider>
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
		expect(onNavigateSearch).toHaveBeenLastCalledWith(
			expect.objectContaining({ filter: "file.name:starts_with:abc" }),
			{
				replace: false,
			},
		);
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

	test("a member's custom-field filter shows their shares, leaves out locked rows and says so, through the real hook", async () => {
		sortedChildrenMock.mockReset();
		isOwner = false;
		sharedRows = [
			{ ...NODE, _id: "a-shared.html", name: "a-shared.html", path: "/Docs/a-shared.html", parentId: node._id },
		];
		lockedRows = [
			{ ...NODE, _id: "a-locked.html", name: "a-locked.html", path: "/Docs/a-locked.html", parentId: node._id },
		];
		renderFileView({ nodeId: node._id, filter: "metadata.status:is:Open" });
		await screen.findByRole("link", { name: "Open file-1.html" });
		expect(await screen.findByRole("link", { name: "Open a-shared.html" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: /^Open a-locked\.html/ })).toBeNull();
		expect(screen.getByText("Locked items are not included when you filter by a custom field.")).toBeTruthy();

		// A name filter reads the twin, so the locked row shows and the note goes.
		cleanup();
		renderFileView({ nodeId: node._id, filter: "file.name:starts_with:a" });
		expect(await screen.findByRole("link", { name: "Open a-locked.html, you don't have access" })).toBeTruthy();
		expect(screen.queryByText(/^Locked items are not included/)).toBeNull();
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
