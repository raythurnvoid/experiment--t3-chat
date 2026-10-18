// Current saved and private reads, with one reader's access checks.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_db_get_path_access } from "../server/files.ts";
import { files_visible_resolve_db_create, type files_visible_resolve_Store } from "../server/files-visible-resolve.ts";
import {
	files_saved_placement_db_get_node,
	type files_saved_placement_FixedView,
} from "../server/files-saved-placement.ts";
import type { files_PendingTarget } from "../shared/files.ts";

/**
 * Reuse parent and permission reads within one query, leaving room for its own work.
 */
export async function files_visible_db_create_reader(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		fixedView?: files_saved_placement_FixedView;
		readLimit?: number;
		resume?: { store: files_visible_resolve_Store; fence: string };
		pending?: boolean;
		/**
		 * Review preparation may read children before applying these exact parent deletes.
		 */
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
		isReviewedArchive?: (proposal: Doc<"files_pending_updates">) => Promise<boolean>;
	},
) {
	// A draft move into a folder the user can no longer read hides the node and everything under it,
	// like listings do, so a path never names that folder.
	const core = files_visible_resolve_db_create(ctx.db, { ...args, canReadDestination: can_read });

	const membership = await core.read(() =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.first(),
	);

	const readableByScope = new Map<string, Promise<boolean>>();
	async function can_read(node: Doc<"files_nodes"> | null) {
		if (!membership) return false;
		// Added people change access inside a scope, so the key is the pair.
		const key = node ? `${node.restrictedScopeNodeId ?? ""}:${node.extendedScopeNodeId ?? ""}` : "workspace";
		let readable = readableByScope.get(key);
		if (!readable) {
			readable = access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.read",
				fileNode: node ?? undefined,
			}).then((result) => !result._nay);
			readableByScope.set(key, readable);
		}
		return await readable;
	}

	async function resume_visible(
		operation: { kind: "target"; target: files_PendingTarget } | { kind: "path"; path: string },
		options: { stepLimit?: number; allowPagination?: boolean } = {},
	) {
		if (!membership) return { status: "hidden" as const, value: null };
		const outcome = await core.resume(operation, options);
		if (outcome.status === "unfinished" || outcome.status === "invalidated") return outcome;
		if (outcome.status === "hidden" || !outcome.value || !(await can_read(outcome.value.accessNode)))
			return { status: "hidden" as const, value: null };
		return { status: "resolved" as const, value: outcome.value };
	}

	async function resolve_target(target: files_PendingTarget) {
		if (!membership) return null;
		const result = await core.resolve(target);
		return result && (await can_read(result.accessNode)) ? result.entry : null;
	}

	async function resolve_path(path: string) {
		if (!membership) return null;
		const result = await core.findPath(path);
		return result && (await can_read(result.accessNode)) ? result.entry : null;
	}

	/**
	 * Why a path this reader cannot show is not there: a saved item the user cannot open is `locked`.
	 * A saved item that a draft moved away or deleted is `missing`, like the draft view shows it.
	 */
	async function path_access(path: string) {
		if (!membership) return { status: "missing" as const };
		const access = await files_db_get_path_access(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			subject: { kind: "user", userId: args.userId, plugin: null },
			path,
		});
		return access.status === "locked" ? access : { status: "missing" as const };
	}

	return {
		active: membership !== null,
		view: await core.getView(),
		get exhausted() {
			return core.exhausted;
		},
		read: core.read,
		fixedView: args.fixedView,
		resolve: core.resolve,
		resolveParent: core.resolveParent,
		isBlocked: core.isBlocked,
		findPath: core.findPath,
		findChild: core.findChild,
		parentAliases: core.parentAliases,
		canRead: can_read,
		resumeTarget: (target: files_PendingTarget, options?: { stepLimit?: number; allowPagination?: boolean }) =>
			resume_visible({ kind: "target", target }, options),
		resumePath: (path: string, options?: { stepLimit?: number; allowPagination?: boolean }) =>
			resume_visible({ kind: "path", path }, options),
		resolveTarget: resolve_target,
		/**
		 * Like `resolveTarget`, but tells a locked saved node from a missing one, so a caller can answer
		 * Permission denied. A locked `node` is set only when its parent folder can be opened.
		 */
		async resolveTargetAccess(target: files_PendingTarget) {
			const entry = await resolve_target(target);
			if (entry) return { status: "found" as const, entry };
			if (target.kind !== "saved") return { status: "missing" as const };
			const node = await files_saved_placement_db_get_node(ctx.db, target.id, args.fixedView);
			if (
				!node ||
				node.organizationId !== args.organizationId ||
				node.workspaceId !== args.workspaceId ||
				node.archiveOperationId !== null
			)
				return { status: "missing" as const };
			return await path_access(node.path);
		},
		/**
		 * Like `resolveTarget`, but a readable saved node that a blocked draft move hides still counts, at
		 * its saved place. Save checks use it: a document inside that moved folder, or one that only links
		 * to media there, must still save as before.
		 */
		async resolveTargetForSave(target: files_PendingTarget) {
			if (!membership) return null;
			const result = await core.resolve(target);
			if (result) return (await can_read(result.accessNode)) ? result.entry : null;
			const saved = core.getBlockedSavedEntry(target);
			return saved?.kind === "saved" && (await can_read(saved.node)) ? saved : null;
		},
		resolvePath: resolve_path,
		/** Like `resolvePath`, but tells a locked path from a missing one. */
		async resolvePathAccess(path: string) {
			const entry = await resolve_path(path);
			return entry ? { status: "found" as const, entry } : await path_access(path);
		},
	};
}
