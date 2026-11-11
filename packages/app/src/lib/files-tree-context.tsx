import { createContext, memo, use, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useQuery, type UsePaginatedQueryResult } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { compareValues } from "convex/values";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_ROOT_ID } from "@/lib/files.ts";
import { files_merge_sorted_streams } from "@/hooks/files-search-hooks.ts";
import { files_sort_text_key } from "../../shared/files-sort.ts";
import type { files_DirectoryView, files_SavedStream } from "../../shared/files.ts";
import { useFilesSavedView } from "@/hooks/files-saved-view-hooks.ts";
import { useFilesPaginatedQuery } from "@/hooks/files-paginated-query-hooks.ts";
import { useFn } from "@/hooks/utils-hooks.ts";

/**
 * One tree row. A row with `locked: true` is a child the user cannot open: it has only its name,
 * type, size and dates.
 */
export type FilesTreeRow = FunctionReturnType<typeof app_convex_api.files_tree.list_tree_children>["page"][number];

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

type FilesTreePinResult = FunctionReturnType<typeof app_convex_api.files_tree.get_tree_ancestors>;

type FilesTreeFoldersRequest = {
	folderIds: FilesTreeFolderId[];
	/**
	 * Raw ids, like the route's `nodeId`. The server answers `null` for an id that is not a readable node.
	 */
	pinnedNodeIds: string[];
};

const FILES_TREE_PAGE_SIZE = 200;
const FILES_TREE_SHARED_ROOTS_PAGE_SIZE = 50;
/**
 * How long a closed folder keeps loading. It matches the 5 minutes of the query cache in `main.tsx`.
 */
const FILES_TREE_CLOSED_FOLDER_KEEP_MS = 5 * 60_000;
const FILES_TREE_NO_HOISTED_IDS: ReadonlySet<string> = new Set();

/**
 * The results after one pager report. A pager that loads again keeps the rows it has.
 */
function next_results(
	current: Map<string, FilesTreeFolderResult>,
	folderKey: string,
	result: FilesTreeFolderResult | "loading" | null,
) {
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
}

function find_loaded_node(folderResults: Map<string, FilesTreeFolderResult>, nodeId: string) {
	for (const result of folderResults.values()) {
		const row = result.rows.find((item) => item._id === nodeId);
		if (row) {
			return row;
		}
	}
	return undefined;
}

/**
 * The args of the saved streams of one kind of one folder.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function files_tree_stream_args(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: FilesTreeFolderId;
	kind: app_convex_Doc<"files_nodes">["kind"];
	stream: "normal" | "cohort";
}) {
	const { membershipId, folderId, kind, stream } = args;
	return {
		children: (restricted: boolean) => ({ membershipId, parentId: folderId, kind, restricted, stream }),
	};
}

/**
 * The server order of the live tree streams: `(sortName, name)`.
 * The server builds `sortName` with `files_sort_text_key`.
 */
function tree_row_key(row: FilesTreeRow) {
	return [files_sort_text_key(row.name), row.name];
}

/**
 * Merge the streams of one list in the server order. A node that two streams hold (shared to the
 * member and to their role, or in both tree streams for a moment right after it became restricted)
 * shows once.
 * `blocking` is the stream whose next page lets more rows show.
 */
function merge_tree_streams(streams: Array<UsePaginatedQueryResult<FilesTreeRow>>) {
	// Build each row's key once, not once per compare.
	const keys = new Map(streams.flatMap((stream) => stream.results.map((row) => [row, tree_row_key(row)] as const)));
	const merge = files_merge_sorted_streams({
		streams: streams.map((stream) => ({ rows: stream.results, isDone: stream.status === "Exhausted" })),
		compare: (a, b) => compareValues(keys.get(a)!, keys.get(b)!),
		key: (row) => row._id,
	});
	return { rows: merge.rows, blocking: merge.blockingRank === null ? null : streams[merge.blockingRank]! };
}

/**
 * One list of a picker: the merged rows of its segments, in order. A segment shows only once the
 * segments before it are done, so a later page of folders cannot push the files down. Show more
 * loads the stream that holds the last shown segment back.
 */
