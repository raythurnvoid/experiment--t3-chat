import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { access_control_db_can_act_on_file_node, access_control_db_has_permission } from "./access_control.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import { files_nodes_db_require_writable, type files_nodes_WriteContext } from "./files_nodes.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import { crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { server_path_parent_of } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

export async function plugins_external_files_db_get_node(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; path: string },
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", null),
		)
		.first();
}

export async function plugins_external_files_db_authorize(
	ctx: QueryCtx,
	args: {
		grantId: Id<"plugin_service_grants">;
		tokenHash: string;
		serviceSecretHash: string;
		path: string;
		allowSealRoot?: boolean;
		exactNodeId?: Id<"files_nodes">;
		recoverEmptySetup?: { datasetGeneration: string; channelId: string; rootPath: string };
	},
) {
	const now = Date.now();
	const grant = await ctx.db.get("plugin_service_grants", args.grantId);
	if (
		!grant ||
		grant.revokedAt != null ||
		grant.expiresAt <= now ||
		grant.phase !== "processing" ||
		!grant.scopes.includes("files:write") ||
		!grant.destinationPathPrefix ||
		!crypto_timing_safe_equal(grant.tokenHash, args.tokenHash)
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const [installation, workspace, actor, registration] = await Promise.all([
		ctx.db.get("plugins_workspace_installations", grant.installationId),
		ctx.db.get("organizations_workspaces", grant.workspaceId),
		ctx.db.get("users", grant.actorUserId),
		ctx.db
			.query("plugins_service_registrations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", grant.pluginName))
			.first(),
	]);
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== grant.pluginVersionId ||
		installation.organizationId !== grant.organizationId ||
		installation.workspaceId !== grant.workspaceId ||
		!workspace ||
		workspace.organizationId !== grant.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!actor ||
		actor.deletedAt != null ||
		!registration ||
		!registration.scopes.includes("files:write") ||
		!crypto_timing_safe_equal(registration.exchangeSecretHash, args.serviceSecretHash) ||
		!(await plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: grant.serviceAccountId }))
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	if (
		!["plugin.service.connect", "workspace.files.write", "workspace.files.own-write"].every((capability) =>
			installation.acceptedCapabilities.some((accepted) => accepted === capability),
		)
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	if (
		!(
			args.path.startsWith(`${grant.destinationPathPrefix}/`) ||
			(args.allowSealRoot && args.path === grant.destinationPathPrefix)
		)
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", grant.actorUserId)
				.eq("organizationId", grant.organizationId)
				.eq("workspaceId", grant.workspaceId),
		)
		.first();
	if (!membership) return Result({ _nay: { message: "Permission denied" } });

	const scope = { organizationId: grant.organizationId, workspaceId: grant.workspaceId };
	// Archive uses the saved node, even when another active item now uses its old path.
	const node = args.exactNodeId
		? await ctx.db.get("files_nodes", args.exactNodeId)
		: await plugins_external_files_db_get_node(ctx, { ...scope, path: args.path });
	if (
		node &&
		(node.organizationId !== grant.organizationId || node.workspaceId !== grant.workspaceId || node.path !== args.path)
	)
		return Result({ _nay: { message: "Permission denied" } });
	let parentPath = server_path_parent_of(args.path);
	let parentNode: Doc<"files_nodes"> | null = null;
	while (parentPath !== "/") {
		parentNode = await plugins_external_files_db_get_node(ctx, { ...scope, path: parentPath });
		if (parentNode) break;
		parentPath = server_path_parent_of(parentPath);
	}
	const aclNode = node ?? parentNode;
	if (
		aclNode &&
		(await files_metadata_db_read_entry(ctx, {
			...scope,
			fileNodeId: aclNode._id,
			key: "plugin-name",
		})) !== installation.pluginName
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	const writeContext: files_nodes_WriteContext = {
		writer: { kind: "service_account", serviceAccountId: grant.serviceAccountId },
		actorUserId: grant.actorUserId,
		policyReach: "ancestors",
		resourceScope: node
			? { kind: node.kind === "folder" ? "subtree" : "node", nodeId: node._id }
			: { kind: "create", parentNodeId: parentNode?._id ?? files_ROOT_ID, path: args.path },
	};
	if (args.recoverEmptySetup && node?.kind === "folder" && node.restrictedScopeNodeId === node._id) {
		const setup = args.recoverEmptySetup;
		const writer = await ctx.db
			.query("plugins_external_file_writers")
			.withIndex("by_installation_datasetGeneration_channelId", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("datasetGeneration", setup.datasetGeneration)
					.eq("channelId", setup.channelId),
			)
			.first();
		if (
			writer &&
			writer.folderNodeId === node._id &&
			writer.path === args.path &&
			writer.rootPath === setup.rootPath &&
			setup.rootPath === grant.destinationPathPrefix &&
			setup.channelId !== "__root"
		) {
			const [root, binding, child] = await Promise.all([
				ctx.db.get("files_nodes", writer.rootNodeId),
				ctx.db
					.query("plugins_external_file_bindings")
					.withIndex("by_writer", (q) => q.eq("writerId", writer._id))
					.first(),
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q.eq("organizationId", grant.organizationId).eq("workspaceId", grant.workspaceId).eq("parentId", node._id),
					)
					.first(),
			]);
			if (
				root?.kind === "folder" &&
				root.path === setup.rootPath &&
				root.archiveOperationId === null &&
				binding?.nodeId === node._id &&
				binding.detachedAt === null &&
				!child &&
				(await files_metadata_db_read_entry(ctx, { ...scope, fileNodeId: root._id, key: "plugin-name" })) ===
					installation.pluginName &&
				(await access_control_db_can_act_on_file_node(ctx, {
					...scope,
					userId: grant.actorUserId,
					fileNode: node,
					permission: "content.read",
				}))
			) {
				// Only ensure uses this path, to recover IDs for an empty private setup. No file or ACL changes follow.
				return Result({ _yay: { installation, serviceGrant: grant, pluginRun: null, writeContext, node, parentNode } });
			}
		}
	}
	let allowed: boolean;
	if (aclNode) {
		allowed = await access_control_db_can_act_on_file_node(ctx, {
			...scope,
			userId: grant.actorUserId,
			serviceAccountId: grant.serviceAccountId,
			fileNode: aclNode,
			permission: "content.write",
		});
	} else {
		const organization = await ctx.db.get("organizations", grant.organizationId);
		if (!organization?.defaultWorkspaceId) return Result({ _nay: { message: "Permission denied" } });
		const permission = {
			...scope,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "workspace" as const, id: String(workspace._id) },
			permission: "content.write" as const,
		};
		allowed =
			(await access_control_db_has_permission(ctx, { ...permission, userId: grant.actorUserId })) &&
			(await access_control_db_has_permission(ctx, { ...permission, serviceAccountId: grant.serviceAccountId }));
	}
	if (!allowed) return Result({ _nay: { message: "Permission denied" } });
	const writable = await files_nodes_db_require_writable(ctx, {
		...scope,
		writeContext,
		target: node ? { kind: "node", node } : { kind: "create", parentNode, path: args.path },
	});
	if (writable._nay) return writable;
	return Result({ _yay: { installation, serviceGrant: grant, pluginRun: null, writeContext, node, parentNode } });
}

