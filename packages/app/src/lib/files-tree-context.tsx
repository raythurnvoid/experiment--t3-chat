import { createContext, memo, use, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { usePaginatedQuery, useQuery, type UsePaginatedQueryResult } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { compareValues } from "convex/values";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_ROOT_ID } from "@/lib/files.ts";
import { files_merge_sorted_streams } from "@/hooks/files-search-hooks.ts";
import { files_sort_text_key } from "../../shared/files-sort.ts";
import type { files_SavedStream } from "../../shared/files.ts";
import { useFilesSavedView } from "@/hooks/files-saved-view-hooks.ts";

type FilesTreeRow = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children>["page"][number];

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
const FILES_TREE_SHARED_ROOTS_PAGE_SIZE = 50;

function folder_key(folderId: FilesTreeFolderId, archived: boolean) {
	return `${folderId}:${archived ? "archived" : "active"}`;
}

function shared_roots_key(archived: boolean) {
	return `shared-roots:${archived ? "archived" : "active"}`;
}

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

/**
 * The args of the saved streams of one kind of one folder.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function files_tree_stream_args(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: FilesTreeFolderId;
	kind: app_convex_Doc<"files_nodes">["kind"];
	archived: boolean;
	savedStream?: files_SavedStream;
}) {
	const { membershipId, folderId, kind, archived, savedStream } = args;
	return {
		children: (restricted: boolean) => ({ membershipId, parentId: folderId, kind, archived, restricted, ...(savedStream ? { savedStream } : {}) }),
		// The tree reads the share copies in the folder table's name order.
		shared: (principalIndex: 0 | 1 | 2) => ({
			membershipId,
			parentId: folderId,
			kind,
			archived,
			principalIndex,
			sort: [{ field: "name", direction: "asc" as const }],
			filter: null,
			namePrefix: null,
			segment: "value" as const,
			...(savedStream ? { savedStream } : {}),
		}),
	};
}

/**
 * The server order of the tree streams: active rows by `(sortName, name)`, archived rows by
 * `(archiveOperationId, sortName, name)`. The server builds `sortName` with `files_sort_text_key`.
 */
function tree_row_key(row: FilesTreeRow) {
	const nameKey = [files_sort_text_key(row.name), row.name];
	return row.archiveOperationId === null ? nameKey : [row.archiveOperationId, ...nameKey];
}

/**
 * Merge the streams of one list in the server order. A node that two streams hold (shared to the
 * member and to their role) shows once. `blocking` is the stream whose next page lets more rows show.
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
function picker_list(segments: Array<Array<UsePaginatedQueryResult<FilesTreeRow>>>, pageSize: number) {
	const openIndex = segments.findIndex((streams) => streams.some((stream) => stream.status !== "Exhausted"));
	const merges = (openIndex === -1 ? segments : segments.slice(0, openIndex + 1)).map(merge_tree_streams);
	const blocking = merges.at(-1)?.blocking ?? null;
	return {
		rows: merges.flatMap((merge) => merge.rows),
		status: segments.some((streams) => streams.some((stream) => stream.status === "LoadingFirstPage"))
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
	sharedRoots: { active: FilesTreeFolderResult; archived: FilesTreeFolderResult };
	isOwner: boolean | null;
	registerFolders: (ownerId: string, request: FilesTreeFoldersRequest) => () => void;
} | null>(null);

type FilesTreeFolderPager_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderKey: string;
	folderId: FilesTreeFolderId;
	archived: boolean;
	/**
	 * Whether the reader owns the organization, or null while that loads.
	 */
	isOwner: boolean | null;
	onResult: (folderKey: string, result: FilesTreeFolderResult | "loading" | null) => void;
};

/**
 * The streams of one kind of one folder: the open children, the owner's restricted children, and
 * the restricted children shared with a member, one stream per principal. Each stream answers an
 * empty, done page to the readers it is not for. Once the role is known, those streams are not read.
 * With `enabled` false, no stream is read.
 */
function useFilesTreeKindSource(
	args: Omit<Parameters<typeof files_tree_stream_args>[0], "savedStream"> & {
		isOwner: FilesTreeFolderPager_Props["isOwner"];
		pageSize: number;
		enabled: boolean;
		savedStream: files_SavedStream | null;
	},
) {
	const { isOwner, pageSize, enabled } = args;
	const streamArgs = files_tree_stream_args({ ...args, savedStream: args.savedStream ?? undefined });
	const options = { initialNumItems: pageSize };
	const openArgs = enabled && args.savedStream ? streamArgs.children(false) : ("skip" as const);
	const twinArgs = !enabled || !args.savedStream || isOwner === false ? ("skip" as const) : streamArgs.children(true);
	const sharedArgs = (principalIndex: 0 | 1 | 2) =>
		!enabled || !args.savedStream || isOwner === true ? ("skip" as const) : streamArgs.shared(principalIndex);
	const open = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children, openArgs, options);
	const twin = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children, twinArgs, options);
	const shared0 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(0), options);
	const shared1 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(1), options);
	const shared2 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(2), options);
	// A skipped stream reports `LoadingFirstPage` forever, so leave it out.
	return [open, ...(isOwner === false ? [] : [twin]), ...(isOwner === true ? [] : [shared0, shared1, shared2])];
}

