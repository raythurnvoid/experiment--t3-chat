import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type ChatOnFinishCallback } from "ai";
import { useEffect, useMemo } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { create } from "zustand";

import type { api_schemas_Main } from "@/lib/api-schemas.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppLocalStorageState } from "@/lib/storage.ts";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	get_id_generator,
	should_never_happen,
} from "@/lib/utils.ts";
import { useLiveRef } from "./utils-hooks.ts";
import { generate_id } from "../lib/utils.ts";
import {
	type ai_chat_AiSdk5UiMessage,
	ai_chat_DEFAULT_MAIN_MODEL_ID,
	ai_chat_is_main_model_id,
	type ai_chat_MainModelId,
	type ai_chat_Thread,
} from "@/lib/ai-chat.ts";

type ThreadChatArgs = {
	chatId: string | null;
	initialMessages?: ai_chat_AiSdk5UiMessage[] | undefined;
	prepareSendMessagesRequest: NonNullable<DefaultChatTransport<ai_chat_AiSdk5UiMessage>["prepareSendMessagesRequest"]>;
	onFinish?: (options: ThreadChatOnFinish) => void;
};

type ThreadSession = {
	chat: Chat<ai_chat_AiSdk5UiMessage> | null;
	draftComposerText: string;
	selectedModelId?: ai_chat_MainModelId;
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

type ChatRequestMetadata = {
	isOptimistic: boolean;
};

type ThreadChatOnFinish = Parameters<ChatOnFinishCallback<ai_chat_AiSdk5UiMessage>>[0] & {
	chatId: string;
};

const useAiChatStore = ((/* iife */) => {
	const initialSelectedThreadId = useAppLocalStorageState.getState().ai_chat_last_open;

	const store = create(() => ({
		selectedThreadId: initialSelectedThreadId ?? null,
		draftSelectedModelId: ai_chat_DEFAULT_MAIN_MODEL_ID as string,
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

export function ai_chat_is_optimistic_thread(thread?: ai_chat_Thread | null) {
	const clientGeneratedId = thread?.clientGeneratedId;
	if (!clientGeneratedId) {
		return false;
	}
	return thread._id === clientGeneratedId;
}

function strip_provider_metadata_from_message_parts(message: ai_chat_AiSdk5UiMessage) {
	return {
		...message,
		parts: message.parts?.map((part) => {
			if (!("providerMetadata" in part)) {
				return part;
			}

			const { providerMetadata: _providerMetadata, ...partWithoutProviderMetadata } = part;
			return partWithoutProviderMetadata;
		}) as ai_chat_AiSdk5UiMessage["parts"],
	} satisfies ai_chat_AiSdk5UiMessage;
}

function message_has_visible_parts(message: ai_chat_AiSdk5UiMessage) {
	return message.parts.some((part) => {
		if (part.type.startsWith("data-") || part.type === "step-start") {
			return false;
		}

		if ("text" in part) {
			return part.text.trim().length > 0;
		}

		return true;
	});
}

function get_message_selected_model_id(message?: ai_chat_AiSdk5UiMessage | null) {
	const selectedModelId = message?.metadata?.selectedModelId;
	if (!selectedModelId || !ai_chat_is_main_model_id(selectedModelId)) {
		return undefined;
	}

	return selectedModelId;
}

const thread_session_create = (args?: {
	optimisticThread?: ai_chat_Thread;
	chat?: Chat<ai_chat_AiSdk5UiMessage> | null;
	chatArgs?: ThreadChatArgs | undefined;
	selectedModelId?: ai_chat_MainModelId;
}) => {
	return {
		chat: args?.chat ?? (args?.chatArgs ? create_chat_instance(args.chatArgs) : null),
		draftComposerText: "",
		selectedModelId: args?.selectedModelId,
		anchorId: undefined,
		streamingTitle: undefined,
		optimisticThread: args?.optimisticThread,
	} satisfies ThreadSession;
};

function create_chat_instance(args: ThreadChatArgs) {
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
		onFinish: (options) => {
			args.onFinish?.({ ...options, chatId: chat.id });
		},
	});

	return chat;
}

export type useAiChatController_Props = {
	includeArchived?: boolean;
};

export const useAiChatController = (props?: useAiChatController_Props) => {
	const includeArchived = props?.includeArchived ?? true;

	const selectedThreadId = useAiChatStore((state) => state.selectedThreadId);
	const draftSelectedModelId = useAiChatStore((state) => state.draftSelectedModelId);
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
	const addThreadMessages = useMutation(app_convex_api.ai_chat.thread_messages_add);

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

	const persistedMessagesLookup = ((/* iife */) => {
		if (!persistedThreadMessages) return undefined;

		const result = {
			mapById: new Map<string, ai_chat_AiSdk5UiMessage>(),
			childrenByParentId: new Map<string | null, ai_chat_AiSdk5UiMessage[]>(),
			clientGeneratedIds: new Set<string>(),
			list: [] as ai_chat_AiSdk5UiMessage[],
		};

		for (const message of persistedThreadMessages.messages) {
			// Convert DB message to AI SDK UI message
			const dbMessageContent = message.content as ai_chat_AiSdk5UiMessage;
			const uiMessage = {
				id: message._id,
				role: dbMessageContent.role,
				parts: dbMessageContent.parts,
				metadata: {
					...(dbMessageContent.metadata ?? {}),
					convexId: message._id,
					convexParentId: message.parentId,
					parentClientGeneratedId: dbMessageContent.metadata?.parentClientGeneratedId ?? null,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
			} satisfies ai_chat_AiSdk5UiMessage;

			result.mapById.set(message._id, uiMessage);

			const parentIdOrRoot = message.parentId ?? null;
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

	const persistedSelectedModelId = ((/* iife */) => {
		if (!persistedMessagesLookup) {
			return undefined;
		}

		for (const message of persistedMessagesLookup.list) {
			if (message.role !== "user") {
				continue;
			}

			const selectedModelId = get_message_selected_model_id(message);
			if (selectedModelId) {
				return selectedModelId;
			}
		}

		return undefined;
	})();

	const selectedModelId = selectedThreadId
		? (session?.selectedModelId ?? persistedSelectedModelId ?? ai_chat_DEFAULT_MAIN_MODEL_ID)
		: draftSelectedModelId;

	useEffect(() => {
		if (!selectedThreadId || !session || session.selectedModelId !== undefined) {
			return;
		}

		useAiChatStore.actions.setSession(selectedThreadId, (prev) => {
			if (!prev || prev.selectedModelId !== undefined) {
				return;
			}

			return {
				...prev,
				selectedModelId: persistedSelectedModelId ?? ai_chat_DEFAULT_MAIN_MODEL_ID,
			};
		});
	}, [persistedSelectedModelId, selectedThreadId, session]);

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

			// Keep submit-message requests anchored to the persisted parent chosen during `sendUserText`.
			// After `stop`, `options.messages.at(-2)?.id` can still be the optimistic assistant id,
			// which creates a bogus sibling branch or a reconstruction failure.
			const parentId =
				options.trigger === "regenerate-message"
					? options.messages.at(-1)?.id
					: (messagesToAppend.at(-1)?.metadata?.convexParentId ?? null);

			const metadata = options.requestMetadata as ChatRequestMetadata;

			const requestBody = {
				...options.body,
				model: selectedModelId,
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

	const handleChatFinish = useLiveRef<(options: ThreadChatOnFinish) => void>((options) => {
		if (!options.isAbort) {
			return;
		}

		if (options.message.role !== "assistant") {
			return;
		}

		if (options.message.metadata?.convexId || !message_has_visible_parts(options.message)) {
			return;
		}

		const session = useAiChatStore.actions.getSession(options.chatId);
		const threadId =
			session?.optimisticThread && options.chatId === session.optimisticThread._id
				? null
				: (options.chatId as app_convex_Id<"ai_chat_threads">);

		if (!threadId) {
			return;
		}

		addThreadMessages({
			threadId,
			parentId: options.message.metadata?.convexParentId ?? null,
			messages: [
				{
					clientGeneratedMessageId: options.message.id,
					content: strip_provider_metadata_from_message_parts(options.message),
				},
			],
		}).catch((error) => {
			console.error("[useAiChatController.handleChatFinish] Failed to persist aborted assistant message", {
				error,
				threadId,
				messageId: options.message.id,
			});
		});
	});

	const unselectedChatInstance = create_chat_instance({
		chatId: null,
		prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
		onFinish: (options) => handleChatFinish.current(options),
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
				onFinish: (options) => handleChatFinish.current(options),
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

	const pendingMessagesLookup = ((/* iife */) => {
		const result = {
			list: [] as ai_chat_AiSdk5UiMessage[],
			mapById: new Map<string, ai_chat_AiSdk5UiMessage>(),
			/**
			 * The key can be either a convex id or a client-generated id.
			 */
			childrenByParentId: new Map<string | null, ai_chat_AiSdk5UiMessage[]>(),
		};

		// Read messages from the newest to the oldest.
		for (const message of chat.messages.toReversed()) {
			// Skip alredy persisted messages
			if (
				persistedMessagesLookup?.clientGeneratedIds.has(message.id) ||
				persistedMessagesLookup?.mapById.has(message.id)
			) {
				continue;
			}

			if (!persistedMessagesLookup?.mapById.has(message.id)) {
				result.list.push(message);
			}

			result.mapById.set(message.id, message);

			const parentIdOrRoot = ((/* iife */) => {
				let parentId = undefined;

				if (message.metadata?.convexParentId) {
					// When the parent message is persisted but convex is not synced yet,
					// the `convexParentId` is valorized but it will not resolve to any message,
					// to be sure it resolve to a message we check into `persistedMessagesLookup.mapById`
					parentId = persistedMessagesLookup?.mapById.get(message.metadata.convexParentId)?.id;
				}

				// When the parent message is persisted but convex is not synced yet
				// we have to fallback to associate this message to the clientGeneratedId
				// of the parent because the parent message is not yet coming from
				// the `persistedMessagesLookup` but is present only in the
				// AI SDK chat object, therefore it displays still as a pending message.
				if (!parentId) parentId = message.metadata?.parentClientGeneratedId;

				return parentId ?? null;
			})();

			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(message);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [message]);
			}
		}

		return result;
	})();

	const anchorMessage = persistedMessagesLookup
		? session?.anchorId
			? (persistedMessagesLookup.mapById.get(session.anchorId) ?? null)
			: (pendingMessagesLookup.list.at(0) ?? persistedMessagesLookup.list.at(0) ?? null)
		: null;

	const activeBranchMessages = ((/* iife */) => {
		const tail = [];
		const head = [];
		const mapById = new Map<string, ai_chat_AiSdk5UiMessage>();

		// Find tail messages from persisted messages.
		if (persistedMessagesLookup) {
			// Since we move upward and messages are ordered from newest to oldest
			// we should start from the newest (0).
			let current = anchorMessage ?? persistedMessagesLookup.list.at(0);
			while (current) {
				mapById.set(current.id, current);
				tail.push(current);
				current = ((/* iife */) => {
					let parentMessage = undefined;

					if (current.metadata?.convexParentId) {
						parentMessage = pendingMessagesLookup.mapById.get(current.metadata.convexParentId);
						if (!parentMessage) parentMessage = persistedMessagesLookup?.mapById.get(current.metadata.convexParentId);
					}

					// When sending a user message, in the convex BE we save it
					// immidiately, the assistant message will stream with a convex id
					// already set but the convex sync engine might not have synced it yed
					// so we need to fallback to the client-generated id to get it from
					// the pending messages lookup.
					if (current.metadata?.parentClientGeneratedId && !parentMessage) {
						parentMessage = pendingMessagesLookup.mapById.get(current.metadata.parentClientGeneratedId);
					}

					return parentMessage;
				})();
			}
		}

		// find head messages from pending or persisted messages.
		{
			// Since we move downward and messages are ordered from newest to oldest
			// we should start from the oldest (-1).
			let current = anchorMessage ?? pendingMessagesLookup.list.at(-1);
			while (current) {
				// The anchor is already included in the tail
				if (current !== anchorMessage) {
					mapById.set(current.id, current);
					head.push(current);
				}

				// Find the most recent child message.
				current =
					pendingMessagesLookup.childrenByParentId.get(current.id)?.at(0) ??
					persistedMessagesLookup?.childrenByParentId.get(current.id)?.at(0);
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

		if (persistedMessagesLookup) {
			for (const [parentId, children] of persistedMessagesLookup.childrenByParentId.entries()) {
				result.set(parentId, children.toReversed());
			}
		}

		for (const [parentId, children] of pendingMessagesLookup.childrenByParentId.entries()) {
			result.set(parentId, [...(result.get(parentId) ?? []), ...children.toReversed()]);
		}

		return result;
	})();

	const startNewChat = (message?: string) => {
		const nextSelectedModelId = selectedModelId;
		const optimisticThread = create_optimistic_thread();
		const optimisticChat = create_chat_instance({
			chatId: optimisticThread._id,
			prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			onFinish: (options) => handleChatFinish.current(options),
		});
		useAiChatStore.actions.setSession(optimisticThread._id, () => {
			return thread_session_create({
				optimisticThread: optimisticThread,
				chat: optimisticChat,
				selectedModelId: nextSelectedModelId,
			});
		});
		useAiChatStore.setState(() => ({
			selectedThreadId: optimisticThread._id,
			draftSelectedModelId: nextSelectedModelId,
		}));

		if (message?.trim()) {
			optimisticChat.sendMessage(
				{
					role: "user",
					parts: [{ type: "text", text: message }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
						selectedModelId: nextSelectedModelId,
					} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
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
			.catch((error) => {
				console.error("[useAiChatController.branchChat] Error branching chat", { error, threadId, messageId });
			});
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
				onFinish: (options) => handleChatFinish.current(options),
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
		updateThread({ threadId, starred }).catch((error) => {
			console.error("[useAiChatController.setThreadStarred] Error updating thread star", { error, threadId, starred });
		});
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

		updateThread({ threadId, isArchived }).catch((error) => {
			console.error("[useAiChatController.archiveThread] Error updating archive status", {
				error,
				threadId,
				isArchived,
			});
		});
	};

	const removeOptimisticThread = (threadId: string) => {
		const session = useAiChatStore.actions.getSession(threadId);
		if (!session?.optimisticThread) {
			return;
		}
		const storeSelectedThreadId = useAiChatStore.getState().selectedThreadId;
		if (storeSelectedThreadId === threadId) {
			useAiChatStore.setState(() => ({ selectedThreadId: null }));
		}
		useAiChatStore.actions.deleteSession(threadId);
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

		const messageToRegenerate = persistedMessagesLookup?.mapById.get(messageId) ?? null;
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
			.catch((error: unknown) => {
				console.error("[useAiChatController.regenerate] Error regenerating message", { error, threadId, messageId });
			});

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

		const threadSelectedModelId = session.selectedModelId ?? selectedModelId;

		const targetMessage = options?.messageId ? activeBranchMessages?.mapById.get(options.messageId) : null;
		const targetMessageIndex = targetMessage ? activeBranchMessages.list.indexOf(targetMessage) : undefined;
		const latestMessage = activeBranchMessages.list.at(-1);

		// Prevent the UI from breaking by hiding unnecessary optimistic messages
		// that can be created as the user stop and adds a new message to the chat
		// 1 or more times
		const shouldDropOptimisticAssistant = Boolean(
			!targetMessage && latestMessage?.role === "assistant" && !latestMessage.metadata?.convexId,
		);
		const nextChatMessages =
			targetMessageIndex !== undefined && targetMessageIndex >= 0
				? activeBranchMessages.list.slice(0, targetMessageIndex)
				: shouldDropOptimisticAssistant
					? activeBranchMessages.list.slice(0, -1)
					: activeBranchMessages.list;

		chat.messages = nextChatMessages;

		const parentMessageIds = targetMessage
			? {
					convexParentId: targetMessage.metadata?.convexParentId ?? null,
					parentClientGeneratedId: targetMessage.metadata?.parentClientGeneratedId ?? null,
				}
			: ((/* iife */) => {
					if (!latestMessage) {
						return {
							convexParentId: null,
							parentClientGeneratedId: null,
						};
					}

					// After a manual stop, the latest assistant message can remain optimistic-only.
					// In that case, keep threading on its resolved parent instead of its client id.
					if (latestMessage.role === "assistant" && !latestMessage.metadata?.convexId) {
						return {
							convexParentId: latestMessage.metadata?.convexParentId ?? latestMessage.id,
							parentClientGeneratedId: latestMessage.metadata?.parentClientGeneratedId ?? null,
						};
					}

					return {
						convexParentId: latestMessage.metadata?.convexId ?? latestMessage.id,
						parentClientGeneratedId: latestMessage.metadata?.parentClientGeneratedId ?? null,
					};
				})();

		chat.sendMessage(
			{
				role: "user",
				parts: [{ type: "text", text: value }],
				metadata: {
					convexParentId: parentMessageIds.convexParentId,
					parentClientGeneratedId: parentMessageIds.parentClientGeneratedId,
					selectedModelId: threadSelectedModelId,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
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

	const setSelectedModelId = (modelId: ai_chat_MainModelId) => {
		if (!selectedThreadId) {
			useAiChatStore.setState(() => ({ draftSelectedModelId: modelId }));
			return;
		}

		useAiChatStore.setState(() => ({ draftSelectedModelId: modelId }));

		useAiChatStore.actions.setSession(selectedThreadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.selectedModelId === modelId) {
				return base;
			}

			return {
				...base,
				selectedModelId: modelId,
			};
		});
	};

	const stop = () => {
		chat.stop().catch((error) => {
			console.error("[useAiChatController.stop] Failed to stop chat", {
				error,
				chatId: activeChatInstance.id,
			});
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
						session.chat.id = threadId;
						return { ...session, optimisticThread: undefined };
					});
				} else if (session.selectedModelId !== undefined && persistedSession.selectedModelId === undefined) {
					useAiChatStore.actions.setSession(threadId, (prev) => {
						if (!prev || prev.selectedModelId !== undefined) {
							return;
						}

						return {
							...prev,
							selectedModelId: session.selectedModelId,
						};
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
		selectedModelId,
		session,

		currentThreadsWithOptimistic,
		streamingTitleByThreadId,

		status,
		isRunning,
		error: chat.error,
		activeBranchMessages,
		messagesChildrenByParentId,

		startNewChat,
		branchChat,
		selectThread,
		selectBranchAnchor,
		setThreadStarred,
		archiveThread,
		removeOptimisticThread,

		setComposerValue,
		setSelectedModelId,
		sendUserText,
		regenerate,
		stop,
		resumeStream: chat.resumeStream,
		addToolOutput: chat.addToolOutput,
		setMessages: chat.setMessages,
	};
};

export type AiChatController = ReturnType<typeof useAiChatController>;
