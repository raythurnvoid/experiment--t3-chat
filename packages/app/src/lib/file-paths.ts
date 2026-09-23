import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";

const ELLIPSIS = "…";
const PATH_SEPARATOR = "/";

function segment_graphemes(text: string) {
	if (typeof Intl === "undefined" || !Intl.Segmenter) {
		return Array.from(text);
	}

	return Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
		(segment) => segment.segment,
	);
}

/**
 * Build the middle labels of one candidate shape: the first `wholeCount` segments whole, then
 * `prefixCount` graphemes of the next one, then nothing.
 *
 * `drop` leaves out every segment that has no room and puts the `…` on the last label, so a joined
 * path never shows an extra `/…/` after visible text. `keep` gives every segment its own label, and
 * a segment with no room becomes `…`.
 */
function truncate_middle_labels(args: {
	middleGraphemes: string[][];
	wholeCount: number;
	prefixCount: number;
	collapse: "drop" | "keep";
}) {
	const labels: string[] = [];

	for (let index = 0; index < args.middleGraphemes.length; index += 1) {
		const graphemes = args.middleGraphemes[index] ?? [];
		if (index < args.wholeCount) {
			labels.push(graphemes.join(""));
		} else if (index === args.wholeCount && args.prefixCount > 0) {
			labels.push(`${graphemes.slice(0, args.prefixCount).join("")}${ELLIPSIS}`);
		} else if (args.collapse === "keep") {
			labels.push(ELLIPSIS);
		}
	}

	if (args.collapse === "drop") {
		// Put the `…` on the last visible label for the segments that were left out, so the joined
		// path never shows an extra `/…/` after visible text.
		const isComplete = args.wholeCount >= args.middleGraphemes.length;
		const lastLabel = labels[labels.length - 1];
		if (!isComplete && lastLabel !== undefined && !lastLabel.endsWith(ELLIPSIS)) {
			labels[labels.length - 1] = `${lastLabel}${ELLIPSIS}`;
		}
		if (labels.length === 0) {
			labels.push(ELLIPSIS);
		}
	}

	return labels;
}

/**
 * `fits` must be monotonic over `visibleCount`: once a longer candidate fails, longer candidates in
 * the same search must fail too. That holds while the search stays inside one segment (a longer
 * prefix that keeps its `…` is always wider). It does not hold across segments in `keep` mode, so
 * `truncate_middle_segments` runs one search per cut segment instead of one over all of them.
 */
