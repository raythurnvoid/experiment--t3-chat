import { useRef, useMemo, useState, useEffect } from "react";
import { create_promise_with_resolvers, tuple } from "../lib/utils.ts";
import type { ExtractStrict } from "type-fest";

/**
 * A hook that returns a ref that is updated with the latest value of the passed parameter.
 *
 * @param value - The value to update the ref with.
 * @returns A ref that is updated with the latest value of the passed parameter.
 */
export function useLiveRef<T>(value: T) {
	const ref = useRef<T>(value);
	// eslint-disable-next-line react-hooks/refs
	ref.current = value;
	return ref;
}

/**
 * A hook that works similar to useState but returns a ref and provides
 * a setter function that will update the ref and force a re-render.
 *
 * @param initialValue - The initial value of the state.
 *
 * @returns A tuple containing the state and the function to update it.
 */
export function useLiveState<T>(initialValue: T) {
	const [, setState] = useState(initialValue);
	const ref = useRef(initialValue);

	return useMemo(
		() =>
			// eslint-disable-next-line react-hooks/refs
			tuple(ref, (value: T) => {
				if (ref.current === value) return;
				const newValue = typeof value === "function" ? value(ref.current) : value;
				setState(newValue);
				ref.current = newValue;
			}),
		[],
	);
}

/**
 * Hook that provides a ref containing a promise that resolves after each render.
 * The promise is created on each render and resolved via useEffect.
 *
 * @returns A ref object containing a promise that resolves when the render has been committed to the DOM
 *
 * @example
 *
 * const renderPromiseRef = useRenderPromise();
 *
 * const handleSomeAction = async () => {
 *   doSomething();
 *   // Wait for React to commit changes to the DOM
 *   renderPromiseRef.current.then(() => {
 *     // Now DOM is updated, safe to do measurements or manipulations
 *     scrollToElement();
 *   });
 * };
 */
export function useRenderPromise() {
	const [, setDummyState] = useState({});

	// Create a ref to hold our promise
	const promiseWithResolversRef = useRef<PromiseWithResolvers<void>>(null);
	const promiseRef = useRef<Promise<void>>(Promise.resolve()) as React.RefObject<Promise<void>>;

	if (promiseRef.current === null) {
		promiseRef.current = Promise.resolve();
	}

	useEffect(() => {
		// Resolve the promise after DOM updates
		promiseWithResolversRef.current?.resolve();

		// On each render, create a new promise
		const promiseWithResolvers = create_promise_with_resolvers<void>();
		promiseWithResolversRef.current = promiseWithResolvers;
		promiseRef.current = promiseWithResolvers.promise;
	});

	return function () {
		setDummyState({});
		return promiseRef.current;
	};
}

type WatchableValueEventEmitterListenOptions = Omit<
	AddEventListenerOptions,
	ExtractStrict<keyof AddEventListenerOptions, "capture">
>;

class WatchableValueEventEmitter<T> {
	static eventType = "WatchableValueEventEmitter:value";

	eventEmitter = document.createElement("div") as {
		dispatchEvent: HTMLElement["dispatchEvent"];
		addEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: WatchableValueEventEmitterListenOptions,
		) => void;
	};

	constructor() {}

	dispatch(value: T, options?: WatchableValueEventEmitterListenOptions) {
		this.eventEmitter.dispatchEvent(
			new CustomEvent(WatchableValueEventEmitter.eventType, {
				detail: value,
				...options,
			}),
		);
	}

	listen(listener: (value: T) => void, options?: WatchableValueEventEmitterListenOptions) {
		const abortController = new AbortController();

		this.eventEmitter.addEventListener(
			WatchableValueEventEmitter.eventType,
			(event) => {
				listener((event as CustomEvent<T>).detail);
			},
			{
				...options,
				signal: options?.signal ? AbortSignal.any([abortController.signal, options.signal]) : abortController.signal,
			},
		);

		return () => {
			abortController.abort();
		};
	}
}

/**
 * Returns an object that can be used to watch a value or to
 * wait for the first value to be set.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *  // ... component setup
 *
 * 	const watchableValue = useWatchableValue<SomeValue>();
 *
 *  useEffect(() => {
 *    if (!someState) return;
 *
 * 		watchableValue.setValue(someState);
 * 	}, [someState]);
 *
 * 	useEffect(() => {
 * 		watchableValue.firstValuePromise.then((watcher) => {
 *      // Access the first value that was set
 * 			console.info(watcher.firstValue);
 *
 *      // Access the current value
 *      console.info(watcher.getCurrentValue());
 * 		});
 * 	}, []);
 *
 *  useEffect(() => {
 *    const unwatch = watchableValue.watch((value) => {
 *      // Handle the value change
 *      console.info(value);
 *    });
 *
 *    return () => unwatch();
 *  }, []);
 *
 *  // ... rest of the component implementation
 * }
 * ```
 */
export function useWatchableValue<T>(initialValue?: T) {
	const firstValueDeferred = ((/* iife  */) => {
		let deferred: PromiseWithResolvers<{
			/**
			 * The first value that was set.
			 */
			firstValue: T;
			/**
			 * Get the current value.
			 */
			getCurrentValue: () => T;
		}>;

		if (initialValue !== undefined) {
			deferred = {
				promise: Promise.resolve({
					firstValue: initialValue,
					getCurrentValue: () => initialValue,
				}),
				resolve: () => {},
				reject: () => {},
			};
		} else {
			deferred = create_promise_with_resolvers();
		}

		return deferred;
	})();

	const firstValueSet = useRef(initialValue !== undefined ? true : false);

	const currentValue = useRef<T | undefined>(initialValue);

	const eventEmitter = new WatchableValueEventEmitter<T>();

	return {
		/**
		 * A promise that resolves when the first value is set.
		 */
		firstValuePromise: firstValueDeferred.promise,
		/**
		 * Set the value and resolve
		 * the `firstValuePromise` if it hasn't been resolved yet.
		 */
		setValue(value: T) {
			currentValue.current = value;

			eventEmitter.dispatch(value);

			if (!firstValueSet.current) {
				firstValueDeferred.resolve({
					firstValue: value,
					getCurrentValue: () => value,
				});
				firstValueSet.current = true;
			}
		},
		/**
		 * Get the current value.
		 *
		 * To ensure the values has been initialized,
		 * use the `getCurrentValue` function resolved by the `firstValuePromise`.
		 */
		getCurrentValue() {
			return currentValue.current;
		},
		/**
		 * Watch for changes to the value.
		 */
		watch(listener: (value: T) => void, options?: WatchableValueEventEmitterListenOptions) {
			return eventEmitter.listen(listener, options);
		},
	};
}
