// Bounded character-refining text diff for plain-text documents.
//
// Adapted from `@sanity/diff-match-patch` 3.2.0 (`src/diff/*`, MIT licensed, itself derived from
// Google's diff-match-patch). The installed package's public `makeDiff` has a timeout, but when
// its internal deadline expires it silently returns a coarse whole-block delete+insert and does
// not report that it did. A coarse result is unsafe to apply to a shared `Y.Text` (concurrent
// saves would double the file), so this adaptation makes budget exhaustion an explicit refusal:
// the Myers bisect throws a module-private error instead of falling back, and the public wrapper
// converts that into a `_nay`. Everything else follows the installed source so results match the
// library's exact (non-coarse) output, including its surrogate-pair boundary adjustment.
//
// Pure helpers with no deadline behavior (`cleanupSemantic`, the `Diff` tuple type and the
// `DIFF_*` constants) are imported from the installed package instead of being copied.

import { cleanupSemantic, DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, type Diff } from "@sanity/diff-match-patch";
import { Result } from "common/errors-as-values-utils.ts";

/**
 * Wall-clock backstop for one diff. On exhaustion the diff refuses instead of degrading.
 *
 * No Convex mutation computes a text diff: every caller runs in the browser or in a Convex
 * action, and both have a live `Date.now()`. So this deadline can sit far above normal compute
 * times. The step budget below makes the real refusal decision. The deadline only stops runaway
 * wall time when a machine is much slower, or when the snake-extension scans, which the step
 * budget does not count, dominate the time.
 *
 * Measured 2026-08-10 (Node 22 dev machine): the heaviest ordinary edit that must pass
 * (prettify a 40 KB minified JSON) computes for ~8.5 s, and the heaviest edit the step budget
 * admits (replace-all with 4,000 hits in a 270 KB file) computes for ~21 s. A 10 s deadline
 * would refuse the first case on a slightly slower machine, so the backstop is 30 s.
 */
const files_text_diff_DEADLINE_MS = 30_000;

/**
 * Operation budget for one diff, counted as Myers bisect steps. The same input always counts
 * the same number of steps on every machine, so this budget is the deterministic refusal
 * decision; the deadline above is only a backstop.
 *
 * Calibrated from measurements 2026-08-10. Ordinary bulk edits must pass: a full sort of
 * 1,000 lines (~25 KB) needs 131M steps, prettify of a 40 KB minified JSON needs 313M, and
 * replace-all with 1,000 hits in a 66 KB file needs 52M. Genuinely pathological near-cap
 * changes must refuse: a shuffled sort of ~890 KB and a random 880 KB vs 880 KB rewrite both
 * exceed 2,000M. 1,000M gives the heaviest must-pass case a 3.2x margin and refuses every
 * measured pathological case.
 */
const files_text_diff_MAX_OPERATIONS = 1_000_000_000;

/**
 * User-facing refusal message. The editors show it verbatim, so keep it stable.
 */
export const files_text_diff_TOO_LARGE_MESSAGE = "This change is too large to compare safely";

/**
 * Thrown by the bisect when the time or operation budget runs out. Module-private: the public
 * wrapper catches it and returns a `_nay`, so no caller ever sees a coarse diff or an exception.
 */
class TextDiffBudgetExceeded extends Error {}

type DiffBudget = {
	deadline: number;
	operationsLeft: number;
};

type InternalDiffOptions = {
	checkLines: boolean;
	budget: DiffBudget;
};

/**
 * Compute the minimal character-refining diff from `sourceText` to `targetText`.
 *
 * Line mode is only an acceleration: replacement blocks are re-diffed at character level, so
 * different character spans on one line of a multiline file merge correctly. On budget
 * exhaustion this returns `_nay` with the stable user-facing message; it never falls back to a
 * coarse whole-document replacement.
 */
