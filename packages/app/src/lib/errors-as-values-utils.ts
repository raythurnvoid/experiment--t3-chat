import type { IsUnknown, LiteralUnion } from "type-fest";

/**
 * By default when calling `AbortController.abort` the reason is an instance of `DOMException` with a name `AbortError`.
 *
 * This means that Web Apis like `fetch` will throw this error.
 *
 * To check if the error is an abortion the user can check for `error.name === 'AbortError'`.
 *
 * However if the user wants to pass a reason for the abort, he might be tempted to pass a string and that would be wrong.
 *
 * Even passing an `Error` is not fine because you wouldn't be able to recognize if a function did throw because there was an
 * error or because it was aborted.
 *
 * This class serve the purpose of easily creating an `Error` while setting the name to `AbortError` so the user doesn't
 * have to distinguish between abortion with a reason or without.
 *
 * @example
 * ```ts
 * const abortController = new AbortController();
 *
 * // At some point, somewhere in the code
 * function handleUserAbort() {
 *   abortController.abort(new AbortReason('The user aborted the request'));
 * }
 *
 * function fetchData(url: string) {
 *   try {
 *     const result = await fetch(url, { signal: abortController.signal });
 *   } catch (error) {
 *     if (error.name === 'AbortError') {
 *       return new BadResultAbort('The request was aborted', { cause: error });
 *     } else {
 *       return new BadResult('Failed to fetch', { cause: error });
 *     }
 *   }
 * }
 * ```
 *
 * @example
 * Since `AbortReason` implements `[Symbol.hasInstance]` it can be used with `instanceof` to check
 * both `AbortReason` and `DOMException` with a name `AbortError`.
 * ```ts
 * try {
 *   // ...
 * } catch (error) {
 *   if (error instanceof AbortReason) {
 *     // Handle the error
 *   }
 * }
 * ```
 */
export class AbortReason extends Error {
	/** Used to be compatible with the native `DOMException` with the name `AbortError`. */
	readonly name = "AbortError";

	readonly message: string = undefined as any;
	readonly cause: Error | Result_nay | undefined = undefined;

	constructor(message: string, options?: ErrorOptions & { cause?: AbortReason["cause"] }) {
		super(message, options);
		this.message = message;
		if (options?.cause) {
			this.cause = options.cause;
		}
	}

	/** Mostly used by sentry to format the console message */
	toString() {
		return `[AbortReason: ${this.message}]`;
	}

	static of(signal: AbortSignal): AbortReason {
		let message;
		if (signal.reason?.message != null) {
			message = signal.reason.message;
		} else {
			message = "(Invalid abort reason)";
		}

		let cause;
		if (signal.reason?.cause) {
			cause = signal.reason.cause;
		}

		return new AbortReason(message, { cause });
	}

	static [Symbol.hasInstance](value: any): value is AbortReason {
		return value instanceof Error && value.name === "AbortError";
	}
}

/**
 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
 * For asynchronous functions, use `Result.tryAsync` instead.
 */
export function Result_try<T>(fn: () => T): Result<{ _yay: T } | { _nay: Result_nay }> {
	try {
		return Result({ _yay: fn() });
	} catch (error: any) {
		return Result({ _nay: "_nay" in error ? error._nay : Result_nay_from(error) });
	}
}

/**
 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
 * For synchronous functions, use `Result.try` instead.
 */
export function Result_try_async<T>(fn: () => Promise<T>) {
	return fn()
		.then((value) => {
			return Result({ _yay: value });
		})
		.catch((error) => {
			return Result({ _nay: "_nay" in error ? error._nay : Result_nay_from(error) });
		});
}

/**
 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
 * For cases where you have a function that returns a promise, use `Result.tryAsync` instead.
 */
export function Result_try_promise<T>(promise: Promise<T>): Promise<Result<{ _yay: T } | { _nay: Result_nay }>> {
	return promise
		.then((value) => {
			return Result({ _yay: value });
		})
		.catch((error) => {
			return Result({ _nay: "_nay" in error ? error._nay : Result_nay_from(error) });
		});
}

export function Result_nay_from(error_or_nay: unknown) {
	console.log("error_or_nay", error_or_nay);
	if (error_or_nay == null) {
		return Result_nay({
			message: error_or_nay === null ? "null" : "undefined",
		});
	} else if (
		typeof error_or_nay === "object" &&
		"message" in error_or_nay &&
		typeof error_or_nay.message === "string" &&
		"name" in error_or_nay &&
		typeof error_or_nay.name === "string"
	) {
		return Result_nay(error_or_nay as Result_nay);
	} else if (
		typeof error_or_nay === "object" &&
		"message" in error_or_nay &&
		typeof error_or_nay.message === "string"
	) {
		return Result_nay({
			message: error_or_nay.message,
		});
	} else if (typeof error_or_nay === "string") {
		return Result_nay({
			message: error_or_nay,
		});
	} else {
		return Result_nay({
			message: "unknown",
		});
	}
}