export async function plugins_external_files_db_content_revision(ctx: QueryCtx, node: Doc<"files_nodes">) {
	const sequence = node.yjsLastSequenceId
		? await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId)
		: null;
	return JSON.stringify([node.assetId, node.yjsLastSequenceId, sequence?.lastSequence ?? null]);
}

/**
 * Check authority before exposing a receipt or a conflict. Receipt retries do not write again.
 */
export async function plugins_external_files_db_check_write(
	ctx: QueryCtx,
	args: {
		grantId: Id<"plugin_service_grants">;
		path: string;
		expectedParentNodeId: Id<"files_nodes">;
		write: NonNullable<Doc<"public_api_file_write_stages">["externalFileWrite"]>;
	},
) {
	const facts = await plugins_external_files_db_authorize(ctx, {
		...args.write,
		grantId: args.grantId,
		path: args.path,
	});
	if (facts._nay) return facts;
	const writer = await ctx.db.get("plugins_external_file_writers", args.write.writerId);
	if (!writer || writer.installationId !== facts._yay.installation._id) {
		return Result({ _nay: { message: "Permission denied" } });
	}
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
		root.archiveOperationId !== null ||
		root.path !== writer.rootPath ||
		!folder ||
		folder.archiveOperationId !== null ||
		folder.path !== writer.path ||
		args.expectedParentNodeId !== folder._id ||
		server_path_parent_of(args.path) !== folder.path ||
		writer.generation !== args.write.writerGeneration
	) {
		return Result({ _nay: { name: "stale_write", message: "The output folder or writer changed" } });
	}
	const receipt = await ctx.db
		.query("plugins_external_file_receipts")
		.withIndex("by_writer_operationId", (q) => q.eq("writerId", writer._id).eq("operationId", args.write.operationId))
		.first();
	const fingerprint = JSON.stringify([
		args.path,
		args.write.writerGeneration,
		args.write.sequence,
		args.write.contentHash,
		args.expectedParentNodeId,
		args.write.expectedNodeId,
		args.write.expectedContentRevision,
		args.write.expectedReaderRevision,
	]);
	if (receipt) {
		if (receipt.operation !== "write" || receipt.fingerprint !== fingerprint) {
			return Result({ _nay: { name: "stale_write", message: "This operation was already used for another write" } });
		}
		return Result({ _yay: { ...facts._yay, writer, binding, fingerprint, receipt } });
	}
	if (binding && binding.detachedAt === null && binding.revision !== args.write.expectedReaderRevision) {
		return Result({ _nay: { name: "stale_write", message: "The transcript readers changed" } });
	}
	// A fenced rebuild may reuse its source sequence. Ordering is local to the current writer generation.
	const latest = await ctx.db
		.query("plugins_external_file_receipts")
		.withIndex("by_writer_path_writerGeneration_sequence", (q) =>
			q.eq("writerId", writer._id).eq("path", args.path).eq("writerGeneration", writer.generation),
		)
		.order("desc")
		.first();
	if (latest && latest.sequence >= args.write.sequence) {
		return Result({ _nay: { name: "stale_write", message: "A newer transcript write already exists" } });
	}
	const node = facts._yay.node;
	if (
		(node?._id ?? null) !== args.write.expectedNodeId ||
		(node ? await plugins_external_files_db_content_revision(ctx, node) : null) !== args.write.expectedContentRevision
	) {
		return Result({ _nay: { name: "stale_write", message: "The file changed during the write" } });
	}
	return Result({ _yay: { ...facts._yay, writer, binding, fingerprint, receipt: null } });
}

export async function plugins_external_files_db_record_write(
	ctx: MutationCtx,
	args: {
		stage: Doc<"public_api_file_write_stages">;
		node: Doc<"files_nodes">;
		fingerprint: string;
	},
) {
	const write = args.stage.externalFileWrite!;
	const writer = await ctx.db.get("plugins_external_file_writers", write.writerId);
	await ctx.db.insert("plugins_external_file_receipts", {
		organizationId: args.stage.organizationId,
		workspaceId: args.stage.workspaceId,
		installationId: writer!.installationId,
		writerId: write.writerId,
		operationId: write.operationId,
		operation: "write",
		fingerprint: args.fingerprint,
		path: args.stage.path,
		sequence: write.sequence,
		writerGeneration: write.writerGeneration,
		nodeId: args.node._id,
		contentRevision: await plugins_external_files_db_content_revision(ctx, args.node),
		readerRevision: write.expectedReaderRevision,
		createdAt: Date.now(),
	});
}
