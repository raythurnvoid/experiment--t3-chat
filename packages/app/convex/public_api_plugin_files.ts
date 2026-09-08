// The plugin file doors behind `/api/v1/files/plugin-folders/ensure`, `/api/v1/files/plugin-archive`,
// and `/api/v1/files/plugin-access/set` (routes in `public_api_plugin_files_http_routes.ts`).
//
// Editable `plugin-name` metadata selects the files and folders a plugin can use.
// Current capabilities, actor and account permissions, and write policies control each operation.

import { v, type Infer } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { z } from "zod";

import { internalMutation, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_can_act_on_file_node, access_control_db_has_permission } from "./access_control.ts";
import {
	files_nodes_db_require_writable,
	files_nodes_db_require_write_policy_management,
	files_nodes_db_set_write_policy,
	type files_nodes_WriteContext,
	files_nodes_db_archive_nodes,
	files_nodes_db_create_node_recursively_at_path,
} from "./files_nodes.ts";
import { files_metadata_db_read_entry } from "./files_metadata.ts";
import {
	public_api_db_revalidate_file_write_principal,
	public_api_db_revalidate_live_plugin_run,
} from "./public_api.ts";
import {
	public_api_service_uploads_db_collect_bounded_descendants,
	public_api_service_uploads_MAX_ARCHIVE_NODES,
} from "./public_api_service_uploads.ts";
import { public_api_authorize_request, public_api_settle_plugin_call_best_effort } from "./public_api_http_auth.ts";
import {
	plugins_data_db_apply_file_access_binding,
	plugins_data_db_prepare_file_access_binding,
} from "./plugins_data.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_normalize_name, files_normalize_special_node_path } from "../shared/files.ts";
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
				.eq("archiveOperationId", null),
		)
		.first();
}

/**
 * Finish access checks before creating a folder or changing its write policy and readers.
 */
async function db_prepare_plugin_access(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		node: Doc<"files_nodes"> | null;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		writeContext: files_nodes_WriteContext;
		readOnly?: boolean;
		readScopeId?: string | null;
	},
) {
	if (!args.installation.acceptedCapabilities.includes("workspace.files.own-access")) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	let writePolicy: Doc<"files_nodes">["writePolicy"] | undefined =
		args.readOnly === undefined
			? undefined
			: args.readOnly
				? { mode: "writer", writer: args.writeContext.writer }
				: null;
	if (args.node && JSON.stringify(writePolicy) === JSON.stringify(args.node.writePolicy)) {
		writePolicy = undefined;
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

	// Existing nodes already passed target management. Only changes affecting descendants need their grants.
	if (!args.node || writePolicy !== undefined || (binding && binding.readScopeId !== null)) {
		const parentNode = args.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.parentId);
		const managed = await files_nodes_db_require_write_policy_management(ctx, {
			organizationId: args.installation.organizationId,
			workspaceId: args.installation.workspaceId,
			writeContext: args.writeContext,
			target: args.node ? { kind: "node", node: args.node } : { kind: "create", parentNode, path: args.path },
			writePolicy: writePolicy === undefined ? (args.node?.writePolicy ?? null) : writePolicy,
		});
		if (managed._nay) {
			return managed;
		}
	}

	return Result({ _yay: { writePolicy, binding } });
}

