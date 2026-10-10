// The metadata catalog (`files_metadata_catalog`): the saved metadata keys and short string values of
// one workspace, counted, so the search box and the folder Columns menu page their suggestions with
// one index range at any workspace size. Convex has no "distinct values" or prefix search, so this
// table does it.
//
// Families:
// - `key`: one row per field path. `count` is its field docs, `kindCounts` its value docs by kind.
// - `value`: one row per field path and string value of at most 1,024 encoded bytes.
// - `parent`: one row per folder (or `"root"`) and field path of its children's field docs.
// Only saved, active (not archived) docs of real workspaces count, and only fields the search grammar
// can name in at most 160 characters. Restriction is not part of any row, so a restrict writes
// nothing here. A doc of a Move cohort counts in the rows of its own view (`moveView`), like share
// rows (`server/files-share-rows.ts`), and readers merge the normal rows with the visible view's rows.
//
// Accepted leak: any member sees every row of the workspace, also keys and values of files they
// cannot open. Search results and opening a file stay access-checked. A search engine must fix this:
// it counts keys and values over only the files the caller can read. Then delete the three catalog
// tables, this module, the overlay hook, the compactor, its cron and the data deletion pass.
//
// Writes: the overlay wrapper (`server/files-pending-overlay.ts`) adds each metadata doc write to a
// change map, and every flush inserts one delta per changed row and clears the map. Savers never
// write a row or patch a shared doc, so parallel saves of the same key do not conflict. The compactor
// (`compact_metadata_catalog` in `convex/files_pending_overlay.ts`) applies deltas older than
// `COMPACT_CUTOFF_MS` in batches, so a new key shows after about 5 to 15 seconds.
//
// Repair: `rebuild_metadata_catalog` counts a workspace again from its saved docs, in a quiet window.
// Its `check` mode counts into shadow families (`check_*`), and `check_metadata_catalog` compares
// them with the rows.
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import type { WithoutSystemFields } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_metadata_catalog_lower } from "../shared/files-metadata.ts";
import { files_search_query_field_path_is_valid } from "../shared/files-search-query.ts";

type Row = WithoutSystemFields<Doc<"files_metadata_catalog">>;
type KindCounts = NonNullable<Row["kindCounts"]>;

/**
 * Pending changes to catalog rows, by row: the same shape as a delta.
 */
export type files_metadata_catalog_Changes = Map<string, Row>;

/**
 * The metadata doc fields a contribution reads. A patch of none of them changes no row.
 */
export const files_metadata_catalog_SOURCE_FIELDS = [
	"organizationId",
	"workspaceId",
	"sourceKind",
	"moveView",
	"archiveOperationId",
	"parentId",
	"docKind",
	"fieldPath",
	"valueKind",
	"stringValue",
] as const;

type Source = Partial<
	Pick<
		Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }>,
		(typeof files_metadata_catalog_SOURCE_FIELDS)[number]
	>
>;

const KINDS = ["string", "number", "boolean", "maybe_date"] as const;

/**
 * Longest string value with a value row, in encoded bytes. Index keys over 2,500 bytes share a
 * buffered prefix group in Convex, so a page of longer values is not a real read bound.
 */
const VALUE_MAX_BYTES = 1024;

/**
 * The compactor applies only deltas older than this, so one run sums the deltas of many saves.
 */
const COMPACT_CUTOFF_MS = 5000;

/**
 * Deltas per compactor run: about 1,000 reads and writes, far below the Convex limits.
 */
const COMPACT_BATCH_SIZE = 500;

/**
 * Rows or deltas one rebuild job deletes while it clears.
 */
const CLEAR_BATCH_SIZE = 100;

/**
 * Source docs per seed page. `SEED_PAGE_BYTES` ends a page early, because one source doc can
 * approach 1 MiB.
 */
const SEED_PAGE_SIZE = 100;
const SEED_PAGE_BYTES = 1024 * 1024;

