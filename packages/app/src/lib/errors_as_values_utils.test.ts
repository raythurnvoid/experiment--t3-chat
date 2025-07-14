import { describe, test, expect } from "vitest";
import { BadResult, BadResultAbort, AbortReason, Result, type BadResult_Any } from "./errors_as_values_utils";

describe("BadResult", () => {
	test("creates BadResult with message", () => {
		const badResult = new BadResult("test error");
		expect(badResult.message).toBe("test error");
		expect(badResult.name).toBe("BadResult");
		expect(badResult.cause).toBeUndefined();
		expect(badResult.meta).toBeUndefined();
	});

	test("creates BadResult with message and cause", () => {
		const cause = new Error("cause error");
		const badResult = new BadResult("test error", { cause });

		expect(badResult.message).toBe("test error");
		expect(badResult.cause).toBe(cause);
		expect(badResult.meta).toBeUndefined();
	});

	test("creates BadResult with message and meta", () => {
		const meta = { foo: "bar" };
		const badResult = new BadResult("test error", { meta });

		expect(badResult.message).toBe("test error");
		expect(badResult.meta).toBe(meta);
		expect(badResult.cause).toBeUndefined();
	});

	test("creates BadResult with message, cause, and meta", () => {
		const cause = new Error("cause error");
		const meta = { foo: "bar" };
		const badResult = new BadResult("test error", { cause, meta });

		expect(badResult.message).toBe("test error");
		expect(badResult.cause).toBe(cause);
		expect(badResult.meta).toBe(meta);
	});

	describe("static methods", () => {
		test("BadResult.is identifies BadResult instances", () => {
			const badResult = new BadResult("test error");
			const badResultAbort = new BadResultAbort("aborted");
			const error = new Error("regular error");
			const notAnError = { message: "not an error" };

			expect(BadResult.is(badResult)).toBe(true);
			expect(BadResult.is(badResultAbort)).toBe(true);
			expect(BadResult.is(error)).toBe(false);
			expect(BadResult.is(notAnError)).toBe(false);
			expect(BadResult.is(null)).toBe(false);
			expect(BadResult.is(undefined)).toBe(false);
		});

		test("BadResult.isError identifies Error instances", () => {
			const badResult = new BadResult("test error");
			const error = new Error("regular error");
			const notAnError = { message: "not an error" };

			expect(BadResult.isError(badResult)).toBe(false);
			expect(BadResult.isError(error)).toBe(true);
			expect(BadResult.isError(notAnError)).toBe(false);
			expect(BadResult.isError(null)).toBe(false);
			expect(BadResult.isError(undefined)).toBe(false);
		});

		test("BadResult.isBadResultOrError identifies both BadResult and Error instances", () => {
			const badResult = new BadResult("test error");
			const badResultAbort = new BadResultAbort("aborted");
			const error = new Error("regular error");
			const notAnError = { message: "not an error" };

			expect(BadResult.isBadResultOrError(badResult)).toBe(true);
			expect(BadResult.isBadResultOrError(badResultAbort)).toBe(true);
			expect(BadResult.isBadResultOrError(error)).toBe(true);
			expect(BadResult.isBadResultOrError(notAnError)).toBe(false);
			expect(BadResult.isBadResultOrError(null)).toBe(false);
			expect(BadResult.isBadResultOrError(undefined)).toBe(false);
		});

		test("BadResult.isNot correctly identifies non-BadResult values", () => {
			const badResult = new BadResult("test error");
			const notABadResult = "not a bad result";

			expect(BadResult.isNot(badResult)).toBe(false);
			expect(BadResult.isNot(notABadResult)).toBe(true);
		});

		test("BadResult.throwIfBadResult throws if value is BadResult", () => {
			const badResult = new BadResult("test error");
			const notABadResult = "not a bad result";

			expect(() => BadResult.throwIfBadResultOrError(badResult)).toThrow();
			expect(() => BadResult.throwIfBadResultOrError(notABadResult)).not.toThrow();
		});

		test("BadResult.try captures errors and returns them", async () => {
			const successFn = () => "success";
			const errorFn = () => {
				throw new Error("error thrown");
			};
			const badResultFn = () => {
				throw new BadResult("bad result thrown");
			};

			expect(await BadResult.try(successFn)).toBe("success");

			const errorResult = await BadResult.try(errorFn);
			expect(errorResult).toBeInstanceOf(Error);
			expect(errorResult.message).toBe("error thrown");

			const badResultError = await BadResult.try(badResultFn);
			expect(badResultError).toBeInstanceOf(BadResult);
			expect(badResultError.message).toBe("bad result thrown");
		});

		test("BadResult.getStack builds a stack trace with causes", () => {
			const innerError = new Error("inner error");
			const middleError = new BadResult("middle error", { cause: innerError });
			const outerError = new BadResult("outer error", { cause: middleError });

			const stack = BadResult.getStack(outerError);

			expect(stack).toContain("outer error");
			expect(stack).toContain("middle error");
			expect(stack).toContain("inner error");
		});
	});
});

describe("BadResultAbort", () => {
	test("creates BadResultAbort with message", () => {
		const abort = new BadResultAbort("operation aborted");

		expect(abort.message).toBe("operation aborted");
		expect(abort.name).toBe("BadResultAbort");
		expect(abort.cause).toBeUndefined();
		expect(abort.meta).toBeUndefined();
	});

	test("creates BadResultAbort with message and meta", () => {
		const meta = { signal: new AbortController().signal };
		const abort = new BadResultAbort("operation aborted", { meta });

		expect(abort.message).toBe("operation aborted");
		expect(abort.meta).toBe(meta);
	});

	test("BadResult.is identifies BadResultAbort as a BadResult", () => {
		const abort = new BadResultAbort("operation aborted");
		expect(BadResult.is(abort)).toBe(true);
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

describe("Result", () => {
	test("creates Result with ok value", () => {
		const result = new Result({ ok: "success" });

		expect(result.ok).toBe("success");
		expect(result.bad).toBeUndefined();
	});

	test("creates Result with bad value", () => {
		const badResult = new BadResult("failure");
		const result = new Result({ bad: badResult });

		expect(result.bad).toBe(badResult);
		expect(result.ok).toBeUndefined();
	});

	test("discriminated union pattern works", () => {
		function processResult(result: Result<{ ok: string }> | Result<{ bad: BadResult_Any }>) {
			if (result.bad) {
				return `Error: ${result.bad.message}`;
			} else {
				return `Success: ${result.ok}`;
			}
		}

		const successResult = new Result({ ok: "it worked" });
		const failureResult = new Result({ bad: new BadResult("it failed") });

		expect(processResult(successResult)).toBe("Success: it worked");
		expect(processResult(failureResult)).toBe("Error: it failed");
	});
});