function find_max_fitting<Candidate>(
	min: number,
	max: number,
	buildCandidate: (visibleCount: number) => Candidate,
	fits: (candidate: Candidate) => boolean,
) {
	let best: Candidate | null = null;
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

/**
 * Shrink the middle segments while the first segment and the tail stay whole.
 *
 * The search has two levels. The outer loop tries fewer whole middle segments each time. The inner
 * binary search finds the longest prefix of the first cut segment. One binary search over the total
 * grapheme count is not enough in `keep` mode: a cut segment costs its `…`, and that cost goes away
 * the moment the segment becomes whole, so the width does not always grow with the count. Inside one
 * segment the width does grow with the prefix, so the binary search is safe there. In `drop` mode
 * the width is monotonic anyway, and this finds the same shape a single binary search would.
 */
function truncate_middle_segments(args: {
	firstSegment: string;
	middleSegments: string[];
	tailSegments: string[];
	collapse: "drop" | "keep";
	fits: (labels: string[]) => boolean;
}) {
	const middleGraphemes = args.middleSegments.map(segment_graphemes);

	for (let wholeCount = middleGraphemes.length; wholeCount >= 0; wholeCount -= 1) {
		const cutGraphemes = middleGraphemes[wholeCount];
		const best = find_max_fitting(
			0,
			cutGraphemes ? Math.max(0, cutGraphemes.length - 1) : 0,
			(prefixCount) => [
				args.firstSegment,
				...truncate_middle_labels({ middleGraphemes, wholeCount, prefixCount, collapse: args.collapse }),
				...args.tailSegments,
			],
			args.fits,
		);
		if (best) return best;
	}

	return null;
}

/**
 * Shorten one segment to the longest prefix (plus `…`) whose labels fit. Fall back to its first
 * grapheme when even that does not fit. `wrap` places the label among the other labels of the shape.
 */
function truncate_segment_prefix(
	graphemes: string[],
	wrap: (label: string) => string[],
	fits: (labels: string[]) => boolean,
) {
	if (graphemes.length === 0) return wrap("");

	const best = find_max_fitting(
		1,
		Math.max(1, graphemes.length - 1),
		(visibleCount) =>
			wrap(`${graphemes.slice(0, visibleCount).join("")}${visibleCount < graphemes.length ? ELLIPSIS : ""}`),
		fits,
	);

	return best ?? wrap(`${graphemes[0]}${graphemes.length > 1 ? ELLIPSIS : ""}`);
}

/**
 * Shorten path segments until `fits` accepts them.
 *
 * `collapse: "drop"` removes middle segments that no longer fit. One joined path string has no
 * place to show a dropped segment, so dropping is correct there. It can return fewer labels than
 * `segments`. `collapse: "keep"` gives every segment its own label, so a caller that renders one
 * link per segment never loses a link. It always returns exactly `segments.length` labels.
 *
 * `fits` owns all measurement. The last shape is returned without being measured, so the result is
 * not guaranteed to fit. `keep` always returns the same number of labels, so a caller may add a
 * fixed cost per label. `drop` does not, so a per-label cost is wrong there.
 */
export function files_truncate_path_segments(args: {
	segments: string[];
	collapse: "drop" | "keep";
	fits: (labels: string[]) => boolean;
}) {
	if (args.fits(args.segments)) return args.segments;
	if (args.segments.length === 0) return args.segments;
	if (args.segments.length === 1) {
		return truncate_segment_prefix(segment_graphemes(args.segments[0] ?? ""), (label) => [label], args.fits);
	}

	const firstSegment = args.segments[0] ?? "";
	const lastSegment = args.segments[args.segments.length - 1] ?? "";

	// First shrink the middle while preserving the first segment and tail context.
	// Only move to stronger truncation stages when that shape cannot fit.
	if (args.segments.length > 3) {
		const firstAndLastTwo = truncate_middle_segments({
			firstSegment,
			middleSegments: args.segments.slice(1, -2),
			tailSegments: args.segments.slice(-2),
			collapse: args.collapse,
			fits: args.fits,
		});
		if (firstAndLastTwo) return firstAndLastTwo;
	}

	if (args.segments.length > 2) {
		const firstAndLast = truncate_middle_segments({
			firstSegment,
			middleSegments: args.segments.slice(1, -1),
			tailSegments: [lastSegment],
			collapse: args.collapse,
			fits: args.fits,
		});
		if (firstAndLast) return firstAndLast;
	}

	// From here on the middle segments have no room. `drop` leaves them out of the labels. `keep`
	// shows each one as `…`, so the caller still renders one link per segment.
	const middleLabels = args.collapse === "drop" ? [] : args.segments.slice(1, -1).map(() => ELLIPSIS);

	// Once the middle segments have no room, spend the remaining budget on the first segment
	// before truncating the last segment.
	const firstGraphemes = segment_graphemes(firstSegment);
	const lastGraphemes = segment_graphemes(lastSegment);
	// An empty first segment has nothing to show. `drop` leaves its label out too, so the joined
	// path does not start with a doubled separator.
	if (firstGraphemes.length === 0) {
		return truncate_segment_prefix(
			lastGraphemes,
			(label) => (args.collapse === "drop" ? [label] : ["", ...middleLabels, label]),
			args.fits,
		);
	}

	if (firstGraphemes.length > 4) {
		const middleFirstSegment = find_max_fitting(
			4,
			firstGraphemes.length - 1,
			(visibleCount) => {
				const startCount = Math.ceil(visibleCount / 2);
				const endCount = Math.floor(visibleCount / 2);
				return [
					`${firstGraphemes.slice(0, startCount).join("")}${ELLIPSIS}${firstGraphemes.slice(firstGraphemes.length - endCount).join("")}`,
					...middleLabels,
					lastSegment,
				];
			},
			args.fits,
		);
		if (middleFirstSegment) return middleFirstSegment;
	}

	if (firstGraphemes.length > 2) {
		const firstPrefix = find_max_fitting(
			2,
			firstGraphemes.length - 1,
			(visibleCount) => [`${firstGraphemes.slice(0, visibleCount).join("")}${ELLIPSIS}`, ...middleLabels, lastSegment],
			args.fits,
		);
		if (firstPrefix) return firstPrefix;
	}

	// The last segment remains intact until the first segment is down to one grapheme.
	const firstGraphemeLabel = `${firstGraphemes[0]}${ELLIPSIS}`;
	const firstGraphemeAndLast = [firstGraphemeLabel, ...middleLabels, lastSegment];
	if (args.fits(firstGraphemeAndLast)) return firstGraphemeAndLast;

	// Last, shorten the last segment. `truncate_segment_prefix` falls back to its first grapheme plus
	// `…`, the smallest shape that still shows both ends of the path. If even that does not fit, let
	// it overflow instead of hiding both ends behind a bare ellipsis.
	return truncate_segment_prefix(lastGraphemes, (label) => [firstGraphemeLabel, ...middleLabels, label], args.fits);
}

export function files_truncate_path_for_width(args: {
	path: string;
	width: number;
	font: string;
	letterSpacing: number;
}) {
	const options = { letterSpacing: args.letterSpacing, whiteSpace: "normal" as const };
	const leadingSeparator = args.path.startsWith(PATH_SEPARATOR) ? PATH_SEPARATOR : "";
	const body = leadingSeparator ? args.path.slice(1) : args.path;
	const segments = body.length > 0 ? body.split(PATH_SEPARATOR) : [];

	const labels = files_truncate_path_segments({
		segments,
		collapse: "drop",
		fits: (candidateLabels) => {
			// Pretext measures candidates with caller-owned font metrics so resize work
			// does not need synchronous DOM style reads.
			const stats = measureLineStats(
				prepareWithSegments(`${leadingSeparator}${candidateLabels.join(PATH_SEPARATOR)}`, args.font, options),
				args.width,
			);

			return stats.lineCount <= 1 && stats.maxLineWidth <= args.width;
		},
	});

	return `${leadingSeparator}${labels.join(PATH_SEPARATOR)}`;
}