/**
 * Rows per check page. Each row costs one exact read of its pair.
 */
const CHECK_PAGE_SIZE = 100;

/**
 * Each family with its shadow, then each shadow with its family. A rebuild in `check` mode writes
 * the shadows.
 */
const CHECK_PAIRS = [
	["key", "check_key"],
	["value", "check_value"],
	["parent", "check_parent"],
	["check_key", "key"],
	["check_value", "value"],
	["check_parent", "parent"],
] as const;

/**
 * True when a string value gets a value row: its encoded payload is at most 1,024 bytes. Convex's
 * index encoding writes each U+0000 as two bytes, so it counts one extra byte for each.
 */
export function files_metadata_catalog_value_is_short(value: string) {
	// Every UTF-16 unit is at least one UTF-8 byte, so a longer string never fits.
	if (value.length > VALUE_MAX_BYTES) return false;
	return new TextEncoder().encode(value).length + value.split("\0").length - 1 <= VALUE_MAX_BYTES;
}

function row_key(row: Row) {
	return JSON.stringify([
		row.organizationId,
		row.workspaceId,
		row.moveView?.cohortId ?? null,
		row.moveView?.view ?? null,
		row.family,
		row.parentId ?? null,
		row.fieldPath,
		row.stringValue ?? null,
	]);
}

/**
 * Add one row change to a sum of changes. A key row sums its kinds too.
 */
function add_change(changes: files_metadata_catalog_Changes, change: Row) {
	const key = row_key(change);
	const sum = changes.get(key);
	if (!sum) {
		changes.set(key, { ...change, kindCounts: change.kindCounts && { ...change.kindCounts } });
		return;
	}
	sum.count += change.count;
	if (sum.kindCounts) for (const kind of KINDS) sum.kindCounts[kind] += change.kindCounts![kind];
}

/**
 * Add what one metadata doc counts, times `sign`, to the map.
 */
function add_doc(changes: files_metadata_catalog_Changes, doc: Source | null, sign: 1 | -1) {
	if (!doc || doc.sourceKind !== "committed" || doc.archiveOperationId !== undefined) return;
	if (!doc.fieldPath || !files_search_query_field_path_is_valid(doc.fieldPath)) return;
	const base = {
		moveView: doc.moveView,
		organizationId: doc.organizationId as Id<"organizations">,
		workspaceId: doc.workspaceId as Id<"organizations_workspaces">,
		fieldPathLower: files_metadata_catalog_lower(doc.fieldPath),
		fieldPath: doc.fieldPath,
	};
	const kindCounts: KindCounts = { string: 0, number: 0, boolean: 0, maybe_date: 0 };
	if (doc.docKind === "field") {
		add_change(changes, { ...base, family: "key", count: sign, kindCounts });
		if (doc.parentId !== undefined)
			add_change(changes, { ...base, family: "parent", parentId: doc.parentId, count: sign });
		return;
	}
	if (!doc.valueKind) return;
	// `count` counts field docs, so a value doc adds to its key's kinds only.
	add_change(changes, { ...base, family: "key", count: 0, kindCounts: { ...kindCounts, [doc.valueKind]: sign } });
	if (doc.valueKind === "string" && doc.stringValue !== undefined && files_metadata_catalog_value_is_short(doc.stringValue))
		add_change(changes, { ...base, family: "value", stringValue: doc.stringValue, count: sign });
}

/**
 * Add the change of one metadata doc write: `old` is the doc before it (null for an insert) and
 * `next` the doc after it (null for a delete). Pending docs change nothing.
 */
export function files_metadata_catalog_add_write(
	changes: files_metadata_catalog_Changes,
	old: Source | null,
	next: Source | null,
) {
	add_doc(changes, old, -1);
	add_doc(changes, next, 1);
}

function is_zero(change: Row) {
	return change.count === 0 && KINDS.every((kind) => (change.kindCounts?.[kind] ?? 0) === 0);
}

