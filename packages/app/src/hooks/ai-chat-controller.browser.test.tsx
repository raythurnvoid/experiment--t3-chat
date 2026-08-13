// Unlike `ai-chat-controller.test.tsx`, this module runs the real `Chat`, `useChat`, and
// `DefaultChatTransport`. It fakes only Convex, auth, the tenant context, and the HTTP response.
// A mocked SDK cannot show that an SDK upgrade changed behavior.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { ai_chat_UiMessage, ai_chat_Thread } from "@/lib/ai-chat.ts";

const hookMocks = vi.hoisted(() => ({
	tenant: {
		membershipId: "membership_test",
		organizationId: "organization_test",
		workspaceId: "workspace_test",
	},
	threads: [] as Array<{ archived: boolean; [key: string]: unknown }>,
	threadMessages: [] as Array<{
		_id: string;
		parentId: string | null;
		clientGeneratedMessageId?: string | null;
		content: ai_chat_UiMessage;
	}>,
	mutation: vi.fn((): Promise<{ _yay: { threadId: string } }> => Promise.resolve({ _yay: { threadId: "thread_new" } })),
	// One scripted response per chat request, shifted in order. A test that scripts two responses
	// is asserting that the app made two requests.
	responses: [] as Array<() => Response>,
	requestBodies: [] as unknown[],
}));

