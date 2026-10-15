// One resolver program for both ordinary reads and saved continuations.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import type { files_PendingParent, files_PendingTarget, files_VisibleEntry } from "../shared/files.ts";
import { server_path_normalize } from "./server-utils.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_publish_receipt,
	files_saved_placement_db_get_publish_receipt_by_saved_node,
	files_saved_placement_db_get_slot,
	type files_saved_placement_FixedView,
	type files_saved_placement_View,
} from "./files-saved-placement.ts";
import type { files_visible_resolve_Effect } from "./files-visible-resolve-machine.ts";

export type files_visible_resolve_Resolved = {
	entry: files_VisibleEntry;
	accessNode: Doc<"files_nodes"> | null;
	hidden: boolean;
	moveApplied: boolean;
	appliedMoveTarget: Extract<files_PendingTarget, { kind: "saved" }> | null;
	destinationAccessNodeIds: Id<"files_nodes">[];
};

export type files_visible_resolve_Parent = Omit<files_visible_resolve_Resolved, "entry"> & { path: string };

export type files_visible_resolve_Operation =
	| { kind: "target"; target: files_PendingTarget }
	| { kind: "facts"; target: files_PendingTarget }
	| { kind: "parent"; parent: files_PendingParent }
	| { kind: "claim"; node: Doc<"files_nodes"> }
	| { kind: "move"; parent: files_PendingParent; name: string; cursor: string | null; probed?: boolean }
	| { kind: "aliases"; parent: files_PendingParent }
	| { kind: "child"; parent: files_PendingParent; path: string }
	| { kind: "path"; path: string; parent?: files_PendingParent; index?: number }
	| { kind: "cycle"; index: number; end: number };

export type files_visible_resolve_Facts = {
	own: files_visible_resolve_Resolved | null;
	parent: files_visible_resolve_Parent | null;
	savedParent: files_visible_resolve_Parent | null;
	claimed: boolean;
	cycle: boolean;
};

export type files_visible_resolve_Value<T extends files_visible_resolve_Operation> = T["kind"] extends "facts"
	? files_visible_resolve_Facts
	: T["kind"] extends "parent"
		? files_visible_resolve_Parent | null
		: T["kind"] extends "claim"
			? boolean
			: T["kind"] extends "move"
				? Doc<"files_pending_updates"> | null
				: T["kind"] extends "aliases"
					? files_PendingParent[]
					: files_visible_resolve_Resolved | null;

type Effect = files_visible_resolve_Effect<files_visible_resolve_Operation>;
type Program<T> = Generator<Effect, T, unknown>;

function* read<T>(run: () => Promise<T>, paginated = false): Program<T> {
	return (yield { kind: "read", run, paginated }) as T;
}

function* call<T>(operation: files_visible_resolve_Operation): Program<T> {
	return (yield { kind: "call", operation }) as T;
}

function* get<T>(key: string): Program<T | null> {
	return (yield { kind: "get", key }) as T | null;
}

function* set(key: string, value: unknown): Program<void> {
	yield { kind: "set", key, value };
}

function key_of(target: files_PendingTarget) {
	return `${target.kind}:${target.id}`;
}

/**
 * Every child call yields its own frame. Local loops cover at most two aliases and five child
 * candidates. The only growing walks (paths, cycles and claim pages) use another saved frame.
 */
