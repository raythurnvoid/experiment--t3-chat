import type { UnknownRecord } from "type-fest";

/**
 * Similar to `Error` should be regularly returned instead of throwed.
 *
 * This will allow to write code that handles error are retularly returned values.
 *
 * The advantages of returning a `BadResult` over throwing an `Error` are:
 * - The caller is forced to take care of errors.
 * - The types of the errors are explicit.
 * - The types can be inferred automatically by checking the message string.
 * - Better performance when the function may throw many times, creating the stack trace is expensive.
 *
 * From the type-level standpoint, `BadResult` is a superset of `Error`.
 *
 * This means that you can use `BadResult` everywhere you would use an `Error` and it will be compatible.
 *
 * To distinguish between `BadResult` and `Error` you can use the `BadResult.is` or `Error.isError`/`e instanceof Error` methods.
 *
 * @example
 * ```ts
 * function fetchData() {
 *   try {
 *     const response = await fetch(url);
 *
 *     if (!response.ok) {
 *       return new Result({ bad: new BadResult('The server returned an error', { meta: { response } }) });
 *     }
 *
 *     return new Result({ ok: response });
 *   } catch (error) {
 *     return new Result({ bad: new BadResult('Failed to fetch data', { cause: error }) });
 *   }
 * }
 *
 * const result = await fetchData();
 * if (BadResult.is(result)) {
 *   // Handle the error
 * } else {
 *   // Handle the result
 * }
 * ```
 */
export class BadResult<
	Message extends string = string,
	Args extends {
		cause?: Error | BadResult;
		meta?: {};
	} = object,
