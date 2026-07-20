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

type AiChatControllerStoreMockState = {
	messageById: Map<string, ai_chat_AiSdk5UiMessage>;
	branchSiblingIdsByMessageId: Map<string, readonly string[]>;
	runningMessageIdByThreadId: Map<string, string | null>;
	failedSendUserMessageIdByThreadId: Map<string, string | null>;
	editingMessageIdByThreadId: Map<string, string | null>;
};

vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: {
		useStore: <Result,>(selector: (state: AiChatControllerStoreMockState) => Result) => {
			const runningMessageIdByThreadId = new Map<string, string | null>();
			const failedSendUserMessageIdByThreadId = new Map<string, string | null>();
			const editingMessageIdByThreadId = new Map<string, string | null>();

			if (hookMocks.runningMessageId) {
				runningMessageIdByThreadId.set("thread_1", hookMocks.runningMessageId);
			}
			if (hookMocks.sendErrorMessageId) {
				failedSendUserMessageIdByThreadId.set("thread_1", hookMocks.sendErrorMessageId);
			}
			if (hookMocks.editingMessageId) {
				editingMessageIdByThreadId.set("thread_1", hookMocks.editingMessageId);
			}

			return selector({
				messageById: hookMocks.messageById,
				branchSiblingIdsByMessageId: hookMocks.branchSiblingIdsByMessageId,
				runningMessageIdByThreadId,
				failedSendUserMessageIdByThreadId,
				editingMessageIdByThreadId,
			});
		},
	},
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
		parts: [{ type: "text", text: "Can you summarize my workspace notes?" }],
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
	const bashWorkspaceMount = "/home/cloud-usr/w/personal/home";

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

		expect(hookMocks.actions.sendUserText).toHaveBeenCalledWith("thread_1", "Can you summarize my workspace notes?", {
			messageId: "msg_user_failed",
		});
	});

	test("renders user message text as plain text, without markdown parsing", () => {
		const text = "test\n\n- Prefer `internal.*` refs";
		renderMessage({
			message: {
				id: "msg_user_plain",
				role: "user",
				parts: [{ type: "text", text }],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
					selectedModelId: "gpt-5.4-nano",
					selectedModeId: "ask",
				},
			} satisfies ai_chat_AiSdk5UiMessage,
		});

		const part = document.querySelector(".AiChatMessagePartTextUser");
		expect(part?.textContent).toBe(text);
		expect(part?.querySelector("code")).toBeNull();
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
							title: `exit 0 · ${bashWorkspaceMount}`,
							output: `$ pwd\ncwd: ${bashWorkspaceMount}\nnext cwd: ${bashWorkspaceMount}\nexit: 0\n\n<stdout>\n${bashWorkspaceMount}\n</stdout>`,
							stdout: `${bashWorkspaceMount}\n`,
							stderr: "",
							metadata: {
								command: "pwd",
								cwd: bashWorkspaceMount,
								nextCwd: bashWorkspaceMount,
								exitCode: 0,
								stdoutTruncated: false,
								stderrTruncated: false,
								stdoutLength: bashWorkspaceMount.length + 1,
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
		expect(terminal.textContent).toContain(`${bashWorkspaceMount}$ pwd`);
		expect(terminal.textContent).toContain(bashWorkspaceMount);
		expect(terminal.textContent).toContain(`exit 0 · cwd ${bashWorkspaceMount}`);
		expect(screen.queryByRole("region", { name: "Metadata" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Stdout" })).toBeNull();
	});

	test("renders execute_code tool output as code, input, and result sections", () => {
		renderMessage({
			message: {
				id: "msg_assistant_execute_code",
				role: "assistant",
				parts: [
					{
						type: "tool-execute_code",
						toolCallId: "call_execute_code",
						state: "output-available",
						input: { code: "return input.a + input.b;", input: { a: 12, b: 9 } },
						output: {
							title: "Execute code",
							metadata: {
								executionId: "exec_1",
								status: "succeeded",
								elapsedMs: 7,
								resultTruncated: false,
								logsTruncated: false,
							},
							output: "Result: 21",
						},
					},
				],
				metadata: {
					convexParentId: "msg_user_failed",
					parentClientGeneratedId: null,
				},
			} satisfies ai_chat_AiSdk5UiMessage,
		});

		expect(screen.getByRole("button", { name: "Execute code" })).not.toBeNull();
		// The old generic renderer leaked type/toolCallId/state pills; the dedicated one must not.
		expect(screen.queryByText(/toolCallId:/)).toBeNull();

		fireEvent.click(screen.getByText("Execute code"));
		expect(screen.getByRole("textbox", { name: "Code" }).textContent).toContain("return input.a + input.b;");
		expect(screen.getByRole("textbox", { name: "Input" }).textContent).toContain('"a": 12');
		expect(screen.getByRole("textbox", { name: "Result" }).textContent).toContain("Result: 21");
	});

	test("flags a runner-level execute_code failure in the summary and error section", () => {
		renderMessage({
			message: {
				id: "msg_assistant_execute_code_error",
				role: "assistant",
				parts: [
					{
						type: "tool-execute_code",
						toolCallId: "call_execute_code_error",
						state: "output-available",
						input: { code: "throw new Error('boom');" },
						output: {
							title: "Execute code",
							metadata: {
								executionId: "exec_err",
								status: "errored",
								elapsedMs: 3,
								resultTruncated: false,
								logsTruncated: false,
							},
							output: "Error: Error: boom",
						},
					},
				],
				metadata: {
					convexParentId: "msg_user_failed",
					parentClientGeneratedId: null,
				},
			} satisfies ai_chat_AiSdk5UiMessage,
		});

		expect(screen.getByText("failed")).not.toBeNull();

		fireEvent.click(screen.getByText("Execute code"));
		expect(screen.getByRole("textbox", { name: "Error" }).textContent).toContain("Error: Error: boom");
		expect(screen.queryByRole("textbox", { name: "Result" })).toBeNull();
	});
});
