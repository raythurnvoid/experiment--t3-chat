import "./channels-message-list.css";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { MyButton } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { ChannelsMessage, type ChannelsMessage_CustomAttributes } from "./channels-message.tsx";
import type { ChannelsMessage as ChannelsMessageData, useChannelsMessageWindow } from "./channels-message-window.ts";

type ChannelsMessageList_ClassNames =
	| "ChannelsMessageList"
	| "ChannelsMessageList-status"
	| "ChannelsMessageList-day"
	| "ChannelsMessageList-new"
	| "ChannelsMessageList-pagination";

export const ChannelsMessageList = memo(function ChannelsMessageList(
	props: {
		window: ReturnType<typeof useChannelsMessageWindow>;
		name: string;
		thread: boolean;
		readSequence: number;
		jumpMessageId: string | undefined;
		canPost: boolean;
		canManage: boolean;
		resolvable: boolean;
		onRead: (sequence: number) => void;
	} & Pick<
		ComponentProps<typeof ChannelsMessage>,
		"onReply" | "onThread" | "onJump" | "onEdit" | "onDelete" | "onReaction" | "onUnread" | "onCopyLink" | "onResolve"
	>,
) {
	const { window, name, thread, readSequence, jumpMessageId, canPost, canManage, resolvable, onRead, ...actions } =
		props;
	const { rows, loading, error, atLatest, hasOlder, hasNewer, newCount, older, newer, latest } = window;
	const listRef = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const anchor = useRef<{ id: string; offset: number } | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [showLatest, setShowLatest] = useState(false);
	const messageIdAttribute = "data-message-id" satisfies keyof ChannelsMessage_CustomAttributes;
	const rowKey = rows.map((row) => row.message._id).join(":");
	const sequence = (row: ChannelsMessageData) =>
		thread ? (row.message.threadSequence ?? 0) : (row.message.mainSequence ?? 0);
	const changePage = useFn((change: () => void) => {
		const list = listRef.current;
		if (list) {
			const row = Array.from(list.querySelectorAll<HTMLElement>(`article[${messageIdAttribute}]`)).find(
				(row) => row.getBoundingClientRect().bottom > list.getBoundingClientRect().top,
			);
			if (row)
				anchor.current = {
					id: row.dataset.messageId!,
					offset: row.getBoundingClientRect().top - list.getBoundingClientRect().top,
				};
		}
		change();
	});
	const visibleRead = useFn(onRead);
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const visible = new Set<Element>();
		const markRead = () => {
			if (document.visibilityState !== "visible") return;
			const values = Array.from(visible).map((element) =>
				Number(element.getAttribute("data-sequence" satisfies keyof ChannelsMessage_CustomAttributes)),
			);
			if (values.length) visibleRead(Math.max(...values));
		};
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) visible.add(entry.target);
					else visible.delete(entry.target);
				}
				markRead();
			},
			{ root: list },
		);
		list.querySelectorAll(`article[${messageIdAttribute}]`).forEach((row) => observer.observe(row));
		document.addEventListener("visibilitychange", markRead);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", markRead);
		};
	}, [rowKey, visibleRead, messageIdAttribute]);
	useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) return;
		if (jumpMessageId) {
			const target = list.querySelector<HTMLElement>(`[${messageIdAttribute}="${jumpMessageId}"]`);
			if (target) {
				target.scrollIntoView({ block: "center" });
				target.focus({ preventScroll: true });
			}
		} else if (anchor.current && !loading) {
			const row = list.querySelector<HTMLElement>(`[${messageIdAttribute}="${anchor.current.id}"]`);
			if (row)
				list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.current.offset;
			anchor.current = null;
		} else if (atLatest && atBottom.current) list.scrollTop = list.scrollHeight;
	}, [rowKey, loading, atLatest, jumpMessageId, messageIdAttribute]);
	const keydown: ComponentProps<"div">["onKeyDown"] = (event) => {
		if (
			!(event.target instanceof HTMLElement) ||
			event.target.tagName !== "ARTICLE" ||
			!["ArrowUp", "ArrowDown"].includes(event.key)
		)
			return;
		const list = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`article[${messageIdAttribute}]`));
		const index = list.indexOf(event.target);
		const next = list[(index + (event.key === "ArrowUp" ? -1 : 1) + list.length) % list.length];
		if (next) {
			event.preventDefault();
			next.focus();
			next.scrollIntoView({ block: "nearest" });
		}
	};
	return (
		<div
			ref={listRef}
			role="log"
			aria-label={thread ? "Thread replies" : `Messages in ${name}`}
			className={cn(
				"ChannelsMessageList" satisfies ChannelsMessageList_ClassNames,
				"app-scrollable" satisfies AppClassName,
			)}
			onKeyDown={keydown}
			onScroll={(event) => {
				const list = event.currentTarget;
				atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
				setShowLatest(!atBottom.current);
			}}
		>
			<div className={"ChannelsMessageList-pagination" satisfies ChannelsMessageList_ClassNames}>
				{hasOlder && (
					<MyButton disabled={loading} onClick={() => changePage(older)}>
						Load older
					</MyButton>
				)}
				{hasNewer && (
					<MyButton disabled={loading} onClick={() => changePage(newer)}>
						Load newer
					</MyButton>
				)}
				{(hasNewer || showLatest) && (
					<MyButton
						onClick={() => {
							atBottom.current = true;
							anchor.current = null;
							setShowLatest(false);
							latest();
							if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
						}}
					>
						Jump to latest{newCount > 0 && ` (${newCount} new)`}
					</MyButton>
				)}
			</div>
			{error ? (
				<div role="alert" className={"ChannelsMessageList-status" satisfies ChannelsMessageList_ClassNames}>
					{error}
					<MyButton onClick={latest}>Retry</MyButton>
				</div>
			) : loading && rows.length === 0 ? (
				<p className={"ChannelsMessageList-status" satisfies ChannelsMessageList_ClassNames}>Loading messages…</p>
			) : rows.length === 0 ? (
				<p className={"ChannelsMessageList-status" satisfies ChannelsMessageList_ClassNames}>
					{thread ? "No replies yet" : "No messages yet. Start the conversation."}
				</p>
			) : null}
			{rows.map((row, index) => {
				const previous = rows[index - 1];
				const day = new Date(row.message._creationTime).toLocaleDateString();
				const newDay = !previous || new Date(previous.message._creationTime).toLocaleDateString() !== day;
				const firstNew = sequence(row) > readSequence && (!previous || sequence(previous) <= readSequence);
				const grouped =
					!!previous &&
					!newDay &&
					!firstNew &&
					previous.message.authorUserId === row.message.authorUserId &&
					row.message._creationTime - previous.message._creationTime < 300_000 &&
					!row.message.replyTo &&
					!previous.message.replyTo &&
					previous.message.deletedAt === null &&
					row.message.deletedAt === null;
				return (
					<div key={row.message._id}>
						{newDay && <div className={"ChannelsMessageList-day" satisfies ChannelsMessageList_ClassNames}>{day}</div>}
						{firstNew && <div className={"ChannelsMessageList-new" satisfies ChannelsMessageList_ClassNames}>New</div>}
						<ChannelsMessage
							row={row}
							grouped={grouped}
							unread={sequence(row) > readSequence}
							sequence={sequence(row)}
							tabIndex={
								focusedId === row.message._id || (!rows.some((item) => item.message._id === focusedId) && index === 0)
									? 0
									: -1
							}
							onFocus={() => setFocusedId(row.message._id)}
							canPost={canPost}
							canManage={canManage}
							resolvable={resolvable}
							{...actions}
						/>
					</div>
				);
			})}
		</div>
	);
});