export function Result_nay<
	T extends {
		name?: Result_nay_name;
		message?: string;
		cause?: unknown;
		data?: unknown;
	},
>(
	error_or_nay: T,
): Result_nay<{
	name: T["name"] extends Result_nay_name ? T["name"] : "nay";
	message: T["message"] extends string ? T["message"] : string;
	cause: IsUnknown<T["cause"]> extends true ? never : T["cause"];
	data: IsUnknown<T["data"]> extends true ? never : T["data"];
}> {
	return {
		// @ts-expect-error
		name: error_or_nay.name ?? "nay",
		message: error_or_nay.message ?? "",
		// @ts-expect-error
		cause: error_or_nay.cause,
		// @ts-expect-error
		data: "data" in error_or_nay ? error_or_nay.data : undefined,
	};
}

export function Result<
	T extends
		| { _yay: unknown }
		| {
				_nay: {
					name?: Result_nay_name;
					message?: string;
					cause?: unknown;
					data?: unknown;
				};
		  },
>(
	args: T,
): T extends { _yay: unknown }
	? Result<{ _yay: T["_yay"] }>
	: Result<{
			_nay: Result_nay<{
				// @ts-expect-error
				name: T["_nay"]["name"] extends Result_nay_name
					? // @ts-expect-error
						T["_nay"]["name"]
					: "nay";
				// @ts-expect-error
				message: T["_nay"]["message"] extends string ? T["_nay"]["message"] : string;
				// @ts-expect-error
				cause: IsUnknown<T["_nay"]["cause"]> extends true ? never : T["_nay"]["cause"];
				// @ts-expect-error
				data: IsUnknown<T["_nay"]["data"]> extends true ? never : T["_nay"]["data"];
			}>;
		}> {
	return "_nay" in args
		? ({
				_nay: Result_nay(args._nay),
			} as any)
		: ({
				_yay: args._yay,
			} as any);
}

type Result_nay_name = LiteralUnion<"nay" | "nay_abort", string>;

export type Result_nay<
	T extends {
		name?: Result_nay_name;
		message: string;
		cause?: unknown;
		data?: unknown;
	} = {
		name?: Result_nay_name;
		message: string;
		cause?: unknown;
		data?: unknown;
	},
> = {
	name: T["name"] extends Result_nay_name ? T["name"] : "nay";
	message: T["message"];
	cause?: T["cause"];
	data: T["data"];
};

export type Result<
	T extends {
		_yay?: unknown;
		_nay?: {
			name?: Result_nay_name;
			message: string;
			cause?: unknown;
			data?: unknown;
		};
	},
> = T extends { _yay: unknown }
	? {
			_yay: T["_yay"];
			_nay?: never;
		}
	: {
			_nay: Result_nay<NonNullable<T["_nay"]>>;
			_yay?: never;
		};

/**
 * Same as Sentry depth, we should not need more for now
 */
const ERROR_SERIALIZATION_TO_JSON_MAX_DEPTH = 10;

/**
 * Serialize an `Error` object to a JSON object.
 *
 * Used for Sentry to serialized `Error` objects nested in other objects
 * and allow sentry to expose the `cause` property in the UI
 */
export function Error_serializeToJSON(error: Error | Result_nay): {
	name: string;
	message: string;
	cause: unknown;
	stack: string | undefined;
} {
	const json = {
		name: error.name,
		message: error.message,
		cause: error.cause,
		stack: "stack" in error ? error.stack : `${error.name}: ${error.message}`,
	};

	// Recursively serialize `cause`
	let pointer = json as any;
	let depth = 0;
	while (pointer.cause) {
		depth++;
		if (depth > ERROR_SERIALIZATION_TO_JSON_MAX_DEPTH) {
			break;
		}

		if ("toJSON" in (pointer.cause as any) && typeof (pointer.cause as any).toJSON === "function") {
			pointer.cause = (pointer.cause as any).toJSON();
			break; // Exit, toJSON will recursively serialize the cause
		} else if (pointer.cause instanceof Error) {
			pointer = pointer.cause = {
				...pointer.cause,
				name: pointer.cause.name,
				message: pointer.cause.message,
				stack: pointer.cause.stack,
				cause: pointer.cause.cause,
			};
		}
	}

	return json;
}
