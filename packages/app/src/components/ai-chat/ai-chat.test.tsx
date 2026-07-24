import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AiChatThreadRuntime } from "@/hooks/ai-chat-controller.tsx";
import type { ai_chat_AiSdk5UiMessage } from "@/lib/ai-chat.ts";

// Network boundary: the real hooks talk to a live Convex client.
vi.mock("convex/react", () => ({
	useQuery: () => undefined,
}));

// The real module creates a live ConvexReactClient at import (needs VITE_CONVEX_URL).
vi.mock("@/lib/app-convex-client.ts", () => ({
	app_convex_api: {},
}));

// Provider boundary: the real useContext throws without an AppTenantProvider mounted above.
vi.mock("@/lib/app-tenant-context.tsx", () => ({
	AppTenantProvider: {
		useContext: () => ({ membershipId: "membership_1" }),
	},
}));

// The controller store lives outside the component; the thread only reads the editing map.
vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: {
		useStore: (selector: (state: { editingMessageIdByThreadId: Map<string, string> }) => unknown) =>
			selector({ editingMessageIdByThreadId: new Map() }),
	},
}));

// The real composer boots a Tiptap editor. Keep the queue props visible for thread wiring tests.
vi.mock("@/components/ai-chat/ai-chat-composer.tsx", () => ({
	AiChatComposer: function AiChatComposer(props: {
		canQueue: boolean;
		isQueueing: boolean;
		isQueueEditing?: boolean;
		initialValue: string;
		inputLabel?: string;
		submitLabel?: string;
		selectedModelId: string;
		selectedModeId: string;
		onSubmit: (value: string) => boolean | void;
		onClose?: () => void;
	}) {
		return (
			<div
				className="AiChatComposer"
				data-testid="ai-chat-composer"
				data-can-queue={props.canQueue}
				data-is-queueing={props.isQueueing}
				data-is-queue-editing={props.isQueueEditing}
				data-initial-value={props.initialValue}
				data-input-label={props.inputLabel}
				data-selected-model-id={props.selectedModelId}
				data-selected-mode-id={props.selectedModeId}
				tabIndex={-1}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						props.onClose?.();
					}
				}}
			>
				<button type="button" onClick={() => props.onSubmit(props.initialValue)}>
					{props.submitLabel ?? "Send message"}
				</button>
			</div>
		);
	},
}));

vi.mock("@/components/ai-chat/ai-chat-message.tsx", () => ({
	AiChatMessage: function AiChatMessage(props: { message: ai_chat_AiSdk5UiMessage; isRunning: boolean }) {
		return <div data-testid={`message-${props.message.role}`} data-running={props.isRunning} />;
	},
	AiChatMessagePendingAssistant: function AiChatMessagePendingAssistant() {
		return <div>Thinking</div>;
	},
}));

vi.mock("@/components/ai-chat/ai-chat-threads.tsx", () => ({
	AiChatThreads: function AiChatThreads() {
		return <div />;
	},
}));

vi.mock("@/components/main-app-sidebar-toggle.tsx", () => ({
	MainAppSidebarToggle: function MainAppSidebarToggle() {
		return <div />;
	},
}));

// CatchBoundary is a plain error boundary; the stub renders children without a router.
vi.mock("@tanstack/react-router", () => ({
	CatchBoundary: function CatchBoundary(props: { children?: ReactNode }) {
		return <>{props.children}</>;
	},
}));

// The real hook attaches scroll listeners to live elements; the thread only reads isAtBottom.
vi.mock("@/lib/ui.tsx", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ui.tsx")>()),
	useUiStickToBottom: () => ({ isAtBottom: true, scrollToBottom: vi.fn() }),
}));

import { AiChatThread } from "./ai-chat.tsx";

/** Minimal idle-thread runtime: empty branch, nothing streaming, welcome screen state. */
function makeController(overrides?: Partial<AiChatThreadRuntime>): AiChatThreadRuntime {
	return {
		selectedThreadId: null,
		selectedModelId: "model_1",
		selectedModeId: "mode_agent",
		session: null,
		status: "ready",
		error: null,
		isRunning: false,
		canSendUserText: true,
		queuedUserMessages: [],
		queuedUserMessageEdit: null,
		queuedUserMessageLimit: 10,
		canQueueUserText: false,
		isQueueingUserText: false,
		isMessageQueueFull: false,
		isMessageQueuePaused: false,
		activeBranchMessages: { list: [], anchorId: null },
		addToolOutput: vi.fn(),
		resumeStream: vi.fn(),
		stop: vi.fn(),
		setSelectedModelId: vi.fn(),
		setSelectedModeId: vi.fn(),
		sendUserText: vi.fn(),
		startQueuedUserMessageEdit: vi.fn(),
		setQueuedUserMessageEditText: vi.fn(),
		setQueuedUserMessageEditModelId: vi.fn(),
		setQueuedUserMessageEditModeId: vi.fn(),
		saveQueuedUserMessageEdit: vi.fn(),
		cancelQueuedUserMessageEdit: vi.fn(),
		setQueuedUserMessagesReordering: vi.fn(),
		reorderQueuedUserMessages: vi.fn(),
		removeQueuedUserMessage: vi.fn(),
		resumeQueuedUserMessages: vi.fn(),
		regenerate: vi.fn(),
		setComposerValue: vi.fn(),
		...overrides,
	} as unknown as AiChatThreadRuntime;
}

