// Save a complete file in one transaction. Upload actions stay in files_nodes_content.ts.

import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import type { Doc, Id } from "./_generated/dataModel";
import type { RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import type { files_YjsRootKind } from "../server/files.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema, { files_metadata_entries_validator } from "./schema.ts";
import { doc } from "convex-helpers/validators";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { access_control_db_authorize_file_write } from "./access_control.ts";
import { files_metadata_db_insert_committed } from "./files_metadata_db.ts";
import {
	files_nodes_db_upsert_file_stats as db_upsert_file_stats,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_insert_committed_text_chunks,
	files_nodes_db_hand_unpublished_assets_to_deletion_ledger,
	files_nodes_db_finalize_editable_text_node_creation,
	files_compute_wc_counts,
} from "./files_nodes_create_db.ts";
import { files_nodes_create_db_resolve_destination } from "./files_nodes_create_preflight.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";

// Reuse the loaded module between calls. Keep request state inside each handler.
export const experimental_reuseContext = true;

export async function db_insert_file_text_content(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		/**
		 * The chunker shape for this content. This argument REPLACES the old `contentType`
		 * derivation — the branch below is exhaustive on the closed union and on nothing else, so
		 * an unrecognized content type can never reach a throw inside the infinite-retry workpool.
		 * Editable nodes read it from `files_nodes.textKind`; read-only mounts pass the
		 * `"plain_text"` literal because a mount has no Yjs document to have a shape.
		 */
		rootKind: files_YjsRootKind;
		textContent: string;
		/**
		 * Repair-only escape: commit the chunks of a text whose frontmatter is over the index
		 * caps without inserting metadata docs, so the insert helper's over-cap backstop cannot
		 * throw mid-repair. The caller keeps the frontmatter marker pair set instead.
		 */
		skipFrontmatterIndex?: boolean;
	},
) {
	const chunks =
		args.rootKind === "rich_text"
			? await files_chunk_markdown(args.textContent)
			: Result({ _yay: files_chunk_plain_text(args.textContent) });
	if (chunks._nay) {
		return chunks;
	}

	await files_nodes_db_insert_committed_text_chunks(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: args.path,
		archiveOperationId: args.archiveOperationId ?? undefined,
		yjsSequence: args.yjsSequence,
		chunks: chunks._yay,
	});

	// Frontmatter is a rich-text (Markdown) concept only: a `.yaml` opening with `---` is plain
	// text and must not be frontmatter-indexed.
	if (args.rootKind === "rich_text" && !args.skipFrontmatterIndex) {
		await files_metadata_db_insert_committed(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSequence: args.yjsSequence,
			markdownContent: args.textContent,
		});
	}

	const counts = files_compute_wc_counts(args.textContent);
	await db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		lineCount: counts.lineCount,
		wordCount: counts.wordCount,
		charCount: counts.charCount,
	});

	return Result({ _yay: null });
}

/**
 * Insert the content docs for a just-created file node, in the same mutation that inserted the
 * node (`db_insert_node` in files_nodes_create_db.ts with `expectsTextContent: true`). Read-only
 * files get committed chunks + real stats only; editable files also get their Yjs snapshot doc, the
 * last-sequence doc, and the node patch linking both. This is the former `db_insert_node` text
 * branch; it lives here because chunking needs mastra. Failures throw so Convex rolls back the
 * node and every related doc created in the mutation.
 */
