import "./channels.css";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { useConvexConnectionState, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MyModal, MyModalPopover, MyModalScrollableArea } from "@/components/my-modal.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { app_convex, app_convex_api, app_convex_is_id_like, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppChannelsProvider, type ChannelsNavigationMode } from "@/lib/app-channels-context.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { ChannelsSidebar } from "./channels-sidebar.tsx";
import { ChannelsDialogs, type ChannelsDialogKind } from "./channels-dialogs.tsx";
import { ChannelsConversation } from "./channels-conversation.tsx";
import { ChannelsActivity, ChannelsThreads } from "./channels-feed.tsx";
import { ChannelsLayoutContext, channels_focus_opener } from "./channels-layout-context.ts";
import { ChannelsPaneHeader } from "./channels-pane-header.tsx";
import { ChannelsPickerError } from "./channels-picker.tsx";
import { useChannelsPickerFocus } from "./channels-picker-hooks.ts";

export type ChannelsSearch = { thread?: string; message?: string };
const CHANNELS_PANEL_TAB_ID_THREAD = "app_channels_panel_tabs_thread" satisfies AppElementId;
const CHANNELS_PANEL_TAB_ID_AGENT = "app_channels_panel_tabs_agent" satisfies AppElementId;
type ChannelsContent_ClassNames =
	| "ChannelsContent"
	| "ChannelsContent-empty"
	| "ChannelsContent-status"
	| "ChannelsContent-panel-toolbar"
	| "ChannelsContent-panel-tabs-panels"
	| "ChannelsContent-panel-tabs-panel"
	| "ChannelsContent-thread-host";
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
	onNavigate: (channelId: app_convex_Id<"channels">, search?: ChannelsSearch, mode?: ChannelsNavigationMode) => void;
	children?: ReactNode;
}) {
	const { channelId, search, view = "messages", onNavigate, children } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const connection = useConvexConnectionState();
	const { navigation, consumeNavigation } = AppChannelsProvider.useContext();
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
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [sidebarOpen, setSidebarOpen] = useAppLocalStorageStateValue("app_state::sidebar::channels_open");
	const [sidebarWidth, setSidebarWidth] = useAppLocalStorageStateValue("app_state::channels_sidebar_width");
	const [panelWidth, setPanelWidth] = useAppLocalStorageStateValue("app_state::channels_panel_width");
	const region = useRef<HTMLDivElement>(null);
	const sidebarFocus = useRef<{ element: HTMLElement; memberId: string | null } | null>(null);
	const sidebarPanel = useRef<ImperativePanelHandle>(null);
	const sidebarLayout = useRef(0);
	const rightPanel = useRef<ImperativePanelHandle>(null);
	const rightLayout = useRef(0);
	const panelOpener = useRef<HTMLElement | null>(null);
	const [width, setWidth] = useState(0);
	const [threadHost, setThreadHost] = useState<HTMLDivElement | null>(null);
	const [narrowPanel, setNarrowPanel] = useState(false);
	// Only a loaded conversation renders the thread. Without one, the Thread tab would stay blank.
	const hasThread =
		view === "messages" &&
		!!channel &&
		!!state &&
		!!(
			search.thread ||
			(search.message &&
				(channel.channel.kind === "file" ||
					((channel.channel.kind === "public" || channel.channel.kind === "private") &&
						channel.channel.layout === "posts")))
		);
	const rootId = hasThread ? (search.thread ?? search.message ?? null) : null;
	const [tab, setTab] = useState<"thread" | "agent">(rootId ? "thread" : "agent");
	const [tabRootId, setTabRootId] = useState(rootId);
	// A tab the user picked holds while the same thread stays open. Another thread selects Thread, and no
	// thread falls back to Agent. Reset it during render, so the new thread never shows on the old tab.
	if (tabRootId !== rootId) {
		setTabRootId(rootId);
		setTab(rootId ? "thread" : "agent");
	}

	// Like Files: from 820px the right panel is always a column, and the channel list follows the user's own
	// open flag. The list shows as a column only when list 220 + conversation 360 + panel 360 fit.
	const narrow = width < 820;
	// The panel opened from the Agent button covers the conversation only while narrow. Forget it when the
	// window gets wider, so it does not cover the conversation again later by itself.
	if (!narrow && narrowPanel) setNarrowPanel(false);
	const panelVisible = !narrow || !!rootId || narrowPanel;
	const sidebarFits = width >= 944;
	const sidebarVisible = sidebarOpen && sidebarFits;
	const available = Math.max(1, width - (sidebarVisible ? 2 : 0) - (narrow ? 0 : 2));
	const maximumPanel = Math.min(480, Math.max(360, available - 360 - (sidebarVisible ? 220 : 0)));
	const actualPanelWidth = Math.min(panelWidth, maximumPanel);
	const maximumSidebar = Math.min(320, Math.max(220, available - 360 - (narrow ? 0 : actualPanelWidth)));
	const actualSidebarWidth = Math.min(sidebarWidth, maximumSidebar);
	const openSidebar = useFn(() => (sidebarFits ? setSidebarOpen(true) : setDrawer(true)));
	const open = useFn((id: app_convex_Id<"channels">, query?: ChannelsSearch, mode?: ChannelsNavigationMode) => {
		setDrawer(false);
		onNavigate(id, query, mode);
	});
	const openPanel = useFn((opener: HTMLElement) => {
		panelOpener.current = opener;
		setTab("agent");
		setNarrowPanel(true);
		// The panel hides the button that opened it. Move focus into the panel, so the keyboard does not start
		// again from the top of the page.
		requestAnimationFrame(() => document.getElementById(CHANNELS_PANEL_TAB_ID_AGENT)?.focus({ preventScroll: true }));
	});
	const closePanel = useFn(() => {
		setNarrowPanel(false);
		// The panel stays open while a thread is open, so Back also closes the thread.
		if (rootId && selectedId) open(selectedId);
		// The conversation comes before the panel in the page, so the first match is its copy of the root.
		channels_focus_opener(panelOpener, region.current, rootId);
	});
	const showThread = useFn(() => setTab("thread"));
	const changeTab = useFn((id: string | null | undefined) => {
		if (id) setTab(id === CHANNELS_PANEL_TAB_ID_THREAD ? "thread" : "agent");
	});
	const sidebar = (
		<ChannelsSidebar
			channelId={channelId}
			collapsed={collapsed}
			setCollapsed={setCollapsed}
			onClose={() => (drawer ? setDrawer(false) : setSidebarOpen(false))}
			onDialog={setDialog}
			onNavigate={() => setDrawer(false)}
		/>
	);
	AppHotkeysProvider.useHotkey({ hotkey: "Mod+K", callback: useFn(() => setDialog("quick")) });

	useEffect(() => {
		const element = region.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	// A hidden panel keeps its share of the width, so size the hidden list to 0. Then the conversation and the
	// panel add up to the whole width.
	useEffect(() => {
		sidebarPanel.current?.resize(sidebarVisible ? (actualSidebarWidth / available) * 100 : 0);
	}, [sidebarVisible, actualSidebarWidth, available]);
	useEffect(() => {
		if (!narrow) rightPanel.current?.resize((actualPanelWidth / available) * 100);
	}, [narrow, actualPanelWidth, available]);
	useLayoutEffect(() => {
		const previous = sidebarFocus.current;
		if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
		const row = previous.memberId
			? region.current?.querySelector<HTMLElement>(
					`[data-member-id="${CSS.escape(previous.memberId)}"] a, [data-member-id="${CSS.escape(previous.memberId)}"] button`,
				)
			: null;
		(
			row ??
			region.current?.querySelector<HTMLElement>(
				'button[aria-label="Open channels"], aside[aria-label="Channels"] button[aria-expanded]',
			)
		)?.focus();
	}, [sidebarVisible, drawer]);
	useEffect(() => {
		if (lastChannel) open(lastChannel.channel._id, undefined, "passive");
	}, [lastChannel, open]);
	useEffect(() => {
		if (channel) setLastOpen(channel.channel._id);
	}, [channel, setLastOpen]);
	useEffect(() => {
		if (!selectedId || !navigation?.committed || navigation.channelId !== selectedId || channel === undefined) return;
		if (channel && state === undefined) return;
		if (!consumeNavigation(selectedId)) return;
		if (channel?.channel.kind !== "direct" || !state?.member) return;
		void app_convex
			.mutation(app_convex_api.channels.open_direct_channel_by_id, {
				membershipId,
				channelId: channel.channel._id,
				expectedVisibilityRevision: state.member.visibilityRevision,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsContent] Could not open conversation", { error });
				toast.error("Could not open this conversation");
			});
	}, [selectedId, navigation, channel, state, membershipId, consumeNavigation]);

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
				search={search}
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
			ref={region}
			onFocusCapture={(event) => {
				if (event.target.closest('aside[aria-label="Channels"]'))
					sidebarFocus.current = {
						element: event.target,
						memberId: event.target.closest<HTMLElement>("[data-member-id]")?.dataset.memberId ?? null,
					};
			}}
			className={"ChannelsContent" satisfies ChannelsContent_ClassNames}
			data-layout={narrow ? "single" : sidebarFits ? "wide" : "columns"}
			{...({
				"data-channel-access": channel ? "allowed" : channelId ? "missing" : "none",
			} satisfies ChannelsContent_CustomAttributes)}
		>
			{!connection.isWebSocketConnected && (
				<p role="status" className={"ChannelsContent-status" satisfies ChannelsContent_ClassNames}>
					Connecting… Your draft is saved on this device.
				</p>
			)}
			<ChannelsLayoutContext
				value={{
					sidebarVisible,
					drawerOpen: drawer,
					openSidebar,
					narrow,
					threadHost,
					openPanel: narrow ? openPanel : null,
					panelOpener,
					showThread,
				}}
			>
				<MyPanelGroup
					direction="horizontal"
					// Double-click on a resize handle goes back to the default widths in storage.ts.
					defaultLayout={
						narrow
							? undefined
							: [
									sidebarVisible ? (240 / available) * 100 : 0,
									100 - (((sidebarVisible ? 240 : 0) + 380) / available) * 100,
									(380 / available) * 100,
								]
					}
					onLayoutReset={() => {
						setSidebarWidth(240);
						setPanelWidth(380);
					}}
					onLayout={(layout) => {
						sidebarLayout.current = layout[0]!;
						rightLayout.current = layout[layout.length - 1]!;
					}}
				>
					<MyPanel
						ref={sidebarPanel}
						order={1}
						isOpen={sidebarVisible}
						closeBehavior="hidden"
						defaultSize={sidebarVisible ? (actualSidebarWidth / available) * 100 : 0}
						minSize={sidebarVisible ? (220 / available) * 100 : 0}
						maxSize={sidebarVisible ? (maximumSidebar / available) * 100 : 100}
					>
						{sidebarVisible && !drawer ? sidebar : null}
					</MyPanel>
					<MyPanelResizeHandle
						isOpen={sidebarVisible}
						closeBehavior="hidden"
						aria-label="Resize channels sidebar"
						onKeyUp={(event) => {
							if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
								setSidebarWidth(Math.max(220, Math.min(maximumSidebar, (sidebarLayout.current * available) / 100)));
						}}
						onDragging={(dragging) => {
							if (!dragging)
								setSidebarWidth(Math.max(220, Math.min(maximumSidebar, (sidebarLayout.current * available) / 100)));
						}}
					/>
					{/* Keep the conversation mounted while the panel covers it, so its draft and scroll stay. */}
					<MyPanel
						order={2}
						isOpen={!(narrow && panelVisible)}
						closeBehavior="hidden"
						minSize={narrow ? 0 : (360 / available) * 100}
					>
						{!(channel && state && view === "messages") && (
							<ChannelsPaneHeader
								title={
									<h1>
										{view === "messages"
											? "Messages"
											: view === "activity"
												? "Activity"
												: view === "threads"
													? "Threads"
													: view === "search"
														? "Search messages"
														: "Browse channels"}
									</h1>
								}
							/>
						)}
						{content}
					</MyPanel>
					<MyPanelResizeHandle
						isOpen={!narrow}
						closeBehavior="hidden"
						aria-label="Resize conversation and panel"
						onKeyUp={(event) => {
							if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
								setPanelWidth(Math.max(360, Math.min(maximumPanel, (rightLayout.current * available) / 100)));
						}}
						onDragging={(dragging) => {
							if (!dragging)
								setPanelWidth(Math.max(360, Math.min(maximumPanel, (rightLayout.current * available) / 100)));
						}}
					/>
					{/* Keep the agent chat mounted while the panel is hidden, like the Files sidebar. */}
					<MyPanel
						ref={rightPanel}
						order={3}
						isOpen={panelVisible}
						closeBehavior="hidden"
						defaultSize={narrow ? 30 : (actualPanelWidth / available) * 100}
						minSize={narrow ? 0 : (360 / available) * 100}
						maxSize={narrow ? 100 : (maximumPanel / available) * 100}
					>
						<MyTabs
							selectedId={tab === "thread" ? CHANNELS_PANEL_TAB_ID_THREAD : CHANNELS_PANEL_TAB_ID_AGENT}
							setSelectedId={changeTab}
						>
							<div className={"ChannelsContent-panel-toolbar" satisfies ChannelsContent_ClassNames}>
								{/* With an open thread, the thread header has its own Back. */}
								{narrow && !(tab === "thread" && rootId) && (
									<MyIconButton tooltip="Back to channel" onClick={closePanel}>
										<ArrowLeft />
									</MyIconButton>
								)}
								<MyTabsList aria-label="Panel tabs">
									<MyTabsTab id={CHANNELS_PANEL_TAB_ID_THREAD}>Thread</MyTabsTab>
									<MyTabsTab id={CHANNELS_PANEL_TAB_ID_AGENT}>Agent</MyTabsTab>
								</MyTabsList>
							</div>
							<MyTabsPanels className={"ChannelsContent-panel-tabs-panels" satisfies ChannelsContent_ClassNames}>
								<MyTabsPanel
									className={"ChannelsContent-panel-tabs-panel" satisfies ChannelsContent_ClassNames}
									tabId={CHANNELS_PANEL_TAB_ID_THREAD}
								>
									<div
										ref={setThreadHost}
										className={"ChannelsContent-thread-host" satisfies ChannelsContent_ClassNames}
									></div>
									{!rootId && (
										<p className={"ChannelsContent-empty" satisfies ChannelsContent_ClassNames}>
											No thread open. Choose Reply in thread on a message.
										</p>
									)}
								</MyTabsPanel>
								<MyTabsPanel
									className={"ChannelsContent-panel-tabs-panel" satisfies ChannelsContent_ClassNames}
									tabId={CHANNELS_PANEL_TAB_ID_AGENT}
								>
									<FileEditorSidebarAgent isActive={panelVisible && tab === "agent"} pluginPage={null} />
								</MyTabsPanel>
							</MyTabsPanels>
						</MyTabs>
					</MyPanel>
				</MyPanelGroup>
				<MyModal open={drawer} setOpen={setDrawer}>
					<MyModalPopover aria-label="Channels" className="ChannelsContent-drawer">
						<MyModalScrollableArea>{drawer ? sidebar : null}</MyModalScrollableArea>
					</MyModalPopover>
				</MyModal>
			</ChannelsLayoutContext>
			{dialog && (
				<ChannelsDialogs
					key={`${dialog}:${selectedId}`}
					kind={dialog}
					channel={channel ?? null}
					onClose={() => setDialog(null)}
					onChannel={(id, mode) => open(id, undefined, mode)}
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
	const { accessScopeKey, status } = AppChannelsProvider.useContext();
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
			{accessScopeKey === null ? (
				<p>
					{status === "error"
						? "Could not load channels"
						: status === "unavailable"
							? "Channels unavailable"
							: "Loading channels…"}
				</p>
			) : (
				<CatchBoundary getResetKey={() => `${membershipId}:${accessScopeKey}`} errorComponent={ChannelsPickerError}>
					<ChannelsBrowsePages
						key={`${membershipId}:${accessScopeKey}`}
						accessScopeKey={accessScopeKey}
						archived={archived}
						prefix={filter}
						onNavigate={onNavigate}
						onJoin={join}
					/>
				</CatchBoundary>
			)}
		</section>
	);
});

const ChannelsBrowsePages = memo(function ChannelsBrowsePages(props: {
	accessScopeKey: string;
	archived: boolean;
	prefix: string;
	onNavigate: (id: app_convex_Id<"channels">) => void;
	onJoin: (id: app_convex_Id<"channels">) => void;
}) {
	const { accessScopeKey, archived, prefix, onNavigate, onJoin } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const channels = usePaginatedQuery(
		app_convex_api.channels.browse_public_channels,
		{ membershipId, accessScopeKey, archived, prefix },
		{ initialNumItems: 50 },
	);
	const loading = channels.status === "LoadingFirstPage";
	const [held, setHeld] = useState<typeof channels.results | null>(null);
	if (!loading && held !== channels.results) setHeld(channels.results);
	const rows = loading && held ? held : channels.results;
	const focus = useChannelsPickerFocus();
	return (
		<div {...focus} className={"ChannelsBrowse-list" satisfies ChannelsBrowse_ClassNames} aria-busy={loading}>
			{rows.map((channel) => (
				<div key={channel._id} className={"ChannelsBrowse-row" satisfies ChannelsBrowse_ClassNames}>
					<div>
						<strong>{channel.kind === "public" || channel.kind === "private" ? `#${channel.name}` : ""}</strong>
						{(channel.kind === "public" || channel.kind === "private") && channel.archived && <span>Archived</span>}
						<p>{channel.kind === "public" || channel.kind === "private" ? channel.topic : ""}</p>
					</div>
					<MyButton data-picker-row={channel._id} disabled={loading} onClick={() => onNavigate(channel._id)}>
						View
					</MyButton>
					{!archived && (
						<MyButton disabled={loading} onClick={() => onJoin(channel._id)}>
							Join
						</MyButton>
					)}
				</div>
			))}
			{loading && held === null ? <p>Loading channels…</p> : rows.length === 0 ? <p>No public channels yet</p> : null}
			{(channels.status === "CanLoadMore" || channels.status === "LoadingMore") && (
				<MyButton
					aria-disabled={channels.status === "LoadingMore"}
					onClick={() => {
						if (channels.status === "CanLoadMore") channels.loadMore(50);
					}}
				>
					{channels.status === "LoadingMore" ? "Loading…" : "Show more channels"}
				</MyButton>
			)}
		</div>
	);
});