function picker_list(
	segments: Array<Array<UsePaginatedQueryResult<FilesTreeRow> & { directoryView?: files_DirectoryView }>>,
	pageSize: number,
	directory = false,
) {
	const streams = segments.flat();
	const viewKey = JSON.stringify(streams[0]?.directoryView);
	const viewsMatch = !directory || streams.every((stream) =>
		stream.directoryView !== undefined && JSON.stringify(stream.directoryView) === viewKey,
	);
	const openIndex = segments.findIndex((streams) => streams.some((stream) => stream.status !== "Exhausted"));
	const merges = (openIndex === -1 ? segments : segments.slice(0, openIndex + 1)).map(merge_tree_streams);
	const blocking = merges.at(-1)?.blocking ?? null;
	return {
		rows: viewsMatch ? merges.flatMap((merge) => merge.rows) : [],
		status: !viewsMatch || segments.some((streams) => streams.some((stream) =>
			stream.status === "LoadingFirstPage" || (directory && stream.status === "LoadingMore"),
		))
			? ("loading" as const)
			: openIndex === -1
				? ("done" as const)
				: ("more" as const),
		loadMore: () => blocking?.loadMore(pageSize),
	};
}

const FilesTreeContext = createContext<{
	folderResults: Map<string, FilesTreeFolderResult>;
	pinResults: Map<string, FilesTreePinResult>;
	sharedRoots: FilesTreeFolderResult;
	liveFolderIds: ReadonlySet<string>;
	isOwner: boolean | null;
	registerFolders: (ownerId: string, request: FilesTreeFoldersRequest) => () => void;
} | null>(null);

type FilesTreeFolderPager_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: FilesTreeFolderId;
	open: boolean;
	onResult: (folderKey: string, result: FilesTreeFolderResult | "loading" | null) => void;
	onExpire: (folderId: FilesTreeFolderId) => void;
};

/**
 * The streams of one kind of one folder: the open children and the restricted twin. Every reader
 * reads both. The twin gives each child the user cannot open as a locked row. With `enabled`
 * false, no stream is read.
 */
function useFilesTreeKindSource(
	args: Parameters<typeof files_tree_stream_args>[0] & {
		pageSize: number;
		enabled: boolean;
	},
) {
	const { pageSize, enabled } = args;
	const streamArgs = files_tree_stream_args(args);
	const options = { initialNumItems: pageSize };
	const streamArgsOrSkip = (restricted: boolean) =>
		enabled ? streamArgs.children(restricted) : ("skip" as const);
	const open = useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_children, streamArgsOrSkip(false), options);
	const twin = useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_children, streamArgsOrSkip(true), options);
	return [open, twin];
}

function useFilesTreeKindStreams(
	args: Omit<Parameters<typeof files_tree_stream_args>[0], "stream"> & {
		pageSize: number;
		enabled: boolean;
	},
) {
	const normal = useFilesTreeKindSource({ ...args, stream: "normal" });
	const cohort = useFilesTreeKindSource({ ...args, stream: "cohort" });
	return args.enabled ? [...normal, ...cohort] : [];
}

/**
 * Page one folder: its subfolders and its files, each in the server's name order.
 */
