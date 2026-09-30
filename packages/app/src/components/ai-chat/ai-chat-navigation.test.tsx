import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";

import type { ai_chat_Thread } from "@/lib/ai-chat.ts";
import type { AiChatThreads_Props } from "./ai-chat-threads.tsx";

const queryMocks = vi.hoisted(() => ({
	tenant: {
		membershipId: "membership_navigation",
		organizationId: "organization_navigation",
		workspaceId: "workspace_navigation",
	},
	threads: [] as ai_chat_Thread[],
	loadingThreadIds: new Set<string>(),
	listeners: new Set<() => void>(),
	branchPage: { nodes: [], nextId: null },
	jobs: [],
	mutation: vi.fn(() => Promise.resolve({ _yay: null })),
}));

// Keep selection and sessions real. Only the network and leaf UI are mocked.
vi.mock("convex/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/react")>()),
	useQuery: (query: Parameters<typeof getFunctionName>[0], args: { threadId: string } | "skip") => {
		const threads = useSyncExternalStore(
			(listener) => {
				queryMocks.listeners.add(listener);
				return () => queryMocks.listeners.delete(listener);
			},
			() => queryMocks.threads,
		);
		if (args === "skip") {
			return undefined;
		}
		switch (getFunctionName(query)) {
			case "ai_chat:thread_get":
				return queryMocks.loadingThreadIds.has(args.threadId)
					? undefined
					: (threads.find((thread) => thread._id === args.threadId) ?? null);
			case "ai_chat_runs:branch_page":
				return queryMocks.branchPage;
			default:
				return queryMocks.jobs;
		}
	},
	usePaginatedQuery: (_query: unknown, args: { archived: boolean } | "skip") => {
		const threads = useSyncExternalStore(
			(listener) => {
				queryMocks.listeners.add(listener);
				return () => queryMocks.listeners.delete(listener);
			},
			() => queryMocks.threads,
		);
		return {
			results: args === "skip" ? [] : threads.filter((thread) => thread.archived === args.archived),
			status: "Exhausted",
			loadMore: vi.fn(),
		};
	},
	useMutation: () => queryMocks.mutation,
	useAction: () => queryMocks.mutation,
	// These tests never load older pages of a branch.
	useQueries: () => ({}),
}));

vi.mock("@/components/app-auth.tsx", () => ({
	AppAuthProvider: { getToken: () => Promise.resolve(null) },
}));

vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: { useContext: () => queryMocks.tenant },
}));

vi.mock("./ai-chat-threads.tsx", () => ({
	AiChatThreads: function AiChatThreads(props: AiChatThreads_Props) {
		return (
			<div>
				<div data-testid="selected-thread">{props.selectedThreadId ?? "none"}</div>
				<button type="button" onClick={props.onNewChat}>
					New Chat
				</button>
				{props.paginatedThreads.unarchived.results.map((thread) => (
					<button key={thread._id} type="button" onClick={() => props.onSelectThread(thread._id)}>
						{thread.title ?? thread._id}
					</button>
				))}
				<button
					type="button"
					onClick={() => props.selectedThreadId && props.onArchiveThread(props.selectedThreadId, true)}
				>
					Archive selected chat
				</button>
			</div>
		);
	},
}));

vi.mock("./ai-chat-composer.tsx", () => ({
	AiChatComposer: () => <div />,
}));

vi.mock("./ai-chat-message.tsx", () => ({
	AiChatMessage: () => <div />,
	AiChatMessagePendingAssistant: () => <div />,
}));

vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({
	MainAppSidebarToggle: () => <div />,
}));

vi.mock("@tanstack/react-router", () => ({
	CatchBoundary: (props: { children?: ReactNode }) => <>{props.children}</>,
}));

vi.mock("@/lib/ui.tsx", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ui.tsx")>()),
	useUiStickToBottom: () => ({ isAtBottom: true, scrollToBottom: vi.fn() }),
}));

import { AiChat, type AiChat_UrlQuery } from "./ai-chat.tsx";
import { app_local_storage_set_value } from "@/lib/storage.ts";

function createThread(id: string, clientGeneratedId: string | null = null) {
	return {
		_id: id,
		_creationTime: 1,
		organizationId: queryMocks.tenant.organizationId,
		workspaceId: queryMocks.tenant.workspaceId,
		clientGeneratedId,
		title: id,
		archived: false,
		starred: false,
		runtime: "aisdk_5",
		createdBy: "user_navigation",
		updatedBy: "user_navigation",
		updatedAt: 1,
		lastMessageAt: 1,
		newestNodeId: null,
	} as ai_chat_Thread;
}

beforeEach(() => {
	queryMocks.tenant.membershipId = `membership_${crypto.randomUUID()}`;
	queryMocks.threads = [createThread("thread_first"), createThread("thread_second")];
	queryMocks.loadingThreadIds.clear();
	queryMocks.mutation.mockClear();
});

afterEach(() => {
	cleanup();
	queryMocks.listeners.clear();
});

