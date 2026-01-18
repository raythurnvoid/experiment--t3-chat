import type { IsAny, LiteralUnion, Writable } from "type-fest";

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
	readonly cause: Error | Result<{ _nay: any }>["_nay"] | undefined = undefined;

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
export function Result_try<T>(fn: () => T): Result<
	| { _yay: T }
	| { _nay: null }
	| {
			_nay: {
				name?: Result_nay_name;
				message?: string;
				cause?: unknown;
				data?: unknown;
				stack?: string;
			};
	  }
> {
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
export function Result_try_async<T>(fn: () => Promise<T>): Promise<
	Result<
		| { _yay: T }
		| { _nay: null }
		| {
				_nay: {
					name?: Result_nay_name;
					message?: string;
					cause?: unknown;
					data?: unknown;
					stack?: string;
				};
		  }
	>
> {
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
export function Result_try_promise<T>(promise: Promise<T>): Promise<
	Result<
		| { _yay: T }
		| { _nay: null }
		| {
				_nay: {
					name?: Result_nay_name;
					message?: string;
					cause?: unknown;
					data?: unknown;
					stack?: string;
				};
		  }
	>
> {
	return promise
		.then((value) => {
			return Result({ _yay: value });
		})
		.catch((error) => {
			return Result({ _nay: "_nay" in error ? error._nay : Result_nay_from(error) });
		});
}

export function Result_nay_from(error_or_nay: unknown) {
	if (error_or_nay == null) {
		return null;
	} else if (typeof error_or_nay === "object") {
		return {
			// @ts-expect-error
			message: error_or_nay.message,
			// @ts-expect-error
			name: error_or_nay.name,
			// @ts-expect-error
			cause: error_or_nay.cause,
			// @ts-expect-error
			data: error_or_nay.data,
		};
	} else if (typeof error_or_nay === "string") {
		return {
			message: error_or_nay,
		};
	} else {
		return {
			message: "unknown",
		};
	}
}

export function Result<
	const T extends
		| { _yay: unknown }
		| {
				_nay: {
					name?: Result_nay_name;
					message?: string;
					cause?: unknown;
					data?: unknown;
					stack?: string;
				} | null;
		  },
>(
	args: T,
): T extends { _yay: unknown }
	? Result<{ _yay: T["_yay"] }>
	: T extends { _nay: null }
		? Result<{ _nay: null }>
		: Result<{
				_nay: {
					// @ts-expect-error
					name: T["_nay"]["name"] extends Result_nay_name
						? // @ts-expect-error
							T["_nay"]["name"]
						: undefined;
					// @ts-expect-error
					message: T["_nay"]["message"] extends string ? T["_nay"]["message"] : string;
					// @ts-expect-error
					cause: "cause" extends keyof T["_nay"] ? T["_nay"]["cause"] : never;
					// @ts-expect-error
					data: "data" extends keyof T["_nay"] ? T["_nay"]["data"] : never;
					// @ts-expect-error
					stack: "stack" extends keyof T["_nay"] ? string : never;
				};
			}> {
	return "_nay" in args
		? args._nay === null
			? ({ _nay: null } as any)
			: ({
					_nay: {
						name: args._nay.name,
						message: args._nay.message,
						cause: (args._nay as { cause?: unknown }).cause,
						data: (args._nay as { data?: unknown }).data,
					},
				} as any)
		: ({
				_yay: args._yay,
			} as any);
}

type Result_nay_name = LiteralUnion<"nay" | "nay_abort", string>;

export type Result<
	T extends {
		_yay?: unknown;
		_nay?: {
			name?: Result_nay_name;
			message?: string;
			cause?: unknown;
			data?: unknown;
			stack?: string;
		} | null;
	},
> = T extends { _yay: unknown }
	? {
			_yay: IsAny<T["_yay"]> extends true ? unknown : T["_yay"];
			_nay?: undefined;
		}
	: {
			_nay: IsAny<T["_nay"]> extends true
				? {
						name?: Result_nay_name;
						message?: string;
						cause?: unknown;
						data?: unknown;
						stack?: string;
					}
				: T["_nay"] extends null
					? null
					: {
							name: "name" extends keyof T["_nay"] ? T["_nay"]["name"] : "nay";
							// @ts-expect-error
							message: T["_nay"]["message"];
							// @ts-expect-error
							cause: T["_nay"]["cause"];
							// @ts-expect-error
							data: Writable<T["_nay"]["data"]>;
							stack?: string;
						};
			_yay?: undefined;
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
export function Error_serializeToJSON(error: Error | Result<{ _nay: any }>["_nay"]): {
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

	// @ts-expect-error
	return json;
}
