import { createContext, memo, use, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_ROOT_ID } from "@/lib/files.ts";

type FilesTreeRow = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree>["page"][number];

type FilesTreeFolderId = app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;

/**
 * One open folder, as its pager reports it.
 * `loading` lasts until the first page arrives, `more` while pages remain, and `done` when the folder is complete.
 */
type FilesTreeFolderResult = {
	rows: FilesTreeRow[];
	status: "loading" | "more" | "done";
	loadMore: () => void;
};

type FilesTreePinResult = FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_ancestors>;

type FilesTreeFoldersRequest = {
	folderIds: FilesTreeFolderId[];
	archived: boolean;
	/**
	 * Raw ids, like the route's `nodeId`. The server answers `null` for an id that is not a readable node.
	 */
	pinnedNodeIds: string[];
};

const FILES_TREE_PAGE_SIZE = 200;

function folder_key(folderId: FilesTreeFolderId, archived: boolean) {
	return `${folderId}:${archived ? "archived" : "active"}`;
}

const FilesTreeContext = createContext<{
	nodes: FilesTreeRow[] | undefined;
	registerConsumer: () => () => void;
	folderResults: Map<string, FilesTreeFolderResult>;
	pinResults: Map<string, FilesTreePinResult>;
	sharedRoots: {
		active: FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_shared_roots> | undefined;
		archived: FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_shared_roots> | undefined;
	};
	registerFolders: (ownerId: string, request: FilesTreeFoldersRequest) => () => void;
} | null>(null);

type FilesTreeFolderPager_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderKey: string;
	folderId: FilesTreeFolderId;
	archived: boolean;
	onResult: (folderKey: string, result: FilesTreeFolderResult | "loading" | null) => void;
};

/**
 * Page one folder: its subfolders and its files, each in the server's name order.
 */
const FilesTreeFolderPager = memo(function FilesTreeFolderPager(props: FilesTreeFolderPager_Props) {
	const { membershipId, folderKey, folderId, archived, onResult } = props;

	const folders = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children,
		{ membershipId, parentId: folderId, kind: "folder", archived },
		{ initialNumItems: FILES_TREE_PAGE_SIZE },
	);
	// Load the first files page together with the first folders page, so an open folder needs one round
	// trip. The tree sorts folders first, so a later folders page only adds rows above the files.
	const files = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children,
		{ membershipId, parentId: folderId, kind: "file", archived },
		{ initialNumItems: FILES_TREE_PAGE_SIZE },
	);

	useEffect(() => {
		// While a page loads, `results` can miss rows: a page split drops the old page before its two halves
		// arrive. So report only settled results. The provider keeps the rows it has until then.
		const settled = (status: typeof folders.status) => status === "CanLoadMore" || status === "Exhausted";
		if (!settled(folders.status) || !settled(files.status)) {
			onResult(folderKey, "loading");
			return;
		}

		onResult(folderKey, {
			rows: [...folders.results, ...files.results],
			status: folders.status === "Exhausted" && files.status === "Exhausted" ? "done" : "more",
			loadMore: () => {
				if (folders.status === "CanLoadMore") {
					folders.loadMore(FILES_TREE_PAGE_SIZE);
				} else if (files.status === "CanLoadMore") {
					files.loadMore(FILES_TREE_PAGE_SIZE);
				}
			},
		});
	}, [folderKey, folders, files, onResult]);

	useEffect(() => () => onResult(folderKey, null), [folderKey, onResult]);

	return null;
});

type FilesTreePinWatcher_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: string;
	onResult: (nodeId: string, result: FilesTreePinResult | undefined) => void;
};

/**
 * Keep one pinned node and its ancestors live, even when the page that holds the node is not loaded.
 */
const FilesTreePinWatcher = memo(function FilesTreePinWatcher(props: FilesTreePinWatcher_Props) {
	const { membershipId, nodeId, onResult } = props;
	const result = useQuery(app_convex_api.files_nodes.get_tree_ancestors, { membershipId, nodeId });

	useEffect(() => {
		if (result !== undefined) {
			onResult(nodeId, result);
		}
	}, [nodeId, result, onResult]);

	useEffect(() => () => onResult(nodeId, undefined), [nodeId, onResult]);

	return null;
});

