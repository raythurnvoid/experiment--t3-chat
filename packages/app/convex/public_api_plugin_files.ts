/**
 * The plugin file doors behind `/api/v1/files/plugin-folders/ensure`, `/api/v1/files/plugin-archive`,
 * and `/api/v1/files/plugin-access/set` (routes in `public_api_plugin_files_http_routes.ts`).
 *
 * Editable `plugin-name` metadata selects the files and folders a plugin can use.
 * Current capabilities, actor permissions, and locks still control each operation.
 */
import { v, type Infer } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { z } from "zod";

import { internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_has_permission } from "./access_control.ts";
import {
	files_node_require_writable,
	files_nodes_db_archive_nodes,
	files_nodes_db_can_act_on_swept_nodes,
	files_nodes_db_cascade_read_only_scope,
	files_nodes_db_collect_descendants,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_resolve_parent_read_only_scope,
} from "./files_nodes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import {
	public_api_db_can_pass_read_only_for_plugin,
	public_api_db_revalidate_file_write_principal,
	public_api_db_revalidate_live_plugin_run,
} from "./public_api.ts";
import {
	public_api_service_uploads_db_collect_bounded_descendants,
	public_api_service_uploads_db_release_service_created_locks,
	public_api_service_uploads_MAX_ARCHIVE_NODES,
} from "./public_api_service_uploads.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import {
	plugins_data_db_apply_file_access_binding,
	plugins_data_db_prepare_file_access_binding,
} from "./plugins_data.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_normalize_name } from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import type { public_api_Scope } from "../shared/public-api.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). Do not keep request state in module-level values.
export const experimental_reuseContext = true;

async function db_get_active_node_at_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		path: string;
	},
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.first();
}

/**
 * Finish access checks before creating a folder or changing its locks and readers.
 */
async function db_prepare_plugin_access(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		node: Doc<"files_nodes"> | null;
		parentId: Doc<"files_nodes">["parentId"];
		readOnly?: boolean;
		readScopeId?: string | null;
	},
) {
	if (!args.installation.acceptedCapabilities.includes("workspace.files.own-access")) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	let readOnlyChange: boolean | undefined;
	if (args.readOnly !== undefined) {
		let parentScopeNodeId = await files_nodes_db_resolve_parent_read_only_scope(ctx, {
			parentId: args.parentId,
		});
		const hasParentLock = parentScopeNodeId !== undefined;
		// A nested plugin lock must not hide an outer member lock.
		while (parentScopeNodeId !== undefined) {
			const parentScopeNode = await ctx.db.get("files_nodes", parentScopeNodeId);
			if (args.readOnly !== true || parentScopeNode?.readOnlyPluginName !== args.installation.pluginName) {
				return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
			}
			parentScopeNodeId = await files_nodes_db_resolve_parent_read_only_scope(ctx, {
				parentId: parentScopeNode.parentId,
			});
		}
		if (args.node && args.node.readOnlyScopeNodeId === args.node._id) {
			if (args.node.readOnlyPluginName !== args.installation.pluginName) {
				return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
			}
			if (!args.readOnly) {
				readOnlyChange = false;
			}
		} else if (args.readOnly && !hasParentLock) {
			readOnlyChange = true;
		}
	}

	let binding: NonNullable<Awaited<ReturnType<typeof plugins_data_db_prepare_file_access_binding>>["_yay"]> | null =
		null;
	if (args.readScopeId !== undefined) {
		const prepared = await plugins_data_db_prepare_file_access_binding(ctx, {
			installation: args.installation,
			nodeId: args.node?._id ?? null,
			readScopeId: args.readScopeId,
		});
		if (prepared._nay) {
			return prepared;
		}
		binding = prepared._yay;
	}

	return Result({ _yay: { readOnlyChange, binding } });
}

