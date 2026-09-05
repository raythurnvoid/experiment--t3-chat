import { paginationOptsValidator, type RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { files_node_require_writable } from "./files_nodes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
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
import { files_search_query_qualified_field_is_valid } from "../shared/files-search-query.ts";
import {
	organizations_is_reserved_workspace_id,
	organizations_is_global_organization_id,
} from "../shared/organizations.ts";
import { files_db_get_visible_node_by_path, files_pending_update_content_of } from "../server/files.ts";

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
		.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.nodeId)
				.gte("qualifiedField", files_metadata_FRONTMATTER_FIELD_PREFIX)
				.lt("qualifiedField", "frontmatter/"),
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
		.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
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
		archiveOperationId: fileNode.archiveOperationId,
	};
	await Promise.all([
		...metadata.fields.map((qualifiedField) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField,
				docKind: "field" as const,
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField: value.qualifiedField,
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
		userId: string;
		nodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
		unstagedText: string;
	},
) {
	await files_metadata_db_delete_pending(ctx, { pendingUpdateId: args.pendingUpdateId });

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		console.error("Failed to replace pending metadata: fileNode is missing or mismatched", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			fileNode,
		});
		return;
	}

	const preflight = files_metadata_preflight_frontmatter(args.unstagedText);
	// The stale pending docs were deleted above, so returning here leaves this proposal with no
	// frontmatter docs. That is the right outcome: the proposal still saves, and nothing stale is
	// left behind.
	if (preflight._nay) {
		console.warn("Skipped pending frontmatter metadata: the frontmatter could not be parsed", {
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			error: preflight._nay,
		});
		return;
	}

	const metadata = preflight._yay.metadata;
	// Impossible backstop only: the pending commit mutations run the same preflight before any
	// canonical write and return a visible refusal. The throw stays so an unexpected over-cap
	// insert still rolls back the whole pending save mutation, including the pending update doc
	// write that ran before this helper.
	if (files_metadata_frontmatter_exceeds_index_caps(preflight._yay)) {
		throw convex_error({ message: "Too many frontmatter fields" });
	}

	const scope = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "pending" as const,
		userId: args.userId,
		pendingUpdateId: args.pendingUpdateId,
		path: fileNode.path,
		treePath: fileNode.treePath,
		archiveOperationId: fileNode.archiveOperationId,
	};
	await Promise.all([
		...metadata.fields.map((qualifiedField) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField,
				docKind: "field" as const,
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField: value.qualifiedField,
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
	const docs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.collect();
	await Promise.all(docs.map((doc) => ctx.db.patch("files_metadata_docs", doc._id, patch)));
}

// #endregion indexed doc writes

// #region search

function tree_path_from_path(path: string) {
	return path === "/" ? "/" : `${path.replace(/\/+$/u, "")}/`;
}

/**
 * Exclusive upper bound of a subtree scan. A tree path prefix ends in `/`, and `0` is the next
 * character after `/`, so `>= "/docs/" && < "/docs0"` covers every descendant of `/docs` and
 * nothing else. `\uffff` would miss paths with characters above the Basic Multilingual Plane.
 */
function tree_path_upper_bound(treePathPrefix: string) {
	return `${treePathPrefix.slice(0, -1)}0`;
}

/**
 * Exclusive upper bound of a string prefix scan. Convex sorts strings by their UTF-8 bytes, which
 * is code point order, so the last code point of the prefix goes up by one: `>= "op" && < "oq"`
 * covers `open` and `op😀`. `${prefix}\uffff` would miss a value whose next character is above the
 * Basic Multilingual Plane. The step skips the surrogate range, which no string holds. A prefix
 * that ends in the last code point carries into the one before it, and a prefix made of that code
 * point alone has no bound. The code points before it are joined back with `join("")`, not spread
 * into `String.fromCodePoint(...chars)`, because a spread of a long value throws a RangeError.
 */
function string_prefix_upper_bound(prefix: string) {
	const chars = [...prefix];
	while (chars.length > 0) {
		const last = chars.pop()!.codePointAt(0)!;
		if (last < 0x10ffff) {
			const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
			return chars.join("") + String.fromCodePoint(next);
		}
	}
	return null;
}

function metadata_kind_from_qualified_field(qualifiedField: string) {
	return qualifiedField.slice(0, qualifiedField.indexOf("."));
}

async function db_list_pending_file_node_ids(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_pending_updates">["organizationId"];
		workspaceId: Doc<"files_pending_updates">["workspaceId"];
		userId: Id<"users">;
	},
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.order("asc")
		.collect();
	// Move-only docs have no pending metadata docs: only content-bearing
	// docs hide their file's committed docs.
	return pendingUpdates
		.filter((pendingUpdate) => files_pending_update_content_of(pendingUpdate) != null)
		.map((pendingUpdate) => pendingUpdate.fileNodeId);
}

function format_search_result(doc: Doc<"files_metadata_docs">) {
	const base = {
		path: doc.path,
		nodeId: doc.fileNodeId,
		qualifiedField: doc.qualifiedField,
		metadataKind: metadata_kind_from_qualified_field(doc.qualifiedField),
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
				fileNodeId: doc.fileNodeId,
				qualifiedField: doc.qualifiedField,
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
			return ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.eq("qualifiedField", plan.qualifiedField);
					return args.treePathPrefix
						? base.gte("treePath", args.treePathPrefix).lt("treePath", tree_path_upper_bound(args.treePathPrefix))
						: base;
				});
		case "eq":
			if (typeof plan.value === "string") {
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("qualifiedField", plan.qualifiedField)
							.eq("valueKind", "string")
							.eq("stringValue", value);
						return args.treePathPrefix
							? base.gte("treePath", args.treePathPrefix).lt("treePath", tree_path_upper_bound(args.treePathPrefix))
							: base;
					});
			}
			if (typeof plan.value === "number") {
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_qualifiedField_number_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("qualifiedField", plan.qualifiedField)
							.eq("valueKind", "number")
							.eq("numberValue", value);
						return args.treePathPrefix
							? base.gte("treePath", args.treePathPrefix).lt("treePath", tree_path_upper_bound(args.treePathPrefix))
							: base;
					});
			}
			{
				const value = plan.value;
				return ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_qualifiedField_boolean_tree", (q) => {
						const base = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("qualifiedField", plan.qualifiedField)
							.eq("valueKind", "boolean")
							.eq("booleanValue", value);
						return args.treePathPrefix
							? base.gte("treePath", args.treePathPrefix).lt("treePath", tree_path_upper_bound(args.treePathPrefix))
							: base;
					});
			}
		case "prefix":
			return ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("qualifiedField", plan.qualifiedField)
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
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_number_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("qualifiedField", plan.qualifiedField)
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
 * Whether one doc read from an index range belongs to the caller's view: under the folder path,
 * and under the pending overlay rule. Metadata search follows the same overlay rule as full-text
 * search: show the acting user's pending indexed docs and hide stale committed docs for those files.
 */
