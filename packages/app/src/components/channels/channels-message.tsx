import "./channels-message.css";
import { lazy, memo, Suspense, useState, type KeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { Check, CornerUpLeft, MessageSquare, MoreHorizontal, SmilePlus } from "lucide-react";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { AiChatMarkdown } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { FileQuote } from "@/components/file-quotes/file-quote.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyMenu, MyMenuItem, MyMenuPopover, MyMenuTrigger } from "@/components/my-menu.tsx";
import { MyPopover, MyPopoverContent, MyPopoverTrigger } from "@/components/my-popover.tsx";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import { url_path_file_by_node_id } from "@/lib/urls.ts";
import {
	channels_file_quotes_to_draft,
	channels_render_file_mentions,
	channels_render_people_mentions,
} from "../../../shared/channels.ts";
import { file_quotes_parse_draft } from "../../../shared/file-quotes.ts";
import type { ChannelsMessage as ChannelsMessageData } from "./channels-message-window.ts";
import { ChannelsUpload } from "./channels-upload.tsx";

const ChannelsEmojiPicker = lazy(() => import("./channels-emoji-picker.tsx"));
type ChannelsMessage_ClassNames =
	| "ChannelsMessage"
	| "ChannelsMessage-avatar"
	| "ChannelsMessage-content"
	| "ChannelsMessage-header"
	| "ChannelsMessage-actions"
	| "ChannelsMessage-reply"
	| "ChannelsMessage-attachments"
	| "ChannelsMessage-reactions"
	| "ChannelsMessage-deleted"
	| "ChannelsMessage-thread";

export const ChannelsMessageContent = memo(function ChannelsMessageContent(props: { row: ChannelsMessageData }) {
	const { row } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const parts = file_quotes_parse_draft(
		channels_file_quotes_to_draft(
			channels_render_file_mentions(
				channels_render_people_mentions(row.message.body, row.mentionNames),
				row.fileMentions.map((file) =>
					file.kind === "file"
						? {
								name: file.name,
								href: url_path_file_by_node_id({ organizationName, workspaceName, nodeId: file.fileNodeId }),
							}
						: null,
				),
			),
			row.message.fileQuotes,
		),
	);
	return (
		<>
			{row.message.deletedAt !== null ? (
				<p className={"ChannelsMessage-deleted" satisfies ChannelsMessage_ClassNames}>This message was deleted</p>
			) : (
				parts.map((part, index) =>
					part.type === "data-file-quote" ? (
						<FileQuote key={index} quote={part.data} />
					) : (
						<AiChatMarkdown key={index} markdown={part.text} />
					),
				)
			)}
			{row.attachments.length > 0 && (
				<div className={"ChannelsMessage-attachments" satisfies ChannelsMessage_ClassNames}>
					{row.attachments.map((attachment, index) =>
						attachment.kind === "unavailable" ? (
							<span key={index}>File unavailable</span>
						) : attachment.kind === "upload" ? (
							<ChannelsUpload key={attachment.uploadId} upload={attachment} />
						) : (
							<a
								key={attachment.fileNodeId}
								href={url_path_file_by_node_id({ organizationName, workspaceName, nodeId: attachment.fileNodeId })}
								title={attachment.path}
							>
								{attachment.name}
							</a>
						),
					)}
				</div>
			)}
		</>
	);
});

export type ChannelsMessage_CustomAttributes = {
	"data-message-id": string;
	"data-root-message-id": string;
	"data-sequence": number;
	"data-unread": string;
	"data-grouped": string;
	"data-thread-resolved": string;
	"data-reply-count": number;
};

export const ChannelsMessage = memo(function ChannelsMessage(props: {
	row: ChannelsMessageData;
	grouped: boolean;
	unread: boolean;
	tabIndex: number;
	sequence: number;
	canPost: boolean;
	canManage: boolean;
	resolvable: boolean;
	onFocus?: () => void;
	onReply: (row: ChannelsMessageData, quote: string | null) => void;
	onThread: (rootMessageId: app_convex_Id<"channels_messages">) => void;
	onJump: (
		messageId: app_convex_Id<"channels_messages">,
		threadRootId: app_convex_Id<"channels_messages"> | null,
	) => void;
	onEdit: (row: ChannelsMessageData) => void;
	onDelete: (row: ChannelsMessageData) => void;
	onReaction: (messageId: app_convex_Id<"channels_messages">, emoji: string) => void;
	onUnread: (messageId: app_convex_Id<"channels_messages">) => void;
	onCopyLink: (row: ChannelsMessageData) => void;
	onResolve: (row: ChannelsMessageData) => void;
}) {
	const {
		row,
		grouped,
		unread,
		tabIndex,
		sequence,
		canPost,
		canManage,
		resolvable,
		onFocus,
		onReply,
		onThread,
		onJump,
		onEdit,
		onDelete,
		onReaction,
		onUnread,
		onCopyLink,
		onResolve,
	} = props;
	const { message, authorName, replyPreview, thread } = row;
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const { userId } = AppAuthProvider.useAuthenticated();
	const profile = useQuery(app_convex_api.users.get_workspace_member_anagraphic, {
		organizationId,
		workspaceId,
		userId: message.authorUserId,
	});
	const pastProfile = useQuery(
		app_convex_api.users.get_anagraphic,
		profile === null ? { userId: message.authorUserId } : "skip",
	);
	const reactions = useQuery(app_convex_api.channels_messages.list_message_reactions, {
		membershipId,
		messageId: message._id,
	});
	const threadState = useQuery(
		app_convex_api.channels_messages.get_thread_state,
		thread ? { membershipId, rootMessageId: message._id } : "skip",
	);
	const [emojiOpen, setEmojiOpen] = useState(false);
	const mine = userId === message.authorUserId;
	const deleted = message.deletedAt !== null;
	const rootId = message.threadRootId ?? message._id;
	const date = new Date(message._creationTime);
	const fullTime = date.toLocaleString();
	const reply = () => {
		const selection = window.getSelection();
		const body = selection?.anchorNode?.parentElement?.closest(".AiChatMarkdown");
		const quote =
			selection?.anchorNode &&
			selection.focusNode &&
			body?.closest("article")?.getAttribute("data-message-id" satisfies keyof ChannelsMessage_CustomAttributes) ===
				message._id &&
			body?.contains(selection.anchorNode) &&
			body.contains(selection.focusNode)
				? selection.toString().slice(0, 1024)
				: "";
		onReply(row, quote || null);
	};
	const keydown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key.toLowerCase() === "r" && canPost && !deleted) {
			event.preventDefault();
			reply();
		} else if (event.key.toLowerCase() === "t") {
			event.preventDefault();
			onThread(rootId);
		} else if (event.key.toLowerCase() === "e" && mine && canPost && !deleted) {
			event.preventDefault();
			onEdit(row);
		} else if (event.key === "Delete" && (mine || canManage) && canPost && !deleted) {
			event.preventDefault();
			onDelete(row);
		} else if (event.key === "+" && canPost && !deleted) {
			event.preventDefault();
			setEmojiOpen(true);
		}
	};
	return (
		<article
			className={"ChannelsMessage" satisfies ChannelsMessage_ClassNames}
			{...({
				"data-message-id": message._id,
				"data-root-message-id": rootId,
				"data-sequence": sequence,
				"data-unread": String(unread),
				"data-grouped": String(grouped),
				"data-thread-resolved": String(thread?.isResolved ?? false),
				"data-reply-count": thread?.replyCount ?? 0,
			} satisfies ChannelsMessage_CustomAttributes)}
			aria-label={`${authorName}, ${fullTime}`}
			tabIndex={tabIndex}
			onFocus={onFocus}
			onKeyDown={keydown}
		>
			{!grouped && (
				<MyAvatar className={"ChannelsMessage-avatar" satisfies ChannelsMessage_ClassNames}>
					<MyAvatarImage src={(profile ?? pastProfile)?.avatarUrl} alt="" />
					<MyAvatarFallback>{authorName.slice(0, 2)}</MyAvatarFallback>
				</MyAvatar>
			)}
			<div className={"ChannelsMessage-content" satisfies ChannelsMessage_ClassNames}>
				{!grouped && (
					<header className={"ChannelsMessage-header" satisfies ChannelsMessage_ClassNames}>
						<strong>{authorName}</strong>
						<time dateTime={date.toISOString()} title={fullTime}>
							{format_relative_time(message._creationTime)}
						</time>
						{message.editedAt !== null && <span>(edited)</span>}
					</header>
				)}
				{grouped && message.editedAt !== null && <span>(edited)</span>}
				{replyPreview && message.replyTo && (
					<MyButton
						variant="ghost"
						className={"ChannelsMessage-reply" satisfies ChannelsMessage_ClassNames}
						onClick={() => onJump(message.replyTo!.messageId, replyPreview.targetThreadRootId)}
					>
						<CornerUpLeft size={14} />
						<span>
							{replyPreview.targetDeleted
								? "Original message was deleted"
								: `${replyPreview.authorName}: ${replyPreview.excerpt}`}
						</span>
					</MyButton>
				)}
				<ChannelsMessageContent row={row} />
				{!deleted && (
					<div className={"ChannelsMessage-reactions" satisfies ChannelsMessage_ClassNames}>
						{(reactions ?? []).map((reaction) => (
							<MyButton
								key={reaction.emoji}
								variant="ghost-highlightable"
								aria-pressed={reaction.mine}
								tooltip={reaction.names.join(", ")}
								disabled={!canPost}
								onClick={() => onReaction(message._id, reaction.emoji)}
							>
								{reaction.emoji} {reaction.count}
							</MyButton>
						))}
					</div>
				)}
				{thread && thread.replyCount > 0 && (
					<MyButton
						variant="link"
						className={"ChannelsMessage-thread" satisfies ChannelsMessage_ClassNames}
						onClick={() => onThread(rootId)}
					>
						{thread.recentReplierUserIds.map((id) => (
							<ChannelsMessageReplier key={id} userId={id} />
						))}
						{thread.isResolved && <Check size={14} />}
						{thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"} ·{" "}
						{format_relative_time(thread.lastActivityAt)}
						{(threadState?.unreadCount ?? 0) > 0 && ` · ${threadState!.unreadCount} new`}
						{thread.isResolved && " · Resolved"}
					</MyButton>
				)}
			</div>
			<div className={"ChannelsMessage-actions" satisfies ChannelsMessage_ClassNames}>
				{!deleted && (
					<>
						<MyPopover open={emojiOpen} setOpen={setEmojiOpen}>
							<MyPopoverTrigger>
								<MyIconButton tooltip="Add reaction" variant="ghost-highlightable" disabled={!canPost}>
									<SmilePlus />
								</MyIconButton>
							</MyPopoverTrigger>
							<MyPopoverContent aria-label="Choose a reaction">
								{emojiOpen && (
									<Suspense fallback={<p>Loading emoji…</p>}>
										<ChannelsEmojiPicker
											onSelect={(emoji) => {
												onReaction(message._id, emoji);
												setEmojiOpen(false);
											}}
										/>
									</Suspense>
								)}
							</MyPopoverContent>
						</MyPopover>
						<MyIconButton tooltip="Reply" variant="ghost-highlightable" disabled={!canPost} onClick={reply}>
							<CornerUpLeft />
						</MyIconButton>
					</>
				)}
				<MyIconButton tooltip="Reply in thread" variant="ghost-highlightable" onClick={() => onThread(rootId)}>
					<MessageSquare />
				</MyIconButton>
				<MyMenu>
					<MyMenuTrigger>
						<MyIconButton tooltip="More message actions" variant="ghost-highlightable">
							<MoreHorizontal />
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover aria-label="Message actions">
						{mine && canPost && !deleted && <MyMenuItem onClick={() => onEdit(row)}>Edit</MyMenuItem>}
						{(mine || canManage) && canPost && !deleted && (
							<MyMenuItem variant="destructive" onClick={() => onDelete(row)}>
								Delete
							</MyMenuItem>
						)}
						<MyMenuItem onClick={() => onCopyLink(row)}>Copy link</MyMenuItem>
						<MyMenuItem onClick={() => onUnread(message._id)}>Mark unread</MyMenuItem>
						{resolvable && thread && canPost && (
							<MyMenuItem onClick={() => onResolve(row)}>{thread.isResolved ? "Reopen" : "Resolve"}</MyMenuItem>
						)}
					</MyMenuPopover>
				</MyMenu>
			</div>
		</article>
	);
});

type ChannelsMessageReplier_ClassNames = "ChannelsMessageReplier";

const ChannelsMessageReplier = memo(function ChannelsMessageReplier(props: { userId: app_convex_Id<"users"> }) {
	const profile = useQuery(app_convex_api.users.get_anagraphic, { userId: props.userId });
	return (
		<MyAvatar
			className={"ChannelsMessageReplier" satisfies ChannelsMessageReplier_ClassNames}
			title={profile?.displayName ?? "User"}
		>
			<MyAvatarImage src={profile?.avatarUrl} alt="" />
			<MyAvatarFallback>{profile?.displayName.slice(0, 2) ?? "U"}</MyAvatarFallback>
		</MyAvatar>
	);
});