async function db_apply_plugin_access(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		node: Doc<"files_nodes">;
		prepared: NonNullable<Awaited<ReturnType<typeof db_prepare_plugin_access>>["_yay"]>;
	},
) {
	if (args.prepared.readOnlyChange !== undefined) {
		const scopeNodeId = args.prepared.readOnlyChange ? args.node._id : undefined;
		await ctx.db.patch("files_nodes", args.node._id, {
			readOnlyScopeNodeId: scopeNodeId,
			readOnlyPluginName: args.prepared.readOnlyChange ? args.installation.pluginName : undefined,
			readOnlyPluginServiceTargetId: undefined,
		});
		await files_nodes_db_cascade_read_only_scope(ctx, {
			organizationId: args.node.organizationId,
			workspaceId: args.node.workspaceId,
			parentId: args.node._id,
			scopeNodeId,
		});
	}
	if (args.prepared.binding) {
		await plugins_data_db_apply_file_access_binding(ctx, {
			installation: args.installation,
			node: args.node,
			prepared: args.prepared.binding,
		});
	}
}

// #region ensure

export const ensure_plugin_folder = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * The member the run acts for; folder authorship and ACL answers are theirs.
		 */
		userId: v.id("users"),
		runId: v.id("plugins_event_runs"),
		path: v.string(),
		readOnly: v.optional(v.boolean()),
		readScopeId: v.optional(v.union(v.string(), v.null())),
	},
	returns: v_result({
		_yay: v.object({ nodeId: v.id("files_nodes"), path: v.string(), created: v.boolean() }),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const liveRun = await public_api_db_revalidate_live_plugin_run(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			runId: args.runId,
			now,
		});
		if (liveRun._nay) {
			return liveRun;
		}
		const { pluginRun, installation } = liveRun._yay;

		// Upload runs keep their sibling-write rule and cannot ensure folders.
		if (pluginRun.event !== "ui.invoke.requested" || pluginRun.actorUserId !== args.userId) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		if (!installation.acceptedCapabilities.includes("workspace.files.own-write")) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		// Decide the access consent before any folder is created, so a refusal creates nothing.
		if (
			(args.readOnly !== undefined || args.readScopeId !== undefined) &&
			!installation.acceptedCapabilities.includes("workspace.files.own-access")
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Walk the existing chain. The walk stops at the first missing segment; everything after
		// it is created below.
		const segments = path_extract_segments_from(args.path);
		let currentParent: Doc<"files_nodes">["parentId"] = files_ROOT_ID;
		let deepest: Doc<"files_nodes"> | null = null;
		let firstMissingIndex: number | null = null;
		for (const [index, name] of segments.entries()) {
			const existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("parentId", currentParent)
						.eq("name", name)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!existing) {
				firstMissingIndex = index;
				break;
			}
			deepest = existing;
			currentParent = existing._id;
		}

		// The run acts for its member, so the member must still be one and must still be allowed
		// to write here — the same rule as the write engine, asked against the deepest existing
		// node so a restricted plugin folder is judged by the grants that let the actor in.
		const actorMembership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!actorMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const [organization, workspace] = await Promise.all([
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);
		const canWrite =
			organization?.defaultWorkspaceId &&
			workspace &&
			(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resource: deepest
					? { kind: "file", id: String(deepest._id), restrictedScopeNodeId: deepest.restrictedScopeNodeId ?? null }
					: { kind: "workspace", id: String(workspace._id) },
				permission: "content.write",
				userId: args.userId,
			}));

		if (!canWrite) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		if (
			deepest &&
			(deepest.kind !== "folder" ||
				(await files_metadata_db_read_entry(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId: deepest._id,
					key: "plugin-name",
				})) !== installation.pluginName)
		) {
			return Result({
				_nay: { name: "conflict", message: "This path is used by an item without this plugin's label" },
			});
		}

		// A lock on the existing chain refuses the create, unless it is the plugin's own lock.
		if (deepest) {
			const writable = files_node_require_writable(deepest);
			if (
				writable._nay &&
				!(await public_api_db_can_pass_read_only_for_plugin(ctx, {
					facts: { pluginRun, installation, serviceGrant: null },
					node: deepest,
				}))
			) {
				return writable;
			}
		}

		let nodeId: Id<"files_nodes">;
		let created = false;
		if (firstMissingIndex === null) {
			if (!deepest) {
				// The route refuses "/", so the walk always saw at least one segment.
				throw should_never_happen("plugin folder ensure walked no segments", { path: args.path });
			}
			nodeId = deepest._id;
			const binding = await ctx.db
				.query("plugins_file_access_bindings")
				.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
				.first();
			if (
				binding &&
				(binding.installationId !== installation._id ||
					(args.readScopeId !== undefined && binding.scopeId !== args.readScopeId))
			) {
				return Result({ _nay: { name: "conflict", message: "This item has a different plugin reader binding" } });
			}
			if (binding) {
				const preparedBinding = await plugins_data_db_prepare_file_access_binding(ctx, {
					installation,
					nodeId,
					readScopeId: binding.scopeId,
				});
				if (preparedBinding._nay) {
					return preparedBinding;
				}
			}
		} else {
			let preparedAccess: NonNullable<Awaited<ReturnType<typeof db_prepare_plugin_access>>["_yay"]> | null = null;
			if (args.readOnly !== undefined || args.readScopeId !== undefined) {
				const prepared = await db_prepare_plugin_access(ctx, {
					installation,
					node: null,
					parentId: deepest?._id ?? files_ROOT_ID,
					readOnly: args.readOnly,
					readScopeId: args.readScopeId,
				});
				if (prepared._nay) {
					return prepared;
				}
				preparedAccess = prepared._yay;
			}
			const createdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: args.userId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: files_ROOT_ID,
				path: args.path,
				kind: "folder",
				// The authority questions were answered above against the deepest existing node.
				skipAccessControlAndLock: true,
				// A folder created under this plugin's locked root must come out locked too, the same
				// way the write doors create files under it. Without this the new folder carries no
				// lock pointer, so the tree above says read-only while the folder's own field says
				// nothing, and `access: { readOnly: true }` on it becomes a no-op that locks nothing.
				inheritParentReadOnlyScope: true,
				createdNodesMetadata: [
					{ key: "source", value: "plugin" },
					{ key: "plugin-name", value: installation.pluginName },
				],
				now,
			});
			if (createdResult._nay) {
				// A concurrent create raced this walk; the caller retries and hits the idempotent path.
				return Result({ _nay: { name: "conflict", message: createdResult._nay.message } });
			}
			nodeId = createdResult._yay;
			created = true;
			if (preparedAccess) {
				const node = await ctx.db.get("files_nodes", nodeId);
				if (!node) {
					throw should_never_happen("ensured plugin folder is missing right after create", { nodeId });
				}
				await db_apply_plugin_access(ctx, { installation, node, prepared: preparedAccess });
			}
		}

		return Result({ _yay: { nodeId, path: args.path, created } });
	},
});

