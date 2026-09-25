import { paginationOptsValidator, type RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import app_convex_schema, {
	files_pending_target_validator,
	files_metadata_entries_validator,
	ai_chat_workspaces_source_validator,
} from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { files_search_db_create_reader } from "./files_search.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_pending_update_db_update_index_revision } from "./files_pending_updates.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { files_nodes_db_require_user_writable } from "./files_nodes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	path_tree_prefix_upper_bound,
	server_convex_get_user_fallback_to_anonymous,
	string_prefix_upper_bound,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_frontmatter_exceeds_index_caps,
	files_metadata_apply_set_and_remove,
	files_metadata_extract_entries,
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_parse_entries_yaml,
	files_metadata_validate_remove_keys,
	files_metadata_preflight_frontmatter,
	files_metadata_validate_entries,
	type files_metadata_Entry,
	type files_metadata_SearchPlan,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";
import {
	files_search_query_field_path_is_valid,
	files_search_query_FIELD_PATH_MAX_LENGTH,
} from "../shared/files-search-query.ts";
import { files_sort_text_key, files_sort_value_of } from "../shared/files-sort.ts";
import {
	organizations_is_reserved_workspace_id,
	organizations_is_global_organization_id,
} from "../shared/organizations.ts";
import {
	files_db_get_visible_node_by_path,
	files_db_patch_pending_update,
	files_pending_update_has_pending_chunks,
} from "../server/files.ts";
import {
	files_pending_update_content_is_stale,
	type files_PendingTarget,
	type files_VisibleEntry,
} from "../shared/files.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

// #region indexed doc writes

function value_doc_payload(value: files_metadata_Value) {
	switch (value.valueKind) {
		case "string":
			return {
				docKind: "value" as const,
				valueKind: "string" as const,
				stringValue: value.value,
			};
		case "number":
			return {
				docKind: "value" as const,
				valueKind: "number" as const,
				numberValue: value.value,
			};
		case "boolean":
			return {
				docKind: "value" as const,
				valueKind: "boolean" as const,
				booleanValue: value.value,
			};
		case "maybe_date":
			return {
				docKind: "value" as const,
				valueKind: "maybe_date" as const,
				numberValue: value.value,
			};
	}
}

/**
 * The folder table sort fields of one committed field doc, built from the node and the values of
 * that one field. Value docs and pending docs never carry them.
 *
 * The flag and the key come from `restrictedScopeNodeId` and `name`, the fields the node's stored
 * copies are built from, so the field doc always matches the node's real state.
 */
function committed_field_sort_fields(fileNode: Doc<"files_nodes">, fieldValues: files_metadata_Value[]) {
	const sortValue = files_sort_value_of(fieldValues);
	return {
		parentId: fileNode.parentId,
		nodeKind: fileNode.kind,
		isRestrictedScopeRoot: fileNode.restrictedScopeNodeId === fileNode._id,
		name: fileNode.name,
		sortName: files_sort_text_key(fileNode.name),
		...(sortValue ? { sortValue: sortValue.sortValue, sortDisplayValue: sortValue.displayValue } : {}),
	};
}

/**
 * Delete only the frontmatter docs of a file, so re-indexing its content leaves the file metadata
 * a user or an agent wrote alone. Content materialization calls this before it re-inserts.
 *
 * The bound stops at `frontmatter/` because `/` is the next character after `.`, so the range
 * covers every `frontmatter.` field and nothing else.
 */
export async function files_metadata_db_delete_committed_frontmatter(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		nodeId: Id<"files_nodes">;
	},
) {
	const docs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.nodeId)
				.gte("fieldPath", files_metadata_FRONTMATTER_FIELD_PREFIX)
				.lt("fieldPath", "frontmatter/"),
		)
		.collect();
	await Promise.all(docs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));
}

export async function files_metadata_db_delete_pending(
	ctx: MutationCtx,
	args: { pendingUpdateId: Id<"files_pending_updates"> },
) {
	const docs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
	await Promise.all(docs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));
}

export async function files_metadata_db_insert_committed(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		nodeId: Id<"files_nodes">;
		yjsSequence?: number;
		markdownContent: string;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		fileNode.kind !== "file"
	) {
		const errorMessage = "fileNode is missing or mismatched";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			fileNode,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const preflight = files_metadata_preflight_frontmatter(args.markdownContent);
	// The save that called this must still finish, so index no frontmatter and keep going. The
	// caller already logged the same failure; log here too because this helper also runs from
	// paths that never preflight themselves.
	if (preflight._nay) {
		console.warn("Skipped committed frontmatter metadata: the frontmatter could not be parsed", {
			nodeId: args.nodeId,
			error: preflight._nay,
		});
		return;
	}

	const metadata = preflight._yay.metadata;
	// Impossible backstop only: committed materialization already ran this preflight and settled
	// a marker instead of calling here. The throw stays so an unexpected over-cap insert still
	// rolls the whole transaction back rather than exceeding Convex's per-transaction doc-write
	// limit.
	if (files_metadata_frontmatter_exceeds_index_caps(preflight._yay)) {
		throw convex_error({ message: "Too many frontmatter fields" });
	}

	const scope = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "committed" as const,
		...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
		path: fileNode.path,
		treePath: fileNode.treePath,
		archiveOperationId: fileNode.archiveOperationId ?? undefined,
	};
	await Promise.all([
		...metadata.fields.map((fieldPath) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath,
				docKind: "field" as const,
				...committed_field_sort_fields(
					fileNode,
					metadata.values.filter((value) => value.fieldPath === fieldPath),
				),
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath: value.fieldPath,
				...value_doc_payload(value),
			}),
		),
	]);
}

