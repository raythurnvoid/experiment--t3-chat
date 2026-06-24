import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";

const ELLIPSIS = "…";
const PATH_SEPARATOR = "/";

function segment_graphemes(text: string) {
	if (typeof Intl === "undefined" || !Intl.Segmenter) {
		return Array.from(text);
	}

	return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (segment) => segment.segment);
}

function truncate_middle_segments(middleSegments: string[], visibleCount: number) {
	if (visibleCount <= 0) return [ELLIPSIS];

	let remainingVisibleCount = visibleCount;
	let hasOmittedRemainder = false;
	const truncatedSegments: string[] = [];

	for (const segment of middleSegments) {
		const segmentGraphemes = segment_graphemes(segment);
		if (remainingVisibleCount <= 0) {
			hasOmittedRemainder = true;
			continue;
		}

		const segmentVisibleCount = Math.min(remainingVisibleCount, segmentGraphemes.length);
		remainingVisibleCount -= segmentVisibleCount;
		if (segmentVisibleCount < segmentGraphemes.length) {
			hasOmittedRemainder = true;
		}
		truncatedSegments.push(
			segmentVisibleCount >= segmentGraphemes.length
				? segment
				: `${segmentGraphemes.slice(0, segmentVisibleCount).join("")}${ELLIPSIS}`,
		);
	}

	// Omitted middle remainders are represented by the ellipsis on the previous
	// visible segment, avoiding an extra slash-owned `/…/` after visible content.
	if (hasOmittedRemainder) {
		const lastTruncatedSegment = truncatedSegments[truncatedSegments.length - 1];
		if (lastTruncatedSegment && !lastTruncatedSegment.endsWith(ELLIPSIS)) {
			truncatedSegments[truncatedSegments.length - 1] = `${lastTruncatedSegment}${ELLIPSIS}`;
		}
	}

	return truncatedSegments.length > 0 ? truncatedSegments : [ELLIPSIS];
}

/**
 * `fits` must be monotonic over `visibleCount`: once a longer candidate fails,
 * longer candidates in the same truncation stage must fail too.
 */
function find_max_fitting(
	min: number,
	max: number,
	buildCandidate: (visibleCount: number) => string,
	fits: (candidate: string) => boolean,
) {
	let best: string | null = null;
	let low = min;
	let high = max;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = buildCandidate(mid);

		if (fits(candidate)) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return best;
}

function truncate_middle_path(args: {
	leadingSeparator: string;
	firstSegment: string;
	middleSegments: string[];
	tailSegments: string[];
	fits: (candidate: string) => boolean;
}) {
	const middleGraphemeCount = args.middleSegments.reduce(
		(total, segment) => total + segment_graphemes(segment).length,
		0,
	);

	return find_max_fitting(
		0,
		middleGraphemeCount,
		(visibleCount) =>
			`${args.leadingSeparator}${[
				args.firstSegment,
				...truncate_middle_segments(args.middleSegments, visibleCount),
				...args.tailSegments,
			].join(PATH_SEPARATOR)}`,
		args.fits,
	);
}

function truncate_single_segment(
	leadingSeparator: string,
	segment: string,
	fits: (candidate: string) => boolean,
) {
	const graphemes = segment_graphemes(segment);
	if (graphemes.length === 0) return leadingSeparator;

	const best = find_max_fitting(
		1,
		Math.max(1, graphemes.length - 1),
		(visibleCount) =>
			`${leadingSeparator}${graphemes.slice(0, visibleCount).join("")}${visibleCount < graphemes.length ? ELLIPSIS : ""}`,
		fits,
	);

	return best ?? `${leadingSeparator}${graphemes[0]}${graphemes.length > 1 ? ELLIPSIS : ""}`;
}