/**
 * Insert one delta per changed row, then clear the map. A workspace with no marker gets one and a
 * compactor run. The flush calls it at its end, every time, so a walk that flushes before each
 * child never inserts a change twice.
 *
 * Savers only insert deltas and read the marker, so parallel saves do not conflict. When the
 * compactor deletes the marker while a saver reads it, one of them retries, and the saver then
 * inserts a new marker.
 */
export async function files_metadata_catalog_db_insert_deltas(
	ctx: MutationCtx,
	changes: files_metadata_catalog_Changes,
) {
	const scopes = new Map<string, Pick<Row, "organizationId" | "workspaceId">>();
	for (const change of changes.values()) {
		if (is_zero(change)) continue;
		// Global and plugin volume workspaces have no catalog.
		const organizationId = ctx.db.normalizeId("organizations", change.organizationId);
		const workspaceId = ctx.db.normalizeId("organizations_workspaces", change.workspaceId);
		if (!organizationId || !workspaceId) continue;
		await ctx.db.insert("files_metadata_catalog_deltas", change);
		scopes.set(`${organizationId}:${workspaceId}`, { organizationId, workspaceId });
	}
	changes.clear();
	for (const scope of scopes.values()) {
		const marker = await ctx.db
			.query("files_metadata_catalog_compactors")
			.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
			.first();
		if (marker) continue;
		const markerId = await ctx.db.insert("files_metadata_catalog_compactors", { ...scope, phase: "draining" });
		await ctx.scheduler.runAfter(COMPACT_CUTOFF_MS, internal.files_pending_overlay.compact_metadata_catalog, {
			markerId,
		});
	}
}

/**
 * The stored row of one row key, or null.
 */
function db_get_row(ctx: QueryCtx, row: Row) {
	return ctx.db
		.query("files_metadata_catalog")
		.withIndex("by_org_ws_family_parent_lower_field_value", (q) =>
			q
				.eq("organizationId", row.organizationId)
				.eq("workspaceId", row.workspaceId)
				.eq("moveView.cohortId", row.moveView?.cohortId)
				.eq("moveView.view", row.moveView?.view)
				.eq("family", row.family)
				.eq("parentId", row.parentId)
				.eq("fieldPathLower", row.fieldPathLower)
				.eq("fieldPath", row.fieldPath)
				.eq("stringValue", row.stringValue),
		)
		.first();
}

/**
 * One compactor run: apply up to `COMPACT_BATCH_SIZE` old deltas of the marker's workspace to their
 * rows, delete them, then schedule the next run or end the chain. A missing marker ends the chain:
 * a purge or a rebuild deleted it.
 *
 * Drift (a count below 0) never throws: it clamps to 0 and logs one line per run. A throw would stop
 * the chain, and with it every later key. A rebuild in a quiet window fixes drift.
 */
