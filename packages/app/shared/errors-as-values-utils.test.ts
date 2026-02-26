import { describe, test, expect } from "vitest";
import {
	AbortReason,
	Result,
	Result_nay_from,
	Result_try,
	Result_try_async,
	Result_try_promise,
} from "./errors-as-values-utils.ts";

describe("Result", () => {
	test("creates Result _nay with message", () => {
		const badResult = Result({ _nay: { message: "test error" } });
		expect(badResult._nay.message).toBe("test error");
		expect(badResult._nay.name).toBeUndefined();
		expect(badResult._nay.cause).toBeUndefined();
		expect(badResult._nay.data).toBeUndefined();
	});

	test("creates Result _nay with message and cause", () => {
		const cause = new Error("cause error");
		const badResult = Result({ _nay: { message: "test error", cause } });

		expect(badResult._nay.message).toBe("test error");
		expect(badResult._nay.cause).toBe(cause);
		expect(badResult._nay.data).toBeUndefined();
	});

	test("creates Result _nay with message and data", () => {
		const data = { foo: "bar" };
		const badResult = Result({ _nay: { message: "test error", data } });

		expect(badResult._nay.message).toBe("test error");
		expect(badResult._nay.data).toBe(data);
		expect(badResult._nay.cause).toBeUndefined();
	});

	test("creates Result _nay with message, cause, and data", () => {
		const cause = new Error("cause error");
		const data = { foo: "bar" };
		const badResult = Result({ _nay: { message: "test error", cause, data } });

		expect(badResult._nay.message).toBe("test error");
		expect(badResult._nay.cause).toBe(cause);
		expect(badResult._nay.data).toBe(data);
	});

	describe("helper functions", () => {
		test("Result_try captures errors and returns them (sync)", () => {
			const successFn = () => "success";
			const errorFn = () => {
				throw new Error("error thrown");
			};
			const badResultFn = () => {
				throw Result({ _nay: { message: "bad result thrown" } }) as any;
			};

			expect(Result_try(successFn)._yay).toBe("success");

			const errorResult = Result_try(errorFn);
			expect(errorResult._nay?.message).toBe("error thrown");

			const badResultError = Result_try(badResultFn);
			expect(badResultError._nay?.message).toBe("bad result thrown");
		});

		test("Result_try_async captures errors and returns them (async)", async () => {
			const asyncSuccessFn = async () => "async success";
			const asyncErrorFn = async () => {
				throw new Error("async error thrown");
			};
			const asyncNayResultFn = async () => {
				throw Result({ _nay: { message: "async bad result thrown" } }) as any;
			};

			expect((await Result_try_async(asyncSuccessFn))._yay).toBe("async success");

			const errorResult = await Result_try_async(asyncErrorFn);
			expect(errorResult._nay?.message).toBe("async error thrown");

			const badResultError = await Result_try_async(asyncNayResultFn);
			expect(badResultError._nay?.message).toBe("async bad result thrown");
		});

		test("Result_try_promise captures errors from promises directly", async () => {
			expect((await Result_try_promise(Promise.resolve("promise success")))._yay).toBe("promise success");

			const errorResult = await Result_try_promise(Promise.reject(new Error("promise error")));
			expect(errorResult._nay?.message).toBe("promise error");

			const nayResult = await Result_try_promise(
				Promise.reject(Result({ _nay: { message: "promise nay result" } }) as any),
			);
			expect(nayResult._nay?.message).toBe("promise nay result");
		});

		// test("BadResult.getStack builds a stack trace with causes", () => {
		// 	const innerError = new Error("inner error");
		// 	const middleError = new BadResult("middle error", { cause: innerError });
		// 	const outerError = new BadResult("outer error", { cause: middleError });

		// 	const stack = BadResult.getStack(outerError);

		// 	expect(stack).toContain("outer error");
		// 	expect(stack).toContain("middle error");
		// 	expect(stack).toContain("inner error");
		// });
	});

	test("creates Result with _yay", () => {
		const result = Result({ _yay: "success" });

		expect(result._yay).toBe("success");
		expect(result._nay).toBeUndefined();
	});

	test("discriminated union pattern works", () => {
		function processResult(result: Result<{ _yay: string }> | Result<{ _nay: { message: string } }>) {
			if (result._nay) {
				return `Error: ${result._nay.message}`;
			} else {
				return `Success: ${result._yay}`;
			}
		}

		const successResult = Result({ _yay: "it worked" });
		const failureResult = Result({ _nay: { name: "nay", message: "it failed" } });

		expect(processResult(successResult)).toBe("Success: it worked");
		expect(processResult(failureResult)).toBe("Error: it failed");
	});
});

