// The recursive walk (`ls -R`, `find`, `tree`, `meta search`, the API's `recursive: true` and the
// search box's custom-field search). It reads a folder's subtree one restricted area at a time, so it
// never reads a row under a folder the caller cannot open.
//
// Nodes with the same `restrictedScopeNodeId` form an area. A caller who can open an area's root can
// open every row of it, so a frame reads its area's rows with no check per row (only the job-lag
// rows, see below). The restricted folders directly inside an area are its boundaries
// (`parentScopeNodeId`). At each boundary the walk enters (a readable root) or stops (a locked one:
// a locked row and a "Permission denied" line, and nothing under it is read).
//
// The walk runs in the action: each stream page is its own internal query with one `.paginate()`.
// Only the top frame is read, so the walk is depth first. The cursor holds only the top frame's root
// and one key; `resolve_stack` rebuilds the frames above it.
//
// While a scope job runs, a row can still point at its old area. It comes from that area's frame,
// maybe a little out of path order, and its own check decides it (locked when not readable).
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import { compareValues, v, type Infer, type Value } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import { convex_invalid_cursor_error } from "./convex-utils.ts";
import { files_index_range_apply, files_index_range_phases } from "./files-index-range.ts";
import type { files_saved_stream_db_create } from "./files-saved-stream.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

/**
 * The stream calls of one page. Each call returns at least one row, one boundary or the end of a
 * stream, so every page moves on. An action page that runs the walk more than once shares this budget.
 */
export const files_tree_walk_MAX_CALLS = 64;

/**
 * Boundaries per call. Each one reads its grants (about 4 point reads, more for an "Add people" chain).
 */
const WALK_BOUNDARY_PAGE = 25;

const WALK_ROW_PAGE = 100;

/**
 * Restricted folders above the top frame. A path has at most 1,024 characters, so about 500 levels.
 */
const WALK_MAX_DEPTH = 600;

const bound_validator = v.object({ key: v.array(v.any()), inclusive: v.boolean() });

/**
 * One stream call of a frame: the rows of one area in one node's range, from `lower`.
 */
export const files_tree_walk_frame_validator = v.object({
	/** The area: a restricted root, a former root whose job still runs, or null for open rows. */
	scopeNodeId: v.union(v.id("files_nodes"), v.null()),
	/** The frame's node. A folder frame reads its subtree, a file frame only that file. */
	treePath: v.string(),
	kind: v.union(v.literal("folder"), v.literal("file")),
	lower: bound_validator,
	/** The native range of `files_index_range_phases` this call reads. */
	phase: v.number(),
});

export type files_tree_walk_FrameArgs = Infer<typeof files_tree_walk_frame_validator>;

type Key = Value[];
type Bound = { key: Key; inclusive: boolean };

// A walk key is `treePath`, a rank, then the stream's two id fields. At one path the boundary comes
// before the rows: a metadata doc and its node have the same path but different ids.
const BOUNDARY = 0;
const ROW = 1;

// A stream's frontier of only a `treePath` says every row before that path is decided (the rows under a
// folder the user's drafts hide). It stays a path-only key, so the walk goes on at that path.
function walk_key(key: Key, rank: number): Key {
	return key.length === 1 ? key : [key[0], rank, ...key.slice(1)];
}

function native_key(key: Key): Key {
	return [key[0], ...key.slice(2)];
}

/**
 * A walk bound as the native bound of a stream of one rank.
 */
function native_lower(lower: Bound, rank: number): Bound {
	if (lower.key.length === 1) return lower;
	if (lower.key[1] === rank) return { key: [lower.key[0], ...lower.key.slice(2)], inclusive: lower.inclusive };
	// After a boundary every row at its path is still to read; after a row every boundary there is read.
	return { key: [lower.key[0]], inclusive: rank === ROW };
}

export const files_tree_walk_cursor_schema = z.object({
	/** The start's `treePath`. A rename of the start ends the cursor. */
	start: z.string(),
	/** The top frame's root, or null for the start frame. Its `treePath` catches a rename. */
	top: z.object({ nodeId: z.string(), treePath: z.string() }).nullable(),
	/** Where the top frame goes on, as a walk key. */
	after: z.object({ key: z.array(z.any()), inclusive: z.boolean() }),
});

export type files_tree_walk_Cursor = z.infer<typeof files_tree_walk_cursor_schema>;

type Frame = {
	scopeNodeId: Id<"files_nodes"> | null;
	treePath: string;
	kind: "folder" | "file";
	/** The frame root's stream key, so its parent goes on after it. Null for the start frame. */
	root: { nodeId: Id<"files_nodes">; key: Key } | null;
};

