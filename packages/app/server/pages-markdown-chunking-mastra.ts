import { MDocument } from "@mastra/rag";
import { pages_tiptap_markdown_to_plain_text } from "./pages.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { should_never_happen } from "./server-utils.ts";

export const pages_chunk_BITMASK_FLAGS = {
	isCode: 1 << 0,
	isTable: 1 << 1,
	hasMoreFragmentContentAbove: 1 << 2,
	hasMoreFragmentContentBelow: 1 << 3,
} as const;

const MARKDOWN_TABLE_SEPARATOR_REGEX = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MAX_CHUNK_SIZE = 1200;

// TODO: Confirm whether this pipeline should use chunk overlap at all; current app usage keeps it at 0.
// Observation: we removed local fallback searching and now rely on Mastra startIndex metadata directly.
// Also tests would need to be updated to handle overlap.
const OVERLAP = 0;

function create_line_start_offsets(markdownContent: string) {
	const lineStartOffsets = [0];
	for (let index = 0; index < markdownContent.length; index++) {
		if (markdownContent[index] === "\n") {
			lineStartOffsets.push(index + 1);
		}
	}
	return lineStartOffsets;
}

/**
 * Resolves the 1-based line number for a character offset in a text document.
 *
 * `lineStartOffsetsAsc` contains for each line the character index (offset) at which it starts.
 *
 * Line 1 starts at index 0.
 *
 * This function uses binary search to find the line number that contains the target offset.
 *
 * @param args.targetOffset Character offset in the source text (negative values map to line 1).
 * @param args.lineStartOffsetsAsc Per-line start character offsets in ascending order.
 * @returns 1-based line number containing `targetOffset` (line number = matched array index + 1).
 */
function get_line_number_from_offset(args: { targetOffset: number; lineStartOffsetsAsc: number[] }) {
	const maxOffset = args.lineStartOffsetsAsc.at(-1);
	if (maxOffset === undefined) {
		throw should_never_happen("lineStartOffsetsAsc is empty", {
			lineStartOffsetsAsc: args.lineStartOffsetsAsc,
		});
	}

	// if the target offset is before the first line, return line 1.
	if (args.targetOffset <= 0) {
		return 1;
	}

	// if the target offset is after the last line, return the last line.
	if (args.targetOffset >= maxOffset) {
		return args.lineStartOffsetsAsc.length;
	}

	// use binary search to find the line number for the target offset.
	let low = 0;
	let high = args.lineStartOffsetsAsc.length - 1;
	let best = 0;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const value = args.lineStartOffsetsAsc[mid];
		if (value <= args.targetOffset) {
			best = mid;
			low = mid + 1;

			// If we find an exact match, exit the loop.
			if (value === args.targetOffset) {
				break;
			}
		} else {
			high = mid - 1;
		}
	}

	return best + 1;
}

/**
 * Builds per-line markdown classification data used for chunk flag mapping.
 *
 * `codeByLine` and `tableByLine` are 1-based boolean maps where index `n`
 * corresponds to line `n`; index 0 is intentionally unused to align with
 * line-number APIs.
 *
 * Code lines are detected from fenced blocks (``` or ~~~). Table lines are
 * detected from contiguous pipe-like segments that include a markdown separator
 * row (for example `| --- | --- |`).
 *
 * @param markdownContent Markdown source text to classify line-by-line.
 * @returns Total line count plus per-line code/table classification maps.
 */
function create_markdown_line_classification_maps(markdownContent: string): {
	lineCount: number;
	codeByLine: boolean[];
	tableByLine: boolean[];
} {
	// Keep raw line text for local parsing; classification maps use 1-based line numbers.
	const lines = markdownContent.length > 0 ? markdownContent.split("\n") : [""];
	const lineCount = lines.length;
	const codeByLine = Array<boolean>(lineCount + 1).fill(false);
	const tableByLine = Array<boolean>(lineCount + 1).fill(false);

	let isInsideCodeBlock = false;
	let activeFencePrefix = "";

	// Mark lines that belong to fenced code blocks (including fence lines).
	for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
		const line = lines[lineNumber - 1] ?? "";
		const trimmedLine = line.trim();

		if (!isInsideCodeBlock) {
			if (trimmedLine.startsWith("```")) {
				isInsideCodeBlock = true;
				activeFencePrefix = "```";
			} else if (trimmedLine.startsWith("~~~")) {
				isInsideCodeBlock = true;
				activeFencePrefix = "~~~";
			}
		}

		if (isInsideCodeBlock) {
			codeByLine[lineNumber] = true;
			if (trimmedLine.startsWith(activeFencePrefix)) {
				// Keep fence lines inside the code section, then close.
				if (lineNumber > 1 && codeByLine[lineNumber - 1]) {
					isInsideCodeBlock = false;
					activeFencePrefix = "";
				}
			}
		}
	}

	// Scan contiguous table-like segments and mark them only when a separator row exists.
	let lineIndex = 0;
	while (lineIndex < lineCount) {
		const lineNumber = lineIndex + 1;
		if (codeByLine[lineNumber]) {
			lineIndex += 1;
			continue;
		}

		const trimmedLine = (lines[lineIndex] ?? "").trim();
		if (trimmedLine.length === 0 || !trimmedLine.includes("|")) {
			lineIndex += 1;
			continue;
		}

		const segmentStartIndex = lineIndex;
		let segmentEndIndex = lineIndex;
		while (segmentEndIndex + 1 < lineCount) {
			const nextLineIndex = segmentEndIndex + 1;
			const nextLineNumber = nextLineIndex + 1;
			if (codeByLine[nextLineNumber]) {
				break;
			}

			const nextTrimmedLine = (lines[nextLineIndex] ?? "").trim();
			if (nextTrimmedLine.length === 0 || !nextTrimmedLine.includes("|")) {
				break;
			}

			segmentEndIndex = nextLineIndex;
		}

		const segmentHasSeparator = (() => {
			for (let index = segmentStartIndex; index <= segmentEndIndex; index++) {
				if (MARKDOWN_TABLE_SEPARATOR_REGEX.test(lines[index] ?? "")) {
					return true;
				}
			}
			return false;
		})();

		const segmentLength = segmentEndIndex - segmentStartIndex + 1;
		if (segmentHasSeparator && segmentLength >= 2) {
			for (let index = segmentStartIndex; index <= segmentEndIndex; index++) {
				tableByLine[index + 1] = true;
			}
		}

		lineIndex = segmentEndIndex + 1;
	}

	return {
		lineCount,
		codeByLine,
		tableByLine,
	};
}

