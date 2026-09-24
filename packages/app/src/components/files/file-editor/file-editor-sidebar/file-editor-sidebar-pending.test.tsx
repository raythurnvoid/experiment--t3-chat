import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

const {
	tenantContextMock,
	useQueryMock,
	useQueriesMock,
	treeNodesMock,
	actionMock,
	mutationMock,
	queryMock,
	startReviewMock,
	fetchFileYjsStateAndTextMock,
	fetchPendingStateMock,
	downloadBlobMock,
	upsertPendingMock,
	truncatePathForWidthMock,
	loadMoreMock,
	pagination,
	reviewStart,
} = vi.hoisted(() => ({
	tenantContextMock: vi.fn(),
	useQueryMock: vi.fn(),
	useQueriesMock: vi.fn(),
	treeNodesMock: vi.fn(),
	actionMock: vi.fn(),
	mutationMock: vi.fn(),
	queryMock: vi.fn(),
	startReviewMock: vi.fn(),
	fetchFileYjsStateAndTextMock: vi.fn(),
	fetchPendingStateMock: vi.fn(),
	downloadBlobMock: vi.fn(),
	upsertPendingMock: vi.fn(),
	truncatePathForWidthMock: vi.fn((args: { path: string }) => args.path),
	loadMoreMock: vi.fn(),
	pagination: { status: "Exhausted" as "CanLoadMore" | "LoadingMore" | "Exhausted" },
	reviewStart: { isStarting: false, listeners: new Set<() => void>() },
}));

// Network boundary: the real hooks talk to a live Convex client; tests feed query data directly.
vi.mock("convex/react", () => ({
	usePaginatedQuery: (...args: unknown[]) => {
		const result = useQueryMock(...args);
		return {
			results: makeOwnerViewFixtures(result) ?? [],
			status: result === undefined ? "LoadingFirstPage" : pagination.status,
			loadMore: loadMoreMock,
		};
	},
	useQuery: (...args: unknown[]) => {
		const result = useQueryMock(...args);
		return args[0] === "list_files_pending_updates" ? makeOwnerViewFixtures(result) : result;
	},
	useQueries: (queries: Record<string, { query: unknown }>) => useQueriesMock(queries),
	useConvex: () => ({ action: actionMock, mutation: mutationMock, query: queryMock }),
}));

// Review submission is tested through the real Activity provider in app-notifications.test.tsx.
// Like the real provider, `isStartingReview` stays true until the `startReview` promise settles.
// A mock that always says false would let a test click buttons the real panel disables.
vi.mock("@/lib/app-activities-context.tsx", async () => {
	const { useSyncExternalStore } = await import("react");

	const setIsStarting = (isStarting: boolean) => {
		reviewStart.isStarting = isStarting;
		reviewStart.listeners.forEach((listener) => listener());
	};

	const subscribe = (listener: () => void) => {
		reviewStart.listeners.add(listener);
		return () => {
			reviewStart.listeners.delete(listener);
		};
	};

	return {
		AppActivitiesProvider: {
			useContext: () => ({
				startReview: (...args: unknown[]) => {
					setIsStarting(true);
					return Promise.resolve(startReviewMock(...args)).finally(() => setIsStarting(false));
				},
				isStartingReview: useSyncExternalStore(subscribe, () => reviewStart.isStarting),
				pendingStopSourceIds: new Set(),
				stop: vi.fn(),
			}),
		},
	};
});

// Feed the complete tree separately from the pending-update queries.
vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: { useFullList: () => treeNodesMock() },
}));

// Spy target: tests assert on toast.error and toast.warning calls.
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), warning: vi.fn() },
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => tenantContextMock(),
	},
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL), and the
// codegen'd api object is a Proxy; plain-string function refs keep call assertions readable.
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex: { action: actionMock },
	app_convex_api: {
		users: { get_anagraphic: "get_anagraphic" },
		files_pending_update_runs: { get: "review_get", list_items: "review_list_items" },
		files_pending_updates: {
			get_pending_source_summary: "get_pending_source_summary",
			create_private_pending_download_url: "create_private_pending_download_url",
			get_file_pending_target: "get_file_pending_target",
			list_files_pending_updates: "list_files_pending_updates",
			get_file_pending_update: "get_file_pending_update",
			discard_file_pending_content: "discard_file_pending_content",
			discard_file_pending_update: "discard_file_pending_update",
			upsert_file_pending_update: "upsert_file_pending_update",
			save_file_pending_update: "save_file_pending_update",
			apply_file_pending_move: "apply_file_pending_move",
			apply_file_pending_archive: "apply_file_pending_archive",
			discard_file_pending_structural: "discard_file_pending_structural",
			accept_file_pending_replacement: "accept_file_pending_replacement",
		},
		files_nodes: {
			list_tree: "list_tree",
			get_current_user_file_write_permission: "get_current_user_file_write_permission",
		},
		r2: {
			get_asset_by_file_node_id: "get_asset_by_file_node_id",
		},
	},
}));

// Keep the real modules. Fake only the network reads (committed-content fetch, paged pending
// state fetch) and the batch-staging upsert helper; the byte->text decode below runs the REAL
// bridge on real encoded states — a stub there would keep objective 16 green while production
// is wrong.
vi.mock("@/lib/files.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/files.ts")>()),
	files_fetch_file_yjs_state_and_text: (...args: unknown[]) => fetchFileYjsStateAndTextMock(...args),
	files_fetch_file_pending_update_yjs_state: (...args: unknown[]) => fetchPendingStateMock(...args),
	files_download_blob: (...args: unknown[]) => downloadBlobMock(...args),
	files_upsert_file_pending_update: (...args: unknown[]) => upsertPendingMock(...args),
}));

// The real implementation measures text with Pretext font metrics that happy-dom cannot provide;
// tests also spy on it to assert the measured width/font.
vi.mock("@/lib/file-paths.ts", () => ({
	files_truncate_path_for_width: (args: { path: string; width: number; font: string; letterSpacing: number }) =>
		truncatePathForWidthMock(args),
}));

// Same Pretext limitation for the source select's overflow check: report every label as fitting.
vi.mock("@chenglou/pretext", () => ({
	measureLineStats: () => ({ lineCount: 1, maxLineWidth: 0 }),
	prepareWithSegments: (candidate: string) => ({ candidate }),
}));

// The real MyLink is a TanStack Router Link and needs a RouterProvider; the stub renders a plain
// anchor with the resolved href.
vi.mock("@/components/my-link.tsx", () => ({
	MyLink: function MyLink(props: {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>);
		className?: string;
		"aria-label"?: string;
		tooltip?: string;
		onClick?: () => void;
		children?: ReactNode;
	}) {
		let href = props.to;
		for (const [key, value] of Object.entries(props.params ?? {})) {
			href = href.replace(`$${key}`, value);
		}
		// The real Link also accepts an updater function; there is no previous search in the stub.
		const search = typeof props.search === "function" ? props.search({}) : props.search;
		const query = search ? `?${new URLSearchParams(search).toString()}` : "";
		// The real MyLink renders `tooltip` through MyTooltip; the stub keeps it on the anchor so
		// tests can still assert the full label reaches the link.
		return (
			<a
				href={`${href}${query}`}
				aria-label={props["aria-label"]}
				title={props.tooltip}
				onClick={(event) => {
					event.preventDefault();
					props.onClick?.();
				}}
			>
				<span className={props.className}>{props.children}</span>
			</a>
		);
	},
}));

import { FileEditorSidebarPending } from "./file-editor-sidebar-pending.tsx";
import { FilesPendingReviewModal } from "@/components/files/files-pending-review.tsx";
import { encodeStateAsUpdate } from "yjs";
import { files_yjs_doc_create_from_text } from "../../../../../shared/files-tiptap.ts";
import { files_PENDING_UPDATE_STALE_BASE_MESSAGE } from "../../../../../shared/files.ts";
import { files_u8_to_array_buffer } from "@/lib/files.ts";

/**
 * Real encoded branch states per fixture state id. The fetch mock serves these bytes and the
 * component decodes them through the real byte->text bridge.
 */
const pendingStateBytesByStateId = new Map<string, ArrayBuffer>();
const blockedTargetIds = new Set<string>();
const unreadableTargetIds = new Set<string>();
const requiredParentsById = new Map<
	string,
	Array<{ target: { kind: "private"; id: string }; path: string; pendingUpdateId: string; reviewedRevision: number }>
>();
// Folder drafts the server reports as holding another draft (`hasActiveChildDraft`).
const activeChildDraftTargetIds = new Set<string>();
function registerPendingState(stateId: string, text: string) {
	// Always overwrite: tests reuse fixture ids with different texts.
	const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: "rich_text" });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	pendingStateBytesByStateId.set(stateId, files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)));
	yjsDoc.destroy();
	return stateId;
}

