import { useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useFn } from "./utils-hooks.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_TreeItem } from "@/lib/files.ts";
import { search_path_filter } from "@/lib/files-search.ts";
import {
	files_search_query_folder_path,
	files_search_query_parse,
	files_search_query_to_plans,
} from "../../shared/files-search-query.ts";
import { files_sort_compare, type files_sort_RowKey, type files_sort_Sort } from "../../shared/files-sort.ts";
import { files_table_metadata_field, type files_table_Filter } from "../../shared/files-table.ts";

/**
 * Page `files_visible.list` 50 entries at a time, and return the entries only when the listing is done.
 */
export function useFilesVisibleEntries(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderPath: string | null | undefined;
	mode: "subtree" | "children";
}) {
	const { membershipId, folderPath, mode } = args;

	const scope = JSON.stringify([membershipId, folderPath, mode]);
	const [pages, setPages] = useState({ scope, cursors: [null] as Array<string | null> });
	const cursors = useMemo(() => (pages.scope === scope ? pages.cursors : [null]), [scope, pages]);

	const queries = useMemo(
		() =>
			typeof folderPath !== "string"
				? {}
				: Object.fromEntries(
						cursors.map((cursor, index) => [
							index,
							{
								query: app_convex_api.files_visible.list,
								args: {
									membershipId,
									folderPath,
									mode,
									numItems: 50,
									cursor,
								},
							},
						]),
					),
		[cursors, folderPath, membershipId, mode],
	);

	const responses = useQueries(queries);

	const progress = useMemo(() => {
		type Page = FunctionReturnType<typeof app_convex_api.files_visible.list>;
		const entries: Array<NonNullable<Page["_yay"]>["items"][number]> = [];
		let nextCursors: Array<string | null> | null = null;
		let complete = folderPath === null;
		let failed = false;

		for (let index = 0; index < cursors.length; index++) {
			const response: Page | Error | undefined = responses[index];
			if (response === undefined) break;
			if (response instanceof Error || response._nay) {
				failed = true;
				break;
			}

			entries.push(...response._yay.items);
			if (response._yay.isDone) {
				complete = true;
				if (index + 1 < cursors.length) nextCursors = cursors.slice(0, index + 1);
				break;
			}

			const cursor = response._yay.continueCursor;
			if (cursor === null) {
				failed = true;
				break;
			}
			if (cursor !== cursors[index + 1]) {
				nextCursors = [...cursors.slice(0, index + 1), cursor];
				break;
			}
		}

		return { entries: complete && !failed ? entries : undefined, nextCursors, complete, failed };
	}, [cursors, folderPath, responses]);

	// Keep all loaded pages subscribed. If an earlier cursor changes, discard its old suffix.
	useEffect(() => {
		if (pages.scope === scope && !progress.nextCursors) return;
		// Cached pages can resolve all at once. Yield between pages so the input stays responsive.
		const timer = setTimeout(() => setPages({ scope, cursors: progress.nextCursors ?? cursors }), 0);
		return () => clearTimeout(timer);
	}, [cursors, scope, pages.scope, progress.nextCursors]);

	return { entries: progress.entries, isFailed: progress.failed };
}

const FILES_SORTED_CHILDREN_PAGE_SIZE = 100;

type FilesSortedChildrenRow = {
	target: { kind: "saved"; id: app_convex_Id<"files_nodes"> };
	name: string;
	kind: app_convex_Doc<"files_nodes">["kind"];
	createdAt: number;
	updatedAt: number;
	contentByteSize: number | null;
	updatedBy: app_convex_Id<"users">;
	contentType: app_convex_Doc<"files_nodes">["contentType"];
	treeRow: FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>["page"][number];
	sortKey: files_sort_RowKey;
	segment: "value" | "missing";
};

/**
 * The state of one stream. `inactive` is a stream that has not started, so it is not loading.
 */
type FilesSortedChildrenStreamStatus = "inactive" | "loading" | "more" | "done";

type FilesSortedChildrenStream = {
	rows: FilesSortedChildrenRow[];
	status: FilesSortedChildrenStreamStatus;
	loadMore: () => void;
};

/**
 * Merge sorted streams into one sorted list. A row shows only when every other stream that is not
 * done has loaded strictly past it. Otherwise the next page of that stream could still hold a row
 * that sorts before it. Rows with the same key keep the stream order: a stream's index is its rank.
 *
 * With `key`, rows with the same key show once, in the first place. A node shared to the member and
 * to their role is in two streams, and a node can be in two streams for a moment, for example right
 * after it became restricted.
 *
 * Returns the rows to show, and the index of the stream that holds the merge back: the stream that
 * is not done and whose loaded rows end first. Its next page lets more rows show.
 */
