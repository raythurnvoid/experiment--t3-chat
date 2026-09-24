import { useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
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
import { files_sort_compare, files_sort_field_is_built_in, type files_sort_Sort } from "../../shared/files-sort.ts";

/**
 * Page `files_visible.list` 50 entries at a time, and return the entries only when the listing is done.
 */
export function useFilesVisibleEntries(
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	folderPath: string | null | undefined,
	mode: "subtree" | "children",
) {
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

const FILES_SORTED_CHILDREN_PAGE_SIZE = 50;

type FilesSortedChildrenRow = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>
>["rows"][number];

type FilesSortedChildrenPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;

/**
 * The state of one segment. `inactive` is a segment that has not started, so it is not loading.
 */
type FilesSortedChildrenSegmentStatus = "inactive" | "loading" | "more" | "done" | "failed";

/**
 * Page the missing segment of a metadata key. Its cursor is not pinned like a native Convex cursor:
 * when a row before the end of a page changes, the page ends somewhere else. So keep a chain of
 * cursors like `useFilesVisibleEntries`. When an earlier page ends somewhere else, drop the later
 * pages and load them again up to the same count.
 */
function useFilesSortedMissingPages(
	request: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		parentId: app_convex_Doc<"files_nodes">["parentId"];
		kind: app_convex_Doc<"files_nodes">["kind"];
		sort: files_sort_Sort;
	} | null,
) {
	const scope = JSON.stringify(request);
	const [pages, setPages] = useState({ scope, cursors: [null] as Array<string | null>, pageCount: 1 });
	const cursors = useMemo(() => (pages.scope === scope ? pages.cursors : [null]), [scope, pages]);
	const pageCount = pages.scope === scope ? pages.pageCount : 1;

	// Keep this manual memo. Convex `useQueries` subscribes again whenever the queries object changes
	// identity.
	const queries = useMemo(() => {
		const parsed = JSON.parse(scope) as typeof request;
		return parsed === null
			? {}
			: Object.fromEntries(
					cursors.map((cursor, index) => [
						index,
						{
							query: app_convex_api.files_nodes.list_tree_children_sorted,
							args: {
								...parsed,
								segment: "missing" as const,
								paginationOpts: { numItems: FILES_SORTED_CHILDREN_PAGE_SIZE, cursor },
							},
						},
					]),
				);
	}, [cursors, scope]);

	const responses = useQueries(queries);

	const progress = useMemo(() => {
		const rows: Array<FilesSortedChildrenPage["page"][number]> = [];
		let nextCursors: Array<string | null> | null = null;
		let moreCursor: string | null = null;
		let status: FilesSortedChildrenSegmentStatus = scope === "null" ? "inactive" : "loading";

		for (let index = 0; index < cursors.length && status !== "inactive"; index++) {
			const response: FilesSortedChildrenPage | Error | undefined = responses[index];
			if (response === undefined) {
				status = "loading";
				break;
			}
			if (response instanceof Error) {
				status = "failed";
				break;
			}

			rows.push(...response.page);
			if (response.isDone) {
				status = "done";
				if (index + 1 < cursors.length) nextCursors = cursors.slice(0, index + 1);
				break;
			}
			// Wait for `loadMore()` before asking for more pages than were asked for.
			if (index + 1 >= pageCount) {
				status = "more";
				moreCursor = response.continueCursor;
				break;
			}
			if (response.continueCursor !== cursors[index + 1]) {
				status = "loading";
				nextCursors = [...cursors.slice(0, index + 1), response.continueCursor];
				break;
			}
		}

		const lastPage = responses[cursors.length - 1];
		return {
			rows,
			status,
			nextCursors,
			moreCursor,
			// Most children can have the key, so a page can be empty while more children remain.
			isLastPageEmpty:
				status === "more" && lastPage !== undefined && !(lastPage instanceof Error) && lastPage.page.length === 0,
		};
	}, [cursors, pageCount, responses, scope]);

	useEffect(() => {
		if (pages.scope === scope && !progress.nextCursors) return;
		setPages({ scope, cursors: progress.nextCursors ?? cursors, pageCount });
	}, [cursors, scope, pages.scope, pageCount, progress.nextCursors]);

	const loadMore = useFn(() => {
		if (progress.moreCursor === null) return;
		setPages({ scope, cursors: [...cursors, progress.moreCursor], pageCount: cursors.length + 1 });
	});

	// Ask for the next page by itself when the last page came back empty.
	useEffect(() => {
		if (progress.isLastPageEmpty) {
			loadMore();
		}
	}, [progress.isLastPageEmpty, loadMore]);

	return { rows: progress.rows, status: progress.status, loadMore };
}

type useFilesSortedChildren_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	sort: files_sort_Sort | null;
};

