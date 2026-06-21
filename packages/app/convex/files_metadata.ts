import { paginationOptsValidator, type RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_metadata_extract_frontmatter,
	type files_metadata_SearchPlan,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";

// #region indexed doc writes

function value_insert_payload(value: files_metadata_Value) {
	switch (value.valueKind) {
		case "string":
			return {
				valueKind: "string" as const,
				stringValue: value.value,
			};
		case "number":
			return {
				valueKind: "number" as const,
				numberValue: value.value,
			};
		case "boolean":
			return {
				valueKind: "boolean" as const,
				booleanValue: value.value,
			};
	}
}

export async function files_metadata_db_delete_committed(
	ctx: MutationCtx,
	args: { workspaceId: string; projectId: string; nodeId: Id<"files_nodes"> },
) {
	const [fields, values] = await Promise.all([
		ctx.db
			.query("files_metadata_fields")
			.withIndex("by_workspace_project_source_fileNode_qualifiedField", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		ctx.db
			.query("files_metadata_values")
			.withIndex("by_workspace_project_source_fileNode_qualifiedField_valueKind", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
	]);
	await Promise.all([
		...fields.map((doc) => ctx.db.delete("files_metadata_fields", doc._id)),
		...values.map((doc) => ctx.db.delete("files_metadata_values", doc._id)),
	]);
}

export async function files_metadata_db_delete_pending(
	ctx: MutationCtx,
	args: { pendingUpdateId: Id<"files_pending_updates"> },
) {
	const [fields, values] = await Promise.all([
		ctx.db
			.query("files_metadata_fields")
			.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
		ctx.db
			.query("files_metadata_values")
			.withIndex("by_pendingUpdate_qualifiedField_valueKind", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
	]);
	await Promise.all([
		...fields.map((doc) => ctx.db.delete("files_metadata_fields", doc._id)),
		...values.map((doc) => ctx.db.delete("files_metadata_values", doc._id)),
	]);
}

export async function files_metadata_db_insert_committed(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		yjsSequence: number;
		markdownContent: string;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.workspaceId !== args.workspaceId ||
		fileNode.projectId !== args.projectId ||
		fileNode.kind !== "file"
	) {
		const errorMessage = "fileNode is missing or mismatched";
		const errorData = {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			fileNode,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const metadata = files_metadata_extract_frontmatter(args.markdownContent);
	await Promise.all([
		...metadata.fields.map((qualifiedField) =>
			ctx.db.insert("files_metadata_fields", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId: args.nodeId,
				sourceKind: "committed" as const,
				yjsSequence: args.yjsSequence,
				path: fileNode.path,
				treePath: fileNode.treePath,
				archiveOperationId: fileNode.archiveOperationId,
				qualifiedField,
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_values", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId: args.nodeId,
				sourceKind: "committed" as const,
				yjsSequence: args.yjsSequence,
				path: fileNode.path,
				treePath: fileNode.treePath,
				archiveOperationId: fileNode.archiveOperationId,
				qualifiedField: value.qualifiedField,
				...value_insert_payload(value),
			}),
		),
	]);
}

export async function files_metadata_db_replace_pending(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
		unstagedMarkdown: string;
	},
) {
	await files_metadata_db_delete_pending(ctx, { pendingUpdateId: args.pendingUpdateId });

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.workspaceId !== args.workspaceId || fileNode.projectId !== args.projectId) {
		console.error("Failed to replace pending metadata: fileNode is missing or mismatched", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			fileNode,
		});
		return;
	}

	const metadata = files_metadata_extract_frontmatter(args.unstagedMarkdown);
	await Promise.all([
		...metadata.fields.map((qualifiedField) =>
			ctx.db.insert("files_metadata_fields", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId: args.nodeId,
				sourceKind: "pending" as const,
				userId: args.userId,
				pendingUpdateId: args.pendingUpdateId,
				path: fileNode.path,
				treePath: fileNode.treePath,
				archiveOperationId: fileNode.archiveOperationId,
				qualifiedField,
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_values", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				fileNodeId: args.nodeId,
				sourceKind: "pending" as const,
				userId: args.userId,
				pendingUpdateId: args.pendingUpdateId,
				path: fileNode.path,
				treePath: fileNode.treePath,
				archiveOperationId: fileNode.archiveOperationId,
				qualifiedField: value.qualifiedField,
				...value_insert_payload(value),
			}),
		),
	]);
}

