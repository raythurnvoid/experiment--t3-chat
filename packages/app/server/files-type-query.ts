import { compareValues } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { z } from "zod";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import type { files_type_queries_PageResult, files_type_queries_Request } from "../convex/files_type_queries.ts";
import { files_pending_review_facts_db_get_state } from "./files-pending-review-facts.ts";
import type { files_saved_placement_View } from "./files-saved-placement.ts";
import { files_type_stream_db_page } from "./files-type-stream.ts";
import { server_path_normalize } from "./server-utils.ts";

type Stream = Doc<"files_type_query_streams">;
type Key = NonNullable<Stream["lastKey"]>;

function compare_keys(a: Key, b: Key) {
	return compareValues(
		[a.path, a.createdAt, a.target.kind, a.target.id],
		[b.path, b.createdAt, b.target.kind, b.target.id],
	);
}

function lower_fields(key: Key) {
	return {
		lowerPath: key.path,
		lowerCreatedAt: key.createdAt,
		lowerTargetKind: key.target.kind,
		lowerTargetId: key.target.id,
	};
}

/**
 * Read work already registered by file writes. This read never starts maintenance.
 * Selected Move views publish only after their owner entries are ready.
 */
export async function files_type_query_db_get_readiness(
	db: QueryCtx["db"],
	scope: Pick<Doc<"files_pending_updates">, "organizationId" | "workspaceId">,
) {
	const state = await files_pending_review_facts_db_get_state(db, scope);
	return { state: (state?.pendingJobCount ?? 0) > 0 ? ("updating" as const) : ("ready" as const) };
}

export async function files_type_query_db_open_stream(
	db: MutationCtx["db"],
	args: Pick<Stream, "queryId" | "kind" | "moveTargetId" | "savedPrefix" | "ownerPrefix">,
) {
	const existing = await db
		.query("files_type_query_streams")
		.withIndex("by_query_kind_moveTarget", (q) =>
			q.eq("queryId", args.queryId).eq("kind", args.kind).eq("moveTargetId", args.moveTargetId),
		)
		.first();
	if (existing) return existing._id;
	return await db.insert("files_type_query_streams", {
		...args,
		lastKey: null,
		done: false,
		lowerPath: args.ownerPrefix,
		lowerCreatedAt: 0,
		lowerTargetKind: "",
		lowerTargetId: "",
		readSource: 0,
		readPhase: 0,
		readCursor: null,
		batches: [],
		buffer: [],
		windowEnd: null,
		windowDone: false,
	});
}

/**
 * Save a native page before yielding. Physical Move cleanup may move a candidate between sources.
 * Read in migration order, then keep only the range both sources have reached.
 */
