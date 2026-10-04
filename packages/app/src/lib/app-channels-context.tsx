import { createContext, memo, use, useEffect, useMemo, type ContextType, type ReactNode } from "react";
import { usePaginatedQuery, useQueries, type UsePaginatedQueryReturnType } from "convex/react";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";

const AppChannelsContext = createContext<{
	channelList: UsePaginatedQueryReturnType<typeof app_convex_api.channels.list_my_channels>;
	states: Record<
		string,
		app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel_state> | Error | undefined
	>;
	inbox: UsePaginatedQueryReturnType<typeof app_convex_api.channels_messages.list_my_inbox>;
	threads: UsePaginatedQueryReturnType<typeof app_convex_api.channels_messages.list_my_threads>;
	unreadMentions: number;
	inboxUnreadCount: number;
	threadsUnreadCount: number;
	inboxHasMore: boolean;
	threadsHasMore: boolean;
} | null>(null);

const AppChannelsProvider = Object.assign(
	memo(function AppChannelsProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const channelList = usePaginatedQuery(
			app_convex_api.channels.list_my_channels,
			{ membershipId },
			{ initialNumItems: 50 },
		);
		const inbox = usePaginatedQuery(
			app_convex_api.channels_messages.list_my_inbox,
			{ membershipId },
			{ initialNumItems: 50 },
		);
		const threads = usePaginatedQuery(
			app_convex_api.channels_messages.list_my_threads,
			{ membershipId },
			{ initialNumItems: 50 },
		);
		const queries = useMemo(
			() =>
				Object.fromEntries(
					channelList.results.map((channel) => [
						channel._id,
						{
							query: app_convex_api.channels.get_channel_state,
							args: { membershipId, channelId: channel._id },
						},
					]),
				),
			[channelList.results, membershipId],
		);
		const states = useQueries(queries) as NonNullable<ContextType<typeof AppChannelsContext>>["states"];
		const unreadMentions = Object.values(states).filter(
			(value) => value && !(value instanceof Error) && value.mentionCount > 0,
		).length;
		const inboxUnreadCount = inbox.results.filter((item) => item.unread).length;
		const threadsUnreadCount = threads.results.filter((item) => item.unread).length;
		const inboxHasMore = inbox.status === "CanLoadMore" || inbox.status === "LoadingMore";
		const threadsHasMore = threads.status === "CanLoadMore" || threads.status === "LoadingMore";

		useEffect(() => {
			if (channelList.status === "CanLoadMore") channelList.loadMore(50);
		}, [channelList.status, channelList.loadMore]);
		useEffect(() => {
			document.title = unreadMentions ? `(${unreadMentions}) Press` : "Press";
			return () => {
				document.title = "Press";
			};
		}, [unreadMentions]);

		return (
			<AppChannelsContext.Provider
				value={{
					channelList,
					states,
					inbox,
					threads,
					unreadMentions,
					inboxUnreadCount,
					threadsUnreadCount,
					inboxHasMore,
					threadsHasMore,
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