export function files_text_diff_compute(args: { sourceText: string; targetText: string; deadlineMs?: number }) {
	const budget: DiffBudget = {
		deadline: Date.now() + (args.deadlineMs ?? files_text_diff_DEADLINE_MS),
		operationsLeft: files_text_diff_MAX_OPERATIONS,
	};

	try {
		const diffs = doDiff(args.sourceText, args.targetText, { checkLines: true, budget });
		adjustDiffForSurrogatePairs(diffs);
		return Result({ _yay: diffs });
	} catch (error) {
		if (error instanceof TextDiffBudgetExceeded) {
			return Result({
				_nay: {
					name: "nay",
					message: files_text_diff_TOO_LARGE_MESSAGE,
				},
			});
		}
		throw error;
	}
}

/**
 * Find the differences between two texts. Simplifies the problem by stripping any common prefix
 * or suffix off the texts before diffing.
 */
function doDiff(textA: string, textB: string, options: InternalDiffOptions): Diff[] {
	// Don't reassign fn params
	let text1 = textA;
	let text2 = textB;

	// Check for equality (speedup).
	if (text1 === text2) {
		return text1 ? [[DIFF_EQUAL, text1]] : [];
	}

	// Trim off common prefix (speedup).
	let commonlength = getCommonPrefix(text1, text2);
	const commonprefix = text1.substring(0, commonlength);
	text1 = text1.substring(commonlength);
	text2 = text2.substring(commonlength);

	// Trim off common suffix (speedup).
	commonlength = getCommonSuffix(text1, text2);
	const commonsuffix = text1.substring(text1.length - commonlength);
	text1 = text1.substring(0, text1.length - commonlength);
	text2 = text2.substring(0, text2.length - commonlength);

	// Compute the diff on the middle block.
	let diffs = computeDiff(text1, text2, options);

	// Restore the prefix and suffix.
	if (commonprefix) {
		diffs.unshift([DIFF_EQUAL, commonprefix]);
	}
	if (commonsuffix) {
		diffs.push([DIFF_EQUAL, commonsuffix]);
	}
	diffs = cleanupMerge(diffs);
	return diffs;
}

/**
 * Find the differences between two texts. Assumes that the texts do not have any common prefix
 * or suffix.
 */
function computeDiff(text1: string, text2: string, opts: InternalDiffOptions): Diff[] {
	let diffs: Diff[];

	if (!text1) {
		// Just add some text (speedup).
		return [[DIFF_INSERT, text2]];
	}

	if (!text2) {
		// Just delete some text (speedup).
		return [[DIFF_DELETE, text1]];
	}

	const longtext = text1.length > text2.length ? text1 : text2;
	const shorttext = text1.length > text2.length ? text2 : text1;
	const i = longtext.indexOf(shorttext);
	if (i !== -1) {
		// Shorter text is inside the longer text (speedup).
		diffs = [
			[DIFF_INSERT, longtext.substring(0, i)],
			[DIFF_EQUAL, shorttext],
			[DIFF_INSERT, longtext.substring(i + shorttext.length)],
		];
		// Swap insertions for deletions if diff is reversed.
		if (text1.length > text2.length) {
			diffs[0][0] = DIFF_DELETE;
			diffs[2][0] = DIFF_DELETE;
		}
		return diffs;
	}

	if (shorttext.length === 1) {
		// Single character string.
		// After the previous speedup, the character can't be an equality.
		return [
			[DIFF_DELETE, text1],
			[DIFF_INSERT, text2],
		];
	}

	// Check to see if the problem can be split in two.
	const halfMatch = findHalfMatch(text1, text2);
	if (halfMatch) {
		// A half-match was found, sort out the return data.
		const text1A = halfMatch[0];
		const text1B = halfMatch[1];
		const text2A = halfMatch[2];
		const text2B = halfMatch[3];
		const midCommon = halfMatch[4];
		// Send both pairs off for separate processing.
		const diffsA = doDiff(text1A, text2A, opts);
		const diffsB = doDiff(text1B, text2B, opts);
		// Merge the results.
		return diffsA.concat([[DIFF_EQUAL, midCommon]], diffsB);
	}

	if (opts.checkLines && text1.length > 100 && text2.length > 100) {
		return doLineModeDiff(text1, text2, opts);
	}

	return bisect(text1, text2, opts.budget);
}

/**
 * Do a quick line-level diff on both strings, then rediff the parts for greater accuracy.
 */