export function files_merge_sorted_streams<Row>(args: {
	streams: Array<{ rows: Row[]; isDone: boolean }>;
	compare: (a: Row, b: Row) => number;
	key?: (row: Row) => string;
}) {
	const { streams, compare, key } = args;

	type RankedRow = { row: Row; rank: number };
	const compareRanked = (a: RankedRow, b: RankedRow) => compare(a.row, b.row) || a.rank - b.rank;
	const openStreams = streams.flatMap((stream, rank) =>
		stream.isDone
			? []
			: [{ rank, last: stream.rows.length === 0 ? null : { row: stream.rows[stream.rows.length - 1]!, rank } }],
	);

	const rows = streams
		.flatMap((stream, rank) => stream.rows.map((row): RankedRow => ({ row, rank })))
		.filter((entry) =>
			openStreams.every(
				// A stream's own next page sorts after its loaded rows, so only the other streams hold a row back.
				(stream) => stream.rank === entry.rank || (stream.last !== null && compareRanked(stream.last, entry) > 0),
			),
		)
		.sort(compareRanked)
		.map((entry) => entry.row);
	const seenKeys = new Set<string>();
	const shownRows = key
		? rows.filter((row) => {
				const rowKey = key(row);
				if (seenKeys.has(rowKey)) return false;
				seenKeys.add(rowKey);
				return true;
			})
		: rows;

	// A stream with no loaded rows holds back every other row.
	const blocking = openStreams.reduce<(typeof openStreams)[number] | null>(
		(min, stream) =>
			min === null || (min.last !== null && (stream.last === null || compareRanked(stream.last, min.last) < 0))
				? stream
				: min,
		null,
	);

	return { rows: shownRows, blockingRank: blocking?.rank ?? null };
}

type useFilesSortedChildren_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	/**
	 * The order of the table, one clause. While a filter is on it must be the filter's order
	 * (`files_table_filter_order_field`), because the filter picks the index and the index fixes the
	 * order. Null waits, for example for the folder's saved sort.
	 */
	sort: files_sort_Sort | null;
	filter: files_table_Filter | null;
	/**
	 * The `file.name:starts_with` value that joins an "is" filter, or null.
	 */
	namePrefix: string | null;
	/**
	 * Whether the reader owns the organization, or null while that loads. Once known, the streams
	 * that cannot have rows for this reader are not read.
	 */
	isOwner: boolean | null;
};

/**
 * The streams of one kind and one segment of the folder table: the open rows, the owner's
 * restricted rows (empty for everyone else), then the restricted children shared with a member,
 * one stream per principal (empty for the owner). A metadata sort or filter has no shared rows
 * (`metadataKey`).
 */
function useFilesSortedChildrenSegment(
	props: useFilesSortedChildren_Props & {
		kind: app_convex_Doc<"files_nodes">["kind"];
		segment: FilesSortedChildrenRow["segment"];
		active: boolean;
		metadataKey: string | null;
	},
): FilesSortedChildrenStream[] {
	const { membershipId, folderId, sort, filter, namePrefix, kind, segment, active, isOwner } = props;
	// Skip the streams that cannot have rows. Only the owner reads the restricted twin, and only a
	// member reads shares, which have no metadata copy. The server refuses them all the same.
	const skipsTwin = isOwner === false;
	const skipsShares = props.metadataKey !== null || isOwner === true;
	const sortedArgs = (restricted: boolean) =>
		!active || sort === null || (restricted && skipsTwin)
			? ("skip" as const)
			: { membershipId, parentId: folderId, kind, sort, filter, namePrefix, restricted, segment };
	const sharedArgs = (principalIndex: 0 | 1 | 2) =>
		!active || sort === null || skipsShares
			? ("skip" as const)
			: { membershipId, parentId: folderId, kind, archived: false, principalIndex, sort, filter, namePrefix, segment };
	const options = { initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE };

	const open = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_sorted, sortedArgs(false), options);
	const restricted = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_sorted, sortedArgs(true), options);
	const shared0 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(0), options);
	const shared1 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(1), options);
	const shared2 = usePaginatedQuery(app_convex_api.files_nodes.list_tree_children_shared, sharedArgs(2), options);

	return [open, restricted, shared0, shared1, shared2].map((result, index) => ({
		rows: result.results.map((row): FilesSortedChildrenRow => ({
			target: { kind: "saved", id: row._id },
			name: row.name,
			kind: row.kind,
			createdAt: row._creationTime,
			updatedAt: row.updatedAt,
			contentByteSize: row.contentByteSize,
			updatedBy: row.updatedBy,
			contentType: row.contentType,
			treeRow: row,
			segment,
			sortKey: row.sortKey,
		})),
		// A skipped `usePaginatedQuery` reports `LoadingFirstPage` forever, so a stream that has not
		// started must count as inactive, not as loading. A stream skipped because it cannot have rows
		// is done.
		status:
			(index === 1 && skipsTwin) || (index >= 2 && skipsShares)
				? "done"
				: !active
					? "inactive"
					: result.status === "Exhausted"
						? "done"
						: result.status === "CanLoadMore"
							? "more"
							: "loading",
		loadMore: () => result.loadMore(FILES_SORTED_CHILDREN_PAGE_SIZE),
	}));
}

