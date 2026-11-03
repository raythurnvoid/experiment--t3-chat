import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalQuery } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_nodes_db_require_read_only_management } from "./files_write_policy_db.ts";
import { files_nodes_db_archive_nodes, files_nodes_db_set_read_only } from "./files_nodes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import {
	plugins_external_files_db_authorize,
	plugins_external_files_db_content_revision,
	plugins_external_files_db_check_write,
} from "./plugins_external_files_access.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { public_api_file_archives_db_check_node } from "./public_api_file_archives.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { server_path_parent_of } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

export const check_public_request = internalQuery({
	args: {
		writerId: v.optional(v.string()),
		nodeIds: v.optional(v.array(v.string())),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		if (
			(args.writerId !== undefined && ctx.db.normalizeId("plugins_external_file_writers", args.writerId) === null) ||
			args.nodeIds?.some((id) => ctx.db.normalizeId("files_nodes", id) === null)
		)
			return Result({ _nay: { name: "invalid_input", message: "Invalid file operation ID" } });

		return Result({ _yay: null });
	},
});

export const ensure_writer = internalMutation({
	args: {
		grantId: v.id("plugin_service_grants"),
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		resourceKey: v.string(),
		rootNodeId: v.union(v.id("files_nodes"), v.null()),
		path: v.string(),
		readOnly: v.boolean(),
		force: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.object({
			writerId: v.id("plugins_external_file_writers"),
			rootNodeId: v.id("files_nodes"),
			folderNodeId: v.id("files_nodes"),
			writerGeneration: v.number(),
			created: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const grant = await ctx.db.get("plugin_service_grants", args.grantId);
		if (!grant) return Result({ _nay: { message: "Unauthenticated" } });

		const existing = await ctx.db
			.query("plugins_external_file_writers")
			.withIndex("by_installation_resourceKey", (q) =>
				q.eq("installationId", grant.installationId).eq("resourceKey", args.resourceKey),
			)
			.first();

		const facts = await plugins_external_files_db_authorize(ctx, {
			...args,
			allowSealRoot: true,
			requestReadOnly: args.readOnly,
		});
		if (facts._nay) return facts;

		const { installation, serviceGrant, writeContext } = facts._yay;

		const rootPath = serviceGrant.destinationPathPrefix!;
		if (existing) {
			const root = await files_saved_placement_db_get_node(ctx.db, existing.rootNodeId);
			if (
				existing.installationId !== installation._id ||
				existing.path !== args.path ||
				existing.rootPath !== rootPath ||
				(args.rootNodeId !== null && existing.rootNodeId !== args.rootNodeId) ||
				(args.rootNodeId === null && existing.folderNodeId !== existing.rootNodeId) ||
				facts._yay.node?._id !== existing.folderNodeId ||
				!root ||
				root.path !== rootPath ||
				root.archiveOperationId !== null
			) {
				return Result({ _nay: { name: "stale_write", message: "The output folder changed" } });
			}

			return Result({
				_yay: {
					writerId: existing._id,
					rootNodeId: existing.rootNodeId,
					folderNodeId: existing.folderNodeId,
					writerGeneration: existing.generation,
					created: false,
				},
			});
		}

		if (args.rootNodeId === null) {
			if (args.path !== rootPath || facts._yay.node) {
				return Result({ _nay: { name: "stale_write", message: "The output root is already used" } });
			}
		} else {
			const root = await files_saved_placement_db_get_node(ctx.db, args.rootNodeId);
			if (
				!root ||
				root.kind !== "folder" ||
				root.organizationId !== installation.organizationId ||
				root.workspaceId !== installation.workspaceId ||
				root.path !== rootPath ||
				root.archiveOperationId !== null ||
				(await files_metadata_db_read_entry(ctx, {
					organizationId: installation.organizationId,
					workspaceId: installation.workspaceId,
					fileNodeId: root._id,
					key: "plugin-name",
				})) !== installation.pluginName
			) {
				return Result({ _nay: { name: "stale_write", message: "The output root changed" } });
			}
		}
		if (facts._yay.node && facts._yay.node._id !== args.rootNodeId) {
			return Result({ _nay: { name: "stale_write", message: "The output folder is already used" } });
		}

		if (args.readOnly) {
			const managed = await files_nodes_db_require_read_only_management(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				writeContext,
				target: facts._yay.node
					? { kind: "node", node: facts._yay.node }
					: { kind: "create", parentNode: facts._yay.parentNode, path: args.path },
			});
			if (managed._nay) return managed;
		}

		// A new folder is a regular folder: it gets its parent's access, like a folder a member creates.
		let nodeId = facts._yay.node?._id;
		if (!nodeId) {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				userId: serviceGrant.actorUserId,
				parentId: files_ROOT_ID,
				path: args.path,
				kind: "folder",
				writeContext,
				readOnly: args.readOnly,
				createdNodesMetadata: [
					{ key: "source", value: "plugin" },
					{ key: "plugin-name", value: installation.pluginName },
				],
				now: Date.now(),
			});
			if (created._nay) return created;
			nodeId = created._yay;
		}

		const rootNodeId = args.rootNodeId ?? nodeId;
		const writerId = await ctx.db.insert("plugins_external_file_writers", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: installation._id,
			resourceKey: args.resourceKey,
			rootNodeId,
			folderNodeId: nodeId,
			rootPath,
			path: args.path,
			generation: 1,
			updatedAt: Date.now(),
		});

		return Result({
			_yay: {
				writerId,
				rootNodeId,
				folderNodeId: nodeId,
				writerGeneration: 1,
				created: !facts._yay.node,
			},
		});
	},
});

