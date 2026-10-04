import z from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size } from "./files.ts";

export const file_quotes_MAX_COUNT = 20;
export const file_quotes_MAX_TEXT_BYTES = 4_096;

/**
 * Sent text stays visible when the file itself is no longer readable.
 */
export const file_quotes_schema = z
	.object({
		fileNodeId: z.string().min(1).max(128).nullable(),
		text: z
			.string()
			.refine((text) => text.trim().length > 0 && files_get_utf8_byte_size(text) <= file_quotes_MAX_TEXT_BYTES),
	})
	.strict();

export type file_quotes_Quote = z.infer<typeof file_quotes_schema>;

export const file_quotes_part_schema = z
	.object({
		type: z.literal("data-file-quote"),
		data: file_quotes_schema,
		id: z.string().optional(),
	})
	.strict();

export function file_quotes_validate_parts(parts: unknown) {
	if (!Array.isArray(parts)) return Result({ _nay: { message: "Invalid message parts" } });
	const quotes: file_quotes_Quote[] = [];
	for (const part of parts as unknown[]) {
		if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-file-quote") continue;
		const parsed = file_quotes_part_schema.safeParse(part);
		if (!parsed.success) return Result({ _nay: { message: "Invalid file quotes" } });
		quotes.push(parsed.data.data);
	}
	return quotes.length > file_quotes_MAX_COUNT
		? Result({ _nay: { message: "Quote at most 20 selections" } })
		: Result({ _yay: quotes });
}

export function file_quotes_encode_draft_data(quote: file_quotes_Quote) {
	return encodeURIComponent(JSON.stringify(quote));
}

export function file_quotes_decode_draft_data(data: unknown) {
	if (typeof data !== "string") return null;
	try {
		const parsed = file_quotes_schema.safeParse(JSON.parse(decodeURIComponent(data)));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function file_quotes_serialize_draft(quote: file_quotes_Quote) {
	return `[file-quote data="${file_quotes_encode_draft_data(quote)}"]`;
}

/**
 * Private string drafts keep quote nodes through reload, queue, edit, and retry.
 */
export function file_quotes_parse_draft(draft: string) {
	const parts: Array<{ type: "text"; text: string } | { type: "data-file-quote"; data: file_quotes_Quote }> = [];
	let start = 0;
	for (const match of draft.matchAll(/\[file-quote data="([^"]+)"\]/g)) {
		const quote = file_quotes_decode_draft_data(match[1]);
		if (!quote) continue;
		if (match.index > start) parts.push({ type: "text", text: draft.slice(start, match.index) });
		parts.push({ type: "data-file-quote", data: quote });
		start = match.index + match[0].length;
	}
	if (start < draft.length) parts.push({ type: "text", text: draft.slice(start) });
	return parts;
}

export function file_quotes_draft_to_text(draft: string) {
	return file_quotes_parse_draft(draft)
		.map((part) => (part.type === "text" ? part.text : part.data.text))
		.join("");
}
