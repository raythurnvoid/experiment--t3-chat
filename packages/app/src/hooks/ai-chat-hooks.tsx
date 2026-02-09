import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useEffect, useMemo } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { create } from "zustand";

import type { api_schemas_Main } from "@/lib/api-schemas.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppLocalStorageState } from "@/lib/app-local-storage-state.ts";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	get_id_generator,
	should_never_happen,
} from "@/lib/utils.ts";
import { useLiveRef, useRenderPromise } from "./utils-hooks.ts";
import { generate_id } from "../lib/utils.ts";
import { type ai_chat_AiSdk5UiMessage, type ai_chat_Message, type ai_chat_Thread } from "@/lib/ai-chat.ts";

export type ai_chat_UiMessageMetadata = NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>;

type ThreadChatArgs = {
	chatId: string | null;
	initialMessages?: ai_chat_AiSdk5UiMessage[] | undefined;
	prepareSendMessagesRequest: NonNullable<DefaultChatTransport<ai_chat_AiSdk5UiMessage>["prepareSendMessagesRequest"]>;
};

type ThreadSession = {
	chat: Chat<ai_chat_AiSdk5UiMessage> | null;
	draftComposerText: string;
	/**
	 * Optional branch anchor (Convex message id).
	 *
	 * This should point at the selected assistant-variant root message id.
	 * - `undefined`: default to the latest Convex message in the thread
	 * - `null`: use the root branch
	 */
	anchorId: string | null | undefined;
	streamingTitle?: string;
	optimisticThread?: ai_chat_Thread;
};

type ThreadStore = {
	selectedThreadId: string | null;
	threadById: Map<string, ThreadSession>;
};

type ChatRequestMetadata = {
	isOptimistic: boolean;
};