export const files_tree_walk_boundary_status_validator = v.union(
	v.literal("readable"),
	v.literal("locked"),
	v.literal("former_readable"),
	v.literal("former_locked"),
);

type BoundaryStatus = Infer<typeof files_tree_walk_boundary_status_validator>;

/**
 * One boundary of a frame, as the caller's query returns it.
 */
export type files_tree_walk_Boundary<Row> = {
	node: Pick<Doc<"files_nodes">, "_id" | "treePath" | "kind">;
	status: BoundaryStatus;
	/** The locked row to list, or null when it does not match the filter. */
	row: Row | null;
	/** The path of the "Permission denied" line. */
	path: string;
};

/**
 * One call of a stream: one native page. `frontier` is the key of the last row the call read,
 * before any check, so rows up to it are decided.
 */
type StreamCall<T> = (
	frame: files_tree_walk_FrameArgs,
	numItems: number,
) => Promise<{ items: Array<{ key: Key; value: T }>; frontier: Key | null; phaseCount: number; isDone: boolean }>;

const invalid_cursor = () =>
	convex_invalid_cursor_error("The folder changed since the last page. Run the command again.");

/**
 * The end of a frame's range: after a folder's subtree, or right after a file.
 */
function frame_end(frame: { treePath: string; kind: "folder" | "file" }) {
	return frame.kind === "folder" ? path_tree_prefix_upper_bound(frame.treePath) : `${frame.treePath}\u0000`;
}

/**
 * The native range of one stream call. Index fields: `treePath`, then the two id fields
 * (`_creationTime`, `_id`, or `nodeCreationTime`, `nodeId` on a Move view).
 */
export function files_tree_walk_phase(frame: files_tree_walk_FrameArgs, idFields: [string, string]) {
	// A cursor key before the frame reads from the frame's start.
	const lower =
		compareValues(frame.lower.key, [frame.treePath]) < 0 ? { key: [frame.treePath], inclusive: true } : frame.lower;
	const phases = files_index_range_phases({
		fields: ["treePath", ...idFields],
		order: "asc",
		start: lower.key,
		startInclusive: lower.inclusive,
		end: [frame_end(frame)],
		endInclusive: false,
	});
	return { bounds: phases[frame.phase] ?? null, phaseCount: phases.length };
}

/**
 * Whether the walk enters a boundary. A former root's own row is in its parent's area already; its
 * old area is checked by its live scope (`access_control_db_resolve_live_restricted_scope`).
 */
export async function files_tree_walk_boundary_status(
	node: Doc<"files_nodes">,
	can: (node: Doc<"files_nodes">) => Promise<boolean>,
): Promise<BoundaryStatus> {
	if (node.restrictedScopeNodeId === node._id) return (await can(node)) ? "readable" : "locked";
	return (await can({ ...node, restrictedScopeNodeId: node._id, extendedScopeNodeId: null }))
		? "former_readable"
		: "former_locked";
}

/**
 * One page of a frame's boundaries, with each one's status.
 */
export async function files_tree_walk_db_boundaries(args: {
	saved: Awaited<ReturnType<typeof files_saved_stream_db_create>>;
	frame: files_tree_walk_FrameArgs;
	numItems: number;
	can: (node: Doc<"files_nodes">) => Promise<boolean>;
}) {
	const { bounds, phaseCount } = files_tree_walk_phase(
		args.frame,
		args.saved.tag ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"],
	);
	if (!bounds) return { page: [], frontier: null, phaseCount, isDone: true };
	const result = await args.saved.queries
		.by_parent_scope_archive_tree((q) =>
			files_index_range_apply(q.eq("parentScopeNodeId", args.frame.scopeNodeId).eq("archiveOperationId", null), bounds),
		)
		.paginate({ cursor: null, numItems: args.numItems });
	const nodes = await args.saved.read_nodes(result.page);
	const page: Array<{ node: Doc<"files_nodes">; status: BoundaryStatus }> = [];
	for (const node of nodes) page.push({ node, status: await files_tree_walk_boundary_status(node, args.can) });
	const last = nodes.at(-1);
	return {
		page,
		frontier: last ? files_tree_walk_key(last) : null,
		phaseCount,
		isDone: result.isDone,
	};
}

/**
 * The walk's full key of a node: `treePath`, then creation time and id, like `files_saved_list_page`.
 */
export function files_tree_walk_key(node: Pick<Doc<"files_nodes">, "treePath" | "_creationTime" | "_id">): Key {
	return [node.treePath, node._creationTime, node._id];
}

