import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";

type SnapshotPreload = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	nodeId: app_convex_Id<"files_nodes">;
	abortController: AbortController;
	snapshot: Promise<app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot>>;
	update: Promise<ArrayBuffer | null>;
};

// Only the newly created file's next provider can claim this read.
let pendingSnapshot: SnapshotPreload | null = null;

export function files_yjs_preload_snapshot(args: Pick<SnapshotPreload, "membershipId" | "nodeId">) {
	pendingSnapshot?.abortController.abort();
	const abortController = new AbortController();
	const snapshot = app_convex.action(app_convex_api.files_nodes.yjs_prepare_doc_last_snapshot, args);
	const update = snapshot.then(async (result) => {
		abortController.signal.throwIfAborted();
		if (!result) return null;
		if (!result.snapshotUrl) throw new Error("Yjs snapshot URL is not set");

		const response = await fetch(result.snapshotUrl, { signal: abortController.signal });
		if (!response.ok) throw new Error("Failed to fetch Yjs snapshot from R2");
		return response.arrayBuffer();
	});
	// Creation does not await this read. The provider handles a rejection if it takes it.
	void update.catch(() => {});

	const preload = { ...args, abortController, snapshot, update };
	pendingSnapshot = preload;
	return () => {
		// An old route cleanup must not cancel a newer preload or its provider's read.
		if (pendingSnapshot !== preload) return;
		pendingSnapshot = null;
		abortController.abort();
	};
}

export function files_yjs_has_preloaded_snapshot(args: Pick<SnapshotPreload, "membershipId" | "nodeId">) {
	return pendingSnapshot?.membershipId === args.membershipId && pendingSnapshot.nodeId === args.nodeId;
}

export function files_yjs_take_preloaded_snapshot(args: Pick<SnapshotPreload, "membershipId" | "nodeId">) {
	if (pendingSnapshot?.membershipId !== args.membershipId || pendingSnapshot.nodeId !== args.nodeId) return null;
	const preload = pendingSnapshot;
	pendingSnapshot = null;
	return preload;
}