const useAiChatStore = ((/* iife */) => {
	const initialSelectedThreadId = useAppLocalStorageState.getState().ai_chat_last_open;

	const store = create<ThreadStore>(() => ({
		selectedThreadId: initialSelectedThreadId ?? null,
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

function create_optimistic_thread(): ai_chat_Thread {
	const clientId = generate_id("ai_thread");
	const now = Date.now();
	return {
		_id: clientId as app_convex_Id<"ai_chat_threads">,
		_creationTime: now,
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		clientGeneratedId: clientId,
		title: null,
		archived: false,
		starred: false,
		runtime: "aisdk_5",
		createdBy: "" as app_convex_Id<"users">,
		updatedBy: "" as app_convex_Id<"users">,
		updatedAt: now,
		lastMessageAt: now,
	};
}

/**
 * Returns a message parent id.
 *
 * `null` means the message is a root message (no parent).
 */
export function ai_chat_get_parent_id(parentId?: string | null) {
	return parentId ?? null;
}

export function ai_chat_is_optimistic_thread(thread?: ai_chat_Thread | null) {
	const clientGeneratedId = thread?.clientGeneratedId;
	if (!clientGeneratedId) {
		return false;
	}
	return thread._id === clientGeneratedId;
}

const thread_session_create = (args?: {
	optimisticThread?: ai_chat_Thread;
	chat?: Chat<ai_chat_AiSdk5UiMessage> | null;
	chatArgs?: ThreadChatArgs | undefined;
}) => {
	return {
		chat: args?.chat ?? (args?.chatArgs ? create_chat_instance(args.chatArgs) : null),
		draftComposerText: "",
		anchorId: undefined,
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

function convex_message_to_ui_message(message: ai_chat_Message, metadata?: ai_chat_UiMessageMetadata) {
	const mergedMetadata = merge_metadata(message.content.metadata, metadata);

	return {
		id: message._id,
		role: message.content.role,
		// TODO: improve types
		parts: message.content.parts as ai_chat_AiSdk5UiMessage["parts"],
		...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
	} satisfies ai_chat_AiSdk5UiMessage;
}

function create_chat_instance(args: {
	chatId: string | null;
	initialMessages?: ai_chat_AiSdk5UiMessage[] | undefined;
	prepareSendMessagesRequest: NonNullable<DefaultChatTransport<ai_chat_AiSdk5UiMessage>["prepareSendMessagesRequest"]>;
}) {
	const chat = new Chat<ai_chat_AiSdk5UiMessage>({
		id: args.chatId ?? generate_id("ai_thread"),
		generateId: get_id_generator("ai_message"),
		...(args.initialMessages ? { messages: args.initialMessages } : {}),
		transport: new DefaultChatTransport({
			api: app_fetch_main_api_url("/api/chat"),
			prepareSendMessagesRequest: args.prepareSendMessagesRequest,
		}),
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		onData: (part) => {
			if (!part.type?.startsWith("data-")) {
				return;
			}

			// TODO(ai-chat): Handle a server-emitted "persist-first" mapping part (e.g. `data-message-ids`).
			// Goal: when the backend persists the user message up front + allocates the assistant message doc,
			// it can emit a transient mapping from client UIMessage ids -> Convex message ids.
			// The client can then:
			// - rewrite/remove optimistic `chat.messages` entries deterministically (no DB `client_generated_message_id`)
			// - optionally treat a `persisted` barrier as the signal to drop all optimistic messages for this request.
			switch (part.type) {
				case "data-thread-id": {
					// The server emits `data-thread-id` *during the stream* when it created a new thread.
					//
					// We start in an "optimistic thread" (client-generated id) to let the UI show a New Chat entry instantly.
					// Once the server returns the real Convex thread id, we:
					// - create / update a "persisted session" keyed by the real id
					// - keep the optimistic session selected while streaming (avoid mid-stream `Chat` recreation)
					// - schedule a "selection swap" to the real thread after streaming ends
					//
					// Sidebar dedupe (see below) ensures we don't show BOTH optimistic + persisted entries.

					// @ts-expect-error: Overwrite the readonly chat id to the persisted thread id.
					chat.id = part.data.threadId;

					return;
				}
				case "data-chat-title": {
					useAiChatStore.actions.setSession(chat.id, (prev) => {
						if (!prev) {
							return;
						}

						return {
							...prev,
							streamingTitle: part.data.title,
						};
					});
					return;
				}
				default: {
					return;
				}
			}
		},
	});

	return chat;
}

export type useAiChatController_Props = {
	includeArchived?: boolean;
};

export const useAiChatController = (props?: useAiChatController_Props) => {
	useRenderPromise();

	const includeArchived = props?.includeArchived ?? true;

	const selectedThreadId = useAiChatStore((state) => state.selectedThreadId);
	const threadById = useAiChatStore((state) => state.threadById);

	const session = useAiChatStore((state) =>
		selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null,
	);

	const threads = usePaginatedQuery(app_convex_api.ai_chat.threads_list, { archived: false }, { initialNumItems: 100 });
	const archivedThreads = usePaginatedQuery(
		app_convex_api.ai_chat.threads_list,
		includeArchived ? { archived: true } : "skip",
		{ initialNumItems: 100 },
	);
	const updateThread = useMutation(app_convex_api.ai_chat.thread_update);
	const branchThread = useMutation(app_convex_api.ai_chat.thread_branch);

	const persistedThreadMessages = useQuery(
		app_convex_api.ai_chat.thread_messages_list,
		selectedThreadId && session && !session.optimisticThread
			? {
					threadId: selectedThreadId,
					order: "desc",
				}
			: "skip",
	);

	/** Necessary to manage optimistic threads and their swtch to persisted threads. */
	const threadIdByClientGeneratedId = ((/* iife */) => {
		const result = new Map<string, string>();
		for (const thread of threads.results) {
			result.set(thread.clientGeneratedId, thread._id);
		}
		return result;
	})();

	const optimisticThreads = ((/* iife */) => {
		const result: Array<ai_chat_Thread> = [];
		for (const session of threadById.values()) {
			if (session.optimisticThread && !threadIdByClientGeneratedId.has(session.optimisticThread._id)) {
				result.push(session.optimisticThread);
			}
		}
		return result;
	})();

	const currentThreadsWithOptimistic = ((/* iife */) => {
		const unarchived = {
			...threads,
			results: [...optimisticThreads, ...threads.results],
		};

		const archived = includeArchived ? archivedThreads : null;

		return {
			unarchived,
			archived,
		} as const;
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
			mapById: new Map<string, ai_chat_AiSdk5UiMessage>(),
			childrenByParentId: new Map<string | null, ai_chat_AiSdk5UiMessage[]>(),
			clientGeneratedIds: new Set<string>(),
			list: [] as ai_chat_AiSdk5UiMessage[],
		};

		for (const message of persistedThreadMessages.messages) {
			const uiMessage = convex_message_to_ui_message(message, {
				convexId: message._id,
				convexParentId: message.parentId,
			});

			result.mapById.set(message._id, uiMessage);

			const parentIdOrRoot = ai_chat_get_parent_id(message.parentId);
			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(uiMessage);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [uiMessage]);
			}

			if (message.clientGeneratedMessageId) {
				result.clientGeneratedIds.add(message.clientGeneratedMessageId);
			}

			result.list.push(uiMessage);
		}

		return result;
	})();

	const prepareSendMessagesRequest = useLiveRef<
		NonNullable<DefaultChatTransport<ai_chat_AiSdk5UiMessage>["prepareSendMessagesRequest"]>
	>(async (options) => {
		return (async (/* iife */) => {
			const headers = new Headers(options.headers);
			headers.set("Accept", "text/event-stream");

			const token = await AppAuthProvider.getToken();
			if (token) {
				headers.set("Authorization", `Bearer ${token}`);
			}

			// When regenerating the last message is a persisted assistant message,
			// When editing or submitting the last message is the optimistic user message.
			// The messages we send are the ones we want to persist.
			const messagesToAppend = options.trigger === "regenerate-message" ? [] : options.messages.slice(-1);

			// The `parentId` is the id of the persisted message to which we want to append the new message.
			const parentId =
				options.trigger === "regenerate-message" ? options.messages.at(-1)?.id : options.messages.at(-2)?.id;

			const metadata = options.requestMetadata as ChatRequestMetadata;

			const requestBody = {
				...options.body,

				threadId: metadata.isOptimistic ? undefined : options.id,
				clientGeneratedThreadId: metadata.isOptimistic ? options.id : undefined,

				messages: messagesToAppend,
				trigger: options.trigger,
				parentId,
			} satisfies api_schemas_Main["/api/chat"]["POST"]["body"];

			return {
				api: options.api,
				body: requestBody,
				credentials: "omit" satisfies RequestCredentials,
				headers,
			} as const;
		})().catch((error) =>
			Promise.reject(
				should_never_happen("Failed to prepare send messages request", {
					error,
					options,
				}),
			),
		);
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

			// This happens when a chat is pre-selected from local storage.
			// should_never_happen("[useAiChatController] Missing `session.chat` for selected thread", {
			// 	selectedThreadId,
			// 	hasSession: Boolean(session),
			// });

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

	const chat = useChat<ai_chat_AiSdk5UiMessage>({ chat: activeChatInstance });

	const pendingMessagesData = ((/* iife */) => {
		const result = {
			list: [] as ai_chat_AiSdk5UiMessage[],
			mapById: new Map<string, ai_chat_AiSdk5UiMessage>(),
			childrenByParentId: new Map<string | null, ai_chat_AiSdk5UiMessage[]>(),
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

			result.mapById.set(message.id, message);

			const parentIdOrRoot = ai_chat_get_parent_id(message.metadata?.convexParentId);
			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(message);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [message]);
			}
		}

		return result;
	})();

	const anchorMessage = persistedMessagesData
		? session?.anchorId
			? (persistedMessagesData.mapById.get(session.anchorId) ?? null)
			: (pendingMessagesData.list.at(0) ?? persistedMessagesData.list.at(0) ?? null)
		: null;

	const activeBranchMessages = ((/* iife */) => {
		const tail = [];
		const head = [];
		const mapById = new Map<string, ai_chat_AiSdk5UiMessage>();

		// Find tail messages from persisted messages.
		if (persistedMessagesData) {
			// Since we move upward and messages are ordered from newest to oldest
			// we should start from the newest (0).
			let current = anchorMessage ?? persistedMessagesData.list.at(0);
			while (current) {
				mapById.set(current.id, current);
				tail.push(current);
				current = current.metadata?.convexParentId
					? (pendingMessagesData.mapById.get(current.metadata.convexParentId) ??
						persistedMessagesData.mapById.get(current.metadata.convexParentId))
					: undefined;
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
					mapById.set(current.id, current);
					head.push(current);
				}

				// Find the most recent child message.
				current =
					pendingMessagesData.childrenByParentId.get(current.id)?.at(0) ??
					persistedMessagesData?.childrenByParentId.get(current.id)?.at(0);
			}
		}

		return {
			list: [...tail.toReversed(), ...head],
			mapById,
			anchorId: session ? session.anchorId : undefined,
		};
	})();

	const messagesChildrenByParentId = ((/* iife */) => {
		const result = new Map<string | null, ai_chat_AiSdk5UiMessage[]>();

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
			optimisticChat.sendMessage(
				{
					role: "user",
					parts: [{ type: "text", text: message }],
					metadata: {} satisfies ai_chat_UiMessageMetadata,
				},
				{
					metadata: {
						isOptimistic: true,
					} satisfies ChatRequestMetadata,
				},
			);
		}
	};

	const branchChat = (threadId: string, messageId?: string) => {
		branchThread({ threadId, ...(messageId ? { messageId } : {}) })
			.then((result) => {
				selectThread(result.threadId);
			})
			.catch(console.error);
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

		if (!session?.optimisticThread) {
			useAppLocalStorageState.setState({ ai_chat_last_open: threadId });
		}

		useAiChatStore.setState(() => {
			return { selectedThreadId: threadId };
		});
	};

	const selectBranchAnchor = (threadId: string, anchorId: string | null) => {
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
		updateThread({ threadId, starred }).catch(console.error);
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

		updateThread({ threadId, isArchived }).catch(console.error);
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

		// Hydrate the chat with the exact branch that contains the target message id,
		// so AI SDK can slice correctly for regenerate.
		chat.messages = activeBranchMessages.list;
		chat
			.regenerate({
				messageId,
				metadata: { isOptimistic: session.optimisticThread ? true : false } satisfies ChatRequestMetadata,
			})
			.catch(console.error);

		useAiChatStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[useAiChatController.regenerate] Missing session", {
					threadId,
				});
				return;
			}

			return {
				...prev,
				anchorId: null,
			};
		});
	};

	const sendUserText = (threadId: string, value: string, options?: { messageId?: string }) => {
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

		const targetMessage = options?.messageId ? activeBranchMessages?.mapById.get(options.messageId) : null;
		const targetMessageIndex = targetMessage ? activeBranchMessages.list.indexOf(targetMessage) : undefined;

		chat.messages = targetMessageIndex
			? activeBranchMessages.list.slice(0, targetMessageIndex)
			: activeBranchMessages.list;

		const parentId = targetMessage ? targetMessage.metadata?.convexParentId : activeBranchMessages.list.at(-1)?.id;

		chat.sendMessage(
			{
				role: "user",
				parts: [{ type: "text", text: value }],
				metadata: {
					convexParentId: parentId,
				} satisfies ai_chat_UiMessageMetadata,
			},
			{
				metadata: {
					isOptimistic: session.optimisticThread ? true : false,
				} satisfies ChatRequestMetadata,
			},
		);

		useAiChatStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[useAiChatController.regenerate] Missing session", {
					threadId,
				});
				return;
			}

			return {
				...prev,
				anchorId: null,
			};
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

	const status = ((/* iife */) => {
		if (!selectedThreadId || !session) {
			return "idle" as const;
		}
		if (session.optimisticThread) {
			return "loaded" as const;
		}
		if (persistedThreadMessages === undefined) {
			return "loading" as const;
		}
		return "loaded" as const;
	})();

	useEffect(() => {
		// Clean up optimistic threads that have been persisted.
		for (const session of threadById.values()) {
			if (!session.optimisticThread) continue;

			const optimisticThreadId = session.optimisticThread._id;

			const threadId = threadIdByClientGeneratedId.get(optimisticThreadId);
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
				if (useAiChatStore.getState().selectedThreadId === optimisticThreadId) {
					useAppLocalStorageState.setState({ ai_chat_last_open: threadId });
				}

				useAiChatStore.setState((prev) => {
					if (prev.selectedThreadId === optimisticThreadId) {
						return { ...prev, selectedThreadId: threadId };
					}

					return prev;
				});
			}
		}
	}, [threads.results]);

	return {
		selectedThreadId,
		session,

		currentThreadsWithOptimistic,
		streamingTitleByThreadId,

		status,
		error: chat.error,
		isRunning,
		activeBranchMessages,
		messagesChildrenByParentId,

		startNewChat,
		branchChat,
		selectThread,
		selectBranchAnchor,
		setThreadStarred,
		archiveThread,

		setComposerValue,
		sendUserText,
		regenerate,
		stop: chat.stop,
		resumeStream: chat.resumeStream,
		addToolOutput: chat.addToolOutput,
		clearError: chat.clearError,
		setMessages: chat.setMessages,
	};
};

export type AiChatController = ReturnType<typeof useAiChatController>;
