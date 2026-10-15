import type { Doc } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { files_parse_content_type_prefix } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_index_range_apply, files_index_range_phases } from "./files-index-range.ts";
import type { files_saved_placement_FixedView } from "./files-saved-placement.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

/**
 * Read one native MIME/path page. Access and pending checks run after this indexed selection.
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
	const saved = stream.kind === "saved";
	const prefix = saved ? stream.savedPrefix : stream.ownerPrefix;
	const lastKey = stream.lastKey;
	const lastPath =
		lastKey && saved ? stream.savedPrefix + lastKey.path.slice(stream.ownerPrefix.length) : lastKey?.path;
	const fields = saved
		? ["treePath", ...(tag ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"])]
		: ["ownerTreePath", "nodeCreationTime", "target.kind", "target.id"];
	const phases = files_index_range_phases({
		fields,
		order: "asc",
		start: lastKey
			? [lastPath!, lastKey.createdAt, ...(saved ? [] : [lastKey.target.kind]), lastKey.target.id]
			: [prefix],
		end: [path_tree_prefix_upper_bound(prefix)],
		startInclusive: lastKey === null,
		endInclusive: false,
	});
	const bounds = phases[stream.readPhase];
	if (!bounds) return { items: [], frontier: null, done: true, nextPhase: stream.readPhase, cursor: null };
	const pagination = { cursor: stream.readCursor, numItems: 16, maximumBytesRead: 512 * 1024 };
	if (saved) {
		const filters: typeof bounds = [["eq", type.field, type.value], ...bounds];
		const native = tag
			? await db
					.query("files_saved_places")
					.withIndex(
						type.field === "contentTypeFamily"
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
						type.field === "contentTypeFamily"
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
		const items = native.page.map((node) => ({
			key: {
				path: stream.ownerPrefix + node.treePath.slice(stream.savedPrefix.length),
				createdAt: "nodeId" in node ? node.nodeCreationTime : node._creationTime,
				target: { kind: "saved" as const, id: "nodeId" in node ? node.nodeId : node._id },
			},
			kind: node.kind,
		}));
		return {
			items,
			frontier: items.at(-1)?.key ?? null,
			done: native.isDone && stream.readPhase + 1 >= phases.length,
			nextPhase: native.isDone ? stream.readPhase + 1 : stream.readPhase,
			cursor: native.isDone ? null : native.continueCursor,
		};
	}

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
