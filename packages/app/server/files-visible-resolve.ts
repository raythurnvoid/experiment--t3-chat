// The owner's draft view of one node, read from source tables only: saved nodes, drafts, private
// nodes and publish receipts. It never checks access; `files_visible_db_create_reader` adds that.
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules. The
// mutation wrapper's flush uses this core, and a value import of an app module would pull most of
// `convex/` into the wrapper.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import type { files_PendingParent, files_PendingTarget, files_VisibleEntry } from "../shared/files.ts";

/**
 * Resolve targets and parents through the owner's drafts, within one read budget.
 */
export function files_visible_resolve_db_create(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		readLimit?: number;
		/** Review preparation may read children before applying these exact parent deletes. */
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
		/**
		 * Return hidden targets too, with `hidden: true` and their path: a draft delete, a name claim,
		 * an archived saved node, a closed private node, or a hidden ancestor. A target with no path
		 * (a missing ancestor or the 256-node stop) is still null.
		 */
		includeHidden?: boolean;
	},
) {
	const budget = { exhausted: false, readCount: 0, readLimit: args.readLimit ?? 512 };

	async function read<T>(run: () => Promise<T>): Promise<T | null> {
		if (budget.readCount >= budget.readLimit) {
			budget.exhausted = true;
			return null;
		}
		budget.readCount++;
		return await run();
	}

	async function find_saved_move(parent: files_PendingParent, name: string) {
		const moves = db.query("files_pending_updates").withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("pendingMove.destParent.kind", parent.kind)
				.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id)
				.eq("pendingMove.destName", name),
		);
		const iterator = moves[Symbol.asyncIterator]();
		try {
			while (true) {
				const next = await read(() => iterator.next());
				if (!next || next.done) return null;
				// Private claims use the active-node index because discarded proposals can remain until cleanup.
				if (next.value.target.kind === "saved") return next.value;
			}
		} finally {
			await iterator.return?.();
		}
	}

	/**
	 * Whether the owner's draft takes the saved place of this node: an active private node with the
	 * same parent and name, or a draft move of another active saved node onto it.
	 */
	async function is_claimed(node: Doc<"files_nodes">) {
		const parentTarget: files_PendingParent =
			node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
		const parents: files_PendingParent[] = [parentTarget];
		if (parentTarget.kind === "saved") {
			const receipt = await read(() =>
				db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_savedNode", (q) => q.eq("savedNodeId", parentTarget.id))
					.unique(),
			);
			if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
		}

		for (const parent of parents) {
			const privateClaim = await read(() =>
				db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("parent.kind", parent.kind)
							.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
							.eq("state", "active")
							.eq("name", node.name),
					)
					.first(),
			);
			if (privateClaim) return true;

			const moveClaim = await find_saved_move(parent, node.name);
			if (moveClaim && moveClaim.target.id !== node._id && !moveClaim.pendingArchive) {
				const claimantTarget = moveClaim.target;
				const claimant =
					claimantTarget.kind === "saved" ? await read(() => db.get("files_nodes", claimantTarget.id)) : null;
				if (claimant?.archiveOperationId === null) return true;
			}
		}
		return false;
	}

	// The keys being resolved, outermost first.
	const resolving: string[] = [];
	const resolved = new Map<
		string,
		{ entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null; hidden: boolean } | null
	>();
	// A move cycle means the destination does not resolve. Its members fall back to their saved
	// place, now and on every later resolve, so the answer does not depend on the read order.
	const cycleMembers = new Set<string>();
	// The lowest stack index a cycle cut reached in the current work. A node above that index got a
	// temporary null from the cut, so its result is not cached.
	let cycleCutIndex = Infinity;
	// A result cut by the 256-node stop gives no path and is never cached.
	let stopCount = 0;

	async function resolve_parent(
		parent: files_PendingParent,
	): Promise<{ path: string; accessNode: Doc<"files_nodes"> | null; hidden: boolean } | null> {
		if (parent.kind === "root") return { path: "", accessNode: null, hidden: false };
		if (parent.kind === "private") {
			const node = await read(() => db.get("files_pending_nodes", parent.id));
			if (
				node?.state === "published" &&
				node.userId === args.userId &&
				node.organizationId === args.organizationId &&
				node.workspaceId === args.workspaceId
			) {
				const receipt = await read(() =>
					db
						.query("files_pending_node_publish_receipts")
						.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parent.id))
						.unique(),
				);
				if (!receipt) return null;
				return await resolve_parent({ kind: "saved", id: receipt.savedNodeId });
			}
		}

		const result = await resolve(parent);
		if (!result || result.entry.node.kind !== "folder") return null;
		return { path: result.entry.path, accessNode: result.accessNode, hidden: result.hidden };
	}

	async function resolve(
		target: files_PendingTarget,
	): Promise<{ entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null; hidden: boolean } | null> {
		const key = `${target.kind}:${target.id}`;
		if (resolved.has(key)) return resolved.get(key)!;
		const cycleIndex = resolving.indexOf(key);
		if (cycleIndex !== -1) {
			// The cut node and every node above it on the stack form the cycle.
			for (const member of resolving.slice(cycleIndex)) cycleMembers.add(member);
			cycleCutIndex = Math.min(cycleCutIndex, cycleIndex);
			return null;
		}
		if (resolving.length >= 256) {
			stopCount++;
			return null;
		}
		const index = resolving.length;
		resolving.push(key);
		const stopCountBefore = stopCount;
		const cycleCutIndexBefore = cycleCutIndex;
		cycleCutIndex = Infinity;

		const pending = await read(() =>
			db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", args.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.unique(),
		);

		let result: { entry: files_VisibleEntry; accessNode: Doc<"files_nodes"> | null; hidden: boolean } | null = null;
		const deleted = pending?.pendingArchive !== undefined && !args.reviewedArchiveIds?.has(pending._id);
		if (!deleted || args.includeHidden) {
			if (target.kind === "private") {
				const node = await read(() => db.get("files_pending_nodes", target.id));
				if (
					node &&
					pending &&
					(node.state === "active" || args.includeHidden) &&
					node.userId === args.userId &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const parent = await resolve_parent(node.parent);
					if (parent)
						result = {
							entry: { kind: "private", node, pendingUpdate: pending, path: `${parent.path}/${node.name}` },
							accessNode: parent.accessNode,
							hidden: deleted || node.state !== "active" || parent.hidden,
						};
				}
			} else {
				const node = await read(() => db.get("files_nodes", target.id));
				if (
					node &&
					(node.archiveOperationId === null || args.includeHidden) &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const parentTarget: files_PendingParent =
						node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
					const destination =
						pending?.pendingMove && !cycleMembers.has(key)
							? await resolve_parent(pending.pendingMove.destParent)
							: null;
					// A hidden destination, or a cycle found while resolving it, does not resolve. The node falls
					// back to its saved place.
					const movedParent = destination?.hidden === false && !cycleMembers.has(key) ? destination : null;
					const parent = movedParent ?? (await resolve_parent(parentTarget));
					if (parent) {
						const name = movedParent && pending?.pendingMove ? pending.pendingMove.destName : node.name;
						result = {
							entry: { kind: "saved", node, pendingUpdate: pending, path: `${parent.path}/${name}` },
							accessNode: node,
							hidden: deleted || node.archiveOperationId !== null || parent.hidden,
						};

						if (!movedParent && (await is_claimed(node)))
							result = args.includeHidden ? { ...result, hidden: true } : null;
					}
				}
			}
		}

		resolving.pop();
		if (stopCount === stopCountBefore && cycleCutIndex >= index) resolved.set(key, result);
		cycleCutIndex = Math.min(cycleCutIndexBefore, cycleCutIndex);
		return result;
	}

	return {
		get exhausted() {
			return budget.exhausted;
		},
		get readCount() {
			return budget.readCount;
		},
		/** A job reuses a reader across targets and gives it the reads left before each target. */
		setReadLimit: (limit: number) => {
			budget.readLimit = limit;
		},
		read,
		resolve,
		resolveParent: resolve_parent,
		findSavedMove: find_saved_move,
		isClaimed: is_claimed,
		/** Whether a resolve found this target in a move cycle. Ask after resolving it. */
		isCycleMember: (target: files_PendingTarget) => cycleMembers.has(`${target.kind}:${target.id}`),
	};
}
