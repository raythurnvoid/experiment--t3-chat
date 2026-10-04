import "./channels-conversation.css";
import {
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
	type ComponentProps,
	type FormEvent,
	type ReactNode,
} from "react";
import { useConvexConnectionState, usePaginatedQuery, useQuery } from "convex/react";
import { FileText, Hash, Lock, Menu, MoreHorizontal, Users, X } from "lucide-react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyMenu, MyMenuItem, MyMenuPopover, MyMenuTrigger } from "@/components/my-menu.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import {
	app_convex,
	app_convex_api,
	app_convex_is_id_like,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	app_local_storage_get_value,
	app_local_storage_set_value,
	useAppLocalStorageStateValue,
} from "@/lib/storage.ts";
import { url_path_file_by_node_id, url_path_messages } from "@/lib/urls.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { channels_composer_markdown_for_edit } from "../../../shared/channels.ts";
import { ChannelsComposer, type ChannelsComposerControl_Ref } from "./channels-composer.tsx";
import type { ChannelsMentionItem } from "./channels-composer-mention.tsx";
import { ChannelsMessage } from "./channels-message.tsx";
import { ChannelsMessageList } from "./channels-message-list.tsx";
import { useChannelsMessageWindow, type ChannelsMessage as Message } from "./channels-message-window.ts";
import { useChannelsDirectName, useChannelsMentionPeople, type ChannelsPerson } from "./channels-people.ts";
import type { ChannelsDialogKind } from "./channels-dialogs.tsx";
import type { ChannelsSearch } from "./channels.tsx";
import { ChannelsPosts } from "./channels-posts.tsx";
import type { file_quotes_Quote } from "../../../shared/file-quotes.ts";
import { ChannelsLayoutContext } from "./channels-layout-context.ts";
import { ChannelsPaneHeader } from "./channels-pane-header.tsx";

type Channel = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel>>;
type ChannelState = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel_state>>;
type ChannelsConversation_ClassNames =
	| "ChannelsConversation"
	| "ChannelsConversation-direct-avatar"
	| "ChannelsConversation-thread"
	| "ChannelsConversation-notice";
type ChannelsConversation_CustomAttributes = {
	"data-channel-id": string;
	"data-can-post": string;
};

