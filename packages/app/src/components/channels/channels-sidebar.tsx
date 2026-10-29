import "./channels-sidebar.css";
import { memo, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
	Bell,
	ChevronDown,
	ChevronRight,
	FileText,
	Hash,
	Lock,
	MessageCircle,
	MoreHorizontal,
	PanelLeftClose,
	Plus,
	Search,
	Star,
} from "lucide-react";
import { CatchBoundary, Link, type ErrorComponentProps } from "@tanstack/react-router";
import { toast } from "sonner";
import {
	app_convex,
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionArgs,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyMenu, MyMenuItem, MyMenuPopover, MyMenuTrigger } from "@/components/my-menu.tsx";
import {
	MySidebarList,
	MySidebarListItem,
	MySidebarListItemIcon,
	MySidebarListItemPrimaryAction,
	MySidebarListItemPrimaryActionLink,
	MySidebarListItemTitle,
} from "@/components/my-sidebar.tsx";
import { url_path_messages } from "@/lib/urls.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useChannelsDirectName } from "./channels-people.ts";

type ChannelsSidebar_ClassNames =
	| "ChannelsSidebar"
	| "ChannelsSidebar-header"
	| "ChannelsSidebar-section"
	| "ChannelsSidebar-section-header"
	| "ChannelsSidebar-empty";
type ChannelSection = app_convex_FunctionArgs<typeof app_convex_api.channels.list_my_channels>["section"];

