import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ai_chat_get_message_text, type ai_chat_AiSdk5UiMessage, type ai_chat_Thread } from "@/lib/ai-chat.ts";

type MockChatInstance = {
	id: string;
	messages: unknown[];
	status: "submitted" | "streaming" | "ready" | "error";
	error: Error | undefined;
	transport: MockTransport | undefined;
	sendMessage: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	pendingRequestResolvers: Array<() => void>;
	pendingRequestRejecters: Array<(error: Error) => void>;
	activeRequestCount: number;
	maxActiveRequestCount: number;
};

type MockPrepareSendMessagesRequestOptions = {
	api: string;
	body: Record<string, unknown>;
	headers: Headers;
	id: string;
	messages: Array<{
		id?: string;
		role?: ai_chat_AiSdk5UiMessage["role"];
		parts?: ai_chat_AiSdk5UiMessage["parts"];
		metadata?: {
			convexParentId?: string | null;
			selectedModelId?: string;
			selectedModeId?: string;
		};
	}>;
	trigger: "submit-message" | "regenerate-message";
};

type MockTransport = {
	options: {
		fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
		prepareSendMessagesRequest?: (options: MockPrepareSendMessagesRequestOptions) => unknown;
	};
};

const hookMocks = vi.hoisted(() => {
	return {
		tenant: {
			membershipId: "membership_test",
			organizationId: "organization_test",
			workspaceId: "workspace_test",
		},
		threads: [] as Array<{ archived: boolean; [key: string]: unknown }>,
		threadMessages: [] as Array<{
			_id: string;
			parentId: string | null;
			clientGeneratedMessageId?: string | null;
			content: ai_chat_AiSdk5UiMessage;
		}>,
		mutation: vi.fn(
			(): Promise<
				| { _yay: { threadId: string }; _nay?: never }
				| { _nay: { code: string }; _yay?: never }
			> => Promise.resolve({ _yay: { threadId: "thread_branch" } }),
		),
		renderSelectedThreadId: vi.fn(),
		chatInstances: [] as MockChatInstance[],
		holdChatRequests: false,
	};
});

vi.mock("@ai-sdk/react", () => {
	class MockChat implements MockChatInstance {
		id: string;
		messages: unknown[];
		status: MockChatInstance["status"] = "ready";
		error: Error | undefined;
		transport: MockTransport | undefined;
		nextMessageIndex = 0;
		pendingRequestResolvers: Array<() => void> = [];
		pendingRequestRejecters: Array<(error: Error) => void> = [];
		activeRequestCount = 0;
		maxActiveRequestCount = 0;
		sendMessage = vi.fn((message: unknown, _options?: unknown) => {
			this.error = undefined;
			this.status = "submitted";
			const nextMessage =
				typeof message === "object" && message !== null && !("id" in message)
					? { id: `ai_message_mock_${this.nextMessageIndex}`, ...message }
					: message;

			this.nextMessageIndex += 1;
			this.messages.push(nextMessage);
			if (!hookMocks.holdChatRequests) {
				this.status = "ready";
				return Promise.resolve();
			}

			this.activeRequestCount += 1;
			this.maxActiveRequestCount = Math.max(this.maxActiveRequestCount, this.activeRequestCount);

			return new Promise<void>((resolve, reject) => {
				let isSettled = false;
				const settle = () => {
					if (isSettled) {
						return false;
					}

					isSettled = true;
					this.activeRequestCount -= 1;
					return true;
				};

				this.pendingRequestResolvers.push(() => {
					this.pendingRequestRejecters.shift();
					if (!settle()) {
						return;
					}

					if (!this.error) {
						this.status = "ready";
					}
					resolve();
				});
				this.pendingRequestRejecters.push((error) => {
					this.pendingRequestResolvers.shift();
					if (!settle()) {
						return;
					}

					this.error = error;
					this.status = "error";
					reject(error);
				});
			});
		});
		regenerate = vi.fn(() => Promise.resolve());
		stop = vi.fn(() => {
			this.pendingRequestResolvers.shift()?.();
			return Promise.resolve();
		});
		resumeStream = vi.fn();
		addToolOutput = vi.fn();
		setMessages = vi.fn((messages: unknown[]) => {
			this.messages = messages;
		});

		constructor(args: { id?: string | null; messages?: unknown[]; transport?: MockTransport }) {
			this.id = args.id ?? "mock_chat";
			this.messages = args.messages ?? [];
			this.transport = args.transport;
			hookMocks.chatInstances.push(this);
		}
	}

	return {
		Chat: MockChat,
		useChat: (args: { chat: MockChat }) => args.chat,
	};
});

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();

	return {
		...actual,
		DefaultChatTransport: class DefaultChatTransport {
			options: unknown;

			constructor(options: unknown) {
				this.options = options;
			}
		},
	};
});

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();

	return {
		...actual,
		usePaginatedQuery: (_query: unknown, args: { archived?: boolean } | "skip") => {
			if (args === "skip") {
				return {
					results: [],
					status: "Exhausted",
					loadMore: vi.fn(),
				};
			}

			return {
				results: hookMocks.threads.filter((thread) => thread.archived === args.archived),
				status: "Exhausted",
				loadMore: vi.fn(),
			};
		},
		useMutation: () => hookMocks.mutation,
		useQuery: () => ({ messages: hookMocks.threadMessages }),
	};
});

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: {
		getToken: vi.fn(() => Promise.resolve(null)),
	},
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => hookMocks.tenant,
	},
}));

import { AiChatController, type AiChatControllerStorageKey } from "./ai-chat-controller.tsx";
import { app_local_storage_get_value, app_local_storage_set_value } from "@/lib/storage.ts";

function createThread(args: { id: string; title?: string | null; clientGeneratedId?: string | null; archived?: boolean }) {
	return {
		_id: args.id,
		_creationTime: 1,
		organizationId: hookMocks.tenant.organizationId,
		workspaceId: hookMocks.tenant.workspaceId,
		clientGeneratedId: args.clientGeneratedId ?? null,
		title: args.title ?? null,
		archived: args.archived ?? false,
		starred: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: "user_test",
		updatedBy: "user_test",
		updatedAt: 1,
		lastMessageAt: 1,
	} as ai_chat_Thread;
}

function createPersistedMessage(args: {
	id: string;
	clientGeneratedMessageId?: string | null;
	parentId?: string | null;
	content: ai_chat_AiSdk5UiMessage;
}) {
	return {
		_id: args.id,
		parentId: args.parentId ?? null,
		clientGeneratedMessageId: args.clientGeneratedMessageId ?? null,
		content: args.content,
	};
}

function ControllerProbe(props: {
	label: string;
	selectThreadId?: string;
	onStartNewChat?: (threadId: string) => void;
}) {
	const { label, selectThreadId, onStartNewChat } = props;
	const controller = AiChatController.useThreadList({ includeArchived: false });

	hookMocks.renderSelectedThreadId(controller.selectedThreadId);

	return (
		<div>
			<div data-testid={`${label}-selected`}>{controller.selectedThreadId ?? "null"}</div>
			<div data-testid={`${label}-session`}>{controller.session ? "session" : "no-session"}</div>
			{selectThreadId ? (
				<button type="button" onClick={() => controller.selectThread(selectThreadId)}>
					select {label}
				</button>
			) : null}
			<button
				type="button"
				onClick={() => {
					const threadId = controller.startNewChat();
					onStartNewChat?.(threadId);
				}}
			>
				new {label}
			</button>
		</div>
	);
}

function ThreadUpgradeMapProbe(props: { clientGeneratedId: string }) {
	const controller = AiChatController.useThreadList({ includeArchived: false });

	return (
		<div data-testid="thread-upgrade-map">
			{controller.persistedThreadIdByClientGeneratedId.get(props.clientGeneratedId) ?? "null"}
		</div>
	);
}

function RuntimeIdentityProbe() {
	const [, forceRender] = useState(0);
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const selectedChat = controller.session?.chat as MockChatInstance | null | undefined;
	const latestMessage = controller.activeBranchMessages.list.at(-1);
	const liveMessage = selectedChat?.messages.at(0) as ai_chat_AiSdk5UiMessage | undefined;

	return (
		<div>
			<div data-testid="identity-session">{selectedChat ? "session" : "no-session"}</div>
			<div data-testid="identity-can-send">{controller.canSendUserText ? "yes" : "no"}</div>
			<div data-testid="identity-latest-convex-id">{latestMessage?.metadata?.convexId ?? "null"}</div>
			<div data-testid="identity-live-convex-id">{liveMessage?.metadata?.convexId ?? "null"}</div>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId) {
						return;
					}

					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					if (!chat) {
						return;
					}

					chat.messages = [
						{
							id: "client_user_1",
							role: "user",
							parts: [{ type: "text", text: "Persist me" }],
							metadata: {
								convexParentId: null,
								parentClientGeneratedId: null,
								selectedModelId: "gpt-5.4-nano",
								selectedModeId: "ask",
							},
						} satisfies ai_chat_AiSdk5UiMessage,
					];
					forceRender((value) => value + 1);
				}}
			>
				inject matched live message
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId) {
						return;
					}

					controller.sendUserText(selectedThreadId, "Follow up");
					forceRender((value) => value + 1);
				}}
			>
				send follow up
			</button>
		</div>
	);
}