> {
	readonly name = "BadResult";

	readonly message: Message = undefined as any;
	readonly cause: _BadResult_Cause<Args["cause"]> = undefined as any;
	readonly meta: _BadResult_Meta<Args["meta"]> = undefined as any;
	readonly stack?: string | undefined;

	constructor(
		message: Message,
		// @ts-expect-error
		args: Args = {
			cause: undefined,
			meta: undefined,
		},
	) {
		this.message = message;
		Object.assign(this, args);

		// Define stack as enumerable getter, by default `get` accessors are not enumerable
		Reflect.defineProperty(this, "stack", {
			get: () => BadResult.getStack(this),
			enumerable: true,
			configurable: false,
		});
	}

	/** Mostly used by sentry to format the console message */
	toString() {
		return `[BadResult: ${this.message}]`;
	}

	/**
	 * Mostly used by sentry to properly access non-enumerable
	 * properties of nested Errors like `cause`
	 **/
	toJSON() {
		const json = {
			name: this.name,
			message: this.message as string,
			cause: this.cause as unknown,
			meta: this.meta as unknown,
			stack: this.stack,
		};

		if ("toJSON" in (json.cause as any) && typeof (json.cause as any).toJSON === "function") {
			json.cause = (json.cause as any).toJSON();
		} else if (json.cause instanceof Error) {
			json.cause = Error_serializeToJSON(json.cause);
		}

		return json;
	}

	static is(value: unknown): value is BadResult_Any {
		return value instanceof BadResult || value instanceof BadResultAbort;
	}

	static isError(value: unknown): value is Error {
		return value instanceof Error;
	}

	static isBadResultOrError<T>(value: T): value is Extract<T, BadResult_Any | Error> {
		return BadResult.is(value) || BadResult.isError(value);
	}

	static isNot<T>(value: T | BadResult): value is Exclude<T, BadResult_Any> {
		return !BadResult.is(value);
	}

	static throwIfBadResultOrError<T>(
		value: T | BadResult_Any | Error,
	): asserts value is Exclude<T, BadResult_Any | Error> {
		if (BadResult.isBadResultOrError(value)) {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw value;
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For asynchronous functions, use `BadResult.tryAsync` instead.
	 */
	static try<T>(fn: () => T): T | BadResult_Any | Error {
		try {
			return fn();
		} catch (error) {
			return error as any;
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For synchronous functions, use `BadResult.try` instead.
	 */
	static async tryAsync<T>(fn: () => Promise<T>): Promise<T | BadResult_Any | Error> {
		try {
			return await fn();
		} catch (error) {
			return error as any;
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For cases where you have a function that returns a promise, use `BadResult.tryAsync` instead.
	 */
	static async tryPromise<T>(promise: Promise<T>): Promise<T | BadResult_Any | Error> {
		try {
			return await promise;
		} catch (error) {
			return error as any;
		}
	}

	static getStack(error: BadResult_Any | Error): string {
		let message = "";

		let size = 0;
		let pointer: null | undefined | BadResult_Any | Error | string = error;
		while (pointer) {
			if (pointer instanceof Error) {
				if (message) message += "\nCaused by: ";
				message += pointer.stack;
				pointer = pointer.cause as any;
			} else if (BadResult.is(pointer)) {
				if (message) message += "\nCaused by: ";
				message += `BadResult: ${pointer.message}`;
				pointer = pointer.cause as any;
			} else if (typeof pointer !== "object") {
				if (message) message += "\nCaused by: ";
				message += `Thrown: ${pointer}`;
				pointer = null;
			} else {
				pointer = null;
			}

			size++;
			if (size > 10) {
				break;
			}
		}

		return message;
	}

	static typeAssertNotBadResult<T>(value: T | BadResult<string>): asserts value is T {}

	static typeAssertMayBeBadResultOrError<T>(value: any): asserts value is BadResult_Any | Error {}
}

/**
 * `BadResult` specifically designed to be used for long abortable tasks.
 *
 * It can be used along side an `AbortSignal` and returned when the signal is marked as aborted.
 *
 * @example
 * ```ts
 * function longOperation(signal: AbortSignal) {
 *   if (signal.aborted) {
 *     // Passing the signal is not mandatory, any additional data can be passed through `meta`.
 *     return new BadResultAbort(signal.reason, { meta: { signal } });
 *   }
 * }
 * ```
 */
export class BadResultAbort<
	Message extends string = string,
	Args extends {
		cause?: Error | BadResult;
		meta?: UnknownRecord;
	} = object,
> {
	// Composition over inheritance to prevent inheriting from `BadResult` all static methods.

	readonly name = "BadResultAbort";

	private readonly badResult: BadResult<Message, Args>;

	readonly message: Message = undefined as any;
	readonly cause: _BadResult_Cause<Args["cause"]> = undefined as any;
	readonly meta: _BadResult_Meta<Args["meta"]> = undefined as any;
	readonly stack?: string | undefined;

	constructor(message: Message, args: Args = {} as Args) {
		this.badResult = new BadResult(message, args);

		// Define message, cause, meta and stack as enumerable getters, by default `get` accessors are not enumerable
		Reflect.defineProperty(this, "message", {
			get: () => this.badResult.message,
			enumerable: true,
			configurable: false,
		});
		Reflect.defineProperty(this, "cause", {
			get: () => this.badResult.cause,
			enumerable: true,
			configurable: false,
		});
		Reflect.defineProperty(this, "meta", {
			get: () => this.badResult.meta,
			enumerable: true,
			configurable: false,
		});
		Reflect.defineProperty(this, "stack", {
			get: () => this.badResult.stack,
			enumerable: true,
			configurable: false,
		});
	}

	toString() {
		return `[BadResultAbort: ${this.message}]`;
	}

	/**
	 * Mostly used by sentry to properly access non-enumerable
	 * properties of nested Errors like `cause`
	 **/
	toJSON() {
		const json = this.badResult.toJSON();
		json.name = this.name;
		return json;
	}

	static fromReason(abortReason: AbortReason): BadResultAbort {
		return new BadResultAbort(abortReason.message, {
			cause: abortReason.cause as any,
		});
	}
}

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
	readonly cause: Error | BadResult | undefined = undefined;

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
 * Result class that will help handle errors as regular values.
 *
 * @example
 * ```ts
 * function mayReturnBadResult() {
 *   if (Math.random() > 0.5) {
 *     return new Result({ bad: new BadResult('bad') });
 *   } else {
 *     return new Result({ ok: 'ok' });
 *   }
 * }
 *
 * const result = await mayReturnBadResult();
 * if (result.bad) {
 *   // Handle the error
 * } else {
 *   // Do something
 * }
 * ```
 */
export class Result<
	T extends
		| {
				ok: unknown;
				bad?: never;
		  }
		| {
				bad: BadResult_Any | Error;
				ok?: never;
		  } = { ok: undefined },
> {
	readonly name = "Result";

	// @ts-expect-error
	isOk: T extends { ok: unknown } ? true : false = false;
	// @ts-expect-error
	isBad: T extends { bad: unknown } ? true : false = false;
	// @ts-expect-error
	ok: T extends { ok: unknown } ? T["ok"] : undefined = undefined;
	// @ts-expect-error
	bad: T extends { bad: unknown } ? T["bad"] : undefined = undefined;

	constructor(result?: T) {
		if (result && "bad" in result) {
			// @ts-expect-error
			this.bad = "bad" in result ? result.bad : undefined;
			// @ts-expect-error
			this.isBad = true;
		} else {
			// @ts-expect-error
			this.ok = result.ok;
			// @ts-expect-error
			this.isOk = true;
		}
	}

	/** Mostly used by sentry to format the console message */
	toString() {
		return `[Result.${this.isOk ? "ok" : "bad"}${this.bad ? `: ${this.bad.message}` : ""}]`;
	}

	static throwIfBad<T extends { ok: any; bad: any }>(result: T): asserts result is Exclude<T, Result<{ bad: any }>> {
		if (result.bad) {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw result.bad;
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For asynchronous functions, use `Result.tryAsync` instead.
	 */
	static try<T>(fn: () => T): Result<{ ok: T }> | Result<{ bad: BadResult_Any | Error }> {
		try {
			return new Result({ ok: fn() });
		} catch (error) {
			return new Result({ bad: error as BadResult_Any | Error });
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For synchronous functions, use `Result.try` instead.
	 */
	static async tryAsync<T>(fn: () => Promise<T>): Promise<Result<{ ok: T }> | Result<{ bad: BadResult_Any | Error }>> {
		try {
			return new Result({ ok: await fn() });
		} catch (error) {
			return new Result({ bad: error as BadResult_Any | Error });
		}
	}

	/**
	 * This function assumes that only `Error`s and `BadResult`s are thrown. This may not always be the case.
	 * For cases where you have a function that returns a promise, use `Result.tryAsync` instead.
	 */
	static async tryPromise<T>(promise: Promise<T>): Promise<Result<{ ok: T }> | Result<{ bad: BadResult_Any | Error }>> {
		try {
			return new Result({ ok: await promise });
		} catch (error) {
			return new Result({ bad: error as BadResult_Any | Error });
		}
	}
}

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
export function Error_serializeToJSON(error: Error): {
	name: string;
	message: string;
	cause: unknown;
	stack: string | undefined;
} {
	const json = {
		name: error.name,
		message: error.message,
		cause: error.cause,
		stack: error.stack,
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

export type BadResult_Any = {
	name: string;
	message: string;
	cause?: BadResult_Any | Error | undefined;
	meta?: UnknownRecord | undefined;
	stack?: string | undefined;
	toString(): string;
	toJSON(): object;
};

export type BadResult_Extract<T> = Extract<T, BadResult_Any> extends never ? never : Extract<T, BadResult_Any>;

export type BadResult_Exclude<T> = BadResult_Extract<T> extends never ? T : Exclude<T, BadResult_Any>;

export type Result_PickBad<T> = T extends { bad: infer U } ? Exclude<U, undefined> : never;

export type Result_PickOk<T> = T extends { ok: infer U } ? Exclude<U, undefined> : never;

// Private utilities to set the proper types in the BadResult class.
type _BadResult_Cause<T> = T extends Error ? T : T extends BadResult ? T : undefined;
type _BadResult_Meta<T> = T extends UnknownRecord ? T : undefined;