export const ChannelsSidebar = memo(function ChannelsSidebar(props: {
	channelId: string | undefined;
	collapsed: string[];
	setCollapsed: Dispatch<SetStateAction<string[]>>;
	onClose: () => void;
	onDialog: (dialog: "create" | "direct" | "quick") => void;
	onNavigate: () => void;
}) {
	const { channelId, collapsed, setCollapsed, onClose, onDialog, onNavigate } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { inboxUnreadCount, threadsUnreadCount, status, retrySummary } = AppChannelsProvider.useContext();
	const groups = [
		{
			title: "Starred",
			section: "starred" as const,
			action: null,
		},
		{
			title: "Channels",
			section: "channels" as const,
			action: "create" as const,
		},
		{
			title: "Direct messages",
			section: "direct" as const,
			action: "direct" as const,
		},
		{ title: "Files", section: "files" as const, action: null },
	];
	return (
		<aside aria-label="Channels" className={"ChannelsSidebar" satisfies ChannelsSidebar_ClassNames}>
			<header className={"ChannelsSidebar-header" satisfies ChannelsSidebar_ClassNames}>
				<h1>Messages</h1>
				<MyMenu>
					<MyMenuTrigger>
						<MyIconButton tooltip="New conversation">
							<Plus />
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover aria-label="New conversation">
						<MyMenuItem onClick={() => requestAnimationFrame(() => onDialog("create"))}>Create channel</MyMenuItem>
						<MyMenuItem onClick={() => requestAnimationFrame(() => onDialog("direct"))}>Message someone</MyMenuItem>
					</MyMenuPopover>
				</MyMenu>
				<MyIconButton tooltip="Hide channels" onClick={onClose}>
					<PanelLeftClose />
				</MyIconButton>
			</header>
			<div className={cn("ChannelsSidebar-content", "app-scrollable" satisfies AppClassName)}>
				<MyButton variant="ghost-highlightable" onClick={() => onDialog("quick")}>
					<Search size={16} />
					Find a channel <kbd>Ctrl+K</kbd>
				</MyButton>
				<Link
					to="/w/$organizationName/$workspaceName/messages/activity"
					params={{ organizationName, workspaceName }}
					onClick={onNavigate}
					activeProps={{ "aria-current": "page" }}
					aria-label="Activity"
				>
					<Bell size={16} />
					<span>Activity</span>
					{inboxUnreadCount !== null && inboxUnreadCount > 0 && (
						<span className="ChannelsSidebarRow-count" title="Counts may be delayed">
							{inboxUnreadCount}
						</span>
					)}
				</Link>
				<Link
					to="/w/$organizationName/$workspaceName/messages/threads"
					params={{ organizationName, workspaceName }}
					onClick={onNavigate}
					activeProps={{ "aria-current": "page" }}
					aria-label="Threads"
				>
					<MessageCircle size={16} />
					<span>Threads</span>
					{threadsUnreadCount !== null && threadsUnreadCount > 0 && (
						<span className="ChannelsSidebarRow-count" title="Counts may be delayed">
							{threadsUnreadCount}
						</span>
					)}
				</Link>
				<Link
					to="/w/$organizationName/$workspaceName/messages/search"
					params={{ organizationName, workspaceName }}
					onClick={onNavigate}
					activeProps={{ "aria-current": "page" }}
				>
					<Search size={16} />
					<span>Search messages</span>
				</Link>
				<p data-messages-status={status}>
					{status === "delayed"
						? "Counts may be delayed"
						: status === "updating"
							? "Messages Updating…"
							: status === "error"
								? "Could not load Messages counts"
								: status === "loading"
									? "Loading Messages…"
									: "Messages unavailable"}
				</p>
				{status === "error" && <MyButton onClick={retrySummary}>Retry counts</MyButton>}
				{groups.map((group) => (
					<section
						key={group.title}
						aria-label={group.title}
						className={"ChannelsSidebar-section" satisfies ChannelsSidebar_ClassNames}
					>
						<div className={"ChannelsSidebar-section-header" satisfies ChannelsSidebar_ClassNames}>
							<MyButton
								variant="ghost"
								aria-expanded={!collapsed.includes(group.title)}
								onClick={() =>
									setCollapsed((previous) =>
										previous.includes(group.title)
											? previous.filter((title) => title !== group.title)
											: [...previous, group.title],
									)
								}
							>
								{collapsed.includes(group.title) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
								{group.title}
							</MyButton>
							{group.action && (
								<MyIconButton
									tooltip={group.action === "create" ? "Create channel" : "Message someone"}
									onClick={() => onDialog(group.action!)}
								>
									<Plus />
								</MyIconButton>
							)}
						</div>
						{!collapsed.includes(group.title) && (
							<CatchBoundary getResetKey={() => `${membershipId}:${group.section}`} errorComponent={SectionError}>
								<ChannelsSidebarPage section={group.section} channelId={channelId} onNavigate={onNavigate} />
							</CatchBoundary>
						)}
					</section>
				))}
				<Link
					to="/w/$organizationName/$workspaceName/messages/browse"
					params={{ organizationName, workspaceName }}
					activeProps={{ "aria-current": "page" }}
					onClick={onNavigate}
				>
					<Hash size={16} />
					<span>Browse channels</span>
				</Link>
			</div>
		</aside>
	);
});

const SectionError = memo(function SectionError(props: ErrorComponentProps) {
	return (
		<div role="alert">
			<p>Could not load conversations.</p>
			<MyButton onClick={props.reset}>Retry</MyButton>
		</div>
	);
});

const ChannelsSidebarPage = memo(function ChannelsSidebarPage(props: {
	section: ChannelSection;
	channelId: string | undefined;
	onNavigate: () => void;
}) {
	const { section, channelId, onNavigate } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [refusedMemberId, setRefusedMemberId] = useState<string | null>(null);
	const channels = usePaginatedQuery(
		app_convex_api.channels.list_my_channels,
		{ membershipId, section },
		{ initialNumItems: 50 },
	);
	const list = useRef<HTMLDivElement>(null);
	const focused = useRef<{ element: HTMLElement; memberId: string | null; index: number } | null>(null);
	useLayoutEffect(() => {
		const previous = focused.current;
		if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
		const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-member-id]") ?? []);
		const row =
			rows.find((element) => element.dataset.memberId === previous.memberId) ??
			rows[previous.memberId ? Math.min(previous.index, rows.length - 1) : rows.length - 1];
		const target =
			row?.querySelector<HTMLElement>("a, button") ??
			list.current?.closest("section")?.querySelector<HTMLElement>("button[aria-expanded]");
		target?.focus();
	}, [channels.results, channels.status]);
	return (
		<div
			ref={list}
			onFocusCapture={(event) => {
				const row = event.target.closest<HTMLElement>("[data-member-id]");
				focused.current = {
					element: event.target,
					memberId: row?.dataset.memberId ?? null,
					index: row ? channels.results.findIndex((entry) => entry.memberId === row.dataset.memberId) : -1,
				};
			}}
		>
			<MySidebarList>
				{channels.results.map((entry) =>
					entry.state === "readable" ? (
						<ChannelsSidebarRow
							key={entry.memberId}
							memberId={entry.memberId}
							channel={entry.channel}
							selected={entry.channel._id === channelId}
							onNavigate={onNavigate}
						/>
					) : (
						<MySidebarListItem
							key={entry.memberId}
							className={"ChannelsSidebarRow" satisfies ChannelsSidebarRow_ClassNames}
							data-member-id={entry.memberId}
							data-channel-access={entry.state}
						>
							<MySidebarListItemPrimaryAction onClick={() => setRefusedMemberId(entry.memberId)}>
								<MySidebarListItemIcon>
									<Lock />
								</MySidebarListItemIcon>
								<MySidebarListItemTitle>
									{entry.state === "locked" ? "No access" : "Unavailable"}
								</MySidebarListItemTitle>
							</MySidebarListItemPrimaryAction>
							{refusedMemberId === entry.memberId && (
								<p role="status">{entry.state === "locked" ? "Permission denied" : "Unavailable"}</p>
							)}
						</MySidebarListItem>
					),
				)}
			</MySidebarList>
			{channels.status === "LoadingFirstPage" ? (
				<p data-loading="true">Loading conversations…</p>
			) : channels.results.length === 0 ? (
				<p>No conversations</p>
			) : null}
			{(channels.status === "CanLoadMore" || channels.status === "LoadingMore") && (
				<MyButton
					aria-label={`Show more ${section === "direct" ? "direct messages" : section}`}
					aria-disabled={channels.status === "LoadingMore"}
					aria-busy={channels.status === "LoadingMore"}
					onClick={() => {
						if (channels.status === "CanLoadMore") channels.loadMore(50);
					}}
				>
					{channels.status === "LoadingMore" ? "Loading…" : "Show more"}
				</MyButton>
			)}
		</div>
	);
});

