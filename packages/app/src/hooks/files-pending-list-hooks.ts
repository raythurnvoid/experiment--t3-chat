import { usePaginatedQuery } from "convex/react";
import { compareValues } from "convex/values";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_merge_sorted_streams } from "./files-search-hooks.ts";
import { useFilesSavedView } from "./files-saved-view-hooks.ts";

/**
 * The Pending panel and editor pager share one owner list and sort order.
 */
export function useFilesPendingUpdates(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	listKey: string;
}) {
	const view = useFilesSavedView(args.membershipId);
	const normal = usePaginatedQuery(
		app_convex_api.files_pending_updates.list_files_pending_updates,
		view.normal ? { ...args, savedStream: view.normal } : "skip",
		{ initialNumItems: 20 },
	);
	const cohort = usePaginatedQuery(
		app_convex_api.files_pending_updates.list_files_pending_updates,
		view.cohort ? { ...args, savedStream: view.cohort } : "skip",
		{ initialNumItems: 20 },
	);
	const streams = view.normal ? [normal, ...(view.cohort ? [cohort] : [])] : [];
	const merged = files_merge_sorted_streams({
		streams: streams.map((stream) => ({ rows: stream.results, isDone: stream.status === "Exhausted" })),
		compare: (a, b) =>
			-compareValues(
				[a.updatedAt, a.listRowCreationTime, a.listRowId],
				[b.updatedAt, b.listRowCreationTime, b.listRowId],
			),
		key: (row) => row.pendingUpdateId,
	});
	const blocking = merged.blockingRank === null ? null : streams[merged.blockingRank]!;
	return {
		results: merged.rows,
		status:
			view.loading || streams.some((stream) => stream.status === "LoadingFirstPage")
				? ("LoadingFirstPage" as const)
				: streams.some((stream) => stream.status === "LoadingMore")
					? ("LoadingMore" as const)
					: blocking
						? ("CanLoadMore" as const)
						: ("Exhausted" as const),
		loadMore: (numItems: number) => blocking?.loadMore(numItems),
	};
}