function doLineModeDiff(textA: string, textB: string, opts: InternalDiffOptions): Diff[] {
	// Don't reassign fn params
	let text1 = textA;
	let text2 = textB;

	// Scan the text on a line-by-line basis first.
	const a = linesToChars(text1, text2);
	text1 = a.chars1;
	text2 = a.chars2;
	const linearray = a.lineArray;

	let diffs = doDiff(text1, text2, {
		checkLines: false,
		budget: opts.budget,
	});

	// Convert the diff back to original text.
	charsToLines(diffs, linearray);
	// Eliminate freak matches (e.g. blank lines)
	diffs = cleanupSemantic(diffs);

	// Rediff any replacement blocks, this time character-by-character.
	// Add a dummy entry at the end.
	diffs.push([DIFF_EQUAL, ""]);
	let pointer = 0;
	let countDelete = 0;
	let countInsert = 0;
	let textDelete = "";
	let textInsert = "";
	while (pointer < diffs.length) {
		switch (diffs[pointer][0]) {
			case DIFF_INSERT:
				countInsert++;
				textInsert += diffs[pointer][1];
				break;
			case DIFF_DELETE:
				countDelete++;
				textDelete += diffs[pointer][1];
				break;
			case DIFF_EQUAL:
				// Upon reaching an equality, check for prior redundancies.
				if (countDelete >= 1 && countInsert >= 1) {
					// Delete the offending records and add the merged ones.
					diffs.splice(pointer - countDelete - countInsert, countDelete + countInsert);
					pointer = pointer - countDelete - countInsert;
					const aa = doDiff(textDelete, textInsert, {
						checkLines: false,
						budget: opts.budget,
					});
					for (let j = aa.length - 1; j >= 0; j--) {
						diffs.splice(pointer, 0, aa[j]);
					}
					pointer += aa.length;
				}
				countInsert = 0;
				countDelete = 0;
				textDelete = "";
				textInsert = "";
				break;
			default:
				throw new Error("Unknown diff operation.");
		}
		pointer++;
	}
	diffs.pop(); // Remove the dummy entry at the end.

	return diffs;
}

/**
 * Find the 'middle snake' of a diff, split the problem in two and return the recursively
 * constructed diff. See Myers 1986 paper: An O(ND) Difference Algorithm and Its Variations.
 *
 * The one behavioral change from the installed source: where upstream `break`s out of the loop
 * on deadline and falls through to a coarse whole-block delete+insert, this throws
 * `TextDiffBudgetExceeded` so no coarse result can ever be returned.
 */