/**
 * The saved children of one folder for the folder table, in the order of `sort`. Folders come
 * first. The table is saved-only on purpose: drafts show in the Pending tab and to the agent. See
 * "Saved-only lists" in `.agents/skills/files-explorer-tree/SKILL.md`.
 *
 * Each kind reads a value segment and, for file.extension and file.size with no filter, a missing
 * segment with the rows that have no value. A missing segment starts only after its value segment is
 * done. Each segment merges the streams of `useFilesSortedChildrenSegment`, and a node that two
 * streams hold (shared to the member and to their role) shows once.
 *
 * While a page or a new sort loads, `rows` keeps the last settled rows and `isBusy` is true. `sort:
 * null` waits.
 */
export function useFilesSortedChildren(props: useFilesSortedChildren_Props) {
	const { membershipId, folderId, sort, filter, namePrefix } = props;
	const field = sort?.[0]?.field ?? null;
	const metadataKey = files_table_metadata_field({ sort: sort?.[0] ?? null, filter });
	// No folder has a file.extension. A file.size sort keeps folders in the value segment, by name. A
	// metadata sort has no missing segment: rows without the key are hidden.
	const hasFolderMissing = filter === null && field === "extension";
	const hasFileMissing = filter === null && (field === "extension" || field === "size");

	const sortScope = JSON.stringify([membershipId, folderId, sort, filter, namePrefix]);
	const [retrying, setRetrying] = useState(false);
	const [startedMissing, setStartedMissing] = useState({ sortScope, folder: false, file: false });
	const started = startedMissing.sortScope === sortScope ? startedMissing : { sortScope, folder: false, file: false };
	// The number of rows the table wants. Show more adds one page.
	const [wanted, setWanted] = useState({ sortScope, count: FILES_SORTED_CHILDREN_PAGE_SIZE });
	const wantedCount = wanted.sortScope === sortScope ? wanted.count : FILES_SORTED_CHILDREN_PAGE_SIZE;

	// Load the first folders page and the first files page together, like the Files tree, so a normal
	// folder needs one round trip.
	const folderValue = useFilesSortedChildrenSegment({
		...props,
		kind: "folder",
		segment: "value",
		active: sort !== null,
		metadataKey,
	});
	const fileValue = useFilesSortedChildrenSegment({
		...props,
		kind: "file",
		segment: "value",
		active: sort !== null,
		metadataKey,
	});
	const folderMissing = useFilesSortedChildrenSegment({
		...props,
		kind: "folder",
		segment: "missing",
		active: hasFolderMissing && started.folder,
		metadataKey,
	});
	const fileMissing = useFilesSortedChildrenSegment({
		...props,
		kind: "file",
		segment: "missing",
		active: hasFileMissing && started.file,
		metadataKey,
	});

	// Null when this user cannot read the folder. True when the member has an active share here, so a
	// metadata sort or filter says that shared items are not shown.
	const hasSharedRequests = useMemo(
		(): Parameters<typeof useQueries>[0] =>
			retrying
				? {}
				: {
						hasShared: {
							query: app_convex_api.files_nodes.has_tree_children_shared,
							args: { membershipId, parentId: folderId, archived: false },
						},
					},
		[membershipId, folderId, retrying],
	);
	const hasShared: boolean | null | Error | undefined = useQueries(hasSharedRequests).hasShared;

	// Keep a missing segment started once its value segment was exhausted. A page split briefly turns the
	// value segment back to loading, and stopping the missing segment then would throw its pages away.
	const folderValuesDone = sort !== null && folderValue.every((stream) => stream.status === "done");
	const fileValuesDone = sort !== null && fileValue.every((stream) => stream.status === "done");
	if (
		(hasFolderMissing && !started.folder && folderValuesDone) ||
		(hasFileMissing && !started.file && fileValuesDone)
	) {
		setStartedMissing({
			sortScope,
			folder: started.folder || folderValuesDone,
			file: started.file || fileValuesDone,
		});
	}

	// Display order: folders, then files, each value segment before its missing segment.
	const segments = [
		folderValue,
		...(hasFolderMissing ? [folderMissing] : []),
		fileValue,
		...(hasFileMissing ? [fileMissing] : []),
	];

	// Show a segment only once every segment before it is done. Otherwise the next page of an earlier
	// segment would push the later rows down.
	const openSegmentIndex = segments.findIndex((streams) => streams.some((stream) => stream.status !== "done"));
	const shownSegments = openSegmentIndex === -1 ? segments : segments.slice(0, openSegmentIndex + 1);
	const merges = shownSegments.map((streams) => {
		const merge = files_merge_sorted_streams({
			streams: streams.map((stream) => ({ rows: stream.rows, isDone: stream.status === "done" })),
			compare: (a, b) => files_sort_compare({ a: a.sortKey, b: b.sortKey, sort: sort! }),
			key: (row) => `${row.target.kind}:${row.target.id}`,
		});
		return { rows: merge.rows, blocking: merge.blockingRank === null ? null : streams[merge.blockingRank]! };
	});
	const mergedRows = merges.flatMap((merge) => merge.rows);
	const blockingStream = merges.at(-1)?.blocking ?? null;
	const isSettled =
		sort !== null &&
		hasShared !== undefined &&
		!(hasShared instanceof Error) &&
		segments.every((streams) => streams.every((stream) => stream.status !== "loading"));

	// Load the next page of the stream that holds the merge back, until the table has the rows it wants.
	useEffect(() => {
		if (mergedRows.length < wantedCount && blockingStream?.status === "more") blockingStream.loadMore();
	});

	useEffect(() => {
		if (retrying) setRetrying(false);
	}, [retrying]);

	// Keep the last settled rows of this folder, to show while a new sort or a page loads. Compare by
	// the rows and the sort, not by array identity, so storing them cannot loop the render. Compare the
	// whole rows, so a renamed or updated row is not shown stale while the next page loads.
	const folderScope = JSON.stringify([membershipId, folderId]);
	const heldKey = JSON.stringify([sortScope, mergedRows]);
	const [heldRows, setHeldRows] = useState<{
		folderScope: string;
		key: string;
		sort: files_sort_Sort | null;
		filter: files_table_Filter | null;
		namePrefix: string | null;
		rows: FilesSortedChildrenRow[];
	} | null>(null);
	const shownHeldRows = heldRows?.folderScope === folderScope ? heldRows : null;
	if (isSettled && heldRows?.key !== heldKey) {
		setHeldRows({ folderScope, key: heldKey, sort, filter, namePrefix, rows: mergedRows });
	}

	// Show more asks for one more page of rows. The effect above loads them.
	const loadMore = useFn(() => {
		setWanted({ sortScope, count: mergedRows.length + FILES_SORTED_CHILDREN_PAGE_SIZE });
	});
	const retry = useFn(() => {
		setRetrying(true);
	});
	const isFailed = hasShared === null || hasShared instanceof Error;
	const isDone = isSettled && segments.every((streams) => streams.every((stream) => stream.status === "done"));
	const rows = hasShared === null ? undefined : isSettled ? mergedRows : shownHeldRows?.rows;

	return {
		rows,
		// Held rows keep their old sort keys, header arrows and table sort attributes.
		rowsSort: isSettled ? sort : (shownHeldRows?.sort ?? null),
		rowsFilter: isSettled ? filter : (shownHeldRows?.filter ?? null),
		rowsNamePrefix: isSettled ? namePrefix : (shownHeldRows?.namePrefix ?? null),
		isBusy: !isFailed && !isSettled,
		isDone,
		// The `has_tree_children_shared` query answers null when this user cannot read the folder.
		isFailed,
		isFolderRefused: hasShared === null,
		// The metadata key whose sort or filter hides the member's shared rows here, or null.
		hiddenSharedKey: hasShared === true ? metadataKey : null,
		loadMore,
		retry,
	};
}

