import { useEffect, useRef, useState } from "react";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";
import type { files_PresenceStore } from "@/lib/files.ts";
import type { app_convex_Id } from "../lib/app-convex-client.ts";

export type files_Yjs = {
	yjsProvider: LiveblocksYjsProvider;
	providerNodeId: app_convex_Id<"files_nodes">;
	syncStatus: ReturnType<LiveblocksYjsProvider["getStatus"]>;
	syncChanged: boolean;
};

export type files_Yjs_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	presenceStore: files_PresenceStore;
};

export function useFilesYjs(props: files_Yjs_Props) {
	const { nodeId, membershipId, presenceStore } = props;

	const [yjsProvider, setYjsProvider] = useState<LiveblocksYjsProvider | undefined>(undefined);
	const [providerNodeId, setProviderNodeId] = useState<app_convex_Id<"files_nodes"> | undefined>(undefined);
	const [syncStatus, setSyncStatus] = useState<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");
	const [syncChanged, setSyncChanged] = useState(false);
	const lastStatusRef = useRef<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");

	const onDestroyRef = useRef<() => void>(null);

	useEffect(() => {
		// setYjsProvider(undefined);
		// setProviderNodeId(undefined);
		// setSyncStatus("loading");
		// setSyncChanged(false);
		// lastStatusRef.current = "loading";

		const reactStrictWorkaroundTimer = setTimeout(() => {
			const yjsProvider = new LiveblocksYjsProvider({
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

			onDestroyRef.current = () => {
				yjsProvider.off("status", handleStatus);
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
			}
		: undefined;
}
