import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import app_convex_schema from "./schema.ts";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import {
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_require_write_policy_management,
	files_nodes_db_cascade_restricted_scope,
	files_nodes_db_archive_nodes,
	files_nodes_db_require_writable,
} from "./files_nodes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import {
	public_api_service_uploads_db_collect_bounded_descendants,
	public_api_service_uploads_MAX_ARCHIVE_NODES,
} from "./public_api_service_uploads.ts";
import {
	plugins_external_files_db_authorize,
	plugins_external_files_db_content_revision,
	plugins_external_files_db_check_write,
} from "./plugins_external_files_access.ts";
import { public_api_authorize_request } from "./public_api_http_auth.ts";
import { public_api_is_valid_write_file_name, public_api_write_one_text_file } from "./public_api.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID, files_get_utf8_byte_size, files_normalize_text_document_input } from "../server/files.ts";
import {
	server_path_normalize,
	server_path_parent_of,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { files_normalize_name } from "../shared/files.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
import { Result } from "common/errors-as-values-utils.ts";

const MAX_TEXT_BYTES = 100_000;
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
		const membership = await ctx.db
			.query("plugins_chitchat_memberships")
			.withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.installation.workspaceId).eq("userId", userId))
			.first();
		if (!membership?.active || membership.lifetime !== membershipLifetime)
			throw convex_error({ message: "The transcript readers changed" });
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