const FilesTreeProvider = Object.assign(
	memo(function FilesTreeProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;

		// The full list is only for features that still need every node, like search. It loads only while
		// one of them is mounted.
		const [consumerCount, setConsumerCount] = useState(0);
		const registerConsumer = useCallback(() => {
			setConsumerCount((count) => count + 1);
			return () => setConsumerCount((count) => count - 1);
		}, []);
		// Each paginated hook gets its own session. Share this one across every tree consumer.
		const { results, status, loadMore } = usePaginatedQuery(
			app_convex_api.files_nodes.list_tree,
			consumerCount > 0 ? { membershipId } : "skip",
			{ initialNumItems: 500 },
		);
		const [completeTree, setCompleteTree] = useState<{
			membershipId: typeof membershipId;
			nodes: typeof results;
		} | null>(null);
		const clearCompleteTree = consumerCount === 0 || completeTree?.membershipId !== membershipId;

		if (status === "Exhausted" && completeTree?.nodes !== results) {
			setCompleteTree({ membershipId, nodes: results });
		} else if (clearCompleteTree && completeTree !== null) {
			setCompleteTree(null);
		}

		// Load folder by folder. Every consumer registers the folders it shows. One pager serves each folder.
		const [folderRequests, setFolderRequests] = useState<Map<string, FilesTreeFoldersRequest>>(new Map());
		const registerFolders = useCallback((ownerId: string, request: FilesTreeFoldersRequest) => {
			setFolderRequests((current) => new Map(current).set(ownerId, request));
			return () =>
				setFolderRequests((current) => {
					const next = new Map(current);
					next.delete(ownerId);
					return next;
				});
		}, []);

		const [folderResults, setFolderResults] = useState<Map<string, FilesTreeFolderResult>>(new Map());
		const handleFolderResult = useCallback<FilesTreeFolderPager_Props["onResult"]>((folderKey, result) => {
			setFolderResults((current) => {
				const next = new Map(current);
				if (result === null) {
					next.delete(folderKey);
				} else if (result !== "loading") {
					next.set(folderKey, result);
				} else if (!current.has(folderKey)) {
					next.set(folderKey, { rows: [], status: "loading", loadMore: () => {} });
				} else {
					return current;
				}
				return next;
			});
		}, []);

		const [pinResults, setPinResults] = useState<Map<string, FilesTreePinResult>>(new Map());
		const handlePinResult = useCallback<FilesTreePinWatcher_Props["onResult"]>((nodeId, result) => {
			setPinResults((current) => {
				const next = new Map(current);
				if (result === undefined) {
					next.delete(nodeId);
				} else {
					next.set(nodeId, result);
				}
				return next;
			});
		}, []);

		const openFolders = new Map<string, { folderId: FilesTreeFolderId; archived: boolean }>();
		const pinnedNodeIds = new Set<string>();
		let anyArchived = false;
		for (const request of folderRequests.values()) {
			if (request.archived) {
				anyArchived = true;
			}
			for (const folderId of [files_ROOT_ID, ...request.folderIds]) {
				openFolders.set(folder_key(folderId, false), { folderId, archived: false });
				if (request.archived) {
					openFolders.set(folder_key(folderId, true), { folderId, archived: true });
				}
			}
			for (const nodeId of request.pinnedNodeIds) {
				pinnedNodeIds.add(nodeId);
			}
		}

		// Folders given to this user under a folder they cannot read. The tree shows them at the top.
		const activeSharedRoots = useQuery(
			app_convex_api.files_nodes.list_tree_shared_roots,
			folderRequests.size > 0 ? { membershipId, archived: false } : "skip",
		);
		const archivedSharedRoots = useQuery(
			app_convex_api.files_nodes.list_tree_shared_roots,
			anyArchived ? { membershipId, archived: true } : "skip",
		);

		useEffect(() => {
			if (status === "CanLoadMore") {
				loadMore(500);
			} else if (status === "LoadingFirstPage") {
				// A split briefly reports this status in a discarded render. Clear only after it settles.
				setCompleteTree(null);
			}
		}, [status, loadMore]);

		// Keep the last complete query result while Convex replaces a split page.
		const nodes = status === "Exhausted" ? results : clearCompleteTree ? undefined : completeTree?.nodes;
		return (
			<FilesTreeContext.Provider
				value={{
					nodes,
					registerConsumer,
					folderResults,
					pinResults,
					sharedRoots: { active: activeSharedRoots, archived: archivedSharedRoots },
					registerFolders,
				}}
			>
				{[...openFolders].map(([folderKey, folder]) => (
					<FilesTreeFolderPager
						key={folderKey}
						membershipId={membershipId}
						folderKey={folderKey}
						folderId={folder.folderId}
						archived={folder.archived}
						onResult={handleFolderResult}
					/>
				))}
				{[...pinnedNodeIds].map((nodeId) => (
					<FilesTreePinWatcher key={nodeId} membershipId={membershipId} nodeId={nodeId} onResult={handlePinResult} />
				))}
				{children}
			</FilesTreeContext.Provider>
		);
	}),
	{
		/**
		 * Every node of the workspace. This loads the whole workspace, so use it only while a feature
		 * really needs every node. Pass `false` to stop loading when the feature is idle.
		 */
		useFullList: function useFullList(enabled: boolean) {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useFullList must be used within FilesTreeProvider");
			}
			useEffect(() => (enabled ? value.registerConsumer() : undefined), [enabled, value.registerConsumer]);
			return enabled ? value.nodes : undefined;
		},

		/**
		 * The rows of the root and of the given open folders, plus the pinned nodes with their ancestors.
		 * `rows` is `undefined` until the root's first page arrives.
		 */
		useFolders: function useFolders(request: FilesTreeFoldersRequest) {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useFolders must be used within FilesTreeProvider");
			}

			const ownerId = useId();
			const requestKey = JSON.stringify(request);
			useEffect(
				() => value.registerFolders(ownerId, JSON.parse(requestKey) as FilesTreeFoldersRequest),
				[value.registerFolders, ownerId, requestKey],
			);

			// Keep this manual memo. Callers rebuild their whole tree when these rows change identity, and a
			// new array on every render would rebuild it on every render.
			const { folderResults, pinResults, sharedRoots } = value;
			return useMemo(() => {
				const { folderIds, archived, pinnedNodeIds } = JSON.parse(requestKey) as FilesTreeFoldersRequest;
				const statusByFolderId = new Map<string, FilesTreeFolderResult["status"]>();
				const rowById = new Map<string, FilesTreeRow>();
				// Rows shown at the top because the user cannot read their parent.
				const hoistedIds = new Set<string>();

				const rootResult = folderResults.get(folder_key(files_ROOT_ID, false));
				const archivedSharedRoots = archived ? sharedRoots.archived : { rows: [], truncated: false };
				if (
					!rootResult ||
					rootResult.status === "loading" ||
					sharedRoots.active === undefined ||
					archivedSharedRoots === undefined
				) {
					return { rows: undefined, statusByFolderId, hoistedIds, loadMore: (_folderId: FilesTreeFolderId) => {} };
				}

				for (const folderId of [files_ROOT_ID, ...folderIds]) {
					const results = [
						folderResults.get(folder_key(folderId, false)),
						archived ? folderResults.get(folder_key(folderId, true)) : undefined,
					].filter((result) => result !== undefined);
					statusByFolderId.set(
						folderId,
						results.length === 0 || results.some((result) => result.status === "loading")
							? "loading"
							: results.some((result) => result.status === "more")
								? "more"
								: "done",
					);
					for (const result of results) {
						for (const row of result.rows) {
							rowById.set(row._id, row);
						}
					}
				}

				for (const row of [...sharedRoots.active.rows, ...archivedSharedRoots.rows]) {
					rowById.set(row._id, row);
					hoistedIds.add(row._id);
				}

				// A pinned node shows even when its page is not loaded yet. A loaded row always wins over the pinned copy.
				for (const nodeId of pinnedNodeIds) {
					const pin = pinResults.get(nodeId);
					if (!pin) {
						continue;
					}
					const chain = [...pin.ancestors, pin.node];
					// The top row of the chain sits under a folder the user cannot read. Show it at the top.
					if (chain[0].parentId !== files_ROOT_ID) {
						hoistedIds.add(chain[0]._id);
					}
					for (const row of chain) {
						if (!rowById.has(row._id)) {
							rowById.set(row._id, row);
						}
					}
				}

				const loadMore = (folderId: FilesTreeFolderId) => {
					folderResults.get(folder_key(folderId, false))?.loadMore();
					if (archived) {
						folderResults.get(folder_key(folderId, true))?.loadMore();
					}
				};

				return { rows: [...rowById.values()], statusByFolderId, hoistedIds, loadMore };
			}, [folderResults, pinResults, sharedRoots.active, sharedRoots.archived, requestKey]);
		},
	},
);

export { FilesTreeProvider };
