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
import { useFn } from "./utils-hooks.ts";

// Adapted from Convex 1.46.0 src/react/use_paginated_query.ts.
// Files wait for new saved-view args instead of retrying the same old view.

type PageQuery = {
	query: FunctionReference<"query">;
	args: Record<string, Value> & { paginationOpts: Infer<typeof paginationOptsValidator> };
};

type PageState = {
	query: FunctionReference<"query">;
	args: Record<string, Value>;
	id: number;
	nextPageKey: number;
	pageKeys: number[];
	queries: Record<number, PageQuery>;
	ongoingSplits: Record<number, [number, number]>;
	skip: boolean;
};

// SDK pagers use nonnegative IDs. Each Files pager gets a separate journal.
let paginationId = 0;

function split_page(key: number, splitCursor: string, continueCursor: string) {
	return (state: PageState) => {
		const queries = { ...state.queries };
		const firstKey = state.nextPageKey;
		const secondKey = firstKey + 1;
		queries[firstKey] = {
			query: state.query,
			args: {
				...state.args,
				paginationOpts: { ...state.queries[key]!.args.paginationOpts, endCursor: splitCursor },
			},
		};
		queries[secondKey] = {
			query: state.query,
			args: {
				...state.args,
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
 * Page a Files saved stream. A changed Move view waits until the caller supplies its new args.
 */
export function useFilesPaginatedQuery<Query extends PaginatedQueryReference>(
	query: Query,
	args: PaginatedQueryArgs<Query> | "skip",
	options: { initialNumItems: number },
): UsePaginatedQueryResult<PaginatedQueryItem<Query>> {
	if (typeof options?.initialNumItems !== "number" || options.initialNumItems < 0)
		throw new Error("initialNumItems must be a positive number.");
	const skip = args === "skip";
	const queryName = getFunctionName(query);
	const argsJson = JSON.stringify(convexToJson((skip ? {} : args) as Record<string, Value>));
	const argsObject = useMemo(() => jsonToConvex(JSON.parse(argsJson)) as Record<string, Value>, [argsJson]);
	const queryReference = useMemo(() => makeFunctionReference<"query">(queryName), [queryName]);
	const createInitialState = useMemo(
		() => (): PageState => {
			const id = --paginationId;
			return {
				query: queryReference,
				args: argsObject,
				id,
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
	const [state, setState] = useState<PageState>(createInitialState);
	let current = state;
	if (
		getFunctionName(query) !== getFunctionName(state.query) ||
		argsJson !== JSON.stringify(convexToJson(state.args)) ||
		skip !== state.skip
	) {
		current = createInitialState();
		setState(current);
	}
	const resultsObject = useQueries(current.queries) as Record<
		number,
		PaginationResult<PaginatedQueryItem<Query>> | Error | undefined
	>;
	const [results, lastResult] = useMemo<
		[PaginatedQueryItem<Query>[], PaginationResult<PaginatedQueryItem<Query>> | undefined]
	>(() => {
		let waitingForView = false;
		let invalidCursor = false;
		// A failed split child is defined too. Check all pages before showing rows or swapping a split.
		for (const key of [...current.pageKeys, ...Object.values(current.ongoingSplits).flat()]) {
			const result = resultsObject[key];
			if (!(result instanceof Error)) continue;
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
		if (waitingForView) return [[], undefined];
		if (invalidCursor) {
			setState(createInitialState);
			return [[], undefined];
		}
		const rows: PaginatedQueryItem<Query>[] = [];
		let result: PaginationResult<PaginatedQueryItem<Query>> | undefined;
		for (const key of current.pageKeys) {
			const page = resultsObject[key];
			if (page === undefined) return [rows, undefined];
			if (page instanceof Error) throw page;
			result = page;
			const split = current.ongoingSplits[key];
			if (split) {
				if (resultsObject[split[0]] !== undefined && resultsObject[split[1]] !== undefined)
					setState(complete_split(key));
			} else if (
				page.splitCursor &&
				(page.pageStatus === "SplitRecommended" ||
					page.pageStatus === "SplitRequired" ||
					page.page.length > options.initialNumItems * 2)
			)
				setState(split_page(key, page.splitCursor, page.continueCursor));
			// The caller keeps its previous complete display while a required split loads.
			if (page.pageStatus === "SplitRequired") return [rows, undefined];
			rows.push(...page.page);
		}
		return [rows, result];
	}, [resultsObject, current, options.initialNumItems, createInitialState]);
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
					if (previous.id !== current.id) return previous;
					const key = previous.nextPageKey;
					return {
						...previous,
						nextPageKey: key + 1,
						pageKeys: [...previous.pageKeys, key],
						queries: {
							...previous.queries,
							[key]: {
								query: previous.query,
								args: {
									...previous.args,
									paginationOpts: { numItems, cursor: lastResult.continueCursor, id: previous.id },
								},
							},
						},
					};
				});
			},
		};
	}, [lastResult, current.id, current.nextPageKey]);
	// The tree can retain an older result and its button while this view waits.
	const loadMore = useFn(status.loadMore);
	return { results, ...status, loadMore };
}