export const ChannelsConversation = memo(function ChannelsConversation(props: {
	channel: Channel;
	state: ChannelState;
	people: readonly ChannelsPerson[];
	search: ChannelsSearch;
	narrow: boolean;
	width: number;
	onNavigate: (id: app_convex_Id<"channels">, search?: ChannelsSearch) => void;
	onDialog: (kind: ChannelsDialogKind) => void;
}) {
	const { channel, state, people, search, narrow, width, onNavigate, onDialog } = props;
	const region = useRef<HTMLElement>(null);
	const threadPanel = useRef<ImperativePanelHandle>(null);
	const opener = useRef<HTMLElement | null>(null);
	const [paneWidth, setPaneWidth] = useState(width);
	const [threadWidth, setThreadWidth] = useAppLocalStorageStateValue("app_state::channels_thread_width");
	const threadLayout = useRef(0);
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const document = channel.channel;
	const members = usePaginatedQuery(
		app_convex_api.channels.list_channel_members,
		{ membershipId, channelId: document._id },
		{ initialNumItems: 50 },
	);
	const joined = usePaginatedQuery(app_convex_api.channels.list_my_channels, { membershipId }, { initialNumItems: 50 });
	const publicChannels = usePaginatedQuery(
		app_convex_api.channels.browse_public_channels,
		{ membershipId, archived: false },
		{ initialNumItems: 50 },
	);
	const posts =
		document.kind === "file" ||
		((document.kind === "public" || document.kind === "private") && document.layout === "posts");
	const rootId = search.thread ?? (posts ? search.message : null) ?? null;
	const thread = useQuery(
		app_convex_api.channels_messages.get_thread_by_root,
		rootId ? { membershipId, rootMessageId: rootId } : "skip",
	);
	const directName = useChannelsDirectName(
		document.kind === "direct" ? document.participantUserIds.filter((id) => id !== userId) : [],
		people,
	);
	const name =
		document.kind === "direct"
			? directName
			: document.kind === "file"
				? (channel.file?.name ?? "File")
				: `#${document.name}`;
	const resolvable =
		document.kind === "file" ||
		((document.kind === "public" || document.kind === "private") && document.resolvableThreads);
	const peopleMentions = useChannelsMentionPeople({ channelId: document._id }, people);
	const mentionItems: ChannelsMentionItem[] = [
		...peopleMentions,
		...Array.from(
			new Map([...joined.results, ...publicChannels.results].map((item) => [item._id, item])).values(),
		).flatMap((item) =>
			item.kind === "public" || item.kind === "private"
				? [
						{
							kind: "channel" as const,
							id: item._id,
							label: item.name,
							href: `${url_path_messages({ organizationName, workspaceName })}/${item._id}`,
						},
					]
				: [],
		),
	];
	const openThread = useFn((id: app_convex_Id<"channels_messages">) => {
		opener.current =
			globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
		onNavigate(document._id, { thread: id });
	});
	const closeThread = useFn(() => {
		onNavigate(document._id);
		requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
	});
	const jump = useFn(
		(messageId: app_convex_Id<"channels_messages">, threadRootId: app_convex_Id<"channels_messages"> | null) =>
			onNavigate(document._id, {
				...(threadRootId ? { thread: threadRootId } : {}),
				message: messageId,
			}),
	);

	useEffect(() => {
		if (members.status === "CanLoadMore") members.loadMore(50);
	}, [members.status, members.loadMore]);
	useEffect(() => {
		if (!region.current) return;
		const observer = new ResizeObserver(([entry]) => setPaneWidth(entry!.contentRect.width));
		observer.observe(region.current);
		return () => observer.disconnect();
	}, []);
	const split = !!rootId && !narrow && paneWidth >= 922;
	const available = Math.max(1, paneWidth - 2);
	const maximumThread = Math.min(480, Math.max(360, available - 560));
	const actualThreadWidth = Math.min(threadWidth, maximumThread);
	useEffect(() => {
		if (split) threadPanel.current?.resize((actualThreadWidth / available) * 100);
	}, [split, actualThreadWidth, available]);
	const header = (
		<ChannelsPaneHeader
			title={
				<MyButton
					variant="ghost"
					tooltip={name}
					aria-label={`Details for ${name}`}
					onClick={() => onDialog("settings")}
				>
					{document.kind === "private" ? (
						<Lock size={16} />
					) : document.kind === "file" ? (
						<FileText size={16} />
					) : document.kind === "public" ? (
						<Hash size={16} />
					) : (
						<MyAvatar className={"ChannelsConversation-direct-avatar" satisfies ChannelsConversation_ClassNames}>
							<MyAvatarImage
								src={
									people.find(
										(person) =>
											document.kind === "direct" &&
											document.participantUserIds.filter((id) => id !== userId)[0] === person.id,
									)?.avatarUrl
								}
								alt=""
							/>
							<MyAvatarFallback>{directName.slice(0, 2)}</MyAvatarFallback>
						</MyAvatar>
					)}
					<span>{document.kind === "public" || document.kind === "private" ? document.name : name}</span>
				</MyButton>
			}
		>
			{document.kind === "file" && channel.file && (
				<a
					className={cn(
						"MyButton" satisfies MyButton_ClassNames,
						"MyButton-variant-default" satisfies MyButton_ClassNames,
					)}
					href={url_path_file_by_node_id({ organizationName, workspaceName, nodeId: document.fileNodeId })}
				>
					Open file
				</a>
			)}
			<MyButton aria-label={`Members of ${name}: ${members.results.length}`} onClick={() => onDialog("members")}>
				<Users size={16} />
				{members.results.length}
				{members.status === "CanLoadMore" ? "+" : ""}
			</MyButton>
			<MyMenu>
				<MyMenuTrigger>
					<MyIconButton tooltip={`More for ${name}`}>
						<MoreHorizontal />
					</MyIconButton>
				</MyMenuTrigger>
				<MyMenuPopover aria-label="Conversation actions">
					<MyMenuItem onClick={() => requestAnimationFrame(() => onDialog("settings"))}>Channel details</MyMenuItem>
					<MyMenuItem onClick={() => requestAnimationFrame(() => onDialog("members"))}>Members</MyMenuItem>
				</MyMenuPopover>
			</MyMenu>
		</ChannelsPaneHeader>
	);
	const notice = (
		<>
			{(document.kind === "private" || document.kind === "direct") && (
				<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>
					The organization owner can read this {document.kind === "direct" ? "conversation" : "channel"}.
				</p>
			)}
			{!channel.canPost && (
				<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>{channel.postRefusal}</p>
			)}
		</>
	);
	const main = (
		<>
			{header}
			{notice}
			{posts ? (
				<div className={"app-scrollable" satisfies AppClassName}>
					<ChannelsPosts
						key={document._id}
						channelId={document._id}
						fileNodeId={document.kind === "file" ? document.fileNodeId : undefined}
						state={state}
						canPost={channel.canPost}
						mentionItems={mentionItems}
						onThread={openThread}
					/>
				</div>
			) : (
				<ChannelsConversationPane
					key={document._id}
					channel={channel}
					name={name}
					root={null}
					readSequence={state.readSequence}
					mentionItems={mentionItems}
					jumpMessageId={!rootId ? search.message : undefined}
					resolvable={resolvable}
					onThread={openThread}
					onJump={jump}
				/>
			)}
		</>
	);
	const replies =
		thread?.root.message.channelId === document._id ? (
			<ChannelsConversationPane
				key={rootId}
				channel={channel}
				name={name}
				root={thread.root}
				readSequence={0}
				mentionItems={mentionItems}
				jumpMessageId={search.message}
				resolvable={resolvable}
				onClose={closeThread}
				back={!split}
				notice={!split ? notice : undefined}
				onThread={openThread}
				onJump={jump}
			/>
		) : (
			<>
				<ChannelsPaneHeader title="Thread" showSidebarToggle={false} onBack={!split ? closeThread : undefined}>
					{split && (
						<MyIconButton tooltip="Close thread" onClick={closeThread}>
							<X />
						</MyIconButton>
					)}
				</ChannelsPaneHeader>
				{!split && notice}
				<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>
					{thread === undefined ? "Loading thread…" : "Thread not found"}
				</p>
			</>
		);
	return (
		<section
			ref={region}
			className={"ChannelsConversation" satisfies ChannelsConversation_ClassNames}
			aria-label={name}
			{...({
				"data-channel-id": document._id,
				"data-can-post": String(channel.canPost),
			} satisfies ChannelsConversation_CustomAttributes)}
		>
			<MyPanelGroup
				direction="horizontal"
				defaultLayout={[100 - (380 / available) * 100, (380 / available) * 100]}
				onLayout={(layout) => {
					threadLayout.current = layout[1]!;
				}}
			>
				<MyPanel
					order={1}
					isOpen={!rootId || split}
					closeBehavior="hidden"
					minSize={split ? (560 / available) * 100 : 0}
				>
					{main}
				</MyPanel>
				<MyPanelResizeHandle
					isOpen={split}
					closeBehavior="hidden"
					onKeyUp={(event) => {
						if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
							setThreadWidth(Math.max(360, Math.min(maximumThread, (threadLayout.current * available) / 100)));
					}}
					onDragging={(dragging) => {
						if (!dragging)
							setThreadWidth(Math.max(360, Math.min(maximumThread, (threadLayout.current * available) / 100)));
					}}
				/>
				<MyPanel
					ref={threadPanel}
					order={2}
					isOpen={!!rootId}
					closeBehavior="hidden"
					defaultSize={split ? (actualThreadWidth / available) * 100 : 40}
					minSize={split ? (360 / available) * 100 : 0}
					maxSize={split ? (maximumThread / available) * 100 : 100}
				>
					<aside
						aria-label="Thread"
						className={"ChannelsConversation-thread" satisfies ChannelsConversation_ClassNames}
					>
						{replies}
					</aside>
				</MyPanel>
			</MyPanelGroup>
		</section>
	);
});

