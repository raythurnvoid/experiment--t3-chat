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

import { files_truncate_path_for_width } from "./file-paths.ts";

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

		expect(
			truncate_path_for_width("alpha/inbox/archive/tasks/task-100.md", expected.length),
		).toBe(expected);
		expect(expected).not.toContain("/…/");
	});

	test("truncates middle path segments by one grapheme before collapsing them", () => {
		const expected = "/test/deep/aaaaa/bbb…/ccccc/random.md";

		expect(
			truncate_path_for_width("/test/deep/aaaaa/bbbbb/ccccc/random.md", expected.length),
		).toBe(expected);
	});

	test("does not add an extra slash-separated ellipsis after visible middle content", () => {
		const expected = "/test/deep/aa…/ccccc/random.md";

		expect(
			truncate_path_for_width("/test/deep/aaaaa/bbbbb/ccccc/random.md", expected.length),
		).toBe(expected);
	});

	test("keeps the first segment and last segment when the last two segments do not fit", () => {
		const expected = "alpha/…/task-100.md";

		expect(
			truncate_path_for_width("alpha/inbox/archive/tasks/task-100.md", expected.length),
		).toBe(expected);
	});

	test("truncates inside the first segment while keeping the last segment intact", () => {
		const expected = "meta-ev…14817z/msg-alice.md";

		expect(
			truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length),
		).toBe(expected);
	});

	test("truncates from the first segment through the middle path while keeping the last segment intact", () => {
		const expected = "me…/msg-alice.md";

		expect(
			truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length),
		).toBe(expected);
	});

	test("keeps one grapheme from the first segment and the full last segment", () => {
		const expected = "m…/msg-alice.md";

		expect(
			truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length),
		).toBe(expected);
	});

	test("truncates the last segment only after the first segment reaches one grapheme", () => {
		const expected = "m…/msg…";

		expect(
			truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", expected.length),
		).toBe(expected);
	});

	test("falls back to one grapheme from the first and last segment", () => {
		expect(
			truncate_path_for_width("meta-eval-fixture-20260623t014817z/inbox/msg-alice.md", "m…/m…".length),
		).toBe("m…/m…");
	});

	test("returns the smallest informative path when even that cannot fit", () => {
		expect(
			truncate_path_for_width("alpha/beta.md", 4),
		).toBe("a…/b…");
	});

	test("does not split emoji or combining-character graphemes", () => {
		const expected = "👨‍👩‍👧‍👦…/e\u0301…";
		measureCandidateMock.mockImplementation((candidate: string) => grapheme_count(candidate));

		expect(
			truncate_path_for_width("👨‍👩‍👧‍👦-organization/inbox/e\u0301-file.md", grapheme_count(expected)),
		).toBe(expected);
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
