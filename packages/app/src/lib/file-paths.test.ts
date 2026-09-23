import { beforeEach, describe, expect, test, vi } from "vitest";

// Unit tests keep Pretext at the module boundary; browser checks own real font measurement.
const { measureCandidateMock, measureLineStatsMock, prepareWithSegmentsMock } = vi.hoisted(() => {
	const measureCandidateMock = vi.fn((candidate: string) => candidate.length);

	return {
		measureCandidateMock,
		measureLineStatsMock: vi.fn((prepared: { candidate: string }, width: number) => {
			const measuredWidth = measureCandidateMock(prepared.candidate);
			return {
				lineCount: measuredWidth <= width ? 1 : 2,
				maxLineWidth: measuredWidth,
			};
		}),
		prepareWithSegmentsMock: vi.fn((candidate: string, font: string, options: unknown) => ({
			candidate,
			font,
			options,
		})),
	};
});

vi.mock("@chenglou/pretext", () => ({
	measureLineStats: measureLineStatsMock,
	prepareWithSegments: prepareWithSegmentsMock,
}));

import { files_truncate_path_for_width, files_truncate_path_segments } from "./file-paths.ts";

const TEST_FONT = "500 16px system-ui";

function grapheme_count(text: string) {
	return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
}

beforeEach(() => {
	measureCandidateMock.mockReset();
	measureCandidateMock.mockImplementation((candidate: string) => candidate.length);
	measureLineStatsMock.mockClear();
	prepareWithSegmentsMock.mockClear();
});

function truncate_path_for_width(path: string, maxLength: number) {
	return files_truncate_path_for_width({
		path,
		width: maxLength,
		font: TEST_FONT,
		letterSpacing: 0,
	});
}

describe("files_truncate_path_for_width", () => {
	test("keeps the full path when it fits", () => {
		const path = "alpha/tasks/task-100.md";

		expect(truncate_path_for_width(path, path.length)).toBe(path);
	});

	test("keeps the first segment and last two segments before stronger truncation", () => {
		const expected = "alpha/inbox…/tasks/task-100.md";

		expect(truncate_path_for_width("alpha/inbox/archive/tasks/task-100.md", expected.length)).toBe(expected);
		expect(expected).not.toContain("/…/");
	});

	test("truncates middle path segments by one grapheme before collapsing them", () => {
		const expected = "/test/deep/aaaaa/bbb…/ccccc/random.md";

		expect(truncate_path_for_width("/test/deep/aaaaa/bbbbb/ccccc/random.md", expected.length)).toBe(expected);
	});

	test("does not add an extra slash-separated ellipsis after visible middle content", () => {
		const expected = "/test/deep/aa…/ccccc/random.md";

		expect(truncate_path_for_width("/test/deep/aaaaa/bbbbb/ccccc/random.md", expected.length)).toBe(expected);
	});

	test("keeps the first segment and last segment when the last two segments do not fit", () => {
		const expected = "alpha/…/task-100.md";

		expect(truncate_path_for_width("alpha/inbox/archive/tasks/task-100.md", expected.length)).toBe(expected);
	});

	test("truncates inside the first segment while keeping the last segment intact", () => {
		const expected = "meta-ev…14817z/msg-alice.md";

		expect(truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length)).toBe(
			expected,
		);
	});

	test("truncates from the first segment through the middle path while keeping the last segment intact", () => {
		const expected = "me…/msg-alice.md";

		expect(truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length)).toBe(
			expected,
		);
	});

	test("keeps one grapheme from the first segment and the full last segment", () => {
		const expected = "m…/msg-alice.md";

		expect(truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length)).toBe(
			expected,
		);
	});

	test("truncates the last segment only after the first segment reaches one grapheme", () => {
		const expected = "m…/msg…";

		expect(truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length)).toBe(
			expected,
		);
	});

	test("falls back to one grapheme from the first and last segment", () => {
		expect(truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", "m…/m…".length)).toBe(
			"m…/m…",
		);
	});

	test("returns the smallest informative path when even that cannot fit", () => {
		expect(truncate_path_for_width("alpha/beta.md", 4)).toBe("a…/b…");
	});

	test("does not split emoji or combining-character graphemes", () => {
		const expected = "👨‍👩‍👧‍👦…/e\u0301…";
		measureCandidateMock.mockImplementation((candidate: string) => grapheme_count(candidate));

		expect(truncate_path_for_width("👨‍👩‍👧‍👦-organization/inbox/e\u0301-file.md", grapheme_count(expected))).toBe(expected);
	});

	test("keeps the leading separator when the first segment is empty", () => {
		expect(truncate_path_for_width("//xyz", 3)).toBe("/x…");
	});

	test("uses explicit font metrics and width for Pretext measurement without computed style", () => {
		const path = "alpha/beta/gamma";
		const getComputedStyleSpy = vi.spyOn(globalThis, "getComputedStyle");

		try {
			expect(
				files_truncate_path_for_width({
					path,
					width: 1000,
					font: TEST_FONT,
					letterSpacing: 0.25,
				}),
			).toBe(path);
			expect(prepareWithSegmentsMock).toHaveBeenCalledWith(path, TEST_FONT, {
				letterSpacing: 0.25,
				whiteSpace: "normal",
			});
			expect(measureLineStatsMock).toHaveBeenCalledWith(expect.objectContaining({ candidate: path }), 1000);
			expect(getComputedStyleSpy).not.toHaveBeenCalled();

			const truncatedPath = files_truncate_path_for_width({
				path,
				width: 8,
				font: TEST_FONT,
				letterSpacing: 0,
			});
			expect(truncatedPath).not.toBe(path);
			expect(truncatedPath).toContain("…");
		} finally {
			getComputedStyleSpy.mockRestore();
		}
	});
});