function useFilesTreeKindStreams(
	args: Parameters<typeof files_tree_stream_args>[0] & {
		isOwner: FilesTreeFolderPager_Props["isOwner"];
		pageSize: number;
		enabled: boolean;
	},
) {
	const view = useFilesSavedView(args.membershipId, args.enabled);
	const normal = useFilesTreeKindSource({ ...args, savedStream: view.normal });
	const cohort = useFilesTreeKindSource({ ...args, savedStream: view.cohort });
	if (!view.loading && !view.normal) return [];
	return [...normal, ...(view.cohort ? cohort : [])];
}

/**
 * Page one folder: its subfolders and its files, each in the server's name order.
 */
const FilesTreeFolderPager = memo(function FilesTreeFolderPager(props: FilesTreeFolderPager_Props) {
	const { membershipId, folderKey, folderId, archived, isOwner, onResult } = props;

	const streamArgs = { membershipId, folderId, archived, isOwner, pageSize: FILES_TREE_PAGE_SIZE, enabled: true };
	const folders = useFilesTreeKindStreams({ ...streamArgs, kind: "folder" });
	// Load the first files page together with the first folders page, so an open folder needs one round
	// trip. The tree sorts folders first, so a later folders page only adds rows above the files.
	const files = useFilesTreeKindStreams({ ...streamArgs, kind: "file" });

	useEffect(() => {
		// While a page loads, `results` can miss rows: a page split drops the old page before its two halves
		// arrive. So report only settled results. The provider keeps the rows it has until then.
		const streams = [...folders, ...files];
		if (!streams.every((stream) => stream.status === "CanLoadMore" || stream.status === "Exhausted")) {
			onResult(folderKey, "loading");
			return;
		}

		const folderMerge = merge_tree_streams(folders);
		const fileMerge = merge_tree_streams(files);
		onResult(folderKey, {
			rows: [...folderMerge.rows, ...fileMerge.rows],
			status: streams.every((stream) => stream.status === "Exhausted") ? "done" : "more",
			loadMore: () => (folderMerge.blocking ?? fileMerge.blocking)?.loadMore(FILES_TREE_PAGE_SIZE),
		});
	}, [folderKey, folders, files, onResult]);

	useEffect(() => () => onResult(folderKey, null), [folderKey, onResult]);

	return null;
});

/**
 * The streams of the "Shared with you" group, one per principal. With `enabled` false, no stream is read.
 */
function useFilesTreeSharedRootStreams(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	archived: boolean;
	enabled: boolean;
}) {
	const { membershipId, archived, enabled } = args;
	const view = useFilesSavedView(membershipId, enabled);
	const options = { initialNumItems: FILES_TREE_SHARED_ROOTS_PAGE_SIZE };
	const sharedArgs = (principalIndex: 0 | 1 | 2, savedStream: files_SavedStream | null) =>
		enabled && savedStream ? { membershipId, archived, principalIndex, savedStream } : ("skip" as const);
	const normal = [
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(0, view.normal), options),
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(1, view.normal), options),
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(2, view.normal), options),
	];
	const cohort = [
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(0, view.cohort), options),
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(1, view.cohort), options),
		usePaginatedQuery(app_convex_api.files_nodes.list_tree_shared_roots, sharedArgs(2, view.cohort), options),
	];
	if (!view.loading && !view.normal) return [];
	return [...normal, ...(view.cohort ? cohort : [])];
}

type FilesTreeSharedRootsPager_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderKey: string;
	archived: boolean;
	onResult: FilesTreeFolderPager_Props["onResult"];
};

/**
 * Page every share of a member, for the "Shared with you" group. It reports like a folder pager.
 */
