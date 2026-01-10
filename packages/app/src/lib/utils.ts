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
				return value;
			})
			.catch((error) => {
				deferred.status = "rejected";
				return error;
			});

		return deferred;
	};

	return createDeferred();
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
export function tuple<T extends (Primitive | {})[]>(...args: [...T]): [...T] {
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
	const trimmedName = name.trim();
	const hasSpaces = trimmedName.includes(" ");

	if (hasSpaces) {
		const words = trimmedName.split(" ").filter((word) => word.length > 0);
		if (words.length >= 2) {
			// First letter of first word + first letter of last word
			return (words[0][0] + words[words.length - 1][0]).toUpperCase();
		}
		// Fallback: if somehow only one word after filtering, use first 2 chars
		return trimmedName.slice(0, 2).toUpperCase().padEnd(2, trimmedName[0].toUpperCase());
	} else {
		// Take first 2 characters, padding with first character if needed
		const firstTwo = trimmedName.slice(0, 2).toUpperCase();
		return firstTwo.padEnd(2, trimmedName[0].toUpperCase());
	}
}

/**
 * CustomEvent with better types.
 *
 * @example
 * ```ts
 * const event = new XCustomEvent("connected", { detail: { userId: "1", sessionId: "1" } });
 * event.type; // "connected"
 * event.detail; // { userId: "1", sessionId: "1" }
 * ```
 *
 * @example
 *
 * Subclass
 *
 * ```ts
 * class MyEvent extends XCustomEvent<{ connected: { userId: string; sessionId: string } }> {}
 * ```
 *
 * @example
 *
 * With TypedEventTarget
 *
 * ```ts
 * import { TypedEventTarget } from "@remix-run/interaction";
 *
 * class MyEvent extends XCustomEvent<{ connected: { userId: string; sessionId: string } }> {}
 *
 * class MyEventTarget extends TypedEventTarget<MyEvent["__map"]> {}
 */
export class XCustomEvent<T extends { [key: string]: any }> extends Event {
	declare __map: {
		[K in keyof T]: XCustomEvent<{ [X in K]: T[X] }>;
	};
	declare __union: this["__map"][keyof T];

	// @ts-expect-error
	type: keyof T;
	detail: T[keyof T];

	constructor(type: keyof T, args: EventInit & { detail: T[keyof T] }) {
		super(type as string, args);
		this.type = type;
		this.detail = args.detail;
	}
}

export type AppElementId = "root" | "app_tiptap_hoisting_container" | "app_monaco_hoisting_container";
