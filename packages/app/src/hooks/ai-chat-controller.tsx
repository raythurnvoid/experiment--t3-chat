import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type ChatOnFinishCallback } from "ai";
import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { create } from "zustand";

import type { api_schemas_Main } from "@/lib/api-schemas.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_local_storage_get_value, app_local_storage_set_value, type storage_local_Key } from "@/lib/storage.ts";
import { generate_id, get_id_generator, should_never_happen } from "@/lib/utils.ts";
import { useFn, useLiveRef } from "./utils-hooks.ts";
import {
	type ai_chat_AiSdk5UiMessage,
	ai_chat_DEFAULT_MODEL_ID,
	ai_chat_DEFAULT_MODE_ID,
	ai_chat_is_model_id,
	ai_chat_is_mode_id,
	type ai_chat_ModelId,
	type ai_chat_ModeId,
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
	selectedModelId?: ai_chat_ModelId;
	selectedModeId?: ai_chat_ModeId;
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

type ThreadRenderStatus = "idle" | "loading" | "loaded";

type UseChatResult = ReturnType<typeof useChat<ai_chat_AiSdk5UiMessage>>;

export type AiChatOptimisticThreadId = ReturnType<typeof generate_id<"ai_thread">>;

type StoreState = {
	draftSelectedModelId: ai_chat_ModelId;
	draftSelectedModeId: ai_chat_ModeId;
	threadById: Map<string, ThreadSession>;
	messageById: Map<string, ai_chat_AiSdk5UiMessage>;
	activeMessageIdsByThreadId: Map<string, readonly string[]>;
	branchSiblingIdsByMessageId: Map<string, readonly string[]>;
	runningMessageIdByThreadId: Map<string, string | null>;
	failedSendUserMessageIdByThreadId: Map<string, string | null>;
	streamErrorTextByThreadId: Map<string, string | null>;
	threadStatusByThreadId: Map<string, ThreadRenderStatus>;
	editingMessageIdByThreadId: Map<string, string | null>;
};

const DERIVED_CACHE_CLEAR_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cache persisted Convex messages by their final message id so query refreshes do not recreate old UIMessage objects.
 * Persisted chat messages are append-only today: editing creates a new branch message, and streaming lives in pending state.
 */
const persistedUiMessageById = new Map<string, ai_chat_AiSdk5UiMessage>();

/**
 * Share one cache cleanup interval across every mounted chat controller.
 */
let cacheClearIntervalId: ReturnType<typeof setInterval> | undefined;
let cacheClearIntervalConsumerCount = 0;

export type AiChatRuntimeActions = {
	addToolOutput: UseChatResult["addToolOutput"];
	resumeStream: UseChatResult["resumeStream"];
	stop: () => void;
	setSelectedModelId: (modelId: ai_chat_ModelId) => void;
	setSelectedModeId: (modeId: ai_chat_ModeId) => void;
	sendUserText: (threadId: string, value: string, options?: { messageId?: string }) => void;
	regenerate: (threadId: string, messageId: string) => void;
	branchChat: (threadId: string, messageId?: string) => void;
	selectBranchAnchor: (threadId: string, anchorId: string | null) => void;
	setEditingMessageId: (threadId: string, messageId: string | null) => void;
};

type FullPageStorageKey = Extract<storage_local_Key, `app_state::ai_chat_last_open::scope::${string}`>;

type SidebarSelectedTabStorageKey = Extract<
	storage_local_Key,
	`app_state::file_editor_sidebar_agent_selected_tab::scope::${string}`
>;

type SidebarOpenTabsStorageKey = Extract<
	storage_local_Key,
	`app_state::file_editor_sidebar_open_tabs::scope::${string}`
>;

export type AiChatControllerStorageKey = FullPageStorageKey | SidebarSelectedTabStorageKey;

type SelectionSetOptions = {
	persist?: boolean;
};

type SelectionNext = string | null | ((previousThreadId: string | null) => string | null);

type SelectionContextValue = {
	selectedThreadId: string | null;
	setSelectedThreadId: (next: SelectionNext, options?: SelectionSetOptions) => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export type AiChatController_Props = {
	storageKey: AiChatControllerStorageKey;
	children?: ReactNode;
};

const SIDEBAR_SELECTED_TAB_STORAGE_KEY_PREFIX = "app_state::file_editor_sidebar_agent_selected_tab::scope::";
const SIDEBAR_OPEN_TABS_STORAGE_KEY_PREFIX = "app_state::file_editor_sidebar_open_tabs::scope::";

function is_sidebar_selected_tab_storage_key(
	storageKey: AiChatControllerStorageKey,
): storageKey is SidebarSelectedTabStorageKey {
	return storageKey.startsWith(SIDEBAR_SELECTED_TAB_STORAGE_KEY_PREFIX);
}

function get_sidebar_open_tabs_storage_key(storageKey: SidebarSelectedTabStorageKey): SidebarOpenTabsStorageKey {
	return storageKey.replace(
		SIDEBAR_SELECTED_TAB_STORAGE_KEY_PREFIX,
		SIDEBAR_OPEN_TABS_STORAGE_KEY_PREFIX,
	) as SidebarOpenTabsStorageKey;
}

function get_initial_selected_thread_id(storageKey: AiChatControllerStorageKey) {
	const selectedThreadId = app_local_storage_get_value(storageKey);
	if (!is_sidebar_selected_tab_storage_key(storageKey)) {
		return selectedThreadId;
	}

	const openTabs = app_local_storage_get_value(get_sidebar_open_tabs_storage_key(storageKey));
	const selectedOpenTab = openTabs.find((tab) => tab.id === selectedThreadId);
	return selectedOpenTab?.id ?? openTabs.at(-1)?.id ?? null;
}

function ControllerProvider(props: AiChatController_Props) {
	const { storageKey, children } = props;

	const [selectedThreadId, setSelectedThreadIdState] = useState(() => get_initial_selected_thread_id(storageKey));
	const selectedThreadIdRef = useRef(selectedThreadId);

	const setSelectedThreadId = useFn<SelectionContextValue["setSelectedThreadId"]>((next, options) => {
		const previousThreadId = selectedThreadIdRef.current;
		const nextThreadId = typeof next === "function" ? next(previousThreadId) : next;
		if (nextThreadId === previousThreadId) {
			return;
		}

		// Keep the latest selected id available synchronously for optimistic-id upgrade races.
		selectedThreadIdRef.current = nextThreadId;
		if (options?.persist === true && nextThreadId) {
			app_local_storage_set_value(storageKey, nextThreadId);
		}
		setSelectedThreadIdState(nextThreadId);
	});

	const value = useMemo(() => {
		return {
			selectedThreadId,
			setSelectedThreadId,
		} satisfies SelectionContextValue;
	}, [selectedThreadId, setSelectedThreadId]);

	return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useControllerSelection() {
	const selection = useContext(SelectionContext);
	if (!selection) {
		throw new Error("AiChatController hooks must be used inside AiChatController");
	}

	return selection;
}

function readonly_string_arrays_equal(a: readonly string[] | undefined, b: readonly string[]) {
	if (!a || a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
}

function create_optimistic_thread(tenant: {
	workspaceId: string;
	projectId: string;
	threadId: AiChatOptimisticThreadId;
}): ai_chat_Thread {
	const now = Date.now();
	return {
		_id: tenant.threadId as app_convex_Id<"ai_chat_threads">,
		_creationTime: now,
		workspaceId: tenant.workspaceId,
		projectId: tenant.projectId,
		clientGeneratedId: tenant.threadId,
		title: null,
		archived: false,
		starred: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: "" as app_convex_Id<"users">,
		updatedBy: "" as app_convex_Id<"users">,
		updatedAt: now,
		lastMessageAt: now,
	};
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
	if (!selectedModelId || !ai_chat_is_model_id(selectedModelId)) {
		return undefined;
	}

	return selectedModelId;
}

function get_message_selected_mode_id(message?: ai_chat_AiSdk5UiMessage | null) {
	const selectedModeId =
		message?.metadata?.selectedModeId ?? (message?.metadata as { selectedMode?: string } | undefined)?.selectedMode;
	if (!selectedModeId || !ai_chat_is_mode_id(selectedModeId)) {
		return undefined;
	}

	return selectedModeId;
}

const thread_session_create = (args?: {
	optimisticThread?: ai_chat_Thread;
	chat?: Chat<ai_chat_AiSdk5UiMessage> | null;
	chatArgs?: ThreadChatArgs | undefined;
	selectedModelId?: ai_chat_ModelId;
	selectedModeId?: ai_chat_ModeId;
}) => {
	return {
		chat: args?.chat ?? (args?.chatArgs ? create_chat_instance(args.chatArgs) : null),
		draftComposerText: "",
		selectedModelId: args?.selectedModelId,
		selectedModeId: args?.selectedModeId,
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
					useStore.actions.setSession(chat.id, (prev) => {
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

const useStore = ((/* iife */) => {
	const store = create<StoreState>(() => ({
		draftSelectedModelId: ai_chat_DEFAULT_MODEL_ID,
		draftSelectedModeId: ai_chat_DEFAULT_MODE_ID,
		threadById: new Map(),
		messageById: new Map(),
		activeMessageIdsByThreadId: new Map(),
		branchSiblingIdsByMessageId: new Map(),
		runningMessageIdByThreadId: new Map(),
		failedSendUserMessageIdByThreadId: new Map(),
		streamErrorTextByThreadId: new Map(),
		threadStatusByThreadId: new Map(),
		editingMessageIdByThreadId: new Map(),
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
			setEditingMessageId(threadId: string, messageId: string | null) {
				store.setState((state) => {
					if ((state.editingMessageIdByThreadId.get(threadId) ?? null) === messageId) {
						return state;
					}

					const editingMessageIdByThreadId = new Map(state.editingMessageIdByThreadId);
					editingMessageIdByThreadId.set(threadId, messageId);
					return { editingMessageIdByThreadId };
				});
			},
			clearRenderState() {
				store.setState({
					messageById: new Map(),
					activeMessageIdsByThreadId: new Map(),
					branchSiblingIdsByMessageId: new Map(),
					runningMessageIdByThreadId: new Map(),
					failedSendUserMessageIdByThreadId: new Map(),
					streamErrorTextByThreadId: new Map(),
					threadStatusByThreadId: new Map(),
					editingMessageIdByThreadId: new Map(),
				});
			},
			syncThreadRenderState(args: {
				threadId: string | null;
				status: ThreadRenderStatus;
				messages: readonly ai_chat_AiSdk5UiMessage[];
				branchSiblingIdsByParentId: Map<string | null, readonly string[]>;
				isRunning: boolean;
				hasError: boolean;
			}) {
				const { threadId } = args;
				if (!threadId) {
					return;
				}

				store.setState((state) => {
					let changed = false;

					let messageById = state.messageById;
					for (const message of args.messages) {
						if (messageById.get(message.id) === message) {
							continue;
						}

						if (messageById === state.messageById) {
							messageById = new Map(messageById);
						}
						messageById.set(message.id, message);
						changed = true;
					}

					const nextActiveMessageIds = args.messages.map((message) => message.id);
					let activeMessageIdsByThreadId = state.activeMessageIdsByThreadId;
					if (!readonly_string_arrays_equal(activeMessageIdsByThreadId.get(threadId), nextActiveMessageIds)) {
						activeMessageIdsByThreadId = new Map(activeMessageIdsByThreadId);
						activeMessageIdsByThreadId.set(threadId, nextActiveMessageIds);
						changed = true;
					}

					let branchSiblingIdsByMessageId = state.branchSiblingIdsByMessageId;
					for (const siblingIds of args.branchSiblingIdsByParentId.values()) {
						const stableSiblingIds =
							siblingIds.find((messageId) =>
								readonly_string_arrays_equal(branchSiblingIdsByMessageId.get(messageId), siblingIds),
							) ?? null;
						const nextSiblingIds = stableSiblingIds
							? (branchSiblingIdsByMessageId.get(stableSiblingIds) ?? siblingIds)
							: siblingIds;

						for (const messageId of siblingIds) {
							if (branchSiblingIdsByMessageId.get(messageId) === nextSiblingIds) {
								continue;
							}

							if (branchSiblingIdsByMessageId === state.branchSiblingIdsByMessageId) {
								branchSiblingIdsByMessageId = new Map(branchSiblingIdsByMessageId);
							}
							branchSiblingIdsByMessageId.set(messageId, nextSiblingIds);
							changed = true;
						}
					}

					const runningMessageId = args.isRunning ? (nextActiveMessageIds.at(-1) ?? null) : null;
					let runningMessageIdByThreadId = state.runningMessageIdByThreadId;
					if ((runningMessageIdByThreadId.get(threadId) ?? null) !== runningMessageId) {
						runningMessageIdByThreadId = new Map(runningMessageIdByThreadId);
						runningMessageIdByThreadId.set(threadId, runningMessageId);
						changed = true;
					}

					const latestMessage = args.messages.at(-1);
					const failedSendUserMessageId =
						args.hasError && !args.isRunning && latestMessage?.role === "user" ? latestMessage.id : null;
					let failedSendUserMessageIdByThreadId = state.failedSendUserMessageIdByThreadId;
					if ((failedSendUserMessageIdByThreadId.get(threadId) ?? null) !== failedSendUserMessageId) {
						failedSendUserMessageIdByThreadId = new Map(failedSendUserMessageIdByThreadId);
						failedSendUserMessageIdByThreadId.set(threadId, failedSendUserMessageId);
						changed = true;
					}

					const streamErrorText =
						args.hasError && !failedSendUserMessageId ? "An error occurred during the generation" : null;
					let streamErrorTextByThreadId = state.streamErrorTextByThreadId;
					if ((streamErrorTextByThreadId.get(threadId) ?? null) !== streamErrorText) {
						streamErrorTextByThreadId = new Map(streamErrorTextByThreadId);
						streamErrorTextByThreadId.set(threadId, streamErrorText);
						changed = true;
					}

					let threadStatusByThreadId = state.threadStatusByThreadId;
					if ((threadStatusByThreadId.get(threadId) ?? "idle") !== args.status) {
						threadStatusByThreadId = new Map(threadStatusByThreadId);
						threadStatusByThreadId.set(threadId, args.status);
						changed = true;
					}

					if (!changed) {
						return state;
					}

					return {
						messageById,
						activeMessageIdsByThreadId,
						branchSiblingIdsByMessageId,
						runningMessageIdByThreadId,
						failedSendUserMessageIdByThreadId,
						streamErrorTextByThreadId,
						threadStatusByThreadId,
					};
				});
			},
		},
	});
})();

type useThreadList_Props = {
	includeArchived?: boolean;
};

const useThreadList = (props?: useThreadList_Props) => {
	const includeArchived = props?.includeArchived ?? true;

	const { membershipId, workspaceId, projectId } = AppTenantProvider.useContext();
	const { selectedThreadId, setSelectedThreadId } = useControllerSelection();

	const draftSelectedModelId = useStore((state) => state.draftSelectedModelId);
	const draftSelectedModeId = useStore((state) => state.draftSelectedModeId);
	const threadById = useStore((state) => state.threadById);
	const session = useStore((state) =>
		selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null,
	);

	const threads = usePaginatedQuery(
		app_convex_api.ai_chat.threads_list,
		{ membershipId, archived: false },
		{ initialNumItems: 100 },
	);

	const archivedThreads = usePaginatedQuery(
		app_convex_api.ai_chat.threads_list,
		includeArchived ? { membershipId, archived: true } : "skip",
		{ initialNumItems: 100 },
	);

	const updateThread = useMutation(app_convex_api.ai_chat.thread_update);
	const branchThread = useMutation(app_convex_api.ai_chat.thread_branch);
	const addThreadMessages = useMutation(app_convex_api.ai_chat.thread_messages_add);

	const selectedModelId = selectedThreadId ? (session?.selectedModelId ?? draftSelectedModelId) : draftSelectedModelId;
	const selectedModeId = selectedThreadId ? (session?.selectedModeId ?? draftSelectedModeId) : draftSelectedModeId;

	/** Necessary to manage optimistic threads and their switch to persisted threads. */
	const threadIdByClientGeneratedId = useMemo(() => {
		const result = new Map<string, string>();
		for (const thread of threads.results) {
			if (thread.clientGeneratedId && thread.clientGeneratedId !== thread._id) {
				result.set(thread.clientGeneratedId, thread._id);
			}
		}
		return result;
	}, [threads.results]);

	const optimisticThreads = useMemo(() => {
		const result: Array<ai_chat_Thread> = [];
		for (const session of threadById.values()) {
			if (session.optimisticThread && !threadIdByClientGeneratedId.has(session.optimisticThread._id)) {
				result.push(session.optimisticThread);
			}
		}
		return result;
	}, [threadById, threadIdByClientGeneratedId]);

	const persistedSelectedThreadId = selectedThreadId ? threadIdByClientGeneratedId.get(selectedThreadId) : undefined;

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

			const messagesToAppend = options.trigger === "regenerate-message" ? [] : options.messages.slice(-1);
			const parentId =
				options.trigger === "regenerate-message"
					? options.messages.at(-1)?.id
					: (messagesToAppend.at(-1)?.metadata?.convexParentId ?? null);
			const metadata = options.requestMetadata as ChatRequestMetadata;
			const storeState = useStore.getState();
			const requestSession = storeState.threadById.get(options.id);
			const requestSelectedModelId = requestSession?.selectedModelId;
			const requestSelectedModeId = requestSession?.selectedModeId;
			const modelForRequest =
				requestSelectedModelId && ai_chat_is_model_id(requestSelectedModelId)
					? requestSelectedModelId
					: storeState.draftSelectedModelId;
			const modeForRequest =
				requestSelectedModeId && ai_chat_is_mode_id(requestSelectedModeId)
					? requestSelectedModeId
					: storeState.draftSelectedModeId;

			const requestBody = {
				...options.body,
				model: modelForRequest,
				mode: modeForRequest,
				threadId: metadata.isOptimistic ? undefined : options.id,
				clientGeneratedThreadId: metadata.isOptimistic ? options.id : undefined,
				messages: messagesToAppend,
				trigger: options.trigger,
				parentId,
				membershipId,
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

		const session = useStore.actions.getSession(options.chatId);
		const threadId =
			session?.optimisticThread && options.chatId === session.optimisticThread._id
				? null
				: (options.chatId as app_convex_Id<"ai_chat_threads">);

		if (!threadId) {
			return;
		}

		addThreadMessages({
			membershipId,
			threadId,
			parentId: options.message.metadata?.convexParentId ?? null,
			messages: [
				{
					clientGeneratedMessageId: options.message.id,
					content: strip_provider_metadata_from_message_parts(options.message),
				},
			],
		})
			.then((result) => {
				if (result._nay) {
					console.error(
						"[AiChatController.useThreadList.handleChatFinish] Failed to persist aborted assistant message",
						{
							result,
							threadId,
							messageId: options.message.id,
						},
					);
				}
			})
			.catch((error) => {
				console.error("[AiChatController.useThreadList.handleChatFinish] Failed to persist aborted assistant message", {
					error,
					threadId,
					messageId: options.message.id,
				});
			});
	});

	const createThreadChat = (chatId: string | null) => {
		return create_chat_instance({
			chatId,
			prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			onFinish: (options) => handleChatFinish.current(options),
		});
	};

	const startNewChat = (message?: string) => {
		const nextSelectedModelId = selectedModelId;
		const nextSelectedModeId = selectedModeId;
		const threadId = generate_id("ai_thread");
		const optimisticThread = create_optimistic_thread({ workspaceId, projectId, threadId });
		const optimisticChat = createThreadChat(threadId);
		useStore.actions.setSession(threadId, () => {
			return thread_session_create({
				optimisticThread: optimisticThread,
				chat: optimisticChat,
				selectedModelId: nextSelectedModelId,
				selectedModeId: nextSelectedModeId,
			});
		});
		useStore.setState(() => ({
			draftSelectedModelId: nextSelectedModelId,
			draftSelectedModeId: nextSelectedModeId,
		}));
		setSelectedThreadId(threadId, { persist: false });

		if (message?.trim()) {
			optimisticChat.sendMessage(
				{
					role: "user",
					parts: [{ type: "text", text: message }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
						selectedModelId: nextSelectedModelId,
						selectedModeId: nextSelectedModeId,
					} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
				},
				{
					metadata: {
						isOptimistic: true,
					} satisfies ChatRequestMetadata,
				},
			);
		}

		return threadId;
	};

	const branchChat = (threadId: string, messageId?: string) => {
		branchThread({ membershipId, threadId, ...(messageId ? { messageId } : {}) })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadList.branchChat] Branch failed", { result, threadId, messageId });
					return;
				}

				selectThread(result._yay.threadId);
			})
			.catch((error) => {
				console.error("[AiChatController.useThreadList.branchChat] Error branching chat", {
					error,
					threadId,
					messageId,
				});
			});
	};

	const selectThread = (threadId: string) => {
		let session = useStore.actions.getSession(threadId);
		if (!session) {
			session = useStore.actions.setSession(threadId, () => {
				return thread_session_create();
			});
		}

		if (!session?.chat) {
			const threadChat = createThreadChat(threadId);
			useStore.actions.setSession(threadId, (prev) => {
				const base = prev ?? thread_session_create();
				return { ...base, ...prev, chat: threadChat };
			});
		}

		setSelectedThreadId(threadId, { persist: !session?.optimisticThread });
	};

	const clearSelectedThread = () => {
		setSelectedThreadId(null, { persist: false });
	};

	const setThreadStarred = (threadId: string, starred: boolean) => {
		void updateThread({ threadId, membershipId, starred })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadList.setThreadStarred] Failed to update thread star", {
						result,
						threadId,
						starred,
					});
				}
			})
			.catch((error: unknown) => {
				console.error("[AiChatController.useThreadList.setThreadStarred] Unexpected error updating thread star", {
					error,
					threadId,
					starred,
				});
			});
	};

	const archiveThread = (threadId: string, isArchived: boolean) => {
		const session = useStore.actions.getSession(threadId);

		if (session?.optimisticThread) {
			if (!isArchived) {
				return;
			}
			setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
				persist: false,
			});
			useStore.actions.deleteSession(threadId);
			return;
		}

		void updateThread({ membershipId, threadId, isArchived })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadList.archiveThread] Failed to update archive status", {
						result,
						threadId,
						isArchived,
					});
					return;
				}

				if (isArchived) {
					setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
						persist: false,
					});
				}
			})
			.catch((error: unknown) => {
				console.error("[AiChatController.useThreadList.archiveThread] Unexpected error updating archive status", {
					error,
					threadId,
					isArchived,
				});
			});
	};

	const removeOptimisticThread = (threadId: string) => {
		const session = useStore.actions.getSession(threadId);
		if (!session?.optimisticThread) {
			return;
		}
		setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
			persist: false,
		});
		useStore.actions.deleteSession(threadId);
	};

	// Upgrade stale optimistic selections so tab synchronization does not
	// re-add a client-generated id after the real thread has appeared.
	useEffect(() => {
		if (!selectedThreadId || !persistedSelectedThreadId || persistedSelectedThreadId === selectedThreadId) {
			return;
		}

		setSelectedThreadId(
			(currentThreadId) => {
				// The user may have selected another thread before this effect runs.
				// Keep that newer selection instead of replacing it with this stale optimistic upgrade.
				if (currentThreadId !== selectedThreadId) {
					return currentThreadId;
				}

				return persistedSelectedThreadId;
			},
			{ persist: true },
		);
	}, [persistedSelectedThreadId, selectedThreadId, setSelectedThreadId]);

	useEffect(() => {
		useStore.setState({ threadById: new Map() });
		persistedUiMessageById.clear();
	}, [membershipId]);

	useEffect(() => {
		cacheClearIntervalConsumerCount += 1;
		if (!cacheClearIntervalId) {
			cacheClearIntervalId = setInterval(() => {
				// Clear process-local persisted-message cache periodically so long-lived tabs don't retain every visited row forever.
				persistedUiMessageById.clear();
			}, DERIVED_CACHE_CLEAR_INTERVAL_MS);
		}

		return () => {
			cacheClearIntervalConsumerCount -= 1;
			if (cacheClearIntervalConsumerCount === 0 && cacheClearIntervalId) {
				clearInterval(cacheClearIntervalId);
				cacheClearIntervalId = undefined;
			}
		};
	}, []);

	useEffect(() => {
		for (const session of threadById.values()) {
			if (!session.optimisticThread) continue;

			const optimisticThreadId = session.optimisticThread._id;

			const threadId = threadIdByClientGeneratedId.get(optimisticThreadId);
			if (threadId) {
				const persistedSession = useStore.actions.getSession(threadId);
				if (!persistedSession) {
					useStore.actions.setSession(threadId, () => {
						if (!session.chat) {
							return;
						}

						// @ts-expect-error: Overwrite the readonly chat id to the persisted thread id.
						session.chat.id = threadId;
						return { ...session, optimisticThread: undefined };
					});
				} else {
					if (session.selectedModelId !== undefined && persistedSession.selectedModelId === undefined) {
						useStore.actions.setSession(threadId, (prev) => {
							if (!prev || prev.selectedModelId !== undefined) {
								return;
							}

							return {
								...prev,
								selectedModelId: session.selectedModelId,
							};
						});
					}

					if (session.selectedModeId !== undefined && persistedSession.selectedModeId === undefined) {
						useStore.actions.setSession(threadId, (prev) => {
							if (!prev || prev.selectedModeId !== undefined) {
								return;
							}

							return {
								...prev,
								selectedModeId: session.selectedModeId,
							};
						});
					}
				}

				useStore.actions.deleteSession(optimisticThreadId);

				setSelectedThreadId(
					(currentThreadId) => {
						if (currentThreadId === optimisticThreadId) {
							return threadId;
						}

						return currentThreadId;
					},
					{ persist: true },
				);
			}
		}
	}, [setSelectedThreadId, threadById, threadIdByClientGeneratedId]);

	return {
		selectedThreadId,
		selectedModelId,
		selectedModeId,
		session,
		currentThreadsWithOptimistic,
		streamingTitleByThreadId,
		startNewChat,
		branchChat,
		selectThread,
		clearSelectedThread,
		setThreadStarred,
		archiveThread,
		removeOptimisticThread,
	};
};

