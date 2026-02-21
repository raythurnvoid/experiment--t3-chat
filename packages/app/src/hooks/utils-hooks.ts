import { useRef, useState, useEffect, type SetStateAction, type Dispatch } from "react";
import { tuple } from "../lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { Result } from "../lib/errors-as-values-utils.ts";

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
 * Dramatically improves performance by returning a stable reference to a function
 * that can be passed down as prop to children components avoiding unnecessary re-renders.
 *
 * @example
 * ```tsx
 * const handleClick = useFn<MyIconButton_Props["onClick"]>(() => {
 * 	console.log("clicked", someUnstableValue.val);
 * });
 *
 * // in the template:
 * <MyIconButton onClick={handleClick} />
 * ```
 *
 */
export function useFn<T extends null | undefined | ((...args: any[]) => any)>(handler: T) {
	const handlerRef = useLiveRef(handler);
	return (...args: Parameters<NonNullable<T>>) => handlerRef.current?.(...args);
}

/**
 * Returns the latest computed value for each render.
 *
 * Useful when reading values from stable object instances so the value is re-evaluated on every render.
 *
 * @example
 * ```tsx
 * const itemData = useVal(() => item.getItemData());
 * ```
 */
export function useVal<T>(value: () => T) {
	return value();
}

function is_update_function<T>(value: T | ((oldValue: T) => T)): value is (oldValue: T) => T {
	return typeof value === "function";
}

/**
 * A hook that works similar to useState but returns a ref and provides
 * a setter function that will update the ref and force a re-render.
 *
 * @param initialValue - The initial value of the state.
 *
 * @returns A tuple containing the state and the function to update it.
 */
export function useStateRef<T>(initialValue: T) {
	const ref = useRef(initialValue);
	const [state, setState] = useState(initialValue);

	const [res] = useState(() =>
		tuple(
			ref,

			(value: T | ((oldValue: T) => T)) => {
				if (ref.current === value) return;
				const newValue = is_update_function(value) ? value(ref.current) : value;
				setState(newValue);
				ref.current = newValue;
			},
			state,
		),
	);

	// eslint-disable-next-line react-hooks/immutability
	res[2] = state;

	return res;
}

/**
 * A hook that works like `useState`, but automatically reverts back to the initial value after a timeout.
 *
 * The setter behaves like `setState`, with one addition: you can optionally pass a `timeoutMs`
 * to override the default timeout for that specific update.
 *
 * @param initialState - The initial state value (or lazy initializer).
 * @param timeoutMs - The default timeout (in ms) before reverting to the initial value.
 *
 * @example
 * ```tsx
 * const [isCopied, setIsCopied] = useAutoRevertingState(false);
 *
 * const handleCopy = () => {
 * 	navigator.clipboard
 * 		.writeText("Hello")
 * 		.then(() => setIsCopied(true))
 * 		.catch(console.error);
 * };
 *
 * return (
 * 	<MyIconButton tooltip={isCopied ? "Copied" : "Copy"} onClick={handleCopy}>
 * 		{isCopied ? <Check /> : <Copy />}
 * 	</MyIconButton>
 * );
 * ```
 */
export function useAutoRevertingState<T>(
	initialState: T | (() => T),
	timeoutMs?: number,
): [T, Dispatch<SetStateAction<T>>];
export function useAutoRevertingState<T = undefined>(
	initialState?: T | (() => T),
	timeoutMs?: number,
): [T | undefined, Dispatch<SetStateAction<T | undefined>>];
export function useAutoRevertingState<T = undefined>(
	initialState?: T | (() => T),
	timeoutMs = 2000,
): [T | undefined, Dispatch<SetStateAction<T | undefined>>] {
	const timeoutMsProp = timeoutMs;

	const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const [state, setState] = useState(initialState);
	const initialValueRef = useRef(state);

	const setStateAndRevert = (value: Parameters<typeof setState>[0], timeoutMs = timeoutMsProp) => {
		setState(value);

		if (timeoutIdRef.current !== undefined) {
			clearTimeout(timeoutIdRef.current);
			timeoutIdRef.current = undefined;
		}

		timeoutIdRef.current = setTimeout(() => {
			setState(initialValueRef.current);
		}, timeoutMs);
	};

	useEffect(() => {
		return () => {
			if (timeoutIdRef.current !== undefined) {
				clearTimeout(timeoutIdRef.current);
				timeoutIdRef.current = undefined;
			}
		};
	}, []);

	return [state, setStateAndRevert];
}

/**
 * Returns a debounced version of a value.
 *
 * @param value - The input value to debounce.
 * @param timeoutMs - Optional debounce timeout in milliseconds.
 */
export function useDebounce<T>(value: T, timeoutMs?: number) {
	const [debouncedValue, setDebouncedValue] = useState(value);

	useEffect(() => {
		const timeoutId = setTimeout(() => {
			setDebouncedValue(value);
		}, timeoutMs);

		return () => {
			clearTimeout(timeoutId);
		};
	}, [value, timeoutMs]);

	return debouncedValue;
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
	if (promiseWithResolversRef.current === null) {
		promiseWithResolversRef.current = Promise.withResolvers<void>();
	}

	useEffect(() => {
		// Resolve the promise after DOM updates
		promiseWithResolversRef.current?.resolve();

		// On each render, create a new promise
		const promiseWithResolvers = Promise.withResolvers<void>();
		promiseWithResolversRef.current = promiseWithResolvers;
	});

	return {
		tick: () => {
			setDummyState({});
			return promiseWithResolversRef.current?.promise;
		},
		wait: async (options?: { signal?: AbortSignal }) => {
			const promise = new Promise<{ aborted: boolean }>((resolve, reject) => {
				const handleAbort = () => {
					resolve({ aborted: true });
				};
				options?.signal?.addEventListener("abort", handleAbort, { once: true });

				promiseWithResolversRef.current?.promise
					.then(() => resolve({ aborted: false }))
					.catch(reject)
					.finally(() => options?.signal?.removeEventListener("abort", handleAbort));
			});

			const pResult = await promise;

			if (pResult.aborted) {
				return Result({ _nay: { name: "nay_abort", message: options?.signal?.reason?.message ?? "Aborted" } });
			}

			return Result({ _yay: null });
		},
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
			deferred = Promise.withResolvers();
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

export function useForceRender() {
	const [, setState] = useState({});
	return () => setState({});
}

export function useAsyncEffect(effect: (signal: AbortSignal) => Promise<void>, dependencies: any[]) {
	useEffect(() => {
		const abortController = new AbortController();

		effect(abortController.signal).catch(console.error);

		return () => {
			abortController.abort();
		};
	}, dependencies);
}
