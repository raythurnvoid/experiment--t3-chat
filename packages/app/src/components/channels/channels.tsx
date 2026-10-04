import "./channels.css";
import { memo, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvexConnectionState, usePaginatedQuery, useQuery } from "convex/react";
import { Menu } from "lucide-react";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { app_convex, app_convex_api, app_convex_is_id_like, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppChannelsProvider } from "@/lib/app-channels-context.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { ChannelsSidebar } from "./channels-sidebar.tsx";
import { ChannelsDialogs, type ChannelsDialogKind } from "./channels-dialogs.tsx";
import { ChannelsConversation } from "./channels-conversation.tsx";
import { useChannelsPeople } from "./channels-people.ts";
import { ChannelsActivity, ChannelsThreads } from "./channels-feed.tsx";

export type ChannelsSearch = { thread?: string; message?: string };
type ChannelsContent_ClassNames =
	| "ChannelsContent"
	| "ChannelsContent-header"
	| "ChannelsContent-empty"
	| "ChannelsContent-status";
type ChannelsContent_CustomAttributes = { "data-channel-access": "allowed" | "missing" | "none" };

export const Channels = memo(function Channels(props: ComponentProps<typeof ChannelsContent>) {
	const { membershipId } = AppTenantProvider.useContext();
	const resetKey = useFn(
		() => `${membershipId}:${props.view ?? "messages"}:${props.channelId ?? "index"}:${props.search.thread ?? "main"}`,
	);
	const catchError = useFn((error: unknown) => console.error("[Channels] Failed to load messages", { error }));
	return (
		<CatchBoundary getResetKey={resetKey} onCatch={catchError} errorComponent={ChannelsError}>
			<ChannelsContent {...props} />
		</CatchBoundary>
	);
});

const ChannelsError = memo(function ChannelsError(props: ErrorComponentProps) {
	return (
		<div role="alert">
			<p>Could not load messages. Try again.</p>
			<MyButton onClick={props.reset}>Retry</MyButton>
		</div>
	);
});

const ChannelsContent = memo(function ChannelsContent(props: {
	channelId?: string;
	search: ChannelsSearch;
	view?: "messages" | "browse" | "activity" | "threads" | "search";
	onNavigate: (channelId: app_convex_Id<"channels">, search?: ChannelsSearch) => void;
	children?: ReactNode;
}) {
	const { channelId, search, view = "messages", onNavigate, children } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const connection = useConvexConnectionState();
	const { people } = useChannelsPeople();
	const { channelList, states } = AppChannelsProvider.useContext();
	const [lastOpen, setLastOpen] = useAppLocalStorageStateValue(`app_state::channels_last_open::scope::${membershipId}`);
	const selectedId = channelId && app_convex_is_id_like(channelId) ? (channelId as app_convex_Id<"channels">) : null;
	const channel = useQuery(
		app_convex_api.channels.get_channel,
		selectedId ? { membershipId, channelId: selectedId } : "skip",
	);
	const lastChannel = useQuery(
		app_convex_api.channels.get_channel,
		!channelId && view === "messages" && lastOpen && app_convex_is_id_like(lastOpen)
			? { membershipId, channelId: lastOpen as app_convex_Id<"channels"> }
			: "skip",
	);
	const state = useQuery(
		app_convex_api.channels.get_channel_state,
		channel ? { membershipId, channelId: channel.channel._id } : "skip",
	);
	const [dialog, setDialog] = useState<ChannelsDialogKind | null>(null);
	const [drawer, setDrawer] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 899px)").matches);
	const open = useFn((id: app_convex_Id<"channels">, query?: ChannelsSearch) => {
		setDrawer(false);
		onNavigate(id, query);
	});
	const sidebar = (
		<ChannelsSidebar
			channelId={channelId}
			channelList={channelList}
			states={states}
			people={people}
			onDialog={setDialog}
			onNavigate={() => setDrawer(false)}
		/>
	);
	AppHotkeysProvider.useHotkey({ hotkey: "Mod+K", callback: useFn(() => setDialog("quick")) });

	useEffect(() => {
		const media = matchMedia("(max-width: 899px)");
		const change = () => setNarrow(media.matches);
		media.addEventListener("change", change);
		return () => media.removeEventListener("change", change);
	}, []);
	useEffect(() => {
		if (lastChannel) open(lastChannel.channel._id);
	}, [lastChannel, open]);
	useEffect(() => {
		if (channel) setLastOpen(channel.channel._id);
	}, [channel, setLastOpen]);

	const content =
		view === "activity" ? (
			<ChannelsActivity />
		) : view === "threads" ? (
			<ChannelsThreads />
		) : view === "search" ? (
			children
		) : view === "browse" ? (
			<ChannelsBrowse onNavigate={open} />
		) : (selectedId && channel === undefined) || (channel && state === undefined) ? (
			<div className={"ChannelsContent-empty" satisfies ChannelsContent_ClassNames}>Loading channel…</div>
		) : channel && state ? (
			<ChannelsConversation
				key={channel.channel._id}
				channel={channel}
				state={state}
				people={people}
				search={search}
				narrow={narrow}
				onNavigate={open}
				onDialog={setDialog}
			/>
		) : (
			<div className={"ChannelsContent-empty" satisfies ChannelsContent_ClassNames}>
				{channelId ? (
					<>
						<h2>Channel not found</h2>
						<p>This channel may have been deleted or your access changed.</p>
					</>
				) : (
					<>
						<h2>Your conversations, together</h2>
						<p>Choose a channel or start a new conversation.</p>
						<MyButton onClick={() => setDialog("create")}>Create channel</MyButton>
						<MyButton onClick={() => setDialog("direct")}>Message someone</MyButton>
					</>
				)}
			</div>
		);
	return (
		<div
			className={"ChannelsContent" satisfies ChannelsContent_ClassNames}
			{...({
				"data-channel-access": channel ? "allowed" : channelId ? "missing" : "none",
			} satisfies ChannelsContent_CustomAttributes)}
		>
			<header className={"ChannelsContent-header" satisfies ChannelsContent_ClassNames}>
				<MyIconButton
					tooltip={narrow ? "Open channels" : sidebarOpen ? "Hide channels" : "Show channels"}
					aria-expanded={narrow ? drawer : sidebarOpen}
					onClick={() => (narrow ? setDrawer(true) : setSidebarOpen(!sidebarOpen))}
				>
					<Menu />
				</MyIconButton>
				<span>Messages</span>
			</header>
			{!connection.isWebSocketConnected && (
				<p role="status" className={"ChannelsContent-status" satisfies ChannelsContent_ClassNames}>
					Connecting… Your draft is saved on this device.
				</p>
			)}
			{narrow ? (
				content
			) : (
				<MyPanelGroup direction="horizontal" defaultLayout={[24, 76]}>
					<MyPanel order={1} isOpen={sidebarOpen} defaultSize={24} minSize={15} maxSize={40}>
						{sidebar}
					</MyPanel>
					<MyPanelResizeHandle isOpen={sidebarOpen} />
					<MyPanel order={2} defaultSize={76} minSize={40}>
						{content}
					</MyPanel>
				</MyPanelGroup>
			)}
			{narrow && (
				<MyModal open={drawer} setOpen={setDrawer}>
					<MyModalPopover aria-label="Channels">
						<MyModalHeader>
							<MyModalHeading>Messages</MyModalHeading>
							<MyModalCloseTrigger />
						</MyModalHeader>
						<MyModalScrollableArea>{sidebar}</MyModalScrollableArea>
					</MyModalPopover>
				</MyModal>
			)}
			{dialog && (
				<ChannelsDialogs
					key={`${dialog}:${selectedId}`}
					kind={dialog}
					channel={channel ?? null}
					people={people}
					onClose={() => setDialog(null)}
					onChannel={open}
				/>
			)}
		</div>
	);
});