export async function files_nodes_db_insert_file_content_docs(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		/**
		 * Only used for error logging when the editable content docs fail to insert.
		 */
		parentId?: Doc<"files_nodes">["parentId"];
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		contentType: Doc<"files_nodes">["contentType"];
		/**
		 * The shape of this node's text. The writable and non-collaborative branches both write it
		 * as `files_nodes.textKind`; the read-only branch ignores it, because a mount has no Yjs
		 * document and always chunks as plain text.
		 */
		rootKind: files_YjsRootKind;
		textContent: string;
		readOnly: boolean;
		/**
		 * Create the file with committed content only and no Yjs document. The caller then needs no
		 * `yjsSnapshotAssetId`, because there is no snapshot to upload.
		 */
		nonCollaborative?: boolean;
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		userId: Doc<"files_nodes">["createdBy"];
		now: number;
	},
) {
	const initialYjsSequence = 0;

	if (args.readOnly === true) {
		await db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId ?? undefined,
			// Read-only mounts chunk as plain text, to the same boundaries as before the chunker
			// dispatched on this argument. `args.rootKind` is ignored here: a mount has no Yjs
			// document to have a shape, so the literal is the mount branch's answer.
			rootKind: "plain_text",
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}

			return chunks;
		});

		return;
	}

	// Editable files need a real tenant. External content stays read-only and has no Yjs state.
	if (organizations_is_global_organization_id(args.organizationId)) {
		const errorMessage = "Editable text content requires a real organizationId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	if (scope.kind !== "workspace") {
		const errorMessage = "Editable text content requires a real workspaceId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	if (args.userId === users_SYSTEM_AUTHOR) {
		const errorMessage = "Editable text content requires a real user id";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	const workspaceId = scope.workspaceId;

	// A non-collaborative file gets committed chunks and nothing else: no Yjs snapshot, no sequence
	// doc, no update log. It still stores `textKind`, so it chunks under its real shape and a
	// Markdown file keeps its frontmatter index — unlike the read-only mount branch above, which
	// forces plain text.
	if (args.nonCollaborative === true) {
		await db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId ?? undefined,
			rootKind: args.rootKind,
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}

			return chunks;
		});

		await ctx.db.patch("files_nodes", args.nodeId, {
			textKind: args.rootKind,
			collaborationEnabled: false,
		});

		return;
	}

	if (!args.yjsSnapshotAssetId) {
		const errorMessage = "fileNode.yjsSnapshotId asset is not set";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	const yjsSnapshotAssetId = args.yjsSnapshotAssetId;

	const [yjs_snapshot_id, yjs_last_sequence_id] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId,
			fileNodeId: args.nodeId,
			sequence: 0,
			assetId: yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId,
			fileNodeId: args.nodeId,
			lastSequence: initialYjsSequence,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId ?? undefined,
			yjsSequence: initialYjsSequence,
			rootKind: args.rootKind,
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}

			return chunks;
		}),
	] as const).catch((error) => {
		const errorMessage = "Failed to create file content docs";
		console.error(errorMessage, {
			error,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			nodeId: args.nodeId,
			yjsSequence: initialYjsSequence,
		});
		// Throw so Convex rolls back the node and all related file docs created in this mutation.
		throw convex_error({
			message: errorMessage,
			cause: error,
		});
	});

	await ctx.db.patch("files_nodes", args.nodeId, {
		yjsLastSequenceId: yjs_last_sequence_id,
		yjsSnapshotId: yjs_snapshot_id,
		// Record the shape beside the other Yjs pointers, in the same mutation that created the
		// document, so the node and its document can never be born disagreeing.
		textKind: args.rootKind,
		collaborationEnabled: true,
	});
}

