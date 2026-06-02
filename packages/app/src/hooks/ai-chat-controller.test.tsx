import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_Thread } from "@/lib/ai-chat.ts";

const hookMocks = vi.hoisted(() => {
	return {
		tenant: {
			membershipId: "membership_test",
			workspaceId: "workspace_test",
			projectId: "project_test",
		},
		threads: [] as Array<{ archived: boolean; [key: string]: unknown }>,
		mutation: vi.fn(() => Promise.resolve({ _yay: { threadId: "thread_branch" } })),
		renderSelectedThreadId: vi.fn(),
	};
});

vi.mock("@ai-sdk/react", () => {
	class MockChat {
		id: string;
		messages: unknown[];
		status = "ready";
		error: Error | undefined;
		sendMessage = vi.fn((message: unknown) => {
			this.messages.push(message);
			return Promise.resolve();
		});
		regenerate = vi.fn(() => Promise.resolve());
		stop = vi.fn(() => Promise.resolve());
		resumeStream = vi.fn();
		addToolOutput = vi.fn();
		setMessages = vi.fn((messages: unknown[]) => {
			this.messages = messages;
		});

		constructor(args: { id?: string | null; messages?: unknown[] }) {
			this.id = args.id ?? "mock_chat";
			this.messages = args.messages ?? [];
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
		useQuery: () => ({ messages: [] }),
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