export async function files_metadata_db_replace_pending(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		target: Doc<"files_pending_updates">["target"];
		pendingUpdateId: Id<"files_pending_updates">;
		proposalRevision: number;
		path: string;
		archiveOperationId?: string;
		unstagedText?: string;
		createMetadata?: files_metadata_Entry[];
	},
) {
	await files_metadata_db_delete_pending(ctx, { pendingUpdateId: args.pendingUpdateId });

	const metadata = files_metadata_extract_entries(args.createMetadata ?? []);
	const entryIndexByField = new Map(metadata.fields.map((fieldPath, index) => [fieldPath, index]));
	const preflight = args.unstagedText === undefined ? null : files_metadata_preflight_frontmatter(args.unstagedText);
	// Malformed frontmatter must not hide a new file's separate metadata map.
	if (preflight?._nay) {
		console.warn("Skipped pending frontmatter metadata: the frontmatter could not be parsed", {
			target: args.target,
			pendingUpdateId: args.pendingUpdateId,
			error: preflight._nay,
		});
	} else if (preflight?._yay) {
		// Writers check the caps before they change the proposal. Check them again here, because
		// this transaction is the last place that can still refuse.
		if (files_metadata_frontmatter_exceeds_index_caps(preflight._yay)) {
			throw convex_error({ message: "Too many frontmatter fields" });
		}
		metadata.fields.push(...preflight._yay.metadata.fields);
		metadata.values.push(...preflight._yay.metadata.values);
	}

	const scope = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		sourceKind: "pending" as const,
		target: args.target,
		userId: args.userId,
		pendingUpdateId: args.pendingUpdateId,
		proposalRevision: args.proposalRevision,
		path: args.path,
		treePath: args.path,
		archiveOperationId: args.archiveOperationId,
	};
	await Promise.all([
		...metadata.fields.map((fieldPath) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath,
				docKind: "field" as const,
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath: value.fieldPath,
				entryIndex: entryIndexByField.get(value.fieldPath),
				...value_doc_payload(value),
			}),
		),
	]);
}

export async function files_metadata_db_patch_file_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path?: string;
		treePath?: string;
		archiveOperationId?: string;
		/** Written to committed field docs only, like every folder table sort field. */
		parentId?: Doc<"files_nodes">["parentId"];
		/** Written to committed field docs only, like every folder table sort field. */
		isRestrictedScopeRoot?: boolean;
		/** Written to committed field docs only, with its `sortName`, like every folder table sort field. */
		name?: string;
	},
) {
	const patch: Partial<Pick<Doc<"files_metadata_docs">, "path" | "treePath" | "archiveOperationId">> = {};
	if ("path" in args) {
		patch.path = args.path;
	}
	if ("treePath" in args) {
		patch.treePath = args.treePath;
	}
	if ("archiveOperationId" in args) {
		patch.archiveOperationId = args.archiveOperationId;
	}
	const sortFieldsPatch: Partial<Pick<Doc<"files_nodes">, "parentId" | "isRestrictedScopeRoot" | "name" | "sortName">> =
		{};
	if (args.parentId !== undefined) {
		sortFieldsPatch.parentId = args.parentId;
	}
	if (args.isRestrictedScopeRoot !== undefined) {
		sortFieldsPatch.isRestrictedScopeRoot = args.isRestrictedScopeRoot;
	}
	if (args.name !== undefined) {
		sortFieldsPatch.name = args.name;
		sortFieldsPatch.sortName = files_sort_text_key(args.name);
	}
	const docs = (
		await Promise.all([
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
				)
				.collect(),
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", args.nodeId),
				)
				.collect(),
		])
	).flat();
	await Promise.all(
		docs.flatMap((doc) => {
			const docPatch =
				doc.sourceKind === "committed" && doc.docKind === "field" ? { ...patch, ...sortFieldsPatch } : patch;
			// A restrict change patches only the field docs, so skip the docs it leaves alone.
			if (Object.keys(docPatch).length === 0) {
				return [];
			}
			return [ctx.db.patch("files_metadata_docs", doc._id, docPatch)];
		}),
	);
}

// #endregion indexed doc writes

// #region search

function tree_path_from_path(path: string) {
	return path === "/" ? "/" : `${path.replace(/\/+$/u, "")}/`;
}

function metadata_kind_from_field_path(fieldPath: string) {
	return fieldPath.slice(0, fieldPath.indexOf("."));
}

