import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatOnFinishCallback } from "ai";
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
import { objects_equal_deep } from "@/lib/object.ts";
import { app_local_storage_get_value, app_local_storage_set_value, type storage_local_Key } from "@/lib/storage.ts";
import { generate_id, get_id_generator, should_never_happen, type GeneratedIdPrefix } from "@/lib/utils.ts";
import { useFn, useLiveRef } from "./utils-hooks.ts";
import {
	type ai_chat_AiSdk5UiMessage,
	ai_chat_DEFAULT_MODEL_ID,
	ai_chat_DEFAULT_MODE_ID,
	ai_chat_get_message_text,
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

export type AiChatQueuedUserMessage = {
	id: ReturnType<typeof generate_id<"ai_message">>;
	text: string;
	selectedModelId: ai_chat_ModelId;
	selectedModeId: ai_chat_ModeId;
};

type ThreadSession = {
	chat: Chat<ai_chat_AiSdk5UiMessage> | null;
	draftComposerText: string;
	selectedModelId?: ai_chat_ModelId;
	selectedModeId?: ai_chat_ModeId;
	queuedUserMessages: readonly AiChatQueuedUserMessage[];
	queuedUserMessageEdit: AiChatQueuedUserMessage | null;
	isQueueReordering: boolean;
	isQueuePaused: boolean;
	claimedQueuedUserMessageId: AiChatQueuedUserMessage["id"] | null;
	activeRequestToken: symbol | null;
	isArchivePending: boolean;
	/**
	 * Optional branch anchor (Convex message id).
	 *
	 * This should point at the selected assistant-variant root message id.
	 * - `undefined`: default to the latest Convex message in the thread
	 * - `null`: use the root branch
	 */
	anchorId: string | null | undefined;
	streamingTitle?: string;
};

type ThreadChatOnFinish = Parameters<ChatOnFinishCallback<ai_chat_AiSdk5UiMessage>>[0] & {
	chatId: string;
};

type UseChatResult = ReturnType<typeof useChat<ai_chat_AiSdk5UiMessage>>;

export type AiChatOptimisticThreadId = ReturnType<typeof generate_id<"ai_thread">>;

type StoreState = {
	draftSelectedModelId: ai_chat_ModelId;
	draftSelectedModeId: ai_chat_ModeId;
	threadById: Map<string, ThreadSession>;
	messageById: Map<string, ai_chat_AiSdk5UiMessage>;
	activeMessageIdsByThreadId: Map<string, readonly string[]>;
	branchSiblingIdsByMessageId: Map<string, readonly string[]>;
	failedSendUserMessageIdByThreadId: Map<string, string | null>;
	editingMessageIdByThreadId: Map<string, string | null>;
};

const DERIVED_CACHE_CLEAR_INTERVAL_MS = 60 * 60 * 1000;
const QUEUED_USER_MESSAGE_LIMIT = 10;
const EMPTY_QUEUED_USER_MESSAGES: readonly AiChatQueuedUserMessage[] = [];

/**
 * Cache persisted Convex messages by their final message id so query refreshes do not recreate old UIMessage objects.
 * Persisted chat messages are append-only today: editing creates a new branch message, and streaming lives in pending state.
 */
const persistedUiMessageById = new Map<string, ai_chat_AiSdk5UiMessage>();
// `chat.id` changes as soon as the stream returns the persisted thread id. Keep
// Zustand's current thread id separate because the session moves after Convex syncs.
const threadIdByChat = new WeakMap<Chat<ai_chat_AiSdk5UiMessage>, string>();

async function ai_chat_fetch(input: RequestInfo | URL, init?: RequestInit) {
	let response = await fetch(input, init);

	while (response.status === 429) {
		const body: unknown = await response
			.clone()
			.json()
			.catch(() => null);
		const retryAfterMs =
			typeof body === "object" && body !== null && "retryAfterMs" in body
				? body.retryAfterMs
				: null;
		if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
			return response;
		}

		// Keep the same AI SDK request active while the server's chat bucket refills.
		// Stop aborts this wait through the request signal.
		await new Promise<void>((resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}

			const timeoutId = setTimeout(() => {
				signal?.removeEventListener("abort", handleAbort);
				resolve();
			}, retryAfterMs);
			const handleAbort = () => {
				clearTimeout(timeoutId);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", handleAbort, { once: true });
		});

		response = await fetch(input, init);
	}

	return response;
}

/**
 * Share one cache cleanup interval across every mounted chat controller.
 */
let cacheClearIntervalId: ReturnType<typeof setInterval> | undefined;
let cacheClearIntervalConsumerCount = 0;
let storeMembershipId: string | null = null;

/**
 * Normalize identity once so send/retry logic can trust `metadata.convexId`
 * instead of re-resolving client-generated ids at every call site.
 */
function mutate_message_metadata(
	mut_message: ai_chat_AiSdk5UiMessage,
	args: {
		convexId: string;
		convexParentId: string | null;
		parentClientGeneratedId: string | null;
	},
) {
	mut_message.metadata ??= {
		parentClientGeneratedId: args.parentClientGeneratedId,
	} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>;
	mut_message.metadata.convexId = args.convexId;
	mut_message.metadata.convexParentId = args.convexParentId;
	mut_message.metadata.parentClientGeneratedId = args.parentClientGeneratedId;
}

export type AiChatRuntimeActions = {
	addToolOutput: UseChatResult["addToolOutput"];
	resumeStream: UseChatResult["resumeStream"];
	stop: () => void;
	setSelectedModelId: (modelId: ai_chat_ModelId) => void;
	setSelectedModeId: (modeId: ai_chat_ModeId) => void;
	sendUserText: (threadId: string, value: string, options?: { messageId?: string }) => boolean;
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
	initialSelectedThreadId?: string | null;
	children?: ReactNode;
};

const SIDEBAR_SELECTED_TAB_STORAGE_KEY_PREFIX = "app_state::file_editor_sidebar_agent_selected_tab::scope::";
const SIDEBAR_OPEN_TABS_STORAGE_KEY_PREFIX = "app_state::file_editor_sidebar_open_tabs::scope::";

function is_ai_chat_optimistic_thread_id(threadId?: string | null): threadId is AiChatOptimisticThreadId {
	return Boolean(threadId?.startsWith("ai_thread-" satisfies GeneratedIdPrefix));
}

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

function get_initial_selected_thread_id(storageKey: AiChatControllerStorageKey, initialSelectedThreadId?: string | null) {
	if (initialSelectedThreadId !== undefined) {
		return initialSelectedThreadId;
	}

	const selectedThreadId = app_local_storage_get_value(storageKey);
	if (!is_sidebar_selected_tab_storage_key(storageKey)) {
		return selectedThreadId;
	}

	const openTabs = app_local_storage_get_value(get_sidebar_open_tabs_storage_key(storageKey));
	const selectedOpenTab = openTabs.find((tab) => tab.id === selectedThreadId);
	return selectedOpenTab?.id ?? openTabs.at(-1)?.id ?? null;
}

