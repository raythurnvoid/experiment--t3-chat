import { Result } from "common/errors-as-values-utils.ts";
import { z } from "zod";
import { files_tiptap_markdown_to_plain_text } from "./files-tiptap.ts";
import { file_quotes_serialize_draft, type file_quotes_Quote } from "./file-quotes.ts";

// Starting values, not product rules. They protect the system. Raise them step by step as needed.
export const channels_LIMITS = {
	bodyBytes: 16_384,
	mentions: 50,
	attachments: 20,
	quote: 1_024,
	title: 200,
	anchorExcerpt: 280,
	name: 80,
	topic: 250,
	directParticipants: 9,
	privateMembers: 1_000,
	emoji: 20,
	page: 50,
	pageBytes: 900_000,
} as const;

export const channels_search_query_schema = z
	.string()
	.trim()
	.min(1, "Enter search words")
	.max(512, "Use at most 512 characters")
	.refine((query) => {
		const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
		return words.length > 0 && words.length <= 16;
	}, "Use 1–16 search words");

export function channels_normalize_name(raw: string) {
	const name = raw.trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,80}$/.test(name)) {
		return Result({ _nay: { message: "Use 1–80 lowercase letters, numbers, - or _" } });
	}
	return Result({ _yay: name });
}

export function channels_is_emoji(emoji: string) {
	return /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)$/u.test(
		emoji,
	);
}

/**
 * Replies and the editor must read Markdown in the same way.
 */
export function channels_markdown_to_plain_text(markdown: string) {
	return files_tiptap_markdown_to_plain_text({ markdown });
}

export function channels_render_people_mentions(markdown: string, names: readonly string[]) {
	return markdown.replace(
		/\[@ id="user:(\d+)"\]/g,
		(_token, index: string) => `@${(names[Number(index)] ?? "Person").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&")}`,
	);
}

export function channels_render_file_mentions(
	markdown: string,
	files: readonly ({ name: string; href?: string } | null)[],
) {
	return markdown.replace(/\[@ id="file:(\d+)"\]/g, (_token, index: string) => {
		const file = files[Number(index)];
		if (!file) return "File unavailable";
		const label = `@${file.name.replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&")}`;
		return file.href ? `[${label}](${file.href})` : label;
	});
}

export function channels_render_file_quotes(markdown: string, quotes: readonly file_quotes_Quote[]) {
	return markdown.replace(/\[file-quote id="(\d+)"\]/g, (_token, index: string) =>
		(quotes[Number(index)]?.text ?? "Quote unavailable").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&"),
	);
}

export function channels_file_quotes_to_draft(markdown: string, quotes: readonly file_quotes_Quote[]) {
	return markdown.replace(/\[file-quote id="(\d+)"\]/g, (_token, index: string) =>
		quotes[Number(index)] ? file_quotes_serialize_draft(quotes[Number(index)]!) : "Quote unavailable",
	);
}

export function channels_composer_markdown_for_edit(
	markdown: string,
	userIds: readonly string[],
	fileMentions: readonly ({ kind: "file"; fileNodeId: string } | { kind: "unavailable" })[],
	fileQuotes: readonly file_quotes_Quote[],
) {
	const people = markdown.replace(/\[@ id="user:(\d+)"\]/g, (_token, index: string) =>
		userIds[Number(index)] ? `[@ id="user:${userIds[Number(index)]}"]` : "@Person",
	);
	const files = people.replace(/\[@ id="file:(\d+)"\]/g, (_token, index: string) => {
		const file = fileMentions[Number(index)];
		return file?.kind === "file" ? `[@ id="file:${file.fileNodeId}"]` : "File unavailable";
	});
	return channels_file_quotes_to_draft(files, fileQuotes);
}
