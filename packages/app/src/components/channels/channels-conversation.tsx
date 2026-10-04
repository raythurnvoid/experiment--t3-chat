import "./channels-conversation.css";
import { memo, useEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { useConvexConnectionState, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, Users, X } from "lucide-react";
import { toast } from "sonner";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
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
import { app_local_storage_get_value, app_local_storage_set_value } from "@/lib/storage.ts";
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

type Channel = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel>>;
type ChannelState = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel_state>>;
type ChannelsConversation_ClassNames =
	| "ChannelsConversation"
	| "ChannelsConversation-header"
	| "ChannelsConversation-name"
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
	onNavigate: (id: app_convex_Id<"channels">, search?: ChannelsSearch) => void;
	onDialog: (kind: ChannelsDialogKind) => void;
}) {
	const { channel, state, people, search, narrow, onNavigate, onDialog } = props;
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
	const openThread = useFn((id: app_convex_Id<"channels_messages">) => onNavigate(document._id, { thread: id }));
	const closeThread = useFn(() => onNavigate(document._id));
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
	const main = posts ? (
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
				onThread={openThread}
				onJump={jump}
			/>
		) : (
			<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>
				{thread === undefined ? "Loading thread…" : "Thread not found"}
			</p>
		);
	return (
		<section
			className={"ChannelsConversation" satisfies ChannelsConversation_ClassNames}
			aria-label={name}
			{...({
				"data-channel-id": document._id,
				"data-can-post": String(channel.canPost),
			} satisfies ChannelsConversation_CustomAttributes)}
		>
			<header className={"ChannelsConversation-header" satisfies ChannelsConversation_ClassNames}>
				<div className={"ChannelsConversation-name" satisfies ChannelsConversation_ClassNames}>
					<h1 title={channel.file?.path}>{name}</h1>
					{(document.kind === "public" || document.kind === "private") && document.topic && <p>{document.topic}</p>}
				</div>
				<MyButton aria-label={`Members of ${name}: ${members.results.length}`} onClick={() => onDialog("members")}>
					<Users size={16} />
					{members.results.length}
					{members.status === "CanLoadMore" ? "+" : ""}
				</MyButton>
				{document.kind === "file" && channel.file && (
					<a
						className={cn(
							"MyButton" satisfies MyButton_ClassNames,
							"MyButton-variant-default" satisfies MyButton_ClassNames,
						)}
						href={url_path_file_by_node_id({
							organizationName,
							workspaceName,
							nodeId: document.fileNodeId,
						})}
					>
						Open file
					</a>
				)}
				<MyButton onClick={() => onDialog("settings")}>Details</MyButton>
			</header>
			{(document.kind === "private" || document.kind === "direct") && (
				<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>
					The organization owner can read this {document.kind === "direct" ? "conversation" : "channel"}.
				</p>
			)}
			{!channel.canPost && (
				<p className={"ChannelsConversation-notice" satisfies ChannelsConversation_ClassNames}>{channel.postRefusal}</p>
			)}
			{rootId ? (
				narrow ? (
					<aside
						aria-label="Thread"
						className={"ChannelsConversation-thread" satisfies ChannelsConversation_ClassNames}
					>
						<header className={"ChannelsConversation-header" satisfies ChannelsConversation_ClassNames}>
							<MyButton onClick={closeThread}>
								<ArrowLeft size={16} />
								Back to channel
							</MyButton>
							<MyIconButton tooltip="Close thread" onClick={closeThread}>
								<X />
							</MyIconButton>
						</header>
						{replies}
					</aside>
				) : (
					<MyPanelGroup direction="horizontal" defaultLayout={[60, 40]}>
						<MyPanel defaultSize={60} minSize={30}>
							{main}
						</MyPanel>
						<MyPanelResizeHandle />
						<MyPanel defaultSize={40} minSize={25}>
							<aside
								aria-label="Thread"
								className={"ChannelsConversation-thread" satisfies ChannelsConversation_ClassNames}
							>
								<header className={"ChannelsConversation-header" satisfies ChannelsConversation_ClassNames}>
									<strong>Thread</strong>
									<MyIconButton tooltip="Close thread" onClick={closeThread}>
										<X />
									</MyIconButton>
								</header>
								{replies}
							</aside>
						</MyPanel>
					</MyPanelGroup>
				)
			) : (
				main
			)}
		</section>
	);
});

type ChannelsConversationPane_ClassNames =
	| "ChannelsConversationPane"
	| "ChannelsConversationPane-root"
	| "ChannelsConversationPane-thread-controls"
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
				<>
					<div
						className={cn(
							"ChannelsConversationPane-root" satisfies ChannelsConversationPane_ClassNames,
							"app-scrollable" satisfies AppClassName,
						)}
						{...({ "data-thread-root": rootMessageId } satisfies Pick<
							ChannelsConversationPane_CustomAttributes,
							"data-thread-root"
						>)}
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
							{...actions}
						/>
					</div>
					<div className={"ChannelsConversationPane-thread-controls" satisfies ChannelsConversationPane_ClassNames}>
						<MyButton aria-pressed={threadState?.follower?.following ?? false} onClick={follow}>
							{threadState?.follower?.following ? "Following" : "Follow thread"}
						</MyButton>
						{resolvable && channel.canPost && (
							<MyButton onClick={() => resolve(root)}>{root.thread?.isResolved ? "Reopen" : "Resolve"}</MyButton>
						)}
						{channel.canPost && (root.message.authorUserId === userId || channel.canManage) ? (
							<form onSubmit={saveTitle}>
								<MyInput>
									<MyInputBackground />
									<MyInputArea>
										<MyInputControl
											aria-label="Thread title"
											maxLength={200}
											value={title}
											onChange={(event) => setTitle(event.target.value)}
											placeholder="Thread title"
										/>
									</MyInputArea>
									<MyInputBox />
								</MyInput>
								<MyButton type="submit">Save title</MyButton>
							</form>
						) : (
							root.thread?.title && <strong>{root.thread.title}</strong>
						)}
					</div>
				</>
			)}
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
			/>
			{channel.canPost && (
				<form
					className={"ChannelsConversationPane-composer" satisfies ChannelsConversationPane_ClassNames}
					onSubmit={submit}
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
						autoFocus={editing ? "end" : false}
						disabled={busy}
						submitTooltip={editing ? "Save edit (Enter)" : "Send (Enter)"}
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
					/>
					<div className={"ChannelsConversationPane-tools" satisfies ChannelsConversationPane_ClassNames}>
						{root && channel.channel.kind !== "file" && (
							<MyCheckboxButton checked={alsoInChannel} onCheckedChange={setAlsoInChannel} variant="outline">
								Also send to channel
							</MyCheckboxButton>
						)}
						<span>Enter to send · Shift+Enter for a new line</span>
					</div>
					{error && (
						<p role="alert" className={"ChannelsConversationPane-error" satisfies ChannelsConversationPane_ClassNames}>
							{error}
						</p>
					)}
				</form>
			)}
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
