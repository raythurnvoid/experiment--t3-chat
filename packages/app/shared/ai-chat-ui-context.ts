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
 *
 * `channel` works the same way: the server checks `channelId` and `threadRootId` and replaces the
 * names with saved ones. History reads clear both ids when the reader can no longer open the channel.
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
		/**
		 * The open Messages channel. `name` is what the chip shows: `#name`, the other people of a direct
		 * message, or the file name of a file's comments.
		 */
		channel: z
			.object({
				channelId: z.string().min(1).max(128).nullable(),
				kind: z.enum(["public", "private", "direct", "file"]),
				name: z.string().min(1).max(1000),
				threadRootId: z.string().min(1).max(128).nullable(),
				threadTitle: z.string().min(1).max(200).nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.refine((context) => context.node !== null || context.plugin !== null || context.channel !== null);

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
	if (context.channel) {
		// The model needs the ids to run `channels read`. A history read clears them after access is lost.
		const channel = context.channel;
		const kind =
			channel.kind === "file" ? "file comments" : channel.kind === "direct" ? "direct message" : channel.kind;
		lines.push(
			`Open channel: ${quote(channel.name)} (${kind}${channel.channelId ? `, id ${quote(channel.channelId)}` : ""})`,
		);
		if (channel.threadRootId || channel.threadTitle) {
			lines.push(
				`Open thread${channel.threadTitle ? `: ${quote(channel.threadTitle)}` : ""}${channel.threadRootId ? ` (root message id ${quote(channel.threadRootId)})` : ""}`,
			);
		}
	}
	lines.push("</ui_context>");
	return lines.join("\n");
}
