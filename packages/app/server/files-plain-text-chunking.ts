import { create_line_start_offsets, get_line_number_from_offset } from "./files-line-offsets.ts";

/**
 * Default maximum chunk size (in UTF-16 code units), mirroring the markdown chunker's `MAX_CHUNK_SIZE`
 * so plain-text and markdown chunks have comparable granularity for the search index.
 */
const MAX_CHUNK_SIZE = 1200;

export type files_plain_text_chunk = {
	chunkIndex: number;
	markdownChunk: string;
	plainTextChunk: string;
	startIndex: number;
	endIndex: number;
	lineStart: number;
	lineEnd: number;
	chunkFlags: number;
};

/**
 * Split raw text into contiguous, zero-overlap chunks on line boundaries. Returns the same chunk shape
 * as `files_chunk_markdown` so the committed-chunk insert path can consume it unchanged. Unlike the
 * markdown chunker this performs no markdown parsing — for plain text the markdown and plain-text
 * projections of a chunk are identical (the raw substring), so search/read see byte-identical content.
 *
 * Windows greedily pack whole lines up to `maxChunkSize`. A single line longer than `maxChunkSize`
 * becomes its own window — line boundaries are never split, which keeps `startIndex_n === endIndex_{n-1}`
 * (contiguity) so concatenating chunks in order reconstructs the input exactly. Empty input → `[]`.
 */
export function files_chunk_plain_text(text: string, options?: { maxChunkSize?: number }): Array<files_plain_text_chunk> {
	if (text.length === 0) {
		return [];
	}

	const maxChunkSize = options?.maxChunkSize ?? MAX_CHUNK_SIZE;
	const lineStartOffsetsAsc = create_line_start_offsets(text);
	const chunks: Array<files_plain_text_chunk> = [];

	let windowStart = 0;
	let cursor = 0;

	const pushChunk = (startIndex: number, endIndex: number) => {
		const slice = text.slice(startIndex, endIndex);
		chunks.push({
			chunkIndex: chunks.length,
			markdownChunk: slice,
			plainTextChunk: slice,
			startIndex,
			endIndex,
			lineStart: get_line_number_from_offset({ targetOffset: startIndex, lineStartOffsetsAsc }),
			lineEnd: get_line_number_from_offset({ targetOffset: Math.max(startIndex, endIndex - 1), lineStartOffsetsAsc }),
			chunkFlags: 0,
		});
	};

	// Walk one line at a time. Before extending a non-empty window past `maxChunkSize`, flush it so each
	// emitted window contains whole lines and stays within the cap unless a single line already exceeds it.
	while (cursor < text.length) {
		const newlineIndex = text.indexOf("\n", cursor);
		const lineEnd = newlineIndex === -1 ? text.length : newlineIndex + 1; // include the trailing "\n"
		if (cursor > windowStart && lineEnd - windowStart > maxChunkSize) {
			pushChunk(windowStart, cursor);
			windowStart = cursor;
		}
		cursor = lineEnd;
	}

	if (windowStart < text.length) {
		pushChunk(windowStart, text.length);
	}

	return chunks;
}
