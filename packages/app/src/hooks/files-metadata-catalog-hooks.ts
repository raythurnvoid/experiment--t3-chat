import { useState } from "react";
import { useQuery, type PaginatedQueryArgs, type PaginatedQueryItem, type PaginatedQueryReference } from "convex/react";
import { compareValues, type Value } from "convex/values";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_metadata_catalog_lower,
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_METADATA_FIELD_PREFIX,
} from "../../shared/files-metadata.ts";
import type { files_IndexStream } from "../../shared/files.ts";
import { useFilesSavedIndexView } from "./files-saved-view-hooks.ts";
import { useFilesPaginatedQuery } from "./files-paginated-query-hooks.ts";
import { files_merge_sorted_streams } from "./files-search-hooks.ts";
import { useDebounce } from "./utils-hooks.ts";

/**
 * Rows per catalog page. The doors return at most 50.
 */
const FILES_METADATA_CATALOG_PAGE_SIZE = 50;

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
	/**
	 * Also read each request with `restricted: true` (the owner's restricted twin of
	 * `list_folder_fields`) and merge its rows in.
	 */
	restricted?: boolean;
}) {
	const { query, membershipId, requests, scope, order, rowKey, restricted = false } = args;

	const view = useFilesSavedIndexView(membershipId, requests !== null);
	const streamArgs = (index: number, savedStream: files_IndexStream | null, twin = false) => {
		const request = requests?.[index];
		return request && savedStream && (!twin || restricted)
			? ({ ...request, savedStream, ...(twin ? { restricted: true } : {}) } as unknown as PaginatedQueryArgs<Query>)
			: "skip";
	};
	// Keep the first pages in the query cache for 5 minutes after the menu closes, so it opens again
	// with its rows and no skeleton, also with text left in its box. Cache the requests the menu opens
	// with at once, and later requests once they stay the same for 1 second. Text typed quickly stays
	// live: the cache stops keeping new idle queries once 250 are idle, so a page for every typed
	// prefix would take the place of the folder's own queries.
	const identity = JSON.stringify(requests);
	const settledIdentity = useDebounce(identity, 1000);
	const options = {
		initialNumItems: FILES_METADATA_CATALOG_PAGE_SIZE,
		cacheSavedStreamFirstPage: settledIdentity === identity,
	};
	const groups = [
		[
			useFilesPaginatedQuery(query, streamArgs(0, view.normal), options),
			useFilesPaginatedQuery(query, streamArgs(0, view.cohort), options),
			useFilesPaginatedQuery(query, streamArgs(0, view.normal, true), options),
			useFilesPaginatedQuery(query, streamArgs(0, view.cohort, true), options),
		],
		[
			useFilesPaginatedQuery(query, streamArgs(1, view.normal), options),
			useFilesPaginatedQuery(query, streamArgs(1, view.cohort), options),
			useFilesPaginatedQuery(query, streamArgs(1, view.normal, true), options),
			useFilesPaginatedQuery(query, streamArgs(1, view.cohort, true), options),
		],
	];
	const merges = groups.slice(0, requests?.length ?? 0).map(([normal, cohort, twinNormal, twinCohort]) => {
		// A skipped stream never ends, so only the streams that are read join the merge.
		const pairs = restricted
			? [
					[normal, cohort],
					[twinNormal, twinCohort],
				]
			: [[normal, cohort]];
		const streams = pairs.flatMap(([normalStream, cohortStream]) =>
			view.cohort ? [normalStream!, cohortStream!] : [normalStream!],
		);
		const merged = files_merge_sorted_streams({
			streams: streams.map((stream) => ({ rows: stream.results, isDone: stream.status === "Exhausted" })),
			compare: (a, b) => compareValues(order(a), order(b)),
			key: rowKey,
		});
		return {
			streams,
			rows: merged.rows,
			blocking: merged.blockingRank === null ? null : streams[merged.blockingRank]!,
		};
	});
	const streams = merges.flatMap((merge) => merge.streams);
	const rows = merges.flatMap((merge) => merge.rows);
	const loadedRows = streams.flatMap((stream) => stream.results);
	const loading = requests !== null && (view.loading || streams.some((stream) => stream.status === "LoadingFirstPage"));

	// Keep the last loaded rows. A length check is enough: held rows only show while a new first
	// page loads, and they are disabled then.
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
		/**
		 * The first page loads and no rows of this scope are held, so there is nothing to show yet.
		 * Callers show skeleton rows then.
		 */
		noRowsYet: loading && !isHolding,
		status: loading
			? ("LoadingFirstPage" as const)
			: streams.some((stream) => stream.status === "LoadingMore")
				? ("LoadingMore" as const)
				: merges.some((merge) => merge.blocking !== null)
					? ("CanLoadMore" as const)
					: ("Exhausted" as const),
		loadMore: () => {
			for (const merge of merges) {
				merge.blocking?.loadMore(FILES_METADATA_CATALOG_PAGE_SIZE);
			}
		},
	};
}

