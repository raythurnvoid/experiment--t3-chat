// Metadata writes shared by creation, the metadata doors, and access changes.

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { should_never_happen } from "../shared/shared-utils.ts";
import { convex_error } from "../server/convex-utils.ts";
import { files_metadata_maps_db_write } from "../server/files-metadata-maps.ts";
import {
	files_metadata_frontmatter_exceeds_index_caps,
	files_metadata_extract_entries,
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_preflight_frontmatter,
	files_metadata_search_values,
	files_metadata_scalar_preview,
	type files_metadata_Entry,
	type files_metadata_Value,
} from "../shared/files-metadata.ts";
import { files_sort_text_key, files_sort_value_of } from "../shared/files-sort.ts";
import { files_saved_placement_db_get_node, type files_saved_placement_FixedView } from "../server/files-saved-placement.ts";
import {
	files_pending_update_index_revision,
	type files_VisibleEntry,
} from "../shared/files.ts";

export function files_metadata_value_doc_payload(value: files_metadata_Value) {
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
export function files_metadata_committed_field_sort_fields(
	fileNode: Doc<"files_nodes">,
	fieldValues: files_metadata_Value[],
	fullValues: files_metadata_Value[] = fieldValues,
) {
	const sortValue = files_sort_value_of(fieldValues);
	const plainValues = fullValues.filter((value) => value.valueKind !== "maybe_date");
	const preview = plainValues[0] ? files_metadata_scalar_preview(plainValues[0].value) : null;
	return {
		parentId: fileNode.parentId,
		nodeKind: fileNode.kind,
		isRestrictedScopeRoot: fileNode.restrictedScopeNodeId === fileNode._id,
		name: fileNode.name,
		sortName: files_sort_text_key(fileNode.name),
		...(sortValue && preview
			? {
					sortValue: sortValue.sortValue,
					sortDisplayValue: preview.value,
					sortDisplayValueIsPreview: preview.isPreview || plainValues.length > 1,
				}
			: {}),
	};
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
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
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
		restrictedScopeNodeId: fileNode.restrictedScopeNodeId,
	};
	await Promise.all([
		...metadata.fields.map((fieldPath) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath,
				docKind: "field" as const,
				...files_metadata_committed_field_sort_fields(
					fileNode,
					metadata.values.filter((value) => value.fieldPath === fieldPath),
					preflight._yay.fullMetadata.values.filter((value) => value.fieldPath === fieldPath),
				),
			}),
		),
		...metadata.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath: value.fieldPath,
				...files_metadata_value_doc_payload(value),
			}),
		),
	]);
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
		moveView?: files_saved_placement_FixedView;
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
				.eq("moveView.cohortId", args.moveView?.cohortId)
				.eq("moveView.view", args.moveView?.view)
				.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
				.lt("fieldPath", "metadata/"),
		)
		.collect();
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
 * This writer checks the map limits. The user-facing metadata doors check the permission and the
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
	const node = "fileNode" in args ? args.fileNode : args.privateEntry.node;
	await files_metadata_maps_db_write(ctx.db, {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		owner:
			"fileNode" in args
				? { kind: "saved", id: args.fileNode._id }
				: { kind: "pending", id: args.privateEntry.pendingUpdate._id },
		entries: args.entries,
	});
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
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined)
							.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
							.lt("fieldPath", "metadata/"),
					)
					.collect();
	await Promise.all(existingDocs.map((doc) => ctx.db.delete("files_metadata_docs", doc._id)));

	const full = files_metadata_extract_entries(args.entries);
	const extracted = files_metadata_search_values(full);
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
					restrictedScopeNodeId: args.fileNode.restrictedScopeNodeId,
				}
			: {
					organizationId: args.privateEntry.node.organizationId,
					workspaceId: args.privateEntry.node.workspaceId,
					sourceKind: "pending" as const,
					target: args.privateEntry.pendingUpdate.target,
					userId: args.privateEntry.node.userId,
					pendingUpdateId: args.privateEntry.pendingUpdate._id,
					// The chunk docs keep their revision, so the new metadata docs take the same one.
					proposalRevision: files_pending_update_index_revision(args.privateEntry.pendingUpdate),
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
					? files_metadata_committed_field_sort_fields(
							args.fileNode,
							extracted.values.filter((value) => value.fieldPath === fieldPath),
							full.values.filter((value) => value.fieldPath === fieldPath),
						)
					: {}),
			}),
		),
		...extracted.values.map((value) =>
			ctx.db.insert("files_metadata_docs", {
				...scope,
				fieldPath: value.fieldPath,
				entryIndex: entryIndexByField.get(value.fieldPath),
				...files_metadata_value_doc_payload(value),
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
		fixedView?: files_saved_placement_FixedView;
		/** Written to committed field docs only, like every folder table sort field. */
		isRestrictedScopeRoot: boolean;
		/** The node's area, written to every committed doc. */
		restrictedScopeNodeId: Id<"files_nodes"> | null;
	},
) {
	// Committed metadata is bounded by its write caps. Archive and Restore copy path and archive state
	// onto these docs, and the scope op copies the area of the items inside. Each copies in the same
	// mutation as the node, or in a saved scope job when the node has many docs
	// (`files_pending_overlay_db_follow_saved_scope`).
	const docs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("fileNodeId", args.nodeId)
				.eq("moveView.cohortId", args.fixedView?.cohortId)
				.eq("moveView.view", args.fixedView?.view),
		)
		.collect();
	await Promise.all(
		docs.flatMap((doc) =>
			doc.sourceKind === "committed"
				? [
						ctx.db.patch("files_metadata_docs", doc._id, {
							restrictedScopeNodeId: args.restrictedScopeNodeId,
							...(doc.docKind === "field" ? { isRestrictedScopeRoot: args.isRestrictedScopeRoot } : {}),
						}),
					]
				: [],
		),
	);
}