type ensure_plugin_folder_Result =
	typeof ensure_plugin_folder extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion ensure

// #region archive

const archive_principal_ref_validator = v.union(
	v.object({
		kind: v.literal("plugin_run"),
		runId: v.id("plugins_event_runs"),
		callId: v.id("plugins_event_run_calls"),
	}),
	v.object({
		kind: v.literal("plugin_service"),
		grantId: v.id("plugin_service_grants"),
	}),
);

export const archive_plugin_path = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * The member the principal acts for.
		 */
		userId: v.id("users"),
		principalRef: archive_principal_ref_validator,
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ archivedNodes: v.number() }) }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: args.principalRef,
			path: args.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}
		const facts = revalidated._yay;
		if (args.principalRef.kind === "plugin_run" && facts.pluginRun?.event !== "ui.invoke.requested") {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const installation = facts.installation;
		if (!installation) {
			// Unreachable: both allowed principal kinds resolve an installation.
			throw should_never_happen("plugin archive without an installation", { path: args.path });
		}

		const node = await db_get_active_node_at_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
		});
		// Archiving an absent or already archived path is satisfied by doing nothing.
		if (!node) {
			return Result({ _yay: { archivedNodes: 0 } });
		}

		if (args.principalRef.kind === "plugin_run") {
			if (
				(await files_metadata_db_read_entry(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId: node._id,
					key: "plugin-name",
				})) !== installation.pluginName
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// The sweep below proves the same for the whole subtree, bounded like the service
			// `archive-destination` door.
			const descendants = await public_api_service_uploads_db_collect_bounded_descendants(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: node._id,
				maxNodes: public_api_service_uploads_MAX_ARCHIVE_NODES - 1,
			});
			if (descendants === null) {
				return Result({
					_nay: {
						message: `A plugin archives at most ${public_api_service_uploads_MAX_ARCHIVE_NODES} files and folders at once`,
					},
				});
			}

			// Every descendant must opt in before any lock is released or node is archived.
			for (const swept of descendants) {
				if (
					(await files_metadata_db_read_entry(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						fileNodeId: swept._id,
						key: "plugin-name",
					})) !== installation.pluginName
				) {
					return Result({
						_nay: { name: "conflict", message: "This folder holds items without this plugin's label" },
					});
				}
			}

			// The same sweep question the member and service archives ask: the actor must be able
			// to write everything the cascade takes, including a restricted folder nested inside.
			if (
				!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					rootScopeNodeId: node.restrictedScopeNodeId,
					nodes: descendants,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// Plugin-passable locks are released before the archive so a member can restore the
			// set later; any other lock refuses the whole call. Only a direct lock owns a pointer
			// to release — inherited pointers are cleared by the owning folder's release cascade.
			const directLockedNodes: Array<Doc<"files_nodes">> = [];
			for (const swept of [node, ...descendants]) {
				const writable = files_node_require_writable(swept);
				if (!writable._nay) {
					continue;
				}
				if (!(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts, node: swept }))) {
					return writable;
				}
				if (swept.readOnlyScopeNodeId === swept._id) {
					directLockedNodes.push(swept);
				}
			}

			const activeDescendants = descendants.filter((descendant) => descendant.archiveOperationId === undefined);
			await public_api_service_uploads_db_release_service_created_locks(ctx, { nodes: directLockedNodes });
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds: [node._id, ...activeDescendants.map((descendant) => descendant._id)],
				updatedBy: args.userId,
				now,
			});
			return Result({ _yay: { archivedNodes: activeDescendants.length + 1 } });
		}

		// A sealed service grant archives one matching file through this door.
		if (
			node.kind !== "file" ||
			(await files_metadata_db_read_entry(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: node._id,
				key: "plugin-name",
			})) !== installation.pluginName
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = files_node_require_writable(node);
		if (writable._nay) {
			if (!(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts, node }))) {
				return writable;
			}
			// The passed lock is the file's own direct lock, so release it before archiving —
			// a restore would otherwise refuse the read-only file.
			await public_api_service_uploads_db_release_service_created_locks(ctx, { nodes: [node] });
		}
		await files_nodes_db_archive_nodes(ctx, { nodeIds: [node._id], updatedBy: args.userId, now });
		return Result({ _yay: { archivedNodes: 1 } });
	},
});