function ControllerProvider(props: AiChatController_Props) {
	const { storageKey, initialSelectedThreadId, children } = props;

	const [selectedThreadId, setSelectedThreadIdState] = useState(() =>
		get_initial_selected_thread_id(storageKey, initialSelectedThreadId),
	);
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

	const value = {
		selectedThreadId,
		setSelectedThreadId,
	} satisfies SelectionContextValue;

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

const EMPTY_MESSAGE_METADATA: Record<string, unknown> = {};

// AI SDK can return fresh UIMessage objects for the same persisted tool result.
// Compare the render-relevant fields so no-op syncs keep the existing message reference.
function ui_messages_have_equal_render_content(
	a: ai_chat_AiSdk5UiMessage,
	b: ai_chat_AiSdk5UiMessage,
) {
	if (a === b) {
		return true;
	}
	if (a.id !== b.id || a.role !== b.role) {
		return false;
	}

	return (
		objects_equal_deep(a.parts, b.parts) &&
		objects_equal_deep(a.metadata ?? EMPTY_MESSAGE_METADATA, b.metadata ?? EMPTY_MESSAGE_METADATA)
	);
}

function create_optimistic_thread(tenant: {
	organizationId: string;
	workspaceId: string;
	threadId: AiChatOptimisticThreadId;
}): ai_chat_Thread {
	const now = Date.now();
	return {
		_id: tenant.threadId as app_convex_Id<"ai_chat_threads">,
		_creationTime: now,
		organizationId: tenant.organizationId,
		workspaceId: tenant.workspaceId,
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

const optimisticThreadListItemByKey = new Map<string, ai_chat_Thread>();
function get_optimistic_thread_list_item(tenant: {
	organizationId: string;
	workspaceId: string;
	threadId: AiChatOptimisticThreadId;
}) {
	const key = `${tenant.organizationId}:${tenant.workspaceId}:${tenant.threadId}`;
	let optimisticThread = optimisticThreadListItemByKey.get(key);
	if (!optimisticThread) {
		// Build fake list items once per client id so restored blank tabs do not flicker on every render.
		optimisticThread = create_optimistic_thread(tenant);
		optimisticThreadListItemByKey.set(key, optimisticThread);
	}
	return optimisticThread;
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
		queuedUserMessages: [],
		queuedUserMessageEdit: null,
		isQueueReordering: false,
		isQueuePaused: false,
		claimedQueuedUserMessageId: null,
		activeRequestToken: null,
		isArchivePending: false,
		anchorId: undefined,
		streamingTitle: undefined,
	} satisfies ThreadSession;
};

function create_chat_instance(args: ThreadChatArgs) {
	const chat = new Chat<ai_chat_AiSdk5UiMessage>({
		id: args.chatId ?? generate_id("ai_thread"),
		generateId: get_id_generator("ai_message"),
		...(args.initialMessages ? { messages: args.initialMessages } : {}),
		transport: new DefaultChatTransport({
			api: app_fetch_main_api_url("/api/chat"),
			fetch: ai_chat_fetch,
			prepareSendMessagesRequest: args.prepareSendMessagesRequest,
		}),
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
		failedSendUserMessageIdByThreadId: new Map(),
		editingMessageIdByThreadId: new Map(),
	}));

	return Object.assign(store, {
		actions: {
			getSession(threadId: string) {
				return store.getState().threadById.get(threadId) ?? null;
			},
			setSession<T extends ThreadSession | void>(threadId: string, session: (prev: ThreadSession | null) => T) {
				const prev = store.getState().threadById.get(threadId) ?? null;
				const next = session(prev);

				if (next === undefined) {
					return next;
				}

				if (prev?.chat && prev.chat !== next.chat && threadIdByChat.get(prev.chat) === threadId) {
					threadIdByChat.delete(prev.chat);
				}
				if (next.chat) {
					threadIdByChat.set(next.chat, threadId);
				}
				store.setState((state) => {
					return { threadById: new Map(state.threadById.set(threadId, next)) };
				});

				return next;
			},
			deleteSession(threadId: string) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session) {
						return state;
					}

					if (session.chat && threadIdByChat.get(session.chat) === threadId) {
						threadIdByChat.delete(session.chat);
					}
					const threadById = new Map(state.threadById);
					threadById.delete(threadId);
					return { threadById };
				});
			},
			enqueueQueuedUserMessage(threadId: string, message: AiChatQueuedUserMessage) {
				let didEnqueue = false;
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.queuedUserMessages.length >= QUEUED_USER_MESSAGE_LIMIT) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages: [...session.queuedUserMessages, message],
					});
					didEnqueue = true;
					return { threadById };
				});

				return didEnqueue;
			},
			startQueuedUserMessageEdit(threadId: string, messageId: AiChatQueuedUserMessage["id"]) {
				let didStart = false;
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					const message = session?.queuedUserMessages.find((queuedMessage) => queuedMessage.id === messageId);
					if (!session || !message) {
						return state;
					}

					didStart = true;
					if (session.queuedUserMessageEdit?.id === messageId) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessageEdit: { ...message },
					});
					return { threadById };
				});

				return didStart;
			},
			updateQueuedUserMessageEdit(threadId: string, message: AiChatQueuedUserMessage) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					const edit = session?.queuedUserMessageEdit;
					if (
						!session ||
						!edit ||
						edit.id !== message.id ||
						(edit.text === message.text &&
							edit.selectedModelId === message.selectedModelId &&
							edit.selectedModeId === message.selectedModeId)
					) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessageEdit: message,
					});
					return { threadById };
				});
			},
			saveQueuedUserMessageEdit(
				threadId: string,
				messageId: AiChatQueuedUserMessage["id"],
				text: string,
			) {
				let didSave = false;
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					const edit = session?.queuedUserMessageEdit;
					const messageIndex = session?.queuedUserMessages.findIndex((message) => message.id === messageId) ?? -1;
					if (!session || !edit || edit.id !== messageId || messageIndex < 0 || !text.trim()) {
						return state;
					}

					const queuedUserMessages = [...session.queuedUserMessages];
					queuedUserMessages[messageIndex] = { ...edit, text };

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages,
						queuedUserMessageEdit: null,
					});
					didSave = true;
					return { threadById };
				});

				return didSave;
			},
			cancelQueuedUserMessageEdit(threadId: string, messageId: AiChatQueuedUserMessage["id"]) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.queuedUserMessageEdit?.id !== messageId) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessageEdit: null,
					});
					return { threadById };
				});
			},
			setQueuedUserMessagesReordering(threadId: string, isQueueReordering: boolean) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.isQueueReordering === isQueueReordering) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						isQueueReordering,
					});
					return { threadById };
				});
			},
			reorderQueuedUserMessages(
				threadId: string,
				orderedMessageIds: readonly AiChatQueuedUserMessage["id"][],
			) {
				let didReorder = false;
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.queuedUserMessages.length < 2) {
						return state;
					}

					const messageById = new Map(session.queuedUserMessages.map((message) => [message.id, message]));
					const queuedUserMessages: AiChatQueuedUserMessage[] = [];
					// A claim or another mounted chat can change the queue during a drag.
					// Keep the submitted id order, then append messages that appeared meanwhile.
					for (const messageId of orderedMessageIds) {
						const message = messageById.get(messageId);
						if (!message) {
							continue;
						}
						queuedUserMessages.push(message);
						messageById.delete(messageId);
					}
					queuedUserMessages.push(...messageById.values());

					if (queuedUserMessages.every((message, index) => message === session.queuedUserMessages[index])) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages,
					});
					didReorder = true;
					return { threadById };
				});

				return didReorder;
			},
			removeQueuedUserMessage(threadId: string, messageId: AiChatQueuedUserMessage["id"]) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || !session.queuedUserMessages.some((message) => message.id === messageId)) {
						return state;
					}

					const queuedUserMessages = session.queuedUserMessages.filter((message) => message.id !== messageId);
					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages,
						queuedUserMessageEdit:
							session.queuedUserMessageEdit?.id === messageId ? null : session.queuedUserMessageEdit,
						isQueueReordering: queuedUserMessages.length > 1 && session.isQueueReordering,
						isQueuePaused: queuedUserMessages.length > 0 && session.isQueuePaused,
					});
					return { threadById };
				});
			},
			clearQueuedUserMessages(threadId: string) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || (session.queuedUserMessages.length === 0 && !session.isQueuePaused)) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages: [],
						queuedUserMessageEdit: null,
						isQueueReordering: false,
						isQueuePaused: false,
					});
					return { threadById };
				});
			},
			pauseQueuedUserMessages(threadId: string) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.isQueuePaused) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						isQueuePaused: true,
					});
					return { threadById };
				});
			},
			resumeQueuedUserMessages(threadId: string) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session?.isQueuePaused) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						isQueuePaused: false,
					});
					return { threadById };
				});
			},
			claimNextQueuedUserMessage(threadId: string): AiChatQueuedUserMessage | null {
				let claimedMessage: AiChatQueuedUserMessage | null = null;
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					const nextMessage = session?.queuedUserMessages[0];
					// Let earlier messages keep draining, but never start the item being edited.
					if (
						!session ||
						session.isQueuePaused ||
						session.activeRequestToken ||
						session.claimedQueuedUserMessageId ||
						!nextMessage ||
						session.queuedUserMessageEdit?.id === nextMessage.id ||
						session.isQueueReordering
					) {
						return state;
					}

					claimedMessage = nextMessage;

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages: session.queuedUserMessages.slice(1),
						claimedQueuedUserMessageId: claimedMessage.id,
					});
					return { threadById };
				});

				return claimedMessage;
			},
			restoreClaimedQueuedUserMessage(threadId: string, message: AiChatQueuedUserMessage) {
				store.setState((state) => {
					const session = state.threadById.get(threadId);
					if (!session || session.claimedQueuedUserMessageId !== message.id) {
						return state;
					}

					const threadById = new Map(state.threadById);
					threadById.set(threadId, {
						...session,
						queuedUserMessages: [message, ...session.queuedUserMessages],
						claimedQueuedUserMessageId: null,
					});
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
					failedSendUserMessageIdByThreadId: new Map(),
					editingMessageIdByThreadId: new Map(),
				});
			},
			syncThreadRenderState(args: {
				threadId: string | null;
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
						const storedMessage = messageById.get(message.id);
						// Equal cloned messages should not churn the message map or remount message UI.
						if (storedMessage && ui_messages_have_equal_render_content(storedMessage, message)) {
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

					// The backend can persist the user before its assistant stream fails.
					// Keep the failed turn tied to that user even after Convex assigns its id.
					const failedSendUserMessage =
						args.hasError && !args.isRunning
							? args.messages.findLast((message) => message.role === "user")
							: undefined;
					const failedSendUserMessageId = failedSendUserMessage?.id ?? null;
					let failedSendUserMessageIdByThreadId = state.failedSendUserMessageIdByThreadId;
					if ((failedSendUserMessageIdByThreadId.get(threadId) ?? null) !== failedSendUserMessageId) {
						failedSendUserMessageIdByThreadId = new Map(failedSendUserMessageIdByThreadId);
						failedSendUserMessageIdByThreadId.set(threadId, failedSendUserMessageId);
						changed = true;
					}

					if (!changed) {
						return state;
					}

					return {
						messageById,
						activeMessageIdsByThreadId,
						branchSiblingIdsByMessageId,
						failedSendUserMessageIdByThreadId,
					};
				});
			},
		},
	});
})();