type ChannelsConversationPane_ClassNames =
	| "ChannelsConversationPane"
	| "ChannelsConversationPane-root"
	| "ChannelsConversationPane-indicator"
	| "ChannelsConversationPane-reply-count"
	| "ChannelsConversationPane-composer"
	| "ChannelsConversationPane-tools"
	| "ChannelsConversationPane-reply"
	| "ChannelsConversationPane-error";
type ChannelsConversationPane_CustomAttributes = {
	"data-pane": "thread" | "channel";
	"data-thread-root"?: string;
};

export const ChannelsConversationPane = memo(function ChannelsConversationPane(props: {
	channel: Channel;
	name: string;
	root: Message | null;
	readSequence: number;
	mentionItems: readonly ChannelsMentionItem[];
	quoteRequest?: file_quotes_Quote | null;
	onQuoteInserted?: () => void;
	jumpMessageId: string | undefined;
	resolvable: boolean;
	notice?: ReactNode;
	onClose?: () => void;
	back?: boolean;
	backLabel?: string;
	onThread: ComponentProps<typeof ChannelsMessage>["onThread"];
	onJump: ComponentProps<typeof ChannelsMessage>["onJump"];
}) {
	const {
		channel,
		name,
		root,
		readSequence,
		mentionItems,
		quoteRequest,
		onQuoteInserted,
		jumpMessageId,
		resolvable,
		notice,
		onClose,
		back = false,
		backLabel,
		onThread,
		onJump,
	} = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const connection = useConvexConnectionState();
	const channelId = channel.channel._id;
	const rootMessageId = root?.message._id;
	const window = useChannelsMessageWindow({
		membershipId,
		target: rootMessageId ? { rootMessageId } : { channelId },
		enabled: true,
	});
	const threadState = useQuery(
		app_convex_api.channels_messages.get_thread_state,
		rootMessageId ? { membershipId, rootMessageId } : "skip",
	);
	const jumpTarget = useQuery(
		app_convex_api.channels_messages.get_message,
		jumpMessageId ? { membershipId, messageId: jumpMessageId } : "skip",
	);
	const [entryRead, setEntryRead] = useState<number | null>(root ? null : readSequence);
	if (entryRead === null && threadState !== undefined) setEntryRead(threadState?.follower?.readReplySequence ?? 0);
	const lastRead = useRef(root ? 0 : readSequence);
	const visitedJump = useRef<string | null>(null);
	const composer = useRef<ChannelsComposerControl_Ref>(null);
	const draftKey = rootMessageId ? `thread:${rootMessageId}` : `channel:${channelId}`;
	const storageKey = `app_state::channels_drafts::scope::${membershipId}` as const;
	const [draft] = useState(() => app_local_storage_get_value(storageKey)[draftKey] ?? "");
	const [empty, setEmpty] = useState(!draft.trim());
	const [reply, setReply] = useState<{
		row: Message;
		quote: string | null;
	} | null>(null);
	const [alsoInChannel, setAlsoInChannel] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [deleteMessage, setDeleteMessage] = useState<Message | null>(null);
	const [title, setTitle] = useState(root?.thread?.title ?? "");
	const [renaming, setRenaming] = useState(false);
	const layout = useContext(ChannelsLayoutContext);
	const retry = useRef<{ signature: string; id: string } | null>(null);
	const editing = window.editingMessage;
	const changeDraft = useFn(() => {
		setEmpty(composer.current?.isEmpty() ?? true);
		if (!editing)
			app_local_storage_set_value(storageKey, (previous) => ({
				...previous,
				[draftKey]: composer.current?.getDraftContent() ?? "",
			}));
		setError("");
	});
	const cancel = useFn(() => {
		window.setEditingMessage(null);
		setReply(null);
		setError("");
	});
	const submit = useFn(async (event?: FormEvent) => {
		event?.preventDefault();
		if (
			!channel.canPost ||
			!connection.isWebSocketConnected ||
			busy ||
			!composer.current ||
			composer.current.hasPendingUploads() ||
			composer.current.isEmpty()
		)
			return;
		setBusy(true);
		setError("");
		const body = composer.current.getMarkdownContent();
		const mentionUserIds = composer.current.getMentionUserIds();
		const fileMentionIds = composer.current.getFileMentionIds();
		const fileQuotes = composer.current.getFileQuotes();
		const payload = {
			membershipId,
			target: rootMessageId ? { kind: "thread" as const, rootMessageId } : { kind: "channel" as const, channelId },
			body,
			mentionUserIds,
			fileMentionIds,
			fileQuotes,
			replyTo: reply ? { messageId: reply.row.message._id, quote: reply.quote } : null,
			attachments: composer.current.getAttachments(),
			alsoInChannel,
			title: null,
		};
		const signature = JSON.stringify(payload);
		if (!retry.current || retry.current.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
		await (
			editing
				? app_convex.mutation(app_convex_api.channels_messages.edit_message, {
						membershipId,
						messageId: editing.message._id,
						expectedRevision: editing.message.revision,
						body,
						mentionUserIds,
						fileMentionIds,
						fileQuotes,
					})
				: app_convex.mutation(app_convex_api.channels_messages.send_message, {
						...payload,
						clientMessageId: retry.current.id,
					})
		)
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return;
				}
				if (editing) window.setEditingMessage(null);
				else {
					composer.current?.clear();
					app_local_storage_set_value(storageKey, (previous) => {
						const next = { ...previous };
						delete next[draftKey];
						return next;
					});
					setReply(null);
					setEmpty(true);
					retry.current = null;
					window.latest();
				}
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.submit] Failed to send message", { error });
				setError("Could not send. Your draft is saved. Try again.");
			})
			.finally(() => setBusy(false));
	});
	const markRead = useFn((sequence: number) => {
		if (sequence <= lastRead.current && !(root && threadState?.follower?.pendingRootMention)) return;
		lastRead.current = sequence;
		const request = rootMessageId
			? app_convex.mutation(app_convex_api.channels_messages.mark_thread_read, {
					membershipId,
					rootMessageId,
					replySequence: sequence,
				})
			: app_convex.mutation(app_convex_api.channels.mark_read, {
					membershipId,
					channelId,
					sequence,
				});
		request
			.then((result) => {
				if (result._nay)
					console.error("[ChannelsConversationPane.markRead] Failed to mark read", { error: result._nay });
			})
			.catch((error: unknown) => {
				lastRead.current = 0;
				console.error("[ChannelsConversationPane.markRead] Failed to mark read", { error });
			});
	});
	const reaction = useFn((messageId: app_convex_Id<"channels_messages">, emoji: string) => {
		app_convex
			.mutation(app_convex_api.channels_messages.toggle_reaction, {
				membershipId,
				messageId,
				emoji,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.reaction] Failed to change reaction", { error });
				toast.error("Could not change reaction");
			});
	});
	const unread = useFn((messageId: app_convex_Id<"channels_messages">) => {
		app_convex
			.mutation(app_convex_api.channels.mark_unread, {
				membershipId,
				messageId,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
				else toast.success("Marked unread");
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.unread] Failed to mark unread", { error });
				toast.error("Could not mark unread");
			});
	});
	const copyLink = useFn((row: Message) => {
		const url = new URL(`${url_path_messages({ organizationName, workspaceName })}/${channelId}`, location.origin);
		url.searchParams.set("message", row.message._id);
		if (row.message.threadRootId) url.searchParams.set("thread", row.message.threadRootId);
		navigator.clipboard
			.writeText(url.toString())
			.then(() => toast.success("Link copied"))
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.copyLink] Failed to copy link", { error });
				toast.error("Could not copy link");
			});
	});
	const resolve = useFn((row: Message) => {
		app_convex
			.mutation(
				row.thread?.isResolved
					? app_convex_api.channels_messages.reopen_thread
					: app_convex_api.channels_messages.resolve_thread,
				{
					membershipId,
					rootMessageId: row.message.threadRootId ?? row.message._id,
				},
			)
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.resolve] Failed to change thread", { error });
				toast.error("Could not change thread");
			});
	});
	const edit = useFn((row: Message) => {
		setReply(null);
		window.setEditingMessage(row);
		setError("");
	});
	const replyTo = useFn((row: Message, quote: string | null) => {
		window.setEditingMessage(null);
		setReply({ row, quote });
		composer.current?.focus();
	});
	const actions = {
		onReply: replyTo,
		onThread,
		onJump,
		onEdit: edit,
		onDelete: setDeleteMessage,
		onReaction: reaction,
		onUnread: unread,
		onCopyLink: copyLink,
		onResolve: resolve,
	};
	const remove = useFn(async () => {
		if (!deleteMessage || busy) return;
		setBusy(true);
		await app_convex
			.mutation(app_convex_api.channels_messages.delete_message, {
				membershipId,
				messageId: deleteMessage.message._id,
			})
			.then((result) => {
				if (result._nay) setError(result._nay.message);
				else setDeleteMessage(null);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.remove] Failed to delete message", { error });
				setError("Could not delete message");
			})
			.finally(() => setBusy(false));
	});
	const follow = useFn(() => {
		if (!rootMessageId) return;
		app_convex
			.mutation(
				threadState?.follower?.following
					? app_convex_api.channels_messages.unfollow_thread
					: app_convex_api.channels_messages.follow_thread,
				{ membershipId, rootMessageId },
			)
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.follow] Failed to change follow", { error });
				toast.error("Could not change follow");
			});
	});
	const saveTitle = useFn((event: FormEvent) => {
		event.preventDefault();
		if (!rootMessageId) return;
		app_convex
			.mutation(app_convex_api.channels_messages.set_thread_title, {
				membershipId,
				rootMessageId,
				title: title.trim() || null,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
				else setRenaming(false);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsConversationPane.saveTitle] Failed to save title", { error });
				toast.error("Could not save title");
			});
	});

	useEffect(() => {
		if (
			!jumpTarget ||
			visitedJump.current === jumpMessageId ||
			jumpTarget.message.channelId !== channelId ||
			jumpTarget.message.threadRootId !== (rootMessageId ?? null)
		)
			return;
		visitedJump.current = jumpMessageId ?? null;
		if (!window.rows.some((row) => row.message._id === jumpTarget.message._id))
			window.jump(rootMessageId ? jumpTarget.message.threadSequence! : jumpTarget.message.mainSequence!);
	}, [jumpTarget, jumpMessageId, channelId, rootMessageId, window]);
	useEffect(() => {
		if (!rootMessageId) return;
		const element = document.querySelector(
			`[${"data-thread-root" satisfies keyof ChannelsConversationPane_CustomAttributes}="${rootMessageId}"]`,
		);
		if (!element) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting) && document.visibilityState === "visible") markRead(0);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [rootMessageId, markRead, threadState?.follower?.pendingRootMention]);
	return (
		<div
			className={"ChannelsConversationPane" satisfies ChannelsConversationPane_ClassNames}
			{...({ "data-pane": root ? "thread" : "channel" } satisfies Pick<
				ChannelsConversationPane_CustomAttributes,
				"data-pane"
			>)}
		>
			{root && (
				<ChannelsPaneHeader
					showSidebarToggle={false}
					title={
						<strong title={root.thread?.title ?? (back ? name : "Thread")}>
							Thread{root.thread?.title ? ` · ${root.thread.title}` : back ? ` · ${name}` : ""}
						</strong>
					}
					onBack={back ? onClose : undefined}
					backLabel={backLabel}
				>
					{threadState?.follower?.following && (
						<span className={"ChannelsConversationPane-indicator" satisfies ChannelsConversationPane_ClassNames}>
							Following
						</span>
					)}
					{root.thread?.isResolved && (
						<span className={"ChannelsConversationPane-indicator" satisfies ChannelsConversationPane_ClassNames}>
							Resolved
						</span>
					)}
					<MyMenu>
						<MyMenuTrigger>
							<MyIconButton tooltip="More thread actions">
								<MoreHorizontal />
							</MyIconButton>
						</MyMenuTrigger>
						<MyMenuPopover aria-label="Thread actions">
							<MyMenuItem onClick={follow}>
								{threadState?.follower?.following ? "Unfollow thread" : "Follow thread"}
							</MyMenuItem>
							{channel.canPost && (root.message.authorUserId === userId || channel.canManage) && (
								<MyMenuItem
									onClick={() => {
										setTitle(root.thread?.title ?? "");
										requestAnimationFrame(() => setRenaming(true));
									}}
								>
									Rename thread
								</MyMenuItem>
							)}
							{resolvable && channel.canPost && (
								<MyMenuItem onClick={() => resolve(root)}>{root.thread?.isResolved ? "Reopen" : "Resolve"}</MyMenuItem>
							)}
							{back && layout && (
								<MyMenuItem onClick={() => requestAnimationFrame(layout.openSidebar)}>
									<Menu size={16} />
									Open channels
								</MyMenuItem>
							)}
						</MyMenuPopover>
					</MyMenu>
					{onClose && !back && (
						<MyIconButton tooltip="Close thread" onClick={onClose}>
							<X />
						</MyIconButton>
					)}
				</ChannelsPaneHeader>
			)}
			{notice}
			<ChannelsMessageList
				window={window}
				name={name}
				thread={!!root}
				readSequence={entryRead ?? 0}
				jumpMessageId={jumpMessageId && app_convex_is_id_like(jumpMessageId) ? jumpMessageId : undefined}
				canPost={channel.canPost}
				canManage={channel.canManage}
				resolvable={resolvable}
				onRead={markRead}
				{...actions}
			>
				{root && (
					<>
						<div
							className={"ChannelsConversationPane-root" satisfies ChannelsConversationPane_ClassNames}
							data-thread-root={rootMessageId}
						>
							<ChannelsMessage
								row={root}
								grouped={false}
								unread={false}
								tabIndex={0}
								sequence={0}
								canPost={channel.canPost}
								canManage={channel.canManage}
								resolvable={resolvable}
								hideThreadSummary
								{...actions}
							/>
						</div>
						<div className={"ChannelsConversationPane-reply-count" satisfies ChannelsConversationPane_ClassNames}>
							{root.thread?.replyCount
								? `${root.thread.replyCount} ${root.thread.replyCount === 1 ? "reply" : "replies"}`
								: "No replies yet"}
						</div>
					</>
				)}
			</ChannelsMessageList>
			{channel.canPost && (
				<form
					className={"ChannelsConversationPane-composer" satisfies ChannelsConversationPane_ClassNames}
					onSubmit={submit}
				>
					<ChannelsComposer
						key={editing?.message._id ?? "draft"}
						controlRef={composer}
						initialValue={
							editing
								? channels_composer_markdown_for_edit(
										editing.message.body,
										editing.message.mentionUserIds,
										editing.fileMentions,
										editing.message.fileQuotes,
									)
								: (app_local_storage_get_value(storageKey)[draftKey] ?? "")
						}
						placeholder={root ? "Reply to thread…" : `Message ${name}…`}
						ariaLabel={editing ? "Edit message" : root ? "Thread reply" : "Message"}
						attachmentTarget={editing ? undefined : { kind: "channel", channelId }}
						autoFocus={editing || (root && !jumpMessageId) ? "end" : false}
						disabled={busy}
						submitTooltip={editing ? "Save edit (Enter)" : "Send (Enter)"}
						submitLabel={busy ? "Sending…" : editing ? "Save changes" : "Send"}
						submitDisabled={busy || !connection.isWebSocketConnected || empty}
						onChange={changeDraft}
						onEnter={submit}
						onEscape={reply || editing ? cancel : undefined}
						onEmptyUp={() => {
							const latest = [...window.rows]
								.reverse()
								.find((row) => row.message.authorUserId === userId && row.message.deletedAt === null);
							if (latest) edit(latest);
						}}
						mentionItems={mentionItems}
						quoteRequest={editing ? null : quoteRequest}
						onQuoteInserted={onQuoteInserted}
					>
						{(reply || editing) && (
							<div className={"ChannelsConversationPane-reply" satisfies ChannelsConversationPane_ClassNames}>
								<span>
									{editing
										? "Editing message"
										: `Replying to ${reply!.row.authorName}: ${reply!.quote ?? reply!.row.message.body.slice(0, 160)}`}
								</span>
								<MyIconButton tooltip={editing ? "Cancel edit" : "Cancel reply"} onClick={cancel}>
									<X />
								</MyIconButton>
							</div>
						)}
					</ChannelsComposer>
					<div className={"ChannelsConversationPane-tools" satisfies ChannelsConversationPane_ClassNames}>
						{root && channel.channel.kind !== "file" && (
							<label>
								<input
									type="checkbox"
									checked={alsoInChannel}
									onChange={(event) => setAlsoInChannel(event.target.checked)}
								/>{" "}
								Also send to channel
							</label>
						)}
						<span>Enter to send · Shift+Enter for a new line</span>
					</div>
					{error && (
						<p role="alert" className={"ChannelsConversationPane-error" satisfies ChannelsConversationPane_ClassNames}>
							{error}
						</p>
					)}
					{!connection.isWebSocketConnected && <p role="status">Connecting… Your draft is saved on this device.</p>}
				</form>
			)}
			<MyModal open={renaming} setOpen={setRenaming}>
				<MyModalPopover aria-label="Rename thread">
					<form onSubmit={saveTitle}>
						<MyModalHeader>
							<MyModalHeading>Rename thread</MyModalHeading>
							<MyModalCloseTrigger />
						</MyModalHeader>
						<MyModalScrollableArea>
							<MyInput>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										aria-label="Thread title"
										maxLength={200}
										value={title}
										onChange={(event) => setTitle(event.target.value)}
									/>
								</MyInputArea>
								<MyInputBox />
							</MyInput>
						</MyModalScrollableArea>
						<MyModalFooter>
							<MyButton onClick={() => setRenaming(false)}>Cancel</MyButton>
							<MyButton type="submit">Save title</MyButton>
						</MyModalFooter>
					</form>
				</MyModalPopover>
			</MyModal>
			<MyModal
				open={deleteMessage !== null}
				setOpen={(open) => {
					if (!open) setDeleteMessage(null);
				}}
			>
				<MyModalPopover aria-label="Delete message">
					<MyModalHeader>
						<MyModalHeading>Delete message?</MyModalHeading>
						<MyModalCloseTrigger />
					</MyModalHeader>
					<MyModalScrollableArea>
						<p>The message text will be removed. Its replies will stay.</p>
						{error && <p role="alert">{error}</p>}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton onClick={() => setDeleteMessage(null)}>Cancel</MyButton>
						<MyButton variant="destructive" disabled={busy} onClick={remove}>
							Delete
						</MyButton>
					</MyModalFooter>
				</MyModalPopover>
			</MyModal>
		</div>
	);
});