function format_search_result(doc: Doc<"files_metadata_docs">, entry: { target: files_PendingTarget; path: string }) {
	const base = {
		...entry,
		fieldPath: doc.fieldPath,
		metadataKind: metadata_kind_from_field_path(doc.fieldPath),
		sourceKind: doc.sourceKind,
	};
	if (doc.docKind === "field") {
		return {
			...base,
			valueKind: "none" as const,
		};
	}

	switch (doc.valueKind) {
		case "string":
			return {
				...base,
				valueKind: "string" as const,
				stringValue: doc.stringValue,
			};
		case "number":
			return {
				...base,
				valueKind: "number" as const,
				numberValue: doc.numberValue,
			};
		case "boolean":
			return {
				...base,
				valueKind: "boolean" as const,
				booleanValue: doc.booleanValue,
			};
		case "maybe_date":
			return {
				...base,
				valueKind: "maybe_date" as const,
				numberValue: doc.numberValue,
			};
		default: {
			const errorMessage = "metadataDoc.valueKind is not set";
			const errorData = {
				metadataDocId: doc._id,
				fieldPath: doc.fieldPath,
				docKind: doc.docKind,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
	}
}

/**
 * The index range of one plan. The folder path (`treePathPrefix`) sits in the index for the exists
 * and eq plans. The prefix and range plans use the last index column for the value, so their
 * folder path is checked on the docs read instead.
 */
function search_index_query(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		plan: files_metadata_SearchPlan;
		treePathPrefix?: string;
	},
) {
	const plan = args.plan;
	switch (plan.op) {
		case "exists":
			return ctx.db.query("files_metadata_docs").withIndex("by_org_workspace_archive_docKind_fieldPath_tree", (q) => {
				const base = q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("archiveOperationId", undefined)
					.eq("docKind", "field")
					.eq("fieldPath", plan.fieldPath);
				return args.treePathPrefix
					? base.gte("treePath", args.treePathPrefix).lt("treePath", path_tree_prefix_upper_bound(args.treePathPrefix))
					: base;
			});

		case "eq":
			if (typeof plan.value === "string") {
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_fieldPath_string_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("fieldPath", plan.fieldPath)
							.eq("valueKind", "string")
							.eq("stringValue", value);
						return args.treePathPrefix
							? base
									.gte("treePath", args.treePathPrefix)
									.lt("treePath", path_tree_prefix_upper_bound(args.treePathPrefix))
							: base;
					});
			}

			if (typeof plan.value === "number") {
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_fieldPath_number_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("fieldPath", plan.fieldPath)
							.eq("valueKind", "number")
							.eq("numberValue", value);
						return args.treePathPrefix
							? base
									.gte("treePath", args.treePathPrefix)
									.lt("treePath", path_tree_prefix_upper_bound(args.treePathPrefix))
							: base;
					});
			}

			{
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_fieldPath_boolean_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("fieldPath", plan.fieldPath)
							.eq("valueKind", "boolean")
							.eq("booleanValue", value);
						return args.treePathPrefix
							? base
									.gte("treePath", args.treePathPrefix)
									.lt("treePath", path_tree_prefix_upper_bound(args.treePathPrefix))
							: base;
					});
			}

		case "prefix":
			return ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_fieldPath_string_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("fieldPath", plan.fieldPath)
						.eq("valueKind", "string")
						.gte("stringValue", plan.value);
					const upperBound = string_prefix_upper_bound(plan.value);
					return upperBound === null ? base : base.lt("stringValue", upperBound);
				});

		case "range":
			// Reuse the numeric range index for maybe_date docs. Read their epoch milliseconds from
			// numberValue, and use valueKind to keep them separate from plain number docs.
			return ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_fieldPath_number_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("fieldPath", plan.fieldPath)
						.eq("valueKind", plan.valueKind);
					if (plan.gte != null) {
						const lower = base.gte("numberValue", plan.gte);
						if (plan.lte != null) return lower.lte("numberValue", plan.lte);
						if (plan.lt != null) return lower.lt("numberValue", plan.lt);
						return lower;
					}
					if (plan.gt != null) {
						const lower = base.gt("numberValue", plan.gt);
						if (plan.lte != null) return lower.lte("numberValue", plan.lte);
						if (plan.lt != null) return lower.lt("numberValue", plan.lt);
						return lower;
					}
					if (plan.lte != null) return base.lte("numberValue", plan.lte);
					if (plan.lt != null) return base.lt("numberValue", plan.lt);
					return base;
				});
	}
}

/**
 * Read owner candidates first. Saved index paths can lag a pending move.
 */
function search_query(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		plan: files_metadata_SearchPlan;
		userId: Id<"users">;
	},
) {
	return search_index_query(ctx, args).filter((q) =>
		q.or(
			q.eq(q.field("sourceKind"), "committed"),
			q.and(q.eq(q.field("sourceKind"), "pending"), q.eq(q.field("userId"), args.userId)),
		),
	);
}

/**
 * One search plan, as `files_metadata_SearchPlan` in `shared/files-metadata.ts`. The agent's
 * `search` and the search box's `search_nodes` accept the same shape.
 */
const search_plan_validator = v.union(
	v.object({ op: v.literal("exists"), fieldPath: v.string() }),
	v.object({
		op: v.literal("eq"),
		fieldPath: v.string(),
		value: v.union(v.string(), v.number(), v.boolean()),
	}),
	v.object({ op: v.literal("prefix"), fieldPath: v.string(), value: v.string() }),
	v.object({
		op: v.literal("range"),
		fieldPath: v.string(),
		valueKind: v.union(v.literal("number"), v.literal("maybe_date")),
		gte: v.optional(v.number()),
		gt: v.optional(v.number()),
		lte: v.optional(v.number()),
		lt: v.optional(v.number()),
	}),
);

