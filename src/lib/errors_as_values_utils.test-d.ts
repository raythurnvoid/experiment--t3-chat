import { expectTypeOf, test } from "vitest";
import {
	BadResult,
	BadResultAbort,
	AbortReason,
	Result,
	type BadResult_Any,
	type BadResult_Extract,
	type BadResult_Exclude,
} from "./errors_as_values_utils";

// BadResult class tests
test("BadResult class has correct type structure", () => {
	const result = new BadResult("error message");
	expectTypeOf(result).toHaveProperty("name");
	expectTypeOf(result.name).toBeString();
	expectTypeOf(result.message).toBeString();
	expectTypeOf(result.cause).toBeUndefined();
	expectTypeOf(result.meta).toBeUndefined();
});

test("BadResult with meta has correct types", () => {
	const meta = { foo: "bar" };
	const result = new BadResult("error message", { meta });

	expectTypeOf(result.meta).toEqualTypeOf<{ foo: string }>();
	expectTypeOf(result.meta.foo).toBeString();
});

test("BadResult with cause has correct types", () => {
	const cause = new Error("cause error");
	const result = new BadResult("error message", { cause });

	expectTypeOf(result.cause).toEqualTypeOf<Error>();
	expectTypeOf(result.cause.message).toBeString();
});

// BadResult static methods type tests
test("BadResult.is correctly narrows types", () => {
	const value = {} as BadResult | { success: boolean };

	if (BadResult.is(value)) {
		expectTypeOf(value).toEqualTypeOf<BadResult>();
		expectTypeOf(value.message).toBeString();
	} else {
		expectTypeOf(value).toEqualTypeOf<{ success: boolean }>();
		expectTypeOf(value.success).toBeBoolean();
	}
});

test("BadResult.isNot correctly narrows types", () => {
	const value = {} as BadResult<"error"> | { success: boolean };

	if (BadResult.isNot(value)) {
		expectTypeOf(value).toEqualTypeOf<{ success: boolean }>();
		expectTypeOf(value.success).toBeBoolean();
	} else {
		expectTypeOf(value).toEqualTypeOf<BadResult<"error">>();
		expectTypeOf(value.message).toEqualTypeOf<"error">();
	}
});

test("BadResult.isBadResultOrError correctly narrows types", () => {
	const value = {} as BadResult | Error | { success: boolean };

	if (BadResult.isBadResultOrError(value)) {
		expectTypeOf(value).toEqualTypeOf<BadResult | Error>();
		expectTypeOf(value.message).toBeString();
	} else {
		expectTypeOf(value).toEqualTypeOf<{ success: boolean }>();
		expectTypeOf(value.success).toBeBoolean();
	}
});

test("BadResult.isError correctly narrows types", () => {
	const value = {} as BadResult | Error | { success: boolean };

	if (BadResult.isError(value)) {
		expectTypeOf(value).toEqualTypeOf<Error>();
		expectTypeOf(value.message).toBeString();
	} else {
		expectTypeOf(value).toEqualTypeOf<BadResult | { success: boolean }>();
	}
});

test("BadResult.throwIfBadResult type assertion", () => {
	const value = {} as BadResult | string;

	BadResult.throwIfBadResultOrError(value);
	expectTypeOf(value).toEqualTypeOf<string>();
});

test("BadResult.typeAssertNotBadResult type assertion", () => {
	const value = {} as BadResult | string;

	BadResult.typeAssertNotBadResult(value);
	expectTypeOf(value).toEqualTypeOf<string>();
});

test("BadResult.typeAssertMayBeBadResultOrError type assertion", () => {
	const value = {} as BadResult | Error | string;

	BadResult.typeAssertMayBeBadResultOrError(value);
	expectTypeOf(value).toEqualTypeOf<BadResult | Error>();
});

test("typeAssertMayBeBadResultOrError includes BadResultAbort", () => {
	const value = {} as BadResult | BadResultAbort | string;

	BadResult.typeAssertMayBeBadResultOrError(value);
	expectTypeOf(value).toEqualTypeOf<BadResult | BadResultAbort>();
});

test("BadResult.try return type", async () => {
	const fn = async () => "hello";
	const result = BadResult.try(fn);
	expectTypeOf(result).resolves.toEqualTypeOf<string | Error | BadResult_Any>();
});

test("BadResult.getStack return type", () => {
	const error = new BadResult("test");
	const stack = BadResult.getStack(error);
	expectTypeOf(stack).toBeString();
});

// TypeScript native type utils tests
test("Extract correctly extracts BadResult types", () => {
	type TestType = BadResult<"error"> | string | number;
	type ExtractedType = BadResult_Extract<TestType>;

	expectTypeOf<ExtractedType>().toEqualTypeOf<BadResult<"error">>();
});

test("Exclude correctly excludes BadResult types", () => {
	type TestType = BadResult<"error"> | string | number;
	type ExcludedType = BadResult_Exclude<TestType>;

	expectTypeOf<ExcludedType>().toEqualTypeOf<string | number>();
});

// BadResultAbort tests
test("BadResultAbort has correct type structure", () => {
	const result = new BadResultAbort("operation aborted");

	expectTypeOf(result).toHaveProperty("name");
	expectTypeOf(result.name).toBeString();
	expectTypeOf(result.message).toBeString();
	expectTypeOf(result.cause).toBeUndefined();
	expectTypeOf(result.meta).toBeUndefined();
});

test("BadResultAbort with meta has correct types", () => {
	const meta = { reason: "user cancelled" };
	const result = new BadResultAbort("operation aborted", { meta });

	expectTypeOf(result.meta).toEqualTypeOf<{ reason: string }>();
	expectTypeOf(result.meta.reason).toBeString();
});

test("BadResultAbort with cause has correct types", () => {
	const cause = new Error("cause error");
	const result = new BadResultAbort("operation aborted", { cause });

	expectTypeOf(result.cause).toEqualTypeOf<Error>();
	expectTypeOf(result.cause.message).toBeString();
});

// AbortReason tests
test("AbortReason has correct type structure", () => {
	const reason = new AbortReason("user cancelled");

	expectTypeOf(reason).toHaveProperty("name");
	expectTypeOf(reason.name).toBeString();
	expectTypeOf(reason.message).toBeString();
});

// Result class tests
test("Result with ok value has correct type structure", () => {
	type OkResult = Result<{ ok: string }> | Result<{ bad: BadResult<string> }>;
	const result = {} as OkResult & { ok: string };

	// Verify that result.ok is accessible and has the correct type
	expectTypeOf(result.ok).toBeString();
});

test("Result with bad value has correct type structure", () => {
	type BadResultType = Result<{ ok: string }> | Result<{ bad: BadResult<string> }>;
	const result = {} as BadResultType & { bad: BadResult<string> };

	// Verify that result.bad is accessible and has the correct type
	expectTypeOf(result.bad).toEqualTypeOf<BadResult<string>>();
});