export async function files_metadata_db_patch_file_scope(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
		path?: string;
		treePath?: string;
		archiveOperationId?: string;
	},
) {
	const patch: Partial<Pick<Doc<"files_metadata_fields">, "path" | "treePath" | "archiveOperationId">> = {};
	if ("path" in args) {
		patch.path = args.path;
	}
	if ("treePath" in args) {
		patch.treePath = args.treePath;
	}
	if ("archiveOperationId" in args) {
		patch.archiveOperationId = args.archiveOperationId;
	}
	const [fields, values] = await Promise.all([
		ctx.db
			.query("files_metadata_fields")
			.withIndex("by_workspace_project_fileNode_qualifiedField", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("fileNodeId", args.nodeId),
			)
			.collect(),
		ctx.db
			.query("files_metadata_values")
			.withIndex("by_workspace_project_fileNode_qualifiedField_valueKind", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("fileNodeId", args.nodeId),
			)
			.collect(),
	]);
	await Promise.all([
		...fields.map((doc) => ctx.db.patch("files_metadata_fields", doc._id, patch)),
		...values.map((doc) => ctx.db.patch("files_metadata_values", doc._id, patch)),
	]);
}

// #endregion indexed doc writes

// #region search

function tree_path_from_path(path: string) {
	return path === "/" ? "/" : `${path.replace(/\/+$/u, "")}/`;
}

function metadata_kind_from_qualified_field(qualifiedField: string) {
	return qualifiedField.slice(0, qualifiedField.indexOf("."));
}

async function list_pending_file_node_ids(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; userId: Id<"users"> },
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_workspace_project_user_fileNode", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", args.userId),
		)
		.order("asc")
		.collect();
	return pendingUpdates.map((pendingUpdate) => pendingUpdate.fileNodeId);
}

function format_field_result(doc: Doc<"files_metadata_fields">) {
	return {
		path: doc.path,
		nodeId: doc.fileNodeId,
		qualifiedField: doc.qualifiedField,
		metadataKind: metadata_kind_from_qualified_field(doc.qualifiedField),
		sourceKind: doc.sourceKind,
		valueKind: "none" as const,
	};
}

function format_value_result(doc: Doc<"files_metadata_values">) {
	return {
		path: doc.path,
		nodeId: doc.fileNodeId,
		qualifiedField: doc.qualifiedField,
		metadataKind: metadata_kind_from_qualified_field(doc.qualifiedField),
		sourceKind: doc.sourceKind,
		valueKind: doc.valueKind,
		stringValue: doc.stringValue,
		numberValue: doc.numberValue,
		booleanValue: doc.booleanValue,
	};
}

