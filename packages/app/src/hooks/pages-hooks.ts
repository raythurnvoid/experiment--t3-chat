import { useEffect, useRef, useState } from "react";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "../lib/app-convex-client.ts";

export type pages_Yjs = {
	yjsProvider: LiveblocksYjsProvider;
	syncStatus: ReturnType<LiveblocksYjsProvider["getStatus"]>;
	syncChanged: boolean;
};

export type pages_Yjs_Props = {
	pageId: app_convex_Id<"pages">;
	workspaceId: string;
	projectId: string;
	presenceStore: pages_PresenceStore;
};

export function usePagesYjs(props: pages_Yjs_Props) {
	const { pageId, workspaceId, projectId, presenceStore } = props;

	const [yjsProvider, setYjsProvider] = useState<LiveblocksYjsProvider | undefined>(undefined);
	const [syncStatus, setSyncStatus] = useState<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");
	const [syncChanged, setSyncChanged] = useState(false);
	const lastStatusRef = useRef<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");

	const onDestroyRef = useRef<() => void>(null);

	useEffect(() => {
		const reactStrictWorkaroundTimer = setTimeout(() => {
			const yjsProvider = new LiveblocksYjsProvider({
				pageId: pageId,
				presenceStore: presenceStore,
				workspaceId: workspaceId,
				projectId: projectId,
			});

			setYjsProvider(yjsProvider);

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
	}, [pageId, workspaceId, projectId, presenceStore]);

	return yjsProvider ? { yjsProvider, syncStatus, syncChanged } : undefined;
}