describe("files_truncate_path_segments", () => {
	// Width = character count of the joined labels, the same rule the mocked Pretext uses above.
	function truncate_segments_keep(segments: string[], width: number) {
		return files_truncate_path_segments({
			segments,
			collapse: "keep",
			fits: (labels) => labels.join("/").length <= width,
		});
	}

	const A = ["alpha", "inbox", "archive", "tasks", "task-100.md"];
	const B = ["meta-eval-fixture-20260623t014817z", "inbox", "msg-alice.md"];

	test("keeps every segment whole when the path fits", () => {
		expect(truncate_segments_keep(A, 37)).toEqual(A);
	});

	test("turns a middle segment into an ellipsis instead of dropping it", () => {
		expect(truncate_segments_keep(A, 31)).toEqual(["alpha", "inbox", "…", "tasks", "task-100.md"]);
	});

	test("keeps the first segment and the last two before shortening the first", () => {
		expect(truncate_segments_keep(A, 27)).toEqual(["alpha", "…", "…", "tasks", "task-100.md"]);
	});

	test("shortens the first segment to a prefix while the last stays whole", () => {
		// The middle-ellipsis stage (`al…ha`) needs 23 characters here.
		expect(truncate_segments_keep(A, 22)).toEqual(["alp…", "…", "…", "…", "task-100.md"]);
	});

	test("keeps one grapheme of the first segment and the whole last segment", () => {
		expect(truncate_segments_keep(A, 20)).toEqual(["a…", "…", "…", "…", "task-100.md"]);
	});

	test("shortens the last segment last", () => {
		expect(truncate_segments_keep(A, 14)).toEqual(["a…", "…", "…", "…", "task…"]);
	});

	test("returns the smallest shape even when it does not fit", () => {
		expect(truncate_segments_keep(A, 5)).toEqual(["a…", "…", "…", "…", "t…"]);
	});

	test("truncates inside the first segment before its prefix", () => {
		expect(truncate_segments_keep(B, 29)).toEqual(["meta-ev…14817z", "…", "msg-alice.md"]);
		expect(truncate_segments_keep(B, 18)).toEqual(["me…", "…", "msg-alice.md"]);
		expect(truncate_segments_keep(B, 9)).toEqual(["m…", "…", "msg…"]);
	});

	test("does not split emoji or combining-character graphemes", () => {
		const labels = files_truncate_path_segments({
			segments: ["👨‍👩‍👧‍👦-organization", "inbox", "e\u0301-file.md"],
			collapse: "keep",
			fits: (candidate) => grapheme_count(candidate.join("/")) <= 7,
		});

		expect(labels).toEqual(["👨‍👩‍👧‍👦…", "…", "e\u0301…"]);
	});

	test("shortens a single segment", () => {
		expect(truncate_segments_keep(["task-100.md"], 5)).toEqual(["task…"]);
	});

	test("measures every candidate with one label per segment", () => {
		const seenLengths: number[] = [];

		files_truncate_path_segments({
			segments: A,
			collapse: "keep",
			fits: (labels) => {
				seenLengths.push(labels.length);
				return labels.join("/").length <= 14;
			},
		});

		expect(seenLengths.length).toBeGreaterThan(0);
		expect(seenLengths.every((length) => length === A.length)).toBe(true);
	});

	test("keeps whole middle segments that a single binary search over the grapheme count would miss", () => {
		// An ellipsis costs three here, so a cut segment is wider than the same segment whole. The
		// candidate width then drops when a segment becomes whole, which breaks one binary search
		// over the total grapheme count: it settles on `a…` although two whole middles fit.
		const cost = (labels: string[]) => labels.join("/").replaceAll("…", "...").length;

		expect(
			files_truncate_path_segments({
				segments: ["s", "abcde", "de", "fghij", "t"],
				collapse: "keep",
				fits: (labels) => cost(labels) <= 16,
			}),
		).toEqual(["s", "abcde", "de", "…", "t"]);
	});
});
