import { paginationOptsValidator, type RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_metadata_extract_frontmatter,
	type files_metadata_SearchPlan,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";
import { organizations_is_global_github_workspace_id, organizations_is_global_organization_id } from "../shared/organizations.ts";

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
	}
}

export async function files_metadata_db_delete_committed(
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
				.eq("fileNodeId", args.nodeId),
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

	const metadata = files_metadata_extract_frontmatter(args.markdownContent);
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
		unstagedMarkdown: string;
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

	const metadata = files_metadata_extract_frontmatter(args.unstagedMarkdown);
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
	return pendingUpdates.map((pendingUpdate) => pendingUpdate.fileNodeId);
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
	// Metadata search follows the same pending overlay rule as full-text search:
	// show the acting user's pending indexed docs and hide stale committed docs for those files.
	const plan = args.plan;
	switch (plan.op) {
		case "exists": {
			let query = ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.eq("qualifiedField", plan.qualifiedField);
					return args.treePathPrefix
						? base.gte("treePath", args.treePathPrefix).lt("treePath", `${args.treePathPrefix}\uffff`)
						: base;
				});
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
		case "eq":
			if (typeof plan.value === "string") {
				const value = plan.value;
				let query = ctx.db
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
							? base.gte("treePath", args.treePathPrefix).lt("treePath", `${args.treePathPrefix}\uffff`)
							: base;
					});
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
			if (typeof plan.value === "number") {
				const value = plan.value;
				let query = ctx.db
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
							? base.gte("treePath", args.treePathPrefix).lt("treePath", `${args.treePathPrefix}\uffff`)
							: base;
					});
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
			{
				const value = plan.value;
				let query = ctx.db
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
							? base.gte("treePath", args.treePathPrefix).lt("treePath", `${args.treePathPrefix}\uffff`)
							: base;
					});
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
		case "prefix": {
			let query = ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_string_tree", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("qualifiedField", plan.qualifiedField)
						.eq("valueKind", "string")
						.gte("stringValue", plan.value)
						.lt("stringValue", `${plan.value}\uffff`),
				);
			const treePathPrefix = args.treePathPrefix;
			if (treePathPrefix) {
				query = query.filter((q) =>
					q.and(q.gte(q.field("treePath"), treePathPrefix), q.lt(q.field("treePath"), `${treePathPrefix}\uffff`)),
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
		case "range": {
			let query = ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_workspace_archive_docKind_qualifiedField_number_tree", (q) => {
					const base = q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "value")
						.eq("qualifiedField", plan.qualifiedField)
						.eq("valueKind", "number");
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
			const treePathPrefix = args.treePathPrefix;
			if (treePathPrefix) {
				query = query.filter((q) =>
					q.and(q.gte(q.field("treePath"), treePathPrefix), q.lt(q.field("treePath"), `${treePathPrefix}\uffff`)),
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
	}
}

export const search = internalQuery({
	args: {
		// Scope accepts the reserved `/.mounts` literals so the mount-backed db-files FS can search mount metadata.
		organizationId: doc(app_convex_schema, "files_metadata_docs").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_metadata_docs").fields.workspaceId,
		userId: v.id("users"),
		plan: v.union(
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
				gte: v.optional(v.number()),
				gt: v.optional(v.number()),
				lte: v.optional(v.number()),
				lt: v.optional(v.number()),
			}),
		),
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
				valueKind: v.union(v.literal("none"), v.literal("string"), v.literal("number"), v.literal("boolean")),
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
		if (!organizations_is_global_organization_id(organizationId) && !organizations_is_global_github_workspace_id(workspaceId)) {
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
		return {
			items: result.page.map(format_search_result),
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
					valueKind: v.union(v.literal("string"), v.literal("number"), v.literal("boolean")),
					stringValue: v.optional(v.string()),
					numberValue: v.optional(v.number()),
					booleanValue: v.optional(v.boolean()),
				}),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (!fileNode || fileNode.kind !== "file") {
			return null;
		}

		let pendingUpdate: Doc<"files_pending_updates"> | null = null;
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			!organizations_is_global_github_workspace_id(args.workspaceId)
		) {
			const organizationId: Id<"organizations"> = args.organizationId;
			const workspaceId: Id<"organizations_workspaces"> = args.workspaceId;
			pendingUpdate = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("userId", args.userId)
						.eq("fileNodeId", fileNode._id),
				)
				.first();
		}

		const sourceKind = pendingUpdate ? ("pending" as const) : ("committed" as const);
		const docs = pendingUpdate
			? await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
					.collect()
			: await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_qualifiedField", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", fileNode._id),
					)
					.collect();

		return {
			path: fileNode.path,
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
