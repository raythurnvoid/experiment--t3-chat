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

const FILES_SORTED_CHILDREN_PAGE_SIZE = 50;
const FILES_SORTED_CHILDREN_ACTION_WORK = 1000;

type FilesSortedChildrenRow = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sort_side_rows>
>["rows"][number] & { sortKey: files_sort_RowKey; segment: "value" | "missing" };

type FilesSortedChildrenPage = FunctionReturnType<typeof app_convex_api.files_nodes.list_tree_children_sorted>;

/**
 * The state of one segment. `inactive` is a segment that has not started, so it is not loading.
 */
type FilesSortedChildrenSegmentStatus = "inactive" | "loading" | "more" | "done" | "failed";

type FilesSortedChildrenScanPage = {
	id: number;
	kind: "folder" | "file";
	segment: "value" | "missing";
	cursor: string | null;
	workLimit: number;
	action: number;
	refresh: boolean;
	settled: boolean;
	continueCursor: string | null;
	isDone: boolean;
	workPaused: boolean;
	sortLimit: FilesSortedChildrenPage["sortLimit"];
};

type FilesSortedChildrenScan = {
	scope: string;
	action: number;
	nextId: number;
	remaining: number;
	goal: number;
	stopped: boolean;
	pages: FilesSortedChildrenScanPage[];
	refresh: Array<Pick<FilesSortedChildrenScanPage, "kind" | "segment" | "workLimit">> | null;
	failed: "retry" | "reload" | null;
	retrying: boolean;
};

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
								filter: null,
								workLimit: FILES_SORTED_CHILDREN_ACTION_WORK,
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
	filter: files_table_Filter | null;
};

