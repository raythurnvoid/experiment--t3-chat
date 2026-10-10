import { useState } from "react";
import {
	usePaginatedQuery,
	type PaginatedQueryArgs,
	type PaginatedQueryItem,
	type PaginatedQueryReference,
} from "convex/react";
import { compareValues, type Value } from "convex/values";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_metadata_catalog_lower,
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_METADATA_FIELD_PREFIX,
} from "../../shared/files-metadata.ts";
import type { files_SavedStream } from "../../shared/files.ts";
import { useFilesSavedView } from "./files-saved-view-hooks.ts";
import { files_merge_sorted_streams } from "./files-search-hooks.ts";

/**
 * Rows per catalog page. The doors return at most 50.
 */
export const files_metadata_catalog_PAGE_SIZE = 50;

/**
 * The key prefixes to ask the catalog for, at most one per namespace. A qualified key asks only its
 * own namespace. Text that starts a namespace name (`front`, `meta`) asks that whole namespace.
 */
export function files_metadata_catalog_key_prefixes(typed: string) {
	const namespaces = [files_metadata_FRONTMATTER_FIELD_PREFIX, files_metadata_METADATA_FIELD_PREFIX];
	const lower = files_metadata_catalog_lower(typed);
	if (namespaces.some((namespace) => lower.startsWith(namespace))) {
		return [typed];
	}
	return namespaces.map((namespace) => (namespace.startsWith(lower) ? namespace : `${namespace}${typed}`));
}

/**
 * Index order of a key row: the catalog sorts keys by their lowercase copy, then by the key.
 */
export function files_metadata_catalog_key_order(fieldPath: string): Value {
	return [files_metadata_catalog_lower(fieldPath), fieldPath];
}

/**
 * Pages of one catalog door for up to two requests, one per namespace. Each request reads the
 * normal stream and the visible Move view's stream. They merge in index order and a row in both
 * shows once. The requests' rows show one after the other, and each request has its own cursors.
 *
 * While a new request loads its first page, the rows loaded last for the same `scope` stay in
 * `rows` with `updating` true, so the list does not flash empty. Callers disable those rows.
 *
 * A query error throws, so call this in a child under a `CatchBoundary`.
 */
export function useFilesMetadataCatalogPages<Query extends PaginatedQueryReference>(args: {
	query: Query;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	/**
	 * Door args without `savedStream`, at most two. `null` fetches nothing.
	 */
	requests: Array<Omit<PaginatedQueryArgs<Query>, "savedStream">> | null;
	/**
	 * Held rows show only while the scope (membership, folder, field) stays the same.
	 */
	scope: string;
	order: (row: PaginatedQueryItem<Query>) => Value;
	rowKey: (row: PaginatedQueryItem<Query>) => string;
}) {
	const { query, membershipId, requests, scope, order, rowKey } = args;

	const view = useFilesSavedView(membershipId, requests !== null);
	const streamArgs = (index: number, savedStream: files_SavedStream | null) => {
		const request = requests?.[index];
		return request && savedStream ? ({ ...request, savedStream } as unknown as PaginatedQueryArgs<Query>) : "skip";
	};
	const options = { initialNumItems: files_metadata_catalog_PAGE_SIZE };
	const pairs = [
		[usePaginatedQuery(query, streamArgs(0, view.normal), options), usePaginatedQuery(query, streamArgs(0, view.cohort), options)],
		[usePaginatedQuery(query, streamArgs(1, view.normal), options), usePaginatedQuery(query, streamArgs(1, view.cohort), options)],
	];
	const merges = pairs.slice(0, requests?.length ?? 0).map(([normal, cohort]) => {
		const streams = view.cohort ? [normal!, cohort!] : [normal!];
		const merged = files_merge_sorted_streams({
			streams: streams.map((stream) => ({ rows: stream.results, isDone: stream.status === "Exhausted" })),
			compare: (a, b) => compareValues(order(a), order(b)),
			key: rowKey,
		});
		return { streams, rows: merged.rows, blocking: merged.blockingRank === null ? null : streams[merged.blockingRank]! };
	});
	const streams = merges.flatMap((merge) => merge.streams);
	const rows = merges.flatMap((merge) => merge.rows);
	const loadedRows = streams.flatMap((stream) => stream.results);
	const loading = requests !== null && (view.loading || streams.some((stream) => stream.status === "LoadingFirstPage"));

	// Keep the last loaded rows. A length check is enough: held rows only show while a new first
	// page loads, and they are disabled then.
	const identity = JSON.stringify(requests);
	const [held, setHeld] = useState<{
		scope: string;
		identity: string;
		rows: typeof rows;
		loadedRows: typeof loadedRows;
	} | null>(null);
	if (!loading && (held?.identity !== identity || held.rows.length !== rows.length)) {
		setHeld({ scope, identity, rows, loadedRows });
	}
	const isHolding = loading && held !== null && held.scope === scope;

	return {
		rows: isHolding ? held.rows : rows,
		/**
		 * Every loaded row of every stream, also a row the merge showed once.
		 */
		loadedRows: isHolding ? held.loadedRows : loadedRows,
		updating: loading,
		status: loading
			? ("LoadingFirstPage" as const)
			: streams.some((stream) => stream.status === "LoadingMore")
				? ("LoadingMore" as const)
				: merges.some((merge) => merge.blocking !== null)
					? ("CanLoadMore" as const)
					: ("Exhausted" as const),
		loadMore: () => {
			for (const merge of merges) {
				merge.blocking?.loadMore(files_metadata_catalog_PAGE_SIZE);
			}
		},
	};
}

/**
 * Keys on a folder's children that start with the typed text, for the Columns menu and the folder
 * filter bar.
 */
export function useFilesMetadataFolderKeys(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	prefix: string;
}) {
	const { membershipId, folderId, prefix } = args;

	return useFilesMetadataCatalogPages({
		query: app_convex_api.files_metadata.list_folder_fields,
		membershipId,
		requests: files_metadata_catalog_key_prefixes(prefix).map((keyPrefix) => ({
			membershipId,
			parentId: folderId,
			prefix: keyPrefix,
		})),
		scope: `${membershipId}
${folderId}`,
		order: files_metadata_catalog_key_order,
		rowKey: (fieldPath) => fieldPath,
	});
}
