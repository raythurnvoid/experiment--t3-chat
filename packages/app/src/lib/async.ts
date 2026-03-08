import { useLayoutEffect, useState } from "react";

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
		(async (/* iife */) => {
			while (this.pendingRun) {
				this.currentRun = this.pendingRun;
				this.pendingRun = null;
				await this.currentRun.task().catch(() => {});
				this.currentRun = null;
			}
		})();
	}

	async run<T>(task: () => Promise<T>) {
		if (this.isDisposed) {
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
	}

	dispose() {
		this.isDisposed = true;
		this.pendingRun?.resolve({ aborted: true });
		this.pendingRun = null;
	}
}