function bisect(text1: string, text2: string, budget: DiffBudget): Diff[] {
	// Cache the text lengths to prevent multiple calls.
	const text1Length = text1.length;
	const text2Length = text2.length;
	const maxD = Math.ceil((text1Length + text2Length) / 2);
	const vOffset = maxD;
	const vLength = 2 * maxD;
	const v1 = new Array(vLength);
	const v2 = new Array(vLength);
	// Setting all elements to -1 is faster in Chrome & Firefox than mixing
	// integers and undefined.
	for (let x = 0; x < vLength; x++) {
		v1[x] = -1;
		v2[x] = -1;
	}
	v1[vOffset + 1] = 0;
	v2[vOffset + 1] = 0;
	const delta = text1Length - text2Length;
	// If the total number of characters is odd, then the front path will collide
	// with the reverse path.
	const front = delta % 2 !== 0;
	// Offsets for start and end of k loop.
	// Prevents mapping of space beyond the grid.
	let k1start = 0;
	let k1end = 0;
	let k2start = 0;
	let k2end = 0;
	for (let d = 0; d < maxD; d++) {
		// Refuse when the budget runs out; upstream falls back to a coarse delete+insert here.
		if (Date.now() > budget.deadline) {
			throw new TextDiffBudgetExceeded();
		}
		// Walk the front path one step.
		for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
			if (--budget.operationsLeft < 0) {
				throw new TextDiffBudgetExceeded();
			}
			const k1Offset = vOffset + k1;
			let x1;
			if (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
				x1 = v1[k1Offset + 1];
			} else {
				x1 = v1[k1Offset - 1] + 1;
			}
			let y1 = x1 - k1;
			while (x1 < text1Length && y1 < text2Length && text1.charAt(x1) === text2.charAt(y1)) {
				x1++;
				y1++;
			}
			v1[k1Offset] = x1;
			if (x1 > text1Length) {
				// Ran off the right of the graph.
				k1end += 2;
			} else if (y1 > text2Length) {
				// Ran off the bottom of the graph.
				k1start += 2;
			} else if (front) {
				const k2Offset = vOffset + delta - k1;
				if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1) {
					// Mirror x2 onto top-left coordinate system.
					const x2 = text1Length - v2[k2Offset];
					if (x1 >= x2) {
						// Overlap detected.
						return bisectSplit(text1, text2, x1, y1, budget);
					}
				}
			}
		}

		// Walk the reverse path one step.
		for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
			if (--budget.operationsLeft < 0) {
				throw new TextDiffBudgetExceeded();
			}
			const k2Offset = vOffset + k2;
			let x2;
			if (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
				x2 = v2[k2Offset + 1];
			} else {
				x2 = v2[k2Offset - 1] + 1;
			}
			let y2 = x2 - k2;
			while (
				x2 < text1Length &&
				y2 < text2Length &&
				text1.charAt(text1Length - x2 - 1) === text2.charAt(text2Length - y2 - 1)
			) {
				x2++;
				y2++;
			}
			v2[k2Offset] = x2;
			if (x2 > text1Length) {
				// Ran off the left of the graph.
				k2end += 2;
			} else if (y2 > text2Length) {
				// Ran off the top of the graph.
				k2start += 2;
			} else if (!front) {
				const k1Offset = vOffset + delta - k2;
				if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
					const x1 = v1[k1Offset];
					const y1 = vOffset + x1 - k1Offset;
					// Mirror x2 onto top-left coordinate system.
					x2 = text1Length - x2;
					if (x1 >= x2) {
						// Overlap detected.
						return bisectSplit(text1, text2, x1, y1, budget);
					}
				}
			}
		}
	}
	// Number of diffs equals number of characters, no commonality at all.
	return [
		[DIFF_DELETE, text1],
		[DIFF_INSERT, text2],
	];
}

/**
 * Given the location of the 'middle snake', split the diff in two parts and recurse.
 */
function bisectSplit(text1: string, text2: string, x: number, y: number, budget: DiffBudget): Diff[] {
	const text1a = text1.substring(0, x);
	const text2a = text2.substring(0, y);
	const text1b = text1.substring(x);
	const text2b = text2.substring(y);

	// Compute both diffs serially.
	const diffs = doDiff(text1a, text2a, { checkLines: false, budget });
	const diffsb = doDiff(text1b, text2b, { checkLines: false, budget });

	return diffs.concat(diffsb);
}

/**
 * Determine the common prefix of two strings.
 */
function getCommonPrefix(text1: string, text2: string): number {
	// Quick check for common null cases.
	if (!text1 || !text2 || text1[0] !== text2[0]) {
		return 0;
	}

	// Binary search.
	// Performance analysis: http://neil.fraser.name/news/2007/10/09/
	let pointerMin = 0;
	let pointerMax = Math.min(text1.length, text2.length);
	let pointerMid = pointerMax;
	let pointerStart = 0;
	while (pointerMin < pointerMid) {
		if (text1.substring(pointerStart, pointerMid) === text2.substring(pointerStart, pointerMid)) {
			pointerMin = pointerMid;
			pointerStart = pointerMin;
		} else {
			pointerMax = pointerMid;
		}
		pointerMid = Math.floor((pointerMax - pointerMin) / 2 + pointerMin);
	}
	return pointerMid;
}

/**
 * Determine the common suffix of two strings.
 */
