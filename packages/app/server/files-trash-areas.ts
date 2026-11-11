// The Trash area list that `files/trash/areas` and the agent's `trash areas` share. One internal query
// (`public_api_files_organize.list_trash_areas_page`) reads one page of one stream. The merge below
// joins the streams by `treePath`.

import { compareValues, v, type Infer } from "convex/values";
import type { Id } from "../convex/_generated/dataModel.js";
import type { files_SavedStream } from "../shared/files.ts";

export const files_trash_areas_key_validator = v.object({ treePath: v.string(), nodeId: v.string() });

export type files_trash_areas_Key = Infer<typeof files_trash_areas_key_validator>;

export function files_trash_areas_compare_keys(a: files_trash_areas_Key, b: files_trash_areas_Key) {
	return compareValues([a.treePath, a.nodeId], [b.treePath, b.nodeId]);
}

type Row = { nodeId: Id<"files_nodes">; path: string; treePath: string };

/**
 * Merge the principal streams of each saved source into one page of at most `numItems` areas after
 * `afterKey`, by `treePath`. `read_page` reads one page of one stream. A page can be short with a
 * cursor: rows past the first unfinished stream wait for the next round.
 */
export async function files_trash_areas_merge_page(args: {
	sources: files_SavedStream[];
	afterKey: files_trash_areas_Key | null;
	numItems: number;
	read_page: (page: {
		source: files_SavedStream;
		principalIndex: 0 | 1 | 2 | 3;
		afterKey: files_trash_areas_Key | null;
		numItems: number;
	}) => Promise<
		{ status: "denied" } | { status: "page"; rows: Row[]; frontier: files_trash_areas_Key | null; isDone: boolean }
	>;
}) {
	const { sources, numItems } = args;
	let afterKey = args.afterKey;
	const key_of = (row: Row): files_trash_areas_Key => ({ treePath: row.treePath, nodeId: row.nodeId });
	const page: Row[] = [];
	let isDone = false;
	// The first round runs even with `numItems: 0`, so a guest still gets "denied".
	for (let round = 0; round < 8 && (round === 0 || page.length < numItems); round++) {
		const batches: Array<{ rows: Row[]; frontier: files_trash_areas_Key | null; done: boolean }> = [];
		for (const source of sources) {
			for (const principalIndex of [0, 1, 2, 3] as const) {
				const result = await args.read_page({
					source,
					principalIndex,
					afterKey,
					// One more, because the first row can be the cursor row itself.
					numItems: numItems - page.length + 1,
				});
				if (result.status === "denied") return { status: "denied" as const };
				batches.push({ rows: result.rows, frontier: result.isDone ? null : result.frontier, done: result.isDone });
			}
		}
		// Keep only rows up to the lowest unfinished frontier: a stream may still hold rows before it.
		const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
		frontiers.sort(files_trash_areas_compare_keys);
		const windowEnd = frontiers[0] ?? null;
		const rows = batches
			.flatMap((batch) => batch.rows)
			.filter((row) => windowEnd === null || files_trash_areas_compare_keys(key_of(row), windowEnd) <= 0)
			.sort((a, b) => files_trash_areas_compare_keys(key_of(a), key_of(b)));
		// A folder shared with several principals is in several streams. Staging or cleanup may expose the
		// same folder in both sources too.
		const seen = new Set<Id<"files_nodes">>(page.map((row) => row.nodeId));
		const unique = rows.filter((row) => {
			if (seen.has(row.nodeId)) return false;
			seen.add(row.nodeId);
			return true;
		});
		const remaining = numItems - page.length;
		if (unique.length > remaining) {
			page.push(...unique.slice(0, remaining));
			// With `limit: 1` the first page of `files/trash/areas` holds only the open area, so the next
			// page starts at the top.
			if (page.length > 0) afterKey = key_of(page.at(-1)!);
			break;
		}
		page.push(...unique);
		isDone = batches.every((batch) => batch.done);
		afterKey = windowEnd ?? (page.length > 0 ? key_of(page.at(-1)!) : afterKey);
		if (isDone) break;
	}
	return { status: "page" as const, page, afterKey, isDone };
}