export const search = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		// Scope accepts the reserved `/.mounts` literals so the mount-backed db-files FS can search mount metadata.
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		plan: search_plan_validator,
		pathPrefix: v.optional(v.string()),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				target: files_pending_target_validator,
				fieldPath: v.string(),
				metadataKind: v.string(),
				sourceKind: v.union(v.literal("committed"), v.literal("pending")),
				valueKind: v.union(
					v.literal("none"),
					v.literal("string"),
					v.literal("number"),
					v.literal("boolean"),
					v.literal("maybe_date"),
				),
				stringValue: v.optional(v.string()),
				numberValue: v.optional(v.number()),
				booleanValue: v.optional(v.boolean()),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}
		const treePathPrefix = args.pathPrefix == null ? undefined : tree_path_from_path(args.pathPrefix);
		const result = await search_query(ctx, args).paginate({
			cursor: args.cursor,
			numItems: Math.max(1, Math.min(100, args.numItems)),
		});
		const reader = await files_search_db_create_reader(ctx, args);
		const items = [];
		for (const metadataDoc of result.page) {
			const entry = await reader.resolveDocument(metadataDoc);
			if (reader.exhausted) throw convex_error({ message: "Search is too broad. Narrow the path or filters." });
			if (entry && (!treePathPrefix || tree_path_from_path(entry.path).startsWith(treePathPrefix)))
				items.push(format_search_result(metadataDoc, entry));
		}

		return {
			items,
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_metadata_search_Result =
	typeof search extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion search

// #region search box

/**
 * Raw index caps and the shared owner reader bound each filter query.
 */
const SEARCH_NODES_MAX_PLANS = 4;
const SEARCH_NODES_DOCS_PER_PLAN = 1000;
const SEARCH_PATH_PREFIX_MAX_LENGTH = 1024;

/**
 * Catalog caps. A key, kind, or value is listed only when one of its first few docs in index
 * order sits on a file the caller can read. A member who was given one folder deep inside a big
 * restricted tree can miss a key that way. Typing the key still works.
 *
 * The read budgets count index reads, not docs. Convex allows 4096 `db.get` and `db.query` calls
 * per query, and a permission check for one restricted scope costs several of them. The walk
 * stops early instead of throwing.
 */
const SEARCH_CATALOG_SAMPLE_DOCS = 11;
const SEARCH_FIELDS_MAX_FIELDS = 200;
const SEARCH_FIELDS_READ_BUDGET = 3000;
const SEARCH_VALUES_MAX_VALUES = 25;
const SEARCH_VALUES_READ_BUDGET = 400;
const SEARCH_VALUE_PREFIX_MAX_LENGTH = 200;
const SEARCH_VALUE_KINDS = ["string", "number", "boolean", "maybe_date"] as const;

/**
 * The key grammar `shared/files-search-query.ts` produces. Anything else did not come from the
 * app, and the doors answer it with their empty shape.
 */
function search_field_path_is_valid(fieldPath: string) {
	return (
		fieldPath.length <= files_search_query_FIELD_PATH_MAX_LENGTH && files_search_query_field_path_is_valid(fieldPath)
	);
}

/**
 * Resolve who is calling through `membershipId`, and whether the workspace lets them read
 * everything. Return null when the membership is not theirs. Every search door answers that with
 * its empty shape.
 *
 * A failed read check does not end the query. Somebody whose role gives no workspace-wide read
 * can still have been given one folder, and finding files in that folder is the whole point of
 * sharing. `hasWorkspaceRead` carries that answer to
 * `access_control_db_filter_readable_file_nodes`, which keeps only the nodes they were given.
 */
async function db_get_search_caller(ctx: QueryCtx, args: { membershipId: Id<"organizations_workspaces_users"> }) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) {
		throw convex_error({ message: "Unauthenticated" });
	}

	const membership = await organizations_db_get_membership(ctx, {
		userId: userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return null;
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		permission: "content.read",
	});
	return { userAuth, membership, hasWorkspaceRead: !authorized._nay };
}

/**
 * Keep one owner reader across keys and values. Count catalog range reads separately.
 */
type SearchSampleCache = {
	reader: Awaited<ReturnType<typeof files_search_db_create_reader>>;
	reads: number;
};

/**
 * A suggestion must belong to a current readable file or draft.
 */
async function db_search_sample_is_readable(args: {
	docs: Doc<"files_metadata_docs">[];
	mut_cache: SearchSampleCache;
}) {
	for (const metadataDoc of args.docs) {
		if (args.mut_cache.reader.exhausted) return false;
		if (await args.mut_cache.reader.resolveDocument(metadataDoc)) return true;
	}
	return false;
}

/**
 * The search box's door: the files one filter matches, as ids. The box owns the AND across
 * filters, the negation, and the `file.*` fields, because it already holds every readable node.
 */
export const search_nodes = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		plans: v.array(search_plan_validator),
		pathPrefix: v.optional(v.string()),
	},
	returns: v.object({ targets: v.array(files_pending_target_validator), truncated: v.boolean() }),
	handler: async (ctx, args) => {
		const caller = await db_get_search_caller(ctx, { membershipId: args.membershipId });
		if (!caller) {
			return { targets: [], truncated: false };
		}

		// One filter is at most four plans over keys the shared grammar accepts, inside a folder
		// path. Anything else did not come from the app and gets the empty answer, not an error.
		if (
			args.plans.length === 0 ||
			args.plans.length > SEARCH_NODES_MAX_PLANS ||
			args.plans.some((plan) => !search_field_path_is_valid(plan.fieldPath)) ||
			(args.pathPrefix !== undefined &&
				(!args.pathPrefix.startsWith("/") || args.pathPrefix.length > SEARCH_PATH_PREFIX_MAX_LENGTH))
		) {
			return { targets: [], truncated: false };
		}

		const { organizationId, workspaceId } = caller.membership;
		const userId = caller.userAuth.id;

		const treePathPrefix = args.pathPrefix === undefined ? undefined : tree_path_from_path(args.pathPrefix);
		const reader = await files_search_db_create_reader(ctx, {
			organizationId,
			workspaceId,
			userId,
			hasWorkspaceRead: caller.hasWorkspaceRead,
		});
		const targets = new Map<string, files_PendingTarget>();
		let truncated = false;
		for (const plan of args.plans) {
			const metadataDocs = await search_index_query(ctx, { organizationId, workspaceId, plan }).take(
				SEARCH_NODES_DOCS_PER_PLAN + 1,
			);
			if (metadataDocs.length > SEARCH_NODES_DOCS_PER_PLAN) truncated = true;
			for (const metadataDoc of metadataDocs.slice(0, SEARCH_NODES_DOCS_PER_PLAN)) {
				const entry = await reader.resolveDocument(metadataDoc);
				if (reader.exhausted) {
					truncated = true;
					break;
				}
				if (entry && (!treePathPrefix || tree_path_from_path(entry.path).startsWith(treePathPrefix)))
					targets.set(`${entry.target.kind}:${entry.target.id}`, entry.target);
			}
			if (reader.exhausted) break;
		}
		return { targets: [...targets.values()], truncated };
	},
});