export async function files_metadata_catalog_db_compact(
	ctx: MutationCtx,
	args: { markerId: Id<"files_metadata_catalog_compactors"> },
) {
	const marker = await ctx.db.get("files_metadata_catalog_compactors", args.markerId);
	if (!marker || marker.phase === "clearing") return;
	const scope = { organizationId: marker.organizationId, workspaceId: marker.workspaceId };

	// A background drain no user waits on: every delta read is applied and deleted. Convex sets a
	// delta's creation time when its saver's transaction starts, so a slow saver can still commit an
	// older delta into this range later; this run then conflicts and Convex runs it again.
	const deltas = await ctx.db
		.query("files_metadata_catalog_deltas")
		.withIndex("by_org_ws", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.lt("_creationTime", Date.now() - COMPACT_CUTOFF_MS),
		)
		.take(COMPACT_BATCH_SIZE);
	const sums: files_metadata_catalog_Changes = new Map();
	for (const { _id, _creationTime, ...delta } of deltas) add_change(sums, delta);

	let driftRows = 0;
	let firstDrift: Row | null = null;
	for (const change of sums.values()) {
		if (is_zero(change)) continue;
		const row = await db_get_row(ctx, change);
		const count = (row?.count ?? 0) + change.count;
		let drift = count < 0;
		const kindCounts = change.kindCounts && { ...change.kindCounts };
		if (kindCounts)
			for (const kind of KINDS) {
				kindCounts[kind] += row?.kindCounts?.[kind] ?? 0;
				// A key with no field doc left has no value doc left either.
				if (kindCounts[kind] < 0 || (count <= 0 && kindCounts[kind] > 0)) drift = true;
				kindCounts[kind] = Math.max(0, kindCounts[kind]);
			}
		if (drift) {
			driftRows++;
			firstDrift ??= change;
		}
		if (count <= 0) {
			if (row) await ctx.db.delete("files_metadata_catalog", row._id);
		} else if (!row) await ctx.db.insert("files_metadata_catalog", { ...change, count, kindCounts });
		else await ctx.db.patch("files_metadata_catalog", row._id, { count, kindCounts });
	}
	for (const delta of deltas) await ctx.db.delete("files_metadata_catalog_deltas", delta._id);
	// Never log a value, a row or a delta: they can come from files the log reader cannot open.
	if (firstDrift)
		console.error("files_metadata_catalog drift", {
			workspaceId: scope.workspaceId,
			family: firstDrift.family,
			fieldPath: firstDrift.fieldPath,
			parentId: firstDrift.parentId,
			driftRows,
		});

	// Read young deltas too, so a delta inserted after the read above always gets a run.
	const next = await ctx.db
		.query("files_metadata_catalog_deltas")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.first();
	// A seeding rebuild keeps its marker and chain until its last page.
	if (next || marker.phase === "seeding")
		await ctx.scheduler.runAfter(
			// The read above takes a delta only once it is more than the cutoff old.
			next ? Math.max(0, next._creationTime + COMPACT_CUTOFF_MS + 1 - Date.now()) : COMPACT_CUTOFF_MS,
			internal.files_pending_overlay.compact_metadata_catalog,
			args,
		);
	else await ctx.db.delete("files_metadata_catalog_compactors", marker._id);
}

type RebuildMode = "catalog" | "check" | "clear_check";

/**
 * Start a rebuild of one workspace's catalog from its saved metadata docs. Modes:
 * - `catalog`: delete every delta and row, then count again. It fixes drift.
 * - `check`: count again into the shadow families, for `files_metadata_catalog_db_check`.
 * - `clear_check`: delete the shadow families after a check.
 *
 * Run it only while every source writer is quiet, also scheduled jobs, and keep them quiet until the
 * check ends: the rebuild does not fence writes. A new marker replaces the old one, so the jobs of an
 * older rebuild and its compactor stop.
 */
export async function files_metadata_catalog_db_rebuild(
	ctx: MutationCtx,
	args: Pick<Row, "organizationId" | "workspaceId"> & { mode: RebuildMode },
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.unique();
	// With no Move cohort every source doc is normal, so the rebuild writes no tagged row.
	if (slot?.cohortId) throw new Error("A Move runs in this workspace. Rebuild after it ends.");
	const marker = await ctx.db
		.query("files_metadata_catalog_compactors")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.first();
	if (args.mode === "check") {
		const delta = await ctx.db
			.query("files_metadata_catalog_deltas")
			.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
			.first();
		if (marker || delta) throw new Error("The catalog still has deltas. Check after its compactor ends.");
	}
	if (marker) await ctx.db.delete("files_metadata_catalog_compactors", marker._id);
	const markerId = await ctx.db.insert("files_metadata_catalog_compactors", { ...scope, phase: "clearing" });
	await ctx.scheduler.runAfter(0, internal.files_pending_overlay.rebuild_metadata_catalog_step, {
		markerId,
		mode: args.mode,
		cursor: null,
		fileNodeId: null,
		keys: "[]",
	});
	return markerId;
}

