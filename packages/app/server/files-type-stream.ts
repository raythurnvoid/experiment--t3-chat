import { compareValues, v, type Infer } from "convex/values";
import { internal } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { access_control_create_file_checker } from "../convex/access_control.ts";
import { files_parse_content_type_prefix } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_index_range_apply, files_index_range_phases } from "./files-index-range.ts";
import {
	files_saved_placement_db_get_node,
	type files_saved_placement_FixedView,
	type files_saved_placement_View,
} from "./files-saved-placement.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

export const files_type_stream_cursor_validator = v.object({
	key: v.array(v.union(v.string(), v.number())),
	inclusive: v.boolean(),
});

type Cursor = Infer<typeof files_type_stream_cursor_validator>;
type Item = { treePath: string; createdAt: number; nodeId: Doc<"files_nodes">["_id"]; kind: "file" | "folder" };

function key(item: Item) {
	return [item.treePath, item.createdAt, item.nodeId];
}

/**
 * One native range per internal query keeps MIME reads byte bounded.
 */
export async function files_type_stream_db_saved_page(
	db: QueryCtx["db"],
	args: {
		query: Doc<"files_type_queries">;
		tag?: files_saved_placement_FixedView;
		restricted: boolean;
		lower: Cursor;
		upper: string;
		phase: number;
		limit: number;
	},
) {
	const { query, tag, restricted, lower } = args;
	const type = files_parse_content_type_prefix(query.contentType);
	if (!type) throw should_never_happen("File type query has an invalid type", { queryId: query._id });
	const phases = files_index_range_phases({
		fields: ["treePath", ...(tag ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"])],
		order: "asc",
		start: lower.key,
		startInclusive: lower.inclusive,
		end: [args.upper],
		endInclusive: false,
	});
	const bounds = phases[args.phase];
	if (!bounds) return { items: [], done: true, phaseDone: true };
	const filters: typeof bounds = [
		["eq", restricted ? "isRestrictedScopeRoot" : type.field, restricted ? true : type.value],
		...bounds,
	];
	const pagination = { cursor: null, numItems: args.limit, maximumBytesRead: 512 * 1024 };
	const native = tag
		? await db
				.query("files_saved_places")
				.withIndex(
					restricted
						? "by_view_archive_restricted_tree"
						: type.field === "contentTypeFamily"
							? "by_view_archive_contentTypeFamily_tree"
							: "by_view_archive_contentTypeEssence_tree",
					(q) =>
						files_index_range_apply(
							q.eq("cohortId", tag.cohortId).eq("view", tag.view).eq("archiveOperationId", null),
							filters,
						),
				)
				.paginate(pagination)
		: await db
				.query("files_nodes")
				.withIndex(
					restricted
						? "by_org_ws_archive_restricted_tree"
						: type.field === "contentTypeFamily"
							? "by_org_ws_archive_contentTypeFamily_tree"
							: "by_org_ws_archive_contentTypeEssence_tree",
					(q) =>
						files_index_range_apply(
							q
								.eq("organizationId", query.organizationId)
								.eq("workspaceId", query.workspaceId)
								.eq("moveCohortId", undefined)
								.eq("archiveOperationId", null),
							filters,
						),
				)
				.paginate(pagination);
	const items: Item[] = native.page.map((node) => ({
		treePath: node.treePath,
		createdAt: "nodeId" in node ? node.nodeCreationTime : node._creationTime,
		nodeId: "nodeId" in node ? node.nodeId : node._id,
		kind: node.kind,
	}));
	return { items, done: native.isDone && args.phase + 1 >= phases.length, phaseDone: native.isDone };
}

/**
 * Read MIME matches and locked boundaries together. Each locked folder uses one buffer slot.
 */
export async function files_type_stream_db_walk(
	ctx: MutationCtx,
	args: {
		query: Doc<"files_type_queries">;
		stream: Doc<"files_type_query_streams">;
		view: files_saved_placement_View;
		cursor: Cursor | null;
	},
) {
	const { query, stream, view } = args;
	let root = query.root?.kind === "saved" ? await files_saved_placement_db_get_node(ctx.db, query.root.id) : null;
	if (root?.treePath !== stream.savedPrefix && stream.moveTargetId !== null)
		root = await files_saved_placement_db_get_node(ctx.db, stream.moveTargetId);
	// A private root, or the old saved path of a draft move, has no saved subtree here.
	if (stream.savedPrefix !== "/" && (root?.kind !== "folder" || root.treePath !== stream.savedPrefix))
		return { items: [], cursor: null, lowerPath: stream.ownerPrefix };
	const type = files_parse_content_type_prefix(query.contentType);
	if (!type) throw should_never_happen("File type query has an invalid type", { queryId: query._id });
	const sources: Array<files_saved_placement_FixedView | undefined> = [undefined];
	if (view.cohortId !== null && view.view !== null) sources.push({ cohortId: view.cohortId, view: view.view });
	let lower = args.cursor ?? { key: [stream.savedPrefix], inclusive: false };
	const end = path_tree_prefix_upper_bound(stream.savedPrefix);
	const read = async (
		tag: files_saved_placement_FixedView | undefined,
		restricted: boolean,
		end: string,
		limit: number,
	) => {
		for (let phase = 0; ; phase++) {
			const page: Awaited<ReturnType<typeof files_type_stream_db_saved_page>> = await ctx.runQuery(
				internal.files_type_queries.saved_native_page,
				{
					queryId: query._id,
					tag,
					restricted,
					lower,
					upper: end,
					phase,
					limit,
				},
			);
			if (page.items.length > 0 || page.done) return page;
			// With no filter, a byte split includes its last read doc.
			if (!page.phaseDone) throw should_never_happen("File type page did not advance", { queryId: query._id });
		}
	};
	// A scope job can leave children in both areas. Path ranges include both, but stop before
	// the next real restricted root so no denied subtree is read to find its next sibling.
	const boundaries = (await Promise.all(sources.map((source) => read(source, true, end, 1)))).flatMap(
		(page) => page.items,
	);
	const boundary = boundaries.sort((a, b) => compareValues(key(a), key(b)))[0];
	const batches = await Promise.all(sources.map((source) => read(source, false, boundary?.treePath ?? end, 16)));
	// Both sources share this mutation's snapshot. Stop at their common read frontier;
	// a byte-limited page may end before the other source's last doc.
	const frontier = batches
		.filter((page) => !page.done)
		.map((page) => page.items.at(-1)!)
		.sort((a, b) => compareValues(key(a), key(b)))[0];
	const nodes = batches.flatMap((page) => page.items).sort((a, b) => compareValues(key(a), key(b)));
	const seen = new Set<string>();
	const selected = nodes
		.filter((node) => {
			if ((frontier && compareValues(key(node), key(frontier)) > 0) || seen.has(node.nodeId)) return false;
			seen.add(node.nodeId);
			return true;
		})
		.slice(0, 16);
	let done = selected.length === nodes.length && batches.every((page) => page.done) && !boundary;
	if (selected.length > 0) lower = { key: key(selected.at(-1)!), inclusive: false };
	else if (boundary) {
		const node = await files_saved_placement_db_get_node(ctx.db, boundary.nodeId);
		if (!node) throw should_never_happen("File type boundary has no saved node", { queryId: query._id });
		const checker = access_control_create_file_checker(ctx, {
			organizationId: query.organizationId,
			workspaceId: query.workspaceId,
			subject: { kind: "user", userId: query.userId, plugin: null },
		});
		const readable = await checker.can(node, "content.read");
		const skip = !readable && node.kind === "folder";
		lower = { key: skip ? [path_tree_prefix_upper_bound(node.treePath)] : key(boundary), inclusive: skip };
		if (skip || (readable && node.kind === "file" && node[type.field] === type.value)) selected.push(boundary);
		done = false;
	}
	return {
		items: selected.map((node) => ({
			key: {
				path: stream.ownerPrefix + node.treePath.slice(stream.savedPrefix.length),
				createdAt: node.createdAt,
				target: { kind: "saved" as const, id: node.nodeId },
			},
			kind: node.kind,
		})),
		cursor: done ? null : lower,
		lowerPath: stream.ownerPrefix + String(lower.key[0]).slice(stream.savedPrefix.length),
	};
}

/**
 * Read one native pending MIME/path page. Access checks run after this indexed selection.
 * The caller keeps both selected sources until it can advance their common full key.
 */
export async function files_type_stream_db_page(
	db: QueryCtx["db"],
	args: {
		query: Doc<"files_type_queries">;
		stream: Doc<"files_type_query_streams">;
		tag?: files_saved_placement_FixedView;
	},
) {
	const { query, stream, tag } = args;
	const type = files_parse_content_type_prefix(query.contentType);
	if (!type) throw should_never_happen("File type query has an invalid type", { queryId: query._id });
	const prefix = stream.ownerPrefix;
	const lastKey = stream.lastKey;
	const phases = files_index_range_phases({
		fields: ["ownerTreePath", "nodeCreationTime", "target.kind", "target.id"],
		order: "asc",
		start: lastKey ? [lastKey.path, lastKey.createdAt, lastKey.target.kind, lastKey.target.id] : [prefix],
		end: [path_tree_prefix_upper_bound(prefix)],
		startInclusive: lastKey === null,
		endInclusive: false,
	});
	const bounds = phases[stream.readPhase];
	if (!bounds) return { items: [], frontier: null, done: true, nextPhase: stream.readPhase, cursor: null };
	const pagination = { cursor: stream.readCursor, numItems: 16, maximumBytesRead: 512 * 1024 };
	const organizationId = db.normalizeId("organizations", query.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", query.workspaceId);
	if (!organizationId || !workspaceId || !query.overlay)
		throw should_never_happen("Pending type stream has no owner scope", { queryId: query._id });
	const filters: typeof bounds = stream.kind === "content" ? [["eq", type.field, type.value], ...bounds] : bounds;
	const native = await db
		.query("files_pending_type_entries")
		.withIndex(
			stream.kind === "move"
				? "by_org_ws_user_visible_source_tree"
				: type.field === "contentTypeFamily"
					? "by_org_ws_user_visible_source_family_tree"
					: "by_org_ws_user_visible_source_type_tree",
			(q) =>
				files_index_range_apply(
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("userId", query.userId)
						.eq("moveView.cohortId", tag?.cohortId)
						.eq("moveView.view", tag?.view)
						.eq("isVisible", true)
						.eq("sourceKind", stream.kind === "move" ? "move" : "content"),
					filters,
				),
		)
		.paginate(pagination);
	const items = native.page.map((entry) => ({
		key: { path: entry.ownerTreePath, createdAt: entry.nodeCreationTime, target: entry.target },
		kind: entry.kind,
	}));
	return {
		items,
		frontier: items.at(-1)?.key ?? null,
		done: native.isDone && stream.readPhase + 1 >= phases.length,
		nextPhase: native.isDone ? stream.readPhase + 1 : stream.readPhase,
		cursor: native.isDone ? null : native.continueCursor,
	};
}