const FilesTreeFolderPager = memo(function FilesTreeFolderPager(props: FilesTreeFolderPager_Props) {
	const { membershipId, folderId, open, onResult, onExpire } = props;
	const wantedScope = JSON.stringify([membershipId, folderId]);
	// Show the first available rows. Remember their merged count once they settle.
	const [wanted, setWanted] = useState({ wantedScope, count: 0 });
	const wantedCount = wanted.wantedScope === wantedScope ? wanted.count : 0;

	const streamArgs = { membershipId, folderId, pageSize: FILES_TREE_PAGE_SIZE, enabled: true };
	const folders = useFilesTreeKindStreams({ ...streamArgs, kind: "folder" });
	// Load the first files page together with the first folders page, so an open folder needs one round
	// trip. The tree sorts folders first, so a later folders page only adds rows above the files.
	const files = useFilesTreeKindStreams({ ...streamArgs, kind: "file" });

	useEffect(() => {
		// While a page loads, `results` can miss rows: a page split drops the old page before its two halves
		// arrive. So report only settled results. The provider keeps the rows it has until then.
		const streams = [...folders, ...files];
		const viewKey = JSON.stringify(streams[0]?.directoryView);
		if (!streams.every((stream) =>
			(stream.status === "CanLoadMore" || stream.status === "Exhausted") &&
			stream.directoryView !== undefined && JSON.stringify(stream.directoryView) === viewKey,
		)) {
			onResult(folderId, "loading");
			return;
		}

		const folderMerge = merge_tree_streams(folders);
		const fileMerge = merge_tree_streams(files);
		const rows = [...folderMerge.rows, ...fileMerge.rows];
		const isDone = streams.every((stream) => stream.status === "Exhausted");
		if (rows.length < wantedCount && !isDone) {
			onResult(folderId, "loading");
			(folderMerge.blocking ?? fileMerge.blocking)?.loadMore(FILES_TREE_PAGE_SIZE);
			return;
		}
		if (wanted.wantedScope !== wantedScope || rows.length > wantedCount) {
			setWanted({ wantedScope, count: Math.max(wantedCount, rows.length) });
		}
		onResult(folderId, {
			rows,
			status: isDone ? "done" : "more",
			loadMore: () => setWanted({ wantedScope, count: rows.length + FILES_TREE_PAGE_SIZE }),
		});
	}, [folderId, folders, files, onResult, wantedScope, wanted, wantedCount]);

	// Stop a closed folder only after a while. Opening it again before then clears the timer.
	useEffect(() => {
		if (open) {
			return;
		}
		const timer = setTimeout(() => onExpire(folderId), FILES_TREE_CLOSED_FOLDER_KEEP_MS);
		return () => clearTimeout(timer);
	}, [open, folderId, onExpire]);

	useEffect(() => () => onResult(folderId, null), [folderId, onResult]);

	return null;
});

/**
 * The streams of the "Shared with you" group, one per principal. With `enabled` false, no stream is read.
 */
function useFilesTreeSharedRootStreams(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	enabled: boolean;
}) {
	const { membershipId, enabled } = args;
	const view = useFilesSavedView(membershipId, enabled);
	const options = { initialNumItems: FILES_TREE_SHARED_ROOTS_PAGE_SIZE };
	const sharedArgs = (principalIndex: 0 | 1 | 2, savedStream: files_SavedStream | null) =>
		enabled && savedStream ? { membershipId, principalIndex, savedStream } : ("skip" as const);
	const normal = [
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(0, view.normal), options),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(1, view.normal), options),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(2, view.normal), options),
	];
	const cohort = [
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(0, view.cohort), options),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(1, view.cohort), options),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_tree_shared_roots, sharedArgs(2, view.cohort), options),
	];
	if (!view.loading && !view.normal) return [];
	return [...normal, ...(view.cohort ? cohort : [])];
}

type FilesTreeSharedRootsPager_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	onResult: (result: FilesTreeFolderResult | "loading" | null) => void;
};

/**
 * Page every share of a member, for the "Shared with you" group. It reports like a folder pager.
 */