function RuntimeBranchAnchorProbe() {
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const anchorId = controller.activeBranchMessages.anchorId;

	return (
		<div>
			<div data-testid="branch-anchor">{anchorId === undefined ? "undefined" : (anchorId ?? "null")}</div>
			<div data-testid="branch-session">{controller.session ? "session" : "no-session"}</div>
			<button
				type="button"
				onClick={() => {
					AiChatController.useStore.setState({ threadById: new Map() });
					if (selectedThreadId) {
						controller.selectBranchAnchor(selectedThreadId, null);
					}
				}}
			>
				clear and select root branch
			</button>
		</div>
	);
}

function RuntimeSendProbe() {
	const [, forceRender] = useState(0);
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const selectedChat = controller.session?.chat as MockChatInstance | null | undefined;
	const latestMessage = controller.activeBranchMessages.list.at(-1);
	const failedSendUserMessageId = AiChatController.useStore((state) =>
		selectedThreadId ? (state.failedSendUserMessageIdByThreadId.get(selectedThreadId) ?? null) : null,
	);
	const failedMessage = controller.activeBranchMessages.list.find((message) => message.id === failedSendUserMessageId);

	return (
		<div>
			<div data-testid="runtime-selected">{selectedThreadId ?? "null"}</div>
			<div data-testid="runtime-session">{selectedChat ? "session" : "no-session"}</div>
			<div data-testid="runtime-latest-message">{latestMessage?.id ?? "null"}</div>
			<div data-testid="runtime-failed-message">{failedSendUserMessageId ?? "null"}</div>
			<button type="button" onClick={() => controller.startNewChat()}>
				new runtime
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId) {
						return;
					}

					controller.sendUserText(selectedThreadId, "Retry me");
					forceRender((value) => value + 1);
				}}
			>
				send first
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId) {
						return;
					}

					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					if (!chat) {
						return;
					}

					chat.error = new Error("send failed");
					forceRender((value) => value + 1);
				}}
			>
				mark failed
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId) {
						return;
					}

					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					const userMessage = chat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (!chat || userMessage?.role !== "user") {
						return;
					}

					chat.messages.push({
						id: `assistant_${userMessage.id}`,
						role: "assistant",
						parts: [],
						metadata: {
							convexParentId: null,
							parentClientGeneratedId: userMessage.id,
						},
					} satisfies ai_chat_AiSdk5UiMessage);
					chat.error = new Error("send failed");
					forceRender((value) => value + 1);
				}}
			>
				mark failed after assistant placeholder
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId || !latestMessage) {
						return;
					}

					controller.sendUserText(selectedThreadId, "Retry me", { messageId: latestMessage.id });
					forceRender((value) => value + 1);
				}}
			>
				retry latest
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId || !failedMessage) {
						return;
					}

					controller.sendUserText(selectedThreadId, "Retry me", { messageId: failedMessage.id });
					forceRender((value) => value + 1);
				}}
			>
				retry failed
			</button>
		</div>
	);
}

function RuntimeQueueProbe() {
	const [, forceRender] = useState(0);
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const selectedChat = controller.session?.chat as MockChatInstance | null | undefined;
	const failedSendUserMessageId = AiChatController.useStore((state) =>
		selectedThreadId ? (state.failedSendUserMessageIdByThreadId.get(selectedThreadId) ?? null) : null,
	);
	const failedMessage = controller.activeBranchMessages.list.find((message) => message.id === failedSendUserMessageId);

	const send = (value: string) => {
		if (!selectedThreadId) {
			return;
		}
		controller.sendUserText(selectedThreadId, value);
		forceRender((current) => current + 1);
	};

	return (
		<div>
			<div data-testid="queue-session">{selectedChat ? "session" : "no-session"}</div>
			<div data-testid="queue-selected">{selectedThreadId ?? "null"}</div>
			<div data-testid="queue-draft">{controller.session?.draftComposerText ?? ""}</div>
			<div data-testid="queue-texts">{controller.queuedUserMessages.map((message) => message.text).join("|")}</div>
			<div data-testid="queue-edit">
				{controller.queuedUserMessageEdit
					? `${controller.queuedUserMessageEdit.id}:${controller.queuedUserMessageEdit.text}:${controller.queuedUserMessageEdit.selectedModelId}:${controller.queuedUserMessageEdit.selectedModeId}`
					: "null"}
			</div>
			<div data-testid="queue-full">{controller.isMessageQueueFull ? "yes" : "no"}</div>
			<div data-testid="queue-paused">{controller.isMessageQueuePaused ? "yes" : "no"}</div>
			<div data-testid="queue-failed-message">{failedSendUserMessageId ?? "null"}</div>
			<div data-testid="queue-failed-text">
				{failedMessage ? ai_chat_get_message_text(failedMessage) : "null"}
			</div>
			<button type="button" onClick={() => controller.startNewChat()}>
				new queue probe
			</button>
			<button type="button" onClick={() => send("First")}>
				send first queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = controller.session?.chat;
					if (chat) {
						controller.setComposerValue(chat, "Normal draft");
					}
				}}
			>
				set normal draft probe
			</button>
			<button type="button" onClick={() => send("Second")}>
				send second queue probe
			</button>
			<button type="button" onClick={() => send("Third")}>
				send third queue probe
			</button>
			<button type="button" onClick={() => send("Fourth")}>
				send fourth queue probe
			</button>
			<button type="button" onClick={() => send("Fifth")}>
				send fifth queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					for (const value of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
						send(value);
					}
				}}
			>
				send numbered queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const message = controller.queuedUserMessages.at(0);
					if (message) {
						controller.removeQueuedUserMessage(message.id);
					}
				}}
			>
				remove first queued message probe
			</button>
			<button
				type="button"
				onClick={() => {
					const message = controller.queuedUserMessages.at(1);
					if (message) {
						controller.removeQueuedUserMessage(message.id);
					}
				}}
			>
				remove second queued message probe
			</button>
			<button
				type="button"
				onClick={() => {
					const message = controller.queuedUserMessages.at(0);
					if (message) {
						controller.startQueuedUserMessageEdit(message.id);
					}
				}}
			>
				edit first queued message probe
			</button>
			<button
				type="button"
				onClick={() => {
					const message = controller.queuedUserMessages.at(1);
					if (message) {
						controller.startQueuedUserMessageEdit(message.id);
					}
				}}
			>
				edit second queued message probe
			</button>
			<button
				type="button"
				onClick={() => {
					const message = controller.queuedUserMessages.at(-1);
					if (message) {
						controller.startQueuedUserMessageEdit(message.id);
					}
				}}
			>
				edit last queued message probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = controller.session?.chat;
					const edit = controller.queuedUserMessageEdit;
					if (chat && edit) {
						controller.setQueuedUserMessageEditText(chat, edit.id, "Second edited");
					}
				}}
			>
				change queued edit probe
			</button>
			<button
				type="button"
				onClick={() => {
					const edit = controller.queuedUserMessageEdit;
					if (edit) {
						controller.saveQueuedUserMessageEdit(edit.id, edit.text);
					}
				}}
			>
				save queued edit probe
			</button>
			<button
				type="button"
				onClick={() => {
					const edit = controller.queuedUserMessageEdit;
					if (edit) {
						controller.cancelQueuedUserMessageEdit(edit.id);
					}
				}}
			>
				cancel queued edit probe
			</button>
			<button
				type="button"
				onClick={() => {
					const lastMessage = controller.queuedUserMessages.at(-1);
					if (!lastMessage) {
						return;
					}
					controller.reorderQueuedUserMessages([
						lastMessage.id,
						...controller.queuedUserMessages
							.filter((message) => message.id !== lastMessage.id)
							.map((message) => message.id),
					]);
				}}
			>
				move last queued message first probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = controller.session?.chat;
					if (chat) {
						controller.setQueuedUserMessagesReordering(chat, true);
					}
				}}
			>
				start queued reorder probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = controller.session?.chat;
					if (chat) {
						controller.setQueuedUserMessagesReordering(chat, false);
					}
				}}
			>
				finish queued reorder probe
			</button>
			<button
				type="button"
				onClick={() => {
					controller.setSelectedModelId("gpt-5.4-nano");
					controller.setSelectedModeId("agent");
				}}
			>
				select nano agent queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					controller.setSelectedModelId("gpt-5.4-mini");
					controller.setSelectedModeId("ask");
				}}
			>
				select mini ask queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					for (let index = 0; index < 11; index += 1) {
						send(`Queued ${index}`);
					}
				}}
			>
				fill queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const latestUserMessage = selectedChat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (latestUserMessage?.role === "user") {
						if (!latestUserMessage.metadata) {
							latestUserMessage.metadata = {
								parentClientGeneratedId: null,
							};
						}
						latestUserMessage.metadata.convexId = `convex_${latestUserMessage.id}`;
						selectedChat?.messages.push({
							id: `assistant_${latestUserMessage.id}`,
							role: "assistant",
							parts: [{ type: "text", text: "Done" }],
							metadata: {
								convexParentId: latestUserMessage.metadata.convexId,
								parentClientGeneratedId: latestUserMessage.id,
							},
						} satisfies ai_chat_AiSdk5UiMessage);
					}
					selectedChat?.pendingRequestResolvers.shift()?.();
					forceRender((current) => current + 1);
				}}
			>
				complete client response queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const latestAssistantMessage = selectedChat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (latestAssistantMessage?.role === "assistant") {
						if (!latestAssistantMessage.metadata) {
							latestAssistantMessage.metadata = {
								parentClientGeneratedId: null,
							};
						}
						latestAssistantMessage.metadata.convexId = `convex_${latestAssistantMessage.id}`;
					}
					forceRender((current) => current + 1);
				}}
			>
				persist assistant queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const latestUserMessage = selectedChat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (latestUserMessage?.role === "user") {
						if (!latestUserMessage.metadata) {
							latestUserMessage.metadata = {
								parentClientGeneratedId: null,
							};
						}
						latestUserMessage.metadata.convexId = `convex_${latestUserMessage.id}`;
						selectedChat?.messages.push({
							id: `assistant_${latestUserMessage.id}`,
							role: "assistant",
							parts: [{ type: "text", text: "Done" }],
							metadata: {
								convexId: `convex_assistant_${latestUserMessage.id}`,
								convexParentId: latestUserMessage.metadata.convexId,
								parentClientGeneratedId: latestUserMessage.id,
							},
						} satisfies ai_chat_AiSdk5UiMessage);
					}
					forceRender((current) => current + 1);
				}}
			>
				persist response before settle queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					selectedChat?.pendingRequestResolvers.shift()?.();
					forceRender((current) => current + 1);
				}}
			>
				settle request queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					if (!chat) {
						return;
					}
					chat.error = new Error("send failed");
					chat.status = "error";
					chat.pendingRequestResolvers.shift()?.();
					forceRender((current) => current + 1);
				}}
			>
				fail request queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					chat?.pendingRequestRejecters.shift()?.(new Error("request rejected"));
					forceRender((current) => current + 1);
				}}
			>
				reject request queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const chat = hookMocks.chatInstances.find((chat) => chat.id === selectedThreadId);
					const failedUserMessage = chat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (!chat || failedUserMessage?.role !== "user") {
						return;
					}

					chat.messages.push({
						id: `assistant_${failedUserMessage.id}`,
						role: "assistant",
						parts: [],
						metadata: {
							convexParentId:
								failedUserMessage.metadata?.convexId ?? null,
							parentClientGeneratedId: failedUserMessage.id,
						},
					} satisfies ai_chat_AiSdk5UiMessage);
					chat.error = new Error("send failed");
					chat.status = "error";
					chat.pendingRequestResolvers.shift()?.();
					forceRender((current) => current + 1);
				}}
			>
				fail request after assistant placeholder queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					const userMessage = selectedChat?.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
					if (!selectedChat || userMessage?.role !== "user") {
						return;
					}

					if (!userMessage.metadata) {
						userMessage.metadata = {
							parentClientGeneratedId: null,
						};
					}
					userMessage.metadata.convexId = `convex_${userMessage.id}`;
					selectedChat.messages.push({
						id: `assistant_${userMessage.id}`,
						role: "assistant",
						parts: [],
						metadata: {
							convexParentId: userMessage.metadata.convexId,
							parentClientGeneratedId: userMessage.id,
						},
					} satisfies ai_chat_AiSdk5UiMessage);
					selectedChat.pendingRequestResolvers.shift()?.();
					forceRender((current) => current + 1);
				}}
			>
				settle stopped request with empty assistant queue probe
			</button>
			<button type="button" onClick={controller.stop}>
				stop queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					controller.stop();
					send("Second");
				}}
			>
				stop and queue follower probe
			</button>
			<button type="button" onClick={controller.resumeQueuedUserMessages}>
				resume queue probe
			</button>
			<button
				type="button"
				onClick={() => {
					if (!selectedThreadId || !failedMessage) {
						return;
					}
					controller.sendUserText(selectedThreadId, ai_chat_get_message_text(failedMessage), {
						messageId: failedMessage.id,
					});
				}}
			>
				retry failed queue message probe
			</button>
			<button
				type="button"
				onClick={() => {
					if (selectedThreadId) {
						controller.archiveThread(selectedThreadId, true);
					}
				}}
			>
				archive queue probe
			</button>
		</div>
	);
}

