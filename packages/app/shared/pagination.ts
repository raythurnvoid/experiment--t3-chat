// Generic pagination helpers shared across features.

import { Result } from "./errors-as-values-utils.ts";

/**
 * Composite cursor for `pagination_fan_out_paginate`.
 *
 * The `sources` snapshot pins the `[key, fingerprint]` listing the pagination
 * started from, so any source added, removed, reordered, or re-fingerprinted
 * mid-pagination is reported as "listing changed" instead of silently skipping
 * or duplicating items across pages.
 */
export type pagination_FanOutCursor = {
	kind: "fan_out";
	/** Stream identity set by the caller; cursors created under another scope are rejected. */
	scope: string;
	/** `[sourceKey, sourceFingerprint]` pairs in iteration order when pagination started. */
	sources: Array<[string, string]>;
	/** Source key the next page resumes from. */
	sourceKey: string;
	/** Cursor inside that source's page stream, or null to start it fresh. */
	innerCursor: string | null;
};

/**
 * Upper bound on `runPage` calls per invocation. Inner streams may return
 * short pages long before the requested item count (e.g. scan budgets with
 * post-filters), so one invocation could otherwise chain an unbounded number
 * of inner calls; hitting the bound returns a short page with a continuation
 * cursor instead.
 */
const FAN_OUT_MAX_RUN_PAGE_CALLS = 32;

/**
 * Paginate one inner page stream per source, in `sources` order, as a single
 * continuous page stream under one composite cursor.
 *
 * `runPage` produces one inner page for a source (a paginated Convex query, an
 * HTTP page fetch, ...) and returns items already mapped to their fan-out
 * shape. The returned `continueCursor` is the raw composite cursor payload;
 * how it is stored and transported is up to the caller.
 *
 * Failure messages are short literal-typed markers, not display text; callers
 * build their own user-facing messages from them: "invalid cursor" when
 * `cursor` is not a fan-out cursor for this `scope`, "listing changed" when
 * the current source listing differs from the cursor's snapshot.
 */
export async function pagination_fan_out_paginate<TSource, TItem>(args: {
	/** Identifies this fan-out stream; cursors created under another scope are rejected. */
	scope: string;
	/** Sources in pagination order. `key` must be unique; `fingerprint` extends listing-change detection (e.g. a version id). */
	sources: Array<{ key: string; fingerprint: string; source: TSource }>;
	/** Raw composite cursor payload from a previous page, or null for the first page. */
	cursor: string | null;
	limit: number;
	runPage: (pageArgs: {
		source: TSource;
		innerCursor: string | null;
		numItems: number;
	}) => Promise<{ items: TItem[]; continueCursor: string; isDone: boolean }>;
}) {
	const currentListing: pagination_FanOutCursor["sources"] = args.sources.map((entry) => [
		entry.key,
		entry.fingerprint,
	]);

	let startIndex = 0;
	let startInnerCursor: string | null = null;
	if (args.cursor != null) {
		let parsedCursor: pagination_FanOutCursor | null = null;
		try {
			const raw = JSON.parse(args.cursor) as pagination_FanOutCursor;
			if (raw != null && typeof raw === "object" && raw.kind === "fan_out" && raw.scope === args.scope) {
				parsedCursor = raw;
			}
		} catch {
			// Not a fan-out cursor payload; fall through to the invalid-cursor error.
		}
		if (parsedCursor == null) {
			return Result({
				_nay: { message: "invalid cursor" },
			});
		}
		// Any difference in the source listing invalidates the whole pagination:
		// pages already returned may no longer line up with the current sources.
		if (JSON.stringify(parsedCursor.sources) !== JSON.stringify(currentListing)) {
			return Result({
				_nay: { message: "listing changed" },
			});
		}
		const resumeKey = parsedCursor.sourceKey;
		startIndex = args.sources.findIndex((entry) => entry.key === resumeKey);
		if (startIndex < 0) {
			return Result({
				_nay: { message: "invalid cursor" },
			});
		}
		startInnerCursor = parsedCursor.innerCursor;
	}

	const items: TItem[] = [];
	let runPageCalls = 0;
	for (let index = startIndex; index < args.sources.length; index++) {
		const entry = args.sources[index];
		let innerCursor = index === startIndex ? startInnerCursor : null;
		let sourceDone = false;
		// Inner streams can return short pages before their scan budget; keep
		// requesting the same source until it fills, finishes, or the per-call
		// budget runs out.
		while (!sourceDone && items.length < args.limit && runPageCalls < FAN_OUT_MAX_RUN_PAGE_CALLS) {
			runPageCalls++;
			const page = await args.runPage({ source: entry.source, innerCursor, numItems: args.limit - items.length });
			items.push(...page.items);
			innerCursor = page.continueCursor;
			sourceDone = page.isDone;
		}
		if (!sourceDone) {
			return Result({
				_yay: {
					items,
					continueCursor: JSON.stringify({
						kind: "fan_out",
						scope: args.scope,
						sources: currentListing,
						sourceKey: entry.key,
						innerCursor,
					} satisfies pagination_FanOutCursor),
					isDone: false,
				},
			});
		}
		if (items.length >= args.limit && index + 1 < args.sources.length) {
			return Result({
				_yay: {
					items,
					continueCursor: JSON.stringify({
						kind: "fan_out",
						scope: args.scope,
						sources: currentListing,
						sourceKey: args.sources[index + 1].key,
						innerCursor: null,
					} satisfies pagination_FanOutCursor),
					isDone: false,
				},
			});
		}
	}
	return Result({ _yay: { items, continueCursor: null, isDone: true } });
}
