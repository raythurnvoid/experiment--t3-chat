import type { IndexRange } from "convex/server";
import { compareValues, type Value } from "convex/values";

type Bound = ["eq" | "gt" | "gte" | "lt" | "lte", string, Value | undefined];

/**
 * Split one ordered window into native ranges. Each range gets its own query and paginate call.
 * Adapted from convex-helpers/server/stream.ts splitRange. No stream reads run here.
 */
export function files_index_range_phases(args: {
	fields: string[];
	order: "asc" | "desc";
	start: Array<Value | undefined>;
	end: Array<Value | undefined>;
	startInclusive: boolean;
	endInclusive: boolean;
}) {
	let fields = args.fields;
	let start = args.start;
	let end = args.end;
	let startOp: "gt" | "gte" = args.startInclusive ? "gte" : "gt";
	let endOp: "lt" | "lte" = args.endInclusive ? "lte" : "lt";
	for (let index = 0; index < Math.min(start.length, end.length); index++) {
		const order = compareValues(start[index], end[index]);
		if (order > 0) return [];
		if (order < 0) break;
		if (index === start.length - 1 && start.length === end.length && (!args.startInclusive || !args.endInclusive)) return [];
	}
	const prefix: Bound[] = [];
	while (start.length > 0 && end.length > 0 && compareValues(start[0], end[0]) === 0) {
		prefix.push(["eq", fields[0]!, start[0]]);
		fields = fields.slice(1);
		start = start.slice(1);
		end = end.slice(1);
	}
	if (prefix.length > 0 && ((start.length === 0 && !args.startInclusive) || (end.length === 0 && !args.endInclusive))) return [];
	const compare = (op: Bound[0], key: Array<Value | undefined>) => {
		const bounds = prefix.slice();
		for (let index = 0; index < key.length - 1; index++) bounds.push(["eq", fields[index]!, key[index]]);
		if (key.length > 0) bounds.push([op, fields[key.length - 1]!, key.at(-1)]);
		return bounds;
	};
	const starts: Bound[][] = [];
	while (start.length > 1) {
		starts.push(compare(startOp, start));
		startOp = "gt";
		start = start.slice(0, -1);
	}
	const ends: Bound[][] = [];
	while (end.length > 1) {
		ends.push(compare(endOp, end));
		endOp = "lt";
		end = end.slice(0, -1);
	}
	const middle = start.length === 0 ? compare(endOp, end) : compare(startOp, start);
	if (start.length > 0 && end.length > 0) middle.push([endOp, fields[0]!, end[0]]);
	const phases = [...starts, middle, ...ends.reverse()];
	return args.order === "desc" ? phases.reverse() : phases;
}

/**
 * Apply one trusted index phase to the native builder, including its implicit `_id` tie break.
 */
export function files_index_range_apply(q: IndexRange, bounds: Bound[]) {
	let range = q;
	for (const [op, field, value] of bounds) {
		// Convex omits `_id` from its range type. Its indexes include it after `_creationTime`;
		// convex-helpers getIndexFields uses the same suffix. The caller supplies schema fields.
		const builder = range as IndexRange & {
			[Op in Bound[0]]: (field: string, value: Value | undefined) => IndexRange;
		};
		range = builder[op](field, value);
	}
	return range;
}
