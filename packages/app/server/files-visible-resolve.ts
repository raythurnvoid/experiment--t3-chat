// The owner's draft view, read from source tables. Both ordinary reads and durable reads run the
// same program; the latter save unfinished frames instead of treating a budget as a missing path.
//
// Leaf module: only generated types, shared code and other leaf modules belong here.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import type { files_PendingParent, files_PendingTarget, files_VisibleEntry } from "../shared/files.ts";
import { files_saved_placement_db_get_view, type files_saved_placement_View } from "./files-saved-placement.ts";
import {
	files_visible_resolve_machine_create,
	type files_visible_resolve_Store,
} from "./files-visible-resolve-machine.ts";
import {
	files_visible_resolve_program_create,
	type files_visible_resolve_Operation,
	type files_visible_resolve_Resolved,
	type files_visible_resolve_Parent,
	type files_visible_resolve_Value,
	type files_visible_resolve_Facts,
} from "./files-visible-resolve-program.ts";

export type {
	files_visible_resolve_Resolved,
	files_visible_resolve_Parent,
	files_visible_resolve_Operation,
	files_visible_resolve_Facts,
} from "./files-visible-resolve-program.ts";
export type { files_visible_resolve_Store } from "./files-visible-resolve-machine.ts";

/**
 * Resolve the owner's view. Durable callers must validate the same authority and source fence
 * before every step and before using a result. A changed fence invalidates all saved frames.
 */
