import { delay } from "../../shared/async-utils.ts";
import { useLayoutEffect, useMemo, useState } from "react";

export { delay };

/**
 * Create a deferred object with a status property.
 *
 * @example
 * ```ts
 * const deferred = create_deferred<string>();
 * deferred.status; // "pending"
 * ```
 */
export function create_deferred<T>() {
	const createDeferred = () => {
		const deferred = Object.assign(Promise.withResolvers<T>(), {
			status: "pending" as "pending" | "resolved" | "rejected",

			value: undefined as T | undefined,
			error: undefined as unknown,

			/**
			 * If the deferred is not pending, replace the promise and
			 * set the status to pending.
			 */
			reset: () => {
				if (deferred.status !== "pending") {
					Object.assign(deferred, createDeferred());
				}
			},
		});

		deferred.promise = deferred.promise
			.then((value) => {
				deferred.status = "resolved";
				deferred.value = value;
				deferred.error = undefined;
				return value;
			})
			.catch((error) => {
				deferred.status = "rejected";
				deferred.error = error;
				deferred.value = undefined;
				return error;
			});

		return deferred;
	};

	return createDeferred();
}

/**
 * Tracks a promise value by promise identity.
 *
 * Returns `undefined` while pending and throws the rejection during render.
 * `promise` identity must change whenever the promise inputs change.
 */
export function usePromiseValue<T>(promise: Promise<T>) {
	const [request, setRequest] = useState(() => ({
		promise,
		deferred: create_deferred<T>(),
	}));

	// Ensure the deferred is generated as soon as the promise changes.
	const currentRequest =
		promise === request.promise
			? request
			: {
					promise,
					deferred: create_deferred<T>(),
				};

	// Ensure the state is updated before paint
	useLayoutEffect(() => {
		let isDisposed = false;

		const deferred = currentRequest.deferred;
		setRequest(currentRequest);
		promise
			.then((value) => {
				if (isDisposed) return;
				deferred.resolve(value);
			})
			.catch((error) => {
				if (isDisposed) return;
				deferred.reject(error);
			})
			.finally(() => {
				if (isDisposed) return;
				// Force a re-render.
				setRequest({ ...currentRequest, deferred: { ...deferred } });
			});

		return () => {
			isDisposed = true;
		};
	}, [promise]);

	if (currentRequest.deferred.status === "rejected") {
		throw currentRequest.deferred.error instanceof Error
			? currentRequest.deferred.error
			: new Error("Error while resolving promise value", {
					cause: currentRequest.deferred.error,
				});
	}

	if (currentRequest.deferred.status === "resolved") {
		return currentRequest.deferred.value;
	}

	return undefined;
}

/**
 * Returns a promise that resolves after a given timeout.
 *
 * A new promise is returned each time the `key` or `timeout` changes.
 *
 * @example
 * ```ts
 * const delayed = useDelay({ timeout: 1000, key: someQuery });
 * ```
 */
export function useDelay(key: any, timeout = 100) {
	const timeoutPromise = useMemo(() => delay(timeout), [timeout, key]);
	return usePromiseValue(timeoutPromise);
}

/**
 * Runs one task at a time while keeping only the latest pending task.
 *
 * If a newer task is queued while another task is already pending, the older
 * pending task resolves with `{ aborted: true }`.
 *
 * `dispose()` only aborts the pending task. The current in-flight task is
 * allowed to finish.
 */
export class CoalescedRunner {
	private pendingRun: ReturnType<typeof this.createRun<any>> | null = null;
	private currentRun: ReturnType<typeof this.createRun<any>> | null = null;
	private activeFlushCount = 0;
	private isDisposed = false;

	private createRun<T>(task: () => Promise<T>) {
		const deferred = Promise.withResolvers<{ aborted: true } | { aborted: false; value: T }>();
		return Object.assign(deferred, {
			task: () =>
				task()
					.then((value) => deferred.resolve({ aborted: false as const, value }))
					.catch((error) => deferred.reject(error)),
		});
	}

	private drain() {
		Promise.try(async () => {
			while (this.pendingRun) {
				this.currentRun = this.pendingRun;
				this.pendingRun = null;
				await this.currentRun.task().catch(() => {});
				this.currentRun = null;
			}
		}).catch((e) => console.error(e));
	}

	async run<T>(task: () => Promise<T>) {
		if (this.isDisposed || this.activeFlushCount > 0) {
			return { aborted: true as const };
		}

		const nextRun = this.createRun(task);

		if (this.pendingRun) {
			this.pendingRun?.resolve({ aborted: true });
		}

		this.pendingRun = nextRun;

		if (!this.currentRun) {
			this.drain();
		}

		return nextRun.promise;
	}

	async flush() {
		this.activeFlushCount += 1;

		try {
			while (true) {
				if (this.isDisposed) {
					return { aborted: true as const };
				}

				// Resolve only once both the current run and the latest pending run have drained.
				if (!this.currentRun && !this.pendingRun) {
					return { aborted: false as const, value: undefined };
				}

				// wait one microtask so `drain()` can advance the runner state before we check again.
				await Promise.resolve();
			}
		} finally {
			this.activeFlushCount -= 1;
		}
	}

	dispose() {
		this.isDisposed = true;
		this.pendingRun?.resolve({ aborted: true });
		this.pendingRun = null;
	}
}

/**
 * Like `Promise.allSettled(items.map(run))`, but runs at most `limit` items at the same time.
 * Items start in FIFO order: when one finishes, the next queued item starts. Results keep the
 * input order and rejections never stop the other items. A `limit` below 1 behaves as 1.
 */
export async function async_all_settled_with_limit<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
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