export type AiChatThreadListController = ReturnType<typeof useThreadList>;

const useThreadRuntimeController = () => {
	const { membershipId, workspaceId, projectId } = AppTenantProvider.useContext();
	const { selectedThreadId, setSelectedThreadId } = useControllerSelection();

	const draftSelectedModelId = useStore((state) => state.draftSelectedModelId);
	const draftSelectedModeId = useStore((state) => state.draftSelectedModeId);

	const session = useStore((state) =>
		selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null,
	);
	const selectedThreadFailedSendUserMessageId = useStore((state) =>
		selectedThreadId ? (state.failedSendUserMessageIdByThreadId.get(selectedThreadId) ?? null) : null,
	);

	const updateThread = useMutation(app_convex_api.ai_chat.thread_update);
	const branchThread = useMutation(app_convex_api.ai_chat.thread_branch);
	const addThreadMessages = useMutation(app_convex_api.ai_chat.thread_messages_add);

	const persistedThreadMessages = useQuery(
		app_convex_api.ai_chat.thread_messages_list,
		selectedThreadId && !session?.optimisticThread
			? {
					membershipId,
					threadId: selectedThreadId,
					order: "desc",
				}
			: "skip",
	);

	const persistedMessagesLookup = ((/* iife */) => {
		if (!persistedThreadMessages) return undefined;

		const result = {
			mapById: new Map<string, ai_chat_AiSdk5UiMessage>(),
			mapByClientGeneratedId: new Map<string, ai_chat_AiSdk5UiMessage>(),
			childrenByParentId: new Map<string | null, ai_chat_AiSdk5UiMessage[]>(),
			clientGeneratedIds: new Set<string>(),
			list: [] as ai_chat_AiSdk5UiMessage[],
		};

		for (const message of persistedThreadMessages.messages) {
			// Convert DB message to AI SDK UI message
			const dbMessageContent = message.content as ai_chat_AiSdk5UiMessage;
			const cachedUiMessage = persistedUiMessageById.get(message._id);
			const uiMessage =
				cachedUiMessage ??
				({
					id: message._id,
					role: dbMessageContent.role,
					parts: dbMessageContent.parts,
					metadata: {
						...(dbMessageContent.metadata ?? {}),
						convexId: message._id,
						convexParentId: message.parentId,
						parentClientGeneratedId: dbMessageContent.metadata?.parentClientGeneratedId ?? null,
					} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
				} satisfies ai_chat_AiSdk5UiMessage);

			// Persisted AI messages are append-only today; editing creates a new branch message.
			// If persisted rows become stream-updated later, replace this id-only cache with a versioned key.
			if (!cachedUiMessage) {
				persistedUiMessageById.set(message._id, uiMessage);
			}

			result.mapById.set(message._id, uiMessage);

			const parentIdOrRoot = message.parentId ?? null;
			if (result.childrenByParentId.has(parentIdOrRoot)) {
				result.childrenByParentId.get(parentIdOrRoot)?.push(uiMessage);
			} else {
				result.childrenByParentId.set(parentIdOrRoot, [uiMessage]);
			}

			if (message.clientGeneratedMessageId) {
				result.clientGeneratedIds.add(message.clientGeneratedMessageId);
				result.mapByClientGeneratedId.set(message.clientGeneratedMessageId, uiMessage);
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

	const persistedSelectedModeId = ((/* iife */) => {
		if (!persistedMessagesLookup) {
			return undefined;
		}

		for (const message of persistedMessagesLookup.list) {
			if (message.role !== "user") {
				continue;
			}

			const selectedModeId = get_message_selected_mode_id(message);
			if (selectedModeId) {
				return selectedModeId;
			}
		}

		return undefined;
	})();

	const selectedModelId = selectedThreadId
		? (session?.selectedModelId ?? persistedSelectedModelId ?? ai_chat_DEFAULT_MODEL_ID)
		: draftSelectedModelId;

	const selectedModeId = selectedThreadId
		? (session?.selectedModeId ?? persistedSelectedModeId ?? ai_chat_DEFAULT_MODE_ID)
		: draftSelectedModeId;

	useEffect(() => {
		if (!selectedThreadId || !session || session.selectedModelId !== undefined) {
			return;
		}

		useStore.actions.setSession(selectedThreadId, (prev) => {
			if (!prev || prev.selectedModelId !== undefined) {
				return;
			}

			return {
				...prev,
				selectedModelId: persistedSelectedModelId ?? ai_chat_DEFAULT_MODEL_ID,
			};
		});
	}, [persistedSelectedModelId, selectedThreadId, session]);

	useEffect(() => {
		if (!selectedThreadId || !session || session.selectedModeId !== undefined) {
			return;
		}

		useStore.actions.setSession(selectedThreadId, (prev) => {
			if (!prev || prev.selectedModeId !== undefined) {
				return;
			}

			return {
				...prev,
				selectedModeId: persistedSelectedModeId ?? ai_chat_DEFAULT_MODE_ID,
			};
		});
	}, [persistedSelectedModeId, selectedThreadId, session]);

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

			const modelForRequest = ai_chat_is_model_id(selectedModelId) ? selectedModelId : ai_chat_DEFAULT_MODEL_ID;

			const modeForRequest = ai_chat_is_mode_id(selectedModeId) ? selectedModeId : ai_chat_DEFAULT_MODE_ID;

			const requestBody = {
				...options.body,
				model: modelForRequest,
				mode: modeForRequest,
				threadId: metadata.isOptimistic ? undefined : options.id,
				clientGeneratedThreadId: metadata.isOptimistic ? options.id : undefined,

				messages: messagesToAppend,
				trigger: options.trigger,
				parentId,
				membershipId,
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

		const session = useStore.actions.getSession(options.chatId);
		const threadId =
			session?.optimisticThread && options.chatId === session.optimisticThread._id
				? null
				: (options.chatId as app_convex_Id<"ai_chat_threads">);

		if (!threadId) {
			return;
		}

		addThreadMessages({
			membershipId,
			threadId,
			parentId: options.message.metadata?.convexParentId ?? null,
			messages: [
				{
					clientGeneratedMessageId: options.message.id,
					content: strip_provider_metadata_from_message_parts(options.message),
				},
			],
		})
			.then((result) => {
				if (result._nay) {
					console.error(
						"[AiChatController.useThreadRuntime.handleChatFinish] Failed to persist aborted assistant message",
						{
							result,
							threadId,
							messageId: options.message.id,
						},
					);
				}
			})
			.catch((error) => {
				console.error(
					"[AiChatController.useThreadRuntime.handleChatFinish] Failed to persist aborted assistant message",
					{
						error,
						threadId,
						messageId: options.message.id,
					},
				);
			});
	});

	// Keep this as a direct expression: React Compiler memoizes the Chat instance for stable deps,
	// and `useChat` recreates its subscription when the Chat object identity changes.
	const unselectedChatInstance = create_chat_instance({
		chatId: null,
		prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
		onFinish: (options) => handleChatFinish.current(options),
	});
	const selectedChatInstance =
		selectedThreadId && !session?.chat
			? create_chat_instance({
					chatId: selectedThreadId,
					prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
					onFinish: (options) => handleChatFinish.current(options),
				})
			: null;

	const activeChatInstance = selectedThreadId
		? (session?.chat ?? selectedChatInstance ?? unselectedChatInstance)
		: unselectedChatInstance;

	const chat = useChat<ai_chat_AiSdk5UiMessage>({ chat: activeChatInstance });
	const chatRef = useLiveRef(chat);
	const activeChatInstanceIdRef = useLiveRef(activeChatInstance.id);

	useEffect(() => {
		if (!selectedThreadId || !selectedChatInstance) {
			return;
		}

		useStore.actions.setSession(selectedThreadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.chat) {
				return base;
			}

			return { ...base, chat: selectedChatInstance };
		});
	}, [selectedChatInstance, selectedThreadId]);

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

	const messageChildIdsByParentId = ((/* iife */) => {
		const result = new Map<string | null, string[]>();

		if (persistedMessagesLookup) {
			for (const [parentId, children] of persistedMessagesLookup.childrenByParentId.entries()) {
				result.set(
					parentId,
					children.toReversed().map((child) => child.id),
				);
			}
		}

		for (const [parentId, children] of pendingMessagesLookup.childrenByParentId.entries()) {
			result.set(parentId, [...(result.get(parentId) ?? []), ...children.toReversed().map((child) => child.id)]);
		}

		return result;
	})();

	const startNewChat = (message?: string) => {
		const nextSelectedModelId = selectedModelId;
		const nextSelectedModeId = selectedModeId;
		const threadId = generate_id("ai_thread");
		const optimisticThread = create_optimistic_thread({ workspaceId, projectId, threadId });
		const optimisticChat = create_chat_instance({
			chatId: threadId,
			prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			onFinish: (options) => handleChatFinish.current(options),
		});
		useStore.actions.setSession(threadId, () => {
			return thread_session_create({
				optimisticThread: optimisticThread,
				chat: optimisticChat,
				selectedModelId: nextSelectedModelId,
				selectedModeId: nextSelectedModeId,
			});
		});
		useStore.setState(() => ({
			draftSelectedModelId: nextSelectedModelId,
			draftSelectedModeId: nextSelectedModeId,
		}));
		setSelectedThreadId(threadId, { persist: false });

		if (message?.trim()) {
			optimisticChat.sendMessage(
				{
					role: "user",
					parts: [{ type: "text", text: message }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
						selectedModelId: nextSelectedModelId,
						selectedModeId: nextSelectedModeId,
					} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
				},
				{
					metadata: {
						isOptimistic: true,
					} satisfies ChatRequestMetadata,
				},
			);
		}

		return threadId;
	};

	const branchChat = (threadId: string, messageId?: string) => {
		branchThread({ membershipId, threadId, ...(messageId ? { messageId } : {}) })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadRuntime.branchChat] Branch failed", {
						result,
						threadId,
						messageId,
					});
					return;
				}

				selectThread(result._yay.threadId);
			})
			.catch((error) => {
				console.error("[AiChatController.useThreadRuntime.branchChat] Error branching chat", {
					error,
					threadId,
					messageId,
				});
			});
	};

	const selectThread = (threadId: string) => {
		let session = useStore.actions.getSession(threadId);
		if (!session) {
			session = useStore.actions.setSession(threadId, () => {
				return thread_session_create();
			});
		}

		if (!session?.chat) {
			const threadChat = create_chat_instance({
				chatId: threadId,
				prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
				onFinish: (options) => handleChatFinish.current(options),
			});
			useStore.actions.setSession(threadId, (prev) => {
				const base = prev ?? thread_session_create();
				return { ...base, ...prev, chat: threadChat };
			});
		}

		setSelectedThreadId(threadId, { persist: !session?.optimisticThread });
	};

	const selectBranchAnchor = (threadId: string, anchorId: string | null) => {
		useStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[AiChatController.useThreadRuntime.selectBranchAnchor] Missing session", {
					threadId,
					anchorId,
				});
				return;
			}

			return { ...prev, anchorId };
		});
	};

	const setThreadStarred = (threadId: string, starred: boolean) => {
		void updateThread({ threadId, membershipId, starred })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadRuntime.setThreadStarred] Failed to update thread star", {
						result,
						threadId,
						starred,
					});
				}
			})
			.catch((error: unknown) => {
				console.error("[AiChatController.useThreadRuntime.setThreadStarred] Unexpected error updating thread star", {
					error,
					threadId,
					starred,
				});
			});
	};

	const archiveThread = (threadId: string, isArchived: boolean) => {
		const session = useStore.actions.getSession(threadId);

		// Optimistic threads exist only on the client; "archiving" them just removes the optimistic session.
		if (session?.optimisticThread) {
			if (!isArchived) {
				return;
			}
			setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
				persist: false,
			});
			useStore.actions.deleteSession(threadId);
			return;
		}

		void updateThread({ membershipId, threadId, isArchived })
			.then((result) => {
				if (result._nay) {
					console.error("[AiChatController.useThreadRuntime.archiveThread] Failed to update archive status", {
						result,
						threadId,
						isArchived,
					});
					return;
				}

				if (isArchived) {
					setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
						persist: false,
					});
				}
			})
			.catch((error: unknown) => {
				console.error("[AiChatController.useThreadRuntime.archiveThread] Unexpected error updating archive status", {
					error,
					threadId,
					isArchived,
				});
			});
	};

	const removeOptimisticThread = (threadId: string) => {
		const session = useStore.actions.getSession(threadId);
		if (!session?.optimisticThread) {
			return;
		}
		setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
			persist: false,
		});
		useStore.actions.deleteSession(threadId);
	};

	const regenerate = (threadId: string, messageId: string) => {
		const session = useStore.getState().threadById.get(threadId);
		const chat = session?.chat;

		if (!session || !chat) {
			should_never_happen("[AiChatController.useThreadRuntime.regenerate] Missing deps", {
				threadId,
				messageId,
				session,
			});
			return;
		}

		const messageToRegenerate = persistedMessagesLookup?.mapById.get(messageId) ?? null;
		if (!messageToRegenerate) {
			should_never_happen("[AiChatController.useThreadRuntime.regenerate] Missing Convex message", {
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
				console.error("[AiChatController.useThreadRuntime.regenerate] Error regenerating message", {
					error,
					threadId,
					messageId,
				});
			});

		useStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[AiChatController.useThreadRuntime.regenerate] Missing session", {
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

		const session = useStore.actions.getSession(threadId);
		const chat = session?.chat;

		if (!session || !chat) {
			should_never_happen("[AiChatController.useThreadRuntime.sendUserText] Missing deps", {
				threadId,
				value,
			});
			return;
		}

		const threadSelectedModelId = session.selectedModelId ?? selectedModelId;
		const threadSelectedModeId = session.selectedModeId ?? selectedModeId;

		const targetMessage = options?.messageId ? activeBranchMessages?.mapById.get(options.messageId) : null;
		const targetMessageIndex = targetMessage ? activeBranchMessages.list.indexOf(targetMessage) : undefined;
		const latestMessage = activeBranchMessages.list.at(-1);

		const getPersistedMessageId = (message: ai_chat_AiSdk5UiMessage) =>
			message.metadata?.convexId ??
			(persistedMessagesLookup?.mapById.has(message.id) ? message.id : undefined) ??
			persistedMessagesLookup?.mapByClientGeneratedId.get(message.id)?.id;
		const messageHasPersistedId = (message: ai_chat_AiSdk5UiMessage) => Boolean(getPersistedMessageId(message));

		if (session.optimisticThread && latestMessage) {
			// Keep follow-up sends blocked until the live query has replaced the
			// optimistic thread with the persisted Convex thread id.
			console.warn(
				"[AiChatController.useThreadRuntime.sendUserText] Blocked send until optimistic thread is persisted",
				{
					threadId,
					messageId: latestMessage.id,
					role: latestMessage.role,
				},
			);
			return;
		}

		const latestMessageIsFailedOptimisticUser = Boolean(
			!targetMessage &&
				latestMessage?.role === "user" &&
				!latestMessage.metadata?.convexId &&
				useStore.getState().failedSendUserMessageIdByThreadId.get(threadId) === latestMessage.id,
		);

		// Prevent the UI from breaking by hiding unnecessary optimistic messages
		// that can be created as the user stop and adds a new message to the chat
		// 1 or more times
		const shouldDropOptimisticAssistant = Boolean(
			!targetMessage && latestMessage?.role === "assistant" && !messageHasPersistedId(latestMessage),
		);
		let nextChatMessages = activeBranchMessages.list;
		if (targetMessageIndex !== undefined && targetMessageIndex >= 0) {
			nextChatMessages = activeBranchMessages.list.slice(0, targetMessageIndex);
		} else if (shouldDropOptimisticAssistant || latestMessageIsFailedOptimisticUser) {
			nextChatMessages = activeBranchMessages.list.slice(0, -1);
		}

		const parentMessageIds = ((/* iife */) => {
			const blockUntilParentPersists = (message: ai_chat_AiSdk5UiMessage, reason: string) => {
				console.warn(
					"[AiChatController.useThreadRuntime.sendUserText] Blocked send until parent message is persisted",
					{
						threadId,
						reason,
						messageId: message.id,
						role: message.role,
					},
				);
				return null;
			};

			if (targetMessage) {
				if (!messageHasPersistedId(targetMessage)) {
					return blockUntilParentPersists(targetMessage, "target-message-not-persisted");
				}

				return {
					convexParentId: targetMessage.metadata?.convexParentId ?? null,
					parentClientGeneratedId: targetMessage.metadata?.parentClientGeneratedId ?? null,
				};
			}

			// Failed sends are client-only; anchor the replacement/new message to
			// the parent that produced the failed request instead of an id the
			// backend has never seen.
			if (latestMessageIsFailedOptimisticUser) {
				return {
					convexParentId: latestMessage?.metadata?.convexParentId ?? null,
					parentClientGeneratedId: latestMessage?.metadata?.parentClientGeneratedId ?? null,
				};
			}

			const parentMessage = shouldDropOptimisticAssistant ? nextChatMessages.at(-1) : latestMessage;

			if (!parentMessage) {
				return {
					convexParentId: null,
					parentClientGeneratedId: null,
				};
			}

			if (!messageHasPersistedId(parentMessage)) {
				return blockUntilParentPersists(parentMessage, "latest-message-not-persisted");
			}

			const parentId = getPersistedMessageId(parentMessage);
			if (!parentId) {
				return blockUntilParentPersists(parentMessage, "latest-message-not-persisted");
			}

			const parentClientGeneratedId =
				parentId === parentMessage.id ? (parentMessage.metadata?.parentClientGeneratedId ?? null) : parentMessage.id;

			return {
				convexParentId: parentId,
				parentClientGeneratedId,
			};
		})();

		if (!parentMessageIds) {
			return;
		}

		chat.messages = nextChatMessages;

		chat.sendMessage(
			{
				role: "user",
				parts: [{ type: "text", text: value }],
				metadata: {
					convexParentId: parentMessageIds.convexParentId,
					parentClientGeneratedId: parentMessageIds.parentClientGeneratedId,
					selectedModelId: threadSelectedModelId,
					selectedModeId: threadSelectedModeId,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
			},
			{
				metadata: {
					isOptimistic: session.optimisticThread ? true : false,
				} satisfies ChatRequestMetadata,
			},
		);

		useStore.actions.setSession(threadId, (prev) => {
			if (!prev) {
				should_never_happen("[AiChatController.useThreadRuntime.regenerate] Missing session", {
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
		useStore.actions.setSession(threadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.draftComposerText === message) {
				return base;
			}
			return { ...base, draftComposerText: message };
		});
	};

	const setSelectedModelId = (modelId: ai_chat_ModelId) => {
		if (!selectedThreadId) {
			useStore.setState(() => ({ draftSelectedModelId: modelId }));
			return;
		}

		useStore.setState(() => ({ draftSelectedModelId: modelId }));

		useStore.actions.setSession(selectedThreadId, (prev) => {
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

	const setSelectedModeId = (mode: ai_chat_ModeId) => {
		if (!selectedThreadId) {
			useStore.setState(() => ({ draftSelectedModeId: mode }));
			return;
		}

		useStore.setState(() => ({ draftSelectedModeId: mode }));

		useStore.actions.setSession(selectedThreadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.selectedModeId === mode) {
				return base;
			}

			return {
				...base,
				selectedModeId: mode,
			};
		});
	};

	const stop = useFn(() => {
		chatRef.current.stop().catch((error) => {
			console.error("[AiChatController.useThreadRuntime.stop] Failed to stop chat", {
				error,
				chatId: activeChatInstanceIdRef.current,
			});
		});
	});

	const isRunning = chat.status === "submitted" || chat.status === "streaming";

	const canSendUserText = ((/* iife */) => {
		if (!selectedThreadId) {
			return true;
		}

		const latestMessage = activeBranchMessages.list.at(-1);
		if (!latestMessage) {
			return true;
		}

		if (session?.optimisticThread) {
			return false;
		}

		const getPersistedMessageId = (message: ai_chat_AiSdk5UiMessage) =>
			message.metadata?.convexId ??
			(persistedMessagesLookup?.mapById.has(message.id) ? message.id : undefined) ??
			persistedMessagesLookup?.mapByClientGeneratedId.get(message.id)?.id;
		const latestMessageHasPersistedId = Boolean(getPersistedMessageId(latestMessage));
		if (latestMessageHasPersistedId) {
			return true;
		}

		if (latestMessage.role === "assistant") {
			const parentMessage = activeBranchMessages.list.at(-2);
			// A stopped assistant can remain client-only when the stream is aborted before
			// persistence finishes. Let the next send drop it only after the previous
			// parent has refreshed from Convex with a persisted id.
			return Boolean(parentMessage && getPersistedMessageId(parentMessage));
		}

		// Allow retrying a client-only failed user message because its replacement
		// is anchored to the last persisted parent, not to the failed optimistic id.
		return latestMessage.role === "user" && selectedThreadFailedSendUserMessageId === latestMessage.id;
	})();

	const status = ((/* iife */) => {
		if (!selectedThreadId) {
			return "idle" as const;
		}
		if (session?.optimisticThread) {
			return "loaded" as const;
		}
		if (persistedThreadMessages === undefined) {
			return "loading" as const;
		}
		return "loaded" as const;
	})();

	useLayoutEffect(() => {
		// Sync after every committed runtime render: AI SDK chat state can update through mutable Chat internals,
		// so dependency identity is not a reliable signal for every message/topology change.
		useStore.actions.syncThreadRenderState({
			threadId: selectedThreadId,
			status,
			messages: activeBranchMessages.list,
			branchSiblingIdsByParentId: messageChildIdsByParentId,
			isRunning,
			hasError: Boolean(chat.error),
		});
	});

	useEffect(() => {
		cacheClearIntervalConsumerCount += 1;
		if (!cacheClearIntervalId) {
			cacheClearIntervalId = setInterval(() => {
				// Clear process-local derived caches periodically so long-lived tabs don't retain every visited message forever.
				persistedUiMessageById.clear();
			}, DERIVED_CACHE_CLEAR_INTERVAL_MS);
		}

		return () => {
			cacheClearIntervalConsumerCount -= 1;
			if (cacheClearIntervalConsumerCount === 0 && cacheClearIntervalId) {
				clearInterval(cacheClearIntervalId);
				cacheClearIntervalId = undefined;
			}
		};
	}, []);

	return {
		selectedThreadId,
		selectedModelId,
		selectedModeId,
		session,

		status,
		isRunning,
		canSendUserText,
		error: chat.error,
		activeBranchMessages,
		messageChildIdsByParentId,

		startNewChat,
		branchChat,
		selectThread,
		selectBranchAnchor,
		setThreadStarred,
		archiveThread,
		removeOptimisticThread,

		setComposerValue,
		setSelectedModelId,
		setSelectedModeId,
		setEditingMessageId: (threadId: string, messageId: string | null) => {
			useStore.actions.setEditingMessageId(threadId, messageId);
		},
		sendUserText,
		regenerate,
		stop,
		resumeStream: chat.resumeStream,
		addToolOutput: chat.addToolOutput,
		setMessages: chat.setMessages,
		syncRenderState: () => {
			useStore.actions.syncThreadRenderState({
				threadId: selectedThreadId,
				status,
				messages: activeBranchMessages.list,
				branchSiblingIdsByParentId: messageChildIdsByParentId,
				isRunning,
				hasError: Boolean(chat.error),
			});
		},
	};
};

const useThreadRuntime = () => useThreadRuntimeController();
export type AiChatThreadRuntime = ReturnType<typeof useThreadRuntime>;

const AiChatController = Object.assign(ControllerProvider, {
	useStore,
	useThreadList,
	useThreadRuntime,
});

export { AiChatController };