export const ensure = internalMutation({
	args: {
		grantId: v.id("plugin_service_grants"),
		tokenHash: v.string(),
		serviceSecretHash: v.string(),
		datasetGeneration: v.string(),
		channelId: v.string(),
		rootPath: v.string(),
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
		const facts = await plugins_external_files_db_authorize(ctx, {
			...args,
			allowSealRoot: true,
			recoverEmptySetup: {
				datasetGeneration: args.datasetGeneration,
				channelId: args.channelId,
				rootPath: args.rootPath,
			},
		});
		if (facts._nay) return facts;
		const { installation, serviceGrant, writeContext } = facts._yay;
		if (
			args.readers &&
			(args.readers.length > MAX_READERS ||
				new Set(args.readers.map((reader) => reader.userId)).size !== args.readers.length)
		) {
			return Result({ _nay: { message: "Invalid transcript readers" } });
		}
		const rootWriter = await ctx.db
			.query("plugins_external_file_writers")
			.withIndex("by_installation_datasetGeneration_channelId", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("datasetGeneration", args.datasetGeneration)
					.eq("channelId", "__root"),
			)
			.first();
		const existing = await ctx.db
			.query("plugins_external_file_writers")
			.withIndex("by_installation_datasetGeneration_channelId", (q) =>
				q
					.eq("installationId", installation._id)
					.eq("datasetGeneration", args.datasetGeneration)
					.eq("channelId", args.channelId),
			)
			.first();
		if (existing) {
			const binding = await ctx.db
				.query("plugins_external_file_bindings")
				.withIndex("by_writer", (q) => q.eq("writerId", existing._id))
				.first();
			const root = await ctx.db.get("files_nodes", existing.rootNodeId);
			if (
				existing.path !== args.path ||
				existing.rootPath !== args.rootPath ||
				facts._yay.node?._id !== existing.folderNodeId ||
				!root ||
				root.path !== args.rootPath ||
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
		if (args.channelId === "__root") {
			if (
				args.path !== args.rootPath ||
				args.rootPath !== serviceGrant.destinationPathPrefix ||
				facts._yay.node ||
				args.readers
			) {
				return Result({ _nay: { name: "stale_write", message: "Choose a new transcript root" } });
			}
		} else if (
			!rootWriter ||
			rootWriter.rootPath !== args.rootPath ||
			!(args.path === args.rootPath || args.path.startsWith(`${args.rootPath}/`))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		if (rootWriter) {
			const root = await ctx.db.get("files_nodes", rootWriter.rootNodeId);
			if (!root || root.path !== args.rootPath || root.archiveOperationId !== null) {
				return Result({ _nay: { name: "stale_write", message: "The transcript root changed" } });
			}
		}
		if (facts._yay.node && (args.readers || facts._yay.node._id !== rootWriter?.rootNodeId)) {
			return Result({ _nay: { name: "stale_write", message: "The transcript folder is already used" } });
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
		for (const { userId, membershipLifetime } of args.readers ?? []) {
			const membership = await ctx.db
				.query("plugins_chitchat_memberships")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", installation.workspaceId).eq("userId", userId))
				.first();
			if (!membership?.active || membership.lifetime !== membershipLifetime)
				return Result({ _nay: { message: "The transcript readers changed" } });
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
		const rootNodeId = rootWriter?.rootNodeId ?? nodeId;
		const writerId = await ctx.db.insert("plugins_external_file_writers", {
			organizationId: installation.organizationId,
			workspaceId: installation.workspaceId,
			installationId: installation._id,
			datasetGeneration: args.datasetGeneration,
			channelId: args.channelId,
			rootNodeId,
			folderNodeId: nodeId,
			rootPath: args.rootPath,
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
type ensure_Result = typeof ensure extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

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
type inspect_Result = typeof inspect extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

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
			(folder.archiveOperationId !== null && existing?.operation !== "archive")
		) {
			return Result({ _nay: { name: "stale_write", message: "The output folder changed" } });
		}
		if (args.change.kind === "archive") {
			const node = facts._yay.node;
			if (
				!node ||
				node._id === writer.rootNodeId ||
				(node.kind === "file" ? node.parentId !== folder._id : node._id !== folder._id)
			)
				return Result({ _nay: { name: "stale_write", message: "The transcript file changed" } });
		}
		const fingerprint = JSON.stringify([args.writerGeneration, args.change]);
		if (existing)
			return existing.operation === args.change.kind && existing.fingerprint === fingerprint
				? Result({ _yay: existing })
				: Result({ _nay: { name: "stale_write", message: "This operation was already used" } });
		if (writer.generation !== args.writerGeneration)
			return Result({ _nay: { name: "stale_write", message: "The transcript writer changed" } });
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
				return Result({ _nay: { name: "stale_write", message: "The transcript reader binding changed" } });
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
				return Result({ _nay: { message: "Invalid transcript readers" } });
			}
			for (const reader of args.change.readers) {
				const membership = await ctx.db
					.query("plugins_chitchat_memberships")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", writer.workspaceId).eq("userId", reader.userId))
					.first();
				if (!membership?.active || membership.lifetime !== reader.membershipLifetime)
					return Result({ _nay: { name: "stale_write", message: "The transcript readers changed" } });
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
				return Result({ _nay: { name: "stale_write", message: "The transcript file changed" } });
			if (binding?.detachedAt != null)
				return Result({ _nay: { name: "stale_write", message: "The transcript readers are managed in Files" } });
			const latest = await ctx.db
				.query("plugins_external_file_receipts")
				.withIndex("by_writer_path_writerGeneration_sequence", (q) =>
					q.eq("writerId", writer._id).eq("path", path).eq("writerGeneration", writer.generation),
				)
				.order("desc")
				.first();
			if (latest && latest.sequence >= args.change.sequence) {
				return Result({ _nay: { name: "stale_write", message: "A newer transcript write already exists" } });
			}
			const descendants =
				node.kind === "folder"
					? await public_api_service_uploads_db_collect_bounded_descendants(ctx, {
							organizationId: writer.organizationId,
							workspaceId: writer.workspaceId,
							parentId: node._id,
							maxNodes: public_api_service_uploads_MAX_ARCHIVE_NODES - 1,
						})
					: [];
			if (!descendants)
				return Result({ _nay: { name: "stale_write", message: "Too many transcript files to archive at once" } });
			for (const descendant of descendants) {
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: writer.organizationId,
						workspaceId: writer.workspaceId,
						userId: facts._yay.serviceGrant.actorUserId,
						serviceAccountId: facts._yay.serviceGrant.serviceAccountId,
						fileNode: descendant,
						permission: "content.write",
					})) ||
					(await files_metadata_db_read_entry(ctx, {
						organizationId: writer.organizationId,
						workspaceId: writer.workspaceId,
						fileNodeId: descendant._id,
						key: "plugin-name",
					})) !== facts._yay.installation.pluginName
				)
					return Result({ _nay: { message: "Permission denied" } });
				const writable = await files_nodes_db_require_writable(ctx, {
					organizationId: writer.organizationId,
					workspaceId: writer.workspaceId,
					writeContext: facts._yay.writeContext,
					target: { kind: "node", node: descendant },
				});
				if (writable._nay) return writable;
			}
			nodeId = node._id;
			// An earlier Files archive already did the work. Keep its identity and dates.
			if (node.archiveOperationId === null)
				await files_nodes_db_archive_nodes(ctx, {
					nodeIds: [
						nodeId,
						...descendants
							.filter((descendant) => descendant.archiveOperationId === null)
							.map((descendant) => descendant._id),
					],
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
type change_scope_Result =
	typeof change_scope extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

function fail(error: { message: string; name?: string }) {
	if (error.message === "Unauthenticated" || error.message === "Unauthorized")
		return { status: 401, body: { message: error.message } } as const;
	if (error.message === "Permission denied") return { status: 403, body: { message: error.message } } as const;
	if (error.name === "stale_write" || error.name === "read_only")
		return { status: 409, body: { message: error.message } } as const;
	return { status: 400, body: { message: error.message } } as const;
}

async function authorize<Body>(ctx: ActionCtx, request: Request, schema: z.ZodType<Body>) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write",
		allowedKinds: ["plugin_service"],
		route: "/api/v1/files/write",
	});
	if (auth._nay) return Result({ _nay: { message: auth._nay.body.message, data: auth._nay } });
	const secret = request.headers.get("X-Bonobo-Service-Authorization");
	const token = request.headers.get("Authorization");
	if (
		!secret?.startsWith("Bearer ") ||
		!token?.startsWith("Bearer ") ||
		auth._yay.principal.kind !== "plugin_service"
	) {
		return Result({
			_nay: { message: "Unauthenticated", data: { status: 401, body: { message: "Unauthenticated" } } as const },
		});
	}
	const body = await server_request_json_parse_and_validate(request, schema);
	if (body._nay) return Result({ _nay: { message: body._nay.message, data: fail(body._nay) } });
	return Result({
		_yay: {
			body: body._yay,
			principal: auth._yay.principal,
			grantId: auth._yay.principal.grantId,
			tokenHash: await crypto_sha256_hex(token.slice(7).trim()),
			serviceSecretHash: await crypto_sha256_hex(secret.slice(7).trim()),
		},
	});
}

const path_validator = z
	.string()
	.min(1)
	.refine(
		(path) => path !== "/" && path.startsWith("/") && server_path_normalize(path) === path,
		"Path must be a normalized absolute path",
	);
const ensure_validator = z
	.object({
		datasetGeneration: z.string().min(1).max(128),
		channelId: z.string().min(1).max(128),
		rootPath: path_validator,
		path: path_validator,
		readers: z
			.array(z.object({ userId: z.string(), membershipLifetime: z.number().int().nonnegative() }))
			.max(MAX_READERS)
			.optional(),
		readOnly: z.boolean().default(true),
	})
	.strict();
export type plugins_external_files_http_ensure_Body = z.input<typeof ensure_validator>;

export async function plugins_external_files_http_ensure(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, ensure_validator);
	if (auth._nay) return auth._nay.data;
	for (const segment of path_extract_segments_from(auth._yay.body.path)) {
		const normalized = files_normalize_name("folder", segment);
		if (normalized._nay || normalized._yay !== segment)
			return fail({ message: "Path contains an invalid folder name" });
	}
	const result: ensure_Result = await ctx.runMutation(internal.plugins_external_files.ensure, {
		...auth._yay.body,
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
		readers: auth._yay.body.readers?.map((reader) => ({ ...reader, userId: reader.userId as Id<"users"> })),
	});
	return result._nay
		? fail(result._nay)
		: ({ status: 200, body: result._yay, headers: { "Cache-Control": "no-store" } } as const);
}

const prepare_validator = z.object({ writerId: z.string(), path: path_validator }).strict();
export type plugins_external_files_http_prepare_Body = z.infer<typeof prepare_validator>;

export async function plugins_external_files_http_prepare(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, prepare_validator);
	if (auth._nay) return auth._nay.data;
	const inspected: inspect_Result = await ctx.runQuery(internal.plugins_external_files.inspect, {
		...auth._yay.body,
		writerId: auth._yay.body.writerId as Id<"plugins_external_file_writers">,
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	});
	if (inspected._nay) return fail(inspected._nay);
	const { writer, node } = inspected._yay;
	if (node && (node.kind !== "file" || node.contentType !== "text/markdown;charset=utf-8"))
		return fail({ name: "stale_write", message: "The target is not a Markdown file" });
	let content: string | null = null;
	if (node) {
		const scope = {
			organizationId: writer.organizationId,
			workspaceId: writer.workspaceId,
			userId: auth._yay.principal.actorUserId,
			serviceAccountId: auth._yay.principal.serviceAccountId,
		};
		if (node.collaborationEnabled) {
			const state = await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
				...scope,
				nodeId: node._id,
			});
			if (!state) return fail({ name: "stale_write", message: "The file changed during the read" });
			const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({ state });
			if (reconstructed._nay) return fail(reconstructed._nay);
			content = reconstructed._yay.text;
		} else {
			const read = await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
				...scope,
				path: node.path,
				committedOnly: true,
				mode: { kind: "full", maxBytes: MAX_TEXT_BYTES },
			});
			if (!read) return fail({ name: "stale_write", message: "The file changed during the read" });
			if (read.moreLines) return fail({ name: "stale_write", message: "Transcript content exceeds the file limit" });
			content = read.content;
		}
	}
	if (content !== null && files_get_utf8_byte_size(content) > MAX_TEXT_BYTES)
		return fail({ name: "stale_write", message: "Transcript content exceeds the file limit" });
	const confirmed: inspect_Result = await ctx.runQuery(internal.plugins_external_files.inspect, {
		...auth._yay.body,
		writerId: writer._id,
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	});
	if (confirmed._nay) return fail(confirmed._nay);
	if (
		confirmed._yay.contentRevision !== inspected._yay.contentRevision ||
		confirmed._yay.readerRevision !== inspected._yay.readerRevision ||
		confirmed._yay.writer.generation !== writer.generation
	)
		return fail({ name: "stale_write", message: "The file changed during the read" });
	return {
		status: 200,
		body: {
			nodeId: node?._id ?? null,
			content,
			contentRevision: inspected._yay.contentRevision,
			expectedParentNodeId: writer.folderNodeId,
			writerGeneration: writer.generation,
			readerRevision: inspected._yay.readerRevision,
			detached: inspected._yay.detached,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const write_validator = z
	.object({
		writerId: z.string(),
		path: path_validator,
		operationId: z.string().min(1).max(128),
		writerGeneration: z.number().int().positive(),
		sequence: z.number().int().positive(),
		expectedParentNodeId: z.string(),
		expectedNodeId: z.string().nullable(),
		expectedContentRevision: z.string().nullable(),
		expectedReaderRevision: z.number().int().positive().nullable(),
		contentHash: z.string().regex(/^[a-f0-9]{64}$/),
		content: z.string().min(1),
	})
	.strict();
export type plugins_external_files_http_write_Body = z.infer<typeof write_validator>;

export async function plugins_external_files_http_write(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, write_validator);
	if (auth._nay) return auth._nay.data;
	const body = auth._yay.body;
	if (!body.path.endsWith(".md") || !public_api_is_valid_write_file_name(path_name_of(body.path))) {
		return fail({ message: "Path must end in a valid Markdown file name" });
	}
	const content = files_normalize_text_document_input(body.content);
	if (
		content !== body.content ||
		files_get_utf8_byte_size(content) > MAX_TEXT_BYTES ||
		(await crypto_sha256_hex(content)) !== body.contentHash
	) {
		return fail({ message: "Invalid transcript content or hash" });
	}
	const write = {
		...body,
		writerId: body.writerId as Id<"plugins_external_file_writers">,
		expectedNodeId: body.expectedNodeId as Id<"files_nodes"> | null,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	};
	const { path, expectedParentNodeId, content: _content, ...externalFileWrite } = write;
	const receiptArgs = {
		grantId: auth._yay.grantId,
		path,
		expectedParentNodeId: expectedParentNodeId as Id<"files_nodes">,
		write: externalFileWrite,
	};
	const prior = await ctx.runQuery(internal.plugins_external_files.get_write_receipt, receiptArgs);
	if (prior._nay) return fail(prior._nay);
	if (prior._yay) return { status: 200, body: prior._yay, headers: { "Cache-Control": "no-store" } } as const;
	const credits = await ctx.runQuery(internal.billing.check_credits, {
		userId: auth._yay.principal.actorUserId,
		organizationId: auth._yay.principal.organizationId,
		minimumRequiredCents: 1,
	});
	if (!credits.hasCredits) return { status: 402, body: { message: "Insufficient funds" } } as const;
	const written = await public_api_write_one_text_file(ctx, {
		organizationId: auth._yay.principal.organizationId,
		workspaceId: auth._yay.principal.workspaceId,
		userId: auth._yay.principal.actorUserId,
		visibilityUserId: auth._yay.principal.actorUserId,
		serviceAccountId: auth._yay.principal.serviceAccountId,
		principalRef: { kind: "plugin_service", grantId: auth._yay.grantId },
		path,
		expectedParentNodeId,
		externalFileWrite,
		content,
		contentBytes: files_get_utf8_byte_size(content),
		overwrite: body.expectedNodeId === null ? "fail" : "replace",
		skipIfUnchanged: false,
		shape: { contentType: "text/markdown;charset=utf-8", rootKind: "rich_text" },
		nonCollaborative: true,
		requestReadOnly: false,
	});
	if (written._nay) return { status: written._nay.data.status, body: { message: written._nay.message } } as const;
	const receipt = await ctx.runQuery(internal.plugins_external_files.get_write_receipt, receiptArgs);
	if (receipt._nay) return fail(receipt._nay);
	if (!receipt._yay) return { status: 500, body: { message: "The write receipt is unavailable" } } as const;
	return { status: 200, body: receipt._yay, headers: { "Cache-Control": "no-store" } } as const;
}

const fence_validator = z
	.object({
		writerId: z.string(),
		operationId: z.string().min(1).max(128),
		writerGeneration: z.number().int().positive(),
		nextGeneration: z.number().int().positive(),
	})
	.strict();
export type plugins_external_files_http_fence_Body = z.infer<typeof fence_validator>;
export async function plugins_external_files_http_fence(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, fence_validator);
	if (auth._nay) return auth._nay.data;
	const result: change_scope_Result = await ctx.runMutation(internal.plugins_external_files.change_scope, {
		writerId: auth._yay.body.writerId as Id<"plugins_external_file_writers">,
		operationId: auth._yay.body.operationId,
		writerGeneration: auth._yay.body.writerGeneration,
		change: { kind: "fence", nextGeneration: auth._yay.body.nextGeneration },
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	});
	return result._nay
		? fail(result._nay)
		: ({ status: 200, body: result._yay, headers: { "Cache-Control": "no-store" } } as const);
}