async function db_apply_plugin_access(
	ctx: MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		node: Doc<"files_nodes">;
		writeContext: files_nodes_WriteContext;
		prepared: NonNullable<Awaited<ReturnType<typeof db_prepare_plugin_access>>["_yay"]>;
	},
) {
	if (args.prepared.writePolicy !== undefined) {
		const managed = await files_nodes_db_set_write_policy(ctx, {
			node: args.node,
			writeContext: args.writeContext,
			writePolicy: args.prepared.writePolicy,
		});
		if (managed._nay) {
			return managed;
		}
	}

	if (args.prepared.binding) {
		await plugins_data_db_apply_file_access_binding(ctx, {
			installation: args.installation,
			node: args.node,
			prepared: args.prepared.binding,
		});
	}

	return Result({ _yay: null });
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

		const segments = path_extract_segments_from(args.path);
		let currentParent: Doc<"files_nodes">["parentId"] = files_ROOT_ID;
		let deepest: Doc<"files_nodes"> | null = null;
		let firstMissingIndex: number | null = null;

		// Stop at the first missing segment; the remaining folders are created after access checks.
		for (const [index, name] of segments.entries()) {
			const existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("parentId", currentParent)
						.eq("name", name)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!existing) {
				firstMissingIndex = index;
				break;
			}
			deepest = existing;
			currentParent = existing._id;
		}

		const writeContext: files_nodes_WriteContext = {
			writer: { kind: "service_account", serviceAccountId: pluginRun.serviceAccountId },
			actorUserId: args.userId,
			policyReach: "ancestors",
			resourceScope:
				firstMissingIndex === null && deepest
					? { kind: "subtree", nodeId: deepest._id }
					: { kind: "create", parentNodeId: deepest?._id ?? files_ROOT_ID, path: args.path },
		};

		// Use the deepest existing node so its restricted-scope grants apply to the actor.
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
		const actor = await ctx.db.get("users", args.userId);
		if (!actorMembership || !actor || actor.deletedAt != null) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const [organization, workspace] = await Promise.all([
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);
		if (!organization?.defaultWorkspaceId || !workspace) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const permissionArgs = {
			organizationId: organization._id,
			workspaceId: workspace._id,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: deepest
				? { kind: "file" as const, id: String(deepest._id), restrictedScopeNodeId: deepest.restrictedScopeNodeId }
				: { kind: "workspace" as const, id: String(workspace._id) },
			permission: "content.write" as const,
		};
		const canWrite =
			(await access_control_db_has_permission(ctx, { ...permissionArgs, userId: args.userId })) &&
			(await access_control_db_has_permission(ctx, {
				...permissionArgs,
				serviceAccountId: pluginRun.serviceAccountId,
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

		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext,
			target:
				firstMissingIndex === null && deepest
					? { kind: "node", node: deepest }
					: { kind: "create", parentNode: deepest, path: args.path },
		});
		if (writable._nay) {
			return writable;
		}

		let nodeId: Id<"files_nodes">;
		let created = false;

		// Existing folders keep the member's metadata, write policy, and sharing. A missing reader
		// binding may be a manual sharing choice; ensure must not recreate it.
		if (firstMissingIndex === null) {
			// The route refuses "/", so the walk always saw at least one segment.
			if (!deepest) {
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
					path: args.path,
					writeContext,
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
				writeContext,
				writePolicy: preparedAccess?.writePolicy,
				createdNodesMetadata: [
					{ key: "source", value: "plugin" },
					{ key: "plugin-name", value: installation.pluginName },
				],
				now,
			});
			if (createdResult._nay) {
				return Result({ _nay: { name: "conflict", message: createdResult._nay.message } });
			}
			nodeId = createdResult._yay;
			created = true;

			if (preparedAccess?.binding) {
				const node = await ctx.db.get("files_nodes", nodeId);
				if (!node) {
					throw should_never_happen("ensured plugin folder is missing right after create", { nodeId });
				}
				await plugins_data_db_apply_file_access_binding(ctx, { installation, node, prepared: preparedAccess.binding });
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
		// Both allowed principal kinds resolve an installation.
		if (!installation) {
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

			// Every descendant must opt in before any policy is cleared or node is archived.
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

			const directPolicyNodes: Array<Doc<"files_nodes">> = [];
			for (const swept of [node, ...descendants]) {
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						serviceAccountId: installation.serviceAccountId,
						fileNode: swept,
						permission: "content.write",
					}))
				) {
					return Result({ _nay: { message: "Permission denied" } });
				}

				const writable = await files_nodes_db_require_writable(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					writeContext: facts.writeContext,
					target: { kind: "node", node: swept },
				});
				if (writable._nay) {
					return writable;
				}

				if (swept.writePolicy !== null) {
					if (!installation.acceptedCapabilities.includes("workspace.files.own-access")) {
						return Result({ _nay: { message: "Permission denied" } });
					}

					const managed = await files_nodes_db_require_write_policy_management(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						writeContext: facts.writeContext,
						target: { kind: "node", node: swept },
						writePolicy: null,
					});
					if (managed._nay) {
						return managed;
					}
					directPolicyNodes.push(swept);
				}
			}

			// Clear only authorized local policies so this archived set can be restored.
			for (const policyNode of directPolicyNodes) {
				const cleared = await files_nodes_db_set_write_policy(ctx, {
					node: policyNode,
					writeContext: facts.writeContext,
					writePolicy: null,
				});
				if (cleared._nay) {
					throw convex_error({ message: "Failed to clear file policy", cause: cleared._nay });
				}
			}

			const activeDescendants = descendants.filter((descendant) => descendant.archiveOperationId === null);
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

		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext: facts.writeContext,
			target: { kind: "node", node },
		});
		if (writable._nay) {
			return writable;
		}

		if (node.writePolicy !== null) {
			if (!installation.acceptedCapabilities.includes("workspace.files.create-read-only")) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			const cleared = await files_nodes_db_set_write_policy(ctx, {
				node,
				writeContext: facts.writeContext,
				writePolicy: null,
			});
			if (cleared._nay) {
				return cleared;
			}
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

		const writeContext = revalidated._yay.writeContext;
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				serviceAccountId: installation.serviceAccountId,
				fileNode: node,
				permission: "content.permissions.manage",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext,
			target: { kind: "node", node },
		});
		if (writable._nay) {
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
			path: args.path,
			writeContext,
			readOnly: args.readOnly,
			readScopeId: args.readScopeId,
		});
		if (prepared._nay) {
			return prepared;
		}
		const applied = await db_apply_plugin_access(ctx, { installation, node, writeContext, prepared: prepared._yay });
		if (applied._nay) {
			return applied;
		}

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
	const normalized = files_normalize_special_node_path("folder", server_path_normalize(rawPath));
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
