import z from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { channels_LIMITS } from "./channels.ts";
import { file_quotes_MAX_TEXT_BYTES } from "./file-quotes.ts";
import { files_get_utf8_byte_size, files_STORED_PATH_MAX_LENGTH } from "./files.ts";
import { secret_shaped_text_REGEX } from "./secret-shaped-text.ts";

/**
 * What the user had open in the app when they sent a message. The app adds it to the message as one
 * `data-ui-context` part, and the model reads it as a `<ui_context>` block.
 *
 * The server checks `node.fileNodeId` and replaces `path` and `kind` with the saved values, so the
 * browser's copy is never trusted. A null `fileNodeId` is the workspace root, or a node the reader
 * can no longer open (history reads clear it, like file quotes). `node.pendingNodeId` is the
 * sender's own private draft, which has no saved node yet; the server reads its path for the sender.
 *
 * `channel` works the same way: the server checks `channelId` and `threadRootId` and replaces the
 * names with saved ones. History reads clear both ids when the reader can no longer open the channel.
 */
export const ai_chat_ui_context_schema = z
	.object({
		node: z
			.object({
				fileNodeId: z.string().min(1).max(128).nullable(),
				pendingNodeId: z.string().min(1).max(128).nullable(),
				path: z.string().min(1).max(files_STORED_PATH_MAX_LENGTH),
				kind: z.enum(["file", "folder"]),
			})
			.strict()
			.refine((node) => node.fileNodeId === null || node.pendingNodeId === null)
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
				threadTitle: z.string().min(1).max(channels_LIMITS.title).nullable(),
			})
			.strict()
			.nullable(),
		/**
		 * The selected text in the open file's editor. The browser cuts it to 4,096 bytes and sets
		 * `truncated`. The server keeps it only with a readable open file.
		 */
		selection: z
			.object({
				text: z
					.string()
					.refine((text) => text.trim().length > 0 && files_get_utf8_byte_size(text) <= file_quotes_MAX_TEXT_BYTES),
				editor: z.enum(["rich_text", "plain_text", "diff_original", "diff_modified"]),
				truncated: z.boolean(),
			})
			.strict()
			.nullable(),
		/**
		 * The page the user sees in the cloud web browser. Only the origin, never the full address,
		 * which can hold tokens.
		 */
		browser: z
			.object({
				origin: z
					.string()
					.max(2048)
					.refine((value) => {
						try {
							const url = new URL(value);
							return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
						} catch {
							return false;
						}
					}),
				title: z.string().min(1).max(200).nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.refine(
		(context) =>
			context.node !== null || context.plugin !== null || context.channel !== null || context.browser !== null,
	);

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
 * Write a value as one JSON string with `<` and `>` escaped. A plugin title, a file name, a channel
 * name, a thread title or quoted file text could hold a newline and `</ui_context>`. Without quoting,
 * the text after it would read like the user's own words.
 */
export function ai_chat_ui_context_quote(value: string) {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * The text the model reads. Plugin titles come from plugin manifests, other people write channel
 * names and thread titles, websites write page titles, and selected text is file content. So the
 * system prompt tells the model to treat this block as data.
 */
export function ai_chat_ui_context_to_model_text(context: ai_chat_UiContext) {
	const lines = ["<ui_context>"];
	if (context.node) {
		lines.push(
			context.node.pendingNodeId
				? `Open draft ${context.node.kind}: ${ai_chat_ui_context_quote(context.node.path)} (not saved yet)`
				: `Open ${context.node.kind}: ${ai_chat_ui_context_quote(context.node.path)}`,
		);
	}
	if (context.view) lines.push(`View: ${ai_chat_ui_context_quote(context.view)}`);
	if (context.selection) {
		const editor = {
			rich_text: "rich text editor",
			plain_text: "code editor",
			diff_original: "old side of the diff",
			diff_modified: "new side of the diff",
		}[context.selection.editor];
		lines.push(
			`Selected text (${editor}${context.selection.truncated ? ", only the first 4,096 bytes" : ""}): ${ai_chat_ui_context_quote(context.selection.text)}`,
		);
	}
	if (context.plugin) {
		lines.push(
			`${context.plugin.kind === "page" ? "Plugin page" : "Plugin view"}: ${ai_chat_ui_context_quote(context.plugin.title)} (plugin ${ai_chat_ui_context_quote(context.plugin.pluginName)})`,
		);
	}
	if (context.channel) {
		// The model needs the ids to run `channels read`. A history read clears them after access is lost.
		const channel = context.channel;
		const kind =
			channel.kind === "file" ? "file comments" : channel.kind === "direct" ? "direct message" : channel.kind;
		lines.push(
			`Open channel: ${ai_chat_ui_context_quote(channel.name)} (${kind}${channel.channelId ? `, id ${ai_chat_ui_context_quote(channel.channelId)}` : ""})`,
		);
		if (channel.threadRootId || channel.threadTitle) {
			lines.push(
				`Open thread${channel.threadTitle ? `: ${ai_chat_ui_context_quote(channel.threadTitle)}` : ""}${channel.threadRootId ? ` (root message id ${ai_chat_ui_context_quote(channel.threadRootId)})` : ""}`,
			);
		}
	}
	if (context.browser) {
		lines.push(
			`Browser page: ${context.browser.title ? `${ai_chat_ui_context_quote(context.browser.title)} ` : ""}(site ${ai_chat_ui_context_quote(context.browser.origin)})`,
		);
	}
	lines.push("</ui_context>");
	return lines.join("\n");
}

/**
 * What the open plugin page or file view says it shows, sent in the `/api/chat` request body. The
 * browser never puts it in the message parts, so it reaches the model for one turn and is never
 * stored. The plugin wrote it, so it is untrusted data.
 */
export const ai_chat_plugin_context_schema = z
	.object({
		pluginName: z.string().min(1).max(64),
		kind: z.enum(["page", "file_view"]),
		content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).max(32),
		structuredContent: z.record(z.string(), z.unknown()).nullable(),
	})
	.strict()
	// Measure the same JSON the host frame measures, so a value the frame lets through passes here.
	.refine(
		(context) =>
			files_get_utf8_byte_size(
				JSON.stringify({ content: context.content, structuredContent: context.structuredContent }),
			) <=
			16 * 1024,
		"Plugin text is too big",
	);

export type ai_chat_PluginContext = z.infer<typeof ai_chat_plugin_context_schema>;

// The model reads at most this much plugin text per message. The cut keeps every turn cheap.
const PLUGIN_CONTEXT_MAX_MODEL_BYTES = 4_096;

/**
 * The block the model reads for the plugin text. The text is cleaned, cut to 4 KiB, and quoted, so
 * it cannot close the tag and read like the user's own words.
 */
export function ai_chat_plugin_context_to_model_text(context: ai_chat_PluginContext) {
	const blocks = context.content.map((block) => block.text);
	if (context.structuredContent) blocks.push(JSON.stringify(context.structuredContent));
	const text = blocks
		.join("\n\n")
		// Keep line breaks and tabs. Other control and format characters can hide text from the user.
		.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "")
		.replace(secret_shaped_text_REGEX, "[secret]");

	// `encodeInto` never splits a character.
	const { read } = new TextEncoder().encodeInto(text, new Uint8Array(PLUGIN_CONTEXT_MAX_MODEL_BYTES));
	const shown = read < text.length ? `${text.slice(0, read)}\n[Cut: the plugin sent more than 4 KiB.]` : text;
	return [
		`<plugin_context plugin=${ai_chat_ui_context_quote(context.pluginName)} kind="${context.kind}">`,
		ai_chat_ui_context_quote(shown),
		"</plugin_context>",
	].join("\n");
}