function search_doc_is_visible(
	metadataDoc: Doc<"files_metadata_docs">,
	args: {
		userId: Id<"users">;
		pendingNodeIds: Array<Id<"files_nodes">>;
		treePathPrefix?: string;
	},
) {
	if (args.treePathPrefix && !metadataDoc.treePath.startsWith(args.treePathPrefix)) {
		return false;
	}
	if (metadataDoc.sourceKind === "pending") {
		return metadataDoc.userId === args.userId;
	}
	return !args.pendingNodeIds.includes(metadataDoc.fileNodeId);
}

/**
 * The index range of one plan with the rule of `search_doc_is_visible` as query filters, for the
 * paginated agent `search`. A filter reads the docs it drops, so a door with a read cap reads the
 * index range raw and checks the docs itself.
 */
function search_query(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_metadata_docs">["organizationId"];
		workspaceId: Doc<"files_metadata_docs">["workspaceId"];
		plan: files_metadata_SearchPlan;
		treePathPrefix?: string;
		userId: Id<"users">;
		pendingNodeIds: Array<Id<"files_nodes">>;
	},
) {
	let query = search_index_query(ctx, args);
	const treePathPrefix = args.treePathPrefix;
	if ((args.plan.op === "prefix" || args.plan.op === "range") && treePathPrefix) {
		query = query.filter((q) =>
			q.and(
				q.gte(q.field("treePath"), treePathPrefix),
				q.lt(q.field("treePath"), tree_path_upper_bound(treePathPrefix)),
			),
		);
	}
	query = query.filter((q) =>
		q.or(
			q.eq(q.field("sourceKind"), "committed"),
			q.and(q.eq(q.field("sourceKind"), "pending"), q.eq(q.field("userId"), args.userId)),
		),
	);
	for (const pendingNodeId of args.pendingNodeIds) {
		query = query.filter((q) =>
			q.or(q.neq(q.field("fileNodeId"), pendingNodeId), q.eq(q.field("sourceKind"), "pending")),
		);
	}
	return query;
}

