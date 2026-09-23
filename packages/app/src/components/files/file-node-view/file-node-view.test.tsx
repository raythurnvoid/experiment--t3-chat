import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";
import { encodeStateAsUpdate } from "yjs";
import { files_yjs_doc_create_from_text } from "../../../../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../../../../shared/files.ts";

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
import { global_custom_event_dispatch, global_custom_event_listen } from "@/lib/global-event.tsx";

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
		useConvex: () => ({ mutation: mutationMock, action: actionMock }),
		usePaginatedQuery: (query: never, args: unknown) => {
			const [, forceRender] = useState(0);
			useEffect(() => {
				const listener = () => forceRender((revision) => revision + 1);
				queryPushListeners.add(listener);
				return () => {
					queryPushListeners.delete(listener);
				};
			}, []);
			return {
				results: queryMock(query, args),
				status: pendingListStatus,
				loadMore: loadMorePendingMock,
			};
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
			useFolders: () => ({
				rows: useQuery(api.files_nodes.list_tree, {
					membershipId: tenantContextMock().membershipId,
					paginationOpts: { numItems: 500, cursor: null },
				}),
				statusByFolderId: new Map(),
				hoistedIds: new Set(),
				loadMore: () => {},
			}),
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
	// Expose the link's search params, so a test can tell a saved crumb from a pending one.
	MyLink: (props: {
		children?: ReactNode;
		"aria-label"?: string;
		search?: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>);
	}) => {
		const search = typeof props.search === "function" ? props.search({}) : props.search;
		return (
			<a
				href="#"
				aria-label={props["aria-label"]}
				data-node-id={search?.nodeId as string | undefined}
				data-pending-node-id={search?.pendingNodeId as string | undefined}
			>
				{props.children}
			</a>
		);
	},
	MyLinkIcon: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

import { FileNodeView, type FileNodeView_SearchParams } from "./file-node-view.tsx";
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
			recovery?: { savedParentId: app_convex_Id<"files_nodes">; expiresAt: number | null };
			copyDestination?: { folderPath: string; personal: boolean; replacement: boolean };
	  }
	| null
	| undefined;
let pendingChildren: unknown[];
let header: HTMLDivElement;
let browserSession: unknown;

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
	browserSession = null;
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
			case "files_browser:current_browser_session":
				return browserSession ?? null;
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
				recovery: { savedParentId: NODE._id, expiresAt: null },
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
		expect(screen.getByText("This unsaved draft still has its normal expiry.")).toBeTruthy();
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
					assetId: NODE.assetId as app_convex_Id<"files_r2_assets">,
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
			recovery: { savedParentId: NODE._id as app_convex_Id<"files_nodes">, expiresAt: null },
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
		expect(onNavigateSearch).not.toHaveBeenCalled();
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
	test("shows the first page at once and loads the next page on Show more", async () => {
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
		// The first page shows without waiting for the second one.
		expect(await screen.findByRole("link", { name: "Open e.html" })).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open b.html" })).toBeNull();
		expect(
			queryMock.mock.calls.some(
				([reference, args]) =>
					getFunctionName(reference) === "files_visible:list" && (args as { cursor?: string | null }).cursor,
			),
		).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		secondPageReady = true;
		pushQueryChanges();
		expect(await screen.findByRole("link", { name: "Open f.html" })).toBeTruthy();
		// A later page adds its rows at the end, in the server's order.
		expect(screen.getAllByRole("link", { name: /^Open / }).map((link) => link.getAttribute("aria-label"))).toEqual([
			"Open a.html",
			"Open c.html",
			"Open e.html",
			"Open b.html",
			"Open d.html",
			"Open f.html",
		]);
		expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
		expect(screen.queryByRole("link", { name: "Open f.html" })).toBeNull();
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
		await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
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
		"Review opens the flat review view from %s without navigation",
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
			expect(onNavigateSearch).not.toHaveBeenCalled();
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

	test("the Review option leaves a plugin without navigation", async () => {
		plugins = [PLUGIN];
		const { onNavigateSearch } = renderFileView({ nodeId: NODE._id, q: "page" });
		await selectView("File viewer");

		await selectView("Review changes");
		expect(onNavigateSearch).not.toHaveBeenCalled();
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

describe("FileNodeView browser views", () => {
	test.each(["file", "folder", "root"])("ends the old session when selecting a %s", async (kind) => {
		const { rerender, onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		browserSession = { sessionId: "session_previous", nodeId: NODE._id, targetKind: "saved" };
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
		await waitFor(() => {
			expect(actionMock.mock.calls.filter((call) => getFunctionName(call[0]) === "files_browser:end_browser")).toEqual([
				[expect.anything(), { membershipId: "membership_1", sessionId: "session_previous" }],
			]);
		});
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
		expect(onNavigateSearch).toHaveBeenCalledWith({ nodeId: "node_next", q: undefined });
		node = { ...NODE, _id: "node_next" };
		rerender(<FileNodeView searchParams={{ nodeId: node._id }} onNavigateSearch={onNavigateSearch} />);
		expect(await screen.findByRole("region", { name: "Shared browser" })).toBeTruthy();
	});

	test("leaving a browser view ends its session", async () => {
		treeNodes = [NODE];
		renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		await selectView("Browser");
		browserSession = {
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
		await waitFor(() => {
			expect(actionMock.mock.calls.filter((call) => getFunctionName(call[0]) === "files_browser:end_browser")).toEqual([
				[expect.anything(), { membershipId: "membership_1", sessionId: "session_1" }],
			]);
		});
		expect(screen.queryByRole("region", { name: "Shared browser" })).toBeNull();
	});

	test("a live session does not steal the Code view", async () => {
		treeNodes = [NODE];
		browserSession = {
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
		const { onNavigateSearch } = renderFileView();
		await screen.findByRole("textbox", { name: "Code draft" });
		const menu = await openCurrentCrumbMenu("page.html");
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Archive" }));

		const dialog = await screen.findByRole("dialog", { name: "Archive “page.html”?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(archiveCalls()).toEqual([]);
		expect(onNavigateSearch).not.toHaveBeenCalled();
	});

	test("the folder explorer row menu archives that row through the same dialog", async () => {
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
		const stopListening = global_custom_event_listen("files::reveal_node", handleReveal);
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
});