describe("AiChat URL selection", () => {
	test("keeps a new chat selected while the URL still holds the old thread", () => {
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
		const newThreadId = onUrlQueryChange.mock.calls[0]?.[0].threadId;

		expect(newThreadId).toMatch(/^ai_thread-/);
		expect(screen.getByTestId("selected-thread").textContent).toBe(newThreadId);
		expect(onUrlQueryChange.mock.calls.every(([query]) => query.threadId === newThreadId)).toBe(true);

		view.rerender(<AiChat urlQuery={{ threadId: newThreadId }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe(newThreadId);
		fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
		const nextThreadId = onUrlQueryChange.mock.lastCall?.[0].threadId;
		expect(nextThreadId).not.toBe(newThreadId);
		expect(screen.getByTestId("selected-thread").textContent).toBe(nextThreadId);
	});

	test("keeps a selected existing chat while navigation is pending", () => {
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		fireEvent.click(screen.getByRole("button", { name: "thread_second" }));

		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_second");
		expect(onUrlQueryChange.mock.calls.every(([query]) => query.threadId === "thread_second")).toBe(true);
		view.rerender(<AiChat urlQuery={{ threadId: "thread_second" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_second");
	});

	test("lets New Chat replace a URL thread whose query is still loading", () => {
		queryMocks.loadingThreadIds.add("thread_first");
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
		const newThreadId = onUrlQueryChange.mock.lastCall?.[0].threadId;
		expect(newThreadId).toMatch(/^ai_thread-/);
		expect(screen.getByTestId("selected-thread").textContent).toBe(newThreadId);
	});

	test("applies Back and Forward URLs without navigating back to the old selection", () => {
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		view.rerender(<AiChat urlQuery={{ threadId: "thread_second" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_second");
		view.rerender(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_first");
		expect(onUrlQueryChange).not.toHaveBeenCalled();
	});

	test("waits for a URL thread to load before changing selection or writing the URL", () => {
		queryMocks.loadingThreadIds.add("thread_second");
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		view.rerender(<AiChat urlQuery={{ threadId: "thread_second" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_first");
		expect(onUrlQueryChange).not.toHaveBeenCalled();

		act(() => {
			queryMocks.loadingThreadIds.clear();
			queryMocks.threads = [...queryMocks.threads];
			queryMocks.listeners.forEach((listener) => listener());
		});
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_second");
		expect(onUrlQueryChange).not.toHaveBeenCalled();
	});

	test("writes the saved thread id after an optimistic chat is persisted", () => {
		const optimisticThreadId = "ai_thread-new";
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: optimisticThreadId }} onUrlQueryChange={onUrlQueryChange} />);
		act(() => {
			queryMocks.threads = [createThread("thread_saved", optimisticThreadId), ...queryMocks.threads];
			queryMocks.listeners.forEach((listener) => listener());
		});

		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_saved");
		expect(onUrlQueryChange).toHaveBeenCalledWith({ threadId: "thread_saved" });
		expect(onUrlQueryChange.mock.calls.every(([query]) => query.threadId === "thread_saved")).toBe(true);
		view.rerender(<AiChat urlQuery={{ threadId: "thread_saved" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_saved");
	});

	test("does not return to a saved chat when the user starts another chat", () => {
		const optimisticThreadId = "ai_thread-old";
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		render(<AiChat urlQuery={{ threadId: optimisticThreadId }} onUrlQueryChange={onUrlQueryChange} />);
		fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
		const newThreadId = onUrlQueryChange.mock.lastCall?.[0].threadId;
		act(() => {
			queryMocks.threads = [createThread("thread_saved", optimisticThreadId), ...queryMocks.threads];
			queryMocks.listeners.forEach((listener) => listener());
		});
		expect(screen.getByTestId("selected-thread").textContent).toBe(newThreadId);
		expect(onUrlQueryChange.mock.calls.every(([query]) => query.threadId === newThreadId)).toBe(true);
	});

	test("clears the URL after archiving the selected chat", async () => {
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		render(<AiChat urlQuery={{ threadId: "thread_first" }} onUrlQueryChange={onUrlQueryChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Archive selected chat" }));
		await waitFor(() => {
			expect(screen.getByTestId("selected-thread").textContent).toBe("none");
		});
		expect(onUrlQueryChange).toHaveBeenCalledWith({ threadId: undefined });
	});

	test("clears an unavailable URL and keeps the fallback chat selected", () => {
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		const view = render(<AiChat urlQuery={{ threadId: "thread_missing" }} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_first");
		expect(onUrlQueryChange).toHaveBeenCalledWith({ threadId: undefined });
		onUrlQueryChange.mockClear();
		view.rerender(<AiChat urlQuery={{}} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_first");
		expect(onUrlQueryChange).not.toHaveBeenCalled();
	});

	test("restores the stored selection when the URL has no thread", () => {
		app_local_storage_set_value(
			`app_state::ai_chat_last_open::scope::${queryMocks.tenant.membershipId}`,
			"thread_second",
		);
		const onUrlQueryChange = vi.fn<(query: AiChat_UrlQuery) => void>();
		render(<AiChat urlQuery={{}} onUrlQueryChange={onUrlQueryChange} />);
		expect(screen.getByTestId("selected-thread").textContent).toBe("thread_second");
		expect(onUrlQueryChange).toHaveBeenCalledWith({ threadId: "thread_second" });
	});
});