export function files_truncate_path_for_width(args: {
	path: string;
	width: number;
	font: string;
	letterSpacing: number;
}) {
	const options = { letterSpacing: args.letterSpacing, whiteSpace: "normal" as const };
	const fits = (candidate: string) => {
		// Pretext measures candidates with caller-owned font metrics so resize work
		// does not need synchronous DOM style reads.
		const stats = measureLineStats(
			prepareWithSegments(candidate, args.font, options),
			args.width,
		);

		return stats.lineCount <= 1 && stats.maxLineWidth <= args.width;
	};

	if (fits(args.path)) return args.path;

	const leadingSeparator = args.path.startsWith(PATH_SEPARATOR) ? PATH_SEPARATOR : "";
	const body = leadingSeparator ? args.path.slice(1) : args.path;
	const segments = body.length > 0 ? body.split(PATH_SEPARATOR) : [];
	if (segments.length === 0) return args.path;
	if (segments.length === 1) {
		return truncate_single_segment(leadingSeparator, segments[0] ?? "", fits);
	}

	const firstSegment = segments[0] ?? "";
	const lastSegment = segments[segments.length - 1] ?? "";

	// First shrink the middle while preserving the first segment and tail context.
	// Only move to stronger truncation stages when that shape cannot fit.
	if (segments.length > 3) {
		const firstAndLastTwo = truncate_middle_path({
			leadingSeparator,
			firstSegment,
			middleSegments: segments.slice(1, -2),
			tailSegments: segments.slice(-2),
			fits,
		});
		if (firstAndLastTwo) return firstAndLastTwo;
	}

	if (segments.length > 2) {
		const firstAndLast = truncate_middle_path({
			leadingSeparator,
			firstSegment,
			middleSegments: segments.slice(1, -1),
			tailSegments: [lastSegment],
			fits,
		});
		if (firstAndLast) return firstAndLast;
	}

	// Once the middle path is gone, spend the remaining budget on the first segment
	// before truncating the last segment.
	const firstGraphemes = segment_graphemes(firstSegment);
	const lastGraphemes = segment_graphemes(lastSegment);
	if (firstGraphemes.length === 0) return truncate_single_segment("", lastSegment, fits);

	if (firstGraphemes.length > 4) {
		const middleFirstSegment = find_max_fitting(
			4,
			firstGraphemes.length - 1,
			(visibleCount) => {
				const startCount = Math.ceil(visibleCount / 2);
				const endCount = Math.floor(visibleCount / 2);
				return `${leadingSeparator}${[
					`${firstGraphemes.slice(0, startCount).join("")}${ELLIPSIS}${firstGraphemes.slice(firstGraphemes.length - endCount).join("")}`,
					lastSegment,
				].join(PATH_SEPARATOR)}`;
			},
			fits,
		);
		if (middleFirstSegment) return middleFirstSegment;
	}

	if (firstGraphemes.length > 2) {
		const firstPrefix = find_max_fitting(
			2,
			firstGraphemes.length - 1,
			(visibleCount) =>
				`${leadingSeparator}${firstGraphemes.slice(0, visibleCount).join("")}${ELLIPSIS}${PATH_SEPARATOR}${lastSegment}`,
			fits,
		);
		if (firstPrefix) return firstPrefix;
	}

	// The last segment remains intact until the first segment is down to one grapheme.
	const firstGraphemeAndLast = `${leadingSeparator}${firstGraphemes[0]}${ELLIPSIS}${PATH_SEPARATOR}${lastSegment}`;
	if (fits(firstGraphemeAndLast)) return firstGraphemeAndLast;

	if (lastGraphemes.length > 1) {
		const truncatedLast = find_max_fitting(
			1,
			lastGraphemes.length - 1,
			(visibleCount) =>
				`${leadingSeparator}${firstGraphemes[0]}${ELLIPSIS}${PATH_SEPARATOR}${lastGraphemes.slice(0, visibleCount).join("")}${ELLIPSIS}`,
			fits,
		);
		if (truncatedLast) return truncatedLast;
	}

	// This is the smallest informative path shape. If it still does not fit,
	// let it overflow instead of hiding both path anchors behind a bare ellipsis.
	return `${leadingSeparator}${firstGraphemes[0]}${ELLIPSIS}${PATH_SEPARATOR}${lastGraphemes[0] ?? ""}${lastGraphemes.length > 1 ? ELLIPSIS : ""}`;
}
