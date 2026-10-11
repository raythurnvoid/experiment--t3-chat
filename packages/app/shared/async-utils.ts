/**
 * Resolve after a given number of milliseconds.
 */
export function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Like `Promise.allSettled(items.map(run))`, but runs at most `limit` items at the same time.
 * Items start in FIFO order: when one finishes, the next queued item starts. Results keep the
 * input order and rejections never stop the other items. A `limit` below 1 behaves as 1.
 */
export async function async_all_settled_with_limit<T, R>(args: {
	items: readonly T[];
	limit: number;
	run: (item: T, index: number) => Promise<R>;
}): Promise<PromiseSettledResult<R>[]> {
	const { items, limit, run } = args;

	const results: PromiseSettledResult<R>[] = new Array(items.length);
	// Every worker pulls from this one shared iterator, which is what keeps the order FIFO.
	const queue = items.entries();

	async function run_worker() {
		for (const [index, item] of queue) {
			try {
				results[index] = { status: "fulfilled", value: await run(item, index) };
			} catch (error) {
				results[index] = { status: "rejected", reason: error };
			}
		}
	}

	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workerCount }, run_worker));
	return results;
}
