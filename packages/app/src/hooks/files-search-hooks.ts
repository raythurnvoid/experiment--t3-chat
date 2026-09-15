import { useEffect, useMemo, useState } from "react";
import { useQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import type { files_TreeItem } from "@/lib/files.ts";
import { search_path_filter } from "@/lib/files-search.ts";
import {
	files_search_query_folder_path,
	files_search_query_parse,
	files_search_query_to_plans,
} from "../../shared/files-search-query.ts";

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
								args: { membershipId, folderPath, mode, numItems: 50, cursor },
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

		return { entries: complete && !failed ? entries : undefined, nextCursors, failed };
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
