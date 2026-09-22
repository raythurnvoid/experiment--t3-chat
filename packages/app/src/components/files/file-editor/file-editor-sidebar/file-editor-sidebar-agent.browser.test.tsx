import "@/app.css";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { ai_chat_Thread } from "@/lib/ai-chat.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";

// Keep the real sidebar, controller, AI SDK transport, composer, and tabs.
// Only auth, routing links, and the Convex/HTTP boundaries are simulated.
const mocks = vi.hoisted(() => ({
	tenant: {
		membershipId: "membership_test",
		organizationId: "organization_test",
		workspaceId: "workspace_test",
		organizationName: "personal",
		workspaceName: "home",
	},
	threads: [] as ai_chat_Thread[],
	listeners: new Set<() => void>(),
	requestBodies: [] as Array<{ clientGeneratedThreadId: string }>,
	threadMessages: { messages: [] },
	messageStatusByThreadId: {} as Record<string, "loaded" | "loading" | "denied">,
	mutation: vi.fn(() => Promise.resolve({ _yay: {} })),
}));

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();
	const { useSyncExternalStore } = await import("react");
	return {
		...actual,
		usePaginatedQuery: (_query: unknown, args: { archived?: boolean } | "skip") => {
			const threads = useSyncExternalStore(
				(listener) => {
					mocks.listeners.add(listener);
					return () => mocks.listeners.delete(listener);
				},
				() => mocks.threads,
			);
			return {
				results: args === "skip" ? [] : threads.filter((thread) => thread.archived === args.archived),
				status: "Exhausted",
				loadMore: vi.fn(),
			};
		},
		useMutation: () => mocks.mutation,
		useQuery: (query: FunctionReference<"query">, args: { threadId?: string } | "skip") => {
			const messageStatusByThreadId = useSyncExternalStore(
				(listener) => {
					mocks.listeners.add(listener);
					return () => mocks.listeners.delete(listener);
				},
				() => mocks.messageStatusByThreadId,
			);
			if (args === "skip") return undefined;
			switch (getFunctionName(query)) {
				case "ai_chat:thread_messages_list":
					if (messageStatusByThreadId[args.threadId!] === "denied") return null;
					if (messageStatusByThreadId[args.threadId!] === "loading") return undefined;
					return mocks.threadMessages;
				case "files_pending_updates:get_files_pending_updates_summary":
					return { count: 0, truncated: false };
				default:
					return undefined;
			}
		},
	};
});

vi.mock("@/components/app-auth.tsx", () => ({ AppAuthProvider: { getToken: () => Promise.resolve(null) } }));
vi.mock("@/lib/app-tenant-context.tsx", () => ({ AppTenantProvider: { useContext: () => mocks.tenant } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: (props: { children?: ReactNode; to: string; onClick?: MouseEventHandler<HTMLAnchorElement> }) => (
		<a
			href={props.to}
			onClick={(event) => {
				event.preventDefault();
				props.onClick?.(event);
			}}
		>
			{props.children}
		</a>
	),
}));

import { FileEditorSidebarAgent } from "./file-editor-sidebar-agent.tsx";
import { AiChatController } from "@/hooks/ai-chat-controller.tsx";
import { app_local_storage_get_value, app_local_storage_set_value, storage_listen_event } from "@/lib/storage.ts";

function openSseResponse() {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	return {
		response: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
		write(chunk: Record<string, unknown>) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
		},
		close() {
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	};
}

