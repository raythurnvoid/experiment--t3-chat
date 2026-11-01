// One interval tree per workspace. Its two greatest ends belong to different ops, so a lookup can
// exclude its own op without walking that op's matching paths. All string comparisons stay in JS.

import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { path_tree_prefix_upper_bound } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

type Path = Doc<"files_subtree_op_paths">;

function interval_end(treePath: string) {
	return treePath.endsWith("/") ? path_tree_prefix_upper_bound(treePath) : `${treePath}\0`;
}

function create_reader(ctx: QueryCtx | MutationCtx) {
	const cache = new Map<Id<"files_subtree_op_paths">, Path>();

	async function get(id: Id<"files_subtree_op_paths"> | null) {
		if (id === null) return null;
		const cached = cache.get(id);
		if (cached) return cached;
		const path = await ctx.db.get("files_subtree_op_paths", id);
		if (!path) {
			const errorMessage = "Subtree path tree points to a missing path doc";
			const errorData = { pathId: id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		cache.set(id, path);
		return path;
	}

	async function root(args: Pick<Path, "organizationId" | "workspaceId">) {
		const path = await ctx.db
			.query("files_subtree_op_paths")
			.withIndex("by_organization_workspace_parent", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", null),
			)
			.unique();
		if (path) cache.set(path._id, path);
		return path;
	}

	return { cache, get, root };
}

function create_writer(ctx: MutationCtx) {
	const reader = create_reader(ctx);
	const { get } = reader;

	async function patch(path: Path, fields: Partial<WithoutSystemFields<Path>>) {
		// Unchanged summaries must not make every workspace write touch the root doc.
		if (Object.entries(fields).every(([key, value]) => path[key as keyof Path] === value)) return;
		await ctx.db.patch("files_subtree_op_paths", path._id, fields);
		Object.assign(path, fields);
	}

	async function refresh(path: Path) {
		const [left, right] = await Promise.all([get(path.leftId), get(path.rightId)]);
		const ends = await Promise.all([
			get(left?.maxEndId ?? null),
			get(left?.otherMaxEndId ?? null),
			get(right?.maxEndId ?? null),
			get(right?.otherMaxEndId ?? null),
		]);
		const byOp = new Map<Id<"files_subtree_ops">, Path>();
		for (const candidate of [path, ...ends]) {
			if (!candidate) continue;
			const previous = byOp.get(candidate.opId);
			if (!previous || interval_end(candidate.treePath) > interval_end(previous.treePath))
				byOp.set(candidate.opId, candidate);
		}
		const best = [...byOp.values()].sort((a, b) => {
			const aEnd = interval_end(a.treePath);
			const bEnd = interval_end(b.treePath);
			return aEnd === bEnd ? (a.opId < b.opId ? -1 : 1) : aEnd > bEnd ? -1 : 1;
		});
		await patch(path, {
			height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
			maxEndId: best[0]!._id,
			otherMaxEndId: best[1]?._id ?? null,
		});
	}

	async function rotate(path: Path, direction: "left" | "right") {
		const childKey = direction === "left" ? "rightId" : "leftId";
		const middleKey = direction === "left" ? "leftId" : "rightId";
		const child = (await get(path[childKey]))!;
		const [parent, middle] = await Promise.all([get(path.parentId), get(child[middleKey])]);
		if (parent) await patch(parent, { [parent.leftId === path._id ? "leftId" : "rightId"]: child._id });
		await patch(child, { parentId: path.parentId, [middleKey]: path._id });
		await patch(path, { parentId: child._id, [childKey]: middle?._id ?? null });
		if (middle) await patch(middle, { parentId: path._id });
		await refresh(path);
		await refresh(child);
		return child;
	}

	async function rebalance(id: Id<"files_subtree_op_paths"> | null) {
		while (id !== null) {
			let path = (await get(id))!;
			await refresh(path);
			const [left, right] = await Promise.all([get(path.leftId), get(path.rightId)]);
			const balance = (left?.height ?? 0) - (right?.height ?? 0);
			if (balance > 1) {
				const [outer, inner] = await Promise.all([get(left!.leftId), get(left!.rightId)]);
				if ((inner?.height ?? 0) > (outer?.height ?? 0)) await rotate(left!, "left");
				path = await rotate(path, "right");
			} else if (balance < -1) {
				const [inner, outer] = await Promise.all([get(right!.leftId), get(right!.rightId)]);
				if ((inner?.height ?? 0) > (outer?.height ?? 0)) await rotate(right!, "right");
				path = await rotate(path, "left");
			}
			// A copied successor changes the value behind an existing ref. Even unchanged ref IDs need
			// their full ancestor chain checked before this transaction ends.
			id = path.parentId;
		}
	}

	return { ...reader, patch, rebalance };
}

export async function files_subtree_op_paths_tree_insert(
	ctx: MutationCtx,
	args: Pick<Path, "organizationId" | "workspaceId" | "opId" | "treePath">,
) {
	const existing = await ctx.db
		.query("files_subtree_op_paths")
		.withIndex("by_op_treePath", (q) => q.eq("opId", args.opId).eq("treePath", args.treePath))
		.unique();
	if (existing) return existing._id;

	const tree = create_writer(ctx);
	let path = await tree.root(args);
	let parent: Path | null = null;
	let childKey: "leftId" | "rightId" = "leftId";
	while (path) {
		parent = path;
		childKey =
			args.treePath < path.treePath || (args.treePath === path.treePath && args.opId < path.opId)
				? "leftId"
				: "rightId";
		path = await tree.get(path[childKey]);
	}
	const id = await ctx.db.insert("files_subtree_op_paths", {
		...args,
		parentId: parent?._id ?? null,
		leftId: null,
		rightId: null,
		height: 1,
		maxEndId: null,
		otherMaxEndId: null,
	});
	await tree.patch((await tree.get(id))!, { maxEndId: id });
	if (parent) {
		await tree.patch(parent, { [childKey]: id });
		await tree.rebalance(parent._id);
	}
	return id;
}

/**
 * The caller reads a fresh path doc before each removal. Copying a successor can move another key
 * into this doc, so a batch must not reuse doc IDs captured before earlier removals.
 */
export async function files_subtree_op_paths_tree_delete(ctx: MutationCtx, path: Path) {
	const tree = create_writer(ctx);
	tree.cache.set(path._id, path);
	let removed = path;
	if (path.leftId !== null && path.rightId !== null) {
		removed = (await tree.get(path.rightId))!;
		while (removed.leftId !== null) removed = (await tree.get(removed.leftId))!;
		await tree.patch(path, { opId: removed.opId, treePath: removed.treePath });
	}

	const [parent, child] = await Promise.all([tree.get(removed.parentId), tree.get(removed.leftId ?? removed.rightId)]);
	if (parent) await tree.patch(parent, { [parent.leftId === removed._id ? "leftId" : "rightId"]: child?._id ?? null });
	if (child) await tree.patch(child, { parentId: removed.parentId });
	await ctx.db.delete("files_subtree_op_paths", removed._id);
	tree.cache.delete(removed._id);
	await tree.rebalance(parent?._id ?? null);
}

export async function files_subtree_op_paths_tree_find_blocked(
	ctx: QueryCtx | MutationCtx,
	args: Pick<Path, "organizationId" | "workspaceId"> & {
		treePaths: readonly string[];
		excludeOpId?: Id<"files_subtree_ops">;
	},
) {
	const tree = create_reader(ctx);
	const root = await tree.root(args);
	const blocked: boolean[] = [];
	for (const treePath of args.treePaths) {
		const end = interval_end(treePath);
		let path = root;
		let found = false;
		while (path) {
			if (path.opId !== args.excludeOpId && path.treePath < end && interval_end(path.treePath) > treePath) {
				found = true;
				break;
			}
			const left = await tree.get(path.leftId);
			let maxEnd = await tree.get(left?.maxEndId ?? null);
			if (maxEnd?.opId === args.excludeOpId) maxEnd = await tree.get(left?.otherMaxEndId ?? null);
			// If the left side can overlap, either it contains a match or every right start is too large.
			// Otherwise every eligible left end is before this range, including when the node is excluded.
			path = maxEnd && interval_end(maxEnd.treePath) > treePath ? left : await tree.get(path.rightId);
		}
		blocked.push(found);
	}
	return blocked;
}