function makePendingUpdate(args: {
	id: string;
	fileNodeId: string;
	staged?: string;
	unstaged?: string;
	pendingMove?: { destParentId: string; destName: string; fromPath: string; replacesNodeId?: string };
	copiedFrom?: { nodeId: string; path: string };
	pendingReplacement?: { assetId: string; size: number; contentType: string; baseAssetId: string };
	privatePath?: string;
	privateKind?: "folder" | "stored";
	storedContentType?: string;
	storedSize?: number;
	preparing?: boolean;
	pendingArchive?: { fromPath: string };
	threadIds?: string[];
	/**
	 * Set for a proposal on a file with collaboration off: the content asset it was built from.
	 */
	baseAssetId?: string;
	contentNeedsRebase?: true;
}): app_convex_Doc<"files_pending_updates"> {
	const doc = {
		_id: args.id,
		_creationTime: 0,
		organizationId: "organization_1",
		workspaceId: "workspace_1",
		userId: "user_1",
		target: { kind: args.privatePath ? "private" : "saved", id: args.fileNodeId },
		revision: 1,
		// Structural-only rows leave the whole canonical content group unset, like the server does.
		...(args.staged != null && args.unstaged != null
			? {
					content: {
						base: args.baseAssetId
							? { kind: "asset", assetId: args.baseAssetId }
							: { kind: "yjs", sequence: 0, lineageGeneration: 0 },
						baseStateId: registerPendingState(`${args.id}_base`, "") as never,
						stagedStateId: registerPendingState(`${args.id}_staged`, args.staged) as never,
						unstagedStateId: registerPendingState(`${args.id}_unstaged`, args.unstaged) as never,
					},
				}
			: {}),
		...(args.pendingMove
			? {
					pendingMove: {
						destParent:
							args.pendingMove.destParentId === "root"
								? { kind: "root" }
								: { kind: "saved", id: args.pendingMove.destParentId },
						destName: args.pendingMove.destName,
						fromPath: args.pendingMove.fromPath,
						...(args.pendingMove.replacesNodeId
							? { replacesTarget: { kind: "saved", id: args.pendingMove.replacesNodeId } }
							: {}),
					},
				}
			: {}),
		...(args.copiedFrom
			? { copiedFrom: { target: { kind: "saved", id: args.copiedFrom.nodeId }, path: args.copiedFrom.path } }
			: {}),
		...(args.pendingReplacement ? { pendingReplacement: args.pendingReplacement } : {}),
		...(args.privatePath
			? {
					createIntent:
						args.privateKind === "folder"
							? { kind: "folder", metadata: [] }
							: args.privateKind === "stored"
								? {
										kind: "stored",
										assetId: "asset_private",
										size: args.storedSize ?? 3,
										contentType: args.storedContentType ?? "image/png",
										metadata: [],
									}
								: {
										kind: "text",
										textKind: "rich_text",
										contentType: "text/markdown",
										collaborationEnabled: true,
										metadata: [],
									},
				}
			: {}),
		...(args.preparing ? { preparation: { transferItemId: "transfer_item_1", creationGeneration: 1 } } : {}),
		...(args.pendingArchive ? { pendingArchive: args.pendingArchive } : {}),
		...(args.threadIds ? { threadIds: args.threadIds } : {}),
		...(args.contentNeedsRebase ? { contentNeedsRebase: true } : {}),
		size: 0,
		updatedAt: 1,
	} as unknown as app_convex_Doc<"files_pending_updates">;
	if (args.privatePath) privatePathsById.set(doc.target.id, args.privatePath);
	return doc;
}

const privatePathsById = new Map<string, string>();

// Build the server's owner view from each test's file and proposal fixtures.
function makeOwnerViewFixtures(updates: app_convex_Doc<"files_pending_updates">[] | undefined) {
	return updates?.map((pendingUpdate) => {
		const nodes: app_convex_Doc<"files_nodes">[] = treeNodesMock() ?? [];
		const canAccept = !blockedTargetIds.has(pendingUpdate.target.id) && !pendingUpdate.preparation;
		const hasActiveChildDraft = activeChildDraftTargetIds.has(pendingUpdate.target.id);
		if (unreadableTargetIds.has(pendingUpdate.target.id))
			return {
				kind: "restricted",
				target: pendingUpdate.target,
				pendingUpdateId: pendingUpdate._id,
				revision: pendingUpdate.revision,
				threadIds: pendingUpdate.threadIds,
				hasActiveChildDraft,
			};
		if (pendingUpdate.target.kind === "private") {
			const path = privatePathsById.get(pendingUpdate.target.id)!;
			return {
				kind: "entry",
				entry: {
					kind: "private",
					node: {
						_id: pendingUpdate.target.id,
						name: path.split("/").pop(),
						kind: pendingUpdate.createIntent?.kind === "folder" ? "folder" : "file",
						parent: { kind: "root" },
						userId: "user_1",
						creationGeneration: 1,
					},
					pendingUpdate,
					path,
				},
				readiness: pendingUpdate.preparation ? "preparing" : "ready",
				canEdit: canAccept,
				// A draft inside a folder that is itself a proposal cannot be accepted on its own. It can only
				// be saved together with that folder, which is what canAcceptWithParents means.
				canAccept: canAccept && !requiredParentsById.has(pendingUpdate.target.id),
				canAcceptWithParents: canAccept,
				requiredParents: requiredParentsById.get(pendingUpdate.target.id) ?? [],
				hasActiveChildDraft,
			};
		}
		const node = nodes.find((node) => node._id === pendingUpdate.target.id);
		if (!node)
			return {
				kind: "restricted",
				target: pendingUpdate.target,
				pendingUpdateId: pendingUpdate._id,
				revision: pendingUpdate.revision,
				threadIds: pendingUpdate.threadIds,
			};
		const move = pendingUpdate.pendingMove;
		const parent = move?.destParent;
		const parentPath = parent?.kind === "saved" ? nodes.find((node) => node._id === parent.id)?.path : "";
		return {
			kind: "entry",
			entry: { kind: "saved", node, pendingUpdate, path: move ? `${parentPath}/${move.destName}` : node.path },
			readiness: "ready",
			canEdit: canAccept,
			canAccept,
			canAcceptWithParents: canAccept,
			requiredParents: [],
			hasActiveChildDraft,
		};
	});
}

function makeThread(args: { id: string; title: string | null; archived?: boolean; lastMessageAt?: number }) {
	return {
		organizationName: "source-team",
		workspaceName: "source-workspace",
		title: args.title,
		archived: args.archived ?? false,
		updatedAt: 1,
		lastMessageAt: args.lastMessageAt ?? 1,
	};
}

function makeNode(args: {
	id: string;
	path: string;
	kind?: "file" | "folder";
	parentId?: string;
	hasEditableYjsState?: boolean;
	canWrite?: boolean;
	nonCollaborative?: boolean;
	archived?: boolean;
}): app_convex_Doc<"files_nodes"> {
	const kind = args.kind ?? "file";
	return {
		_id: args.id,
		_creationTime: 0,
		path: args.path,
		name: args.path.split("/").pop() ?? args.path,
		kind,
		parentId: args.parentId ?? "root",
		canWrite: args.canWrite ?? true,
		writeBlockedReason: args.canWrite === false ? "read_only" : null,
		writePolicyState: "none",
		archiveOperationId: args.archived ? `archive_op_${args.id}` : null,
		assetId: null,
		textKind: null,
		collaborationEnabled: null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		...(kind === "file"
			? {
					assetId: `asset_${args.id}`,
					...(args.hasEditableYjsState === false
						? {}
						: args.nonCollaborative
							? { textKind: "rich_text", collaborationEnabled: false }
							: {
									yjsSnapshotId: `snapshot_${args.id}`,
									yjsLastSequenceId: `sequence_${args.id}`,
									textKind: "rich_text",
									collaborationEnabled: true,
								}),
				}
			: {}),
	} as unknown as app_convex_Doc<"files_nodes">;
}

const MEMBERSHIP_ID = "membership_1" as app_convex_Id<"organizations_workspaces_users">;

