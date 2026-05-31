import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_AiSdk5UiMessage } from "@/lib/ai-chat.ts";
import { AiChatMessage } from "./ai-chat-message.tsx";

vi.mock("@/components/ai-chat/ai-chat-composer.tsx", () => ({
	AiChatComposer: function AiChatComposer() {
		return <form />;
	},
}));

vi.mock("@/components/ai-chat/ai-chat-markdown.tsx", () => ({
	AiChatMarkdown: function AiChatMarkdown(props: { className?: string; markdown: string }) {
		return <div className={props.className}>{props.markdown}</div>;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: function Link(props: { children?: ReactNode; to?: string }) {
		return <a href={props.to ?? "#"}>{props.children}</a>;
	},
}));

function createUserMessage() {
	return {
		id: "msg_user_failed",
		role: "user",
		parts: [{ type: "text", text: "Can you summarize my project notes?" }],
		metadata: {
			convexParentId: null,
			parentClientGeneratedId: null,
			selectedModelId: "gpt-5.4-nano",
			selectedModeId: "ask",
		},
	} satisfies ai_chat_AiSdk5UiMessage;
}

function createAssistantErrorMessage() {
	return {
		id: "msg_assistant_error",
		role: "assistant",
		parts: [],
		metadata: {
			convexParentId: "msg_user_failed",
			parentClientGeneratedId: null,
			status: "errored",
		},
	} satisfies ai_chat_AiSdk5UiMessage;
}

function renderMessage(args: {
	message: ai_chat_AiSdk5UiMessage;
	sendErrorText?: string | undefined;
	onMessageRetrySend?: ((args: { threadId: string; messageId: string; value: string }) => void) | undefined;
}) {
	const onMessageRetrySend = args.onMessageRetrySend ?? vi.fn();

	render(
		<AiChatMessage
			message={args.message}
			selectedThreadId="thread_1"
			selectedModelId="gpt-5.4-nano"
			selectedModeId="ask"
			isRunning={false}
			isEditing={false}
			branchAnchorIds={[args.message.id]}
			onToolOutput={vi.fn()}
			onToolResumeStream={vi.fn()}
			onToolStop={vi.fn()}
			onSelectedModelIdChange={vi.fn()}
			onSelectedModeIdChange={vi.fn()}
			onEditStart={vi.fn()}
			onEditCancel={vi.fn()}
			onEditSubmit={vi.fn()}
			onMessageRegenerate={vi.fn()}
			onMessageRetrySend={onMessageRetrySend}
			onMessageBranchChat={vi.fn()}
			onSelectBranchAnchor={vi.fn()}
			sendErrorText={args.sendErrorText}
		/>,
	);

	return { onMessageRetrySend };
}

describe("AiChatMessage", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	test("renders failed-send feedback on a user message and retries the same message", () => {
		const onMessageRetrySend = vi.fn();

		renderMessage({
			message: createUserMessage(),
			sendErrorText: "Message failed to send.",
			onMessageRetrySend,
		});

		expect(screen.getByRole("alert").textContent).toBe("Message failed to send.");

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(onMessageRetrySend).toHaveBeenCalledWith({
			threadId: "thread_1",
			messageId: "msg_user_failed",
			value: "Can you summarize my project notes?",
		});
	});

	test("keeps assistant stream errors separate from failed-send feedback", () => {
		renderMessage({
			message: createAssistantErrorMessage(),
		});

		expect(screen.getByText("An error occurred during the generation")).not.toBeNull();
		expect(screen.queryByText("Message failed to send.")).toBeNull();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});
});