export const create_file_node = internalMutation({
	args: {
		userId: doc(app_convex_schema, "files_nodes").fields.createdBy,
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
		contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
		assetId: v.id("files_r2_assets"),
		yjsSnapshotAssetId: v.optional(v.id("files_r2_assets")),
		archiveOperationId: v.optional(v.string()),
		textContent: v.string(),
		/**
		 * The document shape written on the node for writable files. Read-only mount files have
		 * no Yjs document, so their callers pass the mount literal and the insert ignores it.
		 */
		rootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		readOnly: v.boolean(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
		/**
		 * Tenant assets already uploaded to R2. Add deletion jobs when this mutation refuses them.
		 */
		unpublishedAssetIds: v.optional(v.array(v.id("files_r2_assets"))),
		/**
		 * Source metadata for files created by reserved-scope mirrors.
		 */
		metadata: v.optional(files_metadata_entries_validator),
	},
	returns: v_result({
		_yay: v.object({
			nodeId: v.id("files_nodes"),
		}),
	}),
	handler: async (ctx, args) => {
		const authorUserId = args.userId === users_SYSTEM_AUTHOR ? null : args.userId;
		const authorOrganizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
		const authorWorkspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
		let authorMembership: Doc<"organizations_workspaces_users"> | null = null;

		// Reserved scopes use other cleanup and never pass tenant asset ids.
		if (args.unpublishedAssetIds && (!authorOrganizationId || !authorWorkspaceId)) {
			const errorMessage = "create_file_node unpublishedAssetIds requires a tenant scope";
			const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, path: args.path };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// The action uploaded the R2 files before this mutation.
		// If this mutation refuses them, save their deletion jobs before deleting their asset docs.
		// A later crash cannot lose those jobs.
		const refuse = async (nay: { name?: string; message: string }) => {
			if (args.unpublishedAssetIds && authorOrganizationId && authorWorkspaceId) {
				await files_nodes_db_hand_unpublished_assets_to_deletion_ledger(ctx, {
					organizationId: authorOrganizationId,
					workspaceId: authorWorkspaceId,
					assetIds: args.unpublishedAssetIds,
					reason: "read_only_create",
				});
			}
			return Result({ _nay: nay });
		};

		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return await refuse({ message: "External mount sync run requires mountId and syncRunId" });
		}
		if (args.mountId != null && args.syncRunId != null) {
			// Recheck inside the node-creation transaction. The mount may be replaced
			// after the action's first check.
			const mount = await ctx.db.get("github_mounts", args.mountId);
			if (
				!mount ||
				mount.status !== "running" ||
				mount.syncRunId !== args.syncRunId ||
				mount.pendingCommitSha == null ||
				!args.path.startsWith(`/${mount.name}/${mount.pendingCommitSha}/`)
			) {
				return await refuse({ message: "External mount sync was superseded" });
			}
		}
		// Every caller here is an action: it proved this permission in an earlier transaction and then
		// went off to write R2 objects. A role taken away in that gap would still land a file. So ask
		// again, here, in the transaction that writes. SYSTEM writes come from trusted server flows and
		// have no user to ask about.
		//
		// The reserved global scopes (mount mirrors, plugin sources) have no memberships to ask about,
		// so they are skipped here the same way the node check skips them.
		if (authorUserId && authorOrganizationId && authorWorkspaceId) {
			authorMembership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", authorUserId)
						.eq("organizationId", authorOrganizationId)
						.eq("workspaceId", authorWorkspaceId),
				)
				.first();
			if (!authorMembership) {
				return await refuse({ message: "Permission denied" });
			}

			const authorized = await access_control_db_authorize_file_write(ctx, {
				userAuth: { id: authorUserId },
				membership: authorMembership,
				nodeId: args.parentId,
			});
			if (authorized._nay) {
				return await refuse({ message: "Permission denied" });
			}
		}

		// Check the current destination again before the first insert.
		if (args.unpublishedAssetIds && authorOrganizationId && authorWorkspaceId) {
			const destination = await files_nodes_create_db_resolve_destination(ctx, {
				organizationId: authorOrganizationId,
				workspaceId: authorWorkspaceId,
				parentId: args.parentId,
				path: args.path,
			});
			if (!destination) {
				return await refuse({ message: "Not found" });
			}

			// Check access on every existing path part again.
			// A path part may have become restricted during the upload. Refuse with "Permission denied".
			if (!authorUserId || !authorMembership) {
				return await refuse({ message: "Permission denied" });
			}
			for (const prefixPath of destination.prefixPaths) {
				const segment = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", authorOrganizationId)
							.eq("workspaceId", authorWorkspaceId).eq("moveCohortId", undefined)
							.eq("path", prefixPath)
							.eq("archiveOperationId", null),
					)
					.first();
				if (!segment) {
					break;
				}
				const segmentAuthorized = await access_control_db_authorize_file_write(ctx, {
					userAuth: { id: authorUserId },
					membership: authorMembership,
					nodeId: segment._id,
				});
				if (segmentAuthorized._nay) {
					return await refuse({ message: "Permission denied" });
				}
			}

			const anchorWritable =
				destination.anchorNode === null
					? Result({ _yay: null })
					: await files_nodes_db_require_user_writable(ctx, { node: destination.anchorNode, userId: authorUserId });
			if (anchorWritable._nay) {
				return await refuse(anchorWritable._nay);
			}

			// A normal create needs an empty target path.
			// An archived replacement may share its path with an active node.
			if (destination.targetNode !== null && args.archiveOperationId === undefined) {
				return await refuse({ name: "nay", message: "This file already exists." });
			}
		}

		const now = Date.now();
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			path: args.path,
			kind: "file",
			contentType: args.contentType,
			assetId: args.assetId,
			archiveOperationId: args.archiveOperationId ?? undefined,
			expectsTextContent: true,
			metadata: args.metadata,
			now,
		});
		// The walk finds any conflict, access error, or lock before its first insert.
		// The refusal cannot leave part of a new folder tree behind.
		if (nodeIdResult._nay) {
			return await refuse(nodeIdResult._nay);
		}

		// The leaf's stored path can differ from `args.path` (segments resolved under `parentId`),
		// so read it back from the created node before inserting the content docs.
		const insertedNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
		if (!insertedNode) {
			const errorMessage = "created file node is missing right after insert";
			const errorData = { nodeId: nodeIdResult._yay };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// Same mutation as the node insert: a content-docs failure throws and rolls back the node.
		await files_nodes_db_insert_file_content_docs(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: insertedNode._id,
			path: insertedNode.path,
			parentId: args.parentId,
			archiveOperationId: insertedNode.archiveOperationId ?? undefined,
			contentType: args.contentType,
			rootKind: args.rootKind,
			textContent: args.textContent,
			readOnly: args.readOnly,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			userId: args.userId,
			now,
		});

		// Publish all editable-file data in the same transaction that creates the node.
		// A crash leaves either no file or one complete file with its first version snapshot.
		if (!args.readOnly) {
			if (!args.yjsSnapshotAssetId || !authorOrganizationId || !authorWorkspaceId || !authorUserId) {
				const errorMessage = "Editable file creation requires tenant asset ids and author";
				const errorData = { nodeId: insertedNode._id, yjsSnapshotAssetId: args.yjsSnapshotAssetId };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			const [yjsSnapshotAsset, versionSnapshotAsset] = await Promise.all([
				ctx.db.get("files_r2_assets", args.yjsSnapshotAssetId),
				ctx.db.get("files_r2_assets", args.assetId),
			]);
			if (!yjsSnapshotAsset || !versionSnapshotAsset) {
				const errorMessage = "Editable file creation asset id points to a missing files_r2_assets doc";
				const errorData = {
					nodeId: insertedNode._id,
					yjsSnapshotAssetId: args.yjsSnapshotAssetId,
					versionSnapshotAssetId: args.assetId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			await files_nodes_db_finalize_editable_text_node_creation(ctx, {
				organizationId: authorOrganizationId,
				workspaceId: authorWorkspaceId,
				nodeId: insertedNode._id,
				userId: authorUserId,
				yjsSnapshot: { assetId: args.yjsSnapshotAssetId, size: yjsSnapshotAsset.size },
				versionSnapshotAssetId: args.assetId,
				versionSnapshotSize: versionSnapshotAsset.size,
			});
		}

		return Result({
			_yay: {
				nodeId: nodeIdResult._yay,
			},
		});
	},
});

export type files_nodes_create_Result =
	typeof create_file_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