const FilesTreeSharedRootsPager = memo(function FilesTreeSharedRootsPager(props: FilesTreeSharedRootsPager_Props) {
	const { membershipId, onResult } = props;

	const streams = useFilesTreeSharedRootStreams({ membershipId, enabled: true });

	useEffect(() => {
		// Report only settled results, like the folder pager: a page split drops the old page before its
		// two halves arrive.
		if (!streams.every((stream) => stream.status === "CanLoadMore" || stream.status === "Exhausted")) {
			onResult("loading");
			return;
		}

		const merge = merge_tree_streams(streams);
		onResult({
			rows: merge.rows,
			status: streams.every((stream) => stream.status === "Exhausted") ? "done" : "more",
			loadMore: () => merge.blocking?.loadMore(FILES_TREE_SHARED_ROOTS_PAGE_SIZE),
		});
	}, [streams, onResult]);

	useEffect(() => () => onResult(null), [onResult]);

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
	const result = useQuery(app_convex_api.files_tree.get_tree_ancestors, { membershipId, nodeId });

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
		workspaceId: app_convex_Id<"organizations_workspaces">;
		children: ReactNode;
	}) {
		const { membershipId, workspaceId, children } = props;

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

		// Only the organization owner has every permission ("all"). The owner has no shares, so the
		// "Shared with you" streams are not read for the owner. Null while it loads, so they are read
		// until then. Read it only while a folder is shown, like the folders.
		const organizationList = useQuery(app_convex_api.organizations.list, folderRequests.size > 0 ? {} : "skip");
		const isOwner =
			organizationList === undefined ? null : organizationList.workspaceIdsPermissionsDict[workspaceId] === "all";

		const [folderResults, setFolderResults] = useState<Map<string, FilesTreeFolderResult>>(new Map());
		const handleFolderResult = useCallback<FilesTreeFolderPager_Props["onResult"]>((folderKey, result) => {
			setFolderResults((current) => next_results(current, folderKey, result));
		}, []);
		// The "Shared with you" group keeps its results apart from `folderResults`, so a group update does
		// not rebuild the tree rows.
		const [sharedRootResult, setSharedRootResult] = useState<FilesTreeFolderResult | null>(null);
		const handleSharedRootsResult = useCallback<FilesTreeSharedRootsPager_Props["onResult"]>((result) => {
			if (result !== "loading") setSharedRootResult(result);
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

		const openFolders = new Set<FilesTreeFolderId>();
		const pinnedNodeIds = new Set<string>();
		for (const request of folderRequests.values()) {
			for (const folderId of [files_ROOT_ID, ...request.folderIds]) {
				openFolders.add(folderId);
			}
			for (const nodeId of request.pinnedNodeIds) {
				pinnedNodeIds.add(nodeId);
			}
		}

		// Keep the pager of a closed folder for a while. Its rows stay live, so opening the folder again
		// shows them at once, without "Loading…". Each closed pager removes itself when its time ends.
		const [pagerFolders, setPagerFolders] = useState(openFolders);
		if ([...openFolders].some((folderId) => !pagerFolders.has(folderId))) {
			setPagerFolders(new Set([...pagerFolders, ...openFolders]));
		}
		const handleFolderExpire = useCallback<FilesTreeFolderPager_Props["onExpire"]>((folderId) => {
			setPagerFolders((current) => {
				const next = new Set(current);
				next.delete(folderId);
				return next;
			});
		}, []);
		const liveFolderIds = new Set([...pagerFolders].filter((folderId) => folderId !== files_ROOT_ID));

		// Every share of a member, for the "Shared with you" group. Its pagers report like a folder pager,
		// so the group keeps its rows through a page split like a folder. The owner has no shares to read.
		const sharedRoots: FilesTreeFolderResult =
			isOwner === true
				? { rows: [], status: "done", loadMore: () => {} }
				: (sharedRootResult ?? { rows: [], status: "loading", loadMore: () => {} });

		return (
			<FilesTreeContext.Provider
				value={{
					folderResults,
					pinResults,
					sharedRoots,
					liveFolderIds,
					isOwner,
					registerFolders,
				}}
			>
				{[...pagerFolders].map((folderId) => (
					<FilesTreeFolderPager
						key={folderId}
						membershipId={membershipId}
						folderId={folderId}
						open={openFolders.has(folderId)}
						onResult={handleFolderResult}
						onExpire={handleFolderExpire}
					/>
				))}
				{isOwner !== true && folderRequests.size > 0 && (
					<FilesTreeSharedRootsPager
						membershipId={membershipId}
						onResult={handleSharedRootsResult}
					/>
				)}
				{[...pinnedNodeIds].map((nodeId) => (
					<FilesTreePinWatcher key={nodeId} membershipId={membershipId} nodeId={nodeId} onResult={handlePinResult} />
				))}
				{children}
			</FilesTreeContext.Provider>
		);
	}),
	{
		/**
		 * The rows of the root and of the given open folders, plus the pinned nodes with their ancestors.
		 * `rows` is `undefined` until the root's first page arrives.
		 *
		 * `sharedRoots` is every share of a member, for the "Shared with you" group. A share inside a
		 * folder the member can open also shows in that folder.
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

			// Use manual memos here, not the React Compiler. Callers rebuild their whole tree when `rows` or
			// `hoistedIds` change identity. Callers also pass new `folderIds` and `pinnedNodeIds` arrays on
			// every render, and the compiler compares inputs by identity, so its cache would miss on every
			// render. These memos depend on the JSON text of the request instead.
			// The loaded rows do not read the pins. Opening a row of the tree pins a node that is already
			// loaded, so the rows keep their identity and the tree rows do not render again.
			const { folderResults, pinResults, sharedRoots } = value;
			const foldersKey = JSON.stringify(request.folderIds);
			const pinnedKey = JSON.stringify(request.pinnedNodeIds);
			const loaded = useMemo(() => {
				const folderIds = JSON.parse(foldersKey) as FilesTreeFolderId[];
				const statusByFolderId = new Map<string, FilesTreeFolderResult["status"]>();
				const rowById = new Map<string, FilesTreeRow>();

				const rootResult = folderResults.get(files_ROOT_ID);
				if (!rootResult || rootResult.status === "loading") {
					return {
						rowById: undefined,
						rows: undefined,
						statusByFolderId,
						loadMore: (_folderId: FilesTreeFolderId) => {},
					};
				}

				for (const folderId of [files_ROOT_ID, ...folderIds]) {
					const result = folderResults.get(folderId);
					statusByFolderId.set(folderId, result?.status ?? "loading");
					for (const row of result?.rows ?? []) {
						rowById.set(row._id, row);
					}
				}

				const loadMore = (folderId: FilesTreeFolderId) => {
					folderResults.get(folderId)?.loadMore();
				};

				return { rowById, rows: [...rowById.values()], statusByFolderId, loadMore };
			}, [folderResults, foldersKey]);

			const folders = useMemo(() => {
				const pinnedNodeIds = JSON.parse(pinnedKey) as string[];
				const { rowById, rows, statusByFolderId, loadMore } = loaded;
				// Rows shown at the top because the user cannot read their parent.
				const hoistedIds = new Set<string>();
				const pinnedRowById = new Map<string, FilesTreeRow>();

				// A pinned node shows even when its page is not loaded yet. A loaded row always wins over the pinned copy.
				for (const nodeId of rowById ? pinnedNodeIds : []) {
					const pin = pinResults.get(nodeId);
					if (!pin) {
						continue;
					}
					const chain = [...pin.ancestors, pin.node];
					// The top row of the chain sits under a folder the user cannot read. Show it at the top.
					if (chain[0].parentId !== files_ROOT_ID) {
						hoistedIds.add(chain[0]._id);
					}
					// The server gives a pinned node and its ancestors only when the user can open them.
					for (const row of chain) {
						if (!rowById?.has(row._id) && !pinnedRowById.has(row._id)) {
							pinnedRowById.set(row._id, { ...row, locked: false });
						}
					}
				}

				return {
					rows: rows && pinnedRowById.size > 0 ? [...rows, ...pinnedRowById.values()] : rows,
					statusByFolderId,
					// Share one empty set, so a pin with nothing to hoist keeps the same set.
					hoistedIds: hoistedIds.size > 0 ? hoistedIds : FILES_TREE_NO_HOISTED_IDS,
					loadMore,
				};
			}, [loaded, pinResults, pinnedKey]);

			return { ...folders, sharedRoots };
		},

		/**
		 * The folders that load now, besides the root: every open folder, and every folder that closed in
		 * the last 5 minutes. A consumer can ask for one of them and get its rows at once.
		 */
		useLiveFolderIds: function useLiveFolderIds() {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useLiveFolderIds must be used within FilesTreeProvider");
			}
			return value.liveFolderIds;
		},

		/**
		 * The node's row when any loading folder has loaded it, else undefined. Every consumer's folders
		 * count, so a row the sidebar shows is found even when the caller did not ask for its folder.
		 */
		useLoadedNode: function useLoadedNode(nodeId: string | undefined) {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useLoadedNode must be used within FilesTreeProvider");
			}

			if (nodeId === undefined) {
				return undefined;
			}
			return find_loaded_node(value.folderResults, nodeId);
		},

		/**
		 * Like `useLoadedNode`, as a function for event handlers such as a navigation listener.
		 * The function keeps one identity and always reads the latest rows.
		 */
		useGetLoadedNode: function useGetLoadedNode() {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useGetLoadedNode must be used within FilesTreeProvider");
			}

			const { folderResults } = value;
			return useFn((nodeId: string) => find_loaded_node(folderResults, nodeId));
		},

		/**
		 * Whether the reader owns the organization, or null while that loads. Only the owner reads the
		 * restricted rows of a custom-field sort or filter by value.
		 */
		useIsOwner: function useIsOwner() {
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.useIsOwner must be used within FilesTreeProvider");
			}
			return value.isOwner;
		},

		/**
		 * One folder's saved children for a picker, folders first, in the tree's order. It reads the
		 * tree's streams with the picker's page size, not through the shared pagers, so a picker's pages
		 * do not grow the sidebar's folders. `withFiles: false` reads the folder streams only, and
		 * `folderId: null` reads nothing.
		 *
		 * `shared` is every share of a member at the root, like the "Shared with you" group, and null
		 * elsewhere. A member without workspace read gets no root rows, so they see only that group.
		 */
		usePickerFolder: function usePickerFolder(args: {
			membershipId: app_convex_Id<"organizations_workspaces_users">;
			folderId: FilesTreeFolderId | null;
			withFiles: boolean;
			pageSize: number;
		}) {
			const { membershipId, folderId, withFiles, pageSize } = args;
			const value = use(FilesTreeContext);
			if (!value) {
				throw new Error("FilesTreeProvider.usePickerFolder must be used within FilesTreeProvider");
			}
			const { isOwner } = value;

			const streamArgs = {
				membershipId,
				folderId: folderId ?? files_ROOT_ID,
				pageSize,
			};
			const folders = useFilesTreeKindStreams({ ...streamArgs, kind: "folder", enabled: folderId !== null });
			const files = useFilesTreeKindStreams({ ...streamArgs, kind: "file", enabled: folderId !== null && withFiles });
			// The owner reads everything, so the owner has no shares to read.
			const hasShared = folderId === files_ROOT_ID && isOwner !== true;
			const shared = useFilesTreeSharedRootStreams({ membershipId, enabled: hasShared });
			const children = picker_list(withFiles ? [folders, files] : [folders], pageSize, true);
			const scope = JSON.stringify([membershipId, folderId, withFiles]);
			// A short first page is ready. A refreshed view must refill the rows already shown.
			const [wanted, setWanted] = useState({ scope, count: 0 });
			const wantedCount = wanted.scope === scope ? wanted.count : 0;
			const isSettled = children.status !== "loading" && (children.status === "done" || children.rows.length >= wantedCount);
			useEffect(() => {
				if (children.status === "more" && children.rows.length < wantedCount) children.loadMore();
			});
			const key = JSON.stringify(children.rows);
			const [heldChildren, setHeldChildren] = useState<{ scope: string; key: string; rows: FilesTreeRow[] } | null>(null);
			if (isSettled && (wanted.scope !== scope || children.rows.length > wantedCount)) {
				setWanted({ scope, count: Math.max(wantedCount, children.rows.length) });
			}
			if (isSettled && (heldChildren?.scope !== scope || heldChildren.key !== key)) {
				setHeldChildren({ scope, key, rows: children.rows });
			}

			return {
				children: {
					...children,
					status: isSettled ? children.status : "loading" as const,
					rows: isSettled ? children.rows : (heldChildren?.scope === scope ? heldChildren.rows : []),
					loadMore: () => setWanted({ scope, count: children.rows.length + pageSize }),
				},
				shared: hasShared ? picker_list([shared], pageSize) : null,
			};
		},
	},
);

export { FilesTreeProvider };
