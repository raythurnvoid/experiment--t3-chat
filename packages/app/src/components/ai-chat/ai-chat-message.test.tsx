import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_AiSdk5UiMessage } from "@/lib/ai-chat.ts";
import { AiChatMessage } from "./ai-chat-message.tsx";

const hookMocks = vi.hoisted(() => {
	return {
		messageById: new Map<string, ai_chat_AiSdk5UiMessage>(),
		branchSiblingIdsByMessageId: new Map<string, readonly string[]>(),
		runningMessageId: null as string | null,
		editingMessageId: null as string | null,
		sendErrorMessageId: null as string | null,
		actions: {
			addToolOutput: vi.fn(),
			resumeStream: vi.fn(),
			stop: vi.fn(),
			setSelectedModelId: vi.fn(),
			setSelectedModeId: vi.fn(),
			sendUserText: vi.fn(),
			regenerate: vi.fn(),
			branchChat: vi.fn(),
			selectBranchAnchor: vi.fn(),
			setEditingMessageId: vi.fn(),
		},
	};
});

vi.mock("@/hooks/ai-chat-hooks.tsx", () => ({
	useAiChatMessage: (messageId: string) => hookMocks.messageById.get(messageId) ?? null,
	useAiChatMessageBranchSiblingIds: (messageId: string) =>
		hookMocks.branchSiblingIdsByMessageId.get(messageId) ?? [messageId],
	useAiChatMessageIsEditing: (_threadId: string | null, messageId: string) => hookMocks.editingMessageId === messageId,
	useAiChatMessageIsRunning: (_threadId: string | null, messageId: string) => hookMocks.runningMessageId === messageId,
	useAiChatMessageSendErrorText: (_threadId: string | null, messageId: string) =>
		hookMocks.sendErrorMessageId === messageId ? "Message failed to send." : undefined,
}));

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

function createAssistantMessage(args?: { id?: string; text?: string; parentId?: string | null }) {
	return {
		id: args?.id ?? "msg_assistant",
		role: "assistant",
		parts: args?.text ? [{ type: "text", text: args.text }] : [],
		metadata: {
			convexParentId: args?.parentId ?? "msg_user_failed",
			parentClientGeneratedId: null,
		},
	} satisfies ai_chat_AiSdk5UiMessage;
}

function renderMessage(args: {
	message: ai_chat_AiSdk5UiMessage;
	sendError?: boolean | undefined;
	branchSiblingIds?: readonly string[] | undefined;
	isEditing?: boolean | undefined;
	isRunning?: boolean | undefined;
}) {
	hookMocks.messageById.set(args.message.id, args.message);
	hookMocks.branchSiblingIdsByMessageId.set(args.message.id, args.branchSiblingIds ?? [args.message.id]);
	hookMocks.editingMessageId = args.isEditing ? args.message.id : null;
	hookMocks.runningMessageId = args.isRunning ? args.message.id : null;
	hookMocks.sendErrorMessageId = args.sendError ? args.message.id : null;

	render(
		<AiChatMessage
			messageId={args.message.id}
			selectedThreadId="thread_1"
			selectedModelId="gpt-5.4-nano"
			selectedModeId="ask"
			actions={hookMocks.actions}
		/>,
	);
}

describe("AiChatMessage", () => {
	const bashProjectMount = "/home/cloud-usr/w/personal/home";

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();
		hookMocks.runningMessageId = null;
		hookMocks.editingMessageId = null;
		hookMocks.sendErrorMessageId = null;
	});

	test("renders failed-send feedback on a user message and retries the same message", () => {
		renderMessage({
			message: createUserMessage(),
			sendError: true,
		});

		expect(screen.getByRole("alert").textContent).toBe("Message failed to send.");

		fireEvent.click(screen.getByRole("button", { name: "Retry" }));

		expect(hookMocks.actions.sendUserText).toHaveBeenCalledWith("thread_1", "Can you summarize my project notes?", {
			messageId: "msg_user_failed",
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

	test("switches to the next branch from branch controls", () => {
		renderMessage({
			message: createAssistantMessage({ id: "msg_assistant_a", text: "First branch" }),
			branchSiblingIds: ["msg_assistant_a", "msg_assistant_b"],
		});

		fireEvent.click(screen.getByRole("button", { name: "Next branch" }));

		expect(hookMocks.actions.selectBranchAnchor).toHaveBeenCalledWith("thread_1", "msg_assistant_b");
	});

	test("starts editing a user message on edit click", () => {
		renderMessage({
			message: createUserMessage(),
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

		expect(hookMocks.actions.selectBranchAnchor).toHaveBeenCalledWith("thread_1", null);
		expect(hookMocks.actions.setEditingMessageId).toHaveBeenCalledWith("thread_1", "msg_user_failed");
	});

	test("regenerates an assistant response", () => {
		renderMessage({
			message: createAssistantMessage({ id: "msg_assistant", text: "A response" }),
		});

		fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));

		expect(hookMocks.actions.regenerate).toHaveBeenCalledWith("thread_1", "msg_assistant");
	});

	test("enables copy only when a message has text", () => {
		renderMessage({
			message: createUserMessage(),
		});

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy message" }).disabled).toBe(false);

		cleanup();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();

		renderMessage({
			message: createAssistantMessage({ id: "msg_assistant_empty" }),
		});

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Copy message" }).disabled).toBe(true);
	});

	test("renders bash tool output as a terminal block", () => {
		renderMessage({
			message: {
				id: "msg_assistant_bash",
				role: "assistant",
				parts: [
					{
						type: "tool-bash",
						toolCallId: "call_bash",
						state: "output-available",
						input: { command: "pwd" },
						output: {
							title: `exit 0 · ${bashProjectMount}`,
							output: `$ pwd\ncwd: ${bashProjectMount}\nnext cwd: ${bashProjectMount}\nexit: 0\n\n<stdout>\n${bashProjectMount}\n</stdout>`,
							stdout: `${bashProjectMount}\n`,
							stderr: "",
							metadata: {
								command: "pwd",
								cwd: bashProjectMount,
								nextCwd: bashProjectMount,
								exitCode: 0,
								stdoutTruncated: false,
								stderrTruncated: false,
								stdoutLength: bashProjectMount.length + 1,
								stderrLength: 0,
								pathIndexTruncated: false,
							},
						},
					},
				],
				metadata: {
					convexParentId: "msg_user_failed",
					parentClientGeneratedId: null,
				},
			} satisfies ai_chat_AiSdk5UiMessage,
		});

		expect(screen.getByText("Bash:")).not.toBeNull();
		expect(screen.getByText("pwd")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Bash: pwd" })).not.toBeNull();
		fireEvent.click(screen.getByText("Bash:"));
		const terminal = screen.getByRole("textbox", { name: "Bash terminal output" });
		expect(terminal.textContent).toContain(`${bashProjectMount}$ pwd`);
		expect(terminal.textContent).toContain(bashProjectMount);
		expect(terminal.textContent).toContain(`exit 0 · cwd ${bashProjectMount}`);
		expect(screen.queryByRole("region", { name: "Metadata" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Stdout" })).toBeNull();
	});

});
