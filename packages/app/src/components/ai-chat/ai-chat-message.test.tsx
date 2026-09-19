import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_UiMessage } from "@/lib/ai-chat.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { AiChatBrowserSurfaceProvider, AiChatMessage, AiChatMessagePendingAssistant, type AiChatMessage_Props } from "./ai-chat-message.tsx";
import { global_custom_event_listen } from "@/lib/global-event.tsx";
import type { AiChatComposer_Props } from "./ai-chat-composer.tsx";

vi.mock("@/lib/files-tree-context.tsx", () => ({
	FilesTreeProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("@/components/files/files-clipboard.tsx", () => ({
	FilesClipboardProvider: (props: { children: ReactNode }) => props.children,
}));

vi.mock("convex/react", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		useQuery: () => hookMocks.browserResultFile,
	};
});

const hookMocks = vi.hoisted(() => {
	return {
		messageById: new Map<string, ai_chat_UiMessage>(),
		branchSiblingIdsByMessageId: new Map<string, readonly string[]>(),
		editingMessageId: null as string | null,
		sendErrorMessageId: null as string | null,
		sendErrorDetails: null as string | null,
		browserResultFile: undefined as
			| undefined
			| { nodeId: string; targetKind: "saved" | "private"; expired: boolean },
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
	messageById: Map<string, ai_chat_UiMessage>;
	branchSiblingIdsByMessageId: Map<string, readonly string[]>;
	failedSendUserMessageIdByThreadId: Map<string, string | null>;
	failedSendErrorMessageByThreadId: Map<string, string | null>;
	editingMessageIdByThreadId: Map<string, string | null>;
};

vi.mock("@/hooks/ai-chat-controller.tsx", () => ({
	AiChatController: {
		useStore: <Result,>(selector: (state: AiChatControllerStoreMockState) => Result) => {
			const failedSendUserMessageIdByThreadId = new Map<string, string | null>();
			const failedSendErrorMessageByThreadId = new Map<string, string | null>();
			const editingMessageIdByThreadId = new Map<string, string | null>();

			if (hookMocks.sendErrorMessageId) {
				failedSendUserMessageIdByThreadId.set("thread_1", hookMocks.sendErrorMessageId);
				failedSendErrorMessageByThreadId.set("thread_1", hookMocks.sendErrorDetails);
			}
			if (hookMocks.editingMessageId) {
				editingMessageIdByThreadId.set("thread_1", hookMocks.editingMessageId);
			}

			return selector({
				messageById: hookMocks.messageById,
				branchSiblingIdsByMessageId: hookMocks.branchSiblingIdsByMessageId,
				failedSendUserMessageIdByThreadId,
				failedSendErrorMessageByThreadId,
				editingMessageIdByThreadId,
			});
		},
	},
}));

vi.mock("@/components/ai-chat/ai-chat-composer.tsx", () => ({
	AiChatComposer: function AiChatComposer(props: AiChatComposer_Props) {
		return (
			<form data-testid="message-composer">
				<button type="button" onClick={() => props.onSubmit(props.initialValue, [])}>
					Save message
				</button>
			</form>
		);
	},
}));

vi.mock("@/components/ai-chat/ai-chat-markdown.tsx", () => ({
	AiChatMarkdown: function AiChatMarkdown(props: { className?: string; markdown: string }) {
		return <div className={props.className}>{props.markdown}</div>;
	},
}));

vi.mock("@tanstack/react-router", () => ({
	Link: function Link(props: { children?: ReactNode; to?: string; search?: unknown; onClick?: MouseEventHandler<HTMLAnchorElement> }) {
		return (
			<a href={props.to ?? "#"} data-search={JSON.stringify(props.search)} onClick={props.onClick}>
				{props.children}
			</a>
		);
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
	} satisfies ai_chat_UiMessage;
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
	} satisfies ai_chat_UiMessage;
}

function createAssistantMessage(args?: { id?: string; text?: string; parentId?: string | null }) {
	return {
		id: args?.id ?? "msg_assistant",
		role: "assistant",
		parts: args?.text === undefined ? [] : [{ type: "text", text: args.text }],
		metadata: {
			convexParentId: args?.parentId ?? "msg_user_failed",
			parentClientGeneratedId: null,
		},
	} satisfies ai_chat_UiMessage;
}

function renderMessage(args: {
	message: ai_chat_UiMessage;
	sendError?: boolean | undefined;
	sendErrorDetails?: string | undefined;
	branchSiblingIds?: readonly string[] | undefined;
	isEditing?: boolean | undefined;
	isRunning?: boolean | undefined;
	liveJobs?: AiChatMessage_Props["liveJobs"] | undefined;
}) {
	hookMocks.messageById.set(args.message.id, args.message);
	hookMocks.branchSiblingIdsByMessageId.set(args.message.id, args.branchSiblingIds ?? [args.message.id]);
	hookMocks.editingMessageId = args.isEditing ? args.message.id : null;
	hookMocks.sendErrorMessageId = args.sendError ? args.message.id : null;
	hookMocks.sendErrorDetails = args.sendErrorDetails ?? null;

	return render(
		withTenant(
			<AiChatMessage
				messageId={args.message.id}
				message={args.message}
				selectedThreadId="thread_1"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="ask"
				isRunning={Boolean(args.isRunning)}
				liveJobs={args.liveJobs ?? []}
				actions={hookMocks.actions}
			/>,
		),
	);
}

// Tool cards link back to the edited file, so they read the current tenant from this provider.
// A rerender must reuse it too, otherwise the changed tree remounts the message.
function withTenant(ui: ReactNode) {
	return (
		<AppTenantProvider
			membershipId={"membership-1" as app_convex_Id<"organizations_workspaces_users">}
			workspaceId={"workspace-1" as app_convex_Id<"organizations_workspaces">}
			workspaceName="home"
			organizationId={"organization-1" as app_convex_Id<"organizations">}
			organizationName="personal"
		>
			{ui}
		</AppTenantProvider>
	);
}

describe("AiChatMessage", () => {
	const bashWorkspaceMount = "/home/cloud-usr/w/personal/home";

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();
		hookMocks.editingMessageId = null;
		hookMocks.sendErrorMessageId = null;
		hookMocks.sendErrorDetails = null;
		hookMocks.browserResultFile = undefined;
	});

	test("saves an inline edit with its message id", () => {
		const message = createUserMessage();
		renderMessage({
			message,
			isEditing: true,
		});
		fireEvent.click(screen.getByRole("button", { name: "Save message" }));
		expect(hookMocks.actions.sendUserText).toHaveBeenCalledWith("thread_1", "Can you summarize my workspace notes?", {
			messageId: message.id,
			attachments: [],
		});
	});

	test("shows Thinking without actions before the assistant message exists", () => {
		render(<AiChatMessagePendingAssistant />);

		expect(screen.getByText("Thinking").closest("[aria-busy='true']")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
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

	test("shows the raw failed-send error in a scrollable details dialog", () => {
		const rawErrorMessage = JSON.stringify({ type: "error", message: "x".repeat(5_000) });
		renderMessage({
			message: createUserMessage(),
			sendError: true,
			sendErrorDetails: rawErrorMessage,
		});

		fireEvent.click(screen.getByRole("button", { name: "Show error details" }));

		const dialog = screen.getByRole("dialog", { name: "Error details" });
		const details = screen.getByRole<HTMLPreElement>("textbox", { name: "Raw error message" });
		expect(details.textContent).toBe(rawErrorMessage);
		expect(details.style.getPropertyValue("--TextMonospaceBlock-max-height")).toBe("50vh");

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(dialog.hasAttribute("inert")).toBe(true);
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
			} satisfies ai_chat_UiMessage,
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

	test("shows Thinking while an empty assistant response is starting", () => {
		renderMessage({
			message: createAssistantMessage({ id: "msg_assistant_starting", text: " " }),
			isRunning: true,
		});

		expect(screen.getByText("Thinking").closest("[aria-busy='true']")).not.toBeNull();
	});

	test("removes the empty-response placeholder when assistant content arrives", () => {
		const messageId = "msg_assistant_streaming";
		const rendered = renderMessage({
			message: createAssistantMessage({ id: messageId, text: " " }),
			isRunning: true,
		});

		expect(screen.getByText("Thinking")).not.toBeNull();

		const streamingMessage = createAssistantMessage({ id: messageId, text: "Streaming response" });
		rendered.rerender(
			<AiChatMessage
				messageId={messageId}
				message={streamingMessage}
				selectedThreadId="thread_1"
				selectedModelId="gpt-5.4-nano"
				selectedModeId="ask"
				isRunning={true}
				liveJobs={[]}
				actions={hookMocks.actions}
			/>,
		);

		expect(screen.getByText("Streaming response")).not.toBeNull();
		expect(screen.queryByText("Thinking")).toBeNull();
	});

	test("shows a tool instead of keeping an empty reasoning placeholder", () => {
		const message = {
			id: "msg_assistant_tool_starting",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "" },
				{
					type: "tool-bash",
					toolCallId: "call_bash_starting",
					state: "input-streaming",
					input: { command: "pwd" },
				},
			],
			metadata: {
				convexParentId: "msg_user_failed",
				parentClientGeneratedId: null,
			},
		} satisfies ai_chat_UiMessage;

		renderMessage({ message, isRunning: true });

		expect(screen.getByRole("button", { name: "Bash: pwd" })).not.toBeNull();
		expect(screen.queryByText("Thinking")).toBeNull();
		expect(screen.queryByText("Thought")).toBeNull();
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
		expect(screen.queryByText("Thinking")).toBeNull();
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
			} satisfies ai_chat_UiMessage,
		});

		expect(screen.getByText("Bash:")).not.toBeNull();
		expect(screen.getByText("pwd")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Bash: pwd" })).not.toBeNull();
		fireEvent.click(screen.getByText("Bash:"));
		const terminal = screen.getByRole("textbox", { name: "Bash terminal output" });
		expect(terminal.textContent).toContain("$ pwd");
		expect(terminal.textContent).toContain(bashWorkspaceMount);
		expect(terminal.textContent).toContain(`next cwd: ${bashWorkspaceMount}\nexit: 0`);
		expect(screen.queryByRole("region", { name: "Metadata" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Stdout" })).toBeNull();
	});

	test("spins a finished bash tool while its jobs run, and stops when they end", () => {
		const bashMessage = {
			id: "msg_assistant_bash_jobs",
			role: "assistant",
			parts: [
				{
					type: "tool-bash",
					toolCallId: "call_bash_jobs",
					state: "output-available",
					input: { command: "sleep 30 &" },
					output: {
						title: "exit 0",
						output: "$ sleep 30 &",
						metadata: {
							command: "sleep 30 &",
							cwd: bashWorkspaceMount,
							nextCwd: bashWorkspaceMount,
							exitCode: 0,
							stdoutTruncated: false,
							stderrTruncated: false,
							stdoutLength: 0,
							stderrLength: 0,
							pathIndexTruncated: false,
							launchedJobNumbers: [1],
						},
					},
				},
			],
			metadata: {
				convexParentId: "msg_user_failed",
				parentClientGeneratedId: null,
			},
		} satisfies ai_chat_UiMessage;
		const liveJob = {
			jobNumber: 1,
			status: "running",
			shellName: "default",
			scriptPreview: "sleep 30",
			parentJobNumber: null,
			invocationId: "invocation_1" as AiChatMessage_Props["liveJobs"][number]["invocationId"],
			startedAt: Date.now(),
			finishedAt: undefined,
		} satisfies AiChatMessage_Props["liveJobs"][number];

		renderMessage({ message: bashMessage, liveJobs: [liveJob] });

		// The tool finished, so the card still opens on click, but its jobs keep the spinner.
		const button = screen.getByRole("button", { name: "Bash: sleep 30 &" });
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.getAttribute("aria-disabled")).toBe("false");
		expect(screen.getByRole("progressbar", { name: "Running" })).not.toBeNull();
		fireEvent.click(screen.getByText("Bash:"));
		expect(screen.getByRole("textbox", { name: "Bash terminal output" })).not.toBeNull();

		cleanup();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();

		renderMessage({ message: bashMessage, liveJobs: [] });

		expect(screen.getByRole("button", { name: "Bash: sleep 30 &" }).getAttribute("aria-busy")).toBe("false");
		expect(screen.queryByRole("progressbar", { name: "Running" })).toBeNull();

		cleanup();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();

		const otherLiveJob = {
			...liveJob,
			jobNumber: 2,
			invocationId: "invocation_2" as AiChatMessage_Props["liveJobs"][number]["invocationId"],
		};
		renderMessage({ message: bashMessage, liveJobs: [otherLiveJob] });
		expect(screen.getByRole("button", { name: "Bash: sleep 30 &" }).getAttribute("aria-busy")).toBe("false");
	});

	test("keeps an open tool output open when the streamed message is persisted", () => {
		const clientGeneratedId = "ai_message-client_1";
		const bashPart = {
			type: "tool-bash",
			toolCallId: "call_bash_persist",
			state: "output-available",
			input: { command: "pwd" },
			output: {
				title: `exit 0 · ${bashWorkspaceMount}`,
				output: bashWorkspaceMount,
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
		} satisfies ai_chat_UiMessage["parts"][number];

		// The controller stamps a live message's own id into metadata.clientGeneratedId.
		const streamingMessage = {
			id: clientGeneratedId,
			role: "assistant",
			parts: [bashPart],
			metadata: {
				convexParentId: "msg_user_failed",
				parentClientGeneratedId: null,
				clientGeneratedId,
			},
		} satisfies ai_chat_UiMessage;
		const rendered = renderMessage({ message: streamingMessage, isRunning: true });

		// jsdom does not toggle a details element from a summary click, so set the
		// user-toggled uncontrolled open state directly.
		const openedDetails = document.querySelector("details");
		expect(openedDetails).not.toBeNull();
		openedDetails!.open = true;

		// When the stream finishes, the persisted row replaces the streamed message: the
		// message id becomes the Convex id and the client id moves into metadata.
		const persistedMessage = {
			...streamingMessage,
			id: "msg_assistant_persisted",
			metadata: {
				...streamingMessage.metadata,
				convexId: "msg_assistant_persisted",
				clientGeneratedId,
			},
		} satisfies ai_chat_UiMessage;
		hookMocks.messageById.set(persistedMessage.id, persistedMessage);
		hookMocks.branchSiblingIdsByMessageId.set(persistedMessage.id, [persistedMessage.id]);
		rendered.rerender(
			withTenant(
				<AiChatMessage
					messageId={persistedMessage.id}
					message={persistedMessage}
					selectedThreadId="thread_1"
					selectedModelId="gpt-5.4-nano"
					selectedModeId="ask"
					isRunning={false}
					liveJobs={[]}
					actions={hookMocks.actions}
				/>,
			),
		);

		// The same DOM node must survive: a remount would recreate the details closed.
		expect(document.querySelector("details[open]")).toBe(openedDetails);
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
			} satisfies ai_chat_UiMessage,
		});

		expect(screen.getByRole("button", { name: "Execute code" })).not.toBeNull();
		// The old generic renderer leaked type/toolCallId/state pills; the dedicated one must not.
		expect(screen.queryByText(/toolCallId:/)).toBeNull();

		fireEvent.click(screen.getByText("Execute code"));
		expect(screen.getByRole("textbox", { name: "Code" }).textContent).toContain("return input.a + input.b;");
		expect(screen.getByRole("textbox", { name: "Input" }).textContent).toContain('"a": 12');
		expect(screen.getByRole("textbox", { name: "Result" }).textContent).toContain("Result: 21");
	});

	test.each(["saved", "private"] as const)("colors the edit_file diff and opens its %s target", (kind) => {
		// The tool already trimmed the patch down to the changed lines.
		const diff = [" {", '-	"n": 1', '+	"n": 2', " }", ""].join("\n");

		renderMessage({
			message: {
				id: "msg_assistant_edit_file",
				role: "assistant",
				parts: [
					{
						type: "tool-edit_file",
						toolCallId: "call_edit_file",
						state: "output-available",
						input: { path: "/qa.json", oldString: '"n": 1', newString: '"n": 2', replaceAll: false },
						output: {
							title: "/qa.json",
							metadata: {
								target:
									kind === "private"
										? { kind, id: "private_1" as app_convex_Id<"files_pending_nodes"> }
										: { kind, id: "node_1" as app_convex_Id<"files_nodes"> },
								pendingUpdateId: null,
								path: "/qa.json",
								matches: 1,
								matcher: "exact",
								diff,
							},
							output: "Replaced 1 occurrence",
						},
					},
				],
				metadata: {
					convexParentId: "msg_user_failed",
					parentClientGeneratedId: null,
				},
			} satisfies ai_chat_UiMessage,
		});

		fireEvent.click(screen.getByRole("button", { name: "Edit file: qa.json" }));
		expect(JSON.parse(screen.getByRole("link", { name: "Open file" }).getAttribute("data-search")!)).toEqual(
			kind === "private" ? { pendingNodeId: "private_1" } : { nodeId: "node_1" },
		);

		const result = screen.getByRole("textbox", { name: "Result" });
		expect(result.querySelector(".DiffMonospaceBlock-line-removed")?.textContent).toContain('"n": 1');
		expect(result.querySelector(".DiffMonospaceBlock-line-added")?.textContent).toContain('"n": 2');
		expect(result.querySelectorAll(".DiffMonospaceBlock-line-context").length).toBe(3);
	});

	test.each([
		{ state: "output-available", output: "Browser succeeded.", link: true, name: "links a live result" },
		{ state: "output-available", output: "Browser refused.", link: false, name: "hides the link on refusal" },
		{ state: "input-available", output: "Running…", link: false, name: "shows running before output" },
	] as const)("browser run card $name", ({ state, output, link }) => {
		if (link) {
			hookMocks.browserResultFile = { nodeId: "node_1", targetKind: "saved", expired: false };
		}
		const part =
			state === "output-available"
				? ({
						type: "tool-browser_run",
						toolCallId: "call_browser",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output,
							metadata:
								output === "Browser refused."
									? { status: "refused" }
									: { status: "succeeded", resultId: "result-1" },
						},
					} as const)
				: ({
						type: "tool-browser_run",
						toolCallId: "call_browser",
						state: "input-available",
						input: {},
					} as const);
		renderMessage({
			message: {
				id: "msg_assistant_browser",
				role: "assistant",
				parts: [part],
				metadata: {
					convexParentId: "msg_user_before",
					parentClientGeneratedId: null,
				},
			} satisfies ai_chat_UiMessage,
		});

		expect(screen.getByRole("button", { name: "Browser run" })).not.toBeNull();
		expect(screen.getByText(output)).not.toBeNull();
		if (link) {
			expect(screen.queryByRole("link", { name: "Open in Files" })).not.toBeNull();
		} else {
			expect(screen.queryByRole("link", { name: "Open in Files" })).toBeNull();
		}
	});

	test("Open browser asks the Files owner to open the exact result target", () => {
		hookMocks.browserResultFile = { nodeId: "node_1", targetKind: "saved", expired: false };
		const message = {
			id: "msg_browser_open",
			role: "assistant",
			parts: [
				{
					type: "tool-browser_run",
					toolCallId: "call_browser",
					state: "output-available",
					input: {},
					output: {
						title: "Browser run",
						output: "Browser succeeded.",
						metadata: { status: "succeeded", resultId: "result-1" },
					},
				},
			],
			metadata: { convexParentId: "msg_user_before", parentClientGeneratedId: null },
		} satisfies ai_chat_UiMessage;
		hookMocks.messageById.set(message.id, message);
		render(
			withTenant(
				<AiChatBrowserSurfaceProvider value="files">
					<AiChatMessage
						messageId={message.id}
						message={message}
						selectedThreadId="thread_1"
						selectedModelId="gpt-5.4-nano"
						selectedModeId="ask"
						isRunning={false}
						liveJobs={[]}
						actions={hookMocks.actions}
					/>
				</AiChatBrowserSurfaceProvider>,
			),
		);
		const opened = vi.fn();
		const stopListening = global_custom_event_listen("files::open_browser", (event) => opened(event.detail));
		fireEvent.click(screen.getByRole("link", { name: "Open browser" }));
		stopListening();
		expect(opened).toHaveBeenCalledWith({ membershipId: "membership-1", nodeId: "node_1", targetKind: "saved" });
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
			} satisfies ai_chat_UiMessage,
		});

		expect(screen.getByText("failed")).not.toBeNull();

		fireEvent.click(screen.getByText("Execute code"));
		expect(screen.getByRole("textbox", { name: "Error" }).textContent).toContain("Error: Error: boom");
		expect(screen.queryByRole("textbox", { name: "Result" })).toBeNull();
	});
});