/**
 * The frames from the start frame's child down to `top`, following `parentScopeNodeId` up to the
 * start's area. Each frame root must still be a readable boundary inside the start, at the same
 * path. Null when the chain changed.
 */
export async function files_tree_walk_db_resolve_stack(args: {
	get_node: (nodeId: Id<"files_nodes">) => Promise<Doc<"files_nodes"> | null>;
	can: (node: Doc<"files_nodes">) => Promise<boolean>;
	start: { scopeNodeId: Id<"files_nodes"> | null; treePath: string };
	top: { nodeId: Id<"files_nodes">; treePath: string };
}) {
	const frames: Array<{ nodeId: Id<"files_nodes">; treePath: string; kind: "folder" | "file"; key: Key }> = [];
	let nodeId = args.top.nodeId;
	for (let level = 0; level < WALK_MAX_DEPTH; level++) {
		const node = await args.get_node(nodeId);
		const child = frames[0];
		if (
			!node ||
			node.archiveOperationId !== null ||
			node.parentScopeNodeId === undefined ||
			node.treePath === args.start.treePath ||
			!node.treePath.startsWith(args.start.treePath) ||
			(child
				? node.kind !== "folder" || !child.treePath.startsWith(node.treePath)
				: node.treePath !== args.top.treePath)
		)
			return null;
		const status = await files_tree_walk_boundary_status(node, args.can);
		if (status !== "readable" && status !== "former_readable") return null;
		frames.unshift({ nodeId: node._id, treePath: node.treePath, kind: node.kind, key: files_tree_walk_key(node) });
		if (node.parentScopeNodeId === args.start.scopeNodeId) return frames;
		if (node.parentScopeNodeId === null) return null;
		nodeId = node.parentScopeNodeId;
	}
	return null;
}

export const files_tree_walk_stack_validator = v.union(
	v.array(
		v.object({
			nodeId: v.id("files_nodes"),
			treePath: v.string(),
			kind: v.union(v.literal("folder"), v.literal("file")),
			key: v.array(v.any()),
		}),
	),
	v.null(),
);

/**
 * One page of the walk. `rows` and `boundaries` are the streams of one frame (one per saved source
 * and filter); the walk merges them by the full key. Throws an invalid cursor when a frame above
 * the cursor changed.
 *
 * Returns the listed entries in walk order. An entry is a row, a locked boundary row, or only a
 * "Permission denied" path (a locked folder that does not match the filter). Each entry has the
 * cursor right after it. `frames` are the frames above the end cursor's top frame, so a caller that
 * runs the next page in the same action can pass them back instead of reading them again.
 */