/**
 * Track the exact AI SDK request until it settles.
 *
 * AI SDK clears its internal active response after `onFinish`, so the next
 * queued message must wait for this separate request token.
 */
function track_chat_request(
	chat: Chat<ai_chat_AiSdk5UiMessage>,
	request: Promise<void>,
	claimedQueuedUserMessageId: AiChatQueuedUserMessage["id"] | null = null,
) {
	const requestToken = Symbol();
	const threadId = threadIdByChat.get(chat);
	if (!threadId) {
		should_never_happen("[AiChatController.track_chat_request] Missing thread id", {
			chatId: chat.id,
		});
		return;
	}

	useStore.actions.setSession(threadId, (prev) => {
		if (!prev || prev.chat !== chat) {
			return;
		}

		return {
			...prev,
			activeRequestToken: requestToken,
			claimedQueuedUserMessageId,
		};
	});

	const settle = (didFail: boolean) => {
		const currentThreadId = threadIdByChat.get(chat);
		if (!currentThreadId) {
			return;
		}

		useStore.actions.setSession(currentThreadId, (prev) => {
			if (!prev || prev.chat !== chat || prev.activeRequestToken !== requestToken) {
				return;
			}

			return {
				...prev,
				activeRequestToken: null,
				claimedQueuedUserMessageId: null,
				// Keep later messages queued when the visible active turn fails.
				isQueuePaused: prev.queuedUserMessages.length > 0 && (prev.isQueuePaused || didFail),
			};
		});
	};

	void request.then(
		() => settle(Boolean(chat.error)),
		() => settle(true),
	);
}

function stop_thread_session(threadId: string) {
	const session = useStore.actions.getSession(threadId);
	useStore.actions.clearQueuedUserMessages(threadId);
	session?.chat?.stop().catch((error: unknown) => {
		console.error("[AiChatController.stop_thread_session] Failed to stop chat", {
			error,
			threadId,
		});
	});
}

function stop_and_delete_thread_session(threadId: string) {
	stop_thread_session(threadId);
	useStore.actions.deleteSession(threadId);
}