/**
 * The qualified fields the search box suggests as keys, with the value kinds each one holds
 * somewhere the caller can read. They come back in index order, which is alphabetical.
 */
export const list_search_fields = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			fieldPath: v.string(),
			valueKinds: v.array(
				v.union(v.literal("string"), v.literal("number"), v.literal("boolean"), v.literal("maybe_date")),
			),
		}),
	),
	handler: async (ctx, args) => {
		const caller = await db_get_search_caller(ctx, { membershipId: args.membershipId });
		if (!caller) {
			return [];
		}

		const { organizationId, workspaceId } = caller.membership;
		const userId = caller.userAuth.id;
		const mut_cache: SearchSampleCache = {
			reader: await files_search_db_create_reader(ctx, {
				organizationId,
				workspaceId,
				userId,
				hasWorkspaceRead: caller.hasWorkspaceRead,
			}),
			reads: 0,
		};
		const fields: Array<{ fieldPath: string; valueKinds: Array<(typeof SEARCH_VALUE_KINDS)[number]> }> = [];
		let lastFieldPath = "";

		// Walk the distinct qualified fields with one index read per field: the first field doc above
		// the last one seen. Each field then reads a few docs per kind to decide whether the caller
		// may see it.
		while (
			fields.length < SEARCH_FIELDS_MAX_FIELDS &&
			mut_cache.reads < SEARCH_FIELDS_READ_BUDGET &&
			!mut_cache.reader.exhausted
		) {
			const after = lastFieldPath;
			const nextFieldDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_fieldPath_tree", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.gt("fieldPath", after),
				)
				.first();
			mut_cache.reads += 1;
			if (!nextFieldDoc) {
				break;
			}
			const fieldPath = nextFieldDoc.fieldPath;
			lastFieldPath = fieldPath;
			// The other doors refuse a field this long, so the catalog must not offer it.
			if (!search_field_path_is_valid(fieldPath)) {
				continue;
			}

			// The samples are read raw, so one index read is one read. Another user's draft among them
			// is dropped here instead of by a query filter, which would read on past the cap.
			const fieldDocs = (
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_fieldPath_tree", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "field")
							.eq("fieldPath", fieldPath),
					)
					.take(SEARCH_CATALOG_SAMPLE_DOCS)
			).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
			mut_cache.reads += 1;
			let readable = await db_search_sample_is_readable({ docs: fieldDocs, mut_cache });

			// Every value index has `valueKind` right after the key, so the string index serves all
			// four kinds. A kind is listed only when the caller can read a file that holds it.
			const valueKinds: Array<(typeof SEARCH_VALUE_KINDS)[number]> = [];
			for (const valueKind of SEARCH_VALUE_KINDS) {
				const valueDocs = (
					await ctx.db
						.query("files_metadata_docs")
						.withIndex("by_org_workspace_archive_docKind_fieldPath_string_tree", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("archiveOperationId", undefined)
								.eq("docKind", "value")
								.eq("fieldPath", fieldPath)
								.eq("valueKind", valueKind),
						)
						.take(SEARCH_CATALOG_SAMPLE_DOCS)
				).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
				mut_cache.reads += 1;
				if (valueDocs.length > 0 && (await db_search_sample_is_readable({ docs: valueDocs, mut_cache }))) {
					valueKinds.push(valueKind);
					readable = true;
				}
			}

			if (readable) {
				fields.push({ fieldPath, valueKinds });
			}
		}

		return fields;
	},
});

/**
 * The string values of one key that start with `prefix`, for the search box's value suggestions.
 */
export const list_search_values = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fieldPath: v.string(),
		prefix: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const caller = await db_get_search_caller(ctx, { membershipId: args.membershipId });
		if (!caller) {
			return [];
		}
		if (!search_field_path_is_valid(args.fieldPath) || args.prefix.length > SEARCH_VALUE_PREFIX_MAX_LENGTH) {
			return [];
		}

		const { organizationId, workspaceId } = caller.membership;
		const userId = caller.userAuth.id;
		const mut_cache: SearchSampleCache = {
			reader: await files_search_db_create_reader(ctx, {
				organizationId,
				workspaceId,
				userId,
				hasWorkspaceRead: caller.hasWorkspaceRead,
			}),
			reads: 0,
		};
		const values: string[] = [];
		let lastValue: string | null = null;

		// Walk the distinct values with one index read per value. The index is sorted by value, so
		// the first value that does not start with the prefix ends the walk. No upper bound is needed.
		// The first read starts at the prefix itself, every later read starts above the last value.
		while (
			values.length < SEARCH_VALUES_MAX_VALUES &&
			mut_cache.reads < SEARCH_VALUES_READ_BUDGET &&
			!mut_cache.reader.exhausted
		) {
			const lowerBound: { gte: string } | { gt: string } =
				lastValue === null ? { gte: args.prefix } : { gt: lastValue };
			const nextValueDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_fieldPath_string_tree", (q) => {
					const base = q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("fieldPath", args.fieldPath)
						.eq("valueKind", "string");
					return "gte" in lowerBound ? base.gte("stringValue", lowerBound.gte) : base.gt("stringValue", lowerBound.gt);
				})
				.first();
			mut_cache.reads += 1;
			if (
				!nextValueDoc ||
				nextValueDoc.stringValue === undefined ||
				!nextValueDoc.stringValue.startsWith(args.prefix)
			) {
				break;
			}
			// The annotation breaks an inference cycle: `lastValue` feeds the query that yields this value.
			const value: string = nextValueDoc.stringValue;
			lastValue = value;

			// Read raw for the same reason as in `list_search_fields`: one index read is one read.
			const valueDocs = (
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_fieldPath_string_tree", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("fieldPath", args.fieldPath)
							.eq("valueKind", "string")
							.eq("stringValue", value),
					)
					.take(SEARCH_CATALOG_SAMPLE_DOCS)
			).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
			mut_cache.reads += 1;
			if (await db_search_sample_is_readable({ docs: valueDocs, mut_cache })) {
				values.push(value);
			}
		}

		return values;
	},
});