/**
 * One rebuild job. While the marker is `clearing` it deletes up to `CLEAR_BATCH_SIZE` deltas or rows.
 * While it is `seeding` it reads one page of saved metadata docs and inserts their deltas; the
 * compactor applies them meanwhile. The last page sets the marker to `draining`, so the compactor
 * deletes it when no delta is left. A missing marker, or one in another phase, ends the chain.
 *
 * A file's key deltas wait until its last doc is read (`keys` carries them to the next job): a key
 * delta with value kinds but no field count would make the compactor delete the row. Value and parent
 * deltas go out at once. A file has a few hundred key rows at most, of at most 160-character paths.
 */
export async function files_metadata_catalog_db_rebuild_step(
	ctx: MutationCtx,
	args: {
		markerId: Id<"files_metadata_catalog_compactors">;
		mode: RebuildMode;
		cursor: string | null;
		fileNodeId: Id<"files_nodes"> | null;
		keys: string;
	},
) {
	const marker = await ctx.db.get("files_metadata_catalog_compactors", args.markerId);
	if (!marker) return;
	const scope = { organizationId: marker.organizationId, workspaceId: marker.workspaceId };

	if (marker.phase === "clearing") {
		let deleted = 0;
		if (args.mode === "catalog") {
			const deltas = await ctx.db
				.query("files_metadata_catalog_deltas")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
				.take(CLEAR_BATCH_SIZE);
			for (const delta of deltas) await ctx.db.delete("files_metadata_catalog_deltas", delta._id);
			deleted += deltas.length;
		}
		// `catalog` deletes all rows, the other modes only the shadow families.
		const prefixes = args.mode === "catalog" ? [undefined] : CHECK_PAIRS.slice(0, 3).map(([, shadow]) => shadow);
		for (const family of prefixes) {
			if (deleted === CLEAR_BATCH_SIZE) break;
			const rows = await ctx.db
				.query("files_metadata_catalog")
				.withIndex("by_org_ws_family_parent_lower_field_value", (q) => {
					const workspace = q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId);
					return family
						? workspace.eq("moveView.cohortId", undefined).eq("moveView.view", undefined).eq("family", family)
						: workspace;
				})
				.take(CLEAR_BATCH_SIZE - deleted);
			for (const row of rows) await ctx.db.delete("files_metadata_catalog", row._id);
			deleted += rows.length;
		}
		if (deleted === CLEAR_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.files_pending_overlay.rebuild_metadata_catalog_step, args);
			return;
		}
		// The compactor also applies any delta that came in meanwhile, and deletes a `draining` marker.
		await ctx.db.patch("files_metadata_catalog_compactors", marker._id, {
			phase: args.mode === "clear_check" ? "draining" : "seeding",
		});
		await ctx.scheduler.runAfter(0, internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker._id });
		if (args.mode !== "clear_check")
			await ctx.scheduler.runAfter(0, internal.files_pending_overlay.rebuild_metadata_catalog_step, args);
		return;
	}
	if (marker.phase !== "seeding") return;

	// A background pass that reads every saved doc of the workspace once. No suggestion read may copy it.
	const page = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("sourceKind", "committed"),
		)
		.paginate({ cursor: args.cursor, numItems: SEED_PAGE_SIZE, maximumBytesRead: SEED_PAGE_BYTES });
	const changes: files_metadata_catalog_Changes = new Map();
	const keys: files_metadata_catalog_Changes = new Map((JSON.parse(args.keys) as Row[]).map((row) => [row_key(row), row]));
	let fileNodeId = args.fileNodeId;
	const emit_keys = () => {
		for (const row of keys.values()) add_change(changes, row);
		keys.clear();
	};
	for (const doc of page.page) {
		if (doc.sourceKind !== "committed") continue;
		if (doc.fileNodeId !== fileNodeId) {
			emit_keys();
			fileNodeId = doc.fileNodeId;
		}
		const contribution: files_metadata_catalog_Changes = new Map();
		files_metadata_catalog_add_write(contribution, null, doc);
		for (const row of contribution.values())
			add_change(
				row.family === "key" ? keys : changes,
				args.mode === "check" ? { ...row, family: `check_${row.family as "key" | "value" | "parent"}` } : row,
			);
	}
	if (page.isDone) emit_keys();
	await files_metadata_catalog_db_insert_deltas(ctx, changes);
	if (page.isDone) {
		await ctx.db.patch("files_metadata_catalog_compactors", marker._id, { phase: "draining" });
		return;
	}
	await ctx.scheduler.runAfter(0, internal.files_pending_overlay.rebuild_metadata_catalog_step, {
		...args,
		cursor: page.continueCursor,
		fileNodeId,
		keys: JSON.stringify([...keys.values()]),
	});
}