type ChannelsSidebarRow_ClassNames = "ChannelsSidebarRow" | "ChannelsSidebarRow-count";
type ChannelsSidebarRow_CustomAttributes = {
	"data-channel-id": string;
	"data-channel-kind": string;
	"data-unread": string;
	"data-mention-count": number;
};

const ChannelsSidebarRow = memo(function ChannelsSidebarRow(props: {
	memberId: string;
	channel: app_convex_Doc<"channels">;
	selected: boolean;
	onNavigate: () => void;
}) {
	const { memberId, channel, selected, onNavigate } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { cancelNavigation, followLink } = AppChannelsProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const [menuOpen, setMenuOpen] = useState(false);
	const state = useQuery(app_convex_api.channels.get_channel_state, { membershipId, channelId: channel._id });
	const file = useQuery(
		app_convex_api.channels.get_channel,
		channel.kind === "file" ? { membershipId, channelId: channel._id } : "skip",
	);
	const directName = useChannelsDirectName(
		channel.kind === "direct" ? channel.participantUserIds.filter((id) => id !== userId) : [],
	);
	const name =
		channel.kind === "direct" ? directName : channel.kind === "file" ? (file?.file?.name ?? "File") : channel.name;
	const unread =
		state?.member?.notify !== "none" &&
		(state?.member?.notify === "mentions" ? (state?.mentionCount ?? 0) > 0 : state?.unread === true);
	const path = `${url_path_messages({ organizationName, workspaceName })}/${channel._id}`;
	const onChange = useFn(async (operation: "read" | "star" | "leave" | "all" | "mentions" | "none") => {
		if (!state) return;
		const args = { membershipId, channelId: channel._id };
		if (operation === "leave" && channel.kind === "direct") cancelNavigation(channel._id);
		try {
			const result =
				operation === "read"
					? await app_convex.mutation(app_convex_api.channels.mark_read, {
							...args,
							sequence: state.activity.lastChannelSequence,
						})
					: operation === "star"
						? await app_convex.mutation(app_convex_api.channels.set_channel_starred, {
								...args,
								starred: !state.member?.starred,
							})
						: operation === "leave"
							? await app_convex.mutation(
									channel.kind === "direct"
										? app_convex_api.channels.hide_direct_channel
										: app_convex_api.channels.leave_channel,
									args,
								)
							: await app_convex.mutation(app_convex_api.channels.set_channel_notify, { ...args, notify: operation });
			if (result._nay) toast.error(result._nay.message);
		} catch (error) {
			console.error("[ChannelsSidebar] Cannot change channel", error);
			toast.error("Could not change this channel");
		}
	});
	return (
		<MySidebarListItem
			data-member-id={memberId}
			className={"ChannelsSidebarRow" satisfies ChannelsSidebarRow_ClassNames}
			{...({
				"data-channel-id": channel._id,
				"data-channel-kind": channel.kind,
				"data-unread": String(unread),
				"data-mention-count": state?.mentionCount ?? 0,
			} satisfies ChannelsSidebarRow_CustomAttributes)}
		>
			<MySidebarListItemPrimaryActionLink
				variant="button"
				to={path}
				aria-current={selected ? "page" : undefined}
				tooltip={file?.file?.path ?? name}
				aria-label={file?.file?.path ?? name}
				onClick={(event) => {
					followLink(event);
					onNavigate();
				}}
			>
				<MySidebarListItemIcon>
					{channel.kind === "private" ? (
						<Lock />
					) : channel.kind === "direct" ? (
						<MessageCircle />
					) : channel.kind === "file" ? (
						<FileText />
					) : (
						<Hash />
					)}
				</MySidebarListItemIcon>
				<MySidebarListItemTitle>{name}</MySidebarListItemTitle>
				{(state?.mentionCount ?? 0) > 0 && (
					<span className={"ChannelsSidebarRow-count" satisfies ChannelsSidebarRow_ClassNames}>
						{state!.mentionCount >= 100 ? "99+" : state!.mentionCount}
					</span>
				)}
			</MySidebarListItemPrimaryActionLink>
			<MyMenu open={menuOpen} setOpen={setMenuOpen}>
				<MyMenuTrigger>
					<MyIconButton tooltip={`Actions for ${name}`} variant="ghost-highlightable">
						<MoreHorizontal />
					</MyIconButton>
				</MyMenuTrigger>
				<MyMenuPopover aria-label={`Actions for ${name}`}>
					<MyMenuItem onClick={() => onChange("read")}>Mark read</MyMenuItem>
					<MyMenuItem onClick={() => onChange("star")}>
						<Star size={16} />
						{state?.member?.starred ? "Unstar" : "Star"}
					</MyMenuItem>
					<MyMenuItem onClick={() => onChange("all")}>Notify on all messages</MyMenuItem>
					<MyMenuItem onClick={() => onChange("mentions")}>Notify on mentions</MyMenuItem>
					<MyMenuItem onClick={() => onChange("none")}>No notifications</MyMenuItem>
					<MyMenuItem onClick={() => onChange("leave")}>
						{channel.kind === "direct" ? "Close conversation" : "Leave channel"}
					</MyMenuItem>
				</MyMenuPopover>
			</MyMenu>
		</MySidebarListItem>
	);
});
