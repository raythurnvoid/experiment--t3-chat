import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { ai_chat_Thread } from "@/lib/ai-chat.ts";

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
		useQuery: (query: FunctionReference<"query">, args: unknown) => {
			if (args === "skip") return undefined;
			switch (getFunctionName(query)) {
				case "ai_chat:thread_messages_list":
					return mocks.threadMessages;
				case "files_pending_updates:list_files_pending_updates":
					return [];
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
		mocks.mutation.mockClear();
		app_local_storage_set_value("app_state::files_last_tab", "app_file_editor_sidebar_tabs_agent");
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	test("keeps the real composer and focus through persistence during a queued edit", async () => {
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
				<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" />
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

		const optimisticId = mocks.requestBodies[0]?.clientGeneratedThreadId;
		expect(optimisticId).toMatch(/^ai_thread-/u);
		stream.write({ type: "data-thread-id", data: { threadId: "thread_persisted" }, transient: true });
		mocks.threads = [
			{
				_id: "thread_persisted",
				_creationTime: 1,
				organizationId: mocks.tenant.organizationId,
				workspaceId: mocks.tenant.workspaceId,
				clientGeneratedId: optimisticId,
				title: "Persisted",
				archived: false,
				starred: false,
				runtime: "aisdk_5",
				stateId: null,
				createdBy: "user_test",
				updatedBy: "user_test",
				updatedAt: 1,
			} as ai_chat_Thread,
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
					<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" />
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
				<FileEditorSidebarAgent rootTabId="app_file_editor_sidebar_tabs_agent" />
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
});
