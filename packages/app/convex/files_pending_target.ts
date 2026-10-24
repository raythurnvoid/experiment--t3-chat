// Current saved and private Pending views. Content writers use the same access checks.

import { query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { app_convex_Doc } from "../src/lib/app-convex-client.ts";
import app_convex_schema, { files_pending_target_validator } from "./schema.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import {
	files_pending_nodes_db_get_ancestry,
	files_pending_nodes_db_can_save_to_copied_parent,
	files_pending_nodes_db_resolve_read_target,
} from "./files_pending_nodes_db.ts";
import { files_db_get_pending_update, files_DRAFT_IDLE_EXPIRY_MS } from "../server/files.ts";
import { files_saved_placement_db_get_proposal } from "../server/files-saved-placement.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { path_join, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { convex_error } from "../server/convex-utils.ts";
import { files_PENDING_PATH_TOO_DEEP_MESSAGE, type files_PendingTarget } from "../shared/files.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

/**
 * Private content follows its current saved parent's access and write policy.
 */
export async function files_pending_target_db_get_private(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: app_convex_Doc<"organizations_workspaces_users">;
		privateNodeId: Id<"files_pending_nodes">;
		pendingUpdateId?: Id<"files_pending_updates">;
		recoveryRead?: true;
	},
) {
	const scope = {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.membership.userId,
	};
	const ancestry = await files_pending_nodes_db_get_ancestry(ctx, {
		...scope,
		privateNodeId: args.privateNodeId,
		allowArchivedParent: args.recoveryRead,
	});
	if (ancestry._nay) return ancestry;
	const pendingUpdate = await files_db_get_pending_update(ctx, {
		...scope,
		target: { kind: "private", id: args.privateNodeId },
		pendingUpdateId: args.pendingUpdateId,
	});
	if (!pendingUpdate) return Result({ _nay: { message: "Not found" } });
	const accessArgs = {
		userAuth: { id: scope.userId },
		membership: args.membership,
		fileNode: ancestry._yay.savedParent ?? undefined,
	};
	const readable = await access_control_db_authorize_membership(ctx, { ...accessArgs, permission: "content.read" });
	if (readable._nay) return readable;
	const writable = await access_control_db_authorize_membership(ctx, { ...accessArgs, permission: "content.write" });
	const policy = ancestry._yay.savedParent
		? await files_nodes_db_require_user_writable(ctx, {
				node: ancestry._yay.savedParent,
				userId: scope.userId,
			})
		: null;
	const createIntent = pendingUpdate.createIntent;
	const ready =
		!pendingUpdate.preparation &&
		createIntent !== undefined &&
		(createIntent.kind !== "text" || pendingUpdate.content?.base.kind === "new");
	const parentArchived = ancestry._yay.savedParent?.archiveOperationId != null;
	if (parentArchived && !ready) return Result({ _nay: { message: "Not found" } });
	const canSave =
		!parentArchived &&
		!writable._nay &&
		(!policy?._nay ||
			(ancestry._yay.savedParent !== null &&
				(await files_pending_nodes_db_can_save_to_copied_parent(ctx, {
					membership: args.membership,
					node: ancestry._yay.ancestors.at(-1) ?? ancestry._yay.node,
					savedParent: ancestry._yay.savedParent,
				}))));
	return Result({
		_yay: {
			...ancestry._yay,
			pendingUpdate,
			readiness: ready ? ("ready" as const) : ("preparing" as const),
			canEdit: !parentArchived && !writable._nay && !policy?._nay,
			canAccept: ready && canSave && ancestry._yay.ancestors.length === 0,
			canAcceptWithParents: ready && canSave,
		},
	});
}

const pending_target_entry_validator = v.union(
	v.object({
		kind: v.literal("saved"),
		node: doc(app_convex_schema, "files_nodes"),
		pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		path: v.string(),
	}),
	v.object({
		kind: v.literal("private"),
		node: doc(app_convex_schema, "files_pending_nodes"),
		pendingUpdate: doc(app_convex_schema, "files_pending_updates"),
		path: v.string(),
	}),
);

