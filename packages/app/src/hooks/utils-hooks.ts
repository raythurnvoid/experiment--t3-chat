import { useRef, useMemo, useState, useEffect } from "react";
import { create_promise_with_resolvers, tuple } from "../lib/utils.ts";

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
