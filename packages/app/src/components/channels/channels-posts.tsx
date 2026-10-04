import "./channels-posts.css";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { useConvexConnectionState, useQuery } from "convex/react";
import { MyButton } from "@/components/my-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_local_storage_get_value, app_local_storage_set_value } from "@/lib/storage.ts";
import { format_relative_time } from "@/lib/date.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { ChannelsComposer, type ChannelsComposerControl_Ref } from "./channels-composer.tsx";
import type { ChannelsMentionItem } from "./channels-composer-mention.tsx";
import { ChannelsMessageContent } from "./channels-message.tsx";
import type { ChannelsMessage } from "./channels-message-window.ts";
import type { file_quotes_Quote } from "../../../shared/file-quotes.ts";

type ChannelsPosts_ClassNames =
	| "ChannelsPosts"
	| "ChannelsPosts-toolbar"
	| "ChannelsPosts-form"
	| "ChannelsPosts-card"
	| "ChannelsPosts-heading"
	| "ChannelsPosts-excerpt"
	| "ChannelsPosts-status";
type ChannelsPosts_CustomAttributes = { "data-post-id": string; "data-post-new": string; "data-post-resolved": string };

const ChannelsPost = memo(function ChannelsPost(props: {
	row: ChannelsMessage;
	isNew: boolean;
	markMissing: boolean;
	onThread: (id: app_convex_Id<"channels_messages">) => void;
}) {
	const { row, isNew, markMissing, onThread } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const state = useQuery(app_convex_api.channels_messages.get_thread_state, {
		membershipId,
		rootMessageId: row.message._id,
	});
	const pending = row.thread?.anchor?.confirmedAt === null;
	return (
		<article
			className={"ChannelsPosts-card" satisfies ChannelsPosts_ClassNames}
			{...({
				"data-post-id": row.message._id,
				"data-post-new": String(isNew),
				"data-post-resolved": String(row.thread?.isResolved ?? false),
			} satisfies ChannelsPosts_CustomAttributes)}
		>
			<header className={"ChannelsPosts-heading" satisfies ChannelsPosts_ClassNames}>
				<strong>{row.authorName}</strong>
				<time dateTime={new Date(row.thread?.lastActivityAt ?? row.message._creationTime).toISOString()}>
					{format_relative_time(row.thread?.lastActivityAt ?? row.message._creationTime)}
				</time>
				{isNew && <span>New</span>}
				{row.thread?.isResolved && <span>Resolved</span>}
			</header>
			{row.thread?.title && <h2>{row.thread.title}</h2>}
			{markMissing && row.thread?.anchor?.confirmedAt != null && (
				<blockquote className={"ChannelsPosts-excerpt" satisfies ChannelsPosts_ClassNames}>
					<strong>Original text removed</strong>
					<p>{row.thread.anchor.excerpt}</p>
				</blockquote>
			)}
			<ChannelsMessageContent row={row} />
			{pending ? (
				<p>Adding comment…</p>
			) : (
				<MyButton onClick={() => onThread(row.message._id)}>
					Open comment · {row.thread?.replyCount ?? 0} replies
					{(state?.unreadCount ?? 0) > 0 && ` · ${state!.unreadCount} new`}
				</MyButton>
			)}
		</article>
	);
});

