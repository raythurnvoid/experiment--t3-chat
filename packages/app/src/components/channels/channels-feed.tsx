import "./channels-feed.css";
import { memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { CatchBoundary, Link, type ErrorComponentProps } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { toast } from "sonner";
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
import { useChannelsDirectName } from "./channels-people.ts";

type ChannelsFeedMessage_ClassNames =
	| "ChannelsFeedMessage"
	| "ChannelsFeedMessage-header"
	| "ChannelsFeedMessage-preview"
	| "ChannelsFeedMessage-meta";
type ChannelsFeedMessage_CustomAttributes = { "data-message-id": string; "data-unread": string };

export const ChannelsFeedMessage = memo(function ChannelsFeedMessage(props: {
	row: ChannelsMessage;
	unread?: boolean;
	label?: string;
	threadRootId?: app_convex_Id<"channels_messages"> | null;
	onOpen?: () => void;
	children?: ReactNode;
}) {
	const { row, unread = false, label, threadRootId, onOpen, children } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const { followLink } = AppChannelsProvider.useContext();
	const channel = useQuery(app_convex_api.channels.get_channel, { membershipId, channelId: row.message.channelId });
	const directName = useChannelsDirectName(
		channel?.channel.kind === "direct" ? channel.channel.participantUserIds.filter((id) => id !== userId) : [],
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
				{unread && (
					<span className="ChannelsFeedMessage-unread" title="Unread">
						●
					</span>
				)}
				<Link
					to="/w/$organizationName/$workspaceName/messages/$channelId"
					params={{ organizationName, workspaceName, channelId: row.message.channelId }}
					search={{ message: row.message._id, thread: root }}
					onClick={(event) => {
						followLink(event);
						onOpen?.();
					}}
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

const ChannelsFeedError = memo(function ChannelsFeedError(props: ErrorComponentProps) {
	return (
		<div role="alert">
			<p>Could not load Messages</p>
			<MyButton onClick={props.reset}>Retry</MyButton>
		</div>
	);
});

export const ChannelsActivity = memo(function ChannelsActivity() {
	const { membershipId } = AppTenantProvider.useContext();
	return (
		<CatchBoundary getResetKey={() => membershipId} errorComponent={ChannelsFeedError}>
			<ChannelsActivityPage />
		</CatchBoundary>
	);
});

const ChannelsActivityPage = memo(function ChannelsActivityPage() {
	const { inboxUnreadCount, status } = AppChannelsProvider.useContext();
	const { membershipId } = AppTenantProvider.useContext();
	const inbox = usePaginatedQuery(
		app_convex_api.channels_messages.list_my_inbox,
		{ membershipId },
		{ initialNumItems: 50 },
	);
	const focus = useFeedFocus();

	return (
		<section
			{...focus}
			tabIndex={-1}
			className={cn("ChannelsActivity" satisfies ChannelsActivity_ClassNames, "app-scrollable" satisfies AppClassName)}
			aria-label="Activity"
		>
			<p data-messages-status={status}>
				{inboxUnreadCount !== null
					? `Unread: ${inboxUnreadCount} · Counts may be delayed`
					: status === "updating"
						? "Messages Updating…"
						: status === "error"
							? "Could not load Messages counts"
							: status === "unavailable"
								? "Messages unavailable"
								: "Loading Messages counts…"}
			</p>
			<div className={"ChannelsActivity-list" satisfies ChannelsActivity_ClassNames}>
				{inbox.results.map((entry) => (
					<div
						key={entry.state === "readable" ? entry.item._id : entry.inboxId}
						data-feed-row={entry.state === "readable" ? entry.item._id : entry.inboxId}
					>
						{entry.state === "readable" ? (
							<ChannelsFeedMessage
								key={entry.item._id}
								row={entry.message}
								label={entry.item.kind === "mention" ? "Mention" : "Reply"}
								unread={entry.unread}
								threadRootId={entry.item.threadRootId}
							/>
						) : (
							<article key={entry.inboxId} data-inbox-id={entry.inboxId} data-channel-access={entry.state}>
								<MyButton
									onClick={() => toast.error(entry.state === "locked" ? "Permission denied" : "Message unavailable")}
								>
									{entry.state === "locked" ? "No access" : "Unavailable"}
								</MyButton>
							</article>
						)}
					</div>
				))}
			</div>
			{inbox.status === "LoadingFirstPage" ? (
				<p>Loading activity…</p>
			) : inbox.results.length === 0 ? (
				<p>No activity in this page</p>
			) : null}
			{(inbox.status === "CanLoadMore" || inbox.status === "LoadingMore") && (
				<MyButton
					aria-disabled={inbox.status === "LoadingMore"}
					aria-busy={inbox.status === "LoadingMore"}
					onClick={() => {
						if (inbox.status === "CanLoadMore") inbox.loadMore(50);
					}}
				>
					{inbox.status === "LoadingMore" ? "Loading…" : "Show more activity"}
				</MyButton>
			)}
		</section>
	);
});

type ChannelsThreads_ClassNames = "ChannelsThreads" | "ChannelsThreads-list";

export const ChannelsThreads = memo(function ChannelsThreads() {
	const { membershipId } = AppTenantProvider.useContext();
	return (
		<CatchBoundary getResetKey={() => membershipId} errorComponent={ChannelsFeedError}>
			<ChannelsThreadsPage />
		</CatchBoundary>
	);
});

const ChannelsThreadsPage = memo(function ChannelsThreadsPage() {
	const { threadsUnreadCount, status } = AppChannelsProvider.useContext();
	const { membershipId } = AppTenantProvider.useContext();
	const threads = usePaginatedQuery(
		app_convex_api.channels_messages.list_my_threads,
		{ membershipId },
		{ initialNumItems: 50 },
	);
	const focus = useFeedFocus();
	return (
		<section
			{...focus}
			tabIndex={-1}
			className={cn("ChannelsThreads" satisfies ChannelsThreads_ClassNames, "app-scrollable" satisfies AppClassName)}
			aria-label="Followed threads"
		>
			<p data-messages-status={status}>
				{threadsUnreadCount !== null
					? `Unread threads: ${threadsUnreadCount} · Counts may be delayed`
					: status === "updating"
						? "Messages Updating…"
						: status === "error"
							? "Could not load Messages counts"
							: status === "unavailable"
								? "Messages unavailable"
								: "Loading Messages counts…"}
			</p>
			<div className={"ChannelsThreads-list" satisfies ChannelsThreads_ClassNames}>
				{threads.results.map((entry) => (
					<div
						key={entry.state === "readable" ? entry.follower._id : entry.followerId}
						data-feed-row={entry.state === "readable" ? entry.follower._id : entry.followerId}
					>
						{entry.state === "readable" ? (
							<ChannelsFeedMessage
								key={entry.follower._id}
								row={entry.root}
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
									{entry.follower.following ? " · Following" : ""}
									{entry.root.thread!.isResolved ? " · Resolved" : ""}
								</p>
							</ChannelsFeedMessage>
						) : (
							<article key={entry.followerId} data-follower-id={entry.followerId} data-channel-access={entry.state}>
								<MyButton
									onClick={() => toast.error(entry.state === "locked" ? "Permission denied" : "Thread unavailable")}
								>
									{entry.state === "locked" ? "No access" : "Unavailable"}
								</MyButton>
							</article>
						)}
					</div>
				))}
			</div>
			{threads.status === "LoadingFirstPage" ? (
				<p>Loading threads…</p>
			) : threads.results.length === 0 ? (
				<p>No followed threads in this page</p>
			) : null}
			{(threads.status === "CanLoadMore" || threads.status === "LoadingMore") && (
				<MyButton
					aria-disabled={threads.status === "LoadingMore"}
					aria-busy={threads.status === "LoadingMore"}
					onClick={() => {
						if (threads.status === "CanLoadMore") threads.loadMore(50);
					}}
				>
					{threads.status === "LoadingMore" ? "Loading…" : "Show more threads"}
				</MyButton>
			)}
		</section>
	);
});

function useFeedFocus() {
	const ref = useRef<HTMLElement>(null);
	const focused = useRef<{ element: HTMLElement; id: string | undefined; index: number } | null>(null);
	useLayoutEffect(() => {
		const previous = focused.current;
		if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
		const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-feed-row]") ?? []);
		const row =
			rows.find((element) => element.dataset.feedRow === previous.id) ??
			rows[previous.id ? Math.min(previous.index, rows.length - 1) : rows.length - 1];
		(row?.querySelector<HTMLElement>("a, button") ?? ref.current)?.focus();
	});
	return {
		ref,
		onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
			const row = event.target.closest<HTMLElement>("[data-feed-row]");
			focused.current = {
				element: event.target,
				id: row?.dataset.feedRow,
				index: Array.from(ref.current?.querySelectorAll("[data-feed-row]") ?? []).indexOf(row!),
			};
		},
	};
}