export function files_visible_resolve_db_create(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		fixedView?: { cohortId: Id<"files_move_cohorts">; view: "before" | "after" };
		currentView?: files_saved_placement_View;
		readLimit?: number;
		stagedPrivateParents?: boolean;
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
		isReviewedArchive?: (proposal: Doc<"files_pending_updates">) => Promise<boolean>;
		includeHidden?: boolean;
		/**
		 * Saved-only callers use the same parent walk without any private claims or proposals.
		 */
		pending?: boolean;
		canReadDestination?: (node: Doc<"files_nodes">) => Promise<boolean>;
		resume?: { store: files_visible_resolve_Store; fence: string };
	},
) {
	const budget = { exhausted: false, readCount: 0, readLimit: args.readLimit ?? 512 };
	let view: Promise<files_saved_placement_View> | null = null;
	const get_view = () =>
		(view ??= args.currentView ? Promise.resolve(args.currentView) : files_saved_placement_db_get_view(db, args));
	const iterators = new Map<string, AsyncIterator<Doc<"files_pending_updates">>>();
	const program = files_visible_resolve_program_create(db, {
		...args,
		getView: get_view,
		// Existing query callers already own their pagination. Their exact claim lookup keeps its
		// iterator; durable jobs use native pages so the source position survives another transaction.
		readMovePage: args.resume
			? undefined
			: async (parent, name, cursor) => {
					const key = JSON.stringify([parent, name]);
					let iterator = iterators.get(key);
					if (cursor === null || !iterator) {
						iterator = db
							.query("files_pending_updates")
							.withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("userId", args.userId)
									.eq("pendingMove.destParent.kind", parent.kind)
									.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id)
									.eq("pendingMove.destName", name),
							)
							[Symbol.asyncIterator]();
						iterators.set(key, iterator);
					}
					const next = await iterator.next();
					if (next.done) iterators.delete(key);
					return { page: next.done ? [] : [next.value], isDone: Boolean(next.done), continueCursor: "next" };
				},
	});
	let machine = files_visible_resolve_machine_create({ program, store: args.resume?.store });

	async function read<T>(run: () => Promise<T>): Promise<T | null> {
		if (budget.readCount >= budget.readLimit) {
			budget.exhausted = true;
			return null;
		}
		budget.readCount++;
		return await run();
	}

	async function run<T>(
		operation: files_visible_resolve_Operation,
		hasReadBudget?: () => Promise<boolean>,
		stepLimit = Number.MAX_SAFE_INTEGER,
	): Promise<T | null> {
		if (budget.exhausted) return null;
		await machine.next();
		const outcome = await machine.run({
			operation,
			fence: args.resume?.fence ?? "query",
			steps: stepLimit,
			readLimit: Math.max(0, budget.readLimit - budget.readCount),
			hasReadBudget,
		});
		if (outcome.status !== "invalidated") budget.readCount += outcome.reads;
		if (outcome.status !== "complete") {
			budget.exhausted = true;
			// Ordinary callers have no continuation. Never retain a half-finished cycle or cached miss.
			if (!args.resume) machine = files_visible_resolve_machine_create({ program });
			return null;
		}
		return outcome.value as T | null;
	}

	async function resume<T extends files_visible_resolve_Operation>(
		operation: T,
		options: { stepLimit?: number; allowPagination?: boolean } = {},
	) {
		if (!args.resume) throw new Error("A durable resolver needs a store and a current fence");
		const outcome = await machine.run({
			operation,
			fence: args.resume.fence,
			steps: options.stepLimit ?? 32,
			readLimit: Math.max(0, budget.readLimit - budget.readCount),
			allowPagination: options.allowPagination,
		});
		if (outcome.status !== "invalidated") budget.readCount += outcome.reads;
		if (outcome.status === "invalidated") return { status: "invalidated" as const };
		if (outcome.status === "unfinished") return { status: "unfinished" as const, paginated: outcome.paginated };
		const value = outcome.value as files_visible_resolve_Value<T>;
		const hidden = value === null || (typeof value === "object" && "hidden" in value && value.hidden);
		return { status: hidden ? ("hidden" as const) : ("resolved" as const), value, paginated: outcome.paginated };
	}

	return {
		get exhausted() {
			return budget.exhausted;
		},
		get readCount() {
			return budget.readCount;
		},
		setReadLimit: (limit: number) => {
			budget.readLimit = limit;
			budget.exhausted = budget.readCount >= limit;
		},
		read,
		getView: get_view,
		fixedView: args.fixedView,
		resume,
		resolve: (target: files_PendingTarget) => run<files_visible_resolve_Resolved>({ kind: "target", target }),
		resolveFacts: (
			target: files_PendingTarget,
			hasReadBudget?: () => Promise<boolean>,
			options?: { claimOnly?: boolean; stepLimit?: number },
		) =>
			run<files_visible_resolve_Facts>(
				{ kind: "facts", target, ...(options?.claimOnly ? { claimOnly: true } : {}) },
				hasReadBudget,
				options?.stepLimit,
			),
		resolveParent: (parent: files_PendingParent) => run<files_visible_resolve_Parent>({ kind: "parent", parent }),
		findSavedMove: (parent: files_PendingParent, name: string) =>
			run<Doc<"files_pending_updates">>({ kind: "move", parent, name, cursor: null }),
		isClaimed: async (node: Doc<"files_nodes">) => Boolean(await run<boolean>({ kind: "claim", node })),
		parentAliases: async (parent: files_PendingParent) =>
			(await run<files_PendingParent[]>({ kind: "aliases", parent })) ?? [],
		findChild: (parent: files_PendingParent, path: string) =>
			run<files_visible_resolve_Resolved>({ kind: "child", parent, path }),
		findPath: (path: string) => run<files_visible_resolve_Resolved>({ kind: "path", path }),
		isCycleMember: (target: files_PendingTarget) =>
			machine.getCachedRecord<boolean>("cycle:" + target.kind + ":" + target.id) === true,
		isBlocked: (parent: files_PendingParent) =>
			parent.kind !== "root" && machine.getCachedRecord("blocked:" + parent.kind + ":" + parent.id) != null,
		getBlockedSavedEntry: (target: files_PendingTarget) =>
			machine.getCachedRecord<{ entry: files_VisibleEntry | null }>("blocked:" + target.kind + ":" + target.id)
				?.entry ?? null,
	};
}