export const inspect = internalQuery({
	args: {
		grantId: v.id("plugin_service_grants"),
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		writerId: v.id("plugins_external_file_writers"),
		path: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			writer: doc(app_convex_schema, "plugins_external_file_writers"),
			node: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
			contentRevision: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const facts = await plugins_external_files_db_authorize(ctx, { ...args, allowSealRoot: true });
		if (facts._nay) return facts;

		if (
			facts._yay.node &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: facts._yay.installation.organizationId,
				workspaceId: facts._yay.installation.workspaceId,
				subject: facts._yay.writeContext.subject,
				fileNode: facts._yay.node,
				permission: "content.read",
			}))
		)
			return Result({ _nay: { message: "Permission denied" } });

		const writer = await ctx.db.get("plugins_external_file_writers", args.writerId);
		if (
			!writer ||
			writer.installationId !== facts._yay.installation._id ||
			!(args.path === writer.path || server_path_parent_of(args.path) === writer.path)
		)
			return Result({ _nay: { message: "Permission denied" } });
		const [root, folder] = await Promise.all([
			files_saved_placement_db_get_node(ctx.db, writer.rootNodeId),
			files_saved_placement_db_get_node(ctx.db, writer.folderNodeId),
		]);
		if (
			!root ||
			root.path !== writer.rootPath ||
			root.archiveOperationId !== null ||
			!folder ||
			folder.path !== writer.path ||
			folder.archiveOperationId !== null
		) {
			return Result({ _nay: { name: "stale_write", message: "The output folder changed" } });
		}

		return Result({
			_yay: {
				writer,
				node: facts._yay.node,
				contentRevision: facts._yay.node
					? await plugins_external_files_db_content_revision(ctx, facts._yay.node)
					: null,
			},
		});
	},
});

export const get_write_receipt = internalQuery({
	args: {
		grantId: v.id("plugin_service_grants"),
		path: v.string(),
		expectedParentNodeId: v.id("files_nodes"),
		write: doc(app_convex_schema, "public_api_file_write_stages").fields.externalFileWrite,
	},
	returns: v_result({ _yay: v.union(doc(app_convex_schema, "plugins_external_file_receipts"), v.null()) }),
	handler: async (ctx, args) => {
		if (!args.write) return Result({ _nay: { message: "Permission denied" } });

		const checked = await plugins_external_files_db_check_write(ctx, { ...args, write: args.write });
		if (checked._nay) return checked;

		return Result({ _yay: checked._yay.receipt });
	},
});