export function useFilesSearchServerFilters(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	searchQuery: string;
	treeItemsList: Pick<files_TreeItem, "kind" | "path">[] | undefined;
}) {
	const { membershipId, searchQuery, treeItemsList } = args;

	// A positive `file.path` filter bounds the metadata queries below to its folder. The tree
	// filter ignores case, so the folder sent is the stored path of the node the typed path names. A
	// path that names a file has nothing under it, so it sends no folder, and the tree filter keeps
	// that file by its own path.
	const searchPathPrefix = ((/* iife */) => {
		const pathFilter = search_path_filter(files_search_query_parse(searchQuery).filters);
		if (pathFilter === null) {
			return undefined;
		}
		const folderPath = files_search_query_folder_path(pathFilter.value);
		const node = treeItemsList?.find((item) => item.path.toLowerCase() === folderPath.toLowerCase());
		if (node === undefined) {
			return folderPath;
		}
		return node.kind === "file" ? undefined : node.path;
	})();

	// A metadata filter runs on the server, one subscription per chip, keyed by the chip's raw
	// token. The tree filtering below waits for every one of them before it shows results.
	//
	// Keep manual `useMemo` here. Convex `useQueries` re-subscribes with a render-phase setState
	// whenever the queries object identity changes, so an inline object loops the render until
	// React throws. Build the object once per query string.
	const searchNodeQueries = useMemo(() => {
		const parsed = files_search_query_parse(searchQuery);
		return Object.fromEntries(
			parsed.filters
				.filter((filter) => filter.problem === null && filter.key.namespace !== "file")
				.map((filter) => [
					filter.raw,
					{
						query: app_convex_api.files_metadata.search_nodes,
						args: {
							membershipId,
							plans: files_search_query_to_plans(filter),
							...(searchPathPrefix === undefined ? {} : { pathPrefix: searchPathPrefix }),
						},
					},
				]),
		);
	}, [membershipId, searchQuery, searchPathPrefix]);
	const searchNodeResults = useQueries(searchNodeQueries);
	// Every valid `file.link` chip reads one workspace list of public links, so it is loaded once.
	// It is workspace-wide, so a `file.path` chip does not change it. Keep manual `useMemo` for the
	// same reason as above.
	const searchLinkRequest = useMemo(() => {
		const raws = files_search_query_parse(searchQuery)
			.filters.filter(
				(filter) => filter.problem === null && filter.key.namespace === "file" && filter.key.name === "link",
			)
			.map((filter) => filter.raw);
		return {
			raws,
			queries: Object.fromEntries(
				raws.length === 0
					? []
					: [["links", { query: app_convex_api.files_share_links.list_workspace_links, args: { membershipId } }]],
			),
		};
	}, [membershipId, searchQuery]);
	const searchLinkResults = useQueries(searchLinkRequest.queries);
	// The tree rebuild effect below keys on the identity of `visibleFileIds`, so the matches and
	// this map must keep their identity until a result changes.
	const searchServerTargetKeys = useMemo(() => {
		const targetKeysByRaw = new Map<string, Set<string> | null>();
		for (const raw of Object.keys(searchNodeQueries)) {
			const result: FunctionReturnType<typeof app_convex_api.files_metadata.search_nodes> | Error | undefined =
				searchNodeResults[raw];
			// The door throws only for a missing session, which the route already handles. A failed
			// query is an unknown answer, not an empty one: a negated chip must not show every file
			// because its query threw. It ends the "Searching…" state, so `null` counts as answered.
			if (result instanceof Error || result?.truncated) {
				targetKeysByRaw.set(raw, null);
			} else if (result !== undefined) {
				targetKeysByRaw.set(raw, new Set(result.targets.map((target) => `${target.kind}:${target.id}`)));
			}
		}

		// The list holds only saved files. `null` means the membership was refused, so the answer is
		// unknown like a failed query, not an empty list.
		const linkResult:
			| FunctionReturnType<typeof app_convex_api.files_share_links.list_workspace_links>
			| Error
			| undefined = searchLinkResults.links;
		for (const raw of searchLinkRequest.raws) {
			if (linkResult instanceof Error || linkResult === null) {
				targetKeysByRaw.set(raw, null);
			} else if (linkResult !== undefined) {
				targetKeysByRaw.set(raw, new Set(linkResult.map((link) => `saved:${link.nodeId}`)));
			}
		}

		return targetKeysByRaw;
	}, [searchNodeQueries, searchNodeResults, searchLinkRequest, searchLinkResults]);
	const isSearchLoading = [...Object.keys(searchNodeQueries), ...searchLinkRequest.raws].some(
		(raw) => !searchServerTargetKeys.has(raw),
	);
	const isSearchFailed = [...searchServerTargetKeys.values()].some((targetKeys) => targetKeys === null);

	return { searchServerTargetKeys, isSearchLoading, isSearchFailed };
}
