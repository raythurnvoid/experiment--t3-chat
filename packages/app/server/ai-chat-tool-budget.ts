import type { ToolSet } from "ai";

const encoder = new TextEncoder();
// One tool call's serialized input cap.
const TOOL_INPUT_MAX_BYTES = 64 * 1024;
// Headroom inside the run budget kept for tool results, so inputs can never spend it all.
const TOOL_RESULT_RESERVED_BYTES = 128 * 1024;

function serialized_bytes(value: unknown) {
	return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
}

export function ai_chat_message_fits_storage(message: unknown) {
	// Leave room for the Convex document fields around the UI message.
	return serialized_bytes(message) <= 900 * 1024;
}

export function ai_chat_tool_budget_create() {
	return { remainingBytes: 384 * 1024, exhausted: false };
}

export function ai_chat_tool_budget_apply<T extends ToolSet>(
	tools: T,
	budget: ReturnType<typeof ai_chat_tool_budget_create>,
) {
	for (const value of Object.values(tools)) {
		const execute = value.execute;
		if (!execute) continue;

		value.execute = async (input, options) => {
			const inputBytes = serialized_bytes(input);
			// Reserve before awaiting: parallel calls cannot spend another call's result space.
			// A file result repeats its path in both the title and metadata.
			const reservedBytes = TOOL_RESULT_RESERVED_BYTES + 2 * inputBytes;
			if (budget.exhausted || inputBytes > TOOL_INPUT_MAX_BYTES || budget.remainingBytes < inputBytes + reservedBytes) {
				budget.exhausted = true;
				throw new Error("Tool budget reached. This call was not run. Finish this reply and continue in a new message.");
			}
			budget.remainingBytes -= inputBytes + reservedBytes;

			try {
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
			}
		};
	}
	return tools;
}
