import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import app_convex_schema from "./schema.ts";
import {
	access_control_db_authorize_service_account_grant,
	access_control_db_can_act_on_file_node,
	access_control_db_set_service_account_grant,
} from "./access_control.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import {
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_require_write_policy_management,
	files_nodes_db_cascade_restricted_scope,
	files_nodes_db_archive_nodes,
} from "./files_nodes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import {
	plugins_external_files_db_authorize,
	plugins_external_files_db_content_revision,
	plugins_external_files_db_check_write,
} from "./plugins_external_files_access.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { server_path_parent_of } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

const MAX_READERS = 50;

export async function plugins_external_files_db_replace_readers(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		nodeId: Id<"files_nodes">;
		readers: { userId: Id<"users">; membershipLifetime: number }[];
	},
) {
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.installation.organizationId)
				.eq("workspaceId", args.installation.workspaceId)
				.eq("resourceKind", "file")
				.eq("resourceId", String(args.nodeId)),
		)
		.take(151);
	for (const grant of existing) {
		if (grant.principalKind !== "service_account") await ctx.db.delete("access_control_permission_grants", grant._id);
	}
	for (const { userId, membershipLifetime } of args.readers) {
		const membership = await organizations_membership_lifetimes_db_get(ctx, {
			workspaceId: args.installation.workspaceId,
			userId,
		});
		if (!membership?.active || membership.lifetime !== membershipLifetime)
			throw convex_error({ message: "The file readers changed" });
		await ctx.db.insert("access_control_permission_grants", {
			organizationId: args.installation.organizationId,
			workspaceId: args.installation.workspaceId,
			resourceKind: "file",
			resourceId: String(args.nodeId),
			principalKind: "user",
			userId,
			externalPluginMembershipLifetime: membership.lifetime,
			permission: "content.read",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	}
	return existing.flatMap((grant) =>
		grant.principalKind === "user" && grant.userId && grant.externalPluginMembershipLifetime !== undefined
			? [{ userId: grant.userId, membershipLifetime: grant.externalPluginMembershipLifetime }]
			: [],
	);
}

export const check_public_request = internalQuery({
	args: {
		writerId: v.optional(v.string()),
		nodeIds: v.optional(v.array(v.string())),
		userIds: v.optional(v.array(v.string())),
		receiptId: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		if (
			(args.writerId !== undefined && ctx.db.normalizeId("plugins_external_file_writers", args.writerId) === null) ||
			(args.receiptId !== undefined && ctx.db.normalizeId("plugins_external_file_receipts", args.receiptId) === null) ||
			args.nodeIds?.some((id) => ctx.db.normalizeId("files_nodes", id) === null) ||
			args.userIds?.some((id) => ctx.db.normalizeId("users", id) === null)
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
		readers: v.optional(v.array(v.object({ userId: v.id("users"), membershipLifetime: v.number() }))),
		readOnly: v.boolean(),
	},
	returns: v_result({
		_yay: v.object({
			writerId: v.id("plugins_external_file_writers"),
			rootNodeId: v.id("files_nodes"),
			folderNodeId: v.id("files_nodes"),
			writerGeneration: v.number(),
			readerRevision: v.union(v.number(), v.null()),
			detached: v.boolean(),
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
			recoverEmptySetup: existing ? { writerId: existing._id } : undefined,
		});
		if (facts._nay) return facts;

		const { installation, serviceGrant, writeContext } = facts._yay;
		if (
			args.readers &&
			(args.readers.length > MAX_READERS ||
				new Set(args.readers.map((reader) => reader.userId)).size !== args.readers.length)
		) {
			return Result({ _nay: { message: "Invalid file readers" } });
		}

		const rootPath = serviceGrant.destinationPathPrefix!;
		if (existing) {
			const binding = await ctx.db
				.query("plugins_external_file_bindings")
				.withIndex("by_writer", (q) => q.eq("writerId", existing._id))
				.first();
			const root = await ctx.db.get("files_nodes", existing.rootNodeId);
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
					readerRevision: binding?.revision ?? null,
					detached: binding?.detachedAt != null,
					created: false,
				},
			});
		}

		if (args.rootNodeId === null) {
			if (args.path !== rootPath || facts._yay.node) {
				return Result({ _nay: { name: "stale_write", message: "The output root is already used" } });
			}
		} else {
			const root = await ctx.db.get("files_nodes", args.rootNodeId);
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
		if (facts._yay.node && (args.readers || facts._yay.node._id !== args.rootNodeId)) {
			return Result({ _nay: { name: "stale_write", message: "The output folder is already used" } });
		}

		if (args.readOnly || args.readers) {
			if (!installation.acceptedCapabilities.includes("workspace.files.own-access"))
				return Result({ _nay: { message: "Permission denied" } });
			const managed = await files_nodes_db_require_write_policy_management(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				writeContext,
				target: facts._yay.node
					? { kind: "node", node: facts._yay.node }
					: { kind: "create", parentNode: facts._yay.parentNode, path: args.path },
				writePolicy: args.readOnly ? { mode: "writer", writer: writeContext.writer } : null,
			});
			if (managed._nay) return managed;
		}

		if (args.readers) {
			const parent = facts._yay.parentNode;
			const allowed = await access_control_db_authorize_service_account_grant(ctx, {
				userAuth: { id: serviceGrant.actorUserId },
				membership: facts._yay.membership,
				resource: parent ? { kind: "file", nodeId: parent.restrictedScopeNodeId ?? parent._id } : { kind: "workspace" },
				level: "manage",
			});
			if (allowed._nay) return Result({ _nay: { message: "Permission denied" } });
		}

		for (const { userId, membershipLifetime } of args.readers ?? []) {
			const membership = await organizations_membership_lifetimes_db_get(ctx, {
				workspaceId: installation.workspaceId,
				userId,
			});
			if (!membership?.active || membership.lifetime !== membershipLifetime)
				return Result({ _nay: { message: "The file readers changed" } });
		}

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
				writePolicy: args.readOnly ? { mode: "writer", writer: writeContext.writer } : undefined,
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

		if (args.readers) {
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await files_nodes_db_cascade_restricted_scope(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				parentId: nodeId,
				scopeNodeId: nodeId,
			});
			await plugins_external_files_db_replace_readers(ctx, { installation, nodeId, readers: args.readers });
			await ctx.db.insert("plugins_external_file_bindings", {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				installationId: installation._id,
				writerId,
				nodeId,
				revision: 1,
				detachedAt: null,
				updatedAt: Date.now(),
			});

			// The new private scope stops inheriting account access. Keep the authorized writer usable.
			const granted = await access_control_db_set_service_account_grant(ctx, {
				organizationId: installation.organizationId,
				workspaceId: installation.workspaceId,
				serviceAccountId: serviceGrant.serviceAccountId,
				resource: { kind: "file", nodeId },
				level: "manage",
			});
			if (granted._nay) throw convex_error(granted._nay);
		}

		return Result({
			_yay: {
				writerId,
				rootNodeId,
				folderNodeId: nodeId,
				writerGeneration: 1,
				readerRevision: args.readers ? 1 : null,
				detached: false,
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
			readerRevision: v.union(v.number(), v.null()),
			detached: v.boolean(),
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
				userId: facts._yay.serviceGrant.actorUserId,
				serviceAccountId: facts._yay.serviceGrant.serviceAccountId,
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
		const [root, folder, binding] = await Promise.all([
			ctx.db.get("files_nodes", writer.rootNodeId),
			ctx.db.get("files_nodes", writer.folderNodeId),
			ctx.db
				.query("plugins_external_file_bindings")
				.withIndex("by_writer", (q) => q.eq("writerId", writer._id))
				.first(),
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
				readerRevision: binding?.revision ?? null,
				detached: binding?.detachedAt != null,
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
		expectedPath: v.optional(v.string()),
		change: v.union(
			v.object({ kind: v.literal("fence"), nextGeneration: v.number() }),
			v.object({
				kind: v.literal("readers"),
				expectedReaderRevision: v.number(),
				readers: v.array(v.object({ userId: v.id("users"), membershipLifetime: v.number() })),
			}),
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
		});
		if (facts._nay) return facts;
		if (
			writer.installationId !== facts._yay.installation._id ||
			(args.expectedPath !== undefined && args.expectedPath !== writer.path) ||
			!(path === writer.path || server_path_parent_of(path) === writer.path)
		)
			return Result({ _nay: { message: "Permission denied" } });
		const [root, folder, binding] = await Promise.all([
			ctx.db.get("files_nodes", writer.rootNodeId),
			ctx.db.get("files_nodes", writer.folderNodeId),
			ctx.db
				.query("plugins_external_file_bindings")
				.withIndex("by_writer", (q) => q.eq("writerId", writer._id))
				.first(),
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
		const fingerprint = JSON.stringify([args.writerGeneration, args.change]);
		if (existing)
			return existing.operation === args.change.kind && existing.fingerprint === fingerprint
				? Result({ _yay: existing })
				: Result({ _nay: { name: "stale_write", message: "This operation was already used" } });
		if (writer.generation !== args.writerGeneration)
			return Result({ _nay: { name: "stale_write", message: "The file writer changed" } });
		let readerRevision = binding?.revision ?? null;
		let previousReaders: { userId: Id<"users">; membershipLifetime: number }[] | null = null;
		let generation = writer.generation;
		let nodeId = folder._id;
		if (args.change.kind === "fence") {
			if (!Number.isSafeInteger(args.change.nextGeneration) || args.change.nextGeneration !== generation + 1) {
				return Result({ _nay: { name: "stale_write", message: "The next writer generation is invalid" } });
			}
			generation = args.change.nextGeneration;
			await ctx.db.patch("plugins_external_file_writers", writer._id, { generation, updatedAt: Date.now() });
		} else if (args.change.kind === "readers") {
			if (!binding || binding.detachedAt !== null || binding.revision !== args.change.expectedReaderRevision) {
				return Result({ _nay: { name: "stale_write", message: "The file reader binding changed" } });
			}
			if (
				!facts._yay.installation.acceptedCapabilities.includes("workspace.files.own-access") ||
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: writer.organizationId,
					workspaceId: writer.workspaceId,
					userId: facts._yay.serviceGrant.actorUserId,
					serviceAccountId: facts._yay.serviceGrant.serviceAccountId,
					fileNode: folder,
					permission: "content.permissions.manage",
				}))
			)
				return Result({ _nay: { message: "Permission denied" } });
			if (
				args.change.readers.length > MAX_READERS ||
				new Set(args.change.readers.map((reader) => reader.userId)).size !== args.change.readers.length
			) {
				return Result({ _nay: { message: "Invalid file readers" } });
			}
			for (const reader of args.change.readers) {
				const membership = await organizations_membership_lifetimes_db_get(ctx, {
					workspaceId: writer.workspaceId,
					userId: reader.userId,
				});
				if (!membership?.active || membership.lifetime !== reader.membershipLifetime)
					return Result({ _nay: { name: "stale_write", message: "The file readers changed" } });
			}
			previousReaders = await plugins_external_files_db_replace_readers(ctx, {
				installation: facts._yay.installation,
				nodeId: folder._id,
				readers: args.change.readers,
			});
			readerRevision = binding.revision + 1;
			await ctx.db.patch("plugins_external_file_bindings", binding._id, {
				revision: readerRevision,
				updatedAt: Date.now(),
			});
		} else {
			const node = facts._yay.node!;
			if (
				args.change.expectedContentRevision !== undefined &&
				(await plugins_external_files_db_content_revision(ctx, node)) !== args.change.expectedContentRevision
			)
				return Result({ _nay: { name: "stale_write", message: "The file changed" } });
			if (binding?.detachedAt != null)
				return Result({ _nay: { name: "stale_write", message: "The file readers are managed in Files" } });
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
			// An earlier Files archive already did the work. Keep its identity and dates.
			if (node.archiveOperationId === null)
				await files_nodes_db_archive_nodes(ctx, {
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
			readerRevision,
			createdAt: Date.now(),
		});
		if (args.change.kind === "readers" && previousReaders !== null) {
			await ctx.db.insert("plugins_external_file_reader_changes", {
				organizationId: writer.organizationId,
				workspaceId: writer.workspaceId,
				installationId: writer.installationId,
				writerId: writer._id,
				receiptId: id,
				grantId: args.grantId,
				tokenHash: args.tokenHash,
				pluginVersionId: facts._yay.serviceGrant.pluginVersionId,
				serviceAccountId: facts._yay.serviceGrant.serviceAccountId,
				actorUserId: facts._yay.serviceGrant.actorUserId,
				previousReaders,
				nextReaders: args.change.readers,
				rollbackReceiptId: null,
			});
		}
		return Result({ _yay: (await ctx.db.get("plugins_external_file_receipts", id))! });
	},
});
