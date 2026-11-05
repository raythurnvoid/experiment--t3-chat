import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import { files_nodes_db_require_writable, type files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { plugins_db_get_live_service_account, plugins_file_subject } from "./plugins_service_accounts.ts";
import { crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import { files_db_get_visible_node_by_path, files_ROOT_ID } from "../server/files.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_sequence,
} from "../server/files-saved-placement.ts";
import { server_path_parent_of } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { plugins_file_grants_db_validate_pair } from "../server/plugins-file-grants.ts";

export async function plugins_external_files_db_get_node(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; path: string },
) {
	return await files_db_get_visible_node_by_path(ctx, args);
}

export async function plugins_external_files_db_authorize(
	ctx: QueryCtx,
	args: {
		grantId: Id<"plugin_service_grants">;
		tokenHash: string;
		serviceSecretHash: string;
		path: string;
		allowSealRoot?: boolean;
		force?: boolean;
		requestReadOnly?: boolean;
		exactNodeId?: Id<"files_nodes">;
		acceptedFilePairId?: Id<"plugins_file_pairs"> | null;
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
		(args.acceptedFilePairId !== undefined && args.acceptedFilePairId !== (grant.filePairId ?? null)) ||
		(args.acceptedFilePairId === undefined && !grant.filePairId && installation.fileAccessModel === "personal") ||
		(grant.filePairId &&
			!(await plugins_file_grants_db_validate_pair(ctx, {
				pairId: grant.filePairId,
				installationId: installation._id,
				userId: grant.actorUserId,
			})))
	)
		return Result({ _nay: { message: "Permission denied" } });
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
		? await files_saved_placement_db_get_node(ctx.db, args.exactNodeId)
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
	// The plugin-name stamp on the node (or nearest folder) is the ownership proof for this scope.
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
	if (
		(args.force === true || args.requestReadOnly === true) &&
		!installation.acceptedCapabilities.includes("workspace.files.manage-read-only")
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	const writeContext: files_nodes_WriteContext = {
		subject: plugins_file_subject(installation, grant.actorUserId, grant.filePairId),
		force: args.force === true,
		actorUserId: grant.actorUserId,
		resourceScope: node
			? { kind: node.kind === "folder" ? "subtree" : "node", nodeId: node._id }
			: { kind: "create", parentNodeId: parentNode?._id ?? files_ROOT_ID, path: args.path },
	};
	// No node on the path yet means a create at the workspace root.
	if (
		!(await access_control_db_can_act_on_file_node(ctx, {
			...scope,
			subject: writeContext.subject,
			fileNode: aclNode,
			permission: "content.write",
		}))
	)
		return Result({ _nay: { message: "Permission denied" } });
	return Result({
		_yay: { installation, membership, serviceGrant: grant, pluginRun: null, writeContext, node, parentNode },
	});
}

export async function plugins_external_files_db_content_revision(ctx: QueryCtx, node: Doc<"files_nodes">) {
	const sequence = await files_saved_placement_db_get_sequence(ctx.db, node);
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
		acceptedFilePairId?: Id<"plugins_file_pairs"> | null;
	},
) {
	const facts = await plugins_external_files_db_authorize(ctx, {
		...args.write,
		grantId: args.grantId,
		path: args.path,
		acceptedFilePairId: args.acceptedFilePairId,
	});
	if (facts._nay) return facts;

	const writer = await ctx.db.get("plugins_external_file_writers", args.write.writerId);
	if (!writer || writer.installationId !== facts._yay.installation._id) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	const [root, folder] = await Promise.all([
		files_saved_placement_db_get_node(ctx.db, writer.rootNodeId),
		files_saved_placement_db_get_node(ctx.db, writer.folderNodeId),
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
	// Keep ordinary retries identical when force is omitted or false.
	const fingerprint = JSON.stringify([
		args.path,
		args.write.writerGeneration,
		args.write.sequence,
		args.write.contentHash,
		args.expectedParentNodeId,
		args.write.expectedNodeId,
		args.write.expectedContentRevision,
		args.write.contentType,
		args.write.nonCollaborative,
		args.write.requestReadOnly,
		...(args.write.force ? [true] : []),
	]);
	if (receipt) {
		if (receipt.operation !== "write" || receipt.fingerprint !== fingerprint) {
			return Result({ _nay: { name: "stale_write", message: "This operation was already used for another write" } });
		}
		return Result({ _yay: { ...facts._yay, writer, fingerprint, receipt } });
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
		return Result({ _nay: { name: "stale_write", message: "A newer file write already exists" } });
	}

	const node = facts._yay.node;
	if (
		(node?._id ?? null) !== args.write.expectedNodeId ||
		(node ? await plugins_external_files_db_content_revision(ctx, node) : null) !== args.write.expectedContentRevision
	) {
		return Result({ _nay: { name: "stale_write", message: "The file changed during the write" } });
	}

	const writable = await files_nodes_db_require_writable(ctx, {
		organizationId: facts._yay.installation.organizationId,
		workspaceId: facts._yay.installation.workspaceId,
		writeContext: facts._yay.writeContext,
		target: node ? { kind: "node", node } : { kind: "create", parentNode: facts._yay.parentNode, path: args.path },
	});
	if (writable._nay) return Result({ _nay: writable._nay });
	return Result({ _yay: { ...facts._yay, writer, fingerprint, receipt: null } });
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
		createdAt: Date.now(),
	});
}