export function files_visible_resolve_program_create(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		fixedView?: files_saved_placement_FixedView;
		getView: () => Promise<files_saved_placement_View>;
		stagedPrivateParents?: boolean;
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
		isReviewedArchive?: (proposal: Doc<"files_pending_updates">) => Promise<boolean>;
		includeHidden?: boolean;
		pending?: boolean;
		canReadDestination?: (node: Doc<"files_nodes">) => Promise<boolean>;
		readMovePage?: (
			parent: files_PendingParent,
			name: string,
			cursor: string | null,
		) => Promise<{
			page: Doc<"files_pending_updates">[];
			isDone: boolean;
			continueCursor: string;
		}>;
	},
) {
	function* blocked(parent: files_PendingParent): Program<boolean> {
		return parent.kind !== "root" && (yield* get("blocked:" + key_of(parent))) !== null;
	}

	function* aliases(parent: files_PendingParent): Program<files_PendingParent[]> {
		const parents = [parent];
		if (parent.kind === "saved") {
			const receipt = yield* read(async () =>
				files_saved_placement_db_get_publish_receipt_by_saved_node(
					db,
					{ ...args, savedNodeId: parent.id },
					args.fixedView,
					await args.getView(),
				),
			);
			if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
		}
		return parents;
	}

	function* find_move(
		operation: Extract<files_visible_resolve_Operation, { kind: "move" }>,
	): Program<Doc<"files_pending_updates"> | null> {
		const { parent, name, cursor } = operation;
		const query = () =>
			db.query("files_pending_updates").withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("pendingMove.destParent.kind", parent.kind)
					.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id)
					.eq("pendingMove.destName", name),
			);
		// Empty slots and a single current saved claim need no page. This lets a normal write finish
		// inline even when its caller already used the transaction's one paginated query.
		if (!args.readMovePage && cursor === null && !operation.probed) {
			const first = yield* read(() => query().first());
			if (!first) return null;
			if (first.target.kind === "saved") {
				const selected = first.moveCohortId
					? yield* read(() => files_saved_placement_db_get_proposal(db, first._id, args.fixedView))
					: first;
				if (selected?.pendingMove) return selected;
			}
			yield { kind: "tail", operation: { ...operation, probed: true } };
			return null;
		}
		const page = yield* read(
			() => (args.readMovePage ? args.readMovePage(parent, name, cursor) : query().paginate({ cursor, numItems: 1 })),
			args.readMovePage === undefined,
		);
		const source = page.page[0];
		// Discarded private proposals can remain. The active private-node index owns their claims.
		if (source?.target.kind === "saved") {
			const proposal = source.moveCohortId
				? yield* read(() => files_saved_placement_db_get_proposal(db, source._id, args.fixedView))
				: source;
			if (proposal?.pendingMove) return proposal;
		}
		if (page.isDone) return null;
		yield { kind: "tail", operation: { ...operation, cursor: page.continueCursor } };
		return null;
	}

	function* claim(node: Doc<"files_nodes">): Program<boolean> {
		const parent: files_PendingParent =
			node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
		const parents = yield* call<files_PendingParent[]>({ kind: "aliases", parent });
		for (const alias of parents) {
			const privateClaim = yield* read(() =>
				db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("parent.kind", alias.kind)
							.eq("parent.id", alias.kind === "root" ? undefined : alias.id)
							.eq("state", "active")
							.eq("name", node.name),
					)
					.first(),
			);
			if (privateClaim) {
				const published = yield* read(async () =>
					files_saved_placement_db_get_publish_receipt(
						db,
						{ ...args, privateNodeId: privateClaim._id },
						args.fixedView,
						await args.getView(),
					),
				);
				if (!published) return true;
			}
			const move = yield* call<Doc<"files_pending_updates"> | null>({
				kind: "move",
				parent: alias,
				name: node.name,
				cursor: null,
			});
			if (move && move.target.id !== node._id && !move.pendingArchive && move.target.kind === "saved") {
				const targetId = move.target.id;
				const claimant = yield* read(() => files_saved_placement_db_get_node(db, targetId, args.fixedView));
				if (claimant?.archiveOperationId === null) return true;
			}
		}
		return false;
	}

	function* parent(parent: files_PendingParent): Program<files_visible_resolve_Parent | null> {
		if (parent.kind === "root")
			return {
				path: "",
				accessNode: null,
				hidden: false,
				destinationAccessNodeIds: [],
				moveApplied: false,
				appliedMoveTarget: null,
			};
		if (args.pending === false && parent.kind === "private") return null;
		if (parent.kind === "private") {
			const node = yield* read(() => db.get("files_pending_nodes", parent.id));
			if (
				node &&
				node.userId === args.userId &&
				node.organizationId === args.organizationId &&
				node.workspaceId === args.workspaceId
			) {
				const receipt = yield* read(async () =>
					files_saved_placement_db_get_publish_receipt(
						db,
						{ ...args, privateNodeId: parent.id },
						args.fixedView,
						await args.getView(),
					),
				);
				if (receipt) {
					if (
						args.stagedPrivateParents &&
						args.fixedView?.view === "after" &&
						receipt.moveView?.cohortId === args.fixedView.cohortId &&
						receipt.moveView.view === "after"
					) {
						const saved = yield* read(() => files_saved_placement_db_get_node(db, receipt.savedNodeId, args.fixedView));
						if (
							!saved ||
							saved.kind !== "folder" ||
							saved.moveCohortId !== args.fixedView.cohortId ||
							saved.publishedFromPrivateNodeId !== parent.id ||
							saved.organizationId !== args.organizationId ||
							saved.workspaceId !== args.workspaceId
						)
							return null;
						return {
							path: saved.path,
							accessNode: saved,
							hidden: saved.archiveOperationId !== null,
							destinationAccessNodeIds: [],
							moveApplied: false,
							appliedMoveTarget: null,
						};
					}
					const saved = yield* call<files_visible_resolve_Parent | null>({
						kind: "parent",
						parent: { kind: "saved", id: receipt.savedNodeId },
					});
					if (yield* blocked({ kind: "saved", id: receipt.savedNodeId }))
						yield* set("blocked:" + key_of(parent), { entry: null });
					return saved;
				}
				if (node.state === "published") return null;
			}
		}
		const result = yield* call<files_visible_resolve_Resolved | null>({ kind: "target", target: parent });
		if (!result || result.entry.node.kind !== "folder") return null;
		const { entry, ...rest } = result;
		return { ...rest, path: entry.path };
	}

	function* target(target: files_PendingTarget): Program<files_visible_resolve_Resolved | null> {
		if (args.pending === false && target.kind === "private") return null;
		const key = key_of(target);
		const cached = yield* get<{ value: files_visible_resolve_Resolved | null }>("resolved:" + key);
		if (cached) return cached.value;
		if (target.kind === "private") {
			const receipt = yield* read(async () =>
				files_saved_placement_db_get_publish_receipt(
					db,
					{ ...args, privateNodeId: target.id },
					args.fixedView,
					await args.getView(),
				),
			);
			if (receipt) return yield* call({ kind: "target", target: { kind: "saved", id: receipt.savedNodeId } });
		}
		const depth = (yield { kind: "depth" }) as number;
		const active = yield* get<number>("active:" + key);
		if (active !== null) {
			const cut = yield* get<number>("cut");
			yield* set("cut", cut === null ? active : Math.min(cut, active));
			yield* call({ kind: "cycle", index: active, end: depth });
			return null;
		}
		yield* set("active:" + key, depth);
		const previousCut = yield* get<number>("cut");
		yield* set("cut", null);
		const source =
			args.pending === false
				? null
				: yield* read(() =>
						db
							.query("files_pending_updates")
							.withIndex("by_user_target", (q) =>
								q.eq("userId", args.userId).eq("target.kind", target.kind).eq("target.id", target.id),
							)
							.unique(),
					);
		const pending = source?.moveCohortId
			? yield* read(() => files_saved_placement_db_get_proposal(db, source._id, args.fixedView))
			: source;
		let result: files_visible_resolve_Resolved | null = null;
		let isBlocked = false;
		let savedPlace: files_VisibleEntry | null = null;
		const deleted =
			pending?.pendingArchive !== undefined &&
			!args.reviewedArchiveIds?.has(pending._id) &&
			!(args.isReviewedArchive && (yield* read(() => args.isReviewedArchive!(pending))));
		if (!deleted || args.includeHidden) {
			if (target.kind === "private") {
				const node = yield* read(() => db.get("files_pending_nodes", target.id));
				if (
					node &&
					pending &&
					(node.state === "active" || args.includeHidden) &&
					node.userId === args.userId &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const resolvedParent = yield* call<files_visible_resolve_Parent | null>({
						kind: "parent",
						parent: node.parent,
					});
					if (resolvedParent)
						result = {
							entry: { kind: "private", node, pendingUpdate: pending, path: `${resolvedParent.path}/${node.name}` },
							accessNode: resolvedParent.accessNode,
							hidden: deleted || node.state !== "active" || resolvedParent.hidden,
							destinationAccessNodeIds: resolvedParent.destinationAccessNodeIds,
							moveApplied: false,
							appliedMoveTarget: resolvedParent.appliedMoveTarget,
						};
					else isBlocked = yield* blocked(node.parent);
				}
			} else {
				const node = yield* read(() => files_saved_placement_db_get_node(db, target.id, args.fixedView));
				if (
					node &&
					(node.archiveOperationId === null || args.includeHidden) &&
					node.organizationId === args.organizationId &&
					node.workspaceId === args.workspaceId
				) {
					const parentTarget: files_PendingParent =
						node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
					const cycleBefore = yield* get<boolean>("cycle:" + key);
					const destination =
						pending?.pendingMove && !cycleBefore
							? yield* call<files_visible_resolve_Parent | null>({
									kind: "parent",
									parent: pending.pendingMove.destParent,
								})
							: null;
					const inCycle = yield* get<boolean>("cycle:" + key);
					// Cycles and hidden destinations use the saved place. A denied destination never does.
					const movedParent = destination?.hidden === false && !inCycle ? destination : null;
					isBlocked =
						pending?.pendingMove !== undefined &&
						!inCycle &&
						(movedParent
							? movedParent.accessNode !== null &&
								args.canReadDestination !== undefined &&
								!(yield* read(() => args.canReadDestination!(movedParent.accessNode!)))
							: yield* blocked(pending.pendingMove.destParent));
					const resolvedParent = isBlocked
						? null
						: (movedParent ??
							(yield* call<files_visible_resolve_Parent | null>({ kind: "parent", parent: parentTarget })));
					if (!resolvedParent && !isBlocked) isBlocked = yield* blocked(parentTarget);
					if (isBlocked) savedPlace = { kind: "saved", node, pendingUpdate: pending, path: node.path };
					if (resolvedParent) {
						const name = movedParent && pending?.pendingMove ? pending.pendingMove.destName : node.name;
						result = {
							entry: { kind: "saved", node, pendingUpdate: pending, path: `${resolvedParent.path}/${name}` },
							accessNode: node,
							hidden: deleted || node.archiveOperationId !== null || resolvedParent.hidden,
							moveApplied: movedParent !== null,
							appliedMoveTarget: movedParent ? target : resolvedParent.appliedMoveTarget,
							destinationAccessNodeIds: movedParent
								? [
										...(movedParent.accessNode ? [movedParent.accessNode._id] : []),
										...movedParent.destinationAccessNodeIds,
									]
								: resolvedParent.destinationAccessNodeIds,
						};
						if (args.pending !== false && !movedParent && (yield* call<boolean>({ kind: "claim", node })))
							result = args.includeHidden ? { ...result, hidden: true } : null;
					}
				}
			}
		}
		yield { kind: "delete", key: "active:" + key };
		if (isBlocked) yield* set("blocked:" + key, { entry: savedPlace });
		const cut = yield* get<number>("cut");
		if (cut === null || cut >= depth) yield* set("resolved:" + key, { value: result });
		yield* set("cut", previousCut === null ? cut : cut === null ? previousCut : Math.min(previousCut, cut));
		return result;
	}

	function* child(parent: files_PendingParent, path: string): Program<files_visible_resolve_Resolved | null> {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const candidates = new Map<string, files_PendingTarget>();
		if (parent.kind !== "private") {
			const parentId = parent.kind === "root" ? "root" : parent.id;
			const saved = yield* read(async () =>
				files_saved_placement_db_get_slot(db, { ...args, parentId, name }, args.fixedView, await args.getView()),
			);
			if (saved) candidates.set(saved._id, { kind: "saved", id: saved._id });
		}
		const parents = args.pending === false ? [] : yield* call<files_PendingParent[]>({ kind: "aliases", parent });
		for (const alias of parents) {
			const node = yield* read(() =>
				db
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
			if (node) candidates.set(node._id, { kind: "private", id: node._id });
			const move = yield* call<Doc<"files_pending_updates"> | null>({
				kind: "move",
				parent: alias,
				name,
				cursor: null,
			});
			if (move) candidates.set(move.target.id, move.target);
		}
		let current: files_visible_resolve_Resolved | null = null;
		for (const candidate of candidates.values()) {
			const result = yield* call<files_visible_resolve_Resolved | null>({ kind: "target", target: candidate });
			if (result?.entry.path !== path) continue;
			if (current && (current.entry.kind !== result.entry.kind || current.entry.node._id !== result.entry.node._id))
				return null;
			current = result;
		}
		return current;
	}

	return function* program(operation: files_visible_resolve_Operation): Program<unknown> {
		switch (operation.kind) {
			case "target":
				return yield* target(operation.target);
			case "facts": {
				const own = yield* call<files_visible_resolve_Resolved | null>({ kind: "target", target: operation.target });
				const target = operation.target;
				const node =
					target.kind === "saved"
						? yield* read(() => files_saved_placement_db_get_node(db, target.id, args.fixedView))
						: yield* read(() => db.get("files_pending_nodes", target.id));
				const source = yield* read(() =>
					db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", args.userId).eq("target.kind", target.kind).eq("target.id", target.id),
						)
						.unique(),
				);
				const pending = source?.moveCohortId
					? yield* read(() => files_saved_placement_db_get_proposal(db, source._id, args.fixedView))
					: source;
				const parentTarget =
					target.kind === "private" && node && "parent" in node ? node.parent : pending?.pendingMove?.destParent;
				const resolvedParent = parentTarget
					? yield* call<files_visible_resolve_Parent | null>({ kind: "parent", parent: parentTarget })
					: null;
				const savedParent =
					target.kind === "saved" && node && "parentId" in node
						? yield* call<files_visible_resolve_Parent | null>({
								kind: "parent",
								parent: node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId },
							})
						: null;
				const claimed =
					target.kind === "saved" &&
					node &&
					"parentId" in node &&
					node.archiveOperationId === null &&
					!pending?.pendingArchive &&
					!own?.moveApplied
						? yield* call<boolean>({ kind: "claim", node })
						: false;
				const cycle = (yield* get<boolean>("cycle:" + key_of(target))) === true;
				return { own, parent: resolvedParent, savedParent, claimed, cycle } satisfies files_visible_resolve_Facts;
			}
			case "parent":
				return yield* parent(operation.parent);
			case "claim": {
				const key = "claimed:" + operation.node._id;
				const cached = yield* get<{ value: boolean }>(key);
				if (cached) return cached.value;
				const value = yield* claim(operation.node);
				yield* set(key, { value });
				return value;
			}
			case "move":
				return yield* find_move(operation);
			case "aliases":
				return yield* aliases(operation.parent);
			case "child":
				return yield* child(operation.parent, operation.path);
			case "cycle": {
				if (operation.index >= operation.end) return null;
				const frame = (yield { kind: "frame", depth: operation.index }) as files_visible_resolve_Operation | null;
				if (frame?.kind === "target") yield* set("cycle:" + key_of(frame.target), true);
				yield { kind: "tail", operation: { ...operation, index: operation.index + 1 } };
				return null;
			}
			case "path": {
				const parts = server_path_normalize(operation.path).split("/").filter(Boolean);
				const index = operation.index ?? 0;
				if (index >= parts.length) return null;
				const result = yield* call<files_visible_resolve_Resolved | null>({
					kind: "child",
					parent: operation.parent ?? { kind: "root" },
					path: "/" + parts.slice(0, index + 1).join("/"),
				});
				if (!result || index === parts.length - 1) return result;
				if (result.entry.node.kind !== "folder") return null;
				const nextParent: files_PendingParent =
					result.entry.kind === "saved"
						? { kind: "saved", id: result.entry.node._id }
						: { kind: "private", id: result.entry.node._id };
				yield { kind: "tail", operation: { ...operation, parent: nextParent, index: index + 1 } };
				return null;
			}
		}
	};
}
