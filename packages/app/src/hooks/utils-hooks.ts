import { useRef } from "react";

/**
 * A hook that returns a ref that is updated with the latest value of the passed parameter.
 *
 * @param value - The value to update the ref with.
 * @returns A ref that is updated with the latest value of the passed parameter.
 */
export function useLiveRef<T>(value: T) {
	const ref = useRef<T>(value);
	ref.current = value;
	return ref;
}
