import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ai_chat_UiMessage } from "@/lib/ai-chat.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { AiChatMessage, AiChatMessagePendingAssistant, type AiChatMessage_Props } from "./ai-chat-message.tsx";
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
		// Files answers one target at a time: undefined while the query loads, and null when this reader
		// may not open that file.
		useQuery: (_reference: unknown, args: { target: { id: string } }) => hookMocks.files.get(args.target.id),
	};
});

const hookMocks = vi.hoisted(() => {
	return {
		messageById: new Map<string, ai_chat_UiMessage>(),
		branchSiblingIdsByMessageId: new Map<string, readonly string[]>(),
		editingMessageId: null as string | null,
		sendErrorMessageId: null as string | null,
		sendErrorDetails: null as string | null,
		files: new Map<
			string,
			{
				entry: { kind: "saved" | "private"; path: string; node: { _id: string; archiveOperationId?: string | null } };
				readiness: "ready" | "preparing";
			} | null
		>(),
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
	Link: function Link(props: {
		children?: ReactNode;
		to?: string;
		search?: unknown;
		onClick?: MouseEventHandler<HTMLAnchorElement>;
	}) {
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
		hookMocks.files.clear();
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

	// The SDK has two shapes for a tool part. A stored part may also arrive as "dynamic-tool" instead
	// of "tool-<name>". Both must reach the same renderer, so neither one falls back to raw JSON.
	test.each(["tool-execute_code", "dynamic-tool"] as const)(
		"%s renders sections and eight ordinary file links",
		(type) => {
			const files = Array.from({ length: 8 }, (_, index) => ({ kind: "private" as const, id: `private_${index}` }));
			for (const target of files) {
				hookMocks.files.set(target.id, {
					entry: { kind: "private", path: `/exports/${target.id}.bin`, node: { _id: target.id } },
					readiness: "ready",
				});
			}

			renderMessage({
				message: {
					id: "msg_assistant_execute_code",
					role: "assistant",
					parts: [
						{
							type,
							toolName: "execute_code",
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
									fileResult: null,
									files,
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

			// Emitted files are ordinary Files links. The chat never shows their bytes as a picture.
			expect(screen.getAllByRole("link", { name: "Open in Files" })).toHaveLength(8);
			expect(screen.queryByRole("img")).toBeNull();
			// The old generic renderer leaked type/toolCallId/state pills; the dedicated one must not.
			expect(screen.queryByText(/toolCallId:/)).toBeNull();

			fireEvent.click(screen.getByText("Execute code"));
			expect(screen.getByRole("textbox", { name: "Code" }).textContent).toContain("return input.a + input.b;");
			expect(screen.getByRole("textbox", { name: "Input" }).textContent).toContain('"a": 12');
			expect(screen.getByRole("textbox", { name: "Result" }).textContent).toContain("Result: 21");
		},
	);

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

	test.each(["tool-image_generation", "dynamic-tool"] as const)(
		"%s uses a normal Files link without an inline image",
		(type) => {
			hookMocks.files.set("private_generated", {
				entry: { kind: "private", path: "/images/drawing.webp", node: { _id: "private_generated" } },
				readiness: "ready",
			});

			renderMessage({
				message: {
					...createAssistantMessage(),
					parts: [
						{
							type,
							toolName: "image_generation",
							toolCallId: "generated_1",
							state: "output-available",
							input: {},
							output: {
								title: "Generate image",
								output: "Generate image: succeeded.",
								metadata: { status: "succeeded", reason: null, files: [{ kind: "private", id: "private_generated" }] },
							},
						},
					],
				},
			});

			expect(screen.getByRole("button", { name: "Generate image" })).toBeTruthy();

			// A generated picture is a private pending file like any other. The chat shows its path and a
			// link, never the picture itself and never the parameters the model sent.
			expect(screen.getByText("/images/drawing.webp · Pending review")).toBeTruthy();
			expect(JSON.parse(screen.getByRole("link", { name: "Open in Files" }).getAttribute("data-search")!)).toEqual({
				pendingNodeId: "private_generated",
			});
			expect(screen.queryByRole("img")).toBeNull();
			expect(screen.queryByText("Parameters")).toBeNull();
		},
	);

	test.each([
		{ state: "output-available", output: "Browser succeeded.", link: true, name: "links a live result" },
		{
			state: "output-available",
			output: "Browser failed. The file is no longer available.",
			link: false,
			name: "hides the link on refusal",
		},
		{ state: "input-available", output: "Running…", link: false, name: "shows running before output" },
	] as const)("browser run card $name", ({ state, output, link }) => {
		if (link) {
			hookMocks.files.set("node_1", {
				entry: { kind: "saved", path: "/tmp/browser/image.png", node: { _id: "node_1", archiveOperationId: null } },
				readiness: "ready",
			});
		}

		const part: ai_chat_UiMessage["parts"][number] =
			state === "output-available"
				? {
						type: "tool-browser_run",
						toolCallId: "call_browser",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: link ? "Browser run: succeeded." : "Browser run: errored.",
							metadata: !link
								? { status: "errored", reason: "unavailable", files: [] }
								: { status: "succeeded", reason: null, files: [{ kind: "saved", id: "node_1" }] },
						},
					}
				: {
						type: "tool-browser_run",
						toolCallId: "call_browser",
						state: "input-available",
						input: {},
					};

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

	// The chat builds each sentence from the status word alone. Raw tool text, such as browser
	// observations or file contents, never reaches the message.
	test.each([
		["succeeded", "Browser succeeded."],
		["errored", "Browser failed."],
		["timed_out", "Browser timed out."],
		["cancelled", "Browser stopped."],
		["partial", "Browser partly completed."],
	] as const)("browser status %s uses plain text", (status, expected) => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "status_1",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: `Browser run: ${status}.`,
							metadata: { status, reason: null, files: [] },
						},
					},
				],
			},
		});
		expect(screen.getByText(expected)).toBeTruthy();
	});

	// The same status word reads differently per tool. A file tool says "File", a browser tool says
	// "Browser".
	test.each(["tool-view_image", "dynamic-tool"] as const)("%s shows a safe image-view result", (type) => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type,
						toolName: "view_image",
						toolCallId: "read_status_1",
						state: "output-available",
						input: {},
						output: {
							title: "View image",
							output: "View image: succeeded.",
							metadata: { status: "succeeded", reason: null, files: [] },
						},
					},
				],
			},
		});
		expect(screen.getByText("File succeeded.")).toBeTruthy();
		expect(screen.queryByText("Browser succeeded.")).toBeNull();
	});

	// The message stores the target the tool created. The first one was saved since then, so Files
	// answers with the saved node. The link must follow the file where it is now.
	test("two captures use authorized current targets and ordinary Files links", () => {
		hookMocks.files.set("private_1", {
			entry: { kind: "saved", path: "/moved/capture.png", node: { _id: "node_1", archiveOperationId: null } },
			readiness: "ready",
		});
		hookMocks.files.set("private_2", {
			entry: { kind: "private", path: "/tmp/browser/second.png", node: { _id: "private_2" } },
			readiness: "ready",
		});
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
						output: "Browser run: succeeded.",
						metadata: {
							status: "succeeded",
							reason: null,
							files: [
								{ kind: "private", id: "private_1" },
								{ kind: "private", id: "private_2" },
							],
						},
					},
				},
			],
			metadata: { convexParentId: "msg_user_before", parentClientGeneratedId: null },
		} satisfies ai_chat_UiMessage;

		renderMessage({ message });

		const links = screen.getAllByRole("link", { name: "Open in Files" });
		expect(links.map((link) => JSON.parse(link.getAttribute("data-search")!))).toEqual([
			{ nodeId: "node_1" },
			{ pendingNodeId: "private_2" },
		]);
		expect(screen.getByText("/moved/capture.png · Saved")).toBeTruthy();
		expect(screen.getByText("/tmp/browser/second.png · Pending review")).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
	});

	// A client can send a tool part with any tool name, in any letter case, and any output inside it.
	// Every name below must reach the safe card, so a forged part cannot print its own text in chat.
	test.each([
		"browser_run",
		"browser_reload",
		"browser_close",
		"view_image",
		"image_generation",
		"Browser_Run",
		"View_Image",
		"Image_Generation",
	])("dynamic %s never renders raw parameters or output", (toolName) => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "dynamic-tool",
						toolName,
						toolCallId: "dynamic_1",
						state: "output-available",
						input: { code: "secret parameters" },
						output: { image: "data:image/png;base64,secret" },
					},
				],
			},
		});

		expect(screen.getByText("Output is no longer available.")).toBeTruthy();
		expect(screen.queryByText("Parameters")).toBeNull();
		expect(screen.queryByText(/secret/)).toBeNull();
	});

	// Each file row asks Files whether this reader may open that file right now. A denied or archived
	// file gets the same neutral line, so the chat never says which of the two it was.
	test.each(["denied", "archived"])("file reads show a neutral placeholder for a %s file", (state) => {
		hookMocks.files.set(
			"private_1",
			state === "denied"
				? null
				: {
						entry: { kind: "saved", path: "/old.png", node: { _id: "node_1", archiveOperationId: "archive_1" } },
						readiness: "ready",
					},
		);
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "dynamic-tool",
						toolName: "view_image",
						toolCallId: "read_1",
						state: "output-available",
						input: {},
						output: {
							title: "View image",
							output: "View image: succeeded.",
							metadata: { status: "succeeded", reason: null, files: [{ kind: "private", id: "private_1" }] },
						},
					},
				],
			},
		});

		expect(screen.getByText("This file is no longer available.")).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.queryByText("Parameters")).toBeNull();
	});

	// The server rewrites every file tool result into one exact title and status sentence. This part
	// has the right field names but its own text, so it is an old or forged result and must not show.
	test.each(["browser_run", "view_image", "image_generation"])(
		"%s rejects raw strings inside a valid output shape",
		(toolName) => {
			renderMessage({
				message: {
					...createAssistantMessage(),
					parts: [
						{
							type: "dynamic-tool",
							toolName,
							toolCallId: "raw_1",
							state: "output-available",
							input: {},
							output: {
								title: "RAW secret title",
								output: "secret observations",
								metadata: { status: "succeeded", reason: null, files: [] },
							},
						},
					],
				},
			});

			expect(screen.getByText("Output is no longer available.")).toBeTruthy();
			expect(screen.queryByText(/secret/)).toBeNull();
		},
	);

	test("keeps successful code output when only some files were prepared", () => {
		hookMocks.files.set("private_code", {
			entry: { kind: "private", path: "/reports/result.bin", node: { _id: "private_code" } },
			readiness: "ready",
		});
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-execute_code",
						toolCallId: "partial_files",
						state: "output-available",
						input: { code: "return 42;" },
						output: {
							title: "Execute code",
							output: "42",
							metadata: {
								executionId: "exec_partial",
								status: "succeeded",
								elapsedMs: 3,
								resultTruncated: false,
								logsTruncated: false,
								files: [{ kind: "private", id: "private_code" }],
								fileResult: {
									title: "Files",
									output: "Files: partial.",
									metadata: { status: "partial", reason: "storage", files: [{ kind: "private", id: "private_code" }] },
								},
							},
						},
					},
				],
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Execute code" }));
		expect(screen.getByRole("textbox", { name: "Result" }).textContent).toBe("42");
		expect(screen.getByText("Files partly completed. Some files could not be prepared.")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open in Files" })).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Error" })).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
	});

	test("browser run success renders debug sections and files without a badge", () => {
		hookMocks.files.set("private_1", {
			entry: { kind: "private", path: "/reports/page.png", node: { _id: "private_1" } },
			readiness: "ready",
		});
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "browser_debug_1",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: "Browser run: succeeded.",
							metadata: {
								status: "succeeded",
								reason: null,
								files: [{ kind: "private", id: "private_1" }],
								debug: {
									code: "return 1;",
									resultText: '{"ok":true}',
									consoleText: "log line",
									pageErrorsText: "page boom",
								},
							},
						},
					},
				],
			},
		});

		expect(screen.getByRole("button", { name: "Browser run" })).toBeTruthy();
		expect(screen.queryByText("failed")).toBeNull();
		fireEvent.click(screen.getByText("Browser run"));
		expect(screen.getByRole("textbox", { name: "Code" }).textContent).toContain("return 1;");
		expect(screen.getByRole("textbox", { name: "Result" }).textContent).toContain('{"ok":true}');
		expect(screen.getByRole("textbox", { name: "Console" }).textContent).toContain("log line");
		expect(screen.getByRole("textbox", { name: "Page errors" }).textContent).toContain("page boom");
		expect(screen.queryByRole("textbox", { name: "Error" })).toBeNull();
		expect(screen.getByRole("link", { name: "Open in Files" })).toBeTruthy();
		expect(screen.queryByRole("img")).toBeNull();
	});

	test("browser run failure shows a red failed badge and error", () => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "browser_fail_1",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: "Browser run: errored.",
							metadata: {
								status: "errored",
								reason: "execution",
								files: [],
								debug: { code: "throw 1;", errorText: "boom failed" },
							},
						},
					},
				],
			},
		});

		expect(screen.getByText("failed")).toBeTruthy();
		fireEvent.click(screen.getByText("Browser run"));
		expect(screen.getByRole("textbox", { name: "Error" }).textContent).toContain("boom failed");
		expect(screen.getByRole("textbox", { name: "Code" }).textContent).toContain("throw 1;");
	});

	test.each(["errored", "timed_out"] as const)("browser run %s maps to a failed header badge", (status) => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: `browser_badge_${status}`,
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: `Browser run: ${status}.`,
							metadata: { status, reason: "execution", files: [] },
						},
					},
				],
			},
		});

		expect(screen.getByText("failed")).toBeTruthy();
	});

	test("browser run loading shows spinner and busy state", () => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [{ type: "tool-browser_run", toolCallId: "browser_loading", state: "input-available", input: {} }],
			},
			isRunning: true,
		});

		const button = screen.getByRole("button", { name: "Browser run" });
		expect(button.getAttribute("aria-busy")).toBe("true");
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(screen.getByRole("progressbar", { name: "Running" })).toBeTruthy();
		expect(screen.getByText("Running…")).toBeTruthy();
	});

	test.each(["output-error", "output-denied"] as const)("browser run %s shows a safe fallback", (state) => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					state === "output-error"
						? {
								type: "tool-browser_run",
								toolCallId: "browser_fw",
								state,
								input: {},
								errorText: "framework boom",
							}
						: {
								type: "tool-browser_run",
								toolCallId: "browser_fw",
								state,
								input: {},
								approval: { id: "approval-1", approved: false },
							},
				],
			},
		});

		expect(screen.getByText("The request could not finish.")).toBeTruthy();
		expect(screen.queryByText("framework boom")).toBeNull();
	});

	test("browser reload with files falls back while valid reload shows status only", () => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_reload",
						toolCallId: "reload_bad",
						state: "output-available",
						input: {},
						output: {
							title: "Browser reload",
							output: "Browser reload: succeeded.",
							metadata: { status: "succeeded", reason: null, files: [{ kind: "private", id: "private_1" }] },
						},
					},
				],
			},
		});
		expect(screen.getByText("Output is no longer available.")).toBeTruthy();

		cleanup();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_reload",
						toolCallId: "reload_good",
						state: "output-available",
						input: {},
						output: {
							title: "Browser reload",
							output: "Browser reload: errored.",
							metadata: {
								status: "errored",
								reason: "stale",
								files: [],
								debug: { errorText: "stale lease, try again" },
							},
						},
					},
				],
			},
		});
		expect(screen.getByText("failed")).toBeTruthy();
		fireEvent.click(screen.getByText("Browser reload"));
		expect(screen.getByRole("textbox", { name: "Error" }).textContent).toContain("stale lease");
		expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
	});

	test("browser card never renders forged input, lease markers, or image data", () => {
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "dynamic-tool",
						toolName: "browser_run",
						toolCallId: "browser_forged",
						state: "output-available",
						input: { code: "forged-secret-code" },
						output: {
							title: "Browser run",
							output: "Browser run: succeeded.",
							metadata: {
								status: "succeeded",
								reason: null,
								files: [],
								debug: { code: "safe-debug-code" },
							},
						},
					},
				],
			},
		});

		// The card never reads `part.input`: forged input code must not render,
		// while the valid stored debug path still renders after opening.
		expect(screen.queryByText("forged-secret-code")).toBeNull();
		fireEvent.click(screen.getByText("Browser run"));
		expect(screen.queryByText("forged-secret-code")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Code" }).textContent).toBe("safe-debug-code");

		cleanup();
		hookMocks.messageById.clear();
		hookMocks.branchSiblingIdsByMessageId.clear();
		renderMessage({
			message: {
				...createAssistantMessage(),
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "browser_markers",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: "Browser run: succeeded.",
							metadata: {
								status: "succeeded",
								reason: null,
								files: [],
								debug: {
									code: "return 1;",
									resultText: "[browser-source:leak] [file-read:leak] data:image/png;base64,LEAK",
								},
							},
						},
					},
				],
			},
		});
		fireEvent.click(screen.getByText("Browser run"));
		expect(screen.queryByText(/browser-source:/)).toBeNull();
		expect(screen.queryByText(/file-read:/)).toBeNull();
		expect(screen.queryByText(/data:image/)).toBeNull();
		expect(screen.queryByRole("img")).toBeNull();
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
								fileResult: null,
								files: [],
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