beforeEach(() => {
	startReviewMock.mockReset();
	startReviewMock.mockResolvedValue(undefined);
	reviewStart.isStarting = false;
	pagination.status = "Exhausted";
	loadMoreMock.mockReset();
	blockedTargetIds.clear();
	requiredParentsById.clear();
	activeChildDraftTargetIds.clear();
	unreadableTargetIds.clear();
	privatePathsById.clear();
	tenantContextMock.mockReturnValue({
		membershipId: MEMBERSHIP_ID,
		organizationId: "organization_1",
		organizationName: "team",
		workspaceId: "workspace_1",
		workspaceName: "home",
	});
	actionMock.mockReset();
	actionMock.mockResolvedValue({ _yay: null });
	mutationMock.mockReset();
	mutationMock.mockResolvedValue({ _yay: null });
	queryMock.mockReset();
	queryMock.mockResolvedValue(null);
	fetchFileYjsStateAndTextMock.mockReset();
	fetchFileYjsStateAndTextMock.mockResolvedValue({ text: { _yay: "Committed content\n" } });
	fetchPendingStateMock.mockReset();
	downloadBlobMock.mockReset();
	fetchPendingStateMock.mockImplementation(async (args: { stateId: string }) => {
		const bytes = pendingStateBytesByStateId.get(args.stateId);
		return bytes ? { _yay: bytes } : { _nay: { name: "nay", message: "Missing pending state fixture" } };
	});
	upsertPendingMock.mockReset();
	upsertPendingMock.mockRejectedValue(new Error("Review must not rewrite text states"));
	truncatePathForWidthMock.mockReset();
	truncatePathForWidthMock.mockImplementation((args: { path: string }) => args.path);
	useQueryMock.mockReset();
	useQueriesMock.mockReset();
	useQueriesMock.mockReturnValue({});
	treeNodesMock.mockReset();
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.warning).mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("FileEditorSidebarPending", () => {
	test("waits for the owner query before listing pending changes", () => {
		useQueryMock.mockReturnValue(undefined);
		treeNodesMock.mockReturnValue(undefined);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("Loading pending changes…")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
	});

	test("renders an empty state when there are no pending updates", () => {
		useQueryMock.mockReturnValue([]);
		treeNodesMock.mockReturnValue([]);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("No pending changes")).toBeTruthy();
	});

	test("keeps Load more available after an empty continuing page", () => {
		useQueryMock.mockReturnValue([]);
		treeNodesMock.mockReturnValue([]);
		pagination.status = "CanLoadMore";
		render(<FileEditorSidebarPending />);
		expect(screen.queryByText("No pending changes")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Load more pending changes" }));
		expect(loadMoreMock).toHaveBeenCalledWith(20);
	});

	test("bulk Discard acts on loaded rows while more pages remain", async () => {
		const loaded = makePendingUpdate({ id: "pu_loaded", fileNodeId: "node_loaded", staged: "s", unstaged: "u" });
		makePendingUpdate({ id: "pu_later", fileNodeId: "node_later", staged: "s", unstaged: "u" });
		useQueryMock.mockReturnValue([loaded]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_loaded", path: "/loaded.md" }),
			makeNode({ id: "node_later", path: "/later.md" }),
		]);
		pagination.status = "CanLoadMore";
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_loaded", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(loadMoreMock).not.toHaveBeenCalled();
	});
	test("does not map a private proposal to a saved file with the same id text", () => {
		const saved = makePendingUpdate({ id: "pu_saved", fileNodeId: "node_saved", staged: "s", unstaged: "u" });
		const privateUpdate = makePendingUpdate({
			id: "pu_private",
			fileNodeId: "node_private",
			staged: "s",
			unstaged: "u",
			privatePath: "/private.md",
		});
		useQueryMock.mockReturnValue([saved, privateUpdate]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_saved", path: "saved.md" }),
			makeNode({ id: "node_private", path: "unrelated.md" }),
		]);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("saved.md")).toBeTruthy();
		expect(screen.queryByText("unrelated.md")).toBeNull();
		expect(screen.getByRole("link", { name: "/private.md" }).getAttribute("href")).toContain(
			"pendingNodeId=node_private",
		);
	});

	test("selects the reviewed empty private text state without rewriting its branches", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_private",
				fileNodeId: "private_a",
				privatePath: "/empty.md",
				staged: "",
				unstaged: "",
			}),
		]);
		treeNodesMock.mockReturnValue(undefined);
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("button", { name: "Accept changes to /empty.md" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_private", reviewedRevision: 1, selectedContentStateId: "pu_private_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
	});
	test.each(["folder", "stored"] as const)("selects an added %s without decoding text", async (privateKind) => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_private", fileNodeId: "private_a", privatePath: "/added", privateKind }),
		]);
		treeNodesMock.mockReturnValue(undefined);
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/private.png" } });
		const { container } = render(<FileEditorSidebarPending />);

		// Both use the normal row with inline Accept. Only the stored file has details to open.
		expect(screen.getByText(privateKind === "stored" ? "Added file" : "Added folder")).toBeTruthy();
		expect(screen.getByRole("link", { name: "/added" })).toBeTruthy();
		expect(container.querySelector("details") !== null).toBe(privateKind === "stored");
		if (privateKind === "stored") {
			expect(actionMock).not.toHaveBeenCalled();

			// jsdom does not fire the toggle event by itself, so open the row and fire it by hand.
			const details = container.querySelector("details")!;
			details.open = true;
			fireEvent(details, new Event("toggle"));
			await screen.findByRole("img", { name: "added" });
		}
		fireEvent.click(screen.getByRole("button", { name: "Accept changes to /added" }));
		await waitFor(() =>
			expect(startReviewMock).toHaveBeenCalledWith({
				kind: "accept",
				items: [{ pendingUpdateId: "pu_private", reviewedRevision: 1, selectedContentStateId: null }],
			}),
		);
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
		expect(fetchFileYjsStateAndTextMock).not.toHaveBeenCalled();
	});

	describe("folder drafts that hold a draft", () => {
		function renderFolderWithNote() {
			const folder = makePendingUpdate({
				id: "pu_folder",
				fileNodeId: "private_folder",
				privatePath: "/qa",
				privateKind: "folder",
			});
			const note = makePendingUpdate({
				id: "pu_note",
				fileNodeId: "private_note",
				privatePath: "/qa/note.md",
				staged: "",
				unstaged: "hi",
			});
			activeChildDraftTargetIds.add("private_folder");
			requiredParentsById.set("private_note", [
				{
					target: { kind: "private", id: "private_folder" },
					path: "/qa",
					pendingUpdateId: "pu_folder",
					reviewedRevision: 3,
				},
			]);
			useQueryMock.mockReturnValue([folder, note]);
			treeNodesMock.mockReturnValue(undefined);
			return render(<FileEditorSidebarPending />);
		}

		test("draws only the draft inside, names the folder, and counts one change", () => {
			renderFolderWithNote();

			expect(screen.queryByRole("link", { name: "/qa" })).toBeNull();
			// The row looks like any new file. Only its tooltip and accessible name list the folder.
			expect(screen.getByRole("link", { name: "/qa/note.md, also adds /qa" })).toBeTruthy();
			expect(screen.getByText("Added file")).toBeTruthy();
			expect(screen.queryByText(/also adds/)).toBeNull();
			expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 1 change" })).toBeTruthy();
		});

		test("row Accept saves the folder first, then the draft with its reviewed text", async () => {
			renderFolderWithNote();

			fireEvent.click(screen.getByRole("button", { name: "Accept changes to /qa/note.md" }));

			await waitFor(() =>
				expect(startReviewMock).toHaveBeenCalledWith({
					kind: "accept",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 3, selectedContentStateId: null },
						{ pendingUpdateId: "pu_note", reviewedRevision: 1, selectedContentStateId: "pu_note_unstaged" },
					],
				}),
			);
		});

		test("row Discard removes only the draft", async () => {
			renderFolderWithNote();

			fireEvent.click(screen.getByRole("button", { name: "Discard changes to /qa/note.md" }));

			await waitFor(() =>
				expect(startReviewMock).toHaveBeenCalledWith({
					kind: "discard",
					items: [{ pendingUpdateId: "pu_note", reviewedRevision: 1, selectedContentStateId: null }],
				}),
			);
		});

		test("bulk actions send the hidden folder together with the draft inside it", async () => {
			renderFolderWithNote();

			fireEvent.click(screen.getByRole("button", { name: "Accept all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "accept",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 3, selectedContentStateId: null },
						{ pendingUpdateId: "pu_note", reviewedRevision: 1, selectedContentStateId: "pu_note_unstaged" },
					],
				}),
			);

			fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "discard",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 1, selectedContentStateId: null },
						{ pendingUpdateId: "pu_note", reviewedRevision: 1, selectedContentStateId: null },
					],
				}),
			);
		});

		test("bulk actions under a chat never touch a hidden folder that holds another chat's draft", async () => {
			activeChildDraftTargetIds.add("private_folder");
			const folderParent = {
				target: { kind: "private", id: "private_folder" },
				path: "/qa",
				pendingUpdateId: "pu_folder",
				reviewedRevision: 3,
			} as const;
			requiredParentsById.set("private_note", [folderParent]);
			requiredParentsById.set("private_x", [folderParent]);
			treeNodesMock.mockReturnValue(undefined);
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_folder",
					fileNodeId: "private_folder",
					privatePath: "/qa",
					privateKind: "folder",
					threadIds: ["thread_a"],
				}),
				makePendingUpdate({
					id: "pu_note",
					fileNodeId: "private_note",
					privatePath: "/qa/note.md",
					staged: "",
					unstaged: "hi",
					threadIds: ["thread_b"],
				}),
				makePendingUpdate({
					id: "pu_x",
					fileNodeId: "private_x",
					privatePath: "/qa/x.md",
					staged: "",
					unstaged: "x",
					threadIds: ["thread_a"],
				}),
			]);
			useQueriesMock.mockReturnValue({
				thread_a: makeThread({ id: "thread_a", title: "First chat", lastMessageAt: 10 }),
				thread_b: makeThread({ id: "thread_b", title: "Second chat", lastMessageAt: 20 }),
			});
			render(<FileEditorSidebarPending />);
			const selectSource = (name: RegExp) => {
				fireEvent.click(screen.getByRole("combobox"));
				fireEvent.click(screen.getByRole("option", { name }));
			};

			// The folder and x.md belong to the first chat, but note.md in the same folder belongs to
			// the second one. So discarding x.md must keep the folder, and saving x.md saves it.
			selectSource(/^First chat/);
			expect(screen.getByRole("combobox", { name: "Pending changes source: First chat, 1 change" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "discard",
					items: [{ pendingUpdateId: "pu_x", reviewedRevision: 1, selectedContentStateId: null }],
				}),
			);
			fireEvent.click(screen.getByRole("button", { name: "Accept all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "accept",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 3, selectedContentStateId: null },
						{ pendingUpdateId: "pu_x", reviewedRevision: 1, selectedContentStateId: "pu_x_unstaged" },
					],
				}),
			);

			// The second chat's draft saves its folder with it, like its row Accept does.
			selectSource(/^Second chat/);
			fireEvent.click(screen.getByRole("button", { name: "Accept all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "accept",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 3, selectedContentStateId: null },
						{ pendingUpdateId: "pu_note", reviewedRevision: 1, selectedContentStateId: "pu_note_unstaged" },
					],
				}),
			);
		});

		test("Discard all under a chat keeps the folders above another chat's hidden folder", async () => {
			activeChildDraftTargetIds.add("private_f");
			activeChildDraftTargetIds.add("private_g");
			const parentF = {
				target: { kind: "private", id: "private_f" },
				path: "/f",
				pendingUpdateId: "pu_f",
				reviewedRevision: 1,
			} as const;
			const parentG = {
				target: { kind: "private", id: "private_g" },
				path: "/f/g",
				pendingUpdateId: "pu_g",
				reviewedRevision: 1,
			} as const;
			requiredParentsById.set("private_g", [parentF]);
			requiredParentsById.set("private_x", [parentF, parentG]);
			treeNodesMock.mockReturnValue(undefined);
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_f",
					fileNodeId: "private_f",
					privatePath: "/f",
					privateKind: "folder",
					threadIds: ["thread_a"],
				}),
				makePendingUpdate({
					id: "pu_g",
					fileNodeId: "private_g",
					privatePath: "/f/g",
					privateKind: "folder",
					threadIds: ["thread_b"],
				}),
				makePendingUpdate({
					id: "pu_x",
					fileNodeId: "private_x",
					privatePath: "/f/g/x.md",
					staged: "",
					unstaged: "x",
					threadIds: ["thread_a"],
				}),
			]);
			useQueriesMock.mockReturnValue({
				thread_a: makeThread({ id: "thread_a", title: "First chat", lastMessageAt: 10 }),
				thread_b: makeThread({ id: "thread_b", title: "Second chat", lastMessageAt: 20 }),
			});
			render(<FileEditorSidebarPending />);

			// The first chat cannot send g, so /f must stay too: it still holds g.
			fireEvent.click(screen.getByRole("combobox"));
			fireEvent.click(screen.getByRole("option", { name: /^First chat/ }));
			fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "discard",
					items: [{ pendingUpdateId: "pu_x", reviewedRevision: 1, selectedContentStateId: null }],
				}),
			);
		});

		test("lists several parent folders only in the label", () => {
			const note = makePendingUpdate({
				id: "pu_deep",
				fileNodeId: "private_deep",
				privatePath: "/a/b/c.md",
				staged: "",
				unstaged: "hi",
			});
			requiredParentsById.set("private_deep", [
				{ target: { kind: "private", id: "private_a" }, path: "/a", pendingUpdateId: "pu_a", reviewedRevision: 1 },
				{ target: { kind: "private", id: "private_b" }, path: "/a/b", pendingUpdateId: "pu_b", reviewedRevision: 1 },
			]);
			useQueryMock.mockReturnValue([note]);
			treeNodesMock.mockReturnValue(undefined);

			render(<FileEditorSidebarPending />);

			expect(screen.getByText("Added file")).toBeTruthy();
			expect(screen.getByRole("link", { name: "/a/b/c.md, also adds /a, /a/b" })).toBeTruthy();
		});

		test("a hidden folder without access is not drawn or counted either", () => {
			const folder = makePendingUpdate({
				id: "pu_folder",
				fileNodeId: "private_folder",
				privatePath: "/qa",
				privateKind: "folder",
			});
			const note = makePendingUpdate({ id: "pu_note", fileNodeId: "private_note", privatePath: "/qa/note.md" });
			activeChildDraftTargetIds.add("private_folder");
			unreadableTargetIds.add("private_folder");
			unreadableTargetIds.add("private_note");
			useQueryMock.mockReturnValue([folder, note]);
			treeNodesMock.mockReturnValue(undefined);

			render(<FileEditorSidebarPending />);

			expect(screen.getAllByText("Draft unavailable")).toHaveLength(1);
			expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 1 change" })).toBeTruthy();
		});
	});

	test.each(["image/png", "image/webp"])(
		"%s review shows its maker, chat, and exact required folders",
		async (contentType) => {
			const update = makePendingUpdate({
				id: "pu_image",
				fileNodeId: "private_image",
				privatePath: "/captures/page.png",
				privateKind: "stored",
				storedContentType: contentType,
				threadIds: ["thread_a"],
			});
			useQueryMock.mockImplementation((reference) =>
				reference === "get_anagraphic" ? { displayName: "Alex" } : [update],
			);
			useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Check page" }) });
			requiredParentsById.set("private_image", [
				{
					target: { kind: "private", id: "private_folder" },
					path: "/captures",
					pendingUpdateId: "pu_folder",
					reviewedRevision: 5,
				},
			]);
			treeNodesMock.mockReturnValue([]);
			actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/private.png" } });

			const { container } = render(<FileEditorSidebarPending />);

			// A closed row signs nothing. A long list of drafts would otherwise ask for one signed URL per
			// image just to draw the list.
			expect(actionMock).not.toHaveBeenCalled();

			const details = container.querySelector("details")!;
			details.open = true;
			fireEvent(details, new Event("toggle"));
			await screen.findByRole("img", { name: "page.png" });

			expect(screen.getByText(/Created by Alex/)).toBeTruthy();
			expect(screen.getByRole("link", { name: "Check page" }).getAttribute("href")).toBe(
				"/w/source-team/source-workspace/chat?threadId=thread_a",
			);
			// The row names the folder it will create in its label. Accepting this row, or Accept all,
			// sends the folder first, so the file has somewhere to land.
			expect(screen.getByRole("link", { name: "/captures/page.png, also adds /captures" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Accept all shown pending changes" }).matches(":disabled")).toBe(false);

			fireEvent.click(screen.getByRole("button", { name: "Accept changes to /captures/page.png" }));

			await waitFor(() =>
				expect(startReviewMock).toHaveBeenCalledWith({
					kind: "accept",
					items: [
						{ pendingUpdateId: "pu_folder", reviewedRevision: 5, selectedContentStateId: null },
						{ pendingUpdateId: "pu_image", reviewedRevision: 1, selectedContentStateId: null },
					],
				}),
			);
			const discard = screen.getByRole("button", { name: "Discard changes to /captures/page.png" });
			await waitFor(() => expect(discard.getAttribute("aria-disabled")).toBe("false"));
			fireEvent.click(discard);
			await waitFor(() =>
				expect(startReviewMock).toHaveBeenLastCalledWith({
					kind: "discard",
					items: [{ pendingUpdateId: "pu_image", reviewedRevision: 1, selectedContentStateId: null }],
				}),
			);
		},
	);

	// Only real pictures get an inline preview. Everything else, including SVG and HTML, shows its type
	// and size with a Download button. Drawing them in the app would run code the agent produced.
	test.each([
		{ contentType: "application/zip", name: "archive.zip", bytes: [0, 255, 128] },
		{ contentType: "application/pdf", name: "document.pdf", bytes: [0, 255, 128] },
		{ contentType: "application/octet-stream", name: "empty", bytes: [] },
		{ contentType: "application/x-custom", name: "binary", bytes: [0, 255, 128] },
		{ contentType: "image/svg+xml", name: "drawing.svg", bytes: [0, 255, 128] },
		{ contentType: "text/html", name: "page.html", bytes: [0, 255, 128] },
	])("reviews and downloads $contentType without an inline preview", async ({ contentType, name, bytes }) => {
		const update = makePendingUpdate({
			id: "pu_binary",
			fileNodeId: "private_binary",
			privatePath: `/exports/${name}`,
			privateKind: "stored",
			storedContentType: contentType,
			storedSize: bytes.length,
		});
		useQueryMock.mockImplementation((reference) =>
			reference === "get_anagraphic" ? { displayName: "Alex" } : [update],
		);
		treeNodesMock.mockReturnValue([]);
		requiredParentsById.set("private_binary", [
			{
				target: { kind: "private", id: "private_exports" },
				path: "/exports",
				pendingUpdateId: "pu_exports",
				reviewedRevision: 7,
			},
		]);
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/binary" } });
		const blob = new Blob([Uint8Array.from(bytes)]);
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
		vi.stubGlobal("fetch", fetchMock);

		const { container } = render(<FileEditorSidebarPending />);
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));

		expect(screen.getByText(`${contentType} · ${bytes.length} bytes`)).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
		expect(container.querySelector("iframe, audio, video, object, embed")).toBeNull();
		// The signed URL is created only when the user presses Download.
		expect(actionMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: `Download ${name}` }));

		await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledWith({ blob, filename: name }));
		expect(fetchMock).toHaveBeenCalledWith("https://assets.test/binary");
		expect(actionMock).toHaveBeenCalledWith("create_private_pending_download_url", {
			membershipId: MEMBERSHIP_ID,
			target: { kind: "private", id: "private_binary" },
			pendingUpdateId: "pu_binary",
			reviewedRevision: 1,
			creationGeneration: 1,
		});

		// The Download button must be usable again once the download has finished.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: `Download ${name}` }).matches(":disabled")).toBe(false),
		);

		fireEvent.click(screen.getByRole("button", { name: `Accept changes to /exports/${name}` }));
		await waitFor(() =>
			expect(startReviewMock).toHaveBeenCalledWith({
				kind: "accept",
				items: [
					{ pendingUpdateId: "pu_exports", reviewedRevision: 7, selectedContentStateId: null },
					{ pendingUpdateId: "pu_binary", reviewedRevision: 1, selectedContentStateId: null },
				],
			}),
		);
	});

	// A download started during Accept would read a file that is being saved. So every row button,
	// Download included, stays disabled until the review request settles.
	test("disables Download while Accept is starting a review", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_binary",
				fileNodeId: "private_binary",
				privatePath: "/archive.zip",
				privateKind: "stored",
				storedContentType: "application/zip",
				storedSize: 3,
			}),
		]);
		treeNodesMock.mockReturnValue([]);
		let finishReview = () => {};
		startReviewMock.mockReturnValue(new Promise<void>((resolve) => (finishReview = resolve)));

		const { container } = render(<FileEditorSidebarPending />);
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		const download = screen.getByRole("button", { name: "Download archive.zip" });
		expect(download.matches(":disabled")).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Accept changes to /archive.zip" }));

		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(download.matches(":disabled")).toBe(true);
		fireEvent.click(download);
		expect(actionMock).not.toHaveBeenCalled();

		await act(async () => finishReview());
		expect(download.matches(":disabled")).toBe(false);
	});

	// The bytes of a preparing file are not in storage yet. So the row cannot open, download or
	// accept. The user may still throw the draft away.
	test("preparing stored files block preview, download, and Accept while keeping Discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_preparing",
				fileNodeId: "private_preparing",
				privatePath: "/preparing.png",
				privateKind: "stored",
				preparing: true,
			}),
		]);
		treeNodesMock.mockReturnValue([]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(screen.getByText("Preparing…")).toBeTruthy();
		// The row uses the same accordion as a ready draft, but it has no chevron and closes again
		// when something opens it.
		const details = container.querySelector("details")!;
		expect(details.querySelector("summary button[aria-hidden]")).toBeNull();
		details.open = true;
		fireEvent(details, new Event("toggle"));
		expect(details.open).toBe(false);
		expect(screen.getByRole("button", { name: "Accept changes to /preparing.png" }).matches(":disabled")).toBe(true);
		expect(screen.queryByRole("button", { name: "Download preparing.png" })).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
		expect(actionMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Discard changes to /preparing.png" }));
		await waitFor(() =>
			expect(startReviewMock).toHaveBeenCalledWith({
				kind: "discard",
				items: [{ pendingUpdateId: "pu_preparing", reviewedRevision: 1, selectedContentStateId: null }],
			}),
		);
	});

	// The row must keep the same buttons when its draft becomes ready. If the row swapped its layout,
	// the focused Discard button would leave the page and focus would fall back to the page body.
	test.each([
		{ draft: "stored", privateKind: "stored" as const, path: "/preparing.png" },
		{ draft: "text", staged: "", unstaged: "draft", path: "/preparing.md" },
	])("keeps focus on Discard when a preparing $draft draft becomes ready", (args) => {
		const { draft: _draft, ...fixture } = args;
		const makeDraft = (preparing: boolean) =>
			makePendingUpdate({
				id: "pu_preparing",
				fileNodeId: "private_preparing",
				privatePath: fixture.path,
				...fixture,
				preparing,
			});
		let updates = [makeDraft(true)];
		const listeners = new Set<() => void>();
		useQueryMock.mockImplementation(() =>
			useSyncExternalStore(
				(listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				() => updates,
			),
		);
		treeNodesMock.mockReturnValue([]);
		render(<FileEditorSidebarPending />);

		const discard = screen.getByRole("button", { name: `Discard changes to ${fixture.path}` });
		discard.focus();
		updates = [makeDraft(false)];
		act(() => listeners.forEach((listener) => listener()));

		expect(screen.queryByText("Preparing…")).toBeNull();
		expect(document.activeElement).toBe(discard);
	});

	test("keeps focus in Pending when the last focused image row disappears", async () => {
		let updates = [
			makePendingUpdate({
				id: "pu_image",
				fileNodeId: "private_image",
				privatePath: "/page.png",
				privateKind: "stored",
			}),
		];
		const listeners = new Set<() => void>();
		useQueryMock.mockImplementation(() =>
			useSyncExternalStore(
				(listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				() => updates,
			),
		);
		treeNodesMock.mockReturnValue([]);
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/private.png" } });
		const { container } = render(<FileEditorSidebarPending />);
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		await screen.findByRole("img", { name: "page.png" });

		// The focused row is the last one, and it goes away. Keyboard focus must move to the Pending panel
		// instead of falling back to the page body.
		screen.getByRole("button", { name: "Discard changes to /page.png" }).focus();
		updates = [];
		act(() => listeners.forEach((listener) => listener()));

		await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Pending changes"));
		expect(screen.getByText("No pending changes")).toBeTruthy();
	});

	test("image Discard stays available when Accept loses permission and reports review failure", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_image",
				fileNodeId: "private_image",
				privatePath: "/page.png",
				privateKind: "stored",
			}),
		]);
		blockedTargetIds.add("private_image");
		treeNodesMock.mockReturnValue([]);
		actionMock.mockResolvedValue({ _yay: { url: "https://assets.test/private.png" } });
		startReviewMock.mockRejectedValue(new Error("The draft changed. Review it again."));
		const { container } = render(<FileEditorSidebarPending />);
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		await screen.findByRole("img", { name: "page.png" });

		// The reader lost write access to the file, so Accept is off. Discarding their own draft still works.
		expect(screen.getByRole("button", { name: "Accept changes to /page.png" }).matches(":disabled")).toBe(true);

		const discard = screen.getByRole("button", { name: "Discard changes to /page.png" });
		discard.focus();
		fireEvent.click(discard);

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The draft changed. Review it again."));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_image", reviewedRevision: 1, selectedContentStateId: null }],
		});

		// The row is still there after the failure, so focus must stay on the button the user pressed.
		expect(document.activeElement).toBe(discard);
	});

	test("preparing drafts show progress, block Accept, and keep whole Discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_private",
				fileNodeId: "private_a",
				privatePath: "/draft.md",
				staged: "",
				unstaged: "draft",
				preparing: true,
			}),
		]);
		treeNodesMock.mockReturnValue([]);
		const { container } = render(<FileEditorSidebarPending />);
		expect(screen.getByText("Preparing…")).toBeTruthy();
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		expect(details.open).toBe(false);
		expect(screen.getByRole("button", { name: "Accept changes to /draft.md" }).hasAttribute("disabled")).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Discard changes to /draft.md" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_private", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
	});
	test("restricted drafts expose only their count and whole Discard", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_private",
				fileNodeId: "private_a",
				privatePath: "/secret/draft.md",
				staged: "",
				unstaged: "secret",
				threadIds: ["thread_a"],
			}),
		]);
		unreadableTargetIds.add("private_a");
		treeNodesMock.mockReturnValue([]);
		useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Agent chat" }) });
		const { container } = render(<FileEditorSidebarPending />);
		expect(screen.getByText("Draft unavailable")).toBeTruthy();
		expect(container.textContent).not.toContain("secret");
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("button", { name: "Accept all shown pending changes" }).hasAttribute("disabled")).toBe(
			true,
		);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Agent chat/ }));
		expect(screen.getByRole("combobox", { name: "Pending changes source: Agent chat, 1 change" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Discard unavailable draft" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_private", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
	});
	test("bulk Discard includes readable and restricted private drafts", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_readable",
				fileNodeId: "private_a",
				privatePath: "/a.md",
				staged: "",
				unstaged: "a",
			}),
			makePendingUpdate({
				id: "pu_restricted",
				fileNodeId: "private_b",
				privatePath: "/secret.md",
				staged: "",
				unstaged: "b",
			}),
		]);
		unreadableTargetIds.add("private_b");
		treeNodesMock.mockReturnValue([]);
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [
				{ pendingUpdateId: "pu_readable", reviewedRevision: 1, selectedContentStateId: null },
				{ pendingUpdateId: "pu_restricted", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Started discarding 2 pending changes");
	});
	test("renders items sorted by path with full path visible", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_z", path: "zebra/notes.md" }),
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const paths = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-path-text")).map(
			(element) => element.textContent,
		);
		expect(paths).toEqual(["alpha/intro.md", "zebra/notes.md"]);
	});

	test("filters user and shared agent changes by source", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_user", fileNodeId: "node_user", staged: "s", unstaged: "u" }),
			makePendingUpdate({
				id: "pu_shared",
				fileNodeId: "node_shared",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_a", "thread_b"],
			}),
			makePendingUpdate({
				id: "pu_a",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_a"],
			}),
			makePendingUpdate({
				id: "pu_b",
				fileNodeId: "node_b",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_b"],
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_user", path: "/user.md" }),
			makeNode({ id: "node_shared", path: "/shared.md" }),
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);
		useQueriesMock.mockReturnValue({
			thread_a: makeThread({ id: "thread_a", title: "First chat", lastMessageAt: 10 }),
			thread_b: makeThread({ id: "thread_b", title: "Second chat", archived: true, lastMessageAt: 20 }),
		});

		const { container } = render(<FileEditorSidebarPending />);
		const selectSource = (name: RegExp) => {
			fireEvent.click(screen.getByRole("combobox"));
			fireEvent.click(screen.getByRole("option", { name }));
		};
		const visiblePaths = () =>
			Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-path-text")).map(
				(element) => element.textContent,
			);

		expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 4 changes" })).toBeTruthy();
		expect(visiblePaths()).toEqual(["/a.md", "/b.md", "/shared.md", "/user.md"]);
		expect(useQueriesMock).toHaveBeenCalledWith({
			thread_a: { query: "get_pending_source_summary", args: { membershipId: MEMBERSHIP_ID, threadId: "thread_a" } },
			thread_b: { query: "get_pending_source_summary", args: { membershipId: MEMBERSHIP_ID, threadId: "thread_b" } },
		});

		fireEvent.click(screen.getByRole("combobox"));
		expect(
			screen.getAllByRole("option").map((option) => option.querySelector(".MySelectItemContentPrimary")?.textContent),
		).toEqual(["All changes", "Your edits", "Second chat", "First chat"]);
		expect(screen.getByRole("option", { name: /^Second chat Archived/ })).toBeTruthy();
		fireEvent.click(screen.getByRole("option", { name: /^Your edits/ }));
		expect(screen.getByRole("combobox", { name: "Pending changes source: Your edits, 1 change" })).toBeTruthy();
		expect(visiblePaths()).toEqual(["/user.md"]);

		selectSource(/^First chat/);
		expect(visiblePaths()).toEqual(["/a.md", "/shared.md"]);

		selectSource(/^Second chat/);
		expect(visiblePaths()).toEqual(["/b.md", "/shared.md"]);
	});

	test("shows loading, unavailable, and untitled chat source labels", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_loading",
				fileNodeId: "node_loading",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_loading"],
			}),
			makePendingUpdate({
				id: "pu_missing",
				fileNodeId: "node_missing",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_missing"],
			}),
			makePendingUpdate({
				id: "pu_error",
				fileNodeId: "node_error",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_error"],
			}),
			makePendingUpdate({
				id: "pu_untitled",
				fileNodeId: "node_untitled",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_untitled"],
			}),
			makePendingUpdate({
				id: "pu_user",
				fileNodeId: "node_user",
				staged: "s",
				unstaged: "u",
				threadIds: [],
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_loading", path: "/loading.md" }),
			makeNode({ id: "node_missing", path: "/missing.md" }),
			makeNode({ id: "node_error", path: "/error.md" }),
			makeNode({ id: "node_untitled", path: "/untitled.md" }),
			makeNode({ id: "node_user", path: "/user.md" }),
		]);
		useQueriesMock.mockReturnValue({
			thread_loading: undefined,
			thread_missing: null,
			thread_error: new Error("Query failed"),
			thread_untitled: makeThread({ id: "thread_untitled", title: null, lastMessageAt: 50 }),
		});

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));

		expect(screen.getByRole("option", { name: /^Loading chat… Agent chat 1$/ })).toBeTruthy();
		expect(
			screen.getAllByRole("option", { name: /^Unavailable chat This chat is no longer available 1$/ }),
		).toHaveLength(2);
		expect(screen.getByRole("option", { name: /^New Chat Last message/ })).toBeTruthy();
		expect(
			screen.getByRole("option", { name: /^Your edits Changes you made in the editor, not from a chat 1$/ }),
		).toBeTruthy();
	});

	test("keeps an unavailable source selectable for review without a title or route", async () => {
		const update = makePendingUpdate({
			id: "pu_kept",
			fileNodeId: "private_kept",
			privatePath: "/kept.zip",
			privateKind: "stored",
			storedContentType: "application/zip",
			threadIds: ["thread_gone"],
		});
		useQueryMock.mockImplementation((reference) =>
			reference === "get_anagraphic" ? { displayName: "Alex" } : [update],
		);
		useQueriesMock.mockReturnValue({ thread_gone: null });
		treeNodesMock.mockReturnValue([]);
		const { container } = render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Unavailable chat/ }));
		const details = container.querySelector("details")!;
		details.open = true;
		fireEvent(details, new Event("toggle"));
		expect(await screen.findByText("Unavailable chat", { selector: "p" })).toBeTruthy();
		expect(container.querySelector('a[href*="/chat"]')).toBeNull();
		expect(container.textContent).not.toContain("Private source title");
		expect(container.innerHTML).not.toContain("source-team");
		fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));
		await waitFor(() =>
			expect(startReviewMock).toHaveBeenCalledWith({
				kind: "discard",
				items: [{ pendingUpdateId: "pu_kept", reviewedRevision: 1, selectedContentStateId: null }],
			}),
		);
	});

	test("hides the zero-count Your edits source", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_agent",
				fileNodeId: "node_agent",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_a"],
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_agent", path: "/agent.md" })]);
		useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Agent chat" }) });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));

		expect(
			screen.getAllByRole("option").map((option) => option.querySelector(".MySelectItemContentPrimary")?.textContent),
		).toEqual(["All changes", "Agent chat"]);
	});

	test("returns to All changes when the selected chat stops contributing", async () => {
		const userUpdate = makePendingUpdate({ id: "pu_user", fileNodeId: "node_user", staged: "s", unstaged: "u" });
		const agentUpdate = makePendingUpdate({
			id: "pu_agent",
			fileNodeId: "node_agent",
			staged: "s",
			unstaged: "u",
			threadIds: ["thread_a"],
		});
		const userNode = makeNode({ id: "node_user", path: "/user.md" });
		const agentNode = makeNode({ id: "node_agent", path: "/agent.md" });
		let pendingUpdates = [userUpdate, agentUpdate];
		const pendingUpdateListeners = new Set<() => void>();
		useQueryMock.mockImplementation(function useReactivePendingUpdatesQuery() {
			return useSyncExternalStore(
				(listener) => {
					pendingUpdateListeners.add(listener);
					return () => pendingUpdateListeners.delete(listener);
				},
				() => pendingUpdates,
				() => pendingUpdates,
			);
		});
		treeNodesMock.mockReturnValue([userNode, agentNode]);
		useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Agent chat" }) });

		const { container } = render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Agent chat/ }));
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text")?.textContent).toBe("/agent.md");

		act(() => {
			pendingUpdates = [userUpdate];
			for (const listener of pendingUpdateListeners) listener();
		});

		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 1 change" })).toBeTruthy();
		});
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text")?.textContent).toBe("/user.md");

		act(() => {
			pendingUpdates = [userUpdate, agentUpdate];
			for (const listener of pendingUpdateListeners) listener();
		});

		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 2 changes" })).toBeTruthy();
		});
	});

	test("bulk actions affect only the selected source", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_user", fileNodeId: "node_user", staged: "S_USER", unstaged: "U_USER" }),
			makePendingUpdate({
				id: "pu_agent",
				fileNodeId: "node_agent",
				staged: "S_AGENT",
				unstaged: "U_AGENT",
				threadIds: ["thread_a"],
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_user", path: "/user.md" }),
			makeNode({ id: "node_agent", path: "/agent.md" }),
		]);
		useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Agent chat" }) });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Agent chat/ }));
		fireEvent.click(screen.getByText("Accept all"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_agent", reviewedRevision: 1, selectedContentStateId: "pu_agent_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("bulk discard affects only the selected source", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_user", fileNodeId: "node_user", staged: "S_USER", unstaged: "U_USER" }),
			makePendingUpdate({
				id: "pu_agent",
				fileNodeId: "node_agent",
				staged: "S_AGENT",
				unstaged: "U_AGENT",
				threadIds: ["thread_a"],
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_user", path: "/user.md" }),
			makeNode({ id: "node_agent", path: "/agent.md" }),
		]);
		useQueriesMock.mockReturnValue({ thread_a: makeThread({ id: "thread_a", title: "Agent chat" }) });

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Agent chat/ }));
		fireEvent.click(screen.getByRole("button", { name: "Discard all shown pending changes" }));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_agent", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("Started discarding 1 pending changes");
	});
	test("sends only the shown folder and lets the server check hidden dependencies", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_folder",
				fileNodeId: "node_folder",
				pendingArchive: { fromPath: "/docs" },
				threadIds: ["thread_a"],
			}),
			makePendingUpdate({
				id: "pu_child",
				fileNodeId: "node_child",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_b"],
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_folder", path: "/docs", kind: "folder" }),
			makeNode({ id: "node_child", path: "/docs/report.md", parentId: "node_folder" }),
		]);
		useQueriesMock.mockReturnValue({
			thread_a: makeThread({ id: "thread_a", title: "Folder chat" }),
			thread_b: makeThread({ id: "thread_b", title: "Child chat" }),
		});

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Folder chat/ }));
		fireEvent.click(screen.getByRole("button", { name: "Accept all shown pending changes" }));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_folder", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});
	test("Review remaining changes clears the source filter so linked changes are visible", async () => {
		const updates = [
			makePendingUpdate({
				id: "pu_folder",
				fileNodeId: "node_folder",
				pendingArchive: { fromPath: "/docs" },
				threadIds: ["thread_a"],
			}),
			makePendingUpdate({
				id: "pu_child",
				fileNodeId: "node_child",
				staged: "s",
				unstaged: "u",
				threadIds: ["thread_b"],
			}),
		];
		useQueryMock.mockImplementation((query: unknown) => {
			if (query === "list_files_pending_updates") return updates;
			if (query === "review_get")
				return {
					run: { kind: "accept", step: "finished", needsReviewIds: ["pu_child"] },
					activity: { status: "failed", finishedAt: 2, errorMessage: "Review linked changes together." },
					controls: { canStop: false },
				};
			if (query === "review_list_items") return { page: [], isDone: true, continueCursor: "" };
			return undefined;
		});
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_folder", path: "/docs", kind: "folder" }),
			makeNode({ id: "node_child", path: "/docs/report.md", parentId: "node_folder" }),
		]);
		useQueriesMock.mockReturnValue({
			thread_a: makeThread({ id: "thread_a", title: "Folder chat" }),
			thread_b: makeThread({ id: "thread_b", title: "Child chat" }),
		});
		const onClose = vi.fn();
		const content = (showReview: boolean) => (
			<>
				<FileEditorSidebarPending />
				{showReview ? (
					<FilesPendingReviewModal
						membershipId={MEMBERSHIP_ID}
						runId={"review_1" as app_convex_Id<"files_pending_update_runs">}
						onClose={onClose}
					/>
				) : null}
			</>
		);
		const view = render(content(false));
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: /^Folder chat/ }));
		expect(screen.queryByRole("link", { name: "/docs/report.md" })).toBeNull();
		view.rerender(content(true));
		fireEvent.click(screen.getByRole("link", { name: "Review remaining changes" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		view.rerender(content(false));
		await waitFor(() =>
			expect(screen.getByRole("combobox", { name: "Pending changes source: All changes, 2 changes" })).toBeTruthy(),
		);
		expect(screen.getByRole("link", { name: "/docs" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "/docs/report.md" })).toBeTruthy();
		expect(startReviewMock).not.toHaveBeenCalled();
	});

	test("path link opens the file in the diff editor and preserves the full path metadata", () => {
		useQueryMock.mockReturnValue([makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" })]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/deeply/nested/intro.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "alpha/deeply/nested/intro.md" });
		const href = link?.getAttribute("href");
		expect(href).toContain("/w/team/home/files");
		expect(href).toContain("nodeId=node_a");
		expect(href).toContain("view=diff_editor");
		expect(link.getAttribute("aria-label")).toBe("alpha/deeply/nested/intro.md");
		expect(link.getAttribute("title")).toBe("alpha/deeply/nested/intro.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text")?.textContent).toBe(
			"alpha/deeply/nested/intro.md",
		);
	});

	test("truncates visible path text while preserving full path metadata", () => {
		const path = "alpha/deeply/nested/intro.md";
		const truncatedPath = "alpha/de…/intro.md";
		const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(80);
		truncatePathForWidthMock.mockReturnValue(truncatedPath);
		useQueryMock.mockReturnValue([makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" })]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: path });
		const pathText = container.querySelector(".FileEditorSidebarPending-item-path-text");
		expect(pathText?.textContent).toBe(truncatedPath);
		expect(link.getAttribute("aria-label")).toBe(path);
		expect(link.getAttribute("title")).toBe(path);
		expect(truncatePathForWidthMock).toHaveBeenCalledWith({
			path,
			width: 80,
			font: expect.stringContaining("system-ui"),
			letterSpacing: 0,
		});

		clientWidthSpy.mockRestore();
	});

	test("Accept pins the shown revision and unstaged state without staging text", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: "pu_a_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
	});
	test("Accept sends the selected state without decoding preview bytes", async () => {
		const pendingUpdate = makePendingUpdate({
			id: "pu_refused",
			fileNodeId: "node_a",
			staged: "STAGED_MD",
			unstaged: "UNSTAGED_MD",
		});
		// No preview bytes are available. Accept still sends only the reviewed state ID.
		pendingStateBytesByStateId.delete("pu_refused_staged");
		pendingStateBytesByStateId.delete("pu_refused_unstaged");
		useQueryMock.mockReturnValue([pendingUpdate]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_refused", reviewedRevision: 1, selectedContentStateId: "pu_refused_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(fetchPendingStateMock).not.toHaveBeenCalled();
	});
	test("keeps Accept disabled and Discard enabled when the owner view blocks acceptance", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);
		blockedTargetIds.add("node_a");

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("Accept").closest("button")?.hasAttribute("disabled")).toBe(true);
		expect(screen.getByText("Discard").closest("button")?.hasAttribute("disabled")).toBe(false);
	});

	test("keeps Accept disabled and Discard working for a read-only file", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md", canWrite: false })]);

		render(<FileEditorSidebarPending />);

		expect(screen.getByText("Accept").closest("button")?.hasAttribute("disabled")).toBe(true);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("disables Accept all while any visible row lacks write permission", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "alpha/other.md" }),
		]);
		blockedTargetIds.add("node_b");

		render(<FileEditorSidebarPending />);

		expect(screen.getByRole("button", { name: "Accept all shown pending changes" }).hasAttribute("disabled")).toBe(
			true,
		);
		expect(screen.getByRole("button", { name: "Discard all shown pending changes" }).hasAttribute("disabled")).toBe(
			false,
		);
		expect(screen.getByRole("button", { name: "Accept changes to alpha/intro.md" }).hasAttribute("disabled")).toBe(
			false,
		);
		expect(screen.getByRole("button", { name: "Accept changes to alpha/other.md" }).hasAttribute("disabled")).toBe(
			true,
		);
	});

	test("shows a refused review without claiming the change was accepted", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);
		startReviewMock.mockRejectedValue(new Error("Pending changes were revised. Review the latest version."));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Pending changes were revised. Review the latest version."),
		);
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("Discard selects the whole reviewed proposal", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_MD", unstaged: "UNSTAGED_MD" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "alpha/intro.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("Accept all sends one exact selection for all shown changes", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [
				{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: "pu_a_unstaged" },
				{ pendingUpdateId: "pu_b", reviewedRevision: 1, selectedContentStateId: "pu_b_unstaged" },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("Discard all sends one exact selection without changing text", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [
				{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: null },
				{ pendingUpdateId: "pu_b", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("a refused review is not retried by the browser", async () => {
		useQueryMock.mockReturnValue([makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" })]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		startReviewMock.mockRejectedValue(new Error("Rate limit exceeded"));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Rate limit exceeded"));
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("announces only that review started and keeps the proposals visible", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({ id: "pu_b", fileNodeId: "node_b", staged: "STAGED_B", unstaged: "UNSTAGED_B" }),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "alpha/intro.md" }),
			makeNode({ id: "node_b", path: "beta/readme.md" }),
		]);
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Started accepting 2 pending changes"));
		expect(screen.getByRole("link", { name: "alpha/intro.md" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "beta/readme.md" })).toBeTruthy();
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(actionMock).not.toHaveBeenCalled();
	});
	test("move row renders from → dest without an accordion or diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /docs/a.md" });
		const href = link.getAttribute("href");
		expect(href).toContain("nodeId=node_a");
		expect(href).not.toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/docs/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
		expect(container.querySelector("details")).toBeNull();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("binary replacement shows only the old and new file sizes", () => {
		const pendingUpdates = [
			makePendingUpdate({
				id: "pu_binary_replace",
				fileNodeId: "node_source",
				pendingMove: { destParentId: "root", destName: "target.mp4", fromPath: "/source.mp4" },
			}),
		];
		useQueryMock.mockImplementation((query: unknown, args: { fileNodeId?: string }) => {
			if (query === "list_files_pending_updates") return pendingUpdates;
			if (query === "get_asset_by_file_node_id") {
				return { size: args.fileNodeId === "node_source" ? 1_024 : 1_030 };
			}
			return undefined;
		});
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_source", path: "/source.mp4", hasEditableYjsState: false }),
			makeNode({ id: "node_target", path: "/target.mp4", hasEditableYjsState: false }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const details = container.querySelector("details");
		expect(details).toBeTruthy();
		const link = screen.getByRole("link", { name: "/source.mp4 → /target.mp4" });
		expect(link.getAttribute("href")).not.toContain("view=diff_editor");
		expect(useQueryMock).toHaveBeenCalledWith("get_asset_by_file_node_id", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: "node_source",
		});
		expect(useQueryMock).toHaveBeenCalledWith("get_asset_by_file_node_id", {
			membershipId: MEMBERSHIP_ID,
			fileNodeId: "node_target",
		});
		fireEvent.click(details?.querySelector("summary button") as HTMLButtonElement);

		const sizeDiff = screen.getByRole("textbox", { name: "Size difference for /source.mp4" });
		expect(sizeDiff.textContent).toContain("-Size: 1.0 KB (1030 bytes)");
		expect(sizeDiff.textContent).toContain("+Size: 1.0 KB (1024 bytes)");
		expect(fetchFileYjsStateAndTextMock).not.toHaveBeenCalled();
	});

	test("binary replacement shows when the file sizes are unchanged", () => {
		const pendingUpdates = [
			makePendingUpdate({
				id: "pu_binary_replace",
				fileNodeId: "node_source",
				pendingMove: { destParentId: "root", destName: "target.mp4", fromPath: "/source.mp4" },
			}),
		];
		useQueryMock.mockImplementation((query: unknown) => {
			if (query === "list_files_pending_updates") return pendingUpdates;
			if (query === "get_asset_by_file_node_id") return { size: 1_024 };
			return undefined;
		});
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_source", path: "/source.mp4", hasEditableYjsState: false }),
			makeNode({ id: "node_target", path: "/target.mp4", hasEditableYjsState: false }),
		]);

		const { container } = render(<FileEditorSidebarPending />);
		fireEvent.click(container.querySelector("details summary button") as HTMLButtonElement);

		expect(screen.getByRole("textbox", { name: "Size difference for /source.mp4" }).textContent).toBe(
			"Size unchanged: 1.0 KB (1024 bytes)",
		);
	});

	test("binary delete has no disclosure control or content fetch", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_binary_delete",
				fileNodeId: "node_video",
				pendingArchive: { fromPath: "/video.mp4" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_video", path: "/video.mp4", hasEditableYjsState: false })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector("details")).toBeNull();
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-deleted")?.textContent).toBe("/video.mp4");
		expect(screen.getByRole("link", { name: "/video.mp4" }).getAttribute("href")).not.toContain("view=diff_editor");
		expect(fetchFileYjsStateAndTextMock).not.toHaveBeenCalled();
	});

	test("delete with editable Yjs state starts loading committed content before the first expand", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_text_delete",
				fileNodeId: "node_text",
				pendingArchive: { fromPath: "/notes.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_text", path: "/notes.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		await waitFor(() =>
			expect(fetchFileYjsStateAndTextMock).toHaveBeenCalledWith({
				membershipId: MEMBERSHIP_ID,
				nodeId: "node_text",
			}),
		);
		const details = container.querySelector("details");
		expect(details).toBeTruthy();
		fireEvent.click(details?.querySelector("summary button") as HTMLButtonElement);

		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: "Diff preview" }).textContent).toContain("Committed content"),
		);
		expect(screen.getByRole("link", { name: "/notes.md" }).getAttribute("href")).not.toContain("view=diff_editor");
	});

	test("added row shows the green Added file caption and path and keeps the diff link", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/recorded.md" },
				privatePath: "/copy.md",
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/copy.md" }),
			makeNode({ id: "node_src", path: "/source.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Added file");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")?.textContent).toBe("/copy.md");
		const link = screen.getByRole("link", { name: "/copy.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(container.querySelector("details")).toBeTruthy();
	});

	test("row on an archived file says Archived and still accepts onto it", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_a",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md", archived: true })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Modified · Archived");
		expect(screen.getByRole("link", { name: "/a.md, archived" })).toBeTruthy();

		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_a", reviewedRevision: 1, selectedContentStateId: "pu_a_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("copy row shows the Replaced caption without the green path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/target.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test.each([true, false])(
		"whole-file copy row shows Replaced and accepts without needing its source path (visible %s)",
		async (sourceVisible) => {
			useQueryMock.mockReturnValue([
				makePendingUpdate({
					id: "pu_replacement",
					fileNodeId: "node_a",
					...(sourceVisible ? { copiedFrom: { nodeId: "node_src", path: "/photo.png" } } : {}),
					pendingReplacement: { assetId: "asset_staged", size: 3, contentType: "image/png", baseAssetId: "asset_base" },
				}),
			]);
			treeNodesMock.mockReturnValue([
				makeNode({ id: "node_a", path: "/target.md" }),
				makeNode({ id: "node_src", path: "/photo.png" }),
			]);

			const { container } = render(<FileEditorSidebarPending />);

			expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
			// No text branches to diff: the link opens the file itself.
			const link = screen.getByRole("link", { name: "/target.md" });
			expect(link.getAttribute("href")).toContain("nodeId=node_a");
			expect(link.getAttribute("href")).not.toContain("view=diff_editor");

			fireEvent.click(screen.getByText("Accept"));

			await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
			expect(startReviewMock).toHaveBeenCalledWith({
				kind: "accept",
				items: [{ pendingUpdateId: "pu_replacement", reviewedRevision: 1, selectedContentStateId: null }],
			});
			expect(upsertPendingMock).not.toHaveBeenCalled();
			expect(actionMock).not.toHaveBeenCalled();
			expect(mutationMock).not.toHaveBeenCalled();
		},
	);
	test("plain edit rows show the Modified caption without the green path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_edit", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Modified");
		expect(container.querySelector(".FileEditorSidebarPending-item-path-text-added")).toBeNull();
	});

	test.each([
		["rich_text", "plain_text"],
		["plain_text", "rich_text"],
		["rich_text", null],
	] as const)(
		"previews the retained %s proposal after restore changes the file shape to %s",
		async (sourceKind, rootKind) => {
			const pendingUpdate = {
				...makePendingUpdate({
					id: "pu_restored",
					fileNodeId: "node_restored",
					staged: "accepted\n",
					unstaged: "proposed\n",
					contentNeedsRebase: true,
				}),
				contentRebaseRootKind: sourceKind,
			};
			for (const [role, text] of [
				["staged", "accepted\n"],
				["unstaged", "proposed\n"],
			] as const) {
				const yjsDoc = files_yjs_doc_create_from_text({ text, rootKind: sourceKind });
				if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
				pendingStateBytesByStateId.set(`pu_restored_${role}`, files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)));
				yjsDoc.destroy();
			}
			useQueryMock.mockReturnValue([pendingUpdate]);
			treeNodesMock.mockReturnValue([
				{
					...makeNode({ id: "node_restored", path: "/restored.txt", hasEditableYjsState: rootKind !== null }),
					textKind: rootKind ?? undefined,
				},
			]);

			const { container } = render(<FileEditorSidebarPending />);
			fireEvent.click(container.querySelector("details summary button") as HTMLButtonElement);
			await waitFor(() =>
				expect(screen.getByRole("textbox", { name: "Diff preview" }).textContent).toContain("+proposed"),
			);
			expect(screen.getByRole("textbox", { name: "Diff preview" }).textContent).toContain("-accepted");
			fireEvent.click(screen.getByRole("button", { name: "Accept changes to /restored.txt" }));
			expect(upsertPendingMock).not.toHaveBeenCalled();
			expect(actionMock).not.toHaveBeenCalled();
		},
	);

	test("a stale row points to Review, refuses Accept, and is skipped by Accept all", async () => {
		// Collaboration off on both files. /a.md was saved after its proposal: the node moved to
		// another asset than the one the proposal was built from.
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_stale", fileNodeId: "node_a", staged: "s", unstaged: "u", baseAssetId: "asset_old" }),
			makePendingUpdate({
				id: "pu_fresh",
				fileNodeId: "node_b",
				staged: "s",
				unstaged: "u",
				baseAssetId: "asset_node_b",
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md", nonCollaborative: true }),
			makeNode({ id: "node_b", path: "/b.md", nonCollaborative: true }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(caption) => caption.textContent,
		);
		expect(captions).toEqual(["Review to update", "Modified"]);
		// The suffix gives assistive tech the caption's meaning.
		expect(screen.getByRole("link", { name: "/a.md, review to update" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "/b.md" })).toBeTruthy();

		// Accept on the stale row explains instead of sending: the server would refuse the same way.
		fireEvent.click(screen.getByRole("button", { name: "Accept changes to /a.md" }));
		await act(async () => {});
		expect(toast.error).toHaveBeenCalledWith(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();

		// Accept all skips the stale row, says so once, and accepts the fresh one.
		fireEvent.click(screen.getByText("Accept all"));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_fresh", reviewedRevision: 1, selectedContentStateId: "pu_fresh_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalledWith("Changes waiting for review are skipped. Open Review to update them.");
	});
	test("keeps changed-collaboration proposals for review and skips them while accepting a delete", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_review",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				contentNeedsRebase: true,
			}),
			makePendingUpdate({
				id: "pu_delete",
				fileNodeId: "node_b",
				staged: "s",
				unstaged: "u",
				contentNeedsRebase: true,
				pendingArchive: { fromPath: "/b.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);
		render(<FileEditorSidebarPending />);

		expect(screen.getByRole("link", { name: "/a.md, review to update" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Accept changes to /a.md" }));
		await act(async () => {});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText("Accept all"));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_delete", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalledWith("Changes waiting for review are skipped. Open Review to update them.");
	});
	test("Accept all reports both preparation reasons once and accepts only fresh content and the delete", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_stale", fileNodeId: "node_a", staged: "s", unstaged: "u", baseAssetId: "asset_old" }),
			makePendingUpdate({
				id: "pu_marked",
				fileNodeId: "node_b",
				staged: "s",
				unstaged: "u",
				contentNeedsRebase: true,
			}),
			makePendingUpdate({ id: "pu_fresh", fileNodeId: "node_c", staged: "s", unstaged: "u" }),
			makePendingUpdate({
				id: "pu_delete",
				fileNodeId: "node_d",
				staged: "s",
				unstaged: "u",
				contentNeedsRebase: true,
				pendingArchive: { fromPath: "/d.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md", nonCollaborative: true }),
			makeNode({ id: "node_b", path: "/b.md" }),
			makeNode({ id: "node_c", path: "/c.md" }),
			makeNode({ id: "node_d", path: "/d.md" }),
		]);
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [
				{ pendingUpdateId: "pu_fresh", reviewedRevision: 1, selectedContentStateId: "pu_fresh_unstaged" },
				{ pendingUpdateId: "pu_delete", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalledTimes(1);
	});
	test("mixed row keeps the accordion, compounds the caption, and shows the from → dest move label", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		const link = screen.getByRole("link", { name: "/a.md → /b.md" });
		expect(link.getAttribute("href")).toContain("view=diff_editor");
		expect(link.getAttribute("title")).toBe("/a.md → /b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-from")?.textContent).toBe("/a.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-move-label-to")?.textContent).toBe("/b.md");
		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Modified · Moved");
		expect(container.querySelector("details")).toBeTruthy();
		expect(screen.getByText("Accept")).toBeTruthy();
	});

	test("a moved private draft uses its current path and remains Added", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed_added",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				privatePath: "/b.md",
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Added file");
		expect(screen.getByRole("link", { name: "/b.md" }).getAttribute("href")).toContain("pendingNodeId=node_a");
	});

	test("move row ignores a declared target that left the destination path", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "a.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			// The declared target moved away after the proposal; nothing occupies /docs/a.md, so
			// accepting is a plain move and no file gets replaced.
			makeNode({ id: "node_dest", path: "/docs/renamed.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Moved");
	});

	test("move row uses the live destination occupant over a stale declared target", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "dest.md", fromPath: "/a.md", replacesNodeId: "node_t" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			// The declared target moved to /elsewhere.md after the proposal while a different
			// active file took /docs/dest.md; accepting archives that occupant, so show Replaced.
			makeNode({ id: "node_t", path: "/elsewhere.md" }),
			makeNode({ id: "node_o", path: "/docs/dest.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
	});

	test("move row onto an occupied destination shows Replaced, a free one shows Moved", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_occupied",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "node_docs", destName: "b.md", fromPath: "/a.md" },
			}),
			makePendingUpdate({
				id: "pu_free",
				fileNodeId: "node_c",
				pendingMove: { destParentId: "node_docs", destName: "free.md", fromPath: "/c.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_c", path: "/c.md" }),
			makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			makeNode({ id: "node_b", path: "/docs/b.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		expect(captions).toEqual(["Replaced", "Moved"]);
	});

	test("folder move row shows Replaced only for an empty folder occupant", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_folder_empty",
				fileNodeId: "node_dir_a",
				pendingMove: { destParentId: "root", destName: "empty-dst", fromPath: "/dir-a" },
			}),
			makePendingUpdate({
				id: "pu_folder_full",
				fileNodeId: "node_dir_b",
				pendingMove: { destParentId: "root", destName: "full-dst", fromPath: "/dir-b" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_dir_a", path: "/dir-a", kind: "folder" }),
			makeNode({ id: "node_dir_b", path: "/dir-b", kind: "folder" }),
			makeNode({ id: "node_empty_dst", path: "/empty-dst", kind: "folder" }),
			makeNode({ id: "node_full_dst", path: "/full-dst", kind: "folder" }),
			makeNode({ id: "node_full_child", path: "/full-dst/keep.md", parentId: "node_full_dst" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		// rename() semantics: only the empty folder occupant is replaced on accept.
		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		expect(captions).toEqual(["Replaced", "Moved"]);
	});

	test("move row onto an occupant with its own pending move shows Moved, not Replaced", () => {
		useQueryMock.mockReturnValue([
			// /a.md → /b.md while /b.md has its own pending move away: accept forces B's move
			// first, so nothing is left at /b.md to replace.
			makePendingUpdate({
				id: "pu_chain_a",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
			makePendingUpdate({
				id: "pu_chain_b",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "c.md", fromPath: "/b.md" },
			}),
			// /d.md → /e.md where /e.md has no pending move: accept still replaces it.
			makePendingUpdate({
				id: "pu_replace",
				fileNodeId: "node_d",
				pendingMove: { destParentId: "root", destName: "e.md", fromPath: "/d.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
			makeNode({ id: "node_d", path: "/d.md" }),
			makeNode({ id: "node_e", path: "/e.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		const captions = Array.from(container.querySelectorAll(".FileEditorSidebarPending-item-caption")).map(
			(element) => element.textContent,
		);
		// Rows sort by path: /a.md, /b.md, /d.md.
		expect(captions).toEqual(["Moved", "Moved", "Replaced"]);
	});

	test("mixed replace row shows the Replaced caption", () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "s",
				unstaged: "u",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md", replacesNodeId: "node_dest" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_dest", path: "/b.md" }),
		]);

		const { container } = render(<FileEditorSidebarPending />);

		expect(container.querySelector(".FileEditorSidebarPending-item-caption")?.textContent).toBe("Replaced");
		expect(screen.queryByText("Added")).toBeNull();
	});

	test("move Accept sends the exact structural review", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_move", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("a mixed review refusal leaves its move and content untouched", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		startReviewMock.mockRejectedValue(new Error("Path already exists"));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Path already exists"));
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("move Discard sends the exact reviewed proposal", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_move", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("a structural discard review refusal surfaces the error", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		startReviewMock.mockRejectedValue(new Error("Discard conflict"));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Discard conflict"));
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("Discard all shows the selection refusal without claiming completion", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		startReviewMock.mockRejectedValue(new Error("Discard conflict"));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Discard conflict"));
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("copy Discard sends one whole-proposal review", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_copy", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("private file Discard removes the whole reviewed proposal", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_added",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				privatePath: "/new.md",
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/new.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_added", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("copy Accept selects its current content state", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/copy.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_copy", reviewedRevision: 1, selectedContentStateId: "pu_copy_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("mixed Accept keeps move and content in the same exact review", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [{ pendingUpdateId: "pu_mixed", reviewedRevision: 1, selectedContentStateId: "pu_mixed_unstaged" }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(queryMock).not.toHaveBeenCalled();
	});
	test("mixed Discard selects the whole reviewed proposal", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [{ pendingUpdateId: "pu_mixed", reviewedRevision: 1, selectedContentStateId: null }],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("mixed Discard shows one review refusal", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_mixed",
				fileNodeId: "node_a",
				staged: "STAGED_MD",
				unstaged: "UNSTAGED_MD",
				pendingMove: { destParentId: "root", destName: "b.md", fromPath: "/a.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([makeNode({ id: "node_a", path: "/a.md" })]);
		startReviewMock.mockRejectedValue(new Error("Discard failed"));
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Discard failed"));
		expect(startReviewMock).toHaveBeenCalledTimes(1);
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
		expect(screen.getByRole("status").textContent).toBe("");
	});
	test("Accept all sends text and structural selections together", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_move",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "c.md", fromPath: "/b.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [
				{ pendingUpdateId: "pu_content", reviewedRevision: 1, selectedContentStateId: "pu_content_unstaged" },
				{ pendingUpdateId: "pu_move", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("Accept all sends the whole folder swap cycle in one review", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({
				id: "pu_folder_a",
				fileNodeId: "node_a",
				pendingMove: { destParentId: "root", destName: "fsc-b", fromPath: "/fsc-a" },
			}),
			makePendingUpdate({
				id: "pu_folder_b",
				fileNodeId: "node_b",
				pendingMove: { destParentId: "root", destName: "fsc-a", fromPath: "/fsc-b" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/fsc-a", kind: "folder" }),
			makeNode({ id: "node_b", path: "/fsc-b", kind: "folder" }),
		]);
		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Accept all"));
		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "accept",
			items: [
				{ pendingUpdateId: "pu_folder_a", reviewedRevision: 1, selectedContentStateId: null },
				{ pendingUpdateId: "pu_folder_b", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
	test("Discard all sends copy and content proposals together", async () => {
		useQueryMock.mockReturnValue([
			makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "STAGED_A", unstaged: "UNSTAGED_A" }),
			makePendingUpdate({
				id: "pu_copy",
				fileNodeId: "node_b",
				staged: "STAGED_B",
				unstaged: "UNSTAGED_B",
				copiedFrom: { nodeId: "node_src", path: "/source.md" },
			}),
		]);
		treeNodesMock.mockReturnValue([
			makeNode({ id: "node_a", path: "/a.md" }),
			makeNode({ id: "node_b", path: "/b.md" }),
		]);

		render(<FileEditorSidebarPending />);
		fireEvent.click(screen.getByText("Discard all"));

		await waitFor(() => expect(startReviewMock).toHaveBeenCalledTimes(1));
		expect(startReviewMock).toHaveBeenCalledWith({
			kind: "discard",
			items: [
				{ pendingUpdateId: "pu_content", reviewedRevision: 1, selectedContentStateId: null },
				{ pendingUpdateId: "pu_copy", reviewedRevision: 1, selectedContentStateId: null },
			],
		});
		expect(upsertPendingMock).not.toHaveBeenCalled();
		expect(actionMock).not.toHaveBeenCalled();
		expect(mutationMock).not.toHaveBeenCalled();
	});
});