// #endregion search box

// #region get by path

function format_get_by_path_value(doc: Doc<"files_metadata_docs">) {
	switch (doc.valueKind) {
		case "string":
			return {
				fieldPath: doc.fieldPath,
				valueKind: "string" as const,
				stringValue: doc.stringValue,
			};
		case "number":
			return {
				fieldPath: doc.fieldPath,
				valueKind: "number" as const,
				numberValue: doc.numberValue,
			};
		case "boolean":
			return {
				fieldPath: doc.fieldPath,
				valueKind: "boolean" as const,
				booleanValue: doc.booleanValue,
			};
		case "maybe_date":
			return {
				fieldPath: doc.fieldPath,
				valueKind: "maybe_date" as const,
				numberValue: doc.numberValue,
			};
		default: {
			const errorMessage = "metadataDoc.valueKind is not set";
			const errorData = {
				metadataDocId: doc._id,
				fieldPath: doc.fieldPath,
				docKind: doc.docKind,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
	}
}

export const get_by_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		// Scope accepts the reserved `/.mounts` literals so the mount-backed db-files FS can read mount metadata.
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		path: v.string(),
		/** The owner whose pending paths the caller is reading. */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			path: v.string(),
			target: files_pending_target_validator,
			sourceKind: v.union(v.literal("committed"), v.literal("pending")),
			fields: v.array(v.string()),
			values: v.array(
				v.object({
					fieldPath: v.string(),
					valueKind: v.union(v.literal("string"), v.literal("number"), v.literal("boolean"), v.literal("maybe_date")),
					stringValue: v.optional(v.string()),
					numberValue: v.optional(v.number()),
					booleanValue: v.optional(v.boolean()),
				}),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		let entry: files_VisibleEntry | null;
		if (
			args.serviceAccountId === undefined &&
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const reader = await files_visible_db_create_reader(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
			});
			entry = await reader.resolvePath(args.path);
			if (reader.exhausted) throw convex_error({ message: "Metadata path lookup exceeded its read limit." });
		} else {
			const node = await files_db_get_visible_node_by_path(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				path: args.path,
			});
			if (!node) return null;

			const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				serviceAccountId: args.serviceAccountId,
				nodes: [node],
			});
			entry = readable ? { kind: "saved", node, pendingUpdate: null, path: node.path } : null;
		}

		if (!entry) return null;
		if (
			entry.kind === "private" &&
			(entry.pendingUpdate.preparation ||
				!entry.pendingUpdate.createIntent ||
				(entry.pendingUpdate.createIntent.kind === "text" && !entry.pendingUpdate.content))
		)
			return null;

		const pendingUpdate =
			entry.pendingUpdate &&
			(entry.kind === "private" ||
				(files_pending_update_has_pending_chunks(entry.pendingUpdate) &&
					!files_pending_update_content_is_stale(entry.pendingUpdate, entry.node)))
				? entry.pendingUpdate
				: null;

		// Saved metadata stays current beside pending frontmatter. Private entries own both indexes.
		const sourceKind = pendingUpdate ? ("pending" as const) : ("committed" as const);
		const committedDocs =
			entry.kind === "private"
				? []
				: await ctx.db
						.query("files_metadata_docs")
						.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", entry.node._id),
						)
						.collect();
		const docs = pendingUpdate
			? [
					...committedDocs.filter((doc) => doc.fieldPath.startsWith(files_metadata_METADATA_FIELD_PREFIX)),
					...(
						await ctx.db
							.query("files_metadata_docs")
							.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
							.collect()
					).filter((doc) => doc.sourceKind === "pending" && doc.proposalRevision === pendingUpdate.revision),
				]
			: committedDocs;

		return {
			path: entry.path,
			target:
				entry.kind === "saved"
					? { kind: "saved" as const, id: entry.node._id }
					: { kind: "private" as const, id: entry.node._id },
			sourceKind,
			fields: docs.filter((doc) => doc.docKind === "field").map((doc) => doc.fieldPath),
			values: docs.filter((doc) => doc.docKind === "value").map(format_get_by_path_value),
		};
	},
});

export type files_metadata_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion get by path

// #region file metadata

/**
 * Read the scalar back out of one value doc.
 *
 * The three value fields are optional in the schema because one doc fills only its own field.
 * Both writers always fill it, so a doc that fills none is a bug and not a state to recover from.
 */