type ChannelsBrowse_ClassNames = "ChannelsBrowse" | "ChannelsBrowse-list" | "ChannelsBrowse-row";

const ChannelsBrowse = memo(function ChannelsBrowse(props: { onNavigate: (id: app_convex_Id<"channels">) => void }) {
	const { onNavigate } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [archived, setArchived] = useState(false);
	const [filter, setFilter] = useState("");
	const [error, setError] = useState("");
	const channels = usePaginatedQuery(
		app_convex_api.channels.browse_public_channels,
		{ membershipId, archived },
		{ initialNumItems: 50 },
	);
	const join = useFn(async (id: app_convex_Id<"channels">) => {
		setError("");
		await app_convex
			.mutation(app_convex_api.channels.join_channel, { membershipId, channelId: id })
			.then((result) => {
				if (result._nay) setError(result._nay.message);
				else onNavigate(id);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsBrowse.join] Failed to join channel", { error });
				setError("Could not join this channel");
			});
	});
	return (
		<section
			className={cn("ChannelsBrowse" satisfies ChannelsBrowse_ClassNames, "app-scrollable" satisfies AppClassName)}
			aria-label="Browse channels"
		>
			<h1>Browse channels</h1>
			<MyInput>
				<MyInputBackground />
				<MyInputArea>
					<MyInputControl
						type="search"
						aria-label="Filter channels"
						placeholder="Channel name…"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
				</MyInputArea>
				<MyInputBox />
			</MyInput>
			<MyButton aria-pressed={archived} onClick={() => setArchived(!archived)}>
				{archived ? "Show active channels" : "Show archived channels"}
			</MyButton>
			{error && <p role="alert">{error}</p>}
			<div className={"ChannelsBrowse-list" satisfies ChannelsBrowse_ClassNames}>
				{channels.results
					.filter(
						(channel) =>
							(channel.kind === "public" || channel.kind === "private") && channel.name.includes(filter.toLowerCase()),
					)
					.map((channel) => (
						<div key={channel._id} className={"ChannelsBrowse-row" satisfies ChannelsBrowse_ClassNames}>
							<div>
								<strong>{channel.kind === "public" || channel.kind === "private" ? `#${channel.name}` : ""}</strong>
								<p>{channel.kind === "public" || channel.kind === "private" ? channel.topic : ""}</p>
							</div>
							<MyButton onClick={() => onNavigate(channel._id)}>View</MyButton>
							{!archived && <MyButton onClick={() => join(channel._id)}>Join</MyButton>}
						</div>
					))}
			</div>
			{channels.status === "LoadingFirstPage" ? (
				<p>Loading channels…</p>
			) : channels.results.length === 0 ? (
				<p>No public channels yet</p>
			) : null}
			{channels.status === "CanLoadMore" && <MyButton onClick={() => channels.loadMore(50)}>Load more</MyButton>}
		</section>
	);
});