function getCommonSuffix(text1: string, text2: string): number {
	// Quick check for common null cases.
	if (!text1 || !text2 || text1[text1.length - 1] !== text2[text2.length - 1]) {
		return 0;
	}

	// Binary search.
	// Performance analysis: http://neil.fraser.name/news/2007/10/09/
	let pointerMin = 0;
	let pointerMax = Math.min(text1.length, text2.length);
	let pointerMid = pointerMax;
	let pointerEnd = 0;
	while (pointerMin < pointerMid) {
		if (
			text1.substring(text1.length - pointerMid, text1.length - pointerEnd) ===
			text2.substring(text2.length - pointerMid, text2.length - pointerEnd)
		) {
			pointerMin = pointerMid;
			pointerEnd = pointerMin;
		} else {
			pointerMax = pointerMid;
		}
		pointerMid = Math.floor((pointerMax - pointerMin) / 2 + pointerMin);
	}

	return pointerMid;
}

type HalfMatch = [string, string, string, string, string];

/**
 * Does a slice of shorttext exist within longtext such that the slice is at least half the
 * length of longtext?
 */
function findHalfMatch(text1: string, text2: string): null | HalfMatch {
	const longText = text1.length > text2.length ? text1 : text2;
	const shortText = text1.length > text2.length ? text2 : text1;
	if (longText.length < 4 || shortText.length * 2 < longText.length) {
		return null; // Pointless.
	}

	// First check if the second quarter is the seed for a half-match.
	const halfMatch1 = halfMatchI(longText, shortText, Math.ceil(longText.length / 4));
	// Check again based on the third quarter.
	const halfMatch2 = halfMatchI(longText, shortText, Math.ceil(longText.length / 2));

	let halfMatch;
	if (halfMatch1 && halfMatch2) {
		// Both matched.  Select the longest.
		halfMatch = halfMatch1[4].length > halfMatch2[4].length ? halfMatch1 : halfMatch2;
	} else if (!halfMatch1 && !halfMatch2) {
		return null;
	} else if (!halfMatch2) {
		halfMatch = halfMatch1;
	} else if (!halfMatch1) {
		halfMatch = halfMatch2;
	}

	if (!halfMatch) {
		throw new Error("Unable to find a half match.");
	}

	// A half-match was found, sort out the return data.
	let text1A: string;
	let text1B: string;
	let text2A: string;
	let text2B: string;

	if (text1.length > text2.length) {
		text1A = halfMatch[0];
		text1B = halfMatch[1];
		text2A = halfMatch[2];
		text2B = halfMatch[3];
	} else {
		text2A = halfMatch[0];
		text2B = halfMatch[1];
		text1A = halfMatch[2];
		text1B = halfMatch[3];
	}
	const midCommon = halfMatch[4];
	return [text1A, text1B, text2A, text2B, midCommon];
}

/**
 * Do the two texts share a slice which is at least half the length of the longer text?
 * This speedup can produce non-minimal diffs.
 */
function halfMatchI(longText: string, shortText: string, i: number): null | HalfMatch {
	// Start with a 1/4 length slice at position i as a seed.
	const seed = longText.slice(i, i + Math.floor(longText.length / 4));
	let j = -1;
	let bestCommon = "";
	let bestLongTextA;
	let bestLongTextB;
	let bestShortTextA;
	let bestShortTextB;

	while ((j = shortText.indexOf(seed, j + 1)) !== -1) {
		const prefixLength = getCommonPrefix(longText.slice(i), shortText.slice(j));
		const suffixLength = getCommonSuffix(longText.slice(0, i), shortText.slice(0, j));
		if (bestCommon.length < suffixLength + prefixLength) {
			bestCommon = shortText.slice(j - suffixLength, j) + shortText.slice(j, j + prefixLength);
			bestLongTextA = longText.slice(0, i - suffixLength);
			bestLongTextB = longText.slice(i + prefixLength);
			bestShortTextA = shortText.slice(0, j - suffixLength);
			bestShortTextB = shortText.slice(j + prefixLength);
		}
	}
	if (bestCommon.length * 2 >= longText.length) {
		return [bestLongTextA || "", bestLongTextB || "", bestShortTextA || "", bestShortTextB || "", bestCommon || ""];
	}

	return null;
}

/**
 * Split two texts into an array of strings. Reduce the texts to a string of hashes where each
 * Unicode character represents one line.
 */