/**
 * The draft folders a draft file still needs, outermost first. Save creates them in this order.
 * The list never returns these folders as rows, so `threadIds` tells Discard all which chat made
 * each one.
 */
const required_parents_validator = v.array(
	v.object({
		target: v.object({ kind: v.literal("private"), id: v.id("files_pending_nodes") }),
		path: v.string(),
		pendingUpdateId: v.id("files_pending_updates"),
		reviewedRevision: v.number(),
		threadIds: v.optional(v.array(v.id("ai_chat_threads"))),
	}),
);

const pending_target_view_validator = v.object({
	kind: v.literal("entry"),
	entry: pending_target_entry_validator,
	readiness: v.union(v.literal("preparing"), v.literal("ready")),
	canEdit: v.boolean(),
	canAccept: v.boolean(),
	canAcceptWithParents: v.boolean(),
	/**
	 * A saved move whose path goes through a folder the user can no longer read. Path reads hide the
	 * node, but this entry shows it at its saved place, so its path is not the destination, and Accept
	 * would fail.
	 */
	moveDestinationUnreadable: v.boolean(),
	requiredParents: required_parents_validator,
	// The saved folder the pending chain hangs from, for the header's breadcrumb. `null` at the root.
	savedParentId: v.union(v.id("files_nodes"), v.null()),
	recovery: v.optional(v.object({ savedParentId: v.id("files_nodes"), expiresAt: v.number() })),
	copyDestination: v.optional(v.object({ folderPath: v.string(), personal: v.boolean(), replacement: v.boolean() })),
});

