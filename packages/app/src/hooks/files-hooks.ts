import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	files_yjs_Provider,
	type files_yjs_EditBlockReason,
	type files_yjs_PushRefusalReason,
} from "@/lib/files-yjs-provider.ts";
import { app_qa_register_files_yjs_provider } from "@/lib/app-qa.ts";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Id } from "../lib/app-convex-client.ts";

export type useFilesYjs_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	presenceStore: files_PresenceStore;
	editable: boolean;
	editBlockReason: files_yjs_EditBlockReason | null;
};

export function useFilesYjs(props: useFilesYjs_Props) {
	const { nodeId, membershipId, presenceStore, editable, editBlockReason } = props;

	const [yjsProvider, setYjsProvider] = useState<files_yjs_Provider | undefined>(undefined);
	const [providerNodeId, setProviderNodeId] = useState<app_convex_Id<"files_nodes"> | undefined>(undefined);
	const [syncStatus, setSyncStatus] = useState<ReturnType<files_yjs_Provider["getStatus"]>>("loading");
	const [syncChanged, setSyncChanged] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [pushRefusedReason, setPushRefusedReason] = useState<files_yjs_PushRefusalReason | null>(null);
	const lastStatusRef = useRef<ReturnType<files_yjs_Provider["getStatus"]>>("loading");

	// Keep a save warning while this file gets a new provider.
	const persistentPushRefusalReasonRef = useRef<files_yjs_PushRefusalReason | null>(null);
	const onDestroyRef = useRef<() => void>(null);

	// This cleanup closes the provider created by the previous effect.
	// Read the latest access before deciding whether to drop its edits.
	const getLatestAccess = useEffectEvent(() => ({ nodeId, editable, editBlockReason }));

	useEffect(() => {
		// The warning belongs to one file. Do not show it after opening another file.
		persistentPushRefusalReasonRef.current = null;
		setPushRefusedReason(null);
	}, [nodeId]);

	// Create a new Y.Doc when access changes. A Yjs sync cannot remove unsaved
	// edits from the current Y.Doc.
	useEffect(() => {
		setYjsProvider(undefined);
		setProviderNodeId(undefined);
		setSyncStatus("loading");
		setSyncChanged(false);
		lastStatusRef.current = "loading";

		// Wait one task. In development, React runs this effect twice and cleans up
		// the first run.
		const reactStrictWorkaroundTimer = setTimeout(() => {
			const yjsProvider = new files_yjs_Provider({
				nodeId: nodeId,
				membershipId: membershipId,
				presenceStore: presenceStore,
				editable,
			});

			setYjsProvider(yjsProvider);
			setProviderNodeId(nodeId);

			function handleStatus() {
				const status = yjsProvider.getStatus();
				setSyncStatus(status);
				if (lastStatusRef.current !== status) {
					setSyncChanged(true);
					lastStatusRef.current = status;
				}
			}

			handleStatus();
			yjsProvider.on("status", handleStatus);

			function handleLoadFailed(failed: boolean) {
				setLoadFailed(failed);
			}

			setLoadFailed(yjsProvider.loadFailed);
			yjsProvider.on("loadFailed", handleLoadFailed);

			function handlePushRefused(reason: files_yjs_PushRefusalReason | null, persistent = false) {
				// Keep access warnings while this hook replaces the provider.
				if (persistent && reason) {
					persistentPushRefusalReasonRef.current = reason;
				}
				setPushRefusedReason(persistentPushRefusalReasonRef.current ?? reason);
			}

			// The event may fire before this listener is ready. Read the current reason too.
			setPushRefusedReason(persistentPushRefusalReasonRef.current ?? yjsProvider.pushRefusedReason);
			yjsProvider.on("pushRefused", handlePushRefused);

			const unregisterQaProvider = app_qa_register_files_yjs_provider(yjsProvider);

			onDestroyRef.current = () => {
				const latestAccess = getLatestAccess();
				if (latestAccess.nodeId === nodeId && latestAccess.editable !== editable) {
					// Clear queued edits before `destroy()` can send them after the file locks or
					// the user loses write permission.
					yjsProvider.dropPendingUpdatesForAccessChange(latestAccess);
				}

				yjsProvider.off("status", handleStatus);
				yjsProvider.off("loadFailed", handleLoadFailed);
				yjsProvider.off("pushRefused", handlePushRefused);
				unregisterQaProvider();
				yjsProvider.destroy();
			};
		});

		return () => {
			clearTimeout(reactStrictWorkaroundTimer);
			onDestroyRef.current?.();
		};
	}, [editable, membershipId, nodeId, presenceStore]);

	return yjsProvider && providerNodeId
		? {
				yjsProvider,
				providerNodeId,
				syncStatus,
				syncChanged,
				loadFailed,
				pushRefusedReason,
			}
		: undefined;
}