function linesToChars(
	textA: string,
	textB: string,
): {
	chars1: string;
	chars2: string;
	lineArray: string[];
} {
	const lineArray: string[] = []; // e.g. lineArray[4] === 'Hello\n'
	const lineHash: { [key: string]: number } = {}; // e.g. lineHash['Hello\n'] === 4

	// '\x00' is a valid character, but various debuggers don't like it.
	// So we'll insert a junk entry to avoid generating a null character.
	lineArray[0] = "";

	/**
	 * Split a text into an array of strings. Reduce the texts to a string of hashes where each
	 * Unicode character represents one line. Modifies linearray and linehash through being a
	 * closure.
	 */
	function diffLinesToMunge(text: string) {
		let chars = "";
		// Walk the text, pulling out a substring for each line.
		// text.split('\n') would would temporarily double our memory footprint.
		// Modifying text would create many large strings to garbage collect.
		let lineStart = 0;
		let lineEnd = -1;
		// Keeping our own length variable is faster than looking it up.
		let lineArrayLength = lineArray.length;
		while (lineEnd < text.length - 1) {
			lineEnd = text.indexOf("\n", lineStart);
			if (lineEnd === -1) {
				lineEnd = text.length - 1;
			}
			let line = text.slice(lineStart, lineEnd + 1);

			// eslint-disable-next-line no-prototype-builtins
			if (lineHash.hasOwnProperty ? lineHash.hasOwnProperty(line) : lineHash[line] !== undefined) {
				chars += String.fromCharCode(lineHash[line]);
			} else {
				if (lineArrayLength === maxLines) {
					// Bail out at 65535 because
					// String.fromCharCode(65536) == String.fromCharCode(0)
					line = text.slice(lineStart);
					lineEnd = text.length;
				}
				chars += String.fromCharCode(lineArrayLength);
				lineHash[line] = lineArrayLength;
				lineArray[lineArrayLength++] = line;
			}
			lineStart = lineEnd + 1;
		}
		return chars;
	}
	// Allocate 2/3rds of the space for textA, the rest for textB.
	let maxLines = 40000;
	const chars1 = diffLinesToMunge(textA);
	maxLines = 65535;
	const chars2 = diffLinesToMunge(textB);
	return { chars1, chars2, lineArray };
}

/**
 * Rehydrate the text in a diff from a string of line hashes to real lines of text.
 */
function charsToLines(diffs: Diff[], lineArray: string[]): void {
	for (let x = 0; x < diffs.length; x++) {
		const chars = diffs[x][1];
		const text: string[] = [];
		for (let y = 0; y < chars.length; y++) {
			text[y] = lineArray[chars.charCodeAt(y)];
		}
		diffs[x][1] = text.join("");
	}
}

function cloneDiff(diff: Diff): Diff {
	return [diff[0], diff[1]];
}

/**
 * Reorder and merge like edit sections. Merge equalities. Any edit section can move as long as
 * it doesn't cross an equality.
 */