export const ChannelsPosts = memo(function ChannelsPosts(props: {
	channelId: app_convex_Id<"channels"> | null;
	fileNodeId?: app_convex_Id<"files_nodes">;
	state: app_convex_FunctionReturnType<typeof app_convex_api.channels.get_channel_state> | undefined;
	canPost: boolean;
	mentionItems: readonly ChannelsMentionItem[];
	markThreadIds?: readonly string[];
	hideMarkedPosts?: boolean;
	quoteRequest?: file_quotes_Quote | null;
	onQuoteInserted?: () => void;
	onThread: (id: app_convex_Id<"channels_messages">) => void;
}) {
	const {
		channelId,
		fileNodeId,
		state,
		canPost,
		mentionItems,
		markThreadIds,
		hideMarkedPosts = false,
		quoteRequest,
		onQuoteInserted,
		onThread,
	} = props;
	const { membershipId } = AppTenantProvider.useContext();
	const connection = useConvexConnectionState();
	const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const posts = useQuery(
		app_convex_api.channels_messages.list_posts,
		channelId
			? {
					membershipId,
					channelId,
					filter,
					paginationOpts: { numItems: 50, cursor: cursors.at(-1)! },
				}
			: "skip",
	);
	const list = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [entryRead, setEntryRead] = useState<number | null>(null);
	const visit = useRef(false);
	const composer = useRef<ChannelsComposerControl_Ref>(null);
	const draftKey = fileNodeId ? `file:${fileNodeId}` : `channel:${channelId}`;
	const storageKey = `app_state::channels_drafts::scope::${membershipId}` as const;
	const [draft] = useState(() => app_local_storage_get_value(storageKey)[draftKey] ?? "");
	const [creating, setCreating] = useState(!!draft);
	useEffect(() => {
		if (quoteRequest && canPost) setCreating(true);
	}, [quoteRequest, canPost]);
	const [empty, setEmpty] = useState(!draft.trim());
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const retry = useRef<{ signature: string; id: string } | null>(null);
	const change = useFn(() => {
		setEmpty(composer.current?.isEmpty() ?? true);
		app_local_storage_set_value(storageKey, (previous) => ({
			...previous,
			[draftKey]: composer.current?.getDraftContent() ?? "",
		}));
		setError("");
	});
	const submit = useFn((event?: FormEvent) => {
		event?.preventDefault();
		if (
			!composer.current ||
			busy ||
			!canPost ||
			composer.current.isEmpty() ||
			composer.current.hasPendingUploads() ||
			!connection.isWebSocketConnected
		)
			return;
		const body = composer.current.getMarkdownContent().trim();
		const mentionUserIds = composer.current.getMentionUserIds();
		const fileMentionIds = composer.current.getFileMentionIds();
		const fileQuotes = composer.current.getFileQuotes();
		const attachments = composer.current.getAttachments();
		const signature = JSON.stringify({ body, mentionUserIds, fileMentionIds, fileQuotes, attachments, title });
		if (retry.current?.signature !== signature) retry.current = { signature, id: crypto.randomUUID() };
		setBusy(true);
		setError("");
		app_convex
			.mutation(app_convex_api.channels_messages.send_message, {
				membershipId,
				target: fileNodeId
					? { kind: "file_comment", fileNodeId, anchorExcerpt: null }
					: { kind: "channel", channelId: channelId! },
				clientMessageId: retry.current.id,
				body,
				mentionUserIds,
				fileMentionIds,
				fileQuotes,
				replyTo: null,
				attachments,
				alsoInChannel: false,
				title: title.trim() || null,
			})
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return;
				}
				composer.current?.clear();
				setEmpty(true);
				setTitle("");
				setCreating(false);
				retry.current = null;
				app_local_storage_set_value(storageKey, (previous) => {
					const next = { ...previous };
					delete next[draftKey];
					return next;
				});
				onThread(result._yay.rootMessageId);
			})
			.catch((error: unknown) => {
				console.error("[ChannelsPosts.submit] Failed to send post", { error });
				setError("Could not send. Your draft is saved. Try again.");
			})
			.finally(() => setBusy(false));
	});

	useEffect(() => {
		const element = list.current;
		if (!element) return;
		let onScreen = false;
		const update = () => setVisible(onScreen && document.visibilityState === "visible");
		const observer = new IntersectionObserver((entries) => {
			onScreen = entries.some((entry) => entry.isIntersecting);
			update();
		});
		observer.observe(element);
		document.addEventListener("visibilitychange", update);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", update);
		};
	}, []);
	useEffect(() => {
		if (!visible) {
			visit.current = false;
			setEntryRead(null);
			return;
		}
		if (!channelId || !state || visit.current) return;
		// Capture the visit head once. New replies during this visit stay unread.
		visit.current = true;
		setEntryRead(state.readSequence);
		app_convex
			.mutation(app_convex_api.channels.mark_read, {
				membershipId,
				channelId,
				sequence: state.activity.lastChannelSequence,
			})
			.then((result) => {
				if (result._nay) console.error("[ChannelsPosts.markRead] Failed to mark posts read", { error: result._nay });
			})
			.catch((error: unknown) => console.error("[ChannelsPosts.markRead] Failed to mark posts read", { error }));
	}, [visible, channelId, state, membershipId]);
	const rows = posts?.page.filter(
		(row) =>
			!(markThreadIds !== undefined && row.thread?.anchor?.confirmedAt === null) &&
			(!hideMarkedPosts || row.thread?.isResolved || !markThreadIds?.includes(row.message._id)),
	);
	return (
		<div ref={list} className={"ChannelsPosts" satisfies ChannelsPosts_ClassNames} aria-label="Comments">
			<div className={"ChannelsPosts-toolbar" satisfies ChannelsPosts_ClassNames}>
				{(["open", "resolved", "all"] as const).map((value) => (
					<MyButton
						key={value}
						aria-pressed={filter === value}
						onClick={() => {
							setFilter(value);
							setCursors([null]);
						}}
					>
						{value === "open" ? "Open" : value === "resolved" ? "Resolved" : "All"}
					</MyButton>
				))}
				{canPost && (
					<MyButton aria-expanded={creating} onClick={() => setCreating((value) => !value)}>
						New comment
					</MyButton>
				)}
			</div>
			{creating && canPost && (
				<form className={"ChannelsPosts-form" satisfies ChannelsPosts_ClassNames} onSubmit={submit}>
					<MyInput>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								aria-label="Comment title"
								placeholder="Title (optional)"
								value={title}
								maxLength={200}
								onChange={(event) => setTitle(event.target.value)}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>
					<ChannelsComposer
						controlRef={composer}
						initialValue={app_local_storage_get_value(storageKey)[draftKey] ?? ""}
						placeholder="Write a comment…"
						ariaLabel="New comment"
						attachmentTarget={fileNodeId ? { kind: "file", fileNodeId } : { kind: "channel", channelId: channelId! }}
						disabled={busy}
						submitTooltip="Send comment (Enter)"
						submitDisabled={busy || empty || !connection.isWebSocketConnected}
						onChange={change}
						onEnter={submit}
						mentionItems={mentionItems}
						quoteRequest={quoteRequest}
						onQuoteInserted={onQuoteInserted}
						autoFocus="end"
					/>
					{error && <p role="alert">{error}</p>}
				</form>
			)}
			{channelId && posts === undefined ? (
				<p className={"ChannelsPosts-status" satisfies ChannelsPosts_ClassNames}>Loading comments…</p>
			) : rows?.length || hideMarkedPosts ? null : (
				<p className={"ChannelsPosts-status" satisfies ChannelsPosts_ClassNames}>No comments yet</p>
			)}
			{rows?.map((row) => (
				<ChannelsPost
					key={row.message._id}
					row={row}
					isNew={entryRead !== null && (row.thread?.lastActivitySequence ?? row.message.channelSequence) > entryRead}
					markMissing={markThreadIds !== undefined && !markThreadIds.includes(row.message._id)}
					onThread={onThread}
				/>
			))}
			<div className={"ChannelsPosts-toolbar" satisfies ChannelsPosts_ClassNames}>
				{cursors.length > 1 && (
					<MyButton onClick={() => setCursors((previous) => previous.slice(0, -1))}>Previous comments</MyButton>
				)}
				{posts && !posts.isDone && (
					<MyButton onClick={() => setCursors((previous) => [...previous, posts.continueCursor])}>
						More comments
					</MyButton>
				)}
			</div>
		</div>
	);
});
