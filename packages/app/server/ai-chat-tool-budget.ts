import type { ToolSet } from "ai";

const encoder = new TextEncoder();
// One tool call's serialized input cap.
const TOOL_INPUT_MAX_BYTES = 64 * 1024;

function serialized_bytes(value: unknown) {
	return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
}

// Leave room for the Convex document fields around the UI message.
export const ai_chat_MESSAGE_MAX_BYTES = 900 * 1024;

export function ai_chat_message_fits_storage(message: unknown) {
	return serialized_bytes(message) <= ai_chat_MESSAGE_MAX_BYTES;
}

export function ai_chat_tool_budget_create() {
	return {
		remainingBytes: 384 * 1024,
		reservedInFlightBytes: 0,
		/**
		 * Set when a call was refused or cut for space. The route then makes the next step the last one.
		 */
		exhausted: false,
		/**
		 * Calls waiting for space, oldest first. Waiting calls hold no space.
		 */
		queue: [] as Array<{ costBytes: number; reservedBytes: number; admit: (admitted: boolean) => void }>,
		/**
		 * Tool calls of a step that Stop reached before its step doc was planned. None of them may start.
		 */
		stoppedToolCallIds: new Set<string>(),
	};
}

/**
 * Give space to the waiting calls in order. A new call never passes a waiting call.
 */
function admit_waiting_calls(budget: ReturnType<typeof ai_chat_tool_budget_create>) {
	while (budget.queue.length > 0) {
		const head = budget.queue[0]!;
		// Reserve for the head before it wakes, so a call that starts later cannot take its space.
		if (budget.remainingBytes >= head.costBytes) {
			budget.queue.shift();
			budget.remainingBytes -= head.costBytes;
			budget.reservedInFlightBytes += head.reservedBytes;
			head.admit(true);
			continue;
		}
		// The head cannot fit even after every running call gives its reserve back. Refuse it and
		// look at the next call, which may be smaller.
		if (budget.remainingBytes + budget.reservedInFlightBytes < head.costBytes) {
			budget.queue.shift();
			budget.exhausted = true;
			head.admit(false);
			continue;
		}
		return;
	}
}

/**
 * Wait in the queue until the call has space. Resolves `"refused"` when it can never fit and
 * `"stopped"` when Stop lands while it waits.
 */
function wait_for_space(
	budget: ReturnType<typeof ai_chat_tool_budget_create>,
	args: { costBytes: number; reservedBytes: number; abortSignal: AbortSignal | undefined },
) {
	return new Promise<"admitted" | "refused" | "stopped">((resolve) => {
		const waiter = {
			costBytes: args.costBytes,
			reservedBytes: args.reservedBytes,
			admit: (admitted: boolean) => {
				args.abortSignal?.removeEventListener("abort", handleAbort);
				resolve(admitted ? "admitted" : "refused");
			},
		};
		const handleAbort = () => {
			const index = budget.queue.indexOf(waiter);
			if (index === -1) return;
			budget.queue.splice(index, 1);
			resolve("stopped");
			// The next call may fit now that this one left the head.
			admit_waiting_calls(budget);
		};
		args.abortSignal?.addEventListener("abort", handleAbort, { once: true });
		budget.queue.push(waiter);
		admit_waiting_calls(budget);
	});
}

export function ai_chat_tool_budget_apply<T extends ToolSet>(
	tools: T,
	budget: ReturnType<typeof ai_chat_tool_budget_create>,
	reserve: {
		/**
		 * Result space each call of these tools keeps inside the reply budget, so inputs can never spend it all.
		 */
		resultReservedBytes: number;
	},
) {
	for (const value of Object.values(tools)) {
		const execute = value.execute;
		if (!execute) continue;

		value.execute = async (input, options) => {
			// Stop can land while the receipt middleware holds the finish part to save usage. The SDK
			// still starts the tool calls of that step afterwards, and some tools ignore the signal.
			// So check Stop here, before any tool body runs.
			if (options.abortSignal?.aborted || budget.stoppedToolCallIds.has(options.toolCallId)) {
				throw new Error("Stopped. This call was not run.");
			}

			const inputBytes = serialized_bytes(input);
			// Reserve before running: parallel calls cannot spend another call's result space.
			// A file result repeats its path in both the title and metadata.
			const reservedBytes = reserve.resultReservedBytes + 2 * inputBytes;
			const admission =
				inputBytes > TOOL_INPUT_MAX_BYTES
					? "refused"
					: await wait_for_space(budget, {
							costBytes: inputBytes + reservedBytes,
							reservedBytes,
							abortSignal: options.abortSignal,
						});
			if (admission === "stopped") {
				throw new Error("Stopped. This call was not run.");
			}
			if (admission === "refused") {
				budget.exhausted = true;
				throw new Error("Tool budget reached. This call was not run. Finish this reply and continue in a new message.");
			}

			try {
				// A queued call can wake after Stop. Check again so no body runs after Stop.
				if (options.abortSignal?.aborted) {
					throw new Error("Stopped. This call was not run.");
				}

				// App tools all return this shape. Provider tools have no local execute function.
				const result = (await execute(input, options)) as {
					title: string;
					output: string;
					metadata: Record<string, unknown>;
					instructions?: string;
				};
				const availableBytes = reservedBytes + budget.remainingBytes;
				if (serialized_bytes(result) > availableBytes) {
					budget.exhausted = true;
					// Keep the real outcome and guidance. Only the display preview may be omitted.
					if (typeof result.metadata.diff === "string") {
						result.metadata.diff = "[Diff preview omitted: this reply reached its tool budget.]";
					}
					// The model reads this flag of an MCP result to know that its output was cut.
					if (result.metadata.kind === "mcp_result") {
						result.metadata.truncated = true;
					}
					const output = result.output;
					let start = 0;
					let end = output.length;
					while (start < end) {
						const middle = Math.ceil((start + end) / 2);
						result.output = `${output.slice(0, middle)}\n[Output preview truncated: this reply reached its tool budget.]`;
						if (serialized_bytes(result) <= availableBytes) start = middle;
						else end = middle - 1;
					}
					result.output = `${output.slice(0, start)}\n[Output preview truncated: this reply reached its tool budget.]`;
				}
				budget.remainingBytes += reservedBytes - serialized_bytes(result);
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const boundedError = new Error(
					message.length <= 2048 ? message : `${message.slice(0, 2048)}\n[Error truncated.]`,
					{ cause: error },
				);
				budget.remainingBytes += reservedBytes - serialized_bytes(boundedError.message);
				throw boundedError;
			} finally {
				budget.reservedInFlightBytes -= reservedBytes;
				admit_waiting_calls(budget);
			}
		};
	}
	return tools;
}
