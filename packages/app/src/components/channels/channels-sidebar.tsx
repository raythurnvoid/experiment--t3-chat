import "./channels-sidebar.css";
import { memo, useState } from "react";
import { useQuery, type UsePaginatedQueryReturnType } from "convex/react";
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
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
	app_convex,
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionReturnType,
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
	MySidebarListItemPrimaryActionLink,
	MySidebarListItemTitle,
} from "@/components/my-sidebar.tsx";
import { url_path_messages } from "@/lib/urls.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useChannelsDirectName, type ChannelsPerson } from "./channels-people.ts";

type ChannelsSidebar_ClassNames =
	| "ChannelsSidebar"
	| "ChannelsSidebar-header"
	| "ChannelsSidebar-section"
	| "ChannelsSidebar-section-header"
	| "ChannelsSidebar-empty";
type ChannelState = app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel_state>;

export const ChannelsSidebar = memo(function ChannelsSidebar(props: {
	channelId: string | undefined;
	channelList: UsePaginatedQueryReturnType<typeof app_convex_api.channels.list_my_channels>;
	states: Record<string, ChannelState | Error | undefined>;
	people: readonly ChannelsPerson[];
	onClose: () => void;
	onDialog: (dialog: "create" | "direct" | "quick") => void;
	onNavigate: () => void;
}) {
	const { channelId, channelList, states, people, onClose, onDialog, onNavigate } = props;
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { inboxUnreadCount, threadsUnreadCount, inboxHasMore, threadsHasMore } = AppChannelsProvider.useContext();
	const { results: channels, status, loadMore } = channelList;
	const change = useFn(
		async (channel: app_convex_Doc<"channels">, operation: "read" | "star" | "leave" | "all" | "mentions" | "none") => {
			const state = states[channel._id];
			if (!state || state instanceof Error) return;
			const args = { membershipId, channelId: channel._id };
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
		},
	);
	const starred = channels.filter((channel) => {
		const state = states[channel._id];
		return state && !(state instanceof Error) && state.member?.starred;
	});
	const unstarred = channels.filter((channel) => !starred.includes(channel));
	const groups = [
		{
			title: "Starred",
			channels: starred,
			action: null,
		},
		{
			title: "Channels",
			channels: unstarred.filter((channel) => channel.kind === "public" || channel.kind === "private"),
			action: "create" as const,
		},
		{
			title: "Direct messages",
			channels: unstarred.filter((channel) => channel.kind === "direct"),
			action: "direct" as const,
		},
		{ title: "Files", channels: unstarred.filter((channel) => channel.kind === "file"), action: null },
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
					{(inboxUnreadCount > 0 || inboxHasMore) && (
						<span
							className="ChannelsSidebarRow-count"
							title={inboxHasMore ? "Unread in loaded items; more items available." : "Unread in loaded items"}
						>
							{inboxUnreadCount}
							{inboxHasMore ? "+" : ""}
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
					{(threadsUnreadCount > 0 || threadsHasMore) && (
						<span
							className="ChannelsSidebarRow-count"
							title={threadsHasMore ? "Unread in loaded items; more items available." : "Unread in loaded items"}
						>
							{threadsUnreadCount}
							{threadsHasMore ? "+" : ""}
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
				{status === "LoadingFirstPage" ? (
					<p>Loading channels…</p>
				) : channels.length === 0 ? (
					<div className={"ChannelsSidebar-empty" satisfies ChannelsSidebar_ClassNames}>
						<p>No channels yet</p>
						<MyButton onClick={() => onDialog("create")}>Create channel</MyButton>
						<MyButton onClick={() => onDialog("direct")}>Message someone</MyButton>
					</div>
				) : null}
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
							<MySidebarList>
								{group.channels.map((channel) => {
									const state = states[channel._id];
									return (
										<ChannelsSidebarRow
											key={channel._id}
											channel={channel}
											state={state instanceof Error ? null : state}
											people={people}
											selected={channel._id === channelId}
											onNavigate={onNavigate}
											onChange={(operation) => void change(channel, operation)}
										/>
									);
								})}
							</MySidebarList>
						)}
					</section>
				))}
				{status === "CanLoadMore" && <MyButton onClick={() => loadMore(50)}>Load more channels</MyButton>}
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

type ChannelsSidebarRow_ClassNames = "ChannelsSidebarRow" | "ChannelsSidebarRow-count";
type ChannelsSidebarRow_CustomAttributes = {
	"data-channel-id": string;
	"data-channel-kind": string;
	"data-unread": string;
	"data-mention-count": number;
};

const ChannelsSidebarRow = memo(function ChannelsSidebarRow(props: {
	channel: app_convex_Doc<"channels">;
	state: ChannelState | undefined;
	people: readonly ChannelsPerson[];
	selected: boolean;
	onNavigate: () => void;
	onChange: (operation: "read" | "star" | "leave" | "all" | "mentions" | "none") => void;
}) {
	const { channel, state, people, selected, onNavigate, onChange } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const [menuOpen, setMenuOpen] = useState(false);
	const file = useQuery(
		app_convex_api.channels.get_channel,
		channel.kind === "file" ? { membershipId, channelId: channel._id } : "skip",
	);
	const directName = useChannelsDirectName(
		channel.kind === "direct" ? channel.participantUserIds.filter((id) => id !== userId) : [],
		people,
	);
	const name =
		channel.kind === "direct" ? directName : channel.kind === "file" ? (file?.file?.name ?? "File") : channel.name;
	const unread =
		state?.member?.notify !== "none" &&
		(state?.member?.notify === "mentions" ? (state?.mentionCount ?? 0) > 0 : state?.unread === true);
	const path = `${url_path_messages({ organizationName, workspaceName })}/${channel._id}`;
	return (
		<MySidebarListItem
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
				onClick={onNavigate}
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