function set_thread_archive_pending(threadId: string, isArchivePending: boolean) {
	useStore.actions.setSession(threadId, (session) => {
		if (!session || session.isArchivePending === isArchivePending) {
			return;
		}
		return { ...session, isArchivePending };
	});
}

type useThreadList_Props = {
	includeArchived?: boolean;
};

const useThreadList = (props?: useThreadList_Props) => {
	const includeArchived = props?.includeArchived ?? true;

	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const { selectedThreadId, setSelectedThreadId } = useControllerSelection();

	const draftSelectedModelId = useStore((state) => state.draftSelectedModelId);
	const draftSelectedModeId = useStore((state) => state.draftSelectedModeId);
	const threadById = useStore((state) => state.threadById);
	const session = useStore((state) => (selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null));

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
	const persistedThreadIdByClientGeneratedId = useMemo<ReadonlyMap<string, string>>(() => {
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

		for (const threadId of threadById.keys()) {
			if (!is_ai_chat_optimistic_thread_id(threadId) || persistedThreadIdByClientGeneratedId.has(threadId)) {
				continue;
			}

			result.push(get_optimistic_thread_list_item({ organizationId, workspaceId, threadId }));
		}

		return result;
	}, [workspaceId, threadById, persistedThreadIdByClientGeneratedId, organizationId]);

	const persistedSelectedThreadId = selectedThreadId
		? persistedThreadIdByClientGeneratedId.get(selectedThreadId)
		: undefined;

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

			const lastMessage = options.messages.at(-1);
			const messagesToAppend =
				options.trigger === "submit-message" && lastMessage?.role === "user" ? [lastMessage] : [];
			const parentId =
				options.trigger === "regenerate-message"
					? options.messages.at(-1)?.id
					: (messagesToAppend.at(-1)?.metadata?.convexParentId ?? null);
			const isOptimisticThread = is_ai_chat_optimistic_thread_id(options.id);
			const storeState = useStore.getState();
			const requestSession = storeState.threadById.get(options.id);
			const requestSelectedModelId = requestSession?.selectedModelId;
			const requestSelectedModeId = requestSession?.selectedModeId;
			const requestUserMessage = messagesToAppend.at(-1);
			const messageSelectedModelId = get_message_selected_model_id(requestUserMessage);
			const messageSelectedModeId = get_message_selected_mode_id(requestUserMessage);
			const modelForRequest =
				messageSelectedModelId ??
				(requestSelectedModelId && ai_chat_is_model_id(requestSelectedModelId)
					? requestSelectedModelId
					: storeState.draftSelectedModelId);
			const modeForRequest =
				messageSelectedModeId ??
				(requestSelectedModeId && ai_chat_is_mode_id(requestSelectedModeId)
					? requestSelectedModeId
					: storeState.draftSelectedModeId);

			const requestBody = {
				...options.body,
				model: modelForRequest,
				mode: modeForRequest,
				threadId: isOptimisticThread ? undefined : options.id,
				clientGeneratedThreadId: isOptimisticThread ? options.id : undefined,
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

		const threadId = is_ai_chat_optimistic_thread_id(options.chatId)
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

	const startNewChat = useFn((message?: string) => {
		const nextSelectedModelId = selectedModelId;
		const nextSelectedModeId = selectedModeId;
		const threadId = generate_id("ai_thread");
		const optimisticChat = createThreadChat(threadId);
		useStore.actions.setSession(threadId, () => {
			return thread_session_create({
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
			const request = optimisticChat.sendMessage({
				role: "user",
				parts: [{ type: "text", text: message }],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
					selectedModelId: nextSelectedModelId,
					selectedModeId: nextSelectedModeId,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
			});
			track_chat_request(optimisticChat, request);
		}

		return threadId;
	});

	const selectThread = useFn((threadId: string) => {
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

		setSelectedThreadId(threadId, { persist: !is_ai_chat_optimistic_thread_id(threadId) });
	});

	const branchChat = useFn((threadId: string, messageId?: string) => {
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
	});

	const clearSelectedThread = useFn(() => {
		setSelectedThreadId(null, { persist: false });
	});

	const setThreadStarred = useFn((threadId: string, starred: boolean) => {
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
	});

	const archiveThread = useFn((threadId: string, isArchived: boolean) => {
		if (is_ai_chat_optimistic_thread_id(threadId)) {
			if (!isArchived) {
				return;
			}
			setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
				persist: false,
			});
			stop_and_delete_thread_session(threadId);
			return;
		}

		if (isArchived) {
			// Block sends and queue draining until the mutation succeeds. If it
			// fails, keep the active request and queued messages so the user can continue.
			set_thread_archive_pending(threadId, true);
		}
		void updateThread({ membershipId, threadId, isArchived })
			.then((result) => {
				if (result._nay) {
					set_thread_archive_pending(threadId, false);
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
					stop_and_delete_thread_session(threadId);
				}
			})
			.catch((error: unknown) => {
				set_thread_archive_pending(threadId, false);
				console.error("[AiChatController.useThreadList.archiveThread] Unexpected error updating archive status", {
					error,
					threadId,
					isArchived,
				});
			});
	});

	const removeOptimisticThread = useFn((threadId: string) => {
		if (!is_ai_chat_optimistic_thread_id(threadId)) {
			return;
		}
		setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
			persist: false,
		});
		stop_and_delete_thread_session(threadId);
	});

	useEffect(() => {
		if (!is_ai_chat_optimistic_thread_id(selectedThreadId)) {
			return;
		}

		selectThread(selectedThreadId);
	}, [selectThread, selectedThreadId]);

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
		if (storeMembershipId === membershipId) {
			return;
		}

		for (const threadId of useStore.getState().threadById.keys()) {
			stop_and_delete_thread_session(threadId);
		}
		storeMembershipId = membershipId;
		useStore.setState({ threadById: new Map() });
		persistedUiMessageById.clear();
		optimisticThreadListItemByKey.clear();
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
		for (const [optimisticThreadId] of threadById.entries()) {
			if (!is_ai_chat_optimistic_thread_id(optimisticThreadId)) continue;

			const threadId = persistedThreadIdByClientGeneratedId.get(optimisticThreadId);
			if (threadId) {
				// Another mounted chat surface may have moved this session after this
				// effect rendered. Read it again so the queued messages move only once.
				const session = useStore.actions.getSession(optimisticThreadId);
				if (!session) {
					continue;
				}

				if (session.chat) {
					// @ts-expect-error: Overwrite the readonly chat id to the persisted thread id.
					session.chat.id = threadId;
				}

				useStore.actions.setSession(threadId, (persistedSession) => {
					if (!persistedSession) {
						return session.chat ? { ...session } : undefined;
					}

					// Keep the optimistic Chat and request state. They own the live
					// stream that caused this thread id upgrade.
					return {
						...persistedSession,
						chat: session.chat ?? persistedSession.chat,
						draftComposerText: session.draftComposerText,
						selectedModelId: session.selectedModelId ?? persistedSession.selectedModelId,
						selectedModeId: session.selectedModeId ?? persistedSession.selectedModeId,
						queuedUserMessages: [...session.queuedUserMessages, ...persistedSession.queuedUserMessages],
						queuedUserMessageEdit:
							session.queuedUserMessageEdit ?? persistedSession.queuedUserMessageEdit,
						isQueueReordering: session.isQueueReordering || persistedSession.isQueueReordering,
						isQueuePaused: session.isQueuePaused || persistedSession.isQueuePaused,
						claimedQueuedUserMessageId:
							session.claimedQueuedUserMessageId ?? persistedSession.claimedQueuedUserMessageId,
						activeRequestToken: session.activeRequestToken ?? persistedSession.activeRequestToken,
						isArchivePending: session.isArchivePending || persistedSession.isArchivePending,
						anchorId: session.anchorId,
						streamingTitle: session.streamingTitle ?? persistedSession.streamingTitle,
					};
				});
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
	}, [setSelectedThreadId, threadById, persistedThreadIdByClientGeneratedId]);

	return {
		selectedThreadId,
		selectedModelId,
		selectedModeId,
		session,
		currentThreadsWithOptimistic,
		persistedThreadIdByClientGeneratedId,
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
	const { membershipId } = AppTenantProvider.useContext();
	const { selectedThreadId, setSelectedThreadId } = useControllerSelection();
	const selectedThreadIsOptimistic = is_ai_chat_optimistic_thread_id(selectedThreadId);

	const draftSelectedModelId = useStore((state) => state.draftSelectedModelId);
	const draftSelectedModeId = useStore((state) => state.draftSelectedModeId);

	const session = useStore((state) => (selectedThreadId ? (state.threadById.get(selectedThreadId) ?? null) : null));
	const selectedThreadFailedSendUserMessageId = useStore((state) =>
		selectedThreadId ? (state.failedSendUserMessageIdByThreadId.get(selectedThreadId) ?? null) : null,
	);

	const updateThread = useMutation(app_convex_api.ai_chat.thread_update);
	const branchThread = useMutation(app_convex_api.ai_chat.thread_branch);
	const addThreadMessages = useMutation(app_convex_api.ai_chat.thread_messages_add);

	const persistedThreadMessages = useQuery(
		app_convex_api.ai_chat.thread_messages_list,
		selectedThreadId && !selectedThreadIsOptimistic
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
			list: [] as ai_chat_AiSdk5UiMessage[],
		};

		for (const message of persistedThreadMessages.messages) {
			// Convert DB message to AI SDK UI message
			const dbMessageContent = message.content as ai_chat_AiSdk5UiMessage;
			const metadata = {
				convexId: message._id,
				convexParentId: message.parentId ?? null,
				parentClientGeneratedId: dbMessageContent.metadata?.parentClientGeneratedId ?? null,
			};
			const cachedUiMessage = persistedUiMessageById.get(message._id);
			const uiMessage =
				cachedUiMessage ??
				({
					id: message._id,
					role: dbMessageContent.role,
					parts: dbMessageContent.parts,
					metadata: {
						...(dbMessageContent.metadata ?? {}),
						...metadata,
					} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
				} satisfies ai_chat_AiSdk5UiMessage);
			mutate_message_metadata(uiMessage, metadata);

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

			// Only submit requests append the optimistic user message. Regenerate and
			// edit requests are anchored to existing persisted messages instead.
			const lastMessage = options.messages.at(-1);
			const messagesToAppend =
				options.trigger === "submit-message" && lastMessage?.role === "user" ? [lastMessage] : [];

			// Keep submit-message requests anchored to the persisted parent chosen during `sendUserText`.
			// After `stop`, `options.messages.at(-2)?.id` can still be the optimistic assistant id,
			// which creates a bogus sibling branch or a reconstruction failure.
			const parentId =
				options.trigger === "regenerate-message"
					? options.messages.at(-1)?.id
					: (messagesToAppend.at(-1)?.metadata?.convexParentId ?? null);

			const isOptimisticThread = is_ai_chat_optimistic_thread_id(options.id);

			const requestUserMessage = messagesToAppend.at(-1);
			const messageSelectedModelId = get_message_selected_model_id(requestUserMessage);
			const messageSelectedModeId = get_message_selected_mode_id(requestUserMessage);
			const modelForRequest =
				messageSelectedModelId ?? (ai_chat_is_model_id(selectedModelId) ? selectedModelId : ai_chat_DEFAULT_MODEL_ID);
			const modeForRequest =
				messageSelectedModeId ?? (ai_chat_is_mode_id(selectedModeId) ? selectedModeId : ai_chat_DEFAULT_MODE_ID);

			const requestBody = {
				...options.body,
				model: modelForRequest,
				mode: modeForRequest,
				threadId: isOptimisticThread ? undefined : options.id,
				clientGeneratedThreadId: isOptimisticThread ? options.id : undefined,

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

		const threadId = is_ai_chat_optimistic_thread_id(options.chatId)
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
			const persistedMessage =
				persistedMessagesLookup?.mapById.get(message.id) ??
				persistedMessagesLookup?.mapByClientGeneratedId.get(message.id);

			if (persistedMessage?.metadata?.convexId) {
				mutate_message_metadata(message, {
					convexId: persistedMessage.metadata.convexId,
					convexParentId: persistedMessage.metadata.convexParentId ?? null,
					parentClientGeneratedId: persistedMessage.metadata.parentClientGeneratedId ?? null,
				});
				continue;
			}

			result.list.push(message);

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

	const startNewChat = useFn((message?: string) => {
		const nextSelectedModelId = selectedModelId;
		const nextSelectedModeId = selectedModeId;
		const threadId = generate_id("ai_thread");
		const optimisticChat = create_chat_instance({
			chatId: threadId,
			prepareSendMessagesRequest: (options) => prepareSendMessagesRequest.current(options),
			onFinish: (options) => handleChatFinish.current(options),
		});
		useStore.actions.setSession(threadId, () => {
			return thread_session_create({
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
			const request = optimisticChat.sendMessage({
				role: "user",
				parts: [{ type: "text", text: message }],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
					selectedModelId: nextSelectedModelId,
					selectedModeId: nextSelectedModeId,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
			});
			track_chat_request(optimisticChat, request);
		}

		return threadId;
	});

	const selectThread = useFn((threadId: string) => {
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

		setSelectedThreadId(threadId, { persist: !is_ai_chat_optimistic_thread_id(threadId) });
	});

	const branchChat = useFn((threadId: string, messageId?: string) => {
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
	});

	const selectBranchAnchor = useFn((threadId: string, anchorId: string | null) => {
		// Queued messages belong to the branch that was active when they were added.
		// Clear them before changing that branch.
		useStore.actions.clearQueuedUserMessages(threadId);
		useStore.actions.setSession(threadId, (prev) => {
			const base = prev ?? thread_session_create();

			return { ...base, anchorId };
		});
	});

	const setThreadStarred = useFn((threadId: string, starred: boolean) => {
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
	});

	const archiveThread = useFn((threadId: string, isArchived: boolean) => {
		// Optimistic threads exist only on the client; "archiving" them just removes the optimistic session.
		if (is_ai_chat_optimistic_thread_id(threadId)) {
			if (!isArchived) {
				return;
			}
			setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
				persist: false,
			});
			stop_and_delete_thread_session(threadId);
			return;
		}

		if (isArchived) {
			// Block sends and queue draining until the mutation succeeds. If it
			// fails, keep the active request and queued messages so the user can continue.
			set_thread_archive_pending(threadId, true);
		}
		void updateThread({ membershipId, threadId, isArchived })
			.then((result) => {
				if (result._nay) {
					set_thread_archive_pending(threadId, false);
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
					stop_and_delete_thread_session(threadId);
				}
			})
			.catch((error: unknown) => {
				set_thread_archive_pending(threadId, false);
				console.error("[AiChatController.useThreadRuntime.archiveThread] Unexpected error updating archive status", {
					error,
					threadId,
					isArchived,
				});
			});
	});

	const removeOptimisticThread = useFn((threadId: string) => {
		if (!is_ai_chat_optimistic_thread_id(threadId)) {
			return;
		}
		setSelectedThreadId((currentThreadId) => (currentThreadId === threadId ? null : currentThreadId), {
			persist: false,
		});
		stop_and_delete_thread_session(threadId);
	});

	const regenerate = useFn((threadId: string, messageId: string) => {
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
		useStore.actions.clearQueuedUserMessages(threadId);
		chat.messages = activeBranchMessages.list;
		const request = chat.regenerate({
			messageId,
		});
		track_chat_request(chat, request);
		request.catch((error: unknown) => {
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
	});

	const setComposerValue = useFn((chat: Chat<ai_chat_AiSdk5UiMessage>, message: string) => {
		const threadId = threadIdByChat.get(chat);
		if (!threadId) {
			return;
		}
		useStore.actions.setSession(threadId, (prev) => {
			const base = prev ?? thread_session_create();
			if (base.draftComposerText === message) {
				return base;
			}
			return { ...base, draftComposerText: message };
		});
	});

	const failedSendUserMessage = selectedThreadFailedSendUserMessageId
		? activeBranchMessages.mapById.get(selectedThreadFailedSendUserMessageId)
		: undefined;

	const sendUserTextNow = useFn(
		(
			threadId: string,
			value: string,
			options?: {
				messageId?: string;
				queuedMessage?: AiChatQueuedUserMessage;
			},
		) => {
			if (!value.trim()) {
				return false;
			}

			const session = useStore.actions.getSession(threadId);
			const chat = session?.chat;

			if (!session || !chat) {
				should_never_happen("[AiChatController.useThreadRuntime.sendUserText] Missing deps", {
					threadId,
					value,
				});
				return false;
			}

			const targetMessage = options?.messageId ? activeBranchMessages?.mapById.get(options.messageId) : null;
			const targetMessageIndex = targetMessage ? activeBranchMessages.list.indexOf(targetMessage) : undefined;
			const latestMessage = activeBranchMessages.list.at(-1);

			const targetMessageIsFailedUserMessage = Boolean(
				targetMessage?.role === "user" && failedSendUserMessage?.id === targetMessage.id,
			);
			const targetMessageIsFailedOptimisticUserMessage = Boolean(
				targetMessageIsFailedUserMessage && !targetMessage?.metadata?.convexId,
			);
			const failedSendUserMessageIndex =
				failedSendUserMessage?.role === "user"
					? activeBranchMessages.list.indexOf(failedSendUserMessage)
					: -1;
			const shouldReplaceFailedSend = !targetMessage && failedSendUserMessageIndex >= 0;
			const threadSelectedModelId =
				options?.queuedMessage?.selectedModelId ??
				(targetMessageIsFailedOptimisticUserMessage ? get_message_selected_model_id(targetMessage) : undefined) ??
				session.selectedModelId ??
				selectedModelId;
			const threadSelectedModeId =
				options?.queuedMessage?.selectedModeId ??
				(targetMessageIsFailedOptimisticUserMessage ? get_message_selected_mode_id(targetMessage) : undefined) ??
				session.selectedModeId ??
				selectedModeId;

			if (
				is_ai_chat_optimistic_thread_id(threadId) &&
				latestMessage &&
				!targetMessageIsFailedOptimisticUserMessage &&
				!shouldReplaceFailedSend
			) {
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
				return false;
			}

			// Stop can leave a client-only assistant. Drop it before the next turn
			// so it does not stay beside the new request.
			const shouldDropOptimisticAssistant = Boolean(
				!targetMessage && latestMessage?.role === "assistant" && !latestMessage.metadata?.convexId,
			);
			let nextChatMessages = activeBranchMessages.list;
			if (targetMessageIndex !== undefined && targetMessageIndex >= 0) {
				nextChatMessages = activeBranchMessages.list.slice(0, targetMessageIndex);
			} else if (shouldReplaceFailedSend) {
				nextChatMessages = activeBranchMessages.list.slice(0, failedSendUserMessageIndex);
			} else if (shouldDropOptimisticAssistant) {
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

				// Retry passes the failed message id; replace that client-only message
				// from its original parent instead of treating it as the persisted target.
				if (targetMessageIsFailedOptimisticUserMessage) {
					return {
						convexParentId: targetMessage?.metadata?.convexParentId ?? null,
						parentClientGeneratedId: targetMessage?.metadata?.parentClientGeneratedId ?? null,
					};
				}

				if (targetMessage) {
					if (!targetMessage.metadata?.convexId) {
						return blockUntilParentPersists(targetMessage, "target-message-not-persisted");
					}

					return {
						convexParentId: targetMessage.metadata?.convexParentId ?? null,
						parentClientGeneratedId: targetMessage.metadata?.parentClientGeneratedId ?? null,
					};
				}

				// A new turn replaces the failed turn. Use its parent even when the
				// backend persisted the failed user before the assistant stream broke.
				if (shouldReplaceFailedSend) {
					return {
						convexParentId: failedSendUserMessage?.metadata?.convexParentId ?? null,
						parentClientGeneratedId: failedSendUserMessage?.metadata?.parentClientGeneratedId ?? null,
					};
				}

				const parentMessage = shouldDropOptimisticAssistant ? nextChatMessages.at(-1) : latestMessage;

				if (!parentMessage) {
					return {
						convexParentId: null,
						parentClientGeneratedId: null,
					};
				}

				const parentId = parentMessage.metadata?.convexId ?? null;
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
				return false;
			}

			chat.messages = nextChatMessages;

			const request = chat.sendMessage({
				...(options?.queuedMessage ? { id: options.queuedMessage.id } : {}),
				role: "user",
				parts: [{ type: "text", text: value }],
				metadata: {
					convexParentId: parentMessageIds.convexParentId,
					parentClientGeneratedId: parentMessageIds.parentClientGeneratedId,
					selectedModelId: threadSelectedModelId,
					selectedModeId: threadSelectedModeId,
				} satisfies NonNullable<ai_chat_AiSdk5UiMessage["metadata"]>,
			});
			track_chat_request(chat, request, options?.queuedMessage?.id ?? null);

			useStore.actions.setSession(threadId, (prev) => {
				if (!prev) {
					should_never_happen("[AiChatController.useThreadRuntime.sendUserTextNow] Missing session", {
						threadId,
					});
					return;
				}

				return {
					...prev,
					anchorId: null,
					// Retrying the failed turn resumes its followers. Another failure pauses them again.
					isQueuePaused: targetMessageIsFailedUserMessage ? false : prev.isQueuePaused,
				};
			});

			return true;
		},
	);

	const sendUserText = useFn((threadId: string, value: string, options?: { messageId?: string }) => {
		if (!value.trim()) {
			return false;
		}

		const session = useStore.actions.getSession(threadId);
		const chat = session?.chat;
		if (!session || !chat) {
			should_never_happen("[AiChatController.useThreadRuntime.sendUserText] Missing deps", {
				threadId,
				value,
			});
			return false;
		}
		if (session.isArchivePending) {
			return false;
		}

		const shouldQueue =
			!options?.messageId &&
			(Boolean(session.activeRequestToken) ||
				Boolean(session.claimedQueuedUserMessageId) ||
				session.queuedUserMessages.length > 0 ||
				chat.status === "submitted" ||
				chat.status === "streaming");

		if (shouldQueue) {
			const didEnqueue = useStore.actions.enqueueQueuedUserMessage(threadId, {
				id: generate_id("ai_message"),
				text: value,
				selectedModelId: session.selectedModelId ?? selectedModelId,
				selectedModeId: session.selectedModeId ?? selectedModeId,
			});
			if (didEnqueue) {
				setComposerValue(chat, "");
			}
			return didEnqueue;
		}

		const didSend = sendUserTextNow(threadId, value, options);
		if (didSend) {
			setComposerValue(chat, "");
		}
		return didSend;
	});

	const setSelectedModelId = useFn((modelId: ai_chat_ModelId) => {
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
	});

	const setSelectedModeId = useFn((mode: ai_chat_ModeId) => {
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
	});

	const startQueuedUserMessageEdit = useFn((messageId: AiChatQueuedUserMessage["id"]) => {
		if (!selectedThreadId) {
			return false;
		}
		return useStore.actions.startQueuedUserMessageEdit(selectedThreadId, messageId);
	});

	const setQueuedUserMessageEditText = useFn(
		(chat: Chat<ai_chat_AiSdk5UiMessage>, messageId: AiChatQueuedUserMessage["id"], text: string) => {
			const threadId = threadIdByChat.get(chat);
			if (!threadId) {
				return;
			}
			const edit = useStore.actions.getSession(threadId)?.queuedUserMessageEdit;
			if (!edit || edit.id !== messageId) {
				return;
			}
			useStore.actions.updateQueuedUserMessageEdit(threadId, { ...edit, text });
		},
	);

	const setQueuedUserMessageEditModelId = useFn(
		(
			chat: Chat<ai_chat_AiSdk5UiMessage>,
			messageId: AiChatQueuedUserMessage["id"],
			selectedModelId: ai_chat_ModelId,
		) => {
			const threadId = threadIdByChat.get(chat);
			if (!threadId) {
				return;
			}
			const edit = useStore.actions.getSession(threadId)?.queuedUserMessageEdit;
			if (!edit || edit.id !== messageId) {
				return;
			}
			useStore.actions.updateQueuedUserMessageEdit(threadId, { ...edit, selectedModelId });
		},
	);

	const setQueuedUserMessageEditModeId = useFn(
		(
			chat: Chat<ai_chat_AiSdk5UiMessage>,
			messageId: AiChatQueuedUserMessage["id"],
			selectedModeId: ai_chat_ModeId,
		) => {
			const threadId = threadIdByChat.get(chat);
			if (!threadId) {
				return;
			}
			const edit = useStore.actions.getSession(threadId)?.queuedUserMessageEdit;
			if (!edit || edit.id !== messageId) {
				return;
			}
			useStore.actions.updateQueuedUserMessageEdit(threadId, { ...edit, selectedModeId });
		},
	);

	const setQueuedUserMessagesReordering = useFn(
		(chat: Chat<ai_chat_AiSdk5UiMessage>, isQueueReordering: boolean) => {
			const threadId = threadIdByChat.get(chat);
			if (!threadId) {
				return;
			}
			useStore.actions.setQueuedUserMessagesReordering(threadId, isQueueReordering);
		},
	);

	const saveQueuedUserMessageEdit = useFn((messageId: AiChatQueuedUserMessage["id"], text: string) => {
		if (!selectedThreadId) {
			return false;
		}
		return useStore.actions.saveQueuedUserMessageEdit(selectedThreadId, messageId, text);
	});

	const cancelQueuedUserMessageEdit = useFn((messageId: AiChatQueuedUserMessage["id"]) => {
		if (!selectedThreadId) {
			return;
		}
		useStore.actions.cancelQueuedUserMessageEdit(selectedThreadId, messageId);
	});

	const reorderQueuedUserMessages = useFn(
		(orderedMessageIds: readonly AiChatQueuedUserMessage["id"][]) => {
			if (!selectedThreadId) {
				return false;
			}
			return useStore.actions.reorderQueuedUserMessages(selectedThreadId, orderedMessageIds);
		},
	);

	const removeQueuedUserMessage = useFn((messageId: AiChatQueuedUserMessage["id"]) => {
		if (!selectedThreadId) {
			return;
		}
		useStore.actions.removeQueuedUserMessage(selectedThreadId, messageId);
	});

	const resumeQueuedUserMessages = useFn(() => {
		if (!selectedThreadId) {
			return;
		}

		// Resume an error-paused queue by retrying its visible failed turn first.
		if (failedSendUserMessage?.role === "user") {
			sendUserTextNow(selectedThreadId, ai_chat_get_message_text(failedSendUserMessage), {
				messageId: failedSendUserMessage.id,
			});
			return;
		}

		useStore.actions.resumeQueuedUserMessages(selectedThreadId);
	});

	const stop = useFn(() => {
		if (selectedThreadId) {
			// Stop the active turn, but keep later messages until the user resumes the queue.
			useStore.actions.pauseQueuedUserMessages(selectedThreadId);
		}
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
		if (session?.isArchivePending) {
			return false;
		}

		const latestMessage = activeBranchMessages.list.at(-1);
		if (!latestMessage) {
			return true;
		}

		const latestMessageHasPersistedId = Boolean(latestMessage.metadata?.convexId);
		if (latestMessageHasPersistedId) {
			return true;
		}

		// Allow retrying a client-only failed user message because its replacement
		// is anchored to the last persisted parent, not to the failed optimistic id.
		if (latestMessage.role === "user" && selectedThreadFailedSendUserMessageId === latestMessage.id) {
			return true;
		}

		if (selectedThreadIsOptimistic) {
			return false;
		}

		if (latestMessage.role === "assistant") {
			const parentMessage = activeBranchMessages.list.at(-2);
			// A stopped assistant can remain client-only when the stream is aborted before
			// persistence finishes. Let the next send drop it only after the previous
			// parent has refreshed from Convex with a persisted id.
			return Boolean(parentMessage?.metadata?.convexId);
		}

		return false;
	})();

	const queuedUserMessages = session?.queuedUserMessages ?? EMPTY_QUEUED_USER_MESSAGES;
	const queuedUserMessageEdit = session?.queuedUserMessageEdit ?? null;
	const isQueueingUserText =
		isRunning ||
		Boolean(session?.activeRequestToken) ||
		Boolean(session?.claimedQueuedUserMessageId) ||
		Boolean(session?.isArchivePending) ||
		queuedUserMessages.length > 0;
	const canQueueUserText =
		Boolean(selectedThreadId) && !session?.isArchivePending && queuedUserMessages.length < QUEUED_USER_MESSAGE_LIMIT;
	const isMessageQueueFull = queuedUserMessages.length >= QUEUED_USER_MESSAGE_LIMIT;
	const isMessageQueuePaused = Boolean(session?.isQueuePaused);

	const status = ((/* iife */) => {
		if (!selectedThreadId) {
			return "idle" as const;
		}
		if (selectedThreadIsOptimistic) {
			return "loaded" as const;
		}
		if (persistedThreadMessages === undefined) {
			return "loading" as const;
		}
		return "loaded" as const;
	})();

	const setEditingMessageId = useFn((threadId: string, messageId: string | null) => {
		useStore.actions.setEditingMessageId(threadId, messageId);
	});

	const syncRenderState = useFn(() => {
		useStore.actions.syncThreadRenderState({
			threadId: selectedThreadId,
			messages: activeBranchMessages.list,
			branchSiblingIdsByParentId: messageChildIdsByParentId,
			isRunning,
			hasError: Boolean(chat.error),
		});
	});

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

	useEffect(() => {
		const latestMessage = activeBranchMessages.list.at(-1);
		const latestMessageParent = activeBranchMessages.list.at(-2);
		// Stop can leave an empty assistant that onFinish intentionally does not persist.
		// Drop it only after its parent is persisted, so the queued follower has a safe anchor.
		const canDropClientOnlyAssistant = Boolean(
			latestMessage?.role === "assistant" &&
				!latestMessage.metadata?.convexId &&
				!message_has_visible_parts(latestMessage) &&
				latestMessageParent?.metadata?.convexId,
		);
		// A failed turn can be replaced from its parent, including when Convex
		// persisted the user before its assistant stream failed.
		if (
			!selectedThreadId ||
			(selectedThreadIsOptimistic && !failedSendUserMessage) ||
			!session?.chat ||
			session.chat !== activeChatInstance ||
			session.isQueuePaused ||
			session.activeRequestToken ||
			session.claimedQueuedUserMessageId ||
			session.isQueueReordering ||
			session.isArchivePending ||
			session.queuedUserMessages.length === 0 ||
			isRunning ||
			(persistedThreadMessages === undefined && !failedSendUserMessage) ||
			(latestMessage &&
				!latestMessage.metadata?.convexId &&
				!failedSendUserMessage &&
				!canDropClientOnlyAssistant)
		) {
			return;
		}

		let cancelled = false;
		queueMicrotask(() => {
			if (cancelled) {
				return;
			}

			const currentSession = useStore.actions.getSession(selectedThreadId);
			if (
				!currentSession ||
				currentSession.chat !== activeChatInstance ||
				currentSession.isQueuePaused ||
				currentSession.activeRequestToken ||
				currentSession.claimedQueuedUserMessageId ||
				currentSession.isQueueReordering
			) {
				return;
			}

			const queuedMessage = useStore.actions.claimNextQueuedUserMessage(selectedThreadId);
			if (!queuedMessage) {
				return;
			}

			try {
				const didSend = sendUserTextNow(selectedThreadId, queuedMessage.text, { queuedMessage });
				if (!didSend) {
					useStore.actions.restoreClaimedQueuedUserMessage(selectedThreadId, queuedMessage);
				}
			} catch (error: unknown) {
				useStore.actions.restoreClaimedQueuedUserMessage(selectedThreadId, queuedMessage);
				console.error("[AiChatController.useThreadRuntime] Failed to start queued message", {
					error,
					threadId: selectedThreadId,
					messageId: queuedMessage.id,
				});
			}
		});

		return () => {
			cancelled = true;
		};
	}, [
		activeBranchMessages.list,
		activeChatInstance,
		failedSendUserMessage,
		isRunning,
		persistedThreadMessages,
		selectedThreadId,
		selectedThreadIsOptimistic,
		sendUserTextNow,
		session,
	]);

	// Attach the render-created Chat instance to the selected session once React has produced it.
	// Restored `ai_thread-*` tabs use the same session shape as persisted tabs; the id prefix
	// controls request routing later.
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

	useLayoutEffect(() => {
		// Sync after every committed runtime render: AI SDK chat state can update through mutable Chat internals,
		// so dependency identity is not a reliable signal for every message/topology change.
		useStore.actions.syncThreadRenderState({
			threadId: selectedThreadId,
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
		queuedUserMessages,
		queuedUserMessageEdit,
		queuedUserMessageLimit: QUEUED_USER_MESSAGE_LIMIT,
		canQueueUserText,
		isQueueingUserText,
		isMessageQueueFull,
		isMessageQueuePaused,
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
		setEditingMessageId,
		startQueuedUserMessageEdit,
		setQueuedUserMessageEditText,
		setQueuedUserMessageEditModelId,
		setQueuedUserMessageEditModeId,
		saveQueuedUserMessageEdit,
		cancelQueuedUserMessageEdit,
		setQueuedUserMessagesReordering,
		reorderQueuedUserMessages,
		sendUserText,
		removeQueuedUserMessage,
		resumeQueuedUserMessages,
		regenerate,
		stop,
		resumeStream: chat.resumeStream,
		addToolOutput: chat.addToolOutput,
		setMessages: chat.setMessages,
		syncRenderState,
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
