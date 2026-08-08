import { useEffect, useRef, useState } from "react";
import { files_yjs_Provider } from "@/lib/files-yjs-provider.ts";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Id } from "../lib/app-convex-client.ts";

export type useFilesYjs_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	presenceStore: files_PresenceStore;
};

export function useFilesYjs(props: useFilesYjs_Props) {
	const { nodeId, membershipId, presenceStore } = props;

	const [yjsProvider, setYjsProvider] = useState<files_yjs_Provider | undefined>(undefined);
	const [providerNodeId, setProviderNodeId] = useState<app_convex_Id<"files_nodes"> | undefined>(undefined);
	const [syncStatus, setSyncStatus] = useState<ReturnType<files_yjs_Provider["getStatus"]>>("loading");
	const [syncChanged, setSyncChanged] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const lastStatusRef = useRef<ReturnType<files_yjs_Provider["getStatus"]>>("loading");

	const onDestroyRef = useRef<() => void>(null);

	useEffect(() => {
		// setYjsProvider(undefined);
		// setProviderNodeId(undefined);
		// setSyncStatus("loading");
		// setSyncChanged(false);
		// lastStatusRef.current = "loading";

		const reactStrictWorkaroundTimer = setTimeout(() => {
			const yjsProvider = new files_yjs_Provider({
				nodeId: nodeId,
				membershipId: membershipId,
				presenceStore: presenceStore,
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

			onDestroyRef.current = () => {
				yjsProvider.off("status", handleStatus);
				yjsProvider.off("loadFailed", handleLoadFailed);
				yjsProvider.destroy();
			};
		});

		return () => {
			clearTimeout(reactStrictWorkaroundTimer);
			onDestroyRef.current?.();
		};
	}, [membershipId, nodeId, presenceStore]);

	return yjsProvider && providerNodeId
		? {
				yjsProvider,
				providerNodeId,
				syncStatus,
				syncChanged,
				loadFailed,
			}
		: undefined;
}
