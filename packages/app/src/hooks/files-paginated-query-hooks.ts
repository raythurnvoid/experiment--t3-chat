import { useMemo, useState } from "react";
import {
	useQueries,
	type PaginatedQueryArgs,
	type PaginatedQueryItem,
	type PaginatedQueryReference,
	type UsePaginatedQueryResult,
} from "convex/react";
import {
	getFunctionName,
	makeFunctionReference,
	type FunctionReference,
	type paginationOptsValidator,
	type PaginationResult,
} from "convex/server";
import { ConvexError, convexToJson, jsonToConvex, type Infer, type Value } from "convex/values";
import type { files_DirectoryView } from "../../shared/files.ts";
import { useCachedQueries } from "./convex-hooks.ts";
import { useFn } from "./utils-hooks.ts";

// Adapted from Convex 1.46.0 src/react/use_paginated_query.ts.
// Global saved views wait for new args. Directory views reset their native pages locally.

type PageQuery = {
	query: FunctionReference<"query">;
	args: Record<string, Value> & { paginationOpts: Infer<typeof paginationOptsValidator> };
};

type PageState = {
	query: FunctionReference<"query">;
	args: Record<string, Value>;
	id: number;
	requestedItems: number;
	refilling: boolean;
	nextPageKey: number;
	pageKeys: number[];
	queries: Record<number, PageQuery>;
	ongoingSplits: Record<number, [number, number]>;
	skip: boolean;
};

// SDK pagers use nonnegative IDs, so Files pagers use negative ones. The ID is part of the query args.
// Every pager starts with the same ID, so an unbound first page can use the query cache on a revisit.
// Cursor errors and mixed directory views need a new ID, or the cache returns the same broken page.
const FIRST_PAGINATION_ID = -1;
let paginationId = FIRST_PAGINATION_ID;

function next_pagination_id() {
	paginationId -= 1;
	return paginationId;
}

function split_page(key: number, splitCursor: string, continueCursor: string, directoryView?: files_DirectoryView) {
	return (state: PageState) => {
		const queries = { ...state.queries };
		const firstKey = state.nextPageKey;
		const secondKey = firstKey + 1;
		queries[firstKey] = {
			query: state.query,
			args: {
				...state.args,
				...(directoryView === undefined ? {} : { pageView: directoryView }),
				paginationOpts: { ...state.queries[key]!.args.paginationOpts, endCursor: splitCursor },
			},
		};
		queries[secondKey] = {
			query: state.query,
			args: {
				...state.args,
				...(directoryView === undefined ? {} : { pageView: directoryView }),
				paginationOpts: {
					...state.queries[key]!.args.paginationOpts,
					cursor: splitCursor,
					endCursor: continueCursor,
				},
			},
		};
		return {
			...state,
			queries,
			nextPageKey: firstKey + 2,
			ongoingSplits: { ...state.ongoingSplits, [key]: [firstKey, secondKey] as [number, number] },
		};
	};
}

function complete_split(key: number) {
	return (state: PageState) => {
		const split = state.ongoingSplits[key];
		if (!split) return state;
		const queries = { ...state.queries };
		delete queries[key];
		const ongoingSplits = { ...state.ongoingSplits };
		delete ongoingSplits[key];
		const index = state.pageKeys.indexOf(key);
		return {
			...state,
			queries,
			ongoingSplits,
			pageKeys:
				index < 0 ? state.pageKeys : [...state.pageKeys.slice(0, index), ...split, ...state.pageKeys.slice(index + 1)],
		};
	};
}

/**
 * Page a Files saved stream. Keep native cursors beside the directory view that made them.
 */