function same_counts(a: Row, b: Row) {
	return a.count === b.count && KINDS.every((kind) => (a.kindCounts?.[kind] ?? 0) === (b.kindCounts?.[kind] ?? 0));
}

function describe(row: Doc<"files_metadata_catalog">) {
	return `${row.family} row ${row._id} of ${row.fieldPath}${row.parentId ? ` in ${row.parentId}` : ""}`;
}

/**
 * Compare one page of a workspace's catalog with the shadow families of a `check` rebuild, and return
 * the differences. It pages each family and reads each row's shadow, then pages each shadow and reads
 * its row. Call again with the returned cursor until it is null. A difference names row ids, paths
 * and counts, never a value: the caller may not be allowed to open the file.
 *
 * It refuses while the workspace has a Move cohort, a compactor marker or a delta: then the catalog
 * is not settled, so the check proves nothing.
 */
export async function files_metadata_catalog_db_check(
	ctx: QueryCtx,
	args: Pick<Row, "organizationId" | "workspaceId"> & { cursor: string | null },
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.unique();
	const marker = await ctx.db
		.query("files_metadata_catalog_compactors")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.first();
	const delta = await ctx.db
		.query("files_metadata_catalog_deltas")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.first();
	if (slot?.cohortId || marker || delta)
		return { differences: ["the catalog is not settled: a Move, a compactor or a delta is still running"], cursor: null };
	// Rows of a Move view sort after normal rows. With no cohort, any such row is left over.
	const last = await ctx.db
		.query("files_metadata_catalog")
		.withIndex("by_org_ws_family_parent_lower_field_value", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
		)
		.order("desc")
		.first();
	const differences = last?.moveView ? [`${describe(last)} belongs to an ended Move`] : [];

	const position = args.cursor
		? (JSON.parse(args.cursor) as { pair: number; page: string | null })
		: { pair: 0, page: null };
	const [family, pair] = CHECK_PAIRS[position.pair]!;
	const rows = await ctx.db
		.query("files_metadata_catalog")
		.withIndex("by_org_ws_family_parent_lower_field_value", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined)
				.eq("family", family),
		)
		.paginate({ cursor: position.page, numItems: CHECK_PAGE_SIZE });
	for (const row of rows.page) {
		const other = await db_get_row(ctx, { ...row, family: pair });
		if (family.startsWith("check_")) {
			if (!other) differences.push(`missing row: ${describe(row)} has no ${pair} row`);
		} else if (!other) differences.push(`extra row: ${describe(row)} has no saved doc`);
		else if (!same_counts(row, other))
			differences.push(
				`${describe(row)}: count ${row.count} ${JSON.stringify(row.kindCounts ?? null)}, expected ${other.count} ${JSON.stringify(other.kindCounts ?? null)}`,
			);
	}

	const next = rows.isDone ? { pair: position.pair + 1, page: null } : { ...position, page: rows.continueCursor };
	return { differences, cursor: next.pair < CHECK_PAIRS.length ? JSON.stringify(next) : null };
}
