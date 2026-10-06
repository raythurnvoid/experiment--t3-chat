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
import {
	files_sort_compare,
	files_sort_field_is_built_in,
	files_sort_key_of,
	type files_sort_RowKey,
	type files_sort_Sort,
} from "../../shared/files-sort.ts";
import type { files_table_Filter } from "../../shared/files-table.ts";

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

type FilesSortedChildrenRow = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>
>["rows"][number] & { sortKey: files_sort_RowKey; segment: "value" | "missing" };

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
 * Returns the rows to show, and the index of the stream that holds the merge back: the stream that
 * is not done and whose loaded rows end first. Its next page lets more rows show.
 */
function merge_sorted_streams<Row>(args: {
	streams: Array<{ rows: Row[]; isDone: boolean }>;
	compare: (a: Row, b: Row) => number;
}) {
	const { streams, compare } = args;

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

	// A stream with no loaded rows holds back every other row.
	const blocking = openStreams.reduce<(typeof openStreams)[number] | null>(
		(min, stream) =>
			min === null || (min.last !== null && (stream.last === null || compareRanked(stream.last, min.last) < 0))
				? stream
				: min,
		null,
	);

	return { rows, blockingRank: blocking?.rank ?? null };
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
};

/**
 * The saved children of one folder for the folder table, in the order of `sort`. Folders come
 * first. The table is saved-only on purpose: drafts show in the Pending tab and to the agent. See
 * "Saved-only lists" in `.agents/skills/files-explorer-tree/SKILL.md`.
 *
 * Each kind reads a value segment and, for file.extension and file.size with no filter, a missing
 * segment with the rows that have no value. A missing segment starts only after its value segment is
 * done. Each segment merges these streams: the open rows, the owner's restricted rows (empty for
 * everyone else), and the restricted children shared with a member (the side rows).
 *
 * While a page or a new sort loads, `rows` keeps the last settled rows and `isBusy` is true. `sort:
 * null` waits.
 */