export async function files_pending_target_db_get_view(
	ctx: QueryCtx,
	args: {
		membership: app_convex_Doc<"organizations_workspaces_users">;
		target: files_PendingTarget;
		reader: Awaited<ReturnType<typeof files_visible_db_create_reader>>;
	},
) {
	const { membership, target, reader } = args;
	const userAuth = { id: membership.userId };
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};

	if (target.kind === "private") {
		const resolved = await reader.resolve(target);
		if (reader.exhausted) throw convex_error({ message: files_PENDING_PATH_TOO_DEEP_MESSAGE });
		if (!resolved) {
			const data = await files_pending_target_db_get_private(ctx, {
				membership,
				privateNodeId: target.id,
				recoveryRead: true,
			});
			if (data._nay || !data._yay.savedParent?.archiveOperationId) return null;
			const { node, pendingUpdate, ancestors, savedParent } = data._yay;
			let path = savedParent.path;
			const requiredParents = [];
			for (const parent of ancestors.toReversed()) {
				path = path_join(path, parent.name);
				const proposal = await files_db_get_pending_update(ctx, {
					...scope,
					target: { kind: "private", id: parent._id },
				});
				if (!proposal) return null;
				requiredParents.push({
					target: { kind: "private" as const, id: parent._id },
					path,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
					...(proposal.threadIds ? { threadIds: proposal.threadIds } : {}),
				});
			}
			// The owner is reading this, so the draft also lives 4 hours past their last heartbeat.
			const lastActive = await ctx.db
				.query("users_last_active")
				.withIndex("by_user", (q) => q.eq("userId", userAuth.id))
				.unique();
			return {
				kind: "entry" as const,
				entry: { kind: "private" as const, node, pendingUpdate, path: path_join(path, node.name) },
				readiness: "ready" as const,
				canEdit: false,
				canAccept: false,
				canAcceptWithParents: false,
				moveDestinationUnreadable: false,
				requiredParents,
				savedParentId: savedParent._id,
				recovery: {
					savedParentId: savedParent._id,
					expiresAt: Math.max(pendingUpdate.expiresAt, (lastActive?.lastActiveAt ?? 0) + files_DRAFT_IDLE_EXPIRY_MS),
				},
			};
		}
		if (!resolved || resolved.entry.kind !== "private" || !(await reader.canRead(resolved.accessNode))) return null;
		const { entry, accessNode } = resolved;

		const writable = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			fileNode: accessNode ?? undefined,
			permission: "content.write",
		});
		const policy = accessNode
			? await files_nodes_db_require_user_writable(ctx, {
					node: accessNode,
					userId: membership.userId,
				})
			: null;

		const ready =
			!entry.pendingUpdate.preparation &&
			entry.pendingUpdate.createIntent !== undefined &&
			(entry.pendingUpdate.createIntent.kind !== "text" || entry.pendingUpdate.content?.base.kind === "new");
		const canEdit = !writable._nay && !policy?._nay;
		// The draft folders above this draft, nearest first. The reader resolved this chain already, so
		// this walk reads only a saved folder's publish receipt.
		const parents = [];
		let parent = entry.node.parent;
		while (parent.kind === "private") {
			const parentEntry = (await reader.resolve(parent))?.entry;
			if (parentEntry?.kind !== "private") break;
			parents.push(parentEntry);
			parent = parentEntry.node.parent;
		}
		const parentId = parent.kind === "private" ? parent.id : null;
		const receipt = parentId
			? await reader.read(() =>
					ctx.db
						.query("files_pending_node_publish_receipts")
						.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parentId))
						.unique(),
				)
			: null;
		const savedParentId = parent.kind === "saved" ? parent.id : (receipt?.savedNodeId ?? null);
		const savedParentEntry = savedParentId ? (await reader.resolve({ kind: "saved", id: savedParentId }))?.entry : null;
		if (reader.exhausted) throw convex_error({ message: files_PENDING_PATH_TOO_DEEP_MESSAGE });
		const savedParent = savedParentEntry?.kind === "saved" ? savedParentEntry.node : null;
		const canSave =
			canEdit ||
			(!writable._nay &&
				savedParent !== null &&
				(await files_pending_nodes_db_can_save_to_copied_parent(ctx, {
					membership,
					node: parents.at(-1)?.node ?? entry.node,
					savedParent,
				})));
		const requiredParents = [];
		let parentsReady = true;
		// Review only the folders this file needs, in publish order. Siblings stay pending.
		for (const parentEntry of parents.toReversed()) {
			// A parent that is still preparing, or is no longer a folder draft, blocks the whole save.
			if (parentEntry.pendingUpdate.preparation || parentEntry.pendingUpdate.createIntent?.kind !== "folder") {
				parentsReady = false;
				break;
			}
			requiredParents.push({
				target: { kind: "private" as const, id: parentEntry.node._id },
				path: parentEntry.path,
				pendingUpdateId: parentEntry.pendingUpdate._id,
				reviewedRevision: parentEntry.pendingUpdate.revision,
				...(parentEntry.pendingUpdate.threadIds ? { threadIds: parentEntry.pendingUpdate.threadIds } : {}),
			});
		}

		return {
			kind: "entry" as const,
			entry,
			readiness: ready ? ("ready" as const) : ("preparing" as const),
			canEdit,
			// Save this draft alone only when every parent folder above it is already saved.
			canAccept: ready && canSave && parents.length === 0,
			// Otherwise the user can save it together with the draft folders listed below.
			canAcceptWithParents: ready && canSave && parentsReady,
			moveDestinationUnreadable: false,
			requiredParents,
			savedParentId: savedParent?._id ?? null,
		};
	}

	const readable = await access_control_db_authorize_node(ctx, {
		userAuth,
		membership,
		nodeId: target.id,
		permission: "content.read",
	});
	if (readable._nay) return null;
	const node = readable._yay.fileNode;

	const physicalPendingUpdate = await files_db_get_pending_update(ctx, { ...scope, target });
	const pendingUpdate = physicalPendingUpdate
		? await files_saved_placement_db_get_proposal(ctx.db, physicalPendingUpdate._id)
		: null;
	const writable = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		fileNode: node,
		permission: "content.write",
	});
	const policy = await files_nodes_db_require_user_writable(ctx, {
		node,
		userId: membership.userId,
	});

	const canEdit = !writable._nay && !policy._nay;
	const destination = pendingUpdate?.pendingMove?.destParent;
	const destinationNode =
		destination?.kind === "private" ? await ctx.db.get("files_pending_nodes", destination.id) : null;

	const visibleEntry = await reader.resolveTarget(target);
	if (reader.exhausted) throw convex_error({ message: files_PENDING_PATH_TOO_DEEP_MESSAGE });
	// The reader hides a move whose path goes through a folder the user can no longer read. The row
	// still shows the node at its saved place, says so, and keeps Accept off.
	const moveDestinationUnreadable = destination !== undefined && reader.isBlocked(target);

	return {
		kind: "entry" as const,
		entry: {
			kind: "saved" as const,
			node,
			pendingUpdate,
			// Review still names an archived, replaced or blocked source that the normal tree hides.
			path: visibleEntry?.path ?? node.path,
		},
		readiness: "ready" as const,
		canEdit,
		canAccept: canEdit && destinationNode?.state !== "active" && !moveDestinationUnreadable,
		canAcceptWithParents: canEdit && destinationNode?.state !== "active" && !moveDestinationUnreadable,
		moveDestinationUnreadable,
		requiredParents: [],
		savedParentId: null,
	};
}