/**
 * The children of one folder for the folder table, in the order of `sort`. Folders come first. In
 * each kind, the rows with a value come before the rows without one, and those are always by name,
 * A to Z.
 *
 * Each of these segments has its own pager. A missing segment starts only after its value segment is
 * exhausted, and stays started for that sort. The side rows (restricted children, and this user's
 * drafts and moves) join their segment only once the loaded rows of that segment reach them, so a
 * side row never jumps when the next page loads.
 *
 * While a page or a new sort loads, `rows` keeps the last settled rows and `isBusy` is true. `sort:
 * null` waits, for example for the folder's saved sort.
 */
export function useFilesSortedChildren(props: useFilesSortedChildren_Props) {
	const { membershipId, folderId, sort } = props;
	const field = sort?.field ?? null;
	const isMetadata = field !== null && !files_sort_field_is_built_in(field);
	// Folders have no extension, so they all miss a type. Folders have no size, so they sort by name.
	const hasFolderMissing = field === "type" || isMetadata;
	const hasFileMissing = field === "type" || field === "size" || isMetadata;

	const segmentArgs = (kind: app_convex_Doc<"files_nodes">["kind"]) =>
		sort === null ? null : { membershipId, parentId: folderId, kind, sort };

	const sortScope = JSON.stringify([membershipId, folderId, sort]);
	const [startedMissing, setStartedMissing] = useState({ sortScope, folder: false, file: false });
	const started = startedMissing.sortScope === sortScope ? startedMissing : { sortScope, folder: false, file: false };

	// Load the first folders page and the first files page together, like the Files tree, so a normal
	// folder needs one round trip.
	const folderValues = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		sort === null ? "skip" : { ...segmentArgs("folder")!, segment: "value" },
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileValues = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		sort === null ? "skip" : { ...segmentArgs("file")!, segment: "value" },
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	// Rows without a type or a size have a native cursor. A metadata key's missing rows use a cursor chain.
	const folderMissing = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		field === "type" && started.folder ? { ...segmentArgs("folder")!, segment: "missing" } : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileMissing = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		(field === "type" || field === "size") && started.file ? { ...segmentArgs("file")!, segment: "missing" } : "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const folderMissingPages = useFilesSortedMissingPages(isMetadata && started.folder ? segmentArgs("folder") : null);
	const fileMissingPages = useFilesSortedMissingPages(isMetadata && started.file ? segmentArgs("file") : null);
	const sideRows = useQuery(
		app_convex_api.files_nodes.list_tree_children_sort_side_rows,
		sort === null ? "skip" : { membershipId, parentId: folderId, sort },
	);

	// Keep a missing segment started once its value segment was exhausted. A page split briefly turns the
	// value segment back to loading, and stopping the missing segment then would throw its pages away.
	if (
		(hasFolderMissing && !started.folder && folderValues.status === "Exhausted") ||
		(hasFileMissing && !started.file && fileValues.status === "Exhausted")
	) {
		setStartedMissing({
			sortScope,
			folder: started.folder || folderValues.status === "Exhausted",
			file: started.file || fileValues.status === "Exhausted",
		});
	}

	const pagerOf = (result: typeof folderValues, active: boolean) => {
		const status: FilesSortedChildrenSegmentStatus = !active
			? "inactive"
			: result.status === "Exhausted"
				? "done"
				: result.status === "CanLoadMore"
					? "more"
					: "loading";
		return { rows: result.results, status, loadMore: () => result.loadMore(FILES_SORTED_CHILDREN_PAGE_SIZE) };
	};

	// Display order. A skipped `usePaginatedQuery` reports `LoadingFirstPage` forever, so a segment that
	// has not started must count as inactive, not as loading.
	const direction = sort?.direction ?? "asc";
	const segments: Array<{
		kind: app_convex_Doc<"files_nodes">["kind"];
		segment: FilesSortedChildrenRow["segment"];
		order: files_sort_Sort["direction"];
		rows: Array<FilesSortedChildrenPage["page"][number]>;
		status: FilesSortedChildrenSegmentStatus;
		loadMore: () => void;
	}> = [
		{
			kind: "folder",
			segment: "value",
			order: field === "size" ? "asc" : direction,
			...pagerOf(folderValues, sort !== null),
		},
	];
	if (hasFolderMissing) {
		segments.push({
			kind: "folder",
			segment: "missing",
			order: "asc",
			...(isMetadata ? folderMissingPages : pagerOf(folderMissing, started.folder)),
		});
	}
	segments.push({ kind: "file", segment: "value", order: direction, ...pagerOf(fileValues, sort !== null) });
	if (hasFileMissing) {
		segments.push({
			kind: "file",
			segment: "missing",
			order: "asc",
			...(isMetadata ? fileMissingPages : pagerOf(fileMissing, started.file)),
		});
	}

	const isSettled =
		sort !== null && sideRows !== undefined && segments.every((segment) => segment.status !== "loading");

	const claimedNames = new Set(sideRows?.nameClaims ?? []);
	const sideKeys = new Set(sideRows?.rows.map((row) => `${row.target.kind}:${row.target.id}`));
	// Show a segment only once every segment before it is done. Otherwise the next page of an earlier
	// segment would push the later rows down.
	const openSegmentIndex = segments.findIndex((segment) => segment.status !== "done");
	const shownSegments = openSegmentIndex === -1 ? segments : segments.slice(0, openSegmentIndex + 1);
	const mergedRows = shownSegments.flatMap((segment) => {
		const compare = (
			a: { sortKey: FilesSortedChildrenRow["sortKey"] },
			b: { sortKey: FilesSortedChildrenRow["sortKey"] },
		) => files_sort_compare(a.sortKey, b.sortKey, segment.order);

		// A draft or a pending move takes a name, so the saved row with that name is hidden, like in
		// the rest of the Files view. The side rows win over a main row of the same node while the two
		// queries catch up with each other.
		const mainRows = segment.rows
			.filter((row) => !claimedNames.has(row.name) && !sideKeys.has(`saved:${row._id}`))
			.map((row): FilesSortedChildrenRow => ({
				target: { kind: "saved", id: row._id },
				name: row.name,
				kind: row.kind,
				updatedAt: row.updatedAt,
				updatedBy: row.updatedBy,
				contentType: row.contentType,
				preparing: false,
				treeRow: row,
				segment: segment.segment,
				sortKey: row.sortKey,
				sortFieldValue: row.sortFieldValue,
			}));

		// Show a side row once the last loaded main row of its segment sorts at or after it, or once the
		// segment is done. Earlier, the next page could still hold rows that sort before it.
		const lastMainRow = segment.rows.at(-1);
		const segmentSideRows = (sideRows?.rows ?? []).filter(
			(row) =>
				row.kind === segment.kind &&
				row.segment === segment.segment &&
				(segment.status === "done" || (lastMainRow !== undefined && compare(lastMainRow, row) >= 0)),
		);

		return [...mainRows, ...segmentSideRows].sort(compare);
	});

	// Keep the last settled rows of this folder, to show while a new sort or a page loads. Compare by
	// the rows and the sort, not by array identity, so storing them cannot loop the render. Compare the
	// whole rows, so a renamed or updated row is not shown stale while the next page loads.
	const folderScope = JSON.stringify([membershipId, folderId]);
	const heldKey = JSON.stringify([sortScope, mergedRows]);
	const [heldRows, setHeldRows] = useState<{
		folderScope: string;
		key: string;
		sort: files_sort_Sort | null;
		rows: FilesSortedChildrenRow[];
	} | null>(null);
	if (isSettled && heldRows?.key !== heldKey) {
		setHeldRows({ folderScope, key: heldKey, sort, rows: mergedRows });
	}
	const shownHeldRows = heldRows?.folderScope === folderScope ? heldRows : null;

	// Load the first shown segment that has more rows. A hidden segment would load rows nobody sees.
	const loadMore = useFn(() => {
		shownSegments.find((segment) => segment.status === "more")?.loadMore();
	});

	return {
		rows: isSettled ? mergedRows : shownHeldRows?.rows,
		// Held rows keep the sort keys of the sort they were loaded with, so show their values with it.
		rowsSort: isSettled ? sort : (shownHeldRows?.sort ?? null),
		isBusy: !isSettled,
		isDone: isSettled && segments.every((segment) => segment.status === "done"),
		// Side rows are null when this user cannot read the folder.
		isFailed: sideRows === null || segments.some((segment) => segment.status === "failed"),
		tooManyShared: sideRows?.tooManyShared ?? false,
		tooManyPending: sideRows?.tooManyPending ?? false,
		loadMore,
	};
}

export function useFilesSearchMetadata(
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	searchQuery: string,
	treeItemsList: Pick<files_TreeItem, "kind" | "path">[] | undefined,
) {
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
	// The tree rebuild effect below keys on the identity of `visibleFileIds`, so the matches and
	// this map must keep their identity until a result changes.
	const searchMetadataTargetKeys = useMemo(() => {
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

		return targetKeysByRaw;
	}, [searchNodeQueries, searchNodeResults]);
	const isSearchLoading = Object.keys(searchNodeQueries).some((raw) => !searchMetadataTargetKeys.has(raw));
	const isSearchFailed = [...searchMetadataTargetKeys.values()].some((targetKeys) => targetKeys === null);

	return { searchMetadataTargetKeys, isSearchLoading, isSearchFailed };
}
