import { useChat, type UIMessage } from "@ai-sdk/react";
import type { HttpChatTransportInitOptions } from "ai";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { Tool as assistant_ui_Tool } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";

import type { api_schemas_Main } from "@/lib/api-schemas.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAiChatThreadStore } from "@/stores/ai-chat-thread-store.ts";

const ai_chat_message_format = "ai-sdk/v5";
const ai_chat_runtime_id = "ai-chat-runtime";
const ai_chat_runtime_unselected_id = `${ai_chat_runtime_id}-unselected`;

type ai_chat_PrepareSendMessagesRequestArgs = Parameters<
	NonNullable<HttpChatTransportInitOptions<UIMessage>["prepareSendMessagesRequest"]>
>[0];

function ai_chat_convex_message_to_ui_message(message: app_convex_Doc<"messages">): UIMessage {
	return Object.assign(
		{
			id: message.client_generated_message_id ?? message._id,
			role: message.content.role,
			parts: message.content.parts as UIMessage["parts"],
		},
		message.content.metadata !== undefined ? { metadata: message.content.metadata } : {},
	);
}

export const useAiChatRuntime = () => {
	const selectedThreadId = useAiChatThreadStore((state) => state.selectedThreadId);
	const setSelectedThreadId = useAiChatThreadStore((state) => state.setSelectedThreadId);
	const startNewThread = useAiChatThreadStore((state) => state.startNewThread);

	const threadsList = useQuery(app_convex_api.ai_chat.threads_list, {
		paginationOpts: {
			numItems: 20,
			cursor: null,
		},
		includeArchived: true,
	});
	const threadsPage = threadsList?.page?.threads ?? [];
	const hasSelectedThreadRef = useRef(false);

	useEffect(() => {
		if (selectedThreadId) {
			hasSelectedThreadRef.current = true;
			return;
		}

		if (threadsPage.length > 0) {
			setSelectedThreadId(threadsPage[0]._id);
			hasSelectedThreadRef.current = true;
			return;
		}

		if (!threadsList || hasSelectedThreadRef.current) {
			return;
		}

		hasSelectedThreadRef.current = true;
		((/* iife */) => startNewThread())().catch((error) => {
			console.error("Failed to create initial chat thread:", error);
		});
	}, [selectedThreadId, threadsList, threadsPage, setSelectedThreadId, startNewThread]);

	const threadMessagesResult = useQuery(
		app_convex_api.ai_chat.thread_messages_list,
		selectedThreadId
			? {
					threadId: selectedThreadId as app_convex_Id<"threads">,
					order: "asc",
				}
			: "skip",
	);
	const threadMessages = threadMessagesResult?.messages ?? [];

	const convexMessageIdMap = useMemo(() => {
		return new Map<string, app_convex_Id<"messages">>(
			threadMessages.map((message) => [message.client_generated_message_id ?? message._id, message._id]),
		);
	}, [threadMessages]);
	const lastConvexMessageId = threadMessages.at(-1)?._id ?? null;

	const convexUiMessages = useMemo(() => {
		return threadMessages.map(ai_chat_convex_message_to_ui_message);
	}, [threadMessages]);

	const persistedMessageIds = useMemo(() => {
		return new Set(threadMessages.map((message) => message.client_generated_message_id ?? message._id));
	}, [threadMessages]);

	const persistKeyRef = useRef<string | null>(null);
	const isPersistingRef = useRef(false);

	useEffect(() => {
		persistKeyRef.current = null;
		isPersistingRef.current = false;
	}, [selectedThreadId]);

	const prepareSendMessagesRequest = useCallback(
		async (options: ai_chat_PrepareSendMessagesRequestArgs) => {
			const body = options.body as Record<string, unknown> & {
				system?: string | undefined;
				tools: Record<string, assistant_ui_Tool>;
			};

			if (body == null) {
				throw new Error('`body` is null when calling `AssistantChatTransport.app_fetch_main_api_url("/api/chat")`');
			}

			const headers = new Headers(options.headers);
			headers.set("Accept", "text/event-stream");

			const token = await AppAuthProvider.getToken();
			if (token) {
				headers.set("Authorization", `Bearer ${token}`);
			}

			let threadId = selectedThreadId;
			if (!threadId) {
				threadId = await startNewThread();
			}

			const resolvedParentId =
				options.trigger === "regenerate-message" && options.messageId
					? (convexMessageIdMap.get(options.messageId) ?? lastConvexMessageId ?? undefined)
					: (lastConvexMessageId ?? undefined);

			const credentials = "omit" as RequestCredentials;

			return {
				api: options.api,
				body: {
					...body,
					id: options.id,
					// Send only the last message
					messages: options.messages.slice(-1),
					trigger: options.trigger,
					messageId: options.messageId,
					threadId,
					parentId: resolvedParentId,
				} satisfies api_schemas_Main["/api/chat"]["POST"]["body"],
				credentials,
				headers,
			};
		},
		[selectedThreadId, startNewThread, lastConvexMessageId, convexMessageIdMap],
	);

	const transport = useMemo(() => {
		return new AssistantChatTransport({
			api: app_fetch_main_api_url("/api/chat"),
			prepareSendMessagesRequest: prepareSendMessagesRequest,
		});
	}, [prepareSendMessagesRequest]);

	const chatId = selectedThreadId ?? ai_chat_runtime_unselected_id;
	const chat = useChat({
		id: chatId,
		transport,
	});

	const runtime = useAISDKRuntime(chat);

	useEffect(() => {
		transport.setRuntime(runtime);
	}, [transport, runtime]);

	const pendingMessages = useMemo(() => {
		return chat.messages.filter((message) => !persistedMessageIds.has(message.id));
	}, [chat.messages, persistedMessageIds]);

	const lastPersistedConvexId = useMemo(() => {
		for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
			const message = chat.messages[index];
			if (!message || !persistedMessageIds.has(message.id)) {
				continue;
			}

			return convexMessageIdMap.get(message.id) ?? lastConvexMessageId ?? null;
		}

		return lastConvexMessageId ?? null;
	}, [chat.messages, persistedMessageIds, convexMessageIdMap, lastConvexMessageId]);

	const messagePersistMutation = useMutation(app_convex_api.ai_chat.thread_messages_add_many);

	useEffect(() => {
		if (!selectedThreadId) {
			return;
		}

		if (chat.status !== "ready") {
			return;
		}

		if (pendingMessages.length === 0) {
			persistKeyRef.current = null;
			return;
		}

		const pendingKey = pendingMessages.map((message) => message.id).join("|");
		if (persistKeyRef.current === pendingKey || isPersistingRef.current) {
			return;
		}

		const parentId = lastPersistedConvexId;

		const messagesInput = pendingMessages.map((message) => {
			const parts = (message.parts ?? []).filter((part) => part.type !== "file");
			const content = Object.assign(
				{
					role: message.role,
					parts,
				},
				message.metadata != null ? { metadata: message.metadata } : {},
			);

			return {
				id: message.id,
				format: ai_chat_message_format,
				content,
			};
		});

		isPersistingRef.current = true;
		persistKeyRef.current = pendingKey;

		((/* iife */) =>
			messagePersistMutation({
				threadId: selectedThreadId as app_convex_Id<"threads">,
				parentId: parentId ? (parentId as app_convex_Id<"messages">) : null,
				messages: messagesInput,
			}))()
			.catch((error) => {
				persistKeyRef.current = null;
				console.error("Failed to persist chat messages:", error);
			})
			.finally(() => {
				isPersistingRef.current = false;
			});
	}, [selectedThreadId, chat.status, pendingMessages, messagePersistMutation, lastConvexMessageId]);

	const chatMessageKey = useMemo(() => {
		return chat.messages.map((message) => message.id).join("|");
	}, [chat.messages]);

	const convexMessageKey = useMemo(() => {
		return convexUiMessages.map((message) => message.id).join("|");
	}, [convexUiMessages]);

	useEffect(() => {
		if (!selectedThreadId) {
			return;
		}

		if (chat.status !== "ready") {
			return;
		}

		if (pendingMessages.length > 0) {
			return;
		}

		if (chatMessageKey === convexMessageKey) {
			return;
		}

		chat.setMessages(convexUiMessages);
	}, [selectedThreadId, chat.status, pendingMessages.length, chatMessageKey, convexMessageKey, convexUiMessages, chat]);

	return runtime;
};
