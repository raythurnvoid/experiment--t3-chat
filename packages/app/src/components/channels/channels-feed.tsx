import "./channels-feed.css";
import { memo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { ChannelsMessageContent } from "./channels-message.tsx";
import type { ChannelsMessage } from "./channels-message-window.ts";
import { useChannelsDirectName, useChannelsPeople, type ChannelsPerson } from "./channels-people.ts";

type ChannelsFeedMessage_ClassNames =
	| "ChannelsFeedMessage"
	| "ChannelsFeedMessage-header"
	| "ChannelsFeedMessage-preview"
	| "ChannelsFeedMessage-meta";
type ChannelsFeedMessage_CustomAttributes = { "data-message-id": string; "data-unread": string };

export const ChannelsFeedMessage = memo(function ChannelsFeedMessage(props: {
	row: ChannelsMessage;
	people: readonly ChannelsPerson[];
	unread?: boolean;
	label?: string;
	threadRootId?: app_convex_Id<"channels_messages"> | null;
	onOpen?: () => void;
	children?: ReactNode;
}) {
	const { row, people, unread = false, label, threadRootId, onOpen, children } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const channel = useQuery(app_convex_api.channels.get_channel, { membershipId, channelId: row.message.channelId });
	const directName = useChannelsDirectName(
		channel?.channel.kind === "direct" ? channel.channel.participantUserIds.filter((id) => id !== userId) : [],
		people,
	);
	if (channel === null) return null;
	if (channel === undefined) return <p>Loading channel…</p>;
	const name =
		channel.channel.kind === "direct"
			? directName
			: channel.channel.kind === "file"
				? channel.file!.path
				: `#${channel.channel.name}`;
	const root =
		threadRootId ??
		row.message.threadRootId ??
		(channel.channel.kind === "file" ||
		((channel.channel.kind === "public" || channel.channel.kind === "private") && channel.channel.layout === "posts")
			? row.message._id
			: undefined);
	return (
		<article
			className={"ChannelsFeedMessage" satisfies ChannelsFeedMessage_ClassNames}
			{...({
				"data-message-id": row.message._id,
				"data-unread": String(unread),
			} satisfies ChannelsFeedMessage_CustomAttributes)}
		>
			<header className={"ChannelsFeedMessage-header" satisfies ChannelsFeedMessage_ClassNames}>
				<strong>{name}</strong>
				{label && <span>{label}</span>}
				{unread && <strong>New</strong>}
				<Link
					to="/w/$organizationName/$workspaceName/messages/$channelId"
					params={{ organizationName, workspaceName, channelId: row.message.channelId }}
					search={{ message: row.message._id, thread: root }}
					onClick={onOpen}
				>
					Open context
				</Link>
			</header>
			<p className={"ChannelsFeedMessage-meta" satisfies ChannelsFeedMessage_ClassNames}>
				{row.authorName} ·{" "}
				<time
					dateTime={new Date(row.message._creationTime).toISOString()}
					title={new Date(row.message._creationTime).toLocaleString()}
				>
					{format_relative_time(row.message._creationTime)}
				</time>
			</p>
			<div
				className={cn(
					"ChannelsFeedMessage-preview" satisfies ChannelsFeedMessage_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
			>
				<ChannelsMessageContent row={row} />
			</div>
			{children}
		</article>
	);
});

type ChannelsActivity_ClassNames = "ChannelsActivity" | "ChannelsActivity-list";
type ChannelsActivity_CustomAttributes = { "data-compact": string };

export const ChannelsActivity = memo(function ChannelsActivity(props: { compact?: boolean; onOpen?: () => void }) {
	const { compact = false, onOpen } = props;
	const { inbox, inboxUnreadCount, inboxHasMore } = AppChannelsProvider.useContext();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const { people } = useChannelsPeople();
	return (
		<section
			className={cn(
				"ChannelsActivity" satisfies ChannelsActivity_ClassNames,
				!compact && ("app-scrollable" satisfies AppClassName),
			)}
			aria-label={compact ? "Message activity" : "Activity"}
			{...({ "data-compact": String(compact) } satisfies ChannelsActivity_CustomAttributes)}
		>
			{compact ? <h2>Messages</h2> : <h1>Activity</h1>}
			<p title="This count covers loaded inbox items">
				Unread in loaded items: {inboxUnreadCount}
				{inboxHasMore ? "+" : ""}
			</p>
			{compact && (
				<Link
					to="/w/$organizationName/$workspaceName/messages/activity"
					params={{ organizationName, workspaceName }}
					onClick={onOpen}
				>
					View Activity
				</Link>
			)}
			<div className={"ChannelsActivity-list" satisfies ChannelsActivity_ClassNames}>
				{inbox.results.map((entry) => (
					<ChannelsFeedMessage
						key={entry.item._id}
						row={entry.message}
						people={people}
						label={entry.item.kind === "mention" ? "Mention" : "Reply"}
						unread={entry.unread}
						threadRootId={entry.item.threadRootId}
						onOpen={onOpen}
					/>
				))}
			</div>
			{inbox.status === "LoadingFirstPage" ? (
				<p>Loading activity…</p>
			) : inbox.results.length === 0 ? (
				<p>No activity in this page</p>
			) : null}
			{inbox.status === "CanLoadMore" && <MyButton onClick={() => inbox.loadMore(50)}>Load more activity</MyButton>}
			{inbox.status === "LoadingMore" && <p>Loading more activity…</p>}
		</section>
	);
});

type ChannelsThreads_ClassNames = "ChannelsThreads" | "ChannelsThreads-list";

export const ChannelsThreads = memo(function ChannelsThreads() {
	const { threads, threadsUnreadCount, threadsHasMore } = AppChannelsProvider.useContext();
	const { people } = useChannelsPeople();
	return (
		<section
			className={cn("ChannelsThreads" satisfies ChannelsThreads_ClassNames, "app-scrollable" satisfies AppClassName)}
			aria-label="Followed threads"
		>
			<h1>Threads</h1>
			<p title="This count covers loaded followed threads">
				Unread in loaded threads: {threadsUnreadCount}
				{threadsHasMore ? "+" : ""}
			</p>
			<div className={"ChannelsThreads-list" satisfies ChannelsThreads_ClassNames}>
				{threads.results.map((entry) => (
					<ChannelsFeedMessage
						key={entry.follower._id}
						row={entry.root}
						people={people}
						unread={entry.unread}
						threadRootId={entry.root.message._id}
					>
						{entry.root.thread!.title && <h2>{entry.root.thread!.title}</h2>}
						<p>
							{entry.root.thread!.replyCount} replies
							{entry.root.thread!.lastReplySequence > entry.follower.readReplySequence
								? ` · ${entry.root.thread!.lastReplySequence - entry.follower.readReplySequence} new replies`
								: ""}
							{entry.follower.pendingRootMention ? " · New mention" : ""}
						</p>
					</ChannelsFeedMessage>
				))}
			</div>
			{threads.status === "LoadingFirstPage" ? (
				<p>Loading threads…</p>
			) : threads.results.length === 0 ? (
				<p>No followed threads in this page</p>
			) : null}
			{threads.status === "CanLoadMore" && <MyButton onClick={() => threads.loadMore(50)}>Load more threads</MyButton>}
			{threads.status === "LoadingMore" && <p>Loading more threads…</p>}
		</section>
	);
});