const FilesTreeSharedRootsPager = memo(function FilesTreeSharedRootsPager(props: FilesTreeSharedRootsPager_Props) {
	const { membershipId, folderKey, archived, onResult } = props;

	const streams = useFilesTreeSharedRootStreams({ membershipId, archived, enabled: true });

	useEffect(() => {
		// Report only settled results, like the folder pager: a page split drops the old page before its
		// two halves arrive.
		if (!streams.every((stream) => stream.status === "CanLoadMore" || stream.status === "Exhausted")) {
			onResult(folderKey, "loading");
			return;
		}

		const merge = merge_tree_streams(streams);
		onResult(folderKey, {
			rows: merge.rows,
			status: streams.every((stream) => stream.status === "Exhausted") ? "done" : "more",
			loadMore: () => merge.blocking?.loadMore(FILES_TREE_SHARED_ROOTS_PAGE_SIZE),
		});
	}, [folderKey, streams, onResult]);

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

		// Only the organization owner has every permission ("all"). The owner reads restricted children
		// in the restricted twins, and a member reads them in the share streams. Null while it loads,
		// so every stream is read until then. Read it only while a folder is shown, like the folders.
		const organizationList = useQuery(app_convex_api.organizations.list, folderRequests.size > 0 ? {} : "skip");
		const isOwner =
			organizationList === undefined ? null : organizationList.workspaceIdsPermissionsDict[workspaceId] === "all";

		const [folderResults, setFolderResults] = useState<Map<string, FilesTreeFolderResult>>(new Map());
		const handleFolderResult = useCallback<FilesTreeFolderPager_Props["onResult"]>((folderKey, result) => {
			setFolderResults((current) => next_results(current, folderKey, result));
		}, []);
		// The "Shared with you" group keeps its results apart from `folderResults`, so a group update does
		// not rebuild the tree rows.
		const [sharedRootResults, setSharedRootResults] = useState<Map<string, FilesTreeFolderResult>>(new Map());
		const handleSharedRootsResult = useCallback<FilesTreeFolderPager_Props["onResult"]>((folderKey, result) => {
			setSharedRootResults((current) => next_results(current, folderKey, result));
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

		// Every share of a member, for the "Shared with you" group. Its pagers report like a folder pager,
		// so the group keeps its rows through a page split like a folder. The owner has no shares to read.
		const get_shared_roots = (archived: boolean): FilesTreeFolderResult =>
			isOwner === true
				? { rows: [], status: "done", loadMore: () => {} }
				: (sharedRootResults.get(shared_roots_key(archived)) ?? { rows: [], status: "loading", loadMore: () => {} });

		return (
			<FilesTreeContext.Provider
				value={{
					folderResults,
					pinResults,
					sharedRoots: { active: get_shared_roots(false), archived: get_shared_roots(true) },
					isOwner,
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
						isOwner={isOwner}
						onResult={handleFolderResult}
					/>
				))}
				{isOwner !== true && folderRequests.size > 0 && (
					<FilesTreeSharedRootsPager
						membershipId={membershipId}
						folderKey={shared_roots_key(false)}
						archived={false}
						onResult={handleSharedRootsResult}
					/>
				)}
				{isOwner !== true && anyArchived && (
					<FilesTreeSharedRootsPager
						membershipId={membershipId}
						folderKey={shared_roots_key(true)}
						archived
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

			// Keep this manual memo. Callers rebuild their whole tree when these rows change identity, and a
			// new array on every render would rebuild it on every render.
			const { folderResults, pinResults, sharedRoots } = value;
			const folders = useMemo(() => {
				const { folderIds, archived, pinnedNodeIds } = JSON.parse(requestKey) as FilesTreeFoldersRequest;
				const statusByFolderId = new Map<string, FilesTreeFolderResult["status"]>();
				const rowById = new Map<string, FilesTreeRow>();
				// Rows shown at the top because the user cannot read their parent.
				const hoistedIds = new Set<string>();

				const rootResult = folderResults.get(folder_key(files_ROOT_ID, false));
				if (!rootResult || rootResult.status === "loading") {
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
			}, [folderResults, pinResults, requestKey]);

			// Active shares first, then archived ones while the archived items show.
			const sharedRootsResult: FilesTreeFolderResult = request.archived
				? {
						rows: [...sharedRoots.active.rows, ...sharedRoots.archived.rows],
						status:
							sharedRoots.active.status === "loading" || sharedRoots.archived.status === "loading"
								? "loading"
								: sharedRoots.active.status === "more" || sharedRoots.archived.status === "more"
									? "more"
									: "done",
						loadMore:
							sharedRoots.active.status === "more" ? sharedRoots.active.loadMore : sharedRoots.archived.loadMore,
					}
				: sharedRoots.active;
			return { ...folders, sharedRoots: sharedRootsResult };
		},

		/**
		 * Whether the reader owns the organization, or null while that loads. The owner reads restricted
		 * children in the restricted twins, and a member reads them in the share streams.
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
				archived: false,
				isOwner,
				pageSize,
			};
			const folders = useFilesTreeKindStreams({ ...streamArgs, kind: "folder", enabled: folderId !== null });
			const files = useFilesTreeKindStreams({ ...streamArgs, kind: "file", enabled: folderId !== null && withFiles });
			// The owner reads everything, so the owner has no shares to read.
			const hasShared = folderId === files_ROOT_ID && isOwner !== true;
			const shared = useFilesTreeSharedRootStreams({ membershipId, archived: false, enabled: hasShared });

			return {
				children: picker_list(withFiles ? [folders, files] : [folders], pageSize),
				shared: hasShared ? picker_list([shared], pageSize) : null,
			};
		},
	},
);

export { FilesTreeProvider };
