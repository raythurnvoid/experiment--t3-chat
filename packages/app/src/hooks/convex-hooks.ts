// Source:
// convex-helpers (https://github.com/get-convex/convex-helpers)
// hooks (useStableQuery/useSingleFlight/useLatestValue/useTypingIndicator)

import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FunctionReference } from "convex/server";

/**
 * Drop-in replacement for `useQuery` that keeps the previous result while new args load.
 * Useful when query args change often (e.g., dynamic ID lists) to avoid `undefined` flicker.
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
	query: Query,
	...queryArgs: OptionalRestArgsOrSkip<Query>
) {
	// eslint-disable-next-line react-hooks/todo
	const result = useQuery(query, ...queryArgs);
	const stored = useRef(result);

	if (result !== undefined) {
		stored.current = result;
	}

	return stored.current;
}

/**
 * Ensures only one async invocation of `fn` runs at a time; while in-flight, queues
 * the latest call and drops intermediate ones. Subsequent callers get the Promise of
 * the next execution.
 */
export function useSingleFlight<F extends (...args: any[]) => Promise<any>>(fn: F) {
	const flightStatus = useRef<{
		inFlight: boolean;
		upNext: null | {
			fn: F;
			resolve: (value: unknown) => void;
			reject: (reason?: any) => void;
			args: Parameters<F>;
		};
	}>({
		inFlight: false,
		upNext: null,
	});

	return useCallback(
		(...args: Parameters<F>): ReturnType<F> => {
			if (flightStatus.current.inFlight) {
				return new Promise((resolve, reject) => {
					flightStatus.current.upNext = { fn, resolve, reject, args };
				}) as ReturnType<F>;
			}
			flightStatus.current.inFlight = true;
			const firstReq = fn(...args) as ReturnType<F>;
			void (async () => {
				await firstReq.finally(() => {
					// continue
				});

				while (flightStatus.current.upNext) {
					const cur = flightStatus.current.upNext;
					flightStatus.current.upNext = null;
					await cur
						.fn(...cur.args)
						.then(cur.resolve)
						.catch(cur.reject);
				}
				flightStatus.current.inFlight = false;
			})();
			return firstReq;
		},
		[fn],
	);
}

/**
 * Returns a pair of functions: `nextValue` (awaits the next update) and `updateValue`
 * (pushes a new value). Each `nextValue` resolves once per `updateValue` call.
 */
export function useLatestValue<T>() {
	const initial = useMemo(() => {
		const [promise, resolve] = makeSignal();
		return { data: undefined as T, promise, resolve };
	}, []);
	const ref = useRef(initial);

	const nextValue = useCallback(async () => {
		await ref.current.promise;
		const [promise, resolve] = makeSignal();
		ref.current.promise = promise;
		ref.current.resolve = resolve;
		return ref.current.data;
	}, []);

	const updateValue = useCallback((data: T) => {
		ref.current.data = data;
		ref.current.resolve();
	}, []);

	return [nextValue, updateValue] as const;
}

/**
 * Simple typing indicator helper: sets `typing` true while text is non-empty, then
 * auto-clears after 1s of inactivity.
 */
export function useTypingIndicator(text: string, updateMyPresence: (p: { typing?: boolean }) => void) {
	useEffect(() => {
		if (text.length === 0) {
			updateMyPresence({ typing: false });
			return;
		}
		updateMyPresence({ typing: true });
		const timer = setTimeout(() => updateMyPresence({ typing: false }), 1000);
		return () => clearTimeout(timer);
	}, [updateMyPresence, text]);
}

function makeSignal() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return [promise, resolve] as const;
}