export async function files_tree_walk_page<Row>(args: {
	start: { scopeNodeId: Id<"files_nodes"> | null; treePath: string; kind: "folder" | "file"; withRoot: boolean };
	cursor: files_tree_walk_Cursor | null;
	numItems: number;
	maxCalls?: number;
	rows: Array<StreamCall<Row>>;
	boundaries: Array<StreamCall<files_tree_walk_Boundary<Row>>>;
	resolve_stack: (top: {
		nodeId: Id<"files_nodes">;
		treePath: string;
	}) => Promise<Infer<typeof files_tree_walk_stack_validator>>;
}) {
	const { start, numItems } = args;
	const maxCalls = args.maxCalls ?? files_tree_walk_MAX_CALLS;
	const stack: Frame[] = [{ scopeNodeId: start.scopeNodeId, treePath: start.treePath, kind: start.kind, root: null }];
	let lower: Bound = { key: [start.treePath], inclusive: start.withRoot };
	if (args.cursor) {
		if (args.cursor.start !== start.treePath) throw invalid_cursor();
		if (args.cursor.top) {
			const frames = await args.resolve_stack({
				nodeId: args.cursor.top.nodeId as Id<"files_nodes">,
				treePath: args.cursor.top.treePath,
			});
			if (!frames) throw invalid_cursor();
			for (const frame of frames)
				stack.push({
					scopeNodeId: frame.nodeId,
					treePath: frame.treePath,
					kind: frame.kind,
					root: { nodeId: frame.nodeId, key: frame.key },
				});
		}
		lower = args.cursor.after;
	}

	const cursor_at = (after: Bound): files_tree_walk_Cursor => {
		const top = stack.at(-1)!;
		return { start: start.treePath, top: top.root && { nodeId: top.root.nodeId, treePath: top.treePath }, after };
	};
	const entries: Array<{ key: Key; row: Row | null; denied: string | null; cursor: files_tree_walk_Cursor }> = [];
	const seen = new Set<string>();
	let listed = 0;
	let calls = 0;
	let done = false;

	walk: while (listed < numItems && calls < maxCalls) {
		const frame = stack.at(-1)!;
		type Item = { key: Key; row?: Row; boundary?: files_tree_walk_Boundary<Row> };
		const batches: Array<{ items: Item[]; frontier: Key | null; done: boolean }> = [];
		const read = async <T>(
			stream: StreamCall<T>,
			rank: number,
			numItems: number,
			wrap: (value: T) => Omit<Item, "key">,
		) => {
			for (let phase = 0; ; phase++) {
				const { scopeNodeId, treePath, kind } = frame;
				const page = await stream({ scopeNodeId, treePath, kind, lower: native_lower(lower, rank), phase }, numItems);
				calls++;
				const streamDone = page.isDone && phase + 1 >= page.phaseCount;
				if (page.frontier || streamDone) {
					batches.push({
						items: page.items.map((item) => ({ key: walk_key(item.key, rank), ...wrap(item.value) })),
						frontier: page.frontier && walk_key(page.frontier, rank),
						done: streamDone,
					});
					return;
				}
			}
		};
		for (const stream of args.rows)
			await read(stream, ROW, Math.min(WALK_ROW_PAGE, numItems - listed), (row) => ({ row }));
		for (const stream of args.boundaries)
			await read(stream, BOUNDARY, WALK_BOUNDARY_PAGE, (boundary) => ({ boundary }));

		// Rows up to the smallest frontier of an open stream are decided in every stream.
		const frontiers = batches.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []));
		frontiers.sort(compareValues);
		const windowEnd = frontiers[0] ?? null;
		const items = batches
			.flatMap((batch) => batch.items)
			.filter((item) => windowEnd === null || compareValues(item.key, windowEnd) <= 0)
			.sort((a, b) => compareValues(a.key, b.key));

		let skipBelow: Key | null = null;
		for (const item of items) {
			if (skipBelow && compareValues(item.key, skipBelow) < 0) continue;
			if (listed >= numItems) break walk;
			const boundary = item.boundary;
			if (!boundary) {
				lower = { key: item.key, inclusive: false };
				// Two calls read different snapshots, so a row can come twice.
				if (!seen.has(String(item.key[3]))) {
					seen.add(String(item.key[3]));
					entries.push({ key: item.key, row: item.row!, denied: null, cursor: cursor_at(lower) });
					listed++;
				}
				continue;
			}
			if (boundary.status === "readable" || boundary.status === "former_readable") {
				// The frame starts with the root's own row, in its own area. A former root's row is in this
				// area: it comes after the frame, since this frame goes on after the boundary.
				stack.push({
					scopeNodeId: boundary.node._id,
					treePath: boundary.node.treePath,
					kind: boundary.node.kind,
					root: { nodeId: boundary.node._id, key: native_key(item.key) },
				});
				lower = { key: [boundary.node.treePath], inclusive: true };
				continue walk;
			}
			if (boundary.status === "former_locked") {
				// Its old area stays closed. Its own row is in this area.
				lower = { key: item.key, inclusive: false };
				continue;
			}
			// Locked: list it and read nothing under it. Boundaries and rows inside it are job lag.
			skipBelow = [frame_end(boundary.node)];
			lower = { key: skipBelow, inclusive: true };
			if ((boundary.row || boundary.node.kind === "folder") && !seen.has(boundary.node._id)) {
				seen.add(boundary.node._id);
				entries.push({
					key: item.key,
					row: boundary.row,
					denied: boundary.node.kind === "folder" ? boundary.path : null,
					cursor: cursor_at(lower),
				});
				if (boundary.row) listed++;
			}
		}
		if (windowEnd !== null) {
			if (!skipBelow || compareValues(windowEnd, skipBelow) >= 0)
				lower = { key: windowEnd, inclusive: windowEnd.length === 1 };
			continue;
		}
		// Every stream of the frame is done: go on in the parent after this frame's root.
		const popped = stack.pop()!;
		if (!popped.root) {
			done = true;
			break;
		}
		lower = { key: walk_key(popped.root.key, BOUNDARY), inclusive: false };
	}
	const frames = stack.flatMap((frame) =>
		frame.root ? [{ nodeId: frame.root.nodeId, treePath: frame.treePath, kind: frame.kind, key: frame.root.key }] : [],
	);
	return { entries, cursor: done ? null : cursor_at(lower), frames, calls };
}
