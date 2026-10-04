import "./channels-message.css";
import { lazy, memo, Suspense, useState, type KeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { Check, CornerUpLeft, FileText, MessageSquare, MoreHorizontal, SmilePlus } from "lucide-react";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { AiChatMarkdown, AiChatMarkdownLink } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { FileQuote } from "@/components/file-quotes/file-quote.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyMenu, MyMenuItem, MyMenuItemsGroup, MyMenuPopover, MyMenuTrigger } from "@/components/my-menu.tsx";
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
	| "ChannelsMessage-thread"
	| "ChannelsMessage-body"
	| "ChannelsMessage-time"
	| "ChannelsMessage-person-mention"
	| "ChannelsMessage-file-icon";

type ChannelsMentionNode = { type: string; value?: string; url?: string; children?: ChannelsMentionNode[] };

function remark_channels_people_mentions({ names, ids }: { names: readonly string[]; ids: readonly string[] }) {
	// Streamdown caches plugins by name and options, so pass mention data as options.
	// Only stored mention tokens become highlights. Code keeps plain mention text.
	return (tree: ChannelsMentionNode) => {
		const visit = (node: ChannelsMentionNode) => {
			if (node.type === "code" || node.type === "inlineCode") {
				node.value = channels_render_people_mentions(node.value ?? "", names);
				return;
			}
			node.children = node.children?.flatMap((child) => {
				if (child.type !== "text") {
					visit(child);
					return [child];
				}
				const text = child.value ?? "";
				const parts: ChannelsMentionNode[] = [];
				let start = 0;
				for (const match of text.matchAll(/\[@ id="user:(\d+)"\]/g)) {
					parts.push({ type: "text", value: text.slice(start, match.index) });
					const index = Number(match[1]);
					const mention = { type: "text", value: `@${names[index] ?? "Person"}` };
					parts.push(
						ids[index] ? { type: "link", url: `#channels-person-${ids[index]}`, children: [mention] } : mention,
					);
					start = match.index + match[0].length;
				}
				parts.push({ type: "text", value: text.slice(start) });
				return parts;
			});
		};
		visit(tree);
	};
}

export const ChannelsMessageContent = memo(function ChannelsMessageContent(props: { row: ChannelsMessageData }) {
	const { row } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const parts = file_quotes_parse_draft(
		channels_file_quotes_to_draft(
			channels_render_file_mentions(
				row.message.body,
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
						<AiChatMarkdown
							key={index}
							className={"ChannelsMessage-body" satisfies ChannelsMessage_ClassNames}
							markdown={part.text}
							remarkPlugins={[
								[remark_channels_people_mentions, { names: row.mentionNames, ids: row.message.mentionUserIds }],
							]}
							components={{
								a: ({ href, children, ...rest }) => {
									const personId = row.message.mentionUserIds.find((id) => href === `#channels-person-${id}`);
									if (personId)
										return (
											<span
												className={"ChannelsMessage-person-mention" satisfies ChannelsMessage_ClassNames}
												data-user-id={personId}
											>
												{children}
											</span>
										);
									const file = row.fileMentions.find(
										(file) =>
											file.kind === "file" &&
											href === url_path_file_by_node_id({ organizationName, workspaceName, nodeId: file.fileNodeId }),
									);
									return (
										<AiChatMarkdownLink {...rest} href={href}>
											{file && (
												<FileText
													className={"ChannelsMessage-file-icon" satisfies ChannelsMessage_ClassNames}
													size={16}
												/>
											)}
											{children}
										</AiChatMarkdownLink>
									);
								},
							}}
						/>
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
	hideThreadSummary?: boolean;
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
		hideThreadSummary = false,
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
	const [menuOpen, setMenuOpen] = useState(false);
	const mine = userId === message.authorUserId;
	const deleted = message.deletedAt !== null;
	const rootId = message.threadRootId ?? message._id;
	const date = new Date(message._creationTime);
	const fullTime = date.toLocaleString();
	const clock = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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
			data-actions-open={String(menuOpen || emojiOpen)}
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
			{grouped && (
				<time
					className={"ChannelsMessage-time" satisfies ChannelsMessage_ClassNames}
					dateTime={date.toISOString()}
					title={fullTime}
					tabIndex={0}
				>
					{clock}
				</time>
			)}
			<div className={"ChannelsMessage-content" satisfies ChannelsMessage_ClassNames}>
				{!grouped && (
					<header className={"ChannelsMessage-header" satisfies ChannelsMessage_ClassNames}>
						<strong title={authorName}>{authorName}</strong>
						<time dateTime={date.toISOString()} title={fullTime} tabIndex={0}>
							{clock}
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
				{!deleted && !!reactions?.length && (
					<div className={"ChannelsMessage-reactions" satisfies ChannelsMessage_ClassNames}>
						{(reactions ?? []).map((reaction) => (
							<MyButton
								key={reaction.emoji}
								variant="outline"
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
				{!hideThreadSummary && thread && thread.replyCount > 0 && (
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
					</>
				)}
				<MyIconButton tooltip="Reply in thread" variant="ghost-highlightable" onClick={() => onThread(rootId)}>
					<MessageSquare />
				</MyIconButton>
				<MyMenu open={menuOpen} setOpen={setMenuOpen}>
					<MyMenuTrigger>
						<MyIconButton tooltip="More message actions" variant="ghost-highlightable">
							<MoreHorizontal />
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover aria-label="Message actions">
						{/* Let More close before moving focus or opening another popup. */}
						{canPost && !deleted && <MyMenuItem onClick={() => requestAnimationFrame(reply)}>Quote reply</MyMenuItem>}
						<MyMenuItem onClick={() => requestAnimationFrame(() => onThread(rootId))}>Reply in thread</MyMenuItem>
						{canPost && !deleted && (
							<MyMenuItem onClick={() => requestAnimationFrame(() => setEmojiOpen(true))}>Add reaction</MyMenuItem>
						)}
						{mine && canPost && !deleted && (
							<MyMenuItem onClick={() => requestAnimationFrame(() => onEdit(row))}>Edit</MyMenuItem>
						)}
						<MyMenuItem onClick={() => onCopyLink(row)}>Copy link</MyMenuItem>
						<MyMenuItem onClick={() => onUnread(message._id)}>Mark unread</MyMenuItem>
						{resolvable && thread && canPost && (
							<MyMenuItem onClick={() => onResolve(row)}>{thread.isResolved ? "Reopen" : "Resolve"}</MyMenuItem>
						)}
						{(mine || canManage) && canPost && !deleted && (
							<MyMenuItemsGroup separator>
								<MyMenuItem variant="destructive" onClick={() => requestAnimationFrame(() => onDelete(row))}>
									Delete
								</MyMenuItem>
							</MyMenuItemsGroup>
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
