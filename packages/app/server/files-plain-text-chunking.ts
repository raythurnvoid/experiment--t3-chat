import { create_line_start_offsets, get_line_number_from_offset } from "./files-line-offsets.ts";

/**
 * Default maximum chunk size (in UTF-16 code units), mirroring the markdown chunker's `MAX_CHUNK_SIZE`
 * so plain-text and markdown chunks have comparable granularity for the search index.
 */
const MAX_CHUNK_SIZE = 1200;

export type files_plain_text_chunk = {
	chunkIndex: number;
	textChunk: string;
	plainTextChunk: string;
	startIndex: number;
	endIndex: number;
	lineStart: number;
	lineEnd: number;
	chunkFlags: number;
};

function is_high_surrogate(codeUnit: number) {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * Split raw text into contiguous, zero-overlap chunks. Returns the same chunk shape
 * as `files_chunk_markdown` so the committed-chunk insert path can consume it unchanged. Unlike the
 * markdown chunker this performs no markdown parsing — for plain text the markdown and plain-text
 * projections of a chunk are identical (the raw substring), so search/read see byte-identical content.
 *
 * Windows greedily pack whole lines up to `maxChunkSize`. A single line longer than the cap is
 * split MID-LINE into cap-sized pieces (a 600 KB minified-JSON line would otherwise become one
 * chunk document and blow Convex's per-document limit inside the infinite-retry workpool). Every
 * piece of a split line reports that line's number as both `lineStart` and `lineEnd`, and a cut
 * never lands between a high and a low surrogate. `startIndex_n === endIndex_{n-1}` (contiguity)
 * still holds, so concatenating chunks in order reconstructs the input exactly. Empty input → `[]`.
 *
 * One accepted regression from mid-line cuts: a search token that straddles a cut inside a split
 * line is findable in neither chunk. Cuts at `\n` never had this problem.
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
			textChunk: slice,
			plainTextChunk: slice,
			startIndex,
			endIndex,
			lineStart: get_line_number_from_offset({ targetOffset: startIndex, lineStartOffsetsAsc }),
			lineEnd: get_line_number_from_offset({ targetOffset: Math.max(startIndex, endIndex - 1), lineStartOffsetsAsc }),
			chunkFlags: 0,
		});
	};

	// Walk one line at a time. Before extending a non-empty window past `maxChunkSize`, flush it so each
	// emitted window contains whole lines and stays within the cap.
	while (cursor < text.length) {
		const newlineIndex = text.indexOf("\n", cursor);
		const lineEnd = newlineIndex === -1 ? text.length : newlineIndex + 1; // include the trailing "\n"
		if (cursor > windowStart && lineEnd - windowStart > maxChunkSize) {
			pushChunk(windowStart, cursor);
			windowStart = cursor;
		}

		// A single line longer than the cap: emit cap-sized pieces of it until the tail fits. The
		// tail stays in the open window so following short lines can pack in behind it.
		while (lineEnd - windowStart > maxChunkSize) {
			let pieceEnd = windowStart + maxChunkSize;
			// Never cut between a high and a low surrogate: Yjs and search would each see half a
			// character. Same rule as `compute_minimal_text_edit` in file-editor-plain-text.tsx.
			if (is_high_surrogate(text.charCodeAt(pieceEnd - 1))) {
				pieceEnd -= 1;
			}
			// A cap of 1 around a surrogate pair cannot move the cut backward; take the whole pair
			// instead of looping forever. Real callers use the 1200 default, so this is test-only.
			if (pieceEnd <= windowStart) {
				pieceEnd = windowStart + 2;
			}
			pushChunk(windowStart, pieceEnd);
			windowStart = pieceEnd;
		}

		cursor = lineEnd;
	}

	if (windowStart < text.length) {
		pushChunk(windowStart, text.length);
	}

	return chunks;
}