export function useFilesPaginatedQuery<Query extends PaginatedQueryReference>(
	query: Query,
	args: PaginatedQueryArgs<Query> | "skip",
	options: {
		initialNumItems: number;
		/**
		 * Let the first page of a `savedStream` use the query cache too. Pass it only for a few queries
		 * per stream, like a menu's untyped first page. Each old Move generation then stays idle in the
		 * cache for up to 5 minutes.
		 */
		cacheSavedStreamFirstPage?: boolean;
	},
): UsePaginatedQueryResult<PaginatedQueryItem<Query>> & { directoryView: files_DirectoryView | undefined } {
	if (typeof options?.initialNumItems !== "number" || options.initialNumItems < 0)
		throw new Error("initialNumItems must be a positive number.");
	const skip = args === "skip";
	const queryName = getFunctionName(query);
	const argsJson = JSON.stringify(convexToJson((skip ? {} : args) as Record<string, Value>));
	const argsObject = useMemo(() => jsonToConvex(JSON.parse(argsJson)) as Record<string, Value>, [argsJson]);
	const directory = argsObject.stream === "normal" || argsObject.stream === "cohort";
	const queryReference = useMemo(() => makeFunctionReference<"query">(queryName), [queryName]);
	const createInitialState = useMemo(
		() =>
			(id: number, requestedItems?: number, refilling = false): PageState => {
				return {
					query: queryReference,
					args: argsObject,
					id,
					requestedItems: requestedItems ?? options.initialNumItems,
					refilling,
					nextPageKey: 1,
					pageKeys: skip ? [] : [0],
					queries: skip
						? {}
						: {
								0: {
									query: queryReference,
									args: { ...argsObject, paginationOpts: { numItems: options.initialNumItems, cursor: null, id } },
								},
							},
					ongoingSplits: {},
					skip,
				};
			},
		[argsObject, queryReference, options.initialNumItems, skip],
	);
	const [state, setState] = useState<PageState>(() => createInitialState(FIRST_PAGINATION_ID));
	let current = state;
	if (
		getFunctionName(query) !== getFunctionName(state.query) ||
		argsJson !== JSON.stringify(convexToJson(state.args)) ||
		skip !== state.skip
	) {
		current = createInitialState(FIRST_PAGINATION_ID);
		setState(current);
	}
	// Keep reusable first pages in the idle cache. Old view and cursor queries must stop with their pager.
	const cacheSavedStreamFirstPage = options.cacheSavedStreamFirstPage ?? false;
	const [cachedQueries, liveQueries] = useMemo(() => {
		const cached: Record<number, PageQuery> = {};
		const live: Record<number, PageQuery> = {};
		for (const [key, page] of Object.entries(current.queries)) {
			const paginationOpts = page.args.paginationOpts;
			const queries =
				("savedStream" in page.args && !cacheSavedStreamFirstPage) ||
				"pageView" in page.args ||
				paginationOpts.cursor !== null ||
				paginationOpts.endCursor != null ||
				paginationOpts.id !== FIRST_PAGINATION_ID
					? live
					: cached;
			queries[Number(key)] = page;
		}
		return [cached, live];
	}, [current.queries, cacheSavedStreamFirstPage]);
	const cachedResults = useCachedQueries(cachedQueries);
	const liveResults = useQueries(liveQueries);
	const resultsObject = useMemo(() => ({ ...cachedResults, ...liveResults }), [cachedResults, liveResults]) as Record<
		number,
		(PaginationResult<PaginatedQueryItem<Query>> & { directoryView?: files_DirectoryView }) | Error | undefined
	>;
	const [results, lastResult, nextState, directoryView] = useMemo<
		[
			PaginatedQueryItem<Query>[],
			(PaginationResult<PaginatedQueryItem<Query>> & { directoryView?: files_DirectoryView }) | undefined,
			PageState | "reset" | null,
			files_DirectoryView | undefined,
		]
	>(() => {
		let waitingForView = false;
		let invalidCursor = false;
		let directoryView: files_DirectoryView | undefined;
		// A failed split child is defined too. Check all pages before showing rows or swapping a split.
		for (const key of [...current.pageKeys, ...Object.values(current.ongoingSplits).flat()]) {
			const result = resultsObject[key];
			if (!(result instanceof Error)) {
				if (directory && result !== undefined) {
					const view = result.directoryView;
					if (directoryView === undefined) directoryView = view;
					else if (directoryView?.cohortId !== view?.cohortId || directoryView?.view !== view?.view)
						invalidCursor = true;
				}
				continue;
			}
			const data = result instanceof ConvexError ? result.data : null;
			if (
				data !== null &&
				typeof data === "object" &&
				"reason" in data &&
				(data.reason === "saved_move_view_changed" || data.reason === "saved_search_view_changed") &&
				"paginationError" in data &&
				data.paginationError === "InvalidCursor"
			) {
				waitingForView = true;
				continue;
			}
			if (
				result.message.includes("InvalidCursor") ||
				(data !== null &&
					typeof data === "object" &&
					"isConvexSystemError" in data &&
					data.isConvexSystemError === true &&
					"paginationError" in data &&
					data.paginationError === "InvalidCursor")
			) {
				invalidCursor = true;
				continue;
			}
			throw result;
		}
		// A cursor reset still has old view args. Wait first, but never hide another error.
		if (waitingForView) return [[], undefined, null, undefined];
		if (invalidCursor) return [[], undefined, "reset", undefined];
		const rows: PaginatedQueryItem<Query>[] = [];
		let result: PaginationResult<PaginatedQueryItem<Query>> | undefined;
		let next: PageState | null = null;
		for (const key of current.pageKeys) {
			const page = resultsObject[key];
			if (page === undefined) return [rows, undefined, next, undefined];
			if (page instanceof Error) throw page;
			result = page;
			const split = current.ongoingSplits[key];
			if (split) {
				if (resultsObject[split[0]] !== undefined && resultsObject[split[1]] !== undefined)
					next = complete_split(key)(next ?? current);
			} else if (
				page.splitCursor &&
				(page.pageStatus === "SplitRecommended" ||
					page.pageStatus === "SplitRequired" ||
					page.page.length > options.initialNumItems * 2)
			)
				next = split_page(key, page.splitCursor, page.continueCursor, page.directoryView)(next ?? current);
			// The caller keeps its previous complete display while a required split loads.
			if (page.pageStatus === "SplitRequired") return [rows, undefined, next, undefined];
			rows.push(...page.page);
		}
		// A directory reset refills the requested rows before it settles.
		if (current.refilling && result) {
			if (rows.length < current.requestedItems && !result.isDone) {
				const previous = next ?? current;
				const key = previous.nextPageKey;
				return [
					[],
					undefined,
					{
						...previous,
						nextPageKey: key + 1,
						pageKeys: [...previous.pageKeys, key],
						queries: {
							...previous.queries,
							[key]: {
								query: previous.query,
								args: {
									...previous.args,
									pageView: directoryView!,
									paginationOpts: { numItems: options.initialNumItems, cursor: result.continueCursor, id: previous.id },
								},
							},
						},
					},
					undefined,
				];
			}
			next = { ...(next ?? current), refilling: false };
		}
		return [rows, result, next, directoryView];
	}, [resultsObject, current, options.initialNumItems, directory]);
	// Keep the page calculation pure. Apply only its derived transition during render.
	if (nextState === "reset")
		setState(createInitialState(next_pagination_id(), directory ? current.requestedItems : undefined, directory));
	else if (nextState !== null) setState(nextState);
	const status = useMemo(() => {
		if (!lastResult)
			return {
				status: current.nextPageKey === 1 ? ("LoadingFirstPage" as const) : ("LoadingMore" as const),
				isLoading: true as const,
				loadMore: (_numItems: number) => {},
			};
		if (lastResult.isDone)
			return { status: "Exhausted" as const, isLoading: false as const, loadMore: (_numItems: number) => {} };
		let loadingMore = false;
		return {
			status: "CanLoadMore" as const,
			isLoading: false as const,
			loadMore: (numItems: number) => {
				if (loadingMore) return;
				loadingMore = true;
				setState((previous) => {
					// New args can reuse the same ID, so check the args too.
					if (previous.id !== current.id || previous.args !== current.args) return previous;
					const key = previous.nextPageKey;
					return {
						...previous,
						requestedItems: previous.requestedItems + numItems,
						nextPageKey: key + 1,
						pageKeys: [...previous.pageKeys, key],
						queries: {
							...previous.queries,
							[key]: {
								query: previous.query,
								args: {
									...previous.args,
									...(lastResult.directoryView === undefined ? {} : { pageView: lastResult.directoryView }),
									paginationOpts: { numItems, cursor: lastResult.continueCursor, id: previous.id },
								},
							},
						},
					};
				});
			},
		};
	}, [lastResult, current.id, current.args, current.nextPageKey]);
	// The tree can retain an older result and its button while this view waits.
	const loadMore = useFn(status.loadMore);
	return { results, ...status, loadMore, directoryView };
}