/**
 * Keys on a folder's children that start with the typed text, for the Columns menu and the folder
 * filter bar. The owner also reads the keys of the restricted children.
 */
export function useFilesMetadataFolderKeys(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderId: app_convex_Doc<"files_nodes">["parentId"];
	prefix: string;
	/**
	 * Whether the reader owns the organization, or null while that loads.
	 */
	isOwner: boolean | null;
}) {
	const { membershipId, folderId, prefix, isOwner } = args;

	return useFilesMetadataCatalogPages({
		query: app_convex_api.files_metadata.list_folder_fields,
		membershipId,
		requests: files_metadata_catalog_key_prefixes(prefix).map((keyPrefix) => ({
			membershipId,
			parentId: folderId,
			restricted: false,
			prefix: keyPrefix,
		})),
		scope: `${membershipId}\n${folderId}`,
		order: files_metadata_catalog_key_order,
		rowKey: (fieldPath) => fieldPath,
		// Like the tree's twin, read it until the reader is known not to be the owner, so the owner does
		// not see restricted keys late. Anyone else gets an empty page.
		restricted: isOwner !== false,
	});
}

/**
 * Shown to a member without workspace read when a suggestion page is empty. The server gives them
 * nothing at the root, in an open folder, or in a restricted folder whose root they cannot open.
 */
export const files_metadata_catalog_NO_WORKSPACE_READ_MESSAGE =
	"Suggestions need access to the whole workspace or to the restricted folder you are in. You can still type a filter, like metadata.status:open.";

/**
 * Shown to a member under the value suggestions: a member reads the values of one area only.
 */
export const files_metadata_catalog_AREA_VALUES_MESSAGE =
	"Suggestions show values from files everyone can open, or from the restricted folder you are in.";

/**
 * Whether the caller reads the whole workspace, or null while that loads. At the root (and in an
 * open folder) `list_search_fields`, `get_search_field` and `list_search_values` read the open
 * area, which needs workspace read, so a member without it (a guest) gets empty pages there.
 */
export function useFilesMetadataHasWorkspaceRead(workspaceId: app_convex_Id<"organizations_workspaces">) {
	const organizationList = useQuery(app_convex_api.organizations.list);
	const permissions = organizationList?.workspaceIdsPermissionsDict[workspaceId];
	return organizationList === undefined
		? null
		: permissions === "all" || permissions?.includes("content.read") === true;
}

/**
 * Whether the caller owns the organization, or null while that loads. Only the owner has every
 * permission ("all"), and only the owner reads the suggestions of the whole workspace.
 */
export function useFilesMetadataIsOwner(workspaceId: app_convex_Id<"organizations_workspaces">) {
	const organizationList = useQuery(app_convex_api.organizations.list);
	return organizationList === undefined ? null : organizationList.workspaceIdsPermissionsDict[workspaceId] === "all";
}
