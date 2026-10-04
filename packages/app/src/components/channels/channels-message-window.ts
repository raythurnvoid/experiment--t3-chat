import { useQueries, useQuery } from "convex/react";
import type { PaginationResult } from "convex/server";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";

export type ChannelsMessage = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.channels_messages.get_message>
>;

type Page = { id: number; cursor: string | null; endCursor?: string };
type MessageWindow = { anchor: number; pages: Page[]; newerAnchor: number | null; extend: boolean };

// Keep each pane, including its live head and edit pin, within 3 MiB.
const WINDOW_BYTES = 3 * 1024 * 1024;

export function useChannelsMessageWindow(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	target: { channelId: app_convex_Id<"channels"> } | { rootMessageId: app_convex_Id<"channels_messages"> };
	enabled: boolean;
}) {
	const { membershipId, target, enabled } = props;
	const replies = "rootMessageId" in target;
	const targetId = "rootMessageId" in target ? target.rootMessageId : target.channelId;
	const mainHead = useQuery(
		app_convex_api.channels_messages.list_latest_main,
		enabled && "channelId" in target ? { membershipId, channelId: target.channelId } : "skip",
	);
	const replyHead = useQuery(
		app_convex_api.channels_messages.list_latest_thread,
		enabled && "rootMessageId" in target ? { membershipId, rootMessageId: target.rootMessageId } : "skip",
	);
	const head = replies ? replyHead : mainHead;
	const sequence = replies ? (replyHead?.lastReplySequence ?? 0) : (mainHead?.lastMainSequence ?? 0);
	const [window, setWindow] = useState<MessageWindow | null>(null);
	const [cache, setCache] = useState<Record<number, PaginationResult<ChannelsMessage>>>({});
	const [editingMessage, setEditingMessage] = useState<ChannelsMessage | null>(null);
	const nextPageId = useRef(0);
	const observedEdit = useQuery(
		app_convex_api.channels_messages.get_message,
		enabled && editingMessage ? { membershipId, messageId: editingMessage.message._id } : "skip",
	);
	// Convex needs stable descriptors while a frozen page reconnects.
	const queries = useMemo(
		() =>
			Object.fromEntries(
				(enabled ? (window?.pages ?? []) : []).map((page) => [
					String(page.id),
					{
						query: replies
							? app_convex_api.channels_messages.list_thread_page
							: app_convex_api.channels_messages.list_main_page,
						args: {
							membershipId,
							...(replies ? { rootMessageId: targetId } : { channelId: targetId }),
							anchorSequence: window!.anchor,
							paginationOpts: {
								numItems: 50,
								cursor: page.cursor,
								...(page.endCursor ? { endCursor: page.endCursor } : {}),
							},
						},
					},
				]),
			),
		[enabled, window, replies, membershipId, targetId],
	);
	const results = useQueries(queries) as Record<string, PaginationResult<ChannelsMessage> | Error | undefined>;
	const pages = (window?.pages ?? []).map((descriptor) => ({
		descriptor,
		result: results[String(descriptor.id)] ?? cache[descriptor.id],
	}));
	const readyPages = pages.filter(
		(page): page is { descriptor: Page; result: PaginationResult<ChannelsMessage> } =>
			page.result !== undefined && !(page.result instanceof Error),
	);
	const pageRows = window ? readyPages.flatMap((page) => page.result.page) : (head?.messages ?? []);
	const pin = observedEdit === undefined ? editingMessage : observedEdit;
	const rows =
		pin && pin.message.deletedAt === null && !pageRows.some((row) => row.message._id === pin.message._id)
			? [...pageRows, pin]
			: pageRows;
	const sortedRows = [...rows].sort(
		(left, right) =>
			(replies ? (left.message.threadSequence ?? 0) : (left.message.mainSequence ?? 0)) -
			(replies ? (right.message.threadSequence ?? 0) : (right.message.mainSequence ?? 0)),
	);
	const lastPage = readyPages.at(-1);
	const loading = enabled && (!head || pages.some((page) => results[String(page.descriptor.id)] === undefined));
	const error = pages.find((page) => page.result instanceof Error)?.result;
	const bytes = new TextEncoder().encode(JSON.stringify({ rows, head })).byteLength;
	const rowSequence = (row: ChannelsMessage) =>
		replies ? (row.message.threadSequence ?? 0) : (row.message.mainSequence ?? 0);

	useEffect(() => {
		setCache((previous) => {
			const next = Object.fromEntries(readyPages.map(({ descriptor, result }) => [descriptor.id, result]));
			return Object.keys(previous).length === Object.keys(next).length &&
				Object.entries(next).every(([id, result]) => previous[Number(id)] === result)
				? previous
				: next;
		});
	}, [results, window]);

	useEffect(() => {
		if (!enabled || observedEdit === null || observedEdit?.message.deletedAt != null) setEditingMessage(null);
	}, [enabled, observedEdit]);

	useEffect(() => {
		if (!window || !enabled) return;
		if (readyPages.some(({ result }) => result.pageStatus === "SplitRequired")) {
			setWindow({
				anchor: pageRows[0] ? rowSequence(pageRows[0]) + 1 : window.anchor,
				pages: [{ id: ++nextPageId.current, cursor: null }],
				newerAnchor: window.newerAnchor,
				extend: false,
			});
		} else if (bytes > WINDOW_BYTES && window.pages.length > 1) {
			setWindow({ ...window, pages: window.pages.slice(1), newerAnchor: rowSequence(pageRows[0]!) + 1 });
		} else if (window.extend && lastPage) {
			setWindow({
				...window,
				extend: false,
				pages: lastPage.result.isDone
					? window.pages
					: [
							...window.pages.map((page) => ({ ...page, endCursor: lastPage.result.continueCursor })),
							{ id: ++nextPageId.current, cursor: lastPage.result.continueCursor },
						],
			});
		} else if (readyPages.some(({ descriptor, result }) => !descriptor.endCursor && !result.isDone)) {
			setWindow({
				...window,
				pages: window.pages.map((page) => {
					const result = results[String(page.id)];
					return !page.endCursor && result && !(result instanceof Error) && !result.isDone
						? { ...page, endCursor: result.continueCursor }
						: page;
				}),
			});
		}
	}, [window, enabled, results, bytes]);

	const latest = useFn(() => setWindow(null));
	const older = useFn(() => {
		if (!enabled || loading || !head) return;
		if (!window) {
			setWindow({
				anchor: sequence + 1,
				pages: [{ id: ++nextPageId.current, cursor: null }],
				newerAnchor: sequence + 1,
				extend: true,
			});
			return;
		}
		if (!lastPage || lastPage.result.isDone) return;
		const next = [...window.pages, { id: ++nextPageId.current, cursor: lastPage.result.continueCursor }];
		const maximum = replies ? 2 : 5;
		setWindow({
			...window,
			pages: next.slice(-maximum),
			newerAnchor: next.length > maximum ? rowSequence(pageRows[0]!) + 1 : window.newerAnchor,
		});
	});
	const newer = useFn(() => {
		if (!window?.newerAnchor || loading) return;
		if (window.newerAnchor >= sequence + 1) latest();
		else
			setWindow({
				anchor: window.newerAnchor,
				pages: [{ id: ++nextPageId.current, cursor: null }],
				newerAnchor: Math.min(sequence + 1, window.newerAnchor + 50),
				extend: false,
			});
	});
	const jump = useFn((anchorSequence: number) =>
		setWindow({
			anchor: anchorSequence + 25,
			pages: [{ id: ++nextPageId.current, cursor: null }],
			newerAnchor: Math.min(sequence + 1, anchorSequence + 75),
			extend: false,
		}),
	);
	return {
		rows: enabled ? sortedRows : [],
		sequence,
		loading,
		error: error instanceof Error ? error.message : null,
		atLatest: window === null,
		hasNewer: window !== null,
		hasOlder: window
			? !!lastPage && !lastPage.result.isDone
			: head?.messages.at(-1)
				? rowSequence(head.messages.at(-1)!) > 1
				: false,
		newCount: window ? Math.max(0, sequence + 1 - window.anchor) : 0,
		editingMessage,
		setEditingMessage,
		older,
		newer,
		latest,
		jump,
	};
}
