import { useSyncExternalStore } from "react";
import { app_convex, app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";

// One shared `activities.list_recent` watch per membership (the Convex client dedupes it with the
// notifications bell subscription), sliced per target file node. Components subscribe to a single
// node's slice through `useFileNodeActivities`, so a feed update only re-renders the components
// whose node slice actually changed.

type activities_NodeSlice = app_convex_Doc<"activities">[];

type ActivitiesFeed = {
	dispose: () => void;
	listenerCount: number;
	/** Cached per-node slices; the fingerprint keeps snapshot references stable across feed updates. */
	slicesByNodeId: Map<string, { fingerprint: string; snapshot: activities_NodeSlice }>;
	listenersByNodeId: Map<string, Set<() => void>>;
};

const feeds_by_membership = new Map<string, ActivitiesFeed>();

const EMPTY_NODE_SLICE: activities_NodeSlice = [];

function apply_feed_result(feed: ActivitiesFeed, result: activities_NodeSlice | undefined) {
	if (result === undefined) {
		return;
	}

	// Group the feed by target node; feed order (newest first) carries over into each slice.
	const nextSlicesByNodeId = new Map<string, activities_NodeSlice>();
	for (const activity of result) {
		for (const target of activity.targets) {
			if (target.type !== "file_node") {
				continue;
			}
			const slice = nextSlicesByNodeId.get(target.id);
			if (slice) {
				slice.push(activity);
			} else {
				nextSlicesByNodeId.set(target.id, [activity]);
			}
		}
	}

	// Every activity write bumps `updatedAt`, so it is enough as the per-slice change signal.
	const changedNodeIds: string[] = [];
	for (const [nodeId, slice] of nextSlicesByNodeId) {
		const fingerprint = slice.map((activity) => `${activity._id}:${activity.updatedAt}`).join("\n");
		const previous = feed.slicesByNodeId.get(nodeId);
		if (previous && previous.fingerprint === fingerprint) {
			continue;
		}
		feed.slicesByNodeId.set(nodeId, { fingerprint, snapshot: slice });
		changedNodeIds.push(nodeId);
	}
	for (const nodeId of feed.slicesByNodeId.keys()) {
		if (!nextSlicesByNodeId.has(nodeId)) {
			feed.slicesByNodeId.delete(nodeId);
			changedNodeIds.push(nodeId);
		}
	}

	for (const nodeId of changedNodeIds) {
		const listeners = feed.listenersByNodeId.get(nodeId);
		if (!listeners) {
			continue;
		}
		for (const listener of listeners) {
			listener();
		}
	}
}

function get_or_create_feed(membershipId: app_convex_Id<"organizations_workspaces_users">) {
	const existing = feeds_by_membership.get(membershipId);
	if (existing) {
		return existing;
	}

	const watcher = app_convex.watchQuery(app_convex_api.activities.list_recent, { membershipId });

	const feed: ActivitiesFeed = {
		dispose: () => {},
		listenerCount: 0,
		slicesByNodeId: new Map(),
		listenersByNodeId: new Map(),
	};

	// `localQueryResult` throws when the server returned an error for the query (e.g. auth loss).
	const read_local_result = () => {
		try {
			return watcher.localQueryResult();
		} catch (error) {
			console.error("[activities] Failed to read the activities feed", { error });
			return undefined;
		}
	};

	feed.dispose = watcher.onUpdate(() => {
		apply_feed_result(feed, read_local_result());
	});
	// Seed from the local cache: another subscriber (the notifications bell) may already hold the result.
	apply_feed_result(feed, read_local_result());

	feeds_by_membership.set(membershipId, feed);
	return feed;
}

/**
 * The active (non archived) activities targeting one file node, newest first.
 *
 * Re-renders only when that node's slice changes; nodes without activities share one
 * stable empty array. Pass `nodeId: null` when no file is viewed (no subscription).
 */
export function useFileNodeActivities(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes"> | null;
}) {
	const { membershipId, nodeId } = args;

	return useSyncExternalStore(
		(onStoreChange) => {
			if (nodeId === null) {
				return () => {};
			}
			const feed = get_or_create_feed(membershipId);
			let listeners = feed.listenersByNodeId.get(nodeId);
			if (!listeners) {
				listeners = new Set();
				feed.listenersByNodeId.set(nodeId, listeners);
			}
			listeners.add(onStoreChange);
			feed.listenerCount += 1;

			return () => {
				listeners.delete(onStoreChange);
				if (listeners.size === 0) {
					feed.listenersByNodeId.delete(nodeId);
				}
				feed.listenerCount -= 1;
				if (feed.listenerCount === 0) {
					feed.dispose();
					feeds_by_membership.delete(membershipId);
				}
			};
		},
		() =>
			nodeId === null
				? EMPTY_NODE_SLICE
				: (feeds_by_membership.get(membershipId)?.slicesByNodeId.get(nodeId)?.snapshot ?? EMPTY_NODE_SLICE),
		() => EMPTY_NODE_SLICE,
	);
}
