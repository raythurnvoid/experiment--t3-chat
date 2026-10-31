import z from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { files_STORED_PATH_MAX_LENGTH } from "./files.ts";

/**
 * What the user had open in the app when they sent a message. The app adds it to the message as one
 * `data-ui-context` part, and the model reads it as a `<ui_context>` block.
 *
 * The server checks `node.fileNodeId` and replaces `path` and `kind` with the saved values, so the
 * browser's copy is never trusted. A null `fileNodeId` is the workspace root, or a node the reader
 * can no longer open (history reads clear it, like file quotes).
 */
export const ai_chat_ui_context_schema = z
	.object({
		node: z
			.object({
				fileNodeId: z.string().min(1).max(128).nullable(),
				path: z.string().min(1).max(files_STORED_PATH_MAX_LENGTH),
				kind: z.enum(["file", "folder"]),
			})
			.strict()
			.nullable(),
		/**
		 * The name of the shown view, as the view picker shows it, for example "Rich text".
		 */
		view: z.string().min(1).max(200).nullable(),
		plugin: z
			.object({
				pluginName: z.string().min(1).max(64),
				title: z.string().min(1).max(200),
				kind: z.enum(["page", "file_view"]),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.refine((context) => context.node !== null || context.plugin !== null);

export type ai_chat_UiContext = z.infer<typeof ai_chat_ui_context_schema>;

export const ai_chat_ui_context_part_schema = z
	.object({
		type: z.literal("data-ui-context"),
		data: ai_chat_ui_context_schema,
		id: z.string().optional(),
	})
	.strict();

/**
 * Check the shape of the `data-ui-context` parts of a sent message. A message has at most one.
 */
export function ai_chat_ui_context_validate_parts(parts: unknown) {
	if (!Array.isArray(parts)) return Result({ _nay: { message: "Invalid message parts" } });
	const contexts: ai_chat_UiContext[] = [];
	for (const part of parts as unknown[]) {
		if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-ui-context") continue;
		const parsed = ai_chat_ui_context_part_schema.safeParse(part);
		if (!parsed.success) return Result({ _nay: { message: "Invalid screen info" } });
		contexts.push(parsed.data.data);
	}
	return contexts.length > 1
		? Result({ _nay: { message: "Invalid screen info" } })
		: Result({ _yay: contexts[0] ?? null });
}

/**
 * Write a value as one JSON string with `<` and `>` escaped. A plugin title or a file name could
 * hold a newline and `</ui_context>`. Without quoting, the text after it would read like the user's
 * own words.
 */
function quote(value: string) {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * The text the model reads. Plugin titles come from plugin manifests, so the system prompt tells
 * the model to treat this block as data.
 */
export function ai_chat_ui_context_to_model_text(context: ai_chat_UiContext) {
	const lines = ["<ui_context>"];
	if (context.node) lines.push(`Open ${context.node.kind}: ${quote(context.node.path)}`);
	if (context.view) lines.push(`View: ${quote(context.view)}`);
	if (context.plugin) {
		lines.push(
			`${context.plugin.kind === "page" ? "Plugin page" : "Plugin view"}: ${quote(context.plugin.title)} (plugin ${quote(context.plugin.pluginName)})`,
		);
	}
	lines.push("</ui_context>");
	return lines.join("\n");
}
