import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_AiSdk5UiMessage, ai_chat_Thread } from "@/lib/ai-chat.ts";

type MockChatInstance = {
	id: string;
	messages: unknown[];
	error: Error | undefined;
	transport: MockTransport | undefined;
	sendMessage: ReturnType<typeof vi.fn>;
};

type MockPrepareSendMessagesRequestOptions = {
	api: string;
	body: Record<string, unknown>;
	headers: Headers;
	id: string;
	messages: Array<{
		metadata?: {
			convexParentId?: string | null;
		};
	}>;
	trigger: "submit-message" | "regenerate-message";
};

type MockTransport = {
	options: {
		prepareSendMessagesRequest?: (options: MockPrepareSendMessagesRequestOptions) => unknown;
	};
};

const hookMocks = vi.hoisted(() => {
	return {
		tenant: {
			membershipId: "membership_test",
			workspaceId: "workspace_test",
			projectId: "project_test",
		},
		threads: [] as Array<{ archived: boolean; [key: string]: unknown }>,
		threadMessages: [] as Array<{
			_id: string;
			parentId: string | null;
			clientGeneratedMessageId?: string | null;
			content: ai_chat_AiSdk5UiMessage;
		}>,
		mutation: vi.fn(() => Promise.resolve({ _yay: { threadId: "thread_branch" } })),
		renderSelectedThreadId: vi.fn(),
		chatInstances: [] as MockChatInstance[],
	};
});

vi.mock("@ai-sdk/react", () => {
	class MockChat implements MockChatInstance {
		id: string;
		messages: unknown[];
		status = "ready";
		error: Error | undefined;
		transport: MockTransport | undefined;
		nextMessageIndex = 0;
		sendMessage = vi.fn((message: unknown, _options?: unknown) => {
			const nextMessage =
				typeof message === "object" && message !== null && !("id" in message)
					? { id: `ai_message_mock_${this.nextMessageIndex}`, ...message }
					: message;

			this.nextMessageIndex += 1;
			this.messages.push(nextMessage);
			return Promise.resolve();
		});
		regenerate = vi.fn(() => Promise.resolve());
		stop = vi.fn(() => Promise.resolve());
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
		lastAssistantMessageIsCompleteWithToolCalls: vi.fn(() => false),
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
		workspaceId: hookMocks.tenant.workspaceId,
		projectId: hookMocks.tenant.projectId,
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

function RuntimeSendProbe() {
	const [, forceRender] = useState(0);
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const selectedChat = controller.session?.chat as MockChatInstance | null | undefined;
	const latestMessage = controller.activeBranchMessages.list.at(-1);
	const failedSendUserMessageId = AiChatController.useStore((state) =>
		selectedThreadId ? (state.failedSendUserMessageIdByThreadId.get(selectedThreadId) ?? null) : null,
	);

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
					if (!selectedThreadId || !latestMessage) {
						return;
					}

					controller.sendUserText(selectedThreadId, "Retry me", { messageId: latestMessage.id });
					forceRender((value) => value + 1);
				}}
			>
				retry latest
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

function FullPageSurface(props: { children: ReactNode }) {
	const storageKey: `app_state::ai_chat_last_open::scope::${string}` = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;

	return (
		<AiChatController key={storageKey} storageKey={storageKey}>
			{props.children}
		</AiChatController>
	);
}

describe("AiChatController", () => {
	beforeEach(() => {
		hookMocks.tenant.membershipId = `membership_${crypto.randomUUID()}`;
		hookMocks.tenant.workspaceId = "workspace_test";
		hookMocks.tenant.projectId = "project_test";
		hookMocks.threads = [];
		hookMocks.threadMessages = [];
		hookMocks.chatInstances = [];
		hookMocks.mutation.mockClear();
		hookMocks.renderSelectedThreadId.mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
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
					metadata: {
						convexParentId: null,
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
		});
		expect(body.threadId).toBeUndefined();
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