function ControllerSurface(props: { storageKey: AiChatControllerStorageKey; children: ReactNode }) {
	return (
		<AiChatController key={props.storageKey} storageKey={props.storageKey}>
			{props.children}
		</AiChatController>
	);
}

function SidebarSurface(props: { children: ReactNode }) {
	const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;

	return (
		<AiChatController key={selectedTabStorageKey} storageKey={selectedTabStorageKey}>
			{props.children}
		</AiChatController>
	);
}

function FullPageSurface(props: { children: ReactNode; initialSelectedThreadId?: string | null }) {
	const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;

	return (
		<AiChatController key={storageKey} storageKey={storageKey} initialSelectedThreadId={props.initialSelectedThreadId}>
			{props.children}
		</AiChatController>
	);
}

describe("AiChatController", () => {
	beforeEach(() => {
		hookMocks.tenant.membershipId = `membership_${crypto.randomUUID()}`;
		hookMocks.tenant.organizationId = "organization_test";
		hookMocks.tenant.workspaceId = "workspace_test";
		hookMocks.threads = [];
		hookMocks.threadMessages = [];
		hookMocks.chatInstances = [];
		hookMocks.holdChatRequests = false;
		hookMocks.mutation.mockClear();
		hookMocks.renderSelectedThreadId.mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	test("initializes full-page selection from last-open storage before controllers render", () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		app_local_storage_set_value(storageKey, "thread_full_last");

		render(
			<FullPageSurface>
				<ControllerProbe label="full" />
			</FullPageSurface>,
		);

		expect(screen.getByTestId("full-selected").textContent).toBe("thread_full_last");
		expect(hookMocks.renderSelectedThreadId).toHaveBeenNthCalledWith(1, "thread_full_last");
	});

	test("initializes full-page selection from URL thread before last-open storage", () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		app_local_storage_set_value(storageKey, "thread_full_last");

		render(
			<FullPageSurface initialSelectedThreadId="thread_url_selected">
				<ControllerProbe label="full" />
			</FullPageSurface>,
		);

		expect(screen.getByTestId("full-selected").textContent).toBe("thread_url_selected");
		expect(hookMocks.renderSelectedThreadId).toHaveBeenNthCalledWith(1, "thread_url_selected");
		expect(app_local_storage_get_value(storageKey)).toBe("thread_full_last");
	});

	test("rehydrates URL optimistic full-page selection as an optimistic session", async () => {
		const optimisticThreadId = "ai_thread-url_restored";

		render(
			<FullPageSurface initialSelectedThreadId={optimisticThreadId}>
				<ControllerProbe label="full" />
			</FullPageSurface>,
		);

		expect(screen.getByTestId("full-selected").textContent).toBe(optimisticThreadId);
		await waitFor(() => {
			expect(screen.getByTestId("full-session").textContent).toBe("session");
		});
		expect(hookMocks.chatInstances.some((chat) => chat.id === optimisticThreadId)).toBe(true);
	});

	test("initializes sidebar selection from selected/open tab storage and ignores full-page last-open storage", () => {
		const fullPageStorageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${hookMocks.tenant.membershipId}`;
		const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;

		app_local_storage_set_value(fullPageStorageKey, "thread_full_last");
		app_local_storage_set_value(openTabsStorageKey, [
			{ id: "thread_sidebar_first", title: "Sidebar first" },
			{ id: "thread_sidebar_selected", title: "Sidebar selected" },
		]);
		app_local_storage_set_value(selectedTabStorageKey, "thread_sidebar_selected");

		render(
			<SidebarSurface>
				<ControllerProbe label="sidebar" />
			</SidebarSurface>,
		);

		expect(screen.getByTestId("sidebar-selected").textContent).toBe("thread_sidebar_selected");
		expect(hookMocks.renderSelectedThreadId).toHaveBeenNthCalledWith(1, "thread_sidebar_selected");
	});

	test("initializes sidebar selection from the last open tab when the stored selected tab is stale", () => {
		const fullPageStorageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${hookMocks.tenant.membershipId}`;
		const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;

		app_local_storage_set_value(fullPageStorageKey, "thread_full_last");
		app_local_storage_set_value(openTabsStorageKey, [
			{ id: "thread_sidebar_first", title: "Sidebar first" },
			{ id: "thread_sidebar_last", title: "Sidebar last" },
		]);
		app_local_storage_set_value(selectedTabStorageKey, "thread_sidebar_stale");

		render(
			<SidebarSurface>
				<ControllerProbe label="sidebar" />
			</SidebarSurface>,
		);

		expect(screen.getByTestId("sidebar-selected").textContent).toBe("thread_sidebar_last");
		expect(hookMocks.renderSelectedThreadId).toHaveBeenNthCalledWith(1, "thread_sidebar_last");
	});

	test("exposes persisted thread ids by restored optimistic client-generated id", () => {
		const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${hookMocks.tenant.membershipId}`;
		const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;
		const optimisticThreadId = "ai_thread-restored_upgrade";
		const persistedThreadId = "thread_persisted_upgrade";

		hookMocks.threads = [
			createThread({
				id: persistedThreadId,
				clientGeneratedId: optimisticThreadId,
				title: "Upgraded thread",
			}),
		];
		app_local_storage_set_value(openTabsStorageKey, [{ id: optimisticThreadId, title: "New chat" }]);
		app_local_storage_set_value(selectedTabStorageKey, optimisticThreadId);

		render(
			<SidebarSurface>
				<ThreadUpgradeMapProbe clientGeneratedId={optimisticThreadId} />
			</SidebarSurface>,
		);

		expect(screen.getByTestId("thread-upgrade-map").textContent).toBe(persistedThreadId);
	});

	test("rehydrates stored optimistic sidebar tabs as selected optimistic sessions", async () => {
		const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${hookMocks.tenant.membershipId}`;
		const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;
		const optimisticThreadId = "ai_thread-restored_unsent";

		app_local_storage_set_value(openTabsStorageKey, [
			{ id: "thread_sidebar_last", title: "Sidebar last" },
			{ id: optimisticThreadId, title: "New chat" },
		]);
		app_local_storage_set_value(selectedTabStorageKey, optimisticThreadId);

		render(
			<SidebarSurface>
				<ControllerProbe label="sidebar" />
			</SidebarSurface>,
		);

		expect(screen.getByTestId("sidebar-selected").textContent).toBe(optimisticThreadId);
		await waitFor(() => {
			expect(screen.getByTestId("sidebar-session").textContent).toBe("session");
		});
		expect(hookMocks.chatInstances.some((chat) => chat.id === optimisticThreadId)).toBe(true);
	});

	test("sends from a restored optimistic sidebar tab with client-generated thread id", async () => {
		const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${hookMocks.tenant.membershipId}`;
		const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${hookMocks.tenant.membershipId}`;
		const optimisticThreadId = "ai_thread-restored_send";

		app_local_storage_set_value(openTabsStorageKey, [{ id: optimisticThreadId, title: "New chat" }]);
		app_local_storage_set_value(selectedTabStorageKey, optimisticThreadId);

		render(
			<SidebarSurface>
				<RuntimeSendProbe />
			</SidebarSurface>,
		);

		expect(screen.getByTestId("runtime-selected").textContent).toBe(optimisticThreadId);
		await waitFor(() => {
			expect(screen.getByTestId("runtime-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first" }));

		const chat = hookMocks.chatInstances.find((chat) => chat.id === optimisticThreadId);
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected restored optimistic chat instance");
		}
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.sendMessage.mock.calls[0]?.[1]).toBeUndefined();

		const prepareSendMessagesRequest = chat.transport?.options.prepareSendMessagesRequest;
		expect(prepareSendMessagesRequest).toBeTypeOf("function");
		if (!prepareSendMessagesRequest) {
			throw new Error("Expected restored optimistic chat transport");
		}

		const preparedRequest = await prepareSendMessagesRequest({
			api: "/api/chat",
			body: {},
			headers: new Headers(),
			id: optimisticThreadId,
			messages: [
				{
					id: "client_user_restored_send",
					role: "user",
					parts: [{ type: "text", text: "Retry me" }],
					metadata: {
						convexParentId: null,
						selectedModelId: "gpt-5.4-mini",
						selectedModeId: "ask",
					},
				},
			],
			trigger: "submit-message",
		});

		if (typeof preparedRequest !== "object" || preparedRequest === null || !("body" in preparedRequest)) {
			throw new Error("Expected prepared request body");
		}
		const body = (preparedRequest as { body: Record<string, unknown> }).body;
		expect(body).toMatchObject({
			clientGeneratedThreadId: optimisticThreadId,
			model: "gpt-5.4-mini",
			mode: "ask",
		});
		expect(body.threadId).toBeUndefined();
	});

	test("does not append assistant messages when preparing a submit request", async () => {
		render(
			<FullPageSurface initialSelectedThreadId="thread_auto_submit_guard">
				<RuntimeSendProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(hookMocks.chatInstances.some((chat) => chat.id === "thread_auto_submit_guard")).toBe(true);
		});

		const chat = hookMocks.chatInstances.find((chat) => chat.id === "thread_auto_submit_guard");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected chat instance");
		}

		const prepareSendMessagesRequest = chat.transport?.options.prepareSendMessagesRequest;
		expect(prepareSendMessagesRequest).toBeTypeOf("function");
		if (!prepareSendMessagesRequest) {
			throw new Error("Expected chat transport");
		}

		const preparedRequest = await prepareSendMessagesRequest({
			api: "/api/chat",
			body: {},
			headers: new Headers(),
			id: "thread_auto_submit_guard",
			messages: [
				{
					id: "msg_auto_submit_assistant",
					role: "assistant",
					parts: [
						{
							type: "tool-execute_code",
							toolCallId: "call_auto_submit_assistant",
							state: "output-available",
							input: { code: "return 1;" },
							output: {
								title: "Execute code",
								metadata: {
									executionId: "exec_auto_submit_assistant",
									status: "succeeded",
									elapsedMs: 1,
									resultTruncated: false,
									logsTruncated: false,
								},
								output: "Result: 1",
							},
						},
					],
					metadata: {
						convexParentId: "msg_user_before_tool",
					},
				},
			],
			trigger: "submit-message",
		});

		if (typeof preparedRequest !== "object" || preparedRequest === null || !("body" in preparedRequest)) {
			throw new Error("Expected prepared request body");
		}
		const body = (preparedRequest as { body: Record<string, unknown> }).body;
		expect(body.messages).toEqual([]);
		expect(body.parentId).toBeNull();
	});

	test("retries the same chat request after the server rate limit clears", async () => {
		render(
			<FullPageSurface initialSelectedThreadId="thread_rate_limit_retry">
				<RuntimeSendProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("runtime-session").textContent).toBe("session");
		});

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_rate_limit_retry");
		const chatFetch = chat?.transport?.options.fetch;
		if (!chatFetch) {
			throw new Error("Expected chat transport fetch");
		}

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ message: "Rate limit exceeded", retryAfterMs: 1 }, { status: 429 }),
			)
			.mockResolvedValueOnce(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);

		const response = await chatFetch("/api/chat", { method: "POST" });

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("returns a malformed rate-limit response without retrying", async () => {
		render(
			<FullPageSurface initialSelectedThreadId="thread_rate_limit_malformed">
				<RuntimeSendProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("runtime-session").textContent).toBe("session");
		});

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_rate_limit_malformed");
		const chatFetch = chat?.transport?.options.fetch;
		if (!chatFetch) {
			throw new Error("Expected chat transport fetch");
		}

		const rateLimitResponse = Response.json(
			{ message: "Rate limit exceeded", retryAfterMs: "later" },
			{ status: 429 },
		);
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(rateLimitResponse);
		vi.stubGlobal("fetch", fetchMock);

		const response = await chatFetch("/api/chat", { method: "POST" });

		expect(response).toBe(rateLimitResponse);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("cancels a rate-limit wait when the chat request stops", async () => {
		render(
			<FullPageSurface initialSelectedThreadId="thread_rate_limit_stop">
				<RuntimeSendProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("runtime-session").textContent).toBe("session");
		});

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_rate_limit_stop");
		const chatFetch = chat?.transport?.options.fetch;
		if (!chatFetch) {
			throw new Error("Expected chat transport fetch");
		}

		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ message: "Rate limit exceeded", retryAfterMs: 60_000 }, { status: 429 }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const abortController = new AbortController();

		const response = chatFetch("/api/chat", {
			method: "POST",
			signal: abortController.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		abortController.abort();

		await expect(response).rejects.toBe(abortController.signal.reason);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("uses current model and mode when preparing a regenerate request", async () => {
		render(
			<FullPageSurface initialSelectedThreadId="thread_regenerate_settings">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});
		fireEvent.click(screen.getByRole("button", { name: "select mini ask queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_regenerate_settings");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected regenerate settings chat instance");
		}
		const prepareSendMessagesRequest = chat.transport?.options.prepareSendMessagesRequest;
		if (!prepareSendMessagesRequest) {
			throw new Error("Expected regenerate settings transport");
		}

		const preparedRequest = await prepareSendMessagesRequest({
			api: "/api/chat",
			body: {},
			headers: new Headers(),
			id: "thread_regenerate_settings",
			messages: [
				{
					id: "historical_user",
					role: "user",
					parts: [{ type: "text", text: "Old turn" }],
					metadata: {
						convexParentId: null,
						selectedModelId: "gpt-5.4-nano",
						selectedModeId: "agent",
					},
				},
				{
					id: "historical_assistant",
					role: "assistant",
					parts: [{ type: "text", text: "Old answer" }],
					metadata: {
						convexParentId: "historical_user",
					},
				},
			],
			trigger: "regenerate-message",
		});

		if (typeof preparedRequest !== "object" || preparedRequest === null || !("body" in preparedRequest)) {
			throw new Error("Expected prepared regenerate request body");
		}
		expect((preparedRequest as { body: Record<string, unknown> }).body).toMatchObject({
			model: "gpt-5.4-mini",
			mode: "ask",
			parentId: "historical_assistant",
		});
	});

	test("stamps matched live messages with persisted identity before follow-up sends", async () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		app_local_storage_set_value(storageKey, "thread_persisted_identity");
		hookMocks.threadMessages = [
			createPersistedMessage({
				id: "msg_persisted_user_1",
				clientGeneratedMessageId: "client_user_1",
				content: {
					id: "client_user_1",
					role: "user",
					parts: [{ type: "text", text: "Persist me" }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
						selectedModelId: "gpt-5.4-nano",
						selectedModeId: "ask",
					},
				},
			}),
		];

		render(
			<FullPageSurface>
				<RuntimeIdentityProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("identity-session").textContent).toBe("session");
		});
		expect(screen.getByTestId("identity-latest-convex-id").textContent).toBe("msg_persisted_user_1");
		expect(screen.getByTestId("identity-can-send").textContent).toBe("yes");

		fireEvent.click(screen.getByRole("button", { name: "inject matched live message" }));

		await waitFor(() => {
			expect(screen.getByTestId("identity-live-convex-id").textContent).toBe("msg_persisted_user_1");
		});

		fireEvent.click(screen.getByRole("button", { name: "send follow up" }));

		const chat = hookMocks.chatInstances.find((chat) => chat.id === "thread_persisted_identity");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected persisted identity chat instance");
		}
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		const sentMessage = chat.sendMessage.mock.calls.at(-1)?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.metadata?.convexParentId).toBe("msg_persisted_user_1");
	});

	test("keeps message references stable for cloned execute_code messages with equal content", () => {
		AiChatController.useStore.actions.clearRenderState();

		const message = {
			id: "msg_execute_code_stable",
			role: "assistant",
			parts: [
				{
					type: "tool-execute_code",
					toolCallId: "call_execute_code_stable",
					state: "output-available",
					input: {
						code: "return input.a * input.b + input.c;",
						input: { a: 12, b: 9, c: 7 },
					},
					output: {
						title: "Execute code",
						metadata: {
							executionId: "exec_stable",
							status: "succeeded",
							elapsedMs: 7,
							resultTruncated: false,
							logsTruncated: false,
						},
						output: "Result: 115",
					},
				},
			],
			metadata: {
				convexParentId: "msg_user_execute_code",
				parentClientGeneratedId: null,
			},
		} satisfies ai_chat_AiSdk5UiMessage;

		AiChatController.useStore.actions.syncThreadRenderState({
			threadId: "thread_execute_code_stable",
			messages: [message],
			branchSiblingIdsByParentId: new Map([[message.metadata.convexParentId, [message.id]]]),
			isRunning: false,
			hasError: false,
		});

		const firstState = AiChatController.useStore.getState();
		const firstMessageById = firstState.messageById;
		const firstMessage = firstMessageById.get(message.id);
		expect(firstMessage).toBe(message);

		// Mirror live execute_code hydration, where equal tool content can arrive as a new object.
		const clonedMessage = structuredClone(message) as ai_chat_AiSdk5UiMessage;
		AiChatController.useStore.actions.syncThreadRenderState({
			threadId: "thread_execute_code_stable",
			messages: [clonedMessage],
			branchSiblingIdsByParentId: new Map([[message.metadata.convexParentId, [message.id]]]),
			isRunning: false,
			hasError: false,
		});

		const nextState = AiChatController.useStore.getState();
		expect(nextState.messageById).toBe(firstMessageById);
		expect(nextState.messageById.get(message.id)).toBe(firstMessage);
	});

	test("selectBranchAnchor hydrates a missing restored persisted thread session", async () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		app_local_storage_set_value(storageKey, "thread_restored_branch");
		hookMocks.threadMessages = [
			createPersistedMessage({
				id: "msg_branch_user_1",
				content: {
					id: "client_branch_user_1",
					role: "user",
					parts: [{ type: "text", text: "Edit this restored message" }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
						selectedModelId: "gpt-5.4-nano",
						selectedModeId: "ask",
					},
				},
			}),
		];

		render(
			<FullPageSurface>
				<RuntimeBranchAnchorProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("branch-session").textContent).toBe("session");
		});
		expect(screen.getByTestId("branch-anchor").textContent).toBe("undefined");

		fireEvent.click(screen.getByRole("button", { name: "clear and select root branch" }));

		await waitFor(() => {
			expect(screen.getByTestId("branch-session").textContent).toBe("session");
			expect(screen.getByTestId("branch-anchor").textContent).toBe("null");
		});
	});

	test("selectThread hydrates a session and updates only the current surface selection", () => {
		const surfaceAStorageKey: AiChatControllerStorageKey = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}_a`;
		const surfaceBStorageKey: AiChatControllerStorageKey = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}_b`;

		render(
			<div>
				<ControllerSurface storageKey={surfaceAStorageKey}>
					<ControllerProbe label="surface-a" selectThreadId="thread_selected_a" />
				</ControllerSurface>
				<ControllerSurface storageKey={surfaceBStorageKey}>
					<ControllerProbe label="surface-b" />
				</ControllerSurface>
			</div>,
		);

		fireEvent.click(screen.getByRole("button", { name: "select surface-a" }));

		expect(screen.getByTestId("surface-a-selected").textContent).toBe("thread_selected_a");
		expect(screen.getByTestId("surface-a-session").textContent).toBe("session");
		expect(screen.getByTestId("surface-b-selected").textContent).toBe("null");
		expect(app_local_storage_get_value(surfaceAStorageKey)).toBe("thread_selected_a");
		expect(app_local_storage_get_value(surfaceBStorageKey)).toBeNull();
	});

	test("startNewChat selects the optimistic id without writing last-open storage", () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		app_local_storage_set_value(storageKey, "thread_existing_last");

		render(
			<FullPageSurface>
				<ControllerProbe label="full" />
			</FullPageSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new full" }));

		const selectedThreadId = screen.getByTestId("full-selected").textContent;
		expect(selectedThreadId).not.toBeNull();
		expect(selectedThreadId).not.toBe("null");
		expect(selectedThreadId).not.toBe("thread_existing_last");
		expect(app_local_storage_get_value(storageKey)).toBe("thread_existing_last");
	});

	test("retries a failed optimistic user message by replacing it from its original parent", async () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;

		render(
			<ControllerSurface storageKey={storageKey}>
				<RuntimeSendProbe />
			</ControllerSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new runtime" }));

		await waitFor(() => {
			expect(screen.getByTestId("runtime-selected").textContent).toMatch(/^ai_thread-/);
		});

		fireEvent.click(screen.getByRole("button", { name: "send first" }));

		const chat = hookMocks.chatInstances.find((chat) => chat.sendMessage.mock.calls.length === 1);
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected selected chat to send first message");
		}

		await waitFor(() => {
			expect(screen.getByTestId("runtime-latest-message").textContent).toBe("ai_message_mock_0");
		});

		fireEvent.click(screen.getByRole("button", { name: "mark failed" }));

		await waitFor(() => {
			expect(screen.getByTestId("runtime-failed-message").textContent).toBe("ai_message_mock_0");
		});

		fireEvent.click(screen.getByRole("button", { name: "retry latest" }));

		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(chat.messages).toHaveLength(1);
	});

	test("keeps Retry on the failed user message when AI SDK adds an assistant placeholder", async () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;

		render(
			<ControllerSurface storageKey={storageKey}>
				<RuntimeSendProbe />
			</ControllerSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new runtime" }));

		await waitFor(() => {
			expect(screen.getByTestId("runtime-selected").textContent).toMatch(/^ai_thread-/);
		});

		fireEvent.click(screen.getByRole("button", { name: "send first" }));

		const chat = hookMocks.chatInstances.find((chat) => chat.sendMessage.mock.calls.length === 1);
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected selected chat to send first message");
		}

		fireEvent.click(screen.getByRole("button", { name: "mark failed after assistant placeholder" }));

		await waitFor(() => {
			expect(screen.getByTestId("runtime-failed-message").textContent).toBe("ai_message_mock_0");
		});

		fireEvent.click(screen.getByRole("button", { name: "retry failed" }));

		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(chat.messages).toHaveLength(1);
	});

	test("runs queued messages one at a time in FIFO order", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_fifo">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fourth queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fifth queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_fifo");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected queue chat instance");
		}
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third|Fourth|Fifth");

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));

		await waitFor(() => {
			expect(chat.pendingRequestResolvers).toHaveLength(0);
		});
		expect(chat.activeRequestCount).toBe(0);
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third|Fourth|Fifth");

		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth|Fifth");
		});
		const secondSentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondSentMessage?.metadata?.convexParentId).toBe("convex_assistant_ai_message_mock_0");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "persist response before settle queue probe" }));

		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(chat.activeRequestCount).toBe(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth|Fifth");

		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Fourth|Fifth");
		});
		const thirdSentMessage = chat.sendMessage.mock.calls[2]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(thirdSentMessage?.metadata?.convexParentId).toBe(`convex_assistant_${secondSentMessage?.id}`);
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		expect(chat.sendMessage).toHaveBeenCalledTimes(3);
		expect(chat.activeRequestCount).toBe(0);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Fourth|Fifth");

		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(4);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Fifth");
		});
		const fourthSentMessage = chat.sendMessage.mock.calls[3]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(fourthSentMessage?.metadata?.convexParentId).toBe(`convex_assistant_${thirdSentMessage?.id}`);
		expect(chat.activeRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "persist response before settle queue probe" }));
		expect(chat.sendMessage).toHaveBeenCalledTimes(4);
		expect(chat.activeRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(5);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const fifthSentMessage = chat.sendMessage.mock.calls[4]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(fifthSentMessage?.metadata?.convexParentId).toBe(`convex_assistant_${fourthSentMessage?.id}`);
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);

		const sentTexts = chat.sendMessage.mock.calls.map((call) => {
			const message = call[0] as ai_chat_AiSdk5UiMessage;
			return message.parts.find((part) => part.type === "text")?.text;
		});
		expect(sentTexts).toEqual(["First", "Second", "Third", "Fourth", "Fifth"]);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(
				AiChatController.useStore.getState().threadById.get("thread_queue_fifo")?.activeRequestToken,
			).toBeNull();
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(5);
		expect(chat.activeRequestCount).toBe(0);
		expect(chat.pendingRequestResolvers).toHaveLength(0);
		expect(screen.getByTestId("queue-texts").textContent).toBe("");
	});

	test("edits a queued message in place and blocks draining until save", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_edit">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "select mini ask queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "select nano agent queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "set normal draft probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_edit");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected queue edit chat instance");
		}
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "edit first queued message probe" }));
		fireEvent.click(screen.getByRole("button", { name: "change queued edit probe" }));

		await waitFor(() => {
			expect(screen.getByTestId("queue-edit").textContent).toMatch(
				/^ai_message-.*:Second edited:gpt-5\.4-mini:ask$/,
			);
		});
		expect(screen.getByTestId("queue-draft").textContent).toBe("Normal draft");
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		expect(screen.getByTestId("queue-edit").textContent).toBe("null");
		expect(screen.getByTestId("queue-draft").textContent).toBe("Normal draft");
		const sentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.parts).toContainEqual({ type: "text", text: "Second edited" });
		expect(sentMessage?.metadata?.selectedModelId).toBe("gpt-5.4-mini");
		expect(sentMessage?.metadata?.selectedModeId).toBe("ask");
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("drains earlier messages but waits when the edited message is next", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_edit_later">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit second queued message probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_edit_later");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected later queue edit chat instance");
		}
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Third:/);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		const secondSentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondSentMessage?.parts).toContainEqual({ type: "text", text: "Second" });
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Third:/);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third");

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const thirdSentMessage = chat.sendMessage.mock.calls[2]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(thirdSentMessage?.parts).toContainEqual({ type: "text", text: "Third" });
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("keeps one through zero in order while the final queued message is edited", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_numbered_edit">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send numbered queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit last queued message probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_numbered_edit");
		if (!chat) {
			throw new Error("Expected numbered queue chat instance");
		}
		expect(screen.getByTestId("queue-texts").textContent).toBe("2|3|4|5|6|7|8|9|0");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:0:/);

		for (let expectedRequestCount = 2; expectedRequestCount <= 9; expectedRequestCount += 1) {
			fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
			fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

			await waitFor(() => {
				expect(chat.sendMessage).toHaveBeenCalledTimes(expectedRequestCount);
			});
		}

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(9);
		expect(screen.getByTestId("queue-texts").textContent).toBe("0");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:0:/);

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(10);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const sentTexts = chat.sendMessage.mock.calls.map((call) => {
			const message = call[0] as ai_chat_AiSdk5UiMessage;
			return message.parts.find((part) => part.type === "text")?.text;
		});
		expect(sentTexts).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("keeps a queued edit blocked after the active request rejects", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_edit_failure">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit first queued message probe" }));
		fireEvent.click(screen.getByRole("button", { name: "change queued edit probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_edit_failure");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected failed queue edit chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "reject request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second edited|Third");
		expect(screen.getByTestId("queue-edit").textContent).toBe("null");

		fireEvent.click(screen.getByRole("button", { name: "retry failed queue message probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		});
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second edited|Third");
		const retriedMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(retriedMessage?.parts).toContainEqual({ type: "text", text: "First" });

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		const editedMessage = chat.sendMessage.mock.calls[2]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(editedMessage?.parts).toContainEqual({ type: "text", text: "Second edited" });
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("keeps a resumed queue blocked until the open edit is saved", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_edit_resume">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist response before settle queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "stop queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit first queued message probe" }));
		fireEvent.click(screen.getByRole("button", { name: "change queued edit probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_edit_resume");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected resumed queue edit chat instance");
		}

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		const sentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.parts).toContainEqual({ type: "text", text: "Second edited" });
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("runs reordered queued messages in the new order", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_reorder">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fourth queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "start queued reorder probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_reorder");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected queue reorder chat instance");
		}
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third|Fourth");
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third|Fourth");

		fireEvent.click(screen.getByRole("button", { name: "move last queued message first probe" }));
		fireEvent.click(screen.getByRole("button", { name: "finish queued reorder probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		});
		const sentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.parts).toContainEqual({ type: "text", text: "Fourth" });
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("waits for both request settlement and the matching Convex assistant", async () => {
		hookMocks.holdChatRequests = true;
		const view = render(
			<FullPageSurface initialSelectedThreadId="thread_queue_convex_barriers">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_convex_barriers");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected Convex barrier queue chat instance");
		}

		const firstUserMessage = chat.messages.at(0) as ai_chat_AiSdk5UiMessage | undefined;
		expect(firstUserMessage?.role).toBe("user");
		if (!firstUserMessage || firstUserMessage.role !== "user") {
			throw new Error("Expected the first user message");
		}
		const firstAssistantMessage: ai_chat_AiSdk5UiMessage = {
			id: `assistant_${firstUserMessage.id}`,
			role: "assistant",
			parts: [{ type: "text", text: "Done" }],
			metadata: {
				convexParentId: null,
				parentClientGeneratedId: firstUserMessage.id,
			},
		};
		chat.messages.push(firstAssistantMessage);
		chat.status = "ready";

		hookMocks.threadMessages = [
			createPersistedMessage({
				id: "convex_first_assistant",
				parentId: "convex_first_user",
				clientGeneratedMessageId: firstAssistantMessage.id,
				content: firstAssistantMessage,
			}),
			createPersistedMessage({
				id: "convex_first_user",
				clientGeneratedMessageId: firstUserMessage.id,
				content: firstUserMessage,
			}),
		];
		view.rerender(
			<FullPageSurface initialSelectedThreadId="thread_queue_convex_barriers">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(firstAssistantMessage.metadata?.convexId).toBe("convex_first_assistant");
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(chat.activeRequestCount).toBe(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		const secondSentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondSentMessage?.metadata?.convexParentId).toBe("convex_first_assistant");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);

		const secondUserMessage = chat.messages.at(-1) as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondUserMessage?.role).toBe("user");
		if (!secondUserMessage || secondUserMessage.role !== "user") {
			throw new Error("Expected the second user message");
		}
		const secondAssistantMessage: ai_chat_AiSdk5UiMessage = {
			id: `assistant_${secondUserMessage.id}`,
			role: "assistant",
			parts: [{ type: "text", text: "Done again" }],
			metadata: {
				convexParentId: null,
				parentClientGeneratedId: secondUserMessage.id,
			},
		};
		chat.messages.push(secondAssistantMessage);
		chat.status = "ready";

		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third");

		hookMocks.threadMessages = [
			createPersistedMessage({
				id: "convex_second_assistant",
				parentId: "convex_second_user",
				clientGeneratedMessageId: secondAssistantMessage.id,
				content: secondAssistantMessage,
			}),
			createPersistedMessage({
				id: "convex_second_user",
				parentId: "convex_first_assistant",
				clientGeneratedMessageId: secondUserMessage.id,
				content: secondUserMessage,
			}),
			createPersistedMessage({
				id: "convex_first_assistant",
				parentId: "convex_first_user",
				clientGeneratedMessageId: firstAssistantMessage.id,
				content: firstAssistantMessage,
			}),
			createPersistedMessage({
				id: "convex_first_user",
				clientGeneratedMessageId: firstUserMessage.id,
				content: firstUserMessage,
			}),
		];
		view.rerender(
			<FullPageSurface initialSelectedThreadId="thread_queue_convex_barriers">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const thirdSentMessage = chat.sendMessage.mock.calls[2]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(thirdSentMessage?.metadata?.convexParentId).toBe("convex_second_assistant");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("pauses FIFO processing after a request rejects and retries before resuming", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_rejection">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_rejection");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected rejected-request queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "reject request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");
		expect(chat.pendingRequestResolvers).toHaveLength(0);
		expect(chat.maxActiveRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		});
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);
		const retriedMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(retriedMessage?.parts).toContainEqual({ type: "text", text: "First" });

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third");
		});
		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(4);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const sentTexts = chat.sendMessage.mock.calls.map((call) => {
			const message = call[0] as ai_chat_AiSdk5UiMessage;
			return message.parts.find((part) => part.type === "text")?.text;
		});
		expect(sentTexts).toEqual(["First", "First", "Second", "Third"]);
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("pauses behind a failed queued follower and retries it from the prior assistant", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_follower_rejection">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fourth queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_follower_rejection");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected follower-rejection queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");
		});
		const secondSentMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondSentMessage?.metadata?.convexParentId).toBe("convex_assistant_ai_message_mock_0");

		fireEvent.click(screen.getByRole("button", { name: "reject request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("Second");
		expect(chat.pendingRequestResolvers).toHaveLength(0);
		expect(chat.maxActiveRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		});
		const retriedMessage = chat.sendMessage.mock.calls[2]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(retriedMessage?.parts).toContainEqual({ type: "text", text: "Second" });
		expect(retriedMessage?.metadata?.convexParentId).toBe("convex_assistant_ai_message_mock_0");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "reject request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(3);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("Second");

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(4);
			expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		});
		const secondRetry = chat.sendMessage.mock.calls[3]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(secondRetry?.parts).toContainEqual({ type: "text", text: "Second" });
		expect(secondRetry?.metadata?.convexParentId).toBe("convex_assistant_ai_message_mock_0");

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(5);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Fourth");
		});
		const nextMessage = chat.sendMessage.mock.calls[4]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(nextMessage?.parts).toContainEqual({ type: "text", text: "Third" });
	});

	test("removes a middle follower without changing the remaining FIFO order", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_remove_middle">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fourth queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "remove second queued message probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_remove_middle");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected remove-middle queue chat instance");
		}
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Fourth");
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(chat.activeRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Fourth");
		});

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		const sentTexts = chat.sendMessage.mock.calls.map((call) => {
			const message = call[0] as ai_chat_AiSdk5UiMessage;
			return message.parts.find((part) => part.type === "text")?.text;
		});
		expect(sentTexts).toEqual(["First", "Second", "Fourth"]);
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("removing the final paused follower also clears the paused state", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_remove_paused">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_remove_paused");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected remove-paused queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "stop queue probe" }));

		await waitFor(() => {
			expect(
				AiChatController.useStore.getState().threadById.get("thread_queue_remove_paused")?.activeRequestToken,
			).toBeNull();
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(chat.activeRequestCount).toBe(0);

		fireEvent.click(screen.getByRole("button", { name: "remove first queued message probe" }));

		expect(screen.getByTestId("queue-texts").textContent).toBe("");
		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		expect(chat.sendMessage).toHaveBeenCalledOnce();
	});

	test("pauses queued messages after an error and keeps the failed user visible", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_error">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_error");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected error queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "fail request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-message").textContent).toBe("ai_message_mock_0");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");
		expect(chat.error?.message).toBe("send failed");

		const sentTexts = chat.messages
			.filter((message): message is ai_chat_AiSdk5UiMessage => {
				return typeof message === "object" && message !== null && "role" in message && message.role === "user";
			})
			.map((message) => message.parts.find((part) => part.type === "text")?.text);
		expect(sentTexts).toEqual(["First"]);
	});

	test("pauses queued messages when a new optimistic thread fails before persistence", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface>
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new queue probe" }));
		await waitFor(() => {
			expect(screen.getByTestId("queue-selected").textContent).toMatch(/^ai_thread-/);
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const optimisticThreadId = screen.getByTestId("queue-selected").textContent;
		const chat = hookMocks.chatInstances.find((item) => item.id === optimisticThreadId);
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected optimistic error queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "fail request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");

		const sentTexts = chat.messages
			.filter((message): message is ai_chat_AiSdk5UiMessage => {
				return typeof message === "object" && message !== null && "role" in message && message.role === "user";
			})
			.map((message) => message.parts.find((part) => part.type === "text")?.text);
		expect(sentTexts).toEqual(["First"]);
	});

	test("pauses queued messages after an error with an assistant placeholder", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_error_placeholder">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_error_placeholder");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected placeholder error queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "fail request after assistant placeholder queue probe" }));

		expect(screen.getByTestId("queue-failed-message").textContent).toBe("ai_message_mock_0");
		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");

		const sentTexts = chat.messages
			.filter((message): message is ai_chat_AiSdk5UiMessage => {
				return typeof message === "object" && message !== null && "role" in message && message.role === "user";
			})
			.map((message) => message.parts.find((part) => part.type === "text")?.text);
		expect(sentTexts).toEqual(["First"]);
	});

	test("pauses the queue when Convex persists the failed user before the stream error", async () => {
		hookMocks.holdChatRequests = true;
		const view = render(
			<FullPageSurface initialSelectedThreadId="thread_queue_persisted_user_error">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_persisted_user_error");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected persisted-user error queue chat instance");
		}

		const firstUserMessage = chat.messages.find(
			(message): message is ai_chat_AiSdk5UiMessage =>
				typeof message === "object" && message !== null && "role" in message && message.role === "user",
		);
		expect(firstUserMessage).toBeDefined();
		if (!firstUserMessage) {
			throw new Error("Expected the first queued-test user message");
		}

		hookMocks.threadMessages = [
			createPersistedMessage({
				id: "convex_failed_user",
				clientGeneratedMessageId: firstUserMessage.id,
				content: firstUserMessage,
			}),
		];
		view.rerender(
			<FullPageSurface initialSelectedThreadId="thread_queue_persisted_user_error">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(firstUserMessage.metadata?.convexId).toBe("convex_failed_user");
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(chat.activeRequestCount).toBe(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");

		fireEvent.click(screen.getByRole("button", { name: "fail request after assistant placeholder queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-failed-message").textContent).toBe("convex_failed_user");
		expect(screen.getByTestId("queue-failed-text").textContent).toBe("First");
		expect(chat.pendingRequestResolvers).toHaveLength(0);
		expect(chat.maxActiveRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		});
		const retriedMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(retriedMessage?.parts).toContainEqual({ type: "text", text: "First" });
		expect(retriedMessage?.metadata?.convexParentId).toBeNull();
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second|Third");
	});

	test("keeps the model and mode selected when a message was queued", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_settings">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "select nano agent queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "select mini ask queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_settings");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected queue settings chat instance");
		}
		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		});

		const queuedMessage = chat.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(queuedMessage?.metadata?.selectedModelId).toBe("gpt-5.4-nano");
		expect(queuedMessage?.metadata?.selectedModeId).toBe("agent");
	});

	test("limits the queue to ten messages and stop pauses it until resume", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_limit">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "fill queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_limit");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected queue chat instance");
		}
		expect(screen.getByTestId("queue-texts").textContent?.split("|")).toHaveLength(10);
		expect(screen.getByTestId("queue-full").textContent).toBe("yes");

		fireEvent.click(screen.getByRole("button", { name: "stop queue probe" }));

		expect(screen.getByTestId("queue-texts").textContent?.split("|")).toHaveLength(10);
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(chat.stop).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole("button", { name: "persist response before settle queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(
				AiChatController.useStore.getState().threadById.get("thread_queue_limit")?.activeRequestToken,
			).toBeNull();
		});
		expect(chat.error).toBeUndefined();
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent?.split("|")).toHaveLength(10);

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent?.split("|")).toHaveLength(9);
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
	});

	test("Stop pauses a follower queued before the active request settles", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_stop_latch">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "stop and queue follower probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_stop_latch");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected Stop latch queue chat instance");
		}

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");

		fireEvent.click(
			screen.getByRole("button", { name: "settle stopped request with empty assistant queue probe" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
	});

	test("Stop pauses after a queued follower starts and Resume continues once", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_stop_follower">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send fourth queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_stop_follower");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected stopped-follower queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");
		});
		expect(chat.activeRequestCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "stop queue probe" }));

		expect(chat.stop).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");

		fireEvent.click(screen.getByRole("button", { name: "persist response before settle queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "settle request queue probe" }));

		await waitFor(() => {
			expect(chat.activeRequestCount).toBe(0);
		});
		expect(chat.sendMessage).toHaveBeenCalledTimes(2);
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Fourth");

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(3);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Fourth");
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
		expect(chat.activeRequestCount).toBe(1);
		expect(chat.pendingRequestResolvers).toHaveLength(1);
		expect(chat.maxActiveRequestCount).toBe(1);
	});

	test("resumes after Stop leaves an empty client-only assistant", async () => {
		hookMocks.holdChatRequests = true;
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_stopped_empty_assistant">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_stopped_empty_assistant");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected stopped queue chat instance");
		}

		fireEvent.click(screen.getByRole("button", { name: "stop queue probe" }));
		fireEvent.click(
			screen.getByRole("button", { name: "settle stopped request with empty assistant queue probe" }),
		);

		await waitFor(() => {
			expect(
				AiChatController.useStore.getState().threadById.get("thread_queue_stopped_empty_assistant")
					?.activeRequestToken,
			).toBeNull();
		});
		expect(chat.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(screen.getByTestId("queue-paused").textContent).toBe("yes");

		fireEvent.click(screen.getByRole("button", { name: "resume queue probe" }));

		await waitFor(() => {
			expect(chat.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("");
		});
		expect(screen.getByTestId("queue-paused").textContent).toBe("no");
	});

	test("keeps queued work when archive fails", async () => {
		hookMocks.holdChatRequests = true;
		hookMocks.mutation.mockResolvedValueOnce({ _nay: { code: "ArchiveFailed" } });
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		render(
			<FullPageSurface initialSelectedThreadId="thread_queue_archive_failure">
				<RuntimeQueueProbe />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-session").textContent).toBe("session");
		});
		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));

		const chat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_archive_failure");
		expect(chat).toBeDefined();
		if (!chat) {
			throw new Error("Expected archive failure chat instance");
		}
		fireEvent.click(screen.getByRole("button", { name: "archive queue probe" }));

		await waitFor(() => {
			expect(hookMocks.mutation).toHaveBeenCalled();
			expect(AiChatController.useStore.getState().threadById.get("thread_queue_archive_failure")?.isArchivePending).toBe(
				false,
			);
		});
		expect(screen.getByTestId("queue-texts").textContent).toBe("Second");
		expect(chat.stop).not.toHaveBeenCalled();
	});

	test("keeps queue order and an open edit when an optimistic thread gets its persisted id", async () => {
		hookMocks.holdChatRequests = true;
		const view = render(
			<FullPageSurface>
				<RuntimeQueueProbe />
				<ControllerProbe label="queue-list" />
			</FullPageSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new queue probe" }));
		await waitFor(() => {
			expect(screen.getByTestId("queue-selected").textContent).toMatch(/^ai_thread-/);
		});
		const optimisticThreadId = screen.getByTestId("queue-selected").textContent;
		if (!optimisticThreadId) {
			throw new Error("Expected optimistic queue thread id");
		}

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit first queued message probe" }));
		fireEvent.click(screen.getByRole("button", { name: "change queued edit probe" }));
		fireEvent.click(screen.getByRole("button", { name: "move last queued message first probe" }));
		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));

		await waitFor(() => {
			expect(
				AiChatController.useStore.getState().threadById.get(optimisticThreadId)?.activeRequestToken,
			).toBeNull();
		});
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);

		hookMocks.threads = [
			createThread({
				id: "thread_queue_upgraded_after_settle",
				clientGeneratedId: optimisticThreadId,
			}),
		];
		view.rerender(
			<FullPageSurface>
				<RuntimeQueueProbe />
				<ControllerProbe label="queue-list" />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-selected").textContent).toBe("thread_queue_upgraded_after_settle");
		});
		expect(
			AiChatController.useStore.getState().threadById.get("thread_queue_upgraded_after_settle")?.activeRequestToken,
		).toBeNull();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);

		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(screen.getByTestId("queue-texts").textContent).toBe("Second edited");
		});
		const upgradedChat = hookMocks.chatInstances.find(
			(item) => item.id === "thread_queue_upgraded_after_settle",
		);
		expect(upgradedChat?.sendMessage).toHaveBeenCalledTimes(2);
		const sentMessage = upgradedChat?.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.parts).toContainEqual({ type: "text", text: "Third" });
	});

	test("moves the active request and queue once across mounted surfaces", async () => {
		hookMocks.holdChatRequests = true;
		const view = render(
			<>
				<FullPageSurface>
					<RuntimeQueueProbe />
					<ControllerProbe label="queue-list" />
				</FullPageSurface>
				<SidebarSurface>
					<ControllerProbe label="queue-mirror" />
				</SidebarSurface>
			</>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new queue probe" }));
		await waitFor(() => {
			expect(screen.getByTestId("queue-selected").textContent).toMatch(/^ai_thread-/);
		});
		const optimisticThreadId = screen.getByTestId("queue-selected").textContent;
		if (!optimisticThreadId) {
			throw new Error("Expected optimistic queue thread id");
		}

		fireEvent.click(screen.getByRole("button", { name: "send first queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send second queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "send third queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "edit first queued message probe" }));
		fireEvent.click(screen.getByRole("button", { name: "change queued edit probe" }));
		fireEvent.click(screen.getByRole("button", { name: "move last queued message first probe" }));
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);

		hookMocks.threads = [
			createThread({
				id: "thread_queue_upgraded",
				clientGeneratedId: optimisticThreadId,
			}),
		];
		view.rerender(
			<>
				<FullPageSurface>
					<RuntimeQueueProbe />
					<ControllerProbe label="queue-list" />
				</FullPageSurface>
				<SidebarSurface>
					<ControllerProbe label="queue-mirror" />
				</SidebarSurface>
			</>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("queue-selected").textContent).toBe("thread_queue_upgraded");
		});
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");
		expect(screen.getByTestId("queue-edit").textContent).toMatch(/:Second edited:/);

		const upgradedSession = AiChatController.useStore.getState().threadById.get("thread_queue_upgraded");
		expect(upgradedSession?.activeRequestToken).not.toBeNull();
		expect(upgradedSession?.chat?.id).toBe("thread_queue_upgraded");
		expect(AiChatController.useStore.getState().threadById.has(optimisticThreadId)).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "complete client response queue probe" }));
		fireEvent.click(screen.getByRole("button", { name: "persist assistant queue probe" }));

		expect(upgradedSession?.chat?.sendMessage).toHaveBeenCalledOnce();
		expect(screen.getByTestId("queue-texts").textContent).toBe("Third|Second");

		fireEvent.click(screen.getByRole("button", { name: "save queued edit probe" }));

		await waitFor(() => {
			expect(upgradedSession?.chat?.sendMessage).toHaveBeenCalledTimes(2);
			expect(screen.getByTestId("queue-texts").textContent).toBe("Second edited");
		});
		const upgradedChat = hookMocks.chatInstances.find((item) => item.id === "thread_queue_upgraded");
		const sentMessage = upgradedChat?.sendMessage.mock.calls[1]?.[0] as ai_chat_AiSdk5UiMessage | undefined;
		expect(sentMessage?.parts).toContainEqual({ type: "text", text: "Third" });
	});

	test("optimistic-id upgrade replaces selected optimistic id and persists only the persisted id", async () => {
		const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;
		let optimisticThreadId: string | null = null;

		const view = render(
			<FullPageSurface>
				<ControllerProbe label="full" onStartNewChat={(threadId) => (optimisticThreadId = threadId)} />
			</FullPageSurface>,
		);

		fireEvent.click(screen.getByRole("button", { name: "new full" }));

		expect(optimisticThreadId).not.toBeNull();
		expect(screen.getByTestId("full-selected").textContent).toBe(optimisticThreadId);
		expect(app_local_storage_get_value(storageKey)).toBeNull();

		hookMocks.threads = [
			createThread({
				id: "thread_persisted_upgrade",
				clientGeneratedId: optimisticThreadId,
			}),
		];

		view.rerender(
			<FullPageSurface>
				<ControllerProbe label="full" onStartNewChat={(threadId) => (optimisticThreadId = threadId)} />
			</FullPageSurface>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("full-selected").textContent).toBe("thread_persisted_upgrade");
		});
		expect(app_local_storage_get_value(storageKey)).toBe("thread_persisted_upgrade");
	});
});
