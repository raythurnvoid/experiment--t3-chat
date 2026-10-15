// Current saved and private reads, with one reader's access checks.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_visible_resolve_db_create } from "../server/files-visible-resolve.ts";
import {
	files_saved_placement_db_get_publish_receipt_by_saved_node,
	files_saved_placement_db_get_slot,
	type files_saved_placement_FixedView,
} from "../server/files-saved-placement.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import { path_name_of } from "../shared/paths.ts";
import type { files_PendingTarget, files_PendingParent } from "../shared/files.ts";

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
		const key = node?.restrictedScopeNodeId ?? "workspace";
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

	async function parent_aliases(parent: files_PendingParent) {
		const parents = [parent];
		if (parent.kind === "saved") {
			const receipt = await core.read(async () =>
				files_saved_placement_db_get_publish_receipt_by_saved_node(
					ctx.db,
					{ ...args, savedNodeId: parent.id },
					args.fixedView,
					await core.getView(),
				),
			);
			if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
		}
		return parents;
	}

	/**
	 * The one visible child of `parent` at `path` (the parent's path plus the child's name).
	 */
	async function find_child(parent: files_PendingParent, path: string) {
		const name = path_name_of(path);
		const candidates = new Map<string, files_PendingTarget>();
		if (parent.kind !== "private") {
			const parentId = parent.kind === "root" ? "root" : parent.id;
			const saved = await core.read(async () =>
				files_saved_placement_db_get_slot(ctx.db, { ...args, parentId, name }, args.fixedView, await core.getView()),
			);
			if (saved) candidates.set(saved._id, { kind: "saved", id: saved._id });
		}

		for (const alias of await parent_aliases(parent)) {
			const privateNode = await core.read(() =>
				ctx.db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("parent.kind", alias.kind)
							.eq("parent.id", alias.kind === "root" ? undefined : alias.id)
							.eq("state", "active")
							.eq("name", name),
					)
					.first(),
			);
			if (privateNode) candidates.set(privateNode._id, { kind: "private", id: privateNode._id });
			const move = await core.findSavedMove(alias, name);
			if (move) candidates.set(move.target.id, move.target);
		}

		let current: Awaited<ReturnType<typeof core.resolve>> = null;
		for (const target of candidates.values()) {
			const result = await core.resolve(target);
			if (result?.entry.path !== path) continue;
			// A published private alias and its saved slot name the same node until cleanup.
			if (current && (current.entry.kind !== result.entry.kind || current.entry.node._id !== result.entry.node._id))
				return null;
			current = result;
		}
		return current;
	}

	async function find_path(path: string) {
		const segments = server_path_normalize(path).split("/").filter(Boolean);
		let parent: files_PendingParent = { kind: "root" };
		let current: Awaited<ReturnType<typeof core.resolve>> = null;

		for (let index = 0; index < segments.length; index++) {
			current = await find_child(parent, `/${segments.slice(0, index + 1).join("/")}`);
			if (!current || (index < segments.length - 1 && current.entry.node.kind !== "folder")) return null;
			parent =
				current.entry.kind === "saved"
					? { kind: "saved", id: current.entry.node._id }
					: { kind: "private", id: current.entry.node._id };
		}

		return current;
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
		findPath: find_path,
		findChild: find_child,
		parentAliases: parent_aliases,
		canRead: can_read,
		async resolveTarget(target: files_PendingTarget) {
			if (!membership) return null;
			const result = await core.resolve(target);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
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
		async resolvePath(path: string) {
			if (!membership) return null;
			const result = await find_path(path);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
		},
	};
}