export async function files_type_query_db_fill_stream(
	db: MutationCtx["db"],
	query: Doc<"files_type_queries">,
	stream: Stream,
	view: files_saved_placement_View,
) {
	const tags = [undefined, ...(view.cohortId && view.view ? [{ cohortId: view.cohortId, view: view.view }] : [])];
	if (view.migrationDirection === "to_normal") tags.reverse();
	const page = await files_type_stream_db_page(db, { query, stream, tag: tags[stream.readSource] });
	if (page.frontier === null && !page.done) {
		await db.patch("files_type_query_streams", stream._id, { readPhase: page.nextPhase, readCursor: page.cursor });
		return;
	}
	const batches = [...stream.batches, { items: page.items, frontier: page.frontier, done: page.done }];
	if (stream.readSource + 1 < tags.length) {
		await db.patch("files_type_query_streams", stream._id, {
			batches,
			readSource: stream.readSource + 1,
			readPhase: 0,
			readCursor: null,
		});
		return;
	}
	const frontiers = batches
		.flatMap((batch) => (!batch.done && batch.frontier ? [batch.frontier] : []))
		.sort(compare_keys);
	const windowEnd = frontiers[0] ?? null;
	const seen = new Set<string>();
	const buffer = batches
		.flatMap((batch) => batch.items)
		.filter((item) => windowEnd === null || compare_keys(item.key, windowEnd) <= 0)
		.sort((a, b) => compare_keys(a.key, b.key))
		.filter((item) => {
			const key = `${item.key.target.kind}:${item.key.target.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	const windowDone = batches.every((batch) => batch.done);
	await db.patch("files_type_query_streams", stream._id, {
		batches: [],
		readSource: 0,
		readPhase: 0,
		readCursor: null,
		buffer,
		windowEnd,
		windowDone,
		...(buffer[0]
			? lower_fields(buffer[0].key)
			: {
					lastKey: windowEnd ?? stream.lastKey,
					done: windowDone,
					...(windowEnd ? lower_fields(windowEnd) : {}),
				}),
	});
}

/**
 * Save candidate consumption with its output or child stream in the same mutation.
 */
export async function files_type_query_db_consume(db: MutationCtx["db"], stream: Stream) {
	const buffer = stream.buffer.slice(1);
	const lastKey = stream.windowEnd ?? stream.buffer.at(-1)?.key ?? stream.lastKey;
	await db.patch("files_type_query_streams", stream._id, {
		buffer,
		...(buffer[0]
			? lower_fields(buffer[0].key)
			: {
					lastKey,
					done: stream.windowDone,
					windowEnd: null,
					windowDone: false,
					...(lastKey ? lower_fields(lastKey) : {}),
				}),
	});
}

/**
 * Keep each resolver frame in its own doc; no array grows with the path graph.
 */
export function files_type_query_db_work(db: MutationCtx["db"], queryId: Id<"files_type_queries">, generation: number) {
	const get_doc = (key: string) =>
		db
			.query("files_type_query_work")
			.withIndex("by_query_key", (q) => q.eq("queryId", queryId).eq("key", `${generation}:${key}`))
			.first();
	return {
		async get(key: string) {
			return (await get_doc(key))?.value ?? null;
		},
		async set(key: string, value: string) {
			const existing = await get_doc(key);
			if (existing) await db.patch("files_type_query_work", existing._id, { value });
			else await db.insert("files_type_query_work", { queryId, key: `${generation}:${key}`, value });
		},
		async delete(key: string) {
			const existing = await get_doc(key);
			if (existing) await db.delete("files_type_query_work", existing._id);
		},
	};
}

/**
 * Delete children before the query. Retrying a partial cleanup is safe.
 */
export async function files_type_query_db_delete_batch(
	db: MutationCtx["db"],
	queryId: Id<"files_type_queries">,
	limit: number,
) {
	const query = await db.get("files_type_queries", queryId);
	if (!query) return 0;
	if (query.state !== "canceled") await db.patch("files_type_queries", queryId, { state: "canceled", lease: null });
	const streams = await db
		.query("files_type_query_streams")
		.withIndex("by_query", (q) => q.eq("queryId", queryId))
		.take(limit);
	if (streams.length) {
		for (const row of streams) await db.delete("files_type_query_streams", row._id);
		return streams.length;
	}
	const steps = await db
		.query("files_type_query_steps")
		.withIndex("by_query_step", (q) => q.eq("queryId", queryId))
		.take(limit);
	if (steps.length) {
		for (const row of steps) await db.delete("files_type_query_steps", row._id);
		return steps.length;
	}
	const work = await db
		.query("files_type_query_work")
		.withIndex("by_query_key", (q) => q.eq("queryId", queryId))
		.take(limit);
	if (work.length) {
		for (const row of work) await db.delete("files_type_query_work", row._id);
		return work.length;
	}
	await db.delete("files_type_queries", queryId);
	return 1;
}

const cursor_schema = z.object({ queryId: z.string(), step: z.number().int().nonnegative() });

export function files_type_query_request_matches(
	query: Doc<"files_type_queries">,
	request: files_type_queries_Request,
) {
	return (
		query.organizationId === request.organizationId &&
		query.workspaceId === request.workspaceId &&
		query.userId === request.userId &&
		query.pluginReviewRoot === request.pluginReviewRoot &&
		query.rootPath === server_path_normalize(request.rootPath) &&
		query.contentType === request.contentType.trim().toLowerCase() &&
		query.overlay === request.overlay &&
		query.limit === request.limit &&
		query.directoriesOnly === request.directoriesOnly &&
		compareValues(query.agentSource, request.agentSource ? { ...request.agentSource, run: null } : undefined) === 0
	);
}

export async function files_type_query_start(
	ctx: ActionCtx,
	request: files_type_queries_Request,
	cursor: string | null,
) {
	if (cursor !== null) {
		let decoded: unknown;
		try {
			decoded = JSON.parse(cursor);
		} catch {
			decoded = null;
		}
		const parsed = cursor_schema.safeParse(decoded);
		if (!parsed.success)
			return Result({ _nay: { message: "Invalid file search cursor. Rerun find without --cursor." } });
		const query = await ctx.runQuery(internal.files_type_queries.get, { queryId: parsed.data.queryId });
		if (!query || !files_type_query_request_matches(query, request))
			return Result({ _nay: { message: "The file search changed. Rerun find without --cursor." } });
		return Result({ _yay: { queryId: query._id, step: parsed.data.step } });
	}
	return await ctx.runMutation(internal.files_type_queries.begin, request);
}

/**
 * One call does bounded work. A short page retains every unfinished source position.
 */
export async function files_type_query_page(
	ctx: ActionCtx,
	request: files_type_queries_Request,
	cursor: string | null,
): Promise<files_type_queries_PageResult> {
	const started = await files_type_query_start(ctx, request, cursor);
	if (started._nay) return started;
	const position = started._yay;
	const token = crypto.randomUUID();
	try {
		for (let slice = 0; slice < 32; slice++) {
			const result: files_type_queries_PageResult = await ctx.runMutation(internal.files_type_queries.advance, {
				...request,
				...position,
				token,
				seal: slice === 31,
			});
			if (result._nay || result._yay.state === "page" || slice === 31) return result;
		}
		throw new Error("File search slice did not return");
	} finally {
		await ctx.runMutation(internal.files_type_queries.release, { queryId: position.queryId, token });
	}
}