export const change_scope = internalMutation({
	args: {
		grantId: v.id("plugin_service_grants"),
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		writerId: v.id("plugins_external_file_writers"),
		operationId: v.string(),
		writerGeneration: v.number(),
		force: v.optional(v.boolean()),
		expectedPath: v.optional(v.string()),
		change: v.union(
			v.object({ kind: v.literal("fence"), nextGeneration: v.number() }),
			v.object({ kind: v.literal("read_only"), readOnly: v.boolean() }),
			v.object({
				kind: v.literal("archive"),
				path: v.string(),
				nodeId: v.id("files_nodes"),
				sequence: v.number(),
				expectedContentRevision: v.optional(v.string()),
			}),
		),
	},
	returns: v_result({ _yay: doc(app_convex_schema, "plugins_external_file_receipts") }),
	handler: async (ctx, args) => {
		const writer = await ctx.db.get("plugins_external_file_writers", args.writerId);
		if (!writer) return Result({ _nay: { message: "Permission denied" } });

		const path = args.change.kind === "archive" ? args.change.path : writer.path;
		const existing = await ctx.db
			.query("plugins_external_file_receipts")
			.withIndex("by_writer_operationId", (q) => q.eq("writerId", writer._id).eq("operationId", args.operationId))
			.first();
		const facts = await plugins_external_files_db_authorize(ctx, {
			...args,
			path,
			allowSealRoot: true,
			exactNodeId: args.change.kind === "archive" ? args.change.nodeId : undefined,
			requestReadOnly: args.change.kind === "read_only",
		});
		if (facts._nay) return facts;

		if (
			writer.installationId !== facts._yay.installation._id ||
			(args.expectedPath !== undefined && args.expectedPath !== writer.path) ||
			!(path === writer.path || server_path_parent_of(path) === writer.path)
		)
			return Result({ _nay: { message: "Permission denied" } });

		const [root, folder] = await Promise.all([
			files_saved_placement_db_get_node(ctx.db, writer.rootNodeId),
			files_saved_placement_db_get_node(ctx.db, writer.folderNodeId),
		]);
		if (
			!root ||
			root.path !== writer.rootPath ||
			root.archiveOperationId !== null ||
			!folder ||
			folder.path !== writer.path ||
			folder.archiveOperationId !== null
		) {
			return Result({ _nay: { name: "stale_write", message: "The output folder changed" } });
		}

		if (args.change.kind === "archive") {
			const node = facts._yay.node;
			if (!node || node.kind !== "file" || node._id === writer.rootNodeId || node.parentId !== folder._id)
				return Result({ _nay: { name: "stale_write", message: "The file changed" } });
		}

		const fingerprint = JSON.stringify([args.writerGeneration, args.change, ...(args.force === true ? [true] : [])]);
		// A retry is accepted only when it repeats the original operation and payload exactly.
		if (existing)
			return existing.operation === args.change.kind && existing.fingerprint === fingerprint
				? Result({ _yay: existing })
				: Result({ _nay: { name: "stale_write", message: "This operation was already used" } });

		if (writer.generation !== args.writerGeneration)
			return Result({ _nay: { name: "stale_write", message: "The file writer changed" } });

		let generation = writer.generation;
		let nodeId = folder._id;
		if (args.change.kind === "fence") {
			if (!Number.isSafeInteger(args.change.nextGeneration) || args.change.nextGeneration !== generation + 1) {
				return Result({ _nay: { name: "stale_write", message: "The next writer generation is invalid" } });
			}
			generation = args.change.nextGeneration;
			await ctx.db.patch("plugins_external_file_writers", writer._id, { generation, updatedAt: Date.now() });
		} else if (args.change.kind === "read_only") {
			const changed = await files_nodes_db_set_read_only(ctx, {
				node: folder,
				writeContext: facts._yay.writeContext,
				readOnly: args.change.readOnly,
			});
			if (changed._nay) return changed;
		} else {
			const node = facts._yay.node!;
			if (
				args.change.expectedContentRevision !== undefined &&
				(await plugins_external_files_db_content_revision(ctx, node)) !== args.change.expectedContentRevision
			)
				return Result({ _nay: { name: "stale_write", message: "The file changed" } });

			// Sequences only order writes inside one writer generation; a new generation restarts them.
			const latest = await ctx.db
				.query("plugins_external_file_receipts")
				.withIndex("by_writer_path_writerGeneration_sequence", (q) =>
					q.eq("writerId", writer._id).eq("path", path).eq("writerGeneration", writer.generation),
				)
				.order("desc")
				.first();
			if (latest && latest.sequence >= args.change.sequence) {
				return Result({ _nay: { name: "stale_write", message: "A newer file write already exists" } });
			}

			nodeId = node._id;
			if (node.archiveOperationId === null) {
				const writable = await public_api_file_archives_db_check_node(ctx, {
					node,
					writeContext: facts._yay.writeContext,
				});
				if (writable._nay) return writable;
			}
			// An earlier Files archive already did the work. Keep its identity and dates.
			if (node.archiveOperationId === null)
				await files_nodes_db_archive_nodes({
					ctx,
					nodeIds: [nodeId],
					updatedBy: facts._yay.serviceGrant.actorUserId,
					now: Date.now(),
				});
		}

		const id = await ctx.db.insert("plugins_external_file_receipts", {
			organizationId: writer.organizationId,
			workspaceId: writer.workspaceId,
			installationId: writer.installationId,
			writerId: writer._id,
			operationId: args.operationId,
			operation: args.change.kind,
			fingerprint,
			path,
			sequence: args.change.kind === "archive" ? args.change.sequence : 0,
			writerGeneration: generation,
			nodeId,
			contentRevision: null,
			createdAt: Date.now(),
		});

		return Result({ _yay: (await ctx.db.get("plugins_external_file_receipts", id))! });
	},
});
