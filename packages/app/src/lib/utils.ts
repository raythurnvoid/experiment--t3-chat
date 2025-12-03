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

export function forward_ref(refValue: any, ...targetRefs: (React.Ref<any> | undefined)[]) {
	const cleanedUpFns: (() => void)[] = [];
	if (targetRefs) {
		for (const targetRef of targetRefs) {
			if (targetRef) {
				if (typeof targetRef === "function") {
					const cleanedUpFn = targetRef(refValue);
					if (cleanedUpFn) {
						cleanedUpFns.push(cleanedUpFn);
					}
				} else {
					targetRef.current = refValue;
				}
			}
		}
	}

	return () => {
		for (const cleanedUpFn of cleanedUpFns) {
			cleanedUpFn();
		}
	};
}

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

/**
 * Useful to create an object/value of a specific type while being sure that all properties are compliant with the type.
 *
 * Unlike `as` this will show an error if you only pass some properties of the object.
 *
 * Unlike `satisfies` this will set the type of the result to the desired type.
 */
export function make<T>(value: T): T {
	return value;
}

/**
 * Log a message with the values that are `undefined` or `null`.
 * @example
 * ```ts
 * if (!someValue || !someOtherValue) {
 *   log_missing_values("someIdentifier", { someValue, someOtherValue });
 * }
 * ```
 */
export function msg_with_nullish_values(name: string, deps: Record<string, any>) {
	const missingValues = Object.entries(deps).reduce((acc, [_, value]) => {
		if (value === undefined || value === null) {
			acc.push(_);
		}
		return acc;
	}, [] as string[]);
	if (missingValues.length > 0) {
		if (import.meta.env.DEV) {
			// eslint-disable-next-line no-debugger
			debugger;
		}
		return `[log_nullish_values] [${name}] is missing the following values: [${missingValues.toString()}]`;
	}
	return undefined;
}

/**
 * Calculates the scrollbar width and sets it as a CSS custom property.
 * Creates an invisible container to measure the scrollbar width accurately.
 */
export function valorize_scrollbar_width_px_css_var(): void {
	const id = "invisible-container-to-calculate-scrollbar-width";

	let invisibleContainer = document.getElementById(id);

	if (!invisibleContainer) {
		invisibleContainer = document.createElement("div");
		invisibleContainer.id = id;
		invisibleContainer.style.position = "absolute";
		invisibleContainer.style.zIndex = "-1";
		invisibleContainer.style.width = "100px";
		invisibleContainer.style.height = "0px";
		invisibleContainer.style.opacity = "0";
		invisibleContainer.style.overflow = "scroll";
		invisibleContainer.style.pointerEvents = "none";
		document.body.appendChild(invisibleContainer);
	}

	const scrollbarWidth = invisibleContainer.offsetWidth - invisibleContainer.clientWidth;

	document.body.style.setProperty("--app-scrollbar-w", `${scrollbarWidth}px`);
}

export function string_optional(strings: TemplateStringsArray, ...values: any[]): string {
	if (values.some((value) => value != null && value !== "")) {
		return String.raw(strings, ...values);
	}

	return "";
}

export function compute_fallback_user_name(name: string) {
	const hasSpaces = name.includes(" ");

	if (hasSpaces) {
		return name
			.split(" ")
			.map((word) => word[0].toUpperCase())
			.join("");
	} else if (name.length > 2) {
		return name.slice(0, 2).toUpperCase();
	} else {
		return name[0].toUpperCase();
	}
}