describe("FileEditorSidebarAgent thread upgrade", () => {
	beforeEach(() => {
		mocks.tenant.membershipId = `membership_${crypto.randomUUID()}`;
		mocks.threads = [];
		mocks.requestBodies = [];
		mocks.messageStatusByThreadId = {};
		mocks.mutation.mockClear();
		app_local_storage_set_value("app_state::files_last_tab", "app_file_editor_sidebar_tabs_agent");
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	test("closes a refused chat without restoring it from sidebar storage and allows access later", async () => {
		const openTabsKey = `app_state::file_editor_sidebar_open_tabs::scope::${mocks.tenant.membershipId}` as const;
		const selectedTabKey =
			`app_state::file_editor_sidebar_agent_selected_tab::scope::${mocks.tenant.membershipId}` as const;
		const tabs = [
			{ id: "thread_left", title: "Left chat" },
			{ id: "thread_private", title: "Private chat" },
			{ id: "thread_right", title: "Right chat" },
		];
		mocks.threads = tabs.map(
			(tab) =>
				({
					_id: tab.id as app_convex_Id<"ai_chat_threads">,
					_creationTime: 1,
					organizationId: mocks.tenant.organizationId,
					workspaceId: mocks.tenant.workspaceId,
					clientGeneratedId: `ai_thread-${tab.id}`,
					title: tab.title,
					archived: false,
					starred: false,
					runtime: "aisdk_5",
					createdBy: "user_test" as app_convex_Id<"users">,
					updatedBy: "user_test" as app_convex_Id<"users">,
					updatedAt: 1,
				}) satisfies ai_chat_Thread,
		);
		app_local_storage_set_value(openTabsKey, tabs);
		app_local_storage_set_value(selectedTabKey, "thread_private");
		render(
			<FileEditorSidebarAgent
				rootTabId="app_file_editor_sidebar_tabs_agent"
				browserNodeId={null}
				browserNodeKind={null}
			/>,
		);
		await userEvent.click(screen.getByRole("tab", { name: "Left chat" }));
		await userEvent.click(await screen.findByRole("textbox", { name: "Send a message..." }));
		await userEvent.keyboard("Keep this draft");
		await userEvent.click(screen.getByRole("tab", { name: "Private chat" }));
		const editor = await screen.findByRole("textbox", { name: "Send a message..." });
		await userEvent.click(editor);
		await userEvent.keyboard("Private unsent draft");

		// Loading must keep the selected tab and its draft.
		act(() => {
			mocks.messageStatusByThreadId = { thread_private: "loading" };
			mocks.listeners.forEach((listener) => listener());
		});
		expect(app_local_storage_get_value(openTabsKey)).toEqual(tabs);
		expect(screen.getByRole("tab", { name: "Private chat", selected: true })).toBeTruthy();
		expect(editor.textContent).toBe("Private unsent draft");

		act(() => {
			mocks.messageStatusByThreadId = { thread_private: "denied" };
			mocks.threads = mocks.threads.map((thread) =>
				thread._id === "thread_right" ? { ...thread, title: "Updated right chat" } : thread,
			);
			mocks.listeners.forEach((listener) => listener());
		});
		await waitFor(() => expect(screen.queryByRole("tab", { name: "Private chat" })).toBeNull());
		expect(app_local_storage_get_value(openTabsKey)).toEqual([
			tabs[0],
			{ id: "thread_right", title: "Updated right chat" },
		]);
		expect(app_local_storage_get_value(selectedTabKey)).toBe("thread_left");
		expect(screen.getByRole("tab", { name: "Left chat", selected: true })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("Keep this draft");
		expect(AiChatController.useStore.actions.getSession("thread_private")).toBeNull();
		await userEvent.click(screen.getByRole("tab", { name: "Updated right chat" }));
		expect(app_local_storage_get_value(selectedTabKey)).toBe("thread_right");

		act(() => {
			mocks.messageStatusByThreadId = {};
			mocks.listeners.forEach((listener) => listener());
		});
		await userEvent.click(screen.getByRole("combobox", { name: "Past chats" }));
		await userEvent.click(await screen.findByRole("option", { name: "Private chat" }));
		await waitFor(() => expect(screen.getByRole("tab", { name: "Private chat", selected: true })).toBeTruthy());
		expect(app_local_storage_get_value(selectedTabKey)).toBe("thread_private");
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("");
		expect(AiChatController.useStore.actions.getSession("thread_private")).not.toBeNull();
	});

	test("replaces the last refused saved tab with a usable new chat", async () => {
		const openTabsKey = `app_state::file_editor_sidebar_open_tabs::scope::${mocks.tenant.membershipId}` as const;
		const selectedTabKey =
			`app_state::file_editor_sidebar_agent_selected_tab::scope::${mocks.tenant.membershipId}` as const;
		app_local_storage_set_value(openTabsKey, [{ id: "thread_private", title: "Private chat" }]);
		app_local_storage_set_value(selectedTabKey, "thread_private");
		mocks.messageStatusByThreadId = { thread_private: "denied" };
		render(
			<FileEditorSidebarAgent
				rootTabId="app_file_editor_sidebar_tabs_agent"
				browserNodeId={null}
				browserNodeKind={null}
			/>,
		);
		await waitFor(() => expect(screen.queryByRole("tab", { name: "Private chat" })).toBeNull());
		const editor = await screen.findByRole("textbox", { name: "Send a message..." });
		await userEvent.click(editor);
		await userEvent.keyboard("New private draft");
		expect(editor.textContent).toBe("New private draft");
		const selectedId = app_local_storage_get_value(selectedTabKey);
		expect(selectedId).toMatch(/^ai_thread-/u);
		expect(app_local_storage_get_value(openTabsKey)).toEqual([{ id: selectedId, title: "New chat" }]);
		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(AiChatController.useStore.actions.getSession("thread_private")).toBeNull();
	});

	test("keeps the composer through persistence and clears its queued edit when access is refused", async () => {
		const stream = openSseResponse();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				mocks.requestBodies.push(JSON.parse(String(init?.body)));
				return stream.response;
			}),
		);
		render(
			<div style={{ width: 480, height: 720 }}>
				<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" browserNodeId={null} browserNodeKind={null} />
			</div>,
		);
		const editor = await screen.findByRole("textbox", { name: "Send a message..." });
		const draftComposer = editor.closest(".AiChatComposer");
		await userEvent.click(editor);
		await userEvent.keyboard("First message{Enter}");
		await waitFor(() => expect(mocks.requestBodies).toHaveLength(1));
		expect(editor.closest(".AiChatComposer")).toBe(draftComposer);
		expect(draftComposer?.isConnected).toBe(true);
		stream.write({ type: "start", messageId: "assistant_live" });
		await userEvent.click(editor);
		await userEvent.keyboard("Queued draft{Enter}");
		await userEvent.click(await screen.findByRole("button", { name: "Edit queued message: Queued draft" }));
		const editComposer = screen.getByRole("textbox", { name: "Edit queued message" }).closest(".AiChatComposer");
		const editTextbox = screen.getByRole("textbox", { name: "Edit queued message" });
		await userEvent.click(editTextbox);
		expect(screen.queryByRole("button", { name: "Instructions and skills" })).toBeNull();

		const optimisticId = mocks.requestBodies[0]!.clientGeneratedThreadId;
		expect(optimisticId).toMatch(/^ai_thread-/u);
		stream.write({ type: "data-thread-id", data: { threadId: "thread_persisted" }, transient: true });
		mocks.threads = [
			{
				_id: "thread_persisted" as app_convex_Id<"ai_chat_threads">,
				_creationTime: 1,
				organizationId: mocks.tenant.organizationId,
				workspaceId: mocks.tenant.workspaceId,
				clientGeneratedId: optimisticId,
				title: "Persisted",
				archived: false,
				starred: false,
				runtime: "aisdk_5",
				createdBy: "user_test" as app_convex_Id<"users">,
				updatedBy: "user_test" as app_convex_Id<"users">,
				updatedAt: 1,
			},
		];
		mocks.listeners.forEach((listener) => listener());
		await waitFor(() =>
			expect(
				app_local_storage_get_value(
					`app_state::file_editor_sidebar_agent_selected_tab::scope::${mocks.tenant.membershipId}`,
				),
			).toBe("thread_persisted"),
		);
		expect(editComposer?.isConnected).toBe(true);
		expect(document.activeElement).toBe(editTextbox);
		expect(screen.getByRole("textbox", { name: "Edit queued message" }).closest(".AiChatComposer")).toBe(editComposer);
		expect(screen.getByRole("textbox", { name: "Edit queued message" }).textContent).toBe("Queued draft");
		stream.write({ type: "finish" });
		stream.close();

		act(() => {
			mocks.messageStatusByThreadId = { thread_persisted: "denied" };
			mocks.listeners.forEach((listener) => listener());
		});
		await waitFor(() => expect(screen.queryByRole("tab", { name: "Persisted" })).toBeNull());
		expect(screen.queryByRole("textbox", { name: "Edit queued message" })).toBeNull();
		await screen.findByRole("textbox", { name: "Send a message..." });
		expect(
			app_local_storage_get_value(
				`app_state::file_editor_sidebar_agent_selected_tab::scope::${mocks.tenant.membershipId}`,
			),
		).toMatch(/^ai_thread-/u);
		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(AiChatController.useStore.actions.getSession("thread_persisted")).toBeNull();
		expect(mocks.requestBodies).toHaveLength(1);
	});

	test("publishes a new chat tab before publishing its selection", async () => {
		const writtenKeys: string[] = [];
		const stopListening = storage_listen_event((event) => {
			if (event.key?.includes("file_editor_sidebar")) {
				writtenKeys.push(event.key);
			}
		});
		try {
			render(
				<div style={{ width: 480, height: 720 }}>
					<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" browserNodeId={null} browserNodeKind={null} />
				</div>,
			);
			await screen.findByRole("textbox", { name: "Send a message..." });
			writtenKeys.length = 0;

			await userEvent.click(screen.getByRole("button", { name: "New chat" }));

			const openTabsKey = `app_state::file_editor_sidebar_open_tabs::scope::${mocks.tenant.membershipId}`;
			const selectedTabKey = `app_state::file_editor_sidebar_agent_selected_tab::scope::${mocks.tenant.membershipId}`;
			const openTabsWriteIndex = writtenKeys.indexOf(openTabsKey);
			const selectedTabWriteIndex = writtenKeys.indexOf(selectedTabKey);
			expect(openTabsWriteIndex).toBeGreaterThanOrEqual(0);
			expect(selectedTabWriteIndex).toBeGreaterThan(openTabsWriteIndex);
		} finally {
			stopListening();
		}
	});

	test("restores each chat's draft when switching between different tabs", async () => {
		render(
			<div style={{ width: 480, height: 720 }}>
				<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" browserNodeId={null} browserNodeKind={null} />
			</div>,
		);
		const firstEditor = await screen.findByRole("textbox", { name: "Send a message..." });
		const firstTab = screen.getByRole("tab", { name: "New chat" });
		await userEvent.click(firstEditor);
		await userEvent.keyboard("First draft");
		await userEvent.click(screen.getByRole("button", { name: "New chat" }));
		const secondEditor = screen.getByRole("textbox", { name: "Send a message..." });
		expect(secondEditor).not.toBe(firstEditor);
		expect(secondEditor.textContent).toBe("");
		await userEvent.click(secondEditor);
		await userEvent.keyboard("Second draft");
		await userEvent.click(firstTab);
		expect(screen.getByRole("textbox", { name: "Send a message..." }).textContent).toBe("First draft");
	});

	test("scrolls the new chat tab into view when tabs overflow", async () => {
		render(
			<div style={{ width: 480, height: 720 }}>
				<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" browserNodeId={null} browserNodeKind={null} />
			</div>,
		);
		await screen.findByRole("textbox", { name: "Send a message..." });

		const newChatButton = screen.getByRole("button", { name: "New chat" });
		for (let index = 0; index < 8; index++) {
			await userEvent.click(newChatButton);
		}

		await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(9));
		const selectedTab = screen.getByRole("tab", { selected: true });
		const header = document.querySelector(".FileEditorSidebarAgentHeader");
		expect(header).not.toBeNull();
		const headerRect = header!.getBoundingClientRect();
		const tabRect = selectedTab.getBoundingClientRect();
		expect(tabRect.left).toBeGreaterThanOrEqual(headerRect.left - 1);
		expect(tabRect.right).toBeLessThanOrEqual(headerRect.right + 1);
	});
});