function cleanupMerge(rawDiffs: Diff[]): Diff[] {
	let diffs = rawDiffs.map((diff) => cloneDiff(diff));

	// Add a dummy entry at the end.
	diffs.push([DIFF_EQUAL, ""]);
	let pointer = 0;
	let countDelete = 0;
	let countInsert = 0;
	let textDelete = "";
	let textInsert = "";
	let commonlength;
	while (pointer < diffs.length) {
		switch (diffs[pointer][0]) {
			case DIFF_INSERT:
				countInsert++;
				textInsert += diffs[pointer][1];
				pointer++;
				break;
			case DIFF_DELETE:
				countDelete++;
				textDelete += diffs[pointer][1];
				pointer++;
				break;
			case DIFF_EQUAL:
				// Upon reaching an equality, check for prior redundancies.
				if (countDelete + countInsert > 1) {
					if (countDelete !== 0 && countInsert !== 0) {
						// Factor out any common prefixies.
						commonlength = getCommonPrefix(textInsert, textDelete);
						if (commonlength !== 0) {
							if (
								pointer - countDelete - countInsert > 0 &&
								diffs[pointer - countDelete - countInsert - 1][0] === DIFF_EQUAL
							) {
								diffs[pointer - countDelete - countInsert - 1][1] += textInsert.substring(0, commonlength);
							} else {
								diffs.splice(0, 0, [DIFF_EQUAL, textInsert.substring(0, commonlength)]);
								pointer++;
							}
							textInsert = textInsert.substring(commonlength);
							textDelete = textDelete.substring(commonlength);
						}
						// Factor out any common suffixies.
						commonlength = getCommonSuffix(textInsert, textDelete);
						if (commonlength !== 0) {
							diffs[pointer][1] = textInsert.substring(textInsert.length - commonlength) + diffs[pointer][1];
							textInsert = textInsert.substring(0, textInsert.length - commonlength);
							textDelete = textDelete.substring(0, textDelete.length - commonlength);
						}
					}
					// Delete the offending records and add the merged ones.
					pointer -= countDelete + countInsert;
					diffs.splice(pointer, countDelete + countInsert);
					if (textDelete.length) {
						diffs.splice(pointer, 0, [DIFF_DELETE, textDelete]);
						pointer++;
					}
					if (textInsert.length) {
						diffs.splice(pointer, 0, [DIFF_INSERT, textInsert]);
						pointer++;
					}
					pointer++;
				} else if (pointer !== 0 && diffs[pointer - 1][0] === DIFF_EQUAL) {
					// Merge this equality with the previous one.
					diffs[pointer - 1][1] += diffs[pointer][1];
					diffs.splice(pointer, 1);
				} else {
					pointer++;
				}
				countInsert = 0;
				countDelete = 0;
				textDelete = "";
				textInsert = "";
				break;
			default:
				throw new Error("Unknown diff operation");
		}
	}
	if (diffs[diffs.length - 1][1] === "") {
		diffs.pop(); // Remove the dummy entry at the end.
	}

	// Second pass: look for single edits surrounded on both sides by equalities
	// which can be shifted sideways to eliminate an equality.
	// e.g: A<ins>BA</ins>C -> <ins>AB</ins>AC
	let hasChanges = false;
	pointer = 1;
	// Intentionally ignore the first and last element (don't need checking).
	while (pointer < diffs.length - 1) {
		if (diffs[pointer - 1][0] === DIFF_EQUAL && diffs[pointer + 1][0] === DIFF_EQUAL) {
			// This is a single edit surrounded by equalities.
			if (
				diffs[pointer][1].substring(diffs[pointer][1].length - diffs[pointer - 1][1].length) === diffs[pointer - 1][1]
			) {
				// Shift the edit over the previous equality.
				diffs[pointer][1] =
					diffs[pointer - 1][1] + diffs[pointer][1].substring(0, diffs[pointer][1].length - diffs[pointer - 1][1].length);
				diffs[pointer + 1][1] = diffs[pointer - 1][1] + diffs[pointer + 1][1];
				diffs.splice(pointer - 1, 1);
				hasChanges = true;
			} else if (diffs[pointer][1].substring(0, diffs[pointer + 1][1].length) === diffs[pointer + 1][1]) {
				// Shift the edit over the next equality.
				diffs[pointer - 1][1] += diffs[pointer + 1][1];
				diffs[pointer][1] = diffs[pointer][1].substring(diffs[pointer + 1][1].length) + diffs[pointer + 1][1];
				diffs.splice(pointer + 1, 1);
				hasChanges = true;
			}
		}
		pointer++;
	}
	// If shifts were made, the diff needs reordering and another shift sweep.
	if (hasChanges) {
		diffs = cleanupMerge(diffs);
	}

	return diffs;
}

function isHighSurrogate(char: string): boolean {
	const charCode = char.charCodeAt(0);
	return charCode >= 0xd800 && charCode <= 0xdbff;
}

function isLowSurrogate(char: string): boolean {
	const charCode = char.charCodeAt(0);
	return charCode >= 0xdc00 && charCode <= 0xdfff;
}

function combineChar(data: string, char: string, dir: 1 | -1) {
	return dir === 1 ? data + char : char + data;
}

/**
 * Splits out a character in a given direction.
 */