afterEach(() => {
	cleanup();
});

describe("AiChatThread", () => {
	test("keeps Thinking visible until the running assistant has content", async () => {
		const userMessage = {
			id: "message_user_pending",
			role: "user",
			parts: [{ type: "text", text: "Tell me a joke" }],
			metadata: {
				convexParentId: null,
				parentClientGeneratedId: null,
				selectedModelId: "gpt-5.4-nano",
				selectedModeId: "ask",
			},
		} satisfies ai_chat_AiSdk5UiMessage;
		const assistantMessage = {
			id: "message_assistant_pending",
			role: "assistant",
			parts: [],
			metadata: {
				convexParentId: "message_user_pending",
				parentClientGeneratedId: null,
			},
		} satisfies ai_chat_AiSdk5UiMessage;

		const rendered = render(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_pending",
					isRunning: true,
					activeBranchMessages: {
						list: [userMessage],
						mapById: new Map<string, ai_chat_AiSdk5UiMessage>([[userMessage.id, userMessage]]),
						anchorId: null,
					},
				})}
				scrollableContainer={null}
			/>,
		);

		expect(screen.getByText("Thinking")).not.toBeNull();

		rendered.rerender(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_pending",
					isRunning: true,
					activeBranchMessages: {
						list: [userMessage, assistantMessage],
						mapById: new Map<string, ai_chat_AiSdk5UiMessage>([
							[userMessage.id, userMessage],
							[assistantMessage.id, assistantMessage],
						]),
						anchorId: null,
					},
				})}
				scrollableContainer={null}
			/>,
		);

		await waitFor(() => {
			expect(screen.queryByText("Thinking")).toBeNull();
			expect(screen.getByTestId("message-assistant").dataset.running).toBe("true");
		});
	});

	test("renders composerTopSlot inside the composer stack, above the composer", () => {
		const { container } = render(
			<AiChatThread
				controller={makeController()}
				scrollableContainer={null}
				composerTopSlot={<div data-testid="composer-top-slot" />}
			/>,
		);

		const stack = container.querySelector(".AiChatThread-composer-stack");
		expect(stack).toBeTruthy();

		const slot = stack?.querySelector("[data-testid='composer-top-slot']");
		const composer = stack?.querySelector(".AiChatComposer");
		expect(slot).toBeTruthy();
		expect(composer).toBeTruthy();
		// The slot must come before the composer in DOM order.
		expect(slot && composer && slot.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("renders only the composer in the stack when no slot is passed", () => {
		const { container } = render(<AiChatThread controller={makeController()} scrollableContainer={null} />);

		const stack = container.querySelector(".AiChatThread-composer-stack");
		expect(stack).toBeTruthy();
		expect(stack?.childElementCount).toBe(1);
		expect(stack?.firstElementChild?.classList.contains("AiChatComposer")).toBe(true);
	});

	test("renders and announces a paused queue", () => {
		const startQueuedUserMessageEdit = vi.fn();
		const removeQueuedUserMessage = vi.fn();
		const resumeQueuedUserMessages = vi.fn();
		render(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queued",
					queuedUserMessages: [
						{
							id: "ai_message-queued",
							text: "Run this next",
							selectedModelId: "gpt-5.4-nano",
							selectedModeId: "agent",
						},
					],
					canQueueUserText: true,
					isQueueingUserText: true,
					isMessageQueuePaused: true,
					startQueuedUserMessageEdit,
					removeQueuedUserMessage,
					resumeQueuedUserMessages,
				})}
				scrollableContainer={null}
			/>,
		);

		expect(screen.getByRole("status").textContent).toBe("1 queued message. Queue paused.");
		expect(screen.getByRole("region", { name: "Queue Messages" })).not.toBeNull();
		expect(screen.getByTestId("ai-chat-composer").dataset.canQueue).toBe("true");
		expect(screen.getByTestId("ai-chat-composer").dataset.isQueueing).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		fireEvent.click(screen.getByRole("button", { name: "Edit queued message: Run this next" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Run this next" }));

		expect(resumeQueuedUserMessages).toHaveBeenCalledOnce();
		expect(startQueuedUserMessageEdit).toHaveBeenCalledWith("ai_message-queued");
		expect(removeQueuedUserMessage).toHaveBeenCalledWith("ai_message-queued");
	});

	test("uses the composer to save a queued edit without sending", () => {
		const queuedUserMessageEdit = {
			id: "ai_message-queued",
			text: "Edited queued text",
			selectedModelId: "gpt-5.4-mini",
			selectedModeId: "ask",
		} as const;
		const saveQueuedUserMessageEdit = vi.fn(() => true);
		const cancelQueuedUserMessageEdit = vi.fn();
		const sendUserText = vi.fn();
		const view = render(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queued_edit",
					session: {
						draftComposerText: "Keep this normal draft",
					} as AiChatThreadRuntime["session"],
					queuedUserMessages: [queuedUserMessageEdit],
					queuedUserMessageEdit,
					canQueueUserText: false,
					isQueueingUserText: true,
					isMessageQueueFull: true,
					saveQueuedUserMessageEdit,
					cancelQueuedUserMessageEdit,
					sendUserText,
				})}
				scrollableContainer={null}
			/>,
		);

		const composer = screen.getByTestId("ai-chat-composer");
		expect(composer.dataset.initialValue).toBe("Edited queued text");
		expect(composer.dataset.inputLabel).toBe("Edit queued message");
		expect(composer.dataset.selectedModelId).toBe("gpt-5.4-mini");
		expect(composer.dataset.selectedModeId).toBe("ask");
		expect(composer.dataset.canQueue).toBe("true");
		expect(screen.getByRole("status").textContent).toBe(
			"1 queued message. Queue is full. Editing a queued message.",
		);

		fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));

		expect(saveQueuedUserMessageEdit).toHaveBeenCalledWith("ai_message-queued", "Edited queued text");
		expect(cancelQueuedUserMessageEdit).not.toHaveBeenCalled();
		expect(sendUserText).not.toHaveBeenCalled();

		view.rerender(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queued_edit",
					session: {
						draftComposerText: "Keep this normal draft",
					} as AiChatThreadRuntime["session"],
					queuedUserMessages: [],
					queuedUserMessageEdit: null,
					saveQueuedUserMessageEdit,
					cancelQueuedUserMessageEdit,
					sendUserText,
				})}
				scrollableContainer={null}
			/>,
		);
		expect(screen.getByTestId("ai-chat-composer").dataset.initialValue).toBe("Keep this normal draft");
	});

	test("cancels a queued edit with Escape and restores the normal draft without sending", () => {
		const queuedUserMessageEdit = {
			id: "ai_message-queued",
			text: "Leave this queued text alone",
			selectedModelId: "gpt-5.4-mini",
			selectedModeId: "ask",
		} as const;
		const cancelQueuedUserMessageEdit = vi.fn();
		const sendUserText = vi.fn();
		const view = render(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queued_cancel",
					session: {
						draftComposerText: "Keep this normal draft",
					} as AiChatThreadRuntime["session"],
					queuedUserMessages: [queuedUserMessageEdit],
					queuedUserMessageEdit,
					cancelQueuedUserMessageEdit,
					sendUserText,
				})}
				scrollableContainer={null}
			/>,
		);

		fireEvent.keyDown(screen.getByTestId("ai-chat-composer"), { key: "Escape" });

		expect(cancelQueuedUserMessageEdit).toHaveBeenCalledWith("ai_message-queued");
		expect(sendUserText).not.toHaveBeenCalled();

		view.rerender(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queued_cancel",
					session: {
						draftComposerText: "Keep this normal draft",
					} as AiChatThreadRuntime["session"],
					queuedUserMessages: [queuedUserMessageEdit],
					queuedUserMessageEdit: null,
					cancelQueuedUserMessageEdit,
					sendUserText,
				})}
				scrollableContainer={null}
			/>,
		);
		expect(screen.getByTestId("ai-chat-composer").dataset.initialValue).toBe("Keep this normal draft");
	});

	test("announces queue count, full, and paused state changes", () => {
		const firstQueuedMessage = {
			id: "ai_message-first",
			text: "First queued message",
			selectedModelId: "gpt-5.4-nano",
			selectedModeId: "agent",
		} as const;
		const secondQueuedMessage = {
			id: "ai_message-second",
			text: "Second queued message",
			selectedModelId: "gpt-5.4-mini",
			selectedModeId: "ask",
		} as const;
		const view = render(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queue_announcements",
					queuedUserMessages: [firstQueuedMessage],
					canQueueUserText: true,
					isQueueingUserText: true,
				})}
				scrollableContainer={null}
			/>,
		);

		expect(screen.getByRole("status").textContent).toBe("1 queued message.");

		view.rerender(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queue_announcements",
					queuedUserMessages: [firstQueuedMessage, secondQueuedMessage],
					canQueueUserText: false,
					isQueueingUserText: true,
					isMessageQueueFull: true,
				})}
				scrollableContainer={null}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("2 queued messages. Queue is full.");

		view.rerender(
			<AiChatThread
				controller={makeController({
					selectedThreadId: "thread_queue_announcements",
					queuedUserMessages: [secondQueuedMessage],
					canQueueUserText: true,
					isQueueingUserText: true,
					isMessageQueuePaused: true,
				})}
				scrollableContainer={null}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("1 queued message. Queue paused.");
	});
});