type archive_plugin_path_Result =
	typeof archive_plugin_path extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion archive

// #region access

export const set_plugin_access = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * The member the run acts for.
		 */
		userId: v.id("users"),
		runId: v.id("plugins_event_runs"),
		callId: v.id("plugins_event_run_calls"),
		path: v.string(),
		readOnly: v.optional(v.boolean()),
		readScopeId: v.optional(v.union(v.string(), v.null())),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: { kind: "plugin_run", runId: args.runId, callId: args.callId },
			path: args.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}
		const installation = revalidated._yay.installation;
		if (revalidated._yay.pluginRun?.event !== "ui.invoke.requested") {
			return Result({ _nay: { message: "Permission denied" } });
		}
		if (!installation) {
			// Unreachable: the plugin_run branch always resolves an installation.
			throw should_never_happen("plugin access change without an installation", { path: args.path });
		}

		const node = await db_get_active_node_at_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
		});
		if (!node) {
			return Result({ _nay: { message: "Not found" } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (
			!organization?.defaultWorkspaceId ||
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: args.workspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resource: { kind: "file", id: String(node._id), restrictedScopeNodeId: node.restrictedScopeNodeId ?? null },
				userId: args.userId,
				permission: "content.permissions.manage",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = files_node_require_writable(node);
		if (
			writable._nay &&
			!(await public_api_db_can_pass_read_only_for_plugin(ctx, {
				facts: revalidated._yay,
				node,
			}))
		) {
			return writable;
		}
		const binding = await ctx.db
			.query("plugins_file_access_bindings")
			.withIndex("by_node", (q) => q.eq("nodeId", node._id))
			.first();
		if (binding && binding.installationId !== installation._id) {
			return Result({ _nay: { name: "conflict", message: "This item has a different plugin reader binding" } });
		}
		const prepared = await db_prepare_plugin_access(ctx, {
			installation,
			node,
			parentId: node.parentId,
			readOnly: args.readOnly,
			readScopeId: args.readScopeId,
		});
		if (prepared._nay) {
			return prepared;
		}
		const changesBinding =
			prepared._yay.binding &&
			(prepared._yay.binding.readScopeId !== null || prepared._yay.binding.existingBinding !== null);
		if (node.kind === "folder" && (prepared._yay.readOnlyChange !== undefined || changesBinding)) {
			const descendants = await files_nodes_db_collect_descendants(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				parentId: node._id,
			});
			if (
				!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					rootScopeNodeId: node.restrictedScopeNodeId,
					nodes: descendants,
					permission: "content.permissions.manage",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
		}
		await db_apply_plugin_access(ctx, { installation, node, prepared: prepared._yay });

		return Result({ _yay: { nodeId: node._id } });
	},
});

type set_plugin_access_Result =
	typeof set_plugin_access extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion access

// #region http handlers

/**
 * Validate an absolute, already-canonical folder path. The plugin doors refuse non-canonical
 * segments for the same reason the write route does: creation happens verbatim on publish, so a
 * segment the app's own creation flows would reject must never materialize.
 */
function validate_canonical_folder_path(rawPath: string) {
	if (!rawPath.startsWith("/")) {
		return Result({ _nay: { message: "Path must be absolute." } });
	}
	const normalized = server_path_normalize(rawPath);
	if (normalized === "/") {
		return Result({ _nay: { message: "Path must not be the workspace root." } });
	}
	for (const segment of path_extract_segments_from(normalized)) {
		const normalizedSegment = files_normalize_name("folder", segment);
		if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
			return Result({ _nay: { message: "Path contains an invalid folder name." } });
		}
	}

	return Result({ _yay: normalized });
}