function has_bitmask_flag_in_range(args: { mapByLine: boolean[]; lineStart: number; lineEnd: number }) {
	for (let lineNumber = args.lineStart; lineNumber <= args.lineEnd; lineNumber++) {
		if (args.mapByLine[lineNumber]) {
			return true;
		}
	}
	return false;
}

function set_chunk_bitmask_flags(args: {
	lineStart: number;
	lineEnd: number;
	lineMaps: ReturnType<typeof create_markdown_line_classification_maps>;
}) {
	const { lineStart, lineEnd, lineMaps } = args;
	const { codeByLine, tableByLine } = lineMaps;

	const isCode = has_bitmask_flag_in_range({ mapByLine: codeByLine, lineStart, lineEnd });
	const isTable = has_bitmask_flag_in_range({ mapByLine: tableByLine, lineStart, lineEnd });

	const codeHasMoreAbove = isCode && lineStart > 1 && codeByLine[lineStart] && codeByLine[lineStart - 1];
	const codeHasMoreBelow = isCode && lineEnd < lineMaps.lineCount && codeByLine[lineEnd] && codeByLine[lineEnd + 1];

	const tableHasMoreAbove = isTable && lineStart > 1 && tableByLine[lineStart] && tableByLine[lineStart - 1];
	const tableHasMoreBelow = isTable && lineEnd < lineMaps.lineCount && tableByLine[lineEnd] && tableByLine[lineEnd + 1];

	let chunkFlags = 0;
	if (isCode) {
		chunkFlags |= pages_chunk_BITMASK_FLAGS.isCode;
	}
	if (isTable) {
		chunkFlags |= pages_chunk_BITMASK_FLAGS.isTable;
	}
	if (codeHasMoreAbove || tableHasMoreAbove) {
		chunkFlags |= pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove;
	}
	if (codeHasMoreBelow || tableHasMoreBelow) {
		chunkFlags |= pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow;
	}

	return chunkFlags;
}

export async function pages_chunk_markdown(markdown: string, options?: { maxChunkSize?: number }) {
	if (markdown.length === 0) {
		return Result({ _yay: [] });
	}

	let chunkDocs;
	try {
		chunkDocs = await MDocument.fromMarkdown(markdown).chunk({
			strategy: "markdown",
			maxSize: options?.maxChunkSize ?? MAX_CHUNK_SIZE,
			overlap: OVERLAP,
			// Prevent regex separator literals (e.g. "#{1,6}") from leaking into merged chunks.
			separatorPosition: "start",
			addStartIndex: true,
			stripWhitespace: false,
		});
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while chunking markdown",
				cause: error,
			},
		});
	}

	const lineStartOffsetsAsc = create_line_start_offsets(markdown);
	const lineMaps = create_markdown_line_classification_maps(markdown);

	const chunks: Array<{
		chunkIndex: number;
		markdownChunk: string;
		plainTextChunk: string;
		lineStart: number;
		lineEnd: number;
		chunkFlags: number;
	}> = [];

	for (let chunkIndex = 0; chunkIndex < chunkDocs.length; chunkIndex++) {
		const chunkDoc = chunkDocs[chunkIndex]!;
		const markdownChunk = chunkDoc.text;
		if (markdownChunk.length === 0) {
			continue;
		}

		const startIndex = chunkDoc.metadata?.["startIndex"];
		if (
			typeof startIndex !== "number" ||
			!Number.isInteger(startIndex) ||
			startIndex < 0 ||
			startIndex > markdown.length
		) {
			throw should_never_happen("Failed to resolve chunk start index from Mastra metadata", {
				chunkDoc,
			});
		}

		const startOffset = startIndex;
		const endOffset = startOffset + markdownChunk.length;

		const lineStart = get_line_number_from_offset({
			targetOffset: startOffset,
			lineStartOffsetsAsc,
		});
		const lineEnd = get_line_number_from_offset({
			targetOffset: endOffset,
			lineStartOffsetsAsc,
		});

		const plainTextResult = pages_tiptap_markdown_to_plain_text({
			markdown: markdownChunk,
		});
		if (plainTextResult._nay) {
			return Result({
				_nay: {
					name: "nay",
					message: "Failed to convert markdown chunk to plain text",
					cause: plainTextResult._nay,
				},
			});
		}

		const plainTextChunk = plainTextResult._yay;
		const chunkFlags = set_chunk_bitmask_flags({
			lineStart,
			lineEnd,
			lineMaps,
		});

		chunks.push({
			chunkIndex: chunks.length,
			markdownChunk,
			plainTextChunk,
			lineStart,
			lineEnd,
			chunkFlags,
		});
	}

	return Result({ _yay: chunks });
}

export function pages_chunk_has_bitmask_flag(chunkFlags: number, flag: number) {
	return (chunkFlags & flag) === flag;
}