const readers_validator = z
	.object({
		writerId: z.string(),
		operationId: z.string().min(1).max(128),
		writerGeneration: z.number().int().positive(),
		expectedReaderRevision: z.number().int().positive(),
		readers: z
			.array(z.object({ userId: z.string(), membershipLifetime: z.number().int().nonnegative() }))
			.max(MAX_READERS),
	})
	.strict();
export type plugins_external_files_http_readers_Body = z.infer<typeof readers_validator>;
export async function plugins_external_files_http_readers(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, readers_validator);
	if (auth._nay) return auth._nay.data;
	const result: change_scope_Result = await ctx.runMutation(internal.plugins_external_files.change_scope, {
		writerId: auth._yay.body.writerId as Id<"plugins_external_file_writers">,
		operationId: auth._yay.body.operationId,
		writerGeneration: auth._yay.body.writerGeneration,
		change: {
			kind: "readers",
			expectedReaderRevision: auth._yay.body.expectedReaderRevision,
			readers: auth._yay.body.readers.map((reader) => ({ ...reader, userId: reader.userId as Id<"users"> })),
		},
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	});
	return result._nay
		? fail(result._nay)
		: ({ status: 200, body: result._yay, headers: { "Cache-Control": "no-store" } } as const);
}

const archive_validator = z
	.object({
		writerId: z.string(),
		operationId: z.string().min(1).max(128),
		writerGeneration: z.number().int().positive(),
		path: path_validator,
		nodeId: z.string(),
		sequence: z.number().int().positive(),
		expectedContentRevision: z.string().optional(),
	})
	.strict();
export type plugins_external_files_http_archive_Body = z.infer<typeof archive_validator>;
export async function plugins_external_files_http_archive(ctx: ActionCtx, request: Request) {
	const auth = await authorize(ctx, request, archive_validator);
	if (auth._nay) return auth._nay.data;
	const result: change_scope_Result = await ctx.runMutation(internal.plugins_external_files.change_scope, {
		writerId: auth._yay.body.writerId as Id<"plugins_external_file_writers">,
		operationId: auth._yay.body.operationId,
		writerGeneration: auth._yay.body.writerGeneration,
		change: {
			kind: "archive",
			path: auth._yay.body.path,
			nodeId: auth._yay.body.nodeId as Id<"files_nodes">,
			sequence: auth._yay.body.sequence,
			expectedContentRevision: auth._yay.body.expectedContentRevision,
		},
		grantId: auth._yay.grantId,
		tokenHash: auth._yay.tokenHash,
		serviceSecretHash: auth._yay.serviceSecretHash,
	});
	return result._nay
		? fail(result._nay)
		: ({ status: 200, body: result._yay, headers: { "Cache-Control": "no-store" } } as const);
}