function splitChar(data: string, dir: 1 | -1): [string, string] {
	return dir === 1 ? [data.substring(0, data.length - 1), data[data.length - 1]] : [data.substring(1), data[0]];
}

/**
 * Checks if two entries of the diff has the same character in the same "direction".
 */
function hasSharedChar(diffs: Diff[], i: number, j: number, dir: 1 | -1): boolean {
	return dir === 1
		? diffs[i][1][diffs[i][1].length - 1] === diffs[j][1][diffs[j][1].length - 1]
		: diffs[i][1][0] === diffs[j][1][0];
}

/**
 * Takes in a position of an EQUAL diff-type and attempts to "deisolate" the character for a
 * given direction. By this we mean that we attempt to either "shift" it to the later diffs, or
 * bring another character next into this one. See the installed source for worked examples.
 */
function deisolateChar(diffs: Diff[], i: number, dir: 1 | -1) {
	const inv = dir === 1 ? -1 : 1;
	let insertIdx: null | number = null;
	let deleteIdx: null | number = null;

	let j = i + dir;
	for (; j >= 0 && j < diffs.length && (insertIdx === null || deleteIdx === null); j += dir) {
		const [op, text] = diffs[j];
		if (text.length === 0) {
			continue;
		}

		if (op === DIFF_INSERT) {
			if (insertIdx === null) {
				insertIdx = j;
			}
			continue;
		} else if (op === DIFF_DELETE) {
			if (deleteIdx === null) {
				deleteIdx = j;
			}
			continue;
		} else if (op === DIFF_EQUAL) {
			if (insertIdx === null && deleteIdx === null) {
				// This means that there was two consecutive EQUAL. Kinda weird, but easy to handle.
				const [rest, char] = splitChar(diffs[i][1], dir);
				diffs[i][1] = rest;
				diffs[j][1] = combineChar(diffs[j][1], char, inv);
				return;
			}
			break;
		}
	}

	if (insertIdx !== null && deleteIdx !== null && hasSharedChar(diffs, insertIdx, deleteIdx, dir)) {
		// Special case.
		const [insertText, insertChar] = splitChar(diffs[insertIdx][1], inv);
		const [deleteText] = splitChar(diffs[deleteIdx][1], inv);
		diffs[insertIdx][1] = insertText;
		diffs[deleteIdx][1] = deleteText;
		diffs[i][1] = combineChar(diffs[i][1], insertChar, dir);
		return;
	}

	const [text, char] = splitChar(diffs[i][1], dir);
	diffs[i][1] = text;

	if (insertIdx === null) {
		diffs.splice(j, 0, [DIFF_INSERT, char]);

		// We need to adjust deleteIdx here since it's been shifted
		if (deleteIdx !== null && deleteIdx >= j) deleteIdx++;
	} else {
		diffs[insertIdx][1] = combineChar(diffs[insertIdx][1], char, inv);
	}

	if (deleteIdx === null) {
		diffs.splice(j, 0, [DIFF_DELETE, char]);
	} else {
		diffs[deleteIdx][1] = combineChar(diffs[deleteIdx][1], char, inv);
	}
}

/**
 * Go over each pair of diffs and see if there was a split at a surrogate pair. Keeping this
 * adjustment is what makes every diff boundary safe to use as a `Y.Text` operation boundary:
 * no boundary lands between a high and a low surrogate.
 */
function adjustDiffForSurrogatePairs(diffs: Diff[]) {
	for (let i = 0; i < diffs.length; i++) {
		const [diffType, diffText] = diffs[i];

		if (diffText.length === 0) continue;

		const firstChar = diffText[0];
		const lastChar = diffText[diffText.length - 1];

		if (isHighSurrogate(lastChar) && diffType === DIFF_EQUAL) {
			deisolateChar(diffs, i, 1);
		}

		if (isLowSurrogate(firstChar) && diffType === DIFF_EQUAL) {
			deisolateChar(diffs, i, -1);
		}
	}

	for (let i = 0; i < diffs.length; i++) {
		// Remove any empty diffs
		if (diffs[i][1].length === 0) {
			diffs.splice(i, 1);
		}
	}
}
