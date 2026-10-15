// Temporary native rollback proof. Keep all state inside one wrapped mutation.

import type { MutationCtx } from "../convex/_generated/server.js";

type Entry = {
	readonly operation: "insert" | "patch" | "replace" | "delete" | "runAfter" | "runAt" | "cancel";
	readonly id: string;
};
type State = { enabled: boolean; entries: Entry[] };
const STATE = Symbol("files_move_page_proof");
type WrappedCtx = MutationCtx & { [STATE]?: State };

export function files_move_page_proof_db_wrap(ctx: MutationCtx) {
	const state: State = { enabled: false, entries: [] };
	const db = new Proxy(ctx.db, {
		get(target, property) {
			if (property === "insert" || property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const result: unknown = await Reflect.apply(Reflect.get(target, property), target, args);
					if (state.enabled) {
						const tableFirst = property !== "insert" && args.length === (property === "delete" ? 2 : 3);
						const id = property === "insert" ? result : args[tableFirst ? 1 : 0];
						state.entries.push({ operation: property, id: id as string });
					}
					return result;
				};
			const value = Reflect.get(target, property) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const scheduler = new Proxy(ctx.scheduler, {
		get(target, property) {
			if (property === "runAfter" || property === "runAt" || property === "cancel")
				return async (...args: unknown[]) => {
					const result: unknown = await Reflect.apply(Reflect.get(target, property), target, args);
					if (state.enabled)
						state.entries.push({ operation: property, id: (property === "cancel" ? args[0] : result) as string });
					return result;
				};
			const value = Reflect.get(target, property) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db, scheduler, [STATE]: state };
}

/**
 * Enable only after the rollback mutation checks its exact scope and current owner.
 */
export function files_move_page_proof_enable(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[STATE];
	if (!state) throw new Error("Move page proof needs a wrapped mutation");
	state.enabled = true;
}

/**
 * Successful calls in completion order. Values and function arguments are never retained.
 */
export function files_move_page_proof_ledger(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[STATE];
	if (!state) throw new Error("Move page proof needs a wrapped mutation");
	return state.entries.slice();
}
