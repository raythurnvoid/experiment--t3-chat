import { useEffect, useRef, useState } from "react";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";
import type { pages_PresenceStore } from "@/lib/pages.ts";
import type { app_convex_Id } from "../lib/app-convex-client.ts";

export type pages_Yjs = {
	yjsProvider: LiveblocksYjsProvider;
	providerPageId: app_convex_Id<"pages">;
	syncStatus: ReturnType<LiveblocksYjsProvider["getStatus"]>;
	syncChanged: boolean;
};

export type pages_Yjs_Props = {
	pageId: app_convex_Id<"pages">;
	membershipId: app_convex_Id<"workspaces_projects_users">;
	presenceStore: pages_PresenceStore;
};

export function usePagesYjs(props: pages_Yjs_Props) {
	const { pageId, membershipId, presenceStore } = props;

	const [yjsProvider, setYjsProvider] = useState<LiveblocksYjsProvider | undefined>(undefined);
	const [providerPageId, setProviderPageId] = useState<app_convex_Id<"pages"> | undefined>(undefined);
	const [syncStatus, setSyncStatus] = useState<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");
	const [syncChanged, setSyncChanged] = useState(false);
	const lastStatusRef = useRef<ReturnType<LiveblocksYjsProvider["getStatus"]>>("loading");

	const onDestroyRef = useRef<() => void>(null);

	useEffect(() => {
		// setYjsProvider(undefined);
		// setProviderPageId(undefined);
		// setSyncStatus("loading");
		// setSyncChanged(false);
		// lastStatusRef.current = "loading";

		const reactStrictWorkaroundTimer = setTimeout(() => {
			const yjsProvider = new LiveblocksYjsProvider({
				pageId: pageId,
				membershipId: membershipId,
				presenceStore: presenceStore,
			});

			setYjsProvider(yjsProvider);
			setProviderPageId(pageId);

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
	}, [membershipId, pageId, presenceStore]);

	return yjsProvider && providerPageId
		? {
				yjsProvider,
				providerPageId,
				syncStatus,
				syncChanged,
			}
		: undefined;
}
