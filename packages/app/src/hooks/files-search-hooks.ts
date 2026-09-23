import { useEffect, useMemo, useState } from "react";
import { useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useFn } from "./utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_TreeItem } from "@/lib/files.ts";
import { search_path_filter } from "@/lib/files-search.ts";
import {
	files_search_query_folder_path,
	files_search_query_parse,
	files_search_query_to_plans,
} from "../../shared/files-search-query.ts";

/**
 * Page `files_visible.list` 50 entries at a time.
 *
 * `complete` loads every page and returns the entries only when the listing is done.
 * `incremental` returns the pages loaded so far and loads the next page only on `loadMore()`. It asks for
 * folders first, then files, so the Files table can show each page as it arrives without sorting again.
 */
export function useFilesVisibleEntries(
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	folderPath: string | null | undefined,
	mode: "subtree" | "children",
	load: "complete" | "incremental" = "complete",
) {
	const scope = JSON.stringify([membershipId, folderPath, mode]);
	// `pageCount` is how many pages incremental mode was asked for. When an earlier page changes and its
	// old suffix is dropped, the hook loads pages again up to that count, so the table keeps its length.
	const [pages, setPages] = useState({ scope, cursors: [null] as Array<string | null>, pageCount: 1 });
	const cursors = useMemo(() => (pages.scope === scope ? pages.cursors : [null]), [scope, pages]);
	const pageCount = pages.scope === scope ? pages.pageCount : 1;

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
									...(load === "incremental" ? { orderBy: "kindThenName" as const } : {}),
								},
							},
						]),
					),
		[cursors, folderPath, load, membershipId, mode],
	);

	const responses = useQueries(queries);

	const progress = useMemo(() => {
		type Page = FunctionReturnType<typeof app_convex_api.files_visible.list>;
		const entries: Array<NonNullable<Page["_yay"]>["items"][number]> = [];
		let nextCursors: Array<string | null> | null = null;
		let moreCursor: string | null = null;
		let loadedPages = 0;
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
			loadedPages++;
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
			// Incremental mode waits for `loadMore()` before it asks for the next page.
			if (load === "incremental" && index + 1 >= pageCount) {
				moreCursor = cursor;
				break;
			}
			if (cursor !== cursors[index + 1]) {
				nextCursors = [...cursors.slice(0, index + 1), cursor];
				break;
			}
		}

		const hasEntries = complete || (load === "incremental" && loadedPages > 0);
		return { entries: hasEntries && !failed ? entries : undefined, nextCursors, moreCursor, complete, failed };
	}, [cursors, folderPath, load, pageCount, responses]);

	// Keep all loaded pages subscribed. If an earlier cursor changes, discard its old suffix.
	useEffect(() => {
		if (pages.scope === scope && !progress.nextCursors) return;
		// Cached pages can resolve all at once. Yield between pages so the input stays responsive.
		const timer = setTimeout(() => setPages({ scope, cursors: progress.nextCursors ?? cursors, pageCount }), 0);
		return () => clearTimeout(timer);
	}, [cursors, scope, pages.scope, pageCount, progress.nextCursors]);

	// Do nothing while the last page is loading or when the listing is done.
	const loadMore = useFn(() => {
		if (progress.moreCursor === null) return;
		setPages({ scope, cursors: [...cursors, progress.moreCursor], pageCount: cursors.length + 1 });
	});

	return { entries: progress.entries, isFailed: progress.failed, isDone: progress.complete, loadMore };
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