function search_query(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
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
				.query("files_metadata_fields")
				.withIndex("by_workspace_project_archiveOperation_qualifiedField_treePath", (q) => {
					const base = q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("archiveOperationId", undefined)
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
			return { kind: "fields" as const, query };
		}
		case "eq":
			if (typeof plan.value === "string") {
				const value = plan.value;
				let query = ctx.db
					.query("files_metadata_values")
					.withIndex("by_workspace_project_archive_qualifiedField_stringValue_tree", (q) => {
						const base = q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", args.projectId)
							.eq("archiveOperationId", undefined)
							.eq("qualifiedField", plan.qualifiedField)
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
				return { kind: "values" as const, query };
			}
			if (typeof plan.value === "number") {
				const value = plan.value;
				let query = ctx.db
					.query("files_metadata_values")
					.withIndex("by_workspace_project_archive_qualifiedField_numberValue_tree", (q) => {
						const base = q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", args.projectId)
							.eq("archiveOperationId", undefined)
							.eq("qualifiedField", plan.qualifiedField)
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
				return { kind: "values" as const, query };
			}
			{
				const value = plan.value;
				let query = ctx.db
					.query("files_metadata_values")
					.withIndex("by_workspace_project_archive_qualifiedField_booleanValue_tree", (q) => {
						const base = q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", args.projectId)
							.eq("archiveOperationId", undefined)
							.eq("qualifiedField", plan.qualifiedField)
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
				return { kind: "values" as const, query };
			}
		case "prefix": {
			let query = ctx.db
				.query("files_metadata_values")
				.withIndex("by_workspace_project_archive_qualifiedField_stringValue_tree", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("archiveOperationId", undefined)
						.eq("qualifiedField", plan.qualifiedField)
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
			return { kind: "values" as const, query };
		}
		case "range": {
			let query = ctx.db
				.query("files_metadata_values")
				.withIndex("by_workspace_project_archive_qualifiedField_numberValue_tree", (q) => {
					const base = q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("archiveOperationId", undefined)
						.eq("qualifiedField", plan.qualifiedField);
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
			return { kind: "values" as const, query };
		}
	}
}

export const search = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
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
		const pendingNodeIds = await list_pending_file_node_ids(ctx, args);
		const treePathPrefix = args.pathPrefix == null ? undefined : tree_path_from_path(args.pathPrefix);
		const searchQuery = search_query(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			plan: args.plan,
			treePathPrefix,
			userId: args.userId,
			pendingNodeIds,
		});
		if (searchQuery.kind === "fields") {
			const result = await searchQuery.query.paginate({ cursor: args.cursor, numItems: args.numItems });
			return {
				items: result.page.map(format_field_result),
				continueCursor: result.continueCursor,
				isDone: result.isDone,
			};
		}
		const result = await searchQuery.query.paginate({ cursor: args.cursor, numItems: args.numItems });
		return {
			items: result.page.map(format_value_result),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_metadata_search_Result =
	typeof search extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue> ? Awaited<ReturnValue> : never;

// #endregion search

// #region get by path

export const get_by_path = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
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
			.withIndex("by_workspace_project_path_archiveOperation", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("path", args.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (!fileNode || fileNode.kind !== "file") {
			return null;
		}

		const pendingUpdate = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_workspace_project_user_fileNode", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("userId", args.userId)
					.eq("fileNodeId", fileNode._id),
			)
			.first();

		const sourceKind = pendingUpdate ? ("pending" as const) : ("committed" as const);
		const [fields, values] = await Promise.all([
			pendingUpdate
				? ctx.db
						.query("files_metadata_fields")
						.withIndex("by_pendingUpdate_qualifiedField", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
						.collect()
				: ctx.db
						.query("files_metadata_fields")
						.withIndex("by_workspace_project_source_fileNode_qualifiedField", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", fileNode._id),
						)
						.collect(),
			pendingUpdate
				? ctx.db
						.query("files_metadata_values")
						.withIndex("by_pendingUpdate_qualifiedField_valueKind", (q) => q.eq("pendingUpdateId", pendingUpdate._id))
						.collect()
				: ctx.db
						.query("files_metadata_values")
						.withIndex("by_workspace_project_source_fileNode_qualifiedField_valueKind", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", fileNode._id),
						)
						.collect(),
		]);

		return {
			path: fileNode.path,
			nodeId: fileNode._id,
			sourceKind,
			fields: fields.map((field) => field.qualifiedField),
			values: values.map((value) => ({
				qualifiedField: value.qualifiedField,
				valueKind: value.valueKind,
				stringValue: value.stringValue,
				numberValue: value.numberValue,
				booleanValue: value.booleanValue,
			})),
		};
	},
});

export type files_metadata_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion get by path