/**
 * One search plan, as `files_metadata_SearchPlan` in `shared/files-metadata.ts`. The agent's
 * `search` and the search box's `search_nodes` accept the same shape.
 */
const search_plan_validator = v.union(
	v.object({ op: v.literal("exists"), qualifiedField: v.string() }),
	v.object({
		op: v.literal("eq"),
		qualifiedField: v.string(),
		value: v.union(v.string(), v.number(), v.boolean()),
	}),
	v.object({ op: v.literal("prefix"), qualifiedField: v.string(), value: v.string() }),
	v.object({
		op: v.literal("range"),
		qualifiedField: v.string(),
		valueKind: v.union(v.literal("number"), v.literal("maybe_date")),
		gte: v.optional(v.number()),
		gt: v.optional(v.number()),
		lte: v.optional(v.number()),
		lt: v.optional(v.number()),
	}),
);

export const search = internalQuery({
	args: {
		// Scope accepts the reserved `/.mounts` literals so the mount-backed db-files FS can search mount metadata.
		organizationId: doc(app_convex_schema, "files_metadata_docs").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_metadata_docs").fields.workspaceId,
		userId: v.id("users"),
		plan: search_plan_validator,
		pathPrefix: v.optional(v.string()),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				nodeId: v.id("files_nodes"),
				qualifiedField: v.string(),
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
		let pendingNodeIds: Array<Id<"files_nodes">> = [];
		const organizationId = args.organizationId;
		const workspaceId = args.workspaceId;
		// File metadata is not derived from content, so a pending content edit must not hide it. Every
		// plan targets one qualified field. So the field prefix alone decides this for the whole query,
		// and a metadata search never collects the pending overlay.
		const isMetadataPlan = args.plan.qualifiedField.startsWith(files_metadata_METADATA_FIELD_PREFIX);
		if (
			!isMetadataPlan &&
			!organizations_is_global_organization_id(organizationId) &&
			!organizations_is_reserved_workspace_id(workspaceId)
		) {
			pendingNodeIds = await db_list_pending_file_node_ids(ctx, {
				organizationId,
				workspaceId,
				userId: args.userId,
			});
		}
		const treePathPrefix = args.pathPrefix == null ? undefined : tree_path_from_path(args.pathPrefix);
		const query = search_query(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			plan: args.plan,
			treePathPrefix,
			userId: args.userId,
			pendingNodeIds,
		});
		const result = await query.paginate({ cursor: args.cursor, numItems: args.numItems });

		// Metadata docs carry the file path, so a hit inside a restricted folder would say the file is
		// there and what it is called. Each distinct file on the page is looked up once.
		const pageNodeIds = [...new Set(result.page.map((metadataDoc) => metadataDoc.fileNodeId))];
		const pageNodes = (await Promise.all(pageNodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
			(fileNode) => fileNode !== null,
		);
		const readableNodeIds = new Set(
			(
				await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodes: pageNodes,
				})
			).map((fileNode) => fileNode._id),
		);

		return {
			items: result.page.filter((metadataDoc) => readableNodeIds.has(metadataDoc.fileNodeId)).map(format_search_result),
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
 * Caps for the search box doors below. The box sends one filter per query. A filter expands to at
 * most four plans: two metadata kinds times two value kinds. The docs of each plan are read before
 * the readable-nodes filter runs, so the caps bound the reads, not the answer. A workspace with
 * more matching docs than one plan reads gets a partial answer. `file.path:` narrows the scan of
 * the exists and eq plans. The prefix and range plans check the folder on the docs read.
 *
 * The readable-nodes filter pays one permission check per distinct restricted folder among the
 * candidates, and a check costs several index reads. So the candidates are also cut at
 * `SEARCH_NODES_MAX_SCOPES` restricted folders, to stay inside the 4096 reads Convex allows.
 */
const SEARCH_NODES_MAX_PLANS = 4;
const SEARCH_NODES_DOCS_PER_PLAN = 1000;
const SEARCH_NODES_MAX_CANDIDATES = 1000;
const SEARCH_NODES_MAX_SCOPES = 250;
const SEARCH_PATH_PREFIX_MAX_LENGTH = 1024;
const SEARCH_QUALIFIED_FIELD_MAX_LENGTH = 160;

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
const SEARCH_SCOPE_CHECK_READS = 8;
const SEARCH_VALUE_PREFIX_MAX_LENGTH = 200;
const SEARCH_VALUE_KINDS = ["string", "number", "boolean", "maybe_date"] as const;

/**
 * The key grammar `shared/files-search-query.ts` produces. Anything else did not come from the
 * app, and the doors answer it with their empty shape.
 */
function search_qualified_field_is_valid(qualifiedField: string) {
	return (
		qualifiedField.length <= SEARCH_QUALIFIED_FIELD_MAX_LENGTH &&
		files_search_query_qualified_field_is_valid(qualifiedField)
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
 * What one catalog walk remembers across keys and values: which nodes and which restricted scopes
 * the caller can read, and how many index reads the walk has spent.
 */
type SearchSampleCache = {
	readableByNodeId: Map<Id<"files_nodes">, boolean>;
	readableByScopeId: Map<string, boolean>;
	reads: number;
};

/**
 * True when one of the sample docs sits on a file the caller can read. The catalog must not name
 * a key or value from a doc alone, because the doc's file may sit in a restricted folder.
 *
 * Whether a file is readable depends on its restricted scope only, so the answer is cached per
 * scope as well as per node. A workspace with one restricted folder then pays for one permission
 * check, not one per sampled file.
 */
async function db_search_sample_is_readable(
	ctx: QueryCtx,
	args: {
		caller: NonNullable<Awaited<ReturnType<typeof db_get_search_caller>>>;
		docs: Doc<"files_metadata_docs">[];
		mut_cache: SearchSampleCache;
	},
) {
	for (const nodeId of new Set(args.docs.map((metadataDoc) => metadataDoc.fileNodeId))) {
		let readable = args.mut_cache.readableByNodeId.get(nodeId);
		if (readable === undefined) {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			args.mut_cache.reads += 1;
			if (fileNode === null) {
				readable = false;
			} else {
				const scopeKey = fileNode.restrictedScopeNodeId ?? "";
				readable = args.mut_cache.readableByScopeId.get(scopeKey);
				if (readable === undefined) {
					readable =
						(
							await access_control_db_filter_readable_file_nodes(ctx, {
								organizationId: args.caller.membership.organizationId,
								workspaceId: args.caller.membership.workspaceId,
								userId: args.caller.userAuth.id,
								nodes: [fileNode],
								hasWorkspaceRead: args.caller.hasWorkspaceRead,
							})
						).length > 0;
					// An open node costs the filter no reads. A restricted scope costs one permission check.
					if (fileNode.restrictedScopeNodeId) {
						args.mut_cache.reads += SEARCH_SCOPE_CHECK_READS;
					}
					args.mut_cache.readableByScopeId.set(scopeKey, readable);
				}
			}
			args.mut_cache.readableByNodeId.set(nodeId, readable);
		}
		if (readable) {
			return true;
		}
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
	returns: v.object({ nodeIds: v.array(v.id("files_nodes")) }),
	handler: async (ctx, args) => {
		const caller = await db_get_search_caller(ctx, { membershipId: args.membershipId });
		if (!caller) {
			return { nodeIds: [] };
		}

		// One filter is at most four plans over keys the shared grammar accepts, inside a folder
		// path. Anything else did not come from the app and gets the empty answer, not an error.
		if (
			args.plans.length === 0 ||
			args.plans.length > SEARCH_NODES_MAX_PLANS ||
			args.plans.some((plan) => !search_qualified_field_is_valid(plan.qualifiedField)) ||
			(args.pathPrefix !== undefined &&
				(!args.pathPrefix.startsWith("/") || args.pathPrefix.length > SEARCH_PATH_PREFIX_MAX_LENGTH))
		) {
			return { nodeIds: [] };
		}

		const { organizationId, workspaceId } = caller.membership;
		const userId = caller.userAuth.id;

		// A pending content edit changes frontmatter, not the metadata map, so only frontmatter plans
		// use the pending overlay. See `search` for the rule.
		const hasFrontmatterPlan = args.plans.some((plan) =>
			plan.qualifiedField.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX),
		);
		const pendingNodeIds = hasFrontmatterPlan
			? await db_list_pending_file_node_ids(ctx, { organizationId, workspaceId, userId })
			: [];
		const treePathPrefix = args.pathPrefix === undefined ? undefined : tree_path_from_path(args.pathPrefix);

		// Read each plan's index range raw, so the cap bounds the docs read. The folder path and the
		// pending overlay are checked on the docs read.
		const candidateIds = new Set<Id<"files_nodes">>();
		for (const plan of args.plans) {
			const metadataDocs = await search_index_query(ctx, { organizationId, workspaceId, plan, treePathPrefix }).take(
				SEARCH_NODES_DOCS_PER_PLAN,
			);
			const planPendingNodeIds = plan.qualifiedField.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)
				? pendingNodeIds
				: [];
			for (const metadataDoc of metadataDocs) {
				if (candidateIds.size >= SEARCH_NODES_MAX_CANDIDATES) {
					break;
				}
				if (search_doc_is_visible(metadataDoc, { userId, pendingNodeIds: planPendingNodeIds, treePathPrefix })) {
					candidateIds.add(metadataDoc.fileNodeId);
				}
			}
		}

		// A hit inside a restricted folder must not reach a caller who was not given that folder.
		// Past `SEARCH_NODES_MAX_SCOPES` restricted folders the answer is partial.
		const candidateNodes = (
			await Promise.all([...candidateIds].map((nodeId) => ctx.db.get("files_nodes", nodeId)))
		).filter((fileNode) => fileNode !== null);
		const scopeIds = new Set<string>();
		const cappedNodes = candidateNodes.filter((fileNode) => {
			if (!fileNode.restrictedScopeNodeId) {
				return true;
			}
			if (!scopeIds.has(fileNode.restrictedScopeNodeId) && scopeIds.size >= SEARCH_NODES_MAX_SCOPES) {
				return false;
			}
			scopeIds.add(fileNode.restrictedScopeNodeId);
			return true;
		});
		const readableNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId,
			workspaceId,
			userId,
			nodes: cappedNodes,
			hasWorkspaceRead: caller.hasWorkspaceRead,
		});

		// No "is complete" flag, on purpose: a flag next to fewer ids than the caps would say outright
		// that restricted files matched. The caps can still hint at it, but never name a file.
		return { nodeIds: readableNodes.map((fileNode) => fileNode._id) };
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
			qualifiedField: v.string(),
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
		const mut_cache: SearchSampleCache = { readableByNodeId: new Map(), readableByScopeId: new Map(), reads: 0 };
		const fields: Array<{ qualifiedField: string; valueKinds: Array<(typeof SEARCH_VALUE_KINDS)[number]> }> = [];
		let lastQualifiedField = "";

		// Walk the distinct qualified fields with one index read per field: the first field doc above
		// the last one seen. Each field then reads a few docs per kind to decide whether the caller
		// may see it.
		while (fields.length < SEARCH_FIELDS_MAX_FIELDS && mut_cache.reads < SEARCH_FIELDS_READ_BUDGET) {
			const after = lastQualifiedField;
			const nextFieldDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_tree", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.gt("qualifiedField", after),
				)
				.first();
			mut_cache.reads += 1;
			if (!nextFieldDoc) {
				break;
			}
			const qualifiedField = nextFieldDoc.qualifiedField;
			lastQualifiedField = qualifiedField;
			// The other doors refuse a field this long, so the catalog must not offer it.
			if (!search_qualified_field_is_valid(qualifiedField)) {
				continue;
			}

			// The samples are read raw, so one index read is one read. Another user's draft among them
			// is dropped here instead of by a query filter, which would read on past the cap.
			const fieldDocs = (
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_org_workspace_archive_docKind_qualifiedField_tree", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "field")
							.eq("qualifiedField", qualifiedField),
					)
					.take(SEARCH_CATALOG_SAMPLE_DOCS)
			).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
			mut_cache.reads += 1;
			let readable = await db_search_sample_is_readable(ctx, { caller, docs: fieldDocs, mut_cache });

			// Every value index has `valueKind` right after the key, so the string index serves all
			// four kinds. A kind is listed only when the caller can read a file that holds it.
			const valueKinds: Array<(typeof SEARCH_VALUE_KINDS)[number]> = [];
			for (const valueKind of SEARCH_VALUE_KINDS) {
				const valueDocs = (
					await ctx.db
						.query("files_metadata_docs")
						.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("archiveOperationId", undefined)
								.eq("docKind", "value")
								.eq("qualifiedField", qualifiedField)
								.eq("valueKind", valueKind),
						)
						.take(SEARCH_CATALOG_SAMPLE_DOCS)
				).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
				mut_cache.reads += 1;
				if (valueDocs.length > 0 && (await db_search_sample_is_readable(ctx, { caller, docs: valueDocs, mut_cache }))) {
					valueKinds.push(valueKind);
					readable = true;
				}
			}

			if (readable) {
				fields.push({ qualifiedField, valueKinds });
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
		qualifiedField: v.string(),
		prefix: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const caller = await db_get_search_caller(ctx, { membershipId: args.membershipId });
		if (!caller) {
			return [];
		}
		if (!search_qualified_field_is_valid(args.qualifiedField) || args.prefix.length > SEARCH_VALUE_PREFIX_MAX_LENGTH) {
			return [];
		}

		const { organizationId, workspaceId } = caller.membership;
		const userId = caller.userAuth.id;
		const mut_cache: SearchSampleCache = { readableByNodeId: new Map(), readableByScopeId: new Map(), reads: 0 };
		const values: string[] = [];
		let lastValue: string | null = null;

		// Walk the distinct values with one index read per value. The index is sorted by value, so
		// the first value that does not start with the prefix ends the walk. No upper bound is needed.
		// The first read starts at the prefix itself, every later read starts above the last value.
		while (values.length < SEARCH_VALUES_MAX_VALUES && mut_cache.reads < SEARCH_VALUES_READ_BUDGET) {
			const lowerBound: { gte: string } | { gt: string } =
				lastValue === null ? { gte: args.prefix } : { gt: lastValue };
			const nextValueDoc = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) => {
					const base = q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("qualifiedField", args.qualifiedField)
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
					.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("archiveOperationId", undefined)
							.eq("docKind", "value")
							.eq("qualifiedField", args.qualifiedField)
							.eq("valueKind", "string")
							.eq("stringValue", value),
					)
					.take(SEARCH_CATALOG_SAMPLE_DOCS)
			).filter((metadataDoc) => metadataDoc.sourceKind === "committed" || metadataDoc.userId === userId);
			mut_cache.reads += 1;
			if (await db_search_sample_is_readable(ctx, { caller, docs: valueDocs, mut_cache })) {
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
				qualifiedField: doc.qualifiedField,
				valueKind: "string" as const,
				stringValue: doc.stringValue,
			};
		case "number":
			return {
				qualifiedField: doc.qualifiedField,
				valueKind: "number" as const,
				numberValue: doc.numberValue,
			};
		case "boolean":
			return {
				qualifiedField: doc.qualifiedField,
				valueKind: "boolean" as const,
				booleanValue: doc.booleanValue,
			};
		case "maybe_date":
			return {
				qualifiedField: doc.qualifiedField,
				valueKind: "maybe_date" as const,
				numberValue: doc.numberValue,
			};
		default: {
			const errorMessage = "metadataDoc.valueKind is not set";
			const errorData = {
				metadataDocId: doc._id,
				fileNodeId: doc.fileNodeId,
				qualifiedField: doc.qualifiedField,
				docKind: doc.docKind,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
	}
}

export const get_by_path = internalQuery({
	args: {
		// Scope accepts the reserved `/.mounts` literals so the mount-backed db-files FS can read mount metadata.
		organizationId: doc(app_convex_schema, "files_metadata_docs").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_metadata_docs").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			path: v.string(),
			nodeId: v.id("files_nodes"),
			sourceKind: v.union(v.literal("committed"), v.literal("pending")),
			fields: v.array(v.string()),
			values: v.array(
				v.object({
					qualifiedField: v.string(),
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
		const fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			overlayUserId: args.overlayUserId,
		});
		if (!fileNode || fileNode.kind !== "file") {
			return null;
		}

		const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodes: [fileNode],
		});
		if (!readable) {
			return null;
		}

		let pendingUpdate: Doc<"files_pending_updates"> | null = null;
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const organizationId: Id<"organizations"> = args.organizationId;
			const workspaceId: Id<"organizations_workspaces"> = args.workspaceId;
			const row = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("userId", args.userId)
						.eq("fileNodeId", fileNode._id),
				)
				.first();
			// A move-only doc carries no pending metadata docs: committed
			// metadata stays authoritative for it.
			if (row && files_pending_update_content_of(row) != null) {
				pendingUpdate = row;
			}
		}

		// `sourceKind` describes the frontmatter docs only. A pending content proposal replaces what
		// the file's own frontmatter says, but it says nothing about the metadata written next to the
		// file, so those docs are always read from committed and are always current.
		const sourceKind = pendingUpdate ? ("pending" as const) : ("committed" as const);
		const committedDocs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", fileNode._id),
			)
			.collect();
		const docs = pendingUpdate
			? [
					...committedDocs.filter((doc) => doc.qualifiedField.startsWith(files_metadata_METADATA_FIELD_PREFIX)),
					...(await ctx.db
						.query("files_metadata_docs")
						.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
						.collect()),
				]
			: committedDocs;

		return {
			// The overlay can present a moved node here: echo the requested path, not the
			// node's committed path (identical without an overlay).
			path: args.path,
			nodeId: fileNode._id,
			sourceKind,
			fields: docs.filter((doc) => doc.docKind === "field").map((doc) => doc.qualifiedField),
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

export const files_metadata_entry_fields = {
	key: v.string(),
	value: v.union(v.string(), v.number(), v.boolean()),
};

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
		fileNodeId: doc.fileNodeId,
		qualifiedField: doc.qualifiedField,
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
		.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.fileNodeId)
				.gte("qualifiedField", files_metadata_METADATA_FIELD_PREFIX)
				.lt("qualifiedField", "metadata/"),
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
async function db_read_metadata(
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
			key: doc.qualifiedField.slice(files_metadata_METADATA_FIELD_PREFIX.length),
			value: read_entry_value(doc),
		}));
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
 * read-only lock before they call it.
 *
 * The file-creation flows also call it directly, inside the same transaction that creates the node.
 * At that moment no permission has been set on the new file yet. Mount files and plugin source
 * mirrors go further: they are created read-only with a SYSTEM author on purpose. If those flows
 * went through the doors, the read-only check would refuse the very write that records where the
 * file came from.
 */