function read_entry_value(doc: Doc<"files_metadata_docs">) {
	if (doc.valueKind === "string" && doc.stringValue !== undefined) {
		return doc.stringValue;
	}
	if (doc.valueKind === "number" && doc.numberValue !== undefined) {
		return doc.numberValue;
	}
	if (doc.valueKind === "boolean" && doc.booleanValue !== undefined) {
		return doc.booleanValue;
	}

	const errorMessage = "metadata value doc has no value for its valueKind";
	const errorData = {
		metadataDocId: doc._id,
		fieldPath: doc.fieldPath,
		valueKind: doc.valueKind,
	};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}

/**
 * Collect every `metadata.` doc of one file. The bound stops at `metadata/` because `/` is the
 * next character after `.`, so the range covers every metadata field and no frontmatter field.
 */
async function db_query_metadata_docs(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		fileNodeId: Id<"files_nodes">;
	},
) {
	return await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.fileNodeId)
				.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
				.lt("fieldPath", "metadata/"),
		)
		.collect();
}

/**
 * Rebuild one file's metadata map from its index docs.
 *
 * Only value docs carry a value. A field doc exists so an existence search can find the key. A
 * `maybe_date` doc is a second copy of a date-like string that range search needs. Both would
 * repeat a key that a value doc already returned, so both are filtered out here. `entryIndex`
 * restores the order the keys were written in, because the index sorts them by key.
 */
export async function files_metadata_db_read_entries(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		fileNodeId: Id<"files_nodes">;
	},
) {
	const docs = await db_query_metadata_docs(ctx, args);

	return docs
		.filter((doc) => doc.docKind === "value" && doc.valueKind !== "maybe_date")
		.sort((left, right) => (left.entryIndex ?? 0) - (right.entryIndex ?? 0))
		.map((doc) => ({
			key: doc.fieldPath.slice(files_metadata_METADATA_FIELD_PREFIX.length),
			value: read_entry_value(doc),
		}));
}

export async function files_metadata_db_read_entry(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		fileNodeId: Id<"files_nodes">;
		key: string;
	},
) {
	const docs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.fileNodeId)
				.eq("fieldPath", `${files_metadata_METADATA_FIELD_PREFIX}${args.key}`),
		)
		.collect();
	// A scalar has an existence doc and a value doc, plus a date index when applicable.
	const valueDoc = docs.find((doc) => doc.docKind === "value" && doc.valueKind !== "maybe_date");
	return valueDoc ? read_entry_value(valueDoc) : undefined;
}

/**
 * Replace one file's metadata in a single transaction: delete the `metadata.` docs it has now,
 * then insert one field doc and one value doc per key. The file's frontmatter docs are untouched,
 * so a Markdown file keeps both sources side by side.
 *
 * Copy `path`, `treePath` and `archiveOperationId` from the node like the frontmatter writers do.
 * Search filters on those fields, so a doc without them would be invisible to a path-scoped or
 * archive-scoped search until the next rename.
 *
 * This writer checks nothing. The two user-facing doors below check the permission and the
 * current file policy before they call it.
 *
 * The file-creation flows also call it directly, inside the same transaction that creates the node.
 * At that moment no permission has been set on the new file yet. Mount files and plugin source
 * mirrors go further: they are created read-only with a SYSTEM author on purpose. If those flows
 * went through the doors, the read-only check would refuse the very write that records where the
 * file came from.
 */
export async function files_metadata_db_write_entries(
	ctx: MutationCtx,
	args: ({ fileNode: Doc<"files_nodes"> } | { privateEntry: Extract<files_VisibleEntry, { kind: "private" }> }) & {
		entries: files_metadata_Entry[];
	},
) {
	const existingDocs =
		"fileNode" in args
			? await db_query_metadata_docs(ctx, {
					organizationId: args.fileNode.organizationId,
					workspaceId: args.fileNode.workspaceId,
					fileNodeId: args.fileNode._id,
				})
			: await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) =>
						q
							.eq("pendingUpdateId", args.privateEntry.pendingUpdate._id)
							.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
							.lt("fieldPath", "metadata/"),
					)
					.collect();
	await Promise.all(existingDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));

	const extracted = files_metadata_extract_entries(args.entries);
	// `fields` is built in entry order, so a field's position in it is the entry's position in the
	// map the user typed.
	const entryIndexByField = new Map(extracted.fields.map((fieldPath, index) => [fieldPath, index]));

	const scope =
		"fileNode" in args
			? {
					organizationId: args.fileNode.organizationId,
					workspaceId: args.fileNode.workspaceId,
					fileNodeId: args.fileNode._id,
					sourceKind: "committed" as const,
					path: args.fileNode.path,
					treePath: args.fileNode.treePath,
					archiveOperationId: args.fileNode.archiveOperationId ?? undefined,
				}
			: {
					organizationId: args.privateEntry.node.organizationId,
					workspaceId: args.privateEntry.node.workspaceId,
					sourceKind: "pending" as const,
					target: args.privateEntry.pendingUpdate.target,
					userId: args.privateEntry.node.userId,
					pendingUpdateId: args.privateEntry.pendingUpdate._id,
					proposalRevision: args.privateEntry.pendingUpdate.revision,
					path: args.privateEntry.path,
					treePath: args.privateEntry.path,
				};
	await Promise.all([
		...extracted.fields.map((fieldPath) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath,
				docKind: "field" as const,
				...("fileNode" in args
					? committed_field_sort_fields(
							args.fileNode,
							extracted.values.filter((value) => value.fieldPath === fieldPath),
						)
					: {}),
			}),
		),
		...extracted.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath: value.fieldPath,
				entryIndex: entryIndexByField.get(value.fieldPath),
				...value_doc_payload(value),
			}),
		),
	]);
}

