import { createContext, memo, use, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import { useRouter, type HistoryState, type ParsedLocation } from "@tanstack/react-router";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex_api,
	app_convex_is_id_like,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";

export type ChannelsNavigationMode = "open" | "passive" | "alreadyOpened";

declare module "@tanstack/react-router" {
	interface HistoryState {
		messagesNavigation?: { nonce: string; mode: ChannelsNavigationMode };
	}
}

// eslint-disable-next-line react-refresh/only-export-components
export function channels_navigation_state(mode: ChannelsNavigationMode = "open"): HistoryState {
	return { messagesNavigation: { nonce: crypto.randomUUID(), mode } };
}

type ChannelNavigation = {
	serial: number;
	channelId: string;
	key: string | undefined;
	href: string;
	committed: boolean;
};
type ChannelsSummary = app_convex_FunctionReturnType<typeof app_convex_api.channels_notifications.get_summary>;

const AppChannelsContext = createContext<{
	summary: ChannelsSummary | Error | undefined;
	status: "loading" | "unavailable" | "updating" | "delayed" | "error";
	accessScopeKey: string | null;
	unreadMentions: number | null;
	inboxUnreadCount: number | null;
	threadsUnreadCount: number | null;
	navigation: ChannelNavigation | null;
	consumeNavigation: (channelId: string) => boolean;
	cancelNavigation: (channelId: string) => void;
	followLink: (event: MouseEvent<HTMLAnchorElement>) => void;
	retrySummary: () => void;
} | null>(null);

const AppChannelsProvider = Object.assign(
	memo(function AppChannelsProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const router = useRouter();
		const [retrying, setRetrying] = useState(false);
		const queries = useMemo(() => {
			const result: RequestForQueries = {};
			if (!retrying)
				result.summary = { query: app_convex_api.channels_notifications.get_summary, args: { membershipId } };
			return result;
		}, [membershipId, retrying]);
		const summary = useQueries(queries).summary as ChannelsSummary | Error | undefined;
		const status =
			summary instanceof Error
				? "error"
				: summary === undefined
					? "loading"
					: summary === null
						? "unavailable"
						: summary.state;
		const ready = summary && !(summary instanceof Error) && summary.state === "delayed" ? summary : null;
		const accessScopeKey = summary && !(summary instanceof Error) ? summary.accessScopeKey : null;
		const [navigation, setNavigation] = useState<ChannelNavigation | null>(null);
		const pending = useRef<ChannelNavigation | null>(null);
		const serial = useRef(0);
		const arrived = useRef(false);
		const consumeNavigation = useFn((channelId: string) => {
			if (pending.current?.channelId !== channelId || !pending.current.committed) return false;
			pending.current = null;
			setNavigation(null);
			return true;
		});
		const cancelNavigation = useFn((channelId: string) => {
			if (pending.current?.channelId !== channelId) return;
			pending.current = null;
			setNavigation(null);
		});
		const followLink = useFn((event: MouseEvent<HTMLAnchorElement>) => {
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey ||
				event.currentTarget.target === "_blank"
			)
				return;
			const href = event.currentTarget.getAttribute("href");
			if (!href) return;
			event.preventDefault();
			void router
				.navigate({ href, state: channels_navigation_state() })
				.catch((error: unknown) => console.error("[AppChannelsProvider] Could not open conversation", { error }));
		});
		const retrySummary = useFn(() => setRetrying(true));

		useEffect(() => {
			if (!retrying) return;
			const timer = setTimeout(() => setRetrying(false), 0);
			return () => clearTimeout(timer);
		}, [retrying]);
		useEffect(() => {
			const record = (
				location: { pathname: string; href: string; state: ParsedLocation["state"] },
				suppress: boolean,
			) => {
				const channelId = /\/messages\/([^/]+)\/?$/.exec(location.pathname)?.[1];
				pending.current =
					channelId && app_convex_is_id_like(channelId) && !suppress
						? {
								serial: ++serial.current,
								channelId,
								key: location.state.__TSR_key,
								href: location.href,
								committed: false,
							}
						: null;
				setNavigation(pending.current);
			};
			const confirm = (location: ParsedLocation) => {
				const intent = pending.current;
				if (!intent || intent.key !== location.state.__TSR_key || intent.href !== location.href) return;
				pending.current = { ...intent, committed: true };
				setNavigation(pending.current);
			};
			const unsubscribeHistory = router.history.subscribe(({ location, action }) => {
				const mode = location.state.messagesNavigation?.mode;
				// Back and Forward are new choices, even when the original entry was passive.
				record(
					location,
					(action.type === "PUSH" || action.type === "REPLACE") && (mode === "passive" || mode === "alreadyOpened"),
				);
			});
			// Loads and invalidations can resolve too. Only a recorded navigation may open a DM.
			const unsubscribeResolved = router.subscribe("onResolved", ({ toLocation }) => confirm(toLocation));
			if (!arrived.current) {
				arrived.current = true;
				record(router.state.location, false);
				if (router.state.resolvedLocation) confirm(router.state.resolvedLocation);
			}
			return () => {
				unsubscribeHistory();
				unsubscribeResolved();
			};
		}, [router]);
		useEffect(() => {
			document.title =
				status === "updating"
					? "Bonobo Senate — Messages updating"
					: ready?.mentionChannels
						? `(${ready.mentionChannels}) Bonobo Senate`
						: "Bonobo Senate";
			return () => {
				document.title = "Bonobo Senate";
			};
		}, [status, ready?.mentionChannels]);

		return (
			<AppChannelsContext.Provider
				value={{
					summary,
					status,
					accessScopeKey,
					unreadMentions: ready?.mentionChannels ?? null,
					inboxUnreadCount: ready?.unreadInbox ?? null,
					threadsUnreadCount: ready?.unreadThreads ?? null,
					navigation,
					consumeNavigation,
					cancelNavigation,
					followLink,
					retrySummary,
				}}
			>
				{children}
			</AppChannelsContext.Provider>
		);
	}),
	{
		useContext() {
			const value = use(AppChannelsContext);
			if (!value) throw new Error("AppChannelsProvider.useContext must be used within AppChannelsProvider");
			return value;
		},
	},
);

export { AppChannelsProvider };