export async function files_metadata_db_write_entries(
	ctx: MutationCtx,
	args: {
		fileNode: Doc<"files_nodes">;
		entries: files_metadata_Entry[];
	},
) {
	const existingDocs = await db_query_metadata_docs(ctx, {
		organizationId: args.fileNode.organizationId,
		workspaceId: args.fileNode.workspaceId,
		fileNodeId: args.fileNode._id,
	});
	await Promise.all(existingDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));

	const extracted = files_metadata_extract_entries(args.entries);
	// `fields` is built in entry order, so a field's position in it is the entry's position in the
	// map the user typed.
	const entryIndexByField = new Map(extracted.fields.map((qualifiedField, index) => [qualifiedField, index]));

	const scope = {
		organizationId: args.fileNode.organizationId,
		workspaceId: args.fileNode.workspaceId,
		fileNodeId: args.fileNode._id,
		sourceKind: "committed" as const,
		path: args.fileNode.path,
		treePath: args.fileNode.treePath,
		archiveOperationId: args.fileNode.archiveOperationId,
	};
	await Promise.all([
		...extracted.fields.map((qualifiedField) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField,
				docKind: "field" as const,
			}),
		),
		...extracted.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				qualifiedField: value.qualifiedField,
				entryIndex: entryIndexByField.get(value.qualifiedField),
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
	// Only files carry metadata, and a node from another workspace is not this member's to see, so
	// both answer "Not found" instead of naming what exists.
	if (
		!fileNode ||
		fileNode.organizationId !== args.membership.organizationId ||
		fileNode.workspaceId !== args.membership.workspaceId ||
		fileNode.kind !== "file"
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

	const writable = files_node_require_writable(fileNode);
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
	returns: v.array(v.object(files_metadata_entry_fields)),
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

		return await db_read_metadata(ctx, {
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
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		set: v.array(v.object(files_metadata_entry_fields)),
		remove: v.array(v.string()),
	},
	returns: v_result({ _yay: v.object({ path: v.string(), entries: v.array(v.object(files_metadata_entry_fields)) }) }),
	handler: async (ctx, args) => {
		const fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			overlayUserId: args.userId,
		});
		if (!fileNode || fileNode.kind !== "file") {
			return Result({ _nay: { message: "Not found" } });
		}

		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const writable = files_node_require_writable(fileNode);
		if (writable._nay) {
			return writable;
		}

		const currentEntries = await db_read_metadata(ctx, {
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			fileNodeId: fileNode._id,
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

		await files_metadata_db_write_entries(ctx, { fileNode, entries: validated._yay.entries });

		return Result({ _yay: { path: fileNode.path, entries: validated._yay.entries } });
	},
});

// #endregion file metadata
