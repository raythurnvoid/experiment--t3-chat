// Saved resolver frames. Each frame keeps only its own calls; descendants have separate docs.

export type files_visible_resolve_Store = {
	get: (key: string) => Promise<string | null>;
	set: (key: string, value: string) => Promise<void>;
	delete: (key: string) => Promise<void>;
};

export type files_visible_resolve_Effect<Operation> =
	| { kind: "read"; run: () => Promise<unknown>; paginated?: boolean }
	| { kind: "call" | "tail"; operation: Operation }
	| { kind: "get"; key: string }
	| { kind: "set"; key: string; value: unknown }
	| { kind: "delete"; key: string }
	| { kind: "depth" }
	| { kind: "frame"; depth: number };

type Frame<Operation> = { operation: Operation; results: unknown[] };
type Head = { fence: string; operation: string; depth: number; complete: boolean; result?: unknown };

/**
 * Run the same resolver program in memory or across transactions. Recreating a generator replays
 * only that frame's recorded local calls. It never repeats a database read or walks old descendants.
 */
export function files_visible_resolve_machine_create<Operation>(args: {
	program: (operation: Operation) => Generator<files_visible_resolve_Effect<Operation>, unknown, unknown>;
	store?: files_visible_resolve_Store;
}) {
	const memory = new Map<string, string>();
	const records = new Map<string, unknown>();
	const store = args.store ?? {
		get: async (key: string) => memory.get(key) ?? null,
		set: async (key: string, value: string) => {
			memory.set(key, value);
		},
		delete: async (key: string) => {
			memory.delete(key);
		},
	};
	async function get<T>(key: string): Promise<T | null> {
		const value = await store.get(key);
		return value === null ? null : (JSON.parse(value) as T);
	}
	async function set(key: string, value: unknown) {
		// Contributor lists do not affect paths or access. Keep them out of durable structural work.
		await store.set(
			key,
			JSON.stringify(
				value,
				args.store ? (key, value: unknown) => (key === "threadIds" ? undefined : value) : undefined,
			),
		);
	}

	async function run(input: {
		operation: Operation;
		fence: string;
		steps: number;
		readLimit: number;
		allowPagination?: boolean;
		hasReadBudget?: () => Promise<boolean>;
	}) {
		let head = await get<Head>("head");
		if (head && head.fence !== input.fence) return { status: "invalidated" as const };
		const operationKey = JSON.stringify(input.operation, (_key, value: unknown) =>
			value !== null && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
				: value,
		);
		if (head && head.operation !== operationKey) {
			if (!head.complete) throw new Error("Finish the current resolver operation before starting another");
			head = null;
		}
		if (!head) {
			head = { fence: input.fence, operation: operationKey, depth: 0, complete: false };
			await set("frame:0", { operation: input.operation, results: [] });
		}
		// Saved results are not a new page in this call.
		let paginated = false;
		let reads = 0;
		for (let step = 0; !head.complete && step < input.steps; step++) {
			const frame = await get<Frame<Operation>>(`frame:${head.depth}`);
			if (!frame) throw new Error("Resolver frame is missing");
			const program = args.program(frame.operation);
			let next = program.next();
			for (const result of frame.results) {
				if (next.done) throw new Error("Resolver frame no longer matches its program");
				next = program.next(result);
			}
			if (next.done) {
				await store.delete(`frame:${head.depth}`);
				if (head.depth === 0) {
					head.complete = true;
					head.result = next.value;
				} else {
					head.depth--;
					const parent = await get<Frame<Operation>>(`frame:${head.depth}`);
					if (!parent) throw new Error("Resolver parent frame is missing");
					parent.results.push(next.value);
					await set(`frame:${head.depth}`, parent);
				}
				continue;
			}
			const effect = next.value;
			if (effect.kind === "call") {
				head.depth++;
				await set(`frame:${head.depth}`, { operation: effect.operation, results: [] });
				continue;
			}
			if (effect.kind === "tail") {
				await set(`frame:${head.depth}`, { operation: effect.operation, results: [] });
				continue;
			}
			let result: unknown = null;
			if (effect.kind === "read") {
				if (reads >= input.readLimit) break;
				if (effect.paginated && (paginated || input.allowPagination === false)) break;
				// A selected-view helper can read several docs. Check the caller's real budget too.
				if (input.hasReadBudget && !(await input.hasReadBudget())) break;
				if (effect.paginated) paginated = true;
				result = await effect.run();
				reads++;
			} else if (effect.kind === "get") {
				result = await get(`record:${effect.key}`);
				records.set(effect.key, result);
			} else if (effect.kind === "set") {
				await set(`record:${effect.key}`, effect.value);
				records.set(effect.key, effect.value);
			} else if (effect.kind === "delete") {
				await store.delete(`record:${effect.key}`);
				records.delete(effect.key);
			} else if (effect.kind === "depth") result = head.depth;
			else if (effect.kind === "frame")
				result = (await get<Frame<Operation>>(`frame:${effect.depth}`))?.operation ?? null;
			frame.results.push(result ?? null);
			await set(`frame:${head.depth}`, frame);
		}
		await set("head", head);
		return head.complete
			? { status: "complete" as const, value: head.result, reads, paginated }
			: { status: "unfinished" as const, reads, paginated };
	}

	return {
		run,
		/**
		 * Keep target memo records when starting the next operation in the same view.
		 */
		async next() {
			await store.delete("head");
		},
		getCachedRecord: <T>(key: string) => records.get(key) as T | undefined,
	};
}