// Source access can change after Copy. Keep its stored proof, but hide stale source details on reads.
export async function files_pending_target_db_redact_copy_source(
	ctx: QueryCtx,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	const { copiedFrom } = pendingUpdate;
	if (!copiedFrom) return pendingUpdate;
	const source =
		copiedFrom.target.kind === "saved"
			? await ctx.db.get("files_nodes", copiedFrom.target.id)
			: await ctx.db.get("files_pending_nodes", copiedFrom.target.id);
	const sourceScope = source ? files_db_resolve_scope(ctx, source.workspaceId) : null;
	if (source && !organizations_is_global_organization_id(source.organizationId) && sourceScope?.kind === "workspace") {
		const workspace = await ctx.db.get("organizations_workspaces", sourceScope.workspaceId);
		if (workspace && workspace.pluginDataPurgeStartedAt === undefined) {
			const scope = {
				organizationId: source.organizationId,
				workspaceId: sourceScope.workspaceId,
				userId: pendingUpdate.userId,
			};
			const reader = await files_visible_db_create_reader(ctx, scope);
			const target = await files_pending_nodes_db_resolve_read_target(ctx, { ...scope, target: copiedFrom.target });
			const visible = target ? await reader.resolveTarget(target) : null;
			// A rename must not reveal the old location either.
			if (visible?.path === copiedFrom.path) {
				return { ...pendingUpdate, copiedFrom: { target: copiedFrom.target, path: copiedFrom.path } };
			}
		}
	}
	return { ...pendingUpdate, copiedFrom: undefined };
}

async function db_get_public_pending_target_view(
	ctx: QueryCtx,
	view: NonNullable<Awaited<ReturnType<typeof files_pending_target_db_get_view>>>,
) {
	const { entry } = view;
	const pendingUpdate = entry.pendingUpdate;
	const organization = pendingUpdate?.copiedFrom
		? await ctx.db.get("organizations", pendingUpdate.organizationId)
		: null;
	const copyDestination = organization
		? {
				folderPath: `/${path_extract_segments_from(entry.path).slice(0, -1).join("/")}`,
				personal: organization.default,
				replacement: entry.kind === "saved",
			}
		: undefined;
	return {
		...view,
		entry:
			entry.kind === "private"
				? { ...entry, pendingUpdate: await files_pending_target_db_redact_copy_source(ctx, entry.pendingUpdate) }
				: {
						...entry,
						pendingUpdate: pendingUpdate ? await files_pending_target_db_redact_copy_source(ctx, pendingUpdate) : null,
					},
		...(copyDestination ? { copyDestination } : {}),
	};
}

