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
import type { files_PendingParent, files_PendingTarget } from "../shared/files.ts";

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

	/**
	 * Check one owner-path child at a time, starting at the caller's already authorized root.
	 */
	async function resume_traversal(
		input: { root: files_PendingParent; rootPath: string; target: files_PendingTarget; path: string },
		options: { stepLimit?: number; allowPagination?: boolean } = {},
	) {
		if (!membership) return { status: "hidden" as const, value: null };
		const resume = args.resume;
		if (!resume) throw new Error("A durable traversal needs a store and a current fence");
		const prefix = input.rootPath === "/" ? "/" : `${input.rootPath}/`;
		if (input.path !== input.rootPath && !input.path.startsWith(prefix))
			return { status: "hidden" as const, value: null };
		const key = `traversal:${JSON.stringify([input.root, input.rootPath])}`;
		const progressKey = `${key}:progress:${input.path}`;
		type Parent = { fence: string; target: files_PendingParent; path: string };
		let parent: Parent = { fence: resume.fence, target: input.root, path: input.rootPath };
		let nextPath = input.path;
		let progress: string | null = null;
		if (input.path !== input.rootPath) {
			progress = await resume.store.get(progressKey);
			const parentPath = input.path.slice(0, input.path.lastIndexOf("/")) || "/";
			const cached =
				progress ??
				(parentPath === input.rootPath ? null : await resume.store.get(`${key}:parent:${parentPath}`));
			if (cached) parent = JSON.parse(cached) as Parent;
			if (parent.fence !== resume.fence) return { status: "invalidated" as const };
			const slash = input.path.indexOf("/", parent.path === "/" ? 1 : parent.path.length + 1);
			nextPath = slash < 0 ? input.path : input.path.slice(0, slash);
		} else if (input.root.kind === "root") return { status: "hidden" as const, value: null };
		// The index already names the candidate. Only its parents need a name lookup.
		const outcome =
			nextPath === input.path
				? await core.resume({ kind: "target", target: input.target }, options)
				: await core.resume({ kind: "child", parent: parent.target, path: nextPath }, options);
		if (outcome.status === "unfinished" || outcome.status === "invalidated") return outcome;
		if (outcome.status === "hidden" || !outcome.value) return { status: "hidden" as const, value: null };
		const value = outcome.value;
		if (value.entry.path !== nextPath) return { status: "hidden" as const, value: null };
		const target: files_PendingTarget =
			value.entry.kind === "saved"
				? { kind: "saved", id: value.entry.node._id }
				: { kind: "private", id: value.entry.node._id };
		if (!(await can_read(value.accessNode)))
			return { status: "locked" as const, path: nextPath, target, kind: value.entry.node.kind };
		if (value.entry.node.kind === "folder") {
			parent = { fence: resume.fence, target, path: nextPath };
			await resume.store.set(`${key}:parent:${nextPath}`, JSON.stringify(parent));
		}
		if (nextPath === input.path) {
			if (progress !== null) await resume.store.delete(progressKey);
			return { status: "resolved" as const, value };
		}
		if (value.entry.node.kind !== "folder") return { status: "hidden" as const, value: null };
		// Core frames keep unfinished lookups. Progress starts after a parent passes its checks.
		await resume.store.set(progressKey, JSON.stringify(parent));
		return { status: "unfinished" as const, paginated: outcome.paginated };
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
		resumeTraversal: resume_traversal,
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