const ensure_folder_body_validator = z.object({
	path: z.string(),
	access: z.object({ readOnly: z.boolean().optional(), readScopeId: z.string().nullable().optional() }).optional(),
});

export type public_api_plugin_files_http_ensure_folder_Body = z.infer<typeof ensure_folder_body_validator>;

export async function public_api_plugin_files_http_ensure_folder(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/plugin-folders/ensure",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Settles the consumed plugin call and builds the error body in one step; the
	// caller supplies the matching literal status so the response union stays narrow.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, ensure_folder_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	const validatedPath = validate_canonical_folder_path(body._yay.path);
	if (validatedPath._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: validatedPath._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	const result = (await ctx.runMutation(internal.public_api_plugin_files.ensure_plugin_folder, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.actorUserId,
		runId: principal.runId,
		path: validatedPath._yay,
		...(body._yay.access?.readOnly === undefined ? {} : { readOnly: body._yay.access.readOnly }),
		...(body._yay.access?.readScopeId === undefined ? {} : { readScopeId: body._yay.access.readScopeId }),
	})) as ensure_plugin_folder_Result;
	if (result._nay) {
		if (result._nay.message === "Unauthenticated") {
			return {
				status: 401,
				body: await fail({ status: 401, message: result._nay.message, errorCode: "unauthenticated" }),
			} as const;
		}

		if (result._nay.message === "Permission denied") {
			return {
				status: 403,
				body: await fail({ status: 403, message: result._nay.message, errorCode: "permission_denied" }),
			} as const;
		}
		// The private-space binding refuses a dead readScopeId with "Not found".
		if (result._nay.message === "Not found") {
			return {
				status: 404,
				body: await fail({ status: 404, message: result._nay.message, errorCode: "not_found" }),
			} as const;
		}

		return {
			status: 409,
			body: await fail({ status: 409, message: result._nay.message, errorCode: "conflict" }),
		} as const;
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});
	console.info("Public API plugin folder ensured", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		created: result._yay.created,
	});
	return {
		status: 200,
		body: {
			nodeId: result._yay.nodeId,
			path: result._yay.path,
			created: result._yay.created,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const plugin_archive_body_validator = z.object({
	path: z.string(),
});

export type public_api_plugin_files_http_archive_Body = z.infer<typeof plugin_archive_body_validator>;

export async function public_api_plugin_files_http_archive(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/plugin-archive",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_run", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, plugin_archive_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	if (!body._yay.path.startsWith("/")) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must be absolute.", errorCode: "invalid_input" }),
		} as const;
	}

	const requestedPath = server_path_normalize(body._yay.path);
	if (requestedPath === "/") {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must not be the workspace root.", errorCode: "invalid_input" }),
		} as const;
	}

	let principalRef: Infer<typeof archive_principal_ref_validator>;
	if (principal.kind === "plugin_run") {
		if (!pluginCallId) {
			// Unreachable: public API authorization creates the call for plugin_run principals.
			throw should_never_happen("plugin_run archive without a consumed call", { runId: principal.runId });
		}
		principalRef = { kind: "plugin_run", runId: principal.runId, callId: pluginCallId };
	} else {
		principalRef = { kind: "plugin_service", grantId: principal.grantId };
	}

	const result = (await ctx.runMutation(internal.public_api_plugin_files.archive_plugin_path, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.actorUserId,
		principalRef,
		path: requestedPath,
	})) as archive_plugin_path_Result;
	if (result._nay) {
		if (result._nay.message === "Unauthenticated") {
			return {
				status: 401,
				body: await fail({ status: 401, message: result._nay.message, errorCode: "unauthenticated" }),
			} as const;
		}

		if (result._nay.message === "Permission denied") {
			return {
				status: 403,
				body: await fail({ status: 403, message: result._nay.message, errorCode: "permission_denied" }),
			} as const;
		}

		return {
			status: 409,
			body: await fail({ status: 409, message: result._nay.message, errorCode: "conflict" }),
		} as const;
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});
	console.info("Public API plugin path archived", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		archivedNodes: result._yay.archivedNodes,
	});
	return {
		status: 200,
		body: { archivedNodes: result._yay.archivedNodes },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const plugin_access_body_validator = z.object({
	path: z.string(),
	access: z.object({ readOnly: z.boolean().optional(), readScopeId: z.string().nullable().optional() }),
});

export type public_api_plugin_files_http_set_access_Body = z.infer<typeof plugin_access_body_validator>;

export async function public_api_plugin_files_http_set_access(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/plugin-access/set",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, plugin_access_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	if (!body._yay.path.startsWith("/")) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must be absolute.", errorCode: "invalid_input" }),
		} as const;
	}

	const requestedPath = server_path_normalize(body._yay.path);
	if (requestedPath === "/") {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must not be the workspace root.", errorCode: "invalid_input" }),
		} as const;
	}
	// An access object with nothing to change is a caller mistake, not a no-op.
	if (body._yay.access.readOnly === undefined && body._yay.access.readScopeId === undefined) {
		return {
			status: 400,
			body: await fail({
				status: 400,
				message: "access must set readOnly or readScopeId.",
				errorCode: "invalid_input",
			}),
		} as const;
	}

	if (!pluginCallId) {
		// Unreachable: public API authorization creates the call for plugin_run principals.
		throw should_never_happen("plugin_run access change without a consumed call", { runId: principal.runId });
	}

	const result = (await ctx.runMutation(internal.public_api_plugin_files.set_plugin_access, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.actorUserId,
		runId: principal.runId,
		callId: pluginCallId,
		path: requestedPath,
		...(body._yay.access.readOnly === undefined ? {} : { readOnly: body._yay.access.readOnly }),
		...(body._yay.access.readScopeId === undefined ? {} : { readScopeId: body._yay.access.readScopeId }),
	})) as set_plugin_access_Result;
	if (result._nay) {
		if (result._nay.message === "Unauthenticated") {
			return {
				status: 401,
				body: await fail({ status: 401, message: result._nay.message, errorCode: "unauthenticated" }),
			} as const;
		}

		if (result._nay.message === "Permission denied") {
			return {
				status: 403,
				body: await fail({ status: 403, message: result._nay.message, errorCode: "permission_denied" }),
			} as const;
		}

		if (result._nay.message === "Not found") {
			return {
				status: 404,
				body: await fail({ status: 404, message: result._nay.message, errorCode: "not_found" }),
			} as const;
		}

		return {
			status: 409,
			body: await fail({ status: 409, message: result._nay.message, errorCode: "conflict" }),
		} as const;
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});
	console.info("Public API plugin access changed", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		readOnly: body._yay.access.readOnly ?? null,
		readScopeIdSet: body._yay.access.readScopeId !== undefined,
	});
	return {
		status: 200,
		body: { nodeId: result._yay.nodeId },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

// #endregion http handlers