export const get_file_pending_target = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: v.object({ kind: v.union(v.literal("saved"), v.literal("private")), id: v.string() }),
	},
	returns: v.union(
		v.object({
			entry: pending_target_entry_validator,
			readiness: v.union(v.literal("preparing"), v.literal("ready")),
			canEdit: v.boolean(),
			canAccept: v.boolean(),
			canAcceptWithParents: v.boolean(),
			moveDestinationUnreadable: pending_target_view_validator.fields.moveDestinationUnreadable,
			requiredParents: required_parents_validator,
			// The saved folder the pending chain hangs from, for the header's breadcrumb. `null` at the root.
			savedParentId: v.union(v.id("files_nodes"), v.null()),
			recovery: pending_target_view_validator.fields.recovery,
			copyDestination: pending_target_view_validator.fields.copyDestination,
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		let target: files_PendingTarget;
		if (args.target.kind === "saved") {
			const id = ctx.db.normalizeId("files_nodes", args.target.id);
			if (!id) return null;
			target = { kind: "saved", id };
		} else {
			const id = ctx.db.normalizeId("files_pending_nodes", args.target.id);
			if (!id) return null;
			target = { kind: "private", id };
		}
		const scope = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		};
		// The Pending tab loads each row's view with its own query, so this budget is per row. The worst
		// row measured costs 1,285 ranges in all: an archived draft 255 folders deep. The reader stops at
		// 2,048 reads, which leaves about 2,000 of Convex's 4,096 ranges for reads outside it. A row past
		// the limit throws, and the Pending tab shows a short message on that row only.
		const reader = await files_visible_db_create_reader(ctx, { ...scope, readLimit: 2048 });
		// An old private link keeps working after Save. Null means the file is gone.
		const readTarget = await files_pending_nodes_db_resolve_read_target(ctx, { ...scope, target });
		if (!readTarget) return null;
		const rawView = await files_pending_target_db_get_view(ctx, { membership, target: readTarget, reader });
		const view = rawView ? await db_get_public_pending_target_view(ctx, rawView) : null;
		return view
			? {
					entry: view.entry,
					readiness: view.readiness,
					canEdit: view.canEdit,
					canAccept: view.canAccept,
					canAcceptWithParents: view.canAcceptWithParents,
					moveDestinationUnreadable: view.moveDestinationUnreadable,
					requiredParents: view.requiredParents,
					savedParentId: view.savedParentId,
					...(view.recovery ? { recovery: view.recovery } : {}),
					...(view.copyDestination ? { copyDestination: view.copyDestination } : {}),
				}
			: null;
	},
});

export type files_pending_target_get_file_pending_target_Result =
	typeof get_file_pending_target extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// Keep this read here, not in files_pending_updates.ts. Opening a file waits on it, and that module
// loads about 5 MB of code on a cold call.
export const get_file_pending_update = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: files_pending_target_validator,
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.object({
			...doc(app_convex_schema, "files_pending_updates").fields,
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
			currentPendingContentVersion: v.union(v.number(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		if (args.target.kind === "private") {
			const data = await files_pending_target_db_get_private(ctx, {
				membership,
				privateNodeId: args.target.id,
				pendingUpdateId: args.pendingUpdateId,
				recoveryRead: true,
			});
			return data._nay
				? null
				: {
						...(await files_pending_target_db_redact_copy_source(ctx, data._yay.pendingUpdate)),
						currentYjsLastSequenceId: null,
						currentPendingContentVersion: null,
					};
		}
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.target.id,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		const physicalPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			target: args.target,
			pendingUpdateId: args.pendingUpdateId,
		});
		const pendingUpdate = physicalPendingUpdate
			? await files_saved_placement_db_get_proposal(ctx.db, physicalPendingUpdate._id)
			: null;
		if (!pendingUpdate) {
			return null;
		}
		return {
			...(await files_pending_target_db_redact_copy_source(ctx, pendingUpdate)),
			currentYjsLastSequenceId: authorized._yay.fileNode.yjsLastSequenceId ?? null,
			currentPendingContentVersion: authorized._yay.fileNode.pendingContentVersion,
		};
	},
});