describe("AbortReason", () => {
	test("creates AbortReason with message", () => {
		const reason = new AbortReason("user cancelled");

		expect(reason.message).toBe("user cancelled");
		expect(reason.name).toBe("AbortError");
	});

	test("instanceof works with DOMException AbortErrors", () => {
		const reason = new AbortReason("user cancelled");

		// Create a mock DOMException with name AbortError
		const domException = new Error("DOM abort");
		domException.name = "AbortError";

		expect(reason instanceof AbortReason).toBe(true);
		expect(domException instanceof AbortReason).toBe(true);
		expect(new Error("regular error") instanceof AbortReason).toBe(false);
	});

	test("AbortReason.of creates AbortReason from AbortSignal", () => {
		const controller = new AbortController();
		const reason = new Error("abort reason");
		controller.abort(reason);

		const abortReason = AbortReason.of(controller.signal);

		expect(abortReason).toBeInstanceOf(AbortReason);
		expect(abortReason.message).toBe("abort reason");
	});
});

describe("Workflows", () => {
	test("Function that returns _yay", () => {
		function doSomethingYay(flag: boolean) {
			if (flag) {
				return Result({ _yay: "success" });
			} else {
				return Result({ _nay: { message: "failure" as const } });
			}
		}

		const result = doSomethingYay(true);
		if (result._nay) {
			throw new Error("Did error");
		}

		expect(result._yay).toBe("success");
	});

	test("Function that returns _nay", () => {
		function doSomethingNay(flag: boolean) {
			if (flag) {
				return Result({ _nay: { message: "failure" } });
			} else {
				return Result({ _yay: "success" });
			}
		}

		const result = doSomethingNay(true);
		if (result._nay) {
			expect(result._nay.message).toBe("failure");
			return;
		}

		throw new Error("Should error");
	});

	test("Function that returns _nay with data and union", () => {
		function doSomethingNay(num: number) {
			if (num === 0) {
				return Result({ _yay: "success" });
			} else if (num === 1) {
				return Result({ _nay: { message: "failure" as const } });
			} else {
				return Result({ _nay: { message: "failure with data" as const, data: { foo: "bar" } } });
			}
		}

		const result = doSomethingNay(2);
		if (result._nay) {
			if (result._nay.message === "failure with data") {
				expect(result._nay.data.foo).toBe("bar");
			}

			return;
		}

		throw new Error("Should error");
	});

	test("Abort task", () => {
		const controller = new AbortController();
		controller.abort(new AbortReason("abort reason"));

		function doSomething(signal: AbortSignal) {
			try {
				if (signal.aborted) {
					throw AbortReason.of(signal);
				}

				return Result({ _yay: "success" });
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					const abortReasonAsNay = Result_nay_from(error);
					return Result({ _nay: { ...abortReasonAsNay, name: "nay_abort", cause: error } });
				}

				return Result({ _nay: { message: "unknown error" } });
			}
		}

		const result = doSomething(controller.signal);
		if (result._nay && result._nay.name === "nay_abort") {
			expect(result._nay.message).not.toBeUndefined();
			return;
		}

		throw new Error("Should error");
	});
});