export function useFilesSortedChildren(props: useFilesSortedChildren_Props) {
	const { membershipId, folderId, sort, filter, namePrefix } = props;
	const field = sort?.[0]?.field ?? null;
	const isMetadata = field !== null && !files_sort_field_is_built_in(field);
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

	const streamArgs = (
		kind: app_convex_Doc<"files_nodes">["kind"],
		segment: FilesSortedChildrenRow["segment"],
		restricted: boolean,
	) =>
		sort === null
			? ("skip" as const)
			: { membershipId, parentId: folderId, kind, sort, filter, namePrefix, restricted, segment };

	// Load the first folders page and the first files page together, like the Files tree, so a normal
	// folder needs one round trip. The restricted streams answer an empty, done page to everyone
	// except the owner.
	const folderOpen = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		streamArgs("folder", "value", false),
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const folderRestricted = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		streamArgs("folder", "value", true),
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileOpen = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		streamArgs("file", "value", false),
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileRestricted = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		streamArgs("file", "value", true),
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const folderMissingOpen = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		hasFolderMissing && started.folder ? streamArgs("folder", "missing", false) : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const folderMissingRestricted = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		hasFolderMissing && started.folder ? streamArgs("folder", "missing", true) : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileMissingOpen = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		hasFileMissing && started.file ? streamArgs("file", "missing", false) : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileMissingRestricted = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		hasFileMissing && started.file ? streamArgs("file", "missing", true) : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	// The side rows are the restricted children shared with a member. The owner gets none: the
	// restricted streams above hold them.
	const sideScope = JSON.stringify([membershipId, folderId, sort !== null]);
	const sideRequests = useMemo(() => {
		const [membershipId, folderId, hasSort] = JSON.parse(sideScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			boolean,
		];
		return Object.fromEntries(
			!hasSort || retrying
				? []
				: [
						[
							"side",
							{
								query: app_convex_api.files_nodes.list_tree_children_sort_side_rows,
								args: { membershipId, parentId: folderId },
							},
						],
					],
		);
	}, [sideScope, retrying]);
	const sideResponse:
		| FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>
		| Error
		| undefined = useQueries(sideRequests).side;
	const sideRows = sideResponse instanceof Error ? undefined : sideResponse;
	const sideTargetsText = JSON.stringify(sideRows?.rows.map((row) => row.target) ?? []);
	const sideKeyScope = JSON.stringify([membershipId, folderId, sort]);
	const sideKeyRequests = useMemo(() => {
		const [membershipId, folderId, sort] = JSON.parse(sideKeyScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			typeof props.sort,
		];
		// A built-in key comes from the row's own facts. A metadata key needs a read.
		if (sort === null || retrying || files_sort_field_is_built_in(sort[0]!.field)) return {};
		const targets = JSON.parse(sideTargetsText) as FilesSortedChildrenRow["target"][];
		return Object.fromEntries(
			targets.map((target) => [
				`${target.kind}:${target.id}`,
				{
					query: app_convex_api.files_nodes.get_table_sort_key,
					args: { membershipId, parentId: folderId, target, sort },
				},
			]),
		);
	}, [sideKeyScope, sideTargetsText, retrying]);
	const sideKeyResponses = useQueries(sideKeyRequests);
	const sideKeyResults = Object.keys(sideKeyRequests).map(
		(key) => sideKeyResponses[key] as files_sort_RowKey | null | Error | undefined,
	);
	const sideKeysReady =
		sideRows !== undefined && sideKeyResults.every((result) => result !== undefined && !(result instanceof Error));
	const sideKeysFailed = sideKeyResults.some((result) => result instanceof Error);
	const keyedSideRows: FilesSortedChildrenRow[] = (sideRows?.rows ?? []).flatMap((row) => {
		if (sort === null) return [];
		const key = `${row.target.kind}:${row.target.id}`;
		const dot = row.name.lastIndexOf(".");
		const sortKey =
			key in sideKeyRequests
				? (sideKeyResponses[key] as files_sort_RowKey | null | Error | undefined)
				: files_sort_key_of({
						sort,
						facts: {
							...row,
							extension: dot > 0 && dot < row.name.length - 1 ? row.name.slice(dot + 1).toLowerCase() : null,
						},
						metadataParts: new Map(),
					});
		if (sortKey == null || sortKey instanceof Error) return [];
		// A metadata sort hides the rows without its key, like the streams do.
		if (isMetadata && sortKey.parts[0] === null) return [];
		const segment = row.kind === "folder" && field === "size" ? "value" : sortKey.parts[0] === null ? "missing" : "value";
		return [{ ...row, sortKey, segment }];
	});
	const sideMatchScope = JSON.stringify([membershipId, folderId, filter, namePrefix, sort !== null]);
	const sideMatchRequests = useMemo(() => {
		const [membershipId, folderId, filter, namePrefix, hasSort] = JSON.parse(sideMatchScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			typeof props.filter,
			typeof props.namePrefix,
			boolean,
		];
		if (filter === null || !hasSort || retrying) return {};
		const targets = JSON.parse(sideTargetsText) as FilesSortedChildrenRow["target"][];
		return Object.fromEntries(
			targets.map((target) => [
				`${target.kind}:${target.id}`,
				{
					query: app_convex_api.files_nodes.get_table_filter_match,
					args: { membershipId, parentId: folderId, target, filter, namePrefix },
				},
			]),
		);
	}, [sideMatchScope, sideTargetsText, retrying]);
	const sideMatchResponses = useQueries(sideMatchRequests);
	const sideMatchResults = Object.keys(sideMatchRequests).map(
		(key) =>
			sideMatchResponses[key] as
				| FunctionReturnType<typeof app_convex_api.files_nodes.get_table_filter_match>
				| Error
				| undefined,
	);
	const sideMatchesReady =
		sideRows !== undefined && sideMatchResults.every((result) => result !== undefined && !(result instanceof Error));
	const sideMatchesFailed =
		sideResponse instanceof Error || sideKeysFailed || sideMatchResults.some((result) => result instanceof Error);
	const refusedSideKeys = new Set([
		...Object.keys(sideMatchRequests).filter((key) => sideMatchResponses[key] === null),
		...Object.keys(sideKeyRequests).filter((key) => sideKeyResponses[key] === null),
	]);

	// Keep a missing segment started once its value segment was exhausted. A page split briefly turns the
	// value segment back to loading, and stopping the missing segment then would throw its pages away.
	const folderValuesDone = folderOpen.status === "Exhausted" && folderRestricted.status === "Exhausted";
	const fileValuesDone = fileOpen.status === "Exhausted" && fileRestricted.status === "Exhausted";
	if ((hasFolderMissing && !started.folder && folderValuesDone) || (hasFileMissing && !started.file && fileValuesDone)) {
		setStartedMissing({
			sortScope,
			folder: started.folder || folderValuesDone,
			file: started.file || fileValuesDone,
		});
	}

	// The side rows win over a main row of the same node while the two queries catch up with each other.
	const sideKeys = new Set(sideRows?.rows.map((row) => `${row.target.kind}:${row.target.id}`));
	// A skipped `usePaginatedQuery` reports `LoadingFirstPage` forever, so a stream that has not started
	// must count as inactive, not as loading.
	const streamOf = (
		result: typeof folderOpen,
		segment: FilesSortedChildrenRow["segment"],
		active: boolean,
	): FilesSortedChildrenStream => ({
		rows: result.results
			.filter((row) => !sideKeys.has(`saved:${row._id}`))
			.map(
				(row): FilesSortedChildrenRow => ({
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
				}),
			),
		status: !active
			? "inactive"
			: result.status === "Exhausted"
				? "done"
				: result.status === "CanLoadMore"
					? "more"
					: "loading",
		loadMore: () => result.loadMore(FILES_SORTED_CHILDREN_PAGE_SIZE),
	});
	const sideStreamOf = (
		kind: app_convex_Doc<"files_nodes">["kind"],
		segment: FilesSortedChildrenRow["segment"],
	): FilesSortedChildrenStream => ({
		rows: keyedSideRows.filter((row) => {
			const key = `${row.target.kind}:${row.target.id}`;
			const match: FunctionReturnType<typeof app_convex_api.files_nodes.get_table_filter_match> | Error | undefined =
				sideMatchResponses[key];
			return (
				!refusedSideKeys.has(key) &&
				row.kind === kind &&
				row.segment === segment &&
				(filter === null || (match != null && !(match instanceof Error) && match.matches))
			);
		}),
		// The side rows come in one complete list, so they never hold the merge back.
		status: "done",
		loadMore: () => {},
	});

	// Display order. Each segment merges the open stream, the owner's restricted stream and the side rows.
	const segments: Array<{ streams: FilesSortedChildrenStream[] }> = [
		{
			streams: [
				streamOf(folderOpen, "value", sort !== null),
				streamOf(folderRestricted, "value", sort !== null),
				sideStreamOf("folder", "value"),
			],
		},
	];
	if (hasFolderMissing) {
		segments.push({
			streams: [
				streamOf(folderMissingOpen, "missing", started.folder),
				streamOf(folderMissingRestricted, "missing", started.folder),
				sideStreamOf("folder", "missing"),
			],
		});
	}
	segments.push({
		streams: [
			streamOf(fileOpen, "value", sort !== null),
			streamOf(fileRestricted, "value", sort !== null),
			sideStreamOf("file", "value"),
		],
	});
	if (hasFileMissing) {
		segments.push({
			streams: [
				streamOf(fileMissingOpen, "missing", started.file),
				streamOf(fileMissingRestricted, "missing", started.file),
				sideStreamOf("file", "missing"),
			],
		});
	}

	// Show a segment only once every segment before it is done. Otherwise the next page of an earlier
	// segment would push the later rows down.
	const openSegmentIndex = segments.findIndex((segment) => segment.streams.some((stream) => stream.status !== "done"));
	const shownSegments = openSegmentIndex === -1 ? segments : segments.slice(0, openSegmentIndex + 1);
	const merges = shownSegments.map((segment) => {
		const merge = merge_sorted_streams({
			streams: segment.streams.map((stream) => ({ rows: stream.rows, isDone: stream.status === "done" })),
			compare: (a, b) => files_sort_compare({ a: a.sortKey, b: b.sortKey, sort: sort! }),
		});
		return { rows: merge.rows, blocking: merge.blockingRank === null ? null : segment.streams[merge.blockingRank]! };
	});
	// A node can be in two streams for a moment, for example right after it became restricted.
	const mergedKeys = new Set<string>();
	const mergedRows = merges
		.flatMap((merge) => merge.rows)
		.filter((row) => {
			const key = `${row.target.kind}:${row.target.id}`;
			if (mergedKeys.has(key)) return false;
			mergedKeys.add(key);
			return true;
		});
	const blockingStream = merges.at(-1)?.blocking ?? null;
	const isSettled =
		sort !== null &&
		sideMatchesReady &&
		sideKeysReady &&
		!sideMatchesFailed &&
		segments.every((segment) => segment.streams.every((stream) => stream.status !== "loading"));

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
	const heldKey = JSON.stringify([sortScope, mergedRows, [...sideKeys]]);
	const [heldRows, setHeldRows] = useState<{
		folderScope: string;
		key: string;
		sort: files_sort_Sort | null;
		filter: files_table_Filter | null;
		namePrefix: string | null;
		rows: FilesSortedChildrenRow[];
		sideKeys: string[];
	} | null>(null);
	const shownHeldRows = heldRows?.folderScope === folderScope ? heldRows : null;
	const heldRowsToShow = shownHeldRows?.rows.filter((row) => {
		const key = `${row.target.kind}:${row.target.id}`;
		return (
			sideRows !== null &&
			!refusedSideKeys.has(key) &&
			!(sideRows !== undefined && shownHeldRows.sideKeys.includes(key) && !sideKeys.has(key)) &&
			!(row.target.kind === "saved" && !shownHeldRows.sideKeys.includes(key) && sideKeys.has(key))
		);
	});
	if (isSettled && heldRows?.key !== heldKey) {
		setHeldRows({ folderScope, key: heldKey, sort, filter, namePrefix, rows: mergedRows, sideKeys: [...sideKeys] });
	} else if (shownHeldRows && heldRowsToShow && heldRowsToShow.length !== shownHeldRows.rows.length) {
		// Keep known removals through Retry's query reset. A settled result can restore the row later.
		setHeldRows({ ...shownHeldRows, key: "", rows: heldRowsToShow });
	}

	// Show more asks for one more page of rows. The effect above loads them.
	const loadMore = useFn(() => {
		setWanted({ sortScope, count: mergedRows.length + FILES_SORTED_CHILDREN_PAGE_SIZE });
	});
	const retry = useFn(() => {
		setRetrying(true);
	});
	const isFailed = sideRows === null || sideMatchesFailed;
	const isDone = isSettled && segments.every((segment) => segment.streams.every((stream) => stream.status === "done"));
	const rows = sideRows === null ? undefined : isSettled ? mergedRows : heldRowsToShow;

	return {
		rows,
		sideTargets: sideRows?.rows.map((row) => row.target) ?? [],
		// Held rows keep their old sort keys, header arrows and table sort attributes.
		rowsSort: isSettled ? sort : (shownHeldRows?.sort ?? null),
		rowsFilter: isSettled ? filter : (shownHeldRows?.filter ?? null),
		rowsNamePrefix: isSettled ? namePrefix : (shownHeldRows?.namePrefix ?? null),
		isBusy: !isFailed && !isSettled,
		isDone,
		// Side rows are null when this user cannot read the folder.
		isFailed,
		isFolderRefused: sideRows === null,
		tooManyShared: sideRows?.tooManyShared ?? false,
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
