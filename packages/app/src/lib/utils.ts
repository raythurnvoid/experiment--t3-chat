import { clsx, type ClassValue } from "clsx";
import type { CSSProperties } from "react";
import { twMerge } from "tailwind-merge";
import type { KeysOfUnion, Primitive } from "type-fest";

export * from "../../shared/shared-utils.ts";

/**
 * Useful to make it easier to concat class names in react components
 **/
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function sx(style: CSSPropertiesX) {
	return style;
}

export type CSSPropertiesX = CSSProperties & Record<string, string | number | undefined | null>;

/**
 * Delay for a given number of milliseconds.
 *
 * @example
 *
 * ```ts
 * delay(1000); // 1 second
 * ```
 **/
export function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function should_never_happen(message: string) {
	console.error("[shouldNeverHappen]", message);
	if (import.meta.env.DEV) {
		// eslint-disable-next-line no-debugger
		debugger;
	}
}

export function has_defined_property<O extends object, P extends KeysOfUnion<O>>(
	obj: O,
	property: P,
): obj is ExtractTypeByPropertyAndAssertNotUndefined<O, P> {
	return (
		property in obj &&
		/* @ts-expect-error */
		obj[property] !== undefined
	);
}

/**
 * At runtime tuples are just arrays, but for TS the type will be a tuple with well defined literal types.
 *
 * https://www.typescriptlang.org/docs/handbook/2/objects.html#tuple-types
 *
 * @example
 * ```ts
 * const myTuple = tuple('hello', 'world', 42); // ['hello', 'world', 42]
 * ```
 */
export function tuple<T extends (Primitive | object)[]>(...args: [...T]): [...T] {
	return args;
}

type ExtractTypeByProperty<O extends object, P extends KeysOfUnion<O>> = Extract<O, { [K in P]?: any }>;

type ExtractTypeByPropertyAndAssertNotUndefined<O extends object, P extends KeysOfUnion<O>> = ExtractTypeByProperty<
	O,
	P
> & {
	[K in P]: Exclude<ExtractTypeByProperty<O, K>[K], undefined>;
};

/**
 * Chromium do not adhere to the standard and does not support `autocomplete="off"` forcing developers to resort to workarounds.
 *
 * @link https://stackoverflow.com/questions/12374442
 * @link https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/autocomplete
 */
export function ui_create_auto_complete_off_value(): string {
	return `off=${Date.now()}`;
}

/**
 * To be removed once `Promise.withResolvers` is widely available.
 *
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 */
export function create_promise_with_resolvers<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void | PromiseLike<void>;
	reject: (reason?: unknown) => void | PromiseLike<void>;
} {
	let resolve: (value: T) => void;
	let reject: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve: resolve! as any, reject: reject! };
}