vi.mock("convex/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("convex/react")>();

	return {
		...actual,
		usePaginatedQuery: (_query: unknown, args: { archived?: boolean } | "skip") => {
			if (args === "skip") {
				return { results: [], status: "Exhausted", loadMore: vi.fn() };
			}

			return {
				results: hookMocks.threads.filter((thread) => thread.archived === args.archived),
				status: "Exhausted",
				loadMore: vi.fn(),
			};
		},
		useMutation: () => hookMocks.mutation,
		useQuery: () => ({ messages: hookMocks.threadMessages }),
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

/**
 * Build the SSE body the AI SDK transport expects: one `data:` line per UI message chunk,
 * closed by the `[DONE]` sentinel.
 */
function sseResponse(chunks: Array<Record<string, unknown>>) {
	const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

	return new Response(`${lines}data: [DONE]\n\n`, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/**
 * This helper uses the same body format. The stream stays open until the test closes it.
 * Use it when the test has to act while the chat is still streaming.
 */
function openSseResponse() {
	const encoder = new TextEncoder();
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		write(chunk: Record<string, unknown>) {
			streamController.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
		},
		close() {
			streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
			streamController.close();
		},
	};
}

function createThread(id: string) {
	return {
		_id: id,
		_creationTime: 1,
		organizationId: hookMocks.tenant.organizationId,
		workspaceId: hookMocks.tenant.workspaceId,
		clientGeneratedId: `client_${id}`,
		title: "Persisted",
		archived: false,
		starred: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: "user_test",
		updatedBy: "user_test",
		updatedAt: 1,
		lastMessageAt: 1,
	} as ai_chat_Thread;
}

function RuntimeStreamProbe() {
	const controller = AiChatController.useThreadRuntime();
	const selectedThreadId = controller.selectedThreadId;
	const assistantMessage = controller.activeBranchMessages.list.findLast((message) => message.role === "assistant");
	const toolParts = (assistantMessage?.parts ?? []).filter((part) => part.type.startsWith("tool-"));

	return (
		<div>
			<div data-testid="chat-id">{controller.session?.chat?.id ?? "null"}</div>
			<div data-testid="running">{controller.isRunning ? "yes" : "no"}</div>
			<div data-testid="error">{controller.error?.message ?? "null"}</div>
			<div data-testid="queue-paused">{controller.isMessageQueuePaused ? "yes" : "no"}</div>
			<div data-testid="queued">{controller.queuedUserMessages.length}</div>
			<div data-testid="assistant-text">
				{(assistantMessage?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")}
			</div>
			<div data-testid="tool-parts">
				{toolParts.map((part) => `${part.type}:${"state" in part ? part.state : ""}`).join("|")}
			</div>
			<div data-testid="tool-output">
				{toolParts.map((part) => ("output" in part && part.output ? JSON.stringify(part.output) : "")).join("|")}
			</div>
			<button type="button" onClick={() => controller.startNewChat()}>
				new chat
			</button>
			<button type="button" onClick={() => controller.selectThread("thread_persisted")}>
				select persisted
			</button>
			<button
				type="button"
				onClick={() => {
					if (selectedThreadId) {
						controller.sendUserText(selectedThreadId, "Hi");
					}
				}}
			>
				send
			</button>
			<button
				type="button"
				onClick={() => {
					if (selectedThreadId) {
						controller.sendUserText(selectedThreadId, "Queued");
					}
				}}
			>
				queue
			</button>
			<button type="button" onClick={() => controller.stop()}>
				stop
			</button>
		</div>
	);
}

function renderRuntime() {
	const storageKey: AiChatControllerStorageKey = `app_state::ai_chat_last_open::scope::${hookMocks.tenant.membershipId}`;

	return render(
		<AiChatController key={storageKey} storageKey={storageKey}>
			<RuntimeStreamProbe />
		</AiChatController>,
	);
}

describe("AiChatController streaming against the real AI SDK", () => {
	beforeEach(() => {
		hookMocks.tenant.membershipId = `membership_${crypto.randomUUID()}`;
		hookMocks.threads = [];
		hookMocks.threadMessages = [];
		hookMocks.responses = [];
		hookMocks.requestBodies = [];
		hookMocks.mutation.mockReset().mockResolvedValue({ _yay: { threadId: "thread_new" } });

		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				hookMocks.requestBodies.push(JSON.parse(String(init?.body ?? "null")));
				const next = hookMocks.responses.shift();
				if (!next) {
					throw new Error("The test did not script a response for this chat request");
				}

				return next();
			}),
		);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("streams text deltas into one assistant message and returns to ready", async () => {
		hookMocks.responses.push(() =>
			sseResponse([
				{ type: "start" },
				{ type: "start-step" },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "Hello" },
				{ type: "text-delta", id: "t1", delta: " world" },
				{ type: "text-end", id: "t1" },
				{ type: "finish-step" },
				{ type: "finish" },
			]),
		);

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));
		await userEvent.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(screen.getByTestId("running").textContent).toBe("no");
		});
		expect(screen.getByTestId("assistant-text").textContent).toBe("Hello world");
		expect(screen.getByTestId("error").textContent).toBe("null");
	});

	test("moves a tool part from input-streaming to output-available", async () => {
		hookMocks.responses.push(() =>
			sseResponse([
				{ type: "start" },
				{ type: "start-step" },
				{ type: "tool-input-start", toolCallId: "call_1", toolName: "bash" },
				{ type: "tool-input-delta", toolCallId: "call_1", inputTextDelta: '{"command":"ls"}' },
				{ type: "tool-input-available", toolCallId: "call_1", toolName: "bash", input: { command: "ls" } },
				{ type: "tool-output-available", toolCallId: "call_1", output: { stdout: "notes.md" } },
				{ type: "finish-step" },
				{ type: "finish" },
			]),
		);

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));
		await userEvent.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(screen.getByTestId("running").textContent).toBe("no");
		});
		expect(screen.getByTestId("tool-parts").textContent).toBe("tool-bash:output-available");
		expect(screen.getByTestId("tool-output").textContent).toBe('{"stdout":"notes.md"}');
	});

	test("shows the error text the server sent instead of a generic message", async () => {
		hookMocks.responses.push(() =>
			sseResponse([
				{ type: "start" },
				{ type: "start-step" },
				{ type: "error", errorText: "The model refused the request" },
			]),
		);

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));
		await userEvent.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(screen.getByTestId("error").textContent).toBe("The model refused the request");
		});
	});

	test("overwrites the chat id when the server sends the persisted thread id", async () => {
		hookMocks.responses.push(() =>
			sseResponse([
				{ type: "start" },
				{ type: "data-thread-id", data: { threadId: "thread_persisted" }, transient: true },
				{ type: "start-step" },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "ok" },
				{ type: "text-end", id: "t1" },
				{ type: "finish-step" },
				{ type: "finish" },
			]),
		);

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));
		expect(screen.getByTestId("chat-id").textContent).toMatch(/^ai_thread-/u);

		await userEvent.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(screen.getByTestId("chat-id").textContent).toBe("thread_persisted");
		});
	});

	test("waits out a 429 inside the same request and keeps one assistant turn", async () => {
		hookMocks.responses.push(
			() =>
				new Response(JSON.stringify({ retryAfterMs: 10 }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				}),
		);
		hookMocks.responses.push(() =>
			sseResponse([
				{ type: "start" },
				{ type: "start-step" },
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "after the wait" },
				{ type: "text-end", id: "t1" },
				{ type: "finish-step" },
				{ type: "finish" },
			]),
		);

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));
		await userEvent.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(screen.getByTestId("running").textContent).toBe("no");
		});
		expect(hookMocks.requestBodies).toHaveLength(2);
		expect(screen.getByTestId("assistant-text").textContent).toBe("after the wait");
		expect(screen.getByTestId("error").textContent).toBe("null");
	});

	test("ignores Stop while the chat is idle", async () => {
		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "new chat" }));

		await userEvent.click(screen.getByRole("button", { name: "stop" }));

		expect(screen.getByTestId("running").textContent).toBe("no");
		expect(screen.getByTestId("error").textContent).toBe("null");
		// No request was scripted, so a Stop that reached the transport would have thrown.
		expect(hookMocks.requestBodies).toHaveLength(0);
	});

	test("fails the request when the finish callback throws", async () => {
		hookMocks.threads = [createThread("thread_persisted")];
		const live = openSseResponse();
		hookMocks.responses.push(() => live.response);
		// If this request finished cleanly, the queued message would start and find no scripted
		// response. That failure would look like the one this test wants. So script a second turn.
		hookMocks.responses.push(() => sseResponse([{ type: "start" }, { type: "finish" }]));

		renderRuntime();
		await userEvent.click(screen.getByRole("button", { name: "select persisted" }));
		await userEvent.click(screen.getByRole("button", { name: "send" }));
		live.write({ type: "start" });
		live.write({ type: "start-step" });
		live.write({ type: "text-start", id: "t1" });
		live.write({ type: "text-delta", id: "t1", delta: "streamed" });
		await waitFor(() => {
			expect(screen.getByTestId("running").textContent).toBe("yes");
		});

		await userEvent.click(screen.getByRole("button", { name: "queue" }));
		await waitFor(() => {
			expect(screen.getByTestId("queued").textContent).toBe("1");
		});

		// `markThreadRead` runs inside the controller's `onFinish` for the selected persisted thread.
		// Make that mutation throw only now, so the earlier mutations in this flow still succeed.
		// AI SDK 5 swallowed a throw from `onFinish`. AI SDK 6 lets that throw reject the request.
		// A rejected request pauses the queue.
		hookMocks.mutation.mockImplementation(() => {
			throw new Error("mark read failed");
		});
		live.write({ type: "text-end", id: "t1" });
		live.write({ type: "finish-step" });
		live.write({ type: "finish" });
		live.close();

		await waitFor(() => {
			expect(screen.getByTestId("queue-paused").textContent).toBe("yes");
		});
		// The streamed text survives the throw. Only the request is marked failed.
		expect(screen.getByTestId("assistant-text").textContent).toBe("streamed");
	});
});
