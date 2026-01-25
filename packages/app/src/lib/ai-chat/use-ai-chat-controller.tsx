import { Chat, useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { create } from "zustand";

import type { api_schemas_Main } from "@/lib/api-schemas.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { should_never_happen } from "@/lib/utils.ts";
import { useLiveRef, useRenderPromise } from "../../hooks/utils-hooks.ts";
import { generate_id } from "../utils.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";

export type ai_chat_UiMessageMetadata = {
	ai_chat: {
		convexId?: string | undefined;
		convexParentId?: string | null | undefined;
	};
};

type DataPart = {
	type: string;
	id?: string | undefined;
	data?: unknown;
};

type TitlePartData = {
	title?: string | null;
};

type ThreadIdPartData = {
	threadId?: string | null;
	clientThreadId?: string | null;
};

type ThreadChatArgs = {
	chatId: string | null;
	initialMessages?: UIMessage[] | undefined;
	prepareSendMessagesRequest: NonNullable<DefaultChatTransport<UIMessage>["prepareSendMessagesRequest"]>;
};

type ThreadSession = {
	chat: Chat<UIMessage> | null;
	draftComposerText: string;
	/**
	 * Optional branch anchor (Convex message id).
	 *
	 * This should point at the selected assistant-variant root message id.
	 * When null, we default to the latest Convex message in the thread.
	 */
	anchorId: string | null;
	streamingTitle?: string | undefined;
	optimisticThread?: app_convex_Doc<"threads"> | undefined;
};

type ThreadStore = {
	selectedThreadId: string | null;
	threadById: Map<string, ThreadSession>;
};

const useAiChatStore = ((/* iife */) => {
	const store = create<ThreadStore>(() => ({
		selectedThreadId: null,
		threadById: new Map(),
	}));

	return Object.assign(store, {
		actions: {
			getSession(chatId: string) {
				return store.getState().threadById.get(chatId) ?? null;
			},
			setSession<T extends ThreadSession | void>(chatId: string, session: (prev: ThreadSession | null) => T) {
				const prev = store.getState().threadById.get(chatId) ?? null;
				const next = session(prev);

				if (next === undefined) {
					return next;
				}

				store.setState((state) => {
					return { threadById: new Map(state.threadById.set(chatId, next)) };
				});

				return next;
			},
			deleteSession(chatId: string) {
				store.setState((state) => {
					if (!state.threadById.has(chatId)) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.delete(chatId);
					return { threadById };
				});
			},
		},
	});
})();

function create_optimistic_thread(): app_convex_Doc<"threads"> {
	const clientId = generate_id("ai_thread");
	const now = Date.now();
	return {
		_id: clientId as app_convex_Id<"threads">,
		_creationTime: now,
		title: null,
		archived: false,
		last_message_at: now,
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		created_by: "",
		updated_by: "",
		updated_at: now,
		external_id: clientId,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		starred: false,
	};
}

const thread_session_create = (args?: {
	optimisticThread?: app_convex_Doc<"threads">;
	chat?: Chat<UIMessage> | null;
	chatArgs?: ThreadChatArgs | undefined;
}) => {
	return {
		chat: args?.chat ?? (args?.chatArgs ? create_chat_instance(args.chatArgs) : null),
		draftComposerText: "",
		anchorId: null,
		streamingTitle: undefined,
		optimisticThread: args?.optimisticThread,
	} satisfies ThreadSession;
};

function merge_metadata(base: Record<string, unknown> | undefined, overlay: Record<string, unknown> | undefined) {
	if (!base && !overlay) {
		return undefined;
	}

	return { ...base, ...overlay };
}

function convex_message_to_ui_message(
	message: app_convex_Doc<"messages">,
	metadata?: ai_chat_UiMessageMetadata,
): UIMessage {
	const mergedMetadata = merge_metadata(message.content.metadata, metadata);

	return {
		id: message._id,
		role: message.content.role,
		parts: message.content.parts as UIMessage["parts"],
		...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
	};
}

function create_chat_instance(args: {
	chatId: string | null;
	initialMessages?: UIMessage[] | undefined;
	prepareSendMessagesRequest: NonNullable<DefaultChatTransport<UIMessage>["prepareSendMessagesRequest"]>;
}) {
	const handleDataPart = (part: DataPart) => {
		if (!part.type?.startsWith("data-")) {
			return;
		}

		const partName = part.type.slice("data-".length);

		// TODO(ai-chat): Handle a server-emitted "persist-first" mapping part (e.g. `data-message-ids`).
		// Goal: when the backend persists the user message up front + allocates the assistant message doc,
		// it can emit a transient mapping from client UIMessage ids -> Convex message ids.
		// The client can then:
		// - rewrite/remove optimistic `chat.messages` entries deterministically (no DB `client_generated_message_id`)
		// - optionally treat a `persisted` barrier as the signal to drop all optimistic messages for this request.
		if (partName === "thread-id") {
			// The server emits `data-thread-id` *during the stream* when it created a new thread.
			//
			// We start in an "optimistic thread" (client-generated id) to let the UI show a New Chat entry instantly.
			// Once the server returns the real Convex thread id, we:
			// - create / update a "persisted session" keyed by the real id
			// - keep the optimistic session selected while streaming (avoid mid-stream `Chat` recreation)
			// - schedule a "selection swap" to the real thread after streaming ends
			//
			// Sidebar dedupe (see below) ensures we don't show BOTH optimistic + persisted entries.
			const data = part.data as ThreadIdPartData | string | null | undefined;
			const threadId = typeof data === "string" ? data : typeof data?.threadId === "string" ? data.threadId : null;
			const optimisticThreadId = typeof data === "string" ? null : (data?.clientThreadId ?? null);

			if (!threadId || !optimisticThreadId) {
				should_never_happen("[useAiChatController] Missing thread id on data-thread-id part", {
					part,
				});
				return;
			}

			// @ts-expect-error: Overwrite the readonly chat id to the persisted thread id.
			chat.id = threadId;

			return;
		}

		if (partName === "chat-title") {
			const data = part.data as TitlePartData | string | null | undefined;
			const title = typeof data === "string" ? data : typeof data?.title === "string" ? data.title : null;
			if (!title) {
				return;
			}
			if (chat.id) {
				if (useAiChatStore.getState().threadById.get(chat.id)?.optimisticThread) {
					return;
				}
				useAiChatStore.actions.setSession(chat.id, (prev) => {
					if (!prev) {
						return;
					}

					return {
						...prev,
						streamingTitle: title,
					};
				});
			}
		}
	};

	const transport = new DefaultChatTransport({
		api: app_fetch_main_api_url("/api/chat"),
		prepareSendMessagesRequest: args.prepareSendMessagesRequest,
	});

	const chat = new Chat({
		id: args.chatId ?? generate_id("ai_thread"),
		...(args.initialMessages ? { messages: args.initialMessages } : {}),
		transport,
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		onData: handleDataPart,
	});

	return chat;
}

export const useAiChatController = () => {
	useRenderPromise();

	const selectedThreadId = useAiChatStore((state) => state.selectedThreadId);
	const threadById = useAiChatStore((state) => state.threadById);

	const session = useAiChatStore((state) =>
		selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null,
	);

	const persistedThreads = useQuery(app_convex_api.ai_chat.threads_list, {
		paginationOpts: {
			numItems: 20,
			cursor: null,
		},
		includeArchived: true,
	});
	const updateThread = useMutation(app_convex_api.ai_chat.thread_update);

	const persistedThreadMessages = useQuery(
		app_convex_api.ai_chat.thread_messages_list,
		selectedThreadId && session && !session.optimisticThread
			? {
					threadId: selectedThreadId as app_convex_Id<"threads">,
					order: "desc",
				}
			: "skip",
	);

	/** Necessary to manage optimistic threads and their swtch to persisted threads. */
	const threadIdByExternalId = ((/* iife */) => {
		const result = new Map<string, string>();
		for (const thread of persistedThreads ? persistedThreads.page.threads : []) {
			if (thread.external_id) {
				result.set(thread.external_id, thread._id);
			}
		}
		return result;
	})();

	const threads = ((/* iife */) => {
		const result = persistedThreads ? [...persistedThreads.page.threads] : [];
		for (const session of threadById.values()) {
			if (session.optimisticThread && !threadIdByExternalId.has(session.optimisticThread._id)) {
				result.push(session.optimisticThread);
			}
		}
		return result;
	})();

	const streamingTitleByThreadId = useMemo(() => {
		const result: Record<string, string | undefined> = {};
		for (const [threadId, session] of threadById.entries()) {
			if (session.streamingTitle) {
				result[threadId] = session.streamingTitle;
			}
		}
		return result;
	}, [threadById]);

	const persistedMessagesData = ((/* iife */) => {
		if (!persistedThreadMessages) return undefined;

		const result = {
			mapById: new Map<string, UIMessage>(),
			childrenByParentId: new Map<string, UIMessage[]>(),
			clientGeneratedIds: new Set<string>(),
			list: [] as UIMessage[],
		};

		for (const message of persistedThreadMessages.messages) {
			const uiMessage = convex_message_to_ui_message(message, {
				ai_chat: {
					convexId: message._id,
					convexParentId: message.parent_id,
				},
			});

			result.mapById.set(message._id, uiMessage);

			const parentIdOrRoot = message.parent_id ?? "_root";
			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(uiMessage);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [uiMessage]);
			}

			if (message.client_generated_message_id) {
				result.clientGeneratedIds.add(message.client_generated_message_id);
			}

			result.list.push(uiMessage);
		}

		return result;
	})();

	const prepareSendMessagesRequest = useLiveRef<
		NonNullable<DefaultChatTransport<UIMessage>["prepareSendMessagesRequest"]>
	>(async (options) => {
		const headers = new Headers(options.headers);
		headers.set("Accept", "text/event-stream");

		const token = await AppAuthProvider.getToken();
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}

		const chatId = options.id;

		const session = useAiChatStore.getState().threadById.get(chatId);
		const threadId = session?.optimisticThread ? undefined : chatId;
		const clientThreadId = session?.optimisticThread ? (session.optimisticThread.external_id ?? chatId) : undefined;

		const isRegenerate = options.trigger === "regenerate-message";
		const regenMessage =
			isRegenerate && options.messageId
				? (persistedMessagesData?.mapById.get(options.messageId as app_convex_Id<"messages">) ?? null)
				: null;
		if (isRegenerate && !options.messageId) {
			should_never_happen("[useAiChatController] Missing messageId for regenerate request", { chatId });
		}
		if (isRegenerate && options.messageId && !regenMessage) {
			should_never_happen("[useAiChatController] Missing Convex message for regenerate request", {
				chatId,
				messageId: options.messageId,
			});
		}

		const metadata = regenMessage?.metadata as ai_chat_UiMessageMetadata | undefined;
		const regenParentId = metadata?.ai_chat.convexParentId ?? null;
		const resolvedParentId = ((/* iife */) => {
			if (isRegenerate) {
				return regenParentId ?? undefined;
			}
			if (!threadId || chatId !== selectedThreadId) {
				return undefined;
			}
			const anchorId = session?.anchorId ?? null;
			const base = anchorId
				? (persistedMessagesData?.mapById.get(anchorId as app_convex_Id<"messages">) ?? null)
				: (persistedMessagesData?.list.at(0) ?? null);
			if (!base) {
				return undefined;
			}

			let lastDescendant = base;
			let lastDescendantPointer: typeof base | undefined = base;
			while (lastDescendantPointer) {
				lastDescendantPointer = persistedMessagesData?.childrenByParentId.get(lastDescendantPointer.id)?.at(0);
				if (lastDescendantPointer) {
					lastDescendant = lastDescendantPointer;
				}
			}
			return lastDescendant.id;
		})();
		const messagesPayload = isRegenerate ? [] : options.messages.slice(-1);

		const tools = (options.body as { tools?: Record<string, unknown> } | undefined)?.tools ?? {};
		const requestBody = {
			...(options.body as Record<string, unknown> | undefined),
			id: threadId ?? chatId,
			messages: messagesPayload,
			trigger: options.trigger,
			messageId: options.messageId,
			tools,
			...(threadId ? { threadId } : {}),
			...(clientThreadId ? { clientThreadId } : {}),
			...(resolvedParentId ? { parentId: resolvedParentId } : {}),
		} satisfies api_schemas_Main["/api/chat"]["POST"]["body"];

		return {
			api: options.api,
			body: requestBody,
			credentials: "omit" as RequestCredentials,
			headers,
		};
	});

	const unselectedChatInstance = create_chat_instance({
		chatId: null,
		prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
	});

	const activeChatInstance = ((/* iife */) => {
		if (selectedThreadId) {
			if (session?.chat) {
				return session.chat;
			}

			should_never_happen("[useAiChatController] Missing `session.chat` for selected thread", {
				selectedThreadId,
				hasSession: Boolean(session),
			});

			const createdChat = create_chat_instance({
				chatId: selectedThreadId,
				prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			});

			useAiChatStore.actions.setSession(selectedThreadId, (prev) => {
				const base = prev ?? thread_session_create();
				return { ...base, ...prev, chat: createdChat };
			});

			return createdChat;
		}

		return unselectedChatInstance;
	})();

	const chat = useChat({ chat: activeChatInstance });

	const pendingMessagesData = ((/* iife */) => {
		const result = {
			list: [] as UIMessage[],
			childrenByParentId: new Map<string, UIMessage[]>(),
		};

		// Read messages from the newest to the oldest.
		for (const message of chat.messages.toReversed()) {
			// Skip alredy persisted messages
			if (persistedMessagesData?.clientGeneratedIds.has(message.id) || persistedMessagesData?.mapById.has(message.id)) {
				continue;
			}

			if (!persistedMessagesData?.mapById.has(message.id)) {
				result.list.push(message);
			}

			const metadata = message.metadata as ai_chat_UiMessageMetadata | undefined;
			const parentIdOrRoot = metadata?.ai_chat.convexParentId ?? "_root";
			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(message);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [message]);
			}
		}

		return result;
	})();

	const anchorId = session?.anchorId;

	const anchorMessage = persistedMessagesData
		? anchorId
			? (persistedMessagesData.mapById.get(anchorId) ?? null)
			: (persistedMessagesData.list.at(0) ?? null)
		: null;

	const activeBranchMessages = ((/* iife */) => {
		const tail = [];
		const head = [];

		// Find tail messages from persisted messages.
		if (persistedMessagesData) {
			// Since we move upward and messages are ordered from newest to oldest
			// we should start from the newest (0).
			let current = anchorMessage ?? persistedMessagesData.list.at(0);
			while (current) {
				tail.push(current);
				const metadata = current.metadata as ai_chat_UiMessageMetadata | undefined;
				const parentIdOrRoot = metadata?.ai_chat.convexParentId ?? "_root";
				current = persistedMessagesData.mapById.get(parentIdOrRoot);
			}
		}

		// find head messages from pending or persisted messages.
		{
			// Since we move downward and messages are ordered from newest to oldest
			// we should start from the oldest (-1).
			let current = anchorMessage ?? pendingMessagesData.list.at(-1);
			while (current) {
				// The anchor is already included in the tail
				if (current !== anchorMessage) {
					head.push(current);
				}

				// Find the most recent child message.
				current =
					pendingMessagesData.childrenByParentId.get(current.id)?.at(0) ??
					persistedMessagesData?.childrenByParentId.get(current.id)?.at(0);
			}
		}

		return [...tail.toReversed(), ...head];
	})();

	const messagesChildrenByParentId = ((/* iife */) => {
		const result = new Map<string, UIMessage[]>();

		if (persistedMessagesData) {
			for (const [parentId, children] of persistedMessagesData.childrenByParentId.entries()) {
				result.set(parentId, children.toReversed());
			}
		}

		for (const [parentId, children] of pendingMessagesData.childrenByParentId.entries()) {
			result.set(parentId, [...(result.get(parentId) ?? []), ...children.toReversed()]);
		}

		return result;
	})();

	const startNewChat = (message?: string) => {
		const optimisticThread = create_optimistic_thread();
		const optimisticChat = create_chat_instance({
			chatId: optimisticThread._id,
			prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
		});
		useAiChatStore.actions.setSession(optimisticThread._id, () => {
			return thread_session_create({ optimisticThread: optimisticThread, chat: optimisticChat });
		});
		useAiChatStore.setState(() => ({ selectedThreadId: optimisticThread._id }));

		if (message?.trim()) {
			optimisticChat.sendMessage({
				role: "user",
				parts: [{ type: "text", text: message }],
				metadata: {
					ai_chat: {},
				} satisfies Partial<ai_chat_UiMessageMetadata>,
			});
		}
	};

	const selectThread = (threadId: string) => {
		let session = useAiChatStore.actions.getSession(threadId);
		if (!session) {
			session = useAiChatStore.actions.setSession(threadId, () => {
				return thread_session_create();
			});
		}

		if (!session?.chat) {
			const threadChat = create_chat_instance({
				chatId: threadId,
				prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			});
			useAiChatStore.actions.setSession(threadId, (prev) => {
				const base = prev ?? thread_session_create();
				return { ...base, ...prev, chat: threadChat };
			});
		}

		useAiChatStore.setState(() => {
			return { selectedThreadId: threadId };
		});
	};

	const selectBranchAnchor = (threadId: string, anchorId: string) => {
		useAiChatStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[useAiChatController.selectBranchAnchor] Missing session", {
					threadId,
					anchorId,
				});
				return;
			}

			return { ...prev, anchorId };
		});
	};

	const setThreadStarred = (threadId: string, starred: boolean) => {
		updateThread({ threadId: threadId as app_convex_Id<"threads">, starred }).catch(console.error);
	};

	const archiveThread = (threadId: string, isArchived: boolean) => {
		const storeSelectedThreadId = useAiChatStore.getState().selectedThreadId;
		const session = useAiChatStore.actions.getSession(threadId);

		// Optimistic threads exist only on the client; "archiving" them just removes the optimistic session.
		if (session?.optimisticThread) {
			if (!isArchived) {
				return;
			}
			if (storeSelectedThreadId === threadId) {
				useAiChatStore.setState(() => ({ selectedThreadId: null }));
			}
			useAiChatStore.actions.deleteSession(threadId);
			return;
		}

		if (isArchived && storeSelectedThreadId === threadId) {
			useAiChatStore.setState(() => ({ selectedThreadId: null }));
		}

		updateThread({ threadId: threadId as app_convex_Id<"threads">, isArchived }).catch(console.error);
	};

	const regenerate = (threadId: string, messageId: string) => {
		const session = useAiChatStore.getState().threadById.get(threadId);
		const chat = session?.chat;

		if (!session || !chat) {
			should_never_happen("[useAiChatController.regenerate] Missing deps", {
				threadId,
				messageId,
				session,
			});
			return;
		}

		const messageToRegenerate = persistedMessagesData?.mapById.get(messageId) ?? null;
		if (!messageToRegenerate) {
			should_never_happen("[useAiChatController.regenerate] Missing Convex message", {
				threadId,
				messageId,
			});
			return;
		}

		useAiChatStore.actions.setSession(threadId, (prev) => {
			const metadata = messageToRegenerate.metadata as ai_chat_UiMessageMetadata | undefined;
			const parentIdOrRoot = metadata?.ai_chat.convexParentId ?? "_root";

			const base = prev ?? thread_session_create();
			return {
				...base,
				...prev,
				anchorId: parentIdOrRoot,
			};
		});

		// Hydrate the chat with the exact branch that contains the target message id,
		// so AI SDK can slice correctly for regenerate.
		chat.messages = activeBranchMessages;

		chat.regenerate({ messageId }).catch(console.error);
	};

	const sendUserText = (threadId: string, value: string) => {
		if (!value.trim()) {
			return;
		}

		const session = useAiChatStore.actions.getSession(threadId);
		const chat = session?.chat;

		if (!session || !chat) {
			should_never_happen("[useAiChatController.sendUserText] Missing deps", {
				threadId,
				value,
			});
			return;
		}

		const convexParentId = activeBranchMessages.at(-1)?.id;

		chat.messages = activeBranchMessages;
		chat.sendMessage({
			role: "user",
			parts: [{ type: "text", text: value }],
			metadata: {
				ai_chat: {
					convexParentId,
				},
			} satisfies Partial<ai_chat_UiMessageMetadata>,
		});

		setComposerValue(threadId, "");
	};

	const setComposerValue = (threadId: string, message: string) => {
		useAiChatStore.actions.setSession(threadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.draftComposerText === message) {
				return base;
			}
			return { ...base, draftComposerText: message };
		});
	};

	const isRunning = chat.status === "submitted" || chat.status === "streaming";

	useEffect(() => {
		// Clean up optimistic threads that have been persisted.
		for (const session of threadById.values()) {
			if (!session.optimisticThread) continue;

			const optimisticThreadId = session.optimisticThread._id;

			const threadId = threadIdByExternalId.get(optimisticThreadId);
			if (threadId) {
				const persistedSession = useAiChatStore.actions.getSession(threadId);
				if (!persistedSession) {
					useAiChatStore.actions.setSession(threadId, () => {
						// @ts-expect-error: Overwrite the readonly chat id to the persisted thread id.
						session.chat.id = threadId;
						return { ...session, optimisticThread: undefined };
					});
				}

				useAiChatStore.actions.deleteSession(optimisticThreadId);

				// Swap selection to the persisted thread if the optimistic thread was selected.
				useAiChatStore.setState((prev) => {
					if (prev.selectedThreadId === optimisticThreadId) {
						return { ...prev, selectedThreadId: threadId };
					}

					return prev;
				});
			}
		}
	}, [persistedThreads]);

	return {
		selectedThreadId,
		session,

		threads,
		streamingTitleByThreadId,

		status: chat.status,
		error: chat.error,
		isRunning,
		activeBranchMessages,
		messagesChildrenByParentId,

		startNewChat,
		selectThread,
		selectBranchAnchor,
		setThreadStarred,
		archiveThread,

		setComposerValue,
		sendUserText,
		sendMessage: chat.sendMessage,
		regenerate,
		stop: chat.stop,
		resumeStream: chat.resumeStream,
		addToolOutput: chat.addToolOutput,
		clearError: chat.clearError,
		setMessages: chat.setMessages,
	};
};

export type AiChatController = ReturnType<typeof useAiChatController>;
