import { should_never_happen } from "./server-utils.ts";

/**
 * Per-line start character offsets (ascending) for a text document: index `n` is the character offset
 * at which line `n+1` begins. Line 1 always starts at offset 0. Shared by the markdown chunker and the
 * plain-text chunker so both map chunk character offsets to 1-based line numbers identically.
 */
export function create_line_start_offsets(content: string) {
	const lineStartOffsets = [0];
	for (let index = 0; index < content.length; index++) {
		if (content[index] === "\n") {
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
export function get_line_number_from_offset(args: { targetOffset: number; lineStartOffsetsAsc: number[] }) {
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