/**
 * The write door for file metadata.
 *
 * Metadata uses the same `content.write` permission as the file's content, because metadata is part
 * of what the file says. Keys have no owner. Anybody who may write the file may set any key, so
 * there is no second permission to check. A read-only file refuses metadata writes too, exactly
 * like its content.
 */
async function db_authorize_metadata_write(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		fileNodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
	// A node from another workspace is not this member's to see.
	if (
		!fileNode ||
		fileNode.organizationId !== args.membership.organizationId ||
		fileNode.workspaceId !== args.membership.workspaceId
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: "content.write",
		fileNode,
	});
	if (authorized._nay) {
		return authorized;
	}

	const writable = await files_nodes_db_require_user_writable(ctx, { node: fileNode, userId: args.userAuth.id });
	if (writable._nay) {
		return writable;
	}

	return Result({ _yay: fileNode });
}

export const get_entries = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: files_metadata_entries_validator,
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return [];
		}

		// Ask about the node, not the workspace, so a file inside a restricted folder is refused here
		// even for somebody the workspace lets read everything else.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return [];
		}

		return await files_metadata_db_read_entries(ctx, {
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			fileNodeId: fileNode._id,
		});
	},
});

export const set_entries = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
		metadataYaml: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await db_authorize_metadata_write(ctx, {
			userAuth,
			membership,
			fileNodeId: args.fileNodeId,
		});
		if (authorized._nay) {
			return authorized;
		}

		// The modal parses the same text before it calls, so the user normally sees a mistake without
		// spending a write. This is the real door: any other caller can send anything.
		const parsed = files_metadata_parse_entries_yaml(args.metadataYaml);
		if (parsed._nay) {
			return parsed;
		}

		await files_metadata_db_write_entries(ctx, { fileNode: authorized._yay, entries: parsed._yay.entries });

		return Result({ _yay: null });
	},
});

/**
 * The agent's write door: set some keys, remove some others, leave the rest alone.
 *
 * The agent works with paths, so the node is resolved the same way its file reads resolve one. It
 * has no membership doc, so permissions are checked against the user it acts for, exactly like the
 * agent's content writes.
 */
export const update_entries_by_path = internalMutation({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		set: files_metadata_entries_validator,
		remove: v.array(v.string()),
	},
	returns: v_result({ _yay: v.object({ path: v.string(), entries: files_metadata_entries_validator }) }),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const allowed = await ai_chat_workspaces_db_authorize_file_scope(ctx, { ...args, agentSource: args.agentSource });
			if (allowed._nay) return allowed;
		}
		const reader = await files_visible_db_create_reader(ctx, args);
		const resolved = await reader.findPath(args.path);
		if (reader.exhausted) return Result({ _nay: { message: "Metadata path lookup exceeded its read limit." } });

		if (!resolved || !(await reader.canRead(resolved.accessNode))) {
			return Result({ _nay: { message: "Not found" } });
		}
		const { entry, accessNode } = resolved;

		if (
			entry.kind === "private" &&
			(entry.pendingUpdate.preparation ||
				!entry.pendingUpdate.createIntent ||
				(entry.pendingUpdate.createIntent.kind === "text" && !entry.pendingUpdate.content))
		) {
			return Result({ _nay: { name: "preparing", message: "This draft is still preparing." } });
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.first();
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			fileNode: accessNode ?? undefined,
			permission: "content.write",
		});
		if (authorized._nay) return authorized;

		if (accessNode) {
			const writable = await files_nodes_db_require_user_writable(ctx, { node: accessNode, userId: args.userId });
			if (writable._nay) return writable;
		}

		const currentEntries =
			entry.kind === "private"
				? entry.pendingUpdate.createIntent!.metadata
				: await files_metadata_db_read_entries(ctx, {
						organizationId: entry.node.organizationId,
						workspaceId: entry.node.workspaceId,
						fileNodeId: entry.node._id,
					});
		// Check the removed keys before applying them. A key that cannot exist would remove nothing, and
		// the call would still report success, so the caller would never learn it made a mistake.
		const removeKeys = files_metadata_validate_remove_keys(args.remove);
		if (removeKeys._nay) {
			return removeKeys;
		}

		const entries = files_metadata_apply_set_and_remove(currentEntries, { set: args.set, remove: args.remove });

		// The map the file ends up with is what gets checked, not just the keys this call touches:
		// the caps are about the whole map.
		const validated = files_metadata_validate_entries(entries);
		if (validated._nay) {
			return validated;
		}

		if (entry.kind === "private") {
			const revision = entry.pendingUpdate.revision + 1;
			const updatedAt = Date.now();
			const createIntent = { ...entry.pendingUpdate.createIntent!, metadata: validated._yay.entries };
			await files_db_patch_pending_update(ctx, entry.pendingUpdate._id, { createIntent, revision, updatedAt });
			await files_pending_update_db_update_index_revision(ctx, {
				pendingUpdateId: entry.pendingUpdate._id,
				proposalRevision: revision,
			});
			await files_metadata_db_write_entries(ctx, {
				privateEntry: { ...entry, pendingUpdate: { ...entry.pendingUpdate, createIntent, revision, updatedAt } },
				entries: validated._yay.entries,
			});
		} else {
			await files_metadata_db_write_entries(ctx, { fileNode: entry.node, entries: validated._yay.entries });
		}

		return Result({ _yay: { path: entry.path, entries: validated._yay.entries } });
	},
});

// #endregion file metadata