/**
 * The children of one folder for the folder table, in the order of `sort`. Folders come first. In
 * each kind, every clause has its own direction and missing values stay last. A one-field sort's
 * missing values use Name A to Z.
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
	const { membershipId, folderId, sort, filter } = props;
	const field = sort?.[0].field ?? null;
	const isMetadata = field !== null && !files_sort_field_is_built_in(field);
	const customScan = filter !== null || (sort !== null && sort.length > 1);
	// A single Size sort keeps folders in the value segment. Multi-sort folders miss Type and Size.
	const hasFolderMissing = field === "type" || (field === "size" && sort!.length > 1) || isMetadata;
	const hasFileMissing = field === "type" || field === "size" || isMetadata;

	const segmentArgs = (kind: app_convex_Doc<"files_nodes">["kind"]) =>
		sort === null
			? null
			: { membershipId, parentId: folderId, kind, sort, filter: null, workLimit: FILES_SORTED_CHILDREN_ACTION_WORK };

	const sortScope = JSON.stringify([membershipId, folderId, sort, filter]);
	const [scan, setScan] = useState<FilesSortedChildrenScan>({
		scope: sortScope,
		action: 1,
		nextId: 1,
		remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
		goal: 5,
		stopped: false,
		pages: [],
		refresh: null,
		failed: null,
		retrying: false,
	});
	const currentScan: FilesSortedChildrenScan =
		scan.scope === sortScope
			? scan
			: {
					scope: sortScope,
					action: scan.action + 1,
					nextId: scan.nextId,
					remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
					goal: 5,
					stopped: false,
					pages: [],
					refresh: null,
					failed: null,
					retrying: false,
				};
	if (scan.scope !== sortScope) setScan(currentScan);
	const filteredPagesText = JSON.stringify(
		currentScan.pages.map(({ id, kind, segment, cursor, workLimit }) => ({ id, kind, segment, cursor, workLimit })),
	);
	const filteredRequests = useMemo(() => {
		const [membershipId, folderId, sort, filter] = JSON.parse(sortScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			typeof props.sort,
			typeof props.filter,
		];
		if (sort === null || (filter === null && sort.length === 1) || currentScan.retrying) return {};
		const pages = JSON.parse(filteredPagesText) as Array<
			Pick<FilesSortedChildrenScanPage, "id" | "kind" | "segment" | "cursor" | "workLimit">
		>;
		return Object.fromEntries(
			pages.map((page) => [
				page.id,
				{
					query: app_convex_api.files_nodes.list_tree_children_sorted,
					args: {
						membershipId,
						parentId: folderId,
						kind: page.kind,
						segment: page.segment,
						sort,
						filter,
						workLimit: page.workLimit,
						paginationOpts: { numItems: FILES_SORTED_CHILDREN_PAGE_SIZE, cursor: page.cursor },
					},
				},
			]),
		);
	}, [sortScope, filteredPagesText, currentScan.retrying]);
	const filteredResponses = useQueries(filteredRequests);
	const [startedMissing, setStartedMissing] = useState({ sortScope, folder: false, file: false });
	const started = startedMissing.sortScope === sortScope ? startedMissing : { sortScope, folder: false, file: false };

	// Load the first folders page and the first files page together, like the Files tree, so a normal
	// folder needs one round trip.
	const folderValues = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		sort === null || customScan || currentScan.retrying ? "skip" : { ...segmentArgs("folder")!, segment: "value" },
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileValues = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		sort === null || customScan || currentScan.retrying ? "skip" : { ...segmentArgs("file")!, segment: "value" },
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	// Rows without a type or a size have a native cursor. A metadata key's missing rows use a cursor chain.
	const folderMissing = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		!customScan && !currentScan.retrying && field === "type" && started.folder
			? { ...segmentArgs("folder")!, segment: "missing" }
			: "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const fileMissing = usePaginatedQuery(
		app_convex_api.files_nodes.list_tree_children_sorted,
		!customScan && !currentScan.retrying && (field === "type" || field === "size") && started.file
			? { ...segmentArgs("file")!, segment: "missing" }
			: "skip",
		{ initialNumItems: FILES_SORTED_CHILDREN_PAGE_SIZE },
	);
	const folderMissingPages = useFilesSortedMissingPages(
		!customScan && !currentScan.retrying && isMetadata && started.folder ? segmentArgs("folder") : null,
	);
	const fileMissingPages = useFilesSortedMissingPages(
		!customScan && !currentScan.retrying && isMetadata && started.file ? segmentArgs("file") : null,
	);
	const sideScope = JSON.stringify([membershipId, folderId, sort !== null]);
	const sideRequests = useMemo(() => {
		const [membershipId, folderId, hasSort] = JSON.parse(sideScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			boolean,
		];
		return Object.fromEntries(
			!hasSort || currentScan.retrying
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
	}, [sideScope, currentScan.retrying]);
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
		if (sort === null || currentScan.retrying) return {};
		const nameIndex = sort.findIndex((clause) => clause.field === "name");
		const meaningful = nameIndex === -1 ? sort : sort.slice(0, nameIndex);
		if (meaningful.every((clause) => files_sort_field_is_built_in(clause.field))) return {};
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
	}, [sideKeyScope, sideTargetsText, currentScan.retrying]);
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
					facts: { ...row, type: dot > 0 && dot < row.name.length - 1 ? row.name.slice(dot + 1).toLowerCase() : null },
					metadataParts: new Map(),
				});
		if (sortKey == null || sortKey instanceof Error) return [];
		const segment =
			row.kind === "folder" && field === "size" && sort.length === 1
				? "value"
				: sortKey.parts[0] === null
					? "missing"
					: "value";
		return [{ ...row, sortKey, segment }];
	});
	const sideMatchScope = JSON.stringify([membershipId, folderId, filter, sort !== null]);
	const sideMatchRequests = useMemo(() => {
		const [membershipId, folderId, filter, hasSort] = JSON.parse(sideMatchScope) as [
			typeof props.membershipId,
			typeof props.folderId,
			typeof props.filter,
			boolean,
		];
		if (filter === null || !hasSort || currentScan.retrying) return {};
		const targets = JSON.parse(sideTargetsText) as FilesSortedChildrenRow["target"][];
		return Object.fromEntries(
			targets.map((target) => [
				`${target.kind}:${target.id}`,
				{
					query: app_convex_api.files_nodes.get_table_filter_match,
					args: { membershipId, parentId: folderId, target, filter },
				},
			]),
		);
	}, [sideMatchScope, sideTargetsText, currentScan.retrying]);
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
	// A filter's checked match decides whether a draft is still unknown.
	const preparing =
		filter === null
			? (sideRows?.rows.some((row) => row.preparing) ?? false)
			: sideMatchResults.some((result) => result != null && !(result instanceof Error) && result.preparing);
	const refusedSideKeys = new Set([
		...Object.keys(sideMatchRequests).filter((key) => sideMatchResponses[key] === null),
		...Object.keys(sideKeyRequests).filter((key) => sideKeyResponses[key] === null),
	]);

	// Keep a missing segment started once its value segment was exhausted. A page split briefly turns the
	// value segment back to loading, and stopping the missing segment then would throw its pages away.
	if (
		!customScan &&
		((hasFolderMissing && !started.folder && folderValues.status === "Exhausted") ||
			(hasFileMissing && !started.file && fileValues.status === "Exhausted"))
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
	const segments: Array<{
		kind: app_convex_Doc<"files_nodes">["kind"];
		segment: FilesSortedChildrenRow["segment"];
		rows: Array<FilesSortedChildrenPage["page"][number]>;
		status: FilesSortedChildrenSegmentStatus;
		loadMore: () => void;
		scanBoundary?: FilesSortedChildrenRow["sortKey"] | null;
	}> = [
		{
			kind: "folder",
			segment: "value",
			...pagerOf(folderValues, sort !== null),
		},
	];
	if (hasFolderMissing) {
		segments.push({
			kind: "folder",
			segment: "missing",
			...(isMetadata ? folderMissingPages : pagerOf(folderMissing, started.folder)),
		});
	}
	segments.push({ kind: "file", segment: "value", ...pagerOf(fileValues, sort !== null) });
	if (hasFileMissing) {
		segments.push({
			kind: "file",
			segment: "missing",
			...(isMetadata ? fileMissingPages : pagerOf(fileMissing, started.file)),
		});
	}
	let sortLimit: FilesSortedChildrenPage["sortLimit"] = null;
	let workPaused = false;
	if (customScan) {
		for (const segment of segments) {
			const pages = currentScan.pages.filter((page) => page.kind === segment.kind && page.segment === segment.segment);
			segment.rows = [];
			segment.scanBoundary = null;
			segment.status = pages.length === 0 ? "inactive" : "loading";
			for (let index = 0; index < pages.length; index++) {
				const page = pages[index]!;
				const response: FilesSortedChildrenPage | Error | undefined = filteredResponses[page.id];
				if (response instanceof Error) {
					segment.status = "failed";
					break;
				}
				if (response === undefined) break;
				segment.rows.push(...response.page);
				segment.scanBoundary = response.scanBoundary ?? segment.scanBoundary;
				if (response.sortLimit || response.workPaused) {
					sortLimit = response.sortLimit;
					workPaused = response.workPaused;
					segment.status = "more";
					break;
				}
				if (response.isDone) {
					segment.status = "done";
					break;
				}
				if (index + 1 === pages.length) {
					segment.status = "more";
					break;
				}
				if (response.continueCursor !== pages[index + 1]!.cursor) break;
			}
		}
	}

	const changedPageIndex = currentScan.pages.findIndex((page) => {
		const response: FilesSortedChildrenPage | Error | undefined = filteredResponses[page.id];
		return (
			page.settled &&
			response !== undefined &&
			!(response instanceof Error) &&
			(response.continueCursor !== page.continueCursor ||
				response.isDone !== page.isDone ||
				response.workPaused !== page.workPaused ||
				JSON.stringify(response.sortLimit) !== JSON.stringify(page.sortLimit))
		);
	});
	const claimedNames = new Set(sideRows?.nameClaims ?? []);
	const sideKeys = new Set(sideRows?.rows.map((row) => `${row.target.kind}:${row.target.id}`));
	// Show a segment only once every segment before it is done. Otherwise the next page of an earlier
	// segment would push the later rows down.
	const openSegmentIndex = segments.findIndex((segment) => segment.status !== "done");
	const shownSegments = openSegmentIndex === -1 ? segments : segments.slice(0, openSegmentIndex + 1);
	const mergedKeys = new Set<string>();
	const mergedRows = shownSegments
		.flatMap((segment) => {
			const compare = (
				a: { sortKey: FilesSortedChildrenRow["sortKey"] },
				b: { sortKey: FilesSortedChildrenRow["sortKey"] },
			) => files_sort_compare({ a: a.sortKey, b: b.sortKey, sort: sort! });

			// A draft or a pending move takes a name, so the saved row with that name is hidden, like in
			// the rest of the Files view. The side rows win over a main row of the same node while the two
			// queries catch up with each other.
			const mainRows = segment.rows
				.filter((row) => !claimedNames.has(row.name) && !sideKeys.has(`saved:${row._id}`))
				.map((row): FilesSortedChildrenRow => ({
					target: { kind: "saved", id: row._id },
					name: row.name,
					kind: row.kind,
					createdAt: row._creationTime,
					updatedAt: row.updatedAt,
					contentByteSize: row.contentByteSize,
					updatedBy: row.updatedBy,
					contentType: row.contentType,
					preparing: false,
					treeRow: row,
					segment: segment.segment,
					sortKey: row.sortKey,
				}));

			// Show a side row once the last loaded main row of its segment sorts at or after it, or once the
			// segment is done. Earlier, the next page could still hold rows that sort before it.
			const lastMainKey = customScan ? segment.scanBoundary : segment.rows.at(-1)?.sortKey;
			const segmentSideRows = keyedSideRows.filter((row) => {
				const match: FunctionReturnType<typeof app_convex_api.files_nodes.get_table_filter_match> | Error | undefined =
					sideMatchResponses[`${row.target.kind}:${row.target.id}`];
				return (
					!refusedSideKeys.has(`${row.target.kind}:${row.target.id}`) &&
					row.kind === segment.kind &&
					row.segment === segment.segment &&
					(filter === null || (match != null && !(match instanceof Error) && match.matches)) &&
					(segment.status === "done" || (lastMainKey != null && compare({ sortKey: lastMainKey }, row) >= 0))
				);
			});

			return [...mainRows, ...segmentSideRows].sort(compare);
		})
		.filter((row) => {
			const key = `${row.target.kind}:${row.target.id}`;
			if (mergedKeys.has(key)) return false;
			mergedKeys.add(key);
			return true;
		});
	const isSettled =
		sort !== null &&
		sideMatchesReady &&
		sideKeysReady &&
		!sideMatchesFailed &&
		segments.every((segment) => segment.status !== "loading" && segment.status !== "failed") &&
		(!customScan ||
			(currentScan.failed === null &&
				currentScan.pages.length > 0 &&
				currentScan.refresh === null &&
				changedPageIndex === -1 &&
				currentScan.pages.every((page) => page.settled) &&
				(segments.every((segment) => segment.status !== "inactive") ||
					mergedRows.length >= currentScan.goal ||
					currentScan.remaining === 0 ||
					currentScan.stopped)));

	useEffect(() => {
		if (currentScan.retrying) {
			setScan({ ...currentScan, retrying: false });
			return;
		}
		if (!customScan || sort === null || sideRows === null || currentScan.failed !== null || sideMatchesFailed) return;
		if (changedPageIndex !== -1) {
			const page = currentScan.pages[changedPageIndex]!;
			const response = filteredResponses[page.id] as FilesSortedChildrenPage;
			if (
				response.workPaused ||
				(!response.isDone &&
					!response.sortLimit &&
					(!response.continueCursor || response.continueCursor === page.cursor))
			) {
				setScan({ ...currentScan, failed: "reload" });
				return;
			}
			if (response.sortLimit) {
				setScan({
					...currentScan,
					pages: currentScan.pages.slice(0, changedPageIndex + 1).map((entry) =>
						entry.id === page.id
							? {
									...entry,
									continueCursor: response.continueCursor,
									isDone: response.isDone,
									workPaused: response.workPaused,
									sortLimit: response.sortLimit,
								}
							: entry,
					),
					refresh: null,
					stopped: true,
				});
				return;
			}
			// A live cursor change rebuilds only the old settled slots with their original limits.
			setScan({
				...currentScan,
				pages: currentScan.pages.slice(0, changedPageIndex + 1).map((entry) =>
					entry.id === page.id
						? {
								...entry,
								continueCursor: response.continueCursor,
								isDone: response.isDone,
								workPaused: response.workPaused,
								sortLimit: response.sortLimit,
							}
						: entry,
				),
				refresh: [
					...currentScan.pages
						.slice(changedPageIndex + 1)
						.filter((entry) => entry.settled || entry.refresh)
						.map(({ kind, segment, workLimit }) => ({ kind, segment, workLimit })),
					...(currentScan.refresh ?? []),
				],
				stopped:
					currentScan.refresh !== null
						? currentScan.stopped
						: !currentScan.pages.slice(changedPageIndex + 1).some((entry) => !entry.settled && !entry.refresh),
			});
			return;
		}
		if (currentScan.pages.some((page) => page.settled && filteredResponses[page.id] instanceof Error)) {
			setScan({ ...currentScan, failed: "reload" });
			return;
		}
		// Reserve before issuing one scan. Cached renders settle that same reservation only once.
		const unsettled = currentScan.pages.find((page) => !page.settled);
		if (unsettled) {
			const response: FilesSortedChildrenPage | Error | undefined = filteredResponses[unsettled.id];
			if (response === undefined) return;
			if (
				response instanceof Error ||
				!Number.isInteger(response.workCount) ||
				response.workCount < 0 ||
				response.workCount > unsettled.workLimit ||
				(unsettled.refresh && response.workPaused) ||
				(!response.isDone &&
					!response.sortLimit &&
					!response.workPaused &&
					(!response.continueCursor || response.continueCursor === unsettled.cursor))
			) {
				setScan({ ...currentScan, failed: unsettled.refresh ? "reload" : "retry" });
				return;
			}
			setScan({
				...currentScan,
				stopped: currentScan.stopped || response.workPaused || response.sortLimit !== null,
				refresh: response.sortLimit ? null : currentScan.refresh,
				remaining:
					currentScan.remaining +
					(!unsettled.refresh && unsettled.action === currentScan.action
						? unsettled.workLimit - response.workCount
						: 0),
				pages: currentScan.pages.map((page) =>
					page.id === unsettled.id
						? {
								...page,
								settled: true,
								continueCursor: response.continueCursor,
								isDone: response.isDone,
								workPaused: response.workPaused,
								sortLimit: response.sortLimit,
							}
						: page,
				),
			});
			return;
		}

		if (currentScan.pages.some((page) => filteredResponses[page.id] === undefined)) return;

		const open = segments.find((segment) => segment.status !== "done");
		if (currentScan.refresh !== null) {
			const slots = open
				? currentScan.refresh.filter((slot) => {
						const position = segments.findIndex(
							(segment) => segment.kind === slot.kind && segment.segment === slot.segment,
						);
						return position >= segments.indexOf(open);
					})
				: [];
			const slot = slots[0];
			if (!slot || slot.kind !== open?.kind || slot.segment !== open.segment) {
				setScan({ ...currentScan, refresh: null });
				return;
			}
			const last = currentScan.pages.filter((page) => page.kind === slot.kind && page.segment === slot.segment).at(-1);
			setScan({
				...currentScan,
				nextId: currentScan.nextId + 1,
				refresh: slots.slice(1),
				pages: [
					...currentScan.pages,
					{
						...slot,
						id: currentScan.nextId,
						cursor: last?.continueCursor ?? null,
						action: currentScan.action,
						refresh: true,
						settled: false,
						continueCursor: null,
						isDone: false,
						workPaused: false,
						sortLimit: null,
					},
				],
			});
			return;
		}
		if (
			!open ||
			sortLimit !== null ||
			workPaused ||
			currentScan.stopped ||
			currentScan.remaining === 0 ||
			(sideRows !== undefined && mergedRows.length >= currentScan.goal)
		)
			return;
		const last = currentScan.pages.filter((page) => page.kind === open.kind && page.segment === open.segment).at(-1);
		const workLimit =
			sort.length > 1 ? currentScan.remaining : Math.min(FILES_SORTED_CHILDREN_PAGE_SIZE, currentScan.remaining);
		setScan({
			...currentScan,
			nextId: currentScan.nextId + 1,
			remaining: currentScan.remaining - workLimit,
			pages: [
				...currentScan.pages,
				{
					id: currentScan.nextId,
					kind: open.kind,
					segment: open.segment,
					cursor: last?.continueCursor ?? null,
					workLimit,
					action: currentScan.action,
					refresh: false,
					settled: false,
					continueCursor: null,
					isDone: false,
					workPaused: false,
					sortLimit: null,
				},
			],
		});
	});

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
			!(
				row.target.kind === "saved" &&
				!shownHeldRows.sideKeys.includes(key) &&
				(claimedNames.has(row.name) || sideKeys.has(key))
			)
		);
	});
	if (isSettled && heldRows?.key !== heldKey) {
		setHeldRows({ folderScope, key: heldKey, sort, filter, rows: mergedRows, sideKeys: [...sideKeys] });
	} else if (shownHeldRows && heldRowsToShow && heldRowsToShow.length !== shownHeldRows.rows.length) {
		// Keep known removals through Retry's query reset. A settled result can restore the row later.
		setHeldRows({ ...shownHeldRows, key: "", rows: heldRowsToShow });
	}
	const requestMatches = useFn((count: number) => {
		if (!customScan) return;
		if (count <= 5) {
			// Dropping an unanswered request spends its full reserved work.
			setScan({
				...currentScan,
				goal: 5,
				stopped: true,
				pages: currentScan.pages.filter((page) => page.settled),
				refresh: null,
			});
			return;
		}
		setScan({
			...currentScan,
			goal: count,
			action: currentScan.action + 1,
			remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
			stopped: false,
			pages: currentScan.pages.filter((page) => !page.workPaused),
		});
	});
	const continueSearch = useFn(() => {
		if (!customScan) return;
		setScan({
			...currentScan,
			action: currentScan.action + 1,
			remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
			stopped: false,
			pages: currentScan.pages.filter((page) => !page.workPaused),
		});
	});
	const reload = useFn(() => {
		if (!customScan) return;
		setScan({
			...currentScan,
			action: currentScan.action + 1,
			remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
			goal: 5,
			stopped: false,
			pages: [],
			refresh: null,
			failed: null,
			retrying: true,
		});
	});
	const retry = useFn(() => {
		setScan({
			...currentScan,
			action: currentScan.action + 1,
			remaining: FILES_SORTED_CHILDREN_ACTION_WORK,
			stopped: false,
			pages: currentScan.pages.filter((page) => page.settled && !page.workPaused),
			refresh: null,
			failed: null,
			retrying: true,
		});
	});

	// Load the first shown segment that has more rows. A hidden segment would load rows nobody sees.
	const loadMore = useFn(() => {
		if (customScan) {
			requestMatches(Math.max(50, mergedRows.length + 50));
			return;
		}
		shownSegments.find((segment) => segment.status === "more")?.loadMore();
	});
	const isFailed =
		sideRows === null ||
		sideMatchesFailed ||
		currentScan.failed !== null ||
		segments.some((segment) => segment.status === "failed");
	const isDone =
		isSettled &&
		segments.every((segment) => segment.status === "done") &&
		!preparing &&
		sortLimit === null &&
		!workPaused;
	const paused =
		customScan &&
		!isFailed &&
		!isDone &&
		sortLimit === null &&
		(currentScan.remaining === 0 || (currentScan.stopped && currentScan.refresh === null)) &&
		currentScan.pages.every((page) => page.settled) &&
		mergedRows.length < currentScan.goal;
	const searching =
		customScan &&
		!isFailed &&
		!isDone &&
		sortLimit === null &&
		!paused &&
		(sideRows === undefined ||
			!sideMatchesReady ||
			!sideKeysReady ||
			currentScan.pages.some((page) => !page.settled) ||
			(!currentScan.stopped &&
				mergedRows.length < currentScan.goal &&
				segments.some((segment) => segment.status !== "done")));
	const rows = sideRows === null ? undefined : isSettled ? mergedRows : heldRowsToShow;

	return {
		rows,
		sideTargets: sideRows?.rows.map((row) => row.target) ?? [],
		// Held rows keep their old sort keys, header arrows and table sort attributes.
		rowsSort: isSettled ? sort : (shownHeldRows?.sort ?? null),
		rowsFilter: isSettled ? filter : (shownHeldRows?.filter ?? null),
		isBusy: !isFailed && (!isSettled || searching),
		isDone,
		// Side rows are null when this user cannot read the folder.
		isFailed,
		isFolderRefused: sideRows === null,
		searching,
		paused,
		preparing,
		refreshing: customScan && currentScan.refresh !== null && !isFailed,
		sortLimit,
		workPaused,
		filterRecovery:
			currentScan.failed ?? (sideMatchesFailed ? (currentScan.refresh !== null ? "reload" : "retry") : null),
		tooManyShared: sideRows?.tooManyShared ?? false,
		tooManyPending: sideRows?.tooManyPending ?? false,
		loadMore,
		requestMatches,
		continueSearch,
		reload,
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
